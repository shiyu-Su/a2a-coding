/**
 * `orch/session/store.ts` 单元测试（v0.4.0 数据层，`node:test`，无新依赖）。
 *
 * 覆盖：`blocked` 本地态往返、Feature Context 列、Artifact 注册表、事件收件箱
 * （含 `updateTaskState`/`updateFeatureState` 集中写事件）、`inputArtifacts` 往返，
 * 以及 `pruneTasks` 对活跃 Feature 的 `blocked` 任务的保护。
 * v0.4.1：追加存储加固三项——busy timeout、默认库路径锚定 orch 单元根、CAS 条件更新。
 * v0.5.0：追加三时刻列（`created_at` / `started_at` / `finished_at`）的写入时机与旧库迁移。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Worker } from "node:worker_threads";
import { appRootFromModule } from "../app-root.js";
import type { TaskState } from "../types.js";
import {
  DEFAULT_SESSION_DB,
  EVENT_FEATURE_STATE,
  EVENT_TASK_BLOCKED,
  EVENT_TASK_SETTLED,
  openStoreDatabase,
  SessionStore,
} from "../session/store.js";

/** 每个用例独立的内存库（`:memory:` 实例间互不共享） */
function newStore(): SessionStore {
  return new SessionStore(":memory:");
}

test("blocked 任务态可落库并读回", () => {
  const store = newStore();
  try {
    const created = store.createTask({
      taskId: "t-blocked",
      projectId: "p1",
      contextId: "c1",
      state: "blocked",
    });
    assert.equal(created.state, "blocked");
    assert.equal(store.getTask("t-blocked")?.state, "blocked");
  } finally {
    store.close();
  }
});

test("Feature Context 列：contextId 创建落库 + plan/decisions/contracts 增量更新", () => {
  const store = newStore();
  try {
    const created = store.createFeature({
      featureId: "f1",
      title: "并行需求",
      contextId: "ctx-1",
    });
    assert.equal(created.contextId, "ctx-1");
    assert.equal(created.plan, null);
    assert.equal(created.decisions, null);
    assert.equal(created.contracts, null);

    const updated = store.updateFeatureContext("f1", {
      plan: "统一方案",
      decisions: '["D1"]',
      contracts: '{"api":"v1"}',
    });
    assert.equal(updated?.plan, "统一方案");
    assert.equal(updated?.decisions, '["D1"]');
    assert.equal(updated?.contracts, '{"api":"v1"}');
    // 未提供的字段保持原值
    assert.equal(updated?.contextId, "ctx-1");

    // 空 patch 为 no-op，不改变已有值
    const noop = store.updateFeatureContext("f1", {});
    assert.equal(noop?.plan, "统一方案");

    // 不存在的 Feature 返回 null
    assert.equal(store.updateFeatureContext("missing", { plan: "x" }), null);
  } finally {
    store.close();
  }
});

test("inputArtifacts 引用数组往返（JSON 解析正确）", () => {
  const store = newStore();
  try {
    store.createTask({
      taskId: "t2",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      inputArtifacts: [{ producerTaskId: "t1", name: "api.yaml" }, { artifactId: "t1:a1" }],
    });
    const read = store.getTask("t2");
    assert.equal(read?.inputArtifacts?.length, 2);
    assert.equal(read?.inputArtifacts?.[0]?.producerTaskId, "t1");
    assert.equal(read?.inputArtifacts?.[0]?.name, "api.yaml");
    assert.equal(read?.inputArtifacts?.[1]?.artifactId, "t1:a1");

    // 未声明的任务为 null
    store.createTask({ taskId: "t3", projectId: "p1", contextId: "c1", state: "working" });
    assert.equal(store.getTask("t3")?.inputArtifacts, null);
  } finally {
    store.close();
  }
});

test("Artifact 注册表：upsert 覆盖 + 按 Feature / 生产者查询", () => {
  const store = newStore();
  try {
    store.upsertArtifact({
      artifactId: "t1:a1",
      featureId: "f1",
      producerTaskId: "t1",
      name: "api.yaml",
      mime: "text/yaml",
      uri: "file:///tmp/api.yaml",
      size: 128,
      contentHash: "h1",
    });
    store.upsertArtifact({
      artifactId: "t1:a2",
      featureId: "f1",
      producerTaskId: "t1",
      name: "schema.sql",
    });
    store.upsertArtifact({
      artifactId: "t2:a1",
      featureId: "f1",
      producerTaskId: "t2",
      name: "web.html",
    });

    assert.equal(store.listArtifactsByFeature("f1").length, 3);
    assert.equal(store.listArtifactsByProducer("t1").length, 2);

    const first = store.getArtifact("t1:a1");
    assert.equal(first?.mime, "text/yaml");
    assert.equal(first?.size, 128);
    assert.equal(first?.contentHash, "h1");

    // 同 id 覆盖：name 更新，且不产生重复行
    store.upsertArtifact({
      artifactId: "t1:a1",
      featureId: "f1",
      producerTaskId: "t1",
      name: "api-v2.yaml",
    });
    assert.equal(store.getArtifact("t1:a1")?.name, "api-v2.yaml");
    assert.equal(store.listArtifactsByProducer("t1").length, 2);
  } finally {
    store.close();
  }
});

test("事件集中写：状态变化写 task.settled / task.blocked / feature.state；同态不重复", () => {
  const store = newStore();
  try {
    store.createFeature({ featureId: "f1", title: "F" });
    store.createTask({
      taskId: "t1",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      featureId: "f1",
    });

    // working -> completed：task.settled
    store.updateTaskState("t1", "completed", null, "ok");
    // 同态重复更新：不写新事件
    store.updateTaskState("t1", "completed", null, "ok");
    // completed -> blocked：task.blocked
    store.updateTaskState("t1", "blocked");
    // Feature 流转：feature.state
    store.updateFeatureState("f1", "executing");

    const events = store.listEvents();
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((e) => e.kind),
      [EVENT_TASK_SETTLED, EVENT_TASK_BLOCKED, EVENT_FEATURE_STATE],
    );
    assert.equal(events[0]?.taskId, "t1");
    assert.equal(events[0]?.featureId, "f1");
    assert.equal(events[0]?.state, "completed");
    assert.equal(events[1]?.state, "blocked");
    assert.equal(events[2]?.featureId, "f1");
    assert.equal(events[2]?.state, "executing");

    // 游标：since 之后只回增量
    const cursor = events[0]?.eventId ?? 0;
    assert.deepEqual(
      store.listEvents({ since: cursor }).map((e) => e.kind),
      [EVENT_TASK_BLOCKED, EVENT_FEATURE_STATE],
    );
    assert.equal(store.latestEventId(), events[2]?.eventId);

    // 手动 appendEvent 亦纳入游标
    const manual = store.appendEvent({ featureId: "f1", kind: "task.settled", state: "working" });
    assert.equal(store.latestEventId(), manual.eventId);
    assert.equal(store.listEvents({ since: cursor }).length, 3);
  } finally {
    store.close();
  }
});

test("pruneTasks：活跃 Feature 的 blocked 任务不被误删，Feature 终态后方可归档", () => {
  const store = newStore();
  try {
    store.createFeature({ featureId: "f1", title: "F", state: "executing" });
    // 无 Feature 归属的已完成任务（可被超期清理）
    store.createTask({ taskId: "t-free", projectId: "p1", contextId: "c1", state: "completed" });
    // 活跃 Feature 的 blocked 任务（应受保护）
    store.createTask({
      taskId: "t-blocked",
      projectId: "p1",
      contextId: "c1",
      state: "blocked",
      featureId: "f1",
    });

    // retentionDays = -1 → cutoff 在未来，全部“超期”
    const removed = store.pruneTasks({ retentionDays: -1, maxPerProject: 1000 });
    assert.equal(removed, 1); // 仅 t-free
    assert.equal(store.getTask("t-free"), null);
    assert.equal(store.getTask("t-blocked")?.state, "blocked");

    // Feature 转终态后，blocked 任务随归档
    store.updateFeatureState("f1", "failed");
    const removed2 = store.pruneTasks({ retentionDays: -1, maxPerProject: 1000 });
    assert.equal(removed2, 1);
    assert.equal(store.getTask("t-blocked"), null);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// v0.4.1 存储加固
// ---------------------------------------------------------------------------

/** 子线程持有写锁 holdMs 后释放；持锁成功即回传 "locked"（用于消除竞态） */
const LOCK_WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.path);
db.exec("BEGIN IMMEDIATE;");
parentPort.postMessage("locked");
setTimeout(() => {
  try { db.exec("COMMIT;"); } catch { /* 已被终止 */ }
  db.close();
  parentPort.postMessage("released");
}, workerData.holdMs);
`;

test("busy timeout：并发写锁期间等待锁释放而非立即 SQLITE_BUSY", async () => {
  const dbPath = join(tmpdir(), `a2a-busy-${process.pid}-${Date.now()}.sqlite`);
  const store = new SessionStore(dbPath);
  // 另一线程先持有写锁、200ms 后释放；若无 busy timeout，本线程写会立即抛 SQLITE_BUSY
  const worker = new Worker(LOCK_WORKER_SRC, {
    eval: true,
    workerData: { path: dbPath, holdMs: 200 },
  });
  try {
    await once(worker, "message"); // worker 已持锁
    const rec = store.upsertSession({
      projectId: "p1",
      contextId: "c1",
      sessionId: "s1",
      agentKind: "opencode",
    });
    assert.equal(rec.sessionId, "s1");
  } finally {
    store.close();
    await worker.terminate();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
});

test("DEFAULT_SESSION_DB 锚定 orch 单元根（绝对路径，非 cwd 相对）", () => {
  assert.ok(isAbsolute(DEFAULT_SESSION_DB));
  assert.equal(DEFAULT_SESSION_DB, join(appRootFromModule(import.meta.url), "data", "sessions.sqlite"));
});

test("openStoreDatabase：显式 busy timeout 生效且 WAL 保持", () => {
  const dbPath = join(tmpdir(), `a2a-pragma-${process.pid}-${Date.now()}.sqlite`);
  const db = openStoreDatabase(dbPath, 4321);
  try {
    const bt = db.prepare("PRAGMA busy_timeout").get() as Record<string, unknown>;
    assert.equal(Number(bt["timeout"]), 4321);
    const jm = db.prepare("PRAGMA journal_mode").get() as Record<string, unknown>;
    assert.equal(String(jm["journal_mode"]).toLowerCase(), "wal");
  } finally {
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
});

test("SESSION_DB 环境变量优先于默认路径", () => {
  const prev = process.env["SESSION_DB"];
  process.env["SESSION_DB"] = ":memory:";
  const store = new SessionStore();
  try {
    store.createTask({ taskId: "env-t", projectId: "p1", contextId: "c1", state: "working" });
    assert.equal(store.getTask("env-t")?.state, "working");
  } finally {
    store.close();
    if (prev === undefined) delete process.env["SESSION_DB"];
    else process.env["SESSION_DB"] = prev;
  }
});

test("CAS 条件更新：仅当期望态匹配才写入；过期期望被拒绝（防丢失更新）", () => {
  const store = newStore();
  try {
    // Task：正常 CAS
    store.createTask({ taskId: "t1", projectId: "p1", contextId: "c1", state: "working" });
    assert.equal(store.compareAndSwapTaskState("t1", "working", "completed", null, "ok"), true);
    assert.equal(store.getTask("t1")?.state, "completed");
    // 期望态已过期（当前 completed ≠ working）→ 拒绝，不覆盖
    assert.equal(store.compareAndSwapTaskState("t1", "working", "failed"), false);
    assert.equal(store.getTask("t1")?.state, "completed");
    // 不存在的任务 → 拒绝
    assert.equal(store.compareAndSwapTaskState("missing", "working", "completed"), false);

    // Feature：正常 CAS + 过期拒绝（用**枚举内**的态：waiting_approval → executing）
    // 显式给出初态：本用例验证的是 **CAS 语义**，不依赖 `createFeature` 的缺省态
    store.createFeature({ featureId: "f1", title: "F", state: "waiting_approval" });
    assert.equal(store.compareAndSwapFeatureState("f1", "waiting_approval", "executing"), true);
    assert.equal(store.getFeature("f1")?.state, "executing");
    assert.equal(store.compareAndSwapFeatureState("f1", "waiting_approval", "testing"), false);
    assert.equal(store.getFeature("f1")?.state, "executing");
  } finally {
    store.close();
  }
});

test("CAS 接入既有路径：updateTaskState/updateFeatureState 保留返回值语义与事件写入", () => {
  const store = newStore();
  try {
    store.createFeature({ featureId: "f1", title: "F" });
    store.createTask({
      taskId: "t1",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      featureId: "f1",
    });

    // 不存在的 id：返回 null（与既有语义一致）
    assert.equal(store.updateTaskState("missing", "completed"), null);
    assert.equal(store.updateFeatureState("missing", "executing"), null);

    // 正常流转：返回落库记录 + 写事件
    assert.equal(store.updateTaskState("t1", "completed", null, "ok")?.state, "completed");
    assert.equal(store.updateFeatureState("f1", "executing")?.state, "executing");

    // 同态重复：不重复写事件
    store.updateTaskState("t1", "completed");
    store.updateFeatureState("f1", "executing");

    const events = store.listEvents();
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.kind),
      [EVENT_TASK_SETTLED, EVENT_FEATURE_STATE],
    );
  } finally {
    store.close();
  }
});

test("v0.4.1 迁移：旧库补列幂等、老行取默认值、新列可回读（exhausted/failure_kind）", () => {
  const dbPath = join(tmpdir(), `a2a-v041-migrate-${process.pid}-${Date.now()}.sqlite`);
  try {
    // ① 造一个「旧库」：手工建缺 v0.4.1 五列的 tasks 表 + 一条老行
    const legacy = openStoreDatabase(dbPath);
    legacy.exec(
      "CREATE TABLE tasks (task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, " +
        "context_id TEXT NOT NULL, state TEXT NOT NULL, artifacts_json TEXT, updated_at TEXT NOT NULL)",
    );
    legacy.exec(
      "INSERT INTO tasks (task_id, project_id, context_id, state, updated_at) " +
        "VALUES ('legacy-1', 'p1', 'c1', 'completed', '2026-09-15T00:00:00.000Z')",
    );
    legacy.close();

    // ② 首次打开 = 迁移（try-ALTER 补 5 列）；再开一次 = 迁移重复执行（幂等，不应抛）
    new SessionStore(dbPath).close();
    const store = new SessionStore(dbPath);
    try {
      // rowToTask 映射 + 老行默认值（INTEGER NOT NULL DEFAULT 0 / TEXT NULL）
      const legacyRow = store.getTask("legacy-1");
      assert.equal(legacyRow?.retryCount, 0);
      assert.equal(legacyRow?.failureKind, null);
      // v0.6.1 REQ-05：三个休眠列自本期起**不进 SELECT**，读侧恒中性值
      assert.equal(legacyRow?.exhausted, false);
      assert.equal(legacyRow?.notBefore, null);
      assert.equal(legacyRow?.lastPollAt, null);
    } finally {
      store.close();
    }

    // ③ 列仍在库中（schema 不挖）；`failure_kind` 仍可读写，**休眠三列不再被读出**
    const raw = openStoreDatabase(dbPath);
    raw.exec("UPDATE tasks SET exhausted = 1, not_before = '2030-01-01T00:00:00.000Z', failure_kind = 'infra' WHERE task_id = 'legacy-1'");
    raw.close();
    const store2 = new SessionStore(dbPath);
    try {
      const row = store2.getTask("legacy-1");
      // 休眠列即便在库中被置位也不被读回（读侧恒中性值 ⇒ 「停止读写」可机械核验）
      assert.equal(row?.exhausted, false, "exhausted 休眠列：读侧恒 false（旧值不再可读）");
      assert.equal(row?.notBefore, null, "not_before 休眠列：读侧恒 null");
      assert.equal(row?.failureKind, "infra", "failure_kind 仍可读（只停写，不停读）");
      assert.equal(row?.state, "completed", "列搬动不得改写 state");
    } finally {
      store2.close();
    }
  } finally {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
});

/** 迁移期捕获 `console.error`（断言"正常升级不告警" / "脏值告警且有留痕"） */
function captureConsoleError<T>(run: () => T, sink: string[]): T {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    sink.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    return run();
  } finally {
    console.error = original;
  }
}

test("N2b 迁移：退役三态归一 + 脏值兜底 + 三条纪律（不改 updated_at / 不写事件 / 幂等）", () => {
  const dbPath = join(tmpdir(), `a2a-n2b-migrate-${process.pid}-${Date.now()}.sqlite`);
  const T0 = "2026-01-01T00:00:00.000Z";
  try {
    // ① 造"旧库"：先空打开一次建表，再用**直连**句柄塞入退役态与真脏值
    //    （枚举收缩后 `createFeature` 已拒退役态，无法用它造数据）
    new SessionStore(dbPath).close();
    const raw = openStoreDatabase(dbPath);
    for (const [id, state] of [
      ["legacy-discussing", "discussing"],
      ["legacy-analyzing", "analyzing"],
      ["legacy-planning", "planning"],
      ["dirty-unknown", "weird_state"],
    ] as const) {
      raw.exec(
        `INSERT INTO features (feature_id, state, title, created_at, updated_at)
         VALUES ('${id}', '${state}', 'L', '${T0}', '${T0}')`,
      );
    }
    raw.close();

    // ② 首次打开 = 迁移：退役态走正常路径（**不告警**），真脏值走兜底（**告警 + 留痕**）
    const collected: string[] = [];
    const store = captureConsoleError(() => new SessionStore(dbPath), collected);
    try {
      for (const id of [
        "legacy-discussing",
        "legacy-analyzing",
        "legacy-planning",
        "dirty-unknown",
      ]) {
        assert.equal(store.getFeature(id)?.state, "waiting_approval", `${id} 应归一到审批门`);
      }
      const warnings = collected.filter((line) => line.includes("脏值归一"));
      assert.equal(warnings.length, 1, "只有真脏值触发兜底（退役三态属正常升级路径）");
      assert.match(warnings[0] ?? "", /weird_state/);
      // 纪律 (a)：不改 updated_at；纪律 (b)：不写 feature.state 事件
      assert.equal(store.getFeature("legacy-discussing")?.updatedAt, T0, "归一不得改 updated_at");
      assert.equal(store.listEvents().length, 0, "迁移不得写 feature.state 事件");
    } finally {
      store.close();
    }

    // ③ 幂等：重复打开零行命中、状态 / 时间戳 / 事件均不变、不再告警
    const collected2: string[] = [];
    const store2 = captureConsoleError(() => new SessionStore(dbPath), collected2);
    try {
      assert.equal(store2.getFeature("legacy-analyzing")?.state, "waiting_approval");
      assert.equal(store2.getFeature("legacy-analyzing")?.updatedAt, T0);
      assert.equal(store2.listEvents().length, 0);
      assert.deepEqual(
        store2.listFeatures().map((f) => f.state),
        ["waiting_approval", "waiting_approval", "waiting_approval", "waiting_approval"],
      );
      assert.deepEqual(collected2, [], "幂等：重复迁移不应再产生告警");
    } finally {
      store2.close();
    }
  } finally {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
});

test("rearmForRetry：仅 failed 命中；命中后 retry_count +1、清 remote_task_id / finished_at；非 failed 零变化", () => {
  const store = newStore();
  try {
    // 非 failed（working）→ 不命中，且字段零变化
    store.createTask({
      taskId: "t-working",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      remoteTaskId: "remote-1",
      dispatchMessage: "orig",
    });
    assert.equal(store.rearmForRetry("t-working", "retry note"), false);
    const working = store.getTask("t-working");
    assert.equal(working?.state, "working");
    assert.equal(working?.retryCount, 0, "未命中不得自增 retry_count");
    assert.equal(working?.remoteTaskId, "remote-1", "未命中不得清 remote_task_id");
    assert.equal(working?.dispatchMessage, "orig");

    // failed → 命中：state / remote_task_id / dispatch_message / retry_count / finished_at 一次写全
    store.createTask({
      taskId: "t-failed",
      projectId: "p1",
      contextId: "c1",
      state: "failed",
      remoteTaskId: "remote-2",
      dispatchMessage: "orig",
    });
    assert.ok(store.getTask("t-failed")?.finishedAt !== null, "failed 是终态口径之一 ⇒ 有 finished_at");

    assert.equal(store.rearmForRetry("t-failed", "orig\n\n【重派】"), true);
    const retried = store.getTask("t-failed");
    assert.equal(retried?.state, "working");
    assert.equal(retried?.remoteTaskId, null);
    assert.equal(retried?.dispatchMessage, "orig\n\n【重派】");
    assert.equal(retried?.retryCount, 1, "本列自 REQ-05 起语义休眠（仅供重派记账），原语行为保留");
    assert.equal(retried?.contextId, "c1", "重派同 contextId 续接（不得换 ctx）");
    assert.equal(retried?.finishedAt, null, "回到未完成 ⇒ 必须清 finished_at（不变量：有 finished_at ⇔ 已完成）");

    // 第二次：已非 failed → 不命中、不再自增
    assert.equal(store.rearmForRetry("t-failed", "again"), false);
    assert.equal(store.getTask("t-failed")?.retryCount, 1);

    // 任务不存在 → 不命中
    assert.equal(store.rearmForRetry("missing", "x"), false);
  } finally {
    store.close();
  }
});

test("N2：失败自动化五层的 store 写口整块移除（markTaskExhausted / markTaskFailureKind / setTaskNotBefore / setTaskLastPollAt）", () => {
  const store = newStore() as unknown as Record<string, unknown>;
  for (const gone of [
    "markTaskExhausted",
    "markTaskFailureKind",
    "setTaskNotBefore",
    "setTaskLastPollAt",
  ]) {
    assert.equal(store[gone], undefined, `${gone} 必须整块删除（休眠列停止读写）`);
  }
  const store2 = newStore();
  try {
    // 仅重派原语保留（供 N4 复用），其余失败自动化写口不存在 ⇒ 建任务后故障列恒中性值
    store2.createTask({ taskId: "t-n2", projectId: "p1", contextId: "c1", state: "failed" });
    const rec = store2.getTask("t-n2");
    assert.equal(rec?.exhausted, false);
    assert.equal(rec?.failureKind, null);
    assert.equal(rec?.notBefore, null);
    assert.equal(rec?.lastPollAt, null);
  } finally {
    store2.close();
  }
});

/** `finished_at` 终态口径（与 store 内 `FINISHED_TASK_STATES` 对齐；用于不变量断言） */
const FINISHED_STATES = ["completed", "failed", "blocked"] as const;

/** 终态口径成员判定（`as const` 元组的 `includes` 收窄到字面量，此处放宽回 `TaskState`） */
function isFinishedState(state: TaskState): boolean {
  return (FINISHED_STATES as readonly TaskState[]).includes(state);
}

test("v0.5.0 三时刻列：created_at 首次为准、started_at 仅 NULL 才填、finished_at 仅三终态写", () => {
  const store = newStore();
  try {
    // ① createTask(working)：created_at / started_at 落库，finished_at 为 NULL
    const created = store.createTask({
      taskId: "t-moments",
      projectId: "p1",
      contextId: "c1",
      state: "working",
    });
    assert.equal(typeof created.createdAt, "string", "working 登记应写 created_at");
    assert.equal(created.createdAt, created.updatedAt, "首次落库：created_at 与 updated_at 同源");
    assert.equal(typeof created.startedAt, "string", "working 登记应写 started_at");
    assert.equal(created.finishedAt, null, "working 不得写 finished_at");

    // ② 同 id upsert：created_at / started_at **不被覆盖**（首次为准），updated_at 照常刷新
    const laterIso = "2030-01-01T00:00:00.000Z";
    const again = store.createTask({
      taskId: "t-moments",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      updatedAt: laterIso,
    });
    assert.equal(again.updatedAt, laterIso, "updated_at 照常被 upsert 刷新");
    assert.equal(again.createdAt, created.createdAt, "upsert 不得覆盖 created_at（首次为准）");
    assert.equal(again.startedAt, created.startedAt, "upsert 不得重置 started_at（首次开工为准）");
    assert.equal(again.finishedAt, null);

    // ③ markTaskDispatched：**仅当 started_at IS NULL 才填**（幂等、不覆盖重派）
    //    登记态非 working ⇒ started_at 为 NULL（如 input-required = 等澄清）
    store.createTask({
      taskId: "t-idem",
      projectId: "p1",
      contextId: "c1",
      state: "input-required",
    });
    assert.equal(store.getTask("t-idem")?.startedAt, null, "非 working 登记不写 started_at");
    const firstDispatch = store.markTaskDispatched("t-idem", "remote-A");
    assert.equal(typeof firstDispatch?.startedAt, "string", "首次派发补 started_at");
    const secondDispatch = store.markTaskDispatched("t-idem", "remote-B");
    assert.equal(
      secondDispatch?.startedAt,
      firstDispatch?.startedAt,
      "重派不得覆盖 started_at（仅 NULL 才填）",
    );
    assert.equal(secondDispatch?.remoteTaskId, "remote-B", "remote_task_id 照常回填最新");

    // ④ createTask 终态：仅 completed / failed / blocked 写 finished_at
    for (const state of FINISHED_STATES) {
      const rec = store.createTask({
        taskId: `t-fin-${state}`,
        projectId: "p1",
        contextId: "c1",
        state,
      });
      assert.equal(typeof rec.finishedAt, "string", `${state} 应写 finished_at`);
      assert.equal(rec.finishedAt, rec.updatedAt, `${state}：finished_at 与本次 updated_at 同源`);
    }
    // working / input-required 是中间态 ⇒ 不得写（独立单任务走 handleCall 直接 createTask(终态)，
    // 故 createTask 这一写口必须覆盖；此处同时锁住"非终态不写"）
    for (const state of ["working", "input-required"] as TaskState[]) {
      const rec = store.createTask({
        taskId: `t-nofin-${state}`,
        projectId: "p1",
        contextId: "c1",
        state,
      });
      assert.equal(rec.finishedAt, null, `${state} 不得写 finished_at`);
    }

    // ⑤ CAS 写口：working → 终态落 finished_at；working → input-required 不落
    store.createTask({ taskId: "t-cas", projectId: "p1", contextId: "c1", state: "working" });
    assert.equal(store.getTask("t-cas")?.finishedAt, null);
    assert.equal(store.compareAndSwapTaskState("t-cas", "working", "completed", null, "ok"), true);
    assert.equal(typeof store.getTask("t-cas")?.finishedAt, "string", "CAS 转终态应写 finished_at");

    store.createTask({ taskId: "t-cas2", projectId: "p1", contextId: "c1", state: "working" });
    assert.equal(store.compareAndSwapTaskState("t-cas2", "working", "input-required"), true);
    assert.equal(store.getTask("t-cas2")?.finishedAt, null, "input-required ≠ 已完成，不写");

    // ⑥ rearmTask / rearmForRetry 清空 finished_at（回到"未完成"）
    store.createTask({ taskId: "t-rearm", projectId: "p1", contextId: "c1", state: "completed" });
    const beforeRearm = store.getTask("t-rearm");
    assert.equal(typeof beforeRearm?.finishedAt, "string");
    const rearmed = store.rearmTask("t-rearm", "resume");
    assert.equal(rearmed?.state, "working");
    assert.equal(rearmed?.finishedAt, null, "rearmTask 必须清 finished_at");
    assert.equal(rearmed?.createdAt, beforeRearm?.createdAt, "rearm 不改 created_at");
    assert.equal(rearmed?.startedAt, beforeRearm?.startedAt, "rearm 不改 started_at（不重置起点）");

    store.createTask({ taskId: "t-rearm2", projectId: "p1", contextId: "c1", state: "failed" });
    assert.equal(typeof store.getTask("t-rearm2")?.finishedAt, "string");
    assert.equal(store.rearmForRetry("t-rearm2", "orig"), true);
    assert.equal(store.getTask("t-rearm2")?.finishedAt, null, "rearmForRetry 必须清 finished_at");

    // ⑦ 不变量全表抽查：有 finished_at ⇔ state ∈ 终态口径
    for (const t of store.listTasks({ projectId: "p1", limit: 100 })) {
      assert.equal(
        t.finishedAt !== null,
        isFinishedState(t.state),
        `${t.taskId}(${t.state}) 破坏不变量「有 finished_at ⇔ 已完成」`,
      );
    }
  } finally {
    store.close();
  }
});

test("v0.5.0 迁移：旧库补三时刻列幂等、老行留 NULL（不回填）、新列可回读", () => {
  const dbPath = join(tmpdir(), `a2a-v050-moments-${process.pid}-${Date.now()}.sqlite`);
  try {
    // ① 造「旧库」：tasks 表**无三时刻列** + 一条老行
    const legacy = openStoreDatabase(dbPath);
    legacy.exec(
      "CREATE TABLE tasks (task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, " +
        "context_id TEXT NOT NULL, state TEXT NOT NULL, artifacts_json TEXT, updated_at TEXT NOT NULL)",
    );
    legacy.exec(
      "INSERT INTO tasks (task_id, project_id, context_id, state, updated_at) " +
        "VALUES ('legacy-m', 'p1', 'c1', 'completed', '2026-09-15T00:00:00.000Z')",
    );
    legacy.close();

    // ② 首次打开 = 迁移（try-ALTER 补 3 列）；再开一次 = 迁移重复执行（幂等，不应抛）
    new SessionStore(dbPath).close();
    const store = new SessionStore(dbPath);
    try {
      const row = store.getTask("legacy-m");
      assert.equal(row?.createdAt, null, "老数据不回填 created_at（留 NULL）");
      assert.equal(row?.startedAt, null, "老数据不回填 started_at（留 NULL）");
      assert.equal(row?.finishedAt, null, "老数据不回填 finished_at（留 NULL）");
      assert.equal(row?.state, "completed", "补列不得改写既有列");
      assert.equal(row?.updatedAt, "2026-09-15T00:00:00.000Z");
    } finally {
      store.close();
    }

    // ③ 新列可写回并读回（TASK_COLUMNS / rowToTask 已覆盖三列）
    const raw = openStoreDatabase(dbPath);
    raw.exec(
      "UPDATE tasks SET created_at = '2026-01-01T00:00:00.000Z', " +
        "started_at = '2026-01-01T00:00:01.000Z', finished_at = '2026-01-01T00:00:02.000Z' " +
        "WHERE task_id = 'legacy-m'",
    );
    raw.close();
    const store2 = new SessionStore(dbPath);
    try {
      const row = store2.getTask("legacy-m");
      assert.equal(row?.createdAt, "2026-01-01T00:00:00.000Z");
      assert.equal(row?.startedAt, "2026-01-01T00:00:01.000Z");
      assert.equal(row?.finishedAt, "2026-01-01T00:00:02.000Z");
    } finally {
      store2.close();
    }
  } finally {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
});

// ---------------------------------------------------------------------------
// v0.7.0 A2：Runner 注册表 + 任务队列地基
// ---------------------------------------------------------------------------

/** 临时库路径（文件库；跨连接 / 跨实例断言需要，`:memory:` 做不到） */
function tempDbPath(tag: string): string {
  return join(tmpdir(), `a2a-${tag}-${process.pid}-${Date.now()}.sqlite`);
}

function cleanupDb(dbPath: string): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

test("A2 Runner 注册表：按 machine_id 幂等 upsert、registered_at 首次为准、心跳刷新、项目全量替换", () => {
  const store = newStore();
  try {
    const first = store.upsertRunner({
      runnerId: "r1",
      machineId: "m1",
      protocolVersion: "2.0",
      version: "0.7.0",
      registeredAt: "2026-09-18T00:00:00.000Z",
      lastHeartbeatAt: "2026-09-18T00:00:00.000Z",
    });
    assert.equal(first.runnerId, "r1");
    assert.equal(first.machineId, "m1");
    assert.equal(first.state, "online");
    assert.equal(first.registeredAt, "2026-09-18T00:00:00.000Z");

    // 同机重注册（新实例 id）：命中同一行；registered_at 保留首次，其余刷新
    const again = store.upsertRunner({
      runnerId: "r2",
      machineId: "m1",
      protocolVersion: "2.0",
      version: "0.7.1",
      registeredAt: "2026-09-18T01:00:00.000Z",
      lastHeartbeatAt: "2026-09-18T01:00:00.000Z",
    });
    assert.equal(again.runnerId, "r2");
    assert.equal(again.registeredAt, "2026-09-18T00:00:00.000Z", "registered_at 首次为准");
    assert.equal(again.version, "0.7.1");
    assert.equal(again.lastHeartbeatAt, "2026-09-18T01:00:00.000Z");

    // 心跳：按 runner_id 刷新 + 置回 online；不存在返回 null
    store.upsertRunner({
      runnerId: "r2",
      machineId: "m1",
      protocolVersion: "2.0",
      state: "offline",
    });
    const beat = store.touchRunnerHeartbeat("r2", "2026-09-18T02:00:00.000Z");
    assert.equal(beat?.lastHeartbeatAt, "2026-09-18T02:00:00.000Z");
    assert.equal(beat?.state, "online");
    assert.equal(store.touchRunnerHeartbeat("missing"), null);

    // 项目全量替换
    const two = store.runnerProjectsReplace("r2", [
      {
        projectId: "p1",
        agentKind: "opencode",
        a2aPort: 4101,
        status: "online",
        workspace: "G:/p1",
        risk: "write",
        startedAt: "2026-09-18T00:00:03.000Z",
      },
      { projectId: "p2", agentKind: "codex", a2aPort: 4102, status: "offline" },
    ]);
    assert.equal(two.length, 2);
    assert.equal(two[0]?.projectId, "p1");
    assert.equal(two[0]?.risk, "write");
    assert.equal(two[0]?.workspace, "G:/p1");
    assert.equal(two[1]?.workspace, null);
    assert.equal(typeof two[0]?.updatedAt, "string");

    // 全量替换 ⇒ 本次未上报的 p2 被移除；重复替换幂等；空数组 = 清空
    const one = store.runnerProjectsReplace("r2", [
      { projectId: "p1", agentKind: "opencode", a2aPort: 4101, status: "online" },
    ]);
    assert.deepEqual(
      one.map((p) => p.projectId),
      ["p1"],
    );
    assert.deepEqual(
      store
        .runnerProjectsReplace("r2", [
          { projectId: "p1", agentKind: "opencode", a2aPort: 4101, status: "online" },
        ])
        .map((p) => p.projectId),
      ["p1"],
    );
    assert.deepEqual(store.runnerProjectsReplace("r2", []), []);
  } finally {
    store.close();
  }
});

test("A2 队列 claim CAS：同一任务并发至多一个领取者（两实例同库竞争唯一）", () => {
  const dbPath = tempDbPath("a2-claim");
  const storeA = new SessionStore(dbPath);
  const storeB = new SessionStore(dbPath);
  try {
    storeA.createTask({ taskId: "q1", projectId: "p1", contextId: "c1", state: "working" });
    const enq = storeA.enqueueTask("q1");
    assert.equal(enq?.queueState, "queued");
    assert.ok(enq?.queuedAt);
    assert.ok(enq?.dispatchGuard, "dispatch_guard 降级为入队幂等键");

    // 入队幂等：重复入队不刷新 queued_at / guard（FIFO 位次与幂等键均不变）
    const enq2 = storeA.enqueueTask("q1");
    assert.equal(enq2?.queuedAt, enq?.queuedAt);
    assert.equal(enq2?.dispatchGuard, enq?.dispatchGuard);

    // 两实例同时领取：CAS 保证只有一行成功（另一实例候选为空 / CAS 落空）
    const a = storeA.claimTask({ claimedBy: "m1" });
    const b = storeB.claimTask({ claimedBy: "m2" });
    const winners = [a, b].filter((r) => r !== null);
    assert.equal(winners.length, 1, "同一 queued 任务并发领取至多一个成功");
    const won = winners[0];
    assert.equal(won?.taskId, "q1");
    assert.equal(won?.queueState, "claimed");
    assert.ok(won?.claimToken);
    assert.ok(won?.claimedAt);

    // 二次领取（任一实例）均失败：已被 claim，CAS 只认 queue_state='queued'
    assert.equal(storeA.claimTask({ claimedBy: "m1" }), null);
    assert.equal(storeB.claimTask({ claimedBy: "m2" }), null);
  } finally {
    storeA.close();
    storeB.close();
    cleanupDb(dbPath);
  }
});

test("A2 队列：未入队不可领；projectIds 过滤；空集零 I/O；入队不存在任务返回 null", () => {
  const store = newStore();
  try {
    assert.equal(store.enqueueTask("missing"), null, "任务不存在 ⇒ 入队返回 null");

    store.createTask({ taskId: "q1", projectId: "p1", contextId: "c1", state: "working" });
    store.createTask({ taskId: "q2", projectId: "p2", contextId: "c2", state: "working" });
    // 未入队（queue_state 为 NULL = 视为 settled）⇒ 不可领
    assert.equal(store.claimTask({ claimedBy: "m1" }), null);

    store.enqueueTask("q1");
    store.enqueueTask("q2");
    // 显式空数组 = 无可领取（零 I/O）
    assert.equal(store.claimTask({ claimedBy: "m1", projectIds: [] }), null);
    // projectIds 过滤：只在 p2 内领取
    const claimed = store.claimTask({ claimedBy: "m1", projectIds: ["p2"] });
    assert.equal(claimed?.taskId, "q2");
    assert.equal(claimed?.projectId, "p2");
    // 领取后其项目内的 q1 仍可被领（过滤只约束当次）
    assert.equal(store.claimTask({ claimedBy: "m1" })?.taskId, "q1");
  } finally {
    store.close();
  }
});

test("A2 requeueStaleTask：claimed→queued + 清 claim 三字段；按领取者过滤；非领取零写入", () => {
  const dbPath = tempDbPath("a2-requeue");
  const store = new SessionStore(dbPath);
  try {
    store.createTask({ taskId: "q1", projectId: "p1", contextId: "c1", state: "working" });
    store.enqueueTask("q1");
    const claimed = store.claimTask({ claimedBy: "m1", claimedAt: "2026-09-18T00:00:01.000Z" });
    assert.equal(claimed?.queueState, "claimed");
    const queuedAt = claimed?.queuedAt;

    // 领取者不匹配 ⇒ 不清算（防误清他人）
    assert.equal(store.requeueStaleTask("q1", "other"), false);
    // 正确领取者 ⇒ claimed→queued，清 claim 三字段
    assert.equal(store.requeueStaleTask("q1", "m1"), true);

    const raw = openStoreDatabase(dbPath);
    try {
      const row = raw
        .prepare(
          "SELECT queue_state, claimed_by, claim_token, claimed_at, queued_at FROM tasks WHERE task_id = 'q1'",
        )
        .get() as Record<string, unknown>;
      assert.equal(row["queue_state"], "queued");
      assert.equal(row["claimed_by"], null, "claim 三字段之一：claimed_by 清空");
      assert.equal(row["claim_token"], null, "claim 三字段之二：claim_token 清空");
      assert.equal(row["claimed_at"], null, "claim 三字段之三：claimed_at 清空");
      assert.equal(row["queued_at"], queuedAt, "清算保留原 queued_at（FIFO 位次不变）");
    } finally {
      raw.close();
    }

    // 已非领取态 / 任务不存在 ⇒ 零写入
    assert.equal(store.requeueStaleTask("q1"), false);
    assert.equal(store.requeueStaleTask("missing"), false);

    // 清算后可被重新领取（新 token / 新领取者）
    const reclaimed = store.claimTask({ claimedBy: "m2" });
    assert.equal(reclaimed?.queueState, "claimed");
    assert.equal(reclaimed?.claimedBy, "m2");
    assert.notEqual(reclaimed?.claimToken, claimed?.claimToken);
  } finally {
    store.close();
    cleanupDb(dbPath);
  }
});

test("A2 upsertTaskResult：按 (machineId,taskId) 幂等、首个终态胜出、缺行可建、队列态 settled", () => {
  const store = newStore();
  try {
    store.createTask({
      taskId: "t1",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      featureId: "f1",
    });
    const first = store.upsertTaskResult({
      machineId: "m1",
      taskId: "t1",
      projectId: "p1",
      contextId: "c1",
      state: "completed",
      artifactsJson: '{"a":1}',
      text: "ok",
      remoteTaskId: "remote-1",
    });
    assert.equal(first.state, "completed");
    assert.equal(first.queueState, "settled");
    assert.equal(first.artifactsJson, '{"a":1}');
    assert.equal(first.text, "ok");
    assert.equal(first.remoteTaskId, "remote-1");
    assert.equal(typeof first.finishedAt, "string");
    assert.equal(first.featureId, "f1", "落库不得动既有编排列");

    // 双路径同键同载荷重复到达：零变化（updated_at / finished_at 不刷新）⇒ 严格幂等
    const second = store.upsertTaskResult({
      machineId: "m1",
      taskId: "t1",
      projectId: "p1",
      contextId: "c1",
      state: "completed",
      artifactsJson: '{"a":1}',
      text: "ok",
      remoteTaskId: "remote-1",
    });
    assert.equal(second.updatedAt, first.updatedAt, "重复回传不得刷新 updated_at");
    assert.equal(second.finishedAt, first.finishedAt);

    // 首个终态胜出：迟到且状态 / 载荷不同的上报不得回退、不得覆盖 artifacts
    const late = store.upsertTaskResult({
      machineId: "m1",
      taskId: "t1",
      projectId: "p1",
      contextId: "c1",
      state: "failed",
      artifactsJson: '{"a":2}',
      text: "late",
    });
    assert.equal(late.state, "completed");
    assert.equal(late.artifactsJson, '{"a":1}');
    assert.equal(late.text, "ok");

    // 缺行（任务未落库）⇒ 直接建行并 settled；input-required 非终态 ⇒ 无 finished_at
    const created = store.upsertTaskResult({
      machineId: "m1",
      taskId: "t-missing",
      projectId: "p9",
      contextId: "c9",
      state: "input-required",
      text: "need info",
    });
    assert.equal(created.state, "input-required");
    assert.equal(created.queueState, "settled");
    assert.equal(created.finishedAt, null);
  } finally {
    store.close();
  }
});

test("A2 迁移：四段前向幂等（连续三跑库状态一致）+ 注册表不启动清空", () => {
  const dbPath = tempDbPath("a2-migrate");
  try {
    // 第一跑：建库（四段迁移）+ 落注册表 / 队列数据
    const s1 = new SessionStore(dbPath);
    s1.upsertRunner({
      runnerId: "r1",
      machineId: "m1",
      protocolVersion: "2.0",
      version: "0.7.0",
      registeredAt: "2026-09-18T00:00:00.000Z",
      lastHeartbeatAt: "2026-09-18T00:00:00.000Z",
    });
    s1.runnerProjectsReplace("r1", [
      { projectId: "p1", agentKind: "opencode", a2aPort: 4101, status: "online" },
    ]);
    s1.createTask({ taskId: "q1", projectId: "p1", contextId: "c1", state: "working" });
    s1.enqueueTask("q1");
    s1.claimTask({ claimedBy: "m1", claimToken: "tok-1", claimedAt: "2026-09-18T00:00:02.000Z" });
    s1.close();

    /** 直连快照：任务 / 注册表 / 项目投影 / tasks 列清单（迁移幂等的机械核验面） */
    const snapshot = (): Record<string, unknown> => {
      const raw = openStoreDatabase(dbPath);
      try {
        const tasks = raw
          .prepare(
            "SELECT task_id, project_id, state, queue_state, claimed_by, claim_token, claimed_at, queued_at " +
              "FROM tasks ORDER BY task_id",
          )
          .all();
        const runners = raw.prepare("SELECT * FROM runners ORDER BY runner_id").all();
        const projects = raw
          .prepare("SELECT * FROM runner_projects ORDER BY runner_id, project_id")
          .all();
        const taskColumns = raw
          .prepare("PRAGMA table_info(tasks)")
          .all()
          .map((c) => String((c as Record<string, unknown>)["name"]));
        return { tasks, runners, projects, taskColumns };
      } finally {
        raw.close();
      }
    };

    const after1 = snapshot();
    assert.equal((after1["runners"] as unknown[]).length, 1);
    // 第二 / 第三跑：仅打开 = 四段迁移重复执行 ⇒ 库状态逐字节一致（无清空、无重复行）
    new SessionStore(dbPath).close();
    const after2 = snapshot();
    assert.deepEqual(after2, after1, "连续两跑后库状态须一致（迁移幂等）");
    new SessionStore(dbPath).close();
    assert.deepEqual(snapshot(), after1, "第三跑仍一致（前向迁移可反复执行）");
    assert.equal((after2["runners"] as unknown[]).length, 1, "注册表不启动清空（重启后仍在）");
  } finally {
    cleanupDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// v0.8.6 §2.3 · N4：features.owner_group 归属列（打标 + 幂等迁移 + 列表过滤 fail-closed）
// ---------------------------------------------------------------------------

test("createFeature 落 owner_group（打标 + 无身份 = NULL + 重跑不改归属）", () => {
  const store = newStore();
  try {
    const tagged = store.createFeature({
      featureId: "f-owner-g1",
      title: "有归属",
      ownerGroup: "g1",
    });
    assert.equal(tagged.ownerGroup, "g1", "创建时按连接身份打标 owner_group");

    const orphan = store.createFeature({ featureId: "f-owner-null", title: "无归属" });
    assert.equal(orphan.ownerGroup, null, "无 ownerGroup 入参 ⇒ NULL（未配组 / 存量语义）");

    // 重跑（ON CONFLICT）不得覆盖已有归属（Feature 谁建谁见，owner 不可变）
    const reCreate = store.createFeature({
      featureId: "f-owner-g1",
      title: "有归属",
      ownerGroup: "g2",
    });
    assert.equal(reCreate.ownerGroup, "g1", "同 featureId 重跑不改归属（owner_group 不进 ON CONFLICT UPDATE）");
  } finally {
    store.close();
  }
});

test("listFeatures owner_group 过滤：给定组名只见本组（NULL 被排除 = fail-closed）；缺省全量", () => {
  const store = newStore();
  try {
    store.createFeature({ featureId: "a", title: "A", ownerGroup: "g1" });
    store.createFeature({ featureId: "b", title: "B", ownerGroup: "g2" });
    store.createFeature({ featureId: "c", title: "C" }); // NULL 无归属（存量）

    const g1 = store.listFeatures({ ownerGroup: "g1" }).map((f) => f.featureId);
    assert.deepEqual([...g1].sort(), ["a"], "g1 只见自己的 a（b 属另一组、c 无归属都被排除）");

    const g2 = store.listFeatures({ ownerGroup: "g2" }).map((f) => f.featureId);
    assert.deepEqual(g2, ["b"], "g2 只见自己的 b");

    const all = store.listFeatures().map((f) => f.featureId);
    assert.deepEqual(
      [...all].sort(),
      ["a", "b", "c"],
      "缺省（未配组匿名 / web 运维视图）⇒ 全量，含 NULL 无归属行",
    );
  } finally {
    store.close();
  }
});

test("owner_group 列幂等迁移：老库（无该列）以新代码打开后自动补列，重启不报错", () => {
  const dbPath = join(tmpdir(), `orch-owner-mig-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
  try {
    // 造一个「无 owner_group 列」的老 features 表（模拟配组改造前的库）
    const legacy = openStoreDatabase(dbPath);
    legacy.exec(
      `CREATE TABLE features (
         feature_id  TEXT PRIMARY KEY,
         state       TEXT NOT NULL,
         title       TEXT NOT NULL,
         requirement TEXT,
         created_at  TEXT NOT NULL,
         updated_at  TEXT NOT NULL
       )`,
    );
    legacy
      .prepare(
        `INSERT INTO features (feature_id, state, title, requirement, created_at, updated_at)
         VALUES ('legacy-1', 'completed', '存量', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
      )
      .run();
    legacy.close();

    // 以新代码打开 ⇒ ctor try-ALTER 幂等补列，存量行 owner_group = NULL（不回填）
    const store = new SessionStore(dbPath);
    try {
      const got = store.getFeature("legacy-1");
      assert.ok(got !== null, "存量行仍可读回");
      assert.equal(got.ownerGroup, null, "补列不回填 ⇒ 存量 owner_group = NULL");
    } finally {
      store.close();
    }
    // 再开一次：列已存在 ⇒ try-ALTER 命中 catch，不抛（幂等）
    const again = new SessionStore(dbPath);
    assert.equal(again.getFeature("legacy-1")?.ownerGroup, null);
    again.close();
  } finally {
    cleanupDb(dbPath);
  }
});
