/**
 * M3 桥任务终态 artifacts 接线单测（REQ-v0.8.1-2026-09-19-01 · 节点 M3）。
 *
 * 判据（去重口径为硬性）：
 * - completed ⇒ `status.message` 不带结果文本，`name="response"` 单 text part artifact
 *   承载 `parseOutcome` **剥块后**全文；
 * - input-required / failed ⇒ message = question/reason 短文 + artifact = 剥块全文；
 * - 执行器给出未剥块原文 ⇒ 台账侧防御性剥块（无 ```a2a-outcome 围栏残留）；
 * - orch `resultText`（message + artifacts 拼接）对 completed 不双填（文本恰出现一次）。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskRegistry } from "../acp-bridge/task-registry.js";
import { A2A_OUTCOME_CONVENTION } from "../acp-bridge/outcome.js";
import type { TaskExecutionInput, TaskExecutionResult, TaskExecutor } from "../acp-bridge/types.js";
import { statusMessageText, resultText } from "../launcher/a2a-client.js";

/** 可控执行器：settle 显式给终态结果（与 acp-bridge-a2a.test.ts 同型，直连台账）。 */
class ControllableExecutor implements TaskExecutor {
  readonly resolvers = new Map<string, (r: TaskExecutionResult) => void>();

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
}

function block(json: string): string {
  return `\`\`\`a2a-outcome\n${json}\n\`\`\``;
}

function artifactText(artifact: unknown): string {
  const parts = (artifact as { parts: Array<{ text: string }> }).parts;
  return parts.map((p) => p.text).join("\n");
}

/** settle 之后放行一个宏任务，确保 run() 的 `await execute` 续体（applyResult 回写）已执行。 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

test("M3 completed：message 无结果文本 + response artifact 承载剥块全文", async () => {
  const executor = new ControllableExecutor();
  const registry = new TaskRegistry({ executor, idFactory: () => "t1" });
  const task = await registry.send({
    message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: "m1" },
  });
  executor.settle("t1", {
    state: "completed",
    text: `答复正文。\n\n${block('{"state":"completed"}')}`,
  });
  await flush();
  assert.equal(task.status.state, "completed");
  assert.equal(task.status.message, undefined);
  assert.equal(task.artifacts.length, 1);
  assert.equal(task.artifacts[0]?.name, "response");
  assert.equal(task.artifacts[0]?.parts.length, 1);
  assert.equal(artifactText(task.artifacts[0]), "答复正文。");
  // 去重口径：resultText（message+artifacts 拼接）不含 outcome 围栏残留
  assert.equal(resultText(task), "答复正文。");
});

test("M3 input-required：message = question 短文，artifact = 剥块全文（短重复沿口径）", async () => {
  const executor = new ControllableExecutor();
  const registry = new TaskRegistry({ executor, idFactory: () => "t2" });
  const task = await registry.send({
    message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: "m2" },
  });
  executor.settle("t2", {
    state: "input-required",
    text: "需要先确认部署环境。\n\n说明段落。",
    question: "需要先确认部署环境。",
  });
  await flush();
  assert.equal(task.status.state, "input-required");
  assert.equal(statusMessageText(task), "需要先确认部署环境。");
  assert.equal(task.artifacts.length, 1);
  assert.equal(artifactText(task.artifacts[0]), "需要先确认部署环境。\n\n说明段落。");
});

test("M3 failed：message = reason 短文，artifact = 剥块全文", async () => {
  const executor = new ControllableExecutor();
  const registry = new TaskRegistry({ executor, idFactory: () => "t3" });
  const task = await registry.send({
    message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: "m3" },
  });
  executor.settle("t3", { state: "failed", text: "缺依赖。已尝试安装失败。", reason: "缺依赖" });
  await flush();
  assert.equal(task.status.state, "failed");
  assert.equal(statusMessageText(task), "缺依赖");
  assert.equal(artifactText(task.artifacts[0]), "缺依赖。已尝试安装失败。");
});

test("M3 failed 无 reason（执行器抛错路径的裸错误文本）⇒ message 回退全文，行为不回退", async () => {
  const executor: TaskExecutor = {
    execute: () => Promise.reject(new Error("boom")),
  };
  const registry = new TaskRegistry({ executor, idFactory: () => "t4" });
  const task = await registry.send({
    message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: "m4" },
  });
  // run() 的 catch 已同步 settle（promise 链微任务内完成）
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(task.status.state, "failed");
  assert.equal(statusMessageText(task), "boom");
  assert.equal(artifactText(task.artifacts[0]), "boom");
});

test("M3 防御性剥块：执行器给未剥块原文 ⇒ artifact 无围栏残留", async () => {
  const executor = new ControllableExecutor();
  const registry = new TaskRegistry({ executor, idFactory: () => "t5" });
  const task = await registry.send({
    message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: "m5" },
  });
  executor.settle("t5", {
    state: "input-required",
    text: `问题？\n\n${block('{"state":"input-required","question":"问题？"}')}`,
    question: "问题？",
  });
  await flush();
  const text = artifactText(task.artifacts[0]);
  assert.ok(!text.includes("a2a-outcome"), text);
  assert.equal(text, "问题？");
});

test("M3 约定文本零改动：A2A_OUTCOME_CONVENTION 常量不因接线变更而漂移", () => {
  assert.ok(A2A_OUTCOME_CONVENTION.includes("a2a-outcome"));
});

// ---------- REQ-v0.8.10-2026-09-24-01 · M-N3：台账终态支路（幽灵轮的迟到取消）----------

/** 记录 `cancel` 通知落点的可控执行器（M-N3：断言「通知发了没」「state 动没动」） */
class SpyExecutor extends ControllableExecutor {
  readonly canceled: string[] = [];

  cancel(taskId: string): void {
    this.canceled.push(taskId);
  }
}

test("M-N3 终态支路：abandoned 的 failed 轮收到迟到 cancel ⇒ 仍通知执行器，但 state 不变（不触 CAS）", async () => {
  const executor = new SpyExecutor();
  const registry = new TaskRegistry({ executor, idFactory: () => "tg-1" });
  const task = await registry.send({
    message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: "m1" },
  });
  executor.settle("tg-1", { state: "failed", text: "会话满窗", abandoned: true });
  await flush();
  assert.equal(task.status.state, "failed");

  const again = await registry.cancel("tg-1");
  assert.deepEqual(executor.canceled, ["tg-1"], "幽灵轮必须拿得到取消（纯 launcher 侧覆盖不了这一格）");
  assert.equal(again?.status.state, "failed", "硬约束 ②：终态支路**只通知、不改 state**");
});

test("M-N3 终态支路（负向）：未标 abandoned 的终态轮 ⇒ 幂等返回、零通知（正常收敛的轮不被打扰）", async () => {
  const executor = new SpyExecutor();
  const registry = new TaskRegistry({ executor, idFactory: () => "tn-1" });
  await registry.send({
    message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: "m1" },
  });
  executor.settle("tn-1", { state: "completed", text: "正常收敛" });
  await flush();

  const task = await registry.cancel("tn-1");
  assert.equal(task?.status.state, "completed");
  assert.deepEqual(executor.canceled, []);
});

test("M-N3 在飞支路不回归：working 轮 cancel ⇒ 通知执行器 + state 置 canceled", async () => {
  const executor = new SpyExecutor();
  const registry = new TaskRegistry({ executor, idFactory: () => "tw-1" });
  const task = await registry.send({
    message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: "m1" },
  });

  const canceled = await registry.cancel("tw-1");
  assert.deepEqual(executor.canceled, ["tw-1"]);
  assert.equal(canceled?.status.state, "canceled");
  assert.equal(task.status.state, "canceled");
});
