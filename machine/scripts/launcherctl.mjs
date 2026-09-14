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

/** start 等待 /health 可达的超时（端口在自检前即监听，通常毫秒级） */
const READY_TIMEOUT_MS = 30_000;
/** stop 等待端口释放的超时 */
const STOP_TIMEOUT_MS = 15_000;
/** 单次 TCP 探测超时 / 轮询间隔 */
const PROBE_TIMEOUT_MS = 1_000;
const PROBE_INTERVAL_MS = 200;
/** logs --follow 轮询间隔 */
const FOLLOW_INTERVAL_MS = 300;

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

/** 读取机器配置里脚本关心的字段（端口 / 绑定地址 / 可选优雅停止端点） */
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
  return {
    path: CONFIG_PATH,
    port: launcher.port,
    listenHost: typeof launcher.listenHost === "string" ? launcher.listenHost : undefined,
    shutdownEndpoint: launcher.shutdownEndpoint === true,
    shutdownToken: typeof launcher.shutdownToken === "string" ? launcher.shutdownToken : undefined,
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

/** 轮询 /health 至可达或超时 */
async function waitForHealth(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await httpHealth(host, port);
    if (health !== null) return health;
    if (Date.now() >= deadline) return null;
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

/** 后台启动（幂等：端口已监听即视为已在运行）。不退出，返回结果供调用方决定输出 / 退出码。 */
async function doStart(config) {
  const host = resolveProbeHost(config, readPidfile());

  if (await probePort(config.port, host)) {
    const health = await httpHealth(host, config.port);
    return { ok: true, already: true, host, port: config.port, health, pid: undefined };
  }

  ensureBuilt();
  mkdirSync(LOG_DIR, { recursive: true });

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
  } finally {
    closeSync(logFd);
  }

  child.once("error", (err) => {
    console.error(
      `[launcherctl] 子进程启动失败：${err instanceof Error ? err.message : String(err)}`,
    );
  });
  child.unref();

  const health = await waitForHealth(host, config.port, READY_TIMEOUT_MS);
  if (health === null) {
    return { ok: false, already: false, host, port: config.port, health: null, pid: child.pid };
  }
  return { ok: true, already: false, host, port: config.port, health, pid: child.pid };
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
  const flags = { lines: undefined, follow: false, help: false };
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
  console.log(`launcherctl — Launcher 跨平台启停脚本（machine 单元）

用法：
  node scripts/launcherctl.mjs <command> [options]

命令：
  start     后台启动 Launcher（已在运行则提示并退出 0）
  stop      停止 Launcher（POSIX 发 SIGTERM；Windows taskkill /T /F 强制树杀）
  restart   停止后重新后台拉起
  status    查看运行态（pid / host:port / health / startedAt）
  logs      输出日志文件（--lines N 取尾部；--follow 跟踪）

选项（logs）：
  -n, --lines <N>   仅输出尾部 N 行
  -f, --follow      持续跟踪新增日志（默认关闭）
  -h, --help        显示帮助

配置：
  MACHINE_CONFIG  机器配置文件路径（缺省 ${join(MACHINE_ROOT, "config", "config.json")}）
  pidfile         ${PIDFILE_PATH}
  log             ${LOG_PATH}`);
}

async function cmdStart() {
  const config = loadConfig();
  const result = await doStart(config);

  if (!result.ok) {
    console.error(
      `[launcherctl] 启动超时（${READY_TIMEOUT_MS}ms）：${formatHost(result.host)}:${result.port} /health 不可达（pid=${result.pid}）`,
    );
    printLogTail(30);
    process.exit(1);
  }
  if (result.already) {
    const suffix = result.health?.status ? `（health=${result.health.status}）` : "";
    info(`已在运行：${formatHost(result.host)}:${result.port}${suffix}`);
    process.exit(0);
  }
  const note = result.health?.status === "starting" ? "（自检进行中，业务路由暂 503）" : "";
  info(
    `已后台启动 pid=${result.pid}，health=${result.health?.status ?? "ok"}${note}，日志：${LOG_PATH}`,
  );
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

async function cmdRestart() {
  const config = loadConfig();
  const result = await doStop(config);
  if (!result.ok) {
    console.error(`[launcherctl] restart 中止（停止失败）：${result.message}`);
    process.exit(1);
  }
  info(result.message);
  await cmdStart();
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
  switch (command) {
    case "start":
      await cmdStart();
      break;
    case "stop":
      await cmdStop();
      break;
    case "restart":
      await cmdRestart();
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
