import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRequirement,
  buildMcpEndpoint,
  buildFeatureCreateArgs,
  buildToolsCallRequest,
  parseToolCallEnvelope,
  normalizeMcpBaseUrl,
  RequirementConfigError,
  REQUIREMENT_STAGE,
  REQUIREMENT_APPROVAL,
  FEATURE_CREATE_TOOL,
  DEFAULT_MCP_BASE_URL,
} from "../dist/requirement.js";

// 组装一个 MCP tools/call 成功信封（result.content[0].text = 桥 handler 的 JSON）。
function okEnvelope(payload) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false },
  };
}

// ---------------------------------------------------------------------------
// 断言①：传出的参数确实带 stage="需求分析" + approval="未发起"
// ---------------------------------------------------------------------------

test("buildFeatureCreateArgs: 始终显式带 stage=需求分析 + approval=未发起 + 调用方 version", () => {
  const args = buildFeatureCreateArgs({ title: "板的唯一封装", version: "v0.9.0", requirement: "原文", contextId: "c1" });
  assert.equal(args.stage, "需求分析");
  assert.equal(args.approval, "未发起");
  assert.equal(args.version, "v0.9.0");
  assert.equal(args.title, "板的唯一封装");
  assert.equal(args.requirement, "原文");
  assert.equal(args.contextId, "c1");
  assert.equal(REQUIREMENT_STAGE, "需求分析");
  assert.equal(REQUIREMENT_APPROVAL, "未发起");
});

test("createRequirement: 出网 body 的 arguments 确实携带 stage/approval（端到端捕获）", async () => {
  let capturedBody = null;
  const fetchImpl = async (_url, init) => {
    capturedBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify(okEnvelope({ ok: true, featureId: "F-42", state: "waiting_approval", stage: "需求分析", version: "v0.9.0", approval: "未发起" })), { status: 200 });
  };
  const out = await createRequirement({ title: "甲", version: "v0.9.0" }, { group: "a2a-coding", fetchImpl });
  assert.equal(out.ok, true);
  // 「提前批准一个方案未定的需求」机制上不可能：证据 = 出网参数强制带这两值。
  assert.equal(capturedBody.params.arguments.stage, "需求分析");
  assert.equal(capturedBody.params.arguments.approval, "未发起");
  assert.equal(capturedBody.params.name, "a2a_feature_create");
});

test("buildFeatureCreateArgs: 空标题即抛 RequirementConfigError（先于网络）", () => {
  assert.throws(() => buildFeatureCreateArgs({ title: "   ", version: "v1" }), RequirementConfigError);
});

// ---------------------------------------------------------------------------
// 断言②：组名出现在 URL 首段
// ---------------------------------------------------------------------------

test("buildMcpEndpoint: 组名写在路径首段 /<组名>/mcp", () => {
  assert.equal(buildMcpEndpoint("http://127.0.0.1:8787", "a2a-coding"), "http://127.0.0.1:8787/a2a-coding/mcp");
  assert.equal(buildMcpEndpoint("http://127.0.0.1:8787/", "org A/1"), "http://127.0.0.1:8787/org%20A%2F1/mcp");
  assert.equal(normalizeMcpBaseUrl("http://h:1//"), "http://h:1");
});

test("buildMcpEndpoint: 空组名（null 身份）直接抛错", () => {
  assert.throws(() => buildMcpEndpoint(DEFAULT_MCP_BASE_URL, "  "), RequirementConfigError);
});

test("createRequirement: 请求 URL = 基址 + /<组名>/mcp（端到端捕获）", async () => {
  let capturedUrl = "";
  const fetchImpl = async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify(okEnvelope({ ok: true, featureId: "F-1" })), { status: 200 });
  };
  await createRequirement({ title: "甲", version: "v0.9.0" }, { group: "flow-team", baseUrl: "http://127.0.0.1:8787", fetchImpl });
  assert.equal(capturedUrl, "http://127.0.0.1:8787/flow-team/mcp");
});

// ---------------------------------------------------------------------------
// 断言③：桥返回错误码时结构化透传、不吞
// ---------------------------------------------------------------------------

test("parseToolCallEnvelope: 桥业务错误码结构化透传（feature_invalid_stage 等）", () => {
  const out = parseToolCallEnvelope({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "feature_invalid_stage", error: "非法 stage" }) }], isError: true },
  });
  assert.deepEqual(out, { ok: false, code: "feature_invalid_stage", error: "非法 stage" });
});

test("parseToolCallEnvelope: 归属校验失败 project_not_a_member 原样带出", () => {
  const out = parseToolCallEnvelope(okEnvelope({ ok: false, code: "project_not_a_member", error: "非本组成员" }));
  assert.equal(out.ok, false);
  assert.equal(out.code, "project_not_a_member");
});

test("parseToolCallEnvelope: 协议级校验错误（非 JSON 文本）落 protocol_error 承载原文", () => {
  const out = parseToolCallEnvelope({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "MCP error -32602: Input validation error" }], isError: true },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "protocol_error");
  assert.match(out.error, /-32602/);
});

test("parseToolCallEnvelope: JSON-RPC 层 error → jsonrpc_<code>", () => {
  const out = parseToolCallEnvelope({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Tool not found" } });
  assert.equal(out.ok, false);
  assert.equal(out.code, "jsonrpc_-32601");
});

test("parseToolCallEnvelope: 成功回显三登记字段；缺列容错 null", () => {
  const withFields = parseToolCallEnvelope(okEnvelope({ ok: true, featureId: "F1", state: "waiting_approval", stage: "需求分析", version: "v1", approval: "未发起" }));
  assert.equal(withFields.ok, true);
  assert.equal(withFields.stage, "需求分析");
  assert.equal(withFields.approval, "未发起");
  const legacy = parseToolCallEnvelope(okEnvelope({ ok: true, featureId: "F2" }));
  assert.equal(legacy.state, null);
  assert.equal(legacy.stage, null);
});

test("createRequirement: HTTP 非 2xx / 传输异常均结构化上报（不吞成成功）", async () => {
  const http = await createRequirement({ title: "甲", version: "v1" }, { group: "g", fetchImpl: async () => new Response("boom", { status: 503 }) });
  assert.equal(http.ok, false);
  assert.equal(http.code, "http_503");

  const thrown = await createRequirement({ title: "甲", version: "v1" }, { group: "g", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, "transport_error");
  assert.match(thrown.error, /ECONNREFUSED/);
});

test("buildToolsCallRequest: 默认 id 且 params 完整", () => {
  const req = buildToolsCallRequest({ title: "t" }, 7);
  assert.equal(req.method, "tools/call");
  assert.equal(req.id, 7);
  assert.equal(req.params.name, FEATURE_CREATE_TOOL);
});

// ---------------------------------------------------------------------------
// 断言④（纪律）：板代码里对 a2a_feature_create 的调用点唯一 · 且绝不触碰状态推进三工具
// ---------------------------------------------------------------------------

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

function walkTs(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walkTs(full, acc);
    else if (ent.name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

/** 归一成 `src/xxx.ts`（正斜杠）形式的相对路径，避免断言受 OS 分隔符影响。 */
function relFromSrc(full) {
  return relative(SRC_DIR, full).split(sep).join("/");
}

test("纪律扫描：src/** 中 a2a_feature_create 仅出现在 requirement.ts", () => {
  const files = walkTs(SRC_DIR);
  assert.ok(files.length > 0, "应能枚举 src 下 .ts 文件");
  const hits = files
    .filter((f) => readFileSync(f, "utf8").includes("a2a_feature_create"))
    .map(relFromSrc);
  assert.deepEqual(hits, ["requirement.ts"], "对 a2a_feature_create 的引用必须收敛在唯一封装文件");
});

test("纪律扫描：板代码里绝不出现 approve / advance / cancel 三工具名（板不写状态机）", () => {
  const forbidden = ["a2a_feature_approve", "a2a_feature_advance", "a2a_feature_cancel"];
  const offenders = [];
  for (const f of walkTs(SRC_DIR)) {
    const src = readFileSync(f, "utf8");
    for (const tok of forbidden) {
      if (src.includes(tok)) offenders.push(`${relFromSrc(f)} -> ${tok}`);
    }
  }
  assert.deepEqual(offenders, [], "板不写状态机：不得引用任何状态推进工具");
});
