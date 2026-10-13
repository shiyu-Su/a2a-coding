/**
 * Feature 状态机（v0.3.0，纯模块 / 零副作用 / 可单测）。
 *
 * 主链（8 态；REQ-v0.4.1-2026-09-16-01 收敛为 6 态，REQ-2026-10-12-03 O1 于 `approve` 之后、
 * `executing` 之前插入 `version_planning` / `decomposing` 两态）：
 *   waiting_approval → version_planning → decomposing → executing → integrating
 *     → testing → reviewing → completed
 * 异常态（3）：needs_input / failed / cancelled；终态：completed / failed / cancelled。
 * （`blocked` 为源文档保留态，属 v0.4.0 失败传播，本版不实现。）
 *
 * 收敛说明：前段三态（`discussing` / `analyzing` / `planning`）已删除 —— 引擎只做需求实现，
 * Step 0/1（需求访谈 / 方案评估）不走引擎。`waiting_approval → executing` 是**唯一准入**
 * （`approve` 专用门；`advance` 绕门在工具层被拒，见 `bridge/feature-tools.ts`）。
 * O1 起该边**保留**（只加边、不改任何既有出边）；`approve` 的目标态改落 `version_planning`
 * 属后续节点（O4）的行为改造，不在本词汇节点。
 *
 * 职责边界：本模块只做「合法流转」的代码强制（`canTransition` / `assertTransition`，
 * 非法流转 fail-fast）；持久化由 `session/store.ts` 承担，桥只做接线。「方案好坏 /
 * 是否问用户」等判断仍由 orch agent 经 MCP 工具触发。
 */
import type { FeatureState } from "../types.js";

/** 全部状态（8 主态 + 3 异常态），用于收窄 / 表单枚举 */
export const FEATURE_STATES: readonly FeatureState[] = [
  "waiting_approval",
  "version_planning",
  "decomposing",
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
  "waiting_approval",
  "version_planning",
  "decomposing",
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
 * - `needs_input` 仅回 `executing`（补齐输入续推，按改造文档 §2.2 转移表）；
 * - `version_planning` / `decomposing`（O1 新增词汇）**不得跳档**：各自只有下一态 + 异常态出边；
 *   `waiting_approval → executing` 这条既有边**原样保留**（只加边，见改造文档 §2.1）。
 */
const TRANSITIONS: Readonly<Record<FeatureState, readonly FeatureState[]>> = {
  waiting_approval: ["executing", "version_planning", "cancelled", "failed"],
  version_planning: ["decomposing", "cancelled", "failed"],
  decomposing: ["executing", "cancelled", "failed"],
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
