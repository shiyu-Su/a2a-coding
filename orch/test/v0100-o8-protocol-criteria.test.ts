/**
 * v0.10.0 O8（REQ-v0.10.0-2026-09-24-01 · 改造文档 §2.2）——
 * **`PROTOCOL.md` 协议规则自洽化（判据式）+ 演进记录加 `repo` 行；常量保持 2.3 不升版**。
 *
 * 静态锚（读仓根 `PROTOCOL.md`，不启服务、不联网）：
 * 1. **版本规则第一条改判据式**：`可被对端完全忽略且不影响任何判定 / 消费语义 ⇒ 不升版`；
 *    另一支 `引入新可观测行为 ... ⇒ minor +1`；
 * 2. **删矛盾尾句**：`未知字段忽略` 段不再夹带 `minor` 升级主张（旧「加可选字段 → minor +1」已除）；
 * 3. **v0.8.8 裁定保留 + 升为一般判据**的接续句在位；
 * 4. **演进记录加 `repo` 行**：可选字段、可忽略、**不升版**、沿用 2.3；
 * 5. **协议常量保持 `2.3`**（`repo` 为纯可忽略可选字段 ⇒ 不升版；本版断言不翻版）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../types.js";

/** 仓根 `PROTOCOL.md`（dist/test → 上溯三级 = 仓根） */
function protocolText(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "..", "..", "..", "PROTOCOL.md"), "utf8");
}

function lineWith(text: string, needle: string): string {
  const line = text.split(/\r?\n/).find((l) => l.includes(needle));
  assert.ok(line !== undefined, `PROTOCOL.md 应含「${needle}」所在行`);
  return line ?? "";
}

test("O8 协议常量保持 2.3（repo = 可忽略可选字段 ⇒ 不升版，断言不翻版）", () => {
  assert.equal(PROTOCOL_VERSION, "2.3", "PROTOCOL_VERSION 必须保持 2.3（不因新增 repo 升版）");
});

test("O8 版本规则第一条：判据式（可完全忽略且不影响判定/消费 ⇒ 不升版；引入新可观测行为 ⇒ minor+1）", () => {
  const text = protocolText();
  const rule = lineWith(text, "**加可选字段**（请求或响应）");
  assert.match(rule, /以判据为准，不默认升版/, "首句须为「以判据为准、不默认升版」");
  assert.match(rule, /可被对端完全忽略且不影响任何判定 \/ 消费语义/, "判据支一：可完全忽略 ⇒ 不升版");
  assert.match(rule, /引入新可观测行为/, "判据支二：引入新可观测行为 ⇒ minor+1");
});

test("O8 已删矛盾尾句：未知字段忽略段不夹带 minor 升级主张", () => {
  const text = protocolText();
  const unknownFields = lineWith(text, "**未知字段忽略**");
  assert.ok(!unknownFields.includes("minor"), "旧「加可选字段 → minor +1」尾句已删（不得回潮）");
  // 对照：判据式的「minor +1」仍只在版本规则条目内（不在宽容解析段）
  assert.match(lineWith(text, "**加可选字段**（请求或响应）"), /minor \+1/);
});

test("O8 v0.8.8 裁定保留 + 升为版本规则一般判据的接续句在位", () => {
  const text = protocolText();
  assert.match(text, /仅新增可忽略的可选字段本身不触发升版/, "v0.8.8 结论不动");
  assert.match(text, /本裁定的判据已升为版本规则一般判据/, "段尾接续句在位（消除自相矛盾）");
});

test("O8 演进记录含 repo 行：可选 / 可忽略 / 不升版 / 沿用 2.3", () => {
  const text = protocolText();
  const row = lineWith(text, "注册载荷新增**可选字段 `repo`**");
  assert.match(row, /v0\.10\.0/, "行须标注 v0.10.0");
  assert.match(row, /不升版/, "明确不升版");
  assert.match(row, /沿用 2\.3/, "沿用 2.3");
  assert.match(row, /可被对端完全忽略|可忽略/, "可忽略判定");
});
