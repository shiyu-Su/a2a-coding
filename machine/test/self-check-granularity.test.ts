/**
 * `machine/launcher/self-check.ts` 粒度改判 + F-e 提示修正单元测试
 * （REQ-v0.8.6-2026-09-21-02 · §2.4 裁决 ④⑤⑥ · 节点 N5）。
 *
 * 门禁判据：
 * - **粒度改判（⑤）**：单项目失败不再判负全机 —— `ok = 至少一项可服务` + 全量 `failures` 保留
 *   + `unavailable` 集；单项目解析失败 ⇒ 其余项目照常、结果 `ok=true`（对应 index.ts 不退出）。
 * - **机器级判据收敛（REQ-v0.8.6-2026-09-21-02 · 节点 B）**：index.ts 机器级 `exit(1)` **只保留
 *   `allUnavailable`**（全部项目不可用）；`fatalEnsureFault`（ensure 阶段 cause≠backend-entry）已删除
 *   —— 单项目 ensure 故障（含「包装器进程提前退出」）一律项目级，机器继续服务其余。
 * - **F-e（⑥）**：`hintFor` 先按 `cause` 分流、kind 文案兜底 —— 模型名非法 ⇒ 提示指向模型/参数，
 *   不再落到「检查认证」；`backend-entry` cause ⇒ 指向分层清单。
 *
 * 用真实本机 HTTP 服务充当 A2A 端点（Message 直返=通过；failed Task=校验失败），不引新依赖。
 * 运行：`npm run build && node --test dist/test/self-check-granularity.test.js`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AgentManager } from "../launcher/manager.js";
import {
  runStartupSelfCheck,
  classifySelfCheckCause,
  hintFor,
} from "../launcher/self-check.js";
import type { MachineConfig } from "../types.js";

/** 适配器四层解析未命中时抛出的错误文案（与 claude.ts CLAUDE_BACKEND_CMD_REQUIRED 同形，取判别子串即可） */
const BACKEND_ENTRY_MSG =
  "未能解析到 claude 的 ACP 后端入口：L0/L1/L2/L3 均未命中——请安装该适配器、设 NPM_CONFIG_PREFIX，或显式配置 agentConfig.backendCmd；清单见 launcher.log [backend] 行";

/** 起一个最小 A2A JSON-RPC 端点：mode=ok → Message 直返（视为 completed）；mode=model-fail → failed Task（含模型非法文本） */
function startRpcServer(mode: "ok" | "model-fail"): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    const result =
      mode === "ok"
        ? { role: "agent", parts: [{ kind: "text", text: "OK" }], messageId: "m-1" }
        : {
            id: "task-model-1",
            status: {
              state: "failed",
              message: {
                role: "agent",
                parts: [
                  {
                    kind: "text",
                    text: "invalid_request_error: model gpt-9999-not-exist is not supported (code -32602 invalid params)",
                  },
                ],
              },
            },
          };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: "rpc-1", result }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("无法解析监听端口");
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** 自检只用 ensure / stop / inFlight 三面；按 projectId 定制 ensure 抛错（缺省文案=后端入口未解析，可指定自定义 reason） */
function makeFakeManager(
  endpoint: string,
  throwing: ReadonlySet<string> | ReadonlyMap<string, string>,
): AgentManager {
  const reasonFor = (projectId: string): string | undefined => {
    if (throwing instanceof Map) return throwing.get(projectId);
    return throwing.has(projectId) ? BACKEND_ENTRY_MSG : undefined;
  };
  const fake = {
    inFlight: {
      size: 0,
      add: (): void => {},
      remove: (): boolean => true,
      has: (): boolean => false,
    },
    ensure: async (projectId: string): Promise<{ projectId: string; endpoint: string; started: boolean }> => {
      const reason = reasonFor(projectId);
      if (reason !== undefined) {
        // 模拟适配器 buildLaunch / 包装器拉起阶段抛出（ensure 阶段）
        throw new Error(reason);
      }
      return { projectId, endpoint, started: true };
    },
    stop: async (projectId: string): Promise<{ projectId: string; stopped: boolean }> => ({
      projectId,
      stopped: true,
    }),
  };
  return fake as unknown as AgentManager;
}

/**
 * index.ts 机器级退出判据的镜像断言（REQ-v0.8.6-2026-09-21-02 收敛后唯一判据 = allUnavailable）。
 * index.ts 是带启动副作用的入口不可 import，故此处按同式重算：
 * `unavailable.length >= total > 0` ⇒ 机器级（closeServer → shutdown → removePidfile → exit(1)）。
 */
function assertMachineLevelExit(result: { unavailable: unknown[] }, total: number, expected: boolean): void {
  const allUnavailable = total > 0 && result.unavailable.length >= total;
  assert.equal(
    allUnavailable,
    expected,
    `机器级退出判据（allUnavailable）应为 ${expected}（unavailable=${result.unavailable.length}/${total}）`,
  );
}

test("§2.4-⑤ 粒度改判：单项目后端入口解析失败 ⇒ 其余项目照常、结果 ok=true（机器不退出）", async () => {
  const { server, port } = await startRpcServer("ok");
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const manager = makeFakeManager(endpoint, new Set(["entry-bad"]));
    const machine: MachineConfig = {
      machineId: "m-gran",
      launcher: { port: 0, startupCheckPrompt: "OK", startupCheckTimeoutMs: 5_000 },
      projects: [
        { projectId: "entry-bad", workspace: "C:/ws/entry-bad", agentKind: "claude", a2aPort: port },
        { projectId: "good", workspace: "C:/ws/good", agentKind: "opencode", a2aPort: port },
      ],
    };

    const result = await runStartupSelfCheck(manager, machine);

    // 至少一项可服务 ⇒ ok=true（旧口径下 failures.length!==0 会判 false → 全机退出）
    assert.equal(result.ok, true, "单项目失败时机器仍应判可服务（ok=true）");
    // 全量 failures 保留
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.projectId, "entry-bad");
    assert.equal(result.failures[0]?.stage, "ensure");
    assert.equal(result.failures[0]?.cause, "backend-entry");
    // 新增不可用项目集：仅 entry-bad；good 不在其中
    assert.deepEqual(
      result.unavailable.map((f) => f.projectId),
      ["entry-bad"],
    );
    assert.equal(
      result.unavailable.some((f) => f.projectId === "good"),
      false,
      "good 项目通过自检，不得进不可用集",
    );
  } finally {
    await closeServer(server);
  }
});

test("§2.4-⑤ 粒度改判：全部项目失败 ⇒ ok=false（机器级故障仍判负）", async () => {
  const { server, port } = await startRpcServer("ok");
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const manager = makeFakeManager(endpoint, new Set(["a", "b"]));
    const machine: MachineConfig = {
      machineId: "m-all-bad",
      launcher: { port: 0, startupCheckPrompt: "OK", startupCheckTimeoutMs: 5_000 },
      projects: [
        { projectId: "a", workspace: "C:/ws/a", agentKind: "claude", a2aPort: port },
        { projectId: "b", workspace: "C:/ws/b", agentKind: "codex", a2aPort: port },
      ],
    };

    const result = await runStartupSelfCheck(manager, machine);

    assert.equal(result.ok, false, "全部项目不可用时机器级故障应判负（ok=false）");
    assert.equal(result.unavailable.length, 2);
    assertMachineLevelExit(result, 2, true);
  } finally {
    await closeServer(server);
  }
});

test("REQ-v0.8.6 节点 B①：单项目 ensure「包装器进程提前退出」⇒ 项目级不可用、ok=true、机器不退出（真机 7/8 现场回归锚）", async () => {
  const { server, port } = await startRpcServer("ok");
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    // 真机 2026-09-22 现场：7 个项目自检通过，1 个在 ensure 阶段包装器进程提前退出（code=1）
    // —— 旧 fatalEnsureFault 判成机器级致整机 exit(1)；收敛后一律项目级。
    const manager = makeFakeManager(endpoint, new Map([["exit-early", "包装器进程提前退出（code=1, signal=null）"]]));
    const machine: MachineConfig = {
      machineId: "m-node-b",
      launcher: { port: 0, startupCheckPrompt: "OK", startupCheckTimeoutMs: 5_000 },
      projects: [
        { projectId: "exit-early", workspace: "C:/ws/exit-early", agentKind: "claude", a2aPort: port },
        { projectId: "good-1", workspace: "C:/ws/good-1", agentKind: "opencode", a2aPort: port },
        { projectId: "good-2", workspace: "C:/ws/good-2", agentKind: "codex", a2aPort: port },
      ],
    };

    const result = await runStartupSelfCheck(manager, machine);

    assert.equal(result.ok, true, "单项目 ensure 提前退出不得判负全机（ok=true）");
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.projectId, "exit-early");
    assert.equal(result.failures[0]?.stage, "ensure");
    assert.equal(result.failures[0]?.cause, undefined, "端口/进程类故障 cause 仍为 undefined（文案用途不变）");
    assert.match(result.failures[0]?.hint ?? "", /a2aPort|端口/, "ensure 文案提示仍指向 workspace/端口检查");
    assert.deepEqual(result.unavailable.map((f) => f.projectId), ["exit-early"]);
    // 机器级判据只剩 allUnavailable：1/3 不可用 ⇒ 不退出，逐项登记后继续服务其余
    assertMachineLevelExit(result, 3, false);
  } finally {
    await closeServer(server);
  }
});

test("REQ-v0.8.6 节点 B②：全部项目 ensure 端口/进程类故障 ⇒ cause 不再参与判据、但 allUnavailable 命中 ⇒ 仍机器级退出", async () => {
  const { server, port } = await startRpcServer("ok");
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const manager = makeFakeManager(endpoint, new Map([
      ["a", "listen EADDRINUSE 127.0.0.1:8787 端口被占用"],
      ["b", "包装器进程提前退出（code=1, signal=null）"],
    ]));
    const machine: MachineConfig = {
      machineId: "m-node-b-all",
      launcher: { port: 0, startupCheckPrompt: "OK", startupCheckTimeoutMs: 5_000 },
      projects: [
        { projectId: "a", workspace: "C:/ws/a", agentKind: "claude", a2aPort: port },
        { projectId: "b", workspace: "C:/ws/b", agentKind: "codex", a2aPort: port },
      ],
    };

    const result = await runStartupSelfCheck(manager, machine);

    assert.equal(result.ok, false);
    assert.equal(result.failures[0]?.cause, undefined, "全部为端口/进程类 cause（旧判据下 fatalEnsureFault 命中）");
    assertMachineLevelExit(result, 2, true); // allUnavailable 保留机器级退出路径
  } finally {
    await closeServer(server);
  }
});

test("REQ-v0.8.6 节点 B③：部分可用（混合失败原因）⇒ ok=true 且非机器级（既有语义不变）", async () => {
  const { server, port } = await startRpcServer("ok");
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const manager = makeFakeManager(endpoint, new Set(["entry-bad"]));
    const machine: MachineConfig = {
      machineId: "m-node-b-partial",
      launcher: { port: 0, startupCheckPrompt: "OK", startupCheckTimeoutMs: 5_000 },
      projects: [
        { projectId: "entry-bad", workspace: "C:/ws/entry-bad", agentKind: "claude", a2aPort: port },
        { projectId: "good", workspace: "C:/ws/good", agentKind: "opencode", a2aPort: port },
      ],
    };

    const result = await runStartupSelfCheck(manager, machine);

    assert.equal(result.ok, true);
    assert.equal(result.unavailable.length, 1);
    assertMachineLevelExit(result, 2, false);
  } finally {
    await closeServer(server);
  }
});

test("§2.4-⑥ F-e 集成：模型名非法 ⇒ cause=model、提示指向模型/参数而非认证", async () => {
  const { server, port } = await startRpcServer("model-fail");
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const manager = makeFakeManager(endpoint, new Set());
    const machine: MachineConfig = {
      machineId: "m-fe",
      launcher: { port: 0, startupCheckPrompt: "OK", startupCheckTimeoutMs: 5_000 },
      // 用 qoder-cn 作对照：旧 hintFor 对 qoder-cn 一律给「检查 qodercn 认证」；F-e 后应按 cause 分流
      projects: [
        { projectId: "model-bad", workspace: "C:/ws/model-bad", agentKind: "qoder-cn", a2aPort: port },
      ],
    };

    const result = await runStartupSelfCheck(manager, machine);

    const failure = result.failures[0];
    assert.ok(failure, "应产出一条失败");
    assert.equal(failure?.stage, "settle");
    assert.equal(failure?.cause, "model", "模型名非法应分类为 cause=model");
    assert.ok(failure?.hint, "失败项应带修复提示");
    assert.match(failure?.hint ?? "", /模型/, "提示须指向模型");
    assert.doesNotMatch(failure?.hint ?? "", /认证|qodercn|QODERCN/, "提示不得再落到认证类文案");
  } finally {
    await closeServer(server);
  }
});

test("§2.4-⑥ F-e 单元：classifySelfCheckCause 分流 + hintFor 先按 cause、kind 兜底", () => {
  // backend-entry（四 kind 文案统一含「ACP 后端入口」+「[backend] 行」）
  assert.equal(classifySelfCheckCause(BACKEND_ENTRY_MSG), "backend-entry");
  // model（模型名非法 / -32602 无效参数）
  assert.equal(classifySelfCheckCause("invalid model gpt-9999 (code -32602 invalid params)"), "model");
  assert.equal(classifySelfCheckCause("模型名不存在"), "model");
  // 端口/进程类 → undefined（仅交 ensure 文案；机器级判据已收敛为 allUnavailable，cause 不再参与）
  assert.equal(classifySelfCheckCause("listen EADDRINUSE 127.0.0.1:8787 端口被占用"), undefined);
  assert.equal(classifySelfCheckCause("包装器进程提前退出（code=1, signal=null）"), undefined);
  // auth
  assert.equal(classifySelfCheckCause("missing OPENAI_API_KEY, unauthorized"), "auth");

  // hintFor 先按 cause 分流：同一 kind 下不同 cause 得不同提示
  assert.match(hintFor("qoder-cn", "settle", "model"), /模型/);
  assert.doesNotMatch(hintFor("qoder-cn", "settle", "model"), /认证|qodercn|QODERCN/);
  assert.match(hintFor("qoder-cn", "settle", "auth"), /认证/);
  assert.match(hintFor("claude", "settle", "timeout"), /超时/);
  assert.match(hintFor("codex", "ensure", "backend-entry"), /分层清单|后端入口|backend/i);
  assert.match(hintFor("codex", "ensure", "backend-entry"), /NPM_CONFIG_PREFIX|agentConfig.backendCmd/);
  // cause 缺省 → kind 文案兜底（qoder-cn 仍给认证指引，证明是 cause 驱动了 F-e 修正）
  assert.match(hintFor("qoder-cn", "settle", undefined), /认证|qodercn|QODERCN/i);
});
