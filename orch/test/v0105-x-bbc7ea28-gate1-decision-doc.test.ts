/**
 * v0.10.5 增补 `bbc7ea28` · **O4** —— 门①（需求确认）**第二前提**（《需求确认单》已登记）的测试锚。
 *
 * 被锚定的行为（`bridge/feature-tools.ts` 的确认单守卫 / 引擎映射 §3 门表 案 (a)）：
 * 「本次携带 `stage` 写」∧「目标值 ≠ 需求分析」∧「当前 stage = 需求分析」∧「可见 `decisions`
 * （已落库 ∪ 本单同写）无 `{topic}-需求确认单.md` 档名」⇒ **整单拒绝、零写入**，
 * 错误码 `feature_confirmation_doc_required`；**唯一豁免 = `retryTaskIds` 重派路径**。
 *
 * 与相邻文件的分工（各锚各面、两文件**分立**不并写）：
 * - `test/v0105-x-bbc7ea28-approval-guard-forward-edges.test.ts`（同增补 **O2**）锚门② 行前提的
 *   **枚举面**；本文件锚门① 第二前提的**判据面**（缺 / 已落库 / 本单同写 / 严格式 / 不误伤 / 豁免）；
 * - `test/v0105-o4-approve-branch-gate-mount.test.ts` 与 `v0105-o1-*` 只把确认单登记当**夹具**
 *   （为正例铺路），不判据化；本文件反过来**不测** `version` 守卫本体，只在「两前提独立成码」
 *   一处碰它的报因顺序。
 *
 * 夹具口径：除末条「两前提独立成码」（刻意留空 `version`）外，每张卡都**已排期**（`version` 非空）
 * ⇒ `version` 守卫的第四条件不成立，判据面上的每一次拒绝都只可能来自「确认单登记」这一前提。
 * 「⑤ 对照面 / ⑥ 对照面」两条负例则反过来钉「放行不是空转」——判据的成立条件由夹具真实铺满。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 * 隔离：`SESSION_DB=:memory:`，每条用例各自 `close()`；不 import `bridge/index.ts`
 * ⇒ 无需 `MACHINES_CONFIG`（本文件零派发、零出站）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_FEATURE_STATE,
  close,
  createFeature,
  createTask,
  getFeature,
  getTask,
  listEvents,
  updateFeatureState,
  updateTaskState,
  versionLedgerCreate,
} from "../session/store.js";
import {
  ERR_CONFIRMATION_DOC_REQUIRED,
  handleFeatureAdvance,
  handleFeatureCreate,
  type FeatureAdvanceSuccess,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";
import type { FeatureRecord } from "../types.js";

const GROUP = "g-x-o4";
const VERSION = "0.10.5";
/** 合法档名（`需求流程.md` §4 命名规范 `{topic}-需求确认单.md`，固定尾段带 hyphen 前缀） */
const DOC_OK = '["doc/v0.10.5/夹具-需求确认单.md"]';
/** 本单携带的**另一份**产出物登记（无确认单档名）—— 令「本单无」这半测的是判据、不是空入参 */
const DOC_OTHER = '["doc/v0.10.5/夹具-改造文档.md"]';
/** 门① 的过门形态：抬 `stage`「改造方案」（登记字段特例，`to` = 当前态、零迁移） */
const PASS_TARGET = "改造方案";

type AdvanceResult = FeatureAdvanceSuccess | FeatureToolFailure;

function mustOk<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) {
    const f = outcome as unknown as FeatureToolFailure;
    throw new Error(`期望成功，实际失败：${f.code} ${f.error}`);
  }
  return outcome as Extract<T, { ok: true }>;
}

function mustFail(outcome: { ok: boolean }): FeatureToolFailure {
  if (outcome.ok) throw new Error("期望被拒，实际放行");
  return outcome as FeatureToolFailure;
}

/** 本 Feature 的状态事件条数（「零状态事件」那半的核对面） */
function stateEvents(featureId: string): number {
  return listEvents({ featureId, limit: 100 }).filter((e) => e.kind === EVENT_FEATURE_STATE).length;
}

/**
 * 整单零写入的核对面：主链态 + 三枚登记字段 + 两枚 Context 字段 + 状态事件条数。
 * 条数（而非「总数为 0」）入面 —— 夹具自身铺态会留下状态事件（⑥ 铺 `executing`），
 * 断言「不新增」才是本前提的零写入语义。
 */
function face(featureId: string): Record<string, unknown> {
  const feature = getFeature(featureId);
  assert.ok(feature, `夹具卡应可读回：${featureId}`);
  return {
    state: feature.state,
    stage: feature.stage,
    approval: feature.approval,
    version: feature.version,
    plan: feature.plan,
    decisions: feature.decisions,
    stateEvents: stateEvents(featureId),
  };
}

/**
 * 一张**已排期、两道门均未过**的卡：`waiting_approval` / `stage=需求分析` / `approval=未发起` /
 * `version` 非空 / `decisions` 空 —— 走真实 create 契约（初值恒定），登记面才有内容可核。
 */
function freshCard(tag: string): FeatureRecord {
  close();
  mustOk(versionLedgerCreate({ ownerGroup: GROUP, version: VERSION }));
  const created = mustOk(handleFeatureCreate({ title: `x-o4-${tag}`, version: VERSION }, GROUP));
  const feature = getFeature(created.featureId);
  assert.ok(feature, "夹具卡应可读回");
  assert.equal(feature.stage, "需求分析", "夹具前置：门① 尚未过");
  assert.equal(feature.approval, "未发起", "夹具前置：两道门均未过");
  assert.equal(feature.version, VERSION, "夹具前置：version 非空 ⇒ 每次拒绝只可能来自第二前提");
  assert.equal(feature.decisions, null, "夹具前置：确认单未登记");
  return feature;
}

/**
 * **只登记 `decisions`、不抬 stage** 的那一单（② / ④ 的「已落库」半边靠它铺）。
 *
 * ⚠ 形态说明：登记字段特例的入边判据 = `hasRegistration`（`stage`/`approval`/`version` 任一）
 * ∧ `to` = 当前态 ⇒ **纯 `decisions`（不带任何登记字段）的 `to` = 当前态在主链上无路径**
 * （落进 `canTransition` 判 `feature_transition_invalid`）。故 Step 0 首步登记在实现上须**同单**
 * 带一枚登记字段 —— 这里带 `stage: 需求分析`（原值重写），同时坐实守卫判据的第二条件：
 * **目标值 = 需求分析 ⇒ 本前提不触发**（否则刚创建的门都没过的卡连档名都登记不进去）。
 */
function registerOnly(featureId: string, decisions: string): AdvanceResult {
  return handleFeatureAdvance(
    { featureId, to: "waiting_approval", stage: "需求分析", decisions },
    GROUP,
  );
}

/** 抬 `stage` 出「需求分析」；`extra` 用于同单夹带 note / decisions */
function raiseStage(
  featureId: string,
  stage: string = PASS_TARGET,
  extra: Record<string, unknown> = {},
): AdvanceResult {
  return handleFeatureAdvance({ featureId, to: "waiting_approval", stage, ...extra }, GROUP);
}

/** 负例的统一断言：错误码字面 + 报因可读 + 整单零写入（含不新增状态事件） */
function assertRejected(
  outcome: AdvanceResult,
  featureId: string,
  before: Record<string, unknown>,
): void {
  const failure = mustFail(outcome);
  assert.equal(failure.code, "feature_confirmation_doc_required", "错误码字面");
  assert.match(failure.error, /需求确认单/, "报因须指向《需求确认单》登记（善后动作可读）");
  assert.equal(stateEvents(featureId), before["stateEvents"], "零状态事件（不新增，夹具铺态不计）");
  assert.deepEqual(
    face(featureId),
    before,
    "整单零写入（state / stage / approval / version / Context 逐字不变）",
  );
}

// ===========================================================================
// 字面锚：导出常量与读面字面不得漂移
// ===========================================================================

test("错误码字面锚：导出常量 = feature_confirmation_doc_required（与 version 守卫那枚独立成码）", () => {
  assert.equal(ERR_CONFIRMATION_DOC_REQUIRED, "feature_confirmation_doc_required");
});

// ===========================================================================
// ① 负锚：缺档名拒（已落库无 ∧ 本单无）
// ===========================================================================

test("① 已落库无 ∧ 本单无 ⇒ 拒为 feature_confirmation_doc_required，整单零写入", () => {
  const card = freshCard("both-missing");
  const before = face(card.featureId);

  // 同单夹带 note + 另一份产出物登记 ⇒ 「本单无」测的是档名判据，不是「decisions 为空」
  const outcome = raiseStage(card.featureId, PASS_TARGET, {
    note: "不该落库的一轮说明",
    decisions: DOC_OTHER,
  });
  assertRejected(outcome, card.featureId, before);

  const after = getFeature(card.featureId);
  assert.equal(after?.plan, null, "note 不落 Feature Context");
  assert.equal(after?.decisions, null, "被拒那单的 decisions 不落 Feature Context");
  assert.equal(after?.stage, "需求分析", "拒后仍「需求分析」⇒ 门① 可善后重试（不是死锁）");
});

// ===========================================================================
// ② 正锚：已落库有档名放行（并集第一半），且登记写自身不被本前提挡
// ===========================================================================

test("② 已落库有档名 ⇒ 放行；只登记 decisions 的那一单不受本前提介入（目标值 = 需求分析 ⇒ 守卫不触发）", () => {
  const card = freshCard("persisted-hit");

  // (a) 先只登记档名（`stage` 原值重写）—— 若守卫在「没抬出需求分析」时也咬人，
  //     Step 0 首步登记就被自己的门打死（档名永远写不进去）
  const registered = mustOk(registerOnly(card.featureId, DOC_OK));
  assert.equal(registered.state, "waiting_approval", "登记写不迁主链");
  assert.equal(getFeature(card.featureId)?.stage, "需求分析", "目标值 = 当前值 ⇒ 逐字不变");
  assert.equal(getFeature(card.featureId)?.decisions, DOC_OK, "已落库半边可读回");

  // (b) 再抬 stage —— 本单**不**再传 decisions ⇒ 判据只读已落库值即放行
  const raised = mustOk(raiseStage(card.featureId));
  assert.equal(raised.state, "waiting_approval", "登记特例零迁移（主链不为过门而动）");
  assert.equal(getFeature(card.featureId)?.stage, PASS_TARGET, "门① 过门");
  assert.equal(
    getFeature(card.featureId)?.decisions,
    DOC_OK,
    "第二次登记写不带 decisions ⇒ 原值不被清空",
  );
});

// ===========================================================================
// ③ 正锚：本单同写档名放行（并集第二半 —— 并集不可省）
// ===========================================================================

test("③ 同一 advance 里「登记确认单 + 抬 stage」⇒ 放行（只看已落库即打死这个既有合法用法）", () => {
  const card = freshCard("pending-hit");
  assert.equal(card.decisions, null, "已落库半边为空 ⇒ 放行只能来自本单同写");

  const raised = mustOk(raiseStage(card.featureId, PASS_TARGET, { decisions: DOC_OK }));
  assert.equal(raised.state, "waiting_approval");
  assert.equal(getFeature(card.featureId)?.stage, PASS_TARGET, "门① 过门");
  assert.equal(
    getFeature(card.featureId)?.decisions,
    DOC_OK,
    "同单 Context 一并落库（F2：早退不丢 Context）",
  );
});

// ===========================================================================
// ④ 负锚：宽松子串不误放（严格式令无 topic 前缀 / 非 hyphen 分隔不构成命中）
// ===========================================================================

test("④ 路径含「需求确认单.md」但不带「-」前缀 ⇒ 不误放（裸文件名 / 下划线，已落库与本单同写各一遍）", () => {
  const looseForms = [
    '["doc/v0.10.5/需求确认单.md"]', // §4 明令禁止的无 topic 前缀形态
    '["doc/v0.10.5/夹具_需求确认单.md"]', // 下划线分隔 ⇒ 不命中 "-需求确认单.md"
  ];
  for (const [i, doc] of looseForms.entries()) {
    // (a) 宽松形态**已落库**（先走合法的只登记那一单）再抬 stage ⇒ 仍拒
    const persisted = freshCard(`loose-persisted-${i}`);
    mustOk(registerOnly(persisted.featureId, doc));
    const persistedBefore = face(persisted.featureId);
    assert.equal(getFeature(persisted.featureId)?.decisions, doc, "夹具：宽松档名已落库");
    assertRejected(raiseStage(persisted.featureId), persisted.featureId, persistedBefore);

    // (b) 宽松形态在**本单同写** ⇒ 仍拒
    const pending = freshCard(`loose-pending-${i}`);
    assertRejected(
      raiseStage(pending.featureId, PASS_TARGET, { decisions: doc }),
      pending.featureId,
      face(pending.featureId),
    );
  }
});

// ===========================================================================
// ⑤ 负锚（不误伤）：`stage = 发版` 的登记写不挂本前提
// ===========================================================================

test("⑤ 已过门卡写 stage = 发版 ⇒ 放行（发版轮不重述产出物，本前提不得反过来追登记）", () => {
  close();
  mustOk(versionLedgerCreate({ ownerGroup: GROUP, version: VERSION }));
  // 发版登记发生在 `completed` 之后；走完整主链要过归属门 ⇒ 从登记面直接铺夹具：
  // 本条只吃「当前 stage ≠ 需求分析」这一条件，主链怎么到的 completed 与守卫无关。
  const seeded = createFeature({
    featureId: "x-o4-release-stage",
    title: "x-o4-发版登记",
    state: "completed",
    ownerGroup: GROUP,
    stage: "验收",
    version: VERSION,
    approval: "已通过",
  });
  assert.equal(seeded.decisions, null, "夹具：名下无任何 decisions 登记");

  const written = mustOk(
    handleFeatureAdvance(
      {
        featureId: seeded.featureId,
        to: "completed",
        stage: "发版",
        note: "§8 步骤 4–7 完成后登记",
      },
      GROUP,
    ),
  );
  assert.equal(written.state, "completed", "登记特例零迁移（终态上仍可写登记 —— 无终态守卫）");
  assert.equal(getFeature(seeded.featureId)?.stage, "发版", "发版登记落笔");
  assert.equal(getFeature(seeded.featureId)?.decisions, null, "放行面不附带任何登记写入");
});

test("⑤ 对照面：判据吃的是「当前 stage = 需求分析」，不是「目标值 = 改造方案」⇒ 未过门写发版照拒", () => {
  const card = freshCard("release-target-from-analysis");
  const before = face(card.featureId);
  const failure = mustFail(raiseStage(card.featureId, "发版"));
  assert.equal(failure.code, "feature_confirmation_doc_required", "目标值换成「发版」仍受本前提管");
  assert.deepEqual(face(card.featureId), before, "整单零写入");
});

// ===========================================================================
// ⑥ 负锚（豁免面）：`retryTaskIds` 重派路径不挂本前提
// ===========================================================================

test("⑥ retryTaskIds 路径 ⇒ 本前提豁免（重派是派发语义操作、不是过门）；同单显式 stage 照原样落笔", () => {
  const card = executingWithFailedNode("retry-exempt");
  const before = face(card.featureId);

  // (a) 对照：同一张卡**去掉 retryTaskIds** ⇒ 同一携带即被本前提拒
  //     ⇒ 下面的放行确实是本参数的豁免面，不是「判据本身不成立」的空转
  assertRejected(
    handleFeatureAdvance(
      { featureId: card.featureId, to: "integrating", stage: PASS_TARGET },
      GROUP,
    ),
    card.featureId,
    before,
  );

  // (b) 豁免面：重派同单携带 stage 写 ∧ 无确认单 ⇒ 不得报本码，且重派照常生效
  const out = mustOk(
    handleFeatureAdvance(
      { featureId: card.featureId, to: "executing", retryTaskIds: ["A"], stage: PASS_TARGET },
      GROUP,
    ),
  );
  assert.equal(out.state, "executing", "重派无状态转移（Feature 态逐字不变）");
  assert.deepEqual(out.rearmed, ["A"], "重派生效（未被本前提挡在守卫层）");
  assert.equal(getTask("A")?.state, "working", "失败节点回到待派发");
  assert.equal(
    getFeature(card.featureId)?.stage,
    PASS_TARGET,
    "豁免 ≠ 丢弃：同单显式登记的 stage 仍落笔",
  );
});

/**
 * 把停靠卡铺成「`executing` ∧ `stage` 仍需求分析 ∧ 一枚 `failed` 节点 A」。
 *
 * ⚠ `stage` **刻意留在需求分析**（正常流转下派生写会抬到「改造」）—— 不留这枚人为形态，本条
 * 只能证明「派生写已让判据第三条件失效」，证不到守卫本身的豁免面。主链态走 store 写口
 * （`executing` 是引擎自动推进的结果，测试里不重跑调度器）。
 */
function executingWithFailedNode(tag: string): FeatureRecord {
  const card = freshCard(tag);
  createTask({
    taskId: "A",
    projectId: "p1",
    contextId: `ctx-${card.featureId}-A`,
    state: "working",
    featureId: card.featureId,
    dependencies: null,
  });
  updateTaskState("A", "failed", null, "boom");
  updateFeatureState(card.featureId, "executing");

  const shaped = getFeature(card.featureId);
  assert.equal(shaped?.state, "executing", "夹具：卡已铺到 executing");
  assert.equal(shaped?.stage, "需求分析", "夹具：stage 未被派生抬走");
  assert.equal(getTask("A")?.state, "failed", "夹具：A 为可重派的失败节点");
  return card;
}

// ===========================================================================
// 两前提独立成码：缺哪报哪，不合并成一枚错误码
// ===========================================================================

test("两前提独立成码：version 空 ∧ 确认单未登记 ⇒ 报 feature_group_version_required（不是本码）", () => {
  close();
  mustOk(versionLedgerCreate({ ownerGroup: GROUP, version: VERSION }));
  // create 不带 version ⇒ 未排期停靠形态
  const created = mustOk(handleFeatureCreate({ title: "x-o4-both-missing" }, GROUP));
  assert.equal(getFeature(created.featureId)?.version, "", "夹具：未排期");
  const before = face(created.featureId);

  const failure = mustFail(raiseStage(created.featureId, PASS_TARGET, { decisions: DOC_OTHER }));
  assert.equal(
    failure.code,
    "feature_group_version_required",
    "version 守卫在前 ⇒ 两缺项时报 version 那一笔（善后动作不同，不得合并成一枚码）",
  );
  assert.equal(getFeature(created.featureId)?.stage, "需求分析", "整单零写入（stage 仍需求分析）");
  assert.deepEqual(face(created.featureId), before, "整单零写入（登记字段与 Context 逐字不变）");
});
