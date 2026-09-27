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
// BD18 ①：「确认」按钮可用性（按 approval 条件化）
// ---------------------------------------------------------------------------

/** 确认按钮的一次可用性判定：可点与否 + 面向用户的一行说明（禁用时含原因与下一步）。 */
export interface ConfirmAffordance {
  enabled: boolean;
  note: string;
}

/** 审批门「待审批」是唯一可点确认的档位（与桥侧 `approve` 门同口径）。 */
const APPROVAL_PENDING = "待审批";

/**
 * 「发送确认指令给 agent」按钮的可用性规则（纯函数，**只控显示可用性，不写状态机**）。
 *
 * 背景（v0.9.0 收口轨 13）：板建需求初态 = `approval = 未发起`，此前按钮恒显示 ⇒
 * 用户自然先点「确认」，agent 核对不通过只回报缺什么 —— 行为正确但按钮在误导。
 * 刻意**不隐藏**（看不到入口更迷惑）：禁用 + 说明原因与下一步。
 */
export function deriveConfirmAffordance(approval: string | null): ConfirmAffordance {
  switch (approval) {
    case APPROVAL_PENDING:
      return {
        enabled: true,
        note: "审批门 = 待审批：核对改造文档后可发送确认指令（放不放行仍由 agent 核对后决定）。",
      };
    case "未发起":
      return {
        enabled: false,
        note: "方案未就绪（approval = 未发起）：需先「触发一轮」让 agent 产出需求确认单与改造文档、并把审批门置「待审批」，此按钮才会变为可点。",
      };
    case "已通过":
      return {
        enabled: false,
        note: "审批门已是「已通过」：放行已完成，无需再次确认（approval 单向、无回边）。",
      };
    default:
      return {
        enabled: false,
        note: `仅当审批门 = 「${APPROVAL_PENDING}」时确认按钮可点（当前值 = ${approval ?? "缺失"}）；方案未就绪时先「触发一轮」让 agent 产出改造文档。`,
      };
  }
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
// 收口轨 14 ②：写按钮的「轮占用」可用性（在飞 / 排队轮渲染为禁用 + 原因）
// ---------------------------------------------------------------------------

/** 占用轮的最小视图（与 `host-turn.ts` 的 `OccupantTurnView` 结构兼容，视图层不自造字段）。 */
export interface BusyTurnView {
  turnId: string;
  round: number;
  state: "running" | "queued";
}

/**
 * 「触发一轮 / 发送确认指令」按钮的**轮状态判据**（纯函数，只管显示可用性）：
 * 该需求已有在飞 / 排队轮 ⇒ 禁用 + 原因（防连点重复烧一轮；服务端另有 409 `board_turn_busy` 硬闸）。
 * 无占用轮 ⇒ enabled = `null`，交回各按钮自身的既有判据（approval 等），不在此处越权。
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
 * 收口轨 17：终态需求的「触发一轮 / 发送确认指令」可用性（纯函数，只管显示可用性）。
 * 判据单一源 = {@link isTerminalFeatureState}；服务端另有 409 `board_feature_terminal` 硬闸（轨 16 ③）。
 * 非终态 ⇒ `null`，交回各按钮自身的既有判据（占用 / approval），不在此处越权。
 */
export function deriveTerminalFeatureAffordance(state: string | null): ConfirmAffordance | null {
  if (state === null || !isTerminalFeatureState(state)) return null;
  return { enabled: false, note: terminalFeatureNote(state) };
}

// ---------------------------------------------------------------------------
// BD18 ②：详情页「下一步」引导行
// ---------------------------------------------------------------------------

/** 引导行的输入（全部来自既有只读数据：宿主面装配与否 / 待澄清轮 / 登记字段 / 引擎态）。 */
export interface NextStepInput {
  hostFaceAssembled: boolean;
  awaitingAnswer: boolean;
  approval: string | null;
  state: string | null;
}

/**
 * 详情页「下一步」一行提示（纯函数）。判序：宿主面未装配 > **终态** > 待澄清回答 > approval 三态。
 * 文案必须指向**页面上真实存在的入口**（触发一轮 / 确认 / 回答框 / config.json）。
 *
 * **收口轨 16 ①**：终态判序**先于**待澄清 —— Feature 已 completed / failed / cancelled 时，
 * 台账里哪怕还残留陈旧的 `awaiting_answer` 轮，也不得再引导用户「回答上方问题」
 * （详情页同时不渲染回答表单，两侧同判据 = {@link isTerminalFeatureState}）。
 */
export function deriveNextStepHint(input: NextStepInput): string {
  if (!input.hostFaceAssembled) {
    return "下一步：宿主面未装配（本板进程未接宿主桥）⇒ 需先在 config.json 配 orgsDir，之后本页才会出现「触发一轮 / 确认」入口。";
  }
  if (isTerminalFeatureState(input.state)) {
    return terminalFeatureNote(input.state);
  }
  if (input.awaitingAnswer) {
    return "下一步：回答上方问题（页面下方「回答待澄清的问题」表单，同 contextId 续推）。";
  }
  switch (input.approval) {
    case "未发起":
      return "下一步：点「触发一轮」让 agent 开始需求访谈；产出改造文档后审批门会进入「待审批」。";
    case APPROVAL_PENDING:
      return "下一步：核对改造文档后点「确认」（板只投指令给 agent，由 agent 核对后放行）。";
    case "已通过":
      return "下一步：审批门已通过，引擎按 DAG 接管执行；刷新本页看「进展三面」即可。";
    default:
      return `下一步：请核对该需求的审批门值（当前 = ${input.approval ?? "缺失"}）；尚无改造文档时先点「触发一轮」。`;
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
