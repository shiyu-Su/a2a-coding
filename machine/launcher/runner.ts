/**
 * Runner 出站栈（v0.7.0 Phase A 影子注册 · 节点 MA1）。
 *
 * 连接模型反转的第一块 machine 侧地基：Launcher 升格为 Runner，**主动出站**连接 orch 桥。
 * （MA1 只做「影子注册」；入站端点已于 M5·MC1 退役，见 `server.ts`。）出站循环：
 *
 *   启动自检通过后 → `POST {bridge.url}/runner/register`（携注册载荷）
 *     → `POST {bridge.url}/runner/connect` 长轮询（空响应 = 心跳；有响应 = 命令）
 *
 * Phase A（MA1）只做「影子注册」；**Phase B（MB1）**在其上接驳命令执行 —— 除注册载荷 /
 * 长轮询 / 退避外，命令族三类（dispatch / stop / cancel-task）交由 `runner-exec.ts` 执行，
 * 结果交 outbox 回传（**M4·MB2** 起由 `runner-outbox.ts` 的 `FileOutbox` 落盘并投递
 * `/runner/result`）。本模块仍显式不做：
 * - 不退役入站端点（M5）、不改 adapter / wrapper；
 * - 不 bump 协议常量（由 MPT 节点负责），注册载荷里的 `protocolVersion` 取当前常量。
 *
 * 出口路径收敛：本模块是 machine 侧**唯一**的出站 HTTP 出口（全部经 `FetchLike`），
 * 便于后续节点审计与替换。
 *
 * 失败语义：401/403 等 HTTP 错误一律结构化（`RunnerHttpError`：status + code）并进入
 * 退避，**绝不崩进程**；退避 1s → 2s → 4s → … cap 30s，±20% jitter。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig, MachineConfig, RiskLevel } from "../types.js";
import { PROTOCOL_VERSION } from "../types.js";
import { appRootFromModule } from "./app-root.js";
import { errorMessage } from "./process.js";
import {
  RunnerCommandExecutor,
  createLoggingOutbox,
  parseRunnerCommand,
  type RunnerCommandAck,
  type RunnerExecHost,
  type RunnerOutbox,
} from "./runner-exec.js";
import { RunnerStateWriter } from "./runner-state.js";
import type { SelfCheckFailure, SelfCheckResult } from "./self-check.js";

/** 长轮询客户端超时：服务端 hold ~25s，客户端 30s 兜底 */
export const RUNNER_CONNECT_TIMEOUT_MS = 30_000;

/** 注册请求超时：注册是短请求，不应拖满长轮询预算 */
export const RUNNER_REGISTER_TIMEOUT_MS = 10_000;

/** 退避基数（首次失败 1s） */
export const BACKOFF_BASE_MS = 1_000;

/** 退避上限（30s） */
export const BACKOFF_CAP_MS = 30_000;

/** 退避抖动幅度（±20%） */
export const BACKOFF_JITTER_RATIO = 0.2;

/** 出站 HTTP 出口类型（可注入，便于单测；缺省为全局 `fetch`） */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 可注入日志口（单测静音用） */
export interface RunnerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const defaultLogger: RunnerLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/** 可扩展能力声明（Phase A 为 `{}`，后续节点按需扩展；桥侧忽略未知字段） */
export type RunnerCapabilities = Record<string, unknown>;

/** 注册载荷中的单个项目（只含归属 / 路由所需字段，不含 workspace / agentConfig） */
export interface RunnerProjectPayload {
  projectId: string;
  agentKind: MachineConfig["projects"][number]["agentKind"];
  /** 解析后的有效风险档位（缺省 `write`，与 manager 的权限映射同口径） */
  risk: RiskLevel;
  a2aPort: number;
}

/** 注册载荷中的自检结论（部分项目失败 `ok=true` 仍注册；仅**全部项目不可用**才不注册） */
export interface RunnerSelfCheckPayload {
  ok: boolean;
  failures: SelfCheckFailure[];
}

/** `POST /runner/register` 载荷 */
export interface RunnerRegisterPayload {
  machineId: string;
  projects: RunnerProjectPayload[];
  capabilities: RunnerCapabilities;
  selfCheck: RunnerSelfCheckPayload;
  protocolVersion: string;
  /** Runner 软件版本（观测用，非 `protocolVersion`）：取 `machine/package.json` 的 `version` */
  version: string;
}

/** Runner 内部状态（注册 / 心跳 / 拨款；Phase A 仅前两者被写，供后续节点接驳） */
export interface RunnerState {
  registered: boolean;
  lastRegisteredAt: string | null;
  lastHeartbeatAt: string | null;
  /** 最近一次长轮询完成时刻（成功 / 失败 / 超时均刷新；M6·MC2 起为 runner-state 的新鲜度锚点） */
  lastPollAt: string | null;
  lastCommandAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** 连续失败次数（成功后清零） */
  failures: number;
  /** 退避尝试序号（0 = 首次失败） */
  backoffAttempt: number;
  /** 最近一次计算出的退避时长（毫秒，含抖动；观测用） */
  nextBackoffMs: number | null;
  /** 收到并处理的命令条数（含无法识别者；M3·MB1 起执行命令族三类） */
  commandsReceived: number;
}

function createRunnerState(): RunnerState {
  return {
    registered: false,
    lastRegisteredAt: null,
    lastHeartbeatAt: null,
    lastPollAt: null,
    lastCommandAt: null,
    lastError: null,
    lastErrorAt: null,
    failures: 0,
    backoffAttempt: 0,
    nextBackoffMs: null,
    commandsReceived: 0,
  };
}

/**
 * Runner 注册态快照（v0.7.0 M2·MA2）：Launcher `/health` 的 `bridge` 段数据源。
 * 只读派生自 `RunnerState`，**不触发任何网络 / 状态变更**。字段与 `server.ts` 的
 * `BridgeHealthStatus` 结构一致（后者为 HTTP 契约，二者保持同形）。
 */
export interface RunnerHealthSnapshot {
  registered: boolean;
  lastHeartbeatAt: string | null;
  lastError: string | null;
}

/** 本机在飞任务台账条目（内存态；Phase A 备好数据结构，Phase B 接驳命令执行） */
export interface InFlightEntry {
  taskId: string;
  projectId: string;
  /** 领取 / 派发时刻（UTC ISO 8601），供 idleStop 判据与对账使用 */
  startedAt: string;
  /**
   * 本地包装器返回的 A2A 任务 id（`message/send` 返回后回填）。
   * `null` = 尚未取得句柄（send 在途 / Message 直返），cancel-task 据此判定可否取消。
   */
  a2aTaskId?: string | null;
}

/**
 * 在飞任务台账（内存 `Map<taskId, InFlightEntry>`）。
 * Phase A 提供数据结构与增删查；Phase B 起作为命令执行的计/清事实源
 * （`stop` 判据 = `size === 0`；`cancel-task` 经 `projectOf` / `get` 定位）。
 */
export class InFlightLedger {
  private readonly entries = new Map<string, InFlightEntry>();

  add(entry: InFlightEntry): void {
    this.entries.set(entry.taskId, entry);
  }

  remove(taskId: string): boolean {
    return this.entries.delete(taskId);
  }

  has(taskId: string): boolean {
    return this.entries.has(taskId);
  }

  get(taskId: string): InFlightEntry | undefined {
    return this.entries.get(taskId);
  }

  projectOf(taskId: string): string | null {
    return this.entries.get(taskId)?.projectId ?? null;
  }

  get size(): number {
    return this.entries.size;
  }

  snapshot(): InFlightEntry[] {
    return [...this.entries.values()];
  }

  clear(): void {
    this.entries.clear();
  }
}

/** 结构化出站错误：HTTP 状态码 + 桥错误码（401 `runner_unauthorized` / 403 `runner_not_allowed` …） */
export class RunnerHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RunnerHttpError";
    this.status = status;
    this.code = code;
  }
}

function defaultErrorCode(status: number): string {
  if (status === 401) return "runner_unauthorized";
  if (status === 403) return "runner_not_allowed";
  return `http_${status}`;
}

/**
 * 计算退避时长：`min(1000 * 2^attempt, 30000)` 再乘 ±20% jitter。
 * attempt 0 → 1s、1 → 2s、2 → 4s、3 → 8s、4 → 16s、5+ → 30s（cap）。
 * `random` 注入以便单测断言确定性；缺省 `Math.random`。
 */
export function computeBackoffDelayMs(attempt: number, random: () => number): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const base = Math.min(BACKOFF_BASE_MS * 2 ** safeAttempt, BACKOFF_CAP_MS);
  const factor = 1 + (random() * 2 - 1) * BACKOFF_JITTER_RATIO;
  return Math.round(base * factor);
}

/**
 * 读 `machine/package.json` 的 `version`（Runner 软件版本，**观测用**，非协议版本）。
 *
 * 按 PROTOCOL.md 2.0 的 `/runner/register` 契约，`version` 为**可选字段**；此处自报本单元
 * `package.json` 版本即可（读取 / 解析失败回落 `"0.0.0"`，不阻塞注册）。
 */
function readRunnerVersion(): string {
  try {
    const raw = readFileSync(join(appRootFromModule(import.meta.url), "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return "0.0.0";
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 进程内缓存的 Runner 软件版本（模块加载时读一次；注册载荷 `version` 字段用） */
export const RUNNER_VERSION = readRunnerVersion();

/** 纯函数：由机器配置 + 自检结论构造注册载荷（单测直接断言） */
export function buildRegisterPayload(
  machine: MachineConfig,
  selfCheck: SelfCheckResult,
  capabilities: RunnerCapabilities = {},
): RunnerRegisterPayload {
  return {
    machineId: machine.machineId,
    projects: machine.projects.map((project) => ({
      projectId: project.projectId,
      agentKind: project.agentKind,
      // 缺省 write（与 manager.ts 权限映射同口径），保证桥看到的即实际执行档位
      risk: project.risk ?? "write",
      a2aPort: project.a2aPort,
    })),
    capabilities: { ...capabilities },
    selfCheck: { ok: selfCheck.ok, failures: selfCheck.failures },
    protocolVersion: PROTOCOL_VERSION,
    version: RUNNER_VERSION,
  };
}

/** Runner 依赖注入口（缺省取全局实现；单测注入 fake） */
export interface RunnerDeps {
  fetch?: FetchLike;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  logger?: RunnerLogger;
  capabilities?: RunnerCapabilities;
  now?: () => Date;
  /**
   * 命令执行宿主（`AgentManager` 结构化满足，M3·MB1）。
   * 缺省 = 不接执行器 ⇒ 收到命令仅计数 / 记日志（Phase A 行为，零回归）。
   */
  manager?: RunnerExecHost;
  /**
   * 结果回传出口（M4·MB2 文件 outbox，由 `launcher/index.ts` 注入）；
   * 缺省 = 仅记日志的 stub。其 `start?()` / `stop?()` 随 Runner 生命周期调用。
   */
  outbox?: RunnerOutbox;
  /** 单任务派发等待上限；缺省 {@link DEFAULT_DISPATCH_TIMEOUT_MS} */
  dispatchTimeoutMs?: number;
  /**
   * runner-state 落盘路径（`<machine 根>/.a2a/runner-state.json`，M6·MC2）。
   * 缺省 = **不落盘**（单测 / 未接线），生产由 `launcher/index.ts` 注入；保证既有调用零回归。
   */
  runnerStatePath?: string;
  /** runner-state 非强制写的节流间隔（ms）；缺省 {@link RUNNER_STATE_WRITE_THROTTLE_MS} */
  runnerStateThrottleMs?: number;
  /**
   * 本机在飞任务台账（v0.7.0 · M5·MC1）：与 `AgentManager` **共享同一实例**，
   * 使 idleStop 判据（`inflight==0` 且静默 ≥ `idleStopMs`）能看到命令族派发的在飞任务。
   * 缺省 = 自建（单测 / 未接线；与 manager 不共享，行为同旧版）。
   */
  ledger?: InFlightLedger;
}

/** 缺省可中断 sleep：`stop()` 触发 abort 时立即 resolve，保证退出有界 */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref();
    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

interface PostResult {
  status: number;
  ok: boolean;
  text: string;
  body: unknown;
}

/** 从统一外壳 `{ result, data, error }` 中提取错误码 / 错误信息（error 可为字符串或对象） */
function extractBridgeError(body: unknown): { code: string | null; message: string | null } {
  if (typeof body !== "object" || body === null) return { code: null, message: null };
  const error = (body as Record<string, unknown>)["error"];
  if (typeof error === "string") return { code: null, message: error };
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return {
      code: typeof record["code"] === "string" ? record["code"] : null,
      message: typeof record["message"] === "string" ? record["message"] : null,
    };
  }
  return { code: null, message: null };
}

/**
 * Runner 出站循环。
 *
 * 生命周期：`start()`（后台循环）→ `stop()`（幂等，abort 在飞请求与退避等待）。
 * 单次动作（`register()` / `connect()`）公开以便单测逐步驱动。
 */
export class Runner {
  readonly state: RunnerState = createRunnerState();
  readonly inFlight: InFlightLedger;

  private readonly bridge: BridgeConfig;
  private readonly registerPayload: RunnerRegisterPayload;
  private readonly fetchFn: FetchLike;
  private readonly sleepFn: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly logger: RunnerLogger;
  private readonly now: () => Date;
  /** 命令执行器（M3·MB1）；未注入 `manager` 时为 null（Phase A 计数行为） */
  private readonly executor: RunnerCommandExecutor | null;
  /** 结果回传出口（M4·MB2 起生产注入 `FileOutbox`）；其生命周期随本 Runner 启停 */
  private readonly outbox: RunnerOutbox;
  /** 本机 Launcher 端口（runner-state 落盘字段） */
  private readonly port: number;
  /** runner-state 写入器（M6·MC2）；未注入 `runnerStatePath` 时为 null（不落盘） */
  private readonly stateWriter: RunnerStateWriter | null;
  /** 待随下一轮长轮询回传的命令回执（stop / cancel-task） */
  private readonly pendingAcks: RunnerCommandAck[] = [];

  private running = false;
  private stopped = false;
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    machine: MachineConfig,
    bridge: BridgeConfig,
    selfCheck: SelfCheckResult,
    deps: RunnerDeps = {},
  ) {
    this.bridge = bridge;
    this.registerPayload = buildRegisterPayload(machine, selfCheck, deps.capabilities ?? {});
    this.port = machine.launcher.port;
    // M5·MC1：与 AgentManager 共享同一在飞台账（idleStop 判据数据源）；缺省自建（旧行为）
    this.inFlight = deps.ledger ?? new InFlightLedger();
    this.stateWriter =
      deps.runnerStatePath === undefined
        ? null
        : new RunnerStateWriter({
            path: deps.runnerStatePath,
            machineId: this.registerPayload.machineId,
            port: this.port,
            selfCheck: this.registerPayload.selfCheck,
            logger: deps.logger,
            now: deps.now,
            ...(deps.runnerStateThrottleMs !== undefined
              ? { throttleMs: deps.runnerStateThrottleMs }
              : {}),
          });
    this.fetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
    this.sleepFn = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.logger = deps.logger ?? defaultLogger;
    this.now = deps.now ?? (() => new Date());
    this.outbox = deps.outbox ?? createLoggingOutbox(this.logger);
    this.executor =
      deps.manager === undefined
        ? null
        : new RunnerCommandExecutor({
            host: deps.manager,
            ledger: this.inFlight,
            machineId: this.registerPayload.machineId,
            outbox: this.outbox,
            logger: this.logger,
            ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
            ...(deps.now !== undefined ? { now: deps.now } : {}),
            ...(deps.dispatchTimeoutMs !== undefined
              ? { dispatchTimeoutMs: deps.dispatchTimeoutMs }
              : {}),
          });
  }

  /** 启动后台出站循环（幂等；`stop()` 可终止） */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.abortController = new AbortController();
    // 结果回传 outbox（M4·MB2）：与出站循环同生命周期启停（boot 不补发既有文件）
    this.outbox.start?.();
    // 初始落盘（状态变更即时写）：让 reaper 在注册前的窗口也能看到本 Runner 进程
    this.persistState(true);
    this.loopPromise = this.loop().catch((err: unknown) => {
      // 循环自身已全捕获；此处兜底，保证永不产生未处理拒绝
      this.logger.error(`[runner] 循环异常退出：${errorMessage(err)}`);
    });
  }

  /** 停止出站循环（幂等）：中止在飞请求与退避等待，保证退出有界 */
  stop(): void {
    this.stopped = true;
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    // 结果回传 outbox 随之停止（中止在飞回传请求与退避等待）
    this.outbox.stop?.();
    // 关停前落盘一次最终态（观测用；写盘失败不影响退出）
    this.persistState(true);
  }

  /** 等待循环结束（单测 / 关停编排用） */
  whenStopped(): Promise<void> {
    return this.loopPromise ?? Promise.resolve();
  }

  /**
   * 供 Launcher `/health` 读取的注册态快照（M2·MA2 读点）。
   * 纯只读：不回写 state、不发起请求，可任意频次调用。
   */
  healthSnapshot(): RunnerHealthSnapshot {
    return {
      registered: this.state.registered,
      lastHeartbeatAt: this.state.lastHeartbeatAt,
      lastError: this.state.lastError,
    };
  }

  /** 单次注册尝试：成功即返回；HTTP / 网络失败抛出（由循环退避） */
  async register(): Promise<void> {
    const url = this.endpoint("/runner/register");
    const res = await this.post(url, this.registerPayload, RUNNER_REGISTER_TIMEOUT_MS);
    if (!res.ok) throw this.toHttpError(res);
    this.state.registered = true;
    this.state.lastRegisteredAt = this.isoNow();
    this.markHealthy();
    this.persistState(true);
    this.logger.info(
      `[runner] 注册成功：url=${url} machineId=${this.registerPayload.machineId} projects=${this.registerPayload.projects.length}`,
    );
  }

  /**
   * 单次长轮询：空响应 = 心跳；非空响应 = 命令（M3·MB1 起按命令族三类执行）。
   *
   * 请求体携带**上一轮产生的 acks**（stop / cancel-task 回执）；仅当本次响应成功
   * （HTTP ok）才清除待回传 acks，失败 / 网络异常则原样留到下一轮重投。
   * 未注入执行宿主（`RunnerDeps.manager`）时退化为 Phase A 行为：仅计数 / 记日志。
   */
  async connect(): Promise<"heartbeat" | "command"> {
    const url = this.endpoint("/runner/connect");
    const acks = this.pendingAcks.splice(0, this.pendingAcks.length);
    let res: PostResult;
    try {
      res = await this.post(
        url,
        { machineId: this.registerPayload.machineId, ...(acks.length > 0 ? { acks } : {}) },
        RUNNER_CONNECT_TIMEOUT_MS,
      );
    } catch (err) {
      this.pendingAcks.unshift(...acks);
      throw err;
    }
    if (!res.ok) {
      this.pendingAcks.unshift(...acks);
      throw this.toHttpError(res);
    }

    if (hasCommand(res)) {
      this.state.commandsReceived += 1;
      this.state.lastCommandAt = this.isoNow();
      this.markHealthy();
      await this.handleCommand(res.body);
      this.persistState(true);
      return "command";
    }

    this.state.lastHeartbeatAt = this.isoNow();
    this.markHealthy();
    this.persistState(true);
    return "heartbeat";
  }

  /** 解析并执行一条命令；dispatch 后台执行，stop / cancel-task 的回执排队待下一轮回传 */
  private async handleCommand(body: unknown): Promise<void> {
    const command = parseRunnerCommand(body);
    if (command === null) {
      this.logger.warn(
        `[runner] 收到无法识别的命令（累计 ${this.state.commandsReceived} 条），已忽略`,
      );
      return;
    }
    if (this.executor === null) {
      this.logger.warn(
        `[runner] 收到命令 ${command.type}，但未注入执行宿主（仅计数；累计 ${this.state.commandsReceived} 条）`,
      );
      return;
    }
    const ack = await this.executor.handle(command);
    if (ack !== null) this.pendingAcks.push(ack);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.register();
        break;
      } catch (err) {
        if (this.stopped) return;
        await this.handleFailure("register", err);
      }
    }

    while (!this.stopped) {
      // 轮询起点：刷新 lastPollAt（runner-state 新鲜度锚点之一）
      this.state.lastPollAt = this.isoNow();
      try {
        await this.connect();
      } catch (err) {
        if (this.stopped) return;
        await this.handleFailure("connect", err);
      } finally {
        // 每轮轮询节流写（状态变更路径已按 force 即时写，此处只兜底更新节拍字段）
        if (!this.stopped) this.persistState(false);
      }
    }
  }

  /** 组装 runner-state 快照并落盘（无写入器时为空操作） */
  private persistState(force: boolean): void {
    if (this.stateWriter === null) return;
    this.stateWriter.write(
      {
        registeredAt: this.state.lastRegisteredAt,
        lastHeartbeatAt: this.state.lastHeartbeatAt,
        lastPollAt: this.state.lastPollAt,
        lastError: this.state.lastError,
        inflightCount: this.inFlight.size,
      },
      { force },
    );
  }

  private async handleFailure(phase: "register" | "connect", err: unknown): Promise<void> {
    const delay = computeBackoffDelayMs(this.state.backoffAttempt, this.random);
    this.state.backoffAttempt += 1;
    this.state.failures += 1;
    this.state.nextBackoffMs = delay;
    this.state.lastError = errorMessage(err);
    this.state.lastErrorAt = this.isoNow();
    // 状态变更即时写（lastError / 退避进度落盘，供 reaper 与运维观测）
    this.persistState(true);
    const detail =
      err instanceof RunnerHttpError ? `status=${err.status} code=${err.code}` : "transport-error";
    this.logger.error(
      `[runner] ${phase} 失败（${detail}，连续第 ${this.state.failures} 次，${delay}ms 后重试）：${this.state.lastError}`,
    );
    await this.sleepFn(delay, this.abortController?.signal ?? new AbortController().signal);
  }

  /** 成功（注册 / 心跳 / 命令）后的状态复位 */
  private markHealthy(): void {
    this.state.lastError = null;
    this.state.lastErrorAt = null;
    this.state.failures = 0;
    this.state.backoffAttempt = 0;
    this.state.nextBackoffMs = null;
  }

  private endpoint(path: string): string {
    return `${trimTrailingSlash(this.bridge.url)}${path}`;
  }

  private isoNow(): string {
    return this.now().toISOString();
  }

  private toHttpError(res: PostResult): RunnerHttpError {
    const parsed = extractBridgeError(res.body);
    const code = parsed.code ?? defaultErrorCode(res.status);
    const message = parsed.message ?? `HTTP ${res.status}`;
    return new RunnerHttpError(res.status, code, message);
  }

  private async post(url: string, body: unknown, timeoutMs: number): Promise<PostResult> {
    const signal = this.abortController?.signal;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined =
      signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, signal]);
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${this.bridge.token}`,
      },
      body: JSON.stringify(body),
      signal: combined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.trim().length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }
    return { status: res.status, ok: res.ok, text, body: parsed };
  }
}

/** 非空 JSON 对象响应视为「有命令」；空响应 / 204 / `null` 视为心跳 */
function hasCommand(res: PostResult): boolean {
  if (res.text.trim().length === 0) return false;
  if (typeof res.body !== "object" || res.body === null) return false;
  return Object.keys(res.body).length > 0;
}

/**
 * 由机器配置创建 Runner：`launcher.bridge` 缺省时返回 `null`（**不启动出站**，零网络调用）。
 */
export function createRunner(
  machine: MachineConfig,
  selfCheck: SelfCheckResult,
  deps: RunnerDeps = {},
): Runner | null {
  const bridge = machine.launcher.bridge;
  if (bridge === undefined) return null;
  return new Runner(machine, bridge, selfCheck, deps);
}
