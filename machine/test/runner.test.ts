/**
 * `machine/launcher/runner.ts` 单元测试（`node:test`，无新依赖）。
 *
 * 覆盖节点 MA1 门禁要求：
 * - 退避序列（1s→2s→4s→8s→16s→30s cap ±20% jitter）；
 * - 401 / 403 结构化错误不崩进程（循环退避照跑）；
 * - 注册载荷构造（字段 / 有效 risk 缺省 / protocolVersion）+ Bearer 鉴权头；
 * - 缺 `launcher.bridge` 时 `createRunner` 返回 null（零出站）；
 * - 长轮询空响应 = 心跳、含命令 = 仅计数不执行；
 * - in-flight 台账数据结构。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  InFlightLedger,
  RUNNER_VERSION,
  Runner,
  RunnerHttpError,
  buildRegisterPayload,
  computeBackoffDelayMs,
  createRunner,
  type RunnerLogger,
  type RunnerRegisterPayload,
} from "../launcher/runner.js";
import type { SelfCheckResult } from "../launcher/self-check.js";
import { SELF_CHECK_LEDGER_PREFIX } from "../launcher/self-check.js";
import { PROTOCOL_VERSION, type BridgeConfig, type MachineConfig } from "../types.js";

const BRIDGE: BridgeConfig = { url: "http://bridge.test:3200", token: "tok-abc" };

const MACHINE: MachineConfig = {
  machineId: "m-test",
  launcher: { port: 3100, bridge: BRIDGE },
  projects: [
    {
      projectId: "alpha",
      workspace: "C:/ws/alpha",
      agentKind: "opencode",
      a2aPort: 3010,
      risk: "read",
    },
    { projectId: "beta", workspace: "C:/ws/beta", agentKind: "codex", a2aPort: 3011 },
  ],
};

const SELF_CHECK_OK: SelfCheckResult = { ok: true, failures: [], unavailable: [] };

interface CapturingLogger extends RunnerLogger {
  lines: string[];
}

function silentLogger(): CapturingLogger {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info:${message}`),
    warn: (message) => lines.push(`warn:${message}`),
    error: (message) => lines.push(`error:${message}`),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 记录调用并回固定响应的 fake fetch */
function recordingFetch(response: () => Response): {
  calls: Array<{ url: string; init: RequestInit }>;
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return response();
    },
  };
}

test("退避序列：1s→2s→4s→8s→16s→30s 并 cap 30s（±20% jitter）", () => {
  const mid = (): number => 0.5;
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7].map((attempt) => computeBackoffDelayMs(attempt, mid)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
  );

  // 抖动下界 / 上界（random=0 → ×0.8，random=1 → ×1.2）
  assert.equal(
    computeBackoffDelayMs(0, () => 0),
    Math.round(BACKOFF_BASE_MS * 0.8),
  );
  assert.equal(
    computeBackoffDelayMs(0, () => 1),
    Math.round(BACKOFF_BASE_MS * 1.2),
  );
  // cap 同样吃抖动，但不越出 ±20%
  assert.equal(
    computeBackoffDelayMs(9, () => 1),
    Math.round(BACKOFF_CAP_MS * 1.2),
  );
  assert.ok(computeBackoffDelayMs(0, () => 0) >= BACKOFF_BASE_MS * 0.8);
  assert.ok(computeBackoffDelayMs(0, () => 1) <= BACKOFF_BASE_MS * 1.2);
});

test("注册载荷构造：字段齐全、risk 缺省 write、protocolVersion 取当前常量", () => {
  const payload = buildRegisterPayload(MACHINE, SELF_CHECK_OK);
  assert.equal(payload.machineId, "m-test");
  assert.equal(payload.protocolVersion, PROTOCOL_VERSION);
  // 可选字段 `version` 自报 Runner 软件版本（观测用，非 protocolVersion）：非空字符串
  assert.ok(typeof payload.version === "string" && payload.version.length > 0);
  assert.equal(payload.version, RUNNER_VERSION);
  assert.deepEqual(payload.capabilities, {});
  assert.deepEqual(payload.selfCheck, { ok: true, failures: [] });
  assert.deepEqual(payload.projects, [
    { projectId: "alpha", agentKind: "opencode", risk: "read", a2aPort: 3010 },
    { projectId: "beta", agentKind: "codex", risk: "write", a2aPort: 3011 },
  ]);
});

test("注册请求：POST /runner/register + Bearer 鉴权头 + 载荷入 body", async () => {
  const { calls, fetchFn } = recordingFetch(() =>
    jsonResponse(200, { result: { ok: true }, data: null, error: null }),
  );
  const runner = new Runner(MACHINE, BRIDGE, SELF_CHECK_OK, {
    fetch: fetchFn,
    logger: silentLogger(),
  });

  await runner.register();

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.url, "http://bridge.test:3200/runner/register");
  assert.equal(call.init.method, "POST");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], "Bearer tok-abc");
  assert.equal(headers["content-type"], "application/json");
  const body = JSON.parse(String(call.init.body)) as RunnerRegisterPayload;
  assert.deepEqual(body, buildRegisterPayload(MACHINE, SELF_CHECK_OK));
  assert.equal(runner.state.registered, true);
  assert.ok(runner.state.lastRegisteredAt !== null);
});

test("401 结构化错误：抛出 RunnerHttpError（status + code）", async () => {
  const { fetchFn } = recordingFetch(() =>
    jsonResponse(401, {
      result: null,
      data: null,
      error: { code: "runner_unauthorized", message: "bad token" },
    }),
  );
  const runner = new Runner(MACHINE, BRIDGE, SELF_CHECK_OK, {
    fetch: fetchFn,
    logger: silentLogger(),
  });

  await assert.rejects(
    () => runner.register(),
    (err: unknown) => {
      assert.ok(err instanceof RunnerHttpError);
      assert.equal(err.status, 401);
      assert.equal(err.code, "runner_unauthorized");
      assert.equal(err.message, "bad token");
      return true;
    },
  );
  assert.equal(runner.state.registered, false);
});

test("401 不崩进程：后台循环按退避序列重试并可被 stop() 收束", async () => {
  const logger = silentLogger();
  const delays: number[] = [];
  let fetchCount = 0;
  let runnerRef: Runner | null = null;

  const fetchFn = async (): Promise<Response> => {
    fetchCount += 1;
    // 第 4 次调用时从 fetch 内部触发 stop（模拟关停 / 外部终止）
    if (fetchCount === 4) runnerRef?.stop();
    return jsonResponse(403, {
      result: null,
      data: null,
      error: { code: "runner_not_allowed", message: "not a member machine" },
    });
  };

  const runner = new Runner(MACHINE, BRIDGE, SELF_CHECK_OK, {
    fetch: fetchFn,
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
    logger,
  });
  runnerRef = runner;

  runner.start();
  await runner.whenStopped();

  assert.equal(fetchCount, 4);
  assert.equal(runner.state.registered, false);
  assert.equal(runner.state.failures, 3);
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.ok(runner.state.lastError?.includes("not a member machine"));
  assert.ok(
    logger.lines.some(
      (line) => line.startsWith("error:") && line.includes("code=runner_not_allowed"),
    ),
  );
});

test("缺 launcher.bridge：createRunner 返回 null 且零出站", async () => {
  const noBridge: MachineConfig = { machineId: "m2", launcher: { port: 3100 }, projects: [] };
  let called = 0;
  const runner = createRunner(noBridge, SELF_CHECK_OK, {
    fetch: async () => {
      called += 1;
      return jsonResponse(200, {});
    },
  });

  assert.equal(runner, null);
  assert.equal(called, 0);
});

test("长轮询：空响应 / 204 = 心跳，非空响应 = 命令（仅计数不执行）", async () => {
  const responses: Response[] = [
    new Response(null, { status: 204 }),
    jsonResponse(200, { result: { command: "dispatch" }, data: null, error: null }),
  ];
  let index = 0;
  const runner = new Runner(MACHINE, BRIDGE, SELF_CHECK_OK, {
    fetch: async () => responses[index++] ?? new Response(null, { status: 204 }),
    logger: silentLogger(),
  });

  assert.equal(await runner.connect(), "heartbeat");
  assert.ok(runner.state.lastHeartbeatAt !== null);
  assert.equal(runner.state.commandsReceived, 0);

  assert.equal(await runner.connect(), "command");
  assert.equal(runner.state.commandsReceived, 1);
  assert.ok(runner.state.lastCommandAt !== null);
});

test("in-flight 台账：Map 增删查与 projectId 反查", () => {
  const ledger = new InFlightLedger();
  ledger.add({ taskId: "t1", projectId: "alpha", startedAt: "2026-09-18T00:00:00Z" });
  ledger.add({ taskId: "t2", projectId: "beta", startedAt: "2026-09-18T00:01:00Z" });

  assert.equal(ledger.size, 2);
  assert.equal(ledger.has("t1"), true);
  assert.equal(ledger.projectOf("t2"), "beta");

  assert.equal(ledger.remove("t1"), true);
  assert.equal(ledger.remove("t1"), false);
  assert.equal(ledger.size, 1);
  assert.deepEqual(
    ledger.snapshot().map((entry) => entry.taskId),
    ["t2"],
  );

  ledger.clear();
  assert.equal(ledger.size, 0);
});

test("countFor：按项目在飞计数（v0.8.10 · M-N1），remove 后同步回落", () => {
  const ledger = new InFlightLedger();
  ledger.add({ taskId: "a1", projectId: "alpha", startedAt: "2026-09-18T00:00:00Z" });
  ledger.add({ taskId: "a2", projectId: "alpha", startedAt: "2026-09-18T00:00:10Z" });
  ledger.add({ taskId: "b1", projectId: "beta", startedAt: "2026-09-18T00:00:20Z" });

  assert.equal(ledger.countFor("alpha"), 2);
  assert.equal(ledger.countFor("beta"), 1);
  assert.equal(ledger.countFor("gamma"), 0, "无条目项目 = 0，不抛");

  assert.equal(ledger.remove("a2"), true);
  assert.equal(ledger.countFor("alpha"), 1);
  assert.equal(ledger.size, 2, "全机 size 与按项目 countFor 各自独立");

  // 自检前缀条目同样计入按项目数（idleStop 保护口径与 size 一致）
  ledger.add({
    taskId: `${SELF_CHECK_LEDGER_PREFIX}alpha`,
    projectId: "alpha",
    startedAt: "2026-09-18T00:01:00Z",
  });
  assert.equal(ledger.countFor("alpha"), 2);
});
