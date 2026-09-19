/**
 * ACP 会话生命周期 + B1 执行器桥接（REQ-v0.8.0-2026-09-19-01 · 节点 B3）。
 *
 * 语义（依 P1 探针实测方言）：
 * - 会话保证：`session/load` → 失败回退 `session/resume` → 再失败 `session/new`；成功映射落 `SessionMap`；
 * - `session/prompt` params `{ sessionId, prompt:[{type:"text",text}] }`（文本前置 outcome 约定）；
 * - 流式累积：`session/update` 通知中 `update.sessionUpdate === "agent_message_chunk"` 的
 *   `update.content.text` 逐 chunk 拼接为最终回复（`agent_thought_chunk` 忽略）；
 * - 终态：`stopReason:"cancelled"` → `canceled`；否则按 `parseOutcome` 映射 completed/input-required/failed；
 *   超时 → `failed`（对齐 600s 惯例，可配置）。
 *
 * 依赖可注入（`client` 经构造注入，fake 单测）；不 import `orch/**` / `launcher/**`。
 */
import { AcpError } from "./client.js";
import type { TaskExecutionInput, TaskExecutionResult } from "../types.js";
import { parseOutcome, withOutcomeConvention } from "../outcome.js";
import type { SessionMap } from "../session-map.js";

/** 单次 `session/prompt` 超时（对齐三端 prompt 600s 惯例；可配置）。 */
export const DEFAULT_SESSION_TIMEOUT_MS = 600_000;
/** Runner 派发侧任务超时预算（对齐 launcher `runner-exec` 660s；本桥不自持，仅常量登记）。 */
export const DEFAULT_TASK_TIMEOUT_MS = 660_000;

/** 会话客户端最小面（`AcpClient` 结构满足；便于 fake 注入）。 */
export interface AcpRequestClient {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
}

export interface AcpSessionRunnerOptions {
  client: AcpRequestClient;
  /** ACP 会话工作目录（项目 workspace） */
  cwd: string;
  /** contextId ↔ sessionId 映射（缺省不持久化，每次 `session/new`） */
  sessions?: SessionMap;
  timeoutMs?: number;
  mcpServers?: readonly unknown[];
  logger?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 会话执行器：实现 B1 的 `TaskExecutor` 语义（execute / cancel）。
 * 任务执行 = 保证会话（load|resume|new）→ prompt（注入 outcome 约定）→ 累积至终态 → 文本。
 */
export class AcpSessionRunner {
  private readonly client: AcpRequestClient;
  private readonly cwd: string;
  private readonly sessions: SessionMap | null;
  private readonly timeoutMs: number;
  private readonly mcpServers: readonly unknown[];
  private readonly logger: (message: string) => void;
  /** sessionId → 已累积的 agent message chunks */
  private readonly buffers = new Map<string, string[]>();
  /** taskId → sessionId（供 cancel 定位） */
  private readonly taskSessions = new Map<string, string>();

  constructor(options: AcpSessionRunnerOptions) {
    this.client = options.client;
    this.cwd = options.cwd;
    this.sessions = options.sessions ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.mcpServers = options.mcpServers ?? [];
    this.logger = options.logger ?? ((): void => undefined);
    this.client.onNotification((method, params) => this.onNotification(method, params));
  }

  /** 执行一个任务（B1 `TaskExecutor.execute` 语义）。 */
  async execute(input: TaskExecutionInput): Promise<TaskExecutionResult> {
    let sessionId: string;
    try {
      sessionId = await this.ensureSession(input.contextId);
    } catch (err) {
      return { state: "failed", text: `会话建立失败：${messageOf(err)}` };
    }
    this.buffers.set(sessionId, []);
    this.taskSessions.set(input.taskId, sessionId);

    let promptResult: unknown;
    try {
      promptResult = await this.requestWithTimeout("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: withOutcomeConvention(input.text) }],
      });
    } catch (err) {
      return this.failureResult(err);
    }

    const text = this.takeText(sessionId);
    const stopReason =
      isRecord(promptResult) && typeof promptResult["stopReason"] === "string"
        ? promptResult["stopReason"]
        : "";
    if (stopReason === "cancelled" || stopReason === "canceled") {
      return { state: "canceled", text };
    }

    const outcome = parseOutcome(text);
    if (outcome.state === "input-required") {
      return { state: "input-required", text: outcome.text.length > 0 ? outcome.text : (outcome.question ?? "") };
    }
    if (outcome.state === "failed") {
      return { state: "failed", text: outcome.text.length > 0 ? outcome.text : (outcome.reason ?? "任务失败") };
    }
    return { state: "completed", text: outcome.text };
  }

  /** 取消：尽力通知后端 `session/cancel`（B1 `TaskExecutor.cancel` 语义）。 */
  async cancel(taskId: string): Promise<void> {
    const sessionId = this.taskSessions.get(taskId);
    if (sessionId === undefined) return;
    try {
      await this.client.request("session/cancel", { sessionId }, 10_000);
    } catch (err) {
      this.logger(`[acp-session] session/cancel 失败（忽略）：${messageOf(err)}`);
    }
  }

  private failureResult(err: unknown): TaskExecutionResult {
    if (err instanceof AcpError && err.kind === "timeout") {
      return { state: "failed", text: `任务超时（ACP session/prompt 超过 ${String(this.timeoutMs)}ms）` };
    }
    return { state: "failed", text: messageOf(err) };
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update" || !isRecord(params)) return;
    const sessionId = params["sessionId"];
    const update = params["update"];
    if (typeof sessionId !== "string" || !isRecord(update)) return;
    // P1 探针：仅 agent_message_chunk 计入回复（agent_thought_chunk 为思考，忽略）
    if (update["sessionUpdate"] !== "agent_message_chunk") return;
    const content = update["content"];
    if (!isRecord(content)) return;
    const text = content["text"];
    if (typeof text !== "string") return;
    const buffer = this.buffers.get(sessionId);
    if (buffer !== undefined) buffer.push(text);
  }

  private takeText(sessionId: string): string {
    const chunks = this.buffers.get(sessionId);
    this.buffers.delete(sessionId);
    return chunks === undefined ? "" : chunks.join("");
  }

  private async ensureSession(contextId: string): Promise<string> {
    const cached = this.sessions?.get(contextId) ?? null;
    if (cached !== null) {
      if (await this.tryReuse("session/load", cached)) return cached;
      if (await this.tryReuse("session/resume", cached)) return cached;
    }
    const sessionId = await this.newSession();
    this.sessions?.set(contextId, sessionId);
    return sessionId;
  }

  private async tryReuse(method: string, sessionId: string): Promise<boolean> {
    const params =
      method === "session/load"
        ? { sessionId, cwd: this.cwd, mcpServers: [...this.mcpServers] }
        : { sessionId };
    try {
      await this.requestWithTimeout(method, params);
      return true;
    } catch (err) {
      this.logger(`[acp-session] ${method} 失败（回退下一策略）：${messageOf(err)}`);
      return false;
    }
  }

  private async newSession(): Promise<string> {
    const result = await this.requestWithTimeout("session/new", {
      cwd: this.cwd,
      mcpServers: [...this.mcpServers],
    });
    if (!isRecord(result) || typeof result["sessionId"] !== "string" || result["sessionId"].length === 0) {
      throw new AcpError("protocol", "session/new 响应缺少 sessionId");
    }
    return result["sessionId"];
  }

  /** 带**自身**超时的请求（不依赖客户端实现，便于 fake 注入与超时单测）。 */
  private async requestWithTimeout(method: string, params: unknown): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new AcpError("timeout", `ACP 请求超时：${method}（${String(this.timeoutMs)}ms）`));
      }, this.timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.client.request(method, params, this.timeoutMs), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
