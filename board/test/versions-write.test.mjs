/**
 * v0.10.0 B2 · 引擎版本写口**纯函数**单测（改造文档 §2.3(2)/(3)）——
 * `parseVersionWriteResponse`（信封解析，绝不抛 / 绝不 fail-closed）与
 * `describeVersionWriteError`（orch_* 显示映射表；未知码原样透出）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { describeVersionWriteError, parseVersionWriteResponse } from "../dist/versions-write.js";
import { createVersionsWriteClient, ENGINE_UNREACHABLE_CODE } from "../dist/versions-write.js";

// ---------------------------------------------------------------------------
// ① 错误码显示映射表
// ---------------------------------------------------------------------------

test("B2-err-① orch_* 已知码走业务化映射", () => {
  const cases = [
    ["orch_version_exists", /已存在/],
    ["orch_version_unknown", /不在引擎版本台账/],
    ["orch_version_released_locked", /已发版/],
    ["orch_version_open_cards", /未收口/],
    ["orch_version_not_converged", /发版闸/],
    ["orch_version_invalid_shape", /x\.y\.z/],
    ["orch_version_status_invalid", /状态不合法/],
  ];
  for (const [code, re] of cases) {
    const text = describeVersionWriteError(code, "引擎原文（不该被采用）");
    assert.match(text, re, `${code} 命中文案`);
    assert.doesNotMatch(text, /引擎原文/, `${code} 若映射命中则不落引擎原文`);
  }
});

test("B2-err-② 未知码 ⇒ 原样透出引擎文案（不 fail-closed、不吞成通用错误）", () => {
  assert.equal(describeVersionWriteError("orch_future_code", "引擎新码原文"), "引擎新码原文");
  assert.equal(describeVersionWriteError("not_found", "not_found"), "not_found");
});

test("B2-err-③ 未知码且引擎文案为空 ⇒ 兜底回显错误码本身（仍可展示）", () => {
  assert.equal(describeVersionWriteError("weird_code", "   "), "weird_code");
});

// ---------------------------------------------------------------------------
// ② 信封解析（成功 / 失败 / 非 JSON / 空体）
// ---------------------------------------------------------------------------

test("B2-parse-① 2xx + 成功信封 ⇒ 读回 version/status", () => {
  const out = parseVersionWriteResponse(
    201,
    JSON.stringify({ ok: true, version: { version: "v1.0.0", status: "notstart" } }),
  );
  assert.deepEqual(out, { ok: true, httpStatus: 201, version: "v1.0.0", status: "notstart" });
});

test("B2-parse-② remove 204 空体 ⇒ 成功档（version/status 为 null，调用方用入参）", () => {
  assert.deepEqual(parseVersionWriteResponse(204, ""), { ok: true, httpStatus: 204, version: null, status: null });
});

test("B2-parse-③ 失败信封（error 对象）⇒ 取 code/message", () => {
  const out = parseVersionWriteResponse(
    409,
    JSON.stringify({ ok: false, error: { code: "orch_version_exists", message: "重复" } }),
  );
  assert.deepEqual(out, { ok: false, httpStatus: 409, code: "orch_version_exists", message: "重复" });
});

test("B2-parse-④ 失败信封（error 为字符串，如 http.ts 兜底 404）⇒ 整串当 code 兼 message", () => {
  const out = parseVersionWriteResponse(404, JSON.stringify({ ok: false, error: "not_found" }));
  assert.deepEqual(out, { ok: false, httpStatus: 404, code: "not_found", message: "not_found" });
});

test("B2-parse-⑤ 非 JSON 错误体 ⇒ response_invalid + HTTP 码（不抛）", () => {
  const out = parseVersionWriteResponse(502, "<html>bad gateway</html>");
  assert.equal(out.ok, false);
  assert.equal(out.code, "response_invalid");
  assert.equal(out.httpStatus, 502);
  assert.match(out.message, /502/);
});

test("B2-parse-⑥ 2xx 但非 JSON / 缺 ok:true ⇒ 失败整理（不抛）", () => {
  const a = parseVersionWriteResponse(200, "not json");
  assert.equal(a.ok, false);
  assert.equal(a.code, "response_invalid");
  const b = parseVersionWriteResponse(200, JSON.stringify({ version: { version: "v1" } }));
  assert.equal(b.ok, false);
  assert.equal(b.code, "response_invalid");
});

test("B2-parse-⑦ 2xx 成功信封但缺 version 块 ⇒ 成功档、version/status 为 null", () => {
  assert.deepEqual(parseVersionWriteResponse(200, JSON.stringify({ ok: true })), {
    ok: true,
    httpStatus: 200,
    version: null,
    status: null,
  });
});

// ---------------------------------------------------------------------------
// ③ 客户端网络层（fetch 注入）：请求形状 + 传输失败硬失败
// ---------------------------------------------------------------------------

test("B2-http-① create/remove/setStatus 的 method / URL / body 形状（ownerGroup=null 全局档）", async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, method: init.method, body: init.body ?? null, contentType: init.headers["content-type"] ?? null });
    return new Response(JSON.stringify({ ok: true, version: { version: "v1.2.3", status: "notstart" } }), { status: 200 });
  };
  const client = createVersionsWriteClient({ baseUrl: "http://engine:8787/", fetchImpl: fakeFetch });
  await client.create({ ownerGroup: null, version: "v1.2.3" });
  await client.remove({ ownerGroup: "组织甲", version: "v1.2.3" });
  await client.setStatus({ ownerGroup: "组织甲", version: "v1.2.3", status: "active" });
  assert.deepEqual(seen, [
    {
      url: "http://engine:8787/api/versions",
      method: "POST",
      body: JSON.stringify({ ownerGroup: null, version: "v1.2.3" }),
      contentType: "application/json",
    },
    {
      url: `http://engine:8787/api/versions/${encodeURIComponent("v1.2.3")}?owner_group=${encodeURIComponent("组织甲")}`,
      method: "DELETE",
      body: null,
      contentType: null,
    },
    {
      url: `http://engine:8787/api/versions/${encodeURIComponent("v1.2.3")}/status`,
      method: "PATCH",
      body: JSON.stringify({ ownerGroup: "组织甲", status: "active" }),
      contentType: "application/json",
    },
  ]);
});

test("B2-http-② 全局档 remove ⇒ 不带 owner_group 查询参数（引擎匿名档 NULL）", async () => {
  let captured = null;
  const fakeFetch = async (url) => {
    captured = url;
    return new Response(null, { status: 204 });
  };
  const client = createVersionsWriteClient({ baseUrl: "http://engine:8787", fetchImpl: fakeFetch });
  const out = await client.remove({ ownerGroup: null, version: "v9.9.9" });
  assert.equal(captured, "http://engine:8787/api/versions/v9.9.9");
  assert.deepEqual(out, { ok: true, httpStatus: 204, version: null, status: null });
});

test("B2-http-③ 传输层失败（fetch 抛）⇒ 502 bridge_unreachable 硬失败（无本地兜底）", async () => {
  const fakeFetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
  };
  const client = createVersionsWriteClient({ baseUrl: "http://engine:8787", fetchImpl: fakeFetch });
  for (const out of [
    await client.create({ ownerGroup: null, version: "v1.0.0" }),
    await client.remove({ ownerGroup: null, version: "v1.0.0" }),
    await client.setStatus({ ownerGroup: null, version: "v1.0.0", status: "active" }),
  ]) {
    assert.equal(out.ok, false);
    assert.equal(out.httpStatus, 502);
    assert.equal(out.code, ENGINE_UNREACHABLE_CODE);
    assert.match(out.message, /引擎不可达/);
  }
});

test("B2-http-④ 引擎业务 409 ⇒ 透传 code（不抛、不本地兜底）", async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ ok: false, error: { code: "orch_version_exists", message: "dup" } }), { status: 409 });
  const client = createVersionsWriteClient({ baseUrl: "http://engine:8787", fetchImpl: fakeFetch });
  const out = await client.create({ ownerGroup: null, version: "v1.0.0" });
  assert.deepEqual(out, { ok: false, httpStatus: 409, code: "orch_version_exists", message: "dup" });
});
