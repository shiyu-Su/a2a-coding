/**
 * 启动补结算（REQ-v0.8.7-2026-09-22-01 · 节点 M6，台账链第二段）。
 *
 * **病根**：Launcher 被硬杀时，`.a2a/inflight/` 里留下的在飞任务（M5 落盘）随进程消亡
 * —— 桥侧看不到事实，只能等 30 min 墙钟判死。本机在冷启动那一刻**知道自己死过**，
 * 应把「已无执行体」的在飞任务立即结为 `failed` 上报。
 *
 * **判据（纯函数 {@link planInflightReconcile}）**：读 `.a2a/inflight/*` **减去** 本机
 * 子女账本（`.a2a/children/<pid>.json`）**在册且存活** pid 所属项目 ⇒ 该项目仍有执行体
 * （wrapper 子进程还活着，任务可能真在跑）⇒ 跳过（宁漏勿误杀）；其余 ⇒ 本机已无执行体
 * ⇒ 孤儿。自检条目（`SELF_CHECK_LEDGER_PREFIX`）一律排除（M5 台账本就不落盘自检条目，
 * 此处为防御性二次过滤）。
 *
 * **上报复用 `outbox.deliver()`**：造 `state='failed'` **新结果**入 pending（落盘 / Bearer /
 * 退避 / ack 零新代码），原因走 `text`；**不落 claimToken**（凭证随进程消亡是物理事实，
 * 桥侧窄口 A2 允许「无 token 且 failed」，契约 ④ 行级绑定兜安全）。
 * **⚠ 这不违反「boot 不补发」** —— 那条是**不回放既有 outbox 文件**，此处是造新结果。
 *
 * **字段口径**：`contextId` 置空串 —— M5 在飞台账（`InFlightEntry`）不落 contextId，
 * 桥侧 `handleResult` 按 `(machineId, taskId)` 定位、逐键白名单读取（改造文档 §2.8 待决 D
 * 「宽容」口径），空串仅为满足结果 schema 必填字段。
 *
 * **清理语义**：`deliver()` 成功（本地原子落盘即算）⇒ 删对应 inflight 条目（事实已消费）；
 * 之后若 ack 前再崩，该 failed 件滞留 `.a2a/outbox`（boot 不回放）⇒ 由 orch 墙钟兜底，
 * 属 §2.7 分工（machine 管「本机知道死过」，orch 管「看不到事实的最终兜底」）。
 *
 * **fail-safe**：本模块所有读 / 删 / deliver 失败只告警、**绝不抛出**、绝不阻断启动
 * （deliver 失败的条目**保留文件**，下次启动重试）。
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { childLedgerDir } from "./manager.js";
import { errorMessage } from "./process.js";
import { isPidAlive } from "./reconcile.js";
import type { RunnerOutbox, RunnerTaskResult } from "./runner-exec.js";
import { SELF_CHECK_LEDGER_PREFIX } from "./self-check.js";

/** inflight 目录名（相对 machine 单元根：`<machine 根>/.a2a/inflight`，与 M5 落盘一致） */
export const INFLIGHT_DIRNAME = "inflight";

/** inflight 条目文件名约定：`<taskId>.json`（M5 `atomicWriteJson` 落盘形状 = `InFlightEntry`） */
const INFLIGHT_FILE_RE = /^(.+)\.json$/;

/** 子女账本文件名约定（与 `reconcile.ts` 一致）：`<pid>.json` */
const CHILD_LEDGER_FILE_RE = /^(\d+)\.json$/;

/** 补结算失败原因文本前缀（桥侧契约 ⑤ 要求 `text` 非空；原因走 text，判据与处置留 orch） */
export const INFLIGHT_RECONCILE_FAILURE_TEXT =
  "启动补结算：上一进程遗留的在飞任务在本机已无执行体（子女账本无该项目存活 pid），按 failed 结账";

/** 可注入日志口（结构化兼容既有 logger） */
export interface InflightReconcileLogger {
  info?(message: string): void;
  warn(message: string): void;
}

/** inflight 台账落盘条目（判定输入，不含 I/O 副作用；形状 = M5 持久化的 `InFlightEntry` 子集） */
export interface InflightRecord {
  taskId: string;
  projectId: string;
  startedAt: string;
}

/** 跳过原因（观测 / 单测断言用） */
export type InflightSkipReason = "self-check" | "executor-alive";

/** 补结算计划（纯数据，由 {@link planInflightReconcile} 产出） */
export interface InflightReconcilePlan {
  /** 本机已无执行体的在飞任务 ⇒ 造 `failed` 结果入 outbox */
  orphans: InflightRecord[];
  /** 跳过：`self-check`（自检前缀，假故障源）/ `executor-alive`（子女账本在册存活，宁漏勿误杀） */
  skipped: { record: InflightRecord; reason: InflightSkipReason }[];
}

/**
 * **纯判定**：inflight 条目 → `{ orphans, skipped }`。
 *
 * 判定顺序：① 自检前缀 ⇒ 跳过（永不进补结算清单）；② 条目 projectId 命中「仍有存活执行体」
 * 的项目集 ⇒ 跳过（wrapper 可能真在跑，误报 = 假 failed）；③ 其余 ⇒ 孤儿。
 */
export function planInflightReconcile(
  records: readonly InflightRecord[],
  opts: {
    /** 子女账本中**存活** pid 所属的 projectId 集合（本机仍有执行体的项目） */
    liveExecutorProjectIds: ReadonlySet<string>;
  },
): InflightReconcilePlan {
  const plan: InflightReconcilePlan = { orphans: [], skipped: [] };
  for (const record of records) {
    if (record.taskId.startsWith(SELF_CHECK_LEDGER_PREFIX)) {
      plan.skipped.push({ record, reason: "self-check" });
      continue;
    }
    if (opts.liveExecutorProjectIds.has(record.projectId)) {
      plan.skipped.push({ record, reason: "executor-alive" });
      continue;
    }
    plan.orphans.push(record);
  }
  return plan;
}

/** 取 `unknown` 错误的 `code`（避免 `any`；与 `reconcile.ts` 同口径） */
function errnoCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * 读 inflight 目录。目录不存在（从未有过在飞）**不算异常**；单条目损坏 ⇒ 跳过并告警
 * （宁漏勿误杀 —— 读不出 projectId 就无从判定，留给 orch 墙钟）。
 * 自检前缀文件名在读取层即排除（NTFS 上冒号文件名本就不可达，此为口径防御）。
 */
function readInflightRecords(dir: string, logger: InflightReconcileLogger): InflightRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return [];
    logger.warn(`[launcher] 读在飞台账目录失败（跳过启动补结算）：${errorMessage(err)}`);
    return [];
  }

  const records: InflightRecord[] = [];
  for (const name of names) {
    const match = INFLIGHT_FILE_RE.exec(name);
    const taskId = match?.[1];
    if (taskId === undefined || taskId.startsWith(SELF_CHECK_LEDGER_PREFIX)) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) throw new Error("条目不是对象");
      const obj = parsed as Record<string, unknown>;
      const projectId = readString(obj, "projectId");
      if (projectId === undefined) throw new Error("缺 projectId");
      records.push({
        taskId,
        projectId,
        startedAt: readString(obj, "startedAt") ?? "",
      });
    } catch (err) {
      logger.warn(`[launcher] 在飞台账条目 ${name} 无法解析（跳过）：${errorMessage(err)}`);
    }
  }
  return records;
}

/** 读子女账本目录，收集**存活** pid 所属 projectId（解析失败的存活条目只告警，不计入） */
function readLiveExecutorProjectIds(
  dir: string,
  isAlive: (pid: number) => boolean,
  logger: InflightReconcileLogger,
): Set<string> {
  const live = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") {
      logger.warn(`[launcher] 读子女账本目录失败（按无存活执行体处理）：${errorMessage(err)}`);
    }
    return live;
  }
  for (const name of names) {
    const pidText = CHILD_LEDGER_FILE_RE.exec(name)?.[1];
    if (pidText === undefined) continue;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !isAlive(pid)) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) continue;
      const projectId = readString(parsed as Record<string, unknown>, "projectId");
      if (projectId !== undefined) live.add(projectId);
    } catch (err) {
      logger.warn(
        `[launcher] 子女账本条目 ${name}（pid=${pidText} 存活）无法解析（不计入在册）：${errorMessage(err)}`,
      );
    }
  }
  return live;
}

/** 补结算结果（fail-safe：任何一步失败只置 `degraded`，不抛出） */
export interface InflightReconcileSummary {
  /** 已造 failed 结果入 outbox 的孤儿数 */
  reported: number;
  /** 跳过的条目数（自检前缀 / 仍有存活执行体） */
  skipped: number;
  /** deliver 失败数（条目保留，下次启动重试） */
  failed: number;
  /** 是否降级（读目录 / 落盘失败）——仅影响日志，不阻断启动 */
  degraded: boolean;
}

export interface InflightReconcileOptions {
  /** inflight 目录绝对路径（`<machine 根>/.a2a/inflight`） */
  inflightDir: string;
  /** 本机 machineId（上报体身份字段，桥侧契约 ③④ 校验） */
  machineId: string;
  /** 结果回传出口（生产 = 与 Runner 同一个 `FileOutbox` 实例，循环随 Runner 启动） */
  outbox: RunnerOutbox;
  /** 子女账本目录；缺省 {@link childLedgerDir}（单测注入） */
  childrenDir?: string;
  /** pid 存活判定；缺省 {@link isPidAlive}（单测注入，不启服务） */
  isAlive?: (pid: number) => boolean;
  /** 结果 `finishedAt` 时间源；缺省当前时间 */
  now?: () => Date;
  logger?: InflightReconcileLogger;
}

/**
 * 启动补结算入口（`onListening` 内、`reconcileStartupLedger` **之后**、自检 ensure **之前**
 * 调用 —— 对账刚更新子女账本；自检新拉起的子进程会掩盖孤儿，故必须在前）。
 * 永不抛出。
 */
export async function reconcileInflightOnStartup(
  options: InflightReconcileOptions,
): Promise<InflightReconcileSummary> {
  const logger = options.logger ?? { warn: (m) => console.warn(m) };
  const isAlive = options.isAlive ?? isPidAlive;
  const now = options.now ?? (() => new Date());
  const summary: InflightReconcileSummary = { reported: 0, skipped: 0, failed: 0, degraded: false };

  const records = readInflightRecords(options.inflightDir, logger);
  const liveProjects = readLiveExecutorProjectIds(
    options.childrenDir ?? childLedgerDir(),
    isAlive,
    logger,
  );
  const plan = planInflightReconcile(records, { liveExecutorProjectIds: liveProjects });
  summary.skipped = plan.skipped.length;

  for (const record of plan.orphans) {
    const result: RunnerTaskResult = {
      taskId: record.taskId,
      machineId: options.machineId,
      projectId: record.projectId,
      contextId: "",
      state: "failed",
      text: `${INFLIGHT_RECONCILE_FAILURE_TEXT}（startedAt=${record.startedAt || "未知"}）`,
      artifacts: [],
      finishedAt: now().toISOString(),
    };
    try {
      // 无 credential 上报：claimToken 不落盘（A2 窄口 + 桥侧契约 ④ 行级绑定兜安全）
      await options.outbox.deliver(result);
      rmSync(join(options.inflightDir, `${record.taskId}.json`), { force: true });
      summary.reported += 1;
    } catch (err) {
      summary.failed += 1;
      summary.degraded = true;
      logger.warn(
        `[launcher] 启动补结算上报失败 taskId=${record.taskId}（保留台账条目，下次启动重试）：${errorMessage(err)}`,
      );
    }
  }

  const byReason = plan.skipped.reduce<Record<InflightSkipReason, number>>(
    (acc, item) => {
      acc[item.reason] += 1;
      return acc;
    },
    { "self-check": 0, "executor-alive": 0 },
  );
  if (records.length > 0 || summary.reported > 0) {
    logger.info?.(
      `[launcher] 启动补结算：上报 failed ${summary.reported} 个（候选孤儿 ${plan.orphans.length}）` +
        `、跳过 ${summary.skipped} 个（执行体在册 ${byReason["executor-alive"]} / 自检 ${byReason["self-check"]}）` +
        (summary.degraded ? `；已降级（${summary.failed} 个保留待重试，不阻断启动）` : ""),
    );
  }
  return summary;
}
