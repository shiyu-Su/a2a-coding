/**
 * 板侧 **suspended 台账**（v0.9.5 C7 · T7）—— 本地 JSON 文件 `.data/suspended.json`。
 *
 * 事实源：`doc/v0.9.5/推进流程精简-改造文档.md` §2-C7 + 确认单 §6–§9。
 *
 * **语义（R2 定稿，文档与测试均按此钉死）**：
 * - **内存为事实源；`.data/*.json` 仅供崩溃取证，启动即清空重写** —— 与停链标志落内存同口径，
 *   重启即无链（板心跳的监视对象是**进程内**挂起条目，不跨重启）；
 * - 一条需求一条（按 `featureId` keyed），条目 =
 *   `(featureId, turnId, contextId, pending[], wakeCond?, firedKeys[], createdAt)`；
 * - `turnId` = **板发轮**标识（归属校验在写口 handler：必须等于该需求最新板发轮；agent 客户端任务
 *   天然没有板发 turnId ⇒ 进不了本台账）；
 * - `pending[]` = inquiry 子任务 id 清单（空 = 纯 DAG 监视）；`wakeCond?` = 可选唤醒条件
 *   （有界不透明串，解释权归 C8 评估器）；`firedKeys[]` = **去重位**（同一条件只唤一次，C8 写）。
 * - **停链时同条目清**（与停链标志同生死）：清条目挂接在停链口，载体（停链标志 / 链内计数）
 *   归 T2/T3 单一定义，本模块**不另造任何链状态**。
 *
 * 单进程单写手（板进程）⇒ 原子替换写（tmp + rename），与其余台账同口径**不加文件锁**。
 * **坏文件 fail-closed**：`load()` 对坏 JSON / 坏形状一律回落空台账并如实回报 `corrupt=true`，
 * **绝不信任半截数据**；写入为崩溃取证，**best-effort**（写失败不得反噬在飞挂起链 —— 内存才是事实源）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./host-bridge-ledger.js";

/** 台账 schema 版本（未来加字段时用于迁移判定）。 */
export const SUSPEND_LEDGER_VERSION = 1;

/** 缺省台账落点：`<board>/.data/suspended.json`（`.data/` 已在 `.gitignore`）。 */
export function defaultSuspendLedgerFile(cwd: string = process.cwd()): string {
  return join(resolve(cwd), ".data", "suspended.json");
}

/** 一条挂起条目（内存事实源的一份；`.data` 落盘是同形快照）。 */
export interface SuspendedEntry {
  /** 需求标识（keyed：一条需求至多一条挂起条目）。 */
  featureId: string;
  /** 登记时的**板发轮**标识（归属校验键；agent 客户端任务没有它）。 */
  turnId: string;
  /** 该轮所属会话（唤醒时同 `contextId` 续推的事实源）。 */
  contextId: string;
  /** inquiry 子任务 id 清单（空数组 = 纯 DAG 监视）。 */
  pending: string[];
  /** 可选唤醒条件（有界串；解释权归 C8 评估器）；无 ⇒ null。 */
  wakeCond: string | null;
  /** 已唤去重键（同一条件只唤一次；C8 评估命中时经 {@link SuspendLedgerStore.recordFired} 写入）。 */
  firedKeys: string[];
  /** 登记时刻（ISO）。 */
  createdAt: string;
}

export interface SuspendLedger {
  version: number;
  entries: SuspendedEntry[];
}

// ---------------------------------------------------------------------------
// 纯函数（无 I/O；单测目标）
// ---------------------------------------------------------------------------

export function emptySuspendLedger(): SuspendLedger {
  return { version: SUSPEND_LEDGER_VERSION, entries: [] };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** 字符串数组容错解析：只留非空串、去重保序（缺 / 非数组 ⇒ 空数组，不臆造）。 */
function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s !== null && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 单条挂起条目的容错解析：`featureId` / `turnId` / `contextId` 任一缺失 / 空白 ⇒ 丢条目（不臆造）。 */
export function parseSuspendedEntry(input: unknown): SuspendedEntry | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const featureId = str(r.featureId);
  const turnId = str(r.turnId);
  const contextId = str(r.contextId);
  if (featureId === null || turnId === null || contextId === null) return null;
  return {
    featureId,
    turnId,
    contextId,
    pending: strArray(r.pending),
    wakeCond: str(r.wakeCond),
    firedKeys: strArray(r.firedKeys),
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
  };
}

/** 整本台账容错解析（坏形状 ⇒ 空台账；同 `featureId` 后读到覆盖前者，不叠双条目）。 */
export function parseSuspendLedger(raw: unknown): SuspendLedger {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptySuspendLedger();
  const body = raw as Record<string, unknown>;
  const entries: readonly unknown[] = Array.isArray(body.entries) ? body.entries : [];
  const out: SuspendLedger = {
    version:
      typeof body.version === "number" && Number.isInteger(body.version) ? body.version : SUSPEND_LEDGER_VERSION,
    entries: [],
  };
  for (const entry of entries) {
    const rec = parseSuspendedEntry(entry);
    if (rec === null) continue;
    const idx = out.entries.findIndex((e) => e.featureId === rec.featureId);
    if (idx >= 0) out.entries[idx] = rec;
    else out.entries.push(rec);
  }
  return out;
}

/** 序列化（固定缩进 2 + 行尾换行，口径同其余台账）。 */
export function serializeSuspendLedger(ledger: SuspendLedger): string {
  return JSON.stringify({ version: SUSPEND_LEDGER_VERSION, entries: ledger.entries }, null, 2) + "\n";
}

/** upsert（纯函数）：按 `featureId` 覆盖同 key 条目（重挂起 = 覆盖，不叠条目）；不改动入参。 */
export function upsertSuspendedEntry(
  ledger: SuspendLedger,
  entry: SuspendedEntry,
): { ledger: SuspendLedger; replaced: boolean } {
  const idx = ledger.entries.findIndex((e) => e.featureId === entry.featureId);
  if (idx < 0) return { ledger: { version: ledger.version, entries: [...ledger.entries, entry] }, replaced: false };
  const next = [...ledger.entries];
  next[idx] = entry;
  return { ledger: { version: ledger.version, entries: next }, replaced: true };
}

/** 删条目（纯函数）：不存在 ⇒ 原样返回 + `removed: false`。 */
export function removeSuspendedEntry(
  ledger: SuspendLedger,
  featureId: string,
): { ledger: SuspendLedger; removed: boolean } {
  if (!ledger.entries.some((e) => e.featureId === featureId)) return { ledger, removed: false };
  return {
    ledger: { version: ledger.version, entries: ledger.entries.filter((e) => e.featureId !== featureId) },
    removed: true,
  };
}

/** 追加去重键（纯函数）：已存在 / 空键 ⇒ `changed: false`（幂等，文件不动）。 */
export function addFiredKey(
  ledger: SuspendLedger,
  featureId: string,
  key: string,
): { ledger: SuspendLedger; changed: boolean } {
  const k = key.trim();
  if (k === "") return { ledger, changed: false };
  const idx = ledger.entries.findIndex((e) => e.featureId === featureId);
  if (idx < 0) return { ledger, changed: false };
  const prev = ledger.entries[idx] as SuspendedEntry;
  if (prev.firedKeys.includes(k)) return { ledger, changed: false };
  const next = [...ledger.entries];
  next[idx] = { ...prev, firedKeys: [...prev.firedKeys, k] };
  return { ledger: { version: ledger.version, entries: next }, changed: true };
}

// ---------------------------------------------------------------------------
// 文件层（内存为事实源；`.data` 仅供崩溃取证）
// ---------------------------------------------------------------------------

/** `arm` 的入参（`firedKeys` / `createdAt` 由 store 归一，调用方不必构造）。 */
export interface ArmSuspendedInput {
  featureId: string;
  turnId: string;
  contextId: string;
  pending: readonly string[];
  wakeCond?: string | null;
}

/**
 * suspended 台账存取：**内存 `entries` 为事实源**，`.data/<file>` 为崩溃取证快照。
 * - 构造即 {@link reset}（**启动清空重写**：重启即无链，与停链口径一致）；
 * - 变更 API（`arm` / `clear` / `recordFired`）先改内存、再 best-effort 落盘；
 * - `load()` 只读文件（取证 / 单测用），坏文件回落空台账 + `corrupt=true`（fail-closed）。
 */
export class SuspendLedgerStore {
  readonly file: string;
  private entries: SuspendedEntry[] = [];

  constructor(file: string = defaultSuspendLedgerFile()) {
    this.file = file;
    this.reset();
  }

  /** **启动清空重写**：内存清空 + best-effort 覆盖 `.data` 快照（不跨重启）。 */
  reset(): void {
    this.entries = [];
    this.persist();
  }

  /** 取证读（只读文件，不改内存）：缺文件 = 空台账且非坏；坏 JSON ⇒ 空台账 + `corrupt=true`。 */
  load(): { ledger: SuspendLedger; corrupt: boolean } {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return { ledger: emptySuspendLedger(), corrupt: false };
    }
    try {
      return { ledger: parseSuspendLedger(JSON.parse(raw) as unknown), corrupt: false };
    } catch {
      return { ledger: emptySuspendLedger(), corrupt: true };
    }
  }

  /** 全部挂起条目（内存事实源的只读视图；按登记序）。 */
  list(): readonly SuspendedEntry[] {
    return this.entries;
  }

  /** 查该需求的挂起条目；无 ⇒ null。 */
  get(featureId: string): SuspendedEntry | null {
    return this.entries.find((e) => e.featureId === featureId) ?? null;
  }

  exists(featureId: string): boolean {
    return this.get(featureId) !== null;
  }

  /**
   * **挂起登记（upsert）**：置 / 覆盖该需求的内存条目（`firedKeys` 归零、`createdAt` 取当前时刻），
   * 再 best-effort 落盘快照。同需求重复登记 = 覆盖（不叠条目）。
   */
  arm(input: ArmSuspendedInput, now: string = new Date().toISOString()): SuspendedEntry {
    const entry: SuspendedEntry = {
      featureId: input.featureId,
      turnId: input.turnId,
      contextId: input.contextId,
      pending: [...new Set(input.pending.map((p) => p.trim()).filter((p) => p !== ""))],
      wakeCond: input.wakeCond === undefined || input.wakeCond === null || input.wakeCond.trim() === ""
        ? null
        : input.wakeCond.trim(),
      firedKeys: [],
      createdAt: now,
    };
    const next = upsertSuspendedEntry({ version: SUSPEND_LEDGER_VERSION, entries: this.entries }, entry);
    this.entries = next.ledger.entries;
    this.persist();
    return entry;
  }

  /** **停链清条目**（与停链标志同生死）：有该需求条目 ⇒ 删并落盘 + `true`；无 ⇒ `false`（幂等）。 */
  clear(featureId: string): boolean {
    const next = removeSuspendedEntry({ version: SUSPEND_LEDGER_VERSION, entries: this.entries }, featureId);
    if (!next.removed) return false;
    this.entries = next.ledger.entries;
    this.persist();
    return true;
  }

  /** 记一次已唤（去重位）：新键 ⇒ `true` 并落盘；已存在 / 无条目 ⇒ `false`（幂等）。 */
  recordFired(featureId: string, key: string): boolean {
    const next = addFiredKey({ version: SUSPEND_LEDGER_VERSION, entries: this.entries }, featureId, key);
    if (!next.changed) return false;
    this.entries = next.ledger.entries;
    this.persist();
    return true;
  }

  /**
   * best-effort 落盘（崩溃取证）：写失败**不得**反噬在飞挂起链（内存才是事实源），
   * 故吞掉异常，绝不让 `.data` 的可用性决定链条生死。
   */
  private persist(): void {
    try {
      writeFileAtomic(this.file, serializeSuspendLedger({ version: SUSPEND_LEDGER_VERSION, entries: this.entries }));
    } catch {
      // 取证面失败不阻断；内存事实源照常可用。
    }
  }
}
