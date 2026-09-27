/**
 * Agent View 页的数据面（REQ-2026-09-26-02 · B-T3，改造文档 §2-T3）—— **只读**：
 * 机器表（`/api/projects` 的 `runners` ∪ `machines`）+ 在飞任务（**逐 project 并发** `GET /api/tasks`）
 * + 3300 收编的桥 identity/version 页头（`GET <mcpBaseUrl>/health`）。
 *
 * 硬口径（冻结边界六条）：
 * - **零写面**：本文件不含任何状态推进工具名 / 写封装（纪律钉 = `test/agents-page.test.mjs`）；
 * - **零新增存储、不缓存**：每次渲染现查（项目快照 + 逐项目任务 + 桥 health），板不落任何中间账；
 * - **单项目失败不炸页**：查询失败 / 超时 ⇒ 该项目 `ok=false`（视图层灰化），其余项目照常呈现；
 * - **不做 /api 契约假设**：`claimedAt` 与 health 各键一律缺键容错为 `null`（老桥 / 未投影 ⇒ 页上如实
 *   显示「—」，不臆造缺省值）；
 * - **identity/version 的唯一承载位**：3300 页面退役后桥身份只在本页页头呈现（G3 收编）；
 * - **orch 看不见的两件事不呈现、不推算**：machine 闸内排队与读席占用 ⇒ 不编造并发数，
 *   页脚口径行如实标注（常量见 `derive.AGENT_VIEW_CALIBRATION_NOTE`）。
 */
import type { BridgeClient, ProjectTaskItem, ProjectsView } from "./bridge-client.js";
import { ORG_QUERY_TIMEOUT_MS } from "./orgs-view.js";

/** 逐项目 / health 查询的单项超时（复用 N6 口径：一页并发查 N 项，宁可早降级不可拖垮整页）。 */
export const AGENT_QUERY_TIMEOUT_MS = ORG_QUERY_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// 在飞判据（闭集反面：终态之外即在飞）
// ---------------------------------------------------------------------------

/**
 * 任务侧**终态**闭集（值域照桥 `state`；`blocked` = 良性终态、冻结未跑，不算在飞）。
 * 取「终态闭集」而非「在飞闭集」：桥的 state 值域非封闭（新增中间态时**默认算在飞**，
 * 漏算比误算更危险 —— 漏算会让在飞任务在运维页上静默消失）。
 */
export const TERMINAL_TASK_STATES: readonly string[] = [
  "completed",
  "failed",
  "canceled",
  "cancelled",
  "rejected",
  "blocked",
];

/** 该 state 是否算「在飞」（终态闭集之外 ⇒ true；空 / 缺失 ⇒ false，无从判断不占位）。 */
export function isInflightTaskState(state: string | null): boolean {
  if (state === null || state === "") return false;
  return !TERMINAL_TASK_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// 逐 project 在飞任务查询（照 orgs-view：并发 + 单项超时 + 失败收口）
// ---------------------------------------------------------------------------

/** 单项目任务查询结果（fetcher 出口）。`ok=false` = 不可达（失败 / 超时），在飞集未知。 */
export type AgentTasksOutcome =
  | { ok: true; tasks: ProjectTaskItem[] }
  | { ok: false; code: string; error: string };

/** 逐项目查询注入面（单测喂假桥；缺省 = 经板侧只读桥客户端真查）。 */
export type AgentTasksFetcher = (projectId: string) => Promise<AgentTasksOutcome>;

/**
 * 以板侧只读桥客户端构造逐项目查询器：`GET /api/tasks?project=…`（**不加 state / limit 过滤** ——
 * 在飞筛选在板侧纯函数里做，桥的服务端过滤值域不由板假设）。
 * 单次超时 {@link AGENT_QUERY_TIMEOUT_MS}；失败 / 超时一律收口为 `ok=false`，不外抛（不炸页）。
 */
export function createAgentTasksFetcher(
  client: Pick<BridgeClient, "getTasks">,
  timeoutMs: number = AGENT_QUERY_TIMEOUT_MS,
): AgentTasksFetcher {
  return async (projectId: string): Promise<AgentTasksOutcome> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("tasks_timeout")), timeoutMs);
      });
      const view = await Promise.race([client.getTasks(projectId), timeout]);
      return { ok: true, tasks: view.tasks };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: message === "tasks_timeout" ? "tasks_timeout" : "tasks_query_failed",
        error: message,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// 机器表（runners ∪ machines）
// ---------------------------------------------------------------------------

/**
 * 机器表的一行 = 一台机器的**归并结论**（`runners[]` 给在线态与心跳，`machines[]` 给项目数与机器 error）。
 * 两源按 `machineId` 归并：只在一源出现 ⇒ 另一源字段如实缺席（`online = null` / `projectCount = 0`），
 * **不臆造**（「runner 没登记」≠「离线」、「快照里没有项目」≠「机器不可达」）。
 */
export interface AgentMachineRow {
  machineId: string;
  /** runner 上报的在线态；`null` = 该机器无 runner 登记 ⇒ 未知（不判离线）。 */
  online: boolean | null;
  lastHeartbeatAt: string | null;
  /** 该项目快照里挂在这台机器上的项目数；无机器条目 ⇒ 0（如实，不代表不可达）。 */
  projectCount: number;
  /** 机器级 error（`machines[].error`）；无条目或无错 ⇒ null。 */
  machineError: string | null;
}

/** 项目快照 → 机器表行（纯函数；`machineId` 字典序，与组织页同排序口径）。 */
export function buildMachineRows(view: ProjectsView): AgentMachineRow[] {
  const byMachine = new Map<string, AgentMachineRow>();
  const row = (machineId: string): AgentMachineRow => {
    const existing = byMachine.get(machineId);
    if (existing !== undefined) return existing;
    const created: AgentMachineRow = { machineId, online: null, lastHeartbeatAt: null, projectCount: 0, machineError: null };
    byMachine.set(machineId, created);
    return created;
  };
  for (const m of view.machines) {
    const target = row(m.machineId);
    target.projectCount = m.projects.length;
    target.machineError = m.error;
  }
  for (const r of view.runners) {
    const target = row(r.machineId);
    target.online = r.online;
    target.lastHeartbeatAt = r.lastHeartbeatAt;
  }
  return [...byMachine.values()].sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
}

// ---------------------------------------------------------------------------
// 在飞任务区（逐项目小节 + claimedAt 排序）
// ---------------------------------------------------------------------------

/** 一个项目在在飞区里的一节（项目身份来自 `/api/projects`，任务来自逐项目查询）。 */
export interface AgentInflightProject {
  machineId: string;
  projectId: string;
  agentKind: string | null;
  /** 机器不可达时携带的机器级 error（项目行本身不含 error 键）；无 ⇒ null。 */
  machineError: string | null;
  outcome: AgentTasksOutcome;
  /** 在飞任务（`outcome.ok` 时已按 {@link isInflightTaskState} 筛过；查询失败 ⇒ 空数组）。 */
  inflight: ProjectTaskItem[];
}

export interface AgentInflightModel {
  projects: AgentInflightProject[];
  /** 任务查询失败（灰化）的项目数。 */
  grayedCount: number;
  /** 全页在飞任务总数（灰化项目的贡献未知，不计入 —— 页上须同时显示灰化数）。 */
  inflightTotal: number;
}

/** projectId → 任务查询结论（fetcher 出口表）；缺项按查询失败收口（不臆造「没有在飞」）。 */
export type AgentTasksByProject = ReadonlyMap<string, AgentTasksOutcome>;

/**
 * 在飞任务的稳定排序：`claimedAt` **升序**（最早领取 = 跑得最久的在前，运维上最需要看见）；
 * 无 `claimedAt`（当前桥 `/api/tasks` 投影未带出该键、或任务尚未领取）⇒ 沉底，
 * 沉底行之间保持入参序（不做二次抖动排序键，避免同刻刷新行跳位）。
 */
export function sortByClaimedAt(tasks: readonly ProjectTaskItem[]): ProjectTaskItem[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      const ka = a.task.claimedAt;
      const kb = b.task.claimedAt;
      if (ka === null && kb === null) return a.index - b.index;
      if (ka === null) return 1;
      if (kb === null) return -1;
      if (ka === kb) return a.index - b.index;
      return ka < kb ? -1 : 1;
    })
    .map((e) => e.task);
}

/**
 * 项目快照 + 逐项目任务结论 → 在飞区（纯函数）：
 * 逐项目一节（一机多项目 ⇒ 每项目各自一节，与 `machines[].projects[]` 同序）；
 * 缺结论（查询器未装配 / 表里没这一项）⇒ 按 `agent_query_missing` 失败收口，**不算「没有在飞」**。
 */
export function buildInflightModel(view: ProjectsView, tasks: AgentTasksByProject): AgentInflightModel {
  const projects: AgentInflightProject[] = [];
  let grayedCount = 0;
  let inflightTotal = 0;
  for (const m of view.machines) {
    for (const p of m.projects) {
      const outcome = tasks.get(p.projectId) ?? {
        ok: false as const,
        code: "agent_query_missing",
        error: "在飞任务查询器未返回该项目的任务清单",
      };
      const inflight = outcome.ok ? sortByClaimedAt(outcome.tasks.filter((t) => isInflightTaskState(t.state))) : [];
      if (!outcome.ok) grayedCount += 1;
      else inflightTotal += inflight.length;
      projects.push({
        machineId: m.machineId,
        projectId: p.projectId,
        agentKind: p.agentKind,
        machineError: m.error,
        outcome,
        inflight,
      });
    }
  }
  return { projects, grayedCount, inflightTotal };
}

// ---------------------------------------------------------------------------
// 桥 identity/version（G3 收编：3300 页面退役后的唯一承载位）
// ---------------------------------------------------------------------------

/**
 * 编排桥自报身份（原 3300 页面页头四字段）。`/health` 现只带 `role` / `version`
 * （`pid` / `startedAt` 在桥自己的 pidfile 里，板不读他单元文件）⇒ 缺键归一为 `null`，
 * 页上显示「—」并如实标注来源，**不臆造**。
 */
export interface BridgeIdentity {
  status: string | null;
  role: string | null;
  pid: number | null;
  startedAt: string | null;
  version: string | null;
}

/** 桥身份查询结果（fetcher 出口）。`ok=false` = 取不到（失败 / 超时 / 非 JSON），页头灰化。 */
export type BridgeIdentityOutcome =
  | { ok: true; identity: BridgeIdentity }
  | { ok: false; code: string; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `GET <base>/health` 原始负载 → 身份视图（纯函数）。
 * 只做**白名单字段投影 + 逐键容错**：非对象 / 非数值 pid ⇒ 该键 `null`（不判整次失败）；
 * 仅「响应不是 JSON 对象」才收口失败（连形状都没有 = 取不到，而非字段缺失）。
 */
export function normalizeBridgeIdentity(json: unknown): BridgeIdentityOutcome {
  if (!isRecord(json)) return { ok: false, code: "response_invalid", error: "桥 /health 响应不是 JSON 对象" };
  const pid = typeof json.pid === "number" && Number.isFinite(json.pid) ? json.pid : null;
  const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    ok: true,
    identity: {
      status: text(json.status),
      role: text(json.role),
      pid,
      startedAt: text(json.startedAt),
      version: text(json.version),
    },
  };
}

export type BridgeIdentityFetcher = () => Promise<BridgeIdentityOutcome>;

export interface BridgeIdentityFetcherOptions {
  /** MCP 基址（`config.json` 的 `mcpBaseUrl`，缺省 `http://127.0.0.1:8787`）—— 桥 `/health` 挂在这一面。 */
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 构造桥身份查询器：`GET <mcpBaseUrl>/health`（只读、零鉴权、loopback）。
 * 传输失败 / 非 2xx / 非法 JSON ⇒ 一律收口 `ok=false`（**不外抛**，页头灰化不炸页）。
 */
export function createBridgeIdentityFetcher(options: BridgeIdentityFetcherOptions): BridgeIdentityFetcher {
  const base = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? AGENT_QUERY_TIMEOUT_MS;
  return async (): Promise<BridgeIdentityOutcome> => {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") return { ok: false, code: "no_fetch", error: "运行环境无 fetch 实现" };
    let res: Response;
    try {
      res = await fetchImpl(`${base}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "health_unreachable", error: message };
    }
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, code: `http_${res.status}`, error: `桥返回 HTTP ${res.status}：${raw.slice(0, 200)}` };
    }
    try {
      return normalizeBridgeIdentity(JSON.parse(raw) as unknown);
    } catch {
      return { ok: false, code: "response_invalid", error: `桥 /health 响应不是合法 JSON：${raw.slice(0, 200)}` };
    }
  };
}
