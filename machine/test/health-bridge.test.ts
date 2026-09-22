/**
 * `machine/launcher/server.ts` `GET /health` 的 `bridge` 段（v0.7.0 · 节点 M2·MA2）。
 *
 * 门禁判据：
 * - bridge **未启用** → `bridge.registered === false`，且既有 `ok` / `protocolVersion` /
 *   `status` 三者与旧口径**逐字段不变**（additive 承诺）；
 * - bridge **启用** → 注册成功后 `registered === true`；心跳刷新 `lastHeartbeatAt`；
 *   失败进入退避时 `registered === false` 且 `lastError` 非空。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Runner, type RunnerLogger } from "../launcher/runner.js";
import {
  createLauncherApp,
  type BridgeHealthStatus,
  type LauncherAppOptions,
} from "../launcher/server.js";
import type { SelfCheckResult } from "../launcher/self-check.js";
import { PROTOCOL_VERSION, type BridgeConfig, type MachineConfig } from "../types.js";

const BRIDGE: BridgeConfig = { url: "http://bridge.test:3200", token: "tok-abc" };

/** 启用 bridge 的机器（用于「启用 → 注册成功」判据；未启用 = 无 bridge 的默认快照） */
const MACHINE_WITH_BRIDGE: MachineConfig = {
  machineId: "m-health",
  launcher: { port: 0, bridge: BRIDGE },
  projects: [],
};

const SELF_CHECK_OK: SelfCheckResult = { ok: true, failures: [], unavailable: [] };

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
}

/** 旧口径三字段（additive 承诺：这三者不得因 bridge 段而变化） */
function legacy(body: HealthBody): { ok: boolean; protocolVersion: string; status: string } {
  return { ok: body.ok, protocolVersion: body.protocolVersion, status: body.status };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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
    const res = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(res.status, 200);
    return (await res.json()) as HealthBody;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

const DISABLED: BridgeHealthStatus = {
  registered: false,
  lastHeartbeatAt: null,
  lastError: null,
};

test("/health：bridge 未启用 → registered:false，既有 ok/protocolVersion/status 逐不变", async () => {
  const body = await fetchHealth({});

  assert.deepEqual(body.bridge, DISABLED);
  assert.deepEqual(legacy(body), {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    status: "ok",
  });
});

test("/health：isReady=false 时 status=starting，bridge 仍为未启用态", async () => {
  const body = await fetchHealth({ isReady: () => false });

  assert.deepEqual(body.bridge, DISABLED);
  assert.deepEqual(legacy(body), {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    status: "starting",
  });
});

test("/health：bridge 启用，注册成功后 registered:true（read 点取自 Runner 共享状态）", async () => {
  const runner = new Runner(MACHINE_WITH_BRIDGE, BRIDGE, SELF_CHECK_OK, {
    fetch: async () => jsonResponse(200, { result: { ok: true }, data: null, error: null }),
    logger: SILENT,
  });
  await runner.register();

  const body = await fetchHealth({ getBridgeStatus: () => runner.healthSnapshot() });

  assert.deepEqual(body.bridge, { registered: true, lastHeartbeatAt: null, lastError: null });
  // 注册成功后既有三字段仍为就绪口径（不受 bridge 影响）
  assert.deepEqual(legacy(body), {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    status: "ok",
  });
});

test("/health：bridge 启用，心跳后 lastHeartbeatAt 非空", async () => {
  let call = 0;
  const runner = new Runner(MACHINE_WITH_BRIDGE, BRIDGE, SELF_CHECK_OK, {
    fetch: async () => {
      call += 1;
      return call === 1
        ? jsonResponse(200, { result: { ok: true }, data: null, error: null })
        : new Response(null, { status: 204 });
    },
    logger: SILENT,
  });
  await runner.register();
  assert.equal(await runner.connect(), "heartbeat");

  const body = await fetchHealth({ getBridgeStatus: () => runner.healthSnapshot() });

  assert.equal(body.bridge.registered, true);
  assert.ok(body.bridge.lastHeartbeatAt !== null);
  assert.equal(body.bridge.lastError, null);
});

test("/health：bridge 启用但注册失败 → registered:false 且 lastError 非空", async () => {
  let fetchCount = 0;
  let runnerRef: Runner | null = null;
  const runner = new Runner(MACHINE_WITH_BRIDGE, BRIDGE, SELF_CHECK_OK, {
    fetch: async () => {
      fetchCount += 1;
      // 第 2 次失败后再收敛循环（第 1 次已在 handleFailure 写入 lastError）
      if (fetchCount === 2) runnerRef?.stop();
      return jsonResponse(401, {
        result: null,
        data: null,
        error: { code: "runner_unauthorized", message: "bad token" },
      });
    },
    sleep: async () => {},
    random: () => 0.5,
    logger: SILENT,
  });
  runnerRef = runner;

  runner.start();
  await runner.whenStopped();

  const body = await fetchHealth({ getBridgeStatus: () => runner.healthSnapshot() });

  assert.equal(body.bridge.registered, false);
  assert.ok(body.bridge.lastError?.includes("bad token") === true);
});
