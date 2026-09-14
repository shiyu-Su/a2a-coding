/**
 * 串行 Task DAG 调度器（v0.3.0）。
 *
 * 定位：**上层编排循环**，复用 `task-watcher` 作下层单任务看护（不重造 poll/renew）。
 * 调度器为**代码组件**，在桥进程内后台运行，LLM 不参与等待 / 轮询。
 *
 * 循环（串行，同一 Feature 同时最多一个在飞任务）：
 *   取就绪任务（`dependencies` 全部 completed）→ 派发 → 等 onSettled → 推进 Feature → 取下一个
 *
 * 职责边界：
 * - 派发动作由注入的 `dispatch` 实现（`bridge/index.ts` 的 `dispatchFeatureNode`）承担
 *   ——locate → ensure → A2A send，并在终态时回调 `notifyTaskSettled`；
 * - 本模块只做「就绪判定 / 门闩 / 状态收敛 / 启动恢复」，不直接触碰 A2A。
 *
 * 失败语义（v0.3.0 无 `blocked`）：任一任务 `failed` / 看护放弃 → Feature `failed`；
 * 任务 `input-required` → Feature `needs_input`（等用户 / orch agent `advance` 续推）。
 */
import {
  getFeature,
  listFeatureTasks,
  listFeatures,
  updateFeatureState,
  updateTaskState,
} from "../session/store.js";
import {
  allowedTransitions,
  canTransition,
  isTerminalFeatureState,
} from "../feature/state-machine.js";
import type { FeatureRecord, TaskRecord, TaskState } from "../types.js";

/** 桥重启后对账在飞任务时写入的结果文本（对齐 wrapper `failed(interrupted)` 语义） */
export const FEATURE_INTERRUPTED_TEXT =
  "任务因桥进程重启而中断（interrupted），未产出终态；请重新发起或重试。";

/** 看护放弃（连续失败超限）时写入的结果文本 */
export const FEATURE_ABANDONED_TEXT =
  "任务后台看护连续失败超限（abandoned），任务状态未知；请重新发起或重试。";

/** 调度循环间隔（可配，默认 1500ms） */
export const FEATURE_TICK_MS = readPositiveIntEnv("FEATURE_TICK_MS", 1_500);

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** 注入的派发结果：`settled` 表示同步即可判定终态（内联 completed/failed/input-required） */
export interface FeatureDispatchResult {
  ok: boolean;
  settled?: { state: TaskState; text: string | null };
  error?: string;
}

/** 注入的节点派发函数（由桥实现；已在远端终态时回调 notifyTaskSettled） */
export type FeatureNodeDispatch = (node: TaskRecord) => Promise<FeatureDispatchResult>;

export interface FeatureSchedulerOptions {
  dispatch: FeatureNodeDispatch;
  pollIntervalMs?: number;
}

/** 启动恢复摘要 */
export interface FeatureRecoverySummary {
  /** 扫描到的非终态 Feature 数 */
  scanned: number;
  /** 被收敛为 failed 的 Feature 数 */
  failedFeatures: number;
  /** 被按 interrupted 语义收敛的任务数 */
  interruptedTasks: number;
}

export class FeatureScheduler {
  private readonly dispatch: FeatureNodeDispatch;
  private readonly pollIntervalMs: number;
  /** 每 Feature 单任务门闩（防双重派发；仅覆盖「派发调用进行中」这一瞬间） */
  private readonly dispatching = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: FeatureSchedulerOptions) {
    this.dispatch = options.dispatch;
    this.pollIntervalMs = options.pollIntervalMs ?? FEATURE_TICK_MS;
  }

  /** 启动后台循环（幂等） */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    // 不因定时器持有进程：桥退出即终止（生命周期随桥进程）
    if (typeof this.timer.unref === "function") this.timer.unref();
    void this.tick();
  }

  /** 停止后台循环（幂等） */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 触发一次推进（approve / advance / 任务终态后调用；不阻塞调用方） */
  kick(): void {
    void this.tick();
  }

  /**
   * 任务终态通知（由桥的看护 `onSettled` / 同步派发结果调用）。
   * `failed` → Feature failed；`input-required` → Feature needs_input；`completed` → 交给 tick 判完成。
   */
  notifyTaskSettled(
    featureId: string,
    taskId: string,
    outcome: { state: TaskState; text: string | null },
  ): void {
    const feature = getFeature(featureId);
    if (feature === null || isTerminalFeatureState(feature.state)) return;
    if (outcome.state === "failed") {
      this.failFeature(feature, `任务 ${taskId} 失败`);
      return;
    }
    if (outcome.state === "input-required") {
      this.needsInputFeature(feature, `任务 ${taskId} 需人工澄清`);
      return;
    }
    // completed：由 tick 判定「全部任务终态 → integrating」
    this.kick();
  }

  /**
   * 桥重启恢复（**纯本地对账 + 状态收敛，不 ensure、不派发**）。
   * - `executing` 且存在**已派发**（remoteTaskId 非空）的 `working` 任务：按 wrapper
   *   `failed(interrupted)` 语义收敛（任务置 failed + Feature 置 failed）；
   * - `waiting_approval` / `needs_input` / `integrating` / `testing` / `reviewing` 保持挂起；
   * - 其余非终态（discussing/analyzing/planning）保持。
   */
  recover(): FeatureRecoverySummary {
    const summary: FeatureRecoverySummary = {
      scanned: 0,
      failedFeatures: 0,
      interruptedTasks: 0,
    };
    for (const feature of listFeatures({ limit: 1000 })) {
      if (isTerminalFeatureState(feature.state)) continue;
      summary.scanned += 1;
      if (feature.state !== "executing") continue;
      const nodes = listFeatureTasks(feature.featureId, { limit: 1000 });
      const inFlight = nodes.filter(
        (n) => n.remoteTaskId !== null && n.state === "working",
      );
      if (inFlight.length === 0) continue; // 无在飞任务：保留，交由调度循环续推
      for (const node of inFlight) {
        updateTaskState(node.taskId, "failed", node.artifactsJson, FEATURE_INTERRUPTED_TEXT);
        summary.interruptedTasks += 1;
      }
      if (this.failFeature(feature, "桥重启：在飞任务按 interrupted 语义收敛")) {
        summary.failedFeatures += 1;
      }
    }
    return summary;
  }

  // ------------------------------------------------------------------
  // 内部：调度循环
  // ------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const features = listFeatures({ limit: 1000 });
      for (const feature of features) {
        if (feature.state !== "executing") continue;
        await this.advanceExecuting(feature);
      }
    } catch (err) {
      console.error(`[a2a-feature] 调度循环异常：${toMessage(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** 推进单个 `executing` Feature：校验 DAG → 判失败/澄清/完成 → 派发下一个就绪节点 */
  private async advanceExecuting(feature: FeatureRecord): Promise<void> {
    const nodes = listFeatureTasks(feature.featureId, { limit: 1000 });
    if (nodes.length === 0) return;
    if (this.dispatching.has(feature.featureId)) return; // 门闩：派发调用进行中

    const dagError = validateDag(nodes);
    if (dagError !== null) {
      this.failFeature(feature, dagError);
      return;
    }

    // 失败 / 需澄清优先（本版无 blocked：任一失败即整体失败）
    if (nodes.some((n) => n.state === "failed")) {
      this.failFeature(feature, "存在失败任务");
      return;
    }
    if (nodes.some((n) => n.state === "input-required")) {
      this.needsInputFeature(feature, "存在待澄清任务");
      return;
    }
    // 全部 completed → 自动 executing → integrating
    if (nodes.every((n) => n.state === "completed")) {
      this.transition(feature, "integrating", "全部任务达终态（调度器自动）");
      return;
    }

    // 同一 Feature 同时最多一个在飞任务
    const inFlight = nodes.find((n) => n.remoteTaskId !== null && n.state === "working");
    if (inFlight !== undefined) return;

    const byId = new Map(nodes.map((n) => [n.taskId, n]));
    const ready = nodes.find(
      (n) => n.remoteTaskId === null && n.state === "working" && depsAllCompleted(n, byId),
    );
    if (ready === undefined) return; // 队列等待前序依赖中

    this.dispatching.add(feature.featureId);
    try {
      const result = await this.dispatch(ready);
      if (!result.ok) {
        this.failFeature(feature, result.error ?? `派发任务 ${ready.taskId} 失败`);
        return;
      }
      if (result.settled !== undefined) {
        this.notifyTaskSettled(feature.featureId, ready.taskId, result.settled);
      }
    } finally {
      this.dispatching.delete(feature.featureId);
    }
  }

  // ------------------------------------------------------------------
  // 内部：状态收敛
  // ------------------------------------------------------------------

  /** 置 failed；已终态或非法流转时返回 false */
  private failFeature(feature: FeatureRecord, reason: string): boolean {
    const current = getFeature(feature.featureId);
    if (current === null || isTerminalFeatureState(current.state)) return false;
    if (!canTransition(current.state, "failed")) return false;
    updateFeatureState(current.featureId, "failed");
    console.error(`[a2a-feature] Feature ${current.featureId} → failed：${reason}`);
    return true;
  }

  /** 置 needs_input（仅在允许流转时；记录触发任务由调用方文本说明） */
  private needsInputFeature(feature: FeatureRecord, reason: string): boolean {
    const current = getFeature(feature.featureId);
    if (current === null || isTerminalFeatureState(current.state)) return false;
    if (current.state === "needs_input") return false;
    if (!canTransition(current.state, "needs_input")) return false;
    updateFeatureState(current.featureId, "needs_input");
    console.error(`[a2a-feature] Feature ${current.featureId} → needs_input：${reason}`);
    return true;
  }

  /** 合法则流转，否则记日志（不抛） */
  private transition(feature: FeatureRecord, to: FeatureRecord["state"], reason: string): boolean {
    const current = getFeature(feature.featureId);
    if (current === null || isTerminalFeatureState(current.state)) return false;
    if (!canTransition(current.state, to)) {
      console.error(
        `[a2a-feature] Feature ${current.featureId} 非法流转 ${current.state} → ${to}（合法后继：${allowedTransitions(current.state).join(" / ") || "无"}）；跳过：${reason}`,
      );
      return false;
    }
    updateFeatureState(current.featureId, to);
    console.error(`[a2a-feature] Feature ${current.featureId} → ${to}：${reason}`);
    return true;
  }
}

/**
 * DAG 合法性校验：悬空引用 / 环 → 返回错误说明（调度器据此置 Feature failed）。
 * 依赖引用的是**同一 Feature 内的本地 taskId**。
 */
export function validateDag(nodes: readonly TaskRecord[]): string | null {
  const byId = new Map(nodes.map((n) => [n.taskId, n]));
  for (const node of nodes) {
    for (const dep of node.dependencies ?? []) {
      if (!byId.has(dep)) {
        return `任务 ${node.taskId} 依赖悬空引用 ${dep}（不在本 Feature 任务集内）`;
      }
    }
  }
  // DFS 三色环检测
  const color = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    const c = color.get(id);
    if (c === 1) return true; // 回边 = 环
    if (c === 2) return false;
    color.set(id, 1);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (visit(dep)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const node of nodes) {
    if (visit(node.taskId)) return `任务依赖存在环（起点 ${node.taskId}）`;
  }
  return null;
}

/** 依赖是否全部 completed */
function depsAllCompleted(node: TaskRecord, byId: Map<string, TaskRecord>): boolean {
  for (const dep of node.dependencies ?? []) {
    if (byId.get(dep)?.state !== "completed") return false;
  }
  return true;
}
