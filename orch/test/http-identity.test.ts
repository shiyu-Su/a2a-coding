/**
 * HTTP 层「身份 = URL 路径首段」用例（v0.8.6 req01 N2，改造文档 §2.2 B 形态）。
 *
 * 覆盖（断言不弱化：错误码 / 身份捕获逐条精确断言）：
 * ① `/<组名>{path}` 命中身份 ⇒ `coreFor("<组名>")`；
 * ② `path === options.path` ⇒ 无身份（`coreFor(null)`；未配组全量接纳照旧）；
 * ③ 配组（`identityRequired() === true`）下匿名访问 ⇒ **403** `{ok:false,error:"group_identity_required"}` + 文案指路，
 *    且 **core 不被装配**（coreFor 零调用）；带身份访问同环境 ⇒ 不被 403；
 * ④ 组名撞保留首段 ⇒ 启动 fail-fast（在 `config.test.ts` 覆盖，本文件覆盖其 HTTP 侧残面：
 *    `/health` / `/runner/*` 路由不受身份解析影响）；
 * ⑤ 尾斜杠 / 空首段 / 额外段 / absolute-form ⇒ **不落 MCP**（落后续路由 / 404）。
 * 另：`matchMcpPath` 纯函数单测（含自定义 `options.path` 多段形）与
 * `resolveGroup` 身份→组视图纯函数单测（命中 / 聚合 / 未命中 fail-closed）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。本文件不触碰 store（无 SESSION_DB）。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { matchMcpPath, startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import type { BridgeCore } from "../bridge/index.js";
import { resolveGroup } from "../bridge/index.js";
import { memberKey } from "../config.js";
import type { ProjectGroup } from "../types.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const transports: HttpTransportHandle[] = [];

after(async () => {
  for (const transport of transports) await transport.close();
});

/** 内核桩：MCP `initialize` 握手不触达领域方法；被触达即报错（防止测试悄悄走进 core） */
function unused(name: string): never {
  throw new Error(`unused BridgeCore method: ${name}`);
}

function fakeCore(): BridgeCore {
  return {
    projects: async () => unused("projects"),
    tasks: async () => unused("tasks"),
    call: async () => unused("call"),
    registerFeatureNode: () => unused("registerFeatureNode"),
    taskStatus: async () => unused("taskStatus"),
    cancel: async () => unused("cancel"),
    events: () => unused("events"),
    wait: async () => unused("wait"),
    featureCreate: () => unused("featureCreate"),
    featureStatus: () => unused("featureStatus"),
    featureAdvance: () => unused("featureAdvance"),
    featureApprove: () => unused("featureApprove"),
    featureCancel: () => unused("featureCancel"),
    kickScheduler: () => unused("kickScheduler"),
  };
}

interface OpenOptions {
  path?: string;
  /** 本文件以「捕获身份」为主：不传 coreFor 时走 options.core 兜底路径 */
  coreFor?: (identity: string | null) => BridgeCore;
  identityRequired?: () => boolean;
}

async function openTransport(o: OpenOptions = {}): Promise<HttpTransportHandle> {
  const transport = await startHttpTransport({
    core: fakeCore(),
    ...(o.coreFor === undefined ? {} : { coreFor: o.coreFor }),
    ...(o.identityRequired === undefined
      ? {}
      : { identityRequired: o.identityRequired }),
    host: "127.0.0.1",
    port: 0,
    path: o.path ?? "/mcp",
    isReady: () => true,
    role: () => "owner",
    version: "test",
    onShutdown: () => {
      /* 不触发停机 */
    },
  });
  transports.push(transport);
  return transport;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

/** POST 一条 MCP `initialize` JSON-RPC（stateless 握手不触达 core，仅验证身份路由 / 门） */
function postMcp(port: number, path: string, method = "POST"): Promise<HttpResult> {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "n2-http-identity", version: "1" },
    },
  });
  return new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(payload),
        },
        agent: false,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString("utf8");
        });
        res.on("end", () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(data) as Record<string, unknown>;
          } catch {
            /* 非 JSON 响应：保留 {}，由 status 断言兜底 */
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end(method === "POST" ? payload : undefined);
  });
}

// ---------------------------------------------------------------------------
// matchMcpPath 纯函数单测
// ---------------------------------------------------------------------------

test("matchMcpPath：path === options.path ⇒ 无身份（identity=null）", () => {
  assert.deepEqual(matchMcpPath("/mcp", "/mcp"), { identity: null });
  assert.deepEqual(matchMcpPath("/orch/mcp", "/orch/mcp"), { identity: null });
});

test("matchMcpPath：/<组名>{path} ⇒ 首段为身份（含自定义多段 options.path）", () => {
  assert.deepEqual(matchMcpPath("/g1/mcp", "/mcp"), { identity: "g1" });
  assert.deepEqual(matchMcpPath("/team-a/mcp", "/mcp"), { identity: "team-a" });
  assert.deepEqual(matchMcpPath("/g1/orch/mcp", "/orch/mcp"), { identity: "g1" });
});

test("matchMcpPath：其余形态一律不匹配（尾斜杠 / 空首段 / 额外段 / 无余段 / absolute-form / 其它路由）", () => {
  assert.equal(matchMcpPath("/g1/mcp/", "/mcp"), undefined); // ⑤ 尾斜杠：余段 "/mcp/" ≠ "/mcp"
  assert.equal(matchMcpPath("//mcp", "/mcp"), undefined); // 空首段
  assert.equal(matchMcpPath("/a/b/mcp", "/mcp"), undefined); // identity 不得含 "/"
  assert.equal(matchMcpPath("/g1", "/mcp"), undefined); // 无余段
  assert.equal(matchMcpPath("/g1/xmcp", "/mcp"), undefined); // 余段不精确相等
  assert.equal(matchMcpPath("/health", "/mcp"), undefined);
  assert.equal(matchMcpPath("/mcp/x", "/mcp"), undefined);
  assert.equal(matchMcpPath("", "/mcp"), undefined);
  assert.equal(matchMcpPath("http://h/mcp", "/mcp"), undefined); // absolute-form 不截身份
});

// ---------------------------------------------------------------------------
// resolveGroup 纯函数单测（身份 → 组视图）
// ---------------------------------------------------------------------------

function groupOf(name: string, keys: string[]): ProjectGroup {
  return {
    name,
    members: keys.map((projectId) => ({ machineId: "m1", projectId })),
    memberKeys: new Set(keys.map((projectId) => memberKey("m1", projectId))),
    memberMachineIds: new Set(["m1"]),
    selective: true,
  };
}

test("resolveGroup：身份命中组名 ⇒ 该组；未命中 ⇒ fail-closed 空组（不回退全量接纳，I2）", () => {
  const groups = [groupOf("gA", ["p1"]), groupOf("gB", ["p2"])];
  assert.equal(resolveGroup("gA", groups), groups[0]);
  assert.equal(resolveGroup("gB", groups), groups[1]);
  const unknown = resolveGroup("typo", groups);
  assert.equal(unknown.selective, true, "未知身份必须 selective（否则=全量接纳，fail-open）");
  assert.equal(unknown.memberKeys.size, 0);
  assert.equal(unknown.memberMachineIds.size, 0);
  assert.equal(unknown.name, "typo", "错误文案可用：name 保留所连身份");
});

test("resolveGroup：无身份 ⇒ 全组聚合视图（未配组 = 全量接纳；配组 = 并集，仅供 web/兜底，HTTP 匿名被 403 门挡住）", () => {
  const none = resolveGroup(null, []);
  assert.equal(none.selective, false, "未配任何组 ⇒ 全量接纳照旧");
  const agg = resolveGroup(null, [groupOf("gA", ["p1"]), groupOf("gB", ["p2"])]);
  assert.equal(agg.selective, true);
  assert.equal(agg.memberKeys.size, 2, "聚合并集 = 各组成员不重叠之和（互斥保证）");
});

// ---------------------------------------------------------------------------
// HTTP 端到端（真实监听 + JSON-RPC 握手）
// ---------------------------------------------------------------------------

test("① POST /<组名>/mcp ⇒ 200 且 coreFor 收到身份；② POST /mcp ⇒ 无身份（未配组照旧全量接纳）", async () => {
  const seen: Array<string | null> = [];
  const transport = await openTransport({
    coreFor: (identity) => {
      seen.push(identity);
      return fakeCore();
    },
  });

  const named = await postMcp(transport.port, "/g1/mcp");
  assert.equal(named.status, 200, `组名端点应握手成功，实际 ${JSON.stringify(named)}`);
  assert.ok(named.body.result, "initialize 应答必须含 result");

  const anon = await postMcp(transport.port, "/mcp");
  assert.equal(anon.status, 200, `未配组匿名入口必须照旧，实际 ${JSON.stringify(anon)}`);

  assert.deepEqual(seen, ["g1", null], "身份必须逐请求透到 coreFor（首段=g1；恰等 path=null）");
});

test("③ 配组环境：匿名 /mcp ⇒ 403 group_identity_required + 文案指路，core 不被装配；带身份 /g1/mcp ⇒ 放行", async () => {
  let coreCalls = 0;
  const seen: Array<string | null> = [];
  const transport = await openTransport({
    coreFor: (identity) => {
      coreCalls += 1;
      seen.push(identity);
      return fakeCore();
    },
    identityRequired: () => true, // 配了组（单一判据 = groups.length > 0，由调用方注入）
  });

  const anon = await postMcp(transport.port, "/mcp");
  assert.equal(anon.status, 403, `配组下匿名必须 403，实际 ${JSON.stringify(anon)}`);
  assert.equal(anon.body.ok, false);
  assert.equal(anon.body.error, "group_identity_required");
  assert.match(String(anon.body.message), /本机已配置 projectGroup/);
  assert.match(String(anon.body.message), /\/<组名>\/mcp/);
  assert.equal(coreCalls, 0, "403 门必须在装配 core 之前（core 零触达）");

  const named = await postMcp(transport.port, "/g1/mcp");
  assert.equal(named.status, 200, "配组不改变带身份路径的行为");
  assert.deepEqual(seen, ["g1"]);

  const bogus = await postMcp(transport.port, "/typo/mcp");
  assert.equal(
    bogus.status,
    200,
    "未命中组名的身份照常透给 core（fail-closed 判定属 resolveGroup 层，不在 HTTP 层猜组名清单）",
  );
  assert.deepEqual(seen, ["g1", "typo"]);
});

test("⑤ 尾斜杠 / 空首段 / 额外段 ⇒ 404（不落 MCP、不触发 403 门）", async () => {
  const transport = await openTransport({ identityRequired: () => true });
  for (const path of ["/g1/mcp/", "//mcp", "/a/b/mcp", "/g1"]) {
    const res = await postMcp(transport.port, path);
    assert.equal(res.status, 404, `path=${path} 必须落 404，实际 ${JSON.stringify(res)}`);
    assert.equal(res.body.error, "not_found");
  }
});

test("④残面：保留路由不受身份解析影响（/health 恒 200；未注入 runner 时 /runner/* 仍 404）", async () => {
  const transport = await openTransport({ identityRequired: () => true });
  const health = await postMcp(transport.port, "/health", "GET");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");
  const runner = await postMcp(transport.port, "/runner/register");
  assert.equal(runner.status, 404);
});

test("方法门先于身份门：非 POST 的匿名 /mcp ⇒ 405（即便配组）", async () => {
  const transport = await openTransport({ identityRequired: () => true });
  const res = await postMcp(transport.port, "/mcp", "GET");
  assert.equal(res.status, 405);
  assert.equal(res.body.error, "method_not_allowed");
});

test("兜底兼容：未注入 coreFor（既有接线形态）⇒ 匿名 /mcp 照旧、走 options.core", async () => {
  const transport = await openTransport();
  const res = await postMcp(transport.port, "/mcp");
  assert.equal(res.status, 200, `未注入 coreFor 的旧形态必须不变，实际 ${JSON.stringify(res)}`);
});
