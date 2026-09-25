/**
 * v0.9.1 O1-B（REQ-v0.9.1-2026-09-25-02 · B1）—— `a2a_feature_status` 单 Feature 分支的
 * **acceptance 聚合块**（纯读增强，引擎推进语义零改动）。
 *
 * 锁定的行为面：
 *
 * 1. **stages[]**（主链段轨迹，`feature.state` 事件回放）：
 *    - **首段合成**：createFeature 不写事件 ⇒ `waiting_approval.enteredAt = feature.createdAt`；
 *    - **不按 state 聚合去重**：`executing → needs_input → executing` 得 ≥2 段同名 `executing`；
 *    - **相邻段 state 必不同**（store「只在真变化时写事件」守卫的读侧投影）；
 *    - **末段 `leftAt = null`**，其余段 `leftAt = 下一段 enteredAt`。
 * 2. **failures[]**：`feature.failure_report` 按 eventId 升序**零去重**原样列出（含「重启后再收敛
 *    的同 payload 重复账单如实呈现」—— 读面无进程内态，等价于同 payload 连 append 两条都在）；
 *    无失败 ⇒ **空数组**。
 * 3. **stateCounts**：与列表分支**同一事实源**（`featureTaskStateCounts` 聚合 SQL）、归属不放宽。
 * 4. **列表分支出参不变**（负向守卫）：列表行不得冒出 `acceptance`。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENT_FEATURE_STATE,
  appendEvent,
  createTask,
  featureTaskStateCounts,
  getFeature,
  listEvents,
  updateFeatureState,
} from "../session/store.js";
import { EVENT_FAILURE_REPORT } from "../bridge/scheduler.js";
import type { TaskState } from "../types.js";
import type { BridgeCore } from "../bridge/index.js";
import type {
  FeatureAcceptance,
  FeatureStatusSuccess,
  FeatureToolFailure,
} from "../bridge/feature-tools.js";

// 只读面 ⇒ 任何出站即失败（照 `v090-o2-read-plane.test.ts` 的桩口径）
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`acceptance 读面路径不应有任何出站请求：${url}`);
}) satisfies typeof globalThis.fetch;

const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-v091-o1-"));
const CFG_PATH = join(CFG_DIR, "config.json");
process.env["MACHINES_CONFIG"] = CFG_PATH;
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

const { createCore } = await import("../bridge/index.js");
const coreA: BridgeCore = createCore("gA");

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(CFG_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具助手
// ---------------------------------------------------------------------------

function mustOk<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) {
    const f = outcome as unknown as FeatureToolFailure;
    throw new Error(`期望成功，实际失败：${f.code} ${f.error}`);
  }
  return outcome as Extract<T, { ok: true }>;
}

function acceptanceOf(featureId: string): FeatureAcceptance {
  const res = mustOk(coreA.featureStatus({ featureId })) as FeatureStatusSuccess;
  const acc = res.acceptance;
  assert.ok(acc !== undefined, `单查 ${featureId} 必须带 acceptance 聚合块`);
  return acc;
}

function newFeature(title: string): string {
  return mustOk(coreA.featureCreate({ title })).featureId;
}

/** 带断言的下标取用（tsconfig 开了 noUncheckedIndexedAccess） */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  assert.ok(v !== undefined, `index ${String(i)} 越界`);
  return v;
}

// ---------------------------------------------------------------------------
// 1. stages[]：首段合成 + 不去重 + 相邻必不同 + 末段 leftAt=null
// ---------------------------------------------------------------------------

test("O1-B stages[]：create 后仅首段（enteredAt = feature.createdAt、leftAt=null）", () => {
  const featureId = newFeature("轨迹起点");
  const feature = getFeature(featureId);
  assert.ok(feature !== null);
  const { stages } = acceptanceOf(featureId);
  assert.equal(stages.length, 1, "create 不写 feature.state 事件 ⇒ 只有合成首段");
  assert.deepEqual(stages[0], {
    state: "waiting_approval",
    enteredAt: feature.createdAt,
    leftAt: null,
  });
});

test("O1-B stages[]：executing→needs_input→executing 轨迹（≥2 段同名 executing / 相邻必不同 / 末段 leftAt=null）", () => {
  const featureId = newFeature("轨迹回放");
  const feature = getFeature(featureId);
  assert.ok(feature !== null);
  // 造轨迹：waiting_approval → executing → needs_input → executing → integrating
  updateFeatureState(featureId, "executing");
  updateFeatureState(featureId, "needs_input");
  updateFeatureState(featureId, "executing");
  updateFeatureState(featureId, "integrating");

  const { stages } = acceptanceOf(featureId);
  assert.deepEqual(
    stages.map((s) => s.state),
    ["waiting_approval", "executing", "needs_input", "executing", "integrating"],
    "逐事件回放、**不按 state 聚合去重**（同名 executing 两段是轨迹本义）",
  );

  // 负向锚 1a：相邻段 state 必不同（store 守卫的读侧投影）
  for (let i = 1; i < stages.length; i += 1) {
    assert.notEqual(at(stages, i).state, at(stages, i - 1).state, `相邻段不得同态（index ${String(i)}）`);
  }
  // 负向锚 1b：含 needs_input→executing ⇒ ≥2 段同名 executing
  assert.ok(
    stages.filter((s) => s.state === "executing").length >= 2,
    "轨迹回炉后必须留下 ≥2 段 executing，而非聚合为一段",
  );
  // 负向锚 1c：末段 leftAt=null，其余段 leftAt = 下一段 enteredAt
  assert.equal(at(stages, stages.length - 1).leftAt, null, "末段 = 现停靠态，leftAt 必须为 null");
  for (let i = 0; i < stages.length - 1; i += 1) {
    assert.equal(at(stages, i).leftAt, at(stages, i + 1).enteredAt, `段 ${String(i)} 的 leftAt 即下一段 enteredAt`);
  }
  // 首段合成仍成立（有后续事件时 enteredAt 依旧来自 feature.createdAt）
  assert.equal(at(stages, 0).state, "waiting_approval");
  assert.equal(at(stages, 0).enteredAt, feature.createdAt, "首段 enteredAt 从 createdAt 合成");
});

// ---------------------------------------------------------------------------
// 2. failures[]：零去重 + 无失败空数组 + 重复账单如实呈现
// ---------------------------------------------------------------------------

test("O1-B failures[]：无失败 ⇒ 空数组（键在、值为 []）", () => {
  const featureId = newFeature("零失败");
  const { failures } = acceptanceOf(featureId);
  assert.deepEqual(failures, [], "无 failure_report ⇒ 空数组而非缺省/undefined");
});

test("O1-B failures[]：同 payload 两条账单**零去重**、eventId 升序、payload 原文透传", () => {
  const featureId = newFeature("失败账单");
  const payload = JSON.stringify({
    failed: [{ taskId: "f1-t0", projectId: "alpha", text: "boom", contextId: "c1", failureKind: "transport" }],
    blockedSet: ["f1-t1"],
  });
  const e1 = appendEvent({ featureId, taskId: null, kind: EVENT_FAILURE_REPORT, state: null, payload });
  // 「重启后再收敛的重复事件」投影：调度器签名 Map 是进程内态（重启失忆）、payload 无 retryCount
  // ⇒ 读面**必须**逐条如实呈现，不做任何去重 —— 同 payload 再 append 一条即可复现该形状。
  const e2 = appendEvent({ featureId, taskId: null, kind: EVENT_FAILURE_REPORT, state: null, payload });

  const { failures } = acceptanceOf(featureId);
  assert.equal(failures.length, 2, "同 payload 两条 ⇒ 仍两条（零去重）");
  assert.deepEqual(
    failures.map((f) => f.eventId),
    [e1.eventId, e2.eventId],
    "按 eventId 升序原样列出",
  );
  assert.equal(at(failures, 0).payload, payload, "payload 原文透传（不解析、不改写）");
  assert.equal(at(failures, 1).payload, payload);
  for (const f of failures) assert.equal(typeof f.at, "string", "每条附 at（= 事件 created_at）");
});

// ---------------------------------------------------------------------------
// 3. stateCounts：与列表分支同一事实源、同一条 SQL
// ---------------------------------------------------------------------------

test("O1-B stateCounts：与 featureTaskStateCounts / 列表行逐 Feature 全等；零节点 ⇒ 空对象", () => {
  const featureId = newFeature("计数同源");
  (["completed", "completed", "failed"] as TaskState[]).forEach((state, i) => {
    createTask({ taskId: `o1b-t${String(i)}`, projectId: "alpha", contextId: `o1b-c${String(i)}`, state, featureId });
  });
  const empty = newFeature("计数空");

  const acc = acceptanceOf(featureId);
  assert.deepEqual(acc.stateCounts, { completed: 2, failed: 1 });
  assert.deepEqual(
    acc.stateCounts,
    featureTaskStateCounts("gA").get(featureId),
    "与列表分支同一事实源（featureTaskStateCounts，归属不放宽）",
  );

  const list = mustOk(coreA.featureStatus({})) as FeatureStatusSuccess;
  const row = (list.features ?? []).find((f) => f.featureId === featureId);
  assert.ok(row !== undefined);
  assert.deepEqual(acc.stateCounts, row.stateCounts, "单查与列表行逐 Feature 全等");

  assert.deepEqual(acceptanceOf(empty).stateCounts, {}, "零节点 ⇒ 空对象（不补 0）");

  // 主链事件kind 与 failure 事件不干扰计数：轨迹迁态后 stateCounts 仍只数节点
  updateFeatureState(featureId, "executing");
  assert.deepEqual(acceptanceOf(featureId).stateCounts, { completed: 2, failed: 1 });
});

// ---------------------------------------------------------------------------
// 4. 负向守卫：列表分支出参不变（additive 只落单查分支）
// ---------------------------------------------------------------------------

test("O1-B 列表分支出参不变：行内与顶层都不得冒出 acceptance", () => {
  newFeature("列表守卫行");
  const list = mustOk(coreA.featureStatus({})) as FeatureStatusSuccess;
  assert.equal(list.acceptance, undefined, "列表调用顶层不得冒出 acceptance");
  assert.ok((list.features ?? []).length > 0, "前置：列表非空（防 vacuous）");
  for (const row of list.features ?? []) {
    assert.equal(
      (row as unknown as Record<string, unknown>)["acceptance"],
      undefined,
      `列表行 ${row.featureId} 不得冒出 acceptance（列表分支出参不变）`,
    );
  }

  // 对照（防 vacuous）：同 Feature 走单查分支 ⇒ acceptance 确实在
  const firstRow = at(list.features ?? [], 0);
  const single = mustOk(coreA.featureStatus({ featureId: firstRow.featureId })) as FeatureStatusSuccess;
  assert.ok(single.acceptance !== undefined, "单查分支确实产出 acceptance ⇒ 上面的负向不是读不到");
  assert.equal(single.features, undefined, "单查分支不冒列表字段（既有守卫不 regression）");
});

// ---------------------------------------------------------------------------
// 5. 只读性：acceptance 聚合不消费事件、不推游标（feature.state 事件数前后不变）
// ---------------------------------------------------------------------------

test("O1-B 纯读：反复单查不产生/不消费任何事件", () => {
  const featureId = newFeature("纯读");
  updateFeatureState(featureId, "executing");
  const before = listEventCount(featureId);
  for (let i = 0; i < 3; i += 1) acceptanceOf(featureId);
  assert.equal(listEventCount(featureId), before, "单查读面零写入（事件集合不变）");

  const { stages } = acceptanceOf(featureId);
  assert.deepEqual(
    stages.map((s) => s.state),
    ["waiting_approval", "executing"],
  );
});

function listEventCount(featureId: string): number {
  return listEvents({ featureId }).length;
}

// kind 常量防漂移断言（读面消费的就是这两类事件）
test("O1-B 事件 kind 常量防漂移", () => {
  assert.equal(EVENT_FEATURE_STATE, "feature.state");
  assert.equal(EVENT_FAILURE_REPORT, "feature.failure_report");
});
