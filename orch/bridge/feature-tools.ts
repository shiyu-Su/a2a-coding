/**
 * MCP Feature 工具组（v0.3.0，5 个）。
 *
 * 纯数据层处理器：只依赖 `session/store.ts`、`feature/state-machine.ts` 与 `./scheduler.js` 的
 * **纯函数**（`planResume` = 重派 / 解冻计划，无副作用、不触发调度），
 * 不触碰 A2A / 不触发调度（调度 kick 由 `bridge/index.ts` 在工具返回后统一发起）。
 *
 * - `handleFeatureCreate`  新建 Feature（**初态 `waiting_approval`** = 主链起点；落 `contextId` 到
 *                          `features.context_id`）
 * - `handleFeatureStatus`  查询单个 Feature 详情 / 全部列表（state + tasks 摘要 + artifacts）
 * - `handleFeatureAdvance` orch agent 驱动主链推进（状态机校验合法后继；`note`→plan、
 *                          `decisions`/`contracts` 可选落 Feature Context；`answer` 用于 needs_input 补齐）；
 *                          **`waiting_approval → executing` 已禁用** —— 唯一准入 = `handleFeatureApprove`，
 *                          错误码 `feature_approval_required`；**`retryTaskIds`**（§2.3）走**显式特例**：
 *                          跳过 `canTransition`（转移表零改动、无自环）、重派指定 `failed` 节点 +
 *                          解冻闭包**外**的 `blocked` 下游，**不改 Feature 态**
 * - `handleFeatureApprove` 审批门：`waiting_approval → executing`
 * - `handleFeatureCancel`  任意非终态 → `cancelled`
 *
 * 另含 **trace 只读投影**（v0.8.8 §2.10(c)，非 MCP 工具）：`handleFeatureTrace` 回答
 * 「这个 Feature 为什么还没完成」（在等谁 / 排队位次），纯读不落库，供工作台端点复用。
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
  getFeature,
  getQueuedTask,
  listArtifactsByFeature,
  listBusyTasksForProject,
  listFeatureTasks,
  listFeatures,
  rearmForRetry,
  rearmTask,
  updateFeatureContext,
  updateFeatureState,
  updateTaskState,
} from "../session/store.js";
import { planResume } from "./scheduler.js";
import type { FeatureContextPatch, QueueState, QueuedTaskRecord } from "../session/store.js";
import {
  allowedTransitions,
  canTransition,
  isFeatureState,
  isTerminalFeatureState,
} from "../feature/state-machine.js";
import type {
  ArtifactRecord,
  FailureKind,
  FeatureRecord,
  FeatureState,
  InputArtifactRef,
  TaskRecord,
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
] as const;

const DIAG_STRING_KEYS = ["ambiguousReason"] as const;
const DIAG_BOOLEAN_KEYS = ["sessionReused", "sessionResumed", "outcomeAmbiguous"] as const;

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
 * Feature **五出口归属校验**（§2.3 / §1.3 R-3 / G2）：`identity` = 本次连接身份（组名）。
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
// create
// ---------------------------------------------------------------------------

export interface FeatureCreateArgs {
  title: string;
  requirement?: string;
  /** Feature 级会话上下文（落 `features.context_id`，跨任务 / 跨 worker 启停复用） */
  contextId?: string;
}

export interface FeatureCreateSuccess {
  ok: true;
  featureId: string;
  state: FeatureState;
  title: string;
  /** 回显入参 contextId（已随 createFeature 持久化到 features.context_id） */
  contextId?: string;
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
  const featureId = randomUUID();
  const rec = createFeature({
    featureId,
    title,
    requirement: args.requirement ?? null,
    contextId: args.contextId ?? null,
    // 入口打标：归属 = 本次连接身份（组名）；无身份 ⇒ NULL（无归属，fail-closed 存量语义）
    ownerGroup: identity,
    // 主链起点 = 审批门停靠点（REQ-v0.4.1-2026-09-16-01 §2.3）：引擎只做需求实现，
    // 前段讨论 / 方案（Step 0/1）不走引擎；`waiting_approval → executing` 只能经 `a2a_feature_approve`
    state: "waiting_approval",
  });
  const success: FeatureCreateSuccess = { ok: true, featureId: rec.featureId, state: rec.state, title: rec.title };
  if (rec.contextId !== null) success.contextId = rec.contextId;
  return success;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface FeatureStatusArgs {
  featureId?: string;
}

export interface FeatureStatusSuccess {
  ok: true;
  feature?: FeatureRecord;
  tasks?: FeatureTaskSummary[];
  /** 该 Feature 已登记的产物（v0.4.0；仅单 Feature 查询返回） */
  artifacts?: ArtifactRecord[];
  features?: Array<FeatureRecord & { taskCount: number }>;
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
    return { ok: true, feature, tasks, artifacts };
  }
  // 列表路径：配组 ⇒ 只列本组 Feature（`owner_group = identity`，NULL 无归属被排除 = fail-closed）；
  // 无身份 ⇒ 全量（未配组 / web 运维视图）。
  const features = listFeatures({
    limit: 1000,
    ownerGroup: identity === null ? undefined : identity,
  }).map((f) => ({
    ...f,
    taskCount: listFeatureTasks(f.featureId, { limit: 1000 }).length,
  }));
  return { ok: true, features };
}

// ---------------------------------------------------------------------------
// advance
// ---------------------------------------------------------------------------

export interface FeatureAdvanceArgs {
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

  // ---- 重派与解冻（§2.3 / N4）：**显式特例**，不得给 `TRANSITIONS` 加自环 ----------------------
  // `retryTaskIds` 是**派发语义操作**（重派指定失败节点 + 解冻其闭包外下游），不是状态流转
  // ⇒ 跳过 `canTransition`（转移表保持单一事实源、不出现 `executing → executing` 自环）；
  // `to` 必须**显式** `"executing"`，以防借本参数做状态流转。
  if (args.retryTaskIds !== undefined) {
    return handleRetryResume(feature, { ...args, retryTaskIds: args.retryTaskIds });
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
  const patch: FeatureContextPatch = {};
  if (args.note !== undefined) patch.plan = args.note;
  if (args.decisions !== undefined) patch.decisions = args.decisions;
  if (args.contracts !== undefined) patch.contracts = args.contracts;
  if (Object.keys(patch).length > 0) {
    updateFeatureContext(feature.featureId, patch);
  }

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
  const patch: FeatureContextPatch = {};
  if (args.note !== undefined) patch.plan = args.note;
  if (args.decisions !== undefined) patch.decisions = args.decisions;
  if (args.contracts !== undefined) patch.contracts = args.contracts;
  if (Object.keys(patch).length > 0) updateFeatureContext(feature.featureId, patch);

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
  const updated = updateFeatureState(feature.featureId, "executing");
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
  if (isTerminalFeatureState(feature.state)) {
    return {
      ok: false,
      code: "feature_terminal",
      error: `Feature 已终态（${feature.state}），不可取消`,
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
// trace（v0.8.8 §2.10(c)：只读查询「在等谁 / 排队位次」；不落库、不触发调度）
// ---------------------------------------------------------------------------

/**
 * 「这个 Feature 为什么还没完成」的**只读投影**（REQ-v0.8.8-2026-09-22-01 §2.10(c) · O7）。
 *
 * 纯计算（store 只读 + 现成判据），**不落库、不加写口、不改调度器行为**；
 * 出参为**独立新增只读面**（不改既有工具出参形状），供工作台 trace 端点与后续
 * 「排队可见面 / 限流」复用同一 helper。
 *
 * 口径：
 * - 只输出**非终态节点**（`working` / `input-required`；`completed` / `failed` / `blocked` 不出）；
 * - **项目忙判定走队列态**（`state='working' ∧ queue_state IN ('queued','claimed','running')`，
 *   经 `listBusyTasksForProject` = `listBusyProjectIds` 同一谓词的行级展开）——
 *   **不走 `remote_task_id`**（pull 模型下该列在飞期间恒 NULL，用了永远判「不忙」）；
 *   占用者可跨 Feature（项目串行是全局事实）。调度器**进程内** `reservedProjects` 只守
 *   「入队未落库」的同 tick 窗口（毫秒级），本查询覆盖不到，口径上按已落库事实回答；
 * - `blockedOn` = **直接依赖**中未达 `completed` 者（含 failed/blocked 上游）；
 * - `position` = 全局 FIFO 位次估计：`queue_state='queued' ∧ created_at < 我` 计数 +1
 *   （仅对「已入队待领」或「就绪未入队」的 `working` 节点给出；ISO 同毫秒并列不区分）。
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
  /** 读缓存：同项目忙明细 / 同登记时刻的位次各查一次（节点数上限 1000，纯读、量小） */
  const busyByProject = new Map<string, QueuedTaskRecord[]>();
  const aheadByCreatedAt = new Map<string, number>();

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

    let position: number | null = null;
    if (n.state === "working" && n.createdAt !== null && (queueState === "queued" || queueState === null)) {
      let ahead = aheadByCreatedAt.get(n.createdAt);
      if (ahead === undefined) {
        ahead = countQueuedBefore(n.createdAt);
        aheadByCreatedAt.set(n.createdAt, ahead);
      }
      position = ahead + 1;
    }

    traced.push({
      taskId: n.taskId,
      projectId: n.projectId,
      state: n.state,
      queueState,
      waitReason: waitReasonOf(feature, n.state, queueState, blockedOn, projectBusy),
      blockedOn,
      projectBusy,
      position,
      waitedSince: waitedSinceOf(n, q, queueState),
    });
  }
  return { ok: true, featureId: feature.featureId, featureState: feature.state, nodes: traced };
}

export interface FeatureTraceArgs {
  featureId: string;
}

/** 节点「为何未完成」（闭集；排队可见面 / 限流后续在此之上叠加） */
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
  /** 依赖已满足但同项目被占（项目串行门） */
  | "project_busy"
  /** 就绪且项目空闲：等调度器 tick 的派发窗口 */
  | "ready_pending_dispatch";

/** 项目占用（串行门）视图：bool + 占位节点 + 占位机 */
export interface FeatureTraceProjectBusy {
  busy: boolean;
  /** 占用项目的节点 id（`working ∧ queue_state 忙` 的他节点，可跨 Feature）；无占用 ⇒ null */
  taskId: string | null;
  /** 占位机（占用节点的 `claimed_by`）；占用者已入队未被领取 ⇒ null */
  machineId: string | null;
}

/** trace 单节点视图（仅非终态节点） */
export interface FeatureTraceNode {
  taskId: string;
  projectId: string;
  state: TaskRecord["state"];
  /** 队列态；null = 不在队（未入队 / 重排后待再派 / input-required） */
  queueState: QueueState | null;
  waitReason: FeatureWaitReason;
  /** 未 completed 的直接依赖 id（与真实依赖一致；含 failed/blocked 上游） */
  blockedOn: string[];
  projectBusy: FeatureTraceProjectBusy;
  /** 全局 FIFO 位次估计（1 起）；不适用（在飞 / `created_at` 未知）⇒ null */
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
): FeatureWaitReason {
  if (state === "input-required") return "awaiting_user";
  if (queueState === "claimed" || queueState === "running") return "running_remote";
  if (queueState === "queued") return "queued";
  if (blockedOn.length > 0) return "upstream_dependencies";
  if (feature.state !== "executing") return "feature_not_executing";
  if (projectBusy.busy) return "project_busy";
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
