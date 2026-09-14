/**
 * Launcher 进程入口。
 * 机器配置路径来自环境变量 `MACHINE_CONFIG`（缺省 `<machine 单元根>/config/config.json`，模板见同目录 `config.json.default`），
 * 监听该配置的 `launcher.port`（可选 `launcher.listenHost`，缺省不设 = 绑定全部网卡）；退出时清理全部 Agent 子进程。
 *
 * 启动顺序（REQ-v0.2.1-2026-09-14-02「启动与退出健壮性」）：
 *   1. `listen(port[, listenHost])` 先行 —— 端口绑定即单实例互斥锁（OS 级原子 test-and-set）；
 *      `EADDRINUSE` → 打印「已在运行」并 `exit(1)`，**不再进入自检**（根除双实例 a2a 撞车）。
 *   2. `'listening'` 后写 pidfile（`<machine 根>/.a2a/launcher.pid`）→ 清理过期包装器配置 → 启动自检。
 *   3. 就绪门：自检通过前 `GET /health` 报 `status:"starting"`、业务路由 503；通过后 `status:"ok"`。
 *   4. 自检失败 fail-fast：关闭端口 → 回收全部子进程 → 删 pidfile → `exit(1)`。
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
import { runStartupSelfCheck } from "./self-check.js";
import { createLauncherApp } from "./server.js";

/** 缺省机器配置：源码运行与构建运行均以 machine 单元根（含 package.json）为基准解析 */
const DEFAULT_MACHINE_CONFIG = join(appRootFromModule(import.meta.url), "config", "config.json");

const configPath = process.env["MACHINE_CONFIG"] ?? DEFAULT_MACHINE_CONFIG;
const machine = loadMachineConfig(configPath);
const manager = new AgentManager(machine);

const appRoot = appRootFromModule(import.meta.url);
/** 实例元数据（非锁）：供 REQ-01 status/stop 读取 pid */
const PIDFILE_PATH = join(appRoot, ".a2a", "launcher.pid");

const idleStopMs = machine.launcher.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
const idleStopLabel = idleStopMs > 0 ? String(idleStopMs) : "disabled";
const listenHost = machine.launcher.listenHost;

let server: Server | null = null;
let shuttingDown = false;
/** 就绪门状态：自检通过前 false（业务路由 503） */
let ready = false;
/** 本实例是否成功写入 pidfile（避免误删其它实例的文件） */
let pidfileWritten = false;

const app = createLauncherApp(manager, {
  isReady: () => ready,
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
  manager.killAllSync();
  removePidfile();
});

/** 自检通过前业务路由 503，通过后置就绪 */
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

  // 启动自检（缺省开）：端口已监听（互斥锁已生效），全部项目通过才放行业务路由
  if (machine.launcher.startupCheck ?? true) {
    const result = await runStartupSelfCheck(manager, machine);
    if (!result.ok) {
      for (const failure of result.failures) {
        console.error(
          `[launcher] 自检失败 ${failure.projectId}（${failure.stage}）：${failure.reason}`,
        );
        if (failure.hint !== undefined) {
          console.error(`[launcher]   修复提示：${failure.hint}`);
        }
      }
      console.error(
        `[launcher] 启动自检未通过（${result.failures.length} 个项目失败），退出（fail-fast；设 launcher.startupCheck=false 可跳过自检）`,
      );
      // 必须关端口再退出，否则下次 start 撞残留；同时回收全部子进程 / 删 pidfile
      await closeServer();
      await manager.shutdown();
      removePidfile();
      process.exit(1);
    }
  }

  ready = true;
  console.log(`[launcher] 就绪（status=ok）`);
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
