#!/usr/bin/env node
/**
 * 存量 Feature 归属回填（REQ-v0.8.6-2026-09-21-01 · 节点 N4，可选迁移脚本）。
 *
 * 背景（改造文档 §2.8 G2 / §1.3 R-3，已裁 = **fail-closed**）：`features.owner_group` 列新增后，
 * 未配组环境创建的历史 Feature 与配组改造前的存量行都是 `owner_group = NULL`（无归属）。
 * fail-closed 语义 ⇒ **已配组环境下这些 NULL 行对任何组身份不可见**（不猜默认组）。
 *
 * 默认方案 (a) 是「就按 fail-closed：历史 Feature 归档不可见」，**无需跑本脚本**。
 * 本脚本是方案 (b) 的**可选**动作：确需让某批存量 NULL Feature 归到指定组、重新可见时，
 * 由用户显式指定目标组跑一次（一条参数化 `UPDATE`）。
 *
 * 语义：
 *   - 缺省 **dry-run**：以 `readOnly: true` 打开，只列出将归入目标组的 NULL 行与计数，**不开可写连接、不写**。
 *   - `--apply` 才写：单条 `UPDATE features SET owner_group = ? WHERE owner_group IS NULL`（参数绑定，不拼接）。
 *   - **可重入**：回填后再跑 ⇒ `WHERE owner_group IS NULL` 命中 0 行（NULL 已消除）。
 *   - 只碰 `owner_group` 这一列、只动 `NULL` 行（已有归属的不动）。
 *
 * ❗ 前置：`owner_group` 列由 `session/store.ts` 的 ctor（try-ALTER 幂等迁移）在桥**首次以新代码打开库时**建立。
 * 本脚本不自建列；若列不存在会 fail-fast 并提示先以新代码起桥一次（或手动补列）后再跑。
 *
 * ⚠ 执行时点：本脚本在本 Feature 内**只产出、不执行**；`--apply` 由用户在停桥窗口手动跑。
 *
 * 用法：
 *   node scripts/migrate-feature-owner.mjs --group <组名>            # dry-run（默认，只读预览）
 *   node scripts/migrate-feature-owner.mjs --group <组名> --apply    # 实际写入
 *
 * 环境变量：SESSION_DB 会话库路径（缺省 `<orch>/data/sessions.sqlite`，与 `bridgectl.mjs` / 既有迁移脚本同源）
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = dirname(SCRIPT_DIR);
const DB_PATH = process.env["SESSION_DB"] ?? join(ORCH_ROOT, "data", "sessions.sqlite");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

function parseGroup() {
  const gi = args.indexOf("--group");
  if (gi === -1) return undefined;
  return args[gi + 1];
}

const GROUP = parseGroup();
// 消费掉已识别的参数，其余视为未知
const KNOWN = new Set(["--apply", "--group", GROUP]);
const UNKNOWN = args.filter((a) => !KNOWN.has(a));

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

function open(readOnly) {
  return new DatabaseSync(DB_PATH, readOnly ? { readOnly: true } : {});
}

function hasOwnerColumn(db) {
  return db.prepare("PRAGMA table_info(features)").all().some((c) => c.name === "owner_group");
}

function selectNullOwner(db) {
  return db.prepare("SELECT feature_id, state, title FROM features WHERE owner_group IS NULL").all();
}

function countNullOwner(db) {
  return db.prepare("SELECT count(*) AS c FROM features WHERE owner_group IS NULL").get().c;
}

function main() {
  if (UNKNOWN.length > 0) {
    fail(`未知参数：${UNKNOWN.join(" ")}（只接受 --group <组名> 与 --apply）`);
    return;
  }
  if (GROUP === undefined || GROUP === null || GROUP.startsWith("--")) {
    fail("缺少 --group <组名>：必须显式指定把存量 NULL Feature 归到哪个组（不猜默认组，见 §2.8 G2）。");
    return;
  }
  if (!existsSync(DB_PATH)) {
    fail(`会话库不存在：${resolve(DB_PATH)}`);
    return;
  }

  console.log(`库：${resolve(DB_PATH)}`);
  console.log(`目标组：owner_group = '${GROUP}'（仅回填 owner_group IS NULL 的行）`);
  console.log(`模式：${APPLY ? "--apply（写入）" : "dry-run（只读，不写入）"}`);

  const probe = open(true);
  try {
    if (!hasOwnerColumn(probe)) {
      fail(
        "features 表无 owner_group 列 ⇒ 请先以本版本代码起桥一次（store ctor 的 try-ALTER 幂等补列），再跑本脚本。",
      );
      return;
    }
    const rows = selectNullOwner(probe);
    console.log(`\n[features] owner_group IS NULL → '${GROUP}'：${rows.length} 行`);
    for (const r of rows) console.log(`  ${JSON.stringify(r)}`);
    if (!APPLY) {
      console.log(`\ndry-run 合计待归 ${rows.length} 行。确认无误后加 --apply 执行。`);
      return;
    }
  } finally {
    probe.close();
  }

  // --apply：重开可写连接执行单条参数化 UPDATE
  const db = open(false);
  try {
    const before = countNullOwner(db);
    const res = db
      .prepare("UPDATE features SET owner_group = ? WHERE owner_group IS NULL")
      .run(GROUP);
    console.log(
      `\n[features] changes=${res.changes} · 改前 NULL=${before} → 改后 NULL=${countNullOwner(db)}`,
    );
  } finally {
    db.close();
  }
  console.log("\n完成。再跑一次本脚本应为 0 changes（NULL 已消除，可重入）。");
}

main();
