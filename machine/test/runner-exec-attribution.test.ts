/**
 * `machine/launcher/runner-exec.ts` 归因面单元测试（v0.8.10 · 节点 M-N4，改造文档 §2.4）。
 *
 * 覆盖节点门禁：
 * - **① 有停因时停因侧键落账 / 无停因时缺键**（不补 0、不补 false）；
 * - **③ `cancel-task` 成功路径有日志行**（断言行型：此前成功取消完全静默，本机无法自证）；
 * - 停事件账本身的时间窗语义（`[派发起算, 结算]` 闭区间；窗外的停不追认）。
 *
 * 与 `runner-exec.test.ts` 分开成文件：本文件只测**归因五键**这条新增面，
 * 不复用主测试文件的假宿主（要注入停事件账）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { A2AFetch } from "../launcher/a2a-client.js";
import { InFlightLedger, type RunnerLogger } from "../launcher/runner.js";
import {
  DIAGNOSTICS_ARTIFACT_NAME,
  RunnerCommandExecutor,
  type RunnerExecHost,
  type RunnerOutbox,
  type RunnerTaskResult,
} from "../launcher/runner-exec.js";
import { StopEventLedger } from "../launcher/stop-ledger.js";
import type { ProjectConfig } from "../types.js";

const PROJECT: ProjectConfig = {
  projectId: "alpha",
  workspace: "C:/ws/alpha",
  agentKind: "opencode",
  a2aPort: 4321,
};

const STARTED_AT = "2026-09-18T00:00:00.000Z";
const STARTED_MS = Date.parse(STARTED_AT);

const SILENT: RunnerLogger = {
  info: (message) => void message,
  warn: (message) => void message,
  error: (message) => void message,
};

function rpcResult(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "rpc-1", result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 假宿主：`ensure` 可控抛错（抛错 ⇒ 该单以 `failed` 收场，归因键应落在其 diagnostics 上） */
function makeHost(options: { ensureThrows?: boolean; stopEvents?: StopEventLedger } = {}): RunnerExecHost {
  return {
    ensure: async (projectId) => {
      if (options.ensureThrows === true) throw new Error(`起不来：${projectId}`);
      return { endpoint: "http://127.0.0.1:4321" };
    },
    stop: async () => ({ stopped: true }),
    getProject: (projectId) => {
      if (projectId !== PROJECT.projectId) throw new Error(`未知项目：${projectId}`);
      return PROJECT;
    },
    ...(options.stopEvents !== undefined
      ? { stopEventLedger: (): StopEventLedger => options.stopEvents as StopEventLedger }
      : {}),
  };
}

function captureOutbox(): { outbox: RunnerOutbox; wait: () => Promise<RunnerTaskResult> } {
  let resolveFn: ((result: RunnerTaskResult) => void) | null = null;
  const first = new Promise<RunnerTaskResult>((resolve) => {
    resolveFn = resolve;
  });
  return {
    outbox: {
      deliver: (result) => {
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
  outbox: RunnerOutbox;
  ledger?: InFlightLedger;
  fetch?: A2AFetch;
  logger?: RunnerLogger;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}): RunnerCommandExecutor {
  return new RunnerCommandExecutor({
    host: options.host,
    ledger: options.ledger ?? new InFlightLedger(),
    outbox: options.outbox,
    machineId: "m-test",
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    // 假时钟下静默窗靠**次数闸**兜底 ⇒ 睡眠必须是 no-op（否则 10s 窗真等）
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    logger: options.logger ?? SILENT,
    now: () => new Date(STARTED_AT),
  });
}

/** 交一张 dispatch 单并等结果（`ensureThrows` ⇒ 该单以 failed 收场） */
async function settle(options: {
  host: RunnerExecHost;
  fetch?: A2AFetch;
}): Promise<RunnerTaskResult> {
  const cap = captureOutbox();
  const exec = makeExecutor({ host: options.host, outbox: cap.outbox, ...(options.fetch !== undefined ? { fetch: options.fetch } : {}) });
  await exec.handle({ type: "dispatch", taskId: "t1", projectId: "alpha", contextId: "ctx-1", payload: "hi" });
  return await cap.wait();
}

test("① 有停因 ⇒ diagnostics 落 stopCause / stopCauseTaskId（不动 failureKind 六类闭集）", async () => {
  const events = new StopEventLedger({ now: () => STARTED_MS });
  events.recordStop({ projectId: "alpha", cause: "idle-reap", causeTaskId: "t-肇事", inflightAtStop: 1 });

  const result = await settle({ host: makeHost({ ensureThrows: true, stopEvents: events }) });

  assert.equal(result.state, "failed");
  assert.equal(result.failureKind, "runner"); // 六类闭集口径不变（ensure 抛错 = runner）
  const d = result.diagnostics;
  assert.ok(d !== undefined && d !== null);
  assert.equal(d.stopCause, "idle-reap");
  assert.equal(d.stopCauseTaskId, "t-肇事");
  // 取消侧三键：本轮没有任何取消事实 ⇒ 一并缺键
  assert.ok(!("ghostRoundCancelled" in d));
  assert.ok(!("cancelQuiesceMs" in d));
  assert.ok(!("cancelUnsupported" in d));
});

test("① 反例：无停因 ⇒ 五键全缺（不补 0 / 不补 false），completed 结果不编造 diagnostics", async () => {
  const events = new StopEventLedger({ now: () => STARTED_MS });
  const result = await settle({
    host: makeHost({ stopEvents: events }),
    fetch: async () =>
      rpcResult({
        id: "a2a-1",
        status: { state: "completed", message: { role: "agent", parts: [{ kind: "text", text: "done" }] } },
        artifacts: [],
      }),
  });

  assert.equal(result.state, "completed");
  const wire = JSON.stringify(result);
  for (const key of ["stopCause", "stopCauseTaskId", "ghostRoundCancelled", "cancelQuiesceMs", "cancelUnsupported"]) {
    assert.ok(!wire.includes(`"${key}"`), `缺键要求：${key} 不得出现在回传载荷（更不得补 0/false）`);
  }
});

test("① 时间窗语义：停落在派发起算**之前** ⇒ 不追认（防「一次停、终身背锅」）", async () => {
  // 时钟比派发结算时刻早 1ms ⇒ 事件落在闭区间 [起算, 结算] 之外
  const late = new StopEventLedger({ now: () => STARTED_MS - 1 });
  late.recordStop({ projectId: "alpha", cause: "idle-reap", inflightAtStop: 0 });
  const result = await settle({ host: makeHost({ ensureThrows: true, stopEvents: late }) });
  const d = result.diagnostics;
  assert.ok(d !== undefined && d !== null);
  assert.ok(!("stopCause" in d), "派发开始前的停不落 stopCause 键（闭区间 [起算, 结算] 之外）");
});

test("③ cancel-task 成功路径有一行 info 日志（含 taskId / projectId / 目标任务 id）", async () => {  const info: string[] = [];
  const warn: string[] = [];
  const logger: RunnerLogger = {
    info: (m) => void info.push(m),
    warn: (m) => void warn.push(m),
    error: (m) => void m,
  };
  const ledger = new InFlightLedger();
  ledger.add({ taskId: "t1", projectId: "alpha", startedAt: STARTED_AT, a2aTaskId: "a2a-9" });
  const exec = makeExecutor({
    host: makeHost(),
    ledger,
    outbox: captureOutbox().outbox,
    fetch: async () => rpcResult({ id: "a2a-9", status: { state: "canceled" }, artifacts: [] }),
    logger,
  });

  const ack = await exec.handle({ type: "cancel-task", taskId: "t1", commandId: "c1" });
  assert.deepEqual(ack, { commandId: "c1" });
  // 行型断言：一行、以固定前缀起头、三个标识齐备（此前成功取消零日志 ⇒ 只能靠后端账本反推）
  assert.equal(info.length, 1);
  assert.match(
    info[0] ?? "",
    /^\[runner\] cancel-task 已送达：taskId=t1 project=alpha a2aTaskId=a2a-9$/,
  );
  assert.equal(warn.length, 0);
});

/** 桥侧自报「prompt 满窗」的终态任务（⇒ launcher 归 timeout / timeoutScope=acp-prompt） */
function bridgeTimeoutTask(): unknown {
  return {
    id: "a2a-1",
    status: {
      state: "failed",
      message: { role: "agent", parts: [{ kind: "text", text: "会话 600000ms 超时" }] },
    },
    artifacts: [
      {
        artifactId: "diag",
        name: DIAGNOSTICS_ARTIFACT_NAME,
        parts: [
          { kind: "text", text: JSON.stringify({ acpErrorKind: "timeout", chunkCount: 0 }) },
        ],
      },
    ],
  };
}

/** 收尾取消跑在 `deliver()` **之后**（硬约束③）⇒ 观察面在另一个微任务链上落地，此处仅有界等实到 */
async function until<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 50; i += 1) {
    const value = read();
    if (value !== undefined) return value; // `0` 是合法测量值 ⇒ 只有 undefined 算「还没有值」
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待观察面落地超时（50 × 5ms）");
}

test("② 取消侧观察面：收尾取消达静默 ⇒ 取消往返耗时进停事件账（供播报），账单不含该键（取消排在交卷后）", async () => {
  const events = new StopEventLedger({ now: () => STARTED_MS });
  const cap = captureOutbox();
  const exec = makeExecutor({
    host: makeHost({ stopEvents: events }),
    outbox: cap.outbox,
    fetch: async (_url, init) => {
      const req = JSON.parse(String(init.body)) as { method: string };
      if (req.method === "message/send") return rpcResult(bridgeTimeoutTask());
      // 收尾取消：后端承认取消并立刻落终态 ⇒ 静默达成（假时钟不前进 ⇒ 往返 0ms）
      return rpcResult({ id: "a2a-1", status: { state: "canceled" }, artifacts: [] });
    },
  });
  await exec.handle({ type: "dispatch", taskId: "t1", projectId: "alpha", contextId: "ctx-1", payload: "hi" });
  const billed = await cap.wait();

  assert.equal(billed.state, "failed");
  assert.equal(billed.failureKind, "timeout"); // 六类闭集不变（归因只增 diagnostics 键）
  // ★ 硬约束 ③ 的可观测后果：取消排在 `deliver()` 之后 ⇒ 这一单的 diagnostics **不含**取消侧键
  assert.ok(!("cancelQuiesceMs" in (billed.diagnostics ?? {})));
  assert.ok(!("ghostRoundCancelled" in (billed.diagnostics ?? {})));
  // 观察面（下一次 `start()` 的 config-snapshot 播报 + `/health degraded` 的读点）收到取消往返 = 0ms
  assert.equal(await until(() => events.lastCancelQuiesceMs("alpha")), 0);
  assert.deepEqual(events.cancelUnsupportedProjectIds(), []);
});

test("② 取消侧观察面：取消发出但静默窗内未落终态 ⇒ 项目进 cancelUnsupported 集", async () => {
  const events = new StopEventLedger({ now: () => STARTED_MS });
  const cap = captureOutbox();
  const exec = makeExecutor({
    host: makeHost({ stopEvents: events }),
    outbox: cap.outbox,
    pollIntervalMs: 200,
    sleep: async () => undefined, // 假时钟下静默窗靠次数闸兜底 ⇒ 不真等 10s
    fetch: async (_url, init) => {
      const req = JSON.parse(String(init.body)) as { method: string };
      if (req.method === "message/send") return rpcResult(bridgeTimeoutTask());
      // 后端收下取消却不落终态（不认 `session/cancel`）⇒ 轮询到窗满仍未静默
      return rpcResult({ id: "a2a-1", status: { state: "working" }, artifacts: [] });
    },
  });
  await exec.handle({ type: "dispatch", taskId: "t1", projectId: "alpha", contextId: "ctx-1", payload: "hi" });
  await cap.wait();

  assert.equal(await until(() => events.cancelUnsupportedProjectIds()[0]), "alpha");
  assert.equal(events.lastCancelQuiesceMs("alpha"), undefined); // 无取消往返值 ⇒ 播报省略该键
});
