/**
 * v0.8.8 O3 单测（`node:test`，无新依赖）：`diagnostics` 宽 JSON 落库 + `task.continued` 派生事件。
 *
 * 覆盖（改造文档 §2.2 / §2.5 落库口径；验收判据 ①~④）：
 * - **① `continueAttempts = 0`（缺键 / 显式 0 / 形状不符）⇒ 不发** `task.continued`；
 * - **② `> 0` ⇒ 恰发一条且 payload 键齐**（§2.2 键清单逐键显式读；机侧缺报的键省略）；
 * - **③ 宽 JSON 能原样读回**（断言读到的是**原文结构**：数值 / 布尔 / 嵌套 `acpErrorData` 原文，
 *   不是派生布尔 —— §2.5「返工红线」）；
 * - **④ 事件消费面无漏改**：`a2a_events`（`core.events`）与 `a2a_wait` 全量转发新 kind；
 * - 口径：`task.settled.continueAttempts` 自 O3 起取 diagnostics 值；`attempt` 仍只取
 *   `retry_count`（续跑**不落 `retry_count`**，§2.2 正交双口径）；迟到 / 重复上报 ⇒ 零事件、
 *   零诊断覆写（首个终态胜出）；续跑后转 `input-required`（非终态）仍留痕、**不发** `task.settled`。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_TASK_CONTINUED,
  EVENT_TASK_SETTLED,
  claimTask,
  close as closeStore,
  createTask,
  enqueueTask,
  getTask,
  listEvents,
  rearmForRetry,
  upsertRunner,
  upsertTaskResult,
} from "../session/store.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import { RUNNER_RESULT_PATH, createRunnerEndpoints, type RunnerEndpointOptions } from "../bridge/runner.js";
import type { BridgeCore } from "../bridge/index.js";
import type { MachineRef, MachinesConfig } from "../types.js";

// ---------------------------------------------------------------------------
// 脚手架（同 o3-failure-kind.test.ts 先例）
// ---------------------------------------------------------------------------

const transports: HttpTransportHandle[] = [];

after(async () => {
  for (const transport of transports) await transport.close();
  closeStore();
});

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
    // ④ 事件消费面：`a2a_events` / `a2a_wait` 走 core 的真实现（下方 serve 注入）
    events: () => unused("events"),
    wait: async () => unused("wait"),
    featureCreate: () => unused("featureCreate"),
    featureStatus: () => unused("featureStatus"),
    featureAdvance: () => unused("featureAdvance"),
    featureApprove: () => unused("featureApprove"),
    featureCancel: () => unused("featureCancel"),
    featureTrace: () => unused("featureTrace"),
    configWriteGroup: async () => unused("configWriteGroup"),
    kickScheduler: () => unused("kickScheduler"),
  };
}

const NOW = Date.parse("2026-09-22T03:00:00.000Z");

function makeConfig(machineId: string, token: string): MachinesConfig {
  const machines: MachineRef[] = [{ machineId, launcherUrl: "", token }];
  return {
    machines,
    transport: { mode: "http", http: { host: "127.0.0.1", port: 0, path: "/mcp" } },
    web: { enabled: false, host: "127.0.0.1", port: 0 },
    runner: { holdMs: 50, heartbeatTimeoutMs: 3_600_000, orphanTimeoutMs: 1_800_000 },
  };
}

function endpoints(machineId: string, overrides: Partial<RunnerEndpointOptions> = {}) {
  return createRunnerEndpoints({
    role: () => "owner",
    config: () => makeConfig(machineId, `tok-${machineId}`),
    now: () => NOW,
    sweepIntervalMs: 3_600_000, // 关闭自动循环：由用例显式驱动
    ...overrides,
  });
}

async function serve(handle: ReturnType<typeof createRunnerEndpoints>): Promise<number> {
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
  return transport.port;
}

/** 登记 + 入队 + 领取（`projectIds` 限定本项目：同进程共享 `:memory:` 库） */
function seed(taskId: string, projectId: string, machineId: string, claimToken: string): void {
  createTask({
    taskId,
    projectId,
    contextId: `ctx-${taskId}`,
    state: "working",
    dispatchMessage: `${taskId}: run`,
    prompt: taskId,
  });
  assert.notEqual(enqueueTask(taskId), null);
  const claimed = claimTask({
    claimedBy: machineId,
    claimToken,
    claimedAt: new Date(NOW).toISOString(),
    projectIds: [projectId],
  });
  assert.equal(claimed?.taskId, taskId, `任务 ${taskId} 应被领取`);
}

async function post(
  port: number,
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${RUNNER_RESULT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 无体响应
  }
  return { status: res.status, data: (parsed["data"] ?? {}) as Record<string, unknown> };
}

function continuedEvents(taskId?: string) {
  return listEvents().filter((e) => e.kind === EVENT_TASK_CONTINUED && (taskId === undefined || e.taskId === taskId));
}

function settledEvents(taskId: string) {
  return listEvents().filter((e) => e.kind === EVENT_TASK_SETTLED && e.taskId === taskId);
}

/** §2.2 payload 键清单中「本版本机侧必带」的键（`remainingMs` 见文件末专项用例） */
const CONTINUED_REQUIRED_KEYS = [
  "taskId",
  "machineId",
  "projectId",
  "continueAttempts",
  "continueTrigger",
  "timeoutScope",
  "partialChars",
  "updateCount",
  "firstChunkElapsedMs",
  "sessionResumed",
] as const;

/** 一次真实续跑回传的完整 diagnostics（M1/M2/M3 形状：计量 + 续跑留痕 + 取证面原文） */
function continuedDiagnostics(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    acpErrorKind: "timeout",
    acpErrorCode: -32603,
    acpErrorData: '{"_errors":["model busy"]}',
    timeoutScope: "acp-prompt",
    firstChunkElapsedMs: 18_400,
    promptElapsedMs: 600_002,
    bridgeEnsureElapsedMs: 811,
    partialChars: 9_312,
    updateCount: 27,
    partialTailChars: 4_000,
    sessionResumed: true,
    continueAttempts: 1,
    continueTrigger: "acp-prompt-timeout",
    workspaceTouched: true,
    touchedFileCount: 3,
    elapsedMs: 604_120,
    stage: "wait",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// ① 不发：continueAttempts = 0 / 缺键 / 形状不符
// ---------------------------------------------------------------------------

test("O3 continueAttempts=0（缺键 / 显式 0 / 非数值 / 负数 / 无 diagnostics）⇒ 一条 task.continued 都不发", async () => {
  const machineId = "m-o3b-zero";
  const port = await serve(endpoints(machineId));
  upsertRunner({ runnerId: machineId, machineId, protocolVersion: "1.0.0", state: "online" });

  const cases: Array<[string, Record<string, unknown> | undefined]> = [
    ["o3b-z-none", undefined],
    ["o3b-z-nokey", { acpErrorKind: "timeout", timeoutScope: "acp-prompt", partialChars: 900 }],
    ["o3b-z-zero", continuedDiagnostics({ continueAttempts: 0 })],
    ["o3b-z-bad", continuedDiagnostics({ continueAttempts: "1" })],
    ["o3b-z-neg", continuedDiagnostics({ continueAttempts: -1 })],
  ];
  for (const [taskId, diagnostics] of cases) {
    seed(taskId, "p-o3b-zero", machineId, `ct-${taskId}`);
    const body: Record<string, unknown> = {
      machineId,
      taskId,
      claimToken: `ct-${taskId}`,
      state: "failed",
      text: "任务失败",
    };
    if (diagnostics !== undefined) body["diagnostics"] = diagnostics;
    assert.equal((await post(port, body, `tok-${machineId}`)).status, 200, `${taskId} 应 200 ack`);
  }
  assert.equal(continuedEvents().length, 0, "continueAttempts 不 > 0 ⇒ 不得发 task.continued");
  // 无续跑 ⇒ task.settled.continueAttempts 恒 0（O2 口径不回退）
  for (const [taskId] of cases) {
    const payload = JSON.parse(String(settledEvents(taskId)[0]?.payload)) as Record<string, unknown>;
    assert.equal(payload.continueAttempts, 0, `${taskId}：settled.continueAttempts 应为 0`);
    assert.equal(payload.attempt, 0, `${taskId}：attempt 仍只取 retry_count`);
  }
});

// ---------------------------------------------------------------------------
// ② > 0 ⇒ 恰发一条且 payload 键齐
// ---------------------------------------------------------------------------

test("O3 continueAttempts>0 ⇒ 恰发一条 task.continued，payload 含 §2.2 键清单（逐键显式读）", async () => {
  const machineId = "m-o3b-one";
  const port = await serve(endpoints(machineId));
  upsertRunner({ runnerId: machineId, machineId, protocolVersion: "1.0.0", state: "online" });

  seed("o3b-c-1", "p-o3b-one", machineId, "ct-o3b-c-1");
  const res = await post(
    port,
    {
      machineId,
      taskId: "o3b-c-1",
      claimToken: "ct-o3b-c-1",
      state: "completed",
      text: "续跑后完成",
      diagnostics: continuedDiagnostics(),
    },
    `tok-${machineId}`,
  );
  assert.equal(res.status, 200);

  const events = continuedEvents("o3b-c-1");
  assert.equal(events.length, 1, "一次胜出回传 ⇒ 恰一条 task.continued");
  const ev = events[0];
  assert.equal(ev?.featureId, null, "独立任务无 Feature 归属（组可见性按 task_id 反查）");
  assert.equal(ev?.state, "completed", "事件 state = 结算态");
  const payload = JSON.parse(String(ev?.payload)) as Record<string, unknown>;
  assert.equal(payload.taskId, "o3b-c-1");
  assert.equal(payload.machineId, machineId);
  assert.equal(payload.projectId, "p-o3b-one");
  assert.equal(payload.continueAttempts, 1);
  assert.equal(payload.continueTrigger, "acp-prompt-timeout");
  assert.equal(payload.timeoutScope, "acp-prompt");
  assert.equal(payload.partialChars, 9_312);
  assert.equal(payload.updateCount, 27);
  assert.equal(payload.firstChunkElapsedMs, 18_400);
  assert.equal(payload.sessionResumed, true);
  for (const key of CONTINUED_REQUIRED_KEYS) {
    assert.ok(key in payload, `payload 缺键 ${key}`);
  }
  // 结算事件同批携带续跑口径（正交双字段：attempt=重派、continueAttempts=续跑）
  const settled = JSON.parse(String(settledEvents("o3b-c-1")[0]?.payload)) as Record<string, unknown>;
  assert.equal(settled.continueAttempts, 1, "settled.continueAttempts 自 O3 起取 diagnostics 值");
  assert.equal(settled.attempt, 0, "续跑不得动 retry_count 口径（§2.2 契约 C2）");
  assert.equal(getTask("o3b-c-1")?.retryCount, 0, "落库列 retry_count 亦不因续跑自增");
});

test("O3 重复 / 迟到上报 ⇒ task.continued 不重发、诊断原文不被覆写（首个终态胜出）", async () => {
  const machineId = "m-o3b-dup";
  const port = await serve(endpoints(machineId));
  upsertRunner({ runnerId: machineId, machineId, protocolVersion: "1.0.0", state: "online" });

  seed("o3b-c-dup", "p-o3b-dup", machineId, "ct-o3b-c-dup");
  const first = continuedDiagnostics();
  await post(
    port,
    { machineId, taskId: "o3b-c-dup", claimToken: "ct-o3b-c-dup", state: "completed", diagnostics: first },
    `tok-${machineId}`,
  );
  const kept = getTask("o3b-c-dup")?.diagnosticsJson;
  assert.ok(kept !== null && kept !== undefined);
  assert.deepEqual(JSON.parse(kept) as Record<string, unknown>, first, "首个终态的诊断原文落库");

  // 迟到的不同终态（自报没续跑）⇒ 200 ack、零写入 ⇒ 不改诊断、不再发事件
  const late = await post(
    port,
    {
      machineId,
      taskId: "o3b-c-dup",
      claimToken: "ct-o3b-c-dup",
      state: "failed",
      diagnostics: { continueAttempts: 0, stage: "wait", elapsedMs: 1 },
    },
    `tok-${machineId}`,
  );
  assert.equal(late.status, 200);
  assert.equal(late.data["state"], "completed", "首个终态胜出");
  assert.deepEqual(JSON.parse(String(getTask("o3b-c-dup")?.diagnosticsJson)) as Record<string, unknown>, first);
  assert.equal(continuedEvents("o3b-c-dup").length, 1, "迟到件不得重发 task.continued");
});

test("O3 续跑后转 input-required（非终态）⇒ 仍发 task.continued、不发 task.settled", () => {
  upsertTaskResult({
    machineId: "m-o3b-ir",
    taskId: "o3b-c-ir",
    projectId: "p-o3b-ir",
    contextId: "ctx-o3b-c-ir",
    state: "input-required",
    featureId: null,
    text: "需澄清",
    diagnostics: continuedDiagnostics(),
  });
  assert.equal(continuedEvents("o3b-c-ir").length, 1, "续跑留痕与是否终态无关");
  assert.equal(settledEvents("o3b-c-ir").length, 0, "input-required 不得发 task.settled");
});

// ---------------------------------------------------------------------------
// ③ 宽 JSON 原样读回（不是派生布尔）
// ---------------------------------------------------------------------------

test("O3 宽 JSON 原样读回：getTask().diagnosticsJson 保留数值/布尔/嵌套原文（§2.5 返工红线）", async () => {
  const machineId = "m-o3b-raw";
  const port = await serve(endpoints(machineId));
  upsertRunner({ runnerId: machineId, machineId, protocolVersion: "1.0.0", state: "online" });

  const diag = continuedDiagnostics({ sessionResumed: false, touchedFileCount: 0 });
  seed("o3b-raw-1", "p-o3b-raw", machineId, "ct-o3b-raw-1");
  await post(
    port,
    { machineId, taskId: "o3b-raw-1", claimToken: "ct-o3b-raw-1", state: "failed", failureKind: "timeout", diagnostics: diag },
    `tok-${machineId}`,
  );
  const record = getTask("o3b-raw-1");
  assert.ok(typeof record?.diagnosticsJson === "string", "必须读到原文 JSON 串（不是布尔、不是摘要）");
  const back = JSON.parse(String(record?.diagnosticsJson)) as Record<string, unknown>;
  assert.deepEqual(back, diag, "逐键原样回读（含 acpErrorData 宽 JSON 字符串与 false 值）");
  // 派生布尔会丢掉的原料必须仍在（v0.8.10 排队可见面要用）
  assert.equal(back.bridgeEnsureElapsedMs, 811);
  assert.equal(back.promptElapsedMs, 600_002);
  assert.equal(back.acpErrorCode, -32603);
  assert.equal(back.acpErrorData, '{"_errors":["model busy"]}');
  assert.equal(back.partialTailChars, 4_000);
  assert.equal(back.workspaceTouched, true);
  assert.equal(back.touchedFileCount, 0);
  assert.equal(back.sessionResumed, false, "false 不得被「键省略」口径吞掉");
  // 闭集分类与宽 JSON 两列各写各的（timeout + acp-prompt ⇒ 原样采纳，不落兜底）
  assert.equal(record?.failureKind, "timeout");
});

test("O3 无 diagnostics 上报 ⇒ 列留 NULL（不猜内容），读回为 null", async () => {
  const machineId = "m-o3b-null";
  const port = await serve(endpoints(machineId));
  upsertRunner({ runnerId: machineId, machineId, protocolVersion: "1.0.0", state: "online" });
  seed("o3b-null-1", "p-o3b-null", machineId, "ct-o3b-null-1");
  await post(
    port,
    { machineId, taskId: "o3b-null-1", claimToken: "ct-o3b-null-1", state: "completed", text: "ok" },
    `tok-${machineId}`,
  );
  assert.equal(getTask("o3b-null-1")?.diagnosticsJson, null);
  assert.equal(continuedEvents("o3b-null-1").length, 0);
});

test("O3 重派后再次续跑 ⇒ 两 episode 各留一条（attempt 与 continueAttempts 正交）", () => {
  const task = "o3b-c-retry";
  createTask({ taskId: task, projectId: "p-o3b-retry", contextId: `ctx-${task}`, state: "working" });
  upsertTaskResult({
    machineId: "m-o3b-retry",
    taskId: task,
    projectId: "p-o3b-retry",
    contextId: `ctx-${task}`,
    state: "failed",
    diagnostics: continuedDiagnostics(),
  });
  assert.equal(rearmForRetry(task, `${task}: retry`), true, "宿主重派 ⇒ retry_count +1");
  upsertTaskResult({
    machineId: "m-o3b-retry",
    taskId: task,
    projectId: "p-o3b-retry",
    contextId: `ctx-${task}`,
    state: "failed",
    diagnostics: continuedDiagnostics(),
  });
  const continued = continuedEvents(task);
  assert.equal(continued.length, 2, "两次胜出各一条（不可被上一条静默吞掉）");
  const second = JSON.parse(String(continued[1]?.payload)) as Record<string, unknown>;
  assert.equal(second.continueAttempts, 1);
  const settled = settledEvents(task).map((e) => JSON.parse(String(e.payload)) as Record<string, unknown>);
  assert.deepEqual(
    settled.map((p) => [p.attempt, p.continueAttempts]),
    [
      [0, 1],
      [1, 1],
    ],
    "attempt=重派计数、continueAttempts=续跑计数，两口径不混",
  );
  assert.equal(getTask(task)?.retryCount, 1, "retry_count 只记宿主重派");
});

test("O3 逐键显式读：机侧缺报的键省略（不填 0/false 冒充「没有」）；remainingMs 一旦上报即带出", () => {
  const task = "o3b-c-sparse";
  upsertTaskResult({
    machineId: "m-o3b-sparse",
    taskId: task,
    projectId: "p-o3b-sparse",
    contextId: `ctx-${task}`,
    state: "failed",
    diagnostics: { continueAttempts: 1, timeoutScope: "acp-prompt", remainingMs: 233_880 },
  });
  const payload = JSON.parse(String(continuedEvents(task)[0]?.payload)) as Record<string, unknown>;
  assert.deepEqual(payload, {
    taskId: task,
    machineId: "m-o3b-sparse",
    projectId: "p-o3b-sparse",
    continueAttempts: 1,
    timeoutScope: "acp-prompt",
    remainingMs: 233_880,
  });
  assert.ok(!("sessionResumed" in payload), "缺报 ⇒ 键省略（未知 ≠ false）");
  assert.ok(!("continueTrigger" in payload), "缺报 ⇒ 键省略");
});

// ---------------------------------------------------------------------------
// ④ 事件消费面：a2a_events / a2a_wait / 工作台 /api/events 全量转发
// ---------------------------------------------------------------------------

test("O3 事件消费面无漏改：listEvents / a2a_events（core.events）都能看到 task.continued", async () => {
  const task = "o3b-c-sink";
  upsertTaskResult({
    machineId: "m-o3b-sink",
    taskId: task,
    projectId: "p-o3b-sink",
    contextId: `ctx-${task}`,
    state: "completed",
    featureId: "fe-o3b-sink",
    diagnostics: continuedDiagnostics(),
  });
  assert.ok(
    listEvents().some((e) => e.kind === EVENT_TASK_CONTINUED && e.taskId === task),
    "store 收件箱必须有 task.continued",
  );
  const settled = listEvents().find((e) => e.kind === EVENT_TASK_SETTLED && e.taskId === task);
  assert.ok(settled !== undefined, "同一上报的 task.settled 仍在（未被续跑事件挤掉）");
  assert.equal(settled?.featureId, "fe-o3b-sink", "归属沿用（组可见性经 feature_id 反查）");

  // `a2a_events` 的领域入口（`createCore(null)` = 未配组匿名 ⇒ 全量可见）：新 kind 无需白名单即透传
  const { createCore } = await import("../bridge/index.js");
  const core = createCore(null);
  const view = core.events(0);
  if (view.ok !== true) throw new Error(`a2a_events 读取失败：${view.error}`);
  assert.ok(
    view.events.some((e) => e.kind === EVENT_TASK_CONTINUED && e.taskId === task),
    "a2a_events 必须能读到 task.continued（全量转发）",
  );
  const waited = await core.wait(0);
  if (waited.ok !== true) throw new Error(`a2a_wait 读取失败：${waited.error}`);
  // 游标已被上一次读推走 ⇒ wait 只见增量（本用例断言不抛错、结构一致即可）
  assert.ok(Array.isArray(waited.events));
});
