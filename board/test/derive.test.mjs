import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveDisplayStage,
  deriveConfirmAffordance,
  deriveTurnBusyAffordance,
  deriveTerminalFeatureAffordance,
  deriveNextStepHint,
  formatWaitedSince,
  traceWaitDisplay,
  UNKNOWN_STAGE_LABEL,
  B13_CALIBRATION_NOTES,
  PARALLELISM_NOTE,
  INFLIGHT_CALIBRATION_NOTE,
  FEATURE_TERMINAL_STATES,
  isTerminalFeatureState,
} from "../dist/derive.js";

// ---------------------------------------------------------------------------
// 派生规则（§2.2-9）：引擎态 → 改造 / 回归 / 验收，逐例 + 边界
// ---------------------------------------------------------------------------

test("deriveDisplayStage: 主链派生逐例", () => {
  assert.deepEqual(deriveDisplayStage("executing", "改造方案"), { label: "改造中", basis: "derived" });
  assert.deepEqual(deriveDisplayStage("integrating", "改造方案"), { label: "改造中", basis: "derived" });
  assert.deepEqual(deriveDisplayStage("testing", "改造方案"), { label: "回归中", basis: "derived" });
  assert.deepEqual(deriveDisplayStage("reviewing", "改造方案"), { label: "验收中", basis: "derived" });
  assert.deepEqual(deriveDisplayStage("completed", "改造方案"), { label: "已完成", basis: "derived" });
});

test("deriveDisplayStage: completed + 登记发版 ⇒ 已发版（发版在 completed 之后写入）", () => {
  assert.deepEqual(deriveDisplayStage("completed", "发版"), { label: "已发版", basis: "derived" });
});

test("deriveDisplayStage: 边界态回落登记值（waiting_approval / failed / cancelled / blocked）", () => {
  // waiting_approval：引擎不参与 Step 0/1 ⇒ 显示登记值本身
  assert.deepEqual(deriveDisplayStage("waiting_approval", "需求分析"), { label: "需求分析", basis: "registered" });
  assert.deepEqual(deriveDisplayStage("waiting_approval", "改造方案"), { label: "改造方案", basis: "registered" });
  // failed（仅 DAG 非法 fail-fast）与 cancelled：不派生、原样登记值（引擎态由状态列另行显示）
  assert.deepEqual(deriveDisplayStage("failed", "改造方案"), { label: "改造方案", basis: "registered" });
  assert.deepEqual(deriveDisplayStage("cancelled", "改造方案"), { label: "改造方案", basis: "registered" });
  // blocked 不是 Feature 态（节点态）；防御性按未知值处理 ⇒ 原样登记，不吞不猜
  assert.deepEqual(deriveDisplayStage("blocked", "改造方案"), { label: "改造方案", basis: "registered" });
  // 未知引擎态同样回落登记值
  assert.deepEqual(deriveDisplayStage("whatever", "回归"), { label: "回归", basis: "registered" });
});

test("deriveDisplayStage: needs_input = 改造中 · 待澄清（澄清只发生在 executing 期）", () => {
  assert.deepEqual(deriveDisplayStage("needs_input", "改造方案"), {
    label: "改造中 · 待澄清",
    basis: "derived",
  });
});

test("deriveDisplayStage: 登记缺失（null）⇒ 未知（登记缺失），不臆造缺省", () => {
  const r = deriveDisplayStage("waiting_approval", null);
  assert.equal(r.label, UNKNOWN_STAGE_LABEL);
  assert.equal(r.basis, "registered");
});

// ---------------------------------------------------------------------------
// B13-①：等待时长唯一时钟 = waitedSince（不与任何第二时钟相加）
// ---------------------------------------------------------------------------

test("formatWaitedSince: 单时钟差值 now - waitedSince", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  assert.equal(formatWaitedSince("2026-09-24T11:56:40Z", now), "3m 20s");
  assert.equal(formatWaitedSince("2026-09-24T11:59:50Z", now), "10s");
  assert.equal(formatWaitedSince("2026-09-24T09:00:00Z", now), "3h 0m");
});

test("formatWaitedSince: 缺值 / 非法 / 未来时刻 ⇒ —（不按 0 计、不做二次推断）", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  assert.equal(formatWaitedSince(null, now), "—");
  assert.equal(formatWaitedSince("", now), "—");
  assert.equal(formatWaitedSince("not-a-date", now), "—");
  assert.equal(formatWaitedSince("2026-09-24T12:00:05Z", now), "—");
});

// ---------------------------------------------------------------------------
// B13-③：projectBusy 只反映写门；写门没挡却没开工 ⇒ 读档占位；waitReason 原样
// ---------------------------------------------------------------------------

function node(over = {}) {
  return {
    taskId: "t1",
    projectId: "p",
    state: "submitted",
    lane: "read",
    queueState: "queued",
    waitReason: "read_lane_running",
    blockedOn: [],
    projectBusy: { busy: false, taskId: null, machineId: null },
    readOccupants: [],
    position: null,
    waitedSince: null,
    ...over,
  };
}

test("traceWaitDisplay: 写门占用 ⇒ 标注占用任务；waitReason 原样透出", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const d = traceWaitDisplay(
    node({
      lane: "write",
      waitReason: "project_busy",
      projectBusy: { busy: true, taskId: "t9", machineId: "m1" },
      position: 2,
      waitedSince: "2026-09-24T11:59:00Z",
      blockedOn: ["a", "b"],
    }),
    now,
  );
  assert.equal(d.waitReason, "project_busy");
  assert.equal(d.writeGate, "写门占用（taskId=t9 machine=m1）");
  assert.equal(d.readOccupants, "—");
  assert.equal(d.position, "2");
  assert.equal(d.waited, "1m 0s");
  assert.equal(d.waitedSince, "2026-09-24T11:59:00Z");
  assert.equal(d.blockedOn, "a, b");
});

test("traceWaitDisplay: busy:false 却没开工 ⇒ 显式给出读档占位（readOccupants）", () => {
  const d = traceWaitDisplay(
    node({
      readOccupants: [
        { taskId: "r1", featureId: "F", queueState: "running", machineId: "m1", queuedAt: "q" },
        { taskId: "r2", featureId: null, queueState: "running", machineId: null, queuedAt: null },
      ],
      waitReason: "ready_pending_dispatch",
    }),
    0,
  );
  assert.equal(d.writeGate, "写门未挡");
  assert.match(d.readOccupants, /^读档占位 2 个：r1@m1, r2$/);
  assert.equal(d.waitReason, "ready_pending_dispatch");
});

test("traceWaitDisplay: 终态缺位字段全部显式 —（不臆造）", () => {
  const d = traceWaitDisplay(node({ position: null, waitedSince: null }), 0);
  assert.equal(d.position, "—");
  assert.equal(d.waited, "—");
  assert.equal(d.blockedOn, "—");
});

// ---------------------------------------------------------------------------
// B13-② + §2.2-13 文案常量
// ---------------------------------------------------------------------------

test("口径脚注常量齐备（B13 三条 + 在跑数口径 + 并行度）", () => {
  assert.equal(B13_CALIBRATION_NOTES.length, 3);
  assert.match(B13_CALIBRATION_NOTES[0], /不得相加/);
  assert.match(B13_CALIBRATION_NOTES[1], /inFlightCount/);
  assert.match(B13_CALIBRATION_NOTES[2], /readOccupants/);
  assert.match(INFLIGHT_CALIBRATION_NOTE, /≠ 实际在跑数/);
  assert.match(PARALLELISM_NOTE, /编排侧并行 ≠ 改造侧并行/);
  assert.match(PARALLELISM_NOTE, /maxConcurrentReads ≥ 2/);
  assert.match(PARALLELISM_NOTE, /DAG 拆宽 ≠ 并行/);
  assert.match(PARALLELISM_NOTE, /不承诺「多需求并行」/);
});

// ---------------------------------------------------------------------------
// BD18 ①：确认按钮可用性（按 approval 三态 + 缺值/未知值）
// ---------------------------------------------------------------------------

test("BD18-derive 确认态：待审批 ⇒ 唯一可点档（note 指向 agent 核对语义）", () => {
  const a = deriveConfirmAffordance("待审批");
  assert.equal(a.enabled, true);
  assert.match(a.note, /待审批/);
  assert.match(a.note, /agent 核对/);
});

test("BD18-derive 确认态（负向）：未发起 ⇒ 禁用 + 原因「方案未就绪」+ 下一步指向触发一轮", () => {
  const a = deriveConfirmAffordance("未发起");
  assert.equal(a.enabled, false);
  assert.match(a.note, /方案未就绪/);
  assert.match(a.note, /触发一轮/);
  assert.match(a.note, /待审批/);
});

test("BD18-derive 确认态：已通过 ⇒ 禁用 + 说明已放行、无回边", () => {
  const a = deriveConfirmAffordance("已通过");
  assert.equal(a.enabled, false);
  assert.match(a.note, /已通过/);
  assert.match(a.note, /无需再次确认/);
});

test("BD18-derive 确认态：null / 未知值 ⇒ 禁用且原样透出当前值（不吞不猜）", () => {
  for (const v of [null, "", "某种未知档"]) {
    const a = deriveConfirmAffordance(v);
    assert.equal(a.enabled, false, `approval=${JSON.stringify(v)} 不得可点`);
    assert.match(a.note, /待审批/);
    if (v !== null) assert.ok(a.note.includes(v), "未知值须原样出现在说明里");
  }
});

// ---------------------------------------------------------------------------
// 收口轨 14 ②：写按钮的「轮占用」可用性（在飞 / 排队 ⇒ 禁用 + 原因；无占用 ⇒ null）
// ---------------------------------------------------------------------------

test("轨14-derive 占用（在飞）⇒ 禁用 + 原因含轮次与轮 id（看得见、说明为什么白点）", () => {
  const a = deriveTurnBusyAffordance({ turnId: "turn-7", round: 3, state: "running" });
  assert.equal(a.enabled, false);
  assert.match(a.note, /本轮进行中/);
  assert.match(a.note, /第 3 轮/);
  assert.match(a.note, /turn-7/);
  assert.match(a.note, /防连点重复排队/);
});

test("轨14-derive 占用（排队）⇒ 禁用 + 原因说「排队中」（与在飞文案可分辨）", () => {
  const a = deriveTurnBusyAffordance({ turnId: "turn-8", round: 1, state: "queued" });
  assert.equal(a.enabled, false);
  assert.match(a.note, /本轮排队中/);
  assert.doesNotMatch(a.note, /本轮进行中/);
});

test("轨14-derive（正向锚）无占用轮 ⇒ null：不越权覆盖各按钮自身的既有判据（approval 等）", () => {
  assert.equal(deriveTurnBusyAffordance(null), null);
});

// ---------------------------------------------------------------------------
// 收口轨 17：终态需求的写按钮可用性（判据单一源 = isTerminalFeatureState；非终态 ⇒ null）
// ---------------------------------------------------------------------------

test("轨17-derive 引擎终态三值 ⇒ 禁用 + 与引导行同一份终态文案（两处不得漂移）", () => {
  for (const s of FEATURE_TERMINAL_STATES) {
    const a = deriveTerminalFeatureAffordance(s);
    assert.equal(a.enabled, false, `${s} 终态不得可点`);
    assert.match(a.note, /板上无需再操作/);
    assert.equal(a.note, deriveNextStepHint({ hostFaceAssembled: true, awaitingAnswer: true, approval: "待审批", state: s }), `${s} 原因行 = 引导行文案`);
  }
  assert.match(deriveTerminalFeatureAffordance("completed").note, /引擎态 completed/);
});

test("轨17-derive（正向锚）非终态 / null / 未知态 ⇒ null：交回占用与 approval 既有判据", () => {
  for (const s of ["waiting_approval", "executing", "integrating", "needs_input", null, "some-future-state"]) {
    assert.equal(deriveTerminalFeatureAffordance(s), null, `${s} 非终态不越权`);
  }
});

// ---------------------------------------------------------------------------
// BD18 ②：「下一步」引导行（判序：宿主面 > 终态 > 待澄清 > approval；轨16 起终态压过待澄清）
// ---------------------------------------------------------------------------

const NS = { hostFaceAssembled: true, awaitingAnswer: false, approval: "未发起", state: "waiting_approval" };

test("BD18-derive 下一步：宿主面未装配 ⇒ 明示配 orgsDir（优先于一切 approval 分支）", () => {
  const hint = deriveNextStepHint({ ...NS, hostFaceAssembled: false, approval: "待审批" });
  assert.match(hint, /宿主面未装配/);
  assert.match(hint, /orgsDir/);
});

test("BD18-derive 下一步：存在 awaiting_answer 轮 ⇒ 回答优先（压过 approval 分支）", () => {
  const hint = deriveNextStepHint({ ...NS, awaitingAnswer: true, approval: "待审批" });
  assert.match(hint, /回答上方问题/);
});

test("BD18-derive 下一步：approval 三态逐条", () => {
  assert.match(deriveNextStepHint({ ...NS, approval: "未发起" }), /点「触发一轮」.*需求访谈/);
  assert.match(deriveNextStepHint({ ...NS, approval: "待审批" }), /核对改造文档后点「确认」/);
  assert.match(deriveNextStepHint({ ...NS, approval: "已通过" }), /引擎.*接管执行/);
});

test("BD18-derive 下一步：终态先行（completed / cancelled / failed 不再引导点按钮）", () => {
  assert.match(deriveNextStepHint({ ...NS, state: "completed" }), /已完成.*无需再操作/);
  assert.match(deriveNextStepHint({ ...NS, state: "cancelled" }), /已取消.*无需再操作/);
  assert.match(deriveNextStepHint({ ...NS, state: "failed" }), /失败终态.*无需再操作/);
});

// ---------------------------------------------------------------------------
// 收口轨 16 ①：引擎终态**压过**待澄清引导（陈旧 awaiting 残留不得再出「回答上方问题」）
// ---------------------------------------------------------------------------

test("轨16-derive 下一步：终态 ∧ awaitingAnswer=true ⇒ 仍走终态文案，不出「回答上方问题」", () => {
  for (const [state, re] of [
    ["completed", /已完成.*无需再操作/],
    ["cancelled", /已取消.*无需再操作/],
    ["failed", /失败终态.*无需再操作/],
  ]) {
    const hint = deriveNextStepHint({ ...NS, state, awaitingAnswer: true, approval: "待审批" });
    assert.match(hint, re, `${state} 终态文案照常`);
    assert.doesNotMatch(hint, /回答上方问题/, `${state} 下不得引导回答陈旧问题`);
  }
});

test("轨16-derive 下一步：非终态（executing / needs_input）的 awaiting 引导不回归", () => {
  for (const state of ["executing", "needs_input"]) {
    assert.match(deriveNextStepHint({ ...NS, state, awaitingAnswer: true }), /回答上方问题/);
  }
});

test("轨16-derive isTerminalFeatureState：三值闭集；null / 未知态 ⇒ 非终态（不吞不猜）", () => {
  assert.deepEqual([...FEATURE_TERMINAL_STATES], ["completed", "failed", "cancelled"]);
  for (const s of FEATURE_TERMINAL_STATES) assert.equal(isTerminalFeatureState(s), true);
  for (const s of ["executing", "integrating", "testing", "reviewing", "waiting_approval", "needs_input", "blocked"]) {
    assert.equal(isTerminalFeatureState(s), false, `${s} 不是终态`);
  }
  assert.equal(isTerminalFeatureState(null), false);
  assert.equal(isTerminalFeatureState("some-future-state"), false);
});

test("BD18-derive 下一步：approval 缺值 ⇒ 兜底行透出原值（不臆造分支）", () => {
  const hint = deriveNextStepHint({ ...NS, approval: null });
  assert.match(hint, /审批门值（当前 = 缺失）/);
  assert.match(hint, /触发一轮/);
});
