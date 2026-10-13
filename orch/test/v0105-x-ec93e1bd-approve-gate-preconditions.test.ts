/**
 * v0.10.5 增补 `ec93e1bd` · **N3（orch）** —— 门②（改造文档确认）**过门条件六条**的一致性锚。
 *
 * 被锚定的行为（`bridge/feature-tools.ts` 的 `handleFeatureApprove` / 引擎映射 §3 门②行）：
 * 过门判据 = ① `state = waiting_approval` · ② `approval = 待审批`（这两条**原有不动**）·
 * ③ `version` 非空 · ④ `decisions` 含《需求确认单》档名 · ⑤ `stage` **非**「需求分析」·
 * ⑥ `decisions` 含**任一** `-改造文档.md` 档名；串接序 **③→④→⑤→⑥**、位置早于三笔写
 * （主链迁移 / `approval = 已通过` / 版本 `notstart→active`）⇒ 任一不过 ⇒ **零迁移、零写入**。
 *
 * 四枚锚：① 逐条负例（含序锚「同时缺 ⑤⑥ ⇒ 报 ⑤」）② 四条不动断言（原判据不被新四条插队）
 * ③ 轨型无分支（无父 / 增补 / 承接 三形同一判据）④ 合取式一致性（只断 `pending` 空 / 非空）。
 *
 * 与相邻文件的分工：
 * - `test/v0105-x-bbc7ea28-gate1-decision-doc.test.ts` 锚门① 第二前提的**判据面**（`advance` 侧），
 *   本文件锚同一批码在 **`approve` 侧**的挂载；
 * - `test/v0105-o4-approve-branch-gate-mount.test.ts` 锚 `approve` 的**目标态分流**与**原三条判据**
 *   （其 `③` 那发 = 本文件锚 2d 的引用对象），不判据化新增四条；本文件反过来不改其夹具。
 *
 * ⚠ 本文件**不断言**「`pending` 首枚 ⇔ `approve` 拒因」：既有 `derivePendingItems` 的读面序
 * （确认单 → 排期 → `stage` → 改造文档）与门① 守卫序（`version` → 确认单）**存在分歧**，该分歧
 * 已登记为主需求改造文档 §6 非影响性改进点、**本卡不修** ⇒ 锚 4 只吃空 / 非空。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 * 隔离：`SESSION_DB=:memory:`，每发各自 `close()` 重开；不 import `bridge/index.ts`
 * ⇒ 无需 `MACHINES_CONFIG`（本文件零派发、零出站）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前

import { test } from "node:test";
import assert from "node:assert/strict";
import { close, getFeature, versionLedgerCreate, versionLedgerStatus } from "../session/store.js";
import {
  ERR_CONFIRMATION_DOC_REQUIRED,
  ERR_DESIGN_DOC_REQUIRED,
  ERR_GROUP_VERSION_REQUIRED,
  ERR_REQUIREMENT_GATE_NOT_PASSED,
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCreate,
  handleFeatureStatus,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";

const GROUP = "g-x-n3";
const VERSION = "0.10.5";
const CONF = "doc/v0.10.5/夹具-需求确认单.md";
const DESIGN = "doc/v0.10.5/夹具-改造文档.md";
const DOCS = (...paths: string[]) => JSON.stringify(paths);

function mustOk<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) {
    const f = outcome as unknown as FeatureToolFailure;
    throw new Error(`期望成功，实际失败：${f.code} ${f.error}`);
  }
  return outcome as Extract<T, { ok: true }>;
}

function mustFail(outcome: { ok: boolean }): FeatureToolFailure {
  if (outcome.ok) throw new Error("期望被拒，实际放行");
  return outcome as unknown as FeatureToolFailure;
}

/** 独立库 + 一枚**未激活**（`notstart`）版号 —— 锚 2c 的双向判据要求起点确定 */
function freshDb(): void {
  close();
  mustOk(versionLedgerCreate({ ownerGroup: GROUP, version: VERSION }));
}

/** 门②「零迁移、零写入」的核对面 = 主链态 + 三枚登记字段里的两枚 + `decisions` */
function face(featureId: string): Record<string, unknown> {
  const feature = getFeature(featureId);
  assert.ok(feature, `夹具卡应可读回：${featureId}`);
  return { state: feature.state, stage: feature.stage, approval: feature.approval, decisions: feature.decisions };
}

function readPending(featureId: string): string[] {
  const out = handleFeatureStatus({ featureId }, GROUP);
  if (!out.ok) throw new Error(`status 应可读：${out.code} ${out.error}`);
  assert.ok(out.pending, "单查出参应带本阶段明细");
  return out.pending;
}

function approve(featureId: string) {
  return handleFeatureApprove({ featureId }, GROUP);
}

/**
 * 一张 `waiting_approval ∧ approval = 待审批` 的卡，按 `spec` 铺满 / 留下缺项。
 *
 * `raised: false` 时档名经「`to` = 当前态 ∧ `stage` **原值重写**」登记 —— 目标值 = 需求分析 ⇒
 * 门① 两前提不触发（否则连档名都登记不进去）；`raised: true` 时抬 `stage` 出「需求分析」，
 * 该单同受门① 执法 ⇒ 必须带确认单。
 */
function buildCard(
  tag: string,
  spec: { version: boolean; docs: string[]; raised: boolean; parentFeatureId?: string },
): string {
  const args: { title: string; version?: string; parentFeatureId?: string } = { title: `x-n3-${tag}` };
  if (spec.version) args.version = VERSION;
  if (spec.parentFeatureId !== undefined) args.parentFeatureId = spec.parentFeatureId;
  const created = mustOk(handleFeatureCreate(args, GROUP));
  const featureId = created.featureId;
  if (spec.raised) mustOk(handleFeatureAdvance({ featureId, to: "waiting_approval", stage: "改造方案", decisions: DOCS(...spec.docs) }, GROUP));
  else mustOk(handleFeatureAdvance({ featureId, to: "waiting_approval", stage: "需求分析", decisions: DOCS(...spec.docs) }, GROUP));
  mustOk(handleFeatureAdvance({ featureId, to: "waiting_approval", approval: "待审批" }, GROUP));
  assert.equal(getFeature(featureId)?.approval, "待审批", "夹具：①② 已铺满 ⇒ 拒因只可能来自新增四条");
  return featureId;
}

/** 四条新增判据各缺其一的负例表（其余条件由 `buildCard` 真实铺满 ⇒ 不是空转） */
const NEGATIVES: Array<{ miss: string; spec: { version: boolean; docs: string[]; raised: boolean }; code: string }> = [
  { miss: "③（未排期）", spec: { version: false, docs: [CONF, DESIGN], raised: false }, code: "feature_group_version_required" },
  { miss: "④（确认单未登记）", spec: { version: true, docs: [DESIGN], raised: false }, code: "feature_confirmation_doc_required" },
  { miss: "⑤（门① 未过）", spec: { version: true, docs: [CONF, DESIGN], raised: false }, code: "feature_requirement_gate_not_passed" },
  { miss: "⑥（改造文档未登记）", spec: { version: true, docs: [CONF], raised: true }, code: "feature_design_doc_required" },
];

// ===========================================================================
// 锚 1 · 逐条负例：缺哪报哪（四枚码字面 + 串接序 + 零迁移零写入）
// ===========================================================================

test("锚1 逐条负例：缺 ③/④/⑤/⑥ 各拒一发 ⇒ 四枚码字面逐一定位，且 state/stage/approval/decisions 逐字不动", () => {
  for (const neg of NEGATIVES) {
    freshDb();
    const featureId = buildCard(`neg-${neg.miss}`, neg.spec);
    const before = face(featureId);

    const failure = mustFail(approve(featureId));
    assert.equal(failure.code, neg.code, `缺 ${neg.miss} 的错误码字面`);
    assert.match(failure.error, /零迁移/, "报因须写明零迁移（善后可读）");
    assert.deepEqual(face(featureId), before, `缺 ${neg.miss} ⇒ 零迁移零写入`);
  }
});

test("锚1 序锚：同时缺 ⑤⑥ ⇒ 报 ⑤（判据串接序 ③→④→⑤→⑥ 锁死，缺哪报哪、不合并）", () => {
  freshDb();
  const featureId = buildCard("order-5-6", { version: true, docs: [CONF], raised: false });
  const before = face(featureId);

  const failure = mustFail(approve(featureId));
  assert.equal(failure.code, ERR_REQUIREMENT_GATE_NOT_PASSED, "⑤ 在 ⑥ 之前 ⇒ 两缺项时报 ⑤ 那一笔");
  assert.notEqual(failure.code, ERR_DESIGN_DOC_REQUIRED, "不得报成 ⑥（两枚各定一件事，合并会让读账方分不清该补哪一笔）");
  assert.deepEqual(face(featureId), before, "零迁移零写入");
});

test("锚1 字面锚：两枚新导出常量的字面不得漂移（照 bbc7ea28 那发的先例）", () => {
  assert.equal(ERR_REQUIREMENT_GATE_NOT_PASSED, "feature_requirement_gate_not_passed");
  assert.equal(ERR_DESIGN_DOC_REQUIRED, "feature_design_doc_required");
  assert.equal(ERR_GROUP_VERSION_REQUIRED, "feature_group_version_required");
  assert.equal(ERR_CONFIRMATION_DOC_REQUIRED, "feature_confirmation_doc_required");
});

// ===========================================================================
// 锚 2 · 四条不动断言：原两条判据仍在前、新四条没插队、版本面不被拖下水
// ===========================================================================

test("锚2a 非 waiting_approval 仍 feature_state_invalid（新增四条不改第一条判据）", () => {
  freshDb();
  const featureId = buildCard("moved", { version: true, docs: [CONF, DESIGN], raised: true });
  mustOk(approve(featureId));
  assert.equal(getFeature(featureId)?.state, "version_planning", "夹具：已离开 waiting_approval");

  const before = face(featureId);
  const failure = mustFail(approve(featureId));
  assert.equal(failure.code, "feature_state_invalid", "第一条判据字面不变");
  assert.deepEqual(face(featureId), before, "被拒 ⇒ 态与登记字段不动");
});

test("锚2b 一张 approval=未发起 ∧ stage=需求分析 ∧ 无 decisions 的卡 ⇒ 报 feature_approval_not_ready（不是任何新码）", () => {
  freshDb();
  const created = mustOk(handleFeatureCreate({ title: "x-n3-legacy-first", version: VERSION }, GROUP));
  const featureId = created.featureId;
  assert.equal(getFeature(featureId)?.stage, "需求分析", "夹具：门① 未过");
  assert.equal(getFeature(featureId)?.decisions, null, "夹具：无任何产出物登记 ⇒ ③④⑤⑥ 四条全缺");
  const before = face(featureId);

  const failure = mustFail(approve(featureId));
  // 一发同时证两件事：② 仍在新增四条之前（旧负锚不转红）+ 新四条没插队
  assert.equal(failure.code, "feature_approval_not_ready", "原第二条判据先报 ⇒ 新码没插到它前面");
  assert.deepEqual(face(featureId), before, "零迁移零写入");
});

test("锚2c 版本台账双向：被 ⑤ 拒后仍 notstart ⇒ 不造不可回滚半态；同卡补齐放行同轮转 active", () => {
  freshDb();
  const featureId = buildCard("notstart", { version: true, docs: [CONF, DESIGN], raised: false });
  assert.equal(versionLedgerStatus(GROUP, VERSION).status, "notstart", "过审前台账三态起点");

  const failure = mustFail(approve(featureId));
  assert.equal(failure.code, ERR_REQUIREMENT_GATE_NOT_PASSED, "本发只缺 ⑤（两枚档名均在册）");
  assert.equal(versionLedgerStatus(GROUP, VERSION).status, "notstart", "被拒 ⇒ 自动转换未触发（判据早于三笔写）");

  // 补齐 = 同单「抬 stage ∧ 重发全量两枚档名」（纯 decisions 的 `to` = 当前态在主链上无路径）
  mustOk(
    handleFeatureAdvance(
      { featureId, to: "waiting_approval", stage: "改造方案", decisions: DOCS(CONF, DESIGN) },
      GROUP,
    ),
  );
  mustOk(approve(featureId));
  assert.equal(versionLedgerStatus(GROUP, VERSION).status, "active", "放行同轮 notstart→active（既有触发点不转红）");
});

test("锚2d 引用锚：原三条判据「逐字不变」由 v0105-o4-approve-branch-gate-mount.test.ts:255 的 ③ 那发承担，本卡只钉六枚码字面两两互异", () => {
  const legacy = ["feature_state_invalid", "feature_approval_not_ready", "feature_transition_invalid"];
  const added = [ERR_GROUP_VERSION_REQUIRED, ERR_CONFIRMATION_DOC_REQUIRED, ERR_REQUIREMENT_GATE_NOT_PASSED, ERR_DESIGN_DOC_REQUIRED];
  assert.deepEqual(added, ["feature_group_version_required", "feature_confirmation_doc_required", "feature_requirement_gate_not_passed", "feature_design_doc_required"]);
  assert.equal(new Set([...legacy, ...added]).size, legacy.length + added.length, "新增四枚不得顶替任何一枚旧码的字面");
});

// ===========================================================================
// 锚 3 · 轨型无分支：无父 / 增补 / 承接 三形走同一判据
// ===========================================================================

test("锚3a 三形同判据：无父卡 / 增补卡 / 承接卡各打一发「缺 ⑥」⇒ 同一枚 feature_design_doc_required（判据串不读 parentFeatureId）", () => {
  freshDb();
  const parent = mustOk(handleFeatureCreate({ title: "x-n3-parent", version: VERSION }, GROUP)).featureId;

  const shots: Array<{ form: string; featureId: string }> = [
    { form: "无父（主轨）", featureId: buildCard("main-6", { version: true, docs: [CONF], raised: true }) },
    { form: "增补轨", featureId: buildCard("aug-6", { version: true, docs: [CONF], raised: true, parentFeatureId: parent }) },
    { form: "承接轨（亦挂父）", featureId: buildCard("take-6", { version: true, docs: [CONF], raised: true, parentFeatureId: parent }) },
  ];
  for (const shot of shots) {
    const failure = mustFail(approve(shot.featureId));
    assert.equal(failure.code, ERR_DESIGN_DOC_REQUIRED, `${shot.form}：同一缺项报同一码 ⇒ 判据面无轨型分支`);
    assert.equal(face(shot.featureId).approval, "待审批", `${shot.form}：零写入`);
  }
  assert.equal(getFeature(shots[0]!.featureId)?.parentFeatureId, null, "夹具：主轨无父");
  assert.equal(getFeature(shots[1]!.featureId)?.parentFeatureId, parent, "夹具：增补挂父");
  assert.equal(getFeature(shots[2]!.featureId)?.parentFeatureId, parent, "夹具：承接同款挂父（引擎不辨两轨）");
});

test("锚3b 正例放行：主轨 ⇒ version_planning；增补卡把主需求的 -改造文档.md 档名写进自己 decisions ⇒ 放行（跳过 version_planning）", () => {
  freshDb();
  const mainId = buildCard("main-ok", { version: true, docs: [CONF, DESIGN], raised: true });
  assert.equal(mustOk(approve(mainId)).state, "version_planning", "主轨正例放行");

  // 增补轨登记的是**主需求那一份**改造文档（档名同一个串）⇒ ⑥ 命中，判据不带轨型分支
  const augId = buildCard("aug-ok", { version: true, docs: [CONF, DESIGN], raised: true, parentFeatureId: mainId });
  assert.match(getFeature(augId)?.decisions ?? "", /-改造文档\.md/, "夹具：增补卡 decisions 含主需求那一份档名");
  assert.equal(mustOk(approve(augId)).state, "decomposing", "增补轨正例放行（分流只改目标态，不改判据）");

  // 反面对照：同一张增补形卡，decisions **只有确认单** ⇒ 同一缺项同一码
  const augNegId = buildCard("aug-neg", { version: true, docs: [CONF], raised: true, parentFeatureId: mainId });
  assert.equal(mustFail(approve(augNegId)).code, ERR_DESIGN_DOC_REQUIRED, "增补卡缺 ⑥ ⇒ 与主轨同码");
});

// ===========================================================================
// 锚 4 · 合取式一致性（只断 `pending` 空 / 非空）
// ===========================================================================

test("锚4 合取式：pending 非空 ⇔ approve 被拒（四条各一）；pending 空 ∧ approval=待审批 ⇔ 放行", () => {
  for (const neg of NEGATIVES) {
    freshDb();
    const featureId = buildCard(`pend-${neg.miss}`, neg.spec);
    assert.ok(readPending(featureId).length > 0, `缺 ${neg.miss} ⇒ 明细必报欠账（非空半边）`);
    assert.equal(mustFail(approve(featureId)).code, neg.code, `缺 ${neg.miss} ⇒ 拒`);
  }

  freshDb();
  const ready = buildCard("pend-ok", { version: true, docs: [CONF, DESIGN], raised: true });
  assert.deepEqual(readPending(ready), [], "登记欠账清零");
  assert.equal(getFeature(ready)?.approval, "待审批", "合取式另一半：approval = 待审批");
  assert.equal(mustOk(approve(ready)).state, "version_planning", "pending 空 ∧ approval 待审批 ⇒ 六条全过、放行");
});

test("锚4 反向补一发：pending 恰为 [\"design-doc\"] ⇒ 报 feature_design_doc_required（只断这一枚可对齐的欠账，不推「首枚 ⇔ 拒因」）", () => {
  freshDb();
  const featureId = buildCard("pend-design", { version: true, docs: [CONF], raised: true });
  assert.deepEqual(readPending(featureId), ["design-doc"], "读面恰报这一枚欠账");
  assert.equal(mustFail(approve(featureId)).code, ERR_DESIGN_DOC_REQUIRED, "该形态下读面序与守卫序恰好同指");
});
