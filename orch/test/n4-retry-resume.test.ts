/**
 * N4（REQ-v0.6.1-2026-09-17-05 §2.3）行为锁定 —— **重派与解冻**（`retryTaskIds`）。
 *
 * 覆盖（对应改造文档 §4.1 判据）：
 * - **V4**：重派成功路径（`rearmForRetry` 复用 + 解冻闭包外下游 + `task.rearmed` 留痕）·
 *   空数组 / 非法 id（**逐 id 报因、整单拒绝、不静默跳过**）/ 与 `answer` 同传 / `to` 非 executing
 *   ⇒ 结构化错误且 **Feature 态与节点态零变更**（不抖振）；
 * - **不给 `TRANSITIONS` 加自环**：不传 `retryTaskIds` 时 `executing → executing` 仍被状态机拒；
 * - **V5**：已派发（`remoteTaskId !== null`）被冻节点解冻 ⇒ **不清 `remote_task_id`、不动 `finished_at`**；
 * - **解冻全量确定性**：闭包**内**（仍有未重派失败上游）的 `blocked` 保持冻结；
 * - **needs_input 单源**：`answer` 续推路径不受影响、且与 `retryTaskIds` 互斥（不串味）；
 * - **I3 留痕**（宿主裁定 (a)）：封存早退（`needs_input` / 静止期）的结算**必有痕**
 *   （`transition_skipped` / code `sealed_settle`）—— #86 由本事件承载（N7 改写该断言）。
 *
 * 独立成文件（不与 `scheduler.test.ts` / `feature-tools.test.ts` 混写）：N4 的验收断言与后续
 * 「测试重写」节点（N7）的改动面解耦，便于逐节点核验时单独跑。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 * 隔离：默认库固定 `:memory:`，每个用例先 `close()` 重置为空库。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  close,
  createFeature,
  createTask,
  getFeature,
  getTask,
  listEvents,
  listFeatureTasks,
  markTaskDispatched,
  updateTaskState,
} from "../session/store.js";
import { EVENT_TASK_REARMED, handleFeatureAdvance } from "../bridge/feature-tools.js";
import {
  EVENT_FEATURE_TRANSITION_SKIPPED,
  FeatureScheduler,
  computeReadyNodes,
  descendantClosure,
  planResume,
} from "../bridge/scheduler.js";
import type { FeatureState, TaskRecord, TaskState } from "../types.js";

process.env["SESSION_DB"] = ":memory:";

/** 本 Feature 的 `task.rearmed` 事件 */
function rearmEvents(featureId: string) {
  return listEvents({ limit: 500 }).filter(
    (e) => e.kind === EVENT_TASK_REARMED && e.featureId === featureId,
  );
}

/** 构造测试用 TaskRecord（仅提供断言关心的字段） */
function node(
  id: string,
  state: TaskState,
  dependencies: string[] | null = null,
  remoteTaskId: string | null = null,
): TaskRecord {
  return {
    taskId: id,
    projectId: "p1",
    contextId: `ctx-${id}`,
    state,
    // v0.8.10 O-N1：并发档；纯函数构造取缺省档（write = 参与串行门）
    lane: "write",
    // v0.10.2 O-1：职责位；纯函数构造取缺省档（unit_agent = 本字段引入前的唯一行为）
    taskType: "unit_agent",
    artifactsJson: null,
    text: null,
    prompt: null,
    updatedAt: "2026-01-01T00:00:00Z",
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    featureId: "f1",
    dependencies,
    inputArtifacts: null,
    remoteTaskId,
    // v0.6.1 REQ-05 §2.5（N6/C11）：派发占位键；纯函数构造取中性值（未发出）
    dispatchGuard: null,
    dispatchMessage: null,
    retryCount: 0,
    failureKind: null,
    exhausted: false,
    notBefore: null,
    lastPollAt: null,
  };
}

/**
 * 建 Feature + 节点：节点先按 `working` 落库，再 `markTaskDispatched`（可选）后置目标态
 * —— 走真实的 CAS / `finished_at` 口径，避免"手工造记录"掩盖路径差异。
 */
function setup(
  featureId: string,
  featureState: FeatureState,
  specs: Array<{ id: string; goal: TaskState; deps?: string[]; remote?: string }>,
): void {
  createFeature({ featureId, title: featureId, state: featureState });
  for (const spec of specs) {
    createTask({
      taskId: spec.id,
      projectId: "p1",
      contextId: `ctx-${spec.id}`,
      state: "working",
      featureId,
      dependencies: spec.deps ?? null,
    });
    if (spec.remote !== undefined) markTaskDispatched(spec.id, spec.remote);
    if (spec.goal !== "working") updateTaskState(spec.id, spec.goal, null, "boom");
  }
}

// ---------------------------------------------------------------------------
// 纯函数：可达闭包 ≠「谁应被新冻」
// ---------------------------------------------------------------------------

test("N4 · descendantClosure / planResume：解冻判定用**可达闭包**（blocked 不在 propagateBlocked 返回值里）", () => {
  const nodes: TaskRecord[] = [
    node("A", "failed"),
    node("A2", "failed"),
    node("B", "blocked", ["A"]),
    node("D", "blocked", ["A2"]),
    node("E", "working", ["B"]),
  ];
  // 可达闭包含 roots 自身与所有（含已 blocked 的）下游
  assert.deepEqual([...descendantClosure(["A2"], nodes)].sort(), ["A2", "D"]);

  // 重派 A：A 退出 failed ⇒ B 不在剩余失败集（A2）的闭包内 ⇒ 解冻；D 仍在 ⇒ 保持冻结
  const plan = planResume(nodes, ["A"]);
  assert.deepEqual(plan.invalid, []);
  assert.deepEqual(plan.rearmIds, ["A"]);
  assert.deepEqual(plan.unfreezeIds, ["B"]);
  assert.deepEqual(plan.keepBlockedIds, ["D"]);

  // 非法 id（blocked）⇒ invalid 非空且**不给部分重派集**
  const bad = planResume(nodes, ["B"]);
  assert.equal(bad.invalid.length, 1);
  assert.equal(bad.invalid[0]?.taskId, "B");
  assert.deepEqual(bad.rearmIds, []);
  assert.deepEqual(bad.unfreezeIds, []);
});

// ---------------------------------------------------------------------------
// V4：成功路径
// ---------------------------------------------------------------------------

test("N4 · V4 重派成功：failed → working（清 remote/finished、retry_count+1）+ 解冻闭包外 blocked + task.rearmed", () => {
  close();
  setup("f-ok", "executing", [
    { id: "A", goal: "failed" },
    { id: "B", goal: "blocked", deps: ["A"] },
  ]);

  const out = handleFeatureAdvance({ featureId: "f-ok", to: "executing", retryTaskIds: ["A"] });
  if (!out.ok) assert.fail(`应成功：${out.code} ${out.error}`);

  assert.equal(out.featureId, "f-ok");
  assert.deepEqual(out.rearmed, ["A"]);
  assert.deepEqual(out.unfrozen, ["B"]);
  // 相等值回显：本路径无状态转移
  assert.equal(out.from, "executing");
  assert.equal(out.state, "executing");

  const a = getTask("A");
  assert.equal(a?.state, "working", "重派回待派发");
  assert.equal(a?.remoteTaskId, null, "rearmForRetry 清 remote_task_id");
  assert.equal(a?.finishedAt, null, "rearmForRetry 清 finished_at（回到未完成）");
  assert.equal(a?.retryCount, 1, "记账自增（字段语义休眠，但写口仍计）");

  assert.equal(getTask("B")?.state, "working", "闭包外 blocked 解冻");
  assert.equal(getFeature("f-ok")?.state, "executing", "Feature 态不变");

  // 「重派」须**真的可再派**：回到待派发后必须落进调度器的就绪集（否则只是状态翻转、任务不会跑）
  const ready = computeReadyNodes(listFeatureTasks("f-ok", { limit: 1000 }));
  assert.deepEqual(
    ready.map((n) => n.taskId),
    ["A"],
    "重派节点回到就绪集（remote 已清 + 依赖满足）；被解冻的 B 因上游 A 未 completed 仍不就绪",
  );

  const events = rearmEvents("f-ok");
  assert.equal(events.length, 1, "每个成功重派恰一条 task.rearmed");
  assert.equal(events[0]?.taskId, "A");
  assert.equal(events[0]?.state, "working", "events.state = 重派后的实际节点态");
  assert.equal(JSON.parse(events[0]?.payload ?? "{}")["contextId"], "ctx-A", "payload 带节点会话（供核对同 ctx 续接）");
});

test("N4 · V4 部分重派：闭包**内**（仍有未重派失败上游）的 blocked 保持冻结", () => {
  close();
  setup("f-keep", "executing", [
    { id: "A", goal: "failed" },
    { id: "A2", goal: "failed" },
    { id: "B", goal: "blocked", deps: ["A"] },
    { id: "D", goal: "blocked", deps: ["A2"] },
  ]);

  const out = handleFeatureAdvance({ featureId: "f-keep", to: "executing", retryTaskIds: ["A"] });
  if (!out.ok) assert.fail(`应成功：${out.code} ${out.error}`);

  assert.deepEqual(out.rearmed, ["A"]);
  assert.deepEqual(out.unfrozen, ["B"]);
  assert.equal(getTask("D")?.state, "blocked", "A2 未重派 ⇒ D 仍在闭包内，不得解冻");
  assert.equal(getTask("A2")?.state, "failed", "未点名的 failed 节点不动");
});

// ---------------------------------------------------------------------------
// V4：拒绝面（且 Feature / 节点态零变更）
// ---------------------------------------------------------------------------

test("N4 · V4 不传拒绝：空数组 ⇒ feature_nothing_to_resume，零写入", () => {
  close();
  setup("f-empty", "executing", [{ id: "A", goal: "failed" }]);

  const out = handleFeatureAdvance({ featureId: "f-empty", to: "executing", retryTaskIds: [] });
  assert.equal(out.ok, false);
  if (out.ok) assert.fail("空数组必须被拒");
  assert.equal(out.code, "feature_nothing_to_resume");

  assert.equal(getTask("A")?.state, "failed", "拒绝路径不得改节点态");
  assert.equal(getFeature("f-empty")?.state, "executing");
  assert.equal(rearmEvents("f-empty").length, 0);
});

test("N4 · V4 非法 id 拒绝：未知 / 非 failed / 重复 **逐 id 报因**，整单拒绝（不做部分重派）", () => {
  close();
  setup("f-bad", "executing", [
    { id: "A", goal: "failed" },
    { id: "B", goal: "working" },
  ]);

  const out = handleFeatureAdvance({
    featureId: "f-bad",
    to: "executing",
    retryTaskIds: ["nope", "B", "A", "A"],
  });
  assert.equal(out.ok, false);
  if (out.ok) assert.fail("非法 id 必须被拒");
  assert.equal(out.code, "feature_nothing_to_resume");
  assert.match(out.error, /nope → 不属于本 Feature/);
  assert.match(out.error, /B → state=working/);
  assert.match(out.error, /A → 重复出现/);

  // 整单拒绝 ⇒ 合法项也不得被部分重派
  assert.equal(getTask("A")?.state, "failed", "部分重派被禁止");
  assert.equal(rearmEvents("f-bad").length, 0);
});

test("N4 · V4 冲突参数拒绝：retryTaskIds 与 answer 同传 ⇒ feature_conflicting_args，零写入", () => {
  close();
  setup("f-conflict", "executing", [{ id: "A", goal: "failed" }]);

  const out = handleFeatureAdvance({
    featureId: "f-conflict",
    to: "executing",
    retryTaskIds: ["A"],
    answer: "不该被用到",
  });
  assert.equal(out.ok, false);
  if (out.ok) assert.fail("互斥参数必须被拒");
  assert.equal(out.code, "feature_conflicting_args");
  assert.equal(getTask("A")?.state, "failed");
  assert.equal(rearmEvents("f-conflict").length, 0);
});

test("N4 · V4 to 非 executing / 终态 Feature 拒绝，零写入", () => {
  close();
  setup("f-args", "executing", [{ id: "A", goal: "failed" }]);
  const wrongTo = handleFeatureAdvance({ featureId: "f-args", to: "integrating", retryTaskIds: ["A"] });
  assert.equal(wrongTo.ok, false);
  if (wrongTo.ok) assert.fail("to 非 executing 必须被拒");
  assert.equal(wrongTo.code, "feature_invalid_args");
  assert.equal(getTask("A")?.state, "failed");

  close();
  setup("f-term", "cancelled", [{ id: "A", goal: "failed" }]);
  const terminal = handleFeatureAdvance({ featureId: "f-term", to: "executing", retryTaskIds: ["A"] });
  assert.equal(terminal.ok, false);
  if (terminal.ok) assert.fail("终态 Feature 必须被拒");
  assert.equal(terminal.code, "feature_terminal");
  assert.equal(getTask("A")?.state, "failed");
});

test("N4 · 无自环：不传 retryTaskIds 时 executing → executing 仍被状态机拒（feature_transition_invalid）", () => {
  close();
  setup("f-loop", "executing", [{ id: "A", goal: "failed" }]);

  const out = handleFeatureAdvance({ featureId: "f-loop", to: "executing" });
  assert.equal(out.ok, false);
  if (out.ok) assert.fail("executing → executing 必须被拒（转移表无自环）");
  assert.equal(out.code, "feature_transition_invalid");
  assert.equal(getTask("A")?.state, "failed");
  assert.equal(rearmEvents("f-loop").length, 0, "常规路径不得产生 task.rearmed");
});

// ---------------------------------------------------------------------------
// V5：已派发被冻节点解冻不清 remote_task_id（防同节点双派）
// ---------------------------------------------------------------------------

test("N4 · V5 解冻只改 state：已派发被冻节点 remote_task_id 不清、finished_at 不变、不计 retry_count", () => {
  close();
  setup("f-v5", "executing", [
    { id: "A", goal: "failed" },
    { id: "B", goal: "blocked", deps: ["A"], remote: "r-B" },
    { id: "C", goal: "blocked", deps: ["A"] },
  ]);
  const before = getTask("B");
  assert.equal(before?.remoteTaskId, "r-B");
  assert.notEqual(before?.finishedAt, null, "blocked 是终态口径 ⇒ 有 finished_at");

  const out = handleFeatureAdvance({ featureId: "f-v5", to: "executing", retryTaskIds: ["A"] });
  if (!out.ok) assert.fail(`应成功：${out.code} ${out.error}`);
  assert.deepEqual(out.unfrozen?.slice().sort(), ["B", "C"]);

  const b = getTask("B");
  assert.equal(b?.state, "working");
  assert.equal(b?.remoteTaskId, "r-B", "已派发被冻节点解冻**不得**清 remote_task_id（防同节点双派）");
  assert.equal(b?.finishedAt, before?.finishedAt, "不改变其 finished_at");
  assert.equal(b?.retryCount, 0, "解冻不是重派 ⇒ 不记账");

  const c = getTask("C");
  assert.equal(c?.state, "working");
  assert.equal(c?.remoteTaskId, null, "未派发被冻节点解冻后仍为未派发（可被调度）");
});

// ---------------------------------------------------------------------------
// needs_input 单源：answer 续推不与 retryTaskIds 串味
// ---------------------------------------------------------------------------

test("N4 · needs_input 单源：answer 续推照旧工作，且不产生 task.rearmed；与 retryTaskIds 互斥", () => {
  close();
  setup("f-ni", "needs_input", [{ id: "T", goal: "input-required" }]);

  const out = handleFeatureAdvance({ featureId: "f-ni", to: "executing", answer: "按 A 方案继续" });
  if (!out.ok) assert.fail(`answer 续推应成功：${out.code} ${out.error}`);
  assert.equal(getFeature("f-ni")?.state, "executing", "needs_input → executing 仍由常规路径承担");
  const t = getTask("T");
  assert.equal(t?.state, "working", "待澄清节点被重排");
  assert.match(t?.dispatchMessage ?? "", /\[用户澄清\]/, "answer 并入原消息（同 ctx 续接）");
  assert.equal(rearmEvents("f-ni").length, 0, "answer 路径是**单一来源**，不得写 task.rearmed");

  // 互斥：同传即拒（已在上方 V4 用例逐项断言，此处复核 code 语义不在 answer 路径被绕过）
  const both = handleFeatureAdvance({
    featureId: "f-ni",
    to: "executing",
    retryTaskIds: ["T"],
    answer: "x",
  });
  assert.equal(both.ok, false);
  if (both.ok) assert.fail("同传必须被拒");
  assert.equal(both.code, "feature_conflicting_args");
});

// ---------------------------------------------------------------------------
// I3 留痕（宿主裁定 (a)）：封存早退必有痕（#86 由本事件承载 → N7 改写断言）
// ---------------------------------------------------------------------------

test("N4 · I3：封存早退（needs_input）补 transition_skipped / code=sealed_settle，state=null、payload.to=目标态名", () => {
  close();
  createFeature({ featureId: "f-seal", title: "封存", state: "needs_input" });
  createTask({
    taskId: "T",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-seal",
  });
  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });

  scheduler.notifyTaskSettled("f-seal", "T", { state: "failed", text: "boom" });

  assert.equal(getFeature("f-seal")?.state, "needs_input", "封存期不得改 Feature 态");
  const events = listEvents({ limit: 500 }).filter(
    (e) => e.kind === EVENT_FEATURE_TRANSITION_SKIPPED,
  );
  assert.equal(events.length, 1, "封存早退**必须留痕**（I3：静默死信必有痕）");
  const payload = JSON.parse(events[0]?.payload ?? "{}") as Record<string, unknown>;
  assert.equal(payload["code"], "sealed_settle");
  assert.equal(payload["to"], "failed", "payload.to = 该 settle 的目标态名");
  assert.equal(payload["from"], "needs_input");
  assert.equal(events[0]?.state, null, "态没变 ⇒ events.state 必须为 null");
});
