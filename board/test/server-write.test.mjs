import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * 已发版锁夹具（v0.9.4 N3）：`releasedVersions` 已退役出服务端配置（运行时锁改读版本台账）
 * ⇒ 测试把「这些版本已发版」预置为临时台账文件喂入（`versionsLedgerFile`）。
 * **恒注入**（未声明锁版时喂空台账）：否则缺省会读开发机真实 `.data/versions.json`，锁随本机状态漂移。
 * **v0.9.6 B3**：条目唯一键 = `(org, version)` ⇒ 夹具带 `org` 档（缺省空串 = 未归属桶，
 * 不锁任何具名组织的写口）；要撞锁的用例按提需求实际归属档传 `releasedOrg`。
 * 单项也可写成 `{ org, version }`（同一本台账里跨组织布条目，见 N2-⑧）。
 */
function releasedLedgerFixture(versions = [], org = "") {
  const dir = mkdtempSync(join(tmpdir(), "board-locked-"));
  const file = join(dir, "versions.json");
  const entries = versions.map((raw) => {
    const pair = typeof raw === "object" && raw !== null ? raw : { org, version: String(raw) };
    return {
      org: pair.org ?? "",
      version: String(pair.version).trim(),
      status: "released",
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
      note: null,
    };
  });
  writeFileSync(file, JSON.stringify({ version: 2, versions: entries }, null, 2) + "\n", "utf8");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withServer(run, serverOptions = {}) {
  const { client, calls } = fakeClient();
  const { releasedVersions, releasedOrg, ...rest } = serverOptions;
  const seed = releasedLedgerFixture(releasedVersions ?? [], releasedOrg ?? "");
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    ...rest,
    versionsLedgerFile: seed.file,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, calls);
  } finally {
    await handle.close();
    seed.cleanup();
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
      const res = await post(base, { title: "甲", version: "v0.9.0" }, { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 201);
      assert.equal(JSON.parse(res.text).group, "board-default-org");
      const viaBlank = await post(base, { title: "乙", version: "v0.9.0", group: "  " }, { ...WRITE_HEADERS, accept: "application/json" });
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
      const viaForm = await post(base, { title: "甲", version: "v0.9.0" }, { origin: base });
      assert.equal(viaForm.status, 303);
      assert.equal(viaForm.headers.get("location"), "/features/F-42");
      assert.equal(viaForm.headers.get("cache-control"), "no-store");
      const viaApi = await post(base, { title: "甲", version: "v0.9.0" }, { ...WRITE_HEADERS, accept: "application/json" });
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
        const res = await post(base, { title: "甲", version: "v0.9.0" }, { ...WRITE_HEADERS, accept: "application/json" });
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
// ④ 空 title ⇒ 400（且不出网）；M6 起空 version 合法（未排期）⇒ 建卡成功
// ---------------------------------------------------------------------------

test("BD7-④（负向 · M6 收敛为仅 title 必填）：空 title ⇒ 400 结构化，校验先于写封装（不静默创建）", async () => {
  const { fn, seen } = fakeCreate();
  for (const fields of [{ title: "   ", version: "v1" }, { title: "  " }]) {
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

test("M6：空 version 建卡成功（未排期）；出网 version 已 trim（空白不落「空格列」）", async () => {
  const { fn, captured } = realCreateCapturing(
    okEnvelope({ ok: true, featureId: "F-Pool", state: "waiting_approval", stage: "需求分析", version: "", approval: "未发起" }),
  );
  await withServer(
    async (base) => {
      const missing = await post(base, { title: "进池需求" }, { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(missing.status, 201, "version 键缺失 ⇒ 合法（未排期）");
      const blank = await post(base, { title: "进池需求乙", version: "   " }, { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(blank.status, 201, "纯空白 version ⇒ 合法，不再 400");
      assert.equal(JSON.parse(blank.text).featureId, "F-Pool");
    },
    { defaultGroup: "g", mcpBaseUrl: "http://127.0.0.1:8787", createRequirementImpl: fn },
  );
  const argsMissing = captured.bodies[0].params.arguments;
  assert.equal(argsMissing.version, "", "缺键归一为空串出网");
  const argsBlank = captured.bodies[1].params.arguments;
  assert.equal(argsBlank.version, "", "空 version 发送前 trim ⇒ 空串（orch 无 trim，空白会自成一列）");
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
      const getOnWritePath = await fetch(`${base}/requirements`, { method: "GET", redirect: "manual" });
      // REQ-2026-09-26-04 Q2：同路径双义已终结 —— GET = 303 回首页（列表页退役），POST 仍是提需求写面
      assert.equal(getOnWritePath.status, 303, "GET /requirements = 303 回首页");
      assert.equal(getOnWritePath.headers.get("location"), "/");
      await getOnWritePath.body?.cancel();
      const putOnWritePath = await req(base, "/requirements", { method: "PUT" });
      assert.equal(putOnWritePath.status, 405, "退役路径的其它方法不放开（只认 POST），落读面方法门 ⇒ 405");
      assert.deepEqual(calls, [], "GET 重定向与 405 均不触桥（写面方法门判定本身不触桥）");
    },
    { defaultGroup: "g" },
  );
});

// ---------------------------------------------------------------------------
// BD11-⑥（负向锚）：组织名进表单**没有**顺手开出状态机写口
// ---------------------------------------------------------------------------

test("BD11-⑥（负向锚）：板不写状态机迁移 —— approve/cancel 零引用、advance 收敛于排期封装、写面白名单不含状态机口", async () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const walk = (dir, acc = []) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full, acc);
      else if (ent.name.endsWith(".ts")) acc.push(full);
    }
    return acc;
  };
  // v0.9.2 新口径：排期写借 advance「to=当前态 ∧ 仅 version」特例，收敛于唯一封装 feature-schedule.ts；
  // approve / cancel 两个真·迁移工具名仍须 0 命中，advance 命中只允许出现在该白名单文件。
  const stateMachineTools = ["a2a_feature_approve", "a2a_feature_cancel"];
  const ADVANCE_WHITELIST_BASENAME = "feature-schedule.ts";
  let smHits = 0;
  const advanceOffenders = [];
  const files = walk(srcDir);
  assert.ok(files.length > 0, "应能枚举 src 下 .ts 文件");
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const tok of stateMachineTools) smHits += text.split(tok).length - 1;
    if (text.includes("a2a_feature_advance") && !f.endsWith(ADVANCE_WHITELIST_BASENAME)) {
      advanceOffenders.push(f.replace(srcDir, "").split(/[\\/]/).join("/"));
    }
  }
  assert.equal(smHits, 0, "板不写状态机迁移：approve / cancel 在 src/** 出现次数必须为 0");
  assert.deepEqual(advanceOffenders, [], "a2a_feature_advance 只能出现在 feature-schedule.ts（排期写唯一封装）");

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

test("BD7-⑦（BD11 反转 · B5a 重指空间排期页）：提需求表单在看板上的**空间免选**档（全局档表单已无 HTTP 宿主，字段形状钉在 web.test BD8/BD11）；只读渲染与 CSP 均未变", async () => {
  // B5a 起看板唯一宿主 = `/org/<名>/schedule` ⇒ 页面上那枚表单恒为 BD8 免选形态（组织由路径决定）
  await withServer(async (base, calls) => {
    const res = await req(base, "/org/g/schedule");
    assert.equal(res.status, 200);
    assert.match(res.text, /<form method="post" action="\/org\/g\/requirements"/, "action 带空间前缀（写面仍归一到 POST /requirements）");
    assert.match(res.text, /name="title"/);
    assert.match(res.text, /name="version"/);
    assert.match(res.text, /name="requirement"/);
    assert.match(res.text, /<input type="hidden" name="group" value="g">/, "组织名不进可编辑字段：hidden 值必发");
    assert.doesNotMatch(res.text, /<input name="group"/, "空间页不出可编辑组织输入（必填/留空两档归单元面）");
    assert.match(res.text, /board_org_mismatch/, "mismatch 执法提示在表单内");
    // N3：本文件默认未装配宿主面 ⇒ 提需求表单旁如实标 orgsDir 未装配
    assert.match(res.text, /组织目录根（orgsDir）未装配/);
    // 收口轨 14：页面引入**同源内联脚本**（提交守卫等，无外源 src=）；
    // 增补② 起排期页另挂**同源 vendored** 资产（/static/mermaid.min.js，浮层换入依赖图补渲）⇒
    // 「零 src=」放宽为「src= 只许同源相对 /static/」，外源仍封死（CSP script-src 两档 + 下方主机面断言）。
    assert.match(res.text, /<script>/);
    for (const m of res.text.matchAll(/<script[^>]*src="([^"]*)"/g)) {
      assert.match(m[1], /^\/static\//, `src= 只许同源 /static/（实际 ${m[1]}）`);
    }
    assert.doesNotMatch(res.text, /<script[^>]*src="(https?:|\/\/)/, "不得引入外源脚本");
    assert.match(res.text, /data-submit=/, "写表单须带提交守卫的就地反馈文案");
    // 既有只读渲染照旧（REQ-04 Q2：列表页退役后由排期看板承载同一份 features 读面；B5a 宿主 = 空间页）
    assert.match(res.text, /需求甲/);
    assert.match(res.text, /任务数：4/);
    assert.deepEqual(calls, ["getFeatures"]);
    // CSP（收口轨 14 + BD14 + 增补轨 2 明示口径）：default-src 仍 'none'、form-action 仍限同源；
    // script-src = 'unsafe-inline'（页面内字面量脚本）+ 'self'（同源 vendored /static 资产），
    // connect-src = 'self'（详情浮层同源 fetch），**无任何外源主机 URL**。
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.equal(
      csp,
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
      "CSP 全串单点 = layout.ts BOARD_CSP（含第三处放宽 connect-src 'self'）",
    );
    const scriptDir = /(^|;)\s*script-src([^;]*)/.exec(csp)?.[2]?.trim() ?? "";
    assert.deepEqual(scriptDir.split(/\s+/).sort(), ["'self'", "'unsafe-inline'"], "script-src 只放开内联 + 同源两档");
    assert.equal(/https?:|\/\//.test(scriptDir), false, "script-src 不得含外源");
    const connectDir = /(^|;)\s*connect-src([^;]*)/.exec(csp)?.[2]?.trim() ?? "";
    assert.deepEqual(connectDir.split(/\s+/), ["'self'"], "connect-src 只放开同源一档");
  });
  // 配了默认组织：空间页仍恒免选（板级默认提示属全局档，B5a 后无 HTTP 宿主 ⇒ 负向钉）
  await withServer(async (base) => {
    const res = await req(base, "/org/g/schedule");
    assert.match(res.text, /<input type="hidden" name="group" value="g">/, "空间档不受 defaultGroup 影响");
    assert.doesNotMatch(res.text, /留空 = 用板级默认/, "板级默认提示只在单元面钉（web.test BD11）：HTTP 面无全局档宿主");
  }, { defaultGroup: "board-default-org" });
});

test("N3（真 HTTP）：提需求表单旁 orgsDir 提示随宿主面状态三档渲染（就绪 / 配了但不可用）", async () => {
  const faceWith = (orgsDir, problem) => ({
    configView: () => ({ orgsDir, defaultOrg: null, kind: "claude" }),
    orgsDirProblem: () => problem,
  });
  await withServer(async (base) => {
    const res = await req(base, "/");
    assert.equal(res.status, 200);
    assert.match(res.text, /组织目录根（orgsDir）<b>就绪<\/b>/);
    assert.match(res.text, /C:\/orgs\/live/);
  }, { hostFace: faceWith("C:/orgs/live", null) });
  await withServer(async (base) => {
    const res = await req(base, "/");
    assert.match(res.text, /class="hint err"/, "不可用档须走红字错误样式");
    assert.match(res.text, /board_orgs_dir_missing/);
    assert.match(res.text, /组织目录根不存在：C:\\orgs\\gone/);
  }, {
    hostFace: faceWith("C:/orgs/gone", {
      code: "board_orgs_dir_missing",
      message: "组织目录根不存在：C:\\orgs\\gone ⇒ 任何组织的宿主桥都无落点，不 spawn 进程。",
    }),
  });
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
      assert.equal(seen.length, 1);
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

// ---------------------------------------------------------------------------
// 增补 ⑤ N2：提需求执法 —— 已发版锁版（config releasedVersions）⇒ 409 board_version_released
// ---------------------------------------------------------------------------

test("N2-①（负向 · API 档）：锁版排入 ⇒ 409 board_version_released，文案含版本号与「不可排入」，零出网", async () => {
  const { fn, seen } = fakeCreate();
  await withServer(
    async (base) => {
      const res = await post(
        base,
        { group: "g", title: "往已发版排", version: "v0.9.1", requirement: "原文" },
        { ...WRITE_HEADERS, accept: "application/json" },
      );
      assert.equal(res.status, 409);
      const json = JSON.parse(res.text);
      assert.equal(json.ok, false);
      assert.equal(json.code, "board_version_released");
      assert.match(json.error, /v0\.9\.1/, "文案须点明被锁的版本号");
      assert.match(json.error, /已发版版本不可排入新需求/);
      assert.equal(seen.length, 0, "锁校验必须先于写封装（零出网）");
    },
    { defaultGroup: null, createRequirementImpl: fn, releasedVersions: ["v0.9.1"], releasedOrg: "g" },
  );
});

test("N2-②（负向 · 表单档）：锁版排入 ⇒ 409 错误浮层（族名「版本已发版锁定」+ code）+ 提交字段回填", async () => {
  const { fn, seen } = fakeCreate();
  await withServer(
    async (base) => {
      const res = await post(base, { group: "flow", title: "队列可见", version: "v0.9.1", requirement: "文案回填" }, { origin: base });
      assert.equal(res.status, 409);
      assert.match(res.text, /<div class="err-ov"/, "表单档须走错误浮层，不裸 JSON");
      assert.match(res.text, /版本已发版锁定/, "族名须有中文映射（views.ERROR_FAMILY_LABELS）");
      assert.match(res.text, /board_version_released/);
      assert.doesNotMatch(res.text, /"code":"board_version_released"/, "表单档不得残留裸 JSON");
      // 回填：组织 / 标题 / 版本 / 需求描述 原值带回（与 requirementBackfillFields 同字段集）
      const field = (label, value) =>
        new RegExp(
          `<span class="err-ov-field-label">${label}</span>\\s*<span class="err-ov-field-value mono">${value}</span>`,
        );
      assert.match(res.text, field("组织", "flow"));
      assert.match(res.text, field("标题", "队列可见"));
      assert.match(res.text, field("版本", "v0\\.9\\.1"));
      assert.match(res.text, field("需求描述", "文案回填"));
      assert.equal(seen.length, 0);
    },
    { defaultGroup: null, createRequirementImpl: fn, releasedVersions: ["v0.9.1"], releasedOrg: "flow" },
  );
});

test("N2-③（正向）：未锁版本照常放行（201）；锁表存在不影响其它版排期", async () => {
  const { fn, seen } = fakeCreate();
  await withServer(
    async (base) => {
      const res = await post(
        base,
        { title: "往在制版排", version: "v0.9.2" },
        { ...WRITE_HEADERS, accept: "application/json" },
      );
      assert.equal(res.status, 201);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].input.version, "v0.9.2");
    },
    { defaultGroup: "g", createRequirementImpl: fn, releasedVersions: ["v0.9.0", "v0.9.1"], releasedOrg: "g" },
  );
});

test("N2-④（正向 · 不扩拦）：空 version（键缺失 / 纯空白）在未排期池放行 —— 锁不拦空", async () => {
  const { fn, seen } = fakeCreate();
  await withServer(
    async (base) => {
      const missing = await post(base, { title: "进池甲" }, { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(missing.status, 201, "version 键缺失 = 未排期 ⇒ 恒不锁");
      const blank = await post(base, { title: "进池乙", version: "   " }, { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(blank.status, 201, "纯空白 version trim 后 = 空串 ⇒ 恒不锁");
      assert.equal(seen.length, 2);
    },
    { defaultGroup: "g", createRequirementImpl: fn, releasedVersions: ["v0.9.1"], releasedOrg: "g" },
  );
});

test("N2-⑤（锁判据边界）：前后空白仍锁（trim 全等）；近似串不前缀连坐（v0.9.1-probe / 子串放行）", async () => {
  const { fn, seen } = fakeCreate();
  await withServer(
    async (base) => {
      const spaced = await post(
        base,
        { title: "带空白", version: "  v0.9.1  " },
        { ...WRITE_HEADERS, accept: "application/json" },
      );
      assert.equal(spaced.status, 409, "表单值先 trim 再判锁（parseRequirementForm 已 trim）");
      const probe = await post(
        base,
        { title: "探针版", version: "v0.9.1-probe" },
        { ...WRITE_HEADERS, accept: "application/json" },
      );
      assert.equal(probe.status, 201, "禁前缀匹配：v0.9.1 已发版不得连坐 v0.9.1-probe");
      const partial = await post(
        base,
        { title: "半截版", version: "v0.9" },
        { ...WRITE_HEADERS, accept: "application/json" },
      );
      assert.equal(partial.status, 201, "禁子串匹配：锁表元素与提交值都必须全等");
      assert.equal(seen.length, 2);
    },
    { defaultGroup: "g", createRequirementImpl: fn, releasedVersions: [" v0.9.1 ", "v0.9.0"], releasedOrg: "g" },
  );
});

test("N2-⑥（校验顺序锚）：锁校验排在 CSRF / 入参校验之后 —— 未认证与空 title 不因锁版改判", async () => {
  const { fn, seen } = fakeCreate();
  await withServer(
    async (base) => {
      const unauthed = await post(base, { title: "甲", version: "v0.9.1" });
      assert.equal(unauthed.status, 403, "CSRF 守卫先于一切（锁版不提前暴露配置）");
      const noTitle = await post(
        base,
        { title: "   ", version: "v0.9.1" },
        { ...WRITE_HEADERS, accept: "application/json" },
      );
      assert.equal(noTitle.status, 400, "入参校验先于锁校验");
      assert.equal(JSON.parse(noTitle.text).code, "requirement_form_invalid");
      assert.equal(seen.length, 0);
    },
    { defaultGroup: "g", createRequirementImpl: fn, releasedVersions: ["v0.9.1"], releasedOrg: "g" },
  );
});

/**
 * **REQ-2026-09-28-07 · v0.9.6 B3（版本切片读面 · 口径 29）**：提需求写口的锁按组织切 ——
 * 台账唯一键 `(org, version)` ⇒ 锁的 org 维 = 三段回退 `spaceOrg ?? form.group ?? ctx.write.defaultGroup`
 * （全局档 = 表单组织，未填才落板级默认）。验收④「两组织同版号互不可见互不锁」的写口那一半。
 */
test("N2-⑦（v0.9.6 B3 · 组织切片）：同版号只锁该组织 —— alpha released ⇒ alpha 撞 409、beta 照常 201", async () => {
  const { fn, seen } = fakeCreate();
  await withServer(
    async (base) => {
      const hit = await post(
        base,
        { group: "alpha", title: "撞本组织锁", version: "v0.9.1" },
        { ...WRITE_HEADERS, accept: "application/json" },
      );
      assert.equal(hit.status, 409, "同组织同版号 ⇒ 锁照常执法");
      assert.equal(JSON.parse(hit.text).code, "board_version_released");
      const other = await post(
        base,
        { group: "beta", title: "他组织同版号", version: "v0.9.1" },
        { ...WRITE_HEADERS, accept: "application/json" },
      );
      assert.equal(other.status, 201, "他组织的 released 不锁本组织（切片读面）");
      assert.equal(seen.length, 1, "仅放行的一条触达写封装");
      assert.equal(seen[0].options.group, "beta");
    },
    { defaultGroup: "alpha", createRequirementImpl: fn, releasedVersions: ["v0.9.1"], releasedOrg: "alpha" },
  );
});

test("N2-⑧（v0.9.6 B3 · 三段回退档）：表单未填组织 ⇒ 锁随板级默认档走（回落档不是免锁档）", async () => {
  const { fn, seen } = fakeCreate();
  await withServer(
    async (base) => {
      const miss = await post(
        base,
        { title: "回落默认组织", version: "v0.9.1" },
        { ...WRITE_HEADERS, accept: "application/json" },
      );
      assert.equal(miss.status, 201, "released 条目挂在 he-org 名下 ⇒ 不锁板级默认组织的同版号");
      const hit = await post(
        base,
        { title: "撞默认组织自己的锁", version: "v0.9.0" },
        { ...WRITE_HEADERS, accept: "application/json" },
      );
      assert.equal(hit.status, 409, "板级默认组织自己名下 released ⇒ 仍 409（回落档照常执法）");
      assert.equal(JSON.parse(hit.text).code, "board_version_released");
      assert.equal(seen.length, 1, "只有放行的一条触达写封装");
      assert.equal(seen[0].input.version, "v0.9.1");
    },
    {
      defaultGroup: "g",
      createRequirementImpl: fn,
      releasedVersions: [{ org: "he-org", version: "v0.9.1" }, { org: "g", version: "v0.9.0" }],
    },
  );
});

test("N2-⑦（缺省不锁）：未注入 releasedVersions ⇒ 任何版本都可排入（config 未登记 = 无锁，行为逐字节同旧）", async () => {
  const { fn, seen } = fakeCreate();
  await withServer(
    async (base) => {
      const res = await post(base, { title: "甲", version: "v0.9.1" }, { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(res.status, 201);
      assert.equal(seen.length, 1);
    },
    { defaultGroup: "g", createRequirementImpl: fn },
  );
});

// ---------------------------------------------------------------------------
// v0.9.4 N4 semver 收口（HTTP 面 · 提需求）：非法 version ⇒ 400 零出网；空串放行（未排期）
// ---------------------------------------------------------------------------

test("N4-①（提需求 semver 收口）：非法 version ⇒ 400 requirement_form_invalid 且零出网；空串 = 未排期放行", async () => {
  const { fn, captured } = realCreateCapturing(
    okEnvelope({ ok: true, featureId: "F-N4", state: "waiting_approval", version: "v0.9.4" }),
  );
  await withServer(
    async (base) => {
      for (const bad of ["v0.9.1-probe", "v0.9", "latest"]) {
        const res = await post(base, { title: "探针", version: bad }, { ...WRITE_HEADERS, accept: "application/json" });
        assert.equal(res.status, 400, `${bad} 应被拒`);
        assert.equal(JSON.parse(res.text).code, "requirement_form_invalid");
      }
      assert.deepEqual(captured.bodies, [], "非法版本先于网络被拒（零出网）");
      // 空串 = 未排期 ⇒ 放行（走真实封装 + 注入 fetch）
      const ok = await post(base, { title: "进池", version: "" }, { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(ok.status, 201);
      assert.equal(captured.bodies[0].params.arguments.version, "");
    },
    { defaultGroup: "g", createRequirementImpl: fn },
  );
});
