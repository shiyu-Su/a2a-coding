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
  /** 本轮**结构有效**的 outcome 块数（v0.8.9 · M3 观测键；与 {@link countValidOutcomeBlocks} 同判据）。 */
  blockCount: number;
  /**
   * 决定 `state` 的块（主规则的「末块」）在有效块序列中的 0 基序号（v0.8.9 · M3 观测键）；
   * 本轮无结构有效块（含末块非法的回退路径）⇒ `-1`。
   */
  lastBlockIndex: number;
}

/** 匹配 ```a2a-outcome ... ``` 围栏块（捕获其中 JSON 行）。 */
function outcomeBlockRegex(): RegExp {
  return /```a2a-outcome[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 围栏块内的 JSON 是否**结构有效**（可解析为对象）；非法 / 非对象 ⇒ `null`。
 * {@link parseOutcome} 的 `matched` 判据与此同源 —— 块数计量与取块判据不得有两套「有效」定义。
 */
function outcomeBlockPayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    return isRecord(parsed) ? parsed : null;
  } catch {
    // 解析失败：回退 completed（绝不因解析问题判失败）
    return null;
  }
}

/**
 * 文本中**结构有效**的 `a2a-outcome` 块数（v0.8.9 · M2 出窗计量 `blockCount` 的事实源）。
 * 只数「围栏存在且 JSON 可解析为对象」的块 —— 残缺块 / 非法 JSON 不计，与
 * {@link parseOutcome} 的 `matched` 同判据（共用 {@link outcomeBlockPayload}）。
 */
export function countValidOutcomeBlocks(text: string): number {
  let count = 0;
  for (const match of text.matchAll(outcomeBlockRegex())) {
    if (outcomeBlockPayload(match[1] ?? "") !== null) count += 1;
  }
  return count;
}

/** 围栏块序列中**结构有效**的块数（与 {@link countValidOutcomeBlocks} 同判据）。 */
function validBlockCount(matches: readonly RegExpMatchArray[]): number {
  let count = 0;
  for (const match of matches) {
    if (outcomeBlockPayload(match[1] ?? "") !== null) count += 1;
  }
  return count;
}

/**
 * 主规则映射（**逐字不动**）：有效块 `input-required` / `failed` 直取，
 * 非法 / 非对象 / 未知 state ⇒ 回退 `completed`；两个入口共用，防止两套回退定义漂移。
 */
function mapOutcome(
  parsed: Record<string, unknown> | null,
  cleaned: string,
  blockCount: number,
  lastBlockIndex: number,
): OutcomeResult {
  if (parsed === null) {
    return { state: "completed", text: cleaned, matched: false, blockCount, lastBlockIndex };
  }
  const state = parsed["state"];
  if (state === "input-required") {
    const question = parsed["question"];
    return {
      state: "input-required",
      text: cleaned,
      matched: true,
      blockCount,
      lastBlockIndex,
      ...(typeof question === "string" ? { question } : {}),
    };
  }
  if (state === "failed") {
    const reason = parsed["reason"];
    return {
      state: "failed",
      text: cleaned,
      matched: true,
      blockCount,
      lastBlockIndex,
      ...(typeof reason === "string" ? { reason } : {}),
    };
  }
  // 未知 state / 显式 completed：回退 completed
  return { state: "completed", text: cleaned, matched: true, blockCount, lastBlockIndex };
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
  const blockCount = validBlockCount(matches);
  if (last === undefined) {
    return { state: "completed", text: cleaned, matched: false, blockCount: 0, lastBlockIndex: -1 };
  }
  const parsed = outcomeBlockPayload(last[1] ?? "");
  return mapOutcome(parsed, cleaned, blockCount, parsed === null ? -1 : blockCount - 1);
}

/**
 * 本轮的一个**消息组**（v0.8.9 · M3 分组入口输入；与桥 `CaptureWindow.groups` 的
 * `MessageGroup` 结构兼容：同 `messageId` 的连续 chunk 归一组，组序 = 到达序）。
 */
export interface OutcomeMessageGroup {
  readonly messageId?: string;
  readonly chunks: readonly string[];
}

/**
 * 按 `messageId` 分组的本轮块序列解析 outcome（v0.8.9 · M3）。
 * 「末块」= **最后一个含围栏块的 messageGroup 里的最后一个围栏块**（按组定位，而非字符偏移）。
 * 单组（= 正常单轮单块）时与 {@link parseOutcome} **逐字等价**；
 * 组内找不到任何围栏块（如围栏跨界断裂）时整体回落 {@link parseOutcome} 的全文口径，
 * 保证回退规则不存在第二套。
 */
export function parseOutcomeFromGroups(groups: readonly OutcomeMessageGroup[]): OutcomeResult {
  const texts = groups.map((group) => group.chunks.join(""));
  const full = texts.join("");
  const groupMatches = texts.map((t) => [...t.matchAll(outcomeBlockRegex())]);
  let last: RegExpMatchArray | undefined;
  for (let i = groupMatches.length - 1; i >= 0; i -= 1) {
    const ms = groupMatches[i];
    if (ms === undefined || ms.length === 0) continue;
    last = ms[ms.length - 1];
    break;
  }
  if (last === undefined) return parseOutcome(full);
  const blockCount = groupMatches.reduce((n, ms) => n + validBlockCount(ms), 0);
  const cleaned = full.replace(outcomeBlockRegex(), "").trim();
  const parsed = outcomeBlockPayload(last[1] ?? "");
  return mapOutcome(parsed, cleaned, blockCount, parsed === null ? -1 : blockCount - 1);
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
