/**
 * ACP 桥（`machine/acp-bridge/`）共享类型：A2A 任务形状 + 可注入执行器契约。
 *
 * 归属：REQ-v0.8.0-2026-09-19-01 · 节点 B1。**零依赖叶模块**：不 import 仓内任何模块，
 * 也不 import `orch/**` / `launcher/**`（避免 acp-bridge → launcher 的依赖倒置）。
 *
 * 形状口径：与 `machine/launcher/a2a-client.ts` 的读取面**逐字兼容** ——
 * `id` / `status.state` / `status.message.parts` / `artifacts[].parts`，
 * 终态集合 = completed / canceled / failed / rejected / input-required / auth-required。
 */

/** A2A 任务态（`working` + `a2a-client.ts` 的 A2A_TERMINAL_STATES 全集）。 */
export type TaskState =
  | "working"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "input-required"
  | "auth-required";

/** 终态子集（不含 `working`）。 */
export type TerminalTaskState = Exclude<TaskState, "working">;

/** v0.3 text part：`{ kind: "text", text }`。 */
export interface TextPart {
  kind: "text";
  text: string;
}

/** v0.3 message（role 收敛为字面量，防字符串漂移）。 */
export interface A2AMessage {
  role: "user" | "agent";
  parts: TextPart[];
  messageId: string;
  contextId?: string;
  /**
   * A2A 消息元信息（**v0.10.2 · M-2 起桥侧接这根线**）：machine → 后端 agent 段的角色意图载体
   * （launcher 从 dispatch 顶层 `taskType` + 本机 `agentConfig.roles` 映射后写入）。
   * 本模块只标**形态**（宽对象），**不校验**；解析的唯一落点 = `a2a-server.ts` 的
   * `parseRoleIntent`（其它地方不得再解析 `metadata`）。
   */
  metadata?: Record<string, unknown>;
}

/**
 * 会话级 **per-request 覆盖包**（v0.10.2 · M-2 · F-C4 `M2-a` 档）。
 *
 * 语义 = 「**override 优先、无则回落构造器**」：每个键**单独**判定 —— 有效值覆盖构造器同名字段，
 * 缺省 / 空串 ⇒ 落 `BridgeArgs` → `startBridge` 装配的**进程级缺省**（未配 ⇒ 逐字现状）。
 * 覆盖**只在同 `agentKind` / 同后端进程内**生效（`M2-b` 跨 kind / 跨 `backendCmd` 属边界外，本版不做）。
 *
 * `risk` 只标形态：取值 = `index.ts` 的 `BridgeRisk` 闭集（`read` / `write` / `full`），
 * 本模块是零依赖叶、不 import 该类型，**校验与消费归 `acp/permission.ts` 的 `sessionId→risk` 路由节点**。
 */
export interface SessionOverrides {
  model?: string;
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace";
  mode?: string;
  collaborationMode?: string;
  risk?: string;
}

/** v0.3 artifact（最小集：文本 parts）。 */
export interface A2AArtifact {
  artifactId: string;
  name?: string;
  parts: TextPart[];
}

/**
 * v0.3 Task。`a2a-client.ts` 读取的字段：`id`、`status.state`、
 * `status.message.parts`、`artifacts[].parts`。
 */
export interface A2ATask {
  id: string;
  status: { state: TaskState; message?: A2AMessage };
  artifacts: A2AArtifact[];
}

/** 执行器入参：桥收到一条 `message/send` 后交给执行器。 */
export interface TaskExecutionInput {
  /** 桥分配的任务 id（与 A2A Task.id 同值） */
  taskId: string;
  /** message parts 拼接后的文本（prompt） */
  text: string;
  /** A2A contextId（缺省为 ""） */
  contextId: string;
  /** 原始 A2A messageId */
  messageId: string;
  /**
   * 职责位原值（v0.10.2 · M-2）：由 `message.metadata.taskType` 解出，**桥只透传 / 留痕，不校验**
   * （闭集执法在 launcher intake，见 `launcher/runner-exec.ts`）。缺省 ⇒ 不落该键 = 未声明。
   */
  taskType?: string;
  /**
   * 会话级 per-request 覆盖包（v0.10.2 · M-2）：由 `message.metadata` 解出的**有效键**，
   * 逐键「override 优先、无则回落构造器」。缺省 / 空对象 ⇒ 全回落（逐字现状）。
   */
  overrides?: SessionOverrides;
}

/** 执行器终态结果（由 B2/B3 的 ACP 会话执行器产出）。 */
export interface TaskExecutionResult {
  /** 终态（不含 working） */
  state: TerminalTaskState;
  /** 结果文本（**剥 outcome 块后的全文**，v0.8.1 M3 基线）→ 写入 `name="response"` artifact */
  text?: string;
  /** `input-required` 短文（M3：写入 status.message；artifact 仍承载全文，短重复沿口径不修） */
  question?: string;
  /** `failed` 短文（同上） */
  reason?: string;
  /** 附加产物（追加在 `response` artifact 之后；缺省无） */
  artifacts?: A2AArtifact[];
  /**
   * 本轮已被**执行器放弃**、但后端那一轮可能仍在烧（v0.8.10 · M-N3 · B16′ 的桥侧半边）。
   * 现唯一产出点 = ACP 会话执行器的 prompt 满窗出口。台账据此允许「终态支路」的迟到取消
   * （只通知执行器、**不改 state**）。缺省 = false（未放弃 / 无需迟到取消）。
   */
  abandoned?: boolean;
}

/**
 * 任务执行器（**可注入**）：B1 用 stub；B2/B3 以 ACP 会话执行器替换。
 * `cancel` 可选：桥收到 `tasks/cancel` 时尽力通知执行器。
 */
export interface TaskExecutor {
  execute(input: TaskExecutionInput): Promise<TaskExecutionResult>;
  cancel?(taskId: string): void | Promise<void>;
}

/** 可注入时钟（缺省 `() => new Date()`）。 */
export type Clock = () => Date;
