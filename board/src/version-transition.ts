/**
 * 版本状态转换执法（REQ-2026-09-27-05 §2.3 · W3）—— **纯函数 + 注入式存储**，无自持 IO。
 *
 * 事实源 = 需求确认单 v5「状态迁移矩阵」五条边（改造文档 §2.3 复述）：
 *
 * | 迁移 | 触发方 | 闸 |
 * |---|---|---|
 * | `notstart → active` | 自动（首卡过 Step 0 确认门）+ 手动 | 无（版本级不另加锁；排期锁由既有双条件闸管） |
 * | `active → notstart` | 仅手动 | 名下存在**已确认卡**（`stage ≠ 需求分析`）⇒ 拒 |
 * | `active → released` | 仅手动（发版收尾） | 名下需求**全部收尾**（`total > 0 ∧ completed + cancelled === total ∧ completed > 0`）才可，否则拒 |
 * | `released → active` | 仅手动（发版纠错重开） | 无 |
 * | `notstart → released` | **禁止**（必须逐态） | 状态机拒绝 |
 *
 * 另有两条隐含口径：
 * - **自环**（`from === to`）恒放行且 `noop = true`（`setVersionStatus` 层幂等、不写文件）；
 * - 未列出的边（如 `released → notstart`）一律 `forbidden`（fail-closed，不猜）。
 *
 * **自动转换唯一一处** = {@link applyAutoVersionTransitions}（渲染前惰性比对
 * 「台账 `notstart` 条目 × 名下存在 `stage ≠ 需求分析` 的卡」），**三条护栏**：
 * ① 幂等（命中一跳后 `status = active`，下次比对不再命中）；② 写失败不阻断渲染
 * （`failed` 回报，调用方 warn 留痕；失败条目从回落台账剔除 ⇒ 徽标回落派生态）；
 * ③ 进程内节流（同条目 ≥ {@link AUTO_THROTTLE_MS} 至多尝试一次）。自动写留
 * {@link AUTO_NOTE} 与手动区分。**不做 `active → notstart` 自动回落**（stage/approval 单向无回边）。
 */
import { normalizeVersion } from "./version-order.js";
import type { VersionsLedger, VersionLedgerStatus } from "./versions-ledger.js";

/** 登记阶段「需求分析」= 想法卡（未过 Step 0 确认门）；stage 迁离该值 = 已确认。 */
export const IDEA_CARD_STAGE = "需求分析";

/** 自动转换留痕（与手动写区分）。 */
export const AUTO_NOTE = "auto:first-card-confirmed";

/** 自动转换的**进程内节流**窗口（同条目两次尝试的最小间隔，毫秒）。 */
export const AUTO_THROTTLE_MS = 30_000;

/**
 * 已确认卡判据（**单点**）：`stage ≠ 需求分析`。确认动作 = 需求确认门把 `stage`
 * 「需求分析 → 改造方案」（见 `flow/spec/需求映射`），故 `stage` 迁离即已确认。
 * `null`（老桥缺登记列）⇒ 视作**已确认**（fail-closed：不误判为可回退的想法卡）。
 */
export function isConfirmedCard(stage: string | null | undefined): boolean {
  return (stage ?? "") !== IDEA_CARD_STAGE;
}

/** 自动转换判据 / 手动闸所需的**最小卡片事实**（`FeatureListItem` 的结构相容子集）。 */
export interface VersionCardFact {
  version: string | null | undefined;
  stage: string | null | undefined;
  state?: string | null | undefined;
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

// ---------------------------------------------------------------------------
// 自动转换：notstart → active（唯一一处；三条护栏）
// ---------------------------------------------------------------------------

/**
 * 自动转 `active` 的候选（纯函数）：台账中 `status = notstart` **且**名下存在已确认卡
 * （`stage ≠ 需求分析`）的条目版本号；顺序 = 台账登记序。排卡本身**不触发**（想法卡可停在
 * notstart 版本），仅「首卡过确认门」触发。空版本串 / 无卡 ⇒ 不入候选。
 */
export function deriveAutoActiveVersions(
  ledger: VersionsLedger,
  cards: readonly VersionCardFact[],
): string[] {
  const confirmedVersions = new Set<string>();
  for (const c of cards) {
    const v = normalizeVersion(c.version);
    if (v !== "" && isConfirmedCard(c.stage)) confirmedVersions.add(v);
  }
  return ledger.versions
    .filter((r) => r.status === "notstart" && confirmedVersions.has(normalizeVersion(r.version)))
    .map((r) => r.version);
}

/** 自动转换所需的**最小存储面**（`VersionsLedgerStore` 的结构相容子集；单测可注入假 store）。 */
export interface AutoTransitionStore {
  /** 把条目置 `active` 并落盘；**写失败必须抛出**（由本函数兜、不阻断调用方渲染）。 */
  setStatus(
    version: string,
    status: VersionLedgerStatus,
    now: string,
    note?: string | null,
  ): { ledger: VersionsLedger };
}

export interface AutoTransitionInput {
  /** 当前台账（调用方已 load）。 */
  ledger: VersionsLedger;
  /** 需求卡事实（全局列表；判据只看 version / stage）。 */
  cards: readonly VersionCardFact[];
  /** 存储写入面（抛错 ⇒ 计入 `failed`，不向上传播）。 */
  store: AutoTransitionStore;
  /** 进程内节流表（版本 → 上次尝试时刻 ms）；**跨请求复用**，由调用方持有。 */
  throttle: Map<string, number>;
  /** 当前时刻 ms。 */
  nowMs: number;
}

export interface AutoTransitionOutcome {
  /** **回落渲染用**台账：已含成功转换；写失败条目被剔除 ⇒ 列头徽标回落派生态。 */
  ledger: VersionsLedger;
  /** 本次成功转换的版本（`note = AUTO_NOTE`）。 */
  written: string[];
  /** 命中节流跳过的版本。 */
  throttled: string[];
  /** 尝试写入但失败的版本（调用方 warn 留痕）。 */
  failed: string[];
}

/**
 * 应用自动转换（`notstart → active`）：逐候选 **先判节流**（同条目 ≥ {@link AUTO_THROTTLE_MS}
 * 至多尝试一次，失败也记录时刻避免渲染风暴），再尝试写；失败计入 `failed`、**不抛出**。
 * 返回的 `ledger` 为回落渲染台账（护栏②：失败条目剔除 ⇒ 不误导为「未开始」）。
 */
export function applyAutoVersionTransitions(input: AutoTransitionInput): AutoTransitionOutcome {
  const { ledger, cards, store, throttle, nowMs } = input;
  const qualifying = deriveAutoActiveVersions(ledger, cards);
  const written: string[] = [];
  const throttled: string[] = [];
  const failed: string[] = [];
  let effective = ledger;
  for (const version of qualifying) {
    const last = throttle.get(version);
    if (last !== undefined && nowMs - last < AUTO_THROTTLE_MS) {
      throttled.push(version);
      continue;
    }
    throttle.set(version, nowMs);
    try {
      effective = store.setStatus(version, "active", new Date(nowMs).toISOString(), AUTO_NOTE).ledger;
      written.push(version);
    } catch {
      failed.push(version);
    }
  }
  if (failed.length > 0) {
    const failedSet = new Set(failed);
    effective = {
      version: effective.version,
      versions: effective.versions.filter((r) => !failedSet.has(r.version)),
    };
  }
  return { ledger: effective, written, throttled, failed };
}
