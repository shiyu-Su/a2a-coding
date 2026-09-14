/**
 * Launcher HTTP 接口（本机常驻）：
 *   GET  /health                         健康检查（自报线协议版本 + 就绪态，见 PROTOCOL.md）
 *   GET  /projects                       项目清单 + 运行态
 *   POST /projects/:projectId/ensure     幂等启动（已在跑则复用）
 *   POST /projects/:projectId/stop       停止项目 Agent
 *   POST /shutdown                       优雅停止（可选，`launcher.shutdownEndpoint=true` 时注册）
 * 仅监听配置端口；跨机鉴权由反向代理补足（本版本 Out of Scope）。
 *
 * 就绪门（readiness gate，REQ-v0.2.1-2026-09-14-02）：Launcher 先 `listen` 再自检，
 * 自检通过前 `GET /health` 返回 `200` + `status:"starting"`（供启动探测），业务路由
 * （`/projects*`）返回 `503`，避免「端口已开但一用就废」。
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { PROTOCOL_VERSION, type ApiError } from "../types.js";
import { AgentManager, AgentStartError, ProjectNotFoundError } from "./manager.js";
import { errorMessage } from "./process.js";

/** loopback 源地址白名单（IPv4 / IPv6 / IPv4-mapped） */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface LauncherAppOptions {
  /** 就绪门：自检通过前返回 false，业务路由（`/projects*`）返回 503；缺省恒 true */
  isReady?: () => boolean;
  /** 是否注册 `POST /shutdown`（配置 `launcher.shutdownEndpoint`，缺省 false） */
  shutdownEndpoint?: boolean;
  /** `POST /shutdown` 可选 Bearer 令牌；缺省不校验 */
  shutdownToken?: string;
  /** `/shutdown` 触发：与 SIGINT/SIGTERM 共享同一幂等 `startShutdown()` */
  onShutdown?: () => void;
}

function sendError(res: Response, status: number, code: string, message: string): void {
  const body: { error: ApiError } = { error: { code, message } };
  res.status(status).json(body);
}

function handleManagerError(res: Response, err: unknown): void {
  if (err instanceof ProjectNotFoundError) {
    sendError(res, 404, "PROJECT_NOT_FOUND", err.message);
    return;
  }
  if (err instanceof AgentStartError) {
    sendError(res, 500, "AGENT_START_FAILED", err.message);
    return;
  }
  sendError(res, 500, "INTERNAL_ERROR", errorMessage(err));
}

/** 仅接受 loopback 来源（反代转发后源地址亦为 loopback → 反代必须 deny `/shutdown`） */
function isLoopbackRequest(req: Request): boolean {
  const address = req.socket.remoteAddress;
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

const UNKNOWN_PROJECT_MESSAGE = "缺少 projectId";

export function createLauncherApp(
  manager: AgentManager,
  options: LauncherAppOptions = {},
): Express {
  const isReady = options.isReady ?? ((): boolean => true);
  const app = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      status: isReady() ? "ok" : "starting",
    });
  });

  // 可选：优雅停止端点（默认不注册）。与 SIGINT/SIGTERM 共享同一幂等 startShutdown()
  if (options.shutdownEndpoint === true) {
    const token = options.shutdownToken;
    app.post("/shutdown", (req: Request, res: Response) => {
      if (!isLoopbackRequest(req)) {
        res.status(403).json({ result: "error", data: null, error: "仅接受 loopback 来源" });
        return;
      }
      if (token !== undefined && req.get("authorization") !== `Bearer ${token}`) {
        res.status(401).json({ result: "error", data: null, error: "未认证" });
        return;
      }
      res.json({ result: "ok", data: { shuttingDown: true }, error: null });
      options.onShutdown?.();
    });
  }

  // 就绪门：自检通过前业务路由 503（/health 与 /shutdown 不受影响）
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isReady() && req.path.startsWith("/projects")) {
      sendError(res, 503, "NOT_READY", "启动自检进行中，业务路由暂不可用");
      return;
    }
    next();
  });

  app.get("/projects", (_req: Request, res: Response) => {
    res.json({ projects: manager.listProjects() });
  });

  app.post("/projects/:projectId/ensure", async (req: Request, res: Response) => {
    const projectId = req.params["projectId"];
    if (projectId === undefined || projectId.length === 0) {
      sendError(res, 400, "BAD_REQUEST", UNKNOWN_PROJECT_MESSAGE);
      return;
    }
    try {
      res.json(await manager.ensure(projectId));
    } catch (err) {
      handleManagerError(res, err);
    }
  });

  app.post("/projects/:projectId/stop", async (req: Request, res: Response) => {
    const projectId = req.params["projectId"];
    if (projectId === undefined || projectId.length === 0) {
      sendError(res, 400, "BAD_REQUEST", UNKNOWN_PROJECT_MESSAGE);
      return;
    }
    try {
      res.json(await manager.stop(projectId));
    } catch (err) {
      handleManagerError(res, err);
    }
  });

  // 未命中路由
  app.use((_req: Request, res: Response) => {
    sendError(res, 404, "NOT_FOUND", "路由不存在");
  });

  // 统一错误出口（含 JSON 解析失败等）
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    sendError(res, 400, "BAD_REQUEST", errorMessage(err));
  });

  return app;
}
