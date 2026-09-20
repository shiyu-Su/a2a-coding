/**
 * ACP 会话生命周期 + B1 执行器桥接（REQ-v0.8.0-2026-09-19-01 · 节点 B3）。
 *
 * 语义（依 P1 探针实测方言）：
 * - 会话保证：`session/load` → 失败回退 `session/resume` → 再失败 `session/new`；成功映射落 `SessionMap`；
 * - `session/prompt` params `{ sessionId, prompt:[{type:"text",text}] }`；
 *   **注入 = 每 session 首轮 prompt 前缀**（v0.8.1 · M2）：内容 = 缺省 a2a-outcome 约定
 *   + config 段 `systemPrompt`（append=追加缺省之后 / replace=替换缺省；无 config 仅约定）；
 *   次轮及以后不注入；`prompted` 在收到 prompt 响应后置位（load/resume 跨进程不重注入）；
 * - 流式累积：`session/update` 通知中 `update.sessionUpdate === "agent_message_chunk"` 的
 *   `update.content.text` 逐 chunk 拼接为最终回复（`agent_thought_chunk` 忽略）；
 *   **轮边界双判据（v0.8.1 · M9 + M9-b/M9-c）**：
 *   ① 捕获窗（M9）：缓冲清空与开窗推迟到 `session/prompt` 写出之前，窗外到达的重放一律丢弃；
 *   ② 重放 id 集合（M9-c，普适于多后端）：`session/load|resume` 期间（窗内 prompt 写出前）
 *      到达的每个带 `update.messageId` chunk，其 id 记入 `replayMessageIds`；窗内 chunk
 *      无 messageId ⇒ 保留（`qoderclicn` 实时形态：活 chunk 恒不带 id）；带 id 且 **∈ 集合**
 *      ⇒ 丢弃（历史消息重放的尾部与本窗毫秒级交叠）；带 id 且 **∉ 集合** ⇒ 保留
 *      （opencode 实时形态：活 chunk 带本轮新 id，首见即活）；
 *   修复跨轮污染致续派永久判 input-required 的死循环；
 *   （M9-b 原判据「窗内带 id 一律丢弃」经真机自检证伪为 `qoderclicn` 专属方言 ——
 *    opencode 实时 chunk 本就带 messageId，会被整轮误丢致响应为空，故 M9-c 收窄为集合判定。）
 * - 终态：`stopReason:"cancelled"` → `canceled`；否则按 `parseOutcome` 映射 completed/input-required/failed；
 *   超时 → `failed`（对齐 600s 惯例，可配置）。
 *
 * 依赖可注入（`client` 经构造注入，fake 单测）；不 import `orch/**` / `launcher/**`。
 */
import { AcpError } from "./client.js";
import type { TaskExecutionInput, TaskExecutionResult } from "../types.js";
import { parseOutcome } from "../outcome.js";
import { A2A_OUTCOME_CONVENTION } from "../outcome.js";
import type { SessionMap } from "../session-map.js";

/** 单次 `session/prompt` 超时（对齐三端 prompt 600s 惯例；可配置）。 */
export const DEFAULT_SESSION_TIMEOUT_MS = 600_000;
/** Runner 派发侧任务超时预算（对齐 launcher `runner-exec` 660s；本桥不自持，仅常量登记）。 */
export const DEFAULT_TASK_TIMEOUT_MS = 660_000;

/** 会话客户端最小面（`AcpClient` 结构满足；便于 fake 注入）。 */
export interface AcpRequestClient {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
}

/**
 * 首轮注入的 config 段来源（`--config-file` 指定段，v0.8.1 · M2 消费）。
 * 键形状与 `opencode.{systemPrompt, systemPromptMode}` 配置契约一致。
 */
export interface AcpInjectionConfig {
  /** 段内自定义注入文本（缺省 ⇒ 仅缺省 outcome 约定） */
  systemPrompt?: string;
  /** `append`（缺省）= 追加在缺省约定之后；`replace` = 替换缺省约定 */
  systemPromptMode?: "append" | "replace";
}

export interface AcpSessionRunnerOptions {
  client: AcpRequestClient;
  /** ACP 会话工作目录（项目 workspace） */
  cwd: string;
  /** contextId ↔ sessionId 映射（缺省不持久化，每次 `session/new`） */
  sessions?: SessionMap;
  timeoutMs?: number;
  mcpServers?: readonly unknown[];
  /** 首轮注入的 config 段（缺省 = 无 config，仅缺省约定注入） */
  injection?: AcpInjectionConfig;
  logger?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * chunk 的 `messageId`（M9-c 轮边界输入；无 / 空串 ⇒ `undefined`）。
 * 双方对方言（依双后端真机取证）：
 * - `qoderclicn` v1.1.57（M9-b 探针，仓外 %TEMP%/acp-m9b-probe）：实时 chunk 恒**不带**
 *   messageId（`update` 键集合 = `sessionUpdate` + `content`），只有 `session/load` 回灌的
 *   历史重放逐条带 id（每条历史消息一个 id，从不出现在本轮 prompt 响应里）；
 * - opencode：实时 chunk **本就带** messageId（本轮新消息的 id，首见于本窗）。
 * 故「有无 id」单独不可作判据，必须配合「该 id 是否在捕获窗外已出现过」。
 * 残余边界：某后端重放时若复用与本轮活 chunk 相同的 id，且该 id 曾在窗外出现 ⇒ 会误伤；
 * ACP 语义下 messageId 每消息唯一，可接受。
 */
function messageIdOf(update: Record<string, unknown>): string | undefined {
  const id = update["messageId"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
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
  private readonly injection: AcpInjectionConfig;
  private readonly logger: (message: string) => void;
  /** sessionId → 已累积的 agent message chunks */
  private readonly buffers = new Map<string, string[]>();
  /**
   * 本轮捕获窗（sessionId 集合）：仅 `session/prompt` 写出前置入、`takeText`/失败路径移除。
   * 窗外到达的 agent_message_chunk（load/resume 回灌 backlog）不入本轮缓冲。
   */
  private readonly capturing = new Set<string>();
  /** sessionId → 窗内被 messageId 轮边界判据丢弃的历史重放 chunk 数（收窗时一行日志，供真机取证） */
  private readonly replayDropped = new Map<string, number>();
  /**
   * sessionId → 重放 messageId 集合（M9-c）：捕获窗外（`session/load|resume` 回灌期）出现过的
   * 每个 messageId。窗内 chunk 的 id 命中本集合 ⇒ 判为历史重放；未命中 ⇒ 判为本轮实时消息的新 id。
   * 随 `takeText`/失败路径一并清理，不跨轮泄漏。
   */
  private readonly replayMessageIds = new Map<string, Set<string>>();
  /** taskId → sessionId（供 cancel 定位） */
  private readonly taskSessions = new Map<string, string>();
  /**
   * 无 SessionMap 时的进程内首轮注入簿记（contextId → 已注入）。
   * 持久化路径经 `SessionMap.prompted`，不依赖本集合。
   */
  private readonly promptedInMemory = new Set<string>();

  constructor(options: AcpSessionRunnerOptions) {
    this.client = options.client;
    this.cwd = options.cwd;
    this.sessions = options.sessions ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.mcpServers = options.mcpServers ?? [];
    this.injection = options.injection ?? {};
    this.logger = options.logger ?? ((): void => undefined);
    this.client.onNotification((method, params) => this.onNotification(method, params));
  }

  /**
   * 首轮注入文本 = 缺省 a2a-outcome 约定 + config 段 `systemPrompt`
   * （`append` = 追加在缺省约定之后；`replace` = 替换缺省约定；无 config 时仅缺省约定）。
   */
  private buildInjection(): string {
    const custom = this.injection.systemPrompt;
    if (custom === undefined || custom.length === 0) return A2A_OUTCOME_CONVENTION;
    if (this.injection.systemPromptMode === "replace") return custom;
    return `${A2A_OUTCOME_CONVENTION}\n\n${custom}`;
  }

  /** 该 contextId 的会话是否处于首轮（需注入）。 */
  private isFirstTurn(contextId: string): boolean {
    if (this.sessions !== null) return !this.sessions.isPrompted(contextId);
    return !this.promptedInMemory.has(contextId);
  }

  /** 执行一个任务（B1 `TaskExecutor.execute` 语义）。 */
  async execute(input: TaskExecutionInput): Promise<TaskExecutionResult> {
    let sessionId: string;
    try {
      sessionId = await this.ensureSession(input.contextId);
    } catch (err) {
      return { state: "failed", text: `会话建立失败：${messageOf(err)}` };
    }
    this.taskSessions.set(input.taskId, sessionId);

    const firstTurn = this.isFirstTurn(input.contextId);
    const promptText = firstTurn
      ? `${this.buildInjection()}\n\n---\n\n${input.text}`
      : input.text;

    let promptResult: unknown;
    try {
      // M9 捕获窗：prompt 写出前才清缓冲并开窗（窗外 backlog 直接丢弃，但其 messageId 已登记）。
      // 探针实测回灌尾部与本窗开启毫秒级交叠 ⇒ 窗内另按 M9-c 重放 id 集合二次过滤。
      // 注意：不可在此清 replayMessageIds —— 其中的 id 正是本轮 ensureSession 的 load/resume 期登记的。
      this.buffers.set(sessionId, []);
      this.capturing.add(sessionId);
      promptResult = await this.requestWithTimeout("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: promptText }],
      });
    } catch (err) {
      this.discardCapture(sessionId);
      return this.failureResult(err);
    }
    // prompted 置位时机 = 收到响应即置（含 end_turn / input-required / cancelled）
    if (firstTurn) {
      if (this.sessions !== null) this.sessions.markPrompted(input.contextId);
      else this.promptedInMemory.add(input.contextId);
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
      return {
        state: "input-required",
        text: outcome.text.length > 0 ? outcome.text : (outcome.question ?? ""),
        ...(outcome.question !== undefined ? { question: outcome.question } : {}),
      };
    }
    if (outcome.state === "failed") {
      return {
        state: "failed",
        text: outcome.text.length > 0 ? outcome.text : (outcome.reason ?? "任务失败"),
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      };
    }
    return { state: "completed", text: outcome.text };
  }

  /** 取消：尽力通知后端 `session/cancel`（B1 `TaskExecutor.cancel` 语义；notification 形态，不等响应）。 */
  async cancel(taskId: string): Promise<void> {
    const sessionId = this.taskSessions.get(taskId);
    if (sessionId === undefined) return;
    try {
      this.client.notify("session/cancel", { sessionId });
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
    if (!this.capturing.has(sessionId)) {
      // 窗外 = load/resume 回灌 backlog，不入本轮缓冲；其 messageId 登记为重放 id（M9-c）
      const replayId = messageIdOf(update);
      if (replayId !== undefined) {
        let ids = this.replayMessageIds.get(sessionId);
        if (ids === undefined) {
          ids = new Set<string>();
          this.replayMessageIds.set(sessionId, ids);
        }
        ids.add(replayId);
      }
      return;
    }
    const id = messageIdOf(update);
    if (id !== undefined && this.replayMessageIds.get(sessionId)?.has(id) === true) {
      // M9-c 轮边界：该 id 在捕获窗外已出现过 = 历史消息重放的尾部，排除出本轮文本
      this.replayDropped.set(sessionId, (this.replayDropped.get(sessionId) ?? 0) + 1);
      return;
    }
    const buffer = this.buffers.get(sessionId);
    if (buffer !== undefined) buffer.push(text);
  }

  private takeText(sessionId: string): string {
    this.capturing.delete(sessionId);
    this.replayMessageIds.delete(sessionId);
    const dropped = this.replayDropped.get(sessionId);
    if (dropped !== undefined) {
      this.logger(
        `[acp-session] 本轮丢弃历史重放 chunk ${String(dropped)} 条（sessionId=${sessionId}）`,
      );
      this.replayDropped.delete(sessionId);
    }
    const chunks = this.buffers.get(sessionId);
    this.buffers.delete(sessionId);
    return chunks === undefined ? "" : chunks.join("");
  }

  /** prompt 失败/超时路径：关窗并弃置半截缓冲，避免残窗把下轮 backlog 收进来。 */
  private discardCapture(sessionId: string): void {
    this.capturing.delete(sessionId);
    this.buffers.delete(sessionId);
    this.replayDropped.delete(sessionId);
    this.replayMessageIds.delete(sessionId);
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
