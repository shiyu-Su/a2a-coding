/**
 * orch 侧类型（部署单元 1：orch 机器）。
 *
 * - 机器清单与会话/任务记录：bridge / session store 直接依赖。
 * - 线协议类型（Bridge ⇄ Launcher HTTP）：按 option a 在两侧各自声明，
 *   machine 侧同名类型见 `src/machine/types.ts`，修改时需两侧同步。
 */

/**
 * Bridge ⇄ Launcher 线协议版本（单一事实源：仓库根 PROTOCOL.md；machine 侧同名常量见
 * machine/types.ts，修改需两侧同步并由契约测试锁定）。
 * 规则：加可选字段 minor+1；删字段 / 改语义 / 加必填请求体 major+1。
 */
export const PROTOCOL_VERSION = "1.0";

/**
 * 桥可支持的对端（Launcher）主版本清单。主版本升级时按 PROTOCOL.md 维护流程
 * 显式决策：保留旧主版本支持则留清单并维护对应行为分支（按握手缓存的机器
 * 完整版本号分支）；放弃支持则移出（旧机被拒绝并获升级指引）。
 */
export const SUPPORTED_PEER_PROTOCOL_MAJORS: readonly number[] = [1];

/** 执行层 Agent 类型（决定 A2A 包装器与 CLI 参数） */
export type AgentKind = "opencode" | "codex" | "claude";

/** A2A 任务态 */
export type TaskState = "working" | "completed" | "failed" | "input-required";

/**
 * Feature 状态（v0.3.0）。
 * 主链（9）：discussing → analyzing → planning → waiting_approval → executing →
 * integrating → testing → reviewing → completed；
 * 异常态（3）：needs_input / failed / cancelled；终态：completed / failed / cancelled。
 * 合法流转由 `orch/feature/state-machine.ts` 纯模块强制（非法流转 fail-fast）。
 */
export type FeatureState =
  | "discussing"
  | "analyzing"
  | "planning"
  | "waiting_approval"
  | "executing"
  | "integrating"
  | "testing"
  | "reviewing"
  | "completed"
  | "needs_input"
  | "failed"
  | "cancelled";

/** Feature 记录（落 SQLite `features` 表） */
export interface FeatureRecord {
  featureId: string;
  state: FeatureState;
  title: string;
  /** 需求原文（截断，可空） */
  requirement: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `createFeature` 入参：时间戳 / state 缺省时由存储层补齐 */
export interface FeatureCreateInput {
  featureId: string;
  title: string;
  requirement?: string | null;
  /** 缺省 `discussing` */
  state?: FeatureState;
  createdAt?: string;
  updatedAt?: string;
}

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
  /**
   * 本地任务标识。独立单任务 = 远端 A2A 任务 id；Feature 节点 = orch 本地分配
   * 的节点 id（远端 id 见 `remoteTaskId`）。`dependencies` 引用本字段。
   */
  taskId: string;
  projectId: string;
  contextId: string;
  state: TaskState;
  artifactsJson: string | null;
  /** 任务结果纯文本（成功 = artifacts 文本；失败 = status.message 错误原因）；旧记录可能为 null */
  text: string | null;
  /** 派发时的原始 prompt 片段（落库前截断）；旧记录可能为 null */
  prompt: string | null;
  updatedAt: string;
  /** 归属 Feature（NULL = 独立单任务） */
  featureId: string | null;
  /** 前置任务（本地 taskId 数组，环/悬空引用由调度器校验）；NULL = 无依赖 */
  dependencies: string[] | null;
  /** Feature 节点派发后远端 A2A 任务 id；独立任务为 NULL（taskId 即远端 id） */
  remoteTaskId: string | null;
  /** Feature 排队节点的待派发消息全文；派发后保留（作为可重派依据） */
  dispatchMessage: string | null;
}

/** `a2a_tasks` 列表项：本地任务记录 + 陈旧标记 */
export interface TaskListItem {
  taskId: string;
  contextId: string;
  state: TaskState;
  /** 派发时的原始 prompt 片段（截断），用于辨识任务 */
  prompt: string | null;
  /** 结果文本（本地 text，缺省回退归档 artifacts 文本） */
  text: string;
  /** 归档 artifacts 摘要（ArtifactSummary[]；由 bridge 侧收窄） */
  artifacts: unknown;
  updatedAt: string;
  /** working 且判定不可达（无在飞看护 / 项目不在线）时为 true */
  stale: boolean;
}

/** 统一错误外壳（对外 HTTP / 工具返回） */
export interface ApiError {
  code: string;
  message: string;
}
