/**
 * stateless Streamable HTTP 接入面（REQ-v0.4.1-2026-09-15-02 §2.3）。
 *
 * 为什么是 stateless：宿主（远程 MCP 客户端）按「一问一答」发 `POST /mcp`，
 * **不携带 `Mcp-Session-Id`**（SDK 的 `StreamableHTTPClientTransport` 仅在服务端下发会话号时
 * 才回带）。故本接入面：`sessionIdGenerator: undefined`（不发放会话号）+ `enableJsonResponse: true`
 * （JSON 应答，不起 SSE 流），且**每请求新建 server + transport**（无跨请求内存态）。
 *
 * 路由（仅这三条 + Runner 入站分支）：
 * - `POST {path}`（默认 `/mcp`）：MCP JSON-RPC（stateless）；未就绪时 503，非 POST 时 405。
 *   **v0.8.6 §2.2 B 形态**：MCP 端点亦可写成 **`/<组名>{path}`**（如 `/g1/mcp`）——
 *   **URL 首段 = 连接身份（组名）**，其余须**恰好等于** `options.path`；`path === options.path`
 *   ⇒ 无身份。身份经 `coreFor(identity)` 装配每请求内核视图；**配了组而未带身份 ⇒ 403**
 *   `group_identity_required`（fail-closed，判据由 `identityRequired` 注入；未配组全量接纳照旧）。
 * - `GET /health`：`{ status, role, version, degraded }`；`role` 取自 core 租约（`owner` / `follower`）。
 *   `degraded` 为进程内降级快照（v0.8.8 O5；每项 `{ key, reason, since }`，无降级 ⇒ 空数组）。
 *   就绪信号**晚于** lifecycle 的 `recover()`：未就绪返回 503 + `status="starting"`。
 * - `POST /shutdown`：**仅 loopback 来源**（Windows 无可靠 SIGTERM，优雅停机走此端点，§2.5）；
 *   先回 200 再触发停机，非 loopback → 403。
 * - `/runner/*`（v0.7.0 A3）：**委托** `options.runner`（`bridge/runner.ts`）处理，本层不做
 *   任何鉴权 / 判断 —— 该处理器的 `handle()` 自行完成「非 owner 503」门闩与路由匹配；
 *   未接 runner 时 `/runner/*` 自然落 404（兜底）。
 *
 * 实现边界：HTTP 层用 `node:http`（SDK 的 express 助手依赖 express，而 orch 未声明该依赖，
 * 「不得新增第三方依赖」故不用）；绑定默认 loopback，非 loopback 地址打 warn（跨机鉴权待 v0.7.0）。
 * 端口绑定即单实例互斥：`listen` 失败（端口被占）直接向上抛，由 `index.ts` fail fast 退出。
 */
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CoreRole } from "../../runtime/core-lease.js";
import { bridgeLog } from "../bridge-log.js";
import type { BridgeCore, DegradedItem } from "../index.js";
import { createServer } from "../register-tools.js";
import type { RunnerEndpointHandle } from "../runner.js";

/**
 * HTTP 接入面关闭兜底预算（ms）：`server.close()` 等待在飞请求自然收尾的上限；
 * 到点仍有连接未收尾 ⇒ `closeAllConnections()` 强行断开全部连接并 resolve。
 *
 * **为什么不可裸用 `server.close()`**：keep-alive 连接会让 `server.close()` 的回调**永不触发**
 * ⇒ 停机链不 settle、`process.exit(0)` 不可达、进程不退、`core.lock` 不释放
 * （v0.7.2 K1 主嫌；同仓 `web.ts#closeServer` 已正确处理该陷阱，本文件此前漏改）。
 *
 * **为何 `closeAllConnections()` 兜底不可省**：Runner 长轮询（`runner.ts#handleConnect`，
 * hold 至 `holdMs` 缺省 25s）是**活动连接**，`closeIdleConnections()` 对其无效 —— 只能强断；
 * 而 `/shutdown` 的响应在 close 前已 `res.end()`（`handleShutdownRequest`）⇒ 强断不截断响应。
 *
 * **与停机预算自洽（v0.7.2 K4 对齐，O1 落常量）**：本预算 **5s** + 排空上限
 * （`runtime/lifecycle.ts#readDrainGraceMs()` 缺省 **30s**）= 35s ≤ `scripts/bridgectl.mjs`
 * 的 `STOP_TIMEOUT_MS`（**45s**），留 10s 余量；改本值须同步复核那两处交叉注释。
 */
export const HTTP_CLOSE_GRACE_MS = 5_000;

/** 非 loopback 绑定的告警对象（host 名或 IP、IPv4-mapped IPv6） */
export function isLoopbackHostOrAddress(value: string): boolean {
  const v = value.toLowerCase();
  return (
    v === "localhost" ||
    v === "::1" ||
    v === "[::1]" ||
    v.startsWith("127.") ||
    v === "::ffff:127.0.0.1" ||
    v.startsWith("::ffff:127.")
  );
}

export interface HttpTransportOptions {
  /**
   * 编排内核**兜底**（未注入 `coreFor` 时使用 = 全量身份视图；生产 http 接线恒走 `coreFor`）。
   */
  core: BridgeCore;
  /**
   * 按连接身份装配内核视图（v0.8.6 §2.2 设计，身份载体 = **URL 路径首段**，非 header）：
   * `(identity) => BridgeCore`，`identity = null` 表示无身份（`path === options.path`）。
   * **每请求轻量视图、不按身份缓存 core**（`createCore` 只是领域入口的结构化装配，成本低；
   * 进程级可变状态共享，见改造文档 B1）。缺省 ⇒ 一律用 `options.core`（未接线形态）。
   */
  coreFor?: (identity: string | null) => BridgeCore;
  /**
   * 「配了组 ⇒ 必须带身份」判据谓词（v0.8.6 §2.2 G5，fail-closed）：返回 `true` 时，
   * 匿名请求（`path === options.path`）在 MCP 端点被 **403** `group_identity_required` 拒绝。
   * 单一来源 = `groups.length > 0`，由 `bridge/index.ts` 注入（配置不可读时按 `true` 处理，
   * **绝不回退全量接纳**，I2）。缺省 `false` = 全量接纳照旧（未配组语义 / 既有测试形态）。
   */
  identityRequired?: () => boolean;
  /** 绑定地址（默认配置为 `127.0.0.1`） */
  host: string;
  /** 绑定端口（`0` = 系统分配，实测用） */
  port: number;
  /** MCP 端点路径（如 `/mcp`）；组身份形态 = `/<组名>{path}`（首段为身份，其余须恰好等于本值） */
  path: string;
  /** 就绪谓词：lifecycle `start()`（含 `recover()`）完成前为 false */
  isReady: () => boolean;
  /** core 租约角色（`/health` 报出） */
  role: () => CoreRole;
  /** 桥版本（`/health` 报出） */
  version: string;
  /**
   * 降级快照 getter（v0.8.8 O5）：`/health` 出参 `degraded[]` 的数据源，每项
   * `{ key, reason, since }`。缺省（未注入）⇒ 空数组。**只加键、不改 `status` 语义**。
   */
  degraded?: () => DegradedItem[];
  /** 触发优雅停机（`POST /shutdown` 命中 loopback 时；响应已发出后调用） */
  onShutdown: () => void;
  /**
   * Runner 入站端点处理器（v0.7.0 A3；可选）。
   * 由 `bridge/index.ts` 常驻 http 启动时经 `createRunnerEndpoints` 注入；
   * 缺省（未注入）时 `/runner/*` 走 404（兜底）。
   */
  runner?: RunnerEndpointHandle;
}

export interface HttpTransportHandle {
  /** 实际监听端口（`port=0` 时为系统分配值） */
  readonly port: number;
  /**
   * 停止接受新请求，并在**有界预算**（`HTTP_CLOSE_GRACE_MS`）内等待在飞请求收尾
   * （停机第一步，§2.5）；预算内未收尾 ⇒ `closeAllConnections()` 强断全部连接后 resolve。
   * **幂等**：重复调用返回同一 Promise（不新起兜底 timer、不抛不挂）。
   */
  close(): Promise<void>;
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
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** MCP 端点路径匹配结果（`identity = null` ⇒ 无身份 = `path === options.path` 的匿名入口） */
export interface McpPathMatch {
  identity: string | null;
}

/**
 * 身份提取（v0.8.6 §2.2 B 形态，**HTTP 层唯一注入点**）：
 * - `path === optionsPath` ⇒ `{ identity: null }`（无身份；未配组环境的合法全量入口）；
 * - `path === "/" + identity + optionsPath`（首段非空；其余**恰好**等于 `optionsPath`）⇒ `{ identity }`
 *   （`/<组名>/mcp`，组名作首段）；首段按构造不含 `/`，「其余恰好相等」即排除任何额外段；
 * - 其余 ⇒ `undefined`（落后续路由 / 404；尾斜杠 `/<组名>/mcp/` 因余段不精确相等而落 404）。
 */
export function matchMcpPath(path: string, optionsPath: string): McpPathMatch | undefined {
  if (path === optionsPath) return { identity: null };
  if (!path.startsWith("/")) return undefined; // origin-form 之外（如 absolute-form URI）不截身份
  const rest = path.slice(1); // 去掉开头 "/"
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined; // 无余段（含纯 "/组名"）或空首段（"//…"）
  if (rest.slice(slash) !== optionsPath) return undefined;
  return { identity: rest.slice(0, slash) };
}

/**
 * 装配并监听 HTTP 接入面。
 * 返回后端口已绑定（`listen` 失败即 reject = fail fast），但**尚未就绪**：
 * 就绪由调用方在 lifecycle `start()` 完成后使 `isReady()` 转真。
 */
export async function startHttpTransport(
  options: HttpTransportOptions,
): Promise<HttpTransportHandle> {
  const { host, port, path } = options;
  if (!isLoopbackHostOrAddress(host)) {
    bridgeLog.warn(
      "a2a-bridge",
      `警告：HTTP 接入面绑定非 loopback 地址 ${host}（跨机鉴权待 v0.7.0，请仅在同机 / 受信网络使用）`,
    );
  }
  const server = createHttpServer((req, res) => {
    void handleRequest(req, res, options);
  });
  await listen(server, port, host);
  const boundPort = boundPortOf(server, port);
  // listen 之后的错误不再影响启动（不能 reject 已 resolve 的 Promise）：只记日志
  server.on("error", (err) => {
    bridgeLog.error("a2a-bridge", `HTTP 接入面错误：${toMessage(err)}`);
  });
  bridgeLog.info("a2a-bridge", `HTTP 接入面已监听 http://${host}:${boundPort}${path}`, {
    health: "/health",
    shutdown: "/shutdown",
  });
  // 幂等收口：重复 close 复用同一 Promise（不重入 closeServer、不新起兜底 timer）
  let closePromise: Promise<void> | null = null;
  return {
    port: boundPort,
    close: (): Promise<void> => {
      closePromise ??= closeServer(server);
      return closePromise;
    },
  };
}

/**
 * 关闭 listener（停机第一步）：**必须**先 `closeIdleConnections()`（否则 keep-alive 空闲连接
 * 会让 `server.close()` 的回调永不触发），并以 **`HTTP_CLOSE_GRACE_MS` 兜底 `closeAllConnections()`**
 * 强制收尾（Runner 长轮询等活动连接只能强断）。幂等（`settled` 守卫）；未监听时 `server.close`
 * 直接回调（无 error 事件）。与 `web.ts#closeServer` 同构，仅预算值不同（见常量 JSDoc）。
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
      bridgeLog.warn(
        "a2a-bridge",
        `MCP 接入面关闭兜底：${HTTP_CLOSE_GRACE_MS}ms 内仍有连接未收尾，强制断开全部连接`,
      );
      server.closeAllConnections();
      finish();
    }, HTTP_CLOSE_GRACE_MS);
    server.close(() => finish());
    server.closeIdleConnections();
  });
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

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpTransportOptions,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0] ?? "";
  const mcp = matchMcpPath(path, options.path);
  if (mcp !== undefined) {
    await handleMcpRequest(req, res, options, mcp.identity);
    return;
  }
  if (path === "/health") {
    if (req.method !== "GET") {
      respondJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    const ready = options.isReady();
    respondJson(res, ready ? 200 : 503, {
      status: ready ? "ok" : "starting",
      role: options.role(),
      version: options.version,
      // O5：降级快照（只加键；status 语义不变；未注入 ⇒ 空数组）
      degraded: options.degraded?.() ?? [],
    });
    return;
  }
  if (path === "/shutdown") {
    if (req.method !== "POST") {
      respondJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    handleShutdownRequest(req, res, options);
    return;
  }
  // Runner 入站分支（v0.7.0 A3）：仅在注入处理器时生效；`handle()` 自检形态 / owner 门闩 / 路由匹配
  if (options.runner !== undefined) {
    if (await options.runner.handle(req, res, path)) return;
  }
  respondJson(res, 404, { ok: false, error: "not_found" });
}

/**
 * MCP 端点（stateless）：每请求新建 `server` + `transport`，应答后两者即弃；
 * 内核视图按连接身份装配（`coreFor(identity)`，缺省回退 `options.core`）。
 * 非 POST → 405（含 DELETE：stateless 无会话可终止）；**配了组而未带身份 → 403**
 * `group_identity_required`（§2.2 G5，先于就绪门——配置级错误不等就绪）；
 * 未就绪 → 503（避免客户端在 `recover()` 落地前拿到工具面，§2.5 顺序要点）。
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpTransportOptions,
  identity: string | null,
): Promise<void> {
  if (req.method !== "POST") {
    respondJson(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  if (identity === null && options.identityRequired?.() === true) {
    respondJson(res, 403, {
      ok: false,
      error: "group_identity_required",
      message:
        `本机已配置 projectGroup，禁止不带身份直连 ${options.path}：` +
        `请访问 /<组名>${options.path}（组名见 orch/config/config.json 的 projectGroup[].name）`,
    });
    return;
  }
  if (!options.isReady()) {
    respondJson(res, 503, { ok: false, error: "bridge_starting" });
    return;
  }
  const server = createServer((options.coreFor ?? (() => options.core))(identity));
  const transport = new StreamableHTTPServerTransport({
    // stateless：不下发 Mcp-Session-Id（宿主客户端据此也不会回带）
    sessionIdGenerator: undefined,
    // JSON 应答（不起 SSE 流）：宿主 remote MCP 客户端为一问一答
    enableJsonResponse: true,
  });
  const discard = (err: unknown): void => {
    bridgeLog.debug("a2a-bridge", `stateless 收尾：${toMessage(err)}`);
  };
  res.on("close", () => {
    void transport.close().catch(discard);
    void server.close().catch(discard);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    bridgeLog.error("a2a-bridge", `MCP 请求处理失败：${toMessage(err)}`);
    if (res.headersSent) {
      res.end();
    } else {
      respondJson(res, 500, { ok: false, error: "internal_error" });
    }
  }
}

/**
 * 优雅停机端点（仅 loopback）。先回 200，再用 `setImmediate` 触发停机 ——
 * 停机路径会先 `close()` 本 listener（等待在飞请求收尾），故响应不会被截断。
 */
function handleShutdownRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpTransportOptions,
): void {
  const remote = req.socket.remoteAddress ?? "";
  if (!isLoopbackHostOrAddress(remote)) {
    bridgeLog.warn("a2a-bridge", `/shutdown 拒绝非 loopback 来源：${remote === "" ? "?" : remote}`);
    respondJson(res, 403, { ok: false, error: "loopback_only" });
    return;
  }
  respondJson(res, 200, { ok: true, message: "shutting_down" });
  setImmediate(() => {
    options.onShutdown();
  });
}
