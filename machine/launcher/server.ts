/**
 * Launcher HTTP 接口（本机常驻）：
 *   GET  /health                         健康检查（自报线协议版本，见 PROTOCOL.md）
 *   GET  /projects                       项目清单 + 运行态
 *   POST /projects/:projectId/ensure     幂等启动（已在跑则复用）
 *   POST /projects/:projectId/stop       停止项目 Agent
 * 仅监听配置端口；跨机鉴权由反向代理补足（本版本 Out of Scope）。
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { PROTOCOL_VERSION, type ApiError } from "../types.js";
import { AgentManager, AgentStartError, ProjectNotFoundError } from "./manager.js";
import { errorMessage } from "./process.js";

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

const UNKNOWN_PROJECT_MESSAGE = "缺少 projectId";

export function createLauncherApp(manager: AgentManager): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, protocolVersion: PROTOCOL_VERSION });
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
