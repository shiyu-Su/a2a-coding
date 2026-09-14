/**
 * 后台看护（REQ-v0.1.1-2026-09-13-01）。
 *
 * 对未终态任务循环「续约 + 轮询」直至终态，settle 后由注入的 persist 回调落库。
 * 由 handleCall 在同步预算（SYNC_BUDGET_MS）到点时以 void 启动，不阻塞返回：
 * 无论调用方是否回来轮询，结果最终必落本地库。
 *
 * - 进程内按 taskId 去重：同一任务的看护只启动一次；
 * - 单次 poll / renew 失败仅记日志并继续；连续 poll 失败达上限后放弃（防永久故障空转）；
 * - 生命周期随桥进程：桥退出即终止（需求确认单边界）。
 */
import type { Task } from "@a2a-js/sdk";

/** 连续 poll 失败上限：达到后放弃看护（防永久性故障导致无限空转） */
export const WATCHER_MAX_CONSECUTIVE_FAILURES = 30;

export interface TaskWatcherOptions {
  taskId: string;
  /** 轮询一次远端任务态；抛错计一次失败 */
  poll: () => Promise<Task>;
  /** 租约续约（re-ensure）；失败仅记日志，不打断看护 */
  renew: () => Promise<void>;
  /** 终态判定（completed / failed / input-required / canceled） */
  isSettled: (task: Task) => boolean;
  /** 终态落库（由注入方实现：state + artifactsJson + text） */
  persist: (task: Task) => void;
  /**
   * 看护结束回调（v0.3.0，可选）。
   * - 正常终态：`task` 为终态任务，`outcome.abandoned=false`（在 `persist` 之后调用）；
   * - 连续失败超限放弃：`task=null`，`outcome.abandoned=true`（**放弃路径也有回调**）。
   * 仅供调度器据此推进 Feature DAG 或置 `failed`；不得抛错（实现方自行兜底）。
   */
  onSettled?: (task: Task | null, outcome: { abandoned: boolean }) => void;
  /**
   * 可选：订阅 worker 推送唤醒（v0.4.0 §2.6，缺省 false = 纯轮询，行为同现状）。
   * 开启后，`notifyTaskPush(taskId)` 会打断当前休眠、令看护**立即** poll 一次（推送优先）；
   * 周期性轮询（对账兜底）保持不变。
   */
  subscribePush?: boolean;
  pollIntervalMs: number;
  renewIntervalMs: number;
  maxConsecutiveFailures: number;
}

/** 进程内看护去重表：同一 taskId 只允许一个看护循环 */
const watching = new Set<string>();

/** 推送唤醒订阅表：看护 taskId → 唤醒器集合（仅 `subscribePush=true` 的看护注册） */
const pushWakeups = new Map<string, Set<() => void>>();

/**
 * 推送唤醒（v0.4.0）：通知该 taskId 的看护立即 poll（推送优先）。
 * 无看护订阅时返回 false（调用方据此忽略，轮询对账仍兜底）。实现方不得抛错。
 */
export function notifyTaskPush(taskId: string): boolean {
  const wakeups = pushWakeups.get(taskId);
  if (wakeups === undefined || wakeups.size === 0) return false;
  for (const wake of wakeups) {
    try {
      wake();
    } catch (err) {
      console.error(`[a2a-bridge] 后台看护 ${taskId} 推送唤醒异常：${toMessage(err)}`);
    }
  }
  return true;
}

/** 该 taskId 当前是否有在飞的后台看护（供 a2a_tasks 判定 working 任务是否 stale） */
export function isTaskWatched(taskId: string): boolean {
  return watching.has(taskId);
}

/**
 * 可被推送唤醒打断的休眠：到时 / 收到推送均 resolve。
 * 未订阅推送时（`state.wake` 恒为 null）与普通 `sleep` 等价。
 */
function sleepOrPush(ms: number, state: { wake: (() => void) | null }): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.wake = null;
      resolve();
    }, ms);
    state.wake = () => {
      clearTimeout(timer);
      state.wake = null;
      resolve();
    };
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
  task: Task | null,
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
  if (watching.has(options.taskId)) return false;
  watching.add(options.taskId);
  void watchLoop(options).finally(() => {
    watching.delete(options.taskId);
  });
  return true;
}

async function watchLoop(options: TaskWatcherOptions): Promise<void> {
  const { taskId } = options;
  let consecutiveFailures = 0;
  let lastRenewedAt = Date.now();
  // 推送唤醒订阅（可选）：命中时打断休眠，令本轮立即 poll；轮询对账兜底不变。
  const pushState: { wake: (() => void) | null; pending: boolean } = {
    wake: null,
    pending: false,
  };
  const onPush = (): void => {
    pushState.pending = true;
    pushState.wake?.();
  };
  if (options.subscribePush === true) {
    const set = pushWakeups.get(taskId) ?? new Set<() => void>();
    set.add(onPush);
    pushWakeups.set(taskId, set);
  }
  try {
    while (true) {
      // 推送已到（含 poll 期间到达）：跳过休眠立即对账；否则按轮询间隔休眠
      if (!pushState.pending) {
        await sleepOrPush(options.pollIntervalMs, pushState);
      }
      pushState.pending = false;
      try {
        const task = await options.poll();
        consecutiveFailures = 0;
        if (options.isSettled(task)) {
          options.persist(task);
          console.log(`[a2a-bridge] 后台看护 ${taskId}：任务已终态，看护结束`);
          safeOnSettled(options, task, { abandoned: false });
          return;
        }
      } catch (err) {
        consecutiveFailures += 1;
        console.error(
          `[a2a-bridge] 后台看护 ${taskId} 轮询失败（${consecutiveFailures}/${options.maxConsecutiveFailures}）：${toMessage(err)}`,
        );
        if (consecutiveFailures >= options.maxConsecutiveFailures) {
          console.error(`[a2a-bridge] 后台看护 ${taskId} 连续失败超限，放弃看护`);
          safeOnSettled(options, null, { abandoned: true });
          return;
        }
      }
      if (Date.now() - lastRenewedAt >= options.renewIntervalMs) {
        try {
          await options.renew();
        } catch (err) {
          // 续约失败不打断看护：launcher 侧空闲计时最多按原策略回收
          console.error(`[a2a-bridge] 后台看护 ${taskId} 续约失败：${toMessage(err)}`);
        }
        lastRenewedAt = Date.now();
      }
    }
  } finally {
    if (options.subscribePush === true) {
      const set = pushWakeups.get(taskId);
      if (set !== undefined) {
        set.delete(onPush);
        if (set.size === 0) pushWakeups.delete(taskId);
      }
    }
  }
}
