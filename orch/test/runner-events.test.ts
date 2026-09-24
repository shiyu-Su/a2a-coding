/**
 * v0.7.0 A7 · Runner 事件生产与心跳超期清算单测。
 *
 * 覆盖节点门禁（「离线 → requeue → 回线 claim 复用同一 CAS + 事件留痕」）：
 * - **sweepStale 判定**：心跳静默 ≥ `runner.heartbeatTimeoutMs` ⇒ 该 Runner 名下 `claimed` 任务
 *   被 `requeueStaleTask` 回收为 `queued` + 清 claim 令牌/时刻两字段（v0.8.7 O4 起保留
 *   `claimed_by`），注册态降 `offline`；**幂等**（重跑零变更）；
 * - **事件留痕 + signalEvents**：`task.stale` / `runner.offline` / `runner.online` / `task.claimed`
 *   逐条落 `events` 表，且每次落库均触发注入的 `signalEvents`（收件箱唤醒）；
 * - **回线复用同一 CAS**：Runner 回归经 `/runner/connect`（poll 即心跳）照常 `claim` 同一条被回收的
 *   任务（`queue_state='queued'` → `'claimed'`，新 `claim_token`），并发 `runner.online` 事件；
 * - **门闩**：非 owner（follower）⇒ `sweepStale()` 空结果、零写库。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  claimTask,
  close as closeStore,
  createTask,
  enqueueTask,
  getQueuedTask,
  getRunner,
  listEvents,
  upsertRunner,
} from "../session/store.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import { memberKey } from "../config.js";
import {
  RUNNER_CONNECT_PATH,
  RUNNER_EVENT_OFFLINE,
  RUNNER_EVENT_ONLINE,
  RUNNER_REGISTER_PATH,
  RUNNER_EVENT_TASK_CLAIMED,
  RUNNER_EVENT_TASK_STALE,
  createRunnerEndpoints,
  type RunnerEndpointHandle,
  type RunnerEndpointOptions,
} from "../bridge/runner.js";
import type { BridgeCore } from "../bridge/index.js";
import type { EventRecord, MachineRef, MachinesConfig, ProjectGroup } from "../types.js";

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
    featureTrace: () => unused("featureTrace"),
    kickScheduler: () => unused("kickScheduler"),
  };
}

function machine(machineId: string, token?: string): MachineRef {
  return token === undefined
    ? { machineId, launcherUrl: "" }
    : { machineId, launcherUrl: "", token };
}

function makeConfig(machines: MachineRef[], heartbeatTimeoutMs: number): MachinesConfig {
  return {
    machines,
    transport: { mode: "http", http: { host: "127.0.0.1", port: 0, path: "/mcp" } },
    web: { enabled: false, host: "127.0.0.1", port: 0 },
    runner: { holdMs: 50, heartbeatTimeoutMs, orphanTimeoutMs: 1_800_000 },
  };
}

/** 单机选择性成员配置（注册后 claim 前须成员准入） */
function memberConfig(
  machineId: string,
  token: string,
  projectId: string,
  heartbeatTimeoutMs: number,
): MachinesConfig {
  const members = [{ machineId, projectId }];
  const groups: ProjectGroup[] = [
    {
      name: "g1",
      members,
      memberKeys: new Set([memberKey(machineId, projectId)]),
      memberMachineIds: new Set([machineId]),
      selective: true,
    },
  ];
  return { ...makeConfig([machine(machineId, token)], heartbeatTimeoutMs), groups };
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
    sweepIntervalMs: 3_600_000, // 关闭自动循环：由用例显式调用 sweepStale() 确定性驱动
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

async function post(port: number, path: string, body: unknown, token?: string): Promise<unknown> {
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
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null; // 204 无体
  }
}

function dataOf(res: unknown): Record<string, unknown> {
  const envelope = (res ?? {}) as { data?: unknown };
  return (envelope.data ?? {}) as Record<string, unknown>;
}

/** 建任务并入队（`state = working`） */
function seedQueuedTask(taskId: string, projectId: string, contextId: string): void {
  createTask({
    taskId,
    projectId,
    contextId,
    state: "working",
    dispatchMessage: `${taskId}: run`,
    prompt: taskId,
  });
  assert.notEqual(enqueueTask(taskId), null, `任务 ${taskId} 应成功入队`);
}

function payloadOf(event: EventRecord): Record<string, unknown> {
  try {
    return JSON.parse(event.payload ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function eventsOfKind(kind: string, taskId?: string): EventRecord[] {
  return listEvents({ since: 0, limit: 1000 }).filter(
    (event) => event.kind === kind && (taskId === undefined || event.taskId === taskId),
  );
}

/** 按 payload.machineId 收窄（同一进程共享 `:memory:` 库，须防跨用例串味） */
function eventsForMachine(kind: string, machineId: string): EventRecord[] {
  return eventsOfKind(kind).filter((event) => payloadOf(event).machineId === machineId);
}

// ---------------------------------------------------------------------------
// ① sweepStale：超期 → requeue + 降态 + 事件 + signalEvents + 幂等
// ---------------------------------------------------------------------------

test("sweepStale：心跳超期 → requeue + runner.offline + task.stale（事件留痕 / 唤醒 / 幂等）", () => {
  const cfg = makeConfig([machine("m-sweep")], 1_000);
  let signals = 0;
  const handle = createRunnerEndpoints({
    role: () => "owner",
    config: () => cfg,
    now: () => Date.parse("2026-09-18T00:01:00.000Z"),
    sweepIntervalMs: 3_600_000,
    signalEvents: () => {
      signals += 1;
    },
  });

  upsertRunner({
    runnerId: "m-sweep",
    machineId: "m-sweep",
    protocolVersion: "2.0",
    state: "online",
    lastHeartbeatAt: "2026-09-18T00:00:00.000Z", // 静默 60s ≥ 1s
  });
  seedQueuedTask("t-sweep", "p-sweep", "c-sweep");
  const claimed = claimTask({ claimedBy: "m-sweep", projectIds: ["p-sweep"] });
  assert.notEqual(claimed, null);
  const firstToken = claimed?.claimToken ?? "";
  assert.ok(firstToken.length > 0);

  const before = listEvents({ since: 0, limit: 1000 }).length;
  const result = handle.sweepStale();

  assert.deepEqual(result.offlineRunners, ["m-sweep"]);
  assert.deepEqual(result.requeuedTasks, ["t-sweep"]);
  const requeued = getQueuedTask("t-sweep");
  assert.equal(requeued?.queueState, "queued", "被回收为 queued");
  assert.equal(requeued?.claimedBy, "m-sweep", "v0.8.7 O4：清算保留 claimed_by（补结算窄口凭据）");
  assert.equal(requeued?.claimToken, null);
  assert.equal(requeued?.claimedAt, null);
  assert.equal(getRunner("m-sweep")?.state, "offline", "注册态降 offline（D8：只降态）");

  const stale = eventsOfKind(RUNNER_EVENT_TASK_STALE, "t-sweep");
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.state, "queued");
  assert.equal(payloadOf(stale[0] ?? {}).machineId, "m-sweep");
  assert.equal(payloadOf(stale[0] ?? {}).projectId, "p-sweep");
  const offline = eventsForMachine(RUNNER_EVENT_OFFLINE, "m-sweep");
  assert.equal(offline.length, 1);
  assert.equal(offline[0]?.state, "offline");
  assert.equal(payloadOf(offline[0] ?? {}).machineId, "m-sweep");
  assert.equal(listEvents({ since: 0, limit: 1000 }).length - before, 2, "恰两条事件");
  assert.ok(signals >= 2, "每次落库都应唤醒收件箱");

  // 幂等：再清算一次 ⇒ 零变更、零新事件
  const again = handle.sweepStale();
  assert.deepEqual(again, { offlineRunners: [], requeuedTasks: [] });
  assert.equal(listEvents({ since: 0, limit: 1000 }).length - before, 2, "重复清算不得重复产事件");
});

// ---------------------------------------------------------------------------
// ② 离线 → requeue → 回线：/runner/connect 照常 claim（复用同一 CAS）+ runner.online
// ---------------------------------------------------------------------------

test("离线→requeue→回线：注册→领取→超期回收→/connect 照常 claim 同一 CAS + runner.online", async () => {
  const cfg = memberConfig("m-rec", "tok-rec", "p-rec", 1_000);
  let signals = 0;
  const h = await startHarness(cfg, {
    signalEvents: () => {
      signals += 1;
    },
  });

  const registered = await post(
    h.port,
    RUNNER_REGISTER_PATH,
    {
      machineId: "m-rec",
      protocolVersion: "2.0",
      projects: [{ projectId: "p-rec", agentKind: "opencode", a2aPort: 3091 }],
    },
    "tok-rec",
  );
  assert.equal((registered as { result?: unknown }).result, "ok");

  seedQueuedTask("t-rec", "p-rec", "c-rec");
  // 用例种子直写 store：限定本项目领取（否则会跨用例领走同库中更早入队的 t-sweep）
  const first = claimTask({ claimedBy: "m-rec", projectIds: ["p-rec"] });
  assert.equal(first?.taskId, "t-rec");
  const firstToken = first?.claimToken ?? "";

  // 模拟心跳超期（保留 online，仅把 lastHeartbeatAt 拨到远古）
  upsertRunner({
    runnerId: "m-rec",
    machineId: "m-rec",
    protocolVersion: "2.0",
    state: "online",
    lastHeartbeatAt: "1970-01-01T00:00:00.000Z",
  });
  const swept = h.handle.sweepStale();
  assert.deepEqual(swept.offlineRunners, ["m-rec"]);
  assert.deepEqual(swept.requeuedTasks, ["t-rec"]);
  assert.equal(getQueuedTask("t-rec")?.queueState, "queued");
  assert.equal(getRunner("m-rec")?.state, "offline");

  // 回线：poll 即心跳 ⇒ 发 runner.online，且被回收的任务照常 claim（同一 CAS 重入）
  const resumed = await post(h.port, RUNNER_CONNECT_PATH, { machineId: "m-rec" }, "tok-rec");
  const command = dataOf(resumed);
  assert.equal(command.command, "dispatch");
  assert.equal(command.taskId, "t-rec");
  assert.equal(getRunner("m-rec")?.state, "online", "心跳刷新置回 online");
  const reclaimed = getQueuedTask("t-rec");
  assert.equal(reclaimed?.queueState, "claimed");
  assert.equal(reclaimed?.claimedBy, "m-rec");
  assert.notEqual(reclaimed?.claimToken, firstToken, "回线应发新 claim_token（同一 CAS 重入）");
  assert.equal(reclaimed?.claimToken, command.claimToken);

  const online = eventsForMachine(RUNNER_EVENT_ONLINE, "m-rec");
  assert.equal(online.length, 1);
  assert.equal(online[0]?.state, "online");
  assert.equal(payloadOf(online[0] ?? {}).machineId, "m-rec");
  assert.equal(eventsOfKind(RUNNER_EVENT_TASK_STALE, "t-rec").length, 1);
  assert.equal(eventsForMachine(RUNNER_EVENT_OFFLINE, "m-rec").length, 1);
  assert.equal(
    eventsOfKind(RUNNER_EVENT_TASK_CLAIMED, "t-rec").length,
    1,
    "回线重领经端点发光（首领为用例直写 store，不经端点）",
  );
  assert.ok(signals >= 4, "registered/offline/stale/online/claimed 均触发唤醒");
});

// ---------------------------------------------------------------------------
// ③ 门闩：follower 不抢清算权（空结果、零写库）
// ---------------------------------------------------------------------------

test("门闩：follower ⇒ sweepStale 空结果且零写库（不抢清算权）", () => {
  const cfg = makeConfig([machine("m-fol")], 1_000);
  const handle = createRunnerEndpoints({
    role: () => "follower",
    config: () => cfg,
    now: () => Date.parse("2026-09-18T00:01:00.000Z"),
    sweepIntervalMs: 3_600_000,
  });
  upsertRunner({
    runnerId: "m-fol",
    machineId: "m-fol",
    protocolVersion: "2.0",
    state: "online",
    lastHeartbeatAt: "2026-09-18T00:00:00.000Z",
  });

  const result = handle.sweepStale();
  assert.deepEqual(result, { offlineRunners: [], requeuedTasks: [] });
  assert.equal(getRunner("m-fol")?.state, "online", "follower 不得降级他人注册态");
});
