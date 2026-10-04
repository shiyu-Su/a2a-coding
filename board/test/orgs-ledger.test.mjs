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
  disableOrg,
  setOrgHostAgent,
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
  assert.deepEqual(parseOrgRecord({ org: " flow ", disabledAt: 42 }), { org: "flow", disabledAt: null, agentKind: null, agentModel: null });
  assert.deepEqual(parseOrgRecord({ org: "flow", disabledAt: "2026-09-27T00:00:00Z" }), {
    org: "flow",
    disabledAt: "2026-09-27T00:00:00Z",
    agentKind: null,
    agentModel: null,
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
  assert.deepEqual(first.ledger.orgs, [{ org: "flow-team", disabledAt: null, agentKind: null, agentModel: null }]);
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
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).orgs, [{ org: "新组织", disabledAt: null, agentKind: null, agentModel: null }]);

  const dup = store.addOrg("新组织");
  assert.equal(dup.added, false);
  assert.deepEqual(
    JSON.parse(readFileSync(file, "utf8")).orgs,
    [{ org: "新组织", disabledAt: null, agentKind: null, agentModel: null }],
    "重名写回：文件逐字节不动",
  );

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

// ---------------------------------------------------------------------------
// v0.9.8 按项目组配 agent：agentKind / agentModel 两键（REQ-2026-10-03-01 T1）
// ---------------------------------------------------------------------------

test("v0.9.8-⓪ schema 1 → 2：常量 bump 钉死；序列化恒写常量（照 versions 台账 B1-③ 先例）", () => {
  assert.equal(ORGS_LEDGER_VERSION, 2, "台账 schema 常量 = 2（v0.9.8 记录扩 agent 两键）");
  assert.equal(JSON.parse(serializeOrgsLedger(emptyOrgsLedger())).version, 2);
});

test("v0.9.8-①新键 round-trip：parse 保留并 trim；serialize→parse 无损", () => {
  const rec = parseOrgRecord({ org: "flow", disabledAt: null, agentKind: " opencode ", agentModel: "m-x" });
  assert.deepEqual(rec, { org: "flow", disabledAt: null, agentKind: "opencode", agentModel: "m-x" });
  const l = parseOrgsLedger({ version: 2, orgs: [rec] });
  assert.deepEqual(parseOrgsLedger(JSON.parse(serializeOrgsLedger(l))), l);
});

test("v0.9.8-②坏值归 null（不臆造）：agentKind / agentModel 非串 / 空串 / 纯空白一律按未配置", () => {
  for (const bad of [42, true, {}, [], "", "   "]) {
    const rec = parseOrgRecord({ org: "flow", agentKind: bad, agentModel: bad });
    assert.equal(rec.agentKind, null, JSON.stringify(bad));
    assert.equal(rec.agentModel, null, JSON.stringify(bad));
  }
});

test("v0.9.8-③旧 v1 文件零迁移：读到即认（parse 补两键 null）；任一落盘自动升 2（无迁移器）", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-orgs-v1-"));
  mkdirSync(join(dir, ".data"), { recursive: true });
  const file = join(dir, ".data", "orgs.json");
  writeFileSync(file, JSON.stringify({ version: 1, orgs: [{ org: "甲", disabledAt: null }] }, null, 2) + "\n", "utf8");
  const store = new OrgsLedgerStore(file);
  const { ledger } = store.load();
  assert.equal(ledger.version, 1, "读侧如实保留文件自带的 schema 值");
  assert.deepEqual(findOrgRecord(ledger, "甲"), { org: "甲", disabledAt: null, agentKind: null, agentModel: null });
  const written = store.setOrgHostAgent("甲", "qoder", null);
  assert.equal(written.found, true);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.version, 2, "serialize 恒写常量 ⇒ 旧文件落盘即升 2");
  assert.deepEqual(saved.orgs, [{ org: "甲", disabledAt: null, agentKind: "qoder", agentModel: null }]);
  store.addOrg("乙");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 2);
});

test("v0.9.8-④停用与同名复活都不吞配置（用户裁①：复活保留旧 agent 配置，只抹停用标记）", () => {
  const base = setOrgHostAgent(addOrg(emptyOrgsLedger(), "甲").ledger, "甲", "opencode", "m1").ledger;
  const d = disableOrg(base, "甲", "2026-10-03T00:00:00Z");
  assert.equal(d.changed, true);
  assert.deepEqual(findOrgRecord(d.ledger, "甲"), {
    org: "甲",
    disabledAt: "2026-10-03T00:00:00Z",
    agentKind: "opencode",
    agentModel: "m1",
  }, "disableOrg 不得以重建字面量吞掉两键");
  const r = addOrg(d.ledger, "甲");
  assert.equal(r.added, true);
  assert.deepEqual(findOrgRecord(r.ledger, "甲"), {
    org: "甲",
    disabledAt: null,
    agentKind: "opencode",
    agentModel: "m1",
  });
});

test("v0.9.8-⑤setOrgHostAgent 纯函数：整体覆盖（null=置回）；不在台账 found:false；保留其余键；不改动入参", () => {
  const base = setOrgHostAgent(addOrg(emptyOrgsLedger(), "甲").ledger, "甲", "opencode", "m1").ledger;
  const r = setOrgHostAgent(base, "甲", "qoder", null);
  assert.equal(r.found, true);
  assert.deepEqual(findOrgRecord(r.ledger, "甲"), { org: "甲", disabledAt: null, agentKind: "qoder", agentModel: null });
  assert.deepEqual(findOrgRecord(base, "甲").agentKind, "opencode", "纯函数：不得改动入参台账");
  const miss = setOrgHostAgent(base, "乙", "qoder", "m");
  assert.equal(miss.found, false);
  assert.equal(miss.ledger, base, "未命中 ⇒ 原样返回（store 层据此零写文件）");
});

test("v0.9.8-⑥store.setOrgHostAgent：不在台账 ⇒ 文件逐字节不动（found:false 不落盘）", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-orgs-ha-"));
  const file = join(dir, ".data", "orgs.json");
  const store = new OrgsLedgerStore(file);
  store.addOrg("甲");
  const before = readFileSync(file, "utf8");
  const miss = store.setOrgHostAgent("没有这个组", "qoder", "m");
  assert.equal(miss.found, false);
  assert.equal(readFileSync(file, "utf8"), before, "未命中不得写文件");
});
