/**
 * 启动自检的职责位口径单元测试（v0.10.2 · M-4 · 改造文档 §4 验收判据 7）。
 *
 * 门禁判据：
 * - **真跑恒 1 条 / 项目**，出场身份 = `unit_agent`（`SELF_CHECK_TASK_TYPE`）⇒
 *   给项目配满四个职责位，落到 A2A 端点的 `message/send` 请求数**不随之增长**
 *   （本节点验收「自检墙钟不因职责位数增长」的机械替身：派发条数 = 项目数 × 1）；
 * - **其它职责位只做配置级校验**（不派发、不拉起）：`rolesConfigCheck` 纯函数可独立断言，
 *   自检日志面须逐位有产出；
 * - 配置级校验与加载期**同一判据**（`agent-roles.ts`），不长出第二套。
 *
 * 用真实本机 HTTP 服务充当 A2A 端点（Message 直返 = completed），不引新依赖。
 * 运行：`npm run build && node --test dist/test/self-check-roles.test.js`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AgentManager } from "../launcher/manager.js";
import {
  runStartupSelfCheck,
  rolesConfigCheck,
  SELF_CHECK_TASK_TYPE,
} from "../launcher/self-check.js";
import type { MachineConfig, ProjectConfig } from "../types.js";
import { TASK_TYPES } from "../task-types.js";

/** 结构化假管理器（自检只用到 ensure / stop / inFlight 三面） */
function makeFakeManager(endpoint: string, counts: { ensure: number; stop: number }): AgentManager {
  let size = 0;
  const fake = {
    inFlight: {
      get size(): number {
        return size;
      },
      add: (): void => {
        size += 1;
      },
      remove: (): boolean => {
        if (size > 0) size -= 1;
        return true;
      },
      has: (): boolean => false,
    },
    ensure: async (projectId: string) => {
      counts.ensure += 1;
      return { projectId, endpoint, started: true };
    },
    stop: async (projectId: string) => {
      counts.stop += 1;
      return { projectId, stopped: true };
    },
  };
  return fake as unknown as AgentManager;
}

/** 最小 A2A 端点：任何请求都回「Message 直返」，并累计请求数（= 真跑条数的量度） */
function startRpcServer(counts: { sends: number }): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    counts.sends += 1;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-1",
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

/** 四个职责位全配（risk 一律 read ⇒ 不撞「不得高于项目生效 write」那条） */
const FOUR_ROLES: Record<string, unknown> = {
  unit_agent: { model: "flat/unit" },
  product_manager: { model: "pm/x", systemPrompt: "接不接？", systemPromptMode: "append" },
  project_manager: { model: "project_manager/x", risk: "read" },
  dev_manager: { model: "dev/x", risk: "read" },
};

function project(agentConfig: Record<string, unknown> | undefined): ProjectConfig {
  return {
    projectId: "alpha",
    workspace: "C:/ws/alpha",
    agentKind: "opencode",
    a2aPort: 0,
    ...(agentConfig === undefined ? {} : { agentConfig }),
  };
}

function machineOf(projects: ProjectConfig[]): MachineConfig {
  return {
    machineId: "m-roles",
    launcher: { port: 0, startupCheckPrompt: "OK", startupCheckTimeoutMs: 5_000 },
    projects,
  };
}

/** 抓 self-check 期间的 console 输出（配置级校验「有产出」的判据面） */
function captureLogs(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return run()
    .then(
      () => lines,
      () => lines,
    )
    .finally(() => {
      console.log = log;
      console.error = error;
    });
}

// ---- 真跑条数与职责位数无关 ----

test("真跑恒 1 条：项目配满四个职责位 ⇒ message/send 仍恰 1 次、ensure 恰 1 次", async () => {
  const counts = { sends: 0, ensure: 0, stop: 0 };
  const { server, port } = await startRpcServer(counts);
  try {
    const manager = makeFakeManager(`http://127.0.0.1:${port}`, counts);
    const withRoles = project({ model: "flat/model", roles: FOUR_ROLES });
    const result = await runStartupSelfCheck(manager, machineOf([withRoles]));

    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.deepEqual(result.failures, []);
    assert.equal(counts.sends, 1, "四个职责位 ⇒ 真跑仍是 1 条（其余位只走配置级校验）");
    assert.equal(counts.ensure, 1);
    assert.equal(counts.stop, 1);
  } finally {
    await closeServer(server);
  }
});

test("墙钟判据：真跑条数 = 项目数 × 1（两项目 × 四职责位 ⇒ 恰 2 条，不乘角色数）", async () => {
  const counts = { sends: 0, ensure: 0, stop: 0 };
  const { server, port } = await startRpcServer(counts);
  try {
    const manager = makeFakeManager(`http://127.0.0.1:${port}`, counts);
    const a = { ...project({ roles: FOUR_ROLES }), projectId: "a" };
    const b = { ...project({ roles: FOUR_ROLES }), projectId: "b" };
    const result = await runStartupSelfCheck(manager, machineOf([a, b]));

    assert.equal(result.ok, true);
    assert.equal(counts.sends, 2, "2 项目 × 1 条 = 2，绝不等于 2 × 4 角色");
    assert.equal(counts.ensure, 2);
  } finally {
    await closeServer(server);
  }
});

test("未配 roles 的项目 ⇒ 自检形状逐字不变（1 条真跑、无职责位播报）", async () => {
  const counts = { sends: 0, ensure: 0, stop: 0 };
  const { server, port } = await startRpcServer(counts);
  try {
    const manager = makeFakeManager(`http://127.0.0.1:${port}`, counts);
    const lines = await captureLogs(() =>
      runStartupSelfCheck(manager, machineOf([project(undefined)])).then(() => undefined),
    );
    assert.equal(counts.sends, 1);
    // 配置级校验对「未配」也出一行（逐字现状的可见凭据），但不新增任何派发
    assert.ok(
      lines.some((l) => l.includes("未配 roles ⇒ 全部职责位逐字现状")),
      `自检日志应有职责位配置级一行：${lines.join(" / ")}`,
    );
  } finally {
    await closeServer(server);
  }
});

test("配置级校验有产出：四角色全配 ⇒ 自检日志逐位列出（零派发）", async () => {
  const counts = { sends: 0, ensure: 0, stop: 0 };
  const { server, port } = await startRpcServer(counts);
  try {
    const manager = makeFakeManager(`http://127.0.0.1:${port}`, counts);
    const lines = await captureLogs(() =>
      runStartupSelfCheck(manager, machineOf([project({ roles: FOUR_ROLES })])).then(
        () => undefined,
      ),
    );
    for (const taskType of TASK_TYPES) {
      assert.ok(
        lines.some((l) => l.includes(taskType)),
        `日志须覆盖职责位 ${taskType}：${lines.join(" / ")}`,
      );
    }
    assert.equal(counts.sends, 1);
    assert.equal(
      lines.some((l) => l.includes("校验不过")),
      false,
    );
  } finally {
    await closeServer(server);
  }
});

// ---- 纯函数面：与加载期同一判据 ----

test("SELF_CHECK_TASK_TYPE = unit_agent（真跑那条的出场身份，闭集成员）", () => {
  assert.equal(SELF_CHECK_TASK_TYPE, "unit_agent");
  assert.ok((TASK_TYPES as readonly string[]).includes(SELF_CHECK_TASK_TYPE));
});

test("rolesConfigCheck：未配 ⇒ configured=false、零错误", () => {
  const check = rolesConfigCheck(project({ model: "flat/model" }));
  assert.equal(check.configured, false);
  assert.deepEqual(check.roles, []);
  assert.deepEqual(check.errors, []);
});

test("rolesConfigCheck：四角色全配且合规 ⇒ 逐位可见、零错误", () => {
  const check = rolesConfigCheck(project({ roles: FOUR_ROLES }));
  assert.equal(check.configured, true);
  assert.deepEqual(check.roles, [...TASK_TYPES]);
  assert.deepEqual(check.errors, []);
});

test("rolesConfigCheck：绕过加载期的坏配置 ⇒ 与 config.ts 同一判据报错（①②③各一枚）", () => {
  const bad = project({
    roles: { pm: { model: "x" }, project_manager: { risk: "full" }, dev_manager: { modle: "x" } },
  });
  const check = rolesConfigCheck(bad);
  assert.equal(check.errors.length, 3, JSON.stringify(check.errors));
  assert.match(check.errors.join("\n"), /不是合法职责位/);
  assert.match(check.errors.join("\n"), /高于本项目生效 risk/);
  assert.match(check.errors.join("\n"), /未知键/);
});

test("rolesConfigCheck：上限取本机生效 risk（项目 full ⇒ 角色 full 放行）", () => {
  const fullProject: ProjectConfig = {
    ...project({ roles: { project_manager: { risk: "full" } } }),
    risk: "full",
  };
  assert.deepEqual(rolesConfigCheck(fullProject).errors, []);
  const writeProject: ProjectConfig = {
    ...project({ roles: { project_manager: { risk: "full" } } }),
    risk: "write",
  };
  assert.notDeepEqual(rolesConfigCheck(writeProject).errors, []);
});
