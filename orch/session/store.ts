/**
 * 会话/任务存储（SQLite，`node:sqlite` 内置模块）。
 *
 * 职责：
 * - 持久化 `contextId <-> sessionId` 映射（Agent 退出重启后仍可继承上下文）。
 * - 持久化任务态与 artifacts（`working | completed | failed | input-required`）。
 *
 * 数据库文件路径取自环境变量 `SESSION_DB`，默认锚定 orch 单元根的
 * `data/sessions.sqlite`（自动创建父目录）。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appRootFromModule } from "../app-root.js";
import { conditionalStateUpdate } from "./conditional-update.js";
import { FEATURE_STATES, isFeatureState } from "../feature/state-machine.js";
import type {
  AgentKind,
  ArtifactRecord,
  EventRecord,
  FailureKind,
  FeatureCreateInput,
  FeatureRecord,
  FeatureState,
  InputArtifactRef,
  RiskLevel,
  SessionRecord,
  TaskRecord,
  TaskState,
} from "../types.js";
import { AGENT_KINDS } from "../types.js";

/**
 * 默认数据库文件：锚定 orch 单元根（`<orch>/data/sessions.sqlite`），**非 cwd 相对**，
 * 避免宿主 cwd 变化导致换库；环境变量 `SESSION_DB` 优先级更高。
 */
export const DEFAULT_SESSION_DB = join(
  appRootFromModule(import.meta.url),
  "data",
  "sessions.sqlite",
);

/** 写锁冲突时的等待上限（ms，`DatabaseSync` 的 `timeout` 选项）：避免并发写立即 SQLITE_BUSY */
export const SESSION_BUSY_TIMEOUT_MS = 5000;

/**
 * 打开存储连接：显式 busy timeout（写锁冲突时等待而非立即失败）+ WAL。
 * 单列出来便于单测直接断言连接上的 `PRAGMA busy_timeout` / `journal_mode`。
 */
export function openStoreDatabase(
  dbPath: string,
  busyTimeoutMs: number = SESSION_BUSY_TIMEOUT_MS,
): DatabaseSync {
  const db = new DatabaseSync(dbPath, { timeout: busyTimeoutMs });
  db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

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

/**
 * **已退役**的 Feature 态（REQ-v0.4.1-2026-09-16-01 §2.3 主链收敛）：
 * 前段三态（`discussing` / `analyzing` / `planning`）已从枚举删除，库中遗留值须归一到
 * `waiting_approval`（否则 `rowToFeature` 读取即抛 ⇒ `recover` 启动即抛 / `tick` 停摆）。
 *
 * ⚠️ **未来再退休任何状态时，必须把该态追加进本集合**：constructor 的兜底归一语句以
 * `FEATURE_STATES ∪ RETIRED_FEATURE_STATES` 为"已知值全集"，否则新退役的**合法**态会被
 * 当作脏值反复归一（每次启动都执行）。
 */
const RETIRED_FEATURE_STATES: readonly string[] = ["discussing", "analyzing", "planning"];

/** 失败分类清单（v0.4.1；含校验用，落库值只能是这两者） */
const FAILURE_KINDS: readonly FailureKind[] = ["infra", "task"];

/** 事件 kind：任务结算（completed / failed / input-required） */
export const EVENT_TASK_SETTLED = "task.settled";
/** 事件 kind：任务被失败传播阻塞（blocked） */
export const EVENT_TASK_BLOCKED = "task.blocked";
/** 事件 kind：Feature 状态流转 */
export const EVENT_FEATURE_STATE = "feature.state";
/**
 * 事件 kind：列表查询**触顶截断**告警（v0.6.1 REQ-05 §2.5 白捡 / C12）。
 *
 * `listFeatures` / `listFeatureTasks` 返回行数触顶（`=== limit`）时记**事件 + 日志各一条**，
 * 令「`limit:1000` 静默截断」变为可观测信号。去重：每 (list, scope, limit) **每实例至多一次**。
 */
export const EVENT_LIST_TRUNCATED = "store.list_truncated";

// ---------------------------------------------------------------------------
// v0.7.0 A2：Runner 注册表 + 任务队列地基（pull 连接模型的存储面）
//
// 本段只新增「运行态投影」所需的最小面，不改动既有列语义（`state` / `dispatch_guard`
// 等既有列按各自既有口径继续工作）：
// - `runners` / `runner_projects` 两张**投影表**（可删可重建，**启动不清空**）；
// - `tasks` 五条队列列（`queue_state` / `claimed_by` / `claim_token` / `claimed_at` / `queued_at`）；
// - 类型与读写口集中在 `orch/session/store.ts`（types.ts 的 `TaskRecord` 形状不变）。
// ---------------------------------------------------------------------------

/**
 * 任务队列态（`tasks.queue_state`）。
 * - `queued`：已入队待领取；
 * - `claimed`：已被某 Runner 领取（in-flight，claim CAS 的唯一准入态）；
 * - `running`：Runner 已在本机开工（领取与开工之间的细分态，供 Runner 侧上报）；
 * - `settled`：已结算（终态落库 / 结果已回传）。
 *
 * ⚠️ **NULL 兼容**：v0.7.0 之前的老行该列为 NULL ⇒ 读侧一律视为 `settled`（老数据不在
 * 队列中）。迁移**不回填**（不写历史行），`claimTask` 的 CAS 只认显式 `queue_state = 'queued'`。
 */
export type QueueState = "queued" | "claimed" | "running" | "settled";

const QUEUE_STATES: readonly QueueState[] = ["queued", "claimed", "running", "settled"];

/** Runner 注册态（心跳超期只降为 `offline`，**不得触发 stop** —— 决策 D8） */
export type RunnerState = "online" | "offline";

/** Runner 上报的项目运行态（`runner_projects.status`，与 Launcher `/projects` 同口径） */
export type RunnerProjectStatus = "online" | "offline";

const RISK_LEVELS: readonly RiskLevel[] = ["read", "write", "full"];

/** `tasks` 队列列 + 既有列的组合投影（**不改 `TaskRecord` 形状**，避免波及 types.ts） */
export interface TaskQueueColumns {
  /** 队列态（NULL 老数据已归一为 `settled`） */
  queueState: QueueState;
  /** 领取者标识（落 `tasks.claimed_by`；未领取 / 已清算为 null） */
  claimedBy: string | null;
  /** 本次领取的唯一令牌（`requeueStaleTask` 清算时清空） */
  claimToken: string | null;
  /** 领取时刻（UTC ISO 8601） */
  claimedAt: string | null;
  /** 入队时刻（UTC ISO 8601；FIFO 领取序） */
  queuedAt: string | null;
}

/** 队列视角的任务记录：既有 `TaskRecord` ∪ 队列五列 */
export type QueuedTaskRecord = TaskRecord & TaskQueueColumns;

/** `upsertRunner` 入参：`registeredAt` / `lastHeartbeatAt` 缺省时由存储层补齐 */
export interface RunnerUpsertInput {
  /** 注册实例 id（主键；同一台机器重复注册应沿用同一 id ⇒ `machine_id` UNIQUE 不冲突） */
  runnerId: string;
  /** 机器 id（UNIQUE；「一台机器同时只有一个 Runner 注册行」） */
  machineId: string;
  /** Runner 自携协议版本（如 `"2.0"`） */
  protocolVersion: string;
  /** Runner 软件版本（可空） */
  version?: string | null;
  /** 注册态（缺省 `online`；心跳超期由调用方显式降为 `offline`） */
  state?: RunnerState;
  /** 首次注册时刻（冲突时**保留首次**，不随重注册刷新） */
  registeredAt?: string;
  /** 最近心跳时刻（每次注册 / 心跳刷新） */
  lastHeartbeatAt?: string;
}

/** Runner 注册记录（落 SQLite `runners` 表；运行态投影，重启不清空） */
export interface RunnerRecord {
  runnerId: string;
  machineId: string;
  protocolVersion: string;
  version: string | null;
  state: RunnerState;
  registeredAt: string;
  lastHeartbeatAt: string;
}

/** `runnerProjectsReplace` 单条项目入参（全量替换语义） */
export interface RunnerProjectInput {
  projectId: string;
  /** 工作区绝对路径（可空） */
  workspace?: string | null;
  agentKind: AgentKind;
  a2aPort: number;
  /** 项目风险级别（可空 = 未声明） */
  risk?: RiskLevel | null;
  status: RunnerProjectStatus;
  /** 本地 A2A 端点（可空 = 未就绪） */
  endpoint?: string | null;
  /** 项目 Agent 启动时刻（可空） */
  startedAt?: string | null;
}

/** Runner 项目记录（落 `runner_projects`；`updated_at` 由每次全量替换统一盖章） */
export interface RunnerProjectRecord {
  runnerId: string;
  projectId: string;
  workspace: string | null;
  agentKind: AgentKind;
  a2aPort: number;
  risk: RiskLevel | null;
  status: RunnerProjectStatus;
  endpoint: string | null;
  startedAt: string | null;
  updatedAt: string;
}

/** `claimTask` 入参 */
export interface ClaimTaskOptions {
  /** 领取者标识（落 `tasks.claimed_by`；本版约定 = 领取的 Runner 所属 `machineId`） */
  claimedBy: string;
  /** 唯一 claim token；缺省由存储层生成（`randomUUID`） */
  claimToken?: string;
  /** 仅在这些项目内领取（缺省 = 不限；**空数组 = 无可领取**） */
  projectIds?: readonly string[];
  /** 领取时刻（缺省 now） */
  claimedAt?: string;
}

/**
 * `upsertTaskResult` 入参：**幂等键 = `(machineId, taskId)`**。
 *
 * 逻辑键中的 `taskId` = 派发时下发给 Runner 的任务 id（`tasks.task_id` 主键 ⇒ 二次到达
 * 命中同一行）；`machineId` = 上报机器（pull 回传与 callback 两条路径同源，取同一键去重）。
 * 该方法**只写终态 + artifacts**，不改既有列语义。
 */
export interface TaskResultUpsertInput {
  /** 上报机器（幂等键组成部分；亦是「非本机回传」的审计线索） */
  machineId: string;
  /** 任务本地 id（= 派发时下发给 Runner 的 id） */
  taskId: string;
  projectId: string;
  contextId: string;
  /** 上报任务态（`completed` / `failed` / `input-required` 为主） */
  state: TaskState;
  artifactsJson?: string | null;
  text?: string | null;
  featureId?: string | null;
  remoteTaskId?: string | null;
  /** 上报 / 结算时刻（缺省 now；重复上报时**不覆盖**已结算行） */
  updatedAt?: string;
}

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

/** `listFeatures` 入参：可选状态过滤 / 条数上限 / 归属组过滤 */
export interface ListFeaturesOptions {
  state?: FeatureState;
  limit?: number;
  /**
   * 归属组过滤（v0.8.6 §2.3）：给定组名 ⇒ 仅返回 `owner_group = ownerGroup` 的 Feature
   * （**NULL 无归属行天然被排除** = 已配组环境 fail-closed）；缺省（`undefined`）⇒ 全量
   * （未配组环境的匿名入口 / web 运维视图）。
   */
  ownerGroup?: string;
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

/**
 * 事件的**组可见性范围**（v0.8.6 一桥多组 §2.4 案 B）：只用于**读**过滤，
 * `events` 表**零 DDL、写路径零改动** —— 归属经 `feature_id` / `task_id` 反查得到，
 * `owner_group` 的单一事实源始终留在 `features`（禁第二套归属登记）。
 */
export interface EventVisibilityScope {
  /** 本组身份名：与 `features.owner_group` 精确匹配（Feature 级与节点级事件的归属源） */
  ownerGroup: string;
  /**
   * 本组成员项目 id：覆盖**无 Feature 归属**的任务事件（`mode="inquiry"` 派发、
   * 任务结算等只带 `task_id` 的事件）。项目 id 在机器清单内全局唯一
   * （`locateProject` 的 `projectId → machine` 定位本身即单值语义），故此处只按项目判。
   */
  projectIds: readonly string[];
}

/** `listEvents` 入参：游标与条数上限（+ 可选组可见性范围） */
export interface ListEventsOptions {
  /** 仅返回 `event_id > since` 的事件（缺省 0 = 从头） */
  since?: number;
  limit?: number;
  /** 缺省 / `null` = **不过滤**：未配组环境的匿名入口 / web 运维视图（§2.7） */
  scope?: EventVisibilityScope | null;
}

/**
 * 案 B 的可见性谓词（`listEvents` 与 `latestEventId` **共用**，禁两套 SQL）：
 *
 * - **孤儿事件**（`feature_id` 与 `task_id` 皆 NULL，如 `runner.*`）⇒ **全体可见**
 *   —— 机器级事件不属任何组；
 * - **Feature 归属**（含同时带 `feature_id` 与 `task_id` 的节点事件）⇒ 经
 *   `features.owner_group` 反查，**唯一归属源**；
 * - **仅任务归属**（`feature_id` NULL 但带 `task_id`）⇒ 按本组成员项目；
 * - 三者都不命中 ⇒ 他组事件 ⇒ 不可见。
 *
 * 返回的 `clause` 以 ` AND (...)` 形式拼接（`latestEventId` 侧配 `WHERE 1=1`），
 * 参数顺序 = 拼接顺序（`ownerGroup` → `projectIds`）。
 */
function eventVisibilityPredicate(scope: EventVisibilityScope | null | undefined): {
  clause: string;
  params: string[];
} {
  if (scope === undefined || scope === null) return { clause: "", params: [] };
  const projects =
    scope.projectIds.length > 0
      ? ` OR (feature_id IS NULL AND task_id IN (SELECT task_id FROM tasks WHERE project_id IN (` +
        `${scope.projectIds.map(() => "?").join(",")})` +
        `))`
      : "";
  return {
    clause:
      ` AND ((feature_id IS NULL AND task_id IS NULL)` +
      ` OR feature_id IN (SELECT feature_id FROM features WHERE owner_group = ?)` +
      `${projects})`,
    params: [scope.ownerGroup, ...scope.projectIds],
  };
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

/** 该任务态是否算「已完成」（`finished_at` 的唯一写入判据；口径见 `FINISHED_TASK_STATES`） */
function isFinishedState(state: TaskState): boolean {
  return (FINISHED_TASK_STATES as readonly string[]).includes(state);
}

function isFailureKind(v: string): v is FailureKind {
  return (FAILURE_KINDS as readonly string[]).includes(v);
}

function isQueueState(v: string): v is QueueState {
  return (QUEUE_STATES as readonly string[]).includes(v);
}

function isRunnerState(v: string): v is RunnerState {
  return v === "online" || v === "offline";
}

function isRunnerProjectStatus(v: string): v is RunnerProjectStatus {
  return v === "online" || v === "offline";
}

function isRiskLevel(v: string): v is RiskLevel {
  return (RISK_LEVELS as readonly string[]).includes(v);
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

/** 读取 INTEGER 列（缺失 / 非整数 = 数据损坏，fail-fast） */
function readInteger(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new Error(`[session-store] 列 ${key} 数据损坏：期望 integer`);
  }
  return v;
}

/** 解析 `failure_kind` 列（可空；非法值 = 数据损坏，fail-fast） */
function readFailureKind(row: Record<string, unknown>): FailureKind | null {
  const raw = readNullableString(row, "failure_kind");
  if (raw === null) return null;
  if (!isFailureKind(raw)) {
    throw new Error(`[session-store] 列 failure_kind 数据损坏：非法分类 ${raw}`);
  }
  return raw;
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

/**
 * tasks 表全列清单（SELECT 单一事实源；新增列时同步此处 + rowToTask）。
 *
 * v0.6.1 REQ-05：`exhausted` / `not_before` / `last_poll_at` **三列自本期起为休眠列** ——
 * 列仍在库中（`schema 不挖`），但**不再出现在 SELECT**；`rowToTask` 以固定中性值（`false` / `null`）
 * 填充对应字段，故这三条历史值不会被任何代码读到。
 */
const TASK_COLUMNS =
  "task_id, project_id, context_id, state, artifacts_json, text, prompt, " +
  "feature_id, dependencies, input_artifacts, remote_task_id, dispatch_guard, dispatch_message, updated_at, " +
  "retry_count, failure_kind, " +
  "created_at, started_at, finished_at";

/** features 表全列清单（SELECT 单一事实源；新增列时同步此处 + rowToFeature） */
const FEATURE_COLUMNS =
  "feature_id, state, title, requirement, context_id, plan, decisions, contracts, " +
  "owner_group, created_at, updated_at";

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
    // v0.5.0 三时刻列：一律**可空**（老记录不回填）；`created_at` / `started_at` 正常路径必有值，
    // 但读侧不得 fail-fast（NULL 是合法历史态，不是数据损坏）
    createdAt: readNullableString(row, "created_at"),
    startedAt: readNullableString(row, "started_at"),
    finishedAt: readNullableString(row, "finished_at"),
    featureId: readNullableString(row, "feature_id"),
    dependencies: readDependencies(row),
    inputArtifacts: readInputArtifacts(row),
    remoteTaskId: readNullableString(row, "remote_task_id"),
    // C11 派发占位（非 NULL = 已发出）：老记录 / 独立单任务为 NULL
    dispatchGuard: readNullableString(row, "dispatch_guard"),
    dispatchMessage: readNullableString(row, "dispatch_message"),
    retryCount: readInteger(row, "retry_count"),
    failureKind: readFailureKind(row),
    // v0.6.1 REQ-05：三列休眠 —— 不进 SELECT，恒取中性值（字段保留以维持 TaskRecord 形状）
    exhausted: false,
    notBefore: null,
    lastPollAt: null,
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
    // v0.8.6 §2.3 归属列：可空（NULL = 无归属，存量 / 未配组环境创建）；读侧不 fail-fast
    ownerGroup: readNullableString(row, "owner_group"),
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

/**
 * 解析 `queue_state` 列：**NULL 归一为 `settled`**（v0.7.0 之前的老行不在队列中）；
 * 非 NULL 但非法值 = 数据损坏（fail-fast，与其余列同纪律）。
 */
function readQueueState(row: Record<string, unknown>): QueueState {
  const raw = readNullableString(row, "queue_state");
  if (raw === null) return "settled";
  if (!isQueueState(raw)) {
    throw new Error(`[session-store] 列 queue_state 数据损坏：非法值 ${raw}`);
  }
  return raw;
}

/** `tasks` 队列视角全列清单（SELECT 单一事实源；含队列五列） */
const QUEUE_TASK_COLUMNS = `${TASK_COLUMNS}, queue_state, claimed_by, claim_token, claimed_at, queued_at`;

function rowToQueuedTask(row: Record<string, unknown>): QueuedTaskRecord {
  return {
    ...rowToTask(row),
    queueState: readQueueState(row),
    claimedBy: readNullableString(row, "claimed_by"),
    claimToken: readNullableString(row, "claim_token"),
    claimedAt: readNullableString(row, "claimed_at"),
    queuedAt: readNullableString(row, "queued_at"),
  };
}

function rowToRunner(row: Record<string, unknown>): RunnerRecord {
  const state = readString(row, "state");
  if (!isRunnerState(state)) {
    throw new Error(`[session-store] 列 state 数据损坏：非法 Runner 注册态 ${state}`);
  }
  return {
    runnerId: readString(row, "runner_id"),
    machineId: readString(row, "machine_id"),
    protocolVersion: readString(row, "protocol_version"),
    version: readNullableString(row, "version"),
    state,
    registeredAt: readString(row, "registered_at"),
    lastHeartbeatAt: readString(row, "last_heartbeat_at"),
  };
}

function rowToRunnerProject(row: Record<string, unknown>): RunnerProjectRecord {
  const agentKind = readString(row, "agent_kind");
  if (!isAgentKind(agentKind)) {
    throw new Error(`[session-store] 列 agent_kind 数据损坏：非法值 ${agentKind}`);
  }
  const status = readString(row, "status");
  if (!isRunnerProjectStatus(status)) {
    throw new Error(`[session-store] 列 status 数据损坏：非法项目态 ${status}`);
  }
  const risk = readNullableString(row, "risk");
  if (risk !== null && !isRiskLevel(risk)) {
    throw new Error(`[session-store] 列 risk 数据损坏：非法风险级别 ${risk}`);
  }
  return {
    runnerId: readString(row, "runner_id"),
    projectId: readString(row, "project_id"),
    workspace: readNullableString(row, "workspace"),
    agentKind,
    a2aPort: readInteger(row, "a2a_port"),
    risk,
    status,
    endpoint: readNullableString(row, "endpoint"),
    startedAt: readNullableString(row, "started_at"),
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
  updated_at    TEXT NOT NULL,
  created_at    TEXT,
  started_at    TEXT,
  finished_at   TEXT
)`;

/**
 * `finished_at` 的终态口径（v0.5.0 三时刻列）：**只有这三个态算「已完成」**。
 *
 * ⚠️ 与 `scheduler.isLocalTerminalTask`（把 `input-required` 也算本地终态）**刻意不同**：
 * `input-required` 是**可续推**的中间停靠（澄清后同 `contextId` 续接），不是完成 ⇒
 * 不得写 `finished_at`。两套集合判据相似但语义不同，改动任一者前先确认「本地终结 ≠ 已完成」。
 */
const FINISHED_TASK_STATES: readonly TaskState[] = ["completed", "failed", "blocked"];

const FEATURES_DDL = `
CREATE TABLE IF NOT EXISTS features (
  feature_id  TEXT PRIMARY KEY,
  state       TEXT NOT NULL,
  title       TEXT NOT NULL,
  requirement TEXT,
  owner_group TEXT,
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
 * Runner 注册表（v0.7.0 A2）。**运行态投影**：可删可重建，**启动不清空**。
 * `machine_id` UNIQUE = 「一台机器同时只有一个 Runner 注册行」。
 */
const RUNNERS_DDL = `
CREATE TABLE IF NOT EXISTS runners (
  runner_id         TEXT PRIMARY KEY,
  machine_id        TEXT NOT NULL UNIQUE,
  protocol_version  TEXT NOT NULL,
  version           TEXT,
  state             TEXT NOT NULL,
  registered_at     TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL
)`;

/**
 * Runner 项目投影表（v0.7.0 A2）。写入语义 = `runnerProjectsReplace` **全量替换**
 * （一次注册 / 心跳上报覆盖该 Runner 的项目视图）；机器仍自持项目配置，桥不下发。
 */
const RUNNER_PROJECTS_DDL = `
CREATE TABLE IF NOT EXISTS runner_projects (
  runner_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  workspace   TEXT,
  agent_kind  TEXT NOT NULL,
  a2a_port    INTEGER NOT NULL,
  risk        TEXT,
  status      TEXT NOT NULL,
  endpoint    TEXT,
  started_at  TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (runner_id, project_id)
)`;

/**
 * SQLite 会话/任务存储。
 * 桥（bridge）进程内通常使用模块级默认单例（见文件底部的导出函数）。
 */
export class SessionStore {
  private readonly db: DatabaseSync;
  private closed = false;
  /**
   * C12 触顶告警去重（每实例、每 key 至多一次）。
   *
   * 理由：`listFeatures` / `listFeatureTasks` 位于调度 **tick 热路径**（每 tick 多次），
   * 触顶是**持续性**事实而非事件 ⇒ 若不去的，会每 tick 往事件收件箱刷同一条告警。
   * 随实例销毁（`close()` ⇒ 下次 `getDefaultStore()` 全新集合），测试隔离友好。
   */
  private readonly truncationWarned = new Set<string>();

  constructor(dbPath: string = process.env["SESSION_DB"] ?? DEFAULT_SESSION_DB) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    }
    this.db = openStoreDatabase(dbPath);
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
    // v0.4.1 迁移：tasks 加失败自动化列 —— 重试门槛 / 失败分类 / 中性化标记 / 取证派发门
    // （`INTEGER NOT NULL DEFAULT 0` 使既有行直接取默认值，无需回填）。
    //
    // ⚠️ v0.6.1 REQ-05：**列保留（schema 不挖），但 `exhausted` / `not_before` / `last_poll_at`
    // 三列自本期起为休眠列**（停止读写：不进 `TASK_COLUMNS`、无任何 UPDATE 写口）；`failure_kind`
    // 亦**停止写入**（读侧保留，出参恒 `null`）。保留 ALTER 的目的是**不挖 schema** ⇒ 老库升级
    // 路径不变、未来若要复用在库数据不丢。
    for (const column of [
      "retry_count INTEGER NOT NULL DEFAULT 0",
      "failure_kind TEXT",
      "exhausted INTEGER NOT NULL DEFAULT 0",
      "not_before TEXT",
      "last_poll_at TEXT",
    ]) {
      try {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column}`);
      } catch {
        // 列已存在
      }
    }
    // v0.5.0 迁移：tasks 加三时刻列（网页端只读工作台展示任务耗时）。
    // 一律 `TEXT` 且**允许 NULL**：老数据**不回填**（NULL = 该时刻未知 / 未发生），
    // 故读侧 `rowToTask` 用 `readNullableString` 而非 fail-fast 的 `readString`。
    for (const column of ["created_at TEXT", "started_at TEXT", "finished_at TEXT"]) {
      try {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column}`);
      } catch {
        // 列已存在
      }
    }
    // v0.6.1 REQ-05 §2.5 白捡（C11）：派发占位列 —— 本版**唯一**新增列（任务级幂等键）。
    // 语义见 `types.ts` 的 `TaskRecord.dispatchGuard`：A2A send **前**写占位、send 后回填
    // `remote_task_id`；崩溃恢复据此区分「占位未发 vs 已发」⇒ 既不双派也不永久不派。
    // 纪律：只加列、必可空、不复用既有列、读侧 `readNullableString`、**只在 ctor try-ALTER**。
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN dispatch_guard TEXT");
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
    // v0.8.6 §2.3 迁移（REQ-v0.8.6-2026-09-21-01 · N4）：features 加归属列 `owner_group`
    // （建 Feature 时的连接身份 / 组名）。**必可空、老行不回填**（NULL = 无归属：未配组环境创建的
    // Feature 或配组改造前的存量行）；可见性口径 **fail-closed**（未配组全量可见、已配组对组身份不可见，
    // 不猜默认组，§1.3 R-3 / G2）。读侧 `rowToFeature` 用 `readNullableString`（NULL 合法、不 fail-fast）。
    // 纪律照既有：只加列、必可空、不复用既有列、**只在 ctor try-ALTER**（无 `PRAGMA user_version`、不引入 DDL 版本管理）。
    try {
      this.db.exec("ALTER TABLE features ADD COLUMN owner_group TEXT");
    } catch {
      // 列已存在
    }
    // v0.4.1 迁移（REQ-v0.4.1-2026-09-16-01 §2.3）：主链收敛 ⇒ 前段三态已从枚举删除。
    // `features.state` **无 DB 约束**（见 FEATURES_DDL），非法值在**读取时**抛（`rowToFeature`）⇒
    // `scheduler.recover` 启动即抛（`/health` 永远 503）+ `tick` 停摆（波及所有 Feature）⇒ 必须归一。
    // **三条纪律**：(a) **不改 `updated_at`**（归一不是活动：避免历史 Feature 顶到列表首位，
    // 也避免与 `updateFeatureState`「改态即改时间 + 写事件」的语义混淆）；(b) **不写 `feature.state`
    // 事件**（迁移非运行期状态变更，写事件会灌收件箱、让宿主误判"有新进展"）；(c) **幂等**
    // （WHERE 命中即改，重复启动零行）。**顺序：先退役集、后兜底** ⇒ 只含三态遗留行的**正常升级
    // 路径不会触发**下方兜底告警。
    this.db
      .prepare(
        `UPDATE features SET state = 'waiting_approval'
         WHERE state IN (${RETIRED_FEATURE_STATES.map(() => "?").join(", ")})`,
      )
      .run(...RETIRED_FEATURE_STATES);

    // 兜底：既不属当前枚举、也不属退役集的**真脏值**（手工写入 / 历史脚本）同样会让读取抛 ⇒
    // 先取证（取值 + 行数 `console.error` 留痕），再归一 —— 把"桥起不来"降级为"脏行停在审批门
    // 等人处理"。全集取 `FEATURE_STATES ∪ RETIRED_FEATURE_STATES`（见 `RETIRED_FEATURE_STATES` 注记）。
    const knownStates = [...FEATURE_STATES, ...RETIRED_FEATURE_STATES];
    const knownPlaceholders = knownStates.map(() => "?").join(", ");
    const dirtyRows = this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM features
         WHERE state NOT IN (${knownPlaceholders}) GROUP BY state`,
      )
      .all(...knownStates) as Array<Record<string, unknown>>;
    if (dirtyRows.length > 0) {
      const detail = dirtyRows
        .map((row) => `${String(row["state"])}×${String(row["n"])}`)
        .join(" / ");
      const total = dirtyRows.reduce((sum, row) => sum + Number(row["n"]), 0);
      console.error(
        `[session-store] features.state 脏值归一 → waiting_approval：${detail}（共 ${total} 行）`,
      );
      this.db
        .prepare(
          `UPDATE features SET state = 'waiting_approval'
           WHERE state NOT IN (${knownPlaceholders})`,
        )
        .run(...knownStates);
    }
    // ── v0.7.0 A2：四段前向幂等迁移（Runner 注册表 + 任务队列地基）──────────────
    // 纪律：**前向、逐段、各段自幂等**（`CREATE ... IF NOT EXISTS` / try-ALTER）⇒ 重复启动
    // 零副作用（连续两跑库状态一致）；**注册表不启动清空**（不清 `runners` / `runner_projects`，
    // 重启后投影仍在）。段落划分（顺序固定）：
    //   段 1：`tasks` 队列五列；段 2：`runners` 表；段 3：`runner_projects` 表；段 4：队列 / 注册表索引。
    // 段 1：`tasks` 队列列。老行一律留 NULL（`queue_state` NULL ⇒ 读侧视为 `settled`，**不回填**）。
    for (const column of [
      "queue_state TEXT",
      "claimed_by TEXT",
      "claim_token TEXT",
      "claimed_at TEXT",
      "queued_at TEXT",
    ]) {
      try {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column}`);
      } catch {
        // 列已存在（幂等）
      }
    }
    // 段 2 / 段 3：注册表两张（运行态投影；IF NOT EXISTS = 幂等）
    this.db.exec(RUNNERS_DDL);
    this.db.exec(RUNNER_PROJECTS_DDL);
    // 段 4：索引 —— 队列候选（claim 热路径）/ claim_token 唯一 / 项目投影按 Runner
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(queue_state, queued_at)");
    // claim_token 唯一：SQLite 唯一索引允许多个 NULL ⇒ 未领取行不受限，领取行令牌唯一。
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_claim_token ON tasks(claim_token)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_runner_projects_runner ON runner_projects(runner_id)",
    );

    // 按项目 + updated_at 倒序的列表查询索引
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_project_updated ON tasks(project_id, updated_at DESC)",
    );
    // Feature 列表（按状态 + updated_at 倒序）与按 Feature 取任务节点的索引
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_features_state_updated ON features(state, updated_at DESC)",
    );
    // v0.8.6 §2.3：Feature 列表 / 事件收件箱案 B 过滤（`owner_group = ?`）的热路径索引
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_features_owner ON features(owner_group)");
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

  /**
   * 创建/覆盖任务记录，返回落库后的记录。
   *
   * **v0.5.0 三时刻列**（网页端只读工作台展示耗时；口径见 `types.ts` 的 `TaskRecord`）：
   * - `created_at`：**登记时刻**，仅 INSERT 写；`ON CONFLICT` **不更新** ⇒ 首次为准
   *   （参照 `upsertSession` 保留首次 `created_at` 的先例）；
   * - `started_at`：**首次开工时刻**，`state === "working"` 时填；冲突时 `COALESCE` 保留首次
   *   —— 与 `markTaskDispatched`「仅 NULL 才填」同一纪律：重派 / 重试不重置起点；
   * - `finished_at`：**完成时刻**，终态（`completed` / `failed` / `blocked`）时填；冲突时同样
   *   `COALESCE` 保留首次。**必须在 createTask 也写**：独立单任务走 `handleCall` 直接
   *   `createTask(state = 终态)`，**从不经过 CAS**（见 `bridge/index.ts` 的 handleCall）。
   */
  createTask(rec: TaskCreateInput): TaskRecord {
    const now = nowIso();
    const updatedAt = rec.updatedAt ?? now;
    // 三时刻与本行首次落库同源（同一 `now`），避免毫秒级漂移
    const createdAt = now;
    const startedAt = rec.state === "working" ? now : null;
    const finishedAt = isFinishedState(rec.state) ? now : null;
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
            feature_id, dependencies, input_artifacts, remote_task_id, dispatch_message, updated_at,
            created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           updated_at = excluded.updated_at,
           started_at = COALESCE(started_at, excluded.started_at),
           finished_at = COALESCE(excluded.finished_at, finished_at)`,
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
        createdAt,
        startedAt,
        finishedAt,
      );
    const stored = this.getTask(rec.taskId);
    if (stored === null) {
      throw new Error(`[session-store] createTask 后未能读回记录：${rec.taskId}`);
    }
    return stored;
  }

  /**
   * 原子任务态流转（compare-and-swap）：单语句 `UPDATE ... WHERE task_id = ? AND state = ?`，
   * 仅当当前态等于 `expectedFrom` 时才置为 `to`。返回是否实际写入（`changes > 0`）。
   * 作为「读-改-写」的原子替代，防止并发下丢失更新；`artifactsJson` / `text` 未提供时保留原值。
   *
   * v0.5.0：**`finished_at` 写口** —— 转入终态（`completed` / `failed` / `blocked`）时落时刻；
   * 转入非终态（`working` / `input-required`）时**保留原值**，不在此做隐式清空
   * （清空点是 `rearmTask` / `rearmForRetry`，它们才是"回到未完成"的显式动作）。
   */
  compareAndSwapTaskState(
    taskId: string,
    expectedFrom: TaskState,
    to: TaskState,
    artifactsJson?: string | null,
    text?: string | null,
  ): boolean {
    const now = nowIso();
    const finishedAt = isFinishedState(to) ? now : null;
    const changes = conditionalStateUpdate(this.db, {
      table: "tasks",
      keyColumn: "task_id",
      key: taskId,
      expectedState: expectedFrom,
      nextState: to,
      assignments: [
        "artifacts_json = COALESCE(?, artifacts_json)",
        "text = COALESCE(?, text)",
        "finished_at = COALESCE(?, finished_at)",
        "updated_at = ?",
      ],
      assignmentParams: [artifactsJson ?? null, text ?? null, finishedAt, now],
    });
    return changes > 0;
  }

  /**
   * 更新任务态；`artifactsJson` / `text` 未提供时保留原值（COALESCE）。
   * 任务不存在时无效果，返回 null。
   * v0.4.0：状态发生**变化**且新态非 `working` 时，自动写事件收件箱
   * （`blocked` → `task.blocked`；`completed`/`failed`/`input-required` → `task.settled`）。
   * v0.4.1：写入改为 CAS（`WHERE state = <读到的原态>`），并发被抢先时不覆盖、不重复写事件。
   */
  updateTaskState(
    taskId: string,
    state: TaskState,
    artifactsJson?: string | null,
    text?: string | null,
  ): TaskRecord | null {
    const previous = this.getTask(taskId);
    if (previous === null) return null;
    const changed = this.compareAndSwapTaskState(
      taskId,
      previous.state,
      state,
      artifactsJson,
      text,
    );
    const stored = this.getTask(taskId);
    if (changed && stored !== null && previous.state !== stored.state) {
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
   * **C11 派发占位（先占位后发）**：在 A2A `message/send` **之前**写入「已发出」事实。
   * 任务不存在时无效果，返回 null。
   *
   * - `dispatch_guard` = 占位时刻（非 NULL = 已发起派发）；`remote_task_id` **保持 NULL**，
   *   由 {@link markTaskDispatched} 在 send 返回后回填；
   * - `started_at` 与占位同批写（`COALESCE`：仅首次填）—— 占位时刻即「首次开工」；
   * - **幂等**：`COALESCE(dispatch_guard, ?)` ⇒ 重复调用**不刷新**占位时刻（不产生新事实）。
   *
   * **事务粒度 / 锁**：单条 `UPDATE` 即原子（SQLite 单进程写，`DatabaseSync` 同步执行）；
   * 占位与回填是**两个独立语句**，**不得**跨 `await`（`sendMessage` 是长 I/O）持有事务 ——
   * 崩溃窗口改由「占位」显式表达（`recover` 据三态判定），而非靠长事务掩盖。
   */
  markTaskDispatchStarted(taskId: string): TaskRecord | null {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE tasks
         SET dispatch_guard = COALESCE(dispatch_guard, ?), started_at = COALESCE(started_at, ?),
             updated_at = ?
         WHERE task_id = ?`,
      )
      .run(now, now, now, taskId);
    return this.getTask(taskId);
  }

  /**
   * Feature 节点派发落库：回填远端 id，保持 state（working）以便看护接管。
   * 任务不存在时无效果，返回 null。
   *
   * v0.5.0：**`started_at` 写口（仅当 IS NULL 才填）** —— `COALESCE(started_at, ?)` 使
   * 「首次派发」补时刻、而重派 / 重试**不重置起点**（幂等；与 `createTask` 的 `COALESCE` 同一纪律）。
   *
   * v0.6.1 REQ-05 §2.5 白捡（C11）：本方法 = **占位后的回填**（真实远端 id）——
   * **不清 `dispatch_guard`**（「已发出」是既成事实，清空点只在 `rearmTask` / `rearmForRetry`）。
   */
  markTaskDispatched(taskId: string, remoteTaskId: string): TaskRecord | null {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE tasks
         SET remote_task_id = ?, started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE task_id = ?`,
      )
      .run(remoteTaskId, now, now, taskId);
    return this.getTask(taskId);
  }

  /**
   * needs_input 恢复：将任务节点重新置为待派发（state=working、清远端 id、
   * 更新待派发消息），供调度器以同 contextId 续接。任务不存在时返回 null。
   *
   * v0.5.0：**同时清 `finished_at`** —— 该节点重新成为"在飞未完成"，
   * 否则破坏不变量「有 `finished_at` ⇔ 已完成」（网页端会把它显示成已完成）。
   * `started_at` **保留**（首次开工时刻，续推不改写耗时起点）。
   *
   * v0.6.1 REQ-05 §2.5 白捡（C11）：**同时清 `dispatch_guard`** —— 回到「待派发」后，
   * 旧占位不再代表「已发出」（否则重启恢复会把重排后的节点误判为派发窗口中断 ⇒ 永久不派）。
   *
   * ⚠️ **Feature `failed` 节点重派禁止走此口**：本方法不做状态前置校验、亦不自增 `retry_count`，
   * 唯一入口 = `rearmForRetry`（单语句条件 UPDATE + `retry_count+1`，参与失败账单 episode 去重）。
   */
  rearmTask(taskId: string, dispatchMessage: string): TaskRecord | null {
    this.db
      .prepare(
        `UPDATE tasks
         SET state = 'working', remote_task_id = NULL, dispatch_guard = NULL, dispatch_message = ?,
             updated_at = ?, finished_at = NULL
         WHERE task_id = ?`,
      )
      .run(dispatchMessage, nowIso(), taskId);
    return this.getTask(taskId);
  }

  /**
   * **条件重试**（v0.4.1 §2.4，N=1）：把**已失败**节点重排为待派发，供调度器以
   * **同 `contextId`** 续一次（`rearmTask` 不做状态前置校验，故单列此带条件版本）。
   *
   * 单语句条件 UPDATE（`WHERE task_id = ? AND state = 'failed'`）：状态不匹配即
   * **不写入任何行** ⇒ 既不与并发写入互相覆盖（防丢失更新），也拒绝对非 `failed` 节点重排。
   *
   * **`retry_count` 在此自增（0 → 1），不在 fail 时** —— 该列是「防死循环」承重件：
   * 倒置为「先取证 → 条件重试」后若去掉门槛，会 `fail → 取证 → D 非空 → re-arm → fail → …` 死循环。
   *
   * **顺带清 `exhausted = 0`（re-arm ⇒ 退出中性化）**：中性化标记的事实前提是"这是一个**已终结**
   * 的失败节点"；一旦授予重试，该节点**重新成为普通在飞节点**。若不清：
   * ① `computeReadyNodes` 会把它当"不参与派发"而**永久挡住重试**（静默停滞）；
   * ② `all_completed` 会把它算作 completed，**重试尚未跑完 Feature 就 `integrating`**。
   * 清掉后 `exhausted=1` 恒蕴含 `state='failed'`，**不存在"已 re-arm 却仍置位"的窗口**。
   *
   * 返回是否命中（`false` = 任务不存在或当前态非 `failed`，**未发生任何写入**；此时
   * `exhausted` 亦**不得**被清）。
   *
   * v0.5.0：**同时清 `finished_at`** —— `failed` 是终态口径之一（有 `finished_at`），
   * 授予重试后节点重新成为在飞未完成 ⇒ 必须清空以维持不变量「有 `finished_at` ⇔ 已完成」。
   * `started_at` **保留**（首次开工时刻，重试不改写耗时起点）。
   *
   * v0.6.1 REQ-05 §2.5 白捡（C11）：**同时清 `dispatch_guard`** —— 重派是新的派发动作，
   * 旧占位必须作废，否则 `computeReadyNodes` 的「占位 ⇒ 不重派」判据会**永久挡住重派**
   * （重派节点 `remote_task_id = NULL` 且占位仍在 ⇒ 永不就绪）。
   */
  rearmForRetry(taskId: string, dispatchMessage: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE tasks
         SET state = 'working', remote_task_id = NULL, dispatch_guard = NULL, dispatch_message = ?,
             retry_count = retry_count + 1, exhausted = 0, updated_at = ?, finished_at = NULL
         WHERE task_id = ? AND state = 'failed'`,
      )
      .run(dispatchMessage, nowIso(), taskId);
    return Number(info.changes) > 0;
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

  /**
   * **C12 触顶截断告警**（v0.6.1 REQ-05 §2.5 白捡）：`limit` 触顶（`returned === limit`）时
   * 记**事件 + 日志各一条**（{@link EVENT_LIST_TRUNCATED}），令「`limit:1000` 静默截断」可观测。
   *
   * - 触发判据 = 「返回行数 `=== limit`」（`limit` 调用方已 clamp 到 [1,1000]）⇒ **仅触顶才**
   *   做一次 `COUNT(*)` 得 `total`（校验「恰好等于 limit」vs「真被截断」），**未触顶零额外开销**；
   * - 去重：`key`（= list + scope + limit）不变 ⇒ 本实例内只告警一次；key 变（换 list / 换 limit /
   *   换 Feature）⇒ 重新告警（不同截断面 = 不同事实）；
   * - 纯观测：**不改**查询结果、不抛错（告警失败不得影响读取）。
   */
  private warnIfListTruncated(
    key: string,
    list: string,
    featureId: string | null,
    returned: number,
    limit: number,
    countTotal: () => number,
  ): void {
    if (returned < limit) return;
    if (this.truncationWarned.has(key)) return;
    this.truncationWarned.add(key);
    let total: number;
    try {
      total = countTotal();
      console.error(
        `[session-store] ${list} 触顶截断：limit=${limit}，返回 ${returned}，total=${total}（后续同 key 静默）`,
      );
    } catch (err) {
      console.error(`[session-store] ${list} 触顶统计失败：${String(err)}`);
      total = returned;
    }
    try {
      this.appendEvent({
        featureId,
        taskId: null,
        kind: EVENT_LIST_TRUNCATED,
        state: null,
        payload: JSON.stringify({ list, limit, returned, total }),
      });
    } catch (err) {
      console.error(`[session-store] ${list} 触顶告警事件写入失败：${String(err)}`);
    }
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
    // v0.6.1 REQ-05 §2.5 白捡（C12）：触顶 ⇒ 事件 + 日志各一条（total 校验）
    this.warnIfListTruncated(
      `listFeatureTasks:${featureId}:${limit}`,
      "listFeatureTasks",
      featureId,
      rows.length,
      limit,
      () => {
        const row = this.db
          .prepare("SELECT COUNT(*) AS n FROM tasks WHERE feature_id = ?")
          .get(featureId) as Record<string, unknown> | undefined;
        return Number(row?.["n"] ?? 0);
      },
    );
    return rows.map(rowToTask);
  }

  /**
   * **项目忙**集合（v0.6.1 REQ-05 §2.5 / N5）：当前存在**在飞节点**的 `project_id` 集合。
   *
   * 判据 = `EXISTS(state = 'working' AND remote_task_id IS NOT NULL)`（`DISTINCT project_id`）。
   *
   * ⚠️ **不得复用 `listTasks`**：后者 `limit` clamp 到 `[1,100]` 且按 `updated_at DESC` 截断
   * ⇒ 任务多于 100 条时**静默漏**忙碌项目（串行虚设）。本查询是**集合投影**（无 limit、无排序），
   * 返回基数天然有界于项目数，不存在截断。
   *
   * 「在飞」口径 = **派发在恋 ∨ 看护存活**（受 `A2A_REQUEST_TIMEOUT_MS` / 看护 `renew` +
   * `maxConsecutiveFailures → abandoned` 约束）—— **事件性上界，非墙钟上界**（改造文档 §2.5
   * 硬约束 2）；`working ∧ 丢看护` 的**悬挂态**兜底 = 桥重启 `recover()` 对账，不在本查询内。
   *
   * 本查询只覆盖**已落库**的在飞；「派发已发起但 `remote_task_id` 尚未回填」的窗口由调度器
   * **进程内项目预留**补（`FeatureScheduler.reservedProjects`）——二者相并方为完整忙集。
   */
  listBusyProjectIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT project_id FROM tasks
          WHERE state = 'working' AND remote_task_id IS NOT NULL`,
      )
      .all() as Array<Record<string, unknown>>;
    const ids = new Set<string>();
    for (const row of rows) ids.add(readString(row, "project_id"));
    return ids;
  }

  // ------------------------------------------------------------------
  // v0.7.0 A2：Runner 注册表（运行态投影，启动不清空）
  // ------------------------------------------------------------------

  /**
   * 写入 / 刷新 Runner 注册行（**按 `machine_id` 幂等 upsert**；运行态投影，重启不清空）。
   *
   * - 身份 = `machine_id`：同一台机器重复注册命中同一行（不产生重复注册行）；`runner_id`（PK）
   *   随之更新为本次注册实例 id。**契约**：同一 `runner_id` 只能属于同一台机器 —— 违反会触发
   *   PK 冲突（契约错误，不做静默兼容）。
   * - `registered_at` **保留首次**（重注册不刷新）；`last_heartbeat_at` 每次刷新。
   * - `state` 缺省 `online`；心跳超期降级由调用方显式传 `offline`（决策 D8：只降态、**不 stop**）。
   */
  upsertRunner(rec: RunnerUpsertInput): RunnerRecord {
    const state = rec.state ?? "online";
    if (rec.runnerId.length === 0 || rec.machineId.length === 0) {
      throw new Error("[session-store] upsertRunner 要求 runnerId / machineId 非空");
    }
    if (!isRunnerState(state)) {
      throw new Error(`[session-store] upsertRunner 非法注册态：${String(rec.state)}`);
    }
    const registeredAt = rec.registeredAt ?? nowIso();
    const lastHeartbeatAt = rec.lastHeartbeatAt ?? registeredAt;
    this.db
      .prepare(
        `INSERT INTO runners
           (runner_id, machine_id, protocol_version, version, state, registered_at, last_heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(machine_id) DO UPDATE SET
           runner_id = excluded.runner_id,
           protocol_version = excluded.protocol_version,
           version = excluded.version,
           state = excluded.state,
           registered_at = COALESCE(registered_at, excluded.registered_at),
           last_heartbeat_at = excluded.last_heartbeat_at`,
      )
      .run(
        rec.runnerId,
        rec.machineId,
        rec.protocolVersion,
        rec.version ?? null,
        state,
        registeredAt,
        lastHeartbeatAt,
      );
    const row = this.db.prepare("SELECT * FROM runners WHERE machine_id = ?").get(rec.machineId);
    if (row === undefined) {
      throw new Error(`[session-store] upsertRunner 后未能读回记录：${rec.machineId}`);
    }
    return rowToRunner(row);
  }

  /**
   * 刷新心跳：写 `last_heartbeat_at` 并置回 `online`。返回落库记录；Runner 不存在返回 null。
   * `at` 缺省 now（便于测试注入确定性时刻）。
   */
  touchRunnerHeartbeat(runnerId: string, at?: string): RunnerRecord | null {
    const now = at ?? nowIso();
    const info = this.db
      .prepare("UPDATE runners SET last_heartbeat_at = ?, state = 'online' WHERE runner_id = ?")
      .run(now, runnerId);
    if (Number(info.changes) === 0) return null;
    const row = this.db.prepare("SELECT * FROM runners WHERE runner_id = ?").get(runnerId);
    return row === undefined ? null : rowToRunner(row);
  }

  /**
   * **全量替换**某 Runner 的项目投影（先删后插，单事务）。返回替换后的记录（按 `projectId` 升序）。
   *
   * - 语义：一次注册 / 心跳 = 该 Runner 的**完整项目视图**（非增量）⇒ 本次不再上报的旧项目被移除；
   *   空数组 = 清空（Runner 在线但无项目）。
   * - **先校验后落库**（非法入参 fail-fast，不产生半替换）；删除 + 插入包在 `BEGIN IMMEDIATE`
   *   事务内 ⇒ 读取方不会看到「空窗」。
   * - 不校验 `runnerId` 是否存在（投影可先于 / 独立于注册行写入；注册行由 `upsertRunner` 维护）。
   */
  runnerProjectsReplace(
    runnerId: string,
    projects: readonly RunnerProjectInput[],
  ): RunnerProjectRecord[] {
    if (runnerId.length === 0) {
      throw new Error("[session-store] runnerProjectsReplace 要求 runnerId 非空");
    }
    for (const p of projects) {
      if (p.projectId.length === 0) {
        throw new Error("[session-store] runnerProjectsReplace 要求 projectId 非空");
      }
      if (!isAgentKind(p.agentKind)) {
        throw new Error(
          `[session-store] runnerProjectsReplace 非法 agentKind：${String(p.agentKind)}`,
        );
      }
      if (!Number.isInteger(p.a2aPort)) {
        throw new Error(`[session-store] runnerProjectsReplace 非法 a2aPort：${String(p.a2aPort)}`);
      }
      if (!isRunnerProjectStatus(p.status)) {
        throw new Error(`[session-store] runnerProjectsReplace 非法 status：${String(p.status)}`);
      }
      if (p.risk !== undefined && p.risk !== null && !isRiskLevel(p.risk)) {
        throw new Error(`[session-store] runnerProjectsReplace 非法 risk：${String(p.risk)}`);
      }
    }
    const now = nowIso();
    const insert = this.db.prepare(
      `INSERT INTO runner_projects
         (runner_id, project_id, workspace, agent_kind, a2a_port, risk, status, endpoint, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM runner_projects WHERE runner_id = ?").run(runnerId);
      for (const p of projects) {
        insert.run(
          runnerId,
          p.projectId,
          p.workspace ?? null,
          p.agentKind,
          p.a2aPort,
          p.risk ?? null,
          p.status,
          p.endpoint ?? null,
          p.startedAt ?? null,
          now,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务已不在活动态：保留原始错误，不掩盖
      }
      throw err;
    }
    const rows = this.db
      .prepare("SELECT * FROM runner_projects WHERE runner_id = ? ORDER BY project_id ASC")
      .all(runnerId) as Array<Record<string, unknown>>;
    return rows.map(rowToRunnerProject);
  }

  /**
   * 查询某 Runner 的项目投影（**只读**）。
   *
   * v0.7.0 A3 消费点：`/runner/connect` 在 claim 前读本口，得出「本机可领取的项目集合」
   * （= 本机注册过的项目 ∩ 成员集合），据此判定「任务归属该机器」（静态分布下桥不把
   * 项目下发机器，机器自持项目视图）。缺省按 `projectId` 升序；无记录 / 空 `runnerId` 返回空数组。
   */
  listRunnerProjects(runnerId: string): RunnerProjectRecord[] {
    if (runnerId.length === 0) return [];
    const rows = this.db
      .prepare("SELECT * FROM runner_projects WHERE runner_id = ? ORDER BY project_id ASC")
      .all(runnerId) as Array<Record<string, unknown>>;
    return rows.map(rowToRunnerProject);
  }

  // ------------------------------------------------------------------
  // v0.7.0 A7：心跳超期清算读口（只读 + 单个降态写口）
  //
  // 为什么必须读库：清算循环（`bridge/runner.ts`）要在**桥重启后**仍能判定「哪些 Runner 超期、
  // 其名下还有哪些在飞任务」——进程内记忆重启即丢，会使 `queue_state='claimed'` 的行永久悬挂
  // ⇒ 与 A3 增补 `listRunnerProjects` / `getQueuedTask` 同一纪律（只读口，不改既有列语义）。
  // ------------------------------------------------------------------

  /**
   * 列出全部 Runner 注册行（**只读**；A7 心跳超期扫描的唯一入口）。
   * 缺省按 `registered_at` 升序（稳定序，便于测试断言）。
   */
  listRunners(): RunnerRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runners ORDER BY registered_at ASC, runner_id ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToRunner);
  }

  /**
   * 按 `machine_id` 读单个 Runner 注册行（**只读**；A7 判「离线→回线」的**先前态**读口）。
   * 必须在 `touchRunnerHeartbeat` / `upsertRunner`（二者恒置回 online）**之前**读取，否则
   * `offline` 事实已被覆盖。Runner 不存在 / 空 id 返回 null。
   */
  getRunner(machineId: string): RunnerRecord | null {
    if (machineId.length === 0) return null;
    const row = this.db.prepare("SELECT * FROM runners WHERE machine_id = ?").get(machineId);
    return row === undefined ? null : rowToRunner(row);
  }

  /**
   * 列出某领取者名下的**在飞**队列任务（`queue_state ∈ {claimed, running}`；**只读**）。
   *
   * A7 消费点：心跳超期清算据此遍历待回收任务（随后逐个 `requeueStaleTask`）。
   * 空 `claimedBy` → 空数组（不查库）。缺省按 `queued_at` 升序（FIFO，与 claim 同序）。
   */
  listClaimedTasks(claimedBy: string): QueuedTaskRecord[] {
    if (claimedBy.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ${QUEUE_TASK_COLUMNS} FROM tasks
          WHERE claimed_by = ? AND queue_state IN ('claimed', 'running')
          ORDER BY queued_at ASC, updated_at ASC`,
      )
      .all(claimedBy) as Array<Record<string, unknown>>;
    return rows.map(rowToQueuedTask);
  }

  /**
   * 标记 Runner 为 `offline`（**只写 `state` 单列**；A7 心跳超期降级写口）。
   *
   * 决策 D8：心跳超期**只降注册态、不触发 stop**（本方法不碰任何任务；任务回收由清算循环
   * 单独走 `requeueStaleTask`）。幂等（重复调用零副作用）。Runner 不存在返回 null。
   */
  markRunnerOffline(runnerId: string): RunnerRecord | null {
    if (runnerId.length === 0) return null;
    const info = this.db.prepare("UPDATE runners SET state = 'offline' WHERE runner_id = ?").run(
      runnerId,
    );
    if (Number(info.changes) === 0) return null;
    const row = this.db.prepare("SELECT * FROM runners WHERE runner_id = ?").get(runnerId);
    return row === undefined ? null : rowToRunner(row);
  }

  // ------------------------------------------------------------------
  // v0.7.0 A2：任务队列（claim CAS / 入队 / 清算 / 结果回传）
  // ------------------------------------------------------------------

  /**
   * **入队**（`queue_state = 'queued'`）：`dispatch_guard` **降级为入队幂等键**（不新增同义列）。
   *
   * - 单语句条件 UPDATE（`WHERE task_id = ? AND dispatch_guard IS NULL`）⇒ **幂等**：重复入队
   *   零写入（不刷新 `queued_at` ⇒ 不改变 FIFO 位次，也不覆盖已 `claimed` 的领取状态）。
   * - 任务不存在返回 null；已入队（或老数据已派发）返回**当前记录**（幂等 no-op，非 null）。
   * - 只写 `queue_state` / `queued_at` / `dispatch_guard` / `updated_at`，**不动 `state` 等既有列**。
   */
  enqueueTask(taskId: string): QueuedTaskRecord | null {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE tasks
         SET queue_state = 'queued', queued_at = ?, dispatch_guard = COALESCE(dispatch_guard, ?),
             updated_at = ?
         WHERE task_id = ? AND dispatch_guard IS NULL`,
      )
      .run(now, now, now, taskId);
    const row = this.db
      .prepare(`SELECT ${QUEUE_TASK_COLUMNS} FROM tasks WHERE task_id = ?`)
      .get(taskId);
    return row === undefined ? null : rowToQueuedTask(row);
  }

  /**
   * **领取任务**（CAS：`WHERE queue_state = 'queued'`）。
   *
   * 先从队列按 `queued_at` 升序（FIFO）取候选，再对候选逐条执行条件 UPDATE —— 当前态仍为
   * `queued` 才置 `claimed`（写 `claimed_by` / 唯一 `claim_token` / `claimed_at`）⇒ 并发下
   * **同一任务至多被一个领取者拿到**（CAS 落空者自动试下一候选，绝不覆盖）。
   *
   * - `projectIds` 缺省 = 不限项目；显式空数组 = 无可领取（返回 null，零 I/O）。
   * - `claimToken` 缺省由存储层生成（`randomUUID`；`idx_tasks_claim_token` 唯一索引兜底）。
   * - 无候选 / 全部被抢占 / 候选行消失 ⇒ 返回 null。
   */
  claimTask(opts: ClaimTaskOptions): QueuedTaskRecord | null {
    if (opts.claimedBy.length === 0) {
      throw new Error("[session-store] claimTask 要求 claimedBy 非空");
    }
    const projectIds = opts.projectIds;
    if (projectIds !== undefined && projectIds.length === 0) return null;
    const projectClause =
      projectIds === undefined
        ? ""
        : ` AND project_id IN (${projectIds.map(() => "?").join(", ")})`;
    const candidates = this.db
      .prepare(
        `SELECT task_id FROM tasks WHERE queue_state = 'queued'${projectClause}
         ORDER BY queued_at ASC, updated_at ASC LIMIT 50`,
      )
      .all(...(projectIds === undefined ? [] : [...projectIds])) as Array<Record<string, unknown>>;
    if (candidates.length === 0) return null;
    const claimedAt = opts.claimedAt ?? nowIso();
    const update = this.db.prepare(
      `UPDATE tasks
       SET queue_state = 'claimed', claimed_by = ?, claim_token = ?, claimed_at = ?, updated_at = ?
       WHERE task_id = ? AND queue_state = 'queued'`,
    );
    for (const candidate of candidates) {
      const taskId = readString(candidate, "task_id");
      const claimToken = opts.claimToken ?? randomUUID();
      const info = update.run(opts.claimedBy, claimToken, claimedAt, claimedAt, taskId);
      if (Number(info.changes) === 0) continue; // CAS 落空（已被抢占）⇒ 试下一候选
      const row = this.db
        .prepare(`SELECT ${QUEUE_TASK_COLUMNS} FROM tasks WHERE task_id = ?`)
        .get(taskId);
      return row === undefined ? null : rowToQueuedTask(row);
    }
    return null;
  }

  /**
   * 查询**队列视角**任务记录（**只读**）：既有 `TaskRecord` ∪ 队列五列；任务不存在返回 `null`。
   *
   * v0.7.0 A3 消费点：`/runner/result` 的 **claim_token 校验唯一读口** —— 端点据此比对
   * 上报令牌与当前领取令牌（令牌落库 ⇒ 桥重启 / 断桥重连后仍可校验，不依赖进程内记忆）。
   */
  getQueuedTask(taskId: string): QueuedTaskRecord | null {
    const row = this.db
      .prepare(`SELECT ${QUEUE_TASK_COLUMNS} FROM tasks WHERE task_id = ?`)
      .get(taskId);
    return row === undefined ? null : rowToQueuedTask(row);
  }

  /**
   * **清算悬挂领取**（B2）：`claimed` / `running` → `queued`，并清空 claim 三字段
   * （`claimed_by` / `claim_token` / `claimed_at`）。用于 Runner 心跳超期 / 归零后回收其名下任务。
   *
   * - 条件 UPDATE：仅 `queue_state ∈ {claimed, running}` 命中（`settled` / `queued` / NULL 老行零写入）。
   * - `expectedClaimedBy` 给定 ⇒ 仅清算该领取者名下的任务（防误清他人）。
   * - `queued_at` 保留原值（缺省回填 now）⇒ 重领取沿用原 FIFO 位次。
   * - 返回是否发生迁移（false = 未命中，零写入）。
   */
  requeueStaleTask(taskId: string, expectedClaimedBy?: string): boolean {
    const now = nowIso();
    const claimedClause = expectedClaimedBy === undefined ? "" : " AND claimed_by = ?";
    const params: string[] = [now, now, taskId];
    if (expectedClaimedBy !== undefined) params.push(expectedClaimedBy);
    const info = this.db
      .prepare(
        `UPDATE tasks
         SET queue_state = 'queued', claimed_by = NULL, claim_token = NULL, claimed_at = NULL,
             queued_at = COALESCE(queued_at, ?), updated_at = ?
         WHERE task_id = ? AND queue_state IN ('claimed', 'running')${claimedClause}`,
      )
      .run(...params);
    return Number(info.changes) > 0;
  }

  /**
   * **结果回传落库**（幂等键 = `(machineId, taskId)`）：写终态 + artifacts，并把队列态置 `settled`。
   *
   * 同一逻辑键（pull 回传 / callback 双路径）重复到达 ⇒ **幂等**：已终态行不再被覆盖
   * （`WHERE state NOT IN ('completed','failed','blocked')` 保证「首个终态胜出」，防迟到重复上报
   * 造成状态回退），返回既有行。返回值 = 落库后的**队列视角**记录。
   *
   * - 任务不存在 ⇒ 直接 INSERT 一行（`queue_state = 'settled'`，`created_at = 上报时刻`）。
   * - 只写 `state` / artifacts / text / remote_task_id 与 `finished_at`（首次）/ `updated_at`；
   *   **不动** `dependencies` / `dispatch_message` / `retry_count` 等既有编排列。
   */
  upsertTaskResult(rec: TaskResultUpsertInput): QueuedTaskRecord {
    if (rec.machineId.length === 0 || rec.taskId.length === 0) {
      throw new Error("[session-store] upsertTaskResult 要求 machineId / taskId 非空");
    }
    if (!isTaskState(rec.state)) {
      throw new Error(`[session-store] upsertTaskResult 非法任务态：${String(rec.state)}`);
    }
    const now = rec.updatedAt ?? nowIso();
    const finishedAt = isFinishedState(rec.state) ? now : null;
    this.db
      .prepare(
        `INSERT INTO tasks
           (task_id, project_id, context_id, state, artifacts_json, text, feature_id, remote_task_id,
            updated_at, created_at, started_at, finished_at, queue_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled')
         ON CONFLICT(task_id) DO UPDATE SET
           state = excluded.state,
           artifacts_json = COALESCE(excluded.artifacts_json, artifacts_json),
           text = COALESCE(excluded.text, text),
           remote_task_id = COALESCE(excluded.remote_task_id, remote_task_id),
           queue_state = 'settled',
           updated_at = excluded.updated_at,
           finished_at = COALESCE(finished_at, excluded.finished_at)
         WHERE state NOT IN ('completed', 'failed', 'blocked')`,
      )
      .run(
        rec.taskId,
        rec.projectId,
        rec.contextId,
        rec.state,
        rec.artifactsJson ?? null,
        rec.text ?? null,
        rec.featureId ?? null,
        rec.remoteTaskId ?? null,
        now,
        now,
        rec.state === "working" ? now : null,
        finishedAt,
      );
    const row = this.db
      .prepare(`SELECT ${QUEUE_TASK_COLUMNS} FROM tasks WHERE task_id = ?`)
      .get(rec.taskId);
    if (row === undefined) {
      throw new Error(`[session-store] upsertTaskResult 后未能读回记录：${rec.taskId}`);
    }
    return rowToQueuedTask(row);
  }

  // ------------------------------------------------------------------
  // Feature CRUD（v0.3.0）
  // ------------------------------------------------------------------

  /**
   * 创建/覆盖 Feature 记录（state 缺省 **`waiting_approval`** = 主链起点 / 审批门停靠点，
   * REQ-v0.4.1-2026-09-16-01 §2.3），返回落库后的记录。
   */
  createFeature(rec: FeatureCreateInput): FeatureRecord {
    const state = rec.state ?? "waiting_approval";
    if (!isFeatureState(state)) {
      throw new Error(`[session-store] createFeature 非法 Feature 态：${String(state)}`);
    }
    const createdAt = rec.createdAt ?? nowIso();
    const updatedAt = rec.updatedAt ?? createdAt;
    this.db
      .prepare(
        `INSERT INTO features (feature_id, state, title, requirement, context_id, owner_group, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
        // 归属 = 建 Feature 时的连接身份；重跑（ON CONFLICT）**不改归属**（谁建谁见，owner 不可变），
        // 故不出现在 DO UPDATE SET 中。NULL = 未配组环境 / 存量。
        rec.ownerGroup ?? null,
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
   * 原子 Feature 态流转（compare-and-swap）：单语句 `UPDATE ... WHERE feature_id = ? AND state = ?`，
   * 仅当当前态等于 `expectedFrom` 时才置为 `to`。返回是否实际写入（`changes > 0`）。
   * 作为「读-改-写」的原子替代，防止并发下丢失更新。
   */
  compareAndSwapFeatureState(
    featureId: string,
    expectedFrom: FeatureState,
    to: FeatureState,
  ): boolean {
    if (!isFeatureState(expectedFrom) || !isFeatureState(to)) {
      throw new Error(
        `[session-store] compareAndSwapFeatureState 非法 Feature 态：${String(expectedFrom)} → ${String(to)}`,
      );
    }
    const changes = conditionalStateUpdate(this.db, {
      table: "features",
      keyColumn: "feature_id",
      key: featureId,
      expectedState: expectedFrom,
      nextState: to,
      assignments: ["updated_at = ?"],
      assignmentParams: [nowIso()],
    });
    return changes > 0;
  }

  /**
   * 更新 Feature 态；Feature 不存在时无效果，返回 null。
   * v0.4.0：状态发生变化时自动写 `feature.state` 事件。
   * v0.4.1：写入改为 CAS（`WHERE state = <读到的原态>`），并发被抢先时不覆盖、不重复写事件。
   */
  updateFeatureState(featureId: string, state: FeatureState): FeatureRecord | null {
    if (!isFeatureState(state)) {
      throw new Error(`[session-store] updateFeatureState 非法 Feature 态：${String(state)}`);
    }
    const previous = this.getFeature(featureId);
    if (previous === null) return null;
    const changed = this.compareAndSwapFeatureState(featureId, previous.state, state);
    const stored = this.getFeature(featureId);
    if (changed && stored !== null && previous.state !== stored.state) {
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

  /** 列出 Feature（updated_at 倒序；可选状态 / 归属组过滤；limit 默认 100，clamp 到 [1,1000]） */
  listFeatures(opts: ListFeaturesOptions = {}): FeatureRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.state !== undefined) {
      clauses.push("state = ?");
      params.push(opts.state);
    }
    // v0.8.6 §2.3 归属过滤：给定组名 ⇒ `owner_group = ?`（NULL 无归属行被排除 = fail-closed）；
    // 缺省 ⇒ 不加此谓词（未配组环境匿名入口 / web 运维视图全量）。
    if (opts.ownerGroup !== undefined) {
      clauses.push("owner_group = ?");
      params.push(opts.ownerGroup);
    }
    params.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")} ` : "";
    const rows = this.db
      .prepare(
        `SELECT ${FEATURE_COLUMNS}
         FROM features ${where}ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    // v0.6.1 REQ-05 §2.5 白捡（C12）：触顶 ⇒ 事件 + 日志各一条（total 校验）
    const stateFilter = opts.state;
    const ownerFilter = opts.ownerGroup;
    this.warnIfListTruncated(
      `listFeatures:${stateFilter ?? "*"}:${ownerFilter ?? "*"}:${limit}`,
      "listFeatures",
      null,
      rows.length,
      limit,
      () => {
        const countClauses: string[] = [];
        const countParams: Array<string | number> = [];
        if (stateFilter !== undefined) {
          countClauses.push("state = ?");
          countParams.push(stateFilter);
        }
        if (ownerFilter !== undefined) {
          countClauses.push("owner_group = ?");
          countParams.push(ownerFilter);
        }
        const countWhere = countClauses.length > 0 ? `WHERE ${countClauses.join(" AND ")}` : "";
        const row = this.db
          .prepare(`SELECT COUNT(*) AS n FROM features ${countWhere}`)
          .get(...countParams) as Record<string, unknown> | undefined;
        return Number(row?.["n"] ?? 0);
      },
    );
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

  /**
   * 按游标列出事件（`event_id > since`，升序；limit 默认 100，clamp 到 [1,1000]）。
   * `opts.scope` 给定 ⇒ 按**案 B 谓词**过滤组可见性（缺省 = 不过滤，全量）。
   */
  listEvents(opts: ListEventsOptions = {}): EventRecord[] {
    const since = Math.max(opts.since ?? 0, 0);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const visibility = eventVisibilityPredicate(opts.scope);
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE event_id > ?${visibility.clause}` +
          ` ORDER BY event_id ASC LIMIT ?`,
      )
      .all(since, ...visibility.params, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  /**
   * 当前最大事件 id（空表 / **过滤后无可视事件**返回 0）；用于游标回落。
   * `scope` 必须与同一次读口的 `listEvents` 同一谓词（否则「有新事件」判定会被他组事件
   * 误触发 ⇒ `a2a_wait` 空转，§1.3 R-2 / §2.4(b)）。
   */
  latestEventId(scope?: EventVisibilityScope | null): number {
    const visibility = eventVisibilityPredicate(scope);
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(event_id), 0) AS max_id FROM events WHERE 1=1${visibility.clause}`,
      )
      .get(...visibility.params) as Record<string, unknown> | undefined;
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

/** 原子任务态流转（默认存储） */
export function compareAndSwapTaskState(
  taskId: string,
  expectedFrom: TaskState,
  to: TaskState,
  artifactsJson?: string | null,
  text?: string | null,
): boolean {
  return getDefaultStore().compareAndSwapTaskState(taskId, expectedFrom, to, artifactsJson, text);
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

/** 项目忙集合：存在在飞节点（`working ∧ remote_task_id IS NOT NULL`）的 projectId（默认存储） */
export function listBusyProjectIds(): Set<string> {
  return getDefaultStore().listBusyProjectIds();
}

/** C11 派发占位：A2A send 前写入「已发出」事实（默认存储） */
export function markTaskDispatchStarted(taskId: string): TaskRecord | null {
  return getDefaultStore().markTaskDispatchStarted(taskId);
}

/** Feature 节点派发落库：回填远端 id（默认存储） */
export function markTaskDispatched(taskId: string, remoteTaskId: string): TaskRecord | null {
  return getDefaultStore().markTaskDispatched(taskId, remoteTaskId);
}

/** needs_input 恢复：重排任务节点（默认存储） */
export function rearmTask(taskId: string, dispatchMessage: string): TaskRecord | null {
  return getDefaultStore().rearmTask(taskId, dispatchMessage);
}

/** 条件重试：仅当节点当前为 failed 时重排（默认存储）；返回是否命中 */
export function rearmForRetry(taskId: string, dispatchMessage: string): boolean {
  return getDefaultStore().rearmForRetry(taskId, dispatchMessage);
}

/** 写入 / 刷新 Runner 注册行（默认存储） */
export function upsertRunner(rec: RunnerUpsertInput): RunnerRecord {
  return getDefaultStore().upsertRunner(rec);
}

/** 刷新 Runner 心跳（默认存储） */
export function touchRunnerHeartbeat(runnerId: string, at?: string): RunnerRecord | null {
  return getDefaultStore().touchRunnerHeartbeat(runnerId, at);
}

/** 全量替换 Runner 项目投影（默认存储） */
export function runnerProjectsReplace(
  runnerId: string,
  projects: readonly RunnerProjectInput[],
): RunnerProjectRecord[] {
  return getDefaultStore().runnerProjectsReplace(runnerId, projects);
}

/** 查询 Runner 项目投影（默认存储；v0.7.0 A3 claim 前「任务归属该机器」判据读口） */
export function listRunnerProjects(runnerId: string): RunnerProjectRecord[] {
  return getDefaultStore().listRunnerProjects(runnerId);
}

/** 列出全部 Runner 注册行（默认存储；v0.7.0 A7 心跳超期扫描读口） */
export function listRunners(): RunnerRecord[] {
  return getDefaultStore().listRunners();
}

/** 按 machineId 读 Runner 注册行（默认存储；v0.7.0 A7 离线→回线先前态读口） */
export function getRunner(machineId: string): RunnerRecord | null {
  return getDefaultStore().getRunner(machineId);
}

/** 列出某领取者名下在飞队列任务（默认存储；v0.7.0 A7 清算遍历读口） */
export function listClaimedTasks(claimedBy: string): QueuedTaskRecord[] {
  return getDefaultStore().listClaimedTasks(claimedBy);
}

/** 标记 Runner 离线（默认存储；v0.7.0 A7 心跳超期降级口） */
export function markRunnerOffline(runnerId: string): RunnerRecord | null {
  return getDefaultStore().markRunnerOffline(runnerId);
}

/** 任务入队（默认存储） */
export function enqueueTask(taskId: string): QueuedTaskRecord | null {
  return getDefaultStore().enqueueTask(taskId);
}

/** 领取任务（claim CAS；默认存储） */
export function claimTask(opts: ClaimTaskOptions): QueuedTaskRecord | null {
  return getDefaultStore().claimTask(opts);
}

/** 查询队列视角任务记录（默认存储；v0.7.0 A3 `/runner/result` claim_token 校验读口） */
export function getQueuedTask(taskId: string): QueuedTaskRecord | null {
  return getDefaultStore().getQueuedTask(taskId);
}

/** 清算悬挂领取：claimed/running → queued（默认存储）；返回是否命中 */
export function requeueStaleTask(taskId: string, expectedClaimedBy?: string): boolean {
  return getDefaultStore().requeueStaleTask(taskId, expectedClaimedBy);
}

/** 结果回传幂等落库（默认存储） */
export function upsertTaskResult(rec: TaskResultUpsertInput): QueuedTaskRecord {
  return getDefaultStore().upsertTaskResult(rec);
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

/** 原子 Feature 态流转（默认存储） */
export function compareAndSwapFeatureState(
  featureId: string,
  expectedFrom: FeatureState,
  to: FeatureState,
): boolean {
  return getDefaultStore().compareAndSwapFeatureState(featureId, expectedFrom, to);
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

/** 按游标列出事件（默认存储；`opts.scope` = 案 B 组可见性过滤） */
export function listEvents(opts?: ListEventsOptions): EventRecord[] {
  return getDefaultStore().listEvents(opts);
}

/** 当前最大事件 id（默认存储；`scope` 给定 ⇒ 仅计本组可见事件） */
export function latestEventId(scope?: EventVisibilityScope | null): number {
  return getDefaultStore().latestEventId(scope);
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
