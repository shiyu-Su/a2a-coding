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
      calls.push(`getTasks:${projectId}:${options?.state ?? ""}`);
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

test("GET / 需求列表：渲染派生阶段 + taskCount；桥一次调用（无 N+1）", async () => {
  await withServer(async (base, calls) => {
    const res = await get(base, "/");
    assert.equal(res.status, 200);
    assert.match(res.text, /需求甲/);
    assert.match(res.text, /改造中/);
    assert.match(res.text, /<td>4<\/td>/);
    assert.deepEqual(calls, ["getFeatures"]);
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

test("GET /tasks 无 project ⇒ 选单页；?project=p ⇒ 任务表", async () => {
  await withServer(async (base, calls) => {
    const pick = await get(base, "/tasks");
    assert.equal(pick.status, 200);
    assert.match(pick.text, /<form method="get" action="\/tasks">/);
    const list = await get(base, "/tasks?project=p");
    assert.equal(list.status, 200);
    assert.match(list.text, /执行中（working）/);
    assert.ok(calls.some((c) => c.startsWith("getTasks:p")));
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

test("桥不可达 ⇒ 502 页面如实可见（不静默、不缓存旧数据）", async () => {
  await withServer(
    async (base) => {
      const res = await get(base, "/");
      assert.equal(res.status, 502);
      assert.match(res.text, /桥数据读取失败（502）/);
      assert.match(res.text, /connection refused/);
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
    for (const path of ["/", "/features/F1", "/tasks", "/tasks?project=p", "/projects", "/host"]) {
      const res = await get(base, path);
      assert.equal(res.status, 200, `${path} 不得因默认组织缺失而失败（读面与写面配置无关）`);
    }
    const health = await get(base, "/health");
    assert.equal(health.status, 200, "默认组织缺失不构成 /health degraded");
  } finally {
    await handle.close();
  }
});
