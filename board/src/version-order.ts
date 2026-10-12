/**
 * 版本串排序与「未排期」判据（REQ-v0.9.2-2026-09-25-02 / M1）—— 纯函数，无 IO。
 *
 * 口径：
 * - `trim()` 是版本串的**唯一归一**入口，比较与判据都走归一后的值；
 * - `^v?(\d+)\.(\d+)\.(\d+)$` 命中者按 major/minor/patch **数值序**（`v0.10.0 > v0.9.0`）；
 * - 未命中者（范围符、预发布段、任意自由文本）**字典序垫底**，组内按字典序、相等则稳定；
 * - 「未排期」判据**只有一条路径** `trim() === ""`（orch 已核实：空串与 NULL 在读面同值，不分两支）；
 * - 需求池排序：`createdAt` 降序，缺值/非法落底，同值以 `featureId` 兜底成全序。
 * - 版本列卡序：状态档优先，同档 `createdAt` 降序 + `featureId` 兜底。
 *
 * 不做 semver 全规范解析；分组只在板侧做（orch 的 version 无索引），故本文件只依赖入参本身 ——
 * 日后 orch 加索引不改变此处语义。
 */

/** 排序入参：读面可能给出 null（登记缺失）。 */
export type VersionLike = string | null | undefined;

/** 版本串归一：唯一一处 trim。 */
export function normalizeVersion(raw: VersionLike): string {
  return (raw ?? "").trim();
}

/** 未排期（需求池）判据：归一后为空串。 */
export function isUnscheduled(raw: VersionLike): boolean {
  return normalizeVersion(raw) === "";
}

/** 解析后的三段版本号。 */
export interface SemverTriple {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** `x.y.z`（可带 `v` 前缀）→ 三段数值；其它一律 null。 */
export function parseVersion(raw: VersionLike): SemverTriple | null {
  const m = SEMVER_RE.exec(normalizeVersion(raw));
  if (m === null) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function cmpNumber(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function cmpString(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 版本列排序比较器（升序 = 看板从左到右）。
 * 数值组在前、非 `x.y.z` 组字典序垫底；调用前应已用 `isUnscheduled` 滤掉未排期。
 */
export function compareVersionOrder(a: VersionLike, b: VersionLike): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa !== null && pb !== null) {
    return cmpNumber(pa.major, pb.major) || cmpNumber(pa.minor, pb.minor) || cmpNumber(pa.patch, pb.patch);
  }
  if (pa !== null) return -1;
  if (pb !== null) return 1;
  return cmpString(normalizeVersion(a), normalizeVersion(b));
}

/** 版本列（升序）：非 `x.y.z` 原样保留、字典序排在数值版本之后。 */
export function sortVersions(raws: readonly VersionLike[]): string[] {
  return [...raws].map(normalizeVersion).sort(compareVersionOrder);
}

/** 需求池条目：排序只需要这两个字段。 */
export interface PoolEntry {
  createdAt: string | null | undefined;
  featureId: string;
}

function createdAtMs(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 需求池排序比较器：`createdAt` 降序（新在前）；缺值/非法值落底；
 * 同值（含都为缺值）以 `featureId` 字典序兜底 ⇒ 全序、结果与输入顺序无关。
 */
export function comparePoolEntry(a: PoolEntry, b: PoolEntry): number {
  const ta = createdAtMs(a.createdAt);
  const tb = createdAtMs(b.createdAt);
  if (ta !== null && tb !== null && ta !== tb) return cmpNumber(tb, ta);
  if (ta === null && tb !== null) return 1;
  if (ta !== null && tb === null) return -1;
  return cmpString(a.featureId, b.featureId);
}

/** 需求池排序（返回新数组，不改入参）。 */
export function sortPoolEntries<T extends PoolEntry>(entries: readonly T[]): T[] {
  return [...entries].sort(comparePoolEntry);
}

/** 版本列卡片排序入参：需求池两字段 + 引擎态原值（不认显示词）。 */
export interface FeatureCardEntry extends PoolEntry {
  state: string | null;
}

/**
 * 状态档 → 档位序（六档，值越小越靠前）。用 Map 而非对象字面量：`state` 原值来自桥、
 * 值域不受板控，字面量在 `constructor` 一类键上会命中 `Object.prototype` 上的函数
 * ⇒ 得 `NaN` ⇒ 比较器不再全序（静默乱序，比抛错更难查）。Map 无原型洞。
 */
const STATE_CARD_TIER_RANK = new Map<string, number>([
  ["failed", 0],
  ["waiting_approval", 1],
  ["reviewing", 1],
  ["needs_input", 1],
  ["executing", 2],
  ["integrating", 2],
  ["testing", 2],
  ["completed", 3],
  ["cancelled", 4],
]);

/** 兜底档：任何未在上表的取值（含 null）。 */
const FALLBACK_TIER_RANK = 5;

function stateTierRank(state: string | null): number {
  if (state === null) return FALLBACK_TIER_RANK;
  return STATE_CARD_TIER_RANK.get(state) ?? FALLBACK_TIER_RANK;
}

/**
 * 版本列卡片排序比较器：先比状态档，同档直接复用需求池尺（`createdAt` 降序、
 * 缺值/非法沉底、`featureId` 字典序兜底）⇒ 全序、结果与输入顺序无关。
 */
export function compareFeatureCard(a: FeatureCardEntry, b: FeatureCardEntry): number {
  const tierDiff = cmpNumber(stateTierRank(a.state), stateTierRank(b.state));
  return tierDiff !== 0 ? tierDiff : comparePoolEntry(a, b);
}

/** 版本列卡片排序（返回新数组，不改入参）。 */
export function sortFeatureCards<T extends FeatureCardEntry>(entries: readonly T[]): T[] {
  return [...entries].sort(compareFeatureCard);
}
