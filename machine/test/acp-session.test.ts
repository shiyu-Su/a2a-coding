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
 * **v0.8.9 · M2** 追加：捕获窗按 `messageId` 分组（串接与旧 `chunks` 逐字等价）· 跨轮归档
 * （`lastMessageIds`）判重放 + 安全阀（本轮无其它保留内容时不丢）· 出窗计量 `replayDropped` /
 * `blockCount` · 不确定三判据（`multi-block` / `replay-leak` / `cross-turn-message-id`，续跑轮加
 * `continue-` 前缀，**只置标志、不改 state**）· ①-b 注入判定改读 `injectedAt`（ensure 失败 /
 * 零输出失败不写前计数）· 成功轮也挂 diagnostics（`stage=success` + 体积键 `turn` / `promptChars` /
 * `injectedChars` / `resultChars`）· 无 `SessionMap` 降级路径同扩归档与轮次 · 轮次序号取位于会话
 * 建立**之后**（回落 new 不把死会话轮次算进第一轮）。
 *
 * **v0.8.9 · M6** 收口：M9 八例逐例重审（仅第 7 例语义受 ② 账面化影响 ⇒ 断言从「查日志」升级为
 * 「查 diagnostics + 日志双锚」）· §4 验收锚 CE-1～CE-4（CE-2 同框钉住「本轮有无其它保留内容」这条
 * 分水岭）· ①-b 两条守卫链（ensure 失败 / prompt 段零输出失败 ⇒ 不写 `injectedAt` ⇒ 重派照旧注入
 * ⇒ 成功次轮 `injectedChars=0`）· §2.3 键名契约全键面收口（宿主 2026-09-23 裁定：`lastBlockIndex`
 * **不上账面、不进 orch 投影**；`parseOutcomeFromGroups` **机制就绪、未接线** —— 见该两例注释，未擅自改生产代码）。
 *
 * **v0.8.10 · M-N2** 追加：捕获台账换键 `sessionId → taskId`（同 session 两轮不串 · 并发两 task 各记各窗）·
 * **dead 窗**语义（cancel / 被放弃 ⇒ 窗冻结，其 chunk 一律丢弃并计数）· 残段 id 登记与哨兵键
 * `staleChunkCount`（恒报，`0` = 「没有残段漏进来」的正向证据；经 launcher 白名单透传）·
 * `discardCapture` **照旧删窗**（不 park dead 窗；失败轮不登记残段 id ⇒ 其尾巴改走 M9-c 通道）·
 * 结构锚（窗键 = taskId、通知侧两级路由）。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AcpError } from "../acp-bridge/acp/client.js";
import {
  AcpSessionRunner,
  CONTINUE_TURN_PROMPT_MARKER,
  DIAGNOSTICS_ARTIFACT_NAME,
  DIAGNOSTICS_PARTIAL_TAIL_MAX_CHARS,
  type AcpRequestClient,
} from "../acp-bridge/acp/session.js";
import type { TaskExecutionResult } from "../acp-bridge/types.js";
import {
  CONTINUE_TAIL_MARKER as LAUNCHER_CONTINUE_TAIL_MARKER,
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

test("M9-b/c 观测：窗内丢弃的历史重放条数上账面（diagnostics `replayDropped`）+ 日志留痕", async () => {
  // v0.8.9 · M6（M9 八例重审第 7 例）：`replayDropped` 已由「只落日志」升为**账面键**（§2.3），
  // 故本例主断言改查 diagnostics；日志锚保留（真机取证仍看桥日志，两者不得互相替代）。
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
  const diag = diagOf(result);
  assert.ok(diag !== null, "成功轮须带 diagnostics（② 可见面的前置）");
  assert.equal(diag["replayDropped"], 1, "丢弃条数须上账面，不再只落日志");
  assert.equal(diag["blockCount"], 0, "本轮保留文本零块 ⇒ 判据 ii 不成立");
  assert.ok(
    !("outcomeAmbiguous" in diag),
    "replay-leak 需 `blockCount ≥ 1`；本轮零块 ⇒ 不误报歧义",
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
  assert.equal(turn1.artifacts?.length, 1, "v0.8.9 · M2：成功轮也挂 diagnostics（一条，不多挂）");

  failPrompt = true;
  const turn2 = await r.execute({ ...INPUT, taskId: "t2", text: "again", messageId: "m2" });
  assert.deepEqual(diagCore(diagOf(turn2)), { acpErrorKind: "rpc", stage: "prompt", chunkCount: 1 });
});

test("M2 正常终态也带 diagnostics（stage=success）· 三路 state 齐 · 结果文本零污染", async () => {
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
    const diag = diagOf(result);
    assert.ok(diag !== null, `「${name}」成功出口须带 diagnostics（② 可见面的前置）`);
    assert.equal(diag["stage"], "success", `「${name}」落点须为 success`);
    // AC-S1：诊断走 artifact 另轨，结果文本一个字都不许被污染
    const text = result.text ?? "";
    assert.ok(!text.includes(DIAGNOSTICS_ARTIFACT_NAME), `「${name}」结果文本不得含 artifact 名`);
    for (const key of ["promptElapsedMs", "chunkCount", "partialTail", "turn", "promptChars"]) {
      assert.ok(!text.includes(key), `「${name}」结果文本不得含 diagnostics 键名 ${key}`);
    }
    const split = splitDiagnosticsArtifact(result.artifacts ?? []);
    assert.deepEqual(split.artifacts, [], `「${name}」摘除 diagnostics 后不得剩余 artifact`);
    assert.ok(split.diagnostics !== null, `「${name}」diagnostics 须可被 launcher 侧解出`);
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
  // v0.8.10 · M-N2：失败轮走 `discardCapture`（**删窗**），**不**判 dead、**不**登记残段 id
  // —— 半截产出取完即弃，该轮的台账不留任何活格（续跑轮的尾巴另有通道，见 M-N2 ③）。
  assert.equal(diagOf(turn1)?.["staleChunkCount"], 0, "失败轮的窗是被删掉的，不是被判死的 ⇒ 残段通道未介入");

  fail = false;
  const turn2 = await r.execute({ ...INPUT, taskId: "t2", text: "again", messageId: "m2" });
  assert.equal(turn2.state, "completed");
  assert.equal(turn2.text, "", "残段不得漏进下一轮（discardCapture 仍须执行）");
  const d2 = diagOf(turn2);
  assert.equal(d2?.["chunkCount"], 0, "下一轮自己的窗是空的（旧窗既不残留也不 park 成 dead 窗）");
  assert.equal(d2?.["staleChunkCount"], 0, "本轮无残段可挡 ⇒ 哨兵为 0 = 「没有东西漏进来」的正向证据");
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

/** 记录 `delete()` 调用序的映射（v0.8.9 · M1：双失败处须显式作废旧条目）。 */
class DeleteSpyMap extends SessionMap {
  readonly deleted: string[] = [];

  override delete(contextId: string): void {
    this.deleted.push(contextId);
    super.delete(contextId);
  }
}

test("M1-v0.8.9 load+resume 双失败回落 new ⇒ 先 delete 旧条目，新会话不继承死会话状态", async () => {
  const client = new FakeClient();
  const sessions = new DeleteSpyMap({ projectId: "p1", baseDir: "/m", fs: new MemoryFs() });
  sessions.set("ctx", "cached-sess");
  sessions.bumpTurn("ctx");
  sessions.bumpTurn("ctx");
  sessions.markPrompted("ctx");
  const logs: string[] = [];
  client.responder = (method) => {
    if (method === "session/load" || method === "session/resume") throw new Error("no such session");
    if (method === "session/new") return { sessionId: "fresh-sess" };
    return { stopReason: "end_turn" };
  };

  const result = await new AcpSessionRunner({
    client,
    cwd: "/ws",
    timeoutMs: 1000,
    sessions,
    logger: (m) => logs.push(m),
  }).execute(INPUT);

  assert.equal(result.state, "completed");
  assert.deepEqual(sessions.deleted, ["ctx"], "回落 new 前必须 delete(contextId)");
  assert.equal(sessions.get("ctx"), "fresh-sess");
  assert.equal(diagOf(result)?.["turn"], 1, "轮次序号在会话建立**之后**取：回落 new 的第一轮就是 1（不是死会话的 3）");
  const entry = sessions.getEntry("ctx");
  assert.equal(
    entry?.turn,
    1,
    "死会话的轮次（建前已 bump 两次 = 2）不得并入新会话：delete 已清 ⇒ 1 是本轮成功出口的 +1，不是 3",
  );
  assert.ok(
    logs.some((line) => line.includes("warn") && line.includes("cached-sess")),
    `作废留痕须含旧 sessionId（实得 ${logs.join(" | ")}）`,
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

test("M1↔M2 契约：取证键（code / data / partialTailChars）+ M2 会话层键经 launcher 白名单落到 launcher 侧", async () => {
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
  // M2 会话层键（v0.8.9 · M4 放行）：`sessionReused` 要求有 SessionMap，本例 `runner(client)` 无映射 ⇒ 不入列
  const passed = assertDiagPassthrough(result, [
    ...M1_PASSTHROUGH_KEYS,
    "acpErrorCode",
    "acpErrorData",
    "partialChars",
    "partialTailChars",
    ...M2_BRIDGE_KEYS.filter((key) => key !== "sessionReused"),
  ]);

  assert.equal(passed["acpErrorCode"], -32602);
  assert.equal(typeof passed["acpErrorData"], "string");
  assert.match(passed["acpErrorData"] as string, /_errors/);
  assert.equal(passed["partialTailChars"], 3);
  assert.equal(passed["turn"], 1, "M4 放行：轮次序号落到 launcher");
  assert.equal(passed["resultChars"], 3, "M4 放行：成功/失败轮都报的结果长度键");
  // 半截尾部**正文**（`partialTail`）由白名单收进 `BridgeDiagnostics`（M3 续跑要读），
  // 但在回传投影 `bridgeForReport` 处**剥离** ⇒ 绝不上带 orch（只留 `partialTailChars`）。
});


// ---------- REQ-v0.8.9-2026-09-23-01 · M2：会话层（分组 / 跨轮归档 / 注入判定 / 成功轮计量）----------

/** 带 `SessionMap` 的实例（`ctx → s1` 已就绪，走 `session/load` 复用路径）。 */
function runnerWith(
  client: FakeClient,
  sessions: SessionMap,
  extra: Partial<ConstructorParameters<typeof AcpSessionRunner>[0]> = {},
  logs?: string[],
): AcpSessionRunner {
  return new AcpSessionRunner({
    client,
    cwd: "/ws",
    timeoutMs: 1000,
    sessions,
    ...(logs === undefined ? {} : { logger: (m: string): void => void logs.push(m) }),
    ...extra,
  });
}

test("M2 分组：同 id 连续成组、id 再现另起一组 ⇒ 本轮文本 = 各组按到达序串接（与旧 chunks 逐字等价）", async () => {
  const client = new FakeClient();
  const { prompt } = inFlightPrompt(client);
  const p = runner(client).execute(INPUT);
  await settle();

  emitChunk(client, "A1", "msg-a");
  emitChunk(client, "A2", "msg-a"); // 同 id 续写一组
  emitChunk(client, "B1", "msg-b"); // 换 id ⇒ 新组
  emitChunk(client, "A3", "msg-a"); // id 再现 ⇒ 再新起一组（**不得把 A3 并回第一组 = 文本重排**）
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  assert.equal(result.text, "A1A2B1A3", "分组后串接必须与改动前逐字一致");
  const diag = diagOf(result);
  assert.equal(diag?.["chunkCount"], 4);
  assert.equal(diag?.["resultChars"], 8, "resultChars = 本轮累积字符（成功轮也报）");
  assert.equal(diag?.["blockCount"], 0);
});

test("M2 分组末块：块分散在多个 messageGroup ⇒ blockCount 跨组累计，state 仍走主规则（末块）", async () => {
  const client = new FakeClient();
  const { prompt } = inFlightPrompt(client);
  const p = runner(client).execute(INPUT);
  await settle();

  emitChunk(client, `第一段。${block("input-required", "question", "历史问题")}`, "msg-a");
  emitChunk(client, `第二段。${block("failed", "reason", "本轮原因")}`, "msg-b");
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  // 主规则逐字不动：多块取末块 ⇒ failed（不是第一块的 input-required）
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "本轮原因");
  assert.equal(result.text, "第一段。\n\n第二段。", "块体移除、正文顺序不变（块前的 `\\n\\n` 是 parseOutcome 既有口径，M2 不改）");
  const diag = diagOf(result);
  assert.equal(diag?.["blockCount"], 2, "blockCount = 本轮结构有效块数（跨组累计）");
  assert.equal(diag?.["outcomeAmbiguous"], true);
  assert.equal(diag?.["ambiguousReason"], "multi-block");
});

test("M2 跨轮归档判重放：回灌尾部跨过 load 响应（窗外未登记）⇒ 次轮按历轮活块 id 丢弃 + 不误判 input-required", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  const r = runnerWith(client, sessions);
  const turn1Load = deferred<unknown>();
  const prompt1 = deferred<{ stopReason: string }>();
  client.responder = (method) => {
    if (method === "session/load") return turn1Load.promise;
    if (method === "session/prompt") return prompt1.promise;
    return {};
  };

  const first = r.execute(INPUT);
  await settle();
  turn1Load.resolve({});
  await settle();
  // 首轮活块：带 id，含一个 completed 块
  emitChunk(client, `自检 OK。${block("completed", "note", "ok")}`, "msg-live-1");
  prompt1.resolve({ stopReason: "end_turn" });
  assert.equal((await first).state, "completed");
  assert.deepEqual(sessions.getEntry("ctx")?.lastMessageIds, ["msg-live-1"], "活块 id 须入归档");

  // 次轮：load 立即返回（窗外无回灌）⇒ 上一轮那条消息的**重放**此刻才到（跨过 load 响应的空洞）
  const turn2 = deferred<{ stopReason: string }>();
  client.responder = (method) => {
    if (method === "session/load") return {};
    if (method === "session/prompt") return turn2.promise;
    return {};
  };
  const second = r.execute({ ...INPUT, taskId: "t2", text: "next", messageId: "m2" });
  await settle();
  emitChunk(client, "本轮结论。", "msg-live-2"); // 本轮活块（新 id）
  emitChunk(client, `上一轮遗留：${block("input-required", "question", "该用哪个环境？")}`, "msg-live-1");
  turn2.resolve({ stopReason: "end_turn" });

  const result = await second;
  assert.equal(result.state, "completed", "重放块不得再决定 state（v0.8.1 当年死循环的口径保持）");
  assert.equal(result.text, "本轮结论。");
  const diag = diagOf(result);
  assert.equal(diag?.["replayDropped"], 1, "归档命中丢弃须上账面（不再只落日志）");
  assert.equal(diag?.["outcomeAmbiguous"], true);
  assert.equal(diag?.["ambiguousReason"], "cross-turn-message-id");
  assert.equal(diag?.["turn"], 2, "turn = 桥内该 ctx 的第几轮");
});

test("M2 归档安全阀：归档命中但本轮尚无其它保留内容 ⇒ 不丢（丢空 = M9-b 老错），只留痕", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  sessions.recordMessageId("ctx", "msg-old");
  const r = runnerWith(client, sessions);
  const { load, prompt } = loadBackbone(client);
  const p = r.execute(INPUT);
  await settle();
  load.resolve({});
  await settle();

  emitChunk(client, `整轮只有这一条（id 在归档里）：${block("completed", "note", "ok")}`, "msg-old");
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  assert.equal(result.state, "completed");
  assert.notEqual(result.text, "", "安全阀：无其它保留内容时不得整轮丢空");
  const diag = diagOf(result);
  assert.equal(diag?.["replayDropped"], 0);
  assert.equal(diag?.["outcomeAmbiguous"], true);
  assert.equal(diag?.["ambiguousReason"], "cross-turn-message-id");
});

test("M2 判据 ii（replay-leak）：窗外登记 id 丢弃过且本轮仍有有效块 ⇒ 只置标志、state 不变", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  const { load, prompt } = loadBackbone(client);
  const p = runnerWith(client, sessions).execute(INPUT);
  await settle();

  emitChunk(client, `上一轮：${block("input-required", "question", "历史问题")}`, "hist-1");
  load.resolve({});
  await settle();

  emitChunk(client, `尾部：${block("input-required", "question", "历史问题")}`, "hist-1"); // M9-c 丢弃
  emitChunk(client, `本轮。${block("completed", "note", "ok")}`); // 无 id ⇒ 保留
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  assert.equal(result.state, "completed");
  const diag = diagOf(result);
  assert.equal(diag?.["replayDropped"], 1);
  assert.equal(diag?.["blockCount"], 1);
  assert.equal(diag?.["ambiguousReason"], "replay-leak");
});

test("M2 续跑轮独立取值：prompt 含续跑锚 ⇒ ambiguousReason 走 continue- 前缀 + 自报 continueAttempts", async () => {
  const client = new FakeClient();
  const { prompt } = inFlightPrompt(client);
  const p = runner(client).execute({
    ...INPUT,
    text: `做这件事\n【续跑】残段仅作续跑起点 <<<partial-output-resume>>> tail-begin`,
  });
  await settle();

  emitChunk(client, `一段。${block("completed", "note", "a")}`, "msg-a");
  emitChunk(client, `二段。${block("completed", "note", "b")}`, "msg-b");
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  assert.equal(result.state, "completed", "判「不确定」不得改 state（只暴露、不动作）");
  const diag = diagOf(result);
  assert.equal(diag?.["blockCount"], 2);
  assert.equal(diag?.["ambiguousReason"], "continue-multi-block", "续跑轮用独立取值，与常规轮分账");
  assert.equal(diag?.["continueAttempts"], 1, "续跑轮自报（launcher 的跨轮防递归第二信号）");

  // 反例：常规轮（无锚）同载荷 ⇒ 不带前缀、不自报 continueAttempts
  const client2 = new FakeClient();
  const inflight2 = inFlightPrompt(client2);
  const p2 = runner(client2).execute(INPUT);
  await settle();
  emitChunk(client2, `一段。${block("completed", "note", "a")}`, "msg-a");
  emitChunk(client2, `二段。${block("completed", "note", "b")}`, "msg-b");
  inflight2.prompt.resolve({ stopReason: "end_turn" });
  const diag2 = diagOf(await p2);
  assert.equal(diag2?.["ambiguousReason"], "multi-block");
  assert.ok(!("continueAttempts" in diag2), "常规轮不报该键（缺省 = 0，不占账面）");
});

test("M2 契约：桥侧续跑轮锚与 launcher 的残段标记字面量一致", () => {
  assert.equal(CONTINUE_TURN_PROMPT_MARKER, LAUNCHER_CONTINUE_TAIL_MARKER);
});

/** 依次取 fake 收到的各次 `session/prompt` 正文（注入判定断言用）。 */
function promptTexts(client: FakeClient): string[] {
  return client.calls.flatMap((call) => {
    if (call.method !== "session/prompt") return [];
    const params = call.params as { prompt?: Array<{ text?: unknown }> };
    return [String(params.prompt?.[0]?.text ?? "")];
  });
}

test("M2 ①-b 守卫（ensure 失败不写）：会话建立失败 ⇒ prompt 从未写出 ⇒ injectedAt 不推进 ⇒ 重派照旧注入", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  client.responder = (method) => {
    if (method === "session/load") return {};
    if (method === "session/set_config_option") throw new AcpError("rpc", "unknown model: gpt-9");
    return {};
  };

  const result = await runnerWith(client, sessions, { model: "gpt-9" }).execute(INPUT);
  assert.equal(result.state, "failed");
  const diag = diagOf(result);
  assert.ok(diag !== null);
  assert.equal(diag["stage"], "ensure", "相位 = 建立期（守卫的第一判据）");
  assert.equal(diag["promptChars"], undefined, "prompt 未写出 ⇒ 体积键不报（不编造）");
  assert.equal(
    client.calls.filter((call) => call.method === "session/prompt").length,
    0,
    "守卫的事实面：本轮一条 prompt 都没发出",
  );
  assert.equal(sessions.getEntry("ctx")?.injectedAt, undefined, "ensure 失败绝不写注入前计数");
  assert.equal(sessions.isInjected("ctx"), false, "重派必须仍按首轮（漏注入比重复注入更坏）");
});

test("M2 ①-b 守卫（零输出重发不写 / 有产出失败则写）：注入判据从 prompted 换成「曾发出过」", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  const r = runnerWith(client, sessions);

  // ① 满窗零产出（未到达后端 / 疑似排队）⇒ 不写前计数
  failingPrompt(client, () => new AcpError("timeout", "no output"));
  await r.execute(INPUT);
  assert.equal(sessions.isInjected("ctx"), false, "零输出失败 ⇒ 不写 injectedAt");
  assert.equal(sessions.getEntry("ctx")?.prompted, false, "prompted 语义保留不动（未收到响应）");

  // ② 该类重派：照旧注入约定
  await r.execute({ ...INPUT, taskId: "t2", text: "retry", messageId: "m2" });
  const texts = promptTexts(client);
  assert.equal(texts.length, 2);
  assert.ok(texts[0]?.startsWith(A2A_OUTCOME_CONVENTION), "首轮注入（现状不变）");
  assert.ok(
    texts[1]?.startsWith(A2A_OUTCOME_CONVENTION),
    "零输出重派仍按首轮 ⇒ 第二次 prompt 必须带约定（守卫生效）",
  );

  // ③ 到达后端且有产出的失败 ⇒ 约定已被消费 ⇒ 写前计数
  failingPrompt(client, () => new AcpError("closed", "backend died"), () => {
    emitChunk(client, "已经写了一段正文", "msg-live");
  });
  await r.execute({ ...INPUT, taskId: "t3", text: "again", messageId: "m3" });
  assert.equal(
    sessions.isInjected("ctx"),
    true,
    "prompt 段失败但有推进 ⇒ 记为「曾发出过 prompt」",
  );

  // ④ 次轮不再重复注入
  client.responder = (method) =>
    method === "session/prompt" ? { stopReason: "end_turn" } : { sessionId: "s1" };
  await r.execute({ ...INPUT, taskId: "t4", text: "next", messageId: "m4" });
  const fourth = promptTexts(client)[3] ?? "";
  assert.ok(
    !fourth.includes(A2A_OUTCOME_CONVENTION),
    "①-b 的目的：首轮超时/失败的重派不重复烧一遍约定",
  );
  assert.ok(fourth.includes("next"), "正文本身照旧送达");
  assert.equal(sessions.isPrompted("ctx"), true, "收到响应 ⇒ prompted 置位（既有语义）");
});

test("M2 成功轮也挂 diagnostics：stage=success + 体积键（turn / promptChars / injectedChars / resultChars）· 失败面键不报", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  const r = runnerWith(client, sessions);

  const first = loadBackbone(client);
  const p1 = r.execute({ ...INPUT, text: "做这个" });
  await settle();
  first.load.resolve({});
  await settle();
  emitChunk(client, "结论", "m-1");
  first.prompt.resolve({ stopReason: "end_turn" });
  const d1 = diagOf(await p1);
  assert.ok(d1 !== null, "成功轮必须挂一次 diagnostics");
  assert.equal(d1["stage"], "success");
  assert.equal(d1["turn"], 1, "turn = 桥内该 ctx 的第 1 轮");
  assert.equal(d1["injectedChars"], A2A_OUTCOME_CONVENTION.length + 7, "注入 = 约定 + `\\n\\n---\\n\\n`");
  assert.equal(d1["promptChars"], (d1["injectedChars"] as number) + 3, "promptChars = 注入 + 正文");
  assert.equal(d1["resultChars"], 2, "resultChars = 本轮累积正文");
  for (const key of [
    "acpErrorKind",
    "acpErrorCode",
    "acpErrorData",
    "partialTail",
    "partialTailChars",
    "outcomeAmbiguous",
    "ambiguousReason",
  ]) {
    assert.ok(!(key in d1), `成功轮不报 ${key}（无事实 ⇒ 缺键，不写 null / 不编造）`);
  }

  const second = loadBackbone(client);
  const p2 = r.execute({ ...INPUT, taskId: "t2", text: "再来", messageId: "m2" });
  await settle();
  second.load.resolve({});
  await settle();
  emitChunk(client, "又一结论", "m-9");
  second.prompt.resolve({ stopReason: "end_turn" });
  const d2 = diagOf(await p2);
  assert.ok(d2 !== null);
  assert.equal(d2["turn"], 2, "成功出口 bumpTurn ⇒ 次轮序号递增");
  assert.equal(d2["injectedChars"], 0, "次轮无注入 ⇒ 报 0（「没注入」是事实，与「没报」不同）");
  assert.equal(d2["promptChars"], 2);
});

test("M2 无 SessionMap 降级路径：内存归档 + 轮次同扩（易漏点，判据与持久化路径一致）", async () => {
  const client = new FakeClient();
  const r = runner(client); // 无 sessions ⇒ 走 promptedInMemory / 内存归档

  const b1 = inFlightPrompt(client);
  const p1 = r.execute(INPUT);
  await settle();
  emitChunk(client, "首轮结论。", "msg-1");
  b1.prompt.resolve({ stopReason: "end_turn" });
  const d1 = diagOf(await p1);
  assert.ok(d1 !== null);
  assert.equal(d1["turn"], 1);
  assert.ok(!("sessionReused" in d1), "无映射 ⇒ 无「命中」这件事，键不报（不编造 false）");

  const b2 = inFlightPrompt(client);
  const p2 = r.execute({ ...INPUT, taskId: "t2", text: "next", messageId: "m2" });
  await settle();
  emitChunk(client, "本轮正文。", "msg-2");
  emitChunk(client, "上一轮重放尾巴", "msg-1"); // 命中内存归档 ⇒ 丢
  b2.prompt.resolve({ stopReason: "end_turn" });
  const result2 = await p2;
  assert.equal(result2.text, "本轮正文。", "无 SessionMap 时归档判重放必须同样生效");
  const d2 = diagOf(result2);
  assert.ok(d2 !== null);
  assert.equal(d2["turn"], 2);
  assert.equal(d2["replayDropped"], 1);
  assert.equal(d2["ambiguousReason"], "cross-turn-message-id");
  assert.ok(!("sessionMapSize" in d2), "无 SessionMap ⇒ 映射规模无事实，两键不报");
});

test("M2 ④ 可见面：sessionMapSize / sessionMapOldestAgeDays 只随桥的首个任务带出一次", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  sessions.set("other", "s9");
  client.responder = (method) =>
    method === "session/prompt" ? { stopReason: "end_turn" } : { sessionId: "s1" };
  const r = runnerWith(client, sessions);

  const d1 = diagOf(await r.execute(INPUT));
  assert.ok(d1 !== null);
  assert.equal(d1["sessionMapSize"], 2, "启动加载后的映射条数");
  assert.equal(d1["sessionMapOldestAgeDays"], 0, "刚写入 ⇒ 年龄 0 天（floor）");

  const d2 = diagOf(await r.execute({ ...INPUT, taskId: "t2", text: "next", messageId: "m2" }));
  assert.ok(d2 !== null);
  assert.ok(!("sessionMapSize" in d2), "只带一次（摊到每轮是噪声）");
  assert.ok(!("sessionMapOldestAgeDays" in d2));
});

/** M2 在桥侧新增、待 launcher 白名单放行（放行 = M4 职责）的键。 */
const M2_BRIDGE_KEYS = [
  "turn",
  "sessionReused",
  "promptChars",
  "injectedChars",
  "resultChars",
  "blockCount",
  "replayDropped",
] as const;

test("M2↔M4 契约：M2 新键已在桥侧载荷内；launcher 侧未放行者被丢、放行者不改值（不得改写取值）", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  failingPrompt(client, () => new AcpError("rpc", "boom"), () => {
    emitChunk(client, `一段。${block("completed", "note", "a")}`, "msg-a");
    emitChunk(client, `二段。${block("completed", "note", "b")}`, "msg-b");
  });

  const result = await runnerWith(client, sessions).execute(INPUT);
  const diag = diagOf(result);
  assert.ok(diag !== null);
  for (const key of M2_BRIDGE_KEYS) {
    assert.ok(key in diag, `桥侧未写 ${key}（M2 职责）`);
  }
  assert.equal(diag["blockCount"], 2);
  assert.equal(diag["outcomeAmbiguous"], true, "判据 (i)：多块 ⇒ 只置标志");
  assert.equal(diag["ambiguousReason"], "multi-block");

  const split = splitDiagnosticsArtifact(result.artifacts ?? []);
  const passed = (split.diagnostics ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(passed)) {
    assert.deepEqual(value, diag[key], `透传键 ${key} 的值被 launcher 侧改写`);
  }
  assert.deepEqual(split.artifacts, [], "诊断 artifact 摘除后不剩余 ⇒ 无从混进 resultText（AC-S1）");
  // ---- M4 已放行：翻向「每个 M2 键都在 passed 内」（同 M1 契约用例的 assertDiagPassthrough 写法）----
  for (const key of M2_BRIDGE_KEYS) {
    assert.ok(key in passed, `${key} 未透传 ⇒ launcher 白名单仍缺该键（M4 职责）`);
  }
  assert.ok("outcomeAmbiguous" in passed, "outcomeAmbiguous 未透传 ⇒ M4 的 business 守卫拿不到标志");
  assert.ok("ambiguousReason" in passed, "ambiguousReason 未透传 ⇒ 歧义诱因留在机内、orch 无从反查");
  for (const key of Object.keys(diag)) {
    // 白名单不得漏键：桥写的每个键都须落 launcher，唯一例外 = `stage`（launcher 自测派发相位覆盖）。
    // `partialTail` **是**收进 BridgeDiagnostics 的（M3 续跑 prompt 的原料）；它的剥离发生在
    // 回传投影 `bridgeForReport`（见 runner-exec 的 AC-S2 用例），不在白名单这一层。
    if (key === "stage") continue;
    assert.ok(key in passed, `${key} 在桥侧载荷内但被白名单丢弃 ⇒ M4 漏放行`);
  }
  assert.deepEqual(
    Object.keys(diag)
      .filter((key) => key !== "stage")
      .sort(),
    Object.keys(passed).sort(),
    "桥写键集（除 stage）⇔ launcher 放行键集必须相等",
  );
});

// ---------- REQ-v0.8.9-2026-09-22-01 · M6：回归套件收口（CE-1～CE-4 · ①-b · ② 键名契约）----------
// 本段只做**收口**：把改造文档 §4 的验收条目逐条落成可执行锚，不改任何既有语义。
// 与 M2 已有用例的关系 = 「验收命名」而非重复实现：CE-2 / CE-3 的桥侧机制在 M2 段已各自有例，
// 此处按**验收口径**（CE-x 编号 + 分水岭同框）补锚，并在② 键名契约上把 §2.3 全键面钉死。

test("CE-1（既有锚仍绿）窗外登记 id 的尾部落窗内 + 本轮无 id 活块 ⇒ 本轮文本只含活块", async () => {
  // §2.4 判据 ii 的账面形态：文本纯净（只含活块）+ 丢弃条数上账面 + 歧义可见。
  const client = new FakeClient();
  const sessions = cachedSessions();
  const { load, prompt } = loadBackbone(client);
  const p = runnerWith(client, sessions).execute(INPUT);
  await settle();

  emitChunk(client, `上一轮：${block("input-required", "question", "历史问题")}`, "hist-1"); // 窗外登记
  load.resolve({});
  await settle();

  emitChunk(client, `尾部：${block("input-required", "question", "历史问题")}`, "hist-1"); // 窗内 ⇒ 丢弃
  emitChunk(client, `本轮结论。${block("completed", "note", "ok")}`); // 无 id ⇒ 活块
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  assert.equal(result.state, "completed", "重放的 input-required 块不得决定 state");
  assert.equal(result.text, "本轮结论。", "本轮文本只含活块（块体按主规则移除）");
  const diag = diagOf(result);
  assert.ok(diag !== null);
  assert.equal(diag["replayDropped"], 1);
  assert.equal(diag["blockCount"], 1, "blockCount 只计**保留下来**的块");
  assert.equal(diag["outcomeAmbiguous"], true, "判据 ii：有丢弃且有有效块 ⇒ 显式暴露");
  assert.equal(diag["ambiguousReason"], "replay-leak");
});

test("CE-2（当年死循环的最小构造）归档 id 尾部跨过 load 响应才入窗 ⇒ 分水岭 = 本轮有无其它保留内容", async () => {
  // ── 分支 ①：本轮另有活块 ⇒ 归档命中**丢弃** ⇒ 自愈（completed，不再续派）。
  const healedClient = new FakeClient();
  const healedSessions = cachedSessions();
  healedSessions.recordMessageId("ctx", "m1"); // 上一轮以 input-required 结束并归档 m1
  const healed = loadBackbone(healedClient);
  const healedP = runnerWith(healedClient, healedSessions).execute(INPUT);
  await settle();
  healed.load.resolve({}); // 窗外零回灌 ⇒ M9-c 集合未登记 m1（补 R-a 空洞的正主）
  await settle();
  emitChunk(healedClient, "本轮结论。"); // 无 id 活块 ⇒ 先建立「本轮已有保留内容」
  emitChunk(healedClient, `上一轮遗留：${block("input-required", "question", "该用哪个环境？")}`, "m1");
  healed.prompt.resolve({ stopReason: "end_turn" });

  const healedResult = await healedP;
  assert.equal(healedResult.state, "completed", "分支 ①：判重放并丢弃 ⇒ 死循环已切断");
  assert.equal(healedResult.text, "本轮结论。");
  const healedDiag = diagOf(healedResult);
  assert.ok(healedDiag !== null);
  assert.equal(healedDiag["replayDropped"], 1);
  assert.equal(healedDiag["outcomeAmbiguous"], true);
  assert.equal(healedDiag["ambiguousReason"], "cross-turn-message-id");

  // ── 分支 ②：本轮**零活块**（只有归档 id 的回灌尾部）⇒ M2 安全阀不丢（丢空 = M9-b 老错，R-Ⅱ）。
  //   口径（**宿主 2026-09-23 裁决：取 §2.7 R-Ⅱ，非 §4-4 期望**）：R-Ⅱ 安全阀防的是「把本轮
  //   **唯一**内容丢空」——那正是 v0.8.1 M9-b 犯过的错，「归档命中 ⇒ 丢弃」不得凌驾它。故本版
  //   **接受**「零活块分支下死循环不自愈（仍 `input-required`），但账面必带
  //   `outcomeAmbiguous` + `cross-turn-message-id` = **可发现而非静默**」。改造文档 §4-4 由宿主
  //   同步修订（实施级偏离 +1 版）。**断言不改**，钉的是裁定后的现状。
  const valveClient = new FakeClient();
  const valveSessions = cachedSessions();
  valveSessions.recordMessageId("ctx", "m1");
  const valve = loadBackbone(valveClient);
  const valveP = runnerWith(valveClient, valveSessions).execute(INPUT);
  await settle();
  valve.load.resolve({});
  await settle();
  emitChunk(valveClient, `上一轮遗留：${block("input-required", "question", "该用哪个环境？")}`, "m1");
  valve.prompt.resolve({ stopReason: "end_turn" });

  const valveResult = await valveP;
  assert.equal(valveResult.state, "input-required", "分支 ②：安全阀保留内容 ⇒ 不丢空");
  assert.equal(valveResult.question, "该用哪个环境？");
  const valveDiag = diagOf(valveResult);
  assert.ok(valveDiag !== null);
  assert.equal(valveDiag["replayDropped"], 0, "未丢弃 ⇒ 账面为 0（与分支 ① 的分水岭可见）");
  assert.equal(valveDiag["outcomeAmbiguous"], true, "命中归档必须留痕（即便走安全阀）");
  assert.equal(valveDiag["ambiguousReason"], "cross-turn-message-id");
});

test("CE-3 窗内两个状态互斥的有效块 ⇒ blockCount=2 + multi-block + state 按末块（主规则不动）", async () => {
  const client = new FakeClient();
  const { prompt } = inFlightPrompt(client);
  const p = runner(client).execute(INPUT);
  await settle();

  emitChunk(client, `先问一句。${block("input-required", "question", "要哪个环境？")}`, "msg-a");
  emitChunk(client, `做不到。${block("failed", "reason", "依赖缺失")}`, "msg-b");
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  assert.equal(result.state, "failed", "末块规则逐字不动（互斥时以最后一个块为准）");
  assert.equal(result.reason, "依赖缺失");
  assert.equal(result.text, "先问一句。\n\n做不到。", "两个块体都被移除，正文顺序不变");
  const diag = diagOf(result);
  assert.ok(diag !== null);
  assert.equal(diag["blockCount"], 2);
  assert.equal(diag["outcomeAmbiguous"], true);
  assert.equal(diag["ambiguousReason"], "multi-block", "判据 i 优先级最高");
  assert.equal(diag["replayDropped"], 0, "本轮无重放 ⇒ 与 replay-leak 分账");
  // `business 不判` 属 launcher 侧消费（§1 耦合 1），锚在 `test/runner-exec.test.ts` 的 CE-3 真链路例。
});

test("CE-4（已知不可判）活块与回灌块均无 messageId ⇒ machine 无判据依据 ⇒ 不报 ambiguous（诚实）", async () => {
  // qodercn 方言的**反面**：连回灌块都不带 id ⇒ 归档 / 窗外登记两条判据同时失去输入。
  // 期望「不静默」**不成立**（没有任何可区分重放与实时的信号），本例只钉住「不假装判得出」。
  const client = new FakeClient();
  const sessions = cachedSessions();
  const { load, prompt } = loadBackbone(client);
  const p = runnerWith(client, sessions).execute(INPUT);
  await settle();

  emitChunk(client, `窗外无 id 回灌：${block("input-required", "question", "窗外历史问题")}`);
  load.resolve({}); // 窗外无 id ⇒ 不进 replayMessageIds（登记这条判据也失效）
  await settle();

  emitChunk(client, `上一轮遗留：${block("input-required", "question", "历史问题")}`); // 窗内回灌尾部
  emitChunk(client, "本轮结论。"); // 无 id 活块
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  assert.equal(
    result.state,
    "input-required",
    "已知不可判：无 id ⇒ 重放块无从识别，仍会决定 state（机器不自愈）",
  );
  const diag = diagOf(result);
  assert.ok(diag !== null);
  assert.equal(diag["replayDropped"], 0, "窗外那条被静默丢弃但账面为 0 —— 判据零依据的直接证据");
  assert.ok(!("outcomeAmbiguous" in diag), "无依据时不得编造歧义标志（诚实口径）");
  assert.ok(!("ambiguousReason" in diag));
});

test("①-b 守卫链（ensure 失败）：不写 injectedAt ⇒ 重派照旧注入 ⇒ 成功后的次轮 injectedChars=0", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  client.responder = (method) => {
    if (method === "session/load") return {};
    if (method === "session/set_config_option") throw new AcpError("rpc", "unknown model: gpt-9");
    return {};
  };
  const r = runnerWith(client, sessions, { model: "gpt-9" });

  const first = await r.execute(INPUT);
  assert.equal(first.state, "failed");
  assert.equal(diagOf(first)?.["stage"], "ensure", "prompt 从未写出");
  assert.equal(
    client.calls.filter((call) => call.method === "session/prompt").length,
    0,
    "本派发零 prompt ⇒ 无注入可言",
  );
  assert.equal(sessions.getEntry("ctx")?.injectedAt, undefined, "ensure 失败不写 injectedAt");

  // 重派（建立恢复）⇒ 必须仍按首轮注入，否则约定永久缺失（漏注入比重复注入更坏）
  client.responder = (method) => (method === "session/prompt" ? { stopReason: "end_turn" } : {});
  const retry = await r.execute({ ...INPUT, taskId: "t2", text: "retry", messageId: "m2" });
  const retryDiag = diagOf(retry);
  assert.ok(retryDiag !== null);
  assert.equal(retryDiag["injectedChars"], A2A_OUTCOME_CONVENTION.length + 7, "重派照旧注入约定");
  assert.ok(promptTexts(client)[0]?.startsWith(A2A_OUTCOME_CONVENTION));

  // 正常成功后 ⇒ 次轮不再注入（①-b 的机器可判定证据 = injectedChars 恒 0）
  const next = await r.execute({ ...INPUT, taskId: "t3", text: "next", messageId: "m3" });
  const nextDiag = diagOf(next);
  assert.ok(nextDiag !== null);
  assert.equal(nextDiag["injectedChars"], 0, "次轮 injectedChars === 0");
  assert.ok(!promptTexts(client)[1]?.includes(A2A_OUTCOME_CONVENTION), "次轮正文不含约定");
  assert.equal(diagOf(retry)?.["turn"], 1, "ensure 失败轮不 bump ⇒ 首次成功的 prompt 仍是第 1 轮");
  assert.equal(nextDiag["turn"], 2, "turn 只在成功出口推进（本轮 = 第 2 轮）");
});

test("①-b 守卫链（prompt 阶段零输出失败 = 节点单里「transport 类」的桥侧等价）：不写 injectedAt ⇒ 重派照旧注入 ⇒ 只烧一次约定", async () => {
  // 口径注（M6 复核发现）：`AcpError["kind"]` 闭集 = spawn/closed/timeout/rpc/protocol，**无** `transport`
  // —— transport 是 launcher 侧 HTTP 传输层类别（send/poll），到不了桥。改造文档 §2.2 守卫里的
  // 「transport 零输出类」在桥侧的等价类 = **prompt 段失败且零推进**（closed / spawn / protocol + 零输出）。
  const client = new FakeClient();
  const sessions = cachedSessions();
  const r = runnerWith(client, sessions);
  failingPrompt(client, () => new AcpError("closed", "backend not reachable")); // 未到达后端，零产出

  const first = await r.execute(INPUT);
  assert.equal(first.state, "failed");
  const firstDiag = diagOf(first);
  assert.ok(firstDiag !== null);
  assert.equal(firstDiag["acpErrorKind"], "closed");
  assert.equal(firstDiag["stage"], "prompt", "落点在 prompt（守卫第 2 判据的前半）");
  assert.equal(firstDiag["injectedChars"], A2A_OUTCOME_CONVENTION.length + 7, "本轮确实注入了");
  assert.equal(firstDiag["partialChars"], 0);
  assert.equal(firstDiag["updateCount"], 0, "零 update ⇒ 无推进证据");
  assert.equal(
    sessions.getEntry("ctx")?.injectedAt,
    undefined,
    "「不写」即无需回滚：prompt 未到达后端 ⇒ 绝不记为已注入",
  );
  assert.equal(sessions.isInjected("ctx"), false);

  // 重派 ⇒ 照旧注入
  client.responder = (method) => (method === "session/prompt" ? { stopReason: "end_turn" } : {});
  const retry = await r.execute({ ...INPUT, taskId: "t2", text: "retry", messageId: "m2" });
  assert.equal(diagOf(retry)?.["injectedChars"], A2A_OUTCOME_CONVENTION.length + 7, "重派仍注入");
  assert.equal(sessions.isInjected("ctx"), true, "有响应的重派 ⇒ 前计数落账");

  const third = await r.execute({ ...INPUT, taskId: "t3", text: "next", messageId: "m3" });
  assert.equal(diagOf(third)?.["injectedChars"], 0, "整条链只烧一次约定");
  assert.equal(promptTexts(client).filter((t) => t.startsWith(A2A_OUTCOME_CONVENTION)).length, 2);
});

/**
 * 改造文档 §2.3「machine 产键」表**全键面**（字面量与文档逐字一致 = 验收 9）。
 * **宿主 2026-09-23 裁定**：`lastBlockIndex` 从线上键面**删除** —— `parseOutcome` 的函数出参保留，
 * 但**不上账面、不进 orch 投影**（没有消费者就不过线）。故它不在本清单内，由下例作**负向锚**钉住。
 */
const SPEC_2_3_KEYS = [
  "turn",
  "sessionReused",
  "sessionResumed",
  "promptChars",
  "injectedChars",
  "resultChars",
  "blockCount",
  "replayDropped",
  "outcomeAmbiguous",
  "ambiguousReason",
  "sessionMapSize",
  "sessionMapOldestAgeDays",
] as const;

test("② 键名契约收口：§2.3 键面经桥载荷 → launcher 白名单逐键落地（漏键 / 改写取值即失败）", async () => {
  const client = new FakeClient();
  const sessions = cachedSessions();
  sessions.recordMessageId("ctx", "msg-a");
  const { load, prompt } = loadBackbone(client);
  const p = runnerWith(client, sessions).execute(INPUT);
  await settle();
  load.resolve({});
  await settle();
  emitChunk(client, `本轮正文。${block("completed", "note", "ok")}`, "msg-live-1");
  emitChunk(client, block("input-required", "question", "历史问题"), "msg-a"); // 归档命中 ⇒ 丢弃
  prompt.resolve({ stopReason: "end_turn" });

  const result = await p;
  const diag = diagOf(result);
  assert.ok(diag !== null);
  assert.equal(diag["outcomeAmbiguous"], true, "本例须让歧义两键也进载荷（否则契约测不全）");

  // 桥侧：§2.3 每键都必须在载荷里（缺键 = M2 漏产，orch 无从投影）
  const missingOnBridge = SPEC_2_3_KEYS.filter((key) => !(key in diag));
  assert.deepEqual(
    missingOnBridge,
    [],
    "§2.3 键面与桥载荷零差额（宿主 2026-09-23 裁定 `lastBlockIndex` 不上账面后，不得再有未登记缺口）",
  );
  assert.ok(!("lastBlockIndex" in diag), "裁定口径：`lastBlockIndex` 不过线（桥侧不产）");

  // launcher 侧：值逐键不改写 + 除 `stage` 外不漏放行
  const passed = assertDiagPassthrough(result, [
    "turn",
    "sessionReused",
    "sessionResumed",
    "promptChars",
    "injectedChars",
    "resultChars",
    "blockCount",
    "replayDropped",
    "outcomeAmbiguous",
    "ambiguousReason",
    "sessionMapSize",
    "sessionMapOldestAgeDays",
  ]);
  assert.deepEqual(
    SPEC_2_3_KEYS.filter((key) => !(key in passed)),
    [],
    "§2.3 键面全量经 launcher 白名单放行（宿主裁定 `lastBlockIndex` 不上账面 ⇒ 不得有未放行键）",
  );
  assert.ok(!("lastBlockIndex" in passed), "裁定口径：`lastBlockIndex` 不进 orch 投影");
  assert.equal(diag["replayDropped"], 1);
  assert.equal(diag["blockCount"], 1);
});

test("② 口径锚（宿主 2026-09-23 裁定）：lastBlockIndex 不上账面 · parseOutcomeFromGroups 机制就绪未接线", () => {
  // 本例是**口径登记锚**（不是缺陷上报，缺陷已按裁定收敛）：源码面钉住两条裁定后的现状，
  // 谁将来悄悄改线（把 lastBlockIndex 塞进载荷 / 把分组入口接进判据路径）都会先红在这里。
  const sessionSrc = readFileSync(
    // 运行时 = dist/test/*.js，源码在 machine 根（../../）
    new URL("../../acp-bridge/acp/session.ts", import.meta.url),
    "utf8",
  );

  // 裁定 1：`lastBlockIndex` **不上账面、不进 orch 投影**（§2.3 键面已删该键）——
  //         `parseOutcome` 的函数出参保留无妨，没有消费者就不过线。
  assert.ok(sessionSrc.includes("blockCount: diag.blockCount"), "桥写 blockCount（账面保留键）");
  assert.ok(
    !sessionSrc.includes("lastBlockIndex"),
    "裁定：桥侧不产 lastBlockIndex（若将来要过线，须先由宿主恢复 §2.3 该键 + launcher 白名单同步）",
  );

  // 裁定 3：**机制就绪、未接线**（宿主 2026-09-23 裁定）——今日 run-length 分组与全文拼接
  //         **逐字等价**（等价性锚在 acp-outcome 的「chunk 打散不改变结果」），接线要动**最高风险的
  //         判据路径**而收益为零；其真值场景（R-a「回灌尾部跨过 load 响应」）**尚无真机取证**
  //         ⇒ 登记为未覆盖项，待真机取证证实 R-a 现实存在后再接线。
  assert.ok(!sessionSrc.includes("parseOutcomeFromGroups("), "登记：M3 的分组入口尚无消费方");
  assert.ok(sessionSrc.includes("parseOutcome(text)"), "现状：桥仍走全文口径末块");
});

// ---------- v0.8.10 · M-N2：捕获台账换键（sessionId → taskId）+ dead 窗 + staleChunkCount ----------
// 本段测的是**记录本本身**：同一 `sessionId` 上先后/并存的多个 task 各记各窗，被判死的窗不再
// 产文本，被挡下的残段一律计数（哨兵键 `staleChunkCount`）。换键是 M-N3（定向取消）与只读真并行的地基。

/** 在**指定** sessionId 上发一条 chunk（M-N2 的并发用例需要同一时刻并存的两条会话交错发送）。 */
function emitOn(client: FakeClient, sessionId: string, text: string, messageId?: string): void {
  client.emit("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      ...(messageId !== undefined ? { messageId } : {}),
      content: { type: "text", text },
    },
  });
}

/** 一条在飞 `session/prompt` 的手动闸门（可 resolve 也可 reject）。 */
interface PromptGate {
  promise: Promise<{ stopReason: string }>;
  resolve: (value: { stopReason: string }) => void;
  reject: (err: unknown) => void;
}

/** 多条 `session/prompt` 依调用序各给一个闸门（并发任务的骨架）。 */
function multiPrompt(
  client: FakeClient,
  sessionIdFor: (params: unknown) => string = () => "s1",
): { prompts: PromptGate[] } {
  const prompts: PromptGate[] = [];
  client.responder = (method, params) => {
    if (method === "session/new") return { sessionId: sessionIdFor(params) };
    if (method === "session/prompt") {
      let resolve: (value: { stopReason: string }) => void = () => undefined;
      let reject: (err: unknown) => void = () => undefined;
      const promise = new Promise<{ stopReason: string }>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      prompts.push({ promise, resolve, reject });
      return promise;
    }
    return {};
  };
  return { prompts };
}

test("M-N2 ① 同一 sessionId 的两轮不串：旧轮窗判 dead、其尾巴被挡并计入 staleChunkCount", async () => {
  const client = new FakeClient();
  const { prompts } = multiPrompt(client);
  const r = runner(client);

  const first = r.execute({ ...INPUT, taskId: "t1", text: "第一轮" });
  await settle();
  emitOn(client, "s1", "第一轮的正文", "msg-1"); // 落进 t1 的窗

  // 同 session 上再起一轮 ⇒ 开窗前先把上一轮的窗判 dead（等待已放弃、后端还在跑 = 幽灵轮）
  const second = r.execute({ ...INPUT, taskId: "t2", text: "第二轮", messageId: "m2" });
  await settle();
  emitOn(client, "s1", "第一轮的尾巴（幽灵）", "msg-1"); // 同 id ⇒ 进不了新窗
  emitOn(client, "s1", "第二轮的正文", "msg-2");
  prompts[0]?.resolve({ stopReason: "end_turn" });
  prompts[1]?.resolve({ stopReason: "end_turn" });

  const firstResult = await first;
  const secondResult = await second;
  assert.equal(firstResult.text, "第一轮的正文", "旧轮文本冻结在判 dead 时刻");
  assert.equal(secondResult.text, "第二轮的正文", "旧轮的尾巴不得漏进新轮");

  const d1 = diagOf(firstResult);
  const d2 = diagOf(secondResult);
  assert.ok(d1 !== null && d2 !== null);
  assert.equal(d1["chunkCount"], 1, "判 dead 后旧窗不再收 chunk");
  assert.equal(d1["partialChars"], 6);
  assert.equal(d1["staleChunkCount"], 0, "旧轮自己没被残段打扰（它的尾巴是被新轮挡下的）");
  assert.equal(d2["chunkCount"], 1, "新窗只收自己那条");
  assert.equal(d2["replayDropped"], 0, "残段走 staleChunkCount 分账，不并入历史重放");
  assert.equal(d2["staleChunkCount"], 1, "哨兵：有一条残段试图漏进本轮，已挡");
  assert.equal(d2["blockCount"], 0);
});

test("M-N2 ② 并发两 taskId 各记各窗：后一轮的开/收不得覆盖或抹掉在飞轮的窗", async () => {
  // 旧口径（`sessionId` 单值键）下：t2 开窗会把 t1 的窗**整格覆盖**，t2 收窗再把它删掉
  // ⇒ t1 收窗时拿到 `undefined`，结果文本被清空。换键后各记各窗，此例即回归锚。
  const client = new FakeClient();
  const { prompts } = multiPrompt(client);
  const r = runner(client);

  const first = r.execute({ ...INPUT, taskId: "t1", text: "第一轮" });
  await settle();
  emitOn(client, "s1", "第一轮的正文", "msg-1");

  const second = r.execute({ ...INPUT, taskId: "t2", text: "第二轮", messageId: "m2" });
  await settle();
  emitOn(client, "s1", "第二轮的正文", "msg-2");
  prompts[1]?.resolve({ stopReason: "end_turn" });
  const secondResult = await second; // t2 先收窗（注销活跃指针）
  assert.equal(secondResult.text, "第二轮的正文");

  // t1 仍在飞：它判 dead 之后到达的尾巴落窗外（无指针）⇒ 只登记重放 id，不进任何窗
  emitOn(client, "s1", "第一轮的尾巴", "msg-1");
  prompts[0]?.resolve({ stopReason: "end_turn" });
  const firstResult = await first;

  const d1 = diagOf(firstResult);
  assert.ok(d1 !== null);
  assert.equal(firstResult.text, "第一轮的正文", "t1 的窗没被 t2 覆盖/删除 ⇒ 自己收到的东西还在");
  assert.equal(d1["chunkCount"], 1, "判 dead 之后的尾巴不计入 t1");
  assert.equal(d1["partialChars"], 6);
  assert.equal(d1["staleChunkCount"], 0);
  assert.equal(d1["turn"], 1, "两窗各持自己的轮次序号快照（开窗时取，不互相覆盖）");
});

test("M-N2 ③ discardCapture 照旧删窗：失败轮不 park dead 窗，其残段走 M9-c 通道而非残段通道", async () => {
  const client = new FakeClient();
  const { prompts } = multiPrompt(client);
  const r = runner(client);

  const first = r.execute({ ...INPUT, taskId: "t1", text: "第一轮" });
  await settle();
  emitOn(client, "s1", "第一轮的半截", "msg-1");
  prompts[0]?.reject(new AcpError("rpc", "boom")); // 失败 ⇒ discardCapture（删窗 + 注销指针）
  const firstResult = await first;
  assert.equal(firstResult.state, "failed");
  assert.equal(diagOf(firstResult)?.["partialTail"], "第一轮的半截");

  // 弃窗后后端还在跑：这条尾巴既无窗可进（证明窗被删、不是被 park 成 dead），也不该被登记成残段
  emitOn(client, "s1", "第一轮的尾巴", "msg-1");

  const second = r.execute({ ...INPUT, taskId: "t2", text: "第二轮", messageId: "m2" });
  await settle();
  emitOn(client, "s1", "第二轮的正文", "msg-2");
  emitOn(client, "s1", "第一轮的尾巴再抖一次", "msg-1"); // 窗外登记过的 id ⇒ M9-c 丢弃
  prompts[1]?.resolve({ stopReason: "end_turn" });
  const secondResult = await second;
  const d2 = diagOf(secondResult);
  assert.ok(d2 !== null);
  assert.equal(secondResult.text, "第二轮的正文", "失败轮的尾巴同样漏不进下一轮");
  assert.equal(d2["replayDropped"], 1, "失败轮走的是 M9-c 重放通道（窗外登记 id）");
  assert.equal(d2["staleChunkCount"], 0, "失败轮**不**登记残段 id：续跑轮合法接着写同一条消息，判残段会丢空整轮");
});

test("M-N2 ④ cancel 即判 dead：窗冻结，取消后才到的 chunk 一律丢弃并计数", async () => {
  // 「有实质产出」的判据原料是 `partialChars` —— 已取消的任务若还在涨它，就会被误判成可续跑。
  const client = new FakeClient();
  const { prompts } = multiPrompt(client);
  const r = runner(client, 60_000);
  const p = r.execute(INPUT);
  await settle();
  emitOn(client, "s1", "前半段", "msg-1");
  await r.cancel("t1");
  emitOn(client, "s1", "取消后才吐的尾巴一", "msg-1");
  emitOn(client, "s1", "取消后才吐的尾巴二", "msg-1");
  prompts[0]?.resolve({ stopReason: "cancelled" });

  const result = await p;
  const diag = diagOf(result);
  assert.ok(diag !== null);
  assert.equal(result.state, "canceled");
  assert.equal(result.text, "前半段", "判 dead 后的 chunk 不进本轮文本");
  assert.equal(diag["chunkCount"], 1);
  assert.equal(diag["partialChars"], 3, "partialChars 冻结在判 dead 时刻");
  assert.equal(diag["staleChunkCount"], 2, "dead 窗的 chunk 一律丢弃并计数");
});

test("M-N2 ⑤ 结构锚：捕获窗的键 = taskId（sessionId 不再作窗键）· 弃窗只删不 park", () => {
  const src = readFileSync(
    // 运行时 = dist/test/*.js，源码在 machine 根（../../）
    new URL("../../acp-bridge/acp/session.ts", import.meta.url),
    "utf8",
  );
  assert.ok(src.includes("this.captures.set(input.taskId,"), "开窗键 = taskId");
  assert.ok(!src.includes("this.captures.set(sessionId"), "sessionId 不再是窗的键");
  assert.ok(src.includes("this.captures.get(input.taskId)"), "失败路径按 taskId 取回自己的窗");
  assert.ok(src.includes("private readonly activeTaskOf = new Map<string, string>();"), "两级路由指针存在");
  assert.ok(src.includes("this.routeCapture(sessionId)"), "通知侧走两级路由");

  const discard = src.slice(src.indexOf("private discardCapture("), src.indexOf("private discardCapture(") + 700);
  assert.match(discard, /this\.captures\.delete\(taskId\)/, "discardCapture 仍删窗");
  assert.ok(!discard.includes("markCaptureDead"), "弃窗路径不 park dead 窗（留窗 = 重现「尾巴漏进下一轮」）");
});

test("M-N2 ⑥ staleChunkCount 上账面且经 launcher 白名单透传（恒报，0 也算证据）", async () => {
  const client = new FakeClient();
  client.responder = (method) => (method === "session/new" ? { sessionId: "s1" } : { stopReason: "end_turn" });
  const result = await runner(client).execute(INPUT);
  const diag = diagOf(result);
  assert.ok(diag !== null);
  assert.equal(diag["staleChunkCount"], 0, "干净一轮也须报 0（缺键与报 0 是两回事）");
  const passed = assertDiagPassthrough(result, ["staleChunkCount"]);
  assert.equal(passed["staleChunkCount"], 0, "launcher 白名单漏放行 ⇒ 哨兵停在机内，取证链断");
});

// ---------- REQ-v0.8.10-2026-09-24-01 · M-N3：桥侧自取消（prompt 满窗出口）----------

test("M-N3 桥自取消：prompt 满窗出口发 session/cancel + 结果标 abandoned（后端那轮不再白烧）", async () => {
  const client = new FakeClient();
  failingPrompt(client, () => new AcpError("timeout", "session/prompt 超过 1000ms"));

  const result = await runner(client).execute(INPUT);
  assert.equal(result.state, "failed");
  // `abandoned` = 台账「终态支路」的唯一输入：没有它，launcher 迟到的 tasks/cancel 会被终态跳过
  assert.equal(result.abandoned, true);
  assert.deepEqual(
    client.notifies.filter((n) => n.method === "session/cancel").map((n) => n.params),
    [{ sessionId: "s1" }],
    "满窗即尽力通知后端取消那一轮（只走控制通道）",
  );
});

test("M-N3 桥自取消（负向）：非满窗的 prompt 失败既不 notify 也不标 abandoned", async () => {
  const client = new FakeClient();
  failingPrompt(client, () => new AcpError("rpc", "prompt rejected"));

  const result = await runner(client).execute(INPUT);
  assert.equal(result.state, "failed");
  assert.equal(result.abandoned, undefined, "后端语义拒绝 ≠ 放弃（该轮已自然收敛，无幽灵可言）");
  assert.equal(client.notifies.filter((n) => n.method === "session/cancel").length, 0);
});
