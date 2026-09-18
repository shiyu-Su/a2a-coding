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
 * 任务失败分类（v0.4.1 超时与失败自动化；**v0.6.1 REQ-05 起语义休眠**）。
 * - `infra`：基础设施类失败（超时 / 中断 / 看护放弃 / 库锁 / 网络）⇒ 曾走「取证 → 条件重试」；
 * - `task`：任务本身失败 ⇒ 曾照旧传播 `blocked` → Feature `failed`（不重试）。
 *
 * ⚠️ 五层删除（分类器 `classifyFailure` + 写口 `markTaskFailureKind` 均删）后**不再产生新分类**；
 * 类型与 `tasks.failure_kind` 列一并保留（读侧兼容历史行、出参字段形状不变），但实际恒 `null`。
 */
export type FailureKind = "infra" | "task";

/**
 * Feature 状态（v0.3.0；v0.4.1 REQ-04 收敛为 6 态主链）。
 * 主链（6）：waiting_approval → executing → integrating → testing → reviewing → completed；
 * 异常态（3）：needs_input / failed / cancelled；终态：completed / failed / cancelled。
 * 前段三态（discussing / analyzing / planning）已删除：引擎只做需求实现，Step 0/1 不走引擎。
 * 合法流转由 `orch/feature/state-machine.ts` 纯模块强制（非法流转 fail-fast）。
 */
export type FeatureState =
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
  /** 缺省 `waiting_approval`（主链起点 / 审批门停靠点） */
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

/**
 * 桥 transport 模式（v0.4.1 桥常驻化）。
 * - `stdio`（缺省）：桥随宿主进程内嵌，行为与旧配置完全一致；
 * - `http`：桥常驻监听 `transport.http`，由宿主经 HTTP 连接。
 */
export type TransportMode = "stdio" | "http";

/** `mode = "http"` 时的桥监听参数 */
export interface HttpTransportConfig {
  host: string;
  port: number;
  path: string;
}

/**
 * 桥 transport 配置（v0.4.1）。
 * 配置文件内**可选**（旧 `config.json` 无 `transport` 键时零改动可用），
 * 解析后恒补齐为完整对象：缺省 `mode = "stdio"`、`http = { 127.0.0.1, 8787, "/mcp" }`。
 */
export interface TransportConfig {
  mode: TransportMode;
  http: HttpTransportConfig;
}

/**
 * orch 网页端只读工作台配置（v0.5.0 §2.2）。
 *
 * 配置文件内**可选**，解析后恒补齐为完整对象（缺省见 `config.ts`）。
 * 语义（本段只承载「解析后的配置」，是否 bind 由运行时决定）：
 * - `enabled`（缺省 `true`）**只在常驻（`transport.mode === "http"`）形态下生效**；
 *   stdio 形态**不读它**（避免「`enabled = true` 但无效果」的歧义）。
 * - `allowStdio`（缺省 `false`）= **唯一**允许 stdio 形态也 bind 的显式开关；
 *   开启时运行时**必须 `server.unref()`**（否则持住事件循环 ⇒ 破「桥随宿主退出」不变量 ⇒ 子进程泄漏）。
 * - 运行时 bind 判定式为 `(mode === "http" ? web.enabled : web.allowStdio) && role === "owner"`。
 * - `host` 非 loopback 由**运行时**拒起，**不在解析层拒绝**（loopback 校验属运行时）。
 */
export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
  allowStdio: boolean;
}

/** 项目组成员（v0.6.0：`machineId × projectId` 二元组） */
export interface ProjectMember {
  machineId: string;
  projectId: string;
}

/**
 * 静态「项目组」（v0.6.0 §2.1；`orch/config/config.json` 的 `projectGroup` 段，**单组**、
 * 每请求现读、不缓存）。
 *
 * 段**缺省** ⇒ `selective: false`（全量接纳，与旧版行为完全一致，**绝不 fail-fast**）；
 * 段**存在** ⇒ 严格结构校验、非法即 `fail()`（成员列表空数组 / 成员项非法 /
 * `machineId ∉ machines[]` 一律 fail-fast，见 §2.3-I2「绝不 fail-open」）。
 *
 * `name` / `members` = 配置声明态；`memberKeys` / `memberMachineIds` / `selective` =
 * 解析期由 `config.ts#parseProjectGroup` 产出的**派生态**（`loadMachinesConfig()` 恒填充）。
 * 成员判定**必须**同源于 `memberKey(machineId, projectId)`（§2.3-I1 单一判据，禁第二套拼接）。
 */
export interface ProjectGroup {
  /** 组名（缺省 `null`；遵循本仓「不省略字段、无数据返 `null`」） */
  name: string | null;
  /** 声明态成员（保持配置内声明顺序；重复项由派生集合去重） */
  members: ProjectMember[];
  /** 派生：成员 key 集合（由 `memberKey(machineId, projectId)` 构造） */
  memberKeys: Set<string>;
  /** 派生：成员机器 id 集合（「发现」路径的扫描范围收窄依据） */
  memberMachineIds: Set<string>;
  /** 派生：是否启用选择性连接（段缺省 ⇒ `false` = 全量接纳） */
  selective: boolean;
}

/** orch 侧：机器清单 */
export interface MachinesConfig {
  machines: MachineRef[];
  /** orch 回调端点（v0.4.0；缺省 = 关闭） */
  callback?: CallbackConfig;
  /** 桥 transport（v0.4.1；配置缺省时解析为 `mode = "stdio"` 旧行为） */
  transport: TransportConfig;
  /** 网页端只读工作台（v0.5.0；配置缺省时解析为 `{ true, "127.0.0.1", 3300, false }`） */
  web: WebConfig;
  /**
   * 静态项目组（v0.6.0；**段缺省时解析为 `selective: false` 的全量接纳态**，
   * 由 `loadMachinesConfig()` **恒填充** —— 运行时不会出现 `undefined`，字段可选仅为对齐配置段可选）。
   */
  projectGroup?: ProjectGroup;
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
  /**
   * **登记时刻**（v0.5.0 三时刻列，UTC ISO 8601）。`createTask()` 首次落库时写，
   * `ON CONFLICT` **不更新** ⇒ 恒为首次登记时刻；v0.5.0 之前的老记录**不回填，为 null**。
   */
  createdAt: string | null;
  /**
   * **首次开工时刻**（v0.5.0，UTC ISO 8601）。两个写入点：
   * `createTask()` 且 `state === "working"`；`markTaskDispatched()` **仅当为 NULL 才填**。
   * ⇒ 「只填一次」：重派 / 条件重试**不重置**起点。未开工（含 `input-required` 等）与老记录为 null。
   */
  startedAt: string | null;
  /**
   * **完成时刻**（v0.5.0，UTC ISO 8601）。终态口径 = **`{completed, failed, blocked}`**
   * （**不含** `working` / `input-required`），故 **不变量：`finishedAt !== null` ⇔ 已完成**。
   * 写入点：`createTask()` 终态时 / `compareAndSwapTaskState()` 转入终态时；清空点：
   * `rearmTask()` / `rearmForRetry()`（回到未完成）。老记录为 null。
   */
  finishedAt: string | null;
  /** 归属 Feature（NULL = 独立单任务） */
  featureId: string | null;
  /** 前置任务（本地 taskId 数组，环/悬空引用由调度器校验）；NULL = 无依赖 */
  dependencies: string[] | null;
  /** 下游声明的上游产物引用（v0.4.0；NULL = 无输入产物） */
  inputArtifacts: InputArtifactRef[] | null;
  /** Feature 节点派发后远端 A2A 任务 id；独立任务为 NULL（taskId 即远端 id） */
  remoteTaskId: string | null;
  /**
   * **派发占位（C11 幂等键，v0.6.1 REQ-05 §2.5 白捡；非 NULL = 「已发出」）**。
   *
   * 写入点 = A2A `message/send` **之前**（`markTaskDispatchStarted`），值 = 占位时刻（UTC ISO 8601）；
   * `remoteTaskId` 由 send 返回后回填。二者合起来表达「**已发出即有占位**」：
   * - `dispatchGuard === null` ⇒ **必未发出**（崩溃点在此 ⇒ 重启可安全重派，无双派）；
   * - `dispatchGuard !== null` 且 `remoteTaskId === null` ⇒ **可能已发出、远端 id 未知**
   *   （崩溃点在此 ⇒ 重启保守判「已发出」，**不自动重派**，按 interrupted 收敛并交静止账单）；
   * - 二者皆非 NULL ⇒ 已发出且已知远端 id（既有在飞恢复路径）。
   *
   * 清空点 = `rearmTask` / `rearmForRetry`（回到待派发 ⇒ 可重派，避免「永久不派」）；
   * 回填**不清**（「已发出」是既成事实）。老记录 / 独立单任务为 NULL。
   */
  dispatchGuard: string | null;
  /** Feature 排队节点的待派发消息全文；派发后保留（作为可重派依据） */
  dispatchMessage: string | null;
  /**
   * **重派代次**（v0.4.1 的「条件重试已用次数」；**v0.6.1 REQ-05 起门禁语义删除、降级为记账**）。
   *
   * ⚠️ 本列**唯一写口** = `rearmForRetry`（自增）：`a2a_feature_advance(retryTaskIds)` 每成功重派一次 **+1**
   * ⇒ `a2a_feature_status` 出参 `retryCount` **在重派后 > 0**（**不再恒 `0`**）。
   *
   * **参与失败账单 episode 去重**（v0.6.2 REQ-01）：`reportFailureAtRest` 的签名以
   * `${taskId}:${retryCount}` 记账失败项 ⇒ 同一节点被重派后再次失败，会产出**新的 episode**
   * （失败账单可再次发出），而非被旧签名静默吞掉。
   */
  retryCount: number;
  /**
   * 失败分类（v0.4.1；**v0.6.1 REQ-05 起语义休眠**）。
   *
   * ⚠️ 分类器（`classifyFailure`）与写口（`markTaskFailureKind`）随五层删除 ⇒ 该列不再被写入
   * （读侧保留以兼容历史行）⇒ `a2a_feature_status` 出参 `failureKind` 恒 `null`（字段保留、语义休眠）。
   */
  failureKind: FailureKind | null;
  /**
   * **休眠列（自 REQ-05 起）** —— 中性化标记（v0.4.1 的「失败节点已被取证流接管」）。
   *
   * 列保留（`schema 不挖`）但**引擎不读不写**：`store` 已把它移出 `TASK_COLUMNS`（恒读作 `false`）、
   * 写口 `markTaskExhausted` 已删除。字段保留仅为维持记录形状与老库兼容。
   */
  exhausted: boolean;
  /**
   * **休眠列（自 REQ-05 起）** —— 可派时间门（v0.4.1「登记取证节点后先不派」的持久化挡板）。
   *
   * 列保留但**引擎不读不写**：判据 `isPastNotBefore` 与写口 `setTaskNotBefore` 已删除，
   * `computeReadyNodes` 不再有任何时间门条件。
   */
  notBefore: string | null;
  /**
   * **休眠列（自 REQ-05 起）** —— 最近一次 `GET /projects` 轮询时间（v0.4.1 等回收门 5s 节流用）。
   *
   * 列保留但**引擎不读不写**：写口 `setTaskLastPollAt` 与等回收门整块已删除。
   */
  lastPollAt: string | null;
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
