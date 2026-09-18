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
 *   终态仍调 `onSettled`；`poll` 失败仍按上限走 abandoned）；
 * - **episode 去重（v0.6.2 REQ-01）**：签名含 `${taskId}:${retryCount}` ⇒ 同节点重派后再失败
 *   必发新一条；同静止期（`retryCount` + 集合不变）严格不重发；`rearmTask`（needs_input）不自增。
 *
 * 独立成文件（不与 `scheduler.test.ts` 混写）：N3 的验收断言与后续「测试重写」节点的改动面解耦，
 * 便于逐节点核验时单独跑。
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
  updateTaskState,
} from "../session/store.js";
import { EVENT_FAILURE_REPORT, FeatureScheduler, propagateBlocked } from "../bridge/scheduler.js";
import { handleFeatureAdvance } from "../bridge/feature-tools.js";
import {
  drainTaskWatchers,
  isTaskWatched,
  startTaskWatcher,
  type WatchedTaskView,
} from "../bridge/task-watcher.js";
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
  const settledTasks: (WatchedTaskView | null)[] = [];
  const abandonedFlags: boolean[] = [];
  const started = startTaskWatcher({
    taskId: "w-persist-fail",
    poll: () => ({
      taskId: "w-1",
      state: "completed",
      queueState: "settled",
      claimedBy: null,
      artifactsJson: null,
      text: null,
      featureId: null,
    }),
    isSettled: () => true,
    persist: () => {
      throw new Error("database is locked");
    },
    onSettled: (task, outcome) => {
      settledTasks.push(task);
      abandonedFlags.push(outcome.abandoned);
    },
    pollIntervalMs: 1,
    maxConsecutiveFailures: 1,
  });
  assert.equal(started, true);

  await drainTaskWatchers(2_000);

  assert.equal(isTaskWatched("w-persist-fail"), false, "看护应正常收尾，不得空转");
  assert.deepEqual(abandonedFlags, [false], "persist 异常不得判 abandoned");
  assert.equal(settledTasks[0]?.taskId, "w-1", "终态仍须回调 onSettled（DAG 续推信号不丢）");
});

test("N3 · A5-2：poll 连续失败仍按上限走 abandoned（分类未被放宽）", async () => {
  const abandonedFlags: boolean[] = [];
  let polls = 0;
  startTaskWatcher({
    taskId: "w-poll-fail",
    poll: () => {
      polls += 1;
      throw new Error("unreachable");
    },
    isSettled: () => true,
    persist: () => undefined,
    onSettled: (_task, outcome) => {
      abandonedFlags.push(outcome.abandoned);
    },
    pollIntervalMs: 1,
    maxConsecutiveFailures: 3,
  });

  await drainTaskWatchers(2_000);

  assert.deepEqual(abandonedFlags, [true]);
  assert.equal(polls, 3, "达上限即放弃，不多轮");
});

// ---------------------------------------------------------------------------
// 7. v0.6.2 REQ-01：失败账单 episode 去重（`retryCount` 参与签名）
// ---------------------------------------------------------------------------
// 实现侧（A-N1）把 `reportFailureAtRest` 的签名由 `failedIds` 扩为 `${taskId}:${retryCount}`。
// 本节锁定**可观测语义**：**每一次失败收敛 ⇔ 恰好一条账单** —— 同节点被重派（`retryCount` 变）
// 后再次失败必发**新 episode**；同静止期（`retryCount` + 集合皆不变）**严格不重发**。
// 既有 `N3` 用例（1–6 节）保持原判据，未放宽 / 未删除。

interface FailureReportPayload {
  failed: { taskId: string; projectId: string; text: string | null; contextId: string }[];
  blockedSet: string[];
}

/** 解析失败账单 payload（字段口径见 `reportFailureAtRest`） */
function reportPayload(event: EventRecord | undefined): FailureReportPayload {
  return JSON.parse(event?.payload ?? "{}") as FailureReportPayload;
}

test("N3-v0.6.2 · 同节点二次失败必发：重派使 retryCount 变化 ⇒ 新 episode（第 2 条仍含 A）", async () => {
  close();
  createFeature({ featureId: "f-ep2", title: "episode-2", state: "executing" });
  createTask({
    taskId: "A",
    projectId: "p1",
    contextId: "ca",
    state: "working",
    featureId: "f-ep2",
    dispatchMessage: "do A",
  });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "cb",
    state: "working",
    featureId: "f-ep2",
    dependencies: ["A"],
    dispatchMessage: "do B",
  });
  updateTaskState("A", "failed", null, "boom-1");

  let dispatched = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async () => {
      dispatched += 1;
      return { ok: true };
    },
  });

  scheduler.kick();
  await flush();
  assert.equal(failureReports("f-ep2").length, 1, "首次失败静止 ⇒ 恰好 1 条");
  assert.equal(getTask("A")?.retryCount, 0, "未重派 ⇒ retryCount 仍为 0");

  // 重派 A（episode 边界：重派动作本身不改签名，仅使 retryCount 自增）
  const retried = handleFeatureAdvance({
    featureId: "f-ep2",
    to: "executing",
    retryTaskIds: ["A"],
  });
  if (!retried.ok) assert.fail(`重派应成功：${retried.code} ${retried.error}`);
  assert.deepEqual(retried.rearmed, ["A"]);
  assert.equal(getTask("A")?.retryCount, 1, "重派自增 retryCount ⇒ 失败项签名改变");

  // 同一节点再次失败（B 由失败传播重新冻结）
  updateTaskState("A", "failed", null, "boom-2");
  scheduler.kick();
  await flush();

  const reports = failureReports("f-ep2");
  assert.equal(reports.length, 2, "同节点二次失败（retryCount 0→1）⇒ 必发新 episode");
  const second = reportPayload(reports[1]);
  assert.deepEqual(second.failed.map((f) => f.taskId), ["A"], "第 2 条 failed 仍须含 A");
  assert.equal(second.failed[0]?.text, "boom-2");
  assert.deepEqual(second.blockedSet, ["B"], "第 2 条 blockedSet 为重新冻结的 B");
  assert.equal(getFeature("f-ep2")?.state, "executing", "仍不判死");
  assert.equal(dispatched, 0, "全程静止 ⇒ 零派发");
});

test("N3-v0.6.2 · 同静止期幂等：第 2 条之后连续 kick ⇒ 仍 2 条", async () => {
  close();
  createFeature({ featureId: "f-ep2b", title: "episode-2b", state: "executing" });
  createTask({
    taskId: "A",
    projectId: "p1",
    contextId: "ca",
    state: "working",
    featureId: "f-ep2b",
    dispatchMessage: "do A",
  });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "cb",
    state: "working",
    featureId: "f-ep2b",
    dependencies: ["A"],
    dispatchMessage: "do B",
  });
  updateTaskState("A", "failed", null, "boom-1");

  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
  scheduler.kick();
  await flush();

  const retried = handleFeatureAdvance({
    featureId: "f-ep2b",
    to: "executing",
    retryTaskIds: ["A"],
  });
  if (!retried.ok) assert.fail(`重派应成功：${retried.code} ${retried.error}`);
  updateTaskState("A", "failed", null, "boom-2");
  scheduler.kick();
  await flush();
  assert.equal(failureReports("f-ep2b").length, 2, "第 2 个 episode 已发，作为幂等基线");

  for (let i = 0; i < 4; i += 1) {
    scheduler.kick();
    await flush();
  }
  assert.equal(failureReports("f-ep2b").length, 2, "retryCount + 集合不变 ⇒ 严格不重发");
  assert.equal(getTask("A")?.retryCount, 1, "幂等 tick 不改 retryCount");
  assert.equal(getFeature("f-ep2b")?.state, "executing");
});

test("N3-v0.6.2 · 多节点混合重派：仅重派 A ⇒ B 解冻 / D 保持 blocked；A 再失败 ⇒ 新发一条且 blockedSet 含 B、D", async () => {
  close();
  createFeature({ featureId: "f-mix", title: "mixed", state: "executing" });
  createTask({
    taskId: "A",
    projectId: "p1",
    contextId: "ca",
    state: "working",
    featureId: "f-mix",
    dispatchMessage: "do A",
  });
  createTask({
    taskId: "A2",
    projectId: "p1",
    contextId: "ca2",
    state: "working",
    featureId: "f-mix",
    dispatchMessage: "do A2",
  });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "cb",
    state: "working",
    featureId: "f-mix",
    dependencies: ["A"],
    dispatchMessage: "do B",
  });
  createTask({
    taskId: "D",
    projectId: "p1",
    contextId: "cd",
    state: "working",
    featureId: "f-mix",
    dependencies: ["A2"],
    dispatchMessage: "do D",
  });
  updateTaskState("A", "failed", null, "boom-A");
  updateTaskState("A2", "failed", null, "boom-A2");

  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
  scheduler.kick();
  await flush();

  const first = failureReports("f-mix");
  assert.equal(first.length, 1, "首个 episode");
  assert.deepEqual(
    reportPayload(first[0]).failed.map((f) => f.taskId).slice().sort(),
    ["A", "A2"],
  );
  assert.deepEqual(reportPayload(first[0]).blockedSet, ["B", "D"]);

  // 仅重派 A：A 退出失败集 ⇒ B 不在剩余失败（A2）的闭包内 ⇒ 解冻；D 仍在闭包内 ⇒ 保持冻结
  const retried = handleFeatureAdvance({
    featureId: "f-mix",
    to: "executing",
    retryTaskIds: ["A"],
  });
  if (!retried.ok) assert.fail(`重派应成功：${retried.code} ${retried.error}`);
  assert.deepEqual(retried.rearmed, ["A"]);
  assert.deepEqual(retried.unfrozen, ["B"]);
  assert.equal(getTask("B")?.state, "working", "闭包外 blocked 解冻");
  assert.equal(getTask("D")?.state, "blocked", "A2 未重派 ⇒ D 仍在闭包内，保持冻结");
  assert.equal(getTask("A")?.retryCount, 1);
  assert.equal(getTask("A2")?.retryCount, 0);

  // A 再次失败 ⇒ 新 episode；B 由传播重新冻结，blockedSet 同含 B / D
  updateTaskState("A", "failed", null, "boom-A-again");
  scheduler.kick();
  await flush();

  const reports = failureReports("f-mix");
  assert.equal(reports.length, 2, "混合重派后再次失败 ⇒ 新发一条（仅 A 的 retryCount 变）");
  const second = reportPayload(reports[1]);
  assert.deepEqual(second.failed.map((f) => f.taskId).slice().sort(), ["A", "A2"]);
  assert.deepEqual(second.blockedSet, ["B", "D"], "blockedSet 同含 B（重新冻结）与 D（始终保持）");
  assert.equal(getFeature("f-mix")?.state, "executing", "仍不判死");
});

test("N3-v0.6.2 · rearmTask 不变量：needs_input answer 续推后 retryCount 仍为 0，episode 判定正确", async () => {
  close();
  createFeature({ featureId: "f-ni-r", title: "needs_input-rearm", state: "needs_input" });
  createTask({
    taskId: "T",
    projectId: "p1",
    contextId: "ct",
    state: "input-required",
    featureId: "f-ni-r",
    dispatchMessage: "do T",
  });

  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });

  const resumed = handleFeatureAdvance({
    featureId: "f-ni-r",
    to: "executing",
    answer: "继续",
  });
  if (!resumed.ok) assert.fail(`answer 续推应成功：${resumed.code} ${resumed.error}`);
  assert.equal(getFeature("f-ni-r")?.state, "executing");
  assert.equal(getTask("T")?.state, "working", "待澄清节点被重排");
  assert.equal(
    getTask("T")?.retryCount,
    0,
    "`rearmTask` 不参与记账（唯一写口 = `rearmForRetry`）⇒ retryCount 不得 +1",
  );

  updateTaskState("T", "failed", null, "boom");
  scheduler.kick();
  await flush();
  const reports = failureReports("f-ni-r");
  assert.equal(reports.length, 1, "retryCount=0 的失败项 ⇒ 首个 episode 正常发出（未被签名吞掉）");
  assert.deepEqual(reportPayload(reports[0]).failed.map((f) => f.taskId), ["T"]);

  scheduler.kick();
  await flush();
  assert.equal(
    failureReports("f-ni-r").length,
    1,
    "retryCount 未变 ⇒ 同一 episode 幂等不重发",
  );
});

test("N3-v0.6.2 · 边界回归：retryCount 与集合皆不变 ⇒ 严格不重发", async () => {
  close();
  createFeature({ featureId: "f-strict", title: "strict", state: "executing" });
  createTask({
    taskId: "A",
    projectId: "p1",
    contextId: "ca",
    state: "working",
    featureId: "f-strict",
    dispatchMessage: "do A",
  });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "cb",
    state: "working",
    featureId: "f-strict",
    dependencies: ["A"],
    dispatchMessage: "do B",
  });
  updateTaskState("A", "failed", null, "boom");

  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
  scheduler.kick();
  await flush();

  const reports = failureReports("f-strict");
  assert.equal(reports.length, 1, "基线：恰好 1 条");
  const baselineRetry = getTask("A")?.retryCount ?? -1;
  const baselineBlocked = reportPayload(reports[0]).blockedSet;

  for (let i = 0; i < 5; i += 1) {
    scheduler.kick();
    await flush();
  }

  assert.equal(failureReports("f-strict").length, 1, "retryCount + 集合皆不变 ⇒ 严格不重发");
  assert.equal(getTask("A")?.retryCount, baselineRetry, "retryCount 不被静止 tick 改写");
  assert.deepEqual(
    reportPayload(failureReports("f-strict")[0]).blockedSet,
    baselineBlocked,
    "集合不变（B 仍 blocked）",
  );
  assert.equal(getTask("B")?.state, "blocked");
});
