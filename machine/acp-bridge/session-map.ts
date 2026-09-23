/**
 * contextId ↔ ACP sessionId 会话映射持久化（REQ-v0.8.0-2026-09-19-01 · 节点 B5）。
 *
 * 落点：`<baseDir>/.a2a/acp-sessions/<projectId>.json`（与 `.a2a/children`、`.a2a/outbox`
 * 同族，machine 运行态产物）。**原子写** = 临时文件 + `rename` 覆盖，避免半写文件。
 * 同步 fs ⇒ 单进程内写天然串行（满足「同进程内串行即可」）。
 *
 * **保留边界（v0.8.9 · M1）**：TTL + 每项目条数 LRU，在启动加载与写穿时收敛；
 * 淘汰**只删本侧映射条目**，绝不销毁后端会话文件（下次同 contextId 走 `session/new`）。
 * 边界取值**可配（v0.8.9 · M5）**：构造入参 `retentionDays` / `retentionMax`，
 * 缺省 = {@link DEFAULT_SESSION_RETENTION_DAYS}（7 天）/ {@link DEFAULT_SESSION_RETENTION_MAX}（500 条）。
 *
 * **零仓内依赖**：不 import `launcher/**` / `orch/**`；文件系统与时钟经构造注入，便于单测。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 映射保留边界（v0.8.9 · M1 引入 / M5 可配化）—— 映射只增不减会让
 * `.a2a/acp-sessions/<projectId>.json` 无界膨胀（每个 contextId 一条、桥长跑即累积）。
 * 两值为**缺省**，可经构造入参 `retentionDays` / `retentionMax` 覆盖
 * （配置面：项目平铺 `agentConfig.sessionRetentionDays` / `sessionRetentionMax`
 * ⇒ adapter ⇒ 桥 flag；与 `sessionTimeoutMs` 语义完全独立、互不派生）。
 */
const DAY_MS = 86_400_000;
/** `retentionDays` 缺省：条目自 `updatedAt` 起保留 7 天。 */
export const DEFAULT_SESSION_RETENTION_DAYS = 7;
/** `retentionMax` 缺省：单项目映射条数上限（超出按 LRU 淘汰最旧）。 */
export const DEFAULT_SESSION_RETENTION_MAX = 500;
/** `lastMessageIds` 长度上限（超出丢最旧）。 */
export const MAX_LAST_MESSAGE_IDS = 32;

/**
 * 单条映射记录。
 *
 * v0.8.1 · M2：增 `prompted`（该会话是否已发出过首轮 prompt ⇒ 注入只发生在首轮）。
 * v0.8.9 · M1：增 `turn` / `lastMessageIds` / `injectedAt`（**状态**，非观测性计量）。
 * **旧文件兼容**：缺键 / 类型不符 ⇒ 取缺省值（`turn` = 0 · `lastMessageIds` = [] ·
 * `prompted` / `injectedAt` = 未注入），读取不报错。
 */
export interface SessionMapEntry {
  sessionId: string;
  /** 最近写入时刻（UTC ISO 8601） */
  updatedAt: string;
  /** 首轮 prompt 是否已收到响应（缺省 = 未注入） */
  prompted?: boolean;
  /** 该映射的会话在桥内已完成的轮次（缺省 = 0） */
  turn: number;
  /** 最近消费的 messageId（有界 ≤{@link MAX_LAST_MESSAGE_IDS}，旧在前） */
  lastMessageIds: string[];
  /** 首轮注入完成时刻（UTC ISO 8601；缺省 = 未注入） */
  injectedAt?: string;
}

/** 可注入文件系统（缺省 `createNodeSessionMapFs()`）。 */
export interface SessionMapFs {
  /** 读取文本；文件不存在 / 不可读返回 `null`（不抛出）。 */
  readText(path: string): string | null;
  writeText(path: string, data: string): void;
  /** 原子覆盖：`from` → `to`。 */
  rename(from: string, to: string): void;
  mkdirp(dir: string): void;
}

/** 缺省文件系统实现（`node:fs` 同步 API）。 */
export function createNodeSessionMapFs(): SessionMapFs {
  return {
    readText(path: string): string | null {
      try {
        return readFileSync(path, "utf8");
      } catch {
        // 文件缺失 / 不可读：视为空映射
        return null;
      }
    },
    writeText(path: string, data: string): void {
      writeFileSync(path, data, "utf8");
    },
    rename(from: string, to: string): void {
      renameSync(from, to);
    },
    mkdirp(dir: string): void {
      mkdirSync(dir, { recursive: true });
    },
  };
}

export interface SessionMapOptions {
  projectId: string;
  /** machine 根目录；`.a2a/acp-sessions` 建于其下。 */
  baseDir: string;
  fs?: SessionMapFs;
  now?: () => Date;
  logger?: (message: string) => void;
  /**
   * 条目保留天数（v0.8.9 · M5）；缺省 / 非正数 ⇒ {@link DEFAULT_SESSION_RETENTION_DAYS}。
   * 与 `sessionTimeoutMs` 无任何派生关系（只管映射留存，不管会话执行窗）。
   */
  retentionDays?: number;
  /** 单项目映射条数上限（v0.8.9 · M5）；缺省 / 非正数 ⇒ {@link DEFAULT_SESSION_RETENTION_MAX}。 */
  retentionMax?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `updatedAt` 的可比较刻度；不可解析 ⇒ 0（视作最旧，LRU 先出）。 */
function stampOf(entry: SessionMapEntry): number {
  const ts = Date.parse(entry.updatedAt);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * 内存映射 + 写穿（每次变更原子落盘）。构造时**启动加载**（损坏文件容错：忽略并以空映射继续）。
 */
export class SessionMap {
  private readonly entries = new Map<string, SessionMapEntry>();
  private readonly filePath: string;
  private readonly fs: SessionMapFs;
  private readonly now: () => Date;
  private readonly logger: (message: string) => void;
  /** 生效 TTL（毫秒），由 `retentionDays` 折算（v0.8.9 · M5）。 */
  private readonly retentionMs: number;
  /** 生效条数上限（v0.8.9 · M5）。 */
  private readonly retentionMax: number;
  private tmpCounter = 0;

  constructor(options: SessionMapOptions) {
    this.fs = options.fs ?? createNodeSessionMapFs();
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? ((): void => undefined);
    this.retentionMax =
      typeof options.retentionMax === "number" &&
      Number.isInteger(options.retentionMax) &&
      options.retentionMax > 0
        ? options.retentionMax
        : DEFAULT_SESSION_RETENTION_MAX;
    this.retentionMs =
      (typeof options.retentionDays === "number" &&
      Number.isInteger(options.retentionDays) &&
      options.retentionDays > 0
        ? options.retentionDays
        : DEFAULT_SESSION_RETENTION_DAYS) * DAY_MS;
    this.filePath = join(options.baseDir, ".a2a", "acp-sessions", `${options.projectId}.json`);
    this.load();
  }

  /** 持久化文件绝对路径。 */
  path(): string {
    return this.filePath;
  }

  /** 取 contextId 对应的 ACP sessionId；无则 `null`。 */
  get(contextId: string): string | null {
    return this.entries.get(contextId)?.sessionId ?? null;
  }

  /** 取 contextId 对应条目（含 `prompted` / `turn` / `lastMessageIds` / `injectedAt` 原始值）；无则 `null`。 */
  getEntry(contextId: string): SessionMapEntry | null {
    return this.entries.get(contextId) ?? null;
  }

  /** 该 contextId 的会话是否已完成首轮 prompt；无映射 ⇒ `false`。 */
  isPrompted(contextId: string): boolean {
    return this.entries.get(contextId)?.prompted === true;
  }

  /**
   * 该 contextId 的会话**是否曾发出过**首轮 prompt（v0.8.9 · M2 的注入判定）。
   * 判据 = `injectedAt` 有值 ⇒ 与「是否收到过响应」（{@link isPrompted}）解耦：
   * 首轮 prompt 超时 / 失败**未收到响应**时也算已注入，重派不再重复注入约定。
   */
  isInjected(contextId: string): boolean {
    return this.entries.get(contextId)?.injectedAt !== undefined;
  }

  /**
   * 记录「首轮 prompt 已发出」并落盘（v0.8.9 · M2）：已有 `injectedAt` 时**保留最早时刻**、不覆盖。
   * 无该键则不动（映射已作废 ⇒ 无从谈注入）。
   */
  markInjected(contextId: string): void {
    const entry = this.entries.get(contextId);
    if (entry === undefined) return;
    if (entry.injectedAt === undefined) entry.injectedAt = this.now().toISOString();
    entry.updatedAt = this.now().toISOString();
    this.persist();
  }

  /**
   * 写入映射并原子落盘。
   *
   * **合并式写入（v0.8.9 · M1）**：仅换 `sessionId` + 刷新 `updatedAt`，**保留**该 contextId
   * 已有的 `prompted` / `injectedAt` / `turn` / `lastMessageIds`（覆盖式写入会把已跑轮次清零，
   * 使注入判定与重放判定失忆）。会话确已作废时由调用方先 {@link delete} 再 `set`。
   */
  set(contextId: string, sessionId: string): void {
    const prev = this.entries.get(contextId);
    const entry: SessionMapEntry = {
      sessionId,
      updatedAt: this.now().toISOString(),
      prompted: prev?.prompted === true,
      turn: prev?.turn ?? 0,
      lastMessageIds: prev?.lastMessageIds ?? [],
    };
    if (prev?.injectedAt !== undefined) entry.injectedAt = prev.injectedAt;
    this.entries.set(contextId, entry);
    this.persist();
  }

  /**
   * 标记该映射的会话已收到首轮 prompt 响应并落盘（无该键则不动）。
   * v0.8.9 · M2：`injectedAt` **不被本方法覆盖**——它记的是「prompt 何时发出」，由
   * {@link markInjected} 写入（早于响应）；本方法只在尚无注入时刻时补一个（老调用序兼容）。
   */
  markPrompted(contextId: string): void {
    const entry = this.entries.get(contextId);
    if (entry === undefined) return;
    const stamp = this.now().toISOString();
    entry.prompted = true;
    if (entry.injectedAt === undefined) entry.injectedAt = stamp;
    entry.updatedAt = stamp;
    this.persist();
  }

  /**
   * 轮次 +1 并落盘（无该键则不动）；返回新值（键不存在 ⇒ 0）。
   * 调用方为 prompt 成功出口（v0.8.9 · M2 接线）。
   */
  bumpTurn(contextId: string): number {
    const entry = this.entries.get(contextId);
    if (entry === undefined) return 0;
    entry.turn += 1;
    entry.updatedAt = this.now().toISOString();
    this.persist();
    return entry.turn;
  }

  /**
   * 记录一个已消费的 messageId（无该键则不动；与队尾重复 ⇒ 不重复追加）。
   * 长度恒 ≤{@link MAX_LAST_MESSAGE_IDS}，溢出丢最旧。
   */
  recordMessageId(contextId: string, messageId: string): void {
    const entry = this.entries.get(contextId);
    if (entry === undefined) return;
    if (entry.lastMessageIds[entry.lastMessageIds.length - 1] !== messageId) {
      entry.lastMessageIds.push(messageId);
    }
    while (entry.lastMessageIds.length > MAX_LAST_MESSAGE_IDS) entry.lastMessageIds.shift();
    entry.updatedAt = this.now().toISOString();
    this.persist();
  }

  /**
   * 保留边界收敛（v0.8.9 · M1；M5 起阈值可配）：先按 TTL（构造入参 `retentionDays` 折算，
   * 以 `updatedAt` 计）淘汰过期项，再按 LRU（`updatedAt` 最旧先出）截到 `retentionMax` 条。
   * `load()` 启动一次、`persist()` 写穿时摊还。**只淘汰映射，不销毁后端会话文件。**
   *
   * @returns 淘汰条数；>0 时打一行桥日志（含 removed / kept / 生效阈值）。
   */
  prune(): number {
    const nowMs = this.now().getTime();
    let removed = 0;
    for (const [contextId, entry] of this.entries) {
      const ts = Date.parse(entry.updatedAt);
      if (Number.isFinite(ts) && nowMs - ts > this.retentionMs && this.entries.delete(contextId)) {
        removed += 1;
      }
    }
    const overflow = this.entries.size - this.retentionMax;
    if (overflow > 0) {
      const oldestFirst = [...this.entries].sort((a, b) => stampOf(a[1]) - stampOf(b[1]));
      for (const [contextId] of oldestFirst.slice(0, overflow)) {
        if (this.entries.delete(contextId)) removed += 1;
      }
    }
    if (removed > 0) {
      this.logger(
        `[acp-session-map] prune：removed=${String(removed)} kept=${String(this.entries.size)}` +
          `（ttl=${String(this.retentionMs / DAY_MS)}d max=${String(this.retentionMax)}）`,
      );
    }
    return removed;
  }

  /** 删除映射并落盘（无该键则不动）。**仅表示「不再主动接回」，不销毁后端会话。** */
  delete(contextId: string): void {
    if (this.entries.delete(contextId)) this.persist();
  }

  /** 映射条数（观测 / 单测）。 */
  size(): number {
    return this.entries.size;
  }

  /**
   * 映射规模观测面（v0.8.9 · M2 产 `sessionMapSize` / `sessionMapOldestAgeDays`）：
   * 空映射 ⇒ `oldestAgeDays` 为 `undefined`（**没发生 ≠ 0 天**，下游按缺键解读）。
   * 年龄以 `updatedAt` 计，**向下取整**（不足一天 ⇒ 0）。
   */
  stats(nowMs = this.now().getTime()): { size: number; oldestAgeDays?: number } {
    if (this.entries.size === 0) return { size: 0 };
    let oldest = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) oldest = Math.min(oldest, stampOf(entry));
    if (!Number.isFinite(oldest)) return { size: this.entries.size };
    return { size: this.entries.size, oldestAgeDays: Math.max(0, Math.floor((nowMs - oldest) / 86_400_000)) };
  }

  /** 启动加载：文件缺失 → 空；损坏 / 顶层非对象 → 记日志并以空映射继续；末尾收敛保留边界。 */
  private load(): void {
    const raw = this.fs.readText(this.filePath);
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger(`[acp-session-map] 文件损坏，忽略并重建：${this.filePath}`);
      return;
    }
    if (!isRecord(parsed)) {
      this.logger(`[acp-session-map] 顶层非对象，忽略并重建：${this.filePath}`);
      return;
    }
    for (const [contextId, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      const sessionId = value["sessionId"];
      if (typeof sessionId !== "string" || sessionId.length === 0) continue;
      const updatedAt =
        typeof value["updatedAt"] === "string" ? value["updatedAt"] : this.now().toISOString();
      const entry: SessionMapEntry = { sessionId, updatedAt, turn: 0, lastMessageIds: [] };
      // 旧条目兼容：缺键 / 类型不符 ⇒ 取缺省值（不报错、不写入缺省值干扰旧格式语义）
      if (value["prompted"] === true) entry.prompted = true;
      if (typeof value["injectedAt"] === "string") entry.injectedAt = value["injectedAt"];
      const turn = value["turn"];
      if (typeof turn === "number" && Number.isFinite(turn)) entry.turn = turn;
      const lastMessageIds = value["lastMessageIds"];
      if (Array.isArray(lastMessageIds)) {
        entry.lastMessageIds = lastMessageIds
          .filter((id): id is string => typeof id === "string" && id.length > 0)
          .slice(-MAX_LAST_MESSAGE_IDS);
      }
      this.entries.set(contextId, entry);
    }
    this.prune();
  }

  /** 原子落盘：先写临时文件，再 rename 覆盖。失败只记日志（不抛）。写穿时摊还 prune。 */
  private persist(): void {
    this.prune();
    const data: Record<string, SessionMapEntry> = {};
    for (const [contextId, entry] of this.entries) data[contextId] = entry;
    const json = `${JSON.stringify(data, null, 2)}\n`;
    this.tmpCounter += 1;
    const tmp = `${this.filePath}.tmp-${String(process.pid)}-${String(this.tmpCounter)}`;
    try {
      this.fs.mkdirp(dirname(this.filePath));
      this.fs.writeText(tmp, json);
      this.fs.rename(tmp, this.filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger(`[acp-session-map] 落盘失败：${message}`);
    }
  }
}
