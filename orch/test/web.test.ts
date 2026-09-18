/**
 * 只读网页接面单元测试（`bridge/transports/web.ts` + `bridge/web/html.ts`；v0.5.0 §2.2 / §2.5，节点 N3）。
 *
 * 覆盖：
 * - **路由形状**：path / method / 状态码 / 出参形状（含 404 / 405 / 400）；
 * - **字段白名单**：`/api/projects` 剔除 `workspace`（绝对路径）与 `agentConfig`；
 * - **事件游标隔离**：`/api/events` 直连 `store.listEvents`（`since` 由前端传参、缺省从头、反复读幂等）；
 * - **降级**：端口被占 / 非 loopback host ⇒ 不 throw，返回「未启用」句柄；
 * - **HTML**：首页非空 + 桥标识（role / pid / startedAt）+ 刷新下限 15s + 无外部资源标签。
 *
 * 关于「游标隔离」这条断言为什么这样写（**宿主游标不可直接观测**）：
 * `eventsCursor` 是 `bridge/index.ts` 的**模块私有**变量（未导出），且 `bridge/index.ts` 顶层
 * 直接调用 `main()`（import 它就会拉起整座桥，测试不可 import）⇒ 无法在测试里直接读该游标。
 * 故本用例以**行为**锁定契约：同一 `since` 反复读结果恒等（读口不持有、不推进任何服务端游标），
 * 且缺省 `since` 恒为 0（不会退化成「从隐式游标起」）。配合模块边界（`web.ts` 对 `index.ts`
 * 只有 `import type`）即成充分保证：网页路径**在类型与运行时都不可能**碰到宿主收件箱游标。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { appendEvent, createFeature, createTask, latestEventId } from "../session/store.js";
import type { ProjectStatus } from "../types.js";
import { renderIndexHtml } from "../bridge/web/html.js";
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
    readiness:
      overrides.readiness ??
      (() => ({ role: "owner", pid: 4242, startedAt: "2026-09-16T00:00:00Z" })),
    version: overrides.version ?? "0.5.0-test",
  };
  if (overrides.refreshMs !== undefined) options.refreshMs = overrides.refreshMs;
  if (overrides.unref !== undefined) options.unref = overrides.unref;
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
  features?: Array<{ featureId: string; title: string; state: string; taskCount: number }>;
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

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test("GET / → 内联 HTML（非空 + 桥标识 + 刷新下限 15s + 无外部资源标签）", async () => {
  // refreshMs 低于下限 ⇒ 服务端应收口到 15000
  const handle = await startWeb(fakeCore(), { refreshMs: 1_000 });
  const page = await get(handle.port, "/");
  assert.equal(page.status, 200);
  assert.match(String(page.contentType), /text\/html/);
  assert.ok(page.text.length > 0, "HTML 非空");
  assert.match(page.text, /^<!doctype html>/i);
  assert.ok(page.text.includes("owner"), "页面应显示 role（RuntimeReadiness）");
  assert.ok(page.text.includes("4242"), "页面应显示 pid（RuntimeReadiness）");
  assert.ok(page.text.includes("2026-09-16T00:00:00Z"), "页面应显示 startedAt（RuntimeReadiness）");
  assert.ok(page.text.includes("0.5.0-test"), "页面应显示桥版本");
  assert.ok(page.text.includes("15000"), "自动刷新间隔下限应为 15000ms");
  assert.ok(!/\ssrc=|\shref=/i.test(page.text), "页面不得经标签加载外部资源（零前端工具链）");
  assert.match(String(page.csp), /default-src 'none'/, "HTML 应下发 CSP（禁止外部资源）");
});

test("renderIndexHtml：未就绪（readiness=null）如实标注 starting", () => {
  const html = renderIndexHtml({ readiness: null, version: "0.5.0", refreshMs: 15_000 });
  assert.ok(html.length > 0);
  assert.ok(html.includes("<dt>role</dt><dd>starting</dd>"));
  assert.ok(html.includes("未就绪"));
});

test("GET / → 层级视图「需求 → 任务」（§8 增补 #2）：无手输 projectId / 无查询按钮 / 中文状态映射在展示层", async () => {
  const handle = await startWeb(fakeCore());
  const page = await get(handle.port, "/");
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("需求 → 任务"), "两块面板应合并为「需求 → 任务」层级视图");
  assert.ok(page.text.includes("需求（标题）"), "需求行主标识应为标题");
  assert.ok(page.text.includes("进度"), "需求行应含「进度」列");
  assert.ok(page.text.includes("/api/features/"), "展开应懒加载 GET /api/features/:featureId");
  assert.equal(
    /id="tasks-project"|查询任务|本地库 \+ 只读探测/.test(page.text),
    false,
    "手输 projectId / 「查询任务」按钮 / 术语长句应已移除",
  );
  for (const zh of ["待审批", "执行中", "集成中", "测试中", "评审中", "已完成", "待澄清", "失败", "已取消", "已阻塞"]) {
    assert.ok(page.text.includes(zh), `页面应含中文状态「${zh}」（映射只在展示层）`);
  }
});

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

test("路由形状：未知路径 404；已注册路径非 GET → 405", async () => {
  const handle = await startWeb(fakeCore());

  const missing = await get(handle.port, "/api/nope");
  assert.equal(missing.status, 404);
  assert.equal(json<ErrorBody>(missing).code, "not_found");

  const apiNotGet = await get(handle.port, "/api/projects", "POST");
  assert.equal(apiNotGet.status, 405);
  assert.equal(json<ErrorBody>(apiNotGet).code, "method_not_allowed");

  const pageNotGet = await get(handle.port, "/", "POST");
  assert.equal(pageNotGet.status, 405);

  const featureNotGet = await get(handle.port, "/api/features/f1", "DELETE");
  assert.equal(featureNotGet.status, 405);
});

test("GET /api/features（列表 / 单查 / 未知 404）→ 复用 handleFeatureStatus", async () => {
  const feature = createFeature({ featureId: "f-web-1", title: "只读工作台" });
  const core = fakeCore({
    featureStatus: (args) => {
      if (args.featureId === undefined) {
        return { ok: true, features: [{ ...feature, taskCount: 0 }] };
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

  const one = await get(handle.port, "/api/features/f-web-1");
  assert.equal(one.status, 200);
  assert.equal(json<FeaturesBody>(one).feature?.featureId, "f-web-1");

  const unknown = await get(handle.port, "/api/features/f-nope");
  assert.equal(unknown.status, 404);
  assert.equal(json<ErrorBody>(unknown).code, "feature_not_found");
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
                prompt: "do it",
                remoteTaskId: null,
                dependencies: null,
                inputArtifacts: null,
                updatedAt: "2026-09-16T02:00:00Z",
                failureKind: null,
                retryCount: 0,
              },
              {
                taskId: "t-web-no-record",
                projectId: "p2",
                state: "working" as const,
                prompt: null,
                remoteTaskId: null,
                dependencies: null,
                inputArtifacts: null,
                updatedAt: "2026-09-16T02:00:00Z",
                failureKind: null,
                retryCount: 0,
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
