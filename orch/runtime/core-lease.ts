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
 * K3 补充（v0.7.2 REQ-01 ③，见 {@link reclaimWedgeCoreLease}）：pid 活性无法区分
 * 「活着且在为」与「活着但已 wedge」——优雅停机若被未收尾的连接挂住，进程**留在原地**
 * （端口已释放、`core.lock` 未释放），新实例只判 pid ⇒ 永远降级 follower，直到人工删锁。
 * 故本模块补一层**注入式服务探针**（`probeHttpHealth` 为推荐实现），把这种僵死活锁判为陈旧并回收。
 *
 * **探针必须在「本进程绑定 HTTP 端口之前」执行**：`orch/bridge/index.ts` 的启动顺序是
 * 「先 listen 端口，后抢租约」，一旦本进程已绑定，配置端点上的 `/health` 响应者就是**自身**
 * 而非 holder ⇒ 探针失去意义（自证）。故 {@link reclaimWedgeCoreLease} 由启动流程在
 * `startHttpTransport()` 之前调用（见 `bridge/index.ts` `startHttpBridge`）。
 *
 * 边界：租约**不是** pidfile，也**不做**服务发现 / 注册 / 心跳；仅本机互斥。
 * `reclaimWedgeCoreLease` **不改**锁文件格式、**不改** `isProcessAlive`、**不改** follower 语义。
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
import { request as httpRequest, type ClientRequest } from "node:http";
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
    const startedAt = rec["startedAt"];
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      // stdio 已退役（恒常驻 http）：mode 仅诊断用，历史锁文件中的其它值一律归一为 "http"
      mode: "http",
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

// ---------------------------------------------------------------------------
// K3（v0.7.2 REQ-01 ③）：僵死租约回收 —— 「pid 存活但不在服务」探针
// ---------------------------------------------------------------------------

/** 探针判定（三值）：`unknown` 一律按「活」保守处理（不接管） */
export type HolderServiceVerdict = "serving" | "not-serving" | "unknown";

/**
 * holder「是否仍在服务」探针（注入式，便于单测确定性地覆盖四态）。
 * 返回三值；**抛错 / 超时一律折叠为 `unknown`**（保守视为活，绝不因探针故障误接管）。
 */
export type HolderServiceProbe = (
  holder: CoreLeaseInfo,
) => Promise<HolderServiceVerdict> | HolderServiceVerdict;

/** 探针目标端点 */
export interface HealthEndpoint {
  host: string;
  /** 端口（必须指向真实监听端口；`0` 对探针无意义） */
  port: number;
}

/** 探针独立短超时缺省（ms）——不依赖（可能已 wedge 的）MCP listener 的响应时限 */
export const LEASE_PROBE_TIMEOUT_MS = 300;

/** HTTP 响应体上限（防御性：异常 / 超大响应体不拖住探针） */
const HEALTH_BODY_MAX_CHARS = 4_096;

/** `ECONNREFUSED` = 「端点无人监听」这一**确定性否定**；其余网络错误不构成否定 */
function isConnectionRefused(err: unknown): boolean {
  return errnoOf(err) === "ECONNREFUSED";
}

/** 桥 `/health` 形状（`{ status, role, version }`）⇒ serving；不可解析 ⇒ unknown */
function verdictFromHealthBody(body: string): HolderServiceVerdict {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return "unknown";
    const role = (parsed as Record<string, unknown>)["role"];
    return typeof role === "string" ? "serving" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * HTTP `GET /health` 探针（K3 推荐实现；**零第三方依赖**）。
 *
 * 判定（保守优先）：
 * - 连接被拒（`ECONNREFUSED`）⇒ `not-serving`（端点无人监听 = 文档化 wedge 特征：端口已释放）；
 * - 返回可解析的桥 `/health` 形状（含字符串 `role`）⇒ `serving`；
 * - **超时 / 其它网络错误 / 不可解析响应 ⇒ `unknown`**（保守视为活 ⇒ 不接管）。
 *
 * 超时为**独立短超时**（socket timeout + 自带硬 timer，二者先到者为断），不依赖服务端响应时限。
 * **严格自清理**：任一分支结束都清 timer + `req.destroy()`（不留未释放句柄，测试可自然退出）。
 */
export function probeHttpHealth(
  endpoint: HealthEndpoint,
  timeoutMs: number = LEASE_PROBE_TIMEOUT_MS,
): Promise<HolderServiceVerdict> {
  return new Promise<HolderServiceVerdict>((resolve) => {
    let settled = false;
    const finish = (verdict: HolderServiceVerdict): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(verdict);
    };
    const req: ClientRequest = httpRequest(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: "/health",
        method: "GET",
        // 一次性探测：不复用连接池（避免 keep-alive 句柄滞留、拖住被测 server 收尾）
        agent: false,
        headers: { connection: "close" },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > HEALTH_BODY_MAX_CHARS) finish("unknown");
        });
        res.on("end", () => finish(verdictFromHealthBody(body)));
        res.on("error", () => finish("unknown"));
      },
    );
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => finish("unknown"), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    req.on("error", (err) => finish(isConnectionRefused(err) ? "not-serving" : "unknown"));
    req.on("timeout", () => finish("unknown"));
    req.end();
  });
}

export interface ReclaimWedgeLeaseOptions {
  /** 探针独立短超时（ms）；缺省 {@link LEASE_PROBE_TIMEOUT_MS} */
  probeTimeoutMs?: number;
}

/** 跑注入探针，把「同步抛 / 异步拒绝 / 超时」统一折叠为 `unknown`（保守视为活） */
async function runHolderProbe(
  probe: HolderServiceProbe,
  holder: CoreLeaseInfo,
  timeoutMs: number,
): Promise<HolderServiceVerdict> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<HolderServiceVerdict>((resolve) => {
      timer = setTimeout(() => resolve("unknown"), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    const call = Promise.resolve()
      .then(() => probe(holder))
      .then(
        (verdict): HolderServiceVerdict => verdict,
        (): HolderServiceVerdict => "unknown",
      );
    return await Promise.race([call, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * K3：回收「pid 存活但不在服务」的僵死 core 租约（v0.7.2 REQ-01 ③，§2.2-K3 四态判据）。
 *
 * 四态：
 * - **① 无锁 / 锁不可解析 / holder pid 已死** ⇒ **不处理**（返回 false，交给 `acquireCoreLease`
 *   既有的陈旧清理路径）；
 * - **② holder pid 活 + 探针确认不在服务** ⇒ 删除该锁（返回 true）—— 免人工删锁的关键路径，
 *   调用方随后 `acquireCoreLease` 即可竞争 owner；
 * - **③ holder pid 活 + 探针 `unknown`（失败 / 超时 / 抛错）** ⇒ **保守视为活、不接管**（返回 false）
 *   —— 宁可维持现状阻塞，不可误杀 ⇒ 双 owner / 双调度；
 * - **④ 判定期间锁易主**（re-read `holder.pid` 变化 / 锁消失）⇒ **不删不接管**（返回 false）。
 *
 * 探针自带**独立短超时**（`options.probeTimeoutMs`）：探针 hang 不拖住本函数。
 * 仅当 re-read 后锁仍指向同一 pid 才 `unlink`（防竞态误删新持锁者）。
 * **不改**锁文件格式 / `isProcessAlive` / follower 语义。
 */
export async function reclaimWedgeCoreLease(
  dataDir: string,
  probe: HolderServiceProbe,
  options: ReclaimWedgeLeaseOptions = {},
): Promise<boolean> {
  const lockPath = coreLockPath(dataDir);
  const holder = readLockFile(lockPath);
  if (holder === null) return false; // ① 无锁 / 不可解析
  if (!isProcessAlive(holder.pid)) return false; // ① pid 已死（交 acquireCoreLease 清理）

  const verdict = await runHolderProbe(
    probe,
    holder,
    options.probeTimeoutMs ?? LEASE_PROBE_TIMEOUT_MS,
  );
  if (verdict !== "not-serving") return false; // ③ 保守：serving / unknown 一律不接管

  const again = readLockFile(lockPath);
  if (again === null || again.pid !== holder.pid) return false; // ④ 锁易主 / 已消失
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if (errnoOf(err) !== "ENOENT") return false;
  }
  return true; // ②
}
