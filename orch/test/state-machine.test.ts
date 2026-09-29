/**
 * Feature 状态机 / Feature 工具组单测 —— **A 步**（REQ-v0.4.1-2026-09-16-01，改造文档 v5 §2.3 / §2.4）。
 *
 * 覆盖 A 步：
 * - `create` 起点 = `waiting_approval`（主链起点收敛：引擎只做需求实现，Step 0/1 不走引擎）；
 * - `advance` 唯一门：`waiting_approval → executing` **被拒**（`feature_approval_required`），
 *   进入 `executing` 必须经 `a2a_feature_approve`；
 * - **错误区分**：`waiting_approval → integrating`（**枚举内**的非法后继）报
 *   `feature_transition_invalid`（状态机层判定）；
 * - **不得误伤** `needs_input → executing`（人工澄清续推属设计内）；
 * - `approve` 仅适用于 `waiting_approval`。
 *
 * 范围说明：**只覆盖 A 步**。B 步（删三态 + 一行迁移 + 脏值兜底）的用例在 N2 落地时于本文件补齐。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { close, createFeature, createTask, getFeature, getTask } from "../session/store.js";
import {
  FEATURE_MAIN_CHAIN,
  FEATURE_STATES,
  allowedTransitions,
  isFeatureState,
  isTerminalFeatureState,
} from "../feature/state-machine.js";
import {
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCancel,
  handleFeatureCreate,
  type FeatureCreateSuccess,
  type FeatureStateChangeSuccess,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";

// 默认存储固定内存库（与 feature-tools.test.ts / scheduler.test.ts 同口径）
process.env["SESSION_DB"] = ":memory:";

function mustCreate(outcome: FeatureCreateSuccess | FeatureToolFailure): FeatureCreateSuccess {
  if (!outcome.ok) throw new Error(`期望成功，实际失败：${outcome.code} ${outcome.error}`);
  return outcome;
}

function mustChange(
  outcome: FeatureStateChangeSuccess | FeatureToolFailure,
): FeatureStateChangeSuccess {
  if (!outcome.ok) throw new Error(`期望成功，实际失败：${outcome.code} ${outcome.error}`);
  return outcome;
}

function mustFail(outcome: FeatureStateChangeSuccess | FeatureToolFailure): FeatureToolFailure {
  if (outcome.ok) throw new Error("期望失败，实际成功");
  return outcome;
}

test("A 步 §4.1.1：a2a_feature_create 后 Feature 初态 = waiting_approval（主链起点）", () => {
  close();
  const created = mustCreate(handleFeatureCreate({ title: "A 步起点" }));
  assert.equal(created.state, "waiting_approval", "初态即审批门停靠点");
  assert.equal(getFeature(created.featureId)?.state, "waiting_approval", "落库态与出参一致");
  close();
});

test("A 步 §4.1.2：advance(waiting_approval → executing) 被拒（唯一准入 = approve）", () => {
  close();
  const created = mustCreate(handleFeatureCreate({ title: "绕门被拒" }));

  const failure = mustFail(handleFeatureAdvance({ featureId: created.featureId, to: "executing" }));
  assert.equal(failure.code, "feature_approval_required", "错误码须为专用码");
  assert.match(failure.error, /a2a_feature_approve/, "错误消息须给出正确指引");
  assert.equal(
    getFeature(created.featureId)?.state,
    "waiting_approval",
    "被拒时不得改态（校验先于落库）",
  );
  close();
});

test("A 步 §4.1.2：错误区分 —— advance(waiting_approval → integrating) 报 feature_transition_invalid", () => {
  close();
  const created = mustCreate(handleFeatureCreate({ title: "错误区分" }));

  // 用**枚举内**的非法后继（删三态后 `analyzing` 会先被 `isFeatureState` 拒 ⇒ `feature_invalid_state`，
  // 不再落在状态机判定分支；`waiting_approval` 的后继仅 executing / cancelled / failed）
  const failure = mustFail(
    handleFeatureAdvance({ featureId: created.featureId, to: "integrating" }),
  );
  assert.equal(
    failure.code,
    "feature_transition_invalid",
    "非法目标态走状态机判定；门只接管'合法但须审批'的那一步",
  );
  assert.equal(getFeature(created.featureId)?.state, "waiting_approval");
  close();
});

test("A 步：不得误伤 —— advance(needs_input → executing) 仍可续推（带 answer 续接任务）", () => {
  close();
  createFeature({ featureId: "f-needs", title: "澄清续推", state: "needs_input" });
  createTask({
    taskId: "T-needs",
    projectId: "p1",
    contextId: "c1",
    state: "input-required",
    featureId: "f-needs",
    prompt: "base",
    dispatchMessage: "base",
  });

  const changed = mustChange(
    handleFeatureAdvance({ featureId: "f-needs", to: "executing", answer: "用户答复" }),
  );
  assert.equal(changed.from, "needs_input");
  assert.equal(changed.state, "executing");
  assert.equal(getFeature("f-needs")?.state, "executing");

  const task = getTask("T-needs");
  assert.equal(task?.state, "working", "待澄清任务被 re-arm（回到待派发）");
  assert.match(task?.dispatchMessage ?? "", /\[用户澄清\]/, "answer 追加在原消息之后");
  assert.match(task?.dispatchMessage ?? "", /用户答复/);
  close();
});

test("A 步 §4.1.2：handleFeatureApprove 成功进入 executing；非 waiting_approval 被拒", () => {
  close();
  const created = mustCreate(handleFeatureCreate({ title: "审批门" }));

  const approved = mustChange(handleFeatureApprove({ featureId: created.featureId }));
  assert.equal(approved.from, "waiting_approval");
  assert.equal(approved.state, "executing");
  assert.equal(getFeature(created.featureId)?.state, "executing");

  // 已在 executing ⇒ 重复 approve 被拒（门只对 waiting_approval 开放）
  const again = mustFail(handleFeatureApprove({ featureId: created.featureId }));
  assert.equal(again.code, "feature_state_invalid");
  close();
});

test("B 步 §4.1.6：主链收敛 —— 枚举 9 态（6 主态 + 3 异常态），三态已退役且不可流转", () => {
  assert.deepEqual(
    [...FEATURE_STATES],
    [
      "waiting_approval",
      "executing",
      "integrating",
      "testing",
      "reviewing",
      "completed",
      "needs_input",
      "failed",
      "cancelled",
    ],
    "枚举即事实源：退役三态不得再出现",
  );
  assert.deepEqual(
    [...FEATURE_MAIN_CHAIN],
    ["waiting_approval", "executing", "integrating", "testing", "reviewing", "completed"],
    "主链 6 态（起点 = 审批门停靠点）",
  );

  for (const retired of ["discussing", "analyzing", "planning"]) {
    assert.equal(isFeatureState(retired), false, `${retired} 已退役 ⇒ 收窄失败（读取即被拒）`);
  }
  // 转移表**键集**由类型约束保证（`Record<FeatureState, …>`）：枚举一收缩，任何多余键即编译错误
  // （typecheck 即证明）；表中亦无三态出边（见上方 FEATURE_STATES / FEATURE_MAIN_CHAIN 断言）。

  // 唯一准入边保留在转移表（`approve` 实际不经 canTransition，但表必须与行为一致）。
  // **`cancelled` 是例外**（v0.9.5 O1）：`failed → cancelled` 由 cancel 守卫放行、**不经表**
  // （表内 `failed: []` 不变 —— 见下方「负锚」用例把「不加边」钉成断言）。
  assert.deepEqual(
    [...allowedTransitions("waiting_approval")],
    ["executing", "cancelled", "failed"],
  );
  assert.deepEqual([...allowedTransitions("needs_input")], ["executing", "cancelled", "failed"]);
  assert.deepEqual([...allowedTransitions("completed")], []);
});

// ---------------------------------------------------------------------------
// v0.9.5（REQ-2026-09-28-10 O1）—— `failed` 的收口归档路径（cancel 守卫放行，表零改动）
// ---------------------------------------------------------------------------

test("O1 正例：handleFeatureCancel 可将 failed Feature 归档为 cancelled（发版收口路径）", () => {
  close();
  createFeature({ featureId: "f-cancel", title: "DAG 非法后归档", state: "failed" });
  // 节点账面：一个 failed、一个被冻结的 blocked —— cancel 只迁 Feature 态，二者须原样保留
  createTask({ taskId: "N-failed", projectId: "p1", contextId: "c1", state: "failed", featureId: "f-cancel" });
  createTask({ taskId: "N-blocked", projectId: "p1", contextId: "c2", state: "blocked", featureId: "f-cancel" });

  const cancelled = mustChange(handleFeatureCancel({ featureId: "f-cancel" }));
  assert.equal(cancelled.from, "failed", "出参 from 反映归档前的真实态");
  assert.equal(cancelled.state, "cancelled");
  assert.equal(getFeature("f-cancel")?.state, "cancelled", "落库态已归档为 cancelled");

  assert.equal(getTask("N-failed")?.state, "failed", "本件不重派：failed 节点账面不动");
  assert.equal(getTask("N-blocked")?.state, "blocked", "冻结中的 blocked 节点账面不动");
  close();
});

test("O1 负例：completed / cancelled 调 cancel 仍被拒（feature_terminal，仅错误文案变化）", () => {
  close();
  createFeature({ featureId: "f-done", title: "已完成", state: "completed" });
  createFeature({ featureId: "f-gone", title: "已取消", state: "cancelled" });

  for (const [id, state] of [
    ["f-done", "completed"],
    ["f-gone", "cancelled"],
  ] as const) {
    const fail = mustFail(handleFeatureCancel({ featureId: id }));
    assert.equal(fail.code, "feature_terminal", `${state} 照旧拒 feature_terminal（错误码不变）`);
    assert.equal(getFeature(id)?.state, state, `${state} 被拒时不得改态`);
  }
  // 谓词口径：三终态判定本身不变（`isTerminalFeatureState` 仍认三态）—— 只有 cancel 放行面收窄
  assert.equal(isTerminalFeatureState("failed"), true, "failed 仍是终态（枚举/集合零改动）");
  close();
});

test("O1 负锚「不改边」：转移表 failed 出边恒空 + advance(failed → cancelled) 被拒", () => {
  close();
  createFeature({ featureId: "f-advance", title: "advance 面无归档路径", state: "failed" });

  // ① 表事实：`failed: []` 未被改动
  assert.deepEqual([...allowedTransitions("failed")], [], "转移表不得因 O1 加边");
  // ② 行为事实：归档只走 `a2a_feature_cancel` 操作口，advance 直推被状态机拒
  const fail = mustFail(handleFeatureAdvance({ featureId: "f-advance", to: "cancelled" }));
  assert.equal(fail.code, "feature_transition_invalid", "advance 面不得出现 failed → cancelled");
  assert.equal(getFeature("f-advance")?.state, "failed", "被拒时不得改态");
  close();
});

test("O1 分叉守卫：retry 路径（advance + retryTaskIds）对 failed 仍拒 feature_terminal", () => {
  close();
  createFeature({ featureId: "f-retry", title: "重派守卫不受影响", state: "failed" });
  createTask({ taskId: "R-failed", projectId: "p1", contextId: "c1", state: "failed", featureId: "f-retry" });

  const fail = mustFail(
    handleFeatureAdvance({ featureId: "f-retry", to: "executing", retryTaskIds: ["R-failed"] }),
  );
  assert.equal(
    fail.code,
    "feature_terminal",
    "与 cancel 守卫**刻意分叉**：终态 Feature 的节点不会被调度 ⇒ retry 仍拒三终态",
  );
  assert.equal(getTask("R-failed")?.state, "failed", "被拒时零写入（不抖振）");
  close();
});
