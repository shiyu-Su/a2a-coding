/**
 * 板侧**心跳监视 + 唤醒点火**（v0.9.5 C8 · T8）。
 *
 * 事实源：改造文档 `doc/v0.9.5/推进流程精简-改造文档.md` §2-C8（v5）；
 * 需求确认单 §6（挂起-唤醒）/ §7.3（心跳监视 = 板内 watch 镜像）/ §8（板侧双判定）。
 *
 * ## 它解决什么
 * 宿主 agent「只在线干活、不在线等待」：下发 inquiry 子任务后调板侧**挂起口**（C7 台账）即退出，
 * **一个 `setInterval` 心跳**按拍扫 suspended 台账 + 自动 armed 目标，逐条做**定条件评估**
 * （读既有只读面：`getFeature` 引擎态 / `getTask` 子任务结果），命中后经**接力驱动器**点火
 * （同 `contextId` 新一轮，提示词带「到 X 态 / 子任务 Y 就绪，请处理」的**结构化事实**）。
 *
 * ## R2 收敛四条规格（本模块逐条落实）
 * ① **定时器生命周期**：`start()` 建 `setInterval` + `unref()`；`stop()` `clearInterval()`。
 *    装配层（`index.ts` 停机链）**先 `stop()` 再 `stopAll()`**（写死先后，防停机途中心跳复活桥）。
 * ② **防重入**：`tick()` 有 in-flight 标志，多条串行单拍可能超拍 ⇒ 未跑完时下一拍直接跳过。
 * ③ **心跳只读调用不得刷新桥 `lastActivityAt`**：本模块的读面只有 `BridgeClient`（3300 只读运维面）
 *    与 `sweepIdle`（只改被回收桥的状态）；**不调 `beginRound`/`ensureStarted`/`submitTurn` 之外的桥写面**
 *    —— 只有真正命中点火时才经接力驱动器发轮（那是真实轮，理应刷新活动时间）。⇒ idle 回收不被心跳干扰。
 * ④ **停链标志 / 链内计数载体归 C1–C4 单一定义**：本模块只经 {@link HeartbeatRelayView} **只读**
 *    （`isChainStopped` / `chainCount` / `chainLimit`）与**经接力驱动器点火**（点火自会自增链内计数），
 *    **不另造**任何链状态。
 *
 * ## ⑤ 兜底条（R2 收敛本版做）
 * inquiry 轨宿主**忘调挂起口** ⇒ 台账里没有条目，但板在轮收口时已 `succeeded + executing` 自动 armed
 * （MON2，见 `host-relay.ts` 的 `onMonitor`）⇒ 心跳跟踪该需求的登记 `stage` 是否长期不动：
 * - 阈值取**调度拍量级（≥ 数分钟，非秒级）**，见 {@link DEFAULT_FALLBACK_THRESHOLD_MS}；
 * - 去重键 `(featureId, stage)`：同一条件只兜底一次，二次不唤（交人裁决）；
 * - 唤醒词显式声明 {@link FALLBACK_WAKE_LABEL}，防正常长任务被误判。
 *
 * ## ⑥ 交人闸（v0.9.8 心跳自火交人闸）
 * 点火前经窄读面 {@link HeartbeatDeps.awaitingHeld} 查板侧**当前待澄清的一轮**（`awaiting_answer` ∧
 * 未被更新轮取代 = `BoardHostFace.awaitingTurnOf`）：存在 ⇒ 本拍对该需求**不自火**（不组装提示词、
 * 不调 fire、返 `null` 不计入 `fired[]`），保住用户手里的待答问题。
 * - **绝不记去重键**（`firedKeys` / `scope.record`）：记了会让用户答完后的同一条件**永久失声**；
 *   挡后下一拍照旧重评；
 * - 位置在**去重判定之后、组装提示词之前**（不前移到 `readEngine` 之前 ⇒ 不每拍多读盘；不进
 *   {@link evaluateWake} ⇒ 纯评估器的引擎事实不掺板侧会话态）；
 * - **fail-closed**：谓词抛错 ⇒ 按「有待澄清轮」处置（不点火）并留痕；
 * - 未注入谓词 ⇒ 行为零变更（向后兼容，故本字段**必须可选**）；
 * - 经 `evalTrace` 留一行 `verdict=awaiting-held`。
 *
 * ## 与 watch 脚本同构
 * 退出判据用 watch-task 同一份闭集 {@link SETTLED_TASK_STATES}（未知 state 一律按「未完成」）。
 * **判据分档（v0.9.5 增补 · D3）**：**有 `pending` 清单 ⇒ 一律按 pending 是否全就绪判**，
 * 引擎态非 `executing` **不再**单独构成命中 —— Step 0/1 的需求长停靠 `waiting_approval`，
 * 旧短路会把该档变成恒真（每拍空转烧轮）。`pending` 为空才走纯 DAG 监视语义（原样）。
 * 未知 id（404）按「读不到 ⇒ 不就绪」保守处理，**不假唤醒**（真兜底交给 ⑤）。
 */
import { isTerminalFeatureState } from "./derive.js";
import { RECEIPT_CONTRACT } from "./receipt.js";
import type { SuspendedEntry } from "./suspend-ledger.js";

// ---------------------------------------------------------------------------
// 口径常量
// ---------------------------------------------------------------------------

/** 唤醒轮提示词标题行前缀（用例据此钉住「提示词不含任何编排桥工具全名」）。 */
export const HEARTBEAT_PROMPT_TITLE = "【板 · 唤醒】";

/** ⑤ 兜底唤醒的显式标签（防正常长任务被误判为「忘调挂起口」）。 */
export const FALLBACK_WAKE_LABEL = "疑似漏调挂起口·仅异常兜底";

/** 心跳缺省间隔（取调度拍量级；测试注入更小值）。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** ⑤ 兜底阈值缺省 5 分钟（调度拍量级且 ≥ 数分钟，非秒级）。 */
export const DEFAULT_FALLBACK_THRESHOLD_MS = 300_000;

/**
 * 子任务「就绪」闭集（与 `scripts/watch-task.mjs` 的 `ACHIEVED_TASK_STATES` **逐字同源**）：
 * `completed` / `failed` / `blocked` / `input-required`。**未识别 state 一律按未就绪**（保守，防假唤醒）。
 *
 * **`input-required` 计入闭集 = 本版定案（v0.9.5 增补 · D3，不再摇摆）**：
 * `input-required` 的语义是「子任务停下来要人 / 宿主裁决」—— 它**正是需要唤醒宿主的那一刻**，
 * 不是「还没跑完」。若不计入，挂起条目会**静默永不满足**，只能靠 ⑤ 兜底（且兜底只对无条目的
 * auto 目标适用），现场表现为「子任务在等人，板却一声不吭」。计入后的口径：
 * - **唤醒时机** = 该 pending 清单**全部**落在这四值之一（含 `input-required`）即点火；
 *   单条 `input-required` 其它条仍 `working` ⇒ 仍不唤（等齐，避免半截唤醒）；
 * - **不静默吞掉**：`input-required` 的**内容**由唤醒提示词的结构化事实面交还宿主处置
 *   （板不解析任务文本），点火之后经 `firedKeys` 去重、链内计数与上限照常执法；
 * - **反向保险**：若某条永不到这四值（如长期 `working`），条目**不会**被 ⑤ 兜底误唤
 *   （⑤ 只服务 `auto ∧ dag.length === 0` 的漏调挂起口形态），最终由链内计数上限收口交人。
 */
export const SETTLED_TASK_STATES: readonly string[] = ["completed", "failed", "blocked", "input-required"];

/** 子任务 state 是否已到「就绪」（终态 / 需人态；未知 ⇒ false）。 */
export function isSettledTaskState(state: string | null): boolean {
  return state !== null && SETTLED_TASK_STATES.includes(state);
}

/**
 * DAG 节点的**异常终态**（发起改造轨：节点挂 Feature 下、引擎轨可见，无需 pending 回传）：
 * `failed` / `blocked` / `input-required` ⇒ 唤醒宿主处置（重派 / 补节点 / 交人）。
 */
export const DAG_FAILURE_TASK_STATES: readonly string[] = ["failed", "blocked", "input-required"];

/** DAG 节点 state 是否属异常终态（未知 / 运行中 ⇒ false）。 */
export function isDagNodeFailure(state: string | null): boolean {
  return state !== null && DAG_FAILURE_TASK_STATES.includes(state);
}

/** 一个 DAG 节点的 state 快照（`getFeature` 的 `tasks[]` 投影）。 */
export interface WakeDagTask {
  taskId: string;
  state: string;
}

// ---------------------------------------------------------------------------
// 纯函数：定条件评估
// ---------------------------------------------------------------------------

/** 命中种类：`dag-terminal` = 引擎终态，或（无 pending 时）引擎态已离开执行中（含验收 / 待澄清）；`pending-ready` = 子任务就绪；`fallback` = 兜底条。 */
export type WakeKind = "dag-terminal" | "pending-ready" | "fallback";

export interface WakeDecision {
  hit: boolean;
  /** 未命中 ⇒ null。 */
  kind: WakeKind | null;
  /** 去重键（同一条件只唤一次）；未命中 ⇒ null。 */
  key: string | null;
  reason: string;
  /** 供提示词组装的结构化事实（板侧只读快照，非解析 agent 文本）。 */
  facts: string[];
}

export interface WakeEvalInput {
  featureId: string;
  /** 收口后重取的引擎态；`null` = 读面失败 ⇒ 保守不点火。 */
  engineState: string | null;
  engineStage: string | null;
  /** 挂起条目的 pending 清单（auto 目标恒为 `[]`）。 */
  pending: readonly string[];
  /** `taskId -> state`（`null` = 读不到 / 未知 —— 按未就绪处理）。 */
  pendingStates: Readonly<Record<string, string | null>>;
  /** 该需求 DAG 节点的 state 快照（发起改造轨，`getFeature` 的 `tasks[]`）；缺省 `[]` = 无 DAG。 */
  dagTasks?: readonly WakeDagTask[];
  /** `true` = 无显式挂起条目的**自动 armed** 目标（纯 DAG 监视，⑤ 兜底适用）；`false` = 台账条目。 */
  auto: boolean;
  /** 登记 `stage` 最近一次变化的距今毫秒（auto 目标用；`null` = 不适用 / 未知）。 */
  stageUnchangedMs: number | null;
  fallbackThresholdMs: number;
}

function noWake(reason: string): WakeDecision {
  return { hit: false, kind: null, key: null, reason, facts: [] };
}

/**
 * **该不该唤醒**（纯函数，确认单 §6/§7.3 的定条件评估）。
 *
 * 判定序（命中即返回，互斥）：
 * 1. 引擎态读面失败（`null`）⇒ 保守不点火；
 * 2. 引擎终态（completed / failed / cancelled）⇒ `dag-terminal`（宿主被唤醒去收尾）；
 * 3. **`pending` 非空 ⇒ 一律按 pending 就绪判**（不看引擎态，v0.9.5 增补 · D3）：
 *    全部到终态（{@link isSettledTaskState}）才 `pending-ready`，任一未到 ⇒ 继续监视。
 *    —— Step 0/1（需求分析 / 改造方案）的需求实体长停靠 `waiting_approval`，**引擎态非 `executing`
 *    是常态而非信号**；旧实现在这里短路成 `dag-terminal` ⇒ 判据恒真、每拍都唤，心跳退化成
 *    「按间隔空转烧轮」。子任务是否就绪**只能看 `pending[]`**。
 * 4. `pending` 为空（纯 DAG 监视语义，**按原样不动**）：
 *    - 引擎态已离开执行中（reviewing / needs_input / integrating …）⇒ `dag-terminal`
 *      （宿主被唤醒去收尾 / 验收 / 处置澄清）；
 *    - 引擎 `executing` ⇒ DAG 节点有失败 / 阻塞（{@link isDagNodeFailure}）或全 `completed`
 *      ⇒ `dag-terminal`；
 *    - 引擎 `executing` ∧ 无 DAG（inquiry 轨）∧ `auto`（忘调挂起口自动 armed）∧ `stage` 长期不动 ≥ 阈值
 *      ⇒ `fallback`（⑤ 兜底）。
 */
export function evaluateWake(input: WakeEvalInput): WakeDecision {
  const state = input.engineState;
  if (state === null) return noWake("引擎态读面失败 ⇒ 保守不点火");
  if (isTerminalFeatureState(state)) {
    return {
      hit: true,
      kind: "dag-terminal",
      key: `state:${state}`,
      reason: `引擎已到终态 ${state}`,
      facts: [`引擎态 state = ${state}`, `登记 stage = ${input.engineStage ?? "未知"}`],
    };
  }
  // D3：有 pending 清单 ⇒ 就绪判**优先于**引擎态分流（Step 0/1 停靠 waiting_approval 时引擎态不承载信号）。
  if (input.pending.length > 0) {
    const waiting = input.pending.filter((id) => !isSettledTaskState(input.pendingStates[id] ?? null));
    if (waiting.length > 0) {
      return noWake(`pending 尚未全部就绪（待 ${waiting.join(" · ")}）· 引擎态 ${state} 不参与本档判定`);
    }
    const facts = input.pending.map((id) => `子任务 ${id} state = ${String(input.pendingStates[id] ?? "未知")}`);
    if (state !== "executing") facts.push(`引擎态 state = ${state}（登记 stage = ${input.engineStage ?? "未知"}）`);
    return {
      hit: true,
      kind: "pending-ready",
      key: `pending:${input.pending.join(",")}`,
      reason: `pending 清单全部就绪（${String(input.pending.length)} 项）`,
      facts,
    };
  }
  // 以下 = pending 为空的纯 DAG 监视语义（原样）。
  if (state !== "executing") {
    return {
      hit: true,
      kind: "dag-terminal",
      key: `state:${state}`,
      reason: `引擎态已离开执行中（${state}）`,
      facts: [`引擎态 state = ${state}`, `登记 stage = ${input.engineStage ?? "未知"}`],
    };
  }
  // 纯 DAG 监视（发起改造轨）：节点终态由 `getFeature` 的 `tasks[]` 直接可见（无需 pending 回传）。
  const dag = input.dagTasks ?? [];
  const failed = dag.filter((t) => isDagNodeFailure(t.state));
  if (failed.length > 0) {
    return {
      hit: true,
      kind: "dag-terminal",
      key: `dag-failed:${failed.map((t) => t.taskId).join(",")}`,
      reason: `DAG 有 ${String(failed.length)} 个节点失败 / 阻塞`,
      facts: failed.map((t) => `DAG 节点 ${t.taskId} state = ${t.state}`),
    };
  }
  if (dag.length > 0 && dag.every((t) => t.state === "completed")) {
    return {
      hit: true,
      kind: "dag-terminal",
      key: "dag-completed",
      reason: "DAG 节点全部 completed",
      facts: [`DAG ${String(dag.length)} 个节点均为 completed`],
    };
  }
  // 纯 DAG 监视：只有自动 armed 且**无 DAG 节点可见**（= inquiry 轨「忘调挂起口」）才适用 ⑤ 兜底。
  // 有 DAG 节点的改造轨由上面「节点失败 / 全 completed」与引擎态变化驱动，**不得**被 stage 长任务误判兜底。
  if (input.auto && dag.length === 0 && input.stageUnchangedMs !== null && input.stageUnchangedMs >= input.fallbackThresholdMs) {
    const seconds = Math.round(input.stageUnchangedMs / 1000);
    const thresholdSeconds = Math.round(input.fallbackThresholdMs / 1000);
    return {
      hit: true,
      kind: "fallback",
      key: `fallback:${input.engineStage ?? "unknown"}`,
      reason: `stage 长期不动（${String(seconds)}s ≥ ${String(thresholdSeconds)}s）⇒ 异常兜底`,
      facts: [
        `登记 stage = ${input.engineStage ?? "未知"} 已 ${String(seconds)}s 未变`,
        `引擎态仍在 executing（无显式挂起条目）`,
        FALLBACK_WAKE_LABEL,
      ],
    };
  }
  return noWake("引擎执行中且无 pending / stage 未达兜底阈值 ⇒ 继续监视");
}

/** 去重：该键是否已在 `firedKeys` 中（同一条件只唤一次）。 */
export function isFired(firedKeys: readonly string[], key: string | null): boolean {
  return key !== null && key !== "" && firedKeys.includes(key);
}

// ---------------------------------------------------------------------------
// 纯函数：唤醒提示词
// ---------------------------------------------------------------------------

export interface WakePromptInput {
  featureId: string;
  org: string;
  kind: WakeKind;
  reason: string;
  facts: readonly string[];
}

/**
 * 唤醒轮提示词（纯函数）。**不出现任何编排桥工具全名**（§3.6：各家后端工具名不同）；
 * 把命中条件作为**结构化事实快照**给 agent（板不解析 agent 文本，唯一例外 = 收口回执块
 * （`src/receipt.ts` `parseReceiptBlock`）：获准解析、且必须容错——不匹配即退回现状摘要，不劣于无解析）。
 */
export function buildWakePrompt(input: WakePromptInput): string {
  const lead =
    input.kind === "pending-ready"
      ? "板上心跳监测到：**你上轮下发的子任务已就绪**，请处理（同 contextId 新一轮）。"
      : input.kind === "fallback"
        ? `板上心跳监测到：**该需求登记 stage 长期未动**，疑似上一轮漏调挂起口（${FALLBACK_WAKE_LABEL}）。请先只读核对子任务结果，再决定继续 / 收口。`
        : "板上心跳监测到：**该需求引擎态已变化**，请处理（同 contextId 新一轮）。";
  const lines = [
    `${HEARTBEAT_PROMPT_TITLE} 需求 ${input.featureId} · 组织 ${input.org}`,
    "",
    lead,
    `命中条件：${input.reason}`,
    "结构化事实（板侧只读快照，非解析你的文本）：",
    ...input.facts.map((f) => `- ${f}`),
    "",
    "请以当前工作目录为本组织目录，按 AGENTS.md 的需求流程规范处理**当前该做的一步**：",
    "1. 先只读核对引擎态与子任务进展，不要凭猜测动手；",
    "2. 需要人决策就用 A2A 的 input-required 结束本轮，不要空转；",
    "3. 本轮若再次下发子任务，先调板侧挂起口登记 pending 清单再退出（见本组织 workspace 的 AGENTS.md）；",
    "4. 状态机推进（审批 / 推进 / 取消）只能经编排桥的能力做，板不代劳。",
    // v0.9.6 N6：唤醒轮同样是一轮收尾 ⇒ 引用同一契约常量。
    "",
    RECEIPT_CONTRACT,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 注入面（窄接口）
// ---------------------------------------------------------------------------

/** 收口后重取的引擎态（多带 `ownerGroup`：唤醒发轮要靠它定位组织）。 */
export interface HeartbeatEngineSnapshot {
  state: string | null;
  stage: string | null;
  approval: string | null;
  ownerGroup: string | null;
  /** DAG 节点 state 快照（`getFeature` 的 `tasks[]` 投影；缺省 `[]` = 无 DAG / 未读）。 */
  tasks?: readonly WakeDagTask[];
}

/** suspended 台账的窄读面（`SuspendLedgerStore` 结构满足）。 */
export interface HeartbeatLedger {
  list(): readonly SuspendedEntry[];
  get(featureId: string): SuspendedEntry | null;
  /** 记一次已唤（去重位）；返回是否新键。 */
  recordFired(featureId: string, key: string): boolean;
}

/** 接力驱动器的**只读**链状态面（停链标志 / 链内计数载体归 C1–C4 单一定义，本模块不另造）。 */
export interface HeartbeatRelayView {
  chainCount(requirementId: string): number;
  chainLimit(): number;
  isChainStopped(requirementId: string): boolean;
}

export interface HeartbeatFireInput {
  featureId: string;
  org: string;
  prompt: string;
  kind: WakeKind;
  key: string;
  /**
   * **挂起条目登记时的那一发板轮 `turnId`**（D1 撞车分诊的身份键）：
   * 占用者就是它 ⇒ 本拍跳过（那轮还在收口）；不是 ⇒ 视作同需求新一轮 ⇒ 退让等待。
   * 自动 armed 目标无条目 ⇒ `null`（一律按「新一轮」退让）。
   */
  turnId: string | null;
}

export interface HeartbeatFireResult {
  ok: boolean;
  reason: string;
  /** 点火撞到的占用轮 `turnId`（未撞 ⇒ `null` / 缺省）；供心跳结构化留痕。 */
  occupantTurnId?: string | null;
}

export interface HeartbeatDeps {
  ledger: HeartbeatLedger;
  /** 一跳只读重取引擎态；读面失败 / 未装配 ⇒ `null`（保守不点火）。 */
  readEngine(featureId: string): Promise<HeartbeatEngineSnapshot | null>;
  /** 子任务 state 只读探针；未知 id / 读面失败 ⇒ `null`（按未就绪处理）。 */
  readTaskState(taskId: string): Promise<string | null>;
  /** 经接力驱动器点火（同 `contextId` 新一轮；**自会自增链内计数**）。 */
  fire(input: HeartbeatFireInput): HeartbeatFireResult;
  relay: HeartbeatRelayView;
  /**
   * **交人闸窄读面**（⑥）：该需求当前是否存在「待澄清的一轮」（板侧 `awaiting_answer` ∧ 未被更新轮取代）。
   * 返回 `true` ⇒ 本拍对该需求**不自火**（见文件头 ⑥）。
   * **必须可选** —— 装配层之外（含 t9 锚点用例）以字面量 deps 构造心跳，非可选会连带改替身。
   */
  awaitingHeld?: (featureId: string) => boolean;
  /** `sweepIdle` 欠账补调用点（同拍驱动空闲回收）。 */
  sweepIdle(): Promise<string[]>;
  /** `ownerGroup` 缺失时的显式回退组织（板级默认）；`null` ⇒ 不猜。 */
  defaultOrg?: string | null;
  intervalMs?: number;
  fallbackThresholdMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

export interface WakeFireRecord {
  featureId: string;
  key: string;
  kind: WakeKind;
  fired: boolean;
  reason: string;
  /** 点火撞到的占用轮 `turnId`（未撞 ⇒ `null`）—— 撞车分诊的留痕面。 */
  occupantTurnId?: string | null;
}

export interface HeartbeatTickReport {
  /** 上一拍未跑完 ⇒ 本拍跳过（防叠拍）。 */
  skipped: boolean;
  /** 本拍实际回收的空闲组织。 */
  swept: string[];
  fired: WakeFireRecord[];
}

// ---------------------------------------------------------------------------
// 自动 armed 目标（MON2：无显式挂起条目、`succeeded + executing` ⇒ 板侧自动进监视）
// ---------------------------------------------------------------------------

interface AutoTarget {
  featureId: string;
  org: string;
  stage: string | null;
  /** 当前 `stage` 值首次被观察到的时刻（ms）；`stage` 变化即重置（⑤ 兜底计时起点）。 */
  stageSinceMs: number;
  /** 自动目标自己的去重位（同一条件只唤一次）。 */
  firedKeys: Set<string>;
}

// ---------------------------------------------------------------------------
// 心跳
// ---------------------------------------------------------------------------

/**
 * 单心跳实例：持有常驻 `setInterval`（**板首个常驻句柄**）与自动 armed 注册表。
 * 装配层在 `index.ts` 建并 `start()`；停机链**先 `stop()` 再 `stopAll()`**。
 */
export class Heartbeat {
  private readonly deps: HeartbeatDeps;
  private readonly auto = new Map<string, AutoTarget>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  /** 停机闸（`stop()` 置位）：已跑完在途一拍不再点火（防停机途中心跳复活桥）。`start()` 复位。 */
  private halted = false;

  constructor(deps: HeartbeatDeps) {
    this.deps = deps;
  }

  // -- 自动 armed 注册（接力驱动器 onMonitor 通知） --------------------------

  /**
   * 接力驱动器在每轮收口后告知监视归属：
   * - `auto` ⇒ 自动 armed（无条目但引擎仍执行中；本目标适用 ⑤ 兜底）；
   * - `suspend` / `none` ⇒ 撤销自动目标（条目 / 停链接管）。
   */
  noteMonitor(notice: { featureId: string; kind: "auto" | "suspend" | "none"; org: string; stage: string | null }): void {
    const id = notice.featureId.trim();
    if (id === "") return;
    if (notice.kind === "auto") {
      const existing = this.auto.get(id);
      if (existing === undefined) {
        this.auto.set(id, {
          featureId: id,
          org: notice.org,
          stage: notice.stage,
          stageSinceMs: this.now(),
          firedKeys: new Set(),
        });
      } else {
        existing.org = notice.org;
        if (existing.stage !== notice.stage) {
          existing.stage = notice.stage;
          existing.stageSinceMs = this.now();
        }
      }
      this.trace(id, "自动 armed（succeeded + executing + 无条目 ⇒ 纯 DAG 监视）");
      return;
    }
    if (this.auto.delete(id)) this.trace(id, `自动 armed 撤销（${notice.kind}）`);
  }

  /** 自动 armed 目标数（观测面）。 */
  autoArmedCount(): number {
    return this.auto.size;
  }

  /**
   * 该需求当前**是否被自动 armed 监视**（v0.9.5 增补二 · D2，读面快照用）：只读注册表，不改任何状态。
   * 显式挂起条目不算（那条由挂起台账侧给出 pending 条数）。
   */
  isAutoArmed(featureId: string): boolean {
    return this.auto.has(featureId.trim());
  }

  // -- 生命周期 -------------------------------------------------------------

  /** 起心跳（幂等）：`setInterval` + `unref()`；立即跑一拍，不空等一个间隔。 */
  start(): void {
    if (this.timer !== null) return;
    this.halted = false;
    const interval = this.intervalMs();
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.trace(null, `心跳已启动（interval ${String(interval)}ms，已 unref）`);
    void this.tick();
  }

  /** 停心跳（幂等）：`clearInterval`。装配层停机链在 `stopAll()` **之前**调用。 */
  stop(): void {
    this.halted = true;
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    this.trace(null, "心跳已停（clearInterval）");
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  // -- 一拍 -----------------------------------------------------------------

  /**
   * **一拍**（可单测直调）：防重入 → 空闲回收 → 扫台账 + 自动目标逐条评估 → 命中点火。
   * 上一拍未跑完 ⇒ 本拍跳过并如实回报（`skipped: true`）。
   */
  async tick(): Promise<HeartbeatTickReport> {
    if (this.inFlight) {
      this.trace(null, "上一拍未跑完 ⇒ 跳过本拍（防叠拍）");
      return { skipped: true, swept: [], fired: [] };
    }
    this.inFlight = true;
    try {
      const swept = await this.sweep();
      const fired = await this.scan();
      return { skipped: false, swept, fired };
    } finally {
      this.inFlight = false;
    }
  }

  // -- 内部 ----------------------------------------------------------------

  /** 空闲回收（⑤ 欠账：`sweepIdle` 全仓此前无调用点，由心跳同拍驱动；失败吞掉不阻断监视）。 */
  private async sweep(): Promise<string[]> {
    try {
      return await this.deps.sweepIdle();
    } catch (err: unknown) {
      this.trace(null, `空闲回收失败（已吞，不阻断监视）：${errorText(err)}`);
      return [];
    }
  }

  /** 扫 suspended 台账（显式挂起）+ 自动 armed 目标（有台账条目者跳过，条目优先）。 */
  private async scan(): Promise<WakeFireRecord[]> {
    const fired: WakeFireRecord[] = [];
    const entryIds = new Set<string>();
    for (const entry of this.deps.ledger.list()) {
      entryIds.add(entry.featureId);
      const record = await this.evaluateAndFire(
        {
          featureId: entry.featureId,
          pending: entry.pending,
          auto: false,
          /** 撞车分诊的身份键：本条目登记时的那一发板轮。 */
          turnId: entry.turnId,
          fired: (key) => entry.firedKeys.includes(key),
          record: (key) => this.deps.ledger.recordFired(entry.featureId, key),
        },
        null,
      );
      if (record !== null) fired.push(record);
    }
    for (const target of [...this.auto.values()]) {
      if (entryIds.has(target.featureId)) continue;
      const record = await this.evaluateAndFire(
        {
          featureId: target.featureId,
          pending: [],
          auto: true,
          turnId: null,
          fired: (key) => target.firedKeys.has(key),
          record: (key) => target.firedKeys.add(key),
        },
        target,
      );
      if (record !== null) fired.push(record);
    }
    return fired;
  }

  private async evaluateAndFire(
    scope: {
      featureId: string;
      pending: readonly string[];
      auto: boolean;
      /** 挂起条目的板轮 `turnId`（自动目标 ⇒ `null`）。 */
      turnId: string | null;
      fired: (key: string) => boolean;
      record: (key: string) => void;
    },
    target: AutoTarget | null,
  ): Promise<WakeFireRecord | null> {
    const featureId = scope.featureId;
    // 只读链状态：停链 ⇒ 不点火；链内计数触顶 ⇒ 交人。
    if (this.deps.relay.isChainStopped(featureId)) {
      this.trace(featureId, "停链标志已置 ⇒ 不点火");
      return null;
    }
    if (this.deps.relay.chainCount(featureId) >= this.deps.relay.chainLimit()) {
      this.trace(featureId, "链内连续点火计数触顶 ⇒ 停链交人");
      return null;
    }
    const engine = await this.readEngine(featureId);
    if (engine === null) {
      this.trace(featureId, "引擎态读面失败 ⇒ 保守不点火");
      return null;
    }
    // auto 目标：跟踪 stage 变化（⑤ 兜底计时）。
    let stageUnchangedMs: number | null = null;
    if (target !== null) {
      if (target.stage !== engine.stage) {
        target.stage = engine.stage;
        target.stageSinceMs = this.now();
        this.trace(featureId, `stage 变化（${engine.stage ?? "未知"}）⇒ 兜底计时重置`);
      }
      stageUnchangedMs = Math.max(0, this.now() - target.stageSinceMs);
    }
    const pendingStates = await this.readPending(scope.pending);
    const decision = evaluateWake({
      featureId,
      engineState: engine.state,
      engineStage: engine.stage,
      pending: scope.pending,
      pendingStates,
      dagTasks: engine.tasks ?? [],
      auto: scope.auto,
      stageUnchangedMs,
      fallbackThresholdMs: this.fallbackThresholdMs(),
    });
    if (!decision.hit || decision.key === null || decision.kind === null) {
      this.evalTrace(featureId, scope.turnId, "-", null, "no-hit", decision.reason);
      return null;
    }
    const key = decision.key;
    if (scope.fired(key)) {
      this.evalTrace(featureId, scope.turnId, key, null, "deduped", `已唤过 ⇒ 不重复点火：${decision.reason}`);
      return null;
    }
    const org = this.resolveOrg(engine.ownerGroup);
    if (org === "") {
      this.evalTrace(
        featureId,
        scope.turnId,
        key,
        null,
        "skipped",
        "组织未确定（ownerGroup 缺失且无板级默认）⇒ 不点火",
      );
      return null;
    }
    if (this.halted) {
      this.evalTrace(
        featureId,
        scope.turnId,
        key,
        null,
        "skipped",
        "停机闸已置（stop() 之后）⇒ 在途一拍不再点火",
      );
      return null;
    }
    // ⑥ 交人闸：本需求有「当前待澄清的一轮」⇒ 本拍不自火（**不记去重键**，答完后同一条件仍可唤）。
    const held = this.awaitingHeldCheck(featureId);
    if (held !== "clear") {
      this.evalTrace(
        featureId,
        scope.turnId,
        key,
        null,
        "awaiting-held",
        held === "threw"
          ? `交人闸谓词抛错 ⇒ fail-closed 不点火（不记去重位）：${decision.reason}`
          : `板侧有待澄清轮 ⇒ 本拍不自火，保住用户手里的待答问题（不记去重位）：${decision.reason}`,
      );
      return null;
    }
    const prompt = buildWakePrompt({
      featureId,
      org,
      kind: decision.kind,
      reason: decision.reason,
      facts: decision.facts,
    });
    const result = this.deps.fire({ featureId, org, prompt, kind: decision.kind, key, turnId: scope.turnId });
    const occupant = result.occupantTurnId ?? null;
    if (!result.ok) {
      this.evalTrace(
        featureId,
        scope.turnId,
        key,
        occupant,
        `fire-${result.reason}`,
        `点火未成（${result.reason}）⇒ 不记去重位：${decision.reason}`,
      );
      return { featureId, key, kind: decision.kind, fired: false, reason: result.reason, occupantTurnId: occupant };
    }
    scope.record(key);
    this.evalTrace(featureId, scope.turnId, key, occupant, "fired", `已唤醒（${decision.kind}）：${decision.reason}`);
    return { featureId, key, kind: decision.kind, fired: true, reason: result.reason, occupantTurnId: occupant };
  }

  /**
   * ⑥ 交人闸判据（三档）：未注入谓词 ⇒ `"clear"`（行为零变更）；谓词 `true` ⇒ `"held"`；
   * 谓词抛错 ⇒ `"threw"`，**按「有待澄清轮」处置（fail-closed）**并留痕。
   */
  private awaitingHeldCheck(featureId: string): "clear" | "held" | "threw" {
    const predicate = this.deps.awaitingHeld;
    if (predicate === undefined) return "clear";
    try {
      return predicate(featureId) ? "held" : "clear";
    } catch (err: unknown) {
      this.trace(featureId, `交人闸谓词抛错（fail-closed ⇒ 按有待澄清轮处置、不点火）：${errorText(err)}`);
      return "threw";
    }
  }

  private async readEngine(featureId: string): Promise<HeartbeatEngineSnapshot | null> {
    try {
      return (await this.deps.readEngine(featureId)) ?? null;
    } catch (err: unknown) {
      this.trace(featureId, `引擎态重取失败（保守不点火）：${errorText(err)}`);
      return null;
    }
  }

  private async readPending(pending: readonly string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const taskId of pending) {
      try {
        out[taskId] = (await this.deps.readTaskState(taskId)) ?? null;
      } catch (err: unknown) {
        this.trace(null, `子任务 ${taskId} state 读取失败（按未就绪）：${errorText(err)}`);
        out[taskId] = null;
      }
    }
    return out;
  }

  private resolveOrg(ownerGroup: string | null): string {
    const fromEngine = (ownerGroup ?? "").trim();
    if (fromEngine !== "") return fromEngine;
    return (this.deps.defaultOrg ?? "").trim();
  }

  private intervalMs(): number {
    return this.deps.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  private fallbackThresholdMs(): number {
    return this.deps.fallbackThresholdMs ?? DEFAULT_FALLBACK_THRESHOLD_MS;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private trace(featureId: string | null, line: string): void {
    const log = this.deps.log;
    if (log === undefined) return;
    const at = new Date(this.now()).toISOString();
    log(`[heartbeat] ${at}${featureId === null ? "" : ` ${featureId}`} ${line}`);
  }

  /**
   * **评估 / 点火尝试的结构化留痕**（v0.9.5 增补 · 单行五字段）：
   * `featureId` · 本条目 `turnId` · 判据 `key` · 占用轮 `occupant` · `结论`。
   * 挂起条目按需求 keyed（一轮新登记即覆盖旧条目），事后从台账**读不回**上一轮的判据与撞车事实
   * ⇒ 这些只存在于本行日志里，是撞车分诊与「为什么这一拍没唤」的唯一可回溯面。
   */
  private evalTrace(
    featureId: string,
    turnId: string | null,
    key: string,
    occupantTurnId: string | null,
    verdict: string,
    detail: string,
  ): void {
    const log = this.deps.log;
    if (log === undefined) return;
    const at = new Date(this.now()).toISOString();
    log(
      `[heartbeat] ${at} eval featureId=${featureId} turnId=${turnId ?? "-"} key=${key}` +
        ` occupant=${occupantTurnId ?? "-"} verdict=${verdict} ${detail}`,
    );
  }
}

/** 装配入口（`index.ts` 起服务时调用）。 */
export function createHeartbeat(deps: HeartbeatDeps): Heartbeat {
  return new Heartbeat(deps);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
