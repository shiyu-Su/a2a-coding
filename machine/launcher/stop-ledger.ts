/**
 * 进程内停事件账（v0.8.10 · 节点 M-N4，改造文档 §2.4 归因五键的机制面）。
 *
 * 回答「**谁杀了这一轮**」：`manager.stop(projectId)` 时把「停因 + 当时的按项目在飞快照」
 * 盖进本账；`runner-exec` 结算在飞任务时按 `projectId + 时间窗` 命中 ⇒ 落
 * `diagnostics.stopCause` / `stopCauseTaskId`。宿主据此区分「被连坐」与「业务失败」，
 * 不再对裸 `failed` 误触发重派（改造文档 §3.2 U4 的读账口径）。
 *
 * **不落盘**：连坐是**进程内事实**（跨进程的孤儿另有 v0.8.7 的启动补结算链）。
 * 同时承载两个**运维观察面**（供 `config-snapshot` 播报与 `/health degraded` 读）：
 * - `lastCancelQuiesceMs` = 该项目最近一次「取消 → 静默」的实际耗时
 *   （另有全局口径 `lastCancelQuiesceMsOverall` = 任意项目最近一次取消往返耗时，供 `/health degraded`）；
 * - `cancelUnsupportedProjectIds` = 取消发出但**超时未静默**的项目集（= 后端不认 `session/cancel`）。
 */

/**
 * 停因闭集（四值）：
 * - `idle-reap` = 空闲回收（`IdleReaper.onIdle`）；
 * - `stop-command` = 桥下发的显式 `stop` 命令（`handleStop`）；
 * - `continue` / `resend` = 为续跑 / 重发而停桥 —— **v0.8.10 · M-N3 起该两路已改「定向取消」
 *   不再停桥 ⇒ 本版无生产者**，保留取值是为「将来重新引入停桥路径时不必扩面」。
 */
export type StopCause = "idle-reap" | "continue" | "resend" | "stop-command";

/** 一条停事件（进程内，不落盘） */
export interface StopEvent {
  projectId: string;
  cause: StopCause;
  /** 肇事任务 id（触发停的**归属者**，≠ 被停者；改造文档 §3.2 U8） */
  causeTaskId?: string;
  /** 停当时该项目的在飞数快照（`InFlightLedger.countFor`；0 = 账面上「无人可连坐」） */
  inflightAtStop: number;
  /** 停发生时刻（ms epoch，取自本账注入的时钟） */
  atMs: number;
}

export interface StopEventLedgerOptions {
  /** 时钟（ms epoch；缺省 `Date.now`；单测注入假时钟以与执行器同一时间轴） */
  now?: () => number;
  /** 每项目保留的停事件上限（缺省 {@link DEFAULT_MAX_EVENTS_PER_PROJECT}，防无界增长） */
  maxEventsPerProject?: number;
}

/** 每项目事件上限：连坐归因只需回溯最近几次派发，超出即最旧先丢 */
export const DEFAULT_MAX_EVENTS_PER_PROJECT = 8;

/**
 * 停事件账 + 取消观察面（内存态，单实例由 `launcher/index.ts` 创建并注入
 * `AgentManager`（写停事件、读观察面）与 `RunnerCommandExecutor`（读停事件、写观察面））。
 */
export class StopEventLedger {
  private readonly nowFn: () => number;
  private readonly maxEvents: number;
  private readonly events = new Map<string, StopEvent[]>();
  private readonly lastQuiesceMs = new Map<string, number>();
  /** 全局最近一次「取消 → 静默」取消往返耗时（`/health degraded.lastCancelQuietMs` 的数据源） */
  private lastQuiesceOverallMs: number | null = null;
  private readonly unsupported = new Set<string>();

  constructor(options: StopEventLedgerOptions = {}) {
    this.nowFn = options.now ?? Date.now;
    this.maxEvents = Math.max(1, options.maxEventsPerProject ?? DEFAULT_MAX_EVENTS_PER_PROJECT);
  }

  /** 盖一条停事件（调用方 = `AgentManager.stop`，仅在给定停因时记） */
  recordStop(input: {
    projectId: string;
    cause: StopCause;
    causeTaskId?: string;
    inflightAtStop: number;
  }): StopEvent {
    const event: StopEvent = {
      projectId: input.projectId,
      cause: input.cause,
      ...(input.causeTaskId !== undefined ? { causeTaskId: input.causeTaskId } : {}),
      inflightAtStop: input.inflightAtStop,
      atMs: this.nowFn(),
    };
    const list = this.events.get(event.projectId) ?? [];
    list.push(event);
    while (list.length > this.maxEvents) list.shift();
    this.events.set(event.projectId, list);
    return event;
  }

  /**
   * 按 `projectId + 时间窗` 命中最近一次停事件（`[sinceMs, nowMs]` 闭区间；无 ⇒ null）。
   * `sinceMs` = 被归因任务的派发起算时刻 ⇒ 停**必须**落在该任务的飞行期内，
   * 更早的停事件不会追认到后来者（防「一次停、终身背锅」）。
   */
  matchStop(projectId: string, sinceMs: number, nowMs: number): StopEvent | null {
    const list = this.events.get(projectId);
    if (list === undefined) return null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const event = list[i];
      if (event !== undefined && event.atMs >= sinceMs && event.atMs <= nowMs) return event;
    }
    return null;
  }

  /** 记一次「取消 → 静默」成功（同时清除该项目的「不认取消」标记 —— 后发的取消往返值覆盖前科） */
  noteCancelQuiesce(projectId: string, quiesceMs: number): void {
    const ms = Math.max(0, Math.round(quiesceMs));
    this.lastQuiesceMs.set(projectId, ms);
    this.lastQuiesceOverallMs = ms;
    this.unsupported.delete(projectId);
  }

  /** 记一次「取消已发出但超时未静默」= 后端不认 `session/cancel` 的降级事实 */
  noteCancelUnsupported(projectId: string): void {
    this.unsupported.add(projectId);
  }

  /** 该项目最近一次取消往返耗时（无 ⇒ undefined ⇒ 调用方**省略该键**，不补 0） */
  lastCancelQuiesceMs(projectId: string): number | undefined {
    return this.lastQuiesceMs.get(projectId);
  }

  /**
   * 全局最近一次「取消 → 静默」取消往返耗时（任意项目；无观察 ⇒ null）。
   * 供 `/health degraded.lastCancelQuietMs` —— 该键**恒在**，空态取 `null` 而非省略。
   */
  lastCancelQuiesceMsOverall(): number | null {
    return this.lastQuiesceOverallMs;
  }

  /** 超时未静默的项目集（只读快照，供 `/health degraded`） */
  cancelUnsupportedProjectIds(): string[] {
    return [...this.unsupported];
  }
}
