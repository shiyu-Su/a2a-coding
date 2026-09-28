/**
 * HTTP transport `close()` **有界化**用例（v0.7.2 K1 / K8）。
 *
 * 背景（v0.7.2 K1 主嫌）：`bridge/transports/http.ts` 的 `close()` 原为裸 `server.close(cb)` ——
 * 有 keep-alive 连接时回调永不触发 ⇒ 停机链不 settle、`process.exit(0)` 不可达、进程不退、
 * `core.lock` 不释放。修复 = `server.close(cb)` + `closeIdleConnections()` +
 * **`HTTP_CLOSE_GRACE_MS` 兜底 timer → `closeAllConnections()` 强断并 resolve**（幂等）。
 *
 * 本文件覆盖三条：
 * 1. **空闲 keep-alive**：`closeIdleConnections()` 让 close() 立即 resolve（**远早于**兜底预算）；
 * 2. **活动长轮询**：`closeIdleConnections()` 对其无效 ⇒ **必须**由兜底 timer 触发
 *    `closeAllConnections()` 强断，close() 仍在预算内 resolve（验证兜底真的触发）；
 * 3. **幂等**：重复 close 不抛不挂（返回同一 Promise），close 后再次调用安全。
 *
 * 句柄纪律：全部用例不留未释放句柄（长轮询桩在连接断开时即 resolve；守护 transport 兜底 close），
 * `node --test` 须自然退出（本文件不设 `SESSION_DB`，从不触碰 store）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HTTP_CLOSE_GRACE_MS,
  startHttpTransport,
} from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import { RUNNER_CONNECT_PATH } from "../bridge/runner.js";
import type {
  RunnerEndpointHandle,
  RunnerOrphanSweepResult,
  RunnerSweepResult,
} from "../bridge/runner.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const transports: HttpTransportHandle[] = [];

after(async () => {
  for (const transport of transports) await transport.close();
});

/** 内核桩：本测试从不触达 MCP 面（仅 `/health` 与 `/runner/*` 桩），故所有方法一律抛错 */
function unused(name: string): never {
  throw new Error(`unused BridgeCore method: ${name}`);
}

function fakeCore(): BridgeCore {
  return {
    projects: async () => unused("projects"),
    tasks: async () => unused("tasks"),
    call: async () => unused("call"),
    registerFeatureNode: () => unused("registerFeatureNode"),
    taskStatus: async () => unused("taskStatus"),
    cancel: async () => unused("cancel"),
    events: () => unused("events"),
    wait: async () => unused("wait"),
    featureCreate: () => unused("featureCreate"),
    featureStatus: () => unused("featureStatus"),
    featureAdvance: () => unused("featureAdvance"),
    featureApprove: () => unused("featureApprove"),
    featureCancel: () => unused("featureCancel"),
    featureTrace: () => unused("featureTrace"),
    configWriteGroup: async () => unused("configWriteGroup"),
    kickScheduler: () => unused("kickScheduler"),
  };
}

async function openTransport(runner?: RunnerEndpointHandle): Promise<HttpTransportHandle> {
  const transport = await startHttpTransport({
    core: fakeCore(),
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    isReady: () => true,
    role: () => "owner",
    version: "test",
    onShutdown: () => {
      /* 测试不触发停机 */
    },
    ...(runner === undefined ? {} : { runner }),
  });
  transports.push(transport);
  return transport;
}

/**
 * 模拟活动长轮询的 Runner 端点桩：`/runner/connect` 收到即**不响应**（挂起），
 * 直到连接被断开（`closeAllConnections()` 强断时 `res` 触发 `close`）才返回 —— 与现实
 * `runner.ts#handleConnect` 的活动连接语义一致，且**不留计时器**（自然退出）。
 */
function hangingRunner(onHang: () => void): RunnerEndpointHandle {
  return {
    handle: (_req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
      if (path !== RUNNER_CONNECT_PATH) return Promise.resolve(false);
      onHang();
      return new Promise<boolean>((resolve) => {
        res.on("close", () => resolve(true));
      });
    },
    wake: () => {
      /* 无需唤醒 */
    },
    enqueueStop: () => {
      /* 无控制命令 */
    },
    enqueueCancelTask: () => {
      /* 无控制命令 */
    },
    pendingConnects: () => 1,
    pendingControls: () => 0,
    sweepStale: (): RunnerSweepResult => ({ offlineRunners: [], requeuedTasks: [] }),
    sweepOrphanedTasks: (): RunnerOrphanSweepResult => ({ orphanedTasks: [] }),
  };
}

/** 建一条**空闲的 keep-alive** 连接：发完整 `GET /health`、读完响应后保持 socket 不关 */
function openIdleKeepAlive(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1", () => {
      socket.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
    });
    let data = "";
    const onData = (chunk: Buffer): void => {
      data += chunk.toString("utf8");
      // `/health` 为小 JSON，响应头 + 体一并到达；见到体结束即视为**空闲**
      if (data.includes("}")) {
        socket.off("data", onData);
        resolve(socket);
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

/** close() 后端口应不再接受连接（ECONNREFUSED） */
function isPortRefused(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = netConnect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test("① 挂 keep-alive 空闲连接 ⇒ close() 在预算内 resolve 且端口释放", async () => {
  const transport = await openTransport();
  const socket = await openIdleKeepAlive(transport.port);
  assert.equal(socket.destroyed, false, "空闲连接应在 close 前保持打开（否则用例失去意义）");
  try {
    const startedAt = Date.now();
    await transport.close();
    const elapsed = Date.now() - startedAt;
    // closeIdleConnections() 使空闲连接即时收尾 ⇒ 不应等到兜底预算
    assert.ok(
      elapsed < HTTP_CLOSE_GRACE_MS,
      `空闲连接应即时收尾（< ${HTTP_CLOSE_GRACE_MS}ms），实际 ${elapsed}ms`,
    );
    assert.equal(await isPortRefused(transport.port), true, "close() 后端口应已释放");
  } finally {
    socket.destroy();
  }
});

test("② 挂活动 long-poll 连接 ⇒ close() 仍在预算内 resolve（兜底 closeAllConnections 触发）", async () => {
  let markHung: () => void = () => {
    /* 占位，紧随 Promise 构造赋值 */
  };
  const hung = new Promise<void>((resolve) => {
    markHung = resolve;
  });
  const transport = await openTransport(hangingRunner(markHung));

  const req = httpRequest({
    host: "127.0.0.1",
    port: transport.port,
    path: RUNNER_CONNECT_PATH,
    method: "POST",
    agent: false,
  });
  req.on("error", () => {
    /* 强断时客户端会收到 ECONNRESET，属预期 */
  });
  req.end();
  await hung; // 确保长轮询已真正挂起（活动连接），再触发 close

  try {
    const startedAt = Date.now();
    await transport.close();
    const elapsed = Date.now() - startedAt;
    // 活动连接无法被 closeIdleConnections 收尾 ⇒ close() 必经兜底 timer（≈预算）方 resolve
    assert.ok(
      elapsed >= HTTP_CLOSE_GRACE_MS - 50,
      `活动长轮询应触发兜底强断（须 ≥ 预算 ${HTTP_CLOSE_GRACE_MS}ms），实际 ${elapsed}ms`,
    );
    assert.ok(
      elapsed < HTTP_CLOSE_GRACE_MS + 3_000,
      `兜底后仍须有界 resolve（实际 ${elapsed}ms）`,
    );
    assert.equal(await isPortRefused(transport.port), true, "close() 后端口应已释放");
  } finally {
    req.destroy();
  }
});

test("③ 幂等：重复 close 不抛不挂（返回同一 Promise）", async () => {
  const transport = await openTransport();
  const first = transport.close();
  const second = transport.close();
  assert.equal(first, second, "重复 close 应返回同一 Promise（不重入 closeServer）");

  const startedAt = Date.now();
  await first;
  await transport.close(); // 已 settle 后再调用仍安全
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < HTTP_CLOSE_GRACE_MS, `无连接时 close() 应即时返回（实际 ${elapsed}ms）`);
  assert.equal(await isPortRefused(transport.port), true, "close() 后端口应已释放");
});
