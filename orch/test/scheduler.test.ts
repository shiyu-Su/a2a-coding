/**
 * `orch/bridge/scheduler.ts` 单元测试（`node:test`，无新依赖）。
 *
 * v0.6.1 REQ-05（N2 删五层）后本文件覆盖：
 * - 纯函数：`depStateOf`（依赖三态）/ `computeReadyNodes`（同批就绪）/ `propagateBlocked`
 *   （传递闭包）/ `reduceConvergence`（收敛判定，**已无 `failed` 臂**）；
 * - 单一事实源判据：`isUnhandledFailure`（未处置 failed）/ `isLocalTerminalTask`（本地终态，
 *   与 `bridge/index.ts` 合并为一份）；
 * - 调度器行为：同层整批并发派发、三层防重派、失败传播置 blocked（**Feature 不判死，保持
 *   `executing`**）、全 completed 自动 integrating、`recover()` 并行收敛语义；
 * - 静默路径留痕（`transition_skipped`，D1/I3）；
 * - **N2 删除面自检**：五层（分类 / 中性化 / 取证流 / 等回收门 / 条件重试）的进程内态与
 *   硬闸谓词不复存在，且 `task.retry` / `task.evidence` / `feature.pending_evidence_discarded`
 *   三类事件**零写入**、三个休眠列不再被写入。
 *
 * ✅ v0.6.1 REQ-05 §2.1（N3+ 已落地，v3 语义）：业务失败**不产出 Feature `failed` 终态** ——
 * 失败只冻结依赖闭包（未派发下游置 `blocked`），Feature 停在 `executing` 静止（账单 =
 * `feature.failure_report`，由 `n3-failure-rest.test.ts` 覆盖）；`recover()` 亦不 `failFeature`。
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
  EVENT_FEATURE_STATE,
  getFeature,
  getTask,
  listEvents,
  updateFeatureState,
  updateTaskState,
} from "../session/store.js";
import {
  EVENT_FEATURE_TRANSITION_SKIPPED,
  FeatureScheduler,
  computeReadyNodes,
  depStateOf,
  isLocalTerminalTask,
  isUnhandledFailure,
  propagateBlocked,
  reduceConvergence,
  type FeatureDispatchResult,
} from "../bridge/scheduler.js";
import * as schedulerModule from "../bridge/scheduler.js";
import type { TaskRecord, TaskState } from "../types.js";

// 默认存储固定内存库（getDefaultStore 首次调用时读取）
process.env["SESSION_DB"] = ":memory:";

/** 构造测试用 TaskRecord（仅提供断言关心的字段）；`over` 为字段覆盖口 */
function task(
  id: string,
  state: TaskState,
  dependencies: string[] | null = null,
  remoteTaskId: string | null = null,
  over: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    taskId: id,
    projectId: "p1",
    contextId: "c1",
    state,
    artifactsJson: null,
    text: null,
    prompt: null,
    updatedAt: "2026-01-01T00:00:00Z",
    // v0.5.0 三时刻列：调度判定不消费它们，默认取中性值（老记录形态 = 全 NULL）
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
    // v0.4.1 失败自动化列：**v0.6.1 REQ-05 起为休眠列**（引擎不读不写），此处取中性值
    retryCount: 0,
    failureKind: null,
    exhausted: false,
    notBefore: null,
    lastPollAt: null,
    // 字段覆盖口（N2 重写时预留、此前未被消费 ⇒ lint no-unused-vars；N6 顺手接线）
    ...over,
  };
}

function byIdOf(nodes: readonly TaskRecord[]): Map<string, TaskRecord> {
  return new Map(nodes.map((n) => [n.taskId, n]));
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("depStateOf：无依赖 / 上游 completed → completed", () => {
  const nodes = [task("A", "completed"), task("B", "working", ["A"]), task("C", "working")];
  const byId = byIdOf(nodes);
  assert.equal(depStateOf(nodes[1]!, byId), "completed");
  assert.equal(depStateOf(nodes[2]!, byId), "completed");
});

test("depStateOf：上游未完成 → pending", () => {
  const nodes = [task("A", "working"), task("B", "input-required"), task("C", "working", ["A", "B"])];
  assert.equal(depStateOf(nodes[2]!, byIdOf(nodes)), "pending");
});

test("depStateOf：上游 failed / blocked → upstreamFailed", () => {
  const failed = [task("A", "failed"), task("B", "working", ["A"])];
  assert.equal(depStateOf(failed[1]!, byIdOf(failed)), "upstreamFailed");
  const blocked = [task("A", "blocked"), task("B", "working", ["A"])];
  assert.equal(depStateOf(blocked[1]!, byIdOf(blocked)), "upstreamFailed");
});

test("computeReadyNodes：同批取所有 working 且依赖完成、未派发、不在飞者", () => {
  const nodes = [
    task("A", "working"),
    task("B", "working"),
    task("C", "working", ["A"]), // 依赖未完成
    task("D", "working", null, "r-D"), // 已派发（远端 id 非空）
    task("E", "completed"), // 非 working
  ];
  assert.deepEqual(
    computeReadyNodes(nodes).map((n) => n.taskId),
    ["A", "B"],
  );
});

test("computeReadyNodes：节点级在飞标记使其不可再被选中", () => {
  const nodes = [task("A", "working"), task("B", "working")];
  assert.deepEqual(
    computeReadyNodes(nodes, new Set(["A"])).map((n) => n.taskId),
    ["B"],
  );
  assert.deepEqual(computeReadyNodes(nodes, new Set(["A", "B"])), []);
});

test("computeReadyNodes：C11 占位已写（dispatchGuard ≠ null）⇒ 不 ready（防首 tick 重派）", () => {
  const nodes = [
    task("A", "working"),
    task("B", "working", null, null, { dispatchGuard: "2026-01-01T00:00:00Z" }),
  ];
  assert.deepEqual(
    computeReadyNodes(nodes).map((n) => n.taskId),
    ["A"],
    "占位非 NULL = 可能已发出 ⇒ 不得进就绪集（lifecycle: start() 的立即 tick 早于 recover()）",
  );
});

test("propagateBlocked：沿 dependencies 反向传递闭包（含多分支）", () => {
  const nodes = [
    task("A", "failed"),
    task("B", "working", ["A"]),
    task("C", "working", ["B"]),
    task("D", "working", ["A"]),
    task("E", "working"), // 无关联
  ];
  assert.deepEqual(new Set(propagateBlocked("A", nodes)), new Set(["B", "C", "D"]));
  assert.deepEqual(propagateBlocked("E", nodes), []);
});

test("propagateBlocked：中间节点已终态不阻断下探，且不改写非 working 节点", () => {
  const nodes = [
    task("A", "failed"),
    task("B", "completed", ["A"]), // 已完成：不置 blocked
    task("C", "working", ["B"]), // 但仍是 A 的下游闭包 → blocked
  ];
  assert.deepEqual(propagateBlocked("A", nodes), ["C"]);
});

test("reduceConvergence：input-required → needs_input", () => {
  assert.equal(reduceConvergence([task("A", "completed"), task("B", "input-required")]).kind, "needs_input");
});

test("reduceConvergence：全 completed → all_completed；否则 dispatch", () => {
  assert.equal(reduceConvergence([task("A", "completed"), task("B", "completed")]).kind, "all_completed");
  assert.equal(reduceConvergence([task("A", "completed"), task("B", "working")]).kind, "dispatch");
  assert.equal(reduceConvergence([task("A", "working")]).kind, "dispatch");
});

test("reduceConvergence：failed / blocked **不再判死**（无 failed 臂）⇒ 落回 dispatch", () => {
  // v0.6.1 REQ-05 §2.1：业务失败不产出 Feature failed 终态
  assert.equal(reduceConvergence([task("A", "failed")]).kind, "dispatch");
  assert.equal(reduceConvergence([task("A", "blocked")]).kind, "dispatch");
  assert.equal(reduceConvergence([task("A", "blocked"), task("B", "input-required")]).kind, "needs_input");
  // blocked 为**良性终态**：不计入「全 completed」（否则会把被冻的 Feature 误推进 integrating）
  assert.equal(reduceConvergence([task("A", "blocked"), task("B", "completed")]).kind, "dispatch");
  assert.equal(reduceConvergence([task("A", "failed"), task("B", "completed")]).kind, "dispatch");
});

test("reduceConvergence：空节点集不判 all_completed（不派发也不误判完成）", () => {
  assert.equal(reduceConvergence([]).kind, "dispatch");
});

// ---------------------------------------------------------------------------
// 单一事实源判据（v0.6.1 REQ-05 收窄）
// ---------------------------------------------------------------------------

test("isUnhandledFailure：单一事实源 —— 判据塌缩为 state === 'failed'（无中性化 / 无取证豁免）", () => {
  assert.equal(isUnhandledFailure({ state: "failed" }), true);
  assert.equal(isUnhandledFailure({ state: "working" }), false);
  assert.equal(isUnhandledFailure({ state: "blocked" }), false);
  assert.equal(isUnhandledFailure({ state: "completed" }), false);
  // 休眠列不参与判定：exhausted 置位（历史行可能仍在库）也不改变结论
  assert.equal(isUnhandledFailure(task("A", "failed", null, null, { exhausted: true })), true);

  // 模块面：失败豁免族与失败自动化的导出常量**整族删除**（防第二套判据复活）
  const mod = schedulerModule as unknown as Record<string, unknown>;
  for (const gone of [
    "isNeutered",
    "isNeuteredSettled",
    "isExemptFromFailure",
    "classifyFailure",
    "isPastNotBefore",
    "MAX_RETRY",
    "buildRetryMessage",
    "decideEvidenceOutcome",
    "EVIDENCE_NODE_MARKER",
    "markEvidenceMessage",
    "isEvidenceNode",
    "EVIDENCE_WAIT_MAX_MS",
    "EVIDENCE_POLL_MS",
    "EVIDENCE_READY_STREAK",
    "EVIDENCE_EVENT_KIND",
    "EVENT_TASK_RETRY",
    "EVENT_PENDING_EVIDENCE_DISCARDED",
  ]) {
    assert.equal(mod[gone], undefined, `scheduler 模块不得再导出 ${gone}（五层写侧 + 读侧同批删除）`);
  }
});

test("isLocalTerminalTask：本地终态 = {completed, failed, input-required, blocked}（与 index.ts 合一后唯一判据）", () => {
  assert.equal(isLocalTerminalTask(task("A", "completed")), true);
  assert.equal(isLocalTerminalTask(task("A", "failed")), true);
  assert.equal(isLocalTerminalTask(task("A", "blocked")), true);
  assert.equal(isLocalTerminalTask(task("A", "input-required")), true);
  assert.equal(isLocalTerminalTask(task("A", "working")), false);
  // 休眠列不参与（也不再有「exhausted 视作终态」那一支：改判为 failed 本就命中）
  assert.equal(isLocalTerminalTask(task("A", "working", null, null, { exhausted: true })), false);
});

// ---------------------------------------------------------------------------
// 调度器行为（内存库）
// ---------------------------------------------------------------------------

test("拓扑并行：同层无依赖节点（跨 project）在同一批并发派发，跨层仍按依赖串行", async () => {
  close();
  createFeature({ featureId: "f-par", title: "并行", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-par" });
  // v0.6.1 REQ-05 §2.5（N5）：**同 project 串行**已生效 ⇒ 本用例改用 p1/p2 表达
  // 「同批**跨 project**并发」（A/B 同 project 会被排队，只放行一个；见 n5-project-serial.test.ts V1）。
  createTask({ taskId: "B", projectId: "p2", contextId: "c1", state: "working", featureId: "f-par" });
  createTask({
    taskId: "C",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-par",
    dependencies: ["A"],
  });

  const started: string[] = [];
  const resolvers: Array<() => void> = [];
  let inflight = 0;
  let peak = 0;
  const scheduler = new FeatureScheduler({
    dispatch: (node) => {
      started.push(node.taskId);
      inflight += 1;
      peak = Math.max(peak, inflight);
      return new Promise<FeatureDispatchResult>((resolve) => {
        resolvers.push(() => {
          inflight -= 1;
          resolve({ ok: true });
        });
      });
    },
  });

  scheduler.kick(); // 同步段内完成就绪计算 + 整批启动
  assert.deepEqual(started.slice().sort(), ["A", "B"]);
  assert.equal(peak, 2, "A/B 应同时在飞（并发派发）");
  assert.ok(!started.includes("C"), "C 依赖 A，不应在本批派发");

  for (const release of resolvers) release();
  await new Promise((r) => setImmediate(r));
  assert.equal(getFeature("f-par")?.state, "executing");
});

test("三层防重派：派发进行中重复 kick 不重派同一节点", async () => {
  close();
  createFeature({ featureId: "f-dup", title: "防重", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-dup" });

  let calls = 0;
  let release: () => void = () => {};
  const scheduler = new FeatureScheduler({
    dispatch: () => {
      calls += 1;
      return new Promise<FeatureDispatchResult>((resolve) => {
        release = () => resolve({ ok: true });
      });
    },
  });

  scheduler.kick();
  assert.equal(calls, 1);
  scheduler.kick(); // 模拟 settle 重入
  scheduler.kick();
  assert.equal(calls, 1, "批门闩 + 在飞标记应拦下重派");

  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
});

test("失败传播：上游 failed → 下游传递闭包置 blocked，Feature 不判死（保持 executing）", () => {
  close();
  createFeature({ featureId: "f-fail", title: "失败", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-fail" });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-fail",
    dependencies: ["A"],
  });
  createTask({
    taskId: "C",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-fail",
    dependencies: ["B"],
  });

  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
  updateTaskState("A", "failed", null, "boom");
  scheduler.notifyTaskSettled("f-fail", "A", { state: "failed", text: "boom" });

  assert.equal(getTask("A")?.state, "failed");
  assert.equal(getTask("B")?.state, "blocked");
  assert.equal(getTask("C")?.state, "blocked");
  // v0.6.1 REQ-05 §2.1（v3）：业务失败**不产出 Feature failed 终态**（Feature 停在 executing 静止）
  assert.equal(getFeature("f-fail")?.state, "executing", "失败只冻结闭包，Feature 不判死");
});

test("派发失败：该节点置 failed + 下游 blocked + Feature 不判死（保持 executing）", async () => {
  close();
  createFeature({ featureId: "f-dispfail", title: "派发失败", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-dispfail" });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-dispfail",
    dependencies: ["A"],
  });

  const scheduler = new FeatureScheduler({
    dispatch: async () => ({ ok: false, error: "ensure 超时" }),
  });
  scheduler.kick();
  await new Promise((r) => setImmediate(r));

  assert.equal(getTask("A")?.state, "failed");
  assert.equal(getTask("B")?.state, "blocked");
  // v0.6.1 REQ-05 §2.1（v3）：派发失败同批只传播、不 failFeature（C1 同批不短路）
  assert.equal(getFeature("f-dispfail")?.state, "executing", "派发失败不判死整单");
});

test("收敛：全部任务 completed → Feature executing → integrating", () => {
  close();
  createFeature({ featureId: "f-done", title: "完成", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "completed", featureId: "f-done" });
  createTask({ taskId: "B", projectId: "p1", contextId: "c1", state: "completed", featureId: "f-done" });

  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
  scheduler.kick();
  assert.equal(getFeature("f-done")?.state, "integrating");
  assert.equal(getTask("A")?.state, "completed");
});

test("recover：收集全部在飞节点各置 failed(interrupted)，Feature 不判死且不重派", () => {
  close();
  createFeature({ featureId: "f-rec", title: "恢复", state: "executing" });
  createTask({
    taskId: "A",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-rec",
    remoteTaskId: "r-A",
  });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-rec",
    remoteTaskId: "r-B",
  });
  createTask({ taskId: "C", projectId: "p1", contextId: "c1", state: "working", featureId: "f-rec" });

  const dispatchedIds: string[] = [];
  const scheduler = new FeatureScheduler({
    dispatch: async (n) => {
      dispatchedIds.push(n.taskId);
      return { ok: true };
    },
  });
  const summary = scheduler.recover();

  assert.equal(summary.scanned, 1);
  assert.equal(summary.interruptedTasks, 2);
  // v0.6.1 REQ-05 §2.1（v3）：`recover()` 不再 `failFeature`（字段保留、语义休眠）
  assert.equal(summary.failedFeatures, 0, "recover 不再 failFeature");
  assert.equal(getTask("A")?.state, "failed");
  assert.equal(getTask("B")?.state, "failed");
  // C 是**无依赖独立分支**：`recover()` 本身不改写它（不判 failed）；recover 触发的 tick 会把它
  // 作为**独立就绪分支**正常派发（V2：另一分支不被失败连座）。下游冻结语义见 n3-failure-rest.test.ts V8。
  assert.equal(getTask("C")?.state, "working", "独立分支不被 recover 改写");
  assert.equal(getFeature("f-rec")?.state, "executing", "Feature 交给静止收敛，不判死");
  assert.deepEqual(dispatchedIds, ["C"], "A/B 不被重派；独立就绪分支 C 由 tick 正常派发");
});

test("recover：无在飞任务的 executing Feature 保持，等待续推", () => {
  close();
  createFeature({ featureId: "f-idle", title: "空闲", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-idle" });

  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
  const summary = scheduler.recover();

  assert.equal(summary.scanned, 1);
  assert.equal(summary.interruptedTasks, 0);
  assert.equal(summary.failedFeatures, 0);
  assert.equal(getFeature("f-idle")?.state, "executing");
  assert.equal(getTask("A")?.state, "working");
});

// ---------------------------------------------------------------------------
// 留痕（v0.5.1 D1 / I3）：静默 `return false` / 早退 ⇒ 恰一条 `transition_skipped`
// ---------------------------------------------------------------------------

/** 取某 Feature 的 `feature.state` 事件（可按目标态过滤）——「事件数 = 0 / 恰 1」断言 */
function featureStateEvents(
  featureId: string,
  state?: string,
): Array<{ featureId: string | null; state: string | null }> {
  return listEvents({ limit: 1000 })
    .filter((e) => e.kind === EVENT_FEATURE_STATE && e.featureId === featureId)
    .filter((e) => state === undefined || e.state === state)
    .map((e) => ({ featureId: e.featureId, state: e.state }));
}

/** 取指定 kind 的事件（可按 Feature 过滤），payload 已解析 */
function eventsOfKind(
  kind: string,
  featureId?: string,
): Array<{
  featureId: string | null;
  taskId: string | null;
  state: string | null;
  payload: Record<string, unknown>;
}> {
  return listEvents({ limit: 1000 })
    .filter((e) => e.kind === kind)
    .filter((e) => featureId === undefined || e.featureId === featureId)
    .map((e) => ({
      featureId: e.featureId,
      taskId: e.taskId,
      state: e.state,
      payload: JSON.parse(e.payload ?? "{}") as Record<string, unknown>,
    }));
}

test("D1 留痕 / I3：早退与三处静默 return 各恰一条 transition_skipped，且不产生 feature.state", () => {
  // ① 早退：Feature 不存在（`feature === null`）
  {
    close();
    const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
    scheduler.notifyTaskSettled("f-n3-t8-absent", "T1", { state: "failed", text: "boom" });
    const skipped = eventsOfKind(EVENT_FEATURE_TRANSITION_SKIPPED, "f-n3-t8-absent");
    assert.equal(skipped.length, 1, "早退恰一条留痕");
    assert.equal(skipped[0]?.payload["code"], "early_return_task_settled");
    assert.equal(skipped[0]?.payload["from"], null);
    assert.equal(skipped[0]?.taskId, "T1");
    assert.equal(
      skipped[0]?.state,
      null,
      "态没变 ⇒ events.state 必须为 null（写目标态会让按 state 过滤的消费者误判已交人）",
    );
  }

  // ② 早退：Feature 已终态
  {
    close();
    createFeature({ featureId: "f-n3-t8-term", title: "早退-终态", state: "completed" });
    createTask({
      taskId: "T1",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      featureId: "f-n3-t8-term",
    });
    const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
    const before = featureStateEvents("f-n3-t8-term").length;
    scheduler.notifyTaskSettled("f-n3-t8-term", "T1", { state: "failed", text: "boom" });
    const skipped = eventsOfKind(EVENT_FEATURE_TRANSITION_SKIPPED, "f-n3-t8-term");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.payload["code"], "early_return_task_settled");
    assert.equal(skipped[0]?.payload["from"], "completed");
    assert.equal(getFeature("f-n3-t8-term")?.state, "completed", "早退不改态");
    assert.equal(
      featureStateEvents("f-n3-t8-term").length,
      before,
      "skip 路径不得写 feature.state（I4 对偶：有 feature.state ⇔ 态真变了）",
    );
  }

  // ③ sealed_settle（第二次交人）：v2 起 `isFeatureSealed` **前置早退** —— 已 `needs_input` 的迟到
  //    结算命中**封存分支**（code `sealed_settle`），不再走 `needsInputFeature` 的 `already_needs_input`
  {
    close();
    createFeature({ featureId: "f-n3-t8-ni", title: "已交人", state: "executing" });
    createTask({
      taskId: "T2",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      featureId: "f-n3-t8-ni",
    });
    const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
    scheduler.notifyTaskSettled("f-n3-t8-ni", "T2", { state: "input-required", text: "请澄清" });
    assert.equal(getFeature("f-n3-t8-ni")?.state, "needs_input", "第一次：合法流转（有 feature.state）");
    const before = featureStateEvents("f-n3-t8-ni").length;

    scheduler.notifyTaskSettled("f-n3-t8-ni", "T2", { state: "input-required", text: "再澄清" });
    const skipped = eventsOfKind(EVENT_FEATURE_TRANSITION_SKIPPED, "f-n3-t8-ni");
    assert.equal(skipped.length, 1, "第二次（已 needs_input）恰一条留痕");
    assert.equal(skipped[0]?.payload["code"], "sealed_settle", "封存早退（已 needs_input）");
    assert.equal(skipped[0]?.payload["from"], "needs_input");
    assert.equal(skipped[0]?.payload["to"], "input-required", "payload.to = 该 settle 的目标态名");
    assert.equal(featureStateEvents("f-n3-t8-ni").length, before, "skip 路径不得写 feature.state");
  }

  // ④ illegal_transition（waiting_approval 的合法后继无 needs_input）
  {
    close();
    createFeature({ featureId: "f-n3-t8-il", title: "非法流转", state: "waiting_approval" });
    createTask({
      taskId: "T3",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      featureId: "f-n3-t8-il",
    });
    const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
    scheduler.notifyTaskSettled("f-n3-t8-il", "T3", { state: "input-required", text: "请澄清" });
    const skipped = eventsOfKind(EVENT_FEATURE_TRANSITION_SKIPPED, "f-n3-t8-il");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.payload["code"], "illegal_transition");
    assert.equal(skipped[0]?.payload["from"], "waiting_approval");
    assert.equal(getFeature("f-n3-t8-il")?.state, "waiting_approval", "非法流转不改态");
    assert.equal(featureStateEvents("f-n3-t8-il").length, 0, "skip 路径不得写 feature.state");
  }

  // ⑤ feature_terminal：派发在飞期间 Feature 被并发置终态 ⇒ 派发失败分支的后续判定命中终态
  //    （注：`feature_not_found` 在本仓**无 Feature 删除 API** ⇒ 测试内不可达）
  {
    close();
    createFeature({ featureId: "f-n3-t8-ft", title: "终态留痕", state: "executing" });
    createTask({
      taskId: "T4",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      featureId: "f-n3-t8-ft",
    });
    const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
    updateFeatureState("f-n3-t8-ft", "failed"); // 受控模拟「在飞期间被并发置终态」
    scheduler.notifyTaskSettled("f-n3-t8-ft", "T4", { state: "input-required", text: "请澄清" });
    const skipped = eventsOfKind(EVENT_FEATURE_TRANSITION_SKIPPED, "f-n3-t8-ft");
    assert.equal(skipped.length, 1, "早退留痕恰一条");
    assert.equal(skipped[0]?.payload["code"], "early_return_task_settled");
    assert.equal(getFeature("f-n3-t8-ft")?.state, "failed", "终态不被改写");
  }
});

// ---------------------------------------------------------------------------
// N2 删除面自检（REQ-05 §2.2 / §4.1 V7 / V9）
// ---------------------------------------------------------------------------

test("N2：五层进程内态与硬闸谓词不复存在，且 task.retry / task.evidence / pending_evidence_discarded 零写入", async () => {
  close();
  createFeature({ featureId: "f-n2", title: "删五层", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-n2" });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-n2",
    dependencies: ["A"],
  });

  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });

  // ① 结构：五层的进程内态 / 硬闸 / 门 / 决策方法整块消失
  const probe = scheduler as unknown as Record<string, unknown>;
  for (const gone of [
    "pendingEvidence",
    "evidenceReadyStreak",
    "hasPendingEvidenceDecision",
    "handleEvidenceSettled",
    "resolveRetryTarget",
    "runEvidenceGate",
    "evidencePollDue",
    "evidenceWaitedMs",
    "appendEvidenceEvent",
    "discardPendingEvidence",
    "maxRetry",
    "evidenceWaitMaxMs",
    "evidencePollMs",
    "registerEvidenceNode",
    "resolveEvidence",
    "probeProjectReady",
  ]) {
    assert.equal(probe[gone], undefined, `${gone} 必须整块消失（删五层：写侧 + 读侧同批）`);
  }

  // ② 行为：走完「曾判 infra」的失败 settle 全路径，三类事件零写入
  const infraText = "Prompt timeout after 600000ms"; // v0.4.1 时此文本会触发取证流
  updateTaskState("A", "failed", null, infraText);
  scheduler.notifyTaskSettled("f-n2", "A", { state: "failed", text: infraText });
  await new Promise((r) => setImmediate(r));

  const kinds = listEvents({ limit: 1000 }).map((e) => e.kind);
  for (const gone of ["task.retry", "task.evidence", "feature.pending_evidence_discarded"]) {
    assert.equal(kinds.includes(gone), false, `${gone} 必须零写入（常量族与写点整块删除）`);
  }

  // ③ 三个休眠列不再被写入（读侧恒中性值）；失败分类亦不再落库
  const a = getTask("A");
  assert.equal(a?.state, "failed");
  assert.equal(a?.exhausted, false, "exhausted 休眠列：不再写 1");
  assert.equal(a?.notBefore, null, "not_before 休眠列：不再写挡板");
  assert.equal(a?.lastPollAt, null, "last_poll_at 休眠列：不再写轮询时刻");
  assert.equal(a?.failureKind, null, "failure_kind 停止写入（出参恒 null 语义休眠）");
});
