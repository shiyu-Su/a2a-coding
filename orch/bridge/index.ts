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
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appRootFromModule } from "../app-root.js";
import { defaultProjectGroup, loadMachinesConfig, memberKey } from "../config.js";
import { BRIDGE_VERSION } from "../version.js";
import { BridgeRuntime, defaultPidFile, type RuntimeReadiness } from "../runtime/lifecycle.js";
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
  type ProjectGroup,
  type ProjectStatus,
  type RiskLevel,
  type TaskListItem,
  type TaskRecord,
  type TaskState as DomainTaskState,
  type TransportConfig,
  type TransportMode,
  type WebConfig,
} from "../types.js";
import {
  appendEvent,
  createTask,
  DEFAULT_SESSION_DB,
  getArtifact,
  getDefaultStore,
  getFeature,
  getTask,
  latestEventId,
  listArtifactsByFeature,
  listArtifactsByProducer,
  listEvents,
  listTasks,
  markTaskDispatched,
  pruneTasks,
  setTaskNotBefore,
  truncatePrompt,
  updateTaskState,
  upsertArtifact,
  close as closeSessionStore,
} from "../session/store.js";
import { bridgeLog } from "./bridge-log.js";
import {
  EVIDENCE_ARTIFACT_NAME,
  artifactSummaryText,
  buildEvidenceMessage,
  parseEvidenceResult,
} from "./evidence-message.js";
import {
  isTaskWatched,
  notifyTaskPush,
  startTaskWatcher,
  WATCHER_MAX_CONSECUTIVE_FAILURES,
} from "./task-watcher.js";
import {
  EVIDENCE_EVENT_KIND,
  EVIDENCE_POLL_MS,
  FEATURE_ABANDONED_TEXT,
  FeatureScheduler,
  isLocalTerminalTask,
  markEvidenceMessage,
  type EvidenceResult,
  type FeatureDispatchResult,
} from "./scheduler.js";
import {
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCancel,
  handleFeatureCreate,
  handleFeatureStatus,
  type FeatureAdvanceArgs,
  type FeatureApproveArgs,
  type FeatureCancelArgs,
  type FeatureCreateArgs,
  type FeatureCreateSuccess,
  type FeatureStateChangeSuccess,
  type FeatureStatusArgs,
  type FeatureStatusSuccess,
  type FeatureToolFailure,
} from "./feature-tools.js";
import {
  isLoopbackHostOrAddress,
  startHttpTransport,
  type HttpTransportHandle,
} from "./transports/http.js";
import { startStdioTransport } from "./transports/stdio.js";
import { startWebTransport, type WebTransportOutcome } from "./transports/web.js";
// 挂载态常量（单一事实源在 register-tools.ts）：index → register-tools 的运行时 import 安全
// （register-tools 对 index 仅 **type-only** 引用，擦除后无环）
import { MOUNTABLE_FEATURE_STATES } from "./register-tools.js";

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

async function listMachineProjects(machine: MachineRef, group: ProjectGroup): Promise<ListResult> {
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
  /**
   * **单点过滤**（v0.6.0 §2.2）：`GET /projects` 是本桥**唯一**的项目发现入口 ⇒
   * 在此收口即覆盖全部「发现」路径（`locateProject` cache-hit / scan、`refreshProjectsSnapshotLazily`、
   * `handleProjects`）。判据经 {@link isMemberProject}（与 `assertMember` 同源，I1）。
   */
  return {
    ok: true,
    projects: projects.filter((p) => isMemberProject(machine.machineId, p.projectId, group)),
  };
}

type LocateResult =
  | { ok: true; machine: MachineRef; project: ProjectStatus }
  | { ok: false; code: string; error: string };

type MachinesLoad =
  | { ok: true; machines: MachineRef[]; group: ProjectGroup }
  | { ok: false; error: string };

/**
 * 机器清单 + 项目组（v0.6.0 §2.1 总纲 2）。
 *
 * **不新增进程级缓存**：与 `machines[]` 同生命周期 —— 每次调用现读配置文件，
 * 配置热改（成员增删 / 段增删）**即时生效**，无需重启桥。`projectGroup` 段缺失 ⇒
 * `selective: false`（全量接纳，旧 `config.json` 零改动可用）；段存在但非法 ⇒
 * `loadMachinesConfig` 抛错 ⇒ 此处 `{ ok: false }` ⇒ 调用方一律 `machines_config_error`
 * （**绝不 fail-open**，I2）。
 */
function loadMachines(): MachinesLoad {
  try {
    const config = loadMachinesConfig(MACHINES_CONFIG_PATH);
    return {
      ok: true,
      machines: config.machines,
      // `projectGroup` 只由 `loadMachinesConfig` 产出（恒有值）；`??` 仅为可选字段的类型收窄
      group: config.projectGroup ?? defaultProjectGroup(),
    };
  } catch (err) {
    return {
      ok: false,
      error: `加载机器清单失败（${MACHINES_CONFIG_PATH}）：${toMessage(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// 项目组成员判定（v0.6.0 §2.3-I1：**唯一判据** —— 过滤 / 断言必须同源）
// ---------------------------------------------------------------------------

/**
 * 过滤用（§2.2）：`(machineId, projectId)` 是否为项目组成员。
 *
 * - `selective: false`（无 `projectGroup` 段）⇒ **全量接纳**（旧配置语义）；
 * - `selective: true` ⇒ 唯一判据 = `memberKeys.has(memberKey(machineId, projectId))`
 *   （`memberKey` 单一构造来自 `config.ts`，本文件**不另起拼接**）。
 *
 * 与 {@link assertMember} **同源**（两者只经 `memberKey`）；禁止各自演化（v0.5.1 D2 教训）。
 */
function isMemberProject(machineId: string, projectId: string, group: ProjectGroup): boolean {
  if (!group.selective) return true;
  return group.memberKeys.has(memberKey(machineId, projectId));
}

/** 构造 `project_not_a_member` 结构化失败（`machineId === null` = 未知落点机器的通用表述） */
function notAMemberFailure(
  machineId: string | null,
  projectId: string,
  group: ProjectGroup,
): Failure {
  const where = machineId === null ? `项目 ${projectId}` : `项目 ${projectId}@${machineId}`;
  const who = group.name === null ? "项目组" : `项目组「${group.name}」`;
  return {
    ok: false,
    code: "project_not_a_member",
    error:
      `${where} 不是${who}的成员（选择性连接：未列成员的项目不主动连 / 不 ensure / 不派发）。` +
      `请在 orch/config/config.json 的 projectGroup.members 中登记 { machineId, projectId } 后重试。`,
  };
}

/**
 * 断言用（§2.2）：返回 `Failure`（非成员）或 `null`（通过）。
 *
 * - `machineId` 给定 ⇒ **精确**到 `(machineId, projectId)` 的成员判定
 *   （`ensureProject` 硬兜底用，落点机器已知）；
 * - `machineId === null` ⇒ 只要求「**该项目被任一成员机器声明**」—— 派发前置
 *   （`dispatchTask` / `registerFeatureNode` / `locateProject` 扫描前）尚**不知道落点机器**，
 *   用本形态可**零 I/O** 判定「未被选中」，避免把「没选它」降级成 `project_not_found`。
 *
 * 两种形态**同源**：给定机器走 {@link isMemberProject}；未给定机器遍历
 * `memberMachineIds` × `memberKey` —— 无第二套拼接 / 第二套判据（I1）。
 */
function assertMember(
  machineId: string | null,
  projectId: string,
  group: ProjectGroup,
): Failure | null {
  if (!group.selective) return null;
  if (machineId !== null) {
    return isMemberProject(machineId, projectId, group)
      ? null
      : notAMemberFailure(machineId, projectId, group);
  }
  for (const candidate of group.memberMachineIds) {
    if (group.memberKeys.has(memberKey(candidate, projectId))) return null;
  }
  return notAMemberFailure(null, projectId, group);
}

/**
 * 参与「发现 / 定位」的机器集合：`selective: false` ⇒ 全部机器；否则 ⇒ 配置声明的成员机器。
 *
 * `handleProjects` / `refreshProjectsSnapshotLazily` / `locateProject` **共用同一集合** ——
 * 否则出现「定位得到、快照没有」的双份判据（§2.2）。
 */
function memberMachines(machines: readonly MachineRef[], group: ProjectGroup): MachineRef[] {
  if (!group.selective) return Array.from(machines);
  return machines.filter((m) => group.memberMachineIds.has(m.machineId));
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

/**
 * 解析 project -> machine（v0.6.0 §2.2：**成员机器范围内**定位）。
 *
 * 成员过滤的三条落点（R1「缓存不绕过」）：
 * ① 扫描范围收窄为 `memberMachines(machines, group)`（= `group.memberMachineIds`）；
 * ② **cache-hit 分支先判成员**：`(cachedMachineId, pid)` 已非成员 ⇒ 清缓存条目；
 *    若该项目在**另一台**成员机器上仍是成员，则继续走扫描（见下方 `assertMember` 后的扫描）；
 * ③ **scan-hit 只对成员** `projectIndex.set(...)`（非成员绝不入缓存、绝不作命中）；
 * ④ 扫描前先 `assertMember(null, …)`：未被任何成员机器声明 ⇒ **零 I/O** 返回
 *    `project_not_a_member`，**不降级**成 `project_not_found`、**不回落全量扫描**。
 */
async function locateProject(projectId: string): Promise<LocateResult> {
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error };
  }
  const { group } = config;
  const machines = memberMachines(config.machines, group);

  const cachedMachineId = projectIndex.get(projectId);
  if (cachedMachineId !== undefined) {
    // ② 缓存不绕过：**先判成员**再核对（配置热改移出成员后，缓存不得成为旁路）
    if (!isMemberProject(cachedMachineId, projectId, group)) {
      projectIndex.delete(projectId);
    } else {
      const machine = machines.find((m) => m.machineId === cachedMachineId);
      if (machine !== undefined) {
        const listed = await listMachineProjects(machine, group);
        if (listed.ok) {
          const project = listed.projects.find((p) => p.projectId === projectId);
          if (project !== undefined) {
            rememberProjectStatus(project); // 顺带预热取证快照（免额外 HTTP）
            return { ok: true, machine, project };
          }
        }
        projectIndex.delete(projectId);
      } else {
        projectIndex.delete(projectId);
      }
    }
  }

  /**
   * ④ 扫描前断言：未知落点机器 ⇒ 「任一成员机器声明」即可。
   * 未声明 ⇒ **零 I/O** 失败（`project_not_a_member`）——既不发 `/health` 也不发 `/projects`；
   * 陈旧缓存条目已在上面清理 ⇒ 不存在「回落全量扫描」。
   */
  const denied = assertMember(null, projectId, group);
  if (denied !== null) {
    return { ok: false, code: denied.code, error: denied.error };
  }

  const scanned = await Promise.all(
    machines.map(async (machine) => ({
      machine,
      listed: await listMachineProjects(machine, group),
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
    if (project === undefined) continue;
    // ③ 只对成员入缓存 / 只把成员当命中（`listMachineProjects` 已过滤；此处再判一次 = 显式落点，
    //    防未来有人绕过该过滤时静默污染缓存与快照）
    if (!isMemberProject(machine.machineId, projectId, group)) continue;
    projectIndex.set(projectId, machine.machineId);
    rememberProjectStatus(project); // 顺带预热取证快照（免额外 HTTP）
    return { ok: true, machine, project };
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
  /**
   * **硬兜底 · 首行（v0.6.0 §2.2 / §2.3-I3）**：判成员必须**早于任何网络 I/O**（含 `/health` 握手）。
   * 这是**唯一充分**的解 —— 覆盖全部 6 条「拉起」路径（`handleCall` / `dispatchFeatureNode` /
   * `handleTaskStatus` / `handleCancel` / 看护 `renew` / `pollTaskUntilSettled` 的 `renew`）：
   * 非成员**绝不 `POST /ensure`，连 `GET /health` 都不发**。
   *
   * 配置**现读**（不缓存）⇒ 成员热移除后，在飞任务的 `renew` 也随之失败（R6 设计内行为，
   * 非致命：看护仍用已建 client 直连 `tasks/get` 至终态）。配置坏 ⇒ `machines_config_error`（I2）。
   */
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error };
  }
  const denied = assertMember(machine.machineId, projectId, config.group);
  if (denied !== null) {
    return { ok: false, code: denied.code, error: denied.error };
  }
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
 *
 * v0.4.1：**委托** `scheduler.isLocalTerminalTask(node)`，消除「双份判据」——
 * 该判定是中性化的第 5 处，须认 `exhausted`（节点级谓词，scheduler 为单一事实源）。
 */
function isLocalTerminalState(node: TaskRecord): boolean {
  return isLocalTerminalTask(node);
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
      bridgeLog.info("a2a-bridge", `后台看护：任务 ${task.id} 已终态（${state}），结果落库`);
    },
    // v0.4.0 §2.6：可选订阅推送（命中即提前对账；无推送时与纯轮询等价）
    subscribePush: true,
    pollIntervalMs: POLL_INTERVAL_MS,
    renewIntervalMs: LEASE_RENEW_INTERVAL_MS,
    maxConsecutiveFailures: WATCHER_MAX_CONSECUTIVE_FAILURES,
  });
  if (started) {
    bridgeLog.info("a2a-bridge", `任务 ${settled.id} ${reason}，转后台看护`);
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
  /**
   * 派发前置断言（v0.6.0 §2.2）：**零 I/O 早失败** —— `inquiry` 路径在未被选中时
   * 不得先发 `/health` / `/projects` 才发现「项目不属本组」。判据同源于 {@link assertMember}
   * （`machineId === null`：任一成员机器声明即可；落点机器由随后的 `locateProject` 决定）。
   */
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error, contextId };
  }
  const denied = assertMember(null, projectId, config.group);
  if (denied !== null) {
    return { ok: false, code: denied.code, error: denied.error, contextId };
  }
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

/**
 * `a2a_call` 的**立即派发路径**（REQ-v0.4.1-2026-09-16-01 §2.5）：**只承载 `inquiry`**。
 * 执行型派发（`mode="execute"`）必带 `featureId` ⇒ 走 {@link registerFeatureNode}（登记 DAG 节点，
 * 由调度器派发），永不进入本函数。
 *
 * 契约以**类型级**表达：`mode` 只能取字面量 `"inquiry"` —— 传 `"execute"` 即**编译错误**；
 * `mode` 的必填性 / 对偶校验**不在本层重复实现**（单一事实源：`register-tools.ts` 的
 * `a2aCallSchema` 与 `validateCallMode`）。缺省值使既有 4 参调用点行为完全等价（A 步零破坏）。
 */
async function handleCall(
  projectId: string,
  text: string,
  contextIdInput: string | undefined,
  wait: boolean,
  mode: "inquiry" = "inquiry",
): Promise<CallOutcome> {
  void mode; // 类型级契约：运行时无需分支（非 inquiry 无法通过编译）
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
 * 可挂载态 = `MOUNTABLE_FEATURE_STATES`（**常量集合驱动**，现为
 * `executing` / `waiting_approval`；`analyzing`（分析扇出）已随主链收敛**有意撤销**；
 * 登记 ≠ 派发 —— `tick` 只看 `executing`。变更该常量即自动更新文案，经 `join` 取用）；
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
  if (!MOUNTABLE_FEATURE_STATES.includes(feature.state)) {
    return {
      ok: false,
      code: "feature_state_invalid",
      error: `Feature ${featureId} 当前为 ${feature.state}，仅 ${MOUNTABLE_FEATURE_STATES.join(" / ")} 可挂载任务`,
      contextId,
    };
  }
  /**
   * 登记前断言（v0.6.0 §2.2）：防「登记成功、异步才失败」—— 越界必须**即时**失败。
   * 此处仍在 `createTask` **之前** ⇒ 非成员节点绝不入库、调度器也不会被 kick。
   * 判据同源 {@link assertMember}（`machineId === null`：任一成员机器声明即可）。
   */
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error, contextId };
  }
  const denied = assertMember(null, projectId, config.group);
  if (denied !== null) {
    return { ok: false, code: denied.code, error: denied.error, contextId };
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
    /**
     * `FeatureDispatchResult` 只有 `error`（无 `code`）—— 守住 `scheduler.ts` **零改动**的前提下，
     * 把错误码嵌进错误字符串（如 `[project_not_a_member] …`），保证非成员等结构化失败码在
     * 失败传播 / Feature failed 原因 / 日志里**不丢失**（v0.6.0 §3.1-N2）。
     */
    return { ok: false, error: `[${sent.code}] ${sent.error}` };
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
      bridgeLog.info(
        "a2a-bridge",
        `Feature 节点 ${node.taskId}（远端 ${remoteTaskId}）已终态（${st}）`,
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
    bridgeLog.info(
      "a2a-bridge",
      `Feature 节点 ${node.taskId} 已派发（远端 ${remoteTaskId}），转后台看护`,
    );
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// v0.4.1 取证流：`/projects` 快照 + 取证结论解析（§2.5 硬路径 / §2.3 ③④）
// ---------------------------------------------------------------------------

/** `/projects` 快照状态（**非阻塞**：探针只读快照，刷新为 fire-and-forget 惰性触发） */
interface ProjectsSnapshotState {
  byProject: Map<string, ProjectStatus>;
  /** 最近一次刷新完成时刻（成功或失败都记，用于节流） */
  refreshedAt: number;
  /** 最近一次刷新失败的原因（仅供 reason 留痕；四种失败一律 `ready=false`） */
  error: string | null;
  inFlight: boolean;
}

const projectsSnapshot: ProjectsSnapshotState = {
  byProject: new Map<string, ProjectStatus>(),
  refreshedAt: 0,
  error: null,
  inFlight: false,
};

/**
 * 把项目状态顺带记进快照。**由 `locateProject` 在命中项目时调用**：
 * 派发/查询路径本就已经拿到 `ProjectStatus`，顺带落快照 ⇒ 探针免掉一次额外 HTTP，
 * 也让 `workspace` 在**第一次**登记取证节点时就是真值（而非退化为 cwd 表述）。
 */
function rememberProjectStatus(project: ProjectStatus): void {
  projectsSnapshot.byProject.set(project.projectId, project);
}

/** 把 `/projects` 失败文本归类为 reason（除 `offline` 外四者一律 `ready=false`，此处只为留痕） */
function classifyProbeError(error: string): string {
  if (error.includes("503")) return "503";
  if (error.toLowerCase().includes("starting")) return "starting";
  return "unreachable";
}

/**
 * **惰性刷新** `/projects` 快照（**fire-and-forget，绝不 `await`**）。
 *
 * - 最短刷新间隔 `EVIDENCE_POLL_MS`（与门同频；`inFlight` 防重入）；
 * - **不新增定时器**：由 tick 侧探针调用触发，不引入第二套生命周期；
 * - 无论成败都记 `refreshedAt` ⇒ 失败时不会每 tick 重打。
 */
function refreshProjectsSnapshotLazily(): void {
  if (projectsSnapshot.inFlight) return;
  if (Date.now() - projectsSnapshot.refreshedAt < EVIDENCE_POLL_MS) return;
  projectsSnapshot.inFlight = true;
  void (async () => {
    try {
      const config = loadMachines();
      if (!config.ok) {
        projectsSnapshot.error = "probe_unavailable";
        return;
      }
      /**
       * 只遍历**成员机器**（v0.6.0 §2.2）：必须与 `locateProject` 同时施加，否则出现
       * 「定位得到、快照没有」的双份判据（`probeProjectReady` 会因无快照而 `ready=false`）。
       */
      const targets = memberMachines(config.machines, config.group);
      const listed = await Promise.all(
        targets.map((m) => listMachineProjects(m, config.group)),
      );
      let firstError: string | null = null;
      for (const result of listed) {
        if (result.ok) {
          for (const p of result.projects) rememberProjectStatus(p);
        } else if (firstError === null) {
          firstError = classifyProbeError(result.error);
        }
      }
      projectsSnapshot.error = firstError;
    } catch (err) {
      projectsSnapshot.error = "unreachable";
      bridgeLog.error("a2a-bridge", `取证探针刷新 /projects 失败：${toMessage(err)}`);
    } finally {
      projectsSnapshot.refreshedAt = Date.now();
      projectsSnapshot.inFlight = false;
    }
  })();
}

/**
 * `probeProjectReady` 实现（注入 `FeatureScheduler`，§2.5 硬路径）。
 *
 * `ready = 该 project 的 status !== "online"` —— **线协议字段是 `status`（`online`/`offline`），
 * 没有 `running` 字段**（见 `PROTOCOL.md` / `parseProjectStatus`）。
 * `503` / `starting` / 不可达 / 无快照 ⇒ `ready=false`（由 `reason` 区分，仅留痕）。
 *
 * **同步返回**：只读快照 + 惰性触发刷新，回调内**不 `await`**（否则 10min 的门会拖住 tick 推进）。
 */
function probeProjectReady(projectId: string): { ready: boolean; reason: string } {
  refreshProjectsSnapshotLazily();
  const status = projectsSnapshot.byProject.get(projectId);
  if (status === undefined) {
    return { ready: false, reason: projectsSnapshot.error ?? "probe_unavailable" };
  }
  if (status.status !== "online") return { ready: true, reason: "offline" };
  return { ready: false, reason: "online" };
}

/**
 * `resolveEvidence` 实现（注入 `FeatureScheduler`，§2.5 → §2.3 ④）。
 *
 * 取证结论的解析来源（按优先级）：
 * 1. 该任务**归档产物摘要**里的 `evidence.json`（`tasks.artifacts_json`）——
 *    **这是唯一真正带内容的地方**：`artifacts` 表只存 `name/mime/uri/size`（无内容列）；
 * 2. 该任务全部归档产物文本（worker 未按建议命名时）；
 * 3. `artifacts` 表中名字命中的行（`uri` 恰为内联 JSON 时）。
 *
 * 解析成功 ⇒ 写 `parsed` **转折点**事件（只写一次，不是每轮询）；**失败 / 缺失 ⇒ `null`**
 * ⇒ 调度器按「无证据」交人（fail-safe）。
 */
function resolveEvidence(evidenceTaskId: string): EvidenceResult | null {
  const task = getTask(evidenceTaskId);
  if (task === null) return null;

  const archived = parseArchivedArtifacts(task.artifactsJson);
  const named = archived.find((a) => a.name === EVIDENCE_ARTIFACT_NAME);
  const candidates: string[] = [];
  if (named !== undefined) candidates.push(artifactSummaryText(named));
  candidates.push(textFromArchivedArtifacts(task.artifactsJson));
  for (const rec of listArtifactsByProducer(evidenceTaskId, 50)) {
    if (rec.name === EVIDENCE_ARTIFACT_NAME && rec.uri !== null) candidates.push(rec.uri);
  }

  for (const text of candidates) {
    if (text.length === 0) continue;
    const evidence = parseEvidenceResult(text);
    if (evidence === null) continue;
    appendEvent({
      featureId: task.featureId,
      taskId: evidenceTaskId,
      kind: EVIDENCE_EVENT_KIND,
      state: null,
      payload: JSON.stringify({
        phase: "parsed",
        projectId: task.projectId,
        stable: evidence.stable,
        gatesOk: evidence.gatesOk,
        dCount: evidence.d.length,
        rCount: evidence.r.length,
      }),
    });
    return evidence;
  }
  bridgeLog.error(
    "a2a-bridge",
    `取证结论解析失败（节点 ${evidenceTaskId}）：未取到可解析的 ${EVIDENCE_ARTIFACT_NAME}`,
  );
  return null;
}

/**
 * 取证节点登记（v0.4.1 §2.3 ② / §2.5）—— 注入 `FeatureScheduler.registerEvidenceNode`。
 *
 * 调用时机由调度器保证：`infra` 失败节点**已中性化**（`exhausted=1`）之后才调用，
 * 故此处只需「建节点 + 打角色标记 + 设初始挡板」。
 *
 * 要点：
 * - **新 `contextId`**（`randomUUID()`）：不继承失败节点的会话 ⇒ 与旧 turn 无共享状态，
 *   是**客观第三方**；失败节点若仍在通过超时 turn 写盘，也不会污染本次取证；
 * - **角色标记随消息持久化**（`markEvidenceMessage`）⇒ 桥重启后仍可被 `isEvidenceNode` 识别
 *   （内存态标记会丢，这正是 §4.1.8 要「消息带角色标记」的原因）；
 * - **自包含消息**（nonce / project / workspace / In-Scope / 命令 / 软校验口径 / 输出格式），
 *   模板见 `bridge/evidence-message.ts`；
 * - **初始持久化挡板** `not_before = now + EVIDENCE_POLL_MS`：即使本轮 tick 立刻跑，
 *   取证节点也不会在等回收门判定之前被派出去（后续由 O3b 的门续挡 / 放行）；
 * - **不调用 `scheduler.kick()`**：登记发生在看护回调路径上，下一个 tick（≤1.5s）自然会处理；
 *   初始挡板已保证不会被抢跑。
 */
function registerEvidenceNode(featureId: string, failedTaskId: string): void {
  const failed = getTask(failedTaskId);
  if (failed === null) {
    bridgeLog.error("a2a-bridge", `取证节点登记失败：未知失败节点 ${failedTaskId}`);
    return;
  }
  const feature = getFeature(featureId);
  const nonce = randomUUID();
  const message = markEvidenceMessage(
    buildEvidenceMessage({
      projectId: failed.projectId,
      // 真值优先取自快照（`locateProject` 已顺带写入）⇒ 消息带**真实 workspace**；
      // 尚未预热时（极少）退化为模板的「cwd 即 workspace」表述。
      workspace: projectsSnapshot.byProject.get(failed.projectId)?.workspace ?? null,
      featureId,
      plan: feature?.plan ?? null,
      nonce,
      sampleGapSec: Math.max(1, Math.round(EVIDENCE_POLL_MS / 1000)),
    }),
  );
  const localTaskId = randomUUID();
  createTask({
    taskId: localTaskId,
    projectId: failed.projectId,
    // 新 ctx：取证节点**不继承**失败节点的会话（客观第三方；也避免与旧 turn 共享状态）
    contextId: randomUUID(),
    state: "working",
    prompt: message,
    featureId,
    dispatchMessage: message,
  });
  setTaskNotBefore(localTaskId, new Date(Date.now() + EVIDENCE_POLL_MS).toISOString());
  bridgeLog.info(
    "a2a-bridge",
    `已登记取证节点 ${localTaskId}（feature=${featureId}，失败节点=${failedTaskId}，project=${failed.projectId}）`,
  );
}

/** 进程级调度器（生命周期随桥进程；main() 启动循环 + 恢复） */
const scheduler = new FeatureScheduler({
  dispatch: (node) => dispatchFeatureNode(node),
  registerEvidenceNode: (featureId, failedTaskId) => registerEvidenceNode(featureId, failedTaskId),
  probeProjectReady: (projectId) => probeProjectReady(projectId),
  resolveEvidence: (evidenceTaskId) => resolveEvidence(evidenceTaskId),
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
  if (isLocalTerminalState(record)) {
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

/**
 * `a2a_projects` 出参的 `group` 视图（v0.6.0 §2.3-I5：**恒存在**、不省略字段）。
 * `selective: false` 可消除「空 `memberMachines` 被误读为零成员」的风险。
 */
interface GroupView {
  /** 项目组名；未配置 / 未命名 ⇒ `null`（**不省略字段**） */
  name: string | null;
  /** 是否选择性连接（`false` = 全量接纳 = 旧配置语义） */
  selective: boolean;
  /**
   * **配置声明的**成员机器集合（含当前不可达者 —— **不是**运行时在线集合）；
   * `selective: false` ⇒ `[]`。顺序 = 配置 `members[]` 首次出现序。
   */
  memberMachines: string[];
}

interface MachinesView {
  machines: Array<{
    machineId: string;
    projects: ProjectStatus[];
    error?: string;
  }>;
  /** 项目组视图（v0.6.0；**恒存在**） */
  group: GroupView;
}

/** 项目组 → 出参视图（`memberMachineIds` 由 `members[]` 派生，Set 去重保序 ⇒ 即声明集合） */
function groupView(group: ProjectGroup): GroupView {
  return {
    name: group.name,
    selective: group.selective,
    memberMachines: Array.from(group.memberMachineIds),
  };
}

async function handleProjects(): Promise<MachinesView | Failure> {
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error };
  }
  /**
   * 只遍历**成员机器**（v0.6.0 §2.2）：**无成员的机器整条消失（含其 `error` 条目）** ——
   * 既不 `GET /projects`（不主动连），也不在出参里留占位。每机只列成员由
   * `listMachineProjects(machine, group)` 单点过滤保证。
   */
  const targets = memberMachines(config.machines, config.group);
  const entries = await Promise.all(
    targets.map(async (machine) => {
      const listed = await listMachineProjects(machine, config.group);
      if (listed.ok) {
        return { machineId: machine.machineId, projects: listed.projects };
      }
      return { machineId: machine.machineId, projects: [], error: listed.error };
    }),
  );
  return { machines: entries, group: groupView(config.group) };
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
 * 只采纳 `completed` / `input-required`（`working` 不提前改写；`blocked` 为本地专属）。
 *
 * ⚠️ **不采纳 `failed`**（v0.5.0 D3/D5）：push 由 SDK fire-and-forget 代发、无 ack/重试、可重复/
 * 迟到/乱序 ⇒ 提前把 `failed` 写库会留下「**已写 failed、尚未分类/中性化**」的窗口，周期 tick
 * 撞上即把 Feature 判 `failed`（D3-flaky）；同理 `completed` 预写会让收敛抢在 re-arm 之前
 * （D5-flaky，故本版再删 push 回调里的 `kick()`）。
 * 收窄后 **`failed` 的唯一写者** = 看护 `persist`（`task-watcher.ts`）/ 看护放弃回调 /
 * 派发失败（`scheduler.ts`，同步完成 propagate + failFeature）—— 三者皆为同栈相邻序列，
 * 任何 `kick()` 都插不进「已写 `failed`、未分类」的窗口。
 */
function applyPushedTaskState(localTaskId: string, a2aState: string): void {
  let stateEnum: A2aTaskState;
  try {
    stateEnum = taskStateFromJSON(a2aState);
  } catch {
    return; // 未知状态串：忽略，交由轮询对账
  }
  const mapped = mapTaskState(stateEnum);
  if (mapped !== "completed" && mapped !== "input-required") return;
  const current = getTask(localTaskId);
  if (current === null || isLocalTerminalState(current)) return;
  updateTaskState(localTaskId, mapped);
}

/** 处理一次 push：写 `push.received` 事件 + 命中本地任务回写任务态 + 唤醒看护/订阅（**不驱动流转**） */
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
  // 只唤醒看护（推送优先，立即对账）+ 唤醒长轮询订阅；**不** kick 调度器（v0.5.0 D5）：
  // push 须幂等、不得驱动流转 —— 收敛交给看护 `onSettled` / 周期 tick（延迟 ≤ FEATURE_TICK_MS，
  // 无契约含义）；且在 push 回调同栈内 kick() 会让收敛抢在 re-arm 之前（D5 确定性倒置）。
  const wakeKey = localTaskId ?? info.remoteTaskId;
  if (wakeKey !== null) notifyTaskPush(wakeKey);
  signalEvents();
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

/** 启动 HTTP 事件端点（幂等；`enabled=false` 时不启动） */
function startCallbackServer(cfg: CallbackConfig): void {
  if (!cfg.enabled || callbackServer !== null) return;
  if (!isLoopbackHostOrAddress(cfg.host)) {
    console.error(
      `[a2a-bridge] 警告：回调端点绑定非 loopback 地址 ${cfg.host}` +
        `（仅同机/受信网络 opt-in；跨机回调鉴权待 v0.7.0）`,
    );
  }
  const server = createHttpServer((req, res) => {
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
// 编排内核（core）与 MCP server 工厂
// ---------------------------------------------------------------------------
// 工具注册与 `createServer(core)` 已迁至 `bridge/register-tools.ts`：stateless
// 「每请求新建 server + transport」可**无副作用复用**（本模块是进程入口，import 即有
// 副作用，故工厂不放在这里）。
//
// §2.2 硬规则：core 对外只暴露领域入口（下列 `BridgeCore`），**不含任何 MCP 类型**；
// transports 层调用后自行把结果格式化为 `CallToolResult`。

/**
 * 编排内核对外领域入口（§2.2）。现由 `createCore()` 包住本模块既有领域处理器装配；
 * N6 接常驻化时改为注入 runtime 生命周期（core 租约 / scheduler 归属）。
 */
export interface BridgeCore {
  projects(): Promise<MachinesView | Failure>;
  tasks(projectId: string, state?: DomainTaskState, limit?: number): Promise<TasksView | Failure>;
  call(
    projectId: string,
    text: string,
    contextId: string | undefined,
    wait: boolean,
    /**
     * **立即派发路径只承载 `inquiry`**（类型级约束，见 `handleCall`）；执行型派发
     * （`mode="execute"`）必带 `featureId`，走 `registerFeatureNode`（登记 DAG，由调度器派发）。
     */
    mode?: "inquiry",
  ): Promise<CallOutcome>;
  registerFeatureNode(
    projectId: string,
    message: string,
    contextId: string | undefined,
    featureId: string,
    dependencies: readonly string[],
    inputs?: readonly InputArtifactRef[] | undefined,
  ): CallOutcome;
  taskStatus(taskId: string): Promise<TaskStatusOutcome>;
  cancel(taskId: string): Promise<CancelOutcome>;
  events(since?: number): EventsOutcome;
  wait(timeoutMs?: number): Promise<WaitOutcome>;
  featureCreate(args: FeatureCreateArgs): FeatureCreateSuccess | FeatureToolFailure;
  featureStatus(args: FeatureStatusArgs): FeatureStatusSuccess | FeatureToolFailure;
  featureAdvance(args: FeatureAdvanceArgs): FeatureStateChangeSuccess | FeatureToolFailure;
  featureApprove(args: FeatureApproveArgs): FeatureStateChangeSuccess | FeatureToolFailure;
  featureCancel(args: FeatureCancelArgs): FeatureStateChangeSuccess | FeatureToolFailure;
  /** 工具返回后统一 kick 调度器（Feature 工具组用） */
  kickScheduler(): void;
}

/** 装配内核：既有领域处理器的结构化聚合（N6 常驻化时改为注入 runtime 生命周期）。 */
export function createCore(): BridgeCore {
  return {
    projects: handleProjects,
    tasks: handleTasks,
    call: handleCall,
    registerFeatureNode,
    taskStatus: handleTaskStatus,
    cancel: handleCancel,
    events: handleEvents,
    wait: handleWait,
    featureCreate: handleFeatureCreate,
    featureStatus: handleFeatureStatus,
    featureAdvance: handleFeatureAdvance,
    featureApprove: handleFeatureApprove,
    featureCancel: handleFeatureCancel,
    kickScheduler: (): void => scheduler.kick(),
  };
}

/** 当前活动 MCP server（stdio 路径由 `main()` 装配；供 `shutdown()` 关闭） */
let activeServer: McpServer | null = null;
/** 常驻 HTTP 接入面句柄（http 模式；停机第一步先停收新请求） */
let activeHttp: HttpTransportHandle | null = null;
/**
 * 只读网页接面句柄（v0.5.0 §2.5；**仅在形态门 + `owner` 同时成立时**才有值）。
 * 未启用 / follower / 端口被占 ⇒ 保持 `null`（「无页面」为合法状态，MCP 工具面不受影响）。
 */
let activeWeb: WebTransportOutcome | null = null;
/** 运行时编排（两接入面共用：core 租约 / 后台循环归属 / pidfile / 排空停机） */
let activeRuntime: BridgeRuntime | null = null;
/** 停机重入守卫（信号与 `POST /shutdown` 可能并发到达） */
let stopping = false;

/**
 * 桥运行时 data dir：与 store 的 DB 同目录 —— `core.lock` / `bridge.pid` 落 `orch/data`。
 * DB 路径已由 store 绝对化（N2），此处跟随其目录，保证「租约」与「库」不会分家。
 */
const DATA_DIR = dirname(process.env["SESSION_DB"] ?? DEFAULT_SESSION_DB);

// ---------------------------------------------------------------------------
// 启动（按 `config.transport.mode` 分派：stdio 为默认接入面，http 为常驻接入面）
// ---------------------------------------------------------------------------

/** transport 配置（懒加载 + 进程内缓存；读取失败回落 stdio 默认，与旧配置行为一致） */
let cachedTransportConfig: TransportConfig | null = null;
let transportConfigLoaded = false;

/** 配置缺失 / 非法时的兜底（取值与 `config.ts` 缺省一致） */
const FALLBACK_TRANSPORT: TransportConfig = {
  mode: "stdio",
  http: { host: "127.0.0.1", port: 8787, path: "/mcp" },
};

function transportConfig(): TransportConfig {
  if (!transportConfigLoaded) {
    transportConfigLoaded = true;
    try {
      cachedTransportConfig = loadMachinesConfig(MACHINES_CONFIG_PATH).transport;
    } catch (err) {
      // 与 `callbackConfig()` 一致：配置缺失 / 非法不阻塞启动，回落 stdio（旧行为）
      bridgeLog.error("a2a-bridge", `加载 transport 配置失败（回落 stdio）：${toMessage(err)}`);
      cachedTransportConfig = null;
    }
  }
  return cachedTransportConfig ?? FALLBACK_TRANSPORT;
}

function transportMode(): TransportMode {
  return transportConfig().mode;
}

/** web 配置缺失 / 非法时的兜底（取值与 `config.ts` 缺省一致：常驻启用、stdio 不启用、127.0.0.1:3300） */
const FALLBACK_WEB: WebConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 3300,
  allowStdio: false,
};

/** 网页只读工作台配置（懒加载 + 进程内缓存；读取失败回落默认，与 transport 同策略） */
let cachedWebConfig: WebConfig | null = null;
let webConfigLoaded = false;

function webConfig(): WebConfig {
  if (!webConfigLoaded) {
    webConfigLoaded = true;
    try {
      cachedWebConfig = loadMachinesConfig(MACHINES_CONFIG_PATH).web;
    } catch (err) {
      bridgeLog.error(
        "a2a-bridge",
        `加载 web 配置失败（回落默认：常驻启用 / stdio 不启用）：${toMessage(err)}`,
      );
      cachedWebConfig = null;
    }
  }
  return cachedWebConfig ?? FALLBACK_WEB;
}

/**
 * 开 store + 启动清理（lifecycle 的 `openStore` 钩子）。
 * 与既有 stdio 启动同序：先开库（迁移）再 `pruneTasks()`；清理失败只记日志、不阻塞启动。
 */
function openStoreAndPrune(): void {
  getDefaultStore();
  try {
    const pruned = pruneTasks();
    if (pruned > 0) bridgeLog.info("a2a-bridge", `启动清理任务记录：删除 ${pruned} 条`);
  } catch (err) {
    bridgeLog.error("a2a-bridge", `启动清理任务记录失败：${toMessage(err)}`);
  }
}

/**
 * 装配运行时编排（§2.5）：开 store → 抢 core 租约 → 启动 watcher → 启动 scheduler →
 * `recover()` → 就绪。`unref` 由 lifecycle 按模式给出（stdio=true / http=false）。
 *
 * pidfile **仅常驻模式**写：stdio 桥由宿主作为子进程拉起，若也写 `<dataDir>/bridge.pid`
 * 会覆盖常驻进程的记录（N7 `bridgectl status/stop` 会认错进程）。
 */
function createBridgeRuntime(mode: TransportMode): BridgeRuntime {
  return new BridgeRuntime({
    dataDir: DATA_DIR,
    mode,
    scheduler,
    openStore: openStoreAndPrune,
    pidFile: mode === "http" ? defaultPidFile(DATA_DIR) : null,
  });
}

/** 启动恢复摘要（lifecycle 只回摘要不落日志；此处补日志，承接旧 stdio 路径的 recover 日志） */
function logRecoverySummary(recovery: unknown): void {
  const r = asRecord(recovery);
  if (r === null) return;
  const scanned = typeof r["scanned"] === "number" ? r["scanned"] : 0;
  const failedFeatures = typeof r["failedFeatures"] === "number" ? r["failedFeatures"] : 0;
  const interruptedTasks = typeof r["interruptedTasks"] === "number" ? r["interruptedTasks"] : 0;
  if (scanned === 0 && interruptedTasks === 0) return;
  bridgeLog.info(
    "a2a-bridge",
    `桥重启恢复：扫描非终态 Feature ${scanned}，收敛 failed ${failedFeatures}（interrupted 任务 ${interruptedTasks}）`,
  );
}

/**
 * 网页只读接面接线（v0.5.0 §2.5）：**必须在 `runtime.start()` 之后**调用（否则拿不到 `role`）。
 *
 * 判定式（单一表达式，与 `config.ts` / `types.ts` 注释同源）：
 * `(mode === "http" ? web.enabled : web.allowStdio) && role === "owner"`。
 * - follower **一律不 bind**（同机多桥互抢端口随之消失）；http 形态不读 `allowStdio`，
 *   stdio 形态不读 `enabled`（见 `config.ts` 语义收窄）；
 * - stdio 缺省不 bind：桥是 orch agent 的子进程，由它提供页面会与「网页启动 agent」构成死循环；
 * - **不 throw**：非 loopback / 端口被占 / 未启用 ⇒ 不 bind 且不报错（`startWebTransport` 自吞，
 *   返回未启用句柄）；「无页面」是合法状态，**MCP 工具面不受影响**；
 * - stdio 形态 bind 时 `unref`（否则 listener 持住事件循环 ⇒ 桥不随宿主退出 ⇒ 子进程泄漏）。
 */
async function startWebIfEnabled(mode: TransportMode, readiness: RuntimeReadiness): Promise<void> {
  const web = webConfig();
  // 顺序反转（§2.5 (a)）：此处已过 `runtime.start()` ⇒ `readiness.role` 是权威角色
  const shapeEnabled = mode === "http" ? web.enabled : web.allowStdio;
  if (!shapeEnabled || readiness.role !== "owner") {
    bridgeLog.info(
      "a2a-bridge",
      `网页接面不 bind（mode=${mode}，role=${readiness.role}，形态门=${shapeEnabled ? "开" : "关"}）：` +
        `无页面属合法状态，MCP 工具面不受影响`,
      { host: web.host, port: web.port },
    );
    return;
  }

  try {
    activeWeb = await startWebTransport({
      core: createCore(),
      host: web.host,
      port: web.port,
      // 页面标识（role / pid / startedAt）来自 lifecycle；此处恒非 null（已过 `runtime.start()`）
      readiness: (): { role: string; pid: number; startedAt: string } => ({
        role: readiness.role,
        pid: readiness.pid,
        startedAt: readiness.startedAt,
      }),
      version: BRIDGE_VERSION,
      unref: mode === "stdio",
    });
  } catch (err) {
    // 兜底：网页接面**绝不允许**拖垮 MCP 工具面（契约上 `startWebTransport` 不 throw）
    bridgeLog.error(
      "a2a-bridge",
      `网页接面接线异常（已忽略，MCP 工具面不受影响）：${toMessage(err)}`,
    );
  }
}

/**
 * stdio 接入面（默认）：接入面 + 生命周期编排。
 * 相对旧路径唯一的行为差异是**多一道 core 租约门闩**：owner 照常跑 scheduler/watcher；
 * follower（他进程已持调度权）只提供工具面（§2.4 / §2.8 单桥约束）。
 */
async function startStdioBridge(): Promise<void> {
  const runtime = createBridgeRuntime("stdio");
  activeRuntime = runtime;
  const readiness: RuntimeReadiness = runtime.start();
  logRecoverySummary(readiness.recovery);
  // 启动 worker 回调端点（v0.4.0 §2.6；`callback.enabled` 默认关，关闭时 startCallbackServer 空操作）
  startCallbackServer(callbackConfig());
  const core = createCore();
  activeServer = await startStdioTransport(core);
  console.error(
    `[a2a-bridge] MCP stdio server ready（role=${readiness.role}）: a2a_projects / a2a_tasks / a2a_call / a2a_task_status / a2a_cancel / a2a_feature_create / a2a_feature_status / a2a_feature_advance / a2a_feature_approve / a2a_feature_cancel`,
  );
  // 网页接面在接入面就绪**之后**接线（缺省不 bind；`allowStdio=true` 时经 unref 了才不持进程）
  await startWebIfEnabled("stdio", readiness);
}

/**
 * 常驻接入面（http）：**先 `listen`** —— 端口被占即 fail fast，且此时尚未持锁 / 未写 pidfile
 * （§2.4 第 4 条「端口绑定即单实例互斥」）；随后走 lifecycle 编排。
 * `/health` 在 `recover()` 落地前返回 503 + `status="starting"`（就绪信号晚于 `recover()`，§2.5）。
 *
 * ⚠ **顺序反转（v0.5.0 §2.5 (a)）**：网页接面**必须在 `runtime.start()` 之后**按 `role` 决定是否
 * bind —— 不能沿用 MCP 接入面这套「先 listen 后抢租约」（那时还不知道自己是 owner 还是 follower）。
 */
async function startHttpBridge(): Promise<void> {
  const { host, port, path } = transportConfig().http;
  let ready = false;
  const runtime = createBridgeRuntime("http");
  activeRuntime = runtime;
  const core = createCore();
  const handle = await startHttpTransport({
    core,
    host,
    port,
    path,
    isReady: () => ready,
    role: () => runtime.currentRole,
    version: BRIDGE_VERSION,
    onShutdown: shutdown,
  });
  activeHttp = handle;
  const readiness: RuntimeReadiness = runtime.start();
  logRecoverySummary(readiness.recovery);
  startCallbackServer(callbackConfig());
  ready = true;
  bridgeLog.info(
    "a2a-bridge",
    `MCP HTTP 接入面就绪：http://${host}:${handle.port}${path}（role=${readiness.role}，pid=${readiness.pid}）`,
    {
      health: `http://${host}:${handle.port}/health`,
      shutdown: `http://${host}:${handle.port}/shutdown`,
    },
  );
  // 网页接面**排在 MCP 就绪之后**接线：它不参与 MCP 就绪语义，且绝不允许拖慢 / 拖垮工具面
  await startWebIfEnabled("http", readiness);
}

async function main(): Promise<void> {
  if (transportMode() === "http") {
    await startHttpBridge();
    return;
  }
  await startStdioBridge();
}

/**
 * 优雅停机（信号 / `POST /shutdown` 共用；§2.5 反序 + 排空）：
 * **关网页接面（最先，`close()` 内含 keep-alive 兜底）** → 停收新请求（HTTP listener）→ 停 scheduler
 * → 排空在飞任务与看护（等待至宽限上限，**不取消**远端 A2A 任务）→ 停 watcher → 关 store →
 * 释放租约 → 删 pidfile → 关 MCP server → 退出。幂等（`stopping` 守卫）。
 */
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  void (async (): Promise<void> => {
    try {
      // 网页接面**最先关**（§2.5 (e)）：浏览器 keep-alive 会拖住 server.close()，
      // 故必须早于排空停机；`close()` 已含 closeIdleConnections + 1s 兜底 closeAllConnections。
      const web = activeWeb;
      activeWeb = null;
      if (web !== null) await web.close();
      const handle = activeHttp;
      activeHttp = null;
      if (handle !== null) await handle.close();
      stopCallbackServer();
      const runtime = activeRuntime;
      activeRuntime = null;
      if (runtime === null) {
        // 早到信号（lifecycle 尚未装配）：按旧路径兜底收尾
        scheduler.stop();
        closeSessionStore();
      } else {
        const summary = await runtime.stop();
        bridgeLog.info("a2a-bridge", `停机完成：${JSON.stringify(summary)}`);
      }
      const server = activeServer;
      activeServer = null;
      if (server !== null) await server.close();
    } catch (err) {
      bridgeLog.error("a2a-bridge", `停机异常：${toMessage(err)}`);
    } finally {
      process.exit(0);
    }
  })();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/**
 * 本模块是否被 node **作为入口脚本直接执行**（v0.6.0 §3.1-N2）。
 *
 * 为什么需要：单测要驱动 `createCore()` 的领域入口（成员判据 / 缓存不绕过 / 出站请求计数），
 * 而本模块顶层 `main()` 会**拉起整座桥**（core 租约 / DB / 传输面）⇒「import 即产生副作用」
 * 使 `bridge/index.ts` 不可被单测 import（`test/web.test.ts` 已书面记录该限制）。
 * 判定式只比较 `process.argv[1]` 与 `import.meta.url`：三种真实启动路径
 * （`orch/opencode.json.example` 的 `node …/dist/bridge/index.js`、`bridgectl.mjs` 的 spawn、
 * `npm run bridge`）的 `argv[1]` 都指向本文件 ⇒ 判定恒为真，**生产行为零变化**；
 * 仅「被 import」时不再自动启动。
 */
function isEntryModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  const target = resolve(entry);
  // Windows 路径大小写不敏感（盘符 / 路径段大小写可能不同）⇒ 折半比较
  return process.platform === "win32"
    ? self.toLowerCase() === target.toLowerCase()
    : self === target;
}

if (isEntryModule()) {
  main().catch((err: unknown) => {
    console.error(`[a2a-bridge] fatal: ${toMessage(err)}`);
    process.exit(1);
  });
}
