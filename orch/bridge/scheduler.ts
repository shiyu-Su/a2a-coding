/**
 * 拓扑并行 Task DAG 调度器（v0.4.0）。
 *
 * 定位：**上层编排循环**，复用 `task-watcher` 作下层单任务看护（不重造 poll/renew）。
 * 调度器为**代码组件**，在桥进程内后台运行，LLM 不参与等待 / 轮询。
 *
 * 循环（拓扑并行，同一 Feature 同批并发派发全部就绪节点）：
 *   取就绪集合（`dependencies` 全部 completed）→ 整批 `Promise.all` 并发派发 →
 *   等 settle（onSettled / kick）→ 收敛 Feature → 下一批就绪。
 *
 * 职责边界：
 * - 派发动作由注入的 `dispatch` 实现（`bridge/index.ts` 的 `dispatchFeatureNode`）承担
 *   ——locate → ensure → A2A send，并在终态时回调 `notifyTaskSettled`；
 * - 本模块只做「就绪判定 / 防重派 / 失败传播 / 状态收敛 / 启动恢复」，不直接触碰 A2A。
 *
 * 防重派（三层）：
 * 1. **Feature 级批门闩** `dispatching`：覆盖「整批 `Promise.all` 开始 → 各节点落库完成」全程；
 * 2. **节点级在飞标记** `inFlightNodes`：派发前**同步**置位、批次 settle 后清除，
 *    使 `remoteTaskId` 尚未网络回填的窗口内节点不可被重复选中；
 * 3. **tick 守卫**：`ticking` 防扫描重入 + `tickingFeatures` 按 Feature 粒度独立推进，
 *    避免单个 Feature 的长派发（`ensure` 可能数十秒）饿死其他 Feature。
 *
 * 失败语义（v0.4.0）：任一任务 `failed` → 沿 `dependencies` 反向**传递闭包**把下游
 * `working` 节点置 `blocked`（Task 层本地态，不映射 A2A）；Feature 收敛 `failed`
 * （**Feature 层不新增 `blocked`**）；任务 `input-required` → Feature `needs_input`。
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

// ---------------------------------------------------------------------------
// 纯函数（无副作用 / 可单测）
// ---------------------------------------------------------------------------

/** 依赖三态：`completed`（可派发）/ `pending`（前序未完成）/ `upstreamFailed`（上游失败或阻塞） */
export type DepState = "completed" | "pending" | "upstreamFailed";

/**
 * 单节点依赖三态判定。
 * - 任一上游 `failed` / `blocked` → `upstreamFailed`（不带病派发）；
 * - 否则存在未完成上游 → `pending`；
 * - 全部 completed（含无依赖）→ `completed`。
 */
export function depStateOf(
  node: TaskRecord,
  byId: ReadonlyMap<string, TaskRecord>,
): DepState {
  let pending = false;
  for (const dep of node.dependencies ?? []) {
    const state = byId.get(dep)?.state;
    if (state === "failed" || state === "blocked") return "upstreamFailed";
    if (state !== "completed") pending = true;
  }
  return pending ? "pending" : "completed";
}

/**
 * 计算**同批可并发派发**的就绪节点集合（同层无依赖节点一并返回）。
 * 就绪 = `working` 且尚未派发（`remoteTaskId === null`）且不在在飞标记内且依赖全部 completed。
 */
export function computeReadyNodes(
  nodes: readonly TaskRecord[],
  inFlight?: ReadonlySet<string>,
): TaskRecord[] {
  const byId = new Map(nodes.map((n) => [n.taskId, n]));
  return nodes.filter(
    (n) =>
      n.state === "working" &&
      n.remoteTaskId === null &&
      !(inFlight?.has(n.taskId) ?? false) &&
      depStateOf(n, byId) === "completed",
  );
}

/**
 * 失败传播：沿 `dependencies` **反向传递闭包**，返回因 `failedId` 失败而应置 `blocked` 的
 * 下游节点 id 列表（仅含当前 `working` 者；已完成 / 已失败 / 已阻塞者不改写）。
 * 遍历不因下游已终态而中断，保证其再下游同样被覆盖。
 */
export function propagateBlocked(failedId: string, nodes: readonly TaskRecord[]): string[] {
  const byId = new Map(nodes.map((n) => [n.taskId, n]));
  // 反向边：上游 -> 直接下游
  const downstreamOf = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.dependencies ?? []) {
      const list = downstreamOf.get(dep);
      if (list === undefined) downstreamOf.set(dep, [node.taskId]);
      else list.push(node.taskId);
    }
  }
  const blocked: string[] = [];
  const seen = new Set<string>([failedId]);
  const queue: string[] = [failedId];
  for (;;) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const child of downstreamOf.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      if (byId.get(child)?.state === "working") blocked.push(child);
      queue.push(child); // 继续下探，覆盖“中间节点已终态”的再下游
    }
  }
  return blocked;
}

/** 收敛判定结果（顺序语义见 `reduceConvergence`） */
export type Convergence =
  | { kind: "failed"; reason: string }
  | { kind: "needs_input"; reason: string }
  | { kind: "all_completed" }
  | { kind: "dispatch" };

/**
 * 收敛判定（顺序）：
 * 1. 存在 `failed` / `blocked` → `failed`（Feature 收敛失败，不派发）；
 * 2. 存在 `input-required` → `needs_input`；
 * 3. 全部 `completed` → `all_completed`；
 * 4. 否则 → `dispatch`（派发全部就绪节点）。
 */
export function reduceConvergence(nodes: readonly TaskRecord[]): Convergence {
  const failed = nodes.filter((n) => n.state === "failed").length;
  const blocked = nodes.filter((n) => n.state === "blocked").length;
  if (failed > 0 || blocked > 0) {
    return {
      kind: "failed",
      reason:
        failed > 0
          ? `存在失败任务（${failed}）`
          : `存在被阻塞任务（${blocked}）`,
    };
  }
  if (nodes.some((n) => n.state === "input-required")) {
    return { kind: "needs_input", reason: "存在待澄清任务" };
  }
  if (nodes.length > 0 && nodes.every((n) => n.state === "completed")) {
    return { kind: "all_completed" };
  }
  return { kind: "dispatch" };
}

export class FeatureScheduler {
  private readonly dispatch: FeatureNodeDispatch;
  private readonly pollIntervalMs: number;
  /** Feature 级批门闩：整批 `Promise.all` 开始 → 各节点落库完成，防同 Feature 两批重叠 */
  private readonly dispatching = new Set<string>();
  /** 节点级在飞标记：派发前同步置位、批次 settle 后清除（补 `remoteTaskId` 网络回填窗口） */
  private readonly inFlightNodes = new Set<string>();
  /** tick 守卫：按 Feature 粒度，长派发不互相阻塞 */
  private readonly tickingFeatures = new Set<string>();
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
   * `failed` → 先传播 blocked 再 Feature failed；`input-required` → Feature needs_input；
   * `completed` → 交给 tick 判完成（可能触发下一批就绪）。
   */
  notifyTaskSettled(
    featureId: string,
    taskId: string,
    outcome: { state: TaskState; text: string | null },
  ): void {
    const feature = getFeature(featureId);
    if (feature === null || isTerminalFeatureState(feature.state)) return;
    if (outcome.state === "failed") {
      this.propagateFailure(feature, taskId);
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
   * - `executing` 且存在**已派发**（`remoteTaskId` 非空）的 `working` 任务：收集**全部**在飞节点，
   *   各按 wrapper `failed(interrupted)` 语义收敛（任务置 failed），随后 Feature 置 failed（不重派）；
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

  /**
   * 扫描 `executing` Feature 并**逐 Feature 独立推进**（不 await、不互相阻塞）：
   * 单个 Feature 的 `ensure` 长派发不会饿死其他 Feature；重入由 `ticking` +
   * `tickingFeatures` + `dispatching` + `inFlightNodes` 逐层拦截。
   */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const features = listFeatures({ limit: 1000 });
      for (const feature of features) {
        if (feature.state !== "executing") continue;
        void this.advanceFeature(feature);
      }
    } catch (err) {
      console.error(`[a2a-feature] 调度循环异常：${toMessage(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** 按 Feature 粒度守卫一次推进（长派发期间该 Feature 不重入，其他 Feature 不受影响） */
  private async advanceFeature(feature: FeatureRecord): Promise<void> {
    if (this.tickingFeatures.has(feature.featureId)) return;
    this.tickingFeatures.add(feature.featureId);
    try {
      await this.advanceExecuting(feature);
    } catch (err) {
      console.error(
        `[a2a-feature] Feature ${feature.featureId} 推进异常：${toMessage(err)}`,
      );
    } finally {
      this.tickingFeatures.delete(feature.featureId);
    }
  }

  /**
   * 推进单个 `executing` Feature：DAG 校验 → 失败传播 → 收敛判定 → 整批并发派发就绪节点。
   */
  private async advanceExecuting(feature: FeatureRecord): Promise<void> {
    if (this.dispatching.has(feature.featureId)) return; // 批门闩：本 Feature 派发进行中
    let nodes = listFeatureTasks(feature.featureId, { limit: 1000 });
    if (nodes.length === 0) return;

    const dagError = validateDag(nodes);
    if (dagError !== null) {
      this.failFeature(feature, dagError);
      return;
    }

    // 失败传播（幂等）：任一 failed → 下游传递闭包置 blocked
    const failedIds = nodes
      .filter((n) => n.state === "failed")
      .map((n) => n.taskId);
    if (failedIds.length > 0) {
      let blockedAny = false;
      for (const failedId of failedIds) {
        if (this.propagateFailure(feature, failedId).length > 0) blockedAny = true;
      }
      if (blockedAny) nodes = listFeatureTasks(feature.featureId, { limit: 1000 });
    }

    const convergence = reduceConvergence(nodes);
    if (convergence.kind === "failed") {
      this.failFeature(feature, convergence.reason);
      return;
    }
    if (convergence.kind === "needs_input") {
      this.needsInputFeature(feature, convergence.reason);
      return;
    }
    if (convergence.kind === "all_completed") {
      this.transition(feature, "integrating", "全部任务达终态（调度器自动）");
      return;
    }

    // 就绪集合（拓扑并行）：同层无依赖节点整批并发派发
    const ready = computeReadyNodes(nodes, this.inFlightNodes);
    if (ready.length === 0) return; // 队列等待前序依赖中 / 全部在飞

    // Feature 级批门闩 + 节点级在飞标记：**同步置位**（await 前完成，保证原子防重入）
    this.dispatching.add(feature.featureId);
    for (const node of ready) this.inFlightNodes.add(node.taskId);
    try {
      const results = await Promise.all(ready.map((node) => this.dispatchNode(node)));
      for (let i = 0; i < ready.length; i += 1) {
        const node = ready[i];
        const result = results[i];
        if (node === undefined || result === undefined) continue;
        if (!result.ok) {
          const reason = result.error ?? `派发任务 ${node.taskId} 失败`;
          updateTaskState(node.taskId, "failed", null, reason);
          this.propagateFailure(feature, node.taskId);
          this.failFeature(feature, reason);
          return;
        }
        if (result.settled !== undefined) {
          this.notifyTaskSettled(feature.featureId, node.taskId, result.settled);
        }
      }
    } finally {
      for (const node of ready) this.inFlightNodes.delete(node.taskId);
      this.dispatching.delete(feature.featureId);
    }
  }

  // ------------------------------------------------------------------
  // 内部：派发 / 失败传播 / 状态收敛
  // ------------------------------------------------------------------

  /** 单节点派发；捕获异常，避免整批 `Promise.all` 因单点 reject 丢失其他节点结果 */
  private async dispatchNode(node: TaskRecord): Promise<FeatureDispatchResult> {
    try {
      return await this.dispatch(node);
    } catch (err) {
      return { ok: false, error: toMessage(err) };
    }
  }

  /**
   * 失败传播：把 `failedTaskId` 的全部下游（传递闭包）`working` 节点置 `blocked`，
   * 返回被阻塞的节点 id 列表。
   */
  private propagateFailure(feature: FeatureRecord, failedTaskId: string): string[] {
    const nodes = listFeatureTasks(feature.featureId, { limit: 1000 });
    const blocked = propagateBlocked(failedTaskId, nodes);
    for (const id of blocked) updateTaskState(id, "blocked");
    return blocked;
  }

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
