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

/**
 * A2A 任务态。
 * `blocked` 为 **orch 本地专属**（v0.4.0 失败传播：上游失败 → 下游置 blocked），
 * **不映射 A2A**（A2A 无此态；派发/查询一律按 `working` 语义处理）。
 */
export type TaskState = "working" | "completed" | "failed" | "input-required" | "blocked";

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
  /** Feature 级会话上下文（跨任务 / 跨 worker 启停复用；可空） */
  contextId: string | null;
  /** 统一方案（分析汇总产出，供审批与派发注入；可空） */
  plan: string | null;
  /** 决策记录（JSON 字符串；可空） */
  decisions: string | null;
  /** 契约（JSON 字符串；可空） */
  contracts: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `createFeature` 入参：时间戳 / state 缺省时由存储层补齐 */
export interface FeatureCreateInput {
  featureId: string;
  title: string;
  requirement?: string | null;
  /** Feature 级会话上下文（可空；亦可后续经 `updateFeatureContext` 写入） */
  contextId?: string | null;
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
  /**
   * 该机项目是否接收 orch push 回调（v0.4.0 §2.6；缺省 false）。
   * 仅当 orch `callback.enabled` 与该位**同时**为真时，派发才内联注册回调（路径 1）。
   */
  pushCallback?: boolean;
}

/**
 * orch 回调端点配置（v0.4.0 §2.6 worker 回调）。
 * 默认关；开启后桥在 `host:port` 上监听 `POST /callback` 接收 worker push 通知。
 * `host` 默认 loopback（跨机回调鉴权待 v0.7.0）；`token` 可选，命中则校验通知请求。
 */
export interface CallbackConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** 可选校验令牌（worker push 以 `X-A2A-Notification-Token` 回传；缺省不校验） */
  token?: string;
}

/** orch 侧：机器清单 */
export interface MachinesConfig {
  machines: MachineRef[];
  /** orch 回调端点（v0.4.0；缺省 = 关闭） */
  callback?: CallbackConfig;
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

/**
 * 下游任务对上游产物的引用（`tasks.input_artifacts` 元素；v0.4.0）。
 * 两种定位方式任选其一：`artifactId` 直指主键；或 `producerTaskId`（+可选 `name`）按上游匹配。
 */
export interface InputArtifactRef {
  /** 上游节点（本地 taskId） */
  producerTaskId?: string;
  /** 产物名（配 `producerTaskId` 定位，如 `api.yaml`） */
  name?: string;
  /** 产物主键（直接定位，优先于 producerTaskId+name） */
  artifactId?: string;
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
  /** 下游声明的上游产物引用（v0.4.0；NULL = 无输入产物） */
  inputArtifacts: InputArtifactRef[] | null;
  /** Feature 节点派发后远端 A2A 任务 id；独立任务为 NULL（taskId 即远端 id） */
  remoteTaskId: string | null;
  /** Feature 排队节点的待派发消息全文；派发后保留（作为可重派依据） */
  dispatchMessage: string | null;
}

/** 产物登记记录（落 SQLite `artifacts` 表；v0.4.0） */
export interface ArtifactRecord {
  /** 主键：`${producerTaskId}:${remoteArtifactId}`（避免跨任务 id 冲突） */
  artifactId: string;
  /** 归属 Feature */
  featureId: string;
  /** 上游节点（本地 taskId） */
  producerTaskId: string;
  /** 产物名（如 `api.yaml`） */
  name: string;
  /** mediaType（可空） */
  mime: string | null;
  /** 内容引用（本地落位 / 远端 uri；可空） */
  uri: string | null;
  /** 字节大小（可空） */
  size: number | null;
  /** 内容哈希（可空） */
  contentHash: string | null;
  createdAt: string;
}

/** 事件收件箱记录（落 SQLite `events` 表；v0.4.0） */
export interface EventRecord {
  /** 自增游标（`listEvents(since)` 以此为序） */
  eventId: number;
  featureId: string | null;
  taskId: string | null;
  /** `task.settled` / `task.blocked` / `feature.state`（后续可扩展 push.received 等） */
  kind: string;
  /** 变化后的状态串（可空） */
  state: string | null;
  /** 附加载荷（JSON 字符串；可空） */
  payload: string | null;
  createdAt: string;
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
