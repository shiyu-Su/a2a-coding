/**
 * v0.10.5 **O7**（REQ-2026-10-12-03 · 改造文档 §2.1 / §2.2 / §4 验收面）
 * —— **八态新链专项：状态门控全流程**。
 *
 * 与 `O3`（create 契约 + 门①）/ `O4`（分流 + 双挂 + 收窄）的**单元断言形态正交**：
 * 本文件只在**一条完整链**上逐格走位，量的是「格与格之间的串联」。
 *
 * 锁定的行为面（= 节点验收判据 2–7）：
 * - **判据 2**：新链全程一条 —— `create`（不传 `stage`/`approval`）→ 门① → `approve`（`version_planning`）
 *   → 建版 + 写归属 → `decomposing`（登记节点）→ `executing` → 节点全 `completed` ⇒ **引擎自动** `integrating`
 *   → `testing` → `reviewing` → `completed`，**逐格 `stage` 与半派生表一致**（唯一例外 `integrating` 格
 *   按**实测**锁 `改造` —— 该格由宿主 `advance` 归位，引擎自动边不经派生点，用户裁 A 案 2026-10-13）；
 * - **判据 3**：存量 `waiting_approval` 卡走新链（过渡 (i) 正例 —— 不回填、不特判）；
 * - **判据 4**：旧边兼容 —— `canTransition("waiting_approval","executing") === true`（只加边）**但**
 *   `advance(to="executing")` 被唯一准入守卫拒（二者共存的证明）；
 * - **判据 5**：门① 四条件 / 归属门双挂 / 挂载集收窄 / `decomposing` 期不派发 —— **端到端串一遍**；
 * - **判据 6**：卡停两工序格 ⇒ 该版发版闸未收口（计入 `open`）—— **故意挡、不得豁免**（见该用例注释）；
 * - **判据 7**：回滚面（下方原文，**只登记、不改码**）。
 *
 * **回滚面原文（判据 7）**：旧码读侧会把新态行静默归一为 `waiting_approval`，且 `approval=已通过`
 * 使重新 `approve` 被拒 ⇒ 回滚前须 `SELECT state, count(*) FROM features GROUP BY state` 摸底并
 * 手工把新态行迁回 `executing`。本文件末尾的「回滚摸底」用例只把**摸底读数**与**重新 approve 必被拒**
 * 这两件事实钉成断言，**不引入任何回滚代码**。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 * 隔离：`SESSION_DB=:memory:`；`MACHINES_CONFIG` 是 `bridge/index.ts` 的**模块加载期常量**
 * ⇒ 必须在动态 import **之前**写好；`fetch` 换成**一律抛错的计数桩** ⇒ 派发走 pull 模型（本地入队），
 * 本文件任何出站即失败。**每条用例各占一个 project**（同组多成员）⇒ 领取面 / 队列互不串扰。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前
process.env["SYNC_BUDGET_MS"] = "300";
process.env["POLL_INTERVAL_MS"] = "40";
process.env["TASK_WATCHER_POLL_INTERVAL_MS"] = "50";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimTask,
  featureProjectListByFeature,
  getFeature,
  getQueuedTask,
  getTask,
  listFeatureTasks,
  listFeatures,
  projectVersionCreate,
  runnerProjectsReplace,
  updateFeatureState,
  upsertRunner,
  upsertTaskResult,
  versionLedgerCreate,
} from "../session/store.js";
import { MOUNTABLE_FEATURE_STATES } from "../bridge/register-tools.js";
import { canTransition } from "../feature/state-machine.js";
import {
  ERR_FEATURE_ATTRIBUTION_REQUIRED,
  ERR_GROUP_VERSION_REQUIRED,
  evaluateReleaseGate,
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCancel,
  handleFeatureCreate,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";
import type { BridgeCore } from "../bridge/index.js";

const GROUP = "g-o7";
const MACHINE = "m7";
const PROJECT_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// 零出站计数桩 + 单组多项目机器配置（须在 import bridge/index.js 之前）
// ---------------------------------------------------------------------------

let outboundCount = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  outboundCount += 1;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`八态新链专项不应有任何出站请求（派发 = 本地入队）：${url}`);
}) as typeof globalThis.fetch;

/** 每条用例一个独立 project（领取 / 队列互不串扰），全部登记为本组成员 */
const PROJECTS = Array.from({ length: 16 }, (_, i) => `p7-${String(i + 1).padStart(2, "0")}`);

const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-o7-chain-"));
const CFG_PATH = join(CFG_DIR, "config.json");
process.env["MACHINES_CONFIG"] = CFG_PATH;

writeFileSync(
  CFG_PATH,
  JSON.stringify(
    {
      machines: [{ machineId: MACHINE }],
      projectGroup: [
        { name: GROUP, members: PROJECTS.map((projectId) => ({ machineId: MACHINE, projectId })) },
      ],
    },
    null,
    2,
  ),
  "utf8",
);

const { createCore } = await import("../bridge/index.js");
const core: BridgeCore = createCore(GROUP);

/**
 * Runner 注册 + 项目投影（pull 模型的**定位**侧）：`locateProject` 需机器已注册且项目在线，
 * 否则派发报 `[launcher_unreachable] Runner 未注册`。注册后派发仍是**本地入队**、零出站
 * （出站桩全程计数为 0 即本文件的凭据）。
 */
upsertRunner({ runnerId: MACHINE, machineId: MACHINE, protocolVersion: "2.0" });
runnerProjectsReplace(
  MACHINE,
  PROJECTS.map((projectId) => ({
    projectId,
    agentKind: "opencode" as const,
    a2aPort: 3010,
    status: "online" as const,
  })),
);

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(CFG_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具助手
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** 落库 `stage` 读数（半派生表的逐格对照面） */
function stageOf(featureId: string): string | null {
  return getFeature(featureId)?.stage ?? null;
}

let seq = 0;
function nextVersion(tag: string): string {
  seq += 1;
  return `0.10.5-o7-${tag}-${seq}.0`;
}

let projectSeq = 0;
function nextProject(): string {
  projectSeq += 1;
  assert.ok(projectSeq < PROJECTS.length, "夹具 project 池耗尽（每条用例各占一枚）");
  return PROJECTS[projectSeq - 1]!;
}

/** Group 台账灌版号（每张卡一个独立列车号，避免发版闸串扰） */
function seedGroupLedger(version: string): void {
  mustOk(versionLedgerCreate({ ownerGroup: GROUP, version }));
}

/** project 台账灌 `1.0.0` 行 —— 「先建版 → 再写归属」的**建版**侧（C-15：不隐式建版） */
function seedProjectVersion(projectId: string): void {
  mustOk(projectVersionCreate({ ownerGroup: GROUP, projectId, version: PROJECT_VERSION }));
}

/**
 * 抬 `stage` 那一单携带的产出物登记夹具 —— 门① 第二前提（增补 `bbc7ea28` O3）要《需求确认单》、
 * 门② 的 ⑥（增补 `ec93e1bd`）要《改造文档》。两枚必须**同单在册**：`decisions` 是整值替换，
 * 过门时按当场值逐枚查 ⇒ 只登记其一不放行。档名照命名规范经 `decisions` 落 Feature Context。
 */
const CONFIRMATION_DECISIONS = '["doc/v0.10.5/夹具-需求确认单.md","doc/v0.10.5/夹具-改造文档.md"]';

/**
 * 门① 过门（v0.10.5 新契约）：`version` 已由 create 落定 ⇒ `stage`「需求分析 → 改造方案」
 * 经登记字段特例（`to` = 当前态）写入；`approval` 随后置 `待审批`。
 * 抬 `stage` 的同单须已含《需求确认单》档名（增补 `bbc7ea28` 第二前提：已落库 ∪ 本单同写）。
 */
function passGateOne(featureId: string): void {
  mustOk(
    handleFeatureAdvance(
      { featureId, to: "waiting_approval", stage: "改造方案", decisions: CONFIRMATION_DECISIONS },
      GROUP,
    ),
  );
  mustOk(handleFeatureAdvance({ featureId, to: "waiting_approval", approval: "待审批" }, GROUP));
}

/** 一张**待过门**的卡（`waiting_approval` ∧ `待审批`），版号与本侧 project 台账已灌好 */
function readyFeature(version: string, projectId: string, parentFeatureId?: string): string {
  seedGroupLedger(version);
  seedProjectVersion(projectId);
  const created = mustOk(
    handleFeatureCreate(
      parentFeatureId === undefined
        ? { title: `o7-${version}`, version }
        : { title: `o7-${version}`, version, parentFeatureId },
      GROUP,
    ),
  );
  passGateOne(created.featureId);
  return created.featureId;
}

/** 停在 `decomposing`（已带归属）的卡：`create` → 门① → `approve` → 出 `version_planning` 格 */
function decomposingFeature(version: string, projectId: string): string {
  const featureId = readyFeature(version, projectId);
  mustOk(handleFeatureApprove({ featureId }, GROUP));
  mustOk(
    handleFeatureAdvance(
      {
        featureId,
        to: "decomposing",
        projectVersions: [{ projectId, version: PROJECT_VERSION }],
      },
      GROUP,
    ),
  );
  return featureId;
}

/** 登记一枚节点（`decomposing` / `executing` 均为合法挂载态），返回本地 taskId */
function mountNode(featureId: string, projectId: string, label: string, dependencies: string[] = []): string {
  const outcome = mustOk(core.registerFeatureNode(projectId, label, undefined, featureId, dependencies));
  const taskId = outcome.taskId;
  assert.ok(taskId !== undefined, `登记成功应回 taskId：${JSON.stringify(outcome)}`);
  return taskId;
}

/** 节点是否已入队（pull 模型：入队 = 调度器认领并落领取面，`queued_at` 必非空） */
function isEnqueued(taskId: string): boolean {
  return getQueuedTask(taskId)?.queuedAt != null;
}

/**
 * **逐拍 kick 直到判据成立**（= 常驻桥里 `setInterval` 的调度拍在本文件的等价物）。
 *
 * 本文件不调 `scheduler.start()`（测试面不挂常驻循环），而调度器的三件事都是**按拍**发生的：
 * ① 就绪节点入队；② 上游落定后下游转就绪；③ 全部 `completed` ⇒ `executing → integrating` 收敛。
 * 单记 kick 只覆盖「结算已生效」的那一拍 ⇒ 上游刚落定、下游尚未转 ready 时须**再一拍**。
 * 每次 poll 都 kick 一次，等价于把「等 Runner / 等下一拍」交给调度器自身。
 */
async function kickUntil(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    core.kickScheduler();
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`等待超时（逐拍 kick）：${what}`);
    await sleep(30);
  }
}

/** 模拟 Runner 回传终态（真实结算落库路径；零出站、零 claim —— 领取面只用于 5c 的反证） */
async function settleNode(
  taskId: string,
  featureId: string,
  projectId: string,
  state: "completed" = "completed",
): Promise<void> {
  upsertTaskResult({
    machineId: MACHINE,
    taskId,
    projectId,
    contextId: getTask(taskId)?.contextId ?? "",
    state,
    text: `回执:${state}`,
    featureId,
    remoteTaskId: `r-${taskId.slice(0, 8)}`,
  });
  /**
   * **结算后逐拍 kick**：`tasks.state` 的终态可能由看护异步落，先 kick 的那一拍仍看见该节点在飞
   * ⇒ 下游不入 ready 集、`executing → integrating` 也不判定（本文件不调 `scheduler.start()`，
   * 没有自动下一拍）。故结算点必须持续 kick 到账面生效，等价于常驻桥里的调度拍序列。
   */
  await kickUntil(() => (getTask(taskId)?.state ?? "") === state, `节点 ${taskId} 落 ${state}`);
}

// ===========================================================================
// 判据 2 —— 新链全程一条（端到端）＋ 逐格 stage 与半派生表一致
// ===========================================================================

test("判据 2 新链全程一条：create（不传 stage/approval）→ 门① → approve → 建版+写归属 → decomposing → executing → 引擎自动 integrating → testing → reviewing → completed，逐格 stage 对上派生表（integrating 格按实测锁改造）", async () => {
  const version = nextVersion("full-chain");
  const project = nextProject();
  seedGroupLedger(version);
  seedProjectVersion(project);

  // ---- ① create：初值恒定（`stage=需求分析` / `approval=未发起`，不再是入参） ----
  const created = mustOk(handleFeatureCreate({ title: `o7-${version}`, version }, GROUP));
  const featureId = created.featureId;
  assert.equal(created.state, "waiting_approval", "主链起点 = 审批门停靠点");
  assert.equal(created.stage, "需求分析");
  assert.equal(created.approval, "未发起");
  assert.equal(stageOf(featureId), "需求分析", "未过门 ⇒ stage 恒为初值");

  // ---- ② 门①（需求确认）：登记字段特例抬 stage，主链零迁移（同单已登记《需求确认单》） ----
  mustOk(
    handleFeatureAdvance(
      { featureId, to: "waiting_approval", stage: "改造方案", decisions: CONFIRMATION_DECISIONS },
      GROUP,
    ),
  );
  mustOk(handleFeatureAdvance({ featureId, to: "waiting_approval", approval: "待审批" }, GROUP));
  assert.equal(getFeature(featureId)?.state, "waiting_approval", "门① 不推主链");
  assert.equal(stageOf(featureId), "改造方案");

  // ---- ③ approve：唯一准入 ⇒ version_planning（派生写 stage） ----
  const approved = mustOk(handleFeatureApprove({ featureId }, GROUP));
  assert.equal(approved.state, "version_planning", "主轨（无父）approve 后继 = version_planning");
  assert.equal(getFeature(featureId)?.approval, "已通过");
  assert.equal(stageOf(featureId), "改造方案", "半派生表：version_planning ⇒ 改造方案");
  assert.equal(
    featureProjectListByFeature(featureId).length,
    0,
    "approve 不落归属初版（v0.10.2 回写后置）",
  );

  // ---- ④ PjM 工序落定 ⇒ 先建版（上句已灌）→ 再写归属（同单带 projectVersions） ----
  const toDecomposing = mustOk(
    handleFeatureAdvance(
      {
        featureId,
        to: "decomposing",
        projectVersions: [{ projectId: project, version: PROJECT_VERSION }],
      },
      GROUP,
    ),
  );
  assert.equal(toDecomposing.state, "decomposing");
  assert.deepEqual(toDecomposing.attribution, { created: 1, updated: 0, noop: 0 }, "归属同单落库");
  assert.equal(stageOf(featureId), "改造方案", "半派生表：decomposing ⇒ 改造方案");

  // ---- ⑤ decomposing 内登记两枚节点（末位依赖首枚）⇒ 本格不派发 ----
  const first = mountNode(featureId, project, "O7 首节点");
  const second = mountNode(featureId, project, "O7 末节点", [first]);
  core.kickScheduler();
  await sleep(200);
  assert.equal(outboundCount, 0, "decomposing 期零出站");
  for (const taskId of [first, second]) {
    assert.equal(isEnqueued(taskId), false, `${taskId} 未入队（queued_at 逐字 NULL）`);
  }

  // ---- ⑥ advance ⇒ executing（派生写 stage=改造）----
  mustOk(handleFeatureAdvance({ featureId, to: "executing" }, GROUP));
  assert.equal(stageOf(featureId), "改造", "半派生表：executing ⇒ 改造");

  // ---- ⑦ 节点全 completed ⇒ 引擎自动 executing → integrating（不靠宿主 advance） ----
  await kickUntil(() => isEnqueued(first), "首节点入队待领");
  await settleNode(first, featureId, project);
  await kickUntil(() => isEnqueued(second), "次节点依赖满足后入队");
  await settleNode(second, featureId, project);
  await kickUntil(
    () => getFeature(featureId)?.state === "integrating",
    "全部节点 completed ⇒ 引擎自动 integrating",
  );
  /**
   * **按实测锁定（用户裁 A 案 2026-10-13）**：半派生的**唯一调用点**在 `handleFeatureAdvance`
   * （`bridge/feature-tools.ts:1768`），而 `executing → integrating` 由**调度器**自动迁移
   * （`bridge/scheduler.ts:853` 的 `transition()` 只 `updateFeatureState`、不经 advance）
   * ⇒ 引擎自动入 `integrating` 那一格 `stage` **停在上一档 `改造`**，`回归` 随宿主下一笔
   * `advance(to="testing")` 才归位。改造文档 §2.2 原把 `integrating` 记为「引擎派生」——
   * **措辞订正（改为「宿主 `advance` 归位」）与 §6 缺口登记由宿主落笔，不在本节点落点内**；
   * 本节点**不改 `scheduler.ts`**（「不做什么」清单照旧生效）。
   */
  assert.equal(
    stageOf(featureId),
    "改造",
    "本格 stage 由宿主 advance 归位；引擎自动边（executing→integrating）不经派生点，缺口已登记改造文档 §6（修订历史 +1 版）",
  );

  // ---- ⑧ 终验三格由宿主 advance 连推（派生逐格对上表） ----
  mustOk(handleFeatureAdvance({ featureId, to: "testing" }, GROUP));
  assert.equal(stageOf(featureId), "回归", "半派生表：testing ⇒ 回归（此处补齐 integrating 档的同值）");
  mustOk(handleFeatureAdvance({ featureId, to: "reviewing" }, GROUP));
  assert.equal(stageOf(featureId), "验收", "半派生表：reviewing ⇒ 验收");
  mustOk(handleFeatureAdvance({ featureId, to: "completed" }, GROUP));
  assert.equal(getFeature(featureId)?.state, "completed");
  assert.equal(stageOf(featureId), "验收", "completed 不派生 ⇒ stage 停在验收（发版后由宿主写「发版」）");
  assert.equal(outboundCount, 0, "全程零出站（派发 = 本地入队，结算 = 回传落库）");

  // ---- ⑨ 收口对照（排除判据 6 的空洞）：同版名下唯一卡 completed ⇒ 闸放行 ----
  const gate = mustOk(evaluateReleaseGate({ ownerGroup: GROUP, version }));
  assert.deepEqual(gate.counts, { total: 1, completed: 1, cancelled: 0, open: 0 });
});

// ===========================================================================
// 判据 3 —— 存量 waiting_approval 卡走新链（过渡 (i) 正例：不回填、不特判）
// ===========================================================================

test("判据 3 存量 waiting_approval 卡走新链：早于新两格落地的卡，approve 仍落 version_planning，stage 随下一次真实迁移归位（不回填、不特判）", () => {
  const version = nextVersion("legacy-waiting");
  const project = nextProject();
  seedGroupLedger(version);
  seedProjectVersion(project);

  // 存量形态：v0.10.5 之前建卡并停在 waiting_approval（stage 停在最后一次写入的值 = 需求分析）
  const created = mustOk(handleFeatureCreate({ title: `o7-${version}`, version }, GROUP));
  const featureId = created.featureId;
  assert.equal(getFeature(featureId)?.state, "waiting_approval");
  assert.equal(stageOf(featureId), "需求分析", "存量行停靠期 ⇒ stage 滞后是已知观测噪音");

  // 不回填：新两格落地不改动停靠中的卡
  assert.equal(
    listFeatures({ state: "waiting_approval", ownerGroup: GROUP, limit: 500 }).some(
      (f) => f.featureId === featureId,
    ),
    true,
    "停靠中的存量卡仍可经 waiting_approval 读面读到（未被迁移改写）",
  );

  // 同一张卡走新链：门① → approve ⇒ version_planning（无「旧卡走旧链」的第二套判据）
  passGateOne(featureId);
  const approved = mustOk(handleFeatureApprove({ featureId }, GROUP));
  assert.equal(approved.state, "version_planning", "存量卡与新卡同走一条新链 ⇒ 不特判");
  assert.equal(stageOf(featureId), "改造方案", "stage 在下一次真实迁移时归位（过渡判据第 4 句）");

  mustOk(
    handleFeatureAdvance(
      {
        featureId,
        to: "decomposing",
        projectVersions: [{ projectId: project, version: PROJECT_VERSION }],
      },
      GROUP,
    ),
  );
  assert.equal(getFeature(featureId)?.state, "decomposing");
});

// ===========================================================================
// 判据 4 —— 旧边兼容（只加边 ∧ 唯一准入共存）
// ===========================================================================

test("判据 4 旧边兼容：canTransition(waiting_approval → executing) === true，但 advance(to=executing) 被唯一准入守卫拒且零迁移", () => {
  const version = nextVersion("old-edge");
  const project = nextProject();
  const featureId = readyFeature(version, project);

  // ① 状态机层：既有边逐字保留（O1「只加边」的机器凭据）
  assert.equal(canTransition("waiting_approval", "executing"), true);
  assert.equal(canTransition("waiting_approval", "version_planning"), true, "新边同表并存");

  // ② 工具层：唯一准入守卫照旧拒 ⇒ 错误码 feature_approval_required、主链零迁移
  const failure = mustFail(handleFeatureAdvance({ featureId, to: "executing" }, GROUP));
  assert.equal(failure.code, "feature_approval_required");
  assert.match(failure.error, /a2a_feature_approve/);
  assert.equal(getFeature(featureId)?.state, "waiting_approval", "被拒 ⇒ 零迁移");
  assert.equal(featureProjectListByFeature(featureId).length, 0, "被拒 ⇒ 归属零写入");

  // ③ 同一张卡经 approve ⇒ version_planning ⇒ 旧边**不可跳档**直达 executing
  mustOk(handleFeatureApprove({ featureId }, GROUP));
  const gated = mustFail(handleFeatureAdvance({ featureId, to: "executing" }, GROUP));
  assert.equal(gated.code, "feature_transition_invalid", "version_planning 不得跳档直达 executing");

  // ④ 两格连推才到 executing ⇒ 旧边不是第二准入
  mustOk(
    handleFeatureAdvance(
      {
        featureId,
        to: "decomposing",
        projectVersions: [{ projectId: project, version: PROJECT_VERSION }],
      },
      GROUP,
    ),
  );
  mustOk(handleFeatureAdvance({ featureId, to: "executing" }, GROUP));
  assert.equal(getFeature(featureId)?.state, "executing");
});

// ===========================================================================
// 判据 5 —— 跨节点串联（门① 四条件 / 归属门双挂 / 挂载集收窄 / 不提前派发）
// ===========================================================================

test("判据 5a 串联：门① 四条件端到端 —— 未排期过门 ⇒ 整单零写入；补写 version 后同一迁移重试放行", () => {
  const version = nextVersion("gate1-chain");
  const project = nextProject();
  seedGroupLedger(version);
  seedProjectVersion(project);

  // 未排期卡（create 不传 version ⇒ features.version 为空）
  const created = mustOk(handleFeatureCreate({ title: `o7-${version}` }, GROUP));
  const featureId = created.featureId;
  assert.equal(created.version, "", "未排期 ⇒ version 空串");
  assert.equal(getFeature(featureId)?.version ?? "", "");

  // 四条件全中 ⇒ 结构化拒收、整单零写入
  const denied = mustFail(
    handleFeatureAdvance({ featureId, to: "waiting_approval", stage: "改造方案" }, GROUP),
  );
  assert.equal(denied.code, ERR_GROUP_VERSION_REQUIRED);
  assert.equal(denied.code, "feature_group_version_required", "错误码字面");
  const parked = getFeature(featureId);
  assert.equal(parked?.state, "waiting_approval", "整单零写入：state 不动");
  assert.equal(parked?.stage, "需求分析", "整单零写入：stage 不动");
  assert.equal(parked?.approval, "未发起", "整单零写入：approval 不动");

  // 拒后仍「需求分析 ∧ 未发起」⇒ 排期锁开着 ⇒ 补写 version 后同一迁移重试
  mustOk(handleFeatureAdvance({ featureId, to: "waiting_approval", version }, GROUP));
  mustOk(
    handleFeatureAdvance(
      { featureId, to: "waiting_approval", stage: "改造方案", decisions: CONFIRMATION_DECISIONS },
      GROUP,
    ),
  );
  assert.equal(getFeature(featureId)?.stage, "改造方案", "补排期后过门成立（先排期写、再过门①）");
});

test("判据 5b 串联：归属门双挂端到端 —— 两道出格各撞一次空归属、各补一次归属；增补轨（跳格）由第二枚守卫兜住", () => {
  const version = nextVersion("attr-chain");
  const mainProject = nextProject();
  const featureId = readyFeature(version, mainProject);
  mustOk(handleFeatureApprove({ featureId }, GROUP));

  // 第一枚守卫：version_planning → decomposing 空归属 ⇒ 拒 + 主链零迁移
  const first = mustFail(handleFeatureAdvance({ featureId, to: "decomposing" }, GROUP));
  assert.equal(first.code, ERR_FEATURE_ATTRIBUTION_REQUIRED);
  assert.equal(getFeature(featureId)?.state, "version_planning");
  assert.equal(outboundCount, 0, "被拒 ⇒ 零出站");

  // 带归属 ⇒ 放行
  mustOk(
    handleFeatureAdvance(
      {
        featureId,
        to: "decomposing",
        projectVersions: [{ projectId: mainProject, version: PROJECT_VERSION }],
      },
      GROUP,
    ),
  );
  assert.equal(getFeature(featureId)?.state, "decomposing");
  assert.equal(featureProjectListByFeature(featureId).length, 1);

  // 增补轨（挂父 ⇒ approve 直接落 decomposing、跳过第一枚守卫）⇒ 第二枚守卫兜住
  const childProject = nextProject();
  seedProjectVersion(childProject);
  const child = mustOk(
    handleFeatureCreate(
      { title: `o7-${version}·增补`, version, parentFeatureId: featureId },
      GROUP,
    ),
  );
  passGateOne(child.featureId);
  const childApproved = mustOk(handleFeatureApprove({ featureId: child.featureId }, GROUP));
  assert.equal(childApproved.state, "decomposing", "有父卡跳过 version_planning");
  assert.equal(featureProjectListByFeature(child.featureId).length, 0, "过审不落归属初版");

  const second = mustFail(handleFeatureAdvance({ featureId: child.featureId, to: "executing" }, GROUP));
  assert.equal(second.code, ERR_FEATURE_ATTRIBUTION_REQUIRED, "第二枚挂载点同样拒（双挂）");
  assert.equal(getFeature(child.featureId)?.state, "decomposing");

  mustOk(
    handleFeatureAdvance(
      {
        featureId: child.featureId,
        to: "executing",
        projectVersions: [{ projectId: childProject, version: PROJECT_VERSION }],
      },
      GROUP,
    ),
  );
  assert.equal(getFeature(child.featureId)?.state, "executing");
});

test("判据 5c 串联：挂载集收窄 + decomposing 期不派发（同一条链上先拒后登记、登记后不领、出格才领）", async () => {
  assert.deepEqual([...MOUNTABLE_FEATURE_STATES], ["executing", "decomposing"], "收窄后的挂载集");

  const version = nextVersion("mount-chain");
  const project = nextProject();
  const featureId = readyFeature(version, project);

  // ① 未过门（waiting_approval）⇒ 挂载被拒，且文案不列该态为合法值
  const denied = mustFail(core.registerFeatureNode(project, "停靠期节点", undefined, featureId, []));
  assert.equal(denied.code, "feature_state_invalid");
  assert.doesNotMatch(denied.error, /waiting_approval 可挂载/, "合法值清单不把 waiting_approval 当可挂值");
  assert.equal(listFeatureTasks(featureId, { limit: 100 }).length, 0, "被拒节点零入库");

  // ② 过门后（decomposing）⇒ 同一条消息登记成功
  mustOk(handleFeatureApprove({ featureId }, GROUP));
  mustOk(
    handleFeatureAdvance(
      {
        featureId,
        to: "decomposing",
        projectVersions: [{ projectId: project, version: PROJECT_VERSION }],
      },
      GROUP,
    ),
  );
  const taskId = mountNode(featureId, project, "拆任务格内节点");
  assert.equal(listFeatureTasks(featureId, { limit: 100 }).length, 1);

  // ③ decomposing 期不派发：不入队、领不到、零出站（scheduler 的 executing 过滤零改动 = 机器凭据）
  core.kickScheduler();
  await sleep(150);
  assert.equal(claimTask({ claimedBy: MACHINE, projectIds: [project] }), null, "decomposing 内的节点不进领取面");
  assert.equal(isEnqueued(taskId), false, "未入队 ⇒ queued_at 逐字 NULL");
  assert.equal(getTask(taskId)?.state, "working", "节点态未被 tick 改动");
  assert.equal(outboundCount, 0, "decomposing 期零出站");

  // ④ 出格进 executing ⇒ 同一节点入队（不提前派发的反面证据，排除 vacuous）
  mustOk(handleFeatureAdvance({ featureId, to: "executing" }, GROUP));
  await kickUntil(() => isEnqueued(taskId), "executing 后同一节点入队");
  // 收尾 cancel：本用例把节点留在队里，不收则后续用例的 tick 会再认领它
  mustOk(handleFeatureCancel({ featureId }, GROUP));
  assert.equal(outboundCount, 0, "起派路径仍零出站（pull 模型本地入队）");
});

// ===========================================================================
// 判据 6 —— 发版闸：卡停两工序格 ⇒ 未收口（计入 open）
// **故意挡、不得豁免**：新两格是「已过 approve、未交付」的中间态，落在 §8 收口集合
// {completed, cancelled} 之外 ⇒ 该版不得标记 released。不得为工序格加任何豁免分支。
// （非空洞对照在判据 2 末段：同链走到 completed 后同一闸放行。）
// ===========================================================================

test("判据 6 发版闸故意挡（不得豁免）：卡停 version_planning / decomposing ⇒ 该版计入 open ⇒ 闸拒", () => {
  // ---- 停 version_planning ----
  const v1 = nextVersion("gate-planning");
  const p1 = nextProject();
  const inPlanning = readyFeature(v1, p1);
  mustOk(handleFeatureApprove({ featureId: inPlanning }, GROUP));
  assert.equal(getFeature(inPlanning)?.state, "version_planning");
  const gate1 = mustFail(evaluateReleaseGate({ ownerGroup: GROUP, version: v1 }));
  assert.equal(gate1.code, "orch_version_not_converged");
  assert.match(gate1.error, /open=1/, "version_planning 计入 open（无豁免分支）");

  // ---- 停 decomposing ----
  const v2 = nextVersion("gate-decomposing");
  const p2 = nextProject();
  const inDecomposing = decomposingFeature(v2, p2);
  assert.equal(getFeature(inDecomposing)?.state, "decomposing");
  const gate2 = mustFail(evaluateReleaseGate({ ownerGroup: GROUP, version: v2 }));
  assert.equal(gate2.code, "orch_version_not_converged");
  assert.match(gate2.error, /open=1/, "decomposing 同样计入 open（无豁免分支）");

  // ---- 收口后 open 归零，但**另一条既有判据**接着挡（全 cancelled = 无交付）⇒ 不是工序格豁免 ----
  mustOk(handleFeatureCancel({ featureId: inDecomposing }, GROUP));
  assert.equal(getFeature(inDecomposing)?.state, "cancelled");
  const gate3 = mustFail(evaluateReleaseGate({ ownerGroup: GROUP, version: v2 }));
  assert.equal(gate3.code, "orch_version_all_cancelled", "换的是另一条既有判据（全取消无交付），不是放行");
});

// ===========================================================================
// 判据 7 —— 回滚面（只登记、不改码）：摸底读数 + 「重新 approve 必被拒」两件事实钉住
// ===========================================================================

test("判据 7 回滚摸底：新态行在 features.state 上字面可见（GROUP BY 面）∧ approval=已通过 ⇒ 手工迁回 state 后重新 approve 仍被拒", () => {
  const version = nextVersion("rollback");
  const project = nextProject();
  const featureId = decomposingFeature(version, project); // 已过 approve ⇒ approval = 已通过

  // 摸底读数 = `SELECT state, count(*) FROM features GROUP BY state` 的等价面（只读、零改动）
  const counts = new Map<string, number>();
  for (const f of listFeatures({ ownerGroup: GROUP, limit: 1000 })) {
    counts.set(f.state, (counts.get(f.state) ?? 0) + 1);
  }
  assert.ok((counts.get("decomposing") ?? 0) >= 1, "本用例自身即新态行 ⇒ 摸底必见 decomposing");

  // 旧码读侧会把该行归一成 waiting_approval ⇒ 迁回之前，重新 approve 一定被 state 判据拒
  const again = mustFail(handleFeatureApprove({ featureId }, GROUP));
  assert.equal(again.code, "feature_state_invalid", "非 waiting_approval ⇒ approve 拒（不可补领）");

  // 模拟「只把 state 迁回、不动 approval」的回滚：仍被 approval 判据拒 ⇒ 回滚须两步都做
  updateFeatureState(featureId, "waiting_approval");
  const afterRewind = mustFail(handleFeatureApprove({ featureId }, GROUP));
  assert.equal(
    afterRewind.code,
    "feature_approval_not_ready",
    "approval=已通过 ⇒ 即使 state 迁回也过不了门（回滚须同时手工处理 approval）",
  );
});
