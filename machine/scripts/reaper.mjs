#!/usr/bin/env node
/**
 * 孤儿进程回收器（reaper，REQ-v0.4.1-2026-09-15-03 §2.7）。
 *
 * 纯 Node ESM，零第三方依赖、无需构建：
 *   node scripts/reaper.mjs [--clean] [--grace-ms <ms>] [--help]
 *
 * 定位：**事后兜底**。启动对账（`launcher/reconcile.ts`）是**事前兜底**（清"本机在册之外"
 * 的账本条目）；reaper 处理**多实例 / 远程视角**下的红线判定、宽限期与「Launcher 不可达」
 * 的情形，且**默认只读**，不进任何启动路径。
 *
 * 数据源：子进程账本 `<machine 单元根>/.a2a/children/<pid>.json`
 *   = `{ pid, projectId, kind: "wrapper"|"serve", startedAt, command? }`（M1 落盘）。
 *   注意：账本目录与 `MACHINE_CONFIG` 无关（与 M1/M2 同源，恒取 machine 单元根）；
 *   配置只用于读 `launcher.port` 与项目表（打印 a2aPort）。
 *
 * 安全规则（全部 fail-safe，宁漏勿误杀 —— 多漏一个孤儿只是留到下次再清，误杀不可逆）：
 *   ① 红线 「活 Launcher 在册的项目禁清」：pidfile 的 pid 存活 ⇒ **只列不杀**（即使端口不通）；
 *   ② `/health` 可达但 `status === "starting"` ⇒ **不清理**（启动自检进行中）；
 *   ③ `/projects` 返回 **503** ⇒ **不清理**（业务路由未就绪）；
 *   ④ `/health` 200 且 `/projects` 200 ⇒ 活 Launcher 就绪 ⇒ **只列不杀**；
 *   ⑤ Launcher **不可达**（连接拒绝 / 超时 / 非 200）且 pidfile 无存活 pid ⇒ 账本中
 *      **存活且超过宽限期**的条目才按孤儿处理（可清）；
 *   ⑥ 宽限期：跳过"近期创建"的条目，防与正在进行的拉起竞态（缺省 30s，与
 *      `reconcile.ts#RECONCILE_GRACE_MS` 对齐）；
 *   ⑦ pid-reuse 防护（保守档）：条目 `startedAt` 缺失 / 非法（含进程创建时间不可得）
 *      ⇒ **不判孤儿**，只跳过；条目时间"在未来"（时钟回拨）亦按宽限期处理。
 *   ⑧ 任何探测 / 杀 / 删失败都只记日志：不抛出、不作为门禁（除用法 / 配置错误外恒 exit 0）。
 *
 * 判定顺序与 `reconcile.ts#planLedgerReconcile` 同口径：在册 ⇒ 跳过；pid 不存活 ⇒ 陈旧；
 * 存活但时间不可判 ⇒ 跳过；宽限期内 ⇒ 跳过；存活 + 超宽限 + 无主 ⇒ 孤儿。
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 宽限期（ms）：与 launcher/reconcile.ts 的 RECONCILE_GRACE_MS 对齐 */
const GRACE_MS = 30_000;
/** 单次 HTTP 探测超时 */
const HTTP_TIMEOUT_MS = 2_000;
/** 等待进程真正退出（杀后确认）的上限与间隔 */
const EXIT_WAIT_MS = 3_000;
const EXIT_POLL_MS = 200;
/** 账本文件名约定：`<pid>.json` */
const LEDGER_FILE_RE = /^(\d+)\.json$/;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MACHINE_ROOT = findMachineRoot(SCRIPT_DIR);
const LEDGER_DIR = join(MACHINE_ROOT, ".a2a", "children");
const PIDFILE_PATH = join(MACHINE_ROOT, ".a2a", "launcher.pid");
const CONFIG_PATH = process.env["MACHINE_CONFIG"] ?? join(MACHINE_ROOT, "config", "config.json");

function out(message) {
  console.log(`[reaper] ${message}`);
}

function warn(message) {
  console.error(`[reaper] ${message}`);
}

function fail(message) {
  console.error(`[reaper] ${message}`);
  process.exit(1);
}

function delay(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function usage() {
  console.log(
    [
      "用法：node scripts/reaper.mjs [--clean] [--grace-ms <ms>]",
      "",
      "  默认只读：列出账本中的孤儿（不杀、不删）。",
      "  --clean       实际清理：组杀孤儿进程 + 删账本条目（陈旧条目只删条目）。",
      "  --grace-ms N  覆盖宽限期（缺省 30000）。",
      "",
      "安全规则：Launcher 不可达且 pidfile 无存活 pid 才允许清理；",
      "         pidfile pid 存活 / status=starting / /projects 503 / 活 Launcher 就绪 ⇒ 只列不杀。",
    ].join("\n"),
  );
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

function parseArgs(argv) {
  const opts = { clean: false, graceMs: GRACE_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--clean") {
      opts.clean = true;
    } else if (arg === "--grace-ms") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 0) fail(`--grace-ms 需要一个非负数字：${String(argv[i + 1])}`);
      opts.graceMs = Math.trunc(value);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      usage();
      fail(`未知参数：${String(arg)}`);
    }
  }
  return opts;
}

/** 读取 launcher.port / listenHost / 项目表；配置不可读 = 无法判定红线 ⇒ 直接失败（不猜） */
function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    fail(`无法读取配置 ${CONFIG_PATH}（红线无法判定，已放弃）：${errText(err)}`);
  }
  const launcher = raw?.launcher;
  if (launcher === null || typeof launcher !== "object" || typeof launcher.port !== "number") {
    fail(`配置缺少 launcher.port：${CONFIG_PATH}`);
  }
  const projects = new Map();
  if (Array.isArray(raw?.projects)) {
    for (const project of raw.projects) {
      if (project === null || typeof project !== "object") continue;
      if (typeof project.projectId !== "string") continue;
      projects.set(project.projectId, typeof project.a2aPort === "number" ? project.a2aPort : null);
    }
  }
  return {
    path: CONFIG_PATH,
    port: launcher.port,
    listenHost: typeof launcher.listenHost === "string" ? launcher.listenHost : undefined,
    projects,
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
    };
  } catch {
    return null;
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

function resolveProbeHost(config, pidfile) {
  const candidate = pidfile?.host ?? config.listenHost;
  if (candidate === undefined || candidate === "0.0.0.0" || candidate === "::") return "127.0.0.1";
  return candidate;
}

function baseUrl(host, port) {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** GET 一个 JSON 端点；网络错误 / 超时 / 非 JSON 均以 null 表示"不可达" */
function httpGetJson(host, port, path, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const req = request({ host, port, path, method: "GET", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = body.length > 0 ? JSON.parse(body) : null;
        } catch {
          parsed = null;
        }
        finish({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.once("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.once("error", () => finish(null));
    req.end();
  });
}

/**
 * 探测 Launcher 状态：
 *   "starting"        /health 200 且 status=starting ⇒ 不清理
 *   "not-ready"       /projects 503 ⇒ 不清理
 *   "ready"           /health 200 且 /projects 200 ⇒ 活 Launcher ⇒ 只列不杀
 *   "unreachable"     /health 不可达（连接拒绝 / 超时 / 非 200）⇒ 候选可清（另受 pidfile 红线约束）
 */
async function probeLauncher(host, port) {
  const health = await httpGetJson(host, port, "/health");
  if (health === null) return { state: "unreachable", detail: "GET /health 不可达" };
  if (health.status === 200 && health.body?.status === "starting") {
    return { state: "starting", detail: "GET /health status=starting" };
  }
  const projects = await httpGetJson(host, port, "/projects");
  if (projects !== null && projects.status === 503) {
    return { state: "not-ready", detail: "GET /projects 503" };
  }
  if (health.status === 200 && projects !== null && projects.status === 200) {
    return { state: "ready", detail: "GET /health + /projects 均 200" };
  }
  return {
    state: "not-ready",
    detail: `未预期的响应（/health=${health.status}, /projects=${projects === null ? "不可达" : projects.status}）`,
  };
}

/** 读账本条目：目录不存在 = 空；非 `<pid>.json` 命名忽略；损坏 JSON ⇒ startedAtMs=undefined */
function readLedger() {
  const result = { entries: [], degraded: false };
  let names;
  try {
    names = readdirSync(LEDGER_DIR);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      result.degraded = true;
      warn(`读账本目录失败：${errText(err)}`);
    }
    return result;
  }
  for (const name of names) {
    const match = LEDGER_FILE_RE.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;

    let entry = { file: name, path: join(LEDGER_DIR, name), pid, startedAtMs: undefined };
    try {
      const raw = JSON.parse(readFileSync(entry.path, "utf8"));
      entry = {
        ...entry,
        projectId: typeof raw?.projectId === "string" ? raw.projectId : undefined,
        kind: typeof raw?.kind === "string" ? raw.kind : undefined,
        command: typeof raw?.command === "string" ? raw.command : undefined,
      };
      if (typeof raw?.startedAt === "string") {
        const ms = Date.parse(raw.startedAt);
        if (!Number.isNaN(ms)) entry.startedAtMs = ms;
      }
    } catch (err) {
      warn(`账本条目 ${name} 无法解析（按"时间不可判"处理）：${errText(err)}`);
    }
    result.entries.push(entry);
  }
  return result;
}

/** 分类（与 reconcile.ts#planLedgerReconcile 同口径） */
function classify(entries, { graceMs, nowMs }) {
  const orphans = [];
  const stale = [];
  const skipped = { grace: [], undatable: [] };
  for (const entry of entries) {
    if (!isPidAlive(entry.pid)) {
      stale.push(entry);
      continue;
    }
    if (entry.startedAtMs === undefined) {
      skipped.undatable.push(entry);
      continue;
    }
    if (nowMs - entry.startedAtMs < graceMs) {
      skipped.grace.push(entry);
      continue;
    }
    orphans.push(entry);
  }
  return { orphans, stale, skipped };
}

/** 组杀：win32 `taskkill /pid <p> /T /F`；POSIX 先进程组 `kill(-pid)`，回落单进程 */
function killTree(pid) {
  if (process.platform === "win32") {
    return runCommand("taskkill", ["/pid", String(pid), "/T", "/F"]);
  }
  try {
    process.kill(-pid, "SIGKILL");
    return Promise.resolve();
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程可能已退出，忽略
    }
    return Promise.resolve();
  }
}

function runCommand(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    child.once("exit", () => resolvePromise());
    child.once("error", () => resolvePromise());
  });
}

/** 杀后确认：等待进程真正退出（有界） */
async function waitForExit(pid) {
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(EXIT_POLL_MS);
  }
  return true;
}

function removeLedgerFile(entry) {
  try {
    rmSync(entry.path, { force: true });
    return true;
  } catch (err) {
    warn(`删除账本条目失败 ${entry.file}：${errText(err)}`);
    return false;
  }
}

function formatAge(startedAtMs, nowMs) {
  if (startedAtMs === undefined) return "未知";
  const seconds = Math.max(0, Math.round((nowMs - startedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}min`;
  return `${(seconds / 3_600).toFixed(1)}h`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.clean && process.env["REAPER_READONLY"] === "1") {
    fail("REAPER_READONLY=1：拒绝执行 --clean（防误触发）");
  }
  const config = loadConfig();
  const pidfile = readPidfile();
  const probeHost = resolveProbeHost(config, pidfile);
  const nowMs = Date.now();

  out(`模式        : ${opts.clean ? "清理（--clean）" : "只读（默认；加 --clean 才实际清理）"}`);
  out(`machine 根  : ${MACHINE_ROOT}`);
  out(`配置文件    : ${config.path}`);
  out(`账本目录    : ${LEDGER_DIR}`);
  out(`宽限期      : ${opts.graceMs}ms`);
  out(`launcher    : ${baseUrl(probeHost, config.port)}`);

  // ── 闸门判定（fail-safe：任一"可能活着"的证据 ⇒ 禁清）────────────────────────
  const pidAlive = pidfile !== null && isPidAlive(pidfile.pid);
  let launcher;
  if (pidAlive) {
    launcher = { state: "pidfile-alive", detail: `pidfile pid=${pidfile.pid} 存活` };
    out(`闸门        : 禁清 —— ${launcher.detail}（红线：活 Launcher 在册的项目禁清）`);
  } else {
    launcher = await probeLauncher(probeHost, config.port);
    if (launcher.state === "unreachable") {
      out(`闸门        : 允许清理 —— Launcher 不可达（${launcher.detail}）且 pidfile 无存活 pid`);
    } else {
      out(`闸门        : 不清理 —— ${launcher.detail}（fail-safe）`);
    }
  }
  const canClean = launcher.state === "unreachable";

  // ── 账本分类 ────────────────────────────────────────────────────────────────
  const ledger = readLedger();
  const { orphans, stale, skipped } = classify(ledger.entries, { graceMs: opts.graceMs, nowMs });

  out(`账本条目    : ${ledger.entries.length}（${LEDGER_DIR}）`);
  for (const entry of ledger.entries) {
    const project = entry.projectId ?? "?";
    const a2aPort = project !== "?" && config.projects.has(project) ? config.projects.get(project) : null;
    const fate =
      orphans.includes(entry) ? "孤儿" : stale.includes(entry) ? "陈旧（pid 已死）" : "跳过（宽限/不可判）";
    out(
      `  - pid=${entry.pid} project=${project} kind=${entry.kind ?? "?"}` +
        `${a2aPort === null ? "" : ` a2aPort=${a2aPort}`}` +
        ` 存活=${isPidAlive(entry.pid) ? "是" : "否"} 年龄=${formatAge(entry.startedAtMs, nowMs)} ⇒ ${fate}`,
    );
  }
  out(`孤儿        : ${orphans.length} 个${orphans.length > 0 ? `（pid=${orphans.map((e) => e.pid).join(",")}）` : ""}`);
  out(`陈旧条目    : ${stale.length} 个`);
  out(`跳过        : ${skipped.grace.length + skipped.undatable.length} 个（宽限 ${skipped.grace.length} / 不可判 ${skipped.undatable.length}）`);

  // ── 只读 ⇒ 到此为止 ─────────────────────────────────────────────────────────
  if (!opts.clean) {
    out(
      orphans.length === 0
        ? "结论        : 无孤儿，干净退出（只读模式，未做任何改动）"
        : `结论        : 发现 ${orphans.length} 个孤儿（只读模式，未杀未删；加 --clean 才清理）`,
    );
    if (ledger.degraded) out("结论        : 已降级（见上文日志）");
    return;
  }

  // ── --clean ────────────────────────────────────────────────────────────────
  if (!canClean) {
    out(`结论        : 拒绝清理（闸门禁清：${launcher.detail}）；未杀任何进程、未删任何条目`);
    return;
  }

  let killed = 0;
  let failed = 0;
  for (const entry of orphans) {
    try {
      await killTree(entry.pid);
      const exited = await waitForExit(entry.pid);
      if (!exited) {
        failed += 1;
        warn(`孤儿 pid=${entry.pid} 未在 ${EXIT_WAIT_MS}ms 内退出，保留账本条目`);
        continue;
      }
      if (removeLedgerFile(entry)) killed += 1;
    } catch (err) {
      failed += 1;
      warn(`清理孤儿 pid=${entry.pid} 失败（保留账本条目）：${errText(err)}`);
    }
  }
  let staleRemoved = 0;
  for (const entry of stale) {
    if (removeLedgerFile(entry)) staleRemoved += 1;
  }

  out(`已清理      : 杀 ${killed} 个孤儿、删 ${staleRemoved} 个陈旧条目${failed > 0 ? `、失败 ${failed} 个` : ""}`);
  out(`结论        : ${failed > 0 ? "部分失败（见上文日志）" : "清理完成"}`);
}

await main().catch((err) => {
  // 兜底：任何未预期异常都不得让脚本"半途静默"退出
  warn(`未预期异常：${errText(err)}`);
  process.exit(0);
});
