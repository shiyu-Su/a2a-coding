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
import { readFileSync } from "node:fs";
import { AcpError } from "../acp-bridge/acp/client.js";
import { AcpSessionRunner, type AcpRequestClient } from "../acp-bridge/acp/session.js";
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

test("M4 负向锚点（源码级）：会话面 set_config_option 的 configId 字面量仅 \"model\"", () => {
  // effort / reasoning_effort / mode 等其它 config id 属后端既有能力，桥不得顺手接线；
  // 以源码扫描锁住「协议面只发 model」这一实现边界（行为断言只覆盖已跑路径，扫描兜底未跑路径）。
  const src = readFileSync(
    // 运行时 = dist/test/*.js，源码在 machine 根（../../）
    new URL("../../acp-bridge/acp/session.ts", import.meta.url),
    "utf8",
  );
  const configIds = [...src.matchAll(/configId:\s*"([^"]+)"/g)].map((m) => m[1] as string);
  assert.ok(configIds.length > 0, "session.ts 应含 set_config_option 的 configId 字面量");
  assert.deepEqual([...new Set(configIds)], ["model"]);
  for (const forbidden of ["effort", "reasoning_effort", 'mode"']) {
    assert.ok(!src.includes(`configId: "${forbidden}`), `不得出现 configId=${forbidden}`);
  }
});

