/**
 * `machine/acp-bridge/acp/session.ts` 定向单测（REQ-v0.8.0-2026-09-19-01 · 节点 B3）。
 *
 * 判据：new 成功 / resume 失败回退 new / update 流式拼接 / 超时 → failed / 后端中途退出 → failed。
 * fake 客户端经构造注入。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpError } from "../acp-bridge/acp/client.js";
import { AcpSessionRunner, type AcpRequestClient } from "../acp-bridge/acp/session.js";
import { SessionMap, type SessionMapFs } from "../acp-bridge/session-map.js";
import { A2A_OUTCOME_CONVENTION } from "../acp-bridge/outcome.js";

class FakeClient implements AcpRequestClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  responder: (method: string, params: unknown) => Promise<unknown> | unknown = () => ({});
  private readonly handlers = new Set<(method: string, params: unknown) => void>();

  request(method: string, params: unknown, _timeoutMs?: number): Promise<unknown> {
    this.calls.push({ method, params });
    return Promise.resolve().then(() => this.responder(method, params));
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(method: string, params: unknown): void {
    for (const handler of [...this.handlers]) handler(method, params);
  }
}

class MemoryFs implements SessionMapFs {
  readonly files = new Map<string, string>();
  readText(path: string): string | null {
    const value = this.files.get(path);
    return value === undefined ? null : value;
  }
  writeText(path: string, data: string): void {
    this.files.set(path, data);
  }
  rename(from: string, to: string): void {
    const value = this.files.get(from);
    if (value !== undefined) {
      this.files.set(to, value);
      this.files.delete(from);
    }
  }
  mkdirp(): void {
    return undefined;
  }
}

function runner(client: AcpRequestClient, timeoutMs = 1000, sessions?: SessionMap): AcpSessionRunner {
  return new AcpSessionRunner({ client, cwd: "/ws", timeoutMs, ...(sessions !== undefined ? { sessions } : {}) });
}

const INPUT = { taskId: "t1", text: "hi", contextId: "ctx", messageId: "m1" };

test("B3 session/new 成功：prompt 注入约定 + 流式拼接 agent_message_chunk", async () => {
  const client = new FakeClient();
  client.responder = (method, params) => {
    if (method === "session/new") return { sessionId: "s1" };
    if (method === "session/prompt") {
      const sessionId = (params as { sessionId: string }).sessionId;
      client.emit("session/update", { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "IGNORED" } } });
      client.emit("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello, " } } });
      client.emit("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } });
      return { stopReason: "end_turn" };
    }
    return {};
  };

  const result = await runner(client).execute(INPUT);
  assert.equal(result.state, "completed");
  assert.equal(result.text, "Hello, world");

  const promptCall = client.calls.find((c) => c.method === "session/prompt");
  const promptText = (promptCall?.params as { prompt: Array<{ text: string }> }).prompt[0]?.text ?? "";
  assert.ok(promptText.startsWith(A2A_OUTCOME_CONVENTION), "首轮 prompt 应前置 outcome 约定");
  assert.ok(promptText.endsWith("hi"));
});

test("B3 resume 失败回退 session/new", async () => {
  const client = new FakeClient();
  const fs = new MemoryFs();
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs });
  sessions.set("ctx", "old-sess");

  client.responder = (method) => {
    if (method === "session/load") throw new Error("load failed");
    if (method === "session/resume") throw new Error("resume failed");
    if (method === "session/new") return { sessionId: "new-sess" };
    return { stopReason: "end_turn" };
  };

  const result = await runner(client, 1000, sessions).execute(INPUT);
  assert.equal(result.state, "completed");
  assert.deepEqual(
    client.calls.map((c) => c.method),
    ["session/load", "session/resume", "session/new", "session/prompt"],
  );
  assert.equal(sessions.get("ctx"), "new-sess");
});

test("B3 session/load 成功：复用同一 sessionId（不新建）", async () => {
  const client = new FakeClient();
  const fs = new MemoryFs();
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs });
  sessions.set("ctx", "old-sess");
  client.responder = (method) => (method === "session/load" ? {} : { stopReason: "end_turn" });

  await runner(client, 1000, sessions).execute(INPUT);
  assert.ok(client.calls.some((c) => c.method === "session/load"));
  assert.ok(!client.calls.some((c) => c.method === "session/new"));
  assert.equal(sessions.get("ctx"), "old-sess");
});

test("B3 超时 → failed（含超时文本）", async () => {
  const client = new FakeClient();
  client.responder = (method) =>
    method === "session/new" ? { sessionId: "s1" } : new Promise<never>(() => undefined);
  const result = await runner(client, 50).execute(INPUT);
  assert.equal(result.state, "failed");
  assert.match(result.text ?? "", /任务超时/);
});

test("B3 后端中途退出 → failed（结构化错误文本）", async () => {
  const client = new FakeClient();
  client.responder = (method) =>
    method === "session/new" ? { sessionId: "s1" } : Promise.reject(new AcpError("closed", "backend exited"));
  const result = await runner(client, 1000).execute(INPUT);
  assert.equal(result.state, "failed");
  assert.equal(result.text, "backend exited");
});

test("B3 stopReason=cancelled → canceled", async () => {
  const client = new FakeClient();
  client.responder = (method) =>
    method === "session/new" ? { sessionId: "s1" } : { stopReason: "cancelled" };
  const result = await runner(client, 1000).execute(INPUT);
  assert.equal(result.state, "canceled");
});

// 注：`tasks/cancel`（含 session/cancel 通知）由 B7 端到端集成覆盖（`acp-bridge-e2e.test.ts`）。
