/**
 * v0.8.7 O2 孤儿墙钟出口单测（`node:test`，无新依赖）。
 *
 * 覆盖（改造文档 §2.2 / §4 L1）：
 * - **墙钟超期**：`queue_state ∈ {claimed,running} ∧ claimed_at < now - orphanTimeoutMs` ⇒
 *   `sweepOrphanedTasks()` 置 `state='failed'` ∧ `queue_state='settled'` ∧ `failure_kind='runner'`，
 *   `task.orphaned` **恰一条**；重复 sweep 幂等（零重复产出）。
 * - **未超时不误杀**（负例）：领取未达阈值 ⇒ 零写入零事件。
 * - **同 tick 先 stale 后墙钟**：心跳先命中者走 requeue（可复活），墙钟不收 ⇒ 无 `task.orphaned`。
 * - **契约 3（不清 claim 三字段）**：墙钟判死后迟到件仍过 claim_token 比对 ⇒
 *   `/runner/result` 回 200 ack、行保持 `failed`（首个终态胜出，machine outbox 可清）。
 * - **Feature 静止收敛联动**：墙钟置 `failed` 后调度器 tick 发**恰一条** `feature.failure_report`，
 *   Feature 保持 `executing`。
 * - **门闩**：非 owner ⇒ 空结果、零写库。
 *
 * 确定性驱动：注入固定时钟 + `sweepIntervalMs` 大值关闭自动循环，用例显式调用
 * `sweepStale()` / `sweepOrphanedTasks()`（与 `runner-events.test.ts` 同一先例）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  claimTask,
  close as closeStore,
  createFeature,
  createTask,
  enqueueTask,
  getFeature,
  getQueuedTask,
  listEvents,
  upsertRunner,
} from "../session/store.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import {
  RUNNER_EVENT_TASK_ORPHANED,
  RUNNER_EVENT_TASK_STALE,
  RUNNER_RESULT_PATH,
  createRunnerEndpoints,
  type RunnerEndpointHandle,
  type RunnerEndpointOptions,
} from "../bridge/runner.js";
import { EVENT_FAILURE_REPORT, FeatureScheduler } from "../bridge/scheduler.js";
import type { BridgeCore } from "../bridge/index.js";
import type { EventRecord, MachineRef, MachinesConfig } from "../types.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const transports: HttpTransportHandle[] = [];

after(async () => {
  for (const transport of transports) await transport.close();
  closeStore();
});

/** 内核桩：本测试仅 `/runner/result` 一处触达 http 面，其余方法一律抛错 */
function unused(name: string): never {
  throw new Error(`unused BridgeCore method: ${name}`);
}

function fakeCore(): BridgeCore {
  return {
    projects: async () => unused("projects"),
    tasks: async () => unused("tasks"),
    call: async () => unused("call"),
    registerFeatureNode: () => unused("registerFeatureNode"),
    taskStatus: async () => unused("taskStatus"),
    cancel: async () => unused("cancel"),
    events: () => unused("events"),
    wait: async () => unused("wait"),
    featureCreate: () => unused("featureCreate"),
    featureStatus: () => unused("featureStatus"),
    featureAdvance: () => unused("featureAdvance"),
    featureApprove: () => unused("featureApprove"),
    featureCancel: () => unused("featureCancel"),
    featureTrace: () => unused("featureTrace"),
    configWriteGroup: async () => unused("configWriteGroup"),
    kickScheduler: () => unused("kickScheduler"),
  };
}

/** 固定判决时钟（注入 `now`；所有领取时刻相对它回推） */
const NOW = Date.parse("2026-09-22T00:10:00.000Z");

function makeConfig(machines: MachineRef[], orphanTimeoutMs: number, heartbeatTimeoutMs = 3_600_000): MachinesConfig {
  return {
    machines,
    transport: { mode: "http", http: { host: "127.0.0.1", port: 0, path: "/mcp" } },
    web: { enabled: false, host: "127.0.0.1", port: 0 },
    runner: { holdMs: 50, heartbeatTimeoutMs, orphanTimeoutMs },
  };
}

function machine(machineId: string, token?: string): MachineRef {
  return token === undefined
    ? { machineId, launcherUrl: "" }
    : { machineId, launcherUrl: "", token };
}

/** 建任务（可带 featureId）入队并由指定机器领取（固定 claimToken / 领取时刻） */
function seedClaimedTask(opts: {
  taskId: string;
  projectId: string;
  machineId: string;
  claimToken: string;
  claimedAt: string;
  featureId?: string;
}): void {
  createTask({
    taskId: opts.taskId,
    projectId: opts.projectId,
    contextId: `ctx-${opts.taskId}`,
    state: "working",
    dispatchMessage: `${opts.taskId}: run`,
    prompt: opts.taskId,
    ...(opts.featureId === undefined ? {} : { featureId: opts.featureId }),
  });
  assert.notEqual(enqueueTask(opts.taskId), null, `任务 ${opts.taskId} 应成功入队`);
  const claimed = claimTask({
    claimedBy: opts.machineId,
    claimToken: opts.claimToken,
    claimedAt: opts.claimedAt,
    // 同进程共享 `:memory:` 库 ⇒ 限定本项目，避免抢走其它用例遗留的 queued 行
    projectIds: [opts.projectId],
  });
  assert.equal(claimed?.taskId, opts.taskId, `任务 ${opts.taskId} 应被领取`);
}

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

function sweep(overrides: Partial<RunnerEndpointOptions>): RunnerEndpointHandle {
  return createRunnerEndpoints({
    role: () => "owner",
    config: () => makeConfig([machine("m-any")], 60_000),
    now: () => NOW,
    sweepIntervalMs: 3_600_000, // 关闭自动循环：由用例显式调用确定性驱动
    ...overrides,
  });
}

function eventsOfKind(kind: string, taskId: string): EventRecord[] {
  return listEvents({ since: 0, limit: 1000 }).filter(
    (event) => event.kind === kind && event.taskId === taskId,
  );
}

function payloadOf(event: EventRecord): Record<string, unknown> {
  try {
    return JSON.parse(event.payload ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function post(port: number, body: unknown, token: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${RUNNER_RESULT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 无体响应
  }
  const data = (parsed["data"] ?? {}) as Record<string, unknown>;
  return { status: res.status, data };
}

/** 推进足够多轮次，覆盖 `advanceExecuting` 内的多个 `await` */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function failureReports(featureId: string): EventRecord[] {
  return listEvents({ limit: 1000 }).filter(
    (e) => e.kind === EVENT_FAILURE_REPORT && e.featureId === featureId,
  );
}

// ---------------------------------------------------------------------------
// ① 墙钟超期：failed + settled + runner + task.orphaned 恰一条（幂等 / 契约 3）
// ---------------------------------------------------------------------------

test("墙钟超期 → failed+settled+failure_kind='runner' + task.orphaned 恰一条；重复 sweep 幂等", () => {
  const cfg = makeConfig([machine("m-o2-a", "tok-o2-a")], 60_000);
  const handle = sweep({ config: () => cfg });
  seedClaimedTask({
    taskId: "o2-t-a",
    projectId: "p-o2-a",
    machineId: "m-o2-a",
    claimToken: "ct-o2-a",
    claimedAt: isoAgo(120_000), // 领取已 120s ≥ 60s
  });

  const result = handle.sweepOrphanedTasks();
  assert.deepEqual(result.orphanedTasks, ["o2-t-a"]);

  const row = getQueuedTask("o2-t-a");
  assert.equal(row?.state, "failed");
  assert.equal(row?.queueState, "settled");
  assert.equal(row?.failureKind, "runner", "墙钟判死落「不可续跑」子类（v0.8.8 O1）");
  assert.ok(row?.finishedAt, "终态 ⇒ finished_at 首填");
  // 契约 3 前提：claim 三字段**不清**（迟到件仍可过 token 比对）
  assert.equal(row?.claimToken, "ct-o2-a");
  assert.equal(row?.claimedBy, "m-o2-a");
  assert.equal(row?.claimedAt, isoAgo(120_000));

  const events = eventsOfKind(RUNNER_EVENT_TASK_ORPHANED, "o2-t-a");
  assert.equal(events.length, 1, "task.orphaned 恰一条");
  const payload = payloadOf(events[0] as EventRecord);
  assert.equal(payload.machineId, "m-o2-a");
  assert.equal(payload.projectId, "p-o2-a");
  assert.equal(payload.featureId, null);
  assert.equal(payload.claimedAt, isoAgo(120_000));
  assert.equal(payload.elapsedMs, 120_000);
  assert.equal(payload.timeoutMs, 60_000);

  // 重复清算：行已 `settled` ⇒ 判据不再命中，零写入零事件
  const again = handle.sweepOrphanedTasks();
  assert.deepEqual(again.orphanedTasks, []);
  assert.equal(eventsOfKind(RUNNER_EVENT_TASK_ORPHANED, "o2-t-a").length, 1, "重复清算不得重复产事件");
});

test("契约 3：墙钟判死后的迟到回传仍过 token 比对 ⇒ 200 ack、行保持 failed（首个终态胜出）", async () => {
  const cfg = makeConfig([machine("m-o2-b", "tok-o2-b")], 60_000);
  const handle = sweep({ config: () => cfg });
  seedClaimedTask({
    taskId: "o2-t-b",
    projectId: "p-o2-b",
    machineId: "m-o2-b",
    claimToken: "ct-o2-b",
    claimedAt: isoAgo(120_000),
  });
  assert.deepEqual(handle.sweepOrphanedTasks().orphanedTasks, ["o2-t-b"]);

  const transport = await startHttpTransport({
    core: fakeCore(),
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    isReady: () => true,
    role: () => "owner",
    version: "test",
    onShutdown: () => {
      /* 测试不触发停机 */
    },
    runner: handle,
  });
  transports.push(transport);

  const res = await post(transport.port, {
    machineId: "m-o2-b",
    taskId: "o2-t-b",
    claimToken: "ct-o2-b",
    state: "completed",
    text: "late result",
  }, "tok-o2-b");
  assert.equal(res.status, 200, "迟到件必须 2xx-ignore（非 409）");
  assert.equal(res.data.ack, true);
  assert.equal(res.data.state, "failed", "首个终态胜出：迟到 completed 不覆盖墙钟 failed");
  assert.equal(res.data.idempotent, true);

  const row = getQueuedTask("o2-t-b");
  assert.equal(row?.state, "failed");
  assert.equal(row?.failureKind, "runner", "迟到件不得改写失败分类");
  assert.equal(row?.text, null, "迟到件零写入（text 不被覆盖）");
});

test("未超时不误杀（负例）：领取未达 orphanTimeoutMs ⇒ 零写入零事件", () => {
  const cfg = makeConfig([machine("m-o2-c")], 60_000);
  const handle = sweep({ config: () => cfg });
  seedClaimedTask({
    taskId: "o2-t-c",
    projectId: "p-o2-c",
    machineId: "m-o2-c",
    claimToken: "ct-o2-c",
    claimedAt: isoAgo(30_000), // 30s < 60s
  });

  assert.deepEqual(handle.sweepOrphanedTasks().orphanedTasks, []);
  const row = getQueuedTask("o2-t-c");
  assert.equal(row?.state, "working");
  assert.equal(row?.queueState, "claimed");
  assert.equal(eventsOfKind(RUNNER_EVENT_TASK_ORPHANED, "o2-t-c").length, 0);
});

// ---------------------------------------------------------------------------
// ② 同 tick 顺序：先 sweepStale（心跳命中 → requeue 可复活）后墙钟（只收残量）
// ---------------------------------------------------------------------------

test("同 tick 先 stale 后墙钟：心跳先命中的悬挂领取被 requeue，墙钟不收（无 task.orphaned）", () => {
  const cfg = makeConfig([machine("m-o2-d")], 60_000, 1_000); // 心跳判死 1s < 墙钟 60s
  const handle = sweep({ config: () => cfg });
  upsertRunner({
    runnerId: "m-o2-d",
    machineId: "m-o2-d",
    protocolVersion: "2.2",
    state: "online",
    lastHeartbeatAt: isoAgo(5_000), // 心跳静默 5s ≥ 1s ⇒ 心跳路先命中
  });
  seedClaimedTask({
    taskId: "o2-t-d",
    projectId: "p-o2-d",
    machineId: "m-o2-d",
    claimToken: "ct-o2-d",
    claimedAt: isoAgo(120_000), // 同时墙钟也已超 —— 但 requeue 在前 ⇒ 墙钟判据不命中
  });

  // 复刻 timer 回调的调用序（`bridge/runner.ts` constructor：先 sweepStale 后 sweepOrphanedTasks）
  const stale = handle.sweepStale();
  const orphaned = handle.sweepOrphanedTasks();

  assert.deepEqual(stale.requeuedTasks, ["o2-t-d"], "心跳路先回收");
  assert.deepEqual(orphaned.orphanedTasks, [], "墙钟只收残量");
  const row = getQueuedTask("o2-t-d");
  assert.equal(row?.state, "working", "requeue 可复活：不是 failed");
  assert.equal(row?.queueState, "queued");
  assert.equal(eventsOfKind(RUNNER_EVENT_TASK_STALE, "o2-t-d").length, 1);
  assert.equal(eventsOfKind(RUNNER_EVENT_TASK_ORPHANED, "o2-t-d").length, 0);
});

// ---------------------------------------------------------------------------
// ③ Feature 静止收敛联动：墙钟置 failed → 调度器恰一条 feature.failure_report
// ---------------------------------------------------------------------------

test("墙钟判死的 Feature 节点 → 调度器静止收敛发恰一条 feature.failure_report（Feature 保持 executing）", async () => {
  const cfg = makeConfig([machine("m-o2-e")], 60_000);
  const handle = sweep({ config: () => cfg });
  createFeature({ featureId: "f-o2", title: "墙钟收敛", state: "executing" });
  seedClaimedTask({
    taskId: "o2-t-e",
    projectId: "p-o2-e",
    machineId: "m-o2-e",
    claimToken: "ct-o2-e",
    claimedAt: isoAgo(120_000),
    featureId: "f-o2",
  });

  assert.deepEqual(handle.sweepOrphanedTasks().orphanedTasks, ["o2-t-e"]);

  let dispatched = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async () => {
      dispatched += 1;
      return { ok: true };
    },
  });
  scheduler.kick();
  await flush();
  scheduler.kick();
  await flush();

  assert.equal(getFeature("f-o2")?.state, "executing", "失败静止：Feature 不转移");
  assert.equal(dispatched, 0, "静止期零派发");
  const reports = failureReports("f-o2");
  assert.equal(reports.length, 1, "feature.failure_report 恰一条");
  const payload = JSON.parse(reports[0]?.payload ?? "{}") as {
    failed: { taskId: string }[];
    blockedSet: string[];
  };
  assert.deepEqual(payload.failed.map((f) => f.taskId), ["o2-t-e"]);
  assert.deepEqual(payload.blockedSet, []);
});

// ---------------------------------------------------------------------------
// ④ 门闩：非 owner ⇒ 空结果、零写库
// ---------------------------------------------------------------------------

test("门闩：follower ⇒ sweepOrphanedTasks 空结果且零写库（不抢清算权）", () => {
  const cfg = makeConfig([machine("m-o2-f")], 60_000);
  const handle = sweep({
    config: () => cfg,
    role: () => "follower",
  });
  seedClaimedTask({
    taskId: "o2-t-f",
    projectId: "p-o2-f",
    machineId: "m-o2-f",
    claimToken: "ct-o2-f",
    claimedAt: isoAgo(120_000),
  });

  assert.deepEqual(handle.sweepOrphanedTasks().orphanedTasks, []);
  const row = getQueuedTask("o2-t-f");
  assert.equal(row?.state, "working");
  assert.equal(row?.queueState, "claimed");
  assert.equal(eventsOfKind(RUNNER_EVENT_TASK_ORPHANED, "o2-t-f").length, 0);
});
