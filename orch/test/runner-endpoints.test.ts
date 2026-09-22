/**
 * Runner 入站端点单元测试（`bridge/runner.ts` + `bridge/transports/http.ts` 路由分支；v0.7.0 A3）。
 *
 * 覆盖节点门禁：
 * - **鉴权三态**：缺 / 错 token ⇒ 401 `runner_unauthorized`；machineId ∉ `machines[]` ⇒ 403
 *   `runner_not_allowed`；协议主版本 ∉ `[2]` ⇒ 403 `protocol_version_mismatch`（结构化拒绝）；
 * - **成员拒绝**：选择性项目组下，非成员项目不 claim（心跳），显式请求非成员项目 ⇒ 403
 *   `project_not_a_member`；
 * - **多组 claim（v0.8.6 §2.5 N5）**：判据 = 「本机在**任一组**中的项目」—— 配组且属本组 ⇒ 放 ·
 *   属另一组 / 未配组内 ⇒ 拒 · **未配任何组 ⇒ 全放**（旧部署零破坏）；
 * - **CAS claim 唯一**：同一入队任务被两个并发 `/connect` 争抢 ⇒ 恰一个 `dispatch`、另一个心跳；
 * - **wake 唤醒**：挂起的 `/connect` 被 `wake(machineId)` 立即唤醒并领取新入队任务（远早于 hold）；
 * - **hold 超时**：无命令时到点返回 204（心跳）；
 * - **owner 门闩**：follower ⇒ 503 `runner_not_owner`（stdio 已退役，接入面恒 http）；
 * - **register 落库 / 事件 / 宽容解析**：投影全量替换 + `runner.registered` 事件 + 未知字段忽略；
 * - **result claim_token 校验**：错令牌 ⇒ 409，正确 ⇒ 200 ack 且幂等。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  close as closeStore,
  createTask,
  enqueueTask,
  getQueuedTask,
  listEvents,
  listRunnerProjects,
} from "../session/store.js";
import { memberKey } from "../config.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import {
  RUNNER_CONNECT_PATH,
  RUNNER_EVENT_REGISTERED,
  RUNNER_REGISTER_PATH,
  RUNNER_RESULT_PATH,
  createRunnerEndpoints,
  type RunnerEndpointHandle,
  type RunnerEndpointOptions,
} from "../bridge/runner.js";
import type { BridgeCore } from "../bridge/index.js";
import type { MachineRef, MachinesConfig, ProjectGroup } from "../types.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const transports: HttpTransportHandle[] = [];

after(async () => {
  for (const transport of transports) await transport.close();
  closeStore();
});

/** 内核桩：本测试从不触达 MCP 面（仅 `/runner/*`），故所有方法一律抛错 */
function unused(name: string): never {
  throw new Error(`unused BridgeCore method: ${name}`);
}

function fakeCore(): BridgeCore {
  return {
    projects: async () => unused("projects"),
    tasks: async () => unused("tasks"),
    call: async () => unused("call"),
    registerFeatureNode: () => unused("registerFeatureNode"),
    taskStatus: async () => unused("taskStatus"),
    cancel: async () => unused("cancel"),
    events: () => unused("events"),
    wait: async () => unused("wait"),
    featureCreate: () => unused("featureCreate"),
    featureStatus: () => unused("featureStatus"),
    featureAdvance: () => unused("featureAdvance"),
    featureApprove: () => unused("featureApprove"),
    featureCancel: () => unused("featureCancel"),
    kickScheduler: () => unused("kickScheduler"),
  };
}

function machine(machineId: string, token?: string): MachineRef {
  return token === undefined
    ? { machineId, launcherUrl: "" }
    : { machineId, launcherUrl: "", token };
}

function makeConfig(opts: {
  machines: MachineRef[];
  /** v0.8.6 §2.5 N5：claim 判据读**组数组**（`groups[]`，任一组放行）；`undefined` = 未配组段 */
  groups?: Array<{ name: string; members: Array<{ machineId: string; projectId: string }> }>;
  holdMs?: number;
}): MachinesConfig {
  let groups: ProjectGroup[] | undefined;
  if (opts.groups !== undefined) {
    groups = opts.groups.map((g) => ({
      name: g.name,
      members: g.members,
      memberKeys: new Set(g.members.map((m) => memberKey(m.machineId, m.projectId))),
      memberMachineIds: new Set(g.members.map((m) => m.machineId)),
      selective: true,
    }));
  }
  return {
    machines: opts.machines,
    transport: { mode: "http", http: { host: "127.0.0.1", port: 0, path: "/mcp" } },
    web: { enabled: false, host: "127.0.0.1", port: 0 },
    runner: { holdMs: opts.holdMs ?? 100, heartbeatTimeoutMs: 60_000 },
    ...(groups === undefined ? {} : { groups }),
  };
}

interface Harness {
  port: number;
  handle: RunnerEndpointHandle;
}

async function startHarness(
  cfg: MachinesConfig,
  overrides: Partial<RunnerEndpointOptions> = {},
): Promise<Harness> {
  const handle = createRunnerEndpoints({
    role: () => "owner",
    config: () => cfg,
    ...overrides,
  });
  const transport = await startHttpTransport({
    core: fakeCore(),
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    isReady: () => true,
    role: () => "owner",
    version: "test",
    onShutdown: () => {
      /* 测试不触发停机 */
    },
    runner: handle,
  });
  transports.push(transport);
  return { port: transport.port, handle };
}

interface HttpResult {
  status: number;
  text: string;
  body: unknown;
}

async function post(port: number, path: string, body: unknown, token?: string): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    /* 204 无体 */
  }
  return { status: res.status, text, body: parsed };
}

interface Envelope {
  result?: unknown;
  data?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

function envelope(res: HttpResult): Envelope {
  return (res.body ?? {}) as Envelope;
}

function dataOf(res: HttpResult): unknown {
  return envelope(res).data;
}

function errorCodeOf(res: HttpResult): unknown {
  return envelope(res).error?.code;
}

interface DispatchShape {
  command?: unknown;
  taskId?: unknown;
  claimToken?: unknown;
  message?: unknown;
  projectId?: unknown;
  commandId?: unknown;
}

/** 注册一个 Runner 及其项目（各用例通用前置） */
async function register(
  port: number,
  machineId: string,
  token: string,
  projects: Array<{ projectId: string; agentKind: string; a2aPort: number; risk?: string }>,
): Promise<HttpResult> {
  return post(
    port,
    RUNNER_REGISTER_PATH,
    { machineId, protocolVersion: "2.0", capabilities: {}, projects },
    token,
  );
}

/** 建任务并入队（`state = working`，携带派发消息） */
function seedQueuedTask(taskId: string, projectId: string, contextId: string, message: string): void {
  createTask({
    taskId,
    projectId,
    contextId,
    state: "working",
    dispatchMessage: message,
    prompt: message,
  });
  const enqueued = enqueueTask(taskId);
  assert.notEqual(enqueued, null, `任务 ${taskId} 应成功入队`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error("waitFor 超时");
    await delay(5);
  }
}

// ---------------------------------------------------------------------------
// 鉴权三态
// ---------------------------------------------------------------------------

test("鉴权三态：缺/错 token=401；非白名单机器=403；协议主版本不在 [2]=403；合法=200", async () => {
  const cfg = makeConfig({
    machines: [machine("m-auth", "tok-auth"), machine("m-no-token")],
    holdMs: 60,
  });
  const h = await startHarness(cfg);
  const projects = [{ projectId: "p-auth", agentKind: "opencode", a2aPort: 3021 }];

  // ① 缺 token
  const noToken = await post(h.port, RUNNER_REGISTER_PATH, {
    machineId: "m-auth",
    protocolVersion: "2.0",
    projects,
  });
  assert.equal(noToken.status, 401);
  assert.equal(errorCodeOf(noToken), "runner_unauthorized");

  // ① 错 token
  const badToken = await register(h.port, "m-auth", "wrong", projects);
  assert.equal(badToken.status, 401);
  assert.equal(errorCodeOf(badToken), "runner_unauthorized");

  // ① 该机未配置 token ⇒ 一律拒绝（绝不 fail-open）
  const unconfigured = await register(h.port, "m-no-token", "whatever", projects);
  assert.equal(unconfigured.status, 401);
  assert.equal(errorCodeOf(unconfigured), "runner_unauthorized");

  // ② machineId 不在白名单
  const ghost = await register(h.port, "m-ghost", "tok-auth", projects);
  assert.equal(ghost.status, 403);
  assert.equal(errorCodeOf(ghost), "runner_not_allowed");

  // ③ 协议主版本不在 [2]（结构化拒绝）
  const oldProtocol = await post(
    h.port,
    RUNNER_REGISTER_PATH,
    { machineId: "m-auth", protocolVersion: "1.0", projects },
    "tok-auth",
  );
  assert.equal(oldProtocol.status, 403);
  assert.equal(errorCodeOf(oldProtocol), "protocol_version_mismatch");
  assert.ok(String(envelope(oldProtocol).error?.message).includes("可支持主版本=[2]"));

  // 合法
  const ok = await register(h.port, "m-auth", "tok-auth", projects);
  assert.equal(ok.status, 200);
  assert.equal(envelope(ok).result, "ok");
});

// ---------------------------------------------------------------------------
// 注册：投影全量替换 + 事件 + 宽容解析
// ---------------------------------------------------------------------------

test("register：upsertRunner/全量替换投影 + runner.registered 事件；capabilities 与未知字段宽容忽略", async () => {
  const cfg = makeConfig({ machines: [machine("m-reg", "tok-reg")], holdMs: 60 });
  const h = await startHarness(cfg);

  const first = await post(
    h.port,
    RUNNER_REGISTER_PATH,
    {
      machineId: "m-reg",
      protocolVersion: "2.0",
      capabilities: { os: "linux", tools: ["git"] },
      selfCheck: { ok: true, failures: [] },
      unknownTopLevel: { anything: true },
      projects: [
        { projectId: "p-a", agentKind: "opencode", a2aPort: 3031, risk: "read", unknown: 1 },
        { projectId: "p-b", agentKind: "codex", a2aPort: 3032 },
      ],
    },
    "tok-reg",
  );
  assert.equal(first.status, 200);
  assert.deepEqual(listRunnerProjects("m-reg").map((p) => p.projectId), ["p-a", "p-b"]);
  assert.equal(listRunnerProjects("m-reg")[0]?.agentKind, "opencode");
  assert.equal(listRunnerProjects("m-reg")[0]?.risk, "read");

  // 全量替换：第二次只报 1 个 ⇒ 旧项目消失
  const second = await register(h.port, "m-reg", "tok-reg", [
    { projectId: "p-b", agentKind: "codex", a2aPort: 3032 },
  ]);
  assert.equal(second.status, 200);
  assert.deepEqual(listRunnerProjects("m-reg").map((p) => p.projectId), ["p-b"]);

  const registered = listEvents({ since: 0 }).filter(
    (event) =>
      event.kind === RUNNER_EVENT_REGISTERED &&
      (JSON.parse(event.payload ?? "{}") as { machineId?: unknown }).machineId === "m-reg",
  );
  assert.equal(registered.length, 2);
  const payload = JSON.parse(registered[0]?.payload ?? "{}") as { machineId?: unknown; projects?: unknown };
  assert.equal(payload.machineId, "m-reg");
  assert.deepEqual(payload.projects, ["p-a", "p-b"]);
});

// ---------------------------------------------------------------------------
// 成员拒绝
// ---------------------------------------------------------------------------

test("成员拒绝：非成员项目不 claim（心跳）；显式请求非成员项目 ⇒ project_not_a_member", async () => {
  const cfg = makeConfig({
    machines: [machine("m-member", "tok-member")],
    groups: [{ name: "g1", members: [{ machineId: "m-member", projectId: "p-in" }] }],
    holdMs: 60,
  });
  const h = await startHarness(cfg);
  await register(h.port, "m-member", "tok-member", [
    { projectId: "p-in", agentKind: "opencode", a2aPort: 3041 },
    { projectId: "p-out", agentKind: "opencode", a2aPort: 3042 },
  ]);

  // 非成员项目任务：不入 claim（心跳）
  seedQueuedTask("t-out", "p-out", "ctx-out", "should not be claimed");
  const heartbeat = await post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-member" }, "tok-member");
  assert.equal(heartbeat.status, 204);
  assert.equal(getQueuedTask("t-out")?.queueState, "queued");

  // 显式请求非成员项目 ⇒ 403
  const denied = await post(
    h.port,
    RUNNER_CONNECT_PATH,
    { machineId: "m-member", projects: ["p-out"] },
    "tok-member",
  );
  assert.equal(denied.status, 403);
  assert.equal(errorCodeOf(denied), "project_not_a_member");

  // 成员项目任务：可 claim
  seedQueuedTask("t-in", "p-in", "ctx-in", "claim me");
  const dispatch = await post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-member" }, "tok-member");
  assert.equal(dispatch.status, 200);
  const command = dataOf(dispatch) as DispatchShape;
  assert.equal(command.command, "dispatch");
  assert.equal(command.taskId, "t-in");
  assert.equal(command.projectId, "p-in");

  // 非白名单机器的 connect 亦 403 runner_not_allowed
  const ghost = await post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-ghost2" }, "tok-member");
  assert.equal(ghost.status, 403);
  assert.equal(errorCodeOf(ghost), "runner_not_allowed");
});

// ---------------------------------------------------------------------------
// 多组 claim「任一组放行」（v0.8.6 §2.5 S5 / N5）
// ---------------------------------------------------------------------------

test("N5 ① 配组 + 项目属本机所在组 ⇒ 放（claim 成功下发 dispatch）", async () => {
  const cfg = makeConfig({
    machines: [machine("m-n5a", "tok-n5a")],
    groups: [
      { name: "gA", members: [{ machineId: "m-n5a", projectId: "n5a-in" }] },
      { name: "gB", members: [{ machineId: "m-n5b", projectId: "n5a-other" }] },
    ],
    holdMs: 60,
  });
  const h = await startHarness(cfg);
  await register(h.port, "m-n5a", "tok-n5a", [
    { projectId: "n5a-in", agentKind: "opencode", a2aPort: 3061 },
  ]);
  seedQueuedTask("t-n5a-in", "n5a-in", "ctx-n5a-in", "claim me");

  const dispatch = await post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-n5a" }, "tok-n5a");
  assert.equal(dispatch.status, 200);
  const command = dataOf(dispatch) as DispatchShape;
  assert.equal(command.command, "dispatch");
  assert.equal(command.taskId, "t-n5a-in");
  assert.equal(command.projectId, "n5a-in");
});

test("N5 ② 项目属另一组 / 不属任何组 ⇒ 静默不 claim（心跳）；显式请求则 403 project_not_a_member", async () => {
  const cfg = makeConfig({
    machines: [machine("m-n5b", "tok-n5b"), machine("m-n5c", "tok-n5c")],
    groups: [
      // 本机自己在 gA 只有一个成员项目
      { name: "gA", members: [{ machineId: "m-n5b", projectId: "n5b-in" }] },
      // 同 projectId 挂在**另一台机器**的 gB 组下 ⇒ 对本机不是成员（memberKey 同源于 (machineId,projectId)）
      { name: "gB", members: [{ machineId: "m-n5c", projectId: "n5b-foreign" }] },
    ],
    holdMs: 60,
  });
  const h = await startHarness(cfg);
  await register(h.port, "m-n5b", "tok-n5b", [
    { projectId: "n5b-in", agentKind: "opencode", a2aPort: 3062 },
    { projectId: "n5b-foreign", agentKind: "opencode", a2aPort: 3063 },
    { projectId: "n5b-ungrouped", agentKind: "opencode", a2aPort: 3064 },
  ]);

  // 另一组的项目 + 未配进任何组的项目：均不入 claim（心跳），且任务仍留队列
  seedQueuedTask("t-n5b-foreign", "n5b-foreign", "ctx-n5b-1", "should not be claimed");
  seedQueuedTask("t-n5b-ungrouped", "n5b-ungrouped", "ctx-n5b-2", "should not be claimed");
  const heartbeat = await post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-n5b" }, "tok-n5b");
  assert.equal(heartbeat.status, 204);
  assert.equal(getQueuedTask("t-n5b-foreign")?.queueState, "queued");
  assert.equal(getQueuedTask("t-n5b-ungrouped")?.queueState, "queued");

  // 显式请求另一组的项目 ⇒ 403 + 结构化错误码 + 文案指路
  const denied = await post(
    h.port,
    RUNNER_CONNECT_PATH,
    { machineId: "m-n5b", projects: ["n5b-foreign"] },
    "tok-n5b",
  );
  assert.equal(denied.status, 403);
  assert.equal(errorCodeOf(denied), "project_not_a_member");
  assert.match(String(envelope(denied).error?.message ?? ""), /不在本机任一组成员集合/);

  // 显式请求未配组的项目 ⇒ 同样 403
  const denied2 = await post(
    h.port,
    RUNNER_CONNECT_PATH,
    { machineId: "m-n5b", projects: ["n5b-ungrouped"] },
    "tok-n5b",
  );
  assert.equal(denied2.status, 403);
  assert.equal(errorCodeOf(denied2), "project_not_a_member");

  // 本机所在组的项目照旧可 claim（对照组：证明上面被拒不是「全拒」造成）
  seedQueuedTask("t-n5b-in", "n5b-in", "ctx-n5b-3", "claim me");
  const dispatch = await post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-n5b" }, "tok-n5b");
  assert.equal(dispatch.status, 200);
  assert.equal((dataOf(dispatch) as DispatchShape).taskId, "t-n5b-in");
});

test("N5 ③ 未配任何组 ⇒ 本机注册项目全放（零破坏，含显式清单）", async () => {
  const cfg = makeConfig({
    machines: [machine("m-n5c", "tok-n5c")],
    groups: [], // 显式空组数组 = 未配组（与段缺失同语义）
    holdMs: 60,
  });
  const h = await startHarness(cfg);
  await register(h.port, "m-n5c", "tok-n5c", [
    { projectId: "n5c-p1", agentKind: "opencode", a2aPort: 3065 },
    { projectId: "n5c-p2", agentKind: "opencode", a2aPort: 3066 },
  ]);

  seedQueuedTask("t-n5c-p1", "n5c-p1", "ctx-n5c-1", "claim me first");
  const first = await post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-n5c" }, "tok-n5c");
  assert.equal(first.status, 200);
  const c1 = dataOf(first) as DispatchShape;
  assert.equal(c1.command, "dispatch");
  assert.equal(c1.taskId, "t-n5c-p1");
  assert.equal(c1.projectId, "n5c-p1");

  // 显式请求清单里的项目：未配组 ⇒ 不因成员判定被拒（仍按本机注册投影放行）
  seedQueuedTask("t-n5c-p2", "n5c-p2", "ctx-n5c-2", "claim me second");
  const scoped = await post(
    h.port,
    RUNNER_CONNECT_PATH,
    { machineId: "m-n5c", projects: ["n5c-p2"] },
    "tok-n5c",
  );
  assert.equal(scoped.status, 200);
  const c2 = dataOf(scoped) as DispatchShape;
  assert.equal(c2.taskId, "t-n5c-p2");
  assert.equal(c2.projectId, "n5c-p2");
});

// ---------------------------------------------------------------------------
// CAS claim 唯一
// ---------------------------------------------------------------------------

test("CAS claim 唯一：同一入队任务被两个并发 /connect 争抢 ⇒ 恰一个 dispatch、另一个心跳", async () => {
  const cfg = makeConfig({ machines: [machine("m-cas", "tok-cas")], holdMs: 80 });
  const h = await startHarness(cfg);
  await register(h.port, "m-cas", "tok-cas", [
    { projectId: "p-cas", agentKind: "opencode", a2aPort: 3051 },
  ]);
  seedQueuedTask("t-cas", "p-cas", "ctx-cas", "claim once");

  const [a, b] = await Promise.all([
    post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-cas" }, "tok-cas"),
    post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-cas" }, "tok-cas"),
  ]);
  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [200, 204], "并发领取应恰有一个命中");
  const winner = a.status === 200 ? a : b;
  assert.equal((dataOf(winner) as DispatchShape).taskId, "t-cas");

  const stored = getQueuedTask("t-cas");
  assert.equal(stored?.queueState, "claimed");
  assert.equal(stored?.claimedBy, "m-cas");
  assert.ok((stored?.claimToken ?? "").length > 0);
});

// ---------------------------------------------------------------------------
// wake 唤醒
// ---------------------------------------------------------------------------

test("wake 唤醒：挂起的 /connect 被立刻唤醒并领取新入队任务（远早于 hold）", async () => {
  const cfg = makeConfig({ machines: [machine("m-wake", "tok-wake")], holdMs: 3_000 });
  const h = await startHarness(cfg);
  await register(h.port, "m-wake", "tok-wake", [
    { projectId: "p-wake", agentKind: "opencode", a2aPort: 3061 },
  ]);

  const startedAt = Date.now();
  const pending = post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-wake" }, "tok-wake");
  await waitFor(() => h.handle.pendingConnects() === 1, 2_000);

  // 长轮询挂起后，新任务入队 → 派发侧 wake
  seedQueuedTask("t-wake", "p-wake", "ctx-wake", "wake me up");
  h.handle.wake("m-wake");

  const res = await pending;
  const elapsed = Date.now() - startedAt;
  assert.equal(res.status, 200);
  assert.equal((dataOf(res) as DispatchShape).taskId, "t-wake");
  assert.ok(elapsed < 2_000, `应被立即唤醒而非等到 hold（实测 ${elapsed}ms）`);
});

// ---------------------------------------------------------------------------
// hold 超时
// ---------------------------------------------------------------------------

test("hold 超时：无命令时到点返回 204 心跳（且不超过请求/配置的 hold 上限）", async () => {
  const cfg = makeConfig({ machines: [machine("m-hold", "tok-hold")], holdMs: 70 });
  const h = await startHarness(cfg);
  await register(h.port, "m-hold", "tok-hold", [
    { projectId: "p-hold", agentKind: "opencode", a2aPort: 3071 },
  ]);

  const startedAt = Date.now();
  const res = await post(
    h.port,
    RUNNER_CONNECT_PATH,
    { machineId: "m-hold", holdMs: 5_000 },
    "tok-hold",
  );
  const elapsed = Date.now() - startedAt;
  assert.equal(res.status, 204);
  assert.equal(res.text, "");
  assert.ok(elapsed >= 60, `应挂起至 hold（实测 ${elapsed}ms）`);
  assert.ok(elapsed < 1_000, `hold 请求值须被配置上限夹住（实测 ${elapsed}ms）`);
  assert.equal(getQueuedTask("t-nonexistent"), null);
});

// ---------------------------------------------------------------------------
// owner 门闩（stdio 已退役，接入面恒 http）
// ---------------------------------------------------------------------------

test("owner 门闩：follower ⇒ 503 runner_not_owner", async () => {
  const cfg = makeConfig({ machines: [machine("m-gate", "tok-gate")], holdMs: 60 });
  const follower = await startHarness(cfg, { role: () => "follower" });
  const denied = await post(
    follower.port,
    RUNNER_REGISTER_PATH,
    { machineId: "m-gate", protocolVersion: "2.0", projects: [] },
    "tok-gate",
  );
  assert.equal(denied.status, 503);
  assert.equal(errorCodeOf(denied), "runner_not_owner");
});

// ---------------------------------------------------------------------------
// /runner/result：claim_token 校验 + 幂等 ack
// ---------------------------------------------------------------------------

test("result：claim_token 校验（错=409）；正确=200 ack 且重复上报幂等", async () => {
  const cfg = makeConfig({ machines: [machine("m-res", "tok-res")], holdMs: 60 });
  const h = await startHarness(cfg);
  await register(h.port, "m-res", "tok-res", [
    { projectId: "p-res", agentKind: "opencode", a2aPort: 3081 },
  ]);
  seedQueuedTask("t-res", "p-res", "ctx-res", "run me");

  const dispatch = await post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-res" }, "tok-res");
  const command = dataOf(dispatch) as DispatchShape;
  const claimToken = String(command.claimToken);
  assert.ok(claimToken.length > 0);

  const wrong = await post(
    h.port,
    RUNNER_RESULT_PATH,
    { machineId: "m-res", taskId: "t-res", claimToken: "stale-token", state: "completed" },
    "tok-res",
  );
  assert.equal(wrong.status, 409);
  assert.equal(errorCodeOf(wrong), "claim_token_mismatch");

  const ok = await post(
    h.port,
    RUNNER_RESULT_PATH,
    {
      machineId: "m-res",
      taskId: "t-res",
      claimToken,
      projectId: "p-res",
      contextId: "ctx-res",
      state: "completed",
      text: "done",
      artifacts: [{ name: "out.txt", text: "hello" }],
    },
    "tok-res",
  );
  assert.equal(ok.status, 200);
  assert.equal(envelope(ok).result, "ok");
  const ack = dataOf(ok) as { ack?: unknown; taskId?: unknown; state?: unknown; idempotent?: unknown };
  assert.equal(ack.ack, true);
  assert.equal(ack.taskId, "t-res");
  assert.equal(ack.state, "completed");
  assert.equal(ack.idempotent, false);

  const stored = getQueuedTask("t-res");
  assert.equal(stored?.state, "completed");
  assert.equal(stored?.queueState, "settled");
  assert.equal(stored?.text, "done");

  // 重复上报（同 claim_token）：幂等 ack，不覆盖首个终态
  const duplicate = await post(
    h.port,
    RUNNER_RESULT_PATH,
    {
      machineId: "m-res",
      taskId: "t-res",
      claimToken,
      state: "failed",
      text: "late failure",
    },
    "tok-res",
  );
  assert.equal(duplicate.status, 200);
  const duplicateAck = dataOf(duplicate) as { state?: unknown; idempotent?: unknown };
  assert.equal(duplicateAck.state, "completed");
  assert.equal(duplicateAck.idempotent, true);
  assert.equal(getQueuedTask("t-res")?.text, "done");
});

// ---------------------------------------------------------------------------
// 控制命令（stop / cancel-task）
// ---------------------------------------------------------------------------

test("控制命令：stop / cancel-task 优先于 dispatch 下发，取最早就绪者（载荷含 commandId / projectId）", async () => {
  const cfg = makeConfig({ machines: [machine("m-ctrl", "tok-ctrl")], holdMs: 60 });
  const h = await startHarness(cfg);
  await register(h.port, "m-ctrl", "tok-ctrl", [
    { projectId: "p-ctrl", agentKind: "opencode", a2aPort: 3091 },
  ]);
  seedQueuedTask("t-ctrl", "p-ctrl", "ctx-ctrl", "queued work");

  h.handle.enqueueCancelTask("m-ctrl", "t-ctrl");
  h.handle.enqueueStop("m-ctrl", "p-ctrl");
  assert.equal(h.handle.pendingControls("m-ctrl"), 2);

  const first = await post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-ctrl" }, "tok-ctrl");
  assert.equal(first.status, 200);
  const cancelCommand = dataOf(first) as DispatchShape;
  assert.equal(cancelCommand.command, "cancel-task");
  assert.equal(cancelCommand.taskId, "t-ctrl");
  assert.equal(cancelCommand.projectId, "p-ctrl");
  assertNonEmptyString(cancelCommand.commandId, "cancel-task.commandId");

  const second = await post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-ctrl" }, "tok-ctrl");
  assert.equal(second.status, 200);
  const stopCommand = dataOf(second) as DispatchShape;
  assert.equal(stopCommand.command, "stop");
  assert.equal(stopCommand.projectId, "p-ctrl");
  assertNonEmptyString(stopCommand.commandId, "stop.commandId");

  // 控制命令清空后，才轮到 dispatch（dispatch 载荷亦携 commandId）
  const third = await post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-ctrl" }, "tok-ctrl");
  assert.equal((dataOf(third) as DispatchShape).command, "dispatch");
  assertNonEmptyString((dataOf(third) as DispatchShape).commandId, "dispatch.commandId");
  assert.equal(h.handle.pendingControls("m-ctrl"), 0);
});

test("cancel-task 载荷含 taskId/projectId/commandId；machine 回执 commandId 可原样回带（宽容接收）", async () => {
  const cfg = makeConfig({ machines: [machine("m-ack", "tok-ack")], holdMs: 40 });
  const h = await startHarness(cfg);
  await register(h.port, "m-ack", "tok-ack", [
    { projectId: "p-ack", agentKind: "opencode", a2aPort: 3093 },
  ]);
  seedQueuedTask("t-ack", "p-ack", "ctx-ack", "cancel me");

  h.handle.enqueueCancelTask("m-ack", "t-ack");
  const commandRes = await post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-ack" }, "tok-ack");
  assert.equal(commandRes.status, 200);
  const command = dataOf(commandRes) as DispatchShape;
  assert.equal(command.command, "cancel-task");
  assert.equal(command.taskId, "t-ack");
  assert.equal(command.projectId, "p-ack");
  assertNonEmptyString(command.commandId, "cancel-task.commandId");

  // machine 语义键回执：下一轮 `/connect` 的 `acks[]` 携 `{ commandId, error? }` ⇒ 桥宽容接收（200，不 400）
  const ackRes = await post(
    h.port,
    RUNNER_CONNECT_PATH,
    { machineId: "m-ack", acks: [{ commandId: command.commandId }] },
    "tok-ack",
  );
  assert.equal(ackRes.status, 200);
  assert.equal(envelope(ackRes).result, "ok");
  assert.equal((dataOf(ackRes) as DispatchShape).command, "dispatch");
});

/** 断言字段为「非空字符串」（命令 id 契约：桥侧 uuid 生成，任何命令族载荷均不得为空） */
function assertNonEmptyString(value: unknown, label: string): void {
  assert.equal(typeof value, "string", `${label} 应为 string（实测 ${typeof value}）`);
  assert.ok((value as string).length > 0, `${label} 不应为空串`);
}
