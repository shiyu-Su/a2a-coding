/**
 * 版本状态转换执法（REQ-2026-09-27-05 §2.3 · W3）—— **纯函数 + 注入式存储**，无自持 IO。
 *
 * 事实源 = 需求确认单 v5「状态迁移矩阵」五条边（改造文档 §2.3 复述）：
 *
 * | 迁移 | 触发方 | 闸 |
 * |---|---|---|
 * | `notstart → active` | **仅手动** | 无（版本级不另加锁；排期锁由既有双条件闸管） |
 * | `active → notstart` | 仅手动 | 名下存在**已确认卡**（`stage ≠ 需求分析`）⇒ 拒 |
 * | `active → released` | 仅手动（发版收尾） | 名下需求**全部收尾**（`total > 0 ∧ completed + cancelled === total ∧ completed > 0`）才可，否则拒 |
 * | `released → active` | 仅手动（发版纠错重开） | 无 |
 * | `notstart → released` | **禁止**（必须逐态） | 状态机拒绝 |
 *
 * 另有两条隐含口径：
 * - **自环**（`from === to`）恒放行且 `noop = true`（`setVersionStatus` 层幂等、不写文件）；
 * - 未列出的边（如 `released → notstart`）一律 `forbidden`（fail-closed，不猜）。
 *
 * **自动转换（`notstart → active`）已迁引擎（v0.10.0 · C-1 / O2b）** —— 板侧只保留上面这张
 * 人工写面的迁移矩阵执法，**不留任何自动写路径**。
 */
import type { VersionLedgerStatus } from "./versions-ledger.js";

/** 登记阶段「需求分析」= 想法卡（未过 Step 0 确认门）；stage 迁离该值 = 已确认。 */
export const IDEA_CARD_STAGE = "需求分析";

/**
 * 已确认卡判据（**单点**）：`stage ≠ 需求分析`。确认动作 = 需求确认门把 `stage`
 * 「需求分析 → 改造方案」（见 `flow/spec/需求映射`），故 `stage` 迁离即已确认。
 * `null`（老桥缺登记列）⇒ 视作**已确认**（fail-closed：不误判为可回退的想法卡）。
 */
export function isConfirmedCard(stage: string | null | undefined): boolean {
  return (stage ?? "") !== IDEA_CARD_STAGE;
}

// ---------------------------------------------------------------------------
// 手动写面：迁移矩阵五条边（纯判定）
// ---------------------------------------------------------------------------

/** 拒绝码（结构化错误码；handler 层 409）。 */
export type VersionTransitionRejectCode =
  | "board_version_transition_forbidden"
  | "board_version_transition_confirmed_cards"
  | "board_version_transition_release_incomplete";

export interface VersionTransitionFacts {
  /** 目标版本号（仅入错误文案）。 */
  version: string;
  /** 该版本名下是否存在已确认卡（`stage ≠ 需求分析`）。 */
  hasConfirmedCard: boolean;
  /** 名下卡总数（`active → released` 判据用）。 */
  total: number;
  /** 名下 `state === completed` 的卡数（raw 桶，**不合成** 收尾数）。 */
  completed: number;
  /** 名下 `state === cancelled` 的卡数（raw 桶，计入完成集合）。 */
  cancelled: number;
  /** 名下 `state === failed` 的卡数（raw 桶，**不计入** 完成集合；仅入错误文案）。 */
  failed: number;
}

export type VersionTransitionDecision =
  | { ok: true; noop: boolean }
  | { ok: false; code: VersionTransitionRejectCode; error: string };

/**
 * 迁移矩阵判定（纯函数）：给定现态 / 目标态 / 事实 ⇒ 放行（`noop` 区分自环）或结构化拒绝。
 * **发版闸的完成集合 = `completed + cancelled`**（内部合成，不落字段）—— `failed` 不计入
 * （DAG 非法 fail-fast 的遗留，须先经 `cancel` 归档才收口）；`completed > 0` 是必要项
 * （全部 `cancelled` 的版本无任何交付，不得标记 `released`）。
 */
export function decideVersionTransition(
  from: VersionLedgerStatus,
  to: VersionLedgerStatus,
  facts: VersionTransitionFacts,
): VersionTransitionDecision {
  if (from === to) return { ok: true, noop: true };
  if (from === "notstart" && to === "active") return { ok: true, noop: false };
  if (from === "active" && to === "notstart") {
    if (facts.hasConfirmedCard) {
      return {
        ok: false,
        code: "board_version_transition_confirmed_cards",
        error:
          `版本 ${facts.version} 名下有已确认卡（stage ≠ ${IDEA_CARD_STAGE}）⇒ 不可退回 notstart` +
          "（仅有想法卡或名下无卡时才可退；已确认的需求挪版走 cancel 从 Step 0 新建）。",
      };
    }
    return { ok: true, noop: false };
  }
  if (from === "active" && to === "released") {
    const finished = facts.completed + facts.cancelled;
    if (facts.total > 0 && finished === facts.total && facts.completed > 0) return { ok: true, noop: false };
    return {
      ok: false,
      code: "board_version_transition_release_incomplete",
      error:
        `版本 ${facts.version} 名下需求未全部收尾（completed ${facts.completed} + cancelled ${facts.cancelled} = ${finished} / total ${facts.total}，failed ${facts.failed}）⇒ 不可标记已发版` +
        "（判据 = total > 0 ∧ completed + cancelled === total ∧ completed > 0；failed 不计入收尾，全 cancelled 亦无交付 ⇒ 拒）。",
    };
  }
  if (from === "released" && to === "active") return { ok: true, noop: false };
  return {
    ok: false,
    code: "board_version_transition_forbidden",
    error: `版本状态迁移不合法：${from} → ${to} ⇒ 状态机拒绝（notstart → released 必须逐态；released → notstart 无此迁移）。`,
  };
}
