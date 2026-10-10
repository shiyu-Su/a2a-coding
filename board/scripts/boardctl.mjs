#!/usr/bin/env node
/**
 * board 板服务跨平台启停脚本（BD13″ · v0.9.0；照 `orch/scripts/bridgectl.mjs` 与
 * `machine/scripts/launcherctl.mjs` 同构蓝本，**零新依赖**，全用 `node:*`）。
 *
 *   node scripts/boardctl.mjs start|stop|restart|status|logs [options]
 *
 * 关键约定：
 *   - 入口   board/dist/index.js（缺失时**只提示** `npm run build`，不自动构建）
 *   - pidfile board/.a2a/board.pid（**由板自己写**，JSON { pid, port, host, startedAt }；本脚本只读）
 *   - 日志   board/.a2a/logs/board.log（本脚本把 stdout+stderr **合并追加**重定向到此；
 *            板自 v0.9.0 起每行带 [ISO时间] [tag] 前缀 —— 刻意改进，不继承 machine 无行级时间戳的痛点）
 *   - 致命日志 board/.a2a/logs/board.fatal.log（BD19 缺陷②：板死在 logger 之前时 board.log 会**一片空白**，
 *            堆栈只在这条同步落盘的通道里）⇒ start 失败分支**连它一起打尾部**（存在才打）并在文案里给出路径
 *   - 配置   **不解析配置内容**（BD12″ 裁定「配置只从文件读」）：只把 `BOARD_CONFIG` 环境变量
 *            **原样透传**给板进程（缺省就不带 ⇒ 板自己按仓内缺省路径读）；
 *            端口探测 = pidfile 的 { host, port } 优先，pidfile 缺失回落缺省 3400。
 *
 * Windows 脱壳拉起（照蓝本）：
 *   常驻板服务经 WMI `Win32_Process.Create` 建**隐藏 powershell 壳**（挂 WmiPrvSE，**脱离调用方
 *   进程树** —— 否则宿主工具会「等自己作业清空」而卡住），壳内 `cmd /c "node <entry> >> <log> 2>&1"`
 *   合并两条流并保持追加语义；powershell 用 `-EncodedCommand`（UTF-16LE + Base64）规避多层引号。
 *   WMI 不可用 ⇒ **显式**降级 `spawn(detached)+unref()` 并在 stdout 警告（不静默）。
 *   POSIX 保持 `spawn(detached:true)` + `unref()`（setsid 天然脱离）。
 *
 * 运行判定（**不以「端口可连」为准**，键 = `/health` 的 `status`）：
 *   `GET /health` HTTP 200 且 `status:"ok"` ⇒ 运行中；端口可连但 /health 不可答 / status 非 ok
 *   ⇒ 真占用（非本板）；端口未监听 ⇒ 未运行。与 pidfile 交叉 ⇒ 三态：
 *   运行中 / pidfile 陈旧 / 未运行（+ 端口被非本板占用 = 异常态，exit 1）。
 *
 * stop 两条路径（蓝本口径）：
 *   ① 优雅 = `POST /shutdown`（**仅 loopback 来源受理**；200 仅代表「受理」≠ 已停）
 *      —— 请求超时 5s + 收敛等待 45s（判据 = 端口释放 ∧ 进程退出）；
 *   ② 优雅不可达 / 超时 ⇒ 兜底强杀（Windows `taskkill /T /F`；POSIX SIGTERM→宽限→组杀 SIGKILL），
 *      **确证进程已退之后**才清 pidfile；未达标路径保留 pidfile 供排查。
 *
 * 退出卫生（照 orch v0.7.2 X1）：主流程**不用 `process.exit`**，改设 `process.exitCode`
 * （让事件循环自然排空，治 Windows 退出期退出码被污染）；HTTP 走 `node:http`
 * （`agent:false` + `Connection: close`，不残留 keep-alive 句柄）。**退出码恒 {0,1}**。
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

/** 缺省端口（与 `src/config.ts` 的 DEFAULT_PORT 同值；本脚本**不读配置文件**，仅作回落探测点） */
export const DEFAULT_PORT = 3400;
/** start 等待服务可答（/health 200 + status ok）的超时 */
export const READY_TIMEOUT_MS = 30_000;
/** stop 的优雅收敛等待（POST /shutdown 受理 → 端口释放 ∧ 进程退出） */
export const STOP_TIMEOUT_MS = 45_000;
/** `POST /shutdown` 单次请求超时 */
export const SHUTDOWN_TIMEOUT_MS = 5_000;
/** POSIX stop 的 SIGTERM→SIGKILL 宽限 */
export const STOP_TERM_GRACE_MS = 5_000;
const PROBE_TIMEOUT_MS = 1_000;
const PROBE_INTERVAL_MS = 200;
/** 已确认运行中之后，再等 pidfile 就位的小宽限（板 listening 与写 pidfile 相差毫秒级） */
const PIDFILE_GRACE_MS = 1_000;
const FOLLOW_INTERVAL_MS = 300;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BOARD_ROOT = findBoardRoot(SCRIPT_DIR);
const ENTRY = join(BOARD_ROOT, "dist", "index.js");
const PIDFILE_PATH = join(BOARD_ROOT, ".a2a", "board.pid");
const LOG_DIR = join(BOARD_ROOT, ".a2a", "logs");
const LOG_PATH = join(LOG_DIR, "board.log");
/** BD19 缺陷②：板在 logger 就绪前崩溃 ⇒ 堆栈只落这里（`board.log` 可能一行都没有）。 */
const FATAL_LOG_PATH = join(LOG_DIR, "board.fatal.log");

function findBoardRoot(startDir) {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

/** 显式失败：抛 CliExit，由 main() 收口设 process.exitCode（不强制退出） */
class CliExit extends Error {
  constructor(code) {
    super(`explicit exit ${code}`);
    this.name = "CliExit";
    this.code = code;
  }
}

function fail(message) {
  console.error(`[boardctl] ${message}`);
  throw new CliExit(1);
}

function info(message) {
  console.log(`[boardctl] ${message}`);
}

function warn(message) {
  console.log(`[boardctl] 警告：${message}`);
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 路径与常量打包成 deps（可注入，供单测换临时目录） */
export function defaultPaths() {
  return {
    entry: ENTRY,
    pidfile: PIDFILE_PATH,
    logDir: LOG_DIR,
    logPath: LOG_PATH,
    fatalLogPath: FATAL_LOG_PATH,
    root: BOARD_ROOT,
  };
}

/**
 * 读 pidfile（**由板自己写**，本脚本只读）；缺失 / 坏 JSON / 形状不合法 ⇒ null。
 * 校验口径与 `src/lifecycle.ts#parsePidfileRecord` 一致（pid/port 正整数、host 非空字符串）。
 */
export function readPidfile(path = PIDFILE_PATH) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw === null || typeof raw !== "object" || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    if (!Number.isInteger(raw.port) || raw.port <= 0 || typeof raw.host !== "string" || raw.host === "") return null;
    return {
      pid: raw.pid,
      port: raw.port,
      host: raw.host,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
    };
  } catch {
    return null;
  }
}

/** 探测端点：pidfile 的 { host, port } 优先；缺失回落 127.0.0.1:3400（**不读配置内容**） */
export function resolveProbeEndpoint(pidfile, fallbackPort = DEFAULT_PORT) {
  if (pidfile !== null) {
    const host = pidfile.host === "0.0.0.0" || pidfile.host === "::" ? "127.0.0.1" : pidfile.host;
    return { host, port: pidfile.port };
  }
  return { host: "127.0.0.1", port: fallbackPort };
}

function formatHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}

/** 单次 TCP 连接探测：能连上即认为端口已监听 */
export function probePort(port, host, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((r) => {
    const socket = createConnection({ port, host });
    const finish = (ok) => {
      socket.destroy();
      r(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/**
 * 极简 HTTP（node:http，非 fetch/undici）：`agent:false` + `Connection: close`
 * ⇒ 一请求一 socket、响应结束即释放（退出卫生：不残留 keep-alive 句柄污染退出码）。
 */
function httpRequestText(host, port, path, method, timeoutMs) {
  return new Promise((r) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        r(v);
      }
    };
    const req = httpRequest(
      { host, port, path, method, agent: false, headers: { connection: "close" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
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

/** GET /health；网络错误 / 非 JSON ⇒ null */
export async function httpHealth(host, port, timeoutMs = 2_000) {
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
    port: typeof body.port === "number" ? body.port : undefined,
    version: typeof body.version === "string" ? body.version : undefined,
  };
}

/** 运行判定：HTTP 200 ∧ status === "ok"（不以端口可连为准） */
export function isHealthRunning(health) {
  return health !== null && health.httpStatus === 200 && health.status === "ok";
}

/**
 * 三态分类（纯函数；运行判定键 = /health 的 status，pidfile 只做交叉）：
 *   running   —— /health 200 + ok（pidfile 缺失时如实标注 unknownPid）
 *   occupied  —— 端口可连但 /health 不健康（非本板，或本板未就绪）⇒ 异常，调用方 exit 1
 *   stale     —— 端口未监听但 pidfile 在 ⇒ pidfile 陈旧
 *   stopped   —— 端口未监听且无 pidfile ⇒ 未运行
 */
export function classifyStatus({ listening, health, pidfile }) {
  if (listening) {
    return isHealthRunning(health) ? "running" : "occupied";
  }
  if (pidfile !== null) return "stale";
  return "stopped";
}

/** 轮询 /health 至运行（谓词 = isHealthRunning）或超时；返回最后一次可答 health（诊断用） */
async function waitForRunning(host, port, timeoutMs, deps) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const health = await deps.httpHealth(host, port);
    if (health !== null) last = health;
    if (isHealthRunning(health)) return { matched: health, last };
    if (Date.now() >= deadline) return { matched: null, last };
    await delay(PROBE_INTERVAL_MS);
  }
}

/**
 * start 编排（幂等；纯编排、探测全走注入 deps ⇒ 单测可喂假探测）。
 * 结果 kind ∈ occupied / already / spawned / started / start-timeout / spawn-failed。
 */
export async function doStart(flags = {}, deps) {
  const pidfile0 = deps.readPidfile();
  let { host, port } = resolveProbeEndpoint(pidfile0);

  if (await deps.probePort(port, host)) {
    const health = await deps.httpHealth(host, port);
    if (isHealthRunning(health)) {
      return { kind: "already", host, port, health, pid: pidfile0?.pid };
    }
    return {
      kind: "occupied",
      host,
      port,
      health,
      reason:
        health === null
          ? "/health 不可答（非 200 / 网络错误 / 超时）"
          : `/health status=${health.status ?? "(缺失)"} 非 ok`,
    };
  }

  // 端口未监听 ⇒ 拉起
  if (!deps.existsEntry()) {
    return { kind: "spawn-failed", reason: `未找到 ${deps.entry}：请先在板目录运行 npm run build`, host, port };
  }
  deps.mkdirLogDir();
  const launched = deps.launch();
  if (launched.kind === "spawn-failed") {
    return { kind: "spawn-failed", reason: launched.reason, host, port };
  }

  if (flags.noWait) {
    return { kind: "spawned", host, port, launched: launched.kind };
  }

  // 缺省 / --wait-ready：板 listening 后才自写 pidfile ⇒ 先等 pidfile 出现（拿真实端口），
  // 期间同时按缺省端口探测（同机同盘，通常毫秒级先后到）。
  const deadline = Date.now() + (flags.readyTimeout ?? READY_TIMEOUT_MS);
  for (;;) {
    const pf = deps.readPidfile();
    const ep = resolveProbeEndpoint(pf, port);
    const hit = await waitForRunning(ep.host, ep.port, Math.max(0, Math.min(2_000, deadline - Date.now())), deps);
    if (hit.matched !== null) {
      // 板先 listening、后自写 pidfile（同进程相邻两行）⇒ 命中健康后再给 pidfile 一点余量，
      // 免得把"运行中"报成"pid 未知"（拿不到 pid 不影响 status/stop 的其它判据，只是少一行现场）
      let rec = pf;
      const pidDeadline = Date.now() + PIDFILE_GRACE_MS;
      while (rec === null && Date.now() < pidDeadline) {
        await delay(PROBE_INTERVAL_MS);
        rec = deps.readPidfile();
      }
      return { kind: "started", host: ep.host, port: ep.port, health: hit.matched, pid: rec?.pid, launched: launched.kind };
    }
    if (Date.now() >= deadline) break;
    await delay(PROBE_INTERVAL_MS);
  }
  return { kind: "start-timeout", host, port, pid: deps.readPidfile()?.pid };
}

/** 优雅停机端点；受理（200）返回 true */
async function tryShutdownEndpoint(host, port, deps) {
  const res = await deps.httpRequestText(host, port, "/shutdown", "POST", SHUTDOWN_TIMEOUT_MS);
  if (res === null) {
    info("/shutdown 请求失败 / 超时，转入强杀兜底");
    return false;
  }
  if (res.statusCode === 200) {
    info("已发送 POST /shutdown（受理 = 优雅停机：停宿主桥 → 关卡口 → 删 pidfile；200 ≠ 已停）");
    return true;
  }
  info(`/shutdown 返回 HTTP ${res.statusCode}，转入强杀兜底`);
  return false;
}

/**
 * 收口判据 = **端口释放 ∧ 进程退出**（/shutdown 的 200 只是受理、close 回调只是停监听）；
 * pidfile 缺失时退化为仅看端口（exited = null = 无法校验）。
 * `timeoutMs` 可注入（缺省 `STOP_TIMEOUT_MS`），供单测把等待窗口压到毫秒级。
 */
export async function waitStopConverged(port, host, pid, timeoutMs, deps) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const released = !(await deps.probePort(port, host));
    const exited = pid === undefined ? null : !deps.isPidAlive(pid);
    if (released && exited !== false) return { released, exited };
    if (Date.now() >= deadline) return { released, exited };
    await delay(PROBE_INTERVAL_MS);
  }
}

/** 进程存活判定：ESRCH = 不存在；其余（EPERM 等）保守判活 */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** 强杀兜底：Windows 树杀（板可能托管宿主桥+后端两级进程）；POSIX 组杀 SIGKILL、ESRCH 回落单 pid */
export function killForce(pid, platform = process.platform) {
  if (platform === "win32") {
    info(`强制停止（Windows taskkill /PID ${pid} /T /F）…`);
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (result.error !== undefined) {
      return { ok: false, reason: `taskkill 执行失败：${result.error.message}` };
    }
    if (result.status !== 0) {
      return { ok: false, reason: `taskkill 失败（退出码 ${result.status}）：/PID ${pid} /T /F 未确认杀除` };
    }
    return { ok: true };
  }
  info(`强制停止（POSIX SIGKILL 组杀 pid=${pid}）…`);
  try {
    process.kill(-pid, "SIGKILL");
    return { ok: true };
  } catch (err) {
    if (err?.code === "ESRCH") {
      try {
        process.kill(pid, "SIGKILL");
        return { ok: true };
      } catch (err2) {
        if (err2?.code === "ESRCH") return { ok: true, gone: true };
        return { ok: false, reason: `SIGKILL 失败：${err2?.message ?? String(err2)}` };
      }
    }
    return { ok: false, reason: `SIGKILL 失败：${err?.message ?? String(err)}` };
  }
}

function removePidfile(path) {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { force: true });
  } catch (err) {
    console.error(`[boardctl] 删除 pidfile 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * stop 编排（纯编排 + deps 注入 ⇒ 「优雅→强杀」分支可单测）：
 *   ① 在监听 ⇒ POST /shutdown 优雅 → 收敛等待（`deps.stopTimeoutMs` 缺省 STOP_TIMEOUT_MS）；
 *   ② 优雅不可达 / 未收敛 ⇒ 定位 pid（pidfile）→ 强杀（`deps.killForce` 缺省本模块实现）→ 再收敛等待；
 *   收敛达标才清 pidfile；未达标保留现场并 ok:false。
 * 端口未监听：pidfile 陈旧（pid 已死）⇒ 清理并 ok；pid 仍活（启动中/wedge）⇒ 不误杀、ok:false。
 */
export async function doStop(deps) {
  const stopTimeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const kill = deps.killForce ?? ((pid) => killForce(pid, deps.platform));
  const pidfile = deps.readPidfile();
  const { host, port } = resolveProbeEndpoint(pidfile);
  const listening = await deps.probePort(port, host);

  if (listening) {
    const graceful = await tryShutdownEndpoint(host, port, deps);
    if (graceful) {
      const converged = await waitStopConverged(port, host, pidfile?.pid, stopTimeoutMs, deps);
      if (converged.released && converged.exited !== false) {
        removePidfile(deps.pidfile);
        const note =
          converged.exited === true ? `，pid=${pidfile.pid} 已退出` : "（pidfile 缺失，进程退出未校验）";
        return { ok: true, message: `已停止（POST /shutdown 优雅停机，端口 ${port} 已释放${note}）` };
      }
      info(
        `优雅停机未达标（${stopTimeoutMs}ms）：端口 ${port} ${converged.released ? "已释放" : "仍占用"}${
          converged.exited === false ? `，pid=${pidfile?.pid} 仍存活` : ""
        } ⇒ 转入强杀兜底 …`,
      );
    }

    if (pidfile === null) {
      return {
        ok: false,
        message: `端口 ${port} 被占用，但 pidfile 缺失（${deps.pidfile}），无法定位进程，未执行强杀`,
      };
    }
    if (!deps.isPidAlive(pidfile.pid)) {
      return {
        ok: false,
        message: `pidfile 陈旧（pid=${pidfile.pid} 已不存在），端口 ${port} 仍被占用，无法定位进程，未执行强杀`,
      };
    }
    const killed = kill(pidfile.pid);
    if (!killed.ok) return { ok: false, message: killed.reason };
    const converged = await waitStopConverged(port, host, pidfile.pid, stopTimeoutMs, deps);
    if (converged.released && converged.exited !== false) {
      removePidfile(deps.pidfile);
      return { ok: true, message: `已停止（强杀 pid=${pidfile.pid}，端口 ${port} 已释放、进程已退出）` };
    }
    return {
      ok: false,
      message: `停止超时：端口 ${port} ${converged.released ? "已释放" : "仍被占用"}，pid=${pidfile.pid} ${
        converged.exited === false ? "仍存活" : "状态未知"
      }（pidfile 已保留 ${deps.pidfile}）`,
    };
  }

  // 端口未监听
  if (pidfile === null) {
    return { ok: true, message: `未运行（端口 ${port} 未监听）` };
  }
  if (!deps.isPidAlive(pidfile.pid)) {
    removePidfile(deps.pidfile);
    return { ok: true, message: `未运行（端口 ${port} 未监听）；已清理陈旧 pidfile` };
  }
  return {
    ok: false,
    message: `端口 ${port} 未监听，但 pidfile 指向的 pid=${pidfile.pid} 仍存活（可能正在启动或已 wedge）；未强杀、保留 pidfile`,
  };
}

// ---------------------------------------------------------------------------
// Windows 脱壳（照蓝本：WMI Win32_Process.Create + -EncodedCommand）
// ---------------------------------------------------------------------------

function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * 脱壳壳脚本：隐藏窗口拉起板服务，stdout/stderr **追加合并**落 board.log
 * （Start-Process 不允许两流同文件 ⇒ 经 cmd /c … >> log 2>&1）。
 * **只透传配置路径**：`BOARD_CONFIG` 有就带、没有就不设（板按仓内缺省读，脚本不解析内容）。
 */
function buildDetachShellScript(paths) {
  const inner = `/c ""${process.execPath}" "${paths.entry}" >> "${paths.logPath}" 2>&1"`;
  const lines = [
    "$shell = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }",
  ];
  if (process.env["BOARD_CONFIG"] !== undefined) {
    lines.push(`$env:BOARD_CONFIG = ${psQuote(process.env["BOARD_CONFIG"])}`);
  }
  lines.push(
    `Start-Process -FilePath $shell -ArgumentList ${psQuote(inner)} -WorkingDirectory ${psQuote(
      paths.root,
    )} -WindowStyle Hidden`,
  );
  return lines.join("\n");
}

function launchDetachedWindows(paths) {
  const shellCmd = `powershell -NoProfile -WindowStyle Hidden -EncodedCommand ${encodePowerShell(
    buildDetachShellScript(paths),
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
      .filter((l) => l.trim() !== "");
    const detail = lines.length > 0 ? `：${lines[lines.length - 1]}` : "";
    return { kind: "failed", reason: `WMI Create 退出码 ${result.status}${detail}` };
  }
  return { kind: "detached" };
}

/** 兜底/POSIX：spawn(detached) + unref，stdio 指向日志 fd（调用方可正常拿到 EOF） */
function spawnDetached(paths) {
  const logFd = openSync(paths.logPath, "a");
  let child;
  try {
    child = spawn(process.execPath, [paths.entry], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      cwd: paths.root,
    });
  } catch (err) {
    closeSync(logFd);
    return { kind: "spawn-failed", reason: err instanceof Error ? err.message : String(err) };
  }
  closeSync(logFd);
  child.once("error", (err) => {
    console.error(`[boardctl] 子进程启动失败：${err instanceof Error ? err.message : String(err)}`);
  });
  child.unref();
  return { kind: "spawn", child };
}

/** 拉起：Windows 先试 WMI 脱壳，不可用 ⇒ 显式降级 spawn(detached) 并 stdout 警告（不静默） */
export function launchBoard(paths, platform = process.platform) {
  if (platform !== "win32") return spawnDetached(paths);
  const detached = launchDetachedWindows(paths);
  if (detached.kind === "detached") return { kind: "detached" };
  warn(
    `Windows 脱壳拉起不可用（${detached.reason}）⇒ 降级为 spawn(detached)；**调用方（宿主工具）可能被拖住**（常驻板服务仍在其作业 / 进程树内）。`,
  );
  return spawnDetached(paths);
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

/** 取文本尾部 count 行（忽略结尾空行） */
export function lastLines(text, count) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

async function followLog(path) {
  let size = statSync(path).size;
  for (;;) {
    await delay(FOLLOW_INTERVAL_MS);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.size < size) size = 0; // 截断 / 轮转
    if (stat.size === size) continue;
    const fd = openSync(path, "r");
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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parsePositiveInt(value, name) {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) <= 0) {
    fail(`${name} 需要一个正整数`);
  }
  return Number(value);
}

function parseArgs(argv) {
  const flags = { lines: undefined, follow: false, help: false, noWait: false, waitReady: false, readyTimeout: undefined };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--follow" || arg === "-f") flags.follow = true;
    else if (arg === "--lines" || arg === "-n") {
      i += 1;
      flags.lines = parsePositiveInt(argv[i], "--lines");
    } else if (arg.startsWith("--lines=")) flags.lines = parsePositiveInt(arg.slice("--lines=".length), "--lines");
    else if (arg === "--no-wait") flags.noWait = true;
    else if (arg === "--wait-ready") flags.waitReady = true;
    else if (arg === "--ready-timeout") {
      i += 1;
      flags.readyTimeout = parsePositiveInt(argv[i], "--ready-timeout");
    } else if (arg.startsWith("--ready-timeout=")) {
      flags.readyTimeout = parsePositiveInt(arg.slice("--ready-timeout=".length), "--ready-timeout");
    } else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg.startsWith("-")) fail(`未知选项：${arg}`);
    else positionals.push(arg);
  }
  if (flags.noWait && flags.waitReady) {
    fail("--no-wait 与 --wait-ready 不能同时使用（前者发起即返，后者等待 /health status=ok）");
  }
  if (flags.readyTimeout !== undefined && !flags.waitReady) {
    fail("--ready-timeout 仅在 --wait-ready 下有效");
  }
  return { command: positionals[0], flags };
}

function printUsage() {
  console.log(`boardctl — board 板服务跨平台启停脚本（board 单元 · BD13″）

用法：
  node scripts/boardctl.mjs <command> [options]

命令：
  start     后台启动板服务（Windows 经 WMI 脱壳、POSIX detached + unref；已在运行提示并 exit 0；
            端口被非本板占用 exit 1；缺省等待 /health 200+status=ok 后返回）
  stop      停止板服务（优先 POST /shutdown 优雅停机——仅 loopback；超时/不可达兜底强杀；
            收口判据 = 端口释放 ∧ 进程退出，达标才清 pidfile）
  restart   停止后重新后台拉起（--no-wait 仅 start 段：stop 段仍阻塞，非瞬时）
  status    三态（运行中 / pidfile 陈旧 / 未运行）；判定键 = /health 的 status，不以端口可连为准
  logs      输出日志（board/.a2a/logs/board.log，行级 [ISO时间] [tag] 前缀）

选项（start / restart）：
  --no-wait         发起即返（exit 0 = 已发起 ≠ 就绪）
  --wait-ready      显式等待 /health status=ok（与缺省同判据；板无自检阶段，缺省本就等 ok）
  --ready-timeout <ms>  --wait-ready 的等待上限（缺省 ${READY_TIMEOUT_MS}）
选项（logs）：
  -n, --lines <N>   仅输出尾部 N 行
  -f, --follow      持续跟踪新增
  -h, --help        显示帮助

配置（BD12″ 口径）：
  本脚本**不解析配置内容** —— 只把 env BOARD_CONFIG（配置文件**路径**）原样透传给板进程；
  缺省配置文件 = <board>/config/config.json（默认值参照 config.json.default · 可运行示例 config.json.example）。
  pidfile  ${PIDFILE_PATH}（板自己写，本脚本只读）
  日志     ${LOG_PATH}
  致命日志 ${FATAL_LOG_PATH}（板死在 logger 之前时唯一的取证面；start 失败会连它一起打尾部）
  入口     ${ENTRY}（缺失请先 npm run build）

退出卫生：退出码恒 {0,1}；主流程不设 process.exit（改 process.exitCode，事件循环自然排空，
治 Windows 退出期退出码污染）。`);
}

function buildDeps(paths) {
  return {
    ...paths,
    probePort,
    httpHealth,
    httpRequestText,
    readPidfile: () => readPidfile(paths.pidfile),
    existsEntry: () => existsSync(paths.entry),
    mkdirLogDir: () => mkdirSync(paths.logDir, { recursive: true }),
    launch: () => launchBoard(paths),
    isPidAlive,
    platform: process.platform,
  };
}

async function cmdStart(flags, deps) {
  const result = await doStart(flags, deps);
  switch (result.kind) {
    case "occupied": {
      console.error(
        `[boardctl] 端口 ${formatHost(result.host)}:${result.port} 被占用（非运行中的本板）：${result.reason}；` +
          "已中止 start（exit 1、未拉起板服务）。请先释放该端口或改配置 port。",
      );
      process.exitCode = 1;
      return;
    }
    case "already": {
      info(`已在运行：${formatHost(result.host)}:${result.port}（health=ok${result.pid !== undefined ? `，pid=${result.pid}` : ""}）；exit 0`);
      process.exitCode = 0;
      return;
    }
    case "spawn-failed": {
      console.error(`[boardctl] 启动失败：${result.reason}`);
      process.exitCode = 1;
      return;
    }
    case "spawned": {
      info(`已发起启动（--no-wait：发起即返，exit 0 = 已发起 ≠ 就绪）；日志：${deps.logPath}`);
      info("pid 仅供参考，请另起 `npm run status` 确认运行态。");
      process.exitCode = 0;
      return;
    }
    case "started": {
      info(
        `已后台启动并运行中：${formatHost(result.host)}:${result.port}（health=ok${
          result.pid !== undefined ? `，pid=${result.pid}` : "，pid 未知（pidfile 未就位）"
        }），日志：${deps.logPath}`,
      );
      process.exitCode = 0;
      return;
    }
    case "start-timeout": {
      console.error(
        `[boardctl] 启动超时（${flags.readyTimeout ?? READY_TIMEOUT_MS}ms）：/health 未达 200+status=ok（pid=${
          result.pid ?? "未知"
        }）；判为「启动失败」。` +
          `板若在 logger 就绪前就崩，board.log 会一片空白 —— 崩溃堆栈另看 ${deps.fatalLogPath ?? FATAL_LOG_PATH}。`,
      );
      printLogTail(deps, 30);
      process.exitCode = 1;
      return;
    }
    default: {
      console.error(`[boardctl] 未知启动结果：${String(result.kind)}`);
      process.exitCode = 1;
    }
  }
}

function printLogTail(deps, count) {
  if (!existsSync(deps.logPath)) {
    console.error(`[boardctl] 日志不存在：${deps.logPath}`);
    if (!printFatalTail(deps, count)) {
      console.error(
        `[boardctl] 启动期致命日志也不存在：${deps.fatalLogPath ?? "(未注入 fatalLogPath)"} —— 两文件皆空 = 板进程根本没被拉起`,
      );
    }
    return;
  }
  console.error(`[boardctl] 日志尾部 ${count} 行（${deps.logPath}）：`);
  const tail = lastLines(readFileSync(deps.logPath, "utf8"), count);
  console.error(tail === "" ? "（空文件 —— 板死在 logger 之前时就是这副样子，看下面）" : tail);
  printFatalTail(deps, count);
}

/**
 * 启动失败取证面（BD19 · 缺陷②）：崩在 logger 就绪之前 ⇒ `board.log` 可能一行都没有，
 * 堆栈只落在板 bootstrap 同步写的 `board.fatal.log`。文件不存在 ⇒ 什么都不打
 * （多数失败没有致命崩溃，勿造噪音）；`deps.fatalLogPath` 未注入（老调用方/假 deps）⇒ 同样静默跳过。
 * 返回是否打印过，供调用方在文案里区分「有第二现场」。
 */
export function printFatalTail(deps, count) {
  const path = deps.fatalLogPath;
  if (typeof path !== "string" || path === "" || !existsSync(path)) return false;
  console.error(`[boardctl] 启动期致命日志尾部 ${count} 行（${path}）：`);
  console.error(lastLines(readFileSync(path, "utf8"), count));
  return true;
}

async function cmdStop(deps) {
  const result = await doStop(deps);
  if (result.ok) {
    info(result.message);
    process.exitCode = 0;
    return;
  }
  console.error(`[boardctl] ${result.message}`);
  console.error(`[boardctl] 可手动排查：pidfile=${deps.pidfile}`);
  process.exitCode = 1;
}

async function cmdRestart(flags, deps) {
  info(
    `restart 先执行 stop（阻塞，非瞬时：POST /shutdown ≤${SHUTDOWN_TIMEOUT_MS / 1000}s + 收敛等待 ≤${
      STOP_TIMEOUT_MS / 1000
    }s，兜底强杀再 ≤${STOP_TIMEOUT_MS / 1000}s）…`,
  );
  const stop = await doStop(deps);
  if (!stop.ok) {
    console.error(`[boardctl] restart 中止（停止失败）：${stop.message}`);
    process.exitCode = 1;
    return;
  }
  info(stop.message);
  await cmdStart(flags, deps);
}

async function cmdStatus(deps) {
  const pidfile = deps.readPidfile();
  const { host, port } = resolveProbeEndpoint(pidfile);
  const listening = await deps.probePort(port, host);
  const health = listening ? await deps.httpHealth(host, port) : null;
  const state = classifyStatus({ listening, health, pidfile });
  const pidAlive = pidfile !== null && deps.isPidAlive(pidfile.pid);

  const labels = {
    running: "运行中",
    occupied: "端口被占用（可连但 /health 非 ok，非运行中的本板）",
    stale: "pidfile 陈旧（有文件但端口未监听）",
    stopped: "未运行",
  };
  info(`状态     : ${labels[state]}`);
  info(
    `pid      : ${
      pidfile !== null ? `${pidfile.pid}${pidAlive ? "" : "（已不存在）"}` : listening ? "未知（pidfile 缺失）" : "-"
    }`,
  );
  info(`endpoint : ${formatHost(host)}:${port}`);
  info(
    `health   : ${
      health !== null
        ? `${health.status ?? "(缺失)"}${health.version !== undefined ? ` version=${health.version}` : ""}`
        : "不可达"
    }`,
  );
  info(`startedAt: ${pidfile?.startedAt ?? "-"}`);
  info(`pidfile  : ${deps.pidfile}${existsSync(deps.pidfile) ? "" : "（不存在）"}`);
  info(`log      : ${deps.logPath}`);
  // 退出码：运行中 / 未运行 = 0；占用异常 / pidfile 陈旧 = 1（提示需处置）
  process.exitCode = state === "running" || state === "stopped" ? 0 : 1;
}

async function cmdLogs(flags, deps) {
  if (!existsSync(deps.logPath)) {
    console.error(`[boardctl] 日志不存在：${deps.logPath}（板服务从未后台起过？用 start 拉起后再看）`);
    process.exitCode = 1;
    return;
  }
  const content = readFileSync(deps.logPath, "utf8");
  const output = flags.lines === undefined ? content : lastLines(content, flags.lines);
  process.stdout.write(output.endsWith("\n") || output.length === 0 ? output : `${output}\n`);
  if (flags.follow) await followLog(deps.logPath);
  process.exitCode = 0;
}

export async function main(argv, paths = defaultPaths()) {
  try {
    const { command, flags } = parseArgs(argv);
    if (flags.help || command === "help" || command === undefined) {
      printUsage();
      // 显式求助（-h / --help / help）⇒ 0；**什么参数都没给** ⇒ 1（未执行任何命令，不算成功）
      process.exitCode = flags.help || command === "help" ? 0 : 1;
      return;
    }
    const startOnly = flags.noWait || flags.waitReady || flags.readyTimeout !== undefined;
    if (startOnly && command !== "start" && command !== "restart") {
      fail(`--no-wait / --wait-ready / --ready-timeout 仅适用于 start / restart（当前命令：${command}）`);
    }
    const deps = buildDeps(paths);
    switch (command) {
      case "start":
        await cmdStart(flags, deps);
        break;
      case "stop":
        await cmdStop(deps);
        break;
      case "restart":
        await cmdRestart(flags, deps);
        break;
      case "status":
        await cmdStatus(deps);
        break;
      case "logs":
        await cmdLogs(flags, deps);
        break;
      default:
        fail(`未知子命令：${command}（运行 node scripts/boardctl.mjs --help 查看用法）`);
    }
  } catch (err) {
    if (err instanceof CliExit) {
      process.exitCode = err.code;
      return;
    }
    console.error(`[boardctl] 未预期错误：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  }
}

/** 被 import 时零副作用（单测直接驱动导出函数）；仅直跑才进 CLI */
function isEntryModule() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  const target = resolve(entry);
  return process.platform === "win32" ? self.toLowerCase() === target.toLowerCase() : self === target;
}

if (isEntryModule()) {
  await main(process.argv.slice(2));
}
