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
  type OccupantTurnView,
  type SubmittedTurn,
  type SubmitTurnInput,
  type TurnResult,
} from "./host-turn.js";
import { type TurnRecord, type TurnState } from "./host-turn-ledger.js";

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
 * 首轮提示词（纯函数）。**不出现任何 MCP 工具全名**（§3.6：claude / qoder / opencode / codex 各家不同），
 * 也不指示 agent 去「点确认」—— 门与推进的表述停在「需要人决策 ⇒ input-required」。
 */
export function buildTurnPrompt(input: { featureId: string; org: string; version?: string | null }): string {
  const versionLine = input.version !== undefined && input.version !== null && input.version !== ""
    ? ` · 版本 ${input.version}`
    : "";
  return [
    `${TURN_PROMPT_TITLE} 需求 ${input.featureId}${versionLine} · 组织 ${input.org}`,
    "",
    "你是这条需求的**推进者**（需求实体已由板以本组织身份创建，初态停在审批门前）。",
    "以当前工作目录为本组织目录，按 AGENTS.md 的需求流程规范推进该需求**当前该做的一步**：",
    "1. 先用编排桥的只读能力查清这条需求现在的引擎态与登记阶段，不要凭猜测动手；",
    "2. 按所处阶段产出该阶段的文档（需求确认单 / 改造文档等），写入本组织目录的 doc/{版本}/；",
    "3. 需要人决策就用 A2A 的 input-required 结束本轮，不要自问自答；",
    "4. 状态机推进（审批 / 推进 / 取消）只能经编排桥的能力做，板不代劳。",
  ].join("\n");
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
  queueView(org: string): BridgeQueueView;
  activeTurns(org?: string): TurnResult[];
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
  /** 注入给后端的 MCP 端点推导（缺省由 BD4a 的 `defaultMcpUrlForOrg` 口径给出）。 */
  mcpUrlFor?: (org: string) => string;
  /**
   * 目录三态探针（BD14 · 缺省 = 真查盘）：只用于**组织目录根**这一处，
   * 目的是让「配了但不存在」在**触发前**就是结构化错误，而不是等 spawn 撞出一个负 errno。
   */
  dirKind?: DirKindProbeFn;
}

// ---------------------------------------------------------------------------
// 宿主面
// ---------------------------------------------------------------------------

/**
 * 组织 → 起桥配置（**纯函数**）。抽出来的理由：`index.ts` 还要把同一份口径交给
 * `createHostBridgeGateway`（对话轮侧的起桥口）—— 两侧必须算出**同一个** workspace，
 * 否则「触发时的组织目录」与「轮内重拉桥时的目录」会分家。
 * workspace 落点在此决定，**无兜底路径**（§3.8 裁定 9）。
 */
export function orgBridgeConfig(
  deps: Pick<HostFaceDeps, "orgsDir" | "kind" | "idleStopMs" | "mcpUrlFor">,
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
  const config: HostBridgeConfig = {
    org,
    workspace: ws.workspace,
    kind: deps.kind ?? DEFAULT_HOST_AGENT_KIND,
    idleStopMs: deps.idleStopMs ?? DEFAULT_IDLE_STOP_MS,
  };
  if (deps.mcpUrlFor !== undefined) config.mcpUrl = deps.mcpUrlFor(org);
  return config;
}

/**
 * 板侧**唯一**的宿主面出口（HTTP 层只认这个类的接口）。
 * 与 BD7 写面同规格：一切失败都是结构化错误，页面据此显示，不缓存、不假数据。
 */
export class BoardHostFace {
  private readonly deps: HostFaceDeps;

  constructor(deps: HostFaceDeps) {
    this.deps = deps;
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
   */
  async triggerTurn(input: {
    featureId: string;
    org: string | null;
    version?: string | null;
    kind?: "trigger" | "confirm";
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

    const promptInput = { featureId, org, ...(input.version !== undefined ? { version: input.version } : {}) };
    const text = input.kind === "confirm" ? buildConfirmPrompt(promptInput) : buildTurnPrompt(promptInput);
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
