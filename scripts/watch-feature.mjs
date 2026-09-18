#!/usr/bin/env node
// watch-feature.mjs — 监视一个 Feature，直到它到达「需宿主动作」时点或观察窗口耗尽；只读，不写任何状态/文件。
//
// 用法：
//   node scripts/watch-feature.mjs <featureId> [--base <url>] [--interval <ms>] [--max <loops>]
//     --base      只读工作台地址；优先级：--base > 环境变量 WATCH_BASE_URL > 默认 http://127.0.0.1:3300
//     --interval  轮询间隔毫秒（默认 10000，下限 2000）
//     --max       最多观察轮数（默认 180，下限 1）；观察窗口 = interval × max
//
// 退出码：
//   0  completed        — feature.state ∈ {integrating, testing, reviewing, completed}（已离开 executing，完成侧）
//   10 failure-at-rest  — feature.state === 'executing' 且「静止且有失败」（判据见下）
//   11 needs-input      — feature.state === 'needs_input'
//   12 cancelled        — feature.state === 'cancelled'
//   13 failed           — feature.state === 'failed'（仅 DAG 非法 fail-fast）
//   20 timeout          — 观察窗口耗尽仍为 'executing'，且未检出 failure-at-rest
//   1  error            — 参数错误 / 连接错误（只读 web 不可用，含超时）/ feature 不存在
//
// 判据（快照驱动，已结算清单之外的任务态一律视为「活跃」，故对未知任务态名稳健）：
//   hasFailure = tasks 中存在 state === 'failed' 或 'blocked'
//   anyActive  = tasks 中存在 state ∉ {completed, failed, blocked, cancelled}
//   atRestWithFailure = hasFailure && !anyActive
//   failure-at-rest(10) 与 timeout(20) 互斥：每轮先判 at-rest；窗口内从未触发才退 20。
//
// 说明：
//   - 只读：仅访问只读工作台 API `GET {base}/api/features/{featureId}`；不读 SQLite，不写任何状态 / 文件。
//   - 本脚本不使用事件游标（/api/events 的 since=0 仅回最旧页 ⇒ 无法廉价取得「当前游标」）；
//     判据取自 /api/features/:id 快照（state + tasks[]）。feature.failure_report 仍由宿主经 a2a_events 消费（不在本脚本职责）。
//   - `blocked` 是任务级（task）状态，不是 Feature 级状态。
//   - 退出方式：置 `process.exitCode` 后自然退出（**不调 `process.exit()`**）——
//     避免在活动句柄关闭期间强制退出引发的 libuv 竞态（Windows 上表现为断言崩溃、退出码损坏）。
//     为此 HTTP 读取用 `node:http`（`agent:false`，无 keep-alive），不在事件循环留异步句柄。

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import process from "node:process";

const DEFAULT_BASE_URL = "http://127.0.0.1:3300";
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_LOOPS = 180;
const MIN_INTERVAL_MS = 2_000;
const MIN_MAX_LOOPS = 1;
const REQUEST_TIMEOUT_MS = 10_000;

const EXIT_COMPLETED = 0;
const EXIT_ERROR = 1;
const EXIT_FAILURE_AT_REST = 10;
const EXIT_NEEDS_INPUT = 11;
const EXIT_CANCELLED = 12;
const EXIT_FAILED = 13;
const EXIT_TIMEOUT = 20;

const COMPLETED_FEATURE_STATES = new Set(["integrating", "testing", "reviewing", "completed"]);
const SETTLED_TASK_STATES = new Set(["completed", "failed", "blocked", "cancelled"]);

const USAGE = [
  "用法: node scripts/watch-feature.mjs <featureId> [--base <url>] [--interval <ms>] [--max <loops>]",
  "  --base      只读工作台地址；优先级：--base > 环境变量 WATCH_BASE_URL > 默认 http://127.0.0.1:3300",
  "  --interval  轮询间隔毫秒（默认 10000，下限 2000）",
  "  --max       最多观察轮数（默认 180，下限 1）；观察窗口 = interval × max",
].join("\n");

// 直接 writeSync：process.exit 不会截断已同步写出的输出
function writeLine(fd, line) {
  try {
    fs.writeSync(fd, `${line}\n`);
  } catch {
    // 输出管道不可用时静默：退出码仍是唯一可信信号
  }
}

function out(line) {
  writeLine(1, line);
}

function err(line) {
  writeLine(2, line);
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInt(raw, flag) {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flag} 取值非法：${raw}（须为正整数）`);
  }
  return Number.parseInt(raw, 10);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0].startsWith("--")) {
    throw new Error(argv.length === 0 ? "缺少 featureId" : `缺少 featureId（收到标志 ${argv[0]}）`);
  }

  const options = {
    featureId: argv[0],
    baseUrl: process.env.WATCH_BASE_URL?.trim() || DEFAULT_BASE_URL,
    intervalMs: DEFAULT_INTERVAL_MS,
    maxLoops: DEFAULT_MAX_LOOPS,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`未知参数：${token}`);
    }

    const eqIndex = token.indexOf("=");
    const flag = eqIndex === -1 ? token : token.slice(0, eqIndex);
    const inlineValue = eqIndex === -1 ? undefined : token.slice(eqIndex + 1);
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${flag} 缺少取值`);
      }
      i += 1;
      return next;
    };

    if (flag === "--base") {
      const baseUrl = takeValue().trim().replace(/\/+$/, "");
      if (baseUrl === "") {
        throw new Error("--base 取值为空");
      }
      options.baseUrl = baseUrl;
    } else if (flag === "--interval") {
      options.intervalMs = Math.max(MIN_INTERVAL_MS, parsePositiveInt(takeValue(), flag));
    } else if (flag === "--max") {
      options.maxLoops = Math.max(MIN_MAX_LOOPS, parsePositiveInt(takeValue(), flag));
    } else {
      throw new Error(`未知标志：${flag}`);
    }
  }

  return options;
}

// 用 node:http（agent:false = 无 keep-alive）而非 fetch：请求结束即释放 socket，
// 不在事件循环里留 undici 异步句柄 —— 避免 process.exit 期间的 libuv 关闭竞态。
function httpGetJson(urlString, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (error) {
      reject(new Error(`只读 web 地址非法（${urlString}）：${describeError(error)}`));
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      { method: "GET", headers: { accept: "application/json" }, agent: false, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            bodyText: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.on("error", (error) => reject(error));
    req.end();
  });
}

async function fetchSnapshot(baseUrl, featureId) {
  const url = `${baseUrl}/api/features/${encodeURIComponent(featureId)}`;

  let response;
  try {
    response = await httpGetJson(url, REQUEST_TIMEOUT_MS);
  } catch (error) {
    throw new Error(`连接错误：只读 web 不可用（${url}）：${describeError(error)}`);
  }

  let body;
  try {
    body = JSON.parse(response.bodyText);
  } catch {
    throw new Error(`连接错误：只读 web 响应非 JSON（HTTP ${response.status}，${url}）`);
  }
  if (!isRecord(body)) {
    throw new Error(`连接错误：只读 web 响应格式异常（HTTP ${response.status}，${url}）`);
  }

  const status = response.status;
  if (body.ok !== true || !isRecord(body.feature)) {
    const looksNotFound =
      status === 404 || body.code === "feature_not_found" || (status >= 200 && status < 300);
    if (looksNotFound) {
      throw new Error(`feature 不存在：${featureId}（HTTP ${status}）`);
    }
    throw new Error(`连接错误：只读 web 返回 HTTP ${status}（${url}）`);
  }

  const tasks = Array.isArray(body.tasks) ? body.tasks.filter(isRecord) : [];
  return { feature: body.feature, tasks };
}

function formatTimestamp(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function summarizeTaskStates(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    const state = typeof task.state === "string" && task.state !== "" ? task.state : "unknown";
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([state, count]) => `${state}=${count}`)
    .join(" ");
}

function isAtRestWithFailure(tasks) {
  let hasFailure = false;
  let anyActive = false;
  for (const task of tasks) {
    if (task.state === "failed" || task.state === "blocked") {
      hasFailure = true;
    }
    if (!SETTLED_TASK_STATES.has(task.state)) {
      anyActive = true;
    }
  }
  return hasFailure && !anyActive;
}

function formatProgressLine(iteration, snapshot, atRest) {
  const state = typeof snapshot.feature.state === "string" ? snapshot.feature.state : "unknown";
  const summary = summarizeTaskStates(snapshot.tasks);
  return `[watch] #${iteration} ${formatTimestamp(new Date())} state=${state} tasks{${summary}} atRest=${atRest}`;
}

function formatFinalLine(featureId, state, label) {
  return `[watch] 完成：feature=${featureId} state=${state} 判定=${label}`;
}

function classifySnapshot(snapshot) {
  const state = snapshot.feature.state;

  if (COMPLETED_FEATURE_STATES.has(state)) {
    return { exitCode: EXIT_COMPLETED, label: "completed" };
  }
  if (state === "cancelled") {
    return { exitCode: EXIT_CANCELLED, label: "cancelled" };
  }
  if (state === "failed") {
    return { exitCode: EXIT_FAILED, label: "failed" };
  }
  if (state === "needs_input") {
    return { exitCode: EXIT_NEEDS_INPUT, label: "needs-input" };
  }
  if (state === "executing") {
    return isAtRestWithFailure(snapshot.tasks)
      ? { exitCode: EXIT_FAILURE_AT_REST, label: "failure-at-rest" }
      : null;
  }

  throw new Error(
    `未覆盖的 feature 状态：${String(state)}（本脚本只处理 executing 与需宿主动作的已离开态）`,
  );
}

async function run(options) {
  const { featureId, baseUrl, intervalMs, maxLoops } = options;
  out(`[watch] feature=${featureId} base=${baseUrl} interval=${intervalMs}ms max=${maxLoops}`);

  let lastState = "unknown";

  for (let iteration = 1; iteration <= maxLoops; iteration += 1) {
    let snapshot;
    try {
      snapshot = await fetchSnapshot(baseUrl, featureId);
    } catch (error) {
      err(`[watch] ${describeError(error)}`);
      out(formatFinalLine(featureId, lastState, "error"));
      return EXIT_ERROR;
    }

    if (typeof snapshot.feature.state === "string" && snapshot.feature.state !== "") {
      lastState = snapshot.feature.state;
    }

    let verdict;
    try {
      verdict = classifySnapshot(snapshot);
    } catch (error) {
      err(`[watch] ${describeError(error)}`);
      out(formatFinalLine(featureId, lastState, "error"));
      return EXIT_ERROR;
    }

    out(formatProgressLine(iteration, snapshot, isAtRestWithFailure(snapshot.tasks)));

    if (verdict !== null) {
      out(formatFinalLine(featureId, lastState, verdict.label));
      return verdict.exitCode;
    }

    if (iteration < maxLoops) {
      await sleep(intervalMs);
    }
  }

  out(formatFinalLine(featureId, lastState, "timeout"));
  return EXIT_TIMEOUT;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    err(`[watch] ${describeError(error)}`);
    err(USAGE);
    return EXIT_ERROR;
  }

  try {
    return await run(options);
  } catch (error) {
    err(`[watch] 意外错误：${describeError(error)}`);
    out(formatFinalLine(options.featureId, "unknown", "error"));
    return EXIT_ERROR;
  }
}

// 不调 process.exit()：置 exitCode 后交由事件循环自然退出（句柄已全部释放 ⇒ 无关闭竞态）。
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    err(`[watch] 意外错误：${describeError(error)}`);
    process.exitCode = EXIT_ERROR;
  },
);
