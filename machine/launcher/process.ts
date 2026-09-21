/**
 * Agent 子进程工具：spawn（Windows 走 shell 以解析 .cmd 包装器）、
 * stdout/stderr 逐行转发（不吞 stderr）、终止。
 *
 * 终止语义（REQ-v0.4.1-2026-09-15-03 §2.7）：
 * - **Windows**：`taskkill /T /F` 树杀（既有行为不变）；
 * - **POSIX**：`spawn` 以 `detached: true` 建**独立进程组**（pgid = child.pid），终止时用
 *   `process.kill(-pid, …)` **组杀**，覆盖 shell / CLI 派生的**孙进程**（单进程 kill 会漏）。
 */
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { delimiter, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { LaunchSpec } from "../adapters/types.js";
import { appRootFromModule } from "./app-root.js";

const KILL_GRACE_MS = 5000;
const EXIT_WAIT_FALLBACK_MS = 10_000;

/**
 * 应用根目录：源码运行（<root>/machine/launcher）与构建运行（<root>/dist/machine/launcher）
 * 深度不同，固定层级相对路径无法兼顾，改为自模块目录向上查找 package.json。
 */
const APP_ROOT = appRootFromModule(import.meta.url);

/**
 * 子进程环境：把 `<root>/node_modules/.bin` 前置到 PATH，
 * 保证本地可执行依赖（后端命令解析等）在源码（machine/launcher/index.ts）与构建产物
 * （dist/machine/launcher/index.js）两种启动方式下都可解析。
 */
function buildChildEnv(): NodeJS.ProcessEnv {
  const binDir = resolve(APP_ROOT, "node_modules", ".bin");
  // Windows 上 PATH 的键名可能是 `Path`：沿用现有键名，避免大小写重复项
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const currentPath = process.env[pathKey] ?? "";
  return {
    ...process.env,
    [pathKey]: currentPath.length > 0 ? `${binDir}${delimiter}${currentPath}` : binDir,
  };
}

/** 子进程是否已退出（正常退出或被动信号） */
export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** 提取 unknown 错误的人类可读消息 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Windows 上 Node 无法直接执行 npm 的 .cmd shim，需经 cmd.exe；
 * 含空白/引号的参数需预先加引号（Node shell 模式不做转义）。
 */
function quoteForCmd(arg: string): string {
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** 启动 A2A 包装器进程；cwd 固定为项目 workspace，隔离工作目录 */
export function spawnAgentProcess(spec: LaunchSpec, workspace: string): ChildProcess {
  const stdio: StdioOptions = ["ignore", "pipe", "pipe"];
  const env = buildChildEnv();
  if (process.platform === "win32") {
    // Windows 无法直接执行 npm 的 .cmd shim，需经 cmd.exe。自行拼接并预转义参数，
    // 避免 `spawn(cmd, args, { shell: true })` 的 DEP0190（参数不转义只拼接）告警。
    const commandLine = [spec.command, ...spec.args.map(quoteForCmd)].join(" ");
    return spawn(commandLine, { cwd: workspace, shell: true, windowsHide: true, stdio, env });
  }
  return spawn(spec.command, spec.args, {
    cwd: workspace,
    shell: false,
    // POSIX：建独立进程组（组长 = 本子进程）⇒ 终止时可按组杀覆盖孙进程。
    // 注意**不 `unref()`**：仍需 stdio 管道与 `exit` 事件跟踪该子进程。
    // Windows 分支不带该选项（行为不变）。
    detached: true,
    windowsHide: true,
    stdio,
    env,
  });
}

/** 将子进程 stdout/stderr 逐行转发到父进程（保留 stderr，便于诊断） */
export function pipeChildOutput(child: ChildProcess, prefix: string): void {
  forwardLines(child.stdout, (line) => {
    console.log(`${prefix} ${line}`);
  });
  forwardLines(child.stderr, (line) => {
    console.error(`${prefix} ${line}`);
  });
}

function forwardLines(stream: Readable | null, onLine: (line: string) => void): void {
  if (stream === null) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      onLine(buffer.slice(0, newlineIndex).replace(/\r$/, ""));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) onLine(buffer.replace(/\r$/, ""));
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    // 兜底：极端情况下 exit 事件未到达，避免调用方永久挂起
    const timer = setTimeout(() => {
      resolve();
    }, EXIT_WAIT_FALLBACK_MS);
    timer.unref();
  });
}

/**
 * 向**进程组**发信号（POSIX 专用）：`process.kill(-pid, signal)`。
 *
 * 组不存在（`ESRCH`，例如该子进程不是组长 / 已退出）时回落单进程信号，保证不静默失效。
 * 绝不抛出：返回是否至少成功发出一次信号。
 */
function signalProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  // 防 `kill(-1)` / `kill(0)` 这类"广播给自己全部进程"的灾难性误用（正常 pid 恒 > 1）
  if (pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      // 进程可能已退出，忽略
      return false;
    }
  }
}

/**
 * 向"子进程树"发信号：POSIX 有 pid ⇒ 组杀（含孙进程）；无 pid 或非 POSIX ⇒ 退化为对
 * 直接子进程 `child.kill(signal)`（保持 win32 无 pid 时的既有语义）。绝不抛出。
 */
function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform !== "win32" && signalProcessTree(pid, signal)) return;
  try {
    child.kill(signal);
  } catch {
    // 进程可能已退出，忽略
  }
}

/**
 * 异步杀进程树（shell 包装会多出 cmd.exe 中间层，普通 kill 杀不干净）。
 * win32 走 `taskkill /T /F`；POSIX 走 `process.kill(-pid, "SIGKILL")` **组杀**（补孙进程）。
 * 供 `terminateChild` 与 `manager` 复用。
 */
export function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    return new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("exit", () => {
        resolve();
      });
      killer.once("error", () => {
        resolve();
      });
    });
  }
  signalProcessTree(pid, "SIGKILL");
  return Promise.resolve();
}

/**
 * 同步杀进程树：`process.on("exit")` 中不可 await，必须同步完成。
 * win32 → `spawnSync("taskkill", ["/pid", pid, "/T", "/F"])`；POSIX → 组杀
 * `process.kill(-pid, "SIGKILL")`。
 * 任何失败都降级为 `child.kill()`，绝不抛出（exit 钩子内抛错会被忽略且污染退出码）。
 */
export function killProcessTreeSync(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill();
    } catch {
      // 进程可能已退出，忽略
    }
    return;
  }
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      try {
        child.kill();
      } catch {
        // 进程可能已退出，忽略
      }
    }
    return;
  }
  if (signalProcessTree(pid, "SIGKILL")) return;
  try {
    child.kill();
  } catch {
    // 进程可能已退出，忽略
  }
}

/**
 * 终止子进程：先优雅、后强杀。
 * - Windows：`taskkill /T /F` 树杀（既有行为不变）；
 * - POSIX：`SIGTERM` → 宽限 `graceMs` → `SIGKILL`，**两者都面向进程组**（覆盖孙进程）。
 *   SIGTERM 的优雅期**保留**（见报告：让 CLI/包装器有机会 flush / 清理；去掉只会把
 *   "半写文件"窗口从"通常瞬间"变成"必然停在写入中途"，且失去优雅清理）。
 */
export async function terminateChild(child: ChildProcess, graceMs = KILL_GRACE_MS): Promise<void> {
  if (hasExited(child)) return;

  if (process.platform === "win32" && typeof child.pid === "number") {
    await killProcessTree(child.pid);
    if (!hasExited(child)) child.kill();
    await waitForExit(child);
    return;
  }

  signalChildTree(child, "SIGTERM");
  const timer = setTimeout(() => {
    if (!hasExited(child)) signalChildTree(child, "SIGKILL");
  }, graceMs);
  timer.unref();
  await waitForExit(child);
  clearTimeout(timer);
}
