/**
 * v0.10.2 · 节点 M-3 真链路自测（fake ACP stub，**不调真实 CLI**）。
 *
 * 判据①：`startBridge` 装配贯通 —— 同一后端进程内两个会话各带不同 `metadata.risk`
 *   override ⇒ 权限处理器按 `sessionId` 路由，**两会话决策各自生效**。
 * 判据②：不带 override 的会话 ⇒ 逐字回落进程级 `--risk`（本桥 = `write` ⇒ allow）。
 *
 * 链路：HTTP `message/send`（带 / 不带 metadata）→ `a2a-server.parseRoleIntent`（M-2）
 *   → `AcpSessionRunner.execute`（M-3 登记点）→ stub `session/request_permission`
 *   → `createPermissionHandler`（M-3 读取点）→ 决策经 stub 回显进结果文本。
 *
 * stub 形态依 `test/acp-bridge-e2e.test.ts`（B7）；运行：`npm test`。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, type BridgeArgs, type RunningBridge } from "../acp-bridge/index.js";
import { createNodeAcpSpawn } from "../acp-bridge/acp/client.js";
import type { AcpSpawn } from "../acp-bridge/acp/types.js";
import { A2A_TERMINAL_STATES, postJsonRpc, taskViewOf } from "../launcher/a2a-client.js";

const DIR = mkdtempSync(join(tmpdir(), "a2a-acp-m3-"));
const WS = join(DIR, "ws");
mkdirSync(WS, { recursive: true });
const STUB = join(DIR, "fake-qodercn.mjs");

/** fake stub：session/new 固定 sessionId；prompt 期发 request_permission，把决策回显进文本。 */
const STUB_SOURCE = String.raw`import { createInterface } from "node:readline";
function send(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
let seq = 0;
const pending = new Map();
rlLoop();
function rlLoop() {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", function (line) {
    if (line.trim().length === 0) return;
    let m = null;
    try { m = JSON.parse(line); } catch (e) { return; }
    if (m.method === "initialize") { send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }); return; }
    if (m.method === "session/new") { seq += 1; send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "stub-sess-" + seq } }); return; }
    if (m.method === "session/load" || m.method === "session/resume") { send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "session not found" } }); return; }
    if (m.method === "session/prompt") {
      const sid = m.params && m.params.sessionId;
      pending.set(String(m.id), sid);
      const permId = "perm-" + m.id;
      send({ jsonrpc: "2.0", id: permId, method: "session/request_permission", params: { sessionId: sid, toolCall: { title: "write file" }, options: [ { optionId: "allow-1", name: "Allow", kind: "allow_once" }, { optionId: "reject-1", name: "Reject", kind: "reject_once" } ] } });
      return;
    }
    if (typeof m.id === "string" && m.id.indexOf("perm-") === 0) {
      const promptId = m.id.slice(5);
      // prompt 请求 id 是数字（NDJSON JSON-RPC）⇒ pending 键统一按字符串存取
      const sid = pending.get(String(promptId));
      const o = m.result && m.result.outcome;
      const outcomeText = o ? (o.outcome + ":" + (o.optionId || "")) : "none";
      pending.delete(String(promptId));
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "perm=" + outcomeText } } } });
      send({ jsonrpc: "2.0", id: Number(promptId), result: { stopReason: "end_turn" } });
      return;
    }
  });
}
`;
writeFileSync(STUB, STUB_SOURCE, "utf8");

after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function stubSpawn(): AcpSpawn {
  return (_command, _args, options) => createNodeAcpSpawn()(process.execPath, [STUB, "--acp"], options);
}

async function startTestBridge(risk: "read" | "write" | "full"): Promise<RunningBridge> {
  const args: BridgeArgs = {
    port: 0,
    workspace: WS,
    projectId: "m3-p1",
    backendCmd: "fake-qodercn",
    risk,
  };
  const running = await startBridge(args, {
    spawn: stubSpawn(),
    env: { ...process.env },
    logger: () => undefined,
  });
  await running.server.listen(0);
  return running;
}

async function sendAndSettle(
  base: string,
  contextId: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  const message: Record<string, unknown> = {
    role: "user",
    parts: [{ kind: "text", text: "hi" }],
    messageId: randomUUID(),
    contextId,
    ...(metadata !== undefined ? { metadata } : {}),
  };
  const sent = await postJsonRpc(base, "message/send", { message, configuration: { blocking: false } }, 5_000);
  const id = taskViewOf(sent).id;
  if (id === null) throw new Error("缺少 task id");
  const deadline = Date.now() + 15_000;
  for (;;) {
    const got = await postJsonRpc(base, "tasks/get", { id }, 5_000);
    const view = taskViewOf(got);
    if (A2A_TERMINAL_STATES.has(view.state)) {
      assert.equal(view.state, "completed", `stub 任务应正常收敛：${view.text}`);
      return view.text;
    }
    if (Date.now() > deadline) throw new Error("settle 超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const baseOf = (running: RunningBridge): string =>
  `http://127.0.0.1:${String(running.server.port())}`;

async function teardown(running: RunningBridge): Promise<void> {
  await running.server.close();
  await running.client.close();
}

test("M-3 ①：同进程两会话各带 read / full override ⇒ 决策各自生效；②不带 override ⇒ 回落进程级 write", async () => {
  const running = await startTestBridge("write");
  try {
    const base = baseOf(running);
    const readView = await sendAndSettle(base, "ctx-read", { risk: "read" });
    const fullView = await sendAndSettle(base, "ctx-full", { risk: "full" });
    const plainView = await sendAndSettle(base, "ctx-plain");

    assert.ok(readView.includes("perm=selected:reject-1"), `会话档 read 应拒写：${readView}`);
    assert.ok(fullView.includes("perm=selected:allow-1"), `会话档 full 应批：${fullView}`);
    assert.ok(plainView.includes("perm=selected:allow-1"), `无 override 应回落进程级 write：${plainView}`);
  } finally {
    await teardown(running);
  }
});

test("M-3 ②：进程级 read 下带 full override 的会话获批（回落方向双向可证）", async () => {
  const running = await startTestBridge("read");
  try {
    const base = baseOf(running);
    const fullView = await sendAndSettle(base, "ctx-read-base", { risk: "full" });
    const plainView = await sendAndSettle(base, "ctx-read-plain");
    assert.ok(fullView.includes("perm=selected:allow-1"), `会话档 full 应覆盖进程级 read：${fullView}`);
    assert.ok(plainView.includes("perm=selected:reject-1"), `无 override 应回落进程级 read：${plainView}`);
  } finally {
    await teardown(running);
  }
});

test("M-3 ②：非法 risk 档（superuser）⇒ 视为未给 ⇒ 逐字回落进程级", async () => {
  const running = await startTestBridge("write");
  try {
    const view = await sendAndSettle(baseOf(running), "ctx-bogus", { risk: "superuser" });
    assert.ok(view.includes("perm=selected:allow-1"), `非法档不得生效：${view}`);
  } finally {
    await teardown(running);
  }
});
