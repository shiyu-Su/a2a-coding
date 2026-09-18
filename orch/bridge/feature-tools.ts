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
 */
import { randomUUID } from "node:crypto";
import {
  appendEvent,
  createFeature,
  getFeature,
  listArtifactsByFeature,
  listFeatureTasks,
  listFeatures,
  rearmForRetry,
  rearmTask,
  updateFeatureContext,
  updateFeatureState,
  updateTaskState,
} from "../session/store.js";
import { planResume } from "./scheduler.js";
import type { FeatureContextPatch } from "../session/store.js";
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
   * ⚠️ v0.6.1 REQ-05：失败分类器与写口已随「删五层」整块删除 ⇒ **本字段语义休眠（恒 `null`）**。
   * 字段**保留**（出参形状不变、web 零改动），但**不得**再据它判断失败类型。
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
): FeatureStatusSuccess | FeatureToolFailure {
  if (args.featureId !== undefined && args.featureId.length > 0) {
    const feature = getFeature(args.featureId);
    if (feature === null) {
      return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
    }
    const tasks = listFeatureTasks(feature.featureId, { limit: 1000 }).map(summarizeTask);
    const artifacts = listArtifactsByFeature(feature.featureId, 1000);
    return { ok: true, feature, tasks, artifacts };
  }
  const features = listFeatures({ limit: 1000 }).map((f) => ({
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
): FeatureAdvanceSuccess | FeatureToolFailure {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }

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
): FeatureStateChangeSuccess | FeatureToolFailure {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
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
): FeatureStateChangeSuccess | FeatureToolFailure {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
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
