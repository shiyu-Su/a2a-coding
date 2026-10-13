/**
 * v0.10.5 **O4**（REQ-2026-10-12-03 · 改造文档 §2.1 / §2.6 / §5.3 裁定 3）
 * —— **`approve` 目标态分流 + 归属门双挂 + 挂载集收窄**。
 *
 * 锁定的行为面（= 节点验收判据 1–8，逐条对号）：
 * ① 无父卡 `approve` ⇒ `state = version_planning` ∧ `approval = 已通过`；
 * ② 有父卡两轨（增补 / 承接）同款 ⇒ `state = decomposing`（**跳过** `version_planning`）；
 * ③ `approve` **三条既有判据零改动**（非 `waiting_approval` 拒 / `approval` 须 `待审批` /
 *    放行同轮版本 `notstart→active`）；
 * ④ **归属门双挂**：`version_planning → decomposing` 与 `decomposing → executing` 各两条断言
 *    （归属空 ⇒ 失败且**主链零迁移** / 归属非空 ⇒ 放行），空归属错误码
 *    `feature_attribution_required`（**独立码**，不是 `orch_project_attribution_state_locked`）；
 * ⑤ **挂载集收窄**：`waiting_approval` 上 `mode="execute"` 被结构化拒且**文案不列该态为合法值**；
 *    同一张卡在 `decomposing` 与 `executing` 各登记成功；
 * ⑥ **不提前派发**：`decomposing` 内已登记节点 ⇒ 一次 tick 后 `queue_state` 恒 `NULL`
 *    （`scheduler.ts` 的 `state='executing'` 过滤零改动 = 本条的机器凭据）；
 * ⑦ **异常面不扩**：`decomposing` 期 `to="needs_input"` ⇒ 非法流转拒绝（新两态不挂 `needs_input`）；
 * ⑧ **发版闸按设计挡**：卡停 `version_planning` ⇒ 该版未收口（计入 `open`，**无豁免**）。
 *
 * 另钉一条边界：`waiting_approval` 上 `advance(to="executing")` 仍走 `feature_approval_required`
 * （分流不得顺手把审批门变成可绕）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 * 隔离：`SESSION_DB=:memory:`；`MACHINES_CONFIG` 是 `bridge/index.ts` 的**模块加载期常量**
 * ⇒ 必须在动态 import **之前**写好；`fetch` 换成**一律抛错的计数桩** ⇒ 登记路径任何出站即失败。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  featureProjectListByFeature,
  getFeature,
  getQueuedTask,
  listFeatureTasks,
  projectVersionCreate,
  versionLedgerCreate,
  versionLedgerStatus,
} from "../session/store.js";
import { FeatureScheduler } from "../bridge/scheduler.js";
import { MOUNTABLE_FEATURE_STATES } from "../bridge/register-tools.js";
import {
  ERR_FEATURE_ATTRIBUTION_REQUIRED,
  evaluateReleaseGate,
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCancel,
  handleFeatureCreate,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";
import type { BridgeCore } from "../bridge/index.js";

const GROUP = "g-o4";
const PROJECT = "p1";

// ---------------------------------------------------------------------------
// 零出站计数桩 + 单组机器配置（须在 import bridge/index.js 之前）
// ---------------------------------------------------------------------------

let outboundCount = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  outboundCount += 1;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`登记 / 工序路径不应有任何出站请求：${url}`);
}) as typeof globalThis.fetch;

const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-o4-mount-"));
const CFG_PATH = join(CFG_DIR, "config.json");
process.env["MACHINES_CONFIG"] = CFG_PATH;

writeFileSync(
  CFG_PATH,
  JSON.stringify(
    {
      machines: [{ machineId: "m1" }],
      projectGroup: [{ name: GROUP, members: [{ machineId: "m1", projectId: PROJECT }] }],
    },
    null,
    2,
  ),
  "utf8",
);

const { createCore } = await import("../bridge/index.js");
const core: BridgeCore = createCore(GROUP);

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(CFG_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具助手
// ---------------------------------------------------------------------------

function mustOk<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) {
    const f = outcome as unknown as { code?: string; error?: string };
    throw new Error(`期望成功，实际失败：${f.code} ${f.error}`);
  }
  return outcome as Extract<T, { ok: true }>;
}

function mustFail(outcome: { ok: boolean }): FeatureToolFailure {
  if (outcome.ok) throw new Error("期望失败，实际成功");
  return outcome as unknown as FeatureToolFailure;
}

let seq = 0;
function nextVersion(tag: string): string {
  seq += 1;
  return `0.10.5-${tag}-${seq}.0`;
}

/** 组台账灌版号；project 台账的 `1.0.0` 行全文件只灌一次（重复建版必撞 409） */
let projectRowSeeded = false;
function seedLedgers(version: string, projectVersion = "1.0.0"): void {
  mustOk(versionLedgerCreate({ ownerGroup: GROUP, version }));
  if (projectRowSeeded) return;
  mustOk(projectVersionCreate({ ownerGroup: GROUP, projectId: PROJECT, version: projectVersion }));
  projectRowSeeded = true;
}

/**
 * 抬 `stage` 那一单携带的产出物登记夹具 —— 门① 第二前提（增补 `bbc7ea28` O3）要《需求确认单》、
 * 门② 的 ⑥（增补 `ec93e1bd`）要《改造文档》。两枚必须**同单在册**：`decisions` 是整值替换，
 * 过门时按当场值逐枚查 ⇒ 只登记其一不放行。
 */
const CONFIRMATION_DECISIONS = '["doc/v0.10.5/夹具-需求确认单.md","doc/v0.10.5/夹具-改造文档.md"]';

/**
 * 一张**待过门**的卡（`waiting_approval` + `已通过` 之前的 `待审批`）。
 * v0.10.5 契约：`create` 不收 `stage`/`approval` ⇒ 过门需先经 advance 写登记字段。
 */
function readyFeature(version: string, parentFeatureId?: string): string {
  const created = mustOk(
    handleFeatureCreate(
      parentFeatureId === undefined
        ? { title: `o4-${version}`, version }
        : { title: `o4-${version}`, version, parentFeatureId },
      GROUP,
    ),
  );
  // 门① 第二前提（增补 bbc7ea28 O3）：抬 stage 的登记写须带《需求确认单》档名
  mustOk(
    handleFeatureAdvance(
      {
        featureId: created.featureId,
        to: "waiting_approval",
        stage: "改造方案",
        decisions: CONFIRMATION_DECISIONS,
      },
      GROUP,
    ),
  );
  mustOk(handleFeatureAdvance({ featureId: created.featureId, to: "waiting_approval", approval: "待审批" }, GROUP));
  return created.featureId;
}

/** 一张已放行到**工序格之后**的卡：主轨 = `decomposing`（带归属）、有父 = `decomposing` */
function decomposingFeature(version: string, parentFeatureId?: string): string {
  const featureId = readyFeature(version, parentFeatureId);
  mustOk(handleFeatureApprove({ featureId }, GROUP));
  if (parentFeatureId === undefined) {
    mustOk(
      handleFeatureAdvance(
        { featureId, to: "decomposing", projectVersions: [{ projectId: PROJECT, version: "1.0.0" }] },
        GROUP,
      ),
    );
  }
  return featureId;
}

/** 推进足够多轮，覆盖 tick 内的多个 await */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 从登记成功文案里取本地 taskId */
function taskIdFromText(text: string): string {
  const m = /taskId=([0-9a-fA-F-]{36})/.exec(text);
  const taskId = m?.[1];
  assert.ok(taskId, `登记返回应含 taskId：${text}`);
  return taskId;
}

/** CallOutcome 成功档的文案字段（登记路径恒有 `text`） */
function textOf(outcome: { text?: string }): string {
  return outcome.text ?? "";
}

// ---------------------------------------------------------------------------
// ① 无父卡 ⇒ version_planning
// ---------------------------------------------------------------------------

test("① 无父卡 approve ⇒ state=version_planning ∧ approval=已通过（主轨进 PjM 工序格）", () => {
  const version = nextVersion("main");
  seedLedgers(version);
  const featureId = readyFeature(version);

  const outcome = mustOk(handleFeatureApprove({ featureId }, GROUP));
  assert.equal(outcome.from, "waiting_approval");
  assert.equal(outcome.state, "version_planning", "主轨 approve 后继 = version_planning，不是 executing");

  const feature = getFeature(featureId);
  assert.equal(feature?.state, "version_planning");
  assert.equal(feature?.approval, "已通过");
  assert.equal(feature?.parentFeatureId, null, "判据左半边：无父");
  // 工序格内不落归属（回写后置），approve 自身不写归属
  assert.equal(featureProjectListByFeature(featureId).length, 0);
});

// ---------------------------------------------------------------------------
// ② 有父卡两轨 ⇒ decomposing（各一条断言）
// ---------------------------------------------------------------------------

test("②a 增补轨（parentFeatureId 非空）approve ⇒ 直接 decomposing（跳过 version_planning）", () => {
  const mainVersion = nextVersion("aug-main");
  seedLedgers(mainVersion);
  const mainId = decomposingFeature(mainVersion);

  // 增补轨须与主轨同 Group Version（规范判据），故复用父卡版号
  const featureId = readyFeature(mainVersion, mainId);
  const feature0 = getFeature(featureId);
  assert.equal(feature0?.parentFeatureId, mainId, "判据右半边：有父");

  const outcome = mustOk(handleFeatureApprove({ featureId }, GROUP));
  assert.equal(outcome.state, "decomposing", "增补轨不重走 PjM 工序 ⇒ 不进 version_planning");
  assert.equal(getFeature(featureId)?.approval, "已通过");
});

test("②b 承接轨（亦挂父）approve ⇒ 同样直接 decomposing", () => {
  const mainVersion = nextVersion("take-main");
  seedLedgers(mainVersion);
  // 承接轨的形态事实 = 主轨失败静止后另立的挂子卡；父引用与增补轨同一字段 ⇒ 同款分流
  const mainId = decomposingFeature(mainVersion);
  mustOk(handleFeatureAdvance({ featureId: mainId, to: "executing" }, GROUP));

  // 承接轨与主轨同 Group Version（增补同款），故复用父卡版号
  const featureId = readyFeature(mainVersion, mainId);
  const outcome = mustOk(handleFeatureApprove({ featureId }, GROUP));
  assert.equal(outcome.state, "decomposing");
  assert.equal(getFeature(featureId)?.state, "decomposing");
});

// ---------------------------------------------------------------------------
// ③ approve 三条既有判据零改动
// ---------------------------------------------------------------------------

test("③ approve 三条既有判据逐字不变：非 waiting_approval 拒 / approval 须待审批 / 放行同轮 notstart→active", () => {
  // 判据 1：非 waiting_approval ⇒ feature_state_invalid（分流只改**目标态**，不改本判据）
  const v1 = nextVersion("gates1");
  seedLedgers(v1);
  const already = decomposingFeature(v1);
  const f1 = mustFail(handleFeatureApprove({ featureId: already }, GROUP));
  assert.equal(f1.code, "feature_state_invalid");
  assert.match(f1.error, /waiting_approval/);
  assert.equal(getFeature(already)?.state, "decomposing", "被拒 ⇒ 态不动");

  // 判据 2：approval ≠ 待审批 ⇒ feature_approval_not_ready（create 初值恒「未发起」）
  const v2 = nextVersion("notready");
  seedLedgers(v2);
  const created = mustOk(handleFeatureCreate({ title: `o4-${v2}`, version: v2 }, GROUP));
  const f2 = mustFail(handleFeatureApprove({ featureId: created.featureId }, GROUP));
  assert.equal(f2.code, "feature_approval_not_ready");
  assert.equal(getFeature(created.featureId)?.state, "waiting_approval", "被拒 ⇒ 态不动");
  assert.equal(getFeature(created.featureId)?.approval, "未发起", "被拒 ⇒ 门状态不落地");

  // 判据 3：放行同轮版本 notstart→active（既有断言不转红）
  const v3 = nextVersion("active");
  seedLedgers(v3);
  assert.equal(versionLedgerStatus(GROUP, v3).status, "notstart", "过审前台账三态起点");
  const toApprove = readyFeature(v3);
  mustOk(handleFeatureApprove({ featureId: toApprove }, GROUP));
  assert.equal(versionLedgerStatus(GROUP, v3).status, "active", "approve 放行 = 自动转换触发点");
});

// ---------------------------------------------------------------------------
// ④ 归属门双挂（两枚转移 × 空 / 非空 = 四条）
// ---------------------------------------------------------------------------

test("④a version_planning → decomposing：归属空 ⇒ feature_attribution_required 且主链零迁移", () => {
  const version = nextVersion("gate1-empty");
  seedLedgers(version);
  const featureId = readyFeature(version);
  mustOk(handleFeatureApprove({ featureId }, GROUP));

  const failure = mustFail(handleFeatureAdvance({ featureId, to: "decomposing" }, GROUP));
  assert.equal(failure.code, ERR_FEATURE_ATTRIBUTION_REQUIRED);
  assert.equal(failure.code, "feature_attribution_required", "宿主裁定：独立码字面");
  assert.equal(getFeature(featureId)?.state, "version_planning", "主链零迁移");
  assert.equal(featureProjectListByFeature(featureId).length, 0, "零落库");
});

test("④b version_planning → decomposing：同单带归属 ⇒ 放行（迁移 + 归属同单生效）", () => {
  const version = nextVersion("gate1-ok");
  seedLedgers(version);
  const featureId = readyFeature(version);
  mustOk(handleFeatureApprove({ featureId }, GROUP));

  const outcome = mustOk(
    handleFeatureAdvance(
      { featureId, to: "decomposing", projectVersions: [{ projectId: PROJECT, version: "1.0.0" }] },
      GROUP,
    ),
  );
  assert.equal(outcome.state, "decomposing");
  assert.deepEqual(outcome.attribution, { created: 1, updated: 0, noop: 0 });
});

test("④c decomposing → executing：归属空 ⇒ 同一码拒（兜增补 / 承接轨的出口）", () => {
  const mainVersion = nextVersion("gate2-main");
  seedLedgers(mainVersion);
  const mainId = readyFeature(mainVersion);
  mustOk(handleFeatureApprove({ featureId: mainId }, GROUP));
  mustOk(
    handleFeatureAdvance(
      { featureId: mainId, to: "decomposing", projectVersions: [{ projectId: PROJECT, version: "1.0.0" }] },
      GROUP,
    ),
  );

  // 承接轨：approve 直接落 decomposing ⇒ 本格出口由第二枚守卫兜住
  // （与主轨同 Group Version；归属按 featureId 计 ⇒ 子卡归属集仍为空）
  const childId = readyFeature(mainVersion, mainId);
  mustOk(handleFeatureApprove({ featureId: childId }, GROUP));
  assert.equal(getFeature(childId)?.state, "decomposing");
  assert.equal(featureProjectListByFeature(childId).length, 0, "增补/承接轨过审不落归属初版");

  const failure = mustFail(handleFeatureAdvance({ featureId: childId, to: "executing" }, GROUP));
  assert.equal(failure.code, ERR_FEATURE_ATTRIBUTION_REQUIRED);
  assert.equal(getFeature(childId)?.state, "decomposing", "主链零迁移");
});

test("④d decomposing → executing：已有归属（前格落库）⇒ 放行（不重复要求带参）", () => {
  const version = nextVersion("gate2-ok");
  seedLedgers(version);
  const featureId = decomposingFeature(version);
  assert.equal(featureProjectListByFeature(featureId).length, 1, "归属在上一格已落库");

  const outcome = mustOk(handleFeatureAdvance({ featureId, to: "executing" }, GROUP));
  assert.equal(outcome.state, "executing");
});

test("④e 守卫位置在写入之前：空归属被拒时 Feature Context 零写入", () => {
  const version = nextVersion("gate-nowrite");
  seedLedgers(version);
  const featureId = readyFeature(version);
  mustOk(handleFeatureApprove({ featureId }, GROUP));

  mustFail(
    handleFeatureAdvance({ featureId, to: "decomposing", note: "不该落库的一轮说明" }, GROUP),
  );
  const feature = getFeature(featureId);
  assert.equal(feature?.state, "version_planning");
  // plan 落库的唯一读面 = a2a_feature_status 的 context；此处以 store 行不被推进为凭（态与归属均逐字不变）
  assert.equal(featureProjectListByFeature(featureId).length, 0);
});

// ---------------------------------------------------------------------------
// ⑤ 挂载集收窄
// ---------------------------------------------------------------------------

test("⑤ 挂载常量 = executing / decomposing；waiting_approval 被拒且文案不列其为合法值", () => {
  assert.deepEqual([...MOUNTABLE_FEATURE_STATES], ["executing", "decomposing"]);

  const version = nextVersion("mount");
  seedLedgers(version);
  const featureId = readyFeature(version); // waiting_approval，未过门

  const failure = mustFail(
    core.registerFeatureNode(PROJECT, "节点正文", undefined, featureId, []),
  );
  assert.equal(failure.code, "feature_state_invalid");
  const listed = /仅 (.+?) 可挂载任务/.exec(failure.error);
  assert.ok(listed, `拒因应含合法挂载态清单：${failure.error}`);
  assert.equal(listed[1], "executing / decomposing", "合法值清单逐字不含 waiting_approval");
  assert.equal(outboundCount, 0, "被拒节点零出站");
  assert.equal(listFeatureTasks(featureId, { limit: 100 }).length, 0, "被拒节点绝不入库");
});

test("⑤b 同一张卡在 decomposing 与 executing 各登记成功", () => {
  const version = nextVersion("mount-ok");
  seedLedgers(version);
  const featureId = decomposingFeature(version); // 已带归属，处于 decomposing

  const inDecomposing = mustOk(
    core.registerFeatureNode(PROJECT, "拆任务格内登记的节点", undefined, featureId, []),
  );
  assert.match(textOf(inDecomposing), /已登记 Feature 任务节点/, "decomposing 为合法挂载态");

  mustOk(handleFeatureAdvance({ featureId, to: "executing" }, GROUP));
  const inExecuting = mustOk(
    core.registerFeatureNode(PROJECT, "执行期增量节点", undefined, featureId, []),
  );
  assert.match(textOf(inExecuting), /已登记 Feature 任务节点/, "executing 仍为合法挂载态（执行期增量）");
  assert.equal(listFeatureTasks(featureId, { limit: 100 }).length, 2, "两枚节点均在同一 Feature 下");
  /**
   * 收尾 cancel：本条刻意把卡推进到 `executing`，若留在 executing，后续用例里自建的
   * `FeatureScheduler` tick 会认领这两枚节点（跨用例串扰）。cancel 只停派发，不动断言。
   */
  mustOk(handleFeatureCancel({ featureId }, GROUP));
});

// ---------------------------------------------------------------------------
// ⑥ 不提前派发（scheduler 的 executing 过滤零改动）
// ---------------------------------------------------------------------------

test("⑥ decomposing 内已登记节点 ⇒ 一次 tick 后 queue_state 恒 NULL 且零派发", async () => {
  const version = nextVersion("no-early-dispatch");
  seedLedgers(version);
  const featureId = decomposingFeature(version);
  const registered = mustOk(core.registerFeatureNode(PROJECT, "待派节点", undefined, featureId, []));
  const taskId = taskIdFromText(textOf(registered));

  const dispatched: string[] = [];
  const scheduler = new FeatureScheduler({
    dispatch: async (node) => {
      dispatched.push(node.taskId);
      return { ok: true, settled: { state: "completed" as const, text: "stub" } };
    },
  });
  scheduler.kick();
  await flush();

  assert.equal(dispatched.includes(taskId), false, "decomposing 内的节点不进 ready 集");
  assert.deepEqual(dispatched, [], "decomposing 不派发任何节点（executing 过滤零改动的机器凭据）");
  /**
   * `queue_state` 裸列取不到（`readQueueState` 把 **NULL 归一为 `settled`**，v0.7.0 前老行不在队列）
   * ⇒ 「恒为 NULL」的机械凭据换读**同一行的三枚伴随列**：真入过队的行 `queued_at` 必非空。
   * 上两条断言（零派发）+ 本条（零入队）合起来 = 「`decomposing` 期不占机器资源」。
   */
  const row = getQueuedTask(taskId);
  assert.equal(row?.queuedAt ?? null, null, "未入队 ⇒ queued_at 逐字 NULL");
  assert.equal(row?.claimedBy ?? null, null, "未领取 ⇒ claimed_by 逐字 NULL");
  assert.equal(row?.queueState, "settled", "读数 = NULL 的归一值（节点态仍是 working，非真落终态）");
  assert.equal(row?.state, "working", "调度器 tick 未改动该节点态");
});

// ---------------------------------------------------------------------------
// ⑦ 异常面不扩
// ---------------------------------------------------------------------------

test("⑦ decomposing 期 to=needs_input ⇒ 非法流转拒绝（新两态不挂 needs_input）", () => {
  const version = nextVersion("no-needs-input");
  seedLedgers(version);
  const featureId = decomposingFeature(version);

  const failure = mustFail(handleFeatureAdvance({ featureId, to: "needs_input" }, GROUP));
  assert.equal(failure.code, "feature_transition_invalid");
  assert.equal(getFeature(featureId)?.state, "decomposing");
});

// ---------------------------------------------------------------------------
// ⑧ 发版闸按设计挡（不得加豁免）
// ---------------------------------------------------------------------------

test("⑧ 卡停 version_planning ⇒ 该版发版闸未收口（计入 open，无豁免）", () => {
  const version = nextVersion("release-gate");
  seedLedgers(version);
  const featureId = readyFeature(version);
  mustOk(handleFeatureApprove({ featureId }, GROUP));
  assert.equal(getFeature(featureId)?.state, "version_planning");

  const gate = mustFailOk(evaluateReleaseGate({ ownerGroup: GROUP, version }));
  assert.equal(gate.code, "orch_version_not_converged");
  assert.match(gate.error, /open=1/, "新态计入 open（挡闸正是设计意图）");
});

/** 发版闸的失败档判别（`ReleaseGateResult` 的 failure 分支与 FeatureToolFailure 同形） */
function mustFailOk(result: { ok: boolean } | { ok: false; code: string; error: string }): FeatureToolFailure {
  if (result.ok === true) throw new Error("期望发版闸拒绝，实际放行");
  return result as unknown as FeatureToolFailure;
}

// ---------------------------------------------------------------------------
// 边界：分流不得把审批门变成可绕
// ---------------------------------------------------------------------------

test("边界 waiting_approval 上 advance(to=executing) 仍走 feature_approval_required（分流不开第二准入）", () => {
  const version = nextVersion("no-bypass");
  seedLedgers(version);
  const featureId = readyFeature(version);
  const failure = mustFail(handleFeatureAdvance({ featureId, to: "executing" }, GROUP));
  assert.equal(failure.code, "feature_approval_required");
  assert.equal(getFeature(featureId)?.state, "waiting_approval");
});
