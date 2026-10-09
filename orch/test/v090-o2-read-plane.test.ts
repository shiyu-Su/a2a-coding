/**
 * v0.9.0 O2（REQ-v0.9.0-2026-09-24-01 · 改造文档 §3.1 B3″）—— **orch 读面**。
 *
 * 锁定的行为面（逐条对应 B3″ 的三个分句）：
 *
 * 1. **列表 `stateCounts` 走聚合 SQL**（`GROUP BY feature_id, state`）并顺带派生 `taskCount`
 *    ⇒ 列表读「1 + N → O(1)」。
 *    **语义等价性**：出参的 `stateCounts` / `taskCount` 与「改前逐 Feature 数 `listFeatureTasks`」
 *    的**枚举真值**逐 Feature、逐任务态全等（含「零节点 ⇒ 空对象而非补 0」「`feature_id` NULL 的
 *    独立任务不得被聚合捞进」「他组 Feature 不冒计数」三个边界）。
 *    ★ 归属谓词与 `listFeatures` **同源**（`featureOwnershipPredicate`），此处以行为等价性反向锁定。
 *
 * 2. **`store.listEvents` 的 `featureId` 过滤 = 纯读口**：负向锁「**绝不推进宿主收件箱游标**」——
 *    读面反复扫过某 Feature 的事件后，宿主下一次 `a2a_events` 仍**逐条**拿到此前未读的事件；
 *    并以「同一条 `a2a_events` 再读 ⇒ 0 条」作对照防 vacuous。**全程不经 `handleEvents`**。
 *
 * 3. **新事件 kind `feature.stage`**：`stage` / `version` / `approval` **任一真变化才发**
 *    （同值重复写 ⇒ 零事件；`NULL` 存量行写成归一后的缺省值 ⇒ 零事件），
 *    同单多字段变更**只发一条**（`payload.fields` 逐项 from/to），**零 DDL**。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENT_FEATURE_STAGE,
  EVENT_FEATURE_STATE,
  SessionStore,
  appendEvent,
  createFeature,
  createTask,
  featureTaskStateCounts,
  listEvents,
  listFeatureTasks,
  updateFeatureRegistration,
  versionLedgerCreate,
} from "../session/store.js";
import type { EventRecord, FeatureRecord, TaskState } from "../types.js";
import type { BridgeCore } from "../bridge/index.js";
import type { EventsOutcome } from "../bridge/index.js";
import type { FeatureStatusSuccess, FeatureToolFailure } from "../bridge/feature-tools.js";

// 只读面 ⇒ 任何出站即失败（照 `mount-ownership-scope.test.ts` 的桩口径）
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`读面路径不应有任何出站请求：${url}`);
}) satisfies FetchFn;

// 两机组：gA = { m1 / alpha }、gB = { m2 / beta }（`MACHINES_CONFIG` 是 bridge/index.ts 的
// 模块加载期常量 ⇒ 必须在 import 之前写好）
const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-v090-o2-"));
const CFG_PATH = join(CFG_DIR, "config.json");
process.env["MACHINES_CONFIG"] = CFG_PATH;
writeFileSync(
  CFG_PATH,
  JSON.stringify(
    {
      machines: [{ machineId: "m1" }, { machineId: "m2" }],
      projectGroup: [
        { name: "gA", members: [{ machineId: "m1", projectId: "alpha" }] },
        { name: "gB", members: [{ machineId: "m2", projectId: "beta" }] },
      ],
    },
    null,
    2,
  ),
  "utf8",
);

const { createCore } = await import("../bridge/index.js");
const coreA: BridgeCore = createCore("gA");
const coreB: BridgeCore = createCore("gB");
const coreAnon: BridgeCore = createCore(null); // 未配组 / 3300 运维全量视图

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(CFG_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具助手
// ---------------------------------------------------------------------------

function mustOk<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) {
    const f = outcome as unknown as FeatureToolFailure;
    throw new Error(`期望成功，实际失败：${f.code} ${f.error}`);
  }
  return outcome as Extract<T, { ok: true }>;
}

/** 列表分支的一行出参 */
interface CountRow {
  featureId: string;
  taskCount: number;
  stateCounts: Partial<Record<TaskState, number>>;
}

function listRows(core: BridgeCore): Map<string, CountRow> {
  const list = mustOk(core.featureStatus({})) as FeatureStatusSuccess;
  return new Map(
    (list.features ?? []).map((f) => [
      f.featureId,
      { featureId: f.featureId, taskCount: f.taskCount, stateCounts: f.stateCounts },
    ]),
  );
}

/**
 * **改前语义的枚举真值**：逐 Feature 取 `listFeatureTasks`（列表旧分支就是它的 `.length`），
 * 逐态计数在 JS 侧累加。与 SQL 聚合完全独立，才配当对照。
 */
function enumerate(featureId: string): {
  counts: Partial<Record<TaskState, number>>;
  taskCount: number;
} {
  const tasks = listFeatureTasks(featureId, { limit: 1000 });
  const counts: Partial<Record<TaskState, number>> = {};
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  return { counts, taskCount: tasks.length };
}

function featureIdOf(outcome: { ok: boolean; featureId?: string }): string {
  return mustOk(outcome as { ok: true; featureId: string }).featureId;
}

/** 造一个带指定节点态分布的 Feature（`prefix` 保证 taskId 全局唯一） */
function featureWithTasks(
  core: BridgeCore,
  title: string,
  prefix: string,
  states: TaskState[],
  projectId = "alpha",
): string {
  const featureId = featureIdOf(core.featureCreate({ title }));
  states.forEach((state, i) => {
    createTask({
      taskId: `${prefix}-t${String(i)}`,
      projectId,
      contextId: `${prefix}-c${String(i)}`,
      state,
      featureId,
    });
  });
  return featureId;
}

/** 某 Feature 的 `feature.stage` 事件（按 B3″ 的 featureId 只读过滤取） */
function stageEvents(featureId: string): EventRecord[] {
  return listEvents({ featureId }).filter((e) => e.kind === EVENT_FEATURE_STAGE);
}

function countKind(featureId: string, kind: string): number {
  return listEvents({ featureId }).filter((e) => e.kind === kind).length;
}

function failureCodeOf(outcome: { ok: boolean }): string | null {
  return outcome.ok ? null : (outcome as unknown as FeatureToolFailure).code;
}

function fieldsOf(event: EventRecord | undefined): Array<Record<string, unknown>> {
  const parsed = JSON.parse(String(event?.payload)) as { fields: Array<Record<string, unknown>> };
  return parsed.fields;
}

// ---------------------------------------------------------------------------
// 1. 聚合 SQL 与「1 + N」旧实现逐 Feature 等价
// ---------------------------------------------------------------------------

test("B3″ 列表 stateCounts / taskCount：与改前「逐 Feature 数 listFeatureTasks」逐行等价", () => {
  const multi = featureWithTasks(coreA, "多态混合", "o2a", [
    "working",
    "completed",
    "completed",
    "failed",
    "blocked",
    "input-required",
  ]);
  const empty = featureIdOf(coreA.featureCreate({ title: "零节点" }));
  const workingOnly = featureWithTasks(coreA, "全在飞", "o2b", ["working", "working"]);

  const rows = listRows(coreA);
  for (const featureId of [multi, empty, workingOnly]) {
    const row = rows.get(featureId);
    assert.ok(row !== undefined, `列表应含 Feature ${featureId}`);
    const truth = enumerate(featureId);
    assert.deepEqual(row.stateCounts, truth.counts, `${featureId} 逐态计数须与枚举真值全等`);
    assert.equal(row.taskCount, truth.taskCount, `${featureId} taskCount 须与旧口径同值`);
    assert.equal(
      row.taskCount,
      Object.values(row.stateCounts).reduce((s, n) => s + (n ?? 0), 0),
      "taskCount 必须由 stateCounts 派生",
    );
  }

  assert.deepEqual(rows.get(empty)?.stateCounts, {}, "零节点 ⇒ 空对象（键缺席，不是补 0）");
  assert.deepEqual(
    rows.get(workingOnly)?.stateCounts,
    { working: 2 },
    "只回实有态的键（五态补 0 会造出旧实现没有的形状）",
  );
  assert.deepEqual(rows.get(multi)?.stateCounts, {
    working: 1,
    completed: 2,
    failed: 1,
    blocked: 1,
    "input-required": 1,
  });
  assert.equal(rows.get(multi)?.taskCount, 6);

  // 单 Feature 详情分支的出参与行为**零变更**（additive 只落列表）
  const one = mustOk(coreA.featureStatus({ featureId: multi }));
  assert.equal(one.feature?.featureId, multi);
  assert.equal(one.tasks?.length, 6, "详情分支仍走 listFeatureTasks（逐节点摘要）");
  assert.equal(one.features, undefined, "详情分支不得冒出列表字段");
});

test("B3″ 聚合继承归属谓词：他组 Feature 不冒计数、NULL 归属行走 fail-closed", () => {
  const a = featureWithTasks(coreA, "甲组", "o2c", ["completed", "completed"]);
  // gA 的 Feature 挂一个**跑在他组项目上**的节点：计数归属看 Feature，不看项目
  createTask({ taskId: "o2c-a-cross", projectId: "beta", contextId: "o2c-cc", state: "failed", featureId: a });
  const b = featureWithTasks(coreB, "乙组", "o2d", ["working"]);
  // `feature_id` NULL 的独立任务：聚合不得把它挂到任何 Feature 上
  createTask({ taskId: "o2c-x0", projectId: "alpha", contextId: "o2c-cx", state: "completed" });
  // 无归属 Feature（owner_group NULL）：配组视野看不见 ⇒ 聚合侧同样不得出现
  const orphan = createFeature({
    featureId: "o2-orphan-feature",
    title: "无归属",
    state: "executing",
    ownerGroup: null,
  }).featureId;
  createTask({ taskId: "o2c-o1", projectId: "alpha", contextId: "o2c-co1", state: "failed", featureId: orphan });

  const countsA = featureTaskStateCounts("gA");
  assert.deepEqual(countsA.get(a), { completed: 2, failed: 1 }, "本组 Feature 计数含跨组项目的节点");
  assert.equal(countsA.has(b), false, "他组 Feature 不得出现在 gA 的聚合里");
  assert.equal(countsA.has(orphan), false, "NULL 归属被组视野排除 ⇒ 聚合同侧排除（fail-closed 不放宽）");
  assert.equal(featureTaskStateCounts("gB").has(a), false, "对称：gB 也看不见 gA 的 Feature");

  // 列表出参侧：组视野判据不变，且每行计数仍与枚举真值等价
  const listA = listRows(coreA);
  assert.ok(listA.has(a) && !listA.has(b) && !listA.has(orphan), "列表视野与改前一致");
  for (const [featureId, row] of listA) {
    assert.equal(row.taskCount, enumerate(featureId).taskCount, `${featureId} 组内等价`);
  }

  // 无身份（web 运维视图）⇒ 全量视野，聚合与枚举逐行等价（含 NULL 归属行）
  const anonRows = listRows(coreAnon);
  assert.ok(anonRows.has(orphan), "无身份仍列 NULL 归属行（与改前一致）");
  assert.equal(
    anonRows.get(orphan)?.taskCount,
    enumerate(orphan).taskCount,
    "NULL 归属 Feature 在无身份列表里的计数仍与旧口径同值",
  );
  for (const [featureId, row] of anonRows) {
    assert.equal(row.taskCount, enumerate(featureId).taskCount, `${featureId} 全量视野等价`);
  }
});

// ---------------------------------------------------------------------------
// 2. listEvents 的 featureId 过滤：纯读、绝不推进宿主游标
// ---------------------------------------------------------------------------

test("B3″ listEvents(featureId) 只读收窄 + 负向：读面扫过后宿主 a2a_events 仍拿到全部未读事件", () => {
  const featureId = featureIdOf(coreA.featureCreate({ title: "读面扫描对象" }));
  appendEvent({ kind: "runner.registered" }); // 孤儿事件（feature_id NULL，两组可见）
  const theirs = appendEvent({
    featureId: featureIdOf(coreB.featureCreate({ title: "乙组事件" })),
    kind: "feature.state",
    state: "executing",
  }).eventId;

  // 宿主先空读一次 ⇒ 游标按身份初始化在「本组可见最大值」（窗口起点，之后本组才新增事件）
  const base = mustOk(coreA.events() as EventsOutcome);
  const cursorAtBase = base.cursor;
  const scope = { ownerGroup: "gA", projectIds: ["alpha"] };
  // 独立预言机（**走的是另一条读路径**：store 直读 + 案 B 谓词，不经读面过滤口）
  const oracle = (): number[] =>
    listEvents({ since: cursorAtBase, scope, limit: 1000 })
      .map((e) => e.eventId)
      .sort((x, y) => x - y);

  const mine = [
    appendEvent({ featureId, kind: EVENT_FEATURE_STAGE, state: null }).eventId,
    appendEvent({ featureId, kind: "task.settled", state: "completed" }).eventId,
  ];

  // --- 过滤语义：只回该 Feature 的事件，升序
  assert.deepEqual(
    listEvents({ featureId }).map((e) => e.eventId),
    mine,
    "featureId 过滤 = 只回本 Feature 两条（他组 / 孤儿被排除）",
  );
  assert.equal(listEvents({ featureId: "no-such-feature" }).length, 0, "未知 Feature ⇒ 空，不抛");

  // --- 基线：宿主此刻确实**未读**这些事件（防「窗口本来就空」的 vacuous）
  const expected = oracle();
  assert.deepEqual(
    [...mine, ...expected.filter((id) => !mine.includes(id))].sort((x, y) => x - y),
    expected,
    "本组未读集合应含本用例新造的两条",
  );

  // --- ★ 游标零推进（负向主证）：读面反复扫 5 次，宿主下一次读仍**一条不少**
  for (let i = 0; i < 5; i += 1) {
    assert.equal(listEvents({ featureId }).length, 2, "读面自身反复扫也是同结果（无服务端进度）");
    assert.equal(listEvents({ featureId, since: 0, limit: 1000 }).length, 2, "同上（显式 since 也不记进度）");
  }
  const host = mustOk(coreA.events() as EventsOutcome);
  assert.deepEqual(
    host.events.map((e) => e.eventId).sort((x, y) => x - y),
    expected,
    "宿主必须拿到全部未读事件（含 feature.stage 与 task.settled）—— 被读面吃掉任何一条则本断言变红",
  );
  for (const id of mine) {
    assert.ok(
      host.events.some((e) => e.eventId === id),
      `逐条对上：宿主增量缺了 ${String(id)}（不是「条数恰好相等」的巧合）`,
    );
  }
  assert.equal(
    host.events.some((e) => e.eventId === theirs),
    false,
    "他组事件不得进本组增量（featureId 过滤不旁路案 B 谓词）",
  );
  assert.ok(host.cursor > cursorAtBase, "宿主游标只由宿主自己的读推进");

  // --- 对照（防 vacuous）：同一条 `a2a_events` 再读 ⇒ 0 条，说明上一轮**确实**消费了那批事件
  assert.equal(mustOk(coreA.events() as EventsOutcome).count, 0, "handleEvents 的消费语义未被削弱");

  // --- 与 scope 组合（案 B 谓词 ∧ featureId 同时生效）
  assert.equal(listEvents({ scope, featureId }).length, 2, "组内扫本 Feature：两条都在");
  assert.equal(
    listEvents({ scope: { ownerGroup: "gB", projectIds: ["beta"] }, featureId }).length,
    0,
    "他组身份点名本组 featureId 也拿不到 ⇒ 过滤口不成为跨组读洞",
  );
});

// ---------------------------------------------------------------------------
// 3. feature.stage：只在值真变化时发
// ---------------------------------------------------------------------------

test("B3″ feature.stage：create 不发；advance / approve 真变化各发一条并带 from/to", () => {
  const featureId = featureIdOf(
    coreA.featureCreate({ title: "登记流水", stage: "需求分析", approval: "未发起" }),
  );
  assert.equal(stageEvents(featureId).length, 0, "create 是建行不是变更 ⇒ 零事件（既有迁移纪律）");

  mustOk(coreA.featureAdvance({ featureId, to: "waiting_approval", stage: "改造方案" }));
  const afterStage = stageEvents(featureId);
  assert.equal(afterStage.length, 1, "stage 真变化 ⇒ 恰一条");
  assert.deepEqual(fieldsOf(afterStage[0]), [{ field: "stage", from: "需求分析", to: "改造方案" }]);
  assert.equal(afterStage[0]?.state, null, "本事件不承载引擎态（state 列留 NULL）");
  assert.equal(afterStage[0]?.taskId, null, "Feature 级事件不带 taskId");
  assert.equal(afterStage[0]?.featureId, featureId, "归属落 feature_id（案 B 谓词据此反查）");

  // **B2″ 门看 `approval`、不看 `stage`**：`未发起` ⇒ 结构化拒绝，不放行、不改任何登记值 ⇒
  // 拒绝路径必须**零事件**（否则读面会收到一条解释不了任何变化的通知）
  const rejected = coreA.featureApprove({ featureId });
  assert.equal(failureCodeOf(rejected), "feature_approval_not_ready");
  assert.equal(stageEvents(featureId).length, 1, "被拒的 approve ⇒ 零 `feature.stage`");
  assert.equal(countKind(featureId, EVENT_FEATURE_STATE), 0, "被拒的 approve ⇒ 零主链事件");

  // 门状态经 O1 的登记写口置「待审批」（真变化 ⇒ 一条），过审才是主链迁移
  mustOk(coreA.featureAdvance({ featureId, to: "waiting_approval", approval: "待审批" }));
  const afterGate = stageEvents(featureId);
  assert.equal(afterGate.length, 2, "approval 未发起 → 待审批 ⇒ 再一条");
  assert.deepEqual(fieldsOf(afterGate[1]), [{ field: "approval", from: "未发起", to: "待审批" }]);

  mustOk(coreA.featureApprove({ featureId }));
  const afterApprove = stageEvents(featureId);
  assert.equal(afterApprove.length, 3, "approve 落门状态 = approval 真变化 ⇒ 再一条");
  assert.deepEqual(
    fieldsOf(afterApprove[2]),
    [{ field: "approval", from: "待审批", to: "已通过" }],
  );
  assert.equal(
    countKind(featureId, EVENT_FEATURE_STATE),
    1,
    "feature.state 仍只由主链迁移发：三次登记 advance 均不迁态、只有 approve 迁一条 ⇒ 两 kind 正交",
  );
});

test("B3″ feature.stage：同值重复写 ⇒ 零事件；同单多字段 ⇒ 一条；NULL → 缺省 ⇒ 零事件", () => {
  // v0.10.0 §7 排期写状态锁：写 `version` 仅当卡处 `需求分析 ∧ 未发起`；存在性亦已执法 ⇒ 先建卡态 + 预登记版号。
  versionLedgerCreate({ ownerGroup: "gA", version: "v0.9.0" });
  // ① 同值重复写（宿主把同一 stage / 同一 version 再 advance 一次）
  const a = featureIdOf(coreA.featureCreate({ title: "重复写", stage: "需求分析", approval: "未发起" }));
  mustOk(coreA.featureAdvance({ featureId: a, to: "waiting_approval", stage: "需求分析" }));
  assert.equal(stageEvents(a).length, 0, "stage 同值 ⇒ 零事件");
  mustOk(coreA.featureAdvance({ featureId: a, to: "waiting_approval", version: "v0.9.0" }));
  assert.equal(stageEvents(a).length, 1, "version 真变化 ⇒ 一条");
  mustOk(coreA.featureAdvance({ featureId: a, to: "waiting_approval", version: "v0.9.0" }));
  assert.equal(stageEvents(a).length, 1, "version 重复写 ⇒ 不再加条");
  mustOk(coreA.featureAdvance({ featureId: a, to: "waiting_approval", approval: "未发起" }));
  assert.equal(stageEvents(a).length, 1, "approval 写同值（已「未发起」）⇒ 仍零事件");

  // ② 同单多字段变更 ⇒ 恰好一条（一次 advance 是一次事实）
  const b = featureIdOf(coreA.featureCreate({ title: "同单多字段", stage: "需求分析", approval: "未发起" }));
  mustOk(
    coreA.featureAdvance({
      featureId: b,
      to: "waiting_approval",
      stage: "改造方案",
      version: "v0.9.0",
      approval: "未发起",
    }),
  );
  const bEvents = stageEvents(b);
  assert.equal(bEvents.length, 1, "三字段同单变化 ⇒ 恰好一条（不拆条）");
  assert.deepEqual(
    fieldsOf(bEvents[0]).map((f) => f.field),
    ["stage", "version"],
    "真变化的两字段进 fields；写同值的 approval 不进",
  );

  // ③ `NULL` 存量行：写成「归一后的缺省值」⇒ 不算变化；写成真值 ⇒ 算变化
  const store = new SessionStore(":memory:");
  try {
    const legacy = store
      .createFeature({ featureId: "legacy-o2", title: "存量", state: "waiting_approval" })
      .featureId; // 登记三列出存储层不填 ⇒ NULL
    assert.equal(store.getFeature(legacy)?.stage, "改造方案", "NULL 读回归一为缺省");
    assert.equal(store.getFeature(legacy)?.approval, "待审批", "同上（门）");
    assert.equal(store.listEvents({ featureId: legacy }).length, 0, "起点零事件");

    store.updateFeatureRegistration(legacy, { stage: "改造方案", version: "", approval: "待审批" });
    assert.equal(
      store.listEvents({ featureId: legacy }).filter((e) => e.kind === EVENT_FEATURE_STAGE).length,
      0,
      "NULL → 缺省值（归一后相等）⇒ 不发事件（脏值归一不得灌收件箱）",
    );

    store.updateFeatureRegistration(legacy, { stage: "发版" });
    const emitted = store
      .listEvents({ featureId: legacy })
      .filter((e) => e.kind === EVENT_FEATURE_STAGE);
    assert.equal(emitted.length, 1, "NULL → 真值 ⇒ 一条");
    assert.deepEqual(fieldsOf(emitted[0]), [{ field: "stage", from: "改造方案", to: "发版" }]);
    assert.equal(store.getFeature(legacy)?.state, "waiting_approval", "登记写口不动主链态");
    assert.equal(
      store.listEvents({ featureId: legacy }).filter((e) => e.kind === EVENT_FEATURE_STATE).length,
      0,
      "登记面不冒 feature.state",
    );
  } finally {
    store.close();
  }
});

test("B3″ 零 DDL：登记面不发主链事件、空 patch / 未知 Feature 不发事件；EventRecord 形状不变", () => {
  const featureId = featureIdOf(coreA.featureCreate({ title: "空写" }));
  const untouched = updateFeatureRegistration(featureId, {});
  assert.equal((untouched as FeatureRecord | null)?.featureId, featureId, "空 patch 仍回读原行");
  assert.equal(stageEvents(featureId).length, 0, "空 patch（零写入）⇒ 零事件");
  assert.equal(updateFeatureRegistration("no-such-feature", { stage: "回归" }), null, "未知 Feature ⇒ null");
  assert.equal(listEvents({ featureId: "no-such-feature" }).length, 0, "未知 Feature 无事件");

  // 事件面形状：kind 是既有自由文本列（无新列、无迁移）⇒ 出参字段集与既有一致
  const rec = appendEvent({ featureId, kind: EVENT_FEATURE_STAGE, state: null, payload: "{}" });
  assert.deepEqual(
    Object.keys(rec).sort(),
    ["createdAt", "eventId", "featureId", "kind", "payload", "state", "taskId"].sort(),
    "EventRecord 形状不变（零 DDL 的出参侧佐证）",
  );
  assert.equal(stageEvents(featureId).length, 1, "手工 append 也能被 featureId 过滤读到");
});
