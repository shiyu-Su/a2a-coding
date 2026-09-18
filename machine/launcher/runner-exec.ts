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
 * 边界（本节点显式不做）：不改 adapter / wrapper；不退役入站端点（M5）。
 */
import { randomUUID } from "node:crypto";
import type { ProjectConfig } from "../types.js";
import {
  A2A_TERMINAL_STATES,
  postJsonRpc,
  taskViewOf,
  type A2AFetch,
  type A2ATaskView,
} from "./a2a-client.js";
import { agentEndpoint } from "./manager.js";
import { errorMessage } from "./process.js";
import type { InFlightEntry, InFlightLedger, RunnerLogger } from "./runner.js";

/** 单任务派发等待上限（缺省 11 分钟，略大于三端包装器缺省 prompt 超时 600s，保证能看到终态） */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 660_000;

/** 任务态轮询间隔 */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** `tasks/cancel` 短请求超时（取消是控制面动作，不应拖长轮询预算） */
export const CANCEL_TIMEOUT_MS = 10_000;

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

/** 任务结果（M4 落盘 `.a2a/outbox/<taskId>.json` 的载荷形状） */
export interface RunnerTaskResult {
  taskId: string;
  machineId: string;
  projectId: string;
  contextId: string;
  state: RunnerTaskState;
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
  private readonly dispatchTimeoutMs: number;
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
    this.dispatchTimeoutMs = deps.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
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

  /** 派发全流程：ensure → message/send → 轮询终态 → 组装结果 → outbox */
  private async executeDispatch(command: DispatchCommand, entry: InFlightEntry): Promise<void> {
    const deadline = Date.now() + this.dispatchTimeoutMs;
    let result: RunnerTaskResult;
    try {
      const ensured = await this.host.ensure(command.projectId);
      const settled = await this.sendAndWait(ensured.endpoint, command, entry, deadline);
      result = this.buildResult(command, settled.settled, settled.timedOut);
    } catch (err) {
      result = {
        taskId: command.taskId,
        machineId: this.machineId,
        projectId: command.projectId,
        contextId: command.contextId,
        state: "failed",
        text: errorMessage(err),
        artifacts: [],
        finishedAt: this.isoNow(),
      };
    } finally {
      this.ledger.remove(command.taskId);
    }
    this.logger.info(
      `[runner] 任务结束：taskId=${result.taskId} project=${result.projectId} state=${result.state}（交 outbox）`,
    );
    const credential: RunnerResultCredential | undefined =
      command.claimToken !== undefined && command.claimToken.length > 0
        ? { claimToken: command.claimToken }
        : undefined;
    await this.outbox.deliver(result, credential);
  }

  /** 发送 message/send（blocking=false）并轮询 tasks/get 至终态 / 超时 */
  private async sendAndWait(
    endpoint: string,
    command: DispatchCommand,
    entry: InFlightEntry,
    deadline: number,
  ): Promise<{ settled: unknown; timedOut: boolean }> {
    const remaining = (): number => deadline - Date.now();
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
    return { settled, timedOut: true };
  }

  /** 组装回传结果：任务态如实映射 + 文本（无结果文本时回落到 status.message）+ artifacts */
  private buildResult(
    command: DispatchCommand,
    settled: unknown,
    timedOut: boolean,
  ): RunnerTaskResult {
    const view: A2ATaskView = taskViewOf(settled);
    const text = view.text.length > 0 ? view.text : view.statusText;
    return {
      taskId: command.taskId,
      machineId: this.machineId,
      projectId: command.projectId,
      contextId: command.contextId,
      state: mapTaskState(view.state, timedOut),
      text: timedOut && text.length === 0 ? "任务超时（Runner 等待超时）" : text,
      artifacts: view.artifacts,
      finishedAt: this.isoNow(),
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
