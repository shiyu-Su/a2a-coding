/**
 * v0.8.6 req01 补正 · FIX-1 · 跨组写入洞（R-1）与项目侧双分支文案（R-3）的收口单测。
 *
 * 覆盖（改造文档 §2.3 / §6.1-3；F1 收口复核报告 R-1 / R-3）：
 * - **R-1**（安全）：`bridge/index.ts` `registerFeatureNode` 挂载前必须校验
 *   「本连接身份 == Feature `owner_group`」，判据**与 `ownershipFailure` 同源**（禁止第二套判据），
 *   三分支语义完全一致：`identity===null` 放行 / `owner_group===identity` 放行 / 其余 fail-closed 拒。
 *   他组连接不得把自己组内的项目挂进他组 Feature DAG；被拒节点**绝不入库**、**零出站**。
 * - **R-3**：项目侧（`a2a_tasks` → `assertMember` 现传 `groups`）对「属另一组」的项目给出
 *   **区分文案**「属另一项目组」，对「不属任何组」的项目仍走通用「非本组成员」文案。
 *
 * 夹具约束同 `group-read-scope.test.ts`：`MACHINES_CONFIG` 是 `bridge/index.ts` 的**模块加载期常量**
 * ⇒ 必须在 **import 之前**设好（本文件动态 import）。`fetch` 换成**计数桩且一律抛错** ⇒ 任何出站即失败。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getQueuedTask } from "../session/store.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 零出站计数桩
// ---------------------------------------------------------------------------

let outboundCount = 0;
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;
const throwingFetch: FetchFn = async (input) => {
  outboundCount += 1;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`登记 / 只读路径不应有任何出站请求：${url}`);
};
globalThis.fetch = throwingFetch;

// ---------------------------------------------------------------------------
// 两机组：gA = { m1 / alpha }、gB = { m2 / beta }（成员互斥，跨组各不重叠）
// ---------------------------------------------------------------------------

const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-r1r3-mount-"));
const CFG_PATH = join(CFG_DIR, "config.json");
process.env["MACHINES_CONFIG"] = CFG_PATH; // 必须在 import bridge/index.js **之前**

writeFileSync(
  CFG_PATH,
  JSON.stringify(
    {
      machines: [{ machineId: "m1" }, { machineId: "m2" }],
      projectGroup: [
        { name: "gA", members: [{ machineId: "m1", projectId: "alpha" }] },
        { name: "gB", members: [{ machineId: "m2", projectId: "beta" }] },
      ],
    },
    null,
    2,
  ),
  "utf8",
);

const { createCore, dispatchTask } = await import("../bridge/index.js");
const coreA: BridgeCore = createCore("gA");
const coreB: BridgeCore = createCore("gB");
const coreAnon: BridgeCore = createCore(null); // 未配组 / 3300 运维全量视图

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(CFG_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具助手
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

/** 某 Feature 当前挂载节点数（经 owner 身份的 featureStatus 读回） */
function taskCount(core: BridgeCore, featureId: string): number {
  const st = core.featureStatus({ featureId });
  assert.equal(isFailure(st), false, `featureStatus 应成功：${JSON.stringify(st)}`);
  return ((st as { tasks?: unknown[] }).tasks ?? []).length;
}

function featureIdOf(created: unknown): string {
  assert.equal(isFailure(created), false, `featureCreate 应成功：${JSON.stringify(created)}`);
  return (created as { ok: true; featureId: string }).featureId;
}

// ===========================================================================
// R-1：跨组 execute 挂载必须被拒（与 ownershipFailure 同源）
// ===========================================================================

test("R-1 跨组挂载 execute 节点 ⇒ feature_not_owned 拒 + 不泄漏他组组名；同组 / 无身份放行；被拒节点零入库零出站", () => {
  outboundCount = 0;
  const fidB = featureIdOf(coreB.featureCreate({ title: "gB 的 Feature" }));
  assert.equal(taskCount(coreB, fidB), 0, "初态无节点");

  // 攻击面：gA 连接把自己组内项目 `alpha` 挂进 **gB 的** Feature。
  // `alpha ∈ gA` ⇒ `assertMember` 会放行，唯一能拦下的是 R-1 的归属校验（owner_group vs identity）。
  const attack = expectFailure(coreA.registerFeatureNode("alpha", "hi", undefined, fidB, []));
  assert.equal(attack.code, "feature_not_owned", "跨组 execute 挂载必须被拒（判据同源 ownershipFailure）");
  assert.match(attack.error, /属另一项目组/, "文案沿用「属另一项目组」那一支（§6.1-3）");
  assert.ok(!attack.error.includes("gB"), "不泄漏他组组名 gB（§6.1-9）");
  assert.equal(taskCount(coreB, fidB), 0, "被拒节点绝不入库（不污染对方 DAG / 账单）");

  // 正向对照 1（排除 vacuous）：gB 挂自己组项目 `beta` ⇒ 放行。
  const own = coreB.registerFeatureNode("beta", "hi", undefined, fidB, []);
  assert.equal(isFailure(own), false, `同组挂载应放行：${JSON.stringify(own)}`);
  assert.equal(taskCount(coreB, fidB), 1, "同组挂载入库 1 节点");

  // 正向对照 2（identity===null 支）：无身份连接 ⇒ 放行（未配组 / 3300 运维全量视图，与既有语义一致）。
  const anon = coreAnon.registerFeatureNode("alpha", "hi", undefined, fidB, []);
  assert.equal(isFailure(anon), false, `无身份挂载应放行：${JSON.stringify(anon)}`);

  assert.equal(outboundCount, 0, "登记路径全程零出站");
});

test("R-1 存量无归属 Feature（owner_group=NULL）被组身份挂载 ⇒ fail-closed 拒（与五出口同源的 NULL 支）；无身份放行", () => {
  outboundCount = 0;
  const oid = featureIdOf(coreAnon.featureCreate({ title: "存量无归属（NULL）" }));

  // gA 身份操作 owner_group=NULL 的存量 Feature ⇒ 拒（fail-closed，不猜默认组）。
  const denied = expectFailure(coreA.registerFeatureNode("alpha", "hi", undefined, oid, []));
  assert.equal(denied.code, "feature_unowned", "无归属存量对组身份 fail-closed（ownershipFailure NULL 支）");
  assert.equal(taskCount(coreAnon, oid), 0, "被拒节点不入库");

  // 无身份 ⇒ 放行（既有语义，零破坏）。
  const ok = coreAnon.registerFeatureNode("alpha", "hi", undefined, oid, []);
  assert.equal(isFailure(ok), false, `无身份挂存量应放行：${JSON.stringify(ok)}`);
  assert.equal(outboundCount, 0);
});

// ===========================================================================
// R-3：项目侧（a2a_tasks）对「属另一组」的项目给出区分文案
// ===========================================================================

test("R-3 项目侧 a2a_tasks：他组项目 ⇒ 「属另一项目组」区分文案；不属任何组 ⇒ 通用「非本组成员」文案", async () => {
  outboundCount = 0;

  // beta ∈ gB（他组）：现传 groups ⇒ 走「属另一项目组」支（§6.1-3 项目侧对偶）。
  const cross = expectFailure(await coreA.tasks("beta"));
  assert.equal(cross.code, "project_not_a_member");
  assert.match(cross.error, /属另一项目组/, "项目侧对「属另一组」给出区分文案");
  assert.ok(!cross.error.includes("选择性连接"), "「属另一组」支不落入通用文案模板");

  // gamma 不属任何组：仍走通用「非本组成员」文案（不误报「属另一组」）。
  const nowhere = expectFailure(await coreA.tasks("gamma"));
  assert.equal(nowhere.code, "project_not_a_member");
  assert.ok(!nowhere.error.includes("属另一项目组"), "不属任何组 ⇒ 不误报「属另一组」");
  assert.match(nowhere.error, /选择性连接/, "走通用「非本组成员」文案");

  assert.equal(outboundCount, 0, "只读探测在成员判据处即拒 ⇒ 零出站");
});

// ===========================================================================
// Y-1：Feature 节点派发按 owner 组判定成员（dispatchFeatureNode 现传 feature.ownerGroup）
// ===========================================================================

test("Y-1 派发成员判据按 owner 组（非全组聚合）：以 owner=gA 身份派发落在 gB 的项目 ⇒ 拒且零脏行", async () => {
  outboundCount = 0;
  // 复刻 dispatchFeatureNode 现注入的 `identity: feature?.ownerGroup ?? null`（gA-owned Feature）。
  // 该 DAG 节点若落在 gB 的 `beta`，派发期即被 owner 组判据拒（不再因聚合视图放行）。
  const denied = await dispatchTask({
    taskId: "t-y1",
    projectId: "beta",
    contextId: "c-y1",
    wait: false,
    newTask: { prompt: "hi", dispatchMessage: "hi" },
    identity: "gA",
  });
  assert.equal(denied.ok, false, "以 owner 组身份派发非本组项目应被拒");
  if (denied.ok) throw new Error("unreachable");
  assert.equal(denied.code, "project_not_a_member");
  assert.equal(getQueuedTask("t-y1"), null, "派发在成员判据处即拒，绝不入队（零脏行）");

  // 对照：owner_group=null（未配组 / 存量）⇒ 传 null ⇒ 全组聚合视图，与旧行为一致（beta 不被成员判据拦）。
  const viaAggregate = await dispatchTask({
    taskId: "t-y1-null",
    projectId: "beta",
    contextId: "c-y1n",
    wait: false,
    newTask: { prompt: "hi", dispatchMessage: "hi" },
    identity: null,
  });
  // 聚合视图下 beta 是本环境可见项目 ⇒ 不会被 `project_not_a_member` 拦（后续态不在此断言）。
  const rejectedByMember = !viaAggregate.ok && viaAggregate.code === "project_not_a_member";
  assert.equal(rejectedByMember, false, "无身份 ⇒ 聚合视图不拒本环境内项目");

  assert.equal(outboundCount, 0, "派发路径零出站");
});

