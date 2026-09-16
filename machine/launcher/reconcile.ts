/**
 * 启动对账清理（REQ-v0.4.1-2026-09-15-03 §2.7）。
 *
 * **病根**：Launcher 被硬杀（`taskkill /F` / `kill -9`）时走不到 `shutdown()`，其拉起的
 * wrapper / `opencode serve` 成为孤儿并占住项目的 `a2aPort` ⇒ 下次启动的**启动自检**
 * `ensure` 撞 `EADDRINUSE` ⇒ fail-fast `exit(1)` ⇒ **服务根本起不来**。
 *
 * **做法**：在 `onListening` 内（`pruneStaleAgentConfigs` 之后、`runStartupSelfCheck` 之前）
 * 读 M1 的子进程账本 `<machine 根>/.a2a/children/<pid>.json`：
 *   - pid 存活 且 超过宽限期 且 **不在本 Launcher 在册集合** ⇒ **孤儿** ⇒ 组杀 + 删条目；
 *   - pid 已不存活 ⇒ **陈旧条目** ⇒ 只删条目（不杀）；
 *   - 其余跳过（在册 / 宽限期内 / 存活但条目时间不可判）—— 宁漏勿误杀。
 *
 * **红线（活 Launcher 在册禁清 / 无主孤儿可清）**：对账在 `listen` 成功之后执行，端口即
 * 单实例互斥锁（`EADDRINUSE` 的第二实例在自检前就退出了）⇒ 本机此刻只有本 Launcher
 * ⇒ 除「在册集合」外的条目一律**无主**，可清。
 *
 * **fail-safe**：所有读 / 杀 / 删均包 `try/catch`，本模块**绝不抛出**、绝不 `exit`，只记日志。
 * 调用方另有兜底 `try/catch`（见 `index.ts`），确保对账永不阻断启动。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { childLedgerDir, removeChildLedgerEntry } from "./manager.js";
import { errorMessage, killProcessTree } from "./process.js";

/**
 * 宽限期（ms）：跳过「近期创建」的账本条目，防与**正在进行的拉起**竞态。
 * 判定基准为条目的 `startedAt`（写入时刻与 spawn 时刻同源，≈ 文件 mtime）。
 * 取值刻意保守：多漏一个孤儿只是留到下次启动（或 `reaper.mjs`）再清；
 * 误杀一个活着的子进程不可逆。
 */
export const RECONCILE_GRACE_MS = 30_000;

/** M1 账本文件名约定：`<pid>.json` */
const LEDGER_FILE_RE = /^(\d+)\.json$/;

/** 账本文件条目（纯判定函数的输入，不含 I/O 副作用） */
export interface LedgerFileEntry {
  /** 文件名（`<pid>.json`） */
  file: string;
  /** pid（取自文件名，与 M1 写入一致） */
  pid: number;
  /** 条目 `startedAt` 解析结果（ms）；缺失 / 非法 = `undefined`（⇒ 宁漏勿误杀） */
  startedAtMs: number | undefined;
}

/** 跳过原因（观测 / 单测断言用） */
export type SkipReason = "registered" | "grace" | "undatable";

/** 对账计划（纯数据，由 {@link planLedgerReconcile} 产出） */
export interface ReconcilePlan {
  /** 孤儿：pid 存活 + 超宽限 + 无主 ⇒ 组杀 + 删条目 */
  orphans: LedgerFileEntry[];
  /** 陈旧：pid 已不存活 ⇒ 只删条目（不杀） */
  stale: LedgerFileEntry[];
  /** 跳过：`registered`（红线）/ `grace`（宽限期内）/ `undatable`（存活但时间不可判） */
  skipped: { entry: LedgerFileEntry; reason: SkipReason }[];
}

/** 对账结果（fail-safe：任何一步失败只置 `degraded`，不抛出） */
export interface ReconcileSummary {
  /** 实际杀掉的孤儿数 */
  orphansKilled: number;
  /** 实际删除的陈旧条目数 */
  staleRemoved: number;
  /** 跳过的条目数（在册 / 宽限期内 / 时间不可判） */
  skipped: number;
  /** 是否降级（读目录 / 杀进程失败）——仅影响日志，不阻断启动 */
  degraded: boolean;
}

/** 取 `unknown` 错误的 `code`（避免 `any`） */
function errnoCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}

/**
 * 进程存活判定：`ESRCH` = 不存在；`EPERM` = 存在但无权限（视为存活）。
 * 与 `scripts/launcherctl.mjs` 的 `isPidAlive` 同口径。
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === "EPERM";
  }
}

/**
 * **纯判定**：账本条目 → `{ orphans, stale, skipped }`。
 *
 * 判定顺序（红线优先）：① 在册 ⇒ 跳过；② pid 不存活 ⇒ 陈旧；③ 存活但条目时间不可判 ⇒ 跳过
 * （宁漏勿误杀）；④ 宽限期内（含时钟回拨导致的"未来时间"）⇒ 跳过；⑤ 其余 ⇒ 孤儿。
 *
 * `isAlive` 由调用方注入，便于**不启服务**地单测（生产传 {@link isPidAlive}）。
 */
export function planLedgerReconcile(
  entries: readonly LedgerFileEntry[],
  opts: {
    /** 红线：本 Launcher 在册的 pid（启动对账时 = 自身） */
    registeredPids: ReadonlySet<number>;
    /** 判定基准时间（ms） */
    nowMs: number;
    isAlive: (pid: number) => boolean;
    /** 宽限期（ms），缺省 {@link RECONCILE_GRACE_MS} */
    graceMs?: number;
  },
): ReconcilePlan {
  const graceMs = opts.graceMs ?? RECONCILE_GRACE_MS;
  const plan: ReconcilePlan = { orphans: [], stale: [], skipped: [] };

  for (const entry of entries) {
    // ① 红线：在册禁清（优先于一切）
    if (opts.registeredPids.has(entry.pid)) {
      plan.skipped.push({ entry, reason: "registered" });
      continue;
    }
    // ② pid 已不存活 ⇒ 陈旧条目（只删条目）
    if (!opts.isAlive(entry.pid)) {
      plan.stale.push(entry);
      continue;
    }
    // ③ 存活但无法判定条目时间 ⇒ 宁漏勿误杀
    if (entry.startedAtMs === undefined) {
      plan.skipped.push({ entry, reason: "undatable" });
      continue;
    }
    // ④ 宽限期内的新条目（`nowMs - startedAtMs < graceMs` 兼容未来时间）⇒ 跳过
    if (opts.nowMs - entry.startedAtMs < graceMs) {
      plan.skipped.push({ entry, reason: "grace" });
      continue;
    }
    // ⑤ 存活 + 超宽限 + 无主 ⇒ 孤儿
    plan.orphans.push(entry);
  }

  return plan;
}

/** 解析条目 `startedAt`（UTC ISO 8601）为 ms；缺失 / 非法 ⇒ `undefined` */
function readStartedAtMs(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = (raw as { startedAt?: unknown }).startedAt;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * 读账本目录并解析条目。目录不存在（尚未写过账本）**不算异常**。
 * 非 `<pid>.json` 命名的文件一律忽略（不动未知文件）；JSON 损坏 ⇒ `startedAtMs = undefined`。
 */
function readLedgerEntries(): { entries: LedgerFileEntry[]; degraded: boolean } {
  let names: string[];
  try {
    names = readdirSync(childLedgerDir());
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return { entries: [], degraded: false };
    console.error(`[launcher] 读子进程账本目录失败（跳过对账清理）：${errorMessage(err)}`);
    return { entries: [], degraded: true };
  }

  const entries: LedgerFileEntry[] = [];
  for (const name of names) {
    const match = LEDGER_FILE_RE.exec(name);
    const pidText = match?.[1];
    if (pidText === undefined) continue;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;

    let startedAtMs: number | undefined;
    try {
      startedAtMs = readStartedAtMs(
        JSON.parse(readFileSync(join(childLedgerDir(), name), "utf8")) as unknown,
      );
    } catch (err) {
      startedAtMs = undefined;
      console.error(`[launcher] 账本条目 ${name} 无法解析（按"时间不可判"处理）：${errorMessage(err)}`);
    }
    entries.push({ file: name, pid, startedAtMs });
  }
  return { entries, degraded: false };
}

/**
 * 组杀孤儿进程：
 * - win32：复用 `process.ts` 的 `killProcessTree`（`taskkill /pid <p> /T /F` 树杀）；
 * - POSIX：先 `kill(-pid)` **进程组**杀（覆盖 M4 引入的 `detached` 子进程组；组不存在时
 *   回落单进程 `SIGKILL`）。
 */
async function killOrphan(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await killProcessTree(pid);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    await killProcessTree(pid);
  }
}

/**
 * 启动对账清理入口（`onListening` 内、`pruneStaleAgentConfigs` 之后、自检之前调用）。
 * 永不抛出；结果以「对账清理 N 个孤儿」日志 + {@link ReconcileSummary} 双通道回传。
 */
export async function reconcileStartupLedger(): Promise<ReconcileSummary> {
  const read = readLedgerEntries();

  // 红线：在册禁清。启动对账时尚未 `ensure` 任何项目，在册集合只有**自身**；
  // 且本进程已持有端口（唯一实例）⇒ 其余条目均为无主孤儿。
  const plan = planLedgerReconcile(read.entries, {
    registeredPids: new Set([process.pid]),
    nowMs: Date.now(),
    isAlive: isPidAlive,
  });

  let degraded = read.degraded;
  let orphansKilled = 0;
  let staleRemoved = 0;

  for (const entry of plan.orphans) {
    try {
      await killOrphan(entry.pid);
      // 杀成功才删条目；失败则**保留**条目（下次启动 / reaper 重试，避免丢失孤儿记录）
      removeChildLedgerEntry(entry.pid);
      orphansKilled += 1;
    } catch (err) {
      degraded = true;
      console.error(
        `[launcher] 对账清理孤儿失败 pid=${entry.pid}（保留账本条目）：${errorMessage(err)}`,
      );
    }
  }

  for (const entry of plan.stale) {
    removeChildLedgerEntry(entry.pid);
    staleRemoved += 1;
  }

  const skippedByReason = plan.skipped.reduce<Record<SkipReason, number>>(
    (acc, item) => {
      acc[item.reason] += 1;
      return acc;
    },
    { registered: 0, grace: 0, undatable: 0 },
  );
  const orphanPids = plan.orphans.map((entry) => entry.pid).join(",");
  console.log(
    `[launcher] 对账清理 ${orphansKilled} 个孤儿（候选 ${plan.orphans.length}${orphanPids.length > 0 ? `：pid=${orphanPids}` : ""}）` +
      `、删陈旧账本条目 ${staleRemoved} 个（候选 ${plan.stale.length}）` +
      `、跳过 ${plan.skipped.length} 个（在册 ${skippedByReason.registered} / 宽限 ${skippedByReason.grace} / 不可判 ${skippedByReason.undatable}）` +
      (degraded ? "；已降级（见上文日志，不阻断启动）" : ""),
  );

  return { orphansKilled, staleRemoved, skipped: plan.skipped.length, degraded };
}
