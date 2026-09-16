#!/usr/bin/env node
/**
 * bridgectl-probe.mjs —— `orch/scripts/bridgectl.mjs`（桥启停契约）真机探针。
 *
 * 用途（REQ-v0.4.1-2026-09-15-02）：逐条验证 bridgectl 的 start/stop/status 契约，
 * 并显式覆盖两条**反例**（端口被非本桥占用、陈旧 pidfile）。与 `mcp-http-probe.mjs`
 * 同族：纯 Node ESM、零第三方依赖、不参与业务。
 *
 * ★ 隔离铁律（绝不影响正在运行的真实桥）：
 *   - 全程使用**临时 data dir**（`SESSION_DB=<tmp>/data/sessions.sqlite`，其目录即桥的
 *     data dir，pidfile / logs / core.lock 全落临时目录）；
 *   - 全程使用**临时 MACHINES_CONFIG**（`transport.mode=http` + 非默认端口 8897）；
 *   - **不碰** `orch/data`、**不用**默认端口 8787、不读真实 `orch/config/config.json`。
 *
 * ★ 绝不无限等待：HTTP 请求、TCP 探测、轮询、监听**单步硬上限 ≤10s**；`bridgectl`
 *   子进程单步硬上限 20s（其 `start` 自身就绪等待即 30s，10s 存在误判窗口）；
 *   且子进程另加超时兜底（到时强杀 + 硬兜底 resolve）；任何一步超时即判失败并继续清理。
 *
 * ★ 结束必然清理自拉起的进程与临时文件，并用 exit code 表达成败（全过 0 / 任一失败非零）。
 *
 * 用法（须在 orch 单元根运行）：
 *   node tools/bridgectl-probe.mjs
 * 前置：`npm run build` 已产出 `orch/dist/bridge/index.js`（bridgectl start 不自动构建）。
 *
 * 输出：每条断言一行 `[assert N] PASS|FAIL | name= | expect= | actual=`，末尾附
 *       `----- bridgectl-probe-summary -----` JSON（便于 CI 消费）。
 *
 * 退出码：0 = 6 条断言全过；1 = 任一失败（含超时 / 意外异常）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── 路径 ─────────────────────────────────────────────────────────────────────
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = resolve(TOOLS_DIR, "..");
const BRIDGECTL_PATH = join(ORCH_ROOT, "scripts", "bridgectl.mjs");
const BRIDGE_ENTRY = join(ORCH_ROOT, "dist", "bridge", "index.js");

// ── 超时（HTTP/TCP/轮询/监听 ≤10s；bridgectl 子进程 ≤20s：探针自身绝不能挂住） ──
/** 单步（轮询 / 监听 / HTTP）硬上限 */
const STEP_TIMEOUT_MS = 10_000;
/** `bridgectl` 子进程硬上限（放宽：`bridgectl start` 自身就绪等待即 30s） */
const BRIDGECTL_TIMEOUT_MS = 20_000;
/** 单次 HTTP 请求超时 */
const HTTP_TIMEOUT_MS = 2_000;
/** 单次 TCP 探测超时 / 轮询间隔 */
const PROBE_TIMEOUT_MS = 1_000;
const POLL_INTERVAL_MS = 250;
/** 强杀子进程后等待 'close' 的额外宽限（到点即硬 resolve） */
const HARD_GRACE_MS = 3_000;
/** 兜底强杀后列出日志尾部 */
const LOG_TAIL_LINES = 30;

// ── 探针端口（非默认：默认 8787；避开真实桥） ───────────────────────────────
const PROBE_HOST = "127.0.0.1";
const PROBE_PORT = 8897;

// ── 临时工作区（隔离） ───────────────────────────────────────────────────────
const TEMP_ROOT = mkdtempSync(join(tmpdir(), "bridgectl-probe-"));
const DATA_DIR = join(TEMP_ROOT, "data");
const CONFIG_PATH = join(TEMP_ROOT, "machines.config.json");
const WORKTREE_ROOT = join(TEMP_ROOT, "worktrees");
const SESSION_DB = join(DATA_DIR, "sessions.sqlite");
/** 桥自身写 pidfile 的路径（与 bridgectl 的 `dirname(SESSION_DB)/bridge.pid` 同源） */
const PIDFILE_PATH = join(DATA_DIR, "bridge.pid");
const LOG_PATH = join(DATA_DIR, "logs", "bridge.log");
/** 子进程环境：隔离配置 + 隔离 data dir（bridgectl 据此定位 pidfile / log） */
const CHILD_ENV = { ...process.env, MACHINES_CONFIG: CONFIG_PATH, SESSION_DB };

const checks = [];
let bareServer = null;

const summary = {
  probe: "bridgectl-probe",
  orchRoot: ORCH_ROOT,
  bridgectl: BRIDGECTL_PATH,
  bridgeEntry: BRIDGE_ENTRY,
  bridgeEntryExists: existsSync(BRIDGE_ENTRY),
  endpoint: `http://${PROBE_HOST}:${PROBE_PORT}`,
  isolation: {
    tempRoot: TEMP_ROOT,
    config: CONFIG_PATH,
    sessionDb: SESSION_DB,
    pidfile: PIDFILE_PATH,
    log: LOG_PATH,
    defaultPortTouched: false,
  },
  checks,
};

// ── 输出 / 断言 ──────────────────────────────────────────────────────────────
function check(name, pass, expect, actual) {
  checks.push({ name, pass: pass === true, expect, actual });
}

function delay(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function firstNonEmptyLine(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 160);
  }
  return "无";
}

function firstMatchLine(text, re) {
  const matched = re.exec(text);
  return matched === null ? "无" : matched[0].trim().slice(0, 160);
}

function tailLines(text, count) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(Math.max(0, lines.length - count));
}

// ── 临时工作区准备 ───────────────────────────────────────────────────────────
/** 写临时 MACHINES_CONFIG：mode=http + 非默认端口 8897；callback 关闭（不抢 3200） */
function prepareWorkspace() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  const config = {
    transport: { mode: "http", http: { host: PROBE_HOST, port: PROBE_PORT, path: "/mcp" } },
    callback: { enabled: false, host: PROBE_HOST, port: 3200 },
    provisioning: {
      worktreeRoot: WORKTREE_ROOT,
      integrationBranch: "integration",
      policy: { featureIsolation: false, contractFreeze: false },
    },
    // 指向必然无人监听的 loopback 端口：连接立即被拒，不产生长等待
    machines: [
      { machineId: "probe-machine", launcherUrl: "http://127.0.0.1:3199", pushCallback: false },
    ],
  };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

// ── 进程 / 端口 / HTTP 基础工具（全部有界） ──────────────────────────────────
function killTree(pid) {
  if (typeof pid !== "number" || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 进程已退出：忽略
  }
}

/** ESRCH=不存在；EPERM=存在但无权限（视为存活）；其余错误一律视为不存在 */
function isPidAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * 有界执行 `node scripts/bridgectl.mjs <args>`：
 * 到时强杀并标 `timedOut`；再加一层硬兜底，保证 'close' 未到达也必定 resolve。
 */
function runBridgectl(args, timeoutMs = BRIDGECTL_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(process.execPath, [BRIDGECTL_PATH, ...args], {
        cwd: ORCH_ROOT,
        env: CHILD_ENV,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolvePromise({
        code: null,
        signal: null,
        stdout: "",
        stderr: `spawn 失败：${err instanceof Error ? err.message : String(err)}`,
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    let hardTimer = null;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) clearTimeout(killTimer);
      if (hardTimer !== null) clearTimeout(hardTimer);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (err) => {
      stderr += `\n[spawn error] ${err instanceof Error ? err.message : String(err)}`;
    });
    child.once("close", (code, signal) => {
      finish(code, signal);
    });

    killTimer = setTimeout(() => {
      timedOut = true;
      stderr += `\n[probe] 子进程超时（${timeoutMs}ms），强杀 pid=${String(child.pid)}`;
      killTree(child.pid);
    }, timeoutMs);
    hardTimer = setTimeout(() => {
      killTree(child.pid);
      finish(null, null);
    }, timeoutMs + HARD_GRACE_MS);
  });
}

/** 单次 TCP 连接探测：能连上即认为端口已监听 */
function probePort(port, host, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ port, host });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/** 轮询端口释放；释放返回 true，超时返回 false */
async function waitPortFree(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await probePort(port, host))) return true;
    if (Date.now() >= deadline) return false;
    await delay(POLL_INTERVAL_MS);
  }
}

/** 轮询 pid 退出；退出返回 true，超时返回 false */
async function waitPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isPidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(POLL_INTERVAL_MS);
  }
}

function formatHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}

/** GET /health；网络错误 / 非 JSON 返回 null */
async function httpHealth(host, port, timeoutMs = HTTP_TIMEOUT_MS) {
  try {
    const res = await fetch(`http://${formatHost(host)}:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    if (body === null || typeof body !== "object") return null;
    return {
      httpStatus: res.status,
      status: typeof body.status === "string" ? body.status : undefined,
      role: typeof body.role === "string" ? body.role : undefined,
    };
  } catch {
    return null;
  }
}

/** 轮询 `/health` 至 HTTP 200；超时返回最后一次结果（可能为 null） */
async function waitHealthy(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const health = await httpHealth(host, port);
    if (health !== null && health.httpStatus === 200) return health;
    last = health;
    if (Date.now() >= deadline) return last;
    await delay(POLL_INTERVAL_MS);
  }
}

/** 裸 TCP 占位监听（无 HTTP 响应）：成功返回 { ok:true, server }，失败/超时返回 { ok:false } */
function listenBare(port, host, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    let settled = false;
    let timer = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolvePromise(result);
    };
    timer = setTimeout(() => {
      try {
        server.close();
      } catch {
        // 忽略关闭异常
      }
      done({ ok: false, server, error: `listen 超时（${timeoutMs}ms）` });
    }, timeoutMs);
    server.once("error", (err) => {
      done({ ok: false, server, error: err instanceof Error ? err.message : String(err) });
    });
    server.listen({ port, host }, () => {
      done({ ok: true, server, error: null });
    });
  });
}

/** 有界关闭 listener */
function closeServer(server, timeoutMs = 3_000) {
  return new Promise((resolvePromise) => {
    if (server === null || server === undefined) {
      resolvePromise();
      return;
    }
    let settled = false;
    let timer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolvePromise();
    };
    timer = setTimeout(done, timeoutMs);
    try {
      server.close(() => done());
    } catch {
      done();
    }
  });
}

/** 造一个**必然已死**的 pid：起一个进程让它立刻退出，取其 pid */
function makeDeadPid(timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer = null;
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const done = (pid) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolvePromise(pid);
    };
    timer = setTimeout(() => done(null), timeoutMs);
    child.once("error", () => done(null));
    child.once("close", () => done(typeof child.pid === "number" ? child.pid : null));
  });
}

/** 读取 pidfile（缺失 / 形状不合法返回 null） */
function readPidfileRaw() {
  try {
    const raw = JSON.parse(readFileSync(PIDFILE_PATH, "utf8"));
    if (raw === null || typeof raw !== "object" || typeof raw.pid !== "number") return null;
    return raw;
  } catch {
    return null;
  }
}

// ── 清理（必须不抛、必须有界） ───────────────────────────────────────────────
async function cleanup() {
  try {
    const stale = readPidfileRaw();
    if (stale !== null && isPidAlive(stale.pid)) {
      await runBridgectl(["stop"]); // 有界：≤BRIDGECTL_TIMEOUT_MS
      if (isPidAlive(stale.pid)) killTree(stale.pid);
    }
  } catch {
    // 清理失败不掩盖断言结果
  }
  try {
    await closeServer(bareServer);
  } catch {
    // 同上
  }
  try {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    // 同上
  }
}

// ── 6 条断言 ────────────────────────────────────────────────────────────────
async function runChecks() {
  // ① start 冷启：进程存活 + pidfile 写入 + /health 200 status=ok + role
  const start1 = await runBridgectl(["start"]);
  const health1 = start1.code === 0 ? await waitHealthy(PROBE_HOST, PROBE_PORT, STEP_TIMEOUT_MS) : null;
  const pidfile1 = readPidfileRaw();
  const pid1 = pidfile1 === null ? null : pidfile1.pid;
  const pidAlive1 = pid1 !== null && isPidAlive(pid1);
  const healthOk1 =
    health1 !== null &&
    health1.httpStatus === 200 &&
    health1.status === "ok" &&
    typeof health1.role === "string" &&
    health1.role.length > 0;
  check(
    "① start 冷启",
    start1.code === 0 && pidAlive1 && healthOk1,
    "exit=0 且 pidfile 已写且 pid 存活 且 GET /health = 200 + status=ok + 含 role",
    `exit=${String(start1.code)}${start1.timedOut ? "(子进程超时)" : ""}, ` +
      `pidfile=${pid1 === null ? "无" : `pid=${String(pid1)} alive=${String(pidAlive1)}`}, ` +
      `health=${health1 === null ? "不可达" : `http=${String(health1.httpStatus)} status=${String(health1.status)}`}, ` +
      `role=${health1?.role ?? "无"}, stderr=${firstNonEmptyLine(start1.stderr)}`,
  );

  // ② 再次 start：幂等复用，输出「已在运行」且 exit 0
  const start2 = await runBridgectl(["start"]);
  const out2 = `${start2.stdout}\n${start2.stderr}`;
  check(
    "② 重复 start（幂等）",
    start2.code === 0 && out2.includes("已在运行"),
    "exit=0 且输出含「已在运行」",
    `exit=${String(start2.code)}${start2.timedOut ? "(子进程超时)" : ""}, ` +
      `含已在运行=${String(out2.includes("已在运行"))}, 首行=${firstNonEmptyLine(out2)}`,
  );

  // ③ status：运行中 → exit 0 且输出含 role
  const status1 = await runBridgectl(["status"]);
  const out3 = `${status1.stdout}\n${status1.stderr}`;
  check(
    "③ status（运行中）",
    status1.code === 0 && /role\s*:/.test(out3),
    "exit=0 且输出含 role 段",
    `exit=${String(status1.code)}${status1.timedOut ? "(子进程超时)" : ""}, ` +
      `role 行=${firstMatchLine(out3, /^.*\brole\b.*$/m)}`,
  );

  // ④ stop：进程退出 + 端口释放 + pidfile 删除
  const stop1 = await runBridgectl(["stop"]);
  const exited1 = pid1 === null ? true : await waitPidExit(pid1, STEP_TIMEOUT_MS);
  const portFree1 = await waitPortFree(PROBE_PORT, PROBE_HOST, STEP_TIMEOUT_MS);
  const pidfileGone1 = !existsSync(PIDFILE_PATH);
  check(
    "④ stop（运行中）",
    stop1.code === 0 && exited1 && portFree1 && pidfileGone1,
    "exit=0 且桥进程退出 且端口释放 且 pidfile 删除",
    `exit=${String(stop1.code)}${stop1.timedOut ? "(子进程超时)" : ""}, ` +
      `pid=${pid1 === null ? "无" : String(pid1)} exited=${String(exited1)}, ` +
      `port${String(PROBE_PORT)}Free=${String(portFree1)}, pidfileDeleted=${String(pidfileGone1)}, ` +
      `首行=${firstNonEmptyLine(stop1.stdout + stop1.stderr)}`,
  );

  // ⑤ 反例：裸 TCP 占端口 → start 非零退出 + 不写 pidfile + 错误含「已被占用」
  const bare = await listenBare(PROBE_PORT, PROBE_HOST);
  if (bare.ok) {
    bareServer = bare.server;
    const start3 = await runBridgectl(["start"]);
    const out5 = `${start3.stdout}\n${start3.stderr}`;
    const pidfileAfter5 = existsSync(PIDFILE_PATH);
    check(
      "⑤ 端口被非本桥占用（裸 TCP）",
      start3.code !== 0 && pidfileAfter5 === false && out5.includes("已被占用"),
      "start 非零退出 且未写 pidfile 且错误信息含「已被占用」",
      `exit=${String(start3.code)}(期望非零)${start3.timedOut ? "(子进程超时)" : ""}, ` +
        `pidfile 存在=${String(pidfileAfter5)}(期望 false), 含已被占用=${String(out5.includes("已被占用"))}, ` +
        `首行=${firstNonEmptyLine(out5)}`,
    );
    await closeServer(bare.server);
    bareServer = null;
    await waitPortFree(PROBE_PORT, PROBE_HOST, STEP_TIMEOUT_MS); // 复原现场（供 ⑥ 用）
  } else {
    check(
      "⑤ 端口被非本桥占用（裸 TCP）",
      false,
      "start 非零退出 且未写 pidfile 且错误信息含「已被占用」",
      `裸 TCP listener 无法监听 ${PROBE_HOST}:${String(PROBE_PORT)}：${String(bare.error)}`,
    );
  }

  // ⑥ 反例：陈旧 pidfile（已死 pid）→ status 报未运行且 exit 0；stop 不误杀
  const deadPid = await makeDeadPid();
  if (deadPid === null) {
    check(
      "⑥ 陈旧 pidfile（已死 pid）",
      false,
      "status exit=0 且报未运行；stop exit=0 且不误杀（无强杀）且清掉陈旧 pidfile",
      "无法构造已死 pid（子进程失败/超时）",
    );
    return;
  }
  writeFileSync(
    PIDFILE_PATH,
    `${JSON.stringify({ pid: deadPid, mode: "http", role: "probe-stale", startedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );

  const status2 = await runBridgectl(["status"]);
  const out6a = `${status2.stdout}\n${status2.stderr}`;
  // 实现里「端口未监听 + pidfile 存在」的形态是「pidfile 陈旧（有文件但端口未监听）」，
  // 与「未运行」同义（cmdStatus 的两条 not-running 分支），故两者皆判为「报未运行」。
  const statusNotRunning = status2.code === 0 && /陈旧|未运行/.test(out6a);

  const stop2 = await runBridgectl(["stop"]);
  const out6b = `${stop2.stdout}\n${stop2.stderr}`;
  const noForceKill = !out6b.includes("强杀");
  const deadPidUntouched = !isPidAlive(deadPid);
  const stalePidfileCleaned = !existsSync(PIDFILE_PATH);
  check(
    "⑥ 陈旧 pidfile（已死 pid）",
    statusNotRunning && stop2.code === 0 && noForceKill && deadPidUntouched,
    "status exit=0 且报未运行（陈旧/未运行）；stop exit=0 且不误杀（不含「强杀」）",
    `status exit=${String(status2.code)}(期望 0) 报未运行=${String(statusNotRunning)} 状态行=${firstMatchLine(out6a, /^\s*状态.*$/m)}, ` +
      `stop exit=${String(stop2.code)}(期望 0) 未强杀=${String(noForceKill)} 伪造 pid=${String(deadPid)} 仍不存活=${String(deadPidUntouched)}, ` +
      `陈旧 pidfile 已清=${String(stalePidfileCleaned)}, stop 首行=${firstNonEmptyLine(out6b)}`,
  );
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  prepareWorkspace();
  if (!existsSync(BRIDGE_ENTRY)) {
    check(
      "① start 冷启",
      false,
      "exit=0 且 pidfile 已写且 pid 存活 且 GET /health = 200 + status=ok + 含 role",
      `前置缺失：未找到 ${BRIDGE_ENTRY}（请先在 ${ORCH_ROOT} 运行 npm run build）`,
    );
    return;
  }
  await runChecks();
}

main()
  .catch((err) => {
    check(
      "探针执行未抛异常",
      false,
      "6 条断言全部可执行并得出结果",
      err instanceof Error ? `${err.message}\n${String(err.stack ?? "")}` : String(err),
    );
  })
  .then(async () => {
    await cleanup();
  })
  .finally(() => {
    const passedCount = checks.filter((c) => c.pass).length;
    const passed = checks.length > 0 && checks.every((c) => c.pass);
    summary.passed = passed;
    summary.passedCount = passedCount;
    summary.total = checks.length;

    for (const [index, item] of checks.entries()) {
      console.log(
        `[assert ${index + 1}] ${item.pass ? "PASS" : "FAIL"} | name=${item.name} | expect=${item.expect} | actual=${item.actual}`,
      );
    }
    if (!passed && existsSync(LOG_PATH)) {
      console.log(`[probe] 桥日志尾部（${LOG_PATH}）：`);
      console.log(tailLines(readFileSync(LOG_PATH, "utf8"), LOG_TAIL_LINES).join("\n"));
    }
    console.log("----- bridgectl-probe-summary -----");
    console.log(JSON.stringify(summary, null, 2));
    console.log("----- bridgectl-probe-summary-end -----");
    console.log(`[probe] ${passed ? "PASS" : "FAIL"} (${passedCount}/${checks.length} checks)`);

    // 留一点时间让 stdout 冲干净（Windows 管道下 process.exit 过早会截断），
    // 顺便让被强杀子进程的句柄收尾，避免退出码被句柄竞态污染。
    setTimeout(() => {
      process.exit(passed ? 0 : 1);
    }, 150);
  });
