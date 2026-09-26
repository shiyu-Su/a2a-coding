/**
 * 版本状态单点（REQ-v0.9.2-2026-09-26-03 / N1）—— 纯函数，无 IO。
 *
 * 口径（改造文档 §2 N1 / §3 边界 3）：
 * - **锁判据 = trim 后精确串匹配** config `releasedVersions`，**禁前缀匹配**
 *   （防 `v0.9.0-probe` 被 `v0.9.0` 连坐）；空串（未排期）恒不锁；
 * - `deriveVersionStatus` **仅显示用提示**（列头徽标等），**不参与执法** ——
 *   执法只走 {@link isVersionLocked}；派生判不出（有空洞）回落「进行中」。
 */
import { normalizeVersion } from "./version-order.js";

/**
 * 版本是否已锁（已发版）：`releasedVersions` 中**任一元素 trim 后与本串全等**。
 * 未排期（归一后空串）⇒ 恒 false，永不参与锁。
 */
export function isVersionLocked(version: string | null | undefined, releasedVersions: readonly string[]): boolean {
  const v = normalizeVersion(version);
  if (v === "") return false;
  return releasedVersions.some((raw) => typeof raw === "string" && raw.trim() === v);
}

/** 版本状态闭集（显示用）：未排期 / 已发版（锁）/ 已收尾（全部终态且至少一条 completed）/ 进行中。 */
export type VersionStatus = "未排期" | "已发版" | "已收尾" | "进行中";

export interface VersionStatusView {
  status: VersionStatus;
  /** 面向用户的一行说明（徽标 tooltip / 副标题）。 */
  note: string;
  /** 该版需求总数。 */
  total: number;
  /** 其中 completed 数。 */
  completed: number;
  /** 其中终态（completed / failed / cancelled）数。 */
  terminal: number;
}

/** 派生只需要这两个字段；`version` 缺失按该版成员算（调用方已按版分组时可不填）。 */
export interface VersionFeatureEntry {
  state: string | null | undefined;
  version?: string | null | undefined;
}

const TERMINAL_STATES: readonly string[] = ["completed", "failed", "cancelled"];

/**
 * 版本状态派生（**仅显示用提示，不参与执法**）：
 * 锁 > 未排期 > 空版「进行中」 > 全终态且有 completed ⇒「已收尾」 > 其余「进行中」。
 * 判不出（存在非终态 / 空集）一律回落「进行中」，不猜。
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
  let terminal = 0;
  for (const f of members) {
    if (f.state === "completed") completed++;
    if (f.state !== null && f.state !== undefined && TERMINAL_STATES.includes(f.state)) terminal++;
  }
  const base = { total, completed, terminal };
  if (isVersionLocked(v, releasedVersions)) {
    return { ...base, status: "已发版", note: "config releasedVersions 已登记该版 ⇒ 板前台锁定（不可排入/改入/改出）。" };
  }
  if (v === "") {
    return { ...base, status: "未排期", note: "未排期不参与版本锁。" };
  }
  if (total > 0 && terminal === total && completed > 0) {
    return { ...base, status: "已收尾", note: "该版需求全部到达终态且至少一条 completed ⇒ 可发版（显示提示，不执法；登记 releasedVersions 才加锁）。" };
  }
  return { ...base, status: "进行中", note: "该版仍有未到终态的需求，或未登记已发版。" };
}
