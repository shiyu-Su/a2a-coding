/**
 * Launcher HTTP 接口（本机常驻）：
 *   GET  /health     健康检查（自报线协议版本 + 就绪态 + Runner 注册态 `bridge` 段 + 本机降级面 `degraded` 段，见 PROTOCOL.md）
 *   POST /shutdown   优雅停止（可选，`launcher.shutdownEndpoint=true` 时注册）
 *
 * **入站指挥端点已退役（v0.7.0 M5·MC1）**：`/projects`、`/projects/:projectId/ensure`、
 * `/projects/:projectId/stop` 一律命中 404。连接模型反转为 pull 后，项目生命周期由 Runner
 * 出站命令族（dispatch / stop / cancel-task，见 `runner-exec.ts`）驱动，不再经本机 HTTP 入站。
 * 保留面只有 loopback 只读 `/health`（M2·MA2 additive 的 `bridge` 段、v0.8.8 M4 additive 的
 * `degraded` 段）与 v0.6.2 冻结的
 * `/shutdown`；`/health` 的 `status` 在自检通过前仍为 `"starting"`（供启动探测），就绪后 `"ok"`。
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { PROTOCOL_VERSION, type ApiError } from "../types.js";
import { errorMessage } from "./process.js";
import type {
  DispatchQueueCounts,
  DispatchGateSnapshot,
  DispatchLaneCounts,
} from "./runner-exec.js";
import type { SelfCheckCause, SelfCheckFailure } from "./self-check.js";

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

/** `GET /health` 的 `degraded.selfCheckFailedProjects[]` 条目（复用自检的结构化结论与根因分类） */
export interface DegradedSelfCheckFailure {
  projectId: string;
  stage: SelfCheckFailure["stage"];
  cause?: SelfCheckCause;
}

/**
 * `GET /health` 的 `degraded` 段（v0.8.8 · 节点 M4，改造文档 §2.9）：本机降级面快照。
 *
 * **只反映本机 loopback 运维事实，到不了 orch**（注册载荷不扩字段、push 通道 v0.8.3 已退役）
 * ⇒ 与 orch 侧 `degraded[]` 是两个互不相通的面（C4），排查时两处分别查。
 *
 * **判读口径**：未启用 bridge 的机器，`runnerLoopAlive` / `outboxLoopAlive` 恒 `false`
 * 属「未启用」而非「已降级」（与 `bridge.registered` 同处判读），降级判据看
 * `selfCheckSkipped` / `selfCheckFailedProjects` / `unavailableProjectIds` / `outboxPendingCount`。
 */
export interface DegradedStatus {
  /** `launcher.startupCheck === false` —— 自检被跳过，`ok`/`status` 不足以证明「自检通过」 */
  selfCheckSkipped: boolean;
  selfCheckFailedProjects: DegradedSelfCheckFailure[];
  /** `manager` 登记的不可用项目集（此后 `ensure()` 直接抛 `AgentStartError`） */
  unavailableProjectIds: string[];
  outboxLoopAlive: boolean;
  outboxPendingCount: number;
  runnerLoopAlive: boolean;
  inFlightCount: number;
  /**
   * **取消超时未静默的项目集**（v0.8.10 · M-N4）：`tasks/cancel` 已发出、静默窗内该轮仍未达终态
   * = 后端不认 `session/cancel`。与 diagnostics 的 `cancelUnsupported`（单张账单的事实）
   * **同名不同面**（沿用既有先例，不新造别名）；空数组 = 本机当前无此降级项。
   */
  cancelUnsupported: string[];
  /**
   * **闸的按项目在飞档位计数**（v0.8.10 增补轨 · A1，改造文档 §2.3）：
   * `{ [projectId]: { write, read } }`，闸快照原样透出（只含有活动的项目）。
   * **恒在**：无在飞 ⇒ `{}`，不得省略键。
   */
  inFlightByProject: Record<string, DispatchLaneCounts>;
  /**
   * **闸的按项目排队计数**（v0.8.10 增补轨 · A1）：
   * `{ [projectId]: { write, read, oldestWaitedMs } }`。
   * **恒在**：无排队 ⇒ `{}`，不得省略键。
   */
  queuedByProject: Record<string, DispatchQueueCounts>;
  /**
   * **全局最近一次「定向取消 / 收尾取消 → 静默」取消往返耗时**（毫秒；v0.8.10 增补轨 · A1），
   * 数据源 = 停事件账（`lastCancelQuiesceMsOverall`）。
   * **恒在**：无取消往返观测 ⇒ `null`，不得省略键。
   */
  lastCancelQuietMs: number | null;
}

/** `buildDegradedStatus` 的原料：全部为各组件的只读现值，装配点不做加工 */
export interface DegradedInputs {
  /** 原始配置值（`launcher.startupCheck`），缺省 `undefined` = 自检开启 */
  startupCheck?: boolean;
  selfCheckFailures: readonly SelfCheckFailure[];
  unavailableProjectIds: readonly string[];
  outboxLoopAlive: boolean;
  outboxPendingCount: number;
  runnerLoopAlive: boolean;
  inFlightCount: number;
  /** 缺省 = 无观察（空数组）；由 `index.ts` 从停事件账读点注入 */
  cancelUnsupported?: readonly string[];
  /** 闸快照（`Runner.gateSnapshot()`）；缺省 = 未接 bridge / 无活动 ⇒ 两映射均空 */
  gate?: DispatchGateSnapshot;
  /** 全局最近一次「取消 → 静默」取消往返毫秒（缺省 / null = 无观察） */
  lastCancelQuietMs?: number | null;
}

/** 组装 `degraded` 段（纯函数）：负向用例的可测点，尤其「跳过自检不得伪装成自检通过」 */
export function buildDegradedStatus(inputs: DegradedInputs): DegradedStatus {
  return {
    selfCheckSkipped: inputs.startupCheck === false,
    selfCheckFailedProjects: inputs.selfCheckFailures.map((failure) => ({
      projectId: failure.projectId,
      stage: failure.stage,
      ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
    })),
    unavailableProjectIds: [...inputs.unavailableProjectIds],
    outboxLoopAlive: inputs.outboxLoopAlive,
    outboxPendingCount: inputs.outboxPendingCount,
    runnerLoopAlive: inputs.runnerLoopAlive,
    inFlightCount: inputs.inFlightCount,
    cancelUnsupported: [...(inputs.cancelUnsupported ?? [])],
    inFlightByProject: inputs.gate?.inFlightByProject ?? {},
    queuedByProject: inputs.gate?.queuedByProject ?? {},
    lastCancelQuietMs: inputs.lastCancelQuietMs ?? null,
  };
}

/** 未装配读点时的恒定原料（无降级基线；`buildDegradedStatus` 每次产出新对象，不共享可变引用） */
const IDLE_DEGRADED: DegradedInputs = {
  selfCheckFailures: [],
  unavailableProjectIds: [],
  outboxLoopAlive: false,
  outboxPendingCount: 0,
  runnerLoopAlive: false,
  inFlightCount: 0,
};

export interface LauncherAppOptions {
  /** 就绪门：自检通过前返回 false ⇒ `/health` 报 `status:"starting"`；缺省恒 true */
  isReady?: () => boolean;
  /**
   * `/health` 的 `bridge` 段读点（M2·MA2）。缺省 = 未启用 bridge：
   * `registered` 恒 false。只读、无副作用，允许每次请求调用。
   */
  getBridgeStatus?: () => BridgeHealthStatus;
  /**
   * `/health` 的 `degraded` 段读点（v0.8.8 · M4）。缺省 = 无降级基线。
   * 只读、无副作用，允许每次请求调用（纪律同 `getBridgeStatus`）。
   */
  getDegraded?: () => DegradedStatus;
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
  const getDegraded =
    options.getDegraded ?? ((): DegradedStatus => buildDegradedStatus(IDLE_DEGRADED));
  const app = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      status: isReady() ? "ok" : "starting",
      bridge: getBridgeStatus(),
      degraded: getDegraded(),
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
