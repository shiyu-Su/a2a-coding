/**
 * v0.7.0 A6 · 桥层读侧单测（`bridge/index.ts`）：**注册表投影 + 零出站**。
 *
 * 覆盖节点验收（改造文档 §3.1-A6 / §4）：
 * ① `handleProjects` 数据源 = 桥注册表（`runners` / `runner_projects`）：每机项目来自注册投影，
 *    **不再出站** `GET /projects`；
 * ② 出参补 `runners[]`：**只列 memberMachines** 中已注册者（B4），含 `online` / `lastHeartbeatAt`；
 *    未注册 / 心跳超时 ⇒ 保留机器条目 + `error`（`launcher_unreachable` 语义改判）；
 * ③ **字段白名单**：全文不得出现 `workspace` / `agentConfig` / `runnerId` / token / `protocolVersion`；
 * ④ `locateProject` 改查注册视图：命中 ⇒ 入队；全部成员机器未注册/离线 ⇒ `launcher_unreachable`，
 *    注册在线但未上报该项目 ⇒ `project_not_found`；
 * ⑤ 成员判据（v0.6.0 语义保留）：非成员派发 / 查态 / 取消 ⇒ `project_not_a_member` 且**零 I/O**；
 * ⑥ **防 vacuous**：全局 `fetch` 被替换为**计数桩且一律抛错** ⇒ 任何「桥→machine 出站」都会
 *    立即失败（不静默通过）。
 *
 * 夹具约束：`MACHINES_CONFIG_PATH` 是 `bridge/index.ts` 的**模块加载期常量** ⇒ `MACHINES_CONFIG`
 * 必须在 **import 之前**设好（本文件用**动态 import**）；配置文件**内容**每次现读（不缓存）
 * ⇒ 用例之间直接改文件即可模拟「配置热改」。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTask,
  getQueuedTask,
  markRunnerOffline,
  runnerProjectsReplace,
  upsertRunner,
} from "../session/store.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 夹具：**零出站**计数桩（任何 fetch 一律抛错；计数用于「零 I/O」断言）
// ---------------------------------------------------------------------------

let outboundCount = 0;
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;
const throwingFetch: FetchFn = async (input) => {
  outboundCount += 1;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`桥不应再有出站请求（v0.7.0 A6 已退役出站）：${url}`);
};
globalThis.fetch = throwingFetch;

// ---------------------------------------------------------------------------
// 配置文件（内容每次现读 ⇒ 用例之间改文件即「配置热改」）
// ---------------------------------------------------------------------------

const MACHINE_IDS = ["m1", "m2", "m3"] as const;
const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-a6-registry-"));
const CFG_PATH = join(CFG_DIR, "config.json");
process.env["MACHINES_CONFIG"] = CFG_PATH; // 必须在 import bridge/index.js **之前**

interface GroupSpec {
  name?: string;
  members: Array<{ machineId: string; projectId: string }>;
}

/** 写机器清单；`projectGroup` 传 `null` = **段缺失**（全量接纳的缺省态） */
function writeConfig(projectGroup: GroupSpec | null): void {
  const machines = MACHINE_IDS.map((machineId) => ({ machineId }));
  const doc: Record<string, unknown> = { machines };
  if (projectGroup !== null) {
    const group: Record<string, unknown> = { members: projectGroup.members };
    if (projectGroup.name !== undefined) group["name"] = projectGroup.name;
    doc["projectGroup"] = group;
  }
  writeFileSync(CFG_PATH, JSON.stringify(doc, null, 2), "utf8");
}

writeConfig(null);

// 动态 import：模块加载期常量 `MACHINES_CONFIG_PATH` 此刻才被求值（见文件头「夹具约束」）
const { createCore } = await import("../bridge/index.js");
const core: BridgeCore = createCore();

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(CFG_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具助手：向注册表写入 Runner 投影
// ---------------------------------------------------------------------------

interface RunnerProjectSpec {
  projectId: string;
  status?: "online" | "offline";
}

function registerRunner(
  machineId: string,
  projects: RunnerProjectSpec[],
  opts: { state?: "online" | "offline"; lastHeartbeatAt?: string } = {},
): void {
  upsertRunner({
    runnerId: machineId,
    machineId,
    protocolVersion: "2.0",
    ...(opts.state === undefined ? {} : { state: opts.state }),
    ...(opts.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: opts.lastHeartbeatAt }),
  });
  runnerProjectsReplace(
    machineId,
    projects.map((p) => ({
      projectId: p.projectId,
      // 故意写入 workspace：出参白名单必须剔除
      workspace: `C:/secret-ws/${p.projectId}`,
      agentKind: "opencode" as const,
      a2aPort: 3010,
      status: p.status ?? "online",
      endpoint: `http://127.0.0.1:3010/${p.projectId}`,
      startedAt: "2026-09-18T00:00:00Z",
    })),
  );
}

// ---------------------------------------------------------------------------
// 出参收窄（不引入 `any`）
// ---------------------------------------------------------------------------

interface FailureShape {
  ok: false;
  code: string;
  error: string;
}

function isFailure(v: unknown): v is FailureShape {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
}

function expectFailure(v: unknown): FailureShape {
  assert.equal(isFailure(v), true, `期望结构化失败，实得：${JSON.stringify(v)}`);
  return v as FailureShape;
}

interface RunnerViewShape {
  machineId: string;
  online: boolean;
  lastHeartbeatAt: string;
}

interface ProjectsViewShape {
  machines: Array<{ machineId: string; projects: Array<{ projectId: string }>; error?: string }>;
  runners: RunnerViewShape[];
  group: { name: string | null; selective: boolean; memberMachines: string[] };
}

function expectProjectsView(v: unknown): ProjectsViewShape {
  assert.equal(isFailure(v), false, `期望 MachinesView，实得失败：${JSON.stringify(v)}`);
  return v as ProjectsViewShape;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test("①/② 读注册表：项目来自投影 + runners[] 只列成员 + 未注册机器带 error + 零出站", async () => {
  outboundCount = 0;
  writeConfig({
    name: "g1",
    members: [
      { machineId: "m1", projectId: "alpha" },
      { machineId: "m2", projectId: "gamma" },
    ],
  });
  // m1 已注册（上报 alpha + 非成员 beta）；m2 未注册；m3 已注册但**无成员**（应整条消失）
  registerRunner("m1", [{ projectId: "alpha" }, { projectId: "beta" }]);
  registerRunner("m3", [{ projectId: "delta" }]);

  const view = expectProjectsView(await core.projects());

  assert.deepEqual(
    view.machines.map((m) => m.machineId),
    ["m1", "m2"],
    "无成员的机器（m3）整条消失",
  );
  const m1 = view.machines.find((m) => m.machineId === "m1");
  assert.ok(m1 !== undefined);
  assert.deepEqual(
    m1.projects.map((p) => p.projectId),
    ["alpha"],
    "成员机器上的非成员项目（beta）必须被过滤",
  );
  const m2 = view.machines.find((m) => m.machineId === "m2");
  assert.ok(m2 !== undefined);
  assert.deepEqual(m2.projects, []);
  assert.match(
    m2.error ?? "",
    /Runner 未注册/,
    "未注册成员机器应带 error（launcher_unreachable 语义）",
  );

  assert.equal(view.runners.length, 1, "runners[] 只列 memberMachines 中已注册者（m3 非成员 ⇒ 不列）");
  assert.equal(view.runners[0]?.machineId, "m1");
  assert.equal(view.runners[0]?.online, true);
  assert.equal(typeof view.runners[0]?.lastHeartbeatAt, "string");
  assert.deepEqual(view.group, { name: "g1", selective: true, memberMachines: ["m1", "m2"] });
  assert.equal(outboundCount, 0, "handleProjects 必须零出站（读注册表）");
});

test("③ 字段白名单：全文不含 workspace / agentConfig / runnerId / token / protocolVersion", async () => {
  outboundCount = 0;
  writeConfig({ name: "g1", members: [{ machineId: "m1", projectId: "alpha" }] });
  registerRunner("m1", [{ projectId: "alpha" }]);

  const view = await core.projects();
  const raw = JSON.stringify(view);
  for (const forbidden of [
    "workspace",
    "secret-ws",
    "agentConfig",
    "runnerId",
    "protocolVersion",
    "token",
  ]) {
    assert.equal(raw.includes(forbidden), false, `出参不得含 ${forbidden}：${raw}`);
  }
  assert.ok(raw.includes("alpha"), "防 vacuous：出参确实含项目投影");
});

test("② 心跳超时：保留投影 + error（online=false），不触发任何出站", async () => {
  outboundCount = 0;
  writeConfig({ name: "g1", members: [{ machineId: "m1", projectId: "alpha" }] });
  registerRunner("m1", [{ projectId: "alpha" }], { state: "offline" });

  const view = expectProjectsView(await core.projects());
  const m1 = view.machines.find((m) => m.machineId === "m1");
  assert.ok(m1 !== undefined);
  assert.deepEqual(m1.projects.map((p) => p.projectId), ["alpha"], "离线仍保留最后投影");
  assert.match(m1.error ?? "", /心跳超时/);
  assert.equal(view.runners[0]?.online, false);
  assert.equal(outboundCount, 0);
});

test("④ locateProject：注册命中 ⇒ 入队（working 句柄）；未上报 ⇒ project_not_found", async () => {
  outboundCount = 0;
  writeConfig({
    name: "g1",
    members: [
      { machineId: "m1", projectId: "alpha" },
      { machineId: "m2", projectId: "gamma" },
    ],
  });
  registerRunner("m1", [{ projectId: "alpha" }]);
  registerRunner("m2", []);

  // 命中注册投影 ⇒ 立即入队并返回 working 句柄（wait=false 不等预算）
  const called = await core.call("alpha", "hi", undefined, false);
  assert.equal(isFailure(called), false, `期望入队成功：${JSON.stringify(called)}`);
  const taskId = (called as { taskId?: string }).taskId ?? "";
  assert.notEqual(taskId, "", "应返回本地 taskId 句柄");
  assert.equal(getQueuedTask(taskId)?.queueState, "queued", "任务须先落盘 queued 再报告");

  // m2 在线但未上报 gamma ⇒ project_not_found（区别于「未注册」）
  const missing = expectFailure(await core.call("gamma", "hi", undefined, false));
  assert.equal(missing.code, "project_not_found");
  assert.equal(outboundCount, 0, "定位全流程零出站");
});

test("④ locateProject：全部成员机器未注册/离线 ⇒ launcher_unreachable（语义改判）", async () => {
  outboundCount = 0;
  writeConfig({ name: "g1", members: [{ machineId: "m1", projectId: "alpha" }] });
  // 本文件前面用例可能在进程内注册过 m1（`:memory:` 库跨用例共享）⇒ 先降为 offline + 清空投影，
  // 构造「无可用 Runner」的确定态（卸载单条注册行不是存储口职责）。
  markRunnerOffline("m1");
  runnerProjectsReplace("m1", []);
  const outcome = expectFailure(await core.call("alpha", "hi", undefined, false));
  assert.equal(outcome.code, "launcher_unreachable");
  assert.match(
    outcome.error,
    /Runner 未注册|心跳超时/,
    "错误文案应说明「Runner 未注册 / 心跳超时」",
  );
  assert.equal(outboundCount, 0);
});

test("⑤ 非成员：派发 / 查态 / 取消 ⇒ project_not_a_member 且零出站", async () => {
  outboundCount = 0;
  writeConfig({ name: "g1", members: [{ machineId: "m1", projectId: "alpha" }] });
  registerRunner("m1", [{ projectId: "alpha" }]);
  createTask({
    taskId: "t-ghost",
    projectId: "ghost",
    contextId: "ctx-ghost",
    state: "working",
  });

  const denied = expectFailure(await core.call("ghost", "hi", undefined, false));
  assert.equal(denied.code, "project_not_a_member");

  const status = expectFailure(await core.taskStatus("t-ghost"));
  assert.equal(status.code, "project_not_a_member");

  const cancelled = expectFailure(await core.cancel("t-ghost"));
  assert.equal(cancelled.code, "project_not_a_member");

  assert.equal(outboundCount, 0, "非成员路径必须零 I/O");
});

test("⑤ 非成员登记 Feature 节点 ⇒ 登记前失败（零 I/O、节点不入库）", async () => {
  outboundCount = 0;
  writeConfig({ name: "g1", members: [{ machineId: "m1", projectId: "alpha" }] });

  const created = core.featureCreate({ title: "A6 单测夹具 Feature" });
  assert.equal(isFailure(created), false);
  const featureId = (created as { ok: true; featureId: string }).featureId;

  const registered = core.registerFeatureNode("ghost", "hi", undefined, featureId, []);
  const failure = expectFailure(registered);
  assert.equal(failure.code, "project_not_a_member");

  const status = core.featureStatus({ featureId });
  assert.equal(isFailure(status), false);
  assert.equal(
    (status as { tasks?: unknown[] }).tasks?.length ?? 0,
    0,
    "非成员节点绝不入库",
  );
  assert.equal(outboundCount, 0);
});

test("② fail-closed：坏 projectGroup（未知 machineId）⇒ machines_config_error", async () => {
  outboundCount = 0;
  writeConfig({ name: "bad", members: [{ machineId: "nope", projectId: "x" }] });

  const projects = expectFailure(await core.projects());
  assert.equal(projects.code, "machines_config_error");
  const called = expectFailure(await core.call("alpha", "hi", undefined, false));
  assert.equal(called.code, "machines_config_error");
  assert.equal(outboundCount, 0);
});

test("⑤ 缺省兼容：无 projectGroup ⇒ selective=false 全量接纳 + 不过滤 + group 恒存在", async () => {
  outboundCount = 0;
  writeConfig(null);
  registerRunner("m1", [{ projectId: "alpha" }]);
  registerRunner("m2", [{ projectId: "ghost" }]);
  registerRunner("m3", [{ projectId: "delta" }]);

  const view = expectProjectsView(await core.projects());
  assert.deepEqual(
    view.machines.map((m) => m.machineId),
    ["m1", "m2", "m3"],
    "缺省 ⇒ 全部配置机器都参与",
  );
  assert.deepEqual(
    view.machines[0]?.projects.map((p) => p.projectId),
    ["alpha"],
    "缺省 ⇒ 不做任何成员过滤",
  );
  assert.equal(view.runners.length, 3, "缺省 ⇒ runners[] 列全部已注册机器");
  assert.deepEqual(view.group, { name: null, selective: false, memberMachines: [] });
  assert.equal(outboundCount, 0);
});

test("⑥ 本地任务态：taskStatus 读本地落库（不碰远端）", async () => {
  outboundCount = 0;
  writeConfig({ name: "g1", members: [{ machineId: "m1", projectId: "alpha" }] });
  registerRunner("m1", [{ projectId: "alpha" }]);
  createTask({
    taskId: "t-local",
    projectId: "alpha",
    contextId: "ctx-local",
    state: "working",
    text: null,
  });

  const status = await core.taskStatus("t-local");
  assert.equal(isFailure(status), false);
  assert.equal((status as { status: string }).status, "working", "未回传 ⇒ 返回当前本地态");
  assert.equal(outboundCount, 0, "taskStatus 不得有任何出站");
});

test("③ cancel：本地成员任务无 Runner 端点（测试形态）⇒ cancel_unavailable", async () => {
  outboundCount = 0;
  writeConfig({ name: "g1", members: [{ machineId: "m1", projectId: "alpha" }] });
  registerRunner("m1", [{ projectId: "alpha" }]);
  createTask({
    taskId: "t-cancel",
    projectId: "alpha",
    contextId: "ctx-cancel",
    state: "working",
  });

  const cancelled = expectFailure(await core.cancel("t-cancel"));
  assert.equal(cancelled.code, "cancel_unavailable");
  assert.equal(outboundCount, 0, "取消命令经 Runner 端点下发，桥侧零出站");
});
