import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveDisplayStage,
  deriveActionAffordance,
  deriveTurnBusyAffordance,
  deriveNextStepHint,
  deriveTurnProgress,
  formatWaitedSince,
  traceWaitDisplay,
  terminalFeatureNote,
  UNKNOWN_STAGE_LABEL,
  B13_CALIBRATION_NOTES,
  PARALLELISM_NOTE,
  INFLIGHT_CALIBRATION_NOTE,
  FEATURE_TERMINAL_STATES,
  TURN_STALL_AFTER_MS,
  LATEST_TURN_SUMMARY_MAX,
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
// v0.9.5 C5（改写 BD18 ① + 收口轨 17）：动作区档位 = 唯一规则源
// 「approval 三态各配一个灰按钮」的旧形态**定向推翻**：一次只出一档一个按钮，
// 终态 / 宿主面未装配 ⇒ `null`（整个动作区不渲染）；轮占用 ⇒ 同档 disabled + 原因。
// ---------------------------------------------------------------------------

const ACT = { hostFaceAssembled: true, awaitingAnswer: false, approval: "未发起", state: "waiting_approval" };

test("C5-derive 确认档：approval = 待审批 ⇒ 唯一出确认按钮（去向 confirm · 文案点名「放行执行」）", () => {
  const a = deriveActionAffordance({ ...ACT, approval: "待审批" });
  assert.equal(a.kind, "confirm");
  assert.equal(a.label, "确认改造文档 → 放行执行");
  assert.equal(a.enabled, true);
  assert.equal(a.quiet, false, "确认档是主按钮，不低调");
});

test("C5-derive（负向）无「触发一轮」字样：任何档的按钮文案都是意图句", () => {
  for (const input of [
    { ...ACT, approval: "待审批" },
    { ...ACT, state: "executing", approval: "已通过" },
    { ...ACT, approval: "已通过", state: "reviewing" },
    { ...ACT, registeredDocs: ["甲-需求确认单.md"] },
  ]) {
    assert.doesNotMatch(deriveActionAffordance(input).label, /触发一轮/);
  }
});

test("C5-derive 闲置档：预审卡无任何产出 ⇒「让 agent 继续」（不渲染确认块）", () => {
  const a = deriveActionAffordance({ ...ACT, approval: "未发起" });
  assert.equal(a.kind, "turn");
  assert.equal(a.label, "让 agent 继续");
  assert.equal(a.enabled, true);
});

test("C5-derive 提交档：有待裁待答（awaiting / 已登记产出 / 已有轮次）⇒「提交给 agent」", () => {
  assert.equal(deriveActionAffordance({ ...ACT, awaitingAnswer: true }).label, "提交给 agent");
  assert.equal(deriveActionAffordance({ ...ACT, registeredDocs: ["甲-需求确认单.md"] }).label, "提交给 agent");
  assert.equal(deriveActionAffordance({ ...ACT, latestTurn: { state: "succeeded", summary: "已落文档", at: "x" } }).label, "提交给 agent");
});

test("C5-derive 验收档：reviewing / testing ⇒「反馈验收结论」；executing 的兜底档低调（quiet）", () => {
  assert.equal(deriveActionAffordance({ ...ACT, approval: "已通过", state: "reviewing" }).label, "反馈验收结论");
  assert.equal(deriveActionAffordance({ ...ACT, approval: "已通过", state: "testing" }).label, "反馈验收结论");
  const exec = deriveActionAffordance({ ...ACT, approval: "已通过", state: "executing", latestTurn: null });
  assert.equal(exec.label, "让 agent 继续");
  assert.equal(exec.quiet, true, "执行中的兜底按钮低调保留");
  assert.equal(deriveActionAffordance({ ...ACT, approval: "已通过", state: "integrating" }).quiet, true);
});

test("C5-derive（负向）终态 / 宿主面未装配 ⇒ null：整个动作区不渲染（原「灰态按钮 + 原因」退役）", () => {
  for (const s of FEATURE_TERMINAL_STATES) {
    assert.equal(deriveActionAffordance({ ...ACT, state: s, approval: "待审批" }), null, `${s} 不出动作区`);
  }
  assert.equal(deriveActionAffordance({ ...ACT, hostFaceAssembled: false }), null);
});

test("C5-derive 轮占用 ⇒ 同档 disabled + 原因（占用优先于档位，但**不换按钮文案**）", () => {
  const busy = { turnId: "turn-7", round: 3, state: "running" };
  const a = deriveActionAffordance({ ...ACT, approval: "待审批", turnBusy: true, busyTurn: busy });
  assert.equal(a.kind, "confirm", "仍是确认档");
  assert.equal(a.label, "确认改造文档 → 放行执行");
  assert.equal(a.enabled, false);
  assert.match(a.note, /本轮进行中/);
  assert.match(a.note, /第 3 轮/);
  assert.match(a.note, /turn-7/);
  assert.match(a.note, /防连点重复排队/);
});

test("C5-derive 轮占用（排队）⇒ 原因说「排队中」；占用为真却无轮本体 ⇒ 兜底原因不空", () => {
  const q = deriveActionAffordance({ ...ACT, turnBusy: true, busyTurn: { turnId: "turn-8", round: 1, state: "queued" } });
  assert.match(q.note, /本轮排队中/);
  assert.doesNotMatch(q.note, /本轮进行中/);
  const bare = deriveActionAffordance({ ...ACT, turnBusy: true, busyTurn: null });
  assert.equal(bare.enabled, false);
  assert.match(bare.note, /本轮未结束前不可再次提交/);
});

test("轨14-derive 占用判据本体保留（在飞 / 排队文案可分辨 · 无占用 ⇒ null 不越权）", () => {
  assert.equal(deriveTurnBusyAffordance({ turnId: "turn-7", round: 3, state: "running" }).enabled, false);
  assert.equal(deriveTurnBusyAffordance({ turnId: "turn-8", round: 1, state: "queued" }).enabled, false);
  assert.equal(deriveTurnBusyAffordance(null), null);
});

// ---------------------------------------------------------------------------
// BD18 ②（v0.9.5 C1 升级）：「下一步」引导行
// 判序：宿主面 > 终态 > 待澄清 > approval（轨16 起终态压过待澄清）；卡滞档最低，只在 executing 切
// ---------------------------------------------------------------------------

const NS = { hostFaceAssembled: true, awaitingAnswer: false, approval: "未发起", state: "waiting_approval" };

test("BD18-derive 下一步：宿主面未装配 ⇒ 明示配 orgsDir（优先于一切 approval 分支）", () => {
  const hint = deriveNextStepHint({ ...NS, hostFaceAssembled: false, approval: "待审批" });
  assert.match(hint, /宿主面未装配/);
  assert.match(hint, /orgsDir/);
  assert.match(hint, /动作区/, "文案指向新的动作区（不再说「触发一轮」）");
  assert.doesNotMatch(hint, /触发一轮/);
});

test("BD18-derive 下一步：存在 awaiting_answer 轮 ⇒ 回答优先（压过 approval 分支）", () => {
  const hint = deriveNextStepHint({ ...NS, awaitingAnswer: true, approval: "待审批" });
  assert.match(hint, /回答上方问题/);
});

test("C1-derive 下一步：approval 各态一句「卡在哪 + 等谁 + 做什么」（档位文案表，无术语堆叠）", () => {
  assert.match(deriveNextStepHint({ ...NS, approval: "未发起" }), /点「让 agent 继续」.*需求访谈/);
  assert.match(deriveNextStepHint({ ...NS, approval: "待审批" }), /核对后点「确认改造文档 → 放行执行」/);
  assert.match(deriveNextStepHint({ ...NS, approval: "已通过", state: "executing" }), /已通过.*引擎.*自动接力/);
  assert.match(deriveNextStepHint({ ...NS, approval: "已通过", state: "reviewing" }), /等你验收.*反馈验收结论/);
  assert.match(deriveNextStepHint({ ...NS, approval: "已通过", state: "testing" }), /等 agent 回归/);
});

test("C1-derive 下一步：未发起 ∧ 已有产出（登记文档 / 轮次留痕）⇒ 切「等你裁定 · 提交给 agent」档", () => {
  assert.match(deriveNextStepHint({ ...NS, registeredDocs: ["甲-需求确认单.md"] }), /等你 ——.*点「提交给 agent」/);
  assert.match(deriveNextStepHint({ ...NS, latestTurn: { state: "succeeded", summary: "已落确认单", at: "2026-09-29T10:00:00Z" } }), /等你 ——.*提交给 agent/);
});

test("C1-derive 下一步：事实段（登记产出 / 任务计数 / 最近一轮摘要）有哪项说哪项，全缺 ⇒ 不硬凑", () => {
  const withAll = deriveNextStepHint({
    ...NS,
    registeredDocs: ["甲-需求确认单.md", "甲-改造文档.md"],
    taskCounts: { total: 5, completed: 2, failed: 1 },
    latestTurn: { state: "succeeded", summary: "本轮结论：门禁全绿", at: "2026-09-29T10:00:00Z" },
  });
  assert.match(withAll, /已登记产出 甲-需求确认单\.md · 甲-改造文档\.md/);
  assert.match(withAll, /任务 2\/5 完成 · 失败 1/);
  assert.match(withAll, /最近一轮.*本轮结论：门禁全绿/);
  assert.doesNotMatch(deriveNextStepHint({ ...NS }), /已登记产出|任务 \d+\/\d+|最近一轮/, "无事实 ⇒ 事实段整体缺席");
});

test("C1-derive 下一步：产出 > 3 份只列前三 + 计数；摘要超上限 ⇒ 截断", () => {
  const many = deriveNextStepHint({
    ...NS,
    registeredDocs: ["a.md", "b.md", "c.md", "d.md", "e.md"],
    latestTurn: { state: "succeeded", summary: "长".repeat(LATEST_TURN_SUMMARY_MAX + 30), at: null },
  });
  assert.match(many, /a\.md · b\.md · c\.md 等 5 份/);
  assert.match(many, new RegExp(`长{${String(LATEST_TURN_SUMMARY_MAX)}}…`), "摘要按上限截断，不整段刷页");
});

test("N5-derive 回执卡在场 ⇒ 撤「最近一轮 <state>：<摘要>」后缀，改指回执卡", () => {
  const turn = { state: "succeeded", summary: "本轮结论：门禁全绿", at: "2026-09-29T10:00:00Z" };
  const withReceipt = deriveNextStepHint({ ...NS, latestTurn: turn, receiptPresent: true });
  assert.doesNotMatch(withReceipt, /最近一轮/, "回执卡在场 ⇒ 不再重复状态+摘要");
  assert.doesNotMatch(withReceipt, /本轮结论：门禁全绿/, "摘要不进引导行（全文在回执卡）");
  assert.match(withReceipt, /本轮回执见下方回执卡/);
});

test("N5-derive 回执卡在场 ∧ 未发起有轮 ⇒ 整句改写为「指向待用户行 + 动作区裁定」（非旧句）", () => {
  const turn = { state: "succeeded", summary: "已落确认单", at: "2026-09-29T10:00:00Z" };
  const hint = deriveNextStepHint({ ...NS, latestTurn: turn, receiptPresent: true });
  assert.match(hint, /回执卡「待用户」.*动作区补充框.*点「提交给 agent」/);
  assert.doesNotMatch(hint, /agent 已把产出落到本页/, "旧句改写（与回执卡「待用户」行不重复）");
});

test("N5-derive（负向）receiptPresent 缺省/false ⇒ 旧行为逐字节不变（后缀 + 未发起旧句照旧）", () => {
  const turn = { state: "succeeded", summary: "本轮结论：门禁全绿", at: "2026-09-29T10:00:00Z" };
  const omitted = deriveNextStepHint({ ...NS, latestTurn: turn });
  const explicitFalse = deriveNextStepHint({ ...NS, latestTurn: turn, receiptPresent: false });
  assert.equal(omitted, explicitFalse, "缺省 == 显式 false（未接线调用方不回归）");
  assert.match(omitted, /最近一轮 succeeded：本轮结论：门禁全绿/, "旧后缀保持");
  assert.match(omitted, /agent 已把产出落到本页/, "未发起旧句保持");
});

test("C1-derive 卡滞档：executing ∧ 无在飞轮 ∧ 最近一轮超阈值 ⇒ 建议手动「让 agent 继续」（含距今）", () => {
  const at = "2026-09-29T10:00:00Z";
  const then = Date.parse(at);
  const hint = deriveNextStepHint({
    ...NS,
    approval: "已通过",
    state: "executing",
    latestTurn: { state: "succeeded", summary: "已派下一节点", at },
    turnBusy: false,
    nowMs: then + TURN_STALL_AFTER_MS + 60_000,
  });
  assert.match(hint, /agent 好像没接上/);
  assert.match(hint, /没有进行中的轮/);
  assert.match(hint, /距今 11min/, "「距今」= nowMs - at 单时钟差值（derive 内不读时钟）");
  assert.match(hint, /点动作区的「让 agent 继续」/);
});

test("C1-derive 卡滞档（负向四闸）：阈值内 / 有在飞轮 / 无轮次 / 未给 nowMs ⇒ 一律不切卡滞档", () => {
  const at = "2026-09-29T10:00:00Z";
  const then = Date.parse(at);
  const base = { ...NS, approval: "已通过", state: "executing", latestTurn: { state: "succeeded", summary: "s", at } };
  assert.doesNotMatch(deriveNextStepHint({ ...base, nowMs: then + TURN_STALL_AFTER_MS - 1000 }), /好像没接上/);
  assert.doesNotMatch(deriveNextStepHint({ ...base, nowMs: then + 999 * 3600_000, turnBusy: true }), /好像没接上/);
  assert.doesNotMatch(deriveNextStepHint({ ...base, nowMs: then + 999 * 3600_000, latestTurn: null }), /好像没接上/);
  assert.doesNotMatch(deriveNextStepHint({ ...base, nowMs: undefined }), /好像没接上/, "未下传 nowMs ⇒ 不可判，不猜");
});

test("C1-derive 卡滞阈值 = 定死 10 分钟（本版不引配置键）", () => {
  assert.equal(TURN_STALL_AFTER_MS, 10 * 60 * 1000);
});

test("BD18-derive 下一步：终态先行（completed / cancelled / failed 不再引导点按钮）", () => {
  assert.match(deriveNextStepHint({ ...NS, state: "completed" }), /已完成.*无需再操作/);
  assert.match(deriveNextStepHint({ ...NS, state: "cancelled" }), /已取消.*无需再操作/);
  assert.match(deriveNextStepHint({ ...NS, state: "failed" }), /失败终态.*无需再操作/);
});

test("轨17-derive 终态文案两处不漂移：引导行 = terminalFeatureNote（墓碑行的唯一事实源）", () => {
  for (const s of FEATURE_TERMINAL_STATES) {
    assert.equal(
      deriveNextStepHint({ hostFaceAssembled: true, awaitingAnswer: true, approval: "待审批", state: s }),
      terminalFeatureNote(s),
      `${s} 引导行直接复用终态文案，不另写一份`,
    );
  }
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
  assert.doesNotMatch(hint, /触发一轮/, "兜底行不再引导一个不存在的按钮名");
  assert.match(deriveNextStepHint({ ...NS, approval: "某种未知档" }), /当前 = 某种未知档/);
});

// ---------------------------------------------------------------------------
// REQ-v0.9.2 N7：详情页轮次进度（轮台账派生；位次只在排队时取）
// ---------------------------------------------------------------------------

test("N7-derive 在飞轮 ⇒ 第 N 轮 + 无位次（在飞没有位次可言，不自造 1）", () => {
  assert.deepEqual(
    deriveTurnProgress({ turnId: "turn-9", round: 4, state: "running" }, null),
    { turnId: "turn-9", round: 4, state: "running", position: null },
  );
});

test("N7-derive 排队轮 ⇒ 带位次；位次查不到 ⇒ null（不臆造）", () => {
  const busy = { turnId: "turn-10", round: 2, state: "queued" };
  assert.deepEqual(deriveTurnProgress(busy, 3), { turnId: "turn-10", round: 2, state: "queued", position: 3 });
  assert.deepEqual(deriveTurnProgress(busy, null), { turnId: "turn-10", round: 2, state: "queued", position: null });
});

test("N7-derive（负向）无在飞 / 排队轮 ⇒ null：整行不渲染，不显示「第 0 轮」", () => {
  assert.equal(deriveTurnProgress(null, 1), null);
});
