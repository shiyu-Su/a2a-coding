import { test } from "node:test";
import assert from "node:assert/strict";

import { createBoardServer } from "../dist/server.js";
import { scheduleFeature } from "../dist/feature-schedule.js";

const NOW = Date.parse("2026-09-25T12:00:00Z");

/**
 * 只读面假客户端：getFeature 可控返回 state / ownerGroup（M3 端点前置读），
 * 其余读口一律拒触达（写面用例不该打到列表/追踪面）。
 */
function fakeClient(featureOver = {}) {
  const calls = [];
  const feature = {
    featureId: "F1",
    state: "executing",
    title: "需求甲",
    plan: null,
    ownerGroup: "g",
    // v0.9.3 B-T5 双条件闸默认放行态（想法挪版档：stage=需求分析 ∧ approval=未发起）
    // —— 排期写既有用例验的是「三键装配 / 锁版 / CSRF / 漂移」，闸自身的正负例见 G-①…G-④。
    stage: "需求分析",
    version: "v0.9.1",
    approval: "未发起",
    decisions: null,
    contracts: null,
    createdAt: "c",
    updatedAt: "u",
    ...featureOver,
  };
  return {
    calls,
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        throw new Error("不该被排期写用例触达");
      },
      async getFeature(featureId) {
        calls.push(`getFeature:${featureId}`);
        return { feature, tasks: [], acceptance: null };
      },
      async getFeatureTrace() {
        throw new Error("不该被排期写用例触达");
      },
      async getProjects() {
        throw new Error("不该被排期写用例触达");
      },
      async getTasks() {
        throw new Error("不该被排期写用例触达");
      },
    },
  };
}

async function withServer(run, serverOptions = {}, client) {
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    ...serverOptions,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };
const WRITE_HEADERS = { "x-board-write": "1" };

function schedulePost(base, body, headers = {}, options = {}) {
  return fetch(`${base}/features/F1/schedule`, {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM_HEADERS, ...headers },
    body,
    ...options,
  });
}

/** 假排期封装：记录实收 (input, options)，返回可控结果。 */
function fakeSchedule(result) {
  const seen = [];
  const fn = async (input, options) => {
    seen.push({ input, options });
    return result ?? { ok: true, featureId: input.featureId, state: input.to, version: input.version };
  };
  return { fn, seen };
}

/** 真实 scheduleFeature + 注入 fetch：捕获**出网**报文（离线端到端锁装配）。 */
function realScheduleCapturing(payload) {
  const captured = { urls: [], bodies: [] };
  const fn = (input, options) =>
    scheduleFeature(input, {
      ...options,
      fetchImpl: async (url, init) => {
        captured.urls.push(String(url));
        captured.bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(payload), { status: 200 });
      },
    });
  return { fn, captured };
}

function okEnvelope(payload) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false },
  };
}

// ---------------------------------------------------------------------------
// M6 改版失联警示（HTTP 面）：排期表单 GET 页 = 需求详情页；decisions 有旧版文档登记 ⇒ 警示行
// ---------------------------------------------------------------------------

test("M6 GET /features/F1：decisions 登记旧版文档且已改版 ⇒ 失联警示行可见；无登记 ⇒ 无警示行", async () => {
  const staleClient = fakeClient({
    version: "v0.9.2",
    decisions: JSON.stringify(["doc/v0.9.1/甲-改造文档.md 用户确认"]),
  });
  await withServer(
    async (base) => {
      const text = await (await fetch(`${base}/features/F1`)).text();
      assert.match(text, /action="\/features\/F1\/schedule"/, "排期表单 GET 面 = 详情页");
      assert.match(text, /name="version" value="v0\.9\.2"/, "当前版本回填");
      assert.match(text, /文档读锚将随版本切换/, "警示行可见");
      assert.match(text, /v0\.9\.1/, "点名失联的旧版本");
      assert.match(text, /不搬文档目录/);
    },
    {},
    staleClient.client,
  );
  const cleanClient = fakeClient({
    version: "v0.9.2",
    decisions: JSON.stringify(["doc/v0.9.2/甲-改造文档.md"]),
  });
  await withServer(
    async (base) => {
      const text = await (await fetch(`${base}/features/F1`)).text();
      assert.doesNotMatch(text, /文档读锚将随版本切换/, "登记版本 == 当前版本 ⇒ 不警示");
    },
    {},
    cleanClient.client,
  );
});

// ---------------------------------------------------------------------------
// M3-① 装配锁：出网 = advance 特例，arguments 有且仅有 {featureId,to,version}，
// to = getFeature 取来的当前态，身份 = ownerGroup（URL 首段），绝不携带 stage/approval
// ---------------------------------------------------------------------------

test("M3-①：排期出网仅三键（featureId/to/version），to = 当前态，组身份 = ownerGroup 进 URL 首段", async () => {
  const { fn, captured } = realScheduleCapturing(
    okEnvelope({ ok: true, featureId: "F1", state: "executing", version: "v0.9.2" }),
  );
  const { client } = fakeClient({ state: "testing", ownerGroup: "flow" });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.2", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 200);
      const args = captured.bodies[0].params.arguments;
      assert.deepEqual(Object.keys(args).sort(), ["featureId", "to", "version"], "装配仅三键，多一键即破纪律");
      assert.equal(args.featureId, "F1");
      assert.equal(args.to, "testing", "to = getFeature 取来的当前态原样回填（登记字段特例，不迁移状态机）");
      assert.equal(args.version, "v0.9.2");
      assert.ok(!("stage" in args) && !("approval" in args), "绝不携带 stage/approval（approval 单向无回边会锁死过审门）");
      assert.deepEqual(captured.urls, ["http://127.0.0.1:8787/flow/mcp"], "身份 = 该 Feature 的 ownerGroup");
    },
    { defaultGroup: "board-cfg-group", mcpBaseUrl: "http://127.0.0.1:8787", scheduleFeatureImpl: fn },
    client,
  );
});

test("M3-①b：发送前一律 trim()（空格自成一列坑）", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient();
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=%20%20v0.9.2%20", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 200);
      assert.equal(seen[0].input.version, "v0.9.2");
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn },
    client,
  );
});

// ---------------------------------------------------------------------------
// M3-② 空串 = 删除排期（显式发 ""，键存在）；缺键 = 编程错误抛错，不做缺键语义
// ---------------------------------------------------------------------------

test("M3-②：version 空串 = 删除排期 ⇒ 出网 version === \"\" 且键存在", async () => {
  const { fn, captured } = realScheduleCapturing(
    okEnvelope({ ok: true, featureId: "F1", state: "executing", version: "" }),
  );
  const { client } = fakeClient();
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 200, "清空排期是合法语义，不是必填校验失败");
      const args = captured.bodies[0].params.arguments;
      assert.equal(args.version, "");
      assert.ok("version" in args, "清空 = 显式发空串，不是省略键");
    },
    { defaultGroup: "g", mcpBaseUrl: "http://127.0.0.1:8787", scheduleFeatureImpl: fn },
    client,
  );
});

test("M3-②b（负向）：version 键缺失 ⇒ 服务端抛 ScheduleFormProgrammingError（全局兜底 500），零出网、不做缺键语义", async () => {
  const { fn, seen } = fakeSchedule();
  const { client, calls } = fakeClient();
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "title=无关", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 500, "缺键 = 编程错误抛错（全局兜底 500），不得静默当清空或必填 400");
      const json = JSON.parse(await res.text());
      assert.equal(json.ok, false);
      assert.match(json.error, /排期表单缺少 version 键/);
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn },
    client,
  );
  assert.deepEqual(seen, [], "缺键请求不得触达排期封装");
  assert.deepEqual(calls, [], "缺键判定先于 getFeature 读面");
});

// ---------------------------------------------------------------------------
// M3-③ ownerGroup null ⇒ 结构化 503，绝不回落板级默认组
// ---------------------------------------------------------------------------

test("M3-③（负向）：ownerGroup = null ⇒ 503 结构化拒绝，零出网，绝不回落板级默认组", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ ownerGroup: null });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.2", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 503);
      const json = JSON.parse(await res.text());
      assert.equal(json.code, "board_schedule_owner_group_missing");
      assert.match(json.error, /不猜、绝不回落板级默认组/);
    },
    { defaultGroup: "board-default-org", scheduleFeatureImpl: fn },
    client,
  );
  assert.deepEqual(seen, [], "归属未定时不得触达写封装（更不得拿板级默认组出网）");
});

// ---------------------------------------------------------------------------
// M3-④ CSRF 两档 + body 上限（与其它五条写端点同规格）
// ---------------------------------------------------------------------------

test("M3-④（负向）：跨站 Origin ⇒ 403 write_guard_origin；无守卫头无来源 ⇒ 403 origin_unknown；守卫头档 / 同源 Origin 档放行", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient();
  await withServer(
    async (base) => {
      const cross = await schedulePost(base, "version=v1", { origin: "http://evil.example:80" });
      assert.equal(cross.status, 403);
      assert.match(await cross.text(), /CSRF 来源校验拒绝/, "表单档错误浮层族名");

      const noProof = await schedulePost(base, "version=v1", {});
      assert.equal(noProof.status, 403);
      assert.match(await noProof.text(), /CSRF 来源不可判定/);

      const viaHeader = await schedulePost(base, "version=v1", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(viaHeader.status, 200);
      const viaOrigin = await schedulePost(base, "version=v1", { origin: base });
      assert.equal(viaOrigin.status, 303, "同源 Origin 档（零 JS 表单）放行 + PRG");
      assert.equal(seen.length, 2);
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn },
    client,
  );
});

test("M3-④b（负向）：超限体 ⇒ 413 出口在校验层、封装零触达（HTTP 级送达不可构造，口径同 BD20 注）", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient();
  // readBodyCapped 满额即 reject 并 req.destroy()——响应在写入中途被打断，任何客户端收不到
  // （既有断连语义，提需求端点同款）；413 的形状/族名由 write-guard 纯函数用例钉住。
  await withServer(
    async (base) => {
      await assert.rejects(
        () =>
          schedulePost(base, "version=" + "甲".repeat(200_000), {
            ...WRITE_HEADERS,
            accept: "application/json",
          }),
        /ECONNRESET|fetch failed|socket hang up/i,
      );
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn },
    client,
  );
  assert.deepEqual(seen, [], "超限请求不得触达排期封装");
});

// ---------------------------------------------------------------------------
// M3-⑤ 态漂移被 orch 拒 ⇒ 如实弹错误浮层 + N1 回填，不自动重试
// ---------------------------------------------------------------------------

test("M3-⑤：读-写窗口态漂移被桥拒 ⇒ 502 + 错误码透传 + 浮层回填，封装只被调一次（不自动重试）", async () => {
  const { fn, seen } = fakeSchedule({
    ok: false,
    code: "feature_illegal_transition",
    error: "to 非当前态（状态已迁移）",
  });
  const { client } = fakeClient();
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.2", { origin: base });
      assert.equal(res.status, 502);
      const html = await res.text();
      assert.match(html, /桥调用错误|feature_illegal_transition/);
      assert.match(html, /feature_illegal_transition/, "mono 错误码原样上浮层");
      assert.match(html, /未自动重试/, "文案明示不自动重试");
      assert.match(html, /err-ov-field-value/, "N1 回填：错误浮层携带提交值");
      assert.match(html, /v0\.9\.2/);
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn },
    client,
  );
  assert.equal(seen.length, 1, "拒绝后不得自动重试第二次");
});

test("M3-⑤b（负向）：getFeature 读面失败 ⇒ 502 如实报，零出网", async () => {
  const { fn, seen } = fakeSchedule();
  const client = fakeClient().client;
  client.getFeature = async () => {
    throw new Error("桥宕机模拟");
  };
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.2", {
        ...WRITE_HEADERS,
        accept: "application/json",
      });
      assert.equal(res.status, 502);
      const json = JSON.parse(await res.text());
      assert.equal(json.code, "bridge_unreachable");
      assert.match(json.error, /无法确定当前态与归属组织/);
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn },
    client,
  );
  assert.deepEqual(seen, []);
});

// ---------------------------------------------------------------------------
// M3-⑥ wantsJson 分流 + PRG 303 回详情
// ---------------------------------------------------------------------------

test("M3-⑥：成功两档 —— JSON 档 200 结构化回显；表单档 PRG 303 回详情页", async () => {
  const { fn } = fakeSchedule();
  const { client } = fakeClient();
  await withServer(
    async (base) => {
      const json = await schedulePost(base, "version=v0.9.2", {
        ...WRITE_HEADERS,
        accept: "application/json",
      });
      assert.equal(json.status, 200);
      const payload = JSON.parse(await json.text());
      assert.deepEqual(payload, { ok: true, featureId: "F1", group: "g", state: "executing", version: "v0.9.2" });

      const form = await schedulePost(base, "version=v0.9.2", { origin: base });
      assert.equal(form.status, 303);
      assert.equal(form.headers.get("location"), "/features/F1");
      assert.equal(form.headers.get("cache-control"), "no-store");
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn },
    client,
  );
});

// ---------------------------------------------------------------------------
// M3-⑦ 方法门：schedule 只认 POST；GET 不落写面（404 未知路径先行）
// ---------------------------------------------------------------------------

test("M3-⑦（负向）：GET/PUT /features/F1/schedule 不落写面 ⇒ 未知路径 404 先行，零触封装", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient();
  await withServer(
    async (base) => {
      const get = await fetch(`${base}/features/F1/schedule`);
      assert.equal(get.status, 404, "写路径不注册读面路由");
      const put = await fetch(`${base}/features/F1/schedule`, { method: "PUT" });
      assert.equal(put.status, 404, "非 POST 不落 405 也不落写面（未知路径先行，口径同 /requirements 的 PUT）");
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn },
    client,
  );
  assert.deepEqual(seen, []);
});

// ---------------------------------------------------------------------------
// 增补 ⑤ N3：排期执法 —— 入锁 / 出锁 / 同锁版幂等 三分判（锁版 = config releasedVersions）
// ---------------------------------------------------------------------------

const LOCK = ["v0.9.1"];

test("N3-①（负向）：入锁 —— 现版本未锁 ∧ 目标 ∈ 锁版 ⇒ 409 board_version_released，零出网", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ version: "v0.9.2" });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.1", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 409);
      const json = JSON.parse(await res.text());
      assert.equal(json.code, "board_version_released");
      assert.match(json.error, /不可将需求排入/);
      assert.match(json.error, /v0\.9\.1/, "文案点明被锁的目标版本");
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn, releasedVersions: LOCK },
    client,
  );
  assert.deepEqual(seen, [], "锁判必须前置于出网（零出网）");
});

test("N3-②（负向）：出锁 —— 现版本 ∈ 锁版 ∧ 目标为另一版本 ⇒ 409 同码，零出网", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ version: "v0.9.1" });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.2", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 409);
      const json = JSON.parse(await res.text());
      assert.equal(json.code, "board_version_released");
      assert.match(json.error, /已发版版本的需求不可移出或取消排期/);
      assert.match(json.error, /v0\.9\.1/, "文案点明需求当前所在锁版");
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn, releasedVersions: LOCK },
    client,
  );
  assert.deepEqual(seen, []);
});

test("N3-③（负向）：删除排期 = 出锁的一种 ⇒ 现版本 ∈ 锁版时清空被拒，零出网", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ version: "v0.9.1" });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 409, "清空回池对锁版需求同样被拒（出锁口径含清空）");
      const json = JSON.parse(await res.text());
      assert.equal(json.code, "board_version_released");
      assert.match(json.error, /不可移出或取消排期/);
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn, releasedVersions: LOCK },
    client,
  );
  assert.deepEqual(seen, []);
});

test("N3-④（正向）：同锁版无变化 ⇒ 幂等放行（200，装配 version 原样出网）", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ version: "v0.9.1" });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.1", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 200, "重提同一锁版不报错（幂等放行）");
      assert.equal(seen[0].input.version, "v0.9.1");
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn, releasedVersions: LOCK },
    client,
  );
});

test("N3-⑤（正向 · 对照）：未锁版之间的排期与清空照常；未锁版需求可移出", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ version: "v0.9.2" });
  await withServer(
    async (base) => {
      const toOther = await schedulePost(base, "version=v0.9.3", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(toOther.status, 200);
      const toPool = await schedulePost(base, "version=", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(toPool.status, 200, "未锁版需求清空回池放行（口径同 M3-②）");
      assert.equal(seen.length, 2);
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn, releasedVersions: LOCK },
    client,
  );
});

test("N3-⑥（负向 · 表单档）：入锁 / 出锁拒绝 ⇒ 错误浮层 + 目标版本与现版本回填", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ version: "v0.9.1" });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.3", { origin: base });
      assert.equal(res.status, 409);
      const html = await res.text();
      assert.match(html, /<div class="err-ov"/, "表单档须走错误浮层，不裸 JSON");
      assert.match(html, /版本已发版锁定/, "族名中文映射（views.ERROR_FAMILY_LABELS）");
      assert.match(html, /board_version_released/);
      const field = (label, value) =>
        new RegExp(
          `<span class="err-ov-field-label">${label}</span>\\s*<span class="err-ov-field-value mono">${value}</span>`,
        );
      assert.match(html, field("目标版本", "v0\\.9\\.3"));
      assert.match(html, field("现版本", "v0\\.9\\.1"), "被锁的一侧须回显现版本（从哪被锁）");
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn, releasedVersions: LOCK },
    client,
  );
  assert.deepEqual(seen, []);
});

test("N3-⑦（正向 · 对照）：未配置锁表 ⇒ 锁判零影响（锁版目标也照常放行，行为同 N3 之前）", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ version: "v0.9.2" });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.1", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 200, "releasedVersions 缺省 = [] ⇒ 无锁");
      assert.equal(seen.length, 1);
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn },
    client,
  );
});

test("N3-⑧（边界）：锁判与同版判均 trim 后精确比较 —— 现版本带空格仍算锁版，非等串（含前缀串）算改版被出锁拒", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ version: " v0.9.1 " });
  await withServer(
    async (base) => {
      const suffix = await schedulePost(base, "version=v0.9.1-probe", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(suffix.status, 409, "v0.9.1-probe ≠ v0.9.1（精确比较）⇒ 就锁版需求而言是「改到别的版」= 出锁拒");
      assert.match(JSON.parse(await suffix.text()).error, /不可移出或取消排期/, "走的是出锁支，非入锁支");
      const keepLocked = await schedulePost(base, "version=v0.9.2", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(keepLocked.status, 409, "现版本两侧空格归一后仍命中锁版 ⇒ 按出锁拒");
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn, releasedVersions: LOCK },
    client,
  );
  assert.deepEqual(seen, [], "出锁请求一律零出网");
});

test("N3-⑧b（边界 · 入锁侧禁前缀连坐）：现版本未锁时，排向锁版的前缀串放行", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ version: "v0.9.2" });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.1-probe", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 200, "isVersionLocked 精确匹配 ⇒ v0.9.1-probe 不被 v0.9.1 连坐（口径同 N2 提需求面）");
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn, releasedVersions: LOCK },
    client,
  );
  assert.equal(seen.length, 1);
});

test("N3-⑨（边界）：现版本为 null（引擎未登记）⇒ 目标锁版按入锁拒；目标未锁放行", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ version: null });
  await withServer(
    async (base) => {
      const toLocked = await schedulePost(base, "version=v0.9.1", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(toLocked.status, 409);
      const toFree = await schedulePost(base, "version=v0.9.3", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(toFree.status, 200, "null 现版本 = 未排期，不属任何锁版 ⇒ 排向未锁版放行");
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn, releasedVersions: LOCK },
    client,
  );
  assert.equal(seen.length, 1);
});

// ---------------------------------------------------------------------------
// v0.9.3 B-T5 双条件状态闸：排期改动仅 `stage=需求分析 ∧ approval=未发起`（想法挪版）可写
// —— 与 ③b 已发版锁**叠加、互不替代**；stage/approval 只作读判，不进载荷与出网装配。
// ---------------------------------------------------------------------------

test("G-①（正向）：想法挪版态（需求分析 ∧ 未发起）⇒ 改版放行，出网仍仅三键（不含 stage/approval）", async () => {
  const { fn, captured } = realScheduleCapturing(
    okEnvelope({ ok: true, featureId: "F1", state: "executing", version: "v0.9.3" }),
  );
  const { client } = fakeClient({ stage: "需求分析", approval: "未发起", version: "v0.9.1" });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.3", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 200);
      const args = captured.bodies[0].params.arguments;
      assert.deepEqual(Object.keys(args).sort(), ["featureId", "to", "version"], "闸读判不改装配（stage/approval 不进载荷）");
    },
    { defaultGroup: "g", mcpBaseUrl: "http://127.0.0.1:8787", scheduleFeatureImpl: fn },
    client,
  );
});

test("G-②（负向 · 两锁态）：stage 已进「改造方案」或 approval 已「待审批 / 已通过」⇒ 409 board_schedule_state_locked 零出网", async () => {
  for (const over of [
    { stage: "改造方案", approval: "未发起" },
    { stage: "需求分析", approval: "待审批" },
    { stage: "改造方案", approval: "已通过" },
    { stage: "发版", approval: "已通过" },
  ]) {
    const { fn, seen } = fakeSchedule();
    const { client } = fakeClient(over);
    await withServer(
      async (base) => {
        const res = await schedulePost(base, "version=v0.9.3", { ...WRITE_HEADERS, accept: "application/json" });
        assert.equal(res.status, 409, `${over.stage}/${over.approval} ⇒ 非想法态，改版被闸拒`);
        const json = JSON.parse(await res.text());
        assert.equal(json.code, "board_schedule_state_locked");
        assert.match(json.error, /排期锁定/);
        assert.match(json.error, /stage = 需求分析 ∧ approval = 未发起/, "文案给出放行态的完整双条件");
        assert.match(json.error, /需求确认单经用户确认后（stage 迁「改造方案」\/ approval 过门）该需求的排期即不可在本板改动/, "R5 文案句 ①");
        assert.match(json.error, /本板不提供解除入口/, "R5 文案句 ②（不得暗示板上可解）");
        assert.match(json.error, /主需求 cancel 后从 Step 0 新建/, "R5 解锁去处 = 流程，不是板操作");
        assert.match(json.error, /宿主经 MCP 直写[\s\S]*不经过本闸/, "R5 文案句 ③：如实标注 MCP 口不经本闸");
        assert.match(json.error, /流程规范纪律句兜底/);
        assert.doesNotMatch(json.error, /后门不豁免/, "不得声称拦得住 MCP 直写（判据 ⑥ / R5 口径）");
      },
      { defaultGroup: "g", scheduleFeatureImpl: fn },
      client,
    );
    assert.deepEqual(seen, [], "闸判必须前置于出网（零出网）");
  }
});

test("G-③（负向 · 老桥 fail-closed）：stage / approval 缺失（null）⇒ 一律拒写，不猜放行", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ stage: null, approval: null });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.3", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 409);
      const json = JSON.parse(await res.text());
      assert.equal(json.code, "board_schedule_state_locked");
      assert.match(json.error, /缺失/);
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn },
    client,
  );
  assert.deepEqual(seen, []);
});

test("G-④（正向 · 同版豁免）：已确认需求重提**同一版本** ⇒ 幂等放行（零变更不属排期改动，闸与锁版同口径）", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ stage: "改造方案", approval: "已通过", version: " v0.9.2 " });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.2", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 200, "trim 后精确等串 ⇒ 同版重提放行");
      assert.equal(seen.length, 1);
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn },
    client,
  );
});

test("G-⑤（负向 · 入池/清空同样受闸）：想法之外的需求「移出排期回池」也是排期改动 ⇒ 409 同码", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ stage: "改造方案", approval: "已通过", version: "v0.9.2" });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 409);
      assert.equal(JSON.parse(await res.text()).code, "board_schedule_state_locked");
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn },
    client,
  );
  assert.deepEqual(seen, []);
});

test("G-⑥（叠加 · 互不替代）：闸锁 ∧ 目标锁版 ⇒ 版本锁先判（board_version_released）；闸不吞锁、锁不吞闸", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ stage: "改造方案", approval: "已通过", version: "v0.9.2" });
  await withServer(
    async (base) => {
      const both = await schedulePost(base, "version=v0.9.1", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(both.status, 409);
      assert.equal(JSON.parse(await both.text()).code, "board_version_released", "两把锁都在时以已发版锁作答（v0.9.2 既有语义不回退）");
      const gateOnly = await schedulePost(base, "version=v0.9.3", { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(gateOnly.status, 409);
      assert.equal(JSON.parse(await gateOnly.text()).code, "board_schedule_state_locked", "目标未锁 ⇒ 闸独立作答");
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn, releasedVersions: LOCK },
    client,
  );
  assert.deepEqual(seen, [], "两把锁一律零出网");
});

test("G-⑦（表单档）：闸拒 ⇒ 错误浮层族名「排期状态锁定」+ 目标/现版本回填", async () => {
  const { fn, seen } = fakeSchedule();
  const { client } = fakeClient({ stage: "改造方案", approval: "已通过", version: "v0.9.2" });
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.3", { origin: base });
      assert.equal(res.status, 409);
      const html = await res.text();
      assert.match(html, /<div class="err-ov"/);
      assert.match(html, /排期状态锁定/, "族名中文映射（views.ERROR_FAMILY_LABELS）");
      assert.match(html, /board_schedule_state_locked/);
      assert.match(html, /<span class="err-ov-field-label">目标版本<\/span>\s*<span class="err-ov-field-value mono">v0\.9\.3<\/span>/);
      assert.match(html, /<span class="err-ov-field-label">现版本<\/span>\s*<span class="err-ov-field-value mono">v0\.9\.2<\/span>/);
    },
    { defaultGroup: "g", scheduleFeatureImpl: fn },
    client,
  );
  assert.deepEqual(seen, []);
});
