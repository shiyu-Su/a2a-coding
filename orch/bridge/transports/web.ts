/**
 * orch 只读 JSON API 接面（v0.5.0 §2.2 / §2.5；v0.9.3 起页面退役，仅保留 `/api/*` 数据面）。
 *
 * 定位：给编排与 Board 提供**只读**数据口 —— 项目 / Feature / 任务 / 事件。
 * 数据**全部来自桥侧既有能力，不新增数据源**：项目 / Feature / 任务复用 `BridgeCore`
 * （即 `handleProjects` / `handleFeatureStatus` / `handleTasks`），事件直连 store。
 * **只读**：无写操作、无操作端、无鉴权（鉴权待 v0.7.0）、不读 Launcher 日志文件。
 *
 * ## 页面退役（v0.9.3 O2）
 *
 * 原 `GET /` 内联只读工作台页面（`bridge/web/html.ts`）已退役 —— 页面由 Board 取代。
 * 本模块只剩 `/api/*` JSON 路由；出参契约零增减（`/api/projects` 的 `runners` 在其出参内，非独立端点）。
 *
 * ## 路由（全部 `GET`；命中已注册路径但非 GET → 405，未注册 → 404）
 *
 * | 路径 | 数据来源 | 说明 |
 * |---|---|---|
 * | `/api/projects` | `core.projects()`（= `handleProjects`） | **字段白名单** + 快照语义（来源 / 观测时间） |
 * | `/api/features` | `core.featureStatus({})`（= `handleFeatureStatus`） | 列出全部 Feature（含 `taskCount` 与逐态 `stateCounts`；v0.9.0 B3″ 起由**一条聚合 SQL** 派生） |
 * | `/api/features/:featureId` | `core.featureStatus({ featureId })` | 单 Feature + 任务摘要（**含三时刻 + 队列四字段**，渲染层派生）+ 产物；未知 → 404 |
 * | `/api/features/:featureId/trace` | `handleFeatureTrace`（store 只读投影；v0.8.8 §2.10(c)） | Trace 面：非终态节点「在等谁 / 排队位次」；未知 → 404 |
 * | `/api/tasks?project=&state=&limit=` | `core.tasks(...)`（= `handleTasks`） | `project` 必填（缺 → 400） |
 * | `/api/tasks/:taskId` | `store.getQueuedTask`（本地库只读） | 单任务详情（含三时刻 + 队列四字段；见下「已知偏离」） |
 * | `/api/events?since=&limit=&featureId=` | `store.listEvents({ since, limit, featureId })` | **直连 store**；游标由前端传参；`featureId` = 按需求收窄（v0.9.0 B3″，仍纯读） |
 * | `/api/groups` | `loadMachinesConfig(configPath).groups`（每请求现读） | **全组枚举**（v0.9.4 O2）：组结构声明面（`projectGroup` 段），与 `/api/projects`（运行态）语义不同，刻意不合并；配置坏 → 500 `machines_config_error` |
 * | `/api/registry/projects` | `store.listRunners` + `store.listRunnerProjects`（每请求现读，直连） | **注册表全量投影**（REQ-2026-10-03-02）：`runners` 表遍历源，含离线机与其项目，**未经组过滤、无组语义**；与 `/api/projects` 两条读路刻意不交叉复用（C-6） |
 * | `/api/features-by-version?owner_group=&version=` | `store.aggregateFeaturesByVersion(owner_group)`（v0.10.0 O3，直连） | **版本名下卡聚合读面**：`features` 按版号派生「卡清单 + 三桶计数 `{total,completed,cancelled,open}`」，**未登记版号单列一桶不静默丢**；可见性经 `owner_group` 与 `listFeatures` 同源；`version` 给定 ⇒ 收窄到该桶。供板 §2.3「卡派生版号」并集；**非版本台账**（三态归 `/api/versions`），**不做闸判定**（归 O4） |
 *
 * ## 硬约束：读事件**绝不移动宿主收件箱游标**
 *
 * `/api/events` 直连 `session/store.js` 的 `listEvents`，**绝不调用 `handleEvents`、
 * 绝不读写 `eventsCursor` / `advanceEventsCursor`**。原因：`eventsCursor` 是宿主
 * `a2a_events`（`handleEvents` / `handleWait`）的**进程内读游标**；网页把游标推走 ⇒
 * 宿主之后 `a2a_events` **永久收不到新事件**（静默丢事件，且现象极难归因）。
 *
 * **机制保证（不是靠纪律）**：`eventsCursor` 是 `bridge/index.ts` 的**模块私有**变量、
 * 未导出；本模块对 `bridge/index.ts` **只有 `import type`**（编译期擦除 ⇒ 运行时不加载
 * `index.js`、不触发其顶层 `main()`）⇒ 网页路径在**类型与模块边界上都不可能**触碰该游标。
 * 网页侧的游标**由前端传参**（`since`；缺省 `0` = 从头，天然幂等）。
 * 单测 `test/web.test.ts` 以「同一 `since` 反复读同结果 / `since` 缺省恒从头」锁定该行为。
 *
 * ## `/api/tasks` 的已知副作用（**复用 `handleTasks` 的代价；不为此新增服务端缓存**）
 *
 * `handleTasks` 不是纯读：① 先 `pruneTasks()` 跑一次保留策略清理；② 若结果中存在
 * `working` 任务，会经 `locateProject` 读**桥注册表**（v0.7.0 A6：零出站）判定可达性。
 * 即：数据面刷新会**顺带**参与保留策略清理与注册表读取。本模块**刻意不加**服务端缓存来规避 ——
 * 缓存会掩盖真实观测时刻，与「快照 + 观测时间」语义冲突。
 *
 * ## 快照语义（§2.2）
 *
 * `/api/projects` 的 `observedAt` 在**每次请求的内存态**中计算（`new Date()`），**不落库**；
 * 响应标注「由桥注册表（Runner 上报快照）派生 + 观测时间」，**不得呈现为实时在线**。
 *
 * ## 监听 / 降级（§2.5：网页接面**不得拖垮 MCP 工具面**）
 *
 * - `host` 非 loopback ⇒ **拒起**（warn 日志 + 返回未启用），**不 throw**；
 * - `listen` 失败（端口被占等）⇒ **不 throw**，返回「未启用」句柄 + warn；
 * - `close()` **不裸用 `server.close()`**：先 `closeIdleConnections()`，并以 **1s 兜底
 *   `closeAllConnections()`** —— 浏览器 keep-alive 会让裸 `close()` 一直等空闲连接，
 *   挂起停机排空（§2.5）。
 *
 * ## 已知偏离（相对派发说明）
 *
 * `/api/tasks/:taskId` 走 `store.getQueuedTask`（本地只读队列视角，含队列四字段）而**非** `handleTasks`：
 * `handleTasks` 是**按 projectId 列表**的语义（且 `limit` 上限 100），拿不到「按 taskId 精确取一条」，
 * 只能「先查库拿 projectId → 列表 → 再筛」——既多一次副作用（`pruneTasks` + 跨机探测），
 * 又可能因超出 `limit` 而误判 404。故详情页走本地库精确读（零副作用），列表页仍复用 `handleTasks`。
 * 如 N4 / 后续节点要求严格同源，可改用「列表 + 筛」，签名不变。
 */
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  aggregateFeaturesByVersion,
  getQueuedTask,
  listEvents,
  listRunnerProjects,
  listRunners,
} from "../../session/store.js";
import type {
  QueueState,
  QueuedTaskRecord,
  RunnerProjectRecord,
  RunnerState,
  VersionCardAggregate,
  VersionFeaturesBucket,
} from "../../session/store.js";
import type {
  EventRecord,
  ProjectGroup,
  ProjectStatus,
  TaskRecord,
  TaskState,
} from "../../types.js";
import { getWarnedConfigTexts, loadMachinesConfig, memberKey } from "../../config.js";
import { bridgeLog } from "../bridge-log.js";
import { handleFeatureTrace } from "../feature-tools.js";
import type { FeatureTaskSummary } from "../feature-tools.js";
import type { BridgeCore } from "../index.js";
import { isLoopbackHostOrAddress } from "./http.js";

/** 自动刷新最小间隔（§2.2 硬下限；小于它一律抬到它） */
export const WEB_MIN_REFRESH_MS = 15_000;
const WEB_DEFAULT_REFRESH_MS = WEB_MIN_REFRESH_MS;
/** 关闭兜底：1s 后强制断开全部连接（防 keep-alive 拖住停机） */
const WEB_CLOSE_GRACE_MS = 1_000;
/** `GET /api/events` 缺省 / 上限（与 store 的 clamp 对齐） */
const EVENTS_DEFAULT_LIMIT = 100;
const EVENTS_MAX_LIMIT = 1_000;
/** `GET /api/tasks` 上限（与 MCP `a2a_tasks` schema 对齐） */
const TASKS_MAX_LIMIT = 100;
/** 事件收件箱状态取值（`GET /api/tasks?state=`） */
const TASK_STATES: readonly TaskState[] = [
  "working",
  "completed",
  "failed",
  "input-required",
  "blocked",
];

const PROJECTS_SOURCE = "桥注册表（Runner 上报快照）";
const PROJECTS_NOTE =
  "快照语义：由桥注册表（Runner 上报投影 runners / runner_projects）派生 + 观测时间；非实时在线";
const EVENTS_NOTE = "游标由前端传参（since）；本接面不读写宿主 a2a_events 收件箱游标";
const GROUPS_SOURCE = "config.json `projectGroup` 段（每请求现读，热改即时生效）";
const REGISTRY_PROJECTS_SOURCE = "桥注册表（Runner 上报全量投影，未经组过滤）";
const REGISTRY_PROJECTS_NOTE =
  "全量投影语义：遍历源 = runners 注册表（含离线机及其项目、含零项目机），未经组过滤、不认识组；非实时在线探测，项目陈旧性以 lastReportedAt（最后一次 Runner 上报时刻）表达";

const FEATURES_BY_VERSION_SOURCE = "features 表按版号聚合（v0.10.0 O3，零新实体；非版本台账）";
const FEATURES_BY_VERSION_NOTE =
  "派生面语义：版号 → 名下需求卡清单 + 三桶计数 {total, completed, cancelled, open}；未登记版号（version 为 NULL/空串）单列一桶、不静默丢；可见性 = owner_group 过滤（与 listFeatures 同源）。本面是 features 派生投影，非引擎版本台账（三态 status 见 /api/versions）；闸判定归 O4，本面只出计数";

/** 网页端最小内核依赖（`Pick<BridgeCore, …>`：N4 直接传完整 core，结构性兼容） */
export type WebCore = Pick<BridgeCore, "projects" | "tasks" | "featureStatus">;

export interface WebTransportOptions {
  core: WebCore;
  /** 绑定地址（非 loopback 一律拒起） */
  host: string;
  /** 绑定端口（`0` = 系统分配，实测用） */
  port: number;
  /** 桥版本（与 `/health` 同源；页面退役后仅作接面标识） */
  version: string;
  /** 自动刷新间隔（ms；< 15000 一律抬到 15000） */
  refreshMs?: number;
  /**
   * orch 机器清单 `config.json` 路径（`GET /api/groups` 数据源；v0.9.4 O2）。
   * 由接线方注入 `MACHINES_CONFIG_PATH`；缺省 ⇒ `/api/groups` 回 500 `machines_config_error`（无源可读）。
   */
  configPath?: string;
}

export type WebDisabledReason = "non_loopback_host" | "listen_failed";

export interface WebTransportHandle {
  readonly enabled: true;
  readonly host: string;
  /** 实际监听端口（`port=0` 时为系统分配值） */
  readonly port: number;
  close(): Promise<void>;
}

export interface WebTransportDisabled {
  readonly enabled: false;
  readonly reason: WebDisabledReason;
  readonly error: string;
  /** 未启用时的空操作（调用方无需分支即可统一收尾） */
  close(): Promise<void>;
}

export type WebTransportOutcome = WebTransportHandle | WebTransportDisabled;

/** 项目出参（**渲染层白名单**：只这 6 个字段，`machineId` 在 `machines[]` 层） */
export interface ProjectView {
  projectId: string;
  agentKind: ProjectStatus["agentKind"];
  a2aPort: number;
  status: ProjectStatus["status"];
  endpoint: string | null;
  startedAt: string | null;
}

/**
 * `GET /api/registry/projects` 项目级出参（REQ-2026-10-03-02 C-4 / C-5）：
 * `ProjectView` 六字段**逐字兼容**（板可复用现有渲染类型），其上仅加
 * `lastReportedAt` = `runner_projects.updated_at`（每次 Runner 全量上报统一盖章 ⇒ 「最后上报于」）。
 */
export interface RegistryProjectView extends ProjectView {
  lastReportedAt: string;
}

/**
 * `GET /api/registry/projects` 机级出参（遍历源 = `runners` 表）。
 * **无 `error` 字段**（离线机照常列出其项目，不发错误文案）；**无 `runnerId`**（注册即恒等
 * `machineId`，`ON CONFLICT(machine_id)` 单行 ⇒ 纯冗余）。
 */
export interface RegistryMachineView {
  machineId: string;
  runnerState: RunnerState;
  lastHeartbeatAt: string;
  firstRegisteredAt: string;
  projects: RegistryProjectView[];
}

/** 单任务详情出参（**渲染层白名单**：本地库字段，无 workspace 绝对路径 / 无 agentConfig） */
export interface TaskDetailView {
  taskId: string;
  projectId: string;
  contextId: string;
  state: TaskState;
  prompt: string | null;
  text: string | null;
  featureId: string | null;
  dependencies: string[] | null;
  remoteTaskId: string | null;
  retryCount: number;
  failureKind: TaskRecord["failureKind"];
  /** 队列态（`tasks.queue_state`，NULL 老行已归一为 `settled`；无记录 → null） */
  queueState: QueueState | null;
  /** 领取时刻（`tasks.claimed_at`；未领取 → null） */
  claimedAt: string | null;
  /** 入队时刻（`tasks.queued_at`；FIFO 领取序；未入队 → null） */
  queuedAt: string | null;
  /** 领取者标识（`tasks.claimed_by`；未领取 → null） */
  claimedBy: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/**
 * 单 Feature 详情的 Task 行视图 = `FeatureTaskSummary` ∪ 三时刻 ∪ 队列四字段
 * （渲染层就地派生，只增字段；MCP `feature_status` 出参不受影响）。
 */
export type FeatureTaskView = FeatureTaskSummary & {
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  queueState: QueueState | null;
  claimedAt: string | null;
  queuedAt: string | null;
  claimedBy: string | null;
};

/** `GET /api/groups` 成员行（渲染层白名单：`machineId` 按**不透明字符串**处理，勿拆格式） */
export interface GroupMemberView {
  machineId: string;
  projectId: string;
}

/** `GET /api/groups` 单组行（组结构声明面；运行态归 `/api/projects`，二者刻意不合并） */
export interface GroupView {
  /** 配置态组名（`projectGroup[]` 段内必填；`null` 仅出现在非配置态，本端点实际恒为字符串） */
  name: string | null;
  /** 去重后成员数（声明序；与 `members[]` 长度一致） */
  memberCount: number;
  members: GroupMemberView[];
}

// ---------------------------------------------------------------------------
// 启动入口
// ---------------------------------------------------------------------------

/**
 * 启动只读网页接面（**唯一启动入口**，供 N4 接线调用）。
 *
 * 契约：**本函数不 throw**（除编程错误外）——
 * 非 loopback / 端口占用等一律降级为「未启用」句柄 + warn，绝不因网页接面拖垮 MCP 工具面。
 */
export async function startWebTransport(
  options: WebTransportOptions,
): Promise<WebTransportOutcome> {
  const { host, port } = options;
  if (!isLoopbackHostOrAddress(host)) {
    const error = `网页接面拒绝绑定非 loopback 地址 ${host}（跨机鉴权待 v0.7.0）`;
    bridgeLog.warn("a2a-bridge", `${error}；网页接面未启用（桥其余能力不受影响）`);
    return disabled("non_loopback_host", error);
  }

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res, options).catch((err: unknown) => {
      bridgeLog.error("a2a-bridge", `网页接面请求处理失败：${toMessage(err)}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      respondJson(res, 500, failure("internal_error", toMessage(err)));
    });
  });

  try {
    await listen(server, port, host);
  } catch (err) {
    const error = `网页接面监听 ${host}:${port} 失败（${toMessage(err)}）；网页接面未启用（不影响 MCP 工具面）`;
    bridgeLog.warn("a2a-bridge", error);
    // 未监听成功 ⇒ 无句柄可关；显式 close 吞掉后续 error 事件（避免无监听者而崩进程）
    server.close(() => {
      /* 未监听：无事可做 */
    });
    return disabled("listen_failed", error);
  }

  const boundPort = boundPortOf(server, port);
  // listen 之后的错误不影响启动（不能 reject 已 resolve 的 Promise）：只记日志
  server.on("error", (err) => {
    bridgeLog.error("a2a-bridge", `网页接面错误：${toMessage(err)}`);
  });
  bridgeLog.info("a2a-bridge", `只读网页接面已监听 http://${host}:${boundPort}/`, {
    api: "/api/projects, /api/features, /api/features-by-version, /api/tasks, /api/events, /api/groups, /api/registry/projects",
    refreshMs: resolveRefreshMs(options.refreshMs),
  });

  return {
    enabled: true,
    host,
    port: boundPort,
    close: (): Promise<void> => closeServer(server),
  };
}

function disabled(reason: WebDisabledReason, error: string): WebTransportDisabled {
  return {
    enabled: false,
    reason,
    error,
    close: async (): Promise<void> => {
      /* 未启用：无 listener 可关 */
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function boundPortOf(server: Server, fallback: number): number {
  const address = server.address();
  return address === null || typeof address === "string" ? fallback : address.port;
}

/**
 * 关闭 listener：**必须**先 `closeIdleConnections()`（否则浏览器 keep-alive 的空闲连接
 * 会让 `server.close()` 的回调永不触发），并以 **1s 兜底 `closeAllConnections()`** 强制收尾。
 * 幂等（`settled` 守卫）；未监听时 `server.close` 直接回调（无 error 事件）。
 */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      resolve();
    }
    const grace = setTimeout(() => {
      bridgeLog.warn("a2a-bridge", "网页接面关闭兜底：1s 内仍有连接未收尾，强制断开全部连接");
      server.closeAllConnections();
      finish();
    }, WEB_CLOSE_GRACE_MS);
    server.close(() => finish());
    server.closeIdleConnections();
  });
}

/** 自动刷新间隔收口：缺省 15s，**低于 15s 一律抬到 15s**（§2.2 最小间隔） */
export function resolveRefreshMs(requested?: number): number {
  const value = requested ?? WEB_DEFAULT_REFRESH_MS;
  if (!Number.isFinite(value) || value < WEB_MIN_REFRESH_MS) return WEB_MIN_REFRESH_MS;
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

type WebRoute =
  | { kind: "projects" }
  | { kind: "features"; featureId: string | null }
  | { kind: "featureTrace"; featureId: string }
  | { kind: "tasks"; taskId: string | null }
  | { kind: "events" }
  | { kind: "groups" }
  | { kind: "registryProjects" }
  | { kind: "featuresByVersion" };

const FEATURES_PREFIX = "/api/features/";
const TRACE_SUFFIX = "/trace";
const TASKS_PREFIX = "/api/tasks/";
/** 注册表全量投影路径（REQ-2026-10-03-02 C-1…C-6；无查询参数、无身份参数） */
const REGISTRY_PROJECTS_PATH = "/api/registry/projects";
/**
 * 版本名下卡聚合读面路径（v0.10.0 O3）。
 * 刻意用 `/api/features-by-version`（非 `/api/features/…`）：不与 `FEATURES_PREFIX` 前缀分支相撞，
 * 也与引擎版本台账 `/api/versions`（O2）语义分开 —— 本面是 `features` 派生投影，非台账。
 */
const FEATURES_BY_VERSION_PATH = "/api/features-by-version";

function matchRoute(path: string): WebRoute | null {
  if (path === "/api/projects") return { kind: "projects" };
  if (path === "/api/features") return { kind: "features", featureId: null };
  if (path === FEATURES_BY_VERSION_PATH) return { kind: "featuresByVersion" };
  if (path.startsWith(FEATURES_PREFIX)) {
    const raw = path.slice(FEATURES_PREFIX.length);
    if (raw.length > 0 && !raw.includes("/")) return { kind: "features", featureId: raw };
    // `/api/features/:featureId/trace`（v0.8.8 §2.10(c)）：仅认这一段二级子路径，其余仍 404
    if (raw.endsWith(TRACE_SUFFIX)) {
      const fid = raw.slice(0, raw.length - TRACE_SUFFIX.length);
      if (fid.length > 0 && !fid.includes("/")) return { kind: "featureTrace", featureId: fid };
    }
    return null;
  }
  if (path === "/api/tasks") return { kind: "tasks", taskId: null };
  if (path.startsWith(TASKS_PREFIX)) {
    const raw = path.slice(TASKS_PREFIX.length);
    return raw.length > 0 && !raw.includes("/") ? { kind: "tasks", taskId: raw } : null;
  }
  if (path === "/api/events") return { kind: "events" };
  if (path === "/api/groups") return { kind: "groups" };
  if (path === REGISTRY_PROJECTS_PATH) return { kind: "registryProjects" };
  return null;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: WebTransportOptions,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://a2a-web.invalid");
  } catch {
    respondJson(res, 400, failure("bad_url", "无法解析请求 URL"));
    return;
  }

  const route = matchRoute(url.pathname);
  if (route === null) {
    respondJson(res, 404, failure("not_found", `未知路径 ${url.pathname}`));
    return;
  }
  if (req.method !== "GET") {
    respondJson(
      res,
      405,
      failure("method_not_allowed", `只读网页接面仅支持 GET（收到 ${req.method ?? "?"}）`),
    );
    return;
  }

  switch (route.kind) {
    case "projects":
      await sendProjects(res, options);
      return;
    case "features": {
      if (route.featureId === null) {
        sendFeatures(res, options, null);
        return;
      }
      const featureId = decodePathSegment(route.featureId);
      if (featureId === null) {
        respondJson(res, 400, failure("bad_path_segment", "featureId 不是合法的 URI 片段"));
        return;
      }
      sendFeatures(res, options, featureId);
      return;
    }
    case "featureTrace": {
      const featureId = decodePathSegment(route.featureId);
      if (featureId === null) {
        respondJson(res, 400, failure("bad_path_segment", "featureId 不是合法的 URI 片段"));
        return;
      }
      sendFeatureTrace(res, featureId);
      return;
    }
    case "tasks": {
      if (route.taskId === null) {
        await sendTasks(res, options, url);
        return;
      }
      const taskId = decodePathSegment(route.taskId);
      if (taskId === null) {
        respondJson(res, 400, failure("bad_path_segment", "taskId 不是合法的 URI 片段"));
        return;
      }
      sendTaskDetail(res, taskId);
      return;
    }
    case "events":
      sendEvents(res, url);
      return;
    case "groups":
      sendGroups(res, options);
      return;
    case "registryProjects":
      sendRegistryProjects(res);
      return;
    case "featuresByVersion":
      sendFeaturesByVersion(res, url);
      return;
  }
}

// ---------------------------------------------------------------------------
// 各路由处理器
// ---------------------------------------------------------------------------

/**
 * `GET /api/projects`：复用 `handleProjects`，**渲染层做字段白名单**。
 *
 * 白名单（§2.2）：`machineId`（machine 层）/ `projectId` / `agentKind` / `a2aPort` /
 * `status` / `endpoint` / `startedAt`；**剔除 `workspace`（绝对路径）与 `agentConfig`**
 * （以及 `risk`）—— 此处只做输出收窄，**不改 `handleProjects` / `parseProjectStatus` 出参**。
 */
async function sendProjects(res: ServerResponse, options: WebTransportOptions): Promise<void> {
  // 观测时刻：内存态（不落库）。先取时刻再取数据，语义为「本次观测的时刻」
  const observedAt = new Date().toISOString();
  const outcome = await options.core.projects();
  if (isFailure(outcome)) {
    respondJson(res, 500, {
      ...failure(outcome.code, outcome.error),
      source: PROJECTS_SOURCE,
      observedAt,
    });
    return;
  }
  respondJson(res, 200, {
    ok: true,
    source: PROJECTS_SOURCE,
    note: PROJECTS_NOTE,
    observedAt,
    machines: outcome.machines.map((machine) => ({
      machineId: machine.machineId,
      error: machine.error,
      projects: machine.projects.map(toProjectView),
    })),
    // Runner 注册视图（v0.7.0 A6 / B4）：只列 memberMachines 中已注册者；字段白名单同上
    runners: outcome.runners.map((runner) => ({
      machineId: runner.machineId,
      online: runner.online,
      lastHeartbeatAt: runner.lastHeartbeatAt,
    })),
  });
}

/**
 * 项目 → 渲染层视图（**逐字段显式取值**，白名单之外一律不出口）。
 *
 * 入参形状 = `handleProjects` 的 `ProjectSummary`（不含 `workspace`）；这里再收窄一次是
 * **防御性**的（即便上游未来放宽，网页出口也不会带出敏感字段）。
 */
function toProjectView(project: {
  projectId: string;
  agentKind: ProjectStatus["agentKind"];
  a2aPort: number;
  status: ProjectStatus["status"];
  endpoint: string | null;
  startedAt: string | null;
}): ProjectView {
  // 显式逐字段取值（**不用展开**）：白名单之外的字段一律不出口
  return {
    projectId: project.projectId,
    agentKind: project.agentKind,
    a2aPort: project.a2aPort,
    status: project.status,
    endpoint: project.endpoint,
    startedAt: project.startedAt,
  };
}

/**
 * `GET /api/features[/:featureId]`：复用 `handleFeatureStatus`（出参原样透出，不做白名单）。
 *
 * **单 Feature 详情**额外给每个 Task 摘要补**三时刻**（`createdAt` / `startedAt` / `finishedAt`）
 * 与**队列四字段**（`queueState` / `claimedAt` / `queuedAt` / `claimedBy`）——
 * 数据面（v0.5.0 §8 增补 #2 / v0.8.8 O6）要用时刻显示「`createdAt → finishedAt`」与「耗时」，用队列四字段
 * 显示真实「排队」区间（`queuedAt → claimedAt`），而 `FeatureTaskSummary` 不含这七列。补法是
 * **渲染层就地派生**（`getQueuedTask`，本地只读、store 零改动），
 * **不改** `FeatureTaskSummary` / `handleFeatureStatus` / MCP 工具面；列表分支（`/api/features`）
 * **出参与行为完全不变**。
 */
function sendFeatures(
  res: ServerResponse,
  options: WebTransportOptions,
  featureId: string | null,
): void {
  const outcome = options.core.featureStatus(featureId === null ? {} : { featureId });
  if (!outcome.ok) {
    respondJson(res, outcome.code === "feature_not_found" ? 404 : 500, outcome);
    return;
  }
  if (featureId === null || outcome.tasks === undefined) {
    respondJson(res, 200, outcome);
    return;
  }
  respondJson(res, 200, { ...outcome, tasks: outcome.tasks.map(withFeatureTaskTimings) });
}

/**
 * `GET /api/features/:featureId/trace`：Trace 面只读投影（v0.8.8 §2.10(c)，O7）——
 * 回答「这个 Feature 为什么还没完成」（非终态节点的 在等谁 / 队列态 / 项目占用 / 排队位次）。
 * **复用 `handleFeatureTrace` helper**（纯读、不落库、不触发调度），不写第二套判据；
 * 网页 = 非身份面（§2.7）⇒ identity 传 `null`（全量放行）。未知 Feature → 404。
 */
function sendFeatureTrace(res: ServerResponse, featureId: string): void {
  const outcome = handleFeatureTrace({ featureId }, null);
  if (!outcome.ok) {
    respondJson(res, outcome.code === "feature_not_found" ? 404 : 500, outcome);
    return;
  }
  respondJson(res, 200, outcome);
}

/**
 * 单 Feature 详情里 Task 行补三时刻（v0.5.0 §8 增补 #2「进度 / 耗时」）
 * + 队列四字段（v0.8.8 O6：排队列改用真源 `queuedAt → claimedAt`）。
 * 本地无该记录（理论不该发生）⇒ 时刻与队列字段一律 `null`（消费方据此显示「未知 / —」），**不吞不造**。
 */
function withFeatureTaskTimings(task: FeatureTaskSummary): FeatureTaskView {
  const record = getQueuedTask(task.taskId);
  return {
    ...task,
    createdAt: record?.createdAt ?? null,
    startedAt: record?.startedAt ?? null,
    finishedAt: record?.finishedAt ?? null,
    queueState: record?.queueState ?? null,
    claimedAt: record?.claimedAt ?? null,
    queuedAt: record?.queuedAt ?? null,
    claimedBy: record?.claimedBy ?? null,
  };
}

/**
 * `GET /api/tasks?project=&state=&limit=`：复用 `handleTasks`（注意其副作用，见文件头）。
 * 入参校验在渲染层完成（缺 `project` / 非法 `state` / 非法 `limit` → 400），不抛异常。
 */
async function sendTasks(
  res: ServerResponse,
  options: WebTransportOptions,
  url: URL,
): Promise<void> {
  const project = url.searchParams.get("project");
  if (project === null || project.length === 0) {
    respondJson(res, 400, failure("missing_project", "缺少必填查询参数 project"));
    return;
  }

  const stateRaw = url.searchParams.get("state");
  const state = stateRaw === null || stateRaw.length === 0 ? undefined : parseTaskState(stateRaw);
  if (stateRaw !== null && stateRaw.length > 0 && state === undefined) {
    respondJson(
      res,
      400,
      failure("invalid_state", `state 非法：${stateRaw}（可选 ${TASK_STATES.join(" / ")}）`),
    );
    return;
  }

  const limitRaw = url.searchParams.get("limit");
  const limit =
    limitRaw === null || limitRaw.length === 0 ? undefined : parseLimit(limitRaw, TASKS_MAX_LIMIT);
  if (limitRaw !== null && limitRaw.length > 0 && limit === undefined) {
    respondJson(
      res,
      400,
      failure("invalid_limit", `limit 非法：${limitRaw}（1-${TASKS_MAX_LIMIT} 的整数）`),
    );
    return;
  }

  const outcome = await options.core.tasks(project, state, limit);
  respondJson(res, isFailure(outcome) ? 500 : 200, outcome);
}

/**
 * `GET /api/tasks/:taskId`：本地库精确读（只读、零副作用、无远端调用）。
 * **不** 走 `handleTasks`（其为按项目列表语义，见文件头「已知偏离」）。
 */
function sendTaskDetail(res: ServerResponse, taskId: string): void {
  const record = getQueuedTask(taskId);
  if (record === null) {
    respondJson(res, 404, failure("task_not_found", `未知任务 ${taskId}（本地任务存储无记录）`));
    return;
  }
  respondJson(res, 200, { ok: true, task: toTaskDetailView(record) });
}

function toTaskDetailView(record: QueuedTaskRecord): TaskDetailView {
  return {
    taskId: record.taskId,
    projectId: record.projectId,
    contextId: record.contextId,
    state: record.state,
    prompt: record.prompt,
    text: record.text,
    featureId: record.featureId,
    dependencies: record.dependencies,
    remoteTaskId: record.remoteTaskId,
    retryCount: record.retryCount,
    failureKind: record.failureKind,
    queueState: record.queueState,
    claimedAt: record.claimedAt,
    queuedAt: record.queuedAt,
    claimedBy: record.claimedBy,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * `GET /api/events?since=&limit=&featureId=`：**直连 store 的 `listEvents({ since, limit, featureId })`**。
 * 缺省 `since = 0`（从头）—— 幂等、无状态；**不调用 `handleEvents`、不碰 `eventsCursor`**（见文件头）。
 * `featureId`（v0.9.0 B3″）= 板读面按需求收窄，同样**纯读**：过滤落在 store 侧，
 * **绝不经 `handleEvents`**（那条即便显式传 `since` 也推进按身份分的游标 ⇒ 静默吃掉宿主事件）。
 */
function sendEvents(res: ServerResponse, url: URL): void {
  const sinceRaw = url.searchParams.get("since");
  const since =
    sinceRaw === null || sinceRaw.length === 0
      ? 0
      : parseLimit(sinceRaw, Number.MAX_SAFE_INTEGER, 0);
  if (since === undefined) {
    respondJson(res, 400, failure("invalid_since", `since 非法：${sinceRaw ?? ""}（非负整数）`));
    return;
  }

  const limitRaw = url.searchParams.get("limit");
  const limit =
    limitRaw === null || limitRaw.length === 0
      ? EVENTS_DEFAULT_LIMIT
      : parseLimit(limitRaw, EVENTS_MAX_LIMIT);
  if (limit === undefined) {
    respondJson(
      res,
      400,
      failure("invalid_limit", `limit 非法：${limitRaw ?? ""}（1-${EVENTS_MAX_LIMIT} 的整数）`),
    );
    return;
  }

  const featureIdRaw = url.searchParams.get("featureId");
  const featureId = featureIdRaw === null || featureIdRaw.length === 0 ? undefined : featureIdRaw;
  if (featureIdRaw !== null && featureId === undefined) {
    respondJson(res, 400, failure("invalid_feature_id", "featureId 不得为空串"));
    return;
  }

  const events: EventRecord[] = listEvents({ since, limit, featureId });
  respondJson(res, 200, { ok: true, since, count: events.length, events, note: EVENTS_NOTE });
}

/**
 * `GET /api/groups`：**全组枚举只读投影**（v0.9.4 O2，板 C 档数据源）。
 *
 * - 数据源 = `loadMachinesConfig(configPath).groups` —— **每请求现读、不缓存**（与 `loadMachines()`
 *   同纪律：组增删 / 成员增删热改即时生效）；出参是**组结构声明**，与 `/api/projects`（运行态）
 *   语义不同，刻意不合并；
 * - **无身份参数**：3300 是运维全量视图、非身份面（§2.7 纪律不变，照 `createCore(null)` 同款口径）；
 * - `warnings[]` = warn-once 配置瑕疵文案快照（`getWarnedConfigTexts`），板侧只如实呈现、不入判定；
 * - **未配组 ⇒ `groups: []`**（= 全量接纳语义，板据此显示「无组」）；不输出 `selective` 等派生集合；
 * - 配置读失败 / 非法 ⇒ 500 `machines_config_error`（**绝不 fail-open**，与 `loadMachines()` 的
 *   I2 口径一致）；错误经 `error` 字段透出（含配置路径），不抛穿服务器。
 */
function sendGroups(res: ServerResponse, options: WebTransportOptions): void {
  const observedAt = new Date().toISOString();
  const configPath = options.configPath;
  let groups;
  try {
    if (configPath === undefined) {
      throw new Error("网页接面未注入 configPath（MACHINES_CONFIG_PATH）");
    }
    groups = loadMachinesConfig(configPath).groups ?? [];
  } catch (err) {
    respondJson(res, 500, {
      ...failure(
        "machines_config_error",
        `加载机器清单失败（${configPath ?? "未注入"}）：${toMessage(err)}`,
      ),
      source: GROUPS_SOURCE,
      observedAt,
    });
    return;
  }
  respondJson(res, 200, {
    ok: true,
    source: GROUPS_SOURCE,
    observedAt,
    note: "声明面投影：config.json 项目组结构（运行态见 /api/projects）；warnings 为配置瑕疵文案，仅供呈现",
    groups: groups.map(toGroupView),
    warnings: getWarnedConfigTexts(),
  });
}

/**
 * 单组 → 渲染层视图（逐字段显式取值：`memberKeys` / `memberMachineIds` / `selective`
 * 等派生态一律不出口）。`memberCount` 与去重后 `members[]` 同源，防板上计数与列表打架。
 */
function toGroupView(group: ProjectGroup): GroupView {
  const seen = new Set<string>();
  const members: GroupMemberView[] = [];
  for (const m of group.members) {
    const key = memberKey(m.machineId, m.projectId);
    if (seen.has(key)) continue; // 组内重复项：集合去重（与 parseProjectGroups 同口径）
    seen.add(key);
    members.push({ machineId: m.machineId, projectId: m.projectId });
  }
  return { name: group.name, memberCount: members.length, members };
}

/**
 * `GET /api/registry/projects`：**注册表全量投影只读面**（REQ-2026-10-03-02，契约 C-1…C-6）。
 *
 * 存在理由：`/api/projects` 走 `handleProjects`，其机器遍历源是 **config `machines[]` 且经组过滤**
 * ⇒ 板侧「注册表全集 − 组成员」的差集与减集同域、构造性恒空。本面把遍历源换成 `runners` 表，
 * 让差集的左集真正等于「上报过的全量」。
 *
 * - **C-1 遍历源 = `runners` 表**：在线机 ✅；离线机 ✅ 且其项目照常列出（机级 `runnerState=offline`
 *   + `lastHeartbeatAt`，**不发 `error` 文案**）；注册过但零项目 ✅ `projects: []`；
 *   config 里有但**从未注册**的机器 ❌ 不出现（本面不表「配置里有谁」）；
 * - **C-2 零组语义**：出参不含 `declared` / `inGroup` / `group` / `groups` / `ownerGroupName`
 *   或任何「是否属于某组」的布尔 —— 本面对组的唯一关系 = **不认识**（组视野仍只由
 *   `/api/projects` 默认档与 MCP `a2a_projects` 承载）；
 * - **C-3 字符串逐字透出**：不 trim、不大小写折叠、不做任何规范化；
 * - **C-6 与 `/api/projects` 两条读路不交叉复用**：直连 `listRunners` / `listRunnerProjects`
 *   （每请求现读，与 `loadMachines()` 同纪律），**不经 `core.projects()` / `handleProjects`**；
 * - **无查询参数、无身份参数**：3300 = 运维全量视图、非身份面（§2.7 口径，照 `sendGroups`）；
 * - **不刷新注册表、不加 TTL**：陈旧性由 `lastReportedAt` 表达（板侧提示「最后上报于 …」）；
 * - 注册表读失败（库损坏 / 非法列值）⇒ 500 `registry_read_error`，**绝不 fail-open 成空池**。
 */
function sendRegistryProjects(res: ServerResponse): void {
  // 观测时刻：内存态（不落库）；先取时刻再取数据 = 「本次观测的时刻」
  const observedAt = new Date().toISOString();
  let machines: RegistryMachineView[];
  let projectCount: number;
  try {
    machines = [];
    projectCount = 0;
    for (const runner of listRunners()) {
      // 项目行的外键键 = `runner_id`（注册时 `runnerId = machineId`，见 `bridge/runner.ts`）
      const records = listRunnerProjects(runner.runnerId);
      projectCount += records.length;
      machines.push({
        machineId: runner.machineId,
        runnerState: runner.state,
        lastHeartbeatAt: runner.lastHeartbeatAt,
        firstRegisteredAt: runner.registeredAt,
        projects: records.map(toRegistryProjectView),
      });
    }
  } catch (err) {
    respondJson(res, 500, {
      ...failure("registry_read_error", `读取 Runner 注册表失败：${toMessage(err)}`),
      source: REGISTRY_PROJECTS_SOURCE,
      observedAt,
    });
    return;
  }
  respondJson(res, 200, {
    ok: true,
    source: REGISTRY_PROJECTS_SOURCE,
    observedAt,
    note: REGISTRY_PROJECTS_NOTE,
    machines,
    counts: { machines: machines.length, projects: projectCount },
  });
}

/**
 * Runner 项目行 → 渲染层视图（**逐字段显式取值**，白名单之外一律不出口：`workspace`（绝对路径）、
 * `risk`、`runnerId` 均不出口；形状与 `toProjectView` 同款防御）。
 */
function toRegistryProjectView(project: RunnerProjectRecord): RegistryProjectView {
  return {
    projectId: project.projectId,
    agentKind: project.agentKind,
    a2aPort: project.a2aPort,
    status: project.status,
    endpoint: project.endpoint,
    startedAt: project.startedAt,
    lastReportedAt: project.updatedAt,
  };
}

/**
 * `GET /api/features-by-version?owner_group=&version=`：**版本名下卡聚合读面**（v0.10.0 O3，
 * 改造文档 §2.1(5)「只读聚合面 · 首刀 · 零新实体」）。
 *
 * 存在理由：把「版号 → 名下需求卡清单 + 三桶计数 `{total, completed, cancelled, open}`」从
 * `features` 一处派生，供 **板 §2.3「引擎 Release 清单 ∪ 卡派生版号」并集的右半**
 * （卡派生版号 = 本面 `versions` 全集）。
 *
 * - **可见性同源**：`owner_group` 直接透给 `aggregateFeaturesByVersion`（其内复用
 *   {@link featureOwnershipPredicate} = 与 `listFeatures` 同一判据，不另写）；缺省 / 空 ⇒ 全量
 *   （3300 运维视图，与本文件其它面 `identity=null` 口径一致）；给定组名 ⇒ 仅本组
 *   （NULL 无归属被排除 = fail-closed）。
 * - **`version` 可选收窄**：给定 ⇒ `buckets` 只留该版号桶（**空串 ⇒ 未登记桶**）；缺省 ⇒ 全部桶。
 *   `versions` / `unregisteredCount` 恒为**全量口径**（收窄只动 `buckets`，不改派生版号全集）。
 * - **未登记版号不静默丢**：`version=null` 的桶恒在 `buckets` 末位（若存在未登记卡），计数另见
 *   `unregisteredCount`。
 * - **只读、零副作用、不判闸**：闸判定归 O4；本面只出计数与清单。聚合读失败 ⇒ 500
 *   `version_aggregate_error`（**不 fail-open 成空**，与 `registry_read_error` 同口径）。
 *
 * 出参直接透出 store 聚合面形状（{@link VersionCardAggregate} / {@link VersionFeaturesBucket}）——
 * 该形状在 store 侧已收窄（不带 `requirement`/`plan`/`decisions` 长文本），此处不再二次白名单，
 * **避免两份形状漂移**。
 */
function sendFeaturesByVersion(res: ServerResponse, url: URL): void {
  const observedAt = new Date().toISOString();
  const ownerRaw = url.searchParams.get("owner_group");
  const ownerGroup = ownerRaw === null || ownerRaw.length === 0 ? undefined : ownerRaw;
  const versionParam = url.searchParams.get("version"); // null=不给（全量）；""=显式未登记桶

  let aggregate: VersionCardAggregate;
  try {
    aggregate = aggregateFeaturesByVersion(ownerGroup);
  } catch (err) {
    respondJson(res, 500, {
      ...failure("version_aggregate_error", `版本名下卡聚合读失败：${toMessage(err)}`),
      source: FEATURES_BY_VERSION_SOURCE,
      observedAt,
    });
    return;
  }

  const buckets: VersionFeaturesBucket[] =
    versionParam === null
      ? aggregate.buckets
      : aggregate.buckets.filter((b) => (b.version ?? "") === versionParam);

  respondJson(res, 200, {
    ok: true,
    source: FEATURES_BY_VERSION_SOURCE,
    observedAt,
    note: FEATURES_BY_VERSION_NOTE,
    ownerGroup: ownerGroup ?? null,
    version: versionParam,
    versions: aggregate.versions,
    unregisteredCount: aggregate.unregisteredCount,
    buckets,
    counts: {
      versions: aggregate.versions.length,
      buckets: buckets.length,
      features: buckets.reduce((sum, b) => sum + b.counts.total, 0),
    },
  });
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function decodePathSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** 解析任务态（非法返回 `undefined`；调用方据此回 400） */
function parseTaskState(raw: string): TaskState | undefined {
  return TASK_STATES.find((state) => state === raw);
}

/** 解析整数（`min` 缺省 1；非法返回 `undefined`；调用方据此回 400） */
function parseLimit(raw: string, max: number, min = 1): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return undefined;
  return value;
}

function isFailure(v: unknown): v is { ok: false; code: string; error: string } {
  // 与 `register-tools.ts` 的同名私有判据一致（`MachinesView` / `TasksView` 无 `ok` 字段，不能直接读 `.ok`）；
  // 因 N3 落点仅限本文件，未抽出共享模块。
  return typeof v === "object" && v !== null && "ok" in v && (v as { ok?: unknown }).ok === false;
}

function failure(code: string, error: string): { ok: false; code: string; error: string } {
  return { ok: false, code, error };
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}
