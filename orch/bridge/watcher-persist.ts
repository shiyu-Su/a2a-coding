/**
 * v0.11.0 O5（修假完成-provider错误结算 · orch 兜底）：本地看护命中终态的 `persist` 实现。
 *
 * 从 `bridge/index.ts` 抽出为独立导出口（沿用 `task-lookup.ts` / `stage-settle.ts` 先例：
 * 把进程入口模块的判据逻辑外移，使单测可直驱、无需整座拉起 `index.ts`）。
 *
 * **写前翻态**（与 O3 `bridge/runner.ts` 的 `/runner/result` 支同口径）：命中的 `completed` 行
 * 若正文 = provider 错误短回执（`detectProviderFailureReceipt` 命中）⇒ 判定在 `updateTaskState`
 * **之前**完成，据此改判 `failed` 落库（`text` 原文逐字保留、不改其它字段），再按既有写口
 * `setTaskFailureKind` 落 `failure_kind='provider'`（该行此刻已 `failed`）。
 *
 * 边界（改造文档 §3.2 / §7 宿主钉死分工：provider 识别权只归 machine，orch 仅兜底 completed）：
 * - **只兜 `completed` 支**——machine 自报 `failed` 及其 `failureKind` 一律不动（快照非 `completed`
 *   即 `providerReceipt=null`，走原 `updateTaskState`，不二次分类、不回写）；
 * - `poll → persist` 全程同步（`node:sqlite` 写为同步），无 `await` 让出 ⇒ 快照 `completed` 即写时
 *   库态，CAS（`WHERE state=<原读态>`）必然命中，不存在并发改写后被翻态支覆写 machine 分类之虞；
 * - `setTaskFailureKind` 只在该行 `state='failed'` 才写（其自身 `WHERE`），与翻态支天然同门。
 */
import { setTaskFailureKind, updateTaskState } from "../session/store.js";
import { bridgeLog } from "./bridge-log.js";
import { detectProviderFailureReceipt } from "./provider-receipt.js";
import type { WatchedTaskView } from "./task-watcher.js";

/** 看护命中终态落库（`startLocalTaskWatcher` 的 `persist` 注入体）。 */
export function persistWatchedTaskTerminal(task: WatchedTaskView): void {
  const providerReceipt =
    task.state === "completed" && typeof task.text === "string"
      ? detectProviderFailureReceipt(task.text)
      : null;
  const nextState = providerReceipt !== null ? "failed" : task.state;
  // 复用 updateTaskState 路径（CAS；已终态行不覆盖、不重复写 `task.settled` 事件）
  updateTaskState(task.taskId, nextState, task.artifactsJson, task.text);
  if (providerReceipt !== null) {
    bridgeLog.warn(
      "a2a-bridge",
      `看护 completed 命中 provider 错误短回执 ⇒ 写前改判 failed（taskId=${task.taskId} marker=${providerReceipt.marker} snippet=${providerReceipt.snippet}）`,
    );
    setTaskFailureKind(task.taskId, "provider");
  }
}
