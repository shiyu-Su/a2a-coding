/**
 * 会话/任务存储（SQLite，`node:sqlite` 内置模块）。
 *
 * 职责：
 * - 持久化 `contextId <-> sessionId` 映射（Agent 退出重启后仍可继承上下文）。
 * - 持久化任务态与 artifacts（`working | completed | failed | input-required`）。
 *
 * 数据库文件路径取自环境变量 `SESSION_DB`，默认 `./data/sessions.sqlite`（自动创建父目录）。
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentKind, SessionRecord, TaskRecord, TaskState } from "../types.js";

/** 默认数据库文件（相对进程 cwd） */
export const DEFAULT_SESSION_DB = "./data/sessions.sqlite";

/** 从环境变量读取正整数；缺失 / 非法 / 非正时回退 fallback */
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/** prompt 片段最大字符数（可配，默认 500） */
const PROMPT_MAX_CHARS = readPositiveIntEnv("TASK_PROMPT_MAX_CHARS", 500);

/** 任务记录保留天数（按 updated_at 超期清理；可配，默认 7 天） */
const TASK_RETENTION_DAYS = readPositiveIntEnv("TASK_RETENTION_DAYS", 7);

/** 每项目保留的最新任务条数（非 working；可配，默认 200） */
const TASK_MAX_PER_PROJECT = readPositiveIntEnv("TASK_MAX_PER_PROJECT", 200);

/**
 * 截断 prompt 片段（默认 `PROMPT_MAX_CHARS` 字符）。
 * 落库前调用，仅存片段、不存全文。
 */
export function truncatePrompt(text: string, max = PROMPT_MAX_CHARS): string {
  return text.length <= max ? text : text.slice(0, max);
}

const AGENT_KINDS: readonly AgentKind[] = ["opencode", "codex", "claude"];
const TASK_STATES: readonly TaskState[] = ["working", "completed", "failed", "input-required"];

/** `upsertSession` 入参：时间戳缺省时由存储层补齐（UTC ISO 8601） */
export interface SessionUpsertInput {
  projectId: string;
  contextId: string;
  sessionId: string;
  agentKind: AgentKind;
  createdAt?: string;
  lastUsedAt?: string;
}

/** `createTask` 入参：`updatedAt` 缺省时由存储层补齐（UTC ISO 8601） */
export interface TaskCreateInput {
  taskId: string;
  projectId: string;
  contextId: string;
  state: TaskState;
  artifactsJson?: string | null;
  /** 任务结果纯文本（成功 = artifacts 文本；失败 = status.message 错误原因） */
  text?: string | null;
  /** 派发时的原始 prompt 片段（落库前经 truncatePrompt 截断）；缺省为 null */
  prompt?: string | null;
  updatedAt?: string;
}

/** `listTasks` 入参：按项目（可选状态）取最近任务 */
export interface ListTasksOptions {
  projectId: string;
  state?: TaskState;
  limit?: number;
}

/** `pruneTasks` 入参：保留策略阈值覆盖（缺省用环境变量 / 内置默认） */
export interface PruneTasksOptions {
  retentionDays?: number;
  maxPerProject?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isAgentKind(v: string): v is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(v);
}

function isTaskState(v: string): v is TaskState {
  return (TASK_STATES as readonly string[]).includes(v);
}

function readString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v !== "string") {
    throw new Error(`[session-store] 列 ${key} 数据损坏：期望 string`);
  }
  return v;
}

function readNullableString(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new Error(`[session-store] 列 ${key} 数据损坏：期望 string | null`);
  }
  return v;
}

function rowToSession(row: Record<string, unknown>): SessionRecord {
  const agentKind = readString(row, "agent_kind");
  if (!isAgentKind(agentKind)) {
    throw new Error(`[session-store] 列 agent_kind 数据损坏：非法值 ${agentKind}`);
  }
  return {
    projectId: readString(row, "project_id"),
    contextId: readString(row, "context_id"),
    sessionId: readString(row, "session_id"),
    agentKind,
    createdAt: readString(row, "created_at"),
    lastUsedAt: readString(row, "last_used_at"),
  };
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  const state = readString(row, "state");
  if (!isTaskState(state)) {
    throw new Error(`[session-store] 列 state 数据损坏：非法任务态 ${state}`);
  }
  return {
    taskId: readString(row, "task_id"),
    projectId: readString(row, "project_id"),
    contextId: readString(row, "context_id"),
    state,
    artifactsJson: readNullableString(row, "artifacts_json"),
    text: readNullableString(row, "text"),
    prompt: readNullableString(row, "prompt"),
    updatedAt: readString(row, "updated_at"),
  };
}

const SESSIONS_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  project_id   TEXT NOT NULL,
  context_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  agent_kind   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (project_id, context_id)
)`;

const TASKS_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id       TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  context_id    TEXT NOT NULL,
  state         TEXT NOT NULL,
  artifacts_json TEXT,
  text          TEXT,
  prompt        TEXT,
  updated_at    TEXT NOT NULL
)`;

/**
 * SQLite 会话/任务存储。
 * 桥（bridge）进程内通常使用模块级默认单例（见文件底部的导出函数）。
 */
export class SessionStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string = process.env["SESSION_DB"] ?? DEFAULT_SESSION_DB) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SESSIONS_DDL);
    this.db.exec(TASKS_DDL);
    // 旧库迁移：此前版本的 tasks 表无 text 列（列已存在时 ALTER 失败，忽略）
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN text TEXT");
    } catch {
      // 列已存在
    }
    // 旧库迁移：此前版本的 tasks 表无 prompt 列（列已存在时 ALTER 失败，忽略）
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN prompt TEXT");
    } catch {
      // 列已存在
    }
    // 按项目 + updated_at 倒序的列表查询索引
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_project_updated ON tasks(project_id, updated_at DESC)",
    );
  }

  /** 查询会话映射；不存在返回 null */
  getSession(projectId: string, contextId: string): SessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT project_id, context_id, session_id, agent_kind, created_at, last_used_at
         FROM sessions WHERE project_id = ? AND context_id = ?`,
      )
      .get(projectId, contextId);
    return row === undefined ? null : rowToSession(row);
  }

  /** 写入/更新会话映射（保留首次 `created_at`），返回落库后的记录 */
  upsertSession(rec: SessionUpsertInput): SessionRecord {
    const createdAt = rec.createdAt ?? nowIso();
    const lastUsedAt = rec.lastUsedAt ?? createdAt;
    this.db
      .prepare(
        `INSERT INTO sessions
           (project_id, context_id, session_id, agent_kind, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, context_id) DO UPDATE SET
           session_id = excluded.session_id,
           agent_kind = excluded.agent_kind,
           last_used_at = excluded.last_used_at`,
      )
      .run(rec.projectId, rec.contextId, rec.sessionId, rec.agentKind, createdAt, lastUsedAt);
    const stored = this.getSession(rec.projectId, rec.contextId);
    if (stored === null) {
      throw new Error(
        `[session-store] upsertSession 后未能读回记录：${rec.projectId}/${rec.contextId}`,
      );
    }
    return stored;
  }

  /** 创建/覆盖任务记录，返回落库后的记录 */
  createTask(rec: TaskCreateInput): TaskRecord {
    const updatedAt = rec.updatedAt ?? nowIso();
    const prompt =
      rec.prompt === undefined || rec.prompt === null ? null : truncatePrompt(rec.prompt);
    this.db
      .prepare(
        `INSERT INTO tasks
           (task_id, project_id, context_id, state, artifacts_json, text, prompt, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           project_id = excluded.project_id,
           context_id = excluded.context_id,
           state = excluded.state,
           artifacts_json = excluded.artifacts_json,
           text = excluded.text,
           prompt = excluded.prompt,
           updated_at = excluded.updated_at`,
      )
      .run(
        rec.taskId,
        rec.projectId,
        rec.contextId,
        rec.state,
        rec.artifactsJson ?? null,
        rec.text ?? null,
        prompt,
        updatedAt,
      );
    const stored = this.getTask(rec.taskId);
    if (stored === null) {
      throw new Error(`[session-store] createTask 后未能读回记录：${rec.taskId}`);
    }
    return stored;
  }

  /**
   * 更新任务态；`artifactsJson` / `text` 未提供时保留原值（COALESCE）。
   * 任务不存在时无效果，返回 null。
   */
  updateTaskState(
    taskId: string,
    state: TaskState,
    artifactsJson?: string | null,
    text?: string | null,
  ): TaskRecord | null {
    const updatedAt = nowIso();
    this.db
      .prepare(
        `UPDATE tasks
         SET state = ?,
             artifacts_json = COALESCE(?, artifacts_json),
             text = COALESCE(?, text),
             updated_at = ?
         WHERE task_id = ?`,
      )
      .run(state, artifactsJson ?? null, text ?? null, updatedAt, taskId);
    return this.getTask(taskId);
  }

  /** 查询任务记录；不存在返回 null */
  getTask(taskId: string): TaskRecord | null {
    const row = this.db
      .prepare(
        `SELECT task_id, project_id, context_id, state, artifacts_json, text, prompt, updated_at
         FROM tasks WHERE task_id = ?`,
      )
      .get(taskId);
    return row === undefined ? null : rowToTask(row);
  }

  /** 按项目列出任务（updated_at 倒序；可选状态过滤；limit 默认 20，clamp 到 [1,100]） */
  listTasks(opts: ListTasksOptions): TaskRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const clauses: string[] = ["project_id = ?"];
    const params: Array<string | number> = [opts.projectId];
    if (opts.state !== undefined) {
      clauses.push("state = ?");
      params.push(opts.state);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT task_id, project_id, context_id, state, artifacts_json, text, prompt, updated_at
         FROM tasks WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  }

  /**
   * 清理保留策略：删除超期 / 每项目超量的**非 working** 任务记录，返回删除条数。
   * 超期按 `updated_at` 早于 `retentionDays`；超量按每项目保留最新 `maxPerProject` 条。
   */
  pruneTasks(opts: PruneTasksOptions = {}): number {
    const retentionDays = opts.retentionDays ?? TASK_RETENTION_DAYS;
    const maxPerProject = opts.maxPerProject ?? TASK_MAX_PER_PROJECT;
    const cutoffIso = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const expired = this.db
      .prepare("DELETE FROM tasks WHERE state <> 'working' AND updated_at < ?")
      .run(cutoffIso).changes;
    const overflow = this.db
      .prepare(
        `DELETE FROM tasks WHERE state <> 'working' AND task_id IN (
           SELECT task_id FROM (
             SELECT task_id,
                    ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY updated_at DESC) AS rn
             FROM tasks
             WHERE state <> 'working'
           ) WHERE rn > ?
         )`,
      )
      .run(maxPerProject).changes;
    return Number(expired) + Number(overflow);
  }

  /** 关闭数据库连接（幂等） */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

let defaultStore: SessionStore | null = null;

/** 获取进程级默认存储（首次调用时按 `SESSION_DB` 打开数据库） */
export function getDefaultStore(): SessionStore {
  if (defaultStore === null) {
    defaultStore = new SessionStore();
  }
  return defaultStore;
}

/** 查询会话映射（默认存储） */
export function getSession(projectId: string, contextId: string): SessionRecord | null {
  return getDefaultStore().getSession(projectId, contextId);
}

/** 写入/更新会话映射（默认存储） */
export function upsertSession(rec: SessionUpsertInput): SessionRecord {
  return getDefaultStore().upsertSession(rec);
}

/** 创建/覆盖任务记录（默认存储） */
export function createTask(rec: TaskCreateInput): TaskRecord {
  return getDefaultStore().createTask(rec);
}

/** 更新任务态（默认存储） */
export function updateTaskState(
  taskId: string,
  state: TaskState,
  artifactsJson?: string | null,
  text?: string | null,
): TaskRecord | null {
  return getDefaultStore().updateTaskState(taskId, state, artifactsJson, text);
}

/** 查询任务记录（默认存储） */
export function getTask(taskId: string): TaskRecord | null {
  return getDefaultStore().getTask(taskId);
}

/** 按项目列出任务（默认存储） */
export function listTasks(opts: ListTasksOptions): TaskRecord[] {
  return getDefaultStore().listTasks(opts);
}

/** 清理保留策略（默认存储） */
export function pruneTasks(opts?: PruneTasksOptions): number {
  return getDefaultStore().pruneTasks(opts);
}

/** 关闭默认存储（幂等；关闭后再次调用会重新打开数据库） */
export function close(): void {
  if (defaultStore !== null) {
    defaultStore.close();
    defaultStore = null;
  }
}
