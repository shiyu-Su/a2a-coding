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
  appendEvent,
  getFeature,
  getTask,
  listFeatureTasks,
  listFeatures,
  markTaskExhausted,
  markTaskFailureKind,
  rearmForRetry,
  setTaskLastPollAt,
  setTaskNotBefore,
  updateFeatureState,
  updateTaskState,
} from "../session/store.js";
import {
  allowedTransitions,
  canTransition,
  isTerminalFeatureState,
} from "../feature/state-machine.js";
import { bridgeLog } from "./bridge-log.js";
import type { CoreRole } from "../runtime/core-lease.js";
import type { FailureKind, FeatureRecord, TaskRecord, TaskState } from "../types.js";

/** 桥重启后对账在飞任务时写入的结果文本（对齐 wrapper `failed(interrupted)` 语义） */
export const FEATURE_INTERRUPTED_TEXT =
  "任务因桥进程重启而中断（interrupted），未产出终态；请重新发起或重试。";

/** 看护放弃（连续失败超限）时写入的结果文本 */
export const FEATURE_ABANDONED_TEXT =
  "任务后台看护连续失败超限（abandoned），任务状态未知；请重新发起或重试。";

/**
 * **取证节点角色标记**（v0.4.1 §2.5）：显式写入取证节点消息，供调度器识别该节点并
 * ① 走「取证 settle → 决策」分支、② 从 `infra`-取证分支**豁免**（防「取证套取证」死循环）。
 *
 * 选择「消息标记」而非「store 角色列」的理由：无需改 schema（本节点不得动 `store.ts`），
 * 且**随消息持久化** ⇒ 桥重启后仍可识别（内存态标记会丢）。
 */
export const EVIDENCE_NODE_MARKER = "【取证节点 · 只读】";

/** 给取证节点消息打角色标记（O4 登记取证节点时用） */
export function markEvidenceMessage(body: string): string {
  return `${EVIDENCE_NODE_MARKER}\n${body}`;
}

/**
 * 取证节点判定（§2.5）：消息（`dispatchMessage`，回退 `prompt`）带角色标记即取证节点。
 * **只读、纯函数**。
 */
export function isEvidenceNode(
  node: Pick<TaskRecord, "dispatchMessage" | "prompt">,
): boolean {
  const text = node.dispatchMessage ?? node.prompt ?? "";
  return text.includes(EVIDENCE_NODE_MARKER);
}

/** 取证节点结构化结论（§2.5；O4 从 `artifacts` 表解析后注入） */
export interface EvidenceResult {
  /** 软校验 `stable = ① 无在飞 turn（排除自身） AND ② git 静默窗无变化` */
  stable: boolean;
  /** 已改集 */
  d: string[];
  /** 未改集 */
  r: string[];
  /** 门禁是否通过 */
  gatesOk: boolean;
}

/** 取证 settle 后的决策（§2.3） */
export type EvidenceDecision =
  | { kind: "needs_input"; reason: string }
  /** 条件重试：同 `contextId` 续一次（`rearmForRetry`，`retry_count` 由 store 自增） */
  | { kind: "retry" }
  /** R 空且门禁绿：**不拦**，让既有 `reduceConvergence` 收口（推进 `integrating`） */
  | { kind: "settle" };

/**
 * 「取证 settle → 决策」判定（§2.3 决策图，**纯函数**，便于单测）：
 * 1. 无证据（`resolveEvidence` 返回 null）⇒ 交人；
 * 2. `stable === false` ⇒ 交人（不拍板、不重试）；
 * 3. `d` 空 ⇒ 交人（不是"切得太大"，**不自动重做**）；
 * 4. `r` 空 且 门禁绿 ⇒ `settle`（按成功收口，仍须跑验收/回归）；
 * 5. `d` 非空 且 `retryCount < MAX_RETRY` ⇒ `retry`；
 * 6. 否则（重试用尽）⇒ 交人（+ 宿主据 evidence 的 R 挂拆解节点）。
 */
export function decideEvidenceOutcome(
  evidence: EvidenceResult | null,
  retryCount: number,
  maxRetry: number = MAX_RETRY,
): EvidenceDecision {
  if (evidence === null) {
    return { kind: "needs_input", reason: "取证无结构化结果" };
  }
  if (!evidence.stable) {
    return { kind: "needs_input", reason: "工作区不稳定（stable=false，可能有写者）" };
  }
  if (evidence.d.length === 0) {
    return { kind: "needs_input", reason: "无已改集（D 空），不自动重做" };
  }
  if (evidence.r.length === 0 && evidence.gatesOk) {
    return { kind: "settle" };
  }
  if (retryCount < maxRetry) {
    return { kind: "retry" };
  }
  return { kind: "needs_input", reason: `重试已用尽（retryCount=${retryCount}）` };
}

/**
 * 条件重试的「**中性固定模板**」（§2.4，逐字对齐文档）：
 * 追加在原 `dispatch_message` 之后、**不替换**原内容。
 * 「中性」= ① 不含决策内容（不写"只做 X 片"）② 不动 scope（原文照附）③ 只约束行为方式。
 */
export function buildRetryMessage(base: string): string {
  return [
    "【自动重试 · 第 1/1 次 · 同会话续接】",
    "上一次执行在约 600s 时被客户端超时中断；这并不意味着你的改动已丢失。",
    "请按以下方式继续（不要重头再来）：",
    "1. 先核对当前工作区/会话状态（如 git status / 已改文件 / 门禁结果）；",
    "2. 只把尚未完成的部分做完；已完成的部分不要重写；",
    "3. 若接近时间上限，先把改动落盘并给出简短报告（已改哪些文件 / 门禁是否通过 / 还差什么）；",
    "4. 原任务内容如下（未变更）：",
    "────",
    base,
    "────",
  ].join("\n");
}

/** 调度循环间隔（可配，默认 1500ms） */
export const FEATURE_TICK_MS = readPositiveIntEnv("FEATURE_TICK_MS", 1_500);

/**
 * 条件重试上限（v0.4.1 §2.4，N=1：只同 `contextId` 续一次）。
 * **无需 env** —— 这是「防死循环」承重件，不允许按环境放大：
 * 倒置为「先取证 → 条件重试」后，去掉上限会 `fail → 取证 → D 非空 → re-arm → fail → …` 死循环。
 * 判据：`retryCount < MAX_RETRY` 才允许 `rearmForRetry`。
 */
export const MAX_RETRY = 1;

/** 「等回收门」上界（ms，可配，默认 10min）：到点该 project 仍非 offline ⇒ 转软校验兜底 */
export const EVIDENCE_WAIT_MAX_MS = readPositiveIntEnv("EVIDENCE_WAIT_MAX_MS", 600_000);

/** 「等回收门」轮询 `GET /projects` 的间隔（ms，可配，默认 5s） */
export const EVIDENCE_POLL_MS = readPositiveIntEnv("EVIDENCE_POLL_MS", 5_000);

/**
 * 「等回收门」**debounce** 连续达标次数（v10 §2.5）。
 * 依据：Launcher `stop()` **先删条目、后杀进程** ⇒ `/projects` 报 `offline` **早于**进程真死；
 * POSIX 优雅期上界 = 5s 优雅期 + 10s 兜底 ⇒ **2 次、间隔 ≥ `EVIDENCE_POLL_MS`（5s）**
 * 大致覆盖该上界，避免"报告已停、其实仍在写"的窗口。
 */
export const EVIDENCE_READY_STREAK = 2;

/** 「等回收门」转折点事件的 kind（**只写转折点**，严禁每次轮询都写） */
export const EVIDENCE_EVENT_KIND = "task.evidence";

/**
 * 条件重试**已发生**的事件 kind（v0.4.1 §2.3 / §4.1.13 可观测）。
 * 宿主经 `a2a_events` 能**直接看到重试**，不必再靠 `retry_count` 从 0→1 查库推断。
 * **只在 `handleEvidenceSettled` 的 retry 分支写一条**（settle / needs_input / fail 均不写）。
 */
export const EVENT_TASK_RETRY = "task.retry";

/**
 * **状态流转被跳过**的事件 kind（v0.5.1 D1）。
 *
 * 触发点 = `needsInputFeature` 的**三处静默 `return false`**（`feature_not_found` /
 * `already_needs_input` / `illegal_transition`，其中 `current === null` 与终态已拆行 ⇒ 五值
 * 穷举）与 `notifyTaskSettled` 的 Feature 早退（`early_return_task_settled`）⇒ 「静默死信」
 * 从零留痕变为**必有痕**。
 *
 * ⚠️ **不变量：态没变** ⇒ `events.state` 列**必须写 `null`**（该列语义 = 「**实际**流转后的态」；
 * 写目标态会与「态没变」矛盾，且按 `state` 过滤的消费者会**误判 Feature 已交人**）。目标态放
 * `payload.to`。
 * ⚠️ 与 `feature.state`（由 `store.updateFeatureState` 在 CAS 成功且**态变化**时自动写 = **态确实
 * 变了**）互补且互斥 ⇒ **跳过路径不得写 `feature.state`**。
 * ⚠️ 常量随**发射模块**落此文件（先例 `EVIDENCE_EVENT_KIND` / `EVENT_TASK_RETRY`）⇒ `store.ts`
 * 零改动。
 */
export const EVENT_FEATURE_TRANSITION_SKIPPED = "feature.transition_skipped";

/**
 * **「出口即清」丢弃留痕**的事件 kind（v0.5.1 ⑥b）。
 *
 * Feature 因「任务 `input-required`」（`notifyTaskSettled`）、「收敛交人」（`reduceConvergence`）
 * 或「兜底扫描交人」（`advanceExecuting`，v0.5.1 N1′）而离开 `executing` 时，`pendingEvidence` 中的
 * **未决取证流**被一并丢弃 ⇒ 必须留痕（否则一组已登记的待决策事实会**静默消失**）。
 *
 * ⚠️ **独立 kind，不得复用 {@link EVENT_FEATURE_TRANSITION_SKIPPED}**：后者不变量是「态没变」，
 * 而本事件两个触发点的态**确实变了**（已交人）—— 塞进去会**击穿**「有 `feature.state` ⇒ 态真变了」
 * 的对偶。
 * ⚠️ **仅在「条目实际存在」时**写一条（`pendingEvidence.has(featureId)` 为真）；`taskId` = 被丢弃
 * 条目里的 `failedTaskId`；`events.state` 列同样写 `null`。
 * ⚠️ 留痕**不受** `needsInputFeature` 返回值影响（即便它因已 `needs_input` 而 `return false`，
 * 丢弃事实仍须留痕）。
 * ⚠️ 「取证节点失败」（`notifyTaskSettled` 的 `failed` + 取证分支）与「取证派发失败」两处「交人」
 * **本身就是决策本体**、`feature.state` 已留痕 ⇒ **不写**本事件。
 */
export const EVENT_PENDING_EVIDENCE_DISCARDED = "feature.pending_evidence_discarded";

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
  /** 条件重试上限（缺省 `MAX_RETRY` = 1）；单测可注入 */
  maxRetry?: number;
  /** 「等回收门」上界（ms；缺省 `EVIDENCE_WAIT_MAX_MS` = 10min）；单测可注入以免真等 */
  evidenceWaitMaxMs?: number;
  /** 「等回收门」轮询间隔（ms；缺省 `EVIDENCE_POLL_MS` = 5s）；单测可注入 */
  evidencePollMs?: number;
  /**
   * **登记取证节点**（§2.3 ②，IO 由 `index.ts`/O4 注入）：`infra` 失败且失败节点**已中性化**后调用。
   * 调度器只负责「**先中性化、后登记**」的顺序与调用时机，节点怎么建、消息怎么自包含由注入方决定
   * （消息须经 `markEvidenceMessage` 打角色标记）。**不提供 = 本版不启用取证流**（退化为旧行为）。
   */
  registerEvidenceNode?: (featureId: string, failedTaskId: string) => void;
  /**
   * **解析取证结论**（§2.5，IO 由 O4 从 `artifacts` 表实现）：取证节点 settle 后调用。
   * 返回 `null` = 未取到结构化证据 ⇒ 决策为「交人」。
   */
  resolveEvidence?: (evidenceTaskId: string) => EvidenceResult | null;
  /**
   * **探测目标 project 是否已空闲回收**（§2.5 硬路径，IO 由 O4 用 `listMachineProjects` 实现）：
   * `ready = true` 表示该 project **`status !== "online"`**（已 `stop()`）⇒ 结构性无写者。
   * `reason` 表达 `offline` / `503` / `starting` / 不可达等（**一律按"未就绪"处理**，仅用于留痕）。
   *
   * **同步返回**：等回收门由 tick 驱动、**绝不在 `dispatch` 内 `await`**（否则 10min 的门会占满
   * `dispatching`/`inFlightNodes` ⇒ 阻塞 `drain()` 与同 Feature 其它节点）。
   * ⇒ O4 须提供**非阻塞快照**实现（HTTP 轮询由 O4 自己的循环维护快照，本回调只读快照）。
   */
  probeProjectReady?: (projectId: string) => { ready: boolean; reason: string };
}

/**
 * `start()` 选项（REQ-v0.4.1-2026-09-15-02）。
 * - `unref`：是否对定时器 `unref()`（不持有进程）。**缺省 true** = 与旧行为一致
 *   （stdio 桥随宿主退出）；常驻模式由 lifecycle 传 `false`（HTTP listener 持有进程）。
 *   **模式不硬编码进 scheduler**，由调用方按 `mode` 决定。
 * - `role`：core 租约角色门闩（**第二道防线**）。缺省 / `"owner"` 正常启动；
 *   `"follower"` 直接拒绝启动并 warn（不跑后台循环），使"接线写错"也无法双调度。
 */
export interface FeatureSchedulerStartOptions {
  unref?: boolean;
  role?: CoreRole;
}

/** 停机排空轮询间隔（ms） */
const DRAIN_POLL_MS = 25;

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

/**
 * `infra` 失败文本白名单（**小写子串**匹配；判据 = 错误码 + 文本，本版只有文本可用）。
 * 覆盖：wrapper 600s 客户端超时 / 桥重启 interrupted / 看护放弃 abandoned / 库锁 / 网络类。
 */
const INFRA_TEXT_PATTERNS: readonly string[] = [
  "prompt timeout after", // 必须含：wrapper `timeouts.prompt`（600s，外部包 a2a-opencode）
  "interrupted", // 桥重启：FEATURE_INTERRUPTED_TEXT / wrapper failed(interrupted)
  "abandoned", // 看护连续失败超限
  "database is locked", // SQLite 写锁
  "fetch failed",
  "failed to fetch",
  "econnrefused",
  "econnreset",
  "etimedout",
  "enotfound",
  "eai_again",
  "socket hang up",
];

/**
 * 失败分类（v0.4.1 §2.2）：`infra`（可取证 + 条件重试）/ `task`（照旧传播，不重试）。
 *
 * **未知文本一律安全降级为 `task`**（不重试）—— 宁可少自愈，不可对任务级失败做无意义重试。
 * `FEATURE_ABANDONED_TEXT` 单独整串比对（不依赖其文案里恰好含 "abandoned"）。
 */
export function classifyFailure(text: string | null | undefined): FailureKind {
  if (text === null || text === undefined) return "task";
  if (text.includes(FEATURE_ABANDONED_TEXT)) return "infra";
  const lower = text.toLowerCase();
  for (const pattern of INFRA_TEXT_PATTERNS) {
    if (lower.includes(pattern)) return "infra";
  }
  return "task";
}

/**
 * 中性化判定（v0.4.1 §2.6）：`exhausted` 节点已被「取证流」接管 ⇒ **在下游判定中视作 completed**。
 * 注意 `state` **不被改写**（仍是事实上的 `failed`），故所有「读 `state` 做判断」的位置都要过这一层。
 */
export function isNeutered(node: Pick<TaskRecord, "exhausted">): boolean {
  return node.exhausted;
}

/**
 * **判定用**：该节点的失败事实已被中性化 ⇒ 在下游判定中「**视作 completed**」。
 *
 * 为何要带 `state === "failed"`：中性化标记**不会**被条件重试清掉（`rearmForRetry` 只写
 * state / retry_count），故**已 re-arm 的节点仍是 `exhausted` 但处于 `working`**。它此刻是
 * **活跃节点**（重试在飞/待派），而非"已终结的失败事实" ⇒ 既不可视作 completed（否则
 * `all_completed` 会在重试尚未跑完时就成立，Feature 直接 `integrating`），也不可参与
 * "失败已中性化"的过滤。
 */
export function isNeuteredSettled(
  node: Pick<TaskRecord, "exhausted" | "state">,
): boolean {
  return node.exhausted && node.state === "failed";
}

/**
 * **失败豁免判定**（v0.5.1 D2）：该节点**已落定的失败事实**可否在收敛判定 / 失败传播中豁免。
 *
 * 两条臂：① 已中性化（`exhausted` 的失败节点，由取证流接管）；② 取证节点自身失败
 * （失败出路是**交人** `needs_input`，不是连坐整个 Feature）。
 *
 * ⚠️ **证据臂必须带 `state === "failed"`**（与 `isNeuteredSettled` 同因）：re-arm 后节点仍
 * `exhausted` 但已回 `working`，此刻是**活跃节点**。不收窄 ⇒ `every()` 会把 `working` /
 * `blocked` 的取证节点判为「已完成」⇒ `all_completed` **提前成立**，且 `blocked` 取证节点
 * **掉出**兜底扫描（扫描只认 `failed`）。
 *
 * ⚠️ 与 `isNeutered`（判「节点**是否仍处于中性化状态**」）**不可合并**：本谓词判的是
 * 「**已落定的失败事实可否豁免**」（要求 `state === "failed"`），二者在「已 re-arm 节点」上
 * 取值**相反**。
 */
export function isExemptFromFailure(
  node: Pick<TaskRecord, "exhausted" | "state" | "dispatchMessage" | "prompt">,
): boolean {
  return isNeuteredSettled(node) || (isEvidenceNode(node) && node.state === "failed");
}

/**
 * 可派时间门判定（v0.4.1 §2.3）：`notBefore` 为 NULL ⇒ 立即可派；否则需 `notBefore <= now`。
 * **无法解析的时间戳按「无门」处理**（不阻塞派发）：该值只由本单元写入（UTC ISO 8601），
 * 出现坏值时宁可派发，也不让一个坏值把 Feature 永久卡在 `executing`。
 */
export function isPastNotBefore(node: TaskRecord, nowMs: number = Date.now()): boolean {
  if (node.notBefore === null) return true;
  const at = Date.parse(node.notBefore);
  return Number.isNaN(at) ? true : at <= nowMs;
}

/**
 * 本地是否已终结（**中性化第 5 处**）：`exhausted` 节点视作终态 ⇒ `a2a_task_status`
 * 不误查远端（远端任务已不可达）。
 *
 * ⚠️ 落点提示：`index.ts:773` 的同名私有函数 `isLocalTerminalState(state)` **只吃 state 字符串**、
 * 看不到 `exhausted`；本节点不碰 `index.ts`。当前它**行为上已满足**（`exhausted` 不改写 `state`，
 * 而 `failed` 本就被判为本地终态）；待拥有 `index.ts` 的节点把它改为委托本函数，以消除双份判据。
 */
export function isLocalTerminalTask(node: TaskRecord): boolean {
  return (
    isNeutered(node) ||
    node.state === "completed" ||
    node.state === "failed" ||
    node.state === "input-required" ||
    node.state === "blocked"
  );
}

/** 依赖三态：`completed`（可派发）/ `pending`（前序未完成）/ `upstreamFailed`（上游失败或阻塞） */
export type DepState = "completed" | "pending" | "upstreamFailed";

/**
 * 单节点依赖三态判定。
 * - 任一上游 `failed` / `blocked`（**未被中性化**）→ `upstreamFailed`（不带病派发）；
 * - **中性化（`exhausted`）上游视作 `completed`** ⇒ 下游可继续派发（v0.4.1 第 1 处）；
 * - 否则存在未完成上游 → `pending`；
 * - 全部 completed（含无依赖）→ `completed`。
 */
export function depStateOf(
  node: TaskRecord,
  byId: ReadonlyMap<string, TaskRecord>,
): DepState {
  let pending = false;
  for (const dep of node.dependencies ?? []) {
    const upstream = byId.get(dep);
    if (upstream !== undefined && isNeuteredSettled(upstream)) continue; // 中性化 ⇒ 视作 completed
    const state = upstream?.state;
    if (state === "failed" || state === "blocked") return "upstreamFailed";
    if (state !== "completed") pending = true;
  }
  return pending ? "pending" : "completed";
}

/**
 * 计算**同批可并发派发**的就绪节点集合（同层无依赖节点一并返回）。
 * 就绪 = `working` 且**未被中性化**且尚未派发（`remoteTaskId === null`）且不在在飞标记内、
 * **可派时间门已到**（`not_before`）且依赖全部 completed。
 *
 * `not_before > now` 的节点（v0.4.1 §2.3「登记取证节点后先不派」的**持久化门**）不入选
 * ⇒ 「登记即就绪」不再成立，tick 不会抢在等回收门之前把它派出去。
 */
export function computeReadyNodes(
  nodes: readonly TaskRecord[],
  inFlight?: ReadonlySet<string>,
  nowMs: number = Date.now(),
): TaskRecord[] {
  const byId = new Map(nodes.map((n) => [n.taskId, n]));
  return nodes.filter(
    (n) =>
      n.state === "working" &&
      // 中性化节点不参与派发。**无需 re-arm 例外**：`rearmForRetry` 已顺带清 `exhausted = 0`
      // （re-arm ⇒ 退出中性化）⇒ 重试节点是**普通 working 节点**，自然就绪；
      // `exhausted=1` 恒蕴含 `state='failed'`，不会被本条件选中。
      !isNeutered(n) &&
      n.remoteTaskId === null &&
      !(inFlight?.has(n.taskId) ?? false) &&
      isPastNotBefore(n, nowMs) &&
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
 * 1. 存在 **未被中性化** 的 `failed` / `blocked` → `failed`（Feature 收敛失败，不派发）；
 * 2. 存在 **未被中性化** 的 `input-required` → `needs_input`；
 * 3. 全部 `completed`（**中性化节点视作 completed**）→ `all_completed`；
 * 4. 否则 → `dispatch`（派发全部就绪节点）。
 *
 * ⚠️ 第 1 处与第 3 处**都必须**认中性化（v0.4.1 §2.6）：只改第 1 处而漏第 3 处时，
 * 中性化节点 raw `state` 仍是 `failed` ⇒ `every(completed)` 恒为假 ⇒ 既不 `failed` 也不
 * `integrating`，**Feature 永久卡在 `executing`**（最致命的一处）。
 */
export function reduceConvergence(nodes: readonly TaskRecord[]): Convergence {
  const failed = nodes.filter((n) => n.state === "failed" && !isExemptFromFailure(n)).length;
  const blocked = nodes.filter((n) => n.state === "blocked" && !isExemptFromFailure(n)).length;
  if (failed > 0 || blocked > 0) {
    return {
      kind: "failed",
      reason:
        failed > 0
          ? `存在失败任务（${failed}）`
          : `存在被阻塞任务（${blocked}）`,
    };
  }
  if (nodes.some((n) => n.state === "input-required" && !isNeutered(n))) {
    return { kind: "needs_input", reason: "存在待澄清任务" };
  }
  if (nodes.length > 0 && nodes.every((n) => n.state === "completed" || isExemptFromFailure(n))) {
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
  /** 条件重试上限（`retryCount < maxRetry` 才允许 re-arm；见 `MAX_RETRY`） */
  readonly maxRetry: number;
  /** 「等回收门」上界（ms）；O3 的等回收门循环读此值 */
  readonly evidenceWaitMaxMs: number;
  /** 「等回收门」轮询间隔（ms）；O3 的等回收门循环读此值 */
  readonly evidencePollMs: number;
  /** 登记取证节点（注入；缺省不启用取证流） */
  private readonly registerEvidenceNode?: (featureId: string, failedTaskId: string) => void;
  /** 解析取证结论（注入；缺省视为「无证据」⇒ 交人） */
  private readonly resolveEvidence?: (evidenceTaskId: string) => EvidenceResult | null;
  /** 探测目标 project 是否已空闲回收（注入；缺省视为**未就绪** ⇒ 一直等，直到上界放行） */
  private readonly probeProjectReady?: (projectId: string) => { ready: boolean; reason: string };
  /**
   * Feature → **触发取证的失败节点 + 登记时刻**（§2.3 ①）。
   * 取证节点自身 id 无需在此保存：识别靠**消息角色标记**（`isEvidenceNode`）；重试目标靠本映射。
   * 进程内态（桥重启后靠 `exhausted` + `state='failed'` 的**单一扫描**兜底，见 `resolveRetryTarget`；
   * 上界基线回退到失败节点的 `updated_at`，见 `evidenceWaitedMs`）。
   *
   * ⚠️ **出口即清**（v0.5.0 D5）：`handleEvidenceSettled` 的**全部决策出口**（`retry` / `settle` /
   * 两处「交人」）都必须 `delete(featureId)` —— 「决策已落」与「map 有条目」必须一一对应，
   * 否则硬闸 {@link FeatureScheduler.hasPendingEvidenceDecision} 会在 Feature 回到 `executing` 后
   * 继续拦下 `all_completed` ⇒ **Feature 永久卡在 `executing`（死锁）**。
   * 本版只覆盖 `handleEvidenceSettled` 的四个出口；`needsInputFeature` 的其余调用点
   * （取证节点自身失败 / 派发失败等）不产生 `all_completed` 路径 ⇒ 闸不被触发，留 v0.5.1 收口。
   */
  private readonly pendingEvidence = new Map<
    string,
    { failedTaskId: string; registeredAt: number }
  >();
  /**
   * 取证节点 → **连续"已回收"探测次数**（debounce，v10 §2.5）。
   * 进程内态：桥重启后计数归零 ⇒ 只会**更保守**（多探一轮），可接受（门本身是持久化的）。
   */
  private readonly evidenceReadyStreak = new Map<string, number>();

  constructor(options: FeatureSchedulerOptions) {
    this.dispatch = options.dispatch;
    this.pollIntervalMs = options.pollIntervalMs ?? FEATURE_TICK_MS;
    this.maxRetry = options.maxRetry ?? MAX_RETRY;
    this.evidenceWaitMaxMs = options.evidenceWaitMaxMs ?? EVIDENCE_WAIT_MAX_MS;
    this.evidencePollMs = options.evidencePollMs ?? EVIDENCE_POLL_MS;
    this.registerEvidenceNode = options.registerEvidenceNode;
    this.resolveEvidence = options.resolveEvidence;
    this.probeProjectReady = options.probeProjectReady;
  }

  /**
   * 启动后台循环（幂等）。
   *
   * `role === "follower"` 时**拒绝启动**（第二道防线：只有 core 租约持有者跑调度）——
   * 记 warn 并返回，不设定时器、不立即 tick。
   */
  start(options: FeatureSchedulerStartOptions = {}): void {
    if (options.role === "follower") {
      console.error("[a2a-feature] 非 core 租约持有者（follower）：拒绝启动调度器");
      return;
    }
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    // stdio 模式不因定时器持有进程；常驻模式（unref=false）由 HTTP listener 持有进程
    if (options.unref !== false && typeof this.timer.unref === "function") {
      this.timer.unref();
    }
    void this.tick();
  }

  /** 停止后台循环（幂等） */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 停机排空：等待直到**无在飞派发**（Feature 批门闩 + 节点级在飞标记皆空）或达宽限上限。
   * 返回是否已排空（`false` = 超时仍有在飞）。只等待，**不取消**远端 A2A 任务。
   */
  async drain(graceMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, graceMs);
    while (this.dispatching.size > 0 || this.inFlightNodes.size > 0) {
      const remain = deadline - Date.now();
      if (remain <= 0) return false;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(DRAIN_POLL_MS, remain));
      });
    }
    return true;
  }

  /** 触发一次推进（approve / advance / 任务终态后调用；不阻塞调用方） */
  kick(): void {
    void this.tick();
  }

  /**
   * 任务终态通知（由桥的看护 `onSettled` / 同步派发结果调用）。
   *
   * v0.4.1 三段（§2.2/§2.3）：
   * - `failed` + **取证节点** ⇒ **豁免**：直接 `needs_input`（不重试、不再取证、不 propagate，
   *   否则「取证套取证」无限套娃）；
   * - `failed` + `task` 类 ⇒ **维持现状**（传播 `blocked` → Feature `failed`）；
   * - `failed` + `infra` 类 ⇒ ① `markTaskExhausted` **先中性化** → ② 请求登记取证节点 → **return**
   *   （**不 propagate、不 failFeature、不立即 rearm**；重试与否由取证 settle 后决定）；
   * - `input-required` ⇒ Feature `needs_input`；
   * - `completed` + **取证节点** ⇒ 走「取证 settle → 决策」；其余 `completed` ⇒ 交 tick 判完成。
   */
  notifyTaskSettled(
    featureId: string,
    taskId: string,
    outcome: { state: TaskState; text: string | null },
  ): void {
    const feature = getFeature(featureId);
    if (feature === null || isTerminalFeatureState(feature.state)) {
      // v0.5.1 D1（⑤）：早退留痕 —— `feature === null` 与 Feature 已终态**两种情形共用单 code**
      // （**不拆行**：二者对调用方是同一件事「这个 Feature 不再能承接交人」）。
      // `to` 写 `null`：本处**无单一目标态**（`failed` / `input-required` 本应 `needs_input`，
      // `completed` 本应交给 tick 判 `integrating`）⇒ 意向写进 `detail`，不猜一个假目标态。
      this.logTransitionSkipped({
        site: "notifyTaskSettled.earlyReturn",
        featureId,
        taskId,
        from: feature?.state ?? null,
        to: null,
        code: "early_return_task_settled",
        detail: `任务 ${taskId} settle（${outcome.state}）时 Feature 不可承接（不存在或已终态）`,
      });
      return;
    }
    const node = getTask(taskId);
    const isEvidence = node !== null && isEvidenceNode(node);

    if (outcome.state === "failed") {
      if (isEvidence) {
        // 「出口即清」（v0.5.1 ⑥）：交人 = **决策本体** ⇒ 先无条件清 map（不变量 I1），否则人工
        // 恢复后 D5-C 硬闸会永久拦下 `all_completed` ⇒ Feature 永久卡 `executing`（死锁）。
        // 本处**不写** ⑥b 丢弃事件：决策本体已由 `feature.state` 留痕。
        this.pendingEvidence.delete(feature.featureId);
        this.needsInputFeature(feature, `取证节点 ${taskId} 失败（按 §2.5 豁免直接交人）`);
        return;
      }
      // 分类输入：显式 text 优先；回退**库中文本**（看护放弃路径传 text=null，文案在库）
      const failureText = outcome.text ?? node?.text ?? null;
      const failureKind = classifyFailure(failureText);
      // §4.1.13 可观测：失败原因落库（`task` 与 `infra` 两类都写，便于事后统计）。
      // 注：取证节点在上面已豁免返回 ⇒ 不参与分类，故不写此列（其处置不属 {infra, task} 分类语义）。
      markTaskFailureKind(taskId, failureKind);
      if (failureKind === "infra") {
        // ⚠️ 顺序不可换（§2.3）：**先中性化、后登记** —— 失败节点此刻已在库中为 failed，
        // 若先登记（其 `scheduler.kick()` 会立刻跑 reduceConvergence）Feature 会被判 failed 终态，
        // 之后 registerFeatureNode / advance / approve 全被拒 ⇒ 取证与拍板**永不可达**。
        markTaskExhausted(taskId);
        this.pendingEvidence.set(feature.featureId, {
          failedTaskId: taskId,
          registeredAt: Date.now(),
        });
        this.registerEvidenceNode?.(feature.featureId, taskId);
        return;
      }
      this.propagateFailure(feature, taskId);
      this.failFeature(feature, `任务 ${taskId} 失败`);
      return;
    }
    if (outcome.state === "input-required") {
      // 「出口即清」+ 丢弃留痕（v0.5.1 ⑥ / ⑥b）：顺序 = **先 `delete` → 写事件 → `needsInputFeature`**
      // （对齐 `handleEvidenceSettled` 既有出口）。留痕不受 `needsInputFeature` 返回值影响。
      this.discardPendingEvidence(
        feature.featureId,
        "notifyTaskSettled",
        `任务 ${taskId} 需人工澄清`,
      );
      this.needsInputFeature(feature, `任务 ${taskId} 需人工澄清`);
      return;
    }
    // completed
    if (isEvidence) {
      this.handleEvidenceSettled(feature, taskId);
      return;
    }
    // 其余 completed：由 tick 判定「全部任务终态 → integrating」
    this.kick();
  }

  /**
   * 取证 settle → 决策（§2.3 ④）。判定为纯函数 `decideEvidenceOutcome`，此处只做**存储动作**：
   * `retry` ⇒ `rearmForRetry`（同 ctx，`retry_count` 由 store 自增）；`needs_input` ⇒ 交人；
   * `settle` ⇒ 不拦，`kick()` 让既有 `reduceConvergence` 收口（推进 `integrating`）。
   */
  private handleEvidenceSettled(feature: FeatureRecord, evidenceTaskId: string): void {
    const evidence = this.resolveEvidence?.(evidenceTaskId) ?? null;
    const target = this.resolveRetryTarget(feature.featureId);
    const decision = decideEvidenceOutcome(evidence, target?.retryCount ?? 0, this.maxRetry);

    if (decision.kind === "needs_input") {
      // 「出口即清」：决策已落（交人）⇒ 必须清 map，否则硬闸 `hasPendingEvidenceDecision`
      // 在本 Feature 回到 `executing` 后仍拦下 `all_completed` ⇒ Feature 永久卡死（新造死锁）。
      this.pendingEvidence.delete(feature.featureId);
      this.needsInputFeature(feature, `取证决策：交人（${decision.reason}）`);
      return;
    }
    if (decision.kind === "retry") {
      if (target === null) {
        // 「出口即清」：同上 —— 降级交人同样是**决策已落**的终局出口。
        this.pendingEvidence.delete(feature.featureId);
        this.needsInputFeature(feature, "取证决策：应重试但未定位到失败节点（交人）");
        return;
      }
      const base = target.dispatchMessage ?? target.prompt ?? "";
      rearmForRetry(target.taskId, buildRetryMessage(base));
      // §4.1.13 可观测：**恰好一条** `task.retry`（re-arm 之后写，便于拿到自增后的真实值）。
      // 仅此处写 —— `settle` / `needs_input` / fail 分支都不写（本条不产生"需要 orch 响应"的信号）。
      appendEvent({
        featureId: feature.featureId,
        taskId: target.taskId,
        kind: EVENT_TASK_RETRY,
        state: "working",
        payload: JSON.stringify({
          retryCount: getTask(target.taskId)?.retryCount ?? target.retryCount + 1,
          failureKind: "infra", // 进入本分支的不变量：本次失败已被分类为 infra
        }),
      });
      this.pendingEvidence.delete(feature.featureId);
      this.kick(); // 重派由 tick 按 `not_before` / 依赖判定
      return;
    }
    // settle：按成功收口（仍须宿主跑验收/回归才算真通过）
    this.pendingEvidence.delete(feature.featureId);
    this.kick();
  }

  /**
   * 硬闸谓词（v0.5.0 D5）：是否**存在「待决策取证流」** ⇒ 阻止 `all_completed` 推进 `integrating`。
   *
   * 判定 = ① 本 Feature 有**未清**的 `pendingEvidence` 条目（决策尚未落）**且** ② 节点集内
   * **确实存在取证节点**（`isEvidenceNode`，消息角色标记）。
   *
   * ⚠️ **不得**再加「取证节点**未终态**」：D5 主场景里取证节点**恰恰已是 `completed`**（正因如此
   * 收敛才会提前成立）—— 加上"未终态"正好漏掉要挡的那一例。
   * ⚠️ **不得**用裸 `this.pendingEvidence.has(...)`：`registerEvidenceNode` 缺省未注入时，
   * map 可能有条目却**没有**取证节点（结构性负例，见单测 T4）；裸 `has` 会把该 Feature 误困在
   * `executing`（新造死锁）。
   *
   * 同步、纯读（无 `await`、无副作用），沿用既有纯函数 `isEvidenceNode`（零新 import）。
   */
  private hasPendingEvidenceDecision(
    feature: FeatureRecord,
    nodes: readonly TaskRecord[],
  ): boolean {
    return this.pendingEvidence.has(feature.featureId) && nodes.some((n) => isEvidenceNode(n));
  }

  /**
   * 定位本次取证对应的**失败节点**（重试目标）：优先 {@link pendingEvidence}（进程内映射），
   * 回退「**恰好一个** `exhausted` 且仍 `failed` 的节点」——后者跨桥重启仍有效（标记落库）。
   * 命中 0 个或多个（无法消歧）⇒ 返回 null ⇒ 决策降级为交人（fail-safe，不赌）。
   */
  private resolveRetryTarget(featureId: string): TaskRecord | null {
    const nodes = listFeatureTasks(featureId, { limit: 1000 });
    const byId = new Map(nodes.map((n) => [n.taskId, n]));
    const mapped = this.pendingEvidence.get(featureId);
    if (mapped !== undefined) {
      const hit = byId.get(mapped.failedTaskId);
      if (hit !== undefined && hit.state === "failed") return hit;
    }
    const candidates = nodes.filter((n) => isNeutered(n) && n.state === "failed");
    return candidates.length === 1 ? candidates[0]! : null;
  }

  // ------------------------------------------------------------------
  // 内部：等回收门（§2.3 ③ / §2.5）—— tick 驱动，**绝不在 dispatch 内 await**
  // ------------------------------------------------------------------

  /**
   * 「等回收门」一次推进（**同步、无 `await`**）：对每个**尚未派发**的取证节点探测目标 project
   * 是否已空闲回收；未达标则用**持久化** `not_before` 挡板继续挡住派发。
   *
   * - **节流**：距 `last_poll_at` 不足 `evidencePollMs` ⇒ 只续挡板、**不发探测**（tick 为 1.5s）；
   * - **debounce**：需**连续 `EVIDENCE_READY_STREAK` 次**探测 `ready` 才放行（覆盖 `stop()` 的
   *   "先删条目后杀进程"窗口）；
   * - **上界**：自登记起超过 `evidenceWaitMaxMs` ⇒ **放行**（转软校验 = **一等路径**，由取证节点
   *   自采 ①② 并输出 `stable`）；
   * - `503` / `starting` / 不可达 ⇒ 由注入方返回 `ready:false` ⇒ 视作**未就绪**；
   * - **持久化门**（不做纯内存态）：否则桥重启后门即丢、tick 会立刻派发 ⇒ **静默绕过硬路径**；
   * - **可观测**：只写转折点（`wait_start` / `wait_ready` / `wait_timeout`），**严禁每次轮询都写**。
   *
   * 返回是否**改写过库**（调用方据此重读节点快照，避免"刚续了挡板却按旧快照放行"）。
   */
  private runEvidenceGate(
    feature: FeatureRecord,
    nodes: readonly TaskRecord[],
    nowMs: number,
  ): boolean {
    const pendingEvidenceNodes = nodes.filter(
      (n) => isEvidenceNode(n) && n.state === "working" && n.remoteTaskId === null,
    );
    if (pendingEvidenceNodes.length === 0) return false;

    for (const node of pendingEvidenceNodes) {
      const waitedMs = this.evidenceWaitedMs(feature.featureId, node, nowMs);

      // 上界：到点 ⇒ 放行（转软校验，一等路径）
      if (waitedMs >= this.evidenceWaitMaxMs) {
        setTaskNotBefore(node.taskId, null);
        this.evidenceReadyStreak.delete(node.taskId);
        this.appendEvidenceEvent(feature.featureId, node.taskId, node.projectId, {
          phase: "wait_timeout",
          waitedMs,
          ready: false,
          reason: "upper_bound",
        });
        continue;
      }

      // 节流：不足一个轮询间隔 ⇒ 只续挡板，不打探测
      if (!this.evidencePollDue(node, nowMs)) {
        setTaskNotBefore(node.taskId, new Date(nowMs + this.evidencePollMs).toISOString());
        continue;
      }

      // 首次探测 ⇒ `wait_start` 转折点（以 `last_poll_at === null` 判定"第一次"，无需额外状态）
      if (node.lastPollAt === null) {
        this.appendEvidenceEvent(feature.featureId, node.taskId, node.projectId, {
          phase: "wait_start",
          waitedMs,
          ready: false,
          reason: "waiting",
        });
      }
      setTaskLastPollAt(node.taskId, new Date(nowMs).toISOString());

      const probe = this.probeProjectReady?.(node.projectId) ?? {
        ready: false,
        reason: "probe_unavailable",
      };
      if (!probe.ready) {
        // 未就绪（含 503 / starting / 不可达）：作废连续计数、继续挡
        this.evidenceReadyStreak.delete(node.taskId);
        setTaskNotBefore(node.taskId, new Date(nowMs + this.evidencePollMs).toISOString());
        continue;
      }

      const streak = (this.evidenceReadyStreak.get(node.taskId) ?? 0) + 1;
      this.evidenceReadyStreak.set(node.taskId, streak);
      if (streak < EVIDENCE_READY_STREAK) {
        // debounce 未达 ⇒ 继续挡，下一轮再确认
        setTaskNotBefore(node.taskId, new Date(nowMs + this.evidencePollMs).toISOString());
        continue;
      }

      // 达标 ⇒ 清门放行（随后由既有 tick 正常派发）
      setTaskNotBefore(node.taskId, null);
      this.evidenceReadyStreak.delete(node.taskId);
      this.appendEvidenceEvent(feature.featureId, node.taskId, node.projectId, {
        phase: "wait_ready",
        waitedMs,
        ready: true,
        reason: probe.reason,
      });
    }
    return true;
  }

  /** 是否到达下一个探测时点（节流）：无 `last_poll_at`（首次）或已满 `evidencePollMs` */
  private evidencePollDue(node: TaskRecord, nowMs: number): boolean {
    if (node.lastPollAt === null) return true;
    const at = Date.parse(node.lastPollAt);
    return Number.isNaN(at) ? true : nowMs - at >= this.evidencePollMs;
  }

  /**
   * 自登记起已等待时长：优先**进程内**登记时刻，回退**失败节点 `updated_at`**
   * （后者随失败落库持久化 ⇒ 桥重启后上界仍成立，不会永久卡在门里）。
   */
  private evidenceWaitedMs(featureId: string, _node: TaskRecord, nowMs: number): number {
    const mapped = this.pendingEvidence.get(featureId);
    if (mapped !== undefined) return Math.max(0, nowMs - mapped.registeredAt);
    const failed = this.resolveRetryTarget(featureId);
    if (failed !== null) {
      const at = Date.parse(failed.updatedAt);
      if (!Number.isNaN(at)) return Math.max(0, nowMs - at);
    }
    return 0;
  }

  /** 写一条 `task.evidence` 转折点事件（**只在转折点调用**，避免灌满收件箱） */
  private appendEvidenceEvent(
    featureId: string,
    taskId: string,
    projectId: string,
    payload: { phase: string; waitedMs: number; ready: boolean; reason: string },
  ): void {
    appendEvent({
      featureId,
      taskId,
      kind: EVIDENCE_EVENT_KIND,
      state: null,
      payload: JSON.stringify({ ...payload, projectId }),
    });
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
    // v0.4.1 中性化（**第 6 处，v7 §2.6 清单未列但必需**）：已 `exhausted` 的失败节点**不得**
    // 再触发传播 —— 否则下游被置 `blocked` ⇒ `depStateOf` 就算认了中性化也白费（下游永不可派发），
    // 且 blocked>0 会让 `reduceConvergence` 把 Feature 判 `failed`，中性化被整条击穿。
    const failedIds = nodes
      .filter((n) => n.state === "failed" && !isExemptFromFailure(n))
      .map((n) => n.taskId);
    if (failedIds.length > 0) {
      let blockedAny = false;
      for (const failedId of failedIds) {
        if (this.propagateFailure(feature, failedId).length > 0) blockedAny = true;
      }
      if (blockedAny) nodes = listFeatureTasks(feature.featureId, { limit: 1000 });
    }

    // v0.5.1（⑦）**兜底扫描**：`executing` 态下存在 **`failed` 的取证节点** ⇒ 交人。
    // 覆盖「**回调永不达**」的悬挂面 —— 取证节点的失败出路只有 `notifyTaskSettled`（自身失败）与
    // 「取证派发失败」两条，**都依赖回调到达**；无兜底时要么被误判 Feature `failed`（修 D2 前），
    // 要么**永久卡 `executing`**（修 D2 后：节点被豁免 ⇒ 视作完成 ⇒ 被 D5-C 硬闸拦下，而 `tick`
    // 只扫 `executing` ⇒ 无人再救）。
    // ⚠️ 谓词**不认** `isNeuteredSettled`（豁免证据臂必须收窄到 `state === "failed"`，否则活跃
    // 节点会被误判为「已完成」）；⚠️ **不得放进 `reduceConvergence`**（导出纯函数 + `pendingEvidence`
    // 是实例私有进程内态 ⇒ 删除动作**结构上不可能**在纯函数内完成）；⚠️ **不新增独立 tick 循环**
    // （`advanceExecuting` 已在每 Feature 每 tick 被调用 ⇒ 零新增调度面）。
    // 顺序 = 先清 map（I1）→ 写 ⑥b 丢弃事件 → 交人 → return，走 {@link discardPendingEvidence}
    // （v0.5.1 N1′）：与「收敛交人」同构。⚠️ 本处**必须写** ⑥b（`EVENT_PENDING_EVIDENCE_DISCARDED`）——
    // 多次取证流场景下「兜底扫描交人」会丢弃**未决**取证流，无痕即违反不变量 I3（失败事实必有痕）。
    // （与「取证节点失败」/「取证派发失败」两处**不同**：那两处「交人」本身就是决策本体、`feature.state`
    // 已留痕 ⇒ 只 `delete`、不写本事件。）
    if (nodes.some((n) => isEvidenceNode(n) && n.state === "failed")) {
      this.discardPendingEvidence(
        feature.featureId,
        "advanceExecuting",
        "兜底扫描：交人时丢弃待决策取证流",
      );
      this.needsInputFeature(feature, "取证节点失败：交人");
      return;
    }

    const convergence = reduceConvergence(nodes);
    if (convergence.kind === "failed") {
      this.failFeature(feature, convergence.reason);
      return;
    }
    if (convergence.kind === "needs_input") {
      // 「出口即清」+ 丢弃留痕（v0.5.1 ⑥ / ⑥b）：顺序 = **先 `delete` → 写事件 → `needsInputFeature`**。
      this.discardPendingEvidence(feature.featureId, "reduceConvergence", convergence.reason);
      this.needsInputFeature(feature, convergence.reason);
      return;
    }
    if (convergence.kind === "all_completed") {
      // v0.5.0 D5 硬闸：存在「待决策取证流」时**不得**推进 `integrating`。
      // 能走到 `retry` 的前提正是「取证节点已终态 ⇒ 全部节点终态」⇒ 不加此闸，收敛必然先一步
      // 推走 Feature（tick 只扫 `executing`）⇒ re-arm 后节点永不续派。同步、无 `await`（在
      // `transition` 之前完成判定，避免与看护回调交错）。
      if (this.hasPendingEvidenceDecision(feature, nodes)) return;
      this.transition(feature, "integrating", "全部任务达终态（调度器自动）");
      return;
    }

    // v0.4.1「等回收门」（§2.3 ③）：**先**对未派发的取证节点探测/续挡板，**再**算就绪集合。
    // 顺序不可换 —— 否则"登记即就绪"会让 tick 抢在等回收门之前把取证节点派出去。
    // 门会回写库 ⇒ `nodes` 快照已陈旧（刚续的挡板看不见）⇒ 重读，避免按旧快照放行。
    const nowMs = Date.now();
    if (this.runEvidenceGate(feature, nodes, nowMs)) {
      nodes = listFeatureTasks(feature.featureId, { limit: 1000 });
    }

    // 就绪集合（拓扑并行）：同层无依赖节点整批并发派发
    const ready = computeReadyNodes(nodes, this.inFlightNodes, nowMs);
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
          // 取证节点**派发失败**同样豁免（§4.1.8）：本不可达 ⇒ 交人，**不**置 failed / propagate /
          // failFeature（否则 Feature 直接终态，取证与拍板永不可达）。
          if (isEvidenceNode(node)) {
            // 「出口即清」（v0.5.1 ⑥）：同 `notifyTaskSettled` 的取证失败分支 —— 交人 = **决策本体**
            // ⇒ 先无条件清 map（I1），本处**不写** ⑥b 丢弃事件（`feature.state` 已留痕）。
            this.pendingEvidence.delete(feature.featureId);
            this.needsInputFeature(feature, `取证节点 ${node.taskId} 派发失败：${reason}`);
            return;
          }
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

  /**
   * 记一条「**状态流转被跳过**」留痕（v0.5.1 D1 / I3）：`bridgeLog.warn` + 一条
   * {@link EVENT_FEATURE_TRANSITION_SKIPPED}（`events.state` 列写 **`null`**，目标态放 `payload.to`）。
   *
   * **纯观测、无副作用**：不碰 `feature.state`（不变量 I4「`feature.state` 单写者」+ 与「态没变」
   * 的互补性）⇒ 调用方各自保留原 `return false` / `return` 语义。
   */
  private logTransitionSkipped(args: {
    site: string;
    featureId: string;
    taskId: string | null;
    from: string | null;
    to: string | null;
    code: string;
    detail: string;
  }): void {
    bridgeLog.warn(
      "a2a-feature",
      `Feature ${args.featureId} 状态流转跳过（${args.code}）：${args.detail}`,
      { site: args.site, from: args.from, to: args.to, code: args.code },
    );
    appendEvent({
      featureId: args.featureId,
      taskId: args.taskId,
      kind: EVENT_FEATURE_TRANSITION_SKIPPED,
      state: null,
      payload: JSON.stringify({
        site: args.site,
        from: args.from,
        to: args.to,
        code: args.code,
        detail: args.detail,
      }),
    });
  }

  /**
   * 「出口即清」+ 丢弃留痕（v0.5.1 ⑥ / ⑥b）：**先无条件** `delete(featureId)`（不变量 I1
   * 「决策已落 ⇔ `pendingEvidence` 无条目」），再**仅在条目实际存在时**补一条
   * {@link EVENT_PENDING_EVIDENCE_DISCARDED}（`taskId` = 被丢弃条目的 `failedTaskId`，`state` 列 `null`）。
   *
   * ⚠️ 留痕**不受**后续 `needsInputFeature` 返回值影响（即便它因已 `needs_input` 而 `return false`，
   * 「丢弃」这一事实仍须留痕）⇒ 本方法在 `needsInputFeature` **之前**调用，且自带完成（先 `delete`
   * → 写事件，顺序不可换）。
   * ⚠️ 用于三处「出口即清」：任务 `input-required`（`notifyTaskSettled`）、收敛交人
   * （`reduceConvergence`）、**兜底扫描交人**（`advanceExecuting`，v0.5.1 N1′）；「取证节点失败」/
   * 「取证派发失败」两处「交人」**就是决策本体** ⇒ 那两处只 `delete`、**不写本事件**。
   */
  private discardPendingEvidence(
    featureId: string,
    site: "notifyTaskSettled" | "reduceConvergence" | "advanceExecuting",
    detail: string,
  ): void {
    const discarded = this.pendingEvidence.get(featureId);
    this.pendingEvidence.delete(featureId);
    if (discarded === undefined) return;
    appendEvent({
      featureId,
      taskId: discarded.failedTaskId,
      kind: EVENT_PENDING_EVIDENCE_DISCARDED,
      state: null,
      payload: JSON.stringify({
        site,
        code: "pending_evidence_discarded",
        failedTaskId: discarded.failedTaskId,
        detail,
      }),
    });
  }

  /** 置 needs_input（仅在允许流转时；记录触发任务由调用方文本说明） */
  private needsInputFeature(feature: FeatureRecord, reason: string): boolean {
    const current = getFeature(feature.featureId);
    // v0.5.1 D1（④）：三处静默 `return false` **各补** log + 一条 `transition_skipped` 事件
    // （**态没变** ⇒ `state` 列写 `null`，且**不写** `feature.state`）；`:1079` 拆两行使 5 个 code
    // 全部可达。调用方 6 处一律丢弃返回值，故留痕是**唯一**可观测路径。
    if (current === null) {
      this.logTransitionSkipped({
        site: "needsInputFeature",
        featureId: feature.featureId,
        taskId: null,
        from: null,
        to: "needs_input",
        code: "feature_not_found",
        detail: reason,
      });
      return false;
    }
    if (isTerminalFeatureState(current.state)) {
      this.logTransitionSkipped({
        site: "needsInputFeature",
        featureId: feature.featureId,
        taskId: null,
        from: current.state,
        to: "needs_input",
        code: "feature_terminal",
        detail: reason,
      });
      return false;
    }
    if (current.state === "needs_input") {
      this.logTransitionSkipped({
        site: "needsInputFeature",
        featureId: feature.featureId,
        taskId: null,
        from: current.state,
        to: "needs_input",
        code: "already_needs_input",
        detail: reason,
      });
      return false;
    }
    if (!canTransition(current.state, "needs_input")) {
      this.logTransitionSkipped({
        site: "needsInputFeature",
        featureId: feature.featureId,
        taskId: null,
        from: current.state,
        to: "needs_input",
        code: "illegal_transition",
        detail: reason,
      });
      return false;
    }
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
