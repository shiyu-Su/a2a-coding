/**
 * `machine/launcher/server.ts` `GET /health` 的 `degraded` 段（v0.8.8 · 节点 M4，改造文档 §2.9）。
 *
 * 门禁判据：
 * - **负向用例（本节点要消灭的现象）**：`launcher.startupCheck === false` ⇒
 *   `degraded.selfCheckSkipped === true` —— 跳过自检不再被伪装成「自检通过」；
 * - 未降级时该段无假阳性（缺省读点 = 全 false / 空集），且既有
 *   `ok` / `protocolVersion` / `status` / `bridge` 逐字段不变（additive 承诺，
 *   launcherctl / reaper 的就绪判定只吃 `status`）；
 * - 三处只读数据源补齐：`manager.unavailableProjectIds()` / `FileOutbox.loopAlive` /
 *   `Runner.loopAlive`。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../launcher/manager.js";
import { Runner, type RunnerLogger } from "../launcher/runner.js";
import { createFileOutbox } from "../launcher/runner-outbox.js";
import type { SelfCheckFailure } from "../launcher/self-check.js";
import { StopEventLedger } from "../launcher/stop-ledger.js";
import {
  buildDegradedStatus,
  createLauncherApp,
  type BridgeHealthStatus,
  type DegradedInputs,
  type DegradedStatus,
  type LauncherAppOptions,
} from "../launcher/server.js";
import { PROTOCOL_VERSION, type BridgeConfig, type MachineConfig } from "../types.js";

const BRIDGE: BridgeConfig = { url: "http://bridge.test:3200", token: "tok-abc" };

const MACHINE_WITH_BRIDGE: MachineConfig = {
  machineId: "m-degraded",
  launcher: { port: 0, bridge: BRIDGE },
  projects: [],
};

const SILENT: RunnerLogger = {
  info: (message) => void message,
  warn: (message) => void message,
  error: (message) => void message,
};

/** `/health` 响应体（线协议形状） */
interface HealthBody {
  ok: boolean;
  protocolVersion: string;
  status: string;
  bridge: BridgeHealthStatus;
  degraded: DegradedStatus;
}

/** 未装配读点时的基线（= 无降级、未启用 bridge 的机器） */
const CLEAN: DegradedStatus = {
  selfCheckSkipped: false,
  selfCheckFailedProjects: [],
  unavailableProjectIds: [],
  outboxLoopAlive: false,
  outboxPendingCount: 0,
  runnerLoopAlive: false,
  inFlightCount: 0,
  /** v0.8.10 · M-N4：取消超时未静默的项目集（未装配读点 ⇒ 无观察） */
  cancelUnsupported: [],
  /** v0.8.10 增补轨 · A1：三键恒在，空态 = {} / {} / null（不得省略键） */
  inFlightByProject: {},
  queuedByProject: {},
  lastCancelQuietMs: null,
};

/** 组装 `degraded` 原料的测试基线：只覆盖被断言的那一维，其余取「无降级」现值 */
function inputs(overrides: Partial<DegradedInputs>): DegradedInputs {
  return {
    selfCheckFailures: [],
    unavailableProjectIds: [],
    outboxLoopAlive: false,
    outboxPendingCount: 0,
    runnerLoopAlive: false,
    inFlightCount: 0,
    ...overrides,
  };
}

/** 起真实 HTTP 服务读一次 `/health`（拉起后立即关闭），避免引入 supertest 依赖 */
async function fetchHealth(options: LauncherAppOptions): Promise<HealthBody> {
  const app = createLauncherApp(options);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("无法解析监听端口");
    }
    const res = await fetch(`http://127.0.0.1:${String(address.port)}/health`);
    assert.equal(res.status, 200);
    return (await res.json()) as HealthBody;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

function ensureFailure(projectId: string, cause?: SelfCheckFailure["cause"]): SelfCheckFailure {
  return {
    projectId,
    stage: "ensure",
    reason: "拉起失败",
    hint: "检查端口",
    ...(cause !== undefined ? { cause } : {}),
  };
}

test("buildDegradedStatus：startupCheck=false → selfCheckSkipped=true（负向：不再伪装成自检通过）", () => {
  const degraded = buildDegradedStatus(inputs({ startupCheck: false }));

  assert.equal(degraded.selfCheckSkipped, true);
});

test("buildDegradedStatus：startupCheck 缺省 / true → selfCheckSkipped=false（自检在跑，非降级）", () => {
  assert.equal(buildDegradedStatus(inputs({})).selfCheckSkipped, false);
  assert.equal(buildDegradedStatus(inputs({ startupCheck: true })).selfCheckSkipped, false);
});

test("buildDegradedStatus：自检失败项复用结构化结论，只出 {projectId,stage,cause}", () => {
  const degraded = buildDegradedStatus(
    inputs({
      startupCheck: true,
      selfCheckFailures: [ensureFailure("p1", "auth"), ensureFailure("p2")],
    }),
  );

  assert.equal(degraded.selfCheckSkipped, false);
  assert.deepEqual(degraded.selfCheckFailedProjects, [
    { projectId: "p1", stage: "ensure", cause: "auth" },
    { projectId: "p2", stage: "ensure" },
  ]);
});

test("buildDegradedStatus：取消超时未静默的项目 ⇒ 落 degraded.cancelUnsupported（v0.8.10 · M-N4 ②）", () => {
  // 无观察 = 空数组（**不是**「已全部静默」，静默者由 config-snapshot 播报承载）
  assert.deepEqual(buildDegradedStatus(inputs({})).cancelUnsupported, []);
  assert.deepEqual(
    buildDegradedStatus(inputs({ cancelUnsupported: ["alpha"] })).cancelUnsupported,
    ["alpha"],
  );
});

test("/health：degraded 经 HTTP 面带出 cancelUnsupported（读点 = 停事件账）", async () => {
  const body = await fetchHealth({
    getDegraded: () => buildDegradedStatus(inputs({ cancelUnsupported: ["alpha"] })),
  });

  assert.deepEqual(body.degraded.cancelUnsupported, ["alpha"]);
});

test("buildDegradedStatus：A1 三键恒在 —— 空态给 {} / {} / null，不省略键", () => {
  const degraded = buildDegradedStatus(inputs({}));

  assert.ok("inFlightByProject" in degraded);
  assert.ok("queuedByProject" in degraded);
  assert.ok("lastCancelQuietMs" in degraded);
  assert.deepEqual(degraded.inFlightByProject, {});
  assert.deepEqual(degraded.queuedByProject, {});
  assert.equal(degraded.lastCancelQuietMs, null);
});

test("buildDegradedStatus：闸快照与取消往返耗时原样透出（装配点不做加工）", () => {
  const degraded = buildDegradedStatus(
    inputs({
      gate: {
        inFlightByProject: { p: { write: 1, read: 2 } },
        queuedByProject: { p: { write: 3, read: 0, oldestWaitedMs: 4_200 } },
      },
      lastCancelQuietMs: 1_234,
    }),
  );

  assert.deepEqual(degraded.inFlightByProject, { p: { write: 1, read: 2 } });
  assert.deepEqual(degraded.queuedByProject, { p: { write: 3, read: 0, oldestWaitedMs: 4_200 } });
  assert.equal(degraded.lastCancelQuietMs, 1_234);
});

test("/health：degraded 经 HTTP 面带出档位两键与 lastCancelQuietMs（v0.8.10 增补轨 · A1）", async () => {
  const body = await fetchHealth({
    getDegraded: () =>
      buildDegradedStatus(
        inputs({
          gate: {
            inFlightByProject: { p: { write: 1, read: 0 } },
            queuedByProject: {},
          },
          lastCancelQuietMs: 77,
        }),
      ),
  });

  assert.deepEqual(body.degraded.inFlightByProject, { p: { write: 1, read: 0 } });
  assert.deepEqual(body.degraded.queuedByProject, {});
  assert.equal(body.degraded.lastCancelQuietMs, 77);
});

test("StopEventLedger.lastCancelQuiesceMsOverall：无观察 null；后发全局覆盖（lastCancelQuietMs 数据源）", () => {
  const ledger = new StopEventLedger();
  assert.equal(ledger.lastCancelQuiesceMsOverall(), null);

  ledger.noteCancelQuiesce("alpha", 1_234.6);
  assert.equal(ledger.lastCancelQuiesceMsOverall(), 1_235);

  ledger.noteCancelQuiesce("beta", 80);
  assert.equal(ledger.lastCancelQuiesceMsOverall(), 80);
  // 按项目口径不受影响（config-snapshot 播报仍读每项目值）
  assert.equal(ledger.lastCancelQuiesceMs("alpha"), 1_235);
  assert.equal(ledger.lastCancelQuiesceMs("beta"), 80);
});

test("/health：未装配 degraded 读点 → 基线无假阳性，既有字段逐不变（additive）", async () => {  const body = await fetchHealth({});

  assert.deepEqual(body.degraded, CLEAN);
  assert.deepEqual(
    {
      ok: body.ok,
      protocolVersion: body.protocolVersion,
      status: body.status,
      bridge: body.bridge,
    },
    {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      status: "ok",
      bridge: { registered: false, lastHeartbeatAt: null, lastError: null },
    },
  );
});

test("/health：读点装配后 selfCheckSkipped 经 HTTP 面可见，且 status 口径不受影响", async () => {
  const body = await fetchHealth({
    isReady: () => false,
    getDegraded: () =>
      buildDegradedStatus(inputs({ startupCheck: false, unavailableProjectIds: ["p-a", "p-b"] })),
  });

  assert.equal(body.degraded.selfCheckSkipped, true);
  assert.deepEqual(body.degraded.unavailableProjectIds, ["p-a", "p-b"]);
  // 就绪语义仍只由 status 表达（只加键不改值）
  assert.equal(body.status, "starting");
});

test("manager.unavailableProjectIds：登记后出 id 集，纯读不消耗登记", () => {
  const manager = new AgentManager(MACHINE_WITH_BRIDGE);

  assert.deepEqual(manager.unavailableProjectIds(), []);
  manager.markUnavailable("p-a", "ensure: EADDRINUSE");
  manager.markUnavailable("p-b", "settle: 超时");
  assert.deepEqual(manager.unavailableProjectIds(), ["p-a", "p-b"]);
  // 重复读仍为同一集合（getter 不删除条目）
  assert.deepEqual(manager.unavailableProjectIds(), ["p-a", "p-b"]);
});

test("FileOutbox.loopAlive：未启动 / start / stop 三态", async () => {
  const outbox = createFileOutbox({ dir: join(tmpdir(), "a2a-degraded-outbox"), bridge: BRIDGE });
  assert.equal(outbox.loopAlive, false);

  outbox.start();
  assert.equal(outbox.loopAlive, true);

  outbox.stop();
  assert.equal(outbox.loopAlive, false);
  await outbox.whenStopped();
});

test("Runner.loopAlive：出站循环存活区别于 bridge.registered", async () => {
  const runner = new Runner(
    MACHINE_WITH_BRIDGE,
    BRIDGE,
    { ok: true, failures: [], unavailable: [] },
    {
      fetch: async () =>
        new Response(JSON.stringify({ result: { ok: true }, data: null, error: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      sleep: async () => {},
      logger: SILENT,
    },
  );

  // 注册成功但循环未跑：registered=true、loopAlive=false（两面各自如实）
  await runner.register();
  assert.equal(runner.healthSnapshot().registered, true);
  assert.equal(runner.loopAlive, false);

  runner.start();
  assert.equal(runner.loopAlive, true);
  runner.stop();
  assert.equal(runner.loopAlive, false);
  await runner.whenStopped();
});
