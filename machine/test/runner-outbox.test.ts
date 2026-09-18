/**
 * `machine/launcher/runner-outbox.ts` 单元测试（v0.7.0 · 节点 M4·MB2）。
 *
 * 覆盖节点门禁：
 * - **落盘**：`deliver()` 先把结果写 `.a2a/outbox/<taskId>.json`（七字段，schema 不变）；
 * - **回传 + ack**：`POST /runner/result`（Bearer + `claimToken`），HTTP 2xx ⇒ 删文件；
 * - **断网→重连→补投**：投递失败保留文件，重连后重放并 ack 清空；
 * - **重复回传幂等**：同 `taskId` 仅持 1 份文件，单轮只投一次（桥侧 upsert 兜重复）；
 * - **boot 不补发**：`start()` 不扫盘、不回放既有 outbox 文件（Out of Scope，显式断言）；
 * - 后台循环：断网后自动退避重试，重连即补投并清空。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileOutbox, outboxDirOf } from "../launcher/runner-outbox.js";
import type { RunnerLogger } from "../launcher/runner.js";
import type { RunnerTaskResult } from "../launcher/runner-exec.js";
import type { BridgeConfig } from "../types.js";

const BRIDGE: BridgeConfig = { url: "http://bridge.test:3200", token: "tok-abc" };

const SILENT: RunnerLogger = {
  info: (message) => void message,
  warn: (message) => void message,
  error: (message) => void message,
};

const FINISHED_AT = "2026-09-18T01:00:00.000Z";

function makeResult(
  taskId: string,
  state: RunnerTaskResult["state"] = "completed",
  text = "done",
): RunnerTaskResult {
  return {
    taskId,
    machineId: "m-test",
    projectId: "alpha",
    contextId: "ctx-1",
    state,
    text,
    artifacts: [{ artifactId: "a1", parts: [{ kind: "text", text: "art" }] }],
    finishedAt: FINISHED_AT,
  };
}

/** 独立临时 outbox 目录（测试结束清理） */
function tmpOutboxDir(): string {
  return mkdtempSync(join(tmpdir(), "a2a-outbox-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function postOk(): Response {
  return jsonResponse(200, { result: { ack: true }, data: null, error: null });
}

/** 轮询至条件满足（避免依赖真实退避定时器） */
async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitUntil 超时");
}

/** 构造一个只注入单测所需缺省的 outbox（fetch 由各测试提供） */
function makeOutbox(
  dir: string,
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
): FileOutbox {
  return new FileOutbox({
    dir,
    bridge: BRIDGE,
    fetch: fetchFn,
    logger: SILENT,
    now: () => new Date(FINISHED_AT),
    random: () => 0.5,
    // 退避等待立即返回：单测不等真实 1s/2s…
    sleep: async () => {},
  });
}

test("outboxDirOf：目录恒为 <machine 根>/.a2a/outbox", () => {
  assert.equal(outboxDirOf(join("root")), join("root", ".a2a", "outbox"));
});

test("deliver：先落盘七字段 → POST /runner/result（Bearer + claimToken）→ 2xx ack ⇒ 删文件", async () => {
  const dir = tmpOutboxDir();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const outbox = makeOutbox(dir, async (url, init) => {
    calls.push({ url, init });
    return postOk();
  });

  const result = makeResult("t1");
  outbox.deliver(result, { claimToken: "ct-1" });

  const file = join(dir, "t1.json");
  assert.equal(existsSync(file), true, "deliver 必须先落盘");
  // 落盘内容 = 结果 schema 七字段（不因回传凭证而膨胀）
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), result);

  const report = await outbox.flushOnce();
  assert.deepEqual(report, { attempted: 1, acked: 1 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://bridge.test:3200/runner/result");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], "Bearer tok-abc");
  assert.equal(headers["content-type"], "application/json");
  // 回传体 = 结果 + claim_token（桥侧校验用）
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { ...result, claimToken: "ct-1" });

  assert.equal(existsSync(file), false, "ack 后必须删文件");
  assert.equal(outbox.pendingCount, 0);
  assert.equal(outbox.deliveredCount, 1);

  cleanup(dir);
});

test("断网→重连→补投：失败保留文件，重连后重放并 ack 清空", async () => {
  const dir = tmpOutboxDir();
  let online = false;
  let attempts = 0;
  const outbox = makeOutbox(dir, async () => {
    attempts += 1;
    if (!online) {
      return jsonResponse(503, {
        result: null,
        data: null,
        error: { code: "bridge_down", message: "桥不可达" },
      });
    }
    return postOk();
  });

  const file = join(dir, "t1.json");
  outbox.deliver(makeResult("t1"));

  // 断网：投递失败 ⇒ 文件保留、未 ack
  assert.deepEqual(await outbox.flushOnce(), { attempted: 1, acked: 0 });
  assert.equal(existsSync(file), true);
  assert.equal(outbox.pendingCount, 1);
  assert.equal(outbox.lastErrorText?.includes("HTTP 503"), true);

  // 持续断网：仍保留（可重复重放）
  assert.deepEqual(await outbox.flushOnce(), { attempted: 1, acked: 0 });
  assert.equal(existsSync(file), true);

  // 重连：补投成功 ⇒ ack 清空
  online = true;
  assert.deepEqual(await outbox.flushOnce(), { attempted: 1, acked: 1 });
  assert.equal(existsSync(file), false);
  assert.equal(outbox.pendingCount, 0);
  assert.equal(attempts, 3);

  cleanup(dir);
});

test("重复回传幂等：同 taskId 仅持 1 份文件、单轮只投一次（桥侧 upsert 兜重复）", async () => {
  const dir = tmpOutboxDir();
  const bodies: Array<Record<string, unknown>> = [];
  const outbox = makeOutbox(dir, async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return postOk();
  });

  outbox.deliver(makeResult("t1", "completed", "first"));
  outbox.deliver(makeResult("t1", "failed", "second"));

  assert.deepEqual(readdirSync(dir), ["t1.json"], "同 taskId 覆盖 ⇒ 始终一份");
  assert.equal(outbox.pendingCount, 1);

  assert.deepEqual(await outbox.flushOnce(), { attempted: 1, acked: 1 });
  assert.equal(bodies.length, 1, "同 taskId 一轮只投一次");
  assert.equal(bodies[0]?.["state"], "failed"); // 以最后一次落盘为准
  assert.equal(readdirSync(dir).length, 0);

  cleanup(dir);
});

test("boot 不补发：start() 前已存在的 outbox 文件不被回放（Out of Scope 显式断言）", async () => {
  const dir = tmpOutboxDir();
  const stale = join(dir, "stale.json");
  writeFileSync(stale, JSON.stringify(makeResult("stale")), "utf8");

  let calls = 0;
  const outbox = makeOutbox(dir, async () => {
    calls += 1;
    return postOk();
  });

  outbox.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  outbox.stop();
  await outbox.whenStopped();

  assert.equal(calls, 0, "boot 不得回放既有 outbox 文件");
  assert.equal(existsSync(stale), true, "既有文件保留（不补发、不删除）");

  cleanup(dir);
});

test("后台循环：断网后自动退避重试，重连即补投并删文件", async () => {
  const dir = tmpOutboxDir();
  let attempts = 0;
  let resolveDelivered: (() => void) | null = null;
  const delivered = new Promise<void>((resolve) => {
    resolveDelivered = resolve;
  });
  const outbox = makeOutbox(dir, async () => {
    attempts += 1;
    if (attempts < 2) return jsonResponse(503, { result: null, data: null, error: null });
    resolveDelivered?.();
    return postOk();
  });

  const file = join(dir, "t1.json");
  outbox.start();
  outbox.deliver(makeResult("t1"));

  await delivered;
  await waitUntil(() => !existsSync(file));
  assert.equal(outbox.pendingCount, 0);

  outbox.stop();
  await outbox.whenStopped();
  assert.equal(attempts, 2);

  cleanup(dir);
});
