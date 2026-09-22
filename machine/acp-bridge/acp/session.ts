/**
 * ACP 会话生命周期 + B1 执行器桥接（REQ-v0.8.0-2026-09-19-01 · 节点 B3）。
 *
 * 语义（依 P1 探针实测方言）：
 * - 会话保证：`session/load` → 失败回退 `session/resume` → 再失败 `session/new`；成功映射落 `SessionMap`；
 *   阶梯的**实际落点**经 `sessionResumed` 回标（v0.8.8 · M1，见下「失败诊断留痕」）；
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
 * **model 通路（v0.8.2 · M1 协议面增补，协议面 set）**：`model` 非空 ⇒ 每次会话建立（`session/new` 或
 * `session/load` / `session/resume` 复用）**成功后**、`session/prompt` 之前发一次
 * `session/set_config_option {sessionId, configId:"model", value:<原样>}`；恢复路径同样 set（不假设
 * 后端跨会话保持模型）。值**原样透传不校验**（双方言实测：opencode 与 qoder 同方言，qoder 须传
 * modelId 而非显示名）。`model` 未配 / 空串 / 非字符串 ⇒ **完全不调用**，行为与旧版逐字一致。
 * set 失败 ⇒ **fail-fast**（REQ-v0.8.2 M1 验证期裁决「配错就明确失败」）：记一条含配置原值与
 * 失败原因（message / code）的日志后**抛错**，会话建立失败、不继续 prompt、不回退后端默认；
 * 错误经 `execute` 的 `ensureSession` catch 冒泡为任务 `failed`。
 * 成功日志回显的 `currentValue` 从响应 `configOptions[]` 内 `id==="model"` 项取（顶层无该键），
 * 取不到 ⇒ 呈现 `n/a`（不打裸 `undefined`）。
 *
 * 依赖可注入（`client` 经构造注入，fake 单测）；不 import `orch/**` / `launcher/**`。
 *
 * **mode / collaboration_mode / session-meta 通路（v0.8.5 · M1）**：`mode` 非空 ⇒ 每次会话建立后发一次
 * `session/set_mode {sessionId, modeId}`（**仅**后端回 `-32601` 才回落
 * `session/set_config_option {configId:"mode"}`）；`collaboration_mode` 非空 ⇒ **只走**
 * `session/set_config_option {configId:"collaboration_mode"}`（它不在 `modes` 里）。两者与 `model` **同形**：
 * 缺省 / 空串 ⇒ **零请求**；失败 ⇒ **fail-fast**（日志 + 抛错，不静默回落）。`sessionMeta` 非空 ⇒
 * `session/new` / `load` / `resume` **三路统一携带 `_meta`**（否则复用会话拿不到 ⇒ full 档静默降级）。
 * 桥只收 adapter 的原样值，**不做 kind→mode 映射**。
 *
 * **失败诊断留痕（v0.8.7 · M4 → v0.8.8 · M1 扩）**：三处失败出口（① 会话建立失败 ② prompt 失败
 * ③ prompt 超时）各在 `TaskExecutionResult.artifacts` 追加一条 `name="machine-diagnostics"`（text = JSON）
 * ⇒ **零类型 / 零 wire 变更**；launcher `buildResult` 按名摘除 + 解析（见 {@link DIAGNOSTICS_ARTIFACT_NAME}）。
 *
 * 载荷键（v0.8.8 · M1 计量补全 + 取证面；改造文档 §2.5 / §2.3.1）：
 * - **恒定七键**：`acpErrorKind`（`AcpError["kind"]`，非结构化抛出归 `error`）· `stage`（`ensure` / `prompt`
 *   落点）· `promptElapsedMs`（**prompt 段**耗时，改名自 `elapsedMs`，避开与 launcher 侧同名异义的
 *   `elapsedMs`；① 未进入 prompt ⇒ 0）· `bridgeEnsureElapsedMs`（会话建立段耗时）· `chunkCount`（本轮
 *   入缓冲 `agent_message_chunk` 数）· `partialChars`（本轮累计字符数，「确有产出」主判据原料）·
 *   `updateCount`（本轮**任意** `session/update` 计数，含 thought / tool_call = 「有推进」原料）；
 * - **条件五键**（事实缺失即**不报该键**，不编造 0 / false）：`firstChunkElapsedMs`（首 chunk 距开窗；
 *   无 chunk ⇒ 缺键，「满窗零产出」的证据）· `sessionResumed`（`load → resume → new` 阶梯实际是否续接
 *   成功；`false` = **续跑退化成重跑**，本机制最大隐性风险，必须上报）· `acpErrorCode` / `acpErrorData`
 *   （后端错误对象的 `code` 与 `data` **宽 JSON 原文** —— opencode 把细节只写进 `data`，丢掉它等于把
 *   错误压成「Invalid params」四个字）· `partialTail` / `partialTailChars`（半截产出**取出再弃**前先快照、
 *   截断至 {@link DIAGNOSTICS_PARTIAL_TAIL_MAX_CHARS} 经本通道带回 launcher —— 进程会被杀，桥内存态必失效）。
 *
 * ⚠ launcher 侧 `parseBridgeDiagnostics` 是**逐键白名单**：未放行的键会被**静默忽略**（改造文档 §2.5
 * 「只加键不 breaking」）。M1 计量键与取证键的放行已由 M2 同步，契约由 `test/acp-session.test.ts`
 * 的「M4 契约 / M1↔M2 契约」两例锚住（白名单再收窄时该二例失败）。正常完成路径不带该 artifact。
 */
import { AcpError, wideJson } from "./client.js";
import { buildArtifacts } from "../artifacts.js";
import type { TaskExecutionInput, TaskExecutionResult } from "../types.js";
import { parseOutcome } from "../outcome.js";
import { A2A_OUTCOME_CONVENTION } from "../outcome.js";
import type { SessionMap } from "../session-map.js";

/** 单次 `session/prompt` 超时（对齐三端 prompt 600s 惯例；可配置）。 */
export const DEFAULT_SESSION_TIMEOUT_MS = 600_000;
/** Runner 派发侧任务超时预算（对齐 launcher `runner-exec` 660s；本桥不自持，仅常量登记）。 */
export const DEFAULT_TASK_TIMEOUT_MS = 660_000;

/**
 * 失败诊断留痕 artifact 名（v0.8.7 · M4）。消费方 = `launcher/runner-exec.ts` 的
 * `DIAGNOSTICS_ARTIFACT_NAME`（deliver 前摘除 + 解析）—— 两侧同名是**线上传契约**，
 * 由 `test/acp-session.test.ts` 断言二者字面量一致。
 */
export const DIAGNOSTICS_ARTIFACT_NAME = "machine-diagnostics";

/**
 * 半截产出随 diagnostics 带回 launcher 的尾部上限（字符）。**护的是 `/runner/result` 的 1 MiB
 * 请求体上限**（UTF-8 最坏 4 字节/字符 ⇒ 4k 字符 ≤ 16 KB）；与 launcher 侧续跑判据的
 * `CONTINUE_TAIL_MAX_CHARS`（M2）取同一数值，桥先截 ⇒ 桥是唯一持有该文本的地方。
 */
export const DIAGNOSTICS_PARTIAL_TAIL_MAX_CHARS = 4_000;

/** diagnostics 载荷里 `acpErrorData` 宽 JSON 原文的上限（字符）。 */
const DIAGNOSTICS_DATA_MAX_CHARS = 2_000;

/** 人读文本（结果文本 / 日志）里的 `data` 摘要上限（字符）—— 比诊断载荷短，避免文本被淹。 */
const REASON_DATA_MAX_CHARS = 300;

/** 诊断落点（v0.8.7 · M4）：桥内两处失败出口的阶段标识。 */
type BridgeDiagStage = "ensure" | "prompt";

/**
 * `withDiag` 的入参（v0.8.8 · M1）：三项计数与两段耗时**恒报**（无事实即 0，含义明确）；
 * 可选键（`firstChunkElapsedMs` / `sessionResumed` / `partialTail`）**事实缺失 ⇒ 不报**
 * （0 / false 与「没发生」是两回事，下游判据靠前者会误判）；`acpErrorCode` / `acpErrorData`
 * 由 `err` 派生，同样「无即不报」。
 */
interface BridgeDiag {
  err: unknown;
  stage: BridgeDiagStage;
  promptElapsedMs: number;
  bridgeEnsureElapsedMs: number;
  chunkCount: number;
  partialChars: number;
  updateCount: number;
  firstChunkElapsedMs?: number;
  sessionResumed?: boolean;
  partialTail?: string;
}

/**
 * 本轮捕获窗（v0.8.8 · M1）：把此前分散在 `buffers` / `capturing` / `captureOpenedAt` /
 * `replayDropped` 四张并行 map 里的**同一份本轮状态**收成一处，避免跨表漂移与计量口径不一致。
 * 生命周期 = `session/prompt` 写出前置入（M9 捕获窗）、`takeText` / `discardCapture` 移除。
 */
interface CaptureWindow {
  /** 本轮保留的 `agent_message_chunk` 文本（历史重放已在入缓冲前排除） */
  readonly chunks: string[];
  /** 开窗时刻（ms）—— `promptElapsedMs` / `firstChunkElapsedMs` 的锚点 */
  readonly openedAt: number;
  /** 首个入缓冲的 chunk 时刻（ms）；**缺 = 本轮一个 message chunk 都没来过**（「满窗零产出」的证据） */
  firstChunkAt?: number;
  /** 本轮入缓冲 chunk 的累计字符数（「确有产出」主判据原料） */
  partialChars: number;
  /** 本轮**任意** `session/update` 计数（含 thought / tool_call = 「有推进」原料） */
  updateCount: number;
  /** 窗内被 messageId 轮边界判据丢弃的历史重放 chunk 数（收窗时一行日志，供真机取证） */
  replayDropped: number;
}

/** 会话建立结果（v0.8.8 · M1 回标：`load → resume → new` 阶梯的实际落点）。 */
interface EstablishedSession {
  sessionId: string;
  /** `load` / `resume` 任一真成功 = true；回落 `session/new` ⇒ false（**续跑退化成重跑**，必须上报） */
  sessionResumed: boolean;
}

/** 会话客户端最小面（`AcpClient` 结构满足；便于 fake 注入）。 */
export interface AcpRequestClient {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
}

/**
 * 首轮注入来源（v0.8.5 · M4：`--config-file` 段通道退役后 = 桥 flag `--system-prompt`
 * / `--system-prompt-mode` 的解析结果；键形状保持 `systemPrompt` / `systemPromptMode`）。
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
  /**
   * ACP 模型标识（平铺 `agentConfig.model` 原样透传值）；非空 ⇒ 会话建立成功后发一次
   * `session/set_config_option {configId:"model"}`（new / load / resume 三路同此）。缺省 ⇒ 完全不调用。
   */
  model?: string;
  /**
   * ACP 会话模式标识（v0.8.5 · M1；adapter 按 `risk` 映射后的**原样值**，桥不做 kind→mode 映射）。
   * 非空 ⇒ 会话建立成功后发一次（优先 `session/set_mode`，仅 `-32601` 回落
   * `session/set_config_option {configId:"mode"}`）；缺省 / 空串 ⇒ **完全不调用**。
   */
  mode?: string;
  /**
   * ACP `collaboration_mode` 取值（v0.8.5 · M1；原样、不校验）。非空 ⇒ 会话建立成功后发一次
   * `session/set_config_option {configId:"collaboration_mode"}`；缺省 / 空串 ⇒ **完全不调用**。
   */
  collaborationMode?: string;
  /**
   * 会话建立期 `_meta` 注入（v0.8.5 · M1）：`session/new` / `load` / `resume` **三路统一携带**；
   * 缺省 ⇒ 三路均不带该键。
   */
  sessionMeta?: Record<string, unknown>;
  logger?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 后端错误对象的 `code`（非 `AcpError` / 无 code ⇒ `undefined`，**不编造**）。 */
function errorCodeOf(err: unknown): number | undefined {
  return err instanceof AcpError && err.code !== undefined ? err.code : undefined;
}

/**
 * 后端错误对象的 `data` 宽 JSON 原文（截断到 `maxChars`；无 `data` ⇒ `undefined`，**不编造**）。
 * **方言不对称**（双样本取证）：opencode 把细节只写进 `data`、qoder-cn 写进 `message`
 * ⇒ 两侧都得留（改造文档 §2.5 第 12 键）。
 */
function errorDataOf(err: unknown, maxChars: number): string | undefined {
  const data = err instanceof AcpError ? err.data : undefined;
  return data === undefined ? undefined : wideJson(data, maxChars);
}

/**
 * 失败原因串 = `message` + `（code=…）` + `〔data=…〕`（v0.8.8 · M1 取证面）。
 * 三处消费：`applyModel` / `applyMode` / `applyCollaborationMode` 的 fail-fast 文本、
 * `failureResult` 的结果文本、会话建立失败的结果文本 —— 此前 `failureResult` 连 `code` 都不拼，
 * 是「配额 / 限流到底有没有报错」这个问题答不上来的直接原因。
 */
function reasonOf(err: unknown): string {
  const code = errorCodeOf(err);
  const data = errorDataOf(err, REASON_DATA_MAX_CHARS);
  return `${messageOf(err)}${code === undefined ? "" : `（code=${String(code)}）`}${
    data === undefined ? "" : `〔data=${data}〕`
  }`;
}

/** 后端未实现该方法（JSON-RPC `-32601` Method not found）—— **仅此错误**允许回落。 */
function isMethodNotFound(err: unknown): boolean {
  return err instanceof AcpError && err.code === -32601;
}

/** 诊断用错误类别（v0.8.7 · M4）：结构化 `AcpError` 取其 `kind`；裸 Error / 未知抛出归 `error`。 */
function errorKindOf(err: unknown): string {
  return err instanceof AcpError ? err.kind : "error";
}

/**
 * `session/set_config_option` 响应的真值取位（F-a）：双方言实测顶层**无** `currentValue` 键，
 * 生效值嵌在 `result.configOptions[]` 内 `id === configId` 项的 `currentValue`。取不到 ⇒ undefined。
 */
function configCurrentValue(result: unknown, configId: string): unknown {
  if (!isRecord(result)) return undefined;
  const options = result["configOptions"];
  if (!Array.isArray(options)) return undefined;
  const entry = options.find((item) => isRecord(item) && item["id"] === configId);
  return isRecord(entry) ? entry["currentValue"] : undefined;
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
  /** 归一化后的 model：非空字符串才保留（空串 / 非字符串 ⇒ `undefined` ⇒ 永不 set） */
  private readonly model: string | undefined;
  /** 归一化后的 mode：非空字符串才保留（空串 / 非字符串 ⇒ `undefined` ⇒ 永不下发）。 */
  private readonly mode: string | undefined;
  /** 归一化后的 collaboration_mode：同 mode。 */
  private readonly collaborationMode: string | undefined;
  /** 会话建立期 `_meta`（`undefined` ⇒ 三路均不携带）。 */
  private readonly sessionMeta: Record<string, unknown> | undefined;
  private readonly logger: (message: string) => void;
  /**
   * sessionId → 本轮捕获窗（v0.8.8 · M1）：**开窗即存在、收窗即删** ⇒ 「有窗」等价于旧
   * `capturing.has(...)`；窗内一次性收齐本轮的 chunk 文本与三原料计数（旧 `buffers` /
   * `capturing` / `captureOpenedAt` / `replayDropped` 四张并行 map 的合并落点）。
   */
  private readonly captures = new Map<string, CaptureWindow>();
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
    this.model = typeof options.model === "string" && options.model.length > 0 ? options.model : undefined;
    this.mode = typeof options.mode === "string" && options.mode.length > 0 ? options.mode : undefined;
    this.collaborationMode =
      typeof options.collaborationMode === "string" && options.collaborationMode.length > 0
        ? options.collaborationMode
        : undefined;
    this.sessionMeta = options.sessionMeta;
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
    const ensureStartedAt = Date.now();
    let session: EstablishedSession;
    try {
      session = await this.ensureSession(input.contextId);
    } catch (err) {
      // 建立失败：捕获窗未开 ⇒ 三项计数记 0，`sessionResumed` / `firstChunkElapsedMs` **不报**
      //（无事实不编造，报 0 会被下游当成「有推进但零字符」）
      return this.withDiag({ state: "failed", text: `会话建立失败：${reasonOf(err)}` }, {
        err,
        stage: "ensure",
        promptElapsedMs: 0, // 未进入 prompt 段
        bridgeEnsureElapsedMs: Math.max(0, Date.now() - ensureStartedAt),
        chunkCount: 0,
        partialChars: 0,
        updateCount: 0,
      });
    }
    const { sessionId, sessionResumed } = session;
    const bridgeEnsureElapsedMs = Math.max(0, Date.now() - ensureStartedAt);
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
      this.captures.set(sessionId, {
        chunks: [],
        openedAt: Date.now(),
        partialChars: 0,
        updateCount: 0,
        replayDropped: 0,
      });
      promptResult = await this.requestWithTimeout("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: promptText }],
      });
    } catch (err) {
      // 计量与半截尾部快照须在 `discardCapture` **之前**取：失败后进程可能被杀 ⇒ 桥内存态必失效，
      // 尾部只能经 diagnostics 通道带回 launcher（M3 用它拼续跑 prompt）
      const win = this.captures.get(sessionId);
      const produced = win === undefined ? "" : win.chunks.join("");
      const diag: BridgeDiag = {
        err,
        stage: "prompt",
        promptElapsedMs: win === undefined ? 0 : Math.max(0, Date.now() - win.openedAt),
        bridgeEnsureElapsedMs,
        chunkCount: win === undefined ? 0 : win.chunks.length,
        partialChars: win === undefined ? 0 : win.partialChars,
        updateCount: win === undefined ? 0 : win.updateCount,
        firstChunkElapsedMs:
          win === undefined || win.firstChunkAt === undefined
            ? undefined
            : Math.max(0, win.firstChunkAt - win.openedAt),
        sessionResumed,
        partialTail:
          produced.length === 0 ? undefined : produced.slice(-DIAGNOSTICS_PARTIAL_TAIL_MAX_CHARS),
      };
      this.discardCapture(sessionId);
      return this.withDiag(this.failureResult(err), diag);
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
    // v0.8.8 · M1 取证面：此前本出口连 `code` 都不拼（与 `reasonOf` 不同形）⇒ 后端带码错误
    // （配额 / 限流 / Invalid params + `data`）在结果文本里被压成一句话，事后无从取证
    return { state: "failed", text: reasonOf(err) };
  }

  /**
   * 失败出口挂诊断留痕（v0.8.7 · M4 → v0.8.8 · M1 扩键）：经现成 `artifacts` 通道追加一条
   * {@link DIAGNOSTICS_ARTIFACT_NAME}（text = JSON）⇒ 零类型 / 零 wire 变更；launcher 侧摘除 + 解析。
   * 正常完成路径不调用本方法。值为 `undefined` 的键由 `JSON.stringify` 自然**省略** ⇒
   * 「没报」与「报了 0」在载荷上可区分。
   *
   * ⚠ **`chunkCount` 只作留痕，绝不作自动重发判据**：它只计 `agent_message_chunk`、
   * `agent_thought_chunk` 被忽略 ⇒ 思考型后端（codex / claude 长思考）可「有推进而 chunkCount=0」，
   * 而一句「我先看一下」就让 chunkCount>0 —— **双向误判**。判「有推进」用 `updateCount`、
   * 判「有实质产出」用 `partialChars`（改造文档 §2.4 续跑判据）。
   */
  private withDiag(result: TaskExecutionResult, diag: BridgeDiag): TaskExecutionResult {
    const payload = JSON.stringify({
      acpErrorKind: errorKindOf(diag.err),
      stage: diag.stage,
      promptElapsedMs: diag.promptElapsedMs,
      bridgeEnsureElapsedMs: diag.bridgeEnsureElapsedMs,
      chunkCount: diag.chunkCount,
      partialChars: diag.partialChars,
      updateCount: diag.updateCount,
      firstChunkElapsedMs: diag.firstChunkElapsedMs,
      sessionResumed: diag.sessionResumed,
      acpErrorCode: errorCodeOf(diag.err),
      acpErrorData: errorDataOf(diag.err, DIAGNOSTICS_DATA_MAX_CHARS),
      partialTail: diag.partialTail,
      partialTailChars: diag.partialTail?.length,
    });
    return {
      ...result,
      artifacts: [
        ...(result.artifacts ?? []),
        ...buildArtifacts([{ name: DIAGNOSTICS_ARTIFACT_NAME, text: payload }]),
      ],
    };
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update" || !isRecord(params)) return;
    const sessionId = params["sessionId"];
    const update = params["update"];
    if (typeof sessionId !== "string" || !isRecord(update)) return;
    // 本轮任意 session/update 都算「有推进」（含 thought / tool_call / plan）—— 窗内才计
    const win = this.captures.get(sessionId);
    if (win !== undefined) win.updateCount += 1;
    // P1 探针：仅 agent_message_chunk 计入回复（agent_thought_chunk 为思考，忽略）
    if (update["sessionUpdate"] !== "agent_message_chunk") return;
    const content = update["content"];
    if (!isRecord(content)) return;
    const text = content["text"];
    if (typeof text !== "string") return;
    if (win === undefined) {
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
      win.replayDropped += 1;
      return;
    }
    if (win.firstChunkAt === undefined) win.firstChunkAt = Date.now();
    win.partialChars += text.length;
    win.chunks.push(text);
  }

  private takeText(sessionId: string): string {
    const win = this.captures.get(sessionId);
    this.captures.delete(sessionId);
    this.replayMessageIds.delete(sessionId);
    if (win === undefined) return "";
    if (win.replayDropped > 0) {
      this.logger(
        `[acp-session] 本轮丢弃历史重放 chunk ${String(win.replayDropped)} 条（sessionId=${sessionId}）`,
      );
    }
    return win.chunks.join("");
  }

  /**
   * prompt 失败/超时路径：关窗并弃置半截缓冲，避免残窗把下轮 backlog 收进来。
   * **调用方必须在调用前取走尾部与计量**（v0.8.8 · M1「取出再弃」）—— 窗一关即失。
   */
  private discardCapture(sessionId: string): void {
    this.captures.delete(sessionId);
    this.replayMessageIds.delete(sessionId);
  }

  /**
   * 会话保证：load → resume → new；**三条路径成功后**统一依次走一次 {@link applyModel} /
   * {@link applyMode} / {@link applyCollaborationMode}（恢复路径同样下发，不假设后端跨会话保持）。
   *
   * **回标 `sessionResumed`（v0.8.8 · M1）**：`load` / `resume` 任一真成功 ⇒ true；两级都失败回落
   * `session/new` ⇒ false = **续跑退化成重跑**（本机制最大隐性风险，日志 + 诊断双留痕）。
   */
  private async ensureSession(contextId: string): Promise<EstablishedSession> {
    const cached = this.sessions?.get(contextId) ?? null;
    let sessionId: string | null = null;
    let sessionResumed = false;
    if (cached !== null) {
      if (await this.tryReuse("session/load", cached)) {
        sessionId = cached;
        sessionResumed = true;
      } else if (await this.tryReuse("session/resume", cached)) {
        sessionId = cached;
        sessionResumed = true;
      }
    }
    if (sessionId === null) {
      if (cached !== null) {
        this.logger(
          `[acp-session] load/resume 双失败 ⇒ 回落 session/new（contextId=${contextId} 旧 sessionId=${cached}）：续接退化为重跑`,
        );
      }
      sessionId = await this.newSession();
      this.sessions?.set(contextId, sessionId);
    }
    this.logger(
      `[acp-session] 会话建立完成（contextId=${contextId} sessionId=${sessionId} sessionResumed=${String(sessionResumed)}）`,
    );
    await this.applyModel(sessionId);
    await this.applyMode(sessionId);
    await this.applyCollaborationMode(sessionId);
    return { sessionId, sessionResumed };
  }

  /**
   * 模型设置（v0.8.2 · M1 协议面增补）：`model` 缺省 ⇒ **零请求**（与旧版逐字一致）；
   * 否则发 `session/set_config_option {configId:"model", value:<原样>}`，**不校验**值合法性。
   * 失败（含后端 `-32602` 一类的取值错误）⇒ **fail-fast**：日志（含配置原值 + 原因）后抛错，
   * 由 `ensureSession` 冒泡使会话建立失败，任务以 `failed` 收场（不回退后端默认、不继续 prompt）。
   */
  private async applyModel(sessionId: string): Promise<void> {
    if (this.model === undefined) return;
    let result: unknown;
    try {
      result = await this.requestWithTimeout("session/set_config_option", {
        sessionId,
        configId: "model",
        value: this.model,
      });
    } catch (err) {
      const reason = reasonOf(err);
      this.logger(`[acp-session] model=${this.model} 设置失败（${reason}）`);
      throw new Error(`model=${this.model} 设置失败：${reason}`);
    }
    const current = configCurrentValue(result, "model");
    this.logger(
      `[acp-session] model=${this.model} 已设置（currentValue=${current === undefined ? "n/a" : String(current)}）`,
    );
  }

  /**
   * 模式设置（v0.8.5 · M1；与 {@link applyModel} 逐行同形）：`mode` 缺省 ⇒ **零请求**。
   * 下发**优先** `session/set_mode {sessionId, modeId}`；**仅当后端回 `-32601`**（方法不存在）
   * 才回落 `session/set_config_option {configId:"mode"}`；**其余错误一律 fail-fast**
   * （日志含配置原值 + 原因后抛错 ⇒ 会话建立失败、任务 `failed`，不静默回落）。
   * 成功日志回显方式同 {@link applyModel}（`configCurrentValue(result, "mode")`，取不到呈现 `n/a`）。
   */
  private async applyMode(sessionId: string): Promise<void> {
    const mode = this.mode;
    if (mode === undefined) return;
    let result: unknown = undefined;
    try {
      result = await this.requestWithTimeout("session/set_mode", { sessionId, modeId: mode });
    } catch (err) {
      if (!isMethodNotFound(err)) {
        const reason = reasonOf(err);
        this.logger(`[acp-session] mode=${mode} 设置失败（${reason}）`);
        throw new Error(`mode=${mode} 设置失败：${reason}`);
      }
      // 后端未实现 `session/set_mode`（JSON-RPC -32601）⇒ 回落到 config option 通道
      try {
        result = await this.requestWithTimeout("session/set_config_option", {
          sessionId,
          configId: "mode",
          value: mode,
        });
      } catch (fallbackErr) {
        const reason = reasonOf(fallbackErr);
        this.logger(`[acp-session] mode=${mode} 设置失败（${reason}）`);
        throw new Error(`mode=${mode} 设置失败：${reason}`);
      }
    }
    const current = configCurrentValue(result, "mode");
    this.logger(
      `[acp-session] mode=${mode} 已设置（currentValue=${current === undefined ? "n/a" : String(current)}）`,
    );
  }

  /**
   * 协作模式设置（v0.8.5 · M1；与 {@link applyModel} 逐行同形）：`collaborationMode` 缺省 ⇒ **零请求**。
   * `collaboration_mode` **不在 `modes` 集合内** ⇒ **只走**
   * `session/set_config_option {configId:"collaboration_mode"}`，无 `session/set_mode` 优先路径、也不回落；
   * 失败 ⇒ fail-fast（同 applyModel：日志 + 抛错）。
   */
  private async applyCollaborationMode(sessionId: string): Promise<void> {
    const value = this.collaborationMode;
    if (value === undefined) return;
    let result: unknown = undefined;
    try {
      result = await this.requestWithTimeout("session/set_config_option", {
        sessionId,
        configId: "collaboration_mode",
        value,
      });
    } catch (err) {
      const reason = reasonOf(err);
      this.logger(`[acp-session] collaboration_mode=${value} 设置失败（${reason}）`);
      throw new Error(`collaboration_mode=${value} 设置失败：${reason}`);
    }
    const current = configCurrentValue(result, "collaboration_mode");
    this.logger(
      `[acp-session] collaboration_mode=${value} 已设置（currentValue=${current === undefined ? "n/a" : String(current)}）`,
    );
  }

  private async tryReuse(method: string, sessionId: string): Promise<boolean> {
    const base =
      method === "session/load"
        ? { sessionId, cwd: this.cwd, mcpServers: [...this.mcpServers] }
        : { sessionId };
    // `--session-meta-json` **三路统一携带**（load / resume 亦带；否则经 load/resume 的会话拿不到 ⇒ full 档静默降级）
    const params = this.sessionMeta === undefined ? base : { ...base, _meta: this.sessionMeta };
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
      ...(this.sessionMeta !== undefined ? { _meta: this.sessionMeta } : {}),
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
