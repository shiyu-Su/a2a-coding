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
import { FEATURE_STATES, isFeatureState } from "../feature/state-machine.js";
import type {
  AgentKind,
  ArtifactRecord,
  EventRecord,
  FeatureCreateInput,
  FeatureRecord,
  FeatureState,
  InputArtifactRef,
  SessionRecord,
  TaskRecord,
  TaskState,
} from "../types.js";

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
// `blocked` 为 orch 本地专属态（v0.4.0 失败传播），纳入校验清单但与 A2A 无对应
const TASK_STATES: readonly TaskState[] = [
  "working",
  "completed",
  "failed",
  "input-required",
  "blocked",
];
// Feature 状态清单复用状态机模块（单一事实源），此处仅 re-export 供调用方枚举
export const FEATURE_STATE_VALUES: readonly FeatureState[] = FEATURE_STATES;

/** 事件 kind：任务结算（completed / failed / input-required） */
export const EVENT_TASK_SETTLED = "task.settled";
/** 事件 kind：任务被失败传播阻塞（blocked） */
export const EVENT_TASK_BLOCKED = "task.blocked";
/** 事件 kind：Feature 状态流转 */
export const EVENT_FEATURE_STATE = "feature.state";

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
  /** 归属 Feature（v0.3.0；缺省 null = 独立单任务） */
  featureId?: string | null;
  /** 前置任务本地 id 数组（v0.3.0；缺省 null = 无依赖） */
  dependencies?: string[] | null;
  /** 下游声明的上游产物引用（v0.4.0；缺省 null = 无输入产物） */
  inputArtifacts?: InputArtifactRef[] | null;
  /** 远端 A2A 任务 id（Feature 节点派发后回填；缺省 null） */
  remoteTaskId?: string | null;
  /** Feature 排队节点待派发消息全文（v0.3.0；缺省 null） */
  dispatchMessage?: string | null;
}

/** `listTasks` 入参：按项目（可选状态）取最近任务 */
export interface ListTasksOptions {
  projectId: string;
  state?: TaskState;
  limit?: number;
}

/** `listFeatureTasks` 入参：按 Feature 取任务节点（本地 id） */
export interface ListFeatureTasksOptions {
  limit?: number;
}

/** `listFeatures` 入参：可选状态过滤 / 条数上限 */
export interface ListFeaturesOptions {
  state?: FeatureState;
  limit?: number;
}

/** `pruneTasks` 入参：保留策略阈值覆盖（缺省用环境变量 / 内置默认） */
export interface PruneTasksOptions {
  retentionDays?: number;
  maxPerProject?: number;
}

/** `updateFeatureContext` 入参：仅提供的字段被更新（undefined = 保留原值） */
export interface FeatureContextPatch {
  contextId?: string | null;
  plan?: string | null;
  decisions?: string | null;
  contracts?: string | null;
}

/** `upsertArtifact` 入参：`createdAt` 缺省时由存储层补齐 */
export interface ArtifactUpsertInput {
  artifactId: string;
  featureId: string;
  producerTaskId: string;
  name: string;
  mime?: string | null;
  uri?: string | null;
  size?: number | null;
  contentHash?: string | null;
  createdAt?: string;
}

/** `appendEvent` 入参：`createdAt` 缺省时由存储层补齐 */
export interface EventAppendInput {
  featureId?: string | null;
  taskId?: string | null;
  kind: string;
  state?: string | null;
  payload?: string | null;
  createdAt?: string;
}

/** `listEvents` 入参：游标与条数上限 */
export interface ListEventsOptions {
  /** 仅返回 `event_id > since` 的事件（缺省 0 = 从头） */
  since?: number;
  limit?: number;
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

/** tasks 表全列清单（SELECT 单一事实源；新增列时同步此处 + rowToTask） */
const TASK_COLUMNS =
  "task_id, project_id, context_id, state, artifacts_json, text, prompt, " +
  "feature_id, dependencies, input_artifacts, remote_task_id, dispatch_message, updated_at";

/** features 表全列清单（SELECT 单一事实源；新增列时同步此处 + rowToFeature） */
const FEATURE_COLUMNS =
  "feature_id, state, title, requirement, context_id, plan, decisions, contracts, " +
  "created_at, updated_at";

/** 解析 `dependencies` 列（JSON 数组字符串）；非法即数据损坏（fail-fast） */
function readDependencies(row: Record<string, unknown>): string[] | null {
  const raw = readNullableString(row, "dependencies");
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`[session-store] 列 dependencies 数据损坏：非法 JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`[session-store] 列 dependencies 数据损坏：期望 JSON 数组`);
  }
  const deps: string[] = [];
  for (const v of parsed) {
    if (typeof v !== "string") {
      throw new Error(`[session-store] 列 dependencies 数据损坏：数组元素非 string`);
    }
    deps.push(v);
  }
  return deps;
}

/** 解析 `input_artifacts` 列（InputArtifactRef[] JSON 字符串）；非法即数据损坏（fail-fast） */
function readInputArtifacts(row: Record<string, unknown>): InputArtifactRef[] | null {
  const raw = readNullableString(row, "input_artifacts");
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`[session-store] 列 input_artifacts 数据损坏：非法 JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`[session-store] 列 input_artifacts 数据损坏：期望 JSON 数组`);
  }
  const refs: InputArtifactRef[] = [];
  for (const v of parsed) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new Error(`[session-store] 列 input_artifacts 数据损坏：数组元素非对象`);
    }
    refs.push(v as InputArtifactRef);
  }
  return refs;
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
    featureId: readNullableString(row, "feature_id"),
    dependencies: readDependencies(row),
    inputArtifacts: readInputArtifacts(row),
    remoteTaskId: readNullableString(row, "remote_task_id"),
    dispatchMessage: readNullableString(row, "dispatch_message"),
  };
}

function rowToFeature(row: Record<string, unknown>): FeatureRecord {
  const state = readString(row, "state");
  if (!isFeatureState(state)) {
    throw new Error(`[session-store] 列 state 数据损坏：非法 Feature 态 ${state}`);
  }
  return {
    featureId: readString(row, "feature_id"),
    state,
    title: readString(row, "title"),
    requirement: readNullableString(row, "requirement"),
    contextId: readNullableString(row, "context_id"),
    plan: readNullableString(row, "plan"),
    decisions: readNullableString(row, "decisions"),
    contracts: readNullableString(row, "contracts"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function rowToArtifact(row: Record<string, unknown>): ArtifactRecord {
  const size = row["size"];
  return {
    artifactId: readString(row, "artifact_id"),
    featureId: readString(row, "feature_id"),
    producerTaskId: readString(row, "producer_task_id"),
    name: readString(row, "name"),
    mime: readNullableString(row, "mime"),
    uri: readNullableString(row, "uri"),
    size: size === null || size === undefined ? null : Number(size),
    contentHash: readNullableString(row, "content_hash"),
    createdAt: readString(row, "created_at"),
  };
}

function rowToEvent(row: Record<string, unknown>): EventRecord {
  const eventId = row["event_id"];
  return {
    eventId: Number(eventId),
    featureId: readNullableString(row, "feature_id"),
    taskId: readNullableString(row, "task_id"),
    kind: readString(row, "kind"),
    state: readNullableString(row, "state"),
    payload: readNullableString(row, "payload"),
    createdAt: readString(row, "created_at"),
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

const FEATURES_DDL = `
CREATE TABLE IF NOT EXISTS features (
  feature_id  TEXT PRIMARY KEY,
  state       TEXT NOT NULL,
  title       TEXT NOT NULL,
  requirement TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
)`;

/** 产物登记表（v0.4.0 §2.3） */
const ARTIFACTS_DDL = `
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id      TEXT PRIMARY KEY,
  feature_id       TEXT NOT NULL,
  producer_task_id TEXT NOT NULL,
  name             TEXT NOT NULL,
  mime             TEXT,
  uri              TEXT,
  size             INTEGER,
  content_hash     TEXT,
  created_at       TEXT NOT NULL
)`;

/** 事件收件箱表（v0.4.0 §2.6） */
const EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS events (
  event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id TEXT,
  task_id    TEXT,
  kind       TEXT NOT NULL,
  state      TEXT,
  payload    TEXT,
  created_at TEXT NOT NULL
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
    this.db.exec(FEATURES_DDL);
    this.db.exec(ARTIFACTS_DDL);
    this.db.exec(EVENTS_DDL);
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
    // v0.3.0 迁移：tasks 加 feature_id / dependencies / remote_task_id / dispatch_message
    for (const column of [
      "feature_id TEXT",
      "dependencies TEXT",
      "remote_task_id TEXT",
      "dispatch_message TEXT",
    ]) {
      try {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column}`);
      } catch {
        // 列已存在
      }
    }
    // v0.4.0 迁移：tasks 加 input_artifacts（下游引用的上游产物，JSON 数组）
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN input_artifacts TEXT");
    } catch {
      // 列已存在
    }
    // v0.4.0 迁移：features 加 Feature Context 列（context_id / plan / decisions / contracts）
    for (const column of ["context_id TEXT", "plan TEXT", "decisions TEXT", "contracts TEXT"]) {
      try {
        this.db.exec(`ALTER TABLE features ADD COLUMN ${column}`);
      } catch {
        // 列已存在
      }
    }
    // 按项目 + updated_at 倒序的列表查询索引
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_project_updated ON tasks(project_id, updated_at DESC)",
    );
    // Feature 列表（按状态 + updated_at 倒序）与按 Feature 取任务节点的索引
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_features_state_updated ON features(state, updated_at DESC)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_feature ON tasks(feature_id, updated_at DESC)",
    );
    // v0.4.0：artifacts 按 Feature / 生产者节点查询；events 按 Feature 顺序读取
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_artifacts_feature ON artifacts(feature_id)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_artifacts_producer ON artifacts(producer_task_id)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_feature ON events(feature_id, event_id)");
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
    const dependencies =
      rec.dependencies === undefined || rec.dependencies === null
        ? null
        : JSON.stringify(rec.dependencies);
    const inputArtifacts =
      rec.inputArtifacts === undefined || rec.inputArtifacts === null
        ? null
        : JSON.stringify(rec.inputArtifacts);
    this.db
      .prepare(
        `INSERT INTO tasks
           (task_id, project_id, context_id, state, artifacts_json, text, prompt,
            feature_id, dependencies, input_artifacts, remote_task_id, dispatch_message, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           project_id = excluded.project_id,
           context_id = excluded.context_id,
           state = excluded.state,
           artifacts_json = excluded.artifacts_json,
           text = excluded.text,
           prompt = excluded.prompt,
           feature_id = excluded.feature_id,
           dependencies = excluded.dependencies,
           input_artifacts = excluded.input_artifacts,
           remote_task_id = excluded.remote_task_id,
           dispatch_message = excluded.dispatch_message,
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
        rec.featureId ?? null,
        dependencies,
        inputArtifacts,
        rec.remoteTaskId ?? null,
        rec.dispatchMessage ?? null,
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
   * v0.4.0：状态发生**变化**且新态非 `working` 时，自动写事件收件箱
   * （`blocked` → `task.blocked`；`completed`/`failed`/`input-required` → `task.settled`）。
   */
  updateTaskState(
    taskId: string,
    state: TaskState,
    artifactsJson?: string | null,
    text?: string | null,
  ): TaskRecord | null {
    const previous = this.getTask(taskId);
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
    const stored = this.getTask(taskId);
    if (stored !== null && previous !== null && previous.state !== stored.state) {
      const kind =
        stored.state === "blocked"
          ? EVENT_TASK_BLOCKED
          : stored.state === "working"
            ? null
            : EVENT_TASK_SETTLED;
      if (kind !== null) {
        this.appendEvent({
          featureId: stored.featureId,
          taskId: stored.taskId,
          kind,
          state: stored.state,
        });
      }
    }
    return stored;
  }

  /** 查询任务记录；不存在返回 null */
  getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE task_id = ?`).get(taskId);
    return row === undefined ? null : rowToTask(row);
  }

  /**
   * Feature 节点派发落库：回填远端 id，保持 state（working）以便看护接管。
   * 任务不存在时无效果，返回 null。
   */
  markTaskDispatched(taskId: string, remoteTaskId: string): TaskRecord | null {
    this.db
      .prepare("UPDATE tasks SET remote_task_id = ?, updated_at = ? WHERE task_id = ?")
      .run(remoteTaskId, nowIso(), taskId);
    return this.getTask(taskId);
  }

  /**
   * needs_input 恢复：将任务节点重新置为待派发（state=working、清远端 id、
   * 更新待派发消息），供调度器以同 contextId 续接。任务不存在时返回 null。
   */
  rearmTask(taskId: string, dispatchMessage: string): TaskRecord | null {
    this.db
      .prepare(
        `UPDATE tasks
         SET state = 'working', remote_task_id = NULL, dispatch_message = ?, updated_at = ?
         WHERE task_id = ?`,
      )
      .run(dispatchMessage, nowIso(), taskId);
    return this.getTask(taskId);
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
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE ${clauses.join(" AND ")}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  }

  /** 按 Feature 列出任务节点（updated_at 升序 = 派发次序；limit 默认 100，clamp 到 [1,1000]） */
  listFeatureTasks(featureId: string, opts: ListFeatureTasksOptions = {}): TaskRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const rows = this.db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE feature_id = ?
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(featureId, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  }

  // ------------------------------------------------------------------
  // Feature CRUD（v0.3.0）
  // ------------------------------------------------------------------

  /** 创建/覆盖 Feature 记录（state 缺省 `discussing`），返回落库后的记录 */
  createFeature(rec: FeatureCreateInput): FeatureRecord {
    const state = rec.state ?? "discussing";
    if (!isFeatureState(state)) {
      throw new Error(`[session-store] createFeature 非法 Feature 态：${String(state)}`);
    }
    const createdAt = rec.createdAt ?? nowIso();
    const updatedAt = rec.updatedAt ?? createdAt;
    this.db
      .prepare(
        `INSERT INTO features (feature_id, state, title, requirement, context_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(feature_id) DO UPDATE SET
           state = excluded.state,
           title = excluded.title,
           requirement = excluded.requirement,
           context_id = COALESCE(excluded.context_id, context_id),
           updated_at = excluded.updated_at`,
      )
      .run(
        rec.featureId,
        state,
        rec.title,
        rec.requirement ?? null,
        rec.contextId ?? null,
        createdAt,
        updatedAt,
      );
    const stored = this.getFeature(rec.featureId);
    if (stored === null) {
      throw new Error(`[session-store] createFeature 后未能读回记录：${rec.featureId}`);
    }
    return stored;
  }

  /** 查询 Feature；不存在返回 null */
  getFeature(featureId: string): FeatureRecord | null {
    const row = this.db
      .prepare(`SELECT ${FEATURE_COLUMNS} FROM features WHERE feature_id = ?`)
      .get(featureId);
    return row === undefined ? null : rowToFeature(row);
  }

  /**
   * 更新 Feature 态；Feature 不存在时无效果，返回 null。
   * v0.4.0：状态发生变化时自动写 `feature.state` 事件。
   */
  updateFeatureState(featureId: string, state: FeatureState): FeatureRecord | null {
    if (!isFeatureState(state)) {
      throw new Error(`[session-store] updateFeatureState 非法 Feature 态：${String(state)}`);
    }
    const previous = this.getFeature(featureId);
    this.db
      .prepare("UPDATE features SET state = ?, updated_at = ? WHERE feature_id = ?")
      .run(state, nowIso(), featureId);
    const stored = this.getFeature(featureId);
    if (stored !== null && previous !== null && previous.state !== stored.state) {
      this.appendEvent({ featureId, taskId: null, kind: EVENT_FEATURE_STATE, state });
    }
    return stored;
  }

  /**
   * 更新 Feature Context（context_id / plan / decisions / contracts）。
   * 仅提供的字段被写入（undefined = 保留原值）；Feature 不存在时返回 null。
   */
  updateFeatureContext(featureId: string, patch: FeatureContextPatch): FeatureRecord | null {
    const sets: string[] = [];
    const params: Array<string | null> = [];
    if (patch.contextId !== undefined) {
      sets.push("context_id = ?");
      params.push(patch.contextId);
    }
    if (patch.plan !== undefined) {
      sets.push("plan = ?");
      params.push(patch.plan);
    }
    if (patch.decisions !== undefined) {
      sets.push("decisions = ?");
      params.push(patch.decisions);
    }
    if (patch.contracts !== undefined) {
      sets.push("contracts = ?");
      params.push(patch.contracts);
    }
    if (sets.length === 0) return this.getFeature(featureId);
    sets.push("updated_at = ?");
    params.push(nowIso());
    params.push(featureId);
    this.db.prepare(`UPDATE features SET ${sets.join(", ")} WHERE feature_id = ?`).run(...params);
    return this.getFeature(featureId);
  }

  /** 列出 Feature（updated_at 倒序；可选状态过滤；limit 默认 100，clamp 到 [1,1000]） */
  listFeatures(opts: ListFeaturesOptions = {}): FeatureRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.state !== undefined) {
      clauses.push("state = ?");
      params.push(opts.state);
    }
    params.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")} ` : "";
    const rows = this.db
      .prepare(
        `SELECT ${FEATURE_COLUMNS}
         FROM features ${where}ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToFeature);
  }

  // ------------------------------------------------------------------
  // Artifact 注册表（v0.4.0）
  // ------------------------------------------------------------------

  /** 写入/覆盖产物记录（同 id 覆盖），返回落库后的记录 */
  upsertArtifact(rec: ArtifactUpsertInput): ArtifactRecord {
    const createdAt = rec.createdAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO artifacts
           (artifact_id, feature_id, producer_task_id, name, mime, uri, size, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO UPDATE SET
           feature_id = excluded.feature_id,
           producer_task_id = excluded.producer_task_id,
           name = excluded.name,
           mime = excluded.mime,
           uri = excluded.uri,
           size = excluded.size,
           content_hash = excluded.content_hash`,
      )
      .run(
        rec.artifactId,
        rec.featureId,
        rec.producerTaskId,
        rec.name,
        rec.mime ?? null,
        rec.uri ?? null,
        rec.size ?? null,
        rec.contentHash ?? null,
        createdAt,
      );
    const stored = this.getArtifact(rec.artifactId);
    if (stored === null) {
      throw new Error(`[session-store] upsertArtifact 后未能读回记录：${rec.artifactId}`);
    }
    return stored;
  }

  /** 查询产物；不存在返回 null */
  getArtifact(artifactId: string): ArtifactRecord | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE artifact_id = ?").get(artifactId);
    return row === undefined ? null : rowToArtifact(row);
  }

  /** 按 Feature 列出产物（created_at 升序；limit 默认 100，clamp 到 [1,1000]） */
  listArtifactsByFeature(featureId: string, limit = 100): ArtifactRecord[] {
    const capped = Math.min(Math.max(limit, 1), 1000);
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE feature_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(featureId, capped) as Array<Record<string, unknown>>;
    return rows.map(rowToArtifact);
  }

  /** 按生产者节点列出产物（created_at 升序；limit 默认 100，clamp 到 [1,1000]） */
  listArtifactsByProducer(producerTaskId: string, limit = 100): ArtifactRecord[] {
    const capped = Math.min(Math.max(limit, 1), 1000);
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE producer_task_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(producerTaskId, capped) as Array<Record<string, unknown>>;
    return rows.map(rowToArtifact);
  }

  // ------------------------------------------------------------------
  // 事件收件箱（v0.4.0）
  // ------------------------------------------------------------------

  /** 追加事件，返回落库后的记录（`eventId` 由 AUTOINCREMENT 分配） */
  appendEvent(rec: EventAppendInput): EventRecord {
    const createdAt = rec.createdAt ?? nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO events (feature_id, task_id, kind, state, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.featureId ?? null,
        rec.taskId ?? null,
        rec.kind,
        rec.state ?? null,
        rec.payload ?? null,
        createdAt,
      );
    return {
      eventId: Number(info.lastInsertRowid),
      featureId: rec.featureId ?? null,
      taskId: rec.taskId ?? null,
      kind: rec.kind,
      state: rec.state ?? null,
      payload: rec.payload ?? null,
      createdAt,
    };
  }

  /** 按游标列出事件（`event_id > since`，升序；limit 默认 100，clamp 到 [1,1000]） */
  listEvents(opts: ListEventsOptions = {}): EventRecord[] {
    const since = Math.max(opts.since ?? 0, 0);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const rows = this.db
      .prepare("SELECT * FROM events WHERE event_id > ? ORDER BY event_id ASC LIMIT ?")
      .all(since, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  /** 当前最大事件 id（空表返回 0）；用于游标回落 */
  latestEventId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(event_id), 0) AS max_id FROM events").get() as
      Record<string, unknown> | undefined;
    if (row === undefined) return 0;
    return Number(row["max_id"]);
  }

  /**
   * 清理保留策略：删除超期 / 每项目超量的**非 working** 任务记录，返回删除条数。
   * 超期按 `updated_at` 早于 `retentionDays`；超量按每项目保留最新 `maxPerProject` 条。
   * v0.3.0：**排除活跃 Feature 的任务**（其 `feature_id` 非空且所属 Feature 未终态），
   * 避免误删在飞编排的证据。
   * v0.4.0 复核：`blocked` 属非 working，但**活跃 Feature 的 `blocked` 任务同样受 `prunable`
   * 保护**（其所属 Feature 非终态 → 不满足 `feature_id IS NULL` 也不在终态集合内），
   * 仅当所属 Feature 已终态（completed/failed/cancelled）时才随 `blocked` 一并归档。
   */
  pruneTasks(opts: PruneTasksOptions = {}): number {
    const retentionDays = opts.retentionDays ?? TASK_RETENTION_DAYS;
    const maxPerProject = opts.maxPerProject ?? TASK_MAX_PER_PROJECT;
    const cutoffIso = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    // 仅「无 Feature 归属」或「所属 Feature 已终态」的任务可被清理
    const prunable =
      "(feature_id IS NULL OR feature_id IN (" +
      "SELECT feature_id FROM features WHERE state IN ('completed','failed','cancelled')))";
    const expired = this.db
      .prepare(`DELETE FROM tasks WHERE state <> 'working' AND updated_at < ? AND ${prunable}`)
      .run(cutoffIso).changes;
    const overflow = this.db
      .prepare(
        `DELETE FROM tasks WHERE state <> 'working' AND ${prunable} AND task_id IN (
           SELECT task_id FROM (
             SELECT task_id,
                    ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY updated_at DESC) AS rn
             FROM tasks
             WHERE state <> 'working' AND ${prunable}
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

/** 按 Feature 列出任务节点（默认存储） */
export function listFeatureTasks(featureId: string, opts?: ListFeatureTasksOptions): TaskRecord[] {
  return getDefaultStore().listFeatureTasks(featureId, opts);
}

/** Feature 节点派发落库：回填远端 id（默认存储） */
export function markTaskDispatched(taskId: string, remoteTaskId: string): TaskRecord | null {
  return getDefaultStore().markTaskDispatched(taskId, remoteTaskId);
}

/** needs_input 恢复：重排任务节点（默认存储） */
export function rearmTask(taskId: string, dispatchMessage: string): TaskRecord | null {
  return getDefaultStore().rearmTask(taskId, dispatchMessage);
}

/** 创建/覆盖 Feature 记录（默认存储） */
export function createFeature(rec: FeatureCreateInput): FeatureRecord {
  return getDefaultStore().createFeature(rec);
}

/** 查询 Feature（默认存储） */
export function getFeature(featureId: string): FeatureRecord | null {
  return getDefaultStore().getFeature(featureId);
}

/** 更新 Feature 态（默认存储） */
export function updateFeatureState(featureId: string, state: FeatureState): FeatureRecord | null {
  return getDefaultStore().updateFeatureState(featureId, state);
}

/** 更新 Feature Context（默认存储） */
export function updateFeatureContext(
  featureId: string,
  patch: FeatureContextPatch,
): FeatureRecord | null {
  return getDefaultStore().updateFeatureContext(featureId, patch);
}

/** 写入/覆盖产物记录（默认存储） */
export function upsertArtifact(rec: ArtifactUpsertInput): ArtifactRecord {
  return getDefaultStore().upsertArtifact(rec);
}

/** 查询产物（默认存储） */
export function getArtifact(artifactId: string): ArtifactRecord | null {
  return getDefaultStore().getArtifact(artifactId);
}

/** 按 Feature 列出产物（默认存储） */
export function listArtifactsByFeature(featureId: string, limit?: number): ArtifactRecord[] {
  return getDefaultStore().listArtifactsByFeature(featureId, limit);
}

/** 按生产者节点列出产物（默认存储） */
export function listArtifactsByProducer(producerTaskId: string, limit?: number): ArtifactRecord[] {
  return getDefaultStore().listArtifactsByProducer(producerTaskId, limit);
}

/** 追加事件（默认存储） */
export function appendEvent(rec: EventAppendInput): EventRecord {
  return getDefaultStore().appendEvent(rec);
}

/** 按游标列出事件（默认存储） */
export function listEvents(opts?: ListEventsOptions): EventRecord[] {
  return getDefaultStore().listEvents(opts);
}

/** 当前最大事件 id（默认存储） */
export function latestEventId(): number {
  return getDefaultStore().latestEventId();
}

/** 列出 Feature（默认存储） */
export function listFeatures(opts?: ListFeaturesOptions): FeatureRecord[] {
  return getDefaultStore().listFeatures(opts);
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
