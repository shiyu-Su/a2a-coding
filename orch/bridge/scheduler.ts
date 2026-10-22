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
 * 失败语义：任一任务 `failed` → 沿 `dependencies` 反向**传递闭包**把下游 `working` 节点置
 * `blocked`（Task 层本地态，不映射 A2A）；任务 `input-required` → Feature `needs_input`。
 *
 * v0.6.1（REQ-05 §2.2）：**失败自动化五层（失败分类 / 中性化 / 取证流 / 等回收门 / 条件重试）
 * 已整块删除** —— `reduceConvergence` **不再有 `failed` 臂**，`blocked` 升为良性终态（不计入
 * 「未完成」，但也不等于 completed）。
 *
 * v0.6.1（REQ-05 §2.1，N3）：**失败冻结收窄 + 静止收敛**接续落地：
 * - **失败冻结限未派发**：`propagateBlocked` 只把 `remoteTaskId === null` 的 `working` 下游置
 *   `blocked`；**在飞节点（`remoteTaskId !== null`）不动** —— 等看护自然结算（不改写 `finished_at`
 *   ⇒ 根除「本地 blocked 与看护 CAS completed 打架」的写侧冲突面）；
 * - **业务失败不判死整单**：`notifyTaskSettled` 的 `failed` 分支与 `advanceExecuting` 的派发失败
 *   分支都改为「**只传播、不 `failFeature`**」，`failFeature` 收窄为 `validateDag` 失败 + 显式取消；
 *   `recover()` 只把在飞节点置 `failed`，**不再 `failFeature`**（v0.8.8 O4 起：派发窗口节点也不再
 *   启动即置 `failed`，保留 `working` 交补结算 —— 见 {@link FeatureScheduler.recover}）；
 * - **静止收敛（零动作 + 一次事件）**：`advanceExecuting` 在 `computeReadyNodes` 之后、`ready` 为空
 *   且「全部节点非 `working` ∧ 无在飞 ∧ 批门闩未持 ∧ 存在 failed/blocked」时，保持 `executing`
 *   静止并发一条 `feature.failure_report`（进程内 signature 去重，集合变化自然重新武装）；
 * - **封存谓词**（单一入口 `isFeatureSealed`）：Feature 处于静止或 `needs_input` 时，远端结算
 *   **只落库任务态**，不改 Feature 态、不传播（防 C5 漂移）。
 *
 * v0.6.1（REQ-05 §2.5，N5）：**project 粒度串行 + 静止期禁 ensure**接续落地：
 * - **就绪过滤（同 project 排队）**：`computeReadyNodes(nodes, inFlightNodes, busyProjects)` ——
 *   `projectId ∈ busy ⇒ 不 ready`，且**同批顺序认领**（同批内同 project 至多取一个）；
 * - **项目忙集** = 每 tick 一次的 DB 快照（`store.listBusyProjectIds()`：`state='working' ∧
 *   queue_state IN ('queued','claimed','running')`，v0.8.7 REQ-01 O1 改活；旧口径
 *   `remote_task_id IS NOT NULL` 在 pull 模型下**恒空**）∪ **进程内项目预留**（`reservedProjects`：
 *   与 `dispatching` / `inFlightNodes` 同段同步置位、批次 `finally` 同段释放）⇒ 同 tick 多 Feature
 *   并发进入时项目竞争失败者本批跳过、下 tick 重算；
 * - **串行不变量的承载者**：DB 谓词（含 `queued`）+ 本进程预留，**与 machine 侧领取纪律无关**
 *   （v0.8.7 前跨 tick 段实际无人守，见 `store.listBusyProjectIds` 注释）；
 * - **不变量 I-N（静止期禁 ensure）**：静止 / `needs_input` ⇒ 本 Feature **零派发** ⇒ 不调
 *   `dispatchTask` ⇒ **不触 `ensure`**；且静止 ⇒ 无 `working` 在飞 ⇒ 无看护 ⇒ **无 `renew`**
 *   （第二条 ensure 通道）。**不新增状态位 / 子态判据**：`ready.length === 0` 的 `return` 即落点，
 *   新增判据必为恒真死代码（§2.5 明令不拆 schema 位）。
 *
 * v0.10.8（O-4，orch-N5）：**节点集合判据** —— `mode="inquiry"` 自 O-2 起携带 `featureId`
 * （归属声明）⇒ 会落进本模块全部「按 Feature 取节点」的读集。收敛判定 / 失败传播（含静止与
 * 账单）/ 重启恢复**一律先经 {@link isDagNode} 收窄到 DAG 节点集**：inquiry 的
 * `input-required` 不把 Feature 翻成 `needs_input`、inquiry 的 `failed` 不冻结真 DAG 下游也不进
 * 失败账单、在飞 inquiry 不被 `recover()` 强置 `failed`。**只改节点集合判据，不改 Feature
 * 状态机流转**；存量 `mode` NULL 已由 orch-N1 读侧归一为 `dag` ⇒ 恒判 DAG 节点 = 零行为变化。
 *
 * R1 · v0.11.0（orch-N2）：判据**由取反式 `mode !== "inquiry"` 翻正为肯定式 `mode === "dag"`**
 * （`TASK_MODES` 引入第三档 `stage` 后，取反式要随值域扩张逐处改，肯定式不用）。⇒ `stage`
 * 阶段轮行自引入即被本模块全部读集剔出；且**就绪集**（{@link computeReadyNodes}）另加同一条
 * mode 判据 —— 它是唯一的派发入口，且 `dispatchGuard` 会被 `rearmTask` 清空（guard 兜不住
 * mode，故此处不依赖 guard）。零迁移、零回填：本节点不动协议、不动主链转移表与门①/门②。
 *
 * R1 · v0.11.0（orch-N5，本节点）：**消费点补批** —— N2 只翻了判据本身，本模块仍有若干处
 * 「取 `listFeatureTasks` 集合 → 直接判据」**没过 `isDagNode`**（`mode` 翻正后它们对 `stage`
 * 行的处置从「被谓词放行」变成「被语义误用」，是同一枚硬币的另一面）。逐处收窄到 DAG 节点集：
 * ① `advanceExecuting` 的**零节点早退**（原读 `nodes.length` ⇒ 一张只有阶段行的 Feature 顶不掉
 * 早退、整条判据链空跑）；② {@link validateDag} 的**被校验集合**（阶段行自身的 `dependencies`
 * 声明不再当 DAG 合法性判据 ⇒ 不再因阶段行把整单 `failFeature`；依赖**指向**非 DAG 行仍是响亮
 * 报错，且文案按行值点名 mode）；③ {@link FeatureScheduler.propagateFailure} 的**反向闭包集**
 * （阶段行 `working ∧ remoteTaskId === null` 是设计常态 ⇒ 绝不被失败传播冻成 `blocked`）；
 * ④ `isFeatureSealed` 的读集（与 `featureAtRest` 同一口径）；⑤ `recover()` 的**派发窗口集**
 * （阶段行天生命中该判据 ⇒ 不过滤就虚报「派发窗口 N 个保留 working」）。
 * 两处纯函数（{@link reduceConvergence} / {@link computeReadyNodes}）内部早已各自收窄 ⇒ 本节点
 * 不动它们，也不改 Feature 状态机流转。
 */
import {
  appendEvent,
  getFeature,
  getTask,
  listBusyProjectIds,
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
import { bridgeLog } from "./bridge-log.js";
import type { CoreRole } from "../runtime/core-lease.js";
import type { FeatureRecord, TaskMode, TaskRecord, TaskState } from "../types.js";

/** 桥重启后对账在飞任务时写入的结果文本（对齐本单元 C11 派发占位语义「已发出即有占位 ⇒ 保守不重派」） */
export const FEATURE_INTERRUPTED_TEXT =
  "任务因桥进程重启而中断（interrupted），未产出终态；请重新发起或重试。";

/** 看护放弃（连续失败超限）时写入的结果文本 */
export const FEATURE_ABANDONED_TEXT =
  "任务后台看护连续失败超限（abandoned），任务状态未知；请重新发起或重试。";

/**
 * **C11 派发窗口中断**时的结果文案（v0.6.1 REQ-05 §2.5 白捡）。
 *
 * 语义 = 「占位已写（可能已发出）、远端任务 id 未回填」：崩溃点落在 `message/send`
 * **前写占位 → send 返回后回填**之间。占位非 NULL 即「可能已发出」⇒ **不自动重派**（防同节点双派）。
 *
 * ⚠️ **v0.8.8 O4 起 `recover()` 不再在启动时把派发窗口节点置 `failed`**（保留 `working` 交补结算，
 * 见 {@link FeatureScheduler.recover}），故此文案**已退出生产写侧**，仅作显式核实/重派流程
 * （`rearmForRetry` 前后）与测试构造用的备用文案保留（出参语义不变）。
 */
export const FEATURE_DISPATCH_WINDOW_TEXT =
  "任务在派发窗口中断（占位已写、远端任务 id 未回填），可能已在远端发出；为避免重复派发未自动重派，请核实后重试或取消。";

/** 调度循环间隔（可配，默认 1500ms） */
export const FEATURE_TICK_MS = readPositiveIntEnv("FEATURE_TICK_MS", 1_500);

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
 * ⚠️ 与本模块「随发射方落常量」的既有约定一致 ⇒ `store.ts` 零改动。
 */
export const EVENT_FEATURE_TRANSITION_SKIPPED = "feature.transition_skipped";

/**
 * **失败静止账单**事件 kind（v0.6.1 REQ-05 §2.1 / §2.4，N3）。
 *
 * 触发点 = `advanceExecuting` 的**静止收敛**（`computeReadyNodes` 之后、`ready.length === 0`
 * 且 Feature 静止有失败时）。语义：
 * - Feature **态不转移**（仍 `executing`，零动作等宿主）⇒ `events.state` 列写 **`null`**
 *   （与 {@link EVENT_FEATURE_TRANSITION_SKIPPED} 同一条不变量：「态没变 ⇒ 不写目标态」）；
 * - `payload = { failed: [{ taskId, projectId, text, contextId }], blockedSet: [taskId] }`
 *   —— `contextId` 取 **`TaskRecord.contextId`（节点会话，供同 ctx 续推重派）**，**不是**
 *   `FeatureRecord.contextId`；`text` 取节点 `text`（可 `null`）；
 * - **去重 = 一次/静止期**：进程内 `Map<featureId, signature>`，
 *   `signature = sorted(failedIds) + "|" + sorted(blockedIds)`；signature 不变即不重发，
 *   **集合变化（重派 / 解冻）自然重新武装**；桥重启后至多补发一条（登记已知进程内态局限）。
 */
export const EVENT_FAILURE_REPORT = "feature.failure_report";

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

/**
 * `start()` 选项（REQ-v0.4.1-2026-09-15-02）。
 * - `unref`：是否对定时器 `unref()`（不持有进程）。**缺省 true**；桥恒常驻 http，
 *   由 lifecycle 显式传 `false`（HTTP listener 持有进程）。**模式不硬编码进 scheduler**。
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
  /**
   * 扫描到的 **`executing` Feature 数**（v0.9.0 B10″：`state='executing'` 过滤下推 SQL 后，
   * 语义由旧的「非终态 Feature 数」**收窄为「executing 数」**——被 `recover()` 实际处置的正是这批，
   * 非终态非 executing 的 Feature 旧代码也只 `scanned += 1` 后跳过，不计入本值）。
   */
  scanned: number;
  /**
   * 被收敛为 `failed` 的 Feature 数。
   *
   * ⚠️ v0.6.1 REQ-05 §2.1（N3）起**恒为 `0`**：`recover()` 不再 `failFeature`（业务失败不判死整单）
   * —— 在飞节点按 `interrupted` 置 `failed` 后，Feature 留给**静止收敛**叙事（下一 tick 发
   * `feature.failure_report`），由宿主经 `retryTaskIds` 重派或显式取消。
   * 字段**保留**（出参形状稳定，`bridge/index.ts` 启动日志与 `lifecycle` 照读），语义休眠。
   */
  failedFeatures: number;
  /** 被按 interrupted 语义收敛的任务数 */
  interruptedTasks: number;
}

// ---------------------------------------------------------------------------
// 纯函数（无副作用 / 可单测）
// ---------------------------------------------------------------------------

/**
 * **是否「未处置失败」**（v0.6.1 REQ-05 收窄后的判据）：节点事实态为 `failed` 即为未处置。
 *
 * v0.4.1 的失败豁免族（`isNeutered` / `isNeuteredSettled` / `isExemptFromFailure`，含
 * 「已中性化」与「取证节点自身失败」两臂）随五层删除整块消失 ⇒ 判据塌缩为**单一事实**：
 * 无中性化、无取证豁免，`failed` 就是 `failed`。本函数是该单一事实源的唯一入口
 * （失败传播的起点过滤、后续重派节点的集合校验都读它），避免就地写裸判据造成漂移。
 */
export function isUnhandledFailure(node: Pick<TaskRecord, "state">): boolean {
  return node.state === "failed";
}

/**
 * **是否 Feature DAG 节点**（v0.10.8 O-4 · orch-N5 引入；判据翻转 = R1 · v0.11.0 orch-N2）：
 * 调度器**节点集合判据**的单一事实源。
 *
 * 背景：`mode="inquiry"` 自 v0.10.8 O-2 起亦携带 `featureId`（归属声明，落 `tasks.feature_id`）
 * ⇒ inquiry 行会落进全部「按 Feature 取节点」的读集。它**不是 DAG 节点**（不由调度器派发、
 * 不参与依赖拓扑），若混进判据即产生改造文档 §2.1 O-4 的五条后果（本节点处理 ①②③，
 * ④⑤ 在 `feature-tools.ts` = orch-N6）。
 *
 * **判据取肯定式 `mode === "dag"`**（v0.11.0 起 `TASK_MODES` 有三档：`dag` / `inquiry` /
 * `stage` ⇒ 任何取反式都要随值域扩张逐处改一遍，肯定式不用）：闭集内非 `dag` 者一律**不是**
 * DAG 节点，`stage` 阶段轮行自引入即被剔出节点集（不进收敛 / 传播 / 账单 / 恢复 / 就绪集）。
 *
 * ⚠️ **入参类型收紧 = 翻转的承重前提**（本卡唯一不可自愈风险面的执法点）：形参声明为
 * **归一后的 `{ readonly mode: TaskMode }`**，不接受裸 row / `unknown` ⇒ 「凡进本函数的行
 * 必已过 `readMode`（NULL → `dag`）」由编译期保证。取反式时期该前提靠本函数兜底
 * （`undefined !== "inquiry"` = 放行）；翻正后**未过读口的裸对象会被静默剔出节点集**，
 * 与「零迁移」叠加即无声的行为变化。新增调用点若手里是 `Record<string, unknown>`，必须先走
 * 读侧再进本函数，**不得**在本函数里重新兜底（那等于把 mode 归一拆成两处事实源）。
 *
 * ⚠️ 只用于「**节点集合**」筛选；**不改 Feature 状态机流转**（流转表 / `canTransition` 零触达）。
 */
export function isDagNode(node: { readonly mode: TaskMode }): boolean {
  return node.mode === "dag";
}

/**
 * 本地是否已终结（`a2a_task_status` / `a2a_cancel` 的本地快路径判据）：
 * 终结态结果由本地存档直接作答，不再查询远端。
 *
 * ⚠️ **单一事实源**（v0.6.1 REQ-05）：`index.ts` 原有的私有同义函数 `isLocalTerminalState`
 * 已删除，调用方直接消费本函数（此前是「双份判据」，靠委托维持一致）。
 * `blocked` 为 orch 本地专属终态（失败传播，不映射 A2A）：被阻塞节点不会再派发，直接以本地
 * 存档作答，避免误查远端。
 */
export function isLocalTerminalTask(node: TaskRecord): boolean {
  return (
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
 * - 任一上游 `failed` / `blocked` → `upstreamFailed`（不带病派发）；
 * - 否则存在未完成上游 → `pending`；
 * - 全部 completed（含无依赖）→ `completed`。
 *
 * v0.6.1 REQ-05：随中性化族删除，原有「`exhausted` 上游视作 completed」一行消失 —— 上游
 * 失败即 `upstreamFailed`，不再有豁免通道。
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
 * 就绪 = **是 DAG 节点**（{@link isDagNode}，R1 · v0.11.0 orch-N2 加判）且 `working` 且尚未派发
 * （`remoteTaskId === null`）且无派发占位、不在在飞标记内、依赖全部 completed。
 *
 * v0.6.1 REQ-05：`!isNeutered` 与 `isPastNotBefore` 两条判据随五层删除一并移除
 * （中性化列与 `not_before` 门都已停止读写，不再有「登记后先不派」的持久化挡板）。
 *
 * **v0.6.1 REQ-05 §2.5（N5）project 粒度串行**：可选第三参 `busyProjects` = 「项目忙」集合
 * （DB 快照 ∪ 进程内预留，见 {@link FeatureScheduler} 的 `busyProjectIds` / `reservedProjects`）。
 * 传入时另叠一条判据 —— **projectId ∈ busy ⇒ 不 ready**（同 project 排队），并且**同批内同 project
 * 顺序认领**（`claimed`）：同一批里第一个被选中的项目即被本批认领，其后同 project 的候选**本批不取**
 * （下一 tick 重算）。⇒ 不变式「同一 project 任意时刻至多一个在飞节点」**在本批内亦成立**
 * （否则同批两个同 project 节点会并发派发，串行虚设）。
 *
 * `busyProjects` **省略 ⇒ 保持旧语义**（不启用项目认领）：仅调度器（唯一生产调用方）传第三参；
 * 纯函数测试可继续以两参调用断言「拓扑就绪」本身。
 */
export function computeReadyNodes(
  nodes: readonly TaskRecord[],
  inFlight?: ReadonlySet<string>,
  busyProjects?: ReadonlySet<string>,
): TaskRecord[] {
  const byId = new Map(nodes.map((n) => [n.taskId, n]));
  /** 本批已认领的项目（仅当传入 `busyProjects` 时参与判定） */
  const claimed = new Set<string>();
  const ready: TaskRecord[] = [];
  for (const n of nodes) {
    /**
     * **只有 DAG 节点参与就绪计算**（R1 · v0.11.0 orch-N2，**第二道保险**）。
     *
     * 调用点侧本就应先过 {@link isDagNode}（`advanceExecuting` 的其余读集已收窄），但就绪集是
     * **唯一的派发入口** ⇒ 此处独立再判一次。原因 = 占位（`dispatchGuard`）会被 `rearmTask` /
     * `rearmForRetry` **清空**（那是「回到待派发」的显式动作、不区分 mode）⇒ 一旦某条非 DAG 行
     * （`inquiry` / `stage`）被重排成 `working` 且占位为空，本函数就会把它当就绪节点**派发出去**。
     * mode 判据不依赖占位，故占位被清也拦得住（阶段行「长期可见、被指名」全靠这条不派）。
     */
    if (!isDagNode(n)) continue;
    if (n.state !== "working") continue;
    if (n.remoteTaskId !== null) continue;
    /**
     * **C11 占位已写 ⇒ 不重派**（v0.6.1 REQ-05 §2.5 白捡，**第一道防线**）。
     *
     * 「已发出即有占位」：占位（`dispatchGuard`）在 `message/send` 之前落库 ⇒ 占位非 NULL
     * 即「可能已发出」。此处必须排除，否则启动首 tick 会重派 —— 注意 `lifecycle` 的次序是
     * `scheduler.start()`（内含**立即 tick**）**早于** `scheduler.recover()`，恢复判据来不及
     * 先把窗口节点收敛为 `failed`。清空点 = `rearmTask` / `rearmForRetry`（重派是显式动作）。
     */
    if (n.dispatchGuard !== null) continue;
    if (inFlight?.has(n.taskId) ?? false) continue;
    if (
      busyProjects !== undefined &&
      (busyProjects.has(n.projectId) || claimed.has(n.projectId))
    ) {
      continue;
    }
    if (depStateOf(n, byId) !== "completed") continue;
    // ⚠️ 认领**必须晚于全部其它判据**：否则「依赖未满足」的同 project 节点会先占位，
    // 把其后**本可派发**的同 project 节点挤出本批 ⇒ 每 tick 重复占位 ⇒ 永久饿死。
    if (busyProjects !== undefined) claimed.add(n.projectId);
    ready.push(n);
  }
  return ready;
}

/**
 * 失败传播：沿 `dependencies` **反向传递闭包**，返回因 `failedId` 失败而应置 `blocked` 的
 * 下游节点 id 列表（仅含当前 `working` **且未派发**（`remoteTaskId === null`）者；
 * 已完成 / 已失败 / 已阻塞 / **已在飞**者不改写）。
 * 遍历不因下游已终态而中断，保证其再下游同样被覆盖。
 *
 * ⚠️ v0.6.1 REQ-05 §2.1（N3）：**冻结面收窄为「未派发」** —— 在飞节点（`remoteTaskId !== null`）
 * **不置 `blocked`**，等看护自然结算。理由：① 与「已在飞节点的结果有效」自洽；②
 * `updateTaskState(blocked)` 会写 `finished_at`，而看护 `persist` 随后把它 CAS 回终态
 * ⇒ 本地态与远端事实互相打架（根除该 CAS 打架面的**写入侧**）。
 * 注：过滤只影响「谁被冻」，**不影响就绪计算**（`computeReadyNodes` 不受本函数约束）——
 * 未被冻的其余节点照常派发。
 */
export function propagateBlocked(failedId: string, nodes: readonly TaskRecord[]): string[] {
  const byId = new Map(nodes.map((n) => [n.taskId, n]));
  const downstreamOf = buildDownstreamIndex(nodes);
  const blocked: string[] = [];
  const seen = new Set<string>([failedId]);
  const queue: string[] = [failedId];
  for (;;) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const child of downstreamOf.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      const childNode = byId.get(child);
      // v0.6.1 REQ-05 §2.1（N3）：只冻**未派发**的 working 下游；在飞（remoteTaskId !== null）不动
      if (childNode?.state === "working" && childNode.remoteTaskId === null) {
        blocked.push(child);
      }
      queue.push(child); // 继续下探，覆盖“中间节点已终态”的再下游
    }
  }
  return blocked;
}

/**
 * `dependencies` 的**反向边索引**（上游 -> 直接下游）。
 *
 * `propagateBlocked`（谁应被**新冻**）与 `descendantClosure`（谁仍受失败集**支配**）共用同一份
 * 构造，避免两处反向边逻辑漂移。纯函数、无副作用。
 */
function buildDownstreamIndex(nodes: readonly TaskRecord[]): Map<string, string[]> {
  const downstreamOf = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.dependencies ?? []) {
      const list = downstreamOf.get(dep);
      if (list === undefined) downstreamOf.set(dep, [node.taskId]);
      else list.push(node.taskId);
    }
  }
  return downstreamOf;
}

/**
 * **下游可达闭包**（**不按状态过滤**）：返回自 `roots` 沿 `dependencies` 反向可达的全部下游节点 id
 * （含中间节点、已终态节点与 `roots` 自身）。
 *
 * 与 {@link propagateBlocked} 的分工（v0.6.1 REQ-05 §2.3 / N4）：
 * - `propagateBlocked` 回答「**谁应被新冻**」⇒ 只看 `working ∧ remoteTaskId === null`；
 *   已 `blocked` 者**不在**其返回值里；
 * - 本函数回答「**谁仍受该失败集支配**」⇒ 用于**解冻判定**：`blocked` 节点不在闭包内
 *   = 其上游失败已全部被重派 ⇒ 应解冻；仍在闭包内 = 还有未重派的失败上游 ⇒ 保持冻结。
 *   **必须用可达集而非 `propagateBlocked` 的返回值**，否则所有已 `blocked` 节点都会被误判为
 *   「闭包外」而被错误解冻。
 */
export function descendantClosure(
  roots: readonly string[],
  nodes: readonly TaskRecord[],
): Set<string> {
  const downstreamOf = buildDownstreamIndex(nodes);
  const seen = new Set<string>(roots);
  const queue: string[] = [...roots];
  for (;;) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const child of downstreamOf.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

/** `retryTaskIds` 的**重派计划**（纯函数：校验 + 重派集 + 解冻集；**不改库**） */
export interface ResumePlan {
  /**
   * 逐 id 拒绝原因。**非空 ⇒ 整单拒绝**（调用方必须原样驳回，**不得做部分重派**）——
   * 「先校验后改库、任一失败即拒绝流转且 Feature 态不变」（§2.3）。
   */
  invalid: Array<{ taskId: string; reason: string }>;
  /** 可重派（当前 `failed`）的节点 id，保持入参次序 */
  rearmIds: string[];
  /** 闭包**外**且当前 `blocked` ⇒ 应解冻为 `working` 的节点 id */
  unfreezeIds: string[];
  /** 闭包**内**且当前 `blocked` ⇒ 仍有未重派失败上游 ⇒ 保持冻结（不动）的节点 id */
  keepBlockedIds: string[];
}

/**
 * 计算 `retryTaskIds` 的重派与解冻计划（v0.6.1 REQ-05 §2.3 / N4）。
 *
 * 判据（顺序）：
 * 1. **逐 id 校验**：未知 / 不属于本 Feature、`state !== 'failed'`（`isUnhandledFailure` 单一事实源）、
 *    重复出现 ⇒ 记 `invalid`（**不静默跳过**）。任一 `invalid` ⇒ 计划整体作废（**不做部分重派**）。
 * 2. **剩余未重派 failed 集合** = 全量 `failed` − 本次重派集；以其为基算 {@link descendantClosure}。
 * 3. **解冻判定**：当前 `blocked` 且**不在**闭包内 ⇒ `unfreezeIds`；在闭包内 ⇒ `keepBlockedIds`
 *    （仍有未撤销的失败上游，冻结仍成立）。
 *
 * 注：`exhausted` / `not_before` 为休眠列（REQ-05 起不读不写），**不参与**本计划；「清 `not_before`」
 * 原条目已删除（挡门与写口随 N2 一并消失 ⇒ 无对象可清）。
 */
export function planResume(
  nodes: readonly TaskRecord[],
  retryTaskIds: readonly string[],
): ResumePlan {
  const byId = new Map(nodes.map((n) => [n.taskId, n]));
  const invalid: Array<{ taskId: string; reason: string }> = [];
  const rearmIds: string[] = [];
  const claimed = new Set<string>();
  for (const id of retryTaskIds) {
    if (claimed.has(id)) {
      invalid.push({ taskId: id, reason: "重复出现（同一 id 只能重派一次）" });
      continue;
    }
    const node = byId.get(id);
    if (node === undefined) {
      invalid.push({ taskId: id, reason: "不属于本 Feature（未知节点）" });
      continue;
    }
    if (!isUnhandledFailure(node)) {
      invalid.push({ taskId: id, reason: `state=${node.state}（仅 failed 可重派）` });
      continue;
    }
    claimed.add(id);
    rearmIds.push(id);
  }
  if (invalid.length > 0) {
    return { invalid, rearmIds: [], unfreezeIds: [], keepBlockedIds: [] };
  }
  const remainingFailed = nodes
    .filter((n) => isUnhandledFailure(n) && !claimed.has(n.taskId))
    .map((n) => n.taskId);
  const closure = descendantClosure(remainingFailed, nodes);
  const unfreezeIds: string[] = [];
  const keepBlockedIds: string[] = [];
  for (const node of nodes) {
    if (node.state !== "blocked") continue;
    if (closure.has(node.taskId)) keepBlockedIds.push(node.taskId);
    else unfreezeIds.push(node.taskId);
  }
  return { invalid: [], rearmIds, unfreezeIds, keepBlockedIds };
}

/**
 * 收敛判定结果（顺序语义见 `reduceConvergence`）。
 *
 * v0.6.1 REQ-05（§2.1）：**`failed` 臂已删除** —— 业务失败不产出 Feature `failed` 终态；
 * `failed` 仅保留给 DAG 非法（环 / 悬空）的 fail-fast 路径，那条路径不经本判定
 * （`validateDag` 直接在 `advanceExecuting` 里 `failFeature`）。
 */
export type Convergence =
  | { kind: "needs_input"; reason: string }
  | { kind: "all_completed" }
  | { kind: "dispatch" };

/**
 * 收敛判定（顺序）：
 * 1. 存在 `input-required` → `needs_input`；
 * 2. 全部 `completed` → `all_completed`；
 * 3. 否则 → `dispatch`（派发全部就绪节点）。
 *
 * v0.6.1 REQ-05：原第 1 处「存在 `failed` / `blocked` → `failed`」已删除 ⇒ 失败 / 阻塞节点
 * 既不判死也不计入「全完成」，落回 `dispatch`；若此时无就绪节点，则由 **N3 已落地的静止收敛**
 * （零动作 + `feature.failure_report`）承载，Feature 停在 `executing`。
 * `blocked` 为**良性终态**：不计入「全部 `completed`」（故被阻塞的 Feature 不会误进 `integrating`）。
 *
 * **v0.10.8 O-4（①）**：入参 `nodes` 是「按 Feature 取节点」的读集，**含 inquiry 行** ⇒ 本判定
 * 先按 {@link isDagNode} 收窄到 DAG 节点集：inquiry 的 `input-required` **不**把 Feature 翻成
 * `needs_input`；inquiry 在飞 / 未终态 **不**拖延 `all_completed → integrating`。
 * 存量（`mode` NULL → 归一 `dag`）集合不变 ⇒ 零行为变化。
 */
export function reduceConvergence(nodes: readonly TaskRecord[]): Convergence {
  const dag = nodes.filter(isDagNode);
  if (dag.some((n) => n.state === "input-required")) {
    return { kind: "needs_input", reason: "存在待澄清任务" };
  }
  if (dag.length > 0 && dag.every((n) => n.state === "completed")) {
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
  /**
   * **项目忙快照**（v0.6.1 REQ-05 §2.5 / N5）：本 **tick** 开始时取一次
   * `listBusyProjectIds()` = `state='working' ∧ queue_state IN ('queued','claimed','running')`
   * 的 projectId 集合（v0.8.7 REQ-01 O1 改活：旧口径 `remote_task_id IS NOT NULL` 在 pull 模型下
   * 无生产写入点 ⇒ **恒空**，串行门只剩下面的进程内预留）。每 tick 一次、tick 内稳定（读侧零抖动）。
   * 含 `queued` 是刻意的 —— 「上一节点未落定 ⇒ 同项目后续不得先行」即**串行的定义本身**；
   * 悬挂领取被 sweep 清算回 `queued` 后**仍在忙集**亦为正确行为（任务确实未落定）。
   * **只覆盖已落库的忙** —— 「派发已发起但队列态尚未落库」的窗口由 {@link reservedProjects} 补，
   * 二者相并为完整忙集。
   */
  private busyProjectIds: ReadonlySet<string> = new Set();
  /**
   * **进程内项目预留**（v0.6.1 REQ-05 §2.5 / N5）：本批已占位的 projectId。
   *
   * ⚠️ 必须与 `dispatching` / `inFlightNodes` 在**同一段同步代码**置位、在批次 `finally` 同段释放：
   * `tick()` 对每个 `executing` Feature 都是 `void advanceFeature(...)`（**不 await**）⇒ 同一 tick
   * 内多个 Feature 会先后进入 `advanceExecuting`；只有进程内预留能让「项目竞争失败者本批跳过、
   * 下 tick 重算」成立，否则同 project 双派、「同 project 串行」形同虚设（改造文档 §2.5 硬约束 1）。
   *
   * **职责收窄（v0.8.7 REQ-01 O1）**：DB 忙集谓词改活后，本集合**只守「同 tick 多 Feature 并发进入」
   * 的内存瞬间**（派发已发起、`queue_state` 尚未落库那一段）；**跨 tick 的串行不再靠它**（此前由
   * 恒空的 DB 快照 + 本集合共同宣称覆盖，实际本集合在批次 `finally` 即退场 ⇒ 跨 tick 无守护）。
   * 保留不动的理由：覆盖上面的窗口、成本零。
   */
  private readonly reservedProjects = new Set<string>();
  /** tick 守卫：按 Feature 粒度，长派发不互相阻塞 */
  private readonly tickingFeatures = new Set<string>();
  /**
   * 失败静止账单去重（v0.6.1 REQ-05 §2.1，N3）：`Map<featureId, signature>`。
   * `signature = sorted(failedIds) + "|" + sorted(blockedIds)`。
   * - signature 不变 ⇒ **不重发**（重复 tick 幂等）；
   * - 集合变化（重派 / 解冻）⇒ 自然**重新武装**（无需显式清标志，episode 自动复位）；
   * - **进程内态**：桥重启后至多**补发一条**（登记已知局限；不为去重新增 per-feature 事件查询）。
   */
  private readonly failureReportSignatures = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: FeatureSchedulerOptions) {
    this.dispatch = options.dispatch;
    this.pollIntervalMs = options.pollIntervalMs ?? FEATURE_TICK_MS;
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
    // 桥恒常驻（http listener 持有进程）：lifecycle 传 unref=false ⇒ 不 unref 定时器
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
   * v0.6.1 REQ-05 §2.1（N3）：失败自动化的分类 / 取证分支已整块删除后，本函数只剩三段：
   * - `failed` ⇒ **只传播冻结**（`propagateFailure`，且只冻未派发下游）+ `kick` 交 tick 判静止；
   *   **不再 `failFeature`**（业务失败不判死整单）；
   * - `input-required` ⇒ Feature `needs_input`（needs_input 单一来源②）；
   * - `completed` ⇒ 交 tick 判完成（全部 `completed` ⇒ `integrating`）。
   *
   * **封存谓词前置**（防 C5 漂移）：Feature 处于**静止**或 `needs_input` 时，远端结算
   * **只落库任务态**（由调用方 `persist` 完成），**不改 Feature 态、不传播、不发事件**。
   *
   * **v0.10.8 O-4（②）非 DAG 节点先于封存早退**：`mode="inquiry"` 的结算走同一条早退口径
   * （只落库、不传播、不改 Feature 态），留痕 code `non_dag_settle`。
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

    // **v0.10.8 O-4（②）非 DAG 节点早退**：inquiry 行虽带 `featureId`（归属声明），但**不是 DAG
    // 节点** ⇒ 其结算**只落库任务态**（由调用方 `persist` / `updateTaskState` 完成），在此不传播、
    // 不改 Feature 态、不 kick（否则 inquiry 失败会冻结真 DAG 下游并写进失败账单）。
    // 置于封存判定**之前**：本处的「零动作」理由是「节点集合不含它」，而非「Feature 已静止」。
    // **R1 · v0.11.0 orch-N5**：本早退对 `mode="stage"` 的阶段行**同样生效**（判据是 `isDagNode`，
    // 不点名档位）⇒ 单条阶段行 `failed` 走「只落库」这条口，**不进** {@link propagateFailure}；
    // 即便上游漏判，propagateFailure 内部还有一道闭包收窄（消费点 ③）兜住。
    const settled = getTask(taskId);
    if (settled !== null && !isDagNode(settled)) {
      bridgeLog.info(
        "a2a-feature",
        `Feature ${feature.featureId} 收到非 DAG 节点（mode=${settled.mode}）结算：任务 ${taskId}（${outcome.state}）只落库，不传播、不改 Feature 态`,
        { site: "notifyTaskSettled.nonDag", taskId, outcome: outcome.state },
      );
      this.logTransitionSkipped({
        site: "notifyTaskSettled.nonDag",
        featureId: feature.featureId,
        taskId,
        from: feature.state,
        to: outcome.state,
        code: "non_dag_settle",
        detail: `非 DAG 节点（mode=${settled.mode}）结算只落库：任务 ${taskId}（${outcome.state}）不传播、不改 Feature 态`,
      });
      return;
    }

    if (this.isFeatureSealed(feature)) {
      // v0.6.1 REQ-05 §2.1（N3）：静止（失败静止 / needs_input）期 —— 结算**只落库任务态**，
      // 不改 Feature 态、不传播、不发账单（任务态已由调用方 `persist` / `updateTaskState` 落地）。
      bridgeLog.info(
        "a2a-feature",
        `Feature ${feature.featureId} 处于静止（${feature.state}）：任务 ${taskId} 结算（${outcome.state}）只落库，不改 Feature 态`,
        { site: "notifyTaskSettled.sealed", taskId, outcome: outcome.state },
      );
      // v0.5.1 D1（I3「静默死信必有痕」）**不得因封存而失效**（宿主裁定 (a)）：封存早退是**新增的
      // 静默路径**，`bridgeLog` 只在日志面可见、宿主的 `a2a_events` 面看不到 ⇒ 复用
      // `transition_skipped` 通道留痕。`state` 列写 `null`（**态没变**，与既有四条 code 同一不变量）；
      // `payload.to` 放该 settle 的**目标态名**（`outcome.state` = 本会被应用的任务终态，非 Feature 态）；
      // code `sealed_settle` 与 `early_return_task_settled` / 三个 `needsInputFeature` code 区分
      // （封存 ≠ 不可承接 ≠ 已交人 ≠ 非法流转）。**不发 failure_report**（那由静止收敛独占）。
      this.logTransitionSkipped({
        site: "notifyTaskSettled.sealed",
        featureId: feature.featureId,
        taskId,
        from: feature.state,
        to: outcome.state,
        code: "sealed_settle",
        detail: `封存期（${feature.state}）结算只落库：任务 ${taskId}（${outcome.state}）不改 Feature 态、不传播、不发账单`,
      });
      return;
    }

    if (outcome.state === "failed") {
      // v0.6.1 REQ-05 §2.1（N3）：只传播（冻结未派发下游）+ 交给 tick 的静止收敛记账；
      // **不 `failFeature`**（业务失败不判死整单）。kick 后由 `advanceExecuting` 判静止并发账单。
      const blocked = this.propagateFailure(feature, taskId);
      bridgeLog.warn(
        "a2a-feature",
        `Feature ${feature.featureId} 节点 ${taskId} 失败：冻结未派发下游 ${blocked.length} 个，Feature 保持 executing（等静止收敛）`,
        { site: "notifyTaskSettled.failed", taskId, blocked: blocked.length },
      );
      this.kick();
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
   *   各按本单元 C11 派发占位语义「已发出即有占位 ⇒ 保守不重派」收敛（任务置 failed）；
   *   **Feature 不再置 `failed`**（v0.6.1 REQ-05 §2.1 / N3）—— 留给**静止收敛**叙事：
   *   下一 tick（此处显式 `kick`）由 `advanceExecuting` 判静止并发 `feature.failure_report`，
   *   由宿主持账单经 `retryTaskIds` 重派或显式取消；
   * - **C11 派发窗口**（v0.6.1 REQ-05 §2.5；**v0.8.8 O4 起不再启动即置 failed**）：`working` 且
   *   `remoteTaskId === null` 但**占位已写**（`dispatchGuard !== null`）的节点 —— 崩溃点在「send 前
   *   占位 → 回填」之间。**保留 `working`**：交 machine 重连后的**补结算回填终态**（占位仍在 ⇒ 首 tick
   *   不重派、不双派），真失败由孤儿**墙钟出口**（30 min）兜底。此前在此置 `failed` 会**抢先扼杀补结算窗口**
   *   （machine 迟到的终态被 `WHERE state NOT IN terminal` 吞掉）；失败账单时点因此**后移**（见下方实现注释）；
   * - `waiting_approval` / `needs_input` / `integrating` / `testing` / `reviewing` 保持挂起；
   * - 其余非终态（discussing/analyzing/planning）保持。
   *
   * ⇒ `FeatureRecoverySummary.failedFeatures` 自本节点起**恒为 0**（字段保留、语义休眠）。
   *
   * **v0.10.8 O-4（③）**：在飞集 / 计数只覆盖 **DAG 节点**（`isDagNode`）——`mode="inquiry"` 的
   * 在飞行**不**被强置 `failed`，也**不**计入 `interruptedTasks`。
   */
  recover(): FeatureRecoverySummary {
    const summary: FeatureRecoverySummary = {
      scanned: 0,
      failedFeatures: 0,
      interruptedTasks: 0,
    };
    // v0.9.0 B10″：**`state='executing'` 过滤下推 SQL**（旧：扫全量非终态再在内存里 `!== executing`
    // 跳过）。`executing` 恒为非终态 ⇒ 旧循环对「非终态非 executing」的 Feature 只做 `scanned += 1`
    // 后 `continue`（零动作），下推到 SQL 后**被处理（在飞置 failed / kick）的 Feature 集合完全一致**。
    // ⚠️ `scanned` 语义随之**重定义为「executing 数」**（旧 =「非终态数」）—— 见 `FeatureRecoverySummary`。
    for (const feature of listFeatures({ state: "executing", limit: 1000 })) {
      summary.scanned += 1;
      const nodes = listFeatureTasks(feature.featureId, { limit: 1000 }).filter(isDagNode);
      // 已在飞（远端 id 已知）：既有恢复路径
      // **v0.10.8 O-4（③）**：在飞集只取 DAG 节点 ⇒ 重启**不**把在飞 inquiry 强置 `failed`
      // （只读询问的终态由 machine 补结算 / 看护自然落，与 Feature 的 DAG 恢复无关）。
      // **R1 · v0.11.0 orch-N5（消费点 ⑤）**：收窄点**上移到读集** ⇒ 同一段读出的两份判据
      // （在飞集 / 派发窗口集）共用同一个「DAG 节点集」口径，不再一处过、一处不过。
      const inFlight = nodes.filter((n) => n.remoteTaskId !== null && n.state === "working");
      /**
       * **C11 派发窗口**：占位已写（`dispatchGuard !== null`）、远端 id 未回填
       * （`remoteTaskId === null`）且仍 `working` ⇒ 崩溃点落在「send 前占位 → send 返回后回填」之间。
       *
       * **v0.8.8 O4：启动不再误杀** —— 本类节点**不再在 `recover()` 内被置 `failed`**。原因：
       * `recover()` 跑在 `/health` 就绪**之前**，早于 machine 重连后的补结算窗口。若在此抢先置
       * `failed`，machine 随后送来的**补结算迟到件**会被 `upsertTaskResult` 的
       * `WHERE state NOT IN ('completed','failed','blocked')` 挡成零写入 —— **启动收敛扼杀了补结算**。
       * 现改为**保留 `working`**：占位仍在 ⇒ 首 tick `computeReadyNodes` 排除（不双派），交 machine
       * 重连后的**补结算回填终态**；真失败由孤儿的**墙钟出口**（30 min `failOrphanedTask`）兜底。
       * 因此**失败账单（`feature.failure_report`）的时点从「启动即刻」后移到「补结算 / 墙钟」之后**
       * —— 这是刻意的取舍（宁可账单晚到，不可误杀补结算），后人勿再改回启动即置 `failed`。
       *
       * **R1 · v0.11.0 orch-N5（消费点 ⑤ 的后半）**：本判据（`dispatchGuard !== null ∧
       * remoteTaskId === null ∧ working`）阶段行**天生命中** —— 开轮物化写占位、且它不由调度器
       * 派发 ⇒ 远端 id 永不回填。读集不过 `isDagNode` 时，一张只有阶段行的 Feature 会被算成
       * 「派发窗口 N 个」并打出 warn（**零处置**却虚报「保留 working」，把真窗口埋进噪声里）。
       */
      const dispatchWindow = nodes.filter(
        (n) => n.dispatchGuard !== null && n.remoteTaskId === null && n.state === "working",
      );
      if (inFlight.length === 0 && dispatchWindow.length === 0) {
        continue; // 无在飞 / 无派发窗口：保留，交由调度循环续推
      }
      for (const node of inFlight) {
        updateTaskState(node.taskId, "failed", node.artifactsJson, FEATURE_INTERRUPTED_TEXT);
        summary.interruptedTasks += 1;
      }
      if (dispatchWindow.length > 0) {
        bridgeLog.warn(
          "a2a-feature",
          `Feature ${feature.featureId} 重建恢复：在飞 ${inFlight.length} 个按 interrupted 置 failed；派发窗口 ${dispatchWindow.length} 个保留 working（v0.8.8 O4：不启动即置 failed，交 machine 补结算回填，真失败由墙钟兜底）；Feature 保持 executing`,
          {
            site: "recover",
            featureId: feature.featureId,
            interrupted: inFlight.length,
            dispatchWindow: dispatchWindow.length,
          },
        );
      }
      // 不 failFeature：仅在确有在飞节点被置 failed 时驱动一次 tick，让静止收敛发账单。
      // 派发窗口节点保留 working ⇒ 不构成失败，不在此触发账单（见上 O4 说明）。
      if (inFlight.length > 0) this.kick();
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
      // v0.6.1 REQ-05 §2.5（N5）：**每 tick 一次**项目忙快照（tick 内稳定）——与进程内
      // `reservedProjects` 相并构成派发判据的「项目忙」集合（见 `occupiedProjects()`）。
      // ⚠️ v0.9.0 B10″：忙集判据**继续复用 `listBusyProjectIds()`**（其内部 = `busyProjectPredicate()`，
      // 含 `lane IS NULL` 归写档）—— 本节点只把下面 Feature 扫描的 `state` 过滤下推，**不动忙集谓词**。
      this.busyProjectIds = listBusyProjectIds();
      // v0.9.0 B10″：**`state='executing'` 过滤下推 SQL**（旧：`listFeatures({limit})` 扫全量再在
      // 内存里 `state !== "executing" ⇒ continue`）。等价性**只在 Feature 总数 ≤ `limit` 时成立**；
      // **> `limit` 时下推后是修复**（旧路径先按 `updated_at DESC` 截断 `limit` 条、再内存筛选 ⇒
      // 会漏扫排在窗口外的 `executing` Feature）。`executing` 恒非终态，故窗口内选取序不变。
      const features = listFeatures({ state: "executing", limit: 1000 });
      for (const feature of features) {
        void this.advanceFeature(feature);
      }
    } catch (err) {
      console.error(`[a2a-feature] 调度循环异常：${toMessage(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * **项目忙集合**（v0.6.1 REQ-05 §2.5 / N5）= 本 tick 的 DB 快照 ∪ 进程内预留。
   * 纯读，不改状态；供 {@link computeReadyNodes} 的第三参使用。
   */
  private occupiedProjects(): Set<string> {
    const occupied = new Set(this.busyProjectIds);
    for (const projectId of this.reservedProjects) occupied.add(projectId);
    return occupied;
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
    // **R1 · v0.11.0 orch-N5（消费点 ①）**：早退判据读的是 **DAG 节点集**，不是「按 Feature 取到的
    // 全部行」。阶段行与 `dag` 行同处一张读集 ⇒ 若仍看全量行数，一张**只有阶段行**的 Feature
    // （开轮物化后、首批 DAG 节点尚未登记的窗口是真实形态）顶不掉早退，把下面整条判据链空跑一遍，
    // 并且**阶段行自己的 `dependencies` 声明**会进 DAG 合法性校验（见 {@link validateDag} 口径）。
    const rows = listFeatureTasks(feature.featureId, { limit: 1000 });
    let nodes = rows.filter(isDagNode);
    if (nodes.length === 0) return;

    // 全量读集**只**交给 validateDag 一处：它的「依赖目标」判据需要非 DAG 行的**实际 `mode`**
    // 才能报准文案（只喂 DAG 节点集会把「依赖指向阶段行」误报成「悬空引用」—— 两种处置含义不同：
    // 前者是数据被绕过登记口写坏，后者才是真的引用不到）。N6 后读面已剔阶段行 ⇒ 这里能报准的
    // 只剩 `inquiry` 档，其余口径详见 {@link validateDag} 末段「与 orch-N6 读面过滤的口径差」。
    const dagError = validateDag(rows);
    if (dagError !== null) {
      this.failFeature(feature, dagError);
      return;
    }

    // 失败传播（幂等）：任一 failed → 下游传递闭包置 blocked。
    // v0.6.1 REQ-05：原「已中性化失败节点不得再触发传播」的豁免（第 6 处）随中性化族删除；
    // 判据回到单一事实 = 未处置 `failed`（`isUnhandledFailure`）。**N3 已落地收窄**：
    // 「只冻未派发下游」在 `propagateBlocked` 本体（`remoteTaskId === null` 过滤），此处不变。
    // **v0.10.8 O-4（②）**：失败集先按 `isDagNode` 收窄 ⇒ inquiry 的 `failed` **不**触发传播、
    // **不**冻真 DAG 下游（其结算路径亦已在 `notifyTaskSettled` 早退）。
    const failedIds = nodes
      .filter((n) => isDagNode(n) && isUnhandledFailure(n))
      .map((n) => n.taskId);
    if (failedIds.length > 0) {
      let blockedAny = false;
      for (const failedId of failedIds) {
        if (this.propagateFailure(feature, failedId).length > 0) blockedAny = true;
      }
      // 重读同样收窄（消费点 ① 的第二处取集）⇒ 下面 `reduceConvergence` / `computeReadyNodes` /
      // 静止判据拿到的始终是同一口径的 DAG 节点集。
      if (blockedAny)
        nodes = listFeatureTasks(feature.featureId, { limit: 1000 }).filter(isDagNode);
    }

    const convergence = reduceConvergence(nodes);
    if (convergence.kind === "needs_input") {
      this.needsInputFeature(feature, convergence.reason);
      return;
    }
    if (convergence.kind === "all_completed") {
      this.transition(feature, "integrating", "全部任务达终态（调度器自动）");
      return;
    }

    // 就绪集合（拓扑并行）：同层无依赖节点整批并发派发。
    // v0.6.1 REQ-05 §2.5（N5）：第三参 = 「项目忙」集合（DB 快照 ∪ 进程内预留）⇒ **同 project 排队**；
    // 且 `computeReadyNodes` 内部**同批顺序认领** ⇒ 同批内同 project 至多取一个（串行不变式在批内亦成立）。
    const ready = computeReadyNodes(nodes, this.inFlightNodes, this.occupiedProjects());
    if (ready.length === 0) {
      // ⚠️ 触发点**必须晚于**就绪计算（v0.6.1 REQ-05 §2.1 / N3）：严禁在 `reduceConvergence`
      // 处提前 return —— 那会连带停掉同一 Feature 内**仍可派发的独立分支**（A 失败、B 无依赖仍
      // `working`）。走到这里 `ready` 已为空，才轮到「静止收敛」判据。
      // 判据不受闭包限制条件影响：`ready.length > 0` 时**照常派发**（其余节点不被 failure 连座）。
      //
      // **v0.6.1 REQ-05 §2.5（N5）不变量 I-N（静止期禁 ensure）**：本 `return` 是引擎侧
      // 「静止期零 ensure」的**唯一落点** —— 静止（失败静止）与 `needs_input` 期都表现为
      // 「本 Feature **零派发**」：`ready.length === 0` ⇒ 下面不上任何 `dispatchNode` ⇒
      // 不调 `dispatchTask` ⇒ **不触 `ensure`**；且静止 ⇒ 无 `working` 节点 ⇒ 无在飞 ⇒ 无看护
      // ⇒ **无 `renew`（第二条 ensure 通道）**。`needs_input` 更外层：`tick()` 只扫 `executing`，
      // 根本进不到本函数。故此处**不新增子态判据位**（新增必为恒真死代码；§2.5 明令不新增状态位）。
      if (this.featureAtRest(feature.featureId, nodes)) {
        this.reportFailureAtRest(feature, nodes);
      }
      return; // 队列等待前序依赖中 / 项目忙排队 / 全部在飞 / 静止（零动作、无 ensure）
    }

    // Feature 级批门闩 + 节点级在飞标记 + **项目预留**：**同一段同步代码**（全部在 `await` 前完成，
    // 保证同 tick 多 Feature 并发进入时项目竞争失败者本批跳过、下 tick 重算 —— §2.5 硬约束 1）。
    const batchProjects = [...new Set(ready.map((node) => node.projectId))];
    this.dispatching.add(feature.featureId);
    for (const node of ready) this.inFlightNodes.add(node.taskId);
    for (const projectId of batchProjects) this.reservedProjects.add(projectId);
    try {
      const results = await Promise.all(ready.map((node) => this.dispatchNode(node)));
      let failedNodesInBatch = 0;
      for (let i = 0; i < ready.length; i += 1) {
        const node = ready[i];
        const result = results[i];
        if (node === undefined || result === undefined) continue;
        if (!result.ok) {
          // v0.6.1 REQ-05 §2.1（N3）**C1 同批**：派发失败**只落库 failed + 传播**，
          // **不 `failFeature`、不 return** —— `return` 会把本批其余节点的结果（`settled`）整批丢弃。
          // 同批节点互相无依赖边，故逐个传播（各自冻结其**未派发**下游）是安全且必要的；
          // 在飞兄弟节点因 `remoteTaskId !== null` 不被冻结（新过滤），等看护自然结算。
          const reason = result.error ?? `派发任务 ${node.taskId} 失败`;
          updateTaskState(node.taskId, "failed", null, reason);
          const blocked = this.propagateFailure(feature, node.taskId);
          bridgeLog.error(
            "a2a-feature",
            `Feature ${feature.featureId} 节点 ${node.taskId} 派发失败（同批继续处理）：${reason}；冻结未派发下游 ${blocked.length} 个`,
            { site: "advanceExecuting.dispatchFailed", taskId: node.taskId, blocked: blocked.length },
          );
          failedNodesInBatch += 1;
          continue;
        }
        if (result.settled !== undefined) {
          this.notifyTaskSettled(feature.featureId, node.taskId, result.settled);
        }
      }
      if (failedNodesInBatch > 0) {
        // 同批有失败：交给下一 tick 的静止收敛判据记账（本批仍在 finally 清理在飞标记）。
        bridgeLog.warn(
          "a2a-feature",
          `Feature ${feature.featureId} 本批 ${failedNodesInBatch} 个节点派发失败，Feature 保持 executing（等静止收敛）`,
          { site: "advanceExecuting.batchFailed", failed: failedNodesInBatch },
        );
      }
    } finally {
      // 释放时点 = 批次 `finally`（与 `inFlightNodes` 清理**同段**，§2.5 硬约束 1）：
      // 此后节点态/远端 id 已由各 `dispatch` 实现落库（未落库/失败者亦非在飞）⇒ 项目忙由
      // 下一 tick 的 DB 快照接管，进程内预留功成身退。
      for (const node of ready) this.inFlightNodes.delete(node.taskId);
      for (const projectId of batchProjects) this.reservedProjects.delete(projectId);
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
   * 失败传播：把 `failedTaskId` 的全部下游（传递闭包）`working` **且未派发**的 **DAG 节点**
   * 置 `blocked`，返回被阻塞的节点 id 列表。
   *
   * ⚠️ 入参集合与种子都限 **DAG 节点集**（R1 · v0.11.0 orch-N5）—— 非 DAG 行既不被冻、
   * 也不能当种子。`propagateBlocked` / `descendantClosure` 本身保持 mode 无关（纯函数、
   * 与 `planResume` 共用同一份反向边构造 ⇒ 判据留在消费侧，不在纯函数里开第二处 mode 比较）。
   */
  private propagateFailure(feature: FeatureRecord, failedTaskId: string): string[] {
    // **R1 · v0.11.0 orch-N5（消费点 ③）**：反向闭包只在 **DAG 节点集**内算。两条后果：
    // - **阶段行不被冻**：`propagateBlocked` 的冻结核算是 `working ∧ remoteTaskId === null`，
    //   而阶段轮行的**常态形状恰好就是这一条**（长期待回执、永不派发 ⇒ 远端 id 恒空）⇒ 不过滤
    //   时，任一 DAG 失败会把它冻成 `blocked`（写 `finished_at`），R1 的「长期可见、被指名」当场失效。
    // - **非 DAG 的 `failedTaskId` 进来也零动作**：除了闭包不含它，还有一条**种子判定** ——
    //   种子行本身必须在节点集内（见下 `dag.some(...)`）。不这么写的后果：`buildDownstreamIndex`
    //   的反向边取自 **DAG 行自己的 `dependencies` 声明**，一条被（绕过闸①）写坏的 DAG 行若恰好
    //   声明依赖某阶段行，该阶段行就成了反向边的键 ⇒ 拿它当种子照样能冻真节点。种子判定把这条
    //   口子也从「靠调用方自觉」变成「本函数自证」。调用点侧两处（`advanceExecuting` 的失败集 /
    //   `notifyTaskSettled` 的早退）本卡之前就已各自拦下 ⇒ 这里是**第三道保险**。
    const dag = listFeatureTasks(feature.featureId, { limit: 1000 }).filter(isDagNode);
    if (!dag.some((n) => n.taskId === failedTaskId)) return [];
    const blocked = propagateBlocked(failedTaskId, dag);
    for (const id of blocked) updateTaskState(id, "blocked");
    return blocked;
  }

  /**
   * **静止判据**（v0.6.1 REQ-05 §2.1 / N3）：Feature 是否处于「失败静止」。
   *
   * `atRest := 节点集 every(state ≠ 'working') ∧ !dispatching ∧ 无 inFlight（含批内未落库窗口）
   *            ∧ 存在 failed/blocked`
   *
   * 说明：
   * - **第一项**（而非「ready 为空」）才排除「刚 settled 仍在看护」的误判；
   *   `working ∧ remoteTaskId !== null`（派发后丢看护的悬挂态）**算在飞**，兜底 = 桥重启对账；
   * - `dispatching` / `inFlightNodes` 是「派发未落库窗口」的防误判（本类私有态 ⇒ 判据只能落实例方法）；
   * - **存在 failed/blocked** 是必要条件：否则「全 `completed`」由 `reduceConvergence` 走
   *   `all_completed`（另一叙事）；「无就绪但依赖未满足」的队列等待**不是静止**。
   *
   * **v0.10.8 O-4（②）**：判据读的是**节点集合** ⇒ 先按 {@link isDagNode} 收窄。inquiry 行既不算
   * 「在飞拖延静止」，也不算「存在 failed/blocked」的静止理由（否则 inquiry 失败会替整单发账单）。
   */
  private featureAtRest(featureId: string, nodes: readonly TaskRecord[]): boolean {
    const dag = nodes.filter(isDagNode);
    if (dag.length === 0) return false;
    if (this.dispatching.has(featureId)) return false;
    if (dag.some((n) => n.state === "working")) return false;
    if (dag.some((n) => this.inFlightNodes.has(n.taskId))) return false;
    return dag.some((n) => n.state === "failed" || n.state === "blocked");
  }

  /**
   * **封存谓词**（v0.6.1 REQ-05 §2.1 / N3，**单一入口，不散落**）：
   * `featureAtRest ∨ featureState === 'needs_input'`。
   *
   * 语义 = 「远端结算**只落库任务态**，不改 Feature 态、不传播」：
   * - 静止（失败静止）：防「迟到结算 → 传播 / 推进」破坏静止（防 C5 漂移）；
   * - `needs_input`：它是**唯一交人出口**（单一来源②），迟到结算不得把它判死或推进
   *   （旧行为 `failFeature` 会把 `needs_input` 打成 `failed` ⇒ 用户正在看的澄清入口消失）。
   *   ⚠️ 与「`needs_input → executing` 续推」不冲突：那是宿主显式 `advance`，届时已非封存态。
   */
  private isFeatureSealed(feature: FeatureRecord): boolean {
    if (feature.state === "needs_input") return true;
    if (feature.state !== "executing") return false;
    // **R1 · v0.11.0 orch-N5（消费点 ④）**：取集处显式过 `isDagNode`，与 `advanceExecuting`
    // 交给 `featureAtRest` 的那份集合**同口径**（此前一处传收窄集、一处传全量集，靠 `featureAtRest`
    // 内部再滤才没出岔 ⇒ 本处把口径写进取数行，不再依赖被调方兜底）。阶段行既不构成「在飞拖延
    // 静止」，也不构成「存在 failed/blocked 的静止理由」⇒ 含阶段行不破坏封存判定。
    return this.featureAtRest(
      feature.featureId,
      listFeatureTasks(feature.featureId, { limit: 1000 }).filter(isDagNode),
    );
  }

  /**
   * **失败静止账单**（v0.6.1 REQ-05 §2.1 / §2.4，N3）：Feature 保持 `executing`（**态不转移**、
   * 零动作），写一条 {@link EVENT_FAILURE_REPORT}（`events.state = null`：态没变）。
   * 去重见 {@link failureReportSignatures}（signature 不变即不重发）。
   * 载荷口径：`contextId` = **`TaskRecord.contextId`**（节点会话，供同 ctx 续推重派）、
   * `text` = 节点 `text`（可 `null`）、`blockedSet` = 冻结集（sorted）、
   * `failureKind` = 节点 `failureKind`（**v0.8.8 O10**：取既有读口的行值，**未在 scheduler 内分类**；
   * 未分类 ⇒ 键保留、值为 `null`，便于宿主区分「未分类」与「字段缺失」）。
   *
   * **v0.10.8 O-4（②）**：账单明细同样只取 **DAG 节点集**（`isDagNode`）⇒ inquiry 的失败 / 阻塞
   * **不进账单**（`failed[]` / `blockedSet` 皆不含它，signature 亦随之不含 ⇒ 不因 inquiry 状态变化重发）。
   */
  private reportFailureAtRest(feature: FeatureRecord, nodes: readonly TaskRecord[]): void {
    const dag = nodes.filter(isDagNode);
    const failed = dag.filter((n) => n.state === "failed");
    const blockedIds = dag
      .filter((n) => n.state === "blocked")
      .map((n) => n.taskId)
      .sort();
    const failedIds = failed.map((n) => n.taskId).sort();
    const failedKey = failed
      .map((n) => `${n.taskId}:${n.retryCount}`)
      .sort()
      .join(",");
    const signature = `${failedKey}|${blockedIds.join(",")}`;
    if (this.failureReportSignatures.get(feature.featureId) === signature) return;
    this.failureReportSignatures.set(feature.featureId, signature);
    appendEvent({
      featureId: feature.featureId,
      taskId: null,
      kind: EVENT_FAILURE_REPORT,
      state: null,
      payload: JSON.stringify({
        failed: failed.map((n) => ({
          taskId: n.taskId,
          projectId: n.projectId,
          text: n.text,
          contextId: n.contextId,
          failureKind: n.failureKind ?? null,
        })),
        blockedSet: blockedIds,
      }),
    });
    bridgeLog.warn(
      "a2a-feature",
      `Feature ${feature.featureId} 失败静止（保持 executing，零动作）: failed ${failedIds.length} / blocked ${blockedIds.length}；已发 ${EVENT_FAILURE_REPORT}`,
      { site: "reportFailureAtRest", failed: failedIds.length, blocked: blockedIds.length },
    );
  }

  /**
   * 置 failed；已终态或非法流转时返回 false。
   *
   * v0.6.1 REQ-05 §2.1（N3）**收窄后的唯一调用面 = `validateDag` 失败**（结构性不可恢复）；
   * 业务失败改由静止收敛叙事承载（`propagateFailure` + `EVENT_FAILURE_REPORT`），
   * 显式取消走 `a2a_feature_cancel`（`state-machine` 的「any 非终态 → cancelled」）；
   * `failed` 的收口归档亦走此口（表外 —— 转移表 `failed: []` 不变，由 cancel 守卫直写放行）。
   */
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

  /** 置 needs_input（仅在允许流转时；记录触发任务由调用方文本说明） */
  private needsInputFeature(feature: FeatureRecord, reason: string): boolean {
    const current = getFeature(feature.featureId);
    // v0.5.1 D1（④）：三处静默 `return false` **各补** log + 一条 `transition_skipped` 事件
    // （**态没变** ⇒ `state` 列写 `null`，且**不写** `feature.state`）；四个 code 全部可达。
    // 调用方一律丢弃返回值，故留痕是**唯一**可观测路径。
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
 * DAG 合法性校验：**只在 DAG 节点集上**查 悬空引用 / 依赖指向非 DAG 行（`inquiry` / `stage`）/ 环
 * → 返回错误说明（调度器据此置 Feature failed）。
 * 依赖引用的是**同一 Feature 内的本地 taskId**。
 *
 * **v0.10.8 orch-N7 · dep 双闸的闸②**：`dependencies` 指向 `mode="inquiry"` 的行即报错，
 * 判据与 `registerFeatureNode` 的闸①同源（共用 {@link isDagNode}，不开第三口子）。
 * 本闸不是为「正常登记」而设（那条路闸①已在 `createTask` 前拒掉），堵的是**绕过登记口**的
 * 写入（存量数据 / 直改库）：inquiry 行自 O-2 起携带 `featureId` ⇒ 就落在同一 Feature 任务集内，
 * 下面的悬空引用判据**会放行**它，随后 `depStateOf` 让下游按这个只读行的态做 gating
 * （只读行 `failed` / `blocked` ⇒ 下游恒 `upstreamFailed`、**永不派发**）⇒ 必须响亮报错而非静默放行。
 *
 * ⚠️ 存量行 `mode` NULL 已由读侧归一为 `"dag"` ⇒ 本判据对存量**恒不触发**（零行为变化）。
 * R1 · v0.11.0 orch-N2：判据翻正后本闸同时拦下 `mode="stage"` 的阶段轮行（它长期停在待回执态
 * ⇒ 下游恒 `pending`，比只读行的静默挡更隐蔽）；错误文案的 mode 值**取行本身**，不硬编码
 * `inquiry`。闸的**判据本身未动**（仍是 {@link isDagNode} 单一事实源，不开第三口子）。
 *
 * **R1 · v0.11.0 orch-N5（消费点 ②）—— 入参口径与「被校验集合」分离**：
 * - 入参 `rows` = 按 Feature 取到的**全量读集**（含非 DAG 行）。这是刻意的：依赖目标要靠它查
 *   `mode`，只喂 DAG 节点集就退化成「悬空引用」文案，把「有人绕过登记口写了非法 dep」与
 *   「引用了一个根本不存在的 id」两种处置混成一条。
 * - **被校验的节点集** = `rows.filter(isDagNode)`。判据（悬空 / 非 DAG 依赖 / 环）只跑在 DAG 行
 *   的 `dependencies` 声明上 ⇒ **阶段行自己的依赖声明不再当 DAG 合法性判据**。旧形态的实际后果：
 *   一张只有阶段行的 Feature（`advanceExecuting` 顶不掉早退时）会因某条阶段行的 `dependencies`
 *   指向阶段行 / 悬空 ⇒ `validateDag` 报错 ⇒ `failFeature` **把整单打死** —— 而阶段行根本不在
 *   DAG 里，它写了什么不该由 Feature 的 DAG 合法性买单。
 * - **仍然拒收阶段行**：非 DAG 行**作为依赖目标**出现 ⇒ 响亮报错（上面那条闸），文案点名其
 *   实际 `mode`。两道判据合起来 = 「阶段行既不被拉进 DAG 校验，也不许被别人拉进 DAG」。
 *
 * ⚠️ **与 orch-N6 读面过滤的口径差**（行为不变、措辞降级）：N6 起 `listFeatureTasks` 拼
 * `NON_STAGE_MODE_SQL` ⇒ 传入的 `rows` 里**已经没有阶段行**（只剩 `inquiry` 与存量 NULL 归一行）。
 * 于是「dag 行依赖阶段行」这条现在落**悬空引用**文案，而不是 `mode="stage"` 精确点名 ——
 * 两者都是响亮拒收 + `failFeature`，只是可对账精度下降；精确点名的责任回到**闸①**
 * （`bridge/index.ts` 挂载侧 `dependency_is_inquiry`，改 `mode` 值域时那里才是第一现场）。
 * 本闸的 `mode` 插值文案仍由 `test/v0110-n5-*.test.ts` 直接喂集合取证（第二道保险不能因为
 * 第一道保险生效就成为测不到的死代码）。
 */
export function validateDag(rows: readonly TaskRecord[]): string | null {
  /** 依赖目标查表用**全量读集**（要能报出非 DAG 行的实际 `mode`） */
  const byId = new Map(rows.map((n) => [n.taskId, n]));
  /** 被校验集合 = DAG 节点集（消费点 ② 的收窄处） */
  const nodes = rows.filter(isDagNode);
  for (const node of nodes) {
    for (const dep of node.dependencies ?? []) {
      const depNode = byId.get(dep);
      if (depNode === undefined) {
        return `任务 ${node.taskId} 依赖悬空引用 ${dep}（不在本 Feature 任务集内）`;
      }
      if (!isDagNode(depNode)) {
        return `任务 ${node.taskId} 依赖 ${dep} 不是 DAG 节点（mode="${depNode.mode}"），不可作为 DAG 依赖`;
      }
    }
  }
  // DFS 三色环检测。起点集与遍历面都是 DAG 节点集：上面已保证「dag 行的依赖目标必为 dag 行」
  // （否则当场返回错误），故 `byId` 取到的后继不会越出节点集，无需在递归内再判一次 mode。
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
