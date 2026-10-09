/**
 * v0.10.0 O6（REQ-v0.10.0-2026-09-24-01 · 改造文档 §2.1(6)）——
 * **接收注册载荷 `projects[].repo`（可选），消费落四处**：
 * `parseProjects` · `RunnerProjectInput` · `runner_projects` DDL + try-ALTER · `runnerProjectsReplace`。
 *
 * 锁定：
 * 1. **可选、可忽略**：缺省 ⇒ `null`；**非字符串 ⇒ 归一 `null`**（宽容解析，**不 400**）——
 *    这正是 `PROTOCOL.md` 判据式「可被对端完全忽略且不影响任何判定 / 消费语义 ⇒ 不升版」的载荷依据；
 * 2. **原值透传不归一**：`repo` 作为稳定仓标识原样落投影列（不 trim、不折叠大小写）；
 * 3. **不动载荷顶层（红线）**：`repo` 落 `projects[]` 项内，注册事件载荷仍只含项目 id（不因新字段扩面）；
 * 4. **老库补列**：迁移前 `runner_projects` 无 `repo` 列 ⇒ ctor `try-ALTER` 补列（缺省 NULL、幂等）；
 * 5. **协议常量保持 2.3**（不升版）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionStore,
  close as closeStore,
  listRunnerProjects,
  openStoreDatabase,
  runnerProjectsReplace,
} from "../session/store.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import {
  RUNNER_EVENT_REGISTERED,
  RUNNER_REGISTER_PATH,
  createRunnerEndpoints,
} from "../bridge/runner.js";
import { listEvents } from "../session/store.js";
import type { BridgeCore } from "../bridge/index.js";
import type { MachineRef, MachinesConfig } from "../types.js";

// ---------------------------------------------------------------------------
// 脚手架（同 `runner-endpoints.test.ts` 的最小口径）
// ---------------------------------------------------------------------------

const transports: HttpTransportHandle[] = [];
const tmpFiles: string[] = [];

after(async () => {
  for (const transport of transports) await transport.close();
  closeStore();
  for (const path of tmpFiles) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  }
});

/** 内核桩：本测试仅触达 `/runner/register`，MCP 面方法一律抛错 */
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

function makeConfig(): MachinesConfig {
  const machine: MachineRef = { machineId: "m-repo", launcherUrl: "", token: "tok-repo" };
  return {
    machines: [machine],
    transport: { mode: "http", http: { host: "127.0.0.1", port: 0, path: "/mcp" } },
    web: { enabled: false, host: "127.0.0.1", port: 0 },
    runner: { holdMs: 50, heartbeatTimeoutMs: 60_000, orphanTimeoutMs: 1_800_000 },
  };
}

async function startHarness(): Promise<number> {
  const handle = createRunnerEndpoints({ role: () => "owner", config: () => makeConfig() });
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

async function postRegister(port: number, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${RUNNER_REGISTER_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok-repo" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

function tmpDbPath(tag: string): string {
  const path = join(
    tmpdir(),
    `a2a-v0100-o6-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  tmpFiles.push(path);
  return path;
}

function repoById(machineId: string): Record<string, string | null> {
  return Object.fromEntries(listRunnerProjects(machineId).map((p) => [p.projectId, p.repo]));
}

// ---------------------------------------------------------------------------
// 1：parseProjects + RunnerProjectInput + runnerProjectsReplace（经 HTTP 注册全链）
// ---------------------------------------------------------------------------

test("O6 register 透传：repo 原值落投影；缺省/非字符串 ⇒ null（可选字段宽容，不 400）", async () => {
  const port = await startHarness();
  const res = await postRegister(port, {
    machineId: "m-repo",
    protocolVersion: "2.3",
    projects: [
      { projectId: "p-repo", agentKind: "opencode", a2aPort: 3051, repo: " Group-A/Repo-X " },
      { projectId: "p-norepo", agentKind: "codex", a2aPort: 3052 },
      { projectId: "p-badrepo", agentKind: "claude", a2aPort: 3053, repo: 42 },
    ],
  });
  assert.equal(res.status, 200, `注册应 200（实际 ${res.status} ${res.text}）`);

  const repos = repoById("m-repo");
  assert.equal(repos["p-repo"], " Group-A/Repo-X ", "repo 原值透传（不 trim、不折叠大小写）");
  assert.equal(repos["p-norepo"], null, "未配置 ⇒ null（老机零感知）");
  assert.equal(repos["p-badrepo"], null, "非字符串 ⇒ 归一 null（宽容忽略，不 400）");
});

test("O6 红线：repo 落 projects[] 项内，不动注册事件载荷顶层（只播报项目 id）", async () => {
  const port = await startHarness();
  const before = listEvents({ since: 0 }).filter((e) => e.kind === RUNNER_EVENT_REGISTERED).length;
  const res = await postRegister(port, {
    machineId: "m-repo",
    protocolVersion: "2.3",
    projects: [{ projectId: "p-evt", agentKind: "opencode", a2aPort: 3061, repo: "top/secret" }],
  });
  assert.equal(res.status, 200);

  const registered = listEvents({ since: 0 }).filter((e) => e.kind === RUNNER_EVENT_REGISTERED);
  assert.equal(registered.length - before, 1, "本次注册恰新增一条事件");
  const payload = JSON.parse(String(registered[registered.length - 1]?.payload)) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(payload).sort(), ["machineId", "projects", "protocolVersion", "runnerId"]);
  assert.deepEqual(payload["projects"], ["p-evt"], "只播报项目 id，不把 repo 提到载荷顶层");
  assert.equal("repo" in payload, false, "载荷顶层不得出现 repo");
});

// ---------------------------------------------------------------------------
// 2：runnerProjectsReplace（store 直连）—— repo 落列 / 缺省 null / 全量替换保鲜
// ---------------------------------------------------------------------------

test("O6 runnerProjectsReplace：repo 落列、缺省 null、全量替换后随新入参更新", () => {
  runnerProjectsReplace("m-s", [
    { projectId: "p1", agentKind: "opencode", a2aPort: 1, status: "online", repo: "R1" },
    { projectId: "p2", agentKind: "codex", a2aPort: 2, status: "online" },
  ]);
  let rows = listRunnerProjects("m-s");
  assert.equal(rows.find((r) => r.projectId === "p1")?.repo, "R1");
  assert.equal(rows.find((r) => r.projectId === "p2")?.repo, null);

  runnerProjectsReplace("m-s", [
    { projectId: "p1", agentKind: "opencode", a2aPort: 1, status: "online", repo: "R1b" },
  ]);
  rows = listRunnerProjects("m-s");
  assert.equal(rows.length, 1, "全量替换：p2 消失");
  assert.equal(rows[0]?.repo, "R1b", "repo 随新入参更新（非只插不改）");
});

// ---------------------------------------------------------------------------
// 3：DDL + try-ALTER —— 老库补 repo 列（缺省 NULL、幂等）
// ---------------------------------------------------------------------------

test("O6 DDL + try-ALTER：老库 runner_projects 无 repo 列 ⇒ ctor 补列（存量 NULL、写后可用、幂等）", () => {
  const dbPath = tmpDbPath("alter");
  // 造「v0.10.0 前」的老库：runner_projects 无 repo 列 + 一行存量投影
  const raw = openStoreDatabase(dbPath);
  raw.exec(
    `CREATE TABLE runner_projects (
       runner_id   TEXT NOT NULL,
       project_id  TEXT NOT NULL,
       workspace   TEXT,
       agent_kind  TEXT NOT NULL,
       a2a_port    INTEGER NOT NULL,
       risk        TEXT,
       status      TEXT NOT NULL,
       endpoint    TEXT,
       started_at  TEXT,
       updated_at  TEXT NOT NULL,
       PRIMARY KEY (runner_id, project_id)
     )`,
  );
  raw
    .prepare(
      `INSERT INTO runner_projects (runner_id, project_id, agent_kind, a2a_port, status, updated_at)
       VALUES ('m-legacy', 'p-legacy', 'opencode', 1, 'online', '2020-01-01T00:00:00.000Z')`,
    )
    .run();
  raw.close();

  // O6 上线：ctor 跑 try-ALTER 补 repo 列
  const store = new SessionStore(dbPath);
  try {
    assert.equal(
      store.listRunnerProjects("m-legacy")[0]?.repo,
      null,
      "存量行缺省 NULL（补列不是活动）",
    );
    store.runnerProjectsReplace("m-legacy", [
      { projectId: "p-legacy", agentKind: "opencode", a2aPort: 1, status: "online", repo: "R-after" },
    ]);
    assert.equal(store.listRunnerProjects("m-legacy")[0]?.repo, "R-after", "补列后可写可读");
  } finally {
    store.close();
  }

  // 列确已建（独立句柄看元数据）
  const probe = openStoreDatabase(dbPath);
  try {
    const names = (probe.prepare("SELECT name FROM pragma_table_info('runner_projects')").all() as Array<{
      name: string;
    }>).map((r) => r.name);
    assert.ok(names.includes("repo"), "repo 列应由 try-ALTER 补上");
  } finally {
    probe.close();
  }

  // 二次启动：ALTER 命中「列已存在」catch ⇒ 不抛（幂等）
  const again = new SessionStore(dbPath);
  try {
    assert.equal(again.listRunnerProjects("m-legacy")[0]?.repo, "R-after");
  } finally {
    again.close();
  }
});
