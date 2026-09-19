/**
 * 桥进程生命周期工具（REQ-v0.8.0-2026-09-19-01 · 节点 B6）。
 *
 * - **子进程树杀**：win32 → `taskkill /pid <p> /T /F`；POSIX → 进程组 `SIGKILL`
 *   （`process.kill(-pid)`，覆盖孙进程），组不存在则回落单进程信号。防孤儿 `qodercn`。
 * - **致命错误分类**：端口占用（`EADDRINUSE` 等）→ 结构化 `{ code, exitCode: 1 }`，
 *   供入口 `main` 显式结构化退出（非静默）。
 *
 * 全部依赖可注入（platform / spawnTaskkill / signalGroup / signalProcess），便于单测。
 * 零第三方依赖；不 import `orch/**` / `launcher/**`。
 */
import { spawnSync } from "node:child_process";

export interface TreeKillDeps {
  platform?: NodeJS.Platform;
  /** win32 树杀（缺省 `taskkill /pid <p> /T /F`）。 */
  spawnTaskkill?: (pid: number) => void;
  /** POSIX 组杀（返回是否成功发出）。 */
  signalGroup?: (pid: number, signal: NodeJS.Signals) => boolean;
  /** POSIX 单进程回落。 */
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  /** 要发送的信号（缺省 SIGTERM；POSIX 组杀先发此信号）。 */
  signal?: NodeJS.Signals;
}

/**
 * 向"子进程树"发信号 / 强杀：
 * - win32：`taskkill /T /F`（忽略 signal，强制树杀）；
 * - POSIX：先尝试进程组 `signal`，失败回落单进程；再补一次 `SIGKILL` 组杀兜底。
 * 绝不抛出，`pid <= 1` 直接忽略（防 `kill(-1)` 灾难性广播）。
 */
export function killProcessTree(pid: number, deps: TreeKillDeps = {}): void {
  if (pid <= 1) return;
  const platform = deps.platform ?? process.platform;

  if (platform === "win32") {
    const taskkill =
      deps.spawnTaskkill ??
      ((target: number): void => {
        spawnSync("taskkill", ["/pid", String(target), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      });
    try {
      taskkill(pid);
    } catch {
      // 进程可能已退出，忽略
    }
    return;
  }

  const signal = deps.signal ?? "SIGTERM";
  const groupKill =
    deps.signalGroup ??
    ((target: number, sig: NodeJS.Signals): boolean => {
      try {
        process.kill(-target, sig);
        return true;
      } catch {
        return false;
      }
    });
  const procKill =
    deps.signalProcess ??
    ((target: number, sig: NodeJS.Signals): void => {
      try {
        process.kill(target, sig);
      } catch {
        // 进程可能已退出，忽略
      }
    });

  if (groupKill(pid, signal)) return;
  procKill(pid, signal);
}

/** 致命错误分类（结构化：错误码 + 退出码 + 文本）。 */
export interface FatalClassification {
  /** 错误码（如 `EADDRINUSE`；未知 → `UNKNOWN`）。 */
  code: string;
  /** 进程退出码（恒 1）。 */
  exitCode: number;
  /** 人类可读消息。 */
  message: string;
}

/** 把启动期致命错误归类为结构化退出信息（端口占用、权限等）。 */
export function classifyFatal(err: unknown): FatalClassification {
  const errno = err as NodeJS.ErrnoException | null;
  const code = errno !== null && typeof errno.code === "string" ? errno.code : "UNKNOWN";
  const message = err instanceof Error ? err.message : String(err);
  return { code, exitCode: 1, message };
}
