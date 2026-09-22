#!/usr/bin/env node
/**
 * 存量 `agent_kind='qoder'` 退役迁移（REQ-v0.8.6-2026-09-21-03，Step 2 · 节点 O3）。
 *
 * 背景：`AGENT_KINDS` 硬切为 `qoder-cn` 后闭集里不再有 `qoder`，而库里存量
 * `runner_projects.agent_kind='qoder'` 会让新桥一读即抛（读守卫无 try/catch）。
 *
 * ⚠ 执行时点硬约束：**必须在「桥与 Launcher 都已停止、新桥尚未启动」的窗口内执行** ——
 * 旧桥（认 `qoder`）读到 `qoder-cn` 会抛、新桥（认 `qoder-cn`）读到 `qoder` 也会抛，
 * 两侧都不能在跑，不存在「一边跑一边迁」的顺序。
 * 升级六步序列中本脚本是第 3 步：停 mac-dev → 停 win Launcher → **跑本脚本** →
 * 起 orch 新桥 → 改 machine 配置为 `qoder-cn` + 起 Launcher → mac 恢复须先升级。
 *
 * ❗ 本脚本在本 Feature 内**只产出、不执行**（`--apply` 由用户在停桥窗口手动跑）。
 *
 * 语义：
 *   - 缺省 **dry-run**：以 `readOnly: true` 打开，只打印将要修改的行与计数，**不开可写连接**。
 *   - `--apply` 才写：两条 UPDATE 参数绑定（`runner_projects`、`sessions`），
 *     **只碰 `agent_kind` 这一列**，打印改前/改后计数。
 *   - 可重入：迁移完后再跑 ⇒ 0 changes。
 *
 * 用法：node scripts/migrate-agent-kind-qoder-cn.mjs [--apply]
 *
 * 环境变量：SESSION_DB 会话库路径（缺省 `<orch>/data/sessions.sqlite`，与 `bridgectl.mjs` 同源）
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_KIND = "qoder";
const CANONICAL_KIND = "qoder-cn";
const TABLES = ["runner_projects", "sessions"];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = dirname(SCRIPT_DIR);
const DB_PATH = process.env["SESSION_DB"] ?? join(ORCH_ROOT, "data", "sessions.sqlite");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const UNKNOWN = args.filter((a) => a !== "--apply");

if (UNKNOWN.length > 0) {
  console.error(`未知参数：${UNKNOWN.join(" ")}（只接受 --apply）`);
  process.exitCode = 1;
} else if (!existsSync(DB_PATH)) {
  console.error(`会话库不存在：${resolve(DB_PATH)}`);
  process.exitCode = 1;
} else {
  migrate();
}

function open(readOnly) {
  return new DatabaseSync(DB_PATH, readOnly ? { readOnly: true } : {});
}

function selectLegacy(db, table) {
  return db.prepare(`SELECT rowid, * FROM ${table} WHERE agent_kind = ?`).all(LEGACY_KIND);
}

function countKind(db, table, kind) {
  return db.prepare(`SELECT count(*) AS c FROM ${table} WHERE agent_kind = ?`).get(kind).c;
}

function printRows(table, rows) {
  console.log(`\n[${table}] agent_kind='${LEGACY_KIND}' → '${CANONICAL_KIND}'：${rows.length} 行`);
  for (const r of rows) console.log(`  ${JSON.stringify(r)}`);
}

function migrate() {
  console.log(`库：${resolve(DB_PATH)}`);
  console.log(`模式：${APPLY ? "--apply（写入）" : "dry-run（只读，不写入）"}`);

  const reader = open(true);
  const before = {};
  for (const table of TABLES) {
    before[table] = { legacy: countKind(reader, table, LEGACY_KIND), canonical: countKind(reader, table, CANONICAL_KIND) };
  }
  reader.close();

  if (!APPLY) {
    const reader2 = open(true);
    let total = 0;
    for (const table of TABLES) {
      const rows = selectLegacy(reader2, table);
      printRows(table, rows);
      total += rows.length;
    }
    reader2.close();
    console.log(`\ndry-run 合计待改 ${total} 行。确认无误后加 --apply 执行。`);
    return;
  }

  const db = open(false);
  try {
    for (const table of TABLES) {
      printRows(table, selectLegacy(db, table));
      const res = db
        .prepare(`UPDATE ${table} SET agent_kind = ? WHERE agent_kind = ?`)
        .run(CANONICAL_KIND, LEGACY_KIND);
      console.log(
        `[${table}] changes=${res.changes} · 改前 legacy=${before[table].legacy}/canonical=${before[table].canonical}` +
          ` → 改后 legacy=${countKind(db, table, LEGACY_KIND)}/canonical=${countKind(db, table, CANONICAL_KIND)}`
      );
    }
  } finally {
    db.close();
  }
  console.log("\n完成。再跑一次本脚本应为 0 changes（可重入）。");
}
