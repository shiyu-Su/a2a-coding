/**
 * Launcher 进程入口。
 * 机器配置路径来自环境变量 `MACHINE_CONFIG`（缺省 `<machine 单元根>/config/config.json`，模板见同目录 `config.json.default`），
 * 监听该配置的 `launcher.port`（可选 `launcher.listenHost`，缺省不设 = 绑定全部网卡）；退出时清理全部 Agent 子进程。
 *
 * 启动顺序（REQ-v0.2.1-2026-09-14-02「启动与退出健壮性」）：
 *   1. `listen(port[, listenHost])` 先行 —— 端口绑定即单实例互斥锁（OS 级原子 test-and-set）；
 *      `EADDRINUSE` → 打印「已在运行」并 `exit(1)`，**不再进入自检**（根除双实例 a2a 撞车）。
 *   2. `'listening'` 后写 pidfile（`<machine 根>/.a2a/launcher.pid`）→ 清理过期包装器配置
 *      → **启动对账清理**（清上次硬杀留下的无主孤儿，防其占住 a2aPort 令自检 EADDRINUSE）
 *      → **启动补结算**（v0.8.7 M6：无执行体的在飞任务上报 failed）→ 启动自检。
 *   3. 就绪门：自检通过前 `GET /health` 报 `status:"starting"`；通过后 `status:"ok"`
 *      （入站业务路由已退役，就绪态仅由 `/health` 的 `status` 字段表达）。
 *      v0.8.8 · M4 起 `/health` 另携 `degraded` 段（本机降级面：跳过自检 / 自检失败项目 /
 *      不可用项目集 / outbox 与出站循环存活 / 在飞数）；`status` 的取值口径不变。
 *   4. 自检**粒度按可否服务**（§2.4-⑤ 改判 · REQ-v0.8.6-2026-09-21-02 收口）：单项目失败
 *      → 逐项登记 `manager.unavailable` 后继续服务其余项目（`ready=true` 只要至少一项可用）；
 *      **机器级故障 = 全部项目不可用**，仅此一种才关端口 → 回收子进程 → 删 pidfile → `exit(1)`。
 *   5. 优雅停止（SIGINT/SIGTERM 或可选 `POST /shutdown`）共享同一幂等 `startShutdown()`。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { loadMachineConfig } from "../config.js";
import { pruneStaleAgentConfigs } from "./agents-prune.js";
import { appRootFromModule } from "./app-root.js";
import { AgentManager, DEFAULT_IDLE_STOP_MS } from "./manager.js";
import { errorMessage } from "./process.js";
import { reconcileInflightOnStartup } from "./reconcile-inflight.js";
import { reconcileStartupLedger } from "./reconcile.js";
import { InFlightLedger, createRunner, type Runner } from "./runner.js";
import {
  atomicWriteJson,
  createFileOutbox,
  outboxDirOf,
  type FileOutbox,
} from "./runner-outbox.js";
import { RUNNER_STATE_FILENAME } from "./runner-state.js";
import { runStartupSelfCheck, type SelfCheckResult } from "./self-check.js";
import { buildDegradedStatus, createLauncherApp } from "./server.js";
import { StopEventLedger } from "./stop-ledger.js";

/** 缺省机器配置：源码运行与构建运行均以 machine 单元根（含 package.json）为基准解析 */
const DEFAULT_MACHINE_CONFIG = join(appRootFromModule(import.meta.url), "config", "config.json");

const configPath = process.env["MACHINE_CONFIG"] ?? DEFAULT_MACHINE_CONFIG;
const machine = loadMachineConfig(configPath);

const appRoot = appRootFromModule(import.meta.url);
/** 在飞台账落盘目录（v0.8.7 M5）：`.a2a/inflight/<taskId>.json`，补结算孤儿识别的数据源 */
const INFLIGHT_DIR = join(appRoot, ".a2a", "inflight");

/**
 * 本机在飞任务台账（v0.7.0 M5·MC1）：**单一实例**，同时注入 AgentManager（idleStop 判据
 * 数据源 + 自检登记口）与 Runner（命令族 dispatch 登记）。自检早于 Runner 启动，故台账须在
 * manager 之前创建。
 * v0.8.7 M5：注入落盘 writer（原子写/清盘，best-effort —— 落盘失败不炸派发）；
 * 自检条目（`self-check:` 前缀）由台账自身排除，永不落盘。
 */
const inFlight = new InFlightLedger({
  persist: (entry, taskId) => {
    const path = join(INFLIGHT_DIR, `${taskId}.json`);
    try {
      if (entry !== null) atomicWriteJson(path, entry);
      else rmSync(path, { force: true });
    } catch (err) {
      console.error(
        `[launcher] 在飞台账落盘失败（不影响运行）：taskId=${taskId} ${errorMessage(err)}`,
      );
    }
  },
});
/**
 * 进程内停事件账（v0.8.10 · M-N4）：**单一实例**，由 `manager.stop()` 写（盖停因 + 当时的
 * 按项目在飞快照），`runner-exec` 结算时读（归因五键），`/health degraded` 与 `config-snapshot`
 * 播报读（取消观察面）。**不落盘** —— 连坐是进程内事实，重启后无在飞任务可归因。
 */
const stopEvents = new StopEventLedger();
const manager = new AgentManager(machine, { inFlight, stopEvents });

/** 实例元数据（非锁）：供 REQ-01 status/stop 读取 pid */
const PIDFILE_PATH = join(appRoot, ".a2a", "launcher.pid");

const idleStopMs = machine.launcher.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
const idleStopLabel = idleStopMs > 0 ? String(idleStopMs) : "disabled";
const listenHost = machine.launcher.listenHost;

let server: Server | null = null;
let shuttingDown = false;
/** 就绪门状态：自检通过前 false（`/health` 报 `status:"starting"`） */
let ready = false;
/** Runner 出站循环（v0.7.0 Phase A；仅当 launcher.bridge 配置齐全时非 null） */
let runner: Runner | null = null;
/** 本实例是否成功写入 pidfile（避免误删其它实例的文件） */
let pidfileWritten = false;
/** 结果回传 outbox（v0.8.7 M6 单实例：启动补结算与 Runner 共用；未配置 bridge 时恒 null） */
let outbox: FileOutbox | null = null;
/**
 * 启动自检结论。v0.8.8 · M4 起提到模块作用域，供 `/health` 的 `degraded` 段读点跨函数取用；
 * 对象身份不变，`onListening()` 内就地写入自检结果字段。
 */
const selfCheck: SelfCheckResult = { ok: true, failures: [], unavailable: [] };

const app = createLauncherApp({
  isReady: () => ready,
  // `/health` 的 bridge 段读点（M2·MA2）：runner 仅在自检通过且配置了 launcher.bridge
  // 时才存在；为 null（未启用 / 尚未启动）即视为恒未注册。
  getBridgeStatus: () =>
    runner?.healthSnapshot() ?? { registered: false, lastHeartbeatAt: null, lastError: null },
  // `/health` 的 degraded 段读点（v0.8.8 · M4）：只读汇总本机降级面（纯本机运维面，
  // 不经注册载荷外传 —— 与 orch 侧 degraded[] 互不相通）。
  getDegraded: () =>
    buildDegradedStatus({
      startupCheck: machine.launcher.startupCheck,
      selfCheckFailures: selfCheck.failures,
      unavailableProjectIds: manager.unavailableProjectIds(),
      outboxLoopAlive: outbox?.loopAlive ?? false,
      outboxPendingCount: outbox?.pendingCount ?? 0,
      runnerLoopAlive: runner?.loopAlive ?? false,
      inFlightCount: inFlight.size,
      // v0.8.10 · M-N4：取消超时未静默的项目集（与账单里的 `cancelUnsupported` 同名不同面）
      cancelUnsupported: manager.cancelUnsupportedProjectIds(),
      // v0.8.10 增补轨 · A1：闸快照两键（未接 bridge ⇒ 恒空映射，键不省略）
      gate: runner?.gateSnapshot(),
      // 全局最近一次「取消 → 静默」取消往返毫秒（停事件账透出；无观察 ⇒ null）
      lastCancelQuietMs: stopEvents.lastCancelQuiesceMsOverall(),
    }),
  shutdownEndpoint: machine.launcher.shutdownEndpoint === true,
  ...(machine.launcher.shutdownToken !== undefined
    ? { shutdownToken: machine.launcher.shutdownToken }
    : {}),
  onShutdown: () => {
    void startShutdown("shutdown-endpoint");
  },
});

function writePidfile(boundHost: string): void {
  try {
    mkdirSync(dirname(PIDFILE_PATH), { recursive: true });
    writeFileSync(
      PIDFILE_PATH,
      JSON.stringify({
        pid: process.pid,
        port: machine.launcher.port,
        host: boundHost,
        startedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    pidfileWritten = true;
  } catch (err) {
    console.error(`[launcher] 写入 pidfile 失败（不影响运行）：${errorMessage(err)}`);
  }
}

function removePidfile(): void {
  if (!pidfileWritten) return;
  pidfileWritten = false;
  try {
    rmSync(PIDFILE_PATH, { force: true });
  } catch (err) {
    console.error(`[launcher] 删除 pidfile 失败：${errorMessage(err)}`);
  }
}

/** IPv6 字面量加方括号，保证日志中的 URL 可解析 */
function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/** 实际绑定的 host（取 `server.address()`，缺省全网卡时为 `::` / `0.0.0.0`） */
function resolveBoundHost(): string {
  const address = server?.address();
  if (address !== null && address !== undefined && typeof address === "object") {
    return address.address;
  }
  return listenHost ?? "0.0.0.0";
}

function closeServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    const current = server;
    if (current === null) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    current.close(finish);
    // keep-alive 空闲连接不参与 close 回调等待，主动断开以免退出挂起
    current.closeIdleConnections();
    // 兜底：仍有活跃 keep-alive 连接（如刚响应完 /shutdown 的这条）时强制断开，
    // 保证退出有界，不因单个连接卡死 shutdown 链路
    const timer = setTimeout(() => {
      current.closeAllConnections();
      finish();
    }, 1000);
    timer.unref();
  });
}

/** 优雅停止（幂等）：关闭端口 → 回收全部子进程 → 删 pidfile → exit(0) */
async function startShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  // 先停 Runner 出站循环（中止在飞长轮询与退避等待），再收网络与子进程
  runner?.stop();
  runner = null;
  console.log(`[launcher] 收到 ${signal}，正在停止所有 Agent…`);
  await closeServer();
  await manager.shutdown();
  removePidfile();
  process.exit(0);
}

process.on("SIGINT", () => {
  void startShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void startShutdown("SIGTERM");
});

// 兜底：进程退出时同步树杀仍在运行的 child，并清理 pidfile
process.on("exit", () => {
  runner?.stop();
  manager.killAllSync();
  removePidfile();
});

/** 自检通过前 `/health` 报 `status:"starting"`，通过后置就绪 */
async function onListening(): Promise<void> {
  const boundHost = resolveBoundHost();
  console.log(
    `[launcher] machine=${machine.machineId} listening on http://${formatHost(boundHost)}:${machine.launcher.port}`,
  );
  console.log(`[launcher] config=${configPath}`);
  console.log(
    `[launcher] projects=${machine.projects.map((p) => p.projectId).join(",") || "(none)"}`,
  );
  console.log(`[launcher] idleStopMs=${idleStopLabel}`);
  writePidfile(boundHost);

  // 清理不属于当前 projects[] 的过期包装器配置（早于启动自检与对外服务）
  const prune = pruneStaleAgentConfigs(appRoot, machine.projects);
  if (prune.removed.length > 0) {
    console.log(
      `[launcher] 清理过期包装器配置 ${prune.removed.length} 个：${prune.removed.join(", ")}`,
    );
  }

  // 启动对账清理（本需求唯一能修「服务起不来」的动作）：清掉上次 Launcher 被硬杀留下的
  // 无主孤儿（wrapper），否则它们占住项目 a2aPort ⇒ 下面自检的 `ensure`
  // 撞 `EADDRINUSE` ⇒ fail-fast 退出。红线：活 Launcher 在册的项目禁清（此刻本进程持有
  // 端口 = 唯一实例，在册集合仅自身 ⇒ 其余条目均无主）。
  // fail-safe：清理异常一律不阻断启动、不 exit（reconcileStartupLedger 自身亦不抛出）。
  try {
    await reconcileStartupLedger();
  } catch (err) {
    console.error(`[launcher] 启动对账清理异常（不阻断启动）：${errorMessage(err)}`);
  }

  // 启动补结算（v0.8.7 · M6，台账链第二段）：上一进程遗留在 `.a2a/inflight/` 的在飞任务
  // 若本机已无执行体（子女账本无该项目存活 pid）⇒ 造 state=failed 新结果入 outbox 结账
  // （复用落盘 / Bearer / 退避 / ack，不违反「boot 不补发」—— 那条是不回放既有 outbox 文件）。
  // 时序：必须在 `reconcileStartupLedger` 之后（对账刚更新子女账本）、自检 ensure 之前
  // （自检新拉起的子进程会掩盖孤儿）。outbox 提前创建为单一实例，稍后随 Runner 启动投递循环
  // （orch 已核：`/runner/result` 不检查注册表 ⇒ 上报不必挂 register 之后）。
  if (machine.launcher.bridge !== undefined) {
    outbox = createFileOutbox({ dir: outboxDirOf(appRoot), bridge: machine.launcher.bridge });
    try {
      await reconcileInflightOnStartup({
        inflightDir: INFLIGHT_DIR,
        machineId: machine.machineId,
        outbox,
      });
    } catch (err) {
      console.error(`[launcher] 启动补结算异常（不阻断启动）：${errorMessage(err)}`);
    }
  }

  // 启动自检（缺省开）：端口已监听（互斥锁已生效）。
  // **粒度口径（§2.4-⑤ 改判 · REQ-v0.8.6-2026-09-21-02 收口）**：单项目失败一律项目级——
  // 逐项登记不可用、继续服务其余项目；`process.exit(1)` 只保留给**机器级故障 = 全部项目不可用**
  // （真机 2026-09-22：包装器进程提前退出等项目级 ensure 故障曾被误判机器级，致 7/8 可用仍整机退出）。
  if (machine.launcher.startupCheck ?? true) {
    const result = await runStartupSelfCheck(manager, machine);
    selfCheck.ok = result.ok;
    selfCheck.failures = result.failures;
    selfCheck.unavailable = result.unavailable;

    const total = machine.projects.length;
    const allUnavailable = total > 0 && result.unavailable.length >= total;

    for (const failure of result.failures) {
      console.error(
        `[launcher] 自检失败 ${failure.projectId}（${failure.stage}${failure.cause ? "/" + failure.cause : ""}）：${failure.reason}`,
      );
      if (failure.hint !== undefined) {
        console.error(`[launcher]   修复提示：${failure.hint}`);
      }
    }

    if (allUnavailable) {
      console.error(
        `[launcher] 机器级自检故障（全部项目不可用），退出（fail-fast；设 launcher.startupCheck=false 可跳过自检）`,
      );
      // 必须关端口再退出，否则下次 start 撞残留；同时回收全部子进程 / 删 pidfile
      await closeServer();
      await manager.shutdown();
      removePidfile();
      process.exit(1);
    }

    // 非机器级：逐项登记不可用，机器继续服务其余项目
    for (const failure of result.unavailable) {
      manager.markUnavailable(failure.projectId, `${failure.stage}: ${failure.reason}`);
    }
    if (result.unavailable.length > 0) {
      console.warn(
        `[launcher] 自检部分通过：可用 ${total - result.unavailable.length}/${total}，不可用项目 ${result.unavailable
          .map((f) => f.projectId)
          .join(",")}（已登记不可用，不影响其余项目服务）`,
      );
    }
  }

  ready = true;
  console.log(`[launcher] 就绪（status=ok）`);

  // Runner 出站（v0.7.0 Phase A 影子注册 · 节点 MA1）：仅在自检通过后启动，
  // 保证注册载荷携带真实自检结论。`launcher.bridge` 缺省 = 不启动（零出站，现状行为）。
  // M3·MB1：注入本机 AgentManager 作为命令执行宿主（ensure/stop/getProject），
  // 命令族三类（dispatch/stop/cancel-task）由 Runner 出站循环落地。
  // M4·MB2：注入文件 outbox（`.a2a/outbox/<taskId>.json` → POST /runner/result → ack 删）；
  // M6（v0.8.7）：outbox 在补结算处提前创建（同一实例），投递循环随本 Runner 启停。
  // M6·MC2：注入 runner-state 落盘路径（reaper 判活 Runner 的数据源）。
  if (machine.launcher.bridge !== undefined && outbox !== null) {
    const bridge = machine.launcher.bridge;
    runner = createRunner(machine, selfCheck, {
      manager,
      // M5·MC1：与 manager 共享同一在飞台账（idleStop 判据可见 dispatch 的在飞任务）
      ledger: inFlight,
      runnerStatePath: join(appRoot, ".a2a", RUNNER_STATE_FILENAME),
      outbox,
    });
    if (runner !== null) {
      console.log(`[launcher] Runner 出站已启动：url=${bridge.url}`);
      runner.start();
    }
  }
}

async function boot(): Promise<void> {
  // 先 listen（端口即锁）：第二实例在此被 EADDRINUSE 挡下，不再进入自检
  const instance: Server =
    listenHost === undefined
      ? app.listen(machine.launcher.port)
      : app.listen(machine.launcher.port, listenHost);
  server = instance;

  instance.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      const bind = listenHost === undefined ? "*" : listenHost;
      console.error(
        `[launcher] 已在运行 on ${bind}:${machine.launcher.port}（EADDRINUSE），本实例退出`,
      );
      process.exit(1);
    }
    console.error(`[launcher] 启动失败：${err.message}`);
    process.exit(1);
  });

  instance.on("listening", () => {
    void onListening();
  });
}

void boot();
