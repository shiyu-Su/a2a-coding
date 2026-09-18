/**
 * `machine/launcher/self-check.ts` 在飞台账保护单元测试（v0.7.0 · 节点 M5·MC1）。
 *
 * 门禁判据：
 * - 自检经 `manager.ensure` 本地复通（`ensure → A2A message/send → 终态校验`），`ok=true`；
 * - 自检任务**全程计入 in-flight 台账**（add ⇒ remove），使 idleStop 判据在自检期间不成立；
 * - 旧 `LEASE_RENEW` 周期 re-ensure 续约 hack 已删除（`ensure` 全程恰一次 + 源码断言）。
 *
 * 用真实本机 HTTP 服务充当 A2A 端点（Message 直返即视为 completed），不引新依赖。
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AgentManager } from "../launcher/manager.js";
import { runStartupSelfCheck } from "../launcher/self-check.js";
import type { MachineConfig } from "../types.js";

/** 台账调用轨迹（断言 add/remove 顺序与 taskId） */
interface LedgerEvent {
  kind: "add" | "remove";
  taskId: string;
}

/** 结构化假管理器（自检只用到 ensure / stop / inFlight 三面） */
function makeFakeManager(
  endpoint: string,
  events: LedgerEvent[],
  ensureCalls: { count: number },
): AgentManager {
  let size = 0;
  const fake = {
    inFlight: {
      get size(): number {
        return size;
      },
      add: (entry: { taskId: string }): void => {
        size += 1;
        events.push({ kind: "add", taskId: entry.taskId });
      },
      remove: (taskId: string): boolean => {
        if (size > 0) size -= 1;
        events.push({ kind: "remove", taskId });
        return true;
      },
      has: (): boolean => false,
    },
    ensure: async (projectId: string): Promise<{ projectId: string; endpoint: string; started: boolean }> => {
      ensureCalls.count += 1;
      return { projectId, endpoint, started: true };
    },
    stop: async (projectId: string): Promise<{ projectId: string; stopped: boolean }> => ({
      projectId,
      stopped: true,
    }),
  };
  return fake as unknown as AgentManager;
}

/** 起一个最小 A2A JSON-RPC 端点：对任何请求都返回「Message 直返（completed、文本 OK）」 */
function startRpcServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-1",
        // 无顶层 id = Message 直返（非 Task），self-check 视为已完成
        result: { role: "agent", parts: [{ kind: "text", text: "OK" }], messageId: "m-1" },
      }),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("无法解析监听端口");
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

test("自检经 manager.ensure 本地复通：任务计入 in-flight 台账、结束释放、ensure 恰一次", async () => {
  const { server, port } = await startRpcServer();
  try {
    const events: LedgerEvent[] = [];
    const ensureCalls = { count: 0 };
    const manager = makeFakeManager(`http://127.0.0.1:${port}`, events, ensureCalls);
    const machine: MachineConfig = {
      machineId: "m-selfcheck",
      launcher: { port: 0, startupCheckPrompt: "OK", startupCheckTimeoutMs: 5_000 },
      projects: [
        { projectId: "alpha", workspace: "C:/ws/alpha", agentKind: "opencode", a2aPort: port },
      ],
    };

    const result = await runStartupSelfCheck(manager, machine);

    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    // 旧 LEASE_RENEW 会周期 re-ensure；新实现只 ensure 一次（经 ensure 本地复通）
    assert.equal(ensureCalls.count, 1);
    assert.deepEqual(events, [
      { kind: "add", taskId: "self-check:alpha" },
      { kind: "remove", taskId: "self-check:alpha" },
    ]);
  } finally {
    await closeServer(server);
  }
});

test("self-check 不再含 LEASE_RENEW 周期续约 hack（源码断言）", () => {
  const source = readFileSync(new URL("../../launcher/self-check.ts", import.meta.url), "utf8");
  assert.equal(source.includes("LEASE_RENEW"), false);
  assert.equal(source.includes("setInterval"), false);
});
