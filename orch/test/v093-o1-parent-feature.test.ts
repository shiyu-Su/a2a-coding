/**
 * v0.9.3 O1（parentFeatureId 引擎字段 · 改造文档 v3 §2-O 冻结边界）——
 * **features.parent_feature_id：加列 + create 一次性登记 + fail-closed 校验 + 读面透出**。
 *
 * 锁定的行为面：
 * 1. create 带 / 不带 parentFeatureId 的回显（不带 ⇒ 出参无该键、落库读回 NULL = 合法无父）；
 * 2. 父不存在 ⇒ `feature_not_found`（零写入）；
 * 3. 父为他组 Feature ⇒ **同一拒绝码** `feature_not_found`（带身份过滤读口，不泄漏存在性）；
 * 4. **只存不解析**：环登记允许（A←B←C←A 均成功），引擎不递归、不判环；
 * 5. 老库升级：ctor try-ALTER 补列，存量行 NULL ⇒ 读回 null 不 throw（不套脏值归一循环）；
 * 6. 一次性写入语义：同 id 重跑 createFeature（ON CONFLICT）**不改父**（同 owner_group 语义）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionStore,
  close,
  createFeature,
  getFeature,
  listFeatures,
  openStoreDatabase,
} from "../session/store.js";
import {
  handleFeatureCreate,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";

process.env["SESSION_DB"] = ":memory:";

function mustOk<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) {
    const f = outcome as unknown as FeatureToolFailure;
    throw new Error(`期望成功，实际失败：${f.code} ${f.error}`);
  }
  return outcome as Extract<T, { ok: true }>;
}

function mustFail(outcome: { ok: boolean } | FeatureToolFailure): FeatureToolFailure {
  if (outcome.ok) throw new Error("期望失败，实际成功");
  return outcome as FeatureToolFailure;
}

function tmpDbPath(tag: string): string {
  return join(tmpdir(), `a2a-v093-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function rmDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
}

// ---------------------------------------------------------------------------
// 1：回显（带 / 不带）
// ---------------------------------------------------------------------------

test("v0.9.3 O1：create 不带 parentFeatureId ⇒ 出参无该键、落库读回 null（合法无父）", () => {
  close();
  const created = mustOk(handleFeatureCreate({ title: "无父" }));
  assert.equal(
    Object.prototype.hasOwnProperty.call(created, "parentFeatureId"),
    false,
    "未带父 ⇒ 回显不出现该键（同 contextId 回显口径）",
  );
  assert.equal(getFeature(created.featureId)?.parentFeatureId, null, "NULL = 合法无父");
  close();
});

test("v0.9.3 O1：create 带 parentFeatureId ⇒ 回显并落库，读面（单查/列表）自动带出", () => {
  close();
  const parent = mustOk(handleFeatureCreate({ title: "主需求" }));
  const child = mustOk(
    handleFeatureCreate({ title: "增补轨", parentFeatureId: parent.featureId }),
  );
  assert.equal(child.parentFeatureId, parent.featureId, "create 出参回显（唯一手写出参点）");
  assert.equal(getFeature(child.featureId)?.parentFeatureId, parent.featureId, "单查读面带出");
  const listed = listFeatures().find((f) => f.featureId === child.featureId);
  assert.equal(listed?.parentFeatureId, parent.featureId, "列表读面带出（rowToFeature 同源）");
  assert.equal(
    getFeature(parent.featureId)?.parentFeatureId,
    null,
    "父自身不受影响",
  );
  close();
});

// ---------------------------------------------------------------------------
// 2 / 3：fail-closed 校验（不存在 与 他组不可见 ⇒ 同一拒绝码）
// ---------------------------------------------------------------------------

test("v0.9.3 O1：父不存在 ⇒ feature_not_found，零写入", () => {
  close();
  const before = listFeatures().length;
  const denied = mustFail(
    handleFeatureCreate({ title: "孤儿", parentFeatureId: "no-such-feature" }),
  );
  assert.equal(denied.code, "feature_not_found");
  assert.equal(listFeatures().length, before, "校验在写入前 ⇒ 拒绝路径零写入");
  close();
});

test("v0.9.3 O1：父为他组 Feature ⇒ 同一拒绝码 feature_not_found（不泄漏存在性）", () => {
  close();
  const foreign = mustOk(handleFeatureCreate({ title: "他组主需求" }, "g1"));
  const denied = mustFail(
    handleFeatureCreate({ title: "越组挂父", parentFeatureId: foreign.featureId }, "g2"),
  );
  assert.equal(denied.code, "feature_not_found", "不可见与不存在同码（fail-closed，不新增第二拒绝码）");
  assert.ok(
    !denied.error.includes("g1"),
    "错误文案不得泄漏他组组名",
  );
  close();
});

test("v0.9.3 O1：同组父可挂；identity=null（未配组/运维全量）放行 —— ownershipFailure 同源口径", () => {
  close();
  const owned = mustOk(handleFeatureCreate({ title: "本组主需求" }, "g1"));
  mustOk(handleFeatureCreate({ title: "本组增补", parentFeatureId: owned.featureId }, "g1"));
  // identity=null ⇒ ownershipFailure 放行（与 advance/approve 等六出口同口径）
  const anonymous = mustOk(
    handleFeatureCreate({ title: "匿名挂组父", parentFeatureId: owned.featureId }),
  );
  assert.equal(anonymous.parentFeatureId, owned.featureId);
  // g2 挂 g1 的父 ⇒ 拒（对照）
  const denied = mustFail(
    handleFeatureCreate({ title: "越组挂父", parentFeatureId: owned.featureId }, "g2"),
  );
  assert.equal(denied.code, "feature_not_found");
  close();
});

// ---------------------------------------------------------------------------
// 4：只存不解析（环允许）
// ---------------------------------------------------------------------------

test("v0.9.3 O1：环登记允许（A←B←C 均成功）—— 只透单值，父链不递归不判环", () => {
  close();
  const a = mustOk(handleFeatureCreate({ title: "A" }));
  const b = mustOk(handleFeatureCreate({ title: "B", parentFeatureId: a.featureId }));
  const c = mustOk(handleFeatureCreate({ title: "C", parentFeatureId: b.featureId }));
  assert.equal(getFeature(c.featureId)?.parentFeatureId, b.featureId, "只存直接父单值");
  // 反向再挂一层形成环 ⇒ 仍成功（引擎不解析）
  const d = mustOk(handleFeatureCreate({ title: "D(回指 A)", parentFeatureId: c.featureId }));
  assert.equal(getFeature(d.featureId)?.parentFeatureId, c.featureId);
  close();
});

// ---------------------------------------------------------------------------
// 5：老库升级（try-ALTER 补列，NULL 合法、不告警不 throw）
// ---------------------------------------------------------------------------

test("v0.9.3 O1 迁移：老库无 parent_feature_id 列 ⇒ ctor 补列，存量行读回 null 不 throw", () => {
  const dbPath = tmpDbPath("parent-mig");
  const T0 = "2020-01-01T00:00:00.000Z";
  try {
    const legacy = openStoreDatabase(dbPath);
    legacy.exec(
      `CREATE TABLE features (
         feature_id  TEXT PRIMARY KEY,
         state       TEXT NOT NULL,
         title       TEXT NOT NULL,
         requirement TEXT,
         owner_group TEXT,
         created_at  TEXT NOT NULL,
         updated_at  TEXT NOT NULL
       )`,
    );
    legacy
      .prepare(
        `INSERT INTO features (feature_id, state, title, created_at, updated_at)
         VALUES ('legacy-1', 'completed', '存量', ?, ?)`,
      )
      .run(T0, T0);
    legacy.close();

    const store = new SessionStore(dbPath);
    try {
      const got = store.getFeature("legacy-1");
      assert.ok(got !== null);
      assert.equal(got.parentFeatureId, null, "NULL = 合法无父，读侧不 throw、不归一");
      assert.equal(got.updatedAt, T0, "补列不改 updated_at");
    } finally {
      store.close();
    }
    // 二次启动：列已存在 ⇒ try-ALTER 命中 catch（幂等）
    const again = new SessionStore(dbPath);
    assert.equal(again.getFeature("legacy-1")?.parentFeatureId, null);
    again.close();
  } finally {
    rmDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 6：一次性写入语义（ON CONFLICT 不改父）
// ---------------------------------------------------------------------------

test("v0.9.3 O1：同 id 重跑 createFeature ⇒ parent_feature_id 不进 DO UPDATE SET（父不可变）", () => {
  close();
  const p1 = mustOk(handleFeatureCreate({ title: "父一" }));
  mustOk(handleFeatureCreate({ title: "父二" }));
  createFeature({
    featureId: "child-once",
    title: "子",
    parentFeatureId: p1.featureId,
  });
  // 重跑（覆盖语义族）：不带父 ⇒ 不得把已有父抹掉/改掉
  createFeature({ featureId: "child-once", title: "子（重跑）" });
  assert.equal(
    getFeature("child-once")?.parentFeatureId,
    p1.featureId,
    "一次性写入：重跑不改父（同 owner_group 语义）",
  );
  close();
});
