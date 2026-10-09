/**
 * 版本状态单点（REQ-v0.9.2-2026-09-26-03 / N1）—— 纯函数，无 IO。
 *
 * 口径（改造文档 §2 N1 / §3 边界 3 / **v0.10.0 B4 换数据源**）：
 * - **锁判据 = trim 后精确串匹配已发版集**，**禁前缀匹配**
 *   （防 `v0.9.0-probe` 被 `v0.9.0` 连坐）；空串（未排期）恒不锁；
 * - **已发版集的事实源 = 引擎版本台账**（v0.10.0 B4，改造文档 §2.3(1)）—— 板本地
 *   `.data/versions.json` 降为读缓存/降级投影，不再充当锁的数据源；本模块仍是**纯函数、无 IO**，
 *   不自行读引擎，由调用方（`server.ts` 三消费点）以引擎投影喂入；
 *   **读不到投影 ⇒ 调用方 fail-closed 挡排期写**（不得当成「零个已发版」放行），判据本身不因此放宽；
 * - 更早的两段历史口径（v0.9.4 N3 起 config `releasedVersions` 读面退役、调用方以
 *   `releasedVersionNames(ledger)` 喂入）保持不变 —— 本模块签名与判据**零改动**；
 * - `deriveVersionStatus` **仅显示用提示**（列头徽标等），**不参与执法** ——
 *   执法只走 {@link isVersionLocked}；派生判不出（有空洞）回落「进行中」。
 */
import { normalizeVersion } from "./version-order.js";

/**
 * 版本是否已锁（已发版）：**已发版集**（台账 `released` 版本号，调用方喂入）中
 * **任一元素 trim 后与本串全等**。未排期（归一后空串）⇒ 恒 false，永不参与锁。
 */
export function isVersionLocked(version: string | null | undefined, releasedVersions: readonly string[]): boolean {
  const v = normalizeVersion(version);
  if (v === "") return false;
  return releasedVersions.some((raw) => typeof raw === "string" && raw.trim() === v);
}

/** 版本状态闭集（显示用）：未排期 / 已发版（锁）/ 已收尾（完成集合覆盖全部名下卡且至少一条 completed）/ 进行中。 */
export type VersionStatus = "未排期" | "已发版" | "已收尾" | "进行中";

export interface VersionStatusView {
  status: VersionStatus;
  /** 面向用户的一行说明（徽标 tooltip / 副标题）。 */
  note: string;
  /** 该版需求总数。 */
  total: number;
  /** 其中 completed 数（完成集合的正项）。 */
  completed: number;
  /** 其中终态（completed / failed / cancelled）数 —— **只作显示计数，不参与「已收尾」判据**。 */
  terminal: number;
}

/** 派生只需要这两个字段；`version` 缺失按该版成员算（调用方已按版分组时可不填）。 */
export interface VersionFeatureEntry {
  state: string | null | undefined;
  version?: string | null | undefined;
}

/** 终态集合（显示计数用）：`terminal` 含 failed，**不等于完成集合**（完成集合 = completed + cancelled）。 */
const TERMINAL_STATES: readonly string[] = ["completed", "failed", "cancelled"];

/**
 * 版本状态派生（**仅显示用提示，不参与执法**）：
 * 锁 > 未排期 > 空版「进行中」 > 完成集合覆盖全部名下卡且至少一条 completed ⇒「已收尾」 > 其余「进行中」。
 * 判据与 {@link decideVersionTransition} 的发版闸**同口径**（`completed + cancelled === total ∧ completed > 0`）；
 * `failed` 呈现为未收口（回落「进行中」）。判不出（存在非终态 / 空集）一律回落「进行中」，不猜。
 */
export function deriveVersionStatus(
  version: string | null | undefined,
  features: readonly VersionFeatureEntry[],
  releasedVersions: readonly string[] = [],
): VersionStatusView {
  const v = normalizeVersion(version);
  const members = features.filter((f) => f.version === undefined || normalizeVersion(f.version) === v);
  const total = members.length;
  let completed = 0;
  let cancelled = 0;
  let terminal = 0;
  for (const f of members) {
    if (f.state === "completed") completed++;
    if (f.state === "cancelled") cancelled++;
    if (f.state !== null && f.state !== undefined && TERMINAL_STATES.includes(f.state)) terminal++;
  }
  const base = { total, completed, terminal };
  if (isVersionLocked(v, releasedVersions)) {
    return { ...base, status: "已发版", note: "版本台账已将该版标记为 released ⇒ 板前台锁定（不可排入/改入/改出）。" };
  }
  if (v === "") {
    return { ...base, status: "未排期", note: "未排期不参与版本锁。" };
  }
  if (total > 0 && completed + cancelled === total && completed > 0) {
    return { ...base, status: "已收尾", note: "该版需求全部收尾（completed + cancelled）且至少一条 completed ⇒ 可发版（显示提示，不执法；在版本台账标记 released 才加锁）。" };
  }
  return { ...base, status: "进行中", note: "该版仍有未收尾（非终态或 failed）的需求，或未登记已发版。" };
}
