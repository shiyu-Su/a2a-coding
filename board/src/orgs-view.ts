/**
 * 组织视角页的数据面（REQ-v0.9.2 板界面打磨 · N6）—— **只读**：
 * 组织清单归并（磁盘枚举 ∪ 板托管台账 ∪ 需求归属 ∪ 板级默认）+ 逐组项目查询 + 需求按组归组
 * + **全组枚举消费**（v0.9.4 C 档 · BD5：只读 `GET <3300>/api/groups`，组结构**声明面**）。
 *
 * 硬口径（改造文档 §3.1 N6「不做什么」）：
 * - **零写面**：不写任何配置、不写状态机；逐组查询 = 只读 MCP 调用（`a2a_projects`，非三工具名写面）、
 *   全组枚举 = 只读 HTTP GET（3300 聚合面）；
 * - **零新增存储、不缓存**：每次渲染现查（盘 + 各组桥 + 3300），板不落任何中间账；
 * - **单组失败不炸页**：失败 / 超时的组织如实标「不可达」（灰化），其余组织照常呈现；
 * - **3300 宕机不炸页**：全组枚举失败 / 超时 ⇒ 如实标「组数据不可用」（灰化），页面其余照常；
 * - **无归属需求不丢弃、不回落板级默认组**：`ownerGroup = null` 归「（无归属）」伪分组如实呈现。
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { callToolRaw, McpConfigError } from "./mcp-client.js";
import type { FeatureListItem, RegistryProjectsView } from "./bridge-client.js";
import type { DirKindProbeFn } from "./host-runtime.js";
import { statDirKind } from "./host-runtime.js";

/** 逐组 `a2a_projects` 查询的只读工具名（口径扫描锚点：本文件不含任何状态推进工具名）。 */
export const PROJECTS_QUERY_TOOL = "a2a_projects";

/** 单组查询超时（N6 口径 3–5s：一页并发查 N 组，宁可早降级不可拖垮整页）。 */
export const ORG_QUERY_TIMEOUT_MS = 4_000;

/** 无归属需求的伪分组名（如实呈现，不丢弃、不回落板级默认组）。 */
export const NO_OWNER_GROUP_LABEL = "（无归属）";

/** 参与归并的组织名来源。 */
export interface OrgNameSources {
  /** `<orgsDir>` 磁盘一级目录名（未配置 / 目录不可用 ⇒ 空数组，由调用方给出）。 */
  disk: readonly string[];
  /** 板托管台账里的组织（宿主桥 `statuses()` 的 org）。 */
  ledger: readonly string[];
  /** 需求列表的 `ownerGroup`（null 项不进组织清单，进伪分组）。 */
  featureGroups: readonly string[];
  /** 板级默认组织（可空）。 */
  defaultGroup: string | null;
}

/**
 * 组织清单归并（纯函数）：四源并集、trim 后去重、丢弃空名与 `.`/`..` 异常段、字典序排列。
 * 排序键与渲染同单点（避免逐次渲染抖动）。
 */
export function mergeOrgNames(sources: OrgNameSources): string[] {
  const names = new Set<string>();
  for (const list of [sources.disk, sources.ledger, sources.featureGroups, sources.defaultGroup === null ? [] : [sources.defaultGroup]]) {
    for (const raw of list) {
      const name = raw.trim();
      if (name === "" || name === "." || name === "..") continue;
      names.add(name);
    }
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 门户卡清单 ∩ 顶栏切换器清单的**共用口径**（v0.9.4 §9-b/§9-d · REQ-2026-09-27-06 · 纯函数）：
 * **台账未停用 ∪ 需求归属（ownerGroup）**（另并入板级默认与当前空间组织两个无争议源），
 * 停用名一票否决。**磁盘一级目录枚举不进本口径** —— 盘遗留目录与外机组（本板无需求归属）
 * 都不构成板可见的组织（BD7 的「本地三源」形态由本函数取代，两处清单自此同源单点）。
 *
 * `current` = 当前空间组织：其空间路由已由存在性 universe 放行才可能出现在这里，
 * 故保证进清单（顶栏「当前组织」高亮不因源缺席而丢失）；停用名不接受（点了必 410）。
 */
export interface PortalOrgSources {
  /** 台账在用名（板组织台账 ∪ 宿主桥托管）。 */
  ledger: readonly string[];
  /** 需求列表的 `ownerGroup`（null / 空白由调用方滤除）。 */
  featureGroups: readonly string[];
  /** 板级默认组织（可空）。 */
  defaultGroup: string | null;
  /** 台账停用名（唯一判据 = `orgs-ledger.isOrgDisabled` 的集合形态）。 */
  disabled?: readonly string[];
  /** 当前空间组织（非空间页 ⇒ null / 省略）。 */
  current?: string | null;
}

export function portalOrgNames(sources: PortalOrgSources): string[] {
  const disabled = new Set((sources.disabled ?? []).map((n) => n.trim()).filter((n) => n !== ""));
  const merged = mergeOrgNames({
    disk: [],
    ledger: sources.ledger,
    featureGroups: sources.featureGroups,
    defaultGroup: sources.defaultGroup,
  }).filter((n) => !disabled.has(n));
  const current = (sources.current ?? "").trim();
  if (current === "" || disabled.has(current) || merged.includes(current)) return merged;
  return mergeOrgNames({ disk: [current], ledger: merged, featureGroups: [], defaultGroup: null });
}

/** 需求按 `ownerGroup` 归组（纯函数）：null / 空白归属 ⇒ 归「（无归属）」伪分组，不丢弃。 */
export function groupFeaturesByOwner(features: readonly FeatureListItem[]): Map<string, FeatureListItem[]> {
  const groups = new Map<string, FeatureListItem[]>();
  for (const f of features) {
    const owner = (f.ownerGroup ?? "").trim();
    const key = owner === "" ? NO_OWNER_GROUP_LABEL : owner;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [f]);
    else bucket.push(f);
  }
  return groups;
}

/**
 * 组织空间过滤（v0.9.4 D 档 / BD6 · 纯函数）：保留 `ownerGroup` trim 后 == org 的项
 * （trim-vs-trim 口径同 {@link groupFeaturesByOwner}）；null / 空白归属不进任何组织空间。
 */
export function featuresOfOrg(features: readonly FeatureListItem[], org: string): FeatureListItem[] {
  const target = org.trim();
  if (target === "") return [];
  return features.filter((f) => (f.ownerGroup ?? "").trim() === target);
}

/** 组内项目行（`a2a_projects` 出参 `machines[].projects[]` 的白名单字段投影）。 */
export interface OrgProjectRow {
  machineId: string;
  projectId: string;
  agentKind: string | null;
  a2aPort: number | null;
  status: string | null;
  startedAt: string | null;
  /** 机器级 error（`a2a_projects` 出参 machines[].error）；机器无错 ⇒ null。 */
  machineError: string | null;
}

/** 单组查询结果（fetcher 出口）。`ok=false` = 不可达（失败 / 超时），projects 面未知。 */
export type OrgProjectsOutcome =
  | { ok: true; projects: OrgProjectRow[] }
  | { ok: false; code: string; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * `a2a_projects` 原始负载 → 归一结果（纯函数）。
 * 桥侧契约：成功 = 无 `ok` 字段的视图（`machines[]`）；失败 = `{ok:false,code,error}`；
 * JSON-RPC 层错误已由 `callToolRaw` 收口。视图外的异常形状 ⇒ `response_invalid`（不臆造空清单）。
 */
export function normalizeProjectsOutcome(json: unknown): OrgProjectsOutcome {
  if (!isRecord(json)) return { ok: false, code: "response_invalid", error: "组织项目查询响应不是 JSON 对象" };
  if (json.ok === false) {
    return {
      ok: false,
      code: str(json.code) ?? "unknown",
      error: str(json.error) ?? "桥返回失败",
    };
  }
  if (!Array.isArray(json.machines)) {
    return { ok: false, code: "response_invalid", error: "组织项目查询响应缺 machines 数组" };
  }
  const projects: OrgProjectRow[] = [];
  for (const entry of json.machines) {
    if (!isRecord(entry)) continue;
    const machineId = str(entry.machineId) ?? "—";
    const machineError = str(entry.error);
    const rawProjects = Array.isArray(entry.projects) ? entry.projects : [];
    for (const pe of rawProjects) {
      if (!isRecord(pe)) continue;
      const projectId = str(pe.projectId);
      if (projectId === null) continue;
      projects.push({
        machineId,
        projectId,
        agentKind: str(pe.agentKind),
        a2aPort: num(pe.a2aPort),
        status: str(pe.status),
        startedAt: str(pe.startedAt),
        machineError,
      });
    }
  }
  return { ok: true, projects };
}

/** 逐组查询注入面（单测喂假桥；缺省 = 经 N5 通用 MCP 客户端真查）。 */
export type OrgProjectsFetcher = (org: string) => Promise<OrgProjectsOutcome>;

export interface OrgProjectsFetcherOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 以缺省 MCP 客户端构造逐组查询器：组身份 = 组织名（URL 首段），单组超时 {@link ORG_QUERY_TIMEOUT_MS}。 */
export function createOrgProjectsFetcher(options: OrgProjectsFetcherOptions): OrgProjectsFetcher {
  return async (org: string): Promise<OrgProjectsOutcome> => {
    try {
      const outcome = await callToolRaw(
        options.baseUrl,
        org,
        PROJECTS_QUERY_TOOL,
        {},
        { timeoutMs: options.timeoutMs ?? ORG_QUERY_TIMEOUT_MS, ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) },
      );
      return normalizeProjectsOutcome(outcome.ok ? outcome.json : outcome);
    } catch (err) {
      // 组身份不合法（空名等）= 该组不可查，如实结构化上报，不炸整页
      if (err instanceof McpConfigError) return { ok: false, code: "org_name_invalid", error: err.message };
      throw err;
    }
  };
}

/**
 * `<orgsDir>` 一级目录枚举（探针判根；根未配置 / 不是目录 / 查不动 ⇒ 空清单 = 降级不报错，
 * 「盘查不动」与「盘上没组织」在页面上不可混淆的职责交给视图层的 orgsDir 状态行）。
 */
export function listOrgDirs(orgsDir: string | null, probe: DirKindProbeFn = statDirKind): string[] {
  if (orgsDir === null) return [];
  const root = resolve(orgsDir);
  if (probe(root) !== "dir") return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 全组枚举消费（v0.9.4 C 档 · BD5，改造文档 §2.4）
// ---------------------------------------------------------------------------
//
// 数据源 = **3300 只读聚合面** `GET /api/groups`（orch O2）—— 全组事实源本来就在聚合面，
// **不走 MCP 单组连接拼合**（逐组连接只能看到本组，拼合出来的「全组」是假象）。
// 与逐组 `a2a_projects` 的关系 = **并存、不替代**：前者是**组结构声明面**（谁挂在哪组），
// 后者是**运行态**（该组当前有哪些项目）。

/** 全组枚举端点路径（3300 只读面，v0.9.4 O2 交付）。 */
export const GROUPS_QUERY_PATH = "/api/groups";

/** 声明面的一条成员项（`machineId` 按**不透明字符串**处理，板不拆格式）。 */
export interface GroupMemberRow {
  machineId: string;
  projectId: string;
}

/** 声明面的一个组（桥 `GroupView` 的白名单投影）。 */
export interface GroupRow {
  name: string;
  memberCount: number;
  members: GroupMemberRow[];
}

/**
 * 全组枚举查询结果（fetcher 出口）。
 * `ok=false` = 3300 不可达 / 配置坏（`machines_config_error`）⇒ 视图层整块灰化「组数据不可用」，
 * **不得阻断页面其余渲染**。`warnings` = 桥的 warn-once 配置瑕疵文案，**只如实呈现、不入任何判定**。
 */
export type OrgGroupsOutcome =
  | { ok: true; groups: GroupRow[]; warnings: string[]; observedAt: string | null }
  | { ok: false; code: string; error: string };

/**
 * `GET /api/groups` 原始负载 → 归一投影（纯函数）。
 * 桥契约：成功 = `{ok:true, groups[], warnings[]}`（未配组 ⇒ `groups: []` = 全量接纳语义，
 * 是**真实空**不是缺位）；失败 = `{ok:false, code, error}`（500 `machines_config_error`）。
 * 形状不合 ⇒ `response_invalid`（不臆造空清单）；`name` 非字符串的组条目跳过（无法归组身份）。
 */
export function normalizeGroupsOutcome(json: unknown): OrgGroupsOutcome {
  if (!isRecord(json)) return { ok: false, code: "response_invalid", error: "全组枚举响应不是 JSON 对象" };
  if (json.ok !== true) {
    return {
      ok: false,
      code: str(json.code) ?? "response_invalid",
      error: str(json.error) ?? "全组枚举查询未成功",
    };
  }
  if (!Array.isArray(json.groups)) {
    return { ok: false, code: "response_invalid", error: "全组枚举响应缺 groups 数组" };
  }
  const groups: GroupRow[] = [];
  for (const entry of json.groups) {
    if (!isRecord(entry)) continue;
    const name = str(entry.name);
    if (name === null) continue;
    const rawMembers = Array.isArray(entry.members) ? entry.members : [];
    const members: GroupMemberRow[] = [];
    for (const me of rawMembers) {
      if (!isRecord(me)) continue;
      const machineId = str(me.machineId);
      const projectId = str(me.projectId);
      if (machineId === null || projectId === null) continue;
      members.push({ machineId, projectId });
    }
    const declared = num(entry.memberCount);
    groups.push({ name, memberCount: declared !== null ? declared : members.length, members });
  }
  const warnings = Array.isArray(json.warnings) ? json.warnings.filter((w): w is string => typeof w === "string") : [];
  return { ok: true, groups, warnings, observedAt: str(json.observedAt) };
}

/** 全组枚举查询注入面（单测喂假端点；缺省 = 经 3300 只读面真查）。 */
export type OrgGroupsFetcher = () => Promise<OrgGroupsOutcome>;

export interface OrgGroupsFetcherOptions {
  /** 3300 只读运维视图基址（config `bridgeUrl`；缺省同 `bridge-client` 的 `DEFAULT_BRIDGE_BASE_URL`）。 */
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 构造全组枚举查询器：`GET <3300>/api/groups`（只读、零鉴权、loopback）。
 * 传输失败 / 超时 / 非 2xx / 非法 JSON ⇒ 一律收口 `ok=false`，**不外抛**（宕机不阻断页面渲染）；
 * 非 2xx 时优先取响应体的 `code`（如 `machines_config_error`），取不到才落 `http_<status>`。
 */
export function createOrgGroupsFetcher(options: OrgGroupsFetcherOptions): OrgGroupsFetcher {
  const base = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? ORG_QUERY_TIMEOUT_MS;
  return async (): Promise<OrgGroupsOutcome> => {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") return { ok: false, code: "no_fetch", error: "运行环境无 fetch 实现" };
    try {
      const res = await fetchImpl(`${base}${GROUPS_QUERY_PATH}`, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
      const raw = await res.text();
      if (!res.ok) {
        let code = `http_${res.status}`;
        try {
          const body: unknown = JSON.parse(raw);
          code = (isRecord(body) ? str(body.code) : null) ?? code;
        } catch {
          /* 错误体非 JSON ⇒ 用 HTTP 状态码收口，原文照常带出 */
        }
        return { ok: false, code, error: `桥返回 HTTP ${res.status}：${raw.slice(0, 200)}` };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false, code: "response_invalid", error: `全组枚举响应不是合法 JSON：${raw.slice(0, 200)}` };
      }
      return normalizeGroupsOutcome(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 超时与「连不上」分开收口：AbortSignal.timeout 触发的中止在 Node 侧是 TimeoutError / abort 文案
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || /abort|timed? ?out/i.test(`${err.name} ${message}`));
      return { ok: false, code: timedOut ? "groups_timeout" : "groups_unreachable", error: message };
    }
  };
}

// ---------------------------------------------------------------------------
// 项目池集合差（v0.9.8 两栏拖拽增删项目 · REQ-2026-10-03-02 · 纯函数）
// ---------------------------------------------------------------------------

/**
 * 池的一行 = 一个**机器项目对**（键形与 O1 成员对 `{machineId, projectId}` 一致）。
 * 机段随行保留：配对 / 去重按 (machineId, projectId)，**绝不塌成裸 projectId 集**。
 * `lastReportedAt` = 该行在项目池里的唯一时间提示位（显示层「最后上报于」，非实时探测；供 N4 消费）；
 * 仍**不带**运行态字段（agentKind / status / runnerState / online 归下方「项目」区，两栏不重复）。
 */
export interface PoolProjectRow {
  machineId: string;
  projectId: string;
  /** 项目最后一次上报时刻（注册表 `runnerProjectsReplace` 写入）；缺键 ⇒ null。 */
  lastReportedAt: string | null;
}

/**
 * 成员对 / 项目对的复合键（两侧各 trim，口径同 `group-admin.isSameMemberPair` 的「trim 后逐字相等」）。
 * 用 `JSON.stringify` 而非拼接分隔符 —— 定长分隔符会被含该字符的 id 伪造出撞键（machine 与 project 两段各转义）。
 */
export function memberPairKey(machineId: string, projectId: string): string {
  return JSON.stringify([machineId.trim(), projectId.trim()]);
}

/**
 * 项目池集合差（**纯函数**）：注册表全量机器项目 − 全组（**含本组**）声明面成员对。
 * - 去重键 = {@link memberPairKey}（同一机同 projectId 在快照里只出现一次，跨组声明面可重复）；
 * - `lastReportedAt` 随行透传（作池行时间提示，不参与配对键）；
 * - 输入顺序不保证 ⇒ 输出按 (machineId, projectId) 字典序，与渲染同单点（避免逐次渲染抖动）；
 * - **「池里不显示」只是显示过滤，不是写入闸门** —— 执法仍在桥 O1 原子拒 + 板 409
 *   `board_member_group_conflict`（REQ-2026-10-03-02 §3.1 分层口径）。
 */
export function poolProjects(
  allProjects: readonly PoolProjectRow[],
  groups: readonly GroupRow[],
): PoolProjectRow[] {
  const owned = new Set<string>();
  for (const g of groups) {
    for (const m of g.members) owned.add(memberPairKey(m.machineId, m.projectId));
  }
  const seen = new Set<string>();
  const rows: PoolProjectRow[] = [];
  for (const p of allProjects) {
    const key = memberPairKey(p.machineId, p.projectId);
    if (owned.has(key) || seen.has(key)) continue;
    seen.add(key);
    rows.push({ machineId: p.machineId.trim(), projectId: p.projectId.trim(), lastReportedAt: p.lastReportedAt });
  }
  return rows.sort((a, b) => {
    if (a.machineId !== b.machineId) return a.machineId < b.machineId ? -1 : 1;
    if (a.projectId === b.projectId) return 0;
    return a.projectId < b.projectId ? -1 : 1;
  });
}

/** 注册表全量机器项目快照的读取结论（`ctx.client.getRegistryProjects()` 出口；`ok=false` = 快照不可用）。 */
export type ProjectSnapshotOutcome =
  | { ok: true; rows: PoolProjectRow[]; observedAt: string | null }
  | { ok: false; code: string; error: string };

/**
 * 池区的降级结论（视图入参）：任一侧读不到 ⇒ `ok=false`，视图整块灰化并回落到手填表单常态。
 * `ok:true ∧ rows=[]` 是**真实空池**（全量项目已全部归属某组），与「不可用」不得混写。
 */
export type OrgPoolOutcome =
  | { ok: true; rows: PoolProjectRow[]; observedAt: string | null }
  | { ok: false; code: string; error: string };

/**
 * 组装池（**纯函数**，快照 / 声明面两源任一缺席即降级，不臆造空池）：
 * 声明面 `null` = 查询器未装配、`ok=false` = 3300 宕机 / 配置坏 —— 两种情形下「哪些项目已归属」**未知**，
 * 此时若把全量项目当池渲染，会把别组项目重新摆上池面（REQ-2026-10-03-02 用户裁「完全不显示」的反面）。
 */
export function computeProjectPool(snapshot: ProjectSnapshotOutcome, groups: OrgGroupsOutcome | null): OrgPoolOutcome {
  if (!snapshot.ok) return { ok: false, code: snapshot.code, error: snapshot.error };
  if (groups === null) return { ok: false, code: "groups_not_configured", error: "全组枚举查询器未装配 ⇒ 项目归属未知" };
  if (!groups.ok) return { ok: false, code: groups.code, error: groups.error };
  return { ok: true, rows: poolProjects(snapshot.rows, groups.groups), observedAt: snapshot.observedAt };
}

/**
 * 注册表全量机器项目快照（`getRegistryProjects()` 的 `machines[].projects[]`）→ 池候选行（**纯投影**）。
 * 遍历源 = runners 表：在线机与**离线机**的项目一视同仁入行（B-8：归属事实面，不因 runnerState 过滤）；
 * 机段随行保留（不塌成裸 projectId），并透传 `lastReportedAt` 作池行时间提示。
 * 注册表面**无机器级 `error` 条目**（离线机不发 error 文案），故无需 error 分支 —— 快照健康度由
 * `parseRegistryProjects` 的 fail-closed（缺 `machines[]` ⇒ 抛错）在读取侧承载，本函数只投影键，不臆造也不过滤。
 */
export function poolRowsFromSnapshot(view: RegistryProjectsView): PoolProjectRow[] {
  const rows: PoolProjectRow[] = [];
  for (const machine of view.machines) {
    for (const project of machine.projects) {
      rows.push({ machineId: machine.machineId, projectId: project.projectId, lastReportedAt: project.lastReportedAt });
    }
  }
  return rows;
}
