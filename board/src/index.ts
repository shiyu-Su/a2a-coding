/**
 * board 服务启动入口（BD1 骨架 + BD7 写面配置 + BD8 宿主面装配 + BD10 配置面无兜底 + BD11 组织名进表单
 * + **BD12″ 配置化** + **BD13″ 服务化**：pidfile 自写 / 行级时间戳日志 / SIGINT·SIGTERM 与 `POST /shutdown` 共用优雅停机链）。
 *
 * **BD12″ 起配置只从文件读**（用户裁定：「需要配置文件、template、default，而非启动参数」）：
 * 生效配置 = `config/config.json`（活配置，gitignored；模板 `config.json.default` 逐项标注），
 * 启动期读一次（热改不生效、须重启）；**env `BOARD_CONFIG` 只覆盖配置文件路径**，
 * argv 与其余 `BOARD_*` env 一律**不再承载配置内容**（`--port` / `--orgs-dir=` / `--group=` /
 * `--host-kind=` 等通道已撤掉）。加载与校验见 `config.ts`；非法配置以 `[config] …` 文案 fail-fast。
 *
 * 各键语义与缺省（与 BD12″ 之前逐项一致，只挪通道不改语义）：
 * - `port`：缺省 3400；绑定地址**恒为 loopback**（`host` 可覆盖为 `::1` / `localhost`，非 loopback 一律拒起）。
 * - **组织名（BD11 起 = 用户在前台创建/指定）**：主来源是**提需求表单**的 `group` 字段（第一次填写某组织名
 *   = 在板上创建该组织）。配置文件里的 `group` 是**可选默认组织**：表单留空时才用它，**缺失不报错** ——
 *   校验点在**请求期**（表单空 ∧ 无默认 ⇒ `POST /requirements` 结构化 400 `board_group_required`，
 *   不猜、不回落）。宿主面在桥侧 `ownerGroup` 也为空时仍回退该默认，两者皆无 ⇒ 结构化 503
 *   `board_org_not_resolved`。
 * - `orgsDir`（组织目录根，BD8）：**刻意没有缺省值**（§3.8 裁定 9：板不可静默挑一个目录去 spawn 后端进程）
 *   ⇒ 未配置时宿主面不装配，`GET /host` 如实显示「宿主面未装配」，两条宿主写端点返回结构化 503。
 * - `hostKind`：宿主后端 kind，缺省 `claude`；`bridgeUrl` / `mcpBaseUrl`：读面桥 / 写面 MCP 基址；
 *   `machineDist`：machine 运行时产物目录，缺省按仓根推导；`turnTimeoutMs`：单轮有界等待，未配交 BD4b 缺省。
 */
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createBoardServer } from "./server.js";
import { loadConfig, CONFIG_PATH_ENV } from "./config.js";
import {
  HostBridgeManager,
  defaultMcpUrlForOrg,
  type HostBridgeConfig,
} from "./host-bridge.js";
import { HostTurnManager, createHostBridgeGateway } from "./host-turn.js";
import { createHostFace, orgBridgeConfig, type BoardHostFace } from "./host-face.js";
import { readVersion } from "./version.js";
import { patchStreamTimestamp } from "./log.js";
import { createFatalRecorder, defaultFatalLogPath } from "./fatal-log.js";
import {
  buildPidRecord,
  createShutdownChain,
  defaultPidfilePath,
  writePidfile,
} from "./lifecycle.js";

/** 板根（`dist/` 的上一级）：pidfile 与致命日志都按它定位（不依赖 cwd、不依赖配置已解析）。 */
const boardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * **启动期致命记录器**（BD19 · 缺陷②）—— 对象本身无进程副作用（测试 import 本模块也拿得到一个
 * 没人调用的记录器），**真正安装 `uncaughtException` / `unhandledRejection` 钩子在
 * {@link installBootstrapGuards}，且只在直跑入口时装**。
 */
const fatal = createFatalRecorder({ file: defaultFatalLogPath(boardRoot) });

/**
 * 启动失败的**唯一**出口：先用致命记录器落一条（logger 未就绪 ⇒ `board.fatal.log`），再以 1 退出。
 *
 * ⚠ 装钩子会**吞掉** Node 的默认行为（默认 = 打 stderr 后以 1 死掉），所以这里必须把「退出 1」
 * 显式补回来 —— 否则「启动失败却还活着」会变成新的不可观测面。
 */
function failStartup(err: unknown, source: string): never {
  if (fatal.record(source, err) === "lost") {
    // 两条通道都写不出去（盘不可写）⇒ 至少别再吞掉这一次崩溃
    process.stderr.write(`board 启动失败（且致命日志不可写）：${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
}

/** 进程级钩子：**只由直跑入口调用**（测试进程 import 时零挂钩）。 */
function installBootstrapGuards(): void {
  fatal.setPhase("模块加载完成 · bootstrap");
  process.on("uncaughtException", (err: unknown) => failStartup(err, "uncaughtException"));
  process.on("unhandledRejection", (reason: unknown) => failStartup(reason, "unhandledRejection"));
}


/**
 * 装配宿主面（BD8）：BD4a 托管器 + BD4b 轮次 + {@link BoardHostFace} 接线。
 * `orgsDir = null` ⇒ 直接返 `null`（不建任何托管器 ⇒ 板不会去 spawn 任何进程）。
 */
export function buildHostFace(input: {
  orgsDir: string | null;
  defaultOrg: string | null;
  kind: string;
  mcpBaseUrl: string;
  machineDist: string;
  turnTimeoutMs?: number;
}): { face: BoardHostFace; bridges: HostBridgeManager } | null {
  if (input.orgsDir === null) return null;
  const faceDeps = {
    orgsDir: input.orgsDir,
    defaultOrg: input.defaultOrg,
    kind: input.kind,
    ...(input.turnTimeoutMs !== undefined ? { turnTimeoutMs: input.turnTimeoutMs } : {}),
    mcpUrlFor: (org: string) => defaultMcpUrlForOrg(org, input.mcpBaseUrl),
  };
  const bridges = new HostBridgeManager({ machineDistDir: input.machineDist });
  const gateway = createHostBridgeGateway(bridges, (org) => {
    const config = orgBridgeConfig(faceDeps, org);
    if ("error" in config) {
      // 触发路径先查配置、不会走到这里；兜底只为「轮内重拉桥」时同样**不回落任何目录**。
      throw new Error(`${config.error.code}: ${config.error.message}`);
    }
    return config as HostBridgeConfig;
  });
  const turns = new HostTurnManager({ gateway });
  return { face: createHostFace({ ...faceDeps, bridges, turns }), bridges };
}

async function main(): Promise<void> {
  // BD13″ 行级时间戳：入口直跑才包装 stdout/stderr（import 方 = 测试进程，零副作用）；
  // console.* 走同一 write 出口，一并带时间戳落 board.log。
  fatal.setPhase("日志流包装");
  patchStreamTimestamp(process.stdout);
  patchStreamTimestamp(process.stderr, () => "error");
  fatal.setPhase("配置加载");
  const cfg = loadConfig();
  const group = cfg.group;
  const orgsDir = cfg.orgsDir;
  fatal.setPhase("宿主面装配");
  const hostFace = buildHostFace({
    orgsDir,
    defaultOrg: group,
    kind: cfg.hostKind,
    mcpBaseUrl: cfg.mcpBaseUrl,
    machineDist: cfg.machineDist,
    ...(cfg.turnTimeoutMs !== null ? { turnTimeoutMs: cfg.turnTimeoutMs } : {}),
  });
  fatal.setPhase("HTTP 监听");
  const handle = await createBoardServer({
    host: cfg.host,
    port: cfg.port,
    bridge: { baseUrl: cfg.bridgeUrl },
    defaultGroup: group,
    mcpBaseUrl: cfg.mcpBaseUrl,
    hostFace: hostFace?.face ?? null,
    docs: { repoRoot: cfg.repoRoot, orgsDir: cfg.orgsDir },
    onShutdown: () => shutdown("POST /shutdown"),
  });
  process.stdout.write(
    `board v${readVersion()} 监听 http://${handle.host}:${handle.port}/（配置来源 = ${cfg.sourcePath}${CONFIG_PATH_ENV in process.env ? `（经 env ${CONFIG_PATH_ENV} 指定）` : ""}）\n`,
  );
  process.stdout.write(
    `生效值：port = ${cfg.port} · host = ${cfg.host} · 读面桥 = ${cfg.bridgeUrl} · MCP 基址 = ${cfg.mcpBaseUrl} · hostKind = ${cfg.hostKind} · machineDist = ${cfg.machineDist} · turnTimeoutMs = ${cfg.turnTimeoutMs ?? "未配置（下游缺省 10 min）"}\n`,
  );
  if (group === null) {
    process.stdout.write(
      "未配默认组织（config.json 的 group）：不是错误 —— 组织名由提需求表单给出；未配默认时表单的组织名为必填，留空 ⇒ POST /requirements 结构化 400 board_group_required（不猜、不回落兜底组名）\n",
    );
  }
  if (hostFace === null) {
    process.stdout.write(
      "宿主面未装配：config.json 的 orgsDir 未配置（无缺省值，刻意不兜底）⇒ 不起桥、不触发一轮；触发端点返回结构化 503\n",
    );
  } else {
    // BD14：配了 orgsDir **不等于**落点可用 —— 目录不存在时这里必须出声，
    // 不能再照打「宿主面就绪」把问题推到第一次触发一轮（真机上曾以 502 + 负 errno 暴露）。
    const orgsDirProblem = hostFace.face.orgsDirProblem();
    if (orgsDirProblem !== null) {
      process.stderr.write(`警告：${orgsDirProblem.message}\n`);
      process.stderr.write(
        `宿主面已装配但**未就绪**：任何组织的触发一轮一律返回结构化 503 ${orgsDirProblem.code}（不起桥、不代建目录）\n`,
      );
    } else {
      process.stdout.write(`宿主面就绪：组织目录根 = ${orgsDir ?? "—"} · kind = ${cfg.hostKind}\n`);
    }
  }

  // BD13″ pidfile：**板自己写**（listening 之后），boardctl 只读；停机路径删。
  fatal.setPhase("pidfile 写入");
  const pidfilePath = defaultPidfilePath(boardRoot);
  if (writePidfile(pidfilePath, buildPidRecord({ port: handle.port, host: handle.host }))) {
    process.stdout.write(`pidfile：${pidfilePath}（pid=${process.pid}）\n`);
  }

  // BD19：走到这里 = 日志通道（`board.log` 重定向 + 行级时间戳）已可用 ⇒ 致命记录器**切正常日志**，
  // 之后的崩溃不再单开 `board.fatal.log`（那条通道只服务「logger 之前死掉」这一段）。
  fatal.markLoggerReady();

  // BD13″ 优雅停机（SIGINT / SIGTERM 与 POST /shutdown **共用一条链**，重入幂等）：
  // 链的实现见 `lifecycle.createShutdownChain`（先停宿主桥 → 关卡口 → 删 pidfile）。
  //
  // **BD19 缺陷① · 全仓唯一的停机终点 `process.exit`**（`forceExit`）：
  // 既有纪律「主流程不 `process.exit`、只设 `exitCode`」防的是**运行期**退出码被 Windows 污染，
  // 而这里已是**停机终点**（链已走完：桥已停、口已关、pidfile 已删、日志已打），
  // 要的恰恰是「一定退得出去」的确定性 ⇒ 两者不冲突，且它仍排在 `setExitCode(0)` 之后、
  // 只在「链完成后仍未退出」时才介入（定时器 `unref()` ⇒ 正常收尾时压根轮不到它 fire）。
  // 启动失败那条 `process.exit(1)`（{@link failStartup}）是另一条路径，不是本闸。
  const shutdown = createShutdownChain({
    stopBridges: async () => {
      await hostFace?.bridges.stopAll("shutdown");
    },
    closeServer: () => handle.close(),
    pidfilePath,
    log: (line) => void process.stdout.write(line),
    forceExit: (code) => void process.exit(code),
  });
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

// 仅当作为脚本直接运行时启动（import 时不自启，便于测试）
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  // BD19：**钩子先于任何启动动作**装上 ⇒ 死在配置校验 / 宿主面装配 / 监听之前的那一段，
  // 也能留下 `board.fatal.log`（此前这一段是「零日志 + pidfile 不写 + boardctl 只报启动超时」）。
  installBootstrapGuards();
  main().catch((err: unknown) => failStartup(err, "main()"));
}
