/**
 * v0.6.0 项目组与选择性连接 · **桥层单测**（DAG N2；`bridge/index.ts`）。
 *
 * 覆盖改造文档 §4.3 的 orch 单测责任（判据 / 校验 / 缓存）+ §4.2 的可离线断言部分：
 * ① **缓存不绕过**（R1）：成员态 warm `projectIndex` → 改非成员 ⇒ 仍失败且**未回落全量扫描**；
 * ② **fail-closed**（I2）：坏 `projectGroup` ⇒ `machines_config_error`，**不得**表现为「全量接纳成功」；
 * ③ **防 vacuous**（I3）：非成员派发时 **outbound HTTP 计数 = 0**（`/health` 0、`/ensure` 0），
 *    且**夹具让该非成员项目真实出现在 `/projects` 返回中** —— `project_not_a_member` 与
 *    `project_not_found` **分码断言**；
 * ④ **无成员机器零请求**（`GET /projects` 计数 = 0，且整条消失）；
 * ⑤ **缺省兼容**：无 `projectGroup` ⇒ `selective === false` 全量接纳、不过滤、不 fail-fast；
 * ⑥ **出参 `group` 形状**（I5）：恒存在；`name` 缺省 `null`；`memberMachines` = **配置声明集合**
 *    （含当前不可达者，**不是**运行时在线集合）。
 *
 * 夹具约束（§4.3 前置登记）：`MACHINES_CONFIG_PATH` 是 `bridge/index.ts` 的**模块加载期常量**
 * ⇒ `MACHINES_CONFIG` 必须在 **import 之前**设好（本文件用**动态 import**）。配置文件**内容**
 * 则由 `loadMachines()` **每次现读**（不缓存）⇒ 用例之间直接改文件即可模拟「配置热改 / 成员热移除」。
 *
 * 为什么可以 import `bridge/index.ts`：N2 为其顶层 `main()` 加了**入口判定**
 * （`process.argv[1]` vs `import.meta.url`）⇒ 被 import 时不再自动拉起整座桥，
 * `createCore()` 因而成为可测的领域入口（三种真实启动路径的 `argv[1]` 都指向该文件，
 * 生产行为零变化；真机启动由发版/Step 3 冒烟另行验证）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask } from "../session/store.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 夹具：机器清单（内存 Launcher stub，真实 `fetch` 被替换为计数桩）
// ---------------------------------------------------------------------------

/** 各机器 Launcher 基址（端口只需唯一，无需真在监听 —— `fetch` 已换桩） */
const LAUNCHER_BASE: ReadonlyArray<readonly [string, string]> = [
  ["m1", "http://127.0.0.1:31101"],
  ["m2", "http://127.0.0.1:31102"],
  ["m3", "http://127.0.0.1:31103"],
];

function baseOf(machineId: string): string {
  const found = LAUNCHER_BASE.find(([id]) => id === machineId);
  if (found === undefined) throw new Error(`未知机器 ${machineId}`);
  return found[1];
}

/** 一次出站请求的留痕（`machineId` 由 origin 反查 ⇒ 计数断言以「机器 × 路径」为粒度） */
interface OutboundCall {
  machineId: string;
  method: string;
  pathname: string;
}

interface LauncherFixture {
  /** machineId → 该机 `GET /projects` 返回的项目 id 列表（**原始**，未过滤） */
  projectsByMachine: Record<string, string[]>;
  /** 这些机器的 `GET /projects` 返回 503（`/health` 仍正常 ⇒ 测「成员机器不可达」） */
  failingMachines: string[];
  /**
   * `GET /projects` 被服务后的钩子（可选）：用于**确定性地**在「定位成功」与「ensure」之间
   * 制造配置热改（`ensureProject` 每次现读配置 ⇒ 命中 §2.2 的硬兜底首行）。
   */
  onProjectsServed?: (machineId: string) => void;
}

let fixture: LauncherFixture = { projectsByMachine: {}, failingMachines: [] };
const outbound: OutboundCall[] = [];

function resetLauncher(next: LauncherFixture): void {
  outbound.length = 0;
  fixture = next;
}

function callsTo(machineId: string): OutboundCall[] {
  return outbound.filter((c) => c.machineId === machineId);
}

function countRequests(machineId: string, pathname: string): number {
  return outbound.filter((c) => c.machineId === machineId && c.pathname === pathname).length;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function projectStatus(projectId: string): Record<string, unknown> {
  return {
    projectId,
    workspace: `C:/ws/${projectId}`,
    agentKind: "opencode",
    a2aPort: 3010,
    status: "online",
    endpoint: "http://127.0.0.1:3010/",
    startedAt: "2026-09-17T00:00:00Z",
  };
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const originalFetch = globalThis.fetch;

/**
 * 计数桩：只服务本夹具的三台机器；其余 origin（A2A agent card 等）一律抛错
 * （本节点用例**不应**走到联网派发 —— 一旦走到就是用例前置被破坏，显式失败优于静默通过）。
 */
const countingFetch: FetchFn = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const parsed = new URL(url);
  const entry = LAUNCHER_BASE.find(([, base]) => parsed.origin === base);
  if (entry === undefined) throw new Error(`单测未预期的出站请求：${method} ${url}`);
  const machineId = entry[0];
  outbound.push({ machineId, method, pathname: parsed.pathname });
  if (parsed.pathname === "/health") {
    return jsonResponse({ protocolVersion: "1.0", status: "ok" });
  }
  if (parsed.pathname === "/projects" && method === "GET") {
    if (fixture.failingMachines.includes(machineId)) {
      return jsonResponse({ error: "测试：机器不可达" }, 503);
    }
    const ids = fixture.projectsByMachine[machineId] ?? [];
    const projects = ids.map(projectStatus);
    fixture.onProjectsServed?.(machineId);
    return jsonResponse({ projects });
  }
  if (method === "POST" && parsed.pathname.endsWith("/ensure")) {
    return jsonResponse({ endpoint: `${parsed.origin}/a2a`, started: false });
  }
  throw new Error(`单测未预期的出站请求：${method} ${url}`);
};

globalThis.fetch = countingFetch;

// ---------------------------------------------------------------------------
// 配置文件（内容每次现读 ⇒ 用例之间改文件即「配置热改」）
// ---------------------------------------------------------------------------

const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-project-group-"));
const CFG_PATH = join(CFG_DIR, "config.json");
process.env["MACHINES_CONFIG"] = CFG_PATH; // 必须在 import bridge/index.js **之前**

interface GroupSpec {
  name?: string;
  members: Array<{ machineId: string; projectId: string }>;
}

/** 写机器清单；`projectGroup` 传 `null` = **段缺失**（全量接纳的缺省态） */
function writeConfig(projectGroup: GroupSpec | null): void {
  const machines = LAUNCHER_BASE.map(([machineId, launcherUrl]) => ({ machineId, launcherUrl }));
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
// 出参收窄（不引入 `any`；`Failure` 靠 `ok === false` 判别）
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

interface ProjectsViewShape {
  machines: Array<{ machineId: string; projects: Array<{ projectId: string }>; error?: string }>;
  group: { name: string | null; selective: boolean; memberMachines: string[] };
}

function expectProjectsView(v: unknown): ProjectsViewShape {
  assert.equal(isFailure(v), false, `期望 MachinesView，实得失败：${JSON.stringify(v)}`);
  return v as ProjectsViewShape;
}

interface TasksViewShape {
  ok: true;
  projectId: string;
  reachable: boolean;
  notice?: string;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test("⑥/⑤ 选择性连接出参：group 恒存在 + 只列成员项目 + 无成员机器整条消失且零请求", async () => {
  writeConfig({
    name: "g1",
    members: [
      { machineId: "m1", projectId: "alpha" },
      { machineId: "m2", projectId: "gamma" },
    ],
  });
  resetLauncher({
    projectsByMachine: { m1: ["alpha", "beta"], m3: ["delta"] },
    failingMachines: ["m2"],
  });

  const view = expectProjectsView(await core.projects());

  // ⑤ 无成员的机器（m3）：整条消失 + **一个请求都不发**
  assert.deepEqual(
    view.machines.map((m) => m.machineId),
    ["m1", "m2"],
    "无成员的机器必须整条消失",
  );
  assert.equal(countRequests("m3", "/projects"), 0, "无成员的机器不得 GET /projects");
  assert.equal(callsTo("m3").length, 0, "无成员的机器不得有任何出站请求");

  // 每机只列成员：m1 的 beta 是非成员项目 ⇒ 不出现在出参
  const m1 = view.machines.find((m) => m.machineId === "m1");
  assert.ok(m1 !== undefined);
  assert.deepEqual(
    m1.projects.map((p) => p.projectId),
    ["alpha"],
    "成员机器上的非成员项目也必须被过滤",
  );

  // 成员机器不可达 ⇒ 保留条目 + error（不因不可达而消失）
  const m2 = view.machines.find((m) => m.machineId === "m2");
  assert.ok(m2 !== undefined);
  assert.notEqual(m2.error, undefined, "成员机器不可达应带 error 条目");

  // ⑥ group 形状（I5）：恒存在；memberMachines = **配置声明集合**（含当前不可达的 m2）
  assert.deepEqual(view.group, { name: "g1", selective: true, memberMachines: ["m1", "m2"] });
});

test("③/④ 非成员派发：零出站请求 + project_not_a_member；与 project_not_found 分码断言", async () => {
  writeConfig({
    name: "g1",
    members: [
      { machineId: "m1", projectId: "alpha" },
      // "phantom" **已声明**为成员但该机 `/projects` 里并不存在 ⇒ 必须落在 project_not_found
      { machineId: "m1", projectId: "phantom" },
    ],
  });
  resetLauncher({ projectsByMachine: { m1: ["alpha", "ghost"], m2: ["ghost"] }, failingMachines: [] });

  // 夹具自证（防 vacuous）：非成员项目 "ghost" **真实出现**在 `/projects` 返回中
  for (const machineId of ["m1", "m2"]) {
    const raw = await fetch(`${baseOf(machineId)}/projects`);
    const rawBody = (await raw.json()) as { projects: Array<{ projectId: string }> };
    assert.equal(
      rawBody.projects.some((p) => p.projectId === "ghost"),
      true,
      `夹具必须让非成员项目真实出现在 ${machineId} 的 /projects 中（否则测到的是 project_not_found）`,
    );
    assert.equal(countRequests(machineId, "/projects"), 1, "夹具自证请求应被计数");
  }

  outbound.length = 0; // 只统计桥自身发起的请求

  // ① "ghost" 存在于 m1/m2 的 /projects，但不在成员集合内 ⇒ 零 I/O 失败
  const denied = expectFailure(await core.call("ghost", "hi", undefined, true));
  assert.equal(denied.code, "project_not_a_member");
  assert.equal(outbound.length, 0, "非成员派发必须零出站请求（/health 0、/ensure 0）");
  assert.equal(countRequests("m1", "/health"), 0);
  assert.equal(countRequests("m1", "/ensure"), 0);

  // ② 对照：**已声明成员**但该机当前不存在 ⇒ 才是 project_not_found（两码分开）
  const missing = expectFailure(await core.call("phantom", "hi", undefined, true));
  assert.equal(missing.code, "project_not_found");
  assert.equal(outbound.length > 0, true, "project_not_found 路径确实做了只读扫描（对照项）");
});

test("① 缓存不绕过（R1）：成员态 warm projectIndex → 改非成员 ⇒ 仍失败 + 未回落全量扫描", async () => {
  writeConfig({ name: "g1", members: [{ machineId: "m1", projectId: "warm-proj" }] });
  resetLauncher({ projectsByMachine: { m1: ["warm-proj"] }, failingMachines: [] });
  createTask({
    taskId: "t-warm",
    projectId: "warm-proj",
    contextId: "ctx-warm",
    state: "working",
  });

  // 预热：`locateProject` 扫描命中 ⇒ `projectIndex.set("warm-proj", "m1")`
  const warm = await core.tasks("warm-proj");
  assert.equal(isFailure(warm), false);
  assert.equal((warm as TasksViewShape).reachable, true, "成员态应可定位（预热缓存）");
  assert.equal(countRequests("m1", "/projects"), 1, "预热应只扫成员机器一次");

  // 配置热改：`warm-proj` 不再是**任何**成员机器的成员
  writeConfig({ name: "g1", members: [{ machineId: "m1", projectId: "other" }] });
  outbound.length = 0;

  const after = (await core.tasks("warm-proj")) as TasksViewShape;
  assert.equal(isFailure(after), false);
  assert.equal(after.reachable, false, "移出成员后必须失败");
  assert.match(after.notice ?? "", /不是项目组.*的成员/, "必须给出成员语义的原因，而非 project_not_found");
  assert.equal(
    outbound.length,
    0,
    "cache-hit 分支必须**先判成员**：既不核对旧机器，也不回落全量扫描（旧实现会发 /projects）",
  );

  // 文档 §2.2-② 的回落理由：该项目在**另一台**成员机器上仍是成员 ⇒ 应能重新定位（跨机）
  writeConfig({ name: "g1", members: [{ machineId: "m2", projectId: "warm-proj" }] });
  resetLauncher({ projectsByMachine: { m2: ["warm-proj"] }, failingMachines: [] });
  const relocated = (await core.tasks("warm-proj")) as TasksViewShape;
  assert.equal(isFailure(relocated), false);
  assert.equal(relocated.reachable, true, "跨机仍是成员 ⇒ 应重新定位成功");
  assert.equal(countRequests("m2", "/projects"), 1, "重新定位应扫描新的成员机器");
});

test("② fail-closed（I2）：坏 projectGroup（未知 machineId）⇒ machines_config_error，绝不全量接纳", async () => {
  writeConfig({ name: "bad", members: [{ machineId: "nope", projectId: "x" }] });
  resetLauncher({ projectsByMachine: { m1: ["alpha"] }, failingMachines: [] });

  const projects = expectFailure(await core.projects());
  assert.equal(projects.code, "machines_config_error");

  const called = expectFailure(await core.call("alpha", "hi", undefined, true));
  assert.equal(called.code, "machines_config_error");

  assert.equal(
    outbound.length,
    0,
    "坏配置必须 fail-fast —— 不得被当成「全量接纳」而向任何机器发请求",
  );
});

test("⑤ 缺省兼容：无 projectGroup ⇒ selective=false 全量接纳 + 不过滤 + group 恒存在", async () => {
  writeConfig(null);
  resetLauncher({
    projectsByMachine: { m1: ["alpha", "beta"], m2: ["ghost"], m3: ["delta"] },
    failingMachines: [],
  });

  const view = expectProjectsView(await core.projects());
  assert.deepEqual(
    view.machines.map((m) => m.machineId),
    ["m1", "m2", "m3"],
    "缺省 ⇒ 全部配置机器都参与（含非成员机器 m3）",
  );
  assert.deepEqual(
    view.machines[0]?.projects.map((p) => p.projectId),
    ["alpha", "beta"],
    "缺省 ⇒ 不做任何成员过滤",
  );
  assert.deepEqual(
    view.group,
    { name: null, selective: false, memberMachines: [] },
    "缺省 ⇒ group 仍恒存在（name=null、memberMachines=[]）",
  );
  assert.equal(countRequests("m3", "/projects"), 1, "缺省 ⇒ 无成员概念的机器也应被遍历");
});

test("⑧ 非成员登记 Feature 节点 ⇒ 登记前失败（零请求、节点不入库）", async () => {
  writeConfig({ name: "g1", members: [{ machineId: "m1", projectId: "alpha" }] });
  resetLauncher({ projectsByMachine: { m1: ["alpha"] }, failingMachines: [] });

  const created = core.featureCreate({ title: "N2 单测夹具 Feature" });
  assert.equal(isFailure(created), false);
  const featureId = (created as { ok: true; featureId: string }).featureId;

  const registered = core.registerFeatureNode("ghost", "hi", undefined, featureId, []);
  const failure = expectFailure(registered);
  assert.equal(failure.code, "project_not_a_member");
  assert.equal(outbound.length, 0, "登记前断言必须零 I/O（防「登记成功、异步才失败」）");

  const status = core.featureStatus({ featureId });
  assert.equal(isFailure(status), false);
  assert.equal(
    (status as { tasks?: unknown[] }).tasks?.length ?? 0,
    0,
    "非成员节点绝不入库 ⇒ Feature 下无任务",
  );
});

test("⑨ 非成员任务的 taskStatus / cancel ⇒ project_not_a_member（零请求）", async () => {
  writeConfig({ name: "g1", members: [{ machineId: "m1", projectId: "alpha" }] });
  resetLauncher({ projectsByMachine: { m1: ["alpha"] }, failingMachines: [] });
  createTask({
    taskId: "t-ghost",
    projectId: "ghost",
    contextId: "ctx-ghost",
    state: "working",
  });

  const status = expectFailure(await core.taskStatus("t-ghost"));
  assert.equal(status.code, "project_not_a_member");
  const cancelled = expectFailure(await core.cancel("t-ghost"));
  assert.equal(cancelled.code, "project_not_a_member");
  assert.equal(
    outbound.length,
    0,
    "查态 / 取消路径同样不得对非成员发任何请求（覆盖 6 条「拉起」路径之二）",
  );
});

test("⑩ R2 硬兜底：`ensureProject` 首行 —— 定位成功与 ensure 之间热移除成员 ⇒ 零 /health、零 /ensure", async () => {
  writeConfig({ name: "g1", members: [{ machineId: "m1", projectId: "alpha" }] });
  // 钩子：在定位成功（`/projects` 已返回）后、`ensureProject` 现读配置**之前**，把 alpha 移出成员。
  // 只有 `ensureProject` 的**首行**断言能在此时拦下（`locateProject` / `dispatchTask` 都已通过）。
  let mutated = false;
  let atMutation = -1;
  resetLauncher({
    projectsByMachine: { m1: ["alpha"] },
    failingMachines: [],
    onProjectsServed: (machineId) => {
      if (machineId === "m1" && !mutated) {
        mutated = true;
        writeConfig({ name: "g1", members: [{ machineId: "m1", projectId: "other" }] });
        atMutation = outbound.length; // 此刻已包含本次 /projects
      }
    },
  });

  const outcome = expectFailure(await core.call("alpha", "hi", undefined, true));
  assert.equal(mutated, true, "夹具前置：配置热改钩子已触发");
  assert.equal(atMutation > 0, true, "夹具前置：定位阶段的 /projects 已被计数");
  assert.equal(outcome.code, "project_not_a_member");
  assert.equal(countRequests("m1", "/ensure"), 0, "非成员绝不 POST /ensure");
  assert.equal(
    outbound.length,
    atMutation,
    "热改后不得再有任何出站请求 —— 硬兜底在 `ensureProtocol`（/health）之前",
  );
});

