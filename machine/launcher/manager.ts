/**
 * 本机项目 Agent 生命周期管理（内存态）：
 * 按需幂等启动（ensure）、停止、状态聚合；不做服务发现（静态分布约束）。
 */
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../adapters/index.js";
import type {
  ChildLedgerEntry,
  EnsureResult,
  MachineConfig,
  ProjectConfig,
  ProjectStatus,
  StopResult,
} from "../types.js";
import { appRootFromModule } from "./app-root.js";
import { describeAgentConfig } from "./config-snapshot.js";
import { waitForPort } from "./ports.js";
import {
  errorMessage,
  hasExited,
  killProcessTreeSync,
  pipeChildOutput,
  spawnAgentProcess,
  terminateChild,
} from "./process.js";

/** 启动后等待 A2A 端口就绪的总超时 */
const STARTUP_TIMEOUT_MS = 30_000;

/** 空闲回收（用完退出）缺省时长：超过该毫秒数无 ensure 调用即自动 stop */
export const DEFAULT_IDLE_STOP_MS = 300_000;

/**
 * 账本 `command` 的**脱敏**（REQ-v0.8.5-2026-09-21-01 · B17）：`--session-meta-json` 的取值
 * 遮蔽为 `<redacted>` —— 该字段语义「不含环境变量」保持为真，且**敏感 argv 取值不得进账本**
 * （硬约束：凭据类值一律不进 argv）。其余参数逐字保留，便于诊断。
 */
export function redactArgv(args: readonly string[]): string {
  const redacted: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) continue;
    redacted.push(token);
    if (token === "--session-meta-json" && i + 1 < args.length) {
      redacted.push("<redacted>");
      i += 1; // 跳过原值
    }
  }
  return redacted.join(" ");
}

/** 请求的项目不在本机配置中 */
export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`未知项目：${projectId}`);
  }
}

/** 项目 Agent 拉起失败（spawn 失败或端口未就绪） */
export class AgentStartError extends Error {
  constructor(projectId: string, reason: string) {
    super(`项目 ${projectId} 启动失败：${reason}`);
  }
}

/**
 * 本机在飞任务台账的**最小读写面**（结构上由 `runner.ts` 的 `InFlightLedger` 满足）。
 * 定义此结构类型而**不 import** 具体类，避免 `manager ↔ runner` 的运行时循环依赖。
 * M5·MC1 起它同时是 idleStop 判据的数据源（`size`）与自检任务的登记口（`add` / `remove`）。
 */
export interface InFlightLedgerLike {
  readonly size: number;
  add(entry: {
    taskId: string;
    projectId: string;
    startedAt: string;
    a2aTaskId?: string | null;
  }): void;
  remove(taskId: string): boolean;
  has(taskId: string): boolean;
}

/** 未注入台账时的空实现（恒无在飞 ⇒ 到点即回收，等价旧行为；生产由入口注入共享实例） */
const EMPTY_IN_FLIGHT: InFlightLedgerLike = {
  size: 0,
  add: (): void => {},
  remove: (): boolean => false,
  has: (): boolean => false,
};

export interface AgentManagerDeps {
  /**
   * 本机在飞任务台账（v0.7.0 M5·MC1：idleStop 判据数据源）。
   * 生产由 `launcher/index.ts` 创建**单一实例**并同时注入本管理器与 Runner（共享）。
   */
  inFlight?: InFlightLedgerLike;
}

interface RunningAgent {
  projectId: string;
  child: ChildProcess;
  endpoint: string;
  startedAt: string;
}

/** A2A 端点约定：本机回环 + 项目 a2aPort */
export function agentEndpoint(a2aPort: number): string {
  return `http://127.0.0.1:${a2aPort}`;
}

/** 子进程账本目录（`<machine 根>/.a2a/children`；每次调用重新解析，构建/源码两种运行方式均可用） */
export function childLedgerDir(): string {
  return join(appRootFromModule(import.meta.url), ".a2a", "children");
}

/** 账本条目路径 `<machine 根>/.a2a/children/<pid>.json` */
function childLedgerPath(pid: number): string {
  return join(childLedgerDir(), `${pid}.json`);
}

/**
 * write-ahead 写账本（spawn 返回即调用，早于 `waitForPort` / `running.set`）。
 * **fail-safe**：任何失败只记日志，绝不影响拉起流程（账本不是拉起的必要条件）。
 */
export function writeChildLedgerEntry(entry: ChildLedgerEntry): void {
  try {
    mkdirSync(childLedgerDir(), { recursive: true });
    writeFileSync(childLedgerPath(entry.pid), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.error(`[launcher] 写子进程账本失败（不影响运行）：${errorMessage(err)}`);
  }
}

/**
 * 删账本条目（幂等）。**fail-safe**：失败只记日志。
 * `force: true` 使「shutdown 显式清 → 随后 exit 事件再清」的重复删除无害。
 */
export function removeChildLedgerEntry(pid: number): void {
  try {
    rmSync(childLedgerPath(pid), { force: true });
  } catch (err) {
    console.error(`[launcher] 删子进程账本失败（不影响运行）：${errorMessage(err)}`);
  }
}

/**
 * 空闲回收判据（纯函数，v0.7.0 · M5·MC1 新口径）：
 * `inflight == 0 && (now - lastActivity) >= idleStopMs` ⇒ 可本地 stop。
 *
 * **忽略 bridge 可达性**：桥心跳失败只降 Runner 注册态字段（`registered` / `lastError`），
 * 不进入本判据（本函数甚至不接收该输入）⇒ 心跳失败**绝不**触发 stop。
 * `idleStopMs <= 0` = 禁用空闲回收；`inFlightCount > 0` = 有在飞任务 ⇒ 恒 false。
 */
export function isIdleStopDue(opts: {
  inFlightCount: number;
  lastActivityMs: number;
  nowMs: number;
  idleStopMs: number;
}): boolean {
  if (opts.idleStopMs <= 0) return false;
  if (opts.inFlightCount > 0) return false;
  return opts.nowMs - opts.lastActivityMs >= opts.idleStopMs;
}

/** 空闲计时句柄（单测注入假实现，避免真实等待） */
export interface IdleTimerHandle {
  cancel(): void;
}

export interface IdleReaperOptions {
  /** 有效空闲回收时长（ms）；`<=0` = 禁用（不排任何计时） */
  idleStopMs: number;
  /** 本机当前在飞任务数（数据源 = `InFlightLedger.size`） */
  inFlightCount: () => number;
  /** 判据成立时的本地回收动作（由调用方执行 `stop`） */
  onIdle: (projectId: string) => void;
  /** 时钟（ms epoch；缺省 `Date.now`；单测注入假时钟） */
  now?: () => number;
  /** 定时器（缺省 `setTimeout`；单测注入假实现） */
  setTimer?: (callback: () => void, ms: number) => IdleTimerHandle;
  /** 日志（缺省 `console.log`） */
  log?: (message: string) => void;
}

interface IdleEntry {
  lastActivityMs: number;
  handle: IdleTimerHandle | null;
}

function defaultIdleSetTimer(callback: () => void, ms: number): IdleTimerHandle {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

/**
 * 每项目空闲回收计时（M5·MC1）：`noteActivity` 复位静默基准并重新计时；到点按
 * {@link isIdleStopDue} 判定 —— **有在飞任务或未满静默则不停**（按同一时长重查，
 * 且**不复位**静默基准），否则回调 `onIdle`（本地 stop）。
 *
 * 本类**不接收任何 bridge / 网络输入**，故 bridge 可达性与回收决策天然解耦。
 */
export class IdleReaper {
  private readonly entries = new Map<string, IdleEntry>();

  constructor(private readonly options: IdleReaperOptions) {}

  /** 记一次活动（启动成功 / ensure 复用）：复位静默基准并按 `idleStopMs` 重新计时 */
  noteActivity(projectId: string): void {
    this.entries.get(projectId)?.handle?.cancel();
    const entry: IdleEntry = { lastActivityMs: this.now(), handle: null };
    this.entries.set(projectId, entry);
    if (this.options.idleStopMs <= 0) return;
    this.arm(projectId, entry, this.options.idleStopMs);
  }

  /** 清除某项目的空闲计时（停止 / 退出 / 回收路径）；幂等 */
  clear(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (entry === undefined) return;
    entry.handle?.cancel();
    this.entries.delete(projectId);
  }

  /** 清除全部空闲计时（进程退出路径） */
  clearAll(): void {
    for (const projectId of [...this.entries.keys()]) this.clear(projectId);
  }

  private arm(projectId: string, entry: IdleEntry, idleMs: number): void {
    const setTimer = this.options.setTimer ?? defaultIdleSetTimer;
    entry.handle = setTimer(() => {
      // 条目已被 clear / 替换 ⇒ 跳过（正常路径已 cancel，此处为双保险）
      if (this.entries.get(projectId) !== entry) return;
      entry.handle = null;
      const due = isIdleStopDue({
        inFlightCount: this.options.inFlightCount(),
        lastActivityMs: entry.lastActivityMs,
        nowMs: this.now(),
        idleStopMs: idleMs,
      });
      if (!due) {
        // 有在飞任务 / 未满静默：不停，按同一判据重查（不复位静默基准）
        this.arm(projectId, entry, idleMs);
        return;
      }
      (this.options.log ?? ((message: string) => console.log(message)))(
        `[launcher] agent ${projectId} 空闲超时（${idleMs}ms 无调用且无在飞任务），自动回收（用完退出）`,
      );
      this.options.onIdle(projectId);
    }, idleMs);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export class AgentManager {
  private readonly config: MachineConfig;
  /** 本机在飞任务台账（M5·MC1：与 Runner 共享同一实例；自检经此登记） */
  readonly inFlight: InFlightLedgerLike;
  /** 空闲回收计时（M5·MC1：判据 = inflight==0 且静默 ≥ idleStopMs） */
  private readonly idle: IdleReaper;
  private readonly running = new Map<string, RunningAgent>();
  /**
   * 自检判定不可用的项目集（§2.4-⑤）：projectId → 不可用原因。
   * 机器不因单项目不可用而退出，但被登记的项目此后 `ensure()` 直接抛 `AgentStartError`
   * （运行期 dispatch 已把该异常转成任务 failed）。
   */
  private readonly unavailable = new Map<string, string>();
  /** 进行中的 ensure（防并发重复拉起同一项目） */
  private readonly pending = new Map<string, Promise<EnsureResult>>();
  /**
   * 唯一子进程生命周期注册表（spawn 返回即注册）：
   * key 形如 `${projectId}:agent`。这是退出清理的**唯一事实源**，
   * 覆盖 `running` 与「spawn→注册窗口」的 child。
   */
  private readonly allChildren = new Map<string, ChildProcess>();
  /** 退出中标志：置位后 `start()` 拒绝拉起，`running.set` 前二次校验，防止僵死注册 */
  private shuttingDown = false;

  constructor(config: MachineConfig, deps: AgentManagerDeps = {}) {
    this.config = config;
    this.inFlight = deps.inFlight ?? EMPTY_IN_FLIGHT;
    this.idle = new IdleReaper({
      idleStopMs: this.effectiveIdleStopMs(),
      inFlightCount: () => this.inFlight.size,
      onIdle: (projectId) => {
        void this.stop(projectId).catch((err: unknown) => {
          console.error(`[launcher] agent ${projectId} 空闲回收失败：${errorMessage(err)}`);
        });
      },
    });
  }

  /**
   * 登记子进程（spawn 返回后**立即**调用，早于 `waitForPort` / `running.set`）。
   * `exit`/`error` 时自动移除，保证「spawn→注册窗口」归零（退出清理不漏）。
   *
   * 同时 **write-ahead 落账本** `<machine 根>/.a2a/children/<pid>.json`（一进程一文件），
   * 供启动对账清理与 `reaper.mjs` 判定孤儿。
   */
  private trackChild(
    key: string,
    child: ChildProcess,
    meta: { projectId: string; kind: ChildLedgerEntry["kind"]; command?: string },
  ): void {
    this.allChildren.set(key, child);

    const pid = child.pid;
    if (pid === undefined) {
      // 无 pid 无法命名账本文件：只记日志，不阻塞拉起（fail-safe）
      console.error(`[launcher] 子进程 ${key} 无 pid，跳过账本登记`);
    } else {
      writeChildLedgerEntry({
        pid,
        projectId: meta.projectId,
        kind: meta.kind,
        startedAt: new Date().toISOString(),
        ...(meta.command !== undefined ? { command: meta.command } : {}),
      });
    }

    const untrack = (): void => {
      if (this.allChildren.get(key) === child) this.allChildren.delete(key);
      // 账本删除**不受** `allChildren` 守卫约束：shutdown/killAllSync 已 clear 时仍须清
      if (pid !== undefined) removeChildLedgerEntry(pid);
    };
    child.once("exit", untrack);
    child.once("error", untrack);
  }

  /**
   * 显式清账本（`shutdown()` / `killAllSync()` 专用）：这两条路径先 `allChildren.clear()`，
   * 之后 `untrack` 的 `allChildren.get(key) === child` 守卫失效、不再触发 ⇒ 必须在此按 pid 主动删。
   * 只删**本 Launcher 在册**的子进程，不动盘上其它（可能是无主孤儿的）条目。
   */
  private clearLedgerEntries(children: readonly ChildProcess[]): void {
    for (const child of children) {
      if (child.pid !== undefined) removeChildLedgerEntry(child.pid);
    }
  }

  /** 有效空闲回收时长（ms）：缺省 DEFAULT_IDLE_STOP_MS；`0`/负值表示禁用自动回收 */
  private effectiveIdleStopMs(): number {
    return this.config.launcher.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
  }

  /** 本机配置中的项目定义；不存在则抛 ProjectNotFoundError */
  getProject(projectId: string): ProjectConfig {
    const project = this.config.projects.find((p) => p.projectId === projectId);
    if (project === undefined) throw new ProjectNotFoundError(projectId);
    return project;
  }

  /**
   * 登记项目为不可用（§2.4-⑤，由 `launcher/index.ts` 在自检后逐项调用）。
   * 此后对该项目的 `ensure()` 直接抛 `AgentStartError`（用户可见「该项目不可用 + 原因」）；
   * 幂等：重复登记以最新原因覆盖。
   */
  markUnavailable(projectId: string, reason: string): void {
    this.unavailable.set(projectId, reason);
  }

  /**
   * 已登记不可用的项目 id 集（只读快照，v0.8.8 · M4：供 `/health` 的 `degraded` 段）。
   * 纯读、无副作用，可任意频次调用。
   */
  unavailableProjectIds(): string[] {
    return [...this.unavailable.keys()];
  }

  /** 配置 + 运行态拼接（内部聚合；入站 `GET /projects` 已于 v0.7.0 M5·MC1 退役） */
  listProjects(): ProjectStatus[] {
    return this.config.projects.map((project) => {
      const entry = this.running.get(project.projectId);
      if (entry !== undefined && !hasExited(entry.child)) {
        return {
          ...project,
          status: "online",
          endpoint: entry.endpoint,
          startedAt: entry.startedAt,
        };
      }
      if (entry !== undefined) {
        this.idle.clear(project.projectId);
        this.running.delete(project.projectId);
      }
      return {
        ...project,
        status: "offline",
        endpoint: null,
        startedAt: null,
      };
    });
  }

  /**
   * 幂等启动：已在运行直接复用；否则拉起包装器并等待 A2A 端口就绪。
   * 并发调用同一项目共享同一次启动。
   */
  async ensure(projectId: string): Promise<EnsureResult> {
    const project = this.getProject(projectId);

    // 自检判定不可用的项目：直接抛既有形态的 AgentStartError（§2.4-⑤），
    // 运行期 dispatch 会把该异常转成任务 failed（runner-exec.ts 既有路径）。
    const unavailableReason = this.unavailable.get(projectId);
    if (unavailableReason !== undefined) {
      throw new AgentStartError(projectId, `自检判定不可用：${unavailableReason}`);
    }

    const current = this.running.get(projectId);
    if (current !== undefined && !hasExited(current.child)) {
      // 复用命中：视为一次调用，续期空闲计时
      this.idle.noteActivity(projectId);
      return { projectId, endpoint: current.endpoint, started: false };
    }
    if (current !== undefined) {
      this.idle.clear(projectId);
      this.running.delete(projectId);
    }

    const inflight = this.pending.get(projectId);
    if (inflight !== undefined) return inflight;

    const task = this.start(project).finally(() => {
      this.pending.delete(projectId);
    });
    this.pending.set(projectId, task);
    return task;
  }

  private async start(project: ProjectConfig): Promise<EnsureResult> {
    if (this.shuttingDown) {
      throw new AgentStartError(project.projectId, "Launcher 正在退出，拒绝启动新 Agent");
    }
    // 风险档位 → 权限映射：缺省 write（= 三端包装器内置默认，v0.1.0 行为不变）
    const risk = project.risk ?? "write";
    const adapter = getAdapter(project.agentKind);
    const perm = adapter.permission(risk);

    // cwd 必须存在，否则 spawn 会以误导性的 cmd.exe ENOENT 失败
    if (!existsSync(project.workspace)) {
      throw new AgentStartError(project.projectId, `workspace 不存在：${project.workspace}`);
    }

    // 启动配置快照（每次拉起都打）：配置获取层级 + endpoint / 模型 id（配置面解析，观测用）。
    // v0.8.5 · M4：包装器配置产物（`agents/`）随段与配置通道退役 ⇒ 不再生成、无 configPath。
    const snapshot = describeAgentConfig(project);
    console.log(`[launcher] agent ${project.projectId} 配置层级：${snapshot.hierarchy}`);
    console.log(
      `[launcher] agent ${project.projectId} endpoint=${snapshot.endpoint}，model=${snapshot.model}`,
    );
    // 后端入口分层解析结果（改造文档 §2.3 · B4）：命中报来源层，失败报逐层清单；
    // 清单入日志、不进 Error message（适配器抛错文案只留摘要 +「详见 launcher.log [backend] 行」）。
    console.log(`[backend] ${snapshot.backend}`);

    const spec = adapter.buildLaunch({
      projectId: project.projectId,
      workspace: project.workspace,
      a2aPort: project.a2aPort,
      agentConfig: project.agentConfig,
      permissionArgs: perm.args,
    });

    let child: ChildProcess;
    try {
      child = spawnAgentProcess(spec, project.workspace);
    } catch (err) {
      throw new AgentStartError(project.projectId, errorMessage(err));
    }
    // spawn 返回即注册（先于 waitForPort / running.set），退出清理不再漏
    this.trackChild(`${project.projectId}:agent`, child, {
      projectId: project.projectId,
      kind: "wrapper",
      command: redactArgv([spec.command, ...spec.args]),
    });
    const endpoint = agentEndpoint(project.a2aPort);

    // 子进程输出不吞：stdout/stderr 逐行转发，便于诊断启动失败
    pipeChildOutput(child, `[agent:${project.projectId}]`);

    // 记录退出码/信号：用于 waitForPort 中止时给出结构化失败原因（如 wrapper EADDRINUSE 非零退出）
    const exitState: { code: number | null; signal: NodeJS.Signals | null } = {
      code: null,
      signal: null,
    };
    child.once("exit", (code, signal) => {
      exitState.code = code;
      exitState.signal = signal;
    });

    // spawn 失败（命令不存在/无法执行）会触发 error 事件；必须监听，否则未处理异常会杀死 Launcher
    const spawnState: { error: Error | null } = { error: null };
    child.on("error", (err: Error) => {
      spawnState.error = err;
      const entry = this.running.get(project.projectId);
      if (entry !== undefined && entry.child === child) {
        this.idle.clear(project.projectId);
        this.running.delete(project.projectId);
      }
      console.error(`[launcher] agent ${project.projectId} 进程错误：${errorMessage(err)}`);
    });

    // 意外退出时清理内存态（避免 online 假象）
    child.once("exit", (code, signal) => {
      const entry = this.running.get(project.projectId);
      if (entry !== undefined && entry.child === child) {
        this.idle.clear(project.projectId);
        this.running.delete(project.projectId);
      }
      console.log(
        `[launcher] agent ${project.projectId} 退出（code=${String(code)}, signal=${String(signal)}）`,
      );
    });

    try {
      await waitForPort(project.a2aPort, {
        timeoutMs: STARTUP_TIMEOUT_MS,
        shouldAbort: () => hasExited(child) || spawnState.error !== null,
      });
    } catch (err) {
      await terminateChild(child);
      // 早退快速失败：wrapper 因端口冲突等原因非零退出时，不等满 waitForPort 超时
      const reason =
        spawnState.error !== null
          ? errorMessage(spawnState.error)
          : hasExited(child)
            ? `包装器进程提前退出（code=${String(exitState.code)}, signal=${String(exitState.signal)}）`
            : errorMessage(err);
      throw new AgentStartError(project.projectId, reason);
    }

    // 退出中：清理后拒绝注册（避免 shutdown 已跑完却又登记出「僵尸在线」）
    if (this.shuttingDown) {
      await terminateChild(child);
      throw new AgentStartError(project.projectId, "Launcher 正在退出，已中止启动");
    }

    this.running.set(project.projectId, {
      projectId: project.projectId,
      child,
      endpoint,
      startedAt: new Date().toISOString(),
    });
    // 启动成功即开始空闲计时（用完退出；判据 = inflight==0 且静默 ≥ idleStopMs）
    this.idle.noteActivity(project.projectId);
    console.log(`[launcher] agent ${project.projectId} 已上线：${endpoint}`);
    return { projectId: project.projectId, endpoint, started: true };
  }

  /** 停止项目 Agent；未运行时返回 stopped=false */
  async stop(projectId: string): Promise<StopResult> {
    this.getProject(projectId);
    this.idle.clear(projectId);

    const entry = this.running.get(projectId);
    if (entry === undefined || hasExited(entry.child)) {
      this.running.delete(projectId);
      return { projectId, stopped: false };
    }

    this.running.delete(projectId);
    await terminateChild(entry.child);
    console.log(`[launcher] agent ${projectId} 已停止`);
    return { projectId, stopped: true };
  }

  /**
   * 停止所有 Agent（进程退出前调用）：遍历唯一注册表 allChildren。
   * `allChildren.clear()` 之前**显式清账本**（clear 后 untrack 守卫失效，不再自动清）。
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.idle.clearAll();
    this.running.clear();
    const children = [...this.allChildren.values()];
    this.clearLedgerEntries(children);
    this.allChildren.clear();
    await Promise.all(children.map((child) => terminateChild(child)));
  }

  /**
   * 同步兜底清理（process exit 事件中不可 await）：对 allChildren 逐个树杀。
   * 账本清理同为同步（`rmSync`），可在 exit 钩子内完成。
   */
  killAllSync(): void {
    this.shuttingDown = true;
    this.idle.clearAll();
    this.running.clear();
    const children = [...this.allChildren.values()];
    this.clearLedgerEntries(children);
    this.allChildren.clear();
    for (const child of children) killProcessTreeSync(child);
  }
}
