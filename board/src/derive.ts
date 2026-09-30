/**
 * 板侧**派生与显示口径**纯函数（BD3）—— 视图层唯一规则源，禁止把规则散进模板字符串。
 *
 * 事实源：`doc/v0.9.0/Web看板与确认入口-改造文档.md`
 * - §2.2-9（视图 V1）：需求列表 = 登记 `stage` + **改造/回归/验收由引擎态派生**；
 * - §2.2-12（显示口径 B13）：三条 —— ①等待时长只取 `waitedSince`（两个时钟不得相加）
 *   ② `/health inFlightCount` ≠ 在跑数（须标口径）③ `projectBusy` 只反映写门，
 *   写门没挡却没开工时看 `readOccupants[]`；`waitReason` 原样（八值闭集，不自造中文词）；
 * - §2.2-13（并行度口径）：编排侧并行 ≠ 改造侧并行；写串行不变；读并行需
 *   「节点 read 档 ∧ machine `maxConcurrentReads ≥ 2`」（缺省 1/1）⇒ DAG 拆宽 ≠ 并行。
 *
 * **v0.9.5 C1/C5**（`doc/v0.9.5/需求详情页读面精简-改造文档.md`）：详情页规则源集中到本文件 ——
 * 引导行（{@link deriveNextStepHint}，含卡滞档）与动作区档位（{@link deriveActionAffordance}）
 * 共用同一入参 {@link NextStepInput} = 同一事实源；两者只判显示，不写状态机（写端点与 409 硬闸不变）。
 */
import type { TraceNode } from "./bridge-client.js";

// ---------------------------------------------------------------------------
// 阶段派生（§2.2-9 / §2.2-4）
// ---------------------------------------------------------------------------

/** 一次派生的结果：展示标签 + 依据（derived = 引擎态派生；registered = 登记值原样）。 */
export interface DisplayStage {
  label: string;
  basis: "derived" | "registered";
}

/** 登记缺失时的兜底标签（不臆造登记值）。 */
export const UNKNOWN_STAGE_LABEL = "未知（登记缺失）";

/**
 * 引擎态 → 展示阶段。派生只覆盖「引擎看得见的主链段」；
 * 其余态（`waiting_approval` / `failed` / `cancelled` / 任何未知值）**原样回落登记值**，
 * 引擎态本身由列表/详情的「状态」列另行显示 —— 不吞、不猜、不自造。
 *
 * - `executing` / `integrating` → 改造中（integrating = 节点全完成后的自动收敛段，仍在改造）
 * - `testing` → 回归中 · `reviewing` → 验收中
 * - `completed` → 已完成；但若登记 `stage = 发版`（发版流程在 completed 之后写入）→ 已发版
 * - `needs_input` → 改造中 · 待澄清（澄清只发生在 executing 期）
 */
export function deriveDisplayStage(state: string | null, stage: string | null): DisplayStage {
  const registered: DisplayStage = { label: stage ?? UNKNOWN_STAGE_LABEL, basis: "registered" };
  switch (state) {
    case "executing":
    case "integrating":
      return { label: "改造中", basis: "derived" };
    case "testing":
      return { label: "回归中", basis: "derived" };
    case "reviewing":
      return { label: "验收中", basis: "derived" };
    case "completed":
      return stage === "发版"
        ? { label: "已发版", basis: "derived" }
        : { label: "已完成", basis: "derived" };
    case "needs_input":
      return { label: "改造中 · 待澄清", basis: "derived" };
    default:
      // waiting_approval / failed / cancelled / blocked(非 Feature 态、防御性) / 未知值
      return registered;
  }
}

// ---------------------------------------------------------------------------
// B13-① 等待时长：唯一时钟 = `waitedSince`
// ---------------------------------------------------------------------------

/**
 * 「已等待」时长的**唯一合法算法**：`now - waitedSince`，单时钟差值。
 * **严禁**把 orch 侧等待与 machine 侧闸内等待相加（AGENTS.md v0.8.10 / B13-①）。
 * 缺值 / 非法 / 为负 ⇒ `—`（不按 0 计，不做二次推断）。
 */
export function formatWaitedSince(waitedSince: string | null, nowMs: number): string {
  if (waitedSince === null || waitedSince.length === 0) return "—";
  const since = Date.parse(waitedSince);
  if (!Number.isFinite(since)) return "—";
  const elapsedSec = Math.floor((nowMs - since) / 1000);
  if (elapsedSec < 0) return "—";
  if (elapsedSec < 60) return `${elapsedSec}s`;
  const min = Math.floor(elapsedSec / 60);
  if (min < 60) return `${min}m ${elapsedSec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

/**
 * 区间时长（v0.9.3 B-T4 详情页任务行「排队时长 / 执行时长」）：两端 ISO 差值，
 * 格式同 {@link formatWaitedSince}。**单一口径**：缺任一端 / 非法 / 为负 ⇒ `—`
 * （不做「至 now」推算 —— 在飞任务的执行时长终点未到，如实显示 `—`）。
 */
export function formatDurationBetween(fromIso: string | null, toIso: string | null): string {
  if (fromIso === null || toIso === null) return "—";
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "—";
  const elapsedSec = Math.floor((to - from) / 1000);
  if (elapsedSec < 0) return "—";
  if (elapsedSec < 60) return `${elapsedSec}s`;
  const min = Math.floor(elapsedSec / 60);
  if (min < 60) return `${min}m ${elapsedSec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

// ---------------------------------------------------------------------------
// B13-③ trace 节点的等待归因（projectBusy 只反映写门 → 读档占位）
// ---------------------------------------------------------------------------

export interface TraceWaitDisplay {
  /** `waitReason` 八值闭集**原样**透出（不自造中文词） */
  waitReason: string;
  /** 写门一行（只描述 `projectBusy`，不引申） */
  writeGate: string;
  /** 读档占位一行；`readOccupants[]` 为空 ⇒ `—` */
  readOccupants: string;
  /** 位次（与实领序同键 = `queued_at`）；null ⇒ `—` */
  position: string;
  /** 已等待（只由 {@link formatWaitedSince} 派生，单时钟） */
  waited: string;
  /** 等待起点原值（供人工核对，不做格式化） */
  waitedSince: string;
  /** 在等谁（阻塞上游清单）；空 ⇒ `—` */
  blockedOn: string;
}

/**
 * trace 单节点的显示归因（纯函数）。**关键口径**：
 * `projectBusy.busy = false` 且节点是 read 档且 `readOccupants[]` 非空 ⇒
 * 「写门没挡却没开工」的真因是**读档占位**（machine 读闸缺省 1），此处显式给出，
 * 不让用户误读成「写门没挡 = 应该立刻跑」。
 */
export function traceWaitDisplay(node: TraceNode, nowMs: number): TraceWaitDisplay {
  const busy = node.projectBusy;
  const writeGate = busy.busy
    ? `写门占用（taskId=${busy.taskId ?? "?"}${busy.machineId !== null ? ` machine=${busy.machineId}` : ""}）`
    : "写门未挡";
  const occupants =
    node.readOccupants.length === 0
      ? "—"
      : `读档占位 ${node.readOccupants.length} 个：${node.readOccupants
          .map((o) => `${o.taskId}${o.machineId !== null ? `@${o.machineId}` : ""}`)
          .join(", ")}`;
  return {
    waitReason: node.waitReason,
    writeGate,
    readOccupants: occupants,
    position: node.position === null ? "—" : String(node.position),
    waited: formatWaitedSince(node.waitedSince, nowMs),
    waitedSince: node.waitedSince ?? "—",
    blockedOn: node.blockedOn.length === 0 ? "—" : node.blockedOn.join(", "),
  };
}

// ---------------------------------------------------------------------------
// BD18 ①（v0.9.5 C5 档位化改写）：详情页动作区的唯一档位判据
//
// **定向推翻记录**（用户裁定 2026-09-29，改造文档 §2 C5）：BD18 原口径「确认按钮恒显示、
// 仅按 `approval` 置灰」刻意写明「不隐藏：看不到入口更迷惑」。C5 把它改为**按档位收合** ——
// 「确认」只在确认门（`approval = 待审批`）出现，其余档位不渲染确认块；「触发一轮」这一底层
// 机制词从 UI 消失，改为意图化按钮。服务端 409 硬闸一条未减。
// ---------------------------------------------------------------------------

/** 一次可用性判定：可点与否 + 面向用户的一行说明（禁用时含原因与下一步）。 */
export interface ConfirmAffordance {
  enabled: boolean;
  note: string;
}

/** 审批门「待审批」= 确认档唯一档位（与桥侧 `approve` 门同口径）。 */
const APPROVAL_PENDING = "待审批";

/**
 * v0.9.5 C5 动作区档位（**只控显示，不写状态机**）：kind = 提交去向（与两个既有写路由一对一）·
 * label = 面向用户的意图文案 · enabled=false 时 note 给原因 · quiet = 低调档（卡滞兜底用，不抢视觉）。
 */
export interface ActionAffordance {
  kind: "turn" | "confirm";
  label: string;
  enabled: boolean;
  note: string;
  quiet: boolean;
}

/**
 * 动作区唯一档位判据（纯函数，与 {@link deriveNextStepHint} 共用同一入参 = 同一事实源）。
 *
 * 判序：终态 / 宿主面未装配 ⇒ `null`（**不渲染动作区**，见文件头 C5 口径）> 轮占用（disabled）
 * > `approval = 待审批`（确认档，唯一出现「确认」按钮的地方）> 验收段 > 待裁待答 > 闲置。
 */
export function deriveActionAffordance(input: NextStepInput): ActionAffordance | null {
  if (!input.hostFaceAssembled || isTerminalFeatureState(input.state)) return null;
  const base = actionTierBase(input);
  const busy = input.turnBusy === true;
  if (!busy) return base;
  return {
    ...base,
    enabled: false,
    note:
      input.busyTurn !== null && input.busyTurn !== undefined
        ? deriveTurnBusyAffordance(input.busyTurn)?.note ?? "本轮未结束前不可再次提交（防连点重复排队）。"
        : "本轮未结束前不可再次提交（防连点重复排队）。",
  };
}

function actionTierBase(input: NextStepInput): ActionAffordance {
  if (input.approval === APPROVAL_PENDING) {
    return {
      kind: "confirm",
      label: "确认改造文档 → 放行执行",
      enabled: true,
      note: "",
      quiet: false,
    };
  }
  if (input.state === "reviewing" || input.state === "testing") {
    return { kind: "turn", label: "反馈验收结论", enabled: true, note: "", quiet: false };
  }
  if (hasPendingUserInput(input)) {
    return { kind: "turn", label: "提交给 agent", enabled: true, note: "", quiet: false };
  }
  const executing = input.state === "executing" || input.state === "integrating";
  return {
    kind: "turn",
    label: "让 agent 继续",
    enabled: true,
    note: "",
    quiet: executing,
  };
}

/** 「有待裁待答」的显示层判据：待澄清轮 / 已登记产出 / 已有轮次留痕（板不解析待裁项结构，见改造文档 §6）。 */
function hasPendingUserInput(input: NextStepInput): boolean {
  return (
    input.awaitingAnswer === true ||
    (input.registeredDocs?.length ?? 0) > 0 ||
    input.latestTurn !== null && input.latestTurn !== undefined
  );
}

// ---------------------------------------------------------------------------
// v0.9.3 B-T5：排期写「双条件闸」可用性（想法挪版才可拖拽/改版，单一规则源）
// ---------------------------------------------------------------------------

/** 登记阶段「需求分析」—— 想法挪版（零善后档）的阶段判据。 */
const STAGE_REQUIREMENT_ANALYSIS = "需求分析";
/** 审批门「未发起」—— 确认动作未发生（approval 单向无回边）的门判据。 */
const APPROVAL_NOT_INITIATED = "未发起";

/**
 * 排期改动（改版/入池/出池）是否放行（纯函数，**视图与服务端共用同一规则源**）：
 * 仅 `stage = 需求分析` ∧ `approval = 未发起`（= 规范 §7 改版纪律「想法挪版」档）可写；
 * 任一不满足（含老桥缺登记字段 ⇒ null）⇒ 锁定 —— fail-closed，视图置灰、服务端 409
 * `board_schedule_state_locked`（执法见 `server.ts` 排期写处理，本函数只作读判）。
 */
export function deriveScheduleGateOpen(stage: string | null, approval: string | null): boolean {
  return stage === STAGE_REQUIREMENT_ANALYSIS && approval === APPROVAL_NOT_INITIATED;
}

// ---------------------------------------------------------------------------
// 收口轨 14 ②（v0.9.5 C5 档位化改写）：动作区按钮的「轮占用」判据（在飞 / 排队轮 ⇒ disabled + 原因）
// ---------------------------------------------------------------------------

/** 占用轮的最小视图（与 `host-turn.ts` 的 `OccupantTurnView` 结构兼容，视图层不自造字段）。 */
export interface BusyTurnView {
  turnId: string;
  round: number;
  state: "running" | "queued";
}

/**
 * 动作区按钮的**轮状态判据**（纯函数，只管显示可用性）：
 * 该需求已有在飞 / 排队轮 ⇒ 禁用 + 原因（防连点重复烧一轮；服务端另有 409 `board_turn_busy` 硬闸）。
 * 无占用轮 ⇒ enabled = `null`，交回档位判据（{@link deriveActionAffordance}），不在此处越权。
 */
export function deriveTurnBusyAffordance(busy: BusyTurnView | null): ConfirmAffordance | null {
  if (busy === null) return null;
  return {
    enabled: false,
    note:
      busy.state === "running"
        ? `本轮进行中（第 ${busy.round} 轮 · ${busy.turnId}）⇒ 待本轮结束前不可再次提交（防连点重复排队）。`
        : `本轮排队中（第 ${busy.round} 轮 · ${busy.turnId}）⇒ 队列未清空前不可再次提交（防连点重复排队）。`,
  };
}

// ---------------------------------------------------------------------------
// REQ-v0.9.2 N7：详情页「轮次进度」行（轮台账派生）
// ---------------------------------------------------------------------------

/**
 * 详情页轮次进度视图（`null` ⇒ 该需求当前没有在飞 / 排队轮 ⇒ 整行不渲染）。
 * 数据全部来自板侧轮台账与该桥的队列可见面，**不做任何推算**。
 */
export interface TurnProgressView {
  turnId: string;
  /** 第几轮（1 起，= 会话台账 `round`）。 */
  round: number;
  state: "running" | "queued";
  /** 排队位次（1 起）；在飞、或队列里查不到这条轮 ⇒ `null`（不臆造位次）。 */
  position: number | null;
}

/**
 * 轮次进度（纯函数）：占用轮 + 该桥队列位次 ⇒ 一行进度所需的最小事实。
 * 位次只在 `queued` 时取（在飞没有位次可言）；`queuePosition` 由调用方从队列可见面查得，
 * 查不到传 `null` —— 本函数不猜。
 */
export function deriveTurnProgress(
  busy: BusyTurnView | null,
  queuePosition: number | null,
): TurnProgressView | null {
  if (busy === null) return null;
  return {
    turnId: busy.turnId,
    round: busy.round,
    state: busy.state,
    position: busy.state === "queued" ? queuePosition : null,
  };
}

// ---------------------------------------------------------------------------
// v0.9.5 推进流程精简 · 增补二 T3（Feature fbaa15aa）：详情页「链状态」一行
// ---------------------------------------------------------------------------

/**
 * **停链标志的来源**（v0.9.5 增补二）：`user` = 用户经按需求停链口显式停链（人工动作**不得**清除）；
 * `auto` = 板侧自动置位（唤醒退让超上限 / 接力点火撞 occupant 等），人工动作可解冻。
 * 事实源 = `host-relay.ts` 的内存停链记录；本文件只做**只读派生**。
 */
export type ChainStopSource = "user" | "auto";

/** 链状态快照（读面注入的最小只读面；`host-face.ts` / `index.ts` 装配，读面不得据此写状态）。 */
export interface ChainStateSnapshot {
  /** `stopped` = 停链标志已置；`monitoring` = 链在监视中。 */
  chainState: "monitoring" | "stopped";
  /** 停链原因（`monitoring` ⇒ `null`）。 */
  reason: string | null;
  /** 停链来源（`monitoring` ⇒ `null`）。 */
  source: ChainStopSource | null;
  /** 等待回传的子任务条数（读不到 ⇒ `null`，不臆造）。 */
  pendingCount: number | null;
}

/** 详情页链状态行（`null` ⇒ 整行不渲染）。 */
export interface ChainStateLine {
  state: ChainStateSnapshot["chainState"];
  /** 监视档：等待的子任务条数；`null` ⇒ 不显示个数。 */
  pendingCount: number | null;
  /** 停链档：原因；`null` ⇒ 显示「原因未记录」。 */
  reason: string | null;
  /** 停链档：来源；`null` ⇒ 显示「来源未知」。 */
  source: ChainStopSource | null;
}

/**
 * 链状态行（纯函数）：快照缺席 / 形状不合闭集 ⇒ `null`（**不渲染、不报错**）；
 * `pendingCount` 非有限非负整数 ⇒ 按「读不到」处理（照轮次进度行「查不到不臆造位次」的口径）。
 */
export function deriveChainStateLine(snapshot: ChainStateSnapshot | null | undefined): ChainStateLine | null {
  if (snapshot === null || snapshot === undefined) return null;
  const state = snapshot.chainState;
  if (state !== "monitoring" && state !== "stopped") return null;
  const count =
    typeof snapshot.pendingCount === "number" && Number.isInteger(snapshot.pendingCount) && snapshot.pendingCount >= 0
      ? snapshot.pendingCount
      : null;
  if (state === "monitoring") {
    return { state, pendingCount: count, reason: null, source: null };
  }
  return {
    state,
    pendingCount: count,
    reason: typeof snapshot.reason === "string" && snapshot.reason.trim() !== "" ? snapshot.reason : null,
    source: snapshot.source === "user" || snapshot.source === "auto" ? snapshot.source : null,
  };
}

// ---------------------------------------------------------------------------
// 收口轨 16 ①：引擎终态闭集（详情渲染与写面兜底共用同一判据）
// ---------------------------------------------------------------------------

/** 引擎终态三值：需求已进入终态 ⇒ 板上不再有任何「该做的事」。 */
export const FEATURE_TERMINAL_STATES: readonly string[] = ["completed", "failed", "cancelled"];

/** 引擎态是否终态（null / 未知态 ⇒ 非终态 —— 不吞不猜，按观测面原样放行）。 */
export function isTerminalFeatureState(state: string | null): boolean {
  return state !== null && FEATURE_TERMINAL_STATES.includes(state);
}

/** 终态需求面向用户的一行说明（引导行与写按钮原因行共用，避免两处文案漂移）。 */
export function terminalFeatureNote(state: string | null): string {
  switch (state) {
    case "completed":
      return "本需求已完成（引擎态 completed），板上无需再操作；发版由用户主动发起。";
    case "cancelled":
      return "本需求已取消（终态），板上无需再操作。";
    case "failed":
      return "本需求已进入失败终态，板上无需再操作；如需继续请重新提需求。";
    default:
      return `本需求已进入引擎终态（${state ?? "缺失"}），板上无需再操作。`;
  }
}

/**
 * 收口轨 17 → v0.9.5 C5 档位化：终态需求**不再渲染任何动作区**（原「灰态按钮 + 原因」的定向推翻，
 * 用户裁定修订二）。终态事实由 {@link deriveNextStepHint} 的终态档 + 详情页墓碑行承载；
 * 服务端 409 `board_feature_terminal` 硬闸不动（轨 16 ③）。
 */

// ---------------------------------------------------------------------------
// BD18 ②（v0.9.5 C1 升级）：详情页「下一步」引导行
// ---------------------------------------------------------------------------

/**
 * 卡滞阈值（v0.9.5 C1 · 用户裁定 2026-09-29：**定死 10 分钟、不引配置键**）：
 * `state = executing` ∧ 无在飞 / 排队轮 ∧ 最近一轮距今超过本值 ⇒ 引导行切「建议手动继续」档。
 */
export const TURN_STALL_AFTER_MS = 10 * 60 * 1000;

/** 最近一轮摘要的显示上限（超出截断；全文在轮台账 / 结果页，引导行与详情页留痕行共用同一口径）。 */
export const LATEST_TURN_SUMMARY_MAX = 120;

/** 任务计数（详情出参 `tasks` 归一，板不额外触桥）。 */
export interface NextStepTaskCounts {
  total: number;
  completed: number;
  failed: number;
}

/** 最近一轮留痕（`latestTurnOf` 的最小视图；`at` = 该轮最近一次时刻的 ISO 原文）。 */
export interface NextStepLatestTurn {
  state: string;
  summary: string | null;
  at: string | null;
}

/**
 * 引导行的输入（全部来自既有只读数据：宿主面装配与否 / 待澄清轮 / 登记字段 / 引擎态 /
 * v0.9.5 C1 新增的 decisions 产出清单、任务计数、最近一轮、占用轮与当前时刻）。
 *
 * **v0.9.5 C1 纪律**：`nowMs` 由调用方下传（derive 内**不读时钟**，「距今」= `nowMs - Date.parse(at)`
 * 单时钟差值，与 {@link formatWaitedSince} 同口径）；新增字段全部可选 ⇒ 未接线的调用方保持旧行为。
 */
export interface NextStepInput {
  hostFaceAssembled: boolean;
  awaitingAnswer: boolean;
  approval: string | null;
  state: string | null;
  /** v0.9.5 C1：`decisions` 已登记的产出文件名清单（`parseDecisionItems` + `extractRegisteredDocPath` 归一） */
  registeredDocs?: readonly string[];
  /** v0.9.5 C1：任务计数 */
  taskCounts?: NextStepTaskCounts;
  /** v0.9.5 C1：最近一轮摘要（无轮次记录 ⇒ `null`） */
  latestTurn?: NextStepLatestTurn | null;
  /** v0.9.5 C1：该需求是否已有在飞 / 排队轮（卡滞判据的「无在飞轮」条件） */
  turnBusy?: boolean;
  /** v0.9.5 C1：占用轮本体（动作区 disabled 原因行复用，可缺省） */
  busyTurn?: BusyTurnView | null;
  /** v0.9.5 C1：当前时刻（毫秒）；缺省 ⇒ 卡滞档不可判（不猜） */
  nowMs?: number;
  /**
   * v0.9.6 N5：详情页「最近一轮」下方的结构化回执卡是否在场（最新轮带 `receipt` ⇒ true）。
   * 缺省 false ⇒ 未接线的调用方保持旧行为（引导行照旧显示「最近一轮 <state>：<摘要>」）。
   */
  receiptPresent?: boolean;
}

/** 卡滞判据（纯函数）：executing ∧ 无在飞 / 排队轮 ∧ 最近一轮距今 > {@link TURN_STALL_AFTER_MS}。 */
function isStalled(input: NextStepInput): boolean {
  if (input.state !== "executing") return false;
  if (input.turnBusy === true) return false;
  const at = input.latestTurn?.at ?? null;
  const nowMs = input.nowMs ?? null;
  if (at === null || nowMs === null) return false;
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return false;
  return nowMs - then > TURN_STALL_AFTER_MS;
}

/** 「距今」一行事实（单时钟差值；不可判 ⇒ 空串）。 */
function sinceTurnLine(input: NextStepInput): string {
  const at = input.latestTurn?.at ?? null;
  const nowMs = input.nowMs ?? null;
  if (at === null || nowMs === null) return "";
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return "";
  return `（最近一轮距今 ${formatElapsed(nowMs - then)}）`;
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${String(sec)}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${String(min)}min`;
  return `${String(Math.floor(min / 60))}h ${String(min % 60)}min`;
}

/** 本卡事实段（产出 / 任务 / 最近一轮）：有哪项说哪项，全缺 ⇒ 空串。 */
function factsLine(input: NextStepInput): string {
  const parts: string[] = [];
  const docs = input.registeredDocs ?? [];
  if (docs.length > 0) parts.push(`已登记产出 ${docs.slice(0, 3).join(" · ")}${docs.length > 3 ? ` 等 ${String(docs.length)} 份` : ""}`);
  const c = input.taskCounts;
  if (c !== undefined && c.total > 0) parts.push(`任务 ${String(c.completed)}/${String(c.total)} 完成 · 失败 ${String(c.failed)}`);
  const turn = input.latestTurn;
  if (turn !== null && turn !== undefined) {
    if (input.receiptPresent === true) {
      // 回执卡（要点 / 待用户 / 下一步）已在「最近一轮」下方渲染 ⇒ 引导行不重复状态+摘要，改指回执卡。
      parts.push("本轮回执见下方回执卡");
    } else {
      const summary =
        turn.summary !== null && turn.summary !== ""
          ? `：${turn.summary.length > LATEST_TURN_SUMMARY_MAX ? `${turn.summary.slice(0, LATEST_TURN_SUMMARY_MAX)}…` : turn.summary}`
          : "";
      parts.push(`最近一轮 ${turn.state}${summary}`);
    }
  }
  return parts.length === 0 ? "" : `（${parts.join(" · ")}` + "）";
}

/**
 * 详情页「下一步」一行提示（纯函数；v0.9.5 C1 升级为「本卡状态 + 该做的一件事」）。
 *
 * **判序纪律保留**：宿主面未装配 > **终态** > 待澄清回答 > approval 三态；**卡滞档最低**
 * （只在 executing 段内生效，覆盖「已通过 · 等引擎」文案）。每档一句「卡在哪 + 等谁 + 做什么」，
 * 文案只指向**页面上真实存在的入口**（动作区按钮 / 回答框 / config.json）。
 *
 * **v0.9.5 C5 口径**：UI 不再出现「触发一轮」字样（它是底层机制），故本行不得使用该词。
 */
export function deriveNextStepHint(input: NextStepInput): string {
  const facts = factsLine(input);
  if (!input.hostFaceAssembled) {
    return "下一步：宿主面未装配（本板进程未接宿主桥）⇒ 需先在 config.json 配 orgsDir，之后本页才会出现动作区入口。";
  }
  if (isTerminalFeatureState(input.state)) {
    return terminalFeatureNote(input.state);
  }
  if (input.awaitingAnswer) {
    return `下一步：等你回答上方问题（动作区下方的回答框，同 contextId 续推）。${facts}`;
  }
  switch (input.approval) {
    case "未发起": {
      const pending = (input.registeredDocs?.length ?? 0) > 0 || (input.latestTurn !== null && input.latestTurn !== undefined);
      if (pending) {
        if (input.receiptPresent === true) {
          return `下一步：等你 —— 回执卡「待用户」列出了待你拍板的事项 ⇒ 在动作区补充框逐条写明裁定后点「提交给 agent」。${facts}`;
        }
        return `下一步：等你 —— agent 已把产出落到本页，看完在动作区补充框写明裁定 ⇒ 点「提交给 agent」。${facts}`;
      }
      return "下一步：等你 —— 本卡尚无产出 ⇒ 点「让 agent 继续」开始需求访谈（产出需求确认单后进入改造方案）。";
    }
    case APPROVAL_PENDING:
      return `下一步：等你 —— 改造文档已落文件 ⇒ 核对后点「确认改造文档 → 放行执行」（放不放行由 agent 核对后决定）。${facts}`;
    case "已通过": {
      if (isStalled(input)) {
        return `下一步：agent 好像没接上？本页没有进行中的轮${sinceTurnLine(input)}⇒ 点动作区的「让 agent 继续」手动接一轮。${facts}`;
      }
      if (input.state === "reviewing") {
        return `下一步：等你验收 —— 引擎已把全部节点跑完 ⇒ 在动作区写明验收结论点「反馈验收结论」（「通过」即收口）。${facts}`;
      }
      if (input.state === "testing") {
        return `下一步：等 agent 回归 —— 回归段进行中 ⇒ 刷新本页看「进展三面」。${facts}`;
      }
      return `下一步：等 agent —— 审批门已通过，引擎按 DAG 自动接力 ⇒ 刷新本页看进展。${facts}`;
    }
    default:
      return `下一步：等你 —— 请核对该需求的审批门值（当前 = ${input.approval ?? "缺失"}）。${facts}`;
  }
}

// ---------------------------------------------------------------------------
// B13-② 指标口径标注 + §2.2-13 并行度文案（固定文案，视图直接引用）
// ---------------------------------------------------------------------------

/** 「在飞数」指标口径标注 —— 凡显示桥 `/health inFlightCount` 一类指标必须伴随此句。 */
export const INFLIGHT_CALIBRATION_NOTE =
  "口径：在飞数取自桥 /health inFlightCount，含 machine 闸内排队待放行任务 ⇒ ≠ 实际在跑数（会高估）。";

/** §2.2-13 并行度口径 —— 板上任何「并行」表述统一引用本常量。 */
export const PARALLELISM_NOTE =
  "并行度口径：编排侧并行 ≠ 改造侧并行；写串行不变；「读并行」仅在节点声明 read 档且 machine 配 " +
  "maxConcurrentReads ≥ 2 时才真发生（缺省 1/1）⇒ DAG 拆宽 ≠ 并行。板不承诺「多需求并行」。";

/**
 * Agent View 页脚口径行（v0.9.3 B-T3）：本页只呈现 orch 看得见的在飞面 ——
 * **machine 侧的两件事 orch 没有数据**（闸内排队、读席占席），板既不显示也不推算，
 * 只把口径钉在这一行（与 B13「两个时钟不得相加」同族，本页为完整句）。
 */
export const AGENT_VIEW_CALIBRATION_NOTE =
  "口径：闸内排队与 machine 读席占用 orch 不可见，两个时钟不得相加。";

/** B13 三条显示口径脚注（列表 / 详情 / trace 视图统一挂载）。 */
export const B13_CALIBRATION_NOTES: readonly string[] = [
  "等待时长只取 waitedSince（orch 领取队列的等待与 machine 闸内等待是两个时钟，不得相加）。",
  INFLIGHT_CALIBRATION_NOTE,
  "projectBusy 只反映写门；写门未挡却没开工时以 readOccupants[]（读档占位）为准；waitReason 原样显示（八值闭集，不自造中文词）。",
];
