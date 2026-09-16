/**
 * core 调度权租约（REQ-v0.4.1-2026-09-15-02，§2.4）。
 *
 * 为什么存在：多个桥进程共用同一份 `sessions.sqlite` 时，若各自都跑 scheduler/watcher，
 * 会出现「同一节点被两个执行者同时派发」「onSettled 重复触发」「状态读-改-写丢更新」等竞态
 * （2026-09-15 真机复现：3 个桥同抢一份 DAG）。core 租约是**第二道防线**：
 * 同一 `dataDir` 下**至多一个**进程持有调度权（`owner`），其余一律降级为 `follower`
 * （照常提供 MCP 工具面、读写同一库，但**不跑后台循环**）。
 *
 * 机制（**零第三方依赖**，仅 Node 内置）：
 * 1. **原子建锁**：`fs.openSync(path, "wx")` —— 仅当文件不存在时创建成功，失败即 EEXIST 竞态；
 * 2. 锁内容 `{ pid, mode, startedAt }`（`mode` 为桥 transport 模式，仅诊断用）；
 * 3. **pid 活性**：`process.kill(pid, 0)` —— 死进程（ESRCH）→ 判为**陈旧锁**，清掉后重试一次；
 *    活进程（含 EPERM：存在但无权限发信号，保守视为存活）→ 当前进程为 `follower`。
 *
 * 已知残留风险（Windows）：pid 会被系统复用。若持锁进程已退出且其 pid 恰被新进程占用，
 * `process.kill(pid, 0)` 仍成功 → 旧锁被判为"活锁"，新 core 会退化为 follower，直到该
 * 锁文件被人工/pidfile 流程清理。此为**可用性降级**（不双调度，安全方向正确），
 * 故本版不引入心跳/TTL 规避（与"无中心注册 / 反 TTL"立场一致）。
 *
 * 边界：租约**不是** pidfile，也**不做**服务发现 / 注册 / 心跳；仅本机互斥。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { TransportMode } from "../types.js";

/** 调度权角色：`owner` 持锁跑后台循环；`follower` 只提供工具面 */
export type CoreRole = "owner" | "follower";

/** 锁文件名（落在 `dataDir` 下，即 `orch/data/core.lock`） */
export const CORE_LOCK_FILENAME = "core.lock";

/** 锁文件内容（诊断用：谁在何时以何模式持锁） */
export interface CoreLeaseInfo {
  pid: number;
  mode: TransportMode;
  /** UTC ISO 8601 */
  startedAt: string;
}

/**
 * 抢锁结果：
 * - `owner`：本进程持锁，应启动 scheduler + watcher；
 * - `follower`：他进程持锁（或二次竞态失败），**不得**启动后台循环。
 */
export type CoreLeaseResult =
  | { role: "owner"; lockPath: string; info: CoreLeaseInfo }
  | { role: "follower"; lockPath: string; holder: CoreLeaseInfo | null };

/** 抢锁路径（`<dataDir>/core.lock`） */
export function coreLockPath(dataDir: string): string {
  return join(dataDir, CORE_LOCK_FILENAME);
}

/** 本进程通过 `acquireCoreLease` 取得的锁路径（未持有时为 null，供无参 release 用） */
let heldLockPath: string | null = null;

function errnoOf(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/**
 * pid 活性判定。
 * - 非正整数 / 非整数 → 视为**死**（陈旧）；
 * - `ESRCH` → 死；`EPERM` → 活（进程存在但无权限发信号）；
 * - 其余错误 → 保守视为**活**（宁可误判活锁、降级为 follower，也不误清活锁造成双调度）。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = errnoOf(err);
    if (code === "ESRCH") return false;
    return true;
  }
}

/** 读指定锁文件；缺失 / 形状不合法 / JSON 损坏 → null */
function readLockFile(lockPath: string): CoreLeaseInfo | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    const pid = rec["pid"];
    const mode = rec["mode"];
    const startedAt = rec["startedAt"];
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      mode: mode === "stdio" || mode === "http" ? mode : "stdio",
      startedAt: typeof startedAt === "string" ? startedAt : "",
    };
  } catch {
    return null;
  }
}

/** 读 `dataDir` 下的 core 锁内容；无锁 / 不可解析 → null */
export function readCoreLease(dataDir: string): CoreLeaseInfo | null {
  return readLockFile(coreLockPath(dataDir));
}

/** 原子建锁（`wx`）：成功 true；已存在 false；其他 IO 错误抛出（调用方降级为 follower） */
function tryCreateLock(lockPath: string, info: CoreLeaseInfo): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if (errnoOf(err) === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, `${JSON.stringify(info)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * 抢 core 租约。
 *
 * 流程：确保 `dataDir` 存在 → 原子建锁；
 * - 成功 → `{ role: "owner" }`；
 * - 已存在 → 读 pid 判活性：**活** → `{ role: "follower" }`；**死 / 不可解析** →
 *   清陈旧锁并**重试一次**；二次仍失败（他进程抢先）→ `{ role: "follower" }`。
 *
 * 不抛未捕获异常：IO 异常（如只读目录）一律降级为 `follower`，绝不误取调度权。
 */
export function acquireCoreLease(dataDir: string, mode: TransportMode): CoreLeaseResult {
  const lockPath = coreLockPath(dataDir);
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    return { role: "follower", lockPath, holder: null };
  }
  const info: CoreLeaseInfo = {
    pid: process.pid,
    mode,
    startedAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (tryCreateLock(lockPath, info)) {
        heldLockPath = lockPath;
        return { role: "owner", lockPath, info };
      }
    } catch {
      return { role: "follower", lockPath, holder: readLockFile(lockPath) };
    }
    const holder = readLockFile(lockPath);
    if (holder !== null && isProcessAlive(holder.pid)) {
      return { role: "follower", lockPath, holder };
    }
    // 陈旧锁（pid 已死 / 内容损坏 / 空文件）：清理后重试一次
    try {
      unlinkSync(lockPath);
    } catch (err) {
      if (errnoOf(err) !== "ENOENT") {
        return { role: "follower", lockPath, holder };
      }
    }
  }
  return { role: "follower", lockPath, holder: readLockFile(lockPath) };
}

/**
 * 释放 core 租约（删除锁文件）。
 *
 * - 无参调用：释放本进程经 `acquireCoreLease` 取得的锁（未持有 → false，幂等）；
 * - 传 `dataDir`：释放该目录的锁（供停机流程显式指定）。
 *
 * **只删自己持有的锁**：锁内 pid 非本进程时拒绝（防 follower 误删 owner 的活锁）。
 * 返回是否真的删除。
 */
export function releaseCoreLease(dataDir?: string): boolean {
  const lockPath = dataDir === undefined ? heldLockPath : coreLockPath(dataDir);
  if (lockPath === null) return false;
  if (!existsSync(lockPath)) return false; // 无锁可删（幂等）
  const holder = readLockFile(lockPath);
  if (holder !== null && holder.pid !== process.pid) return false;
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if (errnoOf(err) !== "ENOENT") return false;
  }
  if (heldLockPath === lockPath) heldLockPath = null;
  return true;
}
