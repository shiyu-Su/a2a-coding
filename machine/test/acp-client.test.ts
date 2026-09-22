/**
 * `machine/acp-bridge/acp/client.ts` 定向单测（REQ-v0.8.0-2026-09-19-01 · 节点 B2）。
 *
 * 判据：initialize 握手成功/失败、通知路由、服务端请求路由、请求超时、后端崩溃 → 结构化错误。
 * fake stdio（PassThrough）经构造注入；NDJSON framing 断言。
 *
 * **v0.8.8 · M1 取证面 a** 追加：**迟到响应**（超时后回来的那件）落「未知 id」分支时，
 * `error.code` / `message` / `data`（或 `result` 摘要）**必须进日志** —— 历史取证里
 * 「600s 零输出」的 failed 行后紧跟 `收到未知 id 的响应：4`，payload 一字未留 ⇒ 排队证据被吃掉。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { AcpClient, AcpError, wideJson } from "../acp-bridge/acp/client.js";
import type { AcpChildProcess, AcpSpawn } from "../acp-bridge/acp/types.js";

/** 假子进程：stdin 收集客户端写出，stdout 供注入入站消息。 */
class FakeChild implements AcpChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  responder: ((req: Record<string, unknown>) => unknown) | null = null;
  private readonly exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private readonly errors: Array<(error: Error) => void> = [];
  private buffer = "";

  constructor() {
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      for (;;) {
        const index = this.buffer.indexOf("\n");
        if (index < 0) break;
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        this.requests.push(request);
        const response = this.responder?.(request);
        if (response !== null && response !== undefined) this.push(response);
      }
    });
  }

  push(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  kill(): boolean {
    return true;
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exits.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errors.push(listener);
  }

  emitExit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    for (const listener of [...this.exits]) listener(code, signal);
  }
}

function makeClient(fake: FakeChild, requestTimeoutMs = 300, logger?: (message: string) => void): AcpClient {
  const spawn: AcpSpawn = () => fake;
  return new AcpClient({
    command: "qodercn",
    spawn,
    requestTimeoutMs,
    env: {},
    ...(logger !== undefined ? { logger } : {}),
  });
}

function hasId(id: unknown): (r: Record<string, unknown>) => boolean {
  return (r) => r["id"] === id;
}

test("B2 initialize 握手成功：NDJSON 请求形状 + 响应关联", async () => {
  const fake = new FakeChild();
  const client = makeClient(fake);
  fake.responder = (req) =>
    req["method"] === "initialize"
      ? { jsonrpc: "2.0", id: req["id"], result: { protocolVersion: 1, agentInfo: { name: "qoder-cli-cn" } } }
      : null;

  const result = await client.initialize();
  assert.equal(result.protocolVersion, 1);
  assert.equal(fake.requests.length, 1);
  const req = fake.requests[0];
  assert.equal(req?.["method"], "initialize");
  assert.equal(req?.["jsonrpc"], "2.0");
  const params = req?.["params"] as Record<string, unknown>;
  assert.equal(params["protocolVersion"], 1);
  await client.close();
});

test("B2 initialize 失败：JSON-RPC error → AcpError(kind=rpc, code)", async () => {
  const fake = new FakeChild();
  const client = makeClient(fake);
  fake.responder = (req) => ({ jsonrpc: "2.0", id: req["id"], error: { code: -32000, message: "auth required" } });
  await assert.rejects(
    () => client.initialize(),
    (err: unknown) => err instanceof AcpError && err.kind === "rpc" && err.code === -32000,
  );
  await client.close();
});

test("B2 通知路由：无 id 的 session/update → handler", async () => {
  const fake = new FakeChild();
  const client = makeClient(fake);
  const received: Array<{ method: string; params: unknown }> = [];
  client.onNotification((method, params) => received.push({ method, params }));
  client.onNotification(() => undefined);

  fake.push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } } });
  await waitFor(() => received.length === 1);
  assert.equal(received[0]?.method, "session/update");
  await client.close();
});

test("B2 服务端请求路由：setRequestHandler → 回写 result", async () => {
  const fake = new FakeChild();
  const client = makeClient(fake);
  client.setRequestHandler((method) => {
    if (method !== "session/request_permission") throw new Error("unexpected");
    return { outcome: { outcome: "cancelled" } };
  });
  fake.push({ jsonrpc: "2.0", id: "srv-1", method: "session/request_permission", params: { options: [] } });
  await waitFor(() => fake.requests.some(hasId("srv-1")));
  const response = fake.requests.find(hasId("srv-1"));
  assert.deepEqual(response?.["result"], { outcome: { outcome: "cancelled" } });
  await client.close();
});

test("B2 请求超时：无响应 → AcpError(kind=timeout)", async () => {
  const fake = new FakeChild();
  const client = makeClient(fake, 60);
  fake.responder = () => null;
  await assert.rejects(
    () => client.request("session/prompt", {}, 60),
    (err: unknown) => err instanceof AcpError && err.kind === "timeout",
  );
  await client.close();
});

test("B2 后端崩溃：在飞请求以 closed 拒绝，后续请求立即拒绝", async () => {
  const fake = new FakeChild();
  const client = makeClient(fake, 5000);
  fake.responder = () => null;
  const pending = client.request("session/new", {}, 5000);
  fake.emitExit(1, null);
  await assert.rejects(
    () => pending,
    (err: unknown) => err instanceof AcpError && err.kind === "closed",
  );
  await assert.rejects(
    () => client.request("session/new", {}, 5000),
    (err: unknown) => err instanceof AcpError && err.kind === "closed",
  );
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor 超时");
}

// ---------- REQ-v0.8.8-2026-09-22-01 · M1 取证面 a：迟到响应的 payload 必须留痕 ----------

/**
 * 历史取证（改造文档 §2.3.1）：两条「600s 零输出」的 failed 行后 1–2 行紧跟
 * `[acp] 收到未知 id 的响应：4`（= `session/prompt`）—— **响回来了，但 payload 一字未留**，
 * 于是「配额 / 限流到底有没有报错」既不能证实也不能证伪。本组用例锁定 payload 进日志。
 */
test("M1 迟到响应（error 形）：code / message / data 全部进日志", async () => {
  const fake = new FakeChild();
  const logs: string[] = [];
  const client = makeClient(fake, 30, (m) => logs.push(m));
  fake.responder = () => null; // 先不回应答 ⇒ 让请求超时
  await assert.rejects(() => client.request("session/prompt", {}, 30));

  const id = fake.requests[0]?.["id"];
  fake.push({
    jsonrpc: "2.0",
    id,
    error: { code: -32005, message: "quota exceeded", data: { retryAfterMs: 60000 } },
  });
  await waitFor(() => logs.some((m) => m.includes("迟到件")));

  const line = logs.find((m) => m.includes("迟到件")) ?? "";
  assert.match(line, /-32005/, "code 必须留");
  assert.match(line, /quota exceeded/, "message 必须留");
  assert.match(line, /retryAfterMs/, "data 必须留（opencode 方言把细节只写在 data）");
  await client.close();
});

test("M1 迟到响应（result 形）：result 摘要进日志", async () => {
  const fake = new FakeChild();
  const logs: string[] = [];
  const client = makeClient(fake, 30, (m) => logs.push(m));
  fake.responder = () => null;
  await assert.rejects(() => client.request("session/prompt", {}, 30));

  const id = fake.requests[0]?.["id"];
  fake.push({ jsonrpc: "2.0", id, result: { stopReason: "refusal", why: "queued" } });
  await waitFor(() => logs.some((m) => m.includes("迟到件")));

  const line = logs.find((m) => m.includes("迟到件")) ?? "";
  assert.match(line, /stopReason/, "result 摘要必须留（迟到的是结果也是证据）");
  assert.match(line, /queued/);
  await client.close();
});

test("M1 取证面 helper：wideJson 截断留痕、不可序列化值回落 String（永不抛错）", () => {
  assert.equal(wideJson({ a: 1 }), '{"a":1}');
  assert.equal(wideJson([1, 2, 3], 4), "[1,2…(+3)", "截断须留痕（+N = 被砍掉的字符数）");
  assert.equal(wideJson(undefined), "undefined", "JSON.stringify 无结果 ⇒ 回落 String，不得产出空串");
  assert.equal(wideJson(BigInt(7)), "7", "BigInt 直喂 JSON.stringify 会抛 ⇒ 必须走回落路径");
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  assert.match(wideJson(circular), /^\[object Object\]$/, "循环引用 JSON.stringify 抛 ⇒ 回落 String 不抛");
});
