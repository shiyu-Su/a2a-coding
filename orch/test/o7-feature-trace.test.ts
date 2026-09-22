/**
 * v0.8.8 §2.10(c) · 节点 O7：Trace 面只读查询「在等谁 / 排队位次」单元测试。
 *
 * 覆盖（验收判据逐条）：
 * - 同 project「一节点在飞（claimed）+ 另一节点已就绪未派发」⇒ 查询能答出
 *   **在等谁**（占用项目的节点 + 占位机 `claimed_by`）与**排队位次**（`queue_state='queued'
 *   ∧ created_at <` 我 的 FIFO 计数）；
 * - `blockedOn` 与真实依赖一致（未 completed 的直接依赖）；
 * - `projectBusy` 在无在飞节点时为 false（占用者完成后翻 false）；
 * - 项目忙判定走队列态（**不走 `remote_task_id`**——pull 模型下在飞期间恒 NULL）；
 * - 终态节点（completed / failed / blocked）不输出；`input-required` 归 `awaiting_user`；
 * - Feature 不在 `executing` ⇒ 就绪节点给 `feature_not_executing`；
 * - 纯读：查询前后 Feature 态与节点态**零变化**、不落库；
 * - 归属校验复用五出口同一判据（他组拒绝 / 未知 404 语义）；
 * - 网页端点 `GET /api/features/:featureId/trace` 复用同一 helper（200 / 404 / 405）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  claimTask,
  close,
  createFeature,
  createTask,
  enqueueTask,
  getFeature,
  getTask,
  updateTaskState,
} from "../session/store.js";
import { handleFeatureTrace, type FeatureTraceNode } from "../bridge/feature-tools.js";
import { startWebTransport } from "../bridge/transports/web.js";
import type { WebCore, WebTransportHandle } from "../bridge/transports/web.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function trace(featureId: string): FeatureTraceNode[] {
  const outcome = handleFeatureTrace({ featureId });
  if (!outcome.ok) throw new Error(`trace 期望成功：${outcome.code} ${outcome.error}`);
  return outcome.nodes;
}

function nodeOf(nodes: FeatureTraceNode[], taskId: string): FeatureTraceNode {
  const node = nodes.find((n) => n.taskId === taskId);
  assert.ok(node !== undefined, `trace 应含节点 ${taskId}`);
  return node;
}

// ---------------------------------------------------------------------------
// 主场景：同 project 一节点在飞 + 另一节点已就绪未派发
// ---------------------------------------------------------------------------

test("O7 主场景：在飞 + 就绪未派发 ⇒ 答出「在等谁」（占用节点/占位机）与「排队位次」", async () => {
  close();
  createFeature({ featureId: "f-o7", title: "trace", state: "executing" });

  // T5：他 Feature / 他项目的 queued 任务（提供「排队在我前面」的位次原料，created 最早）
  createTask({ taskId: "T5", projectId: "p2", contextId: "c5", state: "working" });
  enqueueTask("T5");
  await sleep(3); // created_at 毫秒级：拉开严格先后

  // T0：已完成的依赖（T2 依赖它 ⇒ T2 拓扑就绪）
  createTask({ taskId: "T0", projectId: "p1", contextId: "c0", state: "completed", featureId: "f-o7" });
  await sleep(3);

  // T1：在飞节点（入队后被 m1 领取 ⇒ queue_state='claimed'，claimed_by=m1）
  createTask({ taskId: "T1", projectId: "p1", contextId: "c1", state: "working", featureId: "f-o7" });
  enqueueTask("T1");
  assert.equal(
    claimTask({ claimedBy: "m1", projectIds: ["p1"] })?.taskId,
    "T1",
    "T1 应被 m1 领取",
  );
  await sleep(3);

  // T2：依赖全 completed（就绪）但同项目被 T1 占用 ⇒ 未派发
  createTask({
    taskId: "T2",
    projectId: "p1",
    contextId: "c2",
    state: "working",
    featureId: "f-o7",
    dependencies: ["T0"],
  });
  // T3：依赖 T1（在飞）⇒ blockedOn = ["T1"]
  createTask({
    taskId: "T3",
    projectId: "p1",
    contextId: "c3",
    state: "working",
    featureId: "f-o7",
    dependencies: ["T1"],
  });
  // T4/T6：终态节点（failed / blocked）⇒ 不进 trace
  createTask({ taskId: "T4", projectId: "p1", contextId: "c4", state: "failed", featureId: "f-o7" });
  createTask({ taskId: "T6", projectId: "p1", contextId: "c6", state: "blocked", featureId: "f-o7" });
  // T7：待澄清
  createTask({ taskId: "T7", projectId: "p3", contextId: "c7", state: "input-required", featureId: "f-o7" });

  const nodes = trace("f-o7");
  assert.deepEqual(
    nodes.map((n) => n.taskId).sort(),
    ["T1", "T2", "T3", "T7"],
    "只输出非终态节点（failed/blocked 不进账）",
  );

  // ---- 在飞节点 T1：running_remote；自己不算「别人占用」 ----
  const t1 = nodeOf(nodes, "T1");
  assert.equal(t1.queueState, "claimed", "队列态取 queue_state（claimed = 在飞）");
  assert.equal(t1.waitReason, "running_remote");
  assert.equal(t1.projectBusy.busy, false, "同项目无其它忙节点 ⇒ 不判被占");
  assert.equal(t1.position, null, "在飞（非 queued）不给位次");
  assert.ok(t1.waitedSince !== null, "等待起点 = 领取时刻");

  // ---- 就绪未派发节点 T2：project_busy + 在等谁 + 排队位次 ----
  const t2 = nodeOf(nodes, "T2");
  assert.equal(t2.queueState, null, "未入队 ⇒ null（不是 settled 误导值）");
  assert.deepEqual(t2.blockedOn, [], "依赖 T0 已 completed ⇒ 无阻塞依赖");
  assert.equal(t2.projectBusy.busy, true, "同项目 T1 在飞 ⇒ 忙");
  assert.equal(t2.projectBusy.taskId, "T1", "在等谁：占用项目的节点");
  assert.equal(t2.projectBusy.machineId, "m1", "占位机 = 占用节点的 claimed_by");
  assert.equal(t2.waitReason, "project_busy");
  assert.equal(t2.position, 2, "位次：T5（更早的 queued 任务）排在我前面 ⇒ 第 2");
  assert.equal(t2.waitedSince, getTask("T2")?.createdAt, "未入队 ⇒ 等待起点 = 登记时刻");

  // ---- T3：blockedOn 与真实依赖一致 ----
  const t3 = nodeOf(nodes, "T3");
  assert.deepEqual(t3.blockedOn, ["T1"], "blockedOn = 未 completed 的直接依赖");
  assert.equal(t3.waitReason, "upstream_dependencies");

  // ---- T7：待澄清 ----
  const t7 = nodeOf(nodes, "T7");
  assert.equal(t7.waitReason, "awaiting_user");
  assert.equal(t7.queueState, null);
  assert.equal(t7.position, null);

  // ---- 纯读：查询前后账面零变化 ----
  assert.equal(getFeature("f-o7")?.state, "executing");
  assert.equal(getTask("T2")?.state, "working");
  assert.equal(getTask("T1")?.state, "working");
  close();
});

test("O7 projectBusy：占用者完成后翻 false（就绪节点转 ready_pending_dispatch）", async () => {
  close();
  createFeature({ featureId: "f-o7b", title: "trace-b", state: "executing" });
  createTask({ taskId: "U1", projectId: "p1", contextId: "u1", state: "working", featureId: "f-o7b" });
  enqueueTask("U1");
  assert.equal(
    claimTask({ claimedBy: "m9", projectIds: ["p1"] })?.taskId,
    "U1",
  );
  await sleep(3);
  createTask({ taskId: "U2", projectId: "p1", contextId: "u2", state: "working", featureId: "f-o7b" });

  const before = nodeOf(trace("f-o7b"), "U2");
  assert.equal(before.projectBusy.busy, true);
  assert.equal(before.projectBusy.taskId, "U1");

  updateTaskState("U1", "completed"); // 占用者落定 ⇒ 同项目不再忙
  const after2 = nodeOf(trace("f-o7b"), "U2");
  assert.equal(after2.projectBusy.busy, false, "无在飞节点 ⇒ projectBusy false");
  assert.equal(after2.projectBusy.taskId, null);
  assert.equal(after2.projectBusy.machineId, null);
  assert.equal(after2.waitReason, "ready_pending_dispatch");
  close();
});

test("O7 Feature 门：不在 executing ⇒ 就绪节点给 feature_not_executing", () => {
  close();
  createFeature({ featureId: "f-o7c", title: "trace-c", state: "waiting_approval" });
  createTask({ taskId: "V1", projectId: "p7", contextId: "v1", state: "working", featureId: "f-o7c" });
  const v1 = nodeOf(trace("f-o7c"), "V1");
  assert.equal(v1.waitReason, "feature_not_executing");
  assert.equal(v1.projectBusy.busy, false);
  close();
});

test("O7 入参面：未知 Feature ⇒ feature_not_found；他组 Feature 按同一归属判据拒绝", () => {
  close();
  assert.deepEqual(
    handleFeatureTrace({ featureId: "f-none" }),
    { ok: false, code: "feature_not_found", error: "未知 Feature f-none" },
  );
  createFeature({ featureId: "f-o7d", title: "trace-d", state: "executing", ownerGroup: "g1" });
  const denied = handleFeatureTrace({ featureId: "f-o7d" }, "g2");
  assert.ok(!denied.ok && denied.code === "feature_not_owned", "他组只读口同样拒绝");
  assert.equal(trace("f-o7d").length, 0, "无身份（web 运维面）⇒ 放行（该 Feature 零节点）");
  close();
});

// ---------------------------------------------------------------------------
// 网页端点：GET /api/features/:featureId/trace（复用同一 helper）
// ---------------------------------------------------------------------------

interface TraceJson {
  ok: boolean;
  code?: string;
  featureState?: string;
  nodes?: FeatureTraceNode[];
}

const openHandles: WebTransportHandle[] = [];
after(async () => {
  for (const handle of openHandles) await handle.close();
});

async function startTraceWeb(): Promise<number> {
  const core: WebCore = {
    projects: async () => ({ machines: [], runners: [], group: { name: null, selective: false, memberMachines: [] } }),
    tasks: async (projectId: string) => ({ ok: true, projectId, reachable: true, tasks: [] }),
    featureStatus: () => ({ ok: true, features: [] }),
  };
  const outcome = await startWebTransport({
    core,
    host: "127.0.0.1",
    port: 0,
    readiness: () => ({ role: "owner", pid: 1, startedAt: "2026-09-22T00:00:00Z" }),
    version: "0.8.8-test",
  });
  assert.equal(outcome.enabled, true, "网页接面应启用");
  if (!outcome.enabled) throw new Error("未启用");
  openHandles.push(outcome);
  return outcome.port;
}

test("O7 网页端点：/api/features/:id/trace 返回同一投影；未知 404；非 GET 405", async () => {
  close();
  createFeature({ featureId: "f-o7w", title: "trace-w", state: "executing" });
  createTask({ taskId: "W1", projectId: "p8", contextId: "w1", state: "working", featureId: "f-o7w" });
  const port = await startTraceWeb();

  const ok = await fetch(`http://127.0.0.1:${port}/api/features/f-o7w/trace`);
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as TraceJson;
  assert.equal(body.ok, true);
  assert.equal(body.featureState, "executing");
  assert.equal(nodeOf(body.nodes ?? [], "W1").waitReason, "ready_pending_dispatch");

  const missing = await fetch(`http://127.0.0.1:${port}/api/features/f-none/trace`);
  assert.equal(missing.status, 404);
  const wrongMethod = await fetch(`http://127.0.0.1:${port}/api/features/f-o7w/trace`, { method: "POST" });
  assert.equal(wrongMethod.status, 405);
  // 路径纪律：只认这一条二级子路径，其余仍 404
  const deeper = await fetch(`http://127.0.0.1:${port}/api/features/f-o7w/trace/x`);
  assert.equal(deeper.status, 404);
  close();
});
