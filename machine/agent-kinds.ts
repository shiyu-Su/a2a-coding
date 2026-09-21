/**
 * machine 侧 agentKind 取值集合的**唯一声明源**（零依赖叶模块）。
 *
 * 只声明取值集合与派生类型，**不得 import 仓内任何其它模块**（避免 import 环 /
 * 分层倒置：`config` / `launcher` / `adapters` 均可依赖本模块，本模块不反向依赖）。
 * `types.ts` 对本类型做 re-export，既有 import 站点无需改动。
 *
 * 与 orch 侧 `orch/types.ts` 的 `AGENT_KINDS` 各自派生、不共享代码；两侧一致性由
 * 回归断言「本地清单 == PROTOCOL.md 锚点」锁定（见改造文档 §2.1）。
 */
export const AGENT_KINDS = ["opencode", "codex", "claude", "qoder"] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * `agentConfig` **顶层平铺命名空间**的保留键（REQ-v0.8.4-2026-09-20-01 · M3 锚定）：
 * 任何 kind 段键（= {@link AGENT_KINDS} 成员）不得与此重名，否则平铺自消费键会与
 * 分段 wrapper 契约命名空间撞车。
 *
 * **「保留」= 命名空间占用，≠ 本需求提供平铺读点** —— 当前实际具备平铺读点的仅
 * `backendCmd` / `model`（见 `launcher/agent-config.ts`）；其余为既有顶层键
 * （wrapper 契约 / 观测键）的占位登记。
 */
export const RESERVED_AGENT_CONFIG_FLAT_KEYS = [
  "backendCmd",
  "model",
  "systemPrompt",
  "systemPromptMode",
  "timeouts",
  "agentCard",
  "events",
  "mcp",
] as const;
