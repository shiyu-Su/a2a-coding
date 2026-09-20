/**
 * Runner 运行态落盘（v0.7.0 Phase C · 节点 M6·MC2）。
 *
 * 目的：Launcher 升格为 Runner 后，**出站运行态**需要一份本机可读的事实源，供
 * `machine/scripts/reaper.mjs` 判定「是否有活 Runner」，避免把活 Runner 拉起的
 * wrapper 当成孤儿误杀（reaper 判据重建）。
 *
 * 落盘：`<machine 单元根>/.a2a/runner-state.json`
 *   { machineId, pid, port, registeredAt, lastHeartbeatAt, lastPollAt,
 *     lastError, inflightCount, selfCheck, updatedAt }
 *
 * 写入语义：
 *   - **原子落盘**：先写同目录临时文件，再 `rename` 覆盖目标（读者永不见半截 JSON）；
 *   - **状态变更即时写**（`force`）：注册成功 / 心跳 / 命令 / 失败（`lastError` 变更）；
 *   - **每轮轮询节流写**（非 `force`）：`start` / `lastPollAt` / `updatedAt` / `inflightCount`
 *     每轮刷新，但受 {@link RUNNER_STATE_WRITE_THROTTLE_MS} 节流，避免空跑写放大。
 *
 * 新鲜度判据（与 `reaper.mjs` 同口径，**N 在两处各自钉死**，本项目约定各单元独立实现）：
 *   N = max(2 × POLL_TIMEOUT_MS, 90s)
 *   - `POLL_TIMEOUT_MS` = 长轮询客户端超时（`runner.ts` 的 `RUNNER_CONNECT_TIMEOUT_MS`）；
 *   - 下限 90s 为改造文档 `REQ-v0.7.0-2026-09-18-01` §2/§3.1 MC2 冻结值；
 *   - `now - max(lastHeartbeatAt, lastPollAt) < N` ⇒ 新鲜；
 *   - **时钟回拨**（时间戳落在未来，`now - t < 0`）⇒ **视为新鲜**（宁漏勿误杀）；
 *   - 两时间戳均缺失 / 非法 ⇒ **不新鲜**（不据此认定活 Runner，回落其它闸门）。
 *
 * fail-safe：本模块所有写盘失败只告警、**绝不抛出**（不得因状态落盘拖垮出站循环）。
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errorMessage } from "./process.js";
import type { SelfCheckFailure } from "./self-check.js";

/** 落盘文件名（与子进程账本同目录：`<machine 根>/.a2a/`） */
export const RUNNER_STATE_FILENAME = "runner-state.json";

/** 非强制写的最小间隔（ms）：每轮轮询节的「节流写」用；状态变更走 `force` 不受此限 */
export const RUNNER_STATE_WRITE_THROTTLE_MS = 1_000;

/**
 * 长轮询客户端超时（ms）：与 `runner.ts` 的 `RUNNER_CONNECT_TIMEOUT_MS` 对齐。
 * 本模块不 import `runner.ts`（避免循环依赖），故此处独立声明并由单测断言等值。
 */
export const RUNNER_POLL_TIMEOUT_MS = 30_000;

/** 新鲜度下限（ms）：改造文档冻结值（`N` 的第二参数） */
export const RUNNER_STATE_FRESH_FLOOR_MS = 90_000;

/** 计算新鲜度窗口 N：`max(2 × POLL_TIMEOUT_MS, 下限)` */
export function runnerStateFreshMs(pollTimeoutMs: number = RUNNER_POLL_TIMEOUT_MS): number {
  return Math.max(2 * pollTimeoutMs, RUNNER_STATE_FRESH_FLOOR_MS);
}

/** 当前缺省新鲜度窗口 N（= max(2×30s, 90s) = 90s） */
export const RUNNER_STATE_FRESH_MS = runnerStateFreshMs();

/** runner-state 内的自检结论（与注册载荷 `selfCheck` 同形） */
export interface RunnerStateSelfCheck {
  ok: boolean;
  failures: SelfCheckFailure[];
}

/** `runner-state.json` 的落盘形状（字段顺序 = 规范要求） */
export interface RunnerStateFile {
  machineId: string;
  pid: number;
  port: number;
  registeredAt: string | null;
  lastHeartbeatAt: string | null;
  lastPollAt: string | null;
  lastError: string | null;
  inflightCount: number;
  selfCheck: RunnerStateSelfCheck;
  /** 本文件最后写入时刻（UTC ISO 8601） */
  updatedAt: string;
}

/** 可注入日志口（结构化兼容 `RunnerLogger`，避免循环 import） */
export interface RunnerStateLogger {
  warn(message: string): void;
}

const defaultLogger: RunnerStateLogger = {
  warn: (message) => console.warn(message),
};

/**
 * 原子落盘：写 `<path>.tmp-*` → `rename` 覆盖目标。
 * 失败时清理临时文件并**抛出**（由 {@link RunnerStateWriter} 统一吞掉并告警）。
 */
export function writeRunnerStateAtomic(path: string, state: RunnerStateFile): void {
  const tmpPath = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // 临时文件清理失败：忽略（下一次写入会覆盖同名，不会污染目标文件）
    }
    throw err;
  }
}

export interface RunnerStateWriterOptions {
  /** 目标文件绝对路径（`<machine 根>/.a2a/runner-state.json`） */
  path: string;
  machineId: string;
  port: number;
  /** 自检结论（随注册载荷同源写入） */
  selfCheck: RunnerStateSelfCheck;
  /** 进程号；缺省 `process.pid`（单测可注入） */
  pid?: number;
  logger?: RunnerStateLogger;
  now?: () => Date;
  /** 非强制写的最小间隔（ms）；缺省 {@link RUNNER_STATE_WRITE_THROTTLE_MS} */
  throttleMs?: number;
}

/**
 * 带节流的 runner-state 写入器（`Runner` 持有一个）。
 *
 * `write(state, { force })`：
 *   - `force=true`：状态变更即时写，不受节流限制；
 *   - `force` 缺省：距上次成功写入 < `throttleMs` 则跳过（返回 `false`）。
 * 写盘异常只 `warn` 并返回 `false`，**绝不抛出**。
 */
export class RunnerStateWriter {
  private readonly path: string;
  private readonly machineId: string;
  private readonly port: number;
  private readonly selfCheck: RunnerStateSelfCheck;
  private readonly pid: number;
  private readonly logger: RunnerStateLogger;
  private readonly now: () => Date;
  private readonly throttleMs: number;
  /** 上次**成功**写入的毫秒时间；`-Infinity` = 尚未写过 */
  private lastWriteMs = Number.NEGATIVE_INFINITY;

  constructor(options: RunnerStateWriterOptions) {
    this.path = options.path;
    this.machineId = options.machineId;
    this.port = options.port;
    this.selfCheck = options.selfCheck;
    this.pid = options.pid ?? process.pid;
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? (() => new Date());
    this.throttleMs = options.throttleMs ?? RUNNER_STATE_WRITE_THROTTLE_MS;
  }

  /**
   * 组装落盘快照并写盘。
   * 传入的是**可变运行态**（`Runner.state` 的字段子集 + 在飞数），本方法只做投影。
   */
  write(
    snapshot: {
      registeredAt: string | null;
      lastHeartbeatAt: string | null;
      lastPollAt: string | null;
      lastError: string | null;
      inflightCount: number;
    },
    options: { force?: boolean } = {},
  ): boolean {
    const nowDate = this.now();
    const nowMs = nowDate.getTime();
    if (options.force !== true && nowMs - this.lastWriteMs < this.throttleMs) return false;

    const state: RunnerStateFile = {
      machineId: this.machineId,
      pid: this.pid,
      port: this.port,
      registeredAt: snapshot.registeredAt,
      lastHeartbeatAt: snapshot.lastHeartbeatAt,
      lastPollAt: snapshot.lastPollAt,
      lastError: snapshot.lastError,
      inflightCount: snapshot.inflightCount,
      selfCheck: this.selfCheck,
      updatedAt: nowDate.toISOString(),
    };
    try {
      writeRunnerStateAtomic(this.path, state);
      this.lastWriteMs = nowMs;
      return true;
    } catch (err) {
      this.logger.warn(`[runner] runner-state 落盘失败（不影响运行）：${errorMessage(err)}`);
      return false;
    }
  }
}
