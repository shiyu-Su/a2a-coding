/**
 * v0.10.2 **O-3**（REQ-2026-10-09-02 · 改造文档 §2.3 F-C6 / F-C7 · §3.1 orch「做」条）——
 * 职责位「**注入与读面**」。
 *
 * 三条验收判据（对应节点任务书）：
 * ① **缺省消息外壳逐字不变**：`unit_agent`（含存量 NULL 归一档）⇒ **不注入** `taskType=` 行，
 *    `dispatch_rendered` 与 v0.8.9 渲染分离的形态**逐字相同**；
 * ② **非缺省含 `taskType=` 行**：注入落在外壳**头部**（`buildNodeDispatchMessage` 的 blocks 首段），
 *    **只进渲染快照** —— `dispatch_message`（base）逐字不变、反复派发**不叠加**；
 * ③ **三读出参字段集一致**：`a2a_feature_status`（`summarizeTask`）· `a2a_feature_trace` ·
 *    `a2a_tasks`（本面**并补 `lane`**）三面同带 `taskType`，**恒有值、不省略字段**，
 *    同一节点三面取值互等；未声明行读回归一 `unit_agent`。
 *
 * 回归检测项形制（§3.1 orch「回归补检测项」）：
 * - **anchor 形制**：闭集取值清单经正则从仓根 `PROTOCOL.md` 的 `task-types` 锚点捕获后**驱动**断言，
 *   本文件**不落硬编码 EXPECTED 副本**（与 `v0102-o1-task-type.test.ts` 同一锚点、同一捕获式）；
 *   注入 / 三处构造点 / 三处出参声明 = **正则解析两侧源码**（`bridge/index.ts` +
 *   `bridge/feature-tools.ts` + `types.ts`）；
 * - **声明链三段**（照根回归 `test-v0.8.10-concurrency.js` 的 `readOnly` 链形制）：入参
 *   （`register-tools.ts` schema）→ 落库列（`store.ts` 列 + `COALESCE`）→ 命令键
 *   （`runner.ts` `toDispatchCommand` 顶层键）。
 *
 * **不做什么** 的回归锁：结果回传面（`/runner/result` 受理段）**不得**出现 `taskType`（F-C7）；
 * 渲染分离纪律不变（渲染函数不回写 base）。
 *
 * 夹具同 `v089-render-split.test.ts`：`:memory:` 库 + 缩短同步预算 + 零出站桩。
 */
process.env["SESSION_DB"] = ":memory:";
process.env["SYNC_BUDGET_MS"] = "300";
process.env["POLL_INTERVAL_MS"] = "40";
process.env["TASK_WATCHER_POLL_INTERVAL_MS"] = "50";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TASK_TYPES, type TaskListItem, type TaskType } from "../types.js";
import {
  getFeature,
  getQueuedTask,
  getTask,
  runnerProjectsReplace,
  updateFeatureContext,
  upsertRunner,
  upsertTaskResult,
} from "../session/store.js";
import type { BridgeCore } from "../bridge/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 缺省职责位 —— 取自 `PROTOCOL.md` dispatch 字段行所载「缺省 `unit_agent`」这一事实，
 * **不是**闭集副本（闭集清单一律经 {@link anchorTaskTypes} 从锚点捕获）。
 */
const DEFAULT_TASK_TYPE: TaskType = "unit_agent";

// ---------------------------------------------------------------------------
// 夹具：零出站计数桩 + 机器清单（m1/alpha，组 g1）
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

const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-v0102-o3-"));
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
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

/** 一轮派发完成的判据（同 `v089-render-split`：渲染快照含本轮 plan 标记 && 已入队占位） */
function dispatchRoundDone(taskId: string, marker: string): boolean {
  const task = getTask(taskId);
  const queued = getQueuedTask(taskId);
  return (
    (task?.dispatchRendered ?? "").includes(marker) &&
    queued !== null &&
    queued.dispatchGuard !== null &&
    queued.queueState === "queued"
  );
}

/** 批释放判据：`dispatchTask(wait:true)` 等满同步预算才清在飞标记 ⇒ 下一 kick 须晚于批收尾 */
const quiesce = (): Promise<void> => sleep(400);

/** 仓根 `PROTOCOL.md`（`dist/test` → 上溯三级 = 仓根，同 `v0102-o1-task-type.test.ts`） */
function protocolText(): string {
  return readFileSync(resolve(HERE, "..", "..", "..", "PROTOCOL.md"), "utf8");
}

/** orch 单元源码（`dist/test` → 上溯两级 = 单元根；**CRLF 归一**，供按 `\n}\n` 切函数体） */
function orchSource(rel: string): string {
  return readFileSync(resolve(HERE, "..", "..", rel), "utf8").replace(/\r\n/g, "\n");
}

/** 从 `PROTOCOL.md` 的 `task-types` 锚点正则捕获闭集清单（无锚点 ⇒ 直接失败，**禁副本**） */
function anchorTaskTypes(): string[] {
  const m = /<!--\s*task-types:\s*([A-Za-z0-9_,\s]+?)\s*-->/.exec(protocolText());
  assert.ok(m !== null && m[1] !== undefined, "PROTOCOL.md 应有 task-types 锚点");
  return (m?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 节点 id → 所属 Feature（只读面按 featureId 查询用） */
const TASK_TO_FEATURE = new Map<string, string>();

function newFeature(title: string, plan: string | null): string {
  const fid = okOrThrow(core.featureCreate({ title }), "featureCreate").featureId;
  assert.ok(fid !== undefined);
  if (plan !== null) updateFeatureContext(fid, { plan });
  return fid;
}

function registerNode(
  message: string,
  featureId: string,
  taskType?: TaskType,
  readOnly?: boolean,
): string {
  const out = okOrThrow(
    core.registerFeatureNode(
      "alpha",
      message,
      undefined,
      featureId,
      [],
      undefined,
      readOnly,
      taskType,
    ),
    "registerFeatureNode",
  );
  assert.ok(out.taskId !== undefined && out.taskId.length > 0);
  const taskId = out.taskId ?? "";
  TASK_TO_FEATURE.set(taskId, featureId);
  return taskId;
}

function report(taskId: string, featureId: string, state: "completed" | "failed", tag: string): void {
  upsertTaskResult({
    machineId: "m1",
    taskId,
    projectId: "alpha",
    contextId: getTask(taskId)?.contextId ?? "",
    state,
    text: tag,
    featureId,
    remoteTaskId: `r-${tag}`,
  });
}

/** 三面出参按 taskId 取行，并统一收成 `Record<string, unknown>` 以便断言「字段存在性」 */
function statusRow(taskId: string): Record<string, unknown> {
  const res = okOrThrow(core.featureStatus({ featureId: featureOf(taskId) }), "featureStatus");
  const row = (res.tasks as unknown as Record<string, unknown>[]).find(
    (t) => t["taskId"] === taskId,
  );
  assert.ok(row !== undefined, `a2a_feature_status 应含节点 ${taskId}`);
  return row;
}

function traceRow(taskId: string): Record<string, unknown> {
  const res = okOrThrow(core.featureTrace({ featureId: featureOf(taskId) }), "featureTrace");
  const row = (res.nodes as unknown as Record<string, unknown>[]).find(
    (n) => n["taskId"] === taskId,
  );
  assert.ok(row !== undefined, `a2a_feature_trace 应含非终态节点 ${taskId}`);
  return row;
}

function featureOf(taskId: string): string {
  const fid = TASK_TO_FEATURE.get(taskId);
  assert.ok(fid !== undefined, `测试内未登记节点 ${taskId} 的 Feature`);
  return fid;
}

/** 非缺省职责位清单（由 TASK_TYPES 过滤缺省档；与锚点同源） */
function nonDefaultTaskTypes(): TaskType[] {
  return TASK_TYPES.filter((t) => t !== DEFAULT_TASK_TYPE);
}

// ---------------------------------------------------------------------------
// ① anchor 形制：闭集清单只来自锚点
// ---------------------------------------------------------------------------

test("v0.10.2 O3 锚点形制：PROTOCOL.md 锚点唯一 + 正则捕获清单 == orch TASK_TYPES", () => {
  const text = protocolText();
  assert.equal(
    countOccurrences(text, "<!-- task-types:"),
    1,
    "task-types 锚点必须全文唯一（两处锚 = 两个事实源）",
  );
  const anchor = anchorTaskTypes();
  assert.ok(anchor.length > 1, "锚点须含缺省档 + 至少一个非缺省档");
  assert.deepEqual([...TASK_TYPES], anchor, "TASK_TYPES 必须逐字等于锚点清单（禁本地副本）");
  assert.ok(anchor.includes(DEFAULT_TASK_TYPE), "锚点必须包含缺省档");
  const dispatchLine =
    text.split(/\r?\n/).find((l) => l.includes("**`taskType`（可选")) ?? "";
  assert.ok(
    dispatchLine.includes(`缺省 \`${DEFAULT_TASK_TYPE}\``),
    "dispatch 字段行须标注缺省档（缺省判据的事实源在锚点侧，不在本测试）",
  );
});

// ---------------------------------------------------------------------------
// ② 声明链三段：入参 → 落库列 → 命令键（静态锚）
// ---------------------------------------------------------------------------

test("v0.10.2 O3 声明链三段：入参 schema → tasks.task_type 列 → DispatchCommand 顶层键", () => {
  assert.match(
    orchSource("bridge/register-tools.ts"),
    /taskType:\s*z\s*\.\s*enum\(\s*TASK_TYPES/,
    "① 入参段：a2aCallSchema.taskType 由 z.enum(TASK_TYPES) 收窄（值域单一源，不另列清单）",
  );
  const store = orchSource("session/store.ts");
  assert.ok(
    store.includes("state, lane, task_type, artifacts_json"),
    "② 落库段：TASK_COLUMNS 含 task_type（列清单单一源）",
  );
  assert.ok(
    store.includes("task_type = COALESCE(excluded.task_type, task_type)"),
    "② 落库段：ON CONFLICT 走 COALESCE（不带职责位的重登记不改档 —— 含调度器重登记）",
  );
  assert.match(
    orchSource("bridge/runner.ts"),
    /rec\.taskType !== "unit_agent"\s*\?\s*\{\s*taskType:\s*rec\.taskType\s*\}/,
    "③ 命令段：toDispatchCommand 仅非缺省带顶层键（照 readOnly 形制）",
  );
});

// ---------------------------------------------------------------------------
// ③ 静态锚：注入落点 + 三处构造点 + 出参声明非可选 + 回传面不带 taskType
// ---------------------------------------------------------------------------

test("v0.10.2 O3 构造点静态锚：注入闸门在 blocks 头部 · 三面构造各带 taskType · 结果回传面不带", () => {
  const bridgeIndex = orchSource("bridge/index.ts");
  const gate = 'if (node.taskType !== "unit_agent") blocks.push(`职责位 taskType=${node.taskType}`);';
  assert.ok(bridgeIndex.includes(gate), "注入闸门 = 仅非缺省（缺省档不注入 ⇒ 缺省外壳逐字不变）");

  const fnStart = bridgeIndex.indexOf("function buildNodeDispatchMessage");
  assert.ok(fnStart >= 0, "buildNodeDispatchMessage 在场");
  const fnBody = bridgeIndex.slice(fnStart, bridgeIndex.indexOf("\n}\n", fnStart));
  assert.ok(
    fnBody.indexOf("blocks.push(`职责位") < fnBody.indexOf("if (feature !== null)"),
    "注入行落在 Feature Context 之前（外壳头部）",
  );
  assert.ok(!/dispatchMessage\s*[:=]/.test(fnBody), "渲染函数不写 base（渲染分离纪律）");

  const featTools = orchSource("bridge/feature-tools.ts");
  // 构造点上 lane 与 taskType 成对相邻（中间只允许注释行）——「三处构造各带」的静态锁
  const pair = (a: string, b: string): RegExp =>
    new RegExp(`${a},\\s*(?://[^\\n]*\\n\\s*)*${b},`);
  assert.match(featTools, pair("lane: rec\\.lane", "taskType: rec\\.taskType"), "① summarizeTask 带 taskType");
  assert.match(featTools, pair("lane: n\\.lane", "taskType: n\\.taskType"), "② trace 节点构造带 taskType");
  assert.match(bridgeIndex, pair("lane: record\\.lane", "taskType: record\\.taskType"), "③ a2a_tasks 带 lane + taskType");

  // **不得省略字段** = 出参类型上是**非可选**声明（三处声明面 + a2a_tasks 的 lane）
  assert.equal(countOccurrences(featTools, "taskType: TaskType;"), 2, "两个 Feature 面出参声明非可选");
  const typesSrc = orchSource("types.ts");
  const itemFace = typesSrc.slice(typesSrc.indexOf("export interface TaskListItem"));
  assert.ok(/taskType:\s*TaskType;/.test(itemFace), "TaskListItem 声明 taskType 非可选");
  assert.ok(/lane:\s*TaskLane;/.test(itemFace), "TaskListItem 补齐 lane 非可选（v0.10.2 O-3）");

  // F-C7「不做」面：结果回传受理段（`/runner/result`）不得消费 taskType
  const runner = orchSource("bridge/runner.ts");
  const resultStart = runner.indexOf("// /runner/result");
  const resultEnd = runner.indexOf("// 内部：claim / 控制命令 / 唤醒", resultStart);
  assert.ok(resultStart >= 0 && resultEnd > resultStart, "runner.ts 的 /runner/result 受理段可定位");
  assert.ok(
    !runner.slice(resultStart, resultEnd).includes("taskType"),
    "结果回传面不带 taskType（只增派发侧）",
  );
});

// ---------------------------------------------------------------------------
// ④ 行为锚：缺省节点渲染快照逐字不变（判据 ①）
// ---------------------------------------------------------------------------

test("v0.10.2 O3 行为锚①：缺省节点派发消息外壳逐字不变、无 taskType= 行", async () => {
  const BASE = "任务正文O3缺省";
  const fid = newFeature("O3 缺省不注入", "方案D");
  const taskId = registerNode(BASE, fid);

  okOrThrow(core.featureApprove({ featureId: fid }), "approve");
  core.kickScheduler();
  await waitFor(() => dispatchRoundDone(taskId, "方案D"), "缺省节点首派");
  await quiesce();

  const rendered = getTask(taskId)?.dispatchRendered ?? "";
  assert.equal(
    rendered,
    `<feature-context>\n## 统一方案（plan）\n方案D\n</feature-context>\n\n---\n\n${BASE}`,
    "缺省档快照 = v0.8.9 渲染分离形态（逐字相同，无注入行）",
  );
  assert.ok(!rendered.includes("taskType="), "缺省档不得注入 taskType= 行");
  assert.equal(getTask(taskId)?.dispatchMessage, BASE, "base 逐字不变（渲染不回写）");

  report(taskId, fid, "completed", "o3-default-settle");
  await quiesce();
});

// ---------------------------------------------------------------------------
// ⑤ 行为锚：非缺省注入一行 + 重派不叠加（判据 ②）
// ---------------------------------------------------------------------------

test("v0.10.2 O3 行为锚②：非缺省注入 taskType= 行，两轮派发后恰 1 次、base 不变", async () => {
  const nonDefaults = nonDefaultTaskTypes();
  assert.deepEqual(
    nonDefaults,
    anchorTaskTypes().filter((v) => v !== DEFAULT_TASK_TYPE),
    "遍历集合与锚点同源（非本文件抄写）",
  );

  const BASE = "任务正文O3职责位";
  const fid = newFeature("O3 非缺省注入", "方案X1");
  const taskId = registerNode(BASE, fid, "dev_manager");

  okOrThrow(core.featureApprove({ featureId: fid }), "approve");
  core.kickScheduler();
  await waitFor(() => dispatchRoundDone(taskId, "方案X1"), "轮 1 首派");
  await quiesce();

  const shell = (plan: string): string =>
    `<feature-context>\n## 统一方案（plan）\n${plan}\n</feature-context>\n\n---\n\n${BASE}`;
  const round1 = getTask(taskId)?.dispatchRendered ?? "";
  assert.equal(round1, `职责位 taskType=dev_manager\n\n${shell("方案X1")}`, "轮 1 快照精确全文");
  assert.match(round1, /^职责位 taskType=dev_manager$/m, "注入行独立成行");
  assert.equal(getTask(taskId)?.dispatchMessage, BASE, "轮 1 后 base 逐字不变");

  // —— 轮 2：failed → retryTaskIds 重派（渲染重算，不叠加）——
  report(taskId, fid, "failed", "o3-retry");
  await waitFor(() => getTask(taskId)?.state === "failed", "轮 2 前置：节点 failed");
  okOrThrow(
    core.featureAdvance({ featureId: fid, to: "executing", retryTaskIds: [taskId], note: "方案X2" }),
    "retryTaskIds 重派",
  );
  core.kickScheduler();
  await waitFor(() => dispatchRoundDone(taskId, "方案X2"), "轮 2 重派落库");
  await quiesce();

  const round2 = getTask(taskId)?.dispatchRendered ?? "";
  assert.equal(countOccurrences(round2, "taskType="), 1, "两轮派发后注入行恰 1 次（不叠加）");
  assert.equal(countOccurrences(round2, "<feature-context>"), 1, "Feature Context 壳恰 1 次");
  assert.equal(round2, `职责位 taskType=dev_manager\n\n${shell("方案X2")}`, "轮 2 快照精确全文");
  assert.equal(getTask(taskId)?.dispatchMessage, BASE, "轮 2 后 base 仍逐字不变");

  // —— 其余非缺省值：落库原样（注入行由 ③ 的闸门静态锚覆盖，值无关）——
  for (const taskType of nonDefaults) {
    const probeFid = newFeature(`O3 遍历 ${taskType}`, null);
    const probeId = registerNode(`正文-${taskType}`, probeFid, taskType);
    assert.equal(getTask(probeId)?.taskType, taskType, `${taskType} 应原样落库`);
    assert.equal(getFeature(probeFid)?.state, "waiting_approval", "遍历节点不派发（Feature 未过门）");
  }

  report(taskId, fid, "completed", "o3-final");
  await quiesce();
  assert.equal(outboundCount, 0, "全程零出站");
});

// ---------------------------------------------------------------------------
// ⑥ 行为锚：三读出参同带 taskType（判据 ③）
// ---------------------------------------------------------------------------

test("v0.10.2 O3 读面锚③：feature_status / feature_trace / a2a_tasks 三面带 taskType 且取值一致（tasks 并补 lane）", async () => {
  const fid = newFeature("O3 三读出参", null);
  const undeclared = registerNode("正文-未声明", fid);
  const readOnlyNode = registerNode("正文-只读档", fid, "project_manager", true);
  const declared = new Map<TaskType, string>();
  for (const taskType of nonDefaultTaskTypes()) declared.set(taskType, registerNode(`正文-${taskType}`, fid, taskType));

  const want = new Map<string, TaskType>([
    [undeclared, DEFAULT_TASK_TYPE],
    [readOnlyNode, "project_manager"],
    ...Array.from(declared.entries()).map(([t, id]) => [id, t] as const),
  ]);

  const tasksView = okOrThrow(await core.tasks("alpha"), "tasks");
  const listRows = new Map<string, TaskListItem>(tasksView.tasks.map((t) => [t.taskId, t]));

  for (const [taskId, taskType] of want) {
    assert.ok(listRows.has(taskId), `a2a_tasks 应含节点 ${taskId}`);
    const faces: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["a2a_feature_status", statusRow(taskId)],
      ["a2a_feature_trace", traceRow(taskId)],
      ["a2a_tasks", listRows.get(taskId) as unknown as Record<string, unknown>],
    ];
    for (const [face, row] of faces) {
      // **不得省略字段**：own property 存在 + 值确定（NULL 已归一）
      assert.ok(Object.hasOwn(row, "taskType"), `${face} 出参必须带 taskType 字段（不得省略）`);
      assert.equal(row["taskType"], taskType, `${face} 的 taskType 应为 ${taskType}`);
      assert.ok(Object.hasOwn(row, "lane"), `${face} 出参必须带 lane 字段`);
    }
    // **字段集一致**：同一节点三面的 taskType / lane 互等
    assert.equal(
      new Set(faces.map(([, row]) => row["taskType"])).size,
      1,
      `节点 ${taskId} 三面 taskType 必须一致`,
    );
    assert.equal(new Set(faces.map(([, row]) => row["lane"])).size, 1, `节点 ${taskId} 三面 lane 必须一致`);
  }

  assert.equal(listRows.get(undeclared)?.taskType, DEFAULT_TASK_TYPE, "未声明行读回归一缺省档");
  assert.equal(listRows.get(readOnlyNode)?.lane, "read", "a2a_tasks 补齐的 lane 与登记档一致");
});
