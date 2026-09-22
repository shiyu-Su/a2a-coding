#!/usr/bin/env node
// watch-feature-loud.mjs — 「失败即叫」版 Feature 看护；只读，不写任何状态 / 文件。
//
// 与 watch-feature.mjs 的**刻意差别**（2026-09-22 实测暴露的缺口）：
//   watch-feature.mjs 的 failure-at-rest(10) 判据是 `hasFailure && !anyActive` —— 要求「**静止**且有失败」。
//   而 600s 超时型失败（本仓常态）出现时，其它节点往往仍在飞 ⇒ 永远不满足静止 ⇒ 脚本只能等到窗口耗尽退 20，
//   宿主因此**收不到「有失败」的信号**（2026-09-22：M1/O5 双双 600s 超时，看护连退两轮 20，通知看起来像「正常完成」）。
//   本脚本改为 **一旦 `failed > 0` 就立即打印失败清单并退出 30** —— 理由：这类失败**每轮重派成本 ~10 分钟**且**不自愈**，
//   早重派 = 省一个观察窗口。
//
// 用法：
//   node scripts/watch-feature-loud.mjs <featureId> [--base <url>] [--interval <ms>] [--max <loops>]
//
// 退出码：
//   30 failed-early    — 检出 `failed` 任务（**附清单**），请宿主尽快 `advance(retryTaskIds)`
//   0  completed-side  — feature.state ∈ {integrating, testing, reviewing, completed}
//   10 failure-at-rest — 静止且有失败（与 watch-feature.mjs 同义）
//   11 needs-input     — feature.state === 'needs_input'
//   12 cancelled       — feature.state === 'cancelled'
//   13 feature-failed  — feature.state === 'failed'（DAG 非法 fail-fast）
//   20 timeout         — 窗口耗尽仍为 executing 且无失败
//   1  error           — 参数 / 连接 / feature 不存在
//
// 输出：① 计数**变化时**打一行快照（避免刷屏）② 检出 failed 时打清单块 ③ 退出前打判定行。
// 只读：仅 `GET {base}/api/features/{featureId}`；不读 SQLite、不写文件。

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import process from "node:process";

const DEFAULT_BASE_URL = "http://127.0.0.1:3300";
const DEFAULT_INTERVAL_MS = 20_000;
const DEFAULT_MAX_LOOPS = 28;
const REQUEST_TIMEOUT_MS = 10_000;

const EXIT_COMPLETED_SIDE = 0;
const EXIT_ERROR = 1;
const EXIT_FAILURE_AT_REST = 10;
const EXIT_NEEDS_INPUT = 11;
const EXIT_CANCELLED = 12;
const EXIT_FEATURE_FAILED = 13;
const EXIT_TIMEOUT = 20;
const EXIT_FAILED_EARLY = 30;

const COMPLETED_SIDE_STATES = new Set(["integrating", "testing", "reviewing", "completed"]);
const SETTLED_TASK_STATES = new Set(["completed", "failed", "blocked", "cancelled"]);

function out(line) {
  try {
    fs.writeSync(1, `${line}\n`);
  } catch {
    /* 管道不可用时静默：退出码仍是唯一可信信号 */
  }
}

function err(line) {
  try {
    fs.writeSync(2, `${line}\n`);
  } catch {
    /* 同上 */
  }
}

function httpGetJson(urlString) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (error) {
      reject(new Error(`地址非法（${urlString}）：${error.message}`));
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      { method: "GET", headers: { accept: "application/json" }, agent: false, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`请求超时（${REQUEST_TIMEOUT_MS}ms）`)));
    req.on("error", reject);
    req.end();
  });
}

function parseArgs(argv) {
  const options = {
    featureId: undefined,
    baseUrl: process.env.WATCH_BASE_URL?.trim() || DEFAULT_BASE_URL,
    intervalMs: DEFAULT_INTERVAL_MS,
    maxLoops: DEFAULT_MAX_LOOPS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      if (options.featureId === undefined) options.featureId = token;
      else throw new Error(`多余的位置参数：${token}`);
      continue;
    }
    const [flag, inline] = token.includes("=") ? token.split(/=(.*)/s, 2) : [token, undefined];
    const take = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} 缺少取值`);
      i += 1;
      return next;
    };
    if (flag === "--base") options.baseUrl = take().trim().replace(/\/+$/, "");
    else if (flag === "--interval") options.intervalMs = Math.max(2000, Number.parseInt(take(), 10));
    else if (flag === "--max") options.maxLoops = Math.max(1, Number.parseInt(take(), 10));
    else if (flag === "--help" || flag === "-h") {
      options.help = true;
      return options;
    } else throw new Error(`未知标志：${flag}`);
  }
  if (!options.help && !options.featureId) throw new Error("缺少 featureId");
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFeature(baseUrl, featureId) {
  const url = `${baseUrl}/api/features/${encodeURIComponent(featureId)}`;
  let res;
  try {
    res = await httpGetJson(url);
  } catch (error) {
    throw new Error(`只读 web 不可用（${url}）：${error.message}`);
  }
  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    throw new Error(`响应非 JSON（HTTP ${res.status}）：${url}`);
  }
  const feature = body?.feature ?? body;
  const tasks = feature?.tasks ?? body?.tasks ?? [];
  if (typeof feature?.state !== "string" || !Array.isArray(tasks)) {
    throw new Error(`响应形状异常（HTTP ${res.status}）：缺 feature.state 或 tasks[]`);
  }
  return { state: feature.state, tasks };
}

function countsOf(tasks) {
  const c = {};
  for (const t of tasks) c[t.state] = (c[t.state] ?? 0) + 1;
  return c;
}

function countsLine(counts) {
  return `tasks{${Object.keys(counts)
    .sort()
    .map((k) => `${k}=${counts[k]}`)
    .join(" ")}}`;
}

function failureBlock(tasks) {
  const bad = tasks.filter((t) => t.state === "failed" || t.state === "blocked");
  const lines = [`[watch-loud] ⚠ 检出 ${bad.filter((t) => t.state === "failed").length} 个 failed / ${bad.filter((t) => t.state === "blocked").length} 个 blocked（下游冻结）：`];
  for (const t of bad) {
    lines.push(
      `[watch-loud]   ${String(t.taskId).slice(0, 8)}  ${String(t.projectId).padEnd(8)} state=${t.state} failureKind=${t.failureKind ?? "-"} retryCount=${t.retryCount ?? 0} updatedAt=${t.updatedAt ?? "-"}`,
    );
  }
  lines.push(`[watch-loud]   尽早 \`a2a_feature_advance(featureId, to="executing", retryTaskIds=[…])\` 重派并解冻下游`);
  return lines.join("\n");
}

async function run(options) {
  const { featureId, baseUrl, intervalMs, maxLoops } = options;
  out(`[watch-loud] feature=${featureId} base=${baseUrl} interval=${intervalMs}ms max=${maxLoops}`);
  let lastCounts = "";
  let lastState = "";
  // 已存在的失败不重复叫：以「本窗口内见过的最低 failed 数」为基线，只有相对基线**新增**失败才退 30。
  // 场景：宿主故意让某失败节点保持 failed（等补正轨跑完再重派）时，旧失败不该反复触发早退。
  let baselineFailed = null;
  for (let i = 1; i <= maxLoops; i += 1) {
    let snap;
    try {
      snap = await fetchFeature(baseUrl, featureId);
    } catch (error) {
      err(`[watch-loud] ${error.message}`);
      return EXIT_ERROR;
    }
    const counts = countsOf(snap.tasks);
    const line = countsLine(counts);
    if (line !== lastCounts || snap.state !== lastState) {
      out(`[watch-loud] #${i} ${new Date().toISOString()} state=${snap.state} ${line} atRest=${counts.failed || counts.blocked ? !snap.tasks.some((t) => !SETTLED_TASK_STATES.has(t.state)) : false}`);
      lastCounts = line;
      lastState = snap.state;
    }
    // ① 失败即叫（本脚本与 watch-feature.mjs 的唯一语义差异）：只对**新增**失败早退
    if (baselineFailed === null) baselineFailed = counts.failed ?? 0;
    if ((counts.failed ?? 0) > baselineFailed) {
      out(failureBlock(snap.tasks));
      out(`[watch-loud] 完成：state=${snap.state} 判定=failed-early exit=${EXIT_FAILED_EARLY}`);
      return EXIT_FAILED_EARLY;
    }
    // ② Feature 离开 executing（完成侧 / 异常态）
    if (COMPLETED_SIDE_STATES.has(snap.state)) {
      out(`[watch-loud] 完成：state=${snap.state} 判定=completed-side exit=${EXIT_COMPLETED_SIDE}`);
      return EXIT_COMPLETED_SIDE;
    }
    if (snap.state === "needs_input") {
      out(`[watch-loud] 完成：state=needs_input 判定=needs-input exit=${EXIT_NEEDS_INPUT}`);
      return EXIT_NEEDS_INPUT;
    }
    if (snap.state === "cancelled") {
      out(`[watch-loud] 完成：state=cancelled 判定=cancelled exit=${EXIT_CANCELLED}`);
      return EXIT_CANCELLED;
    }
    if (snap.state === "failed") {
      out(`[watch-loud] 完成：state=failed 判定=feature-failed exit=${EXIT_FEATURE_FAILED}`);
      return EXIT_FEATURE_FAILED;
    }
    // ③ 静止且有失败（保留既有语义，作兜底）
    const anyActive = snap.tasks.some((t) => !SETTLED_TASK_STATES.has(t.state));
    if (!anyActive && ((counts.failed ?? 0) > 0 || (counts.blocked ?? 0) > 0)) {
      out(failureBlock(snap.tasks));
      out(`[watch-loud] 完成：state=${snap.state} 判定=failure-at-rest exit=${EXIT_FAILURE_AT_REST}`);
      return EXIT_FAILURE_AT_REST;
    }
    if (i < maxLoops) await sleep(intervalMs);
  }
  out(`[watch-loud] 完成：state=${lastState} 判定=timeout exit=${EXIT_TIMEOUT}`);
  return EXIT_TIMEOUT;
}

main();

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    err(`[watch-loud] ${error.message}`);
    process.exitCode = EXIT_ERROR;
    return;
  }
  if (options.help) {
    out("用法: node scripts/watch-feature-loud.mjs <featureId> [--base <url>] [--interval <ms>] [--max <loops>]");
    process.exitCode = EXIT_COMPLETED_SIDE;
    return;
  }
  run(options).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      err(`[watch-loud] 意外错误：${error.message}`);
      process.exitCode = EXIT_ERROR;
    },
  );
}
