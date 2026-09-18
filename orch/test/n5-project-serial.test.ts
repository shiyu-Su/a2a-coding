/**
 * N5（REQ-v0.6.1-2026-09-17-05 §2.5）行为锁定 —— **project 粒度串行 + 静止期禁 ensure**。
 *
 * 覆盖（对应改造文档 §4.1 判据 V1 / V6）：
 * - **V1 同 project 串行不变式**：跨 Feature，同 project 同一时刻 `state='working' ∧
 *   remote_task_id IS NOT NULL` 计数 **≤ 1**；**跨 project 同 tick 可并发**；同 project 排队者
 *   在在飞节点终态（项目释放）后于下一 tick 被放行；
 * - **V6 静止期禁派发**：静止（失败静止）与 `needs_input` 期**零派发**（⇒ 不走 `dispatchTask`
 *   ⇒ 零 ensure / 零入队）；v0.7.0 A5 起 `renew` 退役、`isTaskWatched` 改判**本地队列态**
 *   （`queued/claimed/running`），故「通道②」断言 = 静止期任务不在队；
 * - **`listBusyProjectIds`（项目忙来源）**：口径 = `working ∧ remote_task_id IS NOT NULL`；
 *   终态占位 / 未派发不算忙；**不受 `listTasks` 的 limit clamp 截断**（120 条在飞仍不静默漏）；
 * - **`computeReadyNodes` 第三参**：`projectId ∈ busy ⇒ 不 ready` + **同批顺序认领**（同批同
 *   project 至多一个）；依赖未满足的同 project 节点**不得占位**（否则饿死本可派发者）；
 *   两参调用**保持旧语义**（不启用项目认领）。
 *
 * 独立成文件（不与 `scheduler.test.ts` 混写）：N5 的验收断言与后续「测试重写」节点（N7）的
 * 改动面解耦，便于逐节点核验时单独跑。
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
  enqueueTask,
  getTask,
  listBusyProjectIds,
  listFeatureTasks,
  markTaskDispatched,
  updateTaskState,
} from "../session/store.js";
import type { FeatureDispatchResult } from "../bridge/scheduler.js";
import { FeatureScheduler, computeReadyNodes } from "../bridge/scheduler.js";
import { isTaskWatched } from "../bridge/task-watcher.js";
import type { TaskRecord, TaskState } from "../types.js";

process.env["SESSION_DB"] = ":memory:";

/** 推进足够多轮次，覆盖 `advanceExecuting` 内的多个 `await` */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** 构造纯函数用的 TaskRecord（仅提供断言关心的字段） */
function node(
  id: string,
  state: TaskState,
  projectId: string,
  dependencies: string[] | null = null,
  remoteTaskId: string | null = null,
): TaskRecord {
  return {
    taskId: id,
    projectId,
    contextId: `ctx-${id}`,
    state,
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

/** V1 字面判据：这些 Feature 的节点中，指定 project 的在飞（`working ∧ remote ≠ null`）节点数 */
function inFlightCount(projectId: string, featureIds: readonly string[]): number {
  let count = 0;
  for (const featureId of featureIds) {
    for (const t of listFeatureTasks(featureId, { limit: 1000 })) {
      if (t.projectId === projectId && t.state === "working" && t.remoteTaskId !== null) {
        count += 1;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// 纯函数：就绪过滤 + 同批顺序认领
// ---------------------------------------------------------------------------

test("N5 · computeReadyNodes：projectId ∈ busy ⇒ 不 ready；同批顺序认领；两参调用保持旧语义", () => {
  const nodes: TaskRecord[] = [
    node("A", "working", "p1"),
    node("B", "working", "p2"),
    node("C", "working", "p1"),
  ];

  // 两参（省略 busyProjects）⇒ 旧语义：不做项目认领（纯函数测试可继续断言「拓扑就绪」本身）
  assert.deepEqual(
    computeReadyNodes(nodes).map((n) => n.taskId),
    ["A", "B", "C"],
  );
  // 项目忙（p1 被别的 Feature / 在飞节点占用）⇒ A / C 均不 ready
  assert.deepEqual(
    computeReadyNodes(nodes, undefined, new Set(["p1"])).map((n) => n.taskId),
    ["B"],
  );
  // 忙集为空但启用认领 ⇒ 同批内同 project **只取第一个**（C 下一 tick 重算）
  assert.deepEqual(
    computeReadyNodes(nodes, undefined, new Set()).map((n) => n.taskId),
    ["A", "B"],
  );

  // 依赖未满足者**不得占位**：否则 X 每 tick 先认领 p1，把本可就绪的 Y 永久挤出
  const gated: TaskRecord[] = [
    node("X", "working", "p1", ["Z"]), // 依赖 Z 未完成 ⇒ 不 ready
    node("Y", "working", "p1"), // 无依赖 ⇒ 本批应当就绪
  ];
  assert.deepEqual(
    computeReadyNodes(gated, undefined, new Set()).map((n) => n.taskId),
    ["Y"],
  );
});

// ---------------------------------------------------------------------------
// 项目忙来源：listBusyProjectIds
// ---------------------------------------------------------------------------

test("N5 · listBusyProjectIds：在飞口径（working ∧ remote ≠ null），且不受 limit clamp 截断", () => {
  close();
  // p1：在飞（算忙）
  createTask({ taskId: "a", projectId: "p1", contextId: "c", state: "working", remoteTaskId: "r-a" });
  // p2：working 但未派发（不算忙 —— 项目上没有在飞）
  createTask({ taskId: "b", projectId: "p2", contextId: "c", state: "working" });
  // p3：已终态但留着远端 id（不算忙 —— 非 working）
  createTask({ taskId: "c", projectId: "p3", contextId: "c", state: "completed", remoteTaskId: "r-c" });
  assert.deepEqual([...listBusyProjectIds()].sort(), ["p1"]);

  // 不 clamp：p4 注入 120 条在飞（远超 listTasks 的 limit=100 上限）
  for (let i = 0; i < 120; i += 1) {
    const id = `bulk-${String(i)}`;
    createTask({ taskId: id, projectId: "p4", contextId: "c", state: "working" });
    markTaskDispatched(id, `r-${id}`);
  }
  const busy = listBusyProjectIds();
  assert.equal(busy.has("p4"), true, "不得因 limit clamp 静默漏忙项目（listTasks 在此会漏）");
  assert.deepEqual([...busy].sort(), ["p1", "p4"]);
});

// ---------------------------------------------------------------------------
// V1：同 project 串行（跨 Feature）+ 跨 project 同 tick 并发
// ---------------------------------------------------------------------------

test("N5 · V1 同 project 串行：跨 Feature 同一时刻在飞 ≤ 1，跨 project 同 tick 并发", async () => {
  close();
  createFeature({ featureId: "f-a", title: "A", state: "executing" });
  createTask({ taskId: "A1", projectId: "p1", contextId: "ca", state: "working", featureId: "f-a" });
  createFeature({ featureId: "f-b", title: "B", state: "executing" });
  createTask({ taskId: "B1", projectId: "p1", contextId: "cb", state: "working", featureId: "f-b" });
  createFeature({ featureId: "f-c", title: "C", state: "executing" });
  createTask({ taskId: "C1", projectId: "p2", contextId: "cc", state: "working", featureId: "f-c" });

  const started: string[] = [];
  const inflightByProject = new Map<string, number>();
  let peakSameProject = 0;
  let peakTotal = 0;
  const resolvers: Array<() => void> = [];
  const scheduler = new FeatureScheduler({
    dispatch: (n) => {
      started.push(n.taskId);
      const next = (inflightByProject.get(n.projectId) ?? 0) + 1;
      inflightByProject.set(n.projectId, next);
      peakSameProject = Math.max(peakSameProject, next);
      let total = 0;
      for (const v of inflightByProject.values()) total += v;
      peakTotal = Math.max(peakTotal, total);
      // 对齐真实注入契约：派发即落远端 id（此后项目忙由 DB 快照接管，进程内预留退场）
      markTaskDispatched(n.taskId, `r-${n.taskId}`);
      return new Promise<FeatureDispatchResult>((resolve) => {
        resolvers.push(() => {
          inflightByProject.set(n.projectId, (inflightByProject.get(n.projectId) ?? 1) - 1);
          resolve({ ok: true });
        });
      });
    },
  });

  scheduler.kick(); // 同步段内完成就绪计算 + 整批启动

  const p1Started = started.filter((id) => id === "A1" || id === "B1");
  assert.equal(p1Started.length, 1, "同 project（p1）只放行一个 —— 跨 Feature 排队");
  assert.equal(started.includes("C1"), true, "跨 project（p2）同 tick 并发");
  assert.equal(peakSameProject, 1, "同 project 同一时刻在飞 ≤ 1（进程内预留生效）");
  assert.equal(peakTotal, 2, "跨 project 并发（p1 一个 + p2 一个）");
  assert.equal(inFlightCount("p1", ["f-a", "f-b"]), 1, "V1 字面判据：working ∧ remote≠null 计数 ≤ 1");

  // 释放第一批：节点保持 working ∧ remote ⇒ 项目仍忙 ⇒ 同 project 排队者不得派发
  for (const release of resolvers.splice(0)) release();
  await flush();
  scheduler.kick();
  await flush();
  assert.equal(
    started.filter((id) => id === "A1" || id === "B1").length,
    1,
    "在飞节点未终态 ⇒ 项目仍忙，排队者继续等待",
  );
  assert.equal(inFlightCount("p1", ["f-a", "f-b"]), 1);

  // 在飞节点终态 ⇒ 项目释放 ⇒ 下一 tick 放行排队者
  const first = p1Started[0];
  assert.ok(first !== undefined);
  updateTaskState(first, "completed", null, "done");
  scheduler.kick();
  await flush();
  assert.equal(getTask(first)?.state, "completed");
  assert.equal(
    started.filter((id) => id === "A1" || id === "B1").length,
    2,
    "在飞终态后项目释放，同 project 排队者被放行（下 tick 重算）",
  );
});

// ---------------------------------------------------------------------------
// V-ensure / V6：静止期禁 ensure（调度通道 + 看护通道各一条断言）
// ---------------------------------------------------------------------------

test("N5 · V-ensure/V6：静止期与 needs_input 期零 ensure —— 调度通道零派发、看护通道无 renew", async () => {
  close();
  createFeature({ featureId: "f-rest", title: "静止", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "ca", state: "working", featureId: "f-rest" });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "cb",
    state: "working",
    featureId: "f-rest",
    dependencies: ["A"],
  });
  updateTaskState("A", "failed", null, "boom"); // 造成失败静止

  let dispatchCalls = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async () => {
      dispatchCalls += 1;
      return { ok: true };
    },
  });
  scheduler.kick();
  await flush();
  scheduler.kick(); // 重复 tick 亦不得派发
  await flush();

  // 通道①：调度派发 → dispatchTask → ensureProject：静止期一次都不得发生
  assert.equal(dispatchCalls, 0, "静止期禁 ensure：调度通道零派发");
  assert.equal(getTask("A")?.state, "failed");
  assert.equal(getTask("B")?.state, "blocked", "未派发下游被冻结");

  // 通道②：看护对账（v0.7.0 A5：`renew` 已退役，判据 = 本地队列态）：静止 ⇒ 无在队任务
  assert.equal(inFlightCount("p1", ["f-rest"]), 0, "静止期零在飞（working ∧ remote≠null）");
  assert.equal(isTaskWatched("A"), false, "静止期任务不在队（queue_state=settled）⇒ 无对账");
  assert.equal(isTaskWatched("B"), false);

  // needs_input 期（tick 只扫 executing ⇒ 更外层拦截）：同样零派发 / 零看护
  const niCalls = { n: 0 };
  createFeature({ featureId: "f-ni", title: "澄清", state: "needs_input" });
  createTask({ taskId: "T", projectId: "p1", contextId: "ct", state: "working", featureId: "f-ni" });
  const niScheduler = new FeatureScheduler({
    dispatch: async () => {
      niCalls.n += 1;
      return { ok: true };
    },
  });
  niScheduler.kick();
  await flush();
  assert.equal(niCalls.n, 0, "needs_input 期零派发 ⇒ 零 ensure");
  assert.equal(isTaskWatched("T"), false);

  /**
   * **非空洞性对照**（v0.7.0 A5 判据重定义）：`isTaskWatched` 现由**本地队列态**判定
   * （`queue_state ∈ queued/claimed/running`），与「进程内是否有看护循环」解耦 ——
   * `renew` 退役后旧「无看护 ⇒ 无 renew」的对照不再适用。故此处改用入队/未入队对照，
   * 证明上面两条 `false` 不是「探针恒假」。
   */
  createTask({ taskId: "w-probe", projectId: "p1", contextId: "ct", state: "working" });
  assert.equal(isTaskWatched("w-probe"), false, "未入队（queue_state=NULL=settled）⇒ 非在队");
  enqueueTask("w-probe");
  assert.equal(isTaskWatched("w-probe"), true, "对照：入队（queued）⇒ 在队（上面的 false 非空洞）");
});
