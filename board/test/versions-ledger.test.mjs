import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  VERSIONS_LEDGER_VERSION,
  VERSION_STATUSES,
  defaultVersionsLedgerFile,
  defaultVersionsSentinelFile,
  emptyVersionsLedger,
  parseVersionRecord,
  parseVersionsLedger,
  serializeVersionsLedger,
  findVersionRecord,
  releasedVersionNames,
  releasedVersionLabels,
  isVersionReleased,
  createVersion,
  removeVersion,
  setVersionStatus,
  migrateReleasedVersions,
  migrateLedgerOrgs,
  exportVersionsLedger,
  serializeVersionsExport,
  VERSIONS_EXPORT_SCHEMA,
  VersionsLedgerStore,
} from "../dist/versions-ledger.js";

const NOW = "2026-09-27T12:00:00.000Z";
/** 板根（出源 CLI 用 `dist/` 编译产物，须先 `npm run build`；口径同其余走 dist 的测试）。 */
const boardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// N1 纯函数：容错解析 / 序列化 / 建删设
// ---------------------------------------------------------------------------

test("N1-defaultVersionsLedgerFile：缺省落点 = <cwd>/.data/versions.json", () => {
  const p = defaultVersionsLedgerFile("/tmp/board-x");
  assert.ok(p.endsWith(join(".data", "versions.json")), p);
});

test("N1-三态闭集 = notstart / active / released（单一事实源 VERSION_STATUSES）", () => {
  assert.deepEqual(VERSION_STATUSES, ["notstart", "active", "released"]);
});

test("N1-parse 容错：坏形状 ⇒ 空台账；version 缺失/空白 ⇒ 丢条目；status 非闭集 ⇒ 保守回落 notstart", () => {
  for (const bad of [null, undefined, 42, "x", [], {}]) {
    assert.deepEqual(parseVersionsLedger(bad), emptyVersionsLedger(), JSON.stringify(bad));
  }
  assert.equal(parseVersionRecord({}), null);
  assert.equal(parseVersionRecord({ version: "   " }), null);
  assert.equal(parseVersionRecord("x"), null);
  assert.deepEqual(parseVersionRecord({ version: " v0.9.4 ", status: "活跃" }), {
    org: "",
    version: "v0.9.4",
    status: "notstart",
    createdAt: "",
    updatedAt: "",
    note: null,
  });
});

test("N1-parse 同名条目：后读到覆盖前者（不叠双条目）", () => {
  const l = parseVersionsLedger({
    version: VERSIONS_LEDGER_VERSION,
    versions: [
      { version: "v0.9.4", status: "notstart", createdAt: NOW, updatedAt: NOW },
      { version: "v0.9.4", status: "released", createdAt: NOW, updatedAt: NOW },
    ],
  });
  assert.equal(l.versions.length, 1);
  assert.equal(findVersionRecord(l, "v0.9.4").status, "released");
});

test("N1-序列化 round-trip（缩进 2 + 行尾换行）", () => {
  const l = createVersion(emptyVersionsLedger(), "v0.9.4", NOW).ledger;
  const text = serializeVersionsLedger(l);
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(parseVersionsLedger(JSON.parse(text)), l);
});

test("N1-createVersion 纯函数：新条 status=notstart；同名幂等 added=false；不改动入参", () => {
  const base = emptyVersionsLedger();
  const first = createVersion(base, "v0.9.4", NOW);
  assert.equal(first.added, true);
  assert.deepEqual(first.ledger.versions, [
    { org: "", version: "v0.9.4", status: "notstart", createdAt: NOW, updatedAt: NOW, note: null },
  ]);
  assert.deepEqual(base.versions, [], "纯函数：不得改动入参台账");
  const again = createVersion(first.ledger, "v0.9.4", "2026-01-01T00:00:00.000Z");
  assert.equal(again.added, false);
  assert.equal(again.ledger, first.ledger, "同名 ⇒ 原样返回（不覆盖既有状态）");
});

test("N1-setVersionStatus 纯函数：不存在 ⇒ found=false；同值 ⇒ changed=false；变更写 updatedAt + note", () => {
  const l = createVersion(emptyVersionsLedger(), "v0.9.4", NOW).ledger;
  assert.deepEqual(setVersionStatus(l, "v9.9.9", "active", NOW), { ledger: l, changed: false, found: false });
  assert.deepEqual(setVersionStatus(l, "v0.9.4", "notstart", "2026-10-01T00:00:00.000Z"), {
    ledger: l,
    changed: false,
    found: true,
  });
  const up = setVersionStatus(l, "v0.9.4", "active", "2026-10-01T00:00:00.000Z", "manual:probe");
  assert.equal(up.changed, true);
  assert.deepEqual(findVersionRecord(up.ledger, "v0.9.4"), {
    org: "",
    version: "v0.9.4",
    status: "active",
    createdAt: NOW,
    updatedAt: "2026-10-01T00:00:00.000Z",
    note: "manual:probe",
  });
  assert.equal(findVersionRecord(l, "v0.9.4").status, "notstart", "不得改动入参");
});

test("N1-removeVersion 纯函数：命中 removed=true；未命中 removed=false（原样返回）", () => {
  const l = createVersion(emptyVersionsLedger(), "v0.9.4", NOW).ledger;
  assert.equal(removeVersion(l, "v1.0.0").removed, false);
  const out = removeVersion(l, "v0.9.4");
  assert.equal(out.removed, true);
  assert.deepEqual(out.ledger.versions, []);
  assert.equal(l.versions.length, 1, "不得改动入参");
});

test("N1-releasedVersionNames / isVersionReleased：只认 status=released", () => {
  let l = createVersion(emptyVersionsLedger(), "v0.9.3", NOW).ledger;
  l = createVersion(l, "v0.9.4", NOW).ledger;
  l = setVersionStatus(l, "v0.9.3", "released", NOW).ledger;
  assert.deepEqual(releasedVersionNames(l), ["v0.9.3"]);
  assert.equal(isVersionReleased(l, "v0.9.3"), true);
  assert.equal(isVersionReleased(l, "v0.9.4"), false);
});

// ---------------------------------------------------------------------------
// N1 文件层：原子写（tmp+rename+建父目录）
// ---------------------------------------------------------------------------

function tmpLedger() {
  const dir = mkdtempSync(join(tmpdir(), "board-versions-"));
  return { dir, file: join(dir, ".data", "versions.json") };
}

test("N1-store 原子写：建父目录、无 .tmp 残留、内容可解析；同名创 added=false 且文件不动", () => {
  const { dir, file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  const { ledger, corrupt } = store.load();
  assert.deepEqual(ledger, emptyVersionsLedger(), "缺文件 = 空台账");
  assert.equal(corrupt, false, "缺文件不是「坏文件」");

  const res = store.create("v0.9.4", NOW);
  assert.equal(res.added, true);
  assert.equal(readdirSync(join(dir, ".data")).join(","), "versions.json", "不得留下 .tmp 残留文件");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).versions[0].status, "notstart");

  const dup = store.create("v0.9.4", NOW);
  assert.equal(dup.added, false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).versions.length, 1, "重名写回：文件逐字节不动");

  const set = store.setStatus("v0.9.4", "active", "2026-10-01T00:00:00.000Z");
  assert.equal(set.changed, true);
  assert.equal(store.load().ledger.versions[0].status, "active");

  const rm = store.remove("v0.9.4");
  assert.equal(rm.removed, true);
  assert.deepEqual(store.load().ledger.versions, []);
});

test("N1-store 坏文件：load 如实回报 corrupt=true（不静默当「没有记录」）", () => {
  const { dir, file } = tmpLedger();
  mkdirSync(join(dir, ".data"));
  writeFileSync(file, "{ 这不是 JSON", "utf8");
  const store = new VersionsLedgerStore(file);
  assert.equal(store.load().corrupt, true);
});

// ---------------------------------------------------------------------------
// N1 一次性迁移：config releasedVersions → 台账 released（fail-fast / 残留键 warn / 不双读）
// v0.10.0 B1：边界判据 = **独立哨兵**（不再是台账文件 exists()）
// ---------------------------------------------------------------------------

test("N1-defaultVersionsSentinelFile：哨兵缺省落点 = <cwd>/.data/versions.migrated.json（与台账同目录不同名）", () => {
  const p = defaultVersionsSentinelFile("/tmp/board-x");
  assert.ok(p.endsWith(join(".data", "versions.migrated.json")), p);
  assert.notEqual(p, defaultVersionsLedgerFile("/tmp/board-x"), "哨兵不得与台账同路径");
});

test("B1-旧迁移开关已删（钉「不复用」）：store 不再暴露 exists()，边界只剩 migrationDone()", () => {
  const { file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  assert.equal("exists" in store, false, "exists() 若还在，后续节点可能又把它当迁移边界接回去（假绿根源）");
  assert.equal(typeof store.migrationDone, "function", "唯一边界判据 = 哨兵 migrationDone()");
});

test("N1-迁移成功：哨兵未立 ⇒ releasedVersions 四条全部灌入 status=released，回执 migrated=四条", () => {
  const { file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  const out = migrateReleasedVersions({
    releasedVersions: ["v0.9.0", "v0.9.1", "v0.9.2", "v0.9.3"],
    store,
    now: NOW,
  });
  assert.deepEqual(out.migrated, ["v0.9.0", "v0.9.1", "v0.9.2", "v0.9.3"]);
  assert.deepEqual(out.residual, []);
  assert.equal(out.warning, null);
  assert.equal(existsSync(file), true, "迁移落盘");
  const { ledger } = store.load();
  assert.deepEqual(releasedVersionNames(ledger), ["v0.9.0", "v0.9.1", "v0.9.2", "v0.9.3"]);
  assert.equal(findVersionRecord(ledger, "v0.9.1").note, "migrated:config-releasedVersions");
});

test("B1-迁移空配置：releasedVersions 为空 ⇒ 空操作、不建文件、无 warn", () => {
  const { file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  const out = migrateReleasedVersions({ releasedVersions: [], store, now: NOW });
  assert.deepEqual(out, { migrated: [], residual: [], warning: null });
  assert.equal(existsSync(file), false, "空配置不落台账文件");
});

test("B1-迁移失败 ⇒ 向上抛出（拒起板）：seedReleased 写失败即 fail-fast", () => {
  const boom = new Error("disk boom");
  const fake = {
    migrationDone: () => false,
    markMigrationDone: () => {},
    load: () => ({ ledger: emptyVersionsLedger(), corrupt: false }),
    seedReleased: () => {
      throw boom;
    },
  };
  assert.throws(
    () => migrateReleasedVersions({ releasedVersions: ["v1.0.0"], store: fake, now: NOW }),
    boom,
    "灌入失败必须抛出（调用方 failStartup 拒起板，防已发版锁静默消失）",
  );
});

test("B1-残留键 warn / 不双读：**哨兵已立** ⇒ 忽略 config 键（residual + warning），台账逐字节不动", () => {
  const { dir, file } = tmpLedger();
  const store = new VersionsLedgerStore(file, join(dir, ".data", "versions.migrated.json"));
  store.create("v0.10.0", NOW);
  store.markMigrationDone("migrated=0 residual=0 orgBucketed=0");
  const before = readFileSync(file, "utf8");
  const out = migrateReleasedVersions({
    releasedVersions: ["v0.9.0", "v0.9.1"],
    store,
    now: NOW,
  });
  assert.deepEqual(out.migrated, [], "不双读：不再重复灌入");
  assert.deepEqual(out.residual, ["v0.9.0", "v0.9.1"]);
  assert.match(out.warning, /残留键/, "warn 文案");
  assert.match(out.warning, /哨兵已立/, "边界判据 = 哨兵（文案须说明事实源，不再说「台账已存在」）");
  assert.equal(readFileSync(file, "utf8"), before, "残留键不得改动台账文件");
  assert.deepEqual(findVersionRecord(store.load().ledger, "v0.9.0"), null, "残留键值不进台账");
});

test("B1-假绿钉：台账文件**已存在但为空**（无哨兵）⇒ 不得当成「已迁移」，照灌 releasedVersions", () => {
  const { file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  store.save(emptyVersionsLedger());
  assert.equal(existsSync(file), true, "前置：台账文件存在（旧判据「台账是否存在」会在此假绿）");
  assert.equal(store.migrationDone(), false, "前置：哨兵未立");
  const out = migrateReleasedVersions({ releasedVersions: ["v0.9.0"], store, now: NOW });
  assert.deepEqual(out.migrated, ["v0.9.0"], "空台账 + 无哨兵 ⇒ 迁移视同未发生，不得静默丢弃锁数据");
  assert.deepEqual(out.residual, []);
});

test("B1-哨兵落点：注入自定义台账路径 ⇒ 哨兵由台账**同目录派生**（不落到 cwd/.data 生产目录）", () => {
  const { dir, file } = tmpLedger();
  const custom = join(dir, "elsewhere", "v.json");
  const store = new VersionsLedgerStore(custom);
  assert.equal(store.sentinelFile, join(dir, "elsewhere", "versions.migrated.json"), store.sentinelFile);
  const plain = new VersionsLedgerStore(file);
  assert.equal(plain.sentinelFile, defaultVersionsSentinelFile(dir), "台账走缺省落点时哨兵与缺省哨兵同路径");
});

test("B1-哨兵落盘：markMigrationDone 建文件（含 doneAt/note）、migrationDone 转真；哨兵与台账两判据正交", () => {
  const { dir, file } = tmpLedger();
  const sentinel = join(dir, ".data", "versions.migrated.json");
  const store = new VersionsLedgerStore(file, sentinel);
  assert.equal(store.migrationDone(), false);
  store.markMigrationDone("migrated=4");
  assert.equal(store.migrationDone(), true);
  assert.equal(existsSync(sentinel), true);
  const body = JSON.parse(readFileSync(sentinel, "utf8"));
  assert.equal(body.kind, "board-versions-migration-sentinel");
  assert.equal(body.note, "migrated=4");
  assert.ok(typeof body.doneAt === "string" && body.doneAt.endsWith("Z"), "doneAt = ISO 时刻");
  assert.equal(existsSync(file), false, "**哨兵不得创建台账**（两判据正交）");
  assert.deepEqual(readdirSync(join(dir, ".data")).sort(), ["versions.migrated.json"], "哨兵写入不留 .tmp 残留");
});

test("B1-升级路径：哨兵缺失 + 台账已有数据 ⇒ 已存在版号**不覆盖不复制**、缺失版号补入；回执只报本次新增", () => {
  const { file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  let l = createVersion(emptyVersionsLedger(), "v0.9.3", NOW, "a2a").ledger;
  l = setVersionStatus(l, "v0.9.3", "active", NOW, "manual:keep").ledger;
  store.save(l);
  const out = migrateReleasedVersions({ releasedVersions: ["v0.9.3", "v0.9.0"], store, now: NOW });
  assert.deepEqual(out.migrated, ["v0.9.0"], "v0.9.3 已在台账（active）⇒ 幂等跳过，不进「已灌入」回执");
  const after = store.load().ledger;
  assert.equal(after.versions.length, 2, "已存在版号不得复制出空串桶副本");
  assert.equal(findVersionRecord(after, "v0.9.3", "a2a").status, "active", "既有行状态不被迁移覆盖");
  assert.equal(findVersionRecord(after, "v0.9.3", "a2a").note, "manual:keep", "既有 note 留痕不被改写");
  assert.equal(isVersionReleased(after, "v0.9.0"), true, "台账缺失的已发版版号补入为 released（锁不静默消失）");
});

test("B1-升级路径幂等：重跑迁移（哨兵仍未立）⇒ 零新增、台账逐字节不动", () => {
  const { file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  migrateReleasedVersions({ releasedVersions: ["v0.9.0", "v0.9.1"], store, now: NOW });
  const before = readFileSync(file, "utf8");
  const again = migrateReleasedVersions({ releasedVersions: ["v0.9.0", "v0.9.1"], store, now: "2026-10-09T00:00:00.000Z" });
  assert.deepEqual(again.migrated, [], "已灌入的版号第二次不再算新增");
  assert.equal(readFileSync(file, "utf8"), before, "重跑不得改动台账（updatedAt/note 不动）");
});

// ---------------------------------------------------------------------------
// v0.10.0 B1 出源：台账整表 → 引擎导入载荷（全字段、纯读、确定性、坏文件拒导）
// ---------------------------------------------------------------------------

test("B1-出源全字段：org/version/status/note/createdAt/updatedAt 逐值透传（含未归属空串桶），date 恒 null 空位", () => {
  const { file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  let l = createVersion(emptyVersionsLedger(), "v0.9.0", "2026-09-20T00:00:00.000Z", "a2a").ledger;
  l = setVersionStatus(l, "v0.9.0", "released", "2026-09-21T00:00:00.000Z", "manual:ship", "a2a").ledger;
  l = createVersion(l, "v0.9.8", "2026-10-04T00:00:00.000Z", "a2a").ledger;
  l = createVersion(l, "v1.0.0", "2026-10-05T00:00:00.000Z", "").ledger;
  store.save(l);
  const payload = exportVersionsLedger(store);
  assert.equal(payload.schema, VERSIONS_EXPORT_SCHEMA);
  assert.equal(payload.count, 3);
  assert.deepEqual(payload.versions, [
    {
      org: "a2a",
      version: "v0.9.0",
      status: "released",
      date: null,
      note: "manual:ship",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    },
    {
      org: "a2a",
      version: "v0.9.8",
      status: "notstart",
      date: null,
      note: null,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
    },
    {
      org: "",
      version: "v1.0.0",
      status: "notstart",
      date: null,
      note: null,
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(payload.versions.map((v) => v.org), ["a2a", "a2a", ""], "未归属桶如实带出，不出源侧过滤");
});

test("B1-出源确定性 + 纯读：两次导出逐字节相同、台账与哨兵文件零改动", () => {
  const { file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  store.create("v0.9.0", NOW, "a2a");
  store.create("v0.9.1", NOW, "a2a");
  const before = readFileSync(file, "utf8");
  const a = serializeVersionsExport(exportVersionsLedger(store));
  const b = serializeVersionsExport(exportVersionsLedger(store));
  assert.equal(a, b, "确定性：载荷不含生成时刻 ⇒ 可 diff、可重复导");
  assert.ok(!a.includes("generatedAt"), "不得混入易变字段");
  assert.equal(readFileSync(file, "utf8"), before, "出源是纯读，不改台账");
  assert.equal(store.migrationDone(), false, "出源不立哨兵（哨兵只属迁移链路）");
});

test("B1-出源坏文件 ⇒ 抛出拒导（不按空台账出货，防 released 历史静默导出为零）", () => {
  const { dir, file } = tmpLedger();
  mkdirSync(join(dir, ".data"));
  writeFileSync(file, "{ 这不是 JSON", "utf8");
  const store = new VersionsLedgerStore(file);
  assert.throws(() => exportVersionsLedger(store), /损坏/, "坏文件必须拒导");
});

test("B1-出源缺文件 ⇒ 诚实的空（count=0，不抛）", () => {
  const { file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  assert.deepEqual(exportVersionsLedger(store).versions, []);
});

// ---------------------------------------------------------------------------
// v0.10.0 B1 出源 CLI：scripts/export-versions-ledger.mjs（只读、退出码 {0,1,2}）
// ---------------------------------------------------------------------------

function runExportCli(args, cwd) {
  return spawnSync(process.execPath, [join(boardRoot, "scripts", "export-versions-ledger.mjs"), ...args], {
    encoding: "utf8",
    cwd,
  });
}

test("B1-CLI：--stdout 打全字段载荷；exit 0；台账文件逐字节不动（纯读）", () => {
  const { dir, file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  let l = createVersion(emptyVersionsLedger(), "v0.9.0", NOW, "a2a").ledger;
  l = setVersionStatus(l, "v0.9.0", "released", "2026-09-28T00:00:00.000Z", "manual:ship", "a2a").ledger;
  store.save(l);
  const before = readFileSync(file, "utf8");
  const r = runExportCli(["--in", file, "--stdout"], dir);
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.schema, VERSIONS_EXPORT_SCHEMA);
  assert.equal(payload.count, 1);
  assert.deepEqual(payload.versions, [
    {
      org: "a2a",
      version: "v0.9.0",
      status: "released",
      date: null,
      note: "manual:ship",
      createdAt: NOW,
      updatedAt: "2026-09-28T00:00:00.000Z",
    },
  ]);
  assert.equal(readFileSync(file, "utf8"), before, "CLI 不得改动台账");
  assert.equal(existsSync(join(dir, ".data", "versions.migrated.json")), false, "CLI 不立哨兵");
});

test("B1-CLI：--out 落文件；缺省落点 = 台账同目录 versions-export.json", () => {
  const { dir, file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  store.create("v0.9.0", NOW, "a2a");
  const outPath = join(dir, "engine-import", "versions.json");
  const r1 = runExportCli(["--in", file, "--out", outPath], dir);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(JSON.parse(readFileSync(outPath, "utf8")).count, 1);
  const r2 = runExportCli(["--in", file], dir);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(existsSync(join(dir, ".data", "versions-export.json")), true, "缺省导出落台账同目录");
});

test("B1-CLI：台账损坏 ⇒ exit 2 且**不产载荷**（不按空台账出货）", () => {
  const { dir, file } = tmpLedger();
  mkdirSync(join(dir, ".data"));
  writeFileSync(file, "{ 这不是 JSON", "utf8");
  const outPath = join(dir, "out.json");
  const r = runExportCli(["--in", file, "--out", outPath], dir);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(existsSync(outPath), false, "拒导不得留下半截导出文件");
});

test("B1-CLI：缺文件 ⇒ exit 0 + count 0（诚实的空）；未知参数 ⇒ exit 1", () => {
  const { dir, file } = tmpLedger();
  const ok = runExportCli(["--in", file, "--stdout"], dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).count, 0);
  const bad = runExportCli(["--nope"], dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /未知参数/);
});

// ---------------------------------------------------------------------------
// v0.9.6 B1（REQ-2026-09-28-07 口径 1/2/32）：台账组织维度 + migrateLedgerOrgs
// ---------------------------------------------------------------------------

test("B1-① 跨组织同名不互覆盖（解析层）：去重键 = (org, version)；同键仍后读到覆盖前者", () => {
  const l = parseVersionsLedger({
    version: VERSIONS_LEDGER_VERSION,
    versions: [
      { org: "alpha", version: "v0.9.5", status: "released", createdAt: NOW, updatedAt: NOW },
      { org: "beta", version: "v0.9.5", status: "notstart", createdAt: NOW, updatedAt: NOW },
      { org: "alpha", version: "v0.9.5", status: "active", createdAt: NOW, updatedAt: NOW },
    ],
  });
  assert.equal(l.versions.length, 2, "两个组织的同版号 = 两条独立条目（beta 不得被 alpha 覆盖掉）");
  assert.equal(findVersionRecord(l, "v0.9.5", "alpha").status, "active", "同 (org, version) ⇒ 后读到覆盖前者");
  assert.equal(findVersionRecord(l, "v0.9.5", "beta").status, "notstart", "另一组织的同名条目不受影响");
  assert.deepEqual(releasedVersionNames(l, "alpha"), [], "切片读面：alpha 名下无 released");
  assert.deepEqual(releasedVersionNames(l, "beta"), [], "beta 名下是 notstart，不是 released");
  assert.deepEqual(
    releasedVersionNames(parseVersionsLedger({ version: 2, versions: [{ org: "alpha", version: "v0.9.5", status: "released" }] })),
    ["v0.9.5"],
    "已发版集合按组织可查",
  );
});

test("B1-② 跨组织同名不互覆盖（写面纯函数）：建/设状态/删按 (org, version)，org 省略 = 不限组织", () => {
  let l = createVersion(emptyVersionsLedger(), "v1.0.0", NOW, "alpha").ledger;
  assert.equal(createVersion(l, "v1.0.0", NOW, "alpha").added, false, "同组织同版号 ⇒ 幂等 added=false");
  const cross = createVersion(l, "v1.0.0", NOW, "beta");
  assert.equal(cross.added, true, "不同组织的同版号是**新条目**，不是撞名");
  assert.equal(cross.ledger.versions.length, 2);
  const marked = setVersionStatus(cross.ledger, "v1.0.0", "released", "2026-10-01T00:00:00.000Z", "manual:alpha", "alpha");
  assert.equal(marked.changed, true);
  assert.equal(isVersionReleased(marked.ledger, "v1.0.0", "alpha"), true, "alpha 名下已发版");
  assert.equal(isVersionReleased(marked.ledger, "v1.0.0", "beta"), false, "**beta 不得被同版号的 alpha 锁住**");
  assert.deepEqual(
    marked.ledger.versions.filter((v) => v.org === "beta").map((v) => v.updatedAt),
    [NOW],
    "另一组织的 updatedAt 不被带动",
  );
  assert.deepEqual(releasedVersionLabels(marked.ledger), ["v1.0.0（alpha）"], "启动日志读面带组织维度（空串桶显式标未归属）");
  const rm = removeVersion(marked.ledger, "v1.0.0", "alpha");
  assert.equal(rm.removed, true);
  assert.deepEqual(rm.ledger.versions.map((v) => v.org), ["beta"], "删条目只删该组织那一行");
  assert.equal(removeVersion(rm.ledger, "v1.0.0", "alpha").removed, false, "已删的组织再删 ⇒ removed=false");
});

test("B1-②b org 不落白名单 = 读一次静默丢 org（最危险一类）：解析 + 序列化 round-trip 必须保 org", () => {
  const l = parseVersionsLedger({
    version: VERSIONS_LEDGER_VERSION,
    versions: [{ org: " alpha ", version: "v0.9.6", status: "active", createdAt: NOW, updatedAt: NOW, note: "k" }],
  });
  assert.equal(l.versions[0].org, "alpha", "org 键须被解析（trim）");
  const text = serializeVersionsLedger(l);
  assert.equal(JSON.parse(text).versions[0].org, "alpha", "序列化不得丢 org 键");
  assert.deepEqual(parseVersionsLedger(JSON.parse(text)), l, "round-trip 后 org 仍在");
});

test("B1-③ schema 1 → 2：常量 bump；读到 v1 台账（条目缺 org）⇒ 落盘即写 2", () => {
  assert.equal(VERSIONS_LEDGER_VERSION, 2, "台账 schema 常量 = 2（v0.9.6 B1 记录扩 org）");
  const { dir, file } = tmpLedger();
  mkdirSync(join(dir, ".data"));
  writeFileSync(file, JSON.stringify({ version: 1, versions: [{ version: "v0.9.0", status: "released", createdAt: NOW, updatedAt: NOW }] }, null, 2) + "\n", "utf8");
  const store = new VersionsLedgerStore(file);
  const { ledger } = store.load();
  assert.equal(ledger.version, 1, "读侧如实保留文件里的 schema 值");
  assert.equal(ledger.versions[0].org, "", "缺 org 键 ⇒ 解析落空串（迁移判据）");
  const out = migrateLedgerOrgs(ledger, "a2a-coding", NOW);
  store.save(out.ledger);
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.version, 2, "落盘恒写当前 schema（1 → 2 随迁移完成）");
  assert.equal(onDisk.versions[0].org, "a2a-coding", "迁移后条目带 org");
});

test("B1-④ migrateLedgerOrgs：缺 org 的 8 条全部 stamp 为 defaultGroup；重跑幂等不重复 stamp", () => {
  const legacy = parseVersionsLedger({
    version: 1,
    versions: [
      ...["v0.9.0", "v0.9.1", "v0.9.2", "v0.9.3", "v0.9.4", "v0.9.5"].map((version) => ({
        version,
        status: "released",
        createdAt: "2026-09-27T17:05:15.815Z",
        updatedAt: "2026-09-27T17:05:15.815Z",
        note: "migrated:config-releasedVersions",
      })),
      { version: "v0.9.6", status: "active", createdAt: NOW, updatedAt: NOW, note: "auto:first-card-confirmed" },
      { version: "v0.9.7", status: "notstart", createdAt: NOW, updatedAt: NOW, note: null },
    ],
  });
  const once = migrateLedgerOrgs(legacy, "a2a-coding", "2026-09-29T00:00:00.000Z");
  assert.deepEqual(once.stamped, ["v0.9.0", "v0.9.1", "v0.9.2", "v0.9.3", "v0.9.4", "v0.9.5", "v0.9.6", "v0.9.7"], "8 条全 stamp");
  assert.deepEqual(once.bucketed, [], "已配默认组织 ⇒ 不落空串桶");
  assert.equal(once.warning, null);
  assert.deepEqual(once.ledger.versions.map((v) => v.org), Array(8).fill("a2a-coding"), "全部条目归位 a2a-coding");
  assert.equal(once.ledger.versions[0].createdAt, "2026-09-27T17:05:15.815Z", "stamp 只补 org，不动 createdAt");
  assert.equal(once.ledger.versions[0].note, "migrated:config-releasedVersions", "既有 note 留痕不得被迁移覆盖");
  assert.equal(once.ledger.version, 2, "迁移后台账升为 schema 2");
  const twice = migrateLedgerOrgs(once.ledger, "a2a-coding", "2026-09-30T00:00:00.000Z");
  assert.deepEqual(twice.stamped, [], "重启幂等：已带 org ⇒ 不再 stamp");
  assert.deepEqual(twice.bucketed, []);
  assert.equal(twice.warning, null);
  assert.equal(twice.ledger, once.ledger, "无条目待迁移 ⇒ 台账**原样返回**（调用方据此不落盘）");
});

test("B1-⑤ migrateLedgerOrgs（defaultGroup 未配档）：一次性 warn + 留空串桶，不 fail-fast、不落盘", () => {
  const legacy = parseVersionsLedger({ version: 1, versions: [{ version: "v0.9.0", status: "released", createdAt: NOW, updatedAt: NOW }] });
  for (const missing of [null, "", "   "]) {
    const out = migrateLedgerOrgs(legacy, missing, NOW);
    assert.deepEqual(out.stamped, [], JSON.stringify(missing) + " ⇒ 不 stamp");
    assert.deepEqual(out.bucketed, ["v0.9.0"], "缺 org 条目登记为空串桶版号（供 warn 文案与排查）");
    assert.match(out.warning, /未配默认组织/, "一次性 warn 文案");
    assert.equal(out.ledger, legacy, "未配档 ⇒ 台账原样返回（调用方不得写文件）");
    assert.equal(out.ledger.versions[0].org, "", "留在空串桶（门户不暴露该桶，由调用方过滤）");
  }
  const labels = releasedVersionLabels(legacy);
  assert.deepEqual(labels, ["v0.9.0（未归属组织）"], "空串桶在启动日志显式标出，不静默当光版号");
});
