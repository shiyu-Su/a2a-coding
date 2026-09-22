/**
 * `machine/acp-bridge/acp/session.ts` 定向单测（REQ-v0.8.0-2026-09-19-01 · 节点 B3）。
 *
 * 判据：new 成功 / resume 失败回退 new / update 流式拼接 / 超时 → failed / 后端中途退出 → failed。
 * fake 客户端经构造注入。
 *
 * **v0.8.7 · M4** 追加：三处失败出口各带 `machine-diagnostics` artifact（字段齐全 + 取值口径）·
 * `chunkCount` = 本轮实测 `agent_message_chunk` 数（thought / 窗外不计、不跨轮泄漏）·
 * 正常完成路径不带 diagnostics · 与 launcher 摘除侧的字面量 / 解析契约。
 *
 * **v0.8.8 · M1** 追加：三原料计量（`partialChars` / `updateCount` / `firstChunkElapsedMs`，
 * 事实缺失即**不报该键**）· `elapsedMs` → `promptElapsedMs` 改名 · 两段耗时（含 `bridgeEnsureElapsedMs`）·
 * 取证面 `acpErrorCode` / `acpErrorData`（**`data` 必须真的出现在产物里**）· 半截产出「取出再弃」
 * （尾部快照 + 4000 字符截断 + 取后仍弃窗）· `sessionResumed` 三路回标（回落 new ⇒ false + 日志）·
 * `reasonOf` 单一实现（applyModel 侧不得逐字复制）· launcher 白名单**尚未放行**新键（M2 依赖，留证据）。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AcpError } from "../acp-bridge/acp/client.js";
import {
  AcpSessionRunner,
  DIAGNOSTICS_ARTIFACT_NAME,
  DIAGNOSTICS_PARTIAL_TAIL_MAX_CHARS,
  type AcpRequestClient,
} from "../acp-bridge/acp/session.js";
import type { TaskExecutionResult } from "../acp-bridge/types.js";
import {
  DIAGNOSTICS_ARTIFACT_NAME as LAUNCHER_DIAGNOSTICS_ARTIFACT_NAME,
  splitDiagnosticsArtifact,
} from "../launcher/runner-exec.js";
import { SessionMap, type SessionMapFs } from "../acp-bridge/session-map.js";
import { A2A_OUTCOME_CONVENTION } from "../acp-bridge/outcome.js";

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

// 注：`tasks/cancel` 全链路（含 stub 侧 session/cancel 接收）由 B7 端到端集成覆盖（`acp-bridge-e2e.test.ts`）。

test("M1③ cancel：session/cancel 走 notification 形态（不再 request，不等响应）", async () => {
  const client = new FakeClient();
  client.responder = (method) =>
    method === "session/new" ? { sessionId: "s1" } : new Promise<never>(() => undefined);
  const r = runner(client, 60_000);
  void r.execute(INPUT); // 在飞 prompt（不 resolve），仅建立 taskId→sessionId 映射
  await new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
  await r.cancel("t1");
  assert.deepEqual(client.notifies, [{ method: "session/cancel", params: { sessionId: "s1" } }]);
  assert.ok(!client.calls.some((c) => c.method === "session/cancel"));
});

test("M3 会话侧：input-required / failed 透传 question / reason 短文", async () => {
  const client = new FakeClient();
  client.responder = (method, params) => {
    if (method === "session/new") return { sessionId: "s1" };
    const text = (params as { prompt: Array<{ text: string }> }).prompt[0]?.text ?? "";
    const reply = text.endsWith("FAIL")
      ? "无法完成。\n\n```a2a-outcome\n{\"state\":\"failed\",\"reason\":\"缺权限\"}\n```"
      : "需要先确认环境。\n\n```a2a-outcome\n{\"state\":\"input-required\",\"question\":\"需要先确认环境？\"}\n```";
    client.emit("session/update", {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } },
    });
    return { stopReason: "end_turn" };
  };
  const r = runner(client);

  const clarify = await r.execute(INPUT);
  assert.equal(clarify.state, "input-required");
  assert.equal(clarify.text, "需要先确认环境。");
  assert.equal(clarify.question, "需要先确认环境？");

  const broken = await r.execute({ ...INPUT, taskId: "t2", text: "FAIL" });
  assert.equal(broken.state, "failed");
  assert.equal(broken.text, "无法完成。");
  assert.equal(broken.reason, "缺权限");
});

test("M9 捕获窗：session/load 回灌的历史 backlog（load 响应前到达）不得污染本轮判定", async () => {
  const client = new FakeClient();
  const fs = new MemoryFs();
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs });
  sessions.set("ctx", "s1");

  let resolveLoad: ((value: unknown) => void) | undefined;
  const emitChunk = (text: string): void => {
    client.emit("session/update", {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
  };
  client.responder = (method) => {
    if (method === "session/load") {
      return new Promise((resolve) => {
        resolveLoad = resolve;
      });
    }
    if (method === "session/prompt") {
      emitChunk("本轮只给结论，无 outcome 块。");
      return { stopReason: "end_turn" };
    }
    return {};
  };

  const p = runner(client, 1000, sessions).execute(INPUT);
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  }); // load 请求已在飞（pending）
  // 取证坐实的污染载荷：历史轮遗留 input-required 块，在 load 响应前随 backlog 回灌
  emitChunk("上一轮遗留：\n\n```a2a-outcome\n{\"state\":\"input-required\",\"question\":\"该用哪个环境？\"}\n```");
  resolveLoad?.({}); // 再回 load 响应 → 本轮 prompt 开捕获窗
  const result = await p;
  assert.equal(result.state, "completed");
  assert.equal(result.text, "本轮只给结论，无 outcome 块。");
});

// ── M9-b / M9-c（REQ-v0.8.1-2026-09-19-01）轮边界：重放 id 集合 ────────────────────
// 取证（双后端）：
// - `qoderclicn` v1.1.57（M9-b 探针，仓外 %TEMP%/acp-m9b-probe，2026-09-20）：
//   实时流式 chunk 的 `update` 键集合恒为 `sessionUpdate+content`，**不带 messageId**；
//   `session/load` 回灌的历史重放**逐条带 messageId**（每条历史消息一个独立 id）；
//   回灌 flush 与 load 响应/本轮 prompt 写出**毫秒级交叠**（尾部可落进窗内）
//   ⇒ M9 捕获窗单独不足，须在窗内二次过滤。
// - opencode（M9-c 真机自检 + opencode 探针第 8 点）：**实时 chunk 本就带 messageId**
//   ⇒ M9-b 的「窗内带 id 一律丢弃」是 qodercn 专属方言，会把 opencode 整轮响应丢空。
// M9-c 收敛为普适规则：窗外（load/resume 期）出现过的 messageId 记入重放集合；
// 窗内 chunk 无 id ⇒ 保留；有 id 且在集合 ⇒ 丢弃；有 id 且不在集合 ⇒ 保留（本轮新消息）。

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 排空微任务 + 一个宏任务：确保 execute 已推进到「开窗 + prompt 在飞」。 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function block(state: string, key: string, value: string): string {
  return `\n\n\`\`\`a2a-outcome\n{"state":"${state}","${key}":"${value}"}\n\`\`\``;
}

/** 发一条 agent_message_chunk；`messageId` 省略 = qodercn 口径的「实时 chunk」。 */
function emitChunk(client: FakeClient, text: string, messageId?: string): void {
  client.emit("session/update", {
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      ...(messageId !== undefined ? { messageId } : {}),
      content: { type: "text", text },
    },
  });
}

/** 会话建立 + prompt 在飞的公共骨架（`session/new`，无回灌）：返回 prompt 的手动 resolve 句柄。 */
function inFlightPrompt(client: FakeClient): { prompt: Deferred<{ stopReason: string }> } {
  const prompt = deferred<{ stopReason: string }>();
  client.responder = (method) => {
    if (method === "session/new") return { sessionId: "s1" };
    if (method === "session/prompt") return prompt.promise;
    return {};
  };
  return { prompt };
}

/**
 * `session/load` 回灌骨架：返回 load / prompt 两个手动 resolve 句柄。
 * 用法：`execute()` → `settle()`（load 在飞 = 窗外，可 emit 重放）→ `load.resolve()`
 * → `settle()`（窗已开 + prompt 在飞，可 emit 交叠尾部与本轮 chunk）→ `prompt.resolve()`。
 */
function loadBackbone(client: FakeClient): {
  load: Deferred<unknown>;
  prompt: Deferred<{ stopReason: string }>;
} {
  const load = deferred<unknown>();
  const prompt = deferred<{ stopReason: string }>();
  client.responder = (method) => {
    if (method === "session/load") return load.promise;
    if (method === "session/prompt") return prompt.promise;
    return {};
  };
  return { load, prompt };
}

function cachedSessions(): SessionMap {
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new MemoryFs() });
  sessions.set("ctx", "s1");
  return sessions;
}

test("M9-b/c qodercn 形态：窗外登记过的重放 id，其落入窗内的尾部被丢弃；无 id 实时块保留", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  const { load, prompt } = loadBackbone(client);
  const p = runner(client, 1000, sessions).execute(INPUT);
  await settle();

  // 窗外（load 回灌期）：历史消息带 id 到达 ⇒ 丢弃，但 id 登记为重放 id
  emitChunk(client, `更早轮遗留：${block("failed", "reason", "缺权限")}`, "hist-old");
  emitChunk(client, `上一轮遗留：${block("input-required", "question", "该用哪个环境？")}`, "hist-1");
  load.resolve({});
  await settle();

  // 窗内：同 id 的重放尾部（毫秒级交叠）⇒ 丢弃；无 id ⇒ 本轮实时
  emitChunk(client, `上一轮遗留（尾部）：${block("input-required", "question", "该用哪个环境？")}`, "hist-1");
  emitChunk(client, "本轮结论：无需澄清。");
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  assert.equal(result.state, "completed");
  assert.equal(result.text, "本轮结论：无需澄清。");
});

test("M9-c opencode 形态：本轮实时 chunk 自带新 messageId，仍须保留（M9-b 旧判据会丢空）", async () => {
  const client = new FakeClient();
  const { prompt } = inFlightPrompt(client);
  const p = runner(client).execute(INPUT);
  await settle();

  emitChunk(client, "本轮", "msg-live-1"); // opencode：实时块带本轮新 id
  emitChunk(client, `只给结论。${block("completed", "note", "ok")}`, "msg-live-1");
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  assert.equal(result.state, "completed");
  assert.equal(result.text, "本轮只给结论。");
});

test("M9-c 交错形态：窗外登记的重放 id 块与带新 id 的本轮块交错，本轮 text 仅活块子集", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  const { load, prompt } = loadBackbone(client);
  const p = runner(client, 1000, sessions).execute(INPUT);
  await settle();

  emitChunk(client, `更早轮：${block("failed", "reason", "缺权限")}`, "hist-a");
  emitChunk(client, `上一轮：${block("input-required", "question", "历史问题")}`, "hist-b");
  load.resolve({});
  await settle();

  emitChunk(client, `尾部：${block("input-required", "question", "历史问题")}`, "hist-b");
  emitChunk(client, "需要拍板。", "msg-live-2");
  emitChunk(
    client,
    block("input-required", "question", "另一历史问题"),
    "hist-a",
  );
  emitChunk(client, block("input-required", "question", "本轮问题"), "msg-live-2");
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  assert.equal(result.state, "input-required");
  assert.equal(result.question, "本轮问题");
  assert.equal(result.text, "需要拍板。");
});

test("M9-c 自检等价场景：load 重放 1 条 + 本轮带 id 活块 ⇒ 响应文本非空（原为空文本 fail-fast）", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  const { load, prompt } = loadBackbone(client);
  const p = runner(client, 1000, sessions).execute(INPUT);
  await settle();

  emitChunk(client, `上一轮：${block("input-required", "question", "该用哪个环境？")}`, "hist-1");
  load.resolve({});
  await settle();

  emitChunk(client, `自检 OK。${block("completed", "note", "ok")}`, "msg-live-3");
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  assert.equal(result.state, "completed");
  assert.notEqual(result.text, "", "带 messageId 的实时块不得被整轮丢弃");
  assert.equal(result.text, "自检 OK。");
});

test("M9-b/c 不误伤：本轮无 id 实时块自带的 input-required 仍被判定，不被窗外登记过的重放块覆盖", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  const { load, prompt } = loadBackbone(client);
  const p = runner(client, 1000, sessions).execute(INPUT);
  await settle();

  emitChunk(client, `历史轮：${block("input-required", "question", "历史问题")}`, "hist-c");
  load.resolve({});
  await settle();

  emitChunk(client, block("input-required", "question", "历史问题"), "hist-c"); // 窗内尾部
  emitChunk(client, `需要拍板。${block("input-required", "question", "本轮问题")}`);
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  assert.equal(result.state, "input-required");
  assert.equal(result.question, "本轮问题");
  assert.equal(result.text, "需要拍板。");
});

test("M9-b/c 观测：窗内丢弃的历史重放条数经 logger 留痕（真机闭环取证用）", async () => {
  const client = new FakeClient();
  const logs: string[] = [];
  const sessions = cachedSessions();
  const { load, prompt } = loadBackbone(client);
  const r = new AcpSessionRunner({
    client,
    cwd: "/ws",
    timeoutMs: 1000,
    sessions,
    logger: (m) => logs.push(m),
  });
  const p = r.execute(INPUT);
  await settle();

  emitChunk(client, block("input-required", "question", "历史问题"), "hist-d");
  load.resolve({});
  await settle();

  emitChunk(client, "本轮无块。");
  emitChunk(client, block("input-required", "question", "历史问题"), "hist-d");
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  assert.equal(result.state, "completed");
  assert.equal(result.text, "本轮无块。");
  assert.ok(
    logs.some((l) => l.includes("丢弃历史重放 chunk 1 条")),
    logs.join("\n"),
  );
});

test("M9-c 无跨轮泄漏：重放 id 登记随收窗清空，不累积到次轮", async () => {
  const client = new FakeClient();
  const logs: string[] = [];
  const sessions = cachedSessions();
  const turn1Load = deferred<unknown>();
  const prompt1 = deferred<{ stopReason: string }>();
  const prompt2 = deferred<{ stopReason: string }>();
  let turn = 0;
  client.responder = (method) => {
    if (method === "session/load") return turn === 0 ? turn1Load.promise : {};
    if (method === "session/prompt") return (turn++ === 0 ? prompt1 : prompt2).promise;
    return {};
  };
  const r = new AcpSessionRunner({
    client,
    cwd: "/ws",
    timeoutMs: 1000,
    sessions,
    logger: (m) => logs.push(m),
  });

  const first = r.execute(INPUT);
  await settle();
  emitChunk(client, block("input-required", "question", "历史问题"), "hist-e"); // 窗外登记
  turn1Load.resolve({});
  await settle();
  emitChunk(client, "首轮结论。"); // 本轮实时（无 id）
  emitChunk(client, block("input-required", "question", "历史问题"), "hist-e"); // 窗内尾部 ⇒ 丢弃
  prompt1.resolve({ stopReason: "end_turn" });
  assert.equal((await first).text, "首轮结论。");

  // 次轮：本轮回灌未再带回该 id ⇒ 窗内首见的 hist-e 视为活块，旧登记不得跨轮生效
  const second = r.execute({ ...INPUT, taskId: "t2", text: "next", messageId: "m2" });
  await settle();
  emitChunk(client, "次轮结论。", "hist-e");
  prompt2.resolve({ stopReason: "end_turn" });
  const result = await second;

  assert.equal(result.state, "completed");
  assert.equal(result.text, "次轮结论。");
  assert.equal(
    logs.filter((l) => l.includes("丢弃历史重放 chunk")).length,
    1,
    logs.join("\n"),
  );
});

// ---- REQ-v0.8.2-2026-09-20-01 · M1（协议面增补）：model ⇒ session/set_config_option ----

const SET_MODEL = "session/set_config_option";

function modelRunner(
  client: AcpRequestClient,
  model?: string,
  sessions?: SessionMap,
  logger?: (message: string) => void,
): AcpSessionRunner {
  return new AcpSessionRunner({
    client,
    cwd: "/ws",
    timeoutMs: 1000,
    ...(model !== undefined ? { model } : {}),
    ...(sessions !== undefined ? { sessions } : {}),
    ...(logger !== undefined ? { logger } : {}),
  });
}

/**
 * 应答会话建立（new / load / resume）+ set_config_option + prompt 的通用 fake。
 * `fail` 内的方法抛错（用于 load→resume→new 回退链）；返回已调用方法序列。
 */
function modelResponder(
  client: FakeClient,
  opts: { sessionId?: string; fail?: readonly string[] } = {},
): string[] {
  const sessionId = opts.sessionId ?? "s1";
  const fail = new Set(opts.fail ?? []);
  const methods: string[] = [];
  client.responder = (method, params) => {
    methods.push(method);
    if (fail.has(method)) throw new Error(`${method} 不可用`);
    if (method === "session/new") {
      return { sessionId, configOptions: [{ id: "model", currentValue: "backend-default" }] };
    }
    if (method === "session/load" || method === "session/resume") return {};
    if (method === SET_MODEL) {
      const p = params as { value: string };
      // 真机方言：顶层无 currentValue，生效值在 configOptions[] 内 id==="model" 项
      return { configOptions: [{ id: "model", currentValue: p.value }] };
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

const setParams = (client: FakeClient): unknown[] =>
  client.calls.filter((c) => c.method === SET_MODEL).map((c) => c.params);

test("M1-model ① new 路径配 model ⇒ set 被调用一次，参数逐字 = {sessionId, configId:\"model\", value:配置值}", async () => {
  const client = new FakeClient();
  const methods = modelResponder(client);

  const result = await modelRunner(client, "provider/model-x").execute(INPUT);

  assert.equal(result.state, "completed");
  assert.equal(result.text, "ok");
  assert.deepEqual(setParams(client), [
    { sessionId: "s1", configId: "model", value: "provider/model-x" },
  ]);
  assert.deepEqual(methods, ["session/new", SET_MODEL, "session/prompt"]);
});

test("M1-model ① 值原样透传：含空格 / 斜杠 / 显示名等任意字符串一律不加工", async () => {
  for (const value of ["a b/c:d", "GLM-4.7 (max)", "与显示名同形-中文", "x".repeat(300)]) {
    const client = new FakeClient();
    modelResponder(client);
    await modelRunner(client, value).execute(INPUT);
    assert.deepEqual(setParams(client), [{ sessionId: "s1", configId: "model", value }]);
  }
});

test("M1-model ② 未配 model ⇒ 完全不调 set，方法序列与现状逐字一致", async () => {
  const client = new FakeClient();
  const methods = modelResponder(client);
  await runner(client).execute(INPUT);
  assert.deepEqual(setParams(client), []);
  assert.deepEqual(methods, ["session/new", "session/prompt"]);
});

test("M1-model ② 空串 / 非字符串 ⇒ 归一化为未配置（零调用，序列逐字一致）", async () => {
  const cases: Array<[string, unknown]> = [
    ["空串", ""],
    ["数字", 42],
    ["null", null],
    ["undefined", undefined],
  ];
  for (const [name, model] of cases) {
    const client = new FakeClient();
    const methods = modelResponder(client);
    await modelRunner(client, model as string | undefined).execute(INPUT);
    assert.deepEqual(setParams(client), [], `「${name}」不得发 set_config_option`);
    assert.deepEqual(methods, ["session/new", "session/prompt"], `「${name}」序列应回到现状`);
  }
});

test("M1-model ③ load 复用路径同样 set（sessionId = 复用后的 id）", async () => {
  const client = new FakeClient();
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new MemoryFs() });
  sessions.set("ctx", "old-sess");
  const methods = modelResponder(client, { sessionId: "old-sess" });

  const result = await modelRunner(client, "provider/model-x", sessions).execute(INPUT);

  assert.equal(result.state, "completed");
  assert.deepEqual(methods, ["session/load", SET_MODEL, "session/prompt"]);
  assert.deepEqual(setParams(client), [
    { sessionId: "old-sess", configId: "model", value: "provider/model-x" },
  ]);
});

test("M1-model ③ resume 复用路径（load 失败回落）同样 set", async () => {
  const client = new FakeClient();
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new MemoryFs() });
  sessions.set("ctx", "old-sess");
  const methods = modelResponder(client, { sessionId: "old-sess", fail: ["session/load"] });

  const result = await modelRunner(client, "provider/model-x", sessions).execute(INPUT);

  assert.equal(result.state, "completed");
  assert.deepEqual(methods, ["session/load", "session/resume", SET_MODEL, "session/prompt"]);
  assert.deepEqual(setParams(client), [
    { sessionId: "old-sess", configId: "model", value: "provider/model-x" },
  ]);
});

test("M1-model ③ load + resume 双失败 ⇒ new 后 set 一次（不重复下发）", async () => {
  const client = new FakeClient();
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new MemoryFs() });
  sessions.set("ctx", "old-sess");
  const methods = modelResponder(client, {
    sessionId: "fresh",
    fail: ["session/load", "session/resume"],
  });

  const result = await modelRunner(client, "m", sessions).execute(INPUT);

  assert.equal(result.state, "completed");
  assert.deepEqual(methods, ["session/load", "session/resume", "session/new", SET_MODEL, "session/prompt"]);
  assert.deepEqual(setParams(client), [{ sessionId: "fresh", configId: "model", value: "m" }]);
});

test("M1-model set 失败 ⇒ fail-fast：会话建立失败（任务 failed），不继续 prompt、不回退默认", async () => {
  const client = new FakeClient();
  const logs: string[] = [];
  const methods = modelResponder(client, { fail: [SET_MODEL] });

  const result = await modelRunner(client, "provider/bad", undefined, (m) => logs.push(m)).execute(INPUT);

  assert.equal(result.state, "failed");
  const reason = result.text ?? "";
  assert.ok(reason.includes("provider/bad"), `任务失败原因须含配置原值：${reason}`);
  assert.ok(reason.includes("设置失败"), `任务失败原因须可读：${reason}`);
  assert.deepEqual(methods, ["session/new", SET_MODEL], "set 失败后不得继续 prompt");
  assert.equal(
    logs.filter((l) => l.includes("设置失败") && l.includes("provider/bad")).length,
    1,
    logs.join("\n"),
  );
});

test("M1-model set 失败（后端 RPC 错误带 code）⇒ 日志与任务原因均含 message + code", async () => {
  const client = new FakeClient();
  const logs: string[] = [];
  const methods: string[] = [];
  client.responder = (method) => {
    methods.push(method);
    if (method === SET_MODEL) {
      throw new AcpError("rpc", "Invalid params: unknown model", { code: -32602 });
    }
    return method === "session/new" ? { sessionId: "s1" } : { stopReason: "end_turn" };
  };

  const result = await modelRunner(client, "provider/bad", undefined, (m) => logs.push(m)).execute(INPUT);

  assert.equal(result.state, "failed");
  const reason = result.text ?? "";
  assert.ok(reason.includes("Invalid params: unknown model"), reason);
  assert.ok(reason.includes("-32602"), `失败原因须含后端 code：${reason}`);
  assert.ok(!methods.includes("session/prompt"), "set 失败后不得继续 prompt");
  assert.equal(
    logs.filter((l) => l.includes("model=provider/bad 设置失败") && l.includes("-32602")).length,
    1,
    logs.join("\n"),
  );
});

test("M1-model F-a：currentValue 回显取 configOptions[] 内 id==\"model\" 项（顶层同名陷阱键不采信）", async () => {
  const client = new FakeClient();
  const logs: string[] = [];
  client.responder = (method, params) => {
    if (method === "session/new") return { sessionId: "s1" };
    if (method === SET_MODEL) {
      const p = params as { value: string };
      // 真机原始报文形状：顶层另有同名 currentValue 陷阱键 + 数组内多 config id 项
      return {
        currentValue: "TOP-LEVEL-BOGUS",
        configOptions: [
          { id: "mode", currentValue: "default" },
          { id: "model", currentValue: p.value },
        ],
      };
    }
    return { stopReason: "end_turn" };
  };

  await modelRunner(client, "provider/model-x", undefined, (m) => logs.push(m)).execute(INPUT);

  const line = logs.find((l) => l.includes("已设置"));
  assert.ok(line !== undefined, logs.join("\n"));
  assert.ok(line.includes("currentValue=provider/model-x"), line);
  assert.ok(!line.includes("TOP-LEVEL-BOGUS"), `不得采信顶层陷阱键：${line}`);
  assert.ok(!line.includes("undefined"), `不得打裸 undefined：${line}`);
});

test("M1-model F-a：响应无 configOptions / 数组内无匹配项 ⇒ 回显 n/a（不打裸 undefined）", async () => {
  const shapes: Array<[string, unknown]> = [
    ["无 configOptions", {}],
    ["数组内无 model 项", { configOptions: [{ id: "mode", currentValue: "default" }] }],
    ["configOptions 非数组", { configOptions: "model" }],
  ];
  for (const [name, setResponse] of shapes) {
    const client = new FakeClient();
    const logs: string[] = [];
    client.responder = (method) => {
      if (method === "session/new") return { sessionId: "s1" };
      if (method === SET_MODEL) return setResponse;
      return { stopReason: "end_turn" };
    };

    const result = await modelRunner(client, "provider/model-x", undefined, (m) => logs.push(m)).execute(INPUT);

    assert.equal(result.state, "completed", `「${name}」取不到只影响回显，不致命`);
    const line = logs.find((l) => l.includes("已设置"));
    assert.ok(line !== undefined && line.includes("currentValue=n/a"), `「${name}」应回显 n/a：${line ?? logs.join("\n")}`);
    assert.ok(line !== undefined && !line.includes("undefined"), `「${name}」不得打裸 undefined：${line}`);
  }
});

test("M1-model set 成功留观测日志（回显 currentValue，不做特殊处理）", async () => {
  const client = new FakeClient();
  const logs: string[] = [];
  modelResponder(client);
  await modelRunner(client, "provider/model-x", undefined, (m) => logs.push(m)).execute(INPUT);
  assert.equal(
    logs.filter((l) => l.includes("model=provider/model-x") && l.includes("currentValue=provider/model-x")).length,
    1,
    logs.join("\n"),
  );
});

test("M4 负向锚点：协议面 set 只发 configId=model，不顺手碰其它 config id", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  modelResponder(client, { sessionId: "s1" });
  const r = modelRunner(client, "provider/model-x", sessions);

  // 两轮均走 load 复用路径（load 直成功，不触 new/resume；建立路径由上面①③用例分别锁定）
  client.calls.length = 0;
  const turn1 = await r.execute(INPUT);
  assert.equal(turn1.state, "completed");
  const turn2 = await r.execute({ ...INPUT, taskId: "t2", text: "next", messageId: "m2" });
  assert.equal(turn2.state, "completed");

  const sets = client.calls.filter((c) => c.method === SET_MODEL);
  assert.equal(sets.length, 2, "每次会话建立（含复用）恰好 set 一次，不重复下发");
  for (const call of sets) {
    const params = call.params as Record<string, unknown>;
    // 逐字形状：仅 sessionId/configId/value 三键，configId 恒为 model
    assert.deepEqual(Object.keys(params).sort(), ["configId", "sessionId", "value"]);
    assert.equal(params["configId"], "model");
  }
  // 其它协议方法不被触碰（会话建立 + prompt 之外无请求）
  const others = new Set(client.calls.map((c) => c.method).filter((m) => m !== SET_MODEL));
  assert.deepEqual([...others].sort(), ["session/load", "session/prompt"]);
});

test("M4 翻向（v0.8.5 · M1）：会话内 set_config_option 的 configId 字面量仅 model / mode / collaboration_mode", () => {
  // v0.8.5 · B2-① 起：`model`（既有）+ `mode`（仅 -32601 回落用）+ `collaboration_mode` 是桥协议面
  // set_config_option 出参的**全部** config id；`effort` / `reasoning_effort` 仍不得顺手接线（扫描兜底未跑路径）。
  const src = readFileSync(
    // 运行时 = dist/test/*.js，源码在 machine 根（../../）
    new URL("../../acp-bridge/acp/session.ts", import.meta.url),
    "utf8",
  );
  const configIds = [...src.matchAll(/configId:\s*"([^"]+)"/g)].map((m) => m[1] as string);
  assert.ok(configIds.length > 0, "session.ts 应含 set_config_option 的 configId 字面量");
  assert.deepEqual([...new Set(configIds)].sort(), ["collaboration_mode", "mode", "model"]);
  for (const forbidden of ["effort", "reasoning_effort"]) {
    assert.ok(!src.includes(`configId: "${forbidden}`), `不得出现 configId=${forbidden}`);
  }
});

// ---------- REQ-v0.8.7-2026-09-22-01 · M4：桥侧诊断计量产出（machine-diagnostics artifact） ----------
/** 结果里的 `machine-diagnostics` 载荷（无该 artifact ⇒ `null`）；顺带校验 v0.3 artifact 形状。 */
function diagOf(result: TaskExecutionResult): Record<string, unknown> | null {
  const artifacts = result.artifacts ?? [];
  const marked = artifacts.filter((a) => a.name === DIAGNOSTICS_ARTIFACT_NAME);
  assert.ok(marked.length <= 1, `diagnostics artifact 至多一条（实得 ${String(marked.length)}）`);
  const artifact = marked[0];
  if (artifact === undefined) return null;
  assert.equal(typeof artifact.artifactId, "string", "artifact 须带 artifactId（v0.3 形状）");
  assert.equal(artifact.parts.length, 1);
  assert.equal(artifact.parts[0]?.kind, "text");
  return JSON.parse(artifact.parts[0]?.text ?? "") as Record<string, unknown>;
}

/**
 * 失败出口诊断的**恒定七键**（v0.8.8 · M1）：三原料 + 两段耗时 + kind/stage。
 * 可选键（`firstChunkElapsedMs` / `sessionResumed` / `acpErrorCode` / `acpErrorData` /
 * `partialTail` / `partialTailChars`）事实缺失即不报，故不在此列。
 */
const DIAG_CORE_KEYS = [
  "acpErrorKind",
  "bridgeEnsureElapsedMs",
  "chunkCount",
  "partialChars",
  "promptElapsedMs",
  "stage",
  "updateCount",
];

/**
 * 失败出口诊断的公共口径：恒定七键齐全（两段耗时随真实时钟浮动，只断言类型与非负）·
 * **`elapsedMs` 不得再出现**（v0.8.8 · M1 改名 `promptElapsedMs`，避开与 launcher 侧同名异义）·
 * 返回 kind/stage/chunkCount 供逐字断言（v0.8.7 口径不变）。
 */
function diagCore(diag: Record<string, unknown> | null): Record<string, unknown> {
  assert.ok(diag !== null, "失败出口必须带 machine-diagnostics artifact");
  for (const key of DIAG_CORE_KEYS) {
    assert.ok(key in diag, `恒定键 ${key} 必须存在（实得键 ${Object.keys(diag).join(",")}）`);
  }
  assert.ok(!("elapsedMs" in diag), "prompt 段耗时已改名 promptElapsedMs，不得再有 launcher 同义键 elapsedMs");
  for (const key of ["promptElapsedMs", "bridgeEnsureElapsedMs"]) {
    assert.equal(typeof diag[key], "number", `${key} 须为数字`);
    assert.ok((diag[key] as number) >= 0, `${key} 须非负`);
  }
  return {
    acpErrorKind: diag["acpErrorKind"],
    stage: diag["stage"],
    chunkCount: diag["chunkCount"],
  };
}

test("M4 ① 会话建立失败 ⇒ diagnostics（stage=ensure · kind=AcpError.kind · 未进 prompt ⇒ elapsedMs/chunkCount=0）", async () => {
  const client = new FakeClient();
  client.responder = (method) => {
    if (method === "session/new") throw new AcpError("spawn", "backend spawn failed");
    return { stopReason: "end_turn" };
  };

  const result = await runner(client).execute(INPUT);

  assert.equal(result.state, "failed");
  assert.equal(result.text, "会话建立失败：backend spawn failed");
  assert.deepEqual(diagCore(diagOf(result)), {
    acpErrorKind: "spawn",
    stage: "ensure",
    chunkCount: 0,
  });
  assert.equal(diagOf(result)?.["promptElapsedMs"], 0, "① 未进入 prompt 段 ⇒ prompt 段耗时恒 0");
  assert.ok(!client.calls.some((c) => c.method === "session/prompt"), "建立失败不得继续 prompt");
});

test("M4 ① 非结构化抛出（裸 Error，如 model fail-fast）⇒ acpErrorKind 归 error（不编造 ACP 类别）", async () => {
  const client = new FakeClient();
  client.responder = (method) => {
    if (method === "session/new") throw new Error("model=provider/bad 设置失败");
    return { stopReason: "end_turn" };
  };

  const result = await runner(client).execute(INPUT);

  assert.equal(result.state, "failed");
  assert.deepEqual(diagCore(diagOf(result)), { acpErrorKind: "error", stage: "ensure", chunkCount: 0 });
});

test("M4 ② prompt 失败 ⇒ diagnostics（stage=prompt · kind=closed）· 诊断不进结果文本", async () => {
  const client = new FakeClient();
  client.responder = (method) =>
    method === "session/new"
      ? { sessionId: "s1" }
      : Promise.reject(new AcpError("closed", "backend exited"));

  const result = await runner(client).execute(INPUT);

  assert.equal(result.state, "failed");
  assert.equal(result.text, "backend exited", "结果文本与现状逐字一致（诊断另轨 artifact）");
  assert.ok(!(result.text ?? "").includes(DIAGNOSTICS_ARTIFACT_NAME), "结果文本不得含 artifact 名");
  assert.deepEqual(diagCore(diagOf(result)), { acpErrorKind: "closed", stage: "prompt", chunkCount: 0 });
});

test("M4 ③ prompt 超时 ⇒ diagnostics（kind=timeout · promptElapsedMs 落在超时窗量级）", async () => {
  const client = new FakeClient();
  client.responder = (method) =>
    method === "session/new" ? { sessionId: "s1" } : new Promise<never>(() => undefined);

  const result = await runner(client, 50).execute(INPUT);

  assert.equal(result.state, "failed");
  assert.match(result.text ?? "", /任务超时/);
  const diag = diagOf(result);
  assert.deepEqual(diagCore(diag), { acpErrorKind: "timeout", stage: "prompt", chunkCount: 0 });
  const promptElapsedMs = diag?.["promptElapsedMs"] as number;
  assert.ok(
    promptElapsedMs >= 40 && promptElapsedMs < 5_000,
    `超时出口的 prompt 段耗时须≈超时窗（实得 ${String(promptElapsedMs)}）`,
  );
});

test("M4 chunkCount = 本轮已收 agent_message_chunk 数（thought chunk 不计）", async () => {
  const client = new FakeClient();
  client.responder = (method) => {
    if (method === "session/new") return { sessionId: "s1" };
    const emit = (sessionUpdate: string): void =>
      client.emit("session/update", {
        sessionId: "s1",
        update: { sessionUpdate, content: { type: "text", text: "x" } },
      });
    emit("agent_thought_chunk");
    emit("agent_message_chunk");
    emit("agent_thought_chunk");
    emit("agent_message_chunk");
    emit("agent_message_chunk");
    return Promise.reject(new AcpError("rpc", "prompt rejected"));
  };

  const result = await runner(client).execute(INPUT);

  assert.deepEqual(diagCore(diagOf(result)), { acpErrorKind: "rpc", stage: "prompt", chunkCount: 3 });
});

test("M4 chunkCount 不跨轮泄漏：上一轮 completed 收窗后，本轮失败只计本轮 chunk", async () => {
  const client = new FakeClient();
  let failPrompt = false;
  client.responder = (method) => {
    if (method === "session/new") return { sessionId: "s1" };
    const emitCount = failPrompt ? 1 : 5;
    for (let i = 0; i < emitCount; i += 1) {
      client.emit("session/update", {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `c${String(i)}` },
        },
      });
    }
    if (failPrompt) return Promise.reject(new AcpError("rpc", "second turn failed"));
    return { stopReason: "end_turn" };
  };
  const r = runner(client);

  const turn1 = await r.execute(INPUT);
  assert.equal(turn1.state, "completed");
  assert.equal(turn1.artifacts, undefined, "正常完成路径不带 diagnostics");

  failPrompt = true;
  const turn2 = await r.execute({ ...INPUT, taskId: "t2", text: "again", messageId: "m2" });
  assert.deepEqual(diagCore(diagOf(turn2)), { acpErrorKind: "rpc", stage: "prompt", chunkCount: 1 });
});

test("M4 正常终态不带 diagnostics：completed / canceled / input-required 三路 artifacts 均缺省", async () => {
  const shapes: Array<[string, (client: FakeClient) => void]> = [
    [
      "completed",
      (client) => {
        client.responder = (method) =>
          method === "session/new" ? { sessionId: "s1" } : { stopReason: "end_turn" };
      },
    ],
    [
      "canceled",
      (client) => {
        client.responder = (method) =>
          method === "session/new" ? { sessionId: "s1" } : { stopReason: "cancelled" };
      },
    ],
    [
      "input-required",
      (client) => {
        client.responder = (method) => {
          if (method === "session/new") return { sessionId: "s1" };
          client.emit("session/update", {
            sessionId: "s1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: '要先确认环境。\n\n```a2a-outcome\n{"state":"input-required","question":"要先确认环境？"}\n```',
              },
            },
          });
          return { stopReason: "end_turn" };
        };
      },
    ],
  ];
  for (const [name, setup] of shapes) {
    const client = new FakeClient();
    setup(client);
    const result = await runner(client).execute({ ...INPUT, taskId: `t-${name}` });
    assert.notEqual(result.state, "failed", `「${name}」场景不得误判为失败`);
    assert.equal(result.artifacts, undefined, `「${name}」不得带 diagnostics（不得编造空数组）`);
    assert.equal(diagOf(result), null, `「${name}」不得带 diagnostics`);
  }
});

test("M4 契约：桥与 launcher 的 artifact 名字面量一致", () => {
  assert.equal(DIAGNOSTICS_ARTIFACT_NAME, "machine-diagnostics");
  assert.equal(DIAGNOSTICS_ARTIFACT_NAME, LAUNCHER_DIAGNOSTICS_ARTIFACT_NAME);
});

/**
 * 桥 artifact → launcher 摘除侧的契约校验器（v0.8.8 · M1 写入 / M2 放行）：
 * 1. **透传值逐键一致**（launcher 白名单不得改写取值）；
 * 2. **M1 计量键必须已在白名单内**（否则「桥写了、launcher 丢了」= 取证链断在机内）；
 * 3. launcher 自测键（`elapsedMs` / `stage`）不由桥透传 —— 桥侧 `stage` 只作留痕。
 */
function assertDiagPassthrough(
  result: TaskExecutionResult,
  mustPass: readonly string[],
): Record<string, unknown> {
  const diag = diagOf(result);
  assert.ok(diag !== null, "失败出口必须带 machine-diagnostics artifact");
  const split = splitDiagnosticsArtifact(result.artifacts ?? []);
  const passed = (split.diagnostics ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(passed)) {
    assert.deepEqual(passed[key], diag[key], `透传键 ${key} 的值与桥侧不一致`);
  }
  for (const key of mustPass) {
    assert.ok(key in diag, `桥侧未写 ${key}（M1 职责）`);
    assert.ok(key in passed, `${key} 未透传 ⇒ launcher 白名单仍缺该键（M2 职责）`);
  }
  assert.ok(!("stage" in passed), "launcher 不采桥侧 stage（自测派发相位覆盖）");
  assert.ok(!("elapsedMs" in passed), "launcher 不采桥侧 elapsedMs（自测派发总耗时）");
  return passed;
}

/** 桥侧写入、launcher 白名单必须放行的 M1 计量键（`partialTail` 正文另论，见 M1 契约用例）。 */
const M1_PASSTHROUGH_KEYS = [
  "acpErrorKind",
  "chunkCount",
  "partialChars",
  "updateCount",
  "promptElapsedMs",
  "bridgeEnsureElapsedMs",
  "sessionResumed",
] as const;

test("M4 契约：桥产出的 diagnostics 可被 launcher 摘除侧解出（M1 计量键逐键透传）", async () => {
  const client = new FakeClient();
  client.responder = (method) =>
    method === "session/new"
      ? { sessionId: "s1" }
      : Promise.reject(new AcpError("timeout", "prompt timed out"));

  const result = await runner(client).execute(INPUT);
  const passed = assertDiagPassthrough(result, M1_PASSTHROUGH_KEYS);

  assert.equal(passed["acpErrorKind"], "timeout");
  assert.equal(passed["chunkCount"], 0);
  assert.equal(passed["sessionResumed"], false, "session/new 建立的会话 ⇒ 非续接");
  assert.deepEqual(splitDiagnosticsArtifact(result.artifacts ?? []).artifacts, [], "摘除后不剩余 ⇒ 无从混进 resultText");
});

// ---------- REQ-v0.8.8-2026-09-22-01 · M1：计量补全 + 半截尾部 + sessionResumed 回标 + 取证面 ----------

/** 建一个「session/new 成功 + prompt 由 setup 决定」的 fake。 */
function failingPrompt(client: FakeClient, err: () => unknown, onPrompt?: () => void): void {
  client.responder = (method) => {
    if (method === "session/new") return { sessionId: "s1" };
    if (method === "session/prompt") {
      onPrompt?.();
      return Promise.reject(err());
    }
    return {};
  };
}

test("M1 三原料：partialChars / updateCount / firstChunkElapsedMs 按本轮实测计数", async () => {
  const client = new FakeClient();
  const emit = (sessionUpdate: string, text: string): void =>
    client.emit("session/update", {
      sessionId: "s1",
      update: { sessionUpdate, content: { type: "text", text } },
    });
  failingPrompt(client, () => new AcpError("rpc", "prompt rejected"), () => {
    emit("agent_thought_chunk", "思考思考"); // 不计 chunk/partialChars，计 updateCount
    emit("tool_call", "");                   // 同上（「有推进」原料）
    emit("agent_message_chunk", "Hello, ");   // 7
    emit("agent_message_chunk", "world");     // 5
    emit("plan", "");                         // 计 updateCount
  });

  const diag = diagOf(await runner(client).execute(INPUT));
  assert.ok(diag !== null);
  assert.equal(diag["chunkCount"], 2, "只计 agent_message_chunk");
  assert.equal(diag["partialChars"], 12, "partialChars = 本轮入缓冲字符累计");
  assert.equal(diag["updateCount"], 5, "updateCount = 本轮任意 session/update（含 thought/tool_call/plan）");
  assert.equal(typeof diag["firstChunkElapsedMs"], "number", "有 chunk ⇒ firstChunkElapsedMs 必须报");
  assert.ok((diag["firstChunkElapsedMs"] as number) >= 0);
});

test("M1 满窗零产出 ⇒ firstChunkElapsedMs 不报（「没发生」不得写成 0）· 三原料归 0", async () => {
  const client = new FakeClient();
  failingPrompt(client, () => new AcpError("timeout", "no output"));

  const diag = diagOf(await runner(client).execute(INPUT));
  assert.ok(diag !== null);
  assert.ok(!("firstChunkElapsedMs" in diag), "零 chunk ⇒ 缺键（排队证据的键形态）");
  assert.equal(diag["partialChars"], 0);
  assert.equal(diag["updateCount"], 0);
  assert.ok(!("partialTail" in diag), "零产出 ⇒ 无半截尾部键");
});

test("M1 取证面：acpErrorCode / acpErrorData 进 diagnostics 且 data 原文可见（opencode 方言）", async () => {
  const client = new FakeClient();
  failingPrompt(
    client,
    () =>
      new AcpError("rpc", "Invalid params", {
        code: -32602,
        data: { _errors: { model: ["unknown model: gpt-9"] } },
      }),
  );

  const result = await runner(client).execute(INPUT);
  const diag = diagOf(result);
  assert.ok(diag !== null);
  assert.equal(diag["acpErrorCode"], -32602, "code 必须作独立键进产物（不再只混在文本里）");
  assert.equal(typeof diag["acpErrorData"], "string", "data 必须以宽 JSON 原文进产物");
  assert.ok(
    (diag["acpErrorData"] as string).includes("unknown model"),
    `data 细节不得被压成「Invalid params」四个字（实得 ${String(diag["acpErrorData"])}）`,
  );
  assert.match(result.text ?? "", /code=-32602/, "failureResult 文本补 code");
  assert.match(result.text ?? "", /unknown model/, "failureResult 文本补 data 摘要");
});

test("M1 取证面：无 code / 无 data 的错误 ⇒ 两键不报（不编造）", async () => {
  const client = new FakeClient();
  failingPrompt(client, () => new AcpError("closed", "backend exited"));

  const diag = diagOf(await runner(client).execute(INPUT));
  assert.ok(diag !== null);
  assert.ok(!("acpErrorCode" in diag), "无 code ⇒ 不报（0 是合法 code，不可当缺省）");
  assert.ok(!("acpErrorData" in diag), "无 data ⇒ 不报");
});

test("M1 取证面：acpErrorData 宽 JSON 超上限时截断留标记（护 /runner/result 1 MiB 请求体）", async () => {
  const client = new FakeClient();
  const blob = "x".repeat(9_000);
  failingPrompt(client, () => new AcpError("rpc", "Invalid params", { code: -32602, data: { blob } }));

  const diag = diagOf(await runner(client).execute(INPUT));
  const data = diag?.["acpErrorData"] as string;
  assert.ok(data.length < 2_500, `data 须被截断（实得 ${String(data.length)}）`);
  assert.match(data, /…\(\+\d+\)$/, "截断须留痕，不得静默砍尾");
});

test("M1 半截产出「取出再弃」：尾部快照进 diagnostics 且截到上限", async () => {
  const client = new FakeClient();
  const long = `${"h".repeat(9_000)}TAIL-MARKER`;
  failingPrompt(client, () => new AcpError("timeout", "prompt window full"), () => {
    client.emit("session/update", {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: long } },
    });
  });

  const diag = diagOf(await runner(client).execute(INPUT));
  assert.ok(diag !== null);
  const tail = diag["partialTail"] as string;
  assert.equal(tail.length, DIAGNOSTICS_PARTIAL_TAIL_MAX_CHARS, "尾部须截断至上限");
  assert.equal(diag["partialTailChars"], DIAGNOSTICS_PARTIAL_TAIL_MAX_CHARS);
  assert.equal(tail, long.slice(-DIAGNOSTICS_PARTIAL_TAIL_MAX_CHARS), "保的是**尾部**（续跑起点），不是头部");
  assert.equal(diag["partialChars"], long.length, "partialChars 报的是全长，不受尾部截断影响");
});

test("M1 半截产出短于一屏 ⇒ 原样带回（不截不丢）", async () => {
  const client = new FakeClient();
  failingPrompt(client, () => new AcpError("rpc", "boom"), () => {
    client.emit("session/update", {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "半截话" } },
    });
  });

  const diag = diagOf(await runner(client).execute(INPUT));
  assert.equal(diag?.["partialTail"], "半截话");
  assert.equal(diag?.["partialTailChars"], 3);
});

test("M1 半截取走后窗仍须弃：下一轮不受残窗污染", async () => {
  const client = new FakeClient();
  let fail = true;
  client.responder = (method) => {
    if (method === "session/new") return { sessionId: "s1" };
    if (method === "session/prompt" && fail) {
      client.emit("session/update", {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "残段" } },
      });
      return Promise.reject(new AcpError("rpc", "turn 1 failed"));
    }
    return { stopReason: "end_turn" };
  };
  const r = runner(client);

  const turn1 = await r.execute(INPUT);
  assert.equal(turn1.state, "failed");
  assert.equal(diagOf(turn1)?.["partialTail"], "残段");

  fail = false;
  const turn2 = await r.execute({ ...INPUT, taskId: "t2", text: "again", messageId: "m2" });
  assert.equal(turn2.state, "completed");
  assert.equal(turn2.text, "", "残段不得漏进下一轮（discardCapture 仍须执行）");
});

test("M1 sessionResumed 回标：load 真成功 ⇒ true", async () => {
  const client = new FakeClient();
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new MemoryFs() });
  sessions.set("ctx", "cached-sess");
  client.responder = (method) => {
    if (method === "session/load") return {};
    if (method === "session/prompt") return Promise.reject(new AcpError("rpc", "boom"));
    throw new AcpError("protocol", `不应调用 ${method}（load 已成功）`);
  };

  const diag = diagOf(await runner(client, 1000, sessions).execute(INPUT));
  assert.equal(diag?.["sessionResumed"], true, "load 成功 ⇒ 续接真发生");
  assert.ok(!client.calls.some((c) => c.method === "session/new"), "load 成功不得再 new");
});

test("M1 sessionResumed 回标：load+resume 双失败回落 new ⇒ false + 日志留痕（续跑退化成重跑）", async () => {
  const client = new FakeClient();
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new MemoryFs() });
  sessions.set("ctx", "cached-sess");
  const logs: string[] = [];
  client.responder = (method) => {
    if (method === "session/load" || method === "session/resume") throw new AcpError("rpc", "no such session");
    if (method === "session/new") return { sessionId: "fresh-sess" };
    return Promise.reject(new AcpError("rpc", "boom"));
  };

  const result = await new AcpSessionRunner({
    client,
    cwd: "/ws",
    timeoutMs: 1000,
    sessions,
    logger: (m) => logs.push(m),
  }).execute(INPUT);

  const diag = diagOf(result);
  assert.equal(diag?.["sessionResumed"], false, "回落 session/new ⇒ 续接未发生，必须上报");
  assert.ok(diag?.["stage"] === "prompt");
  assert.ok(
    logs.some((line) => line.includes("回落 session/new")),
    `回落事实须进日志（实得 ${logs.join(" | ")}）`,
  );
});

test("M1 sessionResumed 回标：首轮无缓存会话 ⇒ false；建立失败 ⇒ 不报该键", async () => {
  const client = new FakeClient();
  failingPrompt(client, () => new AcpError("rpc", "boom"));
  const diag = diagOf(await runner(client).execute(INPUT));
  assert.equal(diag?.["sessionResumed"], false, "无 SessionMap ⇒ 每次 new，续接未发生");

  const client2 = new FakeClient();
  client2.responder = (method) => {
    if (method === "session/new") throw new AcpError("spawn", "backend spawn failed");
    return {};
  };
  const diag2 = diagOf(await runner(client2).execute(INPUT));
  assert.ok(diag2 !== null);
  assert.ok(!("sessionResumed" in diag2), "会话都没建成 ⇒ 续接与否无事实，不报（不得编造 false）");
});

test("M1 窗外 update 不计入本轮计数（load 回灌的 backlog 不是「本轮推进」）", async () => {
  const client = new FakeClient();
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new MemoryFs() });
  sessions.set("ctx", "cached-sess");
  client.responder = (method) => {
    if (method === "session/load") {
      for (let i = 0; i < 4; i += 1) {
        client.emit("session/update", {
          sessionId: "cached-sess",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `backlog${String(i)}` } },
        });
      }
      return {};
    }
    if (method === "session/prompt") {
      client.emit("session/update", {
        sessionId: "cached-sess",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想" } },
      });
      return Promise.reject(new AcpError("rpc", "boom"));
    }
    return {};
  };

  const diag = diagOf(await runner(client, 1000, sessions).execute(INPUT));
  assert.equal(diag?.["updateCount"], 1, "只计窗内那 1 次 update（回灌 4 次不计）");
  assert.equal(diag?.["partialChars"], 0, "回灌 backlog 不入本轮 ⇒ partialChars 0");
});

test("M1 取证面：reasonOf 单一实现（applyModel 侧不得再逐字复制拼装）", () => {
  const src = readFileSync(
    // 运行时 = dist/test/*.js，源码在 machine 根（../../）
    new URL("../../acp-bridge/acp/session.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    src.split("（code=${String(err.code)}）").length - 1,
    0,
    "code 拼装只允许在 reasonOf 内（消除逐字复制是 §2.3.1 第 2 条的要求）",
  );
  assert.equal(src.split("reasonOf(err)").length - 1 >= 3, true, "reasonOf 须被三处以上消费");
});

test("M1↔M2 契约：取证键（code / data / partialTailChars）经 launcher 白名单落到 launcher 侧", async () => {
  const client = new FakeClient();
  failingPrompt(
    client,
    () => new AcpError("rpc", "Invalid params", { code: -32602, data: { _errors: { model: ["bad"] } } }),
    () => {
      client.emit("session/update", {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "有产出" } },
      });
    },
  );

  const result = await runner(client).execute(INPUT);
  // `acpErrorData` 是 §2.3.1 第 4 条的关键：不落到 launcher 侧则 opencode 系错误永远只剩「Invalid params」
  const passed = assertDiagPassthrough(result, [
    ...M1_PASSTHROUGH_KEYS,
    "acpErrorCode",
    "acpErrorData",
    "partialChars",
    "partialTailChars",
  ]);

  assert.equal(passed["acpErrorCode"], -32602);
  assert.equal(typeof passed["acpErrorData"], "string");
  assert.match(passed["acpErrorData"] as string, /_errors/);
  assert.equal(passed["partialTailChars"], 3);
  // 半截尾部**正文**（`partialTail`）按 launcher 白名单口径**不透传**（只留字符数）：
  // 正文在桥侧 artifact 与本文件的 diagOf 断言中已证；续跑判据用 partialChars/updateCount，M3 无需正文。
});

