/**
 * v0.10.0 O7（REQ-v0.10.0-2026-09-24-01 · 改造文档 §2.1(1)(6)）——
 * **标记 `released` 时与 `versions.status` 同事务写 `releases` 快照**。
 *
 * 锁定的行为面（判据 = 「released ⇒ 快照落地且不可变 / 非 released 阶段无快照行」）：
 * 1. **同事务**：`UPDATE versions.status='released'` + `INSERT releases` + `version.released` 事件
 *    一并成立或一并回滚（快照 INSERT 失败 ⇒ 状态**不迁**，不留「已锁无事实」的半成品版本）；
 * 2. **不可变**：快照只在缺失时 INSERT，**已有即不覆写**（二次标记 = 幂等回读，入参被忽略）；
 * 3. **非 released 阶段无快照行**：建版（`notstart` / `active`）本身不产生任何 `releases` 行；
 * 4. **`repoId` 取原值、不查 `runner_projects`**（投影表全量替换、上报缺位即空 ⇒ 拿它当数据源会写
 *    假事实）：含空格 / 大小写的原样回读，注册表空着也照样落；
 * 5. **发版分支**（`markVersionReleased`）判据序：台账事实源 → 发版闸（O4）→ `projects` 边界校验
 *    → store 事务；闸不过 / 入参非法 ⇒ **零写入**；已 `released` 的重复标记**不再过闸**（幂等）。
 *
 * ⚠ `versions` / `releases` 两表由 O1 建（已落默认 schema）⇒ 本文件用真表，不代打 fixture。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  close,
  createFeature,
  ERR_RELEASE_PROJECTS,
  ERR_VERSION_SHAPE,
  ERR_VERSION_UNKNOWN,
  EVENT_VERSION_RELEASED,
  openStoreDatabase,
  releaseSnapshotGet,
  releaseSnapshotList,
  SessionStore,
  versionLedgerGet,
} from "../session/store.js";
import type { ReleaseSnapshotWriteResult, VersionLedgerWriteResult } from "../session/store.js";
import { markVersionReleased } from "../bridge/versions-release.js";
import type { MarkVersionReleasedResult } from "../bridge/versions-release.js";
import { handleFeatureCreate, type FeatureToolFailure } from "../bridge/feature-tools.js";

function newStore(): SessionStore {
  return new SessionStore(":memory:");
}

function tmpDbPath(tag: string): string {
  return join(
    tmpdir(),
    `a2a-v0100-o7-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

function rmDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
}

/** 让默认存储重开到指定文件（close ⇒ 下次访问按 `SESSION_DB` 重建） */
function reopenDefault(dbPath: string): void {
  process.env["SESSION_DB"] = dbPath;
  close();
}

function resetToMemory(): void {
  process.env["SESSION_DB"] = ":memory:";
  close();
}

function mustOkSnapshot(
  outcome: ReleaseSnapshotWriteResult,
): Extract<ReleaseSnapshotWriteResult, { ok: true }> {
  if (!outcome.ok) throw new Error(`期望快照写成功，实际失败：${outcome.code} ${outcome.message}`);
  return outcome;
}

function mustOkLedger(
  outcome: VersionLedgerWriteResult,
): Extract<VersionLedgerWriteResult, { ok: true }> {
  if (!outcome.ok) throw new Error(`期望建版成功，实际失败：${outcome.code} ${outcome.message}`);
  return outcome;
}

function mustFailRelease(
  outcome: MarkVersionReleasedResult,
): Extract<MarkVersionReleasedResult, { ok: false }> {
  if (outcome.ok) throw new Error("期望发版被拒，实际成功");
  return outcome;
}

function mustOkRelease(
  outcome: MarkVersionReleasedResult,
): Extract<MarkVersionReleasedResult, { ok: true }> {
  if (!outcome.ok) throw new Error(`期望发版成功，实际失败：${outcome.code} ${outcome.message}`);
  return outcome;
}

function mustOkFeature(outcome: { ok: boolean; featureId?: string } | FeatureToolFailure): string {
  if (!outcome.ok) {
    const f = outcome as FeatureToolFailure;
    throw new Error(`期望建卡成功，实际失败：${f.code} ${f.error}`);
  }
  const featureId = (outcome as { featureId?: string }).featureId;
  if (typeof featureId !== "string") throw new Error("建卡出参缺 featureId");
  return featureId;
}

/** 真发版链路前置：建版（active）+ 名下卡全 completed（同一 store 实例，不开第二个句柄） */
function seedReleasedReady(dbPath: string, ownerGroup: string | null, version: string): void {
  const store = new SessionStore(dbPath);
  try {
    mustOkLedger(store.versionLedgerCreate({ ownerGroup, version, status: "active" }));
    const featureId = store.createFeature({
      featureId: `f-${version}`,
      title: "待发版需求",
      ownerGroup,
      version,
    }).featureId;
    store.updateFeatureState(featureId, "completed");
  } finally {
    store.close();
  }
}

/** 数 `version.released` 事件条数（留痕判据用） */
function releaseEvents(store: SessionStore): number {
  return store.listEvents({ limit: 1000 }).filter((e) => e.kind === EVENT_VERSION_RELEASED).length;
}

// ---------------------------------------------------------------------------
// 1：同事务 —— 状态迁移 + 快照 + 事件三写一并成立
// ---------------------------------------------------------------------------

test("O7 同事务：标记 released ⇒ versions.status 与 releases 快照一并落、事件一条", () => {
  const store = newStore();
  try {
    mustOkLedger(
      store.versionLedgerCreate({ ownerGroup: "g1", version: "1.0.0", status: "active" }),
    );
    const written = mustOkSnapshot(
      store.versionLedgerMarkReleased({
        ownerGroup: "g1",
        version: "1.0.0",
        changelogAnchor: "#v1.0.0",
        projects: [{ repoId: "g1/orch", ref: "orch/v1.0.0" }],
        note: "首个发版",
      }),
    );
    assert.equal(written.statusMigrated, true, "active ⇒ released 真迁移");
    assert.equal(written.snapshotWritten, true, "快照本次落地");
    assert.equal(written.ledger.status, "released", "台账状态已迁");
    assert.equal(store.versionLedgerGet("g1", "1.0.0")?.status, "released", "落库可读回");
    assert.deepEqual(store.releaseSnapshotGet("g1", "1.0.0")?.projects, [
      { repoId: "g1/orch", ref: "orch/v1.0.0" },
    ]);
    assert.equal(store.releaseSnapshotGet("g1", "1.0.0")?.changelogAnchor, "#v1.0.0");
    assert.equal(releaseEvents(store), 1, "发版事件恰好一条");
  } finally {
    store.close();
  }
});

test("O7 同事务回滚：快照 INSERT 失败 ⇒ status 不迁（不留「已锁无事实」的半成品版本）", () => {
  const dbPath = tmpDbPath("rollback");
  try {
    const store = new SessionStore(dbPath);
    mustOkLedger(
      store.versionLedgerCreate({ ownerGroup: "g1", version: "1.0.0", status: "active" }),
    );
    store.close();

    // 外科手术：给 releases 挂一条必失败的触发器 ⇒ 事务内**第二条**语句失败，
    // 用来证明第一条（UPDATE status）不会单独提交（表本身仍在 ⇒ 走的是回滚路径而非 DDL 重建）。
    const raw = openStoreDatabase(dbPath);
    raw.exec(
      `CREATE TRIGGER o7_fail_insert_releases AFTER INSERT ON releases
       BEGIN SELECT RAISE(ABORT, 'O7 用例：快照写入人为失败'); END`,
    );
    raw.close();

    const victim = new SessionStore(dbPath);
    assert.throws(
      () =>
        victim.versionLedgerMarkReleased({
          ownerGroup: "g1",
          version: "1.0.0",
          changelogAnchor: "#v1.0.0",
        }),
      /快照写入人为失败|no such/i,
      "事务内失败必须外抛（不得静默吞）",
    );
    assert.equal(
      victim.versionLedgerGet("g1", "1.0.0")?.status,
      "active",
      "回滚 ⇒ status 保持原值",
    );
    assert.equal(victim.releaseSnapshotGet("g1", "1.0.0"), null, "回滚 ⇒ 无快照行");
    assert.equal(releaseEvents(victim), 0, "回滚 ⇒ 无发版事件");
    victim.close();
  } finally {
    rmDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 2：不可变 —— 二次标记不得改写任何一列
// ---------------------------------------------------------------------------

test("O7 不可变：已 released 再标记（不同入参）⇒ 零改写、零新事件，回读原快照", () => {
  const store = newStore();
  try {
    mustOkLedger(
      store.versionLedgerCreate({ ownerGroup: "g1", version: "1.0.0", status: "active" }),
    );
    const first = mustOkSnapshot(
      store.versionLedgerMarkReleased({
        ownerGroup: "g1",
        version: "1.0.0",
        changelogAnchor: "#v1.0.0",
        projects: [{ repoId: "g1/orch", ref: "orch/v1.0.0" }],
        note: "第一次的发版说明",
      }),
    );
    const second = mustOkSnapshot(
      store.versionLedgerMarkReleased({
        ownerGroup: "g1",
        version: "1.0.0",
        changelogAnchor: "#篡改锚点",
        projects: [{ repoId: "evil", ref: "evil-ref" }],
        note: "第二次试图改写",
      }),
    );
    assert.equal(second.statusMigrated, false, "已是 released ⇒ 不再迁状态");
    assert.equal(second.snapshotWritten, false, "快照已存在 ⇒ 不覆写");
    assert.equal(second.snapshot.createdAt, first.snapshot.createdAt, "createdAt 保持第一次");
    assert.equal(second.snapshot.changelogAnchor, "#v1.0.0", "changelogAnchor 不被改写");
    assert.equal(second.snapshot.note, "第一次的发版说明", "note 不被改写");
    assert.deepEqual(second.snapshot.projects, [{ repoId: "g1/orch", ref: "orch/v1.0.0" }]);
    assert.equal(releaseEvents(store), 1, "幂等重复标记 ⇒ 不再发事件");
  } finally {
    store.close();
  }
});

test("O7 补写：历史 released 行无快照（迁移主源导入）⇒ 只落快照、不动状态、事件标 backfilled", () => {
  const dbPath = tmpDbPath("backfill");
  try {
    const store = new SessionStore(dbPath);
    mustOkLedger(
      store.versionLedgerCreate({ ownerGroup: "g1", version: "0.9.8", status: "active" }),
    );
    mustOkSnapshot(store.versionLedgerMarkReleased({ ownerGroup: "g1", version: "0.9.8" }));
    // 模拟「迁移脚本只导入台账 released 行、无快照」：外科式把快照删掉（表可由 raw 句柄操作）
    store.close();
    const raw = openStoreDatabase(dbPath);
    raw.exec("DELETE FROM releases WHERE owner_group = 'g1' AND version = '0.9.8'");
    raw.exec("DELETE FROM events WHERE kind = 'version.released'");
    raw.close();

    const reopened = new SessionStore(dbPath);
    assert.equal(reopened.versionLedgerGet("g1", "0.9.8")?.status, "released", "台账仍是 released");
    assert.equal(reopened.releaseSnapshotGet("g1", "0.9.8"), null, "历史行无快照（判据 2 前置）");
    const written = mustOkSnapshot(
      reopened.versionLedgerMarkReleased({
        ownerGroup: "g1",
        version: "0.9.8",
        changelogAnchor: "#v0.9.8",
        projects: [{ repoId: null, ref: "orch/v0.9.8" }],
      }),
    );
    assert.equal(written.statusMigrated, false, "补写不动状态（幂等）");
    assert.equal(written.snapshotWritten, true, "补写落快照");
    const events = reopened
      .listEvents({ limit: 1000 })
      .filter((e) => e.kind === EVENT_VERSION_RELEASED);
    assert.equal(events.length, 1);
    assert.equal(JSON.parse(String(events[0]?.payload))["backfilled"], true, "事件标 backfilled");
    reopened.close();
  } finally {
    rmDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 3：非 released 阶段无快照行
// ---------------------------------------------------------------------------

test("O7 阶段隔离：建版 notstart / active 均不产生快照行（发版才落）", () => {
  const store = newStore();
  try {
    mustOkLedger(store.versionLedgerCreate({ ownerGroup: "g1", version: "1.0.0" }));
    mustOkLedger(
      store.versionLedgerCreate({ ownerGroup: "g1", version: "1.1.0", status: "active" }),
    );
    assert.equal(store.releaseSnapshotGet("g1", "1.0.0"), null, "notstart ⇒ 无快照");
    assert.equal(store.releaseSnapshotGet("g1", "1.1.0"), null, "active ⇒ 无快照");
    assert.deepEqual(store.releaseSnapshotList("g1"), [], "非 released 阶段 Release 清单为空");
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 4：repoId 原值入快照、不依赖 runner_projects 投影
// ---------------------------------------------------------------------------

test("O7 repoId 原值：不归一（空格 / 大小写逐字回读），且注册投影为空也照样落", () => {
  const store = newStore();
  try {
    mustOkLedger(
      store.versionLedgerCreate({ ownerGroup: "g1", version: "2.0.0", status: "active" }),
    );
    // runner_projects 全程零上报（内存库不注册任何 Runner）⇒ 若快照取自投影表会是空/假事实
    const written = mustOkSnapshot(
      store.versionLedgerMarkReleased({
        ownerGroup: "g1",
        version: "2.0.0",
        projects: [
          { repoId: " Group-A/Repo-X ", ref: "Orch/v2.0.0" },
          { repoId: null, ref: null },
        ],
      }),
    );
    assert.equal(written.snapshotWritten, true);
    assert.deepEqual(
      store.releaseSnapshotGet("g1", "2.0.0")?.projects,
      [
        { repoId: " Group-A/Repo-X ", ref: "Orch/v2.0.0" },
        { repoId: null, ref: null },
      ],
      "原值入快照：不 trim、不折叠大小写、null 保留",
    );
    assert.deepEqual(store.listRunnerProjects("r-none"), [], "对照：投影表确实为空");
  } finally {
    store.close();
  }
});

test("O7 projects 缺省 = 空数组（单仓未配 repo 的现状仍落快照行）", () => {
  const store = newStore();
  try {
    mustOkLedger(
      store.versionLedgerCreate({ ownerGroup: null, version: "3.0.0", status: "active" }),
    );
    const written = mustOkSnapshot(
      store.versionLedgerMarkReleased({ ownerGroup: null, version: "3.0.0" }),
    );
    assert.deepEqual(written.snapshot.projects, [], "缺省落空数组，不是 null");
    assert.equal(written.snapshot.changelogAnchor, null);
    assert.equal(written.snapshot.note, null);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 5：键与可见性（NULL-safe IS / 组隔离 / 匿名档不重复插行）
// ---------------------------------------------------------------------------

test("O7 键隔离：同名版号分属两组 ⇒ 各自快照独立；匿名档重复标记不产生第二行", () => {
  const store = newStore();
  try {
    mustOkLedger(
      store.versionLedgerCreate({ ownerGroup: "g1", version: "1.0.0", status: "active" }),
    );
    mustOkLedger(
      store.versionLedgerCreate({ ownerGroup: "g2", version: "1.0.0", status: "active" }),
    );
    mustOkLedger(
      store.versionLedgerCreate({ ownerGroup: null, version: "1.0.0", status: "active" }),
    );
    mustOkSnapshot(
      store.versionLedgerMarkReleased({
        ownerGroup: "g1",
        version: "1.0.0",
        projects: [{ repoId: "g1/orch", ref: "orch/v1.0.0" }],
      }),
    );
    mustOkSnapshot(
      store.versionLedgerMarkReleased({
        ownerGroup: "g2",
        version: "1.0.0",
        projects: [{ repoId: "g2/machine", ref: "machine/v1.0.0" }],
      }),
    );
    assert.deepEqual(store.releaseSnapshotGet("g1", "1.0.0")?.projects, [
      { repoId: "g1/orch", ref: "orch/v1.0.0" },
    ]);
    assert.deepEqual(store.releaseSnapshotGet("g2", "1.0.0")?.projects, [
      { repoId: "g2/machine", ref: "machine/v1.0.0" },
    ]);
    assert.equal(store.releaseSnapshotGet("g3", "1.0.0"), null, "他组不可见 ⇒ 无此行");

    // 匿名档：PK 含可空列 ⇒ SQLite 视 NULL 互不相等，重复标记**不得**靠 PK 判重（会静默插第二行）
    mustOkSnapshot(store.versionLedgerMarkReleased({ ownerGroup: null, version: "1.0.0" }));
    const again = mustOkSnapshot(
      store.versionLedgerMarkReleased({ ownerGroup: null, version: "1.0.0", note: "改写尝试" }),
    );
    assert.equal(again.snapshotWritten, false, "匿名档二次标记 ⇒ 幂等，不插第二行");
    assert.equal(again.snapshot.note, null, "匿名档快照未被改写");
    assert.equal(store.releaseSnapshotList(null).length, 1, "匿名档清单只有一行");
    assert.deepEqual(
      store.releaseSnapshotList(undefined).map((r) => r.ownerGroup),
      [null, "g1", "g2"],
      "全量清单三档齐（SQLite 升序把 NULL 排在前，排序只由键决定）",
    );
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 6：store 写口的结构化拒绝（零写入）
// ---------------------------------------------------------------------------

test("O7 写口拒绝：台账无此行 ⇒ 404 orch_version_unknown 且零写入", () => {
  const store = newStore();
  try {
    const fail = store.versionLedgerMarkReleased({ ownerGroup: "g1", version: "9.9.9" });
    if (fail.ok) throw new Error("期望台账无此行被拒");
    assert.equal(fail.code, ERR_VERSION_UNKNOWN);
    assert.equal(fail.status, 404);
    assert.deepEqual(store.releaseSnapshotList(), []);
    assert.equal(releaseEvents(store), 0, "拒绝 ⇒ 零事件");
  } finally {
    store.close();
  }
});

test("O7 写口拒绝：空串版号 ⇒ 400 orch_version_invalid_shape", () => {
  const store = newStore();
  try {
    const fail = store.versionLedgerMarkReleased({ ownerGroup: "g1", version: "   " });
    if (fail.ok) throw new Error("期望空串版号被拒");
    assert.equal(fail.code, ERR_VERSION_SHAPE);
    assert.equal(fail.status, 400);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 7：发版分支（markVersionReleased）—— 闸 + 边界校验 + 事务
// ---------------------------------------------------------------------------

test("O7 发版分支：真机链路（建版 + 名下卡全 completed）⇒ 过闸、落快照、回带三桶计数", () => {
  const dbPath = tmpDbPath("bridge-happy");
  try {
    reopenDefault(dbPath);
    seedReleasedReady(dbPath, "g1", "1.0.0");
    reopenDefault(dbPath);
    const ok = mustOkRelease(
      markVersionReleased({
        ownerGroup: "g1",
        version: "1.0.0",
        changelogAnchor: "#v1.0.0",
        projects: [{ repoId: "g1/orch", ref: "orch/v1.0.0" }],
        note: "发版步骤 4-7 完成",
      }),
    );
    assert.deepEqual(ok.gateCounts, { total: 1, completed: 1, cancelled: 0, open: 0 });
    assert.equal(ok.ledger.status, "released");
    assert.equal(ok.snapshotWritten, true);
    assert.equal(releaseSnapshotGet("g1", "1.0.0")?.changelogAnchor, "#v1.0.0");
    close();
  } finally {
    rmDb(dbPath);
    resetToMemory();
  }
});

test("O7 发版分支：名下有未收口卡 ⇒ 发版闸挡（orch_version_not_converged）且零写入", () => {
  const dbPath = tmpDbPath("bridge-open-card");
  try {
    reopenDefault(dbPath);
    seedReleasedReady(dbPath, "g1", "1.0.0");
    mustOkFeature(handleFeatureCreate({ title: "在飞卡", version: "1.0.0" }, "g1"));
    reopenDefault(dbPath);
    const fail = mustFailRelease(
      markVersionReleased({ ownerGroup: "g1", version: "1.0.0", projects: [] }),
    );
    assert.equal(fail.code, "orch_version_not_converged");
    assert.equal(fail.status, 409);
    assert.equal(versionLedgerGet("g1", "1.0.0")?.status, "active", "闸挡 ⇒ 状态不迁");
    assert.equal(releaseSnapshotGet("g1", "1.0.0"), null, "闸挡 ⇒ 无快照行");
    close();
  } finally {
    rmDb(dbPath);
    resetToMemory();
  }
});

test("O7 发版分支：全 cancelled 无任何交付 ⇒ orch_version_all_cancelled 挡闸", () => {
  const dbPath = tmpDbPath("bridge-all-cancelled");
  try {
    reopenDefault(dbPath);
    const store = new SessionStore(dbPath);
    mustOkLedger(
      store.versionLedgerCreate({ ownerGroup: "g1", version: "1.2.0", status: "active" }),
    );
    store.createFeature({ featureId: "c1", title: "取消轨", ownerGroup: "g1", version: "1.2.0" });
    store.updateFeatureState("c1", "cancelled");
    store.close();
    reopenDefault(dbPath);
    const fail = mustFailRelease(markVersionReleased({ ownerGroup: "g1", version: "1.2.0" }));
    assert.equal(fail.code, "orch_version_all_cancelled");
    assert.equal(releaseSnapshotGet("g1", "1.2.0"), null);
    close();
  } finally {
    rmDb(dbPath);
    resetToMemory();
  }
});

test("O7 发版分支：未登记版号 ⇒ 404（发版不代发版号，建版归 O2a）", () => {
  const dbPath = tmpDbPath("bridge-unknown");
  try {
    reopenDefault(dbPath);
    const fail = mustFailRelease(markVersionReleased({ ownerGroup: "g1", version: "7.7.7" }));
    assert.equal(fail.code, ERR_VERSION_UNKNOWN);
    assert.equal(fail.status, 404);
    close();
  } finally {
    rmDb(dbPath);
    resetToMemory();
  }
});

test("O7 发版分支：projects 形状非法 ⇒ 400 orch_release_projects_invalid 且零写入（校验在进事务前）", () => {
  const dbPath = tmpDbPath("bridge-projects");
  const badPayloads: unknown[] = [
    { repoId: "not-array" },
    "g1/orch",
    [{ repoId: 42, ref: "x" }],
    [{ ref: { nested: true } }],
    [null],
  ];
  try {
    reopenDefault(dbPath);
    seedReleasedReady(dbPath, "g1", "1.0.0");
    reopenDefault(dbPath);
    for (const projects of badPayloads) {
      const fail = mustFailRelease(
        markVersionReleased({ ownerGroup: "g1", version: "1.0.0", projects }),
      );
      assert.equal(
        fail.code,
        ERR_RELEASE_PROJECTS,
        `入参 ${JSON.stringify(projects)} 应被形状校验挡`,
      );
      assert.equal(fail.status, 400);
    }
    assert.equal(versionLedgerGet("g1", "1.0.0")?.status, "active", "形状非法 ⇒ 状态不迁");
    assert.equal(releaseSnapshotGet("g1", "1.0.0"), null, "形状非法 ⇒ 无快照行");
    // 合法入参：null / 缺省 / 元素缺键 ⇒ 归一为 {repoId:null, ref:null} 通过
    const ok = mustOkRelease(
      markVersionReleased({
        ownerGroup: "g1",
        version: "1.0.0",
        projects: [{ repoId: "g1/orch" }, { ref: null }],
      }),
    );
    assert.deepEqual(ok.snapshot.projects, [
      { repoId: "g1/orch", ref: null },
      { repoId: null, ref: null },
    ]);
    close();
  } finally {
    rmDb(dbPath);
    resetToMemory();
  }
});

test("O7 发版分支：已 released 的重复标记不再过闸（幂等）—— 名下新增未收口卡也仍回读原快照", () => {
  const dbPath = tmpDbPath("bridge-idempotent-skip-gate");
  try {
    reopenDefault(dbPath);
    seedReleasedReady(dbPath, "g1", "1.0.0");
    reopenDefault(dbPath);
    mustOkRelease(
      markVersionReleased({
        ownerGroup: "g1",
        version: "1.0.0",
        changelogAnchor: "#v1.0.0",
        projects: [{ repoId: "g1/orch", ref: "orch/v1.0.0" }],
      }),
    );
    // 发版后又挂一张未收口卡 ⇒ 若重复标记仍过闸会被挡，但「幂等回读」不该被闸挡
    createFeature({ featureId: "late", title: "事后补卡", ownerGroup: "g1", version: "1.0.0" });
    const again = mustOkRelease(
      markVersionReleased({
        ownerGroup: "g1",
        version: "1.0.0",
        changelogAnchor: "#篡改",
        projects: [{ repoId: "evil", ref: "evil" }],
      }),
    );
    assert.equal(again.gateCounts, null, "已 released ⇒ 本次未过闸");
    assert.equal(again.statusMigrated, false);
    assert.equal(again.snapshotWritten, false);
    assert.equal(again.snapshot.changelogAnchor, "#v1.0.0", "快照不可变：入参被忽略");
    assert.deepEqual(again.snapshot.projects, [{ repoId: "g1/orch", ref: "orch/v1.0.0" }]);
    assert.equal(
      releaseSnapshotList("g1").length,
      1,
      "Release 清单仍一行（板 §2.3(3) 版本列左半不受重复标记污染）",
    );
    close();
  } finally {
    rmDb(dbPath);
    resetToMemory();
  }
});
