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
 *
 * **v0.10.5 流程一致性**（`doc/v0.10.5/流程一致性-改造文档.md` §2.2 半派生表）：引擎主链 6→8，
 * `version_planning` / `decomposing` 两态进入本文件的派生覆盖（定版中 / 拆任务中，同归 `brand` 色档）；
 * 引导行另有**两态专属档**（定版 / 拆任务工序，不说「自动接力」），卡滞判据的态集一并扩到新两态。
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
 * - `version_planning` → 定版中 · `decomposing` → 拆任务中（v0.10.5 主链 6→8：`approve` 落前者，
 *   PjM 归属落库后入后者，DAG 登记完毕才入 `executing`）
 * - `executing` / `integrating` → 改造中（integrating = 节点全完成后的自动收敛段，仍在改造）
 * - `testing` → 回归中 · `reviewing` → 验收中
 * - `completed` → 已完成；但若登记 `stage = 发版`（发版流程在 completed 之后写入）→ 已发版
 * - `needs_input` → 改造中 · 待澄清（澄清只发生在 executing 期）
 */
export function deriveDisplayStage(state: string | null, stage: string | null): DisplayStage {
  const registered: DisplayStage = { label: stage ?? UNKNOWN_STAGE_LABEL, basis: "registered" };
  switch (state) {
    case "version_planning":
      return { label: "定版中", basis: "derived" };
    case "decomposing":
      return { label: "拆任务中", basis: "derived" };
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
 * 判序：终态 / 宿主面未装配 ⇒ `null`（**不渲染动作区**，见文件头 C5 口径）> **awaiting 短路**
 * （REQ-2026-09-30-03：有待澄清轮 ⇒ `null`，输入面互斥 = 澄清框在场时动作区整体不渲染，
 * **无条件优先**，含 `approval = 待审批` 组合 —— 该态确认动作由澄清框承载）> **监视中短路**
 * （REQ-2026-09-30-04：链监视中 ⇒ `null`，球在引擎不在用户 —— 动作区与补充框整块不出 DOM；
 * **无条件优先于 approval 三态**，`监视中 ∧ approval = 待审批` 确认按钮一并退场、不开例外，
 * 插话逃生门 = 链状态行停链按钮）> 轮占用（disabled）
 * > `approval = 待审批`（确认档，唯一出现「确认」按钮的地方）> 验收段 > 待裁待答 > 闲置。
 */
export function deriveActionAffordance(input: NextStepInput): ActionAffordance | null {
  if (!input.hostFaceAssembled || isTerminalFeatureState(input.state)) return null;
  if (input.awaitingAnswer === true) return null;
  if (input.chainMonitoring === true) return null;
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

/** 「有待裁待答」的显示层判据：待澄清轮 / 已登记产出 / 已有轮次留痕（板不解析待裁项结构，见改造文档 §6）。awaiting 已在动作区入口短路（互斥渲染），此处保留仅作语义完整。 */
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
// 增补五 件B（REQ-2026-10-02-05）：状态 → 色档（排期卡左缘色条的单一规则源）
// ---------------------------------------------------------------------------

/**
 * 色档闭集（七档）。视图只认档位，不认状态名 —— 新增引擎态时改本映射一处，
 * 不在模板里散写条件。**`locked` = 显式锁定语义预留档**；
 * 「已发版」（`completed` ∧ `stage=发版`）的派生显示仍归 `ok`。
 */
export type CardColorTier = "brand" | "warn" | "ok" | "danger" | "locked" | "neutral" | "cancelled";

/**
 * 引擎态 → 色档（纯函数，与 {@link deriveDisplayStage} / {@link deriveScheduleGateOpen}
 * 同一规则源侧）：在途主链六态（`version_planning`/`decomposing`/`executing`/`integrating`/`testing`/`reviewing`）→ `brand`；
 * 待确认 `waiting_approval` → `warn`；`completed` → `ok`；`failed` → `danger`；
 * `cancelled` → `cancelled`（独立档）；
 * `needs_input` / `null` / 未知值 → `neutral`（不猜、不吞，回落中性档）。
 */
export function deriveCardColorTier(state: string | null): CardColorTier {
  switch (state) {
    case "version_planning":
    case "decomposing":
    case "executing":
    case "integrating":
    case "testing":
    case "reviewing":
      return "brand";
    case "waiting_approval":
      return "warn";
    case "completed":
      return "ok";
    case "failed":
      return "danger";
    case "cancelled":
      return "cancelled";
    default:
      return "neutral";
  }
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
 * `state ∈ 卡滞态集` ∧ 无在飞 / 排队轮 ∧ 最近一轮距今超过本值 ⇒ 引导行切「建议手动继续」档。
 * 态集见 {@link STALL_FEATURE_STATES}（v0.10.5 B2 由 `executing` 扩到新两态）。
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
  /**
   * REQ-2026-09-30-04：链是否处于「监视中」（接力/心跳自动续推等子任务回传）。
   * 取值 = `deriveChainStateLine(snap)?.state === "monitoring"` 单点派生（复用闭集校验，
   * 不在原始快照上另开第二条链态判据）；**fail-open**：`null` / 字段缺席 ⇒ false ⇒ 不隐藏动作区，
   * 未接线的调用方保持旧行为。
   */
  chainMonitoring?: boolean;
  /**
   * REQ-2026-09-30-04：监视档显示用的等待回传子任务条数（取值 = `deriveChainStateLine(snap)?.pendingCount`，
   * 同一次派生的附带字段，不二次触桥）。`null` / 缺席 ⇒ 文案退为「等子任务回传」（不臆造个数）。
   */
  chainPendingCount?: number | null;
}

/**
 * 卡滞态集（v0.10.5 B2 扩）：`executing` + 主链新增两态 `version_planning` / `decomposing`。
 * 新两态同属「引擎不派发节点、等宿主动作」的工序（定版 / 拆任务），工序停住与链停住一样要出声。
 */
const STALL_FEATURE_STATES: readonly string[] = ["executing", "version_planning", "decomposing"];

/**
 * 新两态的工序名（卡滞档**独立分句**用）。`executing` 不在表内 ⇒ 沿用原句
 * 「agent 好像没接上？」（该句的事实是「引擎本该自动接力却没接力」，对新两态不成立）。
 */
const STALL_PROCESS_LABEL: Readonly<Record<string, string>> = {
  version_planning: "定版",
  decomposing: "拆任务",
};

/**
 * 卡滞判据（纯函数）：态在 {@link STALL_FEATURE_STATES} 内 ∧ 无在飞 / 排队轮 ∧ 最近一轮距今 > {@link TURN_STALL_AFTER_MS}
 * ⇒ 返回该「距今」毫秒（同一值既作判据、又供文案显示）；任一条件不满足（含不可判 ⇒ 不猜）⇒ `null`。
 */
function stalledElapsedMs(input: NextStepInput): number | null {
  if (input.state === null || !STALL_FEATURE_STATES.includes(input.state)) return null;
  if (input.turnBusy === true) return null;
  const elapsedMs = elapsedSinceTurnMs(input);
  return elapsedMs !== null && elapsedMs > TURN_STALL_AFTER_MS ? elapsedMs : null;
}

/** 「距今」毫秒（单时钟差值 `nowMs - Date.parse(at)`；缺值 / 非法 ⇒ `null`，不猜）。 */
function elapsedSinceTurnMs(input: NextStepInput): number | null {
  const at = input.latestTurn?.at ?? null;
  const nowMs = input.nowMs ?? null;
  if (at === null || nowMs === null) return null;
  const then = Date.parse(at);
  return Number.isFinite(then) ? nowMs - then : null;
}

/** 「距今」一行事实（单时钟差值；不可判 ⇒ 空串）。 */
function sinceTurnLine(input: NextStepInput): string {
  const elapsedMs = elapsedSinceTurnMs(input);
  return elapsedMs === null ? "" : `（最近一轮距今 ${formatElapsed(elapsedMs)}）`;
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
 * **判序纪律保留**：宿主面未装配 > **终态** > 待澄清回答 > needs_input 前置档 > **监视中** > approval 三态；
 * **卡滞档最低**（只在 `approval = 已通过` 分支里生效，态集见 {@link STALL_FEATURE_STATES}）。
 * 每档一句「卡在哪 + 等谁 + 做什么」，文案只指向**页面上真实存在的入口**（动作区按钮 / 澄清框 / 链状态行停链按钮 / config.json）。
 *
 * **v0.10.5 B2 专属档**：`version_planning`（等你 / agent 定版 = PjM 工序）与 `decomposing`
 * （等 agent 拆任务登记 DAG）各有独立文案 —— 这两态上引擎**不派发任何节点**，故不得沿用
 * 「引擎按 DAG 自动接力」兜底句；卡滞时同走独立分句（「<工序>已 X 未推进」），不得复用
 * 「agent 好像没接上？」（那句的隐含前提是「引擎本该接力却没接力」）。
 *
 * **v0.9.5 C5 口径**：UI 不再出现「触发一轮」字样（它是底层机制），故本行不得使用该词。
 *
 * **REQ-2026-09-30-03 互斥口径**：有待澄清轮时动作区不渲染（见 {@link deriveActionAffordance} 的
 * awaiting 短路），故 awaiting 档只指路**澄清框**、不提「动作区下方的回答框」；needs_input 无 awaiting
 * 轮时页面无澄清框，文案不得指向不在场入口。
 *
 * **REQ-2026-09-30-04 监视口径**：链监视中时动作区不渲染（{@link deriveActionAffordance} 的监视中短路），
 * 故监视档只指路**链状态行停链按钮**；文案只描述快照事实（等 N 个子任务），**不预测唤醒时机**
 * （不留第二套「等不等唤醒」口径）。**卡滞档在监视中不可达**是判序的自然结果 ——
 * `stalledElapsedMs` 只活在 `approval = 已通过` 分支内，监视档排在 approval 三态之前即被遮蔽，不另设执法点。
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
    return `下一步：等你回答上方问题（页面下方的澄清框，同 contextId 续推；也可直接给新指示）。${facts}`;
  }
  if (input.state === "needs_input") {
    // 相悖 B 子情形：引擎已挂起（needs_input）但板侧无 awaiting 轮 ⇒ 页面上没有澄清框，
    // 文案不得指向不在场入口（改造文档 §2.3）。
    return `下一步：agent 已挂起（needs_input）· 本页暂无待澄清问题 ⇒ 等 agent 接上，或在动作区补充框写明指示手动接一轮。${facts}`;
  }
  if (input.chainMonitoring === true) {
    // 监视档只陈述快照事实（等子任务回传），不预测唤醒时机（-04 §2.6）；指路唯一在场的插话入口 = 链状态行停链按钮。
    const waiting =
      input.chainPendingCount !== null && input.chainPendingCount !== undefined
        ? `等 ${String(input.chainPendingCount)} 个子任务回传`
        : "等子任务回传";
    return `下一步：链监视中（${waiting}）· 球在引擎不在你手里 ⇒ 动作区与提交口暂时退场；要插话请点本页链状态行的「停链」按钮（停链后动作区回来）。${facts}`;
  }
  switch (input.approval) {
    case "未发起": {
      const pending = (input.registeredDocs?.length ?? 0) > 0 || (input.latestTurn !== null && input.latestTurn !== undefined);
      if (pending) {
        if (input.receiptPresent === true) {
          return `下一步：等你 —— 回执卡「待用户」列出了待你拍板的事项 ⇒ 若链在监视中先点链状态行「停链」，再在回来的动作区补充框逐条写明裁定，点「提交给 agent」。${facts}`;
        }
        return `下一步：等你 —— agent 已把产出落到本页 ⇒ 若链在监视中先点链状态行「停链」，看完后在回来的动作区补充框写明裁定，点「提交给 agent」。${facts}`;
      }
      return "下一步：等你 —— 本卡尚无产出 ⇒ 点「让 agent 继续」开始需求访谈（产出需求确认单后进入改造方案）。";
    }
    case APPROVAL_PENDING:
      return `下一步：等你 —— 改造文档已落文件 ⇒ 核对后点「确认改造文档 → 放行执行」（放不放行由 agent 核对后决定）。${facts}`;
    case "已通过": {
      const stalledMs = stalledElapsedMs(input);
      if (stalledMs !== null) {
        // 卡滞档只在 approval=已通过 分支内评估；链监视中时监视档排在 approval 三态之前 ⇒ 本档不可达（判序自然结果，不另设执法点）。
        const process = STALL_PROCESS_LABEL[input.state ?? ""];
        if (process !== undefined) {
          // 新两态走独立分句：这两态上引擎本就不派发节点，「没接上」的说法不成立，只报「工序未推进」。
          return `下一步：${process}工序已 ${formatElapsed(stalledMs)} 未推进 · 本页没有进行中的轮 ⇒ 这道工序等 agent 与你的动作（引擎在此不派发任何节点），在动作区点「让 agent 继续」手动接一轮。${facts}`;
        }
        return `下一步：agent 好像没接上？本页没有进行中的轮${sinceTurnLine(input)}⇒ 若链在监视中先点链状态行「停链」，动作区回来后手动接一轮。${facts}`;
      }
      if (input.state === "version_planning") {
        return `下一步：等你 / agent 定版 —— 审批门已通过，本卡在 PjM 定版工序 ⇒ 等各 project 项目经理回版本规划结论、你确认后由宿主先建 Project Version 再写归属；要推进就在动作区点「让 agent 继续」。${facts}`;
      }
      if (input.state === "decomposing") {
        return `下一步：等 agent 拆任务登记 DAG —— 归属已落，本卡在拆任务工序 ⇒ 等各 project 研发经理回传本侧任务清单、由 agent 收敛后登记节点（登记完毕才进 executing，之后才谈得上按节点跑）。${facts}`;
      }
      if (input.state === "reviewing") {
        return `下一步：等你验收 —— 引擎已把全部节点跑完 ⇒ 若链在监视中先点链状态行「停链」，动作区回来后写明验收结论点「反馈验收结论」（「通过」即收口）。${facts}`;
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
// B13-② 指标口径标注（固定文案，视图直接引用）
// ---------------------------------------------------------------------------

/** 「在飞数」指标口径标注 —— 凡显示桥 `/health inFlightCount` 一类指标必须伴随此句。 */
export const INFLIGHT_CALIBRATION_NOTE =
  "口径：在飞数取自桥 /health inFlightCount，含 machine 闸内排队待放行任务 ⇒ ≠ 实际在跑数（会高估）。";

/**
 * Agent View 页脚口径行（v0.9.3 B-T3）：本页只呈现 orch 看得见的在飞面 ——
 * **machine 侧的两件事 orch 没有数据**（闸内排队、读席占席），板既不显示也不推算，
 * 只把口径钉在这一行（与 B13「两个时钟不得相加」同族，本页为完整句）。
 */
export const AGENT_VIEW_CALIBRATION_NOTE =
  "口径：闸内排队与 machine 读席占用 orch 不可见，两个时钟不得相加。";

/** trace / 等待面读账口径（原 B13 脚注第 3 条，收敛为单点常量）。 */
export const TRACE_READ_NOTE =
  "projectBusy 只反映写门；写门未挡却没开工时以 readOccupants[]（读档占位）为准；waitReason 原样显示（八值闭集，不自造中文词）；行序 = 登记序（createdAt），而「排队时长」列与 trace 位次仍以入队时刻（queuedAt）为键 ⇒ 二者不同序。";
