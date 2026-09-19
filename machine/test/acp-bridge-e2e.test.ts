/**
 * B7 桥端到端集成自测（fake qodercn stub，**不调真实 CLI**）。
 *
 * 链路：`startBridge`（真实 AcpClient + 会话执行器 + 权限处理器 + A2A 服务面）
 *   → spawn fake stub（临时文件）→ HTTP `message/send` → `tasks/get` 轮询终态。
 *
 * 场景：主流程 completed / contextId 复用走 session/load / tasks/cancel / risk=read 权限被拒。
 * 形状与方言依 P1 探针（NDJSON、session/new|load|prompt、agent_message_chunk、request_permission）。
 *
 * 运行：`npm test`。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, type BridgeArgs, type RunningBridge } from "../acp-bridge/index.js";
import { createNodeAcpSpawn } from "../acp-bridge/acp/client.js";
import type { AcpSpawn } from "../acp-bridge/acp/types.js";
import { A2A_TERMINAL_STATES, postJsonRpc, taskViewOf } from "../launcher/a2a-client.js";

const DIR = mkdtempSync(join(tmpdir(), "a2a-acp-e2e-"));
const WS = join(DIR, "ws");
mkdirSync(WS, { recursive: true });
const STUB = join(DIR, "fake-qodercn.mjs");

/** fake qodercn stub：最小 ACP stdio（NDJSON）——initialize / session·new|load|resume|prompt|cancel / update / request_permission。 */
const STUB_SOURCE = String.raw`import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const LOG = process.env.STUB_LOG;
function log(o) { if (LOG) appendFileSync(LOG, JSON.stringify(o) + "\n"); }
function send(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
let seq = 0;
const sessions = new Set();
let pending = null;
let permSeq = 0;
function finishPrompt(p, reason) {
  const perm = p.permOutcome ? (" perm=" + p.permOutcome) : "";
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: p.sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } } });
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello, " } } } });
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" + perm } } } });
  send({ jsonrpc: "2.0", id: p.id, result: { stopReason: reason } });
}
const rl = createInterface({ input: process.stdin });
rl.on("line", function (line) {
  if (line.trim().length === 0) return;
  let m = null;
  try { m = JSON.parse(line); } catch (e) { return; }
  if (m.method === "initialize") { log({ m: "initialize" }); send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }); return; }
  if (m.method === "session/new") { seq += 1; const sid = "stub-sess-" + seq; sessions.add(sid); log({ m: "session/new", sessionId: sid }); send({ jsonrpc: "2.0", id: m.id, result: { sessionId: sid } }); return; }
  if (m.method === "session/load" || m.method === "session/resume") {
    const sid = m.params && m.params.sessionId;
    log({ m: m.method, sessionId: sid });
    if (typeof sid === "string" && sessions.has(sid)) { send({ jsonrpc: "2.0", id: m.id, result: {} }); }
    else { send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "session not found" } }); }
    return;
  }
  if (m.method === "session/prompt") {
    const sid = m.params && m.params.sessionId;
    const text = (m.params && m.params.prompt && m.params.prompt[0] && m.params.prompt[0].text) || "";
    log({ m: "session/prompt", sessionId: sid, text: text });
    permSeq += 1;
    const pid = "perm-" + permSeq;
    pending = { id: m.id, sessionId: sid, permId: pid, permOutcome: null, slow: text.indexOf("SLOW") >= 0 };
    send({ jsonrpc: "2.0", id: pid, method: "session/request_permission", params: { sessionId: sid, toolCall: { title: "write file" }, options: [ { optionId: "allow-1", name: "Allow", kind: "allow_once" }, { optionId: "reject-1", name: "Reject", kind: "reject_once" } ] } });
    return;
  }
  if (m.method === "session/cancel") {
    log({ m: "session/cancel" });
    send({ jsonrpc: "2.0", id: m.id, result: {} });
    if (pending) { finishPrompt(pending, "cancelled"); pending = null; }
    return;
  }
  if (typeof m.id === "string" && m.id.indexOf("perm-") === 0) {
    if (pending && pending.permId === m.id) {
      const o = m.result && m.result.outcome;
      pending.permOutcome = o ? (o.outcome + ":" + (o.optionId || "")) : "none";
      log({ m: "permission-response", outcome: pending.permOutcome });
      if (!pending.slow) { finishPrompt(pending, "end_turn"); pending = null; }
    }
    return;
  }
});
`;
writeFileSync(STUB, STUB_SOURCE, "utf8");

after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function stubSpawn(): AcpSpawn {
  return (_command, _args, options) => createNodeAcpSpawn()(process.execPath, [STUB, "--acp"], options);
}

async function startTestBridge(risk: "read" | "write" | "full", logPath: string): Promise<RunningBridge> {
  const args: BridgeArgs = {
    port: 0,
    workspace: WS,
    projectId: "p1",
    backendCmd: "fake-qodercn",
    risk,
  };
  const running = await startBridge(args, {
    spawn: stubSpawn(),
    env: { ...process.env, STUB_LOG: logPath },
    logger: () => undefined,
  });
  await running.server.listen(0);
  return running;
}

function sendParams(text: string, contextId: string): unknown {
  return {
    message: {
      role: "user",
      parts: [{ kind: "text", text }],
      messageId: randomUUID(),
      contextId,
    },
    configuration: { blocking: false },
  };
}

async function sendAndSettle(base: string, text: string, contextId: string, timeoutMs = 15000) {
  const sent = await postJsonRpc(base, "message/send", sendParams(text, contextId), 5_000);
  const id = taskViewOf(sent).id;
  if (id === null) throw new Error("缺少 task id");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await postJsonRpc(base, "tasks/get", { id }, 5_000);
    const view = taskViewOf(got);
    if (A2A_TERMINAL_STATES.has(view.state)) return view;
    if (Date.now() > deadline) throw new Error("settle 超时");
    await sleep(20);
  }
}

function readLog(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await sleep(20);
  }
}

const baseOf = (running: RunningBridge): string => `http://127.0.0.1:${String(running.server.port())}`;

async function teardown(running: RunningBridge): Promise<void> {
  await running.server.close();
  await running.client.close();
}

test("B7 主场景：message/send → completed（stub 流式文本 + 权限 allow + artifacts 形状）", async () => {
  const logPath = join(DIR, "log-main.ndjson");
  const running = await startTestBridge("write", logPath);
  try {
    const view = await sendAndSettle(baseOf(running), "hello", "ctx-main");
    assert.equal(view.state, "completed");
    assert.ok(view.text.includes("Hello, world"), view.text);
    assert.ok(view.text.includes("perm=selected:allow-1"), view.text);
    assert.ok(Array.isArray(view.artifacts));
  } finally {
    await teardown(running);
  }
});

test("B7 contextId 复用：第二次走 session/load（恰一次 session/new）", async () => {
  const logPath = join(DIR, "log-reuse.ndjson");
  const running = await startTestBridge("write", logPath);
  try {
    const base = baseOf(running);
    await sendAndSettle(base, "one", "ctx-reuse");
    await sendAndSettle(base, "two", "ctx-reuse");
    const entries = readLog(logPath);
    assert.equal(entries.filter((e) => e["m"] === "session/new").length, 1);
    assert.ok(entries.filter((e) => e["m"] === "session/load").length >= 1);
  } finally {
    await teardown(running);
  }
});

test("B7 tasks/cancel：SLOW 任务被取消", async () => {
  const logPath = join(DIR, "log-cancel.ndjson");
  const running = await startTestBridge("write", logPath);
  try {
    const base = baseOf(running);
    const sent = await postJsonRpc(base, "message/send", sendParams("SLOW job", "ctx-cancel"), 5_000);
    const id = taskViewOf(sent).id;
    assert.ok(id !== null);
    await waitFor(() => readLog(logPath).some((e) => e["m"] === "session/prompt"));
    const canceled = await postJsonRpc(base, "tasks/cancel", { id }, 5_000);
    assert.equal(taskViewOf(canceled).state, "canceled");
    await waitFor(() => readLog(logPath).some((e) => e["m"] === "session/cancel"));
  } finally {
    await teardown(running);
  }
});

test("B7 risk=read：stub 权限请求被拒（越权防护）", async () => {
  const logPath = join(DIR, "log-read.ndjson");
  const running = await startTestBridge("read", logPath);
  try {
    const view = await sendAndSettle(baseOf(running), "hello", "ctx-read");
    assert.equal(view.state, "completed");
    assert.ok(view.text.includes("perm=selected:reject-1"), view.text);
    assert.ok(
      readLog(logPath).some((e) => e["m"] === "permission-response" && e["outcome"] === "selected:reject-1"),
    );
  } finally {
    await teardown(running);
  }
});
