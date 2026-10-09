/**
 * 只读 JSON API 接面单元测试（`bridge/transports/web.ts`；v0.5.0 §2.2 / §2.5，节点 N3；
 * v0.9.3 O2 起页面退役 —— 原 `GET /` 内联工作台页与 `bridge/web/html.ts` 断言已删除，
 * 页面断言的承接面 = Board 测试）。
 *
 * 覆盖：
 * - **路由形状**：path / method / 状态码 / 出参形状（含 404 / 405 / 400）；
 * - **字段白名单**：`/api/projects` 剔除 `workspace`（绝对路径）与 `agentConfig`；
 * - **事件游标隔离**：`/api/events` 直连 `store.listEvents`（`since` 由前端传参、缺省从头、反复读幂等）；
 * - **降级**：端口被占 / 非 loopback host ⇒ 不 throw，返回「未启用」句柄；
 * - **注册表全量投影**（REQ-2026-10-03-02）：`/api/registry/projects` 契约 C-1…C-6
 *   （遍历源 = runners 表 / 零组语义负向 / 字符串逐字 / 字段名对齐 / 两条读路不交叉）。
 *
 * 关于「游标隔离」这条断言为什么这样写（**宿主游标不可直接观测**）：
 * `eventsCursor` 是 `bridge/index.ts` 的**模块私有**变量（未导出），且 `bridge/index.ts` 顶层
 * 直接调用 `main()`（import 它就会拉起整座桥，测试不可 import）⇒ 无法在测试里直接读该游标。
 * 故本用例以**行为**锁定契约：同一 `since` 反复读结果恒等（读口不持有、不推进任何服务端游标），
 * 且缺省 `since` 恒为 0（不会退化成「从隐式游标起」）。配合模块边界（`web.ts` 对 `index.ts`
 * 只有 `import type`）即成充分保证：数据面路径**在类型与运行时都不可能**碰到宿主收件箱游标。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import {
  appendEvent,
  createFeature,
  createTask,
  latestEventId,
  markRunnerOffline,
  runnerProjectsReplace,
  upsertRunner,
} from "../session/store.js";
import type { ProjectStatus } from "../types.js";
import { resetWarnOnceCache } from "../config.js";
import { handleFeatureStatus, projectTaskVisibility } from "../bridge/feature-tools.js";
import type { TaskState } from "../types.js";
import { startWebTransport } from "../bridge/transports/web.js";
import type { WebCore, WebTransportHandle, WebTransportOptions } from "../bridge/transports/web.js";

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  contentType: string | null;
  csp: string | null;
  text: string;
  body: unknown;
}

async function get(port: number, path: string, method = "GET"): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // 非 JSON（HTML 页面）
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    csp: res.headers.get("content-security-policy"),
    text,
    body,
  };
}

/** 断言响应体是 JSON 并按其形状取用（避免 `any`） */
function json<T>(res: HttpResult): T {
  assert.notEqual(res.body, null, "响应体应为 JSON");
  return res.body as T;
}

/** 取数组元素（`noUncheckedIndexedAccess` 下的显式断言） */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  assert.ok(value !== undefined, `list[${index}] 应存在`);
  return value;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("服务器未监听 TCP 端口");
  return address.port;
}

interface CoreOverrides {
  projects?: WebCore["projects"];
  tasks?: WebCore["tasks"];
  featureStatus?: WebCore["featureStatus"];
}

/**
 * `a2a_projects` 出参 `group` 的缺省视图（v0.6.0 §2.3-I5：`group` **恒存在**）。
 * 网页接面**不转发** `group`（`sendProjects` 是显式字段映射），但 `WebCore["projects"]`
 * 的类型（`MachinesView`）要求该字段存在 —— 故此处只补类型形状，不影响 `/api/projects` 出参。
 */
function defaultGroupView(): { name: string | null; selective: boolean; memberMachines: string[] } {
  return { name: null, selective: false, memberMachines: [] };
}

/**
 * ② 只读投影（v0.8.9 O3）在 fake 行上的**空形状**：`FeatureTaskSummary` 自本期起必带
 * `baseChars`/`renderedChars`/`wrappedChars`/`attempts`/`diagnostics` 五字段 —— 桩里没有
 * 派发列可投影，故直接调真函数喂空输入（**不手写常量**，避免契约漂移时桩仍绿）。
 */
function emptyVisibilityView() {
  return projectTaskVisibility({
    dispatchMessage: null,
    dispatchRendered: null,
    retryCount: 0,
    diagnosticsJson: null,
  });
}

/** 最小内核桩：只实现网页接面用到的三件事（`BridgeCore` 结构兼容） */
function fakeCore(overrides: CoreOverrides = {}): WebCore {
  return {
    projects:
      overrides.projects ??
      (async () => ({ machines: [], runners: [], group: defaultGroupView() })),
    tasks:
      overrides.tasks ??
      (async (projectId: string) => ({ ok: true, projectId, reachable: true, tasks: [] })),
    featureStatus: overrides.featureStatus ?? (() => ({ ok: true, features: [] })),
  };
}

const openHandles: WebTransportHandle[] = [];

after(async () => {
  for (const handle of openHandles) await handle.close();
});

function baseOptions(
  core: WebCore,
  overrides: Partial<WebTransportOptions> = {},
): WebTransportOptions {
  const options: WebTransportOptions = {
    core,
    host: overrides.host ?? "127.0.0.1",
    port: overrides.port ?? 0,
    version: overrides.version ?? "0.5.0-test",
  };
  if (overrides.refreshMs !== undefined) options.refreshMs = overrides.refreshMs;
  if (overrides.configPath !== undefined) options.configPath = overrides.configPath;
  return options;
}

async function startWeb(
  core: WebCore,
  overrides: Partial<WebTransportOptions> = {},
): Promise<WebTransportHandle> {
  const outcome = await startWebTransport(baseOptions(core, overrides));
  assert.equal(outcome.enabled, true, `期望网页接面启用：${outcome.enabled ? "" : outcome.reason}`);
  if (!outcome.enabled) throw new Error("网页接面未启用（不可达）");
  openHandles.push(outcome);
  return outcome;
}

/** `GET /projects` 派生对象：故意带上运行时会出现的 `workspace` / `risk` / `agentConfig` */
function onlineProject(): ProjectStatus & { agentConfig?: Record<string, unknown> } {
  return {
    projectId: "orch",
    workspace: "G:/code/secret-workspace/orch",
    agentKind: "opencode",
    a2aPort: 3010,
    status: "online",
    endpoint: "http://127.0.0.1:3010",
    startedAt: "2026-09-16T01:00:00Z",
    risk: "read",
    agentConfig: { token: "do-not-leak" },
  };
}

// ---------------------------------------------------------------------------
// 出参形状（仅声明测试用到的字段）
// ---------------------------------------------------------------------------

interface ErrorBody {
  ok: boolean;
  code: string;
  error: string;
}

interface ProjectsBody {
  ok: boolean;
  source: string;
  note: string;
  observedAt: string;
  machines: Array<{ machineId: string; error?: string; projects: Array<Record<string, unknown>> }>;
  /** Runner 注册视图（v0.7.0 A6）：白名单字段 */
  runners?: Array<Record<string, unknown>>;
}

interface FeaturesBody {
  ok: boolean;
  features?: Array<{
    featureId: string;
    title: string;
    state: string;
    taskCount: number;
    /** v0.9.0 B3″：出参 additive 扩的逐态计数 */
    stateCounts?: Partial<Record<string, number>>;
  }>;
  feature?: { featureId: string; title: string };
  code?: string;
}

/** 单 Feature 详情：tasks 为 `FeatureTaskSummary` + 渲染层补的三时刻 */
interface FeatureDetailBody {
  ok: boolean;
  feature?: { featureId: string; title: string };
  tasks?: Array<Record<string, unknown>>;
}

interface TasksBody {
  ok: boolean;
  projectId: string;
  reachable: boolean;
  notice?: string;
  tasks: unknown[];
}

interface TaskDetailBody {
  ok: boolean;
  task: Record<string, unknown>;
}

interface EventsBody {
  ok: boolean;
  since: number;
  count: number;
  note: string;
  events: Array<{
    eventId: number;
    kind: string;
    state: string | null;
    taskId: string | null;
    createdAt: string;
  }>;
}

/** `GET /api/groups` 出参（v0.9.4 O2；仅声明测试用到的字段） */
interface GroupsBody {
  ok: boolean;
  source: string;
  note: string;
  observedAt: string;
  groups: Array<{
    name: string | null;
    memberCount: number;
    members: Array<{ machineId: string; projectId: string }>;
  }>;
  warnings: string[];
  code?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test("GET /api/projects → 白名单（剔除 workspace / agentConfig / risk / Runner 内部字段）+ 桥注册表快照语义", async () => {
  /** 故意夹带 Runner 内部字段：网页白名单必须剔除（防 vacuous：全文断言不含这些值） */
  const runnerWithInternals = {
    machineId: "m1",
    online: true,
    lastHeartbeatAt: "2026-09-18T00:00:00Z",
    runnerId: "runner-internal-id",
    token: "do-not-leak-token",
    protocolVersion: "2.0",
  };
  const core = fakeCore({
    projects: async () =>
      ({
        machines: [
          { machineId: "m1", projects: [onlineProject()] },
          { machineId: "m2", projects: [], error: "机器不可达（测试）" },
        ],
        runners: [runnerWithInternals],
        group: defaultGroupView(),
      }) as unknown as Awaited<ReturnType<WebCore["projects"]>>,
  });
  const handle = await startWeb(core);
  const res = await get(handle.port, "/api/projects");
  assert.equal(res.status, 200);
  const body = json<ProjectsBody>(res);
  assert.equal(body.ok, true);
  assert.equal(body.source, "桥注册表（Runner 上报快照）");
  assert.match(body.note, /快照语义/);
  assert.match(body.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "须给出观测时间");
  assert.equal(body.machines.length, 2);
  assert.equal(at(body.machines, 0).machineId, "m1");
  assert.equal(at(body.machines, 1).error, "机器不可达（测试）", "机器级 error 应透出");

  const project = at(at(body.machines, 0).projects, 0);
  assert.deepEqual(project, {
    projectId: "orch",
    agentKind: "opencode",
    a2aPort: 3010,
    status: "online",
    endpoint: "http://127.0.0.1:3010",
    startedAt: "2026-09-16T01:00:00Z",
  });
  assert.equal("workspace" in project, false, "workspace 绝对路径不得出口");
  assert.equal("agentConfig" in project, false, "agentConfig 不得出口");
  assert.equal("risk" in project, false, "白名单外字段不得出口");

  // Runner 注册视图：字段白名单 = machineId / online / lastHeartbeatAt（无 runnerId / token / protocolVersion）
  const runner = at(body.runners ?? [], 0);
  assert.deepEqual(runner, {
    machineId: "m1",
    online: true,
    lastHeartbeatAt: "2026-09-18T00:00:00Z",
  });
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("secret-workspace"), "响应全文不得含 workspace 绝对路径");
  assert.ok(!raw.includes("do-not-leak"), "响应全文不得含 agentConfig 内容");
  assert.ok(!raw.includes("runner-internal-id"), "响应全文不得含 runnerId");
  assert.ok(!raw.includes("do-not-leak-token"), "响应全文不得含 Runner token");
});

test("路由形状：未知路径 404；已注册路径非 GET → 405；页面退役后 GET / → 404 JSON", async () => {
  const handle = await startWeb(fakeCore());

  const missing = await get(handle.port, "/api/nope");
  assert.equal(missing.status, 404);
  assert.equal(json<ErrorBody>(missing).code, "not_found");

  const apiNotGet = await get(handle.port, "/api/projects", "POST");
  assert.equal(apiNotGet.status, 405);
  assert.equal(json<ErrorBody>(apiNotGet).code, "method_not_allowed");

  const featureNotGet = await get(handle.port, "/api/features/f1", "DELETE");
  assert.equal(featureNotGet.status, 405);

  // v0.9.3 O2 页面退役：`/` 不再注册 ⇒ 走未注册路径的 404 JSON（不是 405，也不返回 HTML）
  const retiredPage = await get(handle.port, "/");
  assert.equal(retiredPage.status, 404);
  assert.equal(json<ErrorBody>(retiredPage).code, "not_found");
  assert.equal(retiredPage.csp, null, "退役后不再下发 HTML/CSP 应答头");
});

test("GET /api/features/:featureId → 详情 Task 行补三时刻（渲染层派生；本地缺记录给 null，不吞不造）", async () => {
  const feature = createFeature({ featureId: "f-web-1", title: "只读工作台" });
  const core = fakeCore({
    featureStatus: (args) => {
      if (args.featureId === undefined) {
        return {
          ok: true,
          // v0.9.0 B3″：`stateCounts` 是列表出参的 additive 扩字段（真实现由聚合 SQL 派生）
          features: [{ ...feature, taskCount: 0, stateCounts: {} }],
        };
      }
      if (args.featureId === "f-web-1") {
        return { ok: true, feature, tasks: [], artifacts: [] };
      }
      return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
    },
  });
  const handle = await startWeb(core);

  const list = await get(handle.port, "/api/features");
  assert.equal(list.status, 200);
  const listBody = json<FeaturesBody>(list);
  assert.equal(listBody.ok, true);
  assert.equal(at(listBody.features ?? [], 0).featureId, "f-web-1");
  assert.equal(at(listBody.features ?? [], 0).taskCount, 0);
  assert.deepEqual(at(listBody.features ?? [], 0).stateCounts, {}, "B3″ additive 字段原样透出");

  const one = await get(handle.port, "/api/features/f-web-1");
  assert.equal(one.status, 200);
  assert.equal(json<FeaturesBody>(one).feature?.featureId, "f-web-1");

  const unknown = await get(handle.port, "/api/features/f-nope");
  assert.equal(unknown.status, 404);
  assert.equal(json<ErrorBody>(unknown).code, "feature_not_found");
});

test("GET /api/features（列表）与 MCP 面 a2a_feature_status 列表分支逐项同值：stateCounts / taskCount 同源同值（零任务 ⇒ {}）", async () => {
  // O6：板读的是 HTTP 面 `GET /api/features`（非 MCP 面）。此前真机冒烟发现 HTTP 面未透出
  // `stateCounts`（`taskCount` 有）。投影补齐的**验收**不能只喂桩（桩会掩盖白名单丢字段），
  // 必须让 HTTP 面的 core 委托到**同一个** `handleFeatureStatus`（= 生产 `coreFor(null).featureStatus`），
  // 再逐 Feature 比对「HTTP 面 == MCP 面列表分支」的 `taskCount` + `stateCounts`。

  // 两种真实形态：多态混合 + 零任务（真机现状就是 `{}`）
  const mixed = createFeature({ featureId: "f-o6-mixed", title: "多态混合" }).featureId;
  const mixedStates: TaskState[] = ["completed", "completed", "working", "failed"];
  mixedStates.forEach((state, i) =>
    createTask({
      taskId: `t-o6-mixed-${String(i)}`,
      projectId: "p-o6",
      contextId: `c-o6-mixed-${String(i)}`,
      state,
      featureId: mixed,
    }),
  );
  const empty = createFeature({ featureId: "f-o6-empty", title: "零任务" }).featureId;

  // HTTP 面：真网页接面，featureStatus 委托到真 handler（identity null ⇒ 全量视野，与运维视图同判据）
  const handle = await startWeb(fakeCore({ featureStatus: (args) => handleFeatureStatus(args, null) }));
  const list = await get(handle.port, "/api/features");
  assert.equal(list.status, 200);
  const httpRows = (json<FeaturesBody>(list).features ?? []).map((f) => ({
    featureId: f.featureId,
    taskCount: f.taskCount,
    stateCounts: f.stateCounts,
  }));

  // MCP 面：`a2a_feature_status` 列表分支（同一函数、同一 store 快照）
  const mcp = handleFeatureStatus({}, null);
  if (!mcp.ok) throw new Error(`MCP 列表分支应成功，实际失败：${mcp.code} ${mcp.error}`);
  const mcpRows = (mcp.features ?? []).map((f) => ({
    featureId: f.featureId,
    taskCount: f.taskCount,
    stateCounts: f.stateCounts,
  }));

  // ★ 逐项同值（按 featureId 对齐后全等）——两路读取同一 store、无写入介入
  const byFeatureId = (a: { featureId: string }, b: { featureId: string }): number =>
    a.featureId < b.featureId ? -1 : a.featureId > b.featureId ? 1 : 0;
  assert.deepEqual(
    [...httpRows].sort(byFeatureId),
    [...mcpRows].sort(byFeatureId),
    "HTTP /api/features 每项 { taskCount, stateCounts } 须与 MCP 面列表分支逐项同值",
  );

  // 具体形态断言（防两路同时错成一致的空值 / 键序差异掩盖丢字段）
  const httpById = new Map(httpRows.map((f) => [f.featureId, f]));
  assert.deepEqual(httpById.get(mixed)?.stateCounts, { completed: 2, working: 1, failed: 1 });
  assert.equal(httpById.get(mixed)?.taskCount, 4);
  assert.deepEqual(httpById.get(empty)?.stateCounts, {}, "零任务 Feature ⇒ stateCounts 空对象（真机现状）");
  assert.equal(httpById.get(empty)?.taskCount, 0);
});

test("GET /api/features/:featureId → 详情 Task 行补三时刻（渲染层派生；本地缺记录给 null，不吞不造）", async () => {
  createTask({
    taskId: "t-web-timing",
    projectId: "p1",
    contextId: "c-web-timing",
    state: "completed",
    text: "done",
    prompt: "do it",
    featureId: "f-web-timing",
  });
  const core = fakeCore({
    featureStatus: (args) =>
      args.featureId === "f-web-timing"
        ? {
            ok: true,
            feature: createFeature({ featureId: "f-web-timing", title: "层级视图" }),
            tasks: [
              {
                taskId: "t-web-timing",
                projectId: "p1",
                state: "completed" as const,
                lane: "write" as const,
                prompt: "do it",
                remoteTaskId: null,
                dependencies: null,
                inputArtifacts: null,
                updatedAt: "2026-09-16T02:00:00Z",
                failureKind: null,
                retryCount: 0,
                ...emptyVisibilityView(),
              },
              {
                taskId: "t-web-no-record",
                projectId: "p2",
                state: "working" as const,
                lane: "write" as const,
                prompt: null,
                remoteTaskId: null,
                dependencies: null,
                inputArtifacts: null,
                updatedAt: "2026-09-16T02:00:00Z",
                failureKind: null,
                retryCount: 0,
                ...emptyVisibilityView(),
              },
            ],
            artifacts: [],
          }
        : { ok: false, code: "feature_not_found", error: "未知 Feature（测试）" },
  });
  const handle = await startWeb(core);

  const res = await get(handle.port, "/api/features/f-web-timing");
  assert.equal(res.status, 200);
  const tasks = json<FeatureDetailBody>(res).tasks ?? [];
  assert.equal(tasks.length, 2);

  // 「微调出参」：既有字段原样保留（语义不变），仅**增**三时刻
  const known = at(tasks, 0);
  assert.equal(known["taskId"], "t-web-timing");
  assert.equal(known["state"], "completed");
  for (const key of ["createdAt", "startedAt", "finishedAt"]) {
    assert.ok(key in known, `详情 Task 行应含三时刻列 ${key}`);
  }
  assert.match(String(known["createdAt"]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "三时刻应取自本地库");

  // 本地无该任务记录 ⇒ 三值 null（页面据此显示「未知 / —」）
  const noRecord = at(tasks, 1);
  assert.equal(noRecord["createdAt"], null);
  assert.equal(noRecord["startedAt"], null);
  assert.equal(noRecord["finishedAt"], null);
});

test("GET /api/tasks → project 必填、state / limit 校验、结果透传 handleTasks", async () => {
  const calls: Array<{ projectId: string; state: string | undefined; limit: number | undefined }> =
    [];
  const core = fakeCore({
    tasks: async (projectId, state, limit) => {
      calls.push({ projectId, state, limit });
      return {
        ok: true,
        projectId,
        reachable: false,
        notice: "项目 p1 当前非在线（status=offline）",
        tasks: [],
      };
    },
  });
  const handle = await startWeb(core);

  const missing = await get(handle.port, "/api/tasks");
  assert.equal(missing.status, 400);
  assert.equal(json<ErrorBody>(missing).code, "missing_project");

  const ok = await get(handle.port, "/api/tasks?project=p1");
  assert.equal(ok.status, 200);
  const okBody = json<TasksBody>(ok);
  assert.equal(okBody.ok, true);
  assert.equal(okBody.projectId, "p1");
  assert.equal(okBody.reachable, false);
  assert.equal(okBody.notice, "项目 p1 当前非在线（status=offline）");
  assert.deepEqual(calls[0], { projectId: "p1", state: undefined, limit: undefined });

  const badState = await get(handle.port, "/api/tasks?project=p1&state=bogus");
  assert.equal(badState.status, 400);
  assert.equal(json<ErrorBody>(badState).code, "invalid_state");

  const badLimit = await get(handle.port, "/api/tasks?project=p1&limit=abc");
  assert.equal(badLimit.status, 400);
  assert.equal(json<ErrorBody>(badLimit).code, "invalid_limit");

  const filtered = await get(handle.port, "/api/tasks?project=p1&state=working&limit=50");
  assert.equal(filtered.status, 200);
  assert.deepEqual(calls[1], { projectId: "p1", state: "working", limit: 50 });
});

test("GET /api/tasks/:taskId → 本地任务详情（含三时刻；未知 404；无副作用路径）", async () => {
  createTask({
    taskId: "t-web-1",
    projectId: "p1",
    contextId: "c-web-1",
    state: "completed",
    text: "done",
    prompt: "do it",
  });
  const handle = await startWeb(fakeCore());

  const res = await get(handle.port, "/api/tasks/t-web-1");
  assert.equal(res.status, 200);
  const task = json<TaskDetailBody>(res).task;
  assert.equal(task["taskId"], "t-web-1");
  assert.equal(task["projectId"], "p1");
  assert.equal(task["contextId"], "c-web-1");
  assert.equal(task["state"], "completed");
  assert.equal(task["text"], "done");
  assert.equal(task["prompt"], "do it");
  for (const key of ["createdAt", "startedAt", "finishedAt"]) {
    assert.ok(key in task, `详情应含三时刻列 ${key}`);
  }
  assert.equal("workspace" in task, false, "详情不得携带 workspace");
  assert.equal("agentConfig" in task, false, "详情不得携带 agentConfig");

  const unknown = await get(handle.port, "/api/tasks/t-nope");
  assert.equal(unknown.status, 404);
  assert.equal(json<ErrorBody>(unknown).code, "task_not_found");
});

test("GET /api/events → 直连 listEvents：since 透传、缺省 0、反复读幂等（宿主游标隔离）", async () => {
  const e1 = appendEvent({ kind: "task.settled", taskId: "t-ev-1", state: "completed" });
  const e2 = appendEvent({ kind: "task.settled", taskId: "t-ev-2", state: "failed" });
  const handle = await startWeb(fakeCore());

  const first = await get(handle.port, "/api/events");
  assert.equal(first.status, 200);
  const b1 = json<EventsBody>(first);
  assert.equal(b1.ok, true);
  assert.equal(b1.since, 0, "缺省 since 必须是 0（从头），不得从任何隐式游标起");
  assert.equal(b1.count, latestEventId(), "缺省读应返回全部事件");
  assert.ok(b1.events.some((ev) => ev.eventId === e1.eventId && ev.taskId === "t-ev-1"));
  assert.ok(b1.events.some((ev) => ev.eventId === e2.eventId));
  assert.match(b1.note, /游标/, "响应须自述「游标由前端传参」");

  // 游标隔离（行为锁）：同一 since 反复读 ⇒ 结果恒等。
  // 若读口持有 / 推进任何服务端游标（如宿主 `a2a_events` 的 `eventsCursor`），第二次必然变少。
  const second = await get(handle.port, "/api/events");
  const b2 = json<EventsBody>(second);
  assert.equal(b2.since, b1.since);
  assert.equal(b2.count, b1.count);
  assert.deepEqual(b2.events, b1.events);

  const tail = await get(handle.port, `/api/events?since=${String(latestEventId())}`);
  assert.equal(json<EventsBody>(tail).count, 0, "显式 since 透传：已读到的最大 id ⇒ 空增量");

  const one = await get(handle.port, "/api/events?since=0&limit=1");
  const b3 = json<EventsBody>(one);
  assert.equal(b3.count, 1, "limit 透传");
  assert.equal(at(b3.events, 0).eventId, at(b1.events, 0).eventId);

  const badSince = await get(handle.port, "/api/events?since=-1");
  assert.equal(badSince.status, 400);
  assert.equal(json<ErrorBody>(badSince).code, "invalid_since");
});

test("GET /api/events?featureId= → store.listEvents 只读收窄（B3″：不经 handleEvents）", async () => {
  const base = latestEventId();
  const a = createFeature({ featureId: "f-ev-a", title: "甲" });
  const b = createFeature({ featureId: "f-ev-b", title: "乙" });
  const aEvents = [
    appendEvent({ featureId: a.featureId, kind: "feature.stage", state: null }).eventId,
    appendEvent({ featureId: a.featureId, kind: "feature.state", state: "executing" }).eventId,
  ];
  appendEvent({ featureId: b.featureId, kind: "feature.stage", state: null });
  appendEvent({ kind: "runner.registered", featureId: null });
  const handle = await startWeb(fakeCore());

  const only = await get(handle.port, `/api/events?featureId=${a.featureId}`);
  assert.equal(only.status, 200);
  const body = json<EventsBody>(only);
  assert.equal(body.count, 2, "只回该 Feature 的事件（他 Feature / 孤儿事件被排除）");
  assert.deepEqual(
    body.events.map((ev) => ev.eventId),
    aEvents,
    "升序且逐条属于本 Feature",
  );

  // 过滤口本身无状态：同一 query 反复读 ⇒ 结果恒等（服务端不记任何进度）
  const again = json<EventsBody>(await get(handle.port, `/api/events?featureId=${a.featureId}`));
  assert.deepEqual(again.events, body.events);
  assert.equal(again.since, 0, "featureId 过滤不得改动 since 语义");

  const empty = json<EventsBody>(
    await get(handle.port, "/api/events?featureId=f-no-such-feature"),
  );
  assert.equal(empty.count, 0, "未知 Feature ⇒ 空增量（不 404、不报错）");

  const bad = await get(handle.port, "/api/events?featureId=");
  assert.equal(bad.status, 400, "空串 featureId 是非法入参，不当成「无过滤」");
  assert.equal(json<ErrorBody>(bad).code, "invalid_feature_id");

  const all = json<EventsBody>(await get(handle.port, `/api/events?since=${base}`));
  assert.equal(all.count, 4, "不传 featureId ⇒ 行为与改前逐字一致（本用例四条事件全回，不加过滤）");
});

// ---------------------------------------------------------------------------
// GET /api/groups（v0.9.4 O2：全组枚举只读端点）
// ---------------------------------------------------------------------------

const testTmpDir = mkdtempSync(join(tmpdir(), "orch-web-groups-"));

/** 写一份临时 `config.json` 夹具，返回路径（`loadMachinesConfig` 的真解析路径，不打桩） */
function writeGroupsFixture(config: unknown): string {
  const path = join(testTmpDir, `config-${String(Math.random()).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(config));
  return path;
}

/** 最小合法 machines 段（组成员 machineId 校验依赖它） */
function machinesSection(...machineIds: string[]): Array<Record<string, unknown>> {
  return machineIds.map((machineId) => ({
    machineId,
    launcherUrl: "http://127.0.0.1:9000",
  }));
}

test("GET /api/groups → 全组声明投影：name / memberCount / members 白名单（派生态与敏感键不出口；组内重复项去重）", async () => {
  const path = writeGroupsFixture({
    machines: machinesSection("m1", "m2"),
    projectGroup: [
      {
        name: "alpha",
        members: [
          { machineId: "m1", projectId: "p1" },
          { machineId: "m2", projectId: "p2" },
          // 组内重复项（parseProjectGroups 不判跨组互斥）：投影须集合去重，计数与列表同源
          { machineId: "m1", projectId: "p1" },
        ],
      },
      { name: "beta", members: [{ machineId: "m2", projectId: "p3" }] },
    ],
  });
  const handle = await startWeb(fakeCore(), { configPath: path });

  const res = await get(handle.port, "/api/groups");
  assert.equal(res.status, 200);
  const body = json<GroupsBody>(res);
  assert.equal(body.ok, true);
  assert.match(body.source, /projectGroup/);
  assert.match(body.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.deepEqual(body.groups, [
    {
      name: "alpha",
      memberCount: 2,
      members: [
        { machineId: "m1", projectId: "p1" },
        { machineId: "m2", projectId: "p2" },
      ],
    },
    { name: "beta", memberCount: 1, members: [{ machineId: "m2", projectId: "p3" }] },
  ]);
  const raw = JSON.stringify(body);
  for (const leaked of ["memberKeys", "memberMachineIds", "selective", "token"]) {
    assert.ok(!raw.includes(leaked), `派生态 / 敏感键不得出口：${leaked}`);
  }
});

test("GET /api/groups → 未配组回 groups: []（全量接纳语义的声明态），不 404 不报错", async () => {
  const path = writeGroupsFixture({ machines: machinesSection("m1") });
  const handle = await startWeb(fakeCore(), { configPath: path });

  const res = await get(handle.port, "/api/groups");
  assert.equal(res.status, 200);
  const body = json<GroupsBody>(res);
  assert.deepEqual(body.groups, []);
});

test("GET /api/groups → warnings[] 透传 warn-once 配置瑕疵文案（解析宽容项，不入判定）", async () => {
  resetWarnOnceCache(); // 用例级隔离（与 config.test.ts 同纪律）
  const path = writeGroupsFixture({
    machines: [{ machineId: "m1" }], // launcherUrl 缺省 ⇒ warn-once 文案
    projectGroup: [{ name: "alpha", members: [{ machineId: "m1", projectId: "p1" }] }],
  });
  const handle = await startWeb(fakeCore(), { configPath: path });

  const res = await get(handle.port, "/api/groups");
  assert.equal(res.status, 200);
  const body = json<GroupsBody>(res);
  assert.equal(body.groups.length, 1, "宽容告警不影响投影结果");
  assert.ok(
    body.warnings.some((w) => w.includes("machines[0].launcherUrl 缺省")),
    `warnings 应含 launcherUrl 缺省文案，实际：${JSON.stringify(body.warnings)}`,
  );
});

test("GET /api/groups → 配置坏 / 无源：500 machines_config_error；非 GET 405；其它路由不受影响", async () => {
  const badPath = writeGroupsFixture({ machines: "not-an-array" });
  const bad = await startWeb(fakeCore(), { configPath: badPath });
  const badRes = await get(bad.port, "/api/groups");
  assert.equal(badRes.status, 500);
  const badBody = json<GroupsBody>(badRes);
  assert.equal(badBody.code, "machines_config_error");
  assert.ok(String(badBody.error).includes(badPath), "错误文案须含配置路径，便于归因");

  // 未注入 configPath ⇒ 无源可读，同样 machines_config_error（绝不 fail-open 成空清单）
  const noSource = await startWeb(fakeCore());
  const noSourceRes = await get(noSource.port, "/api/groups");
  assert.equal(noSourceRes.status, 500);
  assert.equal(json<GroupsBody>(noSourceRes).code, "machines_config_error");

  // 命中注册路径的非 GET ⇒ 405（整面只读纪律的又一颗钉）
  const notGet = await get(bad.port, "/api/groups", "POST");
  assert.equal(notGet.status, 405);
  assert.equal(json<ErrorBody>(notGet).code, "method_not_allowed");

  // 坏配置只影响 groups 路由，不回伤 core 数据面
  const okProjects = await get(bad.port, "/api/projects");
  assert.equal(okProjects.status, 200);
});

// ---------------------------------------------------------------------------
// GET /api/registry/projects（REQ-2026-10-03-02：注册表全量投影，契约 C-1…C-6）
// ---------------------------------------------------------------------------

interface RegistryBody {
  ok: boolean;
  source: string;
  note: string;
  observedAt: string;
  machines: Array<Record<string, unknown>>;
  counts: { machines: number; projects: number };
  code?: string;
  error?: string;
}

/** 注册一台机（`runnerId` 与 `machineId` 同源 = 注册路径的实际形状，见 `bridge/runner.ts`） */
function seedRunner(
  machineId: string,
  opts: { state?: "online" | "offline"; projects?: number } = {},
): void {
  upsertRunner({
    runnerId: machineId,
    machineId,
    protocolVersion: "2.0",
    version: "test",
    state: opts.state ?? "online",
    registeredAt: "2026-09-01T00:00:00Z",
    lastHeartbeatAt: "2026-09-30T00:00:00Z",
  });
  runnerProjectsReplace(
    machineId,
    Array.from({ length: opts.projects ?? 1 }, (_, i) => ({
      projectId: `${machineId}-p${i}`,
      workspace: `G:/hidden/${machineId}-p${i}`,
      agentKind: "opencode" as const,
      a2aPort: 3100 + i,
      risk: "read" as const,
      status: "online" as const,
      endpoint: `http://127.0.0.1:${3100 + i}`,
      startedAt: "2026-09-20T00:00:00Z",
    })),
  );
}

/** 递归收集响应体全部键名（C-2 负向断言用：键集合上判，不靠全文子串误伤中文文案） */
function collectKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      into.push(k);
      collectKeys(v, into);
    }
  }
  return into;
}

test("GET /api/registry/projects → 路由命中 + 冻结形状（ok/source/observedAt/note/machines[]/counts）", async () => {
  seedRunner("reg-shape", { projects: 2 });
  // C-6：本面直连 store，**不得**复用 `core.projects()` —— 桩里让它直接抛，命中即 500
  const handle = await startWeb(
    fakeCore({
      projects: async () => {
        throw new Error("C-6 违规：registry/projects 复用了 handleProjects 读路");
      },
    }),
  );
  const res = await get(handle.port, "/api/registry/projects");
  assert.equal(res.status, 200);
  const body = json<RegistryBody>(res);
  assert.equal(body.ok, true);
  assert.equal(body.source, "桥注册表（Runner 上报全量投影，未经组过滤）");
  assert.match(body.note, /lastReportedAt/, "note 须点明陈旧性以最后上报时刻表达（非实时探测）");
  assert.match(body.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  const machine = body.machines.find((m) => m["machineId"] === "reg-shape");
  assert.ok(machine !== undefined, "注册过的机须出现在投影内");
  assert.deepEqual(
    Object.keys(machine).sort(),
    ["firstRegisteredAt", "lastHeartbeatAt", "machineId", "projects", "runnerState"],
    "机级键集合冻结（无 error / 无 runnerId）",
  );
  assert.deepEqual(
    Object.keys(at(machine["projects"] as Array<Record<string, unknown>>, 0)).sort(),
    ["a2aPort", "agentKind", "endpoint", "lastReportedAt", "projectId", "startedAt", "status"],
  );
  assert.equal(typeof body.counts.machines, "number");
  assert.equal(
    body.counts.projects,
    body.machines.reduce((n, m) => n + (m["projects"] as unknown[]).length, 0),
  );
});

test("C-1 离线机照常出现：runnerState=offline + lastHeartbeatAt，其项目照常列出，机级不发 error 文案", async () => {
  seedRunner("reg-offline", { projects: 3 });
  markRunnerOffline("reg-offline");
  const handle = await startWeb(fakeCore());
  const body = json<RegistryBody>(await get(handle.port, "/api/registry/projects"));
  const machine = body.machines.find((m) => m["machineId"] === "reg-offline");
  assert.ok(machine !== undefined);
  assert.equal(machine["runnerState"], "offline");
  assert.equal(machine["lastHeartbeatAt"], "2026-09-30T00:00:00Z");
  assert.equal((machine["projects"] as unknown[]).length, 3, "离线不抹掉其项目投影");
  assert.equal("error" in machine, false, "离线机不得发 error 文案");
});

test("C-1 注册过但零项目的机 → projects: []（不缺键、不 404、不计入 counts.projects）", async () => {
  seedRunner("reg-empty", { projects: 0 });
  const handle = await startWeb(fakeCore());
  const body = json<RegistryBody>(await get(handle.port, "/api/registry/projects"));
  const machine = body.machines.find((m) => m["machineId"] === "reg-empty");
  assert.ok(machine !== undefined, "零项目机仍须出现");
  assert.deepEqual(machine["projects"], []);
});

test("C-1 遍历源 = runners 表：config 里有但从未注册的机器不出现在投影内", async () => {
  seedRunner("reg-registered", { projects: 1 });
  const handle = await startWeb(fakeCore());
  const res = await get(handle.port, "/api/registry/projects");
  const body = json<RegistryBody>(res);
  assert.ok(
    body.machines.some((m) => m["machineId"] === "reg-registered"),
    "注册过的机须出现在投影内",
  );
  // 本面无 config 入参 ⇒ 「配置里有但从未注册」的机器在投影里根本没有行（不出现、也不报错）
  assert.equal(
    body.machines.some((m) => String(m["machineId"]).includes("never-registered")),
    false,
  );
  assert.ok(!JSON.stringify(body).includes("never-registered"));
});

test("C-2 零组语义（负向）+ 渲染层白名单：无组布尔、无 workspace / risk / runnerId / agentConfig", async () => {
  seedRunner("reg-nogroup", { projects: 1 });
  const handle = await startWeb(fakeCore());
  const body = json<RegistryBody>(await get(handle.port, "/api/registry/projects"));
  const keys = new Set(collectKeys(body));
  for (const forbidden of [
    "declared",
    "inGroup",
    "group",
    "groups",
    "ownerGroupName",
    "selective",
    "memberMachineIds",
    "runnerId",
    "workspace",
    "risk",
    "agentConfig",
    "token",
  ]) {
    assert.equal(keys.has(forbidden), false, `键 ${forbidden} 不得出口`);
  }
});

test("C-3/C-4/C-5 字符串逐字透出 + 字段名对齐落库语义（lastReportedAt ← updated_at；firstRegisteredAt 保首值；ProjectView 六字段兼容）", async () => {
  const machineId = "reg-verbatim";
  upsertRunner({
    runnerId: machineId,
    machineId,
    protocolVersion: "2.0",
    version: "test",
    registeredAt: "2026-08-01T00:00:00Z",
    lastHeartbeatAt: "2026-09-30T00:00:00Z",
  });
  runnerProjectsReplace(machineId, [
    {
      projectId: " Mixed_Case_Project ",
      agentKind: "qoder-cn",
      a2aPort: 3014,
      status: "online",
      endpoint: "http://127.0.0.1:3014",
      startedAt: null,
    },
  ]);
  // 重注册不得刷新首次注册时刻（COALESCE 保首值）⇒ firstRegisteredAt 仍是 8-01
  upsertRunner({
    runnerId: machineId,
    machineId,
    protocolVersion: "2.0",
    version: "test",
    registeredAt: "2026-10-04T00:00:00Z",
    lastHeartbeatAt: "2026-10-04T00:00:00Z",
  });

  const handle = await startWeb(fakeCore());
  const body = json<RegistryBody>(await get(handle.port, "/api/registry/projects"));
  const machine = body.machines.find((m) => m["machineId"] === machineId);
  assert.ok(machine !== undefined);
  assert.equal(machine["firstRegisteredAt"], "2026-08-01T00:00:00Z", "首值不得被重注册覆盖");
  const project = at(machine["projects"] as Array<Record<string, unknown>>, 0);
  assert.equal(project["projectId"], " Mixed_Case_Project ", "不得 trim、不得大小写折叠");
  assert.equal(project["agentKind"], "qoder-cn");
  assert.equal(project["startedAt"], null);
  assert.match(
    String(project["lastReportedAt"]),
    /^\d{4}-\d{2}-\d{2}T/,
    "lastReportedAt 必须是时刻串",
  );
});

test("回归：3300 路由枚举含 /api/registry/projects（全部已注册路径命中非 404；新路径非 GET ⇒ 405）", async () => {
  const handle = await startWeb(fakeCore());
  const registered = [
    "/api/projects",
    "/api/features",
    "/api/features-by-version",
    "/api/project-versions", // v0.10.1 O6（project 级版本只读投影）
    "/api/tasks",
    "/api/events",
    "/api/groups",
    "/api/registry/projects",
  ];
  for (const path of registered) {
    const res = await get(handle.port, path);
    assert.notEqual(res.status, 404, `${path} 应在路由表内（不得 404）`);
  }
  const notGet = await get(handle.port, "/api/registry/projects", "POST");
  assert.equal(notGet.status, 405);
  assert.equal(json<ErrorBody>(notGet).code, "method_not_allowed");
  // 前缀相似但**未注册**的路径仍须 404（新路径不得吞子树）
  assert.equal((await get(handle.port, "/api/registry")).status, 404);
  assert.equal((await get(handle.port, "/api/registry/projects/extra")).status, 404);
});

test("非 loopback host ⇒ 拒起（不 throw，返回未启用）", async () => {
  for (const host of ["0.0.0.0", "192.168.1.10"]) {
    const outcome = await startWebTransport(baseOptions(fakeCore(), { host }));
    assert.equal(outcome.enabled, false, `host=${host} 应拒起`);
    if (outcome.enabled) throw new Error("不可达");
    assert.equal(outcome.reason, "non_loopback_host");
    assert.ok(outcome.error.includes("loopback"));
    await outcome.close();
  }
});

test("端口被占 ⇒ 降级（不 throw，返回未启用）", async () => {
  const blocker = createHttpServer(() => {
    /* 占位：只为占住端口 */
  });
  await new Promise<void>((resolve) => {
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const port = portOf(blocker);
  try {
    const outcome = await startWebTransport(baseOptions(fakeCore(), { port }));
    assert.equal(outcome.enabled, false, "端口被占应降级而非 throw");
    if (outcome.enabled) throw new Error("不可达");
    assert.equal(outcome.reason, "listen_failed");
    assert.ok(outcome.error.includes("未启用"));
    await outcome.close();
  } finally {
    await new Promise<void>((resolve) => {
      blocker.close(() => resolve());
    });
    blocker.closeAllConnections();
  }
});

test("close() 可停机：keep-alive 空闲连接不挂起（closeIdleConnections + 1s 兜底）", async () => {
  const handle = await startWeb(fakeCore());
  // undici（fetch）默认 keep-alive：请求完成后连接保持空闲，正是裸 close() 会挂起的场景
  const res = await fetch(`http://127.0.0.1:${handle.port}/api/projects`);
  await res.text();

  const startedAt = Date.now();
  await handle.close();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 3_000, `close() 应快速返回（实际 ${elapsed}ms）`);

  const refused = await new Promise<boolean>((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port: handle.port, path: "/", agent: false }, () =>
      resolve(false),
    );
    req.on("error", () => resolve(true));
    req.end();
  });
  assert.equal(refused, true, "close() 后端口应不再接受连接");
});

// ---------------------------------------------------------------------------
// v0.10.0 O3：GET /api/features-by-version（版本名下卡聚合读面，直连 store）
// ---------------------------------------------------------------------------

interface VersionFeaturesBody {
  ok: boolean;
  source: string;
  observedAt: string;
  note: string;
  ownerGroup: string | null;
  version: string | null;
  versions: string[];
  unregisteredCount: number;
  buckets: Array<{
    version: string | null;
    counts: { total: number; completed: number; cancelled: number; open: number };
    features: Array<{ featureId: string; state: string; title: string }>;
  }>;
  counts: { versions: number; buckets: number; features: number };
}

test("GET /api/features-by-version → 版本名下卡聚合：owner_group 收窄可见性 + version 可选 + 未登记桶末位 + 非 GET 405（v0.10.0 O3）", async () => {
  const g = "gweb-fbv";
  createFeature({ featureId: "fbv-a", title: "FBV A", version: "1.2.3", state: "completed", ownerGroup: g });
  createFeature({ featureId: "fbv-b", title: "FBV B", version: "1.2.3", state: "executing", ownerGroup: g });
  createFeature({ featureId: "fbv-c", title: "FBV C", ownerGroup: g }); // 未登记（NULL 版号）

  // 本面直连 store，不经 core —— 桩令 core 三方法皆抛，命中即证明未复用 core 读路
  const handle = await startWeb(
    fakeCore({
      projects: async () => {
        throw new Error("features-by-version 不应经 core.projects");
      },
    }),
  );

  const res = await get(handle.port, `/api/features-by-version?owner_group=${g}`);
  assert.equal(res.status, 200);
  const body = json<VersionFeaturesBody>(res);
  assert.equal(body.ok, true);
  assert.equal(body.ownerGroup, g);
  assert.match(body.source, /features 表按版号聚合/);
  assert.match(body.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.deepEqual(body.versions, ["1.2.3"]);
  assert.equal(body.unregisteredCount, 1, "未登记卡不静默丢");
  assert.equal(body.buckets[body.buckets.length - 1]!.version, null, "未登记桶恒末位");
  const v = body.buckets.find((b) => b.version === "1.2.3")!;
  assert.deepEqual(v.counts, { total: 2, completed: 1, cancelled: 0, open: 1 });
  assert.deepEqual(v.features.map((f) => f.featureId).sort(), ["fbv-a", "fbv-b"]);
  assert.equal(body.counts.features, 3, "counts.features = 全部桶 total 之和");

  // version 收窄：只动 buckets；versions / unregisteredCount 仍全量口径
  const one = json<VersionFeaturesBody>(
    await get(handle.port, `/api/features-by-version?owner_group=${g}&version=1.2.3`),
  );
  assert.equal(one.buckets.length, 1, "收窄只留该桶");
  assert.equal(one.buckets[0]!.version, "1.2.3");
  assert.deepEqual(one.versions, ["1.2.3"], "versions 不随收窄变化");
  assert.equal(one.counts.buckets, 1);

  // version= 空串 ⇒ 命中未登记桶
  const un = json<VersionFeaturesBody>(
    await get(handle.port, `/api/features-by-version?owner_group=${g}&version=`),
  );
  assert.equal(un.buckets.length, 1);
  assert.equal(un.buckets[0]!.version, null);

  // 已注册路径非 GET ⇒ 405
  const notGet = await get(handle.port, "/api/features-by-version", "POST");
  assert.equal(notGet.status, 405);
  assert.equal(json<ErrorBody>(notGet).code, "method_not_allowed");
});
