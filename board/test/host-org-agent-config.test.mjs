/**
 * REQ-2026-10-03-01 v0.9.8 · 板侧 agent 配置按项目组生效 · T1 单测（host-face 解析侧）。
 *
 * 覆盖改造文档 §2 件2 的「回落序」判据（确认单 §2 拍死口径）：
 * ① 都配 ⇒ 组织两键全用组织值
 * ② 只配 kind ⇒ kind 用组织值，**不沿用全局 model**（全局 model 按全局 kind 命名空间配置，跨适配器必错）
 * ③ 只配 model ⇒ kind 回落全局，model 用组织值
 * ④ 都不配 ⇒ 逐字节同 v0.9.7（全局 kind + 全局 hostModel）
 * ⑤ 闭包未注入 ⇒ 与今日行为逐字节同值（存量零变化回归锚）
 * ⑥ 闭包收参 = trim 后的组织名（照 isOrgDisabled 先例）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { orgBridgeConfig } from "../dist/host-face.js";

const GLOBAL_MODEL = "opencode-go/deepseek-v4.1-flash";

/** 组织都未配的闭包（④格的显式形态）。 */
const noneAgent = () => ({ kind: null, model: null });

test("v0.9.8-①都配：kind / model 全用组织值（agentConfig 仍只含 model 一键）", () => {
  const config = orgBridgeConfig(
    { orgsDir: "/orgs-root", kind: "claude", hostModel: GLOBAL_MODEL, orgHostAgent: () => ({ kind: "qoder", model: "org-m" }) },
    "某组织",
  );
  assert.equal("error" in config, false);
  assert.equal(config.kind, "qoder");
  assert.deepEqual(config.agentConfig, { model: "org-m" });
});

test("v0.9.8-②只配 kind：换适配器 ⇒ 不沿用全局 model（不带 agentConfig，该适配器后端缺省接管）", () => {
  const config = orgBridgeConfig(
    { orgsDir: "/orgs-root", kind: "claude", hostModel: GLOBAL_MODEL, orgHostAgent: () => ({ kind: "qoder", model: null }) },
    "某组织",
  );
  assert.equal("error" in config, false);
  assert.equal(config.kind, "qoder");
  assert.equal(config.agentConfig, undefined, "命名空间规则：全局 model 不跨适配器携带");
});

test("v0.9.8-③只配 model：kind 回落全局，model 用组织值（两项各自取值，不成对）", () => {
  const config = orgBridgeConfig(
    { orgsDir: "/orgs-root", kind: "claude", hostModel: GLOBAL_MODEL, orgHostAgent: () => ({ kind: null, model: "org-m" }) },
    "某组织",
  );
  assert.equal("error" in config, false);
  assert.equal(config.kind, "claude");
  assert.deepEqual(config.agentConfig, { model: "org-m" });
});

test("v0.9.8-④都不配：kind=全局 kind、model=全局 hostModel（与 v0.9.7 同值）", () => {
  const config = orgBridgeConfig(
    { orgsDir: "/orgs-root", kind: "claude", hostModel: GLOBAL_MODEL, orgHostAgent: noneAgent },
    "某组织",
  );
  assert.equal("error" in config, false);
  assert.equal(config.kind, "claude");
  assert.deepEqual(config.agentConfig, { model: GLOBAL_MODEL });
});

test("v0.9.8-④b都不配且全局 hostModel 未配 ⇒ 不注入 agentConfig（口径不变）", () => {
  const config = orgBridgeConfig({ orgsDir: "/orgs-root", kind: "claude", orgHostAgent: noneAgent }, "某组织");
  assert.equal("error" in config, false);
  assert.equal(config.agentConfig, undefined);
});

test("v0.9.8-⑤回归锚：闭包未注入 ⇒ 与「两键皆 null 的闭包」及今日全局取值逐字节同值", () => {
  const legacy = orgBridgeConfig({ orgsDir: "/orgs-root", kind: "opencode", hostModel: GLOBAL_MODEL }, "某组织");
  const injected = orgBridgeConfig(
    { orgsDir: "/orgs-root", kind: "opencode", hostModel: GLOBAL_MODEL, orgHostAgent: noneAgent },
    "某组织",
  );
  assert.deepEqual(injected, legacy, "台账存在但组织未配置 ⇒ 起桥配置零变化（存量零破坏主锚）");
  assert.equal(legacy.kind, "opencode");
  assert.deepEqual(legacy.agentConfig, { model: GLOBAL_MODEL });
});

test("v0.9.8-⑥闭包收参 = trim 后的组织名（照 isOrgDisabled 现读先例）", () => {
  const seen = [];
  orgBridgeConfig(
    { orgsDir: "/orgs-root", kind: "claude", orgHostAgent: (org) => { seen.push(org); return { kind: null, model: null }; } },
    "  flow-team  ",
  );
  assert.deepEqual(seen, ["flow-team"]);
});
