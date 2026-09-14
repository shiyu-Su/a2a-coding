/**
 * `orch/bridge/scheduler.ts` 单元测试（v0.4.0 拓扑并行，`node:test`，无新依赖）。
 *
 * 覆盖：
 * - 纯函数：`depStateOf`（依赖三态）/ `computeReadyNodes`（同批就绪）/ `propagateBlocked`
 *   （传递闭包）/ `reduceConvergence`（收敛判定）；
 * - 调度器行为：同层整批并发派发、三层防重派、失败传播置 blocked + Feature failed、
 *   全 completed 自动 integrating、`recover()` 并行收敛语义。
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
  updateTaskState,
} from "../session/store.js";
import {
  FeatureScheduler,
  computeReadyNodes,
  depStateOf,
  propagateBlocked,
  reduceConvergence,
  type FeatureDispatchResult,
} from "../bridge/scheduler.js";
import type { TaskRecord, TaskState } from "../types.js";

// 默认存储固定内存库（getDefaultStore 首次调用时读取）
process.env["SESSION_DB"] = ":memory:";

/** 构造测试用 TaskRecord（仅提供断言关心的字段） */
function task(
  id: string,
  state: TaskState,
  dependencies: string[] | null = null,
  remoteTaskId: string | null = null,
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
    featureId: "f1",
    dependencies,
    inputArtifacts: null,
    remoteTaskId,
    dispatchMessage: null,
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

test("reduceConvergence：failed / blocked → failed（优先于 needs_input）", () => {
  assert.equal(reduceConvergence([task("A", "failed")]).kind, "failed");
  assert.equal(reduceConvergence([task("A", "blocked")]).kind, "failed");
  assert.equal(
    reduceConvergence([task("A", "blocked"), task("B", "input-required")]).kind,
    "failed",
  );
});

test("reduceConvergence：input-required → needs_input", () => {
  assert.equal(reduceConvergence([task("A", "completed"), task("B", "input-required")]).kind, "needs_input");
});

test("reduceConvergence：全 completed → all_completed；否则 dispatch", () => {
  assert.equal(reduceConvergence([task("A", "completed"), task("B", "completed")]).kind, "all_completed");
  assert.equal(reduceConvergence([task("A", "completed"), task("B", "working")]).kind, "dispatch");
  assert.equal(reduceConvergence([task("A", "working")]).kind, "dispatch");
});

// ---------------------------------------------------------------------------
// 调度器行为（内存库）
// ---------------------------------------------------------------------------

test("拓扑并行：同层无依赖节点在同一批并发派发，跨层仍按依赖串行", async () => {
  close();
  createFeature({ featureId: "f-par", title: "并行", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-par" });
  createTask({ taskId: "B", projectId: "p1", contextId: "c1", state: "working", featureId: "f-par" });
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

test("失败传播：上游 failed → 下游传递闭包置 blocked，Feature 收敛 failed", () => {
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
  assert.equal(getFeature("f-fail")?.state, "failed");
});

test("派发失败：该节点置 failed + 下游 blocked + Feature failed", async () => {
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
  assert.equal(getFeature("f-dispfail")?.state, "failed");
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

test("recover：收集全部在飞节点各置 failed(interrupted)，Feature failed 且不重派", () => {
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

  let dispatched = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async () => {
      dispatched += 1;
      return { ok: true };
    },
  });
  const summary = scheduler.recover();

  assert.equal(summary.scanned, 1);
  assert.equal(summary.interruptedTasks, 2);
  assert.equal(summary.failedFeatures, 1);
  assert.equal(getTask("A")?.state, "failed");
  assert.equal(getTask("B")?.state, "failed");
  assert.equal(getTask("C")?.state, "working", "未派发节点不应被改写");
  assert.equal(getFeature("f-rec")?.state, "failed");
  assert.equal(dispatched, 0, "recover 不重派");
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
