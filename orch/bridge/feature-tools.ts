/**
 * MCP Feature 工具组（v0.3.0，5 个）。
 *
 * 纯数据层处理器：只依赖 `session/store.ts` 与 `feature/state-machine.ts`，
 * 不触碰 A2A / 不触发调度（调度 kick 由 `bridge/index.ts` 在工具返回后统一发起）。
 *
 * - `handleFeatureCreate`  新建 Feature（`discussing`；落 `contextId` 到 `features.context_id`）
 * - `handleFeatureStatus`  查询单个 Feature 详情 / 全部列表（state + tasks 摘要 + artifacts）
 * - `handleFeatureAdvance` orch agent 驱动主链推进（状态机校验合法后继；`note`→plan、
 *                          `decisions`/`contracts` 可选落 Feature Context；`answer` 用于 needs_input 补齐）
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
    state: "discussing",
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
