/**
 * `machine/acp-bridge/` M1 定向单测（REQ-v0.8.1-2026-09-19-01 · 节点 M1）。
 *
 * 判据：
 * - `--backend-args`：parseBackendArgs（缺省 / 合法 / 非法）与 parseBridgeArgs 透传；
 *   startBridge 实际 spawn 参数 —— 缺省 `["--acp"]`（qoder v0.8.0 逐字不变）与自定义数组；
 * - `--config-file` + `--config-segment`：readConfigSegment 全部容忍路径（缺文件 / 缺段 /
 *   坏 JSON / 顶层非对象 / 段非对象 ⇒ 告警不抛错、取空）与正常读取；startBridge 落 `config`；
 * - `AcpClient.notify`：无 `id` 的 NDJSON 通知出口；关闭后静默丢弃。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  DEFAULT_BACKEND_ARGS,
  parseBackendArgs,
  parseBridgeArgs,
  parseModelArg,
  readConfigSegment,
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

function writeJson(name: string, content: string): string {
  const path = join(DIR, name);
  writeFileSync(path, content, "utf8");
  return path;
}

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

// ---------- ② --config-file + --config-segment ----------

test("readConfigSegment：未给 configFile ⇒ 空对象且不告警", () => {
  const warnings: string[] = [];
  assert.deepEqual(readConfigSegment({ logger: (m) => warnings.push(m) }), {});
  assert.deepEqual(readConfigSegment({ configFile: "", logger: (m) => warnings.push(m) }), {});
  assert.deepEqual(warnings, []);
});

test("readConfigSegment：正常读取指定段", () => {
  const path = writeJson("ok.json", JSON.stringify({ opencode: { systemPrompt: "x" }, qoder: { a: 1 } }));
  const warnings: string[] = [];
  assert.deepEqual(
    readConfigSegment({ configFile: path, configSegment: "opencode", logger: (m) => warnings.push(m) }),
    { systemPrompt: "x" },
  );
  assert.deepEqual(warnings, []);
});

test("readConfigSegment：容忍路径全谱 ⇒ 一律告警（除缺 segment 外均取空）不抛错", () => {
  const collect = (opts: Parameters<typeof readConfigSegment>[0]): { config: Record<string, unknown>; warnings: string[] } => {
    const warnings: string[] = [];
    const config = readConfigSegment({ ...opts, logger: (m) => warnings.push(m) });
    return { config, warnings };
  };
  const missingFile = collect({ configFile: join(DIR, "nope.json"), configSegment: "opencode" });
  assert.deepEqual(missingFile.config, {});
  assert.equal(missingFile.warnings.length, 1);

  const noSegment = collect({ configFile: join(DIR, "ok.json") });
  assert.deepEqual(noSegment.config, {});
  assert.equal(noSegment.warnings.length, 1);

  const badJson = collect({
    configFile: writeJson("bad.json", "{oops"),
    configSegment: "opencode",
  });
  assert.deepEqual(badJson.config, {});
  assert.equal(badJson.warnings.length, 1);

  const topLevelArray = collect({
    configFile: writeJson("arr.json", "[1,2]"),
    configSegment: "opencode",
  });
  assert.deepEqual(topLevelArray.config, {});
  assert.equal(topLevelArray.warnings.length, 1);

  const missingSegment = collect({ configFile: join(DIR, "ok.json"), configSegment: "absent" });
  assert.deepEqual(missingSegment.config, {});
  assert.equal(missingSegment.warnings.length, 1);

  const segmentNotObject = collect({
    configFile: writeJson("scalar.json", JSON.stringify({ opencode: "just-a-string" })),
    configSegment: "opencode",
  });
  assert.deepEqual(segmentNotObject.config, {});
  assert.equal(segmentNotObject.warnings.length, 1);
});

test("parseBridgeArgs：--config-file / --config-segment 解析；未给则键缺席", () => {
  const common = ["--port", "4100", "--workspace", "/ws", "--project-id", "p1", "--backend-cmd", "b"];
  const withConfig = parseBridgeArgs([...common, "--config-file", "/cfg/p.json", "--config-segment", "opencode"]);
  assert.equal(withConfig.configFile, "/cfg/p.json");
  assert.equal(withConfig.configSegment, "opencode");
  const without = parseBridgeArgs(common);
  assert.equal(without.configFile, undefined);
  assert.equal(without.configSegment, undefined);
});

test("startBridge：config 落解析段；未给配置面 ⇒ 空对象", async () => {
  const { spawn } = makeSpawn();
  const path = writeJson("bridge.json", JSON.stringify({ opencode: { systemPromptMode: "append" } }));
  const withConfig = await startBridge(baseArgs({ configFile: path, configSegment: "opencode" }), {
    spawn,
    logger: () => undefined,
  });
  try {
    assert.deepEqual(withConfig.config, { systemPromptMode: "append" });
  } finally {
    await withConfig.client.close();
  }
  const bare = await startBridge(baseArgs(), { spawn, logger: () => undefined });
  try {
    assert.deepEqual(bare.config, {});
  } finally {
    await bare.client.close();
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
