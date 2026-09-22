/**
 * 配置面键位断言（REQ-v0.8.2-2026-09-20-01 · M4 设立；REQ-v0.8.4-2026-09-20-01 · M3 翻向）
 * —— `resolveAcpModel`。
 *
 * v0.8.4 定稿的键位纪律：**自消费键平铺 / 外包契约键分段** —— `model` 的读者 =
 * machine adapter（读出后经 `--model` 透传给桥）⇒ **顶层平铺键** `agentConfig.model`；
 * 段内 `agentConfig.<kind>.model`（qoder / opencode 段）为**遗留键**，不消费（视同未配，
 * 启动告警见 `adapters.test.ts` 遗留键锚）。值语义 = 原样透传：只判「非空字符串」，
 * 不 trim、不校验、不映射（校验归后端）。wrapper 族的段内 `model` 是外部契约，另议。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAcpModel } from "../launcher/agent-config.js";

test("M4 配置面（v0.8.4 翻向）：读顶层平铺 agentConfig.model，值原样返回（不 trim / 不加工）", () => {
  assert.equal(resolveAcpModel({ model: "provider/model-x" }), "provider/model-x");
  assert.equal(resolveAcpModel({ model: "GLM-4.7 (max)" }), "GLM-4.7 (max)");
  assert.equal(resolveAcpModel({ model: " 空格原样  " }), " 空格原样  ");
});

test("M4 负向锚点（v0.8.4 翻向）：段内 model 一律不读（遗留键视同未配，不做段回退）", () => {
  assert.equal(resolveAcpModel({ "qoder-cn": { model: "seg-should-be-ignored" } }), undefined);
  assert.equal(resolveAcpModel({ opencode: { model: "seg-should-be-ignored" } }), undefined);
  // 平铺键缺失 ⇒ 不因段内值兜底
  assert.equal(
    resolveAcpModel({ backendCmd: "b", "qoder-cn": { model: "seg", systemPromptAppend: "x" } }),
    undefined,
  );
});

test("M4 平铺优先（v0.8.4）：平铺与遗留段内并存 ⇒ 只取平铺值，段内不掺入", () => {
  assert.equal(
    resolveAcpModel({ model: "flat", "qoder-cn": { model: "legacy-segment" } }),
    "flat",
  );
});

test("M4 宽容缺省：agentConfig 缺失 / 平铺 model 非字符串或空串 ⇒ undefined（= 零回退路径）", () => {
  const cases: Array<Record<string, unknown> | undefined> = [
    undefined,
    {},
    { backendCmd: "b" },
    { model: "" },
    { model: 42 },
    { model: null },
    { model: true },
    { model: ["m"] },
  ];
  for (const agentConfig of cases) {
    assert.equal(resolveAcpModel(agentConfig), undefined);
  }
});
