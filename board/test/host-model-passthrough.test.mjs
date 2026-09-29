/**
 * REQ-2026-09-28-10 v0.9.5 · 板宿主桥模型透传（hostModel）· T1 单测。
 *
 * 覆盖改造文档 §2 C1/C2 判据，复用 `orgBridgeConfig` 既有注入面（不新增导出、不碰 --workspace 口径）：
 * ① 配置解析进 BoardConfig（有值原样 / 缺省 null / 空串同 null / 端到端 loadConfig）
 * ② 未知键仍忽略，不影响 hostModel
 * ③ orgBridgeConfig 缺省 null 不注入 agentConfig
 * ④ 有值 ⇒ agentConfig 原样只含 model 一键
 * ⑤ 空串同 null（不注入）
 * ⑥ 非字符串 ⇒ `[config] hostModel` fail-fast
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_PATH_ENV, loadConfig, validateConfig } from "../dist/config.js";
import { orgBridgeConfig } from "../dist/host-face.js";

const SRC = "t://config.json";

test("C1-①配置解析进 BoardConfig：hostModel 有值 trim 后原样、缺省 / 空串 ⇒ null", () => {
  assert.equal(
    validateConfig({ hostModel: "opencode-go/deepseek-v4.1-flash" }, SRC).hostModel,
    "opencode-go/deepseek-v4.1-flash",
  );
  assert.equal(validateConfig({ hostModel: "  gpt-5  " }, SRC).hostModel, "gpt-5", "取值 trim");
  assert.equal(validateConfig({}, SRC).hostModel, null, "缺键 ⇒ null（不透传）");
  assert.equal(validateConfig({ hostModel: null }, SRC).hostModel, null);
  assert.equal(validateConfig({ hostModel: "" }, SRC).hostModel, null, "空串同 null");
  assert.equal(validateConfig({ hostModel: "   " }, SRC).hostModel, null, "纯空白同 null");
});

test("C1-①b（防解析了不进 BoardConfig）返回字面量确实携带 hostModel 键", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(validateConfig({}, SRC), "hostModel"), true);
});

test("C1-③端到端 loadConfig：hostModel 从文件解析进 BoardConfig（_ 注释键被忽略）", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-hostmodel-"));
  const path = join(dir, "config.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({ _hostModelComment: "注释键不该参与解析", hostModel: "opencode-go/deepseek-v4.1-flash" }),
      "utf8",
    );
    assert.equal(loadConfig({ [CONFIG_PATH_ENV]: path }).hostModel, "opencode-go/deepseek-v4.1-flash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C1-②未知键仍忽略，不影响 hostModel 解析", () => {
  assert.equal(
    validateConfig({ futureKnob: { deep: true }, anotherString: "x", hostModel: "m1" }, SRC).hostModel,
    "m1",
  );
  assert.equal(
    validateConfig({ futureKnob: 1, anotherString: "x" }, SRC).hostModel,
    null,
    "未知键在场 ⇒ hostModel 仍为缺省 null",
  );
});

test("C1-⑥（负向）hostModel 非字符串 ⇒ `[config] hostModel` fail-fast（不静默降级）", () => {
  for (const bad of [5, true, {}, []]) {
    assert.throws(
      () => validateConfig({ hostModel: bad }, SRC),
      (err) => err instanceof Error && /^\[config\] hostModel/.test(err.message),
      `hostModel=${JSON.stringify(bad)} 必须被拒`,
    );
  }
});

test("C2-③(⑤)缺省 null / undefined / 空串 ⇒ 不注入 agentConfig（后端自身缺省）", () => {
  // 注：纯空白由**配置层** optString（trim）归一为 null（见 C1-①「纯空白同 null」），
  // 故 orgBridgeConfig 这一层的判据 = `!= null && !== ""`（改造文档 §2 C2 指定的条件装配）。
  for (const hostModel of [undefined, null, ""]) {
    const deps = { orgsDir: "/orgs-root", kind: "claude" };
    if (hostModel !== undefined) deps.hostModel = hostModel;
    const config = orgBridgeConfig(deps, "某组织");
    assert.equal("error" in config, false, `hostModel=${JSON.stringify(hostModel)} 不应产出结构化错误`);
    assert.equal(config.agentConfig, undefined, `hostModel=${JSON.stringify(hostModel)} ⇒ 不注入`);
  }
});

test("C2-④有值 ⇒ agentConfig 原样只含 model 一键（且 workspace/org 口径不动）", () => {
  const model = "opencode-go/deepseek-v4.1-flash";
  const config = orgBridgeConfig({ orgsDir: "/orgs-root", kind: "opencode", hostModel: model }, "某组织");
  assert.equal("error" in config, false);
  assert.deepEqual(config.agentConfig, { model }, "agentConfig 原样 = { model }");
  assert.deepEqual(Object.keys(config.agentConfig), ["model"], "只放 model 一键（不含 backendCmd 等）");
  assert.equal(config.org, "某组织");
  assert.equal(config.kind, "opencode");
});
