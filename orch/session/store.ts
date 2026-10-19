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
  FeatureApproval,
  FeatureCreateInput,
  FeatureRecord,
  FeatureStage,
  FeatureState,
  InputArtifactRef,
  RiskLevel,
  SessionRecord,
  TaskLane,
  TaskMode,
  TaskRecord,
  TaskState,
  TaskType,
  VersionLedgerStatus,
} from "../types.js";
import {
  AGENT_KINDS,
  DEFAULT_FEATURE_APPROVAL,
  DEFAULT_FEATURE_STAGE,
  FAILURE_KINDS,
  FEATURE_APPROVALS,
  FEATURE_STAGES,
  isFeatureApproval,
  isFeatureStage,
  isVersionLedgerStatus,
  ORPHAN_FAILURE_KIND,
  TASK_LANES,
  TASK_MODES,
  TASK_TYPES,
} from "../types.js";

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

/**
 * 失败分类清单 = `types.ts` 的 `FAILURE_KINDS`（**六类闭集**，事实源 `PROTOCOL.md` 2.3 条文；
 * v0.8.8 O1 起**不在此另立清单**）。落库值只能是这六者；旧二分 `infra` / `task` 与任何脏值
 * 在**读侧**按 `readFailureKind` 兜底，不再抛错。
 */

/** 事件 kind：任务结算（completed / failed / input-required） */
export const EVENT_TASK_SETTLED = "task.settled";
/** 事件 kind：任务被失败传播阻塞（blocked） */
export const EVENT_TASK_BLOCKED = "task.blocked";
/**
 * 事件 kind：machine 侧**续跑**留痕（v0.8.8 O3 · 改造文档 §2.2）。
 *
 * **派生事件**（非状态流转）：命名对齐 `task.claimed` / `task.settled`，**仅当本次结果回传的
 * `diagnostics.continueAttempts > 0` 时**由 {@link SessionStore.upsertTaskResult} 在既有结果写口
 * 顺带发出 —— 不新增端点、不新增写口。续跑**不动 `retry_count`**（正交双口径），事件面是它
 * 唯一的可查痕迹。
 */
export const EVENT_TASK_CONTINUED = "task.continued";
/** 事件 kind：Feature 状态流转 */
export const EVENT_FEATURE_STATE = "feature.state";
/**
 * 事件 kind：Feature **登记字段**变更（v0.9.0 B3″）—— `stage` / `version` / `approval` 三字段。
 *
 * - **只在值真变化时发**：同值重复写（宿主重复 `advance` 带同一 `stage`、`NULL` 归一后与目标值
 *   相等的存量行）⇒ **零事件**（否则看板与宿主的登记流水会被无害重写灌满）；
 * - 三字段**任一**变化即一条，`payload.fields` 逐项给 `{ from, to }`（同单多字段变更**不拆条** ——
 *   一次 `advance` 是一次事实）；
 * - **零 DDL**：`events.kind` 是既有自由文本列；`state` 列在此留 `NULL`（本事件不承载引擎态）；
 * - 归属：`feature_id` 必填 ⇒ 案 B 谓词经 `features.owner_group` 反查即可见，他组不可见。
 */
export const EVENT_FEATURE_STAGE = "feature.stage";
/**
 * 事件 kind：**版本台账建行**（v0.10.0 O1/O2a · 改造文档 §2.1(1)(2)）。
 *
 * 由 {@link SessionStore.versionLedgerCreate} 在 INSERT 同事务后发出；`feature_id` / `task_id`
 * 均 `NULL`（版本台账不属于任何 Feature）⇒ 按案 B 归属谓词只有**未限定作用域**的读面可见，
 * 与 `store.list_truncated` 同一处置口径（运维留痕，不进板上清单）。
 */
export const EVENT_VERSION_LEDGER_CREATED = "version.ledger_created";
/** 事件 kind：**版本台账删行**（v0.10.0 O2a；与 `DELETE /api/versions/{version}` 一对一） */
export const EVENT_VERSION_LEDGER_DELETED = "version.ledger_deleted";
/**
 * 事件 kind：**版本自动转 `active`**（v0.10.0 O2c · 改造文档 §2.1(2)）—— 由
 * {@link SessionStore.versionLedgerActivate} 在「`versions.status` 由 `notstart` 迁 `active`」的
 * **同一事务内**发出（`feature_id` / `task_id` 均 `NULL`：版本台账不属任何 Feature）。
 *
 * 触发方 = **引擎内部**（门① 的 `stage` 登记写 / `approve` 放行 / 首个节点派发；`payload.trigger`
 * 记哪一处，见 {@link VersionActivationTrigger}），**不开放板写口** —— 板只读结果。
 * `payload.from = "notstart"` / `payload.to = "active"`；幂等（非 `notstart` ⇒ 零写入、零事件）。
 */
export const EVENT_VERSION_ACTIVATED = "version.activated";
/**
 * 事件 kind：**版本手动设状态**（v0.10.0 O2c）—— 由
 * {@link SessionStore.versionLedgerSetStatus} 在非发版状态间改 `status` 时发出
 * （`notstart ↔ active` 的人工写口；发版仍走 {@link EVENT_VERSION_RELEASED}）。
 * 同值重写（幂等）**零事件**；`released` 为终态，本事件**永不出现在 `from = released`** 的迁移里。
 */
export const EVENT_VERSION_STATUS_CHANGED = "version.status_changed";
/**
 * 事件 kind：**版本发版**（v0.10.0 O7 · 改造文档 §2.1(1)）—— 由
 * {@link SessionStore.versionLedgerMarkReleased} 在「`versions.status` 迁 `released` +
 * `releases` 落快照 + **级联 project 版本置 `released`**（v0.10.1 C-4）」的**同一事务内**发出
 * ⇒ 事件与各笔写同时成立或同时不成立。
 *
 * `payload.backfilled = true` ⇒ 台账行原本已是 `released`、本次只补写缺失的快照
 * （迁移主源导入的历史 `released` 行无快照，见 `需求流程.md` §8 标记 `released` 条），
 * 读账时据此区分「发版那一刻」与「事后补登」。
 *
 * `payload.projectVersionsTargeted` / `projectVersionsReleased`（v0.10.1 O4，只增键）= 级联的
 * 「触达集大小」与「本次真的迁入 `released` 的行数」⇒ 后者为 0 可能是「本就都 `released`」，
 * 不是失败。
 */
export const EVENT_VERSION_RELEASED = "version.released";
/**
 * 事件 kind：**迁移哨兵**（v0.10.0 O1 · 改造文档 §2.1(7)）。
 *
 * 一次性迁移脚本（`scripts/migrate-versions-ledger.mjs`）在 `--apply` 成功后落**一条**，
 * 作为「本库已迁移」的判据 —— **不复用 `exists()`**（台账里有行 ≠ 迁移跑过：建单端点同样会
 * 造出行，拿台账判据会把「手工建单」误当成「已导入板台账」而漏掉未导入的行）。
 * 迁移判据 = 哨兵行存在 ⇒ 跳过；不存在 ⇒ 执行。幂等由「哨兵 + `INSERT` 走 get-then-insert」两重兜住。
 *
 * 哨兵的**读写都在脚本内**（离线一次性工具，直接开 SQLite）；本常量存在的意义 =
 * **把 kind 字面量钉在引擎侧单一事实源**，脚本与任何后续读面对齐同一串，不各写各的。
 */
export const EVENT_VERSION_LEDGER_MIGRATED = "version.ledger_migrated";
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
  /** 领取者标识（落 `tasks.claimed_by`；未领取为 null；v0.8.7 O4 起清算后**保留**——补结算窄口的行级绑定凭据） */
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
  /** 所属仓库标识（可空 = 老桥未上报 / 缺省宿主仓，由引擎解释层承担） */
  repo?: string | null;
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
  /** 所属仓库标识（可空 = 未上报） */
  repo: string | null;
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
  /**
   * machine 回传体 `diagnostics` 的**宽 JSON 原文**（v0.8.8 O3 · §2.5 落库口径）：
   * 由 {@link SessionStore.upsertTaskResult} 序列化后落 `tasks.diagnostics_json`，
   * 并据其 `continueAttempts` 派生 `task.continued` 事件。**不落派生布尔、不丢原料**。
   */
  diagnostics?: unknown;
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
  /**
   * Feature 排队节点**未渲染 base**（v0.3.0；缺省 null）——v0.8.9 O2 起派发渲染结果
   * 只落 `dispatchRendered`，本字段恒干净、可原样重放。
   */
  dispatchMessage?: string | null;
  /**
   * 本次派发的渲染快照（v0.8.9 O1，落 `tasks.dispatch_rendered`；缺省 null）。
   * 写口在 O2 接入（`dispatchFeatureNode` 只写本字段、不回写 `dispatchMessage`）。
   */
  dispatchRendered?: string | null;
  /**
   * **并发档**（v0.8.10 O-N1，落 `tasks.lane`；缺省 `undefined` = 落库 NULL ⇒ 读侧按 `write` 解释）。
   *
   * ⚠️ **ON CONFLICT 走 `COALESCE(excluded.lane, lane)`**（保留首次声明）：本字段**缺省不是 `write`
   * 而是 NULL**，正是为了「**不带档的重登记不会把 read 降成 write**」——若缺省直接写 `'write'`，
   * 任何一次未带 `lane` 的 upsert（重派 / 补登记）都会静默改档。要显式改档必须**显式传值**。
   */
  lane?: TaskLane | null;
  /**
   * **职责位**（v0.10.2 O-1，落 `tasks.task_type`；缺省 `undefined` = 落库 NULL ⇒ 读侧按 `unit_agent`
   * 解释 = 本字段引入前的唯一行为）。
   *
   * ⚠️ **ON CONFLICT 走 `COALESCE(excluded.task_type, task_type)`**（保留首次声明）：与 `lane` 同一条
   * 理由 —— 本字段**缺省不是 `unit_agent` 而是 NULL**，正是为了「**不带职责位的重登记不会把
   * `dev_manager` 降成 `unit_agent`**」（重派 / 补登记都走同一条 upsert）。要显式改档必须**显式传值**。
   */
  taskType?: TaskType | null;
  /**
   * **执行通道**（v0.10.8 O-4 · orch-N1，落 `tasks.mode`；缺省 `undefined` = 落库 NULL ⇒ 读侧按
   * `dag` 解释 = 本字段引入前的唯一行为）。
   *
   * ⚠️ **ON CONFLICT 走 `COALESCE(excluded.mode, mode)`**（保留首次声明）：与 `lane`/`task_type`
   * 同一条理由 —— 不带通道的重登记不得把 `inquiry` 压成 `dag`（反之亦然）。
   */
  mode?: TaskMode | null;
  /**
   * **派发当刻阶段快照**（v0.10.8 O-9 · orch-N2，落 `tasks.stage`；缺省 `undefined` = 落库 NULL
   * ⇒ 读侧照实读出 `null`，**无缺省档可归**，与 `mode` 相反）。
   *
   * ⚠️ **ON CONFLICT 走 `COALESCE(excluded.stage, stage)`**（改造文档 §2.2 O-9 硬细节：
   * **快照只认首次，重派不得改写**）：与 `lane`/`task_type`/`mode` 同一条纪律 —— 缺省不是任何
   * 阶段而是 NULL，正是为了「不带快照的重登记不会把已摄快照覆盖掉」。要显式改值必须**显式传值**。
   */
  stage?: FeatureStage | null;
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

/** `listFeatures` 入参：可选状态 / 版号 / 条数上限 / 归属组过滤 */
export interface ListFeaturesOptions {
  state?: FeatureState;
  limit?: number;
  /**
   * 归属组过滤（v0.8.6 §2.3）：给定组名 ⇒ 仅返回 `owner_group = ownerGroup` 的 Feature
   * （**NULL 无归属行天然被排除** = 已配组环境 fail-closed）；缺省（`undefined`）⇒ 全量
   * （未配组环境的匿名入口 / web 运维视图）。
   */
  ownerGroup?: string;
  /**
   * 版号过滤（v0.10.0 O5b）：与 {@link SessionStore.aggregateFeaturesByVersion} 的**未登记桶口径同源**
   * （{@link featureVersionCondition} 单点承载，`listFeatures` 的 WHERE / 参数 / 去重键三处共用）。
   *
   * - **非空串** ⇒ 精确匹配该版号（trim 归一，与写口 `bridge/feature-tools.ts` 的
   *   `parseRegistration` 同口径）；
   * - **空串 / 纯空白** ⇒ 只返**未登记**卡（`version IS NULL OR version = ''`，含存量 NULL 行）；
   * - **`undefined`** ⇒ 不筛版号（全量）。
   */
  version?: string;
}

/**
 * `aggregateFeaturesByVersion` 出参：单张需求卡（渲染层收窄视图，**不带 `requirement`/`plan`/
 * `decisions` 长文本** —— 聚合面面向「列出版 + 计数」，全文归 `listFeatures` / `feature_status`）。
 */
export interface VersionFeatureCard {
  featureId: string;
  state: FeatureState;
  title: string;
  stage: FeatureStage;
  approval: FeatureApproval;
  parentFeatureId: string | null;
  updatedAt: string;
}

/** 版号名下单桶：三桶计数 + 名下需求卡清单（`version = null` ⇒ 未登记版号桶） */
export interface VersionFeaturesBucket {
  /** 版号；`null` = 未登记桶（`features.version` 为 NULL / 空串） */
  version: string | null;
  counts: { total: number; completed: number; cancelled: number; open: number };
  features: VersionFeatureCard[];
}

/** 版本名下卡聚合读面全量（v0.10.0 O3；见 {@link SessionStore.aggregateFeaturesByVersion}） */
export interface VersionCardAggregate {
  /** 每版号一桶：已登记版号字典序在前，未登记桶（`version=null`）恒最后 */
  buckets: VersionFeaturesBucket[];
  /** 已登记版号全集（升序，不含未登记哨兵）= 板 §2.3「卡派生版号」并集的左料 */
  versions: string[];
  /** 未登记（无版号）卡张数（不静默丢；`0` = 无未登记卡） */
  unregisteredCount: number;
}

/**
 * 版本台账三态（v0.10.0 O1 · 改造文档 §2.1(1)）—— **清单与收窄判据的事实源在 `types.ts`**
 * （`VERSION_LEDGER_STATUSES` / `VersionLedgerStatus` / `isVersionLedgerStatus`，O4 已落），
 * 本表只引用、**不另立第二份清单**（防两处漂移）。语义：
 *
 * - `notstart` —— 台账有此行、尚无节点派发；
 * - `active` —— 已有派发 / 过审（`notstart → active` 的自动转换归 O2c，板无写口）；
 * - `released` —— **终态、不可回退**（写入经 O4 发版闸 + O7 同事务快照）。
 */

/**
 * 版号 **semver 形状**（v0.10.0 O1 起为台账侧权威判据；与 O5 在 `bridge/feature-tools.ts` 内的
 * 私有副本 `VERSION_SHAPE_RE` 逐字同形）：**可选 `v` 前缀** + `X.Y.Z` 三段（不做前导零宽松）
 * + 可选 `-prerelease` + 可选 `+build`。
 *
 * ⚠ 两份副本并存 = 判据漂移风险，收敛项已随本节点回执登记（本节点不改 O5 文件）。
 */
const VERSION_SHAPE_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isVersionShapeValid(version: string): boolean {
  return VERSION_SHAPE_RE.test(version);
}

/** 版本台账行（`versions` 表；**可编辑** —— 排期锁与 `released` 锁的事实源） */
export interface VersionLedgerRecord {
  /** 归属组 = `projectGroup` 组名；`null` = 无归属（未配组的匿名档，与 `features.owner_group` 同口径） */
  ownerGroup: string | null;
  version: string;
  status: VersionLedgerStatus;
  /** 发版日期（自由文本，板侧展示用；引擎不解析、不参与判定） */
  date: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `releases.projects_json` 单项（**原值入快照、不归一**，改造文档 §2.1(6)） */
export interface ReleaseSnapshotProject {
  /**
   * 发版意图带入的 project 标识（v0.10.1 O4 · C-5）。**缺省即不写键** —— 历史旧形状行
   * （`{repoId, ref}`）读回时不得多出 `projectId: null`，否则既有快照的可读形状被改写。
   */
  projectId?: string | null;
  /** 该 project 本次发版的 Project Version（同上：缺省即不写键，不回填） */
  version?: string | null;
  repoId: string | null;
  ref: string | null;
}

/**
 * 发版快照行（`releases` 表；**不可变**）。表与类型由 O1 落，**写入路径 = O7**
 * （标记 `released` 时与 `versions.status` 同事务，见 {@link SessionStore.versionLedgerMarkReleased}）。
 */
export interface ReleaseSnapshotRecord {
  ownerGroup: string | null;
  version: string;
  changelogAnchor: string | null;
  projects: ReleaseSnapshotProject[];
  note: string | null;
  createdAt: string;
}

/**
 * 标记 `released` 的快照入参（v0.10.0 O7 · 改造文档 §2.1(1)(6)）。
 *
 * **全部字段取调用方原值、引擎不归一**（§2.1(6)）：
 * - `projects[].repoId` —— 由**发版动作**（板/宿主的发版意图）带入，引擎**不回查 `runner_projects`
 *   投影表**：该表每次上报**全量替换**（{@link SessionStore.runnerProjectsReplace}），机未上报即空 ⇒
 *   拿它当快照数据源会把「上报缺位」写成「该版无仓库」，是**假事实**；
 * - `projects[].ref` —— 发版动作产生的 commit / tag（引擎不解析、不校验形状，同 §2.1(6) 口径）；
 * - `changelogAnchor` —— CHANGELOG 锚点（同上：引擎不解析文档）。
 *
 * `projects[].projectId` / `projects[].version`（v0.10.1 O4 · C-5）= 快照项的**新增可选键**
 * （四元形状 `{projectId, version, repoId, ref}`）—— 同样**只取发版动作带入的原值**，引擎
 * **不从归属表 / `project_versions` 反查填充**（级联写的是台账，快照承载的是发版意图的原样）。
 * **缺省即不写该键**（不写 `null`）⇒ 历史旧形状 `{repoId, ref}` 行读写两端形状一致、不回填。
 *
 * `projects` 缺省 = 空数组（单仓未配 `repo` 的现状 ⇒ 快照仍落行，`projects_json = "[]"`，
 * 与「非 released 阶段无快照行」的判据不冲突）。
 */
export interface ReleaseSnapshotInput {
  /** 归属组 = 台账键的一部分；`null` = 匿名档 */
  ownerGroup: string | null;
  version: string;
  changelogAnchor?: string | null;
  projects?: ReleaseSnapshotProject[];
  note?: string | null;
}

/**
 * 快照写口出参（v0.10.0 O7）—— 两个布尔把「幂等」拆成可读的两半，供 HTTP 面 / 回执留痕：
 * - `statusMigrated` = 本次**真的**把台账 `status` 迁入 `released`（`false` = 原本已 `released`）；
 * - `snapshotWritten` = 本次**真的**落了快照行（`false` = 快照已存在 ⇒ 不可变，不覆写）。
 *   两者同 `false` ⇒ 纯幂等读回，零写入、零事件。
 */
export type ReleaseSnapshotWriteResult =
  | {
      ok: true;
      snapshot: ReleaseSnapshotRecord;
      ledger: VersionLedgerRecord;
      statusMigrated: boolean;
      snapshotWritten: boolean;
    }
  | { ok: false; code: string; message: string; status: number };

/** `versionLedgerCreate` 入参（`ownerGroup` 必填语义：`null` = 匿名档，不是「未提供」） */
export interface VersionLedgerCreateInput {
  ownerGroup: string | null;
  version: string;
  /** 缺省 `notstart`；**不接受 `released`**（发版只能经 O2c 的设状态端点 + O4 闸） */
  status?: VersionLedgerStatus;
  date?: string | null;
  note?: string | null;
}

/**
 * `versionLedgerSetStatus` 入参（v0.10.0 O2c）—— `PATCH /api/versions/{version}/status` 的**手动**写口。
 *
 * 只承载 `notstart ↔ active` 的人工改态；**`released` 不经此口**（发版必须走
 * {@link SessionStore.versionLedgerMarkReleased} 的闸 + 快照同事务）。
 */
export interface VersionLedgerSetStatusInput {
  ownerGroup: string | null;
  version: string;
  status: VersionLedgerStatus;
  note?: string | null;
}

/**
 * 版本自动转 `active` 的**触发点**（v0.10.7 n3 · 改造文档 §2.1 n3）—— 闭集三值，进
 * {@link EVENT_VERSION_ACTIVATED} 的 `payload.trigger`：
 * - `gate1` = 门①（需求确认）的 `stage` 登记写落库成功（**首触发点**，v0.10.7 起）；
 * - `approve` = 门② 放行；
 * - `dispatch` = 首个节点派发。
 *
 * 后两者自 v0.10.7 起**降级为幂等兜底**（`gate1` 已先把版号抬起 ⇒ 到它们时恒 `activated = false`）。
 * 三处都不判 `active` 作执法依据（`active` 只是观测面读数）。
 */
export type VersionActivationTrigger = "gate1" | "approve" | "dispatch";

/**
 * `versionLedgerActivate` 出参（v0.10.0 O2c）—— 三护栏的**幂等**判据面：
 * - `activated = true` ⇒ 本次真的把 `notstart` 迁成 `active`（且发了一条 {@link EVENT_VERSION_ACTIVATED}）；
 * - `activated = false` ⇒ 无需动作（非 `notstart` / 行不存在 / 台账未就绪）。
 */
export interface VersionActivationResult {
  /** 本次是否真的完成 `notstart → active`（幂等：重复触发恒为 `false`）。 */
  activated: boolean;
  /** 事务后该行 `status`（行不存在 / 台账未就绪 ⇒ `null`）。 */
  status: VersionLedgerStatus | null;
  /** 台账是否就绪（`false` = O1 `versions` 表未落地 ⇒ 过渡态，调用方应静默跳过）。 */
  ledgerReady: boolean;
}

/**
 * 台账写口出参（HTTP 面据此直接映射状态码与信封，见 `bridge/versions-endpoints.ts`）：
 * 失败分支的 `code` 是 **`orch_*` 闭集**（板按错误码显示映射表呈现，未知码原样展示）。
 */
export type VersionLedgerWriteResult =
  | { ok: true; record: VersionLedgerRecord }
  | { ok: false; code: string; message: string; status: number };

/** 版号名下卡的收口计数（`DELETE` 判据用；三桶口径与 O3 聚合面逐字一致） */
export interface VersionCardCounts {
  total: number;
  completed: number;
  cancelled: number;
  /** 未收口 = 其余全部态（含 `failed` —— `failed` 不算收口，见 `需求流程.md` §8） */
  open: number;
}

/**
 * 删版分档用的单张卡账面（v0.10.7 n1 · 改造文档 §2.1 n1）。
 *
 * `state` 取**列原值**（不收窄成 `FeatureState`、不 fail-fast）—— 态闭集外的脏值不得让
 * 分档抛出去，也不得静默消失在四桶之外；它按「非 `completed` / `cancelled`」落入未收口两桶。
 * `stage` / `approval` 走既有读侧归一（NULL / 脏值 ⇒ 缺省），缺省值恒不等于「需求分析 / 未发起」
 * ⇒ 归一本身即 fail-closed，与 §2.0 伪码「任一字段 null ⇒ 不满足」同侧。
 */
export interface VersionDeleteCard {
  featureId: string;
  state: string;
  stage: FeatureStage;
  approval: FeatureApproval;
  decisions: string | null;
}

/**
 * 删版分档出参（v0.10.7 n1）—— 四桶**互斥且并集 = 名下全部卡**，故
 * `total = 四桶长度之和`（不得相加当两批卡：`clearPool ⊆ 清卡集`、`blockedOpen ⊆ 挡删集`）。
 *
 * - **挡删集** = `blockedCompleted` ∪ `blockedOpen`（任一非空 ⇒ 拒删）；
 * - **清卡集** = `clearPool` ∪ `clearCancelled`（删版事务内逐卡清 `version`）。
 */
export interface VersionDeleteClassification {
  /** 挡删 B-3：`state === "completed"`（清其 version 会断交付账） */
  blockedCompleted: VersionDeleteCard[];
  /** 挡删 B-2：未收口 ∧ ¬可回池档 */
  blockedOpen: VersionDeleteCard[];
  /** 清卡 B-4 乙档：未收口 ∧ 可回池档 ⇒ 退回需求池 */
  clearPool: VersionDeleteCard[];
  /** 清卡 B-4 甲档：`state === "cancelled"` ⇒ 随本版清除版本归属 */
  clearCancelled: VersionDeleteCard[];
}

/**
 * **project 台账两态**（v0.10.1 O1 · 改造文档 §2.2）—— 闭集**本文件自持**，不进 `types.ts`：
 * 组档三态（`VERSION_LEDGER_STATUSES`）是 v0.10.0 已冻结的面，而本态**不进** `notstart → active`
 * 自动转换、也**不动** `versions-activation` 节流键（§2.2 硬约束），两者不是同一套值域。
 *
 * - `open` —— 建版即此态，也是**唯一可建态**；
 * - `released` —— 只能由 **Group 级发版动作在同事务内级联置入**（C-4，写入归后续节点）；
 *   一经置入即冻结、不得复用为后续归属目标（C-6 ④）。
 */
export const PROJECT_VERSION_STATUSES = ["open", "released"] as const;
export type ProjectVersionStatus = (typeof PROJECT_VERSION_STATUSES)[number];
export function isProjectVersionStatus(value: unknown): value is ProjectVersionStatus {
  return (
    typeof value === "string" &&
    (PROJECT_VERSION_STATUSES as readonly string[]).includes(value)
  );
}

/** project 台账行（`project_versions` 表；**可编辑**，`released` 由 Group 级联置入） */
export interface ProjectVersionRecord {
  /** 归属组 = `projectGroup` 组名；`null` = 匿名档（与 `versions.owner_group` / `features.owner_group` 同口径） */
  ownerGroup: string | null;
  projectId: string;
  /** Project Version（**不要求**与 Group Version 一致，C-1） */
  version: string;
  status: ProjectVersionStatus;
  /** 发版日期（自由文本，板侧展示用；引擎不解析、不参与判定 —— 照组档同口径） */
  date: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * `projectVersionCreate` 入参（v0.10.1 O1）。
 *
 * **没有 `status` 参数**：建版恒 `open` —— `released` 是发版的结果、不是建版参数（组档同一条判据
 * 在这里由**入参形状**直接承载，因此 C-13 闭集不需要 project 档的 `…_status_invalid` 码）。
 */
export interface ProjectVersionCreateInput {
  ownerGroup: string | null;
  projectId: string;
  version: string;
  date?: string | null;
  note?: string | null;
}

/**
 * project 档写口出参（v0.10.1 O1）—— 形状照 {@link VersionLedgerWriteResult}：
 * 失败分支的 `code` 是 `orch_*` 闭集成员，供 HTTP / MCP 面直接映射状态码与信封。
 */
export type ProjectVersionWriteResult =
  | { ok: true; record: ProjectVersionRecord }
  | { ok: false; code: string; message: string; status: number };

/**
 * 归属（承诺集）行（`feature_projects` 表）—— **不进 prune、不随 Feature 终态 / `cancel` 级联删**
 * （C-16；它替代 `tasks.project_id` 承担「需求触达哪些 project」的长期事实源，K-1）。
 */
export interface FeatureProjectRecord {
  ownerGroup: string | null;
  featureId: string;
  projectId: string;
  /** 本需求把该 project 承接进哪个 Project Version */
  projectVersion: string;
  /**
   * 写入时刻的 Group Version 快照（NOT NULL ⇒ **无 Group Version 落不下归属**，C-21）。
   * 与 `features.version` **同单写定、此后不漂移**（派生不变式，不是流程动作）。
   */
  groupVersion: string;
  /** 写入来源（自由文本，供「可改须留痕」对照；引擎不解析、不校验形状，C-3） */
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `featureProjectUpsert` 入参（v0.10.1 O1） */
export interface FeatureProjectUpsertInput {
  ownerGroup: string | null;
  featureId: string;
  projectId: string;
  projectVersion: string;
  groupVersion: string;
  source?: string | null;
}

/**
 * 归属写口出参（v0.10.1 O1）—— 两个布尔把「**重发安全**」拆开（C-3 ★R3：新增执行节点同轮
 * 必须重发**全量**归属 ⇒ 同一行会被反复写）：
 * - `created = true` ⇒ 本次新落一行；
 * - `created = false` ∧ `changed = true` ⇒ 同键改写（承诺集**可改**，C-3）；
 * - `created = false` ∧ `changed = false` ⇒ 同值幂等重发 ⇒ **零写入、不改 `updated_at`**（重发不制造活动痕迹）。
 */
export type FeatureProjectUpsertResult =
  | { ok: true; record: FeatureProjectRecord; created: boolean; changed: boolean }
  | { ok: false; code: string; message: string; status: number };

/**
 * 归属删口出参（v0.10.1 O1）：键不存在 ⇒ `deleted = false` ∧ `record = null` —— **幂等零副作用**
 * （全量重发的差量删除路径会删到不存在的行，不得当作错误）。
 */
export interface FeatureProjectDeleteResult {
  deleted: boolean;
  record: FeatureProjectRecord | null;
}

/**
 * **project 档收口计数**（v0.10.1 O2 · 改造文档 C-4）—— 三桶口径与 {@link VersionCardCounts}
 * **逐字一致**（`open` 含 `failed`），但**身份不同级**：Group 计数由 `features.version` 派生、
 * 本计数由归属表派生，是同一批卡的两张正交投影 ⇒ **不得横向相加、不得相等校验、不得互校**（C-4 ★R2）。
 * 故**不复用** {@link VersionCardCounts} 这一类型名，避免「同一个类型 ⇒ 可以互相比较」的误读。
 */
export interface ProjectVersionCardCounts {
  total: number;
  completed: number;
  cancelled: number;
  /** 未收口 = 其余全部态（含 `failed` 与主链中间态） */
  open: number;
}

/**
 * `versions` 表的**列清单单一串**（读口共用；SELECT 列序 = {@link rowToVersionLedger} 的取值键序）。
 * 抽成常量：新增列时只需改 DDL + 这一串，避免各读口 SQL 分散漏改。
 */
const VERSION_LEDGER_COLUMNS =
  "owner_group, version, status, date, note, created_at, updated_at";

/**
 * `releases` 表的**列清单单一串**（v0.10.0 O7；同 {@link VERSION_LEDGER_COLUMNS} 的抽常理由）。
 * 无 `updated_at` —— 快照不可变，列面本身就不提供改写目标。
 */
const RELEASE_COLUMNS =
  "owner_group, version, changelog_anchor, projects_json, note, created_at";

/**
 * `project_versions` 表的**列清单单一串**（v0.10.1 O1；同 {@link VERSION_LEDGER_COLUMNS} 的抽常理由）。
 * 列序 = {@link rowToProjectVersion} 的取值键序。
 */
const PROJECT_VERSION_COLUMNS =
  "owner_group, project_id, version, status, date, note, created_at, updated_at";

/** `feature_projects` 表的**列清单单一串**（v0.10.1 O1；同上）。 */
const FEATURE_PROJECT_COLUMNS =
  "owner_group, feature_id, project_id, project_version, group_version, source, created_at, updated_at";

/**
 * 版本台账写口的 **`orch_*` 错误码闭集**（v0.10.0 O2a）。
 *
 * 命名沿用既有 `orch_*` 前缀（板按「错误码显示映射表」翻译成人话，**未知码原样展示、不 fail-closed**）。
 * 码值即契约：HTTP 信封 `error.code` 与 MCP 面共用，不得随意改名。
 */
export const ERR_VERSION_SHAPE = "orch_version_invalid_shape";
export const ERR_VERSION_STATUS = "orch_version_status_invalid";
export const ERR_VERSION_EXISTS = "orch_version_exists";
export const ERR_VERSION_UNKNOWN = "orch_version_unknown";
export const ERR_VERSION_RELEASED_LOCKED = "orch_version_released_locked";
export const ERR_VERSION_OPEN_CARDS = "orch_version_open_cards";
/**
 * 发版快照的 `projects` 入参形状非法（v0.10.0 O7）。
 * 校验落**边界**（HTTP / MCP 入参是 JSON，形状不可信），见 `bridge/versions-release.ts`。
 */
export const ERR_RELEASE_PROJECTS = "orch_release_projects_invalid";

/**
 * project 档写口的 **`orch_*` 错误码**（v0.10.1 O1 · 改造文档 C-13 闭集的**数据面子集**）。
 *
 * C-13 的保留码里，本节点只用「建 / 删 / 写 的数据判据」必然要用的这三个；
 * `_released_locked` / `orch_project_attribution_conflict` / `orch_project_attribution_state_locked`
 * 属**门 / 闸**判据（归属写执法、released 门）⇒ 由后续节点落地，本节点**不预定义**（不留无人产的死码）。
 * 码值即契约：HTTP 信封 `error.code` 与 MCP 面共用，**未知码原样展示、不 fail-closed**（板侧口径）。
 */
export const ERR_PROJECT_VERSION_SHAPE = "orch_project_version_invalid_shape";
export const ERR_PROJECT_VERSION_EXISTS = "orch_project_version_exists";
export const ERR_PROJECT_VERSION_UNKNOWN = "orch_project_version_unknown";

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

/**
 * `updateFeatureRegistration` 入参（v0.9.0 B1″ 登记字段**唯一运行期写口**）：
 * 仅提供的字段被更新（undefined = 保留原值）。
 *
 * 类型是**已校验的闭集值**（校验在 handler，见 `bridge/feature-tools.ts`）⇒ 存储层不再复核；
 * `version` 是自由文本（无闭集）。
 */
export interface FeatureRegistrationPatch {
  stage?: FeatureStage;
  version?: string;
  approval?: FeatureApproval;
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

/** `listEvents` 入参：游标与条数上限（+ 可选组可见性范围 / Feature 过滤） */
export interface ListEventsOptions {
  /** 仅返回 `event_id > since` 的事件（缺省 0 = 从头） */
  since?: number;
  limit?: number;
  /** 缺省 / `null` = **不过滤**：未配组环境的匿名入口 / web 运维视图（§2.7） */
  scope?: EventVisibilityScope | null;
  /**
   * **只读过滤**（v0.9.0 B3″）：给定 ⇒ 仅返回该 Feature 的事件。
   *
   * 存在于**board 读面**：看板要看「这条需求的登记流水」，但**不得**借用
   * `a2a_events`（`handleEvents`）—— 那条即便显式传 `since` 也会**推进按身份分的游标**，
   * 会**静默吃掉宿主的事件**。本过滤留在 store 的纯读侧，**不接触任何游标**。
   */
  featureId?: string;
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

function isTaskLane(v: string): v is TaskLane {
  return (TASK_LANES as readonly string[]).includes(v);
}

function isTaskType(v: string): v is TaskType {
  return (TASK_TYPES as readonly string[]).includes(v);
}

function isTaskMode(v: string): v is TaskMode {
  return (TASK_MODES as readonly string[]).includes(v);
}

/**
 * **写档 SQL 片段**（v0.8.10 O-N1；忙集谓词与 `claimTask` 写优先排序**共用同一片段**）。
 *
 * ⚠️ **`lane IS NULL` 必须算写档**（与 `readLane` 的读侧归一同口径）：
 * 存量行经迁移归一后仍可能有 NULL（`upsertTaskResult` 为未知任务建行时不带档、
 * 以及归一语句之后落的老版本写入路径）—— 一旦把 NULL 当只读，等于**静默放宽串行门**；
 * 一旦在排序里漏掉 NULL，**迁移前的存量行整体沉底**（永远领不到）。
 */
const WRITE_LANE_SQL = "(lane IS NULL OR lane = 'write')";

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

/**
 * 解析 `failure_kind` 列（可空）。
 *
 * **v0.8.8 O1：非法值 ⇒ 兜底 + warn，不再 fail-fast**。口径来自改造文档 §2.1「读侧安全」：
 * 二分时代（v0.8.7）写入的 `infra` / `task` 自 2.3 起非法，而存量行由 §2.1 的**迁移脚本**
 * 置 NULL —— 迁移前若桥先启动，读侧撞旧枚举会**每次启动即抛**（`rowToTask` 在列表读路径上，
 * 一处脏值 ⇒ `recover` / trace / feature_status 全停）。故读侧放宽为落安全类 `business`
 * （「不可重试」侧）并 warn 留原值，供事后区分「真 business」与「兜底 business」。
 *
 * ⚠️ 与 `/runner/result` 的**入站**兜底互补、不可互替：那条接住混跑期在途载荷，本条守住存量库行。
 */
function readFailureKind(row: Record<string, unknown>): FailureKind | null {
  const raw = readNullableString(row, "failure_kind");
  if (raw === null) return null;
  return coerceStoredFailureKind(raw);
}

/** 库中原样存着但已不合 2.3 六类闭集的取值 ⇒ 兜底 `business` + warn 留原值（可重入，无副作用） */
function coerceStoredFailureKind(raw: string): FailureKind {
  if (isFailureKind(raw)) return raw;
  console.error(
    `[session-store] 列 failure_kind 非法值（2.3 前旧值 / 脏行）⇒ 兜底落 business（failure_kind_fallback=${raw}），请执行 §2.1 存量迁移`,
  );
  return "business";
}

/**
 * `diagnostics` 宽 JSON 列的**字符上限**（v0.8.8 O3）：机侧请求体上限 1 MiB（`runner.ts` 的
 * `RUNNER_MAX_BODY_BYTES`），而正常 diagnostics 只有数 KB（计量键 + 后端错误 `data` 摘要）⇒
 * 超上限只可能是后端回显了巨量文本。此处**只防无界落库**（每任务一行 × 保留期），
 * 不做「安全截断」—— 截一半会把 JSON 截成非法、派生事件也随之失效，反而更糟。
 */
const DIAGNOSTICS_JSON_MAX_CHARS = 32_000;

/**
 * 把回传体的 `diagnostics` 序列化为**宽 JSON 原文**（v0.8.8 O3 · §2.5 落库口径）。
 *
 * - 非对象 / 缺键 ⇒ NULL（机侧「判不出不报」的既有语义，不猜内容）；
 * - 数组 ⇒ 原样序列化（异常形状也是机侧事实的一部分，读侧自行判断）；
 * - `JSON.stringify` 抛错（入站是 `unknown`，理论上可含循环引用）⇒ 落 NULL，
 *   **不得让一次结果回传因诊断形状而崩掉结算**；
 * - 超上限 ⇒ 整列留 NULL + `console.error` 留痕（异常兜底路径；正常量级永不命中）。
 */
function serializeDiagnostics(diagnostics: unknown): string | null {
  if (typeof diagnostics !== "object" || diagnostics === null) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(diagnostics);
  } catch {
    console.error("[session-store] diagnostics 无法序列化 ⇒ 本列留空（不影响结果落库）");
    return null;
  }
  if (typeof json !== "string") return null;
  if (json.length <= DIAGNOSTICS_JSON_MAX_CHARS) return json;
  console.error(
    `[session-store] diagnostics 超宽（${json.length} > ${DIAGNOSTICS_JSON_MAX_CHARS} 字符）⇒ 本列留空（防无界落库）`,
  );
  return null;
}

/** 读 `diagnostics_json` 列（可空；NULL = 未上报 / 存量老行） */
function readDiagnosticsJson(row: Record<string, unknown>): string | null {
  return readNullableString(row, "diagnostics_json");
}

/** 诊断键的宽容读取：仅「有限非负数」算数值事实，其余（缺键 / 脏值）⇒ 不报该键 */
function diagNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** 诊断键的宽容读取：仅非空字符串算事实（`timeoutScope` / `continueTrigger`） */
function diagString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** 诊断键的宽容读取：仅布尔算事实（`sessionResumed` / `workspaceTouched`） */
function diagBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  return typeof obj[key] === "boolean" ? (obj[key] as boolean) : undefined;
}

/**
 * 从落库的宽 JSON **反查 `continueAttempts`**（派生事件与 `task.settled.continueAttempts` 的
 * 唯一口径源）。列 NULL / JSON 非法 / 键缺失或非有限数 ⇒ `0`（保守：不发续跑事件）。
 */
function readContinueAttempts(diagnosticsJson: string | null): number {
  return readDiagnosticsObject(diagnosticsJson).continueAttempts;
}

/** 宽 JSON 的读侧解析（派生事件用；**只读口径**，不改写原文） */
function readDiagnosticsObject(diagnosticsJson: string | null): {
  continueAttempts: number;
  obj: Record<string, unknown> | null;
} {
  if (diagnosticsJson === null) return { continueAttempts: 0, obj: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(diagnosticsJson);
  } catch {
    return { continueAttempts: 0, obj: null };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { continueAttempts: 0, obj: null };
  }
  const obj = parsed as Record<string, unknown>;
  return { continueAttempts: diagNumber(obj, "continueAttempts") ?? 0, obj };
}

/**
 * `task.continued` 的 payload（改造文档 §2.2 键清单）。**逐键显式读**（§2.5 不对称纪律：
 * orch 消费新键必须逐键读，不得建在「对端一定带了」上）⇒ 机侧缺报的键**省略**而不是填 0/false
 * （填了就是把「未知」谎报成「没有」）。
 *
 * `remainingMs` 同此口径：它是 launcher 侧续跑闸的输入（`ContinueGateSignals.remainingMs`），
 * M2 的 `RunnerTaskDiagnostics` 尚无该键 ⇒ 机侧一旦在 diagnostics 下带出（「只加键不 breaking」
 * 伞下），本事件自动开始携带。
 */
function continuedEventPayload(params: {
  taskId: string;
  machineId: string;
  projectId: string;
  obj: Record<string, unknown>;
  continueAttempts: number;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    taskId: params.taskId,
    machineId: params.machineId,
    projectId: params.projectId,
    continueAttempts: params.continueAttempts,
  };
  for (const key of ["continueTrigger", "timeoutScope"] as const) {
    const v = diagString(params.obj, key);
    if (v !== undefined) payload[key] = v;
  }
  for (const key of [
    "partialChars",
    "updateCount",
    "firstChunkElapsedMs",
    "remainingMs",
    "partialTailChars",
  ] as const) {
    const v = diagNumber(params.obj, key);
    if (v !== undefined) payload[key] = v;
  }
  const resumed = diagBoolean(params.obj, "sessionResumed");
  if (resumed !== undefined) payload.sessionResumed = resumed;
  return payload;
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
 *
 * v0.8.10 O-N1：加 `lane`（并发档）。**列只加在迁移段、不进 `TASKS_DDL`**（照 v0.6.1 起既有纪律：
 * `dispatch_guard` / `diagnostics_json` / `dispatch_rendered` 三列同此），老库升级路径不变。
 *
 * v0.10.2 O-1：加 `task_type`（职责位）。**同一条纪律：列只加在迁移段、不进 `TASKS_DDL`**。
 *
 * v0.10.8 O-4（orch-N1）：加 `mode`（执行通道）。**同一条纪律：列只加在迁移段、不进 `TASKS_DDL`、
 * 存量不回填**（NULL ⇒ 读侧 `readMode` 归一 `dag`）。⚠️ `mode` **刻意不进队列视角**
 * （`QUEUE_TASK_COLUMNS` 走 `TASK_COLUMNS_CORE`，不带 `mode`）—— `/api/tasks` 出参不动
 * （改造文档 §2.1 O-5）；队列行无 `mode` 键 ⇒ 读侧恒归一 `dag`，队列侧无 mode 消费方。
 *
 * v0.10.8 O-9（orch-N2）：加 `stage`（派发当刻阶段快照）。**同一条纪律：列只加在迁移段、
 * 不进 `TASKS_DDL`、存量不回填**；但读侧与 `mode` **相反** —— NULL 照实读出 `null`、**不归一、
 * 不兜底**（本列没有默认档；改造文档 §2.2 O-9「NULL 一律显 `—`、不得兜底成「需求分析」」）。
 * ⚠️ `stage` **刻意不进队列视角**：队列行无 `stage` 键 ⇒ 读侧恒 `null`，`/api/tasks` 出参不动。
 */
const TASK_COLUMNS_CORE =
  "task_id, project_id, context_id, state, lane, task_type, artifacts_json, text, prompt, " +
  "feature_id, dependencies, input_artifacts, remote_task_id, dispatch_guard, dispatch_message, dispatch_rendered, updated_at, " +
  "retry_count, failure_kind, diagnostics_json, " +
  "created_at, started_at, finished_at";

const TASK_COLUMNS = `${TASK_COLUMNS_CORE}, mode, stage`;

/** features 表全列清单（SELECT 单一事实源；新增列时同步此处 + rowToFeature） */
const FEATURE_COLUMNS =
  "feature_id, state, title, requirement, context_id, plan, decisions, contracts, " +
  "owner_group, parent_feature_id, stage, version, approval, created_at, updated_at";

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
    lane: readLane(row),
    taskType: readTaskType(row),
    mode: readMode(row),
    stage: readTaskStage(row),
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
    // v0.8.9 O1：渲染快照列（NULL = 历史行 / 未渲染 ⇒ 读侧走 `?? dispatchMessage` 兜底）
    dispatchRendered: readNullableString(row, "dispatch_rendered"),
    retryCount: readInteger(row, "retry_count"),
    failureKind: readFailureKind(row),
    // v0.8.8 O3：machine 上报的 diagnostics 宽 JSON 原文（NULL = 未上报 / 存量老行）
    diagnosticsJson: readDiagnosticsJson(row),
    // v0.6.1 REQ-05：三列休眠 —— 不进 SELECT，恒取中性值（字段保留以维持 TaskRecord 形状）
    exhausted: false,
    notBefore: null,
    lastPollAt: null,
  };
}

/**
 * `stage` 读侧归一（v0.9.0 B2″）：NULL（存量行 / 未带值建行）⇒ {@link DEFAULT_FEATURE_STAGE}；
 * 脏值同样落缺省而**不 throw**（与 `state` 的 fail-fast **相反** —— 登记面不得让读取抛出去，
 * 否则 `recover` 启动即抛 / `tick` 停摆）。脏值的**取证与一次性归一**在 ctor（见该处告警）。
 */
function readStage(row: Record<string, unknown>): FeatureStage {
  const raw = readNullableString(row, "stage");
  return raw !== null && isFeatureStage(raw) ? raw : DEFAULT_FEATURE_STAGE;
}

/** `approval` 读侧归一：口径同 {@link readStage}（NULL / 脏值 ⇒ 缺省，不 throw） */
function readApproval(row: Record<string, unknown>): FeatureApproval {
  const raw = readNullableString(row, "approval");
  return raw !== null && isFeatureApproval(raw) ? raw : DEFAULT_FEATURE_APPROVAL;
}

/**
 * **可回池档**（v0.10.7 n1 · 改造文档 §2.0 伪码的引擎侧投影）= 删版时该卡可退回需求池的唯一判据。
 *
 * 正向严格合取：两枚登记字段**都是**那枚字面取值才成立。`stage` / `approval` 是**两次独立写、
 * 不保证同序** ⇒ 不得以 `stage` 单枚代判；经 {@link readStage} / {@link readApproval} 归一后，
 * NULL / 脏值落到的缺省值（`改造方案` / `待审批`）恒不等于这两枚 ⇒ **归一即 fail-closed**，
 * 与伪码「任一字段 null / 非两枚字面取值 ⇒ 不满足」同侧。
 *
 * 板侧同构实现 = `deriveScheduleGateOpen`（两侧不做代码级共享，同源由伪码单点 + 恒等锚承载）。
 */
function isVersionCardBackToPool(card: VersionDeleteCard): boolean {
  return card.stage === "需求分析" && card.approval === "未发起";
}

/** 拒因 message 用的卡 id 清单（空桶 ⇒ `[]`，不省键，便于逐档点数） */
function idList(cards: VersionDeleteCard[]): string {
  return `[${cards.map((card) => card.featureId).join(", ")}]`;
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
    // v0.9.3 O1 父需求列：可空自由 ID（NULL = 无父，合法值）；不做闭集归一、不解析父链
    parentFeatureId: readNullableString(row, "parent_feature_id"),
    // v0.9.0 B2″ 登记三列：**读侧单点归一**（NULL / 脏值 → 缺省，一律不 throw）
    stage: readStage(row),
    version: readNullableString(row, "version") ?? "",
    approval: readApproval(row),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

/**
 * Feature **归属谓词**（v0.8.6 §2.3）= 列表读口视野判据的**唯一事实源**。
 *
 * - 给定组名 ⇒ `owner_group = ?`（`NULL` 无归属行天然被排除 = 已配组环境 fail-closed）；
 * - `undefined` ⇒ 空片段（未配组环境匿名入口 / web 运维视图全量）。
 *
 * ★ **列表读的一切分支必须共用本谓词**（需要裸条件时经 {@link featureOwnershipCondition} 取，
 * 仍是同一事实源）：{@link SessionStore.listFeatures} 与 v0.9.0 B3″ 的
 * {@link SessionStore.featureTaskStateCounts} 聚合 —— 另写一份 = 两个可见性判据漂移，
 * 聚合侧会把不可见 Feature 的节点也算进计数（静默放宽视野）。
 */
function featureOwnershipPredicate(
  ownerGroup: string | undefined,
  startWithWhere = true,
): { clause: string; params: string[] } {
  const condition = featureOwnershipCondition(ownerGroup);
  if (condition.clause === "") return { clause: "", params: [] };
  return {
    clause: startWithWhere ? ` WHERE ${condition.clause}` : ` AND ${condition.clause}`,
    params: condition.params,
  };
}

/** 归属谓词的**裸条件**（不含 `WHERE` / `AND` 前缀）= 多处拼接时的唯一条件事实源 */
function featureOwnershipCondition(
  ownerGroup: string | undefined,
): { clause: string; params: string[] } {
  if (ownerGroup === undefined) return { clause: "", params: [] };
  return { clause: "owner_group = ?", params: [ownerGroup] };
}

/**
 * 版号谓词的**裸条件**（v0.10.0 O5b，不含 `WHERE` / `AND` 前缀）= `listFeatures` 版号过滤的
 * **唯一事实源**。三档口径与 {@link SessionStore.aggregateFeaturesByVersion} 的**未登记桶**同源：
 *
 * - `undefined` ⇒ 空片段（不筛版号 = 全量）；
 * - trim 后**空串** ⇒ `(version IS NULL OR version = '')` = 只返未登记卡（**零绑定参数**；
 *   存量行落 NULL、撤排期行落 `''`，两者同属未登记桶，不得只认其一）；
 * - trim 后**非空** ⇒ `version = ?`（精确匹配，绑定 trim 后值 —— 与写口 trim 归一同口径）。
 */
function featureVersionCondition(
  version: string | undefined,
): { clause: string; params: string[] } {
  if (version === undefined) return { clause: "", params: [] };
  const trimmed = version.trim();
  if (trimmed === "") return { clause: "(version IS NULL OR version = '')", params: [] };
  return { clause: "version = ?", params: [trimmed] };
}

/**
 * `listFeatures` 的**过滤条件清单** = {@link featureListWhere} 与 {@link featureListParams} 的
 * **共同事实源**（拼接序与绑参序由同一份数组派生，不可能各写一份而串位到错误的列）。
 * 顺序固定 **state → version → owner**。
 */
function featureListConditions(
  opts: ListFeaturesOptions,
): Array<{ clause: string; params: string[] }> {
  const conditions: Array<{ clause: string; params: string[] }> = [];
  if (opts.state !== undefined) conditions.push({ clause: "state = ?", params: [opts.state] });
  conditions.push(featureVersionCondition(opts.version));
  conditions.push(featureOwnershipCondition(opts.ownerGroup));
  return conditions;
}

/** `listFeatures` 的 WHERE 片段（状态 ∧ 版号 ∧ 归属谓词；含尾空格，可直接接 `ORDER BY`） */
function featureListWhere(opts: ListFeaturesOptions): string {
  const kept = featureListConditions(opts)
    .filter((c) => c.clause.length > 0)
    .map((c) => c.clause);
  return kept.length > 0 ? `WHERE ${kept.join(" AND ")} ` : "";
}

/** `listFeatures` 的绑定参数（顺序 = {@link featureListWhere} 的片段顺序：state → version → owner） */
function featureListParams(opts: ListFeaturesOptions): Array<string | number> {
  return featureListConditions(opts).flatMap((c) => c.params);
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

/**
 * 解析 `lane` 列（v0.8.10 O-N1）：**NULL 归一为 `write`**（保守档 = 与 v0.8.9 及以前逐字一致的
 * 串行行为；**反方向归一 = 静默放宽串行门**，见 `TASK_LANES` 注记）；
 * 非 NULL 但非法值 = 数据损坏（fail-fast，与其余列同纪律）。
 */
function readLane(row: Record<string, unknown>): TaskLane {
  const raw = readNullableString(row, "lane");
  if (raw === null) return "write";
  if (!isTaskLane(raw)) {
    throw new Error(`[session-store] 列 lane 数据损坏：非法值 ${raw}`);
  }
  return raw;
}

/**
 * 解析 `task_type` 列（v0.10.2 O-1）：**NULL 归一为 `unit_agent`**（缺省职责位 = 本列引入前的
 * 唯一行为，存量行与未带职责位的建行路径均落此档）；
 * 非 NULL 但闭集外的值 = 数据损坏（fail-fast，与其余列同纪律；**不兜底归一**）。
 *
 * 与 `readLane` 的**同一形状、相反的兜底禁忌**：`lane` 若把 NULL 当只读 = 静默放宽串行门；
 * 本列若把 NULL 当非 `unit_agent` = 给存量行凭空赋新语义（触发 `roles` 路由）。
 * 两侧 SQL 都**不谓词化**本列（O-1 无按职责位筛选的查询），归一只在此一处。
 */
function readTaskType(row: Record<string, unknown>): TaskType {
  const raw = readNullableString(row, "task_type");
  if (raw === null) return "unit_agent";
  if (!isTaskType(raw)) {
    throw new Error(`[session-store] 列 task_type 数据损坏：非法值 ${raw}`);
  }
  return raw;
}

/**
 * 解析 `mode` 列（v0.10.8 O-4 · orch-N1）：**NULL 归一为 `dag`**（本列引入前的唯一行为；
 * 存量行**不回填**，NULL 承载「建行早于本列」这一事实 —— 队列视角 `QUEUE_TASK_COLUMNS`
 * 不带该键，同样走此归一）。
 * 非 NULL 但闭集外的值 = 数据损坏（fail-fast，与 `readTaskType` 同纪律；**不兜底归一**）。
 *
 * 兜底方向与 `readLane` 同理不可反：NULL 若按 `inquiry` 解释 = 把全部存量节点剔出
 * DAG 判据集（静默废掉调度）。
 */
function readMode(row: Record<string, unknown>): TaskMode {
  const raw = readNullableString(row, "mode");
  if (raw === null) return "dag";
  if (!isTaskMode(raw)) {
    throw new Error(`[session-store] 列 mode 数据损坏：非法值 ${raw}`);
  }
  return raw;
}

/**
 * 解析 `tasks.stage` 列（v0.10.8 O-9 · orch-N2）：**NULL 照实读出 `null` —— 不归一、不兜底**。
 * 形制与 {@link readMode} **同形状、相反的第二段**：`mode` 有缺省档（`dag` = 本列引入前的唯一
 * 行为）可归一，`stage` **没有默认档** —— NULL 承载「建行早于本列 / 未摄快照」这一事实，兜底成
 * 任何一档（如「需求分析」）都是给存量行凭空赋阶段语义（改造文档 §2.2 O-9：NULL 一律显 `—`）。
 * 队列视角不带该键（`QUEUE_TASK_COLUMNS` 无 `stage`）⇒ 队列行同样读 `null`。
 *
 * 非 NULL 但闭集外的值 = 数据损坏（fail-fast，与 `readMode`/`readTaskType` 同纪律；**不兜底归一**
 * —— 与 features 侧 `readStage` 的「脏值落缺省不 throw」**相反**：那是登记面不得挡引擎，
 * 本列是快照事实面，脏了就该炸出来）。
 */
function readTaskStage(row: Record<string, unknown>): FeatureStage | null {
  const raw = readNullableString(row, "stage");
  if (raw === null) return null;
  if (!isFeatureStage(raw)) {
    throw new Error(`[session-store] 列 stage 数据损坏：非法值 ${raw}`);
  }
  return raw;
}

/**
 * `tasks` 队列视角全列清单（SELECT 单一事实源；含队列五列；`lane` 随核心列清单一并进入）。
 * ⚠️ **不含 `mode`**（v0.10.8 O-4 · orch-N1）：`/api/tasks` 出参不动，队列侧无 mode 消费方；
 * 队列行无 `mode` 键 ⇒ `readMode` 恒归一 `dag`（与存量行同一读侧口径）。
 * ⚠️ **同样不含 `stage`**（v0.10.8 O-9 · orch-N2）：队列行无 `stage` 键 ⇒ `readTaskStage` 恒读
 * `null`（本列无缺省档、不归一不兜底，与 `mode` 的归一口径**相反**）。
 */
const QUEUE_TASK_COLUMNS = `${TASK_COLUMNS_CORE}, queue_state, claimed_by, claim_token, claimed_at, queued_at`;

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
    repo: readNullableString(row, "repo"),
    updatedAt: readString(row, "updated_at"),
  };
}

/**
 * `versions` 行 → 台账记录。
 *
 * `status` 脏值 ⇒ **fail-fast**（照 `rowToRunner` / `rowToRunnerProject` 口径，本表只由引擎写口
 * 与一次性迁移脚本写，脏值 = 库被手工改过 ⇒ 必须可见，不得静默兜成缺省态）。
 */
function rowToVersionLedger(row: Record<string, unknown>): VersionLedgerRecord {
  const status = readString(row, "status");
  if (!isVersionLedgerStatus(status)) {
    throw new Error(`[session-store] 列 status 数据损坏：非法版本台账态 ${status}`);
  }
  return {
    ownerGroup: readNullableString(row, "owner_group"),
    version: readString(row, "version"),
    status,
    date: readNullableString(row, "date"),
    note: readNullableString(row, "note"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

/**
 * 解析 `releases.projects_json` 列（`ReleaseSnapshotProject[]` JSON 字符串）。
 *
 * 快照列**原值入、不归一**（改造文档 §2.1(6)）⇒ 这里**只做形状校验**（数组 / 元素是对象 /
 * 四个键各自是 `string | null`），**不做** trim、大小写折叠、去重、排序 —— 脏值 = 库被手工
 * 改过 ⇒ fail-fast（与 {@link rowToVersionLedger} 同一口径，快照是发版事实、不得静默兜缺省）。
 *
 * **向后兼容**（v0.10.1 O4 · C-5）：`projectId` / `version` 是**后加的可选键** ⇒ 历史旧形状行
 * （只有 `repoId` / `ref`）仍可读，且**读回形状与写入时逐字一致**（缺键不补 `null`、不回填）。
 */
function readReleaseProjects(row: Record<string, unknown>): ReleaseSnapshotProject[] {
  const raw = readNullableString(row, "projects_json");
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`[session-store] 列 projects_json 数据损坏：非法 JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`[session-store] 列 projects_json 数据损坏：期望 JSON 数组`);
  }
  const projects: ReleaseSnapshotProject[] = [];
  for (const v of parsed) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new Error(`[session-store] 列 projects_json 数据损坏：数组元素非对象`);
    }
    const item = v as Record<string, unknown>;
    for (const key of ["repoId", "ref", "projectId", "version"] as const) {
      const value = item[key];
      if (value !== null && value !== undefined && typeof value !== "string") {
        throw new Error(`[session-store] 列 projects_json 数据损坏：${key} 非 string | null`);
      }
    }
    const project: ReleaseSnapshotProject = {
      repoId: (item["repoId"] ?? null) as string | null,
      ref: (item["ref"] ?? null) as string | null,
    };
    if (item["projectId"] !== undefined) project.projectId = item["projectId"] as string | null;
    if (item["version"] !== undefined) project.version = item["version"] as string | null;
    projects.push(project);
  }
  return projects;
}

function rowToReleaseSnapshot(row: Record<string, unknown>): ReleaseSnapshotRecord {
  return {
    ownerGroup: readNullableString(row, "owner_group"),
    version: readString(row, "version"),
    changelogAnchor: readNullableString(row, "changelog_anchor"),
    projects: readReleaseProjects(row),
    note: readNullableString(row, "note"),
    createdAt: readString(row, "created_at"),
  };
}

/**
 * `project_versions` 行 → project 台账记录（v0.10.1 O1）。
 *
 * `status` 脏值 ⇒ **fail-fast**（照 {@link rowToVersionLedger} 口径：本表只由引擎写口写，
 * 脏值 = 库被手工改过 ⇒ 必须可见，不得静默兜成 `open`）。
 */
function rowToProjectVersion(row: Record<string, unknown>): ProjectVersionRecord {
  const status = readString(row, "status");
  if (!isProjectVersionStatus(status)) {
    throw new Error(`[session-store] 列 status 数据损坏：非法 project 台账态 ${status}`);
  }
  return {
    ownerGroup: readNullableString(row, "owner_group"),
    projectId: readString(row, "project_id"),
    version: readString(row, "version"),
    status,
    date: readNullableString(row, "date"),
    note: readNullableString(row, "note"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

/** `feature_projects` 行 → 归属记录（v0.10.1 O1；四列身份字段脏值 ⇒ 同 {@link rowToProjectVersion} 的 fail-fast） */
function rowToFeatureProject(row: Record<string, unknown>): FeatureProjectRecord {
  return {
    ownerGroup: readNullableString(row, "owner_group"),
    featureId: readString(row, "feature_id"),
    projectId: readString(row, "project_id"),
    projectVersion: readString(row, "project_version"),
    groupVersion: readString(row, "group_version"),
    source: readNullableString(row, "source"),
    createdAt: readString(row, "created_at"),
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
  repo        TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (runner_id, project_id)
)`;

/**
 * **版本台账表**（v0.10.0 O1 · 改造文档 §2.1(1)）—— **可编辑**，排期锁与 `released` 锁的事实源。
 *
 * 键 = `(owner_group, version)` ⇒ 列车号**组内唯一**（同名版号可分属两组）。
 * `owner_group` 可空（NULL = 未配组的匿名档）⇒ 目标定位一律用 **NULL-safe `IS`**
 * （`owner_group = ?` 对 NULL 恒不成立；且 SQLite 的 PK/UNIQUE 把 NULL 视为互不相等，
 * 故「重复 ⇒ 409」不得依赖 `ON CONFLICT`，见 {@link SessionStore.versionLedgerGet}）。
 *
 * 形状与 O5 单测的代打 fixture（`test/v0100-o5-version-validation.test.ts`）**逐字一致**
 * ⇒ 该 fixture 在本表落地后原样退役（`IF NOT EXISTS` 空转，不产生第二份表）。
 */
const VERSIONS_DDL = `
CREATE TABLE IF NOT EXISTS versions (
  owner_group TEXT,
  version     TEXT,
  status      TEXT NOT NULL DEFAULT 'notstart',
  date        TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_group, version)
)`;

/**
 * **发版快照表**（v0.10.0 O1 · 改造文档 §2.1(1)）—— **不可变**，仅在标记 `released`
 * 那一刻与 `versions.status` **同事务**写入（写入路径 = O7
 * {@link SessionStore.versionLedgerMarkReleased}，唯一 INSERT 点）。
 *
 * **无 `updated_at`**（快照不改写 = 不可变的 schema 表达）；`projects_json` =
 * `ReleaseSnapshotProject[]` 原文（`repoId` 不归一，§2.1(6)）。
 * **不加 `status` 列**（三态归台账，C-3 裁定：两表分工，快照不重复承载状态）。
 */
const RELEASES_DDL = `
CREATE TABLE IF NOT EXISTS releases (
  owner_group      TEXT,
  version          TEXT,
  changelog_anchor TEXT,
  projects_json    TEXT,
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_group, version)
)`;

/**
 * **project 台账表**（v0.10.1 O1 · 改造文档 §2.2）—— **可编辑**，Project Version 的身份与落库面。
 *
 * 键 = `(owner_group, project_id, version)`（C-2）⇒ 同名版号可分属不同 project / 不同组，
 * **不要求**与 Group Version 一致（C-1）。project **不能跨组**（配置期 fail-fast 互斥，
 * `config.ts` 组间成员断言）⇒ 该键良定义、无跨组歧义。
 *
 * `status` **两态** `open` / `released`（默认 `open`）：不进组档的 `notstart → active` 自动转换，
 * `released` **只由 Group 级发版动作在同事务内级联置入**（C-4）⇒ 本节点的建版口连 `status`
 * 参数都不收（见 {@link ProjectVersionCreateInput}）。
 *
 * `owner_group` 可空（NULL = 未配组的匿名档）⇒ 与 {@link VERSIONS_DDL} 同一条硬约束：
 * **SQLite 的 PK / UNIQUE 把 NULL 视为互不相等**，故「重复 ⇒ 409」**不得**依赖 `ON CONFLICT`
 * 或 `INSERT OR REPLACE`（匿名档会静默插出第二行），一律 **NULL-safe `IS` 自查 + 再插**。
 */
const PROJECT_VERSIONS_DDL = `
CREATE TABLE IF NOT EXISTS project_versions (
  owner_group TEXT,
  project_id  TEXT NOT NULL,
  version     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  date        TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_group, project_id, version)
)`;

/**
 * **归属（承诺集）表**（v0.10.1 O1 · 改造文档 §2.2 / C-3 / C-16）—— 一条需求在本 Group Version
 * 内触达哪些 project、各自落哪个 Project Version。
 *
 * 键 = `(owner_group, feature_id, project_id)` ⇒ 一个需求对同一 project 只有一条承诺（可改、
 * 改后仍是一行，`updated_at` 承载最近一次改动）。
 *
 * **为什么必须显式落库而不由 `tasks` 派生**（K-1）：`tasks.project_id` 是**执行期日志** ——
 * 收口 7 天后被 {@link SessionStore.pruneTasks} 删、不含「规划要触及但未派发」的 project、
 * 且无 version 列。**本表不进 `pruneTasks`（该函数只删 `tasks` 行）**，Feature 终态 / `cancel`
 * 也**不级联删**归属行（C-16）⇒ 归属是长期事实源。
 *
 * `group_version` **NOT NULL**：无 Group Version ⇒ 落不下归属（C-21 的 schema 表达）；
 * 与 `features.version` 同单写定、此后不漂移。匿名档同 {@link PROJECT_VERSIONS_DDL} 的
 * NULL-safe `IS` 口径。
 */
const FEATURE_PROJECTS_DDL = `
CREATE TABLE IF NOT EXISTS feature_projects (
  owner_group     TEXT,
  feature_id      TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  project_version TEXT NOT NULL,
  group_version   TEXT NOT NULL,
  source          TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_group, feature_id, project_id)
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
    // v0.8.8 O3 迁移（§2.5 落库口径）：tasks 加 `diagnostics` **宽 JSON 原文列** ——
    // machine 上报的执行计量（分段耗时 / `timeoutScope` / `acpErrorCode` / `continueAttempts` …）
    // 原样落库，供续跑派生事件与后续版本（v0.8.10 排队可见面）复用；**只落派生布尔即视为返工**。
    // 纪律照既有：只加列、必可空、不复用既有列、读侧 `readNullableString`、**只在 ctor try-ALTER**。
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN diagnostics_json TEXT");
    } catch {
      // 列已存在
    }
    // v0.8.9 O1 迁移（§2 纯丙 · O-①a）：tasks 加 `dispatch_rendered` **渲染快照列** ——
    // 每次派发实际下发全文（含外壳）的落库副本，与 `dispatch_message`（未渲染 base）分离，
    // 使「同一 base 反复派发 ⇒ 外壳叠加」可观测、可在 O2 消除。
    // **只加列、必可空、老行不回填**（NULL ⇒ 读侧 `?? dispatchMessage` 兜底、行为逐字不变）；
    // 覆盖写、不复用既有列、读侧 `readNullableString`、**只在 ctor try-ALTER**。
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN dispatch_rendered TEXT");
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
    // v0.9.3 O1 迁移（REQ-v0.9.3 · parentFeatureId 引擎字段）：features 加 `parent_feature_id`
    // （增补轨挂主需求的单值父引用）。**必可空、老行不回填**（NULL = 无父，合法缺省）；
    // 自由 ID 列：**不套**登记三列的脏值归一循环**（无闭集、NULL 即合法、脏值不猜语义只透存）。
    // 纪律照既有：只加列、不复用既有列、读侧 `readNullableString`、**只在 ctor try-ALTER**。
    try {
      this.db.exec("ALTER TABLE features ADD COLUMN parent_feature_id TEXT");
    } catch {
      // 列已存在
    }
    // ── v0.9.0 B1″ 迁移（REQ-v0.9.0-2026-09-24-01）：features 加**登记三列** ──────────────
    // `stage`（阶段）/ `version`（版本）/ `approval`（门状态）= **观测面登记字段**，
    // 不是状态机态（不改 `TRANSITIONS`、不改主链判据）。
    // 纪律照既有：只加列、**必可空**（存量行三列一律 NULL ⇒ 读侧按缺省）、不复用既有列、
    // **只在 ctor try-ALTER**（无 `PRAGMA user_version`）。
    for (const column of ["stage TEXT", "version TEXT", "approval TEXT"]) {
      try {
        this.db.exec(`ALTER TABLE features ADD COLUMN ${column}`);
      } catch {
        // 列已存在（幂等）
      }
    }
    // 两枚举列的**脏值一次性归一**（照上方 `features.state` 脏值先例：先取证 `console.error`，再改）：
    // 列**无 DB 约束**，非法值虽不会像 `state` 那样让读取抛（读侧 `readStage` / `readApproval` 已
    // 归一兜住），但「库里一个谁都读不出来的值」必须留痕并落定到缺省。
    // **NULL 不在归一范围**（存量行的合法态，语义 = 按缺省，见读侧）；
    // **不改 `updated_at`**（归一不是活动）、**不写事件**（迁移非运行期状态变更）、**幂等**（二次启动零行）。
    for (const [column, known, fallback] of [
      ["stage", FEATURE_STAGES, DEFAULT_FEATURE_STAGE],
      ["approval", FEATURE_APPROVALS, DEFAULT_FEATURE_APPROVAL],
    ] as const) {
      const placeholders = known.map(() => "?").join(", ");
      const dirtyRows = this.db
        .prepare(
          `SELECT ${column} AS v, COUNT(*) AS n FROM features
           WHERE ${column} IS NOT NULL AND ${column} NOT IN (${placeholders}) GROUP BY ${column}`,
        )
        .all(...known) as Array<Record<string, unknown>>;
      if (dirtyRows.length === 0) continue;
      const detail = dirtyRows
        .map((row) => `${String(row["v"])}×${String(row["n"])}`)
        .join(" / ");
      const total = dirtyRows.reduce((sum, row) => sum + Number(row["n"]), 0);
      console.error(
        `[session-store] features.${column} 脏值归一 → ${fallback}：${detail}（共 ${total} 行）`,
      );
      this.db
        .prepare(
          `UPDATE features SET ${column} = ? WHERE ${column} IS NOT NULL AND ${column} NOT IN (${placeholders})`,
        )
        .run(fallback, ...known);
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
    //   段 1：`tasks` 队列五列；段 1b：`tasks.lane`（v0.8.10 O-N1，含存量归一）；
    //   段 1c：`tasks.task_type`（v0.10.2 O-1，存量**不回填**）；
    //   段 1d：`tasks.mode`（v0.10.8 O-4 · orch-N1，存量**不回填**）；
    //   段 1e：`tasks.stage`（v0.10.8 O-9 · orch-N2，存量**不回填**）；
    //   段 2：`runners` 表；段 3：`runner_projects` 表；段 4：队列 / 注册表索引。
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
    // 段 1b（v0.8.10 O-N1 · REQ-v0.8.10-2026-09-23-01 §2.2 / §4-A1）：`tasks.lane` 并发档列。
    // 口径 = **缺省写档**（保守、向后兼容：不读该列时行为与 v0.8.9 逐字一致）。
    //
    // ⚠️ **存量行必须归一为 `write`** —— 本段与 `queue_state` 一族**相反**：那五列老行留 NULL 是
    // 「不在队列中」的正确语义；此处 NULL 若按只读解释 ⇒ **存量行整体退出忙集 = 静默放宽串行门**
    // （同 project 双派双写）。归一之后 NULL 只可能来自**未升版的老代码写入**，SQL 侧仍须按写档算
    // （见 `WRITE_LANE_SQL`）。
    //
    // 纪律照既有：只加列、必可空、不复用既有列、读侧 `readLane`、**只在 ctor try-ALTER**；
    // 归一语句**幂等**（`WHERE lane IS NULL` ⇒ 二次启动零行命中）、**不改 `updated_at`**
    // （归一不是活动，避免存量任务顶到列表首位）、**不写事件**（迁移非运行期状态变更）。
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN lane TEXT");
    } catch {
      // 列已存在（幂等）
    }
    this.db.exec("UPDATE tasks SET lane = 'write' WHERE lane IS NULL");
    // 段 1c（v0.10.2 O-1 · REQ-2026-10-09-01 §2.3 F-C1 / §3.2）：`tasks.task_type` 职责位列。
    // 口径 = **缺省 `unit_agent`**（本列引入前的唯一行为：不读该列时与 v0.10.1 逐字一致）。
    //
    // ⚠️ **与段 1b 相反**：本段**不做**存量 `UPDATE` 归一 —— `lane` 必须回填是因为 SQL 侧两处谓词
    // 直接读该列（NULL 漏归 = 静默放宽串行门）；`task_type` 在 O-1 **没有任何 SQL 谓词消费**，
    // 归一唯一落点 = 读侧 `readTaskType`（NULL ⇒ `unit_agent`）。存量行留 NULL 是**正确语义**
    // （= 未声明），回填 `'unit_agent'` 反而会把「未声明」与「显式声明 unit_agent」两种事实压平，
    // 后续按职责位筛选的节点将无法区分。
    //
    // 纪律照既有：只加列、必可空、不复用既有列、读侧 `readTaskType`、**只在 ctor try-ALTER**
    // （`ALTER` 不改 `updated_at`、不写事件 —— 迁移非运行期状态变更）。
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN task_type TEXT");
    } catch {
      // 列已存在（幂等）
    }
    // 段 1d（v0.10.8 O-4 · orch-N1 · 改造文档 §2.1 O-4）：`tasks.mode` 执行通道列（dag / inquiry）。
    // 口径 = **缺省 `dag`**（本列引入前的唯一行为：存量行 NULL 按 DAG 解释 = 零行为变化）。
    //
    // ⚠️ **存量不回填**（照段 1c `task_type`，不照段 1b `lane`）：本列在 N1 **没有任何 SQL 谓词消费**，
    // 归一唯一落点 = 读侧 `readMode`（NULL ⇒ `dag`）；回填 `'dag'` 会把「建行早于本列」与
    // 「显式建为 dag」两种事实压平，后续节点集合判据（O-4）与 prune 改判（O-8）无从区分。
    //
    // 纪律照既有：只加列、必可空、不复用既有列、读侧 `readMode`、**只在 ctor try-ALTER**
    // （`ALTER` 不改 `updated_at`、不写事件 —— 迁移非运行期状态变更）。
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN mode TEXT");
    } catch {
      // 列已存在（幂等）
    }
    // 段 1e（v0.10.8 O-9 · orch-N2 · 改造文档 §2.2 O-9）：`tasks.stage` 派发当刻阶段快照列。
    // 口径 = **无缺省档**：值 = 该 task 派发当刻其 Feature 登记 `stage` 的快照；NULL = 「建行早于
    // 本列 / 未摄快照」，读侧 `readTaskStage` 照实读出 `null`。
    //
    // ⚠️ **存量不回填**（照段 1c/1d 的纪律），且读侧**不兜底**（与段 1d `mode` 相反）：`mode` 有
    // 缺省档 `dag` 可归一，`stage` 没有 —— 回填或兜底成任何一档（如「需求分析」）都是给存量行
    // 凭空赋阶段语义，板侧按阶段过滤会错桶（改造文档 §2.2 O-9：NULL 一律显 `—`）。
    //
    // 纪律照既有：只加列、必可空、不复用既有列、读侧 `readTaskStage`、**只在 ctor try-ALTER**
    // （`ALTER` 不改 `updated_at`、不写事件 —— 迁移非运行期状态变更）。
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN stage TEXT");
    } catch {
      // 列已存在（幂等）
    }
    // 段 1f（v0.10.8 M1 · 改造文档 §2.2 修正2 / §3）：`tasks.settled_by` 结算接管人列。
    // 口径 = **无缺省档的纯审计位**：值 = 把本行从 `input-required` 结算为终态的续答新行 taskId；
    // NULL = 「未被接管 / 本列引入前的行 / 非结算写入」。
    //
    // ⚠️ **存量不回填、读侧不兜底**（照段 1c/1d/1e 的「无 SQL 谓词消费 ⇒ 不归一」纪律）：本列读者 =
    // 排查脚本与归属回填卡，**不进 `TASK_COLUMNS` / `TaskRecord` / 出参**（改造文档 §2.3：
    // 审计位不是展示位；直查列原值即得）。写侧唯一入口 = `compareAndSwapTaskState` 的
    // `settledBy` 形参（与 CAS **同一条 UPDATE**，不接受两步写 ⇒ 无「已结算未记账」中间态）。
    //
    // 纪律照既有：只加列、必可空、不复用既有列、**只在 ctor try-ALTER**
    // （`ALTER` 不改 `updated_at`、不写事件 —— 迁移非运行期状态变更）。
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN settled_by TEXT");
    } catch {
      // 列已存在（幂等）
    }
    // 段 2 / 段 3：注册表两张（运行态投影；IF NOT EXISTS = 幂等）
    this.db.exec(RUNNERS_DDL);
    this.db.exec(RUNNER_PROJECTS_DDL);
    // v0.10.0 迁移：runner_projects 加 repo 列（可选透传，缺省 = NULL；老库表已存在时新列靠此 ALTER 补上，列已存在时忽略）
    // 纪律照既有：只加列、必可空、不复用既有列、读侧 `readNullableString`、**只在 ctor try-ALTER**。
    try {
      this.db.exec("ALTER TABLE runner_projects ADD COLUMN repo TEXT");
    } catch {
      // 列已存在（幂等）
    }
    // 段 2″ / 段 3：版本面两表（v0.10.0 O1 · 改造文档 §2.1(1)）。
    // `versions` = 可编辑台账（排期锁 / `released` 锁的事实源）；`releases` = 不可变快照（写入归 O7）。
    // 两者都是**新建表**（非既有表加列）⇒ `IF NOT EXISTS` 幂等，无需 try-ALTER；
    // 存量数据由一次性迁移脚本 `scripts/migrate-versions-ledger.mjs` 导入（运行时不读板文件）。
    this.db.exec(VERSIONS_DDL);
    this.db.exec(RELEASES_DDL);
    // 段 2‴ / 段 3″：版本面**两级**新增两表（v0.10.1 O1 · 改造文档 §2.2）。
    // `project_versions` = project 档可编辑台账（两态）；`feature_projects` = 归属（承诺集）。
    // 同为**新建表** ⇒ `IF NOT EXISTS` 幂等；**历史不回填**（C-11：旧版号 task 已 prune、不可复原）
    // ⇒ 无一次性迁移脚本，新版本起生效。
    this.db.exec(PROJECT_VERSIONS_DDL);
    this.db.exec(FEATURE_PROJECTS_DDL);
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
    // v0.10.0 O5（§2.1(4)）：`features.version` 索引 —— 支撑按版本聚合读面 / 排期锁查表的热路径。
    // 老库若已有脏自由文本值也一并索引（读侧透传、不改写存量，见 §2.1(4) 脏值归一条）。
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_features_version ON features(version)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_feature ON tasks(feature_id, updated_at DESC)",
    );
    // v0.4.0：artifacts 按 Feature / 生产者节点查询；events 按 Feature 顺序读取
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_artifacts_feature ON artifacts(feature_id)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_artifacts_producer ON artifacts(producer_task_id)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_feature ON events(feature_id, event_id)");
    // v0.10.1 O1：归属表的**两个查询方向**各有非 PK 前缀的读口 ⇒ 各建一条索引
    // （PK = `(owner_group, feature_id, project_id)` 只覆盖「按 feature 定位某 project」，
    //   继承判据 `(owner_group, group_version, project_id)` 与「按 feature_id 列全归属」都在 PK 之外）。
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_feature_projects_group_version ON feature_projects(owner_group, group_version, project_id)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_feature_projects_feature ON feature_projects(feature_id)");
    // `project_versions` **不另建索引**：单行读走全 PK、列表读走 `owner_group` 前缀，
    // 两者都由 PK 的 autoindex 覆盖（多建一条 = 纯写放大）。
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
   * - `started_at`：**登记时一律不填**（v0.8.7 O3 摘除旧的 `state === "working"` 预填）——
   *   「首次开工时刻」= **首次被领取时刻**，唯一生产写口是 {@link claimTask} 的 `COALESCE`。
   *   预填若不摘除，则任何「登记即 working」的节点抵达 `claimTask` 时该列已非 NULL，
   *   「接到首次领取」永不生效（列恒等于登记时刻，把排队整段算进耗时）。冲突时同样 `COALESCE`
   *   保留首次 ⇒ upsert 不重置起点；
   * - `finished_at`：**完成时刻**，终态（`completed` / `failed` / `blocked`）时填；冲突时同样
   *   `COALESCE` 保留首次。**必须在 createTask 也写**：独立单任务走 `handleCall` 直接
   *   `createTask(state = 终态)`，**从不经过 CAS**（见 `bridge/index.ts` 的 handleCall）。
   */
  createTask(rec: TaskCreateInput): TaskRecord {
    const now = nowIso();
    const updatedAt = rec.updatedAt ?? now;
    // 三时刻中落库的两列与本行首次落库同源（同一 `now`），避免毫秒级漂移
    const createdAt = now;
    // v0.8.7 O3（§2.4，宿主授权摘除 `working` 预填）：登记**不填**开工时刻
    // ⇒ `claimTask` 是生产链路「首次开工」的唯一写口（排队 / 开工由此分得开）。
    const startedAt: string | null = null;
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
           (task_id, project_id, context_id, state, lane, task_type, mode, stage, artifacts_json, text, prompt,
            feature_id, dependencies, input_artifacts, remote_task_id, dispatch_message, dispatch_rendered, updated_at,
            created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           project_id = excluded.project_id,
           context_id = excluded.context_id,
           state = excluded.state,
           lane = COALESCE(excluded.lane, lane),
           task_type = COALESCE(excluded.task_type, task_type),
           mode = COALESCE(excluded.mode, mode),
           stage = COALESCE(excluded.stage, stage),
           artifacts_json = excluded.artifacts_json,
           text = excluded.text,
           prompt = excluded.prompt,
           feature_id = excluded.feature_id,
           dependencies = excluded.dependencies,
           input_artifacts = excluded.input_artifacts,
           remote_task_id = excluded.remote_task_id,
           dispatch_message = excluded.dispatch_message,
           dispatch_rendered = excluded.dispatch_rendered,
           updated_at = excluded.updated_at,
           started_at = COALESCE(started_at, excluded.started_at),
           finished_at = COALESCE(excluded.finished_at, finished_at)`,
      )
      .run(
        rec.taskId,
        rec.projectId,
        rec.contextId,
        rec.state,
        rec.lane ?? null,
        rec.taskType ?? null,
        rec.mode ?? null,
        rec.stage ?? null,
        rec.artifactsJson ?? null,
        rec.text ?? null,
        prompt,
        rec.featureId ?? null,
        dependencies,
        inputArtifacts,
        rec.remoteTaskId ?? null,
        rec.dispatchMessage ?? null,
        rec.dispatchRendered ?? null,
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
   *
   * v0.10.8 M1：可选 `settledBy`（接管人 taskId）**并入同一条 UPDATE** 的 `SET` 段
   * （改造文档 §2.2 修正2：**不接受两步写** —— 拆两条语句就有「已结算未记账」中间态）。
   * 缺省（`undefined` / `null`）⇒ 赋值片段与参数**一个都不加**，既有调用方 SQL 逐字不变、
   * 已落的 `settled_by` 不被覆写；CAS 零命中（`changes = 0`）时与 `state` 同语句整体不写。
   */
  compareAndSwapTaskState(
    taskId: string,
    expectedFrom: TaskState,
    to: TaskState,
    artifactsJson?: string | null,
    text?: string | null,
    settledBy?: string | null,
  ): boolean {
    const now = nowIso();
    const finishedAt = isFinishedState(to) ? now : null;
    const assignments = [
      "artifacts_json = COALESCE(?, artifacts_json)",
      "text = COALESCE(?, text)",
      "finished_at = COALESCE(?, finished_at)",
      "updated_at = ?",
    ];
    const assignmentParams: Array<string | number | null> = [
      artifactsJson ?? null,
      text ?? null,
      finishedAt,
      now,
    ];
    if (settledBy !== undefined && settledBy !== null) {
      assignments.push("settled_by = ?");
      assignmentParams.push(settledBy);
    }
    const changes = conditionalStateUpdate(this.db, {
      table: "tasks",
      keyColumn: "task_id",
      key: taskId,
      expectedState: expectedFrom,
      nextState: to,
      assignments,
      assignmentParams,
    });
    return changes > 0;
  }

  /**
   * 更新任务态；`artifactsJson` / `text` 未提供时保留原值（COALESCE）。
   * 任务不存在时无效果，返回 null。
   * v0.4.0：状态发生**变化**且新态非 `working` 时，自动写事件收件箱
   * （`blocked` → `task.blocked`；`completed`/`failed`/`input-required` → `task.settled`）。
   * v0.4.1：写入改为 CAS（`WHERE state = <读到的原态>`），并发被抢先时不覆盖、不重复写事件。
   * v0.10.8 M1：可选 `settledBy` 透传给 {@link compareAndSwapTaskState}（同一条 UPDATE 落账，
   * §2.2 修正2）；事件段口径不变 —— **本写口不发 `task.continued`**（该事件由回传侧
   * `continueAttempts` 派生，见 `upsertTaskResult`）。
   */
  updateTaskState(
    taskId: string,
    state: TaskState,
    artifactsJson?: string | null,
    text?: string | null,
    settledBy?: string | null,
  ): TaskRecord | null {
    const previous = this.getTask(taskId);
    if (previous === null) return null;
    const changed = this.compareAndSwapTaskState(
      taskId,
      previous.state,
      state,
      artifactsJson,
      text,
      settledBy,
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
   * **旧行查询：本枚续答可接管的「待澄清」询问行**（v0.10.8 M1 · 改造文档 §2.2 护栏①②）。
   * 返回同 `contextId` 下最可能被续答接管的旧行（`updated_at` 最新一条），无候选返回 null。
   *
   * - WHERE 一律**列值严格等式**（`mode = 'inquiry' ∧ state = 'input-required' ∧ context_id = ?
   *   ∧ task_id <> ?`）：**禁走 `readMode` 归一、禁 `mode <> 'dag'` 这类取反式** —— 取反会把
   *   `mode IS NULL` 的存量真 DAG 行捞进来（护栏①，本卡唯一不可自愈风险面）；
   * - 多命中 ⇒ 只取 `updated_at` 最新一条并 `console.error` 留痕，其余留给存量清理脚本
   *   （M3），**不循环结算**（护栏②）；`LIMIT 2` = 「有无第二条」的最小取证，不整表扫；
   * - 只读、无副作用；M1 不接线（生产调用点是 M2 的建行路径）。
   */
  findOpenInquiryPredecessor(contextId: string, excludeTaskId: string): TaskRecord | null {
    const rows = this.db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks
         WHERE mode = 'inquiry' AND state = 'input-required' AND context_id = ? AND task_id <> ?
         ORDER BY updated_at DESC
         LIMIT 2`,
      )
      .all(contextId, excludeTaskId) as Array<Record<string, unknown>>;
    const first = rows[0];
    if (first === undefined) return null;
    if (rows.length > 1) {
      console.error(
        `[session-store] findOpenInquiryPredecessor 同 context 多命中：context_id=${contextId}，` +
          `只取最新 task_id=${String(first["task_id"])}，其余留给存量清理脚本`,
      );
    }
    return rowToTask(first);
  }

  /**
   * **同步事务原语**（v0.10.8 M2 · 改造文档 §2.2 修正1）：把一段**全同步**的写序列包进
   * 单条 `BEGIN IMMEDIATE` ⇒ 「半套副作用」不再可能对外可见。
   *
   * 存在的理由 = `db` 是本类的私有件，调用方要原子化**多个既有原语**（不是重写它们）
   * 时唯一的安全落点：原语各自 `prepare/run`，由本口决定事务边界。
   *
   * ⚠️ 两条硬约束（违反即语义崩塌，调用方自负）：
   * - `fn` **必须同步**：事务体内不得跨 `await`（长 I/O 期间持写锁 = 全库停摆）；
   * - `fn` 体内**不得**调用自开 `BEGIN IMMEDIATE` 的方法（如
   *   {@link SessionStore.versionLedgerDelete} / {@link SessionStore.versionLedgerActivate}）
   *   ⇒ SQLite 直接报「事务已活动」。单语句原语（`createTask` / `updateTaskState` /
   *   只读的 `getTask` / `findOpenInquiryPredecessor`）可安全嵌套。
   *
   * 失败即回滚并**原样抛出**（ROLLBACK 自身失败不掩盖原始错误）。
   */
  runInTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务已不在活动态：保留原始错误，不掩盖
      }
      throw err;
    }
  }

  /**
   * **C11 派发占位原语（保留但生产未接）**：在 A2A `message/send` **之前**写入「已发出」事实。
   * 任务不存在时无效果，返回 null。
   *
   * ⚠️ **v0.8.7 口径翻正**：v0.7.0 连接模型反转为 pull 后，派发改由 {@link enqueueTask} /
   * {@link claimTask} 承载（`queue_state` 五态 + `dispatch_guard` 降级为**入队幂等键**），
   * 本方法**在生产链路零调用点**（仅 `test/n6-pickups.test.ts` 覆盖其语义）。**保留不删**：
   * 它是「占位先于发送」这一崩溃窗口的原语表达，A2A `message/send` 直发（push）路径若重新
   * 启用即由此承接；`recover()` 读的 `dispatch_guard` 现由 {@link enqueueTask} 写入。
   *
   * - `dispatch_guard` = 占位时刻（非 NULL = 已发起派发）；`remote_task_id` **保持 NULL**，
   *   由 {@link markTaskDispatched} 在 send 返回后回填；
   * - `started_at` 与占位同批写（`COALESCE`：仅首次填）—— 占位时刻即「首次开工」；
   *   ⚠️ 生产未接 ⇒ **`started_at` 的实际写入点是 {@link claimTask}**（v0.8.7 O3）；
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
   * **push 遗留路径的派发落库（生产未接）**：回填远端 id，保持 state（working）以便看护接管。
   * 任务不存在时无效果，返回 null。
   *
   * ⚠️ **v0.8.7 口径翻正**：pull 模型下远端 id 由 Runner 回传经 {@link upsertTaskResult} 回填，
   * 本方法**在生产链路零调用点**（仅剩测试引用，如 `markTaskDispatched` 造 `remote_task_id`
   * 的旧用例）⇒ 它是 A2A `message/send` 直发时代的遗留回填口，**不是** `started_at` 的现行写口。
   *
   * v0.5.0：**`started_at` 写口（仅当 IS NULL 才填）** —— `COALESCE(started_at, ?)` 使
   * 「首次派发」补时刻、而重派 / 重试**不重置起点**（幂等；与 `createTask` 的 `COALESCE` 同一纪律）；
   * v0.8.7 起该语义由 {@link claimTask} 承接（**现行唯一生产写入点**）。
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
   * **项目忙谓词**（SQL `WHERE` 片段）= 忙集判据的**唯一事实源**，供 {@link listBusyProjectIds}
   * 展开：`state = 'working' ∧ queue_state IN ('queued', 'claimed', 'running') ∧ 写档`。
   *
   * v0.8.7（REQ-v0.8.7-2026-09-22-01 O1）改活：pull 模型下 `remote_task_id` **已无生产写入点**
   * （`markTaskDispatched` 仅剩测试引用）⇒ 旧口径 `remote_task_id IS NOT NULL` **恒空集**，
   * 串行门只剩进程内 `reservedProjects`（批次 `finally` 即退场，跨 tick 完全不设防）。
   * 忙集口径改由**本地队列态**承载（与 `isTaskWatched` 同口径）。
   *
   * ★ **v0.8.10 O-N1（REQ-v0.8.10-2026-09-23-01 §2.2）读写分道在此兑现**（v0.8.10 前该处预留位）：
   * 末段 `AND (lane IS NULL OR lane = 'write')` ⇒ **只读节点退出忙集** —— 语义是
   * 「**读不挡写、也不挡读**」（只读节点在飞不再把项目挂上门），**不是**「写不挡读」：
   * 写节点在飞 ⇒ 项目仍忙 ⇒ 同 project 的读写节点一律等（本版刻意不放开）。
   *
   * - **改这里即改门**：`bridge/scheduler.ts` 本版**零改动** —— 忙集每 tick 由本谓词的 DB 快照
   *   算出，谓词一放宽门自动放宽；进程内补口 `reservedProjects` 只登记 orch 派发过的节点（= 写档），
   *   无需改形。
   * - **NULL 必须算写档**（见 `WRITE_LANE_SQL` 注记）：漏掉 `lane IS NULL` 会让**未升版老代码写入的
   *   行**被当成只读 ⇒ 串行门静默失效（同 project 双写）。
   * - **消费侧只按 projectId 比对**（`computeReadyNodes` 的 `busyProjects.has` / `claimed.has` /
   *   `claimed.add`）—— 本谓词**不得**改成返回 `p#lane` 复合键：三处比对漏改任一处即门静默失效。
   *   档位信息只由 `lane` 列承载，忙集仍是**项目粒度**的布尔集合。
   */
  private busyProjectPredicate(): string {
    return `${this.unsettledQueuePredicate()} AND ${WRITE_LANE_SQL}`;
  }

  /**
   * **未落定队列谓词**（**不含档位**）：`state = 'working' ∧ queue_state IN ('queued','claimed','running')`
   * = 「这一行还没结账」。
   *
   * ★ v0.8.10 O-N3 抽出：写档忙集（{@link busyProjectPredicate} = 本谓词 ∧ 写档）与只读档占位面
   * （{@link listReadLaneTasksForProject} = 本谓词 ∧ 只读档）**共用这半判据** —— 二者只差档位条件。
   * 排他**不在此**（由 `busyProjectPredicate` 叠加 `WRITE_LANE_SQL` 完成）⇒ **只读节点在飞时本谓词仍命中**
   * ⇒ trace 的 `readOccupants` 才有料可报（U9：谓词一旦排除 read，占位面必须另有一处能看见他们）。
   */
  private unsettledQueuePredicate(): string {
    return `state = 'working' AND queue_state IN ('queued', 'claimed', 'running')`;
  }

  /**
   * **项目忙**集合（v0.6.1 REQ-05 §2.5 / N5；谓词见 {@link busyProjectPredicate}）：
   * 当前**有未落定节点**的 `project_id` 集合（`DISTINCT project_id`）。
   *
   * ① **谓词含 `queued` 是刻意的**：节点已入队但尚未被领取，也算该项目「忙」——
   *   「上一节点未落定 ⇒ 同项目后续节点不得先行」**就是串行的定义本身**，不是宽松误判。
   * ② **sweep requeue（`claimed → queued`）后该行仍留在忙集 = 正确行为**（任务确实未落定，
   *   只是换了个领取者）；将来读者不得把它当漏洞「修掉」（否则会重新引入同项目双派）。
   * ③ **串行不变量完全由本谓词（orch 侧）持有**，**不依赖 machine 侧的领取纪律** ——
   *   Runner 何时领取、领取几个不由 orch 约束，忙集只认落库事实。
   *
   * ⚠️ **不得复用 `listTasks`**：后者 `limit` clamp 到 `[1,100]` 且按 `updated_at DESC` 截断
   * ⇒ 任务多于 100 条时**静默漏**忙碌项目（串行虚设）。本查询是**集合投影**（无 limit、无排序），
   * 返回基数天然有界于项目数，不存在截断。
   *
   * 本查询覆盖**已落库**的忙（`working ∧ 入队/领取/开工`）；「派发已发起但行尚未落库或队列态
   * 尚未写入」的**进程内窗口**由调度器补（`FeatureScheduler.reservedProjects`）——二者相并方为
   * 完整忙集。终态落库（`upsertTaskResult` 置 `settled`）⇒ 自动出集。
   */
  listBusyProjectIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT project_id FROM tasks WHERE ${this.busyProjectPredicate()}`,
      )
      .all() as Array<Record<string, unknown>>;
    const ids = new Set<string>();
    for (const row of rows) ids.add(readString(row, "project_id"));
    return ids;
  }

  /**
   * **项目忙任务明细**（v0.8.8 §2.10(c) Trace 面；**只读**）：{@link listBusyProjectIds}
   * 同一谓词（`busyProjectPredicate()` = 忙集判据唯一事实源）下的**行级**展开 ——
   * 回答「谁占着这个项目」（`claimed_by` = 占位机）。**跨 Feature、全项目集**（谓词本就无
   * `feature_id` 条件：项目串行是全局事实，占用者可能是别的 Feature 的节点）。
   * 按 `created_at` 升序（同项目串行的先来者在前）。
   */
  listBusyTasksForProject(projectId: string): QueuedTaskRecord[] {
    if (projectId.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ${QUEUE_TASK_COLUMNS} FROM tasks
         WHERE project_id = ? AND ${this.busyProjectPredicate()}
         ORDER BY created_at ASC, queued_at ASC`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map(rowToQueuedTask);
  }

  /**
   * **只读档占位明细**（v0.8.10 O-N3 · REQ-v0.8.10-2026-09-23-01 §2.3 / U9；**只读**）：
   * 同项目**未落定的只读行**（{@link unsettledQueuePredicate} ∧ `lane = 'read'`）的行级展开。
   *
   * ★ **为什么必须有这一面**（U9 跨侧不变量，与 `busyProjectPredicate` 的档位排除**同节点交付**）：
   * 写忙集自 v0.8.10 起排除只读档 ⇒ 一个长跑 `read` 会让 trace 的 `projectBusy` 报 `busy=false`
   * 而节点依旧没开工（machine 侧同 project 读并发闸 `maxConcurrentReads` 缺省 1）⇒ 宿主看到
   * 「没被写门挡住、却没开工」的**假空洞**。本查询就是那片被忙集"让开"的占用面，
   * 供 trace 的 `readOccupants[]` / `waitReason='read_lane_running'` 作答。
   *
   * - **`lane = 'read'` 是精确匹配**（与写侧两处判据相反）：NULL 归一为**写**档 ⇒ 只读档**只有显式声明**
   *   才存在，漏掉 `NULL` 是**刻意**的（写成 `(lane IS NULL OR lane='read')` 会把存量行当成占位者）。
   * - **跨 Feature、全项目集内该项目**：只读占位者可能是别的 Feature 的节点，也可能是**存量**散活行
   *   （`feature_id IS NULL` 仅见于 v0.10.8 收紧前的存量行；O-1/O-2 起 `mode="inquiry"` 派发**恒带
   *    `feature_id`** ⇒ 不得再把「散活」等同于 `feature_id IS NULL`；inquiry 行 O-N4 起恒只读档）。
   * - 按 `queued_at` 升序（与 `claimTask` 的第二键同向 = 同档内的实际领取先后）。
   */
  listReadLaneTasksForProject(projectId: string): QueuedTaskRecord[] {
    if (projectId.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ${QUEUE_TASK_COLUMNS} FROM tasks
         WHERE project_id = ? AND ${this.unsettledQueuePredicate()} AND lane = 'read'
         ORDER BY queued_at ASC, updated_at ASC`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map(rowToQueuedTask);
  }

  /**
   * **排队先于 `queuedAt` 的 `queued` 任务数**（v0.8.8 §2.10(c) / **v0.8.10 O-N3 改键** ·
   * Trace 面位次原料；**只读**）：`queue_state = 'queued' ∧ queued_at < ?`。
   *
   * ★ **排序键 = `queued_at`（入队时刻），不再是 `created_at`（登记时刻）** —— 与
   *   {@link claimTask} 的实领序**同源**（该排序第一键是档位、第二键正是 `queued_at`）。
   *   v0.8.8 用 `created_at` 是**两套时钟**：Feature 节点登记（`createTask`）与入队
   *   （`enqueueTask`，= 调度器判定就绪之后）可相隔很久 ⇒ 位次与实际领取次序**系统性偏离**
   *   （表现为"说在第 3、实际下一个就轮到我"）。改键后该偏差消除。
   *
   * - ISO 串字典序即时间序，与 `queued_at` 直接比较成立；`queued_at` 为 NULL 的行**不计**
   *   （未入队 ⇒ 根本不在领取队列里，不是"排在谁前面"）。
   * - **`queuedAt` 为 `null` / 空串（二者同义）= 不设上界**（「此刻入队会排在所有在队者之后」）：供 trace 给
   *   **就绪但尚未入队**的节点一个投影位次 —— 这类行没有自己的 `queued_at`，拿登记时刻去比
   *   正是 v0.8.8 的旧错。同毫秒并列**不区分**（严格 `<`）。
   * - **残余口径 = 档位优先序，与 §2.2 的「写优先」同源、不可由本计数消除**：`claimTask` 第一键是
   *   **写档优先**、第二键才是 `queued_at`，而本计数是**跨档位的纯 FIFO** ⇒
   *   对**写档**节点，排在其前的**只读**行并不真的挡它 ⇒ 报出的位次**偏大**（实际更早轮到）；
   *   对**只读**节点，晚入队的写档仍领在其前 ⇒ 报出的位次**偏小**。两者都是**保守方向相反**的
   *   解释量，读账时按档位取方向，不得当成实领序号。
   */
  countQueuedBefore(queuedAt: string | null): number {
    const bounded = queuedAt !== null && queuedAt.length > 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE queue_state = 'queued' AND queued_at IS NOT NULL${bounded ? " AND queued_at < ?" : ""}`,
      )
      .get(...(bounded ? [queuedAt] : [])) as Record<string, unknown> | undefined;
    return Number(row?.["n"] ?? 0);
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
         (runner_id, project_id, workspace, agent_kind, a2a_port, risk, status, endpoint, started_at, repo, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          p.repo ?? null,
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
   * 先从队列取候选，再对候选逐条执行条件 UPDATE —— 当前态仍为 `queued` 才置 `claimed`
   * （写 `claimed_by` / 唯一 `claim_token` / `claimed_at`）⇒ 并发下
   * **同一任务至多被一个领取者拿到**（CAS 落空者自动试下一候选，绝不覆盖）。
   *
   * ★ **候选排序 = 写优先 + 同档 FIFO**（v0.8.10 O-N1 §2.2 H3 / D9）：
   * `ORDER BY (lane IS NULL OR lane='write') DESC, queued_at ASC, updated_at ASC`。
   * 为什么必须在**领取序**上补这一刀（忙集放宽不解决它）：读写分道后 read 节点可以与写节点同时
   * 在队，若仍是跨 lane 全局 FIFO，**早入队的 read 会顶掉晚入队的 write** —— 写节点最坏等完
   * 一整轮 read 窗。旧版本不出事，是因为 read 只在项目无写忙时才入队 ⇒ read **不可能**排在
   * write 前面被领（隐患 H3 被串行掩盖，见改造文档 §1.2）。
   *
   * ⚠️ **三点随附口径**：
   * 1. **`NULL` 必须算写档**（同 `busyProjectPredicate`，共用 `WRITE_LANE_SQL`）—— 写成
   *    `lane = 'write'` 会让**迁移前的存量行 / 未升版老代码写入的行整体沉底**（排在所有 read 之后，
   *    永远领不到）。
   * 2. **写优先不是绝对序、是候选窗内序**：候选集仍是 `LIMIT 50`。本排序的第一键把**所有写档**
   *    排在**所有只读档**之前 ⇒ 「50 个更早的 read 挤掉一个 write」**在本排序下不会发生**；
   *    真正的上界是**同档内**超出候选窗（≥50 个更早的**同档**行把本行挤出本窗 ⇒ 下一轮才领到）。
   *    **缺省不放宽 `LIMIT`**（放宽只是把上界推远，不改变「候选窗内序」这一性质），该上界
   *    **登记为已知**（改造文档 §2.1 措辞按本条校正）。
   * 3. **`rearm*`（重派 / 重发）不改 `lane`** —— `rearmTask` / `rearmForRetry` 只重置队列态与
   *    记账列，**不产生「重派后变写档」**（也不产生反向的降档）；档位只在**登记时**由
   *    `createTask({ lane })` 决定，重放的是同一个逻辑任务 ⇒ 沿用原档。
   *
   * - `projectIds` 缺省 = 不限项目；显式空数组 = 无可领取（返回 null，零 I/O）。
   * - `claimToken` 缺省由存储层生成（`randomUUID`；`idx_tasks_claim_token` 唯一索引兜底）。
   * - 无候选 / 全部被抢占 / 候选行消失 ⇒ 返回 null。
   * - **v0.8.7 O3（取证面 §2.4）**：领取即**首次开工** ⇒ 同批补 `started_at`
   *   （`COALESCE` 仅 NULL 才填）—— pull 模型下这才是「真的开始跑」的时刻。
   *   `createTask()` 登记时**不再预填**（v0.8.7 O3 摘除旧的 `working` 预填）⇒ 本方法是
   *   生产链路「首次开工时刻」的**唯一写口**；旧口径记的两个写入点
   *   （{@link markTaskDispatchStarted} / {@link markTaskDispatched}）在 v0.7.0 反转为 pull
   *   后**生产零调用**，已翻正为遗留原语。
   *   `COALESCE` 保证**只填一次**：心跳 requeue 后再领取 / `rearmForRetry` 重派**不重置起点**。
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
         ORDER BY ${WRITE_LANE_SQL} DESC, queued_at ASC, updated_at ASC LIMIT 50`,
      )
      .all(...(projectIds === undefined ? [] : [...projectIds])) as Array<Record<string, unknown>>;
    if (candidates.length === 0) return null;
    const claimedAt = opts.claimedAt ?? nowIso();
    const update = this.db.prepare(
      `UPDATE tasks
       SET queue_state = 'claimed', claimed_by = ?, claim_token = ?, claimed_at = ?,
           started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE task_id = ? AND queue_state = 'queued'`,
    );
    for (const candidate of candidates) {
      const taskId = readString(candidate, "task_id");
      const claimToken = opts.claimToken ?? randomUUID();
      const info = update.run(opts.claimedBy, claimToken, claimedAt, claimedAt, claimedAt, taskId);
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
   * **清算悬挂领取**（B2）：`claimed` / `running` → `queued`，清空 claim **令牌与时刻**两字段
   * （`claim_token` / `claimed_at`）。用于 Runner 心跳超期 / 归零后回收其名下任务。
   *
   * - 条件 UPDATE：仅 `queue_state ∈ {claimed, running}` 命中（`settled` / `queued` / NULL 老行零写入）。
   * - `expectedClaimedBy` 给定 ⇒ 仅清算该领取者名下的任务（防误清他人）。
   * - `queued_at` 保留原值（缺省回填 now）⇒ 重领取沿用原 FIFO 位次。
   * - 返回是否发生迁移（false = 未命中，零写入）。
   * - ⚠️ **v0.8.7 O4：不清 `claimed_by`**（只清 `claim_token` / `claimed_at`）—— 保留领取者
   *   行级痕迹，供 `/runner/result` **补结算窄口**做绑定校验（machine 启动补报须证明
   *   「该行仍绑定本机的历史领取」）。安全性：`listClaimedTasks` 按
   *   `queue_state IN ('claimed','running')` 过滤 ⇒ `queued` 行留着旧 `claimed_by` 不进回收
   *   路径；下次 `claimTask` 覆写；心跳清算的 CAS（`expectedClaimedBy`）照常落空 ⇒ 零涟漪。
   */
  requeueStaleTask(taskId: string, expectedClaimedBy?: string): boolean {
    const now = nowIso();
    const claimedClause = expectedClaimedBy === undefined ? "" : " AND claimed_by = ?";
    const params: string[] = [now, now, taskId];
    if (expectedClaimedBy !== undefined) params.push(expectedClaimedBy);
    const info = this.db
      .prepare(
        `UPDATE tasks
         SET queue_state = 'queued', claim_token = NULL, claimed_at = NULL,
             queued_at = COALESCE(queued_at, ?), updated_at = ?
         WHERE task_id = ? AND queue_state IN ('claimed', 'running')${claimedClause}`,
      )
      .run(...params);
    return Number(info.changes) > 0;
  }

  /**
   * 列出**墙钟超期**的在飞队列任务（`queue_state ∈ {claimed, running}` 且
   * `claimed_at < claimedBefore`；**只读**；v0.8.7 O2 孤儿清算遍历入口）。
   *
   * `claimedBefore` = UTC ISO 8601 截止刻（调用方按 `now - orphanTimeoutMs` 推导）；
   * ISO 串字典序即时间序，与 `claimed_at` 直接比较成立。`claimed_at IS NULL` 的行
   * （未领取 / 老数据）**永不命中** —— 无领取时刻即无墙钟起点。按 `claimed_at` 升序。
   */
  listOrphanedTasks(claimedBefore: string): QueuedTaskRecord[] {
    if (claimedBefore.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ${QUEUE_TASK_COLUMNS} FROM tasks
          WHERE queue_state IN ('claimed', 'running') AND claimed_at IS NOT NULL AND claimed_at < ?
          ORDER BY claimed_at ASC, updated_at ASC`,
      )
      .all(claimedBefore) as Array<Record<string, unknown>>;
    return rows.map(rowToQueuedTask);
  }

  /**
   * **墙钟判死**（v0.8.7 O2；v0.8.8 O1 改判取值）：单语句 CAS `claimed`/`running` →
   * `state='failed'` + `queue_state='settled'` + `failure_kind = ORPHAN_FAILURE_KIND`
   * （= **`runner`**，直写，不经结果回传口）。
   *
   * ⚠️ **取值不得用 `timeout`**：墙钟判死的任务**不可续跑**（执行体已不在机上），而 `timeout` 是
   * 场景 C 续跑的靶（`timeoutScope="acp-prompt"` + 有实质产出 ⇒ machine 自动续跑一次）——
   * 写成 `timeout` 会让 trace 把「人已走了」显示成「本可续跑」。v0.8.7 的 `infra` 直写随二分废止。
   *
   * ⚠️ **不清 claim 三字段**（`claimed_by` / `claim_token` / `claimed_at` 保留）——
   * §2.9 契约 3：墙钟判死后 machine 的**迟到件**须仍能通过 `/runner/result` 的
   * claim_token 比对、落 `upsertTaskResult` 幂等口（首个终态胜出 ⇒ 零写入 + 200 ack），
   * 否则 machine 侧 outbox `pending` 永不清除。
   * - `finished_at` 仅首次填充（COALESCE，与 `upsertTaskResult` 同纪律）；**不动 `text`**。
   * - 返回是否发生迁移（false = 未命中：已结算 / 已被心跳清算 requeue，零写入零事件）。
   */
  failOrphanedTask(taskId: string): boolean {
    const now = nowIso();
    const info = this.db
      .prepare(
        `UPDATE tasks
         SET state = 'failed', queue_state = 'settled', failure_kind = ?,
             finished_at = COALESCE(finished_at, ?), updated_at = ?
         WHERE task_id = ? AND queue_state IN ('claimed', 'running')`,
      )
      .run(ORPHAN_FAILURE_KIND, now, now, taskId);
    return Number(info.changes) > 0;
  }

  /**
   * **失败分类写口**（v0.8.7 O3，改造文档 §2.3 写口 (i)）：把 `failure_kind` 落为
   * **六类闭集**之一（清单见 `types.ts` 的 `FAILURE_KINDS`；v0.8.8 O1 硬切，取代旧二分 `{infra, task}`）。
   * 分类值由**调用方**给出 = machine 上报的 `failureKind`（**事实源**），仅在其不合闭集时
   * 才走 `bridge/runner.ts` 的**兜底映射**（**不是** orch 二次分类，改造文档 §3.3）。
   *
   * `AND state = 'failed'` ⇒ **只在「本次上报胜出终态」时生效**（与 {@link upsertTaskResult}
   * 的「首个终态胜出」同语义）：迟到 / 重复上报（行已终态、或已被墙钟判死为 `runner`）⇒
   * **零写入**，故分类不会被后来的重复件改写。
   *
   * - 返回是否发生写入（false = 行不存在 / 该行非 `failed`）。
   * - **不动 `updated_at`**：分类是既有终态行的附属标注，不代表一次状态推进。
   * - 另一处写口 = 墙钟 sweep {@link failOrphanedTask}（自置 `runner`）；
   *   **派发失败路径（`scheduler.ts`）本版不写**。
   */
  setTaskFailureKind(taskId: string, kind: FailureKind): boolean {
    const info = this.db
      .prepare(`UPDATE tasks SET failure_kind = ? WHERE task_id = ? AND state = 'failed'`)
      .run(kind, taskId);
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
   *
   * v0.8.8 O2（§2.6）：本次写入胜出且新态为终态（`isFinishedState`）⇒ 补发结算事件
   * （kind 映射沿用 `updateTaskState` 三分支：`blocked → task.blocked`，其余终态 → `task.settled`）；
   * 迟到 / 重复上报被「首个终态胜出」WHERE 挡成零写入 ⇒ 零事件（幂等）。
   *
   * v0.8.8 O3（§2.2 / §2.5）：同一写口顺带落 `diagnostics_json`（宽 JSON **原文**）并派生
   * **`task.continued`** 事件 —— 落列与发事件都只在「**本次上报胜出首个终态**」时发生
   * （与 `setTaskFailureKind` 的分类写口同一道门 ⇒ 迟到件既不改分类也不改诊断、不重发事件；
   * 非终态的 `working` / `input-required` 进度更新照常刷新诊断）。派生判据只看
   * `continueAttempts > 0`，**与该结果是否终态无关**（续跑后转 `input-required` 同样留痕；
   * 不发 `feature.failure_report` —— 续跑未收敛）。
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
    // 结算前读记账列（本方法不动这三列，先读保证 payload 取「结算时点」值）：
    // `retry_count` = `attempt` 口径；`failure_kind` 的分类写口（`setTaskFailureKind`）
    // 晚于本调用点 ⇒ 未分类时键省略；`state` 供「首个终态胜出」门判据。
    const pre = this.db
      .prepare(`SELECT state, retry_count, failure_kind FROM tasks WHERE task_id = ?`)
      .get(rec.taskId) as
      | { state: string; retry_count: number | null; failure_kind: string | null }
      | undefined;
    // 「首个终态胜出」门（与 `bridge/runner.ts` 写分类的同一条门）：行此前非终态 ⇒ 本次写入胜出；
    // UPDATE 侧 WHERE 已保证迟到件零写入，这里另挡「迟到件携带的 diagnostics」不改写既有账。
    const firstSettle = pre === undefined || !isFinishedState(pre.state as TaskState);
    const diagnosticsJson = serializeDiagnostics(rec.diagnostics);
    const info = this.db
      .prepare(
        `INSERT INTO tasks
           (task_id, project_id, context_id, state, artifacts_json, text, feature_id, remote_task_id,
            diagnostics_json,
            updated_at, created_at, started_at, finished_at, queue_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled')
         ON CONFLICT(task_id) DO UPDATE SET
           state = excluded.state,
           artifacts_json = COALESCE(excluded.artifacts_json, artifacts_json),
           text = COALESCE(excluded.text, text),
           remote_task_id = COALESCE(excluded.remote_task_id, remote_task_id),
           diagnostics_json = COALESCE(excluded.diagnostics_json, diagnostics_json),
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
        firstSettle ? diagnosticsJson : null,
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
    const stored = rowToQueuedTask(row);
    // changes>0 =「本次上报确有胜出写入」（迟到 / 重复 ⇒ 零写入 ⇒ 零事件，与 ack 幂等同语义）。
    const written = Number(info.changes) > 0;
    // 双门：`written` =「本次上报胜出终态」；isFinishedState = working 进度更新不发结算事件。
    if (written && isFinishedState(stored.state)) {
      const kind = stored.state === "blocked" ? EVENT_TASK_BLOCKED : EVENT_TASK_SETTLED;
      const payload: Record<string, unknown> = {
        taskId: stored.taskId,
        state: stored.state,
        attempt: pre?.retry_count ?? 0,
        // 续跑口径 = 本次落库的 diagnostics 原文（O3 起有数据源；机侧未带 ⇒ 0，与 O2 口径一致）
        continueAttempts: readContinueAttempts(stored.diagnosticsJson ?? null),
        machineId: rec.machineId,
      };
      if (pre?.failure_kind != null) {
        // 与 `rowToTask` 同一读侧口径：存量旧值 ⇒ 兜底 + warn（账单不得带出闭集外的取值）
        payload.failureKind = coerceStoredFailureKind(pre.failure_kind);
      }
      this.appendEvent({
        featureId: stored.featureId,
        taskId: stored.taskId,
        kind,
        state: stored.state,
        payload: JSON.stringify(payload),
      });
    }
    // **`task.continued` 派生事件**（§2.2）：仅在 diagnostics 带出 `continueAttempts > 0` 时发，
    // 一次胜出上报 ⇒ 至多一条（重复 / 迟到件被 `written` 挡）。**不发** `feature.failure_report`
    // （那是调度器在「失败收敛静止」时的账单，续跑不产出收敛）。
    const continued = readDiagnosticsObject(stored.diagnosticsJson ?? null);
    if (written && continued.continueAttempts > 0 && continued.obj !== null) {
      this.appendEvent({
        featureId: stored.featureId,
        taskId: stored.taskId,
        kind: EVENT_TASK_CONTINUED,
        state: stored.state,
        payload: JSON.stringify(
          continuedEventPayload({
            taskId: stored.taskId,
            machineId: rec.machineId,
            projectId: stored.projectId,
            obj: continued.obj,
            continueAttempts: continued.continueAttempts,
          }),
        ),
      });
    }
    return stored;
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
        `INSERT INTO features (feature_id, state, title, requirement, context_id, owner_group, parent_feature_id, stage, version, approval, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(feature_id) DO UPDATE SET
           state = excluded.state,
           title = excluded.title,
           requirement = excluded.requirement,
           context_id = COALESCE(excluded.context_id, context_id),
           stage = excluded.stage,
           version = excluded.version,
           approval = excluded.approval,
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
        // v0.9.3 O1 父需求 = 建 Feature 时一次性写入（同 owner_group 语义：重跑不改父，
        // 故**不进 DO UPDATE SET**）。NULL = 无父。校验（存在性 + 可见性）在 handler，存储层不复核。
        rec.parentFeatureId ?? null,
        // v0.9.0 登记三列：存储层**不补缺省、不复核闭集**（缺省由 handler 施加、校验由 handler 做；
        // 登记面不得抛）。缺省不传 ⇒ NULL，读侧按缺省归一（见 `readStage`）。
        // 重跑（ON CONFLICT）按入参**重写**（与 state / title 同族语义）；只想改登记请用 advance。
        rec.stage ?? null,
        rec.version ?? null,
        rec.approval ?? null,
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

  /**
   * 更新 Feature **登记字段**（`stage` / `version` / `approval`；v0.9.0 B1″）。
   * 仅提供的字段被写入（undefined = 保留原值）；Feature 不存在时返回 null。
   *
   * 与 {@link updateFeatureState} 的分工：本写口**不碰 `state` 列、不写 `feature.state` 事件**
   * —— 登记字段是观测面，主链零变更。
   * `updated_at` 照其它写口一样前进（这是一次真实写入，不是迁移归一）。
   *
   * **v0.9.0 B3″ 起**顺带发 {@link EVENT_FEATURE_STAGE}：diff 在**读侧归一之后**的值面上做
   * （`NULL` 存量行被写成缺省值 ⇒ 归一后相等 ⇒ **不算变化、不发事件**），
   * **三字段任一真变化 ⇒ 恰好一条**（同值重复写 ⇒ **零事件**）。
   */
  updateFeatureRegistration(
    featureId: string,
    patch: FeatureRegistrationPatch,
  ): FeatureRecord | null {
    const sets: string[] = [];
    const params: Array<string> = [];
    if (patch.stage !== undefined) {
      sets.push("stage = ?");
      params.push(patch.stage);
    }
    if (patch.version !== undefined) {
      sets.push("version = ?");
      params.push(patch.version);
    }
    if (patch.approval !== undefined) {
      sets.push("approval = ?");
      params.push(patch.approval);
    }
    if (sets.length === 0) return this.getFeature(featureId);
    const previous = this.getFeature(featureId);
    sets.push("updated_at = ?");
    params.push(nowIso());
    params.push(featureId);
    this.db.prepare(`UPDATE features SET ${sets.join(", ")} WHERE feature_id = ?`).run(...params);
    const stored = this.getFeature(featureId);
    if (previous !== null && stored !== null) {
      const diff: Array<{ field: string; from: string; to: string }> = [];
      if (previous.stage !== stored.stage) {
        diff.push({ field: "stage", from: previous.stage, to: stored.stage });
      }
      if (previous.version !== stored.version) {
        diff.push({ field: "version", from: previous.version, to: stored.version });
      }
      if (previous.approval !== stored.approval) {
        diff.push({ field: "approval", from: previous.approval, to: stored.approval });
      }
      if (diff.length > 0) {
        this.appendEvent({
          featureId,
          taskId: null,
          kind: EVENT_FEATURE_STAGE,
          state: null,
          payload: JSON.stringify({ fields: diff }),
        });
      }
    }
    return stored;
  }

  /**
   * **版本台账存在性读口**（v0.10.0 O5 · 改造文档 §2.1(4)）：给定 `(owner_group, version)` 判断是否
   * 命中 O1 版本台账（`versions` 表 PK）。
   *
   * - `exists = true` ⇒ 该 `(owner_group, version)` 已在台账内（排期锁与 `released` 锁由 O4 在此读口
   *   之上执法，本节点不做）；
   * - `exists = false` ∧ `ledgerReady = true` ⇒ 台账已建表但无此版号（存在性校验 ⇒ 拒）；
   - `ledgerReady = false` ⇒ 台账表**尚未由 O1 建立**（过渡态）。此时**不能**把「无表」误判成
   *   「版号不存在」—— 那会把写侧的**所有** version 一刀切挡死，与「O1 未落地 ⇒ 校验未开」的意图相反。
   *   调用方（feature-tools 写口）**在此路径下跳过存在性检查**（**shape 校验仍生效**）；O1 落表后
   *   本读口自动切换到执法路径，无需再改本节点代码。
   *
   * **owner_group 语义**（照 `featureOwnershipPredicate` 口径）：
   - 非空 ⇒ 精确匹配 `owner_group = ?`；
   - `null` / `undefined` ⇒ 匹配 `owner_group IS NULL`（**不放开为「任意组」**，避免跨组串台账）。
   *
   * **不做 normalize**：trim 由调用方负责（写口在 parseRegistration 已 trim）；本读口按字面串查，
   * 与 §2.1(4)「不做脏值归一」口径一致 —— **不改写存量行**。
   */
  versionLedgerHas(
    ownerGroup: string | null | undefined,
    version: string,
  ): { exists: boolean; ledgerReady: boolean } {
    try {
      const row =
        ownerGroup === null || ownerGroup === undefined
          ? this.db
              .prepare("SELECT 1 AS hit FROM versions WHERE owner_group IS NULL AND version = ? LIMIT 1")
              .get(version)
          : this.db
              .prepare("SELECT 1 AS hit FROM versions WHERE owner_group = ? AND version = ? LIMIT 1")
              .get(ownerGroup, version);
      return { exists: row !== undefined, ledgerReady: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no such table")) return { exists: false, ledgerReady: false };
      throw err;
    }
  }

  /**
   * **台账单行读**（v0.10.0 O1 · 改造文档 §2.1(1)）。
   *
   * `ownerGroup` 是**键的一部分**、不是过滤器 ⇒ 这里**不接受 `undefined`**：
   * `null` = 匿名档（未配组），`"g1"` = g1 组。定位用 **NULL-safe `IS`**，
   * 因为 `owner_group = ?` 对 NULL 行恒不成立（会把匿名档读成「不存在」）。
   */
  versionLedgerGet(ownerGroup: string | null, version: string): VersionLedgerRecord | null {
    const row = this.db
      .prepare(`SELECT ${VERSION_LEDGER_COLUMNS} FROM versions WHERE owner_group IS ? AND version = ?`)
      .get(ownerGroup, version) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToVersionLedger(row);
  }

  /**
   * **台账列表读**（v0.10.0 O1）—— `GET /api/versions` 的**板读投影唯一来源**（§2.1(2) / §2.3(1)）。
   *
   * 过滤语义与 {@link SessionStore.listFeatures} 的 `ownerGroup` 逐字对齐：
   * - `undefined` ⇒ **全量**（未配组环境的匿名入口 / 3300 运维全量视图）；
   * - 组名字符串 ⇒ **仅本组**；
   * - `null` ⇒ **仅匿名档**（`owner_group IS NULL` 行）—— 板按组读取时用不到此档，
   *   给一次性迁移脚本与运维查数留口。
   *
   * 排序 = `(owner_group, version)` 字典序（**不按 updatedAt**：读投影要做「集合可比对」，
   * 顺序必须只由键决定，否则同一次改版会把行挤出列表中段）。
   */
  versionLedgerList(ownerGroup?: string | null): VersionLedgerRecord[] {
    const clause =
      ownerGroup === undefined
        ? ""
        : ownerGroup === null
          ? "WHERE owner_group IS NULL"
          : "WHERE owner_group = ?";
    const rows = this.db
      .prepare(
        `SELECT ${VERSION_LEDGER_COLUMNS} FROM versions ${clause} ORDER BY owner_group, version`,
      )
      .all(...(ownerGroup === undefined || ownerGroup === null ? [] : [ownerGroup])) as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToVersionLedger);
  }

  /**
   * **建版（台账建行）**（v0.10.0 O2a · 改造文档 §2.1(2)）—— `POST /api/versions` 的写口。
   *
   * 判据（全部在写口内做完，**任一不过 ⇒ 零写入**，返回结构化失败供 HTTP 面直接映射状态码）：
   * 1. **shape**：`version` trim 后必须命中 semver 形状（{@link isVersionShapeValid}）⇒ 否则 400；
   * 2. **status 可建集**：只接受 `notstart`（缺省）/ `active`；**`released` 不可建**
   *    —— 发版是「过闸后的结果」，不是建版参数；直建 `released` 会绕过 O4 发版闸与 O7 快照；
   * 3. **重复 ⇒ 409**：同 `(owner_group, version)` 已存在即拒（**幂等**：二次 POST 不产生第二行、
   *    不改第一行任何列、不写第二条事件）。
   *
   * ⚠ 重复判定**不得依赖 `ON CONFLICT` / `INSERT OR REPLACE`**：本表 PK 含可空列
   * `owner_group`，而 SQLite 的唯一约束把 NULL 视为互不相等 ⇒ 匿名档会**静默插出第二行**。
   * 故先 {@link versionLedgerGet} 定位、再插；并发窗口由 SQLite 单写者 + 同进程同步 API 兜住。
   *
   * **不做脏值归一**（§2.1(4) 同口径）：入参原样落，`version` 只 trim。
   */
  versionLedgerCreate(input: VersionLedgerCreateInput): VersionLedgerWriteResult {
    const version = input.version.trim();
    if (version.length === 0) {
      return {
        ok: false,
        code: ERR_VERSION_SHAPE,
        message: "version 不得为空串（撤排期不进台账，属 features.version 语义）",
        status: 400,
      };
    }
    if (!isVersionShapeValid(version)) {
      return {
        ok: false,
        code: ERR_VERSION_SHAPE,
        message: `非法 version "${input.version}"：期望 semver 形状 vX.Y.Z（可省 v、可带 -prerelease/+build）`,
        status: 400,
      };
    }
    const status = input.status ?? "notstart";
    if (status === "released" || !isVersionLedgerStatus(status)) {
      return {
        ok: false,
        code: ERR_VERSION_STATUS,
        message: `非法 status "${String(status)}"（建版可集：notstart / active；released 只能经设状态端点过 O4 闸）`,
        status: 400,
      };
    }
    if (this.versionLedgerGet(input.ownerGroup, version) !== null) {
      return {
        ok: false,
        code: ERR_VERSION_EXISTS,
        message: `版本已存在（owner_group=${input.ownerGroup === null ? "NULL" : `"${input.ownerGroup}"`} · version=${version}）`,
        status: 409,
      };
    }
    const at = nowIso();
    const record: VersionLedgerRecord = {
      ownerGroup: input.ownerGroup,
      version,
      status,
      date: input.date ?? null,
      note: input.note ?? null,
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO versions (owner_group, version, status, date, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.ownerGroup,
        record.version,
        record.status,
        record.date,
        record.note,
        record.createdAt,
        record.updatedAt,
      );
    this.appendEvent({
      featureId: null,
      taskId: null,
      kind: EVENT_VERSION_LEDGER_CREATED,
      state: null,
      payload: JSON.stringify({
        ownerGroup: record.ownerGroup,
        version: record.version,
        status: record.status,
      }),
    });
    return { ok: true, record };
  }

  /**
   * **删版（台账删行 + 名下卡同事务清 `version`）**（v0.10.0 O2a · v0.10.7 n2 重写）——
   * `DELETE /api/versions/{version}` 的写口。
   *
   * 两道判据，**任一命中 ⇒ 不删**（结构化失败，零写入、零事件）：
   * 1. **白名单**：`versionLedgerStatus(...).status ∈ {notstart, active}` 才放行 —— `released`
   *    ⇒ 409 {@link ERR_VERSION_RELEASED_LOCKED}（**发版事实不可撤销**：删了就没有「已发版」的读
   *    投影，板 §2.3(1) 的「锁只紧不松」失去依据）；无行 / 表未就绪 / 脏值折叠成 `null`
   *    ⇒ 404 {@link ERR_VERSION_UNKNOWN}（**只紧不松** —— 读不到即挡，不得当作可删放行）。
   *    判据面**只读 {@link SessionStore.versionLedgerStatus}**，不读 {@link SessionStore.versionLedgerGet}：
   *    后者对脏 `status` / 无表 **throw**，会把「表未就绪」变成 500 而不是拒删。
   * 2. **名下不存在挡删卡**（四桶判据 = {@link SessionStore.classifyVersionCardsForDelete}，
   *    单源在 n1，本口不回述条件）：`blockedCompleted` ∪ `blockedOpen` 任一非空 ⇒ 409
   *    {@link ERR_VERSION_OPEN_CARDS}，message 内**分档并带卡 id 清单**。
   *    **码名不改** —— `completed` 入挡删集后，该码的 `open` 语义扩为「**不可清**」（README 由 n4 登记）。
   *
   * **清卡 + 删行 + 事件 = 同一事务**（`BEGIN IMMEDIATE`）：分步写会留下「卡仍指向已消解版号」的
   * 幽灵版号链。逐卡清 `version` 复用 {@link SessionStore.updateFeatureRegistration}（空串 = 既有
   * 撤排期语义，不另立专用口）⇒ 每卡自带一条 {@link EVENT_FEATURE_STAGE} diff 事件。
   * ⚠ 事务体内**不得**调 {@link SessionStore.versionLedgerActivate}（它自开 `BEGIN IMMEDIATE`
   * ⇒ better-sqlite3 嵌套事务报错）。
   *
   * **只删 `versions` 行**：不碰 `feature_projects` / `project_versions` / `releases`（乙案 = 零新写面；
   * 归属行成为**只读历史引用**，见 `需求流程.md` §7「版本删除纪律」判据 3），也不回写 `approval`
   * （单向无回边）。快照只在标记 `released` 时产生，而 `released` 已被判据 1 挡住 ⇒ 可达此处的行必然无快照。
   */
  versionLedgerDelete(ownerGroup: string | null, version: string): VersionLedgerWriteResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const probe = this.versionLedgerStatus(ownerGroup, version);
      if (!probe.ledgerReady) {
        this.db.exec("ROLLBACK");
        return {
          ok: false,
          code: ERR_VERSION_UNKNOWN,
          message: `台账表未就绪（versions 表不存在）⇒ 白名单不放行（只紧不松；version=${version}）`,
          status: 404,
        };
      }
      if (probe.status === "released") {
        this.db.exec("ROLLBACK");
        return {
          ok: false,
          code: ERR_VERSION_RELEASED_LOCKED,
          message: `已发版版本不可删除（version=${version} 处于 released 终态；发版事实归 releases 快照与 git tag）`,
          status: 409,
        };
      }
      if (probe.status !== "notstart" && probe.status !== "active") {
        this.db.exec("ROLLBACK");
        return {
          ok: false,
          code: ERR_VERSION_UNKNOWN,
          message: `台账无此行或 status 不可读（version=${version} · status=${String(probe.status)}：脏值折叠成 null 同拒）⇒ 白名单只放行 notstart / active`,
          status: 404,
        };
      }
      const buckets = this.classifyVersionCardsForDelete(ownerGroup, version);
      if (buckets.blockedCompleted.length > 0 || buckets.blockedOpen.length > 0) {
        this.db.exec("ROLLBACK");
        return {
          ok: false,
          code: ERR_VERSION_OPEN_CARDS,
          message:
            `名下有不可清卡，须先收口或撤排期回池再删版（version=${version}）：` +
            `completed[${buckets.blockedCompleted.length}]=${idList(buckets.blockedCompleted)}（已交付，清 version 会断交付账）` +
            ` / 未收口且不可回池[${buckets.blockedOpen.length}]=${idList(buckets.blockedOpen)}（不满足「需求分析 ∧ 未发起」）`,
          status: 409,
        };
      }
      const record = this.versionLedgerGet(ownerGroup, version);
      if (record === null) {
        throw new Error(
          `[session-store] versionLedgerDelete 白名单通过后未能读回台账行：version=${version}`,
        );
      }
      const clearPlan = [
        ...buckets.clearPool.map((card) => ({ card, cardClass: "pool" as const })),
        ...buckets.clearCancelled.map((card) => ({ card, cardClass: "cancelled" as const })),
      ].sort((a, b) => (a.card.featureId < b.card.featureId ? -1 : 1));
      const cleared = clearPlan.map(({ card, cardClass }) => {
        this.updateFeatureRegistration(card.featureId, { version: "" });
        return {
          featureId: card.featureId,
          cardClass,
          state: card.state,
          stage: card.stage,
          approval: card.approval,
          decisions: card.decisions,
        };
      });
      this.db
        .prepare("DELETE FROM versions WHERE owner_group IS ? AND version = ?")
        .run(ownerGroup, version);
      this.appendEvent({
        featureId: null,
        taskId: null,
        kind: EVENT_VERSION_LEDGER_DELETED,
        state: null,
        payload: JSON.stringify({
          ownerGroup,
          version,
          status: record.status,
          // v0.10.7 n2 扩键（★只增键）：returnedToPool ⊆ cleared[]（仅计可回池档，两个长度不得相加当两批卡）
          returnedToPool: buckets.clearPool.length,
          cleared,
        }),
      });
      this.db.exec("COMMIT");
      return { ok: true, record };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务已不在活动态：保留原始错误，不掩盖
      }
      throw err;
    }
  }

  /**
   * **手动设状态**（v0.10.0 O2c · 改造文档 §2.1(2)）—— `PATCH /api/versions/{version}/status` 的
   * **非发版分支**写口（`notstart ↔ active`）。
   *
   * 判据（任一不过 ⇒ 零写入，结构化失败供 HTTP 面映射）：
   * 1. 台账无此行 ⇒ 404 {@link ERR_VERSION_UNKNOWN}（设状态只能对已登记版号发生）；
   * 2. **`released` 为终态、不可回退** ⇒ 现态 `released` 时改态一律 409
   *    {@link ERR_VERSION_RELEASED_LOCKED}（发版事实不可撤销）；
   * 3. **目标 `released` 不经本口** ⇒ 400 {@link ERR_VERSION_STATUS}（发版必须走
   *    {@link SessionStore.versionLedgerMarkReleased} 的闸 + 快照同事务）；
   * 4. 同态同 note ⇒ **幂等**（`changed: false` 语义，零事件、零改 `updated_at`）。
   *
   * 非发版状态切换落一条 {@link EVENT_VERSION_STATUS_CHANGED}（审计留痕，与自动转换的
   * {@link EVENT_VERSION_ACTIVATED} 区分：前者人工、后者引擎内部）。
   */
  versionLedgerSetStatus(input: VersionLedgerSetStatusInput): VersionLedgerWriteResult {
    const version = input.version.trim();
    if (version.length === 0) {
      return {
        ok: false,
        code: ERR_VERSION_SHAPE,
        message: "version 不得为空串（设状态必须指名版号）",
        status: 400,
      };
    }
    const row = this.versionLedgerGet(input.ownerGroup, version);
    if (row === null) {
      return {
        ok: false,
        code: ERR_VERSION_UNKNOWN,
        message: `台账无此行（owner_group=${input.ownerGroup === null ? "NULL" : `"${input.ownerGroup}"`} · version=${version}）`,
        status: 404,
      };
    }
    if (row.status === "released") {
      return {
        ok: false,
        code: ERR_VERSION_RELEASED_LOCKED,
        message: `已发版版本不可回退（version=${version} 处于 released 终态；发版事实归 releases 快照与 git tag，不可撤销）`,
        status: 409,
      };
    }
    if (input.status === "released") {
      return {
        ok: false,
        code: ERR_VERSION_STATUS,
        message: "状态 released 只能经发版分支（发版闸 + 快照同事务）落定，不经手动设状态口",
        status: 400,
      };
    }
    if (!isVersionLedgerStatus(input.status)) {
      return {
        ok: false,
        code: ERR_VERSION_STATUS,
        message: `非法 status "${String(input.status)}"（手动设状态可集：notstart / active）`,
        status: 400,
      };
    }
    const note =
      input.note === undefined
        ? row.note
        : input.note === null || input.note.trim() === ""
          ? null
          : input.note.trim();
    if (row.status === input.status && row.note === note) {
      return { ok: true, record: row }; // 幂等：同值重写零写入、零事件
    }
    const at = nowIso();
    this.db
      .prepare(
        "UPDATE versions SET status = ?, note = ?, updated_at = ? WHERE owner_group IS ? AND version = ?",
      )
      .run(input.status, note, at, input.ownerGroup, version);
    const updated = this.versionLedgerGet(input.ownerGroup, version);
    const record: VersionLedgerRecord = updated ?? { ...row, status: input.status, note, updatedAt: at };
    this.appendEvent({
      featureId: null,
      taskId: null,
      kind: EVENT_VERSION_STATUS_CHANGED,
      state: null,
      payload: JSON.stringify({
        ownerGroup: input.ownerGroup,
        version,
        from: row.status,
        to: input.status,
      }),
    });
    return { ok: true, record };
  }

  /**
   * **自动转 `active`（引擎内部 · 幂等）**（v0.10.0 O2c · 改造文档 §2.1(2) · v0.10.7 n3 扩 `trigger`）——
   * 「门① 的 `stage` 登记写 / `approve` 放行 / 首个节点派发」触发的 `notstart → active`，**不开放板写口**。
   *
   * 语义（三护栏的**幂等**落点）：
   * - 行不存在 / 台账未就绪 ⇒ **不建行**、`activated = false`（自动转换只翻**已登记**版号，
   *   建版归 O2a；缺失行由写口的存在性校验在排期时挡）；
   * - 现态非 `notstart`（`active` / `released`）⇒ 零写入、零事件 ⇒ `activated = false`；
   * - 现态 `notstart` ⇒ 同事务 `UPDATE status='active'` + 一条 {@link EVENT_VERSION_ACTIVATED}
   *   ⇒ `activated = true`（**失败不吞**：抛给调用方的护栏兜，见 `bridge/versions-activation.ts`）。
   *
   * 并发：`BEGIN IMMEDIATE` 内**重读**再判（与 {@link SessionStore.versionLedgerMarkReleased}
   * 同口径）⇒ 同进程并发触发也不会出现双事件 / 双写。
   *
   * `trigger`（v0.10.7 n3）**本层给缺省 `"dispatch"`**、只进事件 payload、不参与任何判定 ——
   * 三处触发点里两处的既有两参直调因此不必改写；护栏层（activator）必填、逐处显式传。
   */
  versionLedgerActivate(
    ownerGroup: string | null,
    version: string,
    trigger: VersionActivationTrigger = "dispatch",
  ): VersionActivationResult {
    const v = version.trim();
    if (v.length === 0) return { activated: false, status: null, ledgerReady: true };
    const probe = this.versionLedgerStatus(ownerGroup, v);
    if (!probe.ledgerReady) return { activated: false, status: null, ledgerReady: false };
    if (probe.status !== "notstart") return { activated: false, status: probe.status, ledgerReady: true };
    const at = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.versionLedgerGet(ownerGroup, v);
      if (current === null || current.status !== "notstart") {
        this.db.exec("COMMIT");
        return { activated: false, status: current === null ? null : current.status, ledgerReady: true };
      }
      this.db
        .prepare("UPDATE versions SET status = 'active', updated_at = ? WHERE owner_group IS ? AND version = ?")
        .run(at, ownerGroup, v);
      this.appendEvent({
        featureId: null,
        taskId: null,
        kind: EVENT_VERSION_ACTIVATED,
        state: null,
        payload: JSON.stringify({ ownerGroup, version: v, from: "notstart", to: "active", trigger }),
      });
      this.db.exec("COMMIT");
      return { activated: true, status: "active", ledgerReady: true };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务已不在活动态：保留原始错误，不掩盖
      }
      throw err;
    }
  }

  /**
   * 版号名下卡的**分档账面读取**（v0.10.7 n1）—— {@link SessionStore.classifyVersionCardsForDelete}
   * 的唯一读取面（扩列后单点，判据不再分两份 SELECT 各写一条）。
   *
   * **刻意不复用 {@link SessionStore.aggregateFeaturesByVersion}**：聚合面的 `ownerGroup`
   * 语义是「`undefined` ⇒ 全量」，而删版判据要的是**台账键的精确一档**（`null` ⇒ 仅匿名档）。
   * 拿全量当精确档会把**别组的同名版号卡**算进来 ⇒ 误挡删版（fail-closed 方向，
   * 但会把合法操作挡死）。归属匹配用 NULL-safe `IS`，与 {@link versionLedgerGet} 同键口径。
   *
   * 排序 = `feature_id` 升序（分桶后各桶内序确定 ⇒ n2 事件 payload 的 `cleared[]` 可比对）。
   */
  private readVersionCardsForDelete(
    ownerGroup: string | null,
    version: string,
  ): VersionDeleteCard[] {
    const rows = this.db
      .prepare(
        `SELECT feature_id, state, stage, approval, decisions
         FROM features WHERE owner_group IS ? AND version = ?
         ORDER BY feature_id`,
      )
      .all(ownerGroup, version) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      featureId: readString(row, "feature_id"),
      state: readString(row, "state"),
      stage: readStage(row),
      approval: readApproval(row),
      decisions: readNullableString(row, "decisions"),
    }));
  }

  /**
   * **删版分档（纯读，零副作用）**（v0.10.7 n1 · 改造文档 §2.1 n1）—— 把「可回池档」伪码
   * （§2.0，与板侧 `deriveScheduleGateOpen` 逐字同构）落成四桶，供 {@link versionLedgerDelete}
   * 的拒因分档与清卡事务接线。
   *
   * 判据（唯一措辞源 = 改造文档 §2.1 n1 伪码，照抄）：
   * - **挡删集** = `{state === "completed"}` ∪ `{state ∉ {"completed","cancelled"} ∧ ¬可回池档}`
   * - **清卡集** = `{state === "cancelled"}` ∪ `{state ∉ {"completed","cancelled"} ∧ 可回池档}`
   *
   * 其中**可回池档** = `stage === "需求分析" ∧ approval === "未发起"`（正向严格合取；两枚登记字段
   * 是两次独立写、不保证同序 ⇒ **不得以 `stage` 单枚代判**）。四桶互斥且并集 = 名下全部卡。
   *
   * ⚠ 本函数**只是分档**，不是放行判据的全体：台账行存在性 / `status` 白名单仍归
   * {@link versionLedgerDelete}（可删集判据**只允许存在于一处**，读面不得另算一份）。
   */
  classifyVersionCardsForDelete(
    ownerGroup: string | null,
    version: string,
  ): VersionDeleteClassification {
    const buckets: VersionDeleteClassification = {
      blockedCompleted: [],
      blockedOpen: [],
      clearPool: [],
      clearCancelled: [],
    };
    for (const card of this.readVersionCardsForDelete(ownerGroup, version)) {
      if (card.state === "completed") buckets.blockedCompleted.push(card);
      else if (card.state === "cancelled") buckets.clearCancelled.push(card);
      else if (isVersionCardBackToPool(card)) buckets.clearPool.push(card);
      else buckets.blockedOpen.push(card);
    }
    return buckets;
  }

  // ------------------------------------------------------------------
  // v0.10.0 O7：发版快照（`releases` 表 · 与 `versions.status` 同事务写入 · 不可变）
  // ------------------------------------------------------------------

  /**
   * **发版快照单行读**（v0.10.0 O7 · 改造文档 §2.1(1)）—— 键定位口径与
   * {@link SessionStore.versionLedgerGet} 逐字一致（NULL-safe `IS`，`ownerGroup` 是键的一部分）。
   *
   * 判据用途：{@link SessionStore.versionLedgerMarkReleased} 的事务内「快照是否已存在」检查
   * （不可变 ⇒ 存在即不覆写）。
   */
  releaseSnapshotGet(ownerGroup: string | null, version: string): ReleaseSnapshotRecord | null {
    const row = this.db
      .prepare(`SELECT ${RELEASE_COLUMNS} FROM releases WHERE owner_group IS ? AND version = ?`)
      .get(ownerGroup, version) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToReleaseSnapshot(row);
  }

  /**
   * **发版快照列表读**（v0.10.0 O7）—— 板 §2.3(3)「版本列 = **引擎 Release 清单** ∪ 卡派生版号」
   * 左半的数据源（右半 = O3 {@link SessionStore.aggregateFeaturesByVersion}）。
   *
   * 过滤与排序口径与 {@link SessionStore.versionLedgerList} 逐字对齐（`undefined` ⇒ 全量 /
   * 组名 ⇒ 本组 / `null` ⇒ 仅匿名档；排序只由键决定，顺序可比对）。
   *
   * **不含未发版版本**：`releases` 只在标记 `released` 那一刻落行 ⇒ 本清单天然等于「已发版集合」，
   * 不需要（也不得）再按 status 过滤。
   */
  releaseSnapshotList(ownerGroup?: string | null): ReleaseSnapshotRecord[] {
    const clause =
      ownerGroup === undefined
        ? ""
        : ownerGroup === null
          ? "WHERE owner_group IS NULL"
          : "WHERE owner_group = ?";
    const rows = this.db
      .prepare(
        `SELECT ${RELEASE_COLUMNS} FROM releases ${clause} ORDER BY owner_group, version`,
      )
      .all(...(ownerGroup === undefined || ownerGroup === null ? [] : [ownerGroup])) as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToReleaseSnapshot);
  }

  /**
   * **标记 `released` + 落快照（同事务）**（v0.10.0 O7 · 改造文档 §2.1(1)）——
   * 发版动作（O2b 的 `PATCH /api/versions/{version}/status` 的 `released` 分支）的唯一写口。
   *
   * **为什么必须同事务**：`versions.status = released` 是**排期锁**的事实源，`releases` 行是
   * **发版事实**（哪些仓、哪个 ref、CHANGELOG 锚点）的唯一承载。两者分开写 ⇒ 任一步崩在半路都会
   * 留下「已锁但无事实」或「有事实但未锁」的半成品版本，而两者都不可事后自动补齐（前者板会放行
   * 排期、后者发版闸拿不到清单）。故一个事务内做完：UPDATE 台账 + INSERT 快照 + **级联 project
   * 版本置 `released`**（v0.10.1 O4 · C-4，见
   * {@link SessionStore.cascadeProjectVersionsReleased}）+ 事件留痕。
   *
   * **发版只有一个动作**（C-4）：本口即该动作的唯一写口 —— **不存在**「project 自己发自己的版」
   * 的第二入口，也**不存在**「Group 已 `released` 而其触达的 project 版本仍 `open`」的存续形态。
   * 级联任一步失败 ⇒ 整个事务回滚（Group 状态**不落**），不留半成品。
   *
   * **本写口不判发版闸**（判据在 O4 `evaluateReleaseGate`，由调用方在进事务**之前**评）——
   * 闸要读 `features` 聚合（O3 面），搬进事务会把「聚合读」纳入写锁窗口；SQLite 单写者 +
   * 同进程同步 API ⇒ 「闸后写」的并发窗口与 {@link SessionStore.versionLedgerCreate}
   * 的「先 get 再 INSERT」同一口径（同一套护栏，不另立）。
   *
   * 语义（四种入参落点，`releases` **只 INSERT、绝不 UPDATE/DELETE**；级联只 UPDATE
   * `project_versions.status`）：
   * 1. 台账未 `released` ∧ 无快照 ⇒ **正常发版**：UPDATE status + INSERT 快照 + 级联 + 事件
   *    （`backfilled = false`），三写同事务；
   * 2. 台账已 `released` ∧ 无快照 ⇒ **补写**（迁移主源导入的历史 `released` 行本就无快照，
   *    §2.1(7)）：只 INSERT 快照 + 级联 + 事件（`backfilled = true`），status 不动 ⇒ 幂等；
   * 3. 已 `released` ∧ 快照已存在 ⇒ **纯幂等**：`releases` 零写入，级联照跑（触达行已 `released`
   *    ⇒ `changes = 0`），无迁移动作即零事件，原样回读既有快照
   *    （不可变 = 第二次标记**不得**改写快照任何一列，入参被忽略）；
   * 4. 台账无此行 ⇒ 404 {@link ERR_VERSION_UNKNOWN}，零写入（发版只能对着已登记的版号发生；
   *    建版归 O2a，本口不代发）。
   *
   * `projects` / `changelogAnchor` / `ref` **原值入快照、不归一**（§2.1(6)）—— 尤其 `repoId`
   * **不查 `runner_projects` 投影**：见 {@link ReleaseSnapshotInput}。
   *
   * ⚠ 版号形状（{@link isVersionShapeValid}）在此**不复核**：台账行已存在即键已成立，
   *   历史导入行的版号可能早于形状校验（O5）落地，复核会把补写路径（判据 2）整体挡死。
   *   空串仍挡（它不是任何行的键）。
   */
  versionLedgerMarkReleased(input: ReleaseSnapshotInput): ReleaseSnapshotWriteResult {
    const version = input.version.trim();
    if (version.length === 0) {
      return {
        ok: false,
        code: ERR_VERSION_SHAPE,
        message: "version 不得为空串（标记 released 必须指名版号）",
        status: 400,
      };
    }
    const ownerGroup = input.ownerGroup;
    const at = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const ledger = this.versionLedgerGet(ownerGroup, version);
      if (ledger === null) {
        this.db.exec("ROLLBACK");
        return {
          ok: false,
          code: ERR_VERSION_UNKNOWN,
          message: `台账无此行（owner_group=${ownerGroup === null ? "NULL" : `"${ownerGroup}"`} · version=${version}），不得对未登记版号发版`,
          status: 404,
        };
      }
      const existing = this.releaseSnapshotGet(ownerGroup, version);
      const snapshotWritten = existing === null;
      let snapshot = existing;
      if (snapshot === null) {
        this.db
          .prepare(
            `INSERT INTO releases (owner_group, version, changelog_anchor, projects_json, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ownerGroup,
            version,
            input.changelogAnchor ?? null,
            JSON.stringify(input.projects ?? []),
            input.note ?? null,
            at,
          );
        const written = this.releaseSnapshotGet(ownerGroup, version);
        if (written === null) {
          throw new Error(
            `[session-store] versionLedgerMarkReleased 落快照后未能读回：version=${version}`,
          );
        }
        snapshot = written;
      }
      const statusMigrated = ledger.status !== "released";
      if (statusMigrated) {
        this.db
          .prepare(
            "UPDATE versions SET status = 'released', updated_at = ? WHERE owner_group IS ? AND version = ?",
          )
          .run(at, ownerGroup, version);
      }
      // **级联**（v0.10.1 O4 · C-4）：发版只有一个动作 = 标 Group `released`，引擎在**同一事务**内
      // 把它名下**被触达**的 project 版本一并置 `released`（随即冻结 —— released 门由 O2 执法）。
      // 数据源 = 归属表（不是 `project_versions` 全表、也不是 `tasks`）：未被该版任何需求触达的
      // project **不产生行、不被发版**（UPDATE 天然不建行）。与状态迁移无条件一起跑：幂等重标记 /
      // 补写路径也跑 ⇒ 「Group 已 `released` 而触达的 project 仍 `open`」这一形态在事务结束时不可能存续。
      const cascade = this.cascadeProjectVersionsReleased(ownerGroup, version, at);
      if (snapshotWritten || statusMigrated || cascade.released > 0) {
        this.appendEvent({
          featureId: null,
          taskId: null,
          kind: EVENT_VERSION_RELEASED,
          state: null,
          payload: JSON.stringify({
            ownerGroup,
            version,
            from: ledger.status,
            to: "released",
            backfilled: !statusMigrated,
            changelogAnchor: snapshot.changelogAnchor,
            projects: snapshot.projects.length,
            // 级联留痕（★只增键，不改既有键语义）：targeted = 触达集大小，released = 本次真的迁了的行数
            projectVersionsTargeted: cascade.targeted,
            projectVersionsReleased: cascade.released,
          }),
        });
      }
      this.db.exec("COMMIT");
      const stored = this.versionLedgerGet(ownerGroup, version);
      if (stored === null) {
        throw new Error(
          `[session-store] versionLedgerMarkReleased 提交后未能读回台账行：version=${version}`,
        );
      }
      return { ok: true, snapshot, ledger: stored, statusMigrated, snapshotWritten };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务已不在活动态：保留原始错误，不掩盖
      }
      throw err;
    }
  }

  /**
   * **Group 发版级联：置 `released` 到该组版名下被触达的 project 版本**（v0.10.1 O4 ·
   * 改造文档 C-4 / §2.2）—— **只在 {@link SessionStore.versionLedgerMarkReleased} 的事务内调用**，
   * 不对外暴露（独立调用会造出「project 自己发自己的版」这一 C-4 明确否认的动作）。
   *
   * 触达集 = `feature_projects` 里 `(owner_group, group_version)` 名下 **去重**的
   * `(project_id, project_version)`（一条需求触达多 project ⇒ 多项；多需求同 project 同版 ⇒ 一项）。
   * `owner_group` 是键的一部分 ⇒ NULL-safe `IS`（`null` = 匿名档），同
   * {@link SessionStore.featureProjectListByVersion} 口径。
   *
   * **不隐式建版**：只对**已存在**的 `project_versions` 行发 UPDATE，且不写 `status` 之外的列；
   * 归属指向一个不存在的 project 版本行（C-15 由 O2 的归属门挡，历史脏数据可能残留）⇒ 本口
   * **不补、不报错**（发版不替台账造行）。已 `released` 的行不重复迁（`changes = 0`），
   * 故幂等重标记不产生第二次留痕。
   */
  private cascadeProjectVersionsReleased(
    ownerGroup: string | null,
    groupVersion: string,
    at: string,
  ): { targeted: number; released: number } {
    const touched = this.db
      .prepare(
        `SELECT DISTINCT project_id, project_version
         FROM feature_projects WHERE owner_group IS ? AND group_version = ?
         ORDER BY project_id, project_version`,
      )
      .all(ownerGroup, groupVersion) as Array<Record<string, unknown>>;
    const stmt = this.db.prepare(
      `UPDATE project_versions SET status = 'released', updated_at = ?
       WHERE owner_group IS ? AND project_id = ? AND version = ? AND status <> 'released'`,
    );
    let released = 0;
    for (const row of touched) {
      const info = stmt.run(
        at,
        ownerGroup,
        readString(row, "project_id"),
        readString(row, "project_version"),
      );
      released += Number(info.changes);
    }
    return { targeted: touched.length, released };
  }

  /**
   * **迁移哨兵存在性读**（v0.10.0 O1 · 改造文档 §2.1(7)）。
   *
   * 判据 = `events` 里是否存在 kind = {@link EVENT_VERSION_LEDGER_MIGRATED} 的行。
   * **刻意不以台账行数 / `exists()` 充当判据**：建版端点（O2a）自己也会造出台账行 ⇒
   * 「台账非空」推不出「板台账已整表导入过」；拿台账当判据会把未迁移库误判成已迁移，
   * 从此**永久漏掉**只能从 `versions.json` 拿到的行（含 `released` 态与原始时间戳）。
   * 哨兵是**独立的一次性痕迹**，与台账行正交。
   *
   * 表缺失（极端：`events` 不存在）⇒ 返回 `false`（= 未迁移），让调用方走「待迁移」分支，
   * 而不是静默跳过。
   */
  versionsLedgerMigrationDone(): boolean {
    try {
      const row = this.db
        .prepare("SELECT 1 AS hit FROM events WHERE kind = ? LIMIT 1")
        .get(EVENT_VERSION_LEDGER_MIGRATED);
      return row !== undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no such table")) return false;
      throw err;
    }
  }

  /**
   * **版本台账状态读口**（v0.10.0 O4 · 改造文档 §2.1(3)）：给定 `(owner_group, version)` 读引擎
   * 版本台账（O1 `versions` 表的 `status` 列，三态 {@link VersionLedgerStatus}），供 **`released` 锁**
   * 与**发版闸**执法。与 {@link versionLedgerHas} 同族（同一张表、同一 `owner_group` 语义、同过渡兜底）。
   *
   * 分流：
   * - `status = "released"` ⇒ 该版**已发版**：排期写 / 宿主 MCP 直写 `version` 一律挡（`released` 锁）；
   * - `status = "notstart" | "active"` ⇒ 未发版：排期写放行（仍受排期写状态锁）；
   * - `status = null` ∧ `ledgerReady = true` ⇒ 台账已建表但无此版号（存在性另由 {@link versionLedgerHas}
   *   挡门；本读口只回状态、不重复挡存在性）；
   * - `ledgerReady = false` ⇒ 台账表**尚未由 O1 建立**（过渡态）。
   *   **排期写**路径在此跳过 `released` 锁（无表 ≠ 已发版，不得一刀切挡所有版号 —— 同 O5 存在性检查）；
   *   **发版闸**路径在此 **fail-closed**（见 `evaluateReleaseGate`：引擎尚未持有台账 ⇒ 不得发布
   *   「既写本地台账又读引擎」的中间态）。O1 落表后本读口自动切执法路径，**无需再改代码**。
   *
   * **不做 normalize**：trim 由调用方负责（写口已在 `parseRegistration` trim）；本读口按字面串查、不改写存量。
   */
  versionLedgerStatus(
    ownerGroup: string | null | undefined,
    version: string,
  ): { status: VersionLedgerStatus | null; ledgerReady: boolean } {
    try {
      const row =
        ownerGroup === null || ownerGroup === undefined
          ? this.db
              .prepare("SELECT status FROM versions WHERE owner_group IS NULL AND version = ? LIMIT 1")
              .get(version)
          : this.db
              .prepare("SELECT status FROM versions WHERE owner_group = ? AND version = ? LIMIT 1")
              .get(ownerGroup, version);
      if (row === undefined) return { status: null, ledgerReady: true };
      const raw = (row as Record<string, unknown>)["status"];
      return { status: isVersionLedgerStatus(raw) ? raw : null, ledgerReady: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no such table")) return { status: null, ledgerReady: false };
      throw err;
    }
  }

  // ===========================================================================
  // v0.10.1 O1：版本面第二级 —— project 台账（`project_versions`）+ 归属 / 承诺集
  // （`feature_projects`）读写口。
  //
  // 本区是**纯数据面**（建版 / 删版 / 取 / 列 / 写归属 / 删归属 / 两方向查归属）。
  // 门与闸 —— C-3「未过门挡归属写」、C-4「Group 发版同事务级联置 released」、
  // C-6 ③④「已归属不可改 / released 即冻结复用」、C-15「归属须指向已存在的版本行」、
  // project 侧 `releasable`（展示判据）—— **一律不在本层**，由后续节点在这组口之上执法。
  // ===========================================================================

  /**
   * **project 台账单行读**（v0.10.1 O1）。定位用 **NULL-safe `IS`**，同 {@link versionLedgerGet}：
   * `owner_group = ?` 对 NULL 行恒不成立 ⇒ 拿它查匿名档会读成「不存在」。
   * `ownerGroup` 是**键的一部分**、不是过滤器 ⇒ 不接受 `undefined`（`null` = 未配组的匿名档）。
   */
  projectVersionGet(
    ownerGroup: string | null,
    projectId: string,
    version: string,
  ): ProjectVersionRecord | null {
    const row = this.db
      .prepare(
        `SELECT ${PROJECT_VERSION_COLUMNS}
         FROM project_versions WHERE owner_group IS ? AND project_id = ? AND version = ?`,
      )
      .get(ownerGroup, projectId, version) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToProjectVersion(row);
  }

  /**
   * **project 台账列表读**（v0.10.1 O1 · C-7）—— `GET /api/versions` 顶层 `projectVersions[]`
   * 的唯一来源（**缺省全表**、可选本组 / 仅匿名档）。过滤语义与 {@link versionLedgerList}
   * 逐字对齐；排序 = `(owner_group, project_id, version)` 字典序 —— **顺序只由键决定**，
   * 同组档理由（读投影要做集合可比对，否则一次改版会把行挤出列表中段）。
   */
  projectVersionList(ownerGroup?: string | null): ProjectVersionRecord[] {
    const clause =
      ownerGroup === undefined
        ? ""
        : ownerGroup === null
          ? "WHERE owner_group IS NULL"
          : "WHERE owner_group = ?";
    const rows = this.db
      .prepare(
        `SELECT ${PROJECT_VERSION_COLUMNS} FROM project_versions ${clause}
         ORDER BY owner_group, project_id, version`,
      )
      .all(...(ownerGroup === undefined || ownerGroup === null ? [] : [ownerGroup])) as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToProjectVersion);
  }

  /**
   * **建版（project 台账建行）**（v0.10.1 O1 · C-6 ②）—— 后续 `POST /api/project-versions` 的写口。
   *
   * 判据（任一不过 ⇒ **零写入**，结构化失败供 HTTP / MCP 面直接映射状态码）：
   * 1. **身份非空**：`project_id` / `version` trim 后不得为空串 ⇒ 400
   *    {@link ERR_PROJECT_VERSION_SHAPE}（两列皆 PK 成员且 NOT NULL，空串进来只会让 SQLite 抛裸错）；
   * 2. **shape**：`version` 复用组档同一条 semver 判据 {@link isVersionShapeValid} —— C-6 未为
   *    project 档另立形状，缺省档又「继承当时 Group Version 数值」⇒ 同形；
   * 3. **重复 ⇒ 409 {@link ERR_PROJECT_VERSION_EXISTS}**：同 `(owner_group, project_id, version)`
   *    已存在即拒，**幂等**（二次建不产生第二行、不改第一行任何列）。
   *
   * ⚠ 判重**不得依赖 `ON CONFLICT` / `INSERT OR REPLACE`**：PK 含可空列 `owner_group`，而 SQLite
   * 的唯一约束把 NULL 视为互不相等 ⇒ 匿名档会**静默插出第二行**（照 {@link versionLedgerCreate}
   * 现例：先 get 再插；并发窗口由 SQLite 单写者 + 同进程同步 API 兜住）。
   *
   * 落 `status = "open"`（唯一可建态，{@link ProjectVersionCreateInput} 连 status 参数都不收）；
   * **不做** released 门 / 引用完整性（C-6 ④、C-15 = 后续节点）。**不写事件**（project 档事件面
   * 未进本版契约，C-7 / C-13 未定义 ⇒ 留待端点节点定）。
   */
  projectVersionCreate(input: ProjectVersionCreateInput): ProjectVersionWriteResult {
    const projectId = input.projectId.trim();
    if (projectId.length === 0) {
      return {
        ok: false,
        code: ERR_PROJECT_VERSION_SHAPE,
        message: "project_id 不得为空串（project 版本身份 = (owner_group, project_id, version)）",
        status: 400,
      };
    }
    const version = input.version.trim();
    if (version.length === 0) {
      return {
        ok: false,
        code: ERR_PROJECT_VERSION_SHAPE,
        message: "version 不得为空串（撤排期不进 project 台账，属 features.version 语义）",
        status: 400,
      };
    }
    if (!isVersionShapeValid(version)) {
      return {
        ok: false,
        code: ERR_PROJECT_VERSION_SHAPE,
        message: `非法 project version "${input.version}"：期望 semver 形状 vX.Y.Z（可省 v、可带 -prerelease/+build）`,
        status: 400,
      };
    }
    if (this.projectVersionGet(input.ownerGroup, projectId, version) !== null) {
      return {
        ok: false,
        code: ERR_PROJECT_VERSION_EXISTS,
        message: `project 版本已存在（owner_group=${input.ownerGroup === null ? "NULL" : `"${input.ownerGroup}"`} · project_id=${projectId} · version=${version}）`,
        status: 409,
      };
    }
    const at = nowIso();
    const record: ProjectVersionRecord = {
      ownerGroup: input.ownerGroup,
      projectId,
      version,
      status: "open",
      date: input.date ?? null,
      note: input.note ?? null,
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO project_versions (owner_group, project_id, version, status, date, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.ownerGroup,
        record.projectId,
        record.version,
        record.status,
        record.date,
        record.note,
        record.createdAt,
        record.updatedAt,
      );
    return { ok: true, record };
  }

  /**
   * **删版（project 台账删行）**（v0.10.1 O1）—— 未发版 project 版本的撤销 / 重建路径（C-6 ③）。
   *
   * 本口**只承载存在性判据**（无此行 ⇒ 404 {@link ERR_PROJECT_VERSION_UNKNOWN}）：
   * C-6 ③ 的「未发版 ∧ 无任何归属才可删」、C-6 ④ 的「一经 `released` 即冻结」是**门判据**，
   * 由后续节点在本口之上执法（本节点边界 =「不做闸 / 门」）。删**不级联**归属行（C-16）。
   */
  projectVersionDelete(
    ownerGroup: string | null,
    projectId: string,
    version: string,
  ): ProjectVersionWriteResult {
    const row = this.projectVersionGet(ownerGroup, projectId, version);
    if (row === null) {
      return {
        ok: false,
        code: ERR_PROJECT_VERSION_UNKNOWN,
        message: `project 台账无此行（owner_group=${ownerGroup === null ? "NULL" : `"${ownerGroup}"`} · project_id=${projectId} · version=${version}）`,
        status: 404,
      };
    }
    this.db
      .prepare(
        "DELETE FROM project_versions WHERE owner_group IS ? AND project_id = ? AND version = ?",
      )
      .run(ownerGroup, projectId, version);
    return { ok: true, record: row };
  }

  /**
   * **归属单行读**（键定位，NULL-safe `IS`）—— 写口的判重 / 幂等凭据。
   * 对外读面走 {@link featureProjectListByFeature} / {@link featureProjectListByVersion}。
   */
  private featureProjectGet(
    ownerGroup: string | null,
    featureId: string,
    projectId: string,
  ): FeatureProjectRecord | null {
    const row = this.db
      .prepare(
        `SELECT ${FEATURE_PROJECT_COLUMNS}
         FROM feature_projects WHERE owner_group IS ? AND feature_id = ? AND project_id = ?`,
      )
      .get(ownerGroup, featureId, projectId) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToFeatureProject(row);
  }

  /**
   * **不变式继承判据读**（v0.10.1 O1 · C-2）：列出 `(owner_group, group_version, project_id)`
   * 名下已有的归属行 —— 「同一 Group Version + 同一 Project ⇒ 同一 Project Version」的**读凭据**：
   * 调用方（归属写执法）据此「已存在则继承、不存在则新建」。
   *
   * **多行是常态**（实测：一版一 project 名下可挂多条需求，如 `v0.9.8`+`board` = 10 Feature），
   * 「同一 RC」是**归并**语义 ⇒ 本口只回行集、**不判一致**（一致校验 = 后续节点的执法面）。
   * 排序 = `feature_id` 字典序（顺序只由键决定，同上）。
   */
  featureProjectListByVersion(
    ownerGroup: string | null,
    groupVersion: string,
    projectId: string,
  ): FeatureProjectRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${FEATURE_PROJECT_COLUMNS}
         FROM feature_projects WHERE owner_group IS ? AND group_version = ? AND project_id = ?
         ORDER BY feature_id`,
      )
      .all(ownerGroup, groupVersion, projectId) as Array<Record<string, unknown>>;
    return rows.map(rowToFeatureProject);
  }

  /**
   * **按需求列归属**（v0.10.1 O1 · C-19 feature 详情 / 列表只读面的数据源）。
   * `feature_id` 全局唯一 ⇒ **不带** `owner_group` 过滤（可见性由调用方的 Feature 读面把关）。
   * 排序 = `project_id` 字典序（集合可比对）。
   */
  featureProjectListByFeature(featureId: string): FeatureProjectRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${FEATURE_PROJECT_COLUMNS} FROM feature_projects WHERE feature_id = ? ORDER BY project_id`,
      )
      .all(featureId) as Array<Record<string, unknown>>;
    return rows.map(rowToFeatureProject);
  }

  /**
   * **按需求批量列归属**（v0.10.1 O7 · C-19 feature 列表只读面的数据源）：**一条 SQL** 取可见范围内
   * 全部 Feature 的归属行，替掉「列表每行 Feature 再查一次 {@link featureProjectListByFeature}」
   * （1+N → O(1)，照 {@link featureTaskStateCounts} 的 v0.9.0 B3″ 先例）。
   *
   * ★ **归属谓词与 {@link listFeatures} 同源**（{@link featureOwnershipPredicate}）—— 归属条件另写
   * 一份就是两处判据漂移，会把不可见 Feature 的归属塞进只读面（静默放宽可见性）。
   * `ownerGroup` 语义与 `listFeatures` 逐字一致：给定组名 ⇒ 仅本组（`owner_group = ?`，NULL 无归属
   * 行被排除 = fail-closed）；`undefined` ⇒ 全量（未配组环境匿名入口 / 3300 运维视图）。
   *
   * 返回 `Map<featureId, FeatureProjectRecord[]>`：**无归属的 Feature 不出现在 map 里**
   * （调用方按空数组处理 ⇒ 与 {@link featureProjectListByFeature} 查回空数组同语义）。
   * 行序 = `feature_id`, `project_id` 字典序 ⇒ 每个需求桶内 `project_id` 升序，与单需求读口同序
   * （两个面的清单可直接比对）。
   */
  featureProjectListByFeatures(ownerGroup?: string): Map<string, FeatureProjectRecord[]> {
    const owner = featureOwnershipPredicate(ownerGroup, true);
    const rows = this.db
      .prepare(
        `SELECT ${FEATURE_PROJECT_COLUMNS}
         FROM feature_projects ${owner.clause.trim() || "WHERE 1=1"}
         ORDER BY feature_id, project_id`,
      )
      .all(...owner.params) as Array<Record<string, unknown>>;
    const out = new Map<string, FeatureProjectRecord[]>();
    for (const row of rows) {
      const record = rowToFeatureProject(row);
      const bucket = out.get(record.featureId);
      if (bucket === undefined) out.set(record.featureId, [record]);
      else bucket.push(record);
    }
    return out;
  }

  /**
   * **project 档三桶计数**（v0.10.1 O2 · 改造文档 C-4 / §4「project 侧 `releasable` 判据」的读凭据）——
   * 归属到 `(owner_group, project_id, project_version)` 名下的 Feature 按态归并成
   * `{total, completed, cancelled, open}` 三桶。
   *
   * **桶口径与 Group 侧同源**：`completed` / `cancelled` 各自成桶，**其余态（含 `failed` 与主链
   * 中间态）一律进 `open`** —— 照 {@link aggregateFeaturesByVersion} 的「`failed` 不算收口」口径。
   * 但**两套计数不得横向相加 / 相等校验**（C-4 ★R2：Group 由 `features.version` 派生、project 由
   * 归属表派生，是同一批卡的两个正交投影）。
   *
   * **单条 GROUP BY、无 N+1**：归属表按 project 版本定位行集 + JOIN `features` 取态，聚合在 SQL 侧完成。
   * **`INNER JOIN`** ⇒ Feature 行已不存在（归属是长期事实源、不随 Feature 删除而级联，C-16）时
   * 该条**不计入**任何桶 —— 没有态可归并，不得凭归属行猜一个态。
   *
   * `ownerGroup` 是**键的一部分**（`null` = 匿名档，NULL-safe `IS`，同 {@link featureProjectListByVersion}）。
   */
  featureProjectStateCounts(
    ownerGroup: string | null,
    projectId: string,
    projectVersion: string,
  ): ProjectVersionCardCounts {
    const rows = this.db
      .prepare(
        `SELECT f.state AS state, COUNT(*) AS n
         FROM feature_projects p
         JOIN features f ON f.feature_id = p.feature_id
         WHERE p.owner_group IS ? AND p.project_id = ? AND p.project_version = ?
         GROUP BY f.state`,
      )
      .all(ownerGroup, projectId, projectVersion) as Array<Record<string, unknown>>;
    const counts: ProjectVersionCardCounts = { total: 0, completed: 0, cancelled: 0, open: 0 };
    for (const row of rows) {
      const n = Number(row["n"] ?? 0);
      counts.total += n;
      const state = readString(row, "state");
      if (state === "completed") counts.completed += n;
      else if (state === "cancelled") counts.cancelled += n;
      else counts.open += n;
    }
    return counts;
  }

  /**
   * **写归属（建行 / 改行）**（v0.10.1 O1 · C-3）—— 后续 MCP `advance(projectVersions[])` 与板
   * 意图的共同落库口。
   *
   * 三档落点（**同键恒一行**；判重照 {@link projectVersionCreate} 的 NULL-safe `IS` 口径，
   * **不用 `ON CONFLICT`**）：
   * - 键不存在 ⇒ INSERT（`created = true`）；
   * - 键存在 ∧ 值有变 ⇒ UPDATE 三值列 + `updated_at`（`created = false` ∧ `changed = true`）
   *   = 承诺集「**可改须留痕**」（`created_at` 保留首值，照 {@link upsertSession} 口径）；
   * - 键存在 ∧ 值全同 ⇒ **零写入**（两布尔皆 `false`，**不改 `updated_at`**）
   *   = 「新增执行节点同轮重发**全量**、同值幂等、重发安全」（C-3 ★R3）。
   *
   * 身份四列 trim 后不得为空串 ⇒ 400 {@link ERR_PROJECT_VERSION_SHAPE}（PK / NOT NULL 成员）。
   *
   * **本口不校验**：Feature 是否已 `approve`（C-3 未过门挡写）、目标 project 版本行是否存在
   * （C-15 ⇒ `orch_project_version_unknown`）、该版本是否已 `released`（C-6 ④）—— 全部是后续
   * 节点的执法面。本层唯一硬约束 = `group_version` NOT NULL（C-21「无 Group Version ⇒ 无归属」
   * 的 schema 表达）。
   */
  featureProjectUpsert(input: FeatureProjectUpsertInput): FeatureProjectUpsertResult {
    const featureId = input.featureId.trim();
    const projectId = input.projectId.trim();
    const projectVersion = input.projectVersion.trim();
    const groupVersion = input.groupVersion.trim();
    const source = input.source ?? null;
    for (const [column, value] of [
      ["feature_id", featureId],
      ["project_id", projectId],
      ["project_version", projectVersion],
      ["group_version", groupVersion],
    ] as const) {
      if (value.length === 0) {
        return {
          ok: false,
          code: ERR_PROJECT_VERSION_SHAPE,
          message: `归属写入的 ${column} 不得为空串（承诺集身份键成员）`,
          status: 400,
        };
      }
    }
    const existing = this.featureProjectGet(input.ownerGroup, featureId, projectId);
    if (existing !== null) {
      const changed =
        existing.projectVersion !== projectVersion ||
        existing.groupVersion !== groupVersion ||
        existing.source !== source;
      if (!changed) return { ok: true, record: existing, created: false, changed: false };
      const at = nowIso();
      this.db
        .prepare(
          `UPDATE feature_projects
           SET project_version = ?, group_version = ?, source = ?, updated_at = ?
           WHERE owner_group IS ? AND feature_id = ? AND project_id = ?`,
        )
        .run(projectVersion, groupVersion, source, at, input.ownerGroup, featureId, projectId);
      return {
        ok: true,
        record: { ...existing, projectVersion, groupVersion, source, updatedAt: at },
        created: false,
        changed: true,
      };
    }
    const at = nowIso();
    const record: FeatureProjectRecord = {
      ownerGroup: input.ownerGroup,
      featureId,
      projectId,
      projectVersion,
      groupVersion,
      source,
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO feature_projects (owner_group, feature_id, project_id, project_version, group_version, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.ownerGroup,
        record.featureId,
        record.projectId,
        record.projectVersion,
        record.groupVersion,
        record.source,
        record.createdAt,
        record.updatedAt,
      );
    return { ok: true, record, created: true, changed: true };
  }

  /**
   * **删归属**（v0.10.1 O1）—— 从「全量重发」的集合里移除一条承诺（不再触达该 project）。
   *
   * **幂等**：键不存在 ⇒ `deleted = false` ∧ `record = null` ∧ 零副作用（重发时删到不存在的行
   * 不是错误，不产码）。不做任何门判据（Feature 是否 `cancelled`、是否已过门、版本是否已
   * `released` ⇒ 后续节点执法）。
   */
  featureProjectDelete(
    ownerGroup: string | null,
    featureId: string,
    projectId: string,
  ): FeatureProjectDeleteResult {
    const existing = this.featureProjectGet(ownerGroup, featureId, projectId);
    if (existing === null) return { deleted: false, record: null };
    this.db
      .prepare(
        "DELETE FROM feature_projects WHERE owner_group IS ? AND feature_id = ? AND project_id = ?",
      )
      .run(ownerGroup, featureId, projectId);
    return { deleted: true, record: existing };
  }

  /** 列出 Feature（updated_at 倒序；可选状态 / 版号 / 归属组过滤；limit 默认 100，clamp 到 [1,1000]） */
  listFeatures(opts: ListFeaturesOptions = {}): FeatureRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const where = featureListWhere(opts);
    const params = featureListParams(opts);
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT ${FEATURE_COLUMNS}
         FROM features ${where}ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    // v0.6.1 REQ-05 §2.5 白捡（C12）：触顶 ⇒ 事件 + 日志各一条（total 校验）
    // v0.10.0 O5b **去重键补 `version`**：旧键 `(state, owner, limit)` 不含版号 ⇒ 不同版号过滤
    // 共用一个 key，第一个版号触顶后**其余版号的触顶被静默吞**（`truncationWarned` 一次性）。
    // 口径变更：版号段取**归一后**值（与 {@link featureVersionCondition} 同三档：`undefined` ⇒ `*`、
    // 空/纯空白 ⇒ `""` = 未登记桶、非空 ⇒ trim 后版号）⇒ 同一版号的重复触顶仍只告一次。
    const stateFilter = opts.state;
    const ownerFilter = opts.ownerGroup;
    const versionFilter = opts.version === undefined ? "*" : opts.version.trim();
    this.warnIfListTruncated(
      `listFeatures:${stateFilter ?? "*"}:${ownerFilter ?? "*"}:${versionFilter}:${limit}`,
      "listFeatures",
      null,
      rows.length,
      limit,
      () => {
        const row = this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM features ${featureListWhere(opts).trim() || "WHERE 1=1"}`,
          )
          .get(...featureListParams(opts)) as Record<string, unknown> | undefined;
        return Number(row?.["n"] ?? 0);
      },
    );
    return rows.map(rowToFeature);
  }

  /**
   * 列表读口的**节点态计数**（v0.9.0 B3″）：一条 `GROUP BY feature_id, state` 聚合 SQL
   * 拿到每个 Feature 的各态节点数，替掉「每行 Feature 再查一次 `listFeatureTasks`」（1+N → O(1)）。
   *
   * ★ **归属谓词与 {@link listFeatures} 同源**（{@link featureOwnershipPredicate}）—— 视野判据
   * 若另写一份，聚合会把不可见 Feature 的节点也算进计数（静默放宽可见性）。
   *
   * 返回 `Map<featureId, Partial<Record<TaskState, number>>>`：**无节点的 Feature 不出现在 map 里**
   * （调用方按空对象处理 ⇒ `taskCount = 0`，与旧「查回空数组」同语义）。
   * `state` 只回闭集内取值（脏值行不污染出参）。
   */
  featureTaskStateCounts(
    ownerGroup?: string,
  ): Map<string, Partial<Record<TaskState, number>>> {
    const owner = featureOwnershipPredicate(ownerGroup, false);
    const rows = this.db
      .prepare(
        `SELECT t.feature_id AS feature_id, t.state AS state, COUNT(*) AS n
         FROM tasks t
         JOIN features f ON f.feature_id = t.feature_id
         WHERE t.feature_id IS NOT NULL${owner.clause}
         GROUP BY t.feature_id, t.state`,
      )
      .all(...owner.params) as Array<Record<string, unknown>>;
    const out = new Map<string, Partial<Record<TaskState, number>>>();
    for (const row of rows) {
      const featureId = readString(row, "feature_id");
      const state = readString(row, "state");
      if (!isTaskState(state)) continue;
      const bucket = out.get(featureId) ?? {};
      bucket[state] = Number(row["n"]);
      out.set(featureId, bucket);
    }
    return out;
  }

  /**
   * **版本名下卡聚合读面**（v0.10.0 O3，改造文档 §2.1(5)「只读聚合面（首刀，零新实体）」）：
   * 「版号 → 名下需求卡清单 + 三桶计数 `{total, completed, cancelled, open}`」。
   *
   * 两处消费（本节点**不做闸判定**，闸归 O4）：
   * - **O4 发版闸**：取某版号桶的 `counts` 判「`total>0 ∧ completed+cancelled===total ∧ completed>0`」；
   *   三桶口径已在此固化 —— `completed` = 引擎态 `completed`，`cancelled` = 引擎态 `cancelled`，
   *   `open` = 其余全部态（含 `failed`，收口口径不计入 completed/cancelled，见 `需求流程.md` §8）；
   * - **板 §2.3 版本列并集**：「卡派生版号」= `versions` 全集（含未登记卡经 `unregisteredCount` 表达）。
   *
   * ★ **可见性与 {@link listFeatures} 同源**：归属过滤复用 {@link featureOwnershipPredicate}
   *   （同 {@link featureTaskStateCounts} 口径），**不得另写一份归属条件** —— 另写 = 两处判据漂移，
   *   聚合侧会把不可见 Feature 算进计数 ⇒ 闸判静默放宽视野。`ownerGroup` 语义与 `listFeatures` 逐字一致：
   *   给定组名 ⇒ 仅本组（`owner_group = ?`，NULL 无归属行被排除 = fail-closed）；`undefined` ⇒ 全量
   *   （未配组环境匿名入口 / 3300 运维视图）。
   *
   * ★ **截断处理 = 显式全量扫（不加 `LIMIT`）**：版号名下卡数 = 需求量的函数、天然有界（远小于 per-feature
   *   的 `tasks` 表），一次归属过滤全扫即可同时得**卡清单与计数** ⇒ **不存在截断**（若未来加 `LIMIT`，
   *   必须经 {@link warnIfListTruncated} 留痕，且计数不得由截断后的清单派生 —— 会让 O4 闸静默误判）。
   *   计数与卡清单**同源同集**（同一批行 JS 分组），不会打架。
   *
   * ★ **未登记版号单列一桶，不静默丢**：`features.version` 为 NULL / 空串（{@link rowToFeature} 已归一
   *   `''`）⇒ 归入未登记桶（`version: null`），**照样进 `features` 清单、照样计数**；板据此把无版本卡
   *   显示为「未排期 / 未登记」列，而非当作不存在。
   *
   * 排序：`buckets` 按已登记版号字典序、未登记桶恒最后；桶内卡按 `updated_at` 倒序（与 {@link listFeatures}
   *   同「新者在前」）。
   */
  aggregateFeaturesByVersion(ownerGroup?: string): VersionCardAggregate {
    const owner = featureOwnershipPredicate(ownerGroup, true);
    const rows = this.db
      .prepare(
        `SELECT ${FEATURE_COLUMNS}
         FROM features${owner.clause}
         ORDER BY version ASC, updated_at DESC`,
      )
      .all(...owner.params) as Array<Record<string, unknown>>;

    // Map 插入序 = SQL 序（version 升序，NULL/'' 在 SQLite ASC 最前）；未登记桶恒挪到最后
    const byVersion = new Map<string | null, VersionFeaturesBucket>();
    const versions: string[] = [];
    for (const row of rows.map(rowToFeature)) {
      const version = row.version === "" ? null : row.version; // '' = 未登记（NULL 或空串）
      let bucket = byVersion.get(version);
      if (bucket === undefined) {
        bucket = {
          version,
          counts: { total: 0, completed: 0, cancelled: 0, open: 0 },
          features: [],
        };
        byVersion.set(version, bucket);
        if (version !== null) versions.push(version);
      }
      const c = bucket.counts;
      c.total += 1;
      // 态闭集外的脏值只进 total（保守，不虚报 completed/cancelled）；open 末尾派生
      if (row.state === "completed") c.completed += 1;
      else if (row.state === "cancelled") c.cancelled += 1;
      bucket.features.push({
        featureId: row.featureId,
        state: row.state,
        title: row.title,
        stage: row.stage,
        approval: row.approval,
        parentFeatureId: row.parentFeatureId,
        updatedAt: row.updatedAt,
      });
    }

    const buckets: VersionFeaturesBucket[] = [];
    let unregisteredCount = 0;
    for (const [version, bucket] of byVersion) {
      bucket.counts.open = bucket.counts.total - bucket.counts.completed - bucket.counts.cancelled;
      if (version === null) {
        unregisteredCount = bucket.counts.total;
        continue; // 未登记桶先摘出，最后再压回（保证恒在末尾）
      }
      buckets.push(bucket);
    }
    const unregistered = byVersion.get(null);
    if (unregistered !== undefined) buckets.push(unregistered);
    versions.sort();

    return { buckets, versions, unregisteredCount };
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
   * `opts.featureId` 给定 ⇒ 再按 Feature 收窄（v0.9.0 B3″ 板读面）。
   *
   * ★ **纯读口：本方法绝不推进任何游标**（`a2a_events` 的进程内按身份游标在 `bridge/index.ts`，
   * 由 `handleEvents` / `handleWait` 独占）⇒ 看板反复扫同一 Feature 的事件不会吃掉宿主的事件。
   */
  listEvents(opts: ListEventsOptions = {}): EventRecord[] {
    const since = Math.max(opts.since ?? 0, 0);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const visibility = eventVisibilityPredicate(opts.scope);
    const feature =
      opts.featureId === undefined
        ? { clause: "", params: [] as string[] }
        : { clause: " AND feature_id = ?", params: [opts.featureId] };
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE event_id > ?${visibility.clause}${feature.clause}` +
          ` ORDER BY event_id ASC LIMIT ?`,
      )
      .all(since, ...visibility.params, ...feature.params, limit) as Array<Record<string, unknown>>;
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
   * v0.3.0：**排除活跃 Feature 的 DAG 任务**（其 `feature_id` 非空且所属 Feature 未终态），
   * 避免误删在飞编排的证据。
   * v0.4.0 复核：`blocked` 属非 working，但**活跃 Feature 的 `blocked` DAG 任务同样受 `prunable`
   * 保护**（其所属 Feature 非终态 → 不满足 `feature_id IS NULL` 也不在终态集合内），
   * 仅当所属 Feature 已终态（completed/failed/cancelled）时才随 `blocked` 一并归档。
   * v0.10.8 O-8（★R1 保留口径改判 · 改造文档 §2.1 O-8）：上述「活跃 Feature 保护」收窄为
   * **仅 dag 行**；`mode='inquiry'` 行改按 `mode` 选、只看年龄（满 7 天）裁、**不看 Feature 态**，
   * 不再借 `feature_id IS NULL` 选行（该项仅存留于 dag 分支作存量解释）。终态 Feature 的 dag
   * 任务「终态后整批 7 天消失」形态不变。
   */
  pruneTasks(opts: PruneTasksOptions = {}): number {
    const retentionDays = opts.retentionDays ?? TASK_RETENTION_DAYS;
    const maxPerProject = opts.maxPerProject ?? TASK_MAX_PER_PROJECT;
    const cutoffIso = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    // v0.10.8 O-8（★R1 保留口径改判 · 改造文档 §2.1 O-8）：prune 选行改**两分支**——
    //  (a) inquiry 行按 `mode = 'inquiry'` 选，只看 `updated_at` 年龄（外层 DELETE 已带 cutoff），
    //      **不看 Feature 态**：活跃 Feature 的追问满 7 天即归档，不再随其未终态受保护；
    //  (b) dag / 存量（`mode = 'dag'` 或迁移段引入前的 NULL）保留原口径：无 Feature 归属
    //      （`feature_id IS NULL`；O-1/O-2 收紧后新行恒带 `feature_id`，此项仅作存量解释、逐字不变）
    //      或所属 Feature 已终态。不再靠 `feature_id IS NULL` 选 inquiry 行。
    const prunable =
      "(mode = 'inquiry' OR " +
      "((mode IS NULL OR mode = 'dag') AND (feature_id IS NULL OR feature_id IN (" +
      "SELECT feature_id FROM features WHERE state IN ('completed','failed','cancelled')))))";
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

/** 项目忙集合：存在未落定节点（`working ∧ queue_state IN ('queued','claimed','running')`）的 projectId（默认存储） */
export function listBusyProjectIds(): Set<string> {
  return getDefaultStore().listBusyProjectIds();
}

/** 项目忙任务明细（同 `listBusyProjectIds` 谓词的行级展开；v0.8.8 Trace 面；默认存储；只读） */
export function listBusyTasksForProject(projectId: string): QueuedTaskRecord[] {
  return getDefaultStore().listBusyTasksForProject(projectId);
}

/** 项目**只读档**占位明细（写忙集排除 read 后的补位面；v0.8.10 Trace 面；默认存储；只读） */
export function listReadLaneTasksForProject(projectId: string): QueuedTaskRecord[] {
  return getDefaultStore().listReadLaneTasksForProject(projectId);
}

/** 排队先于 `queuedAt`（入队时刻；`null` = 不设上界 = 全部在队数）的 `queued` 任务数（v0.8.10 Trace 位次原料；默认存储；只读） */
export function countQueuedBefore(queuedAt: string | null): number {
  return getDefaultStore().countQueuedBefore(queuedAt);
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

/** 列出墙钟超期的在飞队列任务（默认存储；v0.8.7 O2 孤儿清算读口） */
export function listOrphanedTasks(claimedBefore: string): QueuedTaskRecord[] {
  return getDefaultStore().listOrphanedTasks(claimedBefore);
}

/** 墙钟判死：claimed/running → failed + settled + `failure_kind='runner'`（不可续跑的载体侧事实；默认存储；v0.8.7 O2 建口、v0.8.8 O1 改判取值；不清 claim 三字段，契约 3） */
export function failOrphanedTask(taskId: string): boolean {
  return getDefaultStore().failOrphanedTask(taskId);
}

/** 结果回传幂等落库（默认存储） */
export function upsertTaskResult(rec: TaskResultUpsertInput): QueuedTaskRecord {
  return getDefaultStore().upsertTaskResult(rec);
}

/** 失败分类写口（默认存储；v0.8.7 O3；仅当行当前为 `failed` 才写入） */
export function setTaskFailureKind(taskId: string, kind: FailureKind): boolean {
  return getDefaultStore().setTaskFailureKind(taskId, kind);
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

/** 更新 Feature 登记字段（默认存储；v0.9.0 B1″，**不碰状态机态**） */
export function updateFeatureRegistration(
  featureId: string,
  patch: FeatureRegistrationPatch,
): FeatureRecord | null {
  return getDefaultStore().updateFeatureRegistration(featureId, patch);
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

/**
 * 列表读的节点态聚合（默认存储；v0.9.0 B3″）—— 见
 * {@link SessionStore.featureTaskStateCounts}（**归属谓词与 `listFeatures` 同源**）。
 */
export function featureTaskStateCounts(
  ownerGroup?: string,
): Map<string, Partial<Record<TaskState, number>>> {
  return getDefaultStore().featureTaskStateCounts(ownerGroup);
}

/**
 * 版本名下卡聚合读面（默认存储；v0.10.0 O3）—— 见
 * {@link SessionStore.aggregateFeaturesByVersion}（**归属谓词与 `listFeatures` 同源**；
 * 未登记版号单列一桶、不静默丢；不加 `LIMIT` ⇒ 无截断）。
 */
export function aggregateFeaturesByVersion(ownerGroup?: string): VersionCardAggregate {
  return getDefaultStore().aggregateFeaturesByVersion(ownerGroup);
}

/**
 * 版本台账存在性读口（默认存储；v0.10.0 O5）—— 见
 * {@link SessionStore.versionLedgerHas}（`ledgerReady = false` 语义 = O1 表尚未落地，调用方
 * 在此路径跳过存在性检查、**shape 校验仍生效**；不改写存量）。
 */
export function versionLedgerHas(
  ownerGroup: string | null | undefined,
  version: string,
): { exists: boolean; ledgerReady: boolean } {
  return getDefaultStore().versionLedgerHas(ownerGroup, version);
}

/**
 * 版本台账状态读口（默认存储；v0.10.0 O4）—— 见
 * {@link SessionStore.versionLedgerStatus}（三态 `notstart/active/released`；`ledgerReady = false`
 * 语义 = O1 表尚未落地：排期写跳 `released` 锁、发版闸 fail-closed）。
 */
export function versionLedgerStatus(
  ownerGroup: string | null | undefined,
  version: string,
): { status: VersionLedgerStatus | null; ledgerReady: boolean } {
  return getDefaultStore().versionLedgerStatus(ownerGroup, version);
}

/**
 * 版本台账**单行读**（默认存储；v0.10.0 O1）—— 见 {@link SessionStore.versionLedgerGet}。
 * `ownerGroup` 是键的一部分：`null` = 匿名档（不接受 `undefined`）。
 */
export function versionLedgerGet(
  ownerGroup: string | null,
  version: string,
): VersionLedgerRecord | null {
  return getDefaultStore().versionLedgerGet(ownerGroup, version);
}

/**
 * 版本台账**列表读**（默认存储；v0.10.0 O1）—— 见 {@link SessionStore.versionLedgerList}。
 * `undefined` ⇒ 全量 / 字符串 ⇒ 本组 / `null` ⇒ 仅匿名档。
 */
export function versionLedgerList(ownerGroup?: string | null): VersionLedgerRecord[] {
  return getDefaultStore().versionLedgerList(ownerGroup);
}

/**
 * 版本台账**建版**（默认存储；v0.10.0 O2a）—— 见 {@link SessionStore.versionLedgerCreate}。
 * 出参直接映射 HTTP 状态码与信封（`POST /api/versions`）。
 */
export function versionLedgerCreate(input: VersionLedgerCreateInput): VersionLedgerWriteResult {
  return getDefaultStore().versionLedgerCreate(input);
}

/**
 * 版本台账**删版**（默认存储；v0.10.0 O2a）—— 见 {@link SessionStore.versionLedgerDelete}。
 * 出参直接映射 HTTP 状态码与信封（`DELETE /api/versions/{version}`）。
 */
export function versionLedgerDelete(
  ownerGroup: string | null,
  version: string,
): VersionLedgerWriteResult {
  return getDefaultStore().versionLedgerDelete(ownerGroup, version);
}

/**
 * 版本台账**手动设状态**（默认存储；v0.10.0 O2c）—— 见
 * {@link SessionStore.versionLedgerSetStatus}。`notstart ↔ active` 人工写口；
 * `released` 为终态不可回退，发版另走 {@link versionLedgerMarkReleased}。
 */
export function versionLedgerSetStatus(
  input: VersionLedgerSetStatusInput,
): VersionLedgerWriteResult {
  return getDefaultStore().versionLedgerSetStatus(input);
}

/**
 * 版本台账**自动转 active**（默认存储；v0.10.0 O2c）—— 见
 * {@link SessionStore.versionLedgerActivate}。引擎内部触发（门① 的 `stage` 登记写 /
 * `approve` 放行 / 首个节点派发，`trigger` 随 v0.10.7 n3 进事件 payload），
 * 幂等；调用方的节流 / 不阻断护栏见 `bridge/versions-activation.ts`。
 * 本层 `trigger` **给缺省 `"dispatch"`**（护栏层必填、逐处显式传）。
 */
export function versionLedgerActivate(
  ownerGroup: string | null,
  version: string,
  trigger: VersionActivationTrigger = "dispatch",
): VersionActivationResult {
  return getDefaultStore().versionLedgerActivate(ownerGroup, version, trigger);
}

/**
 * 发版快照**单行读**（默认存储；v0.10.0 O7）—— 见 {@link SessionStore.releaseSnapshotGet}。
 * `ownerGroup` 是键的一部分：`null` = 匿名档（不接受 `undefined`）。
 */
export function releaseSnapshotGet(
  ownerGroup: string | null,
  version: string,
): ReleaseSnapshotRecord | null {
  return getDefaultStore().releaseSnapshotGet(ownerGroup, version);
}

/**
 * 发版快照**列表读**（默认存储；v0.10.0 O7）—— 见 {@link SessionStore.releaseSnapshotList}
 * （= 板 §2.3(3)「引擎 Release 清单」左半）。
 */
export function releaseSnapshotList(ownerGroup?: string | null): ReleaseSnapshotRecord[] {
  return getDefaultStore().releaseSnapshotList(ownerGroup);
}

/**
 * 版本台账**标记 released + 落快照（同事务）**（默认存储；v0.10.0 O7）——
 * 见 {@link SessionStore.versionLedgerMarkReleased}。
 *
 * ⚠ 出参的 `snapshotWritten = false` **不等于**「本次没发版」：快照已存在 ⇒ 幂等回读、
 * 不覆写（不可变判据）。发版闸判据（O4）由调用方在进本口之前评。
 */
export function versionLedgerMarkReleased(
  input: ReleaseSnapshotInput,
): ReleaseSnapshotWriteResult {
  return getDefaultStore().versionLedgerMarkReleased(input);
}

/**
 * 迁移哨兵**存在性读**（默认存储；v0.10.0 O1 · 改造文档 §2.1(7)）—— 见
 * {@link SessionStore.versionsLedgerMigrationDone}（判据 = 哨兵事件行存在；
 * **不以台账行数充当**，那会把「手工建单」误判成「已导入板台账」）。
 * 哨兵的**写入**由离线一次性脚本 `scripts/migrate-versions-ledger.mjs` 直接落 `events`
 * （脚本不经桥进程 ⇒ kind 字面量与 {@link EVENT_VERSION_LEDGER_MIGRATED} 逐字同值）。
 */
export function versionsLedgerMigrationDone(): boolean {
  return getDefaultStore().versionsLedgerMigrationDone();
}

/**
 * project 台账**单行读**（默认存储；v0.10.1 O1）—— 见 {@link SessionStore.projectVersionGet}。
 * `ownerGroup` 是键的一部分：`null` = 匿名档（不接受 `undefined`）。
 */
export function projectVersionGet(
  ownerGroup: string | null,
  projectId: string,
  version: string,
): ProjectVersionRecord | null {
  return getDefaultStore().projectVersionGet(ownerGroup, projectId, version);
}

/**
 * project 台账**列表读**（默认存储；v0.10.1 O1）—— 见 {@link SessionStore.projectVersionList}。
 * `undefined` ⇒ 全表 / 字符串 ⇒ 本组 / `null` ⇒ 仅匿名档。
 */
export function projectVersionList(ownerGroup?: string | null): ProjectVersionRecord[] {
  return getDefaultStore().projectVersionList(ownerGroup);
}

/**
 * project 台账**建版**（默认存储；v0.10.1 O1）—— 见 {@link SessionStore.projectVersionCreate}。
 * 出参直接映射 HTTP 状态码与信封。
 */
export function projectVersionCreate(input: ProjectVersionCreateInput): ProjectVersionWriteResult {
  return getDefaultStore().projectVersionCreate(input);
}

/**
 * project 台账**删版**（默认存储；v0.10.1 O1）—— 见 {@link SessionStore.projectVersionDelete}
 * （纯存在性判据；C-6 ③④ 的门判据由后续节点在本口之上执法）。
 */
export function projectVersionDelete(
  ownerGroup: string | null,
  projectId: string,
  version: string,
): ProjectVersionWriteResult {
  return getDefaultStore().projectVersionDelete(ownerGroup, projectId, version);
}

/**
 * **不变式继承判据读**（默认存储；v0.10.1 O1）—— 见
 * {@link SessionStore.featureProjectListByVersion}（C-2「已存在则继承、不存在则新建」的读凭据）。
 */
export function featureProjectListByVersion(
  ownerGroup: string | null,
  groupVersion: string,
  projectId: string,
): FeatureProjectRecord[] {
  return getDefaultStore().featureProjectListByVersion(ownerGroup, groupVersion, projectId);
}

/**
 * **按需求列归属**（默认存储；v0.10.1 O1）—— 见
 * {@link SessionStore.featureProjectListByFeature}（C-19 feature 侧归属只读面的数据源）。
 */
export function featureProjectListByFeature(featureId: string): FeatureProjectRecord[] {
  return getDefaultStore().featureProjectListByFeature(featureId);
}

/**
 * **按需求批量列归属**（默认存储；v0.10.1 O7）—— 见
 * {@link SessionStore.featureProjectListByFeatures}（C-19 feature 列表只读面的数据源，
 * **一条 SQL** 取全量 ⇒ 列表读不随 Feature 数增长）。
 */
export function featureProjectListByFeatures(
  ownerGroup?: string,
): Map<string, FeatureProjectRecord[]> {
  return getDefaultStore().featureProjectListByFeatures(ownerGroup);
}

/**
 * **project 档三桶计数**（默认存储；v0.10.1 O2）—— 见
 * {@link SessionStore.featureProjectStateCounts}（`releasable` 判据的读凭据）。
 */
export function featureProjectStateCounts(
  ownerGroup: string | null,
  projectId: string,
  projectVersion: string,
): ProjectVersionCardCounts {
  return getDefaultStore().featureProjectStateCounts(ownerGroup, projectId, projectVersion);
}

/**
 * **写归属**（默认存储；v0.10.1 O1）—— 见 {@link SessionStore.featureProjectUpsert}
 * （同键恒一行；同值重发 ⇒ `created = false` ∧ `changed = false` 零写入）。
 */
export function featureProjectUpsert(input: FeatureProjectUpsertInput): FeatureProjectUpsertResult {
  return getDefaultStore().featureProjectUpsert(input);
}

/**
 * **删归属**（默认存储；v0.10.1 O1）—— 见 {@link SessionStore.featureProjectDelete}（幂等）。
 */
export function featureProjectDelete(
  ownerGroup: string | null,
  featureId: string,
  projectId: string,
): FeatureProjectDeleteResult {
  return getDefaultStore().featureProjectDelete(ownerGroup, featureId, projectId);
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
