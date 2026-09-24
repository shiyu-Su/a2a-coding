/**
 * v0.8.10 · 节点 M-N5 单元测试（REQ-v0.8.10-2026-09-23-01 · 改造文档 §2.3）：
 * **两把并发闸（缺省 1/1）+ `readOnly` 消费 + 排队计数快照**。
 *
 * 覆盖面（节点门禁）：
 * - ① **缺省 1/1 ⇒ 并发形态与 v0.8.9 一致**：不配任何键时同项目两条写派发**串行**放行
 *   （第二条排队），单条派发路径与闸前完全同形；
 * - ② **读档与写档互不占位**（读满时写仍可进、写在飞时读照常放行）；
 * - ③ **排队保 FIFO**：释放出的席位**移交队首**，后到者不得插队（否则 `oldestWaitedMs`
 *   与「前面几个」的口径会漂）；
 * - ④ 落盘 schema 宽容（旧文件缺 `readOnly` / `admittedAt` ⇒ 按写、补结算不抛）**已锚在**
 *   `reconcile-inflight.test.ts`（M-N1 落该键时覆盖），本文件不重复；
 * - 可见面数据：`inFlightByProject` / `queuedByProject{write,read,oldestWaitedMs}`
 *   （装配进 `/health degraded` 归 M-N4，本节点只产数据）。
 *
 * 运行：`npm run build && node --test dist/test/gate-concurrency.test.js`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { A2AFetch } from "../launcher/a2a-client.js";
import { loadMachineConfig } from "../config.js";
import {
  DEFAULT_MAX_CONCURRENT_READS,
  DEFAULT_MAX_CONCURRENT_WRITES,
  effectiveGateLimits,
  resolveMaxConcurrentReads,
  resolveMaxConcurrentWrites,
} from "../launcher/agent-config.js";
import { InFlightLedger, Runner } from "../launcher/runner.js";
import {
  DispatchGate,
  RunnerCommandExecutor,
  laneOfReadOnly,
  parseRunnerCommand,
  type GitTextRunner,
  type RunnerExecHost,
  type RunnerOutbox,
  type RunnerTaskResult,
} from "../launcher/runner-exec.js";
import type { BridgeConfig, ProjectConfig } from "../types.js";

const BRIDGE: BridgeConfig = { url: "http://bridge.test:3200", token: "tok" };

/** 让出事件循环若干轮（排队 / 放行都是微任务链，需要真实推进） */
async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rpcResult(result: unknown): Response {
  return jsonResponse(200, { jsonrpc: "2.0", id: "rpc-1", result });
}

function taskResult(id: string, state: string, text: string): unknown {
  return {
    id,
    status: { state, message: { role: "agent", parts: [{ kind: "text", text }] } },
    artifacts: [],
  };
}

/** 假 git：一律抛 ⇒ 工作树指纹键缺失，不影响闸 */
const throwingGit: GitTextRunner = () => {
  throw new Error("git unavailable (test fake)");
};

function project(agentConfig?: Record<string, unknown>): ProjectConfig {
  return {
    projectId: "alpha",
    workspace: "C:/ws/alpha",
    agentKind: "opencode",
    a2aPort: 4321,
    ...(agentConfig === undefined ? {} : { agentConfig }),
  };
}

const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

interface GateHarness {
  exec: RunnerCommandExecutor;
  ledger: InFlightLedger;
  /** 已过闸、抵达 `message/send` 的 prompt 文本（顺序 = 放行顺序；本文件 taskId === 文本） */
  started: string[];
  /** 让某个 prompt 的那一轮收敛（= 交卷、档位归还） */
  finish: (taskId: string) => Promise<void>;
  /** 等某个 taskId 的结果经 outbox 交卷 */
  delivered: (taskId: string) => Promise<RunnerTaskResult>;
}

/** 执行器假链路：`ensure` 即时成功，`message/send` 挂到 `finish(taskId)` 才回终态 */
function makeHarness(proj: ProjectConfig): GateHarness {
  const ledger = new InFlightLedger();
  const started: string[] = [];
  const holdResolve = new Map<string, () => void>();
  const waitResolve = new Map<string, (result: RunnerTaskResult) => void>();
  const host: RunnerExecHost = {
    ensure: async () => ({ endpoint: "http://127.0.0.1:4321" }),
    stop: async () => ({ stopped: true }),
    getProject: (projectId) => {
      if (projectId !== proj.projectId) throw new Error(`未知项目：${projectId}`);
      return proj;
    },
  };
  const fetchFn: A2AFetch = async (_url, init) => {
    const req = JSON.parse(String(init.body)) as {
      method: string;
      params: { message?: { parts?: { text?: string }[] } };
    };
    if (req.method !== "message/send") throw new Error(`未预期方法：${req.method}`);
    const text = String(req.params.message?.parts?.[0]?.text ?? "");
    started.push(text);
    await new Promise<void>((resolve) => {
      holdResolve.set(text, resolve);
    });
    return rpcResult(taskResult(`a2a-${text}`, "completed", "ok"));
  };
  const outbox: RunnerOutbox = {
    deliver: (result) => {
      waitResolve.get(result.taskId)?.(result);
      waitResolve.delete(result.taskId);
    },
  };
  const exec = new RunnerCommandExecutor({
    host,
    ledger,
    machineId: "m-test",
    outbox,
    fetch: fetchFn,
    runGit: throwingGit,
    logger: SILENT,
  });
  return {
    exec,
    ledger,
    started,
    finish: async (taskId) => {
      const done = holdResolve.get(taskId);
      if (done === undefined) throw new Error(`该任务尚未放行到 send 相位：${taskId}`);
      done();
      holdResolve.delete(taskId);
      await tick();
    },
    delivered: (taskId) =>
      new Promise<RunnerTaskResult>((resolve) => {
        waitResolve.set(taskId, resolve);
      }),
  };
}

async function dispatch(
  exec: RunnerCommandExecutor,
  taskId: string,
  overrides: { readOnly?: true } = {},
): Promise<void> {
  // 约定：payload 文本 === taskId ⇒ `started` 数组与 outbox 结果可直接对得上
  await exec.handle({
    type: "dispatch",
    taskId,
    projectId: "alpha",
    contextId: `ctx-${taskId}`,
    payload: taskId,
    ...overrides,
  });
}

/** 写一份临时机器配置（单 project），跑完清理 */
function withAgentConfig(agentConfig: unknown, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "a2a-machine-gate-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        machineId: "m-test",
        launcher: { port: 3100 },
        projects: [
          { projectId: "p1", workspace: "/ws/p1", agentKind: "opencode", a2aPort: 4100, agentConfig },
        ],
      }),
      "utf8",
    );
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- ① 配置面：两把闸的缺省与加载期校验 ----

test("agent-config：两键缺省 = 1/1（不配任何键 ⇒ 形态同 v0.8.9）", () => {
  assert.equal(DEFAULT_MAX_CONCURRENT_WRITES, 1);
  assert.equal(DEFAULT_MAX_CONCURRENT_READS, 1);
  assert.deepEqual(effectiveGateLimits(undefined), { write: 1, read: 1 });
  assert.deepEqual(effectiveGateLimits({ backendCmd: "C:/x.exe" }), { write: 1, read: 1 });
  assert.deepEqual(effectiveGateLimits({ maxConcurrentWrites: 3, maxConcurrentReads: 5 }), {
    write: 3,
    read: 5,
  });
  assert.equal(resolveMaxConcurrentWrites({}), undefined);
  assert.equal(resolveMaxConcurrentReads({}), undefined);
});

test("config：闸上限 = 正整数（含 1）⇒ 正常加载并原样保留", () => {
  withAgentConfig({ maxConcurrentWrites: 1, maxConcurrentReads: 4 }, (path) => {
    const cfg = loadMachineConfig(path);
    assert.equal(cfg.projects[0]?.agentConfig?.["maxConcurrentWrites"], 1);
    assert.equal(cfg.projects[0]?.agentConfig?.["maxConcurrentReads"], 4);
  });
  withAgentConfig({ backendCmd: "C:/x/opencode.exe" }, (path) => {
    const cfg = loadMachineConfig(path);
    assert.equal(cfg.projects[0]?.agentConfig?.["maxConcurrentWrites"], undefined, "缺键合法 = 落缺省 1");
  });
});

test("config：闸上限非法（0 / 负数 / 小数 / 字符串 / null）⇒ fail-fast 且指名键", () => {
  for (const key of ["maxConcurrentWrites", "maxConcurrentReads"] as const) {
    for (const bad of [0, -1, 1.5, "2", null]) {
      withAgentConfig({ [key]: bad }, (path) => {
        let text: string | null = null;
        try {
          loadMachineConfig(path);
        } catch (err) {
          text = String(err);
        }
        assert.notEqual(text, null, `${key}=${JSON.stringify(bad)} 应 fail-fast`);
        assert.match(text ?? "", new RegExp(key));
      });
    }
  }
});

// ---- ② `readOnly` 消费：只有显式 true 进读档 ----

test("laneOfReadOnly / parseRunnerCommand：仅显式 true 归读档，其余按写（老桥不下发即现状）", () => {
  assert.equal(laneOfReadOnly(true), "read");
  assert.equal(laneOfReadOnly(false), "write");
  assert.equal(laneOfReadOnly(undefined), "write");
  assert.equal(laneOfReadOnly("true"), "write");

  const bare = parseRunnerCommand({
    type: "dispatch",
    taskId: "t",
    projectId: "p",
    contextId: "c",
  });
  assert.ok(bare?.type === "dispatch");
  assert.equal(bare?.readOnly, undefined);

  const read = parseRunnerCommand({
    type: "dispatch",
    taskId: "t",
    projectId: "p",
    contextId: "c",
    readOnly: true,
  });
  assert.ok(read?.type === "dispatch" && read.readOnly === true);

  const notRead = parseRunnerCommand({
    type: "dispatch",
    taskId: "t",
    projectId: "p",
    contextId: "c",
    readOnly: "yes",
  });
  assert.ok(notRead?.type === "dispatch" && notRead.readOnly === undefined);

  const both = parseRunnerCommand({
    type: "dispatch",
    taskId: "t",
    projectId: "p",
    contextId: "c",
    readOnly: true,
    claimToken: "ct-1",
  });
  assert.ok(both?.type === "dispatch" && both.readOnly === true && both.claimToken === "ct-1");
});

// ---- ③ 闸本体：FIFO / 档位独立 / 快照（假时钟，纯数据结构层） ----

test("DispatchGate：1/1 ⇒ 同档串行、跨档独立、释放席位移交队首", async () => {
  let clockMs = 1_000;
  const gate = new DispatchGate(() => ({ write: 1, read: 1 }), () => clockMs);

  assert.equal(await gate.acquire("p", "write", "w1"), 0, "空位 ⇒ 立即放行（排队 0ms）");
  const admitted: string[] = [];
  const w2 = gate.acquire("p", "write", "w2").then((waited) => admitted.push(`w2:${waited}`));
  const w3 = gate.acquire("p", "write", "w3").then((waited) => admitted.push(`w3:${waited}`));
  void w2;
  void w3;
  clockMs = 4_000;
  assert.equal(await gate.acquire("p", "read", "r1"), 0, "读档独立 ⇒ 不受写档占位影响");

  const mid = gate.snapshot();
  assert.deepEqual(mid.inFlightByProject, { p: { write: 1, read: 1 } });
  assert.deepEqual(mid.queuedByProject, { p: { write: 2, read: 0, oldestWaitedMs: 3_000 } });

  gate.release("p", "write"); // 席位给队首 w2，不给后来者
  await tick(2);
  assert.deepEqual(admitted, ["w2:3000"], "w2 到队于 1000、放行于 4000 ⇒ 等了 3000ms");
  assert.deepEqual(gate.snapshot().inFlightByProject, { p: { write: 1, read: 1 } });
  // w3 自 1000 起排队、此刻（4000）仍在队 ⇒ 队首等待时长照实累计，不因 w2 刚放行而归零
  assert.deepEqual(gate.snapshot().queuedByProject, { p: { write: 1, read: 0, oldestWaitedMs: 3_000 } });

  clockMs = 5_000;
  gate.release("p", "write"); // w2 交卷 ⇒ 移交 w3（放行时刻即等待结束时刻）
  await tick(2);
  assert.deepEqual(admitted, ["w2:3000", "w3:4000"]);

  gate.release("p", "write");
  gate.release("p", "read");
  assert.deepEqual(gate.snapshot(), { inFlightByProject: {}, queuedByProject: {} });
});

test("DispatchGate：上限 ≥2 才真并行；后到者排到队尾（不插队）", async () => {
  let clockMs = 0;
  const gate = new DispatchGate(() => ({ write: 1, read: 2 }), () => clockMs);
  assert.equal(await gate.acquire("p", "read", "r1"), 0);
  assert.equal(await gate.acquire("p", "read", "r2"), 0);

  const order: string[] = [];
  clockMs = 100;
  const late = gate.acquire("p", "read", "r4").then(() => order.push("r4"));
  clockMs = 200;
  const later = gate.acquire("p", "read", "r3").then(() => order.push("r3"));
  assert.deepEqual(gate.snapshot().queuedByProject, {
    p: { write: 0, read: 2, oldestWaitedMs: 100 },
  });

  gate.release("p", "read");
  gate.release("p", "read");
  await Promise.all([late, later]);
  assert.deepEqual(order, ["r4", "r3"], "FIFO：先入队者先得席位，与 taskId 命名无关");
});

// ---- ④ 真链路：执法点在 fire-and-forget 之前 ----

test("真链路 ①：缺省 1/1 ⇒ 同项目两条写派发串行（第二条排队）= 与 v0.8.9 同形", async () => {
  const h = makeHarness(project());
  await dispatch(h.exec, "w1");
  await dispatch(h.exec, "w2");
  await tick();

  assert.deepEqual(h.started, ["w1"], "写档满位 ⇒ w2 未放行");
  assert.equal(h.ledger.size, 2, "排队中的派发仍算在飞（stop 拒收 / idleStop 判据据它）");
  assert.equal(h.ledger.get("w1")?.readOnly, false, "缺省按写");
  assert.equal(typeof h.ledger.get("w1")?.admittedAt, "string", "放行时刻 = admittedAt");
  assert.equal(h.ledger.get("w2")?.admittedAt, undefined, "未放行 ⇒ 不写 admittedAt");
  const snap = h.exec.gateSnapshot();
  assert.deepEqual(snap.inFlightByProject, { alpha: { write: 1, read: 0 } });
  assert.equal(snap.queuedByProject.alpha?.write, 1);
  assert.ok((snap.queuedByProject.alpha?.oldestWaitedMs ?? -1) >= 0);

  const done2 = h.delivered("w2");
  await h.finish("w1");
  await tick();
  assert.deepEqual(h.started, ["w1", "w2"], "w1 交卷后 w2 才起（串行放行）");
  assert.equal(typeof h.ledger.get("w2")?.admittedAt, "string", "放行后刷入 admittedAt");
  await h.finish("w2");
  await done2;
  assert.equal(h.ledger.size, 0);
  assert.deepEqual(h.exec.gateSnapshot(), { inFlightByProject: {}, queuedByProject: {} });
});

test("真链路 ②：读档与写档互不占位（写在飞时读放行；读满时写照进）", async () => {
  // A. 写档占满 ⇒ 读档另起一路（读不占写位、写也不挡读）
  const a = makeHarness(project());
  await dispatch(a.exec, "w1");
  await dispatch(a.exec, "r1", { readOnly: true });
  await tick();
  assert.deepEqual(a.started, ["w1", "r1"], "读不占写位 ⇒ 写在飞期间读照常放行");
  assert.equal(a.ledger.get("r1")?.readOnly, true);
  assert.ok(typeof a.ledger.get("r1")?.admittedAt === "string", "放行时刻落 admittedAt");
  assert.deepEqual(a.exec.gateSnapshot().inFlightByProject, { alpha: { write: 1, read: 1 } });

  // B. 读档满（上限 1）⇒ 第二条读排队，但**写**照进（读位不挡写位）
  const b = makeHarness(project({ maxConcurrentReads: 1 }));
  const doneW1 = b.delivered("w1");
  const doneR1 = b.delivered("r1");
  const doneR2 = b.delivered("r2");
  const doneW2 = b.delivered("w2");
  await dispatch(b.exec, "r1", { readOnly: true });
  await dispatch(b.exec, "r2", { readOnly: true });
  await dispatch(b.exec, "w1");
  await tick();
  assert.deepEqual(b.started, ["r1", "w1"], "读档满时写仍可进；r2 留在读档队列");
  const snap = b.exec.gateSnapshot();
  assert.deepEqual(snap.inFlightByProject, { alpha: { write: 1, read: 1 } });
  assert.deepEqual(snap.queuedByProject.alpha && { ...snap.queuedByProject.alpha, oldestWaitedMs: 0 }, {
    write: 0,
    read: 1,
    oldestWaitedMs: 0,
  });

  await b.finish("r1");
  await tick();
  assert.ok(b.started.includes("r2"), "读档释放后 r2 放行");
  await dispatch(b.exec, "w2");
  await tick();
  await b.finish("w1");
  await b.finish("w2");
  await b.finish("r2");
  await Promise.all([doneW1, doneR1, doneR2, doneW2]);
  assert.deepEqual(b.exec.gateSnapshot(), { inFlightByProject: {}, queuedByProject: {} });
});

test("真链路 ③：maxConcurrentReads=2 ⇒ 两读并行、第三读按 FIFO 排队", async () => {
  const h = makeHarness(project({ maxConcurrentReads: 2 }));
  const done3 = h.delivered("r3");
  await dispatch(h.exec, "r1", { readOnly: true });
  await dispatch(h.exec, "r2", { readOnly: true });
  await dispatch(h.exec, "r3", { readOnly: true });
  await tick();
  assert.deepEqual(h.started, ["r1", "r2"], "上限 2 ⇒ 第三条读排队");

  await h.finish("r1");
  await tick();
  assert.deepEqual(h.started, ["r1", "r2", "r3"], "释放的席位归队首 r3");
  await h.finish("r2");
  await h.finish("r3");
  await done3;
});

test("真链路 ④：单条派发不经受任何新行为（缺省态零回归）", async () => {
  const h = makeHarness(project());
  const done = h.delivered("solo");
  await dispatch(h.exec, "solo");
  await tick();
  assert.deepEqual(h.started, ["solo"]);
  assert.equal(h.ledger.get("solo")?.readOnly, false);
  await h.finish("solo");
  const result = await done;
  assert.equal(result.state, "completed");
  assert.equal(result.taskId, "solo");
  assert.equal(h.ledger.size, 0);
  assert.deepEqual(h.exec.gateSnapshot(), { inFlightByProject: {}, queuedByProject: {} });
});

test("Runner.gateSnapshot：未接执行器（Phase A 形态）⇒ 两映射皆空、不抛", () => {
  const runner = new Runner(
    { machineId: "m-test", launcher: { port: 3100, bridge: BRIDGE }, projects: [project()] },
    BRIDGE,
    { ok: true, failures: [], unavailable: [] },
    { fetch: async () => new Response("", { status: 200 }), sleep: async () => {}, logger: SILENT },
  );
  assert.deepEqual(runner.gateSnapshot(), { inFlightByProject: {}, queuedByProject: {} });
});
