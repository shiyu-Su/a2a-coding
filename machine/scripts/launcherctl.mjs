#!/usr/bin/env node
/**
 * Launcher 跨平台启停脚本（REQ-v0.2.1-2026-09-14-01）。
 *
 * 纯 Node ESM，零第三方依赖、无需构建：
 *   node scripts/launcherctl.mjs start|stop|restart|status|logs [options]
 *
 * 关键约定（与改造文档 §2.2 对齐）：
 *   - 入口   machine/dist/launcher/index.js（start 前若不存在则先 npm run build）
 *   - pidfile machine/.a2a/launcher.pid（由 Launcher 写，JSON { pid, port, host, startedAt }）
 *   - 日志   machine/.a2a/logs/launcher.log（脚本重定向 stdout/stderr）
 *   - 配置   透传 MACHINE_CONFIG（缺省 machine/config/config.json），端口读 launcher.port
 *
 * 单实例互斥由 Launcher 内部承担（先 listen，端口即锁）；本脚本只做「先探测再起」的快速判定，
 * stop/status 依赖 pidfile + 端口探测，pidfile 缺失/陈旧时不误杀。
 *
 * Windows 脱壳拉起（REQ-v0.6.2-2026-09-18-02 增补轨 D-N1）：
 *   常驻 Launcher 经 WMI `Win32_Process.Create` 脱壳（挂 WmiPrvSE，**不在**调用方作业 / 进程树内），
 *   由隐藏窗口的壳进程 `Start-Process` 拉起 —— 否则宿主工具会「等自己的作业清空」而卡住。
 *   脱壳不可用（无 WMI / 权限不足 / 判定失败）⇒ **显式**降级 `spawn(detached)` 并在 stdout 警告（不静默）。
 *   POSIX 保持 `spawn(detached:true)` + `unref()`（setsid 天然脱离）。
 *
 * 就绪语义（REQ-v0.6.2-2026-09-18-02，C1–C8）：
 *   - 判据键一律取 `/health` 的 `status`（launcher 自检期 = 200 + starting；不得依赖 HTTP 码）。
 *   - 缺省 start：等 L1（/health 可答 = HTTP 200）即返回；exit 0 ≠ 业务就绪（starting 时业务路由 503）。
 *   - `--no-wait`：发起即返（exit 0 = 已发起，≠ 就绪）；spawn 同步失败才 exit 1；pid 仅供参考。
 *   - `--wait-ready`：等待 status=ok 才 exit 0；超时/失败 exit 1（按 `自检失败`/`[self-check]` 过滤行输出）。
 *   - 三分类占用（键 = status）：不可答 / status 非 `ok`|`starting` ⇒ 真占用 exit 1；
 *     `ok` ⇒ 已在运行 exit 0；`starting` ⇒ 本服务启动中（缺省/--no-wait 即返 0，--wait-ready 续等）。
 *   - 竞态归属：以 pidfile 与本次 spawn 的 child 交叉校验（输家提示「另一实例已接管」并 exit 0），不引入脚本级锁。
 *   - 退出码恒 {0,1}（C5）。
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** start 等待 L1（/health 可答 = HTTP 200）的超时（端口在自检前即监听，通常毫秒级） */
const READY_TIMEOUT_MS = 30_000;
/** stop 等待端口释放的超时 */
const STOP_TIMEOUT_MS = 15_000;
/** 单次 TCP 探测超时 / 轮询间隔 */
const PROBE_TIMEOUT_MS = 1_000;
const PROBE_INTERVAL_MS = 200;
/** logs --follow 轮询间隔 */
const FOLLOW_INTERVAL_MS = 300;
/**
 * 单项目启动自检缺省总超时。与 launcher/self-check.ts 的 DEFAULT_STARTUP_CHECK_TIMEOUT_MS 同值
 * （脚本不 import TS 产物，故此处常量须与它保持一致）。
 */
const DEFAULT_STARTUP_CHECK_TIMEOUT_MS = 120_000;
/**
 * `--wait-ready` 缺省整段硬上限 = max(下限, N × startupCheckTimeoutMs + 余量)：
 * 自检按项目顺序串行，N 个项目最坏 N × 单项目超时；再留一个自检超时作余量。
 */
const READY_WAIT_FLOOR_MS = 60_000;
const READY_WAIT_MARGIN_MS = 60_000;
/** 竞态归属判定时等待子进程收尾（输家因 EADDRINUSE 会立即退出）的上限 */
const CHILD_SETTLE_TIMEOUT_MS = 2_000;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MACHINE_ROOT = findMachineRoot(SCRIPT_DIR);
const LAUNCHER_ENTRY = join(MACHINE_ROOT, "dist", "launcher", "index.js");
const PIDFILE_PATH = join(MACHINE_ROOT, ".a2a", "launcher.pid");
const LOG_DIR = join(MACHINE_ROOT, ".a2a", "logs");
const LOG_PATH = join(LOG_DIR, "launcher.log");
const CONFIG_PATH = process.env["MACHINE_CONFIG"] ?? join(MACHINE_ROOT, "config", "config.json");

function fail(message) {
  console.error(`[launcherctl] ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[launcherctl] ${message}`);
}

/** 降级告警（stdout，必须可见）：如脱壳不可用时提示「调用方可能被拖住」 */
function warn(message) {
  console.log(`[launcherctl] 警告：${message}`);
}

function delay(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/** 自脚本目录向上查找含 package.json 的目录（machine 单元根） */
function findMachineRoot(startDir) {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

/**
 * 读取机器配置里脚本关心的字段（端口 / 绑定地址 / 可选优雅停止端点 / 启动自检参数）。
 * `startupCheck` / `startupCheckTimeoutMs` / projects 数用于推导 `--wait-ready` 的缺省硬上限。
 */
function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    fail(`无法读取配置 ${CONFIG_PATH}：${err instanceof Error ? err.message : String(err)}`);
  }
  const launcher = raw?.launcher;
  if (launcher === null || typeof launcher !== "object" || typeof launcher.port !== "number") {
    fail(`配置缺少 launcher.port：${CONFIG_PATH}`);
  }
  const projects = Array.isArray(raw?.projects) ? raw.projects : [];
  return {
    path: CONFIG_PATH,
    port: launcher.port,
    listenHost: typeof launcher.listenHost === "string" ? launcher.listenHost : undefined,
    shutdownEndpoint: launcher.shutdownEndpoint === true,
    shutdownToken: typeof launcher.shutdownToken === "string" ? launcher.shutdownToken : undefined,
    /** 启动自检开关（与 launcher/index.ts 的 `?? true` 同口径） */
    startupCheck: launcher.startupCheck !== false,
    /** 单项目自检超时（缺省与 launcher/self-check.ts 同值） */
    startupCheckTimeoutMs:
      typeof launcher.startupCheckTimeoutMs === "number" && launcher.startupCheckTimeoutMs > 0
        ? launcher.startupCheckTimeoutMs
        : DEFAULT_STARTUP_CHECK_TIMEOUT_MS,
    /** projects 数（`--wait-ready` 缺省硬上限 = N × startupCheckTimeoutMs + 余量） */
    projectCount: projects.length,
  };
}

/** 读取 pidfile；缺失或形状不合法返回 null */
function readPidfile() {
  try {
    const raw = JSON.parse(readFileSync(PIDFILE_PATH, "utf8"));
    if (raw === null || typeof raw !== "object" || typeof raw.pid !== "number") return null;
    return {
      pid: raw.pid,
      port: typeof raw.port === "number" ? raw.port : undefined,
      host: typeof raw.host === "string" ? raw.host : undefined,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
    };
  } catch {
    return null;
  }
}

/** 探测目标地址：pidfile.host 优先，其次配置 listenHost，通配地址归一为 127.0.0.1 */
function resolveProbeHost(config, pidfile) {
  const candidate = pidfile?.host ?? config.listenHost;
  if (candidate === undefined || candidate === "0.0.0.0" || candidate === "::") return "127.0.0.1";
  return candidate;
}

function formatHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}

function baseUrl(host, port) {
  return `http://${formatHost(host)}:${port}`;
}

/** 单次 TCP 连接探测：能连上即认为端口已监听 */
function probePort(port, host, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ port, host });
    const finish = (ok) => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/** GET /health；非 200 或网络错误返回 null */
async function httpHealth(host, port, timeoutMs = 2_000) {
  try {
    const res = await fetch(`${baseUrl(host, port)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return null;
    const body = await res.json().catch(() => null);
    return {
      status: typeof body?.status === "string" ? body.status : undefined,
      protocolVersion: typeof body?.protocolVersion === "string" ? body.protocolVersion : undefined,
    };
  } catch {
    return null;
  }
}

/** L1 谓词：/health 已可答（HTTP 200，status 任意） */
function healthAnswerable(health) {
  return health !== null;
}

/** 业务就绪谓词：/health `status === "ok"`（`starting` = 自检未过，不算就绪） */
function healthReady(health) {
  return health !== null && health.status === "ok";
}

/**
 * 轮询 /health 至满足谓词或超时（每次调用独立超时）。
 * 等待循环内 `null` = 尚未起 ⇒ **继续轮询**（不判占用）；超时返回 `matched: null`。
 * 返回 `{ matched, last }`：`matched` = 命中的 health；`last` = 超时前最后一次可答的 health（诊断用）。
 * 双谓词：L1 用 `healthAnswerable`；业务就绪用 `healthReady`。
 */
async function waitForHealth(host, port, timeoutMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const health = await httpHealth(host, port);
    if (health !== null) {
      last = health;
      if (predicate(health)) return { matched: health, last: health };
    }
    if (Date.now() >= deadline) return { matched: null, last };
    await delay(PROBE_INTERVAL_MS);
  }
}

/** 轮询端口释放；释放返回 true，超时返回 false */
async function waitPortRelease(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await probePort(port, host))) return true;
    if (Date.now() >= deadline) return false;
    await delay(PROBE_INTERVAL_MS);
  }
}

/** 进程存活判定：ESRCH=不存在；EPERM=存在但无权限（视为存活） */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function removePidfileIfPresent() {
  if (!existsSync(PIDFILE_PATH)) return;
  try {
    rmSync(PIDFILE_PATH, { force: true });
  } catch (err) {
    console.error(
      `[launcherctl] 删除 pidfile 失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** start 前确保 dist 已构建；缺失则尝试 npm run build */
function ensureBuilt() {
  if (existsSync(LAUNCHER_ENTRY)) return;
  info(`未找到 ${LAUNCHER_ENTRY}，执行 npm run build …`);
  const result = spawnSync("npm run build", { cwd: MACHINE_ROOT, stdio: "inherit", shell: true });
  if (result.status !== 0 || !existsSync(LAUNCHER_ENTRY)) {
    fail(`构建失败，请先在 ${MACHINE_ROOT} 运行 npm run build`);
  }
}

/** /health 状态标签（诊断输出用；null = 不可答） */
function healthStatusLabel(health) {
  if (health === null) return "不可答";
  return health.status === undefined ? "(缺失)" : health.status;
}

/**
 * 入口占用判定三分类（键 = `/health` 的 `status`，不依赖 HTTP 码）：
 *   free     ：端口未监听 ⇒ 可拉起。
 *   occupied ：端口在监听但 /health 不可答（非 200 / 网络错误 / 超时），或 status 缺失/非白名单
 *              ⇒ **真占用**（非本服务）⇒ 调用方 exit 1。
 *   ready    ：status === "ok" ⇒ 已在运行且已就绪 ⇒ exit 0。
 *   starting ：status === "starting" ⇒ 本服务启动中（自检未过）。
 * 适用范围：`null ⇒ occupied` **仅入口探测**；等待循环内 `null` = 尚未起，继续轮询（见 waitForHealth）。
 */
async function classifyOccupancy(config) {
  const pidfile = readPidfile();
  const host = resolveProbeHost(config, pidfile);
  const port = config.port;

  if (!(await probePort(port, host))) return { kind: "free", host, port, pidfile };

  const health = await httpHealth(host, port);
  if (health === null) {
    return {
      kind: "occupied",
      host,
      port,
      pidfile,
      reason: "端口在监听但 /health 不可答（非 200 / 网络错误 / 超时）",
    };
  }
  if (health.status === "ok") return { kind: "ready", host, port, pidfile, health };
  if (health.status === "starting") return { kind: "starting", host, port, pidfile, health };
  return {
    kind: "occupied",
    host,
    port,
    pidfile,
    reason: `端口在监听但 /health status=${health.status === undefined ? "(缺失)" : `"${health.status}"`} 不在白名单（ok / starting）`,
  };
}

/** 有界等待子进程收尾；返回是否已退出（exitCode / signalCode 任一落定） */
async function settleChildExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(50);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * 竞态归属交叉校验（**不引入脚本级锁**）：以 pidfile 归属判定本次 spawn 的子进程是赢家还是输家。
 *   winner   ：pidfile.pid === child.pid ⇒ 本实例真身。
 *   loser    ：pidfile 存在、pid 与 child.pid 不同、且 child 已退出 ⇒ 端口被另一实例接管（EADDRINUSE），
 *              本实例子进程已死 ⇒ 调用方输出「另一实例已接管 pid=…」并 exit 0。
 *   uncertain：**pidfile 缺失**，或 pid 不同但子进程仍未退出 ⇒ 无法归属，只报告、不冒充。
 */
async function resolveOwnership(child) {
  const pidfile = readPidfile();
  if (pidfile === null) return { kind: "uncertain", pid: undefined };
  if (child.pid !== undefined && pidfile.pid === child.pid) {
    return { kind: "winner", pid: pidfile.pid };
  }
  const exited = await settleChildExit(child, CHILD_SETTLE_TIMEOUT_MS);
  if (exited) return { kind: "loser", pid: pidfile.pid };
  return { kind: "uncertain", pid: pidfile.pid };
}

/** PowerShell 单引号字面量（内部单引号翻倍）：把任意字符串安全嵌入 PS 源码 */
function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/** PowerShell `-EncodedCommand` 载荷（UTF-16LE + Base64）：规避多层命令行的引号 / 转义问题 */
function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * 脱壳壳脚本（Windows）：隐藏窗口拉起常驻 Launcher，stdout / stderr **追加合并**落 launcher.log。
 * 说明：`Start-Process` 不允许 stdout / stderr 指向同一文件（InvalidOperationException），
 * 故经 `cmd /c … >> log 2>&1` 合并两条流，并保持与原 `openSync(log, "a")` 一致的**追加**语义。
 * `MACHINE_CONFIG` 在壳内设置：Start-Process 的子进程继承壳进程环境（WinPS 5.1 无 `-Environment`）。
 */
function buildDetachShellScript(config) {
  const inner = `/c ""${process.execPath}" "${LAUNCHER_ENTRY}" >> "${LOG_PATH}" 2>&1"`;
  return [
    "$shell = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }",
    `$env:MACHINE_CONFIG = ${psQuote(config.path)}`,
    `Start-Process -FilePath $shell -ArgumentList ${psQuote(inner)} -WorkingDirectory ${psQuote(MACHINE_ROOT)} -WindowStyle Hidden`,
  ].join("\n");
}

/**
 * Windows 脱壳拉起：WMI `Win32_Process.Create` 建**隐藏的 powershell 壳**（挂 WmiPrvSE，不在调用方树内），
 * 壳内 `Start-Process -WindowStyle Hidden` 拉起 Launcher。同步等**壳进程**退出（毫秒级），常驻进程已脱壳。
 * 返回 `{ kind: "detached" }` 或 `{ kind: "failed", reason }`（后者由调用方显式降级，不得静默）。
 */
function launchDetachedWindows(config) {
  const shellCmd = `powershell -NoProfile -WindowStyle Hidden -EncodedCommand ${encodePowerShell(
    buildDetachShellScript(config),
  )}`;
  const outerScript =
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(shellCmd)} }; ` +
    "if ($null -eq $r) { exit 2 }; exit [int]$r.ReturnValue";
  let result;
  try {
    result = spawnSync("powershell", ["-NoProfile", "-Command", outerScript], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
  } catch (err) {
    return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  if (result.error !== undefined) return { kind: "failed", reason: result.error.message };
  if (result.status !== 0) {
    const lines = String(result.stderr ?? "")
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "");
    const detail = lines.length > 0 ? `：${lines[lines.length - 1]}` : "";
    return { kind: "failed", reason: `WMI Create 退出码 ${result.status}${detail}` };
  }
  return { kind: "detached" };
}

/**
 * 现有实现：`spawn(detached: true)` + `unref()`（POSIX 天然脱离；Windows 兜底，**可能拖住调用方**）。
 * 返回 `{ kind: "spawn", child }` 或 `{ kind: "spawn-failed", reason }`。
 */
function spawnLauncherDetached(config) {
  const logFd = openSync(LOG_PATH, "a");
  let child;
  try {
    child = spawn(process.execPath, [LAUNCHER_ENTRY], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      cwd: MACHINE_ROOT,
      env: { ...process.env, MACHINE_CONFIG: config.path },
    });
  } catch (err) {
    closeSync(logFd);
    return { kind: "spawn-failed", reason: err instanceof Error ? err.message : String(err) };
  }
  closeSync(logFd);
  if (child.pid === undefined) {
    return { kind: "spawn-failed", reason: "子进程未获得 pid（spawn 同步失败）" };
  }
  child.once("error", (err) => {
    console.error(
      `[launcherctl] 子进程启动失败：${err instanceof Error ? err.message : String(err)}`,
    );
  });
  child.unref();
  return { kind: "spawn", child };
}

/**
 * 拉起初次实例（入口判定为 `free` 后调用）：
 *   - Windows：先试 WMI 脱壳；不可用则**显式**降级 `spawn(detached)` 并在 stdout 警告。
 *   - 其它平台：`spawn(detached:true)` + `unref()`。
 */
function launchLauncher(config) {
  if (process.platform !== "win32") return spawnLauncherDetached(config);

  const detached = launchDetachedWindows(config);
  if (detached.kind === "detached") return { kind: "detached" };

  warn(
    `Windows 脱壳拉起不可用（${detached.reason}）⇒ 降级为 spawn(detached)；**调用方（宿主工具）可能被拖住**（常驻 Launcher 仍在其作业 / 进程树内）。`,
  );
  return spawnLauncherDetached(config);
}

/**
 * 归属判定统一入口：
 *   - spawn 路径（有本地子进程句柄）⇒ `resolveOwnership`（pidfile × child.pid 交叉校验）。
 *   - 脱壳路径（无子进程句柄）⇒ 以 pidfile 为准：存在即「运行中的本服务」，缺失判「不确定」
 *     （脱壳后 Launcher 挂 WmiPrvSE，脚本无句柄可交叉校验；并发竞态退化为「服务可用」语义）。
 */
async function resolveLaunchedOwnership(child) {
  if (child !== undefined) return resolveOwnership(child);
  const pidfile = readPidfile();
  if (pidfile === null) return { kind: "uncertain", pid: undefined };
  return { kind: "winner", pid: pidfile.pid };
}

/** `--wait-ready` 整段硬上限：显式 `--ready-timeout` 优先；缺省 max(60_000, N × startupCheckTimeoutMs + 60_000) */
function resolveReadyTimeoutMs(config, flags) {
  if (flags.readyTimeout !== undefined) return flags.readyTimeout;
  return Math.max(
    READY_WAIT_FLOOR_MS,
    config.projectCount * config.startupCheckTimeoutMs + READY_WAIT_MARGIN_MS,
  );
}

/**
 * 后台启动（幂等）。不退出，返回结构化结果供调用方输出 / 决定退出码。
 * 结果 `kind` ∈ { occupied, already-ready, already-starting, started, no-wait, ready,
 *                 ready-timeout, start-timeout, spawn-failed, race-loser, race-uncertain }；
 * 所有结果均带 `occupied` 布尔（真占用时 true）。
 */
async function doStart(config, flags) {
  const entry = await classifyOccupancy(config);
  const base = { occupied: entry.kind === "occupied", host: entry.host, port: entry.port };

  if (entry.kind === "occupied") {
    return { ...base, kind: "occupied", reason: entry.reason, spawned: false, already: false, health: null, pid: undefined };
  }

  if (entry.kind === "ready") {
    return {
      ...base,
      kind: "already-ready",
      spawned: false,
      already: true,
      health: entry.health,
      pid: entry.pidfile?.pid,
    };
  }

  if (entry.kind === "starting") {
    if (flags.waitReady) {
      const readyTimeoutMs = resolveReadyTimeoutMs(config, flags);
      const waited = await waitForHealth(entry.host, entry.port, readyTimeoutMs, healthReady);
      if (waited.matched !== null) {
        return {
          ...base,
          kind: "ready",
          spawned: false,
          already: true,
          health: waited.matched,
          pid: entry.pidfile?.pid,
          readyTimeoutMs,
        };
      }
      return {
        ...base,
        kind: "ready-timeout",
        spawned: false,
        already: true,
        health: waited.last,
        pid: entry.pidfile?.pid,
        readyTimeoutMs,
      };
    }
    return {
      ...base,
      kind: "already-starting",
      spawned: false,
      already: true,
      health: entry.health,
      pid: entry.pidfile?.pid,
    };
  }

  // entry.kind === "free"：拉起本实例
  ensureBuilt();
  mkdirSync(LOG_DIR, { recursive: true });

  // 拉起方式：Windows 走 WMI 脱壳（脱离调用方作业 / 进程树），其余走 spawn(detached) + unref
  const launched = launchLauncher(config);

  if (launched.kind === "spawn-failed") {
    return {
      ...base,
      kind: "spawn-failed",
      reason: launched.reason,
      spawned: false,
      already: false,
      health: null,
      pid: undefined,
    };
  }

  // 脱壳路径无本地子进程句柄 ⇒ child 为 undefined；pid 取 pidfile（脱壳后此刻可能尚未写入）
  const child = launched.kind === "spawn" ? launched.child : undefined;
  const launchPid = child !== undefined ? child.pid : readPidfile()?.pid;

  // C1/C8：发起即返（exit 0 = 已发起，≠ 就绪）；pid 仅供参考（可能被另一实例接管而退出）
  if (flags.noWait) {
    return { ...base, kind: "no-wait", spawned: true, already: false, health: null, pid: launchPid };
  }

  // C3：等待业务就绪（status=ok）；exit 0 仅在 ok，超时/失败归调用方 exit 1
  if (flags.waitReady) {
    const readyTimeoutMs = resolveReadyTimeoutMs(config, flags);
    const waited = await waitForHealth(entry.host, entry.port, readyTimeoutMs, healthReady);
    if (waited.matched !== null) {
      const ownership = await resolveLaunchedOwnership(child);
      return {
        ...base,
        kind: "ready",
        spawned: true,
        already: false,
        health: waited.matched,
        pid: ownership.kind === "winner" ? ownership.pid : launchPid,
        ownership: ownership.kind,
        readyTimeoutMs,
      };
    }
    return {
      ...base,
      kind: "ready-timeout",
      spawned: true,
      already: false,
      health: waited.last,
      pid: launchPid,
      readyTimeoutMs,
    };
  }

  // C2：缺省等待 L1（/health 可答 = HTTP 200）；返回后由调用方显式标注 starting / ok 且 0 ≠ 业务就绪
  const waited = await waitForHealth(entry.host, entry.port, READY_TIMEOUT_MS, healthAnswerable);
  if (waited.matched === null) {
    return { ...base, kind: "start-timeout", spawned: true, already: false, health: null, pid: launchPid };
  }

  // 竞态归属交叉校验：本次 spawn 可能输给并发实例（EADDRINUSE），须避免把死 pid 当成本实例
  const ownership = await resolveLaunchedOwnership(child);
  if (ownership.kind === "loser") {
    return { ...base, kind: "race-loser", spawned: true, already: false, health: waited.matched, pid: ownership.pid };
  }
  if (ownership.kind === "uncertain") {
    return { ...base, kind: "race-uncertain", spawned: true, already: false, health: waited.matched, pid: launchPid };
  }
  return { ...base, kind: "started", spawned: true, already: false, health: waited.matched, pid: ownership.pid };
}

/** 可选 HTTP 优雅停止（POST /shutdown）；成功返回 true，非 200 / 连接失败返回 false */
async function tryShutdownEndpoint(config, host, port) {
  const headers = {};
  if (config.shutdownToken !== undefined)
    headers["authorization"] = `Bearer ${config.shutdownToken}`;
  try {
    const res = await fetch(`${baseUrl(host, port)}/shutdown`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 200) {
      info("已发送 POST /shutdown（三端优雅停止）");
      return true;
    }
    info(`/shutdown 返回 HTTP ${res.status}，回落默认发信号停止`);
    return false;
  } catch (err) {
    info(
      `/shutdown 请求失败（${err instanceof Error ? err.message : String(err)}），回落默认发信号停止`,
    );
    return false;
  }
}

/** 停止（默认路径 pidfile + 发信号；可选 HTTP 优雅停止）。不退出，返回 { ok, message }。 */
async function doStop(config) {
  const pidfile = readPidfile();
  const host = resolveProbeHost(config, pidfile);
  const port = pidfile?.port ?? config.port;
  const listening = await probePort(port, host);

  // 可选路径：仅当启用端点且端口在监听时尝试
  if (listening && config.shutdownEndpoint) {
    const endpointOk = await tryShutdownEndpoint(config, host, port);
    if (endpointOk) {
      const released = await waitPortRelease(port, host, STOP_TIMEOUT_MS);
      if (released) {
        removePidfileIfPresent();
        return { ok: true, message: `已停止（端口 ${port} 已释放，POST /shutdown）` };
      }
      return { ok: false, message: `停止超时：端口 ${port} 仍被占用` };
    }
  }

  if (!listening) {
    if (pidfile !== null && !isPidAlive(pidfile.pid)) {
      removePidfileIfPresent();
      return { ok: true, message: `未运行（端口 ${port} 未监听）；已清理陈旧 pidfile` };
    }
    return { ok: true, message: `未运行（端口 ${port} 未监听）` };
  }

  if (pidfile === null) {
    return {
      ok: false,
      message: `端口 ${port} 被占用，但 pidfile 缺失（${PIDFILE_PATH}），无法定位进程，未执行停止`,
    };
  }
  if (!isPidAlive(pidfile.pid)) {
    return {
      ok: false,
      message: `pidfile 陈旧（pid=${pidfile.pid} 已不存在），端口 ${port} 仍被占用，无法定位进程，未执行停止`,
    };
  }

  const pid = pidfile.pid;
  if (process.platform === "win32") {
    info(`强制停止（Windows taskkill /PID ${pid} /T /F）…`);
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } else {
    info(`发送 SIGTERM（优雅停止）pid=${pid} …`);
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      if (err?.code !== "ESRCH") {
        return {
          ok: false,
          message: `发送 SIGTERM 失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  const released = await waitPortRelease(port, host, STOP_TIMEOUT_MS);
  if (released) {
    removePidfileIfPresent();
    return { ok: true, message: `已停止（端口 ${port} 已释放）` };
  }
  return { ok: false, message: `停止超时：端口 ${port} 仍被占用（pid=${pid}）` };
}

/** 取文本尾部 count 行（忽略结尾空行） */
function lastLines(text, count) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function printLogTail(count) {
  if (!existsSync(LOG_PATH)) {
    console.error(`[launcherctl] 日志不存在：${LOG_PATH}`);
    return;
  }
  const content = readFileSync(LOG_PATH, "utf8");
  console.error(`[launcherctl] 日志尾部 ${count} 行（${LOG_PATH}）：`);
  console.error(lastLines(content, count));
}

/**
 * 按模式输出**过滤行**（非 tail N）：用于 `--wait-ready` 失败诊断，只打印自检相关行，
 * 避免关键失败被淹没在大段日志尾部。无命中时明示「未匹配」。
 */
function printFilteredLog(patterns) {
  if (!existsSync(LOG_PATH)) {
    console.error(`[launcherctl] 日志不存在：${LOG_PATH}`);
    return;
  }
  const content = readFileSync(LOG_PATH, "utf8");
  const lines = content.split(/\r?\n/).filter((line) => patterns.some((p) => line.includes(p)));
  if (lines.length === 0) {
    console.error(
      `[launcherctl] 日志中未匹配到 ${patterns.join(" / ")} 行（${LOG_PATH}）`,
    );
    return;
  }
  console.error(`[launcherctl] 自检相关日志行（过滤 ${patterns.join(" / ")}，${LOG_PATH}）：`);
  console.error(lines.join("\n"));
}

/** tail -f 等价：轮询文件增长并输出新增字节（处理截断） */
async function followLog() {
  let size = statSync(LOG_PATH).size;
  for (;;) {
    await delay(FOLLOW_INTERVAL_MS);
    let stat;
    try {
      stat = statSync(LOG_PATH);
    } catch {
      continue;
    }
    if (stat.size < size) size = 0; // 文件被截断 / 轮转
    if (stat.size === size) continue;
    const fd = openSync(LOG_PATH, "r");
    try {
      const buffer = Buffer.alloc(stat.size - size);
      readSync(fd, buffer, 0, buffer.length, size);
      process.stdout.write(buffer);
    } finally {
      closeSync(fd);
    }
    size = stat.size;
  }
}

function parsePositiveInt(value, name) {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) <= 0) {
    fail(`${name} 需要一个正整数`);
  }
  return Number(value);
}

function parseArgs(argv) {
  const flags = {
    lines: undefined,
    follow: false,
    help: false,
    noWait: false,
    waitReady: false,
    readyTimeout: undefined,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--follow" || arg === "-f") {
      flags.follow = true;
    } else if (arg === "--lines" || arg === "-n") {
      i += 1;
      flags.lines = parsePositiveInt(argv[i], "--lines");
    } else if (arg.startsWith("--lines=")) {
      flags.lines = parsePositiveInt(arg.slice("--lines=".length), "--lines");
    } else if (arg === "--no-wait") {
      flags.noWait = true;
    } else if (arg === "--wait-ready") {
      flags.waitReady = true;
    } else if (arg === "--ready-timeout") {
      i += 1;
      flags.readyTimeout = parsePositiveInt(argv[i], "--ready-timeout");
    } else if (arg.startsWith("--ready-timeout=")) {
      flags.readyTimeout = parsePositiveInt(arg.slice("--ready-timeout=".length), "--ready-timeout");
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg.startsWith("-")) {
      fail(`未知选项：${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  // C3：--no-wait（发起即返）与 --wait-ready（等待业务就绪）语义互斥 ⇒ 显式报错
  if (flags.noWait && flags.waitReady) {
    fail("--no-wait 与 --wait-ready 不能同时使用（前者发起即返，后者等待业务就绪）");
  }
  // --ready-timeout 仅承载 --wait-ready 的整段硬上限，脱离 --wait-ready 无意义 ⇒ 显式报错
  if (flags.readyTimeout !== undefined && !flags.waitReady) {
    fail("--ready-timeout 仅在 --wait-ready 下有效");
  }

  return { command: positionals[0], flags };
}

function printUsage() {
  console.log(`launcherctl — Launcher 跨平台启停脚本（machine 单元）

用法：
  node scripts/launcherctl.mjs <command> [options]

命令：
  start     后台启动 Launcher（已在运行则提示并退出 0）
  stop      停止 Launcher（POSIX 发 SIGTERM；Windows taskkill /T /F 强制树杀）
  restart   停止后重新后台拉起（stop 段阻塞，非瞬时）
  status    查看运行态（pid / host:port / health / startedAt）
  logs      输出日志文件（--lines N 取尾部；--follow 跟踪）

选项（start / restart）：
  --no-wait              发起即返；exit 0 = 已发起（≠ 就绪）；spawn 同步失败才 exit 1
                         pid 仅供参考，须另起 status 确认；与 --wait-ready 互斥
  --wait-ready           等待业务就绪（/health status=ok）后才 exit 0；超时/失败 exit 1
  --ready-timeout <ms>   --wait-ready 的整段硬上限
                         （缺省 max(60000, N × startupCheckTimeoutMs + 60000)，N = projects 数）

选项（logs）：
  -n, --lines <N>   仅输出尾部 N 行
  -f, --follow      持续跟踪新增日志（默认关闭）
  -h, --help        显示帮助

就绪语义：
  缺省 start 只等 L1（/health 可答 = HTTP 200）即返回 0 —— **缺省 exit 0 ≠ 业务就绪**
  （health.status=starting 时业务路由仍 503）；需业务就绪请加 --wait-ready。

调用拼写（重要，C7）：
  npm 会吞掉裸 --no-* 选项，透传给脚本必须加 -- 分隔：
    npm run start -- --no-wait
    npm run restart -- --wait-ready --ready-timeout 420000

配置：
  MACHINE_CONFIG  机器配置文件路径（缺省 ${join(MACHINE_ROOT, "config", "config.json")}）
  pidfile         ${PIDFILE_PATH}
  log             ${LOG_PATH}`);
}

async function cmdStart(flags) {
  const config = loadConfig();
  const result = await doStart(config, flags);
  const endpoint = `${formatHost(result.host)}:${result.port}`;

  switch (result.kind) {
    case "occupied": {
      console.error(`[launcherctl] 端口 ${endpoint} 被真占用（非本服务）：${result.reason}`);
      console.error(
        "[launcherctl] 未执行启动。如确需强制接管，请先 `npm run stop` 或手动清理占用进程。",
      );
      process.exit(1);
      break;
    }
    case "already-ready": {
      info(`已在运行：${endpoint}（health=ok，自检已通过）；exit 0`);
      break;
    }
    case "already-starting": {
      info(`已在运行：${endpoint}（health=starting，自检进行中）；exit 0`);
      info(
        "注意：缺省 exit 0 ≠ 业务就绪（starting 时 /health 可答为 200，但业务路由仍 503）；如需等待自检通过请用 --wait-ready。",
      );
      break;
    }
    case "started": {
      const status = result.health?.status ?? "ok";
      info(`已后台启动 pid=${result.pid}，health=${status}，日志：${LOG_PATH}`);
      info(
        `缺省等待 L1（/health 可答 = HTTP 200）后返回；**exit 0 ≠ 业务就绪**（当前 status=${status}，starting=自检进行中 / ok=自检已通过）；如需业务就绪请用 --wait-ready。`,
      );
      break;
    }
    case "ready": {
      const via =
        result.ownership === "loser"
          ? `（另一实例已接管 pid=${result.pid}）`
          : result.spawned
            ? `（本次发起 pid=${result.pid}）`
            : "";
      info(`已就绪：${endpoint}（health=ok）${via}；exit 0`);
      break;
    }
    case "no-wait": {
      const pidLabel = result.pid === undefined ? "（脱壳拉起，暂不可知）" : String(result.pid);
      info(`已发起启动 pid=${pidLabel}（--no-wait：发起即返；exit 0 = 已发起，≠ 就绪）`);
      info(
        "pid 仅供参考：子进程可能因另一实例接管（EADDRINUSE）而退出；请另起 `npm run status` 确认运行态。",
      );
      info(
        "调用拼写：`npm run <script> -- --no-wait`（npm 会吞掉裸 --no-* 选项，必须加 `--` 分隔）。",
      );
      break;
    }
    case "race-loser": {
      info(`另一实例已接管 pid=${result.pid}（本实例子进程已退出）；服务可用，exit 0。`);
      break;
    }
    case "race-uncertain": {
      info(
        `服务已可答：${endpoint}（health=${healthStatusLabel(result.health)}），但 pidfile 缺失/无法归属，归属不确定。`,
      );
      info(`本次 pid=${result.pid} 仅供参考；请另起 \`npm run status\` 确认运行态。`);
      break;
    }
    case "ready-timeout": {
      console.error(
        `[launcherctl] --wait-ready 超时（${result.readyTimeoutMs}ms）：/health 未达 status=ok（last=${healthStatusLabel(result.health)}）；判为「启动未就绪」。`,
      );
      printFilteredLog(["自检失败", "[self-check]"]);
      process.exit(1);
      break;
    }
    case "start-timeout": {
      console.error(
        `[launcherctl] 启动超时（${READY_TIMEOUT_MS}ms）：${endpoint} /health 不可达（pid=${result.pid}）；判为「启动失败」（非被占用）。`,
      );
      printLogTail(30);
      process.exit(1);
      break;
    }
    case "spawn-failed": {
      console.error(`[launcherctl] 子进程同步启动失败：${result.reason}`);
      process.exit(1);
      break;
    }
    default: {
      console.error(`[launcherctl] 未知启动结果：${String(result.kind)}`);
      process.exit(1);
    }
  }
  process.exit(0);
}

async function cmdStop() {
  const config = loadConfig();
  const result = await doStop(config);
  if (result.ok) {
    info(result.message);
    process.exit(0);
  }
  console.error(`[launcherctl] ${result.message}`);
  console.error(`[launcherctl] 可手动排查：pidfile=${PIDFILE_PATH}`);
  process.exit(1);
}

async function cmdRestart(flags) {
  const config = loadConfig();
  const stopHint =
    "restart 先执行 stop（阻塞，**非瞬时**：POST /shutdown ≤5s + 等待端口释放 ≤15s，machine ≈ ≤20s）…";
  if (flags.noWait) {
    info(
      `restart --no-wait：**仅 start 段为发起即返**，整体重启仍非瞬时 —— ${stopHint}`,
    );
  } else {
    info(stopHint);
  }
  const result = await doStop(config);
  if (!result.ok) {
    console.error(`[launcherctl] restart 中止（停止失败）：${result.message}`);
    process.exit(1);
  }
  info(result.message);
  await cmdStart(flags);
}

async function cmdStatus() {
  const config = loadConfig();
  const pidfile = readPidfile();
  const host = resolveProbeHost(config, pidfile);
  const port = pidfile?.port ?? config.port;
  const listening = await probePort(port, host);
  const health = listening ? await httpHealth(host, port) : null;
  const pidAlive = pidfile !== null && isPidAlive(pidfile.pid);

  let state;
  if (listening) state = "运行中";
  else if (pidfile !== null) state = "pidfile 陈旧（有文件但端口未监听）";
  else state = "未运行";

  info(`状态：${state}`);
  info(
    `pid      : ${
      pidfile !== null
        ? `${pidfile.pid}${pidAlive ? "" : "（已不存在）"}`
        : listening
          ? "未知（pidfile 缺失）"
          : "-"
    }`,
  );
  info(`endpoint : ${formatHost(host)}:${port}`);
  info(
    `health   : ${
      health !== null
        ? `${health.status ?? "ok"}${health.protocolVersion !== undefined ? ` protocol=${health.protocolVersion}` : ""}`
        : "不可达"
    }`,
  );
  info(`startedAt: ${pidfile?.startedAt ?? "-"}`);
  info(`pidfile  : ${PIDFILE_PATH}${existsSync(PIDFILE_PATH) ? "" : "（不存在）"}`);
  info(`log      : ${LOG_PATH}`);

  process.exit(listening ? 0 : 1);
}

async function cmdLogs(flags) {
  if (!existsSync(LOG_PATH)) {
    console.error(`[launcherctl] 日志不存在：${LOG_PATH}`);
    process.exit(1);
  }
  const content = readFileSync(LOG_PATH, "utf8");
  const output = flags.lines === undefined ? content : lastLines(content, flags.lines);
  process.stdout.write(output.endsWith("\n") || output.length === 0 ? output : `${output}\n`);
  if (flags.follow) await followLog();
  process.exit(0);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || command === "help" || command === undefined || command === "--help") {
    printUsage();
    process.exit(command === undefined ? 1 : 0);
  }
  const startOnlyFlagUsed = flags.noWait || flags.waitReady || flags.readyTimeout !== undefined;
  if (startOnlyFlagUsed && command !== "start" && command !== "restart") {
    fail(
      `--no-wait / --wait-ready / --ready-timeout 仅适用于 start / restart（当前命令：${command}）`,
    );
  }
  switch (command) {
    case "start":
      await cmdStart(flags);
      break;
    case "stop":
      await cmdStop();
      break;
    case "restart":
      await cmdRestart(flags);
      break;
    case "status":
      await cmdStatus();
      break;
    case "logs":
      await cmdLogs(flags);
      break;
    default:
      fail(`未知子命令：${command}（运行 node scripts/launcherctl.mjs --help 查看用法）`);
  }
}

await main();
