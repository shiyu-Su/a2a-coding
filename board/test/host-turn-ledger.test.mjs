import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  HostTurnLedgerStore,
  emptyTurnLedger,
  findSession,
  findTurn,
  isTerminalTurnState,
  openSession,
  parseTurnLedger,
  parseTurnRecord,
  serializeTurnLedger,
  trimTurns,
  upsertTurn,
  TURN_HISTORY_CAP,
} from "../dist/host-turn-ledger.js";

// ---------------------------------------------------------------------------
// 轮态闭集
// ---------------------------------------------------------------------------

test("轮态终态闭集：awaiting_answer / queued / running 都不是终态（等人 ≠ 结束）", () => {
  assert.equal(isTerminalTurnState("succeeded"), true);
  assert.equal(isTerminalTurnState("failed"), true);
  assert.equal(isTerminalTurnState("canceled"), true);
  assert.equal(isTerminalTurnState("timeout"), true);
  assert.equal(isTerminalTurnState("awaiting_answer"), false);
  assert.equal(isTerminalTurnState("queued"), false);
  assert.equal(isTerminalTurnState("running"), false);
});

// ---------------------------------------------------------------------------
// contextId 分配（BD4b 纪律 ④）
// ---------------------------------------------------------------------------

test("开一轮：新需求 ⇒ 分配新 contextId、round = 1", () => {
  let seq = 0;
  const make = () => `board-ctx-${String(++seq)}`;
  const first = openSession(emptyTurnLedger(), { requirementId: "R1", org: "flow", at: "2026-09-24T00:00:00.000Z" }, make);
  assert.equal(first.contextId, "board-ctx-1");
  assert.equal(first.round, 1);
  assert.equal(findSession(first.ledger, "R1").contextId, "board-ctx-1");
});

test("开一轮：同需求续推 ⇒ 复用同一 contextId、round 递增（澄清续推 / 重派）", () => {
  let seq = 0;
  const make = () => `board-ctx-${String(++seq)}`;
  const one = openSession(emptyTurnLedger(), { requirementId: "R1", org: "flow", at: "t1" }, make);
  const two = openSession(one.ledger, { requirementId: "R1", org: "flow", at: "t2" }, make);
  const three = openSession(two.ledger, { requirementId: "R1", org: "flow", at: "t3" }, make);
  assert.equal(two.contextId, one.contextId);
  assert.equal(three.contextId, one.contextId);
  assert.equal(three.round, 3);
  assert.equal(seq, 1, "续推不得再分配第二个 contextId");
  assert.equal(three.ledger.requirements.length, 1);
});

test("开一轮：跨需求各分一个 contextId，绝不共享", () => {
  let seq = 0;
  const make = () => `board-ctx-${String(++seq)}`;
  let ledger = emptyTurnLedger();
  const a = openSession(ledger, { requirementId: "RA", org: "flow", at: "t1" }, make);
  ledger = a.ledger;
  const b = openSession(ledger, { requirementId: "RB", org: "flow", at: "t1" }, make);
  assert.notEqual(a.contextId, b.contextId);
  assert.equal(a.round, 1);
  assert.equal(b.round, 1);
});

// ---------------------------------------------------------------------------
// 轮记录 upsert / 历史裁剪
// ---------------------------------------------------------------------------

function turn(turnId, state, queuedAt = "2026-09-24T00:00:00.000Z") {
  return {
    turnId,
    requirementId: "R1",
    org: "flow",
    contextId: "board-ctx-1",
    taskId: `task-${turnId}`,
    state,
    summary: null,
    question: null,
    error: null,
    bridgeNote: null,
    receipt: null,
    queuedAt,
    startedAt: null,
    finishedAt: null,
    updatedAt: queuedAt,
  };
}

test("轮记录按 turnId upsert：同一轮多次收口只留最后一条（不堆积历史）", () => {
  let ledger = upsertTurn(emptyTurnLedger(), turn("T1", "queued"));
  ledger = upsertTurn(ledger, turn("T1", "running"));
  ledger = upsertTurn(ledger, turn("T1", "succeeded"));
  assert.equal(ledger.turns.length, 1);
  assert.equal(findTurn(ledger, "T1").state, "succeeded");
});

test("历史裁剪只裁已结束的轮：排队中的轮不会被挤出可见面", () => {
  const closed = Array.from({ length: TURN_HISTORY_CAP }, (_, i) => turn(`c${String(i)}`, "succeeded"));
  const open = [turn("queued-1", "queued"), turn("awaiting-1", "awaiting_answer")];
  const trimmed = trimTurns([...closed, ...open]);
  // 总数回到上限，但**未结束的轮一律保留**（挤掉的只能是已结束的）
  assert.equal(trimmed.length, TURN_HISTORY_CAP);
  assert.ok(trimmed.some((t) => t.turnId === "queued-1"));
  assert.ok(trimmed.some((t) => t.turnId === "awaiting-1"));
  assert.equal(trimmed.filter((t) => t.state === "succeeded").length, TURN_HISTORY_CAP - open.length);
  // 极端：未结束轮本身超上限 ⇒ 不裁它们（宁可超限也不让排队隐形）
  const manyOpen = Array.from({ length: TURN_HISTORY_CAP + 5 }, (_, i) => turn(`o${String(i)}`, "queued"));
  assert.equal(trimTurns(manyOpen).length, TURN_HISTORY_CAP + 5);
});

// ---------------------------------------------------------------------------
// 解析容错
// ---------------------------------------------------------------------------

test("坏数据容错：未知轮态 / 缺关键字段的记录被丢弃，不臆造", () => {
  const ledger = parseTurnLedger({
    requirements: [
      { requirementId: "R1", org: "flow", contextId: "c1", round: 2 },
      { requirementId: "R2", org: "flow" }, // 缺 contextId ⇒ 丢
    ],
    turns: [
      turn("T1", "succeeded"),
      { ...turn("T2", "bogus_state") }, // 未知态 ⇒ 丢
      { turnId: "T3" }, // 缺字段 ⇒ 丢
    ],
  });
  assert.equal(ledger.requirements.length, 1);
  assert.equal(ledger.turns.length, 1);
  assert.equal(ledger.turns[0].turnId, "T1");
});

test("序列化往返：文件形态读回与内存一致", () => {
  let ledger = upsertTurn(emptyTurnLedger(), turn("T1", "awaiting_answer"));
  ledger = {
    ...ledger,
    requirements: [{
      requirementId: "R1",
      org: "flow",
      contextId: "board-c1",
      round: 3,
      firstTurnAt: "t0",
      updatedAt: "t1",
    }],
  };
  const back = parseTurnLedger(JSON.parse(serializeTurnLedger(ledger)));
  assert.deepEqual(back.turns, ledger.turns);
  assert.deepEqual(back.requirements, ledger.requirements);
});

// ---------------------------------------------------------------------------
// receipt 字段（v0.9.6 · REQ-2026-09-30-02 · N2）
// ---------------------------------------------------------------------------

test("receipt：带回执的轮记录序列化往返保真（RMW 回路不静默丢字段）", () => {
  const receipt = { head: ["改了台账解析", "补了三条锚"], todo: ["① 是否发版"], next: "等用户验收" };
  const rec = { ...turn("T1", "succeeded"), receipt };
  const back = parseTurnLedger(JSON.parse(serializeTurnLedger(upsertTurn(emptyTurnLedger(), rec))));
  assert.equal(back.turns.length, 1);
  assert.deepEqual(back.turns[0].receipt, receipt);
  // 真正的风险面 = 存盘的 read-modify-write 回路（漏解析 ⇒ 静默丢弃、无告警）
  const dir = mkdtempSync(join(tmpdir(), "board-turn-receipt-"));
  const store = new HostTurnLedgerStore(join(dir, "host-turns.json"));
  store.recordTurn(rec);
  assert.deepEqual(new HostTurnLedgerStore(store.file).load().ledger.turns[0].receipt, receipt);
});

test("receipt：旧记录（文件里根本没有该键）解析为 null，记录本身不丢", () => {
  const legacy = { ...turn("T1", "succeeded") };
  delete legacy.receipt;
  const rec = parseTurnRecord(legacy);
  assert.ok(rec);
  assert.equal(rec.receipt, null);
});

test("receipt：结构损坏（缺键 / 类型不符）解析为 null，不臆造也不丢整条记录", () => {
  const missingKey = parseTurnRecord({ ...turn("T1", "succeeded"), receipt: { head: ["a"], next: "b" } });
  assert.ok(missingKey);
  assert.equal(missingKey.receipt, null);
  const wrongType = parseTurnRecord({ ...turn("T2", "succeeded"), receipt: { head: "a", todo: [], next: "b" } });
  assert.ok(wrongType);
  assert.equal(wrongType.receipt, null);
});

// ---------------------------------------------------------------------------
// 文件台账
// ---------------------------------------------------------------------------

test("HostTurnLedgerStore：openTurn 落文件（分配 + 复用）", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-turn-ledger-"));
  const store = new HostTurnLedgerStore(join(dir, "host-turns.json"));
  const first = store.openTurn({ requirementId: "R1", org: "flow", at: "t1" }, () => "board-ctx-x");
  assert.deepEqual(first, { contextId: "board-ctx-x", round: 1 });
  const second = store.openTurn({ requirementId: "R1", org: "flow", at: "t2" }, () => "should-not-be-used");
  assert.deepEqual(second, { contextId: "board-ctx-x", round: 2 });
  assert.match(readFileSync(store.file, "utf8"), /board-ctx-x/);

  const next = store.recordTurn(turn("T1", "running"));
  assert.equal(findTurn(next, "T1").state, "running");
  // 重读 = 同一事实源（进程重启后靠它恢复历史，运行态不跨进程）
  const reread = new HostTurnLedgerStore(store.file).load();
  assert.equal(reread.corrupt, false);
  assert.equal(findTurn(reread.ledger, "T1").state, "running");
});

test("HostTurnLedgerStore：坏文件标 corrupt，不静默当成「没有记录」", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-turn-ledger-"));
  const file = join(dir, "host-turns.json");
  writeFileSync(file, "{ not json", "utf8");
  const loaded = new HostTurnLedgerStore(file).load();
  assert.equal(loaded.corrupt, true);
  assert.deepEqual(loaded.ledger.turns, []);
});
