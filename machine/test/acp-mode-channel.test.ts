/**
 * `machine/acp-bridge/` 会话通道单测（REQ-v0.8.5-2026-09-21-01 · 节点 M1）。
 *
 * 判据（与既有 `model` 通路同形）：
 * - `mode`：优先 `session/set_mode {sessionId, modeId}`；**仅** 后端回 `-32601` 才回落
 *   `session/set_config_option {configId:"mode"}`；其余错误一律 fail-fast（不发 prompt、不回落）。
 * - `collaboration_mode`：**只走** `session/set_config_option {configId:"collaboration_mode"}`（不涉 `set_mode`）。
 * - 缺省 / 空串 / 非字符串 ⇒ **零请求**（方法序列与未引入本通路时逐字一致）。
 * - `sessionMeta`：`session/new` / `load` / `resume` **三路统一携带 `_meta`**；未配 ⇒ 不带该键。
 * - `--session-meta-json` 解析（`parseSessionMetaArg`）与 `parseBridgeArgs` 三新 flag 透传。
 * - 桥装配：`BridgeArgs` 三选项经 `startBridge` 透传到会话建立（真走 ACP 报文）。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AcpError } from "../acp-bridge/acp/client.js";
import { AcpSessionRunner, type AcpRequestClient } from "../acp-bridge/acp/session.js";
import {
  parseBridgeArgs,
  parseSessionMetaArg,
  startBridge,
  type BridgeArgs,
} from "../acp-bridge/index.js";
import { SessionMap, type SessionMapFs } from "../acp-bridge/session-map.js";
import type { AcpChildProcess, AcpSpawn } from "../acp-bridge/acp/types.js";

const SET_MODE = "session/set_mode";
const SET_CONFIG = "session/set_config_option";
const META = { claudeCode: { options: { allowDangerouslySkipPermissions: true } } };

class FakeClient implements AcpRequestClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly notifies: Array<{ method: string; params: unknown }> = [];
  responder: (method: string, params: unknown) => Promise<unknown> | unknown = () => ({});
  private readonly handlers = new Set<(method: string, params: unknown) => void>();

  request(method: string, params: unknown, _timeoutMs?: number): Promise<unknown> {
    this.calls.push({ method, params });
    return Promise.resolve().then(() => this.responder(method, params));
  }

  notify(method: string, params?: unknown): void {
    this.notifies.push({ method, params });
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

interface ChannelOptions {
  mode?: unknown;
  collaborationMode?: unknown;
  sessionMeta?: Record<string, unknown>;
  sessions?: SessionMap;
  logger?: (message: string) => void;
}

function makeRunner(client: AcpRequestClient, opts: ChannelOptions = {}): AcpSessionRunner {
  return new AcpSessionRunner({
    client,
    cwd: "/ws",
    timeoutMs: 1000,
    ...(opts.mode !== undefined ? { mode: opts.mode as string } : {}),
    ...(opts.collaborationMode !== undefined
      ? { collaborationMode: opts.collaborationMode as string }
      : {}),
    ...(opts.sessionMeta !== undefined ? { sessionMeta: opts.sessionMeta } : {}),
    ...(opts.sessions !== undefined ? { sessions: opts.sessions } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
}

const INPUT = { taskId: "t1", text: "hi", contextId: "ctx", messageId: "m1" };

const cachedSessions = (sessionId = "old-sess"): SessionMap => {
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new MemoryFs() });
  sessions.set("ctx", sessionId);
  return sessions;
};

/**
 * 应答会话建立 + set + prompt 的通用 fake；`failures` = 指定方法抛出的 JSON-RPC code。
 * 返回被调用方法序列（含回落路径）。
 */
function wire(
  client: FakeClient,
  opts: { sessionId?: string; failures?: ReadonlyArray<readonly [string, number]> } = {},
): string[] {
  const sessionId = opts.sessionId ?? "s1";
  const failures = new Map(opts.failures ?? []);
  const methods: string[] = [];
  client.responder = (method, params) => {
    methods.push(method);
    const code = failures.get(method);
    if (code !== undefined) throw new AcpError("rpc", `${method} 被后端拒绝`, { code });
    if (method === "session/new") return { sessionId };
    if (method === "session/load" || method === "session/resume") return {};
    if (method === SET_MODE) {
      const p = params as { modeId: string };
      return { modes: { currentModeId: p.modeId, availableModes: [] } };
    }
    if (method === SET_CONFIG) {
      const p = params as { configId: string; value: string };
      return { configOptions: [{ id: p.configId, currentValue: p.value }] };
    }
    if (method === "session/prompt") {
      client.emit("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
      });
    }
    return { stopReason: "end_turn" };
  };
  return methods;
}

const paramsOf = (client: FakeClient, method: string): unknown[] =>
  client.calls.filter((c) => c.method === method).map((c) => c.params);

/* ---------------- mode：成功 / 原样 / 零请求 / 回落 / fail-fast ---------------- */

test("M1-mode：new 路径下发 session/set_mode，参数逐字 = {sessionId, modeId}", async () => {
  const client = new FakeClient();
  const methods = wire(client);

  const result = await makeRunner(client, { mode: "read-only" }).execute(INPUT);

  assert.equal(result.state, "completed");
  assert.equal(result.text, "ok");
  assert.deepEqual(methods, ["session/new", SET_MODE, "session/prompt"]);
  assert.deepEqual(paramsOf(client, SET_MODE), [{ sessionId: "s1", modeId: "read-only" }]);
});

test("M1-mode：值原样透传（不校验 / 不映射）", async () => {
  for (const value of ["plan", "read-only", "bypassPermissions", "带 空格/中文", "x".repeat(300)]) {
    const client = new FakeClient();
    wire(client);
    await makeRunner(client, { mode: value }).execute(INPUT);
    assert.deepEqual(paramsOf(client, SET_MODE), [{ sessionId: "s1", modeId: value }]);
  }
});

test("M1-mode / M1-collab：未配 ⇒ 零请求（方法序列与现状逐字一致）", async () => {
  const client = new FakeClient();
  const methods = wire(client);

  await makeRunner(client).execute(INPUT);

  assert.deepEqual(paramsOf(client, SET_MODE), []);
  assert.deepEqual(paramsOf(client, SET_CONFIG), []);
  assert.deepEqual(methods, ["session/new", "session/prompt"]);
});

test("M1-mode / M1-collab：空串 / 非字符串 ⇒ 归一化为未配置（零请求）", async () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["空串", ""],
    ["数字", 42],
    ["null", null],
    ["undefined", undefined],
  ];
  for (const [name, value] of cases) {
    const client = new FakeClient();
    const methods = wire(client);
    await makeRunner(client, { mode: value, collaborationMode: value }).execute(INPUT);
    assert.deepEqual(paramsOf(client, SET_MODE), [], `「${name}」不得发 set_mode`);
    assert.deepEqual(paramsOf(client, SET_CONFIG), [], `「${name}」不得发 set_config_option`);
    assert.deepEqual(methods, ["session/new", "session/prompt"], `「${name}」序列应回到现状`);
  }
});

test("M1-mode：仅 -32601 回落 set_config_option{configId:\"mode\"}（回落成功 ⇒ 不失败）", async () => {
  const client = new FakeClient();
  const logs: string[] = [];
  const methods = wire(client, { failures: [[SET_MODE, -32601]] });

  const result = await makeRunner(client, { mode: "read-only", logger: (m) => logs.push(m) }).execute(
    INPUT,
  );

  assert.equal(result.state, "completed");
  assert.deepEqual(methods, ["session/new", SET_MODE, SET_CONFIG, "session/prompt"]);
  assert.deepEqual(paramsOf(client, SET_CONFIG), [
    { sessionId: "s1", configId: "mode", value: "read-only" },
  ]);
  assert.equal(logs.filter((l) => l.includes("设置失败")).length, 0, logs.join("\n"));
  assert.equal(
    logs.filter((l) => l.includes("mode=read-only") && l.includes("已设置")).length,
    1,
    logs.join("\n"),
  );
});

test("M1-mode：非 -32601 错误**不回落** ⇒ fail-fast（任务 failed、不发 prompt、不触 set_config_option）", async () => {
  const client = new FakeClient();
  const logs: string[] = [];
  const methods = wire(client, { failures: [[SET_MODE, -32602]] });

  const result = await makeRunner(client, { mode: "read-only", logger: (m) => logs.push(m) }).execute(
    INPUT,
  );

  assert.equal(result.state, "failed");
  const reason = result.text ?? "";
  assert.ok(reason.includes("read-only"), `任务原因须含配置原值：${reason}`);
  assert.ok(reason.includes("设置失败"), `任务原因须可读：${reason}`);
  assert.ok(reason.includes("-32602"), `任务原因须含后端 code：${reason}`);
  assert.deepEqual(methods, ["session/new", SET_MODE], "非 -32601 不得回落、不得继续 prompt");
  assert.deepEqual(paramsOf(client, SET_CONFIG), []);
  assert.equal(
    logs.filter((l) => l.includes("mode=read-only 设置失败") && l.includes("-32602")).length,
    1,
    logs.join("\n"),
  );
});

test("M1-mode：回落路径再失败 ⇒ 同样 fail-fast（不静默回落）", async () => {
  const client = new FakeClient();
  const logs: string[] = [];
  const methods = wire(client, {
    failures: [
      [SET_MODE, -32601],
      [SET_CONFIG, -32602],
    ],
  });

  const result = await makeRunner(client, { mode: "read-only", logger: (m) => logs.push(m) }).execute(
    INPUT,
  );

  assert.equal(result.state, "failed");
  assert.ok((result.text ?? "").includes("mode=read-only"), result.text);
  assert.deepEqual(methods, ["session/new", SET_MODE, SET_CONFIG]);
  assert.equal(logs.filter((l) => l.includes("mode=read-only 设置失败")).length, 1, logs.join("\n"));
});

test("M1-mode：load / resume / new 三路均下发 set_mode（恢复路径不假设后端保持）", async () => {
  // load 复用
  const c1 = new FakeClient();
  const m1 = wire(c1, { sessionId: "old-sess" });
  await makeRunner(c1, { mode: "plan", sessions: cachedSessions() }).execute(INPUT);
  assert.deepEqual(m1, ["session/load", SET_MODE, "session/prompt"]);
  assert.deepEqual(paramsOf(c1, SET_MODE), [{ sessionId: "old-sess", modeId: "plan" }]);

  // resume 复用（load 失败回落；load 的失败是「不可用」⇒ -32601 语义，仅用于构造路径）
  const c2 = new FakeClient();
  const m2 = wire(c2, { sessionId: "old-sess", failures: [["session/load", -32601]] });
  await makeRunner(c2, { mode: "plan", sessions: cachedSessions() }).execute(INPUT);
  assert.deepEqual(m2, ["session/load", "session/resume", SET_MODE, "session/prompt"]);
  assert.deepEqual(paramsOf(c2, SET_MODE), [{ sessionId: "old-sess", modeId: "plan" }]);

  // new（load + resume 双失败）
  const c3 = new FakeClient();
  const m3 = wire(c3, {
    sessionId: "fresh",
    failures: [
      ["session/load", -32601],
      ["session/resume", -32601],
    ],
  });
  await makeRunner(c3, { mode: "plan", sessions: cachedSessions() }).execute(INPUT);
  assert.deepEqual(m3, ["session/load", "session/resume", "session/new", SET_MODE, "session/prompt"]);
  assert.deepEqual(paramsOf(c3, SET_MODE), [{ sessionId: "fresh", modeId: "plan" }]);
});

/* ---------------- collaboration_mode ---------------- */

test("M1-collab：只走 set_config_option{configId:\"collaboration_mode\"}，不涉 set_mode", async () => {
  const client = new FakeClient();
  const methods = wire(client);

  const result = await makeRunner(client, { collaborationMode: "plan" }).execute(INPUT);

  assert.equal(result.state, "completed");
  assert.deepEqual(methods, ["session/new", SET_CONFIG, "session/prompt"]);
  assert.deepEqual(paramsOf(client, SET_CONFIG), [
    { sessionId: "s1", configId: "collaboration_mode", value: "plan" },
  ]);
  assert.deepEqual(paramsOf(client, SET_MODE), []);
});

test("M1-collab：失败 ⇒ fail-fast，且不回落 set_mode（它不在 modes 里）", async () => {
  const client = new FakeClient();
  const logs: string[] = [];
  const methods = wire(client, { failures: [[SET_CONFIG, -32601]] });

  const result = await makeRunner(client, {
    collaborationMode: "plan",
    logger: (m) => logs.push(m),
  }).execute(INPUT);

  assert.equal(result.state, "failed");
  assert.ok((result.text ?? "").includes("collaboration_mode=plan"), result.text);
  assert.deepEqual(methods, ["session/new", SET_CONFIG]);
  assert.deepEqual(paramsOf(client, SET_MODE), []);
  assert.equal(
    logs.filter((l) => l.includes("collaboration_mode=plan 设置失败")).length,
    1,
    logs.join("\n"),
  );
});

/* ---------------- session-meta ---------------- */

test("M1-session-meta：new / load / resume 三路统一携带 _meta（逐字）", async () => {
  // new
  const c1 = new FakeClient();
  wire(c1);
  await makeRunner(c1, { sessionMeta: META }).execute(INPUT);
  const newParams = paramsOf(c1, "session/new")[0] as Record<string, unknown>;
  assert.deepEqual(newParams["_meta"], META);

  // load（复用路径）
  const c2 = new FakeClient();
  wire(c2, { sessionId: "old-sess" });
  await makeRunner(c2, { sessionMeta: META, sessions: cachedSessions() }).execute(INPUT);
  const loadParams = paramsOf(c2, "session/load")[0] as Record<string, unknown>;
  assert.deepEqual(loadParams["_meta"], META);
  assert.equal(loadParams["cwd"], "/ws", "load 仍带 cwd（未破坏既有形状）");

  // resume（load 失败回落路径）
  const c3 = new FakeClient();
  wire(c3, { sessionId: "old-sess", failures: [["session/load", -32601]] });
  await makeRunner(c3, { sessionMeta: META, sessions: cachedSessions() }).execute(INPUT);
  const resumeParams = paramsOf(c3, "session/resume")[0] as Record<string, unknown>;
  assert.deepEqual(resumeParams["_meta"], META);
});

test("M1-session-meta：未配 ⇒ 三路均不携带 _meta 键（零注入）", async () => {
  const c1 = new FakeClient();
  wire(c1);
  await makeRunner(c1).execute(INPUT);
  const newParams = paramsOf(c1, "session/new")[0] as Record<string, unknown>;
  assert.equal("_meta" in newParams, false);

  const c2 = new FakeClient();
  wire(c2, { sessionId: "old-sess" });
  await makeRunner(c2, { sessions: cachedSessions() }).execute(INPUT);
  const loadParams = paramsOf(c2, "session/load")[0] as Record<string, unknown>;
  assert.equal("_meta" in loadParams, false);

  const c3 = new FakeClient();
  wire(c3, { sessionId: "old-sess", failures: [["session/load", -32601]] });
  await makeRunner(c3, { sessions: cachedSessions() }).execute(INPUT);
  const resumeParams = paramsOf(c3, "session/resume")[0] as Record<string, unknown>;
  assert.equal("_meta" in resumeParams, false);
});

/* ---------------- CLI 解析面 ---------------- */

test("M1-session-meta：parseSessionMetaArg 缺省 / 空串 ⇒ undefined；非法 JSON / 非对象 ⇒ 抛错", () => {
  assert.equal(parseSessionMetaArg(undefined), undefined);
  assert.equal(parseSessionMetaArg(""), undefined);
  assert.deepEqual(parseSessionMetaArg('{"a":1}'), { a: 1 });
  assert.deepEqual(
    parseSessionMetaArg(
      '{"claudeCode":{"options":{"allowDangerouslySkipPermissions":true}}}',
    ),
    META,
  );
  assert.throws(() => parseSessionMetaArg("{not json"), /不是合法 JSON/);
  assert.throws(() => parseSessionMetaArg('["a"]'), /必须是 JSON 对象/);
  assert.throws(() => parseSessionMetaArg('"x"'), /必须是 JSON 对象/);
  assert.throws(() => parseSessionMetaArg("null"), /必须是 JSON 对象/);
});

test("M1：parseBridgeArgs 新增 --mode / --collaboration-mode / --session-meta-json（未给 ⇒ 键缺席）", () => {
  const common = ["--port", "4100", "--workspace", "/ws", "--project-id", "p1", "--backend-cmd", "b"];

  const withFlags = parseBridgeArgs([
    ...common,
    "--mode",
    "read-only",
    "--collaboration-mode",
    "plan",
    "--session-meta-json",
    '{"a":1}',
  ]);
  assert.equal(withFlags.mode, "read-only");
  assert.equal(withFlags.collaborationMode, "plan");
  assert.deepEqual(withFlags.sessionMeta, { a: 1 });

  const without = parseBridgeArgs(common);
  assert.equal("mode" in without, false);
  assert.equal("collaborationMode" in without, false);
  assert.equal("sessionMeta" in without, false);
});

test("M1：parseBridgeArgs 三新 flag 空串 ⇒ 与未配等价（不下发）", () => {
  const common = ["--port", "4100", "--workspace", "/ws", "--project-id", "p1", "--backend-cmd", "b"];
  const args = parseBridgeArgs([
    ...common,
    "--mode",
    "",
    "--collaboration-mode",
    "",
    "--session-meta-json",
    "",
  ]);
  assert.equal("mode" in args, false);
  assert.equal("collaborationMode" in args, false);
  assert.equal("sessionMeta" in args, false);
});

/* ---------------- 桥装配（BridgeArgs ⇒ 会话建立，真走 ACP 报文） ---------------- */

/** 最小 fake 子进程：stdin 收 NDJSON，initialize 固定应答。 */
class FakeChild implements AcpChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly lines: Array<Record<string, unknown>> = [];
  responder:
    | ((method: string, params: Record<string, unknown>) => Record<string, unknown> | undefined)
    | undefined;
  private readonly exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
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
        if (message["method"] === "initialize") {
          this.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: message["id"], result: { protocolVersion: 1 } })}\n`,
          );
          continue;
        }
        if (this.responder === undefined || message["id"] === undefined) continue;
        const result = this.responder(
          String(message["method"]),
          (message["params"] ?? {}) as Record<string, unknown>,
        );
        if (result !== undefined) {
          this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message["id"], result })}\n`);
        }
      }
    });
  }

  kill(): boolean {
    return true;
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exits.push(listener);
  }

  onError(_listener: (error: Error) => void): void {
    return undefined;
  }
}

function makeSpawn(): { spawn: AcpSpawn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawn: AcpSpawn = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawn, children };
}

/** 真实临时目录作 workspace：`startBridge` 会以它建 `SessionMap`（落盘 acp-sessions）。 */
const DIR = mkdtempSync(join(tmpdir(), "a2a-acp-m1-mode-"));

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

test("M1 桥装配：mode / collaborationMode / sessionMeta 经 startBridge 透传到会话建立", async () => {
  const { spawn, children } = makeSpawn();
  const running = await startBridge(
    baseArgs({ mode: "read-only", collaborationMode: "plan", sessionMeta: META }),
    { spawn, logger: () => undefined },
  );
  try {
    const child = children[0];
    assert.ok(child !== undefined, "应 spawn 一个 fake 后端");
    const seen: string[] = [];
    child.responder = (method, params) => {
      seen.push(method);
      if (method === "session/new") return { sessionId: "s-1" };
      if (method === SET_MODE) return { modes: { currentModeId: String(params["modeId"]) } };
      if (method === SET_CONFIG) {
        return {
          configOptions: [
            { id: String(params["configId"]), currentValue: String(params["value"]) },
          ],
        };
      }
      if (method === "session/prompt") {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-1",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "ok" },
              },
            },
          })}\n`,
        );
        return { stopReason: "end_turn" };
      }
      return {};
    };

    const result = await running.runner.execute(INPUT);

    assert.equal(result.state, "completed");
    assert.deepEqual(seen, ["session/new", SET_MODE, SET_CONFIG, "session/prompt"]);
    assert.deepEqual(child.lines.find((l) => l["method"] === "session/new")?.["params"], {
      cwd: DIR,
      mcpServers: [],
      _meta: META,
    });
    assert.deepEqual(child.lines.find((l) => l["method"] === SET_MODE)?.["params"], {
      sessionId: "s-1",
      modeId: "read-only",
    });
    const collab = child.lines.filter(
      (l) =>
        l["method"] === SET_CONFIG &&
        (l["params"] as Record<string, unknown>)["configId"] === "collaboration_mode",
    );
    assert.deepEqual(collab[0]?.["params"], {
      sessionId: "s-1",
      configId: "collaboration_mode",
      value: "plan",
    });
  } finally {
    await running.client.close();
  }
});
