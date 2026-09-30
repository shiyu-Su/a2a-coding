/**
 * t14 · 轮回执契约常量四处 prompt 引用（REQ-2026-09-30-02 · Feature b65b4974 · v0.9.6 · §2-6）。
 *
 * 覆盖：四个 prompt 组装点各含契约关键字 + 「四源同文」契约锚（四处引用同一 RECEIPT_CONTRACT
 * 常量原文，防将来有人抄一份文本造成漂移）；契约文案不含任何 MCP 工具全名。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildTurnPrompt, buildConfirmPrompt } from "../dist/host-face.js";
import { buildRelayPrompt } from "../dist/host-relay.js";
import { buildWakePrompt } from "../dist/heartbeat.js";
import { RECEIPT_CONTRACT } from "../dist/receipt.js";

const KEYWORD = "【回执】";

test("N6-① buildTurnPrompt（首轮/手动/建卡自动首轮）含轮回执契约", () => {
  assert.match(buildTurnPrompt({ featureId: "F1", org: "g" }), new RegExp(KEYWORD));
  assert.ok(buildTurnPrompt({ featureId: "F1", org: "g" }).includes(RECEIPT_CONTRACT));
});

test("N6-② buildConfirmPrompt（确认档 = 一轮收尾）含轮回执契约", () => {
  const p = buildConfirmPrompt({ featureId: "F1", org: "g", version: "v0.9.6" });
  assert.match(p, new RegExp(KEYWORD));
  assert.ok(p.includes(RECEIPT_CONTRACT));
});

test("N6-③ buildRelayPrompt（接力轮）含轮回执契约", () => {
  const p = buildRelayPrompt({ featureId: "F1", org: "g", engine: { state: "executing", stage: "改造", approval: "已通过" } });
  assert.match(p, new RegExp(KEYWORD));
  assert.ok(p.includes(RECEIPT_CONTRACT));
});

test("N6-④ buildWakePrompt（唤醒轮）含轮回执契约", () => {
  const p = buildWakePrompt({ featureId: "F1", org: "g", kind: "pending-ready", reason: "全部就绪", facts: ["t1 completed"] });
  assert.match(p, new RegExp(KEYWORD));
  assert.ok(p.includes(RECEIPT_CONTRACT));
});

test("N6-⑤ 四源同文契约锚：四处引用同一 RECEIPT_CONTRACT 常量原文（防文本漂移）", () => {
  const sources = [
    buildTurnPrompt({ featureId: "F1", org: "g" }),
    buildConfirmPrompt({ featureId: "F1", org: "g" }),
    buildRelayPrompt({ featureId: "F1", org: "g", engine: null }),
    buildWakePrompt({ featureId: "F1", org: "g", kind: "fallback", reason: "stage 未动", facts: [] }),
  ];
  for (const [i, p] of sources.entries()) {
    assert.ok(p.includes(RECEIPT_CONTRACT), `第 ${String(i + 1)} 处须内嵌同一常量全文`);
  }
  // 契约文案不得出现任何 MCP 工具全名（§3.6）
  for (const bad of ["a2a_call", "a2a_feature_approve", "a2a_feature_advance", "a2a_feature_cancel"]) {
    assert.equal(RECEIPT_CONTRACT.includes(bad), false, `契约文案不得出现工具全名 ${bad}`);
  }
});
