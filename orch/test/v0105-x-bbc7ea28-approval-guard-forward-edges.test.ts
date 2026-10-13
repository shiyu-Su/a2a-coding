/**
 * v0.10.5 增补 `bbc7ea28` · **O2** —— 唯一准入门守卫泛化的**动态枚举**测试锚。
 *
 * 被锚定的行为（`bridge/feature-tools.ts` 门②行前提，REQ-2026-10-12-03 O1 泛化形态）：
 * 从 `waiting_approval` 出发、**在转移表出边内**且**在主链上后于本态**的每一枚前进边，
 * `advance` 一律拒为 `feature_approval_required`；**归档边**（非主链态 ⇒ `indexOf` 为 `-1`）放行。
 *
 * 与既有锚的分工（本文件只补「枚举面」这一格）：
 * - `test/state-machine.test.ts` §4.1.2 / `test/v0105-o1-…` 判据 4 / `test/v0105-o4-…` 边界条
 *   都是**点名 `"executing"` 一枚**的单元断言 ⇒ 转移表将来再给本态加前进边时**不会出声**；
 * - 本文件**不点名任何 `to` 取值** —— 前进边集合由 `allowedTransitions("waiting_approval")` 与
 *   `FEATURE_MAIN_CHAIN` 现场算出，逐个跑同一组断言 ⇒ 新边自动进锚。
 *
 * **复漏负锚（验收判据 ②）**：守卫若退回「按 `to` 取值点名」的旧形态，本态的其余前进边
 * （如 `version_planning`）会被放行 ⇒ 本文件的枚举循环必红。
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
  getFeature,
  listEvents,
  versionLedgerCreate,
} from "../session/store.js";
import { FEATURE_MAIN_CHAIN, allowedTransitions } from "../feature/state-machine.js";
import {
  handleFeatureAdvance,
  handleFeatureCreate,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";
import type { FeatureRecord, FeatureState } from "../types.js";

const GROUP = "g-x-o2";
const PARKED = "waiting_approval";

type Outcome = { ok: boolean } | FeatureToolFailure;

function mustOk<T extends Outcome>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) {
    const f = outcome as FeatureToolFailure;
    throw new Error(`期望成功，实际失败：${f.code} ${f.error}`);
  }
  return outcome as Extract<T, { ok: true }>;
}

function mustFail(outcome: Outcome): FeatureToolFailure {
  if (outcome.ok) throw new Error("期望被拒，实际放行");
  return outcome as FeatureToolFailure;
}

/**
 * 门① 第二前提（本增补 O3）所需的《需求确认单》登记夹具 —— 抬 `stage` 时
 * 可见 decisions（已落库 ∪ 本单同写）须含 `{topic}-需求确认单.md` 档名。
 */
const CONFIRMATION_DECISIONS = '["doc/v0.10.5/夹具-需求确认单.md"]';

/**
 * `waiting_approval` 的**前进边** = 出边 ∩「主链上后于本态」（与守卫同一条判据、同一份事实源）。
 * 不写死清单 —— 写死就等于把「漏掉新边」这件事又变回一次人判。
 */
function forwardEdges(): FeatureState[] {
  const parked = FEATURE_MAIN_CHAIN.indexOf(PARKED);
  return allowedTransitions(PARKED).filter((to) => FEATURE_MAIN_CHAIN.indexOf(to) > parked);
}

/**
 * 一张**停在停靠点、两道门均未过**的卡（`version` 已排期、`stage` 抬「改造方案」、
 * `approval` 置「待审批」）—— 携带非初值的登记字段，才使「整单零写入」这三枚断言有内容可核
 * （初值卡上「不变」可以是被归一掩盖）。
 */
function parkedFeature(tag: string): FeatureRecord {
  // 版号里的 prerelease 段只许 `[0-9A-Za-z.-]` ⇒ 态名的下划线换 hyphen（tag 只作可读区分，不进断言）
  const version = `0.10.5-${tag.replace(/_/g, "-")}.0`;
  mustOk(versionLedgerCreate({ ownerGroup: GROUP, version }));
  const created = mustOk(handleFeatureCreate({ title: `x-o2-${tag}`, version }, GROUP));
  // 门① 第二前提（本增补 O3）：抬 stage 的登记写须带《需求确认单》档名
  mustOk(
    handleFeatureAdvance(
      { featureId: created.featureId, to: PARKED, stage: "改造方案", decisions: CONFIRMATION_DECISIONS },
      GROUP,
    ),
  );
  mustOk(handleFeatureAdvance({ featureId: created.featureId, to: PARKED, approval: "待审批" }, GROUP));

  const feature = getFeature(created.featureId);
  assert.ok(feature, "夹具卡应可读回");
  assert.equal(feature.state, PARKED);
  return feature;
}

// ===========================================================================
// 枚举面本身非空、且与非前进边的分界是「主链行序」而非「取值点名」
// ===========================================================================

test("枚举非空 ∪ 非前进边的出边逐枚都是非主链态（归档面的判据 = indexOf 为 -1，不靠写死名字）", () => {
  const forward = forwardEdges();
  assert.ok(forward.length >= 1, `前进边枚举不得为空集（事实源漂移即红）：${JSON.stringify(forward)}`);
  for (const to of allowedTransitions(PARKED)) {
    if (forward.includes(to)) continue;
    assert.equal(FEATURE_MAIN_CHAIN.indexOf(to), -1, `出边 ${to} 未列进前进边，须是主链外态`);
  }
});

// ===========================================================================
// 逐边正锚：每一枚前进边都拒为 feature_approval_required + 整单零写入
// ===========================================================================

test("逐枚前进边（动态枚举）：advance 拒为 feature_approval_required 且 state/stage/approval 逐字不变、Context 零写入、零状态事件", () => {
  for (const to of forwardEdges()) {
    close();
    // 版号标签里的下划线不属 semver 字符集 ⇒ 换 hyphen（tag 只作可读区分，不进断言）
    const feature = parkedFeature(`fwd-${to.replace(/_/g, "-")}`);
    const featureId = feature.featureId;

    // 同单夹带 note / decisions：守卫位置在**任何写入之前** ⇒ 这两枚也不得落库
    const failure = mustFail(
      handleFeatureAdvance(
        { featureId, to, note: `绕门 ${to}：不该落库的一轮说明`, decisions: "[\"不该落库的决策\"]" },
        GROUP,
      ),
    );
    assert.equal(failure.code, "feature_approval_required", `${PARKED} → ${to} 的错误码`);
    assert.match(failure.error, /a2a_feature_approve/, `${PARKED} → ${to} 须指向唯一准入`);

    const after = getFeature(featureId);
    assert.equal(after?.state, PARKED, `${to}：主链零迁移`);
    assert.equal(after?.stage, feature.stage, `${to}：stage 逐字不变`);
    assert.equal(after?.approval, feature.approval, `${to}：approval 逐字不变`);
    assert.equal(after?.version, feature.version, `${to}：version 逐字不变`);
    assert.equal(after?.plan, feature.plan, `${to}：note 不落 Feature Context`);
    assert.equal(after?.decisions, feature.decisions, `${to}：decisions 不落 Feature Context`);
    assert.equal(
      listEvents({ featureId, limit: 100 }).filter((e) => e.kind === EVENT_FEATURE_STATE).length,
      0,
      `${to}：零状态事件（整单零写入的事件面）`,
    );
  }
});

// ===========================================================================
// 归档边负锚：放行面不得被泛化守卫误伤（§8 收口归档路径依赖它）
// ===========================================================================

test("归档边负锚：waiting_approval → cancelled 仍成功（守卫只管前进边，不得挡收口归档）", () => {
  close();
  const feature = parkedFeature("archive-cancelled");
  const outcome = mustOk(handleFeatureAdvance({ featureId: feature.featureId, to: "cancelled" }, GROUP));
  assert.equal(outcome.state, "cancelled", "归档边放行");
  assert.equal(getFeature(feature.featureId)?.state, "cancelled");
});
