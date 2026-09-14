/**
 * `orch/session/store.ts` 单元测试（v0.4.0 数据层，`node:test`，无新依赖）。
 *
 * 覆盖：`blocked` 本地态往返、Feature Context 列、Artifact 注册表、事件收件箱
 * （含 `updateTaskState`/`updateFeatureState` 集中写事件）、`inputArtifacts` 往返，
 * 以及 `pruneTasks` 对活跃 Feature 的 `blocked` 任务的保护。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_FEATURE_STATE,
  EVENT_TASK_BLOCKED,
  EVENT_TASK_SETTLED,
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
    store.updateFeatureState("f1", "analyzing");

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
    assert.equal(events[2]?.state, "analyzing");

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
