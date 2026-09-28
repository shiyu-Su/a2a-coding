import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ORGS_LEDGER_VERSION,
  defaultOrgsLedgerFile,
  emptyOrgsLedger,
  parseOrgRecord,
  parseOrgsLedger,
  serializeOrgsLedger,
  findOrgRecord,
  ledgerOrgNames,
  addOrg,
  OrgsLedgerStore,
} from "../dist/orgs-ledger.js";

// ---------------------------------------------------------------------------
// A1 纯函数：容错解析 / 序列化 / 纯新建
// ---------------------------------------------------------------------------

test("A1-defaultOrgsLedgerFile：缺省落点 = <cwd>/.data/orgs.json", () => {
  const p = defaultOrgsLedgerFile("/tmp/board-x");
  assert.ok(p.endsWith(join(".data", "orgs.json")), p);
});

test("A1-parse 容错：坏形状 ⇒ 空台账；org 缺失/空白 ⇒ 丢条目；disabledAt 非串 ⇒ null", () => {
  for (const bad of [null, undefined, 42, "x", [], {}]) {
    assert.deepEqual(parseOrgsLedger(bad), emptyOrgsLedger(), JSON.stringify(bad));
  }
  assert.equal(parseOrgRecord({}), null);
  assert.equal(parseOrgRecord({ org: "   " }), null);
  assert.equal(parseOrgRecord("x"), null);
  assert.deepEqual(parseOrgRecord({ org: " flow ", disabledAt: 42 }), { org: "flow", disabledAt: null });
  assert.deepEqual(parseOrgRecord({ org: "flow", disabledAt: "2026-09-27T00:00:00Z" }), {
    org: "flow",
    disabledAt: "2026-09-27T00:00:00Z",
  });
});

test("A1-parse 同名条目：后读到覆盖前者（与宿主桥台账同容错口径，不叠双条目）", () => {
  const l = parseOrgsLedger({
    version: ORGS_LEDGER_VERSION,
    orgs: [
      { org: "a", disabledAt: null },
      { org: "a", disabledAt: "2026-09-27T00:00:00Z" },
    ],
  });
  assert.equal(l.orgs.length, 1);
  assert.equal(findOrgRecord(l, "a").disabledAt, "2026-09-27T00:00:00Z");
});

test("A1-序列化 round-trip（缩进 2 + 行尾换行，人读与 diff 友好）", () => {
  const l = addOrg(emptyOrgsLedger(), "甲组织").ledger;
  const text = serializeOrgsLedger(l);
  assert.ok(text.endsWith("\n"));
  assert.match(text, /"org": "甲组织"/);
  assert.deepEqual(parseOrgsLedger(JSON.parse(text)), l);
});

test("A1-addOrg 纯函数：新条目 disabledAt=null；同名不覆盖（幂等 added=false）；不改动入参", () => {
  const base = emptyOrgsLedger();
  const first = addOrg(base, "flow-team");
  assert.equal(first.added, true);
  assert.deepEqual(first.ledger.orgs, [{ org: "flow-team", disabledAt: null }]);
  assert.deepEqual(base.orgs, [], "纯函数：不得改动入参台账");
  const again = addOrg(first.ledger, "flow-team");
  assert.equal(again.added, false);
  assert.equal(again.ledger, first.ledger, "重名 ⇒ 原样返回（不得抹掉既有停用标记）");
  assert.deepEqual(ledgerOrgNames(first.ledger), ["flow-team"]);
});

// ---------------------------------------------------------------------------
// A1 文件层：原子写（tmp+rename+建父目录）
// ---------------------------------------------------------------------------

test("A1-store 原子写：建父目录、无 .tmp 残留、内容可解析；重名 added=false 且文件不动", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-orgs-"));
  const file = join(dir, ".data", "orgs.json");
  const store = new OrgsLedgerStore(file);
  const { ledger, corrupt } = store.load();
  assert.deepEqual(ledger, emptyOrgsLedger(), "缺文件 = 空台账");
  assert.equal(corrupt, false, "缺文件不是「坏文件」");

  const res = store.addOrg("新组织");
  assert.equal(res.added, true);
  assert.equal(readdirSync(join(dir, ".data")).join(","), "orgs.json", "不得留下 .tmp 残留文件");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).orgs, [{ org: "新组织", disabledAt: null }]);

  const dup = store.addOrg("新组织");
  assert.equal(dup.added, false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).orgs, [{ org: "新组织", disabledAt: null }], "重名写回：文件逐字节不动");

  const second = store.addOrg("乙");
  assert.equal(second.added, true);
  assert.deepEqual(ledgerOrgNames(store.load().ledger), ["新组织", "乙"]);
});

test("A1-store 坏文件：load 如实回报 corrupt=true（不静默当「没有记录」）", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-orgs-"));
  mkdirSync(join(dir, ".data"));
  const file = join(dir, ".data", "orgs.json");
  writeFileSync(file, "{ 这不是 JSON", "utf8");
  const store = new OrgsLedgerStore(file);
  const { ledger, corrupt } = store.load();
  assert.equal(corrupt, true);
  assert.deepEqual(ledger, emptyOrgsLedger());
});
