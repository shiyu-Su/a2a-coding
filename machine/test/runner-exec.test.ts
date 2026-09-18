/**
 * `machine/launcher/runner-exec.ts` + Runner 命令分支单元测试（v0.7.0 · 节点 M3·MB1）。
 *
 * 覆盖节点门禁：
 * - **三分支**：dispatch（台账登记 → ensure → A2A message/send → 组装结果交 outbox）、
 *   stop（in-flight>0 拒收 `error:"in-flight"`；否则 stop → ack）、cancel-task（台账定位 →
 *   A2A tasks/cancel；wrapper 不响应 → ack error 且任务照常终态）；
 * - **in-flight 台账计 / 清**：dispatch 登记即 `size=1`，执行完成回落 `size=0`；
 * - **unknown-task 回执**：台账无此 taskId → `error:"unknown-task"` 且零 A2A 调用；
 * - 命令解析（三类 + 别名 + 非法即 null）与任务态映射；
 * - Runner 循环接驳：stop 回执经**下一轮连接体** `acks` 回传。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { A2AFetch } from "../launcher/a2a-client.js";
import { InFlightLedger, Runner, type RunnerLogger } from "../launcher/runner.js";
import {
  RunnerCommandExecutor,
  mapTaskState,
  parseRunnerCommand,
  type RunnerCommand,
  type RunnerExecHost,
  type RunnerOutbox,
  type RunnerResultCredential,
  type RunnerTaskResult,
} from "../launcher/runner-exec.js";
import type { SelfCheckResult } from "../launcher/self-check.js";
import type { BridgeConfig, MachineConfig, ProjectConfig } from "../types.js";

const BRIDGE: BridgeConfig = { url: "http://bridge.test:3200", token: "tok-abc" };

const PROJECT: ProjectConfig = {
  projectId: "alpha",
  workspace: "C:/ws/alpha",
  agentKind: "opencode",
  a2aPort: 4321,
};

const MACHINE: MachineConfig = {
  machineId: "m-test",
  launcher: { port: 3100, bridge: BRIDGE },
  projects: [PROJECT],
};

const SELF_CHECK_OK: SelfCheckResult = { ok: true, failures: [] };

const SILENT: RunnerLogger = {
  info: (message) => void message,
  warn: (message) => void message,
  error: (message) => void message,
};

const STARTED_AT = "2026-09-18T00:00:00.000Z";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A2A JSON-RPC 成功响应（`postJsonRpc` 只读 `result`） */
function rpcResult(result: unknown): Response {
  return jsonResponse(200, { jsonrpc: "2.0", id: "rpc-1", result });
}

/** 终态 Task（status.message 文本 + artifacts） */
function taskResult(id: string, state: string, text: string, artifacts: unknown[] = []): unknown {
  return {
    id,
    status: { state, message: { role: "agent", parts: [{ kind: "text", text }] } },
    artifacts,
  };
}

interface HostCalls {
  ensured: string[];
  stopped: string[];
}

/** 结构化假宿主（AgentManager 的 ensure/stop/getProject 三面） */
function makeHost(calls: HostCalls, project: ProjectConfig | null = PROJECT): RunnerExecHost {
  return {
    ensure: async (projectId) => {
      calls.ensured.push(projectId);
      return { endpoint: "http://127.0.0.1:4321" };
    },
    stop: async (projectId) => {
      calls.stopped.push(projectId);
      return { stopped: true };
    },
    getProject: (projectId) => {
      if (project === null || project.projectId !== projectId) {
        throw new Error(`未知项目：${projectId}`);
      }
      return project;
    },
  };
}

/** 捕获 outbox 投递并可 await 首次投递 */
function captureOutbox(): {
  outbox: RunnerOutbox;
  delivered: RunnerTaskResult[];
  wait: () => Promise<RunnerTaskResult>;
} {
  const delivered: RunnerTaskResult[] = [];
  let resolveFn: ((result: RunnerTaskResult) => void) | null = null;
  const first = new Promise<RunnerTaskResult>((resolve) => {
    resolveFn = resolve;
  });
  return {
    delivered,
    outbox: {
      deliver: (result) => {
        delivered.push(result);
        if (resolveFn !== null) {
          const done = resolveFn;
          resolveFn = null;
          done(result);
        }
      },
    },
    wait: () => first,
  };
}

function makeExecutor(options: {
  host: RunnerExecHost;
  ledger: InFlightLedger;
  outbox: RunnerOutbox;
  fetch?: A2AFetch;
}): RunnerCommandExecutor {
  return new RunnerCommandExecutor({
    host: options.host,
    ledger: options.ledger,
    outbox: options.outbox,
    machineId: "m-test",
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    logger: SILENT,
    now: () => new Date(STARTED_AT),
  });
}

test("dispatch：台账登记 → ensure → A2A message/send → 组装结果交 outbox（终态 + artifacts），台账计/清", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const ledger = new InFlightLedger();
  const cap = captureOutbox();
  const callsLog: string[] = [];
  const fetchFn: A2AFetch = async (url, init) => {
    const req = JSON.parse(String(init.body)) as { method: string; params: unknown };
    callsLog.push(`${url}#${req.method}`);
    if (req.method === "message/send") {
      return rpcResult(
        taskResult("a2a-1", "completed", "done", [
          { artifactId: "a1", parts: [{ kind: "text", text: "art" }] },
        ]),
      );
    }
    throw new Error(`未预期方法：${req.method}`);
  };
  const exec = makeExecutor({ host: makeHost(calls), ledger, outbox: cap.outbox, fetch: fetchFn });

  const ack = await exec.handle({
    type: "dispatch",
    taskId: "t1",
    projectId: "alpha",
    contextId: "ctx-1",
    payload: "hi",
  });

  assert.equal(ack, null); // dispatch 不回 ack（结果走 outbox）
  assert.equal(ledger.has("t1"), true); // 已登记
  assert.equal(ledger.size, 1); // in-flight 计数
  assert.equal(ledger.projectOf("t1"), "alpha");
  assert.deepEqual(calls.ensured, ["alpha"]);

  const result = await cap.wait();
  assert.equal(result.taskId, "t1");
  assert.equal(result.machineId, "m-test");
  assert.equal(result.projectId, "alpha");
  assert.equal(result.contextId, "ctx-1");
  assert.equal(result.state, "completed");
  assert.ok(result.text.includes("done"));
  assert.ok(result.text.includes("art"));
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.finishedAt, STARTED_AT);

  assert.equal(ledger.size, 0); // 终态后清台账
  assert.equal(ledger.has("t1"), false);
  assert.equal(callsLog[0], "http://127.0.0.1:4321/a2a/jsonrpc#message/send");
});

test("dispatch：claimToken 经 outbox 凭证回传（结果 schema 不含 token）", async () => {
  const ledger = new InFlightLedger();
  let resolveDelivery:
    | ((v: { result: RunnerTaskResult; credential?: RunnerResultCredential }) => void)
    | null = null;
  const delivered = new Promise<{ result: RunnerTaskResult; credential?: RunnerResultCredential }>(
    (resolve) => {
      resolveDelivery = resolve;
    },
  );
  const outbox: RunnerOutbox = {
    deliver: (result, credential) => {
      resolveDelivery?.({ result, ...(credential !== undefined ? { credential } : {}) });
    },
  };
  const fetchFn: A2AFetch = async () => rpcResult(taskResult("a2a-1", "completed", "ok"));
  const exec = makeExecutor({
    host: makeHost({ ensured: [], stopped: [] }),
    ledger,
    outbox,
    fetch: fetchFn,
  });

  await exec.handle({
    type: "dispatch",
    taskId: "t1",
    projectId: "alpha",
    contextId: "ctx",
    payload: "x",
    claimToken: "ct-1",
  });

  const got = await delivered;
  assert.equal(got.credential?.claimToken, "ct-1");
  assert.equal(Object.prototype.hasOwnProperty.call(got.result, "claimToken"), false);
});

test("dispatch：同 taskId 重复登记按幂等忽略（不重复 ensure）", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const ledger = new InFlightLedger();
  const cap = captureOutbox();
  // 让首个 ensure 悬挂（不引入定时器），保证重复登记发生在在飞期间
  const gate = new Promise<void>(() => {});
  const host: RunnerExecHost = {
    ensure: async (projectId) => {
      calls.ensured.push(projectId);
      await gate;
      return { endpoint: "http://127.0.0.1:4321" };
    },
    stop: async () => ({ stopped: true }),
    getProject: () => PROJECT,
  };
  const fetchFn: A2AFetch = async () => rpcResult(taskResult("a2a-1", "completed", "ok"));
  const exec = makeExecutor({ host, ledger, outbox: cap.outbox, fetch: fetchFn });

  await exec.handle({
    type: "dispatch",
    taskId: "dup",
    projectId: "alpha",
    contextId: "ctx",
    payload: "x",
  });
  await exec.handle({
    type: "dispatch",
    taskId: "dup",
    projectId: "alpha",
    contextId: "ctx",
    payload: "x",
  });

  assert.equal(ledger.size, 1);
  assert.deepEqual(calls.ensured, ["alpha"]); // 第二次被忽略，未再 ensure
});

test("dispatch：失败（ensure 抛错）→ 结果 state=failed 且台账清空", async () => {
  const ledger = new InFlightLedger();
  const cap = captureOutbox();
  const host: RunnerExecHost = {
    ensure: async () => {
      throw new Error("workspace 不存在");
    },
    stop: async () => ({ stopped: true }),
    getProject: () => PROJECT,
  };
  const exec = makeExecutor({ host, ledger, outbox: cap.outbox });

  await exec.handle({
    type: "dispatch",
    taskId: "t-fail",
    projectId: "alpha",
    contextId: "ctx",
    payload: "x",
  });

  const result = await cap.wait();
  assert.equal(result.state, "failed");
  assert.ok(result.text.includes("workspace 不存在"));
  assert.equal(ledger.size, 0);
});

test("stop：in-flight>0 拒收回执 error:in-flight（不触 stop）；台账清空后 stop → ack", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const ledger = new InFlightLedger();
  const exec = makeExecutor({ host: makeHost(calls), ledger, outbox: captureOutbox().outbox });

  ledger.add({ taskId: "t1", projectId: "alpha", startedAt: STARTED_AT });
  const busy = await exec.handle({ type: "stop", projectId: "alpha", commandId: "c1" });
  assert.deepEqual(busy, { commandId: "c1", error: "in-flight" });
  assert.deepEqual(calls.stopped, []); // 拒收 ⇒ 未停止

  ledger.remove("t1");
  const idle = await exec.handle({ type: "stop", projectId: "alpha", commandId: "c2" });
  assert.deepEqual(idle, { commandId: "c2" });
  assert.deepEqual(calls.stopped, ["alpha"]);
});

test("stop：manager.stop 抛错 → 回执带错误文本（不崩）", async () => {
  const ledger = new InFlightLedger();
  const host: RunnerExecHost = {
    ensure: async () => ({ endpoint: "http://127.0.0.1:4321" }),
    stop: async () => {
      throw new Error("未知项目：alpha");
    },
    getProject: () => PROJECT,
  };
  const exec = makeExecutor({ host, ledger, outbox: captureOutbox().outbox });

  const ack = await exec.handle({ type: "stop", projectId: "alpha", commandId: "c1" });
  assert.equal(ack?.commandId, "c1");
  assert.equal(ack?.error, "未知项目：alpha");
});

test("cancel-task：台账无此 taskId → error:unknown-task 且零 A2A 调用", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const ledger = new InFlightLedger();
  let a2aCalls = 0;
  const fetchFn: A2AFetch = async () => {
    a2aCalls += 1;
    return rpcResult({});
  };
  const exec = makeExecutor({
    host: makeHost(calls),
    ledger,
    outbox: captureOutbox().outbox,
    fetch: fetchFn,
  });

  const ack = await exec.handle({ type: "cancel-task", taskId: "ghost", commandId: "c1" });
  assert.deepEqual(ack, { commandId: "c1", error: "unknown-task" });
  assert.equal(a2aCalls, 0);
});

test("cancel-task：台账命中 → 本地 A2A tasks/cancel（携带 a2a 任务 id），成功 ack 无 error", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const ledger = new InFlightLedger();
  ledger.add({
    taskId: "t1",
    projectId: "alpha",
    startedAt: STARTED_AT,
    a2aTaskId: "a2a-9",
  });
  const seen: Array<{ url: string; method: string; params: unknown }> = [];
  const fetchFn: A2AFetch = async (url, init) => {
    const req = JSON.parse(String(init.body)) as { method: string; params: unknown };
    seen.push({ url, method: req.method, params: req.params });
    return rpcResult(taskResult("a2a-9", "canceled", ""));
  };
  const exec = makeExecutor({
    host: makeHost(calls),
    ledger,
    outbox: captureOutbox().outbox,
    fetch: fetchFn,
  });

  const ack = await exec.handle({ type: "cancel-task", taskId: "t1", commandId: "c1" });
  assert.deepEqual(ack, { commandId: "c1" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "http://127.0.0.1:4321/a2a/jsonrpc");
  assert.equal(seen[0]?.method, "tasks/cancel");
  assert.deepEqual(seen[0]?.params, { id: "a2a-9" });
});

test("cancel-task：wrapper 不响应 → ack error 且台账不动（任务照常走终态）", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const ledger = new InFlightLedger();
  ledger.add({
    taskId: "t1",
    projectId: "alpha",
    startedAt: STARTED_AT,
    a2aTaskId: "a2a-9",
  });
  const fetchFn: A2AFetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:4321");
  };
  const exec = makeExecutor({
    host: makeHost(calls),
    ledger,
    outbox: captureOutbox().outbox,
    fetch: fetchFn,
  });

  const ack = await exec.handle({ type: "cancel-task", taskId: "t1", commandId: "c1" });
  assert.equal(ack?.commandId, "c1");
  assert.ok(ack?.error?.includes("ECONNREFUSED") === true);
  assert.equal(ledger.has("t1"), true); // 台账保留 ⇒ 任务照常终态
});

test("cancel-task：已登记但未取得 a2a 句柄 → error:not-started（零 A2A 调用）", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const ledger = new InFlightLedger();
  ledger.add({ taskId: "t1", projectId: "alpha", startedAt: STARTED_AT, a2aTaskId: null });
  let a2aCalls = 0;
  const fetchFn: A2AFetch = async () => {
    a2aCalls += 1;
    return rpcResult({});
  };
  const exec = makeExecutor({
    host: makeHost(calls),
    ledger,
    outbox: captureOutbox().outbox,
    fetch: fetchFn,
  });

  const ack = await exec.handle({ type: "cancel-task", taskId: "t1", commandId: "c1" });
  assert.deepEqual(ack, { commandId: "c1", error: "not-started" });
  assert.equal(a2aCalls, 0);
});

test("命令解析：dispatch/stop/cancel-task 三类 + 判别字段别名 + 非法即 null", () => {
  assert.deepEqual(
    parseRunnerCommand({
      type: "dispatch",
      taskId: "t1",
      projectId: "alpha",
      contextId: "ctx",
      payload: "hi",
    }),
    { type: "dispatch", taskId: "t1", projectId: "alpha", contextId: "ctx", payload: "hi" },
  );
  // 桥侧现行字段：message（消息体别名）+ claimToken（结果回传凭证）——皆原样带入
  const bridged = parseRunnerCommand({
    command: "dispatch",
    taskId: "t9",
    projectId: "alpha",
    contextId: "ctx-9",
    message: "hello",
    claimToken: "ct-9",
  }) as Extract<RunnerCommand, { type: "dispatch" }>;
  assert.equal(bridged.payload, "hello");
  assert.equal(bridged.claimToken, "ct-9");
  assert.deepEqual(parseRunnerCommand({ command: "stop", projectId: "alpha", commandId: "c1" }), {
    type: "stop",
    projectId: "alpha",
    commandId: "c1",
  });
  assert.deepEqual(
    parseRunnerCommand({ result: { kind: "cancel-task", taskId: "t1", commandId: "c1" } }),
    { type: "cancel-task", taskId: "t1", commandId: "c1" },
  );
  // 对象 payload → 归一为原样（执行期再取文本）
  const dispatch = parseRunnerCommand({
    type: "dispatch",
    taskId: "t2",
    projectId: "alpha",
    contextId: "",
    payload: { text: "obj" },
  }) as Extract<RunnerCommand, { type: "dispatch" }>;
  assert.deepEqual(dispatch.payload, { text: "obj" });

  assert.equal(parseRunnerCommand({ result: { command: "dispatch" } }), null); // 缺字段
  assert.equal(parseRunnerCommand({ command: "unknown" }), null);
  assert.equal(parseRunnerCommand(null), null);
  assert.equal(parseRunnerCommand("dispatch"), null);
});

test("任务态映射：completed/input-required 如实，其余终态与超时归 failed", () => {
  assert.equal(mapTaskState("completed", false), "completed");
  assert.equal(mapTaskState("input-required", false), "input-required");
  assert.equal(mapTaskState("failed", false), "failed");
  assert.equal(mapTaskState("canceled", false), "failed");
  assert.equal(mapTaskState("rejected", false), "failed");
  assert.equal(mapTaskState("completed", true), "failed"); // 超时优先判失败
});

test("Runner 循环接驳：stop 命令经执行器回执，并随下一轮连接体 acks 回传", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const bodies: Array<Record<string, unknown>> = [];
  const responses: Response[] = [
    jsonResponse(200, {
      result: { type: "stop", projectId: "alpha", commandId: "cmd-1" },
      data: null,
      error: null,
    }),
    new Response(null, { status: 204 }),
  ];
  let index = 0;
  const runner = new Runner(MACHINE, BRIDGE, SELF_CHECK_OK, {
    manager: makeHost(calls),
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const response = responses[index] ?? new Response(null, { status: 204 });
      index += 1;
      return response;
    },
    logger: SILENT,
  });

  assert.equal(await runner.connect(), "command");
  assert.deepEqual(calls.stopped, ["alpha"]); // 命令被执行
  assert.equal(runner.state.commandsReceived, 1);

  assert.equal(await runner.connect(), "heartbeat");
  // 回执只随「下一轮」连接体回传（首轮无 acks 字段）
  assert.deepEqual(bodies[0], { machineId: "m-test" });
  assert.deepEqual(bodies[1], { machineId: "m-test", acks: [{ commandId: "cmd-1" }] });
});
