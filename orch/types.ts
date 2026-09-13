/**
 * orch 侧类型（部署单元 1：orch 机器）。
 *
 * - 机器清单与会话/任务记录：bridge / session store 直接依赖。
 * - 线协议类型（Bridge ⇄ Launcher HTTP）：按 option a 在两侧各自声明，
 *   machine 侧同名类型见 `src/machine/types.ts`，修改时需两侧同步。
 */

/** 执行层 Agent 类型（决定 A2A 包装器与 CLI 参数） */
export type AgentKind = "opencode" | "codex" | "claude";

/** A2A 任务态 */
export type TaskState = "working" | "completed" | "failed" | "input-required";

/** 项目风险级别（决定 CLI 权限参数） */
export type RiskLevel = "read" | "write" | "full";

/** orch 侧：机器清单中的一条 */
export interface MachineRef {
  machineId: string;
  launcherUrl: string;
}

/** orch 侧：机器清单 */
export interface MachinesConfig {
  machines: MachineRef[];
}

/** 项目 + 运行态（GET /projects 返回；bridge 消费的 launcher 线协议） */
export interface ProjectStatus {
  projectId: string;
  workspace: string;
  agentKind: AgentKind;
  /** 该项目的 A2A Server 监听端口 */
  a2aPort: number;
  status: "online" | "offline";
  endpoint: string | null;
  startedAt: string | null;
  /** 项目风险级别（launcher 配置；缺省视为未声明） */
  risk?: RiskLevel;
}

/** POST /projects/{id}/ensure 返回 */
export interface EnsureResult {
  projectId: string;
  endpoint: string;
  /** true=本次新启动；false=已在运行、直接复用 */
  started: boolean;
}

/** POST /projects/{id}/stop 返回 */
export interface StopResult {
  projectId: string;
  stopped: boolean;
}

/** 会话映射（Q3：agent 退出后仍可继承上下文） */
export interface SessionRecord {
  projectId: string;
  contextId: string;
  sessionId: string;
  agentKind: AgentKind;
  createdAt: string;
  lastUsedAt: string;
}

/** 任务记录 */
export interface TaskRecord {
  taskId: string;
  projectId: string;
  contextId: string;
  state: TaskState;
  artifactsJson: string | null;
  /** 任务结果纯文本（成功 = artifacts 文本；失败 = status.message 错误原因）；旧记录可能为 null */
  text: string | null;
  updatedAt: string;
}

/** 统一错误外壳（对外 HTTP / 工具返回） */
export interface ApiError {
  code: string;
  message: string;
}
