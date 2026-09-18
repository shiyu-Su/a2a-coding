/**
 * v0.7.0 A4 · `dispatchTask` 入队重写单测（pull 连接模型）。
 *
 * v0.7.0 A6 调整：`locateProject` 已切**注册表投影**（零出站）⇒ 本用例改为向注册表写入
 * `m1/alpha` 投影来「定位」，并保留**防 vacuous** 的零出站计数桩（任何 fetch 一律抛错）。
 *
 * 覆盖节点门禁三项：
 * ① **enqueue 幂等** —— 同一 taskId 二次入队**零写入**（`queued_at` 不刷新 ⇒ FIFO 位次不变）；
 * ② **成员错同步 fail-fast 零网络** —— 非成员派发在任何前置 I/O 之前失败（`outbound === 0`，
 *    且**不留脏行**：既不入队也不建独立任务行）；
 * ③ **超预算返回 working + taskId** —— 无 Runner 领取时到点返回句柄，且任务**先落盘**（queued）
 *    再报告（「接近超时先落盘再报告」）。
 *
 * 夹具约束：`MACHINES_CONFIG` / `SYNC_BUDGET_MS` / `POLL_INTERVAL_MS` 均为 `bridge/index.ts` 的
 * **模块加载期常量** ⇒ 必须在 **import 之前**设好（本文件用动态 import）。
 * Node 的 `node --test` 每个测试文件独立进程 ⇒ 进程级 env / `:memory:` 库互不串扰。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）
process.env["SYNC_BUDGET_MS"] = "300"; // 缩短同步预算，令「超预算 working」可快速断言
process.env["POLL_INTERVAL_MS"] = "40";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTask,
  getQueuedTask,
  runnerProjectsReplace,
  upsertRunner,
} from "../session/store.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 夹具：**零出站**计数桩（A6 后桥不再直连 machine / A2A；任何 fetch 即用例失败）
// ---------------------------------------------------------------------------

let outboundCount = 0;
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;
const throwingFetch: FetchFn = async (input) => {
  outboundCount += 1;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`单测未预期的出站请求（A6 后桥侧出站应已退役）：${url}`);
};
globalThis.fetch = throwingFetch;

const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-a4-dispatch-"));
const CFG_PATH = join(CFG_DIR, "config.json");
process.env["MACHINES_CONFIG"] = CFG_PATH; // 必须在 import bridge/index.js **之前**

/** 写机器清单：选择性项目组（m1 仅声明成员项目；未声明者 ⇒ project_not_a_member） */
function writeConfig(members: Array<{ machineId: string; projectId: string }>): void {
  writeFileSync(
    CFG_PATH,
    JSON.stringify({ machines: [{ machineId: "m1" }], projectGroup: { members } }, null, 2),
    "utf8",
  );
}

writeConfig([{ machineId: "m1", projectId: "alpha" }]);

// 动态 import：`MACHINES_CONFIG` / `SYNC_BUDGET_MS` / `POLL_INTERVAL_MS` 此刻才被求值
const { createCore, dispatchTask } = await import("../bridge/index.js");
const core: BridgeCore = createCore();

// A6：注册表投影 = `alpha` 的落点（替代旧出站 `GET /projects` 扫描）
upsertRunner({ runnerId: "m1", machineId: "m1", protocolVersion: "2.0" });
runnerProjectsReplace("m1", [
  { projectId: "alpha", agentKind: "opencode", a2aPort: 3010, status: "online" },
]);

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(CFG_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 出参收窄（不引入 `any`）
// ---------------------------------------------------------------------------

interface FailureShape {
  ok: false;
  code: string;
  error: string;
}

function isFailure(v: unknown): v is FailureShape {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
}

interface CallSuccessShape {
  ok: true;
  status: string;
  text: string;
  taskId?: string;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test("② 成员错同步 fail-fast：零出站请求 + 零脏行（不入队 / 不建行）", async () => {
  outboundCount = 0;

  // 直接接缝：dispatchTask 首行成员断言
  const denied = await dispatchTask({
    taskId: "t-ghost",
    projectId: "ghost",
    contextId: "c-ghost",
    wait: true,
    newTask: { prompt: "hi", dispatchMessage: "hi" },
  });
  assert.equal(denied.ok, false);
  if (denied.ok) throw new Error("unreachable");
  assert.equal(denied.code, "project_not_a_member");
  assert.equal(outboundCount, 0, "非成员必须在任何前置 I/O 之前失败（零出站）");
  assert.equal(getQueuedTask("t-ghost"), null, "失败路径不得入队（无脏行）");

  // 对外工具面：a2a_call(inquiry) 走同一断言
  const viaCall = await core.call("ghost", "hi", undefined, true);
  assert.equal(isFailure(viaCall), true);
  if (!isFailure(viaCall)) throw new Error("unreachable");
  assert.equal(viaCall.code, "project_not_a_member");
  assert.equal(outboundCount, 0, "工具面非成员派发同样必须零出站请求");
});

test("③ 超预算：返回 working + taskId，且任务已落盘 queued（先落盘再报告）", async () => {
  outboundCount = 0;
  const outcome = await core.call("alpha", "请回答一个问题", undefined, true);
  assert.equal(isFailure(outcome), false, `期望成功外壳，实得：${JSON.stringify(outcome)}`);
  const res = outcome as CallSuccessShape;
  assert.equal(res.status, "working", "无 Runner 领取 ⇒ 超预算后返回 working");
  assert.equal(typeof res.taskId, "string");
  assert.notEqual(res.taskId, undefined);

  const taskId = res.taskId ?? "";
  const queued = getQueuedTask(taskId);
  assert.notEqual(queued, null, "返回句柄前任务必须已落盘");
  assert.equal(queued?.queueState, "queued", "无 Runner 在线 ⇒ 照常入队、不拒绝、不判失败");
  assert.notEqual(queued?.dispatchGuard, null, "入队即写 dispatch_guard（幂等键 / 已发出占位）");
  assert.equal(queued?.projectId, "alpha");
  assert.equal(outboundCount, 0, "入队路径零出站");
});

test("① enqueue 幂等：同 taskId 二次入队零写入（queued_at 不刷新、FIFO 位次不变）", async () => {
  createTask({
    taskId: "t-idem",
    projectId: "alpha",
    contextId: "c-idem",
    state: "working",
    dispatchMessage: "hi",
  });

  const first = await dispatchTask({
    taskId: "t-idem",
    projectId: "alpha",
    contextId: "c-idem",
    wait: false,
    newTask: null,
  });
  assert.equal(first.ok, true);
  const afterFirst = getQueuedTask("t-idem");
  assert.equal(afterFirst?.queueState, "queued");
  const queuedAtAfterFirst = afterFirst?.queuedAt ?? null;
  assert.notEqual(queuedAtAfterFirst, null);

  const second = await dispatchTask({
    taskId: "t-idem",
    projectId: "alpha",
    contextId: "c-idem",
    wait: false,
    newTask: null,
  });
  assert.equal(second.ok, true);
  const afterSecond = getQueuedTask("t-idem");
  assert.equal(afterSecond?.queueState, "queued");
  assert.equal(
    afterSecond?.queuedAt ?? null,
    queuedAtAfterFirst,
    "幂等：重复入队不得刷新 queued_at（不改变 FIFO 位次）",
  );
});
