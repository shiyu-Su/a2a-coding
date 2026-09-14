/**
 * MCP Feature 工具组（v0.3.0，5 个）。
 *
 * 纯数据层处理器：只依赖 `session/store.ts` 与 `feature/state-machine.ts`，
 * 不触碰 A2A / 不触发调度（调度 kick 由 `bridge/index.ts` 在工具返回后统一发起）。
 *
 * - `handleFeatureCreate`  新建 Feature（`discussing`）
 * - `handleFeatureStatus`  查询单个 Feature 详情 / 全部列表（state + tasks 摘要）
 * - `handleFeatureAdvance` orch agent 驱动主链推进（状态机校验合法后继；`answer` 用于 needs_input 补齐）
 * - `handleFeatureApprove` 审批门：`waiting_approval → executing`
 * - `handleFeatureCancel`  任意非终态 → `cancelled`
 */
import { randomUUID } from "node:crypto";
import {
  createFeature,
  getFeature,
  listFeatureTasks,
  listFeatures,
  rearmTask,
  updateFeatureState,
} from "../session/store.js";
import {
  allowedTransitions,
  canTransition,
  isFeatureState,
  isTerminalFeatureState,
} from "../feature/state-machine.js";
import type { FeatureRecord, FeatureState, TaskRecord } from "../types.js";

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
    updatedAt: rec.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface FeatureCreateArgs {
  title: string;
  requirement?: string;
  /** 预留：orch 侧会话上下文（本版 features 表无该列，仅回显） */
  contextId?: string;
}

export interface FeatureCreateSuccess {
  ok: true;
  featureId: string;
  state: FeatureState;
  title: string;
  /** 回显入参 contextId（本版未持久化） */
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
    state: "discussing",
  });
  const success: FeatureCreateSuccess = { ok: true, featureId: rec.featureId, state: rec.state, title: rec.title };
  if (args.contextId !== undefined) success.contextId = args.contextId;
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
    return { ok: true, feature, tasks };
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
  /** 备注（本版未持久化，仅回显 / 日志） */
  note?: string;
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
