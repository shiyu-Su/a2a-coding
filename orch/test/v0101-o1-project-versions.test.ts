/**
 * v0.10.1 **O1**（REQ-2026-10-09-01 · 改造文档 §2.2 / §3 orch 段 / §5 T1）——
 * 版本面第二级的两张新表 + project 档 store 读写口。
 *
 * 锁定的行为面：
 * 1. **两表落地**（验收 ①）：`project_versions`（project 台账，两态 `open`/`released`、缺省 `open`）
 *    与 `feature_projects`（归属 / 承诺集）由 ctor `IF NOT EXISTS` 建起；`PRAGMA table_info` 可见
 *    列面 / PK 序 / NOT NULL / 默认态；归属表**无 `status`**（态归台账，两表分工）；
 *    **无第三表**（级联档下交付事实由 Group `releases` 承载，C-4 / C-5）；Group 面两表未被触碰；
 * 2. **NULL-safe 口径（硬要求）**：两表 PK 均含可空列 `owner_group`，而 SQLite 唯一约束视 NULL
 *    互相不等 ⇒ 判重必须走 `IS` 自查 ⇒ **匿名档重复必须被挡、不得插出第二行**；
 * 3. **读写口**（验收 ②）：建版 → 取 → 列；空身份 / 非法 shape ⇒ 400 零写入 · 同键重复 ⇒ 409
 *    且不产生第二行、不改第一行 · 删版未知 ⇒ 404；
 * 4. **归属两方向可查**（验收 ③）：`(owner_group, group_version, project_id)`（C-2 继承判据）
 *    与 `feature_id`（C-19 feature 侧只读面）；写口三档 = 新行 / 同键改写（可改须留痕）/
 *    **同值幂等重发**（`created=false` ∧ `changed=false` ⇒ 零写入、不改 `updated_at`，C-3 ★R3）；
 * 5. **归属是长期事实源**（验收 ④，K-1 / C-16）：**不进 `pruneTasks`**、**不随 Feature 终态 /
 *    `cancel` 级联删**、删 project 版本也不级联删归属；
 * 6. **O1 边界钉**：本层是**纯数据面** —— 不校验「目标 project 版本行已存在」（C-15）、不判
 *    released 冻结（C-6 ③④）、不看是否过门（C-3）⇒ 这些门 / 闸由后续节点在本口之上执法。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  close,
  ERR_PROJECT_VERSION_EXISTS,
  ERR_PROJECT_VERSION_SHAPE,
  ERR_PROJECT_VERSION_UNKNOWN,
  featureProjectDelete,
  featureProjectListByFeature,
  featureProjectListByVersion,
  featureProjectUpsert,
  openStoreDatabase,
  projectVersionCreate,
  projectVersionGet,
  projectVersionList,
  SessionStore,
} from "../session/store.js";
import type {
  FeatureProjectUpsertInput,
  FeatureProjectUpsertResult,
  ProjectVersionWriteResult,
} from "../session/store.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

after(() => {
  for (const path of tmpDirs) rmSync(path, { recursive: true, force: true });
  process.env["SESSION_DB"] = ":memory:";
  close();
});

function newStore(): SessionStore {
  return new SessionStore(":memory:");
}

function tmpDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `a2a-v0101-o1-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

/** 建在临时文件上的 store（便于另开只读句柄做 schema / 原始行数断言） */
function fileStore(tag: string): { store: SessionStore; dbPath: string } {
  const dbPath = join(tmpDir(tag), "sessions.sqlite");
  return { store: new SessionStore(dbPath), dbPath };
}

interface Col {
  name: string;
  notnull: number;
  pk: number;
  dflt: string | null;
}

function tableInfo(dbPath: string, table: string): Col[] {
  const db = openStoreDatabase(dbPath);
  try {
    return (db.prepare("SELECT * FROM pragma_table_info(?)").all(table) as Array<
      Record<string, unknown>
    >).map((r) => ({
      name: String(r["name"]),
      notnull: Number(r["notnull"]),
      pk: Number(r["pk"]),
      dflt: r["dflt_value"] === null || r["dflt_value"] === undefined ? null : String(r["dflt_value"]),
    }));
  } finally {
    db.close();
  }
}

function colOf(cols: Col[], name: string): Col {
  const found = cols.find((c) => c.name === name);
  assert.ok(found !== undefined, `缺列 ${name}`);
  return found;
}

function hasTable(dbPath: string, table: string): boolean {
  const db = openStoreDatabase(dbPath);
  try {
    return (
      db
        .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
        .get(table) !== undefined
    );
  } finally {
    db.close();
  }
}

/** 显式索引名（PK 的 autoindex 也出现在 sqlite_master，但不算「本节点另建的索引」） */
function indexNames(dbPath: string, table: string): string[] {
  const db = openStoreDatabase(dbPath);
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all(table)
      .map((r) => String((r as Record<string, unknown>)["name"]))
      .filter((name) => name.startsWith("idx_"));
  } finally {
    db.close();
  }
}

/** 原始行数（绕开读口，直接钉「不产生第二行」） */
function rowCount(dbPath: string, sql: string, ...params: unknown[]): number {
  const db = openStoreDatabase(dbPath);
  try {
    const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
    return Number(row?.["n"] ?? 0);
  } finally {
    db.close();
  }
}

/**
 * 同步小睡 —— `nowIso()` 是毫秒精度 ⇒ 同一毫秒内的两次写会落出**同一个** `updated_at`，
 * 「改行推进 / 重发不改」两条断言必须先拉开时钟，否则测的是运气不是行为。
 */
function nap(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

type Ok<T> = Extract<T, { ok: true }>;
type Fail<T> = Extract<T, { ok: false }>;

function mustOk<T extends { ok: boolean }>(outcome: T): Ok<T> {
  if (!outcome.ok) throw new Error(`期望写成功，实际被拒：${JSON.stringify(outcome)}`);
  return outcome as unknown as Ok<T>;
}

function mustFail<T extends { ok: boolean }>(outcome: T): Fail<T> {
  if (outcome.ok) throw new Error("期望写被拒，实际成功");
  return outcome as unknown as Fail<T>;
}

function createVersion(
  store: SessionStore,
  input: { ownerGroup: string | null; projectId: string; version: string; note?: string | null },
): void {
  mustOk<ProjectVersionWriteResult>(store.projectVersionCreate(input));
}

function upsert(
  store: SessionStore,
  input: {
    ownerGroup: string | null;
    featureId: string;
    projectId: string;
    projectVersion: string;
    groupVersion: string;
    source?: string | null;
  },
): Ok<FeatureProjectUpsertResult> {
  return mustOk<FeatureProjectUpsertResult>(store.featureProjectUpsert(input));
}

// ---------------------------------------------------------------------------
// 1：两张新表落地（验收判据 ①）
// ---------------------------------------------------------------------------

test("O1 两表：ctor 建起 project_versions / feature_projects；不建 project 级独立快照表；Group 面两表未动", () => {
  const { store, dbPath } = fileStore("tables");
  store.close();

  for (const need of ["project_versions", "feature_projects"]) {
    assert.ok(hasTable(dbPath, need), `${need} 须由 ctor 建起`);
  }
  assert.ok(!hasTable(dbPath, "project_releases"), "★撤销第三表：不得有 project 级独立交付快照表");
  for (const keep of ["versions", "releases"]) {
    assert.ok(hasTable(dbPath, keep), `组档 ${keep} 表不得被动过（C-1 不动 Group 面）`);
  }
});

test("O1 project_versions 列面：PK = (owner_group, project_id, version)；status 缺省 open；无 feature_id", () => {
  const { store, dbPath } = fileStore("pv-cols");
  store.close();

  const cols = tableInfo(dbPath, "project_versions");
  for (const need of [
    "owner_group",
    "project_id",
    "version",
    "status",
    "date",
    "note",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(cols.some((c) => c.name === need), `project_versions 缺列 ${need}`);
  }
  assert.equal(colOf(cols, "owner_group").notnull, 0, "owner_group 必可空（NULL = 未配组的匿名档）");
  assert.equal(colOf(cols, "owner_group").pk, 1, "PK 首列 = owner_group");
  assert.equal(colOf(cols, "project_id").pk, 2, "PK 次列 = project_id");
  assert.equal(colOf(cols, "version").pk, 3, "PK 末列 = version");
  assert.equal(colOf(cols, "project_id").notnull, 1, "project_id 是身份键 ⇒ NOT NULL");
  assert.equal(colOf(cols, "version").notnull, 1, "version 是身份键 ⇒ NOT NULL");
  assert.equal(
    colOf(cols, "status").dflt,
    "'open'",
    "建版缺省态 = open（released 只由 Group 级发版同事务级联置入）",
  );
  assert.equal(colOf(cols, "created_at").notnull, 1);
  assert.equal(colOf(cols, "updated_at").notnull, 1, "project 台账可编辑 ⇒ 有 updated_at");
  assert.ok(
    !cols.some((c) => c.name === "feature_id"),
    "project 台账不得带 feature_id（归属另成表）",
  );
});

test("O1 feature_projects 列面：PK = (owner_group, feature_id, project_id)；含 project_version/group_version/source；无 status", () => {
  const { store, dbPath } = fileStore("fp-cols");
  store.close();

  const cols = tableInfo(dbPath, "feature_projects");
  for (const need of [
    "owner_group",
    "feature_id",
    "project_id",
    "project_version",
    "group_version",
    "source",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(cols.some((c) => c.name === need), `feature_projects 缺列 ${need}`);
  }
  assert.equal(colOf(cols, "owner_group").notnull, 0, "owner_group 必可空（匿名档同 project 台账口径）");
  assert.equal(colOf(cols, "owner_group").pk, 1);
  assert.equal(colOf(cols, "feature_id").pk, 2, "PK 次列 = feature_id");
  assert.equal(colOf(cols, "project_id").pk, 3, "PK 末列 = project_id");
  assert.equal(colOf(cols, "project_version").notnull, 1, "归属必须指向一个 Project Version");
  assert.equal(
    colOf(cols, "group_version").notnull,
    1,
    "C-21「无 Group Version ⇒ 无归属记录」的 schema 表达 ⇒ NOT NULL",
  );
  assert.equal(colOf(cols, "source").notnull, 0, "source = 留痕用自由文本，可空");
  assert.ok(
    !cols.some((c) => c.name === "status"),
    "态归 project 台账，归属行不重复承载（两表分工，照 releases 无 status 的先例）",
  );
});

test("O1 索引：归属表两个非 PK 前缀的查询方向各有索引；project 台账不另建索引；二次启动幂等", () => {
  const first = fileStore("indexes");
  first.store.close();

  const fpIndexes = indexNames(first.dbPath, "feature_projects");
  assert.ok(
    fpIndexes.includes("idx_feature_projects_group_version"),
    "继承判据读口 (owner_group, group_version, project_id) 需要索引",
  );
  assert.ok(
    fpIndexes.includes("idx_feature_projects_feature"),
    "按 feature_id 列归属需要索引（PK 首列是 owner_group ⇒ 用不上 autoindex）",
  );
  assert.deepEqual(
    indexNames(first.dbPath, "project_versions"),
    [],
    "project 台账单行走全 PK、列表走 owner_group 前缀 ⇒ 额外索引是纯写放大",
  );

  const reopened = new SessionStore(first.dbPath); // 二次启动 ⇒ IF NOT EXISTS 幂等
  reopened.close();
});

// ---------------------------------------------------------------------------
// 2：建版 → 取 → 列 + NULL-safe 判重（验收判据 ②）
// ---------------------------------------------------------------------------

test("建版 → 取 → 列：缺省 status = open · 两戳同刻 · 写口 trim", () => {
  const store = newStore();
  try {
    const plain = mustOk<ProjectVersionWriteResult>(
      store.projectVersionCreate({ ownerGroup: "g1", projectId: "orch", version: "0.10.1" }),
    );
    assert.equal(plain.record.status, "open", "建版缺省态 = open");
    assert.equal(plain.record.createdAt, plain.record.updatedAt, "建行两戳同刻");
    assert.deepEqual(
      store.projectVersionGet("g1", "orch", "0.10.1"),
      plain.record,
      "取回须与建版出参逐字一致",
    );

    const trimmed = mustOk<ProjectVersionWriteResult>(
      store.projectVersionCreate({ ownerGroup: "g1", projectId: "  board  ", version: "  v1.2.3  " }),
    );
    assert.equal(trimmed.record.projectId, "board", "写口 trim project_id");
    assert.equal(trimmed.record.version, "v1.2.3", "写口 trim version");

    assert.equal(store.projectVersionList("g1").length, 2, "列读回本次建的两行");
    assert.equal(store.projectVersionGet("g1", "orch", "9.9.9"), null, "未建过的键 ⇒ null（不得抛）");
  } finally {
    store.close();
  }
});

test("建版判据：空 project_id / 空 version / 非法 shape ⇒ 400 且零写入（不落 SQLite 裸错）", () => {
  const store = newStore();
  try {
    const blankProject = mustFail<ProjectVersionWriteResult>(
      store.projectVersionCreate({ ownerGroup: "g1", projectId: "   ", version: "1.0.0" }),
    );
    assert.equal(blankProject.code, ERR_PROJECT_VERSION_SHAPE);
    assert.equal(blankProject.status, 400);

    const blankVersion = mustFail<ProjectVersionWriteResult>(
      store.projectVersionCreate({ ownerGroup: "g1", projectId: "orch", version: "  " }),
    );
    assert.equal(blankVersion.code, ERR_PROJECT_VERSION_SHAPE);
    assert.equal(blankVersion.status, 400);

    for (const bad of ["foo", "1.2", "0.10.1.1", "v1", "1.0"]) {
      const fail = mustFail<ProjectVersionWriteResult>(
        store.projectVersionCreate({ ownerGroup: "g1", projectId: "orch", version: bad }),
      );
      assert.equal(
        fail.code,
        ERR_PROJECT_VERSION_SHAPE,
        `脏版号 ${JSON.stringify(bad)} 应命中 shape 码`,
      );
      assert.equal(fail.status, 400);
    }
    assert.equal(store.projectVersionList("g1").length, 0, "被拒 ⇒ 零写入");
  } finally {
    store.close();
  }
});

test("建版幂等：同键重复建 ⇒ 409 且不产生第二行、不改第一行任何列", () => {
  const { store, dbPath } = fileStore("pv-dup");
  try {
    createVersion(store, {
      ownerGroup: "g1",
      projectId: "orch",
      version: "1.0.0",
      note: "原始备注",
    });
    const dup = mustFail<ProjectVersionWriteResult>(
      store.projectVersionCreate({
        ownerGroup: "g1",
        projectId: "orch",
        version: "1.0.0",
        note: "改了",
      }),
    );
    assert.equal(dup.code, ERR_PROJECT_VERSION_EXISTS);
    assert.equal(dup.status, 409);
    assert.equal(
      rowCount(dbPath, "SELECT COUNT(*) AS n FROM project_versions"),
      1,
      "重复建版不得产生第二行",
    );
    assert.equal(
      store.projectVersionGet("g1", "orch", "1.0.0")?.note,
      "原始备注",
      "重复建版不得改写第一行",
    );
  } finally {
    store.close();
  }
});

test("NULL-safe 硬要求：owner_group = NULL（未配组档）重复建 ⇒ 被挡且不产生重复行（禁 ON CONFLICT）", () => {
  const { store, dbPath } = fileStore("pv-null");
  try {
    createVersion(store, { ownerGroup: null, projectId: "orch", version: "1.0.0" });
    const dup = mustFail<ProjectVersionWriteResult>(
      store.projectVersionCreate({ ownerGroup: null, projectId: "orch", version: "1.0.0" }),
    );
    assert.equal(dup.code, ERR_PROJECT_VERSION_EXISTS);
    assert.equal(
      rowCount(dbPath, "SELECT COUNT(*) AS n FROM project_versions WHERE owner_group IS NULL"),
      1,
      "SQLite 唯一约束视 NULL 互相不等 ⇒ 判重必须走 IS 自查，匿名档不得插出第二行",
    );
    assert.notEqual(store.projectVersionGet(null, "orch", "1.0.0"), null, "匿名档可按 IS 定位读回");
    assert.equal(store.projectVersionGet("g1", "orch", "1.0.0"), null, "匿名档 ≠ 具名档");
  } finally {
    store.close();
  }
});

test("键独立性：同名 project 版号跨 project / 跨 owner_group 互不串味", () => {
  const store = newStore();
  try {
    createVersion(store, { ownerGroup: "g1", projectId: "orch", version: "1.0.0" });
    createVersion(store, { ownerGroup: "g1", projectId: "board", version: "1.0.0" });
    createVersion(store, { ownerGroup: "g2", projectId: "orch", version: "1.0.0" });
    assert.equal(store.projectVersionList().length, 3, "三行各自成立");
    assert.equal(store.projectVersionList("g1").length, 2);
    assert.equal(store.projectVersionList("g2").length, 1);
    assert.equal(store.projectVersionGet("g2", "board", "1.0.0"), null, "跨组不得读到别组的行");
  } finally {
    store.close();
  }
});

test("列表读三档过滤 + 排序只由键决定（undefined 全表 / 组名本组 / null 仅匿名档）", () => {
  const store = newStore();
  try {
    createVersion(store, { ownerGroup: null, projectId: "zeta", version: "1.0.0" });
    createVersion(store, { ownerGroup: "g1", projectId: "orch", version: "0.10.1" });
    createVersion(store, { ownerGroup: "g1", projectId: "orch", version: "0.9.0" });
    createVersion(store, { ownerGroup: "g1", projectId: "board", version: "1.0.0" });

    assert.equal(
      store.projectVersionList().length,
      4,
      "undefined ⇒ 全表（未配组入口 / 3300 运维视图）",
    );
    assert.equal(store.projectVersionList(null).length, 1, "null ⇒ 仅匿名档");
    assert.equal(store.projectVersionList("g1").length, 3);
    assert.deepEqual(
      store.projectVersionList("g1").map((r) => `${r.projectId}@${r.version}`),
      ["board@1.0.0", "orch@0.10.1", "orch@0.9.0"],
      "排序 = (owner_group, project_id, version) 字典序，与写入序 / updatedAt 无关",
    );
  } finally {
    store.close();
  }
});

test("删版：未知键 ⇒ 404 · 成功 ⇒ 只删台账行、不级联删归属（C-16）", () => {
  const store = newStore();
  try {
    const missing = mustFail<ProjectVersionWriteResult>(
      store.projectVersionDelete("g1", "orch", "1.0.0"),
    );
    assert.equal(missing.code, ERR_PROJECT_VERSION_UNKNOWN);
    assert.equal(missing.status, 404);

    createVersion(store, { ownerGroup: "g1", projectId: "orch", version: "1.0.0" });
    upsert(store, {
      ownerGroup: "g1",
      featureId: "f-1",
      projectId: "orch",
      projectVersion: "1.0.0",
      groupVersion: "0.10.1",
    });
    mustOk<ProjectVersionWriteResult>(store.projectVersionDelete("g1", "orch", "1.0.0"));
    assert.equal(store.projectVersionGet("g1", "orch", "1.0.0"), null);
    assert.equal(
      store.featureProjectListByFeature("f-1").length,
      1,
      "删 project 版本不得级联删归属行（承诺集是独立长期事实源）",
    );
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 3：归属两个方向可查 + 写口三档（验收判据 ③）
// ---------------------------------------------------------------------------

test("归属两个查询方向：按 (owner_group, group_version, project_id) 与按 feature_id 均可读回", () => {
  const store = newStore();
  try {
    const base = { ownerGroup: "g1", projectId: "orch", groupVersion: "0.10.1" };
    upsert(store, { ...base, featureId: "f-a", projectVersion: "0.10.1", source: "过门初版" });
    upsert(store, { ...base, featureId: "f-b", projectVersion: "0.10.1", source: "执行期增量" });
    upsert(store, {
      ownerGroup: "g1",
      featureId: "f-a",
      projectId: "board",
      projectVersion: "0.3.0",
      groupVersion: "0.10.1",
    });
    // 另一 Group Version 名下同 project：不得混进继承判据读口
    upsert(store, { ...base, featureId: "f-c", projectVersion: "0.9.0", groupVersion: "0.9.8" });

    const byCombo = store.featureProjectListByVersion("g1", "0.10.1", "orch");
    assert.deepEqual(
      byCombo.map((r) => r.featureId),
      ["f-a", "f-b"],
      "C-2 继承判据：该组合名下已有承诺（多行 = 归并语义，实测常态）",
    );
    assert.ok(
      byCombo.every((r) => r.projectVersion === "0.10.1"),
      "同一 (Group Version, Project) 名下 Project Version 一致",
    );
    assert.equal(byCombo[0]?.source, "过门初版", "source 原样读回（引擎不解析）");
    assert.deepEqual(
      store.featureProjectListByFeature("f-a").map((r) => r.projectId),
      ["board", "orch"],
      "按需求列归属 = project_id 字典序（集合可比对）",
    );
    assert.equal(store.featureProjectListByVersion("g1", "0.10.1", "nope").length, 0);
    assert.equal(store.featureProjectListByFeature("f-unknown").length, 0);
  } finally {
    store.close();
  }
});

test("归属 NULL-safe 硬要求：匿名档同键重发不产生第二行；跨 owner_group 同键互不覆盖", () => {
  const { store, dbPath } = fileStore("fp-null");
  try {
    const key = {
      featureId: "f-1",
      projectId: "orch",
      projectVersion: "1.0.0",
      groupVersion: "0.10.1",
    };
    assert.equal(upsert(store, { ownerGroup: null, ...key }).created, true);
    const again = upsert(store, { ownerGroup: null, ...key });
    assert.deepEqual(
      { created: again.created, changed: again.changed },
      { created: false, changed: false },
      "匿名档同值重发须命中既有行（判重走 IS ⇒ 不得插第二行）",
    );
    assert.equal(
      rowCount(dbPath, "SELECT COUNT(*) AS n FROM feature_projects WHERE owner_group IS NULL"),
      1,
      "匿名档重复不得产生第二行",
    );

    upsert(store, { ownerGroup: "g1", ...key });
    assert.equal(
      rowCount(dbPath, "SELECT COUNT(*) AS n FROM feature_projects"),
      2,
      "同 (feature_id, project_id) 在不同 owner_group 下各一行（PK 含 owner_group）",
    );
    assert.equal(store.featureProjectListByFeature("f-1").length, 2);
  } finally {
    store.close();
  }
});

test("归属同值幂等重发：零写入 ⇒ updated_at 不变（全量重发不制造活动痕迹，C-3 ★R3）", () => {
  const store = newStore();
  const input: FeatureProjectUpsertInput = {
    ownerGroup: "g1",
    featureId: "f-1",
    projectId: "orch",
    projectVersion: "1.0.0",
    groupVersion: "0.10.1",
    source: "过门初版",
  };
  try {
    const first = upsert(store, input);
    nap();
    const second = upsert(store, input);
    assert.equal(second.created, false);
    assert.equal(second.changed, false);
    assert.deepEqual(second.record, first.record, "同值重发读回的行与原行逐字一致（零写入）");
    assert.equal(second.record.updatedAt, first.record.updatedAt, "同值重发不得推进 updated_at");
    assert.equal(store.featureProjectListByFeature("f-1").length, 1);
  } finally {
    store.close();
  }
});

test("归属改写（承诺集可改须留痕）：created=false · changed=true · created_at 保首值 · updated_at 推进", () => {
  const store = newStore();
  try {
    const first = upsert(store, {
      ownerGroup: "g1",
      featureId: "f-1",
      projectId: "orch",
      projectVersion: "1.0.0",
      groupVersion: "0.10.1",
      source: "过门初版",
    });
    nap();
    const moved = upsert(store, {
      ownerGroup: "g1",
      featureId: "f-1",
      projectId: "orch",
      projectVersion: "1.1.0",
      groupVersion: "0.10.1",
      source: "执行期改口",
    });
    assert.equal(moved.created, false);
    assert.equal(moved.changed, true);
    assert.equal(moved.record.projectVersion, "1.1.0");
    assert.equal(moved.record.source, "执行期改口");
    assert.equal(moved.record.createdAt, first.record.createdAt, "改行保留首次落库时刻");
    assert.ok(
      moved.record.updatedAt > first.record.updatedAt,
      `改行须推进 updated_at（前 ${first.record.updatedAt} / 后 ${moved.record.updatedAt}）`,
    );
    assert.equal(store.featureProjectListByFeature("f-1").length, 1, "改行仍是同一行");
  } finally {
    store.close();
  }
});

test("归属入参判据：四个身份列任一为空串 ⇒ 400 且零写入", () => {
  const store = newStore();
  const valid: FeatureProjectUpsertInput = {
    ownerGroup: "g1",
    featureId: "f-1",
    projectId: "orch",
    projectVersion: "1.0.0",
    groupVersion: "0.10.1",
  };
  try {
    for (const key of ["featureId", "projectId", "projectVersion", "groupVersion"] as const) {
      const fail = mustFail<FeatureProjectUpsertResult>(
        store.featureProjectUpsert({ ...valid, [key]: "  " }),
      );
      assert.equal(fail.code, ERR_PROJECT_VERSION_SHAPE, `${key} 空串应命中形状码`);
      assert.equal(fail.status, 400);
    }
    assert.equal(store.featureProjectListByFeature("f-1").length, 0, "被拒 ⇒ 零写入");
  } finally {
    store.close();
  }
});

test("归属删除：存在 ⇒ 删一行并回原值；不存在 ⇒ 幂等零副作用（全量重发的差量删除路径）", () => {
  const store = newStore();
  try {
    upsert(store, {
      ownerGroup: "g1",
      featureId: "f-1",
      projectId: "orch",
      projectVersion: "1.0.0",
      groupVersion: "0.10.1",
      source: "过门初版",
    });
    const gone = store.featureProjectDelete("g1", "f-1", "orch");
    assert.equal(gone.deleted, true);
    assert.equal(gone.record?.projectVersion, "1.0.0", "回删掉的行原值，供留痕 / 回执");
    assert.equal(store.featureProjectListByFeature("f-1").length, 0);

    const again = store.featureProjectDelete("g1", "f-1", "orch");
    assert.deepEqual(
      { deleted: again.deleted, record: again.record },
      { deleted: false, record: null },
      "删到不存在的行不是错误（重发安全）",
    );

    // 匿名档按键定位同样走 IS
    upsert(store, {
      ownerGroup: null,
      featureId: "f-2",
      projectId: "orch",
      projectVersion: "1.0.0",
      groupVersion: "0.10.1",
    });
    assert.equal(store.featureProjectDelete(null, "f-2", "orch").deleted, true);
    assert.equal(
      featureProjectDelete("g1", "f-2", "orch").deleted,
      false,
      "匿名档行不得被具名档删到",
    );
  } finally {
    store.close();
  }
});

test("O1 边界钉：归属写口是纯数据面 —— 不校验版本行存在、不判 released、不看是否过门（执法归后续节点）", () => {
  const store = newStore();
  try {
    // 目标 Project Version 从未建过（C-15 的 orch_project_version_unknown 属 T2 执法面）
    const orphan = upsert(store, {
      ownerGroup: "g1",
      featureId: "f-1",
      projectId: "orch",
      projectVersion: "9.9.9",
      groupVersion: "0.10.1",
    });
    assert.equal(orphan.created, true, "本层不挡「指向不存在的 project 版本」");
    // 无 Feature 实体亦可写（approval 门判据在 handler / T2）
    assert.equal(store.featureProjectListByVersion("g1", "0.10.1", "orch").length, 1);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 4：归属是长期事实源（验收判据 ④）
// ---------------------------------------------------------------------------

test("归属不进 prune：已收口 Feature 的 task 被清，归属行与 project 台账行原样留存（K-1 / C-16）", () => {
  const store = newStore();
  try {
    store.createFeature({
      featureId: "f-done",
      title: "已收口需求",
      ownerGroup: "g1",
      version: "0.10.1",
      state: "completed",
    });
    for (const projectId of ["orch", "board"]) {
      store.createTask({
        taskId: `t-${projectId}`,
        projectId,
        contextId: `c-${projectId}`,
        state: "completed",
        featureId: "f-done",
      });
    }
    createVersion(store, { ownerGroup: "g1", projectId: "orch", version: "0.10.1" });
    upsert(store, {
      ownerGroup: "g1",
      featureId: "f-done",
      projectId: "orch",
      projectVersion: "0.10.1",
      groupVersion: "0.10.1",
    });

    // 负向对照：prune 确实删掉了 task（否则本用例是假绿）
    const pruned = store.pruneTasks({ retentionDays: -1 });
    assert.ok(pruned >= 1, `前置：task 须真的被 pruneTasks 删掉（实际删 ${pruned} 条）`);

    assert.equal(
      store.featureProjectListByFeature("f-done").length,
      1,
      "归属行不得随 pruneTasks 消失（K-1：tasks 会过期，承诺集不会）",
    );
    assert.notEqual(store.projectVersionGet("g1", "orch", "0.10.1"), null);
    assert.equal(store.featureProjectListByVersion("g1", "0.10.1", "orch").length, 1);
  } finally {
    store.close();
  }
});

test("归属不随 Feature 终态 / cancel 级联删（C-16）", () => {
  const store = newStore();
  try {
    for (const featureId of ["f-live", "f-cancel"]) {
      store.createFeature({
        featureId,
        title: featureId,
        ownerGroup: "g1",
        version: "0.10.1",
        state: "executing",
      });
      upsert(store, {
        ownerGroup: "g1",
        featureId,
        projectId: "orch",
        projectVersion: "0.10.1",
        groupVersion: "0.10.1",
      });
    }
    store.updateFeatureState("f-live", "completed");
    store.updateFeatureState("f-cancel", "cancelled");

    assert.equal(
      store.featureProjectListByVersion("g1", "0.10.1", "orch").length,
      2,
      "Feature 进终态 / cancel 均不级联删归属行",
    );
    assert.equal(store.featureProjectListByFeature("f-cancel").length, 1, "cancelled 名下归属仍在");
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 5：默认存储包装函数与类方法同源（端点 / 3300 读面经模块级函数取投影）
// ---------------------------------------------------------------------------

test("模块级默认存储包装函数可用且与类方法同读一面", () => {
  mustOk<ProjectVersionWriteResult>(
    projectVersionCreate({ ownerGroup: "g1", projectId: "orch", version: "0.10.1" }),
  );
  assert.notEqual(projectVersionGet("g1", "orch", "0.10.1"), null);
  assert.ok(
    projectVersionList("g1").some((r) => r.projectId === "orch" && r.version === "0.10.1"),
    "列表读口经默认存储同样可读",
  );

  mustOk<FeatureProjectUpsertResult>(
    featureProjectUpsert({
      ownerGroup: "g1",
      featureId: "f-wrap",
      projectId: "orch",
      projectVersion: "0.10.1",
      groupVersion: "0.10.1",
    }),
  );
  assert.equal(featureProjectListByFeature("f-wrap").length, 1);
  assert.equal(featureProjectListByVersion("g1", "0.10.1", "orch").length, 1);
  assert.equal(featureProjectDelete("g1", "f-wrap", "orch").deleted, true);
});
