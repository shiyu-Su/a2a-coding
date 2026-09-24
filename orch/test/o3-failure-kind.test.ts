/**
 * v0.8.7 O3 单测（`node:test`，无新依赖）：失败分类写口 + `started_at` 接首次领取。
 *
 * 覆盖（改造文档 §2.3 / §2.4 / §4 L1；**取值口径随 v0.8.8 O1 升为六类闭集**）：
 * - **兜底映射纯函数**：machine 原生 `AcpError.kind` → 六类安全值；`spawn`/`closed` ⇒ `agent`，
 *   `timeout`/`rpc`/`protocol`/未知/缺失/形状不符 ⇒ **安全降级 `business`**（**唯一触发条件 =
 *   machine 未上报合格六类值** ⇒ 不是并行分类器，§3.3 登记的唯一冗余）。
 * - **`setTaskFailureKind` 的 `AND state='failed'` 门**：非 `failed` 行（在飞 / `completed`）与
 *   缺行 ⇒ **零写入**；`failed` 行 ⇒ 写入可回读、不改状态、不刷 `updated_at`。
 * - **`/runner/result` 写口**：回传 `failed` + `diagnostics.acpErrorKind` ⇒ 落列；不带 diagnostics
 *   ⇒ `business`；`completed` ⇒ 不写；**迟到 / 重复回传不得改写**既有分类。
 * - **`claimTask` 的 `started_at` COALESCE**：登记**不填**（v0.8.7 O3 摘除 `working` 预填）⇒
 *   首次领取才填；**重入领取 / requeue 后再领取 / 条件重试均不重置**起点。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  claimTask,
  close as closeStore,
  compareAndSwapTaskState,
  createTask,
  enqueueTask,
  getQueuedTask,
  getTask,
  rearmForRetry,
  requeueStaleTask,
  setTaskFailureKind,
  upsertRunner,
} from "../session/store.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import {
  RUNNER_RESULT_PATH,
  createRunnerEndpoints,
  mapAcpErrorKindToFailureKind,
  readReportedAcpErrorKind,
  type RunnerEndpointOptions,
} from "../bridge/runner.js";
import type { BridgeCore } from "../bridge/index.js";
import type { MachineRef, MachinesConfig } from "../types.js";

// ---------------------------------------------------------------------------
// 脚手架
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

/** 固定判决时钟（同 O2 先例：注入 `now`，领取时刻相对它回推） */
const NOW = Date.parse("2026-09-22T02:00:00.000Z");

function isoAt(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function makeConfig(machines: MachineRef[]): MachinesConfig {
  return {
    machines,
    transport: { mode: "http", http: { host: "127.0.0.1", port: 0, path: "/mcp" } },
    web: { enabled: false, host: "127.0.0.1", port: 0 },
    runner: { holdMs: 50, heartbeatTimeoutMs: 3_600_000, orphanTimeoutMs: 1_800_000 },
  };
}

function machine(machineId: string, token?: string): MachineRef {
  return token === undefined
    ? { machineId, launcherUrl: "" }
    : { machineId, launcherUrl: "", token };
}

function endpoints(overrides: Partial<RunnerEndpointOptions> = {}) {
  return createRunnerEndpoints({
    role: () => "owner",
    config: () => makeConfig([machine("m-any")]),
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

/** 入队 + 领取（`projectIds` 限定本项目：同进程共享 `:memory:` 库） */
function claim(taskId: string, projectId: string, machineId: string, claimToken: string, claimedAt: string) {
  const claimed = claimTask({ claimedBy: machineId, claimToken, claimedAt, projectIds: [projectId] });
  assert.equal(claimed?.taskId, taskId, `任务 ${taskId} 应被领取`);
  return claimed;
}

async function post(
  port: number,
  body: unknown,
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

// ---------------------------------------------------------------------------
// ① 映射纯函数（含形状宽容）
// ---------------------------------------------------------------------------

test("O3 兜底映射纯函数：spawn/closed ⇒ agent；timeout/rpc/protocol/未知/缺失 ⇒ 安全降级 business", () => {
  // 载体类 = 原生 AcpError.kind 的确定性子集（进程起不来 / 中途死）⇒ 六类的 `agent`
  assert.equal(mapAcpErrorKindToFailureKind("spawn"), "agent");
  assert.equal(mapAcpErrorKindToFailureKind("closed"), "agent");
  // timeout 语义歧义（排队 vs 任务本身太长，分辨需计量键）⇒ 不升格为可续跑类，保守落 business
  assert.equal(mapAcpErrorKindToFailureKind("timeout"), "business");
  assert.equal(mapAcpErrorKindToFailureKind("rpc"), "business");
  assert.equal(mapAcpErrorKindToFailureKind("protocol"), "business");
  // 未知 / 缺失 / 形状不符 ⇒ 安全降级 business（不抛、不落可续跑类）
  for (const v of ["whatever", "", "SPAWN", undefined, null, 42, { kind: "spawn" }]) {
    assert.equal(mapAcpErrorKindToFailureKind(v), "business", `输入 ${String(v)} 应降级为 business`);
  }
});

test("O3 diagnostics 取值：只读 `acpErrorKind`；非对象 / 缺键 / 非字符串 ⇒ undefined", () => {
  assert.equal(readReportedAcpErrorKind({ acpErrorKind: "closed", elapsedMs: 12 }), "closed");
  assert.equal(readReportedAcpErrorKind({ elapsedMs: 12 }), undefined);
  for (const v of [undefined, null, "closed", 42, []]) {
    assert.equal(readReportedAcpErrorKind(v), undefined);
  }
  assert.equal(
    mapAcpErrorKindToFailureKind(readReportedAcpErrorKind({ acpErrorKind: "spawn" })),
    "agent",
  );
});

// ---------------------------------------------------------------------------
// ② setTaskFailureKind 的 `AND state='failed'` 门
// ---------------------------------------------------------------------------

test("O3 setTaskFailureKind：仅 failed 行写入；在飞 / completed / 缺行 ⇒ 零写入", () => {
  // a) 在飞（working）⇒ false 且列不动
  createTask({ taskId: "o3-g-working", projectId: "p-o3-g", contextId: "c1", state: "working" });
  assert.equal(setTaskFailureKind("o3-g-working", "agent"), false);
  assert.equal(getTask("o3-g-working")?.failureKind, null, "在飞行不得被写分类");

  // b) completed ⇒ false（分类只属失败）
  createTask({ taskId: "o3-g-done", projectId: "p-o3-g", contextId: "c2", state: "completed" });
  assert.equal(setTaskFailureKind("o3-g-done", "agent"), false);
  assert.equal(getTask("o3-g-done")?.failureKind, null);

  // c) 行不存在 ⇒ false，且不得建行
  assert.equal(setTaskFailureKind("o3-g-missing", "business"), false);
  assert.equal(getTask("o3-g-missing"), null);

  // d) failed ⇒ 写入可回读；只写该列（state 不变、updated_at 不刷）
  createTask({ taskId: "o3-g-fail", projectId: "p-o3-g", contextId: "c3", state: "failed" });
  const before = getTask("o3-g-fail");
  assert.equal(setTaskFailureKind("o3-g-fail", "agent"), true);
  const after = getTask("o3-g-fail");
  assert.equal(after?.failureKind, "agent");
  assert.equal(after?.state, "failed", "只写分类列，不改状态");
  assert.equal(after?.updatedAt, before?.updatedAt, "分类是附属标注 ⇒ 不刷 updated_at");
  // 改写允许（同列覆盖：重派后再次失败可再分类）
  assert.equal(setTaskFailureKind("o3-g-fail", "business"), true);
  assert.equal(getTask("o3-g-fail")?.failureKind, "business");
});

// ---------------------------------------------------------------------------
// ③ /runner/result 写口
// ---------------------------------------------------------------------------

test("O3 回传 failed ⇒ 落 failure_kind（原生 kind 走兜底映射；缺 diagnostics ⇒ business；completed ⇒ 不写）", async () => {
  const cfg = makeConfig([machine("m-o3-r", "tok-o3-r")]);
  const port = await serve(endpoints({ config: () => cfg }));
  upsertRunner({
    runnerId: "m-o3-r",
    machineId: "m-o3-r",
    protocolVersion: "1.0.0",
    state: "online",
  });

  const seed = (taskId: string, claimToken: string): void => {
    createTask({
      taskId,
      projectId: "p-o3-r",
      contextId: `ctx-${taskId}`,
      state: "working",
      dispatchMessage: `${taskId}: run`,
      prompt: taskId,
    });
    assert.notEqual(enqueueTask(taskId), null);
    claim(taskId, "p-o3-r", "m-o3-r", claimToken, isoAt(0));
  };

  seed("o3-r-closed", "ct-r-1");
  assert.equal(
    (
      await post(
        port,
        {
          machineId: "m-o3-r",
          taskId: "o3-r-closed",
          claimToken: "ct-r-1",
          state: "failed",
          text: "ACP 后端进程退出（code=1）",
          diagnostics: { acpErrorKind: "closed", elapsedMs: 1234, stage: "wait" },
        },
        "tok-o3-r",
      )
    ).status,
    200,
  );
  assert.equal(getTask("o3-r-closed")?.failureKind, "agent", "缺键 + closed ⇒ 兜底映射 agent");

  seed("o3-r-none", "ct-r-2");
  await post(
    port,
    { machineId: "m-o3-r", taskId: "o3-r-none", claimToken: "ct-r-2", state: "failed", text: "任务自身失败" },
    "tok-o3-r",
  );
  assert.equal(getTask("o3-r-none")?.failureKind, "business", "无 diagnostics ⇒ 兜底降级 business");

  seed("o3-r-ok", "ct-r-3");
  await post(
    port,
    { machineId: "m-o3-r", taskId: "o3-r-ok", claimToken: "ct-r-3", state: "completed", text: "done" },
    "tok-o3-r",
  );
  assert.equal(getTask("o3-r-ok")?.failureKind, null, "completed ⇒ 不写分类");
});

test("O3 迟到 / 重复回传不得改写分类（墙钟已置 runner ⇒ 迟到件 200 但分类不变）", async () => {
  const cfg = makeConfig([machine("m-o3-l", "tok-o3-l")]);
  const handle = endpoints({ config: () => cfg });
  const port = await serve(handle);
  upsertRunner({
    runnerId: "m-o3-l",
    machineId: "m-o3-l",
    protocolVersion: "1.0.0",
    state: "online",
  });

  // 墙钟判死（O2）⇒ failed + failure_kind='runner'（v0.8.8 O1 的「不可续跑」子类），且不清 claim 三字段
  createTask({
    taskId: "o3-l-late",
    projectId: "p-o3-l",
    contextId: "ctx-o3-l-late",
    state: "working",
    dispatchMessage: "o3-l-late: run",
    prompt: "o3-l-late",
  });
  assert.notEqual(enqueueTask("o3-l-late"), null);
  claim("o3-l-late", "p-o3-l", "m-o3-l", "ct-l-1", isoAt(-1_800_001));
  assert.deepEqual(handle.sweepOrphanedTasks().orphanedTasks, ["o3-l-late"]);
  assert.equal(getTask("o3-l-late")?.failureKind, "runner");

  // 迟到件（自判 rpc）⇒ 200 ack（契约 3），但不得把 runner 改成 business
  const late = await post(
    port,
    {
      machineId: "m-o3-l",
      taskId: "o3-l-late",
      claimToken: "ct-l-1",
      state: "failed",
      text: "迟到终态",
      diagnostics: { acpErrorKind: "rpc" },
    },
    "tok-o3-l",
  );
  assert.equal(late.status, 200);
  assert.equal(late.data["state"], "failed");
  assert.equal(
    getTask("o3-l-late")?.failureKind,
    "runner",
    "首个终态胜出 ⇒ 分类不可被迟到件改写",
  );

  // 重复回传（spawn）同样零改写
  await post(
    port,
    {
      machineId: "m-o3-l",
      taskId: "o3-l-late",
      claimToken: "ct-l-1",
      state: "failed",
      text: "重复终态",
      diagnostics: { acpErrorKind: "spawn" },
    },
    "tok-o3-l",
  );
  assert.equal(getTask("o3-l-late")?.failureKind, "runner");
});

// ---------------------------------------------------------------------------
// ④ started_at 接首次领取
// ---------------------------------------------------------------------------

test("O3 claimTask 填 started_at；重入领取 / requeue 后再领取 / 条件重试**均不重置**起点", () => {
  // 生产真实形态：Feature 节点登记即 `state="working"` ⇒ 领取前该列必须为 NULL
  //（v0.8.7 O3 摘除 `createTask` 的 working 预填 ⇒ `claimTask` 是唯一「首次开工」写口）
  createTask({
    taskId: "o3-s-1",
    projectId: "p-o3-s",
    contextId: "ctx-o3-s-1",
    state: "working",
    dispatchMessage: "o3-s-1: run",
    prompt: "o3-s-1",
  });
  assert.equal(getTask("o3-s-1")?.startedAt, null, "登记一律不填开工时刻（working 也一样）");
  assert.notEqual(enqueueTask("o3-s-1"), null);
  assert.equal(getTask("o3-s-1")?.startedAt, null, "入队不算开工");

  claim("o3-s-1", "p-o3-s", "m-o3-s", "ct-s-1", isoAt(-60_000));
  assert.equal(getTask("o3-s-1")?.startedAt, isoAt(-60_000), "首次领取 ⇒ 开工时刻 = 领取时刻");

  // a) 心跳 requeue → 再领取（更晚的 claimedAt）⇒ started_at 保持首次
  //（`requeueStaleTask` 已把行放回 `queued`，无需再入队）
  assert.equal(requeueStaleTask("o3-s-1", "m-o3-s"), true);
  claim("o3-s-1", "p-o3-s", "m-o3-s", "ct-s-2", isoAt(60_000));
  assert.equal(getTask("o3-s-1")?.startedAt, isoAt(-60_000), "再领取不得重置起点");
  assert.equal(getQueuedTask("o3-s-1")?.claimedAt, isoAt(60_000), "claimed_at 仍是「最后一次领取」");

  // b) failed → rearmForRetry → 再领取 ⇒ 同样不重置
  assert.equal(
    compareAndSwapTaskState("o3-s-1", "working", "failed"),
    true,
    "置 failed 以便条件重试",
  );
  assert.equal(rearmForRetry("o3-s-1", "o3-s-1: retry"), true);
  assert.notEqual(enqueueTask("o3-s-1"), null);
  claim("o3-s-1", "p-o3-s", "m-o3-s", "ct-s-3", isoAt(120_000));
  assert.equal(getTask("o3-s-1")?.startedAt, isoAt(-60_000), "条件重试不得重置起点");
});

test("O3 开工时刻与登记时刻脱钩：CAS 转入 working 不填、upsert 重登记不重置、以领取时刻为准", () => {
  // ① 非 working 登记 → CAS 到 working：两个动作都不写 `started_at`
  //（CAS 只写 state / updated_at ⇒ `started_at` 唯一生产写口是 `claimTask`）
  createTask({
    taskId: "o3-s-2",
    projectId: "p-o3-s2",
    contextId: "ctx-o3-s-2",
    state: "blocked",
    dispatchMessage: "o3-s-2: run",
    prompt: "o3-s-2",
  });
  assert.equal(compareAndSwapTaskState("o3-s-2", "blocked", "working"), true);
  assert.equal(getTask("o3-s-2")?.startedAt, null, "CAS 转入 working 不填开工时刻");

  // ② 领取 ⇒ 开工时刻 = **领取时刻**（不再是登记时刻；排队段不再被算进耗时）
  assert.notEqual(enqueueTask("o3-s-2"), null);
  claim("o3-s-2", "p-o3-s2", "m-o3-s", "ct-s-4", isoAt(90_000));
  assert.equal(getTask("o3-s-2")?.startedAt, isoAt(90_000), "开工时刻 = 首次领取时刻");

  // ③ 派发侧同 id 重新 `createTask`（刷新 `dispatch_message`，= `dispatchFeatureNode` 注入路径）
  //    ⇒ 已填的开工时刻不被覆盖
  createTask({
    taskId: "o3-s-2",
    projectId: "p-o3-s2",
    contextId: "ctx-o3-s-2",
    state: "working",
    dispatchMessage: "o3-s-2: re-dispatch",
    prompt: "o3-s-2",
  });
  assert.equal(getTask("o3-s-2")?.startedAt, isoAt(90_000), "upsert 重登记不得重置开工起点");
});
