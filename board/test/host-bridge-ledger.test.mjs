import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  HostBridgeLedgerStore,
  LEDGER_VERSION,
  defaultLedgerFile,
  emptyLedger,
  findHost,
  parseHostRecord,
  parseLedger,
  removeHost,
  serializeLedger,
  upsertHost,
} from "../dist/host-bridge-ledger.js";

// ---------------------------------------------------------------------------
// 记录级容错解析（缺字段回落 null / 空数组，**不臆造**）
// ---------------------------------------------------------------------------

test("parseHostRecord: 非对象 / 数组 / 缺 org ⇒ null（坏记录整条丢弃，不半成品入账）", () => {
  assert.equal(parseHostRecord(null), null);
  assert.equal(parseHostRecord("x"), null);
  assert.equal(parseHostRecord([]), null);
  assert.equal(parseHostRecord({ pid: 1 }), null, "org 是主键，缺它无法定位记录");
});

test("parseHostRecord: 全字段缺失 ⇒ 标量 null / 空串 / 空数组（不臆造 pid=0 之类）", () => {
  const rec = parseHostRecord({ org: "flow" });
  assert.deepEqual(rec, {
    org: "flow",
    pid: null,
    port: null,
    workspace: "",
    kind: "",
    mcpUrl: null,
    startedAt: null,
    stoppedAt: null,
    stopReason: null,
    cliSessionIds: [],
    docPaths: [],
  });
});

test("parseHostRecord: 值类型作恶（pid 字符串 / 小数 / 数组含空串）一律归位，不污染账面", () => {
  const rec = parseHostRecord({
    org: "flow",
    pid: "1234",
    port: 87.5,
    cliSessionIds: ["s1", "", null, "s1", "s2"],
    docPaths: "not-an-array",
  });
  assert.equal(rec.pid, null);
  assert.equal(rec.port, null);
  assert.deepEqual(rec.cliSessionIds, ["s1", "s2"], "空串剔除、重复去重");
  assert.deepEqual(rec.docPaths, []);
});

// ---------------------------------------------------------------------------
// 整本台账
// ---------------------------------------------------------------------------

test("parseLedger: 坏 JSON 顶层（非对象 / 数组）⇒ 空台账，version 回落当前 schema", () => {
  for (const raw of [null, 3, "[]", [], {}]) {
    const out = parseLedger(raw);
    assert.equal(out.version, LEDGER_VERSION);
    assert.deepEqual(out.hosts, []);
  }
});

test("parseLedger: hosts 非数组 ⇒ 空；同名记录后读到覆盖前者（不产生双记录）", () => {
  assert.deepEqual(parseLedger({ hosts: "nope" }).hosts, []);
  const out = parseLedger({
    version: LEDGER_VERSION,
    hosts: [
      { org: "flow", pid: 11, port: 19001 },
      { org: "flow", pid: 22, port: 19002 },
      { org: "other", pid: 33 },
    ],
  });
  assert.equal(out.hosts.length, 2);
  assert.equal(findHost(out, "flow").pid, 22);
  assert.equal(findHost(out, "flow").port, 19002);
});

test("serializeLedger → parseLedger 往返保真（缩进 2 便于人读与 diff）", () => {
  const l = upsertHost(emptyLedger(), {
    org: "flow",
    pid: 4242,
    port: 18999,
    workspace: "D:/orgs/flow",
    kind: "claude",
    mcpUrl: "http://127.0.0.1:8787/flow/mcp",
    startedAt: "2026-09-24T00:00:00.000Z",
    cliSessionId: "sess-1",
    docPath: "doc/v0.9.0/x-需求确认单.md",
  });
  const text = serializeLedger(l);
  assert.match(text, /\n {6}"org"/, "缩进固定 2（记录在 hosts 数组内，故第 3 级）");
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(parseLedger(JSON.parse(text)), l);
});

// ---------------------------------------------------------------------------
// upsert 语义（**关键**：生命周期写不得抹掉会话句柄）
// ---------------------------------------------------------------------------

test("upsertHost: 未给出的字段维持原值（标量才是覆盖语义）", () => {
  let l = upsertHost(emptyLedger(), { org: "flow", pid: 11, port: 19001, kind: "claude" });
  l = upsertHost(l, { org: "flow", pid: null });
  assert.equal(findHost(l, "flow").pid, null);
  assert.equal(findHost(l, "flow").port, 19001, "未传 port ⇒ 不动");
  assert.equal(findHost(l, "flow").kind, "claude");
});

test("upsertHost: cliSessionId / docPath 是**追加去重**语义，多次生命周期写不抹句柄", () => {
  let l = upsertHost(emptyLedger(), { org: "flow", pid: 11, cliSessionId: "s1", docPath: "d1.md" });
  l = upsertHost(l, { org: "flow", pid: null, stoppedAt: "2026-09-24T01:00:00.000Z", stopReason: "idle" });
  const rec = findHost(l, "flow");
  assert.deepEqual(rec.cliSessionIds, ["s1"], "回收只写生命周期字段，句柄须原样留着");
  assert.deepEqual(rec.docPaths, ["d1.md"]);
  l = upsertHost(l, { org: "flow", cliSessionId: "s1" });
  l = upsertHost(l, { org: "flow", cliSessionId: "s2" });
  assert.deepEqual(findHost(l, "flow").cliSessionIds, ["s1", "s2"]);
});

test("upsertHost: 整批 cliSessionIds / docPaths 同样是追加（存量记录读回时不被空集合抹掉）", () => {
  let l = upsertHost(emptyLedger(), { org: "flow", cliSessionIds: ["s1", "s2"] });
  l = upsertHost(l, { org: "flow", cliSessionIds: ["s2", "s3"] });
  assert.deepEqual(findHost(l, "flow").cliSessionIds, ["s1", "s2", "s3"]);
  l = upsertHost(l, { org: "flow", cliSessionIds: [] });
  assert.deepEqual(findHost(l, "flow").cliSessionIds, ["s1", "s2", "s3"], "空批次 ⇒ 不动，而非清空");
});

test("parseLedger 读回存量记录时保留句柄与文档路径（重启后账面对得上）", () => {
  const l = parseLedger({
    version: LEDGER_VERSION,
    hosts: [
      { org: "flow", pid: null, cliSessionIds: ["s1", "s1", ""], docPaths: ["d1.md"] },
    ],
  });
  assert.deepEqual(findHost(l, "flow").cliSessionIds, ["s1"]);
  assert.deepEqual(findHost(l, "flow").docPaths, ["d1.md"]);
});

test("upsertHost 是纯函数：不改入参对象（避免调用方手里的旧快照被悄悄改写）", () => {
  const base = upsertHost(emptyLedger(), { org: "flow", pid: 11 });
  const before = JSON.stringify(base);
  upsertHost(base, { org: "flow", pid: 99 });
  upsertHost(base, { org: "new", pid: 1 });
  assert.equal(JSON.stringify(base), before);
});

test("removeHost: 摘除组织记录；不存在 ⇒ 原样返回（幂等）", () => {
  let l = upsertHost(emptyLedger(), { org: "flow", pid: 11 });
  l = upsertHost(l, { org: "other", pid: 22 });
  assert.deepEqual(removeHost(l, "nope").hosts.map((h) => h.org), ["flow", "other"]);
  assert.deepEqual(removeHost(l, "flow").hosts.map((h) => h.org), ["other"]);
});

// ---------------------------------------------------------------------------
// 文件层
// ---------------------------------------------------------------------------

function tmpFile(name = "host-bridges.json") {
  const file = join(mkdtempSync(join(tmpdir(), "board-ledger-")), ".data", name);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

test("defaultLedgerFile: 缺省落点 = <cwd>/.data/host-bridges.json（.data/ 不入库）", () => {
  assert.equal(defaultLedgerFile("D:/board"), join("D:/board", ".data", "host-bridges.json"));
});

test("HostBridgeLedgerStore: 文件不存在 ⇒ 空台账且 corrupt=false（正常首启，不是坏数据）", () => {
  const store = new HostBridgeLedgerStore(tmpFile());
  const { ledger, corrupt } = store.load();
  assert.equal(corrupt, false);
  assert.deepEqual(ledger.hosts, []);
});

test("HostBridgeLedgerStore.save/load 往返 + update 走 read-modify-write（句柄跨多次写累积）", () => {
  const file = tmpFile();
  const store = new HostBridgeLedgerStore(file);
  store.update({ org: "flow", pid: 4242, port: 18999, workspace: "D:/orgs/flow", kind: "claude" });
  store.update({ org: "flow", cliSessionId: "sess-1" });
  store.update([{ org: "flow", cliSessionId: "sess-2" }, { org: "other", pid: 9 }]);
  const { ledger, corrupt } = store.load();
  assert.equal(corrupt, false);
  assert.deepEqual(findHost(ledger, "flow").cliSessionIds, ["sess-1", "sess-2"]);
  assert.equal(findHost(ledger, "other").pid, 9);
  assert.deepEqual(readdirSync(dirname(store.file)), ["host-bridges.json"], "临时文件须被 rename 收走，不留 .tmp");
});

test("HostBridgeLedgerStore: 坏 JSON ⇒ 按空台账起，但 corrupt=true 如实回报（不静默当成「没有记录」）", () => {
  const file = tmpFile();
  const store = new HostBridgeLedgerStore(file);
  store.save(upsertHost(emptyLedger(), { org: "flow", pid: 1 }));
  writeFileSync(file, "{ this is not json", "utf8");
  const { ledger, corrupt } = store.load();
  assert.equal(corrupt, true);
  assert.deepEqual(ledger, emptyLedger());
});

test("writeFileAtomic 语义：写父目录自动建、旧内容被整体替换（无半写文件）", () => {
  const store = new HostBridgeLedgerStore(tmpFile());
  store.save(upsertHost(emptyLedger(), { org: "flow", pid: 1 }));
  store.save(emptyLedger());
  const text = readFileSync(store.file, "utf8");
  assert.equal(text.trim(), JSON.stringify({ version: LEDGER_VERSION, hosts: [] }, null, 2));
  assert.equal(existsSync(`${store.file}.tmp`), false);
});
