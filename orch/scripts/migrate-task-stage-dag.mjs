#!/usr/bin/env node
/**
 * 存量 DAG 行 `stage` 一次性回填（v0.10.8 增补轨 `513b58f3` · O-N3 · 改造文档 §6.1 增补节 O-3）
 *
 * 把「`stage` 快照列落地前建行的存量 DAG 节点」与「修正前派生表摄下的错值 dag 行」统一置 `改造`。
 * **读侧零改**（`readTaskStage` 维持「NULL 照实读出、不推导不兜底」），不加 DDL，不改 `tasks.mode`。
 *
 * ## 两支谓词（宿主 2026-10-17 裁 (C) + 一并翻正）
 * - **A 存量回填**：`mode IS NULL ∧ stage IS NULL ∧ feature_id IS NOT NULL` ⇒ `改造`。
 *   `mode` 列晚于 `stage` 列落地、O-4 裁定「存量不回填 `mode`」⇒ 存量 DAG 行在库里是 `mode IS NULL`
 *   （读侧按 dag 解释）。`feature_id IS NOT NULL` 必需：口径收紧前**只有 execute 能带 featureId**
 *   ⇒ 「`mode IS NULL` ∧ 有归属」恰等价于存量 DAG 行；`feature_id IS NULL` 的无名遗留行
 *   （收紧前的询问/探针类）**不填**（不臆造归属，归板侧「—」桶）。
 * - **B 错值翻正**：`mode='dag' ∧ stage='改造方案'` ⇒ `改造`。DAG 节点恒在 `decomposing`/`executing`
 *   建行 ⇒ 修正后的派生表下 `dag` 行不可能合法为「改造方案」；这 8 枚是**修正前表**摄的快照 = 错值，
 *   不是历史事实。「快照只认首次」管的是**重派不得改写**，不豁免一次性纠错迁移。
 *
 * ## 安全
 * - 缺省 **dry-run**（`readOnly` 打开，只出计划与判据）；`--apply` 才写。
 * - **迁移前落快照**（`--snapshot=<path>`，缺省 `data/task-stage-backfill-<utc>.json`）：
 *   两支目标集逐行 `{taskId, mode, stage, featureId}` ⇒ 判据不达标**整批回滚**，事后亦可 `--rollback` 还原。
 * - **整批一个 `BEGIN IMMEDIATE` 事务**，四判据在事务内自证 ⇒ 任一不达标 ⇒ `ROLLBACK` + 退出码 1。
 * - **可重入**：两支谓词回填后都不再命中 ⇒ 二次跑待回填 0 行。
 * - ⚠ **停桥窗口**执行 `--apply`（与 `migrate-versions-ledger.mjs` / `migrate-feature-owner.mjs` 同纪律）。
 *
 * ## 判据（口径修订版 · 原节点卡字面谓词 `mode='dag' ∧ stage IS NULL` 实测命中 0 行）
 * - ① 影响行数 == 迁移前 A + B 两支计数之和
 * - ② 迁移后 A 支计数 == 0 且 B 支计数 == 0
 * - ③ 主需求 `d78b74f5` 名下 22 枚存量 DAG 行（`mode IS NULL`）`stage` 全为 `改造`
 * - ④ `mode='inquiry'` 的 null 行零变化 + `feature_id IS NULL` 的无名遗留行零变化
 *
 * 用法：
 *   node scripts/migrate-task-stage-dag.mjs                       # dry-run
 *   node scripts/migrate-task-stage-dag.mjs --apply               # 写入（停桥窗口）
 *   node scripts/migrate-task-stage-dag.mjs --rollback --snapshot=<path>
 *
 * 环境变量：SESSION_DB 会话库路径（缺省 `<orch>/data/sessions.sqlite`，与 `bridgectl.mjs` 同源）
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = dirname(SCRIPT_DIR);
const DB_PATH = process.env["SESSION_DB"] ?? join(ORCH_ROOT, "data", "sessions.sqlite");

/** 回填目标值 = 修正后派生表下 DAG 建行态（`decomposing` / `executing`）的阶段 */
const BACKFILL_STAGE = "改造";
/** 主需求（判据③ 的核对对象） */
const MAIN_FEATURE = "d78b74f5-ba25-4bd4-9036-e822589b27f0";
/** 主需求名下预期存量 DAG 行数（判据③ 的期望值） */
const MAIN_EXPECT = 22;

/** 两支谓词（见文件头） */
const SCOPES = [
  {
    key: "A-存量回填",
    where: "mode IS NULL AND stage IS NULL AND feature_id IS NOT NULL",
    set: BACKFILL_STAGE,
  },
  { key: "B-错值翻正", where: "mode = 'dag' AND stage = '改造方案'", set: BACKFILL_STAGE },
];

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ROLLBACK = args.includes("--rollback");
const SNAPSHOT_ARG = args.find((a) => a.startsWith("--snapshot="))?.slice("--snapshot=".length);
const UNKNOWN = args.filter((a) => a !== "--apply" && a !== "--rollback" && !a.startsWith("--snapshot="));

function nowIso() {
  return new Date().toISOString();
}

function count(db, where, ...params) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...params).n);
}

/** 快照/判据用到的全部计数（同一次读里取，保证前后一致） */
function readCounts(db) {
  return {
    scope: SCOPES.map((s) => count(db, s.where)),
    mainLegacy: count(db, "feature_id = ? AND mode IS NULL", MAIN_FEATURE),
    mainBackfilled: count(db, "feature_id = ? AND mode IS NULL AND stage = ?", MAIN_FEATURE, BACKFILL_STAGE),
    inquiryNull: count(db, "mode = 'inquiry' AND stage IS NULL"),
    anonymousNull: count(db, "mode IS NULL AND stage IS NULL AND feature_id IS NULL"),
  };
}

function collectTargetRows(db) {
  const rows = [];
  for (const scope of SCOPES) {
    for (const r of db
      .prepare(`SELECT task_id, mode, stage, feature_id FROM tasks WHERE ${scope.where} ORDER BY created_at, task_id`)
      .all()) {
      rows.push({ scope: scope.key, taskId: r.task_id, mode: r.mode, stage: r.stage, featureId: r.feature_id });
    }
  }
  return rows;
}

/**
 * 四判据核对（`after` 与 `before` 同形；`changed` = 各支实际影响行数）
 * @returns {string[]} 不达标项（空 = 全绿）
 */
function checkCriteria(before, changedByScope, after) {
  const misses = [];
  const preTotal = before.scope.reduce((a, b) => a + b, 0);
  const changedTotal = changedByScope.reduce((a, b) => a + b, 0);
  if (changedTotal !== preTotal || changedByScope.some((c, i) => c !== before.scope[i])) {
    misses.push(
      `判据①：影响行数 [${changedByScope.join("/")}] != 迁移前各支计数 [${before.scope.join("/")}]（合计 ${preTotal}）`,
    );
  }
  if (after.scope.some((n) => n !== 0)) {
    misses.push(`判据②：迁移后各支计数 [${after.scope.join("/")}] 应全为 0`);
  }
  if (after.mainBackfilled !== MAIN_EXPECT || after.mainLegacy !== MAIN_EXPECT) {
    misses.push(
      `判据③：主需求 ${MAIN_FEATURE.slice(0, 8)} 存量 DAG 行 ${after.mainLegacy} 枚，其中「${BACKFILL_STAGE}」${after.mainBackfilled} 枚（期望各 ${MAIN_EXPECT}）`,
    );
  }
  if (after.inquiryNull !== before.inquiryNull) {
    misses.push(`判据④：inquiry null 行 ${before.inquiryNull} → ${after.inquiryNull}（应零变化）`);
  }
  if (after.anonymousNull !== before.anonymousNull) {
    misses.push(`判据④：无名遗留行 ${before.anonymousNull} → ${after.anonymousNull}（应零变化、不回填）`);
  }
  return misses;
}

function fmtScope(prefix) {
  return SCOPES.map((s, i) => `${s.key}=${prefix[i]}`).join(" · ");
}

function writeSnapshot(rows) {
  const path = SNAPSHOT_ARG ?? join(ORCH_ROOT, "data", `task-stage-backfill-${nowIso().replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    path,
    JSON.stringify({ at: nowIso(), db: resolve(DB_PATH), scopes: SCOPES, rows }, null, 2),
    "utf8",
  );
  return path;
}

function rollback(db, snapshotPath) {
  if (!existsSync(snapshotPath)) throw new Error(`快照不存在：${resolve(snapshotPath)}`);
  const { rows } = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const before = readCounts(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const stmt = db.prepare("UPDATE tasks SET stage = ? WHERE task_id = ?");
    let restored = 0;
    for (const r of rows) restored += stmt.run(r.stage, r.task_id).changes;
    const after = readCounts(db);
    const preTotal = before.scope.reduce((a, b) => a + b, 0);
    if (after.scope.reduce((a, b) => a + b, 0) !== preTotal + rows.length) {
      throw new Error(`回滚后目标集计数与「迁移前 + 快照行数」不符 ⇒ 整批不提交`);
    }
    db.exec("COMMIT");
    console.log(`[回滚] 快照 ${snapshotPath} 的 ${rows.length} 行按原值还原（实际改动 ${restored} 行）。`);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function main() {
  if (UNKNOWN.length > 0) {
    console.error(`未知参数：${UNKNOWN.join(" ")}（只接受 --apply / --rollback / --snapshot=<path>）`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(DB_PATH)) {
    console.error(`会话库不存在：${resolve(DB_PATH)}`);
    process.exitCode = 1;
    return;
  }

  if (ROLLBACK) {
    const db = new DatabaseSync(DB_PATH);
    try {
      rollback(db, SNAPSHOT_ARG);
    } finally {
      db.close();
    }
    return;
  }

  const probe = new DatabaseSync(DB_PATH, { readOnly: true });
  let before;
  let targetRows;
  try {
    before = readCounts(probe);
    targetRows = collectTargetRows(probe);
  } finally {
    probe.close();
  }

  console.log(`库：${resolve(DB_PATH)}`);
  console.log(`回填值：${BACKFILL_STAGE}`);
  for (const s of SCOPES) console.log(`谓词：${s.key} ⇒ ${s.where}`);
  console.log(`模式：${APPLY ? "--apply（写入）" : "dry-run（只读，不写入）"}`);
  console.log(`\n[迁移前] ${fmtScope(before.scope)} · 合计 ${before.scope.reduce((a, b) => a + b, 0)} 行`);
  console.log(
    `[主需求 ${MAIN_FEATURE.slice(0, 8)}] 存量 DAG 行（mode IS NULL）${before.mainLegacy} · ` +
      `已是「${BACKFILL_STAGE}」${before.mainBackfilled}`,
  );
  console.log(`[不动] inquiry null 行 ${before.inquiryNull} · 无名遗留行（feature_id IS NULL）${before.anonymousNull}`);

  if (!APPLY) {
    console.log(`\ndry-run 合计：待回填 ${targetRows.length} 行（${fmtScope(before.scope)}）。确认无误后加 --apply 执行。`);
    return;
  }

  const snapshotPath = writeSnapshot(targetRows);
  console.log(`\n[快照] ${snapshotPath}（${targetRows.length} 行 task_id→stage 原值）`);

  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec("BEGIN IMMEDIATE");
    let changedByScope;
    try {
      changedByScope = SCOPES.map(
        (s) => db.prepare(`UPDATE tasks SET stage = ? WHERE ${s.where}`).run(s.set).changes,
      );
      const after = readCounts(db);
      const misses = checkCriteria(before, changedByScope, after);
      if (misses.length > 0) {
        db.exec("ROLLBACK");
        console.error(`\n[整批回滚 · 未落库]\n- ${misses.join("\n- ")}`);
        console.error(`快照留存供核对：${snapshotPath}`);
        process.exitCode = 1;
        return;
      }
      db.exec("COMMIT");
      console.log(
        `\n[写入] 影响行数 ${fmtScope(changedByScope)}（合计 ${changedByScope.reduce((a, b) => a + b, 0)}）`,
      );
      console.log(
        `[迁移后] ${fmtScope(after.scope)} · 主需求「${BACKFILL_STAGE}」${after.mainBackfilled}/${after.mainLegacy} · ` +
          `inquiry null ${after.inquiryNull} · 无名遗留 ${after.anonymousNull}`,
      );
      console.log(`[判据] ①②③④ 全绿（事务内自证，不达标即 ROLLBACK）`);
      console.log(
        `回滚：node scripts/migrate-task-stage-dag.mjs --rollback --snapshot=${snapshotPath}`,
      );
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.close();
  }
}

main();
