#!/usr/bin/env node
/**
 * mcp-http-probe.mjs —— 桥 HTTP 接入面「独立 MCP 客户端」真机探针（验证脚本，不参与业务）。
 *
 * 用途（REQ-v0.4.1-2026-09-15-02 §2.3 验收）：**不依赖任何宿主**，直接用
 * `@modelcontextprotocol/sdk` 的 `Client` + `StreamableHTTPClientTransport` 打通
 * `bridge/index.ts` 的 stateless HTTP 接入面，并逐条断言：
 *
 * 1. `initialize` → `tools/list` → `tools/call(a2a_projects)` 全链路可用；
 * 2. **全程不发 `Mcp-Session-Id` 请求头**（stateless 的关键契约；逐请求记录 + 计数断言）；
 * 3. 客户端侧 `transport.sessionId === undefined`（服务端未下发会话号）；
 * 4. `GET /health` 可达，且响应含 `role`（`owner` / `follower`）。
 *
 * 用法（须在 orch 单元根运行，以解析裸包名依赖）：
 *   node tools/mcp-http-probe.mjs
 *   MCP_HTTP_URL=http://127.0.0.1:8899 MCP_HTTP_PATH=/mcp node tools/mcp-http-probe.mjs
 *
 * 退出码：0 = 全部断言通过；1 = 有断言失败（失败项在 `checks` 里 `pass:false`）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE_URL = (process.env["MCP_HTTP_URL"] ?? "http://127.0.0.1:8899").replace(/\/+$/, "");
const MCP_PATH = process.env["MCP_HTTP_PATH"] ?? "/mcp";
const SESSION_HEADER = "mcp-session-id";

/** 逐请求抓包记录（断言「不发 session 头」用） */
const requests = [];
let sessionHeaderSentCount = 0;
let sessionHeaderIssuedCount = 0;

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
}

/** 把各种 header 形态归一为「小写名 → 值」的普通对象 */
function normalizeHeaders(raw) {
  const out = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw.forEach === "function" && typeof raw.get === "function") {
    raw.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (Array.isArray(entry) && entry.length >= 2) {
        out[String(entry[0]).toLowerCase()] = String(entry[1]);
      }
    }
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

/** 记录型 fetch：包装后交给 transport，所有出站请求都留下痕迹 */
async function recordingFetch(input, init) {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : String(input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = normalizeHeaders(init?.headers);
  const sentSession = headers[SESSION_HEADER] ?? null;
  if (sentSession !== null) sessionHeaderSentCount += 1;
  const record = { method, url, sessionHeaderSent: sentSession, status: null };
  requests.push(record);
  const res = await fetch(input, init);
  record.status = res.status;
  const issued = res.headers.get(SESSION_HEADER);
  if (issued !== null) sessionHeaderIssuedCount += 1;
  return res;
}

/** 把 CallToolResult 的 text part 拼起来（拿不到则回落 JSON） */
function toolText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const chunks = [];
  for (const part of content) {
    if (part !== null && typeof part === "object" && part.type === "text" && "text" in part) {
      chunks.push(String(part.text));
    }
  }
  return chunks.join("\n");
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const summary = {
  target: `${BASE_URL}${MCP_PATH}`,
  client: { name: "b3-independent-probe", version: "0.0.1", host: null },
  initialize: null,
  tools: { count: null, names: [] },
  callTool: null,
  health: null,
  sessionHeader: { sentCount: null, issuedCount: null, transportSessionId: null },
  requests: [],
  checks,
};

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}${MCP_PATH}`), {
    fetch: recordingFetch,
  });
  const client = new Client(
    { name: summary.client.name, version: summary.client.version },
    { capabilities: {} },
  );

  await client.connect(transport);

  const serverVersion = client.getServerVersion();
  summary.initialize = {
    protocolVersion: transport.protocolVersion ?? null,
    serverInfo: serverVersion === undefined ? null : serverVersion,
    capabilities: client.getServerCapabilities() ?? null,
  };
  check("initialize/connect 成功", true, `serverInfo=${JSON.stringify(serverVersion)}`);

  const listed = await client.listTools();
  const names = (listed.tools ?? []).map((t) => t.name);
  summary.tools = { count: names.length, names };
  const required = ["a2a_projects", "a2a_tasks", "a2a_call", "a2a_task_status", "a2a_cancel"];
  const missing = required.filter((n) => !names.includes(n));
  check("tools/list 返回工具面", names.length > 0, `count=${names.length}`);
  check("tools/list 含泛型工具", missing.length === 0, missing.length === 0 ? "ok" : `missing=${missing.join(",")}`);

  const callResult = await client.callTool({ name: "a2a_projects", arguments: {} });
  const callText = toolText(callResult);
  const parsed = parseJsonOrNull(callText);
  const machines = Array.isArray(parsed?.machines) ? parsed.machines : [];
  summary.callTool = {
    name: "a2a_projects",
    isError: callResult.isError === true,
    textChars: callText.length,
    machines: machines.map((m) => ({
      machineId: m?.machineId ?? null,
      projects: Array.isArray(m?.projects) ? m.projects.length : 0,
      error: m?.error ?? null,
    })),
    textHead: callText.slice(0, 400),
  };
  check("tools/call(a2a_projects) 非错误返回", callResult.isError !== true, `chars=${callText.length}`);

  const healthRes = await recordingFetch(`${BASE_URL}/health`, { method: "GET" });
  const healthBody = parseJsonOrNull(await healthRes.text());
  const role = healthBody === null ? null : (healthBody.role ?? null);
  summary.health = { status: healthRes.status, body: healthBody };
  check("GET /health 可达（200）", healthRes.status === 200, `status=${healthRes.status}`);
  check("GET /health 含 role", typeof role === "string" && role.length > 0, `role=${String(role)}`);

  summary.sessionHeader = {
    sentCount: sessionHeaderSentCount,
    issuedCount: sessionHeaderIssuedCount,
    transportSessionId: transport.sessionId ?? null,
  };
  check(
    "全程未发送 Mcp-Session-Id 请求头",
    sessionHeaderSentCount === 0,
    `sent=${sessionHeaderSentCount} of ${requests.length} requests`,
  );
  check(
    "服务端未下发会话号（transport.sessionId === undefined）",
    transport.sessionId === undefined,
    `sessionId=${String(transport.sessionId)}`,
  );
  check(
    "服务端未在任何响应下发 Mcp-Session-Id",
    sessionHeaderIssuedCount === 0,
    `issued=${sessionHeaderIssuedCount}`,
  );

  summary.requests = requests;
  await client.close();
}

main()
  .catch((err) => {
    check("探针执行未抛异常", false, err instanceof Error ? err.message : String(err));
  })
  .finally(() => {
    summary.passed = checks.length > 0 && checks.every((c) => c.pass);
    console.log("----- b3-probe-summary -----");
    console.log(JSON.stringify(summary, null, 2));
    console.log("----- b3-probe-summary-end -----");
    console.log(`[probe] ${summary.passed ? "PASS" : "FAIL"} (${checks.filter((c) => c.pass).length}/${checks.length} checks)`);
    // 让 SDK 的 SSE 重连句柄先收尾再退出：立刻 `process.exit()` 会与之竞态
    // （Windows 上表现为 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` → 退出码 0xC0000409）
    setTimeout(() => {
      process.exit(summary.passed ? 0 : 1);
    }, 150);
  });
