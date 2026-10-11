import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseFeaturesList,
  parseFeatureDetail,
  parseTrace,
  parseProjects,
  parseRegistryProjects,
  parseTasks,
  createBridgeClient,
  BridgeResponseError,
} from "../dist/bridge-client.js";
// BD12″ 起：原 dist/index.js 的 resolve* 系列（argv/env 配置通道）已撤，配置解析用例移至 test/config.test.mjs

test("parseFeaturesList: 归一列表字段", () => {
  const view = parseFeaturesList({
    ok: true,
    features: [
      { featureId: "F1", state: "executing", title: "甲", taskCount: 3, ownerGroup: "g", createdAt: "c", updatedAt: "u" },
      { featureId: "F2", state: "completed" },
    ],
  });
  assert.equal(view.features.length, 2);
  assert.equal(view.features[0].featureId, "F1");
  assert.equal(view.features[0].taskCount, 3);
  assert.equal(view.features[1].title, "");
  assert.equal(view.features[1].taskCount, null);
  assert.equal(view.features[1].ownerGroup, null);
});

test("parseFeaturesList: requirement 映射（M5）——字符串原样、缺列/非字符串容错 null", () => {
  const view = parseFeaturesList({
    ok: true,
    features: [
      { featureId: "F1", state: "waiting_approval", requirement: "  原文照抄  " },
      { featureId: "F2", state: "waiting_approval", requirement: "" },
      { featureId: "F3", state: "waiting_approval", requirement: 42 },
      { featureId: "F4", state: "waiting_approval" },
    ],
  });
  assert.equal(view.features[0].requirement, "  原文照抄  ", "原样透传（不 trim 不改写）");
  assert.equal(view.features[1].requirement, "");
  assert.equal(view.features[2].requirement, null, "非字符串 ⇒ null 容错");
  assert.equal(view.features[3].requirement, null, "老桥缺列 ⇒ null 容错");
});

test("parseFeaturesList: ok:false 抛 BridgeResponseError 并带 code", () => {
  assert.throws(
    () => parseFeaturesList({ ok: false, code: "boom", error: "炸了" }),
    (err) => err instanceof BridgeResponseError && err.code === "boom",
  );
});

test("parseFeatureDetail: feature + tasks", () => {
  const view = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing", title: "甲", plan: null },
    tasks: [
      { taskId: "t1", projectId: "p", state: "failed", lane: "read", failureKind: "timeout", retryCount: 1, dependencies: ["t0"], prompt: "修复依赖图节点标签" },
      { taskId: "t2", projectId: "p", state: "completed", dependencies: null },
    ],
  });
  assert.equal(view.feature.featureId, "F1");
  assert.equal(view.tasks.length, 2);
  assert.equal(view.tasks[0].lane, "read");
  assert.equal(view.tasks[0].failureKind, "timeout");
  assert.equal(view.tasks[0].prompt, "修复依赖图节点标签", "增补轨 III N1：收 prompt（依赖图任务要点数据源）");
  assert.equal(view.tasks[1].prompt, null, "缺键 ⇒ null（老桥容错）");
  assert.deepEqual(view.tasks[0].dependencies, ["t0"]);
  assert.equal(view.tasks[1].lane, "write");
  assert.equal(view.tasks[1].dependencies, null);
});

test("parseFeatureDetail: 任务行三时刻 + 队列四字段（B-T4 3300 收编补差）", () => {
  const view = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [
      {
        taskId: "t1",
        projectId: "p",
        state: "completed",
        createdAt: "2026-09-26T00:00:00Z",
        startedAt: "2026-09-26T00:01:30Z",
        finishedAt: "2026-09-26T00:06:30Z",
        queueState: "settled",
        queuedAt: "2026-09-26T00:00:00Z",
        claimedAt: "2026-09-26T00:01:00Z",
        claimedBy: "m1",
      },
    ],
  });
  const t = view.tasks[0];
  assert.equal(t.createdAt, "2026-09-26T00:00:00Z");
  assert.equal(t.startedAt, "2026-09-26T00:01:30Z");
  assert.equal(t.finishedAt, "2026-09-26T00:06:30Z");
  assert.equal(t.queueState, "settled");
  assert.equal(t.queuedAt, "2026-09-26T00:00:00Z");
  assert.equal(t.claimedAt, "2026-09-26T00:01:00Z");
  assert.equal(t.claimedBy, "m1");
});

test("parseFeatureDetail: 任务行时刻/队列字段缺键 ⇒ null（老桥容错，不臆造）", () => {
  const view = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [{ taskId: "t1", projectId: "p", state: "completed" }],
  });
  const t = view.tasks[0];
  assert.equal(t.createdAt, null);
  assert.equal(t.startedAt, null);
  assert.equal(t.finishedAt, null);
  assert.equal(t.queueState, null);
  assert.equal(t.queuedAt, null);
  assert.equal(t.claimedAt, null);
  assert.equal(t.claimedBy, null);
});

// --- v0.10.3 N1：taskType（职责位）透传 —— 值域归桥，板不译写 / 不校验 / 不设闭集假设 --------

test("parseFeatureDetail: taskType 带键 ⇒ 原样透出（含桥侧任意取值，板不译写、不当闭集）", () => {
  const view = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [
      { taskId: "t1", projectId: "p", state: "completed", taskType: "dev_manager" },
      { taskId: "t2", projectId: "p", state: "completed", taskType: "product_manager" },
      { taskId: "t3", projectId: "p", state: "completed", taskType: "桥侧新值" },
    ],
  });
  assert.equal(view.tasks[0].taskType, "dev_manager");
  assert.equal(view.tasks[1].taskType, "product_manager");
  assert.equal(view.tasks[2].taskType, "桥侧新值", "未知值原样照抄（不吞、不归一）");
});

test("parseFeatureDetail: taskType 缺键 ⇒ null（老桥容错；不回落 \"\"、不臆造 unit_agent 缺省）", () => {
  const view = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [
      { taskId: "t1", projectId: "p", state: "completed" },
      { taskId: "t2", projectId: "p", state: "completed", taskType: 42 },
      { taskId: "t3", projectId: "p", state: "completed", taskType: null },
    ],
  });
  assert.equal(view.tasks[0].taskType, null, "缺键 ⇒ null（不得是 \"\"、不得是 \"unit_agent\"）");
  assert.equal(view.tasks[1].taskType, null, "非字符串 ⇒ null（口径同 queueState）");
  assert.equal(view.tasks[2].taskType, null);
});

test("parseTrace: 三面字段 waitReason/position/waitedSince/projectBusy/readOccupants", () => {
  const view = parseTrace({
    ok: true,
    featureId: "F1",
    featureState: "executing",
    nodes: [
      {
        taskId: "t1",
        projectId: "p",
        state: "working",
        lane: "write",
        queueState: "running",
        waitReason: "running_remote",
        blockedOn: [],
        projectBusy: { busy: false, taskId: null, machineId: "m1" },
        readOccupants: [],
        position: null,
        waitedSince: "2026-09-24T00:00:00Z",
      },
      {
        taskId: "t2",
        projectId: "p",
        state: "submitted",
        lane: "read",
        queueState: "queued",
        waitReason: "read_lane_running",
        blockedOn: ["t0"],
        projectBusy: { busy: false, taskId: null, machineId: null },
        readOccupants: [{ taskId: "t9", featureId: null, queueState: "running", machineId: "m1", queuedAt: "q" }],
        position: 2,
        waitedSince: "2026-09-24T00:01:00Z",
      },
    ],
  });
  assert.equal(view.featureId, "F1");
  assert.equal(view.nodes.length, 2);
  assert.equal(view.nodes[1].waitReason, "read_lane_running");
  assert.equal(view.nodes[1].position, 2);
  assert.deepEqual(view.nodes[1].blockedOn, ["t0"]);
  assert.equal(view.nodes[1].projectBusy.busy, false);
  assert.equal(view.nodes[1].readOccupants.length, 1);
  assert.equal(view.nodes[1].readOccupants[0].taskId, "t9");
  assert.equal(view.nodes[0].readOccupants.length, 0);
});

test("createBridgeClient.getFeatures: 注入 fetch，GET 且解析", async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), method: init?.method };
    return new Response(JSON.stringify({ ok: true, features: [{ featureId: "F1", state: "executing", title: "甲" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createBridgeClient({ baseUrl: "http://127.0.0.1:3300/", fetchImpl });
  const view = await client.getFeatures();
  assert.equal(client.baseUrl, "http://127.0.0.1:3300");
  assert.equal(captured.url, "http://127.0.0.1:3300/api/features");
  assert.equal(captured.method, "GET");
  assert.equal(view.features[0].featureId, "F1");
});

test("createBridgeClient.getFeatureTrace: 路径带 featureId 且编码", async () => {
  let capturedUrl = "";
  const fetchImpl = async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ ok: true, featureId: "F/1", featureState: "executing", nodes: [] }), { status: 200 });
  };
  const client = createBridgeClient({ baseUrl: "http://127.0.0.1:3300", fetchImpl });
  const view = await client.getFeatureTrace("F/1");
  assert.equal(capturedUrl, "http://127.0.0.1:3300/api/features/F%2F1/trace");
  assert.equal(view.featureId, "F/1");
});

test("createBridgeClient: 非 2xx 抛 BridgeResponseError", async () => {
  const fetchImpl = async () => new Response("nope", { status: 500 });
  const client = createBridgeClient({ baseUrl: "http://127.0.0.1:3300", fetchImpl });
  await assert.rejects(() => client.getFeatures(), (err) => err instanceof BridgeResponseError);
});

// ---------------------------------------------------------------------------
// BD3 增量：登记字段解析 + projects / tasks 只读面
// ---------------------------------------------------------------------------

test("parseFeaturesList: stage/version/approval 解析；缺列容错 null；老桥全体缺 stateCounts ⇒ null", () => {
  const view = parseFeaturesList({
    ok: true,
    features: [
      { featureId: "F1", state: "waiting_approval", stage: "需求分析", version: "v0.9.0", approval: "未发起" },
      { featureId: "F2", state: "executing" },
    ],
  });
  assert.equal(view.features[0].stage, "需求分析");
  assert.equal(view.features[0].version, "v0.9.0");
  assert.equal(view.features[0].approval, "未发起");
  assert.equal(view.features[1].stage, null);
  assert.equal(view.features[1].approval, null);
  assert.equal(view.features[0].stateCounts, null);
  assert.equal(view.stateCounts, null);
});

// --- v0.9.3 B1：parentFeatureId 解析（增补挂主需求 · 读面标注）---

test("parseFeaturesList: parentFeatureId 解析；缺列 / 非字符串容错 null（口径同 stage，老桥无此字段）", () => {
  const view = parseFeaturesList({
    ok: true,
    features: [
      { featureId: "F1", state: "executing", parentFeatureId: "P1" },
      { featureId: "F2", state: "executing" },
      { featureId: "F3", state: "executing", parentFeatureId: 42 },
    ],
  });
  assert.equal(view.features[0].parentFeatureId, "P1");
  assert.equal(view.features[1].parentFeatureId, null);
  assert.equal(view.features[2].parentFeatureId, null);
});

test("parseFeatureDetail: parentFeatureId 透出（桥未给 ⇒ null，不臆造缺省）", () => {
  const withField = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing", parentFeatureId: "P1" },
    tasks: [],
  });
  assert.equal(withField.feature.parentFeatureId, "P1");
  const without = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [],
  });
  assert.equal(without.feature.parentFeatureId, null);
});

// --- BD6：「各态分布」改用 per-feature stateCounts 本地聚合（三条用例）---

test("parseFeaturesList: 各项 stateCounts 累加成全局分布（含全零项 ⇒ 不丢项、不报缺位）", () => {
  const view = parseFeaturesList({
    ok: true,
    features: [
      { featureId: "F1", state: "executing", taskCount: 3, stateCounts: { completed: 2, working: 1 } },
      { featureId: "F2", state: "completed", taskCount: 1, stateCounts: { completed: 1 } },
      { featureId: "F3", state: "waiting_approval", taskCount: 0, stateCounts: {} },
    ],
  });
  assert.deepEqual(view.stateCounts, { completed: 3, working: 1 });
});

test("parseFeaturesList: 字段整体缺失（老桥）⇒ stateCounts = null（降级文案的唯一判据）", () => {
  const view = parseFeaturesList({
    ok: true,
    features: [{ featureId: "F1", state: "executing", taskCount: 2 }],
  });
  assert.equal(view.stateCounts, null);
});

test("parseFeaturesList: 全部项 stateCounts = {} ⇒ 空分布 {}，不得判成缺位（回归锚）", () => {
  const view = parseFeaturesList({
    ok: true,
    features: [
      { featureId: "F1", state: "waiting_approval", taskCount: 0, stateCounts: {} },
      { featureId: "F2", state: "waiting_approval", taskCount: 0, stateCounts: {} },
    ],
  });
  assert.notEqual(view.stateCounts, null);
  assert.deepEqual(view.stateCounts, {});
});

test("parseFeaturesList: 空列表 ⇒ 空分布（无项可聚，不是缺位）；非数字值键忽略", () => {
  assert.deepEqual(parseFeaturesList({ ok: true, features: [] }).stateCounts, {});
  const view = parseFeaturesList({
    ok: true,
    features: [{ featureId: "F1", state: "executing", stateCounts: { completed: 5, bogus: "x" } }],
  });
  assert.deepEqual(view.stateCounts, { completed: 5 });
});

test("parseFeatureDetail: 登记字段透出（桥未给 ⇒ null，不臆造缺省）", () => {
  const withFields = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing", stage: "改造方案", version: "v1", approval: "已通过" },
    tasks: [],
  });
  assert.equal(withFields.feature.stage, "改造方案");
  assert.equal(withFields.feature.approval, "已通过");
  const without = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [],
  });
  assert.equal(without.feature.stage, null);
  assert.equal(without.feature.version, null);
});

// --- v0.9.5 C4：需求原文上详情页 —— 详情出参的 requirement 键（数据面单点） --------------

test("parseFeatureDetail: requirement 透出（v0.9.5 C4）—— 原文照抄、缺列 / 非字符串容错 null", () => {
  const withText = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "waiting_approval", requirement: "  闸判据对取消轨版本失真  " },
    tasks: [],
  });
  assert.equal(withText.feature.requirement, "  闸判据对取消轨版本失真  ", "原样透传（不 trim 不改写 —— 截断与空白判定归显示层）");

  const legacy = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "waiting_approval" },
    tasks: [],
  });
  assert.equal(legacy.feature.requirement, null, "老桥缺列 ⇒ null 容错（口径同列表面）");

  const weird = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "waiting_approval", requirement: 42 },
    tasks: [],
  });
  assert.equal(weird.feature.requirement, null, "非字符串 ⇒ null，不字符串化脏值");
});

// --- REQ-v0.9.2 N8：详情出参**顶层** acceptance 块（老桥缺键 ⇒ null ⇒ 详情页现行为） --------

test("parseFeatureDetail: acceptance 顶层键透传（stages/failures/stateCounts）", () => {
  const view = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [],
    acceptance: {
      stages: [
        { state: "waiting_approval", enteredAt: "e0", leftAt: "e1" },
        { state: "executing", enteredAt: "e1", leftAt: null },
      ],
      failures: [{ eventId: 7, at: "a1", payload: '{"failed":["t1"],"blockedSet":["t2"]}' }],
      stateCounts: { completed: 2, failed: 1, bogus: "x" },
    },
  });
  assert.equal(view.acceptance.stages.length, 2);
  assert.equal(view.acceptance.stages[1].state, "executing");
  assert.equal(view.acceptance.stages[1].leftAt, null, "末段 leftAt=null 是合法语义，不得被吞");
  assert.equal(view.acceptance.failures[0].eventId, 7);
  assert.equal(view.acceptance.failures[0].payload, '{"failed":["t1"],"blockedSet":["t2"]}');
  assert.deepEqual(view.acceptance.stateCounts, { completed: 2, failed: 1 });
});

test("parseFeatureDetail: 老桥 / acceptance 缺键 ⇒ null（现行为不降级报错）", () => {
  const legacy = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [],
  });
  assert.equal(legacy.acceptance, null);
  const notObject = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [],
    acceptance: "x",
  });
  assert.equal(notObject.acceptance, null);
});

test("parseFeatureDetail: acceptance 容错（空对象 / 非数组 / 未知态 / payload 坏 JSON）", () => {
  const empty = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [],
    acceptance: {},
  });
  assert.deepEqual(empty.acceptance, { stages: [], failures: [], stateCounts: {} }, "空对象 = 合法零段，不是缺位");
  const weird = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [],
    acceptance: {
      stages: "no",
      failures: [null, { eventId: "bad" }],
      stateCounts: 7,
    },
  });
  assert.deepEqual(weird.acceptance.stages, []);
  assert.deepEqual(weird.acceptance.failures, [
    { eventId: null, at: null, payload: null },
    { eventId: null, at: null, payload: null },
  ]);
  assert.deepEqual(weird.acceptance.stateCounts, {});
  const retired = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [],
    acceptance: {
      // 值域非封闭：存量库退役态 analyzing / 缺 state 键 ⇒ 原样/空串，不校验不抛
      stages: [{ state: "analyzing", enteredAt: "e0", leftAt: "e1" }, {}],
      // payload 原文字符串（内层键不作契约）；坏 JSON 原样保留
      failures: [{ eventId: 1, at: "a1", payload: "{坏 JSON" }],
    },
  });
  assert.equal(retired.acceptance.stages[0].state, "analyzing");
  assert.deepEqual(retired.acceptance.stages[1], { state: "", enteredAt: null, leftAt: null });
  assert.equal(retired.acceptance.failures[0].payload, "{坏 JSON");
});

test("parseFeatureDetail: projects[] 三态（v0.10.2 N6 归属读面）—— 真样例 3 行 ⇒ 3 条", () => {
  // 一手样例（2026-10-10 实测 GET http://127.0.0.1:3300/api/features/25aa4b44 顶层 projects[]）
  const view = parseFeatureDetail({
    ok: true,
    feature: { featureId: "25aa4b44", state: "executing" },
    tasks: [],
    projects: [
      { projectId: "board", version: "0.10.2" },
      { projectId: "machine", version: "0.10.2" },
      { projectId: "orch", version: "0.10.2" },
    ],
  });
  assert.deepEqual(view.projects, [
    { projectId: "board", version: "0.10.2" },
    { projectId: "machine", version: "0.10.2" },
    { projectId: "orch", version: "0.10.2" },
  ]);
});

test("parseFeatureDetail: projects[] = [] ⇒ 空数组（合法「未归属」，不得吞成 null）", () => {
  const view = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [],
    projects: [],
  });
  assert.deepEqual(view.projects, []);
  assert.notEqual(view.projects, null, "空面 ≠ 缺面");
});

test("parseFeatureDetail: 无 projects 键 / 非数组 ⇒ null（缺面 ≠ 空面；真机不可触，以单测代）", () => {
  const missing = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [],
  });
  assert.equal(missing.projects, null);
  const wrongShape = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [],
    projects: { projectId: "board", version: "0.10.2" },
  });
  assert.equal(wrongShape.projects, null, "非数组 ⇒ null，不抛");
});

test("parseFeatureDetail: projects[] 逐条严格取 camelCase 两键，非法条目整条丢弃（不抛、不认 snake_case）", () => {
  const view = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F1", state: "executing" },
    tasks: [],
    projects: [
      { projectId: "board", version: "0.10.2" },
      { project_id: "machine", version: "0.10.2" },
      { projectId: "orch" },
      { projectId: "flow", version: "" },
      "x",
      null,
    ],
  });
  assert.deepEqual(view.projects, [{ projectId: "board", version: "0.10.2" }]);
});

test("parseProjects: machines/projects/runners 归一 + 缺字段容错", () => {
  const view = parseProjects({
    ok: true,
    source: "桥注册表",
    note: "快照语义",
    observedAt: "o",
    machines: [
      { machineId: "m1", error: null, projects: [{ projectId: "p1", agentKind: "claude", a2aPort: 3017, status: "online", endpoint: null, startedAt: null }] },
      { machineId: "m2", error: "unreachable" },
    ],
    runners: [{ machineId: "m1", online: true, lastHeartbeatAt: null }],
  });
  assert.equal(view.machines[0].projects[0].a2aPort, 3017);
  assert.deepEqual(view.machines[1].projects, []);
  assert.equal(view.machines[1].error, "unreachable");
  assert.equal(view.runners[0].online, true);
});

test("parseTasks: projectId/reachable/notice/tasks 归一", () => {
  const view = parseTasks({
    ok: true,
    projectId: "p",
    reachable: false,
    notice: "项目 p 非在线",
    tasks: [{ taskId: "t1", contextId: "c", state: "working", prompt: "x", text: null, updatedAt: "u", stale: true }],
  });
  assert.equal(view.projectId, "p");
  assert.equal(view.reachable, false);
  assert.equal(view.notice, "项目 p 非在线");
  assert.equal(view.tasks[0].stale, true);
  assert.equal(view.tasks[0].text, null);
});

test("createBridgeClient.getProjects / getTasks: 仅 GET + query 编码", async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push({ url: String(url), method: init?.method });
    const u = String(url);
    const json = u.includes("/api/tasks")
      ? { ok: true, projectId: "p/1", reachable: true, tasks: [] }
      : { ok: true, machines: [], runners: [] };
    return new Response(JSON.stringify(json), { status: 200 });
  };
  const client = createBridgeClient({ baseUrl: "http://127.0.0.1:3300", fetchImpl });
  await client.getProjects();
  const tv = await client.getTasks("p/1", { state: "working", limit: 50 });
  assert.equal(tv.projectId, "p/1");
  assert.equal(urls[0].url, "http://127.0.0.1:3300/api/projects");
  assert.equal(urls[0].method, "GET");
  assert.equal(urls[1].url, "http://127.0.0.1:3300/api/tasks?project=p%2F1&state=working&limit=50");
  assert.equal(urls[1].method, "GET");
});

// ---------------------------------------------------------------------------
// v0.9.8 N2（REQ-2026-10-03-02）：GET /api/registry/projects 独立取数面
// ---------------------------------------------------------------------------

/** 契约形状（C-1…C-6）+ 刻意混入的多余字段（须容忍不消费）。 */
function registryFixture() {
  return {
    ok: true,
    source: "runners",
    observedAt: "2026-10-04T00:00:00Z",
    note: "非实时探测",
    machines: [
      {
        machineId: "m1",
        runnerId: "m1",
        runnerState: "online",
        lastHeartbeatAt: "2026-10-04T00:00:00Z",
        firstRegisteredAt: "2026-09-01T00:00:00Z",
        declared: true,
        inGroup: true,
        projects: [
          {
            projectId: "orch",
            agentKind: "claude",
            a2aPort: 3017,
            status: "online",
            endpoint: "http://127.0.0.1:3017",
            startedAt: "2026-10-01T00:00:00Z",
            lastReportedAt: "2026-10-04T00:00:00Z",
            ownerGroupName: "g1",
          },
          { projectId: "board", lastReportedAt: "2026-10-03T23:00:00Z" },
        ],
      },
      {
        machineId: "m2",
        runnerState: "offline",
        lastHeartbeatAt: "2026-10-02T10:00:00Z",
        firstRegisteredAt: "2026-09-02T00:00:00Z",
        projects: [{ projectId: "flow", lastReportedAt: "2026-10-02T10:00:00Z" }],
      },
      {
        machineId: "m3",
        runnerState: "offline",
        lastHeartbeatAt: null,
        firstRegisteredAt: "2026-09-03T00:00:00Z",
        projects: [],
      },
    ],
    counts: { machines: 3, projects: 3 },
  };
}

test("parseRegistryProjects: 展平行数与 counts.projects 一致（在线 / 离线 / 零项目三态机器都在遍历源内）", () => {
  const view = parseRegistryProjects(registryFixture());
  const flat = view.machines.flatMap((m) => m.projects);
  assert.equal(flat.length, view.counts.projects, "展平行数 == counts.projects（项目池左集不再构造性恒空）");
  assert.equal(view.machines.length, view.counts.machines);
  assert.deepEqual(view.machines.map((m) => m.machineId), ["m1", "m2", "m3"]);
  assert.equal(view.machines[1].runnerState, "offline", "C-1：离线机照常列出");
  assert.equal(view.machines[1].projects.length, 1, "C-1：离线机的项目照常列出");
  assert.equal(view.machines[2].projects.length, 0, "C-1：注册过但零项目 ⇒ 空数组，不是缺位");
  assert.equal(flat[0].lastReportedAt, "2026-10-04T00:00:00Z", "C-4：项目级时间键 = lastReportedAt");
  assert.equal(flat[1].agentKind, null, "缺字段容错 null（不臆造）");
});

test("parseRegistryProjects: 多余字段容忍不消费（runnerId / declared / inGroup / ownerGroupName 一律不带出）", () => {
  const view = parseRegistryProjects(registryFixture());
  assert.deepEqual(Object.keys(view.machines[0]).sort(), ["firstRegisteredAt", "lastHeartbeatAt", "machineId", "projects", "runnerState"]);
  assert.deepEqual(Object.keys(view.machines[0].projects[0]).sort(), [
    "a2aPort",
    "agentKind",
    "endpoint",
    "lastReportedAt",
    "projectId",
    "startedAt",
    "status",
  ]);
  assert.equal("error" in view.machines[1], false, "机级无 error 字段（离线不发 error 文案）");
});

test("parseRegistryProjects: 字符串逐字透出（C-3 不 trim、不大小写折叠）", () => {
  const view = parseRegistryProjects({
    ok: true,
    machines: [{ machineId: "  M1_x ", runnerState: "Offline", projects: [{ projectId: " Proj A " }] }],
  });
  assert.equal(view.machines[0].machineId, "  M1_x ");
  assert.equal(view.machines[0].runnerState, "Offline");
  assert.equal(view.machines[0].projects[0].projectId, " Proj A ");
});

test("parseRegistryProjects: 缺 machines[] / 非数组 ⇒ 抛 response_invalid（fail-closed，绝不返回空池）", () => {
  for (const body of [
    { ok: true },
    { ok: true, counts: { machines: 0, projects: 0 } },
    { ok: true, machines: null },
    { ok: true, machines: "no" },
    { ok: true, machines: {} },
  ]) {
    assert.throws(
      () => parseRegistryProjects(body),
      (err) => err instanceof BridgeResponseError && err.code === "response_invalid",
      `机器/项目面缺失时必须抛，不得归一成空数组：${JSON.stringify(body)}`,
    );
  }
  const empty = parseRegistryProjects({ ok: true, machines: [] });
  assert.deepEqual(empty.machines, [], "在场且为空 = 真实的零注册机，与「缺字段」可区分");
});

test("parseRegistryProjects: ok:false 抛并带桥 code；counts 缺键容错 null（不校验、不抛）", () => {
  assert.throws(
    () => parseRegistryProjects({ ok: false, code: "registry_unavailable", error: "不可用" }),
    (err) => err instanceof BridgeResponseError && err.code === "registry_unavailable",
  );
  const view = parseRegistryProjects({ ok: true, machines: [{ machineId: "m1", projects: [] }] });
  assert.deepEqual(view.counts, { machines: null, projects: null });
  assert.equal(view.source, null);
});

test("createBridgeClient.getRegistryProjects: 仅 GET /api/registry/projects（无查询、无身份参数）", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response(JSON.stringify(registryFixture()), { status: 200 });
  };
  const client = createBridgeClient({ baseUrl: "http://127.0.0.1:3300/", fetchImpl });
  const view = await client.getRegistryProjects();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:3300/api/registry/projects");
  assert.equal(calls[0].method, "GET");
  assert.equal(view.counts.projects, 3);
});

test("createBridgeClient.getRegistryProjects: 桥响应无 machines[] ⇒ reject（不解析成空池）", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ ok: true, counts: { machines: 0, projects: 0 } }), { status: 200 });
  const client = createBridgeClient({ baseUrl: "http://127.0.0.1:3300", fetchImpl });
  await assert.rejects(
    () => client.getRegistryProjects(),
    (err) => err instanceof BridgeResponseError && err.code === "response_invalid",
  );
});

// ---------------------------------------------------------------------------
// v0.10.1 C2（REQ-2026-10-09-01）—— Group 面跨三档不变式（负向钉）
//
// 口径（改造文档 §2 C-7 硬约束 / C-18⑥ / §4 实现级 board）：
// **`projectVersions` 在场 / 缺位都不改 Group `entries`（同序同状态）；`kind` 只由 `versions[]` 决定。**
// 与 B1 的分工：B1 逐档钉 project 档**自身**的三态与形状（`v0101-engine-project-versions-parse`）；
// 本节只钉**Group 面对 project 面不变**（基线 × 五变体的恒等式 + Group 条目键闭集），二者不重叠。
// 本节专用导入（不动上面既有 import 清单 ⇒ 既有期望零改动）。
// ---------------------------------------------------------------------------

import { parseEngineVersions } from "../dist/bridge-client.js";

const C2_CAPTURED_AT = "2026-10-09T00:00:00.000Z";

/** 「不带 `projectVersions` 键」档（= 老引擎信封；`undefined` 值会造出键，须与缺位区分）。 */
const C2_NO_KEY = Symbol("no projectVersions key");

/** Group 面基线行：登记序（非版号序）+ 同名跨 org + 缺 status 键（⇒ null）三种形状都在内。 */
const C2_GROUP_ROWS = [
  { owner_group: "alpha", version: "0.10.1", status: "active" },
  { owner_group: "alpha", version: "0.9.0", status: "released" },
  { owner_group: "beta", version: "0.10.1" },
];

/** project 面 live 行：刻意与 Group 同名（`alpha` / `0.10.1`）并带两级计数，作为染色 / 相加的探针。 */
const C2_PROJECT_LIVE_ROWS = [
  {
    owner_group: "alpha",
    project_id: "board",
    version: "0.10.1",
    status: "released",
    releasable: true,
    open_count: 0,
    completed_count: 7,
    cancelled_count: 3,
    repo_id: "repo-1",
    ref: "abc123",
  },
  { owner_group: "beta", project_id: "orch", version: "9.9.9", status: "open", open_count: 4 },
];

/** project 面五变体（缺位 / 在场无行 / 在场有行 / 形状不合法 / 在场全非法条目）。 */
const C2_PROJECT_VARIANTS = [
  ["缺位（不带 projectVersions 键）", C2_NO_KEY],
  ["空数组（在场无行 = 合法事实）", []],
  ["live 带行（同名版号 + 两级计数）", C2_PROJECT_LIVE_ROWS],
  ["非数组（形状不合法）", { project_id: "board", version: "0.10.1" }],
  ["全非法条目（缺 project_id / 缺 version / 非对象）", [{}, { version: "9.9.9" }, null, "junk"]],
];

/** 把 project 面变体并入信封（`C2_NO_KEY` ⇒ 原样返回，绝不造出该键）。 */
function c2Envelope(body, projectVariant) {
  return projectVariant === C2_NO_KEY ? body : { ...body, projectVersions: projectVariant };
}

/**
 * Group 面的可比快照 = 三档各自的 Group 侧凭据（`kind` / 根因码 / `entries`），**project 档一律剔除**。
 * absent 档不带 entries ⇒ 收 `null`（「读不到」与「读到 ∧ 零条目」在两档上本就不可混）。
 */
function c2GroupFace(json) {
  const outcome = parseEngineVersions(json, C2_CAPTURED_AT);
  if (outcome.kind !== "projection") return { kind: outcome.kind, code: outcome.code, entries: null };
  return { kind: outcome.kind, code: null, entries: outcome.projection.entries };
}

test("C2-① Group 投影档：projectVersions 五形态下 Group 面与基线逐字段恒等（同序同状态，登记序不被改写）", () => {
  const baseline = c2GroupFace({ ok: true, versions: C2_GROUP_ROWS });
  assert.equal(baseline.kind, "projection", "基线本身必须是投影档（否则下面的恒等式空转）");
  assert.deepEqual(
    baseline.entries,
    [
      { org: "alpha", version: "0.10.1", status: "active" },
      { org: "alpha", version: "0.9.0", status: "released" },
      { org: "beta", version: "0.10.1", status: null },
    ],
    "同序（登记序）+ 同状态（含缺 status 键 ⇒ null，不猜 notstart）",
  );
  for (const [label, variant] of C2_PROJECT_VARIANTS) {
    assert.deepEqual(
      c2GroupFace(c2Envelope({ ok: true, versions: C2_GROUP_ROWS }, variant)),
      baseline,
      `${label} ⇒ Group 面（kind / 根因码 / entries）必须与「无 project 面」的基线逐字段相同`,
    );
  }
  // 正对照（防恒等式空转）：本快照对 Group 面自身是敏感的 ⇒ 上面五次的「相等」才说明 project 面确实没牵动它
  assert.notDeepEqual(c2GroupFace({ ok: true, versions: [C2_GROUP_ROWS[0]] }), baseline, "改 versions[] 必须改快照（只留一行 ⇒ 不再相等）");
});

test("C2-② kind 只由 versions[] 决定：Group 三档 × project 面形态 ⇒ 档位与根因码序列恒定", () => {
  const tiers = [
    ["档1 versions[] 是数组", { ok: true, versions: C2_GROUP_ROWS }, ["projection", null]],
    ["档2 ok:true ∧ 无 versions[]（老桥）", { ok: true }, ["absent", "versions_field_missing"]],
    ["档3 ok:false（引擎如实报错）", { ok: false, code: "boom", error: "引擎报错" }, ["absent", "boom"]],
  ];
  for (const [label, body, expected] of tiers) {
    const faces = C2_PROJECT_VARIANTS.map(([, variant]) => {
      const face = c2GroupFace(c2Envelope(body, variant));
      return [face.kind, face.code];
    });
    assert.deepEqual(
      faces.map(() => expected),
      faces,
      `${label}：五形态的 kind + 根因码必须全等于 Group 面自身判出的档位（project 面不得改判）`,
    );
  }
  // 非对象信封（档4）：带 project 面的「伪信封」同样走 absent —— project 面不得把它升成对象档判定
  assert.equal(parseEngineVersions("junk", C2_CAPTURED_AT).kind, "absent");
  assert.deepEqual(c2GroupFace(c2Envelope({ projectVersions: C2_PROJECT_LIVE_ROWS }, C2_NO_KEY)), {
    kind: "absent",
    code: "unknown",
    entries: null,
  }, "信封无 ok:true ∧ 只带 projectVersions ⇒ 仍 absent（project 面在场不解锁投影档）");
});

test("C2-③ Group 条目键集恒三枚（project 维度与两级计数不挂上 Group 行）；capturedAt 原样透传", () => {
  const outcome = parseEngineVersions(c2Envelope({ ok: true, versions: C2_GROUP_ROWS }, C2_PROJECT_LIVE_ROWS), C2_CAPTURED_AT);
  assert.equal(outcome.kind, "projection");
  assert.equal(outcome.projection.capturedAt, C2_CAPTURED_AT, "捕获时刻由入参给，project 面不改写");
  for (const entry of outcome.projection.entries) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["org", "status", "version"],
      "Group 条目不带 projectId / releasable / 任何计数字段（两级计数不得进同一张表 · 解析层侧）",
    );
  }
  assert.equal(
    outcome.projection.entries.some((e) => e.version === "9.9.9"),
    false,
    "project 独有版号不得成为 Group 条目",
  );
  assert.equal(
    outcome.projection.entries.filter((e) => e.status === "released").length,
    1,
    "Group 侧 released 计数只由 Group 行派生（project 行那条 released 不并入 ⇒ 不染色、不计数）",
  );
});

test("C2-④ Group 零版本是合法事实：versions[] 空数组 ∧ project live ⇒ 投影档 + 空 entries（project 行不得替 Group 填条目）", () => {
  const withLive = c2GroupFace(c2Envelope({ ok: true, versions: [] }, C2_PROJECT_LIVE_ROWS));
  assert.deepEqual(withLive, { kind: "projection", code: null, entries: [] }, "Group 空面 ≠ 缺位，也不得被 project 行填满");
  assert.deepEqual(c2GroupFace(c2Envelope({ ok: true, versions: [] }, C2_NO_KEY)), withLive, "与「无 project 面」的零版本档恒等");
});
