/**
 * 本机项目 Agent 生命周期管理（内存态）：
 * 按需幂等启动（ensure）、停止、状态聚合；不做服务发现（静态分布约束）。
 */
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { getAdapter } from "../adapters/index.js";
import type { LaunchSpec } from "../adapters/types.js";
import type {
  EnsureResult,
  MachineConfig,
  ProjectConfig,
  ProjectStatus,
  StopResult,
} from "../types.js";
import { writeAgentConfig } from "./agent-config.js";
import { appRootFromModule } from "./app-root.js";
import { describeAgentConfig } from "./config-snapshot.js";
import { allocateFreePort, waitForHttpOk, waitForPort } from "./ports.js";
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

/** opencode 项目的前置 `opencode serve` 进程及其后端基址 */
interface OpencodeBackend {
  child: ChildProcess;
  url: string;
}

interface RunningAgent {
  projectId: string;
  child: ChildProcess;
  /** opencode 项目的前置 `opencode serve`；其他 kind 恒为 null */
  serveChild: ChildProcess | null;
  endpoint: string;
  startedAt: string;
  /** 空闲回收定时器（用完退出）：null=未调度/已清除；已 unref，不阻塞进程退出 */
  idleTimer: NodeJS.Timeout | null;
}

/** A2A 端点约定：本机回环 + 项目 a2aPort */
export function agentEndpoint(a2aPort: number): string {
  return `http://127.0.0.1:${a2aPort}`;
}

export class AgentManager {
  private readonly config: MachineConfig;
  private readonly running = new Map<string, RunningAgent>();
  /** 进行中的 ensure（防并发重复拉起同一项目） */
  private readonly pending = new Map<string, Promise<EnsureResult>>();
  /**
   * 唯一子进程生命周期注册表（spawn 返回即注册）：
   * key 形如 `${projectId}:agent` / `${projectId}:serve`。这是退出清理的**唯一事实源**，
   * 覆盖 `running` 与「spawn→注册窗口」的 child（含后台 `opencode serve`）。
   */
  private readonly allChildren = new Map<string, ChildProcess>();
  /** 退出中标志：置位后 `start()` 拒绝拉起，`running.set` 前二次校验，防止僵死注册 */
  private shuttingDown = false;

  constructor(config: MachineConfig) {
    this.config = config;
  }

  /**
   * 登记子进程（spawn 返回后**立即**调用，早于 `waitForPort` / `running.set`）。
   * `exit`/`error` 时自动移除，保证「spawn→注册窗口」归零（退出清理不漏）。
   */
  private trackChild(key: string, child: ChildProcess): void {
    this.allChildren.set(key, child);
    const untrack = (): void => {
      if (this.allChildren.get(key) === child) this.allChildren.delete(key);
    };
    child.once("exit", untrack);
    child.once("error", untrack);
  }

  /** 有效空闲回收时长（ms）：缺省 DEFAULT_IDLE_STOP_MS；`0`/负值表示禁用自动回收 */
  private effectiveIdleStopMs(): number {
    return this.config.launcher.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
  }

  /** 清除条目的空闲计时（停止/退出/回收等条目移除路径） */
  private clearIdleTimer(entry: RunningAgent): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  /**
   * 重置项目空闲计时（用完退出）：
   * 在 start 成功与 ensure 复用命中时调用；超时无再次调用即自动 stop。
   * 有效值为 `0`/负值时禁用，空操作。
   */
  private resetIdleTimer(projectId: string): void {
    const idleMs = this.effectiveIdleStopMs();
    if (idleMs <= 0) return;
    const entry = this.running.get(projectId);
    if (entry === undefined) return;
    this.clearIdleTimer(entry);

    const timer = setTimeout(() => {
      // 条目已被替换或移除则跳过（正常路径已 clearTimeout，此处为双保险）
      if (this.running.get(projectId) !== entry) return;
      entry.idleTimer = null;
      console.log(
        `[launcher] agent ${projectId} 空闲超时（${idleMs}ms 无调用），自动回收（用完退出）`,
      );
      void this.stop(projectId).catch((err: unknown) => {
        console.error(`[launcher] agent ${projectId} 空闲回收失败：${errorMessage(err)}`);
      });
    }, idleMs);
    timer.unref();
    entry.idleTimer = timer;
  }

  /** 本机配置中的项目定义；不存在则抛 ProjectNotFoundError */
  getProject(projectId: string): ProjectConfig {
    const project = this.config.projects.find((p) => p.projectId === projectId);
    if (project === undefined) throw new ProjectNotFoundError(projectId);
    return project;
  }

  /** 配置 + 运行态拼接（GET /projects） */
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
        this.clearIdleTimer(entry);
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

    const current = this.running.get(projectId);
    if (current !== undefined && !hasExited(current.child)) {
      // 复用命中：视为一次调用，续期空闲计时
      this.resetIdleTimer(projectId);
      return { projectId, endpoint: current.endpoint, started: false };
    }
    if (current !== undefined) {
      this.clearIdleTimer(current);
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

    // 生成包装器配置（DEFAULT ← baseConfig ← agentConfig ← risk 配置补丁），经 --config 传给包装器；
    // 生成失败即终止启动，避免已拉起 serve 后才失败
    const appRoot = appRootFromModule(import.meta.url);
    let configPath: string;
    try {
      configPath = writeAgentConfig(project, appRoot, adapter.baseConfig(), perm.config);
    } catch (err) {
      throw new AgentStartError(project.projectId, `生成包装器配置失败：${errorMessage(err)}`);
    }

    // 启动配置快照（每次拉起都打）：配置获取层级 + endpoint / 模型 id（配置面解析，观测用）
    const snapshot = describeAgentConfig(project, configPath);
    console.log(`[launcher] agent ${project.projectId} 配置层级：${snapshot.hierarchy}`);
    console.log(
      `[launcher] agent ${project.projectId} endpoint=${snapshot.endpoint}，model=${snapshot.model}`,
    );

    // opencode 项目：先确保前置 `opencode serve`（cwd=workspace，本机空闲端口）
    let backend: OpencodeBackend | null = null;
    if (project.agentKind === "opencode") {
      backend = await this.startOpencodeServe(project);
    }

    const spec = adapter.buildLaunch({
      projectId: project.projectId,
      workspace: project.workspace,
      a2aPort: project.a2aPort,
      configPath,
      permissionArgs: perm.args,
      ...(backend !== null ? { backendUrl: backend.url } : {}),
    });

    let child: ChildProcess;
    try {
      child = spawnAgentProcess(spec, project.workspace);
    } catch (err) {
      if (backend !== null) await terminateChild(backend.child);
      throw new AgentStartError(project.projectId, errorMessage(err));
    }
    // spawn 返回即注册（先于 waitForPort / running.set），退出清理不再漏
    this.trackChild(`${project.projectId}:agent`, child);
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
        this.clearIdleTimer(entry);
        this.running.delete(project.projectId);
      }
      console.error(`[launcher] agent ${project.projectId} 进程错误：${errorMessage(err)}`);
    });

    // 意外退出时清理内存态（避免 online 假象），并回收其前置 serve（无包装器即无用途）
    child.once("exit", (code, signal) => {
      const entry = this.running.get(project.projectId);
      if (entry !== undefined && entry.child === child) {
        this.clearIdleTimer(entry);
        this.running.delete(project.projectId);
      }
      if (backend !== null) {
        void terminateChild(backend.child).catch((err: unknown) => {
          console.error(
            `[launcher] 回收 opencode serve ${project.projectId} 失败：${errorMessage(err)}`,
          );
        });
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
      if (backend !== null) await terminateChild(backend.child);
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
      if (backend !== null) await terminateChild(backend.child);
      throw new AgentStartError(project.projectId, "Launcher 正在退出，已中止启动");
    }

    this.running.set(project.projectId, {
      projectId: project.projectId,
      child,
      serveChild: backend !== null ? backend.child : null,
      endpoint,
      startedAt: new Date().toISOString(),
      idleTimer: null,
    });
    // 启动成功即开始空闲计时（用完退出）
    this.resetIdleTimer(project.projectId);
    console.log(`[launcher] agent ${project.projectId} 已上线：${endpoint}`);
    return { projectId: project.projectId, endpoint, started: true };
  }

  /**
   * 拉起 opencode 前置 serve：
   * 1. 本机分配空闲端口（与 a2aPort 独立，不占用 A2A 端口）；
   * 2. `opencode serve --port <p> --hostname 127.0.0.1`，cwd=workspace；
   * 3. 等待 `GET /global/health` 返回 200（复用启动超时 + 进程退出中止语义）。
   * 未就绪即终止 serve 并抛 AgentStartError，保证不泄漏半启动进程。
   */
  private async startOpencodeServe(project: ProjectConfig): Promise<OpencodeBackend> {
    let servePort: number;
    try {
      servePort = await allocateFreePort();
    } catch (err) {
      throw new AgentStartError(
        project.projectId,
        `无法分配 opencode serve 端口：${errorMessage(err)}`,
      );
    }

    const spec: LaunchSpec = {
      command: "opencode",
      args: ["serve", "--port", String(servePort), "--hostname", "127.0.0.1"],
    };
    const child = spawnAgentProcess(spec, project.workspace);
    // spawn 返回即注册（早于健康等待），退出清理覆盖半启动 serve
    this.trackChild(`${project.projectId}:serve`, child);
    pipeChildOutput(child, `[serve:${project.projectId}]`);

    const spawnState: { error: Error | null } = { error: null };
    child.on("error", (err: Error) => {
      spawnState.error = err;
      console.error(
        `[launcher] opencode serve ${project.projectId} 进程错误：${errorMessage(err)}`,
      );
    });

    const url = `http://127.0.0.1:${servePort}`;
    try {
      await waitForHttpOk(`${url}/global/health`, {
        timeoutMs: STARTUP_TIMEOUT_MS,
        shouldAbort: () => hasExited(child) || spawnState.error !== null,
      });
    } catch (err) {
      await terminateChild(child);
      const reason = spawnState.error !== null ? errorMessage(spawnState.error) : errorMessage(err);
      throw new AgentStartError(project.projectId, `opencode serve 未就绪：${reason}`);
    }

    console.log(`[launcher] opencode serve ${project.projectId} 已就绪：${url}`);
    return { child, url };
  }

  /** 停止项目 Agent 及其前置 serve；未运行时返回 stopped=false */
  async stop(projectId: string): Promise<StopResult> {
    this.getProject(projectId);

    const entry = this.running.get(projectId);
    if (entry === undefined || hasExited(entry.child)) {
      if (entry !== undefined) this.clearIdleTimer(entry);
      this.running.delete(projectId);
      if (entry !== undefined && entry.serveChild !== null) {
        await terminateChild(entry.serveChild);
      }
      return { projectId, stopped: false };
    }

    this.clearIdleTimer(entry);
    this.running.delete(projectId);
    await terminateChild(entry.child);
    if (entry.serveChild !== null) {
      await terminateChild(entry.serveChild);
    }
    console.log(`[launcher] agent ${projectId} 已停止`);
    return { projectId, stopped: true };
  }

  /** 停止所有 Agent 及其前置 serve（进程退出前调用）：遍历唯一注册表 allChildren */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const entry of this.running.values()) this.clearIdleTimer(entry);
    this.running.clear();
    const children = [...this.allChildren.values()];
    this.allChildren.clear();
    await Promise.all(children.map((child) => terminateChild(child)));
  }

  /** 同步兜底清理（process exit 事件中不可 await）：对 allChildren 逐个树杀 */
  killAllSync(): void {
    this.shuttingDown = true;
    for (const entry of this.running.values()) this.clearIdleTimer(entry);
    this.running.clear();
    const children = [...this.allChildren.values()];
    this.allChildren.clear();
    for (const child of children) killProcessTreeSync(child);
  }
}
