/**
 * REQ-2026-09-26-02 B-T3 · Agent View（只读，GET /agents）—— 门禁测试（fixture 驱动）：
 * ① 机器表归并纯函数（buildMachineRows：runners ∪ machines、缺源不臆造、machineId 字典序）；
 * ② 在飞区纯函数（isInflightTaskState 终态闭集反面 / sortByClaimedAt null 沉底 /
 *    buildInflightModel 缺项按失败收口、灰化数与在飞数分列）；
 * ③ 逐项目任务查询器 + 桥身份查询器（成功 / 失败 / 抛错 / 超时收口；normalizeBridgeIdentity 逐键容错）；
 * ④ HTTP 面（路由 200 + 导航高亮 + 页头身份行 + 机器表 + 在飞小节与排序 + 灰化不炸页 +
 *    查询器 null 降级 + 方法门 405 + 桥宕 502 随发起页高亮）；
 * ⑤ 写面纪律：agent-view.ts 源文件不含状态推进工具名 / 写封装（板不写状态机）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AGENT_QUERY_TIMEOUT_MS,
  TERMINAL_TASK_STATES,
  buildInflightModel,
  buildMachineRows,
  createAgentTasksFetcher,
  createBridgeIdentityFetcher,
  isInflightTaskState,
  normalizeBridgeIdentity,
  sortByClaimedAt,
} from "../dist/agent-view.js";
import { createBoardServer } from "../dist/server.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function project(projectId, agentKind = "claude") {
  return { projectId, agentKind, a2aPort: null, status: "online", endpoint: null, startedAt: null };
}

function machine(machineId, projects, error = null) {
  return { machineId, error, projects };
}

function runner(machineId, online, lastHeartbeatAt) {
  return { machineId, online, lastHeartbeatAt };
}

function projectsView(machines, runners, observedAt = "2026-09-27T01:00:00Z") {
  return { source: "fake", note: null, observedAt, machines, runners };
}

function task(taskId, state, claimedAt = null, overrides = {}) {
  return {
    taskId,
    contextId: "ctx-" + taskId,
    state,
    prompt: "做点什么",
    text: null,
    updatedAt: "2026-09-27T02:00:00Z",
    stale: false,
    claimedAt,
    ...overrides,
  };
}

function tasksView(projectId, tasks) {
  return { projectId, reachable: true, notice: null, tasks };
}

/** 只读桥假客户端：`getProjects` 恒给快照，`getTasks` 可选（缺 ⇒ 该客户端不支持任务面）。 */
function fakeClient(view, getTasks) {
  return {
    baseUrl: "http://fake",
    async getProjects() {
      return view;
    },
    ...(getTasks === undefined ? {} : { getTasks }),
  };
}

async function withServer(options, run) {
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, ...options });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

async function getHtml(base, path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, text: await res.text() };
}

const IDENTITY_OK = {
  ok: true,
  identity: {
    status: "ok",
    role: "owner",
    pid: 4128,
    startedAt: "2026-09-27T00:00:00Z",
    version: "0.9.2",
  },
};

/** 一页的常规输入（HTTP 用例只覆盖差异项，身份默认「可取」以免测试间互相污染）。 */
function twoMachineView() {
  return projectsView(
    [machine("m1", [project("p1"), project("p2")]), machine("m2", [project("p3")])],
    [runner("m1", true, "2026-09-27T02:59:00Z"), runner("m2", false, "2026-09-26T20:00:00Z")],
  );
}

// ---------------------------------------------------------------------------
// ① 机器表归并
// ---------------------------------------------------------------------------

test("T3-① buildMachineRows: runners ∪ machines 按 machineId 归并、字典序、两侧字段互补", () => {
  const rows = buildMachineRows(twoMachineView());
  assert.deepEqual(
    rows.map((r) => r.machineId),
    ["m1", "m2"],
  );
  assert.deepEqual(rows[0], {
    machineId: "m1",
    online: true,
    lastHeartbeatAt: "2026-09-27T02:59:00Z",
    projectCount: 2,
    machineError: null,
  });
  assert.equal(rows[1].online, false, "runner 上报离线 ⇒ 如实「离线」（不是未知）");
  assert.equal(rows[1].projectCount, 1);
});

test("T3-② buildMachineRows: 只在一源出现 ⇒ 另一源字段如实缺席（online=null ≠ 离线 / 无条目 ⇒ 0，不臆造）", () => {
  const rows = buildMachineRows(
    projectsView([machine("m1", [project("p1")], "机器不可达（假）")], [runner("m9", true, "hb-9")]),
  );
  const [m1, m9] = rows;
  assert.equal(m1.machineError, "机器不可达（假）");
  assert.equal(m1.online, null, "无 runner 登记 ⇒ 未知，不判离线");
  assert.equal(m1.lastHeartbeatAt, null);
  assert.equal(m9.projectCount, 0, "快照里没有项目 ≠ 机器不可达");
  assert.equal(m9.machineError, null);
});

test("T3-③ buildMachineRows: 空快照 ⇒ 空表（页上给「无机器」说明行，不出假行）", () => {
  assert.deepEqual(buildMachineRows(projectsView([], [])), []);
});

// ---------------------------------------------------------------------------
// ② 在飞判据与排序
// ---------------------------------------------------------------------------

test("T3-④ isInflightTaskState: 取「终态闭集」的反面 ⇒ 未知中间态默认算在飞（漏算比误算危险）", () => {
  for (const s of TERMINAL_TASK_STATES) assert.equal(isInflightTaskState(s), false, `${s} 是终态`);
  for (const s of ["working", "submitted", "queued", "input-required", "some-future-state"]) {
    assert.equal(isInflightTaskState(s), true, `${s} 不在终态闭集 ⇒ 算在飞`);
  }
  assert.equal(isInflightTaskState(null), false, "无状态可判 ⇒ 不占位");
  assert.equal(isInflightTaskState(""), false);
});

test("T3-⑤ sortByClaimedAt: 升序（最早领取在前）；null 沉底且沉底行间保持入参序", () => {
  const sorted = sortByClaimedAt([
    task("t-null-b", "working", null),
    task("t-late", "working", "2026-09-27T02:00:00Z"),
    task("t-null-a", "working", null),
    task("t-early", "working", "2026-09-27T01:00:00Z"),
  ]);
  assert.deepEqual(
    sorted.map((t) => t.taskId),
    ["t-early", "t-late", "t-null-b", "t-null-a"],
  );
});

test("T3-⑥ buildInflightModel: 逐项目一节 + 在飞筛选；缺结论按 agent_query_missing 收口（≠「没有在飞」）", () => {
  const view = twoMachineView();
  const tasks = new Map([
    ["p1", { ok: true, tasks: [task("t1", "working", "2026-09-27T02:00:00Z"), task("t2", "completed", null), task("t3", "submitted", "2026-09-27T01:00:00Z")] }],
    ["p2", { ok: false, code: "tasks_timeout", error: "tasks_timeout" }],
    // p3 故意缺席（查询器没返回）
  ]);
  const model = buildInflightModel(view, tasks);
  assert.deepEqual(
    model.projects.map((p) => p.projectId),
    ["p1", "p2", "p3"],
  );
  assert.deepEqual(
    model.projects[0].inflight.map((t) => t.taskId),
    ["t3", "t1"],
    "completed 不入在飞；余两条按 claimedAt 升序",
  );
  assert.equal(model.inflightTotal, 2, "只累计可达项目的在飞数（灰化项目贡献未知）");
  assert.equal(model.grayedCount, 2, "p2 查询失败 + p3 缺结论都算灰化");
  assert.equal(model.projects[1].outcome.code, "tasks_timeout");
  assert.equal(model.projects[2].outcome.ok, false);
  assert.equal(model.projects[2].outcome.code, "agent_query_missing");
  assert.deepEqual(model.projects[2].inflight, [], "灰化项目的在飞集未知 ⇒ 不编造条目");
  assert.equal(model.projects[2].machineId, "m2", "项目身份仍来自快照（机器 / agentKind 可见）");
  assert.equal(model.projects[2].agentKind, "claude");
});

// ---------------------------------------------------------------------------
// ③ 查询器
// ---------------------------------------------------------------------------

test("T3-⑦ 逐项目任务查询器: 成功透传 tasks；**不带 state / limit 过滤**（服务端过滤值域不由板假设）", async () => {
  const calls = [];
  const fetchTasks = createAgentTasksFetcher({
    getTasks: async (projectId, options) => {
      calls.push([projectId, options]);
      return tasksView(projectId, [task("t1", "working")]);
    },
  });
  const out = await fetchTasks("p1");
  assert.equal(out.ok, true);
  assert.deepEqual(out.tasks.map((t) => t.taskId), ["t1"]);
  assert.equal(calls[0][0], "p1");
  assert.equal(calls[0][1], undefined, "第二参数不传 ⇒ 桥按缺省投影返回");
});

test("T3-⑧ 逐项目任务查询器: 抛错 ⇒ 收口 ok=false（tasks_query_failed + 原文），不外抛（不炸页）", async () => {
  const fetchTasks = createAgentTasksFetcher({
    getTasks: async () => {
      throw new Error("桥返回失败 [http_502] 连接被拒");
    },
  });
  const out = await fetchTasks("p1");
  assert.equal(out.ok, false);
  assert.equal(out.code, "tasks_query_failed");
  assert.match(out.error, /http_502/);
});

test("T3-⑨ 逐项目任务查询器: 桥悬挂 ⇒ 单项超时收口 tasks_timeout（缺省 = N6 同源 4s 常量）", async () => {
  assert.equal(AGENT_QUERY_TIMEOUT_MS, 4000, "超时缺省复用 ORG_QUERY_TIMEOUT_MS 口径");
  const fetchTasks = createAgentTasksFetcher({ getTasks: () => new Promise(() => {}) }, 20);
  const t0 = Date.now();
  const out = await fetchTasks("p1");
  assert.equal(out.ok, false);
  assert.equal(out.code, "tasks_timeout");
  assert.ok(Date.now() - t0 < 2000, "超时即返回，不跟随桥的无限悬挂");
});

test("T3-⑩ normalizeBridgeIdentity: 白名单投影 + 逐键容错（坏值只降该键，不判整次失败）", () => {
  const full = normalizeBridgeIdentity({
    status: "ok",
    role: "owner",
    pid: 4128,
    startedAt: "2026-09-27T00:00:00Z",
    version: "0.9.2",
    degraded: [],
  });
  assert.deepEqual(full, IDENTITY_OK);
  const partial = normalizeBridgeIdentity({ role: "member", pid: "not-a-pid", status: "" });
  assert.equal(partial.ok, true, "字段缺失 / 值型不符 ⇒ 该键 null，不判整次失败");
  assert.deepEqual(partial.identity, { status: null, role: "member", pid: null, startedAt: null, version: null });
});

test("T3-⑪ normalizeBridgeIdentity（负向）: 响应不是 JSON 对象 ⇒ response_invalid（形状都没有 = 取不到）", () => {
  for (const bad of [null, undefined, [], "text", 7]) {
    const out = normalizeBridgeIdentity(bad);
    assert.equal(out.ok, false);
    assert.equal(out.code, "response_invalid");
  }
});

test("T3-⑫ 桥身份查询器: GET <base>/health（去尾斜杠、只读）成功归一；非 2xx / 非法 JSON / 传输异常收口不抛", async () => {
  const seen = [];
  const ok = await createBridgeIdentityFetcher({
    baseUrl: "http://127.0.0.1:8787/",
    fetchImpl: async (url, init) => {
      seen.push([String(url), init.method]);
      return new Response(JSON.stringify({ role: "owner", version: "0.9.2" }), { status: 200 });
    },
  })();
  assert.deepEqual(seen[0], ["http://127.0.0.1:8787/health", "GET"]);
  assert.equal(ok.ok, true);
  assert.equal(ok.identity.version, "0.9.2");
  assert.equal(ok.identity.pid, null, "桥 /health 未带 pid ⇒ 页上显示「—」，不臆造");

  const http503 = await createBridgeIdentityFetcher({
    baseUrl: "http://x",
    fetchImpl: async () => new Response("nope", { status: 503 }),
  })();
  assert.deepEqual(http503, { ok: false, code: "http_503", error: "桥返回 HTTP 503：nope" });

  const bad = await createBridgeIdentityFetcher({
    baseUrl: "http://x",
    fetchImpl: async () => new Response("<html>not json", { status: 200 }),
  })();
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "response_invalid");

  const down = await createBridgeIdentityFetcher({
    baseUrl: "http://x",
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
    },
  })();
  assert.equal(down.ok, false);
  assert.equal(down.code, "health_unreachable");
  assert.match(down.error, /ECONNREFUSED/);
});

// ---------------------------------------------------------------------------
// ④ HTTP 面 GET /agents
// ---------------------------------------------------------------------------

test("T3-⑬ GET /agents: 200 + 「Agent」导航高亮 + 页头桥身份行 + 机器表 + 在飞小节 + 页脚口径行", async () => {
  const client = fakeClient(twoMachineView(), async (projectId) =>
    projectId === "p1"
      ? tasksView("p1", [
          task("t-late", "working", "2026-09-27T02:00:00Z"),
          task("t-done", "completed", "2026-09-27T00:00:00Z"),
          task("t-early", "submitted", "2026-09-27T01:00:00Z"),
        ])
      : tasksView(projectId, []),
  );
  await withServer({ client, bridgeIdentityFetcher: async () => IDENTITY_OK }, async (base) => {
    const res = await getHtml(base, "/agents");
    assert.equal(res.status, 200);
    assert.match(res.text, /<title>Agent View · board<\/title>/);
    // 件1：「运行监控」撤出侧栏导航（页面保留、深链可达）⇒ 原「导航含 Agent 且高亮」锚改钉
    // 「侧栏一级菜单 = 项目组门户一枚，且 nav 段内不出 /agents」。
    assert.match(res.text, /<a href="\/">项目组门户<\/a>/, "深链页仍是板壳（侧栏一级菜单在位，本页不高亮任何条）");
    assert.doesNotMatch((/<nav>([\s\S]*?)<\/nav>/.exec(res.text) ?? [, ""])[1], /href="\/agents"/, "件1：/agents 撤出导航");
    assert.match(res.text, /<h2>Agent View · 机器与在飞<\/h2>/);
    assert.match(
      res.text,
      /role = <b>owner<\/b> · pid = <b>4128<\/b> · startedAt = <b>2026-09-27T00:00:00Z<\/b> · version = <b>0\.9\.2<\/b>/,
      "3300 收编的桥 identity/version 头（本页是唯一承载位）",
    );
    assert.match(res.text, /来源 = <code>http:\/\/127\.0\.0\.1:8787\/health<\/code>/, "身份来源端点如实标注");
    assert.match(res.text, /<h3>机器（2）<\/h3>/);
    assert.match(res.text, /2026-09-27T02:59:00Z/, "runner 末次心跳");
    assert.match(res.text, /<h3>在飞任务（2 条 · 3 个项目）<\/h3>/);
    assert.match(res.text, /在飞 2 条（终态之外即算在飞；按 <code>claimedAt<\/code> 升序 = 领取最早者在前）/);
    assert.ok(
      res.text.indexOf(">t-earl<") < res.text.indexOf(">t-late<"),
      "在飞小节按 claimedAt 升序（跑得最久的在前）",
    );
    assert.doesNotMatch(res.text, /t-done/, "completed 任务不入在飞小节");
    assert.match(res.text, /<a class="fl" href="\/tasks\?project=p1">p1<\/a>/, "小节头深链到既有任务页");
    assert.match(
      res.text,
      /口径：闸内排队与 machine 读席占用 orch 不可见，两个时钟不得相加。/,
      "页脚口径行（orch 看不见的两件事不呈现、不推算）",
    );
  });
});

test("T3-⑭ GET /agents 灰化: 单项目查询失败 ⇒ 该项目「不可达 ≠ 没有在飞」，其余照常，不炸页", async () => {
  const client = fakeClient(twoMachineView(), async (projectId) => {
    if (projectId === "p2") throw new Error("桥没起（假）");
    return tasksView(projectId, projectId === "p1" ? [task("t1", "working", "2026-09-27T01:00:00Z")] : []);
  });
  await withServer({ client, bridgeIdentityFetcher: async () => IDENTITY_OK }, async (base) => {
    const res = await getHtml(base, "/agents");
    assert.equal(res.status, 200, "灰化不改变整页成功语义");
    assert.match(res.text, /在飞任务查询失败 1 个项目/, "页级灰化计数行");
    assert.match(res.text, /在飞任务不可达（<code>tasks_query_failed<\/code>）：桥没起（假）/);
    assert.match(res.text, /≠「没有在飞」/);
    assert.match(res.text, /不可达 <span class="mono">tasks_query_failed<\/span>/, "汇总表里同样标不可达");
    assert.ok(res.text.indexOf(">p1<") < res.text.indexOf(">p2<"), "其余项目照常呈现");
    assert.equal((res.text.match(/<h3><a class="fl" href="\/tasks\?project=/g) ?? []).length, 2, "只有出节的项目 = 2（p3 无在飞 ⇒ 不出节，仍在上表）");
  });
});

test("T3-⑮ GET /agents 降级: 在飞查询器未装配（null）⇒ 全项目不可达 + 页级说明，页面不炸", async () => {
  const client = fakeClient(twoMachineView());
  await withServer({ client, agentTasksFetcher: null, bridgeIdentityFetcher: null }, async (base) => {
    const res = await getHtml(base, "/agents");
    assert.equal(res.status, 200);
    assert.match(res.text, /agent_tasks_not_queried/);
    assert.match(res.text, /逐项目在飞任务查询器未装配/);
    assert.match(res.text, /在飞任务查询失败 3 个项目/);
    assert.equal(res.text.match(/agent_tasks_not_queried/g).length, 6, "灰化项目在小节与汇总表各标一次");
  });
});

test("T3-⑯ GET /agents 身份降级: 桥 /health 不可达 ⇒ 页头灰化给错误码，机器表与在飞区照常（不炸页）", async () => {
  const client = fakeClient(twoMachineView(), async (projectId) => tasksView(projectId, [task("t1", "working")]));
  await withServer({
    client,
    bridgeIdentityFetcher: async () => ({ ok: false, code: "health_unreachable", error: "connect ECONNREFUSED 127.0.0.1:8787" }),
  }, async (base) => {
    const res = await getHtml(base, "/agents");
    assert.equal(res.status, 200);
    assert.match(res.text, /桥身份不可达（<code>health_unreachable<\/code>）/);
    assert.match(res.text, /role \/ pid \/ startedAt \/ version 未知/);
    assert.match(res.text, /<h3>机器（2）<\/h3>/, "身份取不到不牵连机器表");
    assert.match(res.text, /<h3>在飞任务（3 条 · 3 个项目）<\/h3>/);
  });
});

test("T3-⑰ GET /agents 走真实查询链: 缺省查询器 = 板侧桥客户端逐项目 getTasks（含异常收口）", async () => {
  const seen = [];
  const client = fakeClient(twoMachineView(), async (projectId) => {
    seen.push(projectId);
    if (projectId === "p3") throw new Error("machine 不可达（假）");
    return tasksView(projectId, projectId === "p2" ? [task("t-p2", "working", "2026-09-27T01:00:00Z")] : []);
  });
  await withServer({ client, bridgeIdentityFetcher: null }, async (base) => {
    const res = await getHtml(base, "/agents");
    assert.equal(res.status, 200);
    assert.deepEqual(seen.sort(), ["p1", "p2", "p3"], "逐项目并发拉任务（每个项目一次 getTasks，不聚合）");
    assert.match(res.text, /t-p2/, "p2 的在飞任务渲染");
    assert.match(res.text, /tasks_query_failed/, "p3 失败灰化收口");
  });
});

test("T3-⑱ 方法门: /agents 只认 GET（POST ⇒ 405，写面白名单不扩）", async () => {
  await withServer({ client: fakeClient(projectsView([], [])), agentTasksFetcher: null, bridgeIdentityFetcher: null }, async (base) => {
    const post = await fetch(`${base}/agents`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.match(await post.text(), /仅支持 GET/);
  });
});

test("T3-⑲ 桥宕: GET /agents ⇒ 502 浮层版式，高亮随发起页「Agent」", async () => {
  const client = {
    baseUrl: "http://fake",
    async getProjects() {
      throw new Error("桥没起（假）");
    },
  };
  await withServer({ client, bridgeIdentityFetcher: null }, async (base) => {
    const res = await getHtml(base, "/agents");
    assert.equal(res.status, 502);
    assert.match(res.text, /bridge_unreachable/);
    // 件1：宕页高亮锚原钉「留在 Agent」⇒ 该条已撤出导航，改钉「板壳侧栏一级菜单在位」（高亮不落任何撤出的条）
    assert.match(res.text, /<a href="\/">项目组门户<\/a>/, "宕页仍是板壳");
    assert.doesNotMatch((/<nav>([\s\S]*?)<\/nav>/.exec(res.text) ?? [, ""])[1], /href="\/agents"/, "件1：宕页也不给撤出的条留导航入口");
  });
});

// ---------------------------------------------------------------------------
// ⑤ 写面纪律（源文件扫描）
// ---------------------------------------------------------------------------

test("T3-⑳ 写面纪律: agent-view.ts 不含状态推进工具名 / 写封装（板不写状态机）", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/agent-view.ts", import.meta.url)), "utf8");
  for (const banned of ["a2a_feature_approve", "a2a_feature_advance", "a2a_feature_cancel", "callToolRaw"]) {
    assert.ok(!source.includes(banned), `源文件不得出现 ${banned}`);
  }
});
