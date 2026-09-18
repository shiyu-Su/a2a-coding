/**
 * 任务 id 双向解析（v0.6.1 REQ-05 §2.5 白捡 / A5-5）。
 *
 * 背景：Feature 节点的**本地 id**（`TaskRecord.taskId`，orch 分配）与**远端 id**
 * （`remoteTaskId`，A2A `tasks/*` 使用）**不同**；独立单任务二者相同。
 * `a2a_task_status` / `a2a_cancel` / 推送回写都必须在两套 id 之间解析，且**口径唯一**
 * （改造文档 §2.3：`a2a_cancel` 的 id 解析**唯一事实源 = orch**）。
 *
 * 本模块是该解析的**单一落点**（从 `index.ts` 抽出，避免进程入口模块被单测整座拉起）：
 * - {@link registerRemoteTask}：派发回填时登记 `远端 id → 本地 id`（进程内映射）；
 * - {@link resolveLocalTaskId}：**先按本地 id**，MISS 时按远端映射推查（推送回写用）；
 * - {@link resolveTaskLookup}：在上一者基础上**同时给出「远端调用该用哪个 id」**（A5-5 修复点）。
 *
 * ⚠️ 映射为**进程内**（桥重启后靠轮询对账兜底）；**淘汰 / 清理不在本次范围**（B9 归未来，
 * 本项只修「反查」）。映射只增不减是本版**有意保留**的已知局限。
 */
import { getTask } from "../session/store.js";
import type { TaskRecord } from "../types.js";

/** `远端 A2A 任务 id → 本地任务 id`（进程内；Feature 节点派发成功后登记） */
const remoteTaskIndex = new Map<string, string>();

/** 登记远端 id → 本地 id 映射（派发回填时调用；同键重复登记以后写为准） */
export function registerRemoteTask(remoteTaskId: string, localTaskId: string): void {
  remoteTaskIndex.set(remoteTaskId, localTaskId);
}

/**
 * 由「远端 id 或本地 id」定位**本地** id：
 * 先按本地 id 直查，MISS 时按远端映射反查；均不命中返回 `null`。
 */
export function resolveLocalTaskId(remoteOrLocalId: string): string | null {
  if (getTask(remoteOrLocalId) !== null) return remoteOrLocalId;
  return remoteTaskIndex.get(remoteOrLocalId) ?? null;
}

/** {@link resolveTaskLookup} 的结果：本地记录 + **远端调用应使用的 id** */
export interface TaskLookup {
  record: TaskRecord;
  /**
   * 远端 A2A 调用（`tasks/get` / `tasks/cancel`）应使用的任务 id：
   * - 本地 id 命中 ⇒ `record.remoteTaskId ?? taskId`（Feature 节点用回填的远端 id；
   *   独立单任务二者相同；未派发节点退回入参）；
   * - 远端 id 反查命中 ⇒ **入参本身**即远端 id。
   */
  remoteId: string;
}

/**
 * **A5-5 反查**：任务 id 双向解析，返回本地记录 + 远端调用 id。
 *
 * - **先按本地 id**（`getTask`）：命中即返回（`remoteId` 取 `remoteTaskId ?? taskId`）；
 * - **MISS 时按远端映射推查**（`resolveLocalTaskId`）：命中即返回（`remoteId` = 入参）；
 * - 均不命中 ⇒ `null`（调用方按 `task_not_found` 结构化失败）。
 */
export function resolveTaskLookup(taskId: string): TaskLookup | null {
  const local = getTask(taskId);
  if (local !== null) {
    return { record: local, remoteId: local.remoteTaskId ?? taskId };
  }
  const mappedLocalId = remoteTaskIndex.get(taskId);
  if (mappedLocalId !== undefined) {
    const record = getTask(mappedLocalId);
    if (record !== null) return { record, remoteId: taskId };
  }
  return null;
}
