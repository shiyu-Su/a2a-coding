/**
 * `machine/acp-bridge/outcome.ts` 定向单测（REQ-v0.8.0-2026-09-19-01 · 节点 B5）。
 *
 * 判据：outcome 三类解析回退（无块 / input-required / failed / 非法块 / 未知 state / 多块）
 * + 约定文本注入通道（P1 探针结论 = prompt-prefix）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  A2A_OUTCOME_CONVENTION,
  OUTCOME_INJECTION_CHANNEL,
  countValidOutcomeBlocks,
  parseOutcome,
  parseOutcomeFromGroups,
  withOutcomeConvention,
} from "../acp-bridge/outcome.js";

test("outcome 解析：无块 → completed 回退，matched=false，文本原样", () => {
  const result = parseOutcome("done, all good");
  assert.equal(result.state, "completed");
  assert.equal(result.matched, false);
  assert.equal(result.text, "done, all good");
});

test("outcome 解析：input-required 块 → state + question，块被移除", () => {
  const text = 'waiting\n\n```a2a-outcome\n{"state":"input-required","question":"which env?"}\n```';
  const result = parseOutcome(text);
  assert.equal(result.state, "input-required");
  assert.equal(result.matched, true);
  assert.equal(result.question, "which env?");
  assert.equal(result.text, "waiting");
});

test("outcome 解析：failed 块 → state + reason，块被移除", () => {
  const text = 'cannot proceed\n```a2a-outcome\n{"state":"failed","reason":"auth missing"}\n```';
  const result = parseOutcome(text);
  assert.equal(result.state, "failed");
  assert.equal(result.matched, true);
  assert.equal(result.reason, "auth missing");
  assert.equal(result.text, "cannot proceed");
});

test("outcome 解析：块 JSON 非法 → 回退 completed（matched=false）", () => {
  const text = "x\n```a2a-outcome\n{not json}\n```";
  const result = parseOutcome(text);
  assert.equal(result.state, "completed");
  assert.equal(result.matched, false);
  assert.equal(result.text, "x");
});

test("outcome 解析：未知 state → 回退 completed（matched=true）", () => {
  const text = 'x\n```a2a-outcome\n{"state":"weird"}\n```';
  const result = parseOutcome(text);
  assert.equal(result.state, "completed");
  assert.equal(result.matched, true);
  assert.equal(result.text, "x");
});

test("outcome 解析：多个块 → 以最后一个为准", () => {
  const text =
    'a\n```a2a-outcome\n{"state":"input-required","question":"q1"}\n```\nmid\n```a2a-outcome\n{"state":"failed","reason":"r2"}\n```';
  const result = parseOutcome(text);
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "r2");
});

// ---------- v0.8.9 · M3：出参扩键 + 分组入口 ----------

test("M3 扩键：无块 → blockCount=0 / lastBlockIndex=-1", () => {
  const result = parseOutcome("no block here");
  assert.equal(result.blockCount, 0);
  assert.equal(result.lastBlockIndex, -1);
});

test("M3 扩键：单有效块 → blockCount=1 / lastBlockIndex=0", () => {
  const text = 'x\n```a2a-outcome\n{"state":"failed","reason":"r"}\n```';
  const result = parseOutcome(text);
  assert.equal(result.blockCount, 1);
  assert.equal(result.lastBlockIndex, 0);
});

test("M3 扩键：非结构有效块不计入 blockCount（非法 JSON / 非对象）", () => {
  const text =
    'x\n```a2a-outcome\n{not json}\n```\n```a2a-outcome\n[1,2]\n```\n```a2a-outcome\n{"state":"failed","reason":"r"}\n```';
  const result = parseOutcome(text);
  assert.equal(result.state, "failed");
  assert.equal(result.blockCount, 1);
  assert.equal(result.lastBlockIndex, 0);
  assert.equal(countValidOutcomeBlocks(text), 1);
});

test("M3 扩键：末块非法 ⇒ 回退 completed 且 lastBlockIndex=-1（有效块仍计入 blockCount）", () => {
  const text = 'x\n```a2a-outcome\n{"state":"failed","reason":"r"}\n```\n```a2a-outcome\n{broken\n```';
  const result = parseOutcome(text);
  assert.equal(result.state, "completed");
  assert.equal(result.matched, false);
  assert.equal(result.blockCount, 1);
  assert.equal(result.lastBlockIndex, -1);
});

test("M3 分组入口：单轮单块与 parseOutcome 逐字等价", () => {
  const samples: string[] = [
    "done, all good",
    'waiting\n```a2a-outcome\n{"state":"input-required","question":"q"}\n```',
    'x\n```a2a-outcome\n{"state":"failed","reason":"r"}\n```',
    "x\n```a2a-outcome\n{not json}\n```",
    'x\n```a2a-outcome\n{"state":"weird"}\n```',
    'a\n```a2a-outcome\n{"state":"input-required","question":"q1"}\n```\nmid\n```a2a-outcome\n{"state":"failed","reason":"r2"}\n```',
  ];
  for (const text of samples) {
    assert.deepEqual(
      parseOutcomeFromGroups([{ messageId: "m1", chunks: [text] }]),
      parseOutcome(text),
      `单组等价失败: ${text.slice(0, 20)}`,
    );
  }
});

test("M3 分组入口：末块按最后一个含块 messageGroup 定位", () => {
  // 块① 在组 m1（较早消息），块② 在组 m2（最后一个含块组）⇒ 以 m2 的块为准
  const groups = [
    { messageId: "m1", chunks: ['a\n```a2a-outcome\n{"state":"failed","reason":"r1"}\n```'] },
    { messageId: "m2", chunks: ['\nmid\n```a2a-outcome\n{"state":"input-required","question":"q2"}\n```'] },
  ];
  const result = parseOutcomeFromGroups(groups);
  assert.equal(result.state, "input-required");
  assert.equal(result.question, "q2");
  assert.equal(result.blockCount, 2);
  assert.equal(result.lastBlockIndex, 1);
  // 末组无块 ⇒ 仍取最后一个含块组（m1）的块
  const trailing = parseOutcomeFromGroups([...groups.slice(0, 1), { messageId: "m3", chunks: ["tail"] }]);
  assert.equal(trailing.state, "failed");
  assert.equal(trailing.reason, "r1");
  assert.equal(trailing.blockCount, 1);
});

test("M3 分组入口：chunk 打散不改变结果（组内串接 == 全文拼接）", () => {
  const text = 'x\n```a2a-outcome\n{"state":"failed","reason":"r"}\n```';
  const byChunks = parseOutcomeFromGroups([
    { messageId: "m1", chunks: ["x\n```a2a-out", "come\n"] },
    { messageId: "m1", chunks: ['{"state":"failed","reason":"r"}\n', "```"] },
  ]);
  assert.deepEqual(byChunks, parseOutcome(text));
});

test("outcome 注入通道：prompt-prefix（P1 探针结论）+ 前缀含约定全文", () => {
  assert.equal(OUTCOME_INJECTION_CHANNEL, "prompt-prefix");
  const injected = withOutcomeConvention("do the thing");
  assert.ok(injected.startsWith(A2A_OUTCOME_CONVENTION));
  assert.ok(injected.endsWith("do the thing"));
  assert.equal(withOutcomeConvention(""), A2A_OUTCOME_CONVENTION);
});
