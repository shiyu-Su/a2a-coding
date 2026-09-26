import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseFeaturesList,
  parseFeatureDetail,
  parseTrace,
  parseProjects,
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
      { taskId: "t1", projectId: "p", state: "failed", lane: "read", failureKind: "timeout", retryCount: 1, dependencies: ["t0"] },
      { taskId: "t2", projectId: "p", state: "completed", dependencies: null },
    ],
  });
  assert.equal(view.feature.featureId, "F1");
  assert.equal(view.tasks.length, 2);
  assert.equal(view.tasks[0].lane, "read");
  assert.equal(view.tasks[0].failureKind, "timeout");
  assert.deepEqual(view.tasks[0].dependencies, ["t0"]);
  assert.equal(view.tasks[1].lane, "write");
  assert.equal(view.tasks[1].dependencies, null);
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
