/**
 * M4 断言收口（REQ-v0.8.2-2026-09-20-01）—— `resolveAcpModel`（配置面键位）。
 *
 * 锁定 v0.8.2 的键位纪律：`model` 由 ACP 后端消费 ⇒ **分段键** `agentConfig.<kind>.model`；
 * **平铺 `model` 键不存在**（machine 自消费键只有 `backendCmd` / `timeouts` 等，不得新增）。
 * 值语义 = 原样透传：只判「非空字符串」，不 trim、不校验、不映射（校验归后端）。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAcpModel } from "../launcher/agent-config.js";

test("M4 配置面：只读 agentConfig.<kind>.model，值原样返回（不 trim / 不加工）", () => {
  assert.equal(resolveAcpModel({ qoder: { model: "provider/model-x" } }, "qoder"), "provider/model-x");
  assert.equal(
    resolveAcpModel({ opencode: { model: "GLM-4.7 (max)" } }, "opencode"),
    "GLM-4.7 (max)",
  );
  assert.equal(resolveAcpModel({ qoder: { model: " 空格原样  " } }, "qoder"), " 空格原样  ");
});

test("M4 负向锚点：平铺 model 键一律不读（不新增平铺键）", () => {
  assert.equal(resolveAcpModel({ model: "flat-should-be-ignored" }, "qoder"), undefined);
  // 段内无 model ⇒ 不因平铺键兜底
  assert.equal(
    resolveAcpModel({ backendCmd: "b", model: "flat", qoder: { systemPromptAppend: "x" } }, "qoder"),
    undefined,
  );
});

test("M4 段隔离：其它 kind 的段不作数（kind 选择器严格）", () => {
  const config = { opencode: { model: "oc-model" } };
  assert.equal(resolveAcpModel(config, "qoder"), undefined);
  assert.equal(resolveAcpModel(config, "opencode"), "oc-model");
});

test("M4 宽容缺省：agentConfig 缺失 / 段非对象 / model 非字符串或空串 ⇒ undefined（= 零回退路径）", () => {
  const cases: Array<Record<string, unknown> | undefined> = [
    undefined,
    {},
    { qoder: "oops" },
    { qoder: ["m"] },
    { qoder: null },
    { qoder: {} },
    { qoder: { model: "" } },
    { qoder: { model: 42 } },
    { qoder: { model: null } },
    { qoder: { model: true } },
  ];
  for (const agentConfig of cases) {
    assert.equal(resolveAcpModel(agentConfig, "qoder"), undefined);
  }
});
