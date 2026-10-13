/**
 * v0.9.0 O1（REQ-v0.9.0-2026-09-24-01 · 改造文档 §3.1 B1″ / B2″）——
 * **登记字段 `stage` / `version` / `approval`：加列 + 写口 + 审批门校验 + 读侧归一**。
 *
 * 锁定的行为面（v0.10.5 O6 按新契约改写：`create` 不收 `stage`/`approval`、初值恒定，
 * 过门序列 = create → advance(version) → advance(stage+approval) → approve）：
 * 1. **初值恒定**：`create` ⇒ `stage = 需求分析` + `approval = 未发起`（引擎硬编码，无兼容分叉）；
 * 2. **闭集校验在 advance 写口**（schema 侧只 `z.string()`）：非法值 ⇒ `feature_invalid_stage` /
 *    `feature_invalid_approval`，且**零写入**；
 * 3. **`advance` 登记特例**：`to` = 当前态 ∧ 带登记字段 ⇒ 只写登记、**主链态不变**
 *    （转移表零改动：不带登记字段时「当前态 → 当前态」仍被拒）；**无终态守卫**
 *    （`completed` 后仍可写 `发版`）；
 * 4. **`approve` 校验 `approval = 待审批`**（不看 `stage`）：不满足 ⇒ `feature_approval_not_ready`，
 *    **不放行、不改状态**；放行时把门落 `已通过`（单向、无回边），后继 = `version_planning`（无父）；
 * 5. **读侧单点归一**：`NULL`（存量行）⇒ 缺省、**不 throw**；脏值在 ctor 一次性归一 + 告警，
 *    二次启动不再告警（幂等）、不改 `updated_at`、不写事件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionStore,
  close,
  createFeature,
  getFeature,
  openStoreDatabase,
  projectVersionCreate,
  updateFeatureRegistration,
  versionLedgerCreate,
} from "../session/store.js";
import { FEATURE_APPROVALS, FEATURE_STAGES } from "../types.js";
import {
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCreate,
  type FeatureCreateSuccess,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";

// 默认存储固定内存库（与 feature-tools.test.ts / state-machine.test.ts 同口径）
process.env["SESSION_DB"] = ":memory:";

type Outcome = { ok: true } | FeatureToolFailure;

function mustOk<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) {
    const f = outcome as unknown as FeatureToolFailure;
    throw new Error(`期望成功，实际失败：${f.code} ${f.error}`);
  }
  return outcome as Extract<T, { ok: true }>;
}

function mustFail(outcome: Outcome): FeatureToolFailure {
  if (outcome.ok) throw new Error("期望失败，实际成功");
  return outcome;
}

/**
 * 抬 `stage` 那一单携带的产出物登记夹具 —— 门① 第二前提（增补 `bbc7ea28` O3）要《需求确认单》、
 * 门② 的 ⑥（增补 `ec93e1bd`）要《改造文档》。两枚必须**同单在册**：`decisions` 是整值替换，
 * 过门时按当场值逐枚查 ⇒ 只登记其一不放行。
 */
const CONFIRMATION_DECISIONS = '["doc/v0.9.0/夹具-需求确认单.md","doc/v0.9.0/夹具-改造文档.md"]';

/**
 * v0.10.5 O6 过门序列（新契约定稿，写死照用）：`create`（**不传** `stage`/`approval`）→
 * `advance(to=当前态, version="<非空>")` → `advance(to=当前态, stage="改造方案", approval="待审批")`
 * → `approve`（无父卡落 `version_planning`）。返回 `featureId`。
 * 前置：版号已 {@link seedLedger}（门① `version` 守卫要求排期先写定，version 必须在 stage 之前落）；
 * 抬 `stage` 那一单同带《需求确认单》登记（增补 `bbc7ea28` 门① 第二前提）。
 */
function readyFeature(title: string, version = "v0.9.0"): string {
  const created = mustOk(handleFeatureCreate({ title }));
  mustOk(handleFeatureAdvance({ featureId: created.featureId, to: "waiting_approval", version }));
  mustOk(
    handleFeatureAdvance({
      featureId: created.featureId,
      to: "waiting_approval",
      stage: "改造方案",
      approval: "待审批",
      decisions: CONFIRMATION_DECISIONS,
    }),
  );
  return created.featureId;
}

/** 过门后落 `version_planning` 的卡（主轨无父 ⇒ `approve` 后继即工序格） */
function approvedFeature(title: string): string {
  const featureId = readyFeature(title);
  mustOk(handleFeatureApprove({ featureId }));
  return featureId;
}

/**
 * 走到 `decomposing` 的卡 —— 出 `version_planning` 格须过**归属门**（v0.10.5 O4 双挂），
 * 故同单携带归属（project 台账行已由 {@link seedProjectVersion} 预建）。
 */
function decomposingFeature(title: string): string {
  const featureId = approvedFeature(title);
  mustOk(
    handleFeatureAdvance({
      featureId,
      to: "decomposing",
      projectVersions: [{ projectId: PROJECT_ID, version: PROJECT_VERSION }],
    }),
  );
  return featureId;
}

/** 走到 `executing` 的卡（归属已在前一格落库 ⇒ 本格出口归属门放行） */
function executingFeature(title: string): string {
  const featureId = decomposingFeature(title);
  mustOk(handleFeatureAdvance({ featureId, to: "executing" }));
  return featureId;
}

/** 归属写的前置：project 台账行（C-15 不隐式建版）；每用例 `close()` 后需重灌 */
const PROJECT_ID = "p-o6";
const PROJECT_VERSION = "1.0.0";
function seedProjectVersion(): void {
  const outcome = projectVersionCreate({
    ownerGroup: null,
    projectId: PROJECT_ID,
    version: PROJECT_VERSION,
  });
  if (!outcome.ok) throw new Error(`project 台账建版失败：${outcome.code} ${outcome.message}`);
}

/** 临时库路径（每次调用唯一，避免并行用例互踩） */
function tmpDbPath(tag: string): string {
  return join(tmpdir(), `a2a-v090-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function rmDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
}

/** 迁移期捕获 `console.error`（照 `store.test.ts` 的 `captureConsoleError` 口径） */
function captureConsoleError<T>(run: () => T, sink: string[]): T {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    sink.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    return run();
  } finally {
    console.error = original;
  }
}

/**
 * v0.10.0 O1 落表后 `features.version` 写口存在性已执法（未命中 ⇒ `orch_version_unknown`）——
 * 用例显式把版号登记进引擎台账（`ownerGroup = null` = 无连接身份档），替代旧「任意自由版号」口径。
 */
function seedLedger(version: string): void {
  const outcome = versionLedgerCreate({ ownerGroup: null, version });
  if (!outcome.ok) throw new Error(`台账建版失败 ${version}：${outcome.code} ${outcome.message}`);
}

// ---------------------------------------------------------------------------
// 1 / 2：create 缺省与显式值、闭集校验
// ---------------------------------------------------------------------------

test("v0.9.0 B1″（v0.10.5 改写）：create 初值恒定 ⇒ 需求分析 / 未发起 / 空版本", () => {
  // 作废锚（原位留理由，O6）：原「向后兼容锚」断言 create 缺省落「改造方案 + 待审批」且建完即可
  // approve —— 该缺省形态所依赖的「create 可传/可缺省 stage、approval」能力已于 v0.10.5 O4 删除，
  // 初值改由引擎硬编码，旧断言对象不复存在；本用例改写为新契约的「初值恒定」锚。
  close();
  const created = mustOk(handleFeatureCreate({ title: "初值恒定" }));
  // 出参回显三字段（恒非空）
  assert.equal(created.stage, "需求分析", "初值恒定 stage = 需求分析");
  assert.equal(created.approval, "未发起", "初值恒定 approval = 未发起");
  assert.equal(created.version, "", "version 缺省空");
  // 落库读回同值
  const stored = getFeature(created.featureId);
  assert.equal(stored?.stage, "需求分析");
  assert.equal(stored?.approval, "未发起");
  assert.equal(stored?.version, "");
  // 新契约：建完不得直接 approve（approval = 未发起 ⇒ 门未过），须先走 advance 登记序列
  assert.equal(
    mustFail(handleFeatureApprove({ featureId: created.featureId })).code,
    "feature_approval_not_ready",
    "初值「未发起」⇒ 直接 approve 被拒（旧「建完即过审」形态已随兼容锚作废）",
  );
  close();
});

test("v0.9.0 B1″：板口径 create 显式传「需求分析 + 未发起」⇒ 回显并落库", () => {
  close();
  seedLedger("v0.9.0"); // v0.10.0：排期写存在性已执法，先登记版号
  const created = mustOk(
    handleFeatureCreate({
      title: "板建需求",
      version: "v0.9.0",
    }),
  );
  assert.equal(created.state, "waiting_approval", "初态不因登记字段而变（登记是观测面）");
  assert.equal(created.stage, "需求分析");
  assert.equal(created.version, "v0.9.0");
  assert.equal(created.approval, "未发起");
  assert.equal(getFeature(created.featureId)?.stage, "需求分析");
  close();
});

test("v0.9.0 B1″（v0.10.5 改写）：闭集校验收口 advance-only ⇒ 非法 stage / approval = feature_invalid_stage / feature_invalid_approval", () => {
  // 作废锚（原位留理由，O6）：原两枚 **create 侧**错误码用例断言的是「create 可传 stage/approval
  // 并闭集校验」这一 v0.10.5 O4 已删除的能力（旧键被 strip、create 侧不再产这两枚码）⇒ 改为 advance-only。
  close();
  const created = mustOk(handleFeatureCreate({ title: "脏 stage" }));
  const badStage = mustFail(
    handleFeatureAdvance({ featureId: created.featureId, to: "waiting_approval", stage: "等待审批" }),
  );
  assert.equal(badStage.code, "feature_invalid_stage");
  assert.match(badStage.error, /需求分析/, "错误文案须给出闭集全清单");

  const badApproval = mustFail(
    handleFeatureAdvance({ featureId: created.featureId, to: "waiting_approval", approval: "已通过门" }),
  );
  assert.equal(badApproval.code, "feature_invalid_approval");
  assert.match(badApproval.error, /未发起 \/ 待审批 \/ 已通过/);
  assert.equal(getFeature(created.featureId)?.stage, "需求分析", "拒绝路径零写入");
  assert.equal(getFeature(created.featureId)?.approval, "未发起", "拒绝路径零写入");
  close();
});

test("v0.9.0 B1″：advance 侧同样闭集校验（非法值 ⇒ 结构化拒绝，登记值与主链态均不变）", () => {
  close();
  const created = mustOk(handleFeatureCreate({ title: "advance 校验" }));
  const bad = mustFail(
    handleFeatureAdvance({ featureId: created.featureId, to: "waiting_approval", stage: "发布" }),
  );
  assert.equal(bad.code, "feature_invalid_stage");
  assert.equal(getFeature(created.featureId)?.stage, "需求分析", "拒绝路径零写入（初值 = 需求分析）");
  assert.equal(getFeature(created.featureId)?.state, "waiting_approval");

  const badApproval = mustFail(
    handleFeatureAdvance({ featureId: created.featureId, to: "executing", approval: "已批" }),
  );
  assert.equal(badApproval.code, "feature_invalid_approval");
  assert.equal(
    getFeature(created.featureId)?.state,
    "waiting_approval",
    "校验在门与流转之前 ⇒ 不得借非法值绕过 approve",
  );
  close();
});

// ---------------------------------------------------------------------------
// 3：advance 登记特例（to = 当前态 ∧ 带登记字段）
// ---------------------------------------------------------------------------

test("v0.9.0 B1″：advance 特例「to = 当前态」只写登记，主链态不变（需求确认门凭据）", () => {
  close();
  seedLedger("v0.9.0");
  const created = mustOk(handleFeatureCreate({ title: "需求确认门" }));
  // v0.10.5 O4 门① version 守卫：stage 由「需求分析」外迁以 version 非空为前提 ⇒ 先排期写 version
  mustOk(handleFeatureAdvance({ featureId: created.featureId, to: "waiting_approval", version: "v0.9.0" }));
  const out = mustOk(
    handleFeatureAdvance({
      featureId: created.featureId,
      to: "waiting_approval", // = 当前态
      stage: "改造方案", // 用户确认需求内容 ⇒ 迁移即动作凭据
      decisions: CONFIRMATION_DECISIONS, // 门① 第二前提（增补 bbc7ea28 O3）
    }),
  );
  assert.equal(out.from, "waiting_approval", "特例不是流转：from === state");
  assert.equal(out.state, "waiting_approval");
  const after = getFeature(created.featureId);
  assert.equal(after?.state, "waiting_approval", "主链态逐字不变");
  assert.equal(after?.stage, "改造方案", "登记字段已写入");
  assert.equal(after?.approval, "未发起", "未提供的登记字段保留原值");
  close();
});

test("v0.9.0 B1″：不带登记字段时「to = 当前态」仍被状态机拒（转移表零改动、无自环）", () => {
  close();
  const created = mustOk(handleFeatureCreate({ title: "防自环" }));
  const noReg = mustFail(handleFeatureAdvance({ featureId: created.featureId, to: "waiting_approval" }));
  assert.equal(noReg.code, "feature_transition_invalid", "特例只在带登记字段时生效");
  close();
});

test("v0.9.0 B1″：登记特例**无终态守卫** ⇒ completed 后仍可写 stage = 发版", () => {
  close();
  seedLedger("v0.9.0");
  seedProjectVersion();
  const featureId = executingFeature("发版登记");
  for (const to of ["integrating", "testing", "reviewing", "completed"] as const) {
    mustOk(handleFeatureAdvance({ featureId, to }));
  }
  assert.equal(getFeature(featureId)?.state, "completed");

  const out = mustOk(handleFeatureAdvance({ featureId, to: "completed", stage: "发版" }));
  assert.equal(out.state, "completed", "终态不被本特例拒绝，也不被改写");
  assert.equal(getFeature(featureId)?.stage, "发版", "发版登记必须写得进去");
  close();
});

test("v0.9.0 B1″：登记字段与合法流转同单生效（advance 带 to = 合法后继 + stage / approval）", () => {
  close();
  seedLedger("v0.9.0"); // 供过门序列与下方排期锁说明
  seedProjectVersion(); // v0.10.5 归属门：出 version_planning 格须有归属
  const featureId = executingFeature("同单");
  // v0.10.0 §7 排期写状态锁：`version` 仅 `需求分析 ∧ 未发起` 可写；本卡已过门 ⇒ 同单不携 version
  // （版本写面覆盖见 v0.10.0 O4/O5 用例），此处锚「登记字段与合法流转同单落库」本身。
  const out = mustOk(
    handleFeatureAdvance({
      featureId,
      to: "integrating",
      stage: "回归",
      approval: "已通过",
    }),
  );
  assert.equal(out.state, "integrating", "合法流转照常");
  const after = getFeature(featureId);
  assert.equal(after?.stage, "回归");
  assert.equal(after?.approval, "已通过", "同单登记字段一并落库");
  close();
});

test("v0.9.0 B1″：过门卡同单写 version ⇒ 排期写状态锁拒（新判定口径，零写入）", () => {
  close();
  seedLedger("v0.9.0"); // 过门序列的排期写
  seedLedger("v0.9.1"); // 存在性先于两把锁 ⇒ 先登记，红点才收敛到状态锁
  seedProjectVersion();
  const featureId = executingFeature("过门后写 version");
  const blocked = mustFail(
    handleFeatureAdvance({
      featureId,
      to: "integrating",
      stage: "回归",
      version: "v0.9.1",
    }),
  );
  assert.equal(blocked.code, "board_schedule_state_locked", "过门卡写 version ⇒ 排期写状态锁拒");
  const after = getFeature(featureId);
  assert.equal(after?.state, "executing", "拒绝 ⇒ 主链态零变更");
  assert.equal(after?.version, "v0.9.0", "拒绝 ⇒ version 零写入（保留过门前排期值）");
  close();
});

test("v0.9.0 B1″：改造期（executing）写登记不抖振状态、不触碰节点面", () => {
  close();
  seedLedger("v0.9.0");
  seedProjectVersion();
  const featureId = executingFeature("静止期登记");
  const out = mustOk(handleFeatureAdvance({ featureId, to: "executing", stage: "改造方案" }));
  assert.equal(out.state, "executing");
  assert.equal(out.rearmed, undefined, "不带 retryTaskIds ⇒ 不产生重派动作");
  assert.equal(getFeature(featureId)?.stage, "改造方案");
  close();
});

// ---------------------------------------------------------------------------
// 3.5：登记特例 **不得静默丢弃同单 Feature Context**（O4 门禁报告 F2 回归锚）
// ---------------------------------------------------------------------------

test("v0.9.0 F2：特例 + note 同传 ⇒ note 真的落库（plan）并回显，主链态仍不变", () => {
  close();
  seedLedger("v0.9.0");
  const featureId = readyFeature("特例带 note"); // v0.10.5 门① version 守卫 ⇒ 序列内先排期
  const out = mustOk(
    handleFeatureAdvance({
      featureId,
      to: "waiting_approval", // = 当前态 ⇒ 走登记特例
      stage: "改造方案",
      note: "需求确认单已落文件，用户 2026-09-24 确认",
    }),
  );
  assert.equal(out.ok, true);
  assert.equal(out.note, "需求确认单已落文件，用户 2026-09-24 确认", "出参回显同合法流转路径");
  const after = getFeature(featureId);
  assert.equal(after?.plan, "需求确认单已落文件，用户 2026-09-24 确认", "F2：note 不得被早退丢弃");
  assert.equal(after?.stage, "改造方案", "同单登记字段照写");
  assert.equal(after?.state, "waiting_approval", "特例仍不做状态流转");
  close();
});

test("v0.9.0 F2：特例 + decisions / contracts 同传 ⇒ 三者一起落库", () => {
  close();
  seedLedger("v0.9.0"); // 存在性执法：先登记版号
  // 排期写状态锁（v0.10.0 §7）：写 version 要求卡处 `需求分析 ∧ 未发起` ⇒ 建卡即此态
  const created = mustOk(
    handleFeatureCreate({ title: "特例带契约" }),
  );
  mustOk(
    handleFeatureAdvance({
      featureId: created.featureId,
      to: "waiting_approval",
      version: "v0.9.0",
      decisions: '{"d":"边界确认第 1 轮"}',
      contracts: '{"c":"advance 特例保留早退"}',
    }),
  );
  const after = getFeature(created.featureId);
  assert.equal(after?.decisions, '{"d":"边界确认第 1 轮"}');
  assert.equal(after?.contracts, '{"c":"advance 特例保留早退"}');
  assert.equal(after?.version, "v0.9.0");
  assert.equal(after?.state, "waiting_approval");
  assert.equal(after?.plan, null, "未传 note ⇒ 不得凭空写 plan（保留原值语义）");
  close();
});

test("v0.9.0 F2：特例只传 Context 不传登记 ⇒ 不走特例（仍被状态机拒）", () => {
  close();
  const created = mustOk(handleFeatureCreate({ title: "只带 note" }));
  const denied = mustFail(
    handleFeatureAdvance({ featureId: created.featureId, to: "waiting_approval", note: "无登记字段" }),
  );
  assert.equal(denied.code, "feature_transition_invalid", "特例入口仍是「带登记字段」，未扩围");
  assert.equal(getFeature(created.featureId)?.plan, null, "拒绝路径零写入");
  close();
});

// ---------------------------------------------------------------------------
// 4：approve 校验 approval = 待审批
// ---------------------------------------------------------------------------

test("v0.9.0 B2″：approval ≠ 待审批 ⇒ approve 结构化拒绝，且不改状态、不落已通过", () => {
  close();
  const created = mustOk(
    handleFeatureCreate({ title: "门未发起" }),
  );
  const denied = mustFail(handleFeatureApprove({ featureId: created.featureId }));
  assert.equal(denied.code, "feature_approval_not_ready");
  const after = getFeature(created.featureId);
  assert.equal(after?.state, "waiting_approval", "拒绝 ⇒ 不得放行");
  assert.equal(after?.approval, "未发起", "拒绝 ⇒ 不得改门状态");
  close();
});

test("v0.9.0 B2″：过审把门落「已通过」（单向、无回边）", () => {
  close();
  seedLedger("v0.9.0");
  const featureId = readyFeature("已批过");
  assert.equal(
    mustOk(handleFeatureApprove({ featureId })).state,
    "version_planning",
    "v0.10.5 主轨无父 ⇒ approve 后继 = version_planning（PjM 工序格）",
  );
  assert.equal(getFeature(featureId)?.approval, "已通过", "过审即落定门状态");
  const again = mustFail(handleFeatureApprove({ featureId }));
  assert.equal(again.code, "feature_state_invalid", "态检查在前：已离门 ⇒ 仍报态不符");
  assert.equal(getFeature(featureId)?.state, "version_planning");
  close();
});

test("v0.9.0 B2″：门看 approval 不看 stage（两维正交）", () => {
  close();
  seedLedger("v0.9.0");
  const created = mustOk(handleFeatureCreate({ title: "正交" }));
  // v0.10.5 门① version 守卫 ⇒ stage 外迁前先排期写 version
  mustOk(handleFeatureAdvance({ featureId: created.featureId, to: "waiting_approval", version: "v0.9.0" }));
  // 只把 stage 推到「改造方案」仍不过审 —— 门只看 approval
  mustOk(
    handleFeatureAdvance({
      featureId: created.featureId,
      to: "waiting_approval",
      stage: "改造方案",
      decisions: CONFIRMATION_DECISIONS, // 门① 第二前提（增补 bbc7ea28 O3）
    }),
  );
  assert.equal(
    mustFail(handleFeatureApprove({ featureId: created.featureId })).code,
    "feature_approval_not_ready",
  );
  // 写完改造文档 ⇒ approval 置待审批，随即放行
  mustOk(
    handleFeatureAdvance({
      featureId: created.featureId,
      to: "waiting_approval",
      approval: "待审批",
    }),
  );
  assert.equal(
    mustOk(handleFeatureApprove({ featureId: created.featureId })).state,
    "version_planning",
    "approval 到位即放行（无父卡落 version_planning）",
  );
  assert.equal(getFeature(created.featureId)?.stage, "改造方案", "approve 不顺手改 stage");
  close();
});

test("v0.9.0 B2″：门校验不越过归属校验顺序（他组仍报归属码，不泄漏门状态）", () => {
  close();
  const created = mustOk(handleFeatureCreate({ title: "他组" }, "g1"));
  const denied = mustFail(handleFeatureApprove({ featureId: created.featureId }, "g2"));
  assert.equal(denied.code, "feature_not_owned");
  close();
});

// ---------------------------------------------------------------------------
// 5：读侧单点归一（NULL / 脏值 / 幂等）
// ---------------------------------------------------------------------------

test("v0.9.0 B1″ 迁移：老库补列后存量行三列 NULL ⇒ 读侧按缺省、不 throw、不告警", () => {
  const dbPath = tmpDbPath("stage-mig");
  const T0 = "2020-01-01T00:00:00.000Z";
  try {
    // 造「无登记三列」的老 features 表（配列改造前的库）
    const legacy = openStoreDatabase(dbPath);
    legacy.exec(
      `CREATE TABLE features (
         feature_id  TEXT PRIMARY KEY,
         state       TEXT NOT NULL,
         title       TEXT NOT NULL,
         requirement TEXT,
         owner_group TEXT,
         created_at  TEXT NOT NULL,
         updated_at  TEXT NOT NULL
       )`,
    );
    legacy
      .prepare(
        `INSERT INTO features (feature_id, state, title, created_at, updated_at)
         VALUES ('legacy-1', 'completed', '存量', ?, ?)`,
      )
      .run(T0, T0);
    legacy.close();

    const warnings: string[] = [];
    const store = captureConsoleError(() => new SessionStore(dbPath), warnings);
    try {
      const got = store.getFeature("legacy-1");
      assert.ok(got !== null, "存量行仍可读回");
      assert.equal(got.stage, "改造方案", "NULL ⇒ 缺省（不 throw）");
      assert.equal(got.approval, "待审批", "NULL ⇒ 缺省（不 throw）");
      assert.equal(got.version, "", "NULL ⇒ 空串");
      assert.equal(got.updatedAt, T0, "补列 / 归一不得改 updated_at");
      assert.deepEqual(warnings, [], "NULL 是合法存量态，不是脏值 ⇒ 不告警");
      assert.equal(store.listEvents().length, 0, "迁移不得写事件");
    } finally {
      store.close();
    }
    // 二次启动：列已存在 ⇒ try-ALTER 命中 catch，不抛（幂等）
    const again = new SessionStore(dbPath);
    assert.equal(again.getFeature("legacy-1")?.stage, "改造方案");
    again.close();
  } finally {
    rmDb(dbPath);
  }
});

test("v0.9.0 B2″ 迁移：库里脏值 ⇒ ctor 一次性归一 + 告警留痕，二次启动静默", () => {
  const dbPath = tmpDbPath("stage-dirty");
  const T0 = "2020-06-01T00:00:00.000Z";
  try {
    new SessionStore(dbPath).close();
    const raw = openStoreDatabase(dbPath);
    raw.exec(
      `INSERT INTO features (feature_id, state, title, stage, version, approval, created_at, updated_at)
       VALUES
         ('d1', 'executing', '脏 stage', '等待审批', 'v1', '待审批', '${T0}', '${T0}'),
         ('d2', 'executing', '脏 approval', '改造', 'v2', '已批', '${T0}', '${T0}'),
         ('clean', 'executing', '合法行', '回归', '', '已通过', '${T0}', '${T0}')`,
    );
    raw.close();

    const warnings: string[] = [];
    const store = captureConsoleError(() => new SessionStore(dbPath), warnings);
    try {
      const dirty = warnings.filter((line) => line.includes("脏值归一"));
      assert.equal(dirty.length, 2, "stage / approval 各一条（合法行不告警）");
      assert.match(dirty[0] ?? "", /features\.stage/, "告警须含列名");
      assert.match(dirty[0] ?? "", /等待审批/, "告警须留痕原值");
      assert.match(dirty[1] ?? "", /features\.approval/);
      assert.match(dirty[1] ?? "", /已批/);
      assert.equal(store.getFeature("d1")?.stage, "改造方案", "脏 stage → 缺省");
      assert.equal(store.getFeature("d2")?.approval, "待审批", "脏 approval → 缺省");
      assert.equal(store.getFeature("d2")?.version, "v2", "version 无闭集：原样保留");
      assert.equal(store.getFeature("clean")?.stage, "回归", "合法值不动");
      assert.equal(store.getFeature("clean")?.approval, "已通过");
      assert.equal(store.getFeature("d1")?.updatedAt, T0, "归一不是活动：不改 updated_at");
      assert.equal(store.listEvents().length, 0, "归一不写事件");
    } finally {
      store.close();
    }

    const warnings2: string[] = [];
    const store2 = captureConsoleError(() => new SessionStore(dbPath), warnings2);
    store2.close();
    assert.deepEqual(warnings2, [], "幂等：二次启动零行命中、不再告警");
  } finally {
    rmDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 存储层写口（updateFeatureRegistration）
// ---------------------------------------------------------------------------

test("v0.9.0 B1″：updateFeatureRegistration 只改提供的字段、不碰 state、未知 Feature ⇒ null", () => {
  close();
  createFeature({
    featureId: "reg-1",
    title: "写口",
    stage: "需求分析",
    version: "v1",
    approval: "未发起",
  });
  const before = getFeature("reg-1");
  assert.ok(before !== null);

  const after = updateFeatureRegistration("reg-1", { stage: "改造方案" });
  assert.equal(after?.stage, "改造方案");
  assert.equal(after?.version, "v1", "未提供的列保留原值");
  assert.equal(after?.approval, "未发起");
  assert.equal(after?.state, before.state, "登记写口不碰状态机态");
  assert.equal(updateFeatureRegistration("nope", { stage: "回归" }), null);
  close();
});

test("v0.9.0：闭集值域与改造文档逐字一致（防自行扩缩）", () => {
  // v0.10.5 O1：`stage` 值域由 5 枚扩为 6 枚（新增「验收」），序照主链后段
  assert.deepEqual([...FEATURE_STAGES], ["需求分析", "改造方案", "改造", "回归", "验收", "发版"]);
  assert.deepEqual([...FEATURE_APPROVALS], ["未发起", "待审批", "已通过"]);
});

/** 出参形状锚：`create` 成功出参恒带三字段（看板 V1 直接消费，不得省略） */
test("v0.9.0 B1″：create 出参三字段恒在（含省略入参时）", async () => {
  close();
  const created = mustOk(handleFeatureCreate({ title: "出参形状" }));
  const keys = Object.keys(created).sort();
  assert.ok(
    keys.includes("stage") && keys.includes("version") && keys.includes("approval"),
    `出参须含登记三字段，实际：${keys.join(" / ")}`,
  );
  const shape: FeatureCreateSuccess = created;
  assert.equal(typeof shape.stage, "string");
  close();
});
