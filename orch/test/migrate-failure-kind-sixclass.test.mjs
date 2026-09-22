#!/usr/bin/env node
/**
 * migrate-failure-kind-sixclass.test.mjs —— `scripts/migrate-failure-kind-sixclass.mjs`
 * 契约用例（v0.8.8 O8）。**只跑临时库**，生产库不碰。
 *
 * 覆盖：
 *   1) dry-run：退 0、报告命中行数、**跑前跑后库内容逐字节等价**（未改任何行）；
 *   2) --apply：二分旧值 `infra` / `task` ⇒ NULL；六类合法值与其它列**未被误改**；
 *   3) 可重入：再跑一次 `--apply` ⇒ `changes=0`、计数不变；
 *   4) fail-fast：无 `failure_kind` 列的老库 ⇒ 退 1 并提示先起桥补列。
 *
 * 运行：node --test test/migrate-failure-kind-sixclass.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "scripts", "migrate-failure-kind-sixclass.mjs");

function runScript(dbPath, extraArgs = []) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SCRIPT, ...extraArgs], {
      env: { ...process.env, SESSION_DB: dbPath },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** 建一个带 tasks 表的最小库，按 rows 播种；返回库路径 */
function seed(rows, { withFailureKind = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "o8-mig-"));
  const dbPath = join(dir, "sessions.sqlite");
  const db = new DatabaseSync(dbPath);
  const failureColumn = withFailureKind ? ", failure_kind TEXT" : "";
  db.exec(`CREATE TABLE tasks (task_id TEXT PRIMARY KEY, state TEXT NOT NULL, note TEXT${failureColumn})`);
  const insert = withFailureKind
    ? db.prepare("INSERT INTO tasks (task_id, state, note, failure_kind) VALUES (?, ?, ?, ?)")
    : db.prepare("INSERT INTO tasks (task_id, state, note) VALUES (?, ?, ?)");
  for (const r of rows) insert.run(...r);
  db.close();
  return { dir, dbPath };
}

function dump(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT task_id, state, note, failure_kind FROM tasks ORDER BY task_id").all();
  } finally {
    db.close();
  }
}

const SEED_ROWS = [
  ["t-infra-1", "failed", "二分旧值", "infra"],
  ["t-infra-2", "failed", "二分旧值", "infra"],
  ["t-task-1", "failed", "二分旧值", "task"],
  ["t-business", "failed", "六类合法值不得动", "business"],
  ["t-timeout", "failed", "六类合法值不得动", "timeout"],
  ["t-null", "completed", "未分类不得动", null],
  ["t-untouched", "failed", "非 failed 行的其它列不得动", "task"],
];

test("dry-run：退 0、报出命中行数、库未被改动", async () => {
  const { dir, dbPath } = seed(SEED_ROWS);
  try {
    const before = dump(dbPath);
    const res = await runScript(dbPath);
    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    assert.match(res.stdout, /dry-run（只读，不写入）/);
    assert.match(res.stdout, /failure_kind='infra' → NULL：2 行/);
    assert.match(res.stdout, /failure_kind='task' → NULL：2 行/);
    assert.match(res.stdout, /dry-run 合计待清零 4 行/);
    assert.deepEqual(dump(dbPath), before, "dry-run 不得改动任何行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--apply：旧值归 NULL，六类合法值与其它列未被误改，且可重入", async () => {
  const { dir, dbPath } = seed(SEED_ROWS);
  try {
    const before = dump(dbPath);
    const res = await runScript(dbPath, ["--apply"]);
    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    assert.match(res.stdout, /本次共改 4 行/);
    assert.match(res.stdout, /改后计数：旧值命中 0 行/);

    const afterRows = dump(dbPath);
    const after = Object.fromEntries(afterRows.map((r) => [r.task_id, r]));
    assert.equal(after["t-infra-1"].failure_kind, null);
    assert.equal(after["t-infra-2"].failure_kind, null);
    assert.equal(after["t-task-1"].failure_kind, null);
    assert.equal(after["t-untouched"].failure_kind, null);
    assert.equal(after["t-business"].failure_kind, "business", "六类合法值不得被清零");
    assert.equal(after["t-timeout"].failure_kind, "timeout", "六类合法值不得被清零");
    assert.equal(after["t-null"].failure_kind, null, "未分类行不受影响");
    for (const row of before) {
      assert.equal(after[row.task_id].state, row.state, `state 列不得被改：${row.task_id}`);
      assert.equal(after[row.task_id].note, row.note, `note 列不得被改：${row.task_id}`);
    }

    const again = await runScript(dbPath, ["--apply"]);
    assert.equal(again.code, 0, `stderr=${again.stderr}`);
    assert.match(again.stdout, /本次共改 0 行/);
    assert.deepEqual(dump(dbPath), afterRows, "再跑一次不得改动任何行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("老库无 failure_kind 列 ⇒ fail-fast 退 1，不自行改 schema", async () => {
  const legacy = SEED_ROWS.map((r) => r.slice(0, 3));
  const { dir, dbPath } = seed(legacy, { withFailureKind: false });
  try {
    const res = await runScript(dbPath);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /无 failure_kind 列/);
    assert.match(res.stderr, /起桥一次/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
