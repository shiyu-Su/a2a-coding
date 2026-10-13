/**
 * v0.8.9 O2 行为锚 · 「未渲染 base」与「渲染结果」分离（节点 O2）。
 *
 * 锚命题（改造文档 §2 纯丙 / 节点任务书「行为锚」）：**同一节点连续 3 次派发**
 * （首派 + `answer` 澄清续推 + `retryTaskIds` 失败重派）后 ——
 * - `tasks.dispatch_message`（base）里 `<feature-context>` 出现 **0 次**（恒干净、可原样重放）；
 * - `tasks.dispatch_rendered`（本轮下发快照）里 `<feature-context>` 恰出现 **1 次**（不叠加）。
 *
 * 历史行兜底（`dispatch_rendered = NULL` ⇒ 领取侧 `?? dispatch_message`）：
 * ① 本文件轮 1 前用裸 `createTask`（不写 rendered）证明「未渲染 ⇒ NULL」；
 * ② 既有 `runner-endpoints` / `o1-sixclass` 等用例创建的队列行均不带 rendered，
 *    `toDispatchCommand` 改动后其下发文本逐字不变（全绿即回归覆盖）。
 *
 * 夹具同 `a4-dispatch-queue.test.ts`：`:memory:` 库 + 缩短同步预算 + 零出站桩。
 */
process.env["SESSION_DB"] = ":memory:";
process.env["SYNC_BUDGET_MS"] = "300";
process.env["POLL_INTERVAL_MS"] = "40";
process.env["TASK_WATCHER_POLL_INTERVAL_MS"] = "50";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getFeature,
  getQueuedTask,
  getTask,
  projectVersionCreate,
  runnerProjectsReplace,
  updateFeatureContext,
  upsertRunner,
  upsertTaskResult,
  versionLedgerCreate,
} from "../session/store.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 夹具：零出站计数桩（任何 fetch 即失败）+ 机器清单（m1/alpha，组 g1）
// ---------------------------------------------------------------------------

let outboundCount = 0;
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;
const throwingFetch: FetchFn = async (input) => {
  outboundCount += 1;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`单测未预期的出站请求（pull 模型桥侧零出站）：${url}`);
};
globalThis.fetch = throwingFetch;

const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-o2-render-"));
const CFG_PATH = join(CFG_DIR, "config.json");
process.env["MACHINES_CONFIG"] = CFG_PATH; // 必须在 import bridge/index.js **之前**
writeFileSync(
  CFG_PATH,
  JSON.stringify(
    {
      machines: [{ machineId: "m1" }],
      projectGroup: [{ name: "g1", members: [{ machineId: "m1", projectId: "alpha" }] }],
    },
    null,
    2,
  ),
  "utf8",
);

const { createCore } = await import("../bridge/index.js");
const core: BridgeCore = createCore();

upsertRunner({ runnerId: "m1", machineId: "m1", protocolVersion: "2.0" });
runnerProjectsReplace("m1", [
  { projectId: "alpha", agentKind: "opencode", a2aPort: 3010, status: "online" },
]);

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(CFG_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${what}`);
    await sleep(25);
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function okOrThrow<T extends { ok: boolean }>(
  v: T,
  what: string,
): Extract<T, { ok: true }> {
  assert.equal(v.ok, true, `${what} 应成功：${JSON.stringify(v)}`);
  return v as Extract<T, { ok: true }>;
}

/** 一轮派发完成的判据：渲染快照含本轮 plan 标记 && 节点已重新入队（guard 占位） */
function dispatchRoundDone(taskId: string, planMarker: string): boolean {
  const task = getTask(taskId);
  const queued = getQueuedTask(taskId);
  return (
    (task?.dispatchRendered ?? "").includes(planMarker) &&
    queued !== null &&
    queued.dispatchGuard !== null &&
    queued.queueState === "queued"
  );
}

/**
 * 批释放判据：`dispatchFeatureNode` 内 `dispatchTask(wait:true)` 要等满同步预算
 * （SYNC_BUDGET_MS=300）才走批 `finally`（清 `inFlightNodes`/`reservedProjects`）；
 * 入队可见 ≠ 批已释放 ⇒ 下一次 kick 必须晚于批收尾，否则就绪计算被在飞标记挡掉。
 */
const quiesce = (): Promise<void> => sleep(400);

/** v0.10.5 O7 夹具用版号（{@link toDecomposingFeature}） */
const RS_GROUP_VERSION = "0.10.5-rs.0";
const RS_PROJECT_VERSION = "1.0.0";

/**
 * v0.10.5 O7：建一张停在 `decomposing` 的卡（**可挂载、不派发** —— 调度器只领 `executing` 的节点）。
 *
 * 原形态「create → registerFeatureNode → approve」依赖两处旧契约（`create` 缺省即 `待审批`、
 * `waiting_approval` 可挂载），随 v0.10.5 O4 一并作废。新序列 = `advance(version)` →
 * `advance(stage=改造方案)` → `advance(approval=待审批)` → `approve`（落 `version_planning`）→
 * `advance(decomposing, 带归属)`，**停在本格**：登记节点 → 断言「登记态 rendered = NULL」→
 * 由用例在此处 `advance(executing)` 顶替原来的 `approve` 位置触发起派。
 */
function toDecomposingFeature(title: string): string {
  const fid = okOrThrow(core.featureCreate({ title }), "featureCreate").featureId;
  versionLedgerCreate({ ownerGroup: null, version: RS_GROUP_VERSION });
  projectVersionCreate({ ownerGroup: null, projectId: "alpha", version: RS_PROJECT_VERSION });
  okOrThrow(
    core.featureAdvance({ featureId: fid, to: "waiting_approval", version: RS_GROUP_VERSION }),
    "排期写 version",
  );
  okOrThrow(
    // 门① 第二前提（增补 bbc7ea28 O3）：抬 stage 须已登记《需求确认单》档名
    core.featureAdvance({
      featureId: fid,
      to: "waiting_approval",
      stage: "改造方案",
      decisions: '["doc/v0.8.9/夹具-需求确认单.md","doc/v0.8.9/夹具-改造文档.md"]',
    }),
    "门① 抬 stage",
  );
  okOrThrow(
    core.featureAdvance({ featureId: fid, to: "waiting_approval", approval: "待审批" }),
    "approval 置待审批",
  );
  okOrThrow(core.featureApprove({ featureId: fid }), "approve（唯一准入）");
  okOrThrow(
    core.featureAdvance({
      featureId: fid,
      to: "decomposing",
      projectVersions: [{ projectId: "alpha", version: RS_PROJECT_VERSION }],
    }),
    "出 version_planning 格（带归属）",
  );
  // 门① 那单登记的《需求确认单》不是本文件的外壳断言对象 ⇒ 过门后清回空（增补 bbc7ea28 O3 连带）
  updateFeatureContext(fid, { decisions: null });
  return fid;
}

/** 出 `decomposing` 格进 `executing`（起派扳机 = 原 `approve` 的位置） */
function enterExecuting(fid: string): void {
  okOrThrow(core.featureAdvance({ featureId: fid, to: "executing" }), "出 decomposing 格");
}

// ---------------------------------------------------------------------------
// 行为锚：同一节点 3 次派发（首派 / answer 续推 / retryTaskIds 重派）
// ---------------------------------------------------------------------------

test("v0.8.9 O2 行为锚：3 次派发后 dispatch_message 0 个外壳、dispatch_rendered 恰 1 个", async () => {
  const BASE = "任务正文O2";
  const fid = toDecomposingFeature("O2 渲染分离");
  updateFeatureContext(fid, { plan: "方案v1" });

  const registered = okOrThrow(
    core.registerFeatureNode("alpha", BASE, undefined, fid, []),
    "registerFeatureNode",
  );
  const taskId = registered.taskId ?? "";
  assert.ok(taskId.length > 0);

  // 派发前：未写 rendered ⇒ NULL（历史行/登记态口径，领取侧走 ?? dispatch_message 兜底）
  assert.equal(getTask(taskId)?.dispatchRendered, null, "登记后 rendered 应为 NULL");

  // ---- 轮 1：出 decomposing 格（进 executing）→ 调度器首派 ----
  // （原形态在此 `approve`；v0.10.5 O7 起过门前移、本格是「登记完才起派」的扳机）
  enterExecuting(fid);
  core.kickScheduler();
  await waitFor(() => dispatchRoundDone(taskId, "方案v1"), "轮 1 首派落库");
  await quiesce();

  let task = getTask(taskId);
  assert.equal(task?.dispatchMessage, BASE, "轮 1 后 base 逐字不变（渲染不回写）");
  assert.equal(
    task?.dispatchRendered,
    `<feature-context>\n## 统一方案（plan）\n方案v1\n</feature-context>\n\n---\n\n${BASE}`,
    "轮 1 渲染快照 = 壳 + 分隔 + base（精确全文）",
  );

  // ---- 轮 2：Runner 上报 input-required → answer 澄清续推 ----
  upsertTaskResult({
    machineId: "m1",
    taskId,
    projectId: "alpha",
    contextId: task?.contextId ?? "",
    state: "input-required",
    text: "需要澄清",
    featureId: fid,
    remoteTaskId: "r-1",
  });
  await waitFor(() => getFeature(fid)?.state === "needs_input", "看护上报 → Feature needs_input");
  okOrThrow(
    core.featureAdvance({ featureId: fid, to: "executing", answer: "用户答复甲", note: "方案v2" }),
    "answer 续推 advance",
  );
  task = getTask(taskId);
  assert.equal(
    task?.dispatchMessage,
    `${BASE}\n\n[用户澄清]\n用户答复甲`,
    "澄清只追加进 base（不追加壳）",
  );

  core.kickScheduler();
  await waitFor(() => dispatchRoundDone(taskId, "方案v2"), "轮 2 续推派发落库");
  await quiesce();
  task = getTask(taskId);
  assert.equal(
    countOccurrences(task?.dispatchMessage ?? "", "<feature-context>"),
    0,
    "轮 2 后 base 仍 0 个外壳",
  );

  // ---- 轮 3：Runner 上报 failed → retryTaskIds 原样重放 base ----
  upsertTaskResult({
    machineId: "m1",
    taskId,
    projectId: "alpha",
    contextId: task?.contextId ?? "",
    state: "failed",
    text: "执行失败",
    featureId: fid,
    remoteTaskId: "r-2",
  });
  await waitFor(() => getTask(taskId)?.state === "failed", "轮 3 前置：节点 failed");
  okOrThrow(
    core.featureAdvance({ featureId: fid, to: "executing", retryTaskIds: [taskId], note: "方案v3" }),
    "retryTaskIds 重派 advance",
  );
  core.kickScheduler();
  await waitFor(() => dispatchRoundDone(taskId, "方案v3"), "轮 3 重派派发落库");

  // ---- 终锚 ----
  task = getTask(taskId);
  const base = task?.dispatchMessage ?? "";
  const rendered = task?.dispatchRendered ?? "";
  assert.equal(countOccurrences(base, "<feature-context>"), 0, "3 次派发后 base 外壳 0 次");
  assert.equal(countOccurrences(base, "</feature-context>"), 0, "3 次派发后 base 闭壳 0 次");
  assert.equal(countOccurrences(rendered, "<feature-context>"), 1, "3 次派发后快照外壳恰 1 次");
  assert.equal(
    rendered,
    `<feature-context>\n## 统一方案（plan）\n方案v3\n</feature-context>\n\n---\n\n` +
      `${BASE}\n\n[用户澄清]\n用户答复甲`,
    "轮 3 快照 = 最新壳 + 含澄清的 base（重派只原样重放 base，无历史壳残留）",
  );
  assert.equal(outboundCount, 0, "全程零出站");

  // 收尾：轮 3 派发起的看护仍在轮询 ⇒ 以 completed 上报令其结算退出（不结算则句柄滞留）
  upsertTaskResult({
    machineId: "m1",
    taskId,
    projectId: "alpha",
    contextId: task?.contextId ?? "",
    state: "completed",
    text: "收尾",
    featureId: fid,
    remoteTaskId: "r-3",
  });
  await quiesce();
});

// ---------------------------------------------------------------------------
// 兜底路径说明：`dispatch_rendered = NULL`（历史行 / 独立单任务）⇒ 领取文本走
// `dispatch_message`，与改前逐字一致。真实 HTTP 领取路径由
// `test/runner-endpoints.test.ts`「成员项目任务：可 claim」用例断言 `command.message`
// 覆盖（其种子行不写 rendered）；登记态 rendered=NULL 由上方行为锚第一断言覆盖。
// ---------------------------------------------------------------------------
