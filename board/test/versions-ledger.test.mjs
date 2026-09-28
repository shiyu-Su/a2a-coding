import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VERSIONS_LEDGER_VERSION,
  VERSION_STATUSES,
  defaultVersionsLedgerFile,
  emptyVersionsLedger,
  parseVersionRecord,
  parseVersionsLedger,
  serializeVersionsLedger,
  findVersionRecord,
  releasedVersionNames,
  isVersionReleased,
  createVersion,
  removeVersion,
  setVersionStatus,
  migrateReleasedVersions,
  VersionsLedgerStore,
} from "../dist/versions-ledger.js";

const NOW = "2026-09-27T12:00:00.000Z";

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
    { version: "v0.9.4", status: "notstart", createdAt: NOW, updatedAt: NOW, note: null },
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
// ---------------------------------------------------------------------------

test("N1-迁移成功：台账不存在 ⇒ releasedVersions 四条全部灌入 status=released，回执 migrated=四条", () => {
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

test("N1-迁移空配置：releasedVersions 为空 ⇒ 空操作、不建文件、无 warn", () => {
  const { file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  const out = migrateReleasedVersions({ releasedVersions: [], store, now: NOW });
  assert.deepEqual(out, { migrated: [], residual: [], warning: null });
  assert.equal(existsSync(file), false, "空配置不落台账文件");
});

test("N1-迁移失败 ⇒ 向上抛出（拒起板）：seedReleased 写失败即 fail-fast", () => {
  const boom = new Error("disk boom");
  const fake = {
    exists: () => false,
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

test("N1-残留键 warn / 不双读：台账已存在 ⇒ 忽略 config 键（residual + warning），台账逐字节不动", () => {
  const { file } = tmpLedger();
  const store = new VersionsLedgerStore(file);
  store.create("v0.10.0", NOW);
  const before = readFileSync(file, "utf8");
  const out = migrateReleasedVersions({
    releasedVersions: ["v0.9.0", "v0.9.1"],
    store,
    now: NOW,
  });
  assert.deepEqual(out.migrated, [], "不双读：不再重复灌入");
  assert.deepEqual(out.residual, ["v0.9.0", "v0.9.1"]);
  assert.match(out.warning, /残留键/, "一次性 warn 文案");
  assert.equal(readFileSync(file, "utf8"), before, "残留键不得改动台账文件");
  assert.deepEqual(findVersionRecord(store.load().ledger, "v0.9.0"), null, "残留键值不进台账");
});
