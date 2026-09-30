/**
 * 板侧**版本台账**（REQ-2026-09-27-05 · v0.9.4 N1）—— 本地 JSON 文件 `.data/versions.json`。
 *
 * 板侧版本管理面的**单一事实源**（板前台；v0.10.x Release 对象定型时一次脚本迁移，
 * 见改造文档 §1）。条目 `{org, version, status: notstart|active|released, createdAt, updatedAt, note?}`：
 * - `notstart` 未开始 / `active` 进行中 / `released` 已发版（三态闭集，用户裁定）；
 * - `note` 承载**自动转换留痕**（如 `auto:first-card-confirmed`，与手动区分）与人工备注。
 *
 * **组织作用域（REQ-2026-09-28-07 · v0.9.6 B1，口径 1/2）**：台账 = **扁平数组 + 记录内 `org` 字段**
 * （不用嵌套形态），唯一键 `(org, version)` ⇒ 不同组织可各有 `v0.9.5`。schema 常量 **1 → 2**。
 * 形态三处（`parseVersionRecord` 键白名单 / `parseVersionsLedger` 去重键 / `serializeVersionsLedger`
 * 的 schema 常量）**必须同批生效** —— 任一漏改即「读一次静默丢 org」。
 * `org` 为空串 = **遗留无组织桶**（只在迁移层存在、门户不暴露，见 {@link migrateLedgerOrgs}）。
 *
 * **一次性迁移**（改造文档 §2.1）：启动前置、fail-fast —— `config/config.json` 的
 * `releasedVersions` 四条灌入 → `status=released`；灌入失败 ⇒ 拒起板（防已发版锁静默消失）。
 * 迁移边界 = **台账文件是否存在**：文件已存在 ⇒ 该键为**残留键**，一次性 warn、**不双读**
 * （不重复灌入、不改台账）。台账读面（`isVersionLocked` 切换）归 N3，本节点只建台账 + 写口。
 *
 * 原子写复用 `host-bridge-ledger.ts` 的 {@link writeFileAtomic}（tmp + rename + 建父目录）；
 * 板是单进程单写手，与其余台账同口径**不加文件锁**。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./host-bridge-ledger.js";

/** 台账 schema 版本（未来加字段时用于迁移判定；v0.9.6 B1 记录扩 `org` ⇒ 1 → 2）。 */
export const VERSIONS_LEDGER_VERSION = 2;

/** 缺省台账落点：`<board>/.data/versions.json`（`.data/` 已在 `.gitignore`）。 */
export function defaultVersionsLedgerFile(cwd: string = process.cwd()): string {
  return join(resolve(cwd), ".data", "versions.json");
}

/** 版本状态闭集（三态，用户裁定）：未开始 / 进行中 / 已发版。 */
export type VersionLedgerStatus = "notstart" | "active" | "released";

/** 闭集数组（单一事实源；`write-guard` 的 setStatus 值域校验复用本常量，不立第二套）。 */
export const VERSION_STATUSES: readonly VersionLedgerStatus[] = ["notstart", "active", "released"];

/** 状态值是否落在闭集内（类型守卫）。 */
export function isVersionStatus(raw: unknown): raw is VersionLedgerStatus {
  return typeof raw === "string" && (VERSION_STATUSES as readonly string[]).includes(raw);
}

/** 一条版本台账记录（唯一键 = `(org, version)`，口径 1）。 */
export interface VersionLedgerRecord {
  /** 组织名（唯一键之一；trim 后为 `""` ⇒ 遗留无组织桶 —— 只在迁移层存在、门户不暴露）。 */
  org: string;
  /** 版本号（trim 后非空；组织内唯一）。 */
  version: string;
  /** 三态闭集之一。 */
  status: VersionLedgerStatus;
  /** ISO 时刻（首次登记）。 */
  createdAt: string;
  /** ISO 时刻（最近一次状态变更）。 */
  updatedAt: string;
  /** 备注（自动转换留痕 / 人工）；无 ⇒ null。 */
  note: string | null;
}

/**
 * 键定位的可选组织档：`undefined` = **不限组织**（按 version 命中；未切片调用面的既有行为），
 * 字符串 = 精确匹配 `(org, version)`（`""` 即空串桶自身，仍是精确档）。
 * 切片归调用方（口径 3）：本文件只提供能力，读面 / 写面逐个传 org 归后续节点。
 */
export type VersionOrgFilter = string | undefined;

function matchOrg(rec: VersionLedgerRecord, org: VersionOrgFilter): boolean {
  return org === undefined || rec.org === org;
}

function matchKey(rec: VersionLedgerRecord, version: string, org: VersionOrgFilter): boolean {
  return rec.version === version && matchOrg(rec, org);
}

/** 「版本（组织）」标签（启动日志 / 迁移回执的可读面；空串桶显式标「未归属组织」，不静默显示为光版号）。 */
export function versionRecordLabel(rec: VersionLedgerRecord): string {
  return `${rec.version}（${rec.org === "" ? "未归属组织" : rec.org}）`;
}

export interface VersionsLedger {
  version: number;
  versions: VersionLedgerRecord[];
}

// ---------------------------------------------------------------------------
// 纯函数（无 I/O；单测目标）
// ---------------------------------------------------------------------------

export function emptyVersionsLedger(): VersionsLedger {
  return { version: VERSIONS_LEDGER_VERSION, versions: [] };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** 单条记录容错解析：`version` 缺失 / 空白 ⇒ 丢条目；`status` 非闭集 ⇒ 保守回落 `notstart`；`org` 缺键 ⇒ 空串（交迁移器 stamp）。 */
export function parseVersionRecord(input: unknown): VersionLedgerRecord | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const version = str(r.version);
  if (version === null) return null;
  const status: VersionLedgerStatus = isVersionStatus(r.status) ? r.status : "notstart";
  const createdAt = typeof r.createdAt === "string" ? r.createdAt : "";
  return {
    org: typeof r.org === "string" ? r.org.trim() : "",
    version,
    status,
    createdAt,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : createdAt,
    note: typeof r.note === "string" && r.note.trim() !== "" ? r.note.trim() : null,
  };
}

/** 整本台账容错解析（坏 JSON / 非对象 ⇒ 空台账；**同键 `(org, version)`** 条目后读到覆盖前者；跨组织同名各自保留）。 */
export function parseVersionsLedger(raw: unknown): VersionsLedger {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyVersionsLedger();
  const body = raw as Record<string, unknown>;
  const entries: readonly unknown[] = Array.isArray(body.versions) ? body.versions : [];
  const out: VersionsLedger = {
    version: typeof body.version === "number" && Number.isInteger(body.version) ? body.version : VERSIONS_LEDGER_VERSION,
    versions: [],
  };
  for (const entry of entries) {
    const rec = parseVersionRecord(entry);
    if (rec === null) continue;
    const idx = out.versions.findIndex((v) => v.org === rec.org && v.version === rec.version);
    if (idx >= 0) out.versions[idx] = rec;
    else out.versions.push(rec);
  }
  return out;
}

/** 序列化（固定缩进 2 + 行尾换行，口径同其余台账；schema 常量恒写 ⇒ 读到 1 的台账落盘即升为 2）。 */
export function serializeVersionsLedger(ledger: VersionsLedger): string {
  return JSON.stringify({ version: VERSIONS_LEDGER_VERSION, versions: ledger.versions }, null, 2) + "\n";
}

/** 键定位（org 省略 = 不限组织，按登记序取首个命中）。 */
export function findVersionRecord(ledger: VersionsLedger, version: string, org?: VersionOrgFilter): VersionLedgerRecord | null {
  return ledger.versions.find((v) => matchKey(v, version, org)) ?? null;
}

/** 台账内全部版本号（保持登记序；**跨组织同名折叠为一**，调用方只需版号集合）。 */
export function ledgerVersionNames(ledger: VersionsLedger, org?: VersionOrgFilter): string[] {
  const names: string[] = [];
  for (const rec of ledger.versions) {
    if (matchOrg(rec, org) && !names.includes(rec.version)) names.push(rec.version);
  }
  return names;
}

/** 已发版（`status = released`）版本号集合（跨组织同名折叠）—— N3 锁切换的读面。 */
export function releasedVersionNames(ledger: VersionsLedger, org?: VersionOrgFilter): string[] {
  const names: string[] = [];
  for (const rec of ledger.versions) {
    if (rec.status === "released" && matchOrg(rec, org) && !names.includes(rec.version)) names.push(rec.version);
  }
  return names;
}

/** 已发版条目的「组织 · 版本」标签（启动日志读面，org 维度不得丢）。 */
export function releasedVersionLabels(ledger: VersionsLedger): string[] {
  return ledger.versions.filter((v) => v.status === "released").map(versionRecordLabel);
}

/** 该版本是否已发版（无记录 ⇒ false；org 省略 = 任一组织的该版号）。 */
export function isVersionReleased(ledger: VersionsLedger, version: string, org?: VersionOrgFilter): boolean {
  const rec = findVersionRecord(ledger, version, org);
  return rec !== null && rec.status === "released";
}

/**
 * 建版本（**纯函数**）：同键 `(org, version)` 已存在 ⇒ 原样返回 + `added: false`（幂等，**不覆盖**既有状态）；
 * 不同组织的同版号是**两条独立条目**（口径 1）。org 省略 ⇒ 落空串桶（未切片调用面的既有形态）。
 * 新条目初态 `status = notstart`（用户裁定：`notstart → active` 由首卡过确认门自动触发，见 `version-transition.ts`）。
 */
export function createVersion(
  ledger: VersionsLedger,
  version: string,
  now: string,
  org = "",
): { ledger: VersionsLedger; added: boolean } {
  if (findVersionRecord(ledger, version, org) !== null) return { ledger, added: false };
  const rec: VersionLedgerRecord = { org, version, status: "notstart", createdAt: now, updatedAt: now, note: null };
  return { ledger: { version: ledger.version, versions: [...ledger.versions, rec] }, added: true };
}

/** 删除版本（**纯函数**）：不存在 ⇒ 原样返回 + `removed: false`。删除闸（状态 / 名下无卡）在 handler 层。 */
export function removeVersion(
  ledger: VersionsLedger,
  version: string,
  org?: VersionOrgFilter,
): { ledger: VersionsLedger; removed: boolean } {
  const idx = ledger.versions.findIndex((v) => matchKey(v, version, org));
  if (idx < 0) return { ledger, removed: false };
  return {
    ledger: { version: ledger.version, versions: ledger.versions.filter((v, i) => i !== idx) },
    removed: true,
  };
}

/**
 * 设状态（**纯函数**）：记录不存在 ⇒ `changed: false` + `found: false`（handler 落 404）；
 * 状态与现值相同 ⇒ `changed: false`（幂等，文件逐字节不动）。`note` 给出时覆盖，未给保持原值。
 * 状态转换矩阵（五条边）执法 = `version-transition.ts` 的 `decideVersionTransition`（挪出本文件）；本函数只做存储层写入。
 */
export function setVersionStatus(
  ledger: VersionsLedger,
  version: string,
  status: VersionLedgerStatus,
  now: string,
  note?: string | null,
  org?: VersionOrgFilter,
): { ledger: VersionsLedger; changed: boolean; found: boolean } {
  const idx = ledger.versions.findIndex((v) => matchKey(v, version, org));
  if (idx < 0) return { ledger, changed: false, found: false };
  const prev = ledger.versions[idx] as VersionLedgerRecord;
  const nextNote = note === undefined ? prev.note : note === null || note.trim() === "" ? null : note.trim();
  if (prev.status === status && prev.note === nextNote) return { ledger, changed: false, found: true };
  const next = [...ledger.versions];
  next[idx] = { ...prev, status, updatedAt: now, note: nextNote };
  return { ledger: { version: ledger.version, versions: next }, changed: true, found: true };
}

// ---------------------------------------------------------------------------
// 一次性迁移（config `releasedVersions` → 台账 released）
// ---------------------------------------------------------------------------
export interface ReleasedMigrationResult {
  /** 本次实际灌入台账的版本号（首次迁移；非空 ⇒ 应打印迁移回执）。 */
  migrated: string[];
  /** 台账已存在时被忽略的**残留键**值（一次性 warn、不双读；空 = 无残留）。 */
  residual: string[];
  /** 残留键 warn 文案（null = 无）；调用方负责打印一次。 */
  warning: string | null;
}

/** 迁移所需的台账存取面（最小接口，便于单测注入假 store 钉「写失败 ⇒ 抛出」）。 */
export interface MigrationStore {
  /** 台账文件是否已存在（迁移边界：存在 ⇒ 一次性迁移已发生过）。 */
  exists(): boolean;
  load(): { ledger: VersionsLedger; corrupt: boolean };
  /** 把给定版本号以 `status=released` 灌入并落盘（写失败**抛出** ⇒ fail-fast）。 */
  seedReleased(versions: readonly string[], now: string): VersionsLedger;
}

/**
 * 一次性迁移（改造文档 §2.1）：`releasedVersions` 灌入台账 `status=released`。
 * - `releasedVersions` 为空（未配置 / 空数组）⇒ 空操作，无 warn；
 * - 台账**不存在** ⇒ 迁移：全部灌入 + 落盘（`save` 抛出即向上抛 ⇒ **拒起板**）；
 * - 台账**已存在** ⇒ 该键为**残留键**：一次性 warn 文案，**不双读**（不灌入、不改台账）。
 */
export function migrateReleasedVersions(input: {
  releasedVersions: readonly string[];
  store: MigrationStore;
  now: string;
}): ReleasedMigrationResult {
  const wanted: string[] = [];
  for (const raw of input.releasedVersions) {
    const v = typeof raw === "string" ? raw.trim() : "";
    if (v !== "" && !wanted.includes(v)) wanted.push(v);
  }
  if (wanted.length === 0) return { migrated: [], residual: [], warning: null };
  if (input.store.exists()) {
    return {
      migrated: [],
      residual: wanted,
      warning:
        `config.json 的 releasedVersions 为残留键（版本台账已存在）⇒ 已按单一事实源忽略该键、不再读取：` +
        `${wanted.join(" · ")}。请从 config.json 整键删除（版本状态改在板上维护）。`,
    };
  }
  const ledger = input.store.seedReleased(wanted, input.now);
  return { migrated: releasedVersionNames(ledger), residual: [], warning: null };
}

// ---------------------------------------------------------------------------
// 一次性迁移（台账条目补组织维度：schema 1 → 2，口径 32）
// ---------------------------------------------------------------------------

export interface LedgerOrgMigrationResult {
  /** 迁移后的台账（无条目待迁移 ⇒ 原样返回，调用方不得落盘）。 */
  ledger: VersionsLedger;
  /** 本次 stamp 为 `defaultGroup` 的版号（stamp 前这些条目缺 `org` 键 ⇒ 空串；非空 ⇒ 调用方须落盘 + 打回执）。 */
  stamped: string[];
  /** defaultGroup 未配 ⇒ 这些版号留在空串桶 `""`，一次性 warn 文案承载于 warning。 */
  bucketed: string[];
  /** 未配 defaultGroup 的一次性 warn 文案（null = 无）；调用方负责打印一次。 */
  warning: string | null;
}

/**
 * 一次性迁移（口径 32）：台账条目补组织维度 —— **判据 = 条目缺 `org` 键**（容错解析后 `org = ""`）。
 * - `defaultGroup` 已配 ⇒ 缺 org 的条目 stamp 为该组织（其余字段不动），`stamped` 供回执；
 * - `defaultGroup` 未配 ⇒ **不 fail-fast**：条目落空串桶 `""`（只在迁移层存在、门户不暴露）+ 一次性 warn；
 * - 无缺 org 条目 ⇒ 幂等空操作（`stamped` / `bucketed` 皆空、台账原样返回 ⇒ 调用方不写文件，重启不重复 stamp）。
 */
export function migrateLedgerOrgs(
  ledger: VersionsLedger,
  defaultGroup: string | null,
  now: string,
): LedgerOrgMigrationResult {
  const pending = ledger.versions.filter((v) => v.org === "");
  const versions = pending.map((v) => v.version);
  if (pending.length === 0) return { ledger, stamped: [], bucketed: [], warning: null };
  const org = typeof defaultGroup === "string" ? defaultGroup.trim() : "";
  if (org === "") {
    return {
      ledger,
      stamped: [],
      bucketed: versions,
      warning:
        `版本台账有 ${pending.length} 条缺组织维度（schema 1）且未配默认组织（config.json 的 group）` +
        `⇒ 本次不 stamp，条目留在未归属桶 ""（只在迁移层存在、门户不暴露）：${versions.join(" · ")}。` +
        `配上默认组织后重启板即自动归位。`,
    };
  }
  const next = ledger.versions.map((v) => (v.org === "" ? { ...v, org, updatedAt: now } : v));
  return { ledger: { version: VERSIONS_LEDGER_VERSION, versions: next }, stamped: versions, bucketed: [], warning: null };
}

// ---------------------------------------------------------------------------
// 文件层
// ---------------------------------------------------------------------------

/**
 * 台账文件存取（薄封装：读 = 容错解析，坏文件按空台账起，但**如实回报** `corrupt`）。
 * 单写手 = 板进程；写入为 tmp + rename 原子替换。
 */
export class VersionsLedgerStore implements MigrationStore {
  readonly file: string;
  constructor(file: string = defaultVersionsLedgerFile()) {
    this.file = file;
  }

  exists(): boolean {
    return existsSync(this.file);
  }

  load(): { ledger: VersionsLedger; corrupt: boolean } {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return { ledger: emptyVersionsLedger(), corrupt: false };
    }
    try {
      return { ledger: parseVersionsLedger(JSON.parse(raw) as unknown), corrupt: false };
    } catch {
      return { ledger: emptyVersionsLedger(), corrupt: true };
    }
  }

  save(ledger: VersionsLedger): void {
    writeFileAtomic(this.file, serializeVersionsLedger(ledger));
  }

  /** 建版本（read-modify-write；同键 `(org, version)` 已存在 ⇒ `added:false`，文件不写）。 */
  create(version: string, now: string = new Date().toISOString(), org = ""): { ledger: VersionsLedger; added: boolean } {
    const { ledger } = this.load();
    const next = createVersion(ledger, version, now, org);
    if (next.added) this.save(next.ledger);
    return next;
  }

  /** 删除版本（read-modify-write；不存在 ⇒ `removed:false`，文件不写；org 省略 = 不限组织的首个命中）。 */
  remove(version: string, org?: VersionOrgFilter): { ledger: VersionsLedger; removed: boolean } {
    const { ledger } = this.load();
    const next = removeVersion(ledger, version, org);
    if (next.removed) this.save(next.ledger);
    return next;
  }

  /** 设状态（read-modify-write；不存在 ⇒ `found:false`；同值 ⇒ `changed:false`，文件不写）。 */
  setStatus(
    version: string,
    status: VersionLedgerStatus,
    now: string = new Date().toISOString(),
    note?: string | null,
    org?: VersionOrgFilter,
  ): { ledger: VersionsLedger; changed: boolean; found: boolean } {
    const { ledger } = this.load();
    const next = setVersionStatus(ledger, version, status, now, note, org);
    if (next.changed) this.save(next.ledger);
    return next;
  }

  /** 一次性迁移灌入（**写失败抛出** ⇒ 由调用方 fail-fast 拒起板）。与现存条目合并、不覆盖。 */
  seedReleased(versions: readonly string[], now: string): VersionsLedger {
    const { ledger } = this.load();
    let next = ledger;
    for (const v of versions) next = createVersion(next, v, now).ledger;
    let released = next;
    for (const v of versions) {
      // 迁移语义 = 全部置 released（createVersion 只建 notstart；此处补状态）。
      released = setVersionStatus(released, v, "released", now, "migrated:config-releasedVersions").ledger;
    }
    this.save(released);
    return released;
  }
}
