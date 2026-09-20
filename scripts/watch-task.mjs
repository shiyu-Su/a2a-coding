#!/usr/bin/env node
// watch-task.mjs — 等待一个或多个常规 a2a_call 任务达成「可退出」状态；只读，不写任何状态 / 文件。
//
// 用法：
//   node scripts/watch-task.mjs <taskId...> [--base <url>] [--interval <ms>] [--max <loops>]
//     --base      只读工作台地址；优先级：--base > 环境变量 WATCH_BASE_URL > 默认 http://127.0.0.1:3300
//     --interval  轮询间隔毫秒（默认 10000，下限 2000）
//     --max       最多观察轮数（默认 180，下限 1）；观察窗口 = interval × max
//     --help, -h  打印本用法并退出 0
//
// 退出码（三档；**刻意不按任务状态细分** —— 各任务状态由 stdout 行标注）：
//   0  settled  — 目标 id 全部达成退出判据（**0 = 等到了，不等于成功**；failed / blocked 亦退 0）
//   20 timeout  — 观察窗口耗尽仍有 id 未达成
//   1  error    — 脚本自身错误（参数非法 / 只读 web 不可用 / 未知 taskId）；**优先于 20**
//
// 判据（快照驱动，逐 id 独立）：
//   达成 = state ∈ {completed, failed, blocked, input-required}
//     · 前三 = orch 的 FINISHED_TASK_STATES；input-required 亦退出等待（任务在等宿主裁决，继续等无意义）
//     · **未识别的 state 一律按「未达成」处理**（继续等 → 窗口耗尽退 20）⇒ orch 未来加态不需改本脚本
//   未知 id（HTTP 404 / code=task_not_found）⇒ 该 id 记 not_found 行、**继续等其余 id**，最终退 1
//   多 id 语义 = **「等全部」**（无「等任意一个」；要那语义就单 id 分开跑）
//
// 输出（stdout）：**只打印状态**；等待期间静默，退出时每 id 一行 ——
//   单 id：一行 `state`（原始字符串，不做映射 / 翻译）；多 id：按入参顺序每行 `<taskId> <state>`
//   **不打印**结果文本 / 失败原因 / 待裁决问题 / artifacts ——
//   详情由宿主自行调 MCP 工具 `a2a_task_status` 获取（一次即可，勿轮询）。
//
// 说明：
//   - 只读：仅 GET `{base}/api/tasks/{taskId}`；不读 SQLite，不写任何状态 / 文件。
//   - 入参必须是 `a2a_call` 返回的 taskId（本地 id）：该端点走 `store.getTask` 主键直查，
//     不做 remoteTaskId 反查（传远端 id 会 404）。
//   - 退出方式：置 `process.exitCode` 后自然退出（**不调 `process.exit()`**）——避免活动句柄关闭期的
//     libuv 竞态（Windows 上表现为断言崩溃、退出码损坏）；为此 HTTP 用 `node:http` + `agent:false`（无 keep-alive）。
//   - 端点契约（orch 冻结）：state 五值集合 / 未知 id ⇒ 404 `task_not_found` / 详情 GET-only、绑 127.0.0.1、
//     无鉴权、含 state；本脚本**不依赖** `text` / `artifacts` 的存在与形状。
//   - 已知局限：任务失联或看护放弃时 orch 会保持 `working`（不判 failed）⇒ 本脚本只能等窗口耗尽退 20，
//     这是**正确表现**，不是缺陷。

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

const EXIT_SETTLED = 0;
const EXIT_ERROR = 1;
const EXIT_TIMEOUT = 20;

// 达成即退出等待（= 需宿主动作 / 已结算；见头注「判据」）
const ACHIEVED_TASK_STATES = new Set(["completed", "failed", "blocked", "input-required"]);

const USAGE = [
  "用法: node scripts/watch-task.mjs <taskId...> [--base <url>] [--interval <ms>] [--max <loops>]",
  "  --base      只读工作台地址；优先级：--base > 环境变量 WATCH_BASE_URL > 默认 http://127.0.0.1:3300",
  "  --interval  轮询间隔毫秒（默认 10000，下限 2000）",
  "  --max       最多观察轮数（默认 180，下限 1）；观察窗口 = interval × max",
  "  --help      打印本用法并退出 0",
  "",
  "入参：一个或多个 taskId，**必须是 a2a_call 返回的本地 id**（传 Feature 节点的 remoteTaskId 会 404）。",
  "多 id 语义 = 等「全部」达成（无「等任意一个」）；某 id 未知 ⇒ 记 not_found 行并继续等其余，最终退 1。",
  "退出码：0 = 等到了（**不等于成功**；failed / blocked 亦退 0，成败看 stdout 的 state）· 20 = 窗口耗尽 · 1 = 脚本错误。",
  "stdout 只打印状态（每 id 一行 state），不打印结果文本；详情请另行调用 MCP 工具 a2a_task_status。",
].join("\n");

// 直接 writeSync：不经缓冲，避免与自然退出时序相关的输出截断
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
  if (argv.length === 0) {
    throw new Error("缺少 taskId");
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { help: true };
  }

  const options = {
    taskIds: [],
    baseUrl: process.env.WATCH_BASE_URL?.trim() || DEFAULT_BASE_URL,
    intervalMs: DEFAULT_INTERVAL_MS,
    maxLoops: DEFAULT_MAX_LOOPS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      options.taskIds.push(token);
      continue;
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
    } else if (flag === "--help" || flag === "-h") {
      return { help: true };
    } else {
      throw new Error(`未知标志：${flag}`);
    }
  }

  if (options.taskIds.length === 0) {
    throw new Error("缺少 taskId");
  }

  // 去重（保留首次出现顺序）：同一 id 重复给出时只等一次、只打印一行
  const seen = new Set();
  options.taskIds = options.taskIds.filter((id) => {
    if (id === "" || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (options.taskIds.length === 0) {
    throw new Error("taskId 为空");
  }

  return options;
}

// 用 node:http（agent:false = 无 keep-alive）而非 fetch：请求结束即释放 socket，
// 不在事件循环里留 undici 异步句柄 —— 避免进程退出期的 libuv 关闭竞态。
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

// 归因提示：只读 web 仅在「web.enabled ∧ role==="owner" 且绑 loopback」的机上存在，端口可被配置改动
function unreachableHint(baseUrl) {
  return [
    `连接错误：只读 web 不可用（${baseUrl}）。可能原因：`,
    "  ① 桥未起（或该机 web 未启用：web.enabled=false）；",
    "  ② 本机不是 owner（只读工作台仅在 role=\"owner\" 时提供）；",
    "  ③ web.port 被改过（用 --base 或 WATCH_BASE_URL 指定实际地址）。",
  ].join("\n");
}

// 返回 { kind: "ok", state } | { kind: "not_found" }；连接 / 协议类问题抛错（带归因）
async function fetchTaskState(baseUrl, taskId) {
  const url = `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`;

  let response;
  try {
    response = await httpGetJson(url, REQUEST_TIMEOUT_MS);
  } catch (error) {
    throw new Error(`${unreachableHint(baseUrl)}（${url}：${describeError(error)}）`);
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

  if (body.ok === true && isRecord(body.task)) {
    const state = typeof body.task.state === "string" ? body.task.state : "";
    return { kind: "ok", state: state === "" ? "unknown" : state };
  }

  const looksNotFound = response.status === 404 || body.code === "task_not_found";
  if (looksNotFound) {
    return { kind: "not_found" };
  }
  throw new Error(`连接错误：只读 web 返回 HTTP ${response.status}（${url}）`);
}

function formatLine(taskId, state, multiple) {
  return multiple ? `${taskId} ${state}` : state;
}

async function run(options) {
  const { taskIds, baseUrl, intervalMs, maxLoops } = options;
  const multiple = taskIds.length > 1;

  // 逐 id 结果：state = 最近一次读到的原始 state；notFound = 未知 id；achieved = 已达成退出判据
  const results = new Map(
    taskIds.map((taskId) => [taskId, { state: "unknown", notFound: false, achieved: false }]),
  );

  const printAll = () => {
    for (const taskId of taskIds) {
      const result = results.get(taskId);
      out(formatLine(taskId, result.notFound ? "not_found" : result.state, multiple));
    }
  };

  for (let iteration = 1; iteration <= maxLoops; iteration += 1) {
    const pending = taskIds.filter((taskId) => !results.get(taskId).achieved && !results.get(taskId).notFound);

    let settled = [];
    try {
      settled = await Promise.all(
        pending.map(async (taskId) => [taskId, await fetchTaskState(baseUrl, taskId)]),
      );
    } catch (error) {
      err(`[watch-task] ${describeError(error)}`);
      printAll();
      return EXIT_ERROR;
    }

    for (const [taskId, outcome] of settled) {
      const result = results.get(taskId);
      if (outcome.kind === "not_found") {
        result.notFound = true;
        continue;
      }
      result.state = outcome.state;
      result.achieved = ACHIEVED_TASK_STATES.has(outcome.state);
    }

    const allResolved = taskIds.every((taskId) => {
      const result = results.get(taskId);
      return result.achieved || result.notFound;
    });
    if (allResolved) {
      printAll();
      // 未知 id = 脚本自身错误（优先于 timeout），其余皆「等到了」
      return taskIds.some((taskId) => results.get(taskId).notFound) ? EXIT_ERROR : EXIT_SETTLED;
    }

    if (iteration < maxLoops) {
      await sleep(intervalMs);
    }
  }

  printAll();
  return EXIT_TIMEOUT;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    err(`[watch-task] ${describeError(error)}`);
    err(USAGE);
    return EXIT_ERROR;
  }

  if (options.help) {
    out(USAGE);
    return EXIT_SETTLED;
  }

  try {
    return await run(options);
  } catch (error) {
    err(`[watch-task] 意外错误：${describeError(error)}`);
    for (const taskId of options.taskIds) {
      out(formatLine(taskId, "unknown", options.taskIds.length > 1));
    }
    return EXIT_ERROR;
  }
}

// 不调 process.exit()：置 exitCode 后交由事件循环自然退出（句柄已全部释放 ⇒ 无关闭竞态）。
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    err(`[watch-task] 意外错误：${describeError(error)}`);
    process.exitCode = EXIT_ERROR;
  },
);
