/**
 * board 侧对编排桥的**只读** API 客户端（BD1 骨架）。
 *
 * 硬约束：
 * - **仅 GET**：本模块只提供 GET 路径，不封装任何写操作；
 * - **不碰事件游标**：桥 `/api/events` 的游标语义一律不触碰（事件读取口径由后续节点专门处理）；
 * - 数据源 = 桥既有只读接面（`/api/features` / `/api/features/:id` / `/api/features/:id/trace`）。
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

export interface BridgeClient {
  readonly baseUrl: string;
  getFeatures(): Promise<FeaturesListView>;
  getFeature(featureId: string): Promise<FeatureDetailView>;
  getFeatureTrace(featureId: string): Promise<FeatureTraceView>;
  getProjects(): Promise<ProjectsView>;
  getTasks(projectId: string, options?: GetTasksOptions): Promise<ProjectTasksView>;
}

// ---------------------------------------------------------------------------
// 归一视图（字段对齐桥出参；缺字段容错为 null / 空数组，不臆造）
// ---------------------------------------------------------------------------

export interface FeatureListItem {
  featureId: string;
  state: string;
  title: string;
  taskCount: number | null;
  ownerGroup: string | null;
  /**
   * 登记字段（v0.9.0 B1″，桥读侧单点归一后**非空**；此处仍容错为 null —— 混跑期老桥缺列时
   * 如实显示「未知」，不臆造缺省值）。派生展示规则见 `derive.ts` 的 `deriveDisplayStage`。
   */
  stage: string | null;
  version: string | null;
  approval: string | null;
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
}

export interface ProjectTasksView {
  projectId: string;
  reachable: boolean;
  notice: string | null;
  tasks: ProjectTaskItem[];
}

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
      taskCount: num(f.taskCount),
      ownerGroup: str(f.ownerGroup),
      stage: str(f.stage),
      version: str(f.version),
      approval: str(f.approval),
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
      decisions: str(feature.decisions),
      contracts: str(feature.contracts),
      createdAt: str(feature.createdAt),
      updatedAt: str(feature.updatedAt),
    },
    tasks,
  };
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
    };
  });
  return { projectId, reachable: body.reachable !== false, notice: str(body.notice), tasks };
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
    async getTasks(projectId: string, options: GetTasksOptions = {}): Promise<ProjectTasksView> {
      const qs = new URLSearchParams({ project: projectId });
      if (options.state !== undefined && options.state.length > 0) qs.set("state", options.state);
      if (options.limit !== undefined) qs.set("limit", String(options.limit));
      return parseTasks(await getJson(opts, `/api/tasks?${qs.toString()}`));
    },
  };
}
