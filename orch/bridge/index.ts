/**
 * MCP 泛型桥（orch 工具面）。
 *
 * 只暴露固定 5 个泛型工具，不按 skill 生成工具、不做动态注册（不发 `tools/list_changed`）：
 * - `a2a_projects()`                     聚合各机 `GET /projects`
 * - `a2a_tasks(project, state?, limit?)` 按项目列出本地任务记录（纯本地 + 只读探测，不 ensure）
 * - `a2a_call(project, message, contextId?)`  解析项目→机器 → 幂等 ensure → A2A message/send
 * - `a2a_task_status(taskId)`            查询任务态（远端 A2A `tasks/get`，回写本地存储）
 * - `a2a_cancel(taskId)`                 取消任务（远端 A2A `tasks/cancel`，回写本地存储）
 *
 * 首触一台机器先经 `GET /health` 握手校验线协议版本（PROTOCOL.md）；主版本不受
 * 支持即拒绝派发（fail-fast），杜绝新请求体被旧 Launcher 静默忽略。
 *
 * 依赖：
 * - `@a2a-js/sdk`（A2A Client；v1.1.0：`ClientFactory` + `JsonRpcTransportFactory`/`RestTransportFactory`）
 * - `../session/store.js`（任务态持久化；CLI 会话由包装器按 A2A `contextId` 持有）
 *
 * 跨 MCP 边界的错误一律结构化返回（`{ ok: false, code, error }`），不抛出。
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from "@a2a-js/sdk/client";
import type { Client } from "@a2a-js/sdk/client";
import { Role, TaskState as A2aTaskState, taskStateFromJSON } from "@a2a-js/sdk";
import type {
  Artifact,
  Message,
  Part,
  SendMessageRequest,
  SendMessageResult,
  Task,
} from "@a2a-js/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appRootFromModule } from "../app-root.js";
import { loadMachinesConfig } from "../config.js";
import {
  PROTOCOL_VERSION,
  SUPPORTED_PEER_PROTOCOL_MAJORS,
  type AgentKind,
  type ArtifactRecord,
  type CallbackConfig,
  type EventRecord,
  type FeatureRecord,
  type InputArtifactRef,
  type MachineRef,
  type ProjectStatus,
  type RiskLevel,
  type TaskListItem,
  type TaskRecord,
  type TaskState as DomainTaskState,
} from "../types.js";
import {
  appendEvent,
  createTask,
  getArtifact,
  getFeature,
  getTask,
  latestEventId,
  listArtifactsByFeature,
  listArtifactsByProducer,
  listEvents,
  listTasks,
  markTaskDispatched,
  pruneTasks,
  truncatePrompt,
  updateTaskState,
  upsertArtifact,
  close as closeSessionStore,
} from "../session/store.js";
import {
  isTaskWatched,
  notifyTaskPush,
  startTaskWatcher,
  WATCHER_MAX_CONSECUTIVE_FAILURES,
} from "./task-watcher.js";
import {
  FEATURE_ABANDONED_TEXT,
  FeatureScheduler,
  type FeatureDispatchResult,
} from "./scheduler.js";
import {
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCancel,
  handleFeatureCreate,
  handleFeatureStatus,
} from "./feature-tools.js";

// ---------------------------------------------------------------------------
// 配置与超时（全部可通过环境变量覆盖；显式超时，避免跨机调用挂死）
// ---------------------------------------------------------------------------

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/** orch 侧机器清单路径（默认 orch 单元根 `config/config.json`，模板见同目录 `config.json.default`；环境变量 `MACHINES_CONFIG` 可覆盖） */
const MACHINES_CONFIG_PATH =
  process.env["MACHINES_CONFIG"] ??
  join(appRootFromModule(import.meta.url), "config", "config.json");

/** Launcher `GET /projects` / `POST .../ensure` 超时 */
const LAUNCHER_TIMEOUT_MS = readPositiveIntEnv("LAUNCHER_TIMEOUT_MS", 15_000);
/** Launcher `ensure`（可能触发 Agent 启动）超时 */
const LAUNCHER_ENSURE_TIMEOUT_MS = readPositiveIntEnv("LAUNCHER_ENSURE_TIMEOUT_MS", 60_000);
/** 单次 A2A 请求超时 */
const A2A_REQUEST_TIMEOUT_MS = readPositiveIntEnv("A2A_REQUEST_TIMEOUT_MS", 30_000);
/** A2A Agent Card 拉取超时 */
const A2A_CARD_TIMEOUT_MS = readPositiveIntEnv("A2A_CARD_TIMEOUT_MS", 15_000);
/** `a2a_call` 同步等待预算；到点仍未终态则返回 working + taskId 供轮询（半异步；须小于 host MCP client 请求超时） */
const SYNC_BUDGET_MS = readPositiveIntEnv("SYNC_BUDGET_MS", 30_000);
/** 任务轮询间隔 */
const POLL_INTERVAL_MS = readPositiveIntEnv("POLL_INTERVAL_MS", 1_000);
/** 任务轮询期间的租约续期间隔（周期性重呼 launcher `ensure`，防止空闲自动停止误杀运行中任务） */
const LEASE_RENEW_INTERVAL_MS = readPositiveIntEnv("LEASE_RENEW_INTERVAL_MS", 5_000);
/** 派发注入上游产物时的内联字符上限；超出仅保留头部 + 截断说明（完整内容按 uri 引用） */
const ARTIFACT_INLINE_MAX_CHARS = readPositiveIntEnv("ARTIFACT_INLINE_MAX_CHARS", 4_000);

/** 回调端点默认配置（`config.callback` 缺省时；默认关） */
const DEFAULT_CALLBACK_CONFIG: CallbackConfig = { enabled: false, host: "127.0.0.1", port: 3200 };
/** 回调请求体字节上限（防御性；超出即 400） */
const CALLBACK_MAX_BODY_BYTES = readPositiveIntEnv("CALLBACK_MAX_BODY_BYTES", 1_048_576);
/** 回调事件落库 payload 截断上限（事件表只作收件箱，不存全量 Task） */
const CALLBACK_PAYLOAD_MAX_CHARS = readPositiveIntEnv("CALLBACK_PAYLOAD_MAX_CHARS", 2_000);
/** `a2a_events` 单次返回条数上限 */
const EVENTS_PAGE_LIMIT = readPositiveIntEnv("EVENTS_PAGE_LIMIT", 100);
/** `a2a_wait` 除订阅唤醒外对 DB 的轮询对账间隔（兜底：非回调路径写入的事件） */
const EVENT_WAIT_POLL_MS = readPositiveIntEnv("EVENT_WAIT_POLL_MS", 500);
/** `a2a_wait` 内部 cap：须 < `SYNC_BUDGET_MS`（宿主 MCP 请求超时），留 5s 余量 */
const EVENT_WAIT_MAX_MS = Math.max(1_000, SYNC_BUDGET_MS - 5_000);
/** 事件 kind：收到 worker push 回调（v0.4.0 §2.6） */
const EVENT_PUSH_RECEIVED = "push.received";

const AGENT_KINDS: readonly AgentKind[] = ["opencode", "codex", "claude"];

const RISK_LEVELS: readonly RiskLevel[] = ["read", "write", "full"];

// ---------------------------------------------------------------------------
// 通用小工具（unknown 收窄，避免 any）
// ---------------------------------------------------------------------------

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isAgentKind(v: string): v is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(v);
}

function isRiskLevel(v: unknown): v is RiskLevel {
  return typeof v === "string" && (RISK_LEVELS as readonly string[]).includes(v);
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function stringifyUnknown(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Launcher HTTP（显式超时；失败返回结构化结果，不抛出）
// ---------------------------------------------------------------------------

type HttpResult =
  { ok: true; status: number; data: unknown } | { ok: false; status: number; error: string };

function extractErrorMessage(data: unknown): string | null {
  const o = asRecord(data);
  if (o === null) return null;
  const err = o["error"];
  if (typeof err === "string" && err.length > 0) return err;
  const errObj = asRecord(err);
  if (errObj !== null) {
    const msg = asNonEmptyString(errObj["message"]);
    if (msg !== null) return msg;
  }
  return asNonEmptyString(o["message"]);
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<HttpResult> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: extractErrorMessage(data) ?? `HTTP ${res.status}`,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: toMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// 线协议握手（PROTOCOL.md：桥首触机器时 GET /health 校验 protocolVersion）
// ---------------------------------------------------------------------------

type ProtocolCheck = { ok: true; version: string } | { ok: false; code: string; error: string };

/** 已通过握手校验的机器：machineId → 该机自报完整版本号（供按机器版本的行为分支查用） */
const protocolVerified = new Map<string, string>();
/** in-flight 握手去重：并发首触同一机器只发一次 /health */
const protocolHandshakes = new Map<string, Promise<ProtocolCheck>>();

function parseProtocolMajor(version: string): number | null {
  const m = /^(\d+)\./.exec(version.trim());
  return m === null ? null : Number(m[1]);
}

/**
 * 首触握手（幂等）：每机器成功校验一次后本进程内不再重复；
 * 失败不缓存负项——机器升级后下一次调用自动重新握手，无需重启桥。
 */
async function ensureProtocol(machine: MachineRef): Promise<ProtocolCheck> {
  const verified = protocolVerified.get(machine.machineId);
  if (verified !== undefined) return { ok: true, version: verified };

  const inflight = protocolHandshakes.get(machine.machineId);
  if (inflight !== undefined) return inflight;

  const check = performHandshake(machine).finally(() => {
    protocolHandshakes.delete(machine.machineId);
  });
  protocolHandshakes.set(machine.machineId, check);
  return check;
}

async function performHandshake(machine: MachineRef): Promise<ProtocolCheck> {
  const url = `${trimTrailingSlash(machine.launcherUrl)}/health`;
  const res = await fetchJson(
    url,
    { method: "GET", headers: { accept: "application/json" } },
    LAUNCHER_TIMEOUT_MS,
  );
  if (!res.ok) {
    console.error(
      `[a2a-bridge] protocol handshake: ${machine.machineId} 失败（${res.status}）：${res.error}`,
    );
    return {
      ok: false,
      code: "launcher_unreachable",
      error: `机器 ${machine.machineId} 线协议握手失败：GET ${url}（${res.status}）：${res.error}`,
    };
  }
  const o = asRecord(res.data);
  const raw = o === null ? null : asNonEmptyString(o["protocolVersion"]);
  // 缺失 / 非法 = 未版本化的旧版 Launcher（v0.1.1 及更早），主版本视为 0
  const actual = raw ?? "0.0";
  const major = parseProtocolMajor(actual);
  if (major === null || !SUPPORTED_PEER_PROTOCOL_MAJORS.includes(major)) {
    const actualDesc = raw === null ? "未版本化的旧版 Launcher（无 protocolVersion）" : actual;
    console.error(
      `[a2a-bridge] protocol handshake: ${machine.machineId} v=${actualDesc} 不受支持（本桥 v${PROTOCOL_VERSION}，可支持主版本：${SUPPORTED_PEER_PROTOCOL_MAJORS.join(", ")}）`,
    );
    return {
      ok: false,
      code: "protocol_version_mismatch",
      error:
        `机器 ${machine.machineId}（${machine.launcherUrl}）线协议版本 ${actualDesc} 不受支持` +
        `（本桥线协议版本 ${PROTOCOL_VERSION}，可支持主版本：${SUPPORTED_PEER_PROTOCOL_MAJORS.join(", ")}）。` +
        `请升级该机器 machine 单元（Launcher）后重试；升级后无需重启桥，下一次调用自动重新握手。`,
    };
  }
  protocolVerified.set(machine.machineId, actual);
  // 桥内观测日志统一走 stderr，避免混入 MCP stdio 协议通道
  console.error(
    `[a2a-bridge] protocol handshake: ${machine.machineId} v=${actual} 通过（本桥 v${PROTOCOL_VERSION}）`,
  );
  return { ok: true, version: actual };
}

// ---------------------------------------------------------------------------
// 项目定位（project -> machine；懒加载缓存，无中心注册）
// ---------------------------------------------------------------------------

const projectIndex = new Map<string, string>();

function parseProjectStatus(v: unknown): ProjectStatus | null {
  const o = asRecord(v);
  if (o === null) return null;
  const projectId = asNonEmptyString(o["projectId"]);
  if (projectId === null) return null;
  const workspace = typeof o["workspace"] === "string" ? o["workspace"] : "";
  const agentKindRaw = o["agentKind"];
  const agentKind: AgentKind =
    typeof agentKindRaw === "string" && isAgentKind(agentKindRaw) ? agentKindRaw : "opencode";
  const a2aPortRaw = o["a2aPort"];
  const a2aPort = typeof a2aPortRaw === "number" && Number.isInteger(a2aPortRaw) ? a2aPortRaw : 0;
  const riskRaw = o["risk"];
  const parsed: ProjectStatus = {
    projectId,
    workspace,
    agentKind,
    a2aPort,
    status: o["status"] === "online" ? "online" : "offline",
    endpoint: asNonEmptyString(o["endpoint"]),
    startedAt: asNonEmptyString(o["startedAt"]),
  };
  if (isRiskLevel(riskRaw)) parsed.risk = riskRaw;
  return parsed;
}

function parseProjectList(data: unknown): ProjectStatus[] | null {
  const raw = Array.isArray(data)
    ? data
    : (() => {
        const o = asRecord(data);
        if (o === null) return null;
        const projects = o["projects"];
        return Array.isArray(projects) ? projects : null;
      })();
  if (raw === null) return null;
  const parsed: ProjectStatus[] = [];
  for (const item of raw) {
    const p = parseProjectStatus(item);
    if (p !== null) parsed.push(p);
  }
  return parsed;
}

type ListResult =
  { ok: true; projects: ProjectStatus[] } | { ok: false; code?: string; error: string };

async function listMachineProjects(machine: MachineRef): Promise<ListResult> {
  const protocol = await ensureProtocol(machine);
  if (!protocol.ok) {
    return { ok: false, code: protocol.code, error: protocol.error };
  }
  const url = `${trimTrailingSlash(machine.launcherUrl)}/projects`;
  const res = await fetchJson(
    url,
    { method: "GET", headers: { accept: "application/json" } },
    LAUNCHER_TIMEOUT_MS,
  );
  if (!res.ok) {
    return { ok: false, error: `GET ${url} 失败（${res.status}）：${res.error}` };
  }
  const projects = parseProjectList(res.data);
  if (projects === null) {
    return {
      ok: false,
      error: `GET ${url} 响应格式不合法：期望 ProjectStatus[] 或 { projects: ProjectStatus[] }`,
    };
  }
  return { ok: true, projects };
}

type LocateResult =
  | { ok: true; machine: MachineRef; project: ProjectStatus }
  | { ok: false; code: string; error: string };

function loadMachines(): { ok: true; machines: MachineRef[] } | { ok: false; error: string } {
  try {
    return { ok: true, machines: loadMachinesConfig(MACHINES_CONFIG_PATH).machines };
  } catch (err) {
    return {
      ok: false,
      error: `加载机器清单失败（${MACHINES_CONFIG_PATH}）：${toMessage(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// worker 回调配置（v0.4.0 §2.6：push 内联注册 + 本地事件端点；默认关）
// ---------------------------------------------------------------------------

/** 回调端点配置（懒加载 + 进程内缓存；加载失败回落默认关闭） */
let cachedCallbackConfig: CallbackConfig | null = null;
let callbackConfigLoaded = false;

function callbackConfig(): CallbackConfig {
  if (!callbackConfigLoaded) {
    callbackConfigLoaded = true;
    try {
      cachedCallbackConfig = loadMachinesConfig(MACHINES_CONFIG_PATH).callback ?? null;
    } catch (err) {
      console.error(`[a2a-bridge] 加载回调配置失败：${toMessage(err)}`);
      cachedCallbackConfig = null;
    }
  }
  return cachedCallbackConfig ?? DEFAULT_CALLBACK_CONFIG;
}

/**
 * 该机器本次派发是否内联注册 push 回调（路径 1，v0.4.0 §2.6）：
 * 需 orch `callback.enabled` 与该机 `pushCallback` **同时**为真；返回回调 `url`/`token`。
 */
function pushCallbackFor(machine: MachineRef): { url: string; token: string } | null {
  const cb = callbackConfig();
  if (!cb.enabled || machine.pushCallback !== true) return null;
  return { url: `http://${cb.host}:${cb.port}/callback`, token: cb.token ?? "" };
}

/** 解析 project -> machine（命中缓存时仅向该机核对；未命中时全量扫描并写缓存） */
async function locateProject(projectId: string): Promise<LocateResult> {
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error };
  }
  const machines = config.machines;

  const cachedMachineId = projectIndex.get(projectId);
  if (cachedMachineId !== undefined) {
    const machine = machines.find((m) => m.machineId === cachedMachineId);
    if (machine !== undefined) {
      const listed = await listMachineProjects(machine);
      if (listed.ok) {
        const project = listed.projects.find((p) => p.projectId === projectId);
        if (project !== undefined) return { ok: true, machine, project };
      }
      projectIndex.delete(projectId);
    } else {
      projectIndex.delete(projectId);
    }
  }

  const scanned = await Promise.all(
    machines.map(async (machine) => ({
      machine,
      listed: await listMachineProjects(machine),
    })),
  );
  const unreachable: string[] = [];
  const protocolRefusals: string[] = [];
  for (const { machine, listed } of scanned) {
    if (!listed.ok) {
      // 协议拒绝与普通不可达分开归集：项目无法定位时优先给出可操作的升级指引
      if (listed.code === "protocol_version_mismatch") {
        protocolRefusals.push(listed.error);
      } else {
        unreachable.push(`${machine.machineId}: ${listed.error}`);
      }
      continue;
    }
    const project = listed.projects.find((p) => p.projectId === projectId);
    if (project !== undefined) {
      projectIndex.set(projectId, machine.machineId);
      return { ok: true, machine, project };
    }
  }
  if (protocolRefusals.length > 0) {
    return {
      ok: false,
      code: "protocol_version_mismatch",
      error: `未能定位项目 ${projectId}（机器线协议版本不受支持）：${protocolRefusals.join("; ")}`,
    };
  }
  const suffix = unreachable.length > 0 ? `（部分机器不可达：${unreachable.join("; ")}）` : "";
  return {
    ok: false,
    code: "project_not_found",
    error: `未在已配置机器上找到项目 ${projectId}${suffix}`,
  };
}

type EnsureOutcome =
  { ok: true; endpoint: string; started: boolean } | { ok: false; code: string; error: string };

/** `POST {launcher}/projects/{id}/ensure`（幂等启动），返回 A2A 端点 */
async function ensureProject(machine: MachineRef, projectId: string): Promise<EnsureOutcome> {
  const protocol = await ensureProtocol(machine);
  if (!protocol.ok) {
    return { ok: false, code: protocol.code, error: protocol.error };
  }
  const url = `${trimTrailingSlash(machine.launcherUrl)}/projects/${encodeURIComponent(projectId)}/ensure`;
  const res = await fetchJson(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({}),
    },
    LAUNCHER_ENSURE_TIMEOUT_MS,
  );
  if (!res.ok) {
    return {
      ok: false,
      code: "ensure_failed",
      error: `ensure ${projectId}@${machine.machineId} 失败（${res.status}）：${res.error}`,
    };
  }
  const o = asRecord(res.data);
  const endpoint = o === null ? null : asNonEmptyString(o["endpoint"]);
  if (endpoint === null) {
    return {
      ok: false,
      code: "ensure_bad_response",
      error: `ensure ${projectId}@${machine.machineId} 响应缺少 endpoint`,
    };
  }
  const started = o !== null && o["started"] === true;
  return { ok: true, endpoint, started };
}

// ---------------------------------------------------------------------------
// A2A Client（@a2a-js/sdk v1.1.0）
// ---------------------------------------------------------------------------

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function fetchWithDefaultTimeout(timeoutMs: number): FetchFn {
  return (input, init) =>
    fetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
}

async function createA2AClient(endpoint: string): Promise<Client> {
  const factory = new ClientFactory({
    transports: [
      new JsonRpcTransportFactory({
        fetchImpl: fetchWithDefaultTimeout(A2A_REQUEST_TIMEOUT_MS),
        legacyCompat: { enabled: true },
      }),
      new RestTransportFactory({
        fetchImpl: fetchWithDefaultTimeout(A2A_REQUEST_TIMEOUT_MS),
        legacyCompat: { enabled: true },
      }),
    ],
    clientConfig: {
      polling: true,
      acceptedOutputModes: ["text/plain", "application/json"],
    },
    cardResolver: new DefaultAgentCardResolver({
      fetchImpl: fetchWithDefaultTimeout(A2A_CARD_TIMEOUT_MS),
      legacyCompat: { enabled: true },
    }),
  });
  return factory.createFromUrl(endpoint);
}

// ---------------------------------------------------------------------------
// A2A 结果处理
// ---------------------------------------------------------------------------

type ArtifactPartSummary =
  | { kind: "text"; text: string; mediaType: string }
  | { kind: "data"; data: unknown; mediaType: string }
  | { kind: "url"; url: string; filename: string; mediaType: string }
  | { kind: "raw"; bytes: number; filename: string; mediaType: string };

interface ArtifactSummary {
  artifactId: string;
  name: string;
  description: string;
  parts: ArtifactPartSummary[];
}

function summarizeArtifactPart(part: Part): ArtifactPartSummary | null {
  const content = part.content;
  if (content === undefined) return null;
  switch (content.$case) {
    case "text":
      return { kind: "text", text: content.value, mediaType: part.mediaType };
    case "data": {
      const data: unknown = content.value;
      return { kind: "data", data, mediaType: part.mediaType };
    }
    case "url":
      return {
        kind: "url",
        url: content.value,
        filename: part.filename,
        mediaType: part.mediaType,
      };
    case "raw":
      return {
        kind: "raw",
        bytes: content.value.length,
        filename: part.filename,
        mediaType: part.mediaType,
      };
    default:
      return null;
  }
}

/**
 * wrapper（`@a2a-wrapper/core`）的旁路观测产物，如 `trace.mcp` / `trace.thought` / `trace.delegation`。
 * 这些属于 telemetry，不面向 LLM，不过桥（`summarizeArtifacts` / `taskText` 一律跳过）。
 */
function isTraceArtifact(a: Artifact): boolean {
  return (
    a.name.toLowerCase().startsWith("trace.") || a.artifactId.toLowerCase().startsWith("trace.")
  );
}

function summarizeArtifacts(artifacts: readonly Artifact[]): ArtifactSummary[] {
  const summaries: ArtifactSummary[] = [];
  for (const artifact of artifacts) {
    if (isTraceArtifact(artifact)) continue;
    const parts: ArtifactPartSummary[] = [];
    for (const part of artifact.parts) {
      const summary = summarizeArtifactPart(part);
      if (summary !== null) parts.push(summary);
    }
    summaries.push({
      artifactId: artifact.artifactId,
      name: artifact.name,
      description: artifact.description,
      parts,
    });
  }
  return summaries;
}

function partsToText(parts: readonly Part[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    const content = part.content;
    if (content === undefined) continue;
    switch (content.$case) {
      case "text":
        chunks.push(content.value);
        break;
      case "data": {
        const data: unknown = content.value;
        chunks.push(stringifyUnknown(data));
        break;
      }
      case "url":
        chunks.push(content.value);
        break;
      case "raw":
        break;
      default:
        break;
    }
  }
  return chunks.join("\n");
}

function isTaskResult(result: SendMessageResult): result is Task {
  return "id" in result;
}

function taskStateOf(task: Task): A2aTaskState {
  return task.status?.state ?? A2aTaskState.TASK_STATE_WORKING;
}

function mapTaskState(state: A2aTaskState): DomainTaskState {
  switch (state) {
    case A2aTaskState.TASK_STATE_COMPLETED:
      return "completed";
    case A2aTaskState.TASK_STATE_FAILED:
    case A2aTaskState.TASK_STATE_CANCELED:
    case A2aTaskState.TASK_STATE_REJECTED:
      return "failed";
    case A2aTaskState.TASK_STATE_INPUT_REQUIRED:
    case A2aTaskState.TASK_STATE_AUTH_REQUIRED:
      return "input-required";
    case A2aTaskState.TASK_STATE_UNSPECIFIED:
    case A2aTaskState.TASK_STATE_SUBMITTED:
    case A2aTaskState.TASK_STATE_WORKING:
    case A2aTaskState.UNRECOGNIZED:
    default:
      return "working";
  }
}

function terminalOrInterrupted(state: A2aTaskState): boolean {
  switch (state) {
    case A2aTaskState.TASK_STATE_COMPLETED:
    case A2aTaskState.TASK_STATE_FAILED:
    case A2aTaskState.TASK_STATE_CANCELED:
    case A2aTaskState.TASK_STATE_REJECTED:
    case A2aTaskState.TASK_STATE_INPUT_REQUIRED:
    case A2aTaskState.TASK_STATE_AUTH_REQUIRED:
      return true;
    default:
      return false;
  }
}

function taskText(task: Task): string {
  const statusText =
    task.status?.message === undefined ? "" : partsToText(task.status.message.parts);
  if (statusText.length > 0) return statusText;
  const artifactChunks: string[] = [];
  for (const artifact of task.artifacts) {
    if (isTraceArtifact(artifact)) continue;
    const text = partsToText(artifact.parts);
    if (text.length > 0) artifactChunks.push(text);
  }
  return artifactChunks.join("\n\n");
}

/**
 * 本地记录是否已终结（终结态结果由本地存档直接作答，不再查询远端）。
 * `blocked` 为 orch 本地专属终态（v0.4.0 失败传播，不映射 A2A）：被阻塞节点不会再派发，
 * 直接以本地存档作答，避免误查远端。
 */
function isLocalTerminalState(state: DomainTaskState): boolean {
  return (
    state === "completed" || state === "failed" || state === "input-required" || state === "blocked"
  );
}

/** 从本地存档的 artifactsJson（ArtifactSummary[]）拼接文本；规则对齐 partsToText/taskText，兼容无 text 的旧记录 */
function textFromArchivedArtifacts(artifactsJson: string | null): string {
  if (artifactsJson === null) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifactsJson);
  } catch {
    return "";
  }
  if (!Array.isArray(parsed)) return "";
  const chunks: string[] = [];
  for (const artifact of parsed) {
    const o = asRecord(artifact);
    if (o === null) continue;
    const parts = o["parts"];
    if (!Array.isArray(parts)) continue;
    const partChunks: string[] = [];
    for (const part of parts) {
      const p = asRecord(part);
      if (p === null) continue;
      const kind = p["kind"];
      if (kind === "text" && typeof p["text"] === "string") partChunks.push(p["text"]);
      else if (kind === "data") partChunks.push(stringifyUnknown(p["data"]));
      else if (kind === "url" && typeof p["url"] === "string") partChunks.push(p["url"]);
      // raw：与 partsToText 一致，跳过二进制
    }
    const text = partChunks.join("\n");
    if (text.length > 0) chunks.push(text);
  }
  return chunks.join("\n\n");
}

/** 解析本地归档 `artifactsJson`（ArtifactSummary[]）；缺省 / 非法返回 [] */
function parseArchivedArtifacts(artifactsJson: string | null): ArtifactSummary[] {
  if (artifactsJson === null) return [];
  try {
    const parsed: unknown = JSON.parse(artifactsJson);
    return Array.isArray(parsed) ? (parsed as ArtifactSummary[]) : [];
  } catch {
    return [];
  }
}

/** 同步预算到点的 working 返回文案：指引轮询 + 中断恢复路径 */
function workingGuidanceText(taskId: string, contextId: string): string {
  return `任务仍在执行中。请用 a2a_task_status(taskId="${taskId}") 轮询结果；不要重复 a2a_call（同一任务会重复执行）。若任务因 agent 回收而中断，可携带同 contextId（${contextId}）调用 a2a_call 续接会话继续。`;
}

function buildSendRequest(
  text: string,
  contextId: string,
  push: { url: string; token: string } | null,
): SendMessageRequest {
  const message: Message = {
    messageId: randomUUID(),
    contextId,
    taskId: "",
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: "text", value: text },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      },
    ],
    // 会话由包装器按 contextId 持有，桥不携带 sessionId 元数据
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
  return {
    tenant: "",
    message,
    configuration: {
      acceptedOutputModes: ["text/plain", "application/json"],
      // v0.4.0 §2.6：按 opt-in 内联注册回调（内联注册时 taskId 必须为空，A2A 规范）
      taskPushNotificationConfig:
        push === null
          ? undefined
          : {
              tenant: "",
              id: randomUUID(),
              taskId: "",
              url: push.url,
              token: push.token,
              authentication: undefined,
            },
      returnImmediately: true,
    },
    metadata: undefined,
  };
}

/** 在同步预算内轮询 `tasks/get` 直至终止/中断态；超时返回最后已知状态 */
async function pollTaskUntilSettled(
  client: Client,
  initial: Task,
  deadline: number,
  renew?: () => Promise<void>,
): Promise<Task> {
  let current = initial;
  let lastRenewedAt = Date.now();
  while (Date.now() < deadline) {
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (renew !== undefined && Date.now() - lastRenewedAt >= LEASE_RENEW_INTERVAL_MS) {
      try {
        await renew();
      } catch (err) {
        // 续期失败不打断轮询：保留最后已知状态，launcher 侧空闲计时最多按原策略回收
        console.error(`[a2a-bridge] lease renew failed: ${toMessage(err)}`);
      }
      lastRenewedAt = Date.now();
    }
    try {
      current = await client.getTask(
        { tenant: "", id: initial.id, historyLength: undefined },
        { signal: AbortSignal.timeout(Math.min(A2A_REQUEST_TIMEOUT_MS, remaining)) },
      );
    } catch {
      break; // 保留最后已知状态，返回 taskId 供后续轮询
    }
    if (terminalOrInterrupted(taskStateOf(current))) break;
  }
  return current;
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

interface CallSuccess {
  ok: true;
  text: string;
  artifacts: ArtifactSummary[];
  taskId?: string;
  status: DomainTaskState;
  /** 本轮的 A2A 上下文 ID（省略入参时自动生成；续接同一上下文时回传复用） */
  contextId: string;
}

interface Failure {
  ok: false;
  code: string;
  error: string;
  contextId?: string;
}

type CallOutcome = CallSuccess | Failure;

/**
 * 落库 working + 启动后台看护（轮询 + 续约至终态并落库）+ 返回 working 指引。
 * 半异步（wait=true 且同步预算耗尽）与全异步（wait=false 且未终态）共用。
 * `promptText` 为派发时的原始 prompt（落库截断，REQ-02 联动）；`reason` 仅用于日志。
 */
function deferWorkingTask(
  client: Client,
  machine: MachineRef,
  projectId: string,
  promptText: string,
  settled: Task,
  contextId: string,
  reason: string,
): CallSuccess {
  createTask({
    taskId: settled.id,
    projectId,
    contextId,
    state: "working",
    artifactsJson: JSON.stringify(summarizeArtifacts(settled.artifacts)),
    text: null,
    prompt: truncatePrompt(promptText),
  });
  const started = startTaskWatcher({
    taskId: settled.id,
    poll: () =>
      client.getTask(
        { tenant: "", id: settled.id, historyLength: undefined },
        { signal: AbortSignal.timeout(A2A_REQUEST_TIMEOUT_MS) },
      ),
    renew: async () => {
      await ensureProject(machine, projectId);
    },
    isSettled: (task) => terminalOrInterrupted(taskStateOf(task)),
    persist: (task) => {
      const state = mapTaskState(taskStateOf(task));
      updateTaskState(
        task.id,
        state,
        JSON.stringify(summarizeArtifacts(task.artifacts)),
        taskText(task),
      );
      console.log(`[a2a-bridge] 后台看护：任务 ${task.id} 已终态（${state}），结果落库`);
    },
    // v0.4.0 §2.6：可选订阅推送（命中即提前对账；无推送时与纯轮询等价）
    subscribePush: true,
    pollIntervalMs: POLL_INTERVAL_MS,
    renewIntervalMs: LEASE_RENEW_INTERVAL_MS,
    maxConsecutiveFailures: WATCHER_MAX_CONSECUTIVE_FAILURES,
  });
  if (started) {
    console.log(`[a2a-bridge] 任务 ${settled.id} ${reason}，转后台看护`);
  }
  return {
    ok: true,
    text: workingGuidanceText(settled.id, contextId),
    artifacts: [],
    taskId: settled.id,
    status: "working",
    contextId,
  };
}

/**
 * 可复用派发：解析项目→机器 → 幂等 ensure → 建 A2A client → `message/send`；
 * `wait=true` 时在同步预算内轮询至终态/中断态。**不落库、不启动看护**——
 * 由调用方决定持久化方式（独立任务用远端 taskId；Feature 节点用本地 id + 调度器看护）。
 * 供 `a2a_call`（MCP 工具）与 Feature 调度器（`dispatchFeatureNode`）共用。
 */
type DispatchOutcome =
  | { ok: false; code: string; error: string; contextId: string }
  | { ok: true; contextId: string; kind: "message"; text: string }
  | {
      ok: true;
      contextId: string;
      kind: "task";
      task: Task;
      client: Client;
      machine: MachineRef;
    };

async function dispatchTask(
  projectId: string,
  text: string,
  contextId: string,
  wait: boolean,
): Promise<DispatchOutcome> {
  const located = await locateProject(projectId);
  if (!located.ok) {
    return { ok: false, code: located.code, error: located.error, contextId };
  }
  const ensured = await ensureProject(located.machine, projectId);
  if (!ensured.ok) {
    return { ok: false, code: ensured.code, error: ensured.error, contextId };
  }

  let client: Client;
  try {
    client = await createA2AClient(ensured.endpoint);
  } catch (err) {
    return {
      ok: false,
      code: "a2a_client_init_failed",
      error: `连接 A2A 端点 ${ensured.endpoint} 失败：${toMessage(err)}`,
      contextId,
    };
  }

  let result: SendMessageResult;
  try {
    result = await client.sendMessage(
      buildSendRequest(text, contextId, pushCallbackFor(located.machine)),
      {
        signal: AbortSignal.timeout(A2A_REQUEST_TIMEOUT_MS),
      },
    );
  } catch (err) {
    return {
      ok: false,
      code: "a2a_send_failed",
      error: `A2A message/send 失败：${toMessage(err)}`,
      contextId,
    };
  }

  if (!isTaskResult(result)) {
    return { ok: true, contextId, kind: "message", text: partsToText(result.parts) };
  }

  let settled = result;
  if (wait && !terminalOrInterrupted(taskStateOf(result))) {
    settled = await pollTaskUntilSettled(client, result, Date.now() + SYNC_BUDGET_MS, async () => {
      await ensureProject(located.machine, projectId);
    });
  }
  return { ok: true, contextId, kind: "task", task: settled, client, machine: located.machine };
}

async function handleCall(
  projectId: string,
  text: string,
  contextIdInput: string | undefined,
  wait: boolean,
): Promise<CallOutcome> {
  const contextId =
    contextIdInput !== undefined && contextIdInput.length > 0 ? contextIdInput : randomUUID();

  const sent = await dispatchTask(projectId, text, contextId, wait);
  if (!sent.ok) {
    return { ok: false, code: sent.code, error: sent.error, contextId };
  }
  if (sent.kind === "message") {
    // 对端直接返回 Message（非 Task）：视为一次完成的交互
    return { ok: true, text: sent.text, artifacts: [], status: "completed", contextId };
  }

  const { task, client, machine } = sent;
  // 未终态 —— 落库 working、启动后台看护、立即返回句柄
  if (!terminalOrInterrupted(taskStateOf(task))) {
    return deferWorkingTask(
      client,
      machine,
      projectId,
      text,
      task,
      contextId,
      wait ? `超出同步预算（${SYNC_BUDGET_MS}ms）` : "全异步（wait=false）",
    );
  }

  // 终态：如实落库并返回真实终态
  const status = mapTaskState(taskStateOf(task));
  const artifacts = summarizeArtifacts(task.artifacts);
  createTask({
    taskId: task.id,
    projectId,
    contextId,
    state: status,
    artifactsJson: JSON.stringify(artifacts),
    text: taskText(task),
    prompt: truncatePrompt(text),
  });
  return {
    ok: true,
    text: taskText(task),
    artifacts,
    taskId: task.id,
    status,
    contextId,
  };
}

// ---------------------------------------------------------------------------
// Feature 编排接线（v0.3.0 登记 + 调度器派发；v0.4.0 Context / 上游产物注入）
// ---------------------------------------------------------------------------

/** 产物摘要各 part 中首个非空 mediaType（无则 null） */
function firstPartMime(parts: readonly ArtifactPartSummary[]): string | null {
  for (const part of parts) {
    if (typeof part.mediaType === "string" && part.mediaType.length > 0) return part.mediaType;
  }
  return null;
}

/** 产物摘要各 part 中首个 url（内容引用；无则 null） */
function artifactUriOf(parts: readonly ArtifactPartSummary[]): string | null {
  for (const part of parts) {
    if (part.kind === "url" && part.url.length > 0) return part.url;
  }
  return null;
}

/** 产物摘要各 part 中首个 raw 字节数（其余 kind 无字节语义；无则 null） */
function artifactSizeOf(parts: readonly ArtifactPartSummary[]): number | null {
  for (const part of parts) {
    if (part.kind === "raw") return part.bytes;
  }
  return null;
}

/**
 * 把一次 settle 的产物摘要登记为 `artifacts` 行（v0.4.0 §2.3）。
 * 主键 `${producerTaskId}:${remoteArtifactId}` 避免跨任务 id 冲突；登记 best-effort，
 * 单条失败只记日志、不阻断任务落库。
 */
function registerArtifacts(
  featureId: string,
  producerTaskId: string,
  artifacts: readonly ArtifactSummary[],
): void {
  for (const artifact of artifacts) {
    const artifactId = `${producerTaskId}:${artifact.artifactId}`;
    try {
      upsertArtifact({
        artifactId,
        featureId,
        producerTaskId,
        name: artifact.name.length > 0 ? artifact.name : artifact.artifactId,
        mime: firstPartMime(artifact.parts),
        uri: artifactUriOf(artifact.parts),
        size: artifactSizeOf(artifact.parts),
        contentHash: null,
      });
    } catch (err) {
      console.error(`[a2a-bridge] 产物登记失败（${artifactId}）：${toMessage(err)}`);
    }
  }
}

/** 内联内容按上限截断（大产物仅保留头部 + 截断说明，完整内容按 uri 引用） */
function truncateInline(text: string): string {
  if (text.length <= ARTIFACT_INLINE_MAX_CHARS) return text;
  return `${text.slice(0, ARTIFACT_INLINE_MAX_CHARS)}\n…（已截断，全文 ${text.length} 字符，完整内容见 uri 引用）`;
}

/** 把归档产物摘要的 parts 拼为可注入文本（text/data 内联；url/raw 以引用形式） */
function artifactContentText(parts: readonly ArtifactPartSummary[]): string | null {
  const chunks: string[] = [];
  for (const part of parts) {
    switch (part.kind) {
      case "text":
        chunks.push(truncateInline(part.text));
        break;
      case "data":
        chunks.push(truncateInline(stringifyUnknown(part.data)));
        break;
      case "url":
        chunks.push(`（引用）${part.url}`);
        break;
      case "raw":
        chunks.push(
          `（二进制产物 ${part.filename.length > 0 ? part.filename : "artifact"}，${part.bytes} 字节，见 uri 引用）`,
        );
        break;
    }
  }
  return chunks.length === 0 ? null : chunks.join("\n");
}

interface ResolvedInputArtifact {
  ref: InputArtifactRef;
  record: ArtifactRecord | null;
}

/**
 * 把单条输入引用展开为已登记的产物行：
 * - `artifactId` 直指（命中全键，或按 `:${artifactId}` 后缀匹配）；
 * - `producerTaskId`（+可选 `name`）按生产节点匹配，未给 name 时展开其全部产物；
 * - 未命中以 `record: null` 占位，注入时如实说明。
 */
function resolveArtifactRefs(
  refs: readonly InputArtifactRef[],
  featureId: string,
): ResolvedInputArtifact[] {
  const out: ResolvedInputArtifact[] = [];
  for (const ref of refs) {
    const artifactId = ref.artifactId;
    if (artifactId !== undefined && artifactId.length > 0) {
      const direct = getArtifact(artifactId);
      if (direct !== null) {
        out.push({ ref, record: direct });
        continue;
      }
      const suffix = `:${artifactId}`;
      const hit = listArtifactsByFeature(featureId, 1000).find((a) =>
        a.artifactId.endsWith(suffix),
      );
      out.push({ ref, record: hit ?? null });
      continue;
    }
    const producerTaskId = ref.producerTaskId;
    if (producerTaskId !== undefined && producerTaskId.length > 0) {
      const produced = listArtifactsByProducer(producerTaskId, 1000);
      const name = ref.name;
      const filtered =
        name !== undefined && name.length > 0 ? produced.filter((a) => a.name === name) : produced;
      if (filtered.length === 0) {
        out.push({ ref, record: null });
        continue;
      }
      for (const record of filtered) out.push({ ref, record });
      continue;
    }
    out.push({ ref, record: null });
  }
  return out;
}

/** 未命中产物时的引用描述（供注入段如实说明） */
function describeArtifactRef(ref: InputArtifactRef): string {
  if (ref.artifactId !== undefined && ref.artifactId.length > 0) {
    return `artifactId=${ref.artifactId}`;
  }
  const parts: string[] = [];
  if (ref.producerTaskId !== undefined) parts.push(`producerTaskId=${ref.producerTaskId}`);
  if (ref.name !== undefined) parts.push(`name=${ref.name}`);
  return parts.length > 0 ? parts.join(", ") : "(空引用)";
}

/**
 * 渲染一条已登记产物：元信息（来源 / mediaType / size / uri）+ 尽力从生产节点归档摘要
 * 取回内容（按 `artifact_id` 全键或 `name` 匹配），大文本按 `ARTIFACT_INLINE_MAX_CHARS` 截断。
 */
function renderRegisteredArtifact(record: ArtifactRecord, producer: TaskRecord | null): string {
  const meta: string[] = [`来自上游任务 ${record.producerTaskId}`];
  if (record.mime !== null) meta.push(`mediaType ${record.mime}`);
  if (record.size !== null) meta.push(`size ${record.size}`);
  if (record.uri !== null) meta.push(`uri ${record.uri}`);
  const header = `### ${record.name}（${meta.join("，")}）`;
  if (producer === null || producer.artifactsJson === null) return header;
  const prefix = `${record.producerTaskId}:`;
  const summaries = parseArchivedArtifacts(producer.artifactsJson);
  const match = summaries.find(
    (s) => `${prefix}${s.artifactId}` === record.artifactId || s.name === record.name,
  );
  if (match === undefined) return header;
  const content = artifactContentText(match.parts);
  return content === null ? header : `${header}\n${content}`;
}

/** 解析节点 `inputArtifacts` 并拼为 `<input-artifacts>` 段；无引用返回 null */
function renderInputArtifacts(node: TaskRecord): string | null {
  const refs = node.inputArtifacts;
  const featureId = node.featureId;
  if (refs === null || refs.length === 0 || featureId === null) return null;
  const resolved = resolveArtifactRefs(refs, featureId);
  if (resolved.length === 0) return null;
  const sections: string[] = [];
  for (const item of resolved) {
    if (item.record === null) {
      sections.push(
        `### 未找到产物（${describeArtifactRef(item.ref)}）\n（上游未完成或产物尚未登记）`,
      );
      continue;
    }
    sections.push(renderRegisteredArtifact(item.record, getTask(item.record.producerTaskId)));
  }
  return `<input-artifacts>\n${sections.join("\n\n")}\n</input-artifacts>`;
}

/** 渲染 Feature Context（plan / decisions / contracts）为 `<feature-context>` 段；全空返回 null */
function renderFeatureContext(feature: FeatureRecord): string | null {
  const sections: string[] = [];
  if (feature.plan !== null && feature.plan.length > 0) {
    sections.push(`## 统一方案（plan）\n${feature.plan}`);
  }
  if (feature.decisions !== null && feature.decisions.length > 0) {
    sections.push(`## 决策记录（decisions）\n${feature.decisions}`);
  }
  if (feature.contracts !== null && feature.contracts.length > 0) {
    sections.push(`## 契约（contracts）\n${feature.contracts}`);
  }
  if (sections.length === 0) return null;
  return `<feature-context>\n${sections.join("\n\n")}\n</feature-context>`;
}

/**
 * 组合节点派发消息：Feature Context + 上游产物输入段（若有）+ 原派发消息。
 * 无任何注入内容时与原消息逐字一致（保证既有行为不变）。
 */
function buildNodeDispatchMessage(node: TaskRecord, feature: FeatureRecord | null): string {
  const base = node.dispatchMessage ?? node.prompt ?? "";
  const blocks: string[] = [];
  if (feature !== null) {
    const context = renderFeatureContext(feature);
    if (context !== null) blocks.push(context);
  }
  const inputs = renderInputArtifacts(node);
  if (inputs !== null) blocks.push(inputs);
  if (blocks.length === 0) return base;
  return `${blocks.join("\n\n")}\n\n---\n\n${base}`;
}

/**
 * `a2a_call` 带 `featureId` —— 登记一个 Feature DAG 节点（本地 id），
 * 不立即派发；由调度器在依赖满足后按拓扑并行派发（每 Feature 批门闩）。
 * `analyzing`（分析扇出）/ `executing` 的 Feature 均可挂载任务；
 * `dependencies` 引用同 Feature 内的本地 taskId；`inputs` 声明本节点引用的上游产物。
 */
function registerFeatureNode(
  projectId: string,
  message: string,
  contextIdInput: string | undefined,
  featureId: string,
  dependencies: readonly string[],
  inputs?: readonly InputArtifactRef[] | undefined,
): CallOutcome {
  const contextId =
    contextIdInput !== undefined && contextIdInput.length > 0 ? contextIdInput : randomUUID();
  const feature = getFeature(featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${featureId}`, contextId };
  }
  if (feature.state !== "analyzing" && feature.state !== "executing") {
    return {
      ok: false,
      code: "feature_state_invalid",
      error: `Feature ${featureId} 当前为 ${feature.state}，仅 analyzing / executing 可挂载任务`,
      contextId,
    };
  }
  const localTaskId = randomUUID();
  const deps = dependencies.length > 0 ? Array.from(new Set(dependencies)) : null;
  const inputRefs = inputs !== undefined && inputs.length > 0 ? Array.from(inputs) : null;
  createTask({
    taskId: localTaskId,
    projectId,
    contextId,
    state: "working",
    // prompt 保留截断片段用于辨识；dispatchMessage 存全文供调度器派发
    prompt: message,
    featureId,
    dependencies: deps,
    inputArtifacts: inputRefs,
    dispatchMessage: message,
  });
  scheduler.kick();
  return {
    ok: true,
    text:
      `已登记 Feature 任务节点，调度器将在依赖满足后自动派发（无需人工催办）：` +
      `taskId=${localTaskId}，featureId=${featureId}，依赖=${deps === null ? "无" : deps.join(", ")}。` +
      `用 a2a_feature_status(featureId="${featureId}") 查看进度。`,
    artifacts: [],
    taskId: localTaskId,
    status: "working",
    contextId,
  };
}

/**
 * 远端 A2A 任务 id → 本地 Feature 节点 id（v0.4.0 §2.6 回调回写用）。
 * 回调只携带远端 id，而 Feature 节点本地 id 与远端不同（独立任务二者相同）；
 * 进程内映射，桥重启后靠轮询对账兜底（推送配置本身亦为 worker 端 in-memory）。
 */
const remoteTaskIndex = new Map<string, string>();

/**
 * 调度器注入的节点派发：派发前注入 Feature Context（plan/decisions/contracts）与已完成上游
 * 产物（`inputArtifacts`），复用 `dispatchTask` 派发节点消息，落库远端 id，未终态转后台看护
 * （`onSettled` 回调调度器续推 DAG）；settle 时把 `summarizeArtifacts` 登记为 `artifacts` 行。
 */
async function dispatchFeatureNode(node: TaskRecord): Promise<FeatureDispatchResult> {
  const featureId = node.featureId;
  if (featureId === null) {
    return { ok: false, error: `任务 ${node.taskId} 无 Feature 归属` };
  }
  const feature = getFeature(featureId);
  const message = buildNodeDispatchMessage(node, feature);

  const sent = await dispatchTask(node.projectId, message, node.contextId, true);
  if (!sent.ok) {
    return { ok: false, error: sent.error };
  }
  if (sent.kind === "message") {
    updateTaskState(node.taskId, "completed", null, sent.text);
    return { ok: true, settled: { state: "completed", text: sent.text } };
  }

  const { task, client, machine } = sent;
  const remoteTaskId = task.id;
  const state = mapTaskState(taskStateOf(task));
  // 回调回写映射：远端 id → 本地节点 id（推送只带远端 id）
  remoteTaskIndex.set(remoteTaskId, node.taskId);

  // 远端已终态：登记产物 + 直接落库
  if (terminalOrInterrupted(taskStateOf(task))) {
    const artifacts = summarizeArtifacts(task.artifacts);
    registerArtifacts(featureId, node.taskId, artifacts);
    updateTaskState(node.taskId, state, JSON.stringify(artifacts), taskText(task));
    markTaskDispatched(node.taskId, remoteTaskId);
    return { ok: true, settled: { state, text: taskText(task) } };
  }

  // 未终态：回填远端 id + 转后台看护（看护终态/放弃均经 onSettled 续推 DAG）
  markTaskDispatched(node.taskId, remoteTaskId);
  const started = startTaskWatcher({
    taskId: node.taskId,
    poll: () =>
      client.getTask(
        { tenant: "", id: remoteTaskId, historyLength: undefined },
        { signal: AbortSignal.timeout(A2A_REQUEST_TIMEOUT_MS) },
      ),
    renew: async () => {
      await ensureProject(machine, node.projectId);
    },
    isSettled: (task) => terminalOrInterrupted(taskStateOf(task)),
    persist: (task) => {
      const st = mapTaskState(taskStateOf(task));
      const artifacts = summarizeArtifacts(task.artifacts);
      registerArtifacts(featureId, node.taskId, artifacts);
      updateTaskState(node.taskId, st, JSON.stringify(artifacts), taskText(task));
      console.log(
        `[a2a-bridge] Feature 节点 ${node.taskId}（远端 ${remoteTaskId}）已终态（${st}）`,
      );
    },
    onSettled: (task, outcome) => {
      // 看护放弃路径：本地置 failed 并令 Feature failed
      if (outcome.abandoned || task === null) {
        updateTaskState(node.taskId, "failed", null, FEATURE_ABANDONED_TEXT);
        scheduler.notifyTaskSettled(featureId, node.taskId, { state: "failed", text: null });
        return;
      }
      scheduler.notifyTaskSettled(featureId, node.taskId, {
        state: mapTaskState(taskStateOf(task)),
        text: taskText(task),
      });
    },
    // v0.4.0 §2.6：可选订阅推送（命中即提前对账；无推送时与纯轮询等价）
    subscribePush: true,
    pollIntervalMs: POLL_INTERVAL_MS,
    renewIntervalMs: LEASE_RENEW_INTERVAL_MS,
    maxConsecutiveFailures: WATCHER_MAX_CONSECUTIVE_FAILURES,
  });
  if (started) {
    console.log(
      `[a2a-bridge] Feature 节点 ${node.taskId} 已派发（远端 ${remoteTaskId}），转后台看护`,
    );
  }
  return { ok: true };
}

/** 进程级调度器（生命周期随桥进程；main() 启动循环 + 恢复） */
const scheduler = new FeatureScheduler({
  dispatch: (node) => dispatchFeatureNode(node),
});

interface TaskStatusSuccess {
  ok: true;
  taskId: string;
  status: DomainTaskState;
  text: string;
  artifacts: ArtifactSummary[];
  updatedAt: string;
}

type TaskStatusOutcome = TaskStatusSuccess | (Failure & { task?: TaskRecord });

async function handleTaskStatus(taskId: string): Promise<TaskStatusOutcome> {
  const record = getTask(taskId);
  if (record === null) {
    return {
      ok: false,
      code: "task_not_found",
      error: `未知任务 ${taskId}（本地任务存储无记录）`,
    };
  }

  // 本地快路径：终结态结果是最终事实（落库时已 settle），直接以本地存档作答；
  // 不 ensure、不碰远端——远端任务态不持久化（agent 回收后重 ensure 是新进程，只会 Task not found）
  if (isLocalTerminalState(record.state)) {
    const artifacts = parseArchivedArtifacts(record.artifactsJson);
    return {
      ok: true,
      taskId,
      status: record.state,
      text: record.text ?? textFromArchivedArtifacts(record.artifactsJson),
      artifacts,
      updatedAt: record.updatedAt,
    };
  }

  const located = await locateProject(record.projectId);
  if (!located.ok) {
    return { ok: false, code: located.code, error: located.error, task: record };
  }
  const ensured = await ensureProject(located.machine, record.projectId);
  if (!ensured.ok) {
    return { ok: false, code: ensured.code, error: ensured.error, task: record };
  }

  let client: Client;
  try {
    client = await createA2AClient(ensured.endpoint);
  } catch (err) {
    return {
      ok: false,
      code: "a2a_client_init_failed",
      error: `连接 A2A 端点 ${ensured.endpoint} 失败：${toMessage(err)}`,
      task: record,
    };
  }

  try {
    const task = await client.getTask(
      { tenant: "", id: taskId, historyLength: undefined },
      { signal: AbortSignal.timeout(A2A_REQUEST_TIMEOUT_MS) },
    );
    const status = mapTaskState(taskStateOf(task));
    const artifacts = summarizeArtifacts(task.artifacts);
    updateTaskState(taskId, status, JSON.stringify(artifacts), taskText(task));
    return {
      ok: true,
      taskId,
      status,
      text: taskText(task),
      artifacts,
      updatedAt: nowIso(),
    };
  } catch (err) {
    return {
      ok: false,
      code: "a2a_get_task_failed",
      error: `A2A tasks/get 失败：${toMessage(err)}。任务可能已随 agent 回收而中断；可携带同 contextId（${record.contextId}）调用 a2a_call 续接会话继续。`,
      task: record,
    };
  }
}

type CancelOutcome =
  | {
      ok: true;
      taskId: string;
      status: DomainTaskState;
      text: string;
      artifacts: ArtifactSummary[];
      updatedAt: string;
    }
  | (Failure & { task?: TaskRecord });

async function handleCancel(taskId: string): Promise<CancelOutcome> {
  const record = getTask(taskId);
  if (record === null) {
    return {
      ok: false,
      code: "task_not_found",
      error: `未知任务 ${taskId}（本地任务存储无记录）`,
    };
  }
  const located = await locateProject(record.projectId);
  if (!located.ok) {
    return { ok: false, code: located.code, error: located.error, task: record };
  }
  const ensured = await ensureProject(located.machine, record.projectId);
  if (!ensured.ok) {
    return { ok: false, code: ensured.code, error: ensured.error, task: record };
  }

  let client: Client;
  try {
    client = await createA2AClient(ensured.endpoint);
  } catch (err) {
    return {
      ok: false,
      code: "a2a_client_init_failed",
      error: `连接 A2A 端点 ${ensured.endpoint} 失败：${toMessage(err)}`,
      task: record,
    };
  }

  try {
    const task = await client.cancelTask(
      { tenant: "", id: taskId, metadata: undefined },
      { signal: AbortSignal.timeout(A2A_REQUEST_TIMEOUT_MS) },
    );
    const status = mapTaskState(taskStateOf(task));
    const artifacts = summarizeArtifacts(task.artifacts);
    updateTaskState(taskId, status, JSON.stringify(artifacts), taskText(task));
    return {
      ok: true,
      taskId,
      status,
      text: taskText(task),
      artifacts,
      updatedAt: nowIso(),
    };
  } catch (err) {
    return {
      ok: false,
      code: "a2a_cancel_failed",
      error: `A2A tasks/cancel 失败：${toMessage(err)}`,
      task: record,
    };
  }
}

interface MachinesView {
  machines: Array<{
    machineId: string;
    projects: ProjectStatus[];
    error?: string;
  }>;
}

function isFailure(v: MachinesView | Failure): v is Failure {
  return "ok" in v && v.ok === false;
}

async function handleProjects(): Promise<MachinesView | Failure> {
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error };
  }
  const entries = await Promise.all(
    config.machines.map(async (machine) => {
      const listed = await listMachineProjects(machine);
      if (listed.ok) {
        return { machineId: machine.machineId, projects: listed.projects };
      }
      return { machineId: machine.machineId, projects: [], error: listed.error };
    }),
  );
  return { machines: entries };
}

interface TasksView {
  ok: true;
  projectId: string;
  reachable: boolean;
  notice?: string;
  tasks: TaskListItem[];
}

/**
 * 按项目列出本地任务记录（纯本地 + 只读探测）。
 * 绝不 `ensureProject`（避免「列个表就把 Agent 拉起」）；`stale` 判定仅用本地看护信号 +
 * 一次只读可达性探测（`locateProject`：`/health` + `/projects`），不做逐任务远端查询。
 */
async function handleTasks(
  projectId: string,
  state?: DomainTaskState,
  limit?: number,
): Promise<TasksView | Failure> {
  try {
    pruneTasks();
  } catch (err) {
    console.error(`[a2a-bridge] 任务保留策略清理失败：${toMessage(err)}`);
  }

  const records = listTasks({ projectId, state, limit });

  let reachable = true;
  let notice: string | undefined;
  if (records.some((r) => r.state === "working")) {
    const located = await locateProject(projectId);
    reachable = located.ok && located.project.status === "online";
    if (!located.ok) {
      notice = located.error;
    } else if (!reachable) {
      notice = `项目 ${projectId} 当前非在线（status=offline）`;
    }
  }

  const tasks: TaskListItem[] = records.map((record) => ({
    taskId: record.taskId,
    contextId: record.contextId,
    state: record.state,
    prompt: record.prompt,
    text: record.text ?? textFromArchivedArtifacts(record.artifactsJson),
    artifacts: parseArchivedArtifacts(record.artifactsJson),
    updatedAt: record.updatedAt,
    stale: record.state === "working" && (!reachable || !isTaskWatched(record.taskId)),
  }));

  const view: TasksView = { ok: true, projectId, reachable, tasks };
  if (notice !== undefined) view.notice = notice;
  return view;
}

// ---------------------------------------------------------------------------
// 事件收件箱（v0.4.0 §2.6：a2a_events / a2a_wait）
// ---------------------------------------------------------------------------

/** 进程内读游标（`since` 省略时以它为起点；进程重启回落库内最大 `eventId`） */
let eventsCursor: number | null = null;

/** 取当前游标（首次读取时按库内最大 `eventId` 初始化） */
function currentEventsCursor(): number {
  if (eventsCursor === null) eventsCursor = latestEventId();
  return eventsCursor;
}

/** 推进游标（只前进不回退） */
function advanceEventsCursor(cursor: number): void {
  eventsCursor = Math.max(currentEventsCursor(), cursor);
}

/** 长轮询订阅者（事件写入时经 `signalEvents` 唤醒，避免空等到超时） */
const eventWaiters = new Set<() => void>();

/** 唤醒全部 `a2a_wait` 订阅者 */
function signalEvents(): void {
  if (eventWaiters.size === 0) return;
  const waiters = Array.from(eventWaiters);
  eventWaiters.clear();
  for (const wake of waiters) {
    try {
      wake();
    } catch (err) {
      console.error(`[a2a-bridge] 事件订阅唤醒异常：${toMessage(err)}`);
    }
  }
}

/** 注册一次性唤醒（定时或 `signalEvents` 唤醒，取先到者） */
function waitForSignal(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      eventWaiters.delete(wake);
      resolve();
    };
    const wake = (): void => done();
    const timer = setTimeout(done, timeoutMs);
    eventWaiters.add(wake);
  });
}

interface EventsOutcome {
  ok: true;
  cursor: number;
  count: number;
  events: EventRecord[];
}

interface WaitOutcome extends EventsOutcome {
  timedOut: boolean;
}

/** 读取 `events` 增量；无变化时以 `latestEventId()` 廉价空返回（不查 events 表） */
function handleEvents(since?: number): EventsOutcome {
  const cursor = since === undefined ? currentEventsCursor() : Math.max(since, 0);
  if (latestEventId() <= cursor) {
    advanceEventsCursor(cursor);
    return { ok: true, cursor, count: 0, events: [] };
  }
  const events = listEvents({ since: cursor, limit: EVENTS_PAGE_LIMIT });
  const last = events.length > 0 ? (events[events.length - 1]?.eventId ?? cursor) : cursor;
  advanceEventsCursor(last);
  return { ok: true, cursor: eventsCursor ?? last, count: events.length, events };
}

/**
 * 长轮询：等待 `cursor` 之后的新事件，最多 `timeoutMs`（内部 cap < `SYNC_BUDGET_MS`）。
 * 推送路径写入事件时经 `signalEvents()` 立即唤醒；非推送路径（调度器落库）由定时对账兜底。
 */
async function handleWait(timeoutMs?: number): Promise<WaitOutcome> {
  const cursor = currentEventsCursor();
  const waitMs = Math.min(Math.max(timeoutMs ?? EVENT_WAIT_MAX_MS, 0), EVENT_WAIT_MAX_MS);
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (latestEventId() > cursor) {
      const events = listEvents({ since: cursor, limit: EVENTS_PAGE_LIMIT });
      const last = events.length > 0 ? (events[events.length - 1]?.eventId ?? cursor) : cursor;
      advanceEventsCursor(last);
      return {
        ok: true,
        cursor: eventsCursor ?? last,
        count: events.length,
        events,
        timedOut: false,
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: true, cursor, count: 0, events: [], timedOut: true };
    }
    await waitForSignal(Math.min(remaining, EVENT_WAIT_POLL_MS));
  }
}

// ---------------------------------------------------------------------------
// HTTP 事件端点（v0.4.0 §2.6：worker push 回调；默认关、绑 loopback、token 可选）
// ---------------------------------------------------------------------------

/** 事件端点 listener（未启用 / 已关闭时为 null） */
let callbackServer: Server | null = null;

interface PushInfo {
  /** 远端 A2A 任务 id（push 载荷携带） */
  remoteTaskId: string | null;
  /** 远端任务态（A2A 状态串，如 `TASK_STATE_COMPLETED`；无则 null） */
  state: string | null;
}

/** 取 stream 载荷（兼容 `{statusUpdate:…}` 与 `{payload:{statusUpdate:…}}` 两种形态） */
function pickStreamRecord(parsed: unknown): Record<string, unknown> | null {
  const root = asRecord(parsed);
  if (root === null) return null;
  const nested = asRecord(root["payload"]);
  if (
    nested !== null &&
    (nested["task"] !== undefined ||
      nested["statusUpdate"] !== undefined ||
      nested["artifactUpdate"] !== undefined ||
      nested["message"] !== undefined)
  ) {
    return nested;
  }
  return root;
}

function readTaskStateString(container: Record<string, unknown>): string | null {
  const status = asRecord(container["status"]);
  return status === null ? null : asNonEmptyString(status["state"]);
}

/** 解析 push 载荷：定位远端任务 id 与（若有）任务态串 */
function parsePushInfo(parsed: unknown): PushInfo {
  const rec = pickStreamRecord(parsed);
  if (rec === null) return { remoteTaskId: null, state: null };
  const task = asRecord(rec["task"]);
  if (task !== null) {
    return { remoteTaskId: asNonEmptyString(task["id"]), state: readTaskStateString(task) };
  }
  const statusUpdate = asRecord(rec["statusUpdate"]);
  if (statusUpdate !== null) {
    return {
      remoteTaskId: asNonEmptyString(statusUpdate["taskId"]),
      state: readTaskStateString(statusUpdate),
    };
  }
  const artifactUpdate = asRecord(rec["artifactUpdate"]);
  if (artifactUpdate !== null) {
    return { remoteTaskId: asNonEmptyString(artifactUpdate["taskId"]), state: null };
  }
  const message = asRecord(rec["message"]);
  if (message !== null) {
    return { remoteTaskId: asNonEmptyString(message["taskId"]), state: null };
  }
  return { remoteTaskId: null, state: null };
}

/** 由远端 id 定位本地任务（独立任务 `taskId` 即远端 id；Feature 节点查进程内映射） */
function resolveLocalTaskId(remoteOrLocalId: string): string | null {
  if (getTask(remoteOrLocalId) !== null) return remoteOrLocalId;
  return remoteTaskIndex.get(remoteOrLocalId) ?? null;
}

/**
 * 命中本地任务时回写任务态（推送仅作「提前感知」，完整 artifacts/text 由轮询对账补齐）。
 * 只采纳 `completed` / `failed` / `input-required`（`working` 不提前改写；`blocked` 为本地专属）。
 */
function applyPushedTaskState(localTaskId: string, a2aState: string): void {
  let stateEnum: A2aTaskState;
  try {
    stateEnum = taskStateFromJSON(a2aState);
  } catch {
    return; // 未知状态串：忽略，交由轮询对账
  }
  const mapped = mapTaskState(stateEnum);
  if (mapped !== "completed" && mapped !== "failed" && mapped !== "input-required") return;
  const current = getTask(localTaskId);
  if (current === null || isLocalTerminalState(current.state)) return;
  updateTaskState(localTaskId, mapped);
}

/** 处理一次 push：写 `push.received` 事件 + 命中本地任务回写任务态 + 唤醒订阅 + 调度器 kick */
function applyPushNotification(raw: string): { taskId: string | null; localTaskId: string | null } {
  const parsed: unknown = JSON.parse(raw);
  const info = parsePushInfo(parsed);
  const localTaskId = info.remoteTaskId === null ? null : resolveLocalTaskId(info.remoteTaskId);
  const featureId = localTaskId === null ? null : (getTask(localTaskId)?.featureId ?? null);
  appendEvent({
    featureId,
    taskId: info.remoteTaskId,
    kind: EVENT_PUSH_RECEIVED,
    state: info.state,
    payload:
      raw.length > CALLBACK_PAYLOAD_MAX_CHARS ? raw.slice(0, CALLBACK_PAYLOAD_MAX_CHARS) : raw,
  });
  if (localTaskId !== null && info.state !== null) {
    applyPushedTaskState(localTaskId, info.state);
  }
  // 唤醒看护（推送优先，立即对账）+ 唤醒长轮询订阅 + 驱动 Feature 调度
  const wakeKey = localTaskId ?? info.remoteTaskId;
  if (wakeKey !== null) notifyTaskPush(wakeKey);
  signalEvents();
  scheduler.kick();
  return { taskId: info.remoteTaskId, localTaskId };
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readHeaderValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw.length > 0 ? (raw[0] ?? null) : null;
  return raw ?? null;
}

/** 校验回调 token（可选；支持 `X-A2A-Notification-Token` 与 `Authorization: Bearer`） */
function callbackTokenOk(req: IncomingMessage, expected: string): boolean {
  const direct = readHeaderValue(req, "x-a2a-notification-token");
  if (direct !== null && direct.length > 0) return direct === expected;
  const auth = readHeaderValue(req, "authorization");
  if (auth !== null && auth.startsWith("Bearer ")) return auth.slice(7) === expected;
  return false;
}

/** 读取请求体（含字节上限；超限抛错） */
async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > maxBytes) throw new Error(`回调请求体超过上限（${maxBytes} 字节）`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleCallbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: CallbackConfig,
): Promise<void> {
  try {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || path !== "/callback") {
      respondJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    if (cfg.token !== undefined && cfg.token.length > 0 && !callbackTokenOk(req, cfg.token)) {
      respondJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const raw = await readRequestBody(req, CALLBACK_MAX_BODY_BYTES);
    const applied = applyPushNotification(raw);
    respondJson(res, 200, { ok: true, taskId: applied.taskId, localTaskId: applied.localTaskId });
  } catch (err) {
    console.error(`[a2a-bridge] 回调处理失败：${toMessage(err)}`);
    respondJson(res, 400, { ok: false, error: toMessage(err) });
  }
}

/** 是否 loopback 主机（用于绑定告警：跨机回调鉴权待 v0.7.0） */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** 启动 HTTP 事件端点（幂等；`enabled=false` 时不启动） */
function startCallbackServer(cfg: CallbackConfig): void {
  if (!cfg.enabled || callbackServer !== null) return;
  if (!isLoopbackHost(cfg.host)) {
    console.error(
      `[a2a-bridge] 警告：回调端点绑定非 loopback 地址 ${cfg.host}` +
        `（仅同机/受信网络 opt-in；跨机回调鉴权待 v0.7.0）`,
    );
  }
  const server = createServer((req, res) => {
    void handleCallbackRequest(req, res, cfg);
  });
  server.on("error", (err) => {
    console.error(`[a2a-bridge] 回调端点错误：${toMessage(err)}`);
  });
  server.listen(cfg.port, cfg.host, () => {
    console.error(`[a2a-bridge] 回调端点已监听 http://${cfg.host}:${cfg.port}/callback`);
  });
  // 不因 listener 持有进程：桥退出 / shutdown 关闭（规避「桥孤儿进程」）
  if (typeof server.unref === "function") server.unref();
  callbackServer = server;
}

/** 关闭 HTTP 事件端点（幂等；纳入 shutdown / 信号路径） */
function stopCallbackServer(): void {
  const server = callbackServer;
  callbackServer = null;
  if (server === null) return;
  try {
    server.close();
  } catch (err) {
    console.error(`[a2a-bridge] 回调端点关闭失败：${toMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// MCP Server（stdio；固定工具面，5 个泛型工具）
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "a2a-coding-bridge", version: "0.2.0" });

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

function internalError(err: unknown): CallToolResult {
  return errorResult({ ok: false, code: "internal_error", error: toMessage(err) });
}

server.registerTool(
  "a2a_projects",
  {
    description:
      "聚合列出所有已配置机器及其本机项目（含运行态与 A2A 端点）。机器不可达时该项目列表为空并带 error 字段。",
  },
  async () => {
    try {
      const result = await handleProjects();
      return isFailure(result) ? errorResult(result) : textResult(result);
    } catch (err) {
      return internalError(err);
    }
  },
);

server.registerTool(
  "a2a_tasks",
  {
    description:
      "按项目列出本地任务记录（默认按 updatedAt 倒序、默认 20 条）。用于句柄丢失后找回任务；prompt 为落库片段。",
    inputSchema: {
      project: z.string().min(1).describe("目标项目 ID"),
      state: z
        .enum(["working", "completed", "failed", "input-required", "blocked"])
        .optional()
        .describe("按任务态过滤；省略返回全部"),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("返回条数上限，默认 20，最大 100"),
    },
  },
  async (args) => {
    try {
      const outcome = await handleTasks(args.project, args.state, args.limit);
      return "ok" in outcome && outcome.ok === false ? errorResult(outcome) : textResult(outcome);
    } catch (err) {
      return internalError(err);
    }
  },
);

server.registerTool(
  "a2a_call",
  {
    description:
      "向目标项目派发一轮任务：解析项目→机器，按需幂等启动其 Agent（ensure），经 A2A 发送消息并返回文本结果 + artifacts。传入相同 contextId 可续接上下文；返回 contextId 便于继续追问。wait=false 时立即返回句柄（全异步，不进入同步等待）。提供 featureId 时改为登记 Feature DAG 节点（不立即派发），由调度器按 dependencies 串行自动派发。",
    inputSchema: {
      project: z.string().min(1).describe("目标项目 ID（静态分布配置中的 projectId）"),
      message: z.string().min(1).describe("发给执行 Agent 的任务内容"),
      contextId: z
        .string()
        .optional()
        .describe("会话上下文 ID；续接同一上下文时传入，省略则自动新建并在返回中给出"),
      wait: z
        .boolean()
        .optional()
        .describe(
          "true/省略=半异步（同步等待至多 SYNC_BUDGET_MS 再返回）；false=全异步，立即返回 working + taskId + contextId，由后台看护在终态时落库",
        ),
      featureId: z
        .string()
        .optional()
        .describe(
          "挂载到 Feature：提供时任务作为 DAG 节点登记（返回本地 taskId），由调度器在依赖满足后自动串行派发；省略则按现状立即派发。仅 analyzing / executing 的 Feature 可挂载。",
        ),
      dependencies: z
        .array(z.string())
        .optional()
        .describe(
          "前置任务本地 taskId 数组（仅 featureId 提供时生效；前一任务终态后才派发下一个）",
        ),
      inputs: z
        .array(
          z.object({
            producerTaskId: z.string().optional().describe("上游节点本地 taskId"),
            name: z.string().optional().describe("产物名（配 producerTaskId 定位）"),
            artifactId: z.string().optional().describe("产物主键（优先，支持后缀匹配）"),
          }),
        )
        .optional()
        .describe(
          "本节点引用的上游产物（仅 featureId 提供时生效）：{producerTaskId, name} 或 {artifactId}；派发时解析并注入完成的上游产物内容/引用",
        ),
    },
  },
  async (args) => {
    try {
      if (args.featureId !== undefined && args.featureId.length > 0) {
        const outcome = registerFeatureNode(
          args.project,
          args.message,
          args.contextId,
          args.featureId,
          args.dependencies ?? [],
          args.inputs,
        );
        return outcome.ok ? textResult(outcome) : errorResult(outcome);
      }
      const outcome = await handleCall(
        args.project,
        args.message,
        args.contextId,
        args.wait ?? true,
      );
      return outcome.ok ? textResult(outcome) : errorResult(outcome);
    } catch (err) {
      return internalError(err);
    }
  },
);

server.registerTool(
  "a2a_task_status",
  {
    description: "查询任务态（A2A tasks/get），并回写本地任务存储；返回状态、文本与 artifacts。",
    inputSchema: {
      taskId: z.string().min(1).describe("a2a_call 返回的 taskId"),
    },
  },
  async (args) => {
    try {
      const outcome = await handleTaskStatus(args.taskId);
      return outcome.ok ? textResult(outcome) : errorResult(outcome);
    } catch (err) {
      return internalError(err);
    }
  },
);

server.registerTool(
  "a2a_cancel",
  {
    description: "取消任务（A2A tasks/cancel），并回写本地任务存储；返回取消后的任务态。",
    inputSchema: {
      taskId: z.string().min(1).describe("a2a_call 返回的 taskId"),
    },
  },
  async (args) => {
    try {
      const outcome = await handleCancel(args.taskId);
      return outcome.ok ? textResult(outcome) : errorResult(outcome);
    } catch (err) {
      return internalError(err);
    }
  },
);

server.registerTool(
  "a2a_events",
  {
    description:
      "读取事件收件箱增量（任务结算/阻塞、Feature 流转、worker push）。省略 since 则自进程读游标起；无变化时廉价空返回。",
    inputSchema: {
      since: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("游标：仅返回 eventId 大于它的新事件；省略则用进程读游标"),
    },
  },
  async (args) => {
    try {
      return textResult(handleEvents(args.since));
    } catch (err) {
      return internalError(err);
    }
  },
);

server.registerTool(
  "a2a_wait",
  {
    description:
      "长轮询等待新事件（推送优先唤醒 + 定时对账），最多 timeoutMs（内部上限低于同步预算）；超时无事件则 timedOut=true。",
    inputSchema: {
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("最长等待毫秒；省略用内部上限（cap < SYNC_BUDGET_MS）"),
    },
  },
  async (args) => {
    try {
      return textResult(await handleWait(args.timeoutMs));
    } catch (err) {
      return internalError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// MCP Server（Feature 工具组；静态注册，零重连）
// ---------------------------------------------------------------------------

server.registerTool(
  "a2a_feature_create",
  {
    description:
      "新建 Feature（一条需求，初始态 discussing）。返回 featureId 供后续 advance/approve/cancel/status 引用。",
    inputSchema: {
      title: z.string().min(1).describe("Feature 标题（需求的简短摘要）"),
      requirement: z.string().optional().describe("需求原文（可选）"),
      contextId: z
        .string()
        .optional()
        .describe("Feature 级会话上下文（落 features.context_id，跨任务 / 跨 worker 启停复用）"),
    },
  },
  async (args) => {
    try {
      const outcome = handleFeatureCreate({
        title: args.title,
        requirement: args.requirement,
        contextId: args.contextId,
      });
      return outcome.ok ? textResult(outcome) : errorResult(outcome);
    } catch (err) {
      return internalError(err);
    }
  },
);

server.registerTool(
  "a2a_feature_status",
  {
    description:
      "查询 Feature 详情（state + tasks 摘要 + artifacts）；省略 featureId 时列出全部 Feature（含任务数）。",
    inputSchema: {
      featureId: z.string().optional().describe("Feature ID；省略则列出全部"),
    },
  },
  async (args) => {
    try {
      const outcome = handleFeatureStatus({ featureId: args.featureId });
      return outcome.ok ? textResult(outcome) : errorResult(outcome);
    } catch (err) {
      return internalError(err);
    }
  },
);

server.registerTool(
  "a2a_feature_advance",
  {
    description:
      "orch agent 驱动 Feature 主链推进（如 discussing→analyzing→planning→waiting_approval、integrating→testing→reviewing→completed）；状态机校验合法后继，非法流转被拒。needs_input 恢复用 to=executing 并携带 answer。",
    inputSchema: {
      featureId: z.string().min(1).describe("Feature ID"),
      to: z
        .string()
        .min(1)
        .describe(
          "目标状态：discussing / analyzing / planning / waiting_approval / executing / integrating / testing / reviewing / completed / needs_input / failed / cancelled（非法后继被状态机拒绝）",
        ),
      note: z
        .string()
        .optional()
        .describe("统一方案 / 备注：落 Feature Context 的 plan（供审批与派发注入）"),
      decisions: z
        .string()
        .optional()
        .describe("决策记录（JSON 字符串；落 Feature Context 的 decisions）"),
      contracts: z
        .string()
        .optional()
        .describe("契约（JSON 字符串；落 Feature Context 的 contracts）"),
      answer: z
        .string()
        .optional()
        .describe("needs_input→executing 时的人工澄清内容，以同 contextId 续接待澄清任务"),
    },
  },
  async (args) => {
    try {
      const outcome = handleFeatureAdvance({
        featureId: args.featureId,
        to: args.to,
        note: args.note,
        decisions: args.decisions,
        contracts: args.contracts,
        answer: args.answer,
      });
      if (!outcome.ok) return errorResult(outcome);
      scheduler.kick();
      return textResult(outcome);
    } catch (err) {
      return internalError(err);
    }
  },
);

server.registerTool(
  "a2a_feature_approve",
  {
    description: "审批门：用户放行 Feature（waiting_approval → executing）；非该态调用被拒。",
    inputSchema: {
      featureId: z.string().min(1).describe("Feature ID"),
    },
  },
  async (args) => {
    try {
      const outcome = handleFeatureApprove({ featureId: args.featureId });
      if (!outcome.ok) return errorResult(outcome);
      scheduler.kick();
      return textResult(outcome);
    } catch (err) {
      return internalError(err);
    }
  },
);

server.registerTool(
  "a2a_feature_cancel",
  {
    description: "取消 Feature（任意非终态 → cancelled）；调度器随之停止该 Feature。",
    inputSchema: {
      featureId: z.string().min(1).describe("Feature ID"),
    },
  },
  async (args) => {
    try {
      const outcome = handleFeatureCancel({ featureId: args.featureId });
      return outcome.ok ? textResult(outcome) : errorResult(outcome);
    } catch (err) {
      return internalError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// 启动（stdio）
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    const pruned = pruneTasks();
    if (pruned > 0) {
      console.error(`[a2a-bridge] 启动清理任务记录：删除 ${pruned} 条`);
    }
  } catch (err) {
    console.error(`[a2a-bridge] 启动清理任务记录失败：${toMessage(err)}`);
  }
  // 桥重启恢复：扫描非终态 Feature 纯本地收敛（不 ensure、不派发）
  try {
    const recovered = scheduler.recover();
    if (recovered.scanned > 0 || recovered.interruptedTasks > 0) {
      console.error(
        `[a2a-bridge] 桥重启恢复：扫描非终态 Feature ${recovered.scanned}，收敛 failed ${recovered.failedFeatures}（interrupted 任务 ${recovered.interruptedTasks}）`,
      );
    }
  } catch (err) {
    console.error(`[a2a-bridge] 桥重启恢复失败：${toMessage(err)}`);
  }
  // 启动串行 Task DAG 调度器（进程内异步循环，不阻塞 stdio）
  scheduler.start();
  // 启动 worker 回调端点（v0.4.0 §2.6；`callback.enabled` 默认关，关闭时 startCallbackServer 空操作）
  startCallbackServer(callbackConfig());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    "[a2a-bridge] MCP stdio server ready: a2a_projects / a2a_tasks / a2a_call / a2a_task_status / a2a_cancel / a2a_feature_create / a2a_feature_status / a2a_feature_advance / a2a_feature_approve / a2a_feature_cancel",
  );
}

function shutdown(): void {
  scheduler.stop();
  stopCallbackServer();
  closeSessionStore();
  void server
    .close()
    .catch((err: unknown) => {
      console.error(`[a2a-bridge] close error: ${toMessage(err)}`);
    })
    .finally(() => {
      process.exit(0);
    });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err: unknown) => {
  console.error(`[a2a-bridge] fatal: ${toMessage(err)}`);
  process.exit(1);
});
