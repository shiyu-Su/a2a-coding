/**
 * orch 侧类型（部署单元 1：orch 机器）。
 *
 * - 机器清单与会话/任务记录：bridge / session store 直接依赖。
 * - 线协议类型（Bridge ⇄ Launcher HTTP）：按 option a 在两侧各自声明，
 *   machine 侧同名类型见 `src/machine/types.ts`，修改时需两侧同步。
 */

/**
 * Bridge ⇄ Runner 线协议版本（单一事实源：仓库根 PROTOCOL.md；machine 侧同名常量见
 * machine/types.ts，修改需两侧同步并由契约测试锁定）。
 * 规则：加可选字段 minor+1；必填字段取值集合扩展 minor+1；删字段 / 改语义 / 加必填请求体 major+1。
 *
 * v0.7.0：连接模型整体反转为 pull（Launcher 升格 Runner），握手方向/语义为**破坏性变更**
 * ⇒ major bump `1.0 → 2.0`，**发版即硬切**（v1 通道退役，见 `SUPPORTED_PEER_PROTOCOL_MAJORS`）。
 * v0.8.0：agentKind 取值集合扩展（`+qoder`），字段 / 形状不变 ⇒ minor bump `2.0 → 2.1`
 * （实际强制来自 `agentKind` 闭集拒绝，版本握手只校验主版本）。
 * v0.8.x（req03 硬切）：agentKind 取值 `qoder` 更名为 `qoder-cn`，字段 / 形状不变但**取值集合变更、
 * 旧值 `qoder` 不再合法** ⇒ minor bump `2.1 → 2.2`（同由 `agentKind` 闭集拒绝强制，握手只校验主版本）。
 */
export const PROTOCOL_VERSION = "2.2";

/**
 * 桥可支持的对端（Runner）主版本清单。主版本升级时按 PROTOCOL.md 维护流程
 * 显式决策：保留旧主版本支持则留清单并维护对应行为分支（按握手缓存的机器
 * 完整版本号分支）；放弃支持则移出（旧机被拒绝并获升级指引）。
 *
 * v0.7.0：pull 模型硬切 ⇒ **只留 `[2]`**（v1 入站通道退役，旧 Runner 被拒绝并获升级指引）。
 */
export const SUPPORTED_PEER_PROTOCOL_MAJORS: readonly number[] = [2];

/**
 * 执行层 Agent 类型取值集合（**orch 单元内唯一枚举源**）。
 *
 * 取值集合的规范源 = 仓库根 `PROTOCOL.md` 的机器可解析 `agent-kinds` 锚点；
 * orch（本常量）与 machine（`machine/agent-kinds.ts` 的 `AGENT_KINDS`）各自派生、
 * **不共享代码**，两侧一致性由回归断言「本地清单 == 锚点」锁定。
 *
 * orch 侧仅据此作**闭集校验 / 投影** —— 「决定**执行层后端（ACP 桥 / 适配器）**与 CLI 参数」属 machine 侧语义。
 */
export const AGENT_KINDS = ["opencode", "codex", "claude", "qoder-cn"] as const;

/** 执行层 Agent 类型（由 `AGENT_KINDS` 派生；勿另立第二份清单） */
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * A2A 任务态。
 * `blocked` 为 **orch 本地专属**（v0.4.0 失败传播：上游失败 → 下游置 blocked），
 * **不映射 A2A**（A2A 无此态；派发/查询一律按 `working` 语义处理）。
 */
export type TaskState = "working" | "completed" | "failed" | "input-required" | "blocked";

/**
 * 任务失败分类（v0.4.1 超时与失败自动化；v0.6.1 REQ-05 起语义休眠；**v0.8.7 O3 按二分恢复写入**）。
 * - `infra`：基础设施 / 载体类失败（进程起不来 / 中途死 / 墙钟孤儿）；
 * - `task`：任务自身失败（含协议方言、业务失败，以及**分类未知时的安全降级**）。
 *
 * v0.4.1 的「取证 → 条件重试」判据**不复活**（重派权仍归宿主）；本版只把**分类事实**接回来，
 * v0.8.8 若要扩到六类，是**加取值**而非重定字段。
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
  /**
   * 归属组（v0.8.6 §2.3 / REQ-v0.8.6-2026-09-21-01）：= 建 Feature 时的**连接身份**（组名）。
   *
   * - `null` = **无归属**：未配组环境（连接无身份）下创建的 Feature，或配组改造前的存量行；
   *   可见性走 **fail-closed**（未配组环境全量可见；已配组环境对该组身份不可见，不猜默认组，§1.3 R-3 / G2）。
   * - 非空 = 该组名：Feature **谁建谁见**（列表 / 单查 / advance / approve / cancel 一律按此校验）。
   */
  ownerGroup: string | null;
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
  /**
   * 归属组（v0.8.6 §2.3）：建 Feature 时的连接身份（组名）；`null` / 缺省 = 无归属
   * （未配组环境的匿名入口）。落 `features.owner_group`，Feature 五出口的可见性/可操作性据此判定。
   */
  ownerGroup?: string | null;
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
  /**
   * **已作废（deprecated，v0.7.0）**：桥 → Launcher 的入站指挥通道随 Runner 反向注册退役，
   * pull 模型下本字段**无消费方**（出站路径已在 A6 整体退役：`/health` 握手 / `GET /projects` /
   * `POST …/ensure` 与 A2A 出站均已删除）。
   *
   * 配置解析宽松（解析宽容）：**缺省** ⇒ 告警并归空；**存在但非法**（空串/非字符串）
   * ⇒ 告警并忽略；**存在且合法** ⇒ 原样保留。三路皆**不 fail-fast、不回退全量接纳**。
   *
   * v0.7.0 A6 起类型转**可选**：出站解引用点全数消除后，本字段仅为旧配置的兼容占位。
   */
  launcherUrl?: string;
  /**
   * per-machine Runner 鉴权 token（v0.7.0 D4；**可选**）。
   * 桥按 `machineId` 校验 Runner 注册 / 领任务 / 回传所携带的静态 Bearer token
   * （对应机器侧 `launcher.bridge.token`；常量时间比较）。解析层仅保证「存在时为非空字符串」，
   * 是否配置 / 准入裁决属注册端点（A3）。
   */
  token?: string;
}

/**
 * 桥 transport 模式（v0.4.1 桥常驻化；v0.7.1 **stdio 退役**）。
 * - `"http"`（缺省，现唯一合法值）：桥常驻监听 `transport.http`，由宿主经 HTTP 连接；
 * - `"stdio"`：**已退役**（保留类型仅为承载显式配置的结构化拒绝 —— 配置解析期 fail-fast）。
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
 * 解析后恒补齐为完整对象：缺省 `mode = "http"`、`http = { 127.0.0.1, 8787, "/mcp" }`。
 */
export interface TransportConfig {
  mode: TransportMode;
  http: HttpTransportConfig;
}

/**
 * orch 网页端只读工作台配置（v0.5.0 §2.2；v0.7.1 stdio 退役后 `allowStdio` 移除）。
 *
 * 配置文件内**可选**，解析后恒补齐为完整对象（缺省见 `config.ts`）。
 * 语义（本段只承载「解析后的配置」，是否 bind 由运行时决定）：
 * - `enabled`（缺省 `true`）：是否允许常驻桥另起只读 HTTP 工作台；
 * - 运行时 bind 判定式为 `enabled && role === "owner"`；
 * - `host` 非 loopback 由**运行时**拒起，**不在解析层拒绝**（loopback 校验属运行时）。
 * - `allowStdio`（v0.7.1 起随 stdio 退役成死配置）：配置显式出现仅 warn + 忽略，**不在本结构**。
 */
export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
}

/** 项目组成员（v0.6.0：`machineId × projectId` 二元组） */
export interface ProjectMember {
  machineId: string;
  projectId: string;
}

/**
 * 静态「项目组」（v0.8.6 一桥多组 §2.1；`orch/config/config.json` 的 `projectGroup` 段的
 * **单个组元素**，键名沿用、形状由「单组对象」扩为「**组数组**」，每请求现读、不缓存）。
 *
 * 段**缺省 / 未配任何组** ⇒ 顶层 `groups: []` = **全量接纳**（`selective: false`，与旧版一致、零破坏）；
 * 段**存在** ⇒ 每个 Group 恒 `selective: true`、严格结构校验、非法即 `fail()`；
 * **组间成员互斥**（同一 `(machineId, projectId)` 只能属一个组）⇒ 配置期 fail-fast。
 *
 * `name` / `members` = 配置声明态（`name` 用于错误文案与 `owner_group` 归属列）；
 * `memberKeys` / `memberMachineIds` / `selective` = 解析期由 `config.ts#parseProjectGroups`
 * 产出的**派生态**。成员判定**必须**同源于 `memberKey(machineId, projectId)`
 * （§2.3-I1 单一判据，禁第二套拼接）。
 */
export interface ProjectGroup {
  /**
   * 组名（v0.8.6 §2.2 B 形态起：`projectGroup[]` 段内**必填**，字符集 `[A-Za-z0-9_-]+`，
   * 且不得与保留 URL 首段冲突 —— 组名 = `/mcp` 端点地址的 URL 路径首段身份 `/<组名>/mcp`）；
   * `null` 仅出现在**非配置态**：`defaultProjectGroup()`（未配组全量接纳）与 `resolveGroup`
   * 未命中身份时构造的 fail-closed 空组（name = 该身份）。**不省略字段**。
   */
  name: string | null;
  /** 声明态成员（保持配置内声明顺序；重复项由派生集合去重） */
  members: ProjectMember[];
  /** 派生：成员 key 集合（由 `memberKey(machineId, projectId)` 构造） */
  memberKeys: Set<string>;
  /** 派生：成员机器 id 集合（「发现」路径的扫描范围收窄依据） */
  memberMachineIds: Set<string>;
  /** 派生：是否启用选择性连接（段缺省 ⇒ `false` = 全量接纳；配了组 ⇒ 每组恒 `true`） */
  selective: boolean;
}

/**
 * 顶层 `runner` 段（v0.7.0 D2；**配置可选**，解析后恒补齐为完整对象）。
 *
 * Runner 反向注册的时序阈值（均为**正整数毫秒**，非整数 / <1 / 类型错一律解析期 fail-fast）：
 * - `holdMs`：桥端 `/runner/connect` 长轮询单次挂起上限（缺省 `25000`）；
 *   空超时即视为**心跳**（poll 即心跳，不引 WS/SSE）。
 * - `heartbeatTimeoutMs`：注册心跳判死阈值（缺省 `60000`）；超期只降注册态，
 *   **不得触发 stop**（D8；清算 = requeue，见 B2）。
 * - `orphanTimeoutMs`：**孤儿墙钟判死阈值**（v0.8.7 O2；缺省 `1800000` = 30 min）。
 *   判据 `queue_state ∈ {claimed, running} ∧ claimed_at < now - orphanTimeoutMs` ⇒
 *   `sweepOrphanedTasks()` 置 `failed`（`failure_kind='infra'`）+ `task.orphaned` 事件。
 *   ⚠️ 跨单元不变量（写死）：`orphanTimeoutMs > dispatchTimeoutMs`（machine 侧有 ≤15 min
 *   上限护栏 + 300s margin ⇒ 恒 ≥1.5× 余量）；orch **不读 machine 配置**。
 */
export interface RunnerConfig {
  holdMs: number;
  heartbeatTimeoutMs: number;
  orphanTimeoutMs: number;
}

/** orch 侧：机器清单 */
export interface MachinesConfig {
  machines: MachineRef[];
  /** 桥 transport（v0.4.1；配置缺省时解析为 `mode = "http"`，stdio 已退役） */
  transport: TransportConfig;
  /** 网页端只读工作台（v0.5.0；配置缺省时解析为 `{ true, "127.0.0.1", 3300 }`） */
  web: WebConfig;
  /** Runner 阈值（v0.7.0；v0.8.7 O2 起含墙钟；配置缺省时解析为 `{ holdMs: 25000, heartbeatTimeoutMs: 60000, orphanTimeoutMs: 1800000 }`） */
  runner: RunnerConfig;
  /**
   * 静态项目组数组（v0.8.6 一桥多组 §2.1；`projectGroup` 段，**段缺省 / 未配任何组 ⇒ `[]` = 全量接纳**，
   * 由 `loadMachinesConfig()` **恒填充** —— 运行时不会出现 `undefined`；组间成员互斥 ⇒ 配置期 fail-fast）。
   * 字段可选仅为兼容既有 `MachinesConfig` 字面量夹具（N1 未迁移的构造点），生产路径恒有值。
   */
  groups?: ProjectGroup[];
  /**
   * **全组聚合视图**（v0.8.6 §2.1：`groups[]` 并为单 `ProjectGroup`，`selective` = `groups.length > 0`；
   * 空组 ⇒ `defaultProjectGroup()` 全量接纳）。
   * v0.8.6 N2 起桥侧组判定走 `bridge/index.ts#resolveGroup(identity)`；**N5 起 Runner claim 也已改读
   * `groups[]`「任一组放行」**（`bridge/runner.ts#claimableProjects`），本字段**生产路径已无消费者**，
   * 仅存量断言仍在校验聚合语义 —— 待收尾节点随 `aggregateProjectGroup` 一并退役。
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
   * **首次开工时刻**（v0.5.0，UTC ISO 8601）。
   *
   * **唯一写入点**（v0.8.7 O3 起）= `claimTask()` —— Runner **首次领取**时以 `COALESCE` 填充，
   * **登记时一律不填**（旧的 `createTask(state === "working")` 预填已摘除）⇒ 与「登记时刻」
   * 彻底脱钩 ⇒ 「排队多久 / 真跑了多久」第一次分得开（改造文档 §2.4 用户裁 ⑧ 第 ① 层）。
   * ⇒ 「只填一次」：重派 / 条件重试 / 心跳 requeue 后再领取**均不重置**起点。
   * 未开工（排队中、`input-required`）与 v0.5.0 老记录为 null。
   *
   * ⚠️ 旧口径所指的两个写口（`markTaskDispatchStarted` / `markTaskDispatched`）在 pull 模型下
   * **生产零调用**，已翻正为遗留原语。
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
   * **现行写入点**（v0.7.0 pull 起）= `enqueueTask()`（入队幂等占位，`COALESCE` 不刷新）；
   * `remoteTaskId` 由 Runner 回传经 `upsertTaskResult()` 回填。二者合起来表达「**已发出即有占位**」：
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
   * 失败分类（v0.4.1 引入；v0.6.1 REQ-05 起随五层删除**停止写入**；**v0.8.7 O3 恢复写入**）。
   *
   * 现行两处写口（改造文档 §2.3）：
   * - `/runner/result` 回传 ⇒ `setTaskFailureKind`（分类值 = orch 侧纯函数映射 machine 原生
   *   `AcpError.kind`，**映射权归 orch**；`spawn`/`closed` ⇒ `infra`，其余（含未知 / 缺失）⇒ `task`）；
   * - 孤儿墙钟判死 ⇒ `failOrphanedTask` 自置 `infra`（v0.8.7 O2）。
   *
   * ⚠️ **旧文本白名单分类器 `classifyFailure` 与旧写口 `markTaskFailureKind` 均不复活**
   * （判据已升级为结构化 kind）；**派发失败路径（`scheduler.ts`）本版不写** ⇒ 该路径仍为 `null`。
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
  /** `task.settled` / `task.blocked` / `feature.state` */
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
