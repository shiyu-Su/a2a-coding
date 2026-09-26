/**
 * 版本串排序与「未排期」判据（REQ-v0.9.2-2026-09-25-02 / M1）—— 纯函数，无 IO。
 *
 * 口径：
 * - `trim()` 是版本串的**唯一归一**入口，比较与判据都走归一后的值；
 * - `^v?(\d+)\.(\d+)\.(\d+)$` 命中者按 major/minor/patch **数值序**（`v0.10.0 > v0.9.0`）；
 * - 未命中者（范围符、预发布段、任意自由文本）**字典序垫底**，组内按字典序、相等则稳定；
 * - 「未排期」判据**只有一条路径** `trim() === ""`（orch 已核实：空串与 NULL 在读面同值，不分两支）；
 * - 需求池排序：`createdAt` 降序，缺值/非法落底，同值以 `featureId` 兜底成全序。
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
