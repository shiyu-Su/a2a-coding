/**
 * 板侧**对话轮台账**（v0.9.0 · BD4b）—— 本地 JSON 文件，**不用引擎的 `features` 表**。
 *
 * 事实源：`doc/v0.9.0/Web看板与确认入口-改造文档.md`
 * - **§2.2-6**：桥内**每需求一个 `contextId`**（复用的是**会话**）⇒ `contextId` 由**板分配并落账**，
 *   同一需求的后续轮（澄清续推 / 重派）复用同一条记录；跨需求绝不共享；
 * - **§2.2-7**：桥崩溃后**重拉 + 同 `contextId` 回退**，且「会话可能已回退为新建」**须让用户看见**
 *   ⇒ 每条轮记录带 `bridgeNote`；
 * - **§3.4 R4**：**板在同一桥上一时刻只允许 1 个在飞 prompt**（桥内零并发闸）⇒ 排队中的轮也要出账，
 *   界面才显示得出「排队中」。
 *
 * **为什么归板侧私有**（与 `host-bridge-ledger.ts` 同一理由）：这些是**板自己的会话/轮次事实**
 * （谁在排队、哪条需求绑了哪个 `contextId`、本轮摘要是什么），**绝不落 Feature Context** ——
 * `features` 的文本列是执行节点的注入源，写进去会被拼进每一个派发消息。
 *
 * **本台账不写引擎状态机迁移**（BD4b 硬约束）：这里只有板侧记账，`approve` / `cancel` / 主链 `advance`
 * 全归编排 agent（`version` 排期写经 advance「`to` = 当前态」登记字段特例，唯一落点在 `feature-schedule.ts`）。
 *
 * 单进程单写手（§2.2-1 独立进程树）⇒ 原子替换写（临时文件 + rename），不加文件锁。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Receipt } from "./receipt.js";

/**
 * 台账 schema 版本。
 *
 * **receipt 字段不 bump 本版本**（已裁定）：该常量当前无任何读者（grep 无版本分支），
 * bump 只是净增耦合。`receipt` 的向后兼容靠 {@link parseTurnRecord} 的**显式解析分支**
 * —— 旧记录缺该字段 ⇒ 解析为 `null`，不写 `if (version < 2)` 之类的版本分支。
 */
export const TURN_LEDGER_VERSION = 1;

/** 缺省落点：`<board>/.data/host-turns.json`（与进程台账分文件，互不覆盖）。 */
export function defaultTurnLedgerFile(cwd: string = process.cwd()): string {
  return join(resolve(cwd), ".data", "host-turns.json");
}

/**
 * 板侧轮状态（**不是** Feature 状态机，也**不是** A2A 任务态）：
 * `queued` = 等同桥的闸（§3.4：一桥一在飞）· `awaiting_answer` = A2A `input-required`
 * （**不是失败**，是要人回答）· 其余为终态。
 */
export type TurnState =
  | "queued"
  | "running"
  | "awaiting_answer"
  | "succeeded"
  | "failed"
  | "canceled"
  | "timeout";

/** 轮态的终态闭集（`awaiting_answer` **不在其中** —— 它等的是人，不是调度器）。 */
export const TERMINAL_TURN_STATES: readonly TurnState[] = [
  "succeeded",
  "failed",
  "canceled",
  "timeout",
];

export function isTerminalTurnState(state: string): boolean {
  return (TERMINAL_TURN_STATES as readonly string[]).includes(state);
}

/** 需求 → 会话记录（一条需求一条，`contextId` 终身复用）。 */
export interface RequirementSessionRecord {
  requirementId: string;
  /** 组织名 = 桥 = 单飞闸的层（§3.4：并发上限挂在桥，不是"每需求一个"）。 */
  org: string;
  /** 板分配的 A2A `contextId`。 */
  contextId: string;
  /** 已开过的轮数（1 起）。 */
  round: number;
  firstTurnAt: string;
  updatedAt: string;
}

/** 一轮对话的记录。 */
export interface TurnRecord {
  turnId: string;
  requirementId: string;
  org: string;
  contextId: string;
  /** 桥返回的 A2A 任务 id；未派发成功 ⇒ null。 */
  taskId: string | null;
  state: TurnState;
  /** 剥块后的结果摘要（截断，供界面显示）。 */
  summary: string | null;
  /** `awaiting_answer` 时的问题原文。 */
  question: string | null;
  /** 结构化错误（**不得静默**）。 */
  error: { code: string; message: string } | null;
  /** 桥重拉后同 `contextId` 续 ⇒ 会话可能已回退为新建（§2.2-7「须让用户看见」）。 */
  bridgeNote: string | null;
  /**
   * 本轮尾部【回执】块的结构化结果（契约与类型见 `receipt.ts`）——
   * 嵌套对象（**不用 head/todo/next 三平行字段**，R1 裁定）。
   * 旧记录无此字段、或回执结构损坏 ⇒ `null`（界面按「无回执」渲染）。
   */
  receipt?: Receipt | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface HostTurnLedger {
  version: number;
  requirements: RequirementSessionRecord[];
  turns: TurnRecord[];
}

/** `turns` 的留存上限（超出按 `queuedAt` 丢最老的 —— 只裁历史，**不裁未结束的轮**）。 */
export const TURN_HISTORY_CAP = 200;

// ---------------------------------------------------------------------------
// 纯函数（无 I/O；单测目标）
// ---------------------------------------------------------------------------

export function emptyTurnLedger(): HostTurnLedger {
  return { version: TURN_LEDGER_VERSION, requirements: [], turns: [] };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const TURN_STATES: readonly string[] = [
  "queued",
  "running",
  "awaiting_answer",
  "succeeded",
  "failed",
  "canceled",
  "timeout",
];

function parseError(v: unknown): { code: string; message: string } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const e = v as Record<string, unknown>;
  const code = str(e.code);
  const message = str(e.message);
  if (code === null || message === null) return null;
  return { code, message };
}

/** 字符串数组的容错解析（非数组 / 含非字符串 ⇒ null，**不臆造**）。 */
function stringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/**
 * 回执字段的容错解析（receipt.ts 的 Receipt 落账形态）。
 * 缺字段 / 显式 null ⇒ null（**旧记录兼容**）；三键不全或类型不符 ⇒ null（结构损坏）。
 * 注意：本函数**只决定 receipt 的值**，不因回执坏掉而丢弃整条轮记录。
 */
function parseReceiptField(v: unknown): Receipt {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const head = stringArray(r.head);
  const todo = stringArray(r.todo);
  if (head === null || todo === null) return null;
  if (typeof r.next !== "string") return null;
  return { head, todo, next: r.next };
}

/** 需求会话记录的容错解析（缺字段 ⇒ null，**不臆造**）。 */
export function parseSessionRecord(input: unknown): RequirementSessionRecord | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const requirementId = str(r.requirementId);
  const org = str(r.org);
  const contextId = str(r.contextId);
  if (requirementId === null || org === null || contextId === null) return null;
  return {
    requirementId,
    org,
    contextId,
    round: num(r.round) ?? 1,
    firstTurnAt: str(r.firstTurnAt) ?? "",
    updatedAt: str(r.updatedAt) ?? "",
  };
}

/**
 * 轮记录的容错解析（未知轮态 ⇒ null，防坏数据把界面带偏）。
 *
 * ⚠ **本函数逐字段显式重构对象**：RMW 回路（recordTurn → mutate → load → parse）会把
 * 未在此列出的字段**静默丢弃且无任何告警**。新增 TurnRecord 字段时**必须同步加解析分支**
 * （`receipt` 即此口径；兼容旧记录靠显式解析，不 bump `TURN_LEDGER_VERSION`、不写版本分支）。
 */
export function parseTurnRecord(input: unknown): TurnRecord | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const turnId = str(r.turnId);
  const requirementId = str(r.requirementId);
  const org = str(r.org);
  const contextId = str(r.contextId);
  const state = str(r.state);
  if (turnId === null || requirementId === null || org === null || contextId === null) return null;
  if (state === null || !TURN_STATES.includes(state)) return null;
  return {
    turnId,
    requirementId,
    org,
    contextId,
    taskId: strOrNull(r.taskId),
    state: state as TurnState,
    summary: strOrNull(r.summary),
    question: strOrNull(r.question),
    error: parseError(r.error),
    bridgeNote: strOrNull(r.bridgeNote),
    receipt: parseReceiptField(r.receipt),
    queuedAt: str(r.queuedAt) ?? "",
    startedAt: strOrNull(r.startedAt),
    finishedAt: strOrNull(r.finishedAt),
    updatedAt: str(r.updatedAt) ?? "",
  };
}

/** 整本台账的容错解析（坏 JSON / 非对象 ⇒ 空台账；同 id 记录后读到覆盖前者）。 */
export function parseTurnLedger(raw: unknown): HostTurnLedger {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyTurnLedger();
  const body = raw as Record<string, unknown>;
  let out: HostTurnLedger = {
    version: num(body.version) ?? TURN_LEDGER_VERSION,
    requirements: [],
    turns: [],
  };
  const reqs = Array.isArray(body.requirements) ? body.requirements : [];
  for (const entry of reqs) {
    const rec = parseSessionRecord(entry);
    if (rec === null) continue;
    out = {
      version: out.version,
      requirements: [...out.requirements.filter((s) => s.requirementId !== rec.requirementId), rec],
      turns: out.turns,
    };
  }
  const turns = Array.isArray(body.turns) ? body.turns : [];
  for (const entry of turns) {
    const rec = parseTurnRecord(entry);
    if (rec === null) continue;
    out = upsertTurn(out, rec);
  }
  return out;
}

export function serializeTurnLedger(ledger: HostTurnLedger): string {
  return JSON.stringify(
    {
      version: TURN_LEDGER_VERSION,
      requirements: ledger.requirements,
      turns: ledger.turns,
    },
    null,
    2,
  ) + "\n";
}

export function findSession(
  ledger: HostTurnLedger,
  requirementId: string,
): RequirementSessionRecord | null {
  return ledger.requirements.find((s) => s.requirementId === requirementId) ?? null;
}

export function findTurn(ledger: HostTurnLedger, turnId: string): TurnRecord | null {
  return ledger.turns.find((t) => t.turnId === turnId) ?? null;
}

/**
 * 开一轮 = 取（或首次分配）该需求的 `contextId` 并把轮数 +1（**纯函数**）。
 * 已存在 ⇒ **沿用同一条 `contextId`**（澄清续推 / 重派走的就是这里）；
 * 未存在 ⇒ 用 `makeContextId()` 新建。跨需求不可能相同（记录按需求 keyed）。
 */
export function openSession(
  ledger: HostTurnLedger,
  input: { requirementId: string; org: string; at: string },
  makeContextId: () => string,
): { ledger: HostTurnLedger; contextId: string; round: number } {
  const prev = findSession(ledger, input.requirementId);
  if (prev !== null) {
    const next: RequirementSessionRecord = { ...prev, round: prev.round + 1, updatedAt: input.at };
    return {
      ledger: {
        version: ledger.version,
        requirements: ledger.requirements.map((s) =>
          s.requirementId === input.requirementId ? next : s,
        ),
        turns: ledger.turns,
      },
      contextId: prev.contextId,
      round: next.round,
    };
  }
  const created: RequirementSessionRecord = {
    requirementId: input.requirementId,
    org: input.org,
    contextId: makeContextId(),
    round: 1,
    firstTurnAt: input.at,
    updatedAt: input.at,
  };
  return {
    ledger: { ...ledger, requirements: [...ledger.requirements, created] },
    contextId: created.contextId,
    round: 1,
  };
}

/** 按 turnId upsert 一条轮记录，并按 {@link TURN_HISTORY_CAP} 裁剪历史。 */
export function upsertTurn(ledger: HostTurnLedger, turn: TurnRecord): HostTurnLedger {
  const prev = findTurn(ledger, turn.turnId);
  const turns = prev === null ? [...ledger.turns, turn] : ledger.turns.map((t) => (t.turnId === turn.turnId ? turn : t));
  return { version: ledger.version, requirements: ledger.requirements, turns: trimTurns(turns) };
}

/**
 * 裁到历史上限：**只裁已结束的轮**，未结束（`queued` / `running` / `awaiting_answer`）一律保留
 * —— 否则「谁在排队」会在压力下变成看不见的幽灵。
 */
export function trimTurns(turns: readonly TurnRecord[], cap: number = TURN_HISTORY_CAP): TurnRecord[] {
  if (turns.length <= cap) return [...turns];
  const open = turns.filter((t) => !isTerminalTurnState(t.state));
  const closed = turns.filter((t) => isTerminalTurnState(t.state));
  const keepClosed = closed.slice(Math.max(0, closed.length - Math.max(0, cap - open.length)));
  return [...keepClosed, ...open];
}

// ---------------------------------------------------------------------------
// 文件层
// ---------------------------------------------------------------------------

/** 原子写（临时文件 + rename），建父目录。 */
export function writeTurnFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/**
 * 对话轮台账存取。`corrupt` 标记供板显示「台账读坏了」，不得静默当成「没有记录」。
 * 每次变更都是 read-modify-write（同进程内串行调用即可）。
 */
export class HostTurnLedgerStore {
  readonly file: string;
  constructor(file: string = defaultTurnLedgerFile()) {
    this.file = file;
  }

  load(): { ledger: HostTurnLedger; corrupt: boolean } {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return { ledger: emptyTurnLedger(), corrupt: false };
    }
    try {
      return { ledger: parseTurnLedger(JSON.parse(raw) as unknown), corrupt: false };
    } catch {
      return { ledger: emptyTurnLedger(), corrupt: true };
    }
  }

  save(ledger: HostTurnLedger): void {
    writeTurnFileAtomic(this.file, serializeTurnLedger(ledger));
  }

  /** 一次 read-modify-write（`fn` 返回需要回显的结果）。 */
  mutate<T>(fn: (ledger: HostTurnLedger) => { ledger: HostTurnLedger; out: T }): T {
    const { ledger } = this.load();
    const { ledger: next, out } = fn(ledger);
    this.save(next);
    return out;
  }

  /** 开一轮（分配或沿用 `contextId`）。 */
  openTurn(
    input: { requirementId: string; org: string; at: string },
    makeContextId: () => string,
  ): { contextId: string; round: number } {
    return this.mutate((ledger) => {
      const { ledger: next, contextId, round } = openSession(ledger, input, makeContextId);
      return { ledger: next, out: { contextId, round } };
    });
  }

  /** 落一条轮记录（追加或按 turnId 覆盖），回写后的台账。 */
  recordTurn(turn: TurnRecord): HostTurnLedger {
    return this.mutate((ledger) => {
      const next = upsertTurn(ledger, turn);
      return { ledger: next, out: next };
    });
  }
}
