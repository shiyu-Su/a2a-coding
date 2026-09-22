#!/usr/bin/env node
/**
 * 存量 `failure_kind` 二分旧值清零（REQ-v0.8.8-2026-09-22-01，Step 2 · 节点 O8）。
 *
 * 背景：v0.8.8 O1 把 `tasks.failure_kind` 的取值闭集从二分 `{infra, task}` 硬切为六类
 * `{agent, transport, runner, model_queue, timeout, business}`（事实源 `PROTOCOL.md` 2.3）。
 * 二分时代写入的存量行仍留在库里，读侧虽已放宽为「非法值 ⇒ 兜底 `business` + warn 留原值」
 * （`session/store.ts` 的 `coerceStoredFailureKind`），但那只是**混跑期的安全网**，不是终态：
 * 每次列表读路径都会 warn，且「兜底 business」与「真 business」在账面上混成一坨。
 *
 * **口径 = 归未分类（NULL），不伪造近似六类**：2→6 是有损映射，旧 `task` 桶里混着
 * rpc / protocol / timeout / 未知，旧 `infra` 桶里混着 agent / transport / runner ——
 * 任何映射都是在造证据。置 NULL 后这些任务回到「未分类」，与从未分类的任务同口径。
 *
 * 语义：
 *   - 缺省 **dry-run**：以 `readOnly: true` 打开，只打印命中行与计数，**不开可写连接、不写**。
 *   - `--apply` 才写：每个旧值一条参数化 `UPDATE ... SET failure_kind = NULL WHERE failure_kind = ?`，
 *     **只碰 `failure_kind` 这一列**、**只动命中旧值的行**，打印改前/改后计数。
 *   - **可重入**：迁移完后再跑 ⇒ 命中 0 行 / `changes=0`。
 *   - 六类合法值与 NULL 行**一律不动**（脚本不做任何 schema 变更；列由 `store.ts` ctor 的
 *     try-ALTER 幂等建立，老库若无此列会 fail-fast 提示先以新代码起桥一次）。
 *
 * ⚠ 执行时点：本脚本在改造期内**只产出、只做 dry-run 取证**；`--apply` 由宿主在验收期
 * （桥停止窗口）择时执行，不得写生产库。
 *
 * 用法：node scripts/migrate-failure-kind-sixclass.mjs [--apply]
 *
 * 环境变量：SESSION_DB 会话库路径（缺省 `<orch>/data/sessions.sqlite`，与 `bridgectl.mjs` /
 * 既有迁移脚本同源）
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 二分时代（≤ v0.8.7）写入、自 2.3 起非法的取值 —— 待清零的对象 */
const LEGACY_VALUES = ["infra", "task"];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = dirname(SCRIPT_DIR);
const DB_PATH = process.env["SESSION_DB"] ?? join(ORCH_ROOT, "data", "sessions.sqlite");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const UNKNOWN = args.filter((a) => a !== "--apply");

function open(readOnly) {
  return new DatabaseSync(DB_PATH, readOnly ? { readOnly: true } : {});
}

function hasTable(db, table) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function countLegacy(db, value) {
  return db.prepare("SELECT count(*) AS c FROM tasks WHERE failure_kind = ?").get(value).c;
}

function countNull(db) {
  return db.prepare("SELECT count(*) AS c FROM tasks WHERE failure_kind IS NULL").get().c;
}

function selectLegacy(db, value) {
  return db
    .prepare("SELECT task_id, state, failure_kind FROM tasks WHERE failure_kind = ? ORDER BY task_id")
    .all(value);
}

function printRows(value, rows) {
  console.log(`\n[tasks] failure_kind='${value}' → NULL：${rows.length} 行`);
  for (const r of rows) console.log(`  ${JSON.stringify(r)}`);
}

function main() {
  if (UNKNOWN.length > 0) {
    console.error(`未知参数：${UNKNOWN.join(" ")}（只接受 --apply）`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(DB_PATH)) {
    console.error(`会话库不存在：${resolve(DB_PATH)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`库：${resolve(DB_PATH)}`);
  console.log(`模式：${APPLY ? "--apply（写入）" : "dry-run（只读，不写入）"}`);
  console.log(`口径：二分旧值 ${LEGACY_VALUES.map((v) => `'${v}'`).join(" / ")} ⇒ NULL（未分类，不伪造六类）`);

  const probe = open(true);
  try {
    if (!hasTable(probe, "tasks")) {
      console.error("tasks 表不存在 ⇒ 该库尚无任务账本，无需迁移。");
      return;
    }
    if (!hasColumn(probe, "tasks", "failure_kind")) {
      console.error(
        "tasks 表无 failure_kind 列 ⇒ 请先以本版本代码起桥一次（store ctor 的 try-ALTER 幂等补列），再跑本脚本。",
      );
      process.exitCode = 1;
      return;
    }
    const beforeTotal = LEGACY_VALUES.reduce((sum, v) => sum + countLegacy(probe, v), 0);
    console.log(`改前计数：旧值命中 ${beforeTotal} 行 · NULL（未分类）${countNull(probe)} 行`);

    if (!APPLY) {
      let total = 0;
      for (const value of LEGACY_VALUES) {
        const rows = selectLegacy(probe, value);
        printRows(value, rows);
        total += rows.length;
      }
      console.log(`\ndry-run 合计待清零 ${total} 行（未改动任何行）。确认无误后加 --apply 执行。`);
      return;
    }
  } finally {
    probe.close();
  }

  // --apply：重开可写连接，逐旧值一条参数化 UPDATE
  const db = open(false);
  try {
    let changes = 0;
    for (const value of LEGACY_VALUES) {
      printRows(value, selectLegacy(db, value));
      const res = db.prepare("UPDATE tasks SET failure_kind = NULL WHERE failure_kind = ?").run(value);
      changes += res.changes;
      console.log(`[tasks] failure_kind='${value}' changes=${res.changes}`);
    }
    console.log(`\n改后计数：旧值命中 ${LEGACY_VALUES.reduce((s, v) => s + countLegacy(db, v), 0)} 行 · NULL（未分类）${countNull(db)} 行 · 本次共改 ${changes} 行`);
  } finally {
    db.close();
  }
  console.log("\n完成。再跑一次本脚本应为 0 行 / changes=0（可重入）。");
}

main();
