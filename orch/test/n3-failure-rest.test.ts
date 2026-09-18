/**
 * N3（REQ-05 §2.1）行为锁定 —— 失败冻结与静止收敛。
 *
 * 覆盖（与改造文档 §4.1 判据对应）：
 * - **失败冻结限未派发**：`propagateBlocked` 只冻 `remoteTaskId === null` 的 `working` 下游；
 *   在飞节点不动（V2 的写入侧前提）；
 * - **失败不判死整单**：`notifyTaskSettled(failed)` / `advanceExecuting` 派发失败分支
 *   只传播、不 `failFeature`；C1 同批（一个 `!ok` 不短路丢弃同批其余 `settled` 结果）；
 * - **V3 静止收敛**：`any failure → ready=0 ∧ no in-flight ⇒ Feature 保持 executing`，
 *   且**仅在静止事件一次**（重复 tick 不重复发）；集合变化（重派 / 解冻）自然重新武装；
 * - **封存谓词**：`needs_input` 与静止期「只落库任务态、不改 Feature 态、不传播、不发账单」；
 * - **V8 recover**：在飞节点 → `interrupted`，Feature **不** `failFeature`，静止收敛自然接落；
 * - **A5-2**：看护 `persist` 异常与 `poll` 异常分离分类（`persist` 失败不走 abandoned、
 *   终态仍调 `onSettled`；`poll` 失败仍按上限走 abandoned）。
 *
 * 独立成文件（不与 `scheduler.test.ts` 混写）：N3 的验收断言与后续「测试重写」节点的改动面解耦，
 * 便于逐节点核验时单独跑。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 * 隔离：默认库固定 `:memory:`，每个用例先 `close()` 重置为空库。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "@a2a-js/sdk";
import {
  close,
  createFeature,
  createTask,
  getFeature,
  getTask,
  listEvents,
  updateTaskState,
} from "../session/store.js";
import { EVENT_FAILURE_REPORT, FeatureScheduler, propagateBlocked } from "../bridge/scheduler.js";
import { drainTaskWatchers, isTaskWatched, startTaskWatcher } from "../bridge/task-watcher.js";
import type { EventRecord, TaskRecord, TaskState } from "../types.js";

process.env["SESSION_DB"] = ":memory:";

/** 推进足够多轮次，覆盖 `advanceExecuting` 内的多个 `await` */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** 本 Feature 的失败静止账单事件（`feature.failure_report`） */
function failureReports(featureId: string): EventRecord[] {
  return listEvents({ limit: 200 }).filter(
    (e) => e.kind === EVENT_FAILURE_REPORT && e.featureId === featureId,
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

// ---------------------------------------------------------------------------
// 1. 失败冻结：限未派发
// ---------------------------------------------------------------------------

test("N3 · propagateBlocked：只冻未派发下游（在飞 remoteTaskId !== null 不动）", () => {
  const nodes: TaskRecord[] = [
    node("A", "failed"),
    node("B", "working", ["A"], "r-B"), // 在飞：不得被冻结
    node("C", "working", ["B"], null), // 未派发：闭包内应被冻结
    node("D", "completed"),
  ];
  assert.deepEqual(propagateBlocked("A", nodes), ["C"]);
});

// ---------------------------------------------------------------------------
// 2. V3：静止收敛（一次事件 + 零派发 + 不判死）
// ---------------------------------------------------------------------------

test("N3 · V3 静止收敛：ready=0 且有失败 ⇒ Feature 保持 executing + 恰好一次 failure_report", async () => {
  close();
  createFeature({ featureId: "f-rest", title: "静止收敛", state: "executing" });
  createTask({
    taskId: "A",
    projectId: "pa",
    contextId: "ca",
    state: "working",
    featureId: "f-rest",
  });
  createTask({
    taskId: "B",
    projectId: "pa",
    contextId: "cb",
    state: "working",
    featureId: "f-rest",
    dependencies: ["A"],
  });
  updateTaskState("A", "failed", null, "boom");

  let dispatched = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async () => {
      dispatched += 1;
      return { ok: true };
    },
  });

  scheduler.kick();
  await flush();

  assert.equal(getFeature("f-rest")?.state, "executing", "业务失败不判死整单");
  assert.equal(getTask("B")?.state, "blocked", "未派发下游被冻结");
  assert.equal(dispatched, 0, "静止 ⇒ 零派发（无 dispatch / 无 ensure）");

  const reports = failureReports("f-rest");
  assert.equal(reports.length, 1, "静止收敛恰好一次事件");
  const first = reports[0];
  assert.equal(first?.state, null, "Feature 态未变 ⇒ events.state 必须为 null");
  const payload = JSON.parse(first?.payload ?? "{}") as {
    failed: { taskId: string; projectId: string; text: string | null; contextId: string }[];
    blockedSet: string[];
  };
  assert.deepEqual(
    payload.failed.map((f) => f.taskId),
    ["A"],
  );
  assert.equal(payload.failed[0]?.projectId, "pa");
  assert.equal(payload.failed[0]?.contextId, "ca", "contextId 取 TaskRecord.contextId（节点会话）");
  assert.equal(payload.failed[0]?.text, "boom");
  assert.deepEqual(payload.blockedSet, ["B"]);

  // 重复 tick：signature 不变 ⇒ 不重发
  scheduler.kick();
  await flush();
  scheduler.kick();
  await flush();
  assert.equal(failureReports("f-rest").length, 1, "signature 不变 ⇒ 不重复发（一次/静止期）");
  assert.equal(getFeature("f-rest")?.state, "executing");

  // 集合变化（原冻结节点亦失败）⇒ 自然重新武装
  updateTaskState("B", "failed", null, "also-boom");
  scheduler.kick();
  await flush();
  assert.equal(failureReports("f-rest").length, 2, "集合变化 ⇒ 新 episode 重新武装");
  assert.equal(getFeature("f-rest")?.state, "executing", "仍不判死");
});

// ---------------------------------------------------------------------------
// 3. C1 同批 + 派发失败不判死
// ---------------------------------------------------------------------------

test("N3 · C1 同批：一个 !ok 不短路丢弃同批其余 settled 结果，且不 failFeature", async () => {
  close();
  createFeature({ featureId: "f-batch", title: "同批", state: "executing" });
  createTask({
    taskId: "A",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-batch",
  });
  createTask({
    taskId: "B",
    // v0.6.1 REQ-05 §2.5（N5）：**同 project 串行**已生效 ⇒ 本用例关注「**同批**继续处理」，
    // 故把 B 放到 p2（同 project 会被排队、不同批；见 n5-project-serial.test.ts V1）。
    projectId: "p2",
    contextId: "c2",
    state: "working",
    featureId: "f-batch",
  });

  const scheduler = new FeatureScheduler({
    // 对齐真实注入契约：`settled` 表示「已落库的终态」，故 stub 必须自己先落库
    dispatch: async (n) => {
      if (n.taskId === "A") return { ok: false, error: "ensure 超时" };
      updateTaskState(n.taskId, "completed", null, "ok");
      return { ok: true, settled: { state: "completed", text: "ok" } };
    },
  });
  scheduler.kick();
  await flush();

  assert.equal(getTask("A")?.state, "failed");
  assert.equal(getTask("B")?.state, "completed", "同批其余结果不得被 !ok 短路丢弃");
  assert.equal(getFeature("f-batch")?.state, "executing", "派发失败不判死整单");

  scheduler.kick();
  await flush();
  assert.equal(failureReports("f-batch").length, 1, "下一 tick 落静止账单");
  assert.equal(getFeature("f-batch")?.state, "executing");
});

// ---------------------------------------------------------------------------
// 4. 封存谓词：needs_input
// ---------------------------------------------------------------------------

test("N3 · 封存谓词：needs_input 期远端失败只落库，不改 Feature 态、不传播、不发账单", () => {
  close();
  createFeature({ featureId: "f-ni", title: "澄清", state: "needs_input" });
  createTask({
    taskId: "A",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-ni",
    remoteTaskId: "r-A",
  });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "c2",
    state: "working",
    featureId: "f-ni",
    dependencies: ["A"],
  });

  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
  updateTaskState("A", "failed", null, "boom");
  scheduler.notifyTaskSettled("f-ni", "A", { state: "failed", text: "boom" });

  assert.equal(getFeature("f-ni")?.state, "needs_input", "迟到失败不得把澄清入口判死（防 C5 漂移）");
  assert.equal(getTask("B")?.state, "working", "封存期不传播");
  assert.equal(failureReports("f-ni").length, 0, "封存期不发账单");
});

// ---------------------------------------------------------------------------
// 5. V8：recover 不判死，交静止收敛
// ---------------------------------------------------------------------------

test("N3 · V8 recover：在飞节点 interrupted、Feature 不 failFeature、静止收敛接落", async () => {
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
    contextId: "c2",
    state: "working",
    featureId: "f-rec",
    remoteTaskId: "r-B",
  });
  createTask({
    taskId: "C",
    projectId: "p1",
    contextId: "c3",
    state: "working",
    featureId: "f-rec",
    dependencies: ["A"],
  });

  let dispatched = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async () => {
      dispatched += 1;
      return { ok: true };
    },
  });
  const summary = scheduler.recover();

  assert.equal(summary.interruptedTasks, 2);
  assert.equal(summary.failedFeatures, 0, "N3：recover 不再 failFeature（字段语义休眠）");
  assert.equal(getTask("A")?.state, "failed");
  assert.equal(getTask("B")?.state, "failed");
  assert.notEqual(getTask("C")?.state, "failed", "recover 不得把未派发节点判 failed");
  assert.equal(getFeature("f-rec")?.state, "executing", "Feature 交给静止收敛，不判死");

  await flush();
  assert.equal(getTask("C")?.state, "blocked", "静止收敛前先按闭包冻结未派发下游");
  assert.equal(failureReports("f-rec").length, 1, "recover 后的 tick 落静止账单");
  assert.equal(getFeature("f-rec")?.state, "executing");
  assert.equal(dispatched, 0, "recover 不重派；静止后零派发");
});

// ---------------------------------------------------------------------------
// 6. A5-2：看护 persist / poll 异常分类分离
// ---------------------------------------------------------------------------

test("N3 · A5-2：persist 抛错不走 abandoned，终态仍回调 onSettled", async () => {
  const settledTasks: (Task | null)[] = [];
  const abandonedFlags: boolean[] = [];
  const fakeTask = { id: "w-1" } as unknown as Task;
  const started = startTaskWatcher({
    taskId: "w-persist-fail",
    poll: async () => fakeTask,
    renew: async () => undefined,
    isSettled: () => true,
    persist: () => {
      throw new Error("database is locked");
    },
    onSettled: (task, outcome) => {
      settledTasks.push(task);
      abandonedFlags.push(outcome.abandoned);
    },
    pollIntervalMs: 1,
    renewIntervalMs: 1_000_000,
    maxConsecutiveFailures: 1,
  });
  assert.equal(started, true);

  await drainTaskWatchers(2_000);

  assert.equal(isTaskWatched("w-persist-fail"), false, "看护应正常收尾，不得空转");
  assert.deepEqual(abandonedFlags, [false], "persist 异常不得判 abandoned");
  assert.equal(settledTasks[0]?.id, "w-1", "终态仍须回调 onSettled（DAG 续推信号不丢）");
});

test("N3 · A5-2：poll 连续失败仍按上限走 abandoned（分类未被放宽）", async () => {
  const abandonedFlags: boolean[] = [];
  let polls = 0;
  startTaskWatcher({
    taskId: "w-poll-fail",
    poll: async () => {
      polls += 1;
      throw new Error("unreachable");
    },
    renew: async () => undefined,
    isSettled: () => true,
    persist: () => undefined,
    onSettled: (_task, outcome) => {
      abandonedFlags.push(outcome.abandoned);
    },
    pollIntervalMs: 1,
    renewIntervalMs: 1_000_000,
    maxConsecutiveFailures: 3,
  });

  await drainTaskWatchers(2_000);

  assert.deepEqual(abandonedFlags, [true]);
  assert.equal(polls, 3, "达上限即放弃，不多轮");
});
