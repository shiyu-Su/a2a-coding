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
 * - `GET /health`：`{ status, role, version }`；`role` 取自 core 租约（`owner` / `follower`）。
 *   就绪信号**晚于** lifecycle 的 `recover()`：未就绪返回 503 + `status="starting"`。
 * - `POST /shutdown`：**仅 loopback 来源**（Windows 无可靠 SIGTERM，优雅停机走此端点，§2.5）；
 *   先回 200 再触发停机，非 loopback → 403。
 * - `/runner/*`（v0.7.0 A3）：**委托** `options.runner`（`bridge/runner.ts`）处理，本层不做
 *   任何鉴权 / 形态判断 —— 该处理器的 `handle()` 自行完成「stdio 不注册 / 非 owner 503」门闩
 *   与路由匹配；未接 runner（stdio 形态 / 旧调用方）时 `/runner/*` 自然落 404（零回归）。
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
import type { BridgeCore } from "../index.js";
import { createServer } from "../register-tools.js";
import type { RunnerEndpointHandle } from "../runner.js";

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
  /** 编排内核（每请求 `createServer(core)` 复用同一内核） */
  core: BridgeCore;
  /** 绑定地址（默认配置为 `127.0.0.1`） */
  host: string;
  /** 绑定端口（`0` = 系统分配，实测用） */
  port: number;
  /** MCP 端点路径（如 `/mcp`） */
  path: string;
  /** 就绪谓词：lifecycle `start()`（含 `recover()`）完成前为 false */
  isReady: () => boolean;
  /** core 租约角色（`/health` 报出） */
  role: () => CoreRole;
  /** 桥版本（`/health` 报出） */
  version: string;
  /** 触发优雅停机（`POST /shutdown` 命中 loopback 时；响应已发出后调用） */
  onShutdown: () => void;
  /**
   * Runner 入站端点处理器（v0.7.0 A3；可选）。
   * 由 `bridge/index.ts` 在 `transport.mode === "http"` 时经 `createRunnerEndpoints` 注入；
   * 缺省（未注入）时 `/runner/*` 走 404 —— 即「stdio 形态不注册路由」在 HTTP 层的兜底。
   */
  runner?: RunnerEndpointHandle;
}

export interface HttpTransportHandle {
  /** 实际监听端口（`port=0` 时为系统分配值） */
  readonly port: number;
  /** 停止接受新请求并等待在飞请求收尾（停机第一步，§2.5） */
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
  return {
    port: boundPort,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
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

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpTransportOptions,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (path === options.path) {
    await handleMcpRequest(req, res, options);
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
 * MCP 端点（stateless）：每请求新建 `server` + `transport`，应答后两者即弃。
 * 非 POST → 405（含 DELETE：stateless 无会话可终止）；未就绪 → 503（避免客户端在
 * `recover()` 落地前拿到工具面，§2.5 顺序要点）。
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpTransportOptions,
): Promise<void> {
  if (req.method !== "POST") {
    respondJson(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  if (!options.isReady()) {
    respondJson(res, 503, { ok: false, error: "bridge_starting" });
    return;
  }
  const server = createServer(options.core);
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
