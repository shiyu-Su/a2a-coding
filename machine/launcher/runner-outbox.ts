/**
 * Runner 结果回传 outbox（v0.7.0 Phase B · 节点 M4·MB2）。
 *
 * 连接模型反转为 pull 后，命令结果不再经入站回调回传，而是由 Runner **主动出站**投递：
 *
 *   任务终态 → **先落盘** `<machine 根>/.a2a/outbox/<taskId>.json`（durable）
 *     → `POST {bridge.url}/runner/result`（Bearer；body = 结果 + 领取 token）
 *       → 桥 200 ack（`{ ack: true }`）⇒ **删文件**；否则保留并退避重试。
 *
 * 语义要点（与改造文档 §2「machine 侧」/ REQ-v0.7.0-2026-09-18-01 对齐）：
 * - **落盘优先**：`deliver()` 只做「原子落盘 + 登记内存待投 + 唤醒循环」，网络投递在后台循环做；
 *   断网 / 桥挂 / 超时都不丢结果（文件在，进程内重放）。
 * - **退避重试重放**：失败按 `computeBackoffDelayMs`（1s→2s→…cap 30s ±20% jitter）重试，
 *   同 `taskId` 幂等 —— 重复投递由桥侧 `(machineId, taskId)` upsert 兜底，本侧只保证「一份/ taskId」。
 * - **ack 即清**：仅 HTTP 2xx 视为 ack，删 outbox 文件；非 2xx / 传输错误一律保留下轮重放。
 * - **boot 不补发**（**Out of Scope**，改造文档 §3.2.3 登记）：`start()` **不扫盘、不回放**
 *   既有 outbox 文件；内存待投集合 `pending` 初始为空 ⇒ 只有本次进程生命周期内 `deliver` 的结果
 *   才被投递。跨重启的补发不在本版范围。
 * - **outbox GC = 天然自清**：每个 `taskId` 至多一份文件（同键覆盖写）；ack 后删除；
 *   **不做历史层 / 归档**。
 *
 * 出口收敛：本模块与 `runner.ts` 同属 machine 侧出站 HTTP 出口族（唯一出口原则），
 * 全部经可注入 `FetchLike`，便于单测审计。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BridgeConfig } from "../types.js";
import { errorMessage } from "./process.js";
import {
  RunnerHttpError,
  computeBackoffDelayMs,
  type FetchLike,
  type RunnerLogger,
} from "./runner.js";
import type {
  RunnerOutbox,
  RunnerResultCredential,
  RunnerTaskResult,
} from "./runner-exec.js";

/** outbox 目录名（相对 machine 单元根：`<machine 根>/.a2a/outbox`） */
export const OUTBOX_DIRNAME = "outbox";

/** 结果回传端点路径（桥侧，与 orch/bridge/runner.ts 的 `RUNNER_RESULT_PATH` 同值） */
export const RUNNER_RESULT_PATH = "/runner/result";

/** 结果回传单请求超时（ms）：控制面短请求，不应拖满长轮询预算 */
export const OUTBOX_POST_TIMEOUT_MS = 15_000;

const defaultLogger: RunnerLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/** 缺省可中断 sleep：`stop()` / abort 时立即 resolve，保证退出有界 */
function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref();
    if (signal?.aborted === true) {
      finish();
      return;
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** 原子写 JSON：写同目录临时文件 → `rename` 覆盖（读者永不见半截 JSON），失败即抛出 */
function atomicWriteJson(path: string, value: unknown): void {
  const tmpPath = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // 临时文件清理失败：忽略（同名覆盖不会污染目标文件）
    }
    throw err;
  }
}

export interface FileOutboxOptions {
  /** outbox 目录绝对路径（`<machine 根>/.a2a/outbox`） */
  dir: string;
  /** 桥配置（url + per-machine Bearer token） */
  bridge: BridgeConfig;
  /** 出站 HTTP 出口（缺省全局 `fetch`；单测注入 fake） */
  fetch?: FetchLike;
  logger?: RunnerLogger;
  now?: () => Date;
  random?: () => number;
  /** 退避等待（可注入；缺省真实定时器） */
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

/** 单轮 flush 观测：`attempted` = 本轮实际发起的投递数，`acked` = 收到 ack 并清空者 */
export interface OutboxFlushReport {
  attempted: number;
  acked: number;
}

/**
 * 文件 outbox：结果先落盘，再经后台循环投递 + 退避重试，ack 后删文件。
 *
 * 内存态 `pending` 是「本进程内待 ack 的 taskId 集合」（**不扫盘** ⇒ boot 不补发）；
 * 磁盘文件是 durable 事实源。二者以 `taskId` 对齐，天然「一份 / taskId」。
 */
export class FileOutbox implements RunnerOutbox {
  private readonly dir: string;
  private readonly bridge: BridgeConfig;
  private readonly fetchFn: FetchLike;
  private readonly logger: RunnerLogger;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly sleepFn: (ms: number, signal: AbortSignal | undefined) => Promise<void>;

  /** 本进程待 ack 条目（taskId → 投递凭证）；初始为空 = 不补发 boot 前的既有文件 */
  private readonly pending = new Map<string, RunnerResultCredential | undefined>();
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private stopped = true;
  private failures = 0;
  private ackedCount = 0;
  private lastError: string | null = null;

  constructor(options: FileOutboxOptions) {
    this.dir = options.dir;
    this.bridge = options.bridge;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.sleepFn = options.sleep ?? defaultSleep;
  }

  /** 本进程待 ack 条目数（观测 / 单测） */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 本进程已 ack 条目数（观测 / 单测） */
  get deliveredCount(): number {
    return this.ackedCount;
  }

  /** 最近一次投递失败原因（成功 / 未发生为 null） */
  get lastErrorText(): string | null {
    return this.lastError;
  }

  /**
   * 投递一条结果：**先原子落盘**，再登记内存待投并唤醒后台循环。
   * 同 `taskId` 重复投递覆盖同一文件 / 同一 pending 键 ⇒ 仅持 1 份，天然幂等。
   * 落盘失败即抛出（由调用方记录；不静默丢结果）。
   */
  deliver(result: RunnerTaskResult, credential?: RunnerResultCredential): void {
    atomicWriteJson(this.entryPath(result.taskId), result);
    this.pending.set(result.taskId, credential);
    this.wakeLoop();
  }

  /** 启动后台投递循环（幂等；`stop()` 可终止）。**不扫盘** ⇒ boot 不补发。 */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.abortController = new AbortController();
    this.loopPromise = this.loop().catch((err: unknown) => {
      this.logger.error(`[runner] outbox 循环异常退出：${errorMessage(err)}`);
    });
  }

  /** 停止后台循环（幂等）：中止在飞请求与退避等待，保证退出有界 */
  stop(): void {
    this.stopped = true;
    this.abortController?.abort();
    this.abortController = null;
    this.wakeLoop();
  }

  /** 等待循环结束（单测 / 关停编排用） */
  whenStopped(): Promise<void> {
    return this.loopPromise ?? Promise.resolve();
  }

  /**
   * 单轮投递：对 `pending` 中每条结果各发起一次 `POST /runner/result`。
   * 成功（HTTP 2xx）⇒ 删文件 + 移出 pending；失败 ⇒ 保留，交循环退避重试。
   * 公开以便单测确定性驱动（不依赖真实定时器）。
   */
  async flushOnce(): Promise<OutboxFlushReport> {
    let attempted = 0;
    let acked = 0;
    for (const [taskId, credential] of [...this.pending]) {
      const result = this.readEntry(taskId);
      if (result === null) {
        this.pending.delete(taskId);
        continue;
      }
      attempted += 1;
      try {
        await this.postResult(result, credential);
        this.removeEntry(taskId);
        this.pending.delete(taskId);
        acked += 1;
        this.ackedCount += 1;
        this.failures = 0;
        this.lastError = null;
        this.logger.info(`[runner] outbox 回传成功（ack）：taskId=${taskId} state=${result.state}`);
      } catch (err) {
        this.failures += 1;
        this.lastError = errorMessage(err);
        this.logger.warn(
          `[runner] outbox 回传失败（将退避重试）：taskId=${taskId} ${this.lastError}`,
        );
      }
    }
    return { attempted, acked };
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.pending.size > 0) {
        await this.flushOnce();
        if (this.stopped) return;
        if (this.pending.size > 0) {
          const delay = computeBackoffDelayMs(Math.max(0, this.failures - 1), this.random);
          await this.sleepFn(delay, this.abortController?.signal);
          continue;
        }
      }
      // 无待投：休眠至下一次 deliver / stop（不空转）
      await this.waitForWake();
    }
  }

  /** 休眠至 `deliver()` / `stop()` 唤醒（无定时器；abort 亦唤醒） */
  private waitForWake(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const signal = this.abortController?.signal;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.wake = null;
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      this.wake = finish;
      if (signal?.aborted === true) {
        finish();
        return;
      }
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  private wakeLoop(): void {
    this.wake?.();
  }

  private entryPath(taskId: string): string {
    return join(this.dir, `${taskId}.json`);
  }

  /** 从磁盘读取结果（durable 事实源）；损坏 / 缺失 ⇒ 丢弃该条目并告警，不阻塞其余 */
  private readEntry(taskId: string): RunnerTaskResult | null {
    const path = this.entryPath(taskId);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) throw new Error("outbox 文件不是对象");
      return parsed as RunnerTaskResult;
    } catch (err) {
      this.logger.warn(`[runner] outbox 读取失败，丢弃条目：taskId=${taskId} ${errorMessage(err)}`);
      this.removeEntry(taskId);
      return null;
    }
  }

  private removeEntry(taskId: string): void {
    try {
      rmSync(this.entryPath(taskId), { force: true });
    } catch (err) {
      this.logger.warn(`[runner] outbox 删除失败：taskId=${taskId} ${errorMessage(err)}`);
    }
  }

  /** `POST /runner/result`：body = 结果 + （有则）claim_token；仅 2xx 视为 ack */
  private async postResult(
    result: RunnerTaskResult,
    credential: RunnerResultCredential | undefined,
  ): Promise<void> {
    const body: Record<string, unknown> = { ...result };
    if (credential !== undefined && credential.claimToken.length > 0) {
      body["claimToken"] = credential.claimToken;
    }
    const signal = this.abortController?.signal;
    const timeoutSignal = AbortSignal.timeout(OUTBOX_POST_TIMEOUT_MS);
    const combined =
      signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, signal]);
    const res = await this.fetchFn(
      `${trimTrailingSlash(this.bridge.url)}${RUNNER_RESULT_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${this.bridge.token}`,
        },
        body: JSON.stringify(body),
        signal: combined,
      },
    );
    // 排空响应体（连接复用）；读失败不影响 ack 判定
    await res.text().catch(() => "");
    if (!res.ok) {
      throw new RunnerHttpError(res.status, `http_${res.status}`, `结果回传失败：HTTP ${res.status}`);
    }
  }
}

/** 由 machine 单元根下的 outbox 目录 + 桥配置创建文件 outbox */
export function createFileOutbox(options: FileOutboxOptions): FileOutbox {
  return new FileOutbox(options);
}

/** 计算 outbox 目录绝对路径（`<machine 根>/.a2a/outbox`），供 launcher 入口复用 */
export function outboxDirOf(machineRoot: string): string {
  return join(machineRoot, ".a2a", OUTBOX_DIRNAME);
}
