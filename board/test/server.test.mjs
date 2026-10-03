import { test } from "node:test";
import assert from "node:assert/strict";

import { createBoardServer, assertLoopbackHost } from "../dist/server.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

/** 假桥客户端：只实现只读方法，并记录调用序（证明板端零写、零 N+1）。 */
function fakeClient(overrides = {}) {
  const calls = [];
  const client = {
    baseUrl: "http://fake",
    async getFeatures() {
      calls.push("getFeatures");
      return {
        features: [
          {
            featureId: "F1",
            state: "executing",
            title: "需求甲",
            taskCount: 4,
            ownerGroup: "g",
            stage: "改造方案",
            version: "v0.9.0",
            approval: "已通过",
            createdAt: "c",
            updatedAt: "u",
          },
        ],
        stateCounts: null,
      };
    },
    async getFeature(featureId) {
      calls.push(`getFeature:${featureId}`);
      return {
        feature: {
          featureId,
          state: "executing",
          title: "需求甲",
          plan: null,
          ownerGroup: "g",
          stage: "改造方案",
          version: "v0.9.0",
          approval: "已通过",
          createdAt: "c",
          updatedAt: "u",
        },
        tasks: [
          { taskId: "t1", projectId: "p", state: "completed", lane: "write", failureKind: null, retryCount: 0, dependencies: [] },
        ],
      };
    },
    async getFeatureTrace(featureId) {
      calls.push(`getFeatureTrace:${featureId}`);
      return {
        featureId,
        featureState: "executing",
        nodes: [
          {
            taskId: "t2",
            projectId: "p",
            state: "submitted",
            lane: "read",
            queueState: "queued",
            waitReason: "read_lane_running",
            blockedOn: [],
            projectBusy: { busy: false, taskId: null, machineId: null },
            readOccupants: [
              { taskId: "r1", featureId: null, queueState: "running", machineId: "m1", queuedAt: "q" },
            ],
            position: 1,
            waitedSince: "2026-09-24T11:55:00Z",
          },
        ],
      };
    },
    async getProjects() {
      calls.push("getProjects");
      return {
        source: "桥注册表",
        note: "快照语义",
        observedAt: "o",
        machines: [
          {
            machineId: "m1",
            error: null,
            projects: [
              { projectId: "p", agentKind: "claude", a2aPort: 3017, status: "online", endpoint: null, startedAt: null },
            ],
          },
        ],
        runners: [{ machineId: "m1", online: true, lastHeartbeatAt: "h" }],
      };
    },
    async getTasks(projectId, options) {
      calls.push(`getTasks:${projectId}:${options?.state ?? ""}:${options?.limit ?? ""}`);
      return {
        projectId,
        reachable: true,
        notice: null,
        tasks: [
          { taskId: "t1", contextId: "ctx", state: "working", prompt: "做 x", text: null, updatedAt: "u", stale: false },
        ],
      };
    },
    ...overrides,
  };
  return { client, calls };
}

async function withServer(run, overrides) {
  const { client, calls } = fakeClient(overrides);
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, client, now: () => NOW });
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    await run(base, calls);
  } finally {
    await handle.close();
  }
}

async function get(base, path, method = "GET") {
  const res = await fetch(`${base}${path}`, { method });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

test("GET /requirements ⇒ 303 回首页（REQ-04 Q2 列表页退役；不触桥）", async () => {
  await withServer(async (base, calls) => {
    const res = await fetch(`${base}/requirements`, { redirect: "manual" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
    await res.body?.cancel();
    assert.deepEqual(calls, [], "退役地址只做重定向，不触桥");
  });
});

test("GET /org/g/schedule 看板需求卡（B5a 重指空间排期页）：渲染派生阶段徽标 + taskCount；桥一次调用（无 N+1）", async () => {
  await withServer(async (base, calls) => {
    const res = await get(base, "/org/g/schedule");
    assert.equal(res.status, 200);
    assert.match(res.text, /需求甲/);
    assert.match(res.text, /改造中/);
    assert.match(res.text, /任务数：4/, "卡片带 taskCount（列表自带、无二次查询）");
    assert.deepEqual(calls, ["getFeatures"]);
  });
});

test("过滤参数随列表页退役：`/org/g/schedule` 与 `/requirements` 均不消费 query（REQ-04 Q3 · B5a 看板宿主 = 空间页）", async () => {
  await withServer(async (base, calls) => {
    const res = await get(base, "/org/g/schedule?state=completed");
    assert.equal(res.status, 200);
    assert.match(res.text, /<title>空间 · g · 排期 · board<\/title>/, "看板恒全量渲染，过滤参数无效果");
    assert.doesNotMatch(res.text, /过滤后|filter-form/, "过滤表单已随列表页删除");
    const redirected = await fetch(`${base}/requirements?state=completed`, { redirect: "manual" });
    assert.equal(redirected.status, 303, "带 query 的旧深链同样 303 回首页");
    await redirected.body?.cancel();
    assert.deepEqual(calls, ["getFeatures"], "仅看板页渲染触桥一次，重定向零触达");
  });
});

test("HTML 应答带强 CSP + no-store；页面同源无外部资源", async () => {
  await withServer(async (base) => {
    const res = await get(base, "/");
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(res.text, /src="http/);
    assert.doesNotMatch(res.text, /href="http/);
  });
});

test("GET /features/F1：详情 = feature+tasks+trace 三面（B13 显示齐备）", async () => {
  await withServer(async (base, calls) => {
    const res = await get(base, "/features/F1");
    assert.equal(res.status, 200);
    assert.match(res.text, /已通过/);
    assert.match(res.text, /v0\.9\.0/);
    assert.match(res.text, /read_lane_running/);
    assert.match(res.text, /写门未挡/);
    assert.match(res.text, /读档占位 1 个：r1@m1/);
    assert.match(res.text, /5m 0s/);
    assert.match(res.text, /action="\/features\/F1\/schedule"/, "M6：排期表单 GET 面 = 详情页");
    assert.deepEqual(calls, ["getFeature:F1", "getFeatureTrace:F1"]);
  });
});

test("/features/:id：trace 失败不静默（页面显示错误且详情仍渲染）", async () => {
  await withServer(
    async (base) => {
      const res = await get(base, "/features/F1");
      assert.equal(res.status, 200);
      assert.match(res.text, /trace 读取失败：boom/);
      assert.match(res.text, /需求甲/);
    },
    {
      async getFeatureTrace() {
        throw new Error("boom");
      },
    },
  );
});

test("C1：GET /tasks 裸页（含 ?project= 空值）⇒ 303 回门户 + no-store、零触桥；?project=p ⇒ 深链存活 200 任务表", async () => {
  await withServer(async (base, calls) => {
    for (const path of ["/tasks", "/tasks?project="]) {
      const pick = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(pick.status, 303, `${path} ⇒ 303（裸页退役，判据 = pathname ∧ query，空 project = 无项目可列同档）`);
      assert.equal(pick.headers.get("location"), "/", `${path} 303 目标 = 门户`);
      assert.equal(pick.headers.get("cache-control"), "no-store", `${path} 重定向不缓存`);
      await pick.body?.cancel();
    }
    const list = await get(base, "/tasks?project=p");
    assert.equal(list.status, 200, "深链 ?project=p 存活（views.ts org===null ∧ 带 project 分支不整删）");
    assert.match(list.text, /执行中（working）/);
    assert.ok(calls.some((c) => c.startsWith("getTasks:p")));
  });
});

test("GET /tasks?state=… ⇒ 透传给桥 getTasks（服务端过滤，REQ-v0.9.2 N4）", async () => {
  await withServer(async (base, calls) => {
    const res = await get(base, "/tasks?project=p&state=working");
    assert.equal(res.status, 200);
    assert.ok(calls.includes("getTasks:p:working:"));
    assert.match(res.text, /state=working/);
    assert.match(res.text, /桥服务端过滤/);
  });
});

test("GET /tasks?limit=5 ⇒ 透传；limit 非法（0 / abc / 1.5 / 负数 / 超界）⇒ 结构化 400 不静默吞", async () => {
  await withServer(async (base, calls) => {
    const ok = await get(base, "/tasks?project=p&limit=5");
    assert.equal(ok.status, 200);
    assert.ok(calls.includes("getTasks:p::5"));
    for (const bad of ["0", "abc", "1.5", "-2", "600"]) {
      const res = await get(base, `/tasks?project=p&limit=${bad}`);
      assert.equal(res.status, 400, `limit=${bad} 应 400`);
      assert.match(res.text, /invalid_limit/);
    }
    assert.ok(!calls.some((c) => c.startsWith("getTasks:p::a")), "非法 limit 不得触桥");
    const json = await fetch(`${base}/tasks?project=p&limit=0`, { headers: { accept: "application/json" } });
    assert.equal(json.status, 400);
    const body = await json.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "invalid_limit");
    assert.match(body.error, /limit/);
  });
});

test("GET /projects：机器/项目/runner 三表 + 快照注", async () => {
  await withServer(async (base) => {
    const res = await get(base, "/projects");
    assert.equal(res.status, 200);
    assert.match(res.text, /m1/);
    assert.match(res.text, /3017/);
    assert.match(res.text, /快照语义/);
  });
});

test("只读面：非 GET 一律 405；未知路径 404；/health 保留", async () => {
  await withServer(async (base, calls) => {
    const post = await get(base, "/", "POST");
    assert.equal(post.status, 405);
    // BD8 起写路径有三条，405 文案改为列举白名单（原「只读看板仅支持 GET」措辞已不成立）
    assert.match(post.text, /仅支持 GET/);
    assert.match(post.text, /POST \/requirements/);
    assert.match(post.text, /POST \/host\/\{org\}\/stop/);
    const nf = await get(base, "/nope");
    assert.equal(nf.status, 404);
    const h = await get(base, "/health");
    assert.equal(h.status, 200);
    assert.equal(JSON.parse(h.text).status, "ok");
    // 405/404 不触桥
    assert.deepEqual(calls, []);
  });
});

test("桥不可达 ⇒ 502 页面如实可见（不静默、不缓存旧数据；REQ-v0.9.2 N2 起套 BD2 浮层版式）", async () => {
  await withServer(
    async (base) => {
      const res = await get(base, "/");
      assert.equal(res.status, 502);
      // 整页 = errorPage 统一版式：错误正文改由浮层承载（族名标题 / error / mono code /「知道了」）
      assert.match(res.text, /class="err-ov"/, "桥宕页必须套 BD2 浮层");
      assert.ok(res.text.includes("<h2>桥不可达</h2>"), "浮层标题 = 错误码中文族名");
      assert.match(res.text, /<p>connection refused<\/p>/, "error 正文上浮层");
      assert.ok(res.text.includes('<p class="err-ov-code mono">bridge_unreachable</p>'), "mono 小字 = code");
      assert.match(res.text, /<button type="button" id="err-ov-close">知道了<\/button>/);
      assert.match(res.text, /恢复后刷新本页即可/, "刷新重试口径保留（hint）");
    },
    {
      async getFeatures() {
        throw new Error("connection refused");
      },
    },
  );
});

test("assertLoopbackHost: 非 loopback 拒起", () => {
  assert.doesNotThrow(() => assertLoopbackHost("127.0.0.1"));
  assert.throws(() => assertLoopbackHost("0.0.0.0"), /loopback/);
});

// ---------------------------------------------------------------------------
// BD10-⑤（负向的反向）：默认组织未配置**不牵连读面**（板不拒起 · BD11 起该项已降为可选默认）
// ---------------------------------------------------------------------------

test("BD10-⑤：默认组织未配置（defaultGroup = null，即 resolveDefaultGroup 的真实返回）⇒ 读面五页照常 200", async () => {
  const { client } = fakeClient();
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, client, now: () => NOW, defaultGroup: null });
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    for (const path of ["/", "/features/F1", "/tasks?project=p", "/projects", "/host"]) {
      const res = await get(base, path);
      assert.equal(res.status, 200, `${path} 不得因默认组织缺失而失败（读面与写面配置无关）`);
    }
    const health = await get(base, "/health");
    assert.equal(health.status, 200, "默认组织缺失不构成 /health degraded");
  } finally {
    await handle.close();
  }
});

// ---------------------------------------------------------------------------
// REQ-2026-10-02-02 件B / REQ-2026-10-02-04 件B（回归锚）：notes 逐页摘除（门户 → 任务页），
// 详情页 notes 正钉保留（防 sendPage 单点开关误伤其余页）；任务页口径折叠块一并补负钉
// ---------------------------------------------------------------------------

test("件B：页底 notes 门户 / 任务页摘除 · 详情页保留 · 任务页无口径折叠（增补四补负钉）", async () => {
  await withServer(async (base) => {
    const home = await get(base, "/");
    assert.equal(home.status, 200);
    assert.doesNotMatch(home.text, /<ul class="notes"/, "门户不收全局口径说明");
    const detail = await get(base, "/features/F1");
    assert.equal(detail.status, 200);
    assert.match(detail.text, /<ul class="notes"/, "详情页的页底 notes 照旧保留（单点开关不误伤）");
    const tasks = await get(base, "/tasks?project=p");
    assert.equal(tasks.status, 200);
    assert.doesNotMatch(tasks.text, /<ul class="notes"/, "增补四：全局任务页不收全站口径说明");
    assert.doesNotMatch(tasks.text, /<details class="calib"/, "增补四：全局任务页口径折叠块已删");
  });
});
