/**
 * Launcher HTTP 接口（本机常驻）：
 *   GET  /health     健康检查（自报线协议版本 + 就绪态 + Runner 注册态 `bridge` 段，见 PROTOCOL.md）
 *   POST /shutdown   优雅停止（可选，`launcher.shutdownEndpoint=true` 时注册）
 *
 * **入站指挥端点已退役（v0.7.0 M5·MC1）**：`/projects`、`/projects/:projectId/ensure`、
 * `/projects/:projectId/stop` 一律命中 404。连接模型反转为 pull 后，项目生命周期由 Runner
 * 出站命令族（dispatch / stop / cancel-task，见 `runner-exec.ts`）驱动，不再经本机 HTTP 入站。
 * 保留面只有 loopback 只读 `/health`（M2·MA2 additive 的 `bridge` 段）与 v0.6.2 冻结的
 * `/shutdown`；`/health` 的 `status` 在自检通过前仍为 `"starting"`（供启动探测），就绪后 `"ok"`。
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { PROTOCOL_VERSION, type ApiError } from "../types.js";
import { errorMessage } from "./process.js";

/** loopback 源地址白名单（IPv4 / IPv6 / IPv4-mapped） */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * `GET /health` 的 `bridge` 段（v0.7.0 M2·MA2，**additive**）：Runner 注册态快照。
 *
 * **兼容性承诺**：仅追加字段，`ok` / `protocolVersion` / `status` 的形状与语义不变
 * （launcherctl / reaper 只消费前两者，零影响）。未启用 `launcher.bridge` 时恒为
 * `{ registered: false, lastHeartbeatAt: null, lastError: null }`。
 */
export interface BridgeHealthStatus {
  registered: boolean;
  lastHeartbeatAt: string | null;
  lastError: string | null;
}

export interface LauncherAppOptions {
  /** 就绪门：自检通过前返回 false ⇒ `/health` 报 `status:"starting"`；缺省恒 true */
  isReady?: () => boolean;
  /**
   * `/health` 的 `bridge` 段读点（M2·MA2）。缺省 = 未启用 bridge：
   * `registered` 恒 false。只读、无副作用，允许每次请求调用。
   */
  getBridgeStatus?: () => BridgeHealthStatus;
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

/** 仅接受 loopback 来源（反代转发后源地址亦为 loopback → 反代必须 deny `/shutdown`） */
function isLoopbackRequest(req: Request): boolean {
  const address = req.socket.remoteAddress;
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

export function createLauncherApp(options: LauncherAppOptions = {}): Express {
  const isReady = options.isReady ?? ((): boolean => true);
  // 未启用 bridge（无读点）时的恒定快照：registered 恒 false，每次返回新对象避免共享可变引用
  const getBridgeStatus =
    options.getBridgeStatus ??
    ((): BridgeHealthStatus => ({ registered: false, lastHeartbeatAt: null, lastError: null }));
  const app = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      status: isReady() ? "ok" : "starting",
      bridge: getBridgeStatus(),
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

  // 退役端点（/projects、/projects/:id/ensure、/projects/:id/stop）与其余未知路由统一 404
  app.use((_req: Request, res: Response) => {
    sendError(res, 404, "NOT_FOUND", "路由不存在");
  });

  // 统一错误出口（含 JSON 解析失败等）
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    sendError(res, 400, "BAD_REQUEST", errorMessage(err));
  });

  return app;
}
