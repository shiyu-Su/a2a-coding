/**
 * 未知 agentKind 被拒用例（v0.8.0 · N6；REQ-v0.8.0-2026-09-18-01，改造文档 §2.2 / §4.1-6）。
 *
 * 覆盖 4 条此前零覆盖的拒绝分支：
 * 1. **注册整包拒**：`orch/bridge/runner.ts#parseProjects` 对未知 agentKind fail-fast **拒整包**
 *    （400 `bad_request`），拒绝文案含由 `AGENT_KINDS.join(" / ")` 派生的可选值（N3 已派生化）；
 * 2. **写口拒**：`SessionStore.runnerProjectsReplace` 对未知 agentKind 抛（数据损坏守卫的写侧）；
 * 3/4. **读回脏值守卫**：`rowToSession`（`sessions.agent_kind`）/ `rowToRunnerProject`
 *    （`runner_projects.agent_kind`）对库中脏值 fail-fast，不外泄非法值。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 须在首次触碰默认存储单例之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  close as closeStore,
  listRunnerProjects,
  openStoreDatabase,
  SessionStore,
} from "../session/store.js";
import type { RunnerProjectInput } from "../session/store.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import { RUNNER_REGISTER_PATH, createRunnerEndpoints } from "../bridge/runner.js";
import type { BridgeCore } from "../bridge/index.js";
import { AGENT_KINDS } from "../types.js";
import type { AgentKind, MachinesConfig } from "../types.js";

const transports: HttpTransportHandle[] = [];

after(async () => {
  for (const transport of transports) await transport.close();
  closeStore();
});

// ---------------------------------------------------------------------------
// HTTP 脚手架（仅 `/runner/register`；与 runner-endpoints.test.ts 同形）
// ---------------------------------------------------------------------------

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
    kickScheduler: () => unused("kickScheduler"),
  };
}

function makeConfig(machineId: string, token: string): MachinesConfig {
  return {
    machines: [{ machineId, launcherUrl: "", token }],
    transport: { mode: "http", http: { host: "127.0.0.1", port: 0, path: "/mcp" } },
    web: { enabled: false, host: "127.0.0.1", port: 0 },
    runner: { holdMs: 60, heartbeatTimeoutMs: 60_000, orphanTimeoutMs: 1_800_000 },
  };
}

async function startHarness(machineId: string, token: string): Promise<number> {
  const cfg = makeConfig(machineId, token);
  const handle = createRunnerEndpoints({ role: () => "owner", config: () => cfg });
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
    runner: handle,
  });
  transports.push(transport);
  return transport.port;
}

interface Envelope {
  result?: unknown;
  data?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

async function postRegister(
  port: number,
  token: string,
  payload: unknown,
): Promise<{ status: number; body: Envelope }> {
  const res = await fetch(`http://127.0.0.1:${port}${RUNNER_REGISTER_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: Envelope = {};
  try {
    body = JSON.parse(text) as Envelope;
  } catch {
    /* 本用例不会出现非 JSON 体 */
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// 1. 注册整包拒（orch/bridge/runner.ts#parseProjects）
// ---------------------------------------------------------------------------

test("未知 agentKind：注册 fail-fast 拒整包（400 bad_request），同包合法项不落库；文案由 AGENT_KINDS 派生", async () => {
  const port = await startHarness("m-n6", "tok-n6");

  const rejected = await postRegister(port, "tok-n6", {
    machineId: "m-n6",
    protocolVersion: "2.0",
    projects: [
      { projectId: "p-ok", agentKind: "opencode", a2aPort: 4001 },
      { projectId: "p-bad", agentKind: "dsh", a2aPort: 4002 },
    ],
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error?.code, "bad_request");
  // 文案整串断言：证明「可选值」由 AGENT_KINDS.join(" / ") 派生（而非硬编码回退）
  assert.equal(
    String(rejected.body.error?.message),
    `projects[1].agentKind 非法（可选 ${AGENT_KINDS.join(" / ")}）`,
  );
  // 拒整包：同包内合法的 p-ok 也不得写入投影
  assert.deepEqual(listRunnerProjects("m-n6").map((p) => p.projectId), []);

  // 正向对照：清一色合法注册 ⇒ 200 且投影落库（证明上段空投影来自拒绝，而非存储未共享）
  const ok = await postRegister(port, "tok-n6", {
    machineId: "m-n6",
    protocolVersion: "2.0",
    projects: [{ projectId: "p-ok", agentKind: "opencode", a2aPort: 4001 }],
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(listRunnerProjects("m-n6").map((p) => p.projectId), ["p-ok"]);
});

// ---------------------------------------------------------------------------
// 1b. req03 硬切：旧值 qoder 不再合法 / 新值 qoder-cn 合法（无别名、无归一）
// ---------------------------------------------------------------------------

test("硬切负向：agentKind=qoder（旧值）注册 ⇒ 400 bad_request 整包拒、同包合法项不落库、文案含新值清单", async () => {
  const port = await startHarness("m-qoder-cut", "tok-qoder-cut");

  const rejected = await postRegister(port, "tok-qoder-cut", {
    machineId: "m-qoder-cut",
    protocolVersion: "2.0",
    projects: [
      { projectId: "p-ok", agentKind: "qoder-cn", a2aPort: 4001 },
      { projectId: "p-old", agentKind: "qoder", a2aPort: 4002 },
    ],
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error?.code, "bad_request");
  // 文案整串断言：证明「可选值」由改名后的 AGENT_KINDS.join(" / ") 派生（含 qoder-cn、不含旧值）
  assert.equal(
    String(rejected.body.error?.message),
    `projects[1].agentKind 非法（可选 ${AGENT_KINDS.join(" / ")}）`,
  );
  // 整包拒：旧值 qoder 不合法 ⇒ 同包内合法的 p-ok 也不得写入投影
  assert.deepEqual(listRunnerProjects("m-qoder-cut").map((p) => p.projectId), []);
});

test("硬切正向：agentKind=qoder-cn（新值）注册 ⇒ 200 且投影落库", async () => {
  const port = await startHarness("m-qoder-cn", "tok-qoder-cn");

  const ok = await postRegister(port, "tok-qoder-cn", {
    machineId: "m-qoder-cn",
    protocolVersion: "2.0",
    projects: [{ projectId: "p-cn", agentKind: "qoder-cn", a2aPort: 4001 }],
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(listRunnerProjects("m-qoder-cn").map((p) => p.projectId), ["p-cn"]);
});

// ---------------------------------------------------------------------------
// 2. 写口拒（SessionStore.runnerProjectsReplace）
// ---------------------------------------------------------------------------

test("未知 agentKind：写口 runnerProjectsReplace fail-fast 拒写、零落库", () => {
  const store = new SessionStore(":memory:");
  try {
    const badKind: string = "dsh";
    const bad: RunnerProjectInput = {
      projectId: "p1",
      agentKind: badKind as AgentKind,
      a2aPort: 4001,
      status: "online",
    };
    assert.throws(
      () => store.runnerProjectsReplace("r-bad", [bad]),
      /\[session-store\] runnerProjectsReplace 非法 agentKind：dsh/,
    );
    assert.deepEqual(store.listRunnerProjects("r-bad"), []);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 3/4. 读回脏值守卫（绕过写侧，直接向库注入非法 agent_kind 后读取即拒）
// ---------------------------------------------------------------------------

function tempDbPath(tag: string): string {
  return join(tmpdir(), `a2a-${tag}-${process.pid}-${Date.now()}.sqlite`);
}

function cleanupDb(dbPath: string): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

test("未知 agentKind：读回脏值守卫 sessions.agent_kind（getSession 即抛，不外泄非法值）", () => {
  const dbPath = tempDbPath("n6-session-dirty");
  try {
    const store = new SessionStore(dbPath);
    store.upsertSession({
      projectId: "p1",
      contextId: "c1",
      sessionId: "s1",
      agentKind: "opencode",
    });
    store.close();

    // 绕过写侧守卫，直接向库注入脏值（模拟历史脚本 / 手工改库）
    const raw = openStoreDatabase(dbPath);
    try {
      raw
        .prepare("UPDATE sessions SET agent_kind = ? WHERE project_id = ? AND context_id = ?")
        .run("dsh", "p1", "c1");
    } finally {
      raw.close();
    }

    const reopened = new SessionStore(dbPath);
    try {
      assert.throws(
        () => reopened.getSession("p1", "c1"),
        /\[session-store\] 列 agent_kind 数据损坏：非法值 dsh/,
      );
    } finally {
      reopened.close();
    }
  } finally {
    cleanupDb(dbPath);
  }
});

test("未知 agentKind：读回脏值守卫 runner_projects.agent_kind（listRunnerProjects 即抛）", () => {
  const dbPath = tempDbPath("n6-runner-proj-dirty");
  try {
    const store = new SessionStore(dbPath);
    store.runnerProjectsReplace("r1", [
      { projectId: "p1", agentKind: "opencode", a2aPort: 4001, status: "online" },
    ]);
    store.close();

    const raw = openStoreDatabase(dbPath);
    try {
      raw.prepare("UPDATE runner_projects SET agent_kind = ? WHERE runner_id = ?").run("dsh", "r1");
    } finally {
      raw.close();
    }

    const reopened = new SessionStore(dbPath);
    try {
      assert.throws(
        () => reopened.listRunnerProjects("r1"),
        /\[session-store\] 列 agent_kind 数据损坏：非法值 dsh/,
      );
    } finally {
      reopened.close();
    }
  } finally {
    cleanupDb(dbPath);
  }
});
