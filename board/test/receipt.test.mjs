/**
 * 回执契约叶模块用例（REQ-2026-09-30-02 · v0.9.6 · 改造文档 §2-1 / §4 实现级锚）。
 * 覆盖：正例匹配 / 无块 null / 多空行 / 中文冒号 / 围栏后尾部命中 / MCP 工具全名缺席锚。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RECEIPT_CONTRACT, parseReceiptBlock } from "../dist/receipt.js";

test("正例：三键齐全 ⇒ head/todo/next 结构化", () => {
  const text = [
    "前面一堆正文……",
    "【回执】",
    "要点:",
    "- 建了叶模块",
    "- 补了测试",
    "待用户: ①是否合入 ②版本号",
    "下一步: 接线收口点",
  ].join("\n");
  assert.deepEqual(parseReceiptBlock(text), {
    head: ["建了叶模块", "补了测试"],
    todo: ["是否合入", "版本号"],
    next: "接线收口点",
  });
});

test("无块 ⇒ null；待用户「无」⇒ 空清单", () => {
  assert.equal(parseReceiptBlock("普通收尾，没有回执块"), null);
  const r = parseReceiptBlock("【回执】\n要点:\n- 只有要点\n待用户: 无\n下一步: 继续");
  assert.deepEqual(r?.todo, []);
});

test("多空行容错：块与键之间多段空行仍命中", () => {
  const text = "【回执】\n\n\n要点:\n\n- a\n\n待用户: ①x\n\n下一步: n";
  assert.deepEqual(parseReceiptBlock(text), { head: ["a"], todo: ["x"], next: "n" });
});

test("中文冒号 + 全半角混用容错", () => {
  const text = "【回执】\n要点：\n- 甲\n待用户：①乙\n下一步：丙";
  assert.deepEqual(parseReceiptBlock(text), { head: ["甲"], todo: ["乙"], next: "丙" });
});

test("围栏后尾部命中：桥剥 ```a2a-outcome 围栏后文本尾仍解析", () => {
  const text = [
    "正文",
    "```a2a-outcome",
    "{\"state\":\"completed\"}",
    "```",
    "【回执】",
    "要点:",
    "- 收尾",
    "待用户: 无",
    "下一步: 等验收",
  ].join("\n");
  assert.deepEqual(parseReceiptBlock(text), { head: ["收尾"], todo: [], next: "等验收" });
});

test("契约文案锚：含两条硬规则且无任何 MCP 工具全名", () => {
  assert.match(RECEIPT_CONTRACT, /最末尾/);
  assert.match(RECEIPT_CONTRACT, /a2a-outcome/);
  // MCP 工具全名形如 a2a_call / a2a_feature_create（下划线族）——契约文案不得出现。
  assert.doesNotMatch(RECEIPT_CONTRACT, /a2a_[a-z]/i);
});
