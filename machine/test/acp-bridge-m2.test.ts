/**
 * `machine/acp-bridge/` M2 定向单测（REQ-v0.8.1-2026-09-19-01 · 节点 M2）。
 *
 * 判据（注入语义对齐，跨 kind 行为变更）：
 * - 注入 = 每 session **首轮** prompt 前缀（缺省约定 + config 段 systemPrompt），次轮及以后不注入；
 * - `prompted` 置位时机 = `session/prompt` 收到响应即置（end_turn / input-required / cancelled）；
 * - 「映射写入」（set 初值 false）与「prompted 置位」（markPrompted）两次持久化；
 * - 旧条目兼容：缺键 / undefined ⇒ 视为 false，读旧文件不报错；
 * - append = 追加缺省注入之后；replace = 替换缺省注入；无自定义注入 ⇒ 仅缺省约定；
 * - load/resume 恢复的会话按持久化 prompted 值（新 SessionMap 实例 = 模拟跨进程重启，不重注入）；
 * - qoder ≥2 轮模拟（无 config 段）：末轮 outcome 块仍被 parse 生效。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AcpSessionRunner, type AcpInjectionConfig, type AcpRequestClient } from "../acp-bridge/acp/session.js";
import { SessionMap, type SessionMapFs } from "../acp-bridge/session-map.js";
import { parseOutcome, A2A_OUTCOME_CONVENTION } from "../acp-bridge/outcome.js";


class FakeClient implements AcpRequestClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  responder: (method: string, params: unknown) => unknown = () => ({});
  private readonly handlers = new Set<(method: string, params: unknown) => void>();

  request(method: string, params: unknown, _timeoutMs?: number): Promise<unknown> {
    this.calls.push({ method, params });
    return Promise.resolve().then(() => this.responder(method, params));
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

  emit(method: string, params: unknown): void {
    for (const handler of [...this.handlers]) handler(method, params);
  }

  /** 已发出的 session/prompt 文本（按序）。 */
  promptTexts(): string[] {
    return this.calls
      .filter((c) => c.method === "session/prompt")
      .map((c) => (c.params as { prompt: Array<{ text: string }> }).prompt[0]?.text ?? "");
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

/**
 * 固定时钟（对齐 test/acp-session-map.test.ts 的 `FIXED` 口径）：SessionMap 的 `load()` 会按
 * TTL（缺省 7 天，以 `updatedAt` 计）淘汰条目，走真实墙钟时本文件的旧条目 fixture
 * （`updatedAt = 2026-09-19`）会在 2026-09-26 之后被剪掉 ⇒ 断言随日期过期而必红。
 * 取 2026-09-20 = fixture 之后 1 天：条目仍是「旧格式条目」，但永不在 TTL 之外。
 */
const FIXED_NOW = (): Date => new Date("2026-09-20T00:00:00.000Z");

function makeMap(fs: MemoryFs): SessionMap {
  return new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED_NOW });
}

/** SessionMap 的落盘路径（与实现同口径：join(baseDir, .a2a, acp-sessions, <projectId>.json)）。 */
const MAP_PATH = join("/m", ".a2a", "acp-sessions", "p1.json");

function makeRunner(
  client: AcpRequestClient,
  sessions?: SessionMap,
  injection?: AcpInjectionConfig,
): AcpSessionRunner {
  return new AcpSessionRunner({
    client,
    cwd: "/ws",
    timeoutMs: 1000,
    ...(sessions !== undefined ? { sessions } : {}),
    ...(injection !== undefined ? { injection } : {}),
  });
}

/** 新会话应答：session/new → s1；prompt → end_turn + 一条 message chunk。 */
function echoBackend(client: FakeClient, reply = "ok"): void {
  client.responder = (method, params) => {
    if (method === "session/new") return { sessionId: "s1" };
    if (method === "session/prompt") {
      const sessionId = (params as { sessionId: string }).sessionId;
      client.emit("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } },
      });
      return { stopReason: "end_turn" };
    }
    return {};
  };
}

// ---------- ① SessionMap.prompted 字段 ----------

test("SessionMap.set 初值 prompted=false 落盘（映射写入与置位两次持久化）", () => {
  const fs = new MemoryFs();
  const map = makeMap(fs);
  map.set("ctx", "s1");
  assert.equal(map.isPrompted("ctx"), false);
  const persisted = JSON.parse(fs.files.get(map.path()) ?? "{}") as Record<string, { prompted?: boolean }>;
  assert.equal(persisted["ctx"]?.prompted, false);

  map.markPrompted("ctx");
  assert.equal(map.isPrompted("ctx"), true);
  const after = JSON.parse(fs.files.get(map.path()) ?? "{}") as Record<string, { prompted?: boolean }>;
  assert.equal(after["ctx"]?.prompted, true);
});

test("SessionMap 旧条目兼容：prompted 缺键 ⇒ false，读旧文件不报错", () => {
  const fs = new MemoryFs();
  fs.writeText(MAP_PATH, JSON.stringify({ ctx: { sessionId: "old-s", updatedAt: "2026-09-19T00:00:00.000Z" } }));
  const map = makeMap(fs);
  assert.equal(map.get("ctx"), "old-s");
  assert.equal(map.isPrompted("ctx"), false);
  assert.equal(map.getEntry("ctx")?.prompted, undefined);
  // markPrompted 后升格为 true
  map.markPrompted("ctx");
  assert.equal(map.isPrompted("ctx"), true);
});

test("SessionMap 未知键 prompted 非法值 ⇒ 视为 false；markPrompted 无键不动", () => {
  const fs = new MemoryFs();
  fs.writeText(MAP_PATH, JSON.stringify({ ctx: { sessionId: "s", updatedAt: "x", prompted: "yes" } }));
  const map = makeMap(fs);
  assert.equal(map.isPrompted("ctx"), false);
  map.markPrompted("absent");
  assert.equal(map.isPrompted("absent"), false);
  assert.equal(map.size(), 1);
});

// ---------- ② 首轮注入 / 次轮不注入 ----------

test("注入只发生首轮：第 1 条带缺省约定，第 2 条起裸文本（同 contextId 复用会话）", async () => {
  const client = new FakeClient();
  const fs = new MemoryFs();
  const map = makeMap(fs);
  echoBackend(client);
  const r = makeRunner(client, map);

  await r.execute({ taskId: "t1", text: "第一轮", contextId: "ctx", messageId: "m1" });
  await r.execute({ taskId: "t2", text: "第二轮", contextId: "ctx", messageId: "m2" });
  await r.execute({ taskId: "t3", text: "第三轮", contextId: "ctx", messageId: "m3" });

  const texts = client.promptTexts();
  assert.equal(texts.length, 3);
  assert.ok(texts[0]?.startsWith(A2A_OUTCOME_CONVENTION), "首轮应前置缺省约定");
  assert.ok(texts[0]?.endsWith("第一轮"));
  assert.equal(texts[1], "第二轮");
  assert.equal(texts[2], "第三轮");
  assert.equal(map.isPrompted("ctx"), true);
});

test("prompted 置位时机 = 收到响应即置：input-required / cancelled 同样置位", async () => {
  for (const stop of ["end_turn", "cancelled"] as const) {
    const client = new FakeClient();
    const map = makeMap(new MemoryFs());
    client.responder = (method) =>
      method === "session/new"
        ? { sessionId: "s1" }
        : { stopReason: stop };
    const r = makeRunner(client, map);
    await r.execute({ taskId: "t1", text: "q", contextId: "ctx", messageId: "m1" });
    assert.equal(map.isPrompted("ctx"), true, `${stop} 后应已置位`);
  }
  const client = new FakeClient();
  const map = makeMap(new MemoryFs());
  client.responder = (method, params) => {
    if (method === "session/new") return { sessionId: "s1" };
    const sessionId = (params as { sessionId: string }).sessionId;
    client.emit("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "```a2a-outcome\n{\"state\":\"input-required\",\"question\":\"?\"}\n```" },
      },
    });
    return { stopReason: "end_turn" };
  };
  const r = makeRunner(client, map);
  const first = await r.execute({ taskId: "t1", text: "q", contextId: "ctx", messageId: "m1" });
  assert.equal(first.state, "input-required");
  assert.equal(map.isPrompted("ctx"), true);
});

test("prompt 失败（超时 / 抛错）不置位 ⇒ 下轮仍注入", async () => {
  const client = new FakeClient();
  const map = makeMap(new MemoryFs());
  let promptCount = 0;
  client.responder = (method) => {
    if (method === "session/new") return { sessionId: "s1" };
    promptCount += 1;
    if (promptCount === 1) throw new Error("prompt boom");
    return { stopReason: "end_turn" };
  };
  const r = makeRunner(client, map);
  const broken = await r.execute({ taskId: "t1", text: "A", contextId: "ctx", messageId: "m1" });
  assert.equal(broken.state, "failed");
  assert.equal(map.isPrompted("ctx"), false);
  await r.execute({ taskId: "t2", text: "B", contextId: "ctx", messageId: "m2" });
  assert.ok(client.promptTexts()[1]?.startsWith(A2A_OUTCOME_CONVENTION), "首轮失败后第二轮仍应注入");
});

// ---------- ③ config 段 append / replace / 无 config ----------

test("append（缺省模式）= 追加在缺省约定之后；裸文本在其后", async () => {
  const client = new FakeClient();
  const map = makeMap(new MemoryFs());
  echoBackend(client);
  const r = makeRunner(client, map, { systemPrompt: "额外要求：中文回复" });
  await r.execute({ taskId: "t1", text: "任务", contextId: "ctx", messageId: "m1" });
  const text = client.promptTexts()[0] ?? "";
  assert.ok(text.startsWith(A2A_OUTCOME_CONVENTION));
  assert.ok(text.indexOf("额外要求：中文回复") > text.indexOf(A2A_OUTCOME_CONVENTION.slice(0, 20)), "append 应在缺省约定之后");
  assert.ok(text.endsWith("任务"));
  // 显式 append 与缺省等价
  const client2 = new FakeClient();
  echoBackend(client2);
  await makeRunner(client2, makeMap(new MemoryFs()), { systemPrompt: "X", systemPromptMode: "append" }).execute({
    taskId: "t1", text: "T", contextId: "ctx", messageId: "m1",
  });
  assert.equal(client2.promptTexts()[0], `${A2A_OUTCOME_CONVENTION}\n\nX\n\n---\n\nT`);
});

test("replace = 替换缺省约定（不再含 outcome 约定文案）", async () => {
  const client = new FakeClient();
  echoBackend(client);
  const r = makeRunner(client, makeMap(new MemoryFs()), {
    systemPrompt: "只说 replacements",
    systemPromptMode: "replace",
  });
  await r.execute({ taskId: "t1", text: "任务", contextId: "ctx", messageId: "m1" });
  const text = client.promptTexts()[0] ?? "";
  assert.ok(!text.includes("a2a-outcome convention"), "replace 不应含缺省约定");
  assert.equal(text, "只说 replacements\n\n---\n\n任务");
});

test("无自定义注入（injection 缺省）⇒ 仅缺省约定注入", async () => {
  const client = new FakeClient();
  echoBackend(client);
  const r = makeRunner(client, makeMap(new MemoryFs()));
  await r.execute({ taskId: "t1", text: "任务", contextId: "ctx", messageId: "m1" });
  assert.equal(client.promptTexts()[0], `${A2A_OUTCOME_CONVENTION}\n\n---\n\n任务`);
});
// ---------- ④ load/resume 跨进程不重注入 ----------

test("新 SessionMap 实例（模拟进程重启）load 恢复：prompted=true ⇒ 不重注入；false ⇒ 注入", async () => {
  const fs = new MemoryFs();
  const map1 = makeMap(fs);
  const client1 = new FakeClient();
  echoBackend(client1);
  await makeRunner(client1, map1).execute({ taskId: "t1", text: "A", contextId: "ctx", messageId: "m1" });
  assert.equal(map1.isPrompted("ctx"), true);

  // 进程重启：同一持久化文件新建 map + runner；load 成功复用 sessionId
  const map2 = makeMap(fs);
  const client2 = new FakeClient();
  client2.responder = (method) => (method === "session/load" ? {} : { stopReason: "end_turn" });
  await makeRunner(client2, map2).execute({ taskId: "t2", text: "B", contextId: "ctx", messageId: "m2" });
  assert.ok(client2.calls.some((c) => c.method === "session/load"));
  assert.equal(client2.promptTexts()[0], "B", "重启后 load 的已注入会话不得重注入");

  // 对照：未注入（prompted=false）的重启会话照常注入
  const map3 = makeMap(fs);
  const client3 = new FakeClient();
  echoBackend(client3);
  await makeRunner(client3, map3).execute({ taskId: "t3", text: "C", contextId: "c3", messageId: "m3" });
  assert.ok(client3.promptTexts()[0]?.startsWith(A2A_OUTCOME_CONVENTION));
});

test("映射回退新建会话 ⇒ 新会话首轮重新注入（set 初值 false 与 markPrompted 分两次持久化）", async () => {
  const fs = new MemoryFs();
  const map = makeMap(fs);
  const client = new FakeClient();
  echoBackend(client);
  const r = makeRunner(client, map);
  await r.execute({ taskId: "t1", text: "A", contextId: "ctx", messageId: "m1" });
  assert.equal(map.isPrompted("ctx"), true);

  // 后端拒 load/resume ⇒ 回退 session/new，映射被覆盖（新 session 未注入）
  const promptedAtPrompt: boolean[] = [];
  const persistedEntries: Array<Record<string, { prompted?: boolean }>> = [];
  client.responder = (method) => {
    if (method === "session/load" || method === "session/resume") throw new Error("gone");
    if (method === "session/new") return { sessionId: "s2" };
    promptedAtPrompt.push(map.isPrompted("ctx"));
    persistedEntries.push(JSON.parse(fs.files.get(MAP_PATH) ?? "{}") as Record<string, { prompted?: boolean }>);
    return { stopReason: "end_turn" };
  };
  await r.execute({ taskId: "t2", text: "B", contextId: "ctx", messageId: "m2" });
  assert.equal(map.get("ctx"), "s2");
  assert.equal(promptedAtPrompt[0], false, "set 之后、prompt 响应之前应为未注入");
  assert.equal(persistedEntries[0]?.["ctx"]?.prompted, false, "映射写入那次持久化落的是 prompted=false");
  assert.ok(client.promptTexts()[1]?.startsWith(A2A_OUTCOME_CONVENTION), "新会话首轮应注入");
  assert.equal(map.isPrompted("ctx"), true, "响应后 markPrompted 生效");
});

// ---------- ⑤ qoder ≥2 轮模拟（无 config 段，末轮 outcome 生效） ----------

test("qoder 模拟：无 config 两轮会话，末轮带 outcome 块仍正确解析", async () => {
  const client = new FakeClient();
  const map = makeMap(new MemoryFs());
  client.responder = (method, params) => {
    if (method === "session/new") return { sessionId: "s1" };
    const sessionId = (params as { sessionId: string }).sessionId;
    const text = (params as { prompt: Array<{ text: string }> }).prompt[0]?.text ?? "";
    const reply = text.endsWith("需要确认")
      ? "要确认目标环境。\n\n```a2a-outcome\n{\"state\":\"input-required\",\"question\":\"目标环境是哪个？\"}\n```"
      : "已完成。";
    client.emit("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } },
    });
    return { stopReason: "end_turn" };
  };
  const r = makeRunner(client, map); // 无 injection = qoder 缺省（仅约定）

  const first = await r.execute({ taskId: "t1", text: "开始任务", contextId: "ctx", messageId: "m1" });
  assert.equal(first.state, "completed");
  assert.equal(first.text, "已完成。");

  const second = await r.execute({ taskId: "t2", text: "需要确认", contextId: "ctx", messageId: "m2" });
  assert.equal(second.state, "input-required");
  assert.equal(second.question, "目标环境是哪个？");
  // 末轮无注入块前缀干扰：parseOutcome 直接消费裸回复文本
  assert.equal(parseOutcome("回复\n\n```a2a-outcome\n{\"state\":\"failed\",\"reason\":\"r\"}\n```").state, "failed");
});
