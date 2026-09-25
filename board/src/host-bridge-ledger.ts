/**
 * 板侧**宿主桥私有台账**（v0.9.0 · BD4a）—— 本地 JSON 文件，**不用引擎的 `features` 表**。
 *
 * **为什么归板侧私有**：本台账记的是**进程生命周期事实**（组织 → 桥 pid / 端口 / workspace /
 * 后端 kind / 起停时刻），以及 **CLI 会话句柄与文档路径**。后两类**绝不落 Feature Context** ——
 * `features` 的 `requirement` / `plan` / `context_id` 一类列是执行节点的**注入源**，句柄一旦落进去
 * 会被拼进每一个派发消息（既泄内部标识，又污染上下文）。
 *
 * **不做跨进程并发控制**：板是单进程单写手（§2.2-1 独立进程树），故写入用
 * 「写临时文件 + `renameSync` 覆盖」的原子替换，避免半写文件；不加文件锁。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** 台账 schema 版本（未来加字段时用于迁移判定）。 */
export const LEDGER_VERSION = 1;

/** 缺省台账落点：`<board>/.data/host-bridges.json`（`.data/` 已在 `.gitignore`）。 */
export function defaultLedgerFile(cwd: string = process.cwd()): string {
  return join(resolve(cwd), ".data", "host-bridges.json");
}

/** 一个组织一条宿主桥记录（§2.2-6「每组织一桥」）。 */
export interface HostBridgeRecord {
  /** 组织名 = `projectGroup.name` = MCP URL 首段 = 目录名（一名三用）。 */
  org: string;
  /** 桥进程 pid；未起 / 已收 ⇒ null。 */
  pid: number | null;
  /** 板分配的桥端口；未起 ⇒ null。 */
  port: number | null;
  /** 桥 `--workspace` = 该组织目录。 */
  workspace: string;
  /** 后端 kind（`getAdapter()` 的入参），仅登记、不做映射。 */
  kind: string;
  /** 编排桥 MCP 端点（注入给后端的地址，非秘密）。 */
  mcpUrl: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  /** 最近一次回收/停止原因（`idle` / `manual` / `exited` / …）。 */
  stopReason: string | null;
  /**
   * **CLI 会话句柄**（下一节点写入）—— 只落本台账；
   * 见文件头：落 Feature Context 会被拼进每个执行节点的派发消息。
   */
  cliSessionIds: string[];
  /** **文档路径**（同上，只落本台账）。 */
  docPaths: string[];
}

export interface HostBridgeLedger {
  version: number;
  hosts: HostBridgeRecord[];
}

export type HostBridgePatch = Partial<
  Omit<HostBridgeRecord, "org" | "cliSessionIds" | "docPaths">
> & {
  org: string;
  /** 追加（去重）而非替换 —— 一个组织可能积累多个会话句柄。 */
  cliSessionId?: string;
  docPath?: string;
  /** **整批追加**（同样去重、不覆盖既有集合）—— 读入存量记录 / 一次并入多个句柄时用。 */
  cliSessionIds?: readonly string[];
  docPaths?: readonly string[];
};

// ---------------------------------------------------------------------------
// 纯函数（无 I/O；单测目标）
// ---------------------------------------------------------------------------

export function emptyLedger(): HostBridgeLedger {
  return { version: LEDGER_VERSION, hosts: [] };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s !== null && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 句柄/文档集合的合并：**保留已有 + 追加新到**（按「覆盖」解释是错的 ——
 * 只写生命周期字段的补丁不带数组，一旦覆盖语义就会把先前积累的会话句柄抹掉）。
 * 入参容错走 {@link strArray}（剔空串、去重）。
 */
function mergeArrays(
  prev: readonly string[],
  incoming: string | readonly string[] | undefined,
): string[] {
  if (incoming === undefined) return [...prev];
  const adds = typeof incoming === "string" ? [incoming] : incoming;
  const out = [...prev];
  for (const item of adds) {
    if (item.length > 0 && !out.includes(item)) out.push(item);
  }
  return out;
}

/** 单条记录的容错解析（缺字段回落 null / 空数组，**不臆造**）。 */
export function parseHostRecord(input: unknown): HostBridgeRecord | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const org = str(r.org);
  if (org === null) return null;
  return {
    org,
    pid: numOrNull(r.pid),
    port: numOrNull(r.port),
    workspace: str(r.workspace) ?? "",
    kind: str(r.kind) ?? "",
    mcpUrl: strOrNull(r.mcpUrl),
    startedAt: strOrNull(r.startedAt),
    stoppedAt: strOrNull(r.stoppedAt),
    stopReason: strOrNull(r.stopReason),
    cliSessionIds: strArray(r.cliSessionIds),
    docPaths: strArray(r.docPaths),
  };
}

/** 整本台账的容错解析（坏 JSON / 非对象 ⇒ 空台账；同名记录后读到覆盖前者）。 */
export function parseLedger(raw: unknown): HostBridgeLedger {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyLedger();
  const body = raw as Record<string, unknown>;
  const entries: readonly unknown[] = Array.isArray(body.hosts) ? body.hosts : [];
  let out: HostBridgeLedger = {
    version: numOrNull(body.version) ?? LEDGER_VERSION,
    hosts: [],
  };
  for (const entry of entries) {
    const rec = parseHostRecord(entry);
    if (rec === null) continue;
    out = upsertHost(out, rec);
  }
  return out;
}

/** 序列化（固定缩进 2，便于人读与 diff）。 */
export function serializeLedger(ledger: HostBridgeLedger): string {
  return JSON.stringify({ version: LEDGER_VERSION, hosts: ledger.hosts }, null, 2) + "\n";
}

export function findHost(ledger: HostBridgeLedger, org: string): HostBridgeRecord | null {
  return ledger.hosts.find((h) => h.org === org) ?? null;
}

/**
 * 按 org upsert（**纯函数**，返回新对象；未给出的字段维持原值）。
 * `cliSessionId` / `docPath` 与整批 `cliSessionIds` / `docPaths` 都是**追加**语义（去重、
 * 不覆盖既有集合 —— {@link mergeArrays}），其余标量是覆盖语义。
 * 追加而非覆盖是硬要求：只写生命周期字段的补丁不得抹掉已积累的会话句柄。
 */
export function upsertHost(ledger: HostBridgeLedger, patch: HostBridgePatch): HostBridgeLedger {
  const prev = findHost(ledger, patch.org);
  const base: HostBridgeRecord = prev ?? {
    org: patch.org,
    pid: null,
    port: null,
    workspace: "",
    kind: "",
    mcpUrl: null,
    startedAt: null,
    stoppedAt: null,
    stopReason: null,
    cliSessionIds: [],
    docPaths: [],
  };
  const next: HostBridgeRecord = {
    ...base,
    pid: patch.pid !== undefined ? patch.pid : base.pid,
    port: patch.port !== undefined ? patch.port : base.port,
    workspace: patch.workspace !== undefined ? patch.workspace : base.workspace,
    kind: patch.kind !== undefined ? patch.kind : base.kind,
    mcpUrl: patch.mcpUrl !== undefined ? patch.mcpUrl : base.mcpUrl,
    startedAt: patch.startedAt !== undefined ? patch.startedAt : base.startedAt,
    stoppedAt: patch.stoppedAt !== undefined ? patch.stoppedAt : base.stoppedAt,
    stopReason: patch.stopReason !== undefined ? patch.stopReason : base.stopReason,
    cliSessionIds: mergeArrays(base.cliSessionIds, patch.cliSessionIds ?? patch.cliSessionId),
    docPaths: mergeArrays(base.docPaths, patch.docPaths ?? patch.docPath),
  };
  const hosts = prev === null ? [...ledger.hosts, next] : ledger.hosts.map((h) => (h.org === patch.org ? next : h));
  return { version: ledger.version, hosts };
}

/** 摘除一个组织的记录（删除组织时用；不存在 ⇒ 原样返回）。 */
export function removeHost(ledger: HostBridgeLedger, org: string): HostBridgeLedger {
  return { version: ledger.version, hosts: ledger.hosts.filter((h) => h.org !== org) };
}

// ---------------------------------------------------------------------------
// 文件层
// ---------------------------------------------------------------------------

/** 原子写（临时文件 + rename），建父目录。 */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/**
 * 台账文件存取（薄封装：读 = 容错解析，坏文件按空台账起，但**如实回报**）。
 * `corrupt` 标记用于板显示「台账读坏了」，不得静默当成「没有记录」。
 */
export class HostBridgeLedgerStore {
  readonly file: string;
  constructor(file: string = defaultLedgerFile()) {
    this.file = file;
  }

  load(): { ledger: HostBridgeLedger; corrupt: boolean } {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return { ledger: emptyLedger(), corrupt: false };
    }
    try {
      return { ledger: parseLedger(JSON.parse(raw) as unknown), corrupt: false };
    } catch {
      return { ledger: emptyLedger(), corrupt: true };
    }
  }

  save(ledger: HostBridgeLedger): void {
    writeFileAtomic(this.file, serializeLedger(ledger));
  }

  /** 一次 read-modify-write（同一进程内串行调用即可）。 */
  update(patch: HostBridgePatch | HostBridgePatch[]): HostBridgeLedger {
    const { ledger } = this.load();
    const patches = Array.isArray(patch) ? patch : [patch];
    let next = ledger;
    for (const p of patches) next = upsertHost(next, p);
    this.save(next);
    return next;
  }
}
