/**
 * 「a2a-outcome」约定文案 —— **零依赖叶模块**（不 import 仓内任何其它模块）。
 *
 * 归属：REQ-v0.8.0-2026-09-19-01 · 节点 M1。本常量自 `launcher/agent-config.ts`
 * **原文逐字搬迁**（值零变化），动机 = 消除未来 `acp-bridge → launcher` 的依赖倒置：
 * launcher（适配器 baseConfig / DEFAULT_AGENT_CONFIG）与未来的 ACP 桥均从本叶模块取用，
 * 本模块不得反向依赖任何仓内模块（保持零依赖，作为分层中的叶）。
 *
 * 原始语义（v0.3.1 机制②）：「显式状态标记」约定文案（三端统一、简短、确定性）。
 * worker 在「需要人工拍板」或「确认无法完成」时，于回复末尾输出一个
 * fenced `a2a-outcome` JSON 块；`@a2a-wrapper/core` 的 `resolveOutcome`
 * 在收口点解析后映射为标准 A2A 任务态（input-required / failed）；正常完成
 * 不输出该块（回退 completed）。文案经三端 wrapper 的 systemPrompt 类通道注入。
 */
const A2A_OUTCOME_CONVENTION_LINES = [
  "A2A task outcome convention (follow exactly):",
  "1) If you need the user to decide something before you can continue, end your reply with this fenced block (replace the placeholder):",
  "```a2a-outcome",
  '{"state":"input-required","question":"<the question for the user>"}',
  "```",
  "2) If you are certain the task cannot be completed or is blocked, end your reply with:",
  "```a2a-outcome",
  '{"state":"failed","reason":"<why it is blocked>"}',
  "```",
  "3) On a normal successful completion, do NOT output any a2a-outcome block.",
  "Output at most one such block, and only as the very last thing in your reply.",
];

/** 三端共用的约定文案（供适配器 baseConfig() 绑定到各自的 systemPrompt 类配置键）。 */
export const A2A_OUTCOME_CONVENTION = A2A_OUTCOME_CONVENTION_LINES.join("\n");
