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
 * v0.8.8（O1 硬切）：`failureKind` 取值集合由二分 `{infra, task}` 换为六类闭集（成员移除 = 单向不兼容）
 * ⇒ minor bump `2.2 → 2.3`（须两侧同升；握手仍只校验主版本）。
 */
export const PROTOCOL_VERSION = "2.3";

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
 * 职责位（任务类型）取值集合（**v0.10.2 O-1 引入；orch 单元内唯一枚举源**）。
 *
 * 取值集合的规范源 = 仓库根 `PROTOCOL.md` 的机器可解析 `task-types` 锚点；
 * orch（本常量）与 machine 侧对应模块**各自派生常量、不共享代码**（两单元自包含），
 * 两侧一致性由回归断言「本地清单 == 锚点」锁定（同 `AGENT_KINDS` 先例）。
 *
 * ⚠️ **缺省档 = `unit_agent`**（v0.8.10 `TASK_LANES` 的同形纪律）：本清单是**协议镜像**，
 * orch 不主动扩展 —— 成员变更（增 / 更名 / 移除）必须先改 `PROTOCOL.md` 再同步到这里。
 * 落库列 `tasks.task_type` 的 **NULL 一律归一为 `unit_agent`**（读侧 `readTaskType`）——
 * 反向（NULL 当其它档）等于给存量行凭空赋新语义。
 */
export const TASK_TYPES = ["unit_agent", "product_manager", "project_manager", "dev_manager"] as const;

/** 职责位（由 `TASK_TYPES` 派生；勿另立第二份清单） */
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * A2A 任务态。
 * `blocked` 为 **orch 本地专属**（v0.4.0 失败传播：上游失败 → 下游置 blocked），
 * **不映射 A2A**（A2A 无此态；派发/查询一律按 `working` 语义处理）。
 */
export type TaskState = "working" | "completed" | "failed" | "input-required" | "blocked";

/**
 * 任务并发档（v0.8.10 O-N1，落 `tasks.lane`）。
 *
 * - `write`：**写档** = 参与「同 project 串行门」的唯一档位（缺省档，向后兼容）；
 * - `read`：**只读档** = 退出写忙集 ⇒ 不再挡写、也不再被彼此的在队挡（读不挡写）。
 *
 * ⚠️ **落库 NULL 一律按 `write` 解释**（存量行 / 未带档的建行路径）—— 反过来（NULL 当只读）
 * 等于静默放宽串行门。SQL 侧两处判据（忙集谓词 / `claimTask` 写优先排序）都写成
 * `(lane IS NULL OR lane = 'write')`，**不得简化成 `lane = 'write'`**。
 */
export const TASK_LANES = ["read", "write"] as const;

/** 任务并发档（由 `TASK_LANES` 派生；勿另立第二份清单） */
export type TaskLane = (typeof TASK_LANES)[number];

/**
 * 任务失败分类**六类闭集**（v0.4.1 引入；v0.6.1 REQ-05 起休眠；v0.8.7 O3 按二分恢复；
 * **v0.8.8 O1 硬切为六类**）。
 *
 * ⚠️ **事实源 = `PROTOCOL.md` `/runner/result`「失败分类」条文（2.3 起）**：本清单是协议的
 * 镜像，**orch 不主动扩展** —— 闭集成员变更（增 / 更名 / 移除）必须先改 `PROTOCOL.md` 并
 * **两侧同升**（取值集合成员移除 = 单向不兼容），再同步到这里。
 *
 * - `agent`：后端 agent 本身起不来 / 不认（spawn 失败 / 进程中途退出 / 后端 `rpc`·`protocol` 语义拒绝）；
 * - `transport`：launcher ↔ 编排桥的 HTTP 传输层失败（`send` / `poll` 阶段）；
 * - `runner`：**载体侧事实**（launcher deadline 抛错 / `ensure` 抛错 / 启动补结算与墙钟孤儿）；
 * - `model_queue`：疑似模型侧排队 / 配额限流 —— **machine 恒不产出**，只由 orch 侧启发式**标注**；
 * - `timeout`：满窗，**必带子键** `diagnostics.timeoutScope`（`acp-prompt` / `runner-deadline` 分家）；
 * - `business`：后端正常收敛但业务失败 —— 亦是**安全兜底类**（落在「不可重试」侧）。
 *
 * 旧二分 `{infra, task}` 自 2.3 起**不再是合法取值**，但**接收端必须宽容**（混跑窗口内未升级的
 * 2.2 machine 仍原样上报）⇒ 一律兜底落 `business` + warn 留原值，见 `bridge/runner.ts`。
 * 自动重试的闭集白名单只有 `timeout × timeoutScope="acp-prompt" × 有实质产出` 一条（在 machine 侧执行）。
 */
export const FAILURE_KINDS = [
  "agent",
  "transport",
  "runner",
  "model_queue",
  "timeout",
  "business",
] as const;

/** 失败分类（由 `FAILURE_KINDS` 派生；勿另立第二份清单） */
export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * **墙钟判死**（孤儿清算）直写的分类（v0.8.8 O1）。
 *
 * 口径：领取后超 `runner.orphanTimeoutMs` 无回传 ⇒ **执行体已不在机上**，属**载体侧事实**，
 * 与 machine 侧「启动补结算孤儿」同类（协议条文 / 改造文档 §2.3 均定档 `runner`）。
 *
 * ⚠️ **不得取 `timeout`**：`timeout` 是场景 C 续跑的靶（`timeoutScope="acp-prompt"` + 有实质产出
 * ⇒ machine 可自动续跑一次），墙钟判死的任务**不可续跑** —— 若直写 `timeout`，trace 会把
 * 「人已走了」显示成「本可续跑」。v0.8.7 的 `infra` 直写口径随二分一并废止。
 */
export const ORPHAN_FAILURE_KIND: FailureKind = "runner";

/**
 * Feature 状态（v0.3.0；v0.4.1 REQ-04 收敛为 6 态主链；**v0.10.5 O1 扩为 8 态**）。
 * 主链（8）：waiting_approval → version_planning → decomposing → executing → integrating
 *   → testing → reviewing → completed；
 * 异常态（3）：needs_input / failed / cancelled；终态：completed / failed / cancelled。
 * `version_planning` = `approve` 之后的定版工序（PjM 结论收敛 + 归属落库）；
 * `decomposing` = 本侧任务清单回传 + DAG 节点登记完毕。两新态只加边、不改任何既有出边。
 * 前段三态（discussing / analyzing / planning）已删除：引擎只做需求实现，Step 0/1 不走引擎。
 * 合法流转由 `orch/feature/state-machine.ts` 纯模块强制（非法流转 fail-fast）。
 */
export type FeatureState =
  | "waiting_approval"
  | "version_planning"
  | "decomposing"
  | "executing"
  | "integrating"
  | "testing"
  | "reviewing"
  | "completed"
  | "needs_input"
  | "failed"
  | "cancelled";

/**
 * Feature **阶段登记**值域（v0.9.0 B1″，落 `features.stage`；**v0.10.5 O1 由 5 枚扩为 6 枚，新增「验收」**）。
 *
 * 只登记「引擎看不见的段」（`需求分析` / `改造方案` / `发版`）；`改造` / `回归` / `验收`
 * **由引擎态派生**，不重复登记。**序校验与回退限制都不做**（B5″）。
 */
export const FEATURE_STAGES = ["需求分析", "改造方案", "改造", "回归", "验收", "发版"] as const;

/** 阶段登记（由 `FEATURE_STAGES` 派生；勿另立第二份清单） */
export type FeatureStage = (typeof FEATURE_STAGES)[number];

/**
 * `create` 未传 `stage` 时的缺省值：取「改造方案」= 既有调用方（Step 1 产出后建 Feature）
 * 所处的段 ⇒ **既有行为逐字不变**。
 *
 * ⚠️ **v0.10.5 O1 起本常量只剩「读侧归一」一职**：`create` 侧的硬编码初值与「未传 ⇒ 本值」
 * 这条缺省路径随 O4 的 create 契约重构（摘 `stage`/`approval` 两入参、初值钉「需求分析」）退役；
 * 本值仍是**存量行 NULL 与 ctor 脏值归一的落点**（见 `session/store.ts` 的 `readStage`），故保留。
 */
export const DEFAULT_FEATURE_STAGE: FeatureStage = "改造方案";

/**
 * Feature **审批门状态**值域（v0.9.0 B1″，落 `features.approval`）—— **单向、无回边**。
 *
 * ⚠️ 字段**不得命名 `state`**（该名已属引擎态）。`approval = 待审批` 是 `approve` 六条过门判据里的
 * **②**（增补 `ec93e1bd` 起）—— 原句「`approve` 只校验 approval、不看 `stage`」只剩「①② 两条各自不查
 * `stage`」为真：`stage` 现已是判据 **⑤**（须已离开「需求分析」），但六条**仍不校验 `stage` 迁移序**。
 */
export const FEATURE_APPROVALS = ["未发起", "待审批", "已通过"] as const;

/** 审批门状态（由 `FEATURE_APPROVALS` 派生；勿另立第二份清单） */
export type FeatureApproval = (typeof FEATURE_APPROVALS)[number];

/**
 * `create` 未传 `approval` 时的缺省值（**v0.10.5 O4 起该路径已退役** —— create 摘 `approval`
 * 入参、初值硬编码「未发起」）。本常量只剩**读侧归一**一职：`NULL`（存量行）⇒ 本值、
 * **脏值**在 ctor 一次性归一（见 `session/store.ts` 的 `readApproval`），故保留。
 */
export const DEFAULT_FEATURE_APPROVAL: FeatureApproval = "待审批";

/** 收窄：unknown → FeatureStage（**唯一闭集判据**；handler 校验与读侧归一共用） */
export function isFeatureStage(v: unknown): v is FeatureStage {
  return typeof v === "string" && (FEATURE_STAGES as readonly string[]).includes(v);
}

/** 收窄：unknown → FeatureApproval（同上） */
export function isFeatureApproval(v: unknown): v is FeatureApproval {
  return typeof v === "string" && (FEATURE_APPROVALS as readonly string[]).includes(v);
}

/**
 * **版本台账状态**值域（v0.10.0 O4 · 改造文档 §2.1(1)/(3)，落 `versions.status`）—— 三态、**事实源在引擎**。
 *
 * - `notstart`：台账已建版号、尚未派发任何节点；
 * - `active`：首个节点派发 / `approve` 放行时引擎内部幂等转换（`notstart→active`，非板写口）；
 * - `released`：**已发版锁**的事实源 —— 排期写与 MCP 直写 `version` 一律不得写入 `released` 版号；
 *   标记 `released` 须经发版闸（判据见 `bridge/feature-tools.ts` 的 `evaluateReleaseGate`）。
 *
 * ⚠ 这是**版本**的状态，与 Feature 的 `stage`（观测登记字段）/ `state`（引擎态）三维正交、不得互推。
 */
export const VERSION_LEDGER_STATUSES = ["notstart", "active", "released"] as const;

/** 版本台账状态（由 `VERSION_LEDGER_STATUSES` 派生；勿另立第二份清单） */
export type VersionLedgerStatus = (typeof VERSION_LEDGER_STATUSES)[number];

/** 收窄：unknown → VersionLedgerStatus（台账读口对 `status` 列取值的唯一闭集判据） */
export function isVersionLedgerStatus(v: unknown): v is VersionLedgerStatus {
  return typeof v === "string" && (VERSION_LEDGER_STATUSES as readonly string[]).includes(v);
}

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
  /**
   * **父需求登记**（v0.9.3 O1 / parentFeatureId，落 `features.parent_feature_id`）：
   * 增补轨挂主需求的**单值**记录（只透不解析：不递归父链、不判环、无派生语义）。
   * `null` = 无父（合法缺省，存量行不回填）。
   */
  parentFeatureId: string | null;
  /**
   * **阶段登记**（v0.9.0 B1″ / B2″，落 `features.stage`）：值域见 {@link FEATURE_STAGES}。
   *
   * 类型**非空**是读侧单点归一的结论：`NULL`（存量行 / 未带值建行）一律按
   * {@link DEFAULT_FEATURE_STAGE} 读出；**脏值**（非法值）在 ctor 一次性归一 + 告警，
   * **读侧不 throw**（与 `lane` 同族纪律，区别于 `state` 的 fail-fast）。
   */
  stage: FeatureStage;
  /**
   * **版本登记**（v0.9.0 B1″，落 `features.version`）：自由文本，无闭集。
   * `NULL` ⇒ 空串（缺省空，类型非空同上）。
   */
  version: string;
  /**
   * **审批门状态**（v0.9.0 B1″ / B2″，落 `features.approval`）：值域见 {@link FEATURE_APPROVALS}，
   * `NULL` ⇒ {@link DEFAULT_FEATURE_APPROVAL}。`= 待审批` 是 `approve` 的**必要非充分**判据（六条之一，
   * 增补 `ec93e1bd` 起另加 ③ `version` 非空 / ④ 确认单在册 / ⑤ `stage` 非「需求分析」/ ⑥ 改造文档在册）。
   */
  approval: FeatureApproval;
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
   * （未配组环境的匿名入口）。落 `features.owner_group`，Feature 六出口的可见性/可操作性据此判定。
   */
  ownerGroup?: string | null;
  /**
   * **父需求登记**（v0.9.3 O1）：建 Feature 时一次性写入 `features.parent_feature_id`；
   * 缺省 / `null` = 无父。存在性与可见性校验在 handler（fail-closed），存储层不复核、不解析父链。
   */
  parentFeatureId?: string | null;
  /** 缺省 `waiting_approval`（主链起点 / 审批门停靠点） */
  state?: FeatureState;
  /**
   * **登记字段**（v0.9.0 B1″）：`NULL` 与「不传」等价（读侧按缺省）；闭集校验在 handler，
   * 存储层**不复核**（与 `state` 的 fail-fast 不同 —— 登记面不得抛）。
   */
  stage?: string | null;
  version?: string | null;
  approval?: string | null;
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
 *   `sweepOrphanedTasks()` 置 `failed`（`failure_kind='runner'` = 不可续跑的载体侧事实）+ `task.orphaned` 事件。
 *   ⚠️ 跨单元不变量（写死）：`orphanTimeoutMs`（缺省 1800s）> machine 最坏总框
 *   （= 窗上限 600s + 结构余量 300s + `min(续跑余量, 窗)` ≤ 600s ⇒ 1500s），边际 300s；
 *   orch **不读 machine 配置**。
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
  /**
   * **并发档**（v0.8.10 O-N1，落 `tasks.lane`；取值见 {@link TASK_LANES}）。
   *
   * 声明形态：MCP 入参 `readOnly`（O-N4）→ 落库本列 → 透传 machine（`DispatchCommand.readOnly?`）。
   * **读侧不存在 NULL**：列里的 NULL 一律归一为 `write`（保守、向后兼容，见 `TASK_LANES` 注记）。
   *
   * ★ **三条跨侧事实**（读账 / 排查「为什么没并行」时缺一不可，勿在本列语义里合并它们）：
   * 1. **领取次序（写优先）= orch 的 `claimTask`** —— 候选排序把写档整体排在只读档之前
   *    （否则早入队的 read 会顶掉晚入队的 write）。**这只决定「谁先被领」，不决定「谁在挡谁」**。
   * 2. **实际并发 = machine 的闸**（`maxConcurrentWrites` / `maxConcurrentReads`，缺省 1/1）——
   *    orch 侧**不做第二道闸**（真资源只在 machine 可见；orch 侧闸对不经调度器的散活天然有洞）。
   *    ⇒ **两个时钟不得相加**：orch 领取队列的等待 ≠ machine 本机闸内等待。
   * 3. **同批认领布尔本版刻意不改**（`computeReadyNodes` 的 `claimed: Set<projectId>`）——
   *    同一 tick 同 project 至多放行一个节点（含两个 read）。这是**防洪泛的特性**，不是缺陷；
   *    放开它 = 一次 tick 内同 project 并发起多个后端会话，属下一版议题。
   *
   * ⚠️ **忙集（挡人面）只看写档**：只读节点在飞 ⇒ 项目**不算忙**；写节点在飞 ⇒ 项目忙 ⇒
   *    同 project 的读写节点都等（本版**不**放开「写挡读」）。
   */
  lane: TaskLane;
  /**
   * **职责位**（v0.10.2 O-1，落 `tasks.task_type`；取值见 {@link TASK_TYPES}）。
   *
   * 声明形态（与 `lane` 同一条链，O-1 只落「值域 + 落库」两段）：入参 `taskType` → 落库本列 →
   * 透传 machine（`DispatchCommand.taskType?`）。
   *
   * **读侧不存在 NULL**：列里的 NULL 一律归一为缺省档 `unit_agent`（= 本字段引入前的唯一行为）。
   * 落库侧 NULL 承载的是「**未声明**」这一事实 ⇒ 迁移**不回填**、写侧 `COALESCE` 保留首次声明
   * （与 `lane` 的「NULL 归保守档 + COALESCE 保首次档」同形，兜底方向按各自缺省档取）。
   */
  taskType: TaskType;
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
  /**
   * Feature 排队节点的**未渲染 base**（原始消息 + 历次澄清追加）。
   * v0.8.9 O2 起派发渲染结果**不再回写本列**（只落 `dispatchRendered` 快照），
   * 本列恒干净可重放；派发后保留（作为可重派依据）。
   */
  dispatchMessage: string | null;
  /**
   * **本次派发的渲染快照**（v0.8.9 O1 加列，落 `tasks.dispatch_rendered`；**覆盖写**）。
   *
   * 与 `dispatchMessage` 的分工（改造文档 §2 纯丙）：`dispatch_message` = **未渲染的 base**
   * （原始消息 + 历次澄清追加，唯一事实源、不再被渲染结果回写污染）；`dispatch_rendered` =
   * **每轮派发实际下发的全文**（含 `<feature-context>` 等外壳）。二者分离后「同一 base 反复
   * 派发 ⇒ 外壳层层叠加」才可观测、可消除。
   *
   * **本列由 O2 接上写口**（`dispatchFeatureNode` 渲染结果只写本列、永不回写 base）；
   * NULL = 历史行 / 未渲染 ⇒ 领取侧走 `?? dispatchMessage` 兜底，行为与 v0.8.8 逐字一致。
   */
  dispatchRendered?: string | null;
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
   * 失败分类（v0.4.1 引入；v0.6.1 REQ-05 起随五层删除**停止写入**；v0.8.7 O3 恢复写入；
   * **v0.8.8 O1 起取值为六类闭集**，见 {@link FAILURE_KINDS}）。
   *
   * 现行两处写口（改造文档 §2.1）：
   * - `/runner/result` 回传 ⇒ `setTaskFailureKind`（**分类事实源 = machine 上报的 `failureKind`**，
   *   orch 只做**闭集校验 + 落库**；未上报合格六类值时才落兜底：缺键 ⇒ 由原生 `AcpError.kind`
   *   经 `mapAcpErrorKindToFailureKind` 取安全值（`spawn`/`closed` ⇒ `agent`），旧值 / 未知值 ⇒
   *   `business`；两条兜底路径均 warn 留原值）；
   * - 孤儿墙钟判死 ⇒ `failOrphanedTask` 自置 `runner`（载体侧事实、**不可续跑**；v0.8.7 的
   *   `infra` 直写口径废止）。
   *
   * ⚠️ **旧文本白名单分类器 `classifyFailure` 与旧写口 `markTaskFailureKind` 均不复活**
   * （判据已升级为结构化 kind）；**派发失败路径（`scheduler.ts`）不写** ⇒ 该路径仍为 `null`。
   */
  failureKind: FailureKind | null;
  /**
   * **machine 上报的 `diagnostics` 宽 JSON 原文**（v0.8.8 O3 · 改造文档 §2.2 / §2.5 落库口径）。
   *
   * 唯一写口 = `upsertTaskResult()`（`/runner/result` 结果落库路径，COALESCE ⇒ 迟到件不覆写）。
   * **原样序列化落库、不压成派生布尔**：排队可见面与限流（v0.8.10）要在这些原料上叠判据
   * （`firstChunkElapsedMs` / `promptElapsedMs` / `bridgeEnsureElapsedMs` / `timeoutScope` /
   * `acpErrorCode` / `acpErrorData` / `partialChars` / `updateCount` / `sessionResumed` /
   * `continueAttempts` / `continueTrigger` / `partialTailChars` / `workspaceTouched` /
   * `touchedFileCount`），只落布尔 = 把原料丢掉（§2.5「返工红线」）。
   *
   * NULL = 机侧未带 diagnostics / 升级前的存量行。**不落 `retry_count`**：续跑与宿主重派是
   * 正交两口径（§2.2），本列只承载机侧事实原文。
   */
  diagnosticsJson?: string | null;
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
  /** `task.settled` / `task.blocked` / `task.continued` / `feature.state` */
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
  /**
   * **并发档**（v0.10.2 O-3 补齐；与 `a2a_feature_status` / `a2a_feature_trace` 同字段同语义）。
   *
   * 本面此前**连 `lane` 都没有** —— 三读出参长期不一致，一并补齐（读侧 NULL 已归一 `write`，恒有值）。
   */
  lane: TaskLane;
  /**
   * **职责位**（v0.10.2 O-3；与 `lane` 同一条声明链的两个读出面）：
   * 读侧不存在 NULL（列里的 NULL 已归一缺省档 `unit_agent`）⇒ **恒有值、不得省略字段**。
   */
  taskType: TaskType;
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
