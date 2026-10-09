/**
 * v0.10.0 O5（REQ-v0.10.0-2026-09-24-01 · 改造文档 §2.1(4)）——
 * **`features.version` 写口校验（semver 形状 + 台账存在性）+ `idx_features_version` 索引 + 存量不改写**。
 *
 * 锁定的行为面：
 * 1. **shape 校验（写口）**：`undefined` / 空串 ⇒ 放行（撤排期回未登记桶）；
 *    非空但非 semver ⇒ `feature_invalid_version_shape`（**零写入**，create 与 advance 同款）；
 *    合法 ⇒ trim 后落库（避免 `" v0.10.0 "` 与 `"v0.10.0"` 在台账 PK 上分裂）；
 * 2. **存在性校验（∈ O1 台账）**：shape 过关后按 `(owner_group, version)` 查 `versions` 表；
 *    不在 ⇒ `orch_version_unknown`（**零写入**）；
 * 3. **过渡放行（legacy 兼容兜底）**：`versions` 表**不存在**时，shape 已挡门、存在性检查放行
 *    （`ledgerReady = false`）；O1 已落默认 schema ⇒ 常规工作树恒就绪，用例显式摘表模拟老库；
 * 4. **不做脏值归一**：老库存量自由文本 `version`（如 `"foo"`）经 ctor 补索引后仍原样读出，
 *    **不被改写**、`updated_at` 不前进、不发 `feature.stage` 事件；
 * 5. **索引建成**：`idx_features_version` 在 `sqlite_master` 里可见，且**重复启动幂等**
 *    （`CREATE INDEX IF NOT EXISTS`）。
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
  openStoreDatabase,
  updateFeatureRegistration,
  versionLedgerCreate,
  versionLedgerHas,
} from "../session/store.js";
import {
  handleFeatureAdvance,
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
  return join(
    tmpdir(),
    `a2a-v0100-o5-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

function rmDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
}

/**
 * 建 O1 版本台账并灌入给定版号（**O1 已落默认 schema ⇒ 此处 `CREATE TABLE IF NOT EXISTS` 为 no-op**，
 * 仅补数据行）。表结构与改造文档 §2.1(1) 一致（PK `(owner_group, version)`）。
 */
function seedVersionLedger(dbPath: string, rows: Array<[string | null, string]>): void {
  const db = openStoreDatabase(dbPath);
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS versions (
         owner_group TEXT,
         version     TEXT,
         status      TEXT NOT NULL DEFAULT 'notstart',
         date        TEXT,
         note        TEXT,
         created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (owner_group, version)
       )`,
    );
    const ins = db.prepare(
      "INSERT OR REPLACE INTO versions (owner_group, version, status) VALUES (?, ?, 'notstart')",
    );
    for (const [og, v] of rows) ins.run(og, v);
  } finally {
    db.close();
  }
}

/** 让默认存储重开到指定文件（close ⇒ 下次访问按 `SESSION_DB` 重建） */
function reopenDefault(dbPath: string): void {
  process.env["SESSION_DB"] = dbPath;
  close();
}

/**
 * v0.10.0 O1 落表后 `features.version` 写口**存在性已执法**（未命中 ⇒ `orch_version_unknown`）——
 * 形状校验用例须先把版号登记进引擎台账，红点才收敛到「形状」本身。
 * `ownerGroup = null` 与「无连接身份（缺省）」同档。
 */
function seedLedger(version: string): void {
  const outcome = versionLedgerCreate({ ownerGroup: null, version });
  if (!outcome.ok) throw new Error(`台账建版失败 ${version}：${outcome.code} ${outcome.message}`);
}

// ---------------------------------------------------------------------------
// 1：shape 校验（create + advance）
// ---------------------------------------------------------------------------

test("O5 create：合法 semver（含/不含 v 前缀、prerelease、build）⇒ 放行、trim 落库", () => {
  close();
  const cases: Array<[string, string]> = [
    ["0.10.0", "0.10.0"],
    ["v0.10.0", "v0.10.0"],
    [" 1.2.3 ", "1.2.3"], // trim 归一
    ["v2.0.0-rc.1", "v2.0.0-rc.1"],
    ["2.0.0+build.7", "2.0.0+build.7"],
  ];
  // O1 已落默认 schema ⇒ 写口存在性执法生效：先登记版号，使本用例只锚「形状」判据
  for (const [, expected] of cases) seedLedger(expected);
  for (const [input, expected] of cases) {
    const created = mustOk(handleFeatureCreate({ title: `t-${expected}`, version: input }));
    assert.equal(created.version, expected, `入参 ${JSON.stringify(input)} ⇒ 落库 ${expected}`);
    assert.equal(getFeature(created.featureId)?.version, expected, "读面同源");
  }
  close();
});

test("O5 create：undefined / 空串 ⇒ 放行（撤排期回未登记桶）；非空脏值 ⇒ 结构化拒绝、零写入", () => {
  close();
  const undef = mustOk(handleFeatureCreate({ title: "未传 version" }));
  assert.equal(undef.version, "", "未传 ⇒ NULL 落库、读侧归一空串（既有 v0.9.0 口径不变）");
  const blank = mustOk(handleFeatureCreate({ title: "空串撤排期", version: "" }));
  assert.equal(blank.version, "", "空串 ⇒ 放行（撤排期语义）");
  for (const bad of ["foo", "1.2", "v1", "0.10", "0.10.0.1", "1.2.3.4", "vX.Y.Z", "-1.0.0", "01.2.3"]) {
    const fail = mustFail(handleFeatureCreate({ title: `脏-${bad}`, version: bad }));
    assert.equal(fail.code, "feature_invalid_version_shape", `脏值 ${JSON.stringify(bad)} 应命中 shape 码`);
  }
  close();
});

test("O5 create：`0.10.0.1` / `1.2` / `foo` 等 shape 非法 ⇒ 零写入（列表不含脏名卡）", () => {
  close();
  mustFail(handleFeatureCreate({ title: "脏-4段", version: "0.10.0.1" }));
  mustFail(handleFeatureCreate({ title: "脏-2段", version: "1.2" }));
  mustFail(handleFeatureCreate({ title: "脏-非数字", version: "foo" }));
  seedLedger("0.10.0"); // 合法卡前置：存在性已执法，先登记版号
  const ok = mustOk(handleFeatureCreate({ title: "唯一合法卡", version: "0.10.0" }));
  assert.equal(getFeature(ok.featureId)?.version, "0.10.0");
  close();
});

test("O5 advance：登记特例同样把 shape 挡门（非法 ⇒ 结构化拒绝、主链态与登记值零变更）", () => {
  close();
  seedLedger("0.10.0"); // 存在性已执法 ⇒ 合法版号先登记
  const f = mustOk(handleFeatureCreate({ title: "advance-shape", version: "0.10.0" }));
  const before = getFeature(f.featureId);
  assert.ok(before !== null);
  const fail = mustFail(
    handleFeatureAdvance({ featureId: f.featureId, to: before.state, version: "not-semver" }),
  );
  assert.equal(fail.code, "feature_invalid_version_shape");
  const after = getFeature(f.featureId);
  assert.equal(after?.version, before.version, "shape 拒绝 ⇒ 登记值不变");
  assert.equal(after?.state, before.state, "主链态不变");
  close();
});

// ---------------------------------------------------------------------------
// 2：存在性校验（∈ O1 版本台账）
// ---------------------------------------------------------------------------

test("O5 存在性：台账已建 + 版号命中 ⇒ 放行；未命中 ⇒ `orch_version_unknown`（零写入）", () => {
  const dbPath = tmpDbPath("ledger-hit");
  try {
    // 先用默认流程让 SessionStore ctor 建库（跑既有 DDL / 索引），再关闭
    reopenDefault(dbPath);
    mustOk(handleFeatureCreate({ title: "bootstrap" })); // 触发 singleton 建库
    close();
    // 灌入 O1 台账：只登记 `("g1","0.10.0")` 一行
    seedVersionLedger(dbPath, [["g1", "0.10.0"]]);

    reopenDefault(dbPath);
    // 未传 version ⇒ 落 NULL（读侧归一空串），不进台账检查
    const undef = mustOk(handleFeatureCreate({ title: "无 version" }, "g1"));
    assert.equal(undef.version, "");

    const hit = mustOk(handleFeatureCreate({ title: "命中", version: "0.10.0" }, "g1"));
    assert.equal(hit.version, "0.10.0", "shape 合法 ∧ 台账命中 ⇒ 放行");

    const miss = mustFail(handleFeatureCreate({ title: "未命中", version: "9.9.9" }, "g1"));
    assert.equal(miss.code, "orch_version_unknown", "shape 合法 ∧ 台账未命中 ⇒ 拒");

    // advance 路径同检：把一个已在台账的行改到未登记的版号
    const adv = mustFail(
      handleFeatureAdvance({ featureId: hit.featureId, to: "waiting_approval", version: "9.9.9" }),
    );
    assert.equal(adv.code, "orch_version_unknown", "advance 写 version 同受台账存在性执法");
    // 未命中路径 ⇒ 未落库、原 version 保留
    assert.equal(getFeature(hit.featureId)?.version, "0.10.0", "拒绝 ⇒ 原 version 零变更");
    close();
  } finally {
    rmDb(dbPath);
    process.env["SESSION_DB"] = ":memory:";
    close();
  }
});

test("O5 存在性：owner_group 语义（NULL 归属 ⇒ 匹配 IS NULL；跨组不串台账）", () => {
  const dbPath = tmpDbPath("ledger-owner");
  try {
    reopenDefault(dbPath);
    mustOk(handleFeatureCreate({ title: "bootstrap" }));
    close();
    seedVersionLedger(dbPath, [
      [null, "0.1.0"],
      ["g1", "0.2.0"],
    ]);

    reopenDefault(dbPath);
    // NULL 归属 ⇒ 只能命中 owner_group IS NULL 的台账行
    const nullHit = mustOk(handleFeatureCreate({ title: "null-og 命中", version: "0.1.0" }, null));
    assert.equal(nullHit.version, "0.1.0");
    mustFail(handleFeatureCreate({ title: "null-og 不串 g1", version: "0.2.0" }, null));
    // 非空归属 ⇒ 只能命中同 owner_group 的台账行
    const g1Hit = mustOk(handleFeatureCreate({ title: "g1 命中", version: "0.2.0" }, "g1"));
    assert.equal(g1Hit.version, "0.2.0");
    mustFail(handleFeatureCreate({ title: "g1 借 null 台账", version: "0.1.0" }, "g1"));
    close();
  } finally {
    rmDb(dbPath);
    process.env["SESSION_DB"] = ":memory:";
    close();
  }
});

test("O5 过渡放行（legacy 库表缺失）：台账表不存在 ⇒ shape 过关即放行（`ledgerReady = false`）", () => {
  // v0.10.0 O1 已把 `versions` 表建入默认 schema ⇒ 常规工作树里台账**恒就绪**（存在性执法生效）。
  // 本用例显式模拟「O1 落表前的老库」：打开默认存储（ctor 建表）后，用独立句柄摘掉该表，
  // 使存在性检查走「无表 ⇒ 过渡放行」分支（shape 校验仍生效），验证兼容兜底未被误删。
  const dbPath = tmpDbPath("legacy-no-ledger");
  try {
    reopenDefault(dbPath);
    assert.equal(
      versionLedgerHas(null, "0.0.0").ledgerReady,
      true,
      "O1 已落默认 schema ⇒ 新库恒就绪（旧「未落表」口径作废）",
    );
    const raw = openStoreDatabase(dbPath);
    try {
      raw.exec("DROP TABLE versions");
    } finally {
      raw.close();
    }
    assert.equal(
      versionLedgerHas(null, "0.0.0").ledgerReady,
      false,
      "表缺失 ⇒ ledgerReady = false（不误报未命中）",
    );
    const hit = mustOk(handleFeatureCreate({ title: "过渡放行", version: "0.10.0" }));
    assert.equal(hit.version, "0.10.0", "无台账 ⇒ 跳过存在性检查、放行");
    // shape 挡门仍在（与台账状态无关）
    mustFail(handleFeatureCreate({ title: "shape 仍挡", version: "no-shape" }));
  } finally {
    close();
    process.env["SESSION_DB"] = ":memory:";
    rmDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 4：不做脏值归一 —— 存量自由文本行不被改写
// ---------------------------------------------------------------------------

test("O5 存量不改写：库里已有的自由文本 `version`（脏值）经 ctor 补索引后仍原样读出", () => {
  const dbPath = tmpDbPath("legacy-dirty");
  const T0 = "2020-01-01T00:00:00.000Z";
  try {
    // 建一个「已升过 v0.9.0（有 version 列）但未升 v0.10.0 O5（无 idx_features_version）」的老库，
    // 手工塞一行自由文本 `version`（模拟脏值存量）。
    const legacy = openStoreDatabase(dbPath);
    try {
      legacy.exec(
        `CREATE TABLE features (
           feature_id  TEXT PRIMARY KEY,
           state       TEXT NOT NULL,
           title       TEXT NOT NULL,
           requirement TEXT,
           owner_group TEXT,
           created_at  TEXT NOT NULL,
           updated_at  TEXT NOT NULL,
           context_id  TEXT,
           plan        TEXT,
           decisions   TEXT,
           contracts   TEXT,
           stage       TEXT,
           version     TEXT,
           approval    TEXT,
           parent_feature_id TEXT
         )`,
      );
      legacy
        .prepare(
          `INSERT INTO features (feature_id, state, title, created_at, updated_at, version)
           VALUES ('legacy-1', 'completed', '存量脏版号', ?, ?, ?)`,
        )
        .run(T0, T0, "自由文本-未升");
    } finally {
      legacy.close();
    }

    // O5 上线：SessionStore ctor 跑一遍迁移（应加 idx_features_version、**不改写存量 version 值**）
    const store = new SessionStore(dbPath);
    try {
      const got = store.getFeature("legacy-1");
      assert.ok(got !== null);
      assert.equal(got.version, "自由文本-未升", "读侧透传：脏值不被改写、不归一、不 throw");
      assert.equal(got.updatedAt, T0, "补索引不是活动 ⇒ updated_at 不前进");
    } finally {
      store.close();
    }
    // 二次启动：索引 IF NOT EXISTS 命中 catch 幂等；存量行仍原样
    const again = new SessionStore(dbPath);
    assert.equal(again.getFeature("legacy-1")?.version, "自由文本-未升");
    again.close();
  } finally {
    rmDb(dbPath);
  }
});

test("O5 写口只挡新写：脏值存量卡经 updateFeatureRegistration 不带 version ⇒ 脏值原样保留", () => {
  close();
  createFeature({ featureId: "dirty-existing", title: "存量脏", version: "自由文本" });
  const before = getFeature("dirty-existing");
  assert.ok(before !== null);
  assert.equal(before.version, "自由文本", "写侧原语落脏值（模拟 v0.10.0 前存量）");
  // 经 store 侧原语写其它字段、不带 version ⇒ 脏值不动（handler 侧的 shape 校验不追溯存量）
  updateFeatureRegistration("dirty-existing", { stage: "改造方案" });
  assert.equal(getFeature("dirty-existing")?.version, "自由文本", "不带 version ⇒ 保留原值");
  close();
});

// ---------------------------------------------------------------------------
// 5：索引建成 + 幂等
// ---------------------------------------------------------------------------

test("O5 索引：`idx_features_version` 在 sqlite_master 可见、二次启动不报错（IF NOT EXISTS 幂等）", () => {
  const dbPath = tmpDbPath("index");
  try {
    const store1 = new SessionStore(dbPath);
    store1.close();
    // 直接开一条只读连接看元数据
    const probe = openStoreDatabase(dbPath);
    try {
      const idx = probe
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_features_version'")
        .get() as { name: string } | undefined;
      assert.ok(idx !== undefined, "idx_features_version 应建成");
    } finally {
      probe.close();
    }
    // 二次启动不 throw（幂等）
    const store2 = new SessionStore(dbPath);
    store2.close();
  } finally {
    rmDb(dbPath);
  }
});
