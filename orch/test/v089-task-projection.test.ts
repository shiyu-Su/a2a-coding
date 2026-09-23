/**
 * v0.8.9 O3 出参锚 · ② 的 **orch 侧只读投影**（节点 O3）。
 *
 * 锚命题（改造文档 §2.3「orch 侧（投影，只增出参字段、零写口）」+ §4-5 / §4-13）：
 * - `a2a_feature_status` 的 tasks 行与 `a2a_task_status` 的成功分支**同键同值**
 *   （同一实现 `projectTaskVisibility`，不存在第二套口径）；
 * - 派生 4 键恒有值：`baseChars` / `renderedChars`（`dispatch_rendered` NULL ⇒ **回退 base 长度**）/
 *   `wrappedChars`（= 差值，①-a 去重可证指标）/ `attempts`；
 * - **`attempts` = `retry_count` + `diagnostics.continueAttempts`**，与 `retryCount`、与 machine 的
 *   `turn` **三者同排可区分**（一条 `retryCount=1` + `continueAttempts=1` + `turn=3` 的样本 ⇒
 *   `attempts=2` / `retryCount=1` / `turn=3`）；名不叫 `turns`；
 * - machine 键**只透传、不计算**：`turn` 缺失时**不得**由「同 `contextId` 任务条数」反推
 *   （两任务同 ctx、均无 diagnostics ⇒ 两侧都不出 `turn`）；类型不符（脏值）与缺键一律**省略**，
 *   **不补 `0` / `false`**（「没报」≠「报了 0」）；投影是**白名单** ⇒ 白名单外键不外泄。
 *
 * 夹具同 `v089-render-split.test.ts`：`:memory:` 库 + 零出站桩 + 组 g1（成员 m1/alpha）。
 * 本文件**不派发**（Feature 停 `waiting_approval`、不 kick 调度器）⇒ 投影所需账面全部由
 * `createTask` / `upsertTaskResult` / `rearmForRetry` 直接种出。
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
  createTask,
  rearmForRetry,
  runnerProjectsReplace,
  upsertRunner,
  upsertTaskResult,
} from "../session/store.js";
import { projectTaskVisibility, type FeatureTaskSummary } from "../bridge/feature-tools.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 夹具：零出站计数桩 + 机器清单（m1/alpha，组 g1）
// ---------------------------------------------------------------------------

let outboundCount = 0;
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;
const throwingFetch: FetchFn = async (input) => {
  outboundCount += 1;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`单测未预期的出站请求（投影是纯读面，桥侧零出站）：${url}`);
};
globalThis.fetch = throwingFetch;

const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-o3-projection-"));
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
  "utf8",
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

function okOrThrow<T extends { ok: boolean }>(v: T, what: string): Extract<T, { ok: true }> {
  assert.equal(v.ok, true, `${what} 应成功：${JSON.stringify(v)}`);
  return v as Extract<T, { ok: true }>;
}

/** `a2a_feature_status` 的 tasks 行（按 taskId 取；必须是成功分支） */
function taskSummary(featureId: string, taskId: string): FeatureTaskSummary {
  const view = okOrThrow(core.featureStatus({ featureId }), "featureStatus");
  const row = (view.tasks ?? []).find((t) => t.taskId === taskId);
  assert.ok(row !== undefined, `tasks 行应存在：${taskId}`);
  return row;
}

const SHELL = "<feature-context>\n## 统一方案（plan）\n方案v1\n</feature-context>\n\n---\n\n";

/**
 * machine 侧 diagnostics 的**真实形状**（v0.8.9 · M2 键表）：含两个**白名单外**键
 * （`stage` / `promptElapsedMs`），用于断言投影是白名单、不是整包 dump。
 */
const DIAG = {
  stage: "success",
  promptElapsedMs: 61_200,
  turn: 3,
  sessionReused: true,
  sessionResumed: false,
  promptChars: 1_440,
  injectedChars: 0,
  resultChars: 88,
  partialChars: 88,
  blockCount: 2,
  lastBlockIndex: 1_207,
  replayDropped: 1,
  outcomeAmbiguous: true,
  ambiguousReason: "multi-block",
  continueAttempts: 1,
};

/** 一个带 ② 账面的节点：base + 渲染快照 + 一次 failed 上报（带 diagnostics）+ 一次宿主重派 */
function seedProjectedNode(featureId: string, taskId: string, base: string): void {
  createTask({
    taskId,
    projectId: "alpha",
    contextId: `ctx-${taskId}`,
    state: "working",
    prompt: base,
    featureId,
    dispatchMessage: base,
    dispatchRendered: `${SHELL}${base}`,
  });
  upsertTaskResult({
    machineId: "m1",
    taskId,
    projectId: "alpha",
    contextId: `ctx-${taskId}`,
    state: "failed",
    text: "执行失败",
    featureId,
    remoteTaskId: `r-${taskId}`,
    diagnostics: DIAG,
  });
  // 宿主重派一次 ⇒ `retry_count` = 1（唯一写口；**不动** diagnostics_json）
  assert.equal(rearmForRetry(taskId, base), true, "rearmForRetry 应命中 failed 行");
}

// ---------------------------------------------------------------------------
// 1. 纯函数算术（无库）：回退 / 差值 / attempts / 省略纪律
// ---------------------------------------------------------------------------

test("O3 投影算术：rendered NULL 回退 base、wrappedChars = 差值、attempts = retry_count + continueAttempts", () => {
  const BASE = "任务正文O3";

  // ① 未渲染（历史行 / 登记态）⇒ renderedChars **回退显示 base 长度** ⇒ 包裹量 0
  assert.deepEqual(
    projectTaskVisibility({
      dispatchMessage: BASE,
      dispatchRendered: null,
      retryCount: 0,
      diagnosticsJson: null,
    }),
    {
      baseChars: BASE.length,
      renderedChars: BASE.length,
      wrappedChars: 0,
      attempts: 0,
      diagnostics: {},
    },
  );

  // ② 有渲染快照 ⇒ wrappedChars = 壳体积（**恒等于一层壳**，与 base 长短无关）
  const projected = projectTaskVisibility({
    dispatchMessage: BASE,
    dispatchRendered: `${SHELL}${BASE}`,
    retryCount: 0,
    diagnosticsJson: null,
  });
  assert.equal(projected.renderedChars, projected.baseChars + SHELL.length);
  assert.equal(projected.wrappedChars, SHELL.length);
  assert.equal(
    projectTaskVisibility({
      dispatchMessage: BASE + BASE, // base 翻倍
      dispatchRendered: `${SHELL}${BASE}${BASE}`,
      retryCount: 0,
      diagnosticsJson: null,
    }).wrappedChars,
    projected.wrappedChars,
    "壳体积不随 base 体积增长（①-a 指标的可加性）",
  );

  // ③ attempts：两个加数各自独立可见（**不是** retryCount 的别名）
  const oneEach = projectTaskVisibility({
    dispatchMessage: BASE,
    dispatchRendered: `${SHELL}${BASE}`,
    retryCount: 1,
    diagnosticsJson: JSON.stringify({ continueAttempts: 1 }),
  });
  assert.equal(oneEach.attempts, 2, "retry_count=1 + continueAttempts=1 ⇒ attempts=2");
  assert.equal(oneEach.diagnostics.continueAttempts, 1, "加数本身随投影带出（可核算）");
  assert.equal(
    projectTaskVisibility({
      dispatchMessage: BASE,
      dispatchRendered: null,
      retryCount: 3,
      diagnosticsJson: JSON.stringify({}), // machine 未报 continueAttempts
    }).attempts,
    3,
    "无续跑 ⇒ attempts 退化为 retry_count",
  );

  // ④ 省略纪律：脏 JSON / 脏类型 ⇒ **省略该键**，不补 0/false、不抛
  const dirty = projectTaskVisibility({
    dispatchMessage: null,
    dispatchRendered: null,
    retryCount: 0,
    diagnosticsJson: "{not json",
  });
  assert.deepEqual(dirty.diagnostics, {});
  const typed = projectTaskVisibility({
    dispatchMessage: null,
    dispatchRendered: null,
    retryCount: 0,
    diagnosticsJson: JSON.stringify({
      turn: "3", // 类型不符 ⇒ 不报
      blockCount: -1, // 非有限非负 ⇒ 不报
      ambiguousReason: "", // 空串 ⇒ 不报
      sessionResumed: 0, // 非布尔 ⇒ 不报
      promptChars: 0, // **真报了 0** ⇒ 必须保留（不得与「没报」混同）
    }),
  }).diagnostics;
  assert.deepEqual(typed, { promptChars: 0 }, "只有「机器真报的值」进投影");
});

// ---------------------------------------------------------------------------
// 2. a2a_feature_status 面：键存在 + 类型 + 三本账可区分
// ---------------------------------------------------------------------------

test("O3 出参锚（feature_status）：② 键齐全、类型正确，attempts / retryCount / turn 三账并存且可区分", () => {
  const fid = okOrThrow(core.featureCreate({ title: "O3 投影出参" }), "featureCreate").featureId;
  const BASE = "任务正文O3";
  seedProjectedNode(fid, "t-o3-1", BASE);

  const row = taskSummary(fid, "t-o3-1");

  // 键存在（**恒有值**的派生 4 键 + 透传视图）
  for (const key of ["baseChars", "renderedChars", "wrappedChars", "attempts"] as const) {
    assert.equal(typeof row[key], "number", `${key} 应为 number`);
    assert.notEqual(row[key], null, `${key} 不得为 null`);
  }
  assert.equal(typeof row.diagnostics, "object");
  assert.equal("turns" in row, false, "派生键名 = attempts，**不得**叫 turns");

  // 体积账
  assert.equal(row.baseChars, BASE.length, "baseChars = dispatch_message 字符数");
  assert.equal(row.renderedChars, (SHELL + BASE).length, "renderedChars = dispatch_rendered 字符数");
  assert.equal(row.wrappedChars, SHELL.length, "wrappedChars = renderedChars − baseChars");

  // 三本账同排（§4-13 口径纪律：continueAttempts 不进 retry_count，turn 不是 attempts）
  assert.equal(row.retryCount, 1, "retryCount = 宿主重派 1 次");
  assert.equal(row.attempts, 2, "attempts = retry_count(1) + continueAttempts(1)");
  assert.equal(row.diagnostics.turn, 3, "turn 是 machine 的 ACP 轮次事实，原样透传");
  assert.notEqual(row.attempts, row.retryCount);
  assert.notEqual(row.attempts, row.diagnostics.turn);

  // machine 键逐键原样（**不合并、不改写**：false 照原样保留、partial/result 两键并存）
  assert.deepEqual(row.diagnostics, {
    turn: 3,
    sessionReused: true,
    sessionResumed: false,
    promptChars: 1_440,
    injectedChars: 0,
    resultChars: 88,
    partialChars: 88,
    blockCount: 2,
    lastBlockIndex: 1_207,
    replayDropped: 1,
    outcomeAmbiguous: true,
    ambiguousReason: "multi-block",
    continueAttempts: 1,
  });
  assert.equal(
    "stage" in row.diagnostics || "promptElapsedMs" in row.diagnostics,
    false,
    "投影是**白名单**：§2.3 键表之外的 machine 键不外泄",
  );
  assert.equal(outboundCount, 0, "纯读投影 ⇒ 零出站");
});

// ---------------------------------------------------------------------------
// 3. a2a_task_status 面：与 feature 面同键同值 + 存量行兜底
// ---------------------------------------------------------------------------

test("O3 出参锚（a2a_task_status）：成功分支镜像同值；存量行（未渲染 / 无 diagnostics）走回退不报错", async () => {
  const fid = okOrThrow(core.featureCreate({ title: "O3 两面镜像" }), "featureCreate").featureId;
  const BASE = "任务正文O3-镜像";
  seedProjectedNode(fid, "t-o3-2", BASE);
  // 存量行：既无 dispatch_message、也无 rendered / diagnostics（v0.8.8 前的行形状）
  createTask({
    taskId: "t-o3-legacy",
    projectId: "alpha",
    contextId: "ctx-o3-legacy",
    state: "working",
    prompt: "老任务正文",
    featureId: fid,
  });

  const mirrored = okOrThrow(await core.taskStatus("t-o3-2"), "taskStatus");
  assert.equal(mirrored.status, "working");
  const row = taskSummary(fid, "t-o3-2");
  for (const key of ["baseChars", "renderedChars", "wrappedChars", "attempts"] as const) {
    assert.equal(mirrored[key], row[key], `${key} 两面必须同值（单一实现）`);
  }
  assert.deepEqual(mirrored.diagnostics, row.diagnostics, "diagnostics 两面同值");
  // §4-5：同一任务的**成功轮**体积键在 orch 侧可见（machine 侧成功出口也带 diagnostics）
  assert.equal(mirrored.diagnostics.promptChars, 1_440);
  assert.equal(mirrored.diagnostics.resultChars, 88);

  const legacy = okOrThrow(await core.taskStatus("t-o3-legacy"), "taskStatus(存量行)");
  assert.deepEqual(
    {
      baseChars: legacy.baseChars,
      renderedChars: legacy.renderedChars,
      wrappedChars: legacy.wrappedChars,
      attempts: legacy.attempts,
      diagnostics: legacy.diagnostics,
    },
    { baseChars: 0, renderedChars: 0, wrappedChars: 0, attempts: 0, diagnostics: {} },
    "存量行 ⇒ 全 0 + 空 diagnostics（回退显示，不报错、不编造）",
  );
  assert.equal(outboundCount, 0);
});

// ---------------------------------------------------------------------------
// 4. turn 不反推（§1 表第 6 条的否定锚）
// ---------------------------------------------------------------------------

test("O3 口径锚：turn 只从 diagnostics 透传 —— 同 contextId 两条任务**不得**被反推成 1 / 2", () => {
  const fid = okOrThrow(core.featureCreate({ title: "O3 不反推轮次" }), "featureCreate").featureId;
  for (const id of ["t-o3-turn-a", "t-o3-turn-b"]) {
    // 同一 contextId 的两条任务（若按「同 ctx 任务条数」反推 ⇒ 第二条会出 turn=2）
    createTask({
      taskId: id,
      projectId: "alpha",
      contextId: "ctx-shared-turn",
      state: "working",
      prompt: `正文-${id}`,
      featureId: fid,
      dispatchMessage: `正文-${id}`,
    });
  }
  for (const id of ["t-o3-turn-a", "t-o3-turn-b"]) {
    const row = taskSummary(fid, id);
    assert.equal("turn" in row.diagnostics, false, `${id}：machine 未报 turn ⇒ 键省略（不是 0、不是 1）`);
    assert.equal(row.attempts, 0, `${id}：无重派无续跑 ⇒ attempts=0（与轮次无关）`);
  }
});

// ---------------------------------------------------------------------------
// 5. v0.8.9 · ④ 会话映射可见面（sessionMapSize / sessionMapOldestAgeDays 投影补列）
// ---------------------------------------------------------------------------

test("O3 会话映射键投影：sessionMapSize 透传数值；空映射样本 machine 不报 age ⇒ 出参缺键，不编造 0/false", async () => {
  const fid = okOrThrow(core.featureCreate({ title: "O3 会话映射可见面" }), "featureCreate").featureId;
  const BASE = "任务正文O3-会话映射";

  // 样本 A：非空映射 ⇒ 两键齐报
  createTask({
    taskId: "t-o3-smap-a",
    projectId: "alpha",
    contextId: "ctx-o3-smap-a",
    state: "working",
    prompt: BASE,
    featureId: fid,
    dispatchMessage: BASE,
  });
  upsertTaskResult({
    machineId: "m1",
    taskId: "t-o3-smap-a",
    projectId: "alpha",
    contextId: "ctx-o3-smap-a",
    state: "failed",
    text: "执行失败",
    featureId: fid,
    remoteTaskId: "r-t-o3-smap-a",
    diagnostics: { turn: 1, sessionMapSize: 3, sessionMapOldestAgeDays: 2 },
  });

  // 样本 B：空映射的真实形态 ⇒ machine 只报 size、**不报 age**
  createTask({
    taskId: "t-o3-smap-b",
    projectId: "alpha",
    contextId: "ctx-o3-smap-b",
    state: "working",
    prompt: BASE,
    featureId: fid,
    dispatchMessage: BASE,
  });
  upsertTaskResult({
    machineId: "m1",
    taskId: "t-o3-smap-b",
    projectId: "alpha",
    contextId: "ctx-o3-smap-b",
    state: "failed",
    text: "执行失败",
    featureId: fid,
    remoteTaskId: "r-t-o3-smap-b",
    diagnostics: { turn: 1, sessionMapSize: 0 },
  });

  // feature_status 面（summarizeTask）
  const rowA = taskSummary(fid, "t-o3-smap-a");
  assert.equal(rowA.diagnostics.sessionMapSize, 3, "sessionMapSize 数值原样透传");
  assert.equal(rowA.diagnostics.sessionMapOldestAgeDays, 2, "sessionMapOldestAgeDays 数值原样透传");
  const rowB = taskSummary(fid, "t-o3-smap-b");
  assert.equal(rowB.diagnostics.sessionMapSize, 0, "空映射真报 0 ⇒ 必须保留（≠ 没报）");
  assert.equal(
    "sessionMapOldestAgeDays" in rowB.diagnostics,
    false,
    "machine 缺键 ⇒ 出参缺该键，**不得编造 0/false**",
  );

  // a2a_task_status 面：与 feature 面同键同值（单一实现）
  const mirrorA = okOrThrow(await core.taskStatus("t-o3-smap-a"), "taskStatus(smap-a)");
  assert.deepEqual(mirrorA.diagnostics, rowA.diagnostics, "两面 diagnostics 同值（单一投影实现）");
  const mirrorB = okOrThrow(await core.taskStatus("t-o3-smap-b"), "taskStatus(smap-b)");
  assert.equal(mirrorB.diagnostics.sessionMapSize, 0);
  assert.equal(
    "sessionMapOldestAgeDays" in mirrorB.diagnostics,
    false,
    "task_status 面同样缺键不编造",
  );
  assert.equal(outboundCount, 0);
});
