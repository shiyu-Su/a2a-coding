import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBoardServer } from "../dist/server.js";
import { createRequirement } from "../dist/requirement.js";
import { parseWriteRoute } from "../dist/write-guard.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

/** 只读面假客户端（本文件只用到 getFeatures）。 */
function fakeClient() {
  const calls = [];
  return {
    calls,
    client: {
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
      async getFeature() {
        throw new Error("不该被写面用例触达");
      },
      async getFeatureTrace() {
        throw new Error("不该被写面用例触达");
      },
      async getProjects() {
        throw new Error("不该被写面用例触达");
      },
      async getTasks() {
        throw new Error("不该被写面用例触达");
      },
    },
  };
}

async function withServer(run, serverOptions = {}) {
  const { client, calls } = fakeClient();
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    ...serverOptions,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, calls);
  } finally {
    await handle.close();
  }
}

async function req(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, options);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

/** 守卫头（API 档）与表单档（同源 Origin、零 JS）。 */
const WRITE_HEADERS = { "x-board-write": "1" };
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

function post(base, fields, headers = {}) {
  return req(base, "/requirements", {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM_HEADERS, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/** 假写封装：记录实收 (input, options)，返回可控结果。 */
function fakeCreate(result) {
  const seen = [];
  const fn = async (input, options) => {
    seen.push({ input, options });
    return result ?? {
      ok: true,
      featureId: "F-NEW",
      state: "waiting_approval",
      stage: "需求分析",
      version: input.version,
      approval: "未发起",
    };
  };
  return { fn, seen };
}

/** 真实 createRequirement + 注入 fetch：捕获**出网**报文（离线端到端）。 */
function realCreateCapturing(payload) {
  const captured = { urls: [], bodies: [] };
  const fn = (input, options) =>
    createRequirement(input, {
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
// ① 参数装配：组名来自**提需求表单**（BD11 反转 BD7-①）+ 恒带 stage=需求分析 / approval=未发起
// ---------------------------------------------------------------------------

test("BD11-①（反转 BD7-①）：表单组织名透传进 MCP URL 首段；出网恒带 stage=需求分析 + approval=未发起", async () => {
  const { fn, captured } = realCreateCapturing(
    okEnvelope({ ok: true, featureId: "F-9", state: "waiting_approval", stage: "需求分析", version: "v0.9.0", approval: "未发起" }),
  );
  await withServer(
    async (base) => {
      const res = await post(
        base,
        { group: "  flow-team  ", title: "板写面接线", version: "v0.9.0", requirement: "原文" },
        { ...WRITE_HEADERS, accept: "application/json" },
      );
      assert.equal(res.status, 201);
      const echoed = JSON.parse(res.text);
      assert.equal(echoed.featureId, "F-9");
      assert.equal(echoed.group, "flow-team", "201 须回显本条实际生效的组织名（归属可核对）");
      // ⭐ 断言出网 URL 含**表单所填**组名（= 身份链 S1 的落点），而不是板级默认那个组
      assert.deepEqual(captured.urls, ["http://127.0.0.1:8787/flow-team/mcp"]);
      assert.notDeepEqual(captured.urls, ["http://127.0.0.1:8787/board-cfg-group/mcp"], "板级默认不得覆盖表单所填组织名");
      const args = captured.bodies[0].params.arguments;
      assert.equal(captured.bodies[0].params.name, "a2a_feature_create");
      assert.equal(args.stage, "需求分析");
      assert.equal(args.approval, "未发起");
      assert.equal(args.version, "v0.9.0");
      assert.equal(args.title, "板写面接线");
      // 组身份仍**不进** create 的 arguments（它由 URL 首段承载，桥据此定 owner_group）
      assert.equal(args.group, undefined, "组身份只能经 MCP URL 首段传递，不得混进工具入参");
    },
    { defaultGroup: "board-cfg-group", mcpBaseUrl: "http://127.0.0.1:8787", createRequirementImpl: fn },
  );
});

// ---------------------------------------------------------------------------
// ②（负向）表单组织名空 ∧ 无板级默认 ⇒ 400 结构化（**请求期**，不再有启动期/配置期 503）
// ---------------------------------------------------------------------------

test("BD11-②（负向）：defaultGroup = null ∧ 表单不填 group ⇒ 400 board_group_required，零出网", async () => {
  const { fn, seen } = fakeCreate();
  for (const fields of [{ title: "甲", version: "v1" }, { title: "甲", version: "v1", group: "   " }]) {
    await withServer(
      async (base) => {
        const res = await post(base, fields, { ...WRITE_HEADERS, accept: "application/json" });
        assert.equal(res.status, 400, "组织名缺失是**请求期入参问题**（400），不是配置缺失（旧 503 语义已废）");
        const json = JSON.parse(res.text);
        assert.equal(json.ok, false);
        assert.equal(json.code, "board_group_required");
        assert.match(json.error, /不猜、不回落/, "文案须明示不猜组名");
        assert.match(json.error, /config\.json 的 group/, "文案须给出可照做的默认组织配置键（BD12″ 起配置只从文件读）");
      },
      { defaultGroup: null, createRequirementImpl: fn },
    );
  }
  assert.deepEqual(seen, [], "组织名未定时不得触达写封装（更不得拿兜底组名出网）");
});

// ---------------------------------------------------------------------------
// ③ 表单组织名空 ∧ 有板级默认 ⇒ 用默认
// ---------------------------------------------------------------------------

test("BD11-③：表单留空 ⇒ 回落板级默认组织；201 回显与出网 URL 首段均为该默认", async () => {
  const { fn, captured } = realCreateCapturing(okEnvelope({ ok: true, featureId: "F-3" }));
  await withServer(
    async (base) => {
      const res = await post(base, { title: "甲", version: "v1" }, { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 201);
      assert.equal(JSON.parse(res.text).group, "board-default-org");
      const viaBlank = await post(base, { title: "乙", version: "v1", group: "  " }, { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(viaBlank.status, 201, "纯空白等同未填（与配置面同口径）");
      assert.deepEqual(captured.urls, [
        "http://127.0.0.1:8787/board-default-org/mcp",
        "http://127.0.0.1:8787/board-default-org/mcp",
      ]);
    },
    { defaultGroup: "board-default-org", mcpBaseUrl: "http://127.0.0.1:8787", createRequirementImpl: fn },
  );
});

// ---------------------------------------------------------------------------
// ② 成功回显 featureId
// ---------------------------------------------------------------------------

test("BD7-②：成功回显 featureId —— 表单档 303 跳详情页（PRG），API 档 201 JSON", async () => {
  const { fn } = realCreateCapturing(okEnvelope({ ok: true, featureId: "F-42" }));
  await withServer(
    async (base) => {
      const viaForm = await post(base, { title: "甲", version: "v1" }, { origin: base });
      assert.equal(viaForm.status, 303);
      assert.equal(viaForm.headers.get("location"), "/features/F-42");
      assert.equal(viaForm.headers.get("cache-control"), "no-store");
      const viaApi = await post(base, { title: "甲", version: "v1" }, { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(viaApi.status, 201);
      const json = JSON.parse(viaApi.text);
      assert.equal(json.ok, true);
      assert.equal(json.featureId, "F-42");
    },
    { defaultGroup: "g", createRequirementImpl: fn },
  );
});

// ---------------------------------------------------------------------------
// ③ 结构化错误码透传不吞
// ---------------------------------------------------------------------------

test("BD7-③：桥错误码原样透传（feature_invalid_stage / project_not_a_member / transport_error）", async () => {
  for (const code of ["feature_invalid_stage", "project_not_a_member", "transport_error"]) {
    const { fn } = realCreateCapturing(okEnvelope({ ok: false, code, error: `透传说明-${code}` }));
    await withServer(
      async (base) => {
        const res = await post(base, { title: "甲", version: "v1" }, { ...WRITE_HEADERS, accept: "application/json" });
        assert.equal(res.status, 502);
        const json = JSON.parse(res.text);
        assert.equal(json.ok, false);
        assert.equal(json.code, code, "错误码必须原样，不得改写为通用错误");
        assert.equal(json.error, `透传说明-${code}`);
      },
      { defaultGroup: "g", createRequirementImpl: fn },
    );
  }
});

// ---------------------------------------------------------------------------
// ④ 空 title/version ⇒ 400（且不出网）
// ---------------------------------------------------------------------------

test("BD7-④（负向）：空 title / 空 version ⇒ 400 结构化，校验先于写封装（不静默创建）", async () => {
  const { fn, seen } = fakeCreate();
  for (const fields of [{ title: "   ", version: "v1" }, { title: "甲", version: "  " }, { version: "v1" }]) {
    await withServer(
      async (base) => {
        const res = await post(base, fields, { ...WRITE_HEADERS, accept: "application/json" });
        assert.equal(res.status, 400);
        const json = JSON.parse(res.text);
        assert.equal(json.ok, false);
        assert.equal(json.code, "requirement_form_invalid");
        assert.match(json.error, /必填字段为空/);
      },
      { defaultGroup: "g", createRequirementImpl: fn },
    );
  }
  assert.deepEqual(seen, [], "入参校验必须在触达写封装之前");
});

// ---------------------------------------------------------------------------
// ⑤ CSRF 防线（负向）
// ---------------------------------------------------------------------------

test("BD7-⑤（负向）：跨站 Origin ⇒ 403；无守卫头无来源 ⇒ 403；守卫头值不对也算无；同源 Origin 放行（零 JS 表单）", async () => {
  const { fn, seen } = fakeCreate();
  await withServer(
    async (base) => {
      const cross = await post(base, { title: "甲", version: "v1" }, { origin: "http://evil.example:80" });
      assert.equal(cross.status, 403);
      // 弹窗化（REQ-v0.9.1-2026-09-25-03）：表单档不再裸 JSON，错误浮层给中文族名 + 原文码
      assert.match(cross.text, /CSRF 来源校验拒绝/, "有名跨站 Origin 的族名必须上浮层");
      assert.doesNotMatch(cross.text, /"code":"write_guard_origin"/, "表单档不得残留裸 JSON");

      const wrongHeaderValue = await post(base, { title: "甲", version: "v1" }, { "x-board-write": "yes-please" });
      assert.equal(wrongHeaderValue.status, 403);
      assert.match(wrongHeaderValue.text, /CSRF 来源不可判定/);

      const noProofAtAll = await req(base, "/requirements", { method: "POST", body: "title=甲&version=v1" });
      assert.equal(noProofAtAll.status, 403);

      const sameOrigin = await post(base, { title: "甲", version: "v1" }, { origin: `${base}/`, ...WRITE_HEADERS });
      assert.equal(sameOrigin.status, 303);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].options.group, "g", "表单留空 ⇒ 写封装收到的是板级默认组织（BD11 的兜底档）");
    },
    { defaultGroup: "g", createRequirementImpl: fn },
  );
});

test("BD7-⑤b：Referer 同源档放行；Referer 跨站拒；守卫头缺失但同源端口写法差异仍算同源", async () => {
  const { fn, seen } = fakeCreate();
  await withServer(
    async (base) => {
      const host = base.replace("http://", "");
      const okReferer = await post(base, { title: "甲", version: "v1" }, { referer: `http://${host}/` });
      assert.equal(okReferer.status, 303);
      const badReferer = await post(base, { title: "甲", version: "v1" }, { referer: "http://evil.example/" });
      assert.equal(badReferer.status, 403);
      // Origin 不带显式缺省端口（浏览器行为差异）⇒ 仍判同源
      const originNoPort = await post(base, { title: "乙", version: "v1" }, { origin: base.replace(":80", "") });
      assert.equal(originNoPort.status, 303);
      assert.equal(seen.length, 2);
    },
    { defaultGroup: "g", createRequirementImpl: fn },
  );
});

test("BD7-⑤c（BD11 反转）：板级默认组织未配置不再是错误 —— 表单填了组名就照常建，只有留空才 400", async () => {
  const { fn, seen } = fakeCreate();
  // 未配默认 + 表单填了组织名 ⇒ 201（BD10 的 503 `board_group_not_configured` 语义已废）
  await withServer(
    async (base) => {
      const res = await post(base, { group: "flow-team", title: "甲", version: "v1" }, { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 201);
      assert.equal(seen[0].options.group, "flow-team");
    },
    { defaultGroup: null, createRequirementImpl: fn },
  );
  // 未配默认 + 表单留空 ⇒ 400（请求期入参问题），且 CSRF 判定仍先于组织名判定
  await withServer(
    async (base) => {
      const res = await post(base, { title: "甲", version: "v1" }, { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 400);
      assert.equal(JSON.parse(res.text).code, "board_group_required");
      const unauthed = await post(base, { title: "甲", version: "v1" }, { accept: "application/json" });
      assert.equal(unauthed.status, 403, "未认证请求不得泄露板配置状态");
    },
    { defaultGroup: "   ", createRequirementImpl: fn },
  );
  assert.equal(seen.length, 1, "以上除首个 201 外不得触达写封装（空白默认等同未配置）");
});

// ---------------------------------------------------------------------------
// BD10-②a ⇒ **已由 BD11-② 取代**（同一条负向断言按新语义重写：配置期 503 → 请求期 400）
// 原断言：`group = null ⇒ 503 board_group_not_configured，零出网`。
// 新语义：组织名缺失不再是「板未配置」（板未配默认是合法状态），而是「表单未填 ∧ 无默认」的入参问题
//        ⇒ 400 `board_group_required`；「零出网」这条断言原样保留在 BD11-②（未弱化）。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ⑥ 未放行路径的非 GET 仍 405（钉住方法门没被放宽过头）
// ---------------------------------------------------------------------------

test("BD7-⑥（负向）：读面路径的非 GET 一律仍 405；写路径只认 POST；405/404 不触桥", async () => {
  await withServer(
    async (base, calls) => {
      for (const [method, path] of [
        ["POST", "/"],
        ["POST", "/tasks"],
        ["PUT", "/features/F1"],
        ["DELETE", "/projects"],
        ["PATCH", "/features/F1"],
      ]) {
        const res = await req(base, path, { method });
        assert.equal(res.status, 405, `${method} ${path} 必须仍 405`);
        // BD8 后 405 文案改为列举三条已放开写路径（原「只读看板仅支持 GET」措辞已不成立）
        assert.match(res.text, /仅支持 GET/);
        assert.match(res.text, /\/requirements/, "405 文案须点明放开的写路径");
      }
      const getOnWritePath = await req(base, "/requirements", { method: "GET" });
      assert.equal(getOnWritePath.status, 404, "写路径不注册读面路由");
      const putOnWritePath = await req(base, "/requirements", { method: "PUT" });
      assert.equal(putOnWritePath.status, 404, "非 POST 不落 405 也不落写面（未知路径先行）");
      assert.deepEqual(calls, [], "方法门与路由判定都不得触桥");
    },
    { defaultGroup: "g" },
  );
});

// ---------------------------------------------------------------------------
// BD11-⑥（负向锚）：组织名进表单**没有**顺手开出状态机写口
// ---------------------------------------------------------------------------

test("BD11-⑥（负向锚）：板仍不写状态机 —— src/** 零引用三工具名，且写面白名单不含 approve/advance/cancel", async () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const walk = (dir, acc = []) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full, acc);
      else if (ent.name.endsWith(".ts")) acc.push(full);
    }
    return acc;
  };
  const forbidden = ["a2a_feature_approve", "a2a_feature_advance", "a2a_feature_cancel"];
  let hits = 0;
  const files = walk(srcDir);
  assert.ok(files.length > 0, "应能枚举 src 下 .ts 文件");
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const tok of forbidden) hits += text.split(tok).length - 1;
  }
  assert.equal(hits, 0, "板不写状态机：三个状态推进工具名在 src/** 出现次数必须为 0");

  // 组织名是**入参**，不是新的状态机口：五条写路径之外一律不放行
  for (const path of [
    "/requirements/approve",
    "/features/F1/approve",
    "/features/F1/advance",
    "/features/F1/cancel",
    "/host/表单组织/approve",
  ]) {
    assert.equal(parseWriteRoute("POST", path), null, `${path} 不得成为写路径`);
  }
  await withServer(
    async (base) => {
      for (const path of ["/features/F1/approve", "/features/F1/advance", "/features/F1/cancel"]) {
        const res = await req(base, path, { method: "POST", headers: WRITE_HEADERS });
        assert.equal(res.status, 404, `${path} 未知路径（连 405 都不是：写面从未注册）`);
      }
    },
    { defaultGroup: "g" },
  );
});

test("BD7-⑦（BD11 反转）：列表页表单**含**组织名字段；只读渲染与 CSP 均未变", async () => {
  // 未配默认组织 ⇒ 组织名带 required（前端便利；硬校验仍在服务端）
  await withServer(async (base, calls) => {
    const res = await req(base, "/");
    assert.equal(res.status, 200);
    assert.match(res.text, /<form method="post" action="\/requirements"/);
    assert.match(res.text, /name="title"/);
    assert.match(res.text, /name="version"/);
    assert.match(res.text, /name="requirement"/);
    assert.match(res.text, /name="group"[^>]*required/, "未配默认组织 ⇒ 表单组织名为必填");
    assert.match(res.text, /首次填写即创建该组织/, "表单须说明「首次使用该组织名 = 创建该组织」");
    // 收口轨 14：页面引入**唯一一段同源内联提交守卫**（无外源 src=）
    assert.match(res.text, /<script>/);
    assert.doesNotMatch(res.text, /<script[^>]*src=/, "不得引入外源脚本");
    assert.match(res.text, /data-submit=/, "写表单须带提交守卫的就地反馈文案");
    // 既有只读渲染照旧
    assert.match(res.text, /需求甲/);
    assert.match(res.text, /<td>4<\/td>/);
    assert.deepEqual(calls, ["getFeatures"]);
    // CSP（收口轨 14 + BD14 明示口径）：default-src 仍 'none'、form-action 仍限同源；
    // script-src = 'unsafe-inline'（页面内字面量脚本）+ 'self'（同源 vendored /static 资产），
    // **无任何外源主机 URL**。
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /form-action 'self'/);
    const scriptDir = /(^|;)\s*script-src([^;]*)/.exec(csp)?.[2]?.trim() ?? "";
    assert.deepEqual(scriptDir.split(/\s+/).sort(), ["'self'", "'unsafe-inline'"], "script-src 只放开内联 + 同源两档");
    assert.equal(/https?:|\/\//.test(scriptDir), false, "script-src 不得含外源");
  });
  // 配了默认组织 ⇒ 组织名可不填，且把默认值如实显示在字段旁（不伪装成必填）
  await withServer(async (base) => {
    const res = await req(base, "/");
    assert.match(res.text, /name="group"/);
    assert.doesNotMatch(res.text, /name="group"[^>]*required/, "有默认组织 ⇒ 该字段允许留空");
    assert.match(res.text, /留空 = 用板级默认 board-default-org/);
  }, { defaultGroup: "board-default-org" });
});

// ---------------------------------------------------------------------------
// BD17：`Referrer-Policy: same-origin` —— 响应头 + 页面 meta 同值，且不得 no-referrer
//（no-referrer 会让浏览器连同源表单提交都不发 Referer ⇒ 写面第二档兜底被板自己掐死）
// ---------------------------------------------------------------------------

test("BD17-④（正例 + 负向锚，真 HTTP）：/ 的响应头含 Referrer-Policy: same-origin，页面 HTML 无 no-referrer", async () => {
  await withServer(async (base) => {
    const res = await req(base, "/");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
    assert.match(res.text, /<meta name="referrer" content="same-origin">/);
    assert.doesNotMatch(res.text, /no-referrer/i, "页面不得出现任何 no-referrer");
    // CSP 也不得出现 referrer 指令（那会盖过 meta）
    assert.doesNotMatch(res.headers.get("content-security-policy"), /(^|;)\s*referrer\s/i);
  });
});

test("BD17-⑤（真机报障复现）Origin: null + 同源 Referer ⇒ 表单放行进入业务校验（303）；跨站 Referer 仍拒", async () => {
  const { fn, seen } = fakeCreate();
  await withServer(
    async (base) => {
      const host = base.replace("http://", "");
      const ok = await post(base, { title: "甲", version: "v1" }, { origin: "null", referer: `http://${host}/` });
      assert.equal(ok.status, 303, "两档兜底必须成立：Origin 不可用时同源 Referer 放行");
      assert.equal(seen.length, 1);
      assert.equal(seen[0].options.group, "g");
      // 不削弱 CSRF：Origin 不可用 + Referer 跨站 ⇒ 仍拒
      const evil = await post(base, { title: "乙", version: "v1" }, { origin: "null", referer: "http://evil.example/" });
      assert.equal(evil.status, 403);
      assert.match(evil.text, /CSRF 来源不可判定/);
      // 同源 meta 头不影响跨站有名 Origin 的一律拒
      const crossNamed = await post(base, { title: "丙", version: "v1" }, { origin: "http://evil.example" });
      assert.equal(crossNamed.status, 403);
      assert.match(crossNamed.text, /CSRF 来源校验拒绝/);
      assert.equal(seen.length, 1, "两条被拒请求不得触达写封装");
    },
    { defaultGroup: "g", createRequirementImpl: fn },
  );
});
