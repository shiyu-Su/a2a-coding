/**
 * Feature 状态机（v0.3.0，纯模块 / 零副作用 / 可单测）。
 *
 * 主链（9 态）：
 *   discussing → analyzing → planning → waiting_approval → executing →
 *   integrating → testing → reviewing → completed
 * 异常态（3）：needs_input / failed / cancelled；终态：completed / failed / cancelled。
 * （`blocked` 为源文档保留态，属 v0.4.0 失败传播，本版不实现。）
 *
 * 职责边界：本模块只做「合法流转」的代码强制（`canTransition` / `assertTransition`，
 * 非法流转 fail-fast）；持久化由 `session/store.ts` 承担，桥只做接线。「方案好坏 /
 * 是否问用户」等判断仍由 orch agent 经 MCP 工具触发。
 */
import type { FeatureState } from "../types.js";

/** 全部状态（9 主态 + 3 异常态），用于收窄 / 表单枚举 */
export const FEATURE_STATES: readonly FeatureState[] = [
  "discussing",
  "analyzing",
  "planning",
  "waiting_approval",
  "executing",
  "integrating",
  "testing",
  "reviewing",
  "completed",
  "needs_input",
  "failed",
  "cancelled",
];

/** 主链顺序（不含异常态） */
export const FEATURE_MAIN_CHAIN: readonly FeatureState[] = [
  "discussing",
  "analyzing",
  "planning",
  "waiting_approval",
  "executing",
  "integrating",
  "testing",
  "reviewing",
  "completed",
];

/** 终态：不可再流转 */
export const TERMINAL_FEATURE_STATES: readonly FeatureState[] = [
  "completed",
  "failed",
  "cancelled",
];

/**
 * 合法转移表（from → 允许的 to）。
 * 说明：
 * - `any 非终态 → cancelled`（用户 / orch agent 取消）；
 * - `any 非终态 → failed`（任务失败 / 看护放弃，调度器自动）；
 * - `needs_input` 仅回 `executing`（补齐输入续推，按改造文档 §2.2 转移表）。
 */
const TRANSITIONS: Readonly<Record<FeatureState, readonly FeatureState[]>> = {
  discussing: ["analyzing", "cancelled", "failed"],
  analyzing: ["planning", "needs_input", "cancelled", "failed"],
  planning: ["waiting_approval", "cancelled", "failed"],
  waiting_approval: ["executing", "cancelled", "failed"],
  executing: ["integrating", "needs_input", "cancelled", "failed"],
  integrating: ["testing", "cancelled", "failed"],
  testing: ["reviewing", "cancelled", "failed"],
  reviewing: ["completed", "cancelled", "failed"],
  needs_input: ["executing", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** 收窄：unknown → FeatureState */
export function isFeatureState(v: unknown): v is FeatureState {
  return typeof v === "string" && (FEATURE_STATES as readonly string[]).includes(v);
}

/** 是否终态（completed / failed / cancelled） */
export function isTerminalFeatureState(state: FeatureState): boolean {
  return (TERMINAL_FEATURE_STATES as readonly string[]).includes(state);
}

/** 该状态的合法后继清单（终态为空数组） */
export function allowedTransitions(from: FeatureState): readonly FeatureState[] {
  return TRANSITIONS[from];
}

/** 纯判定：from → to 是否合法 */
export function canTransition(from: FeatureState, to: FeatureState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 非法流转错误（fail-fast 用；桥捕获后返回结构化错误，不落库） */
export class FeatureTransitionError extends Error {
  readonly from: FeatureState;
  readonly to: FeatureState;

  constructor(from: FeatureState, to: FeatureState) {
    const allowed = TRANSITIONS[from];
    const hint =
      allowed.length === 0 ? "（当前为终态，不可再流转）" : `（合法后继：${allowed.join(" / ")}）`;
    super(`[feature] 非法状态流转：${from} → ${to}${hint}`);
    this.name = "FeatureTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * 断言合法流转；非法时抛 `FeatureTransitionError`。
 * 用于「先校验后落库」：校验通过再调用存储层写入。
 */
export function assertTransition(from: FeatureState, to: FeatureState): void {
  if (!canTransition(from, to)) {
    throw new FeatureTransitionError(from, to);
  }
}
