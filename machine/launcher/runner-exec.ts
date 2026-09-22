/**
 * Runner 命令执行器（v0.7.0 · 节点 M3·MB1，Phase B 核心）：**机器侧命令三分支**。
 *
 * M1 出站长轮询从桥收到的命令族由本模块落地执行：
 *   - `dispatch{taskId,projectId,contextId,message|payload,claimToken}` → 台账登记 → `ensure`（幂等复用）→
 *     本地 A2A `message/send` → 轮询至终态 → 组装结果交 outbox 回传（M4·MB2 文件 outbox）；
 *   - `stop{projectId,commandId}` → **in-flight>0 拒收**（回执 `error:"in-flight"`），
 *     否则 `manager.stop` → ack；
 *   - `cancel-task{taskId,commandId}` → 台账定位项目 → 本地 A2A `tasks/cancel`；
 *     wrapper 不响应 → ack error（台账不动，任务照常终态）；台账无此 taskId →
 *     `error:"unknown-task"`。
 *
 * 关键时序：`dispatch` 的执行是**后台异步**的（登记后立即返回，让出轮询循环），
 * 否则长任务会把唯一的长轮询循环钉死 —— 心跳停摆、且 stop/cancel 永远收不到。
 *
 * v0.8.7 · 节点 M3（REQ-v0.8.7-2026-09-22-01）本模块承担三件：
 * - **按项目 deadline**：等待预算由项目平铺 `agentConfig.sessionTimeoutMs` 派生
 *   （{@link dispatchBudgetMs}，恒 `dispatch = session + margin`）—— 防「只配桥侧会话窗、
 *   launcher 仍按 660s 掐断」的静默无效；
 * - **机器可读失败字段**：{@link RunnerTaskResult.failureKind}（{@link classifyFailure} 判定，
 *   launcher 是唯一同时看得见 `ensure` / transport / 自有超时的位置）+ `diagnostics`
 *   （桥内细分经现成 `artifacts` 通道上带，见下）；
 * - **diagnostics artifact 摘除**：桥的 `machine-diagnostics` artifact 在此**取出并剥离**再交
 *   outbox —— 不摘则 resultText（message + artifacts 拼接）会把诊断 JSON 混进结果文本。
 *
 * 边界（本节点显式不做）：不改 adapter / wrapper；不退役入站端点（M5）；
 * 不在桥侧加显式 diagnostics 类型键（走 artifacts 通道 ⇒ 零类型 / 零 wire 变更）；
 * 不预映射 `{infra,task}` 之外的词表（**映射权归 orch**）。
 */
import { randomUUID } from "node:crypto";
import type { ProjectConfig } from "../types.js";
import {
  A2A_TERMINAL_STATES,
  artifactsOf,
  postJsonRpc,
  taskViewOf,
  textFromParts,
  type A2AFetch,
  type A2ATaskView,
} from "./a2a-client.js";
import { agentEndpoint } from "./manager.js";
import { resolveSessionTimeoutMs } from "./agent-config.js";
import { errorMessage } from "./process.js";
import type { InFlightEntry, InFlightLedger, RunnerLogger } from "./runner.js";

/**
 * 单任务派发等待上限**缺省值**（660s = 桥缺省会话窗 600s + 60s）：
 * **仅**用于项目**未配** `agentConfig.sessionTimeoutMs` 时（行为与 v0.8.6 一致，零回归）。
 * 配了 ⇒ 走 {@link dispatchBudgetMs} 按项目派生。
 */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 660_000;

/**
 * 派发预算在桥会话窗之上的**余量**（v0.8.7 · M3）：5 min。
 * 取值理由见改造文档 §1.1 #7：非 prompt 段每步各享一个桥缺省超时（最坏 ≈ 6×600s），
 * 原 660s = 600+60 属侥幸；上限 15 min + 300 s ⇒ 最坏 20 min，仍在 orch 墙钟 30 min 之下。
 */
export const DISPATCH_MARGIN_MS = 300_000;

/** 任务态轮询间隔 */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** `tasks/cancel` 短请求超时（取消是控制面动作，不应拖长轮询预算） */
export const CANCEL_TIMEOUT_MS = 10_000;

/**
 * 传输层有界重发的**重发次数上限**（v0.8.7 · M5 · 用户裁 ③「默认 1 次」）：首发之外的
 * 额外尝试次数。**主形态（终态重跑）与辅形态（send 相位连接级失败内部重投）共用此计数、
 * 互斥划分**（一次派发最多重发一次），故不会双触发。
 */
export const MAX_TRANSPORT_ATTEMPTS = 1;

/**
 * 重发前的**剩余墙钟闸**（v0.8.7 · M5）：`remaining() >= 60_000` 才重发。
 * 否则预算只剩一点点，重发那一轮必然被 deadline 掐断 = 白烧一轮，不如直接把当前终态交回。
 * 总墙钟不越 `deadline`（`executeDispatch` 单点计算，天然封顶，不需新常量）。
 */
export const RESEND_MIN_REMAINING_MS = 60_000;

/**
 * 「桥报的、属载体早夭、可终态重跑」的 ACP 错误类别（v0.8.7 · M5 主形态判据）。
 * `spawn` = 后端进程起不来 / 进程错误；`closed` = 后端进程中途退出（`client.ts:121-127`）。
 * **不含 `timeout`** —— 超时类见 `executeDispatch` 的边界注释，绝不重跑。
 */
const RERUNNABLE_ACP_KINDS: ReadonlySet<string> = new Set(["spawn", "closed"]);

/**
 * 连接级失败的文本特征（v0.8.7 · M5 辅形态判据）：send 相位拿不到终态时的传输层抛错。
 * 覆盖 Node/undici 常见 socket 错码与「fetch failed」包装（桥进程死 → fetch 以 TypeError
 * "fetch failed" 抛出）；**不含** AbortSignal 超时（`The operation ... aborted/timeout`）——
 * 那属超时/abort 类，按边界禁止重发。
 */
const CONNECTION_LEVEL_FAILURE_RE =
  /ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|桥进程|process exited|后端进程退出/i;

/** 辅形态判据：错误文本是否属连接级失败（send 相位、连终态都拿不到的窄场景） */
export function isConnectionLevelFailure(text: string): boolean {
  return CONNECTION_LEVEL_FAILURE_RE.test(text);
}

/** 命令类型（命令族三类） */
export type RunnerCommandType = "dispatch" | "stop" | "cancel-task";

/** 派发命令：把一条任务交给本机项目执行 */
export interface DispatchCommand {
  type: "dispatch";
  /** 桥侧任务 id（本模块台账键 / 回传幂等键） */
  taskId: string;
  projectId: string;
  /** A2A 上下文 id（与桥侧会话映射同源，原样透传） */
  contextId: string;
  /** 任务消息体（字符串 prompt；对象则取 text/message/prompt 或 JSON 化） */
  payload: unknown;
  /**
   * 本次领取令牌（桥侧 `claimToken`）：结果回传 `/runner/result` 时由 outbox **原样带回**
   * 供桥侧校验（改造文档 §2「入站 3 点：register / claim 前 / result claim_token」）。
   * 缺省 = 旧桥未下发（结果仍落盘重试；桥侧缺 token 会拒收，行为显式可观测）。
   */
  claimToken?: string;
}

/** 停止命令：停止本机项目 Agent（in-flight>0 时拒收） */
export interface StopCommand {
  type: "stop";
  projectId: string;
  commandId: string;
}

/** 取消命令：取消某在飞任务的本地 wrapper 执行 */
export interface CancelTaskCommand {
  type: "cancel-task";
  /** 桥侧任务 id（经台账定位项目与本地 A2A 任务 id） */
  taskId: string;
  commandId: string;
}

export type RunnerCommand = DispatchCommand | StopCommand | CancelTaskCommand;

/**
 * 命令回执（stop / cancel-task 用；dispatch 的结果走 outbox 回传，不产生 ack）。
 * `error` 缺省 = 成功；存在即为失败原因（`"in-flight"` / `"unknown-task"` / `"not-started"`
 * / 底层错误文本）。
 */
export interface RunnerCommandAck {
  commandId: string;
  error?: string;
}

/** 结果态：A2A 任务态如实映射后的三类（与 A2A outcome 约定同口径） */
export type RunnerTaskState = "completed" | "failed" | "input-required";

/**
 * 失败大类（⑥ 二分的落点，v0.8.7 · M3）：**launcher 判定、orch 消费**。
 * `infra` = 载体 / 传输 / 超时侧（重派有意义）；`task` = 任务自身跑出来就是失败（重派无意义）。
 * machine **不越过这两个取值**去猜更细的词表（映射与判据归 orch，改造文档 §2.9 契约 4）。
 */
export type RunnerFailureKind = "infra" | "task";

/** launcher 视角的失败落点阶段（本模块唯一能看到这四段的位置） */
export type RunnerFailureStage = "ensure" | "send" | "poll" | "wait";

/**
 * 结果诊断（v0.8.7 · M3）：launcher 自有事实（`elapsedMs` / `stage`）+ 桥内细分
 * （`acpErrorKind` / `chunkCount`，经 `machine-diagnostics` artifact 上带；桥未带 ⇒ 键缺省）。
 * v0.8.7 · M5 增 `attempts`（传输层有界重发**留痕**，不落库 —— `retry_count` 列是 Feature
 * rearm 语义，与本次重发无关，勿混用）。
 */
export interface RunnerTaskDiagnostics {
  /** 桥内 ACP 错误类别（取值见 `acp-bridge/acp/client.ts` 的 `AcpError["kind"]`） */
  acpErrorKind?: string;
  /** 本派发从收到命令到落定结果的墙钟耗时（launcher 自测） */
  elapsedMs: number;
  /** 桥侧累计 chunk 数（仅桥带 diagnostics 时有值；**不作推进判据**，只留痕） */
  chunkCount?: number;
  /** 结果落定时所处阶段 */
  stage: RunnerFailureStage;
  /**
   * 本结果经历的重发次数（v0.8.7 · M5 留痕；`0` / 缺省 = 未重发）。仅存在于回传结果的
   * `diagnostics`，**不落库**（不写 Feature 的 `retry_count`）。
   */
  attempts?: number;
}

/** 任务结果（M4 落盘 `.a2a/outbox/<taskId>.json` 的载荷形状） */
export interface RunnerTaskResult {
  taskId: string;
  machineId: string;
  projectId: string;
  contextId: string;
  state: RunnerTaskState;
  /** 失败大类；**仅 `state === "failed"` 时有值**（其余态不产出 failureKind） */
  failureKind?: RunnerFailureKind;
  /** 机器可读诊断（失败必带；成功时仅当桥上带了 diagnostics 才带） */
  diagnostics?: RunnerTaskDiagnostics;
  text: string;
  artifacts: unknown[];
  finishedAt: string;
}

/**
 * 结果回传凭证（**传输层**，不属于结果 schema）：`claim_token` 由派发命令带入，
 * 由 outbox 在 `POST /runner/result` 时原样带回供桥侧校验。
 */
export interface RunnerResultCredential {
  claimToken: string;
}

/**
 * 结果回传出口。M4 节点提供文件实现 `FileOutbox`（落盘 → `POST /runner/result`
 * → ack 删除 + 退避重试），经 deps 注入；未注入时回落 {@link createLoggingOutbox}
 * 仅记日志的 stub。
 */
export interface RunnerOutbox {
  deliver(result: RunnerTaskResult, credential?: RunnerResultCredential): Promise<void> | void;
  /** 启动 outbox 后台重试循环（可选：stub 无生命周期） */
  start?(): void;
  /** 停止 outbox 循环（可选；幂等） */
  stop?(): void;
}

/** 执行宿主：`AgentManager` 结构化满足（便于单测注入 fake，不依赖具体类） */
export interface RunnerExecHost {
  ensure(projectId: string): Promise<{ endpoint: string }>;
  stop(projectId: string): Promise<{ stopped: boolean }>;
  getProject(projectId: string): ProjectConfig;
}

export interface RunnerExecDeps {
  host: RunnerExecHost;
  ledger: InFlightLedger;
  machineId: string;
  outbox?: RunnerOutbox;
  /** A2A 出口（缺省全局 fetch；单测注入 fake） */
  fetch?: A2AFetch;
  logger?: RunnerLogger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /**
   * 派发预算的**显式覆盖**（单测 / 特殊接线用）。
   * 缺省不给 ⇒ 按项目派生（{@link dispatchBudgetMs}），见 v0.8.7 · M3。
   */
  dispatchTimeoutMs?: number;
  pollIntervalMs?: number;
}

const defaultLogger: RunnerLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 从命令载荷中取判别字段：兼容 `type` / `command` / `kind` 三种命名（A3/A8 定稿前宽容） */
function commandKindOf(o: Record<string, unknown>): string | null {
  for (const key of ["type", "command", "kind"] as const) {
    const value = o[key];
    if (typeof value === "string") return value;
  }
  return null;
}

/** 从 connect 响应体解包命令：兼容裸命令 / `{command}` / `{result}` / `{data}` 包裹 */
function unwrapCommand(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  for (const key of ["command", "result", "data"] as const) {
    const inner = o[key];
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
  }
  return o;
}

/** 任务消息体 → 文本：字符串原样；对象优先 `text` / `message` / `prompt`，否则 JSON 化 */
function payloadText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (typeof payload === "object" && payload !== null) {
    const o = payload as Record<string, unknown>;
    for (const key of ["text", "message", "prompt"] as const) {
      const value = o[key];
      if (typeof value === "string") return value;
    }
    return JSON.stringify(payload);
  }
  return payload === null || payload === undefined ? "" : String(payload);
}

/**
 * 解析一条命令（结构不合法 / 判别字段非三类 ⇒ null）。
 * 宽容点：字段命名未在 PROTOCOL 2.0 定稿前允许多种别名，不合法即忽略（不抛）。
 */
export function parseRunnerCommand(body: unknown): RunnerCommand | null {
  const o = unwrapCommand(body);
  if (o === null) return null;
  const kind = commandKindOf(o);

  if (kind === "dispatch") {
    const taskId = o["taskId"];
    const projectId = o["projectId"];
    if (typeof taskId !== "string" || taskId.length === 0) return null;
    if (typeof projectId !== "string" || projectId.length === 0) return null;
    const contextId = typeof o["contextId"] === "string" ? o["contextId"] : "";
    // 消息体别名：`payload`（本地约定）向后兼容；桥侧现行字段为 `message`（改造文档 §2 / orch 命令契约）
    const payload = o["payload"] ?? o["message"] ?? "";
    const claimToken = o["claimToken"];
    const base: DispatchCommand = { type: "dispatch", taskId, projectId, contextId, payload };
    if (typeof claimToken === "string" && claimToken.length > 0) {
      return { ...base, claimToken };
    }
    return base;
  }

  if (kind === "stop") {
    const projectId = o["projectId"];
    const commandId = o["commandId"];
    if (typeof projectId !== "string" || projectId.length === 0) return null;
    if (typeof commandId !== "string" || commandId.length === 0) return null;
    return { type: "stop", projectId, commandId };
  }

  if (kind === "cancel-task") {
    const taskId = o["taskId"];
    const commandId = o["commandId"];
    if (typeof taskId !== "string" || taskId.length === 0) return null;
    if (typeof commandId !== "string" || commandId.length === 0) return null;
    return { type: "cancel-task", taskId, commandId };
  }

  return null;
}

/** A2A 任务态 → 桥侧结果态（如实映射；其余终态 / 未知一律 failed） */
export function mapTaskState(state: string, timedOut: boolean): RunnerTaskState {
  if (timedOut) return "failed";
  if (state === "completed") return "completed";
  if (state === "input-required") return "input-required";
  return "failed";
}

/**
 * 派发等待预算 = **桥会话窗 + 余量**（v0.8.7 · M3 成对联动，改造文档 §2.6）。
 *
 * `sessionTimeoutMs` = 项目平铺 `agentConfig.sessionTimeoutMs`（与 adapter 下发给桥的
 * `--session-timeout` **同一个值**）⇒ 桥窗一改，launcher 的 deadline **同值派生**，
 * 不存在「只配桥侧、launcher 仍按 660s 掐断」的静默无效。
 * 未配 ⇒ {@link DEFAULT_DISPATCH_TIMEOUT_MS}（桥落自身缺省 600s，行为同 v0.8.6）。
 */
export function dispatchBudgetMs(sessionTimeoutMs: number | undefined): number {
  return sessionTimeoutMs === undefined
    ? DEFAULT_DISPATCH_TIMEOUT_MS
    : sessionTimeoutMs + DISPATCH_MARGIN_MS;
}

/** {@link classifyFailure} 的输入信号（全部是 launcher 看得见的事实，不猜文本） */
export interface FailureSignals {
  /** launcher 自有预算耗尽 */
  timedOut: boolean;
  /** 已映射的结果态 */
  state: RunnerTaskState;
  /** 失败发生在 `host.ensure`（载体拉不起来 / 端口冲突等） */
  threwInEnsure: boolean;
  /**
   * 失败发生在 `send` / `poll` 相位的**传输层**抛错（连接级 / HTTP / RPC 层，无终态可谈）
   * —— 载体侧事实，只有 launcher 看得见；任务自身跑出的失败不走此信号。
   */
  threwInTransport?: boolean;
  /** 桥内 ACP 错误类别（来自 diagnostics；桥未带 ⇒ undefined） */
  acpErrorKind?: string | undefined;
}

/**
 * 失败大类判定（纯函数；v0.8.7 · M3）：**非失败态返回 null**，失败态归 `infra` / `task`。
 *
 * 优先级：`timedOut` **最优先** —— launcher 自有超时是「等待预算」问题，与桥报的 kind 无关
 * （且 launcher **看不见**桥的 kind：桥超时只表现为 failed 文本，故 acpErrorKind 仅作补充）。
 * 其余 infra 信号 = `ensure` 抛错、`send`/`poll` 传输层抛错、桥的 `timeout` kind；
 * **v0.8.7 · M5 追加**：桥报的 `spawn` / `closed` kind（后端进程起不来 / 中途退出）同为
 * **载体侧** infra —— 这不是「猜更细词表」，而是把桥给出的**原生事实**归入 `{infra,task}`
 * 二分中的正确一侧（spawn/closed ⇒ 重派有意义），也是 M5「终态重跑」主形态的触发前置；
 * 都不成立 ⇒ 任务自身失败（`task`）。
 */
export function classifyFailure(signals: FailureSignals): RunnerFailureKind | null {
  if (signals.state !== "failed") return null;
  if (signals.timedOut) return "infra";
  if (signals.threwInEnsure) return "infra";
  if (signals.threwInTransport === true) return "infra";
  if (signals.acpErrorKind === "timeout") return "infra";
  if (signals.acpErrorKind === "spawn" || signals.acpErrorKind === "closed") return "infra";
  return "task";
}

/** 桥上带 diagnostics 用的 artifact 名（零类型 / 零 wire 变更：走现成 artifacts 通道） */
export const DIAGNOSTICS_ARTIFACT_NAME = "machine-diagnostics";

/** 桥 `machine-diagnostics` artifact 解出的字段（形状由桥写入，launcher 只读、不校验取值） */
export interface BridgeDiagnostics {
  acpErrorKind?: string;
  chunkCount?: number;
}

function artifactName(artifact: unknown): string | null {
  if (typeof artifact !== "object" || artifact === null) return null;
  const name = (artifact as Record<string, unknown>)["name"];
  return typeof name === "string" ? name : null;
}

function artifactParts(artifact: unknown): unknown {
  if (typeof artifact !== "object" || artifact === null) return undefined;
  return (artifact as Record<string, unknown>)["parts"];
}

/** JSON 文本 → 桥 diagnostics；非对象 / 非法 JSON / 类型不符 ⇒ 相应键丢弃（宽容，不抛） */
function parseBridgeDiagnostics(text: string): BridgeDiagnostics | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const kind = o["acpErrorKind"];
  const chunks = o["chunkCount"];
  const out: BridgeDiagnostics = {};
  if (typeof kind === "string" && kind.length > 0) out.acpErrorKind = kind;
  if (typeof chunks === "number" && Number.isInteger(chunks) && chunks >= 0) {
    out.chunkCount = chunks;
  }
  return out;
}

/**
 * 摘除 `machine-diagnostics` artifact（v0.8.7 · M3 的**必须**动作）：
 * 返回解析出的桥 diagnostics + **剩余 artifacts**（原样、保序）。
 * 多条同名 ⇒ 只取首条为 diagnostics，其余按普通 artifact 回传（不静默吞数据）。
 */
export function splitDiagnosticsArtifact(artifacts: unknown[]): {
  diagnostics: BridgeDiagnostics | null;
  artifacts: unknown[];
} {
  const rest: unknown[] = [];
  let diagnostics: BridgeDiagnostics | null = null;
  for (const artifact of artifacts) {
    if (diagnostics === null && artifactName(artifact) === DIAGNOSTICS_ARTIFACT_NAME) {
      diagnostics = parseBridgeDiagnostics(textFromParts(artifactParts(artifact)));
      continue;
    }
    rest.push(artifact);
  }
  return { diagnostics, artifacts: rest };
}

/** 一次派发的自述：起算时刻 + 当前落点阶段（供失败归因 / diagnostics 使用） */
interface DispatchTrace {
  startedAtMs: number;
  stage: RunnerFailureStage;
}

/** 一次派发尝试的结果 + 可重发形态（v0.8.7 · M5；两种触发由「是否拿到终态」互斥划分） */
interface AttemptOutcome {
  result: RunnerTaskResult;
  kind: "none" | "terminal-rerun" | "send-connect";
}

/**
 * 命令执行器：由 Runner 在收到命令时调用 `handle()`。
 * `dispatch` 立即返回（后台执行），`stop` / `cancel-task` 完成后返回回执。
 */
export class RunnerCommandExecutor {
  private readonly host: RunnerExecHost;
  private readonly ledger: InFlightLedger;
  private readonly machineId: string;
  private readonly outbox: RunnerOutbox;
  private readonly fetchFn: A2AFetch | undefined;
  private readonly logger: RunnerLogger;
  private readonly now: () => Date;
  private readonly sleepFn: (ms: number) => Promise<void>;
  /** 派发预算覆盖（给了则优先于按项目派生；生产缺省不给） */
  private readonly dispatchTimeoutOverride: number | undefined;
  private readonly pollIntervalMs: number;

  constructor(deps: RunnerExecDeps) {
    this.host = deps.host;
    this.ledger = deps.ledger;
    this.machineId = deps.machineId;
    this.logger = deps.logger ?? defaultLogger;
    this.outbox = deps.outbox ?? createLoggingOutbox(this.logger);
    this.fetchFn = deps.fetch;
    this.now = deps.now ?? (() => new Date());
    this.sleepFn = deps.sleep ?? defaultSleep;
    this.dispatchTimeoutOverride = deps.dispatchTimeoutMs;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** 处理一条命令；dispatch 返回 null（结果走 outbox），其余返回回执 */
  async handle(command: RunnerCommand): Promise<RunnerCommandAck | null> {
    switch (command.type) {
      case "dispatch":
        this.startDispatch(command);
        return null;
      case "stop":
        return await this.handleStop(command);
      case "cancel-task":
        return await this.handleCancel(command);
    }
  }

  /**
   * 登记台账并**后台**执行派发（不阻塞轮询循环）。
   * 同 taskId 重复派发（桥重投）按幂等**忽略**，避免并发重复执行。
   */
  private startDispatch(command: DispatchCommand): void {
    if (this.ledger.has(command.taskId)) {
      this.logger.warn(`[runner] 派发命令重复（taskId=${command.taskId}），已忽略`);
      return;
    }
    const entry: InFlightEntry = {
      taskId: command.taskId,
      projectId: command.projectId,
      startedAt: this.isoNow(),
      a2aTaskId: null,
    };
    this.ledger.add(entry);
    void this.executeDispatch(command, entry).catch((err: unknown) => {
      this.logger.error(`[runner] 派发执行异常（taskId=${command.taskId}）：${errorMessage(err)}`);
      this.ledger.remove(command.taskId);
    });
  }

  /**
   * 派发全流程（v0.8.7 · M5 加**传输层有界重发**）：`ensure → message/send → 轮询终态 →
   * 组装结果`，命中窄幅载体失败则**至多重发一次**，最后交 outbox。
   *
   * **两种触发、互斥划分、共用 `attempts ≤ 1`**（由「是否拿到终态」区分，不会双触发）：
   * - ★ **主形态 = 终态重跑**（{@link shouldRerunTerminal}）：`executeDispatch` **拿到终态之后**
   *   （`result` 到手、`deliver` 之前）判定 —— `failureKind === "infra"` ∧
   *   `diagnostics.acpErrorKind ∈ {spawn, closed}` ∧ `diagnostics.chunkCount === 0` ⇒
   *   **必须先 `host.stop(projectId)` 再 `ensure`** —— `ensure` 只幂等复用在册进程，桥进程
   *   活着且忙时返回同一 endpoint ⇒ 不停则重发撞同一忙会话。这才是「早夭自愈」主体。
   * - **辅形态 = 内部重投**（{@link isSendPhaseConnectFailure}）：唯一窄场景 = **send 相位连接级
   *   失败**（`entry.a2aTaskId === null` + 连接级错误文本）—— 此时连终态都拿不到；进程已死 ⇒
   *   直接重 `ensure`（会重新拉起），无需 stop。
   *
   * **⚠ 边界（不得越界，务必保持不重发）**：「600s 超时且零输出」这一类**绝不重发 / 不重跑** ——
   *   `timeout` 抛错路径只做 `discardCapture`、**从不发 `session/cancel`**（`session.ts:261/
   *   :365-369`）⇒ 桥返回 failed 时后端那一轮**仍在跑**，同 `contextId` 重跑会与新会话的
   *   load/resume 交织；而 ACP 的 cancel 是 notification、不等响应（`:297-306`）⇒ **确认不了
   *   生效 ⇒ 不安全**。该类本版只能靠「加窗跑完」（M2/M3）或**等 orch 墙钟判死后由宿主重派**。
   *   因此 `shouldRerunTerminal` 只认 `spawn/closed`（`timeout` kind 被排除），且 `poll` 相位
   *   抛错（已持有 `view.id`、任务可能仍在执行）不属辅形态 ⇒ 一律不重发 prompt。
   *
   * **留痕**：日志 + `diagnostics.attempts`（**不落库** —— `retry_count` 列是 Feature rearm
   *   语义，不混用）。**orch 侧零改动且不可见**：同 taskId、单次终态回传、不产生第二次账单。
   */
  private async executeDispatch(command: DispatchCommand, entry: InFlightEntry): Promise<void> {
    const trace: DispatchTrace = { startedAtMs: this.now().getTime(), stage: "ensure" };
    const deadline = trace.startedAtMs + this.budgetFor(command.projectId);
    const remaining = (): number => deadline - this.now().getTime();
    let attempts = 0;
    let result: RunnerTaskResult;
    try {
      for (;;) {
        const outcome = await this.attemptOnce(command, entry, deadline, trace);
        const resend =
          attempts < MAX_TRANSPORT_ATTEMPTS &&
          remaining() >= RESEND_MIN_REMAINING_MS &&
          (outcome.kind === "terminal-rerun" || outcome.kind === "send-connect");
        if (!resend) {
          result = outcome.result;
          break;
        }
        attempts += 1;
        this.logger.warn(
          `[runner] 传输层有界重发（第 ${attempts} 次，触发=${outcome.kind}）：` +
            `taskId=${command.taskId} project=${command.projectId} remaining=${remaining()}ms ` +
            `kind=${outcome.result.diagnostics?.acpErrorKind ?? "-"}`,
        );
        // 主形态：先 stop（消除忙会话）；辅形态：桥进程已死，stop 幂等无副作用，亦先 stop 再 ensure。
        try {
          await this.host.stop(command.projectId);
        } catch (err) {
          this.logger.warn(
            `[runner] 重发前 stop 抛错（忽略，继续 ensure）：taskId=${command.taskId} ${errorMessage(err)}`,
          );
        }
      }
    } finally {
      this.ledger.remove(command.taskId);
    }
    if (attempts > 0) result = this.withResendAttempts(result, trace, attempts);
    this.logger.info(
      `[runner] 任务结束：taskId=${result.taskId} project=${result.projectId} state=${result.state}${
        result.failureKind !== undefined ? ` failureKind=${result.failureKind}` : ""
      }${attempts > 0 ? ` attempts=${attempts}` : ""}（交 outbox）`,
    );
    const credential: RunnerResultCredential | undefined =
      command.claimToken !== undefined && command.claimToken.length > 0
        ? { claimToken: command.claimToken }
        : undefined;
    await this.outbox.deliver(result, credential);
  }

  /**
   * 一次派发尝试（ensure → sendAndWait → 组装结果）。返回结果 + 是否可重发及其形态。
   * 抛错归 `buildThrowResult`（`threwInEnsure` 或 `threwInTransport`），并据相位 / 句柄判定辅形态。
   */
  private async attemptOnce(
    command: DispatchCommand,
    entry: InFlightEntry,
    deadline: number,
    trace: DispatchTrace,
  ): Promise<AttemptOutcome> {
    trace.stage = "ensure";
    entry.a2aTaskId = null; // 每次尝试都从「未取得句柄」起算（辅形态判据依赖此）
    try {
      const ensured = await this.host.ensure(command.projectId);
      const settled = await this.sendAndWait(ensured.endpoint, command, entry, deadline, trace);
      const result = this.buildResult(command, settled.settled, settled.timedOut, trace);
      return { result, kind: this.shouldRerunTerminal(result) ? "terminal-rerun" : "none" };
    } catch (err) {
      const text = errorMessage(err);
      const result = this.buildThrowResult(command, trace, text);
      return {
        result,
        kind: this.isSendPhaseConnectFailure(entry, trace, text) ? "send-connect" : "none",
      };
    }
  }

  /**
   * 主形态判据（终态重跑）：拿到终态、且为**载体早夭** —— `state=failed` ∧
   * `failureKind=infra` ∧ `acpErrorKind ∈ {spawn, closed}` ∧ `chunkCount === 0`（严格等于 0，
   * 桥上没报 chunk 数即 `undefined` ⇒ 不重跑，避免对「可能有输出」的失败盲目重投）。
   * `timeout` kind 天然被排除（不属 `{spawn, closed}`）。
   */
  private shouldRerunTerminal(result: RunnerTaskResult): boolean {
    if (result.state !== "failed" || result.failureKind !== "infra") return false;
    const diag = result.diagnostics;
    if (diag === undefined) return false;
    return (
      diag.acpErrorKind !== undefined &&
      RERUNNABLE_ACP_KINDS.has(diag.acpErrorKind) &&
      diag.chunkCount === 0
    );
  }

  /**
   * 辅形态判据（send 相位连接级失败内部重投）：`a2aTaskId === null`（send 未返回）∧
   * `stage === "send"` ∧ 错误文本属连接级。`poll` 相位抛错（句柄已在手、任务可能仍在跑）
   * 不属此列 ⇒ 禁止重发 prompt（见 executeDispatch 边界注释）。
   */
  private isSendPhaseConnectFailure(
    entry: InFlightEntry,
    trace: DispatchTrace,
    errText: string,
  ): boolean {
    return (
      entry.a2aTaskId === null && trace.stage === "send" && isConnectionLevelFailure(errText)
    );
  }

  /**
   * 重发留痕：把 `attempts` 并入 `diagnostics`（成功结果原本可能无 diagnostics ⇒ 以 launcher
   * 自测的 `elapsedMs` / `stage` 造一份最小诊断）。**不落库**、不改结果其它字段。
   */
  private withResendAttempts(
    result: RunnerTaskResult,
    trace: DispatchTrace,
    attempts: number,
  ): RunnerTaskResult {
    const base: RunnerTaskDiagnostics = result.diagnostics ?? {
      elapsedMs: Math.max(0, this.now().getTime() - trace.startedAtMs),
      stage: trace.stage,
    };
    return { ...result, diagnostics: { ...base, attempts } };
  }

  /**
   * 本次派发的等待预算：显式覆盖 > 按项目派生（`agentConfig.sessionTimeoutMs` + 余量）。
   * `getProject` 抛错（未知项目）不在此兜 —— 冒到 `executeDispatch` 的 catch，
   * 归 `stage="ensure"` 的 infra 失败。
   */
  private budgetFor(projectId: string): number {
    if (this.dispatchTimeoutOverride !== undefined) return this.dispatchTimeoutOverride;
    return dispatchBudgetMs(resolveSessionTimeoutMs(this.host.getProject(projectId).agentConfig));
  }

  /** 发送 message/send（blocking=false）并轮询 tasks/get 至终态 / 超时 */
  private async sendAndWait(
    endpoint: string,
    command: DispatchCommand,
    entry: InFlightEntry,
    deadline: number,
    trace: DispatchTrace,
  ): Promise<{ settled: unknown; timedOut: boolean }> {
    const remaining = (): number => deadline - this.now().getTime();
    trace.stage = "send";
    const settledSend = await postJsonRpc(
      endpoint,
      "message/send",
      {
        message: {
          role: "user",
          parts: [{ kind: "text", text: payloadText(command.payload) }],
          messageId: randomUUID(),
          contextId: command.contextId,
        },
        configuration: { blocking: false },
      },
      remaining(),
      this.fetchFn,
    );

    const view = taskViewOf(settledSend);
    if (view.id === null) {
      // Message 直返路径：无任务句柄，视为已完成
      return { settled: settledSend, timedOut: false };
    }
    entry.a2aTaskId = view.id;

    let settled: unknown = settledSend;
    while (remaining() > 0) {
      const state = taskViewOf(settled).state;
      if (A2A_TERMINAL_STATES.has(state)) return { settled, timedOut: false };
      trace.stage = "poll";
      await this.sleepFn(Math.min(this.pollIntervalMs, Math.max(1, remaining())));
      if (remaining() <= 0) break;
      settled = await postJsonRpc(
        endpoint,
        "tasks/get",
        { id: view.id },
        remaining(),
        this.fetchFn,
      );
    }
    trace.stage = "wait";
    return { settled, timedOut: true };
  }

  /**
   * 组装回传结果：任务态如实映射 + 文本（无结果文本时回落到 status.message）+ artifacts，
   * 并**先摘除**桥的 `machine-diagnostics` artifact（v0.8.7 · M3）—— 摘除发生在取文本**之前**，
   * 否则诊断 JSON 会经 `resultText`（message + artifacts 拼接）混进结果文本。
   */
  private buildResult(
    command: DispatchCommand,
    settled: unknown,
    timedOut: boolean,
    trace: DispatchTrace,
  ): RunnerTaskResult {
    const split = splitDiagnosticsArtifact(artifactsOf(settled));
    const bridge = split.diagnostics;
    const body =
      bridge === null || typeof settled !== "object" || settled === null
        ? settled
        : { ...(settled as Record<string, unknown>), artifacts: split.artifacts };
    const view: A2ATaskView = taskViewOf(body);
    const state = mapTaskState(view.state, timedOut);
    const text = view.text.length > 0 ? view.text : view.statusText;
    const kind = classifyFailure({
      timedOut,
      state,
      threwInEnsure: false,
      ...(bridge?.acpErrorKind !== undefined ? { acpErrorKind: bridge.acpErrorKind } : {}),
    });
    const diagnostics = this.diagnosticsOf(state, trace, bridge);
    return {
      taskId: command.taskId,
      machineId: this.machineId,
      projectId: command.projectId,
      contextId: command.contextId,
      state,
      ...(kind !== null ? { failureKind: kind } : {}),
      ...(diagnostics !== null ? { diagnostics } : {}),
      text: timedOut && text.length === 0 ? "任务超时（Runner 等待超时）" : text,
      artifacts: split.artifacts,
      finishedAt: this.isoNow(),
    };
  }

  /** 抛错路径的结果（ensure / transport 抛）：失败必带 diagnostics，归因看落点阶段 */
  private buildThrowResult(
    command: DispatchCommand,
    trace: DispatchTrace,
    text: string,
  ): RunnerTaskResult {
    const kind = classifyFailure({
      timedOut: false,
      state: "failed",
      threwInEnsure: trace.stage === "ensure",
      threwInTransport: trace.stage !== "ensure",
    });
    const diagnostics = this.diagnosticsOf("failed", trace, null);
    return {
      taskId: command.taskId,
      machineId: this.machineId,
      projectId: command.projectId,
      contextId: command.contextId,
      state: "failed",
      ...(kind !== null ? { failureKind: kind } : {}),
      ...(diagnostics !== null ? { diagnostics } : {}),
      text,
      artifacts: [],
      finishedAt: this.isoNow(),
    };
  }

  /**
   * diagnostics 组装：失败态**必带**（归因要用），成功态仅当桥上带了才带
   * （摘除后不丢信息）；`elapsedMs` / `stage` 一律取 launcher 自测值。
   */
  private diagnosticsOf(
    state: RunnerTaskState,
    trace: DispatchTrace,
    bridge: BridgeDiagnostics | null,
  ): RunnerTaskDiagnostics | null {
    if (state === "completed" && bridge === null) return null;
    return {
      elapsedMs: Math.max(0, this.now().getTime() - trace.startedAtMs),
      stage: trace.stage,
      ...(bridge?.acpErrorKind !== undefined ? { acpErrorKind: bridge.acpErrorKind } : {}),
      ...(bridge?.chunkCount !== undefined ? { chunkCount: bridge.chunkCount } : {}),
    };
  }

  /** stop：本机有在飞 ⇒ 拒收；否则停项目 → ack */
  private async handleStop(command: StopCommand): Promise<RunnerCommandAck> {
    if (this.ledger.size > 0) {
      this.logger.warn(
        `[runner] stop 拒收（in-flight=${this.ledger.size}）：project=${command.projectId}`,
      );
      return { commandId: command.commandId, error: "in-flight" };
    }
    try {
      await this.host.stop(command.projectId);
      return { commandId: command.commandId };
    } catch (err) {
      return { commandId: command.commandId, error: errorMessage(err) };
    }
  }

  /** cancel-task：台账无此 taskId ⇒ unknown-task；否则本地 A2A tasks/cancel */
  private async handleCancel(command: CancelTaskCommand): Promise<RunnerCommandAck> {
    const projectId = this.ledger.projectOf(command.taskId);
    if (projectId === null) {
      this.logger.warn(`[runner] cancel-task 未知任务：taskId=${command.taskId}`);
      return { commandId: command.commandId, error: "unknown-task" };
    }
    const entry = this.ledger.get(command.taskId);
    const a2aTaskId = entry?.a2aTaskId ?? null;
    if (a2aTaskId === null) {
      // 已登记但本地 A2A 任务句柄尚未取得（send 未返回）：无法定位取消目标
      return { commandId: command.commandId, error: "not-started" };
    }
    try {
      const project = this.host.getProject(projectId);
      await postJsonRpc(
        agentEndpoint(project.a2aPort),
        "tasks/cancel",
        { id: a2aTaskId },
        CANCEL_TIMEOUT_MS,
        this.fetchFn,
      );
      return { commandId: command.commandId };
    } catch (err) {
      // wrapper 不响应 / 拒绝：只回执失败，**不动台账** —— 任务按其自身节奏走向终态
      this.logger.warn(
        `[runner] cancel-task 失败（taskId=${command.taskId}）：${errorMessage(err)}`,
      );
      return { commandId: command.commandId, error: errorMessage(err) };
    }
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

/** 未注入真实 outbox 时的 stub：只记日志，不落盘、不发起网络（生产由 `FileOutbox` 接驳） */
export function createLoggingOutbox(logger: RunnerLogger = defaultLogger): RunnerOutbox {
  return {
    deliver: (result) => {
      logger.info(
        `[runner] outbox stub（待 M4 落盘回传）：taskId=${result.taskId} state=${result.state} artifacts=${result.artifacts.length}`,
      );
    },
  };
}
