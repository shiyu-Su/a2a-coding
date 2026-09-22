/**
 * 后台看护（REQ-v0.1.1-2026-09-13-01；**v0.7.0 A5 对账目标重写**）。
 *
 * v0.7.0 连接模型反转为 pull：执行不再由桥 `message/send` 直连 A2A，而是目标机 Runner 经
 * `/runner/connect` **领取**本地执行、结果经 `/runner/result` → `upsertTaskResult` 落库。
 * 看护的对账目标随之由「远端 A2A `tasks/get`」换成**「读本地 `tasks` 行（`queue_state` +
 * 回传落库态）」**：
 *
 * - `poll`：读本地行（`queue_state` + 回传落库态 + 回传载荷）；
 * - `persist`：命中终态时按 `updateTaskState` 路径落终态 / artifacts / text；
 * - **`renew`（周期 `ensure`）退役** —— 续约判据已移派 Runner **本地**（在飞台账），桥侧不再对
 *   未终态任务调 `ensureProject`（旧第二条 ensure 通道整体消失）；
 * - **兜底（B2）**：`claimed` / `running` 且**领取者心跳超期** ⇒ 调注入的 O7 requeue / 事件路径
 *   （`reclaimStale`）；**不判 `failed`、不 `stop`**（stale ≠ failed）。回收后任务回 `queued`，
 *   看护继续等「Runner 回归重 claim 或宿主 `retryTaskIds`」；
 * - **兜底（B3）**：`queued` 无人领取 ⇒ **不自动失败、不计连续失败**，仅**一次性**事件提示
 *   （`onUnclaimed`）；处置走 `retryTaskIds` / `cancel`。
 *
 * 骨架不变（自 v0.1.1 起的既有纪律）：
 * - 进程内按 `taskId` 去重：同一任务的看护只启动一次；
 * - 单次 `poll` 失败仅记日志并继续；连续失败达上限后放弃（防永久故障空转）；
 * - `persist`（终态落库）异常与 `poll` 异常**分离分类** —— `persist` 抛错**不计入**连续失败、
 *   不走 abandoned，且终态仍**必调** `onSettled`（DAG 续推信号不丢）；
 * - 生命周期随桥进程：桥退出即终止（需求确认单边界）。
 */
import { getQueuedTask } from "../session/store.js";
import type { QueueState, QueuedTaskRecord } from "../session/store.js";
import type { TaskState } from "../types.js";
import { bridgeLog } from "./bridge-log.js";
import type { DegradationSink } from "./index.js";

/** 连续 poll 失败上限：达到后放弃看护（防永久性故障导致无限空转） */
export const WATCHER_MAX_CONSECUTIVE_FAILURES = 30;

/**
 * 看护对账视角的本地任务行（`poll` 返回）：
 * `queue_state` + Runner 回传落库态 + 回传载荷（artifacts / text）。
 */
export interface WatchedTaskView {
  /** 本地任务 id */
  taskId: string;
  /** 回传落库态（`upsertTaskResult` 写入的 `tasks.state`） */
  state: TaskState;
  /** 队列态（`queued` / `claimed` / `running` / `settled`；NULL 老行已归一 `settled`） */
  queueState: QueueState;
  /** 领取者（`claimed` / `running` 时的 machineId；未领取为 null） */
  claimedBy: string | null;
  /** 回传 artifacts（JSON 字符串；无则 null） */
  artifactsJson: string | null;
  /** 回传文本（无则 null） */
  text: string | null;
  /** 归属 Feature（无则 null） */
  featureId: string | null;
}

export interface TaskWatcherOptions {
  taskId: string;
  /**
   * 读一次**本地**任务行（`queue_state` + 回传落库态）；行不存在返回 `null`。
   * 抛错计一次失败；返回 `null` 亦计一次失败（正常路径「建行先于入队」，缺行为异常态）。
   */
  poll: () => WatchedTaskView | null;
  /** 终态判定（本地回传态：`completed` / `failed` / `input-required` / `blocked`） */
  isSettled: (task: WatchedTaskView) => boolean;
  /**
   * 终态落库（由注入方实现：**复用 `updateTaskState` 路径**写 state + artifactsJson + text）。
   * 抛错**不计入**连续失败、不走 abandoned（终态已确定是既成事实），收尾仍继续。
   */
  persist: (task: WatchedTaskView) => void;
  /**
   * 领取超期判据（**Runner 心跳静默 ≥ `runner.heartbeatTimeoutMs`**；由注入方查 `runners` 表判定）。
   * 缺省视为不超期（无注入 = 纯对账，超期回收交 O7 周期清算兜底）。
   */
  isClaimStale?: (task: WatchedTaskView) => boolean;
  /**
   * 超期兜底动作（**O7 requeue / 事件路径**）：回收该悬挂领取（`requeueStaleTask` + `task.stale`）。
   * **不判 `failed`、不触发 `stop`**（stale ≠ failed）；回收后任务回 `queued`，看护继续对账。
   */
  reclaimStale?: (task: WatchedTaskView) => void;
  /**
   * `queued` 无人领取的**一次性**事件提示（B3；同一次连续未领取只提示一次，被领取后复位）。
   * 仅提示，**不改任务态、不计连续失败**。异常仅记日志。
   */
  onUnclaimed?: (task: WatchedTaskView) => void;
  /**
   * 看护结束回调（v0.3.0，可选）。
   * - 正常终态：`task` 为终态行，`outcome.abandoned=false`（在 `persist` 之后调用）；
   * - 连续失败超限放弃：`task=null`，`outcome.abandoned=true`（**放弃路径也有回调**）。
   * 仅供调度器据此推进 Feature DAG；不得抛错（实现方自行兜底）。
   */
  onSettled?: (task: WatchedTaskView | null, outcome: { abandoned: boolean }) => void;
  pollIntervalMs: number;
  maxConsecutiveFailures: number;
}

/** 进程内看护去重表：同一 taskId 只允许一个看护循环 */
const watching = new Set<string>();

/**
 * 看护子系统 owner 门闩（REQ-v0.4.1-2026-09-15-02）。
 *
 * **只有 core 租约持有者（owner）应启动/轮询看护**；`follower` 置 false 后，
 * `startTaskWatcher` 一律拒绝并 warn（返回 false，不建立轮询循环）。
 * 缺省 `true` = 保持既有行为（未接入 lifecycle 的调用方零改动）。
 */
let watcherEnabled = true;

/**
 * 看护门闩降级键（v0.8.8 O5；`/health` `degraded[]` 的 watcher 停用位）。
 * 此前注释承诺「门闩状态供 `/health`」但从未接线，现经 `degradationSink` 落地。
 */
export const TASK_WATCHER_DEGRADED_KEY = "task-watcher.disabled";

/** 降级登记表 sink（装配点由 index 注入一次；未注入 ⇒ 门闩变更不外报，保持旧行为） */
let degradationSink: DegradationSink | null = null;

/** 注入降级登记表 sink（`bridge/index.ts` 常驻 http 启动时调用） */
export function setTaskWatcherDegradationSink(sink: DegradationSink): void {
  degradationSink = sink;
}

/** 设置 owner 门闩（lifecycle 按 core 租约 role 调用；O5 起同步登记 /health 降级位） */
export function setTaskWatcherEnabled(enabled: boolean): void {
  watcherEnabled = enabled;
  if (degradationSink === null) return;
  if (enabled) {
    degradationSink.clear(TASK_WATCHER_DEGRADED_KEY);
  } else {
    degradationSink.mark(
      TASK_WATCHER_DEGRADED_KEY,
      "看护 owner 门闩停用（当前非 core 租约持有者 / follower）",
    );
  }
}

/** 当前门闩状态（供 /health 降级位 / 单测断言） */
export function isTaskWatcherEnabled(): boolean {
  return watcherEnabled;
}

/** 排空结果 */
export interface WatcherDrainResult {
  /** 是否已排空（`false` = 到宽限上限仍有在飞看护） */
  drained: boolean;
  /** 剩余在飞看护数 */
  remaining: number;
  /** 实际等待毫秒数 */
  waitedMs: number;
}

const DRAIN_POLL_MS = 25;

function drainSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 停机排空：等待全部在飞看护循环自然结束（各自 poll 到终态 / 放弃）或达宽限上限。
 * 只等待，**不取消**本地任务（对齐 §2.5 停机语义）。
 */
export async function drainTaskWatchers(
  graceMs: number,
  pollMs: number = DRAIN_POLL_MS,
): Promise<WatcherDrainResult> {
  const startedAt = Date.now();
  for (;;) {
    if (watching.size === 0) {
      return { drained: true, remaining: 0, waitedMs: Date.now() - startedAt };
    }
    const remain = graceMs - (Date.now() - startedAt);
    if (remain <= 0) {
      return { drained: false, remaining: watching.size, waitedMs: Date.now() - startedAt };
    }
    await drainSleep(Math.min(pollMs, remain));
  }
}

/**
 * **stale 的「watched」判据（v0.7.0 A5 重定义）**：由 `queue_state` 判定，不再依赖「进程内是否
 * 有看护循环」。口径（改造文档 §3.1 A5 / B2/B3）：
 * `queued`（待领取）/ `claimed`（已领取；超期者由 O7 清算回收为 `queued`）/ `running` ⇒ **在队**；
 * `settled`（含 NULL 老行归一）⇒ 不在队。
 *
 * 用于 `a2a_tasks` 的 `stale` 判定：在队任务即便本进程无看护循环也**不算 stale**
 * （pull 模型下 leader 可换、看护可重启，任务本身仍在流水线上）。
 */
export function isQueueWatched(queueState: QueueState): boolean {
  return queueState === "queued" || queueState === "claimed" || queueState === "running";
}

/** 按本地任务行判定「是否在队 / 被看护」（读库；读失败 / 无行 ⇒ false） */
export function isTaskWatched(taskId: string): boolean {
  let task: QueuedTaskRecord | null;
  try {
    task = getQueuedTask(taskId);
  } catch (err) {
    console.error(`[a2a-bridge] 看护判据读取本地任务行失败（${taskId}）：${toMessage(err)}`);
    return false;
  }
  return task !== null && isQueueWatched(task.queueState);
}

/**
 * 看护循环休眠（轮询对账节奏）：**unref** —— 看护是后台维护循环（B3 下 `queued` 任务可长期
 * 驻留），**不得独撑事件循环** —— 常驻由 http listener / MCP transport 持有；单测 / 停机
 * 不被拖住。与 runner 心跳清算循环的 `sweepTimer.unref()` 同一纪律。
 */
function watchSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** 安全触发 onSettled：回调异常仅记日志，绝不打断看护收尾 */
function safeOnSettled(
  options: TaskWatcherOptions,
  task: WatchedTaskView | null,
  outcome: { abandoned: boolean },
): void {
  if (options.onSettled === undefined) return;
  try {
    options.onSettled(task, outcome);
  } catch (err) {
    console.error(`[a2a-bridge] 后台看护 ${options.taskId} onSettled 回调异常：${toMessage(err)}`);
  }
}

/** 启动后台看护（fire-and-forget）；同 taskId 已有看护时返回 false（去重） */
export function startTaskWatcher(options: TaskWatcherOptions): boolean {
  if (!watcherEnabled) {
    bridgeLog.warn(
      "a2a-bridge",
      `非 core 租约持有者（follower）：拒绝启动后台看护 ${options.taskId}`,
    );
    return false;
  }
  if (watching.has(options.taskId)) return false;
  watching.add(options.taskId);
  void watchLoop(options).finally(() => {
    watching.delete(options.taskId);
  });
  return true;
}

/**
 * 看护主循环：周期读本地行对账。
 *
 * 分支（v0.7.0 A5）：
 * - 读到 `null` / 抛错 ⇒ 计一次连续失败（达上限放弃）；
 * - 命中终态 ⇒ `persist` + `onSettled(abandoned=false)`，结束；
 * - `queued` ⇒ B3：**不判失败、不计连续失败**，一次性 `onUnclaimed` 提示后继续等；
 * - `claimed`/`running` 且 `isClaimStale` ⇒ 调 `reclaimStale`（O7 requeue / 事件；不判 failed、不 stop）；
 * - 其余 ⇒ 继续下一轮。
 */
async function watchLoop(options: TaskWatcherOptions): Promise<void> {
  const { taskId } = options;
  let consecutiveFailures = 0;
  /** B3：本轮连续「queued 无人领取」是否已提示过（被领取 / 终态后复位） */
  let unclaimedNotified = false;
  while (true) {
    await watchSleep(options.pollIntervalMs);

    let task: WatchedTaskView | null;
    try {
      task = options.poll();
    } catch (err) {
      consecutiveFailures += 1;
      console.error(
        `[a2a-bridge] 后台看护 ${taskId} 本地对账失败（${consecutiveFailures}/${options.maxConsecutiveFailures}）：${toMessage(err)}`,
      );
      if (consecutiveFailures >= options.maxConsecutiveFailures) {
        console.error(`[a2a-bridge] 后台看护 ${taskId} 连续失败超限，放弃看护`);
        safeOnSettled(options, null, { abandoned: true });
        return;
      }
      continue;
    }

    if (task === null) {
      // 行缺失 = 异常态（正常路径「建行先于入队」）；计一次连续失败，防永久空转
      consecutiveFailures += 1;
      console.error(
        `[a2a-bridge] 后台看护 ${taskId} 本地任务行缺失（${consecutiveFailures}/${options.maxConsecutiveFailures}）`,
      );
      if (consecutiveFailures >= options.maxConsecutiveFailures) {
        console.error(`[a2a-bridge] 后台看护 ${taskId} 连续失败超限，放弃看护`);
        safeOnSettled(options, null, { abandoned: true });
        return;
      }
      continue;
    }

    // 成功读到行：任何后续分支都不再算「连续失败」
    consecutiveFailures = 0;

    if (options.isSettled(task)) {
      /**
       * v0.6.1 REQ-05 §2.5（A5-2 / N3）：**`persist` 异常与 `poll` 异常分离分类**。
       * `persist` 失败**不得**走 abandoned、**不得**打断收尾（终态已确定是既成事实）；
       * **已完成终态必须 `persist`（成功或失败）后仍 `safeOnSettled`** —— DAG 续推信号不丢。
       */
      try {
        options.persist(task);
      } catch (err) {
        console.error(
          `[a2a-bridge] 后台看护 ${taskId} 终态落库失败（不影响收尾，仍将回调 onSettled）：${toMessage(err)}`,
        );
      }
      bridgeLog.info("a2a-bridge", `后台看护 ${taskId}：本地任务已终态，看护结束`);
      safeOnSettled(options, task, { abandoned: false });
      return;
    }

    // B3：`queued` 无人领取 —— 不判 failed、不计连续失败，仅一次性事件提示
    if (task.queueState === "queued") {
      if (!unclaimedNotified && options.onUnclaimed !== undefined) {
        try {
          options.onUnclaimed(task);
        } catch (err) {
          console.error(`[a2a-bridge] 后台看护 ${taskId} 未领取提示回调异常：${toMessage(err)}`);
        }
      }
      unclaimedNotified = true;
      continue;
    }
    unclaimedNotified = false;

    // B2：`claimed` / `running` 且领取者心跳超期 ⇒ O7 requeue / 事件路径（stale ≠ failed；不 stop）
    if (
      (task.queueState === "claimed" || task.queueState === "running") &&
      options.isClaimStale !== undefined &&
      options.isClaimStale(task)
    ) {
      try {
        options.reclaimStale?.(task);
      } catch (err) {
        console.error(`[a2a-bridge] 后台看护 ${taskId} 超期回收回调异常：${toMessage(err)}`);
      }
    }
  }
}
