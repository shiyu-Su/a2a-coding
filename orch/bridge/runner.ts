/**
 * Runner 入站端点模块（v0.7.0 A3）。
 *
 * 连接模型反转（pull）后，执行机 Launcher 升格为 **Runner**，主动出站连桥；本模块是桥侧
 * 承载其三个入站端点的**唯一**实现（路由分支挂 `transports/http.ts`，复用常驻 MCP 端口，
 * 不引第二接入面）：
 *
 * | 端点 | 作用 | 关键判据 |
 * |---|---|---|
 * | `POST /runner/register` | 注册 / 刷新投影 | Bearer token（常量时间）→ machineId ∈ `machines[]` → `protocolVersion` 主版本 ∈ `SUPPORTED_PEER_PROTOCOL_MAJORS`；`upsertRunner` + `runnerProjectsReplace` + `runner.registered` 事件 |
 * | `POST /runner/connect` | 长轮询（poll 即心跳） | 同上鉴权；claim 前置 = **未配组 ⇒ 全放**，配了组 ⇒ `(machineId,projectId) ∈ 任一组 memberKeys` **且**任务归属该机器（= 本机注册过的项目）；命中 claim CAS 即下发 `dispatch`，另可下发 `stop` / `cancel-task`；空超时 = 心跳（204） |
 * | `POST /runner/result` | 结果回传（ack） | 同上鉴权 + **claim_token 校验**（比对落库领取令牌；**O4 补结算窄口**：无令牌且 `state=failed` ∧ 行 `working` ∧ `claimed_by=本机` ⇒ 受理，否则照旧 409）→ `upsertTaskResult`（幂等键 `(machineId, taskId)`）→ O1：本次胜出 `failed` 时**校验 machine 上报的 `failureKind` 是否合 2.3 六类闭集**并落库（不合 ⇒ 安全兜底类 + warn 带原值，**绝不整包拒收**）→ 200 ack |
 *
 * 门闩与接入面（节点验收项）：
 * - **owner 门闩**：仅 core 租约 `owner` 的实例提供端点；
 *   follower 一律 `503 runner_not_owner`（不抢调度权，也不给 Runner 下发命令）。
 * - **接入面恒 http**：stdio 已退役；未注入本处理器时 `/runner/*` 落 404（`http.ts` 兜底）。
 * - **宽容解析**：`capabilities` 与未知字段一律忽略（不落库、不因未知字段 400）。
 *
 * 唤醒语义：`/connect` 的挂起可被 `wake(machineId)` 立即唤醒（新任务入队时由派发侧调用；
 * 省略 `machineId` = 广播）。计时器不 `unref` —— hold 有界，且正常运行时 http listener 持住
 * 事件循环；unref 会让「无其它句柄」的单测提前退出。
 *
 * 存储读口说明（A3 追加，additive）：A2 只暴露了 `runners` / `runner_projects` / 队列的**写口**，
 * 而本模块的 claim 归属判定与 claim_token 校验必须**读库**（不能靠进程内记忆：桥重启 / 断桥
 * 重连后注册投影与领取令牌仍须可判，否则 E4/E5 语义不成立）⇒ A3 在 `session/store.ts` 增补
 * `listRunnerProjects(runnerId)` 与 `getQueuedTask(taskId)` 两个只读口（不改既有列语义、不改写口）。
 *
 * 边界（本节点不做）：不实现 dispatchTask 入队（A4）、不实现 watcher 换轮询（A5）、
 * 不改 `transports/web.ts`（O6）。
 *
 * A7（本节点增补）：本模块由「纯入站端点」扩展为**事件生产方 + 心跳超期清算方**：
 * - 事件 kind 五值（`runner.registered` / `runner.online` / `runner.offline` / `task.claimed` /
 *   `task.stale`），**统一经 `emitEvent` 落库（`appendEvent`）+ 唤醒收件箱（`signalEvents`）**；
 * - **心跳超期清算循环**（模块内 timer，`sweepIntervalMs` 可覆盖；`sweepStale()` 为确定性单测入口）：
 *   `lastHeartbeatAt` 静默 ≥ `runner.heartbeatTimeoutMs` ⇒ 逐个 `requeueStaleTask`（B2：已领取
 *   任务回收为 `queued` 并清 claim 令牌/时刻两字段，v0.8.7 O4 起保留 `claimed_by` 作补结算
 *   行级绑定凭据）+ `task.stale` 事件，随后降注册态 `offline` +
 *   `runner.offline` 事件；**同 runner 回归照常 claim（复用同一 CAS）** 并在回线时发 `runner.online`。
 * - D8 纪律：心跳超期**只降注册态、不触发 stop**（不碰本机 agent；任务仅回收重排）。
 *
 * ⚠️ 清算循环必须**读库**（`listRunners` / `listClaimedTasks`）而非进程内记忆：桥重启后
 * `queue_state='claimed'` 的行仍须可判、可回收（否则永久悬挂）。为此 `session/store.ts` 增补
 * 四个 A7 读/写口（`listRunners` / `getRunner` / `listClaimedTasks` / `markRunnerOffline`，
 * 均为**只读或单列写**、additive、不改既有列语义）——与 A3 增补两读口同一纪律。
 *
 * O2（v0.8.7 增补）：本模块同时是**孤儿墙钟清算**的事件生产方：
 * - `sweepOrphanedTasks()` 挂**同一** `sweepIntervalMs` timer，**同 tick 先 `sweepStale` 后墙钟**
 *   （心跳先命中者已 requeue 可复活，墙钟只收残量 ⇒ 两路竞争天然消解）；
 * - 判据**任务驱动**（与注册态无关）：`queue_state ∈ {claimed,running} ∧ claimed_at <
 *   now - runner.orphanTimeoutMs`（缺省 30 min）⇒ `failOrphanedTask` CAS 置
 *   `failed` + `settled` + `failure_kind='runner'`（不可续跑）+ `task.orphaned` 事件；
 * - ⚠️ **不清 claim 三字段**：§2.9 契约 3 要求墙钟判死后的迟到件仍过 token 比对、
 *   落 `upsertTaskResult` 幂等口拿 200（否则 machine 侧 outbox `pending` 永不清）。
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { memberKey } from "../config.js";
import type { CoreRole } from "../runtime/core-lease.js";
import {
  appendEvent,
  claimTask,
  failOrphanedTask,
  getQueuedTask,
  getRunner,
  listClaimedTasks,
  listOrphanedTasks,
  listRunnerProjects,
  listRunners,
  markRunnerOffline,
  requeueStaleTask,
  runnerProjectsReplace,
  setTaskFailureKind,
  touchRunnerHeartbeat,
  upsertRunner,
  upsertTaskResult,
} from "../session/store.js";
import type {
  ClaimTaskOptions,
  EventAppendInput,
  QueuedTaskRecord,
  RunnerProjectInput,
  RunnerProjectRecord,
  RunnerRecord,
  RunnerUpsertInput,
  TaskResultUpsertInput,
} from "../session/store.js";
import type {
  AgentKind,
  EventRecord,
  FailureKind,
  InputArtifactRef,
  MachineRef,
  MachinesConfig,
  RiskLevel,
  TaskState,
} from "../types.js";
import {
  AGENT_KINDS,
  FAILURE_KINDS,
  ORPHAN_FAILURE_KIND,
  SUPPORTED_PEER_PROTOCOL_MAJORS,
} from "../types.js";
import { bridgeLog } from "./bridge-log.js";
import type { DegradationSink } from "./index.js";

// ---------------------------------------------------------------------------
// 降级登记键（v0.8.8 O5；两处静默降级各一键，登记到 index 注入的进程内登记表）
// ---------------------------------------------------------------------------

/** 心跳超期清算停摆（配置 / Runner 注册表读取失败 ⇒ 返回空结果） */
const DEGRADED_HEARTBEAT_SWEEP = "runner.heartbeat-sweep";
/** 孤儿墙钟清算停摆（配置 / 在飞任务读取失败 ⇒ 墙钟判死停摆、僵尸滞留） */
const DEGRADED_ORPHAN_SWEEP = "runner.orphan-sweep";

// ---------------------------------------------------------------------------
// 路由路径与错误码 / 事件 kind
// ---------------------------------------------------------------------------

/** 注册端点路径（Runner 启动自检通过后首触） */
export const RUNNER_REGISTER_PATH = "/runner/register";
/** 长轮询端点路径（poll 即心跳；空超时 = 204） */
export const RUNNER_CONNECT_PATH = "/runner/connect";
/** 结果回传端点路径（claim_token 校验 + ack） */
export const RUNNER_RESULT_PATH = "/runner/result";

/** 未认证（缺 token / token 不匹配 / 该机未配置 token） */
export const RUNNER_ERR_UNAUTHORIZED = "runner_unauthorized";
/** 不在白名单（machineId ∉ machines[]）或非成员项目 */
export const RUNNER_ERR_NOT_ALLOWED = "runner_not_allowed";
/** 本实例非 core 租约 owner（follower；端点仅 owner 提供） */
export const RUNNER_ERR_NOT_OWNER = "runner_not_owner";
/** 协议主版本不受支持（结构化拒绝，含升级指引） */
export const RUNNER_ERR_PROTOCOL_MISMATCH = "protocol_version_mismatch";
/** 请求体 / 必填字段非法 */
export const RUNNER_ERR_BAD_REQUEST = "bad_request";
/** 请求体超限 */
export const RUNNER_ERR_PAYLOAD_TOO_LARGE = "payload_too_large";
/** 方法不符（端点仅 POST） */
export const RUNNER_ERR_METHOD_NOT_ALLOWED = "method_not_allowed";
/** 项目不在本机任一组成员集合（与既有 `project_not_a_member` 同码） */
export const RUNNER_ERR_PROJECT_NOT_MEMBER = "project_not_a_member";
/** 回传的任务在本地库中不存在 */
export const RUNNER_ERR_TASK_NOT_FOUND = "task_not_found";
/** 回传令牌与落库领取令牌不一致（陈旧 / 已清算领取） */
export const RUNNER_ERR_CLAIM_TOKEN_MISMATCH = "claim_token_mismatch";

/** 事件 kind：Runner 注册 / 刷新（A7 广播面的输入之一） */
export const RUNNER_EVENT_REGISTERED = "runner.registered";
/** 事件 kind：Runner 心跳超期后**恢复**（offline → online 的回线；注册或 poll 心跳触发） */
export const RUNNER_EVENT_ONLINE = "runner.online";
/** 事件 kind：Runner 心跳超期（清算循环产出；D8：只降注册态，**不触发 stop**） */
export const RUNNER_EVENT_OFFLINE = "runner.offline";
/** 事件 kind：任务被 Runner 领取（claim CAS 成功后） */
export const RUNNER_EVENT_TASK_CLAIMED = "task.claimed";
/** 事件 kind：悬挂领取被清算回收（`claimed`/`running` → `queued`；B2 requeue） */
export const RUNNER_EVENT_TASK_STALE = "task.stale";
/** 事件 kind：孤儿墙钟判死（`claimed`/`running` 超 `runner.orphanTimeoutMs` → `failed` + `settled`；v0.8.7 O2） */
export const RUNNER_EVENT_TASK_ORPHANED = "task.orphaned";

/** 请求体上限（防御性；超出 413，与回调端点同量级） */
const RUNNER_MAX_BODY_BYTES = 1_048_576;

const RISK_LEVELS: readonly RiskLevel[] = ["read", "write", "full"];
const TASK_STATES: readonly TaskState[] = [
  "working",
  "completed",
  "failed",
  "input-required",
  "blocked",
];
/**
 * 已落终态集 —— **必须与 `upsertTaskResult` 的 `WHERE state NOT IN (...)` 同集合**
 * （契约 3「首个终态胜出」在判据侧的镜像）。
 */
const SETTLED_TERMINAL_STATES: readonly TaskState[] = ["completed", "failed", "blocked"];

// ---------------------------------------------------------------------------
// 失败分类：闭集校验 + 兜底（v0.8.8 O1 · 改造文档 §2.1：**事实源 = machine**，orch 只校验 + 落库）
// ---------------------------------------------------------------------------

/**
 * machine 侧原生 `AcpError.kind`（`machine/acp-bridge/acp/client.ts`）中属**载体类**的取值：
 * `spawn` = 后端进程起不来，`closed` = 后端进程中途退出（二者都是「载体没了」的确定性信号，
 * 协议条文把二者归 `agent`）。
 */
const ACP_AGENT_ERROR_KINDS: readonly string[] = ["spawn", "closed"];

/** 该字符串是否为合格的六类值（闭集校验；清单唯一事实源 = `types.ts` 的 `FAILURE_KINDS`） */
function isFailureKindValue(v: string): v is FailureKind {
  return (FAILURE_KINDS as readonly string[]).includes(v);
}

/**
 * **兜底映射**（v0.8.8 O1 起为本版唯一显式冗余，改造文档 §3.3）：machine 原生 `AcpError.kind`
 * → 六类**安全值**（`spawn` / `closed` ⇒ `agent`；其余 ⇒ `business`，即「不可重试」侧）。
 *
 * ⚠️ **不是并行分类器**：唯一触发条件 = machine **未上报合格的六类值**（见
 * {@link resolveReportedFailureKind} 的缺键支）。闭集变更以 `PROTOCOL.md` 为准、orch 不主动扩展。
 *
 * 保守方向延续 v0.8.7：`timeout` / `rpc` / `protocol` 语义歧义（「排队」与「任务太大」都满窗，
 * 分辨要计量键）⇒ 不自作主张升格为可续跑类，一律落 `business`。
 */
export function mapAcpErrorKindToFailureKind(acpErrorKind: unknown): FailureKind {
  return typeof acpErrorKind === "string" && ACP_AGENT_ERROR_KINDS.includes(acpErrorKind)
    ? "agent"
    : "business";
}

/** {@link resolveReportedFailureKind} 的判据结果 */
export interface FailureKindVerdict {
  /** 实际落库的六类值 */
  kind: FailureKind;
  /**
   * 兜底留痕用的**原值**：合格六类值 ⇒ `null`（未兜底、不 warn）；**缺键** ⇒ `"?"`；
   * 旧值（`infra` / `task`）/ 未知值 ⇒ 原样。warn 必须带它，供事后区分
   * 「真 `business`」与「兜底 `business`」。
   */
  fallbackFrom: string | null;
}

/**
 * 入站 `failureKind` 的**闭集校验 + 兜底**（改造文档 §2.1 D2 硬要求：**绝不整包 400 拒收**）。
 * 纯函数，输入 = `/runner/result` 回传体的 `failureKind` 与 `diagnostics.acpErrorKind` 原值。
 *
 * 三条路径（版本握手只校验主版本 ⇒ 2.2 machine + 2.3 桥**必然混跑**；对旧值硬拒 = 旧机任务
 * 全部结不了账 = 丢单）：
 * 1. **合格六类值** ⇒ 原样采纳（machine 是分类事实源，orch 只校验 + 落库），不 warn；
 * 2. **缺键** = machine 明说「判不出」（§2.3「判不出 ⇒ 不报该键」）⇒ 残余的唯一原生事实是
 *    `acpErrorKind` ⇒ 走 {@link mapAcpErrorKindToFailureKind}（载体类 ⇒ `agent`，否则 `business`）；
 * 3. **旧值 / 未知值** ⇒ 直接落安全兜底类 `business`，**不走** 2 的映射：2.2 的 `infra` / `task`
 *    本身就是一个**已成立的分类主张**（只是词表已退休），拿 `acpErrorKind` 复核它 = orch 变成
 *    第二套分类器（§3.2 禁止）⇒ 只登记安全值 + warn 留原值，事后取证靠 warn。
 */
export function resolveReportedFailureKind(
  reportedKind: unknown,
  acpErrorKind: unknown,
): FailureKindVerdict {
  if (typeof reportedKind === "string") {
    return isFailureKindValue(reportedKind)
      ? { kind: reportedKind, fallbackFrom: null }
      : { kind: "business", fallbackFrom: reportedKind };
  }
  if (reportedKind === undefined || reportedKind === null) {
    return { kind: mapAcpErrorKindToFailureKind(acpErrorKind), fallbackFrom: "?" };
  }
  // 非字符串且非空 = 形状不符的未知值 ⇒ 与旧值同路（不采信主张，只留原值）
  return { kind: "business", fallbackFrom: String(reportedKind) };
}

/**
 * 从回传体的 `diagnostics` 取原生 `acpErrorKind`（**宽容读取**，与 `handleResult` 的逐键白名单
 * 读取同一纪律）：非对象 / 缺键 / 非字符串 ⇒ `undefined` ⇒ 交 {@link mapAcpErrorKindToFailureKind}
 * 安全降级。machine 侧字段形状 = `{ diagnostics: { acpErrorKind?, elapsedMs, stage, ... } }`。
 */
export function readReportedAcpErrorKind(diagnostics: unknown): unknown {
  if (typeof diagnostics !== "object" || diagnostics === null) return undefined;
  return (diagnostics as Record<string, unknown>)["acpErrorKind"];
}

/**
 * **补结算窄口的行级绑定判据**（v0.8.7 O4 限制②+④；纯函数）：
 * 桥侧行 `state='working'`（未结算）∧ `claimed_by = 上报 machineId`（非空）。
 *
 * 为何 ④ 必须：`claimed_by` 是「谁领过 / 谁正持有」的**行级唯一凭据** —— 只按 ②
 * （claimed/working 字面）放行时，他机的迟到补报可击穿「已被重领取」的重派执行
 * （行被别机重领后 `state` 仍 `working`、令牌已换新，无令牌者本应 409）。
 * 配合 O4 前置改动（`requeueStaleTask` 不再清 `claimed_by`）：心跳清算后的 `queued`
 * 行仍留旧领取者 ⇒ 原机可补结算；被**他机重领** ⇒ `claimed_by` 已覆写 ⇒ 原机被拒。
 */
export function supplementalGateHolds(existing: QueuedTaskRecord, machineId: string): boolean {
  return existing.state === "working" && existing.claimedBy !== null && existing.claimedBy === machineId;
}

// ---------------------------------------------------------------------------
// 线协议载荷 / 命令类型
// ---------------------------------------------------------------------------

/**
 * 命令族三类（B1）：`dispatch`（下发任务）/ `stop`（停**本机单个项目** Agent）/ `cancel-task`
 * （取消在飞任务）。命令体即 `/connect` 的成功响应负载（空超时 = 204 心跳，无命令体）。
 *
 * **冻结边界（N1 审阅留痕，与 machine 侧 `parseRunnerCommand` 对齐，该函数不改）**：三类命令
 * 载荷一律必携 `commandId`（桥侧 `uuid` 生成；`stop` / `cancel-task` 的 machine 回执
 * `{ commandId, error? }` 以它原样带回供宿主对账）；`stop` 另必携 `projectId`（= **该 stop
 * 目标项目**；语义为「停本机**单个项目** Agent」而**非停全部**）。
 */
export interface RunnerDispatchCommand {
  command: "dispatch";
  /** 本地任务 id（= 桥侧 `tasks.task_id`；Runner 以其为 outbox 文件名） */
  taskId: string;
  projectId: string;
  contextId: string;
  /** 桥侧命令 id（`uuid`；观测 / 对账用 —— `dispatch` 结果走 `/runner/result`，不走回执） */
  commandId: string;
  /** 派发消息全文（登记时落库的 `dispatch_message`；缺省回退 prompt 片段） */
  message: string;
  /** 本次领取令牌（回传结果时必须原样带回） */
  claimToken: string;
  featureId: string | null;
  /** 前置依赖（本地 taskId；Runner 侧仅作展示，顺序由桥保证） */
  dependencies: string[];
  /** 下游声明的上游产物引用 */
  inputs: InputArtifactRef[] | null;
}

export interface RunnerStopCommand {
  command: "stop";
  /** stop 目标项目（**本机单个项目**；machine `parseRunnerCommand` 要求非空） */
  projectId: string;
  /** 桥侧命令 id（`uuid`；machine 回执 `{ commandId, error? }` 原样带回） */
  commandId: string;
}

export interface RunnerCancelTaskCommand {
  command: "cancel-task";
  taskId: string;
  /** 目标项目（桥侧任务记录解析；观测 / 对账用 —— machine 侧按 `taskId` 定位台账） */
  projectId: string;
  /** 桥侧命令 id（`uuid`；machine 回执 `{ commandId, error? }` 原样带回） */
  commandId: string;
}

export type RunnerCommand = RunnerDispatchCommand | RunnerStopCommand | RunnerCancelTaskCommand;

// ---------------------------------------------------------------------------
// 存储端口（默认绑定 session/store；单测可注入替身）
// ---------------------------------------------------------------------------

/** 端点的存储依赖面（全部为既有写口 + A3 追加的两个只读口 + A7 追加的四个清算口） */
export interface RunnerStorePort {
  upsertRunner: (rec: RunnerUpsertInput) => RunnerRecord;
  touchRunnerHeartbeat: (runnerId: string, at?: string) => RunnerRecord | null;
  runnerProjectsReplace: (
    runnerId: string,
    projects: readonly RunnerProjectInput[],
  ) => RunnerProjectRecord[];
  listRunnerProjects: (runnerId: string) => RunnerProjectRecord[];
  claimTask: (opts: ClaimTaskOptions) => QueuedTaskRecord | null;
  getQueuedTask: (taskId: string) => QueuedTaskRecord | null;
  upsertTaskResult: (rec: TaskResultUpsertInput) => QueuedTaskRecord;
  appendEvent: (rec: EventAppendInput) => EventRecord;
  /** A7：按 `machine_id` 读注册行（判「离线→回线」的先前态；必须在心跳写入前调用） */
  getRunner: (machineId: string) => RunnerRecord | null;
  /** A7：列出全部注册行（心跳超期扫描） */
  listRunners: () => RunnerRecord[];
  /** A7：列出某领取者名下在飞任务（清算遍历） */
  listClaimedTasks: (claimedBy: string) => QueuedTaskRecord[];
  /** A7：清算单条悬挂领取（`claimed`/`running` → `queued`；B2） */
  requeueStaleTask: (taskId: string, expectedClaimedBy?: string) => boolean;
  /** A7：心跳超期降注册态（只写 `state` 单列；D8 不触发 stop） */
  markRunnerOffline: (runnerId: string) => RunnerRecord | null;
  /** O2：列出墙钟超期在飞任务（`claimed_at` 早于给定截止刻；只读） */
  listOrphanedTasks: (claimedBefore: string) => QueuedTaskRecord[];
  /** O2：墙钟判死 CAS（`claimed`/`running` → `failed`+`settled`+`failure_kind='runner'`；不清 claim 三字段） */
  failOrphanedTask: (taskId: string) => boolean;
  /** O3：失败分类写口（仅当行当前为 `failed` 才写；迟到 / 重复上报 ⇒ 零写入） */
  setTaskFailureKind: (taskId: string, kind: FailureKind) => boolean;
}

/** 缺省存储端口：绑定 `session/store` 模块级默认单例 */
const defaultStorePort: RunnerStorePort = {
  upsertRunner,
  touchRunnerHeartbeat,
  runnerProjectsReplace,
  listRunnerProjects,
  claimTask,
  getQueuedTask,
  upsertTaskResult,
  appendEvent,
  getRunner,
  listRunners,
  listClaimedTasks,
  requeueStaleTask,
  markRunnerOffline,
  listOrphanedTasks,
  failOrphanedTask,
  setTaskFailureKind,
};

/** 一次心跳超期清算的结果摘要（可观测 + 确定性单测断言用） */
export interface RunnerSweepResult {
  /** 本次被判超期并降级的 runnerId（`machineId`） */
  offlineRunners: string[];
  /** 本次被回收的悬挂任务本地 id（`claimed`/`running` → `queued`） */
  requeuedTasks: string[];
}

/** 一次孤儿墙钟清算的结果摘要（v0.8.7 O2；可观测 + 确定性单测断言用） */
export interface RunnerOrphanSweepResult {
  /** 本次被墙钟判死的任务本地 id（`claimed`/`running` → `failed` + `settled`） */
  orphanedTasks: string[];
}

/** 清算循环缺省周期（配置不可读时的兜底；正常路径由 `runner.heartbeatTimeoutMs` 推导） */
const DEFAULT_SWEEP_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// 端点装配
// ---------------------------------------------------------------------------

export interface RunnerEndpointOptions {
  /** core 租约角色（`follower` ⇒ 503 `runner_not_owner`） */
  role: () => CoreRole;
  /** 机器清单（`machines[].token` 鉴权 / `groups[]` 成员判定 / `runner.holdMs` 阈值） */
  config: () => MachinesConfig;
  /** hold 上限覆盖（缺省取 `config().runner.holdMs`；单测用） */
  holdMs?: () => number;
  /** 当前时刻（ms epoch；单测注入确定性时钟） */
  now?: () => number;
  /** 存储端口（缺省绑定默认 store 单例） */
  store?: RunnerStorePort;
  /**
   * 事件写入后的收件箱唤醒回调（A7）。缺省 no-op；`bridge/index.ts` 注入 `signalEvents`，
   * 令本模块生产的五类事件与桥其余事件路径**同构**（落库 + 立即唤醒 `a2a_wait` 订阅者）。
   * 回调异常仅告警，绝不反噬端点主流程。
   */
  signalEvents?: () => void;
  /**
   * 心跳超期清算循环周期覆盖（ms；缺省由 `runner.heartbeatTimeoutMs / 4` 推导，下限 1000）。
   * 单测注入大值以关闭自动循环、改用 `sweepStale()` 确定性驱动。
   */
  sweepIntervalMs?: number;
  /**
   * 降级登记表 sink（v0.8.8 O5；可选）。心跳超期清算 / 孤儿墙钟清算**读取失败**（配置 /
   * 在飞任务，导致本轮返回空结果）时 `mark`，成功 tick 时 `clear`。**纯观测**，不改任何
   * 降级返回值语义。缺省（未注入）⇒ 不外报，保持既有行为（单测 / 非 http 形态零改动）。
   */
  degradation?: DegradationSink;
}

export interface RunnerEndpointHandle {
  /**
   * 处理一次请求。返回 `true` = 已处理（响应已写出）；`false` = 非本模块路由（调用方落 404）。
   * 非 `http` 形态 / 非 `/runner/*` 路径一律 `false`。
   */
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
  /** 唤醒挂起的 `/connect`（`machineId` 省略 = 广播；新任务入队 / 事件到达时调用） */
  wake(machineId?: string): void;
  /** 追加一条 `stop` 控制命令（停本机**单个项目** Agent；`projectId` = 目标项目） */
  enqueueStop(machineId: string, projectId: string): void;
  /** 追加一条 `cancel-task` 控制命令（`projectId` 由桥侧任务记录解析补入载荷） */
  enqueueCancelTask(machineId: string, taskId: string): void;
  /** 观测：当前挂起的长轮询数量（单测断言用） */
  pendingConnects(): number;
  /** 观测：某机器待发控制命令数（单测断言用） */
  pendingControls(machineId: string): number;
  /**
   * 立即执行一次**心跳超期清算**（A7；同步、幂等）。timer 自动调用本方法；单测可显式调用以
   * 获得确定性。非 `http` 形态 / 非 `owner` ⇒ 空结果（不抢清算权，也不读库）。
   */
  sweepStale(): RunnerSweepResult;
  /**
   * 立即执行一次**孤儿墙钟清算**（v0.8.7 O2；同步、幂等）。同 timer 周期，**恒在
   * `sweepStale()` 之后**（心跳先命中者走 requeue 可复活，墙钟只收残量）；单测可显式调用。
   * 非 `owner` ⇒ 空结果（不读库）。
   */
  sweepOrphanedTasks(): RunnerOrphanSweepResult;
}

interface PendingControl {
  kind: "stop" | "cancel-task";
  taskId: string | null;
  /** 目标项目（`stop` = 显式指定；`cancel-task` = 由任务记录解析；解析失败为 `""`） */
  projectId: string;
  /** 桥侧命令 id（`uuid`；随命令下发，machine 回执原样带回） */
  commandId: string;
  at: number;
  seq: number;
}

type AuthOutcome =
  | { ok: true; machine: MachineRef }
  | { ok: false; status: number; code: string; message: string };

type BodyOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string };

type ProjectsOutcome =
  | { ok: true; projects: RunnerProjectInput[] }
  | { ok: false; message: string };

type RequestedOutcome = { ok: true; value: string[] | null } | { ok: false; message: string };

type HoldOutcome = { ok: true; holdMs: number } | { ok: false; message: string };

/**
 * 组装 Runner 端点处理器（纯工厂，无副作用、不 bind）。
 * 由 `bridge/index.ts` 常驻 http 启动时创建并传入 `startHttpTransport`。
 */
export function createRunnerEndpoints(options: RunnerEndpointOptions): RunnerEndpointHandle {
  return new RunnerEndpoints(options);
}

class RunnerEndpoints implements RunnerEndpointHandle {
  private readonly options: RunnerEndpointOptions;
  private readonly store: RunnerStorePort;
  private readonly now: () => number;
  /** machineId → 挂起的 `/connect` 唤醒器集合 */
  private readonly waiters = new Map<string, Set<() => void>>();
  /** machineId → 待发控制命令（stop / cancel-task） */
  private readonly controls = new Map<string, PendingControl[]>();
  private controlSeq = 0;
  /** A7：心跳超期清算循环句柄（unref，不独撑事件循环） */
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(options: RunnerEndpointOptions) {
    this.options = options;
    this.store = options.store ?? defaultStorePort;
    this.now = options.now ?? (() => Date.now());
    this.sweepTimer = setInterval(() => {
      try {
        this.sweepStale();
      } catch (err) {
        // 清算循环不得因单次异常停摆（下一周期照常）
        bridgeLog.error("a2a-runner", `心跳超期清算循环异常：${toMessage(err)}`);
      }
      try {
        // O2：同 tick **先 stale 后墙钟** —— 心跳先命中者已 requeue 回 `queued`，
        // 墙钟判据（`claimed`/`running`）自然不再命中 ⇒ 两路竞争消解
        this.sweepOrphanedTasks();
      } catch (err) {
        bridgeLog.error("a2a-runner", `孤儿墙钟清算循环异常：${toMessage(err)}`);
      }
    }, this.resolveSweepInterval());
    // 后台维护计时器 unref：正常运行由 http listener 持住事件循环；单测 / 停机不被拖住
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (
      path !== RUNNER_REGISTER_PATH &&
      path !== RUNNER_CONNECT_PATH &&
      path !== RUNNER_RESULT_PATH
    ) {
      return false;
    }
    // owner 门闩：follower 不提供端点（避免同机双实例各自给 Runner 下发命令）
    if (this.options.role() !== "owner") {
      sendError(
        res,
        503,
        RUNNER_ERR_NOT_OWNER,
        "本桥实例非 core 租约 owner（调度权在其它实例）：Runner 端点仅 owner 提供",
      );
      return true;
    }
    if (req.method !== "POST") {
      sendError(
        res,
        405,
        RUNNER_ERR_METHOD_NOT_ALLOWED,
        `Runner 端点仅支持 POST（收到 ${req.method ?? "?"}）`,
      );
      return true;
    }
    try {
      if (path === RUNNER_REGISTER_PATH) {
        await this.handleRegister(req, res);
      } else if (path === RUNNER_CONNECT_PATH) {
        await this.handleConnect(req, res);
      } else {
        await this.handleResult(req, res);
      }
    } catch (err) {
      bridgeLog.error("a2a-runner", `Runner 端点处理异常（${path}）：${toMessage(err)}`);
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          // 客户端已断开：无可写目标，忽略
        }
      } else {
        sendError(res, 500, "internal_error", toMessage(err));
      }
    }
    return true;
  }

  wake(machineId?: string): void {
    if (machineId === undefined) {
      for (const set of this.waiters.values()) drain(set);
      return;
    }
    const set = this.waiters.get(machineId);
    if (set !== undefined) drain(set);
  }

  enqueueStop(machineId: string, projectId: string): void {
    if (machineId.length === 0 || projectId.length === 0) return;
    this.controlQueue(machineId).push({
      kind: "stop",
      taskId: null,
      projectId,
      commandId: randomUUID(),
      at: this.now(),
      seq: this.controlSeq++,
    });
  }

  enqueueCancelTask(machineId: string, taskId: string): void {
    if (machineId.length === 0 || taskId.length === 0) return;
    this.controlQueue(machineId).push({
      kind: "cancel-task",
      taskId,
      projectId: this.resolveTaskProjectId(taskId),
      commandId: randomUUID(),
      at: this.now(),
      seq: this.controlSeq++,
    });
  }

  /**
   * 解析任务所属项目（`cancel-task` 载荷补 `projectId` 用）。读库失败 / 无记录 ⇒ 空串 ——
   * machine 侧 cancel-task 按 `taskId` 定位台账、**不消费**该字段，故缺省不影响执行。
   */
  private resolveTaskProjectId(taskId: string): string {
    try {
      return this.store.getQueuedTask(taskId)?.projectId ?? "";
    } catch (err) {
      bridgeLog.warn(
        "a2a-runner",
        `解析 cancel-task 目标项目失败（taskId=${taskId}）：${toMessage(err)}`,
      );
      return "";
    }
  }

  pendingConnects(): number {
    let total = 0;
    for (const set of this.waiters.values()) total += set.size;
    return total;
  }

  pendingControls(machineId: string): number {
    return this.controls.get(machineId)?.length ?? 0;
  }

  // ------------------------------------------------------------------
  // A7 心跳超期清算（runner.offline / task.stale 的生产者）
  // ------------------------------------------------------------------

  /**
   * 判决并清算超期 Runner（幂等；timer 周期调用，单测可直接调用）。
   *
   * 判据：注册态 `online` 且 `now - lastHeartbeatAt >= runner.heartbeatTimeoutMs`，则
   * ① `requeueStaleTask`（B2：名下 `claimed`/`running` → `queued` + 清 claim 令牌/时刻两字段，
   * O4 起保留 `claimed_by`）+ `task.stale`；
   * ② `markRunnerOffline` + `runner.offline`（D8：只降态、不 stop）。
   * 门闩：非 `owner` ⇒ 空结果（不读库、不抢清算权）。
   */
  sweepStale(): RunnerSweepResult {
    const result: RunnerSweepResult = { offlineRunners: [], requeuedTasks: [] };
    if (this.options.role() !== "owner") return result;
    // O5：本轮先按健康登记；任一读取失败将在对应 catch 标降级（返回值语义不变）
    this.options.degradation?.clear(DEGRADED_HEARTBEAT_SWEEP);
    let timeoutMs: number;
    try {
      timeoutMs = this.options.config().runner.heartbeatTimeoutMs;
    } catch (err) {
      this.options.degradation?.mark(
        DEGRADED_HEARTBEAT_SWEEP,
        `心跳超期清算读取配置失败：${toMessage(err)}`,
      );
      bridgeLog.error("a2a-runner", `心跳超期清算读取配置失败：${toMessage(err)}`);
      return result;
    }
    let runners: RunnerRecord[];
    try {
      runners = this.store.listRunners();
    } catch (err) {
      this.options.degradation?.mark(
        DEGRADED_HEARTBEAT_SWEEP,
        `心跳超期清算读取 Runner 注册表失败：${toMessage(err)}`,
      );
      bridgeLog.error("a2a-runner", `心跳超期清算读取 Runner 注册表失败：${toMessage(err)}`);
      return result;
    }
    const now = this.now();
    for (const runner of runners) {
      if (runner.state === "offline") continue; // 已降级：不重复清算 / 不重复发事件
      const heartbeat = Date.parse(runner.lastHeartbeatAt);
      if (!Number.isFinite(heartbeat)) continue;
      const idleMs = now - heartbeat;
      if (idleMs < timeoutMs) continue;
      // ① 先回收在飞任务：即便降态随后失败，任务也已回到 queued、可被再领取
      const requeued = this.requeueRunnerTasks(runner, idleMs);
      result.requeuedTasks.push(...requeued);
      // ② 降注册态 + runner.offline（D8：不触发 stop，不碰本机 agent）
      try {
        this.store.markRunnerOffline(runner.runnerId);
      } catch (err) {
        bridgeLog.error(
          "a2a-runner",
          `Runner 降级 offline 失败（runnerId=${runner.runnerId}）：${toMessage(err)}`,
        );
        continue;
      }
      result.offlineRunners.push(runner.machineId);
      this.emitEvent({
        kind: RUNNER_EVENT_OFFLINE,
        state: "offline",
        payload: JSON.stringify({
          machineId: runner.machineId,
          runnerId: runner.runnerId,
          lastHeartbeatAt: runner.lastHeartbeatAt,
          timeoutMs,
          idleMs,
        }),
      });
      bridgeLog.warn(
        "a2a-runner",
        `Runner 心跳超期：machineId=${runner.machineId}（静默 ${idleMs}ms ≥ ${timeoutMs}ms）→ offline，回收任务 ${requeued.length} 个`,
      );
    }
    return result;
  }

  /** 回收某超期 Runner 名下的在飞任务；逐条 CAS（`expectedClaimedBy` 防误清他人）+ `task.stale` */
  private requeueRunnerTasks(runner: RunnerRecord, idleMs: number): string[] {
    let claimed: QueuedTaskRecord[];
    try {
      claimed = this.store.listClaimedTasks(runner.machineId);
    } catch (err) {
      bridgeLog.error(
        "a2a-runner",
        `清算读取在飞任务失败（machineId=${runner.machineId}）：${toMessage(err)}`,
      );
      return [];
    }
    const requeued: string[] = [];
    for (const task of claimed) {
      let hit: boolean;
      try {
        hit = this.store.requeueStaleTask(task.taskId, runner.machineId);
      } catch (err) {
        bridgeLog.error("a2a-runner", `清算任务失败（taskId=${task.taskId}）：${toMessage(err)}`);
        continue;
      }
      if (!hit) continue; // CAS 落空（已被再领取 / 已结算）⇒ 不产事件
      requeued.push(task.taskId);
      this.emitEvent({
        kind: RUNNER_EVENT_TASK_STALE,
        featureId: task.featureId,
        taskId: task.taskId,
        state: "queued",
        payload: JSON.stringify({
          machineId: runner.machineId,
          projectId: task.projectId,
          featureId: task.featureId,
          claimedAt: task.claimedAt,
          idleMs,
        }),
      });
    }
    return requeued;
  }

  // ------------------------------------------------------------------
  // O2 孤儿墙钟清算（task.orphaned 的生产者；v0.8.7）
  // ------------------------------------------------------------------

  /**
   * 判决并清算墙钟超期的在飞任务（幂等；timer 在 `sweepStale()` 之后同 tick 调用，单测可直接调用）。
   *
   * 判据（**任务驱动**，与注册态无关）：`queue_state ∈ {claimed, running}` ∧
   * `claimed_at < now - runner.orphanTimeoutMs` ⇒ 逐条 CAS 置 `failed` + `settled` +
   * `failure_kind='runner'`（**不可续跑**的载体侧事实，v0.8.8 O1 由 `infra` 改判；**不清 claim 三字段**
   * —— §2.9 契约 3：墙钟判死后的迟到件须仍能
   * 通过 `/runner/result` 的 token 比对落幂等口）+ `task.orphaned` 事件。
   * Feature 侧无需本模块动作：节点 `failed` 由调度器 tick 的**静止收敛**发 `feature.failure_report`。
   * 门闩：非 `owner` ⇒ 空结果（不读库）。与心跳清算的分工：心跳管「机器死没死」→ requeue 可复活；
   * 墙钟管「任务自己超没超」→ `failed` 记账交宿主（`advance(retryTaskIds)`）。
   */
  sweepOrphanedTasks(): RunnerOrphanSweepResult {
    const result: RunnerOrphanSweepResult = { orphanedTasks: [] };
    if (this.options.role() !== "owner") return result;
    // O5：本轮先按健康登记；读取失败将在对应 catch 标降级（返回值语义不变）
    this.options.degradation?.clear(DEGRADED_ORPHAN_SWEEP);
    let timeoutMs: number;
    try {
      timeoutMs = this.options.config().runner.orphanTimeoutMs;
    } catch (err) {
      this.options.degradation?.mark(
        DEGRADED_ORPHAN_SWEEP,
        `孤儿墙钟清算读取配置失败：${toMessage(err)}`,
      );
      bridgeLog.error("a2a-runner", `孤儿墙钟清算读取配置失败：${toMessage(err)}`);
      return result;
    }
    const now = this.now();
    let orphans: QueuedTaskRecord[];
    try {
      orphans = this.store.listOrphanedTasks(new Date(now - timeoutMs).toISOString());
    } catch (err) {
      this.options.degradation?.mark(
        DEGRADED_ORPHAN_SWEEP,
        `孤儿墙钟清算读取在飞任务失败：${toMessage(err)}`,
      );
      bridgeLog.error("a2a-runner", `孤儿墙钟清算读取在飞任务失败：${toMessage(err)}`);
      return result;
    }
    for (const task of orphans) {
      let hit: boolean;
      try {
        hit = this.store.failOrphanedTask(task.taskId);
      } catch (err) {
        bridgeLog.error("a2a-runner", `墙钟判死失败（taskId=${task.taskId}）：${toMessage(err)}`);
        continue;
      }
      if (!hit) continue; // CAS 落空（迟到结果已落库 / 心跳已 requeue）⇒ 不产事件
      result.orphanedTasks.push(task.taskId);
      const elapsedMs = now - Date.parse(task.claimedAt ?? "");
      this.emitEvent({
        kind: RUNNER_EVENT_TASK_ORPHANED,
        featureId: task.featureId,
        taskId: task.taskId,
        state: "failed",
        payload: JSON.stringify({
          machineId: task.claimedBy,
          projectId: task.projectId,
          featureId: task.featureId,
          claimedAt: task.claimedAt,
          elapsedMs,
          timeoutMs,
        }),
      });
      bridgeLog.warn(
        "a2a-runner",
        `任务墙钟判死：taskId=${task.taskId} machineId=${task.claimedBy ?? "?"}（领取后 ${elapsedMs}ms ≥ ${timeoutMs}ms）→ failed(${ORPHAN_FAILURE_KIND})`,
      );
    }
    return result;
  }

  /**
   * 若该 machineId 的**先前注册态**为 `offline`（心跳超期降级后回归），发 `runner.online`。
   * **必须在心跳写入（`touchRunnerHeartbeat` / `upsertRunner`）之前调用** —— 二者恒置回 online。
   * 读库失败 / 无注册行 / 先前已 online ⇒ 静默（不阻断注册与 poll）。
   */
  private emitOnlineIfRecovered(machineId: string): void {
    let prior: RunnerRecord | null;
    try {
      prior = this.store.getRunner(machineId);
    } catch (err) {
      bridgeLog.error("a2a-runner", `读取 Runner 先前态失败（machineId=${machineId}）：${toMessage(err)}`);
      return;
    }
    if (prior === null || prior.state !== "offline") return;
    this.emitEvent({
      kind: RUNNER_EVENT_ONLINE,
      state: "online",
      payload: JSON.stringify({
        machineId: prior.machineId,
        runnerId: prior.runnerId,
        lastHeartbeatAt: prior.lastHeartbeatAt,
      }),
    });
    bridgeLog.info("a2a-runner", `Runner 心跳恢复：machineId=${prior.machineId}（offline → online）`);
  }

  /** 清算循环周期：显式覆盖优先；否则按心跳阈值 / 4 推导（下限 1s，读配置失败用兜底） */
  private resolveSweepInterval(): number {
    if (this.options.sweepIntervalMs !== undefined) {
      return Math.max(1, Math.floor(this.options.sweepIntervalMs));
    }
    let timeoutMs = DEFAULT_SWEEP_INTERVAL_MS;
    try {
      timeoutMs = this.options.config().runner.heartbeatTimeoutMs;
    } catch {
      // 配置不可读：用兜底周期（请求路径各自另有配置错误处理）
    }
    return Math.max(1_000, Math.floor(timeoutMs / 4));
  }

  // ------------------------------------------------------------------
  // /runner/register
  // ------------------------------------------------------------------

  private async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = readBearerToken(req);
    if (token === null) {
      sendError(res, 401, RUNNER_ERR_UNAUTHORIZED, "缺少 Bearer token");
      return;
    }
    const bodyRes = await readJsonBody(req);
    if (!bodyRes.ok) {
      sendError(res, bodyRes.status, bodyRes.code, bodyRes.message);
      return;
    }
    const body = bodyRes.body;
    const machineId = asNonEmptyString(body["machineId"]);
    if (machineId === null) {
      sendError(res, 400, RUNNER_ERR_BAD_REQUEST, "machineId 必须是非空字符串");
      return;
    }
    const config = this.options.config();
    const auth = authenticate(token, machineId, config);
    if (!auth.ok) {
      sendError(res, auth.status, auth.code, auth.message);
      return;
    }
    const protocolVersion = asNonEmptyString(body["protocolVersion"]);
    if (protocolVersion === null) {
      sendError(res, 400, RUNNER_ERR_BAD_REQUEST, "protocolVersion 必须是非空字符串");
      return;
    }
    const mismatch = protocolRejection(machineId, protocolVersion);
    if (mismatch !== null) {
      sendError(res, 403, RUNNER_ERR_PROTOCOL_MISMATCH, mismatch);
      return;
    }
    const projectsRes = parseProjects(body["projects"]);
    if (!projectsRes.ok) {
      sendError(res, 400, RUNNER_ERR_BAD_REQUEST, projectsRes.message);
      return;
    }
    const version = asNonEmptyString(body["version"]);
    const runnerId = machineId;
    // A7：注册即心跳 ⇒ 先判先前态（此前可能因心跳超期被降 offline）→ 回线发 runner.online
    this.emitOnlineIfRecovered(machineId);
    this.store.upsertRunner({
      runnerId,
      machineId,
      protocolVersion,
      version,
      state: "online",
    });
    this.store.runnerProjectsReplace(runnerId, projectsRes.projects);
    this.emitEvent({
      kind: RUNNER_EVENT_REGISTERED,
      state: "online",
      payload: JSON.stringify({
        machineId,
        runnerId,
        protocolVersion,
        projects: projectsRes.projects.map((project) => project.projectId),
      }),
    });
    bridgeLog.info("a2a-runner", `Runner 注册：machineId=${machineId} 项目数=${projectsRes.projects.length}`, {
      protocolVersion,
    });
    sendOk(res, {
      ack: true,
      runnerId,
      machineId,
      protocolVersion,
      projects: projectsRes.projects.map((project) => project.projectId),
    });
  }

  // ------------------------------------------------------------------
  // /runner/connect（长轮询；poll 即心跳）
  // ------------------------------------------------------------------

  private async handleConnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = readBearerToken(req);
    if (token === null) {
      sendError(res, 401, RUNNER_ERR_UNAUTHORIZED, "缺少 Bearer token");
      return;
    }
    const bodyRes = await readJsonBody(req);
    if (!bodyRes.ok) {
      sendError(res, bodyRes.status, bodyRes.code, bodyRes.message);
      return;
    }
    const body = bodyRes.body;
    const machineId = asNonEmptyString(body["machineId"]);
    if (machineId === null) {
      sendError(res, 400, RUNNER_ERR_BAD_REQUEST, "machineId 必须是非空字符串");
      return;
    }
    const config = this.options.config();
    const auth = authenticate(token, machineId, config);
    if (!auth.ok) {
      sendError(res, auth.status, auth.code, auth.message);
      return;
    }
    const requestedRes = parseRequestedProjects(body["projects"]);
    if (!requestedRes.ok) {
      sendError(res, 400, RUNNER_ERR_BAD_REQUEST, requestedRes.message);
      return;
    }
    const holdRes = this.resolveHold(body["holdMs"], config);
    if (!holdRes.ok) {
      sendError(res, 400, RUNNER_ERR_BAD_REQUEST, holdRes.message);
      return;
    }
    const claimableRes = this.claimableProjects(machineId, requestedRes.value, config);
    if (!claimableRes.ok) {
      sendError(res, 403, RUNNER_ERR_PROJECT_NOT_MEMBER, claimableRes.message);
      return;
    }
    const claimable = claimableRes.projects;
    // poll 即心跳：先读先前态判「离线→回线」（A7 runner.online），再刷新注册态
    // （心跳超期只降在线态，不触发 stop —— D8）
    this.emitOnlineIfRecovered(machineId);
    this.store.touchRunnerHeartbeat(machineId);

    const deadline = this.now() + holdRes.holdMs;
    for (;;) {
      if (res.destroyed || res.writableEnded) return;
      // 控制命令零成本、已就绪 ⇒ 先于 claim 评估（避免「先 claim 再发现该下发 stop」而丢任务）
      const control = this.takeControl(machineId);
      if (control !== null) {
        sendOk(res, control);
        return;
      }
      const claimed =
        claimable.length === 0
          ? null
          : this.store.claimTask({ claimedBy: machineId, projectIds: claimable });
      if (claimed !== null) {
        this.emitClaim(claimed, machineId);
        sendOk(res, toDispatchCommand(claimed));
        return;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        sendNoContent(res);
        return;
      }
      await this.waitForWake(machineId, remaining);
    }
  }

  // ------------------------------------------------------------------
  // /runner/result（claim_token 校验 + O4 补结算窄口 + 幂等落库 + ack）
  // ------------------------------------------------------------------

  private async handleResult(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = readBearerToken(req);
    if (token === null) {
      sendError(res, 401, RUNNER_ERR_UNAUTHORIZED, "缺少 Bearer token");
      return;
    }
    const bodyRes = await readJsonBody(req);
    if (!bodyRes.ok) {
      sendError(res, bodyRes.status, bodyRes.code, bodyRes.message);
      return;
    }
    const body = bodyRes.body;
    const machineId = asNonEmptyString(body["machineId"]);
    if (machineId === null) {
      sendError(res, 400, RUNNER_ERR_BAD_REQUEST, "machineId 必须是非空字符串");
      return;
    }
    const config = this.options.config();
    const auth = authenticate(token, machineId, config);
    if (!auth.ok) {
      sendError(res, auth.status, auth.code, auth.message);
      return;
    }
    const taskId = asNonEmptyString(body["taskId"]);
    if (taskId === null) {
      sendError(res, 400, RUNNER_ERR_BAD_REQUEST, "taskId 必须是非空字符串");
      return;
    }
    const stateRaw = body["state"];
    if (!isTaskState(stateRaw)) {
      sendError(res, 400, RUNNER_ERR_BAD_REQUEST, `state 非法（可选 ${TASK_STATES.join(" / ")}）`);
      return;
    }
    // **补结算窄口**（v0.8.7 O4）：machine 启动时其进程内 outbox 已丢 claim 令牌，允许
    // 「**无 claimToken 且 state=failed**」的迟到补报落账。窄口命中须同时满足四道限制：
    // ① 只能置 failed（非 failed 仍走原强校验，缺令牌 409）；
    // ② 桥侧行 state='working'（未结算）；
    // ③ body machineId 与 Bearer 身份一致（authenticate 已把守）；
    // ④ 行级绑定：claimed_by = 上报 machineId ∧（queue_state ∈ {queued,claimed} ∨
    //    (running ∧ claimed_by = machineId)）—— 防**敌手机器的迟到补报击穿「已被重领取」的
    //    重派执行**（行被别机重领后 state 仍 working、令牌已换新，无令牌者必须照旧 409，
    //    窄口不得击穿既有保护）。
    // 另加 ⑤ text 非空强校验（400）、⑥ bridgeLog.warn 审计行。不做限流（攻击面已被 ④ 有界）。
    const claimToken = asNonEmptyString(body["claimToken"]);
    const supplemental = claimToken === null && stateRaw === "failed";
    if (supplemental) {
      const reason = asNonEmptyString(body["text"]);
      if (reason === null) {
        sendError(res, 400, RUNNER_ERR_BAD_REQUEST, "无 claimToken 的补结算上报要求 text（失败原因）为非空字符串");
        return;
      }
    } else if (claimToken === null) {
      sendError(res, 400, RUNNER_ERR_BAD_REQUEST, "claimToken 必须是非空字符串");
      return;
    }
    const artifactsRes = parseArtifacts(body["artifacts"]);
    if (!artifactsRes.ok) {
      sendError(res, 400, RUNNER_ERR_BAD_REQUEST, artifactsRes.message);
      return;
    }
    const existing = this.store.getQueuedTask(taskId);
    if (existing === null) {
      sendError(res, 404, RUNNER_ERR_TASK_NOT_FOUND, `未知任务 ${taskId}（本地任务存储无记录）`);
      return;
    }
    let viaSupplementalGate = false;
    if (claimToken !== null) {
      if (existing.claimToken !== claimToken) {
        // 令牌不符 ⇒ 唯一复活路径 = 补结算窄口（①②④）；不满足照旧 409
        if (stateRaw === "failed" && supplementalGateHolds(existing, machineId)) {
          viaSupplementalGate = true;
        } else {
          sendError(
            res,
            409,
            RUNNER_ERR_CLAIM_TOKEN_MISMATCH,
            `claim_token 不匹配（任务当前${existing.claimToken === null ? "未领取（已清算）" : "领取令牌不同"}；补结算须 state=failed 且行仍绑定本机领取）`,
          );
          return;
        }
      }
    } else if (!supplementalGateHolds(existing, machineId)) {
      sendError(
        res,
        409,
        RUNNER_ERR_CLAIM_TOKEN_MISMATCH,
        `无 claimToken 的补结算仅受理 failed 且行仍绑定本机领取（任务当前 state=${existing.state} queue_state=${existing.queueState} claimedBy=${existing.claimedBy ?? "null"}）`,
      );
      return;
    }
    if (viaSupplementalGate) {
      const claimedMs = existing.claimedAt === null ? Number.NaN : Date.parse(existing.claimedAt);
      const elapsedMs = Number.isFinite(claimedMs) ? this.now() - claimedMs : Number.NaN;
      bridgeLog.warn(
        "a2a-runner",
        `Runner 补结算窄口受理（无 claimToken 的迟到 failed）：machineId=${machineId} taskId=${taskId} 距 claimed_at ${Number.isFinite(elapsedMs) ? `${elapsedMs}ms` : "未知"}`,
      );
    }
    const stored = this.store.upsertTaskResult({
      machineId,
      taskId,
      projectId: asNonEmptyString(body["projectId"]) ?? existing.projectId,
      contextId: asNonEmptyString(body["contextId"]) ?? existing.contextId,
      state: stateRaw,
      artifactsJson: artifactsRes.artifactsJson,
      text: typeof body["text"] === "string" ? body["text"] : null,
      featureId: existing.featureId,
      remoteTaskId: asNonEmptyString(body["remoteTaskId"]),
      // **诊断宽 JSON 原文落库 + `task.continued` 派生**（v0.8.8 O3 · §2.2 / §2.5）：整个
      // `diagnostics` 对象原样交给既有结果写口（**不新增写口 / 端点**），由 store 序列化落
      // `tasks.diagnostics_json` 并据 `continueAttempts` 派生事件。**不落派生布尔**（返工红线）。
      diagnostics: body["diagnostics"],
    });
    // **失败分类写口**（v0.8.7 O3 建口；v0.8.8 O1 改口径 · §2.1 写口 (i)）：**machine 上报的
    // `failureKind` 是分类事实源**，orch 只做闭集校验 + 落库；未上报合格六类值时才落兜底
    // （缺键 ⇒ 原生 `AcpError.kind` 映射；旧值 / 未知值 ⇒ `business`），并 warn 带上原值留痕
    // （D2：混跑期不得据此区分「真 business」与「兜底 business」之外的信息）。
    // **判据**：本次上报**胜出**了 `failed` 终态 —— 行此前非 `failed`（`existing.state !== "failed"`）
    // 才写 ⇒ 迟到 / 重复上报**不得改写**既有分类（尤其不得把墙钟 O2 已置的 `runner` 覆盖掉），
    // 与 `upsertTaskResult`「首个终态胜出」同语义。**不得因取值非法而整包拒收**（丢单）。
    if (stateRaw === "failed" && stored.state === "failed" && existing.state !== "failed") {
      const verdict = resolveReportedFailureKind(
        body["failureKind"],
        readReportedAcpErrorKind(body["diagnostics"]),
      );
      this.store.setTaskFailureKind(taskId, verdict.kind);
      if (verdict.fallbackFrom !== null) {
        bridgeLog.warn(
          "a2a-runner",
          `Runner 上报的 failureKind 不合 2.3 六类闭集 ⇒ 兜底落 ${verdict.kind}（failure_kind_fallback=${verdict.fallbackFrom}，混跑期存量由 §2.1 迁移脚本清理）：machineId=${machineId} taskId=${taskId}`,
        );
      }
    }
    // **契约 3 的可观测面**（v0.8.7 O5）：迟到 / 重复上报的终态与**已落终态不一致** ⇒ 只留 warn
    // 痕迹（零写入由 `upsertTaskResult` 的 WHERE 保证）；**不改回执、不改落库**。
    if (SETTLED_TERMINAL_STATES.includes(existing.state) && stateRaw !== existing.state) {
      bridgeLog.warn(
        "a2a-runner",
        `Runner 迟到终态与已落终态不一致（首个终态胜出，零写入）：machineId=${machineId} taskId=${taskId} 上报态=${stateRaw} 现存态=${existing.state}`,
      );
    }
    bridgeLog.info("a2a-runner", `Runner 回传结果：machineId=${machineId} taskId=${taskId} state=${stored.state}`);
    // **契约 3（迟到 / 重复终态 = 2xx-with-ignore）**：`upsertTaskResult` 的
    // `WHERE state NOT IN ('completed','failed','blocked')` 使**重复 / 迟到终态整条 UPDATE
    // 零写入**（首个终态胜出），故回执**必须恒为 200 + `ack:true`**（不一致时另 warn 留痕，见上）。
    // **不得改成 4xx** —— machine 侧 outbox 对**任何非 2xx 一律保留待重试**，此处返回 4xx 会让
    // 已落终态的迟到件**无限退避死循环**（永不清 `pending`）。
    sendOk(res, {
      ack: true,
      taskId,
      state: stored.state,
      // 已终态行不再被覆盖（首个终态胜出）⇒ 重复上报即幂等 ack
      idempotent: existing.state === stored.state,
    });
  }

  // ------------------------------------------------------------------
  // 内部：claim / 控制命令 / 唤醒
  // ------------------------------------------------------------------

  /**
   * 计算本机可领取项目集合。判据（claim 前置，v0.8.6 §2.5 S5「任一组放行」）：
   * **未配任何组 ⇒ 全量接纳（零破坏）**；配了组 ⇒ `(machineId, projectId)` **属本机任一组**
   * `groups.some(g => g.memberKeys.has(memberKey(machineId, projectId)))` **且**项目归属该机器
   * （本机注册投影）。Runner 通道无 MCP 身份（machine 侧零组字段），故按**全组并集**判定，
   * 不按连接所在组收窄。显式 `projects` 请求中若含非成员项目 ⇒ `project_not_a_member`。
   */
  private claimableProjects(
    machineId: string,
    requested: string[] | null,
    config: MachinesConfig,
  ): { ok: true; projects: string[] } | { ok: false; message: string } {
    const groups = config.groups ?? [];
    const selective = groups.length > 0;
    const inAnyGroup = (projectId: string): boolean =>
      groups.some((g) => g.memberKeys.has(memberKey(machineId, projectId)));
    if (requested !== null && selective) {
      const denied = requested.filter((projectId) => !inAnyGroup(projectId));
      if (denied.length > 0) {
        return {
          ok: false,
          message: `项目不在本机任一组成员集合（machineId=${machineId}）：${denied.join(", ")}`,
        };
      }
    }
    const registered = this.store.listRunnerProjects(machineId).map((project) => project.projectId);
    let claimable = registered.filter((projectId) => !selective || inAnyGroup(projectId));
    if (requested !== null) {
      claimable = claimable.filter((projectId) => requested.includes(projectId));
    }
    return { ok: true, projects: claimable };
  }

  /** 取最早就绪的控制命令（按入队时刻；同刻按入队序） */
  private takeControl(machineId: string): RunnerCommand | null {
    const queue = this.controls.get(machineId);
    if (queue === undefined || queue.length === 0) return null;
    let earliestIndex = 0;
    for (let i = 1; i < queue.length; i += 1) {
      const candidate = queue[i];
      const earliest = queue[earliestIndex];
      if (candidate === undefined || earliest === undefined) continue;
      if (candidate.at < earliest.at || (candidate.at === earliest.at && candidate.seq < earliest.seq)) {
        earliestIndex = i;
      }
    }
    const [item] = queue.splice(earliestIndex, 1);
    if (queue.length === 0) this.controls.delete(machineId);
    if (item === undefined) return null;
    if (item.kind === "stop") {
      return { command: "stop", projectId: item.projectId, commandId: item.commandId };
    }
    return {
      command: "cancel-task",
      taskId: item.taskId ?? "",
      projectId: item.projectId,
      commandId: item.commandId,
    };
  }

  private controlQueue(machineId: string): PendingControl[] {
    let queue = this.controls.get(machineId);
    if (queue === undefined) {
      queue = [];
      this.controls.set(machineId, queue);
    }
    return queue;
  }

  private resolveHold(raw: unknown, config: MachinesConfig): HoldOutcome {
    const configured = this.options.holdMs === undefined ? config.runner.holdMs : this.options.holdMs();
    if (raw === undefined) return { ok: true, holdMs: configured };
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      return { ok: false, message: "holdMs 必须是非负整数（毫秒）" };
    }
    return { ok: true, holdMs: Math.min(raw, configured) };
  }

  private waitForWake(machineId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let set = this.waiters.get(machineId);
      if (set === undefined) {
        set = new Set<() => void>();
        this.waiters.set(machineId, set);
      }
      const target = set;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        target.delete(wake);
        resolve();
      };
      const wake = (): void => finish();
      const timer = setTimeout(finish, timeoutMs);
      target.add(wake);
    });
  }

  private emitClaim(rec: QueuedTaskRecord, machineId: string): void {
    this.emitEvent({
      kind: RUNNER_EVENT_TASK_CLAIMED,
      taskId: rec.taskId,
      state: "claimed",
      payload: JSON.stringify({
        machineId,
        projectId: rec.projectId,
        featureId: rec.featureId,
      }),
    });
  }

  /**
   * 统一事件出口（A7）：**先落库（`appendEvent`）再唤醒收件箱（`signalEvents`）** ——
   * 桥内所有 Runner/Task 事件与其余事件路径同构，`a2a_wait` 订阅者不会被本模块遗漏唤醒。
   */
  private emitEvent(rec: EventAppendInput): void {
    try {
      this.store.appendEvent(rec);
    } catch (err) {
      // 事件落库失败不得反噬端点主流程（Runner 拿到 5xx 会重试整轮，代价更大）；落库失败亦不唤醒
      bridgeLog.error("a2a-runner", `事件落库失败（kind=${rec.kind}）：${toMessage(err)}`);
      return;
    }
    this.signalEvents();
  }

  /** 唤醒收件箱长轮询订阅（注入回调；异常仅告警，绝不反噬事件主流程） */
  private signalEvents(): void {
    const signal = this.options.signalEvents;
    if (signal === undefined) return;
    try {
      signal();
    } catch (err) {
      bridgeLog.warn("a2a-runner", `事件唤醒失败（忽略）：${toMessage(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数小工具（鉴权 / 解析 / 应答）
// ---------------------------------------------------------------------------

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === "string" && (AGENT_KINDS as readonly string[]).includes(v);
}

function isRiskLevel(v: unknown): v is RiskLevel {
  return typeof v === "string" && (RISK_LEVELS as readonly string[]).includes(v);
}

function isTaskState(v: unknown): v is TaskState {
  return typeof v === "string" && (TASK_STATES as readonly string[]).includes(v);
}

/** 读取 `Authorization: Bearer <token>`（scheme 大小写不敏感；非该形态返回 null） */
function readBearerToken(req: IncomingMessage): string | null {
  const raw = req.headers["authorization"];
  if (typeof raw !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (match === null) return null;
  const token = match[1];
  return token === undefined || token.length === 0 ? null : token;
}

/**
 * 常量时间比较（等长证明由 SHA-256 摘要保证：先各自摘要再 `timingSafeEqual` ⇒
 * 长度差异不短路、不泄露原始长度）。token 非秘密长度时亦不早退。
 */
function tokensEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * 鉴权：token 形态（缺失已在调用方短路）→ machineId ∈ `machines[]` → 常量时间比对
 * `machines[].token`。**未配置 token ⇒ 拒绝**（`runner_unauthorized`，绝不 fail-open）。
 */
function authenticate(token: string, machineId: string, config: MachinesConfig): AuthOutcome {
  const machine = config.machines.find((candidate) => candidate.machineId === machineId);
  if (machine === undefined) {
    return {
      ok: false,
      status: 403,
      code: RUNNER_ERR_NOT_ALLOWED,
      message: `machineId "${machineId}" 不在机器白名单（machines[]）中`,
    };
  }
  if (machine.token === undefined || machine.token.length === 0) {
    return {
      ok: false,
      status: 401,
      code: RUNNER_ERR_UNAUTHORIZED,
      message: `machines[].token 未配置（machineId=${machineId}）：拒绝准入`,
    };
  }
  if (!tokensEqual(token, machine.token)) {
    return {
      ok: false,
      status: 401,
      code: RUNNER_ERR_UNAUTHORIZED,
      message: "Bearer token 不匹配",
    };
  }
  return { ok: true, machine };
}

/**
 * 协议主版本准入：`protocolVersion` 主版本必须 ∈ `SUPPORTED_PEER_PROTOCOL_MAJORS`。
 * 返回 `null` = 放行；否则返回结构化拒绝文案（含实测版本 / 可支持清单 / 升级指引）。
 */
function protocolRejection(machineId: string, version: string): string | null {
  const major = protocolMajor(version);
  if (major !== null && SUPPORTED_PEER_PROTOCOL_MAJORS.includes(major)) return null;
  return (
    `Runner 协议版本不受支持：machineId=${machineId}，实测 protocolVersion="${version}"` +
    `（主版本 ${major === null ? "无法解析" : String(major)}），本桥可支持主版本=[${SUPPORTED_PEER_PROTOCOL_MAJORS.join(", ")}]` +
    `；请升级 Runner 后重试`
  );
}

function protocolMajor(version: string): number | null {
  const dot = version.indexOf(".");
  const head = dot === -1 ? version : version.slice(0, dot);
  return /^\d+$/.test(head) ? Number(head) : null;
}

/** 解析注册载荷 `projects[]`（必填字段严格；未知 / 可选字段宽容忽略） */
function parseProjects(value: unknown): ProjectsOutcome {
  if (value === undefined) return { ok: true, projects: [] };
  if (!Array.isArray(value)) return { ok: false, message: "projects 必须是数组" };
  const projects: RunnerProjectInput[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = asRecord(value[i]);
    if (item === null) return { ok: false, message: `projects[${i}] 必须是对象` };
    const projectId = asNonEmptyString(item["projectId"]);
    if (projectId === null) {
      return { ok: false, message: `projects[${i}].projectId 必须是非空字符串` };
    }
    if (!isAgentKind(item["agentKind"])) {
      return {
        ok: false,
        message: `projects[${i}].agentKind 非法（可选 ${AGENT_KINDS.join(" / ")}）`,
      };
    }
    const a2aPort = item["a2aPort"];
    if (typeof a2aPort !== "number" || !Number.isInteger(a2aPort) || a2aPort < 1 || a2aPort > 65535) {
      return { ok: false, message: `projects[${i}].a2aPort 必须是 1-65535 的整数` };
    }
    const riskRaw = item["risk"];
    if (riskRaw !== undefined && riskRaw !== null && !isRiskLevel(riskRaw)) {
      return { ok: false, message: `projects[${i}].risk 非法（可选 read / write / full）` };
    }
    const statusRaw = item["status"];
    if (statusRaw !== undefined && statusRaw !== "online" && statusRaw !== "offline") {
      return { ok: false, message: `projects[${i}].status 非法（可选 online / offline）` };
    }
    projects.push({
      projectId,
      agentKind: item["agentKind"],
      a2aPort,
      risk: isRiskLevel(riskRaw) ? riskRaw : null,
      status: statusRaw === "offline" ? "offline" : "online",
      workspace: asNonEmptyString(item["workspace"]),
      endpoint: asNonEmptyString(item["endpoint"]),
      startedAt: asNonEmptyString(item["startedAt"]),
    });
  }
  return { ok: true, projects };
}

/** 解析 `/connect` 显式项目清单：`undefined` = 不限定（`null`）；非字符串项即 400 */
function parseRequestedProjects(value: unknown): RequestedOutcome {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false, message: "projects 必须是字符串数组" };
  const projects: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const projectId = asNonEmptyString(value[i]);
    if (projectId === null) return { ok: false, message: `projects[${i}] 必须是非空字符串` };
    if (!projects.includes(projectId)) projects.push(projectId);
  }
  return { ok: true, value: projects };
}

/** 解析回传 `artifacts`：数组 → JSON 字符串；字符串 → 原样；`null` / 省略 → `null` */
function parseArtifacts(
  value: unknown,
): { ok: true; artifactsJson: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, artifactsJson: null };
  if (typeof value === "string") return { ok: true, artifactsJson: value };
  if (Array.isArray(value)) {
    try {
      return { ok: true, artifactsJson: JSON.stringify(value) };
    } catch (err) {
      return { ok: false, message: `artifacts 无法序列化：${toMessage(err)}` };
    }
  }
  return { ok: false, message: "artifacts 必须是数组或 JSON 字符串" };
}

async function readJsonBody(req: IncomingMessage): Promise<BodyOutcome> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      size += buf.length;
      if (size > RUNNER_MAX_BODY_BYTES) {
        return {
          ok: false,
          status: 413,
          code: RUNNER_ERR_PAYLOAD_TOO_LARGE,
          message: `请求体超过 ${RUNNER_MAX_BODY_BYTES} 字节上限`,
        };
      }
      chunks.push(buf);
    }
  } catch (err) {
    return { ok: false, status: 400, code: RUNNER_ERR_BAD_REQUEST, message: `请求体读取失败：${toMessage(err)}` };
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) {
    return { ok: false, status: 400, code: RUNNER_ERR_BAD_REQUEST, message: "请求体为空（需 JSON 对象）" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, status: 400, code: RUNNER_ERR_BAD_REQUEST, message: "请求体不是合法 JSON" };
  }
  const body = asRecord(parsed);
  if (body === null) {
    return { ok: false, status: 400, code: RUNNER_ERR_BAD_REQUEST, message: "请求体必须是 JSON 对象" };
  }
  return { ok: true, body };
}

function toDispatchCommand(rec: QueuedTaskRecord): RunnerDispatchCommand {
  return {
    command: "dispatch",
    taskId: rec.taskId,
    projectId: rec.projectId,
    contextId: rec.contextId,
    commandId: randomUUID(),
    message: rec.dispatchMessage ?? rec.prompt ?? "",
    claimToken: rec.claimToken ?? "",
    featureId: rec.featureId,
    dependencies: rec.dependencies ?? [],
    inputs: rec.inputArtifacts,
  };
}

function drain(set: Set<() => void>): void {
  const waiters = Array.from(set);
  set.clear();
  for (const wake of waiters) {
    try {
      wake();
    } catch (err) {
      bridgeLog.warn("a2a-runner", `Runner 长轮询唤醒异常：${toMessage(err)}`);
    }
  }
}

/** 统一外壳（与 machine 侧 `/shutdown` 同形）：`{ result, data, error }` */
function sendOk(res: ServerResponse, data: unknown): void {
  respondJson(res, 200, { result: "ok", data, error: null });
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  respondJson(res, status, { result: "error", data: null, error: { code, message } });
}

/** 空超时 / 无命令 = 心跳：204 无体（machine 侧 `hasCommand` 以「空响应 / 空对象」判心跳） */
function sendNoContent(res: ServerResponse): void {
  if (res.headersSent || res.writableEnded) return;
  try {
    res.writeHead(204);
    res.end();
  } catch {
    // 客户端已断开：无可写目标，忽略（避免在共享 HTTP listener 内产生未处理拒绝）
  }
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(payload));
  } catch {
    // 客户端已断开：无可写目标，忽略
  }
}
