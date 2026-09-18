/**
 * A5（REQ-v0.7.0-2026-09-18-01 §3.1 A5）行为锁定 —— **看护对账目标重写为本地队列态**。
 *
 * pull 模型下执行由目标机 Runner 领取并本地完成，结果经 `/runner/result` → `upsertTaskResult`
 * 落库；看护**不再轮询远端 A2A `tasks/get`**，改为读本地 `tasks` 行。覆盖节点门禁：
 * - **pull 语义对账**：`poll` 读本地行（`queue_state` + 回传落库态），命中终态 ⇒ `persist` +
 *   `onSettled(abandoned=false)`；
 * - **超期 requeue 兜底（B2）**：`claimed`/`running` 且领取者心跳超期 ⇒ 调 O7 回收路径，
 *   **不判 `failed`、不 `stop`**（stale ≠ failed），看护继续等待回收后重 claim 的终态；
 * - **queued 无人领取（B3）**：不自动失败、**不计连续失败**，仅一次性事件提示；
 * - **stale「watched」判据重定义**：`queue_state ∈ queued/claimed/running`；
 * - 既有分类未放宽：`poll` 抛错 / 行缺失仍按上限走 abandoned，`persist` 抛错不走 abandoned。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/*.test.js`）。
 * 隔离：默认库固定 `:memory:`；用库的用例先 `close()` 重置为空库。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimTask,
  close,
  createTask,
  enqueueTask,
  upsertTaskResult,
} from "../session/store.js";
import {
  drainTaskWatchers,
  isQueueWatched,
  isTaskWatched,
  startTaskWatcher,
  type WatchedTaskView,
} from "../bridge/task-watcher.js";

process.env["SESSION_DB"] = ":memory:";

/** 构造看护视角的本地任务行（仅覆盖断言关心字段） */
function view(over: Partial<WatchedTaskView> = {}): WatchedTaskView {
  return {
    taskId: "t",
    state: "working",
    queueState: "claimed",
    claimedBy: null,
    artifactsJson: null,
    text: null,
    featureId: null,
    ...over,
  };
}

/** 本地回传态终态判据（与注入侧同口径） */
function isSettled(t: WatchedTaskView): boolean {
  return (
    t.state === "completed" ||
    t.state === "failed" ||
    t.state === "input-required" ||
    t.state === "blocked"
  );
}

// ---------------------------------------------------------------------------
// 1. pull 语义对账：poll 读本地行，命中终态 ⇒ persist + onSettled
// ---------------------------------------------------------------------------

test("A5 · pull 对账：poll 读本地行，命中终态 ⇒ persist + onSettled(abandoned=false)", async () => {
  const persisted: string[] = [];
  const settled: (WatchedTaskView | null)[] = [];
  const abandoned: boolean[] = [];
  let polls = 0;

  const started = startTaskWatcher({
    taskId: "w-pull",
    poll: () => {
      polls += 1;
      // 前两轮：仍在飞（Runner 已领取、未回传）；第三轮：回传落库终态
      return polls < 3
        ? view({ taskId: "w-pull", queueState: "claimed", claimedBy: "m1" })
        : view({ taskId: "w-pull", state: "completed", queueState: "settled", text: "done" });
    },
    isSettled,
    persist: (t) => {
      persisted.push(t.taskId);
    },
    onSettled: (t, outcome) => {
      settled.push(t);
      abandoned.push(outcome.abandoned);
    },
    pollIntervalMs: 1,
    maxConsecutiveFailures: 5,
  });

  assert.equal(started, true);
  await drainTaskWatchers(2_000);

  assert.deepEqual(persisted, ["w-pull"], "命中终态恰好 persist 一次");
  assert.deepEqual(abandoned, [false], "正常终态不得判 abandoned");
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.text, "done", "onSettled 携带回传载荷（text）");
  assert.equal(isTaskWatched("w-pull"), false, "无库行 ⇒ 非在队（看护已收尾）");
});

// ---------------------------------------------------------------------------
// 2. 超期兜底（B2）：claimed 且心跳超期 ⇒ 调 O7 回收路径；不判 failed、不 stop
// ---------------------------------------------------------------------------

test("A5 · 超期兜底：claimed 且领取超期 ⇒ 调 O7 requeue/事件路径，不判 failed", async () => {
  const reclaimed: string[] = [];
  const settledStates: string[] = [];
  const abandoned: boolean[] = [];
  let polls = 0;

  startTaskWatcher({
    taskId: "w-stale",
    poll: () => {
      polls += 1;
      // 前两轮：超期领取（O7 应回收）；第三轮：回收后被重 claim 并回传终态
      return polls <= 2
        ? view({ taskId: "w-stale", queueState: "claimed", claimedBy: "m1" })
        : view({ taskId: "w-stale", state: "completed", queueState: "settled" });
    },
    isSettled,
    persist: () => undefined,
    isClaimStale: () => true,
    reclaimStale: (t) => {
      reclaimed.push(t.taskId);
    },
    onSettled: (t, outcome) => {
      if (t !== null) settledStates.push(t.state);
      abandoned.push(outcome.abandoned);
    },
    pollIntervalMs: 1,
    maxConsecutiveFailures: 2,
  });

  await drainTaskWatchers(2_000);

  assert.deepEqual(reclaimed, ["w-stale", "w-stale"], "每次观察到超期领取都调 O7 回收路径");
  assert.deepEqual(settledStates, ["completed"], "超期**不判 failed**：仍等回收后重 claim 的终态");
  assert.deepEqual(abandoned, [false], "超期兜底不得触发 abandoned");
});

// ---------------------------------------------------------------------------
// 3. queued 无人领取（B3）：不自动失败、不计连续失败，仅一次性事件提示
// ---------------------------------------------------------------------------

test("A5 · B3：queued 无人领取不计连续失败、不判 failed，仅一次性提示", async () => {
  const hints: string[] = [];
  const abandoned: boolean[] = [];
  let polls = 0;

  startTaskWatcher({
    taskId: "w-unclaimed",
    poll: () => {
      polls += 1;
      // 连续 6 轮 queued（远超 maxConsecutiveFailures）后才被领取并终态
      return polls <= 6
        ? view({ taskId: "w-unclaimed", state: "working", queueState: "queued", claimedBy: null })
        : view({ taskId: "w-unclaimed", state: "completed", queueState: "settled" });
    },
    isSettled,
    persist: () => undefined,
    onUnclaimed: (t) => {
      hints.push(t.taskId);
    },
    onSettled: (_t, outcome) => {
      abandoned.push(outcome.abandoned);
    },
    pollIntervalMs: 1,
    maxConsecutiveFailures: 2, // queued 轮次已 3× 于上限，仍不得放弃
  });

  await drainTaskWatchers(2_000);

  assert.deepEqual(abandoned, [false], "queued 不计连续失败 ⇒ 不得 abandoned");
  assert.equal(polls, 7, "看护不放弃，持续对账直到终态");
  assert.deepEqual(hints, ["w-unclaimed"], "仅一次性事件提示（不刷屏）");
});

// ---------------------------------------------------------------------------
// 4. 既有分类未放宽：行缺失仍按上限走 abandoned（与 poll 抛错同口径）
// ---------------------------------------------------------------------------

test("A5 · 行缺失按上限 abandoned（pull 语义不放宽既有分类）", async () => {
  const abandoned: boolean[] = [];
  let polls = 0;

  startTaskWatcher({
    taskId: "w-missing",
    poll: () => {
      polls += 1;
      return null;
    },
    isSettled,
    persist: () => undefined,
    onSettled: (_t, outcome) => {
      abandoned.push(outcome.abandoned);
    },
    pollIntervalMs: 1,
    maxConsecutiveFailures: 3,
  });

  await drainTaskWatchers(2_000);

  assert.deepEqual(abandoned, [true]);
  assert.equal(polls, 3, "行缺失达上限即放弃，不多轮");
});

// ---------------------------------------------------------------------------
// 5. stale「watched」判据重定义 = queue_state ∈ queued/claimed/running
// ---------------------------------------------------------------------------

test("A5 · isQueueWatched：仅 queued/claimed/running 在队", () => {
  assert.equal(isQueueWatched("queued"), true);
  assert.equal(isQueueWatched("claimed"), true);
  assert.equal(isQueueWatched("running"), true);
  assert.equal(isQueueWatched("settled"), false);
});

test("A5 · isTaskWatched 读本地队列态（无行 / NULL 老行 / settled ⇒ false）", () => {
  close();

  assert.equal(isTaskWatched("missing"), false, "无行 ⇒ 非在队");

  createTask({ taskId: "q", projectId: "p1", contextId: "ct", state: "working" });
  assert.equal(isTaskWatched("q"), false, "未入队（queue_state=NULL 归一 settled）⇒ 非在队");

  enqueueTask("q");
  assert.equal(isTaskWatched("q"), true, "queued ⇒ 在队");

  const claimed = claimTask({ claimedBy: "m1", projectIds: ["p1"] });
  assert.equal(claimed?.queueState, "claimed");
  assert.equal(isTaskWatched("q"), true, "claimed ⇒ 在队");

  upsertTaskResult({
    machineId: "m1",
    taskId: "q",
    projectId: "p1",
    contextId: "ct",
    state: "completed",
  });
  assert.equal(isTaskWatched("q"), false, "回传落终态（settled）⇒ 非在队");
});
