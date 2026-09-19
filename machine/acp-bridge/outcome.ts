/**
 * outcome 约定解析与注入（REQ-v0.8.0-2026-09-19-01 · 节点 B5）。
 *
 * **零仓内依赖**：常量从 M1 下沉的**零依赖叶模块** `../agent-outcome.js` 取用，
 * **不得**从 `launcher/**` import（分层红线：acp-bridge 不依赖 launcher）。
 *
 * 解析语义与现有包装器 `@a2a-wrapper/core` 的 `resolveOutcome` 对齐：
 * - 结尾无 `a2a-outcome` 块 ⇒ `completed`（正常完成回退）；
 * - 有效块 `{"state":"input-required"...}` ⇒ `input-required`；
 * - 有效块 `{"state":"failed"...}` ⇒ `failed`；
 * - 块存在但 JSON 非法 / 结构非法 / 未知 state ⇒ **回退 `completed`**（解析问题绝不误判为失败）。
 */
import { A2A_OUTCOME_CONVENTION } from "../agent-outcome.js";

export { A2A_OUTCOME_CONVENTION };

/** outcome 解析结果（映射到 A2A/Bridge 任务态口径）。 */
export interface OutcomeResult {
  /** 映射后的任务态；缺块 / 解析失败一律回退 `completed`。 */
  state: "completed" | "input-required" | "failed";
  /** 去掉 outcome 块并修剪首尾空白后的回复文本。 */
  text: string;
  /** `input-required` 时的问题（可选）。 */
  question?: string;
  /** `failed` 时的原因（可选）。 */
  reason?: string;
  /** 是否解析到**结构有效**的 outcome 块（用于观测 / 去重口径）。 */
  matched: boolean;
}

/** 匹配 ```a2a-outcome ... ``` 围栏块（捕获其中 JSON 行）。 */
function outcomeBlockRegex(): RegExp {
  return /```a2a-outcome[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析 agent 回复文本中的 outcome 约定块。
 * 多个块时以**最后一个**为准；返回文本已移除全部块。
 */
export function parseOutcome(text: string): OutcomeResult {
  const blockRe = outcomeBlockRegex();
  const matches = [...text.matchAll(blockRe)];
  const last = matches.length > 0 ? matches[matches.length - 1] : undefined;
  const cleaned = text.replace(outcomeBlockRegex(), "").trim();
  if (last === undefined) {
    return { state: "completed", text: cleaned, matched: false };
  }

  const raw = last[1] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    // 解析失败：回退 completed（绝不因解析问题判失败）
    return { state: "completed", text: cleaned, matched: false };
  }
  if (!isRecord(parsed)) {
    return { state: "completed", text: cleaned, matched: false };
  }

  const state = parsed["state"];
  if (state === "input-required") {
    const question = parsed["question"];
    return {
      state: "input-required",
      text: cleaned,
      matched: true,
      ...(typeof question === "string" ? { question } : {}),
    };
  }
  if (state === "failed") {
    const reason = parsed["reason"];
    return {
      state: "failed",
      text: cleaned,
      matched: true,
      ...(typeof reason === "string" ? { reason } : {}),
    };
  }
  // 未知 state / 显式 completed：回退 completed
  return { state: "completed", text: cleaned, matched: true };
}

/**
 * outcome 注入通道（**P1 探针实测结论**）。
 *
 * 探针（`qoderclicn --acp` v1.1.57）实测：`session/new` 参数为 `{ cwd, mcpServers }`，
 * `initialize` 的 `agentCapabilities` 未暴露任何 system-prompt 字段 ⇒ **无 session/new
 * system-prompt 通道**，故采用「**首轮 prompt 前缀**」注入。
 */
export const OUTCOME_INJECTION_CHANNEL = "prompt-prefix" as const;

/**
 * 把 `A2A_OUTCOME_CONVENTION` 前置到首轮 prompt（B3 会话建立时对 `session/prompt` 的
 * `prompt[0].text` 调用）。空 prompt 时返回约定文案本身。
 */
export function withOutcomeConvention(prompt: string): string {
  if (prompt.length === 0) return A2A_OUTCOME_CONVENTION;
  return `${A2A_OUTCOME_CONVENTION}\n\n---\n\n${prompt}`;
}
