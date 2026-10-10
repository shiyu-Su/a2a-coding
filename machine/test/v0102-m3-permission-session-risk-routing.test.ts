/**
 * v0.10.2 · 节点 M-3 定向单测（machine：权限会话级路由 `sessionId → risk`）。
 *
 * 覆盖改造文档 §2.3 F-M2 漏点的两条验收判据：
 * - **①** 同进程两会话不同 `risk` **各自生效** —— 喂 per-request override 可观测
 *   （`execute` 登记 → 处理器按 `session/request_permission` params 的 `sessionId` 取档；
 *   `startBridge` 装配贯通的真链路用例见 `v0102-m3-e2e-session-risk.test.ts`）；
 * - **②** 不喂 override ⇒ **回落进程级 `--risk`**（逐字现状：决策与日志形状均不变）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPermissionHandler,
  normalizeRisk,
  SessionRiskRegistry,
  MAX_SESSION_RISKS,
  type AcpPermissionOption,
} from "../acp-bridge/acp/permission.js";
import { AcpSessionRunner, type AcpRequestClient } from "../acp-bridge/acp/session.js";

const ALLOW: AcpPermissionOption = { optionId: "allow-1", name: "Allow", kind: "allow_once" };
const REJECT: AcpPermissionOption = { optionId: "reject-1", name: "Reject", kind: "reject_once" };

/* ------------------------------------------------------------------ *
 * A. 纯函数：normalizeRisk 闭集
 * ------------------------------------------------------------------ */

test("M-3 normalizeRisk：三档命中；空串 / 未知档 / undefined ⇒ undefined（= 未给 override）", () => {
  assert.equal(normalizeRisk("read"), "read");
  assert.equal(normalizeRisk("write"), "write");
  assert.equal(normalizeRisk("full"), "full");
  assert.equal(normalizeRisk(""), undefined);
  assert.equal(normalizeRisk("readonly"), undefined);
  assert.equal(normalizeRisk(undefined), undefined);
});

/* ------------------------------------------------------------------ *
 * B. 处理器：会话档路由 + 进程级回落
 * ------------------------------------------------------------------ */

test("M-3 ①：同进程两会话不同 risk 各自生效（read 拒写 / full 批 always）", () => {
  const registry = new SessionRiskRegistry();
  registry.register("s-read", "read");
  registry.register("s-full", "full");
  const handler = createPermissionHandler("write", undefined, registry); // 进程级 write 不参与两问

  const readOutcome = handler("session/request_permission", {
    sessionId: "s-read",
    options: [ALLOW, REJECT],
  });
  assert.deepEqual(readOutcome, { outcome: { outcome: "selected", optionId: "reject-1" } });

  const fullOutcome = handler("session/request_permission", {
    sessionId: "s-full",
    options: [ALLOW, { optionId: "allow-always", name: "Always", kind: "allow_always" }],
  });
  assert.deepEqual(fullOutcome, { outcome: { outcome: "selected", optionId: "allow-always" } });
});

test("M-3 ②：会话未登记 ⇒ 回落进程级 risk（read 进程档下新会话仍拒写）", () => {
  const registry = new SessionRiskRegistry();
  registry.register("s-other", "full");
  const handler = createPermissionHandler("read", undefined, registry);

  const outcome = handler("session/request_permission", {
    sessionId: "s-unregistered",
    options: [ALLOW, REJECT],
  });
  assert.deepEqual(outcome, { outcome: { outcome: "selected", optionId: "reject-1" } });
});

test("M-3 ②：不传登记表 / params 无 sessionId ⇒ 逐字现状（进程级判定 + 日志形状不变）", () => {
  const logs: string[] = [];
  const handler = createPermissionHandler("write", (m) => void logs.push(m));
  assert.deepEqual(handler("session/request_permission", { options: [ALLOW] }), {
    outcome: { outcome: "selected", optionId: "allow-1" },
  });
  assert.deepEqual(logs, ["[acp-permission] risk=write → selected(allow-1)"]);

  const registry = new SessionRiskRegistry();
  registry.register("s-read", "read");
  const handler2 = createPermissionHandler("write", undefined, registry);
  assert.deepEqual(handler2("session/request_permission", { options: [ALLOW] }), {
    outcome: { outcome: "selected", optionId: "allow-1" },
  }, "params 缺 sessionId ⇒ 无从路由 ⇒ 进程级");
});

test("M-3 登记表：同会话重复登记 ⇒ 后者覆盖；容量有界（超界按插入序淘汰最旧）", () => {
  const registry = new SessionRiskRegistry();
  registry.register("s1", "write");
  registry.register("s1", "read");
  assert.equal(registry.lookup("s1"), "read");

  for (let i = 0; i < MAX_SESSION_RISKS + 5; i += 1) {
    registry.register(`k${String(i)}`, "full");
  }
  assert.equal(registry.size(), MAX_SESSION_RISKS);
  assert.equal(registry.lookup("k0"), undefined, "最旧条目应已淘汰");
  assert.equal(registry.lookup(`k${String(MAX_SESSION_RISKS + 4)}`), "full");
});

/* ------------------------------------------------------------------ *
 * C. execute 登记点：overrides.risk → 共享登记表
 * ------------------------------------------------------------------ */

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

function wireNewSession(client: FakeClient, sessionId: string): void {
  client.responder = (method) => {
    if (method === "session/new") return { sessionId };
    if (method === "session/prompt") return { stopReason: "end_turn" };
    return {};
  };
}

const INPUT = { taskId: "t1", text: "hi", contextId: "ctx", messageId: "m1" };

test("M-3 ①：execute 喂 risk override ⇒ 以 ACP sessionId 登记进共享表 + 留痕日志", async () => {
  const client = new FakeClient();
  wireNewSession(client, "s-42");
  const registry = new SessionRiskRegistry();
  const logs: string[] = [];
  const runner = new AcpSessionRunner({
    client,
    cwd: "/ws",
    timeoutMs: 1_000,
    sessionRisks: registry,
    logger: (m) => void logs.push(m),
  });

  const result = await runner.execute({ ...INPUT, overrides: { risk: "read" } });
  assert.equal(result.state, "completed");
  assert.equal(registry.lookup("s-42"), "read", "生效键 = ACP sessionId（非 contextId）");
  assert.equal(
    logs.some((l) => l.includes("会话级 risk=read 已登记（sessionId=s-42）")),
    true,
    `登记须留痕：${logs.join("\n")}`,
  );
});

test("M-3 ②：execute 不喂 / 喂非法档 ⇒ 零登记 ⇒ 权限处理器保持进程级（逐字现状）", async () => {
  const client = new FakeClient();
  wireNewSession(client, "s-43");
  const registry = new SessionRiskRegistry();
  const runner = new AcpSessionRunner({ client, cwd: "/ws", timeoutMs: 1_000, sessionRisks: registry });

  await runner.execute({ ...INPUT });
  await runner.execute({ taskId: "t2", text: "hi", contextId: "ctx2", messageId: "m2", overrides: { risk: "superuser" } });
  assert.equal(registry.size(), 0, "缺省与非法档都不得进表（逐键宽容口径同 M-2）");

  const handler = createPermissionHandler("read", undefined, registry);
  assert.deepEqual(handler("session/request_permission", { sessionId: "s-43", options: [ALLOW] }), {
    outcome: { outcome: "cancelled" },
  }, "进程档 read：无 allow 可拒则 cancelled（三档语义不因本节点改动）");
});

/* ------------------------------------------------------------------ *
 * D. startBridge 装配：会话建 → 后端 request_permission → 会话档生效
 *    （跨组件贯通由 test/v0102-m3-e2e-session-risk.test.ts 的真链路用例覆盖）
 * ------------------------------------------------------------------ */

test("M-3 ②：三档判定矩阵不因本节点改动（read 拒 / write 批首个 allow / full 批 always）", () => {
  assert.deepEqual(createPermissionHandler("read")("session/request_permission", { options: [ALLOW, REJECT] }), {
    outcome: { outcome: "selected", optionId: "reject-1" },
  });
  assert.deepEqual(createPermissionHandler("write")("session/request_permission", { options: [ALLOW, REJECT] }), {
    outcome: { outcome: "selected", optionId: "allow-1" },
  });
  assert.deepEqual(
    createPermissionHandler("full")("session/request_permission", {
      options: [ALLOW, { optionId: "allow-always", name: "Always", kind: "allow_always" }],
    }),
    { outcome: { outcome: "selected", optionId: "allow-always" } },
  );
});
