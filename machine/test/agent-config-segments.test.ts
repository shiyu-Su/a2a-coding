/**
 * `agentConfig` 平铺读取器（REQ-v0.8.5-2026-09-21-01 · M4）。
 *
 * 本文件原为「`DEFAULT_AGENT_CONFIG` 段一致性」断言；段与配置通道（`writeAgentConfig` /
 * `deepMerge` / `agents/` 产物）整体退役后，**段一致性断言改为平铺断言**：
 * 锁 `resolveSystemPrompt` / `resolveSystemPromptMode` 的宽容缺省口径，并以负向锚点锁
 * 「段与通道产物不再导出」。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as agentConfig from "../launcher/agent-config.js";
import { AGENT_KINDS, RESERVED_AGENT_CONFIG_FLAT_KEYS } from "../agent-kinds.js";

// ---- 平铺 reader 口径（v0.8.5 · M4：自定义注入改走 `--system-prompt(Mode)`）----

test("resolveSystemPrompt：非空字符串原样；缺键 / 空串 / 非字符串 ⇒ undefined", () => {
  assert.equal(agentConfig.resolveSystemPrompt({ systemPrompt: "be terse" }), "be terse");
  assert.equal(agentConfig.resolveSystemPrompt({}), undefined);
  assert.equal(agentConfig.resolveSystemPrompt({ systemPrompt: "" }), undefined);
  assert.equal(agentConfig.resolveSystemPrompt({ systemPrompt: 42 }), undefined);
  assert.equal(agentConfig.resolveSystemPrompt(undefined), undefined);
});

test("resolveSystemPromptMode：仅 append / replace；其余（含非法串）⇒ undefined（桥缺省 append）", () => {
  assert.equal(agentConfig.resolveSystemPromptMode({ systemPromptMode: "append" }), "append");
  assert.equal(agentConfig.resolveSystemPromptMode({ systemPromptMode: "replace" }), "replace");
  assert.equal(agentConfig.resolveSystemPromptMode({ systemPromptMode: "bogus" }), undefined);
  assert.equal(agentConfig.resolveSystemPromptMode({}), undefined);
  assert.equal(agentConfig.resolveSystemPromptMode(undefined), undefined);
});

// ---- 负向锚点：段与配置通道产物不再导出 ----

test("负向锚点：writeAgentConfig / DEFAULT_AGENT_CONFIG / deepMerge 随段退役不再导出", () => {
  for (const retired of ["writeAgentConfig", "DEFAULT_AGENT_CONFIG", "deepMerge"]) {
    assert.equal(retired in agentConfig, false, `${retired} 应随「段与配置通道整体退役」消失`);
  }
  // outcome 约定的 re-export 保留（既有 import 站点零改动）
  assert.equal(typeof agentConfig.A2A_OUTCOME_CONVENTION, "string");
});

// ---- REQ-v0.8.4-2026-09-20-01 · M3 防撞锚：kind 段命名空间与平铺保留键互斥 ----

test("防撞锚：AGENT_KINDS ∩ 保留平铺键 = ∅（分段契约与平铺自消费键不撞车）", () => {
  const reserved = new Set<string>(RESERVED_AGENT_CONFIG_FLAT_KEYS);
  for (const kind of AGENT_KINDS) {
    assert.equal(
      reserved.has(kind),
      false,
      `kind 段键「${kind}」不得占用平铺保留命名空间（保留 = 命名空间占用，≠ 平铺读点）`,
    );
  }
});
