/**
 * `orch/bridge/feature-tools.ts` 单元测试（v0.4.1：`a2a_feature_status` 出参增字段）。
 *
 * 覆盖 `handleFeatureStatus` 的任务摘要出参：新增 `failureKind` / `retryCount`，
 * 且**既有字段语义零变化**（只增不删不改）；字段缺失时给 `null` / `0` 而非 `undefined`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { close, createFeature, createTask, getFeature, rearmForRetry } from "../session/store.js";
import {
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCancel,
  handleFeatureCreate,
  handleFeatureStatus,
  type FeatureStatusSuccess,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";

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

// ---------------------------------------------------------------------------
// v0.8.6 §2.3 · N4：Feature 五出口归属校验（谁建谁见 + 两类拒绝文案 + 存量 NULL fail-closed）
// ---------------------------------------------------------------------------

function asFailure(outcome: { ok: boolean }): FeatureToolFailure {
  if (outcome.ok) throw new Error(`期望失败，实际成功：${JSON.stringify(outcome)}`);
  return outcome as FeatureToolFailure;
}

test("① 入口打标：handleFeatureCreate 以连接身份落 owner_group；无身份 ⇒ NULL", () => {
  close();
  const g1 = handleFeatureCreate({ title: "本组建" }, "g1");
  assert.ok(g1.ok, "create 应成功");
  assert.equal(getFeature(g1.featureId)?.ownerGroup, "g1", "owner_group = 连接身份 g1");

  const anon = handleFeatureCreate({ title: "无身份建" }, null);
  assert.ok(anon.ok);
  assert.equal(getFeature(anon.featureId)?.ownerGroup, null, "无身份 ⇒ NULL（未配组 / 存量语义）");
  close();
});

test("② 五出口拒绝：属另一组 = feature_not_owned；无归属 = feature_unowned（两类文案可区分）", () => {
  close();
  // g1 建的正常 Feature；另一组 g2 建的 Feature；无身份建的存量 NULL Feature
  const mine = handleFeatureCreate({ title: "g1 的" }, "g1");
  assert.ok(mine.ok);
  const theirs = handleFeatureCreate({ title: "g2 的" }, "g2");
  assert.ok(theirs.ok);
  const orphan = handleFeatureCreate({ title: "存量" }, null);
  assert.ok(orphan.ok);
  const fid = mine.featureId;

  // --- 属另一组（feature_not_owned）：以 g2 身份操作 g1 的 Feature ⇒ 四路全拒 ---
  for (const [name, fail] of [
    ["status", asFailure(handleFeatureStatus({ featureId: fid }, "g2"))],
    ["advance", asFailure(handleFeatureAdvance({ featureId: fid, to: "executing" }, "g2"))],
    ["approve", asFailure(handleFeatureApprove({ featureId: fid }, "g2"))],
    ["cancel", asFailure(handleFeatureCancel({ featureId: fid }, "g2"))],
  ] as const) {
    assert.equal(fail.code, "feature_not_owned", `${name} 对他组 Feature 应拒 feature_not_owned`);
    assert.ok(fail.error.includes("属另一项目组"), `${name} 文案含「属另一项目组」`);
    assert.ok(fail.error.includes("谁建谁见"), `${name} 文案点明「谁建谁见」`);
    assert.ok(!fail.error.includes("g1"), `${name} 不泄漏他组组名 g1（§6.1-9）`);
  }

  // --- 无归属（feature_unowned）：以 g1 身份操作 NULL 存量 Feature ⇒ 四路全拒，文案不同 ---
  const oid = orphan.featureId;
  for (const [name, fail] of [
    ["status", asFailure(handleFeatureStatus({ featureId: oid }, "g1"))],
    ["advance", asFailure(handleFeatureAdvance({ featureId: oid, to: "executing" }, "g1"))],
    ["approve", asFailure(handleFeatureApprove({ featureId: oid }, "g1"))],
    ["cancel", asFailure(handleFeatureCancel({ featureId: oid }, "g1"))],
  ] as const) {
    assert.equal(fail.code, "feature_unowned", `${name} 对无归属存量应拒 feature_unowned`);
    assert.ok(fail.error.includes("无归属"), `${name} 文案含「无归属」`);
  }

  // 两类拒绝**错误码与文案分别可断言**（不得混同）
  const notOwned = asFailure(handleFeatureStatus({ featureId: fid }, "g2"));
  const unowned = asFailure(handleFeatureStatus({ featureId: oid }, "g1"));
  assert.notEqual(notOwned.code, unowned.code, "两类拒绝错误码必须不同");
  assert.notEqual(notOwned.error, unowned.error, "两类拒绝文案必须不同");

  // --- 正反例：owner 本人（g1）四路放行；无身份（null）全量放行 ---
  assert.ok(handleFeatureStatus({ featureId: fid }, "g1").ok, "g1 查自己的 Feature ⇒ 放行");
  assert.ok(handleFeatureApprove({ featureId: fid }, "g1").ok, "g1 过审自己的 Feature ⇒ 放行");
  assert.ok(handleFeatureStatus({ featureId: fid }, null).ok, "无身份（未配组/运维）⇒ 全量放行");
  assert.ok(handleFeatureStatus({ featureId: oid }, null).ok, "无身份 ⇒ 存量 NULL 也放行");
  close();
});

test("③ 存量 NULL 可见性：配组身份列表不可见（fail-closed）、未配组全量可见；列表过滤不泄漏他组", () => {
  close();
  createFeature({ featureId: "own", title: "o", ownerGroup: "g1" });
  createFeature({ featureId: "other", title: "p", ownerGroup: "g2" });
  createFeature({ featureId: "legacy", title: "q" }); // owner_group NULL（存量）

  // g1 列表：只见 own（other 属另一组、legacy NULL 被 fail-closed 排除）
  const asG1 = mustSucceed(handleFeatureStatus({}, "g1"));
  assert.deepEqual(
    (asG1.features ?? []).map((f) => f.featureId),
    ["own"],
    "配组身份 g1 列表只含本组，NULL 存量不可见",
  );

  // 无身份（未配组 / web 运维）：全量含 NULL
  const asAll = mustSucceed(handleFeatureStatus({}, null));
  assert.deepEqual(
    (asAll.features ?? []).map((f) => f.featureId).sort(),
    ["legacy", "other", "own"],
    "未配组 / 运维视图 ⇒ 全量可见（含 owner_group NULL 存量）",
  );
  close();
});
