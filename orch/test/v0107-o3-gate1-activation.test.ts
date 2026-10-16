/**
 * v0.10.7 **n6b**（REQ-2026-10-15-05 · 改造文档 §2.1 n3 / §4 锚 ⑤⑥）——
 * 版本 `notstart → active` 的**首触发点前移门①** + 事件 payload 扩键 `trigger` 三档。
 *
 * 被锚定的行为（`bridge/feature-tools.ts` 登记字段特例块内的激活钩子）：
 * 1. **锚 ⑤**：门① 的 `stage`「需求分析 → 改造方案」**登记写落库成功** ⇒ ① 台账转 `active`；
 *    ② `version.activated` payload `trigger = "gate1"`；③ **同键节流已解除** ⇒ 随后 `approve`
 *    兜底触达写口被**幂等**挡下（`activated = false` ∧ `throttled = false`）、事件总数仍为 1
 *    —— 这一枚同时兜住「同键 30s 节流把兜底挡死 / 把首触发挡死」的风险；
 * 2. **守卫负例**：门① 被 `version` 守卫或《需求确认单》守卫拒 ⇒ **零事件、台账仍 `notstart`**
 *    （钉「触发点挂在 `updateFeatureRegistration` 成功**之后**」—— 守卫的拒因 `return` 都在钩子之前）；
 * 3. **生效版号**：门① 同单写 `version` + 抬 `stage` ⇒ 激活的是**写入后**的版号
 *    （钩子显式传 `reg.patch.version ?? feature.version`，不套写前快照的 `activateVersionForFeature`）；
 * 4. **锚 ⑥**：`trigger` 三档字面互异 —— `gate1` / `approve` / `dispatch` 三发分别命中各自 payload
 *    （`approve` / `dispatch` 档用**既有触发点**的生产便捷函数造），并钉 store 层**缺省 `"dispatch"`**
 *    （n3「四处签名穿透 ⇒ 两处既有两参直调零翻案」的依据）。
 *
 * 分工：本文件**只锚激活侧**。删除侧锚 = `test/v0107-o3-version-delete-*.test.ts`（n6a）；
 * 三护栏的节流/不阻断本体 = `test/v0100-o2c-version-status-activation.test.ts`；
 * 门② 六条判据面 = `test/v0105-x-ec93e1bd-approve-gate-preconditions.test.ts`。
 *
 * **夹具纪律**：过门一律走 `handleFeatureCreate` → `advance`（门①）→ `approve` 的既有序列，
 * **不裸写 store**（唯一例外 = 锚 ⑥ 的 store 缺省档探针，它锚的正是 store 层签名）。
 * ⚠ `versionActivator` 是**进程内单例**、节流表不随 `close()` 消解 ⇒ 每发 `freshDb()` 须
 * `clearThrottle()`（n3 加的测试钩子），否则同键被上一发留在 30s 窗口外 = **夹具假红**。
 * 本版 `active` **仅观测面**（不新增执法判据），故本文件不含「`active` 挡什么」的用例。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。零派发、零出站 ⇒ 不 import `bridge/index.ts`。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  close,
  EVENT_VERSION_ACTIVATED,
  getFeature,
  listEvents,
  versionLedgerActivate,
  versionLedgerCreate,
  versionLedgerStatus,
} from "../session/store.js";
import {
  ERR_CONFIRMATION_DOC_REQUIRED,
  ERR_GROUP_VERSION_REQUIRED,
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCreate,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";
import {
  activateVersion,
  activateVersionForFeature,
  versionActivator,
} from "../bridge/versions-activation.js";
import type { FeatureRecord } from "../types.js";

const GROUP = "g-o6b";
const CONF = "doc/v0.10.7/夹具-需求确认单.md";
const DESIGN = "doc/v0.10.7/夹具-改造文档.md";
const DOCS = (...paths: string[]) => JSON.stringify(paths);

after(() => {
  close();
});

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

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

/** 独立库（`notstart` 起点确定）+ 进程内节流表清空 + 给定版号全部建台账行（默认 `notstart`）。 */
function freshDb(...versions: Array<{ ownerGroup: string | null; version: string }>): void {
  close();
  versionActivator.clearThrottle();
  for (const v of versions) {
    mustOk(versionLedgerCreate({ ownerGroup: v.ownerGroup, version: v.version }));
  }
}

/** 本组一枚版号的台账行（多数用例的夹具形态）。 */
function grp(version: string): { ownerGroup: string | null; version: string } {
  return { ownerGroup: GROUP, version };
}

interface ActivatedPayload {
  ownerGroup?: string | null;
  version?: string;
  from?: string;
  to?: string;
  trigger?: string;
}

/** 全部 `version.activated` 事件的 payload（读账唯一面：条数 + 各条字段）。 */
function activatedEvents(): ActivatedPayload[] {
  return listEvents({ limit: 1000 })
    .filter((e) => e.kind === EVENT_VERSION_ACTIVATED)
    .map((e) => (e.payload === null ? {} : (JSON.parse(e.payload) as ActivatedPayload)));
}

/** 某版号的激活事件（至多一条）的 `trigger`；无事件 ⇒ `null`。 */
function triggerOf(version: string): string | null {
  const hits = activatedEvents().filter((e) => e.version === version);
  assert.equal(hits.length, 1, `版号 ${version} 应恰有一条 version.activated 事件（实际 ${hits.length}）`);
  return hits[0]?.trigger ?? null;
}

/** 台账现态（`notstart` / `active` / `released` / `null`=无行）。 */
function statusOf(version: string, ownerGroup: string | null = GROUP): string | null {
  return versionLedgerStatus(ownerGroup, version).status;
}

/** 读回一张卡（夹具核对面）。 */
function readCard(featureId: string): FeatureRecord {
  const feature = getFeature(featureId);
  assert.ok(feature, `夹具卡应可读回：${featureId}`);
  return feature;
}

/** 一张已排期（`version` 非空）∧ `waiting_approval` ∧ `需求分析` ∧ `未发起` 的卡。 */
function seededCard(tag: string, version: string | undefined): string {
  const created = mustOk(handleFeatureCreate({ title: `o6b-${tag}`, version }, GROUP));
  return created.featureId;
}

// ===========================================================================
// 锚 ⑤ · 门① 登记写 = 首触发点（active + trigger=gate1 + 节流已解除 ⇒ approve 幂等零事件）
// ===========================================================================

test("锚⑤ 门① 登记写落库 ⇒ 台账 notstart→active + trigger=gate1；随后 approve 幂等、事件总数仍 1", () => {
  const V = "9.1.0";
  freshDb(grp(V));
  const featureId = seededCard("gate1", V);

  // create 不是触发点（初值恒「需求分析」⇒ 未过门不抬版）
  assert.equal(statusOf(V), "notstart", "建卡后仍 notstart");
  assert.equal(activatedEvents().length, 0, "create 不得产生 version.activated 事件");

  // 门①：`to` = 当前态 ∧ 抬 `stage` ∧ 同单登记确认单（+ 改造文档，为后面 approve 铺满条件）
  const gate1 = mustOk(
    handleFeatureAdvance(
      { featureId, to: "waiting_approval", stage: "改造方案", decisions: DOCS(CONF, DESIGN) },
      GROUP,
    ),
  );
  // 登记写**不改主链**（观测面写入语义）
  assert.equal(gate1.state, "waiting_approval");
  assert.equal(getFeature(featureId)?.stage, "改造方案");
  // ⇒ 首触发点落在这里
  assert.equal(statusOf(V), "active", "门① 登记写成功同轮即抬版");
  const events = activatedEvents();
  assert.equal(events.length, 1);
  const p = events[0] ?? {};
  assert.equal(p.trigger, "gate1");
  assert.equal(p.ownerGroup, GROUP);
  assert.equal(p.version, V);
  assert.equal(p.from, "notstart");
  assert.equal(p.to, "active");

  // **同键节流已解除**：真触达写口（`throttled = false`）而被幂等挡下（`activated = false`）
  // ⇒ 反证「激活成功即解除该键节流」，兜底触发点不会被 30s 窗口静默跳过。
  const feature = getFeature(featureId);
  assert.ok(feature, "夹具卡应可读回");
  const probe = activateVersionForFeature(feature, "approve");
  assert.equal(probe.throttled, false, "门① 命中后同键节流应已解除（否则兜底被静默跳过）");
  assert.equal(probe.activated, false, "已 active ⇒ 写口幂等 no-op");
  assert.equal(probe.status, "active");
  assert.equal(activatedEvents().length, 1, "兜底触达不得再落第二条事件");

  // 续走既有过门序列 ⇒ 真 `approve`（其内部激活此刻被同键节流 / 幂等挡住）同样零事件
  mustOk(handleFeatureAdvance({ featureId, to: "waiting_approval", approval: "待审批" }, GROUP));
  const approved = mustOk(handleFeatureApprove({ featureId }, GROUP));
  assert.equal(approved.state, "version_planning");
  assert.equal(activatedEvents().length, 1, "approve 兜底幂等 ⇒ 事件总数仍为 1");
  assert.equal(triggerOf(V), "gate1", "唯一一条事件的 trigger 必须是 gate1（不是 approve）");

  // 撇开节流表再打一发兜底 ⇒ 零事件是**写口幂等**所致，不是节流遮蔽
  versionActivator.clearThrottle();
  assert.equal(versionLedgerActivate(GROUP, V, "approve").activated, false);
  assert.equal(activatedEvents().length, 1);
});

// ===========================================================================
// 守卫负例 · 触发点挂在「登记写成功之后」（拒 ⇒ 零事件、台账仍 notstart）
// ===========================================================================

test("负例·门① 被 version 守卫拒 ⇒ 零写入、零事件、台账仍 notstart", () => {
  const V = "9.2.0";
  freshDb(grp(V));
  const featureId = seededCard("no-version", undefined); // 未排期（features.version = NULL）

  // 整单零写入（读侧把 NULL 归一为空串 ⇒ 未排期卡的 `version` 读回 `""`）
  const before = readCard(featureId);
  const fail = mustFail(
    handleFeatureAdvance(
      { featureId, to: "waiting_approval", stage: "改造方案", decisions: DOCS(CONF, DESIGN) },
      GROUP,
    ),
  );
  assert.equal(fail.code, ERR_GROUP_VERSION_REQUIRED);
  const f = readCard(featureId);
  assert.equal(f.version, "");
  assert.equal(f.stage, "需求分析");
  assert.equal(f.approval, "未发起");
  assert.equal(f.state, "waiting_approval");
  assert.equal(f.decisions, before.decisions, "拒后 decisions 不动");
  // ⇒ 钩子在写成功之后，守卫未过永不触发（否则等于开出「没过门也抬版」的旁路）
  assert.equal(activatedEvents().length, 0, "拒收不得产生任何 version.activated 事件");
  assert.equal(statusOf(V), "notstart", "台账仍 notstart");
});

test("负例·门① 被《需求确认单》守卫拒 ⇒ 零写入、零事件、台账仍 notstart", () => {
  const V = "9.3.0";
  freshDb(grp(V));
  const featureId = seededCard("no-confirmation", V);

  const before = readCard(featureId);
  const fail = mustFail(
    // 已排期，但 decisions 只登记改造文档 ⇒ 门① 第二前提不成立
    handleFeatureAdvance(
      { featureId, to: "waiting_approval", stage: "改造方案", decisions: DOCS(DESIGN) },
      GROUP,
    ),
  );
  assert.equal(fail.code, ERR_CONFIRMATION_DOC_REQUIRED);
  const f = readCard(featureId);
  assert.equal(f.stage, "需求分析", "拒后 stage 不动");
  assert.equal(f.decisions, before.decisions, "拒后 decisions 不动（登记的档名未落库）");
  assert.equal(activatedEvents().length, 0, "拒收不得产生任何 version.activated 事件");
  assert.equal(statusOf(V), "notstart", "台账仍 notstart");
});

// ===========================================================================
// 生效版号 · 门① 同单写 version + 抬 stage ⇒ 激活**写入后**的版号
// ===========================================================================

test("生效版号·门① 同单排期 + 抬门 ⇒ 激活新版号、旧版号不动（钩子不套写前快照）", () => {
  const V1 = "9.3.1";
  const V2 = "9.3.2";
  freshDb(grp(V1), grp(V2));
  const featureId = seededCard("reschedule", V1);

  mustOk(
    handleFeatureAdvance(
      { featureId, to: "waiting_approval", version: V2, stage: "改造方案", decisions: DOCS(CONF, DESIGN) },
      GROUP,
    ),
  );
  assert.equal(getFeature(featureId)?.version, V2);
  assert.equal(statusOf(V2), "active", "激活的是同单写入后的版号");
  assert.equal(statusOf(V1), "notstart", "写前快照版号不得被抬");
  assert.equal(triggerOf(V2), "gate1");
});

// ===========================================================================
// 锚 ⑥ · trigger 三档字面互异（gate1 / approve / dispatch 各命中各自 payload）
// ===========================================================================

test("锚⑥ trigger 三档字面互异：gate1 / approve / dispatch 三发分别命中各自 payload", () => {
  const VG = "9.4.1"; // gate1 档：真实过门序列
  const VA = "9.4.2"; // approve 档：approve 触发点的既有生产调用（feature-tools.ts）
  const VD = "9.4.3"; // dispatch 档：首个节点派发触发点的既有生产调用（bridge/index.ts）
  freshDb(grp(VG), grp(VA), grp(VD));

  const gateCard = seededCard("t-gate1", VG);
  mustOk(
    handleFeatureAdvance(
      { featureId: gateCard, to: "waiting_approval", stage: "改造方案", decisions: DOCS(CONF, DESIGN) },
      GROUP,
    ),
  );
  assert.equal(activateVersionForFeature({ ownerGroup: GROUP, version: VA }, "approve").activated, true);
  assert.equal(activateVersion(GROUP, VD, "dispatch").activated, true);

  assert.equal(triggerOf(VG), "gate1");
  assert.equal(triggerOf(VA), "approve");
  assert.equal(triggerOf(VD), "dispatch");
  const seen = new Set(activatedEvents().map((e) => e.trigger));
  assert.equal(seen.size, 3, "三档字面必须互异");
  assert.deepEqual([...seen].sort(), ["approve", "dispatch", "gate1"]);
});

test("锚⑥附 store 层缺省 trigger=\"dispatch\"（activator 层必填 ⇒ 两处既有两参直调零翻案）", () => {
  const V = "9.5.0";
  freshDb({ ownerGroup: null, version: V });

  const out = versionLedgerActivate(null, V); // 两参直调 = n3 前签名形态
  assert.equal(out.activated, true);
  assert.equal(triggerOf(V), "dispatch");
});
