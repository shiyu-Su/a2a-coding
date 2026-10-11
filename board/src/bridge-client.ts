/**
 * board 侧对编排桥的**只读** API 客户端（BD1 骨架）。
 *
 * 硬约束：
 * - **仅 GET**：本模块只提供 GET 路径，不封装任何写操作；
 * - **不碰事件游标**：桥 `/api/events` 的游标语义一律不触碰（事件读取口径由后续节点专门处理）；
 * - 数据源 = 桥既有只读接面（`/api/features` / `/api/features/:id` / `/api/features/:id/trace`）
 *   + 引擎版本台账读端点（v0.10.0 B4：`GET <引擎可写面>/api/versions`，与版本写面同端、**仍是 GET**，
 *   见 {@link createEngineVersionsFetcher}）。
 *
 * 解析逻辑与网络调用**分离**：`parse*` 是纯函数（输入已解析 JSON，输出归一视图），
 * 便于不依赖桥在跑即单测；`get*` 负责 fetch + JSON.parse 后委派给对应 `parse*`。
 */

/** 桥缺省基址（3300 = 只读运维视图端口） */
export const DEFAULT_BRIDGE_BASE_URL = "http://127.0.0.1:3300";

export interface BridgeClientOptions {
  /** 桥基址，缺省 {@link DEFAULT_BRIDGE_BASE_URL} */
  baseUrl?: string;
  /** fetch 实现（测试注入用）；缺省 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（ms），缺省 10_000 */
  timeoutMs?: number;
}

/**
 * 版本台账读面基址：与**引擎版本写面同端**（`versions-write.ts` 的
 * `DEFAULT_ENGINE_BASE_URL` = 可写面 8787）。本客户端缺省仍走 3300 只读面，
 * 故版本台账读单独注入该基址（板不直连 machine、也不另立第三个面）。
 */
export const DEFAULT_ENGINE_VERSIONS_BASE_URL = "http://127.0.0.1:8787";

/** 引擎版本台账读端点（改造文档 §2.1(2)：板读投影唯一来源）。 */
export const ENGINE_VERSIONS_QUERY_PATH = "/api/versions";

export interface BridgeClient {
  readonly baseUrl: string;
  getFeatures(): Promise<FeaturesListView>;
  getFeature(featureId: string): Promise<FeatureDetailView>;
  getFeatureTrace(featureId: string): Promise<FeatureTraceView>;
  getProjects(): Promise<ProjectsView>;
  /**
   * `GET /api/registry/projects`（v0.9.8 N1 新只读面）：以 **runners 表为遍历源**的项目清单 ——
   * 离线机及其项目照常列出（机级 `runnerState=offline`），无组布尔（C-2）。
   * **缺 `machines[]` ⇒ 抛 `response_invalid`（fail-closed，绝不降级成空池）**。
   */
  getRegistryProjects(): Promise<RegistryProjectsView>;
  getTasks(projectId: string, options?: GetTasksOptions): Promise<ProjectTasksView>;
  /**
   * **单任务 state 只读探针**（v0.9.5 C8 · T8）：`GET /api/tasks/:taskId`（与宿主 `watch-task.mjs`
   * 同一只读面），供心跳判 `pending` 子任务是否就绪。**未知 id（404 / `task_not_found`）⇒ `null`**，
   * 其余传输 / 格式错误照常抛（保守侧不假唤醒由调用方处理）。仍满足 GET-only 硬约束。
   */
  getTask(taskId: string): Promise<TaskStateView | null>;
}

// ---------------------------------------------------------------------------
// 归一视图（字段对齐桥出参；缺字段容错为 null / 空数组，不臆造）
// ---------------------------------------------------------------------------

export interface FeatureListItem {
  featureId: string;
  state: string;
  title: string;
  /** 需求原文（桥列表出参已透出该键，`…title,requirement,contextId,plan,…`）；老桥缺列 ⇒ null 容错。 */
  requirement: string | null;
  taskCount: number | null;
  ownerGroup: string | null;
  /**
   * 登记字段（v0.9.0 B1″，桥读侧单点归一后**非空**；此处仍容错为 null —— 混跑期老桥缺列时
   * 如实显示「未知」，不臆造缺省值）。派生展示规则见 `derive.ts` 的 `deriveDisplayStage`。
   */
  stage: string | null;
  version: string | null;
  approval: string | null;
  /** 增补 Feature 的父需求 id（v0.9.3 B1 读面标注）；老桥无此列 ⇒ null 容错，口径同 stage。 */
  parentFeatureId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * 该 Feature 内的 per-state 计数（桥 B3″ 的 per-feature 聚合，`GROUP BY feature_id, state`）。
   * **`{}` 是零任务的正常值**；仅当桥未透出该字段（老桥）时为 `null`。
   */
  stateCounts: StateCounts | null;
}

/**
 * 各态分布：桥 `GET /api/features` 的聚合口径是 **per-feature**（每项自带 `stateCounts`），
 * 全局分布由板侧把各项按状态累加得到，**不做任何额外查询**。
 */
export type StateCounts = Record<string, number>;

export interface FeaturesListView {
  features: FeatureListItem[];
  /**
   * 板侧本地聚合的全局分布（各项 `stateCounts` 按状态累加）。
   * `null` = 列表非空但**没有任何一项**带 `stateCounts`（老桥）⇒ 列表页显示降级文案；
   * `{}` = 有字段但全是零任务，或列表本身为空 ⇒ 是真实的空分布，不是缺位。
   */
  stateCounts: StateCounts | null;
}

export interface FeatureTaskItem {
  taskId: string;
  projectId: string;
  state: string;
  lane: string;
  failureKind: string | null;
  retryCount: number | null;
  dependencies: string[] | null;
  /**
   * 三时刻 + 队列四字段（v0.9.3 B-T4 3300 收编补差）：桥详情分支
   * `GET /api/features/:id` 对每个任务摘要就地补投影（`web.ts` `withFeatureTaskTimings`）。
   * 老桥 / 缺键 ⇒ `null`（不臆造、不拿 `updatedAt` 顶替），渲染层出 `—`。
   */
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** 队列态原样透传（值域归桥，板不自造中文词，口径同 trace `waitReason`）。 */
  queueState: string | null;
  /** 入队时刻（排队区间起点：`queuedAt → claimedAt`）。 */
  queuedAt: string | null;
  /** 首次领取时刻（排队区间终点；在飞/未领取 ⇒ null）。 */
  claimedAt: string | null;
  claimedBy: string | null;
  /**
   * 派发消息落库片段（桥 `summarizeTask` 的截断 `prompt`，非全文）。
   * 增补轨 III N1 依赖图节点「任务要点」的数据源；老桥 / 缺键 ⇒ null（容错回退裸 taskId）。
   */
  prompt: string | null;
  /** 职责位原样透传（值域归桥，板不自造中文词，口径同 trace `waitReason`）。 */
  taskType: string | null;
}

/**
 * acceptance 主链段轨迹的一格（桥单查顶层 `acceptance.stages[]`，v0.9.2 N8 消费）。
 * **`state` 值域非封闭**（存量库有已退役值 analyzing / planning）⇒ 原样透传，不校验。
 */
export interface AcceptanceStageView {
  state: string;
  enteredAt: string | null;
  /** null = 末段（Feature 现停在此态）或缺键；渲染层按「是否末段」区分语义 */
  leftAt: string | null;
}

/** 一条失败账单（`acceptance.failures[]`）。`payload` = 事件 payload 原文 JSON 字符串（可 null），内层键不作契约。 */
export interface AcceptanceFailureView {
  eventId: number | null;
  at: string | null;
  payload: string | null;
}

/**
 * 详情页验收轨迹块（= 桥 `GET /api/features/:id` 出参**顶层** `acceptance` 键，非 feature 内；
 * 列表出参无该键）。老桥 / 缺键 ⇒ `null` ⇒ 详情页现行为。
 */
export interface AcceptanceView {
  stages: AcceptanceStageView[];
  failures: AcceptanceFailureView[];
  stateCounts: StateCounts;
}

export interface FeatureDetailView {
  feature: {
    featureId: string;
    state: string;
    title: string;
    plan: string | null;
    ownerGroup: string | null;
    /** 登记字段（v0.9.0 B1″）；容错口径同 {@link FeatureListItem.stage} */
    stage: string | null;
    version: string | null;
    approval: string | null;
    /** 增补 Feature 的父需求 id（v0.9.3 B1 读面标注）；老桥无此列 ⇒ null 容错，口径同 {@link FeatureListItem.parentFeatureId} */
    parentFeatureId: string | null;
    /** 需求原文（v0.9.5 C4 上详情页）：桥详情出参照列表面透出该键；老桥缺列 ⇒ null 容错，口径同 {@link FeatureListItem.requirement}。 */
    requirement: string | null;
    /**
     * Feature Context（BD11 · 阶段产出上板）：桥侧存的是 JSON 字符串（数组归一化属渲染层），
     * 老桥 / 未登记 ⇒ null。
     */
    decisions: string | null;
    contracts: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  };
  tasks: FeatureTaskItem[];
  /** 详情出参顶层 `acceptance` 块；老桥 / 缺键 / 非对象 ⇒ null（现行为） */
  acceptance: AcceptanceView | null;
  /**
   * 详情出参顶层 `projects[]`（归属 / 承诺集读面，v0.10.2 N6）：
   * 数组 ⇒ 逐条 camelCase 两键；**键缺位 / 非数组 ⇒ null**（缺面 ≠ 空面，口径同 {@link projectVersionsOf}）；
   * `[]` ⇒ 空数组 = 合法事实「该需求未归属任何 project」（与 null 的「面不可读」必须可区分）。
   */
  projects: { projectId: string; version: string }[] | null;
}

/** `GET /api/projects` 归一视图（快照语义：`observedAt` + note，非实时在线） */
export interface ProjectEntry {
  projectId: string;
  agentKind: string | null;
  a2aPort: number | null;
  status: string | null;
  endpoint: string | null;
  startedAt: string | null;
}

export interface ProjectMachineEntry {
  machineId: string;
  error: string | null;
  projects: ProjectEntry[];
}

export interface RunnerEntry {
  machineId: string;
  online: boolean;
  lastHeartbeatAt: string | null;
}

export interface ProjectsView {
  source: string | null;
  note: string | null;
  observedAt: string | null;
  machines: ProjectMachineEntry[];
  runners: RunnerEntry[];
}

/**
 * `GET /api/registry/projects`（v0.9.8 N2）归一视图 —— 与 {@link ProjectsView} **是两个独立读路**
 * （C-6：本面直连 orch `listRunners` / `listRunnerProjects`，与 `/api/projects` 不交叉复用）。
 *
 * 契约要点（C-1…C-5，边界 3 轮收敛产物，实现期不得越界）：
 * - 遍历源 = runners 表：在线机、**离线机含其项目**、注册过但零项目（`projects: []`）均出现；
 * - 出参**无任何组布尔**（declared / inGroup / group / groups / ownerGroupName），本面也不消费；
 * - 机级无 `error` 字段（离线机不发 error 文案，靠 `runnerState="offline"` + `lastHeartbeatAt`）；
 * - 项目级字段与 {@link ProjectEntry} 逐字兼容（C-5）＋ `lastReportedAt`（C-4），**无 `runnerId`**。
 */
export interface RegistryProjectEntry extends ProjectEntry {
  /** 项目最后一次上报时刻（`runnerProjectsReplace` 写入）；缺键 ⇒ null。 */
  lastReportedAt: string | null;
}

export interface RegistryMachineEntry {
  machineId: string;
  /** 值域 = `online` / `offline`（值域归桥，板不自造中文词、不做实时探测）。 */
  runnerState: string | null;
  lastHeartbeatAt: string | null;
  firstRegisteredAt: string | null;
  projects: RegistryProjectEntry[];
}

export interface RegistryProjectsView {
  source: string | null;
  note: string | null;
  observedAt: string | null;
  machines: RegistryMachineEntry[];
  /** 桥侧自报计数（缺键 / 非数字 ⇒ null，不作校验、不参与差集）。 */
  counts: { machines: number | null; projects: number | null };
}

/** `GET /api/tasks?project=…` 归一视图（`project` 为桥侧必填参数） */
export interface GetTasksOptions {
  state?: string;
  limit?: number;
}

export interface ProjectTaskItem {
  taskId: string;
  contextId: string | null;
  state: string;
  prompt: string | null;
  text: string | null;
  updatedAt: string | null;
  stale: boolean;
  /**
   * 首次领取时刻（v0.9.3 B-T3 在飞区的排序键）。桥 `/api/tasks` 出参**当前未投影该键** ⇒
   * 容错为 `null`（不臆造、不拿 `updatedAt` 顶替）；排序侧把 `null` 沉底（见 `agent-view.ts`）。
   */
  claimedAt: string | null;
}

export interface ProjectTasksView {
  projectId: string;
  reachable: boolean;
  notice: string | null;
  tasks: ProjectTaskItem[];
}

/**
 * `GET /api/tasks/:taskId` 的归一视图（v0.9.5 C8 · T8 心跳的子任务就绪探针）：
 * 只取 `state`（原样透传，值域归桥，板不自造中文词）；`taskId` 容错为 `null`（桥出参未必带）。
 */
export interface TaskStateView {
  taskId: string | null;
  state: string;
}

/**
 * 引擎版本台账投影的一行（v0.10.0 B4 · 改造文档 §2.1(2) / §2.3(1)）—— 只投影**锁与列并集需要的
 * 键**（`ownerGroup / version / status`），其余列（`date / note / createdAt / updatedAt`）本版不消费。
 * **本接口是 Group 档（`versions[]`）的成员类型：v0.10.1 硬约束 —— 成员与语义零改动，
 * project 档不得混入本接口**（负向钉见 `test/v0101-engine-project-versions-parse.test.mjs`）。
 */
export interface EngineVersionEntry {
  /** 归属组织（引擎 `owner_group`；`null` / 缺键 ⇒ 未归属桶 = 板台账的 `""` 同构语义）。 */
  org: string;
  version: string;
  /**
   * 版本状态（三态 `notstart / active / released`）。值域**不归一、不校验、不回落** —— 非字符串 ⇒
   * `null`，由消费侧按「非 `released`」处理（缺状态绝不当作已发版）。
   */
  status: string | null;
}

/**
 * 引擎版本台账投影（**已发版锁的唯一数据源**）。
 * `capturedAt` = 本次成功读取的时刻（板进程内保留「最后一次投影」时用于如实标注新鲜度）。
 *
 * `projectVersions`（v0.10.1 B1 · C-7）= project 档的**独立缺位承载**：Group 面投影成立时，
 * project 面仍可能「未上线」（顶层字段缺位 / 形状不合法）⇒ 两档分立，互不牵连（C-12）。
 */
export interface EngineVersionsProjection {
  entries: EngineVersionEntry[];
  capturedAt: string;
  /**
   * project 档三态（见 {@link ProjectVersionsField}）；**缺位 ≠ 空数组**，两种显示必须可区分。
   * 解析结果恒带本字段；**夹具的老引擎档 / 历史最后一次投影可能不带** ⇒ 消费侧经
   * {@link projectVersionsOf} 归一读取（`undefined` ⇒ `absent`，不得当作 empty）。
   */
  projectVersions: ProjectVersionsField;
}

/**
 * project 级版本台账的一行（v0.10.1 B1 · C-7 最小键集）。
 * 值域不归一、不校验；**缺键 ⇒ `null`、不猜**（`—` 一类的缺省显示归消费侧，解析层不替引擎补默认）。
 *
 * **v0.10.2 消费面现状**（原排期页 project 版本区块已摘 ⇒ 下列字段不再有板侧显示面，但**仍如实解析、
 * 不裁字段**）：板当前只消费 `org` / `projectId` / `status`（管理页「已发布的最新版本号」列）；
 * `releasable` / 三枚计数 / `reason` / `repoId` / `ref` = **暂无消费面**（引擎自报值，留作读面恢复时的
 * 数据源）。若将来再渲 `releasable`：其缺位是「引擎闸未上线」的过渡档，**不得渲染成「不可发版」**
 * （未知 ≠ 假否定）。
 */
export interface EngineProjectVersionEntry {
  /** 归属组织（引擎 `owner_group`）；缺键 ⇒ 未归属桶 `""`（口径同 {@link EngineVersionEntry.org}）。 */
  org: string;
  /** 归属 project（引擎 `project_id`）；缺失 / 空白的条目在解析层整条丢弃。 */
  projectId: string;
  /** Project Version；缺失 / 空白的条目在解析层整条丢弃。 */
  version: string;
  /** 值域归引擎（`open / released` 等）；非字符串 ⇒ `null`，板不回落、不猜。 */
  status: string | null;
  /** 展示字段（C-4 级联档：project 收口判据降为展示，**不是发版口**）；缺键 ⇒ `null`（板不重算、不判 project 闸）。 */
  releasable: boolean | null;
  /** 以下计数为引擎自报展示值；缺键 / 非数字 ⇒ `null`，板不重算、不与 Group 计数互校（C-18⑥）。 */
  openCount: number | null;
  completedCount: number | null;
  cancelledCount: number | null;
  /** 不可发版原因（展示字段，板侧暂无消费面）；缺键 ⇒ `null`。 */
  reason: string | null;
  /** 仓库标识（展示字段，板侧暂无消费面）；缺键 ⇒ `null`。 */
  repoId: string | null;
  /** 交付引用（展示字段，板侧暂无消费面；交付快照本身板不显示 ★R3）；缺键 ⇒ `null`。 */
  ref: string | null;
}

/**
 * project 档的三态（**两档分立**判据的载体，C-7 / C-12）：
 * - `live` ⇒ 顶层 `projectVersions[]` 在场且**至少一条合法条目**；
 * - `empty` ⇒ 字段在场但**零合法条目** —— 这是**合法事实**（「未登记，本版本起生效」档），
 *   与 `absent`（面未上线）**两种显示必须可区分**；
 * - `absent` ⇒ 顶层字段**缺位 / 非数组** ⇒ project 面单独降级（`error` 文案含「引擎 project 版本面
 *   未上线」；v0.10.2 起**唯一显示面** = 管理页「配置核对」卡第三行，`empty` / `absent` 的可区分性
 *   就落在这一行 ⇒ 项目卡新列对二者同显 `—`，裁定④），
 *   **Group 面（版本列 / 锁 / 门户摘要）一切照常**，不牵连排期写门（project 降级**不进** fail-closed）。
 */
export type ProjectVersionsField =
  | { status: "live"; entries: EngineProjectVersionEntry[] }
  | { status: "empty" }
  | { status: "absent"; code: string; error: string };

/**
 * `GET /api/versions` 的两种「读到了」的结果（v0.10.0 B4）：
 * - **projection** ⇒ 引擎台账在场（空台账 = 合法零条目，锁集为空是真事实）；
 * - **absent** ⇒ 响应合法但**没有 `versions[]` 面**（老桥 / 该端点未上线的引擎）⇒ 调用方按
 *   「拿不到台账投影」处理（**fail-closed 挡排期写**），绝不当成「零个已发版」放行。
 * 二者都不抛：传输层失败 / 非 2xx / 坏 JSON 一律收口为 outcome（宕机不阻断页面渲染，口径同
 * `orgs-view.createOrgGroupsFetcher`）。
 *
 * **v0.10.1 B1 两档分立（C-12）**：`kind:"absent"` **只由 Group 面（`versions[]`）决定** ——
 * project 面的缺位**不新增 kind**，落在 projection 内的 `projectVersions` 独立档上（见
 * {@link ProjectVersionsField}）。`versions[]` 在场 ∧ `projectVersions[]` 缺位 ⇒ Group 面
 * **一切照常**（版本列 / 锁 / 门户摘要），仅 project 面降级，**绝不外溢成排期写停摆**。
 */
export type EngineVersionsOutcome =
  | { kind: "projection"; projection: EngineVersionsProjection }
  | { kind: "absent"; code: string; error: string };

export interface TraceProjectBusy {
  busy: boolean;
  taskId: string | null;
  machineId: string | null;
}

export interface TraceReadOccupant {
  taskId: string;
  featureId: string | null;
  queueState: string | null;
  machineId: string | null;
  queuedAt: string | null;
}

export interface TraceNode {
  taskId: string;
  projectId: string;
  state: string;
  lane: string;
  queueState: string | null;
  waitReason: string;
  blockedOn: string[];
  projectBusy: TraceProjectBusy;
  readOccupants: TraceReadOccupant[];
  position: number | null;
  waitedSince: string | null;
}

export interface FeatureTraceView {
  featureId: string;
  featureState: string;
  nodes: TraceNode[];
}

// ---------------------------------------------------------------------------
// 纯解析函数（无 I/O；单测目标）
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function reqStr(v: unknown, field: string): string {
  if (typeof v !== "string") throw new BridgeResponseError(`${field} 缺失或非字符串`);
  return v;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean {
  return v === true;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** 校验桥统一响应外层（`ok` 为真值才继续），否则抛出携带 code/error 的错误。 */
function expectOk(json: unknown, ctx: string): Record<string, unknown> {
  if (!isRecord(json)) throw new BridgeResponseError(`${ctx}：响应不是 JSON 对象`);
  if (json.ok !== true) {
    const code = str(json.code) ?? "unknown";
    const error = str(json.error) ?? "响应缺少 ok:true";
    throw new BridgeResponseError(`${ctx}：桥返回失败 [${code}] ${error}`, code);
  }
  return json;
}

/** `GET /api/features` → 列表视图（纯函数）。 */
export function parseFeaturesList(json: unknown): FeaturesListView {
  const body = expectOk(json, "features 列表");
  const raw = Array.isArray(body.features) ? body.features : [];
  const features: FeatureListItem[] = raw.map((entry) => {
    const f = isRecord(entry) ? entry : {};
    return {
      featureId: reqStr(f.featureId, "feature.featureId"),
      state: reqStr(f.state, "feature.state"),
      title: str(f.title) ?? "",
      requirement: str(f.requirement),
      taskCount: num(f.taskCount),
      ownerGroup: str(f.ownerGroup),
      stage: str(f.stage),
      version: str(f.version),
      approval: str(f.approval),
      parentFeatureId: str(f.parentFeatureId),
      createdAt: str(f.createdAt),
      updatedAt: str(f.updatedAt),
      stateCounts: parseStateCounts(f.stateCounts),
    };
  });
  return { features, stateCounts: aggregateStateCounts(features) };
}

/**
 * 字段在场即为可用：对象 ⇒ 原样收下（**`{}` 是零任务的正常值，不是缺位**）；
 * 非对象（缺失 / `undefined` / 老桥）⇒ `null`。非数字值的键忽略。
 */
function parseStateCounts(v: unknown): StateCounts | null {
  if (!isRecord(v)) return null;
  const out: StateCounts = {};
  for (const [k, val] of Object.entries(v)) {
    const n = num(val);
    if (n !== null) out[k] = n;
  }
  return out;
}

/** 把各项的 per-feature `stateCounts` 累加成全局分布；老桥（全体缺字段）⇒ `null`。 */
function aggregateStateCounts(features: readonly FeatureListItem[]): StateCounts | null {
  const out: StateCounts = {};
  let anyField = false;
  for (const f of features) {
    if (f.stateCounts === null) continue;
    anyField = true;
    for (const [k, n] of Object.entries(f.stateCounts)) {
      out[k] = (out[k] ?? 0) + n;
    }
  }
  if (!anyField) return features.length === 0 ? {} : null;
  return out;
}

/** `GET /api/features/:featureId` → 详情视图（纯函数）。 */
export function parseFeatureDetail(json: unknown): FeatureDetailView {
  const body = expectOk(json, "feature 详情");
  const feature = isRecord(body.feature) ? body.feature : {};
  const rawTasks = Array.isArray(body.tasks) ? body.tasks : [];
  const tasks: FeatureTaskItem[] = rawTasks.map((entry) => {
    const t = isRecord(entry) ? entry : {};
    return {
      taskId: reqStr(t.taskId, "task.taskId"),
      projectId: reqStr(t.projectId, "task.projectId"),
      state: reqStr(t.state, "task.state"),
      lane: str(t.lane) ?? "write",
      failureKind: str(t.failureKind),
      retryCount: num(t.retryCount),
      dependencies: t.dependencies === null ? null : strArray(t.dependencies),
      createdAt: str(t.createdAt),
      startedAt: str(t.startedAt),
      finishedAt: str(t.finishedAt),
      queueState: str(t.queueState),
      queuedAt: str(t.queuedAt),
      claimedAt: str(t.claimedAt),
      claimedBy: str(t.claimedBy),
      prompt: str(t.prompt),
      taskType: str(t.taskType),
    };
  });
  return {
    feature: {
      featureId: reqStr(feature.featureId, "feature.featureId"),
      state: reqStr(feature.state, "feature.state"),
      title: str(feature.title) ?? "",
      plan: str(feature.plan),
      ownerGroup: str(feature.ownerGroup),
      stage: str(feature.stage),
      version: str(feature.version),
      approval: str(feature.approval),
      parentFeatureId: str(feature.parentFeatureId),
      requirement: str(feature.requirement),
      decisions: str(feature.decisions),
      contracts: str(feature.contracts),
      createdAt: str(feature.createdAt),
      updatedAt: str(feature.updatedAt),
    },
    tasks,
    acceptance: parseAcceptance(body.acceptance),
    projects: parseFeatureProjects(body.projects),
  };
}

/**
 * 顶层 `projects[]`（归属 / 承诺集，v0.10.2 N6）三态解析：
 *
 * - 键**缺位 / 非数组** ⇒ `null`（归属面不可读；**缺面 ≠ 空面**，口径同 {@link projectVersionsOf}）；
 * - 数组 ⇒ 逐条**严格取 camelCase 两键**（一手核实桥出参为 camelCase，不做 snake_case 双形容错）；
 * - `[]` ⇒ 空数组（合法的「未归属」事实，不得吞成 null）。
 * 条目缺任一非空白字符串键 ⇒ 整条丢弃（口径同 project 档「无版号不成条目」），不抛。
 */
function parseFeatureProjects(v: unknown): FeatureDetailView["projects"] {
  if (!Array.isArray(v)) return null;
  const out: { projectId: string; version: string }[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const projectId = str(item.projectId)?.trim();
    const version = str(item.version)?.trim();
    if (!projectId || !version) continue;
    out.push({ projectId, version });
  }
  return out;
}

/**
 * 顶层 `acceptance` 块（v0.9.2 N8）：**非对象（缺失 / 老桥）⇒ null**；对象 ⇒ 逐键容错展开
 * （空对象 = 合法的零段轨迹，不是缺位）。只消费 orch 聚合结果，不在板侧重算、不按 state 反推。
 */
function parseAcceptance(v: unknown): AcceptanceView | null {
  if (!isRecord(v)) return null;
  const rawStages = Array.isArray(v.stages) ? v.stages : [];
  const stages: AcceptanceStageView[] = rawStages.map((entry) => {
    const s = isRecord(entry) ? entry : {};
    return {
      state: str(s.state) ?? "",
      enteredAt: str(s.enteredAt),
      leftAt: str(s.leftAt),
    };
  });
  const rawFailures = Array.isArray(v.failures) ? v.failures : [];
  const failures: AcceptanceFailureView[] = rawFailures.map((entry) => {
    const fl = isRecord(entry) ? entry : {};
    return { eventId: num(fl.eventId), at: str(fl.at), payload: str(fl.payload) };
  });
  return { stages, failures, stateCounts: parseStateCounts(v.stateCounts) ?? {} };
}

/** `GET /api/features/:featureId/trace` → 进展三面视图（纯函数）。 */
export function parseTrace(json: unknown): FeatureTraceView {
  const body = expectOk(json, "feature trace");
  const featureId = reqStr(body.featureId, "trace.featureId");
  const featureState = reqStr(body.featureState, "trace.featureState");
  const rawNodes = Array.isArray(body.nodes) ? body.nodes : [];
  const nodes: TraceNode[] = rawNodes.map((entry) => {
    const n = isRecord(entry) ? entry : {};
    const busy = isRecord(n.projectBusy) ? n.projectBusy : {};
    const rawOccupants = Array.isArray(n.readOccupants) ? n.readOccupants : [];
    const readOccupants: TraceReadOccupant[] = rawOccupants.map((occ) => {
      const o = isRecord(occ) ? occ : {};
      return {
        taskId: reqStr(o.taskId, "readOccupant.taskId"),
        featureId: str(o.featureId),
        queueState: str(o.queueState),
        machineId: str(o.machineId),
        queuedAt: str(o.queuedAt),
      };
    });
    return {
      taskId: reqStr(n.taskId, "node.taskId"),
      projectId: reqStr(n.projectId, "node.projectId"),
      state: reqStr(n.state, "node.state"),
      lane: str(n.lane) ?? "write",
      queueState: str(n.queueState),
      waitReason: reqStr(n.waitReason, "node.waitReason"),
      blockedOn: strArray(n.blockedOn),
      projectBusy: {
        busy: bool(busy.busy),
        taskId: str(busy.taskId),
        machineId: str(busy.machineId),
      },
      readOccupants,
      position: num(n.position),
      waitedSince: str(n.waitedSince),
    };
  });
  return { featureId, featureState, nodes };
}

/** `GET /api/projects` → 项目/机器快照视图（纯函数；字段白名单与桥渲染层一致）。 */
export function parseProjects(json: unknown): ProjectsView {
  const body = expectOk(json, "projects 快照");
  const rawMachines = Array.isArray(body.machines) ? body.machines : [];
  const machines: ProjectMachineEntry[] = rawMachines.map((entry) => {
    const m = isRecord(entry) ? entry : {};
    const rawProjects = Array.isArray(m.projects) ? m.projects : [];
    const projects: ProjectEntry[] = rawProjects.map((pe) => {
      const p = isRecord(pe) ? pe : {};
      return {
        projectId: reqStr(p.projectId, "project.projectId"),
        agentKind: str(p.agentKind),
        a2aPort: num(p.a2aPort),
        status: str(p.status),
        endpoint: str(p.endpoint),
        startedAt: str(p.startedAt),
      };
    });
    return {
      machineId: reqStr(m.machineId, "machine.machineId"),
      error: str(m.error),
      projects,
    };
  });
  const rawRunners = Array.isArray(body.runners) ? body.runners : [];
  const runners: RunnerEntry[] = rawRunners.map((entry) => {
    const r = isRecord(entry) ? entry : {};
    return {
      machineId: reqStr(r.machineId, "runner.machineId"),
      online: r.online === true,
      lastHeartbeatAt: str(r.lastHeartbeatAt),
    };
  });
  return {
    source: str(body.source),
    note: str(body.note),
    observedAt: str(body.observedAt),
    machines,
    runners,
  };
}

/**
 * `GET /api/registry/projects` → 注册表项目视图（纯函数）。
 *
 * **独立解析，不委派 `parseProjects`**（C-6 两条读路不交叉复用）：字段白名单按本面契约，
 * 多余字段容忍不消费。与 `parseProjects` 的关键差别在**缺 `machines[]` 时抛错**（fail-closed）——
 * 老面把缺字段归一为空数组，本面若照做会把「桥面异常」显示成「一个项目都没有」的项目池恒空。
 */
export function parseRegistryProjects(json: unknown): RegistryProjectsView {
  const body = expectOk(json, "registry projects 快照");
  if (!Array.isArray(body.machines)) {
    throw new BridgeResponseError("registry projects 快照：machines[] 缺失或非数组（拒绝降级为空池）");
  }
  const machines: RegistryMachineEntry[] = body.machines.map((entry) => {
    const m = isRecord(entry) ? entry : {};
    const rawProjects = Array.isArray(m.projects) ? m.projects : [];
    const projects: RegistryProjectEntry[] = rawProjects.map((pe) => {
      const p = isRecord(pe) ? pe : {};
      return {
        projectId: reqStr(p.projectId, "registryProject.projectId"),
        agentKind: str(p.agentKind),
        a2aPort: num(p.a2aPort),
        status: str(p.status),
        endpoint: str(p.endpoint),
        startedAt: str(p.startedAt),
        lastReportedAt: str(p.lastReportedAt),
      };
    });
    return {
      machineId: reqStr(m.machineId, "registryMachine.machineId"),
      runnerState: str(m.runnerState),
      lastHeartbeatAt: str(m.lastHeartbeatAt),
      firstRegisteredAt: str(m.firstRegisteredAt),
      projects,
    };
  });
  const counts = isRecord(body.counts) ? body.counts : {};
  return {
    source: str(body.source),
    note: str(body.note),
    observedAt: str(body.observedAt),
    machines,
    counts: { machines: num(counts.machines), projects: num(counts.projects) },
  };
}

/** `GET /api/tasks?project=…` → 单项目任务列表（纯函数；`project` 必填由调用方保证）。 */
export function parseTasks(json: unknown): ProjectTasksView {
  const body = expectOk(json, "tasks 列表");
  const projectId = reqStr(body.projectId, "tasks.projectId");
  const rawTasks = Array.isArray(body.tasks) ? body.tasks : [];
  const tasks: ProjectTaskItem[] = rawTasks.map((entry) => {
    const t = isRecord(entry) ? entry : {};
    return {
      taskId: reqStr(t.taskId, "task.taskId"),
      contextId: str(t.contextId),
      state: reqStr(t.state, "task.state"),
      prompt: str(t.prompt),
      text: str(t.text),
      updatedAt: str(t.updatedAt),
      stale: t.stale === true,
      claimedAt: str(t.claimedAt),
    };
  });
  return { projectId, reachable: body.reachable !== false, notice: str(body.notice), tasks };
}

/**
 * `GET /api/tasks/:taskId` → 单任务 state（纯函数）。出参形状 = `{ ok:true, task:{ taskId?, state } }`
 * （与 `watch-task.mjs#fetchTaskState` 同源）；`state` 缺失 ⇒ `"unknown"`（保守：未知 state 一律按未就绪）。
 */
export function parseTaskState(json: unknown): TaskStateView {
  const body = expectOk(json, "子任务详情");
  const task = isRecord(body.task) ? body.task : {};
  return { taskId: str(task.taskId), state: str(task.state) ?? "unknown" };
}

/**
 * `GET /api/versions` → 引擎版本台账投影（**纯函数**，v0.10.0 B4；v0.10.1 B1 扩 project 档）。
 *
 * 判定分三档，**只有第一档算「拿到投影」**：
 * 1. 信封 `ok:true` ∧ `versions[]` 是数组 ⇒ 投影（**零条目是合法事实**，不是缺位）；
 * 2. 信封 `ok:true` 但**无 `versions[]`** ⇒ `kind:"absent"`（老桥缺该字段）；
 * 3. 信封 `ok:false` / 非对象 ⇒ `kind:"absent"`（引擎如实报错，同样按「拿不到投影」收口）。
 *
 * 逐条容错：`version` 缺失 / 空白 ⇒ 丢该条（无版号无从谈锁）；`owner_group` 与 `ownerGroup`
 * 两式键都认（查询参数用 snake_case、写面 body 用 camelCase，读侧不赌单一形态）；缺键 ⇒ 未归属桶
 * `""`；`status` 原样透传（见 {@link EngineVersionEntry.status}）。
 *
 * **两档分立（v0.10.1 B1 · C-12）**：上面三档**只判 Group 面**；project 面在同一信封里独立收口
 * （{@link parseProjectVersionsField}）—— `versions[]` 在场 ∧ `projectVersions[]` 缺位 ⇒
 * 仍出 projection，Group 面照旧、project 面自持 absent。
 * **硬约束**：本函数**只认 `versions[]` 里的 Group 行**，project 行混入 `versions[]` 不在此面
 * （负向钉 = `test/v0101-engine-project-versions-parse.test.mjs`）。
 */
export function parseEngineVersions(json: unknown, capturedAt: string): EngineVersionsOutcome {
  if (!isRecord(json) || json.ok !== true) {
    const code = isRecord(json) ? (str(json.code) ?? "unknown") : "response_invalid";
    const error = isRecord(json)
      ? (str(json.error) ?? "响应缺少 ok:true")
      : "版本台账响应不是 JSON 对象";
    return { kind: "absent", code, error };
  }
  if (!Array.isArray(json.versions)) {
    return { kind: "absent", code: "versions_field_missing", error: "响应 ok:true 但缺 versions[]（老桥无版本台账面）" };
  }
  const entries: EngineVersionEntry[] = [];
  for (const item of json.versions) {
    if (!isRecord(item)) continue;
    // 负向钉 (a) 的落点：Group 行的形状键永不含 project_id（两档列集不同）⇒ 带非空白
    // project_id 的行整条不进 Group 投影，因而既不进版本列、也不进锁名单。
    // 缺键 / null / 空白仍按 Group 行处理（不改 versions[] 既有语义）。
    const projectId = projectKeyOf(item, "project_id", "projectId");
    if (projectId !== "") continue;
    const version = (str(item.version) ?? "").trim();
    if (version === "") continue;
    const rawOrg = str(item["owner_group"]) ?? str(item.ownerGroup) ?? "";
    entries.push({
      org: rawOrg.trim(),
      version,
      status: str(item.status),
    });
  }
  return {
    kind: "projection",
    projection: { entries, capturedAt, projectVersions: parseProjectVersionsField(json) },
  };
}

/** `project_id` 缺键 / null / 空白的 project 键读取（两式键都认）。 */
function projectKeyOf(item: Record<string, unknown>, snake: string, camel: string): string {
  return (str(item[snake]) ?? str(item[camel]) ?? "").trim();
}

/**
 * project 档的**归一读取口**（v0.10.1 B1 · 供 T2/T3 消费）：
 * 解析结果恒带 `projectVersions`，但**夹具的老引擎档与历史最后一次投影可能不带该字段** ⇒
 * `undefined` 一律按 `absent` 处理（**绝不当成「零条目」的 empty**，口径同 fail-closed：缺面 ≠ 空面）。
 * 消费侧不得各自手写 `projection.projectVersions.status`（未归一 ⇒ 老档上直接抛）。
 */
export function projectVersionsOf(projection: EngineVersionsProjection | null | undefined): ProjectVersionsField {
  const field = projection?.projectVersions;
  if (field !== undefined) return field;
  return {
    status: "absent",
    code: "project_versions_field_missing",
    error: "投影未携带 projectVersions 档（引擎 project 版本面未上线）",
  };
}

/**
 * 顶层 `projectVersions[]` → project 档三态（**纯函数**，v0.10.1 B1 · C-7）。
 *
 * - 键**缺位 / 非数组** ⇒ `absent`（面未上线，根因码 + `error` 文案随档带出，供核对卡第三行展示）；
 * - 键在场 ∧ 数组 ∧ **零合法条目** ⇒ `empty`（**合法事实**，与 `absent` 显示必须可区分）；
 * - 键在场 ∧ 至少一条合法 ⇒ `live`。
 * 合法 = `project_id` 与 `version` 都非空白；不合格条目整条丢弃（口径同 Group 面「无版号不成条目」）。
 */
export function parseProjectVersionsField(body: Record<string, unknown>): ProjectVersionsField {
  if (!("projectVersions" in body)) {
    return {
      status: "absent",
      code: "project_versions_field_missing",
      error: "响应无 projectVersions[]（引擎 project 版本面未上线）",
    };
  }
  const raw = body.projectVersions;
  if (!Array.isArray(raw)) {
    return {
      status: "absent",
      code: "project_versions_field_invalid",
      error: "projectVersions 存在但不是数组（引擎 project 版本面形状不合法）",
    };
  }
  const entries: EngineProjectVersionEntry[] = [];
  for (const item of raw) {
    const e = parseProjectVersionEntry(item);
    if (e !== null) entries.push(e);
  }
  if (entries.length === 0) return { status: "empty" };
  return { status: "live", entries };
}

/** project 档逐条解析（snake_case / camelCase 两式键都认，口径同 Group 面）；非法形状 ⇒ `null`（丢该条）。 */
function parseProjectVersionEntry(item: unknown): EngineProjectVersionEntry | null {
  if (!isRecord(item)) return null;
  const projectId = projectKeyOf(item, "project_id", "projectId");
  if (projectId === "") return null;
  const version = (str(item.version) ?? "").trim();
  if (version === "") return null;
  const rawOrg = str(item["owner_group"]) ?? str(item.ownerGroup) ?? "";
  const releasable = item["releasable"] === true ? true : item["releasable"] === false ? false : null;
  return {
    org: rawOrg.trim(),
    projectId,
    version,
    status: str(item.status),
    releasable,
    openCount: num(item["open_count"] ?? item.openCount),
    completedCount: num(item["completed_count"] ?? item.completedCount),
    cancelledCount: num(item["cancelled_count"] ?? item.cancelledCount),
    reason: str(item.reason),
    repoId: str(item["repo_id"]) ?? str(item.repoId),
    ref: str(item.ref),
  };
}

/**
 * 引擎版本台账**一次性读取器**（v0.10.0 B4 · §2.1(2) / §2.3(1)）—— 已发版锁的唯一喂入源。
 * 一律**不抛**：拿到投影 ⇒ `projection`；其余（不可达 / 超时 / 非 2xx / 坏 JSON / 老桥无
 * `versions[]`）⇒ `absent` 并带**根因码与文案**，供写口在 fail-closed 拒写时如实点出为什么挡。
 */
export type EngineVersionsFetcher = () => Promise<EngineVersionsOutcome>;

export interface EngineVersionsFetcherOptions {
  /** 引擎可写面基址（与 `versions-write.ts` 同端），缺省 {@link DEFAULT_ENGINE_VERSIONS_BASE_URL}。 */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 单次请求超时（ms），缺省 10_000。 */
  timeoutMs?: number;
  /** 投影捕获时刻（ISO 字符串生成器，测试注入固定时钟）。 */
  nowIso?: () => string;
}

function engineVersionsAbsent(code: string, error: string): EngineVersionsOutcome {
  return { kind: "absent", code, error };
}

export function createEngineVersionsFetcher(
  options: EngineVersionsFetcherOptions = {},
): EngineVersionsFetcher {
  const base = (options.baseUrl ?? DEFAULT_ENGINE_VERSIONS_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  return async (): Promise<EngineVersionsOutcome> => {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      return engineVersionsAbsent("no_fetch", "运行环境无 fetch 实现 ⇒ 无法触达引擎版本台账读端点");
    }
    let res: Response;
    try {
      res = await fetchImpl(`${base}${ENGINE_VERSIONS_QUERY_PATH}`, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
    } catch (err: unknown) {
      return engineVersionsAbsent("versions_unreachable", `引擎不可达（GET ${ENGINE_VERSIONS_QUERY_PATH}）：${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return engineVersionsAbsent(`http_${res.status}`, `引擎返回 HTTP ${res.status}：${text.slice(0, 200)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return engineVersionsAbsent("response_invalid", `版本台账响应不是合法 JSON：${text.slice(0, 200)}`);
    }
    return parseEngineVersions(parsed, nowIso());
  };
}

// ---------------------------------------------------------------------------
// 客户端（网络层，仅 GET）
// ---------------------------------------------------------------------------

export class BridgeResponseError extends Error {
  readonly code: string;
  constructor(message: string, code = "response_invalid") {
    super(message);
    this.name = "BridgeResponseError";
    this.code = code;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function getJson(client: BridgeClientOptions, path: string): Promise<unknown> {
  const base = normalizeBaseUrl(client.baseUrl ?? DEFAULT_BRIDGE_BASE_URL);
  const url = `${base}${path}`;
  const fetchImpl = client.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new BridgeResponseError("运行环境无 fetch 实现");
  }
  const timeoutMs = client.timeoutMs ?? 10_000;
  const res = await fetchImpl(url, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new BridgeResponseError(`桥返回 HTTP ${res.status}：${text.slice(0, 200)}`, `http_${res.status}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BridgeResponseError(`桥响应不是合法 JSON：${text.slice(0, 200)}`);
  }
}

export function createBridgeClient(options: BridgeClientOptions = {}): BridgeClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BRIDGE_BASE_URL;
  const opts: BridgeClientOptions = { ...options, baseUrl };
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    async getFeatures(): Promise<FeaturesListView> {
      return parseFeaturesList(await getJson(opts, "/api/features"));
    },
    async getFeature(featureId: string): Promise<FeatureDetailView> {
      return parseFeatureDetail(await getJson(opts, `/api/features/${encodeURIComponent(featureId)}`));
    },
    async getFeatureTrace(featureId: string): Promise<FeatureTraceView> {
      return parseTrace(
        await getJson(opts, `/api/features/${encodeURIComponent(featureId)}/trace`),
      );
    },
    async getProjects(): Promise<ProjectsView> {
      return parseProjects(await getJson(opts, "/api/projects"));
    },
    async getRegistryProjects(): Promise<RegistryProjectsView> {
      return parseRegistryProjects(await getJson(opts, "/api/registry/projects"));
    },
    async getTasks(projectId: string, options: GetTasksOptions = {}): Promise<ProjectTasksView> {
      const qs = new URLSearchParams({ project: projectId });
      if (options.state !== undefined && options.state.length > 0) qs.set("state", options.state);
      if (options.limit !== undefined) qs.set("limit", String(options.limit));
      return parseTasks(await getJson(opts, `/api/tasks?${qs.toString()}`));
    },
    async getTask(taskId: string): Promise<TaskStateView | null> {
      try {
        return parseTaskState(await getJson(opts, `/api/tasks/${encodeURIComponent(taskId)}`));
      } catch (err: unknown) {
        // 未知 id = 404 / `task_not_found` ⇒ null（与 watch-task 同口径）；其余照常抛（不静默吞）。
        if (err instanceof BridgeResponseError && (err.code === "http_404" || err.code === "task_not_found")) {
          return null;
        }
        throw err;
      }
    },
  };
}
