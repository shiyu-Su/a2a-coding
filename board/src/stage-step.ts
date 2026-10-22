/**
 * v0.11.0 B1：板面**按步收口**的单一判据函数（纯函数）—— 一张卡同一时刻至多一个主按钮。
 *
 * 用户裁定（2026-10-20「未来一律通过板操作、板也不允许跳步」，需求确认单 §1.2 / 改造文档 §2.1）：
 * - 视图层**只按 `primaryAction` 渲对应的那一个主按钮**，不自立第二处判据；
 * - `blockers[]` 渲成一行文字；**缺席 = 不渲**，不得渲禁用态按钮凑数；
 * - 判据只读引擎直出事实（阶段轮格 / 合成对象 / decisions 登记位 / `allowedActions` 门闩），
 *   板不判闸、不写状态机、不重算哈希（封口比较单点仍在 `deriveGate1ConfirmState`）。
 *
 * 六态（改造文档 §2.1 冻结表）：
 * | step | 条件 | primaryAction |
 * |---|---|---|
 * | first-round | 当前阶段 0 轮 | `stage_round_open` |
 * | awaiting | 有轮未封口 | null（blockers = 未答 project） |
 * | confirm-round | 已封口、未确认现版 | `gate1_confirm`（无可确认对象 ⇒ null + blocker 说明） |
 * | write-doc | 已确认、《改造文档》未在 decisions 登记 | null（blocker：等宿主登记） |
 * | approve | 改造文档已登记、本格门闩仍在 | `approve` |
 * | done | 已过门②（引擎已收走本格全部动作门闩） | null |
 *
 * 六态与后续阶段（回归 / 验收 / 发版）的冲突按改造文档 §5「遗留」届时扩表，本卡不预设。
 */

import type { StageRunSynthesisView, StageRunView } from "./bridge-client.js";
import { deriveGate1ConfirmState } from "./derive.js";
import { registeredDecisionDocRefs } from "./web/views.js";

/** 「发起首轮」块的唯一准入阶段（需求确认单 §2-A 末行：过了需求分析 ⇒ 整块消失）。 */
export const STAGE_STEP_REQUIREMENT_ANALYSIS = "需求分析";

/** 主按钮词元（与既有写控件一一对应；**不是** `allowedActions` 的新增值，闭集不动）。 */
export const STAGE_STEP_ACTION_ROUND_OPEN = "stage_round_open";
export const STAGE_STEP_ACTION_GATE1_CONFIRM = "gate1_confirm";
export const STAGE_STEP_ACTION_APPROVE = "approve";

/** `allowedActions` 既有门闩两枚（只读取、不新增；闭集取值归引擎）。 */
const LATCH_ROUND_OPEN = "stage_round_open";
const LATCH_DOC_OBJECTION = "doc_objection";

export type StageStepName =
  | "first-round"
  | "awaiting"
  | "confirm-round"
  | "write-doc"
  | "approve"
  | "done";

export type StageStepAction =
  | typeof STAGE_STEP_ACTION_ROUND_OPEN
  | typeof STAGE_STEP_ACTION_GATE1_CONFIRM
  | typeof STAGE_STEP_ACTION_APPROVE;

export interface StageStepInput {
  /** 本卡判定所依据的阶段（= 本轮格自身的 `stage`，口径同 `pickStageRun` 不跨阶段）。 */
  stage: string | null;
  /** 引擎顶层 `stageRuns[]`；`null` / `undefined` = 面不可读（缺面 ≠ 空面，不猜步）。 */
  stageRuns: readonly StageRunView[] | null | undefined;
  /** 本轮格的合成对象（确认档位由此派生）。 */
  synthesis: StageRunSynthesisView | null | undefined;
  /** 需求 `decisions` 登记原文（《改造文档》在册判据）。 */
  decisions: string | null | undefined;
  /** 本轮格的 `allowedActions`；`null` / `undefined` = 未知 ⇒ 保守停在 `approve`（不冒充已过门②）。 */
  allowedActions: readonly string[] | null | undefined;
}

export interface StageStepDecision {
  step: StageStepName;
  /** 唯一主按钮；`null` ⇒ 本卡不渲任何主按钮（缺席 = 不渲）。 */
  primaryAction: StageStepAction | null;
  /** 卡在哪一步的人话清单（视图渲成一行；空数组 ⇒ 不渲行）。 */
  blockers: string[];
}

/** decisions 登记里的《改造文档》文件名清单（复用 views 的登记提取单点，板不另立第二套路径正则）。 */
export function registeredModificationDocFiles(decisions: string | null | undefined): string[] {
  return registeredDecisionDocRefs(decisions)
    .filter((ref) => ref.file.includes("改造文档"))
    .map((ref) => ref.file);
}

/** 六态判定（纯函数、无 IO；判序固定：面可读性 > 0 轮 > 封口 > 确认档 > 登记位 > 门②）。 */
export function decideStep(input: StageStepInput): StageStepDecision {
  const stageKey = (input.stage ?? "").trim();
  if (input.stageRuns === null || input.stageRuns === undefined) {
    return { step: "awaiting", primaryAction: null, blockers: ["阶段轮面不可读 ⇒ 板不猜步"] };
  }
  if (stageKey === "") {
    return { step: "awaiting", primaryAction: null, blockers: ["阶段缺失 ⇒ 板不猜步"] };
  }
  const runs = input.stageRuns.filter((run) => (run.stage ?? "").trim() === stageKey);
  if (runs.length === 0) {
    if (stageKey !== STAGE_STEP_REQUIREMENT_ANALYSIS) {
      return {
        step: "awaiting",
        primaryAction: null,
        blockers: [`当前阶段「${stageKey}」尚无轮次；须先在需求分析开轮，板不允许跨阶段起步`],
      };
    }
    return { step: "first-round", primaryAction: STAGE_STEP_ACTION_ROUND_OPEN, blockers: [] };
  }
  const current = runs.reduce((a, b) => (((b.round ?? -1) > (a.round ?? -1)) ? b : a), runs[0]!);
  if (current.settled !== true) {
    return {
      step: "awaiting",
      primaryAction: null,
      blockers:
        current.unanswered.length > 0
          ? [...current.unanswered]
          : ["本轮未封口（引擎未列欠答）⇒ 封口前不给主按钮"],
    };
  }
  const confirmState = deriveGate1ConfirmState(input.synthesis ?? null);
  if (confirmState === "pending") {
    return { step: "confirm-round", primaryAction: STAGE_STEP_ACTION_GATE1_CONFIRM, blockers: [] };
  }
  if (confirmState === "absent") {
    return {
      step: "confirm-round",
      primaryAction: null,
      blockers: ["已封口但引擎未下发可合成的文档版本（本轮合成面未出）⇒ 这一步暂无按钮可点"],
    };
  }
  const docs = registeredModificationDocFiles(input.decisions);
  if (docs.length === 0) {
    return {
      step: "write-doc",
      primaryAction: null,
      blockers: ["已确认本轮方案 ⇒ 等宿主把《改造文档》登记进本卡决策记录，登记前不出放行入口"],
    };
  }
  const acts = input.allowedActions;
  const stageStillOpen =
    acts === null || acts === undefined || acts.includes(LATCH_ROUND_OPEN) || acts.includes(LATCH_DOC_OBJECTION);
  if (stageStillOpen) {
    return { step: "approve", primaryAction: STAGE_STEP_ACTION_APPROVE, blockers: [] };
  }
  return { step: "done", primaryAction: null, blockers: [] };
}
