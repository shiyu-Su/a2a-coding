/**
 * 板的**宿主轮**（v0.9.0 · BD4b）—— 与板自己 spawn 的宿主桥（`machine/acp-bridge`）做
 * **一轮 A2A 对话**：`message/send` → 轮询 `tasks/get` 到终态 → 结果回写板侧台账，外加 `tasks/cancel`。
 *
 * 事实源：改造文档 §2.2-6（进程拓扑）· §3.4 R4（并发口径改判）· §3.7（M2b 实测）
 *
 * ## 三条硬口径
 * 1. **单飞闸挂在「桥」这一层，不是「每需求一个」**（§3.4 R4）：桥内**零并发闸**，
 *    「一个后端进程同时吃两条 `session/prompt`」**从未验证**，且同 `contextId` 并发会互相覆盖
 *    捕获窗并丢文本 ⇒ **同一组织一时刻只允许 1 个在飞 prompt**；第二个需求要发轮 ⇒ **板侧排队**
 *    （状态 `queued`，界面据此显示「排队中」）。**"并行"只能靠多组织** ⇒ 板不承诺「多需求并行」。
 * 2. **`contextId` = 每需求一个、终身复用**（§2.2-6）：新需求 ⇒ 板分配新 `contextId`；
 *    同一需求的后续轮（澄清续推 / 重派）复用同一条会话记录；跨需求绝不共享。分配落板侧台账
 *    （`host-turn-ledger.ts`），**不落 Feature Context**。
 * 3. **`input-required` 不是失败**：桥**保留了** outcome 约定注入 ⇒ `input-required` 正是板要的
 *    「待澄清」信号（与引擎 `needs_input` 对上）⇒ 落 `awaiting_answer`（**非终态、不占闸位**），
 *    可续发同 `contextId` 的一轮。
 *
 * ## 本节点的边界
 * - **不做进程管理**：起 / 停 / 探活 / 空闲回收复用 BD4a 的出口，经 {@link BridgeGateway} 接线
 *   （缺省实现 {@link createHostBridgeGateway}）；在飞轮数喂回 `beginRound/endRound`
 *   ⇒ BD4a 的「有在飞 ⇒ 不回收」判据自动成立；
 * - **不写引擎状态机迁移**：不调 `approve` / `cancel`，也不把主链 `advance` 到非当前态、不经 MCP 写 `features`；
 *   （`version` 排期写是 advance「`to` = 当前态」的登记字段特例，唯一落点在 `feature-schedule.ts`，不在本模块）
 *   终态 + 摘要只落**板侧台账**；
 * - **不走 Launcher**：端点 = 板自己 spawn 的桥端口 `http://127.0.0.1:<port>/a2a/jsonrpc`；
 * - **等待有界**：轮询受 `turnTimeoutMs` 约束；到点先发 `tasks/cancel`（防后端那一轮继续烧），
 *   再落 `timeout` 并交闸（闸位不留给已死的轮）；
 * - **不常驻**：本类不起任何定时器，`delay` 只在 await 中使用 ⇒ 无悬挂句柄。
 *
 * ## RPC 形状（事实源 = `machine/acp-bridge/a2a-server.ts` + `task-registry.ts`，只读参考）
 * - 唯一路径 **POST `/a2a/jsonrpc`**（非 POST 405、**无 `/health`**）；
 * - `message/send` 的 `message.messageId` **必填非空**（缺 ⇒ `-32602`），parts 只认 `{kind:"text",text}`；
 *   `configuration.blocking` 置 false ⇒ 立即回 `working` 句柄，板靠轮询取终态；
 * - 任务态闭集 = `working` + 终态 `completed / canceled / failed / rejected / input-required / auth-required`；
 *   ⚠ **桥不产出 `blocked`**（节点文案里的 `blocked` 在桥侧对应 `canceled` / `rejected`）⇒
 *   板的终态判定按桥的闭集走（{@link isTerminalTaskState}），不自造态；
 * - **`completed` / `canceled` 的全文只在 `artifacts[name="response"]`**（`status.message` 刻意不带，
 *   防上游把两者拼成双份）；`input-required` / `failed` 的短文在 `status.message`。
 */
import { randomUUID } from "node:crypto";
import {
  isTerminalTurnState,
  HostTurnLedgerStore,
  type RequirementSessionRecord,
  type TurnRecord,
  type TurnState,
} from "./host-turn-ledger.js";
import {
  HOST_BRIDGE_DOWN_MESSAGE,
  type HostBridgeConfig,
  type HostBridgeManager,
} from "./host-bridge.js";

// ---------------------------------------------------------------------------
// 口径常量
// ---------------------------------------------------------------------------

/** 桥 A2A 面唯一路径（与 `a2a-server.ts` 的 `A2A_JSONRPC_PATH` 同值）。 */
export const A2A_JSONRPC_PATH = "/a2a/jsonrpc";

/** 一轮对话的**有界**等待上限（缺省 10 min）—— 到点落 `timeout`，绝不无限等。 */
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

/** `tasks/get` 轮询间隔（缺省 2s）。 */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** 单次 RPC 的传输超时。 */
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/** 落台账摘要的截断长度（界面只给一眼能读完的摘要）。 */
export const TURN_SUMMARY_MAX = 400;

/** 板分配的 `contextId` 前缀（一眼可辨「板侧会话」，与编排侧 contextId 区分）。 */
export const BOARD_CONTEXT_ID_PREFIX = "board-";

/** 排队中的显示文案（**不承诺并行**：同一桥一时刻只跑一轮）。 */
export const QUEUED_DISPLAY = "排队中（同一桥一时刻只跑一轮）";

/** 待澄清的显示文案（`input-required` ⇒ 要人回答，**不是失败**）。 */
export const AWAITING_ANSWER_DISPLAY = "需要你回答";

/** 桥被重拉后同 `contextId` 续的可见文案（§2.2-7「会话可能回退为新建，须让用户看见」）。 */
export const BRIDGE_RESTART_NOTE =
  "宿主桥在本轮前被重拉过 ⇒ 仍以同一 contextId 续接，但 CLI 会话可能已回退为新建";

/** A2A 终态闭集（`working` 之外的全部）。 */
export const A2A_TERMINAL_TASK_STATES: readonly string[] = [
  "completed",
  "canceled",
  "failed",
  "rejected",
  "input-required",
  "auth-required",
];

/** 归一后的轮结局四分（界面分流用；`awaiting_answer` 与 `failed` **绝不混**）。 */
export type TurnOutcomeKind = "succeeded" | "awaiting_answer" | "canceled" | "failed";

// ---------------------------------------------------------------------------
// 纯函数（状态归一 / 摘要 / id）
// ---------------------------------------------------------------------------

/** A2A 任务态 → 轮结局。未知态按 `failed` 处理（**未知不吞成成功**）。 */
export function classifyTaskState(state: string): TurnOutcomeKind {
  switch (state) {
    case "completed":
      return "succeeded";
    case "input-required":
      return "awaiting_answer";
    case "canceled":
      return "canceled";
    default:
      return "failed";
  }
}

/** 轮结局 → 板侧轮状态。 */
export function turnStateOfKind(kind: TurnOutcomeKind): TurnState {
  switch (kind) {
    case "succeeded":
      return "succeeded";
    case "awaiting_answer":
      return "awaiting_answer";
    case "canceled":
      return "canceled";
    case "failed":
      return "failed";
  }
}

/** 轮结局 → 收口后的 `TurnResult.kind`（`timeout` 归 `failed`；未收口 ⇒ null）。 */
export function kindOfTurnState(state: TurnState): TurnOutcomeKind | null {
  switch (state) {
    case "succeeded":
      return "succeeded";
    case "awaiting_answer":
      return "awaiting_answer";
    case "canceled":
      return "canceled";
    case "failed":
    case "timeout":
      return "failed";
    case "queued":
    case "running":
      return null;
  }
}

/**
 * 终态判定按**桥自己的口径**（`machine/acp-bridge/types.ts`：`TerminalTaskState = Exclude<TaskState,"working">`）
 * ⇒ **非 `working` 即终态**。白名单 {@link A2A_TERMINAL_TASK_STATES} 只是文档化的桥侧闭集；
 * 白名单外的态（节点文案里的 `blocked`、未来新增态）同样收口并按 `failed` 处理 ——
 * **绝不因「不认识」而无限等**（比误判失败更糟的是永不收口）。
 */
export function isTerminalTaskState(state: string): boolean {
  return state !== "working";
}

/** 摘要化（折叠空白 + 截断；空 ⇒ null，不写空串占位）。 */
export function summarizeTurnText(text: string | null, max: number = TURN_SUMMARY_MAX): string | null {
  if (text === null) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** 板分配的 `contextId`。 */
export function newBoardContextId(idFactory: () => string = randomUUID): string {
  return `${BOARD_CONTEXT_ID_PREFIX}${idFactory()}`;
}

// ---------------------------------------------------------------------------
// JSON-RPC 报文：纯构造 / 纯解析（单测目标，不依赖桥在跑）
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** 板侧宿主轮的结构化错误（`rpcCode` 仅 JSON-RPC 错误时有值）。 */
export class HostTurnError extends Error {
  readonly code: string;
  readonly rpcCode: number | null;
  constructor(code: string, message: string, rpcCode: number | null = null) {
    super(message);
    this.name = "HostTurnError";
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

/** `message/send` 请求体（形状与桥的 `parseMessageSendParams` 对齐）。 */
export interface MessageSendRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: "message/send";
  params: {
    message: {
      role: "user";
      parts: { kind: "text"; text: string }[];
      messageId: string;
      contextId: string;
    };
    configuration: { blocking: false };
  };
}

/**
 * 造 `message/send`：**非 blocking**（桥的执行在后台，板轮询取终态）+
 * `contextId` 复用会话 + `messageId` 必填非空（桥的硬校验）。
 */
export function buildMessageSendRequest(
  input: { contextId: string; text: string; messageId: string },
  rpcId: number | string = 1,
): MessageSendRequest {
  if (input.contextId.trim() === "") throw new HostTurnError("context_id_missing", "发轮缺失 contextId");
  if (input.text.trim() === "") throw new HostTurnError("prompt_empty", "本轮文本为空");
  if (input.messageId.trim() === "") throw new HostTurnError("message_id_missing", "本轮缺失 messageId");
  return {
    jsonrpc: "2.0",
    id: rpcId,
    method: "message/send",
    params: {
      message: {
        role: "user",
        parts: [{ kind: "text", text: input.text }],
        messageId: input.messageId,
        contextId: input.contextId,
      },
      configuration: { blocking: false },
    },
  };
}

function buildTaskIdRequest(method: "tasks/get" | "tasks/cancel", taskId: string, rpcId: number | string): unknown {
  if (taskId.trim() === "") throw new HostTurnError("task_id_missing", `${method} 缺失任务 id`);
  return { jsonrpc: "2.0", id: rpcId, method, params: { id: taskId } };
}

/** 造 `tasks/get`。 */
export function buildTasksGetRequest(taskId: string, rpcId: number | string = 1): unknown {
  return buildTaskIdRequest("tasks/get", taskId, rpcId);
}

/** 造 `tasks/cancel`（对应人点「停止这一轮」）。 */
export function buildTasksCancelRequest(taskId: string, rpcId: number | string = 1): unknown {
  return buildTaskIdRequest("tasks/cancel", taskId, rpcId);
}

/** 归一后的任务视图。 */
export interface NormalizedTask {
  taskId: string;
  state: string;
  kind: TurnOutcomeKind;
  terminal: boolean;
  /** 结果全文：优先 artifact（`completed` / `canceled` 只在这里），回落 `status.message`。 */
  text: string | null;
  /** `input-required` 的问题原文。 */
  question: string | null;
  /** `failed` / `rejected` / `auth-required` 的原因原文。 */
  reason: string | null;
}

function partsText(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const chunks: string[] = [];
  for (const item of parts) {
    if (!isRecord(item)) continue;
    if (item.kind === "text" && typeof item.text === "string" && item.text.length > 0) chunks.push(item.text);
  }
  return chunks.length === 0 ? null : chunks.join("\n");
}

/** artifact 文本：优先 `name === "response"`（桥的约定名），否则取首个非空 artifact。 */
function artifactText(result: Record<string, unknown>): string | null {
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  let first: string | null = null;
  for (const artifact of artifacts) {
    if (!isRecord(artifact)) continue;
    const t = partsText(artifact.parts);
    if (t === null) continue;
    if (artifact.name === "response") return t;
    if (first === null) first = t;
  }
  return first;
}

function normalizeTask(result: unknown): NormalizedTask | null {
  if (!isRecord(result)) return null;
  const taskId = str(result.id);
  if (taskId === null) return null;
  const status = isRecord(result.status) ? result.status : {};
  const state = str(status.state) ?? "working";
  const messageText = partsText(isRecord(status.message) ? status.message.parts : undefined);
  const full = artifactText(result) ?? messageText;
  return {
    taskId,
    state,
    kind: classifyTaskState(state),
    terminal: isTerminalTaskState(state),
    text: full,
    question: state === "input-required" ? (messageText ?? full) : null,
    reason: state === "failed" || state === "rejected" || state === "auth-required" ? (messageText ?? full) : null,
  };
}

/** JSON-RPC 错误码 → 板侧错误码（-32001 = 桥的 TASK_NOT_FOUND）。 */
function rpcErrorCode(code: number | null): string {
  switch (code) {
    case -32001:
      return "task_not_found";
    case -32602:
      return "invalid_params";
    case -32601:
      return "method_not_found";
    default:
      return "rpc_error";
  }
}

/**
 * 解析 JSON-RPC 响应为归一任务（纯函数）。错误信封与缺字段一律抛 {@link HostTurnError}
 * —— **不吞、不猜成功**。
 */
export function parseTaskResponse(json: unknown): NormalizedTask {
  if (!isRecord(json)) throw new HostTurnError("response_invalid", "桥响应不是 JSON 对象");
  const err = isRecord(json.error) ? json.error : null;
  if (err !== null) {
    const code = typeof err.code === "number" ? err.code : null;
    throw new HostTurnError(rpcErrorCode(code), str(err.message) ?? "桥返回 JSON-RPC 错误", code);
  }
  const task = normalizeTask(json.result);
  if (task === null) throw new HostTurnError("response_invalid", "桥响应缺 result.id");
  return task;
}

// ---------------------------------------------------------------------------
// 传输层（可注入；本节点不真起桥 ⇒ 单测注入假 RPC）
// ---------------------------------------------------------------------------

/** 一次 JSON-RPC 调用：入参请求体，出参**已解析的**响应信封（异常抛 {@link HostTurnError}）。 */
export type RpcCall = (body: unknown) => Promise<unknown>;

/** 板 spawn 的桥的 A2A 端点（**loopback**，不是编排桥、不是 Launcher）。 */
export function bridgeRpcEndpoint(port: number, host: string = "127.0.0.1"): string {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new HostTurnError("bridge_port_invalid", `桥端口非法：${String(port)}`);
  }
  return `http://${host}:${String(port)}${A2A_JSONRPC_PATH}`;
}

export interface HttpRpcOptions {
  /** 完整端点（{@link bridgeRpcEndpoint} 的产物）。 */
  endpoint: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 缺省传输实现：裸 POST + JSON.parse（零运行时依赖，与 `requirement.ts` 同一选型理由）。 */
export function createHttpRpc(options: HttpRpcOptions): RpcCall {
  return async (body: unknown): Promise<unknown> => {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new HostTurnError("no_fetch", "运行环境无 fetch 实现");
    let res: Response;
    try {
      res = await fetchImpl(options.endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS),
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new HostTurnError("transport_error", err instanceof Error ? err.message : String(err));
    }
    const raw = await res.text();
    if (!res.ok) throw new HostTurnError(`http_${String(res.status)}`, `桥返回 HTTP ${String(res.status)}：${raw.slice(0, 200)}`);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new HostTurnError("response_invalid", `桥响应不是合法 JSON：${raw.slice(0, 200)}`);
    }
  };
}

// ---------------------------------------------------------------------------
// 进程侧接线（复用 BD4a 出口，不另起一套）
// ---------------------------------------------------------------------------

/** BD4a 出口在对话轮里用到的最小面（起桥 + 在飞计数；回收 / 台账一概不碰）。 */
export interface BridgeGateway {
  /**
   * 确保该组织的桥在线并给出端口。`reused = false` ⇒ 本轮**新起了一个桥进程**
   * （崩溃后重拉 / 空闲回收后重拉）⇒ 第 2 轮起须给用户「会话可能已回退」的可见提示（§2.2-7）。
   */
  ensureBridge(org: string): Promise<{ ok: boolean; port: number | null; reused: boolean; error: string | null }>;
  /** 本轮开始 ⇒ BD4a 的「有在飞 ⇒ 不回收」判据生效。 */
  beginRound(org: string): void;
  /** 本轮结束（含失败 / 超时 / 取消）。 */
  endRound(org: string): void;
}

/** 缺省接线：把 {@link HostBridgeManager}（BD4a）包成 {@link BridgeGateway}。 */
export function createHostBridgeGateway(
  bridges: HostBridgeManager,
  configFor: (org: string) => HostBridgeConfig,
): BridgeGateway {
  return {
    async ensureBridge(org: string) {
      const result = await bridges.ensureStarted(configFor(org));
      if (!result.ok) {
        const code = result.status.error?.code ?? "bridge_start_failed";
        const message = result.status.error?.message ?? HOST_BRIDGE_DOWN_MESSAGE;
        return { ok: false, port: null, reused: false, error: `${code}: ${message}` };
      }
      return { ok: true, port: result.status.port, reused: result.reused, error: null };
    },
    beginRound: (org: string) => bridges.beginRound(org),
    endRound: (org: string) => bridges.endRound(org),
  };
}

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

export interface SubmitTurnInput {
  /** 组织名 = 桥 = 单飞闸的层。 */
  org: string;
  /** 需求标识（板侧 keyed；同 id 的后续轮复用 `contextId`）。 */
  requirementId: string;
  /** 本轮 prompt 全文。 */
  text: string;
  /** 覆盖本轮的有界等待上限。 */
  timeoutMs?: number;
}

/** 一轮的最终结果（`done` 的解决值；**不 reject** —— 失败也是结果）。 */
export interface TurnResult {
  turnId: string;
  requirementId: string;
  org: string;
  contextId: string;
  taskId: string | null;
  /** `succeeded` / `awaiting_answer` / `canceled` / `failed` / `timeout`。 */
  state: TurnState;
  kind: TurnOutcomeKind | null;
  /** 结果全文（剥 outcome 块后；`awaiting_answer` 时为问题原文）。 */
  text: string | null;
  summary: string | null;
  question: string | null;
  error: { code: string; message: string } | null;
  /** 桥重拉提示（§2.2-7）；无 ⇒ null。 */
  bridgeNote: string | null;
  /** 面向人的显示文案（界面直接用）。 */
  display: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * 占用该需求的轮（收口轨 14 服务端防重的载荷）：`state` 闭集 = 在飞 `running` / 排队 `queued`
 * （`awaiting_answer` **不占** —— 等人回答不占闸位，澄清续推照常）。
 * 时间取该轮记录的原值（`startedAt` 未开跑 ⇒ null）。
 */
export interface OccupantTurnView {
  turnId: string;
  requirementId: string;
  org: string;
  contextId: string;
  round: number;
  /** 占用轮的板侧会话（被拒提交回显用）。 */
  state: "running" | "queued";
  queuedAt: string;
  startedAt: string | null;
}

/** 提交结果：`done` 是这一轮的最终结果；同步字段用于立刻回显「排队中」。 */
export interface SubmittedTurn {
  turnId: string;
  requirementId: string;
  contextId: string;
  round: number;
  /** 是否落在闸后（同桥已有在飞轮 ⇒ true）。 */
  queued: boolean;
  /** 位次（1 = 立刻开跑）。 */
  position: number;
  display: string;
  /**
   * **收口轨 14 服务端防重**：该需求已有在飞 / 排队轮 ⇒ 本轮**不入队、不发 RPC**，
   * `turnId` = 被拒提交自己的 id（可留痕），`occupant` = 占用轮视图；
   * 正常提交 ⇒ `occupant = null`。防重判的落点必须在
   * {@link HostTurnManager.submitTurn} 的**同步段**内（检查 + 入队一体），
   * 两次连点才不可能都通过。
   */
  occupant: OccupantTurnView | null;
  done: Promise<TurnResult>;
}

/** 闸位与队列的可见面（界面显示「排队中」用）。 */
export interface BridgeQueueView {
  org: string;
  running: { turnId: string; requirementId: string; taskId: string | null; startedAt: string } | null;
  waiting: { turnId: string; requirementId: string; queuedAt: string; display: string }[];
  /** 恒 1（§3.4：上限挂在桥上，不是"每需求一个"）。 */
  capacity: 1;
}

export interface CancelTurnResult {
  ok: boolean;
  turnId: string;
  state: TurnState | null;
  error: { code: string; message: string } | null;
  display: string;
}

export interface HostTurnDeps {
  /** 进程侧接线（**必填** —— 本节点不自行 spawn）。 */
  gateway: BridgeGateway;
  /** 按端口造 RPC 客户端；缺省 {@link createHttpRpc}。单测据此**不起真桥**断言报文与闸语义。 */
  rpcFor?: (port: number) => RpcCall;
  /** 板侧轮台账；显式传 `null` ⇒ 纯内存（测试用）。 */
  ledger?: HostTurnLedgerStore | null;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  idFactory?: () => string;
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// 内部记录
// ---------------------------------------------------------------------------

interface TurnJob {
  turnId: string;
  org: string;
  requirementId: string;
  contextId: string;
  round: number;
  text: string;
  timeoutMs: number;
  taskId: string | null;
  state: TurnState;
  /** 本轮已分配到的 RPC 客户端（取消时复用，不二次探桥端口）。 */
  rpc: RpcCall | null;
  queuedAt: number;
  startedAt: number | null;
  bridgeNote: string | null;
  /** 人的「停止这一轮」意图：轮询侧据此收口。 */
  cancelRequested: boolean;
  /** 收口标记：`finish` 幂等的依据（**一条轮只有一个终态**）。 */
  settled: boolean;
  /** 本轮是否由 {@link HostTurnManager.runJob} 持有（决定收口结果由谁交付）。 */
  inRunJob: boolean;
  /** 已收口但尚未交给调用方的结果（`runJob` 在**交闸 + 落计数之后**才解决 `done`）。 */
  outcome: TurnResult | null;
  record: TurnRecord;
  settle: (result: TurnResult) => void;
  done: Promise<TurnResult>;
}

interface BridgeChannel {
  org: string;
  running: TurnJob | null;
  queue: TurnJob[];
}

interface SessionEntry {
  org: string;
  contextId: string;
  round: number;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise<void>((res) => {
    setTimeout(res, ms).unref();
  });
}

function errorOf(err: unknown, fallbackCode: string): { code: string; message: string } {
  if (err instanceof HostTurnError) return { code: err.code, message: err.message };
  return { code: fallbackCode, message: err instanceof Error ? err.message : String(err) };
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 占用轮 → 防重载荷（`startedAt` 未开跑 ⇒ null；时间取记录原值，同一把尺）。 */
function occupantView(job: TurnJob): OccupantTurnView {
  const state: "running" | "queued" = job.state === "queued" ? "queued" : "running";
  return {
    turnId: job.turnId,
    requirementId: job.requirementId,
    org: job.org,
    contextId: job.contextId,
    round: job.round,
    state,
    queuedAt: job.record.queuedAt,
    startedAt: job.record.startedAt,
  };
}

// ---------------------------------------------------------------------------
// 轮次管理器
// ---------------------------------------------------------------------------

/**
 * 一个板进程内 0..N 条桥的**对话轮闸**：每组织一条 {@link BridgeChannel}
 * （闸位 1 + FIFO 队列），跨组织互不相干 ⇒ 「并行只能靠多组织」的机制落点。
 */
export class HostTurnManager {
  private readonly gateway: BridgeGateway;
  private readonly rpcFor: (port: number) => RpcCall;
  private readonly ledger: HostTurnLedgerStore | null;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly idFactory: () => string;
  private readonly turnTimeoutMs: number;
  private readonly pollIntervalMs: number;

  private readonly channels = new Map<string, BridgeChannel>();
  private readonly jobs = new Map<string, TurnJob>();
  /** `ledger = null` 时的会话表（需求 → contextId）；有台账则以台账为事实源。 */
  private readonly sessions = new Map<string, SessionEntry>();
  /** 台账写失败后的降级标记（此后会话表与内存记录为事实源；降级必须经轮记录 error 出可见面）。 */
  private ledgerDegraded = false;

  constructor(deps: HostTurnDeps) {
    this.gateway = deps.gateway;
    this.rpcFor = deps.rpcFor ?? ((port: number) => createHttpRpc({ endpoint: bridgeRpcEndpoint(port) }));
    this.ledger = deps.ledger === null ? null : (deps.ledger ?? new HostTurnLedgerStore());
    this.now = deps.now ?? Date.now;
    this.delay = deps.delay ?? defaultDelay;
    this.idFactory = deps.idFactory ?? randomUUID;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  // -- 发一轮 ---------------------------------------------------------------

  /**
   * **发一轮**（首问 / 澄清续推 / 重派走同一条路径）：按 `requirementId` 取或**首次分配**
   * `contextId` ⇒ 新需求必然是新会话、同需求必然是同会话；随后进入**该桥的闸**
   * （闸空 ⇒ 立刻跑，被占 ⇒ `queued` 排队）。
   *
   * **同需求防重（收口轨 14）**：该需求已有 `running` / `queued` 轮 ⇒ 本轮**不建 job、不入队、
   * 不发 RPC**，返回 `occupant` = 占用轮（跨需求的排队语义不变）。
   *
   * `done` **不 reject**（失败也落成结果）。调用方不 await 时至少留 `turnId` 可取消 ——
   * 本类不起任何定时器，不留常驻句柄。
   */
  submitTurn(input: SubmitTurnInput): SubmittedTurn {
    const org = input.org.trim();
    if (org === "") throw new HostTurnError("org_missing", "组织名缺失：轮次按桥排队");
    const requirementId = input.requirementId.trim();
    if (requirementId === "") throw new HostTurnError("requirement_missing", "需求标识缺失：contextId 按需求分配");
    if (input.text.trim() === "") throw new HostTurnError("prompt_empty", "本轮文本为空");

    const at = this.now();
    const channel = this.channel(org);
    // **防重（收口轨 14）**：同需求已有在飞 / 排队轮 ⇒ 本轮不建 job、不入队、不发 RPC。
    // 检查与下面的入队同处一个同步段 ⇒ 两次连点（哪怕同一 tick 到达）至多一个成功。
    const occupant = this.activeJobOfRequirement(requirementId);
    if (occupant !== null) {
      const view = occupantView(occupant);
      return {
        turnId: `turn-${this.idFactory()}`,
        requirementId,
        contextId: view.contextId,
        round: view.round,
        queued: false,
        position: 0,
        display: `本轮未提交：该需求已有${view.state === "queued" ? "排队" : "在飞"}的一轮（第 ${String(view.round)} 轮 · ${view.turnId}）`,
        occupant: view,
        done: Promise.resolve(this.resultOf(occupant)),
      };
    }
    const { contextId, round } = this.openSession(requirementId, org);
    const turnId = `turn-${this.idFactory()}`;
    const job = this.createJob({
      turnId,
      org,
      requirementId,
      contextId,
      round,
      text: input.text,
      at,
      timeoutMs: input.timeoutMs ?? this.turnTimeoutMs,
    });
    const queued = channel.running !== null;
    if (channel.running === null) channel.running = job;
    else channel.queue.push(job);
    this.jobs.set(turnId, job);
    this.writeTurn(job);
    if (!queued) void this.runJob(job);

    return {
      turnId,
      requirementId,
      contextId,
      round,
      queued,
      position: queued ? channel.queue.length : 1,
      display: queued ? QUEUED_DISPLAY : `进行中（第 ${String(round)} 轮）`,
      occupant: null,
      done: job.done,
    };
  }

  /** **回答待澄清的一轮**：与上一轮同 `contextId`（复用 `submitTurn` 的会话分配）。 */
  answerTurn(input: { org: string; requirementId: string; answer: string; timeoutMs?: number }): SubmittedTurn {
    if (input.answer.trim() === "") throw new HostTurnError("answer_empty", "回答内容为空");
    return this.submitTurn({
      org: input.org,
      requirementId: input.requirementId,
      text: input.answer,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
  }

  // -- 停一轮 ---------------------------------------------------------------

  /**
   * **停止这一轮**：
   * - 排队中 ⇒ 出队落 `canceled`，**不发 RPC**（桥侧还没有这条任务）；
   * - 在飞 ⇒ `tasks/cancel`，收口 `canceled`；桥侧回执异常 ⇒ 如实带 `error` 但仍停本地轮；
   *   发Cancel 期间轮次被轮询收口 ⇒ **如实回报既有态**，不谎称已取消；
   * - 已收口 ⇒ 幂等返回既有态，不改写。
   */
  async cancelTurn(turnId: string): Promise<CancelTurnResult> {
    const job = this.jobs.get(turnId);
    if (job === undefined) {
      const error = { code: "turn_not_found", message: `未知轮次 ${turnId}` };
      return { ok: false, turnId, state: null, error, display: error.message };
    }
    const channel = this.channel(job.org);
    if (channel.running !== job) {
      const waiting = channel.queue.indexOf(job);
      if (waiting >= 0) channel.queue.splice(waiting, 1);
      if (job.state === "queued") {
        this.finish(job, { kind: "canceled", text: null, question: null, error: null });
        return { ok: true, turnId, state: "canceled", error: null, display: "已取消（未开跑，已从队列移除）" };
      }
    }
    if (job.settled) {
      return { ok: true, turnId, state: job.state, error: null, display: `这一轮已是终态（${job.state}）` };
    }
    job.cancelRequested = true;
    let rpcError: { code: string; message: string } | null = null;
    if (job.rpc !== null && job.taskId !== null) {
      try {
        parseTaskResponse(await job.rpc(buildTasksCancelRequest(job.taskId, 2)));
      } catch (err) {
        rpcError = errorOf(err, "cancel_failed");
      }
    }
    this.finish(job, {
      kind: "canceled",
      text: null,
      question: null,
      error: rpcError === null ? null : { code: rpcError.code, message: `已停本地轮，但桥侧回执异常：${rpcError.message}` },
    });
    // `finish` 幂等：若在途 `tasks/get` 已先行收口 ⇒ 这里不改写，返回**真实既有态**
    const state = job.state;
    const display =
      rpcError !== null
        ? `已停止这一轮（桥侧回执：${rpcError.code}）`
        : state === "canceled"
          ? "已停止这一轮"
          : `本地轮已收口，实际终态 = ${state}`;
    return { ok: true, turnId, state, error: rpcError, display };
  }

  // -- 可见面 ---------------------------------------------------------------

  /** 该桥的闸位与队列（界面显示「排队中」；`capacity` 恒 1 = §3.4 的口径）。 */
  queueView(org: string): BridgeQueueView {
    const channel = this.channel(org);
    const running = channel.running;
    return {
      org,
      running:
        running === null
          ? null
          : {
              turnId: running.turnId,
              requirementId: running.requirementId,
              taskId: running.taskId,
              startedAt: toIso(running.startedAt ?? running.queuedAt),
            },
      waiting: channel.queue.map((j) => ({
        turnId: j.turnId,
        requirementId: j.requirementId,
        queuedAt: toIso(j.queuedAt),
        display: QUEUED_DISPLAY,
      })),
      capacity: 1,
    };
  }

  /** 当前仍在闸上 / 闸内的轮（`queued` + `running`；进程内运行态，收口的轮只留台账）。 */
  activeTurns(org?: string): TurnResult[] {
    return [...this.jobs.values()]
      .filter((j) => (org === undefined || j.org === org) && !j.settled)
      .map((j) => this.resultOf(j));
  }

  /** 需求 → 会话记录（`contextId` 的事实源；台账在 ⇒ 以台账为准）。 */
  sessionOf(requirementId: string): RequirementSessionRecord | null {
    if (this.ledger !== null && !this.ledgerDegraded) {
      const { ledger } = this.ledger.load();
      return ledger.requirements.find((s) => s.requirementId === requirementId) ?? null;
    }
    const s = this.sessions.get(requirementId);
    return s === undefined
      ? null
      : {
          requirementId,
          org: s.org,
          contextId: s.contextId,
          round: s.round,
          firstTurnAt: "",
          updatedAt: "",
        };
  }

  /**
   * 该需求**最近一条**轮记录（按 `updatedAt` 取新；台账在 ⇒ 以台账为事实源）。
   * BD9 回答入口的判据面：只有最新轮处于 `awaiting_answer` 才允许续推。
   * ⚠ 「最近一条」只是**账面序** —— 更新轮被历史裁剪后，这里可能露出陈旧记录；
   * 「当前待澄清」的判据请用 {@link findAwaitingTurn}（含取代校验），勿直接用本方法放行回答。
   */
  latestTurnOf(requirementId: string): TurnRecord | null {
    if (this.ledger !== null && !this.ledgerDegraded) {
      const { ledger } = this.ledger.load();
      let best: TurnRecord | null = null;
      for (const t of ledger.turns) {
        if (t.requirementId !== requirementId) continue;
        if (best === null || t.updatedAt >= best.updatedAt) best = t;
      }
      if (best !== null) return best;
    }
    let best: TurnRecord | null = null;
    for (const j of this.jobs.values()) {
      if (j.requirementId !== requirementId) continue;
      if (best === null || j.record.updatedAt >= best.updatedAt) best = j.record;
    }
    return best;
  }

  /**
   * **当前待澄清的一轮**（收口轨 16 ②）：`awaiting_answer` ∧ **未被任何更新轮取代**。
   *
   * 背景：`awaiting_answer` 不是轮的终态收口写点 —— 用户回答后新轮开跑，**旧 awaiting 记录
   * 不会被回写清算**；一旦更新轮被历史裁剪（`trimTurns` 不裁未结束轮 ⇒ 陈旧 awaiting 永存、
   * 新近已收口轮反被裁掉），「取最新记录」会露出最老的陈旧残留，详情页渲染出早已回答过的问题。
   *
   * 取代判据（两条证据，任一成立即视为已被取代；**只读判定，不回写台账**）：
   * ① 需求会话账的 `updatedAt`（每开一轮进 `openTurn` 时刷新，且不参与历史裁剪）晚于
   *    该轮的最后更新 ⇒ 该轮之后又开过新轮；
   * ② 进程内该需求的**另一条**轮记录更新晚于该轮 ⇒ 新轮已在跑 / 已收口。
   *
   * **选型：读侧判据，不选「台账打 superseded 标记」** —— 轮态是七值闭集，加标记要扩值域并
   * 重写历史账（老账文件不兼容），且清不掉**已产生的存量脏记录**（真机 850b3aa9 即如此）；
   * 读侧判定对存量与增量一体生效，事实源仍只有台账一份。
   *
   * 与 {@link busyTurnOf} 互不污染：占用闸的仍只认 `running` / `queued`（在飞/排队），
   * `awaiting_answer` 不占闸的既有语义不变；本方法不改任何轮态，只提供「当前待澄清」判据。
   */
  findAwaitingTurn(requirementId: string): TurnRecord | null {
    const latest = this.latestTurnOf(requirementId);
    if (latest === null || latest.state !== "awaiting_answer") return null;
    return this.isSupersededTurn(requirementId, latest) ? null : latest;
  }

  // -- 内部：闸 / 会话 ------------------------------------------------------

  /**
   * 该需求当前**占用闸位语义**的轮（`running` 在飞 / `queued` 排队；跨组织按需求扫，
   * 需求的 `org` 由会话钉死）。`awaiting_answer`（等人回答）与终态轮 ⇒ 不占。
   */
  private activeJobOfRequirement(requirementId: string): TurnJob | null {
    for (const j of this.jobs.values()) {
      if (j.requirementId !== requirementId || j.settled) continue;
      if (j.state === "running" || j.state === "queued") return j;
    }
    return null;
  }

  /**
   * 该需求**当前占用中的一轮**（在飞 / 排队；收口轨 14 的判据面：详情页渲染禁用、
   * 宿主面防重前置都用它）。`kind` = 占用轮的轮态（`running` | `queued`）。
   */
  busyTurnOf(requirementId: string): OccupantTurnView | null {
    const job = this.activeJobOfRequirement(requirementId);
    return job === null ? null : occupantView(job);
  }

  /** {@link findAwaitingTurn} 的取代证据判定（见其注释①②；ISO 串同格式可直接字典序比较）。 */
  private isSupersededTurn(requirementId: string, turn: TurnRecord): boolean {
    const session = this.sessionOf(requirementId);
    if (session !== null && session.updatedAt > turn.updatedAt) return true;
    for (const j of this.jobs.values()) {
      if (j.requirementId !== requirementId || j.turnId === turn.turnId) continue;
      if (j.record.updatedAt > turn.updatedAt) return true;
    }
    return false;
  }

  private channel(org: string): BridgeChannel {
    const existing = this.channels.get(org);
    if (existing !== undefined) return existing;
    const created: BridgeChannel = { org, running: null, queue: [] };
    this.channels.set(org, created);
    return created;
  }

  /** 闸的空位只在**本轮收口后**交出 ⇒ 同一桥结构上不可能有两个在飞轮。 */
  private pump(org: string): void {
    const channel = this.channel(org);
    if (channel.running !== null) return;
    const next = channel.queue.shift();
    if (next === undefined) return;
    channel.running = next;
    void this.runJob(next);
  }

  /** 取或首次分配该需求的 `contextId`（**同需求复用、跨需求各异**）。 */
  private openSession(requirementId: string, org: string): { contextId: string; round: number } {
    if (this.ledger !== null && !this.ledgerDegraded) {
      try {
        return this.ledger.openTurn({ requirementId, org, at: toIso(this.now()) }, () =>
          newBoardContextId(this.idFactory),
        );
      } catch {
        // 台账坏 ⇒ 降级为进程内会话表（轮次照跑），降级事实由收口时的 error 字段出可见面
        this.ledgerDegraded = true;
      }
    }
    const prev = this.sessions.get(requirementId);
    if (prev !== undefined) {
      const round = prev.round + 1;
      this.sessions.set(requirementId, { ...prev, round });
      return { contextId: prev.contextId, round };
    }
    const contextId = newBoardContextId(this.idFactory);
    this.sessions.set(requirementId, { org, contextId, round: 1 });
    return { contextId, round: 1 };
  }

  private createJob(input: {
    turnId: string;
    org: string;
    requirementId: string;
    contextId: string;
    round: number;
    text: string;
    at: number;
    timeoutMs: number;
  }): TurnJob {
    let settle: (result: TurnResult) => void = () => undefined;
    const done = new Promise<TurnResult>((res) => {
      settle = res;
    });
    const stamp = toIso(input.at);
    const job: TurnJob = {
      turnId: input.turnId,
      org: input.org,
      requirementId: input.requirementId,
      contextId: input.contextId,
      round: input.round,
      text: input.text,
      timeoutMs: input.timeoutMs,
      taskId: null,
      state: "queued",
      rpc: null,
      queuedAt: input.at,
      startedAt: null,
      bridgeNote: null,
      cancelRequested: false,
      settled: false,
      inRunJob: false,
      outcome: null,
      record: {
        turnId: input.turnId,
        requirementId: input.requirementId,
        org: input.org,
        contextId: input.contextId,
        taskId: null,
        state: "queued",
        summary: null,
        question: null,
        error: null,
        bridgeNote: null,
        queuedAt: stamp,
        startedAt: null,
        finishedAt: null,
        updatedAt: stamp,
      },
      settle,
      done,
    };
    return job;
  }

  // -- 内部：一轮的完整执行（发 → 有界轮询 → 收口） ---------------------------

  private async runJob(job: TurnJob): Promise<void> {
    job.inRunJob = true;
    let roundBegan = false;
    try {
      if (job.settled) return; // 取消先于开跑 ⇒ 一条也不发
      const ensured = await this.gateway.ensureBridge(job.org);
      if (job.settled) return;
      if (!ensured.ok || ensured.port === null) {
        this.finish(job, {
          kind: "failed",
          text: null,
          question: null,
          error: { code: "bridge_unavailable", message: `${HOST_BRIDGE_DOWN_MESSAGE}：${ensured.error ?? "端口未知"}` },
        });
        return;
      }
      if (job.round > 1 && !ensured.reused) job.bridgeNote = BRIDGE_RESTART_NOTE;
      const rpc = this.rpcFor(ensured.port);
      job.rpc = rpc;
      this.gateway.beginRound(job.org);
      roundBegan = true;
      const sent = parseTaskResponse(
        await rpc(buildMessageSendRequest({ contextId: job.contextId, text: job.text, messageId: job.turnId }, 1)),
      );
      job.taskId = sent.taskId;
      job.state = "running";
      job.startedAt = this.now();
      this.writeTurn(job);
      await this.pollUntilTerminal(job, rpc);
    } catch (err) {
      this.finish(job, { kind: "failed", text: null, question: null, error: errorOf(err, "turn_failed") });
    } finally {
      // BD4a 的在飞计数与 beginRound 严格配对：发轮抛错也必须落计数，否则该桥永不回收
      if (roundBegan) this.gateway.endRound(job.org);
      // 收口兜底：任何出口都不允许「没收口就交闸」（否则 done 永不解决、闸位泄漏）
      this.finish(job, { kind: "failed", text: null, question: null, error: { code: "turn_unsettled", message: "本轮未收口（内部兜底）" } });
      const channel = this.channel(job.org);
      if (channel.running === job) channel.running = null;
      this.pump(job.org);
      job.inRunJob = false;
      // `done` 在**交闸与落计数之后**才解决 ⇒ 调用方看到的「本轮结束」必然对应闸位已空
      const outcome = job.outcome;
      job.outcome = null;
      if (outcome !== null) job.settle(outcome);
    }
  }

  /** 有界轮询：终态即停；到 `timeoutMs` ⇒ 尽力 `tasks/cancel` 后落 `timeout`。 */
  private async pollUntilTerminal(job: TurnJob, rpc: RpcCall): Promise<void> {
    const deadline = this.now() + job.timeoutMs;
    for (;;) {
      if (job.cancelRequested) {
        this.finish(job, { kind: "canceled", text: null, question: null, error: null });
        return;
      }
      let task: NormalizedTask;
      try {
        task = parseTaskResponse(await rpc(buildTasksGetRequest(job.taskId ?? "", 3)));
      } catch (err) {
        const error = errorOf(err, "poll_failed");
        if (error.code === "task_not_found") {
          // 桥侧不再认识这条任务（如桥重启）⇒ 判失败，**不谎报成功**
          this.finish(job, { kind: "failed", text: null, question: null, error });
          return;
        }
        if (this.now() >= deadline) {
          this.finish(job, {
            kind: "failed",
            text: null,
            question: null,
            state: "timeout",
            error: { code: "turn_timeout", message: `等待终态超过 ${String(job.timeoutMs)}ms（有界上限），末次读取仍失败：${error.message}` },
          });
          return;
        }
        await this.delay(this.pollIntervalMs);
        continue;
      }
      if (task.terminal) {
        this.finish(job, {
          kind: task.kind,
          text: task.kind === "awaiting_answer" ? task.question : task.text,
          question: task.question,
          error:
            task.kind === "failed"
              ? { code: "bridge_task_failed", message: task.reason ?? task.text ?? "桥侧任务失败" }
              : null,
        });
        return;
      }
      if (this.now() >= deadline) {
        await this.bestEffortCancel(rpc, job.taskId);
        this.finish(job, {
          kind: "failed",
          state: "timeout",
          text: null,
          question: null,
          error: { code: "turn_timeout", message: `等待终态超过 ${String(job.timeoutMs)}ms（有界上限），已尽力取消` },
        });
        return;
      }
      await this.delay(this.pollIntervalMs);
    }
  }

  private async bestEffortCancel(rpc: RpcCall, taskId: string | null): Promise<void> {
    if (taskId === null) return;
    try {
      await rpc(buildTasksCancelRequest(taskId, 4));
    } catch {
      // 取消是 best-effort：本地已判超时，不再追桥侧回执
    }
  }

  // -- 内部：收口 + 回写台账 -------------------------------------------------

  /**
   * 收口（**幂等**，一条轮只有一个终态）。`awaiting_answer` 也走这里：它**结束本轮**
   * （`done` 解决、闸位交出）但板侧轮状态**不是终态** —— 等人回答的时间不能占住整条桥。
   */
  private finish(
    job: TurnJob,
    outcome: {
      kind: TurnOutcomeKind;
      /** 覆盖板侧轮态（缺省由 `kind` 派生；`timeout` 用 `state: "timeout"`）。 */
      state?: TurnState;
      text: string | null;
      question: string | null;
      error: { code: string; message: string } | null;
    },
  ): void {
    if (job.settled) return;
    job.settled = true;
    const state: TurnState = outcome.state ?? turnStateOfKind(outcome.kind);
    job.state = state;
    const summary = summarizeTurnText(outcome.text);
    const at = this.now();
    job.record = {
      ...job.record,
      taskId: job.taskId,
      state,
      summary,
      question: state === "awaiting_answer" ? (outcome.question ?? summary) : outcome.question,
      error: outcome.error,
      bridgeNote: job.bridgeNote,
      startedAt: job.startedAt === null ? null : toIso(job.startedAt),
      finishedAt: isTerminalTurnState(state) ? toIso(at) : null,
      updatedAt: toIso(at),
    };
    this.writeTurn(job);
    const result = this.resultOf(job);
    if (job.inRunJob) {
      // 交闸（endRound + pump）在前、`done` 解决在后 ⇒ 调用方看到「结束」时闸位一定已空
      job.outcome = result;
      return;
    }
    job.settle(result);
  }

  /** 轮记录回写板侧台账（**不写引擎状态机**）。写失败 ⇒ 降级可见，不改判结果。 */
  private writeTurn(job: TurnJob): void {
    if (this.ledger === null) return;
    try {
      this.ledger.recordTurn(job.record);
    } catch {
      this.ledgerDegraded = true;
      job.record = {
        ...job.record,
        error: job.record.error ?? {
          code: "ledger_write_failed",
          message: `对话轮台账写入失败：${this.ledger.file}`,
        },
      };
    }
  }

  private resultOf(job: TurnJob): TurnResult {
    return {
      turnId: job.turnId,
      requirementId: job.requirementId,
      org: job.org,
      contextId: job.contextId,
      taskId: job.taskId,
      state: job.state,
      kind: kindOfTurnState(job.state),
      text: job.record.summary,
      summary: job.record.summary,
      question: job.record.question,
      error: job.record.error,
      bridgeNote: job.bridgeNote,
      display: turnDisplay(job),
      queuedAt: job.record.queuedAt,
      startedAt: job.record.startedAt,
      finishedAt: job.record.finishedAt,
    };
  }
}

/** 面向人的显示文案（`input-required` 与 `failed` 分流是本节点的硬口径）。 */
function turnDisplay(job: TurnJob): string {
  const head = `${job.org} · ${job.requirementId} · 第 ${String(job.round)} 轮`;
  switch (job.state) {
    case "queued":
      return `${head} ${QUEUED_DISPLAY}`;
    case "running":
      return `${head} 进行中${job.taskId === null ? "" : `（任务 ${job.taskId}）`}`;
    case "awaiting_answer":
      return `${head} ${AWAITING_ANSWER_DISPLAY}：${job.record.question ?? ""}`;
    case "canceled":
      return `${head} 已停止这一轮`;
    case "timeout":
      return `${head} 本轮超时（有界上限 ${String(job.timeoutMs)}ms）：${job.record.error?.message ?? ""}`;
    case "failed":
      return `${head} 本轮失败：${job.record.error?.message ?? "未知原因"}`;
    case "succeeded":
    default:
      return `${head} 已完成：${job.record.summary ?? ""}`;
  }
}
