/**
 * 组织视角页的数据面（REQ-v0.9.2 板界面打磨 · N6）—— **只读**：
 * 组织清单归并（磁盘枚举 ∪ 板托管台账 ∪ 需求归属 ∪ 板级默认）+ 逐组项目查询 + 需求按组归组。
 *
 * 硬口径（改造文档 §3.1 N6「不做什么」）：
 * - **零写面**：不写任何配置、不写状态机；逐组查询 = 只读 MCP 调用（`a2a_projects`，非三工具名写面）；
 * - **零新增存储、不缓存**：每次渲染现查（盘 + 各组桥），板不落任何中间账；
 * - **单组失败不炸页**：失败 / 超时的组织如实标「不可达」（灰化），其余组织照常呈现；
 * - **无归属需求不丢弃、不回落板级默认组**：`ownerGroup = null` 归「（无归属）」伪分组如实呈现。
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { callToolRaw, McpConfigError } from "./mcp-client.js";
import type { FeatureListItem } from "./bridge-client.js";
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
