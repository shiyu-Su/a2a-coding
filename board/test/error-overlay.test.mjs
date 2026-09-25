/**
 * REQ-v0.9.1-2026-09-25-03 板侧错误提示弹窗化 —— 专项用例（离线）。
 *
 * 覆盖改造文档 §4 判据：
 * - ① 表单档（无 `Accept: application/json`）触发 A1–A10 任一失败 ⇒ `text/html` +
 *   中文族名 + error 正文 + mono code +「知道了」，**无裸 JSON**；
 * - ② JSON 档负向守卫：同请求带 `Accept: application/json` ⇒ `{ok:false,code,error}` 与现状同形；
 * - ③ 浮层渲染转义：error 含 `<script>` 片段时断言被转义。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createBoardServer } from "../dist/server.js";
import { parseRequirementForm } from "../dist/write-guard.js";
import { errorFamilyLabel } from "../dist/web/views.js";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const MAX_BODY = 256 * 1024; // write-guard.MAX_REQUIREMENT_BODY_BYTES

function fakeClient() {
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features: [], stateCounts: null };
    },
    async getFeature(featureId) {
      return {
        feature: {
          featureId,
          state: "executing",
          title: "需求甲",
          ownerGroup: "g",
          stage: "改造方案",
          version: "v0.9.1",
          approval: "已通过",
          createdAt: "c",
          updatedAt: "u",
        },
        tasks: [],
      };
    },
    async getFeatureTrace() {
      throw new Error("trace 不可用（假）");
    },
    async getProjects() {
      throw new Error("不该被本文件触达");
    },
    async getTasks() {
      throw new Error("不该被本文件触达");
    },
  };
}

function fakeFace() {
  return {
    async triggerTurn() {
      throw new Error("不该被本文件触达");
    },
    async confirmTurn() {
      throw new Error("不该被本文件触达");
    },
    async answerRequirement() {
      throw new Error("不该被本文件触达");
    },
    awaitingTurnOf() {
      return null;
    },
    busyTurnOf() {
      return null;
    },
    async statusView() {
      return [];
    },
    configView() {
      return { orgsDir: null, defaultOrg: null, kind: "（假）" };
    },
    orgsDirProblem() {
      return null;
    },
    async stopBridge() {
      return null;
    },
  };
}

async function withServer(run, serverOptions = {}) {
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: fakeClient(),
    now: () => NOW,
    defaultGroup: "g",
    hostFace: fakeFace(),
    ...serverOptions,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

async function req(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, options);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const WRITE_HEADERS = { "x-board-write": "1" };
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

function postReq(base, fields, headers = {}) {
  return req(base, "/requirements", {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM_HEADERS, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/**
 * A2/A7（请求体超限）在 HTTP 级**不可构造送达**，两档都是既有断连语义、非本需求改动面：
 * - readBodyCapped 满额：服务端写 413 后立即 `req.destroy()`，响应在写入中途被打断，
 *   任何客户端（fetch / curl / 浏览器）都收不到 —— JSON 档同样收不到（改前改后一致）；
 * - 声明长度越界但实发不越界：node HTTP 解析层对截断体直接回空体 400，到不了业务出口。
 * ⇒ 分流正确性由「同一条 respondError 出口」+ 族名映射单测 + write-guard 纯函数 413 单测共同钉住；
 *   HTTP 级浮层送达登记为未覆盖项（见 BD1 回报）。
 */

/** 表单档错误页的公共断言（判据 ①）。 */
function assertOverlayPage(res, { status, family, code, errorSnippet }) {
  assert.equal(res.status, status);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.match(res.text, /class="err-ov"/, "浮层容器必须在");
  assert.ok(res.text.includes(family), `族名标题必须上浮层：${family}`);
  assert.ok(res.text.includes(`<p class="err-ov-code mono">${code}</p>`), `mono 小字错误码：${code}`);
  assert.match(res.text, /<button type="button" id="err-ov-close">知道了<\/button>/);
  if (errorSnippet !== undefined) {
    assert.ok(res.text.includes(errorSnippet), `error 正文须上浮层：${errorSnippet}`);
  }
  // 无裸 JSON：JSON 错误体字面量不得出现在表单档响应里
  assert.doesNotMatch(res.text, /"ok":false,"code":/);
}

// ---------------------------------------------------------------------------
// 判据 ①：A1–A8 / A10 表单档 ⇒ HTML 浮层页
// ---------------------------------------------------------------------------

test("BD20-①A1：提需求 CSRF 拒绝（表单档）⇒ 403 浮层页（CSRF 族名 + code + 知道了），无裸 JSON", async () => {
  await withServer(async (base) => {
    const cross = await postReq(base, { title: "甲", version: "v1" }, { origin: "http://evil.example" });
    assertOverlayPage(cross, { status: 403, family: "CSRF 来源校验拒绝", code: "write_guard_origin" });
    assert.match(cross.text, /已按 CSRF 拒绝/, "error 正文 = 守卫文案");
  });
});

test("BD20-①A2/A7：请求体超限档 ⇒ 413 + payload_too_large 走同一 respondError 出口（族名 = 请求体超限）", async () => {
  // 该档的 HTTP 级送达不可构造：readBodyCapped 满额即 reject，出口处 `req.destroy()` 抢在响应
  // flush 前打断连接（改前 JSON 档同样收不到，属既有断连语义）；声明长度越界 + 实发截断则被
  // node 解析层直接回空体 400。故此处钉「喂给出口的数据」：状态码/码/族名三件套与整页渲染一致。
  const form = parseRequirementForm("title=甲&version=v1", MAX_BODY + 1, "g");
  assert.equal(form.ok, false);
  assert.equal(form.status, 413);
  assert.equal(form.code, "payload_too_large");
  assert.equal(errorFamilyLabel(form.code), "请求体超限");
  // 同一出口渲染（errorPage）已由 A1/A3/A4/A5/A6/A8/A10 各档覆盖，此处不重复起服务。
});

test("BD20-①A3：表单字段校验失败（表单档）⇒ 400 浮层页（表单字段校验失败族 + error 正文）", async () => {
  await withServer(async (base) => {
    const res = await postReq(base, { title: "   ", version: "v1" }, WRITE_HEADERS);
    assertOverlayPage(res, {
      status: 400,
      family: "表单字段校验失败",
      code: "requirement_form_invalid",
      errorSnippet: "必填字段为空",
    });
  });
});

test("BD20-①A4：MCP 调用失败（表单档）⇒ 502 浮层页；桥原始 JSON 文本转义后进正文", async () => {
  const fn = async () => ({
    ok: false,
    code: "http_502",
    error: '桥返回 HTTP 502：{"ok":false,"code":"project_not_found"}',
  });
  await withServer(
    async (base) => {
      const res = await postReq(base, { title: "甲", version: "v1" }, { ...WRITE_HEADERS, group: "g" });
      assertOverlayPage(res, {
        status: 502,
        family: "桥调用错误",
        code: "http_502",
        errorSnippet: "project_not_found",
      });
    },
    { createRequirementImpl: fn },
  );
});

test("BD20-①A5/A6：宿主面写门出口（表单档）⇒ 403 / 503 浮层页（A7 与 A2 同出口，HTTP 档见注）", async () => {
  // A5：CSRF 拒绝（hostWriteGate）
  await withServer(async (base) => {
    const res = await req(base, "/features/F1/confirm", {
      method: "POST",
      headers: { origin: "http://evil.example" },
      body: "",
    });
    assertOverlayPage(res, { status: 403, family: "CSRF 来源校验拒绝", code: "write_guard_origin" });
  });
  // A6：宿主面未装配（hostFace = null）
  await withServer(
    async (base) => {
      const res = await req(base, "/features/F1/confirm", { method: "POST", headers: WRITE_HEADERS, body: "" });
      assertOverlayPage(res, { status: 503, family: "宿主面未装配", code: "host_face_disabled" });
    },
    { hostFace: null },
  );
  // A7：宿主写门请求体档 —— 与 A2 共用同一条 respondError 出口（同 status/code 语义）；
  // readBodyCapped 满额断连那一档 413 在写入中途被 req.destroy 打断（任何客户端收不到，
  // 属既有断连语义、非本需求改动面）⇒ HTTP 级送达登记为未覆盖项（见 BD1 回报）。
});

test("BD20-①A8：澄清回答为空（表单档）⇒ 400 浮层页（参数校验失败族）", async () => {
  await withServer(async (base) => {
    const res = await req(base, "/features/F1/answer", {
      method: "POST",
      headers: { ...FORM_HEADERS, ...WRITE_HEADERS },
      body: "answer=",
    });
    assertOverlayPage(res, {
      status: 400,
      family: "参数校验失败",
      code: "answer_empty",
      errorSnippet: "回答内容为空",
    });
  });
});

test("BD20-①A10：未知路径 / 方法门（表单档）⇒ 404 / 405 浮层页；405 文案保留写路径清单", async () => {
  await withServer(async (base) => {
    const nf = await req(base, "/nope");
    assertOverlayPage(nf, { status: 404, family: "未知路径", code: "not_found", errorSnippet: "未知路径 /nope" });
    const postRoot = await req(base, "/", { method: "POST" });
    assertOverlayPage(postRoot, { status: 405, family: "方法不允许", code: "method_not_allowed" });
    assert.match(postRoot.text, /仅支持 GET/, "405 文案（含写路径清单）保留在正文");
  });
});

test("BD20-①A9：未捕获异常档（respondError 500）表单 ⇒ 系统异常浮层；JSON ⇒ 结构化 500 不变", async () => {
  // handle() 外层 try 覆盖了全部渲染路径，真机 500 需渲染器抛错才可达；此处直钉 respondError
  // 的 A9 两档语义经公开面复用：同 errorPage 渲染 + 同 wantsJson 判据（与 A1–A8 共用一条出口），
  // 以族名映射 + 既有出口断言覆盖；未捕获路径本身的负向守卫见 test/server.test.mjs「500 不静默」。
  assert.equal(errorFamilyLabel("internal_error"), "系统异常");
});

// ---------------------------------------------------------------------------
// 判据 ②：JSON 档负向守卫（同请求带 Accept: application/json ⇒ 形状与现状同形）
// ---------------------------------------------------------------------------

test("BD20-②：A1/A3/A4/A6/A8/A10 带 JSON accept ⇒ 结构化 {ok:false,code,error} 同形、无浮层", async () => {
  const JSON_ACCEPT = { accept: "application/json" };
  await withServer(
    async (base) => {
      const shape = (json) => {
        assert.deepEqual(Object.keys(json).sort(), ["code", "error", "ok"]);
        assert.equal(json.ok, false);
      };
      const a1 = await postReq(base, { title: "甲", version: "v1" }, { ...JSON_ACCEPT });
      assert.equal(a1.status, 403);
      const a1j = JSON.parse(a1.text);
      shape(a1j);
      assert.equal(a1j.code, "write_guard_origin_unknown");

      const a3 = await postReq(base, { title: "  ", version: "v1" }, { ...WRITE_HEADERS, ...JSON_ACCEPT });
      assert.equal(a3.status, 400);
      const a3j = JSON.parse(a3.text);
      shape(a3j);
      assert.equal(a3j.code, "requirement_form_invalid");
      assert.match(a3j.error, /必填字段为空/);

      const a6 = await req(base, "/features/F1/confirm", {
        method: "POST",
        headers: { ...WRITE_HEADERS, ...JSON_ACCEPT },
        body: "",
      });
      assert.equal(a6.status, 503);
      const a6j = JSON.parse(a6.text);
      shape(a6j);
      assert.equal(a6j.code, "host_face_disabled");

      const a10 = await req(base, "/nope", { headers: JSON_ACCEPT });
      assert.equal(a10.status, 404);
      const a10j = JSON.parse(a10.text);
      shape(a10j);
      assert.equal(a10j.error, "未知路径 /nope");

      const a10m = await req(base, "/", { method: "POST", headers: JSON_ACCEPT });
      assert.equal(a10m.status, 405);
      assert.equal(JSON.parse(a10m.text).code, "method_not_allowed");
    },
    { hostFace: null },
  );
  // A4（JSON 档）
  const fn = async () => ({ ok: false, code: "transport_error", error: "连接被重置" });
  await withServer(
    async (base) => {
      const res = await postReq(base, { title: "甲", version: "v1" }, { ...WRITE_HEADERS, ...JSON_ACCEPT });
      assert.equal(res.status, 502);
      assert.deepEqual(JSON.parse(res.text), { ok: false, code: "transport_error", error: "连接被重置" });
      assert.doesNotMatch(res.text, /err-ov/, "JSON 档不得带浮层");
      // A8（JSON 档）：本服务宿主面已装配 ⇒ 过闸后落 answer_empty 400
      const a8 = await req(base, "/features/F1/answer", {
        method: "POST",
        headers: { ...WRITE_HEADERS, ...JSON_ACCEPT },
        body: "answer=",
      });
      assert.equal(a8.status, 400);
      assert.deepEqual(JSON.parse(a8.text), {
        ok: false,
        code: "answer_empty",
        error: "回答内容为空（不得静默提交；澄清回答必须有内容）",
      });
    },
    { createRequirementImpl: fn },
  );
});

// ---------------------------------------------------------------------------
// 判据 ③：浮层渲染转义
// ---------------------------------------------------------------------------

test("BD20-③：error 值含 <script> 片段 ⇒ 浮层正文全转义，不产生可执行脚本", async () => {
  const evil = "<script>alert(1)</script>";
  const fn = async () => ({ ok: false, code: "response_invalid", error: `桥响应异常：${evil}` });
  await withServer(
    async (base) => {
      const res = await postReq(base, { title: "甲", version: "v1" }, WRITE_HEADERS);
      assert.equal(res.status, 502);
      assert.ok(res.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "error 必须转义后渲染");
      assert.ok(!res.text.includes(evil), "原始 <script>…</script> 片段不得出现在响应里");
      assert.match(res.text, /桥调用错误/);
      assert.ok(res.text.includes('<p class="err-ov-code mono">response_invalid</p>'));
    },
    { createRequirementImpl: fn },
  );
});

// ---------------------------------------------------------------------------
// 族名映射（无命中回退原文 code；动态前缀 jsonrpc_* / http_*）
// ---------------------------------------------------------------------------

test("BD20-族名：精确表 + 前缀命中；无命中回退原文 code（不吞不猜）", () => {
  assert.equal(errorFamilyLabel("write_guard_origin"), "CSRF 来源校验拒绝");
  assert.equal(errorFamilyLabel("write_guard_origin_unknown"), "CSRF 来源不可判定");
  assert.equal(errorFamilyLabel("requirement_form_invalid"), "表单字段校验失败");
  assert.equal(errorFamilyLabel("board_group_required"), "表单字段校验失败");
  assert.equal(errorFamilyLabel("payload_too_large"), "请求体超限");
  assert.equal(errorFamilyLabel("host_face_disabled"), "宿主面未装配");
  assert.equal(errorFamilyLabel("answer_empty"), "参数校验失败");
  assert.equal(errorFamilyLabel("internal_error"), "系统异常");
  assert.equal(errorFamilyLabel("not_found"), "未知路径");
  assert.equal(errorFamilyLabel("method_not_allowed"), "方法不允许");
  assert.equal(errorFamilyLabel("bad_url"), "请求不合法");
  assert.equal(errorFamilyLabel("jsonrpc_-32601"), "桥调用错误");
  assert.equal(errorFamilyLabel("http_502"), "桥调用错误");
  assert.equal(errorFamilyLabel("some_future_code"), "some_future_code", "无命中必须回退原文 code");
});
