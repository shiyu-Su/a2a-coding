/**
 * `machine/acp-bridge/a2a-server.ts` 定向单测（REQ-v0.8.0-2026-09-19-01 · 节点 B1）。
 *
 * 门禁判据：
 * - 请求/响应形状 == `launcher/a2a-client.ts` 期望（直接复用其 postJsonRpc / taskViewOf 反向验证）；
 * - `message/send` `configuration.blocking:false` **立即**回 task 句柄（执行器未决时 state=working）；
 * - `tasks/get` 轮询至终态（completed 文本 + artifacts 可解析）；
 * - `tasks/cancel` 置 canceled 且通知执行器，迟到结果不覆盖终态；
 * - 未知方法 / 未知任务 → JSON-RPC 错误；未知路径 → 404。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAcpA2AServer, type AcpA2AServer } from "../acp-bridge/a2a-server.js";
import type {
  TaskExecutionInput,
  TaskExecutionResult,
  TaskExecutor,
} from "../acp-bridge/types.js";
import { A2A_TERMINAL_STATES, postJsonRpc, taskViewOf } from "../launcher/a2a-client.js";

/** 可控执行器：execute 挂起至显式 settle（验证 blocking:false 不等待）。 */
class DeferredExecutor implements TaskExecutor {
  private readonly resolvers = new Map<string, (r: TaskExecutionResult) => void>();
  readonly cancelCalls: string[] = [];

  execute(input: TaskExecutionInput): Promise<TaskExecutionResult> {
    return new Promise<TaskExecutionResult>((resolve) => {
      this.resolvers.set(input.taskId, resolve);
    });
  }

  settle(taskId: string, result: TaskExecutionResult): void {
    const resolve = this.resolvers.get(taskId);
    if (resolve === undefined) throw new Error(`无挂起执行：${taskId}`);
    this.resolvers.delete(taskId);
    resolve(result);
  }

  cancel(taskId: string): void {
    this.cancelCalls.push(taskId);
  }
}

const alwaysCompleted: TaskExecutor = {
  execute: () => Promise.resolve<TaskExecutionResult>({ state: "completed" }),
};

async function withServer<T>(executor: TaskExecutor, fn: (base: string) => Promise<T>): Promise<T> {
  const app: AcpA2AServer = createAcpA2AServer({ executor });
  await app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${String(app.port())}`);
  } finally {
    await app.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 轮询 tasks/get 至终态（上限 ~2s，超时抛错）。 */
async function waitTerminal(base: string, id: string): Promise<unknown> {
  for (let i = 0; i < 200; i += 1) {
    const result = await postJsonRpc(base, "tasks/get", { id }, 5_000);
    if (A2A_TERMINAL_STATES.has(taskViewOf(result).state)) return result;
    await sleep(10);
  }
  throw new Error("等待终态超时");
}

function sendParams(text: string, messageId: string, contextId: string): unknown {
  return {
    message: { role: "user", parts: [{ kind: "text", text }], messageId, contextId },
    configuration: { blocking: false },
  };
}

test("message/send blocking:false：立即回 task 句柄（执行器未决 → state=working）", async () => {
  const executor = new DeferredExecutor();
  await withServer(executor, async (base) => {
    const sent = await postJsonRpc(base, "message/send", sendParams("hi", "m1", "c1"), 5_000);
    const view = taskViewOf(sent);
    assert.equal(view.state, "working");
    assert.ok(view.id !== null && view.id.length > 0);
    const id = view.id;
    if (id === null) throw new Error("缺少 task id");

    // 执行器未决：tasks/get 仍 working
    const got = await postJsonRpc(base, "tasks/get", { id }, 5_000);
    assert.equal(taskViewOf(got).state, "working");

    executor.settle(id, { state: "completed", text: "done" });
    const settled = await waitTerminal(base, id);
    const settledView = taskViewOf(settled);
    assert.equal(settledView.state, "completed");
    assert.equal(settledView.text, "done");
  });
});

test("形状兼容：completed 文本 + artifacts 经 a2a-client 解析", async () => {
  const executor: TaskExecutor = {
    execute: (input) =>
      Promise.resolve<TaskExecutionResult>({
        state: "completed",
        text: `echo:${input.text}`,
        artifacts: [{ artifactId: "a1", name: "out.txt", parts: [{ kind: "text", text: "file" }] }],
      }),
  };
  await withServer(executor, async (base) => {
    const sent = await postJsonRpc(base, "message/send", sendParams("hello", "m2", "c2"), 5_000);
    const id = taskViewOf(sent).id;
    if (id === null) throw new Error("缺少 task id");
    const settled = await waitTerminal(base, id);
    const view = taskViewOf(settled);
    assert.equal(view.state, "completed");
    assert.equal(view.text, "echo:hello\nfile");
    assert.equal(view.artifacts.length, 1);
  });
});

test("tasks/cancel：置 canceled 且通知执行器，迟到结果不覆盖终态", async () => {
  const executor = new DeferredExecutor();
  await withServer(executor, async (base) => {
    const sent = await postJsonRpc(base, "message/send", sendParams("x", "m3", "c3"), 5_000);
    const id = taskViewOf(sent).id;
    if (id === null) throw new Error("缺少 task id");

    const canceled = await postJsonRpc(base, "tasks/cancel", { id }, 5_000);
    assert.equal(taskViewOf(canceled).state, "canceled");
    assert.deepEqual(executor.cancelCalls, [id]);

    // 迟到 settle 不得把 canceled 改成 completed
    executor.settle(id, { state: "completed", text: "late" });
    await sleep(20);
    const got = await postJsonRpc(base, "tasks/get", { id }, 5_000);
    assert.equal(taskViewOf(got).state, "canceled");
  });
});

test("执行器抛错 → 任务置 failed（错误文本入 status.message）", async () => {
  const executor: TaskExecutor = {
    execute: () => Promise.reject(new Error("boom")),
  };
  await withServer(executor, async (base) => {
    const sent = await postJsonRpc(base, "message/send", sendParams("x", "m4", "c4"), 5_000);
    const id = taskViewOf(sent).id;
    if (id === null) throw new Error("缺少 task id");
    const settled = await waitTerminal(base, id);
    const view = taskViewOf(settled);
    assert.equal(view.state, "failed");
    assert.equal(view.statusText, "boom");
  });
});

test("未知方法 → JSON-RPC 错误（postJsonRpc 抛出）", async () => {
  await withServer(alwaysCompleted, async (base) => {
    await assert.rejects(() => postJsonRpc(base, "no/such/method", {}, 5_000), /未知方法/);
  });
});

test("tasks/get 未知任务 → JSON-RPC 错误", async () => {
  await withServer(alwaysCompleted, async (base) => {
    await assert.rejects(() => postJsonRpc(base, "tasks/get", { id: "nope" }, 5_000), /未知任务/);
  });
});

test("未知路径 → 404", async () => {
  await withServer(alwaysCompleted, async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  });
});
