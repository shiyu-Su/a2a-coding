/**
 * 板的**宿主面**（v0.9.0 · BD8）—— 把 BD4a 的进程托管（`HostBridgeManager`）与
 * BD4b 的对话轮（`HostTurnManager`）接成 HTTP 层可用的三件事：**触发一轮 / 桥状态视图 / 停桥**。
 *
 * 事实源：`doc/v0.9.0/Web看板与确认入口-改造文档.md`
 * - **§2.2-3**：`featureId` 注入 prompt ⇒ 宿主 agent 由「创建者」变「推进者」；
 * - **§2.2-6**：一组织一桥、桥内每需求一个 `contextId`（分配与复用归 BD4b 台账，本文件不另造）；
 * - **§2.2-7**：**故障可见**（板必须显示「宿主桥已断」，不得静默、不得假数据）；
 * - **§3.4**：起桥参数只经 `buildBridgeLaunchPlan` / `getAdapter()`（本文件**不拼 argv、不写 RPC**）；
 * - **§3.6 直接约束 3**：提示词**不得硬编码工具全名**（三家后端工具名不同）；
 * - **§3.8 裁定 9**：组织目录落点 = **板级可配置 · 无默认值 · 缺失即报错**，**严禁静默回落**。
 *
 * ## 本节点的边界
 * - **确认 / 回答是「投消息」，不是状态机写口**（BD9）：
 *   `confirmTurn` = 把「用户已确认改造文档，请核对后执行放行」作为**一轮消息**投给宿主 agent
 *   （与 `triggerTurn` 同一条触发通道），**放不放行由 agent 判断**；
 *   `answerRequirement` = 仅当该需求存在**当前待澄清的一轮**（`awaiting_answer` ∧ 未被更新轮取代）时，
 *   把回答经 `answerTurn` **续推同一 `contextId`**；否则结构化拒绝（`board_no_awaiting_turn`）；
 * - **本文件不写引擎状态机迁移**：`approve` / `cancel` / 主链 `advance`（迁到非当前态）一个都不碰
 *   （含**文案级**不出现其工具全名）；唯一放开的登记字段写（`version` 排期，经 advance「`to` = 当前态」
 *   特例）落点在**并列的第二个 MCP 写封装** `feature-schedule.ts`，不在本文件；
 *   轮的终态只落板侧台账（BD4b 已做）；
 * - **不新写进程管理与 RPC**：起 / 停 / 查委派 {@link BridgeOps}，发轮委派 {@link TurnOps}
 *   —— 两者都是**窄接口**（真类结构上即满足）⇒ 单测注入假托管器 / 假桥即可离线断言全部语义。
 *
 * ## 排队轮为什么「不等」
 * 闸位容量 = 1（§3.4 R4）。落闸后的轮由 `submitTurn` 自己排队、前一轮收口后由 `pump` 开跑。
 * HTTP 侧若把排队轮也 `await done`，一个请求要吃掉「前一轮 + 本轮」**两个**有界窗 ⇒ 响应时间翻倍且不可解释。
 * 故：**在飞轮 ⇒ 等到终态**（结果即刻显示）· **排队轮 ⇒ 立即回「排队中」**，
 * 其终态改由 `GET /host`（队列视图）与板侧台账承载。
 */
import { resolve, sep } from "node:path";
import { statDirKind, type DirKind, type DirKindProbeFn } from "./host-runtime.js";
import {
  DEFAULT_HOST_AGENT_KIND,
  DEFAULT_IDLE_STOP_MS,
  HOST_BRIDGE_DOWN_MESSAGE,
  ORG_WORKSPACE_MISSING,
  type EnsureStartedResult,
  type HostBridgeConfig,
  type HostBridgeStatus,
} from "./host-bridge.js";
import {
  type BridgeQueueView,
  type CancelTurnResult,
  type OccupantTurnView,
  type SubmittedTurn,
  type SubmitTurnInput,
  type TurnResult,
} from "./host-turn.js";
import {
  type EngineStateProbe,
  type RelayMonitorNotice,
  type SuspendMarker,
  HostRelay,
  buildRelayPrompt,
  createHostRelay,
} from "./host-relay.js";
import type { ChainStateSnapshot } from "./derive.js";
import { type TurnRecord, type TurnState } from "./host-turn-ledger.js";
import { RECEIPT_CONTRACT, type Receipt } from "./receipt.js";

// ---------------------------------------------------------------------------
// 错误码（HTTP 层据此分流；**不得静默**）
// ---------------------------------------------------------------------------

/** 组织目录根未配置（§3.8 裁定 9：无默认值、缺失即报错，**严禁回落兜底路径**）。 */
export const ORGS_DIR_NOT_CONFIGURED = "board_orgs_dir_not_configured";

/**
 * **组织目录根配了但指向的目录不可用**（BD14）—— 与上一条是两回事：
 * `board_orgs_dir_not_configured` = 压根没填；本码 = **填了、但那个路径不存在或不是目录**
 * （= 配错，过去与「配好」完全同形，直到触发一轮才以负 errno 暴露）。
 */
export const ORGS_DIR_MISSING = "board_orgs_dir_missing";

/** 归属组织无法确定（桥的 `ownerGroup` 为空 ∧ 板级组织名未配置 ⇒ 不猜）。 */
export const ORG_NOT_RESOLVED = "board_org_not_resolved";

/** 组织名不能安全落为目录（拒绝分隔符 / `..` / 盘符 ⇒ 防逃逸出组织根）。 */
export const ORG_NAME_INVALID = "board_org_name_invalid";

/**
 * 组织台账里该组织**已停用**（v0.9.4 A3/A4 · BD3）⇒ 不起桥、不供给 workspace、不提新需求。
 * 与 {@link ORGS_DIR_MISSING} 同族（都是「落点/台账事实」问题，不是「桥断了」）⇒ 一律 `config_error` 档。
 */
export const ORG_DISABLED = "board_org_disabled";

/** 触发一轮的入参不合法。 */
export const TURN_REQUEST_INVALID = "board_turn_request_invalid";

/** 桥起不来 / 已断 / 中途消失 —— 与「本轮业务失败」区分，页面按「宿主桥已断」显示。 */
export const BRIDGE_DOWN_CODES: readonly string[] = [
  "bridge_unavailable",
  "bridge_unreachable",
  "bridge_exited",
  "bridge_start_timeout",
  "spawn_failed",
  "launch_plan_failed",
];

/** 首轮提示词的标题行前缀（用例据此钉住「提示词不含工具全名」）。 */
export const TURN_PROMPT_TITLE = "【板 · 触发一轮】";

/** BD9 人工确认指令的标题行前缀。 */
export const CONFIRM_PROMPT_TITLE = "【板 · 人工确认指令】";

/** 该需求当前没有 `awaiting_answer` 的轮 ⇒ 回答入口不可用（结构化拒绝）。 */
export const NO_AWAITING_TURN = "board_no_awaiting_turn";

/**
 * 该需求已有**在飞或排队**的一轮 ⇒ 本次提交不重复入队（收口轨 14 服务端防重，409）。
 * 与 {@link NO_AWAITING_TURN} 同族（`board_` 前缀 + 结构化载荷 = 占用轮 id / kind）。
 */
export const TURN_BUSY = "board_turn_busy";

/**
 * 该需求已进入**引擎终态**（completed / failed / cancelled）⇒ 写面三入口（turn / confirm / answer）
 * 一律拒收（收口轨 16 ③，409）。防「绕过页面直调 API」为一个已结束的需求白烧一轮。
 */
export const FEATURE_TERMINAL = "board_feature_terminal";

/**
 * **v0.9.5 C4 · T3**：自动接力驱动器未装配（宿主面在、但 `startRelay` 未起 / 轮管理器不支持收口回调）
 * ⇒ 按需求停链口无链可停（无内存标志可置），如实结构化 503，**不假装已停**。
 */
export const RELAY_NOT_ASSEMBLED = "board_relay_not_assembled";

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

export type OrgWorkspaceResolution =
  | { ok: true; workspace: string }
  | { ok: false; code: string; error: string };

/**
 * 组织 → 桥 `--workspace`（= `<组织根>/<组织名>`）。
 * 组织名参与路径拼接 ⇒ 必须拒绝分隔符 / 相对段 / 盘符，并再核验结果仍在组织根内
 * （逃逸 = 板被诱导往任意目录 spawn 后端进程）。
 */
export function resolveOrgWorkspace(orgsDir: string, org: string): OrgWorkspaceResolution {
  const name = org.trim();
  if (name === "") return { ok: false, code: ORG_NAME_INVALID, error: "组织名为空：无法定位组织目录" };
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes(":")) {
    return { ok: false, code: ORG_NAME_INVALID, error: `组织名含路径分隔符，不可作为目录名：${name}` };
  }
  const root = resolve(orgsDir);
  const workspace = resolve(root, name);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const inside = process.platform === "win32"
    ? workspace.toLowerCase().startsWith(prefix.toLowerCase())
    : workspace.startsWith(prefix);
  if (!inside) {
    return { ok: false, code: ORG_NAME_INVALID, error: `组织目录落在组织根之外：${name}` };
  }
  return { ok: true, workspace };
}

/**
 * 组织目录根（`orgsDir`）的**存在性校验**（BD14 · 纯函数）：`missing` / `not_dir` 两档各给
 * 「什么不对 + 期望路径 + 怎么补」。未配置（`orgsDir === null`）不在此码辖区 ——
 * 那是既有的 {@link ORGS_DIR_NOT_CONFIGURED}，两者不得混为一谈。
 */
export function diagnoseOrgsDir(orgsDir: string, kind: DirKind): { code: string; message: string } | null {
  if (kind === "dir") return null;
  const abs = resolve(orgsDir);
  const remedy =
    kind === "missing"
      ? `对策：改 config.json 的 orgsDir 指向已有目录，或先 mkdir "${abs}" —— 板不会代建`
      : `对策：该路径上是个**文件**，请改 config.json 的 orgsDir（或移开该文件）`;
  return {
    code: ORGS_DIR_MISSING,
    message: `组织目录根${kind === "missing" ? "不存在" : "不是目录（该路径上是个文件）"}：${abs} ⇒ 任何组织的宿主桥都无落点，不 spawn 进程。${remedy}`,
  };
}

/** 错误码是否属于「宿主桥已断」一族。 */
export function isBridgeDownCode(code: string | null | undefined): boolean {
  return code !== undefined && code !== null && BRIDGE_DOWN_CODES.includes(code);
}

/** 桥状态是否属于「已断」（`unreachable` / `exited` / `failed`）。 */
export function isBridgeDownState(state: HostBridgeStatus["state"]): boolean {
  return state === "unreachable" || state === "exited" || state === "failed";
}

/**
 * 桥状态是否属于「活跃」（v0.9.4 A3 · BD3 拒删前置闸判据）：`running` / `starting` / `unreachable`。
 * **刻意把 `unreachable` 也算活跃**（进程可能仍在、只是端口暂时连不上）—— 宁可多拦（引导用户先逐桥 stop）
 * 也不漏拦（漏拦会把「还有宿主桥的组织」标记停用，违背「不做隐式连带停桥」）。`exited` / `failed` = 已终，不拦。
 */
export function isActiveBridgeState(state: HostBridgeStatus["state"]): boolean {
  return state === "running" || state === "starting" || state === "unreachable";
}

/**
 * 首轮提示词（纯函数）。**不出现任何 MCP 工具全名**（§3.6：claude / qoder / opencode / codex 各家不同），
 * 也不指示 agent 去「点确认」—— 门与推进的表述停在「需要人决策 ⇒ input-required」。
 *
 * **v0.9.5 C2**：`supplement` = 用户在板上**补充口**随本轮一起发来的自由文本（可选）；
 * `trim` 后非空才追加一段显式标注来源的补充块，空 / 缺省 ⇒ 逐字节等同既有纯触发提示词（零行为变更）。
 */
export function buildTurnPrompt(input: {
  featureId: string;
  org: string;
  version?: string | null;
  /** v0.9.5 C2：用户随本轮附加的**可选**补充文本（空 / 缺省 ⇒ 不追加）。 */
  supplement?: string | null;
}): string {
  const versionLine = input.version !== undefined && input.version !== null && input.version !== ""
    ? ` · 版本 ${input.version}`
    : "";
  const lines = [
    `${TURN_PROMPT_TITLE} 需求 ${input.featureId}${versionLine} · 组织 ${input.org}`,
    "",
    "你是这条需求的**推进者**（需求实体已由板以本组织身份创建，初态停在审批门前）。",
    "以当前工作目录为本组织目录，按 AGENTS.md 的需求流程规范推进该需求**当前该做的一步**：",
    "1. 先用编排桥的只读能力查清这条需求现在的引擎态与登记阶段，不要凭猜测动手；",
    "2. 按所处阶段产出该阶段的文档（需求确认单 / 改造文档等），写入本组织目录的 doc/{版本}/；",
    "3. 需要人决策就用 A2A 的 input-required 结束本轮，不要自问自答；",
    "4. 状态机推进（审批 / 推进 / 取消）只能经编排桥的能力做，板不代劳。",
    // v0.9.5 C9（R2 定稿，board 侧一行指针）：本轮若下发子任务，先调挂起口再退出，见 workspace 纪律。
    "5. 本轮若下发子任务，先调板侧挂起口登记 pending 清单再退出本轮（勿空占本轮预算干等）；挂起口地址与 schema 见本组织 workspace 的 AGENTS.md。",
  ];
  const supplement = (input.supplement ?? "").trim();
  if (supplement !== "") {
    lines.push(
      "",
      "【用户补充（本轮随附，来自板上补充口）】",
      supplement,
      "⇒ 请把上述补充纳入本轮判断与产出。",
    );
  }
  // v0.9.6 N6：轮回执契约常量（单点定义于 receipt.ts）——本轮收尾时按此格式输出回执块。
  lines.push("", RECEIPT_CONTRACT);
  return lines.join("\n");
}

/**
 * **人工确认指令**（BD9，纯函数）：用户在板上点了「已确认改造文档」⇒ 板把这件事作为一轮消息
 * 投给宿主 agent，由 **agent** 核对后执行审批放行（approve 语义）。
 * 与 {@link buildTurnPrompt} 同一硬口径：**不出现任何 MCP 工具全名**（§3.6）；
 * 并显式写明「条件不满足就**不得放行**」——按钮不是批准，agent 保留判断。
 */
export function buildConfirmPrompt(input: { featureId: string; org: string; version?: string | null }): string {
  const versionLine = input.version !== undefined && input.version !== null && input.version !== ""
    ? ` · 版本 ${input.version}`
    : "";
  return [
    `${CONFIRM_PROMPT_TITLE} 需求 ${input.featureId}${versionLine} · 组织 ${input.org}`,
    "",
    "用户刚刚在板上表示：**已确认这条需求的改造文档**。",
    "这不是板上批准 —— 板不写引擎状态机，放行只能由你（推进者）核对后执行。",
    "1. 先只读核对：改造文档是否已落文件、边界确认是否已完成、审批门是否处于「待审批」；",
    "2. 核对通过 ⇒ 经编排桥的审批能力（approve 语义）放行这条需求，再按流程继续推进当前该做的一步；",
    "3. 条件不满足 ⇒ **不要放行**，用本轮结论如实说明缺什么（需要人补齐就用 A2A 的 input-required 收口），不得为迎合按钮硬推。",
    // v0.9.6 N6：确认档同样是一轮收尾 ⇒ 引用同一契约常量。
    "",
    RECEIPT_CONTRACT,
  ].join("\n");
}

export type TriggerDisposition =
  | "queued"
  | "awaiting_answer"
  | "succeeded"
  | "canceled"
  | "not_awaiting"
  | "busy"
  | "terminal"
  | "timeout"
  | "bridge_down"
  | "turn_failed"
  | "config_error";

/** 结局 → 建议 HTTP 状态（口径单点，HTML 与 JSON 档共用；**失败不伪装成 200**）。 */
export function dispositionHttpStatus(d: TriggerDisposition): number {
  switch (d) {
    case "queued":
      return 202;
    case "not_awaiting":
    case "busy":
    case "terminal":
      return 409;
    case "timeout":
      return 504;
    case "bridge_down":
    case "turn_failed":
      return 502;
    case "config_error":
      return 503;
    case "awaiting_answer":
    case "succeeded":
    case "canceled":
    default:
      return 200;
  }
}

/** 轮的终态 → 结局分流（`awaiting_answer` **不是失败**，§2.2 硬口径）。 */
export function dispositionOfTurn(state: TurnState): TriggerDisposition {
  switch (state) {
    case "awaiting_answer":
      return "awaiting_answer";
    case "timeout":
      return "timeout";
    case "failed":
      return "turn_failed";
    case "canceled":
      return "canceled";
    case "succeeded":
    default:
      return "succeeded";
  }
}

// ---------------------------------------------------------------------------
// 注入面（窄接口）
// ---------------------------------------------------------------------------

/** BD4a 的进程侧出口（只用到这四个方法；起停查的语义全在 BD4a）。 */
export interface BridgeOps {
  ensureStarted(config: HostBridgeConfig): Promise<EnsureStartedResult>;
  stop(org: string, reason?: string): Promise<HostBridgeStatus | null>;
  statuses(): HostBridgeStatus[];
  health(org: string): Promise<HostBridgeStatus | null>;
}

/** BD4b 的轮次侧出口。 */
export interface TurnOps {
  submitTurn(input: SubmitTurnInput): SubmittedTurn;
  /** BD9 回答入口：仅经此续推（同 `contextId` 的复用由 BD4b 会话台账保证）。 */
  answerTurn(input: { org: string; requirementId: string; answer: string; timeoutMs?: number }): SubmittedTurn;
  /** 该需求最近一条轮记录（仅用于拒绝文案的「最近轮态」回显，不再充当回答判据）。 */
  latestTurnOf(requirementId: string): TurnRecord | null;
  /**
   * 该需求**当前待澄清的一轮**（收口轨 16 ②）：`awaiting_answer` ∧ 未被任何更新轮取代 ⇒ 记录；否则 `null`。
   * 回答入口与详情页回答框都只认这一判据（陈旧残留不算数）。
   */
  findAwaitingTurn(requirementId: string): TurnRecord | null;
  /** 该需求当前在飞 / 排队的一轮（收口轨 14 防重 + 渲染禁用判据）；无 ⇒ null。 */
  busyTurnOf(requirementId: string): OccupantTurnView | null;
  /**
   * **v0.9.5 C4 · T3 停一轮**（按 `turnId`）：排队 ⇒ 出队落 `canceled`（**一条也不发**）；
   * 在飞 ⇒ `tasks/cancel` 收口 `canceled`。停链口用它清该需求占闸的那一轮。
   * 窄接口替身未实现 ⇒ 停链口只置标志、不取消（既有行为不变）。
   */
  cancelTurn?(turnId: string): Promise<CancelTurnResult>;
  queueView(org: string): BridgeQueueView;
  activeTurns(org?: string): TurnResult[];
  /**
   * **v0.9.5 C1**：装 / 换轮收口回调（自动接力的信号源）。轮管理器可选实现；
   * 未实现（窄接口替身）⇒ `startRelay` 不装（既有行为零变更）。
   */
  setTurnSettledHandler?(handler: ((result: TurnResult) => void) | null): void;
}

// ---------------------------------------------------------------------------
// 对外结果形状
// ---------------------------------------------------------------------------

export interface TriggerTurnOutcome {
  ok: boolean;
  org: string;
  featureId: string;
  disposition: TriggerDisposition;
  /** `queued` ⇒ true（本轮未开跑，终态改由状态页 / 台账承载）。 */
  queued: boolean;
  turnId: string | null;
  contextId: string | null;
  round: number | null;
  state: TurnState | null;
  display: string;
  summary: string | null;
  question: string | null;
  /**
   * 本轮尾部【回执】块的结构化结果（v0.9.6 N4 · 契约见 `receipt.ts`）。
   * 只有**真正跑到终态**的那条收口（`settleSubmitted` 取 `TurnResult.receipt`）带真值；
   * 未起轮的拒单（配置错 / 终态 / 排队…）一律 `null` ⇒ 结果页走现状渲染。
   */
  receipt: Receipt | null;
  error: { code: string; message: string } | null;
  /** 桥的 pid / port / kind（触发时如实回显，便于真机取证）。 */
  bridge: { pid: number | null; port: number | null; kind: string } | null;
}

export interface HostStatusEntry {
  status: HostBridgeStatus;
  queue: BridgeQueueView;
  active: TurnResult[];
}

/**
 * **终态需求的写面拒单**（收口轨 16 ③，纯函数）：引擎已 completed / failed / cancelled
 * ⇒ 不起桥、不发轮，直接收口成 409 `board_feature_terminal` 的 {@link TriggerTurnOutcome}
 * （HTML 与 JSON 档共用，与其它拒绝同一形状）。
 */
export function terminalTurnRejection(featureId: string, engineState: string): TriggerTurnOutcome {
  return {
    ok: false,
    org: "",
    featureId,
    disposition: "terminal",
    queued: false,
    turnId: null,
    contextId: null,
    round: null,
    state: null,
    display: `本需求已终态（${engineState}）：本轮未提交`,
    summary: null,
    question: null,
    receipt: null,
    error: {
      code: FEATURE_TERMINAL,
      message: `该需求已进入引擎终态（${engineState}）⇒ 触发 / 确认 / 回答不再受理，板不为已结束的需求白烧一轮`,
    },
    bridge: null,
  };
}

export interface StopBridgeOutcome {
  ok: boolean;
  org: string;
  status: HostBridgeStatus | null;
  error: { code: string; message: string } | null;
  display: string;
}

/**
 * **v0.9.5 C4 · T3** 按需求停链的收口形状（`POST /features/:id/stop-chain` 的落点）。
 * 停链 = 置**内存**停链标志（接力决策器见标志即停、此后不再点火）+ 清该需求占闸的那一轮。
 */
export interface StopChainOutcome {
  ok: boolean;
  featureId: string;
  /** 停链标志是否已置（未起接力 / 标识缺失 ⇒ false）。 */
  chainStopped: boolean;
  /** 被清的那一轮 `turnId`（无在飞 / 排队轮，或替身未实现 `cancelTurn` ⇒ null）。 */
  cancelledTurnId: string | null;
  /** 取消动作的显示文案（无取消 ⇒ null）。 */
  cancelDisplay: string | null;
  error: { code: string; message: string } | null;
  display: string;
}

/** **v0.9.5 C8 · T8** 心跳唤醒点火的收口（`BoardHostFace.wakeTurn`；计数归接力驱动器）。 */
export interface WakeFireOutcome {
  ok: boolean;
  reason: string;
  turnId?: string;
  round?: number;
  /** 撞车的占用轮 `turnId`（仅撞 occupant 时有值）；供心跳结构化留痕。 */
  occupantTurnId?: string | null;
}

export interface HostFaceDeps {
  bridges: BridgeOps;
  turns: TurnOps;
  /** 组织目录根（§3.8 裁定 9）；`null` ⇒ 触发一律结构化 503，**不回落任何兜底路径**。 */
  orgsDir: string | null;
  /**
   * **板级默认组织**（BD11 起为「可选默认」，与提需求表单同源）：桥的 `ownerGroup` 缺失时的
   * **显式**回退目标，`null` ⇒ 不猜。组织名的主来源是表单（用户在前台创建/指定），未配默认不是错误。
   */
  defaultOrg: string | null;
  /** 缺省宿主 kind（§3.8 裁定 #4 = `claude`）。 */
  kind?: string;
  /** 缺省空闲回收阈值（BD4a 口径）。 */
  idleStopMs?: number;
  /** 单轮有界等待上限（ms）；缺省 ⇒ 交给 BD4b 的缺省。 */
  turnTimeoutMs?: number;
  /**
   * **宿主后端模型**（v0.9.5 · 本次仅开 `model` 一键）：有值 ⇒ 起桥时透传 `agentConfig.model`；
   * `null` / 缺省 / 空串 ⇒ 不注入（后端自身缺省）。**板不校验取值**（非法值由后端处置）。
   */
  hostModel?: string | null;
  /** 注入给后端的 MCP 端点推导（缺省由 BD4a 的 `defaultMcpUrlForOrg` 口径给出）。 */
  mcpUrlFor?: (org: string) => string;
  /**
   * 目录三态探针（BD14 · 缺省 = 真查盘）：只用于**组织目录根**这一处，
   * 目的是让「配了但不存在」在**触发前**就是结构化错误，而不是等 spawn 撞出一个负 errno。
   */
  dirKind?: DirKindProbeFn;
  /**
   * **停用闸判据**（v0.9.4 A4 · BD3）：组织在板台账里被标记停用 ⇒ 该组织的 spawn/ensure 一律结构化拒绝。
   * 事实源 = 板组织台账 `.data/orgs.json`（`orgs-ledger.ts`），由装配方注入读取口径（本文件不碰文件）；
   * 未注入 ⇒ 不判停用（等价于「台账没有停用概念」，保持 BD1–BD2 期间的宿主面行为）。
   */
  isOrgDisabled?: (org: string) => boolean;
  /**
   * **v0.9.5 C3 只读引擎态探针**（自动接力点火判据）：轮收口后一跳 `getFeature` 重取
   * `state/stage/approval`。由装配方（`index.ts`，`BridgeClient` 的所有者）注入只读实现；
   * 未注入 ⇒ 接力决策判不了引擎态 ⇒ **保守停链、不点火**（既有行为不变）。
   */
  engineProbe?: EngineStateProbe | null;
  /**
   * **v0.9.5 增补二 · D2 链状态只读快照**（详情页「链状态」一行的事实源）：
   * `featureId → { chainState, reason, source, pendingCount }`。由装配层（`index.ts`）把
   * 接力驱动器（停链标志 + 来源）、挂起台账（pending 条数）、心跳（自动 armed）三处内存态**归一成一个只读闭包**
   * 注入 —— 本文件拿不到 heartbeat / 台账，故走注入而非自造第二套事实。
   * **只读**：实现不得写任何链状态。未注入 ⇒ {@link BoardHostFace.chainSnapshotOf} 回落接力驱动器
   * 内存态给出最小快照（`pendingCount = null`）；接力也未起 ⇒ `null`（读面不渲染该行）。
   */
  chainSnapshot?: (featureId: string) => ChainStateSnapshot | null;
}

// ---------------------------------------------------------------------------
// 宿主面
// ---------------------------------------------------------------------------

/**
 * 组织 → 起桥配置（**纯函数**）。抽出来的理由：`index.ts` 还要把同一份口径交给
 * `createHostBridgeGateway`（对话轮侧的起桥口）—— 两侧必须算出**同一个** workspace，
 * 否则「触发时的组织目录」与「轮内重拉桥时的目录」会分家。
 * workspace 落点在此决定，**无兜底路径**（§3.8 裁定 9）。
 *
 * **A4 停用闸也在这一层**（v0.9.4 · BD3）：本函数是 spawn/ensure 的**唯一配置入口**
 * （`BoardHostFace.bridgeConfigFor` 与 `index.ts` 的轮内重拉桥口都走它）⇒ 命中停用台账即结构化拒绝，
 * 「触发一轮」与「轮内重拉」两条路同闸。**`prepareWorkspace` 纯函数不动**（mkdir 供给语义保持无组织状态知识）。
 */
export function orgBridgeConfig(
  deps: Pick<HostFaceDeps, "orgsDir" | "kind" | "idleStopMs" | "mcpUrlFor" | "isOrgDisabled" | "hostModel">,
  org: string,
): HostBridgeConfig | { error: { code: string; message: string } } {
  if (deps.orgsDir === null) {
    return {
      error: {
        code: ORGS_DIR_NOT_CONFIGURED,
        message: "组织目录根未配置（config.json 的 orgsDir 留空/缺键，无缺省值）⇒ 宿主面不起桥，不回落任何兜底路径",
      },
    };
  }
  const ws = resolveOrgWorkspace(deps.orgsDir, org);
  if (!ws.ok) return { error: { code: ws.code, message: ws.error } };
  if (deps.isOrgDisabled?.(org.trim()) === true) {
    return {
      error: {
        code: ORG_DISABLED,
        message: `组织 ${org.trim()} 已在板台账停用 ⇒ 不起桥、不 spawn 任何后端进程；恢复 = 用同名重新建组织（零迁移）`,
      },
    };
  }
  const config: HostBridgeConfig = {
    org,
    workspace: ws.workspace,
    kind: deps.kind ?? DEFAULT_HOST_AGENT_KIND,
    idleStopMs: deps.idleStopMs ?? DEFAULT_IDLE_STOP_MS,
  };
  if (deps.mcpUrlFor !== undefined) config.mcpUrl = deps.mcpUrlFor(org);
  // v0.9.5 C2：宿主后端模型透传 —— **有值才带**，只放 `model` 一键（`backendCmd` 等不在本次范围）。
  if (deps.hostModel != null && deps.hostModel !== "") config.agentConfig = { model: deps.hostModel };
  return config;
}

/**
 * 板侧**唯一**的宿主面出口（HTTP 层只认这个类的接口）。
 * 与 BD7 写面同规格：一切失败都是结构化错误，页面据此显示，不缓存、不假数据。
 */
export class BoardHostFace {
  private readonly deps: HostFaceDeps;
  /** v0.9.5 C1：接力驱动器（`startRelay` 装配；未装配 ⇒ `null`，人工动作钩子与停链口为空操作）。 */
  private relay: HostRelay | null = null;

  constructor(deps: HostFaceDeps) {
    this.deps = deps;
  }

  // -- v0.9.5 C1：自动接力入口 / 停链口 ---------------------------------------

  /**
   * **起接力**（幂等）：建 {@link HostRelay} 并把轮收口回调接到轮管理器。
   *
   * 回调是接力的**唯一信号源**（`HostTurnManager.onTurnSettled`，在交闸与落计数之后触发）；
   * 轮管理器未实现 `setTurnSettledHandler`（窄接口替身 / 既有测试）⇒ 本方法返 `null`、**不装**，
   * 既有行为零变更。探针来自 `HostFaceDeps.engineProbe`（C3）；未注入 ⇒ 决策保守停链。
   */
  startRelay(input?: {
    chainLimit?: number;
    log?: (line: string) => void;
    /**
     * **v0.9.5 C7/C8** 显式挂起条目查询（返 `null` = 无条目）：供决策器分辨
     * 「显式挂起（MON1）」与「忘调挂起口的自动 armed（MON2，⑤ 兜底适用）」。
     */
    suspendLookup?: (requirementId: string) => SuspendMarker | null;
    /**
     * **v0.9.5 C8** 监视归属通知（只读告知）：心跳据此维护自动 armed 注册表。
     */
    onMonitor?: (notice: RelayMonitorNotice) => void;
  }): HostRelay | null {
    if (this.deps.turns.setTurnSettledHandler === undefined) return null;
    if (this.relay !== null) return this.relay;
    const deps: Parameters<typeof createHostRelay>[0] = {
      submitTurn: (i) => this.deps.turns.submitTurn(i),
      buildPrompt: buildRelayPrompt,
      probe: this.deps.engineProbe ?? null,
    };
    if (input?.chainLimit !== undefined) deps.chainLimit = input.chainLimit;
    if (input?.log !== undefined) deps.log = input.log;
    if (input?.suspendLookup !== undefined) deps.suspendLookup = input.suspendLookup;
    if (input?.onMonitor !== undefined) deps.onMonitor = input.onMonitor;
    const relay = createHostRelay(deps);
    this.relay = relay;
    this.deps.turns.setTurnSettledHandler((result) => relay.handleTurnSettled(result));
    return relay;
  }

  /** 已装配的接力驱动器（未起 ⇒ `null`）。 */
  relayOf(): HostRelay | null {
    return this.relay;
  }

  /** **按需求停链**（T3 停链口写面）：置内存停链标志（来源 `user`），此后该需求任何收口都不再点火。 */
  requestStopChain(featureId: string): boolean {
    if (this.relay === null) return false;
    this.relay.requestStop(featureId, "route", "user");
    return true;
  }

  /** 解停链标志（「新起接力」）。 */
  clearStopChain(featureId: string): boolean {
    if (this.relay === null) return false;
    this.relay.clearStop(featureId, "route");
    return true;
  }

  /** 该需求是否已置停链标志（未起接力 ⇒ `false`）。 */
  chainStopped(featureId: string): boolean {
    return this.relay?.isChainStopped(featureId) ?? false;
  }

  /** 该需求停链标志的**来源与原因**（未置 / 未起接力 ⇒ `null`）。只读，不改任何链状态。 */
  chainStopView(featureId: string): { reason: string; source: "user" | "auto" } | null {
    return this.relay?.stopView(featureId) ?? null;
  }

  /**
   * **详情页「链状态」一行的事实源**（v0.9.5 增补二 · D2，只读）：
   * ① 装配层注入的快照闭包优先（含挂起台账 pending 条数 / 心跳自动 armed）；
   * ② 未注入 ⇒ 回落接力驱动器的内存停链标志（`pendingCount = null` = 读不到就不显示个数）；
   * ③ 两者都拿不到 ⇒ `null` ⇒ 读面**不渲染该行、不报错**；
   * ④ 取值**抛错** ⇒ 一行留痕 + `null`（同样不崩详情页）。
   * 本方法**不写任何状态**（既有的「人工动作只清 auto」解冻只发生在 `noteManualAction` 路径）。
   */
  chainSnapshotOf(featureId: string): ChainStateSnapshot | null {
    const id = featureId.trim();
    if (id === "") return null;
    try {
      const injected = this.deps.chainSnapshot;
      if (injected !== undefined) return injected(id) ?? null;
      const stop = this.relay?.stopView(id);
      if (stop !== undefined && stop !== null) {
        return { chainState: "stopped", reason: stop.reason, source: stop.source, pendingCount: null };
      }
      if (this.relay === null) return null;
      return { chainState: "monitoring", reason: null, source: null, pendingCount: null };
    } catch (err: unknown) {
      this.relay?.noteSnapshotFailure(id, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * **按需求停链**（v0.9.5 C4 · T3 写路由 `POST /features/:id/stop-chain` 的落点）：
   * ① 置内存停链标志（接力决策器**判定序①** 见标志即停 ⇒ 此后任何收口都不再点火）；
   * ② 复用 {@link TurnOps.cancelTurn} 清该需求占闸的那一轮（排队 ⇒ 出队落 `canceled`、**一条也不发**；
   *    在飞 ⇒ `tasks/cancel` 收口 `canceled`）—— 被取消的收口**必然触发收口回调**，但标志已先置
   *    ⇒ 判定序① 短路，不会「停链 → 取消 → 回调 → 又点一发」自激。
   *
   * **不落 `.data/` 台账、不跨重启持久**（改造文档 §2-C4 显式钉）：接力链本身是进程内 Promise 链，
   * 重启即无链可停。未起接力（`startRelay` 返 null）⇒ 结构化 {@link RELAY_NOT_ASSEMBLED}，不假装已停。
   */
  async stopChain(featureId: string): Promise<StopChainOutcome> {
    const id = featureId.trim();
    if (id === "") {
      return {
        ok: false,
        featureId: id,
        chainStopped: false,
        cancelledTurnId: null,
        cancelDisplay: null,
        error: { code: TURN_REQUEST_INVALID, message: "需求标识缺失：停链按需求定位" },
        display: "停链失败：需求标识缺失",
      };
    }
    if (this.relay === null) {
      return {
        ok: false,
        featureId: id,
        chainStopped: false,
        cancelledTurnId: null,
        cancelDisplay: null,
        error: {
          code: RELAY_NOT_ASSEMBLED,
          message: "自动接力驱动器未装配（宿主面在、但接力未起）⇒ 无内存链可停，不假装已停",
        },
        display: "停链失败：自动接力未装配",
      };
    }
    // 停链原因 = 「谁停的 + 停时那一轮的事实」（REQ-2026-09-30-04 §2.5 人话化）：三档与下面的
    // `display` 同信息量（取消了第 N 轮 + turnId / 有轮但取消能力不可用 / 无在飞轮）。停链成功档
    // 现在 303 回详情页，这一串即链状态行显示的「原因」——原独立结果页承载的信息迁到这里。
    // **纯显示文案**：读占用轮只读，可前移到置标志之前；置标志仍**先于** `cancelTurn`（判定序①
    // 据此短路，不自激）；来源 = `user` ⇒ 人工动作（补充 / 回答）不解冻，见增补二 D2。
    const busy = this.deps.turns.busyTurnOf(id);
    const busyTurnId = busy === null ? null : busy.turnId;
    const busyRound = busy === null ? null : busy.round;
    const stopTarget =
      busyTurnId === null || busyRound === null
        ? ""
        : `第 ${String(busyRound)} 轮（${busyTurnId}）`;
    const stopReason =
      stopTarget === ""
        ? "用户经链状态行「停链」· 该需求无在飞 / 排队轮"
        : this.deps.turns.cancelTurn === undefined
          ? `用户经链状态行「停链」· 有${stopTarget}但取消能力不可用 ⇒ 仅置停链标志`
          : `用户经链状态行「停链」· 同时取消${stopTarget}`;
    this.relay.requestStop(id, stopReason, "user");
    let cancelledTurnId: string | null = null;
    let cancelDisplay: string | null = null;
    if (busy !== null && this.deps.turns.cancelTurn !== undefined) {
      const result = await this.deps.turns.cancelTurn(busy.turnId);
      cancelledTurnId = result.turnId;
      cancelDisplay = result.display;
    }
    let display: string;
    if (cancelledTurnId !== null) {
      const roundLabel = busyRound === null ? "" : `第 ${String(busyRound)} 轮`;
      display = `已停链：已取消该需求${roundLabel}（${cancelledTurnId}）；此后不再自动点火（重启板进程即恢复）`;
    } else if (busyTurnId !== null) {
      display = `已停链：该需求有在飞 / 排队轮（${busyTurnId}）但取消能力不可用 ⇒ 仅置停链标志`;
    } else {
      display = "已停链：该需求无在飞 / 排队轮，此后不再自动点火（重启板进程即恢复）";
    }
    return { ok: true, featureId: id, chainStopped: true, cancelledTurnId, cancelDisplay, error: null, display };
  }

  /**
   * **心跳唤醒点火**（v0.9.5 C8 · T8）：把心跳命中的**结构化事实提示词**经接力驱动器发一轮
   * （同 `contextId` 新一轮由 `openSession` 按需求自动完成，不显式传 round/contextId）。
   *
   * **计数 / 刹车归接力驱动器**：`fireWake` 复用与自动接力**同一套刹车**（停链标志 / 链内计数触顶）与
   * **同一链内连续点火计数** —— 板面**不另造**第二套 guard（R2 规格④）。
   * **撞 occupant 的分诊也在接力驱动器**（D1：唤醒不再一撞即停，按占用者身份跳过 / 退让 / 超限停链）；
   * 板面只透传 `turnId`（分诊的身份键）与 `occupantTurnId`（留痕）。
   * 未起接力 ⇒ `ok:false`（不假装已点火）；提交抛错 ⇒ `ok:false`（保守不记去重位，下拍可重试）。
   */
  wakeTurn(input: { featureId: string; org: string; prompt: string; turnId?: string | null }): WakeFireOutcome {
    const featureId = input.featureId.trim();
    const org = this.resolveOrg(input.org);
    if (featureId === "") return { ok: false, reason: "request_invalid" };
    if (org === "") return { ok: false, reason: "org_not_resolved" };
    if (this.relay === null) return { ok: false, reason: "relay_not_assembled" };
    const result = this.relay.fireWake({
      requirementId: featureId,
      org,
      prompt: input.prompt,
      turnId: input.turnId ?? null,
    });
    if (!result.ok) {
      const failed: WakeFireOutcome = { ok: false, reason: result.reason };
      if (result.occupantTurnId !== undefined) failed.occupantTurnId = result.occupantTurnId;
      return failed;
    }
    const outcome: WakeFireOutcome = { ok: true, reason: result.reason };
    if (result.turnId !== undefined) outcome.turnId = result.turnId;
    if (result.round !== undefined) outcome.round = result.round;
    return outcome;
  }

  /** 配置面（状态页如实显示「组织目录未配置 ⇒ 宿主面不可用」，不得静默）。 */
  configView(): { orgsDir: string | null; defaultOrg: string | null; kind: string } {
    return {
      orgsDir: this.deps.orgsDir,
      defaultOrg: this.deps.defaultOrg,
      kind: this.deps.kind ?? DEFAULT_HOST_AGENT_KIND,
    };
  }

  /**
   * 组织目录根**此刻**的可用性结论（BD14）：`null` ⇒ 未配置（另有其码）或好好一个目录。
   * 启动横幅与 `GET /host` 都读它 —— 目录不存在时**不得**再打「宿主面就绪」。
   */
  orgsDirProblem(): { code: string; message: string } | null {
    if (this.deps.orgsDir === null) return null;
    return diagnoseOrgsDir(this.deps.orgsDir, (this.deps.dirKind ?? statDirKind)(this.deps.orgsDir));
  }

  /** 组织 → BD4a 的起桥配置；workspace 落点见 {@link orgBridgeConfig}（**无兜底路径**）。 */
  bridgeConfigFor(org: string): HostBridgeConfig | { error: { code: string; message: string } } {
    const config = orgBridgeConfig(this.deps, org);
    if ("error" in config) return config;
    // 组织根先查（根坏了 ⇒ 报根，不报某个组织；比 workspace 缺失更接近根因）。
    const problem = this.orgsDirProblem();
    if (problem !== null) return { error: problem };
    return config;
  }

  /**
   * **触发一轮**（BD8 主路径；BD9 加 `kind = "confirm"`）：起桥（复用 BD4a `ensureStarted`，幂等）
   * ⇒ 发轮（`contextId` 的分配 / 复用归 BD4b 台账）⇒ 在飞轮等到终态，排队轮立即回「排队中」。
   *
   * `org` 传桥侧的 `ownerGroup`；为空时**只**回退到板级组织名配置（两者皆无 ⇒ 结构化
   * {@link ORG_NOT_RESOLVED}，**不猜组织**）。不抛异常：一切失败都是 `ok = false` + 结构化错误。
   * `kind = "confirm"` 与缺省走**同一条通道**，只是提示词换成 {@link buildConfirmPrompt}。
   *
   * **v0.9.5 C2**：`supplement` = 板上触发一轮表单随附的**可选**补充文本，仅对 `kind = "trigger"`
   * 生效（拼接见 {@link buildTurnPrompt}）；`confirm` 是固定指令模板、表单无该字段，故忽略。
   */
  async triggerTurn(input: {
    featureId: string;
    org: string | null;
    version?: string | null;
    kind?: "trigger" | "confirm";
    /** v0.9.5 C2：本轮随附补充文本（仅 trigger 通道消费；空 / 缺省 = 纯触发）。 */
    supplement?: string | null;
  }): Promise<TriggerTurnOutcome> {
    const featureId = input.featureId.trim();
    const org = this.resolveOrg(input.org);
    const base = this.newBase(org, featureId);
    if (featureId === "") {
      return { ...base, error: { code: TURN_REQUEST_INVALID, message: "需求标识缺失：轮次按需求分配会话" }, display: "触发失败：需求标识缺失" };
    }
    if (org === "") {
      return {
        ...base,
        error: {
          code: ORG_NOT_RESOLVED,
          message: "归属组织未确定：桥侧 ownerGroup 为空且板级组织名未配置（桥按组织建 ⇒ 不猜组织名）",
        },
        display: "触发失败：归属组织未确定",
      };
    }
    // 收口轨 14 防重前置：已有在飞 / 排队轮 ⇒ 不起桥、不发轮，结构化 409
    // （同 BD9「判据不满足不惊动托管器」的口径；连点竞态由 submitTurn 同步段兜底，见 settleSubmitted）。
    const verb = input.kind === "confirm" ? "确认" : "触发";
    const busy = this.busyTurnOf(featureId);
    if (busy !== null) return this.busyOutcome(base, null, busy, verb);
    const up = await this.startBridge(org, base);
    if (up.early !== null) return up.early;

    const promptInput: { featureId: string; org: string; version?: string | null; supplement?: string } = {
      featureId,
      org,
    };
    if (input.version !== undefined) promptInput.version = input.version;
    // v0.9.5 C2：补充文本只走 trigger 通道（confirm 是固定指令模板，表单无该字段）。
    const supplement = input.kind === "confirm" ? "" : (input.supplement ?? "").trim();
    if (supplement !== "") promptInput.supplement = supplement;
    const text = input.kind === "confirm" ? buildConfirmPrompt(promptInput) : buildTurnPrompt(promptInput);
    // v0.9.5 C1：人工动作（补充 / 确认）⇒ 链内连续自动点火计数清零（接力链从人这里重新起算）。
    this.relay?.noteManualAction(featureId, input.kind === "confirm" ? "confirm" : "supplement");
    const submitted = this.deps.turns.submitTurn({
      org,
      requirementId: featureId,
      text,
      ...(this.deps.turnTimeoutMs !== undefined ? { timeoutMs: this.deps.turnTimeoutMs } : {}),
    });
    return this.settleSubmitted(base, up.bridge, submitted, verb);
  }

  /**
   * **人工确认**（BD9）：把「用户已确认改造文档」作为一轮消息投给宿主 agent，
   * 由 agent 核对后执行放行 —— **板不写状态机**，agent 可能判断条件不满足而不放行。
   * 与 {@link triggerTurn} 同一条触发通道（缺省即委托）。
   */
  confirmTurn(input: {
    featureId: string;
    org: string | null;
    version?: string | null;
  }): Promise<TriggerTurnOutcome> {
    return this.triggerTurn({ ...input, kind: "confirm" });
  }

  /**
   * **澄清回答**（BD9 · 收口轨 16 ②改判据）：仅当该需求**当前待澄清的一轮**
   * （`awaiting_answer` ∧ 未被更新轮取代，判据 = {@link TurnOps.findAwaitingTurn}）才可用
   * ⇒ 否则结构化拒绝（{@link NO_AWAITING_TURN}，409）。**陈旧的 awaiting 残留不算数** ——
   * 用户回答后新轮已开跑 ⇒ 再答只会投进一个不在澄清中的会话。
   * 续推经 `answerTurn`，组织取**该轮记录自己的 `org`**（会话在哪条桥上就回哪条桥，不重猜）；
   * 同 `contextId` 的复用由 BD4b 会话台账保证，本方法不另造。
   */
  async answerRequirement(input: { featureId: string; answer: string }): Promise<TriggerTurnOutcome> {
    const featureId = input.featureId.trim();
    const answer = input.answer.trim();
    const base = this.newBase("", featureId);
    if (featureId === "") {
      return { ...base, error: { code: TURN_REQUEST_INVALID, message: "需求标识缺失：轮次按需求分配会话" }, display: "回答失败：需求标识缺失" };
    }
    if (answer === "") {
      return { ...base, error: { code: TURN_REQUEST_INVALID, message: "回答内容为空：澄清回答不得空提交" }, display: "回答失败：内容为空" };
    }
    const awaiting = this.deps.turns.findAwaitingTurn(featureId);
    if (awaiting === null) {
      const latest = this.deps.turns.latestTurnOf(featureId);
      // 最近记录本身是 awaiting_answer 却未被认作"当前" ⇒ 只剩一种解释：已被更新轮取代（残留脏账）
      const why =
        latest === null
          ? "该需求当前没有待澄清的一轮（最近轮态 = 无记录）⇒ 回答入口不可用"
          : latest.state === "awaiting_answer"
            ? `该需求当前没有待澄清的一轮（最近记录 ${latest.turnId} 的 awaiting_answer 已被更新轮取代，属台账陈旧残留）⇒ 回答入口不可用`
            : `该需求当前没有待澄清的一轮（最近轮态 = ${latest.state}）⇒ 回答入口不可用`;
      return {
        ...base,
        org: latest?.org ?? "",
        disposition: "not_awaiting",
        error: { code: NO_AWAITING_TURN, message: why },
        display: "回答未投递：当前没有待澄清的一轮",
      };
    }
    const org = awaiting.org;
    // 收口轨 14 防重前置：澄清轮之后又被连点（新轮在飞 / 排队）⇒ 不再续推，结构化 409。
    const busy = this.busyTurnOf(featureId);
    if (busy !== null) return this.busyOutcome({ ...base, org }, null, busy, "回答");
    const up = await this.startBridge(org, { ...base, org });
    if (up.early !== null) return up.early;
    // v0.9.5 C1：人工动作（澄清回答）⇒ 链内连续自动点火计数清零。
    this.relay?.noteManualAction(featureId, "answer");
    const submitted = this.deps.turns.answerTurn({
      org,
      requirementId: featureId,
      answer,
      ...(this.deps.turnTimeoutMs !== undefined ? { timeoutMs: this.deps.turnTimeoutMs } : {}),
    });
    return this.settleSubmitted({ ...base, org }, up.bridge, submitted, "回答");
  }

  /**
   * 详情页回答框的判据（收口轨 16 ②）：该需求**当前待澄清的一轮**（awaiting ∧ 未被取代）
   * ⇒ 返回该记录，否则 `null`。陈旧 awaiting 残留不再渲染表单。
   */
  awaitingTurnOf(requirementId: string): TurnRecord | null {
    return this.deps.turns.findAwaitingTurn(requirementId);
  }

  /**
   * 该需求**最近一条板发轮记录**（v0.9.5 C7 · T7 挂起口 `turnId` 归属判据的唯一事实源）：
   * 挂起口要求 `turnId` 必须等于本值（R2 定稿：**不设时间窗**，旧轮一律拒）。
   * 台账 / 内存都以轮管理器为单点 —— 本方法只是透传，不另立第二套轮账。
   */
  latestTurnOf(requirementId: string): TurnRecord | null {
    return this.deps.turns.latestTurnOf(requirementId);
  }

  /**
   * 详情页写按钮的**轮状态判据**（收口轨 14 ②）：该需求已有在飞 / 排队轮 ⇒ 给出占用轮
   * （渲染 disabled + 原因），否则 `null`。与 `submitTurn` 的防重同一事实源（BD4b 轮闸）。
   */
  busyTurnOf(requirementId: string): OccupantTurnView | null {
    return this.deps.turns.busyTurnOf(requirementId);
  }

  // -- 内部：triggerTurn / answerRequirement 的公共段 --------------------------

  private resolveOrg(org: string | null): string {
    const fromBridge = (org ?? "").trim();
    return fromBridge !== "" ? fromBridge : (this.deps.defaultOrg ?? "").trim();
  }

  private newBase(org: string, featureId: string): TriggerTurnOutcome {
    return {
      ok: false,
      org,
      featureId,
      disposition: "config_error",
      queued: false,
      turnId: null,
      contextId: null,
      round: null,
      state: null,
      display: "",
      summary: null,
      question: null,
      receipt: null,
      error: null,
      bridge: null,
    };
  }

  /**
   * 起桥（配置缺失 / 起不来 ⇒ 返回**已收口**的 early 结局，本轮不投）；
   * 成功 ⇒ `bridge` 用于如实回显 pid:port。
   */
  private async startBridge(
    org: string,
    base: TriggerTurnOutcome,
  ): Promise<{ early: TriggerTurnOutcome | null; bridge: TriggerTurnOutcome["bridge"] }> {
    const config = this.bridgeConfigFor(org);
    if ("error" in config) {
      return { early: { ...base, error: config.error, display: `触发失败：${config.error.message}` }, bridge: null };
    }
    // 先查配置与落点、再起桥：起不来要在**本次响应**里就看见根因，而不是排进队后无声消失。
    const started = await this.deps.bridges.ensureStarted(config);
    const bridge = { pid: started.status.pid, port: started.status.port, kind: started.status.kind };
    if (!started.ok) {
      const code = started.status.error?.code ?? "bridge_unavailable";
      const message = started.status.error?.message ?? HOST_BRIDGE_DOWN_MESSAGE;
      // BD14：组织目录缺失是**落点（配置）问题**，不是「桥断了」⇒ 按 config_error 分流，
      // 页面与 HTTP 状态都不再把「目录没建」显示成「宿主桥故障」。
      const disposition: TriggerDisposition = code === ORG_WORKSPACE_MISSING ? "config_error" : "bridge_down";
      return { early: { ...base, disposition, display: started.status.display, error: { code, message }, bridge }, bridge };
    }
    return { early: null, bridge };
  }

  /** 收口轨 14 防重的统一收口形状（`verb` = 触发 / 确认 / 回答，决定文案）。 */
  private busyOutcome(
    base: TriggerTurnOutcome,
    bridge: TriggerTurnOutcome["bridge"],
    busy: OccupantTurnView,
    verb: string,
  ): TriggerTurnOutcome {
    const occupantLabel = `第 ${String(busy.round)} 轮 · ${busy.turnId}`;
    return {
      ...base,
      org: busy.org !== "" ? busy.org : base.org,
      disposition: "busy",
      turnId: busy.turnId,
      contextId: busy.contextId,
      round: busy.round,
      state: busy.state,
      bridge,
      error: {
        code: TURN_BUSY,
        message: `该需求已有${busy.state === "queued" ? "排队" : "在飞"}的一轮（${occupantLabel}）⇒ 本次${verb}不再入队（防连点重复烧一轮）`,
      },
      display: `${verb}未提交：该需求已有${busy.state === "queued" ? "排队" : "在飞"}的一轮（${occupantLabel}）`,
    };
  }

  /** 提交后的统一收口：排队 ⇒ 立刻回「排队中」；在飞 ⇒ 等到终态。 */
  private async settleSubmitted(
    base: TriggerTurnOutcome,
    bridge: TriggerTurnOutcome["bridge"],
    submitted: SubmittedTurn,
    verb = "提交",
  ): Promise<TriggerTurnOutcome> {
    // 连点竞态的最终闸口：前置判据与发轮之间隔着一次起桥 await，两次提交可能都已通过前置；
    // `submitTurn` 的同步段只放行第一条，第二条带 `occupant` 回来 ⇒ 如实 409，不重复入队。
    if (submitted.occupant !== null) {
      return this.busyOutcome(base, bridge, submitted.occupant, verb);
    }
    if (submitted.queued) {
      return {
        ...base,
        ok: true,
        disposition: "queued",
        queued: true,
        turnId: submitted.turnId,
        contextId: submitted.contextId,
        round: submitted.round,
        state: "queued",
        display: `${submitted.display}（第 ${String(submitted.position)} 位）`,
        bridge,
      };
    }
    const result = await submitted.done;
    const disposition = dispositionOfTurn(result.state);
    return {
      ok: disposition !== "turn_failed" && disposition !== "timeout",
      org: base.org,
      featureId: base.featureId,
      disposition,
      queued: false,
      turnId: result.turnId,
      contextId: result.contextId,
      round: submitted.round,
      state: result.state,
      display: result.display,
      summary: result.summary,
      question: result.question,
      receipt: result.receipt,
      error: result.error,
      bridge,
    };
  }

  /** 该组织的闸位与队列（状态页与「排队中」显示的同一事实源）。 */
  queueView(org: string): BridgeQueueView {
    return this.deps.turns.queueView(org);
  }

  /**
   * **状态视图**（`GET /host`）：逐组织**主动探活**（`health`）后取队列与在飞轮 ⇒
   * 「进程在但端口连不上」「进程中途消失」都在这一刻被改判为 `unreachable` / `exited`，
   * 页面拿到的是真实的「宿主桥已断」，**不是缓存里的在线**。
   */
  async statusView(): Promise<HostStatusEntry[]> {
    const entries: HostStatusEntry[] = [];
    for (const snapshot of this.deps.bridges.statuses()) {
      const status = (await this.deps.bridges.health(snapshot.org)) ?? snapshot;
      entries.push({
        status,
        queue: this.deps.turns.queueView(status.org),
        active: this.deps.turns.activeTurns(status.org),
      });
    }
    return entries;
  }

  /**
   * **板托管台账的组织名**（REQ-v0.9.2 N6 · 只读同步口径）：托管器里当前有记录的组织集合。
   * 与 `statusView()` 的区别：本方法**不探活、不改任何状态** —— 组织视角页只要「台账里有哪些名字」，
   * 探活归宿主桥状态页自己的职责。
   */
  managedOrgs(): string[] {
    return this.deps.bridges.statuses().map((s) => s.org);
  }

  /**
   * **该组织名下当前活跃的宿主桥状态清单**（v0.9.4 A3 · BD3 拒删前置闸判据）：
   * 只收 {@link isActiveBridgeState} 为真的条目（`running` / `starting` / `unreachable`）。
   * 返回**非空** ⇒ 组织还有活跃宿主桥，「删除（标记停用）」必须 409 拒绝并引导「先逐桥 stop 再删」；
   * 本方法**不探活、不改状态、不停桥**（连带停桥明确不做，停桥是 `POST /host/{org}/stop` 的独立职责）。
   */
  activeBridgesFor(org: string): HostBridgeStatus[] {
    const name = org.trim();
    if (name === "") return [];
    return this.deps.bridges
      .statuses()
      .filter((s) => s.org === name && isActiveBridgeState(s.state));
  }

  /**
   * **停桥**（人工回收一个组织的桥；写面守卫在 HTTP 层，与触发一轮同规格）。
   * 组织未托管 ⇒ `host_not_managed`（不静默返回 200「已停」。BD4a 的 `stop` 对未知组织返回 null）。
   */
  async stopBridge(org: string, reason = "manual"): Promise<StopBridgeOutcome> {
    const name = org.trim();
    if (name === "") {
      return {
        ok: false,
        org: name,
        status: null,
        error: { code: ORG_NOT_RESOLVED, message: "组织名缺失：停桥按组织定位" },
        display: "停桥失败：组织名缺失",
      };
    }
    const managed = this.deps.bridges.statuses().some((s) => s.org === name);
    if (!managed) {
      return {
        ok: false,
        org: name,
        status: null,
        error: { code: "host_not_managed", message: `本板进程未托管组织 ${name} 的宿主桥（无记录可停）` },
        display: `未停桥：组织 ${name} 当前无宿主桥记录`,
      };
    }
    const status = await this.deps.bridges.stop(name, reason);
    if (status === null) {
      return {
        ok: false,
        org: name,
        status: null,
        error: { code: "host_stop_failed", message: `停桥未返回状态：组织 ${name}` },
        display: `停桥失败：组织 ${name} 未返回状态`,
      };
    }
    const stopped = status.state === "exited";
    return {
      ok: stopped,
      org: name,
      status,
      error: stopped ? null : (status.error ?? { code: "host_stop_incomplete", message: status.display }),
      display: stopped ? `${name} 宿主桥已收（${reason}）` : status.display,
    };
  }
}

/** 装配入口（`index.ts` 起服务时调用；测试直接 `new BoardHostFace` 注入假出口）。 */
export function createHostFace(deps: HostFaceDeps): BoardHostFace {
  return new BoardHostFace(deps);
}
