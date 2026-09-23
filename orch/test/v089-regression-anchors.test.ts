/**
 * v0.8.9 O4 回归锚 · orch 套件的三条「防漂移」锚（**纯测试节点，不改生产代码**）。
 *
 * 锚命题（改造文档 §4 验收面 / 节点任务书 O4）：
 * 1. **消息不膨胀端到端（出参面）+ wrappedChars 不随派发次数增长**：同一节点连续 4 次派发
 *    （首派 / `answer` 澄清续推 / `retryTaskIds` 重派 / **变量全冻结的第 4 次重派**）后，
 *    经 `a2a_feature_status` / `a2a_task_status` 断言 —— base 外壳 **0 次**（恒为原始消息 +
 *    澄清追加）、快照外壳 **恰 1 次**、快照全文**逐字** = 当前一层壳 + 当前 base、
 *    `wrappedChars` 恒等于**当前 Feature Context 的一层壳**（O2 文件锚的是存储列且逐轮换 plan
 *    文本；本文件锚投影出参，并以「壳与 base 都不变的第 4 次派发 ⇒ wrappedChars / renderedChars /
 *    快照全文逐字不变」给出字面证据，另以固定壳下 base 翻倍的纯函数快照兜底）。
 *    轮 1→3 的标记落在 decisions（每轮 Feature Context 逐轮不同）：这既是等待谓词能区分轮次的
 *    前提（若壳恒定，第 2/3 轮快照与第 1 轮逐字相同 ⇒ 旧快照即可放行等待），也让「壳体积只跟
 *    Context 走、不跟派发次数走」这一条在第 4 轮被单独冻结验证；Context 变化**先于**触发该轮
 *    派发的动作落库 ⇒ 无「advance 即时 kick 用旧 context 抢跑」的竞态窗口；
 * 2. **历史行兜底**：`dispatch_rendered = NULL` ⇒ 领取所用的消息 = `dispatch_message`
 *    （表达式与 `bridge/runner.ts` 领取文本同一条 `??` 链，行为与 v0.8.8 逐字一致）；
 *    非 NULL ⇒ 领取到渲染快照。HTTP 领取路径的同一判据已由 `runner-endpoints.test.ts`
 *    「成员项目任务：可 claim」覆盖，本文件从 store 侧（`claimTask` 返回行）再锚一次；
 * 3. **出参键名与类型固化**：`summarizeTask`（feature_status tasks 行）/ `a2a_task_status` 成功分支的
 *    `baseChars` / `renderedChars` / `wrappedChars` / `attempts` 恒在且为 number；
 *    透传 diagnostics 的键集合与逐键类型固化（`turn` / `sessionReused` / `sessionResumed` /
 *    `blockCount` / `lastBlockIndex` / `outcomeAmbiguous` / `ambiguousReason` 等）——
 *    后续加键 / 改名 / 类型漂移即红。
 *
 * 夹具同 `v089-render-split.test.ts`：`:memory:` 库 + 缩短同步预算 + 零出站桩 + 组 g1（m1/alpha）。
 */
process.env["SESSION_DB"] = ":memory:";
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
  createTask,
  enqueueTask,
  getFeature,
  getQueuedTask,
  getTask,
  runnerProjectsReplace,
  updateFeatureContext,
  upsertRunner,
  upsertTaskResult,
} from "../session/store.js";
import { projectTaskVisibility, type FeatureTaskSummary } from "../bridge/feature-tools.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 夹具：零出站计数桩（任何 fetch 即失败）+ 机器清单（m1/alpha，组 g1）
// ---------------------------------------------------------------------------

let outboundCount = 0;
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;
const throwingFetch: FetchFn = async (input) => {
  outboundCount += 1;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`单测未预期的出站请求（pull 模型桥侧零出站）：${url}`);
};
globalThis.fetch = throwingFetch;

const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-o4-regression-"));
const CFG_PATH = join(CFG_DIR, "config.json");
process.env["MACHINES_CONFIG"] = CFG_PATH; // 必须在 import bridge/index.js **之前**
writeFileSync(
  CFG_PATH,
  JSON.stringify(
    {
      machines: [{ machineId: "m1" }],
      projectGroup: [{ name: "g1", members: [{ machineId: "m1", projectId: "alpha" }] }],
    },
    null,
    2,
  ),
);

const { createCore } = await import("../bridge/index.js");
const core: BridgeCore = createCore();

upsertRunner({ runnerId: "m1", machineId: "m1", protocolVersion: "2.0" });
runnerProjectsReplace("m1", [
  { projectId: "alpha", agentKind: "opencode", a2aPort: 3010, status: "online" },
]);

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(CFG_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${what}`);
    await sleep(25);
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function okOrThrow<T extends { ok: boolean }>(v: T, what: string): Extract<T, { ok: true }> {
  assert.equal(v.ok, true, `${what} 应成功：${JSON.stringify(v)}`);
  return v as Extract<T, { ok: true }>;
}

/** 渲染壳的结构常量（与 `bridge/index.ts` `renderFeatureContext` + 分隔线逐字对齐） */
const CTX_OPEN = "<feature-context>";
const CTX_CLOSE = "</feature-context>";
const PLAN_TEXT = "统一方案O4（全程不变）";
const MARKERS = ["决策R0", "决策R1", "决策R2"] as const;

/** 轮 r 的 decisions 全文（r+1 条，每条自带本轮独有标记） */
const decisionsFor = (r: number): string =>
  MARKERS.slice(0, r + 1)
    .map((m) => `轮标记:${m}`)
    .join("\n");

/** 轮 r 的**一层壳**全文 = plan 一节 + decisions 一节（与 `renderFeatureContext` 同构） */
const shellFor = (r: number): string =>
  `${CTX_OPEN}\n## 统一方案（plan）\n${PLAN_TEXT}\n\n## 决策记录（decisions）\n${decisionsFor(r)}\n${CTX_CLOSE}\n\n---\n\n`;

/** 一轮派发完成（**重新入队**）的判据：guard 重新占位 + 快照含**本轮独有**标记 */
function reDispatched(taskId: string, marker: string): boolean {
  const task = getTask(taskId);
  const queued = getQueuedTask(taskId);
  return (
    (task?.dispatchRendered ?? "").includes(marker) &&
    queued !== null &&
    queued.dispatchGuard !== null &&
    queued.queueState === "queued"
  );
}

/**
 * 批释放判据（同 `v089-render-split.test.ts`）：入队可见 ≠ 批已释放，
 * 下一轮动作必须晚于同步预算收尾。
 */
const quiesce = (): Promise<void> => sleep(400);

/** `a2a_feature_status` 的 tasks 行（按 taskId 取；必须是成功分支） */
function taskSummary(featureId: string, taskId: string): FeatureTaskSummary {
  const view = okOrThrow(core.featureStatus({ featureId }), "featureStatus");
  const row = (view.tasks ?? []).find((t) => t.taskId === taskId);
  assert.ok(row !== undefined, `tasks 行应存在：${taskId}`);
  return row;
}

/** `a2a_task_status` 与 `a2a_feature_status` 的 ② 键必须同值（单一投影实现的行为面证明） */
async function assertMirrored(taskId: string, row: FeatureTaskSummary): Promise<void> {
  const mirrored = okOrThrow(await core.taskStatus(taskId), "taskStatus");
  for (const key of ["baseChars", "renderedChars", "wrappedChars", "attempts"] as const) {
    assert.equal(mirrored[key], row[key], `${key} 两面必须同值`);
  }
  assert.deepEqual(mirrored.diagnostics, row.diagnostics, "diagnostics 两面同值");
}

// ---------------------------------------------------------------------------
// 1. 消息不膨胀端到端：4 次派发后 wrappedChars = 一层壳，不随派发次数叠加
// ---------------------------------------------------------------------------

test("O4 锚 1：4 次派发（首派/answer 续推/retry 重派/冻结变量的第 4 次重派）后 base 外壳 0 次、快照外壳 1 次、wrappedChars 恒等于一层壳", async () => {
  const BASE = "任务正文O4";
  const fid = okOrThrow(core.featureCreate({ title: "O4 消息不膨胀" }), "featureCreate").featureId;
  updateFeatureContext(fid, { plan: PLAN_TEXT, decisions: decisionsFor(0) });

  const taskId = okOrThrow(
    core.registerFeatureNode("alpha", BASE, undefined, fid, []),
    "registerFeatureNode",
  ).taskId!;
  assert.equal(getTask(taskId)?.dispatchRendered ?? null, null, "登记态 rendered 应为 NULL");

  /** 每轮**派发完成时**读取的投影行（下一轮会覆盖 rendered，必须当轮取） */
  const samples: FeatureTaskSummary[] = [];
  const bases: string[] = [];

  // ---- 轮 1：approve → 首派（context 已含标记 R0）----
  okOrThrow(core.featureApprove({ featureId: fid }), "approve");
  core.kickScheduler();
  await waitFor(() => reDispatched(taskId, MARKERS[0]), "轮 1 首派重新入队");
  bases.push(BASE);
  samples.push(taskSummary(fid, taskId));
  await quiesce();

  // ---- 轮 2：input-required → answer 澄清续推（澄清只追加进 base）----
  updateFeatureContext(fid, { decisions: decisionsFor(1) }); // 轮标记**先于**触发动作落库
  let task = getTask(taskId);
  upsertTaskResult({
    machineId: "m1",
    taskId,
    projectId: "alpha",
    contextId: task?.contextId ?? "",
    state: "input-required",
    text: "需要澄清",
    featureId: fid,
    remoteTaskId: "r-o4-1",
  });
  await waitFor(() => getFeature(fid)?.state === "needs_input", "上报 → Feature needs_input");
  okOrThrow(
    core.featureAdvance({ featureId: fid, to: "executing", answer: "用户答复O4" }),
    "answer 续推 advance",
  );
  const grownBase = `${BASE}\n\n[用户澄清]\n用户答复O4`;
  assert.equal(
    getTask(taskId)?.dispatchMessage,
    grownBase,
    "answer 立即把澄清追加进 base（不追加壳）",
  );
  core.kickScheduler();
  await waitFor(() => reDispatched(taskId, MARKERS[1]), "轮 2 续推重新入队");
  bases.push(grownBase);
  samples.push(taskSummary(fid, taskId));
  await quiesce();

  // ---- 轮 3：failed → retryTaskIds 原样重放 base ----
  updateFeatureContext(fid, { decisions: decisionsFor(2) });
  task = getTask(taskId);
  upsertTaskResult({
    machineId: "m1",
    taskId,
    projectId: "alpha",
    contextId: task?.contextId ?? "",
    state: "failed",
    text: "执行失败",
    featureId: fid,
    remoteTaskId: "r-o4-2",
  });
  await waitFor(() => getTask(taskId)?.state === "failed", "轮 3 前置：节点 failed");
  okOrThrow(
    core.featureAdvance({ featureId: fid, to: "executing", retryTaskIds: [taskId] }),
    "retryTaskIds 重派 advance",
  );
  core.kickScheduler();
  await waitFor(() => reDispatched(taskId, MARKERS[2]), "轮 3 重派重新入队");
  bases.push(grownBase); // 重派 = base 原样重放
  samples.push(taskSummary(fid, taskId));

  // ---- 逐轮出参面终锚（样本为**当轮现场读取**；轮 2/3 会改写 rendered，
  //      两面镜像断言只能在全部轮次结束后对**最终账面**做，见下方）----
  assert.equal(samples.length, 3);
  for (let r = 0; r < 3; r += 1) {
    const row = samples[r]!;
    const shell = shellFor(r);
    // **核心锚**：wrappedChars = renderedChars − baseChars ≡ 当前**一层**壳（叠加一即红）
    assert.equal(row.wrappedChars, row.renderedChars - row.baseChars, `轮 ${r + 1} 差值口径`);
    assert.equal(
      row.wrappedChars,
      shell.length,
      `轮 ${r + 1}（已派发 ${r + 1} 次）：wrappedChars 恒等于一层壳，**不随派发次数增长**`,
    );
    assert.equal(row.baseChars, bases[r]!.length, `轮 ${r + 1}：baseChars = 未渲染 base 体积`);
    assert.equal(
      row.renderedChars,
      (shell + bases[r]!).length,
      `轮 ${r + 1}：renderedChars = 一层壳 + 当前 base`,
    );
  }

  // 末轮存储列（此刻即轮 3 事实）：0 次 / 1 次外壳 + 快照全文逐字
  const raw = getTask(taskId)!;
  const base = raw.dispatchMessage ?? "";
  const rendered = raw.dispatchRendered ?? "";
  assert.equal(countOccurrences(base, CTX_OPEN), 0, "3 次派发后 base 开壳 0 次");
  assert.equal(countOccurrences(base, CTX_CLOSE), 0, "3 次派发后 base 闭壳 0 次");
  assert.equal(base, grownBase, "base 恒为原始消息 + 澄清追加（渲染永不回写）");
  assert.equal(countOccurrences(rendered, CTX_OPEN), 1, "3 次派发后快照开壳恰 1 次（不叠加）");
  assert.equal(countOccurrences(rendered, CTX_CLOSE), 1, "3 次派发后快照闭壳恰 1 次");
  assert.equal(rendered, `${shellFor(2)}${grownBase}`, "轮 3 快照 = 最新一层壳 + 含澄清的 base");

  const finalRow = samples[2]!;
  assert.equal(finalRow.retryCount, 1, "retryCount = 宿主重派 1 次");
  assert.equal(finalRow.attempts, 1, "attempts = retry_count(1) + continueAttempts(0)");
  // 两面镜像：末轮样本即最终账面 ⇒ `a2a_task_status` 必须与 `a2a_feature_status` 同值
  await assertMirrored(taskId, finalRow);

  // ---- 轮 4：**壳与 base 都不变**的第 4 次派发 ⇒ wrappedChars 必须**字面**不变 ----
  // （轮 1→3 的 Feature Context 逐轮加了决策，wrappedChars 随之线性变化属**预期**；
  //   本轮把「增长」的变量全部冻结，只让派发次数 +1 ⇒ 若实现有叠壳，此处必红。）
  await quiesce(); // 轮 3 的批释放后再上报，避免在飞标记挡掉第 4 次派发
  upsertTaskResult({
    machineId: "m1",
    taskId,
    projectId: "alpha",
    contextId: getTask(taskId)?.contextId ?? "",
    state: "failed",
    text: "再次失败",
    featureId: fid,
    remoteTaskId: "r-o4-3",
  });
  await waitFor(() => getTask(taskId)?.state === "failed", "轮 4 前置：节点再次 failed");
  okOrThrow(
    core.featureAdvance({ featureId: fid, to: "executing", retryTaskIds: [taskId] }),
    "轮 4 retryTaskIds 重派 advance",
  );
  core.kickScheduler();
  // 判据 = 第 2 次 re-arm（retryCount 2）之后**重新占位入队** ⇒ 第 4 次派发确已发生
  await waitFor(() => {
    const queued = getQueuedTask(taskId);
    return (
      (getTask(taskId)?.retryCount ?? 0) === 2 &&
      queued !== null &&
      queued.dispatchGuard !== null &&
      queued.queueState === "queued"
    );
  }, "轮 4 重派重新入队");
  const row4 = taskSummary(fid, taskId);
  assert.equal(row4.wrappedChars, finalRow.wrappedChars, "第 4 次派发：wrappedChars 字面不变");
  assert.equal(row4.renderedChars, finalRow.renderedChars, "第 4 次派发：快照体积不变");
  assert.equal(
    getTask(taskId)?.dispatchRendered,
    rendered,
    "第 4 次派发：快照全文与轮 3 **逐字相同**（无第二层壳）",
  );
  assert.equal(row4.baseChars, grownBase.length, "第 4 次派发：base 仍只含澄清追加");
  assert.equal(row4.attempts, 2, "attempts 随宿主重派 +1（触达计数与壳体积正交）");
  await quiesce();

  // 「壳体积不随 base 增长」的纯函数快照（固定壳；派发数/retry 数变化均不影响 wrappedChars）
  const fixedShell = shellFor(0);
  const w1 = projectTaskVisibility({
    dispatchMessage: BASE,
    dispatchRendered: `${fixedShell}${BASE}`,
    retryCount: 0,
    diagnosticsJson: null,
  }).wrappedChars;
  const wMany = projectTaskVisibility({
    dispatchMessage: grownBase + grownBase, // base ≈ 3 倍于首轮
    dispatchRendered: `${fixedShell}${grownBase}${grownBase}`,
    retryCount: 5,
    diagnosticsJson: null,
  }).wrappedChars;
  assert.equal(wMany, w1, "同一层壳下 wrappedChars 不随 base 体积增长（①-a 去重可证指标）");

  // 收尾：以 completed 结算令在飞看护退出（不结算则句柄滞留）
  upsertTaskResult({
    machineId: "m1",
    taskId,
    projectId: "alpha",
    contextId: getTask(taskId)?.contextId ?? "",
    state: "completed",
    text: "收尾",
    featureId: fid,
    remoteTaskId: "r-o4-4",
  });
  await quiesce();
  assert.equal(outboundCount, 0, "全程零出站");
});

// ---------------------------------------------------------------------------
// 2. 历史行兜底：dispatch_rendered = NULL ⇒ 领取所用的消息 = dispatch_message
// ---------------------------------------------------------------------------

test("O4 锚 2：rendered=NULL 领取行走 dispatch_message 兜底；非 NULL 领取到渲染快照", () => {
  // 独立项目：本锚只验 store 侧领取行的**字段兜底**，不参与调度 ⇒ 与锚 1 的在飞节点隔离，
  // 避免 FIFO 领取取到前序用例遗留的排队行。
  const PROJECT = "o4-claim";
  const claim = (taskId: string) => {
    const row = claimTask({ claimedBy: "m-o4", projectIds: [PROJECT] });
    assert.ok(row !== null, `任务 ${taskId} 应可领取`);
    assert.equal(row.taskId, taskId, "FIFO 首条即本锚种子行");
    return row;
  };

  // 历史行形状（v0.8.8 前）：只写 dispatch_message，不写 rendered
  createTask({
    taskId: "t-o4-legacy",
    projectId: PROJECT,
    contextId: "ctx-o4-legacy",
    state: "working",
    prompt: "老任务正文",
    dispatchMessage: "老任务正文",
  });
  assert.notEqual(enqueueTask("t-o4-legacy"), null, "历史行应可入队");
  const legacy = claim("t-o4-legacy");
  assert.equal(legacy.dispatchRendered ?? null, null, "领取行上 rendered 应为 NULL");
  // 与 `bridge/runner.ts` 领取文本**同一条 `??` 链** ⇒ NULL 时下发 = base，行为与 v0.8.8 逐字一致
  assert.equal(
    legacy.dispatchRendered ?? legacy.dispatchMessage ?? legacy.prompt ?? "",
    legacy.dispatchMessage,
    "兜底表达式 = dispatch_message",
  );
  assert.equal(
    legacy.dispatchRendered ?? legacy.dispatchMessage ?? legacy.prompt ?? "",
    "老任务正文",
    "历史行下发文本逐字 = 原始消息（无外壳）",
  );

  // 对照：渲染快照非空 ⇒ 领取文本 = 快照（兜底不劫持新行）
  createTask({
    taskId: "t-o4-rendered",
    projectId: PROJECT,
    contextId: "ctx-o4-rendered",
    state: "working",
    prompt: "新任务正文",
    dispatchMessage: "新任务正文",
    dispatchRendered: `${shellFor(0)}新任务正文`,
  });
  assert.notEqual(enqueueTask("t-o4-rendered"), null);
  const fresh = claim("t-o4-rendered");
  assert.equal(
    fresh.dispatchRendered ?? fresh.dispatchMessage ?? fresh.prompt ?? "",
    `${shellFor(0)}新任务正文`,
    "非 NULL ⇒ 领取到渲染快照",
  );
});

// ---------------------------------------------------------------------------
// 3. 出参键名 / 类型固化（后续漂移即红）
// ---------------------------------------------------------------------------

/** feature_status tasks 行上**必须恰好**出现的键（少键/改名即红；加键须显式更新本清单） */
const ROW_KEYS = [
  "taskId",
  "projectId",
  "state",
  "prompt",
  "remoteTaskId",
  "dependencies",
  "inputArtifacts",
  "updatedAt",
  "failureKind",
  "retryCount",
  "baseChars",
  "renderedChars",
  "wrappedChars",
  "attempts",
  "diagnostics",
] as const;

/** ② 透传 diagnostics 的键闭集与类型期望（§2.3 键表逐字对齐；machine 全报 ⇒ 全透传） */
const DIAG_TYPED: Record<string, "number" | "boolean" | "string"> = {
  turn: "number",
  sessionReused: "boolean",
  sessionResumed: "boolean",
  promptChars: "number",
  injectedChars: "number",
  resultChars: "number",
  partialChars: "number",
  blockCount: "number",
  lastBlockIndex: "number",
  replayDropped: "number",
  outcomeAmbiguous: "boolean",
  ambiguousReason: "string",
  continueAttempts: "number",
};

/** machine 全键样本（含白名单外键 `stage`，用于固化「白名单不外泄」） */
const DIAG_FULL = {
  turn: 4,
  sessionReused: true,
  sessionResumed: true,
  promptChars: 2_048,
  injectedChars: 0,
  resultChars: 120,
  partialChars: 96,
  blockCount: 3,
  lastBlockIndex: 1_500,
  replayDropped: 2,
  outcomeAmbiguous: false,
  ambiguousReason: "multi-block",
  continueAttempts: 1,
  stage: "success",
};

test("O4 锚 3：feature_status 行与 task_status 的键名集合、逐键类型固化（全量 diagnostics 样本）", async () => {
  const fid = okOrThrow(core.featureCreate({ title: "O4 键名固化" }), "featureCreate").featureId;
  const BASE = "任务正文O4-键锚";
  createTask({
    taskId: "t-o4-keys",
    projectId: "alpha",
    contextId: "ctx-o4-keys",
    state: "working",
    prompt: BASE,
    featureId: fid,
    dispatchMessage: BASE,
    dispatchRendered: `${shellFor(0)}${BASE}`,
  });
  upsertTaskResult({
    machineId: "m1",
    taskId: "t-o4-keys",
    projectId: "alpha",
    contextId: "ctx-o4-keys",
    state: "failed",
    text: "执行失败",
    featureId: fid,
    remoteTaskId: "r-o4-keys",
    diagnostics: DIAG_FULL,
  });

  const row = taskSummary(fid, "t-o4-keys");

  // 键名集合固化（逐字比较排序后的 keys 数组）
  assert.deepEqual(
    Object.keys(row).sort(),
    [...ROW_KEYS].sort(),
    "feature_status tasks 行键集合与固化清单不一致（加键/改名/丢键即红）",
  );

  // 派生 4 键恒有值 + 类型固化
  for (const key of ["baseChars", "renderedChars", "wrappedChars", "attempts"] as const) {
    assert.equal(typeof row[key], "number", `${key} 必须是 number，实际 ${typeof row[key]}`);
    assert.ok(Number.isInteger(row[key]) && row[key] >= 0, `${key} 应为非负整数，实际 ${row[key]}`);
  }
  assert.equal(typeof row.retryCount, "number");
  assert.equal(row.attempts, row.retryCount + row.diagnostics.continueAttempts!);
  assert.equal("turns" in row, false, "派生键名 = attempts，不得漂移成 turns");

  // 透传键：键集合固化 + 逐键类型固化 + 白名单不外泄
  assert.deepEqual(
    Object.keys(row.diagnostics).sort(),
    Object.keys(DIAG_TYPED).sort(),
    "diagnostics 白名单键集合固化（machine 全报 ⇒ 全透传；白名单外键不外泄）",
  );
  for (const [key, expected] of Object.entries(DIAG_TYPED)) {
    const actual = (row.diagnostics as Record<string, unknown>)[key];
    assert.equal(
      typeof actual,
      expected,
      `diagnostics.${key} 类型应为 ${expected}，实际 ${typeof actual}`,
    );
  }
  assert.equal("stage" in row.diagnostics, false, "白名单外 machine 键必须被投影滤掉");
  assert.equal(
    row.diagnostics.outcomeAmbiguous,
    false,
    "machine 报了 false ⇒ 透传 false，不得省略",
  );

  // task_status 成功分支：② 键存在 + 与 feature 面同值（单一实现）
  const mirrored = okOrThrow(await core.taskStatus("t-o4-keys"), "taskStatus");
  assert.equal(mirrored.status, "failed");
  for (const key of ["baseChars", "renderedChars", "wrappedChars", "attempts"] as const) {
    assert.ok(key in mirrored, `task_status 成功分支缺 ② 键 ${key}`);
    assert.equal(mirrored[key], row[key], `${key} 两面必须同值`);
  }
  assert.ok("diagnostics" in mirrored, "task_status 成功分支缺 diagnostics");
  assert.deepEqual(mirrored.diagnostics, row.diagnostics, "diagnostics 两面同值");
  assert.equal(outboundCount, 0, "纯读锚零出站");
});
