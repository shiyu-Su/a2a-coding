/**
 * 桥运行时生命周期编排（REQ-v0.4.1-2026-09-15-02，§2.5）。
 *
 * 职责：把「开 store → 抢 core 租约 → 起后台循环 → 就绪」与
 * 「停调度 → 排空在飞 → 关 store → 释放租约 → 清 pidfile」的**顺序**固化成一处，
 * 供 stdio / http 两个接入面共用（接线由后续节点负责，本模块不改 `bridge/index.ts`）。
 *
 * 两条硬规则：
 * 1. **只有 core 租约持有者（owner）启动 scheduler + task-watcher**；`follower` 不跑任何
 *    后台循环（记 warn + `role=follower`），只提供 MCP 工具面 —— 这是对付"多桥同抢一批节点"
 *    的第二道防线（第一道是 core 租约本身的原子建锁）。
 * 2. **`unref` 按模式**：stdio 维持现状（定时器 `unref`，不持有进程，桥随宿主退出）；
 *    常驻（http）**不得 `unref`**（否则进程会自行退出）。模式不硬编码进 scheduler/watcher。
 *
 * 排空调度（停机）：`scheduler.stop()` → 等待 scheduler 在飞派发 + task-watcher 在飞看护
 * 至宽限上限（`drainGraceMs`）→ 停 watcher → 关 store → 释放租约 → 删 pidfile。
 * 排空**只等待，不取消远端 A2A 任务**（避免丢工作）。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bridgeLog } from "../bridge/bridge-log.js";
import {
  drainTaskWatchers,
  setTaskWatcherEnabled,
  type WatcherDrainResult,
} from "../bridge/task-watcher.js";
import { close as closeSessionStore, getDefaultStore } from "../session/store.js";
import type { TransportMode } from "../types.js";
import {
  acquireCoreLease,
  releaseCoreLease,
  type CoreLeaseInfo,
  type CoreRole,
} from "./core-lease.js";

/**
 * stdio 模式是否对后台定时器 `unref()`：
 * **是**（不持有进程，桥随宿主退出）；常驻 http 模式 **否**（由连接持有进程）。
 */
export function unrefTimerForMode(mode: TransportMode): boolean {
  return mode === "stdio";
}

/** 停机排空宽限上限（ms，可配 `BRIDGE_DRAIN_GRACE_MS`，默认 30s） */
export function readDrainGraceMs(
  raw: string | undefined = process.env["BRIDGE_DRAIN_GRACE_MS"],
): number {
  const fallback = 30_000;
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * scheduler 的**最小句柄**（由 bridge 侧 `FeatureScheduler` 结构化满足）。
 * runtime 只依赖这 4 个动作，不反向耦合调度器实现细节。
 */
export interface LifecycleScheduler {
  start(options?: { unref?: boolean; role?: CoreRole }): void;
  stop(): void;
  recover(): unknown;
  drain(graceMs: number): Promise<boolean>;
}

/** task-watcher 子系统的**最小句柄**（由 bridge 侧 true 实现满足；测试可注入替身） */
export interface LifecycleWatcher {
  /** owner 门闩：false 时 `startTaskWatcher` 一律拒绝 */
  setEnabled(enabled: boolean): void;
  /** 排空在飞看护（只等待，不取消远端任务） */
  drain(graceMs: number): Promise<WatcherDrainResult>;
}

/** 默认真实 watcher 句柄（lifecycle 未显式注入时使用） */
export function createDefaultWatcher(): LifecycleWatcher {
  return {
    setEnabled: setTaskWatcherEnabled,
    drain: (graceMs: number): Promise<WatcherDrainResult> => drainTaskWatchers(graceMs),
  };
}

export interface BridgeRuntimeOptions {
  /** `orch/data`（core.lock 落点；须为**绝对路径**，常驻化不得 cwd 相对） */
  dataDir: string;
  /** 桥 transport 模式（决定 unref 与日志形态） */
  mode: TransportMode;
  /** 调度器句柄（由 bridge 装配后注入） */
  scheduler: LifecycleScheduler;
  /** watcher 句柄；缺省走 `task-watcher.ts` 真实现 */
  watcher?: LifecycleWatcher;
  /** 打开 / 初始化 store（缺省 `getDefaultStore()` 懒加载） */
  openStore?: () => void;
  /** 关闭 store（缺省 `store.close()`） */
  closeStore?: () => void;
  /** pidfile 路径；缺省 `<dataDir>/bridge.pid`，传 `null` 关闭（pidfile 不是锁，陈旧无害） */
  pidFile?: string | null;
  /** 停机排空宽限上限（ms）；缺省 `readDrainGraceMs()` */
  drainGraceMs?: number;
  /** 就绪回调（供 `/health` 报 `role` 等） */
  onReady?: (readiness: RuntimeReadiness) => void;
}

/** 就绪信息（`/health` 的数据源） */
export interface RuntimeReadiness {
  role: CoreRole;
  mode: TransportMode;
  pid: number;
  /** UTC ISO 8601 */
  startedAt: string;
  dataDir: string;
  lockPath: string;
  /** 持锁者信息（owner 为自身；follower 为他进程，null = 锁不可解析） */
  holder: CoreLeaseInfo | null;
  /** `scheduler.recover()` 摘要（仅 owner 执行；follower 为 null） */
  recovery: unknown;
}

/** 停机摘要 */
export interface RuntimeShutdownSummary {
  role: CoreRole;
  schedulerDrained: boolean;
  watcherDrained: boolean;
  leaseReleased: boolean;
  pidFileRemoved: boolean;
}

/** 默认 pidfile 路径（`<dataDir>/bridge.pid`） */
export function defaultPidFile(dataDir: string): string {
  return join(dataDir, "bridge.pid");
}

/**
 * 桥运行时：一次进程生命周期内的编排对象。
 * `start()` 幂等（重复调用返回同一就绪信息）；`stop()` 幂等。
 */
export class BridgeRuntime {
  private readonly options: BridgeRuntimeOptions;
  private readonly watcher: LifecycleWatcher;
  private readonly pidFilePath: string | null;
  private readonly drainGraceMs: number;
  private role: CoreRole = "follower";
  private readiness: RuntimeReadiness | null = null;
  private stopped = false;

  constructor(options: BridgeRuntimeOptions) {
    this.options = options;
    this.watcher = options.watcher ?? createDefaultWatcher();
    this.pidFilePath =
      options.pidFile === undefined ? defaultPidFile(options.dataDir) : options.pidFile;
    this.drainGraceMs = options.drainGraceMs ?? readDrainGraceMs();
  }

  /** 当前角色（未 `start()` 时恒为 `follower`） */
  get currentRole(): CoreRole {
    return this.role;
  }

  /**
   * 启动：开 store → **抢 core 租约** → （owner）启动 watcher → 启动 scheduler →
   * `scheduler.recover()` → 暴露就绪信息（含 `role`）。
   * follower 跳过启动 watcher/scheduler/recover，仅记 warn。
   */
  start(): RuntimeReadiness {
    if (this.readiness !== null) return this.readiness;
    const { dataDir, mode, scheduler } = this.options;
    mkdirSync(dataDir, { recursive: true });

    // 1) 开 store（迁移 / 懒加载）
    (this.options.openStore ?? ((): void => void getDefaultStore()))();

    // 2) 抢 core 租约（原子建锁 + pid 活性 + 陈旧清理）
    const lease = acquireCoreLease(dataDir, mode);
    this.role = lease.role;

    let recovery: unknown = null;
    if (lease.role === "owner") {
      // 3) 启动 watcher（owner 门闩打开，后续 startTaskWatcher 才受理）
      this.watcher.setEnabled(true);
      // 4) 启动 scheduler（unref 按模式；role 双保险门闩）
      scheduler.start({ unref: unrefTimerForMode(mode), role: "owner" });
      // 5) 重启恢复（写库收敛在飞节点；必须在就绪信号之前）
      recovery = scheduler.recover();
      this.writePidFile();
      bridgeLog.info("a2a-runtime", `core 租约已取得：role=owner（mode=${mode}）`, {
        pid: process.pid,
        lockPath: lease.lockPath,
      });
    } else {
      // follower：只提供工具面，不跑任何后台循环
      this.watcher.setEnabled(false);
      bridgeLog.warn(
        "a2a-runtime",
        `core 租约被他进程持有 → role=follower：不启动 scheduler / task-watcher`,
        { pid: process.pid, holderPid: lease.holder?.pid ?? null, lockPath: lease.lockPath },
      );
    }

    const readiness: RuntimeReadiness = {
      role: lease.role,
      mode,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      dataDir,
      lockPath: lease.lockPath,
      holder: lease.role === "owner" ? lease.info : lease.holder,
      recovery,
    };
    this.readiness = readiness;
    this.options.onReady?.(readiness);
    return readiness;
  }

  /**
   * 停机：停 scheduler → 排空在飞任务（宽限上限，**不取消**远端任务）→ 停 watcher →
   * 关 store → 释放租约 → 删 pidfile。幂等；follower 不触碰调度权与后台循环。
   */
  async stop(): Promise<RuntimeShutdownSummary> {
    const summary: RuntimeShutdownSummary = {
      role: this.role,
      schedulerDrained: true,
      watcherDrained: true,
      leaseReleased: false,
      pidFileRemoved: false,
    };
    if (this.stopped) return summary;
    this.stopped = true;

    if (this.role === "owner") {
      // 1) 停调度：不再派发新节点
      this.options.scheduler.stop();
      const deadline = Date.now() + this.drainGraceMs;
      // 2) 排空在飞派发 + 在飞看护（共享同一宽限预算）
      summary.schedulerDrained = await this.options.scheduler.drain(
        Math.max(0, deadline - Date.now()),
      );
      summary.watcherDrained = (
        await this.watcher.drain(Math.max(0, deadline - Date.now()))
      ).drained;
      // 3) 停 watcher（门闩关闭：不再受理新看护）
      this.watcher.setEnabled(false);
      // 4) 关 store
      this.closeStore();
      // 5) 释放租约（仅删自己持有的锁）
      summary.leaseReleased = releaseCoreLease(this.options.dataDir);
      // 6) 删 pidfile
      summary.pidFileRemoved = this.removePidFile();
    } else {
      this.closeStore();
    }
    return summary;
  }

  private closeStore(): void {
    try {
      (this.options.closeStore ?? closeSessionStore)();
    } catch (err) {
      bridgeLog.error("a2a-runtime", `关闭 store 失败：${toMessage(err)}`);
    }
  }

  private writePidFile(): void {
    if (this.pidFilePath === null) return;
    try {
      mkdirSync(dirname(this.pidFilePath), { recursive: true });
      writeFileSync(
        this.pidFilePath,
        `${JSON.stringify({
          pid: process.pid,
          mode: this.options.mode,
          role: this.role,
          startedAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
    } catch (err) {
      // pidfile 不是锁、陈旧无害：写失败不阻塞启动
      bridgeLog.warn("a2a-runtime", `写 pidfile 失败：${toMessage(err)}`);
    }
  }

  private removePidFile(): boolean {
    if (this.pidFilePath === null) return false;
    try {
      rmSync(this.pidFilePath, { force: true });
      return true;
    } catch (err) {
      bridgeLog.warn("a2a-runtime", `删 pidfile 失败：${toMessage(err)}`);
      return false;
    }
  }
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
