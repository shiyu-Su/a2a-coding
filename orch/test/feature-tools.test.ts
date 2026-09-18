/**
 * `orch/bridge/feature-tools.ts` 单元测试（v0.4.1：`a2a_feature_status` 出参增字段）。
 *
 * 覆盖 `handleFeatureStatus` 的任务摘要出参：新增 `failureKind` / `retryCount`，
 * 且**既有字段语义零变化**（只增不删不改）；字段缺失时给 `null` / `0` 而非 `undefined`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { close, createFeature, createTask, rearmForRetry } from "../session/store.js";
import { handleFeatureStatus, type FeatureStatusSuccess } from "../bridge/feature-tools.js";

// 默认存储固定内存库（与 scheduler.test.ts 同口径）
process.env["SESSION_DB"] = ":memory:";

function mustSucceed(outcome: ReturnType<typeof handleFeatureStatus>): FeatureStatusSuccess {
  if (!outcome.ok) throw new Error(`期望成功，实际失败：${outcome.code} ${outcome.error}`);
  return outcome;
}

test("a2a_feature_status 出参：任务摘要含 failureKind / retryCount（只增，既有字段语义不变）", () => {
  close();
  createFeature({ featureId: "f-status", title: "出参", state: "executing" });
  createTask({
    taskId: "T1",
    projectId: "p1",
    contextId: "c1",
    state: "failed",
    featureId: "f-status",
    prompt: "p-orig",
    dispatchMessage: "orig",
  });

  const first = mustSucceed(handleFeatureStatus({ featureId: "f-status" }));
  const t1 = first.tasks?.find((t) => t.taskId === "T1");
  assert.ok(t1 !== undefined, "应返回任务摘要");

  // 只增字段：**存在**且为确定值（不是 undefined）
  assert.ok("failureKind" in t1, "必须存在 failureKind 字段（不得省略）");
  assert.ok("retryCount" in t1, "必须存在 retryCount 字段（不得省略）");
  assert.equal(t1.failureKind, null, "未分类 ⇒ null（不是 undefined）");
  assert.equal(t1.retryCount, 0, "未重试 ⇒ 0");

  // 既有字段语义未变
  assert.equal(t1.taskId, "T1");
  assert.equal(t1.projectId, "p1");
  assert.equal(t1.state, "failed");
  assert.equal(t1.prompt, "p-orig");
  assert.equal(t1.dependencies, null);
  assert.equal(t1.inputArtifacts, null);
  assert.equal(t1.remoteTaskId, null);
  assert.equal(typeof t1.updatedAt, "string");

  // retryCount 如实跟随 TaskRecord（`rearmForRetry` 是唯一自增点：同 ctx 续一次的痕迹）
  assert.equal(rearmForRetry("T1", "orig\n\n【自动重试】"), true);
  const second = mustSucceed(handleFeatureStatus({ featureId: "f-status" }));
  const after = second.tasks?.find((t) => t.taskId === "T1");
  assert.equal(after?.retryCount, 1, "重试后 N=1 门槛对宿主可见（无需另查库）");
  assert.equal(after?.state, "working", "re-arm 后回到待派发");

  close();
});
