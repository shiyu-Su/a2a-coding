/**
 * Launcher 进程入口。
 * 机器配置路径来自环境变量 `MACHINE_CONFIG`（缺省 `<machine 单元根>/config/config.json`，模板见同目录 `config.json.default`），
 * 监听该配置的 `launcher.port`；退出时清理全部 Agent 子进程。
 *
 * 启动自检（缺省开，`launcher.startupCheck=false` 跳过）：在监听端口前对本机
 * 全部项目逐个 ensure → 真实最小任务 → 校验 → stop；任一失败即 fail-fast 退出
 * （非零），避免「机器看似起来、一用就废」。
 */
import type { Server } from "node:http";
import { join } from "node:path";
import { loadMachineConfig } from "../config.js";
import { appRootFromModule } from "./app-root.js";
import { AgentManager, DEFAULT_IDLE_STOP_MS } from "./manager.js";
import { runStartupSelfCheck } from "./self-check.js";
import { createLauncherApp } from "./server.js";

/** 缺省机器配置：源码运行与构建运行均以 machine 单元根（含 package.json）为基准解析 */
const DEFAULT_MACHINE_CONFIG = join(
  appRootFromModule(import.meta.url),
  "config",
  "config.json",
);

const configPath = process.env["MACHINE_CONFIG"] ?? DEFAULT_MACHINE_CONFIG;
const machine = loadMachineConfig(configPath);
const manager = new AgentManager(machine);
const app = createLauncherApp(manager);

// 空闲回收（用完退出）的有效设置：缺省 5 分钟，0/负值表示禁用
const idleStopMs = machine.launcher.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
const idleStopLabel = idleStopMs > 0 ? String(idleStopMs) : "disabled";

let server: Server | null = null;

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[launcher] 收到 ${signal}，正在停止所有 Agent…`);
  if (server !== null) server.close();
  await manager.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

// 兜底：进程退出时同步杀掉仍在运行的孩子，避免泄漏
process.on("exit", () => {
  manager.killAllSync();
});

async function boot(): Promise<void> {
  // 启动自检（缺省开）：全部项目通过才对外监听；失败 fail-fast 退出
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
      process.exit(1);
    }
  }

  server = app.listen(machine.launcher.port, () => {
    console.log(
      `[launcher] machine=${machine.machineId} listening on http://127.0.0.1:${machine.launcher.port}`,
    );
    console.log(`[launcher] config=${configPath}`);
    console.log(
      `[launcher] projects=${machine.projects.map((p) => p.projectId).join(",") || "(none)"}`,
    );
    console.log(`[launcher] idleStopMs=${idleStopLabel}`);
  });

  server.on("error", (err: Error) => {
    console.error(`[launcher] 启动失败：${err.message}`);
    process.exit(1);
  });
}

void boot();
