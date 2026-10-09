/**
 * v0.10.1 **O4**（REQ-2026-10-09-01 · 改造文档 §2 C-4 / C-5 / §2.2 / §3 orch 段 / §5 T3）
 * —— **Group mark-released 同事务级联 project 版本 `released`** + **交付快照 `projects[]` 形状扩**。
 *
 * 锁定的行为面：
 * 1. **级联（C-4）**：标 Group `released` ⇒ 该 Group Version 名下**被触达**（= `feature_projects` 里
 *    `(owner_group, group_version)` 的**去重** `(project_id, project_version)`）的 project 版本
 *    **在同事务内**变 `released`；**未被触达的 project 一行都不动**；
 * 2. **不隐式建版**：归属指向不存在的 project 版本行 ⇒ 级联**不补行**（UPDATE 不建行）；
 *    `project_versions` 总行数在发版前后**逐字相等**；
 * 3. **去重**：多条需求触达同一 `(project_id, project_version)` ⇒ 触达集只算一次（事件留痕
 *    `projectVersionsTargeted`）；
 * 4. **组作用域 + 匿名档**：级联按 `owner_group` 定值（NULL-safe `IS`）⇒ 同名版号在他组 /
 *    匿名档互不染色；
 * 5. **★事务原子性**：级联那一步失败（AFTER UPDATE 触发器 RAISE ABORT）⇒ Group `status` **不落**、
 *    `releases` **无行**（整体回滚，不留「Group 已发版而 project 仍 open」的半成品）；
 * 6. **幂等 / 冻结 / 级联照跑**：触达行本就 `released` ⇒ 不重复迁（零变更 ⇒ 零事件）；
 *    已 `released` 的 Group 再标记 ⇒ 级联仍执行（补上漏网的 `open` 行）；
 * 7. **快照形状扩（C-5）**：`releases.projects[]` 项 = `{projectId, version, repoId, ref}`，
 *    四键皆 `string | null | 缺省`；**新增键可选、既有键语义不收紧 ⇒ 协议版本保持 `2.3`**；
 *    **历史旧形状行仍可读**（读回形状与写入逐字一致，缺键不补 `null`、不回填）；新键脏类型 ⇒
 *    `orch_release_projects_invalid` 且**零写入**；
 * 8. **O4 边界钉**：Group 发版闸判据**未放宽**（未收口 / 形状不过 ⇒ 零写入、不级联）；
 *    `orch_version_released_locked` 对级联后已 `released` 的 Group 版本**仍拦新增排期**。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  close,
  ERR_RELEASE_PROJECTS,
  EVENT_VERSION_RELEASED,
  openStoreDatabase,
  projectVersionGet,
  releaseSnapshotList,
  SessionStore,
  versionLedgerGet,
  versionLedgerMarkReleased,
} from "../session/store.js";
import type { ReleaseSnapshotWriteResult, VersionLedgerWriteResult } from "../session/store.js";
import { markVersionReleased } from "../bridge/versions-release.js";
import { handleFeatureCreate, type FeatureToolFailure } from "../bridge/feature-tools.js";
import { PROTOCOL_VERSION } from "../types.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

function newStore(): SessionStore {
  return new SessionStore(":memory:");
}

function tmpDbPath(tag: string): string {
  return join(
    tmpdir(),
    `a2a-v0101-o4-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`,
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

function mustOkLedger(
  outcome: VersionLedgerWriteResult,
): Extract<VersionLedgerWriteResult, { ok: true }> {
  if (!outcome.ok) throw new Error(`期望建版成功，实际失败：${outcome.code} ${outcome.message}`);
  return outcome;
}

function mustOkSnapshot(
  outcome: ReleaseSnapshotWriteResult,
): Extract<ReleaseSnapshotWriteResult, { ok: true }> {
  if (!outcome.ok) throw new Error(`期望发版成功，实际失败：${outcome.code} ${outcome.message}`);
  return outcome;
}

function mustOkWrite(outcome: { ok: boolean; code?: string; message?: string }): void {
  if (!outcome.ok) throw new Error(`期望写成功，实际失败：${outcome.code} ${outcome.message}`);
}

function mustFailTool(outcome: { ok: boolean } | FeatureToolFailure): FeatureToolFailure {
  if (outcome.ok) throw new Error("期望被拒，实际成功");
  return outcome as FeatureToolFailure;
}

/** 发版事件（`version.released`）payload 清单（`event_id ASC` ⇒ 末条即最近一次） */
function releasePayloads(store: SessionStore): Array<Record<string, unknown>> {
  return store
    .listEvents({ limit: 1000 })
    .filter((e) => e.kind === EVENT_VERSION_RELEASED)
    .map((e) => JSON.parse(String(e.payload)) as Record<string, unknown>);
}

function createGroupVersion(store: SessionStore, ownerGroup: string | null, version: string): void {
  mustOkLedger(store.versionLedgerCreate({ ownerGroup, version, status: "active" }));
}

function createProjectVersion(
  store: SessionStore,
  ownerGroup: string | null,
  projectId: string,
  version: string,
): void {
  mustOkWrite(store.projectVersionCreate({ ownerGroup, projectId, version }));
}

/** 归属直写 store 口（绕开 O2 的门 —— 本文件测的是级联，不是门；门的用例在 v0101-o2） */
function attribute(
  store: SessionStore,
  ownerGroup: string | null,
  featureId: string,
  projectId: string,
  projectVersion: string,
  groupVersion: string,
): void {
  mustOkWrite(
    store.featureProjectUpsert({
      ownerGroup,
      featureId,
      projectId,
      projectVersion,
      groupVersion,
      source: "o4-fixture",
    }),
  );
}

/** 建一张已 completed 的卡（发版闸的前置），返回 featureId */
function createCompletedFeature(
  store: SessionStore,
  ownerGroup: string | null,
  featureId: string,
  groupVersion: string,
): string {
  const rec = store.createFeature({
    featureId,
    title: "待发版需求",
    ownerGroup,
    version: groupVersion,
  });
  store.updateFeatureState(rec.featureId, "completed");
  return rec.featureId;
}

// ---------------------------------------------------------------------------
// 1：级联 —— 被触达者同事务变 released、未触达者不动
// ---------------------------------------------------------------------------

test("O4 级联：标 Group released ⇒ 被触达的 project 版本同事务变 released；未触达者一行都不动", () => {
  const store = newStore();
  try {
    createGroupVersion(store, "g1", "1.0.0");
    createProjectVersion(store, "g1", "orch", "1.0.0");
    createProjectVersion(store, "g1", "board", "0.5.0");
    createProjectVersion(store, "g1", "machine", "1.0.0"); // 未被触达
    attribute(store, "g1", "f-a", "orch", "1.0.0", "1.0.0");
    attribute(store, "g1", "f-b", "board", "0.5.0", "1.0.0");

    assert.equal(store.projectVersionList("g1").length, 3, "发版前三行皆在");
    assert.ok(
      store.projectVersionList("g1").every((r) => r.status === "open"),
      "发版前无 released 行",
    );

    const written = mustOkSnapshot(
      store.versionLedgerMarkReleased({ ownerGroup: "g1", version: "1.0.0" }),
    );
    assert.equal(written.ledger.status, "released", "Group 态已迁");
    assert.equal(store.projectVersionGet("g1", "orch", "1.0.0")?.status, "released", "触达者①级联");
    assert.equal(
      store.projectVersionGet("g1", "board", "0.5.0")?.status,
      "released",
      "触达者②级联",
    );
    assert.equal(store.projectVersionGet("g1", "machine", "1.0.0")?.status, "open", "未触达不染色");
    assert.equal(store.projectVersionList("g1").length, 3, "级联不新增任何 project 行");

    const payload = releasePayloads(store).at(-1);
    assert.equal(payload?.["projectVersionsTargeted"], 2, "触达集 = 去重后两项");
    assert.equal(payload?.["projectVersionsReleased"], 2, "两行同事务迁入");
  } finally {
    store.close();
  }
});

test("O4 级联去重：多条需求触达同一 (project_id, project_version) ⇒ 触达集只算一次", () => {
  const store = newStore();
  try {
    createGroupVersion(store, "g1", "2.0.0");
    createProjectVersion(store, "g1", "orch", "2.0.0");
    attribute(store, "g1", "f-1", "orch", "2.0.0", "2.0.0");
    attribute(store, "g1", "f-2", "orch", "2.0.0", "2.0.0");
    attribute(store, "g1", "f-3", "orch", "2.0.0", "2.0.0");

    mustOkSnapshot(store.versionLedgerMarkReleased({ ownerGroup: "g1", version: "2.0.0" }));
    const payload = releasePayloads(store).at(-1);
    assert.equal(payload?.["projectVersionsTargeted"], 1, "三笔归属 ⇒ 去重后触达集 = 1");
    assert.equal(payload?.["projectVersionsReleased"], 1, "只迁一次");
  } finally {
    store.close();
  }
});

test("O4 级联不隐式建版：归属指向不存在的 project 版本行 ⇒ 台账不补行、发版也不报错", () => {
  const store = newStore();
  try {
    createGroupVersion(store, "g1", "3.0.0");
    createProjectVersion(store, "g1", "orch", "3.0.0");
    attribute(store, "g1", "f-1", "orch", "3.0.0", "3.0.0");
    attribute(store, "g1", "f-2", "ghost", "9.9.9", "3.0.0"); // 无对应 project_versions 行

    mustOkSnapshot(store.versionLedgerMarkReleased({ ownerGroup: "g1", version: "3.0.0" }));
    assert.equal(store.projectVersionGet("g1", "ghost", "9.9.9"), null, "发版不替台账造行");
    assert.equal(store.projectVersionList("g1").length, 1, "行数不变");
    assert.equal(store.projectVersionGet("g1", "orch", "3.0.0")?.status, "released");
    assert.equal(
      releasePayloads(store).at(-1)?.["projectVersionsReleased"],
      1,
      "ghost 无行 ⇒ 迁移数只计真实存在者",
    );
  } finally {
    store.close();
  }
});

test("O4 级联按 owner_group 定值：同名版号在他组 / 匿名档互不染色", () => {
  const store = newStore();
  try {
    for (const g of ["g1", "g2"] as const) {
      createGroupVersion(store, g, "1.0.0");
      createProjectVersion(store, g, "orch", "1.0.0");
      attribute(store, g, `f-${g}`, "orch", "1.0.0", "1.0.0");
    }
    createGroupVersion(store, null, "1.0.0");
    createProjectVersion(store, null, "orch", "1.0.0");

    mustOkSnapshot(store.versionLedgerMarkReleased({ ownerGroup: "g1", version: "1.0.0" }));
    assert.equal(store.projectVersionGet("g1", "orch", "1.0.0")?.status, "released", "本组级联");
    assert.equal(store.projectVersionGet("g2", "orch", "1.0.0")?.status, "open", "他组不染色");
    assert.equal(store.projectVersionGet(null, "orch", "1.0.0")?.status, "open", "匿名档不染色");

    // 匿名档自己发版（先补归属）⇒ 只动匿名行（NULL-safe `IS` 口径）
    attribute(store, null, "f-anon", "orch", "1.0.0", "1.0.0");
    mustOkSnapshot(store.versionLedgerMarkReleased({ ownerGroup: null, version: "1.0.0" }));
    assert.equal(store.projectVersionGet(null, "orch", "1.0.0")?.status, "released", "匿名档级联");
    assert.equal(store.projectVersionGet("g2", "orch", "1.0.0")?.status, "open", "他组仍 open");
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 2：★事务原子性 —— 级联失败 ⇒ Group 状态不落（整体回滚）
// ---------------------------------------------------------------------------

test("O4 事务原子性：级联那一步失败 ⇒ Group status 不落、快照不落（不留半成品版本）", () => {
  const dbPath = tmpDbPath("cascade-rollback");
  try {
    const boot = new SessionStore(dbPath);
    createGroupVersion(boot, "g1", "1.0.0");
    createProjectVersion(boot, "g1", "orch", "1.0.0");
    attribute(boot, "g1", "f-a", "orch", "1.0.0", "1.0.0");
    boot.close();

    // 外科手术：给 project_versions 挂必失败的 AFTER UPDATE 触发器 ⇒ 事务内级联步抛错，
    // 用来证明同事务的 UPDATE versions / INSERT releases 不会单独提交（表仍在 ⇒ 走回滚路径）。
    const raw = openStoreDatabase(dbPath);
    raw.exec(
      `CREATE TRIGGER o4_fail_update_project_versions AFTER UPDATE ON project_versions
       BEGIN SELECT RAISE(ABORT, 'O4 用例：级联写入人为失败'); END`,
    );
    raw.close();

    const victim = new SessionStore(dbPath);
    assert.throws(
      () =>
        victim.versionLedgerMarkReleased({
          ownerGroup: "g1",
          version: "1.0.0",
          projects: [{ repoId: "g1/orch", ref: "orch/v1.0.0" }],
        }),
      /级联写入人为失败/,
    );
    assert.equal(victim.versionLedgerGet("g1", "1.0.0")?.status, "active", "Group 态未落");
    assert.equal(victim.releaseSnapshotGet("g1", "1.0.0"), null, "快照未落");
    assert.equal(victim.projectVersionGet("g1", "orch", "1.0.0")?.status, "open", "project 行未落");
    assert.equal(
      releasePayloads(victim).length,
      0,
      "回滚 ⇒ 发版事件一并回滚（事件与三笔写同成立 / 同不成立）",
    );
    victim.close();
  } finally {
    rmDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 3：幂等 / 冻结 / 级联照跑
// ---------------------------------------------------------------------------

test("O4 幂等冻结：触达行本就 released ⇒ 不重复迁、不改 updated_at、零新事件", () => {
  const store = newStore();
  try {
    createGroupVersion(store, "g1", "4.0.0");
    createProjectVersion(store, "g1", "orch", "4.0.0");
    attribute(store, "g1", "f-a", "orch", "4.0.0", "4.0.0");

    mustOkSnapshot(store.versionLedgerMarkReleased({ ownerGroup: "g1", version: "4.0.0" }));
    assert.equal(releasePayloads(store).length, 1, "首次发版一条事件");
    const updatedAt = store.projectVersionGet("g1", "orch", "4.0.0")?.updatedAt;

    const again = mustOkSnapshot(
      store.versionLedgerMarkReleased({
        ownerGroup: "g1",
        version: "4.0.0",
        projects: [{ projectId: "evil", repoId: "evil", ref: "evil" }],
      }),
    );
    assert.equal(again.statusMigrated, false, "Group 态不重复迁");
    assert.equal(again.snapshotWritten, false, "快照不可变 ⇒ 不覆写");
    assert.deepEqual(again.snapshot.projects, [], "快照仍是首次的缺省空数组（入参被忽略）");
    assert.equal(releasePayloads(store).length, 1, "零变更 ⇒ 零事件");
    assert.equal(
      store.projectVersionGet("g1", "orch", "4.0.0")?.updatedAt,
      updatedAt,
      "已 released 的 project 行不被再写（updated_at 不动）",
    );
  } finally {
    store.close();
  }
});

test("O4 级联照跑：Group 已 released 后仍存在的漏网 open 行 ⇒ 再标记时补级联（同事务）", () => {
  const store = newStore();
  try {
    createGroupVersion(store, "g1", "5.0.0");
    mustOkSnapshot(store.versionLedgerMarkReleased({ ownerGroup: "g1", version: "5.0.0" }));
    assert.equal(releasePayloads(store).at(-1)?.["projectVersionsTargeted"], 0, "无触达集");

    // 事后补上的归属 + project 行（ fixture 直写 store 口，绕开门）
    createProjectVersion(store, "g1", "orch", "5.0.0");
    attribute(store, "g1", "f-a", "orch", "5.0.0", "5.0.0");

    const again = mustOkSnapshot(
      store.versionLedgerMarkReleased({ ownerGroup: "g1", version: "5.0.0" }),
    );
    assert.equal(again.statusMigrated, false, "台账原本已 released");
    assert.equal(again.snapshotWritten, false, "快照已存在 ⇒ 不覆写");
    assert.equal(store.projectVersionGet("g1", "orch", "5.0.0")?.status, "released", "级联照跑");
    const payload = releasePayloads(store).at(-1);
    assert.equal(payload?.["backfilled"], true, "未迁 Group 态 ⇒ backfilled 留痕");
    assert.equal(payload?.["projectVersionsTargeted"], 1);
    assert.equal(payload?.["projectVersionsReleased"], 1, "漏网的 open 行被补迁入");
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 4：交付快照形状扩（C-5）
// ---------------------------------------------------------------------------

test("O4 快照形状：新形状 {projectId, version, repoId, ref} 落库并原样回读", () => {
  const store = newStore();
  try {
    createGroupVersion(store, "g1", "6.0.0");
    const written = mustOkSnapshot(
      store.versionLedgerMarkReleased({
        ownerGroup: "g1",
        version: "6.0.0",
        projects: [
          { projectId: "orch", version: "6.0.0", repoId: "g1/orch", ref: "orch/v6.0.0" },
          { projectId: "board", version: "0.2.0", repoId: null, ref: null },
        ],
      }),
    );
    assert.deepEqual(written.snapshot.projects, [
      { repoId: "g1/orch", ref: "orch/v6.0.0", projectId: "orch", version: "6.0.0" },
      { repoId: null, ref: null, projectId: "board", version: "0.2.0" },
    ]);
  } finally {
    store.close();
  }
});

test("O4 快照形状：旧形状行仍可读，且缺键不补 null（读写两端形状逐字一致、不回填）", () => {
  const dbPath = tmpDbPath("legacy-shape");
  try {
    const boot = new SessionStore(dbPath);
    createGroupVersion(boot, "g1", "7.0.0");
    mustOkSnapshot(
      boot.versionLedgerMarkReleased({
        ownerGroup: "g1",
        version: "7.0.0",
        projects: [{ repoId: "g1/orch", ref: "orch/v7.0.0" }], // 旧形状（写口不带新键）
      }),
    );
    // 不经写口，用裸库句柄造一条历史旧形状行（写口本身不产这种形状，读口须照旧可读）
    boot.close();
    const raw = openStoreDatabase(dbPath);
    raw.exec(
      `INSERT INTO releases (owner_group, version, projects_json, created_at)
       VALUES ('g1', '7.1.0', '[{"repoId":"legacy","ref":"legacy-ref"}]', '2026-01-01T00:00:00.000Z')`,
    );
    raw.close();

    const store = new SessionStore(dbPath);
    for (const version of ["7.0.0", "7.1.0"]) {
      const projects = store.releaseSnapshotGet("g1", version)?.projects ?? [];
      assert.equal(projects.length, 1, `${version} 旧形状可读`);
      assert.deepEqual(Object.keys(projects[0] ?? {}).sort(), ["ref", "repoId"], `${version} 形状`);
      assert.equal("projectId" in (projects[0] ?? {}), false, `${version} 缺键不补 null`);
    }
    store.close();
  } finally {
    rmDb(dbPath);
  }
});

test("O4 边界校验：新键脏类型 ⇒ orch_release_projects_invalid 且零写入（校验在进事务前）", () => {
  const dbPath = tmpDbPath("shape");
  try {
    const boot = new SessionStore(dbPath);
    createGroupVersion(boot, "g1", "1.0.0");
    const featureId = createCompletedFeature(boot, "g1", "f-1", "1.0.0");
    createProjectVersion(boot, "g1", "orch", "1.0.0");
    attribute(boot, "g1", featureId, "orch", "1.0.0", "1.0.0");
    boot.close();
    reopenDefault(dbPath);

    for (const bad of [
      [{ projectId: 42, repoId: "g1/orch", ref: "r" }],
      [{ version: {}, repoId: "g1/orch", ref: "r" }],
      [{ projectId: null, version: null, repoId: 1, ref: "r" }],
      "not-an-array",
      [{ repoId: "ok" }, null],
    ]) {
      const outcome = markVersionReleased({ ownerGroup: "g1", version: "1.0.0", projects: bad });
      if (outcome.ok) throw new Error(`入参 ${JSON.stringify(bad)} 应被形状校验挡`);
      assert.equal(outcome.code, ERR_RELEASE_PROJECTS, `入参 ${JSON.stringify(bad)} 应挡为形状码`);
      assert.equal(outcome.status, 400);
    }
    assert.equal(versionLedgerGet("g1", "1.0.0")?.status, "active", "形状不过 ⇒ Group 态不落");
    assert.equal(releaseSnapshotList("g1").length, 0, "形状不过 ⇒ 快照不落");
    assert.equal(projectVersionGet("g1", "orch", "1.0.0")?.status, "open", "形状不过 ⇒ 不级联");

    // 合法新形状 ⇒ 过闸、落快照、同事务级联
    const ok = markVersionReleased({
      ownerGroup: "g1",
      version: "1.0.0",
      projects: [{ projectId: "orch", version: "1.0.0", repoId: "g1/orch", ref: "orch/v1.0.0" }],
    });
    if (!ok.ok) throw new Error(`合法新形状应放行：${ok.code} ${ok.message}`);
    assert.deepEqual(ok.snapshot.projects, [
      { repoId: "g1/orch", ref: "orch/v1.0.0", projectId: "orch", version: "1.0.0" },
    ]);
    assert.equal(projectVersionGet("g1", "orch", "1.0.0")?.status, "released", "级联成立");

    // 旧形状照旧合法（既有键语义不收紧）+ 混合形状
    const legacy = markVersionReleased({
      ownerGroup: "g1",
      version: "1.0.0",
      projects: [{ repoId: "g1/orch", ref: "orch/v1.0.0" }],
    });
    if (!legacy.ok) throw new Error(`旧形状应继续合法：${legacy.code} ${legacy.message}`);
  } finally {
    close();
    resetToMemory();
    rmDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 5：O4 边界钉 —— Group 闸不放宽 / released 锁仍拦新增 / 协议常量不升
// ---------------------------------------------------------------------------

test("O4 边界：Group 发版闸判据未放宽（名下有未收口卡 ⇒ 挡、零写入、不级联）", () => {
  const dbPath = tmpDbPath("gate");
  try {
    const boot = new SessionStore(dbPath);
    createGroupVersion(boot, "g1", "1.0.0");
    const done = createCompletedFeature(boot, "g1", "f-done", "1.0.0");
    boot.createFeature({
      featureId: "f-open",
      title: "仍在跑",
      ownerGroup: "g1",
      version: "1.0.0",
    });
    createProjectVersion(boot, "g1", "orch", "1.0.0");
    attribute(boot, "g1", done, "orch", "1.0.0", "1.0.0");
    boot.close();
    reopenDefault(dbPath);

    const outcome = markVersionReleased({ ownerGroup: "g1", version: "1.0.0" });
    if (outcome.ok) throw new Error("未收口应挡闸");
    assert.equal(outcome.status, 409, "闸不过 ⇒ 冲突，不是 404");
    assert.equal(versionLedgerGet("g1", "1.0.0")?.status, "active", "Group 态不落");
    assert.equal(projectVersionGet("g1", "orch", "1.0.0")?.status, "open", "闸不过 ⇒ 不级联");
  } finally {
    close();
    resetToMemory();
    rmDb(dbPath);
  }
});

test("O4 边界：级联后该 Group 版已 released ⇒ orch_version_released_locked 仍拦新增排期", () => {
  const dbPath = tmpDbPath("lock");
  try {
    const boot = new SessionStore(dbPath);
    createGroupVersion(boot, "g1", "1.0.0");
    const featureId = createCompletedFeature(boot, "g1", "f-1", "1.0.0");
    createProjectVersion(boot, "g1", "orch", "1.0.0");
    attribute(boot, "g1", featureId, "orch", "1.0.0", "1.0.0");
    boot.close();
    reopenDefault(dbPath);

    const released = versionLedgerMarkReleased({ ownerGroup: "g1", version: "1.0.0" });
    if (!released.ok) throw new Error(`发版应放行：${released.code} ${released.message}`);
    assert.equal(released.ledger.status, "released");
    assert.equal(projectVersionGet("g1", "orch", "1.0.0")?.status, "released", "级联结果稳定");

    const fail = mustFailTool(
      handleFeatureCreate(
        { title: "想排进已发版", stage: "需求分析", approval: "未发起", version: "1.0.0" },
        "g1",
      ),
    );
    assert.equal(fail.code, "orch_version_released_locked", "released 锁不因级联改动而放宽");
  } finally {
    close();
    resetToMemory();
    rmDb(dbPath);
  }
});

test("O4 协议常量：新增可选键不升协议版本（PROTOCOL_VERSION 仍 2.3）", () => {
  assert.equal(PROTOCOL_VERSION, "2.3", "快照 projects[] 形状扩只加可选键 ⇒ 协议版不动");
});
