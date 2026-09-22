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
 * - Runner 循环接驳：stop 回执经**下一轮连接体** `acks` 回传；
 * - **v0.8.7 · M3**：`dispatchBudgetMs` / `classifyFailure` / `splitDiagnosticsArtifact` 纯函数 +
 *   真链路（假时钟）预算派生（防「只配桥侧静默无效」）+ diagnostics artifact 摘除（结果文本不被污染）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { A2AFetch } from "../launcher/a2a-client.js";
import { InFlightLedger, Runner, type RunnerLogger } from "../launcher/runner.js";
import {
  DEFAULT_DISPATCH_TIMEOUT_MS,
  DIAGNOSTICS_ARTIFACT_NAME,
  DISPATCH_MARGIN_MS,
  MAX_TRANSPORT_ATTEMPTS,
  RESEND_MIN_REMAINING_MS,
  RunnerCommandExecutor,
  classifyFailure,
  dispatchBudgetMs,
  isConnectionLevelFailure,
  mapTaskState,
  parseRunnerCommand,
  splitDiagnosticsArtifact,
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

const SELF_CHECK_OK: SelfCheckResult = { ok: true, failures: [], unavailable: [] };

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
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  dispatchTimeoutMs?: number;
}): RunnerCommandExecutor {
  return new RunnerCommandExecutor({
    host: options.host,
    ledger: options.ledger,
    outbox: options.outbox,
    machineId: "m-test",
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.dispatchTimeoutMs !== undefined
      ? { dispatchTimeoutMs: options.dispatchTimeoutMs }
      : {}),
    logger: SILENT,
    now: options.now ?? (() => new Date(STARTED_AT)),
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
    ((v: { result: RunnerTaskResult; credential?: RunnerResultCredential }) => void) | null = null;
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
  // v0.8.7 · M3：ensure 抛错 = 载体侧（infra），落点阶段留痕
  assert.equal(result.failureKind, "infra");
  assert.equal(result.diagnostics?.stage, "ensure");
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

// ---------- REQ-v0.8.7-2026-09-22-01 · M3：按项目 deadline + 失败归因 + diagnostics 摘除 ----------

/** 桥上带诊断用的 artifact（文本 = JSON；名字与桥侧约定同名） */
function diagnosticsArtifact(payload: Record<string, unknown>): unknown {
  return {
    artifactId: "diag-1",
    name: DIAGNOSTICS_ARTIFACT_NAME,
    parts: [{ kind: "text", text: JSON.stringify(payload) }],
  };
}

/** 可注入假时钟：时间只在 `sleep` 时前进（真链路预算断言不依赖真实等待） */
function fakeClock(): {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  elapsedMs: () => number;
} {
  let virtual = 0;
  return {
    now: () => new Date(Date.parse(STARTED_AT) + virtual),
    sleep: async (ms: number) => {
      virtual += ms;
    },
    elapsedMs: () => virtual,
  };
}

/** 假桥：`message/send` 返 working 句柄，`tasks/get` 在假时钟到 `terminalAtMs` 前一直 working */
function bridgedFetch(clock: { elapsedMs: () => number }, terminalAtMs: number, task: unknown) {
  const seen: string[] = [];
  const fetchFn: A2AFetch = async (_url, init) => {
    const req = JSON.parse(String(init.body)) as { method: string };
    seen.push(req.method);
    if (req.method === "message/send") return rpcResult(taskResult("a2a-1", "working", ""));
    if (req.method === "tasks/get") {
      return rpcResult(
        clock.elapsedMs() >= terminalAtMs ? task : taskResult("a2a-1", "working", ""),
      );
    }
    throw new Error(`未预期方法：${req.method}`);
  };
  return { fetchFn, seen };
}

function sessionProject(sessionTimeoutMs: number | undefined): ProjectConfig {
  return {
    ...PROJECT,
    agentConfig: sessionTimeoutMs === undefined ? {} : { sessionTimeoutMs },
  };
}

test("M3 dispatchBudgetMs：恒 dispatch = session + margin（margin 300s）；未配 ⇒ 660s 缺省", () => {
  assert.equal(DISPATCH_MARGIN_MS, 300_000);
  assert.equal(dispatchBudgetMs(900_000), 900_000 + 300_000);
  assert.equal(dispatchBudgetMs(60_000), 360_000);
  assert.equal(dispatchBudgetMs(undefined), DEFAULT_DISPATCH_TIMEOUT_MS);
});

test("M3 classifyFailure：ensure / 自有超时 / 桥 timeout ⇒ infra；跑出的失败 ⇒ task；非失败态 null", () => {
  assert.equal(classifyFailure({ timedOut: false, state: "failed", threwInEnsure: true }), "infra");
  assert.equal(
    classifyFailure({
      timedOut: false,
      state: "failed",
      threwInEnsure: false,
      acpErrorKind: "timeout",
    }),
    "infra",
  );
  assert.equal(
    classifyFailure({
      timedOut: false,
      state: "failed",
      threwInEnsure: false,
      threwInTransport: true,
    }),
    "infra",
  );
  assert.equal(classifyFailure({ timedOut: false, state: "failed", threwInEnsure: false }), "task");
  // v0.8.7 · M5：桥报的载体早夭 kind（spawn / closed）归 infra（后端进程起不来 / 中途退出 =
  // 载体侧，重派有意义；这也是「终态重跑」主形态的触发前置）。**不预映射更细词表**（rpc 等仍 task）。
  assert.equal(
    classifyFailure({
      timedOut: false,
      state: "failed",
      threwInEnsure: false,
      acpErrorKind: "spawn",
    }),
    "infra",
  );
  assert.equal(
    classifyFailure({
      timedOut: false,
      state: "failed",
      threwInEnsure: false,
      acpErrorKind: "closed",
    }),
    "infra",
  );
  assert.equal(
    classifyFailure({
      timedOut: false,
      state: "failed",
      threwInEnsure: false,
      acpErrorKind: "rpc",
    }),
    "task",
  );
  // timedOut 最优先（launcher 看不见桥的 kind）
  assert.equal(
    classifyFailure({ timedOut: true, state: "failed", threwInEnsure: false, acpErrorKind: "rpc" }),
    "infra",
  );
  assert.equal(
    classifyFailure({ timedOut: false, state: "completed", threwInEnsure: false }),
    null,
  );
  assert.equal(
    classifyFailure({ timedOut: false, state: "input-required", threwInEnsure: false }),
    null,
  );
});

test("M3 splitDiagnosticsArtifact：摘除且保序回传剩余；非法 JSON 也摘（不污染文本）；无则原样", () => {
  const response = { artifactId: "a1", name: "response", parts: [{ kind: "text", text: "body" }] };
  const split = splitDiagnosticsArtifact([
    response,
    diagnosticsArtifact({ acpErrorKind: "timeout", chunkCount: 3 }),
  ]);
  assert.deepEqual(split.artifacts, [response]);
  assert.deepEqual(split.diagnostics, { acpErrorKind: "timeout", chunkCount: 3 });

  const none = splitDiagnosticsArtifact([response]);
  assert.equal(none.diagnostics, null);
  assert.deepEqual(none.artifacts, [response]);

  const broken = splitDiagnosticsArtifact([
    {
      artifactId: "d",
      name: DIAGNOSTICS_ARTIFACT_NAME,
      parts: [{ kind: "text", text: "not-json" }],
    },
    response,
  ]);
  assert.equal(broken.diagnostics, null);
  assert.deepEqual(broken.artifacts, [response]); // 坏 JSON 也摘除，且其余保序
});

test("M3 buildResult：diagnostics artifact 被摘除 ⇒ 结果文本不含该名 / 诊断内容，剩余 artifacts 原样", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const cap = captureOutbox();
  const fetchFn: A2AFetch = async (_url, init) => {
    const req = JSON.parse(String(init.body)) as { method: string };
    assert.equal(req.method, "message/send");
    return rpcResult(
      taskResult("a2a-1", "completed", "body", [
        { artifactId: "a1", name: "response", parts: [{ kind: "text", text: "body" }] },
        diagnosticsArtifact({ acpErrorKind: "rpc", chunkCount: 7, DIAG_BLOB_MARKER: 1 }),
      ]),
    );
  };
  const exec = makeExecutor({
    host: makeHost(calls),
    ledger: new InFlightLedger(),
    outbox: cap.outbox,
    fetch: fetchFn,
  });
  await exec.handle({
    type: "dispatch",
    taskId: "t-diag",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
  });

  const result = await cap.wait();
  assert.equal(result.state, "completed");
  assert.equal(result.failureKind, undefined); // 成功态不产出 failureKind
  assert.equal(result.artifacts.length, 1);
  assert.equal((result.artifacts[0] as { name?: string }).name, "response");
  assert.ok(result.text.includes("body"));
  assert.ok(
    !result.text.includes(DIAGNOSTICS_ARTIFACT_NAME),
    "结果文本不得含 diagnostics artifact 名",
  );
  assert.ok(!result.text.includes("DIAG_BLOB_MARKER"), "诊断 JSON 不得混进结果文本");
  assert.deepEqual(result.diagnostics, {
    elapsedMs: 0,
    stage: "send",
    acpErrorKind: "rpc",
    chunkCount: 7,
  });
});

test("M3 无 diagnostics artifact 的成功结果 ⇒ 不编造 diagnostics 键", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const cap = captureOutbox();
  const exec = makeExecutor({
    host: makeHost(calls),
    ledger: new InFlightLedger(),
    outbox: cap.outbox,
    fetch: async () => rpcResult(taskResult("a2a-1", "completed", "plain")),
  });
  await exec.handle({
    type: "dispatch",
    taskId: "t-plain",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
  });

  const result = await cap.wait();
  assert.equal(result.state, "completed");
  assert.equal("diagnostics" in result, false);
});

test("M3 真链路（假时钟）：桥窗 900s ⇒ launcher 预算同值派生 1200s，等到 700s 后的终态（防「只配桥侧静默无效」）", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const clock = fakeClock();
  const cap = captureOutbox();
  const { fetchFn } = bridgedFetch(clock, 700_000, taskResult("a2a-1", "completed", "late ok"));
  const exec = makeExecutor({
    host: makeHost(calls, sessionProject(900_000)),
    ledger: new InFlightLedger(),
    outbox: cap.outbox,
    fetch: fetchFn,
    now: clock.now,
    sleep: clock.sleep,
    pollIntervalMs: 1_000,
  });
  await exec.handle({
    type: "dispatch",
    taskId: "t-long",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
  });

  const result = await cap.wait();
  assert.equal(clock.elapsedMs(), 700_000); // 跑过旧 660s 定值仍未掐 ⇒ 预算按项目派生
  assert.equal(result.state, "completed"); // 旧定值 660s 下这里会是「Runner 等待超时」
  assert.ok(result.text.includes("late ok"));
  assert.equal(result.failureKind, undefined);
  assert.equal(result.diagnostics, undefined); // 桥上没带 diagnostics ⇒ 不编造
});

test("M3 真链路（假时钟）：桥窗 60s ⇒ 预算 360s；超预算归 infra 且落点 stage=wait", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const clock = fakeClock();
  const cap = captureOutbox();
  const { fetchFn } = bridgedFetch(clock, 400_000, taskResult("a2a-1", "completed", "never"));
  const exec = makeExecutor({
    host: makeHost(calls, sessionProject(60_000)),
    ledger: new InFlightLedger(),
    outbox: cap.outbox,
    fetch: fetchFn,
    now: clock.now,
    sleep: clock.sleep,
    pollIntervalMs: 1_000,
  });
  await exec.handle({
    type: "dispatch",
    taskId: "t-short",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
  });

  const result = await cap.wait();
  assert.equal(clock.elapsedMs(), 360_000); // 60s + 300s，非 660s 定值
  assert.equal(result.state, "failed");
  assert.equal(result.failureKind, "infra");
  assert.equal(result.text, "任务超时（Runner 等待超时）");
  assert.equal(result.diagnostics?.stage, "wait");
});

test("M3 真链路（假时钟）：桥在 60s 报 failed ⇒ launcher 未判超时、文案为桥文本、桥 timeout kind 归 infra", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const clock = fakeClock();
  const cap = captureOutbox();
  const { fetchFn } = bridgedFetch(
    clock,
    60_000,
    taskResult("a2a-1", "failed", "会话 60000ms 超时", [
      diagnosticsArtifact({ acpErrorKind: "timeout", chunkCount: 0 }),
    ]),
  );
  const exec = makeExecutor({
    host: makeHost(calls, sessionProject(60_000)),
    ledger: new InFlightLedger(),
    outbox: cap.outbox,
    fetch: fetchFn,
    now: clock.now,
    sleep: clock.sleep,
    pollIntervalMs: 1_000,
  });
  await exec.handle({
    type: "dispatch",
    taskId: "t-bridge-timeout",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
  });

  const result = await cap.wait();
  assert.equal(result.state, "failed");
  assert.equal(result.text, "会话 60000ms 超时"); // 不是「任务超时（Runner 等待超时）」
  assert.notEqual(result.text, "任务超时（Runner 等待超时）");
  assert.equal(result.failureKind, "infra"); // 桥报 timeout ⇒ 载体侧
  assert.equal(result.diagnostics?.acpErrorKind, "timeout");
  assert.equal(result.diagnostics?.chunkCount, 0);
  assert.equal(result.diagnostics?.stage, "poll");
  assert.ok(!result.text.includes(DIAGNOSTICS_ARTIFACT_NAME));
});

test("M3 send 相位传输抛错 ⇒ infra + stage=send", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const cap = captureOutbox();
  const exec = makeExecutor({
    host: makeHost(calls),
    ledger: new InFlightLedger(),
    outbox: cap.outbox,
    fetch: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4321");
    },
  });
  await exec.handle({
    type: "dispatch",
    taskId: "t-refused",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
  });

  const result = await cap.wait();
  assert.equal(result.state, "failed");
  assert.equal(result.failureKind, "infra");
  assert.equal(result.diagnostics?.stage, "send");
  assert.ok(result.text.includes("ECONNREFUSED"));
  assert.deepEqual(result.artifacts, []);
});

// ---------- REQ-v0.8.7-2026-09-22-01 · M5：传输层有界重发（≤1 次）----------

/**
 * 按调用序号返回 `message/send` 结果的假桥：每步可以是结果体（成功响应）或 `Error`
 * （连接级抛错）；步数用尽后重复最后一步。`calls()` 返回已发生的 `message/send` 次数。
 */
function sendScript(steps: Array<unknown | Error>): { fetchFn: A2AFetch; calls: () => number } {
  let index = 0;
  const fetchFn: A2AFetch = async (_url, init) => {
    const req = JSON.parse(String(init.body)) as { method: string };
    assert.equal(req.method, "message/send");
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step instanceof Error) throw step;
    return rpcResult(step);
  };
  return { fetchFn, calls: () => index };
}

test("M5 常量：有界重发 = 至多 1 次、重发前剩余闸 60s；连接级文本可辨、超时类不可辨", () => {
  assert.equal(MAX_TRANSPORT_ATTEMPTS, 1);
  assert.equal(RESEND_MIN_REMAINING_MS, 60_000);
  assert.equal(isConnectionLevelFailure("connect ECONNREFUSED 127.0.0.1:4321"), true);
  assert.equal(isConnectionLevelFailure("read ECONNRESET"), true);
  assert.equal(isConnectionLevelFailure("fetch failed"), true); // 桥进程死 → undici TypeError
  assert.equal(isConnectionLevelFailure("The operation was aborted due to timeout"), false);
  assert.equal(isConnectionLevelFailure("会话 60000ms 超时"), false);
});

test("M5 ① 终态 + closed + 零 chunk ⇒ 先 stop 再重跑一次并成功（早夭自愈主形态）", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const cap = captureOutbox();
  const script = sendScript([
    taskResult("a2a-1", "failed", "后端进程退出", [
      diagnosticsArtifact({ acpErrorKind: "closed", chunkCount: 0 }),
    ]),
    taskResult("a2a-1", "completed", "late ok"),
  ]);
  const exec = makeExecutor({
    host: makeHost(calls),
    ledger: new InFlightLedger(),
    outbox: cap.outbox,
    fetch: script.fetchFn,
  });
  await exec.handle({
    type: "dispatch",
    taskId: "t-rerun",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
  });

  const result = await cap.wait();
  assert.equal(result.state, "completed"); // 重跑后拿到成功终态
  assert.ok(result.text.includes("late ok"));
  assert.equal(script.calls(), 2); // message/send 两次（首发夭折 + 重跑）
  assert.deepEqual(calls.ensured, ["alpha", "alpha"]); // 重跑前重新 ensure
  assert.deepEqual(calls.stopped, ["alpha"]); // ★ 必须先 stop（消除忙会话）
  assert.equal(result.diagnostics?.attempts, 1); // 留痕
});

test("M5 ② 终态失败但 chunkCount > 0 ⇒ 不重跑（已可能有输出，不盲目重投）", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const cap = captureOutbox();
  const script = sendScript([
    taskResult("a2a-1", "failed", "partial", [
      diagnosticsArtifact({ acpErrorKind: "spawn", chunkCount: 5 }),
    ]),
  ]);
  const exec = makeExecutor({
    host: makeHost(calls),
    ledger: new InFlightLedger(),
    outbox: cap.outbox,
    fetch: script.fetchFn,
  });
  await exec.handle({
    type: "dispatch",
    taskId: "t-chunks",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
  });

  const result = await cap.wait();
  assert.equal(result.state, "failed");
  assert.equal(result.failureKind, "infra"); // spawn 归 infra，但 chunkCount≠0 ⇒ 仍不重跑
  assert.equal(script.calls(), 1); // 未重发
  assert.deepEqual(calls.stopped, []);
  assert.equal(result.diagnostics?.attempts, undefined);
});

test("M5 ③ timeout 类（infra）⇒ 绝不重跑（后端那一轮可能仍在跑，边界）", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const cap = captureOutbox();
  const script = sendScript([
    taskResult("a2a-1", "failed", "会话 600000ms 超时", [
      diagnosticsArtifact({ acpErrorKind: "timeout", chunkCount: 0 }),
    ]),
  ]);
  const exec = makeExecutor({
    host: makeHost(calls),
    ledger: new InFlightLedger(),
    outbox: cap.outbox,
    fetch: script.fetchFn,
  });
  await exec.handle({
    type: "dispatch",
    taskId: "t-timeout",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
  });

  const result = await cap.wait();
  assert.equal(result.state, "failed");
  assert.equal(result.failureKind, "infra"); // timeout kind 归 infra，但不属 {spawn,closed}
  assert.equal(script.calls(), 1); // 不重发
  assert.deepEqual(calls.stopped, []);
  assert.equal(result.diagnostics?.attempts, undefined);
});

test("M5 ④ send 相位连接级失败（无终态）⇒ 内部重投一次并成功", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const cap = captureOutbox();
  const script = sendScript([
    new Error("connect ECONNREFUSED 127.0.0.1:4321"),
    taskResult("a2a-1", "completed", "recovered"),
  ]);
  const exec = makeExecutor({
    host: makeHost(calls),
    ledger: new InFlightLedger(),
    outbox: cap.outbox,
    fetch: script.fetchFn,
  });
  await exec.handle({
    type: "dispatch",
    taskId: "t-connect",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
  });

  const result = await cap.wait();
  assert.equal(result.state, "completed");
  assert.ok(result.text.includes("recovered"));
  assert.equal(script.calls(), 2); // 首发连接级失败 + 重投
  assert.deepEqual(calls.ensured, ["alpha", "alpha"]);
  assert.equal(result.diagnostics?.attempts, 1); // 留痕
});

test("M5 ⑤ 剩余预算不足（remaining < 60s）⇒ 即使命中也白烧一轮，不重发", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const cap = captureOutbox();
  const script = sendScript([
    taskResult("a2a-1", "failed", "后端进程错误", [
      diagnosticsArtifact({ acpErrorKind: "spawn", chunkCount: 0 }),
    ]),
  ]);
  const exec = makeExecutor({
    host: makeHost(calls),
    ledger: new InFlightLedger(),
    outbox: cap.outbox,
    fetch: script.fetchFn,
    dispatchTimeoutMs: 30_000, // 固定假钟下 remaining()=30s < 60s ⇒ 重发闸关
  });
  await exec.handle({
    type: "dispatch",
    taskId: "t-noremaining",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
  });

  const result = await cap.wait();
  assert.equal(result.state, "failed");
  assert.equal(script.calls(), 1); // 未重发
  assert.deepEqual(calls.stopped, []);
  assert.equal(result.diagnostics?.attempts, undefined);
});

test("M5 另断：attempts 封顶（每次终态都 spawn/零 chunk 也只重跑一次，不双触发）", async () => {
  const calls: HostCalls = { ensured: [], stopped: [] };
  const cap = captureOutbox();
  const script = sendScript([
    taskResult("a2a-1", "failed", "反复夭折", [
      diagnosticsArtifact({ acpErrorKind: "spawn", chunkCount: 0 }),
    ]),
  ]);
  const exec = makeExecutor({
    host: makeHost(calls),
    ledger: new InFlightLedger(),
    outbox: cap.outbox,
    fetch: script.fetchFn,
  });
  await exec.handle({
    type: "dispatch",
    taskId: "t-cap",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
  });

  const result = await cap.wait();
  assert.equal(result.state, "failed");
  assert.equal(script.calls(), 2); // 首发 + 一次重跑即封顶（非 3）
  assert.equal(calls.stopped.length, 1);
  assert.equal(result.diagnostics?.attempts, 1);
  assert.equal(result.diagnostics?.chunkCount, 0);
});
