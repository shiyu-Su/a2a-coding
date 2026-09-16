/**
 * `orch/session/store.ts` 单元测试（v0.4.0 数据层，`node:test`，无新依赖）。
 *
 * 覆盖：`blocked` 本地态往返、Feature Context 列、Artifact 注册表、事件收件箱
 * （含 `updateTaskState`/`updateFeatureState` 集中写事件）、`inputArtifacts` 往返，
 * 以及 `pruneTasks` 对活跃 Feature 的 `blocked` 任务的保护。
 * v0.4.1：追加存储加固三项——busy timeout、默认库路径锚定 orch 单元根、CAS 条件更新。
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
    const manual = store.appendEvent({ featureId: "f1", kind: "push.received", state: "working" });
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
      assert.equal(legacyRow?.exhausted, false);
      assert.equal(legacyRow?.notBefore, null);
      assert.equal(legacyRow?.lastPollAt, null);
    } finally {
      store.close();
    }

    // ③ 新列可写回并读回（后续节点由 scheduler 写 exhausted / failure_kind；此处直连库模拟）
    const raw = openStoreDatabase(dbPath);
    raw.exec("UPDATE tasks SET exhausted = 1, failure_kind = 'infra' WHERE task_id = 'legacy-1'");
    raw.close();
    const store2 = new SessionStore(dbPath);
    try {
      const row = store2.getTask("legacy-1");
      assert.equal(row?.exhausted, true);
      assert.equal(row?.failureKind, "infra");
      assert.equal(row?.state, "completed", "中性化标记不得改写 state（非新 TaskState）");
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

test("rearmForRetry：仅 failed 命中；命中后 retry_count +1、清 remote_task_id 并清 exhausted；非 failed 零变化", () => {
  const store = newStore();
  try {
    // 非 failed（working）→ 不命中，且字段零变化（含**不得清 `exhausted`**）
    store.createTask({
      taskId: "t-working",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      remoteTaskId: "remote-1",
      dispatchMessage: "orig",
    });
    assert.equal(store.markTaskExhausted("t-working"), true);
    assert.equal(store.rearmForRetry("t-working", "retry note"), false);
    const working = store.getTask("t-working");
    assert.equal(working?.state, "working");
    assert.equal(working?.retryCount, 0, "未命中不得自增 retry_count");
    assert.equal(working?.remoteTaskId, "remote-1", "未命中不得清 remote_task_id");
    assert.equal(working?.dispatchMessage, "orig");
    assert.equal(working?.exhausted, true, "未命中不得清 exhausted（中性化不被旁路绕过）");

    // failed → 命中：state / remote_task_id / dispatch_message / retry_count / exhausted 一次写全
    store.createTask({
      taskId: "t-failed",
      projectId: "p1",
      contextId: "c1",
      state: "failed",
      remoteTaskId: "remote-2",
      dispatchMessage: "orig",
    });
    assert.equal(store.markTaskExhausted("t-failed"), true);
    assert.equal(store.getTask("t-failed")?.exhausted, true);

    assert.equal(store.rearmForRetry("t-failed", "orig\n\n【自动重试】"), true);
    const retried = store.getTask("t-failed");
    assert.equal(retried?.state, "working");
    assert.equal(retried?.remoteTaskId, null);
    assert.equal(retried?.dispatchMessage, "orig\n\n【自动重试】");
    assert.equal(retried?.retryCount, 1);
    assert.equal(retried?.contextId, "c1", "重试同 contextId 续接（不得换 ctx）");
    assert.equal(
      retried?.exhausted,
      false,
      "re-arm ⇒ 退出中性化（否则计算就绪时被永久挡住 / all_completed 提前成立）",
    );

    // 第二次：已非 failed → 不命中、不再自增、exhausted 保持已清（N=1 防死循环门槛）
    assert.equal(store.rearmForRetry("t-failed", "again"), false);
    assert.equal(store.getTask("t-failed")?.retryCount, 1);
    assert.equal(store.getTask("t-failed")?.exhausted, false);

    // 任务不存在 → 不命中
    assert.equal(store.rearmForRetry("missing", "x"), false);
  } finally {
    store.close();
  }
});

test("取证派发门原语：setTaskNotBefore / setTaskLastPollAt 往返与清空，且不动 updated_at", () => {
  const store = newStore();
  try {
    store.createTask({
      taskId: "t-gate",
      projectId: "p1",
      contextId: "c1",
      state: "working",
    });
    const before = store.getTask("t-gate")?.updatedAt;
    const gateAt = "2026-09-15T10:00:00.000Z";

    assert.equal(store.setTaskNotBefore("t-gate", gateAt)?.notBefore, gateAt);
    assert.equal(store.setTaskLastPollAt("t-gate", gateAt)?.lastPollAt, gateAt);
    // 清门 → 立即可派
    assert.equal(store.setTaskNotBefore("t-gate", null)?.notBefore, null);
    // 门列是派发门 / 观测元数据，不是任务态变化 ⇒ 不搅动 updated_at（保 listFeatureTasks 的派发次序）
    assert.equal(store.getTask("t-gate")?.updatedAt, before);

    // 任务不存在 → null（与 updateTaskState 语义一致）
    assert.equal(store.setTaskNotBefore("missing", gateAt), null);
    assert.equal(store.setTaskLastPollAt("missing", gateAt), null);
  } finally {
    store.close();
  }
});

test("markTaskExhausted：置位后 state 仍 failed、updated_at/retry_count 不变、幂等、不存在不命中", () => {
  const store = newStore();
  try {
    store.createTask({
      taskId: "t-ex",
      projectId: "p1",
      contextId: "c1",
      state: "failed",
      remoteTaskId: "remote-9",
      dispatchMessage: "orig",
    });
    const before = store.getTask("t-ex");
    assert.equal(before?.exhausted, false, "初始未中性化");

    assert.equal(store.markTaskExhausted("t-ex"), true);
    const after = store.getTask("t-ex");
    assert.equal(after?.exhausted, true);
    assert.equal(after?.state, "failed", "中性化不得改写 state（非新 TaskState，事实仍是 failed）");
    assert.equal(after?.updatedAt, before?.updatedAt, "不得搅动 updated_at（派发次序）");
    assert.equal(after?.retryCount, 0, "中性化不占 N=1 重试额度");
    assert.equal(after?.remoteTaskId, "remote-9");
    assert.equal(after?.failureKind, null, "不越权写 failure_kind（分类归 scheduler）");

    // 幂等：重复置位仍为 1
    assert.equal(store.markTaskExhausted("t-ex"), true);
    assert.equal(store.getTask("t-ex")?.exhausted, true);
    assert.equal(store.getTask("t-ex")?.state, "failed");

    // 不存在的 taskId → 不命中
    assert.equal(store.markTaskExhausted("missing"), false);
  } finally {
    store.close();
  }
});

test("markTaskFailureKind：落库 failure_kind、updated_at 不变、不存在不命中", () => {
  const store = newStore();
  try {
    store.createTask({
      taskId: "t-kind",
      projectId: "p1",
      contextId: "c1",
      state: "failed",
      remoteTaskId: "remote-k",
    });
    const before = store.getTask("t-kind");
    assert.equal(before?.failureKind, null, "初始未分类");

    assert.equal(store.markTaskFailureKind("t-kind", "infra"), true);
    const after = store.getTask("t-kind");
    assert.equal(after?.failureKind, "infra");
    assert.equal(after?.updatedAt, before?.updatedAt, "不写 updated_at（不搅动派发次序）");
    assert.equal(after?.state, "failed", "不改写 state");
    assert.equal(after?.retryCount, 0, "不越权改 retry_count");
    assert.equal(after?.exhausted, false, "不越权改 exhausted（中性化归 markTaskExhausted）");

    // 后写覆盖：task 类同样可落库（两类都写）
    assert.equal(store.markTaskFailureKind("t-kind", "task"), true);
    assert.equal(store.getTask("t-kind")?.failureKind, "task");

    // 不存在的 taskId → 不命中
    assert.equal(store.markTaskFailureKind("missing", "infra"), false);
  } finally {
    store.close();
  }
});
