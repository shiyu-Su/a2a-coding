/**
 * 板的**自动接力决策器与驱动器**（v0.9.5 C1 + C3）。
 *
 * 事实源：改造文档 `doc/v0.9.5/推进流程精简-改造文档.md` §2-C1/§2-C3/§2-C4；
 * 确认单 §8「板侧双判定」。
 *
 * ## 它解决什么
 * 现状每一段（需求分析 / 改造方案 / 发起改造 / 回归）都要人点「触发一轮」。自动接力 =
 * **轮收口后由本模块做一次决策，该续则自动发下一轮** —— 人只在「拍板 / 补料 / 验收」三处出现。
 *
 * ## 接力点（脱离请求路径）
 * 信号源 = `HostTurnManager` 的收口回调（`onTurnSettled`，在**交闸与落计数之后**触发），
 * **不是** `host-face.ts#settleSubmitted`（那条是请求路径，排队轮还不等它）。
 * `submitTurn` 侧的同 `contextId` 复用与 `round` 自增由 `openSession` 按 `requirementId`
 * 自动完成 ⇒ 本模块点火**不显式传 `round`/`contextId`**，直接复用现成的单飞闸 / occupant 防重 /
 * 10min 有界窗。
 *
 * ## C3：收口后一跳引擎态重取
 * `succeeded` 轮不足以决定去向 ⇒ 收口后经**只读探针**重取一次 `state/stage/approval`
 * （`BridgeClient` 只读 GET，绝不出网写）。读面失败 / 未注入探针 ⇒ **保守停链、不点火**
 * （与「不为已结束的需求白烧一轮」同口径）。
 *
 * ## C4：判定序（固定）
 * ① 停链标志 → ② 链内连续点火计数触顶 → ③ `canceled` → ④ 判定表（见 {@link shouldContinue}）。
 * - **链内计数**只数「本次接力链内的连续自动点火」；任何**人工动作**（补充 / 确认 / 回答 / 停链 /
 *   新起接力）清零（见 {@link HostRelay.noteManualAction}）。**不拿 session `round` 绝对值比上限**
 *   （用户此前的手工轮会误触顶）。缺省上限 {@link DEFAULT_RELAY_CHAIN_LIMIT}。
 * - **`canceled` 恒不点火**：停链走的 `cancelTurn` 被清的排队 job 也以 `canceled` 收口，
 *   若该收口再点火一次就会「停链 → 取消 → 回调 → 又点一发」自激。
 * - **点火撞 occupant**：分两条路，**不可混为一谈**（v0.9.5 增补 · D1）——
 *   - **接力路径**（`fire`，轮收口续轮）：**一撞即停**（该需求已有在飞 / 排队轮，含用户手工触发的情形），
 *     不重试、不轮询，留痕；
 *   - **唤醒路径**（`fireWake`，心跳点火）：**不置停链标志**，按占用者身份分诊 ——
 *     占用者就是本条目登记的那一发轮（自己还在收口）⇒ 本拍跳过、等它收口后重评；
 *     占用者是同需求的新一轮 ⇒ 退让等待，**总上限 10 分钟（≈20 拍）**，超限才停链 + 交人 + 留痕。
 *     两条路都**不记去重位**（`firedKeys` 只在真正点火成功后由心跳写入），故下一拍照旧重评。
 * - **`succeeded + 执行中` 进监视、不立即点火**：立即续火会「退出→秒回→再退出」空转到计数触顶
 *   ⇒ 监视（显式挂起 / 纯 DAG）归 C7–C8 心跳接管，本模块只给判定，不抢点火。
 * - **停链标志落内存、不落 `.data/`**：接力链本身是进程内 Promise 链，重启即无链可停。
 * - **停链标志带来源（v0.9.5 增补二 · D2）**：`user` = 用户经按需求停链口显式停链；`auto` = 板侧自动置位
 *   （接力点火撞 occupant / 唤醒退让超上限）。**人工动作（补充 / 确认 / 回答）只清 `auto`**（解冻后可再点火），
 *   `user` 不得被清除 —— 保持「一点即停、不再复活」；显式解停链（{@link HostRelay.clearStop}，= 新起接力）
 *   仍可清两种来源。
 *
 * ## 边界
 * - **不写引擎状态机**：不调 `approve` / `cancel`、不把主链 `advance` 到非当前态、不经 MCP 写 `features`；
 * - **不自建定时器**：跨轮异步补火巡检 loop **不做**（无源后台巡检是 C8 之外的另案）；
 *   监视心跳归 C8 装配层（单 `setInterval`），本模块不常驻任何句柄。
 */
import type { SubmittedTurn, SubmitTurnInput, TurnResult } from "./host-turn.js";
import { isTerminalFeatureState, type ChainStopSource } from "./derive.js";
import { RECEIPT_CONTRACT } from "./receipt.js";

// ---------------------------------------------------------------------------
// 口径常量
// ---------------------------------------------------------------------------

/** 自动接力轮提示词的标题行前缀（用例据此钉住「提示词不含任何 MCP 工具全名」）。 */
export const RELAY_PROMPT_TITLE = "【板 · 自动接力】";

/** 链内**连续自动点火**的缺省上限（到顶即停链交人；人工动作清零后重新计数）。 */
export const DEFAULT_RELAY_CHAIN_LIMIT = 10;

/**
 * **唤醒点火撞 occupant 的退让等待上限**（v0.9.5 增补 · D1）：10 分钟 ≈ 心跳 20 拍
 * （{@link DEFAULT_HEARTBEAT_INTERVAL_MS} = 30s）。
 * 占用者是**同需求的新一轮**时不再「一撞即停」，改为逐拍退让；超过本上限才停链 + 交人 + 留痕。
 */
export const WAKE_OCCUPANT_WAIT_LIMIT_MS = 600_000;

// ---------------------------------------------------------------------------
// 引擎态探针（C3）
// ---------------------------------------------------------------------------

/** 收口后重取的引擎态快照（C3 的点火判据三字段；缺失容错为 `null`，不臆造）。 */
export interface EngineSnapshot {
  state: string | null;
  stage: string | null;
  approval: string | null;
}

/**
 * **只读**引擎态探针（C3）：`state/stage/approval` 一跳 `getFeature`。
 * 实现必须只读（`BridgeClient` 的 GET-only 硬约束不动）；读失败 ⇒ 抛错，驱动器据此保守停链。
 */
export interface EngineStateProbe {
  fetchEngineState(featureId: string): Promise<EngineSnapshot | null>;
}

/** 显式挂起条目的最小面（C7/C8 提供；T2 缺省 `undefined` ⇒ 按「无条目」走自动分支）。 */
export interface SuspendMarker {
  /** pending 清单条数（`0` = 纯 DAG 监视）。明细归 C7/C8，本模块不消费。 */
  pendingCount?: number;
}

/**
 * **监视归属通知**（v0.9.5 C8 · T8）：每轮收口决策后告知装配层「本需求进哪种监视」，
 * 供心跳（C8）维护**自动 armed 注册表**（⑤ 兜底只对无条目的 `auto` 目标适用）。
 * 载体（停链标志 / 链内计数）仍归本模块单一定义，通知只是**只读告知**，不改任何链状态。
 */
export interface RelayMonitorNotice {
  featureId: string;
  /** `auto` = 无条目但引擎执行中（自动 armed）；`suspend` = 显式挂起条目；`none` = 停链 / 交人。 */
  kind: "auto" | "suspend" | "none";
  org: string;
  /** 收口后重取的登记 stage（`null` = 未知）；自动目标据此跟踪 ⑤ 兜底计时。 */
  stage: string | null;
}

// ---------------------------------------------------------------------------
// 决策器（纯函数，C4 判定表）
// ---------------------------------------------------------------------------

/** 链去向：`continue` = 链继续（非交人 / 非停链）；`stop` = 交人 / 停链。 */
export type RelayAction = "continue" | "stop";

/** 续火方式：`immediate` = 立即点火（`submitTurn`）；`monitor` = 进监视（C7/C8 心跳接管，不立即点火）。 */
export type RelayMode = "immediate" | "monitor";

export interface RelayDecision {
  action: RelayAction;
  /** `continue` 时的续火方式；`stop` ⇒ `null`。 */
  mode: RelayMode | null;
  /** `continue + monitor` 时的监视种类（照确认单 §8.2：显式挂起 / 自动纯 DAG）。 */
  monitor: "suspend" | "auto" | null;
  reason: string;
}

function stop(reason: string): RelayDecision {
  return { action: "stop", mode: null, monitor: null, reason };
}

function monitor(kind: "suspend" | "auto", reason: string): RelayDecision {
  return { action: "continue", mode: "monitor", monitor: kind, reason };
}

/**
 * **该不该续火**（纯函数，C4 判定表照抄）。入参 = 轮收口态（`TurnResult`，至少含 `state`）
 * + 收口后重取的引擎态（C3）。`suspend` = 显式挂起条目（C7 起提供，缺省 `undefined` = 无条目）。
 *
 * 判定表（确认单 §8.2）：
 *
 * | 轮态 | 引擎态 | suspend 条目 | 板动作 |
 * |---|---|---|---|
 * | `awaiting_answer` | 任意 | 不看 | 交人（等人回答，链停） |
 * | `failed` / `timeout` | 任意 | 不看 | 交人（不重试，链停） |
 * | `canceled` | 任意 | 不看 | 交人（恒不点火） |
 * | `succeeded` | `reviewing` / 终态 | 不看 | 交人（验收/结束，链停） |
 * | `succeeded` | 执行中 | 有（显式挂起） | 进监视（按 pending 查） |
 * | `succeeded` | 执行中 | 无 | 自动进监视（纯 DAG 监视，防漏） |
 *
 * **保守兜底**：引擎态未知（探针缺省 / 读面失败）⇒ 停链不点火（C3）。
 */
export function shouldContinue(
  outcome: Pick<TurnResult, "state"> | null,
  engine: EngineSnapshot | null,
  suspend?: SuspendMarker | null,
): RelayDecision {
  if (outcome === null) return stop("无轮收口信号 ⇒ 不点火");
  switch (outcome.state) {
    case "awaiting_answer":
      return stop("轮态 awaiting_answer（等人回答）⇒ 交人、链停");
    case "failed":
    case "timeout":
      return stop(`轮态 ${outcome.state}（不重试）⇒ 交人、链停`);
    case "canceled":
      return stop("轮态 canceled（停链收口）⇒ 恒不点火，防自激");
    case "queued":
    case "running":
      return stop(`轮态 ${outcome.state} 非收口态 ⇒ 不点火`);
    case "succeeded":
      break;
    default:
      return stop(`轮态未知（${String(outcome.state)}）⇒ 保守停链`);
  }
  // 轮态 = succeeded ⇒ 必须由引擎态分流（C3）
  if (engine === null) {
    return stop("引擎态读面失败 / 未装配 ⇒ 保守停链、不点火（C3）");
  }
  if (isTerminalFeatureState(engine.state)) {
    return stop(`引擎终态（${String(engine.state)}）⇒ 交人、链停`);
  }
  if (engine.state !== "executing") {
    return stop(`引擎态 ${engine.state ?? "缺失"} 非执行中（reviewing / 审批段等）⇒ 交人、链停`);
  }
  if (suspend !== undefined && suspend !== null) {
    return monitor("suspend", "succeeded + 执行中 + 显式挂起条目 ⇒ 进监视（按 pending 查，不立即点火）");
  }
  return monitor("auto", "succeeded + 执行中 + 无条目 ⇒ 自动进监视（纯 DAG 监视，防漏，不立即点火）");
}

// ---------------------------------------------------------------------------
// 提示词（纯函数）
// ---------------------------------------------------------------------------

export interface RelayPromptInput {
  featureId: string;
  org: string;
  engine: EngineSnapshot | null;
}

/**
 * 自动接力轮的提示词（纯函数）。**不出现任何 MCP 工具全名**（§3.6：各家后端工具名不同）；
 * 把板侧重取到的**引擎态快照作为结构化事实**给 agent（板不解析 agent 文本，唯一例外 = 收口回执块
 * （`src/receipt.ts` `parseReceiptBlock`）：获准解析、且必须容错——不匹配即退回现状摘要，不劣于无解析）。
 */
export function buildRelayPrompt(input: RelayPromptInput): string {
  const engine = input.engine;
  return [
    `${RELAY_PROMPT_TITLE} 需求 ${input.featureId} · 组织 ${input.org}`,
    "",
    "板上监测到该需求**上一轮已收口**且引擎态为**执行中**（自动接力，无需人再点触发）。",
    "本轮引擎态快照（板上收口后重取的只读事实）：",
    `- state = ${engine?.state ?? "未知"} · stage = ${engine?.stage ?? "未知"} · approval = ${engine?.approval ?? "未知"}`,
    "",
    "请以当前工作目录为本组织目录，按 AGENTS.md 的需求流程规范，处理**当前该做的一步**：",
    "1. 先用编排桥的只读能力核对本需求的引擎态与子任务进展，不要凭猜测动手；",
    "2. 子任务仍需等待 ⇒ 按规程收口（需要人决策就用 A2A 的 input-required 结束本轮），不要空转；",
    "3. 状态机推进（审批 / 推进 / 取消）只能经编排桥的能力做，板不代劳。",
    // v0.9.6 N6：接力轮同样是一轮收尾 ⇒ 引用同一契约常量。
    "",
    RECEIPT_CONTRACT,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 驱动器
// ---------------------------------------------------------------------------

/** 点火结果（`ok=false` 时 `reason` 给停链原因，供可见面留痕）。 */
export interface RelayFireResult {
  ok: boolean;
  reason: string;
  turnId?: string;
  round?: number;
  /** 撞车的占用轮 `turnId`（仅撞 occupant 时非空）：分诊结论的可回溯面。 */
  occupantTurnId?: string | null;
  /** 本轮已退让等待的毫秒数（仅 `occupant_yield` / `occupant_wait_exceeded` 时有值）。 */
  waitedMs?: number;
}

export interface HostRelayDeps {
  /** 发一轮（复用 BD4b 通道：同 `contextId` / 单飞闸 / occupant 防重）。 */
  submitTurn(input: SubmitTurnInput): SubmittedTurn;
  /** C3 只读引擎态探针；`null` / 缺省 ⇒ 收口后判不了引擎态 ⇒ 保守停链。 */
  probe?: EngineStateProbe | null;
  /** 接力轮提示词构造（缺省 {@link buildRelayPrompt}）。 */
  buildPrompt?: (input: RelayPromptInput) => string;
  /** 链内连续自动点火上限（缺省 {@link DEFAULT_RELAY_CHAIN_LIMIT}）。 */
  chainLimit?: number;
  /** 显式挂起条目查询（C7 提供；缺省 ⇒ 视作无条目）。 */
  suspendLookup?: (requirementId: string) => SuspendMarker | null;
  /** 监视归属通知（C8 提供；缺省 ⇒ 不通知）。 */
  onMonitor?: (notice: RelayMonitorNotice) => void;
  /**
   * **唤醒点火撞 occupant 的退让等待上限**（D1）；缺省 {@link WAKE_OCCUPANT_WAIT_LIMIT_MS}。
   * 测试注入小值以验「超限才停链」。
   */
  wakeOccupantWaitMs?: number;
  /** 留痕出口（缺省丢弃；装配层接日志）。 */
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * **停链记录**（内存事实源的一份，v0.9.5 增补二 · D2）：原因 + 来源。
 * 来源决定「人工动作能不能解冻」—— 见 {@link HostRelay.noteManualAction}。
 */
export interface ChainStopRecord {
  reason: string;
  source: ChainStopSource;
}

/**
 * 接力驱动器：持有**内存**里的停链标志与链内连续点火计数（C8 只读不另造），
 * 在每轮收口后按 C4 判定序决策，并（在允许立即点火时）经 `submitTurn` 续火。
 */
export class HostRelay {
  private readonly deps: HostRelayDeps;
  /** 停链标志（内存事实源，**不跨重启持久**）；值 = 原因 + 来源（D2）。 */
  private readonly stops = new Map<string, ChainStopRecord>();
  /** 链内连续自动点火计数（人工动作清零）。 */
  private readonly counts = new Map<string, number>();
  /**
   * **唤醒退让计时**（D1，内存事实源，按需求一条）：首次退让的时刻 + 已退让拍数。
   * 占用者换轮**不重置**（「总」上限）；成功点火 / 该需求有轮收口 / 解停链 / 人工动作 ⇒ 清零。
   */
  private readonly wakeWaits = new Map<string, { sinceMs: number; ticks: number }>();

  constructor(deps: HostRelayDeps) {
    this.deps = deps;
  }

  // -- 停链标志 / 链内计数（C8 只读面 + T3 停链口写面） ----------------------

  /** 该需求当前是否置了停链标志。 */
  isChainStopped(requirementId: string): boolean {
    return this.stops.has(requirementId.trim());
  }

  /**
   * **停链记录的只读视图**（v0.9.5 增补二 · D2，读面链状态行的事实源）：未置标志 ⇒ `null`。
   * 返回拷贝 —— 调用方拿到的对象改动不回写内存标志。
   */
  stopView(requirementId: string): ChainStopRecord | null {
    const rec = this.stops.get(requirementId.trim());
    return rec === undefined ? null : { reason: rec.reason, source: rec.source };
  }

  /** 链内连续自动点火计数（C8 心跳可读，用于与上限比较）。 */
  chainCount(requirementId: string): number {
    return this.counts.get(requirementId.trim()) ?? 0;
  }

  /** 链内连续自动点火上限（判定与点火共用同一数值）。 */
  chainLimit(): number {
    return this.deps.chainLimit ?? DEFAULT_RELAY_CHAIN_LIMIT;
  }

  /**
   * **置停链标志**（T3 按需求停链口 / 撞 occupant 自停共用）：置标志 + 清零链内计数。
   * 置后任何收口都不再点火（防自激）。
   *
   * `source`（D2）= 停链的**来源**：用户经停链口显式停链 ⇒ `user`；板侧自动置位 ⇒ `auto`（缺省）。
   * 重复停链以**最后一次的来源为准**（人工停链口会覆盖此前自动置位）。
   */
  requestStop(requirementId: string, reason = "manual", source: ChainStopSource = "auto"): void {
    const reqId = requirementId.trim();
    if (reqId === "") return;
    this.stops.set(reqId, { reason, source });
    this.counts.set(reqId, 0);
    this.wakeWaits.delete(reqId);
    this.trace(reqId, `停链标志已置（来源 ${source} · ${reason}）⇒ 此后不再点火`);
  }

  /** 解停链标志（「新起接力」；人工重启一条链）—— 两种来源都可解（显式解停链本身就是人工动作）。 */
  clearStop(requirementId: string, reason = "manual"): void {
    const reqId = requirementId.trim();
    if (reqId === "") return;
    const prev = this.stops.get(reqId);
    this.stops.delete(reqId);
    this.counts.set(reqId, 0);
    this.wakeWaits.delete(reqId);
    this.trace(
      reqId,
      `停链标志已解（${reason}${prev === undefined ? " · 原本未置" : ` · 原来源 ${prev.source} · 原原因 ${prev.reason}`}）`,
    );
  }

  /**
   * **人工动作**（补充 / 确认 / 回答）：链内连续点火计数清零 + 退让计时清零；
   * 停链标志**只清 `auto`**（解冻 ⇒ 链条可再被点火），**`user` 不清**（保持「一点即停、不再复活」）。
   * 「停链 / 新起接力」本身走 {@link requestStop} / {@link clearStop}，不经本口。
   */
  noteManualAction(requirementId: string, kind = "manual"): void {
    const reqId = requirementId.trim();
    if (reqId === "") return;
    this.counts.set(reqId, 0);
    this.wakeWaits.delete(reqId);
    const stop = this.stops.get(reqId);
    if (stop === undefined) {
      this.trace(reqId, `人工动作（${kind}）⇒ 链内计数清零`);
      return;
    }
    if (stop.source === "user") {
      this.trace(
        reqId,
        `人工动作（${kind}）⇒ 链内计数清零；停链标志来源 user（${stop.reason}）**不清** ⇒ 保持一点即停、不再复活`,
      );
      return;
    }
    this.stops.delete(reqId);
    this.trace(reqId, `人工动作（${kind}）⇒ 链内计数清零 + **解冻自动停链**（原原因 ${stop.reason}）`);
  }

  /**
   * **读面快照取值失败的留痕**（D2 · 件3）：只写一行日志，**不触碰任何链状态**。
   * 由宿主面 `chainSnapshotOf` 的兜底分支调用（接力未装配时无日志出口 ⇒ 读面直接不渲染该行）。
   */
  noteSnapshotFailure(requirementId: string, detail: string): void {
    this.trace(requirementId, `链状态快照取值失败 ⇒ 读面不渲染该行：${detail}`);
  }

  /** 唤醒退让计时观测面（D1 留痕 / 单测用）：未退让 ⇒ `null`。 */
  wakeWaitView(requirementId: string): { sinceMs: number; ticks: number } | null {
    return this.wakeWaits.get(requirementId.trim()) ?? null;
  }

  // -- 收口回调入口（HostTurnManager.onTurnSettled） -------------------------

  /**
   * **轮收口回调**（`void`，不 reject）：内部异步决策，异常自理、**绝不影响轮收口**。
   * 决策序见文件头（① 标志 → ② 计数 → ③ canceled → ④ 判定表）。
   */
  handleTurnSettled(result: TurnResult): void {
    void this.run(result).catch((err: unknown) => {
      this.trace(result.requirementId, `接力决策异常（已吞，不影响轮收口）：${errorText(err)}`);
    });
  }

  private async run(result: TurnResult): Promise<void> {
    const reqId = result.requirementId;

    // 该需求有轮收口 ⇒ 先前退让所等的那个占用者已不在场：唤醒退让计时清零（D1）。
    // 仍有排队轮时下一拍会重新撞并重新起算 —— 「每轮真的跑完」是进展，不计入同一次退让。
    if (this.wakeWaits.delete(reqId)) this.trace(reqId, "轮收口 ⇒ 唤醒退让计时清零");

    // ① 停链标志
    if (this.stops.has(reqId)) {
      this.trace(reqId, "判定序① 停链标志已置 ⇒ 不点火");
      return;
    }
    // ② 链内连续点火计数触顶
    const limit = this.chainLimit();
    if (this.chainCount(reqId) >= limit) {
      this.trace(reqId, `判定序② 链内连续点火计数触顶（${String(limit)}）⇒ 停链交人`);
      return;
    }
    // ③ canceled（恒不点火 —— 停链自激的唯一防线，先于判定表短路）
    if (result.state === "canceled") {
      this.trace(reqId, "判定序③ 轮态 canceled ⇒ 恒不点火（防停链自激）");
      return;
    }
    // ④ 判定表（含 C3 收口后一跳引擎态重取）
    const engine = await this.fetchEngine(reqId);
    const decision = shouldContinue(result, engine, this.suspendFor(reqId));
    this.trace(
      reqId,
      `判定序④ 接力决策 = ${decision.action}${decision.monitor === null ? "" : `/${decision.monitor}`} · ${decision.reason}`,
    );
    if (decision.action !== "continue") {
      this.notifyMonitor({ featureId: reqId, kind: "none", org: result.org, stage: engine?.stage ?? null });
      return;
    }
    if (decision.mode === "immediate") {
      this.fire(result, engine);
      this.notifyMonitor({ featureId: reqId, kind: "none", org: result.org, stage: engine?.stage ?? null });
      return;
    }
    // continue + monitor：进监视归 C7–C8 心跳接管；本模块**不立即点火**（防空转烧轮）
    this.notifyMonitor({
      featureId: reqId,
      kind: decision.monitor === "suspend" ? "suspend" : "auto",
      org: result.org,
      stage: engine?.stage ?? null,
    });
    this.trace(reqId, "进监视（C7/C8 心跳接管）：本轮不立即点火");
  }

  /** 监视归属通知（只读告知；异常不得影响接力决策）。 */
  private notifyMonitor(notice: RelayMonitorNotice): void {
    const cb = this.deps.onMonitor;
    if (cb === undefined) return;
    try {
      cb(notice);
    } catch (err: unknown) {
      this.trace(notice.featureId, `监视归属通知异常（已吞）：${errorText(err)}`);
    }
  }

  /**
   * **立即点火**（`submitTurn` 续火；供 `immediate` 判定）：用接力提示词。
   * 撞 occupant ⇒ 置停链标志、放弃这一发并留痕；提交抛错 ⇒ 停链。
   */
  fire(result: TurnResult, engine: EngineSnapshot | null): RelayFireResult {
    const buildPrompt = this.deps.buildPrompt ?? buildRelayPrompt;
    const prompt = buildPrompt({ featureId: result.requirementId, org: result.org, engine });
    return this.fireInternal({ requirementId: result.requirementId, org: result.org, prompt, source: "relay" });
  }

  /**
   * **唤醒点火**（v0.9.5 C8 · T8）：心跳命中后经此发一轮**已组装好的唤醒提示词**。
   * 与 {@link fire} 共用同一套刹车（停链标志 / 链内计数触顶）与**同一链内计数**
   * —— 唤醒计入链内连续点火计数（载体单一定义，本模块不另造）。
   *
   * **撞 occupant 与接力路径不同（D1）**：不置停链标志，按占用者身份分诊（见 {@link triageWakeOccupant}）。
   * `turnId` = 心跳条目登记时的那一发板轮（自动目标 ⇒ `null`），是分诊的身份键。
   */
  fireWake(input: { requirementId: string; org: string; prompt: string; turnId?: string | null }): RelayFireResult {
    return this.fireInternal({ ...input, source: "wake" });
  }

  private fireInternal(input: {
    requirementId: string;
    org: string;
    prompt: string;
    source: "relay" | "wake";
    turnId?: string | null;
  }): RelayFireResult {
    const reqId = input.requirementId;
    if (this.stops.has(reqId)) {
      this.trace(reqId, "点火前复核：停链标志已置 ⇒ 放弃");
      return { ok: false, reason: "stopped" };
    }
    const limit = this.chainLimit();
    if (this.chainCount(reqId) >= limit) {
      this.trace(reqId, `点火前复核：计数触顶（${String(limit)}）⇒ 放弃`);
      return { ok: false, reason: "limit" };
    }
    let submitted: SubmittedTurn;
    try {
      submitted = this.deps.submitTurn({
        org: input.org,
        requirementId: reqId,
        text: input.prompt,
      });
    } catch (err: unknown) {
      this.trace(reqId, `点火失败（提交抛错）⇒ 停链：${errorText(err)}`);
      return { ok: false, reason: "submit_error" };
    }
    if (submitted.occupant !== null) {
      if (input.source === "wake") return this.triageWakeOccupant(reqId, submitted.occupant.turnId, input.turnId ?? null);
      // 接力路径：保持「一撞即停」（含用户手工触发的情形，链交人裁决）。
      this.requestStop(reqId, `点火撞 occupant（${submitted.occupant.turnId}）`, "auto");
      return { ok: false, reason: "occupant", occupantTurnId: submitted.occupant.turnId };
    }
    const next = this.chainCount(reqId) + 1;
    this.counts.set(reqId, next);
    this.wakeWaits.delete(reqId);
    const sourceLabel = input.source === "wake" ? "唤醒" : "接力";
    this.trace(reqId, `已点火第 ${String(next)} 发（${sourceLabel} · 第 ${String(submitted.round)} 轮 · ${submitted.turnId}）`);
    return { ok: true, reason: "fired", turnId: submitted.turnId, round: submitted.round };
  }

  /**
   * **唤醒撞 occupant 的分诊**（D1，仅唤醒路径进入）：
   * ① 占用者 == 本条目登记的板轮 ⇒ `self`（自己还在收口）：本拍跳过，**不停链、不清计时**，
   *    等该轮收口（收口回调清零计时）或下一拍重评；
   * ② 占用者是同需求另一轮 ⇒ `yield`：累计退让（首次记 `sinceMs`），未超
   *    {@link WAKE_OCCUPANT_WAIT_LIMIT_MS} 只退让不动作；超限 ⇒ `exceeded`：停链 + 交人。
   * 三种结论**都不记去重位**（记与否由调用方心跳按 `ok` 决定），因此不丢后续唤醒机会。
   */
  private triageWakeOccupant(reqId: string, occupantTurnId: string, ownTurnId: string | null): RelayFireResult {
    // ① 占用者就是本条目登记的那一发轮（自己还在收口）⇒ 跳过本拍，不记去重位、不停链、不起退让计时。
    //    （`occupantTurnId` 恒为非空串，故 `ownTurnId = null` 的自动目标天然落到 ②。）
    if (ownTurnId === occupantTurnId) {
      this.trace(reqId, `唤醒撞 occupant = 本条目自己那一轮（${occupantTurnId}）⇒ 本拍跳过，等其收口后重评（不停链）`);
      return { ok: false, reason: "occupant_self", occupantTurnId };
    }
    const waitLimitMs = this.wakeOccupantWaitMs();
    const now = this.nowMs();
    const existing = this.wakeWaits.get(reqId);
    const wait = existing ?? { sinceMs: now, ticks: 0 };
    wait.ticks += 1;
    this.wakeWaits.set(reqId, wait);
    const waitedMs = Math.max(0, now - wait.sinceMs);
    if (waitedMs >= waitLimitMs) {
      this.requestStop(
        reqId,
        `唤醒退让等待超上限（${String(Math.round(waitLimitMs / 1000))}s · 第 ${String(wait.ticks)} 拍 · 占用轮 ${occupantTurnId}）`,
        "auto",
      );
      return { ok: false, reason: "occupant_wait_exceeded", occupantTurnId, waitedMs };
    }
    this.trace(
      reqId,
      `唤醒撞 occupant（同需求新一轮 ${occupantTurnId}）⇒ 退让等待第 ${String(wait.ticks)} 拍` +
        `（已等 ${String(waitedMs)}ms / 上限 ${String(waitLimitMs)}ms）`,
    );
    return { ok: false, reason: "occupant_yield", occupantTurnId, waitedMs };
  }

  // -- 内部 ----------------------------------------------------------------

  /** C3：收口后一跳只读重取；探针缺省 / 读面失败 ⇒ `null`（判定表据此保守停链）。 */
  private async fetchEngine(reqId: string): Promise<EngineSnapshot | null> {
    const probe = this.deps.probe ?? null;
    if (probe === null) {
      this.trace(reqId, "C3 引擎态探针未装配 ⇒ 引擎态未知");
      return null;
    }
    try {
      return (await probe.fetchEngineState(reqId)) ?? null;
    } catch (err: unknown) {
      this.trace(reqId, `C3 引擎态重取失败 ⇒ 保守停链：${errorText(err)}`);
      return null;
    }
  }

  private suspendFor(reqId: string): SuspendMarker | null {
    const lookup = this.deps.suspendLookup;
    if (lookup === undefined) return null;
    try {
      return lookup(reqId) ?? null;
    } catch {
      return null;
    }
  }

  /** D1 唤醒退让总等待上限（可注入，测试用小值）。 */
  private wakeOccupantWaitMs(): number {
    return this.deps.wakeOccupantWaitMs ?? WAKE_OCCUPANT_WAIT_LIMIT_MS;
  }

  private nowMs(): number {
    return (this.deps.now ?? Date.now)();
  }

  private trace(reqId: string, line: string): void {
    const log = this.deps.log;
    if (log === undefined) return;
    const at = new Date((this.deps.now ?? Date.now)()).toISOString();
    log(`[relay] ${at} ${reqId} ${line}`);
  }
}

/** 装配入口（`index.ts` 起服务时经 `BoardHostFace.startRelay` 调用）。 */
export function createHostRelay(deps: HostRelayDeps): HostRelay {
  return new HostRelay(deps);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
