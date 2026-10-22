/**
 * 板侧**组织台账**（v0.9.4 A1 · REQ-2026-09-26-01）—— 本地 JSON 文件 `.data/orgs.json`。
 *
 * **条目只携「停用」态**（`{org, disabledAt}`）：`/orgs` 四源归并**不扩五源**、
 * `mergeOrgNames` 判据不变 —— 「停用」是唯一需要显式过滤的状态源（防两处事实源打架，
 * board R1 ①(2)）；建组织（BD1）= 纯新建 `disabledAt = null`，停用（= 板上的「删除」，BD3 A3）
 * 经 {@link disableOrg} 写 `disabledAt`；**不物理删目录** ⇒ 同名重建 = 复活该条记录（零迁移，见 {@link addOrg}）。
 *
 * 原子写复用 `atomic-write.ts` 的 {@link writeFileAtomic}（tmp + rename + 建父目录）；
 * 板是单进程单写手，与宿主桥台账同口径**不加文件锁**。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";

/** 台账 schema 版本（v0.9.8：记录扩 `agentKind`/`agentModel` 两键 ⇒ 1→2。**零迁移** —— 读侧不设版本门、
 * 不做读时升级（{@link parseOrgsLedger} 保留文件自带 version，{@link serializeOrgsLedger} 恒写本常量
 * ⇒ 旧 v1 文件读到即认、下次落盘自动升 2；口径同 `versions-ledger.ts` 序列化注释）。 */
export const ORGS_LEDGER_VERSION = 2;

/** 缺省台账落点：`<board>/.data/orgs.json`（`.data/` 已在 `.gitignore`）。 */
export function defaultOrgsLedgerFile(cwd: string = process.cwd()): string {
  return join(resolve(cwd), ".data", "orgs.json");
}

/** 一个组织一条记录；停用时刻 + **本组织 agent 配置两键**（v0.9.8 · 按项目组配 agent）。 */
export interface OrgLedgerRecord {
  org: string;
  /** ISO 时刻；null = 未停用。停用写入见 {@link disableOrg}（BD3 A3）。 */
  disabledAt: string | null;
  /** 本组织后端适配器（agentKind）；null = 未配 ⇒ 起桥回落全局 kind。 */
  agentKind: string | null;
  /** 本组织宿主后端模型（agentModel）；null = 未配 ⇒ 起桥回落全局 hostModel / 后端缺省。 */
  agentModel: string | null;
}

export interface OrgsLedger {
  version: number;
  orgs: OrgLedgerRecord[];
}

// ---------------------------------------------------------------------------
// 纯函数（无 I/O；单测目标）
// ---------------------------------------------------------------------------

export function emptyOrgsLedger(): OrgsLedger {
  return { version: ORGS_LEDGER_VERSION, orgs: [] };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * 单条记录的容错解析（org 缺失 / 空白 ⇒ null；disabledAt / agentKind / agentModel 非字符串或空白 ⇒ null，
 * **不臆造**）。两 agent 键**恒写显式 null 不省略**（照 versions 台账形态；旧 v1 文件无这两键 ⇒ 读到即 null）。
 */
export function parseOrgRecord(input: unknown): OrgLedgerRecord | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const org = str(r.org);
  if (org === null) return null;
  return {
    org,
    disabledAt: typeof r.disabledAt === "string" ? r.disabledAt : null,
    agentKind: str(r.agentKind),
    agentModel: str(r.agentModel),
  };
}

/** 整本台账的容错解析（坏 JSON / 非对象 ⇒ 空台账；同名记录后读到覆盖前者）。 */
export function parseOrgsLedger(raw: unknown): OrgsLedger {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyOrgsLedger();
  const body = raw as Record<string, unknown>;
  const entries: readonly unknown[] = Array.isArray(body.orgs) ? body.orgs : [];
  const out: OrgsLedger = {
    version: typeof body.version === "number" && Number.isInteger(body.version) ? body.version : ORGS_LEDGER_VERSION,
    orgs: [],
  };
  for (const entry of entries) {
    const rec = parseOrgRecord(entry);
    if (rec === null) continue;
    const prev = out.orgs.findIndex((o) => o.org === rec.org);
    if (prev >= 0) out.orgs[prev] = rec;
    else out.orgs.push(rec);
  }
  return out;
}

/** 序列化（固定缩进 2，便于人读与 diff；口径同宿主桥台账）。 */
export function serializeOrgsLedger(ledger: OrgsLedger): string {
  return JSON.stringify({ version: ORGS_LEDGER_VERSION, orgs: ledger.orgs }, null, 2) + "\n";
}

export function findOrgRecord(ledger: OrgsLedger, org: string): OrgLedgerRecord | null {
  return ledger.orgs.find((o) => o.org === org) ?? null;
}

/** 台账内全部组织名（含停用 —— 需要「只看在用」时用 {@link enabledOrgNames}）。 */
export function ledgerOrgNames(ledger: OrgsLedger): string[] {
  return ledger.orgs.map((o) => o.org);
}

/**
 * 建组织（**纯函数**）：
 * - 同名记录不存在 ⇒ 追加 `{org, disabledAt: null, agentKind: null, agentModel: null}`，`added: true`；
 * - 同名记录**已停用** ⇒ **复活**为未停用（`disabledAt = null`），同样 `added: true` —— 这是 A3 的
 *   「不物理删目录 ⇒ 同名重建零迁移」：目录与工作区原样不动，台账只把停用标记抹掉；
 *   **复活保留旧 agent 配置**（v0.9.8 用户裁①：spread 既有记录，只改 `disabledAt`）；
 * - 同名记录**未停用** ⇒ 原样返回 + `added: false`（重名闸在 handler 层已先行拒绝，这里只是幂等兜底）。
 */
export function addOrg(ledger: OrgsLedger, org: string): { ledger: OrgsLedger; added: boolean } {
  const index = ledger.orgs.findIndex((o) => o.org === org);
  if (index < 0) {
    return {
      ledger: { version: ledger.version, orgs: [...ledger.orgs, { org, disabledAt: null, agentKind: null, agentModel: null }] },
      added: true,
    };
  }
  const existing = ledger.orgs[index] as OrgLedgerRecord;
  if (existing.disabledAt === null) return { ledger, added: false };
  const next = [...ledger.orgs];
  next[index] = { ...existing, disabledAt: null };
  return { ledger: { version: ledger.version, orgs: next }, added: true };
}

/**
 * 停用 = 板上的「删除」（BD3 A3，**纯函数**）：写 `disabledAt`，**不物理删目录、不删台账条目**。
 * - 记录不存在 ⇒ 追加一条停用记录（磁盘枚举 / 需求归属里已有、但从未在板上建过的组织同样可停）；
 * - 记录未停用 ⇒ 写入给定时刻；
 * - 记录**已停用** ⇒ 原样返回 + `changed: false`（幂等，**保留首次停用时刻**，不被重复点击刷新）。
 */
export function disableOrg(
  ledger: OrgsLedger,
  org: string,
  disabledAt: string,
): { ledger: OrgsLedger; changed: boolean } {
  const index = ledger.orgs.findIndex((o) => o.org === org);
  if (index < 0) {
    return {
      ledger: { version: ledger.version, orgs: [...ledger.orgs, { org, disabledAt, agentKind: null, agentModel: null }] },
      changed: true,
    };
  }
  const existing = ledger.orgs[index] as OrgLedgerRecord;
  if (existing.disabledAt !== null) return { ledger, changed: false };
  const next = [...ledger.orgs];
  // spread 保留既有键（v0.9.8：停用不得吞掉本组织 agent 配置 —— 复活时照旧生效，用户裁①的另一半）
  next[index] = { ...existing, disabledAt };
  return { ledger: { version: ledger.version, orgs: next }, changed: true };
}

/**
 * 写本组织 agent 配置两键（v0.9.8 · 按项目组配 agent，**纯函数**）：**整体覆盖**（传 null = 置 null =
 * 恢复全局回落），不做增量 PATCH。
 * - 记录不存在 ⇒ 原样返回 + `found: false`（目标组织「须在台账」由 handler 判 404）；
 * - 命中 ⇒ 只改 `agentKind` / `agentModel` 两键（spread 保留 `disabledAt` 等其余键），**不改动入参**。
 */
export function setOrgHostAgent(
  ledger: OrgsLedger,
  org: string,
  agentKind: string | null,
  agentModel: string | null,
): { ledger: OrgsLedger; found: boolean } {
  const index = ledger.orgs.findIndex((o) => o.org === org);
  if (index < 0) return { ledger, found: false };
  const existing = ledger.orgs[index] as OrgLedgerRecord;
  const next = [...ledger.orgs];
  next[index] = { ...existing, agentKind, agentModel };
  return { ledger: { version: ledger.version, orgs: next }, found: true };
}

/** 该组织是否已停用（**唯一判据** = 台账里有记录且 `disabledAt !== null`；无记录 ⇒ 未停用）。 */
export function isOrgDisabled(ledger: OrgsLedger, org: string): boolean {
  const rec = findOrgRecord(ledger, org);
  return rec !== null && rec.disabledAt !== null;
}

/** 台账内**已停用**的组织名（A4 过滤源：建组织查重的「可重建」豁免 + 停用态置灰隔离展示）。 */
export function disabledOrgNames(ledger: OrgsLedger): string[] {
  return ledger.orgs.filter((o) => o.disabledAt !== null).map((o) => o.org);
}

/** 台账内**未停用**的组织名（{@link ledgerOrgNames} 减去停用集）。 */
export function enabledOrgNames(ledger: OrgsLedger): string[] {
  return ledger.orgs.filter((o) => o.disabledAt === null).map((o) => o.org);
}

// ---------------------------------------------------------------------------
// 文件层
// ---------------------------------------------------------------------------

/**
 * 台账文件存取（薄封装：读 = 容错解析，坏文件按空台账起，但**如实回报** `corrupt`）。
 * 消费：建组织（查重源 + 写入）· BD2 管理页 · BD3 停用写 —— 单写手 = 板进程。
 */
export class OrgsLedgerStore {
  readonly file: string;
  constructor(file: string = defaultOrgsLedgerFile()) {
    this.file = file;
  }

  load(): { ledger: OrgsLedger; corrupt: boolean } {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return { ledger: emptyOrgsLedger(), corrupt: false };
    }
    try {
      return { ledger: parseOrgsLedger(JSON.parse(raw) as unknown), corrupt: false };
    } catch {
      return { ledger: emptyOrgsLedger(), corrupt: true };
    }
  }

  save(ledger: OrgsLedger): void {
    writeFileAtomic(this.file, serializeOrgsLedger(ledger));
  }

  /** 一次 read-modify-write 建组织（停用记录 ⇒ 复活；未停用同名已存在 ⇒ `added: false`，文件不写）。 */
  addOrg(org: string): { ledger: OrgsLedger; added: boolean } {
    const { ledger } = this.load();
    const next = addOrg(ledger, org);
    if (next.added) this.save(next.ledger);
    return next;
  }

  /**
   * 一次 read-modify-write 停用（A3「删除」）：已停用 ⇒ `changed: false`，文件逐字节不动（幂等，
   * 保留首次停用时刻）。时刻源可注入（单测钉死时钟）。
   */
  disableOrg(org: string, now: () => string = () => new Date().toISOString()): { ledger: OrgsLedger; changed: boolean } {
    const { ledger } = this.load();
    const next = disableOrg(ledger, org, now());
    if (next.changed) this.save(next.ledger);
    return next;
  }

  /**
   * 一次 read-modify-write 写本组织 agent 配置两键（v0.9.8 · 板唯一台账写封装之一）：
   * 记录不在台账 ⇒ `found: false`，**文件零写**（404 语义由 handler 承担）。
   */
  setOrgHostAgent(
    org: string,
    agentKind: string | null,
    agentModel: string | null,
  ): { ledger: OrgsLedger; found: boolean } {
    const { ledger } = this.load();
    const next = setOrgHostAgent(ledger, org, agentKind, agentModel);
    if (next.found) this.save(next.ledger);
    return next;
  }
}
