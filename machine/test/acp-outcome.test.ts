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
  parseOutcome,
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

test("outcome 注入通道：prompt-prefix（P1 探针结论）+ 前缀含约定全文", () => {
  assert.equal(OUTCOME_INJECTION_CHANNEL, "prompt-prefix");
  const injected = withOutcomeConvention("do the thing");
  assert.ok(injected.startsWith(A2A_OUTCOME_CONVENTION));
  assert.ok(injected.endsWith("do the thing"));
  assert.equal(withOutcomeConvention(""), A2A_OUTCOME_CONVENTION);
});
