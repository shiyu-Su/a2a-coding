/**
 * MCP 泛型桥（orch 工具面）· **v0.7.0 pull 连接模型**。
 *
 * 只暴露固定工具面，不按 skill 生成工具、不做动态注册（不发 `tools/list_changed`）：
 * - `a2a_projects()`                    读**桥注册表投影**（`runners` / `runner_projects`）+ `runners[]`
 * - `a2a_tasks(project, state?, limit?)` 按项目列出本地任务记录（纯本地 + 只读探测）
 * - `a2a_call(project, message, contextId?)`  解析项目→机器（注册视图）→ 入队；由 Runner 领取执行
 * - `a2a_task_status(taskId)`           读**本地回传落库**（远端 `tasks/get` 已退役）
 * - `a2a_cancel(taskId)`                下发 `cancel-task` 命令（经 `/runner/connect`，非 A2A 出站）
 *
 * **桥不再出站直连 machine**（A6 出站整体退役）：协议版本由 Runner **入站**注册
 * （`/runner/register`）时校验；项目发现 / 定位改读注册表投影；任务结果由 Runner
 * `/runner/result` 回传落库。
 *
 * 依赖：`../session/store.js`（任务态 / 注册表持久化）。
 *
 * 跨 MCP 边界的错误一律结构化返回（`{ ok: false, code, error }`），不抛出。
 */
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appRootFromModule } from "../app-root.js";
import { aggregateProjectGroup, loadMachinesConfig, memberKey } from "../config.js";
import { BRIDGE_VERSION } from "../version.js";
import {
  BridgeRuntime,
  defaultPidFile,
  readBridgePidFile,
  type RuntimeReadiness,
} from "../runtime/lifecycle.js";
import {
  LEASE_PROBE_TIMEOUT_MS,
  probeHttpHealth,
  reclaimWedgeCoreLease,
  type HealthEndpoint,
} from "../runtime/core-lease.js";
import {
  type AgentKind,
  type ArtifactRecord,
  type EventRecord,
  type FeatureRecord,
  type InputArtifactRef,
  type MachineRef,
  type ProjectGroup,
  type ProjectStatus,
  type TaskListItem,
  type TaskRecord,
  type TaskState as DomainTaskState,
  type TaskType,
  type TransportConfig,
  type TransportMode,
  type WebConfig,
} from "../types.js";
import {
  appendEvent,
  createTask,
  DEFAULT_SESSION_DB,
  enqueueTask,
  getArtifact,
  getDefaultStore,
  getFeature,
  getQueuedTask,
  getRunner,
  getTask,
  latestEventId,
  listArtifactsByFeature,
  listArtifactsByProducer,
  listEvents,
  listRunnerProjects,
  listRunners,
  listTasks,
  pruneTasks,
  truncatePrompt,
  updateTaskState,
  close as closeSessionStore,
  type EventVisibilityScope,
  type RunnerProjectRecord,
  type RunnerRecord,
} from "../session/store.js";
import { bridgeLog } from "./bridge-log.js";
import {
  isTaskWatched,
  setTaskWatcherDegradationSink,
  startTaskWatcher,
  WATCHER_MAX_CONSECUTIVE_FAILURES,
  type WatchedTaskView,
} from "./task-watcher.js";
/**
 * 任务 id 双向解析（v0.6.1 REQ-05 §2.5 白捡 / A5-5）——
 * 从本模块抽出为 `task-lookup.ts`（单一事实源；避免进程入口模块被单测整座拉起）。
 */
import { resolveTaskLookup } from "./task-lookup.js";
import { createRunnerEndpoints, type RunnerEndpointHandle } from "./runner.js";
import { createVersionsEndpoints } from "./versions-endpoints.js";
import { createProjectVersionsEndpoints } from "./project-versions-endpoints.js";
import { activateVersionForFeature } from "./versions-activation.js";
import {
  FeatureScheduler,
  isLocalTerminalTask,
  type FeatureDispatchResult,
} from "./scheduler.js";
import {
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCancel,
  handleFeatureCreate,
  handleFeatureStatus,
  handleFeatureTrace,
  ownershipFailure,
  projectTaskVisibility,
  type FeatureAdvanceArgs,
  type FeatureAdvanceSuccess,
  type FeatureApproveArgs,
  type FeatureCancelArgs,
  type FeatureCreateArgs,
  type FeatureCreateSuccess,
  type FeatureStateChangeSuccess,
  type FeatureStatusArgs,
  type FeatureStatusSuccess,
  type FeatureToolFailure,
  type FeatureTraceArgs,
  type FeatureTraceSuccess,
  type TaskDiagnosticsView,
} from "./feature-tools.js";
import {
  startHttpTransport,
  type HttpTransportHandle,
} from "./transports/http.js";
import { startWebTransport, type WebTransportOutcome } from "./transports/web.js";
// v0.9.4 O1：配置面受控写工具落点（全组面，不吃连接身份）
import {
  writeGroupConfig,
  type ConfigWriteGroupArgs,
  type ConfigWriteGroupOutcome,
} from "./config-write.js";
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

/**
 * v0.7.0 A6：`LAUNCHER_TIMEOUT_MS` / `LAUNCHER_ENSURE_TIMEOUT_MS` / `A2A_REQUEST_TIMEOUT_MS` /
 * `A2A_CARD_TIMEOUT_MS` 已随出站路径退役（桥不再直连 Launcher / A2A；任务经 Runner 队列往返）。
 */
/** `a2a_call` 同步等待预算；到点仍未终态则返回 working + taskId 供轮询（半异步；须小于 host MCP client 请求超时） */
const SYNC_BUDGET_MS = readPositiveIntEnv("SYNC_BUDGET_MS", 30_000);
/** 任务轮询间隔 */
const POLL_INTERVAL_MS = readPositiveIntEnv("POLL_INTERVAL_MS", 1_000);
/**
 * 后台看护对账间隔（v0.7.0 A5）：pull 模型下 `poll` 读**本地行**（SQLite 单查），开销低；
 * 2s 足以在 Runner 回传落库后及时 `persist` + 续推 DAG（同步预算内已终态者不走看护）。
 */
const TASK_WATCHER_POLL_INTERVAL_MS = readPositiveIntEnv("TASK_WATCHER_POLL_INTERVAL_MS", 2_000);
/** 派发注入上游产物时的内联字符上限；超出仅保留头部 + 截断说明（完整内容按 uri 引用） */
const ARTIFACT_INLINE_MAX_CHARS = readPositiveIntEnv("ARTIFACT_INLINE_MAX_CHARS", 4_000);

/** `a2a_events` 单次返回条数上限 */
const EVENTS_PAGE_LIMIT = readPositiveIntEnv("EVENTS_PAGE_LIMIT", 100);
/** `a2a_wait` 除订阅唤醒外对 DB 的轮询对账间隔（兜底：非回调路径写入的事件） */
const EVENT_WAIT_POLL_MS = readPositiveIntEnv("EVENT_WAIT_POLL_MS", 500);
/** `a2a_wait` 内部 cap：须 < `SYNC_BUDGET_MS`（宿主 MCP 请求超时），留 5s 余量 */
const EVENT_WAIT_MAX_MS = Math.max(1_000, SYNC_BUDGET_MS - 5_000);
/**
 * 事件 kind：`queued` 无人领取的一次性提示（v0.7.0 A5 / B3）。
 * **不表示失败**（不判 `failed`、不计连续失败）；处置走 `retryTaskIds` / `cancel`。
 */
const EVENT_TASK_UNCLAIMED = "task.unclaimed";

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

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
// 线协议握手 / Launcher HTTP 出站 —— **v0.7.0 A6 已整体退役**
// ---------------------------------------------------------------------------
// pull 模型下桥不再出站直连 Launcher（`GET /health` 握手 / `GET /projects` / `POST .../ensure`）：
// 协议版本校验改由 Runner 注册端点（`/runner/register`，O3）承载；项目发现改读注册表投影。
// 原 `performHandshake` / `ensureProtocol` / 握手缓存 / `fetchJson` 已删除（「桥→machine 出站」
// 在 index.ts 内不再存在）。

// ---------------------------------------------------------------------------
// 项目投影（v0.7.0 A6：数据源 = 注册表 `runner_projects`，出站扫描已退役）
// ---------------------------------------------------------------------------

/**
 * `a2a_projects` 出参的项目投影（v0.7.0 A6 **字段白名单**）。
 *
 * 数据源 = Runner 上报的运行态投影（`runner_projects`）。**不含** `workspace`（绝对路径）/
 * `agentConfig` / `risk` / 任何 Runner 内部字段（`runnerId` / `protocolVersion` / token）。
 */
interface ProjectSummary {
  projectId: string;
  agentKind: AgentKind;
  a2aPort: number;
  status: ProjectStatus["status"];
  endpoint: string | null;
  startedAt: string | null;
}

/** 注册表项目行 → 出参投影（逐字段显式取值；白名单之外一律不出口） */
function toProjectSummary(rec: RunnerProjectRecord): ProjectSummary {
  return {
    projectId: rec.projectId,
    agentKind: rec.agentKind,
    a2aPort: rec.a2aPort,
    status: rec.status,
    endpoint: rec.endpoint,
    startedAt: rec.startedAt,
  };
}

type LocateResult =
  | { ok: true; machine: MachineRef; project: ProjectSummary }
  | { ok: false; code: string; error: string };

type MachinesLoad =
  | { ok: true; machines: MachineRef[]; groups: ProjectGroup[] }
  | { ok: false; error: string };

/**
 * 机器清单 + **项目组数组**（v0.6.0 §2.1 总纲 2；v0.8.6 §2.2 起改为产 `groups[]`，
 * 「传哪个组」由 {@link resolveGroup} 按连接身份解析）。
 *
 * **不新增进程级缓存**：与 `machines[]` 同生命周期 —— 每次调用现读配置文件，
 * 配置热改（成员增删 / 组增删）**即时生效**，无需重启桥。`projectGroup` 段缺失 ⇒
 * `groups: []`（全量接纳，旧 `config.json` 零改动可用）；段存在但非法 ⇒
 * `loadMachinesConfig` 抛错 ⇒ 此处 `{ ok: false }` ⇒ 调用方一律 `machines_config_error`
 * （**绝不 fail-open**，I2）。
 */
function loadMachines(): MachinesLoad {
  try {
    const config = loadMachinesConfig(MACHINES_CONFIG_PATH);
    return {
      ok: true,
      machines: config.machines,
      // `groups` 只由 `loadMachinesConfig` 产出（恒有数组）；`??` 仅为可选字段的类型收窄
      groups: config.groups ?? [],
    };
  } catch (err) {
    return {
      ok: false,
      error: `加载机器清单失败（${MACHINES_CONFIG_PATH}）：${toMessage(err)}`,
    };
  }
}

/**
 * **身份 → 组视图**（v0.8.6 §2.2 / §2.3）：「传哪个组」的唯一入口。
 * 成员判定函数（`isMemberProject` / `assertMember` / `memberMachines`）**形参即组、判据不变**（I1），
 * 本函数只负责把连接身份（= URL 路径首段组名，`http.ts#matchMcpPath` 提取，经 `coreFor(identity)` 透入）
 * 解析成判定所用的组。
 *
 * - `identity === null`（无身份）⇒ **全组聚合视图**（与 `MachinesConfig.projectGroup` 同源，
 *   复用 `config.ts#aggregateProjectGroup`，禁第二套并集拼接）：
 *   未配组 ⇒ `defaultProjectGroup()`（`selective:false` 全量接纳，HTTP 匿名合法）；
 *   配了组 ⇒ 匿名在 HTTP 层已被 403 门挡住（§2.2 G5），此分支实际只服务 web 运维视图（§2.7 / N6）；
 * - `identity` 命中组名 ⇒ 该组；
 * - `identity` **未命中任何组**（如组名拼错）⇒ **fail-closed 空组**（`selective:true`、零成员，
 *   `name` 保留该身份）：该连接一切操作均 `project_not_a_member`（错误文案直接暴露所连组名），
 *   **绝不回退全量接纳**（I2）。
 *
 * 纯函数（无 I/O）；现读、不按身份缓存（身份解析每请求成本 = 数组线性查）。
 */
export function resolveGroup(
  identity: string | null,
  groups: readonly ProjectGroup[],
): ProjectGroup {
  if (identity === null) {
    return aggregateProjectGroup(groups);
  }
  const hit = groups.find((g) => g.name === identity);
  if (hit !== undefined) return hit;
  return {
    name: identity,
    members: [],
    memberKeys: new Set<string>(),
    memberMachineIds: new Set<string>(),
    selective: true,
  };
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

/**
 * 找「**属另一组**」：目标 `(machineId?, projectId)` 由**非本连接组**的某组声明成员 ⇒ 返回该组名，
 * 否则 `null`。用于 {@link notAMemberFailure} 区分两类拒绝文案（§2.3 / §6.1-3）。
 *
 * 判据**同源于** {@link isMemberProject}（`memberKey` 单一构造）；`callerGroup` 以**引用相等**跳过
 * （`resolveGroup` 命中配置组时返回 `groups` 内**同一对象**）。无身份连接（`identity=null`）拿到的是
 * **聚合组**（并集，非 `groups` 成员）—— 若目标不在聚合组内 ⇒ 它不在任何组 ⇒ 本函数恒 `null`（不误报
 * 「属另一组」）。`memberMachineIds` × `memberKey` 遍历与 {@link assertMember} 的 `null` 机器形态同构。
 */
function findOtherOwnerGroup(
  groups: readonly ProjectGroup[],
  callerGroup: ProjectGroup,
  machineId: string | null,
  projectId: string,
): string | null {
  for (const g of groups) {
    if (g === callerGroup) continue;
    if (machineId !== null) {
      if (g.memberKeys.has(memberKey(machineId, projectId))) return g.name ?? "(未命名组)";
    } else {
      for (const candidate of g.memberMachineIds) {
        if (g.memberKeys.has(memberKey(candidate, projectId))) return g.name ?? "(未命名组)";
      }
    }
  }
  return null;
}

/**
 * 构造 `project_not_a_member` 结构化失败（`machineId === null` = 未知落点机器的通用表述）。
 *
 * v0.8.6 §2.3：**两类拒绝文案可区分**（§6.1-3 明文验收）——
 * - **非本组成员**（`groups` 未给 / 目标不在任何组）：登记指引（既有文案，保持不破坏既有断言）；
 * - **属另一组**（给了 `groups` 且目标由他组声明）：点明「属另一组 + 跨组本版不支持」，
 *   但**不泄漏他组的完整成员清单**（只给组名，组名本身是连接可见的 URL 身份）。
 */
function notAMemberFailure(
  machineId: string | null,
  projectId: string,
  group: ProjectGroup,
  groups?: readonly ProjectGroup[],
): Failure {
  const where = machineId === null ? `项目 ${projectId}` : `项目 ${projectId}@${machineId}`;
  const other =
    groups === undefined
      ? null
      : findOtherOwnerGroup(groups, group, machineId, projectId);
  if (other !== null) {
    return {
      ok: false,
      code: "project_not_a_member",
      error:
        `${where} 属另一项目组「${other}」，不是本连接${group.name === null ? "" : `项目组「${group.name}」`}的可见 / 可派对象：` +
        `组间成员互斥，跨组操作本版不支持（归 v0.11.0 跨组协作 / 授权）。`,
    };
  }
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
 *   （`dispatchTask` 落点已知后的**精确成员复核**用）；
 * - `machineId === null` ⇒ 只要求「**该项目被任一成员机器声明**」—— 派发 / 登记前置
 *   （`dispatchTask` / `registerFeatureNode` / `locateProject`）尚**不知道落点机器**，
 *   用本形态可**零 I/O** 判定「未被选中」，避免把「没选它」降级成 `project_not_found`。
 * - `groups`（可选，v0.8.6 §2.3）⇒ 传入全组数组以启用「属另一组」区分文案；缺省 ⇒ 沿用「非本组成员」单文案。
 *
 * 两种形态**同源**：给定机器走 {@link isMemberProject}；未给定机器遍历
 * `memberMachineIds` × `memberKey` —— 无第二套拼接 / 第二套判据（I1）。
 */
function assertMember(
  machineId: string | null,
  projectId: string,
  group: ProjectGroup,
  groups?: readonly ProjectGroup[],
): Failure | null {
  if (!group.selective) return null;
  if (machineId !== null) {
    return isMemberProject(machineId, projectId, group)
      ? null
      : notAMemberFailure(machineId, projectId, group, groups);
  }
  for (const candidate of group.memberMachineIds) {
    if (group.memberKeys.has(memberKey(candidate, projectId))) return null;
  }
  return notAMemberFailure(null, projectId, group, groups);
}

/**
 * 参与「发现 / 定位」的机器集合：`selective: false` ⇒ 全部机器；否则 ⇒ 配置声明的成员机器。
 *
 * `handleProjects` / `locateProject` **共用同一集合** ——
 * 否则出现「定位得到、展示没有」的双份判据（§2.2）。
 */
function memberMachines(machines: readonly MachineRef[], group: ProjectGroup): MachineRef[] {
  if (!group.selective) return Array.from(machines);
  return machines.filter((m) => group.memberMachineIds.has(m.machineId));
}

/**
 * 解析 `project -> machine`（v0.7.0 A6：**注册视图**为唯一事实源，出站扫描退役）。
 *
 * pull 模型下桥不再出站扫描各机 `GET /projects`：`runner_projects` 是各机 Runner 主动上报的
 * 运行态投影（D3），本函数只读该投影 + 静态配置成员集合（`projectGroup`），**全程零出站**。
 *
 * 判据顺序：
 * ① `assertMember(null, …)`：未被任一成员机器声明 ⇒ `project_not_a_member`（**不降级**成
 *    `project_not_found`、**不回落**全量扫描）；
 * ② 成员机器范围内查注册表：命中 `(machineId, projectId)` 且**精确成员** ⇒ 返回；
 * ③ 未命中：全部成员机器都「Runner 未注册 / 心跳超时」⇒ `launcher_unreachable`（语义改判：
 *    原「握手失败」现指「Runner 未注册 / 心跳超时」，仅状态报告用途）；
 *    否则 ⇒ `project_not_found`。
 */
async function locateProject(projectId: string, identity: string | null = null): Promise<LocateResult> {
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error };
  }
  const group = resolveGroup(identity, config.groups);
  const targets = memberMachines(config.machines, group);

  const denied = assertMember(null, projectId, group, config.groups);
  if (denied !== null) {
    return { ok: false, code: denied.code, error: denied.error };
  }

  let runners: RunnerRecord[];
  try {
    runners = listRunners();
  } catch (err) {
    return {
      ok: false,
      code: "runner_registry_error",
      error: `读取 Runner 注册表失败：${toMessage(err)}`,
    };
  }
  const byMachine = new Map(runners.map((r) => [r.machineId, r]));
  const unreachable: string[] = [];
  for (const machine of targets) {
    const runner = byMachine.get(machine.machineId);
    if (runner === undefined) {
      unreachable.push(`${machine.machineId}: Runner 未注册`);
      continue;
    }
    if (runner.state !== "online") {
      unreachable.push(
        `${machine.machineId}: Runner 心跳超时（lastHeartbeatAt=${runner.lastHeartbeatAt}）`,
      );
    }
    let project: RunnerProjectRecord | undefined;
    try {
      project = listRunnerProjects(runner.runnerId).find((p) => p.projectId === projectId);
    } catch (err) {
      return {
        ok: false,
        code: "runner_registry_error",
        error: `读取 Runner 项目投影失败（machineId=${machine.machineId}）：${toMessage(err)}`,
      };
    }
    if (project === undefined) continue;
    // 精确成员落点（投影已按注册上报，此处再判一次 = 防配置热改后被当作成员命中）
    if (!isMemberProject(machine.machineId, projectId, group)) continue;
    return { ok: true, machine, project: toProjectSummary(project) };
  }
  if (targets.length > 0 && unreachable.length === targets.length) {
    return {
      ok: false,
      code: "launcher_unreachable",
      error:
        `无法定位项目 ${projectId}：Runner 未注册 / 心跳超时（${unreachable.join("; ")}）。` +
        `等待该机 Runner 出站注册后重试。`,
    };
  }
  const suffix = unreachable.length > 0 ? `（部分机器不可达：${unreachable.join("; ")}）` : "";
  return {
    ok: false,
    code: "project_not_found",
    error: `未在 Runner 注册表找到项目 ${projectId}${suffix}`,
  };
}

// ---------------------------------------------------------------------------
// A2A Client / 结果处理 —— **出站已退役（v0.7.0 A6）**
// ---------------------------------------------------------------------------
// 桥不再建 A2A client、不再 `tasks/get` / `tasks/cancel` / `message/send`：任务下发与结果回传
// 全走 Runner 队列（`/runner/connect` 领取 → 本地执行 → `/runner/result` 回传落库）。
// `ensureProject` / `createA2AClient` / `pollTaskUntilSettled` / `deferWorkingTask` 已删除；
// 本地结果读取复用 `textFromArchivedArtifacts` / `parseArchivedArtifacts`。

// ---------------------------------------------------------------------------
// 本地结果处理
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

/** 从本地存档的 artifactsJson（ArtifactSummary[]）拼接文本；兼容无 text 的旧记录 */
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
 * 进程级 Runner 入站端点处理器（v0.7.0 A4）。
 *
 * 仅 `transport.mode === "http"` 时在 `startHttpBridge` 创建并注入 `startHttpTransport`
 * （`/runner/*` 路由 + `wake` 立即下发共用同一实例）；未接线时保持 `null`
 * ⇒ 既不注册 `/runner/*`，`wake` 亦为 no-op（单测 / 早退路径零回归）。
 */
let runnerEndpoints: RunnerEndpointHandle | null = null;

/**
 * 唤醒挂起的 `/runner/connect`（**最佳努力**）：新任务入队后立即下发，避免等满一个 hold
 * 周期。Runner 未连接（无挂起长轮询）时静默 no-op —— 任务仍在队列中，Runner 下轮轮询照常领取。
 * 失败绝不阻断派发（`wake` 只是时延优化，不是投递保证）。
 */
function wakeRunner(machineId: string): void {
  const handle = runnerEndpoints;
  if (handle === null) return;
  try {
    handle.wake(machineId);
  } catch (err) {
    bridgeLog.warn("a2a-runner", `唤醒 Runner 长轮询失败（最佳努力，忽略）：${toMessage(err)}`);
  }
}

/**
 * 派发（v0.7.0 A4，pull 连接模型）：**入队**取代「直连 A2A」。
 *
 * 新主链（对外契约不变：仍可能同步拿到终态，超预算返回 `working` + `taskId` 句柄）：
 * ① 成员前置**同步零 I/O fail-fast**（`assertMember(null, …)`；非成员绝不发一个请求）；
 * ② `projectId → machineId` 解析（v0.7.0 A6：**读 Runner 注册表投影**，零出站）；
 *    落点已知后再现读配置做**精确成员断言**（零 I/O 硬兜底，
 *    防「定位成功与入队之间被移出成员」）；
 * ③ `enqueueTask`（`queue_state=queued` + `dispatch_guard` 幂等键；重复入队零写入、不刷新 FIFO）；
 * ④ `wake(machineId)` 立即下发（最佳努力）；**无 Runner 在线照常入队、不拒绝**；
 * ⑤ `wait=true` ⇒ 同步等待至终态 ≤ `SYNC_BUDGET`；超预算返回 `working` + `taskId`。
 *
 * 桥侧**不再** `ensureProject` / A2A `message/send` —— 执行由目标机 Runner 经 `/runner/connect`
 * 领取后本地完成，结果经 `/runner/result` 回传落库（`upsertTaskResult`）。A2A 出站函数与
 * 「桥→machine 出站」已在 A6 **整体删除**（本文件内零 `fetch`）。
 */
export type DispatchOutcome =
  | { ok: false; code: string; error: string; contextId: string }
  | {
      ok: true;
      contextId: string;
      /** 本地任务 id（= 入队键；pull 模型下独立任务不再以 A2A 远端 id 为主键） */
      taskId: string;
      /** 同步预算内是否已落终态（`false` = 仍在飞 / 尚未被领取，交宿主持句柄轮询） */
      settled: boolean;
      state: DomainTaskState;
      text: string | null;
      artifacts: ArtifactSummary[];
    };

/** `dispatchTask` 入参（A4 测试接缝：enqueue 幂等 / 成员错零网络 / 超预算 working 句柄） */
export interface DispatchTaskInput {
  taskId: string;
  projectId: string;
  contextId: string;
  /** `false` = 全异步：入队后立即返回 `working` 句柄，不等待领取 / 终态 */
  wait: boolean;
  /**
   * 独立任务（inquiry）建行参数：**全部前置断言通过后**才落库 ⇒ 成员错 / 定位失败**不留脏行**。
   * Feature 节点行已存在（`registerFeatureNode` 已建）⇒ 传 `null`，不重复落库。
   * `taskType`（v0.10.2 增补三 E-1）= 职责位**声明原样透传**（缺省 undefined = 落库 NULL ⇒
   * 读侧归一 `unit_agent`）；**与 `lane` 正交** —— inquiry 建行仍恒 `lane='read'`。
   */
  newTask: { prompt: string; dispatchMessage: string; taskType?: TaskType | null } | null;
  /**
   * 连接身份（v0.8.6 §2.2；`null` / 缺省 = 无身份 ⇒ 全组聚合视图）。
   * - **inquiry 路径**（`handleCall`）：由 `coreFor(identity)` 绑定注入 = 调用方连接身份；
   * - **Feature 节点派发路径**（`dispatchFeatureNode`，req01 补正 Y-1）：注入
   *   `feature.ownerGroup` ⇒ 成员判据按该 Feature 的 **owner 组**，与 R-1 挂载归属判据
   *   同源一致；`owner_group === null`（未配组 / 存量 / 3300 运维全量视图）⇒ 传 `null`
   *   = 全组聚合视图（旧行为，零破坏）。
   * 注：`owner_group` 既 gate 五个 Feature 工具出口（`ownershipFailure`），也经本参数 gate
   * Feature 节点派发的成员判据 —— 原注释「派发暂无身份 / 判定归 N4」不准确，已更正。
   */
  identity?: string | null;
}

/** 未终态（超预算 / 全异步）的派发返回：`working` + 本地 `taskId` 句柄 */
function workingDispatchOutcome(taskId: string, contextId: string): DispatchOutcome {
  return {
    ok: true,
    contextId,
    taskId,
    settled: false,
    state: "working",
    text: null,
    artifacts: [],
  };
}

/** 本地任务行 → 看护视图（缺行 ⇒ null） */
function watchedTaskView(taskId: string): WatchedTaskView | null {
  const rec = getQueuedTask(taskId);
  if (rec === null) return null;
  return {
    taskId: rec.taskId,
    state: rec.state,
    queueState: rec.queueState,
    claimedBy: rec.claimedBy,
    artifactsJson: rec.artifactsJson,
    text: rec.text,
    featureId: rec.featureId,
  };
}

/** 本地回传态是否终态（与 `isLocalTerminalTask` 同口径） */
function isSettledView(task: WatchedTaskView): boolean {
  return (
    task.state === "completed" ||
    task.state === "failed" ||
    task.state === "input-required" ||
    task.state === "blocked"
  );
}

// ---------------------------------------------------------------------------
// 降级可见（v0.8.8 O5）—— 进程内「最近观测态」登记表
//
// 三处保护性降级 catch（领取超期判据 / 心跳超期清算 / 孤儿墙钟清算）今天只打日志、
// 保护功能静默失效；本登记表把这些「静默」聚合成可观测快照，经 /health 的 `degraded[]`
// 出口。语义：粘滞「最近一次观测」—— `mark` 记录首次观测时刻（`since`），重复 `mark` 只
// 更新 `reason` 不改 `since`；`clear` 在成功 tick 时移除该项。**纯观测**，不改变任何降级
// 行为（catch 的返回值语义原样保留）。
// ---------------------------------------------------------------------------

/** /health `degraded[]` 的单项（`since` = 首次观测的 epoch ms） */
export interface DegradedItem {
  key: string;
  reason: string;
  since: number;
}

/**
 * 降级登记所需的最小 sink 视图（注入 runner / task-watcher，避免跨模块 value 环引用；
 * `DegradationRegistry` 结构上满足之）。
 */
export interface DegradationSink {
  mark(key: string, reason: string): void;
  clear(key: string): void;
}

/** 进程内降级登记表：粘滞最近观测态（见上节注释） */
export class DegradationRegistry implements DegradationSink {
  private readonly entries = new Map<string, DegradedItem>();

  mark(key: string, reason: string): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.reason = reason; // 粘滞：since 保持首次观测时刻
      return;
    }
    this.entries.set(key, { key, reason, since: Date.now() });
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  /** 当前降级快照（浅拷贝，出口给 /health；无降级 ⇒ 空数组） */
  snapshot(): DegradedItem[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }
}

/** 桥进程内单例登记表（装配点注入 runner / task-watcher，并经 /health getter 出口） */
const degradations = new DegradationRegistry();

/** 领取超期判据降级键（index 侧自用；另两键在 runner.ts，watcher 键在 task-watcher.ts） */
const DEGRADED_CLAIM_STALE = "claim.stale-criterion";

/**
 * 领取是否已超期（B2 判据）：`claimedBy` 对应 Runner 注册行的 `last_heartbeat_at` 静默
 * ≥ `runner.heartbeatTimeoutMs` ⇒ 超期（O7 清算应回收）。
 * 无注册行 / 配置不可读 / 时间戳非法 ⇒ **保守判「未超期」**（不主动回收，交 O7 周期清算兜底）。
 * O5：读取失败（catch）⇒ 登记降级；本轮读取成功 ⇒ 清除降级（判据健康）。返回值语义不变。
 */
function isClaimHeartbeatStale(task: WatchedTaskView): boolean {
  if (task.claimedBy === null) return false;
  try {
    degradations.clear(DEGRADED_CLAIM_STALE); // 先按健康；任一读取抛错将在 catch 重新标降级
    const runner = getRunner(task.claimedBy);
    if (runner === null) return false;
    const heartbeat = Date.parse(runner.lastHeartbeatAt);
    if (!Number.isFinite(heartbeat)) return false;
    const timeoutMs = loadMachinesConfig(MACHINES_CONFIG_PATH).runner.heartbeatTimeoutMs;
    return Date.now() - heartbeat >= timeoutMs;
  } catch (err) {
    degradations.mark(DEGRADED_CLAIM_STALE, `领取超期判据读取失败：${toMessage(err)}`);
    bridgeLog.warn("a2a-bridge", `领取超期判据读取失败（task=${task.taskId}）：${toMessage(err)}`);
    return false;
  }
}

/**
 * 启动本地看护（**v0.7.0 A5 接缝**；`dispatchTask` 在「未在同步预算内终态」返回前调用一次）。
 *
 * pull 模型下任务终态由 Runner 回传落库（`/runner/result` → `upsertTaskResult`），桥侧**无远端
 * 轮询**。本接缝把「入队后如何等到终态并续推」收敛为：看护周期读**本地行**，命中终态即
 * `persist`（`updateTaskState` 路径）+ `onSettled`（Feature 节点据此 `notifyTaskSettled` 续推 DAG）。
 *
 * 兜底（改造文档 §1.3 B2/B3）：
 * - 领取者心跳超期 ⇒ 调 O7 `sweepStale()`（requeue + `task.stale`；**stale ≠ failed**、不 `stop`）；
 * - `queued` 无人领取 ⇒ 仅发 `task.unclaimed` 事件提示（不判 `failed`、不计连续失败）。
 *
 * 同 taskId 已有看护时由 `startTaskWatcher` 去重（返回 false 即静默，幂等）。
 */
function startLocalTaskWatcher(taskId: string): void {
  const record = getTask(taskId);
  const featureId = record?.featureId ?? null;
  startTaskWatcher({
    taskId,
    poll: () => watchedTaskView(taskId),
    isSettled: isSettledView,
    persist: (task) => {
      // 复用 updateTaskState 路径（CAS；已终态行不覆盖、不重复写 `task.settled` 事件）
      updateTaskState(task.taskId, task.state, task.artifactsJson, task.text);
    },
    isClaimStale: isClaimHeartbeatStale,
    reclaimStale: () => {
      const handle = runnerEndpoints;
      if (handle === null) return;
      handle.sweepStale();
    },
    onUnclaimed: (task) => {
      appendEvent({
        featureId: task.featureId ?? featureId,
        taskId,
        kind: EVENT_TASK_UNCLAIMED,
        state: "queued",
        payload: JSON.stringify({
          projectId: record?.projectId ?? null,
          contextId: record?.contextId ?? null,
          note: "queued 无人领取：不自动失败、不计连续失败（B3）；处置走 retryTaskIds / cancel",
        }),
      });
      signalEvents();
    },
    onSettled: (task, outcome) => {
      if (task === null || outcome.abandoned) {
        bridgeLog.warn(
          "a2a-bridge",
          `任务 ${taskId} 看护放弃（本地行连续读取失败）：不判 failed、不 stop，交宿主核实（retryTaskIds / cancel）`,
        );
        return;
      }
      // 终态已由 persist 落库；Feature 节点据此续推 DAG（无 Feature 归属 = 独立 inquiry，零动作）
      if (featureId !== null) {
        scheduler.notifyTaskSettled(featureId, taskId, { state: task.state, text: task.text });
      }
    },
    pollIntervalMs: TASK_WATCHER_POLL_INTERVAL_MS,
    maxConsecutiveFailures: WATCHER_MAX_CONSECUTIVE_FAILURES,
  });
}

export async function dispatchTask(input: DispatchTaskInput): Promise<DispatchOutcome> {
  const { taskId, projectId, contextId, wait } = input;
  const identity = input.identity ?? null;

  // ① 成员前置：同步零 I/O fail-fast（判据同源 assertMember；非成员不产生任何副作用）
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error, contextId };
  }
  const denied = assertMember(
    null,
    projectId,
    resolveGroup(identity, config.groups),
    config.groups,
  );
  if (denied !== null) {
    return { ok: false, code: denied.code, error: denied.error, contextId };
  }

  // ② 落点解析（projectId → machineId）。过渡期 = locateProject；A6 切 Runner 注册表。
  const located = await locateProject(projectId, identity);
  if (!located.ok) {
    return { ok: false, code: located.code, error: located.error, contextId };
  }
  // 硬兜底：现读配置 + 精确到 (machineId, projectId) 的成员断言（零 I/O）
  const recheck = loadMachines();
  if (!recheck.ok) {
    return { ok: false, code: "machines_config_error", error: recheck.error, contextId };
  }
  const deniedAtTarget = assertMember(
    located.machine.machineId,
    projectId,
    resolveGroup(identity, recheck.groups),
    recheck.groups,
  );
  if (deniedAtTarget !== null) {
    return { ok: false, code: deniedAtTarget.code, error: deniedAtTarget.error, contextId };
  }

  // ③ 独立任务建行（前置全部通过之后 ⇒ 失败路径零副作用、零脏行）
  if (input.newTask !== null && getTask(taskId) === null) {
    createTask({
      taskId,
      projectId,
      contextId,
      state: "working",
      // v0.8.10 O-N4：散活（inquiry）本就是只读语义 ⇒ 恒落只读档。
      // 不显式标则按缺省 = 写档 ⇒ 撞 machine 写闸 ⇒ 散活排到 Feature 写节点后面。
      lane: "read",
      // v0.10.2 增补三 E-1：职责位原样透传声明（缺省 undefined = 落库 NULL ⇒ 读侧归一
      // unit_agent）；与 `lane` 正交，本行**不改**上面「恒 read」的读档语义。
      taskType: input.newTask.taskType,
      prompt: truncatePrompt(input.newTask.prompt),
      dispatchMessage: input.newTask.dispatchMessage,
    });
  }

  // ④ 入队（幂等）+ 立即下发（最佳努力）；无 Runner 在线照常入队、不拒绝
  const queued = enqueueTask(taskId);
  if (queued === null) {
    return { ok: false, code: "task_not_found", error: `任务 ${taskId} 不存在，无法入队`, contextId };
  }
  wakeRunner(located.machine.machineId);

  // ⑤ 同步预算内等待终态（终态由 Runner 回传经 `upsertTaskResult` 落库产出）
  if (!wait) {
    // 全异步：交后台看护按本地队列态对账（终态落库 + Feature 续推 / B2/B3 兜底）
    startLocalTaskWatcher(taskId);
    return workingDispatchOutcome(taskId, contextId);
  }
  const deadline = Date.now() + SYNC_BUDGET_MS;
  for (;;) {
    const current = getQueuedTask(taskId);
    if (current !== null && isLocalTerminalTask(current)) {
      return {
        ok: true,
        contextId,
        taskId,
        settled: true,
        state: current.state,
        text: current.text,
        artifacts: parseArchivedArtifacts(current.artifactsJson),
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
  // 超预算（含「已入队但无人领取」）：启动本地看护，终态到达后 persist + 续推 DAG
  startLocalTaskWatcher(taskId);
  return workingDispatchOutcome(taskId, contextId);
}

/**
 * `a2a_call` 的**立即派发路径**（REQ-v0.4.1-2026-09-16-01 §2.5）：**只承载 `inquiry`**。
 * 执行型派发（`mode="execute"`）必带 `featureId` ⇒ 走 {@link registerFeatureNode}（登记 DAG 节点，
 * 由调度器派发），永不进入本函数。
 *
 * 契约以**类型级**表达：`mode` 只能取字面量 `"inquiry"` —— 传 `"execute"` 即**编译错误**；
 * `mode` 的必填性 / 对偶校验**不在本层重复实现**（单一事实源：`register-tools.ts` 的
 * `a2aCallSchema` 与 `validateCallMode`）。缺省值使既有 4 参调用点行为完全等价（A 步零破坏）。
 *
 * v0.7.0 A4：经队列派发 —— 前置通过后落独立任务行 → 入队 + wake → 同步预算内等终态；
 * 拿到终态回真实结果，否则回 `working` + `taskId`（**对外契约不变**）。
 *
 * v0.10.2 增补三 E-1：`taskType` = 职责位声明（可选，形制同 `registerFeatureNode` 的同名入参）
 * —— 建行时原样落 `tasks.task_type`（缺省 = NULL ⇒ 读侧归一 `unit_agent`）。
 * **派发形态与并发档不变**：仍恒 `lane='read'`，仍经同一队列与 `toDispatchCommand` 带顶层键。
 */
async function handleCall(
  projectId: string,
  text: string,
  contextIdInput: string | undefined,
  wait: boolean,
  mode: "inquiry" = "inquiry",
  taskType?: TaskType | undefined,
  identity: string | null = null,
): Promise<CallOutcome> {
  void mode; // 类型级契约：运行时无需分支（非 inquiry 无法通过编译）
  const contextId =
    contextIdInput !== undefined && contextIdInput.length > 0 ? contextIdInput : randomUUID();

  const sent = await dispatchTask({
    taskId: randomUUID(),
    projectId,
    contextId,
    wait,
    newTask: { prompt: text, dispatchMessage: text, taskType },
    identity,
  });
  if (!sent.ok) {
    return { ok: false, code: sent.code, error: sent.error, contextId };
  }
  if (sent.settled) {
    return {
      ok: true,
      text: sent.text ?? "",
      artifacts: sent.artifacts,
      taskId: sent.taskId,
      status: sent.state,
      contextId,
    };
  }
  // 未终态：结果由 Runner 回传落库（`/runner/result` → `upsertTaskResult`），宿主用句柄轮询
  return {
    ok: true,
    text: workingGuidanceText(sent.taskId, contextId),
    artifacts: [],
    taskId: sent.taskId,
    status: "working",
    contextId,
  };
}

// ---------------------------------------------------------------------------
// Feature 编排接线（v0.3.0 登记 + 调度器派发；v0.4.0 Context / 上游产物注入）
// ---------------------------------------------------------------------------

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
 *
 * v0.8.9 O2：`base` 只读**未渲染的原始消息**（`dispatch_message` 经本节点起不再被渲染结果
 * 回写，恒为干净 base；`?? prompt` 为历史行兜底）⇒ 渲染只发生在本函数返回值，
 * 由调用方落 `dispatch_rendered` 快照列，反复派发不叠加外壳。
 *
 * v0.10.2 O-3（F-C6）：**职责位进外壳一行**，且**仅非缺省注入** —— `unit_agent`（含存量 NULL
 * 归一档）**不注入**，故缺省节点的派发消息**逐字不变**。该行是**面向人 / 后端 agent 的外壳**，
 * 机器判据仍以派发命令顶层键 `taskType` 为准（machine 侧禁解析正文取该值）；随其余外壳一并
 * **只进 `dispatch_rendered` 快照**，**绝不回写 `base`**（反复派发不叠加）。
 */
function buildNodeDispatchMessage(node: TaskRecord, feature: FeatureRecord | null): string {
  const base = node.dispatchMessage ?? node.prompt ?? "";
  const blocks: string[] = [];
  if (node.taskType !== "unit_agent") blocks.push(`职责位 taskType=${node.taskType}`);
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
 * `dependencies` 引用同 Feature 内的本地 taskId；`inputs` 声明本节点引用的上游产物；
 * `readOnly`（v0.8.10 O-N4）声明本节点并发档：仅显式 `true` ⇒ `lane='read'`，否则 `'write'`；
 * `taskType`（v0.10.2 O-2）声明本节点职责位：仅显式带值才落 `tasks.task_type`，
 * **缺省（undefined）= 落库 NULL = 未声明** ⇒ 读侧归一 `unit_agent`（**不在此处兜底写值**）。
 */
function registerFeatureNode(
  projectId: string,
  message: string,
  contextIdInput: string | undefined,
  featureId: string,
  dependencies: readonly string[],
  inputs?: readonly InputArtifactRef[] | undefined,
  identity: string | null = null,
  readOnly?: boolean | undefined,
  taskType?: TaskType | undefined,
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
   * v0.8.6 req01 补正 R-1（跨组写入洞 · 安全）：挂载前必须校验「本连接身份 == Feature 归属组」。
   * 六出口归属判据 **`ownershipFailure` 同源**（禁止第二套判据），三分支语义完全一致：
   * - `identity === null`（未配组 / 3300 运维全量视图）⇒ 放行；
   * - `feature.ownerGroup === identity` ⇒ 放行；
   * - 其余（含 `ownerGroup` 为 NULL 的存量 Feature）⇒ **拒**（fail-closed），
   *   沿用 `ownershipFailure` 的「属另一项目组 / 无归属」文案（**不泄漏**他组组名 / 成员清单）。
   * 防他组连接用 `a2a_call(mode="execute", featureId=<他组 Feature>)` 把**本组项目**挂进
   * **他组 DAG**（推动对方自动流转 / 污染对方失败账单）。零 I/O，置于成员断言之前。
   */
  const owned = ownershipFailure(feature, identity);
  if (owned !== null) {
    return { ok: false, code: owned.code, error: owned.error, contextId };
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
  const denied = assertMember(
    null,
    projectId,
    resolveGroup(identity, config.groups),
    config.groups,
  );
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
    // v0.8.10 O-N4：并发档显式写入（不依赖 NULL 缺省）—— readOnly 仅显式 true 才是只读档，
    // 缺省 / false 一律按写档（保守）。
    lane: readOnly === true ? "read" : "write",
    // v0.10.2 O-2：职责位**原样透传声明**（不做 `?? "unit_agent"` 兜底）—— 缺省 = undefined =
    // 落库 NULL = 「未声明」，读侧归一 unit_agent；显式归一会把「未声明」压平成「声明了 unit_agent」，
    // 并让 COALESCE 失去「后续声明可抬档」的能力。
    taskType,
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
 * 远端 A2A 任务 id → 本地 Feature 节点 id 的映射与反查已抽到 `./task-lookup.js`
 * （v0.6.1 REQ-05 §2.5 白捡 / A5-5）：派发回填处调用 {@link registerRemoteTask}，
 * 推送回写 / 工具反查统一走 `resolveLocalTaskId` / `resolveTaskLookup`。
 */

/**
 * 调度器注入的节点派发（v0.7.0 A4：**经队列派发**）。
 *
 * 派发前注入 Feature Context（plan/decisions/contracts）与已完成上游产物（`inputArtifacts`）；
 * v0.8.9 O2：注入后的全文**只落 `dispatch_rendered` 渲染快照**（Runner 领取消息取自
 * `dispatch_rendered ?? dispatch_message`），**绝不回写 `dispatch_message`** —— 后者恒为
 * 未渲染 base（澄清可追加、重派可原样重放，外壳永不累积）。落库后复用 `dispatchTask`
 * **入队**（`queue_state=queued` + `dispatch_guard` 入队幂等占位）。
 * ⚠️ C11 的「先占位后发」原语（`markTaskDispatchStarted` / `markTaskDispatched`）在 pull 模型下
 * **生产零调用**（v0.8.7 已把注释翻正为遗留原语）；`started_at` 的现行写入点 = `claimTask`。
 *
 * 结果链：Runner 领取 → 本地执行 → `/runner/result` 回传 → `upsertTaskResult` 落终态；
 * **节点终态续推 DAG** 由 A5 本地看护接管（`dispatchTask` 未在同步预算内终态时启动；
 * 看护读到本地终态 ⇒ `persist` + `notifyTaskSettled`；`scheduler.ts`
 * 引擎语义零改动：`{ok:true}` 无 `settled` ⇒ 节点留待 `notifyTaskSettled`，且 `dispatch_guard`
 * 非 NULL ⇒ 不被重复派发）。
 */
async function dispatchFeatureNode(node: TaskRecord): Promise<FeatureDispatchResult> {
  const featureId = node.featureId;
  if (featureId === null) {
    return { ok: false, error: `任务 ${node.taskId} 无 Feature 归属` };
  }
  const feature = getFeature(featureId);
  // v0.10.0 O2c：首个节点派发 = 版本「notstart → active」自动转换的触发点之一
  // （引擎内部 · 幂等 · 节流 · 不阻断；`approve` 为另一触发点）。无 Feature / 无版号 ⇒ no-op。
  if (feature !== null) activateVersionForFeature(feature);
  const message = buildNodeDispatchMessage(node, feature);
  // v0.8.9 O2：渲染结果只写 `dispatchRendered`（本轮下发快照，Runner 领取即用）；
  // `dispatchMessage` 原样回写 = 未渲染 base 保持不变（防「反复派发 ⇒ 外壳叠加」）
  createTask({
    taskId: node.taskId,
    projectId: node.projectId,
    contextId: node.contextId,
    state: node.state,
    artifactsJson: node.artifactsJson,
    text: node.text,
    prompt: node.prompt,
    featureId: node.featureId,
    dependencies: node.dependencies,
    inputArtifacts: node.inputArtifacts,
    remoteTaskId: node.remoteTaskId,
    dispatchMessage: node.dispatchMessage,
    dispatchRendered: message,
  });

  const sent = await dispatchTask({
    taskId: node.taskId,
    projectId: node.projectId,
    contextId: node.contextId,
    wait: true,
    newTask: null,
    // v0.8.6 req01 补正 Y-1：Feature 节点派发按 **owner 组**判定成员（`owner_group`），
    // 与 R-1 挂载归属判据一致 ⇒ 收「他组项目混入本组 Feature DAG」的残余路径。
    // 未配组 / 存量 / 3300 运维 ⇒ `owner_group === null` ⇒ 传 `null` = 全组聚合视图（旧行为）。
    identity: feature?.ownerGroup ?? null,
  });
  if (!sent.ok) {
    /**
     * `FeatureDispatchResult` 只有 `error`（无 `code`）—— 守住 `scheduler.ts` **零改动**的前提下，
     * 把错误码嵌进错误字符串（如 `[project_not_a_member] …`），保证非成员等结构化失败码在
     * 失败传播 / Feature failed 原因 / 日志里**不丢失**（v0.6.0 §3.1-N2）。
     */
    return { ok: false, error: `[${sent.code}] ${sent.error}` };
  }
  if (sent.settled) {
    // 入队即已终态（如 Runner 在预算内已完成回传）：直接交调度器续推
    return { ok: true, settled: { state: sent.state, text: sent.text } };
  }
  // 未终态：节点已入队（`dispatch_guard` 非 NULL ⇒ 不被重复派发），等 Runner 回传后续推
  bridgeLog.info(
    "a2a-bridge",
    `Feature 节点 ${node.taskId} 已入队（project=${node.projectId}），等待 Runner 领取`,
  );
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
  /**
   * ② 只读投影（v0.8.9 O3 · 改造文档 §2.3）：与 `a2a_feature_status` 的 tasks 行**同一实现**
   * （{@link projectTaskVisibility}）—— 体积 / 触达 4 键 + machine diagnostics 透传。
   */
  baseChars: number;
  renderedChars: number;
  wrappedChars: number;
  attempts: number;
  diagnostics: TaskDiagnosticsView;
}

type TaskStatusOutcome = TaskStatusSuccess | (Failure & { task?: TaskRecord });

/**
 * `a2a_task_status`（v0.7.0 A6 / B1）：**只读本地回传落库**（远端 `tasks/get` 退役）。
 *
 * pull 模型下任务态由 Runner `/runner/result` 回传经 `upsertTaskResult` 落库，桥侧无远端可查；
 * 任务尚未回传时返回其**当前本地态**（通常 `working`），由宿主按句柄轮询至终态。
 * 仍保留成员前置（非成员任务 ⇒ `project_not_a_member`，零 I/O）。
 *
 * v0.8.9 O3：成功分支**additive** 增 ② 只读投影（`baseChars` / `renderedChars` /
 * `wrappedChars` / `attempts` + `diagnostics` 透传），与 `a2a_feature_status` 的 tasks 行同源。
 */
async function handleTaskStatus(
  taskId: string,
  identity: string | null = null,
): Promise<TaskStatusOutcome> {
  const lookup = resolveTaskLookup(taskId);
  if (lookup === null) {
    return {
      ok: false,
      code: "task_not_found",
      error: `未知任务 ${taskId}（本地任务存储无记录）`,
    };
  }
  const { record } = lookup;
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error, task: record };
  }
  const denied = assertMember(
    null,
    record.projectId,
    resolveGroup(identity, config.groups),
    config.groups,
  );
  if (denied !== null) {
    return { ok: false, code: denied.code, error: denied.error, task: record };
  }
  return {
    ok: true,
    taskId: record.taskId,
    status: record.state,
    text: record.text ?? textFromArchivedArtifacts(record.artifactsJson),
    artifacts: parseArchivedArtifacts(record.artifactsJson),
    updatedAt: record.updatedAt,
    // ② 投影与 `a2a_feature_status` 同源同值（同一函数、零第二套口径）
    ...projectTaskVisibility(record),
  };
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

/**
 * `a2a_cancel`（v0.7.0 A6 / B1）：**命令族第三类 `cancel-task`** —— 经 `/runner/connect`
 * 下一轮轮询下发给目标 Runner，由其对本地执行层 / 项目进程执行取消；终态经 `/runner/result` 回传落库。
 *
 * 桥侧**不再** `tasks/cancel`（A2A 出站退役）。命令为**异步投递**：本函数返回「已下发」，
 * 任务态仍以本地回传落库为准（宿主按 `a2a_task_status` 观察）。
 * 非成员 ⇒ `project_not_a_member`（零 I/O）；无 Runner 端点（未接线 / 非 owner）⇒ `cancel_unavailable`。
 */
async function handleCancel(
  taskId: string,
  identity: string | null = null,
): Promise<CancelOutcome> {
  const lookup = resolveTaskLookup(taskId);
  if (lookup === null) {
    return {
      ok: false,
      code: "task_not_found",
      error: `未知任务 ${taskId}（本地任务存储无记录）`,
    };
  }
  const { record } = lookup;
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error, task: record };
  }
  const denied = assertMember(
    null,
    record.projectId,
    resolveGroup(identity, config.groups),
    config.groups,
  );
  if (denied !== null) {
    return { ok: false, code: denied.code, error: denied.error, task: record };
  }
  if (isLocalTerminalTask(record)) {
    return {
      ok: false,
      code: "task_already_settled",
      error: `任务 ${record.taskId} 已终态（${record.state}），无需取消`,
      task: record,
    };
  }
  const located = await locateProject(record.projectId, identity);
  if (!located.ok) {
    return { ok: false, code: located.code, error: located.error, task: record };
  }
  const endpoint = runnerEndpoints;
  if (endpoint === null) {
    return {
      ok: false,
      code: "cancel_unavailable",
      error:
        "当前接入面未提供 Runner 端点（仅常驻 http owner 提供）：无法下发 cancel-task 命令；" +
        "请确认桥以 `transport.mode=http` 且持 core 租约运行。",
      task: record,
    };
  }
  endpoint.enqueueCancelTask(located.machine.machineId, record.taskId);
  // 最佳努力：立即唤醒挂起的长轮询（Runner 未连接则静默，下轮轮询照常领取）
  wakeRunner(located.machine.machineId);
  return {
    ok: true,
    taskId: record.taskId,
    status: record.state,
    text: `已向 Runner（machineId=${located.machine.machineId}）下发 cancel-task 命令；任务态以 Runner 回传落库为准。`,
    artifacts: parseArchivedArtifacts(record.artifactsJson),
    updatedAt: nowIso(),
  };
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
    projects: ProjectSummary[];
    error?: string;
  }>;
  /**
   * Runner 注册视图（v0.7.0 A6 / B4）：**只列 memberMachines** 中**已注册**的 Runner。
   * 字段白名单 = `machineId` / `online` / `lastHeartbeatAt`；
   * **不含** token / `runnerId` / `protocolVersion` 等协议内部字段，也不含任何 workspace。
   */
  runners: Array<{ machineId: string; online: boolean; lastHeartbeatAt: string }>;
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

/**
 * `a2a_projects`（v0.7.0 A6）：**数据源 = 桥注册表投影**（`runners` / `runner_projects`），
 * 不再出站 `GET /projects`。
 *
 * - 只遍历**成员机器**（v0.6.0 §2.2）：**无成员的机器整条消失（含其 error 条目）**；
 * - 每机：注册行存在 ⇒ 列其注册项目（按成员过滤）；未注册 / 心跳超时 ⇒ 保留条目 + `error`
 *   （`launcher_unreachable` 语义：Runner 未注册 / 心跳超时）；
 * - 出参补 `runners[]`：**只列 memberMachines** 中已注册者（B4），字段白名单见 {@link MachinesView}。
 */
async function handleProjects(identity: string | null = null): Promise<MachinesView | Failure> {
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error };
  }
  const group = resolveGroup(identity, config.groups);
  const targets = memberMachines(config.machines, group);
  let runners: RunnerRecord[];
  try {
    runners = listRunners();
  } catch (err) {
    return {
      ok: false,
      code: "runner_registry_error",
      error: `读取 Runner 注册表失败：${toMessage(err)}`,
    };
  }
  const byMachine = new Map(runners.map((r) => [r.machineId, r]));
  const machines: MachinesView["machines"] = [];
  const runnerViews: MachinesView["runners"] = [];
  try {
    for (const machine of targets) {
      const runner = byMachine.get(machine.machineId);
      if (runner === undefined) {
        machines.push({
          machineId: machine.machineId,
          projects: [],
          error: `Runner 未注册（机器 ${machine.machineId} 尚未出站注册；等待其上报后自动可见）`,
        });
        continue;
      }
      const projects = listRunnerProjects(runner.runnerId)
        .filter((p) => isMemberProject(machine.machineId, p.projectId, group))
        .map(toProjectSummary);
      runnerViews.push({
        machineId: runner.machineId,
        online: runner.state === "online",
        lastHeartbeatAt: runner.lastHeartbeatAt,
      });
      if (runner.state === "online") {
        machines.push({ machineId: machine.machineId, projects });
      } else {
        machines.push({
          machineId: machine.machineId,
          projects,
          error: `Runner 心跳超时（lastHeartbeatAt=${runner.lastHeartbeatAt}）；注册态已降为 offline`,
        });
      }
    }
  } catch (err) {
    return {
      ok: false,
      code: "runner_registry_error",
      error: `读取 Runner 项目投影失败：${toMessage(err)}`,
    };
  }
  return { machines, runners: runnerViews, group: groupView(group) };
}

interface TasksView {
  ok: true;
  projectId: string;
  reachable: boolean;
  notice?: string;
  tasks: TaskListItem[];
}

/**
 * 按项目列出本地任务记录（纯本地 + 只读注册表探测）。
 * 绝不拉起 Agent 执行；`stale` 判定 = **本地队列态**
 * （`isTaskWatched`：`queue_state ∈ queued/claimed/running` ⇒ 在队、不算 stale）+
 * 一次只读可达性探测（`locateProject`：v0.7.0 A6 起读**桥注册表投影**，零出站），
 * 不做逐任务远端查询。
 *
 * v0.8.6 §2.4(c) / 出口 6：**成员前置 + 探测按身份**（形态照 {@link handleTaskStatus}）——
 * 非本组项目 ⇒ `project_not_a_member`（**零副作用**：不 prune、不查库、不探测）；
 * 可达性探测走的 `locateProject` 同样收身份（否则「列得到本组任务、探测到他组机器」= 第二套判据）。
 */
async function handleTasks(
  projectId: string,
  state?: DomainTaskState,
  limit?: number,
  identity: string | null = null,
): Promise<TasksView | Failure> {
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error };
  }
  const denied = assertMember(null, projectId, resolveGroup(identity, config.groups), config.groups);
  if (denied !== null) {
    return { ok: false, code: denied.code, error: denied.error };
  }

  try {
    pruneTasks();
  } catch (err) {
    console.error(`[a2a-bridge] 任务保留策略清理失败：${toMessage(err)}`);
  }

  const records = listTasks({ projectId, state, limit });

  let reachable = true;
  let notice: string | undefined;
  if (records.some((r) => r.state === "working")) {
    const located = await locateProject(projectId, identity);
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
    // v0.10.2 O-3：本面此前连 `lane` 都没有 ⇒ 与 `a2a_feature_status` / `a2a_feature_trace`
    // 长期不一致，一并补齐。两字段都**恒有值**（读侧 NULL 已归一 write / unit_agent），**不得省略**。
    lane: record.lane,
    taskType: record.taskType,
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

/**
 * 进程内读游标 **按连接身份分离**（v0.8.6 §1.3 R-2）：key = 身份（组名，`null` = 无身份）。
 *
 * 全局单游标 = 唯一的跨组泄漏点：A 组读口推进游标会把 B 组的起点一起抬高 ⇒
 * B 组**永久漏读**（不是多读）—— 故游标必须随身份走，且**初值也按身份取**
 * （`latestEventId(scope)`，见 {@link currentEventsCursor}）。
 */
const eventsCursor = new Map<string | null, number>();

/**
 * 身份 → 事件可见性范围（§2.4 案 B：**读时经 `feature_id` / `task_id` 反查 join**）——
 * `events` 表零 DDL、写路径零改动，`owner_group` 的单一事实源留在 `features`（与 N4 打标同源）。
 *
 * - `identity === null` ⇒ `scope = null` = **不过滤**（未配组环境的匿名全量入口 /
 *   web 运维视图 §2.7 —— 与 N4「无身份不校验归属」同口径）；
 * - `identity` 命中组 ⇒ `ownerGroup` = 该身份 + `projectIds` = 本组成员项目
 *   （后者覆盖**无 Feature 归属**的任务事件，如 `mode="inquiry"`）；
 * - `identity` **未命中任何组** ⇒ {@link resolveGroup} 的 fail-closed 空组 ⇒ `projectIds: []`
 *   ⇒ 只见孤儿事件（**绝不回退全量**，I2）；
 * - 配置不可读 ⇒ `machines_config_error`（**不静默降级成「0 条事件」**）。
 */
function resolveEventScope(
  identity: string | null,
): { ok: true; scope: EventVisibilityScope | null } | Failure {
  if (identity === null) return { ok: true, scope: null };
  const config = loadMachines();
  if (!config.ok) {
    return { ok: false, code: "machines_config_error", error: config.error };
  }
  const group = resolveGroup(identity, config.groups);
  return {
    ok: true,
    scope: {
      ownerGroup: identity,
      projectIds: Array.from(new Set(group.members.map((m) => m.projectId))).sort(),
    },
  };
}

/** 取该身份的当前游标（首次读取时按**本组可见**的最大 `eventId` 初始化） */
function currentEventsCursor(
  identity: string | null,
  scope: EventVisibilityScope | null,
): number {
  let cursor = eventsCursor.get(identity);
  if (cursor === undefined) {
    cursor = latestEventId(scope);
    eventsCursor.set(identity, cursor);
  }
  return cursor;
}

/** 推进该身份的游标（只前进不回退），返回推进后的游标 */
function advanceEventsCursor(
  identity: string | null,
  scope: EventVisibilityScope | null,
  cursor: number,
): number {
  const next = Math.max(currentEventsCursor(identity, scope), cursor);
  eventsCursor.set(identity, next);
  return next;
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

export interface EventsOutcome {
  ok: true;
  cursor: number;
  count: number;
  events: EventRecord[];
}

export interface WaitOutcome extends EventsOutcome {
  timedOut: boolean;
}

/** 读取 `events` 增量（按身份可见性）；无变化时以 `latestEventId(scope)` 廉价空返回（不查 events 表） */
function handleEvents(identity: string | null, since?: number): EventsOutcome | Failure {
  const scoped = resolveEventScope(identity);
  if (!scoped.ok) return scoped;
  const { scope } = scoped;
  const cursor = since === undefined ? currentEventsCursor(identity, scope) : Math.max(since, 0);
  if (latestEventId(scope) <= cursor) {
    advanceEventsCursor(identity, scope, cursor);
    return { ok: true, cursor, count: 0, events: [] };
  }
  const events = listEvents({ since: cursor, limit: EVENTS_PAGE_LIMIT, scope });
  const last = events.length > 0 ? (events[events.length - 1]?.eventId ?? cursor) : cursor;
  const next = advanceEventsCursor(identity, scope, last);
  return { ok: true, cursor: next, count: events.length, events };
}

/**
 * 长轮询：等待**本身份可见**的 `cursor` 之后新事件，最多 `timeoutMs`（内部 cap < `SYNC_BUDGET_MS`）。
 * 推送路径写入事件时经 `signalEvents()` 立即唤醒；非推送路径（调度器落库）由定时对账兜底。
 *
 * 「有新事件」判定必须走 `latestEventId(scope)`（R-2）：用全局最大 id 会被他组事件误唤醒 ⇒
 * 空转到超时（读不到任何事件）。唤醒本身是广播（`eventWaiters` 不身份化），
 * 但每轮都用本身份谓词复核 ⇒ 误唤醒只是多跑一次廉价判定，不会误报有事件。
 */
async function handleWait(
  identity: string | null,
  timeoutMs?: number,
): Promise<WaitOutcome | Failure> {
  const scoped = resolveEventScope(identity);
  if (!scoped.ok) return scoped;
  const { scope } = scoped;
  const cursor = currentEventsCursor(identity, scope);
  const waitMs = Math.min(Math.max(timeoutMs ?? EVENT_WAIT_MAX_MS, 0), EVENT_WAIT_MAX_MS);
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (latestEventId(scope) > cursor) {
      const events = listEvents({ since: cursor, limit: EVENTS_PAGE_LIMIT, scope });
      const last = events.length > 0 ? (events[events.length - 1]?.eventId ?? cursor) : cursor;
      return {
        ok: true,
        cursor: advanceEventsCursor(identity, scope, last),
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
    /**
     * **职责位**（v0.10.2 增补三 E-1）：可选，**缺省 = 未声明**（落库 NULL ⇒ 读侧 `unit_agent`）。
     * inquiry 的**读档语义不变**（恒 `lane='read'`），本参数与 `lane` 正交。
     * 非法值在 `register-tools.ts` 的 schema / 准入层已被结构化拒绝，不得到达本口。
     */
    taskType?: TaskType | undefined,
  ): Promise<CallOutcome>;
  registerFeatureNode(
    projectId: string,
    message: string,
    contextId: string | undefined,
    featureId: string,
    dependencies: readonly string[],
    inputs?: readonly InputArtifactRef[] | undefined,
    readOnly?: boolean | undefined,
    /**
     * **职责位**（v0.10.2 O-2）：可选，**缺省 = 未声明**（落库 NULL ⇒ 读侧 `unit_agent`）。
     * 非法值在 `register-tools.ts` 的 schema / 准入层已被结构化拒绝，不得到达本口。
     */
    taskType?: TaskType | undefined,
  ): CallOutcome;
  taskStatus(taskId: string): Promise<TaskStatusOutcome>;
  cancel(taskId: string): Promise<CancelOutcome>;
  events(since?: number): EventsOutcome | Failure;
  wait(timeoutMs?: number): Promise<WaitOutcome | Failure>;
  featureCreate(args: FeatureCreateArgs): FeatureCreateSuccess | FeatureToolFailure;
  featureStatus(args: FeatureStatusArgs): FeatureStatusSuccess | FeatureToolFailure;
  featureAdvance(args: FeatureAdvanceArgs): FeatureAdvanceSuccess | FeatureToolFailure;
  featureApprove(args: FeatureApproveArgs): FeatureStateChangeSuccess | FeatureToolFailure;
  featureCancel(args: FeatureCancelArgs): FeatureStateChangeSuccess | FeatureToolFailure;
  /**
   * **只读 trace 投影**（v0.8.10 O-N3 挂成 MCP 工具 `a2a_feature_trace`）：
   * 「这个 Feature 为什么还没完成」（在等谁 / 排队位次 / 写门与只读档占位）。
   * 纯读、不落库、不触发调度 ⇒ 与其它五口同样**按连接身份做归属校验**（谁建谁见）。
   */
  featureTrace(args: FeatureTraceArgs): FeatureTraceSuccess | FeatureToolFailure;
  /**
   * **O1 受控写**（v0.9.4 REQ-2026-09-26-01 §2.3）：`config.json` 的 `projectGroup` 段
   * 单组操作（五操作闭集；拒绝整文档替换）。**全组面工具**：配置面写**不受**调用方组
   * 可见性限制（identity=null 运维连接语义，边界 R2 冻结口径）⇒ 装配**不吃身份**。
   */
  configWriteGroup(args: ConfigWriteGroupArgs): Promise<ConfigWriteGroupOutcome>;
  /** 工具返回后统一 kick 调度器（Feature 工具组用） */
  kickScheduler(): void;
}

/**
 * 装配内核：既有领域处理器的结构化聚合（N6 常驻化时改为注入 runtime 生命周期）。
 *
 * v0.8.6 §2.2：按**连接身份**装配每请求轻量视图 —— `http.ts` 的 `coreFor(identity)` 即
 * `(identity) => createCore(identity)`（**不按身份缓存**：本函数只是闭包装配，无重资源；
 * 进程级可变状态共享，组判定经 {@link resolveGroup} 按身份取组）。
 * `identity = null`（缺省）= 无身份：未配组环境的匿名全量入口 / web 运维视图（N6 起显式注入）。
 * v0.8.6 §2.4 出口补齐 A 起：**12 个出口的只读三路（`tasks` / `events` / `wait`）也已按身份**
 * （游标随身份分离 = R-2；Feature 工具组五路归 N4，v0.8.10 O-N3 起的 `a2a_feature_trace` 同判据）。
 */
export function createCore(identity: string | null = null): BridgeCore {
  return {
    projects: (): Promise<MachinesView | Failure> => handleProjects(identity),
    tasks: (projectId, state, limit): Promise<TasksView | Failure> =>
      handleTasks(projectId, state, limit, identity),
    call: (projectId, text, contextId, wait, mode, taskType): Promise<CallOutcome> =>
      handleCall(projectId, text, contextId, wait, mode, taskType, identity),
    registerFeatureNode: (projectId, message, contextId, featureId, dependencies, inputs, readOnly, taskType): CallOutcome =>
      registerFeatureNode(projectId, message, contextId, featureId, dependencies, inputs, identity, readOnly, taskType),
    taskStatus: (taskId): Promise<TaskStatusOutcome> => handleTaskStatus(taskId, identity),
    cancel: (taskId): Promise<CancelOutcome> => handleCancel(taskId, identity),
    events: (since): EventsOutcome | Failure => handleEvents(identity, since),
    wait: (timeoutMs): Promise<WaitOutcome | Failure> => handleWait(identity, timeoutMs),
    // Feature 工具组：按连接身份打标（create）+ 归属校验（status/advance/approve/cancel 谁建谁见）。
    // `identity = null`（未配组匿名 / web 运维视图）⇒ 全量放行，零破坏（v0.8.6 §2.3 / N4）。
    featureCreate: (args): FeatureCreateSuccess | FeatureToolFailure =>
      handleFeatureCreate(args, identity),
    featureStatus: (args): FeatureStatusSuccess | FeatureToolFailure =>
      handleFeatureStatus(args, identity),
    featureAdvance: (args): FeatureAdvanceSuccess | FeatureToolFailure =>
      handleFeatureAdvance(args, identity),
    featureApprove: (args): FeatureStateChangeSuccess | FeatureToolFailure =>
      handleFeatureApprove(args, identity),
    featureCancel: (args): FeatureStateChangeSuccess | FeatureToolFailure =>
      handleFeatureCancel(args, identity),
    // 只读面同样按身份做归属校验（他组 Feature 不可见）；无身份 ⇒ 全量放行（与五口同判据）
    featureTrace: (args): FeatureTraceSuccess | FeatureToolFailure =>
      handleFeatureTrace(args, identity),
    // O1 配置面写：**全组面**，刻意不吃 identity（R2 冻结：配置面写不受组可见性限制）
    configWriteGroup: (args): Promise<ConfigWriteGroupOutcome> =>
      writeGroupConfig(MACHINES_CONFIG_PATH, args),
    kickScheduler: (): void => scheduler.kick(),
  };
}

/** 常驻 HTTP 接入面句柄（停机第一步先停收新请求） */
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
// 启动（stdio 退役后**恒常驻 http**；不再有按 mode 的分派）
// ---------------------------------------------------------------------------

/** transport 配置（懒加载 + 进程内缓存） */
let cachedTransportConfig: TransportConfig | null = null;
let transportConfigLoaded = false;

/**
 * 读取桥 transport 配置。**fail-fast（不 bind）**：读配置失败**绝不回落默认** ——
 * 否则坏配置会静默 bind 默认 8787、掩盖问题。stdio 退役后唯一合法 `mode` = `"http"`
 * （显式 `"stdio"` 由 `config.ts` 解析期拒绝）。抛出由入口 `main().catch` 收敛为 exit 1。
 */
function transportConfig(): TransportConfig {
  if (!transportConfigLoaded) {
    transportConfigLoaded = true;
    cachedTransportConfig = loadMachinesConfig(MACHINES_CONFIG_PATH).transport;
  }
  if (cachedTransportConfig === null) {
    throw new Error(
      "[a2a-bridge] transport 配置不可用（加载失败）：拒绝回落默认端口，请修复配置后重启",
    );
  }
  return cachedTransportConfig;
}

/** web 配置缺失 / 非法时的兜底（取值与 `config.ts` 缺省一致：常驻启用、127.0.0.1:3300） */
const FALLBACK_WEB: WebConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 3300,
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
        `加载 web 配置失败（回落默认：常驻启用 127.0.0.1:3300）：${toMessage(err)}`,
      );
      cachedWebConfig = null;
    }
  }
  return cachedWebConfig ?? FALLBACK_WEB;
}

/**
 * 开 store + 启动清理（lifecycle 的 `openStore` 钩子）。
 * 与既有启动同序：先开库（迁移）再 `pruneTasks()`；清理失败只记日志、不阻塞启动。
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
 * `recover()` → 就绪。`unref` 恒 `false`（桥恒常驻 http，由 HTTP listener 持住进程）。
 *
 * pidfile **恒写**：stdio 桥（由宿主作为子进程拉起、会覆盖常驻进程记录）已退役，
 * 不再存在「两形态共用 dataDir 而 pidfile 打架」的场景。
 */
function createBridgeRuntime(mode: TransportMode, endpoint: HealthEndpoint): BridgeRuntime {
  return new BridgeRuntime({
    dataDir: DATA_DIR,
    mode,
    scheduler,
    openStore: openStoreAndPrune,
    pidFile: defaultPidFile(DATA_DIR),
    // K3：owner 把自身 `/health` 端点写进 pidfile，供下一个实例的前置探针定位 holder
    endpoint,
  });
}

/** 启动恢复摘要（lifecycle 只回摘要不落日志；此处补日志） */
function logRecoverySummary(recovery: unknown): void {
  const r = asRecord(recovery);
  if (r === null) return;
  const scanned = typeof r["scanned"] === "number" ? r["scanned"] : 0;
  const failedFeatures = typeof r["failedFeatures"] === "number" ? r["failedFeatures"] : 0;
  const interruptedTasks = typeof r["interruptedTasks"] === "number" ? r["interruptedTasks"] : 0;
  if (scanned === 0 && interruptedTasks === 0) return;
  bridgeLog.info(
    "a2a-bridge",
    `桥重启恢复：扫描 executing Feature ${scanned}，收敛 failed ${failedFeatures}（interrupted 任务 ${interruptedTasks}）`,
  );
}

/**
 * 网页只读接面接线（v0.5.0 §2.5）：**必须在 `runtime.start()` 之后**调用（否则拿不到 `role`）。
 *
 * 判定式（单一表达式，与 `config.ts` / `types.ts` 注释同源）：`web.enabled && role === "owner"`
 * （v0.7.1 stdio 退役后形态门只剩「常驻启用」这一维）。
 * - follower **一律不 bind**（同机多桥互抢端口随之消失）；
 * - **不 throw**：非 loopback / 端口被占 / 未启用 ⇒ 不 bind 且不报错（`startWebTransport` 自吞，
 *   返回未启用句柄）；「无页面」是合法状态，**MCP 工具面不受影响**；
 * - **身份 = 全量（§2.7 / S6）**：注入 `createCore(null)` —— 网页面**只作运维全量视图**，
 *   不承担 orch agent 的身份面（身份唯一载体 = MCP 端点 URL 路径首段 `/<组名>/mcp`）；
 * - listener 不 `unref`：桥恒常驻 http（由 HTTP listener 持住进程），`shutdown()` 会显式关闭。
 */
async function startWebIfEnabled(mode: TransportMode, readiness: RuntimeReadiness): Promise<void> {
  const web = webConfig();
  // 顺序反转（§2.5 (a)）：此处已过 `runtime.start()` ⇒ `readiness.role` 是权威角色
  const shapeEnabled = web.enabled;
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
      // v0.8.6 §2.7（S6 / N6）：网页接面**显式**注入「全量身份」core（`identity = null`
      // ⇒ `resolveGroup` 走全组聚合视图）。3300 是**运维全量视图**，**不作为 orch agent 的
      // 身份面**（agent 身份只经 MCP 端点的 URL 路径段 `/<组名>/mcp` 承载，§2.2）；
      // 组不是鉴权边界（`/mcp` 零鉴权，真边界归「安全与治理」）。
      // `web.ts` 内部零改动：各条路由经 `WebCore = Pick<BridgeCore, …>` 间接转发
      // （例外：v0.9.4 O2 `GET /api/groups` 直读 `configPath` 的配置声明面，不经 core）。
      core: createCore(null),
      // v0.9.4 O2：`GET /api/groups` 数据源路径（每请求现读，热改即时生效）
      configPath: MACHINES_CONFIG_PATH,
      host: web.host,
      port: web.port,
      version: BRIDGE_VERSION,
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
  /**
   * K3 前置探针（v0.7.2 REQ-01 ③）：**必须在 `startHttpTransport()` 绑定端口之前**执行 ——
   * 本进程一旦绑定，配置端点上的 `/health` 响应者就是**自身**，探针将自证而失去意义。
   * 此时观察到的 `/health` 才是 holder 的真实状态：`ECONNREFUSED`（端口已释放）= 文档化 wedge 特征
   * ⇒ 回收僵死锁，使本次启动可竞争 owner；探针失败 / 超时 / 端点不明 ⇒ 保守不动（宁可阻塞）。
   */
  const pidRecord = readBridgePidFile(defaultPidFile(DATA_DIR));
  const reclaimed = await reclaimWedgeCoreLease(DATA_DIR, (holder) => {
    if (pidRecord === null || pidRecord.pid !== holder.pid) return "unknown";
    if (pidRecord.host === undefined || pidRecord.port === undefined) return "unknown";
    return probeHttpHealth(
      { host: pidRecord.host, port: pidRecord.port },
      LEASE_PROBE_TIMEOUT_MS,
    );
  });
  if (reclaimed) {
    bridgeLog.warn(
      "a2a-bridge",
      "检测到僵死 core 租约（holder pid 存活但 /health 不在服务）→ 已回收，本次启动竞争 owner",
    );
  }
  const runtime = createBridgeRuntime("http", { host, port });
  activeRuntime = runtime;
  /**
   * v0.8.6 §2.2：HTTP 面**按连接身份装配每请求内核视图**（`coreFor(identity)`，不缓存）；
   * `options.core` 仅作未注入时的全量兜底（本接线恒有 `coreFor`，实际不被使用）。
   * 403 门判据单一来源 = `groups.length > 0`；配置不可读 ⇒ 按「需身份」处理（fail-closed，I2）。
   */
  const coreFor = (identity: string | null): BridgeCore => createCore(identity);
  const identityRequired = (): boolean => {
    const load = loadMachines();
    return load.ok ? load.groups.length > 0 : true;
  };
  /**
   * Runner 入站端点（v0.7.0 A3 模块 + A4 接线）：仅常驻 http 形态创建。
   * `mode` / `role` 用惰性闭包（`runtime.start()` 在本行之后，角色此刻尚未确定）；
   * `config` 现读 ⇒ token / projectGroup / `runner.holdMs` 热改即时生效（与桥其余路径一致）。
   */
  runnerEndpoints = createRunnerEndpoints({
    role: () => runtime.currentRole,
    config: () => loadMachinesConfig(MACHINES_CONFIG_PATH),
    // A7 接线：Runner 事件（registered/online/offline/claimed/stale）落库后立即唤醒 a2a_wait 订阅者
    signalEvents,
    // O5：心跳超期清算 / 孤儿墙钟清算的静默降级登记到进程内登记表
    degradation: degradations,
  });
  // O5：看护 owner 门闩接入登记表（follower 停用 ⇒ /health `degraded[]` 增一项）
  setTaskWatcherDegradationSink(degradations);
  /**
   * 版本台账端点（v0.10.0 O2a）：仅常驻 http 形态创建，**委托形态照 `/runner/*` 先例**。
   * `role` 用惰性闭包（同上，角色在 `runtime.start()` 才定）；写路的 owner 门闩由处理器自检。
   */
  const versionsEndpoints = createVersionsEndpoints({
    role: () => runtime.currentRole,
  });
  /**
   * Project Version 台账端点（v0.10.1 O5）：与 Group 档同一委托形态、同一端口，**另立处理器实例**
   * （两档路由前缀不重合 ⇒ 互不认领）。
   */
  const projectVersionsEndpoints = createProjectVersionsEndpoints({
    role: () => runtime.currentRole,
  });
  const handle = await startHttpTransport({
    core: coreFor(null), // 兜底视图（匿名/全量）；生产请求路径走 coreFor(identity)
    coreFor,
    identityRequired,
    host,
    port,
    path,
    isReady: () => ready,
    role: () => runtime.currentRole,
    version: BRIDGE_VERSION,
    onShutdown: shutdown,
    runner: runnerEndpoints,
    versions: versionsEndpoints,
    projectVersions: projectVersionsEndpoints,
    // O5：/health 出参增加降级快照（只加键，status/role/version 语义不变）
    degraded: () => degradations.snapshot(),
  });
  activeHttp = handle;
  const readiness: RuntimeReadiness = runtime.start();
  logRecoverySummary(readiness.recovery);
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

/** 桥入口：stdio 退役后**恒常驻 http**（`startHttpBridge` 先 `listen` ⇒ 端口被占即 fail-fast）。 */
async function main(): Promise<void> {
  await startHttpBridge();
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
