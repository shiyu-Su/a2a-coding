/**
 * Feature 状态机 / Feature 工具组单测 —— **A 步**（REQ-v0.4.1-2026-09-16-01，改造文档 v5 §2.3 / §2.4）。
 *
 * 覆盖 A 步：
 * - `create` 起点 = `waiting_approval`（主链起点收敛：引擎只做需求实现，Step 0/1 不走引擎）；
 * - `advance` 唯一门：`waiting_approval → executing` **被拒**（`feature_approval_required`），
 *   过审必须经 `a2a_feature_approve`（v0.10.5 起其后继 = `version_planning`，八态新链专项归 O7）；
 * - **错误区分**：`waiting_approval → integrating`（**枚举内**的非法后继）报
 *   `feature_transition_invalid`（状态机层判定）；
 * - **不得误伤** `needs_input → executing`（人工澄清续推属设计内）；
 * - `approve` 仅适用于 `waiting_approval`。
 *
 * 范围说明：A 步之外，本文件另含 **B 步三态退役**、**v0.10.5 O1 词汇扩集逐边断言**（点）、
 * **v0.10.5 O7 转移表全表快照 + 八态主链逐格走位**（面 —— 整张 11 格表一次锁定，漏一格即红）。
 * 端到端新链（含引擎自动 `executing → integrating`、闸门串联、发版闸、回滚摸底）不在本文件，
 * 归 `test/v0105-o1-state-gated-flow.test.ts`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { close, createFeature, createTask, getFeature, getTask, versionLedgerCreate } from "../session/store.js";
import {
  FEATURE_MAIN_CHAIN,
  FEATURE_STATES,
  TERMINAL_FEATURE_STATES,
  allowedTransitions,
  assertTransition,
  canTransition,
  FeatureTransitionError,
  isFeatureState,
  isTerminalFeatureState,
} from "../feature/state-machine.js";
import {
  DEFAULT_FEATURE_APPROVAL,
  DEFAULT_FEATURE_STAGE,
  FEATURE_STAGES,
  isFeatureStage,
} from "../types.js";
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
  // 不再落在状态机判定分支；`waiting_approval` 的出边只有 executing / version_planning / cancelled / failed
  // 四枚 —— v0.10.5 O1 只加 `version_planning` 那一条，其余逐字不动）
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

test("A 步 §4.1.2（v0.10.5 改写）：过门序列后 approve 放行落 version_planning；非 waiting_approval 被拒", () => {
  // v0.10.5 O6 过门序列（新契约定稿）：create（不传 stage/approval）→ advance(version) →
  // advance(stage=改造方案 + approval=待审批) → approve（无父卡落 version_planning；有父卡分流归 O4 专项）
  close();
  versionLedgerCreate({ ownerGroup: null, version: "v0.10.5" });
  const created = mustCreate(handleFeatureCreate({ title: "审批门" }));
  mustChange(handleFeatureAdvance({ featureId: created.featureId, to: "waiting_approval", version: "v0.10.5" }));
  mustChange(
    handleFeatureAdvance({
      featureId: created.featureId,
      to: "waiting_approval",
      stage: "改造方案",
      approval: "待审批",
      // 门① 第二前提（增补 bbc7ea28 O3）：抬 stage 须已登记《需求确认单》档名
      decisions: '["doc/v0.10.5/夹具-需求确认单.md","doc/v0.10.5/夹具-改造文档.md"]',
    }),
  );

  const approved = mustChange(handleFeatureApprove({ featureId: created.featureId }));
  assert.equal(approved.from, "waiting_approval");
  assert.equal(approved.state, "version_planning", "主轨无父 ⇒ approve 后继 = version_planning");
  assert.equal(getFeature(created.featureId)?.state, "version_planning");

  // 已在 version_planning ⇒ 重复 approve 被拒（门只对 waiting_approval 开放）
  const again = mustFail(handleFeatureApprove({ featureId: created.featureId }));
  assert.equal(again.code, "feature_state_invalid");
  close();
});

test("B 步 §4.1.6 + v0.10.5 O1：主链 8 态 —— 枚举 11 态（8 主态 + 3 异常态），三态已退役且不可流转", () => {
  assert.deepEqual(
    [...FEATURE_STATES],
    [
      "waiting_approval",
      "version_planning",
      "decomposing",
      "executing",
      "integrating",
      "testing",
      "reviewing",
      "completed",
      "needs_input",
      "failed",
      "cancelled",
    ],
    "枚举即事实源：退役三态不得再出现；O1 新增两态入列",
  );
  assert.deepEqual(
    [...FEATURE_MAIN_CHAIN],
    [
      "waiting_approval",
      "version_planning",
      "decomposing",
      "executing",
      "integrating",
      "testing",
      "reviewing",
      "completed",
    ],
    "主链 8 态（起点 = 审批门停靠点；两新态插在 approve 之后、executing 之前）",
  );

  for (const retired of ["discussing", "analyzing", "planning"]) {
    assert.equal(isFeatureState(retired), false, `${retired} 已退役 ⇒ 收窄失败（读取即被拒）`);
  }
  // 转移表**键集**由类型约束保证（`Record<FeatureState, …>`）：枚举一扩张，任何缺键 / 多余键即编译错误
  // （typecheck 即证明）；表中亦无三态出边（见上方 FEATURE_STATES / FEATURE_MAIN_CHAIN 断言）。

  // 唯一准入边保留在转移表（`approve` 实际不经 canTransition，但表必须与行为一致）。
  // **`cancelled` 是例外**（v0.9.5 O1）：`failed → cancelled` 由 cancel 守卫放行、**不经表**
  // （表内 `failed: []` 不变 —— 见下方「负锚」用例把「不加边」钉成断言）。
  // v0.10.5 词汇扩集只加边：`executing` 仍在列（既有出边逐字不动），`version_planning` 为新增那一条。
  assert.deepEqual(
    [...allowedTransitions("waiting_approval")],
    ["executing", "version_planning", "cancelled", "failed"],
  );
  assert.deepEqual([...allowedTransitions("needs_input")], ["executing", "cancelled", "failed"]);
  assert.deepEqual([...allowedTransitions("completed")], []);
});

// ---------------------------------------------------------------------------
// v0.10.5 O1（REQ-2026-10-12-03）—— 状态机词汇扩集：两态入列 + `stage` 值域加「验收」（纯加性）
// ---------------------------------------------------------------------------

test("O1 判据 2：新链三格可转（waiting_approval → version_planning → decomposing → executing）", () => {
  assert.equal(canTransition("waiting_approval", "version_planning"), true);
  assert.equal(canTransition("version_planning", "decomposing"), true);
  assert.equal(canTransition("decomposing", "executing"), true);
});

test("O1 判据 3：新态不得跳档（version_planning 直达 executing / decomposing 回退均被拒）", () => {
  assert.equal(canTransition("version_planning", "executing"), false);
  assert.equal(canTransition("waiting_approval", "decomposing"), false);
  assert.equal(canTransition("decomposing", "version_planning"), false);
  assert.equal(canTransition("decomposing", "integrating"), false);
  assert.equal(canTransition("version_planning", "needs_input"), false);
  assert.equal(canTransition("decomposing", "needs_input"), false);
  for (const [from, to] of [
    ["version_planning", "executing"],
    ["decomposing", "integrating"],
  ] as const) {
    assert.throws(
      () => assertTransition(from, to),
      FeatureTransitionError,
      `${from} → ${to} 非法 ⇒ fail-fast`,
    );
  }
});

test("O1 判据 4：纯加性 —— 既有出边逐字不动（唯一准入边保留、executing 出边同集合）", () => {
  // ① 既有准入边仍在转移表内（只加边，不撤边）
  assert.equal(canTransition("waiting_approval", "executing"), true);
  // ② 后段四格的出边集合逐字同改前
  assert.deepEqual(
    [...allowedTransitions("executing")],
    ["integrating", "needs_input", "cancelled", "failed"],
  );
  assert.deepEqual([...allowedTransitions("integrating")], ["testing", "cancelled", "failed"]);
  assert.deepEqual([...allowedTransitions("testing")], ["reviewing", "cancelled", "failed"]);
  assert.deepEqual([...allowedTransitions("reviewing")], ["completed", "cancelled", "failed"]);
  // ③ 新两态各自只带「下一态 + 异常态」，无多余出边
  assert.deepEqual(
    [...allowedTransitions("version_planning")],
    ["decomposing", "cancelled", "failed"],
  );
  assert.deepEqual([...allowedTransitions("decomposing")], ["executing", "cancelled", "failed"]);
});

test("O1 判据 5：新两态非终态（isTerminalFeatureState 三终态集合零改动）", () => {
  assert.equal(isTerminalFeatureState("decomposing"), false);
  assert.equal(isTerminalFeatureState("version_planning"), false);
  assert.deepEqual(
    [...TERMINAL_FEATURE_STATES],
    ["completed", "failed", "cancelled"],
    "终态集合不因词汇扩集而变",
  );
});

test("O1 判据 6：FEATURE_STAGES 恰六值、序为 需求分析/改造方案/改造/回归/验收/发版", () => {
  assert.deepEqual([...FEATURE_STAGES], ["需求分析", "改造方案", "改造", "回归", "验收", "发版"]);
  assert.equal(FEATURE_STAGES.length, 6);
  assert.equal(isFeatureStage("验收"), true);
  // 缺省两常量保留（值不动，只改注释语义）
  assert.equal(DEFAULT_FEATURE_STAGE, "改造方案");
  assert.equal(DEFAULT_FEATURE_APPROVAL, "待审批");
});

test("O1 判据 7：store 零改动可证 —— 新态入列即落库、新 stage 原样读回", () => {
  close();
  const created = createFeature({
    featureId: "f-o1-vocab",
    title: "新态直接落库",
    state: "version_planning",
  });
  assert.equal(created.state, "version_planning");
  assert.equal(getFeature("f-o1-vocab")?.state, "version_planning", "读回同值（无白名单拦新态）");

  createFeature({ featureId: "f-o1-decomp", title: "拆任务中", state: "decomposing" });
  assert.equal(getFeature("f-o1-decomp")?.state, "decomposing");

  createFeature({ featureId: "f-o1-stage", title: "验收 stage", stage: "验收" });
  assert.equal(getFeature("f-o1-stage")?.stage, "验收", "readStage 对新值原样返回、不归缺省");
  close();
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

// ---------------------------------------------------------------------------
// v0.10.5 O7（REQ-2026-10-12-03）—— 转移表**全表快照** + 八态主链逐格走位
// （O1 的逐边断言是「点」，本节是「面」：整张表一次锁定，漏一格即红）
// ---------------------------------------------------------------------------

/**
 * **转移表全表快照**（8 态主链对接）。
 *
 * 每格值 = `feature/state-machine.ts` 的 `TRANSITIONS` 出边**逐字**清单（序也锁：表内数组序 =
 * `allowedTransitions` 的返回序 = 拒因文案「合法后继」的展示序）。
 * 键集由 `FEATURE_STATES` 反向核对 ⇒ **新增态却忘了在本快照登记 ⇒ 红**（`Record<FeatureState,…>`
 * 的编译期穷举只保证「表有该键」，本快照才保证「测试面看清了那一格」）。
 */
const TRANSITION_SNAPSHOT: Record<(typeof FEATURE_STATES)[number], readonly string[]> = {
  waiting_approval: ["executing", "version_planning", "cancelled", "failed"],
  version_planning: ["decomposing", "cancelled", "failed"],
  decomposing: ["executing", "cancelled", "failed"],
  executing: ["integrating", "needs_input", "cancelled", "failed"],
  integrating: ["testing", "cancelled", "failed"],
  testing: ["reviewing", "cancelled", "failed"],
  reviewing: ["completed", "cancelled", "failed"],
  completed: [],
  needs_input: ["executing", "cancelled", "failed"],
  failed: [],
  cancelled: [],
};

test("O7 转移表全表快照：11 格逐字锁定（含三终态恒空、needs_input 只回 executing）", () => {
  // 键集双向核对：快照枚数与枚举枚数同源（表若加态 ⇒ 本断言先红，不靠 typecheck 单腿走路）
  assert.deepEqual(
    Object.keys(TRANSITION_SNAPSHOT).sort(),
    [...FEATURE_STATES].map((s) => s as string).sort(),
    "快照键集 = FEATURE_STATES（不得漏格 / 不得多格）",
  );
  for (const state of FEATURE_STATES) {
    assert.deepEqual(
      [...allowedTransitions(state)],
      [...TRANSITION_SNAPSHOT[state]],
      `${state} 的出边逐字对不上快照`,
    );
  }
  // 终态三格恒空（`cancelled` 一格 O1 起未被任何用例覆盖，本处补上）
  for (const terminal of TERMINAL_FEATURE_STATES) {
    assert.deepEqual([...allowedTransitions(terminal)], [], `${terminal} 是终态 ⇒ 出边恒空`);
    assert.equal(isTerminalFeatureState(terminal), true);
  }
});

test("O7 主链逐格走位：八格相邻全部合法 ∧ 跳格 / 回退 / 后段挂 needs_input 全部非法", () => {
  assert.equal(FEATURE_MAIN_CHAIN.length, 8, "主链 8 态（v0.10.5 定稿）");

  // ① 逐格相邻可转（整条链一次走完）
  for (let i = 0; i + 1 < FEATURE_MAIN_CHAIN.length; i += 1) {
    const from = FEATURE_MAIN_CHAIN[i]!;
    const to = FEATURE_MAIN_CHAIN[i + 1]!;
    assert.equal(canTransition(from, to), true, `${from} → ${to} 应当合法（主链相邻格）`);
  }

  // ② 跳格与回退一律非法（含新两格：不得从 version_planning 跳 executing、不得回退、不得自转）。
  //    **唯一例外** = 起点格上保留的旧准入边 `waiting_approval → executing` —— O1 是「只加边、
  //    不撤边」，该边留在表内（转移表 = 单一事实源），实际由**工具层**的唯一准入守卫拒
  //    （`feature_approval_required`，见 O7 专项判据 4 与 `v0105-o4-…` 的单元断言）。
  for (let i = 0; i < FEATURE_MAIN_CHAIN.length; i += 1) {
    for (let j = 0; j < FEATURE_MAIN_CHAIN.length; j += 1) {
      if (j === i + 1) continue;
      const from = FEATURE_MAIN_CHAIN[i]!;
      const to = FEATURE_MAIN_CHAIN[j]!;
      if (from === "waiting_approval" && to === "executing") {
        assert.equal(canTransition(from, to), true, "旧准入边逐字保留（表面不撤边）");
        continue;
      }
      assert.equal(canTransition(from, to), false, `${from} → ${to} 非相邻格 ⇒ 必须非法`);
    }
  }

  // ③ `needs_input` 只挂 `executing`（进可出唯一，主链无回边）—— 终验段不得挂澄清
  for (const state of FEATURE_MAIN_CHAIN) {
    assert.equal(
      canTransition(state, "needs_input"),
      state === "executing",
      `${state} → needs_input 只在 executing 成立`,
    );
  }
});
