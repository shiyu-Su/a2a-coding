/**
 * `machine/acp-bridge/` MCP 注入 flag 单测（REQ-v0.9.0-2026-09-24-01 · 节点 M2a）。
 *
 * 判据（改造文档 §3.4 B2‴：给既有空槽接一根 flag）：
 * - ① **向后兼容**：不传 `--mcp-servers-json` ⇒ `BridgeArgs` 键缺席 ⇒ 经 `startBridge` 真起桥后
 *   `session/new` 实参 `mcpServers` 仍为 `[]`（与引入本 flag 前逐字一致）；
 * - ② **透传**：传合法 JSON 数组 ⇒ 值原样落到 `session/new` 与 `session/load` 的 `mcpServers`
 *   （两处在飞槽位同一来源，桥不改写、不补全键）；
 * - ③ **非法即抛**：非法 JSON / 非数组 / 元素非对象 / 缺 `name` / `type` 要求的必填键空 ⇒ 抛错
 *   （`type` 判别键闭集与「缺 `type` ⇒ 抛」由 M2c 增补，见 `acp-bridge-m2c-mcp-type.test.ts`）。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AcpSessionRunner, type AcpRequestClient } from "../acp-bridge/acp/session.js";
import {
  parseBridgeArgs,
  parseMcpServersArg,
  startBridge,
  type BridgeArgs,
} from "../acp-bridge/index.js";
import { SessionMap, type SessionMapFs } from "../acp-bridge/session-map.js";
import type { AcpChildProcess, AcpSpawn } from "../acp-bridge/acp/types.js";

const SERVERS = [
  { name: "a2a", type: "http", url: "http://127.0.0.1:8787/mcp", headers: [{ name: "x", value: "y" }] },
  { name: "local", type: "acp", command: "/usr/bin/foo", args: ["--stdio-only"], env: [] },
];

/* ---------------- ③ parseMcpServersArg ---------------- */

test("M2a：parseMcpServersArg 缺省 / 空串 ⇒ undefined（槽位维持 []）；[] ⇒ 空数组", () => {
  assert.equal(parseMcpServersArg(undefined), undefined);
  assert.equal(parseMcpServersArg(""), undefined);
  assert.deepEqual(parseMcpServersArg("[]"), []);
});

test("M2a：parseMcpServersArg 合法数组 ⇒ 元素原样透传（不改写 / 不补全 / 不删键）", () => {
  assert.deepEqual(parseMcpServersArg(JSON.stringify(SERVERS)), SERVERS);
});

test("M2a：parseMcpServersArg 非法 JSON / 非数组 / 元素非对象 ⇒ 抛错", () => {
  assert.throws(() => parseMcpServersArg("{not json"), /不是合法 JSON/);
  assert.throws(() => parseMcpServersArg('{"name":"a"}'), /必须是 JSON 数组/);
  assert.throws(() => parseMcpServersArg("null"), /必须是 JSON 数组/);
  assert.throws(() => parseMcpServersArg('["a"]'), /第 1 项必须是 JSON 对象/);
  assert.throws(() => parseMcpServersArg("[[]]"), /第 1 项必须是 JSON 对象/);
});

test("M2a：parseMcpServersArg 缺 name / name 空 / type 要求的必填键空 ⇒ 抛错", () => {
  assert.throws(() => parseMcpServersArg('[{"url":"http://x"}]'), /缺少非空字符串 name/);
  assert.throws(() => parseMcpServersArg('[{"name":"","url":"http://x"}]'), /缺少非空字符串 name/);
  assert.throws(() => parseMcpServersArg('[{"name":"a","type":"http","url":""}]'), /type=http 需要非空字符串 url/);
  assert.throws(() => parseMcpServersArg('[{"name":"a","type":"acp","command":""}]'), /type=acp 需要非空字符串 command/);
  assert.throws(() => parseMcpServersArg('[{"name":"a"},{"name":"b"}]'), /项 a 的 type/);
  assert.throws(
    () => parseMcpServersArg('[{"name":"a","type":"http","url":"http://x"},{"name":"b","type":"http"}]'),
    /项 b 的 type=http 需要非空字符串 url/,
    "首个元素合法时，报错须指名实际出错的那一项",
  );
});

/* ---------------- parseBridgeArgs 的 flag 面 ---------------- */

const COMMON = ["--port", "4100", "--workspace", "/ws", "--project-id", "p1", "--backend-cmd", "b"];

test("M2a：parseBridgeArgs --mcp-servers-json ⇒ args.mcpServers；未给 / 空串 ⇒ 键缺席", () => {
  const withFlag = parseBridgeArgs([...COMMON, "--mcp-servers-json", JSON.stringify(SERVERS)]);
  assert.deepEqual(withFlag.mcpServers, SERVERS);
  for (const argv of [COMMON, [...COMMON, "--mcp-servers-json", ""]]) {
    const args = parseBridgeArgs(argv);
    assert.equal(args.mcpServers, undefined);
    assert.equal("mcpServers" in args, false, "键缺席（而非落成空数组）才可区分未配置");
  }
  assert.throws(
    () => parseBridgeArgs([...COMMON, "--mcp-servers-json", "{bad}"]),
    /--mcp-servers-json/,
  );
});

/* ---------------- ① + ② 会话建立实参（真走 ACP 报文） ---------------- */

class FakeClient implements AcpRequestClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private sessionId = "s-new";
  private readonly handlers = new Set<(method: string, params: unknown) => void>();

  request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "session/new") return Promise.resolve({ sessionId: this.sessionId });
    if (method === "session/load") {
      this.sessionId = (params as { sessionId: string }).sessionId;
      return Promise.resolve({});
    }
    if (method === "session/prompt") {
      this.emit("session/update", {
        sessionId: this.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
      });
      return Promise.resolve({ stopReason: "end_turn" });
    }
    return Promise.resolve({});
  }

  notify(): void {
    return undefined;
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(method: string, params: unknown): void {
    for (const handler of [...this.handlers]) handler(method, params);
  }
}

class MemoryFs implements SessionMapFs {
  readonly files = new Map<string, string>();
  readText(path: string): string | null {
    return this.files.get(path) ?? null;
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

const INPUT = { taskId: "t1", text: "hi", contextId: "ctx", messageId: "m1" };

function paramsOf(client: FakeClient, method: string): Record<string, unknown> | undefined {
  const call = client.calls.find((c) => c.method === method);
  return call === undefined ? undefined : (call.params as Record<string, unknown>);
}

test("M2a 会话建立：未配 mcpServers ⇒ session/new 与 session/load 仍发 []（向后兼容锚）", async () => {
  const newPathClient = new FakeClient();
  const newResult = await new AcpSessionRunner({
    client: newPathClient,
    cwd: "/ws",
    timeoutMs: 1000,
  }).execute(INPUT);
  assert.equal(newResult.state, "completed", "本轮须真跑到 prompt（否则断言空转）");
  assert.deepEqual(paramsOf(newPathClient, "session/new")?.["mcpServers"], []);

  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new MemoryFs() });
  sessions.set("ctx", "s-old");
  const loadClient = new FakeClient();
  const loadResult = await new AcpSessionRunner({
    client: loadClient,
    cwd: "/ws",
    timeoutMs: 1000,
    sessions,
  }).execute(INPUT);
  assert.equal(loadResult.state, "completed");
  assert.deepEqual(paramsOf(loadClient, "session/load")?.["mcpServers"], []);
});

test("M2a 会话建立：配 mcpServers ⇒ 同值落到 session/new 与 session/load 两路", async () => {
  const newPathClient = new FakeClient();
  const newResult = await new AcpSessionRunner({
    client: newPathClient,
    cwd: "/ws",
    timeoutMs: 1000,
    mcpServers: SERVERS,
  }).execute(INPUT);
  assert.equal(newResult.text, "ok");
  assert.deepEqual(paramsOf(newPathClient, "session/new")?.["mcpServers"], SERVERS, "new 路（session.ts:1227）");

  const loadFs = new MemoryFs();
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs: loadFs });
  sessions.set("ctx", "s-old");
  const loadClient = new FakeClient();
  const loadResult = await new AcpSessionRunner({
    client: loadClient,
    cwd: "/ws",
    timeoutMs: 1000,
    mcpServers: SERVERS,
    sessions,
  }).execute(INPUT);
  assert.equal(loadResult.text, "ok");
  assert.deepEqual(paramsOf(loadClient, "session/load")?.["mcpServers"], SERVERS, "load 路（session.ts:1211）");
});

/* ---------------- ② 桥装配（BridgeArgs ⇒ 唯一赋值点 ⇒ ACP 报文） ---------------- */

class FakeChild implements AcpChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly lines: Array<Record<string, unknown>> = [];
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
        const message = JSON.parse(line) as Record<string, unknown>;
        this.lines.push(message);
        const method = message["method"];
        const id = message["id"];
        if (id === undefined) continue;
        if (method === "initialize") {
          this.reply(id, { protocolVersion: 1 });
        } else if (method === "session/new") {
          this.reply(id, { sessionId: "s-1" });
        } else if (method === "session/prompt") {
          this.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s-1",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
              },
            })}\n`,
          );
          this.reply(id, { stopReason: "end_turn" });
        } else {
          this.reply(id, {});
        }
      }
    });
  }

  private reply(id: unknown, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  kill(): boolean {
    return true;
  }

  onExit(_listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    return undefined;
  }

  onError(_listener: (error: Error) => void): void {
    return undefined;
  }
}

const DIR = mkdtempSync(join(tmpdir(), "a2a-acp-m2a-"));

function baseArgs(extra: Partial<BridgeArgs> = {}): BridgeArgs {
  return {
    port: 0,
    workspace: DIR,
    projectId: "p1",
    backendCmd: "fake-backend",
    risk: "write",
    ...extra,
  };
}

/** `contextId` 逐测试唯一：`startBridge` 的 `SessionMap` 会落盘共享 workspace，复用同一 ctx 会让第二个测试走 `session/load` 而看不到 `session/new`。 */
async function sessionNewParams(args: BridgeArgs, contextId: string): Promise<Record<string, unknown> | undefined> {
  const children: FakeChild[] = [];
  const spawn: AcpSpawn = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const running = await startBridge(args, { spawn, logger: () => undefined });
  try {
    const result = await running.runner.execute({ ...INPUT, contextId });
    assert.equal(result.state, "completed", "本轮须真跑到 prompt（否则断言空转）");
    const line = children[0]?.lines.find((l) => l["method"] === "session/new");
    return line === undefined ? undefined : (line["params"] as Record<string, unknown>);
  } finally {
    await running.client.close();
  }
}

test("M2a 桥装配：BridgeArgs 无 mcpServers ⇒ 真报文 session/new 仍为 {cwd, mcpServers: []}", async () => {
  const params = await sessionNewParams(baseArgs(), "ctx-no-flag");
  assert.deepEqual(params, { cwd: DIR, mcpServers: [] });
});

test("M2a 桥装配：args.mcpServers 经唯一赋值点透传进 session/new 真报文", async () => {
  const params = await sessionNewParams(baseArgs({ mcpServers: SERVERS }), "ctx-with-flag");
  assert.deepEqual(params, { cwd: DIR, mcpServers: SERVERS });
});
