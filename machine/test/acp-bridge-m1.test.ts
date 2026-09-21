/**
 * `machine/acp-bridge/` M1 定向单测（REQ-v0.8.1-2026-09-19-01 · 节点 M1）。
 *
 * 判据：
 * - `--backend-args`：parseBackendArgs（缺省 / 合法 / 非法）与 parseBridgeArgs 透传；
 *   startBridge 实际 spawn 参数 —— 缺省 `["--acp"]`（qoder v0.8.0 逐字不变）与自定义数组；
 * - `--system-prompt` + `--system-prompt-mode`：parseBridgeArgs 解析（缺省 / 空串 / 非法值 ⇒ 键缺席）；
 * - `AcpClient.notify`：无 `id` 的 NDJSON 通知出口；关闭后静默丢弃。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  DEFAULT_BACKEND_ARGS,
  parseBackendArgs,
  parseBridgeArgs,
  parseModelArg,
  startBridge,
  type BridgeArgs,
} from "../acp-bridge/index.js";
import { AcpClient } from "../acp-bridge/acp/client.js";
import type { AcpChildProcess, AcpSpawn } from "../acp-bridge/acp/types.js";

/** 最小 fake 子进程：stdin 收 NDJSON，initialize 应答固定 result。 */
class FakeChild implements AcpChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly lines: Array<Record<string, unknown>> = [];
  /**
   * `initialize` 之外的应答钩子（返回 `undefined` ⇒ 不应答）；
   * REQ-v0.8.2 · M1（协议面增补）用例据此观测桥实际写出的 ACP 请求。
   */
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
          this.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: message["id"], result })}\n`,
          );
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

function makeSpawn(): { spawn: AcpSpawn; spawned: string[][]; children: FakeChild[] } {
  const spawned: string[][] = [];
  const children: FakeChild[] = [];
  const spawn: AcpSpawn = (_command, args) => {
    spawned.push([...args]);
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawn, spawned, children };
}

const DIR = mkdtempSync(join(tmpdir(), "a2a-acp-m1-"));

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

// ---------- ① --backend-args ----------

test("parseBackendArgs：缺省 undefined / 合法 JSON 字符串数组 / 空数组", () => {
  assert.equal(parseBackendArgs(undefined), undefined);
  assert.deepEqual(parseBackendArgs('["--acp"]'), ["--acp"]);
  assert.deepEqual(parseBackendArgs('["acp"]'), ["acp"]);
  assert.deepEqual(parseBackendArgs("[]"), []);
});

test("parseBackendArgs：坏 JSON / 非数组 / 含非字符串 ⇒ 抛错", () => {
  assert.throws(() => parseBackendArgs("{not json"), /不是合法 JSON/);
  assert.throws(() => parseBackendArgs('{"a":1}'), /JSON 字符串数组/);
  assert.throws(() => parseBackendArgs('["ok",3]'), /JSON 字符串数组/);
});

test("parseBridgeArgs：--backend-args 透传为数组；未给则键缺席（由 startBridge 落缺省）", () => {
  const common = ["--port", "4100", "--workspace", "/ws", "--project-id", "p1", "--backend-cmd", "b"];
  const withArgs = parseBridgeArgs([...common, "--backend-args", '["acp"]']);
  assert.deepEqual(withArgs.backendArgs, ["acp"]);
  const without = parseBridgeArgs(common);
  assert.equal(without.backendArgs, undefined);
});

test("parseBridgeArgs：--system-prompt / --system-prompt-mode 解析；未给 / 非法 ⇒ 键缺席", () => {
  const common = ["--port", "4100", "--workspace", "/ws", "--project-id", "p1", "--backend-cmd", "b"];
  const withInjection = parseBridgeArgs([
    ...common,
    "--system-prompt",
    "be terse",
    "--system-prompt-mode",
    "replace",
  ]);
  assert.equal(withInjection.systemPrompt, "be terse");
  assert.equal(withInjection.systemPromptMode, "replace");
  const without = parseBridgeArgs(common);
  assert.equal(without.systemPrompt, undefined);
  assert.equal(without.systemPromptMode, undefined);
  assert.equal(
    parseBridgeArgs([...common, "--system-prompt-mode", "bogus"]).systemPromptMode,
    undefined,
  );
});

test("startBridge spawn 实参：缺省 = [\"--acp\"]（qoder v0.8.0 逐字不变）", async () => {
  const { spawn, spawned } = makeSpawn();
  const running = await startBridge(baseArgs(), { spawn, logger: () => undefined });
  try {
    assert.deepEqual(spawned[0], [...DEFAULT_BACKEND_ARGS, ]);
    assert.deepEqual(DEFAULT_BACKEND_ARGS as readonly string[], ["--acp"]);
  } finally {
    await running.client.close();
  }
});

test("startBridge spawn 实参：自定义 backendArgs（opencode [\"acp\"]）覆盖缺省", async () => {
  const { spawn, spawned } = makeSpawn();
  const running = await startBridge(baseArgs({ backendArgs: ["acp"] }), {
    spawn,
    logger: () => undefined,
  });
  try {
    assert.deepEqual(spawned[0], ["acp"]);
  } finally {
    await running.client.close();
  }
});

// ---------- ③ AcpClient.notify ----------

test("AcpClient.notify：写出无 id 的 NDJSON 通知；params 缺省时省略该键", () => {
  const fake = new FakeChild();
  const client = new AcpClient({ command: "b", spawn: () => fake, env: {} });
  client.notify("session/cancel", { sessionId: "s1" });
  client.notify("initialized");
  assert.deepEqual(fake.lines.at(-2), { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
  assert.deepEqual(fake.lines.at(-1), { jsonrpc: "2.0", method: "initialized" });
  assert.equal("id" in (fake.lines.at(-1) ?? {}), false);
});

test("AcpClient.notify：关闭后静默丢弃（不写出、不抛错）", async () => {
  const fake = new FakeChild();
  const client = new AcpClient({ command: "b", spawn: () => fake, env: {} });
  await client.close();
  client.notify("session/cancel", { sessionId: "s1" });
  assert.deepEqual(fake.lines, []);
});

// ---------- ④ --model（REQ-v0.8.2-2026-09-20-01 · M1 协议面增补） ----------

test("parseModelArg：缺省 / 空串 ⇒ undefined；非空原样（不校验取值）", () => {
  assert.equal(parseModelArg(undefined), undefined);
  assert.equal(parseModelArg(""), undefined);
  assert.equal(parseModelArg("provider/model-x"), "provider/model-x");
  assert.equal(parseModelArg("显示名也原样送"), "显示名也原样送");
});

test("parseBridgeArgs：--model 解析为 args.model；未给则键缺席", () => {
  const common = ["--port", "4100", "--workspace", "/ws", "--project-id", "p1", "--backend-cmd", "b"];
  assert.equal(parseBridgeArgs([...common, "--model", "m1"]).model, "m1");
  const without = parseBridgeArgs(common);
  assert.equal(without.model, undefined);
  assert.equal("model" in without, false);
});

/** 让 fake 后端应答会话建立 + set + prompt，返回其收到的 set 参数。 */
function wireBackend(child: FakeChild, sessionId = "s-remote"): Array<Record<string, unknown>> {
  const sets: Array<Record<string, unknown>> = [];
  child.responder = (method, params) => {
    if (method === "session/new") {
      return { sessionId, configOptions: [{ id: "model", type: "select", currentValue: "default" }] };
    }
    if (method === "session/set_config_option") {
      sets.push(params);
      return { currentValue: String(params["value"]) };
    }
    if (method === "session/prompt") return { stopReason: "end_turn" };
    return {};
  };
  return sets;
}

test("startBridge --model ⇒ 会话建立后桥向后端发出 set_config_option（value 逐字 = 配置值）", async () => {
  const { spawn, children } = makeSpawn();
  const running = await startBridge(baseArgs({ model: "provider/model-x" }), {
    spawn,
    logger: () => undefined,
  });
  try {
    const sets = wireBackend(children[0] as FakeChild);
    const result = await running.runner.execute({
      taskId: "t1",
      text: "hi",
      contextId: "ctx-with-model",
      messageId: "m1",
    });
    assert.equal(result.state, "completed");
    assert.deepEqual(sets, [{ sessionId: "s-remote", configId: "model", value: "provider/model-x" }]);
  } finally {
    await running.client.close();
  }
});

test("startBridge 未给 --model ⇒ 后端收不到任何 set_config_option（现状逐字一致）", async () => {
  const { spawn, children } = makeSpawn();
  const running = await startBridge(baseArgs(), { spawn, logger: () => undefined });
  try {
    const sets = wireBackend(children[0] as FakeChild);
    await running.runner.execute({
      taskId: "t1",
      text: "hi",
      contextId: "ctx-no-model",
      messageId: "m1",
    });
    assert.deepEqual(sets, []);
    assert.deepEqual(
      (children[0] as FakeChild).lines
        .map((l) => String(l["method"]))
        .filter((m) => m.startsWith("session/")),
      ["session/new", "session/prompt"],
    );
  } finally {
    await running.client.close();
  }
});

// ---------- ⑤ --system-prompt / --system-prompt-mode（REQ-v0.8.5-2026-09-21-01 · M4） ----------

test("startBridge --system-prompt（replace）⇒ 首轮 prompt 前缀 = 自定义注入（替换缺省约定）", async () => {
  const { spawn, children } = makeSpawn();
  const running = await startBridge(
    baseArgs({ systemPrompt: "be terse", systemPromptMode: "replace" }),
    { spawn, logger: () => undefined },
  );
  try {
    wireBackend(children[0] as FakeChild);
    const result = await running.runner.execute({
      taskId: "t1",
      text: "任务",
      contextId: "ctx-injection",
      messageId: "m1",
    });
    assert.equal(result.state, "completed");
    const prompt = (children[0] as FakeChild).lines.find(
      (l) => String(l["method"]) === "session/prompt",
    );
    const params = (prompt?.["params"] ?? {}) as { prompt?: Array<{ text?: string }> };
    assert.equal(params.prompt?.[0]?.text, "be terse\n\n---\n\n任务");
  } finally {
    await running.client.close();
  }
});
