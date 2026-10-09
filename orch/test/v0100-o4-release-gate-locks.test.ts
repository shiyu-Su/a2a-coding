/**
 * v0.10.0 O4（REQ-v0.10.0-2026-09-24-01 · 改造文档 §2.1(3)）——
 * **发版闸 + 两把锁 + 错误码闭集，执法落引擎**。
 *
 * 锁定的行为面（判据 = 五码可复现；宿主 MCP 直写 version 受锁；全 cancelled / 全 failed 挡闸）：
 * 1. **排期写状态锁** `board_schedule_state_locked`（跨单元引用码，字面不变，v0.10.0 起改由**引擎**返回）：
 *    仅 `stage=需求分析 ∧ approval=未发起` 的卡可经 advance 写 version；已过需求确认门 ⇒ 拒、零写入。
 * 2. **`released` 锁** `orch_version_released_locked`：目标版号在引擎台账为 `released` ⇒ create / advance
 *    直写均挡（**后门不豁免**）。
 * 3. **存在性优先**：未登记版号 ⇒ `orch_version_unknown`（O5 判据序不变，先于两把锁）。
 * 4. **发版闸** `evaluateReleaseGate` 判据**不变** `total>0 ∧ completed+cancelled===total ∧ completed>0`：
 *    - 全 completed ⇒ 放行；有 open（含 `failed`）⇒ `orch_version_not_converged`；
 *    - 全 cancelled ⇒ `orch_version_all_cancelled`；全 failed ⇒ `orch_version_not_converged`（open 含 failed）；
 *    - **中间态禁令作判据**：版号不在引擎台账（引擎不持有该行）⇒ `orch_version_unknown`（fail-closed，
 *      事实源须在引擎；**即使名下卡已全部收口也挡**，证明挡的是「引擎不持有」而非收口判据）。
 *
 * ⚠ `versions` 表由 O1 建（已落默认 schema）；测试侧 `seedVersionLedger` 用 `CREATE TABLE IF NOT EXISTS` +
 *   INSERT 灌行，O1 表已在 ⇒ 建表为 no-op、只补数据（与 O5 同法）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  close,
  createFeature,
  getFeature,
  openStoreDatabase,
} from "../session/store.js";
import {
  evaluateReleaseGate,
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
    `a2a-v0100-o4-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

function rmDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
}

/**
 * 建 O1 版本台账并灌入给定行（**O1 已落默认 schema ⇒ `CREATE TABLE IF NOT EXISTS` 为 no-op**，仅补数据）。
 * 表结构与改造文档 §2.1(1) 一致（PK `(owner_group, version)`、`status` 三态）。
 */
function seedVersionLedger(
  dbPath: string,
  rows: Array<[ownerGroup: string | null, version: string, status: string]>,
): void {
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
      "INSERT OR REPLACE INTO versions (owner_group, version, status) VALUES (?, ?, ?)",
    );
    for (const [og, v, status] of rows) ins.run(og, v, status);
  } finally {
    db.close();
  }
}

/** 让默认存储重开到指定文件（close ⇒ 下次访问按 `SESSION_DB` 重建） */
function reopenDefault(dbPath: string): void {
  process.env["SESSION_DB"] = dbPath;
  close();
}

/** 建库（跑既有 DDL / features 表）后关闭，供灌入版本台账 */
function bootstrap(dbPath: string): void {
  reopenDefault(dbPath);
  mustOk(handleFeatureCreate({ title: "bootstrap" }));
  close();
}

function resetToMemory(): void {
  process.env["SESSION_DB"] = ":memory:";
  close();
}

// ---------------------------------------------------------------------------
// 1：排期写状态锁 `board_schedule_state_locked`（宿主 MCP 直写受锁）
// ---------------------------------------------------------------------------

test("O4 排期写状态锁：需求分析∧未发起 的卡可经 advance 排期；已过门的卡被引擎挡", () => {
  const dbPath = tmpDbPath("state-lock");
  try {
    bootstrap(dbPath);
    seedVersionLedger(dbPath, [["g1", "1.0.0", "active"]]);
    reopenDefault(dbPath);

    // ① 想法卡（需求分析 / 未发起）⇒ advance 写 version 放行（改版纪律第一档）
    const idea = mustOk(
      handleFeatureCreate({ title: "想法挪版", stage: "需求分析", approval: "未发起" }, "g1"),
    );
    mustOk(handleFeatureAdvance({ featureId: idea.featureId, to: "waiting_approval", version: "1.0.0" }));
    assert.equal(getFeature(idea.featureId)?.version, "1.0.0", "需求分析∧未发起 ⇒ 排期写放行");

    // ② 已过需求确认门（改造方案 / 待审批）⇒ 引擎挡（非板）
    const confirmed = mustOk(
      handleFeatureCreate({ title: "已过门", stage: "改造方案", approval: "待审批" }, "g1"),
    );
    const fail = mustFail(
      handleFeatureAdvance({ featureId: confirmed.featureId, to: "waiting_approval", version: "1.0.0" }),
    );
    assert.equal(fail.code, "board_schedule_state_locked", "已过门卡再排期 ⇒ 引擎返回跨单元码");
    assert.equal(getFeature(confirmed.featureId)?.version, "", "拒绝 ⇒ version 零写入");
    close();
  } finally {
    rmDb(dbPath);
    resetToMemory();
  }
});

// ---------------------------------------------------------------------------
// 2：released 锁 `orch_version_released_locked`（create + advance 同挡）
// ---------------------------------------------------------------------------

test("O4 released 锁：已发版版号不可排入 —— 宿主 MCP 直写（create / advance）同受引擎执法", () => {
  const dbPath = tmpDbPath("released-lock");
  try {
    bootstrap(dbPath);
    seedVersionLedger(dbPath, [
      ["g1", "1.0.0", "active"],
      ["g1", "9.9.9", "released"],
    ]);
    reopenDefault(dbPath);

    // create 直写已发版版号 ⇒ 挡
    const cf = mustFail(
      handleFeatureCreate(
        { title: "直写已发版", stage: "需求分析", approval: "未发起", version: "9.9.9" },
        "g1",
      ),
    );
    assert.equal(cf.code, "orch_version_released_locked", "create 施 released 锁");

    // advance 直写已发版版号（卡处于可排期态）⇒ 挡
    const idea = mustOk(
      handleFeatureCreate({ title: "想法", stage: "需求分析", approval: "未发起" }, "g1"),
    );
    const af = mustFail(
      handleFeatureAdvance({ featureId: idea.featureId, to: "waiting_approval", version: "9.9.9" }),
    );
    assert.equal(af.code, "orch_version_released_locked", "advance 施 released 锁（后门不豁免）");
    assert.equal(getFeature(idea.featureId)?.version, "", "拒绝 ⇒ version 零写入");

    // 对照：未发版版号（1.0.0 active）排期放行
    mustOk(handleFeatureAdvance({ featureId: idea.featureId, to: "waiting_approval", version: "1.0.0" }));
    assert.equal(getFeature(idea.featureId)?.version, "1.0.0", "active 版号可排期");
    close();
  } finally {
    rmDb(dbPath);
    resetToMemory();
  }
});

// ---------------------------------------------------------------------------
// 3：存在性优先（O5 判据序不变，先于两把锁）
// ---------------------------------------------------------------------------

test("O4 判据优先序：未登记版号 ⇒ orch_version_unknown（先于 released / 状态锁）", () => {
  const dbPath = tmpDbPath("unknown-first");
  try {
    bootstrap(dbPath);
    seedVersionLedger(dbPath, [["g1", "1.0.0", "active"]]);
    reopenDefault(dbPath);

    // 已过门卡 + 未登记版号 ⇒ 存在性先挡（不被状态锁抢先）
    const confirmed = mustOk(
      handleFeatureCreate({ title: "已过门", stage: "改造方案", approval: "待审批" }, "g1"),
    );
    const fail = mustFail(
      handleFeatureAdvance({ featureId: confirmed.featureId, to: "waiting_approval", version: "8.8.8" }),
    );
    assert.equal(fail.code, "orch_version_unknown", "存在性检查先行（O5 序不变）");
    close();
  } finally {
    rmDb(dbPath);
    resetToMemory();
  }
});

// ---------------------------------------------------------------------------
// 4：发版闸 evaluateReleaseGate（判据不变 + 中间态禁令作判据）
// ---------------------------------------------------------------------------

test("O4 发版闸：全 completed 放行；有 open 挡；全 cancelled 挡；全 failed 挡；不在台账挡", () => {
  const dbPath = tmpDbPath("gate");
  try {
    bootstrap(dbPath);
    seedVersionLedger(dbPath, [
      ["gg", "2.0.0", "active"],
      ["gg", "3.0.0", "active"],
      ["gg", "4.0.0", "active"],
      ["gg", "6.0.0", "active"],
    ]);
    reopenDefault(dbPath);

    // 2.0.0：全 completed ⇒ 放行
    createFeature({ featureId: "c2a", title: "A", version: "2.0.0", state: "completed", ownerGroup: "gg" });
    createFeature({ featureId: "c2b", title: "B", version: "2.0.0", state: "completed", ownerGroup: "gg" });
    const ok = evaluateReleaseGate({ ownerGroup: "gg", version: "2.0.0" });
    assert.equal(ok.ok, true, "全 completed ⇒ 闸放行");

    // 3.0.0：全 cancelled ⇒ 挡（无任何交付）
    createFeature({ featureId: "c3a", title: "C", version: "3.0.0", state: "cancelled", ownerGroup: "gg" });
    createFeature({ featureId: "c3b", title: "D", version: "3.0.0", state: "cancelled", ownerGroup: "gg" });
    const allCancelled = mustFail(evaluateReleaseGate({ ownerGroup: "gg", version: "3.0.0" }));
    assert.equal(allCancelled.code, "orch_version_all_cancelled", "全 cancelled ⇒ 挡闸");

    // 4.0.0：全 failed ⇒ open 含 failed ⇒ 未收口（须先 cancel 归档）
    createFeature({ featureId: "c4a", title: "E", version: "4.0.0", state: "failed", ownerGroup: "gg" });
    const allFailed = mustFail(evaluateReleaseGate({ ownerGroup: "gg", version: "4.0.0" }));
    assert.equal(allFailed.code, "orch_version_not_converged", "全 failed ⇒ 未收口挡闸");

    // 6.0.0：completed + open（executing）⇒ 未收口
    createFeature({ featureId: "c6a", title: "F", version: "6.0.0", state: "completed", ownerGroup: "gg" });
    createFeature({ featureId: "c6b", title: "G", version: "6.0.0", state: "executing", ownerGroup: "gg" });
    const mixed = mustFail(evaluateReleaseGate({ ownerGroup: "gg", version: "6.0.0" }));
    assert.equal(mixed.code, "orch_version_not_converged", "有 open ⇒ 未收口挡闸");

    // 9.9.9：不在引擎台账 ⇒ 挡（含中间态禁令：事实源须在引擎）
    const unknown = mustFail(evaluateReleaseGate({ ownerGroup: "gg", version: "9.9.9" }));
    assert.equal(unknown.code, "orch_version_unknown", "版号不在引擎台账 ⇒ 挡");
    close();
  } finally {
    rmDb(dbPath);
    resetToMemory();
  }
});

test("O4 发版闸中间态禁令：版号只在板侧本地投影、未落引擎 versions ⇒ fail-closed 挡发布（非仅纪律）", () => {
  // v0.10.0 事实源在引擎：发版闸判据「版号 ∈ 引擎 versions 台账」把「不得发布既写本地台账又读引擎的中间态」
  // 写成**机器判据**（非仅纪律）。构造中间态 = 卡排到 1.0.0（板本地投影认它存在）且名下**已全 completed**
  // （满足收口口径），但引擎 versions 台账只登记 2.0.0 —— 引擎不持有 1.0.0 ⇒ **即便已收口仍挡发布**（fail-closed）。
  const dbPath = tmpDbPath("intermediate-state");
  try {
    bootstrap(dbPath);
    seedVersionLedger(dbPath, [["gg", "2.0.0", "active"]]);
    reopenDefault(dbPath);

    // 1.0.0 名下做到"全 completed"，但引擎台账无该行 ⇒ 挡（存在性优先于收口判据）
    createFeature({ featureId: "i1", title: "I", version: "1.0.0", state: "completed", ownerGroup: "gg" });
    createFeature({ featureId: "i2", title: "J", version: "1.0.0", state: "completed", ownerGroup: "gg" });
    const fail = mustFail(evaluateReleaseGate({ ownerGroup: "gg", version: "1.0.0" }));
    assert.equal(
      fail.code,
      "orch_version_unknown",
      "版号未落引擎台账 ⇒ 发版闸 fail-closed（中间态禁令；非 not_converged，挡因是「引擎不持有」）",
    );

    // 对照：引擎登记的 2.0.0 且收口 ⇒ 放行（证明上一步挡的是「不在台账」、不是收口判据本身）
    createFeature({ featureId: "i3", title: "K", version: "2.0.0", state: "completed", ownerGroup: "gg" });
    assert.equal(
      evaluateReleaseGate({ ownerGroup: "gg", version: "2.0.0" }).ok,
      true,
      "引擎持有 ∧ 收口 ⇒ 放行",
    );
    close();
  } finally {
    resetToMemory(); // 先关（释放在 dbPath 上的 store 句柄），再删文件
    rmDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 5：五码闭集可复现（汇总断言）
// ---------------------------------------------------------------------------

test("O4 五码闭集：本节点产出的五个错误码均可复现", () => {
  const dbPath = tmpDbPath("five-codes");
  try {
    bootstrap(dbPath);
    seedVersionLedger(dbPath, [
      ["g1", "1.0.0", "active"],
      ["g1", "9.9.9", "released"],
      ["gg", "3.0.0", "active"],
      ["gg", "6.0.0", "active"],
    ]);
    reopenDefault(dbPath);

    const seen = new Set<string>();

    // board_schedule_state_locked
    const confirmed = mustOk(
      handleFeatureCreate({ title: "已过门", stage: "改造方案", approval: "待审批" }, "g1"),
    );
    seen.add(mustFail(handleFeatureAdvance({ featureId: confirmed.featureId, to: "waiting_approval", version: "1.0.0" })).code);

    // orch_version_released_locked
    const idea = mustOk(
      handleFeatureCreate({ title: "想法", stage: "需求分析", approval: "未发起" }, "g1"),
    );
    seen.add(mustFail(handleFeatureAdvance({ featureId: idea.featureId, to: "waiting_approval", version: "9.9.9" })).code);

    // orch_version_unknown（写口存在性）
    seen.add(mustFail(handleFeatureCreate({ title: "脏名", version: "8.8.8" }, "g1")).code);

    // orch_version_all_cancelled（发版闸）
    createFeature({ featureId: "cc1", title: "X", version: "3.0.0", state: "cancelled", ownerGroup: "gg" });
    seen.add(mustFail(evaluateReleaseGate({ ownerGroup: "gg", version: "3.0.0" })).code);

    // orch_version_not_converged（发版闸）
    createFeature({ featureId: "nc1", title: "Y", version: "6.0.0", state: "completed", ownerGroup: "gg" });
    createFeature({ featureId: "nc2", title: "Z", version: "6.0.0", state: "executing", ownerGroup: "gg" });
    seen.add(mustFail(evaluateReleaseGate({ ownerGroup: "gg", version: "6.0.0" })).code);

    for (const code of [
      "board_schedule_state_locked",
      "orch_version_released_locked",
      "orch_version_unknown",
      "orch_version_all_cancelled",
      "orch_version_not_converged",
    ]) {
      assert.ok(seen.has(code), `错误码 ${code} 应可复现`);
    }
    close();
  } finally {
    rmDb(dbPath);
    resetToMemory();
  }
});
