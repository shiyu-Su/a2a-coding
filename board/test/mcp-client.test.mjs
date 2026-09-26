import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildMcpEndpoint,
  buildToolsCallRequest,
  parseToolCallEnvelope,
  callTool,
  normalizeMcpBaseUrl,
  McpConfigError,
} from "../dist/mcp-client.js";

// ---------------------------------------------------------------------------
// 纯函数：端点 / 请求体 / 信封解析（工具名为参数，create 无关）
// ---------------------------------------------------------------------------

test("buildMcpEndpoint: 组名编码进路径首段；空组名抛 McpConfigError", () => {
  assert.equal(buildMcpEndpoint("http://127.0.0.1:8787", "a2a-coding"), "http://127.0.0.1:8787/a2a-coding/mcp");
  assert.equal(normalizeMcpBaseUrl("http://h:1//"), "http://h:1");
  assert.throws(() => buildMcpEndpoint("http://h:1", "  "), McpConfigError);
});

test("buildToolsCallRequest: 工具名与 id 由调用方给出", () => {
  const req = buildToolsCallRequest("a2a_projects", { q: 1 }, 9);
  assert.equal(req.method, "tools/call");
  assert.equal(req.id, 9);
  assert.equal(req.params.name, "a2a_projects");
  assert.deepEqual(req.params.arguments, { q: 1 });
});

test("parseToolCallEnvelope: 成功负载原样带出；业务错误码结构化透传", () => {
  const ok = parseToolCallEnvelope({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify({ ok: true, features: [1, 2] }) }], isError: false },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.payload.features, [1, 2]);

  const fail = parseToolCallEnvelope({
    result: { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "project_not_a_member", error: "非本组成员" }) }], isError: true },
  });
  assert.deepEqual(fail, { ok: false, code: "project_not_a_member", error: "非本组成员" });
});

// ---------------------------------------------------------------------------
// callTool：一次 tools/call 的完整链路（网络注入，不依赖桥在跑）
// ---------------------------------------------------------------------------

test("callTool: 出网 URL/body 正确并归一成功结果", async () => {
  let capturedUrl = "";
  let capturedBody = null;
  const fetchImpl = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify({ ok: true, hello: "world" }) }], isError: false },
    }), { status: 200 });
  };
  const out = await callTool("http://127.0.0.1:8787/", "flow-team", "a2a_projects", {}, { fetchImpl });
  assert.equal(capturedUrl, "http://127.0.0.1:8787/flow-team/mcp");
  assert.equal(capturedBody.params.name, "a2a_projects");
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.payload.hello, "world");
});

test("callTool: 传输异常结构化上报（transport_error），HTTP 非 2xx 带状态码", async () => {
  const thrown = await callTool("http://h:1", "g", "t", {}, { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, "transport_error");

  const http = await callTool("http://h:1", "g", "t", {}, { fetchImpl: async () => new Response("boom", { status: 503 }) });
  assert.equal(http.ok, false);
  assert.equal(http.code, "http_503");
});

// ---------------------------------------------------------------------------
// 分层纪律：通用客户端不携带任何写工具字面量（写口径收敛在 requirement.ts）
// ---------------------------------------------------------------------------

test("纪律扫描：mcp-client.ts 不含任何 Feature 写/状态推进工具名", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/mcp-client.ts", import.meta.url)), "utf8");
  for (const tok of ["a2a_feature_create", "a2a_feature_approve", "a2a_feature_advance", "a2a_feature_cancel"]) {
    assert.ok(!src.includes(tok), `mcp-client.ts 不得出现工具字面量 ${tok}`);
  }
});
