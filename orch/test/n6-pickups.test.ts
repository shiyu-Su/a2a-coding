/**
 * N6（REQ-v0.6.1-2026-09-17-05 §2.5 白捡四项）行为锁定。
 *
 * 覆盖（对应改造文档 §4.1 判据 V10 + 本期白捡表）：
 * - **C11 派发崩溃窗口**（3 组真值 + 重派出口）：按「崩溃点 × 恢复动作」真值表逐行断言 ——
 *   - **C0 派发前**（无占位、无远端）⇒ `recover` 不误判，节点保持待派发、**可安全重派**（必未发出）；
 *   - **C1 占位已写、send 未回填**（有占位、无远端）⇒ 保守判「可能已发出」：`recover` 按
 *     `FEATURE_DISPATCH_WINDOW_TEXT` 收敛为 `failed`（**不自动重派**，防双派），交静止收敛；
 *   - **C2 回填后**（有占位、有远端）⇒ 既有 `FEATURE_INTERRUPTED_TEXT` 路径不变；
 *   - **rearm 出口**：`rearmForRetry` 清占位 ⇒ 重派可再就绪（**不永久不派**）。
 * - **A5-5 反查**：`resolveTaskLookup` 先按本地 id（远端调用用 `remoteTaskId`），MISS 时经
 *   远端 id 映射反查；均不命中 ⇒ `null`。
 * - **C12 截断告警**：`listFeatureTasks` / `listFeatures` 触顶（`=== limit`）⇒ 事件 + 日志各一条
 *   （去重）；`listBusyProjectIds` **不得带 limit 模式**。
 * - **A5-2**：`persist` / `poll` 异常分离已在 N3 落地（见 `task-watcher.ts`），本节点**核验为空项**。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 * 隔离：默认库固定 `:memory:`，每用例先 `close()` 重置为空库。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  close,
  createFeature,
  createTask,
  EVENT_LIST_TRUNCATED,
  getFeature,
  getTask,
  listBusyProjectIds,
  listEvents,
  listFeatureTasks,
  listFeatures,
  markTaskDispatched,
  markTaskDispatchStarted,
  openStoreDatabase,
  rearmForRetry,
  SessionStore,
  updateTaskState,
} from "../session/store.js";
import {
  FEATURE_DISPATCH_WINDOW_TEXT,
  FEATURE_INTERRUPTED_TEXT,
  FeatureScheduler,
} from "../bridge/scheduler.js";
import { registerRemoteTask, resolveTaskLookup } from "../bridge/task-lookup.js";

/** 推进足够多轮次，覆盖 `advanceExecuting` 内的多个 `await` */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// C11：崩溃点 × 恢复动作 真值表
// ---------------------------------------------------------------------------

test("N6 · C11-C0（派发前崩溃）：无占位无远端 ⇒ 不误判，可安全重派", async () => {
  close();
  createFeature({ featureId: "f-c0", title: "C0", state: "executing" });
  createTask({
    taskId: "n-c0",
    projectId: "p1",
    contextId: "c-c0",
    state: "working",
    featureId: "f-c0",
  });

  let dispatched = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async () => {
      dispatched += 1;
      return { ok: true };
    },
  });

  const summary = scheduler.recover();
  assert.equal(summary.interruptedTasks, 0, "无占位 ⇒ 不按 interrupted 收敛");
  assert.equal(getTask("n-c0")?.state, "working", "节点保持待派发");
  assert.equal(getTask("n-c0")?.dispatchGuard, null, "无占位");

  scheduler.kick();
  await flush();
  assert.equal(dispatched, 1, "崩溃点在占位之前 ⇒ 必未发出 ⇒ 重启可安全重派（不双派）");
});

test("N6 · C11-C1（占位已写、send 未回填）：保守判已发出 ⇒ 不重派 + 交静止账单", async () => {
  close();
  createFeature({ featureId: "f-c1", title: "C1", state: "executing" });
  createTask({
    taskId: "n-c1",
    projectId: "p1",
    contextId: "c-c1",
    state: "working",
    featureId: "f-c1",
  });
  // 崩溃点：send **之前**占位已写；send 返回后的回填未发生
  markTaskDispatchStarted("n-c1");

  let dispatched = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async () => {
      dispatched += 1;
      return { ok: true };
    },
  });

  const summary = scheduler.recover();
  assert.equal(summary.interruptedTasks, 1, "派发窗口节点按 interrupted 收敛");
  assert.equal(getTask("n-c1")?.state, "failed", "置 failed（交静止收敛）");
  assert.equal(
    getTask("n-c1")?.text,
    FEATURE_DISPATCH_WINDOW_TEXT,
    "用「派发窗口」专用文案（可区分 C1 与 C2）",
  );
  assert.notEqual(getTask("n-c1")?.dispatchGuard, null, "占位保留（「已发出」是既成事实）");

  scheduler.kick();
  await flush();
  assert.equal(dispatched, 0, "占位 ⇒ 不重派（防同节点双派）");
  const reports = listEvents({ since: 0 }).filter(
    (e) => e.kind === "feature.failure_report",
  );
  assert.equal(reports.length, 1, "交静止收敛：恰好一条 failure_report");
  assert.equal(getFeature("f-c1")?.state, "executing", "业务失败不判死整单");
});

test("N6 · C11-C2（回填后崩溃）：既有 interrupted 恢复路径不变", async () => {
  close();
  createFeature({ featureId: "f-c2", title: "C2", state: "executing" });
  createTask({
    taskId: "n-c2",
    projectId: "p1",
    contextId: "c-c2",
    state: "working",
    featureId: "f-c2",
  });
  markTaskDispatchStarted("n-c2");
  markTaskDispatched("n-c2", "remote-c2"); // 回填已发生

  let dispatched = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async () => {
      dispatched += 1;
      return { ok: true };
    },
  });

  const summary = scheduler.recover();
  assert.equal(summary.interruptedTasks, 1);
  assert.equal(
    getTask("n-c2")?.text,
    FEATURE_INTERRUPTED_TEXT,
    "有远端 id ⇒ 走既有 interrupted 文案（不误用窗口文案）",
  );
  assert.equal(getTask("n-c2")?.remoteTaskId, "remote-c2", "远端 id 保留（供核实）");

  scheduler.kick();
  await flush();
  assert.equal(dispatched, 0, "远端 id 已知 ⇒ 不重派");
});

test("N6 · C11-rearm：派发窗口 failed 经 rearmForRetry 清占位 ⇒ 可重派（不永久不派）", async () => {
  close();
  createFeature({ featureId: "f-rearm", title: "rearm", state: "executing" });
  createTask({
    taskId: "n-rearm",
    projectId: "p1",
    contextId: "c-rearm",
    state: "working",
    featureId: "f-rearm",
  });
  markTaskDispatchStarted("n-rearm");
  updateTaskState("n-rearm", "failed", null, FEATURE_DISPATCH_WINDOW_TEXT);

  assert.equal(rearmForRetry("n-rearm", "请重派（同 contextId 续接）"), true);
  assert.equal(getTask("n-rearm")?.dispatchGuard, null, "重派清占位（旧占位作废）");
  assert.equal(getTask("n-rearm")?.remoteTaskId, null, "远端 id 亦清");

  let dispatched = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async () => {
      dispatched += 1;
      return { ok: true };
    },
  });
  scheduler.kick();
  await flush();
  assert.equal(dispatched, 1, "占位已清 ⇒ 重新就绪（不「永久不派」）");
});

// ---------------------------------------------------------------------------
// A5-5：本地 id ↔ 远端 id 反查
// ---------------------------------------------------------------------------

test("N6 · A5-5 反查：本地命中用 remoteTaskId；MISS 时经远端映射；均不命中 ⇒ null", () => {
  close();
  // Feature 节点：本地 id ≠ 远端 id
  createTask({
    taskId: "local-1",
    projectId: "p1",
    contextId: "c-1",
    state: "working",
    featureId: "f-1",
  });
  markTaskDispatched("local-1", "remote-1");

  const hit = resolveTaskLookup("local-1");
  assert.equal(hit?.record.taskId, "local-1", "本地 id 命中");
  assert.equal(hit?.remoteId, "remote-1", "远端调用必须用 remoteTaskId（旧实现用入参 ⇒ 404）");

  // 独立单任务：本地 id 即远端 id（无 remoteTaskId）
  createTask({ taskId: "solo-1", projectId: "p1", contextId: "c-1", state: "working" });
  assert.equal(resolveTaskLookup("solo-1")?.remoteId, "solo-1", "独立任务二者相同");

  // 本地 MISS ⇒ 经远端 id 映射反查（模拟回调 / 事件只带远端 id）
  registerRemoteTask("remote-2", "local-2");
  createTask({
    taskId: "local-2",
    projectId: "p1",
    contextId: "c-2",
    state: "working",
    featureId: "f-1",
  });
  const reversed = resolveTaskLookup("remote-2");
  assert.equal(reversed?.record.taskId, "local-2", "远端 id 反查到本地记录");
  assert.equal(reversed?.remoteId, "remote-2", "反查命中 ⇒ 入参本身即远端 id");

  // 均不命中
  assert.equal(resolveTaskLookup("nope"), null);
});

// ---------------------------------------------------------------------------
// C12：触顶截断告警（事件 + 日志各一条）+ listBusyProjectIds 无 limit 模式
// ---------------------------------------------------------------------------

test("N6 · C12：listFeatureTasks / listFeatures 触顶 ⇒ 事件一条（去重）；busy 查询无 limit 参数", () => {
  close();
  createFeature({ featureId: "f-many", title: "many", state: "executing" });
  createFeature({ featureId: "f-b", title: "b", state: "executing" });
  createFeature({ featureId: "f-c", title: "c", state: "executing" });
  createFeature({ featureId: "f-d", title: "d", state: "executing" });
  for (let i = 0; i < 5; i += 1) {
    createTask({
      taskId: `t-${String(i)}`,
      projectId: "p1",
      contextId: "c",
      state: "working",
      featureId: "f-many",
    });
  }

  const truncated = (): ReturnType<typeof listEvents> =>
    listEvents({ since: 0, limit: 100 }).filter((e) => e.kind === EVENT_LIST_TRUNCATED);

  // 1) listFeatureTasks 触顶：limit=3 < 5
  const page = listFeatureTasks("f-many", { limit: 3 });
  assert.equal(page.length, 3, "如实返回 limit 条（不改查询语义）");
  let events = truncated();
  assert.equal(events.length, 1, "触顶 ⇒ 恰好一条告警");
  const first = JSON.parse(events[0]?.payload ?? "{}") as {
    list: string;
    limit: number;
    returned: number;
    total: number;
  };
  assert.equal(first.list, "listFeatureTasks");
  assert.equal(first.limit, 3);
  assert.equal(first.returned, 3);
  assert.equal(first.total, 5, "total 校验：真实总数（区分「恰好等 limit」与「真被截断」）");
  assert.equal(events[0]?.featureId, "f-many", "告警归属被查 Feature");

  // 2) 同 key 重复 ⇒ 去重（不再刷屏事件收件箱）
  listFeatureTasks("f-many", { limit: 3 });
  listFeatureTasks("f-many", { limit: 3 });
  assert.equal(truncated().length, 1, "同 key（list+scope+limit）只告警一次");

  // 3) 换 limit ⇒ 新 key ⇒ 重新告警（不同截断面 = 不同事实）
  listFeatureTasks("f-many", { limit: 2 });
  assert.equal(truncated().length, 2, "limit 变 ⇒ 新告警");

  // 4) listFeatures 触顶：4 个 Feature，limit=2
  const features = listFeatures({ limit: 2 });
  assert.equal(features.length, 2);
  events = truncated();
  assert.equal(events.length, 3, "listFeatures 触顶亦告警（另一 list 名）");
  const last = JSON.parse(events[2]?.payload ?? "{}") as { list: string; total: number };
  assert.equal(last.list, "listFeatures");
  assert.equal(last.total, 4);

  // 5) 未触顶 ⇒ 零告警（不误报）
  listFeatureTasks("f-many", { limit: 10 });
  assert.equal(truncated().length, 3, "未触顶不告警");

  // 6) listBusyProjectIds：**不得带 limit 模式**（N5 已隐含，此处置机械断言）
  assert.equal(listBusyProjectIds.length, 0, "listBusyProjectIds 不得带 limit 参数");
});

// ---------------------------------------------------------------------------
// C11：单列迁移（ctor 内一次 try-ALTER）+ 幂等
// ---------------------------------------------------------------------------

test("N6 · C11 迁移：旧库（无 dispatch_guard）首次打开补列、再开幂等、新列可读写", () => {
  const dbPath = join(tmpdir(), `a2a-c11-guard-${String(process.pid)}-${String(Date.now())}.sqlite`);
  try {
    // ① 造「旧库」：tasks 表**无 dispatch_guard**（及后续列）+ 一条老行
    const legacy = openStoreDatabase(dbPath);
    legacy.exec(
      "CREATE TABLE tasks (task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, " +
        "context_id TEXT NOT NULL, state TEXT NOT NULL, artifacts_json TEXT, updated_at TEXT NOT NULL)",
    );
    legacy.exec(
      "INSERT INTO tasks (task_id, project_id, context_id, state, updated_at) " +
        "VALUES ('legacy-g', 'p1', 'c1', 'working', '2026-09-15T00:00:00.000Z')",
    );
    legacy.close();

    // ② 首次打开 = 迁移（try-ALTER 补列）；再开一次 = 迁移重复执行（幂等，不应抛）
    new SessionStore(dbPath).close();
    const store = new SessionStore(dbPath);
    try {
      const row = store.getTask("legacy-g");
      assert.equal(row?.dispatchGuard, null, "老数据占位留 NULL（不回填）");
      assert.equal(row?.state, "working", "补列不得改写既有列");

      // ③ 新列可写回并读回（TASK_COLUMNS / rowToTask 已覆盖）
      store.markTaskDispatchStarted("legacy-g");
      const guarded = store.getTask("legacy-g");
      assert.notEqual(guarded?.dispatchGuard, null, "占位可写可读");
      assert.notEqual(guarded?.startedAt, null, "占位同批补首次开工时刻");

      // ④ 幂等：重复占位不刷新时刻（COALESCE）
      store.markTaskDispatchStarted("legacy-g");
      assert.equal(
        store.getTask("legacy-g")?.dispatchGuard,
        guarded?.dispatchGuard,
        "重复占位不刷新（幂等）",
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
});
