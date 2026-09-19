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
 * **停止成功判据 = 端口释放 ∧ 进程退出**（K5a）：`/shutdown` 的 200 仅代表「受理」，端口释放
 * （`server.close()` 同步停监听）不代表进程已退 ⇒ 须 `readPidfile()` + `isPidAlive` 后置校验；
 * pid 超时未退则落入 `killForce` 兜底，**确证进程已退之后**才清 pidfile。
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
 * stop 段仍阻塞（最长约 95s = `POST /shutdown` ≤5s + 等待端口释放 ≤45s×2），**非瞬时返回**。
 * 退出码恒 `{0,1}`（C5）。
 *
 * 退出卫生（v0.7.2 X1）：**主流程不使用 process.exit**（改设 `process.exitCode` 后自然排空），
 * HTTP 一律走 `node:http`（`agent:false` + `Connection: close`，响应结束即释放 socket），
 * 以规避 Windows 退出期 libuv 断言（`!(handle->flags & UV_HANDLE_CLOSING)`）污染退出码。
 *
 * opt-in `--wait-ready`（配 `--ready-timeout <ms>`，缺省 `READY_TIMEOUT_MS`）显式等待就绪：
 * 判据 = `GET /health` 的 `status === "ok"`（与入口探测同判据键；不含 role / recover）。用途：
 * 入口探测为 `starting` 时**续等至 ok**（缺省该分支即返 0），或放宽就绪预算（>30s，治 v0.7.1
 * 的 `restart --no-wait` 就绪假阴性）；超时 exit 1。与 `--no-wait` 互斥（同传 ⇒ 显式报错 exit 1）。
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
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPidAlive, killForce as killForceImpl } from "./lib/proc.mjs";

/** start 等待 `/health` 就绪的超时（含启动自检 / `recover()`，故留足余量） */
const READY_TIMEOUT_MS = 30_000;
/**
 * stop 等待端口释放的超时（优雅停机 / 强杀共用）。
 *
 * **跨单元同源常量**：与 `orch/runtime/lifecycle.ts` 的 `readDrainGraceMs()` 对齐 ——
 * 优雅停机内部的排空预算缺省 **30s**（env `BRIDGE_DRAIN_GRACE_MS`），故本超时须
 * **≥ 排空上限 + 余量**，否则「排空尚未结束」的正常慢停机会被误判为优雅停机超时、
 * 提前落入强杀兜底。取值 = 30s 排空 + 15s 余量（**不强行等值**）。
 * 脚本不 import TS 产物，故此处常量须与 `readDrainGraceMs()` 缺省值手工保持一致
 * （先例：`machine/scripts/launcherctl.mjs` 的 `DEFAULT_STARTUP_CHECK_TIMEOUT_MS`）。
 * **改一侧必须同步改另一侧**；若运维经 `BRIDGE_DRAIN_GRACE_MS` 抬高排空预算，须同步抬升本值。
 */
const STOP_TIMEOUT_MS = 45_000;
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

/**
 * 显式失败（退出码 1）——**不强制退出进程**：抛 `CliExit` 由 `main()` 收口设 `process.exitCode`，
 * 让事件循环**自然排空**（治 v0.7.2 X1 退出期 libuv 断言 / 退出码被污染为 0xC0000409）。
 * stderr 呈现与退出码契约 {0,1} 不变。
 */
class CliExit extends Error {
  constructor(code) {
    super(`explicit exit ${code}`);
    this.name = "CliExit";
    this.code = code;
  }
}

function fail(message) {
  console.error(`[bridgectl] ${message}`);
  throw new CliExit(1);
}

function info(message) {
  console.log(`[bridgectl] ${message}`);
}

/** 降级告警（stdout，必须可见）：如脱壳不可用时提示「调用方可能被拖住」 */
function warn(message) {
  console.log(`[bridgectl] 警告：${message}`);
}

/** pid 展示：读不到（pidfile 未就位）如实呈现，**不编造** */
function formatPid(pid) {
  return typeof pid === "number" ? String(pid) : "未知（pidfile 未就位）";
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

/**
 * 极简 HTTP 请求（**node:http**，非 fetch / undici）：`agent:false` + `Connection: close`
 * ⇒ 一请求一 socket、响应结束即释放，**不残留 keep-alive 池化句柄**（治 v0.7.2 X1 退出期 libuv
 * 断言：`fetch` 的 undici 全局 agent 会持有 socket，退出时句柄未收尾）。
 * 网络错误 / 超时 ⇒ `null`；成功 ⇒ `{ statusCode, body }`（body 为 utf8 文本）。
 */
function httpRequestText(host, port, requestPath, method, timeoutMs) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const req = httpRequest(
      { host, port, path: requestPath, method, agent: false, headers: { connection: "close" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => done({ statusCode: res.statusCode ?? 0, body }));
        res.on("error", () => done(null));
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done(null);
    });
    req.on("error", () => done(null));
    req.end();
  });
}

/** GET /health；网络错误 / 非 JSON 返回 null（其余情况带回 httpStatus + body 字段） */
async function httpHealth(host, port, timeoutMs = 2_000) {
  const res = await httpRequestText(host, port, "/health", "GET", timeoutMs);
  if (res === null) return null;
  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object") return null;
  return {
    httpStatus: res.statusCode,
    status: typeof body.status === "string" ? body.status : undefined,
    role: typeof body.role === "string" ? body.role : undefined,
    version: typeof body.version === "string" ? body.version : undefined,
  };
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

/**
 * 轮询**停止收口判据**：`端口已释放 ∧ 进程已退出`（K5a；与 machine `launcherctl.mjs` 的
 * `waitStopConverged` 同口径、各自实现，不共享代码）。
 * `probePort` 只是单次 TCP connect（对端套接字一关即 false）⇒ 不能单独作准，须追加 `isPidAlive`
 * 后置校验；pid 未知（pidfile 缺失）时退化为仅看端口，`exited` 置 null 表示无法校验。
 * 返回 `{ released, exited }`：`exited` = true（已退出）/ false（仍存活）/ null（无法校验）。
 */
async function waitStopConverged(port, host, pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const released = !(await probePort(port, host));
    const exited = pid === undefined ? null : !isPidAlive(pid);
    if (released && exited !== false) return { released, exited };
    if (Date.now() >= deadline) return { released, exited };
    await delay(PROBE_INTERVAL_MS);
  }
}

// 进程存活判定 `isPidAlive` 见 `./lib/proc.mjs`（K8/K9 收敛；注入式纯函数，三端可结构级断言）；
// 语义：仅 `ESRCH` 判「不存在」，其余错误（EPERM / EINVAL / …）**保守判活**。

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
 *   - `status === "starting"` ⇒ 本服务启动中 ⇒ **缺省与 `--no-wait` 均即返 0**（`starting`）；
 *     但 opt-in `--wait-ready` 时**续等至 `status === "ok"`** ⇒ `ready`（exit 0）/ `ready-timeout`（exit 1）
 *   - `status` 缺失 / 非白名单 ⇒ 占用（`occupied`，exit 1）
 * 端口未监听则拉起：`--no-wait` 发起即返（`spawned`）；缺省轮询至 `200 && status === "ok"`
 * （`started`，等待上限 = `options.readyTimeoutMs ?? READY_TIMEOUT_MS`），超时 `timeout`（exit 1）。
 * spawn **同步**抛错 ⇒ `spawn-failed`（exit 1）。
 * 不退出，返回 `{ kind, host, port, health, pid, sawStarting?, readyTimeoutMs?, error? }` 供调用方决定输出 / 退出码。
 */
async function doStart(config, options = {}) {
  const noWait = options.noWait === true;
  const waitReady = options.waitReady === true;
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
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
      // ③ 本服务启动中：缺省 / --no-wait 即返 0；`--wait-ready` 则续等至 status:"ok"
      if (waitReady) {
        const ready = await waitForReady(host, port, readyTimeoutMs, options.onStatus);
        const pid = readPidfile()?.pid;
        if (ready.health === null) {
          return {
            kind: "ready-timeout",
            host,
            port,
            health: null,
            pid,
            sawStarting: true,
            readyTimeoutMs,
          };
        }
        return {
          kind: "ready",
          host,
          port,
          health: ready.health,
          pid,
          sawStarting: true,
          readyTimeoutMs,
        };
      }
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
    return {
      kind: "spawn-failed",
      host,
      port,
      health: null,
      pid: undefined,
      error: launched.error,
    };
  }

  // 脱壳路径**无本地子进程句柄**（child=undefined）⇒ pid 以 pidfile 为准；缺失即 undefined（判「不确定」）
  const child = launched.kind === "spawn" ? launched.child : undefined;
  const launchPid = child !== undefined ? child.pid : readPidfile()?.pid;

  if (noWait) {
    // 发起即返：exit 0 = 已发起 ≠ 就绪；异步 spawn error 不改变结论（C8：pid 仅供参考）
    return { kind: "spawned", host, port, health: null, pid: launchPid };
  }

  const ready = await waitForReady(host, port, readyTimeoutMs, options.onStatus);
  // wait-ready 完成后**重读**桥自写的 pidfile 取**权威 pid**（脱壳路径无本地子进程句柄；
  // 上一轮曾报 WMI 壳进程 pid 6728，而 pidfile 的 36240 才是真桥）。读不到即 undefined，
  // 由调用方**如实**输出 `pid=未知（pidfile 未就位）`，不编造。
  const readyPid = readPidfile()?.pid;
  if (ready.health === null) {
    return {
      kind: "timeout",
      host,
      port,
      health: null,
      pid: readyPid,
      sawStarting: ready.sawStarting,
      readyTimeoutMs,
    };
  }
  return {
    kind: "started",
    host,
    port,
    health: ready.health,
    pid: readyPid,
    sawStarting: ready.sawStarting,
  };
}

/** 优雅停机端点（`POST /shutdown`，仅 loopback）；成功返回 true */
async function tryShutdownEndpoint(host, port) {
  const res = await httpRequestText(host, port, "/shutdown", "POST", SHUTDOWN_TIMEOUT_MS);
  if (res === null) {
    info("/shutdown 请求失败 / 超时，转入强杀兜底");
    return false;
  }
  if (res.statusCode === 200) {
    info("已发送 POST /shutdown（优雅停机：排空在飞 → 关库 → 释放租约 → 删 pidfile）");
    return true;
  }
  info(`/shutdown 返回 HTTP ${res.statusCode}，转入强杀兜底`);
  return false;
}

/**
 * 强杀（K5c/K8/K9）：杀法本身集中在 `./lib/proc.mjs`（可注入纯函数，三端分支可结构级断言；
 * 与 `tools/bridgectl-probe.mjs` 的 `killTree` **同源**，避免两套实现）：
 *   - Windows：`taskkill /PID <pid> /T /F`（不变）；
 *   - POSIX：`SIGKILL` **进程组**杀 `kill(-pid)`（桥经 `spawnBridgeDetached` 以 `detached:true`
 *     拉起 ⇒ 桥为进程组组长，组杀可覆盖其子进程）；组不存在（`ESRCH`，含「pid 非组长」的
 *     兜底情形）时**回落** `kill(pid, "SIGKILL")` 单 pid，避免误伤同号进程组。
 * 本函数只负责日志与错误呈现，不改动杀法分支。
 */
function killForce(pid) {
  const result = killForceImpl(pid);
  if (result.method === "taskkill") {
    info(`强制停止（Windows taskkill /PID ${pid} /T /F）…`);
  } else if (result.method === "kill-group") {
    info(`强制停止（POSIX SIGKILL 组杀 pid=${pid}）…`);
  } else if (result.method === "kill-pid") {
    info(`强制停止（POSIX 组杀 ESRCH ⇒ 回落单 pid SIGKILL pid=${pid}）…`);
  }
  if (!result.ok) {
    console.error(
      `[bridgectl] 强杀失败：${
        result.error instanceof Error ? result.error.message : String(result.error)
      }`,
    );
  } else if (result.gone === true) {
    info(`pid=${pid} 已不存在（无需强杀）`);
  }
}

/**
 * 停止：优先 `POST /shutdown` 优雅停机并等待退出；超时兜底强杀；**确证进程已退**后才清 pidfile。
 *
 * **成功判据 = 端口释放 ∧ 进程退出**（K5a；与 machine K7 同口径）：`/shutdown` 返回 200 仅代表
 * 「受理」（handler 在触发停机前就回 200），端口释放亦不代表进程已退 ⇒ 须 `isPidAlive` 后置校验。
 * pid 超时未退 ⇒ **落入 `killForce`**（判据收紧后该兜底才可达：此前「端口一释放即提前 return」
 * 使其永不触发，即 wedge 主症状之一）。任何**未达标**路径一律 `ok:false` 且**保留 pidfile**
 * （提前删 = 下次 stop 失去定位手段）。
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
      // 判据 = 端口释放 ∧ 进程退出；pidfile 缺失（pid 不可知）时退化为仅看端口
      const targetPid = pidfile?.pid;
      const converged = await waitStopConverged(port, host, targetPid, STOP_TIMEOUT_MS);
      if (converged.released && converged.exited !== false) {
        removePidfileIfPresent();
        const pidNote =
          converged.exited === true
            ? `，pid=${targetPid} 已退出`
            : "（pidfile 缺失，进程退出未校验）";
        return {
          ok: true,
          message: `已停止（POST /shutdown 优雅停机，端口 ${port} 已释放${pidNote}）`,
        };
      }
      info(
        `优雅停机未达标（${STOP_TIMEOUT_MS}ms）：端口 ${port} ${
          converged.released ? "已释放" : "仍占用"
        }${converged.exited === false ? `，pid=${targetPid} 仍存活` : ""} ⇒ 转入强杀兜底 …`,
      );
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
    const converged = await waitStopConverged(port, host, pid, STOP_TIMEOUT_MS);
    if (converged.released && converged.exited !== false) {
      removePidfileIfPresent();
      return { ok: true, message: `已停止（强杀 pid=${pid}，端口 ${port} 已释放、进程已退出）` };
    }
    // 未达标：不删 pidfile（保留定位手段），显式失败
    return {
      ok: false,
      message: `停止超时：端口 ${port} ${converged.released ? "已释放" : "仍被占用"}，pid=${pid} ${
        converged.exited === false ? "仍存活" : "状态未知"
      }（pidfile 已保留 ${PIDFILE_PATH}）`,
    };
  }

  // 端口未监听 —— 判据仍为「端口释放 ∧ 进程退出」
  if (pidfile === null) {
    return { ok: true, message: `未运行（端口 ${port} 未监听）` };
  }
  if (!isPidAlive(pidfile.pid)) {
    removePidfileIfPresent();
    return { ok: true, message: `未运行（端口 ${port} 未监听）；已清理陈旧 pidfile` };
  }
  // 端口已释放但进程仍存活 ⇒ 判据不满足：不报成功、不误杀（可能正在启动或已 wedge），保留 pidfile
  return {
    ok: false,
    message: `停止未达标：端口 ${port} 未监听，但 pidfile 指向的 pid=${pidfile.pid} 仍存活（可能正在启动或已 wedge）；未强杀、保留 pidfile ${PIDFILE_PATH}`,
  };
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
    if (arg === "--no-wait") {
      flags.noWait = true;
    } else if (arg === "--wait-ready") {
      flags.waitReady = true;
    } else if (arg === "--ready-timeout") {
      i += 1;
      flags.readyTimeout = parsePositiveInt(argv[i], "--ready-timeout");
    } else if (arg.startsWith("--ready-timeout=")) {
      flags.readyTimeout = parsePositiveInt(
        arg.slice("--ready-timeout=".length),
        "--ready-timeout",
      );
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
  // C3：--no-wait（发起即返）与 --wait-ready（等待就绪）语义互斥 ⇒ 显式报错（不静默取其一）
  if (flags.noWait && flags.waitReady) {
    fail("--no-wait 与 --wait-ready 不能同时使用（前者发起即返，后者等待 status=ok）");
  }
  // --ready-timeout 仅承载 --wait-ready 的就绪等待上限，脱离 --wait-ready 无意义 ⇒ 显式报错
  if (flags.readyTimeout !== undefined && !flags.waitReady) {
    fail("--ready-timeout 仅在 --wait-ready 下有效");
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
                      （最长约 95s = shutdown 5s + 强杀等待 45s×2），该次返回非瞬时。
                    ! --no-wait 报出的 pid 仅供参考，须另起 status 确认（C8）。
  --wait-ready      显式等待就绪（GET /health 返回 status:"ok"）后才 exit 0；超时 exit 1。
                    与 --no-wait 互斥（同传即报错）。用途：入口探测为 starting 时续等至 ok，
                    或配合 --ready-timeout 放宽就绪预算（治 restart --no-wait 就绪假阴性）。
  --ready-timeout <ms>
                    --wait-ready 的就绪等待上限（缺省 30000）；仅在 --wait-ready 下有效。

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
  const waitReady = flags.waitReady === true;
  const readyTimeoutMs = flags.readyTimeout ?? READY_TIMEOUT_MS;
  const config = loadConfig();
  if (config.mode !== "http") {
    fail(
      `配置 ${config.path} 的 transport.mode=${config.mode}：stdio transport 已退役（桥会解析期 fail-fast），bridgectl 无法后台化。` +
        `请删除 "transport.mode"（缺省即 http）或将其改为 "http" 后重试。`,
    );
  }

  const result = await doStart(config, {
    noWait,
    waitReady,
    readyTimeoutMs,
    onStatus: (health) => {
      if (health !== null && health.status === "starting") {
        info("state: starting（服务已可答，尚未就绪；继续等待至 ok …）");
      }
    },
  });

  // 各分支只设 `process.exitCode` 后 return（**不强制退出**）：让已打开的句柄自然排空，
  // 避免 Windows 退出期 libuv 断言污染退出码（v0.7.2 X1）。退出码契约 {0,1} 不变。
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
      process.exitCode = 1;
      return;
    }
    case "spawn-failed": {
      console.error(
        `[bridgectl] 子进程启动失败（spawn 同步异常）：${
          result.error instanceof Error ? result.error.message : String(result.error)
        }；exit 1（未发起）。`,
      );
      process.exitCode = 1;
      return;
    }
    case "timeout": {
      console.error(
        `[bridgectl] state: ${result.sawStarting === true ? "starting" : "unreachable"}；启动失败（超时 ${
          result.readyTimeoutMs ?? READY_TIMEOUT_MS
        }ms）：` +
          `${formatHost(result.host)}:${result.port} /health 未达 200+status=ok（pid=${formatPid(result.pid)}）`,
      );
      printLogTail(30);
      process.exitCode = 1;
      return;
    }
    case "ready": {
      // --wait-ready 且入口探测为 starting：续等至 status:"ok" 成功
      info(
        `state: ok（--wait-ready 已就绪：${formatHost(result.host)}:${result.port}${config.mcpPath}，` +
          `health=${result.health?.status ?? "ok"}，role=${result.health?.role ?? "未报"}）`,
      );
      process.exitCode = 0;
      return;
    }
    case "ready-timeout": {
      console.error(
        `[bridgectl] state: starting；--wait-ready 超时（${
          result.readyTimeoutMs ?? READY_TIMEOUT_MS
        }ms）：` +
          `${formatHost(result.host)}:${result.port} /health 未达 status=ok（pid=${formatPid(result.pid)}）；判为「启动未就绪」`,
      );
      printLogTail(30);
      process.exitCode = 1;
      return;
    }
    case "already": {
      info(
        `state: ok（已在运行：${formatHost(result.host)}:${result.port}${config.mcpPath}，` +
          `health=${result.health?.status ?? "ok"}，role=${result.health?.role ?? "未报"}）`,
      );
      info("提示：缺省 0 ≠ 业务就绪（退出码 0 仅表示 /health 就绪，业务就绪需另行验证）。");
      process.exitCode = 0;
      return;
    }
    case "starting": {
      // 入口探测遇 starting：本服务启动中 ⇒ 缺省 / --no-wait 均即返 0（不接管、不重启）
      info(
        `state: starting（${formatHost(result.host)}:${result.port} 上的本服务正在启动中；未接管、未重启）`,
      );
      info("提示：缺省 0 ≠ 业务就绪；本分支不等待 ok，如需确认请另起 `bridgectl status`。");
      process.exitCode = 0;
      return;
    }
    case "spawned": {
      info(
        `state: starting（--no-wait 发起即返：已拉起，未等待就绪）pid=${formatPid(result.pid)}（仅供参考），` +
          `endpoint=${formatHost(result.host)}:${result.port}${config.mcpPath}，日志：${LOG_PATH}`,
      );
      info(
        "提示：--no-wait 退出码 0 仅表示「已发起」，≠ 就绪；pid 仅供参考，请另起 `bridgectl status`" +
          "（npm run bridge:status）确认。",
      );
      process.exitCode = 0;
      return;
    }
    case "started": {
      if (result.sawStarting === true) {
        info("state: starting（启动过程中服务已可答，尚未就绪）");
      }
      info(
        `state: ok（已后台启动 pid=${formatPid(result.pid)}，health=${result.health?.status ?? "ok"}，` +
          `role=${result.health?.role ?? "未报"}，endpoint=${formatHost(result.host)}:${result.port}${config.mcpPath}，` +
          `日志：${LOG_PATH}）`,
      );
      info("提示：缺省 0 ≠ 业务就绪（退出码 0 仅表示 /health 就绪，业务就绪需另行验证）。");
      process.exitCode = 0;
      return;
    }
    default: {
      console.error(`[bridgectl] 未知启动结果：${String(result.kind)}`);
      process.exitCode = 1;
      return;
    }
  }
}

async function cmdStop() {
  const config = loadConfig();
  const result = await doStop(config);
  if (result.ok) {
    info(result.message);
    process.exitCode = 0;
    return;
  }
  console.error(`[bridgectl] ${result.message}`);
  console.error(`[bridgectl] 可手动排查：pidfile=${PIDFILE_PATH}`);
  process.exitCode = 1;
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
    process.exitCode = 1;
    return;
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
  process.exitCode = running || !listening ? 0 : 1;
}

async function cmdLogs(flags) {
  if (!existsSync(LOG_PATH)) {
    console.error(`[bridgectl] 日志不存在：${LOG_PATH}`);
    process.exitCode = 1;
    return;
  }
  const content = readFileSync(LOG_PATH, "utf8");
  const output = flags.lines === undefined ? content : lastLines(content, flags.lines);
  process.stdout.write(output.endsWith("\n") || output.length === 0 ? output : `${output}\n`);
  if (flags.follow) await followLog();
  process.exitCode = 0;
}

/**
 * 主流程收口：**不再强制退出进程** —— `fail()` 抛出的 `CliExit` 在此转成 `process.exitCode`，
 * 其余已打开句柄（HTTP socket / 子进程 / fd）在事件循环自然排空后一并收尾（v0.7.2 X1）。
 * 未预期异常同样只设退出码 1（不 `process.exit`），避免再次触发 Windows 退出期 libuv 断言。
 */
async function main() {
  try {
    const { command, flags } = parseArgs(process.argv.slice(2));
    if (flags.help || command === "help" || command === undefined || command === "--help") {
      printUsage();
      process.exitCode = command === undefined ? 1 : 0;
      return;
    }
    // --wait-ready / --ready-timeout 仅 start / restart 接受（其余命令显式报错，不静默忽略）
    if (
      (flags.waitReady || flags.readyTimeout !== undefined) &&
      command !== "start" &&
      command !== "restart"
    ) {
      fail(`--wait-ready / --ready-timeout 仅适用于 start / restart（当前命令：${command}）`);
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
  } catch (err) {
    if (err instanceof CliExit) {
      process.exitCode = err.code;
      return;
    }
    console.error(
      `[bridgectl] 未预期错误：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    process.exitCode = 1;
  }
}

/**
 * 本模块是否被 node **作为入口脚本直接执行**（K8 前置；与 `orch/bridge/index.ts` 的
 * `isEntryModule` 同构）。加此守卫后，`import` 本模块**零副作用**（不再一 import 就跑
 * `main()`）⇒ `killForce` / `isPidAlive` 所在的 `./lib/proc.mjs` 可被注入式单测直接驱动，
 * 本模块自身亦可被安全 import。三种真实启动路径（`npm run bridge:*` / 直接 `node
 * scripts/bridgectl.mjs` / 探针 spawn）的 `argv[1]` 均指向本文件 ⇒ 生产行为零变化。
 */
function isEntryModule() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  const target = resolve(entry);
  // Windows 路径大小写不敏感（盘符 / 路径段大小写可能不同）⇒ 折半比较
  return process.platform === "win32"
    ? self.toLowerCase() === target.toLowerCase()
    : self === target;
}

if (isEntryModule()) {
  await main();
}
