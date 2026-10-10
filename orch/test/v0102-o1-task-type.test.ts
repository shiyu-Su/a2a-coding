/**
 * v0.10.2 **O-1**（REQ-2026-10-09-01 · 改造文档 §2.3 F-C1 / §3.1 orch 段 / §3.2 闭集原文）——
 * 职责位「**值域与落库**」。
 *
 * 锁定的行为面（对应节点三条验收判据）：
 * 1. **① 常量 == 锚点**：`orch/types.ts` 的 `TASK_TYPES` 与仓根 `PROTOCOL.md` 的 `task-types`
 *    机器可解析锚点逐项一致（**anchor 形制**：从锚点正则捕获后比对，禁硬编码期望副本）；
 *    锚点在仓内**全文唯一**；`dispatch` 字段行带 `taskType`（标可选 / 缺省 `unit_agent`）；
 *    **`PROTOCOL_VERSION` 保持 `2.3`**（可选 ∧ 缺省 = 引入前的唯一行为 ∧ 不下发即现状 ⇒ 不升版）；
 * 2. **② 存量行读回 `unit_agent`**：迁移**不回填** `task_type`（NULL = 「未声明」是正确语义），
 *    归一只发生在读侧 `readTaskType`；闭集外的非 NULL 值 = 数据损坏 fail-fast（**不兜底归一**）；
 * 3. **③ 列只在迁移段**：`task_type` **不进 `TASKS_DDL`**、由 ctor try-ALTER 补上（必可空、无列缺省值），
 *    重复打开**幂等**（列面一致、不改存量值）；
 * 4. **④ 写侧 `COALESCE(excluded.task_type, task_type)`**：未带职责位的重登记**不改档**
 *    （照 v0.8.10 `lane` 先例）；显式传值才可改档；缺省落库是 NULL 而非字面 `unit_agent`。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, TASK_TYPES } from "../types.js";
import { openStoreDatabase, SessionStore } from "../session/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 仓根 `PROTOCOL.md`（`dist/test` → 上溯三级 = 仓根，同 `v0100-o8-protocol-criteria.test.ts`） */
function protocolText(): string {
  return readFileSync(resolve(HERE, "..", "..", "..", "PROTOCOL.md"), "utf8");
}

/** orch 单元 `session/store.ts` 源码（静态锚：列面纪律只写在源码里） */
function storeSource(): string {
  return readFileSync(resolve(HERE, "..", "..", "session", "store.ts"), "utf8");
}

/** 从 `PROTOCOL.md` 捕获 `task-types` 锚点的取值清单；无锚点 ⇒ null */
function anchorValues(text: string): string[] | null {
  const m = /<!--\s*task-types:\s*([A-Za-z0-9_,\s]+?)\s*-->/.exec(text);
  if (m === null || m[1] === undefined) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function lineWith(text: string, needle: string): string {
  const line = text.split(/\r?\n/).find((l) => l.includes(needle));
  assert.ok(line !== undefined, `PROTOCOL.md 应含「${needle}」所在行`);
  return line ?? "";
}

/** 独立临时库文件（返回其目录与路径，用例结束删目录） */
function tempDb(tag: string): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `a2a-v0102-o1-${tag}-`));
  return { dir, dbPath: join(dir, "sessions.sqlite") };
}

/** 不经 SessionStore（不跑迁移）的裸连接：用于造「旧库」与直读列原值 */
function rawColumn(dbPath: string, sql: string, param: string): Record<string, unknown> | undefined {
  const raw = openStoreDatabase(dbPath);
  try {
    return raw.prepare(sql).get(param) as Record<string, unknown> | undefined;
  } finally {
    raw.close();
  }
}

function taskColumnNames(dbPath: string): string[] {
  const raw = openStoreDatabase(dbPath);
  try {
    return (raw.prepare("PRAGMA table_info(tasks)").all() as Array<Record<string, unknown>>).map(
      (c) => String(c["name"]),
    );
  } finally {
    raw.close();
  }
}

// ---------------------------------------------------------------------------
// ① 值域：常量与 PROTOCOL.md 锚点一致
// ---------------------------------------------------------------------------

test("① TASK_TYPES 逐项等于 PROTOCOL.md task-types 锚点（anchor 形制，不硬编码副本）", () => {
  const values = anchorValues(protocolText());
  assert.notEqual(values, null, "PROTOCOL.md 应存在机器可解析 task-types 锚点");
  assert.deepEqual([...TASK_TYPES], values, "orch 常量必须与锚点逐项一致（含顺序）");
});

test("① 锚点在 PROTOCOL.md 全文唯一（值无关形态）", () => {
  const hits = protocolText().match(/<!--\s*task-types:[^>]*-->/g) ?? [];
  assert.equal(hits.length, 1, `task-types 锚点须恰好一枚，实得 ${hits.length}`);
});

test("① dispatch 两处字段行带 taskType：载荷标可选 + 说明行标缺省 unit_agent", () => {
  const text = protocolText();
  assert.match(
    lineWith(text, '| `"dispatch"` |'),
    /inputs, taskType\? \}/,
    "载荷清单须以 `taskType?` 标记可选",
  );
  const prose = lineWith(text, "`dispatch` 字段：");
  assert.match(prose, /`taskType`（可选，v0\.10\.2 引入）/, "字段说明须标可选");
  assert.match(prose, /缺省 `unit_agent`/, "字段说明须写缺省档");
});

test("① PROTOCOL_VERSION 保持 2.3（taskType 可忽略 ∧ 缺省即现状 ⇒ 不升版，判据成文）", () => {
  assert.equal(PROTOCOL_VERSION, "2.3", "taskType 不得触发协议版本 bump");
  assert.match(
    protocolText(),
    /为何 `PROTOCOL_VERSION` 保持 `2\.3` 不升/,
    "不升版判据须在 PROTOCOL.md 成文",
  );
});

// ---------------------------------------------------------------------------
// ② 落库读侧：NULL 归一 unit_agent（存量行）+ 非法值 fail-fast
// ---------------------------------------------------------------------------

test("② 存量行（旧库无该列）迁移后读回 unit_agent", () => {
  const { dir, dbPath } = tempDb("legacy");
  try {
    // 造 v0.10.2 之前的旧库：裸连接按当年主 DDL 建表并插一行（不带 lane、不带 task_type）
    const raw = openStoreDatabase(dbPath);
    raw.exec(
      `CREATE TABLE IF NOT EXISTS tasks (
         task_id        TEXT PRIMARY KEY,
         project_id     TEXT NOT NULL,
         context_id     TEXT NOT NULL,
         state          TEXT NOT NULL,
         artifacts_json TEXT,
         text           TEXT,
         prompt         TEXT,
         updated_at     TEXT NOT NULL,
         created_at     TEXT,
         started_at     TEXT,
         finished_at    TEXT)`,
    );
    raw.prepare(
      `INSERT INTO tasks (task_id, project_id, context_id, state, updated_at)
       VALUES ('legacy-1', 'p1', 'c1', 'completed', '2026-10-01T00:00:00.000Z')`,
    ).run();
    raw.close();
    assert.ok(!taskColumnNames(dbPath).includes("task_type"), "旧库本不该有 task_type 列");

    const store = new SessionStore(dbPath);
    try {
      const rec = store.getTask("legacy-1");
      assert.notEqual(rec, null, "存量行须在迁移后可读");
      assert.equal(rec?.taskType, "unit_agent", "存量行读侧归一为缺省职责位");
      assert.equal(rec?.lane, "write", "同段 lane 归一不受本节点影响");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("② 缺省不传 ⇒ 落库 NULL（读侧归一），不写字面 unit_agent", () => {
  const { dir, dbPath } = tempDb("default-null");
  try {
    const store = new SessionStore(dbPath);
    const created = store.createTask({
      taskId: "t-default",
      projectId: "p1",
      contextId: "c1",
      state: "working",
    });
    assert.equal(created.taskType, "unit_agent", "出参恒为闭集内取值（读侧归一）");
    store.close();
    const row = rawColumn(dbPath, "SELECT task_type FROM tasks WHERE task_id = ?", "t-default");
    assert.equal(row?.["task_type"], null, "缺省必须落 NULL（回填会把「未声明」压平成显式声明）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("② 闭集外的非 NULL 值 ⇒ 读侧 fail-fast（不兜底归一）", () => {
  const { dir, dbPath } = tempDb("corrupt");
  try {
    const store = new SessionStore(dbPath);
    store.createTask({ taskId: "t-bad", projectId: "p1", contextId: "c1", state: "working" });
    store.close();
    const raw = openStoreDatabase(dbPath);
    raw.prepare("UPDATE tasks SET task_type = 'ceo' WHERE task_id = ?").run("t-bad");
    raw.close();

    const reopened = new SessionStore(dbPath);
    try {
      assert.throws(
        () => reopened.getTask("t-bad"),
        /列 task_type 数据损坏：非法值 ceo/,
        "脏值须按数据损坏抛出，不得静默归一",
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ③ 列面：只在迁移段 ALTER，不进 TASKS_DDL；重复打开幂等
// ---------------------------------------------------------------------------

test("③ 主建表语句不含 task_type；列只由迁移段 try-ALTER 补、且无回填语句", () => {
  const src = storeSource();
  const m = /const TASKS_DDL = `([\s\S]*?)`;/.exec(src);
  assert.notEqual(m, null, "应能定位 TASKS_DDL 模板字面量");
  const ddl = (m as RegExpExecArray)[1] as string;
  assert.ok(!ddl.includes("task_type"), "TASKS_DDL 不得声明 task_type 列");
  assert.match(src, /ALTER TABLE tasks ADD COLUMN task_type TEXT/, "迁移段须 try-ALTER 补列");
  assert.ok(
    !/UPDATE tasks SET task_type/.test(src),
    "迁移段不得回填 task_type（NULL = 未声明是正确语义，归一只在读侧）",
  );
});

test("③ 迁移后的列：可空、无列缺省值", () => {
  const { dir, dbPath } = tempDb("column-shape");
  try {
    const store = new SessionStore(dbPath);
    store.close();
    const raw = openStoreDatabase(dbPath);
    let shape: Record<string, unknown> | undefined;
    try {
      shape = (raw.prepare("PRAGMA table_info(tasks)").all() as Array<Record<string, unknown>>).find(
        (c) => String(c["name"]) === "task_type",
      );
    } finally {
      raw.close();
    }
    assert.notEqual(shape, undefined, "task_type 列应已由迁移段补上");
    assert.equal(shape?.["notnull"], 0, "task_type 必可空（照既有加列纪律）");
    assert.equal(shape?.["dflt_value"], null, "task_type 不得有列缺省值");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("③ 重复打开 = 前向迁移幂等（列面一致、不改已有职责位）", () => {
  const { dir, dbPath } = tempDb("idem");
  try {
    const first = new SessionStore(dbPath);
    first.createTask({
      taskId: "t-idem",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      taskType: "project_manager",
    });
    first.close();

    const cols1 = taskColumnNames(dbPath);
    new SessionStore(dbPath).close();
    assert.deepEqual(taskColumnNames(dbPath), cols1, "二次打开不得改变列面");
    assert.equal(
      rawColumn(dbPath, "SELECT task_type FROM tasks WHERE task_id = ?", "t-idem")?.["task_type"],
      "project_manager",
      "二次打开不得改写已有职责位",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ④ 写侧 COALESCE：未带职责位的重登记不改档
// ---------------------------------------------------------------------------

test("④ 重登记不带 taskType ⇒ 保留首次声明（COALESCE(excluded.task_type, task_type)）", () => {
  const { dir, dbPath } = tempDb("coalesce-keep");
  try {
    const store = new SessionStore(dbPath);
    store.createTask({
      taskId: "t-keep",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      taskType: "dev_manager",
    });
    // 同 taskId 再登记（重派 / 补登记走同一条 upsert）不带职责位 ⇒ 不得降成 unit_agent
    store.createTask({
      taskId: "t-keep",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      taskType: undefined,
    });
    assert.equal(
      store.getTask("t-keep")?.taskType,
      "dev_manager",
      "缺省 NULL 不得覆盖首次声明（照 lane 先例）",
    );
    store.close();
    assert.equal(
      rawColumn(dbPath, "SELECT task_type FROM tasks WHERE task_id = ?", "t-keep")?.["task_type"],
      "dev_manager",
      "落库原值同样须保留首次声明",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("④ 显式传值可改档（COALESCE 只挡 NULL，不挡显式声明）", () => {
  const store = new SessionStore(":memory:");
  try {
    store.createTask({
      taskId: "t-change",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      taskType: "product_manager",
    });
    store.createTask({
      taskId: "t-change",
      projectId: "p1",
      contextId: "c1",
      state: "working",
      taskType: "dev_manager",
    });
    assert.equal(store.getTask("t-change")?.taskType, "dev_manager");
  } finally {
    store.close();
  }
});

test("④ 结果回传口为未知任务建行 ⇒ 不触碰 task_type ⇒ 读回 unit_agent（照 lane 先例不扩列）", () => {
  const { dir, dbPath } = tempDb("result-plane");
  try {
    const store = new SessionStore(dbPath);
    const stored = store.upsertTaskResult({
      machineId: "m1",
      taskId: "t-unknown",
      projectId: "p1",
      contextId: "c1",
      state: "completed",
    });
    assert.equal(stored.taskType, "unit_agent", "结算侧未知任务建行按缺省职责位读回");
    store.close();
    assert.equal(
      rawColumn(dbPath, "SELECT task_type FROM tasks WHERE task_id = ?", "t-unknown")?.["task_type"],
      null,
      "该写口不得触碰 task_type",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
