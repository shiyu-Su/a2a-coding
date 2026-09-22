/**
 * `machine/acp-bridge/` 会话超时参数面单测（v0.8.7 · 节点 M1）。
 *
 * 判据：
 * - `parseSessionTimeoutArg`：合法正整数原样；非整数 / ≤ 0 / 非数字 ⇒ 抛错（宽松校验，纪律同 `--port`）；
 *   缺省 ⇒ `undefined`；**桥侧不做上限校验**（上限单一源在 launcher 项目解析处）。
 * - `parseBridgeArgs`：`--session-timeout` ⇒ `args.sessionTimeoutMs`；未给 ⇒ 键缺席。
 * - `startBridge` 三点一线：`args.sessionTimeoutMs ?? deps.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS`
 *   （以前两者为可观测断言：fake 后端不应答 `session/prompt`，超时文本内嵌生效毫秒数；
 *    末项即既有缺省，由 `AcpSessionRunner` 自身缺省覆盖，不宜在单测里真等 600s）。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { parseBridgeArgs, parseSessionTimeoutArg, startBridge, type BridgeArgs } from "../acp-bridge/index.js";
import type { AcpChildProcess, AcpSpawn } from "../acp-bridge/acp/types.js";

/** 最小 fake 后端：应答 `initialize` / `session/new`，其余请求不应答（⇒ 让超时发生）。 */
class SilentChild implements AcpChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor() {
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as { id?: unknown; method?: string };
        if (message.id === undefined) continue;
        const result =
          message.method === "initialize"
            ? { protocolVersion: 1 }
            : message.method === "session/new"
              ? { sessionId: "s-remote", configOptions: [] }
              : undefined;
        if (result !== undefined) {
          this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
        }
      }
    });
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

const DIR = mkdtempSync(join(tmpdir(), "a2a-acp-timeout-"));

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

/** 拉起桥 → 执行一个永不应答的任务 → 返回超时文本（内嵌生效超时毫秒数）。 */
async function timeoutText(args: BridgeArgs, deps: { sessionTimeoutMs?: number } = {}): Promise<string> {
  const spawn: AcpSpawn = () => new SilentChild();
  const running = await startBridge(args, { spawn, logger: () => undefined, ...deps });
  try {
    const result = await running.runner.execute({
      taskId: "t1",
      text: "hi",
      contextId: "ctx-timeout",
      messageId: "m1",
    });
    assert.equal(result.state, "failed");
    return String(result.text);
  } finally {
    await running.client.close();
  }
}

// ---------- ① parseSessionTimeoutArg ----------

test("parseSessionTimeoutArg：缺省 undefined；正整数原样（含超上限值 —— 桥侧不校验上限）", () => {
  assert.equal(parseSessionTimeoutArg(undefined), undefined);
  assert.equal(parseSessionTimeoutArg("50"), 50);
  assert.equal(parseSessionTimeoutArg("900000"), 900000);
  assert.equal(parseSessionTimeoutArg("999999999"), 999999999);
});

test("parseSessionTimeoutArg：空串 / 非数字 / 小数 / 0 / 负数 ⇒ 抛错", () => {
  for (const raw of ["", "abc", "1.5", "0", "-1"]) {
    assert.throws(() => parseSessionTimeoutArg(raw), /--session-timeout/, `raw=${raw}`);
  }
});

// ---------- ② parseBridgeArgs 透传 ----------

test("parseBridgeArgs：--session-timeout ⇒ args.sessionTimeoutMs；未给 ⇒ 键缺席；非法 ⇒ 抛错", () => {
  const common = [
    "--port",
    "4100",
    "--workspace",
    "/ws",
    "--project-id",
    "p1",
    "--backend-cmd",
    "b",
  ];
  assert.equal(parseBridgeArgs([...common, "--session-timeout", "30000"]).sessionTimeoutMs, 30000);
  const without = parseBridgeArgs(common);
  assert.equal(without.sessionTimeoutMs, undefined);
  assert.equal("sessionTimeoutMs" in without, false);
  assert.throws(() => parseBridgeArgs([...common, "--session-timeout", "0"]), /--session-timeout/);
});

// ---------- ③ startBridge 三点一线 ----------

test("startBridge：args.sessionTimeoutMs 生效，且优先于 deps.sessionTimeoutMs", async () => {
  const text = await timeoutText(baseArgs({ sessionTimeoutMs: 50 }), { sessionTimeoutMs: 60000 });
  assert.match(text, /超过 50ms/);
});

test("startBridge：未给 args.sessionTimeoutMs ⇒ 落 deps.sessionTimeoutMs（原有注入通道不变）", async () => {
  const text = await timeoutText(baseArgs(), { sessionTimeoutMs: 60 });
  assert.match(text, /超过 60ms/);
});
