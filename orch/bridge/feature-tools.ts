/**
 * MCP Feature 工具组（v0.3.0 起 5 个；v0.8.10 O-N3 加只读 trace = 6 个）。
 *
 * 纯数据层处理器：只依赖 `session/store.ts`、`feature/state-machine.ts` 与 `./scheduler.js` 的
 * **纯函数**（`planResume` = 重派 / 解冻计划，无副作用、不触发调度），
 * 不触碰 A2A / 不触发调度（调度 kick 由 `bridge/index.ts` 在工具返回后统一发起）。
 *
 * - `handleFeatureCreate`  新建 Feature（**初态 `waiting_approval`** = 主链起点；落 `contextId` 到
 *                          `features.context_id`）
 * - `handleFeatureStatus`  查询单个 Feature 详情 / 全部列表（state + tasks 摘要 + artifacts；
 *                          v0.9.1 起单查增量扩 `acceptance` 聚合块 = 主链段轨迹 + 失败账单 + 节点态计数）
 * - `handleFeatureAdvance` orch agent 驱动主链推进（状态机校验合法后继；`note`→plan、
 *                          `decisions`/`contracts` 可选落 Feature Context；`answer` 用于 needs_input 补齐）；
 *                          **`waiting_approval → executing` 已禁用** —— 唯一准入 = `handleFeatureApprove`，
 *                          错误码 `feature_approval_required`；**`retryTaskIds`**（§2.3）走**显式特例**：
 *                          跳过 `canTransition`（转移表零改动、无自环）、重派指定 `failed` 节点 +
 *                          解冻闭包**外**的 `blocked` 下游，**不改 Feature 态**
 * - `handleFeatureApprove` 审批门：`waiting_approval → executing`
 * - `handleFeatureCancel`  非收口态 → `cancelled`；**`failed` 亦可经此归档为 `cancelled`**
 *                          （v0.9.5 O1：仅迁 Feature 态、不动节点账面；`completed`/`cancelled` 拒）
 * - `handleFeatureTrace`   **只读**投影「这个 Feature 为什么还没完成」（在等谁 / 排队位次 / 占位档）；
 *                          **v0.8.10 O-N3 起挂成 MCP 工具 `a2a_feature_trace`**（Feature 工具组 5→6），
 *                          与工作台端点 `/api/features/:id/trace` 复用**同一实现**（两出口零第二套判据）
 *
 * 另含 **② 可见面只读投影**（v0.8.9 §2.3，非 MCP 工具）：`projectTaskVisibility` =
 * 「派发包裹体积 + 触达次数 + machine diagnostics 透传」的**唯一实现**，
 * 由 `summarizeTask`（`a2a_feature_status`）与 `handleTaskStatus`（`a2a_task_status`）共用。
 */
import { randomUUID } from "node:crypto";
import {
  appendEvent,
  countQueuedBefore,
  createFeature,
  EVENT_FEATURE_STATE,
  featureTaskStateCounts,
  getFeature,
  getQueuedTask,
  listArtifactsByFeature,
  listBusyTasksForProject,
  listEvents,
  listFeatureTasks,
  listFeatures,
  listReadLaneTasksForProject,
  rearmForRetry,
  rearmTask,
  updateFeatureContext,
  updateFeatureRegistration,
  updateFeatureState,
  updateTaskState,
} from "../session/store.js";
import { EVENT_FAILURE_REPORT, planResume } from "./scheduler.js";
import type {
  FeatureContextPatch,
  FeatureRegistrationPatch,
  QueueState,
  QueuedTaskRecord,
} from "../session/store.js";
import type { TaskLane } from "../types.js";
import {
  allowedTransitions,
  canTransition,
  isFeatureState,
  isTerminalFeatureState,
} from "../feature/state-machine.js";
import type {
  ArtifactRecord,
  EventRecord,
  FailureKind,
  FeatureApproval,
  FeatureRecord,
  FeatureStage,
  FeatureState,
  InputArtifactRef,
  TaskRecord,
  TaskState,
} from "../types.js";
import {
  DEFAULT_FEATURE_APPROVAL,
  DEFAULT_FEATURE_STAGE,
  FEATURE_APPROVALS,
  FEATURE_STAGES,
  isFeatureApproval,
  isFeatureStage,
} from "../types.js";

/**
 * **节点重派**事件 kind（v0.6.1 REQ-05 §2.3 / N4）。
 *
 * 触发点 = `handleFeatureAdvance(retryTaskIds)` 对每个成功重排的失败节点（`rearmForRetry` CAS 命中）。
 * 语义：
 * - **不是** `feature.failure_report` —— 那条由静止收敛在 **Feature 级**发一次（见 `scheduler.ts`），
 *   本 kind 是**节点级**「已重派」痕迹（`NOT failure_report`，宿主已定案）；
 * - `state` 列写重派后的**实际**节点态（`working`）——与 `task.settled` / `task.blocked` 同一列语义
 *   （「实际流转/落库后的态」）；
 * - 兼作**失败静止去重 signature 的重新武装**标记：重派改变 failed/blocked 集合 ⇒ 下一次静止
 *   自然发新账单；本事件让「为何重新武装」在 `a2a_events` 面可观测；
 * - `events` 表**零 schema 变更**（kind 是既有自由文本列）；事件接口面不变（仍 `a2a_events(since)`）。
 */
export const EVENT_TASK_REARMED = "task.rearmed";

/** Feature 工具失败外壳（桥转为 `errorResult`） */
export interface FeatureToolFailure {
  ok: false;
  code: string;
  error: string;
}

/** tasks 摘要（status 出参） */
export interface FeatureTaskSummary {
  taskId: string;
  projectId: string;
  state: TaskRecord["state"];
  /**
   * **并发档**（v0.8.10 O-N3 additive；来源 `tasks.lane`，见 {@link TaskLane}）：
   * `write` = 参与同 project 串行门（缺省档），`read` = 只读档（**退出写忙集** ⇒ 不挡写、不被写挡）。
   *
   * 读账口径：`read` 且**迟迟不开工**时，**先看 trace 的 `readOccupants`**（machine 侧同 project
   * 读并发闸 `maxConcurrentReads` 缺省 1）而非 `projectBusy` —— 后者按设计只反映**写门**。
   * 存量行 / 未带档登记 = `write`（NULL 已在读侧归一，**不存在第三个值**）。
   */
  lane: TaskLane;
  prompt: string | null;
  remoteTaskId: string | null;
  dependencies: string[] | null;
  /** 下游声明的上游产物引用（v0.4.0；NULL = 无输入产物） */
  inputArtifacts: InputArtifactRef[] | null;
  updatedAt: string;
  /**
   * 失败分类（v0.4.1 §4.1.13 可观测；`null` = 未失败 / 未分类）。
   * **只增字段**，既有字段语义不变。
   *
   * ✅ v0.8.7 起本字段已有**真实值**（不再是 v0.6.1「删五层」后的语义休眠恒 `null`）：
   * 写口 = `setTaskFailureKind`（仅当行当前为 `failed` 才写入）与 `failOrphanedTask`（孤儿补结算落
   * `runner`）；v0.8.8 起任务失败在账面携带六类闭集 `failureKind`（事实源 = `PROTOCOL.md`），
   * 可据此判断失败类型（网页工作台已渲染该列，O6）。
   */
  failureKind: FailureKind | null;
  /**
   * 重派记账次数（v0.4.1 的「条件重试已用次数」；**v0.6.1 REQ-05 起门禁语义删除、降级为记账**）。
   *
   * ⚠️ 条件重试 / re-arm 调用点已删除；本列唯一写口 = `rearmForRetry`（保留给「重派」复用）——
   * `a2a_feature_advance(retryTaskIds)` 每成功重派一次 **+1** ⇒ 本字段**不再恒 `0`**。
   * **不得**据此判断「重试是否用尽（N=1 门槛已随条件重试删除）」或「是否已重试过」。
   */
  retryCount: number;
  /** ② 体积 / 触达 / machine 事实只读投影（v0.8.9 O3；见 {@link projectTaskVisibility}） */
  baseChars: number;
  renderedChars: number;
  wrappedChars: number;
  attempts: number;
  diagnostics: TaskDiagnosticsView;
}

/**
 * ② 可见面里**从 machine 透传**的那一半（改造文档 §2.3 键表；**逐键原样、不合并、不改写**）。
 *
 * **缺键 = machine 没报**，与本视图「报了 0」**严格可区分**（⇒ 本接口全部字段可选，
 * 未命中类型的键**省略**，不得补 `0` / `false` —— 补值就是把「未知」谎报成「没有」，
 * 同 `store.ts` 的 `continuedEventPayload` 口径）。
 *
 * `turn` 是**轮次唯一主口径**且**只从 diagnostics 取**：orch **不得**用「同 `contextId`
 * 任务条数」反推（首轮超时未置 `prompted` ⇒ 计数会 +1，§1 表第 6 条已实测否证）。
 */
export interface TaskDiagnosticsView {
  /** 该 `contextId` 的第几轮（桥内单调；**透传**，orch 不计算） */
  turn?: number;
  /** 会话映射命中（与 `sessionResumed` **不等价**） */
  sessionReused?: boolean;
  /** `load|resume` 真成功 */
  sessionResumed?: boolean;
  /** 本轮实际写出 `session/prompt` 的字符数 */
  promptChars?: number;
  /** 其中注入部分（首轮 > 0、次轮应恒 0 —— ①-b 的机器可判定证据） */
  injectedChars?: number;
  /** 本轮累积字符（成功轮也报） */
  resultChars?: number;
  /** 失败轮的已捕获字符量。与 `resultChars` **各自原样保留**：择一只发生在呈现层 */
  partialChars?: number;
  /** 本轮结构有效 outcome 块数 */
  blockCount?: number;
  /** 末块位置 */
  lastBlockIndex?: number;
  /** 被过滤掉的历史重放 chunk 条数 */
  replayDropped?: number;
  /** outcome 不确定标志（machine 侧 false 时不报该键） */
  outcomeAmbiguous?: boolean;
  /** 不确定原因（闭集：`multi-block` / `replay-leak` / `cross-turn-message-id`，续跑轮带 `continue-` 前缀） */
  ambiguousReason?: string;
  /** **machine 自报**的续跑轮数 —— `attempts` 的加数之一，随投影带出使 `attempts` 可核算 */
  continueAttempts?: number;
  /** 桥内会话映射规模（该桥首个任务时搭车带出，v0.8.9 · ④ 可见面） */
  sessionMapSize?: number;
  /** 会话映射最老条目年龄（天）；**空映射时 machine 不报该键** ⇒ 缺键 ≠ 0 */
  sessionMapOldestAgeDays?: number;
  /**
   * **停轮归因：谁杀的**（v0.8.10 · M-N4 五键之一，闭集 `idle-reap` / `continue` / `resend` /
   * `stop-command`）；machine 未报 ⇒ 本键省略。
   */
  stopCause?: string;
  /** **肇事任务 id**（触发 stop 的归属者，**不是被停者清单**，口径 U8） */
  stopCauseTaskId?: string;
  /** 派发收尾的**幽灵轮取消**（B16′）是否生效的账面证据；machine 判不出时不报 ⇒ 缺键 ≠ false */
  ghostRoundCancelled?: boolean;
  /** 取消 → 静默的耗时（ms，真机判据 R1）；**未走取消路径时 machine 不报** ⇒ 缺键 ≠ 0 */
  cancelQuiesceMs?: number;
  /** 后端不认 `session/cancel`（与 machine `/health` 同键名）；缺键 = machine 没报，**不等于「支持」** */
  cancelUnsupported?: boolean;
}

/** {@link projectTaskVisibility} 的输入：只读投影所需的四个列（其余字段不消费） */
export type TaskVisibilitySource = Pick<
  TaskRecord,
  "dispatchMessage" | "dispatchRendered" | "retryCount" | "diagnosticsJson"
>;

/**
 * ② 的 **orch 侧只读投影**（改造文档 §2.3「orch 侧（投影，只增出参字段、零写口）」）。
 *
 * 两个出口共用本函数（`summarizeTask` = `a2a_feature_status` 的 tasks 行 /
 * `handleTaskStatus` = `a2a_task_status`），**投影口径只有一处实现**。
 *
 * - `baseChars` = `dispatch_message`（未渲染 base）字符数；**NULL ⇒ 0**（独立单任务无 base 可测）；
 * - `renderedChars` = `dispatch_rendered`（本轮实际下发快照）字符数；
 *   **NULL ⇒ 回退显示 `baseChars`**（领取侧 `?? dispatch_message` 兜底 ⇒ 下发的就是 base）；
 * - `wrappedChars` = `renderedChars − baseChars` = 本次派发加出去的外壳体积
 *   （**①-a「去重可证」指标**：修复后应恒等于一层壳、**不随派发次数增长**）；
 * - `attempts` = `retry_count`（宿主重派）+ `diagnostics.continueAttempts`（machine 续跑）
 *   = 本节点被**触达**的总次数。**刻意不叫 `turn`**：`turn` 是 machine 的 ACP 轮次事实，
 *   二者口径不同、并存异名（§1 表第 6 条 / §3.3 防撞名）。
 *
 * 计长口径 = `String#length`（UTF-16 code unit），与 machine 侧 `promptChars` 等体积键一致。
 */
export function projectTaskVisibility(rec: TaskVisibilitySource): {
  baseChars: number;
  renderedChars: number;
  wrappedChars: number;
  attempts: number;
  diagnostics: TaskDiagnosticsView;
} {
  const baseChars = rec.dispatchMessage?.length ?? 0;
  const renderedChars = rec.dispatchRendered?.length ?? baseChars;
  const diagnostics = projectDiagnostics(rec.diagnosticsJson ?? null);
  return {
    baseChars,
    renderedChars,
    wrappedChars: renderedChars - baseChars,
    attempts: (rec.retryCount ?? 0) + (diagnostics.continueAttempts ?? 0),
    diagnostics,
  };
}

/**
 * `diagnostics` 透传白名单（**machine 侧键表的镜像**，两侧必须同步）。
 *
 * ★ v0.8.10 O-N3（REQ-v0.8.10-2026-09-23-01 §2.4 / A9）：machine 新增的**归因五键**
 * （`stopCause` / `stopCauseTaskId` / `ghostRoundCancelled` / `cancelQuiesceMs` / `cancelUnsupported`）
 * **必须在此列出** —— 本视图是**显式白名单**，未列入的键**从 MCP 出参里消失**而 **DB 原文仍在**，
 * 是「库里查得到、宿主看不到」最难查的一类落差（v0.8.9 踩过同一个坑）。
 * 新增键的同时**必须同步** {@link TaskDiagnosticsView} 的字段声明（否则 TS 侧读不到）。
 */
const DIAG_NUMBER_KEYS = [
  "turn",
  "promptChars",
  "injectedChars",
  "resultChars",
  "partialChars",
  "blockCount",
  "lastBlockIndex",
  "replayDropped",
  "continueAttempts",
  "sessionMapSize",
  "sessionMapOldestAgeDays",
  "cancelQuiesceMs",
] as const;

const DIAG_STRING_KEYS = ["ambiguousReason", "stopCause", "stopCauseTaskId"] as const;
const DIAG_BOOLEAN_KEYS = [
  "sessionReused",
  "sessionResumed",
  "outcomeAmbiguous",
  "ghostRoundCancelled",
  "cancelUnsupported",
] as const;

/** `diagnostics_json` 原文 → ② 透传视图（NULL / 非法 JSON / 非对象 ⇒ 空视图，不报错） */
function projectDiagnostics(diagnosticsJson: string | null): TaskDiagnosticsView {
  const view: TaskDiagnosticsView = {};
  const obj = parseDiagnosticsObject(diagnosticsJson);
  if (obj === null) return view;
  // 宽容读取：类型不符（脏值）等同「没报」⇒ 省略该键（同 `store.ts` 的 `diag*` 三件套）
  for (const key of DIAG_NUMBER_KEYS) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) view[key] = v;
  }
  for (const key of DIAG_STRING_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) view[key] = v;
  }
  for (const key of DIAG_BOOLEAN_KEYS) {
    const v = obj[key];
    if (typeof v === "boolean") view[key] = v;
  }
  return view;
}

/** 落库宽 JSON 的读侧解析（只读；非法形状 ⇒ `null`） */
function parseDiagnosticsObject(diagnosticsJson: string | null): Record<string, unknown> | null {
  if (diagnosticsJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(diagnosticsJson);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function summarizeTask(rec: TaskRecord): FeatureTaskSummary {
  return {
    taskId: rec.taskId,
    projectId: rec.projectId,
    state: rec.state,
    // 并发档恒有值（读侧 NULL 已归一 write）：**不得省略字段**
    lane: rec.lane,
    prompt: rec.prompt,
    remoteTaskId: rec.remoteTaskId,
    dependencies: rec.dependencies,
    inputArtifacts: rec.inputArtifacts,
    updatedAt: rec.updatedAt,
    // 缺失 / 未设时给 `null` / `0`：**不得省略字段、不得 `undefined`**（老记录 / 部分对象也要有确定值）
    failureKind: rec.failureKind ?? null,
    retryCount: rec.retryCount ?? 0,
    // ② 只读投影（v0.8.9 O3）：派生 4 键恒有值，`diagnostics` 内 machine 键**没报即省略**
    ...projectTaskVisibility(rec),
  };
}

// ---------------------------------------------------------------------------
// 归属校验（v0.8.6 §2.3 / REQ-v0.8.6-2026-09-21-01 · N4）
// ---------------------------------------------------------------------------

/**
 * Feature **六出口归属校验**（§2.3 / §1.3 R-3 / G2）：`identity` = 本次连接身份（组名）。
 *
 * - `identity === null`（无身份）⇒ **全量放行**，不校验归属 —— 未配组环境的匿名入口与
 *   web 运维视图（§2.7「3300 非身份面」）皆走此路，零破坏；
 * - `identity` 非空 ⇒ **Feature 谁建谁见**（§6.1-5）：
 *   - `owner_group === identity` ⇒ 放行；
 *   - `owner_group === null` ⇒ 拒绝，文案 A（**无归属 / 非本组可见对象**，配组环境
 *     fail-closed，不猜默认组，§1.3 R-3 / G2）；
 *   - `owner_group === 其它组名` ⇒ 拒绝，文案 B（**属另一项目组**，跨组操作归 v0.11.0）。
 *
 * 两类拒绝**错误码与文案不同**（供测试分别断言，§6.1-3 的 Feature 面对偶）；**不泄漏**他组组名
 * （只说「属另一项目组」，§6.1-9）。**注**：组不是鉴权边界（§2.7），此处仅是视野隔离，非安全机制。
 *
 * **v0.8.6 req01 补正 R-1 起本函数导出**：`bridge/index.ts` 的 `registerFeatureNode` 挂载前置
 * 复用**同一判据**（禁止第二套判据）—— 他组连接不得把本组项目挂进他组 Feature DAG。
 */
export function ownershipFailure(
  feature: FeatureRecord,
  identity: string | null,
): FeatureToolFailure | null {
  if (identity === null) return null;
  if (feature.ownerGroup === identity) return null;
  if (feature.ownerGroup === null) {
    return {
      ok: false,
      code: "feature_unowned",
      error:
        `Feature ${feature.featureId} 无归属（owner_group 为空），不是本组「${identity}」的可见对象：` +
        `已配组环境下，未配组时创建或配组改造前的存量 Feature 一律不可见（fail-closed，不猜默认组）。` +
        `如需纳入本组，请用迁移脚本显式改归属（scripts/migrate-feature-owner.mjs）。`,
    };
  }
  return {
    ok: false,
    code: "feature_not_owned",
    error:
      `Feature ${feature.featureId} 属另一项目组，不是本组「${identity}」的可见对象：` +
      `Feature 谁建谁见（跨组操作本版不支持，归 v0.11.0）。`,
  };
}

// ---------------------------------------------------------------------------
// 登记字段（v0.9.0 B1″ / B2″）：闭集校验 + 写口收敛
// ---------------------------------------------------------------------------

/** 入参里可能携带登记字段的三个动作（`create` / `advance` 共用同一份校验） */
interface RegistrationInput {
  stage?: string;
  version?: string;
  approval?: string;
}

/**
 * 登记字段的**唯一闭集校验**（schema 侧只用 `z.string()`，不用 `.enum()` ⇒ 校验落这里）。
 *
 * - 只回传**已提供**的字段（undefined = 本次不写该列，交 `updateFeatureRegistration` 保留原值）；
 * - 非法值 ⇒ 结构化拒绝（`feature_invalid_stage` / `feature_invalid_approval`），**零写入**；
 * - **不校验序、不校验回退**（B5″：`stage` 序校验 / 回退限制都不做）。
 */
type RegistrationParse =
  | { ok: true; patch: FeatureRegistrationPatch }
  | { ok: false; code: string; error: string };

function parseRegistration(input: RegistrationInput): RegistrationParse {
  const patch: FeatureRegistrationPatch = {};
  if (input.stage !== undefined) {
    if (!isFeatureStage(input.stage)) {
      return {
        ok: false,
        code: "feature_invalid_stage",
        error: `非法 stage "${input.stage}"（闭集：${FEATURE_STAGES.join(" / ")}）`,
      };
    }
    patch.stage = input.stage;
  }
  if (input.approval !== undefined) {
    if (!isFeatureApproval(input.approval)) {
      return {
        ok: false,
        code: "feature_invalid_approval",
        error: `非法 approval "${input.approval}"（闭集：${FEATURE_APPROVALS.join(" / ")}）`,
      };
    }
    patch.approval = input.approval;
  }
  // `version` 是自由文本（无闭集、不校验）
  if (input.version !== undefined) patch.version = input.version;
  return { ok: true, patch };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface FeatureCreateArgs extends RegistrationInput {
  title: string;
  requirement?: string;
  /** Feature 级会话上下文（落 `features.context_id`，跨任务 / 跨 worker 启停复用） */
  contextId?: string;
  /**
   * **父需求登记**（v0.9.3 O1）：增补轨挂主需求的单值父引用（落 `features.parent_feature_id`）。
   * 存在性 + 可见性校验 fail-closed（不可见 ⇒ 与不存在同一拒绝码，不泄漏他组存在性）；
   * 父链**只存不解析**（不递归、不判环）。
   */
  parentFeatureId?: string;
}

export interface FeatureCreateSuccess {
  ok: true;
  featureId: string;
  state: FeatureState;
  title: string;
  /** 回显入参 contextId（已随 createFeature 持久化到 features.context_id） */
  contextId?: string;
  /** 回显父需求（v0.9.3 O1：仅带父创建时出现，同 contextId 回显口径） */
  parentFeatureId?: string;
  /** 登记字段回显（v0.9.0 B1″：恒有值 —— 未传即缺省，见 {@link DEFAULT_FEATURE_STAGE}） */
  stage: FeatureStage;
  version: string;
  approval: FeatureApproval;
}

export function handleFeatureCreate(
  args: FeatureCreateArgs,
  /** 连接身份（组名）；`null` / 缺省 = 无身份 ⇒ 落 `owner_group = NULL`（未配组 / 存量语义） */
  identity: string | null = null,
): FeatureCreateSuccess | FeatureToolFailure {
  const title = args.title.trim();
  if (title.length === 0) {
    return { ok: false, code: "feature_invalid_args", error: "title 不能为空" };
  }
  // 登记字段：先校验（非法 ⇒ 零写入），再施加缺省
  // ⇒ **不传三参数的既有调用行为逐字不变**（缺省恰为「改造方案 + 待审批」= 既有语义）
  const reg = parseRegistration(args);
  if (reg.ok === false) return reg;
  // 父需求校验（v0.9.3 O1，零写入前）：存在性 + 可见性走带身份过滤读口
  // （`ownershipFailure` 同源判据，禁止第二套）⇒ 不存在与他组不可见**同一拒绝码**
  // `feature_not_found`（不泄漏他组 Feature 的存在性，fail-closed）。只存不解析：不递归、不判环。
  if (args.parentFeatureId !== undefined) {
    const parent = getFeature(args.parentFeatureId);
    const visible = parent !== null && ownershipFailure(parent, identity) === null;
    if (!visible) {
      return {
        ok: false,
        code: "feature_not_found",
        error: `父 Feature ${args.parentFeatureId} 不存在或不可见（带身份过滤读口，fail-closed）`,
      };
    }
  }
  const featureId = randomUUID();
  const rec = createFeature({
    featureId,
    title,
    requirement: args.requirement ?? null,
    contextId: args.contextId ?? null,
    // 入口打标：归属 = 本次连接身份（组名）；无身份 ⇒ NULL（无归属，fail-closed 存量语义）
    ownerGroup: identity,
    // v0.9.3 O1：父需求一次性登记（重跑不改父，同 owner_group 语义）
    parentFeatureId: args.parentFeatureId ?? null,
    // 主链起点 = 审批门停靠点（REQ-v0.4.1-2026-09-16-01 §2.3）：引擎只做需求实现，
    // 前段讨论 / 方案（Step 0/1）不走引擎；`waiting_approval → executing` 只能经 `a2a_feature_approve`
    state: "waiting_approval",
    // v0.9.0 登记字段：`version` 未传 ⇒ NULL（读回归一为空串，不落 "null" 字面量）
    stage: reg.patch.stage ?? DEFAULT_FEATURE_STAGE,
    version: args.version ?? null,
    approval: reg.patch.approval ?? DEFAULT_FEATURE_APPROVAL,
  });
  const success: FeatureCreateSuccess = {
    ok: true,
    featureId: rec.featureId,
    state: rec.state,
    title: rec.title,
    // 回显**落库后读回**的值（读侧已归一 ⇒ 恒非空，与后续 `status` 出参同源）
    stage: rec.stage,
    version: rec.version,
    approval: rec.approval,
  };
  if (rec.contextId !== null) success.contextId = rec.contextId;
  // v0.9.3 O1：回显**落库后读回**的父需求（仅带父创建时出现，同 contextId 口径）
  if (rec.parentFeatureId !== null) success.parentFeatureId = rec.parentFeatureId;
  return success;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface FeatureStatusArgs {
  featureId?: string;
}

/**
 * **主链状态段轨迹**的一格（REQ-v0.9.1-2026-09-25-02 · B1）。
 *
 * ⚠ **stage 一词两义**：本结构的 `state` 承载的是**主链段轨迹**（`feature.state` 事件回放），
 * 与 Feature **登记字段** `stage`（需求分析/改造方案/…/发版，观测面）及事件 kind
 * `feature.stage`（登记流水）**同词不同物** —— 三者互不相干，读账时不得混用。
 */
export interface FeatureAcceptanceStage {
  /** 主链状态机态（FeatureState），不是登记字段 `stage` */
  state: FeatureState;
  enteredAt: string;
  /** 下一段的进入时刻；**末段 = null**（Feature 现停在此态） */
  leftAt: string | null;
}

/**
 * 一条 `feature.failure_report` 账单的**原样**投影（零去重；见 {@link FeatureAcceptance.failures}）。
 */
export interface FeatureAcceptanceFailure {
  eventId: number;
  /** = 事件 `created_at` */
  at: string;
  /** 事件 payload 原文（JSON 字符串：`failed[]` / `blockedSet`；可空） */
  payload: string | null;
}

/**
 * **acceptance 聚合块**（v0.9.1 起，仅 `a2a_feature_status` **单 Feature 分支**出参，additive）。
 *
 * - `stages`：主链段轨迹，回放本 Feature 的 `feature.state` 事件（新态在 `events.state` 列、
 *   时间在 `created_at`、`payload=NULL`）。**首段合成**：`createFeature` 不写事件 ⇒
 *   `waiting_approval` 的 `enteredAt` 从 `feature.createdAt` 合成；**不按 state 聚合去重** ⇒
 *   `executing → needs_input → executing` 得 ≥2 段同名 `executing`（轨迹本义；相邻同态由
 *   store 的「只在真变化时写事件」守卫保证不可能）。
 * - `failures`：`feature.failure_report` 按 `eventId` 升序**原样列出、零去重**（payload 无
 *   retryCount、调度器签名 Map 为进程内态重启失忆 ⇒ 按 payload 去重不可行，也不该做）。
 * - `stateCounts`：与**列表分支**同一事实源（`featureTaskStateCounts` 聚合 SQL，归属谓词同侧），
 *   不做 tasks 就地计数。
 */
export interface FeatureAcceptance {
  stages: FeatureAcceptanceStage[];
  failures: FeatureAcceptanceFailure[];
  stateCounts: Partial<Record<TaskState, number>>;
}

export interface FeatureStatusSuccess {
  ok: true;
  feature?: FeatureRecord;
  tasks?: FeatureTaskSummary[];
  /** 该 Feature 已登记的产物（v0.4.0；仅单 Feature 查询返回） */
  artifacts?: ArtifactRecord[];
  /**
   * **acceptance 聚合块**（v0.9.1 / REQ-02 B1；**仅单 Feature 查询返回**，列表分支出参不变）。
   * 语义与「stage 一词两义」警示见 {@link FeatureAcceptance}。
   */
  acceptance?: FeatureAcceptance;
  /**
   * 列表分支出参（v0.9.0 B3″ 起 **additive** 增 `stateCounts`）。
   *
   * - `stateCounts`：各**任务态**的节点数（事实源 = 一条 `GROUP BY feature_id, state` 聚合 SQL）；
   * - `taskCount`：**由 `stateCounts` 派生**（各态求和）—— 与改前「`listFeatureTasks` 数长度」**逐 Feature 同值**；
   * - 两者都**只走列表读的视野判据**（归属谓词与 `listFeatures` 同源），他组节点不计数。
   */
  features?: Array<FeatureRecord & { taskCount: number; stateCounts: Partial<Record<TaskState, number>> }>;
}

/** `listEvents` 的 limit clamp 上限 = 游标续读的单页大小（短页即读到末尾） */
const ACCEPTANCE_EVENT_PAGE = 1000;

/**
 * **游标续读**本 Feature 的全部事件（`listEvents` 单次调用被 clamp 在 1000 且无 kind 过滤 ⇒
 * 必须 `since` 循环读到短页为止，禁单次调用当作全量）。事件天然按 `eventId` 升序。
 */
function readAllFeatureEvents(featureId: string): EventRecord[] {
  const all: EventRecord[] = [];
  let since = 0;
  for (;;) {
    const page = listEvents({ featureId, since, limit: ACCEPTANCE_EVENT_PAGE });
    all.push(...page);
    const last = page[page.length - 1];
    if (page.length < ACCEPTANCE_EVENT_PAGE || last === undefined) return all;
    since = last.eventId;
  }
}

/**
 * 构造 acceptance 聚合块（只读；不触任何写口 / 门）。
 *
 * `stateCounts` 归属不放宽：`identity` 透传口径与列表分支一致（无身份 ⇒ 全量视野）。
 */
function buildFeatureAcceptance(feature: FeatureRecord, identity: string | null): FeatureAcceptance {
  const events = readAllFeatureEvents(feature.featureId);
  const stateEvents = events.filter(
    (e) => e.kind === EVENT_FEATURE_STATE && typeof e.state === "string",
  );
  const stages: FeatureAcceptanceStage[] = [];
  // 首段合成：createFeature 不写 `feature.state` 事件，初态恒 waiting_approval
  let state: FeatureState = "waiting_approval";
  let enteredAt = feature.createdAt;
  for (const e of stateEvents) {
    stages.push({ state, enteredAt, leftAt: e.createdAt });
    state = e.state as FeatureState;
    enteredAt = e.createdAt;
  }
  stages.push({ state, enteredAt, leftAt: null });
  const failures: FeatureAcceptanceFailure[] = events
    .filter((e) => e.kind === EVENT_FAILURE_REPORT)
    .map((e) => ({ eventId: e.eventId, at: e.createdAt, payload: e.payload }));
  const counts = featureTaskStateCounts(identity === null ? undefined : identity);
  return { stages, failures, stateCounts: counts.get(feature.featureId) ?? {} };
}

export function handleFeatureStatus(
  args: FeatureStatusArgs,
  identity: string | null = null,
): FeatureStatusSuccess | FeatureToolFailure {
  if (args.featureId !== undefined && args.featureId.length > 0) {
    const feature = getFeature(args.featureId);
    if (feature === null) {
      return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
    }
    // 归属校验（谁建谁见）：非本组 ⇒ 拒绝（他组 Feature 不返回详情）
    const denied = ownershipFailure(feature, identity);
    if (denied !== null) return denied;
    const tasks = listFeatureTasks(feature.featureId, { limit: 1000 }).map(summarizeTask);
    const artifacts = listArtifactsByFeature(feature.featureId, 1000);
    return { ok: true, feature, tasks, artifacts, acceptance: buildFeatureAcceptance(feature, identity) };
  }
  // 列表路径：配组 ⇒ 只列本组 Feature（`owner_group = identity`，NULL 无归属被排除 = fail-closed）；
  // 无身份 ⇒ 全量（未配组 / web 运维视图）。
  const features = listFeatures({
    limit: 1000,
    ownerGroup: identity === null ? undefined : identity,
  });
  // v0.9.0 B3″：节点计数改**一条聚合 SQL**（`GROUP BY feature_id, state`，归属谓词与上面
  // `listFeatures` 同源）⇒ 列表读由「1 + N」降为 **O(1)**。`taskCount` 由 `stateCounts` 求和派生，
  // 与改前逐 Feature 的 `listFeatureTasks(...).length` 同值（对照断言见 `test/v090-o2-read-plane.test.ts`）。
  const counts = featureTaskStateCounts(identity === null ? undefined : identity);
  return {
    ok: true,
    features: features.map((f) => {
      const stateCounts = counts.get(f.featureId) ?? {};
      const taskCount = Object.values(stateCounts).reduce((sum, n) => sum + (n ?? 0), 0);
      return { ...f, taskCount, stateCounts };
    }),
  };
}

// ---------------------------------------------------------------------------
// advance
// ---------------------------------------------------------------------------

/**
 * `advance` 入参（v0.9.0 起 `extends RegistrationInput`）。
 *
 * **登记字段写入**（`stage` / `version` / `approval`，见 {@link parseRegistration}）：
 *
 * - **additive**：三者全省略 = 既有行为逐字不变；
 * - `to` **等于当前态** ∧ 带任一登记字段 ⇒ 走**显式特例**（同 `retryTaskIds` 先例：跳过
 *   `canTransition`，转移表**零改动**、不出现自环），**只写登记、不动主链**；
 * - 特例**不加终态守卫**（否则 `completed` 后永远写不进 `发版`）；
 * - 非法值 ⇒ `feature_invalid_stage` / `feature_invalid_approval`（**在任何写入之前**拒绝）。
 */
export interface FeatureAdvanceArgs extends RegistrationInput {
  featureId: string;
  to: string;
  /** 统一方案 / 备注：落 Feature Context 的 `plan`（供审批与派发注入） */
  note?: string;
  /** 决策记录（JSON 字符串；落 Feature Context 的 `decisions`） */
  decisions?: string;
  /** 契约（JSON 字符串；落 Feature Context 的 `contracts`） */
  contracts?: string;
  /** needs_input 补齐：以同 contextId 续接待澄清任务 */
  answer?: string;
  /**
   * **重派与解冻**（REQ-v0.6.1-2026-09-17-05 §2.3）：给一组**本 Feature 内当前 `failed`** 的节点 id。
   *
   * - **additive**：省略 = 既有行为（状态机正常流转路径）完全不变；
   * - 非空 ⇒ 走**显式特例**（跳过 `canTransition`，`TRANSITIONS` **不加自环**），`to` 必须显式
   *   `"executing"`；与 `answer` **互斥**；
   * - 空数组 / 任一 id 非法（未知 / 非 `failed` / 重复）⇒ `feature_nothing_to_resume`（**整单拒绝**，
   *   不做部分重派，Feature 态不变）。
   */
  retryTaskIds?: string[];
}

export interface FeatureStateChangeSuccess {
  ok: true;
  featureId: string;
  from: FeatureState;
  state: FeatureState;
  note?: string;
}

/**
 * `advance` 成功出参（**additive**）。
 *
 * `retryTaskIds` 路径额外回显本次动作面（便于宿主 / 测试核对**实际生效**的节点集）；
 * 非该路径不设这两个字段（出参形状与既有调用方兼容）。
 */
export interface FeatureAdvanceSuccess extends FeatureStateChangeSuccess {
  /** 本次**实际重派**（`rearmForRetry` CAS 命中）的节点 id */
  rearmed?: string[];
  /** 本次**实际解冻**（`blocked` → `working`）的节点 id */
  unfrozen?: string[];
}

export function handleFeatureAdvance(
  args: FeatureAdvanceArgs,
  identity: string | null = null,
): FeatureAdvanceSuccess | FeatureToolFailure {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
  // 归属校验（谁建谁见）：非本组 ⇒ 在任何写入之前拒绝（Feature 态与节点态零变更）
  const denied = ownershipFailure(feature, identity);
  if (denied !== null) return denied;

  // 登记字段：**先解析校验**（非法 ⇒ 任何写入之前拒绝，Feature 态与登记值零变更）
  const reg = parseRegistration(args);
  if (reg.ok === false) return reg;
  const hasRegistration =
    reg.patch.stage !== undefined ||
    reg.patch.approval !== undefined ||
    reg.patch.version !== undefined;

  // ---- 重派与解冻（§2.3 / N4）：**显式特例**，不得给 `TRANSITIONS` 加自环 ----------------------
  // `retryTaskIds` 是**派发语义操作**（重派指定失败节点 + 解冻其闭包外下游），不是状态流转
  // ⇒ 跳过 `canTransition`（转移表保持单一事实源、不出现 `executing → executing` 自环）；
  // `to` 必须**显式** `"executing"`，以防借本参数做状态流转。
  if (args.retryTaskIds !== undefined) {
    return handleRetryResume(feature, { ...args, retryTaskIds: args.retryTaskIds }, reg.patch);
  }

  // ---- 登记字段特例（v0.9.0 B1″）：`to` = 当前态 ∧ 带登记字段 ⇒ **只写登记、不做流转** ------------
  // 与 `retryTaskIds` 同族：跳过 `canTransition`（转移表零改动、`executing → executing` 仍无路径）。
  // ⚠️ **刻意不加终态守卫** —— 发版流程要在 `completed` 之后写 `stage = 发版`（`需求流程.md` §7）；
  // 加了守卫就永远写不进去。主链态在此路径**逐字不变**（`from === state`）。
  // F2（v0.9.0 O4 门禁报告）：早退**不得**丢弃同单 Feature Context —— 与合法流转同一出口落库。
  if (hasRegistration && args.to === feature.state) {
    applyFeatureContext(feature.featureId, args);
    updateFeatureRegistration(feature.featureId, reg.patch);
    const success: FeatureStateChangeSuccess = {
      ok: true,
      featureId: feature.featureId,
      from: feature.state,
      state: feature.state,
    };
    if (args.note !== undefined) success.note = args.note;
    return success;
  }

  if (!isFeatureState(args.to)) {
    return {
      ok: false,
      code: "feature_invalid_state",
      error: `非法目标状态 ${args.to}（合法后继：${allowedTransitions(feature.state).join(" / ") || "无（终态）"}）`,
    };
  }
  if (!canTransition(feature.state, args.to)) {
    return {
      ok: false,
      code: "feature_transition_invalid",
      error: `非法状态流转：${feature.state} → ${args.to}（合法后继：${allowedTransitions(feature.state).join(" / ") || "无（终态）"}）`,
    };
  }

  // 唯一准入门（REQ-v0.4.1-2026-09-16-01 §2.4）：`approve` 是进入 `executing` 的唯一通道。
  // 位置在 `canTransition` **之后** ⇒ `waiting_approval → analyzing` 之类非法目标仍报
  // `feature_transition_invalid`（错误区分），只有"合法但须审批"的这一步改为 `feature_approval_required`。
  // ⚠️ 条件严格限定这两态：**不得**误伤 `needs_input → executing`（人工澄清续推，属设计内）。
  // 注：状态机层保留 `waiting_approval → executing` 边（转移表 = 单一事实源；approve 自身不经 canTransition）。
  if (feature.state === "waiting_approval" && args.to === "executing") {
    return {
      ok: false,
      code: "feature_approval_required",
      error:
        "非法状态流转：waiting_approval → executing 须经审批门（请用 a2a_feature_approve；" +
        "该操作 = 记录用户已给的方案确认，一对一映射，不可预领 / 不可补领）",
    };
  }

  // needs_input → executing：以同 contextId 续接待澄清任务（补齐 answer 后续推）
  if (feature.state === "needs_input" && args.to === "executing") {
    const pending = listFeatureTasks(feature.featureId, { limit: 1000 }).find(
      (n) => n.state === "input-required",
    );
    if (pending !== undefined) {
      const base = pending.dispatchMessage ?? pending.prompt ?? "";
      const answer = args.answer === undefined || args.answer.length === 0 ? "" : args.answer;
      rearmTask(
        pending.taskId,
        answer.length > 0 ? `${base}\n\n[用户澄清]\n${answer}` : base,
      );
    }
  }

  // Feature Context 落库（v0.4.0 §2.5）：note → plan；decisions / contracts 可选
  applyFeatureContext(feature.featureId, args);

  // 登记字段与**合法流转同单**写入（v0.9.0）：先落登记，再迁主链 ⇒ 出参回显的 `state` 是迁移后的态
  if (hasRegistration) updateFeatureRegistration(feature.featureId, reg.patch);

  const updated = updateFeatureState(feature.featureId, args.to);
  const state = updated === null ? args.to : updated.state;
  const success: FeatureStateChangeSuccess = {
    ok: true,
    featureId: feature.featureId,
    from: feature.state,
    state,
  };
  if (args.note !== undefined) success.note = args.note;
  return success;
}

/**
 * Feature Context 落库的唯一出口（v0.4.0 §2.5）：`note` → `plan`；`decisions` / `contracts` 可选。
 *
 * 三条 `advance` 路径共用（合法流转 / `retryTaskIds` 重派 / 登记字段特例）——
 * **同一单不得出现「一条路径丢 Context」的口径差**（v0.9.0 O4 门禁报告 F2）。
 */
function applyFeatureContext(
  featureId: string,
  args: Pick<FeatureAdvanceArgs, "note" | "decisions" | "contracts">,
): void {
  const patch: FeatureContextPatch = {};
  if (args.note !== undefined) patch.plan = args.note;
  if (args.decisions !== undefined) patch.decisions = args.decisions;
  if (args.contracts !== undefined) patch.contracts = args.contracts;
  if (Object.keys(patch).length > 0) updateFeatureContext(featureId, patch);
}

/**
 * `retryTaskIds` 路径实体（§2.3 / N4）：**校验 → 重派 → 解冻**，在 `handleFeatureAdvance` 内联可达。
 *
 * 顺序纪律（**先校验后改库**）：任何拒绝都在**任何写入之前**返回 ⇒ Feature 态与节点态**零变更**（不抖振）。
 * 通过后才：① `rearmForRetry` 逐 id 重派 + 逐条 `task.rearmed`；② 解冻闭包**外**的 `blocked` 节点。
 *
 * 边界说明：
 * - **不做**状态流转（不调 `updateFeatureState`）；`from` / `state` 为**相等值回显**（皆当前态，
 *   正常静止期即 `executing`）—— §2.3 的「均为 `executing`」在本路径的正常用法下成立；
 * - **不新增自环**：`to` 只被**校验**、不被应用（转移表零改动）；非终态的其它态如实回显；
 * - 「清 `not_before`」条目**已删除**：N2 已删写口 `setTaskNotBefore` 与判据 `isPastNotBefore`
 *   （挡门不存在 ⇒ **无对象可清**；休眠列不读不写）；
 * - **「新增业务节点」不走本路径**：就绪节点用 `a2a_call(mode="execute", featureId=…)` 登记
 *   （现成通道）；本参数只重派**既有** `failed` 节点，不实现「重试新事件」。
 */
function handleRetryResume(
  feature: FeatureRecord,
  args: FeatureAdvanceArgs & { retryTaskIds: string[] },
  /** 已校验的登记字段（v0.9.0）；**在所有重派校验通过之后**才落笔，避免半生效 */
  registration: FeatureRegistrationPatch,
): FeatureAdvanceSuccess | FeatureToolFailure {
  // 互斥：`answer` 仅承载 needs_input 澄清（走 needs_input→executing 常规路径），不得与重派同传
  if (args.answer !== undefined) {
    return {
      ok: false,
      code: "feature_conflicting_args",
      error:
        "retryTaskIds 与 answer 互斥：answer 只承载 needs_input 澄清（请用 to=executing + answer、" +
        "不带 retryTaskIds）；重派失败节点请勿携带 answer",
    };
  }
  if (args.to !== "executing") {
    return {
      ok: false,
      code: "feature_invalid_args",
      error: `retryTaskIds 路径要求 to 显式为 "executing"（当前 "${args.to}"）：本参数只做「重派 + 解冻」，不做状态流转`,
    };
  }
  if (isTerminalFeatureState(feature.state)) {
    // 终态 Feature 的节点即使重排也不会被调度（tick 只扫 executing）⇒ 显式拒绝，不留半生效状态
    return {
      ok: false,
      code: "feature_terminal",
      error: `Feature 已终态（${feature.state}），重派无意义（节点不会被调度）`,
    };
  }
  if (args.retryTaskIds.length === 0) {
    return {
      ok: false,
      code: "feature_nothing_to_resume",
      error: "retryTaskIds 为空数组：无可重派对象（至少给一个本 Feature 内 failed 节点 id）",
    };
  }

  // 先校验：任一 id 非法 ⇒ 整单拒绝（**不静默跳过、不做部分重派**）
  const nodes = listFeatureTasks(feature.featureId, { limit: 1000 });
  const plan = planResume(nodes, args.retryTaskIds);
  if (plan.invalid.length > 0) {
    return {
      ok: false,
      code: "feature_nothing_to_resume",
      error: `无可重派对象（逐 id）：${plan.invalid.map((i) => `${i.taskId} → ${i.reason}`).join("；")}`,
    };
  }

  // ① 重派原语：复用 `rearmForRetry`（CAS `WHERE state='failed'`；清 remote_task_id / finished_at、
  //    `retry_count` +1 记账、`exhausted` 归零）；消息 = `dispatch_message` 原文（**同 ctx 续接**）。
  const byId = new Map(nodes.map((n) => [n.taskId, n]));
  const rearmed: string[] = [];
  for (const id of plan.rearmIds) {
    const node = byId.get(id);
    if (node === undefined) continue;
    if (!rearmForRetry(id, node.dispatchMessage ?? node.prompt ?? "")) continue; // CAS 未命中 ⇒ 本 id 未重派
    rearmed.push(id);
    appendEvent({
      featureId: feature.featureId,
      taskId: id,
      kind: EVENT_TASK_REARMED,
      state: "working",
      payload: JSON.stringify({ projectId: node.projectId, contextId: node.contextId }),
    });
  }

  // ② 解冻：闭包**外**的 `blocked` → `working`。`updateTaskState` **只改 state**：
  //    不清 `remote_task_id`（已派发被冻节点的防双派防线）、不动 `finished_at`；
  //    `working` 不写事件（store 既有纪律：仅非 `working` 的新态才落 `task.settled` / `task.blocked`）。
  const unfrozen: string[] = [];
  for (const id of plan.unfreezeIds) {
    const rec = updateTaskState(id, "working");
    if (rec !== null && rec.state === "working") unfrozen.push(id);
  }

  // Feature Context 同常规路径（note → plan；decisions / contracts 可选）；**Feature 态不动**
  applyFeatureContext(feature.featureId, args);

  // 登记字段（v0.9.0）：与 Context 同族，**在全部重派校验通过之后**才写 ⇒ 拒绝路径零变更；
  // **Feature 态仍不动**
  if (
    registration.stage !== undefined ||
    registration.approval !== undefined ||
    registration.version !== undefined
  ) {
    updateFeatureRegistration(feature.featureId, registration);
  }

  return {
    ok: true,
    featureId: feature.featureId,
    // 相等值回显：本路径**无状态转移** ⇒ `from === state`（§2.3「均为 executing」的静止期用法）
    from: feature.state,
    state: feature.state,
    rearmed,
    unfrozen,
  };
}

// ---------------------------------------------------------------------------
// approve（审批门）
// ---------------------------------------------------------------------------

export interface FeatureApproveArgs {
  featureId: string;
}

export function handleFeatureApprove(
  args: FeatureApproveArgs,
  identity: string | null = null,
): FeatureStateChangeSuccess | FeatureToolFailure {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
  // 归属校验（谁建谁见）：非本组 ⇒ 拒绝（过审批门是操作，只能由归属组驱动）
  const denied = ownershipFailure(feature, identity);
  if (denied !== null) return denied;
  if (feature.state !== "waiting_approval") {
    return {
      ok: false,
      code: "feature_state_invalid",
      error: `审批门仅适用于 waiting_approval（当前 ${feature.state}）`,
    };
  }
  // **门看 `approval`，不看 `stage`**（v0.9.0 B2″ / 引擎映射 §3）：两维正交，`stage` 只登记段、
  // 不代表已确认。不满足 ⇒ 结构化拒绝，**不放行、不改状态、不落 `approval = 已通过`**。
  // 既有调用方零红：`create` 缺省即 `待审批`（见 {@link DEFAULT_FEATURE_APPROVAL}）。
  if (feature.approval !== "待审批") {
    return {
      ok: false,
      code: "feature_approval_not_ready",
      error:
        `审批门未发起或已不可过审（approval = ${feature.approval}，仅「待审批」可放行）：` +
        `approve = 记录用户已给的方案确认，前置是改造文档已落文件且 approval 已置「待审批」` +
        `（经 a2a_feature_advance 写登记字段）。`,
    };
  }
  const updated = updateFeatureState(feature.featureId, "executing");
  // 过审即把门状态落定（**单向、无回边**）：同一张单不得被重复过审解释
  updateFeatureRegistration(feature.featureId, { approval: "已通过" });
  return {
    ok: true,
    featureId: feature.featureId,
    from: feature.state,
    state: updated === null ? "executing" : updated.state,
  };
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

export interface FeatureCancelArgs {
  featureId: string;
}

export function handleFeatureCancel(
  args: FeatureCancelArgs,
  identity: string | null = null,
): FeatureStateChangeSuccess | FeatureToolFailure {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
  // 归属校验（谁建谁见）：非本组 ⇒ 拒绝（取消只能由归属组驱动）
  const denied = ownershipFailure(feature, identity);
  if (denied !== null) return denied;
  // v0.9.5（REQ-2026-09-28-10 O1）：`failed` 放行 —— cancel 是 failed 的唯一收口归档口
  // （迁 `cancelled`，仅改 Feature 态、不动节点账面）。`completed` / `cancelled` 照旧拒绝；
  // 转移表 `failed: []` 不改（本守卫直写放行，不经 canTransition）。
  // **与 :905 retry 守卫刻意分叉**：那里仍拒全部三终态（终态节点不会被调度），不得顺手同步。
  if (feature.state === "completed" || feature.state === "cancelled") {
    return {
      ok: false,
      code: "feature_terminal",
      error: `Feature 已收口（${feature.state}），不可取消（failed 可经 cancel 归档为 cancelled）`,
    };
  }
  const updated = updateFeatureState(feature.featureId, "cancelled");
  return {
    ok: true,
    featureId: feature.featureId,
    from: feature.state,
    state: updated === null ? "cancelled" : updated.state,
  };
}

// ---------------------------------------------------------------------------
// trace（v0.8.8 §2.10(c) 只读查询；v0.8.10 O-N3 起同时是 MCP 工具 `a2a_feature_trace`）
// ---------------------------------------------------------------------------

/**
 * 「这个 Feature 为什么还没完成」的**只读投影**（REQ-v0.8.8-2026-09-22-01 §2.10(c) · O7；
 * **REQ-v0.8.10-2026-09-23-01 O-N3 扩档位可见面并挂成 MCP 只读工具**）。
 *
 * 纯计算（store 只读 + 现成判据），**不落库、不加写口、不改调度器行为**；
 * 出参为**独立新增只读面**（不改既有工具出参形状）。两个出口复用**本实现**、不写第二套判据：
 * MCP `a2a_feature_trace`（按连接身份做归属校验）与工作台 `GET /api/features/:id/trace`（无身份）。
 *
 * 口径：
 * - 只输出**非终态节点**（`working` / `input-required`；`completed` / `failed` / `blocked` 不出）；
 * - **项目忙判定走队列态**（`state='working' ∧ queue_state IN ('queued','claimed','running') ∧ 写档`，
 *   经 `listBusyTasksForProject` = `listBusyProjectIds` 同一谓词的行级展开）——
 *   **不走 `remote_task_id`**（pull 模型下该列在飞期间恒 NULL，用了永远判「不忙」）；
 *   占用者可跨 Feature（项目串行是全局事实）。调度器**进程内** `reservedProjects` 只守
 *   「入队未落库」的同 tick 窗口（毫秒级），本查询覆盖不到，口径上按已落库事实回答；
 * - ★ **`projectBusy` 只反映写门**（v0.8.10 起谓词排除只读档）⇒ 「被长跑 read 占着 machine 读闸」
 *   这一格由 **`readOccupants[]`** 补答，`waitReason='read_lane_running'` 标记该情形
 *   （否则「写门没挡、却没开工」= **假空洞**，跨侧不变量 U9）；
 * - `blockedOn` = **直接依赖**中未达 `completed` 者（含 failed/blocked 上游）；
 * - `position` = **与实领序同键**的 FIFO 位次：`queue_state='queued' ∧ queued_at < 我的入队时刻` 计数 +1。
 *   v0.8.8 用 `created_at`（登记时刻）与 `claimTask` 的 `queued_at`（入队时刻）**两套时钟** ⇒ 位次
 *   系统性偏离实领序；O-N3 改键后**同源**（不再是"估计量"）。**未入队**（就绪待派）节点没有
 *   `queued_at` ⇒ 按「不设上界」投影 = 「此刻入队会排在所有在队者之后」。
 *   唯一残余偏差 = `claimTask` 的**写优先**第一键（跨档纯 FIFO 计数消除不了，见 `countQueuedBefore` 注记）。
 */
export function handleFeatureTrace(
  args: FeatureTraceArgs,
  identity: string | null = null,
): FeatureTraceSuccess | FeatureToolFailure {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
  // 归属校验（谁建谁见）：与其它出口同一判据；无身份（web 运维面）⇒ 全量放行
  const denied = ownershipFailure(feature, identity);
  if (denied !== null) return denied;

  const nodes = listFeatureTasks(feature.featureId, { limit: 1000 });
  const byId = new Map(nodes.map((n) => [n.taskId, n]));
  /** 读缓存：同项目写档忙明细 / 同项目只读档占位 / 同一位次上界的计数各查一次（节点上限 1000，纯读、量小） */
  const busyByProject = new Map<string, QueuedTaskRecord[]>();
  const readLaneByProject = new Map<string, QueuedTaskRecord[]>();
  /** 位次缓存键：入队时刻；`NO_QUEUED_AT` = 未入队（不设上界）那一档 */
  const NO_QUEUED_AT = "";
  const aheadByUpperBound = new Map<string, number>();

  const traced: FeatureTraceNode[] = [];
  for (const n of nodes) {
    if (n.state !== "working" && n.state !== "input-required") continue;
    const q = getQueuedTask(n.taskId);
    // 仅在队时报告队列态；NULL（未入队）与 `working ∧ settled` 残留（重排后待再派）一律归 null
    const queueState: QueueState | null =
      n.state === "working" && q !== null && q.queueState !== "settled" ? q.queueState : null;

    const blockedOn = (n.dependencies ?? []).filter((id) => byId.get(id)?.state !== "completed");

    let busyTasks = busyByProject.get(n.projectId);
    if (busyTasks === undefined) {
      busyTasks = listBusyTasksForProject(n.projectId);
      busyByProject.set(n.projectId, busyTasks);
    }
    const others = busyTasks.filter((t) => t.taskId !== n.taskId);
    // 占位者优先取在飞（claimed/running，携带 claimed_by = 占位机）；否则取最早入队者
    const occupier =
      others.find((t) => t.queueState === "claimed" || t.queueState === "running") ??
      others[0] ??
      null;
    const projectBusy: FeatureTraceProjectBusy = {
      busy: occupier !== null,
      taskId: occupier?.taskId ?? null,
      machineId: occupier?.claimedBy ?? null,
    };

    // ★ 只读档占位面（写忙集 O-N1 起排除 read ⇒ 这一格不能空着，否则假空洞 = U9）
    let readLaneTasks = readLaneByProject.get(n.projectId);
    if (readLaneTasks === undefined) {
      readLaneTasks = listReadLaneTasksForProject(n.projectId);
      readLaneByProject.set(n.projectId, readLaneTasks);
    }
    const readOccupants: FeatureTraceReadOccupant[] = readLaneTasks
      .filter((t) => t.taskId !== n.taskId)
      .map((t) => ({
        taskId: t.taskId,
        featureId: t.featureId,
        queueState: t.queueState,
        machineId: t.claimedBy,
        queuedAt: t.queuedAt,
      }));

    let position: number | null = null;
    if (n.state === "working" && (queueState === "queued" || queueState === null)) {
      // 上界 = 自己的入队时刻（与 `claimTask` 实领序同键）；未入队 ⇒ 不设上界（此刻入队即在队尾）
      const upperBound = queueState === "queued" ? (q?.queuedAt ?? null) : null;
      const cacheKey = upperBound ?? NO_QUEUED_AT;
      let ahead = aheadByUpperBound.get(cacheKey);
      if (ahead === undefined) {
        ahead = countQueuedBefore(upperBound);
        aheadByUpperBound.set(cacheKey, ahead);
      }
      position = ahead + 1;
    }

    traced.push({
      taskId: n.taskId,
      projectId: n.projectId,
      state: n.state,
      lane: n.lane,
      queueState,
      waitReason: waitReasonOf(
        feature,
        n.state,
        queueState,
        blockedOn,
        projectBusy,
        readOccupants.length > 0,
      ),
      blockedOn,
      projectBusy,
      readOccupants,
      position,
      waitedSince: waitedSinceOf(n, q, queueState),
    });
  }
  return { ok: true, featureId: feature.featureId, featureState: feature.state, nodes: traced };
}

export interface FeatureTraceArgs {
  featureId: string;
}

/**
 * 节点「为何未完成」（闭集；排队可见面 / 限流后续在此之上叠加）。
 *
 * ★ v0.8.10 O-N3 起为**八值**（末位 `read_lane_running` 是读写分道后补上的一格）：
 * 写忙集（`busyProjectPredicate`）排除只读档 ⇒ 光看 `project_busy` 会把「被长跑 read 占着
 * machine 读闸」读成「没人挡、却没开工」的**假空洞**，故必须有一个显式类别 + `readOccupants[]` 明细
 * （跨侧不变量 U9：谓词改动与本档**同节点交付**）。
 */
export type FeatureWaitReason =
  /** `input-required`：等用户澄清 */
  | "awaiting_user"
  /** 在飞（claimed/running）：等远端执行结果回传 */
  | "running_remote"
  /** 已入队：等 Runner 领取 */
  | "queued"
  /** 直接依赖未 completed（含上游 failed/blocked） */
  | "upstream_dependencies"
  /** Feature 不在 `executing`：调度器不派发（waiting_approval / 主链后段 / 静止期外的停留） */
  | "feature_not_executing"
  /** 依赖已满足但同项目被**写档**占（项目串行门） */
  | "project_busy"
  /**
   * 依赖已满足、写门不挡，但同项目有**未落定的只读档**行在占位（v0.8.10 O-N3）。
   *
   * 挡人的不是 orch 的门（只读档不入写忙集），而是 machine 侧同 project 读并发闸
   * （`maxConcurrentReads`，缺省 1）⇒ **两个时钟不得相加**（口径 U6）：本值只说明
   * 「同项目有 read 未落定」，不推断对方还要跑多久。明细见 `readOccupants[]`。
   */
  | "read_lane_running"
  /** 就绪且项目空闲（写门、只读档均无占用）：等调度器 tick 的派发窗口 */
  | "ready_pending_dispatch";

/** 项目占用（串行门）视图：bool + 占位节点 + 占位机 */
export interface FeatureTraceProjectBusy {
  busy: boolean;
  /** 占用项目的节点 id（`working ∧ queue_state 忙 ∧ 写档` 的他节点，可跨 Feature）；无占用 ⇒ null */
  taskId: string | null;
  /** 占位机（占用节点的 `claimed_by`）；占用者已入队未被领取 ⇒ null */
  machineId: string | null;
}

/**
 * **只读档占位**（v0.8.10 O-N3；`lane='read' ∧ 未落定` 的他节点，可跨 Feature / 散活）。
 *
 * 与 {@link FeatureTraceProjectBusy} 的分工：后者 = **orch 写门**的事实（谁能挡派发），
 * 本视图 = **被写门让开的那片占用面**（不挡 orch 派发、但会占住 machine 侧该项目的执行位）。
 */
export interface FeatureTraceReadOccupant {
  taskId: string;
  /** 占位节点归属的 Feature；`null` = 散活行（不经调度器、无 Feature 归属） */
  featureId: string | null;
  /** 占位行的队列态（`queued` = 已入队未被领取；`claimed` / `running` = 已在机上执行） */
  queueState: QueueState;
  /** 占位机（`claimed_by`）；已入队未被领取 ⇒ null */
  machineId: string | null;
  /** 该行的入队时刻（「等了多久」的原料）；未入队的老行 ⇒ null */
  queuedAt: string | null;
}

/** trace 单节点视图（仅非终态节点） */
export interface FeatureTraceNode {
  taskId: string;
  projectId: string;
  state: TaskRecord["state"];
  /** **并发档**（v0.8.10 O-N3 additive；`read` = 只读档，不参与写忙集） */
  lane: TaskLane;
  /** 队列态；null = 不在队（未入队 / 重排后待再派 / input-required） */
  queueState: QueueState | null;
  waitReason: FeatureWaitReason;
  /** 未 completed 的直接依赖 id（与真实依赖一致；含 failed/blocked 上游） */
  blockedOn: string[];
  projectBusy: FeatureTraceProjectBusy;
  /**
   * 同项目**只读档**占位明细（不含自己；空数组 = 无只读占位）。
   * `projectBusy.busy === false` 而本数组非空 ⇒ 即 `waitReason='read_lane_running'` 那一格。
   */
  readOccupants: FeatureTraceReadOccupant[];
  /**
   * FIFO 位次（1 起）；不适用（在飞 / 待澄清）⇒ null。
   * **与 `claimTask` 实领序同键**（`queued_at`，v0.8.10 O-N3）；未入队节点 = 「此刻入队」的投影位次。
   */
  position: number | null;
  /** 等待起点（在飞 = 领取时刻；排队 = 入队时刻；未入队 = 登记时刻；待澄清 = 最后更新时刻） */
  waitedSince: string | null;
}

export interface FeatureTraceSuccess {
  ok: true;
  featureId: string;
  featureState: FeatureState;
  nodes: FeatureTraceNode[];
}

/** `waitReason` 判定（优先级自上而下；与 `computeReadyNodes` 的判据族一致但面向解释） */
function waitReasonOf(
  feature: FeatureRecord,
  state: TaskRecord["state"],
  queueState: QueueState | null,
  blockedOn: readonly string[],
  projectBusy: FeatureTraceProjectBusy,
  hasReadLaneOccupant: boolean,
): FeatureWaitReason {
  if (state === "input-required") return "awaiting_user";
  if (queueState === "claimed" || queueState === "running") return "running_remote";
  if (queueState === "queued") return "queued";
  if (blockedOn.length > 0) return "upstream_dependencies";
  if (feature.state !== "executing") return "feature_not_executing";
  if (projectBusy.busy) return "project_busy";
  // 写门不挡却没开工 ⇒ 先看是不是只读档占着 machine 的读位（v0.8.10 O-N3，消「假空洞」）
  if (hasReadLaneOccupant) return "read_lane_running";
  return "ready_pending_dispatch";
}

/** 等待起点（按队列态选取对应时刻列；老记录时刻列为 null 时逐级回退） */
function waitedSinceOf(
  node: TaskRecord,
  q: QueuedTaskRecord | null,
  queueState: QueueState | null,
): string | null {
  if (node.state === "input-required") return node.updatedAt;
  if (queueState === "claimed" || queueState === "running") {
    return q?.claimedAt ?? node.startedAt ?? node.createdAt;
  }
  if (queueState === "queued") return q?.queuedAt ?? node.createdAt;
  return node.createdAt;
}
