/**
 * MCP 泛型桥（orch 工具面）。
 *
 * 只暴露固定 4 个泛型工具，不按 skill 生成工具、不做动态注册（不发 `tools/list_changed`）：
 * - `a2a_projects()`                     聚合各机 `GET /projects`
 * - `a2a_call(project, message, contextId?)`  解析项目→机器 → 幂等 ensure → A2A message/send
 * - `a2a_task_status(taskId)`            查询任务态（远端 A2A `tasks/get`，回写本地存储）
 * - `a2a_cancel(taskId)`                 取消任务（远端 A2A `tasks/cancel`，回写本地存储）
 *
 * 依赖：
 * - `@a2a-js/sdk`（A2A Client；v1.1.0：`ClientFactory` + `JsonRpcTransportFactory`/`RestTransportFactory`）
 * - `../session/store.js`（任务态持久化；CLI 会话由包装器按 A2A `contextId` 持有）
 *
 * 跨 MCP 边界的错误一律结构化返回（`{ ok: false, code, error }`），不抛出。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory } from "@a2a-js/sdk/client";
import type { Client } from "@a2a-js/sdk/client";
import { Role, TaskState as A2aTaskState } from "@a2a-js/sdk";
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
import type {
  AgentKind,
  MachineRef,
  ProjectStatus,
  RiskLevel,
  TaskRecord,
  TaskState as DomainTaskState,
} from "../types.js";
import {
  createTask,
  getTask,
  updateTaskState,
  close as closeSessionStore,
} from "../session/store.js";
import { startTaskWatcher, WATCHER_MAX_CONSECUTIVE_FAILURES } from "./task-watcher.js";

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
const LAUNCHER_ENSURE_TIMEOUT_MS = readPositiveIntEnv(
  "LAUNCHER_ENSURE_TIMEOUT_MS",
  60_000,
);
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
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: string };

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

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<HttpResult> {
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
    typeof agentKindRaw === "string" && isAgentKind(agentKindRaw)
      ? agentKindRaw
      : "opencode";
  const a2aPortRaw = o["a2aPort"];
  const a2aPort =
    typeof a2aPortRaw === "number" && Number.isInteger(a2aPortRaw)
      ? a2aPortRaw
      : 0;
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
  | { ok: true; projects: ProjectStatus[] }
  | { ok: false; error: string };

async function listMachineProjects(machine: MachineRef): Promise<ListResult> {
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
  for (const { machine, listed } of scanned) {
    if (!listed.ok) {
      unreachable.push(`${machine.machineId}: ${listed.error}`);
      continue;
    }
    const project = listed.projects.find((p) => p.projectId === projectId);
    if (project !== undefined) {
      projectIndex.set(projectId, machine.machineId);
      return { ok: true, machine, project };
    }
  }
  const suffix =
    unreachable.length > 0 ? `（部分机器不可达：${unreachable.join("; ")}）` : "";
  return {
    ok: false,
    code: "project_not_found",
    error: `未在已配置机器上找到项目 ${projectId}${suffix}`,
  };
}

type EnsureOutcome =
  | { ok: true; endpoint: string; started: boolean }
  | { ok: false; code: string; error: string };

/** `POST {launcher}/projects/{id}/ensure`（幂等启动），返回 A2A 端点 */
async function ensureProject(
  machine: MachineRef,
  projectId: string,
): Promise<EnsureOutcome> {
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
    a.name.toLowerCase().startsWith("trace.") ||
    a.artifactId.toLowerCase().startsWith("trace.")
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
    task.status?.message === undefined
      ? ""
      : partsToText(task.status.message.parts);
  if (statusText.length > 0) return statusText;
  const artifactChunks: string[] = [];
  for (const artifact of task.artifacts) {
    if (isTraceArtifact(artifact)) continue;
    const text = partsToText(artifact.parts);
    if (text.length > 0) artifactChunks.push(text);
  }
  return artifactChunks.join("\n\n");
}

/** 本地记录是否已终结（终结态结果由本地存档直接作答，不再查询远端） */
function isLocalTerminalState(state: DomainTaskState): boolean {
  return state === "completed" || state === "failed";
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

/** 同步预算到点的 working 返回文案：指引轮询 + 中断恢复路径 */
function workingGuidanceText(taskId: string, contextId: string): string {
  return `任务仍在执行中。请用 a2a_task_status(taskId="${taskId}") 轮询结果；不要重复 a2a_call（同一任务会重复执行）。若任务因 agent 回收而中断，可携带同 contextId（${contextId}）调用 a2a_call 续接会话继续。`;
}

function buildSendRequest(text: string, contextId: string): SendMessageRequest {
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
      taskPushNotificationConfig: undefined,
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

async function handleCall(
  projectId: string,
  text: string,
  contextIdInput: string | undefined,
): Promise<CallOutcome> {
  const contextId =
    contextIdInput !== undefined && contextIdInput.length > 0
      ? contextIdInput
      : randomUUID();

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

  const request = buildSendRequest(text, contextId);

  let result: SendMessageResult;
  try {
    result = await client.sendMessage(request, {
      signal: AbortSignal.timeout(A2A_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      code: "a2a_send_failed",
      error: `A2A message/send 失败：${toMessage(err)}`,
      contextId,
    };
  }

  if (isTaskResult(result)) {
    const settled = terminalOrInterrupted(taskStateOf(result))
      ? result
      : await pollTaskUntilSettled(
          client,
          result,
          Date.now() + SYNC_BUDGET_MS,
          async () => {
            await ensureProject(located.machine, projectId);
          },
        );

    // 半异步：同步预算到点仍未终态 —— 落库 working、启动后台看护（轮询+续约至终态并落库）、立即返回句柄
    if (!terminalOrInterrupted(taskStateOf(settled))) {
      createTask({
        taskId: settled.id,
        projectId,
        contextId,
        state: "working",
        artifactsJson: JSON.stringify(summarizeArtifacts(settled.artifacts)),
        text: null,
      });
      const started = startTaskWatcher({
        taskId: settled.id,
        poll: () =>
          client.getTask(
            { tenant: "", id: settled.id, historyLength: undefined },
            { signal: AbortSignal.timeout(A2A_REQUEST_TIMEOUT_MS) },
          ),
        renew: async () => {
          await ensureProject(located.machine, projectId);
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
        pollIntervalMs: POLL_INTERVAL_MS,
        renewIntervalMs: LEASE_RENEW_INTERVAL_MS,
        maxConsecutiveFailures: WATCHER_MAX_CONSECUTIVE_FAILURES,
      });
      if (started) {
        console.log(
          `[a2a-bridge] 任务 ${settled.id} 超出同步预算（${SYNC_BUDGET_MS}ms），转后台看护`,
        );
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

    const status = mapTaskState(taskStateOf(settled));
    const artifacts = summarizeArtifacts(settled.artifacts);
    createTask({
      taskId: settled.id,
      projectId,
      contextId,
      state: status,
      artifactsJson: JSON.stringify(artifacts),
      text: taskText(settled),
    });
    return {
      ok: true,
      text: taskText(settled),
      artifacts,
      taskId: settled.id,
      status,
      contextId,
    };
  }

  return {
    ok: true,
    text: partsToText(result.parts),
    artifacts: [],
    status: "completed",
    contextId,
  };
}

interface TaskStatusSuccess {
  ok: true;
  taskId: string;
  status: DomainTaskState;
  text: string;
  artifacts: ArtifactSummary[];
  updatedAt: string;
}

type TaskStatusOutcome =
  | TaskStatusSuccess
  | (Failure & { task?: TaskRecord });

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
    let artifacts: ArtifactSummary[] = [];
    try {
      const parsed: unknown = JSON.parse(record.artifactsJson ?? "[]");
      if (Array.isArray(parsed)) artifacts = parsed as ArtifactSummary[];
    } catch {
      artifacts = [];
    }
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

// ---------------------------------------------------------------------------
// MCP Server（stdio；固定工具面，4 个泛型工具）
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "a2a-coding-bridge", version: "0.1.0" });

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
  "a2a_call",
  {
    description:
      "向目标项目派发一轮任务：解析项目→机器，按需幂等启动其 Agent（ensure），经 A2A 发送消息并返回文本结果 + artifacts。传入相同 contextId 可续接上下文；返回 contextId 便于继续追问。",
    inputSchema: {
      project: z.string().min(1).describe("目标项目 ID（静态分布配置中的 projectId）"),
      message: z.string().min(1).describe("发给执行 Agent 的任务内容"),
      contextId: z
        .string()
        .optional()
        .describe("会话上下文 ID；续接同一上下文时传入，省略则自动新建并在返回中给出"),
    },
  },
  async (args) => {
    try {
      const outcome = await handleCall(args.project, args.message, args.contextId);
      return outcome.ok ? textResult(outcome) : errorResult(outcome);
    } catch (err) {
      return internalError(err);
    }
  },
);

server.registerTool(
  "a2a_task_status",
  {
    description:
      "查询任务态（A2A tasks/get），并回写本地任务存储；返回状态、文本与 artifacts。",
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

// ---------------------------------------------------------------------------
// 启动（stdio）
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    "[a2a-bridge] MCP stdio server ready: a2a_projects / a2a_call / a2a_task_status / a2a_cancel",
  );
}

function shutdown(): void {
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
