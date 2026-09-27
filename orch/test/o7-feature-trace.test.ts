/**
 * v0.8.8 §2.10(c) · 节点 O7：Trace 面只读查询「在等谁 / 排队位次」单元测试。
 * （v0.8.10 O-N3 起同一实现另挂 MCP 只读工具 `a2a_feature_trace`，本文件的判据即两条出口共用）
 *
 * 覆盖（验收判据逐条）：
 * - 同 project「一节点在飞（claimed）+ 另一节点已就绪未派发」⇒ 查询能答出
 *   **在等谁**（占用项目的节点 + 占位机 `claimed_by`）与**排队位次**（`queue_state='queued'
 *   ∧ queued_at <` 我 的 FIFO 计数；O-N3 起与 `claimTask` 实领序**同键**）；
 * - `blockedOn` 与真实依赖一致（未 completed 的直接依赖）；
 * - `projectBusy` 在无在飞节点时为 false（占用者完成后翻 false）；
 * - 项目忙判定走队列态（**不走 `remote_task_id`**——pull 模型下在飞期间恒 NULL）；
 * - 终态节点（completed / failed / blocked）不输出；`input-required` 归 `awaiting_user`；
 * - Feature 不在 `executing` ⇒ 就绪节点给 `feature_not_executing`；
 * - 纯读：查询前后 Feature 态与节点态**零变化**、不落库；
 * - 归属校验复用六出口同一判据（他组拒绝 / 未知 404 语义）；
 * - **O-N3 ①**：位次同键 —— 早登记但晚入队者**不得**插队；
 * - **O-N3 ②**：只读档占位面 `readOccupants[]` + `waitReason='read_lane_running'`
 *   （写忙集 O-N1 起排除 read ⇒ 少了这一格就是「没被挡、却没开工」的假空洞，跨侧不变量 U9）；
 * - **O-N3 ③**：trace 节点出参键集合固化（additive `lane` / `readOccupants`）+ `waitReason` 八值闭集；
 * - **O-N3 ④**：归因五键进 orch 投影白名单（含「未列入不外泄」「缺键不补 0/false」反向断言）；
 * - 网页端点 `GET /api/features/:featureId/trace` 复用同一 helper（200 / 404 / 405）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  claimTask,
  close,
  createFeature,
  createTask,
  enqueueTask,
  getFeature,
  getTask,
  updateTaskState,
} from "../session/store.js";
import {
  handleFeatureTrace,
  projectTaskVisibility,
  type FeatureTraceArgs,
  type FeatureTraceNode,
} from "../bridge/feature-tools.js";
import { createServer } from "../bridge/register-tools.js";
import type { BridgeCore } from "../bridge/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startWebTransport } from "../bridge/transports/web.js";
import type { WebCore, WebTransportHandle } from "../bridge/transports/web.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function trace(featureId: string): FeatureTraceNode[] {
  const outcome = handleFeatureTrace({ featureId });
  if (!outcome.ok) throw new Error(`trace 期望成功：${outcome.code} ${outcome.error}`);
  return outcome.nodes;
}

function nodeOf(nodes: FeatureTraceNode[], taskId: string): FeatureTraceNode {
  const node = nodes.find((n) => n.taskId === taskId);
  assert.ok(node !== undefined, `trace 应含节点 ${taskId}`);
  return node;
}

// ---------------------------------------------------------------------------
// 主场景：同 project 一节点在飞 + 另一节点已就绪未派发
// ---------------------------------------------------------------------------

test("O7 主场景：在飞 + 就绪未派发 ⇒ 答出「在等谁」（占用节点/占位机）与「排队位次」", async () => {
  close();
  createFeature({ featureId: "f-o7", title: "trace", state: "executing" });

  // T5：他 Feature / 他项目的 queued 任务（提供「排队在我前面」的位次原料，入队最早）
  createTask({ taskId: "T5", projectId: "p2", contextId: "c5", state: "working" });
  enqueueTask("T5");
  await sleep(3); // created_at 毫秒级：拉开严格先后

  // T0：已完成的依赖（T2 依赖它 ⇒ T2 拓扑就绪）
  createTask({ taskId: "T0", projectId: "p1", contextId: "c0", state: "completed", featureId: "f-o7" });
  await sleep(3);

  // T1：在飞节点（入队后被 m1 领取 ⇒ queue_state='claimed'，claimed_by=m1）
  createTask({ taskId: "T1", projectId: "p1", contextId: "c1", state: "working", featureId: "f-o7" });
  enqueueTask("T1");
  assert.equal(
    claimTask({ claimedBy: "m1", projectIds: ["p1"] })?.taskId,
    "T1",
    "T1 应被 m1 领取",
  );
  await sleep(3);

  // T2：依赖全 completed（就绪）但同项目被 T1 占用 ⇒ 未派发
  createTask({
    taskId: "T2",
    projectId: "p1",
    contextId: "c2",
    state: "working",
    featureId: "f-o7",
    dependencies: ["T0"],
  });
  // T3：依赖 T1（在飞）⇒ blockedOn = ["T1"]
  createTask({
    taskId: "T3",
    projectId: "p1",
    contextId: "c3",
    state: "working",
    featureId: "f-o7",
    dependencies: ["T1"],
  });
  // T4/T6：终态节点（failed / blocked）⇒ 不进 trace
  createTask({ taskId: "T4", projectId: "p1", contextId: "c4", state: "failed", featureId: "f-o7" });
  createTask({ taskId: "T6", projectId: "p1", contextId: "c6", state: "blocked", featureId: "f-o7" });
  // T7：待澄清
  createTask({ taskId: "T7", projectId: "p3", contextId: "c7", state: "input-required", featureId: "f-o7" });

  const nodes = trace("f-o7");
  assert.deepEqual(
    nodes.map((n) => n.taskId).sort(),
    ["T1", "T2", "T3", "T7"],
    "只输出非终态节点（failed/blocked 不进账）",
  );

  // ---- 在飞节点 T1：running_remote；自己不算「别人占用」 ----
  const t1 = nodeOf(nodes, "T1");
  assert.equal(t1.queueState, "claimed", "队列态取 queue_state（claimed = 在飞）");
  assert.equal(t1.waitReason, "running_remote");
  assert.equal(t1.projectBusy.busy, false, "同项目无其它忙节点 ⇒ 不判被占");
  assert.equal(t1.position, null, "在飞（非 queued）不给位次");
  assert.ok(t1.waitedSince !== null, "等待起点 = 领取时刻");

  // ---- 就绪未派发节点 T2：project_busy + 在等谁 + 排队位次 ----
  const t2 = nodeOf(nodes, "T2");
  assert.equal(t2.queueState, null, "未入队 ⇒ null（不是 settled 误导值）");
  assert.deepEqual(t2.blockedOn, [], "依赖 T0 已 completed ⇒ 无阻塞依赖");
  assert.equal(t2.projectBusy.busy, true, "同项目 T1 在飞 ⇒ 忙");
  assert.equal(t2.projectBusy.taskId, "T1", "在等谁：占用项目的节点");
  assert.equal(t2.projectBusy.machineId, "m1", "占位机 = 占用节点的 claimed_by");
  assert.equal(t2.waitReason, "project_busy");
  assert.equal(t2.position, 2, "位次：T5（唯一在队者、入队更早）排在我前面 ⇒ 第 2（未入队 ⇒ 不设上界）");
  assert.equal(t2.waitedSince, getTask("T2")?.createdAt, "未入队 ⇒ 等待起点 = 登记时刻");

  // ---- T3：blockedOn 与真实依赖一致 ----
  const t3 = nodeOf(nodes, "T3");
  assert.deepEqual(t3.blockedOn, ["T1"], "blockedOn = 未 completed 的直接依赖");
  assert.equal(t3.waitReason, "upstream_dependencies");

  // ---- T7：待澄清 ----
  const t7 = nodeOf(nodes, "T7");
  assert.equal(t7.waitReason, "awaiting_user");
  assert.equal(t7.queueState, null);
  assert.equal(t7.position, null);

  // ---- 纯读：查询前后账面零变化 ----
  assert.equal(getFeature("f-o7")?.state, "executing");
  assert.equal(getTask("T2")?.state, "working");
  assert.equal(getTask("T1")?.state, "working");
  close();
});

test("O7 projectBusy：占用者完成后翻 false（就绪节点转 ready_pending_dispatch）", async () => {
  close();
  createFeature({ featureId: "f-o7b", title: "trace-b", state: "executing" });
  createTask({ taskId: "U1", projectId: "p1", contextId: "u1", state: "working", featureId: "f-o7b" });
  enqueueTask("U1");
  assert.equal(
    claimTask({ claimedBy: "m9", projectIds: ["p1"] })?.taskId,
    "U1",
  );
  await sleep(3);
  createTask({ taskId: "U2", projectId: "p1", contextId: "u2", state: "working", featureId: "f-o7b" });

  const before = nodeOf(trace("f-o7b"), "U2");
  assert.equal(before.projectBusy.busy, true);
  assert.equal(before.projectBusy.taskId, "U1");

  updateTaskState("U1", "completed"); // 占用者落定 ⇒ 同项目不再忙
  const after2 = nodeOf(trace("f-o7b"), "U2");
  assert.equal(after2.projectBusy.busy, false, "无在飞节点 ⇒ projectBusy false");
  assert.equal(after2.projectBusy.taskId, null);
  assert.equal(after2.projectBusy.machineId, null);
  assert.equal(after2.waitReason, "ready_pending_dispatch");
  close();
});

test("O7 Feature 门：不在 executing ⇒ 就绪节点给 feature_not_executing", () => {
  close();
  createFeature({ featureId: "f-o7c", title: "trace-c", state: "waiting_approval" });
  createTask({ taskId: "V1", projectId: "p7", contextId: "v1", state: "working", featureId: "f-o7c" });
  const v1 = nodeOf(trace("f-o7c"), "V1");
  assert.equal(v1.waitReason, "feature_not_executing");
  assert.equal(v1.projectBusy.busy, false);
  close();
});

test("O7 入参面：未知 Feature ⇒ feature_not_found；他组 Feature 按同一归属判据拒绝", () => {
  close();
  assert.deepEqual(
    handleFeatureTrace({ featureId: "f-none" }),
    { ok: false, code: "feature_not_found", error: "未知 Feature f-none" },
  );
  createFeature({ featureId: "f-o7d", title: "trace-d", state: "executing", ownerGroup: "g1" });
  const denied = handleFeatureTrace({ featureId: "f-o7d" }, "g2");
  assert.ok(!denied.ok && denied.code === "feature_not_owned", "他组只读口同样拒绝");
  assert.equal(trace("f-o7d").length, 0, "无身份（web 运维面）⇒ 放行（该 Feature 零节点）");
  close();
});

// ---------------------------------------------------------------------------
// v0.8.10 O-N3 ①：位次与实领序**同键**（`queued_at`，不再拿登记时刻 `created_at` 比较）
// ---------------------------------------------------------------------------

test("O-N3 位次：早登记、晚入队 ⇒ 不插队（旧 created_at 口径此处恰好反序）", async () => {
  close();
  createFeature({ featureId: "f-o7q", title: "trace-q", state: "executing" });
  // Q1 登记最早，但**最后**入队；Q2 登记晚、**先**入队 ⇒ 实领序 Q2 < Q1
  createTask({ taskId: "Q1", projectId: "p9", contextId: "q1", state: "working", featureId: "f-o7q" });
  await sleep(3);
  createTask({ taskId: "Q2", projectId: "p9", contextId: "q2", state: "working", featureId: "f-o7q" });
  await sleep(3);
  enqueueTask("Q2");
  await sleep(3);
  enqueueTask("Q1");

  const nodes = trace("f-o7q");
  const q1 = nodeOf(nodes, "Q1");
  const q2 = nodeOf(nodes, "Q2");
  assert.equal(q1.waitReason, "queued");
  assert.equal(q2.waitReason, "queued");
  assert.equal(q2.position, 1, "先入队者在前 ⇒ 位次 1");
  assert.equal(q1.position, 2, "后入队者紧随其后（旧口径按 created_at 会误报 q1=1 / q2=2）");
  close();
});

// ---------------------------------------------------------------------------
// v0.8.10 O-N3 ②：read-lane 占位档（消「写门没挡、却没开工」的假空洞 = U9）
// ---------------------------------------------------------------------------

test("O-N3 只读档占位：read 在飞 ⇒ 写档就绪节点 projectBusy=false 但报 read_lane_running + 明细", async () => {
  close();
  createFeature({ featureId: "f-o7r", title: "trace-r", state: "executing" });
  // 只读档 R1：入队后被 m3 领取（在飞）
  createTask({
    taskId: "R1",
    projectId: "p11",
    contextId: "r1",
    state: "working",
    featureId: "f-o7r",
    lane: "read",
  });
  enqueueTask("R1");
  assert.equal(claimTask({ claimedBy: "m3", projectIds: ["p11"] })?.taskId, "R1");
  await sleep(3);
  // 写档 W1：无依赖（就绪）、未入队 ⇒ 调度器不派（要等 machine 侧读位腾出）
  createTask({ taskId: "W1", projectId: "p11", contextId: "w1", state: "working", featureId: "f-o7r" });

  const nodes = trace("f-o7r");
  const r1 = nodeOf(nodes, "R1");
  assert.equal(r1.lane, "read", "出参带档位");
  assert.equal(r1.waitReason, "running_remote");
  assert.deepEqual(r1.readOccupants, [], "占位明细排除自己");

  const w1 = nodeOf(nodes, "W1");
  assert.equal(w1.lane, "write", "未带档 ⇒ 归一 write");
  assert.equal(w1.projectBusy.busy, false, "只读档不入写忙集 ⇒ 写门确实没挡");
  assert.equal(w1.readOccupants.length, 1, "但那片占用面必须报出来（不得留假空洞）");
  assert.deepEqual(w1.readOccupants[0]?.taskId, "R1");
  assert.equal(w1.readOccupants[0]?.machineId, "m3", "占位机 = 只读行的 claimed_by");
  assert.equal(w1.readOccupants[0]?.queueState, "claimed");
  assert.equal(w1.readOccupants[0]?.featureId, "f-o7r");
  assert.equal(w1.waitReason, "read_lane_running");

  // 只读档落定 ⇒ 明细清空、回到 ready_pending_dispatch（不留尾巴）
  updateTaskState("R1", "completed");
  const after2 = nodeOf(trace("f-o7r"), "W1");
  assert.deepEqual(after2.readOccupants, [], "只读档落定后不再有占位");
  assert.equal(after2.waitReason, "ready_pending_dispatch");
  close();
});

// ---------------------------------------------------------------------------
// v0.8.10 O-N3 ③：出参形状固化（additive 两键 + waitReason 八值闭集）
// ---------------------------------------------------------------------------

const NODE_KEYS = [
  "taskId",
  "projectId",
  "state",
  "lane",
  "queueState",
  "waitReason",
  "blockedOn",
  "projectBusy",
  "readOccupants",
  "position",
  "waitedSince",
] as const;

/** `FeatureWaitReason` 的闭集清单（多值/改名即红；与 §2.3 排队可见面对齐） */
const WAIT_REASONS = [
  "awaiting_user",
  "running_remote",
  "queued",
  "upstream_dependencies",
  "feature_not_executing",
  "project_busy",
  "read_lane_running",
  "ready_pending_dispatch",
] as const;

test("O-N3 出参形状：trace 节点键集合固化（含 lane / readOccupants）；waitReason 落在八值闭集", async () => {
  close();
  createFeature({ featureId: "f-o7s", title: "trace-s", state: "executing" });
  createTask({
    taskId: "S1",
    projectId: "p12",
    contextId: "s1",
    state: "working",
    featureId: "f-o7s",
    lane: "read",
  });
  createTask({
    taskId: "S2",
    projectId: "p12",
    contextId: "s2",
    state: "working",
    featureId: "f-o7s",
    dependencies: ["S1"],
  });
  createTask({
    taskId: "S3",
    projectId: "p13",
    contextId: "s3",
    state: "input-required",
    featureId: "f-o7s",
  });

  const nodes = trace("f-o7s");
  for (const n of nodes) {
    assert.deepEqual(
      Object.keys(n).sort(),
      [...NODE_KEYS].sort(),
      `trace 节点键集合与固化清单不一致（${n.taskId}）`,
    );
    assert.ok(
      (WAIT_REASONS as readonly string[]).includes(n.waitReason),
      `waitReason 必须落在八值闭集，实际 ${n.waitReason}`,
    );
    assert.ok(n.lane === "read" || n.lane === "write", `lane 闭集，实际 ${n.lane}`);
    assert.ok(Array.isArray(n.readOccupants), "readOccupants 恒为数组（无占位 = 空数组，不是 null）");
  }
  assert.equal(nodeOf(nodes, "S1").waitReason, "ready_pending_dispatch", "只读档就绪、无同项目 read 占位");
  assert.equal(nodeOf(nodes, "S2").waitReason, "upstream_dependencies");
  assert.equal(nodeOf(nodes, "S3").waitReason, "awaiting_user");
  close();
});

// ---------------------------------------------------------------------------
// v0.8.10 O-N3 ④：归因五键进 orch 白名单（漏列 = DB 有、MCP 面无 ⇒ 最难查的一类落差）
// ---------------------------------------------------------------------------

const VIEW_BASE = {
  dispatchMessage: "正文",
  dispatchRendered: null,
  retryCount: 0,
} as const;

function diagOf(diagnostics: Record<string, unknown>) {
  return projectTaskVisibility({ ...VIEW_BASE, diagnosticsJson: JSON.stringify(diagnostics) })
    .diagnostics;
}

test("O-N3 归因五键：machine 报了就必须从 MCP 面透出；白名单外键不外泄；缺键不补 0/false", () => {
  const full = diagOf({
    turn: 2,
    stopCause: "idle-reap",
    stopCauseTaskId: "t-ghost",
    ghostRoundCancelled: true,
    cancelQuiesceMs: 1_240,
    cancelUnsupported: false,
    // 白名单外（machine 侧自有键 / 未来新键）⇒ 必须被投影滤掉
    stopCauseDetail: "不该外泄",
    cancelQuiesceBytes: 4_096,
  });
  assert.equal(full.stopCause, "idle-reap");
  assert.equal(full.stopCauseTaskId, "t-ghost", "肇事任务 id（口径 U8），不是被停者清单");
  assert.equal(full.ghostRoundCancelled, true);
  assert.equal(full.cancelQuiesceMs, 1_240);
  assert.equal(full.cancelUnsupported, false, "显式 false 必须原样透出（区别于下面的缺键省略）");
  assert.equal("stopCauseDetail" in full, false, "白名单外 string 键不外泄");
  assert.equal("cancelQuiesceBytes" in full, false, "白名单外 number 键不外泄");

  // 未走取消路径的机：**一个键都不报** ⇒ 五键全部省略（不得补 0 / false，「没报」≠「报了 0」）
  const empty = diagOf({ turn: 1 });
  for (const key of [
    "stopCause",
    "stopCauseTaskId",
    "ghostRoundCancelled",
    "cancelQuiesceMs",
    "cancelUnsupported",
  ] as const) {
    assert.equal(key in empty, false, `machine 未报 ⇒ ${key} 省略（不补零值）`);
  }
  assert.equal(empty.turn, 1, "既有键不受影响");

  // 脏值（类型不符）按既有口径丢弃，不得污染归因
  const dirty = diagOf({ cancelQuiesceMs: "1200", stopCause: 7 });
  assert.equal("cancelQuiesceMs" in dirty, false, "number 键收到字符串 ⇒ 省略");
  assert.equal("stopCause" in dirty, false, "string 键收到数字 ⇒ 省略");
});

// ---------------------------------------------------------------------------
// v0.8.10 O-N3 ②'：MCP 出口（Feature 工具组 5→6；**不**新增第 8 个泛型工具）
// ---------------------------------------------------------------------------

/** 只喂 `featureTrace` 的 BridgeCore 桩（其余方法一被调用即红：trace 必须是纯读、不牵动别的出口） */
function traceOnlyCore(): BridgeCore {
  return new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "featureTrace"
          ? (args: FeatureTraceArgs) => handleFeatureTrace(args)
          : () => {
              throw new Error(`trace 出口不得触碰其它 BridgeCore 方法：${String(prop)}`);
            },
    },
  ) as unknown as BridgeCore;
}

test("O-N3 MCP 面：a2a_feature_trace 已注册（工具组 6 / 泛型仍 7）；callTool 返回同一 trace 投影", async () => {
  close();
  createFeature({ featureId: "f-o7m", title: "trace-m", state: "executing" });
  createTask({
    taskId: "M1",
    projectId: "p14",
    contextId: "m1",
    state: "working",
    featureId: "f-o7m",
    lane: "read",
  });

  const server = createServer(traceOnlyCore());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "o7-trace-test", version: "1.0.0" }, {});
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.ok(listed.includes("a2a_feature_trace"), "Feature 工具组必须含只读 trace 出口");
  assert.equal(
    listed.filter((n) => n === "a2a_trace").length,
    0,
    "不得以第 8 个泛型工具形态出现（网页/泛型面不另开编排入口）",
  );
  assert.equal(listed.length, 13, "泛型 7 + Feature 6");

  const res = await client.callTool({ name: "a2a_feature_trace", arguments: { featureId: "f-o7m" } });
  assert.notEqual(res.isError, true, "只读出口应成功");
  const payload = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
    ok: boolean;
    featureState: string;
    nodes: FeatureTraceNode[];
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.featureState, "executing");
  assert.equal(nodeOf(payload.nodes, "M1").lane, "read", "MCP 出口同样带档位");

  const missing = await client.callTool({ name: "a2a_feature_trace", arguments: { featureId: "f-nope" } });
  assert.equal(missing.isError, true, "未知 Feature ⇒ 工具面报错（同一 feature_not_found 语义）");
  await client.close();
  await server.close();
  close();
});

// ---------------------------------------------------------------------------
// 网页端点：GET /api/features/:featureId/trace（复用同一 helper）
// ---------------------------------------------------------------------------

interface TraceJson {
  ok: boolean;
  code?: string;
  featureState?: string;
  nodes?: FeatureTraceNode[];
}

const openHandles: WebTransportHandle[] = [];
after(async () => {
  for (const handle of openHandles) await handle.close();
});

async function startTraceWeb(): Promise<number> {
  const core: WebCore = {
    projects: async () => ({ machines: [], runners: [], group: { name: null, selective: false, memberMachines: [] } }),
    tasks: async (projectId: string) => ({ ok: true, projectId, reachable: true, tasks: [] }),
    featureStatus: () => ({ ok: true, features: [] }),
  };
  const outcome = await startWebTransport({
    core,
    host: "127.0.0.1",
    port: 0,
    version: "0.8.8-test",
  });
  assert.equal(outcome.enabled, true, "网页接面应启用");
  if (!outcome.enabled) throw new Error("未启用");
  openHandles.push(outcome);
  return outcome.port;
}

test("O7 网页端点：/api/features/:id/trace 返回同一投影；未知 404；非 GET 405", async () => {
  close();
  createFeature({ featureId: "f-o7w", title: "trace-w", state: "executing" });
  createTask({ taskId: "W1", projectId: "p8", contextId: "w1", state: "working", featureId: "f-o7w" });
  const port = await startTraceWeb();

  const ok = await fetch(`http://127.0.0.1:${port}/api/features/f-o7w/trace`);
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as TraceJson;
  assert.equal(body.ok, true);
  assert.equal(body.featureState, "executing");
  assert.equal(nodeOf(body.nodes ?? [], "W1").waitReason, "ready_pending_dispatch");

  const missing = await fetch(`http://127.0.0.1:${port}/api/features/f-none/trace`);
  assert.equal(missing.status, 404);
  const wrongMethod = await fetch(`http://127.0.0.1:${port}/api/features/f-o7w/trace`, { method: "POST" });
  assert.equal(wrongMethod.status, 405);
  // 路径纪律：只认这一条二级子路径，其余仍 404
  const deeper = await fetch(`http://127.0.0.1:${port}/api/features/f-o7w/trace/x`);
  assert.equal(deeper.status, 404);
  close();
});
