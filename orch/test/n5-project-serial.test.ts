/**
 * N5（REQ-v0.6.1-2026-09-17-05 §2.5 / REQ-v0.8.7-2026-09-22-01 §2.1）行为锁定
 * —— **project 粒度串行 + 静止期禁 ensure**。
 *
 * **v0.8.7 O1：假绿翻真**。旧版本文件用 `markTaskDispatched` 手工回填 `remote_task_id` 来
 * 满足当时的忙集谓词（`working ∧ remote_task_id IS NOT NULL`）—— 而 pull 模型下该列**已无生产
 * 写入点** ⇒ 忙集恒空 ⇒ 「串行」从未被真正测到。现忙集口径 = `working ∧ queue_state ∈
 * {queued, claimed, running}`，本文件一律改走 **`enqueueTask` + `claimTask` + `upsertTaskResult`
 * 真实 CAS 与真实结算路径**（不需要活 Runner）。
 *
 * 覆盖（对应改造文档 §4 L1）：
 * - ⭐ **「同 project 多节点不并发」真行为锚**（本版硬性验收标准）：同 Feature 两个**无依赖**
 *   同项目节点 ⇒ 第二节点在第一节点**落定前**跨多个 tick 仍不被派发；第一节点终态落库后放行；
 * - **V1 同 project 串行不变式**：跨 Feature，同 project「已派发未落定」计数 **≤ 1**；
 *   **跨 project 同 tick 可并发**；排队者在项目释放后的下一 tick 被放行；
 * - **V6 静止期禁 ensure**：静止（失败静止）与 `needs_input` 期**零派发**（⇒ 不走 `dispatchTask`
 *   ⇒ 零入队）；v0.7.0 A5 起 `renew` 退役、`isTaskWatched` 判**本地队列态**（`queued/claimed/running`）；
 * - **`listBusyProjectIds`（项目忙来源）**：口径 = `working ∧ 在队`；未入队 / 已结算不算忙；
 *   **`queued` 计入忙集**（= 串行定义本身）；**sweep 清算回 `queued` 后仍忙**（正确行为）；
 *   **不受 `listTasks` 的 limit clamp 截断**（120 条在队仍不静默漏）；
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
  claimTask,
  close,
  createFeature,
  createTask,
  enqueueTask,
  getQueuedTask,
  getTask,
  listBusyProjectIds,
  listFeatureTasks,
  requeueStaleTask,
  updateTaskState,
  upsertTaskResult,
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

/** 节点是否「在队」= v0.8.7 忙集口径的后半段（`queued / claimed / running`） */
function isEnqueued(taskId: string): boolean {
  const rec = getQueuedTask(taskId);
  if (rec === null) return false;
  return rec.queueState === "queued" || rec.queueState === "claimed" || rec.queueState === "running";
}

/**
 * V1 字面判据：这些 Feature 的节点中，指定 project **已派发未落定**（`working ∧ 在队`）的节点数。
 * 与 `listBusyProjectIds` 同口径（v0.8.7 起不再看 `remote_task_id`）。
 */
function openCount(projectId: string, featureIds: readonly string[]): number {
  let count = 0;
  for (const featureId of featureIds) {
    for (const t of listFeatureTasks(featureId, { limit: 1000 })) {
      if (t.projectId === projectId && t.state === "working" && isEnqueued(t.taskId)) {
        count += 1;
      }
    }
  }
  return count;
}

/** 模拟 Runner 回传终态（真实结算落库路径：置 `settled` ⇒ 出忙集） */
function settleAsRunner(taskId: string, projectId: string, state: TaskState = "completed"): void {
  upsertTaskResult({
    machineId: "m-test",
    taskId,
    projectId,
    contextId: `ctx-${taskId}`,
    state,
    text: state === "completed" ? "done" : "boom",
  });
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
  // 项目忙（p1 被别的 Feature / 在队节点占用）⇒ A / C 均不 ready
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
// 项目忙来源：listBusyProjectIds（v0.8.7 真实队列态驱动）
// ---------------------------------------------------------------------------

test("N5 · listBusyProjectIds：在队口径（working ∧ queued/claimed/running），且不受 limit clamp 截断", () => {
  close();
  // p1：已入队待领取 ⇒ **忙**（① `queued` 计入 = 串行定义本身）
  createTask({ taskId: "a", projectId: "p1", contextId: "c", state: "working" });
  enqueueTask("a");
  // p2：working 但未入队（尚未派发）⇒ 不忙
  createTask({ taskId: "b", projectId: "p2", contextId: "c", state: "working" });
  // p3：入队后被领取 ⇒ 忙（claimed）
  createTask({ taskId: "c", projectId: "p3", contextId: "c", state: "working" });
  enqueueTask("c");
  const claimedC = claimTask({ claimedBy: "m-test", projectIds: ["p3"] });
  assert.equal(claimedC?.taskId, "c", "前置：claimTask CAS 应领到 c");
  assert.equal(getQueuedTask("c")?.queueState, "claimed");
  // p4：已终态且已结算（真实回传路径）⇒ 不忙
  createTask({ taskId: "d", projectId: "p4", contextId: "c", state: "working" });
  enqueueTask("d");
  settleAsRunner("d", "p4");
  assert.deepEqual([...listBusyProjectIds()].sort(), ["p1", "p3"]);

  // ② **sweep 清算（claimed → queued）后仍在忙集 = 正确行为**（任务未落定，只是换了领取者）
  assert.equal(requeueStaleTask("c", "m-test"), true);
  assert.equal(getQueuedTask("c")?.queueState, "queued");
  assert.equal(listBusyProjectIds().has("p3"), true, "清算回 queued 仍算忙（不得被当漏洞「修掉」）");

  // 领取者清算后仍可被再次领取 ⇒ 忙集不依赖 machine 侧领取纪律（③）
  const reclamed = claimTask({ claimedBy: "m-other", projectIds: ["p3"] });
  assert.equal(reclamed?.taskId, "c");
  assert.equal(reclamed?.queueState, "claimed");

  // 不 clamp：p5 注入 120 条在队（远超 listTasks 的 limit=100 上限）
  for (let i = 0; i < 120; i += 1) {
    const id = `bulk-${String(i)}`;
    createTask({ taskId: id, projectId: "p5", contextId: "c", state: "working" });
    enqueueTask(id);
  }
  const busy = listBusyProjectIds();
  assert.equal(busy.has("p5"), true, "不得因 limit clamp 静默漏忙项目（listTasks 在此会漏）");
  assert.deepEqual([...busy].sort(), ["p1", "p3", "p5"]);
});

// ---------------------------------------------------------------------------
// ⭐ 真行为锚（v0.8.7 硬性验收）：同 project 多节点不并发
// ---------------------------------------------------------------------------

test(
  "N5 · 真行为锚：同 Feature 两个同 project 独立节点 —— 第二节点在第一节点落定前不被派发（跨多 tick）",
  async () => {
    close();
    createFeature({ featureId: "f-serial", title: "串行锚", state: "executing" });
    createTask({ taskId: "A", projectId: "p1", contextId: "ca", state: "working", featureId: "f-serial" });
    createTask({ taskId: "B", projectId: "p1", contextId: "cb", state: "working", featureId: "f-serial" });

    const started: string[] = [];
    const scheduler = new FeatureScheduler({
      dispatch: (n) => {
        started.push(n.taskId);
        // 对齐 pull 真路径：派发 = 入队落库后立即返回（终态由 Runner 稍后回传）
        // ⇒ 批次 `finally` 释放进程内预留，此后项目的忙**只能由 DB 谓词承载**
        enqueueTask(n.taskId);
        return Promise.resolve<FeatureDispatchResult>({ ok: true });
      },
    });

    scheduler.kick();
    await flush();
    // 放行序 = `updated_at ASC`，不假定 A 先于 B ⇒ 断言「恰好一个」而非具体 id
    assert.equal(started.length, 1, `同 project 只放行一个（实得 ${started.join(",")}）`);
    const first = started[0];
    assert.ok(first !== undefined);
    const second = first === "A" ? "B" : "A";
    assert.equal(getQueuedTask(first)?.queueState, "queued", `${first} 已入队未落定`);
    assert.equal(listBusyProjectIds().has("p1"), true, `${first} 在队 ⇒ p1 忙（进程内预留已退场）`);

    // 首节点保持「已入队未落定」期间，重复 tick 不得放行第二节点（旧恒空谓词下此断言必红）
    for (let i = 0; i < 3; i += 1) {
      scheduler.kick();
      await flush();
      assert.equal(started.includes(second), false, `第 ${String(i + 1)} 次重 tick：${first} 未落定 ⇒ ${second} 仍不派发`);
      assert.equal(openCount("p1", ["f-serial"]), 1, "同 project 开放节点数恒 ≤ 1");
    }

    // 首节点经真实回传落终态 ⇒ 出忙集 ⇒ 下一 tick 放行第二节点
    settleAsRunner(first, "p1");
    assert.equal(getTask(first)?.state, "completed");
    assert.equal(listBusyProjectIds().has("p1"), false, `${first} 落定后项目释放（下一 tick 前）`);
    scheduler.kick();
    await flush();
    assert.deepEqual(started, [first, second], "项目释放后同 project 排队者被放行");
    assert.equal(getQueuedTask(second)?.queueState, "queued", "第二节点随即入队（成为新的忙源）");
  },
);

// ---------------------------------------------------------------------------
// V1：同 project 串行（跨 Feature）+ 跨 project 同 tick 并发
// ---------------------------------------------------------------------------

test("N5 · V1 同 project 串行：跨 Feature 同一时刻开放 ≤ 1，跨 project 同 tick 并发", async () => {
  close();
  createFeature({ featureId: "f-a", title: "A", state: "executing" });
  createTask({ taskId: "A1", projectId: "p1", contextId: "ca", state: "working", featureId: "f-a" });
  createFeature({ featureId: "f-b", title: "B", state: "executing" });
  createTask({ taskId: "B1", projectId: "p1", contextId: "cb", state: "working", featureId: "f-b" });
  createFeature({ featureId: "f-c", title: "C", state: "executing" });
  createTask({ taskId: "C1", projectId: "p2", contextId: "cc", state: "working", featureId: "f-c" });

  const started: string[] = [];
  const scheduler = new FeatureScheduler({
    dispatch: (n) => {
      started.push(n.taskId);
      enqueueTask(n.taskId);
      return Promise.resolve<FeatureDispatchResult>({ ok: true });
    },
  });

  scheduler.kick(); // 同 tick 三个 Feature 并发进入（靠进程内预留抢占项目）
  await flush();

  const p1Started = started.filter((id) => id === "A1" || id === "B1");
  assert.equal(p1Started.length, 1, "同 project（p1）只放行一个 —— 跨 Feature 排队");
  assert.equal(started.includes("C1"), true, "跨 project（p2）同 tick 并发");
  assert.equal(started.length, 2, "同 project 同一时刻开放 ≤ 1（p1 一个 + p2 一个）");
  assert.equal(openCount("p1", ["f-a", "f-b"]), 1, "V1 字面判据：working ∧ 在队 计数 ≤ 1");

  // 在飞节点未落定（保持 working ∧ 在队、进程内预留已退场）⇒ 项目仍忙 ⇒ 排队者继续等待
  for (let i = 0; i < 3; i += 1) {
    scheduler.kick();
    await flush();
    assert.equal(
      started.filter((id) => id === "A1" || id === "B1").length,
      1,
      "在飞节点未终态 ⇒ 项目仍忙，排队者继续等待",
    );
  }

  // 在飞节点终态 ⇒ 项目释放 ⇒ 下一 tick 放行排队者
  const first = p1Started[0];
  assert.ok(first !== undefined);
  settleAsRunner(first, "p1");
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

test("N5 · V-ensure/V6：静止期与 needs_input 期零 ensure —— 调度通道零派发、看护通道无入队", async () => {
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
  assert.equal(openCount("p1", ["f-rest"]), 0, "静止期零开放节点（working ∧ 在队）");
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
