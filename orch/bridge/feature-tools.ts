/**
 * MCP Feature 工具组（v0.3.0，5 个）。
 *
 * 纯数据层处理器：只依赖 `session/store.ts` 与 `feature/state-machine.ts`，
 * 不触碰 A2A / 不触发调度（调度 kick 由 `bridge/index.ts` 在工具返回后统一发起）。
 *
 * - `handleFeatureCreate`  新建 Feature（**初态 `waiting_approval`** = 主链起点；落 `contextId` 到
 *                          `features.context_id`）
 * - `handleFeatureStatus`  查询单个 Feature 详情 / 全部列表（state + tasks 摘要 + artifacts）
 * - `handleFeatureAdvance` orch agent 驱动主链推进（状态机校验合法后继；`note`→plan、
 *                          `decisions`/`contracts` 可选落 Feature Context；`answer` 用于 needs_input 补齐）；
 *                          **`waiting_approval → executing` 已禁用** —— 唯一准入 = `handleFeatureApprove`，
 *                          错误码 `feature_approval_required`
 * - `handleFeatureApprove` 审批门：`waiting_approval → executing`
 * - `handleFeatureCancel`  任意非终态 → `cancelled`
 */
import { randomUUID } from "node:crypto";
import {
  createFeature,
  getFeature,
  listArtifactsByFeature,
  listFeatureTasks,
  listFeatures,
  rearmTask,
  updateFeatureContext,
  updateFeatureState,
} from "../session/store.js";
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
   */
  failureKind: FailureKind | null;
  /**
   * 条件重试已用次数（v0.4.1；`0` = 未重试）。
   * 供宿主判断「重试是否已用尽」（N=1 门槛）而无需另查库。
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
}

export interface FeatureStateChangeSuccess {
  ok: true;
  featureId: string;
  from: FeatureState;
  state: FeatureState;
  note?: string;
}

export function handleFeatureAdvance(
  args: FeatureAdvanceArgs,
): FeatureStateChangeSuccess | FeatureToolFailure {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
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
