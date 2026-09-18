/**
 * orch 只读网页接面（页面 + JSON API；v0.5.0 §2.2 / §2.5；节点 N3 —— **只写模块，不接线**）。
 *
 * 定位：给编排加一个**只读**观察口 ——
 * ① 项目成员（machine + project + 在线态）② 任务情况（Feature / Task + 耗时）。
 * 数据**全部来自桥侧既有能力，不新增数据源**：项目 / Feature / 任务复用 `BridgeCore`
 * （即 `handleProjects` / `handleFeatureStatus` / `handleTasks`），事件直连 store。
 * **只读**：无写操作、无操作端、无鉴权（鉴权待 v0.7.0）、不读 Launcher 日志文件。
 *
 * ## 路由（全部 `GET`；命中已注册路径但非 GET → 405，未注册 → 404）
 *
 * | 路径 | 数据来源 | 说明 |
 * |---|---|---|
 * | `/` | — | 内联 HTML 页面（`bridge/web/html.ts`，零前端工具链） |
 * | `/api/projects` | `core.projects()`（= `handleProjects`） | **字段白名单** + 快照语义（来源 / 观测时间） |
 * | `/api/features` | `core.featureStatus({})`（= `handleFeatureStatus`） | 列出全部 Feature（含 taskCount） |
 * | `/api/features/:featureId` | `core.featureStatus({ featureId })` | 单 Feature + 任务摘要（**含三时刻**，渲染层派生）+ 产物；未知 → 404 |
 * | `/api/tasks?project=&state=&limit=` | `core.tasks(...)`（= `handleTasks`） | `project` 必填（缺 → 400） |
 * | `/api/tasks/:taskId` | `store.getTask`（本地库只读） | 单任务详情（见下「已知偏离」） |
 * | `/api/events?since=&limit=` | `store.listEvents({ since, limit })` | **直连 store**；游标由前端传参 |
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
 * 即：网页刷新会**顺带**参与保留策略清理与注册表读取。本模块**刻意不加**服务端缓存来规避 ——
 * 缓存会掩盖真实观测时刻，与「快照 + 观测时间」语义冲突。
 *
 * ## 快照语义（§2.2）
 *
 * `/api/projects` 的 `observedAt` 在**每次请求的内存态**中计算（`new Date()`），
 * **不落库**；响应与页面均标注「由桥注册表（Runner 上报快照）派生 + 观测时间」，
 * **不得呈现为实时在线**。
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
 * `/api/tasks/:taskId` 走 `store.getTask`（本地只读）而**非** `handleTasks`：
 * `handleTasks` 是**按 projectId 列表**的语义（且 `limit` 上限 100），拿不到「按 taskId 精确取一条」，
 * 只能「先查库拿 projectId → 列表 → 再筛」——既多一次副作用（`pruneTasks` + 跨机探测），
 * 又可能因超出 `limit` 而误判 404。故详情页走本地库精确读（零副作用），列表页仍复用 `handleTasks`。
 * 如 N4 / 后续节点要求严格同源，可改用「列表 + 筛」，签名不变。
 */
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { getTask, listEvents } from "../../session/store.js";
import type { EventRecord, ProjectStatus, TaskRecord, TaskState } from "../../types.js";
import { bridgeLog } from "../bridge-log.js";
import { renderIndexHtml } from "../web/html.js";
import type { WebReadiness } from "../web/html.js";
import type { FeatureTaskSummary } from "../feature-tools.js";
import type { BridgeCore } from "../index.js";
import { isLoopbackHostOrAddress } from "./http.js";

export type { WebReadiness };

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

/** 网页端最小内核依赖（`Pick<BridgeCore, …>`：N4 直接传完整 core，结构性兼容） */
export type WebCore = Pick<BridgeCore, "projects" | "tasks" | "featureStatus">;

export interface WebTransportOptions {
  core: WebCore;
  /** 绑定地址（非 loopback 一律拒起） */
  host: string;
  /** 绑定端口（`0` = 系统分配，实测用） */
  port: number;
  /** 桥自身标识（role / pid / startedAt）；常驻化后由 lifecycle 就绪回调提供，未就绪返回 null */
  readiness: () => WebReadiness | null;
  /** 桥版本（页面展示，与 `/health` 同源） */
  version: string;
  /** 自动刷新间隔（ms；< 15000 一律抬到 15000） */
  refreshMs?: number;
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
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
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
    api: "/api/projects, /api/features, /api/tasks, /api/events",
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
  | { kind: "page" }
  | { kind: "projects" }
  | { kind: "features"; featureId: string | null }
  | { kind: "tasks"; taskId: string | null }
  | { kind: "events" };

const FEATURES_PREFIX = "/api/features/";
const TASKS_PREFIX = "/api/tasks/";

function matchRoute(path: string): WebRoute | null {
  if (path === "/") return { kind: "page" };
  if (path === "/api/projects") return { kind: "projects" };
  if (path === "/api/features") return { kind: "features", featureId: null };
  if (path.startsWith(FEATURES_PREFIX)) {
    const raw = path.slice(FEATURES_PREFIX.length);
    return raw.length > 0 && !raw.includes("/") ? { kind: "features", featureId: raw } : null;
  }
  if (path === "/api/tasks") return { kind: "tasks", taskId: null };
  if (path.startsWith(TASKS_PREFIX)) {
    const raw = path.slice(TASKS_PREFIX.length);
    return raw.length > 0 && !raw.includes("/") ? { kind: "tasks", taskId: raw } : null;
  }
  if (path === "/api/events") return { kind: "events" };
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
    case "page":
      respondHtml(res, 200, pageHtml(options));
      return;
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
  }
}

function pageHtml(options: WebTransportOptions): string {
  return renderIndexHtml({
    readiness: options.readiness(),
    version: options.version,
    refreshMs: resolveRefreshMs(options.refreshMs),
  });
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
 * **单 Feature 详情**额外给每个 Task 摘要补**三时刻**（`createdAt` / `startedAt` / `finishedAt`）——
 * 页面（§8 增补 #2）要用它显示「`createdAt → finishedAt`」与「耗时」，而 `FeatureTaskSummary`
 * 不含这三列。补法是**渲染层就地派生**（`getTask`，本地只读），
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
 * 单 Feature 详情里 Task 行补三时刻（v0.5.0 §8 增补 #2「进度 / 耗时」）。
 * 本地无该记录（理论不该发生）⇒ 三值一律 `null`（页面显示「未知 / —」），**不吞不造**。
 */
function withFeatureTaskTimings(
  task: FeatureTaskSummary,
): FeatureTaskSummary & { createdAt: string | null; startedAt: string | null; finishedAt: string | null } {
  const record = getTask(task.taskId);
  return {
    ...task,
    createdAt: record?.createdAt ?? null,
    startedAt: record?.startedAt ?? null,
    finishedAt: record?.finishedAt ?? null,
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
  const record = getTask(taskId);
  if (record === null) {
    respondJson(res, 404, failure("task_not_found", `未知任务 ${taskId}（本地任务存储无记录）`));
    return;
  }
  respondJson(res, 200, { ok: true, task: toTaskDetailView(record) });
}

function toTaskDetailView(record: TaskRecord): TaskDetailView {
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
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * `GET /api/events?since=&limit=`：**直连 store 的 `listEvents({ since, limit })`**。
 * 缺省 `since = 0`（从头）—— 幂等、无状态；**不调用 `handleEvents`、不碰 `eventsCursor`**（见文件头）。
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

  const events: EventRecord[] = listEvents({ since, limit });
  respondJson(res, 200, { ok: true, since, count: events.length, events, note: EVENTS_NOTE });
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

/**
 * HTML 应答：**CSP 强制「无外部资源」**（`default-src 'none'` + 仅同源 connect + 内联 style/script），
 * 与 §2.2「零前端工具链 / 无外部资源」互为约束。
 */
function respondHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  });
  res.end(html);
}
