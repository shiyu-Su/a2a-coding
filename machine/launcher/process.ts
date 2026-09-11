/**
 * Agent 子进程工具：spawn（Windows 走 shell 以解析 .cmd 包装器）、
 * stdout/stderr 逐行转发（不吞 stderr）、终止（Windows 杀进程树）。
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
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
 * 保证 `a2a-opencode` 等本地依赖在源码（machine/launcher/index.ts）与构建产物
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

/** Windows 杀进程树（shell 包装会多出 cmd.exe 中间层，普通 kill 杀不干净） */
function killTreeWindows(pid: number): Promise<void> {
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

/** 终止子进程：先优雅、后强杀；Windows 走 taskkill /T /F */
export async function terminateChild(child: ChildProcess, graceMs = KILL_GRACE_MS): Promise<void> {
  if (hasExited(child)) return;

  if (process.platform === "win32" && typeof child.pid === "number") {
    await killTreeWindows(child.pid);
    if (!hasExited(child)) child.kill();
    await waitForExit(child);
    return;
  }

  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (!hasExited(child)) child.kill("SIGKILL");
  }, graceMs);
  timer.unref();
  await waitForExit(child);
  clearTimeout(timer);
}
