/**
 * v0.10.2 · 增补五 · 节点 M1（machine）定向单测。
 *
 * 覆盖「同 ctx 续接 ∧ 职责位变化 ⇒ warn」守卫的三条判据：
 * - ① 同 ctx 真续接（`sessionResumed`）且前角色已知、本轮变化 ⇒ **warn 出现**；
 * - ② 同 ctx 真续接且角色相同 ⇒ **不 warn**；
 * - ③ 老条目缺 `taskType` 键（前角色未知）⇒ 续接也不 warn（渐进生效）。
 *
 * 守卫只出声、不拒、不改行为 ⇒ 断言只查日志，不查任务态。
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpSessionRunner, type AcpRequestClient } from "../acp-bridge/acp/session.js";
import { SessionMap, type SessionMapFs } from "../acp-bridge/session-map.js";

const WARN_TOKEN = "同会话换职责位";

class FakeClient implements AcpRequestClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  responder: (method: string, params: unknown) => unknown = () => ({});

  request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return Promise.resolve().then(() => this.responder(method, params));
  }
  notify(): void {
    return undefined;
  }
  onNotification(): () => void {
    return () => undefined;
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

/** new 建会话 / load 真续接 / prompt 正常收轮。 */
function wire(client: FakeClient): void {
  client.responder = (method) => {
    if (method === "session/new") return { sessionId: "s1" };
    if (method === "session/load") return {};
    if (method === "session/prompt") return { stopReason: "end_turn" };
    return {};
  };
}

const countWarn = (logs: string[]): number => logs.filter((l) => l.includes(WARN_TOKEN)).length;

test("增补五 M1 ①：同 ctx 续接且换职责位 ⇒ warn 出现", async () => {
  const client = new FakeClient();
  wire(client);
  const logs: string[] = [];
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new MemoryFs() });
  const runner = new AcpSessionRunner({
    client,
    cwd: "/ws",
    timeoutMs: 1000,
    sessions,
    logger: (m) => void logs.push(m),
  });

  // 首轮 new 建会话，记 dev_manager；次轮同 ctx load 续接，换 project_manager ⇒ warn。
  await runner.execute({ taskId: "t1", text: "hi", contextId: "c1", messageId: "m1", taskType: "dev_manager" });
  assert.equal(sessions.getEntry("c1")?.taskType, "dev_manager", "首轮职责位应写穿进映射");

  const result = await runner.execute({
    taskId: "t2",
    text: "hi",
    contextId: "c1",
    messageId: "m2",
    taskType: "project_manager",
  });
  assert.equal(result.state, "completed", "warn 只出声，不改任务态");
  assert.ok(client.calls.some((c) => c.method === "session/load"), "次轮应走续接路径");
  assert.equal(countWarn(logs), 1, `应恰好 warn 一次：${logs.join("\n")}`);
  assert.ok(
    logs.some((l) => l.includes("prev=dev_manager") && l.includes("now=project_manager")),
    logs.join("\n"),
  );
});

test("增补五 M1 ②：同 ctx 续接且角色相同 ⇒ 不 warn", async () => {
  const client = new FakeClient();
  wire(client);
  const logs: string[] = [];
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new MemoryFs() });
  const runner = new AcpSessionRunner({
    client,
    cwd: "/ws",
    timeoutMs: 1000,
    sessions,
    logger: (m) => void logs.push(m),
  });

  await runner.execute({ taskId: "t1", text: "hi", contextId: "c1", messageId: "m1", taskType: "dev_manager" });
  await runner.execute({ taskId: "t2", text: "hi", contextId: "c1", messageId: "m2", taskType: "dev_manager" });

  assert.ok(client.calls.some((c) => c.method === "session/load"), "次轮应走续接路径");
  assert.equal(countWarn(logs), 0, `同角色不得 warn：${logs.join("\n")}`);
});

test("增补五 M1 ③：老条目缺 taskType 键（前角色未知）⇒ 续接也不 warn", async () => {
  const client = new FakeClient();
  wire(client);
  const logs: string[] = [];
  const sessions = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new MemoryFs() });
  // 模拟存量条目：只有 sessionId，无 taskType 键。
  sessions.set("c1", "s1");
  assert.equal(sessions.getEntry("c1")?.taskType, undefined);

  const runner = new AcpSessionRunner({
    client,
    cwd: "/ws",
    timeoutMs: 1000,
    sessions,
    logger: (m) => void logs.push(m),
  });

  await runner.execute({ taskId: "t1", text: "hi", contextId: "c1", messageId: "m1", taskType: "project_manager" });

  assert.ok(client.calls.some((c) => c.method === "session/load"), "该轮应走续接路径");
  assert.equal(countWarn(logs), 0, `前角色未知 ⇒ 渐进生效，不 warn：${logs.join("\n")}`);
});
