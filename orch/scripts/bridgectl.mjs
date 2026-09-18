#!/usr/bin/env node
/**
 * 桥（orch MCP bridge）跨平台启停脚本（REQ-v0.4.1-2026-09-15-02，§2.5；参照
 * `machine/scripts/launcherctl.mjs` 语义）。
 *
 * 纯 Node ESM，零第三方依赖、无需构建：
 *   node scripts/bridgectl.mjs start|stop|restart|status|logs [options]
 *
 * 关键约定（与改造文档 §2.5 / §4.1 第 2 条对齐）：
 *   - 入口   orch/dist/bridge/index.js（缺失时**只提示** `npm run build`，不自动构建）
 *   - pidfile orch/data/bridge.pid（**由桥自己写**，JSON `{ pid, mode, role, startedAt }`）
 *   - 日志   orch/data/logs/bridge.log（本脚本重定向 stdout/stderr）
 *   - 配置   透传 `MACHINES_CONFIG`（缺省 orch/config/config.json），host/port 读 `transport.http`
 *
 * 单实例互斥由桥内部承担（端口绑定即互斥 + core 租约），本脚本**不实现任何锁**：
 * start 只做「先探测再起」的快速判定；stop 优先 `POST /shutdown`（仅 loopback）优雅停机、
 * 超时兜底强杀；status/logs 依赖 pidfile + 端口探测，**pidfile 缺失/陈旧只探测提示、不误杀**。
 *
 * Windows 脱壳拉起（REQ-v0.6.2-2026-09-18-02 增补#2 节点 E-N1；与 machine 侧**同契约、异实现**）：
 *   常驻桥经 WMI `Win32_Process.Create` 脱壳（挂 WmiPrvSE，**不在**调用方作业 / 进程树内），
 *   由隐藏窗口的壳进程 `Start-Process` 拉起 —— 否则调用方（宿主工具）「等自己的作业 / 进程树清空」而卡住。
 *   脱壳不可用（无 WMI / 权限不足 / 判定失败）⇒ **显式**降级 `spawn(detached)` 并在 stdout 警告（不静默）。
 *   POSIX 保持 `spawn(detached:true)` + `unref()`（setsid 天然脱离）。
 *   注：`Start-Process` **不允许** stdout / stderr 指向同一文件（InvalidOperationException），故壳内经
 *   `cmd /c "… >> log 2>&1"` 合并两条流（保持与原 `openSync(log,"a")` 一致的追加语义）；脱壳后脚本
 *   **无子进程句柄** ⇒ pid 归属校验退化为「以 pidfile 为准；缺失判『不确定』」（并发竞态与 machine 侧同口径）。
 *
 * 运行判定（**不以「端口可连」为准**，键 = `/health` 的 `status`）：`GET /health` 返回
 * **HTTP 200 且 `status:"ok"`**（并读出 `role`）才算「桥在运行」；`status:"starting"`
 * （HTTP 503）表示**本服务启动中**。start 入口探测按 `status` 三分类：
 *   - `/health` 不可达 / 不可解析 ⇒ **真占用**（exit 1，不写 pidfile、不 spawn）
 *   - `status:"ok"` ⇒ 已在运行 / 已就绪（exit 0）
 *   - `status:"starting"` ⇒ 本服务启动中 ⇒ **缺省与 `--no-wait` 均即返 0**
 *   - `status` 缺失 / 非白名单（`ok|starting` 之外）⇒ 占用（exit 1）
 *
 * 等待语义（C1/C2）：`start` **缺省**等待服务可答（`/health` 200 且 `status:"ok"`）后返回
 * （≤ `READY_TIMEOUT_MS`）；`--no-wait` 发起即返（exit 0 = 已发起，**≠ 就绪**；仅 spawn
 * 同步失败才 exit 1）。**缺省 0 ≠ 业务就绪**。`restart --no-wait` **仅 start 段**生效，
 * stop 段仍阻塞（最长约 35s = shutdown 5s + 强杀等待 15s×2），**非瞬时返回**。
 * 退出码恒 `{0,1}`（C5）。
 *
 * status 退出码约定（与 `cmdStatus` 实现一致）：桥在运行 → 0；未运行 → 0；
 * 探测/配置异常（端口被非本桥占用、`/health` 不健康、配置不可读）→ 非零。
 *
 * 环境变量（与桥进程一致）：
 *   MACHINES_CONFIG  配置路径（缺省 `<orch>/config/config.json`）
 *   SESSION_DB       会话库路径（缺省 `<orch>/data/sessions.sqlite`）——其目录即桥的 data dir，
 *                    `bridge.pid` / `logs/bridge.log` / `core.lock` 均落在此（便于隔离实测）
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

/** start 等待 `/health` 就绪的超时（含启动自检 / `recover()`，故留足余量） */
const READY_TIMEOUT_MS = 30_000;
/** stop 等待端口释放的超时（优雅停机 / 强杀共用） */
const STOP_TIMEOUT_MS = 15_000;
/** `POST /shutdown` 单次请求超时 */
const SHUTDOWN_TIMEOUT_MS = 5_000;
/** 单次 TCP 探测超时 / 轮询间隔 */
const PROBE_TIMEOUT_MS = 1_000;
const PROBE_INTERVAL_MS = 200;
/** logs --follow 轮询间隔 */
const FOLLOW_INTERVAL_MS = 300;
/** 配置缺省（与 `orch/config.ts` 的缺省一致） */
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 8787;
const DEFAULT_HTTP_PATH = "/mcp";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = findBridgeRoot(SCRIPT_DIR);
const BRIDGE_ENTRY = join(BRIDGE_ROOT, "dist", "bridge", "index.js");
const CONFIG_PATH = process.env["MACHINES_CONFIG"] ?? join(BRIDGE_ROOT, "config", "config.json");
/** 桥的 data dir：跟随 `SESSION_DB` 所在目录（与 `bridge/index.ts` 的 `DATA_DIR` 同源） */
const DATA_DIR =
  process.env["SESSION_DB"] === undefined
    ? join(BRIDGE_ROOT, "data")
    : dirname(resolve(process.env["SESSION_DB"]));
const PIDFILE_PATH = join(DATA_DIR, "bridge.pid");
const LOG_DIR = join(DATA_DIR, "logs");
const LOG_PATH = join(LOG_DIR, "bridge.log");

function fail(message) {
  console.error(`[bridgectl] ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[bridgectl] ${message}`);
}

/** 降级告警（stdout，必须可见）：如脱壳不可用时提示「调用方可能被拖住」 */
function warn(message) {
  console.log(`[bridgectl] 警告：${message}`);
}

function delay(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/** 自脚本目录向上查找含 package.json 的目录（orch 单元根） */
function findBridgeRoot(startDir) {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

/** 读取配置里脚本关心的字段（transport 模式 / host / port / path；`transport` 缺失 = 常驻 http 缺省） */
function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    fail(`无法读取配置 ${CONFIG_PATH}：${err instanceof Error ? err.message : String(err)}`);
  }
  const transport = raw?.transport;
  // stdio 已退役：仅显式 "stdio" 才判 stdio（随后 cmdStart fail-fast），其余（含缺省）= http
  const mode = transport?.mode === "stdio" ? "stdio" : "http";
  const http = transport?.http;
  const host =
    typeof http?.host === "string" && http.host.length > 0 ? http.host : DEFAULT_HTTP_HOST;
  const port =
    typeof http?.port === "number" && Number.isInteger(http.port) ? http.port : DEFAULT_HTTP_PORT;
  const mcpPath =
    typeof http?.path === "string" && http.path.startsWith("/") ? http.path : DEFAULT_HTTP_PATH;
  return { path: CONFIG_PATH, mode, host, port, mcpPath };
}

/** 读取 pidfile（由桥写）；缺失或形状不合法返回 null */
function readPidfile() {
  try {
    const raw = JSON.parse(readFileSync(PIDFILE_PATH, "utf8"));
    if (raw === null || typeof raw !== "object" || typeof raw.pid !== "number") return null;
    return {
      pid: raw.pid,
      mode: typeof raw.mode === "string" ? raw.mode : undefined,
      role: typeof raw.role === "string" ? raw.role : undefined,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
    };
  } catch {
    return null;
  }
}

/** 探测目标地址：配置 host，通配地址（0.0.0.0 / ::）归一为 127.0.0.1 */
function resolveProbeHost(config) {
  const candidate = config.host;
  if (candidate === "0.0.0.0" || candidate === "::") return "127.0.0.1";
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

/** GET /health；网络错误 / 非 JSON 返回 null（其余情况带回 httpStatus + body 字段） */
async function httpHealth(host, port, timeoutMs = 2_000) {
  try {
    const res = await fetch(`${baseUrl(host, port)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    if (body === null || typeof body !== "object") return null;
    return {
      httpStatus: res.status,
      status: typeof body.status === "string" ? body.status : undefined,
      role: typeof body.role === "string" ? body.role : undefined,
      version: typeof body.version === "string" ? body.version : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 轮询 `/health` 至就绪；就绪判定**收紧**为 `HTTP 200 && status === "ok"`（与入口探测
 * `doStart` 一致，防御 200 + 非 ok 的中间态）。循环内 `null`（不可达）与 `starting`
 * 一律**继续轮询至超时**（行为不变）；超时返回 `{ health: null, sawStarting }`。
 * `onStatus` 仅在观测到的 `status` 变化时回调（供上层明示 `starting`）。
 */
async function waitForReady(host, port, timeoutMs, onStatus) {
  const deadline = Date.now() + timeoutMs;
  let reported;
  let sawStarting = false;
  for (;;) {
    const health = await httpHealth(host, port);
    if (health !== null && health.httpStatus === 200 && health.status === "ok") {
      return { health, sawStarting };
    }
    const status = health?.status;
    if (status !== undefined && status !== reported) {
      reported = status;
      if (status === "starting") sawStarting = true;
      onStatus?.(health);
    }
    if (Date.now() >= deadline) return { health: null, sawStarting };
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
      `[bridgectl] 删除 pidfile 失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** start 前确保已构建（缺失只提示，不自动构建） */
function ensureBuilt() {
  if (existsSync(BRIDGE_ENTRY)) return;
  fail(`未找到 ${BRIDGE_ENTRY}：请先在 ${BRIDGE_ROOT} 运行 npm run build`);
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
 * 脱壳壳脚本（Windows）：隐藏窗口拉起常驻桥，stdout / stderr **追加合并**落 bridge.log。
 * 说明：`Start-Process` 不允许 stdout / stderr 指向同一文件（InvalidOperationException），
 * 故经 `cmd /c … >> log 2>&1` 合并两条流，并保持与原 `openSync(log, "a")` 一致的**追加**语义。
 * `MACHINES_CONFIG` / `SESSION_DB` 在壳内设置：Start-Process 的子进程继承壳进程环境
 * （WmiPrvSE 的环境不含调用方变量，故这两个决定落盘的变量必须显式带入）。
 */
function buildDetachShellScript(config) {
  const inner = `/c ""${process.execPath}" "${BRIDGE_ENTRY}" >> "${LOG_PATH}" 2>&1"`;
  const lines = [
    "$shell = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }",
    `$env:MACHINES_CONFIG = ${psQuote(config.path)}`,
  ];
  if (process.env["SESSION_DB"] !== undefined) {
    lines.push(`$env:SESSION_DB = ${psQuote(process.env["SESSION_DB"])}`);
  }
  lines.push(
    `Start-Process -FilePath $shell -ArgumentList ${psQuote(inner)} -WorkingDirectory ${psQuote(
      BRIDGE_ROOT,
    )} -WindowStyle Hidden`,
  );
  return lines.join("\n");
}

/**
 * Windows 脱壳拉起：WMI `Win32_Process.Create` 建**隐藏的 powershell 壳**（挂 WmiPrvSE，不在调用方树内），
 * 壳内 `Start-Process -WindowStyle Hidden` 拉起常驻桥。同步等**壳进程**退出（毫秒级），常驻桥已脱壳。
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
 * 兜底拉起：`spawn(detached: true)` + `unref()`（POSIX 天然脱离；Windows 兜底，**可能拖住调用方**）。
 * stdio 显式绑定到日志 fd：子进程**不继承**调用方的 stdout/stderr，调用方可正常拿到 EOF
 * （否则管道被桥长期持有、调用方读不到 EOF 而挂住）。fd 已被 spawn 复制，随后即可 close。
 * 返回 `{ kind: "spawn", child }` 或 `{ kind: "spawn-failed", error }`。
 */
function spawnBridgeDetached(config) {
  const logFd = openSync(LOG_PATH, "a");
  let child;
  try {
    child = spawn(process.execPath, [BRIDGE_ENTRY], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      cwd: BRIDGE_ROOT,
      env: { ...process.env, MACHINES_CONFIG: config.path },
    });
  } catch (err) {
    closeSync(logFd);
    // spawn **同步**失败（参数非法 / 资源不可用等）：按契约 exit 1，不得当作「已发起」
    return { kind: "spawn-failed", error: err };
  }
  closeSync(logFd);
  child.once("error", (err) => {
    console.error(
      `[bridgectl] 子进程启动失败：${err instanceof Error ? err.message : String(err)}`,
    );
  });
  child.unref();
  return { kind: "spawn", child };
}

/**
 * 拉起初次实例（入口判定为「端口未监听」后调用）：
 *   - Windows：先试 WMI 脱壳（脱离调用方作业 / 进程树）；不可用则**显式**降级 `spawn(detached)` 并 stdout 警告。
 *   - 其它平台：`spawn(detached:true)` + `unref()`。
 */
function launchBridge(config) {
  if (process.platform !== "win32") return spawnBridgeDetached(config);

  const detached = launchDetachedWindows(config);
  if (detached.kind === "detached") return { kind: "detached" };

  warn(
    `Windows 脱壳拉起不可用（${detached.reason}）⇒ 降级为 spawn(detached)；**调用方（宿主工具）可能被拖住**（常驻桥仍在其作业 / 进程树内）。`,
  );
  return spawnBridgeDetached(config);
}

/**
 * 后台启动（幂等，但**判定以 `/health` 为准**：仅端口可连不算「已在运行」）。
 * 入口探测（端口已监听）按 `/health` 的 `status` 三分类（键 = `status`，见文件头）：
 *   - `httpHealth === null`（可连但 /health 不可达 / 非 JSON）⇒ **真占用**（`occupied`，exit 1）
 *   - `status === "ok"` ⇒ 已就绪 / 已在运行（`already`，exit 0）
 *   - `status === "starting"` ⇒ 本服务启动中 ⇒ **缺省与 `--no-wait` 均即返 0**（`starting`）
 *   - `status` 缺失 / 非白名单 ⇒ 占用（`occupied`，exit 1）
 * 端口未监听则拉起：`--no-wait` 发起即返（`spawned`）；缺省轮询至 `200 && status === "ok"`
 * （`started`），超时 `timeout`（exit 1）。spawn **同步**抛错 ⇒ `spawn-failed`（exit 1）。
 * 不退出，返回 `{ kind, host, port, health, pid, sawStarting?, error? }` 供调用方决定输出 / 退出码。
 */
async function doStart(config, options = {}) {
  const noWait = options.noWait === true;
  const host = resolveProbeHost(config);
  const port = config.port;

  if (await probePort(port, host)) {
    const health = await httpHealth(host, port);
    if (health === null) {
      // ① 可连但 /health 不可达 / 不可解析 ⇒ 真占用（不构建、不 spawn、不写 pidfile）
      return { kind: "occupied", host, port, health: null, pid: undefined };
    }
    if (health.status === "ok") {
      // ② 已就绪 / 已在运行
      return { kind: "already", host, port, health, pid: undefined };
    }
    if (health.status === "starting") {
      // ③ 本服务启动中：入口探测遇 starting ⇒ 缺省 / --no-wait 均即返 0
      return { kind: "starting", host, port, health, pid: undefined };
    }
    // ④ status 缺失 / 非白名单 / 不可解析 ⇒ 端口被非本桥进程占用
    return { kind: "occupied", host, port, health, pid: undefined };
  }

  ensureBuilt();
  mkdirSync(LOG_DIR, { recursive: true });

  // 拉起方式：Windows 走 WMI 脱壳（脱离调用方作业 / 进程树），其余走 spawn(detached) + unref
  const launched = launchBridge(config);
  if (launched.kind === "spawn-failed") {
    // spawn **同步**失败（参数非法 / 资源不可用等）：按契约 exit 1，不得当作「已发起」
    return { kind: "spawn-failed", host, port, health: null, pid: undefined, error: launched.error };
  }

  // 脱壳路径**无本地子进程句柄**（child=undefined）⇒ pid 以 pidfile 为准；缺失即 undefined（判「不确定」）
  const child = launched.kind === "spawn" ? launched.child : undefined;
  const launchPid = child !== undefined ? child.pid : readPidfile()?.pid;

  if (noWait) {
    // 发起即返：exit 0 = 已发起 ≠ 就绪；异步 spawn error 不改变结论（C8：pid 仅供参考）
    return { kind: "spawned", host, port, health: null, pid: launchPid };
  }

  const ready = await waitForReady(host, port, READY_TIMEOUT_MS, options.onStatus);
  if (ready.health === null) {
    return {
      kind: "timeout",
      host,
      port,
      health: null,
      pid: launchPid,
      sawStarting: ready.sawStarting,
    };
  }
  return {
    kind: "started",
    host,
    port,
    health: ready.health,
    pid: launchPid,
    sawStarting: ready.sawStarting,
  };
}

/** 优雅停机端点（`POST /shutdown`，仅 loopback）；成功返回 true */
async function tryShutdownEndpoint(host, port) {
  try {
    const res = await fetch(`${baseUrl(host, port)}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(SHUTDOWN_TIMEOUT_MS),
    });
    if (res.status === 200) {
      info("已发送 POST /shutdown（优雅停机：排空在飞 → 关库 → 释放租约 → 删 pidfile）");
      return true;
    }
    info(`/shutdown 返回 HTTP ${res.status}，转入强杀兜底`);
    return false;
  } catch (err) {
    info(`/shutdown 请求失败（${err instanceof Error ? err.message : String(err)}），转入强杀兜底`);
    return false;
  }
}

/** 强杀（Windows `taskkill /PID <pid> /T /F`；POSIX 发 SIGTERM） */
function killForce(pid) {
  if (process.platform === "win32") {
    info(`强制停止（Windows taskkill /PID ${pid} /T /F）…`);
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return;
  }
  info(`发送 SIGTERM（优雅停止）pid=${pid} …`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if (err?.code !== "ESRCH") {
      console.error(
        `[bridgectl] 发送 SIGTERM 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * 停止：优先 `POST /shutdown` 优雅停机并等待退出；超时兜底强杀；清 pidfile。
 * pidfile 缺失/陈旧**只探测提示、不误杀**（pidfile 不是锁，陈旧无害）。
 * 不退出，返回 { ok, message }。
 */
async function doStop(config) {
  const pidfile = readPidfile();
  const host = resolveProbeHost(config);
  const port = config.port;
  const listening = await probePort(port, host);

  if (listening) {
    if (await tryShutdownEndpoint(host, port)) {
      if (await waitPortRelease(port, host, STOP_TIMEOUT_MS)) {
        removePidfileIfPresent();
        return { ok: true, message: `已停止（POST /shutdown 优雅停机，端口 ${port} 已释放）` };
      }
      info(`优雅停机超时（${STOP_TIMEOUT_MS}ms）端口 ${port} 仍占用，转入强杀兜底 …`);
    }

    if (pidfile === null) {
      return {
        ok: false,
        message: `端口 ${port} 被占用，但 pidfile 缺失（${PIDFILE_PATH}），无法定位进程，未执行强杀`,
      };
    }
    if (!isPidAlive(pidfile.pid)) {
      return {
        ok: false,
        message: `pidfile 陈旧（pid=${pidfile.pid} 已不存在），端口 ${port} 仍被占用，无法定位进程，未执行强杀`,
      };
    }

    const pid = pidfile.pid;
    killForce(pid);
    if (await waitPortRelease(port, host, STOP_TIMEOUT_MS)) {
      removePidfileIfPresent();
      return { ok: true, message: `已停止（强杀 pid=${pid}，端口 ${port} 已释放）` };
    }
    return { ok: false, message: `停止超时：端口 ${port} 仍被占用（pid=${pid}）` };
  }

  // 端口未监听：只探测提示，不误杀
  if (pidfile !== null && !isPidAlive(pidfile.pid)) {
    removePidfileIfPresent();
    return { ok: true, message: `未运行（端口 ${port} 未监听）；已清理陈旧 pidfile` };
  }
  if (pidfile !== null) {
    return {
      ok: true,
      message: `未运行（端口 ${port} 未监听）；pidfile 指向的 pid=${pidfile.pid} 仍存活，仅探测提示、未强杀`,
    };
  }
  return { ok: true, message: `未运行（端口 ${port} 未监听）` };
}

/** 取文本尾部 count 行（忽略结尾空行） */
function lastLines(text, count) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function printLogTail(count) {
  if (!existsSync(LOG_PATH)) {
    console.error(`[bridgectl] 日志不存在：${LOG_PATH}`);
    return;
  }
  const content = readFileSync(LOG_PATH, "utf8");
  console.error(`[bridgectl] 日志尾部 ${count} 行（${LOG_PATH}）：`);
  console.error(lastLines(content, count));
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
  const flags = { lines: undefined, follow: false, help: false, noWait: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-wait") {
      flags.noWait = true;
    } else if (arg === "--follow" || arg === "-f") {
      flags.follow = true;
    } else if (arg === "--lines" || arg === "-n") {
      i += 1;
      flags.lines = parsePositiveInt(argv[i], "--lines");
    } else if (arg.startsWith("--lines=")) {
      flags.lines = parsePositiveInt(arg.slice("--lines=".length), "--lines");
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg.startsWith("-")) {
      fail(`未知选项：${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0], flags };
}

function printUsage() {
  console.log(`bridgectl — 桥（orch MCP bridge）跨平台启停脚本（orch 单元）

用法：
  node scripts/bridgectl.mjs <command> [options]

命令：
  start     后台启动常驻桥（Windows 经 WMI 脱壳、POSIX 走 detached + stdio 指向日志 fd；缺省轮询 /health 至 ok；
            已在运行则提示并退出 0；端口被非本桥占用则 exit 1 且不写 pidfile；--no-wait 则发起即返）
  stop      停止桥（优先 POST /shutdown 优雅停机，超时兜底强杀；清 pidfile）
  restart   停止后重新后台拉起（--no-wait 仅 start 段生效：stop 段仍阻塞，非瞬时）
  status    查看运行态（pid / host:port / health / role / startedAt）；退出码：运行 0 / 未运行 0 / 探测异常非零
  logs      输出日志文件（--lines N 取尾部；--follow 跟踪）

选项（start / restart）：
  --no-wait         发起即返；exit 0 = 已发起（≠ 就绪），仅 spawn 同步失败才 exit 1。
                    缺省 = 等待服务可答（GET /health 200 且 status:"ok"）后返回。
                    缺省 0 ≠ 业务就绪（退出码 0 仅表示 /health 就绪，业务就绪需另行验证）。
                    ! npm 会吞掉裸 --no-*（C7）：必须用 -- 透传，例如
                        npm run bridge:start -- --no-wait
                        npm run bridge:restart -- --no-wait
                    ! restart 的 --no-wait 仅作用于 start 段：stop 段仍阻塞
                      （最长约 35s = shutdown 5s + 强杀等待 15s×2），该次返回非瞬时。
                    ! --no-wait 报出的 pid 仅供参考，须另起 status 确认（C8）。

选项（logs）：
  -n, --lines <N>   仅输出尾部 N 行
  -f, --follow      持续跟踪新增日志（默认关闭）
  -h, --help        显示帮助

前置：
  start 需 ${BRIDGE_ENTRY}（缺失请先 npm run build）；
  且配置 transport.mode=http（否则桥为 stdio 接入面、无常驻端口）。

配置：
  MACHINES_CONFIG  配置文件路径（缺省 ${CONFIG_PATH}），host/port 读 transport.http
  SESSION_DB       会话库路径（缺省 ${join(BRIDGE_ROOT, "data", "sessions.sqlite")}）；其目录即 data dir
  pidfile          ${PIDFILE_PATH}
  log              ${LOG_PATH}`);
}

async function cmdStart(flags) {
  const noWait = flags.noWait === true;
  const config = loadConfig();
  if (config.mode !== "http") {
    fail(
      `配置 ${config.path} 的 transport.mode=${config.mode}：stdio transport 已退役（桥会解析期 fail-fast），bridgectl 无法后台化。` +
        `请删除 "transport.mode"（缺省即 http）或将其改为 "http" 后重试。`,
    );
  }

  const result = await doStart(config, {
    noWait,
    onStatus: (health) => {
      if (health !== null && health.status === "starting") {
        info("state: starting（服务已可答，尚未就绪；继续等待至 ok …）");
      }
    },
  });

  switch (result.kind) {
    case "occupied": {
      const detail =
        result.health === null
          ? "/health 不可达 / 不可解析（非本桥 HTTP 服务）"
          : `status 非白名单（httpStatus=${result.health.httpStatus}，status=${result.health.status ?? "无"}）`;
      console.error(
        `[bridgectl] 端口 ${result.port} 已被占用（非本桥）：${formatHost(result.host)}:${result.port} ${detail}；` +
          `已中止 start（exit 1、未写 pidfile、未启动桥）。请先释放该端口，或改用其它 transport.http.port。`,
      );
      process.exit(1);
      return;
    }
    case "spawn-failed": {
      console.error(
        `[bridgectl] 子进程启动失败（spawn 同步异常）：${
          result.error instanceof Error ? result.error.message : String(result.error)
        }；exit 1（未发起）。`,
      );
      process.exit(1);
      return;
    }
    case "timeout": {
      console.error(
        `[bridgectl] state: ${result.sawStarting === true ? "starting" : "unreachable"}；启动失败（超时 ${READY_TIMEOUT_MS}ms）：` +
          `${formatHost(result.host)}:${result.port} /health 未达 200+status=ok（pid=${result.pid}）`,
      );
      printLogTail(30);
      process.exit(1);
      return;
    }
    case "already": {
      info(
        `state: ok（已在运行：${formatHost(result.host)}:${result.port}${config.mcpPath}，` +
          `health=${result.health?.status ?? "ok"}，role=${result.health?.role ?? "未报"}）`,
      );
      info("提示：缺省 0 ≠ 业务就绪（退出码 0 仅表示 /health 就绪，业务就绪需另行验证）。");
      process.exit(0);
      return;
    }
    case "starting": {
      // 入口探测遇 starting：本服务启动中 ⇒ 缺省 / --no-wait 均即返 0（不接管、不重启）
      info(
        `state: starting（${formatHost(result.host)}:${result.port} 上的本服务正在启动中；未接管、未重启）`,
      );
      info("提示：缺省 0 ≠ 业务就绪；本分支不等待 ok，如需确认请另起 `bridgectl status`。");
      process.exit(0);
      return;
    }
    case "spawned": {
      info(
        `state: starting（--no-wait 发起即返：已拉起，未等待就绪）pid=${result.pid}（仅供参考），` +
          `endpoint=${formatHost(result.host)}:${result.port}${config.mcpPath}，日志：${LOG_PATH}`,
      );
      info(
        "提示：--no-wait 退出码 0 仅表示「已发起」，≠ 就绪；pid 仅供参考，请另起 `bridgectl status`" +
          "（npm run bridge:status）确认。",
      );
      process.exit(0);
      return;
    }
    case "started": {
      if (result.sawStarting === true) {
        info("state: starting（启动过程中服务已可答，尚未就绪）");
      }
      info(
        `state: ok（已后台启动 pid=${result.pid}，health=${result.health?.status ?? "ok"}，` +
          `role=${result.health?.role ?? "未报"}，endpoint=${formatHost(result.host)}:${result.port}${config.mcpPath}，` +
          `日志：${LOG_PATH}）`,
      );
      info("提示：缺省 0 ≠ 业务就绪（退出码 0 仅表示 /health 就绪，业务就绪需另行验证）。");
      process.exit(0);
      return;
    }
    default: {
      console.error(`[bridgectl] 未知启动结果：${String(result.kind)}`);
      process.exit(1);
      return;
    }
  }
}

async function cmdStop() {
  const config = loadConfig();
  const result = await doStop(config);
  if (result.ok) {
    info(result.message);
    process.exit(0);
  }
  console.error(`[bridgectl] ${result.message}`);
  console.error(`[bridgectl] 可手动排查：pidfile=${PIDFILE_PATH}`);
  process.exit(1);
}

async function cmdRestart(flags) {
  const noWait = flags.noWait === true;
  const config = loadConfig();
  if (noWait) {
    // C6：--no-wait 仅作用 start 段；stop 段（shutdown + 兜底强杀等待）仍阻塞 ⇒ 显式提示非瞬时
    info(
      `restart --no-wait：仅 **start 段** 发起即返；**stop 段仍阻塞**（最长约 ${
        (SHUTDOWN_TIMEOUT_MS + STOP_TIMEOUT_MS * 2) / 1000
      }s = shutdown ${SHUTDOWN_TIMEOUT_MS / 1000}s + 强杀等待 ${STOP_TIMEOUT_MS / 1000}s×2），本次调用**非瞬时返回**。`,
    );
  }
  const result = await doStop(config);
  if (!result.ok) {
    console.error(`[bridgectl] restart 中止（停止失败）：${result.message}`);
    process.exit(1);
  }
  info(result.message);
  await cmdStart(flags);
}

/**
 * status 退出码约定（REQ-v0.4.1-2026-09-15-02）：
 *   - 桥在运行（端口监听且 `GET /health` HTTP 200 + `status:"ok"`）→ 退出码 **0**
 *   - 未运行（端口未监听：pidfile 缺失或陈旧）→ 退出码 **0**
 *   - 探测/配置异常（端口被非本桥占用即「可连但 /health 不健康」；配置不可读由 loadConfig 直接 fail）
 *     → 退出码 **非零**
 * 即「未运行」是正常可预期状态，不得以非零退出码误报为错误。
 */
async function cmdStatus() {
  const config = loadConfig();
  const pidfile = readPidfile();
  const host = resolveProbeHost(config);
  const port = config.port;
  const listening = await probePort(port, host);
  const health = listening ? await httpHealth(host, port) : null;
  /** 运行判定以 `/health` 为准：端口可连但 /health 不健康不算「运行中」 */
  const running = health !== null && health.httpStatus === 200 && health.status === "ok";
  const pidAlive = pidfile !== null && isPidAlive(pidfile.pid);

  let state;
  if (running) state = "运行中";
  else if (listening) state = "端口被占用（可连但 /health 不健康，非本桥）";
  else if (pidfile !== null) state = "pidfile 陈旧（有文件但端口未监听）";
  else state = "未运行";

  const role =
    health?.role ?? (running ? "未报" : listening ? "未知（/health 未返回 role）" : "不可达");

  info(`状态     : ${state}`);
  info(
    `pid      : ${
      pidfile !== null
        ? `${pidfile.pid}${pidAlive ? "" : "（已不存在）"}`
        : listening
          ? "未知（pidfile 缺失）"
          : "-"
    }`,
  );
  info(`endpoint : ${formatHost(host)}:${port}${config.mcpPath}`);
  info(
    `health   : ${
      health !== null
        ? `${health.status ?? "ok"}${health.version !== undefined ? ` version=${health.version}` : ""}`
        : "不可达"
    }`,
  );
  info(`role     : ${role}`);
  info(`startedAt: ${pidfile?.startedAt ?? "-"}`);
  info(`pidfile  : ${PIDFILE_PATH}${existsSync(PIDFILE_PATH) ? "" : "（不存在）"}`);
  info(`config   : ${config.path}（transport.mode=${config.mode}）`);
  info(`log      : ${LOG_PATH}`);

  // 退出码（见本函数顶部注释）：桥在运行 → 0；未运行 → 0；探测异常（端口可连但 /health 不健康）→ 非零。
  if (running || !listening) process.exit(0);
  process.exit(1);
}

async function cmdLogs(flags) {
  if (!existsSync(LOG_PATH)) {
    console.error(`[bridgectl] 日志不存在：${LOG_PATH}`);
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
      fail(`未知子命令：${command}（运行 node scripts/bridgectl.mjs --help 查看用法）`);
  }
}

await main();
