#!/usr/bin/env node
// watch-feature.mjs — 派发 Feature 后循环查询其状态，直到离开 executing（或循环上限）
// 用法：
//   node scripts/watch-feature.mjs <featureId> [--interval 10000] [--max 60] [--db <sqlite路径>]
// 退出码：0 = 终态（completed / failed / cancelled / needs_input）；2 = 达到循环上限仍未终态；1 = 参数/连接错误。
// 只读：仅 SELECT，绝不写库；DB 文件由运行中的桥持有（WAL/读并发均可）。

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : null;
}

const featureId = args[0];
if (!featureId || featureId.startsWith("--")) {
  console.error("用法: node scripts/watch-feature.mjs <featureId> [--interval ms] [--max 次] [--db 路径]");
  process.exit(1);
}
const interval = Math.max(2000, parseInt(argValue("--interval", "10000"), 10) || 10000);
const maxLoops = Math.max(1, parseInt(argValue("--max", "60"), 10) || 60);

// DB 路径：--db > SESSION_DB 环境变量 > orchestr/data/sessions.sqlite（相对本仓根）
const dbPath = argValue("--db", null)
  ?? process.env.SESSION_DB
  ?? path.resolve(process.cwd(), "orch/data/sessions.sqlite");
if (!fs.existsSync(dbPath)) {
  console.error(`[watch] DB 不存在: ${dbPath}`);
  process.exit(1);
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
// 注意：needs_input 是需要宿主介入的停留态，也视为「不是执行中」即退出；integrating/testing/reviewing 同理（引擎已交宿主）。

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (err) {
  console.error(`[watch] 打开 DB 失败（只读）: ${err?.message ?? err}`);
  process.exit(1);
}

function snapshot() {
  const feature = db
    .prepare("SELECT state, title, updated_at FROM features WHERE feature_id = ?")
    .get(featureId);
  if (!feature) return null;
  const counts = db
    .prepare(
      `SELECT state, COUNT(*) AS n FROM tasks WHERE feature_id = ? GROUP BY state ORDER BY state`
    )
    .all(featureId);
  return { feature, counts };
}

function fmtSnapshot(s) {
  return `${s.feature.state} | ${s.feature.title}`;
}

function tasksLine(counts) {
  return counts.map((r) => `${r.state}=${r.n}`).join(" ");
}

console.log(
  `[watch] feature=${featureId} interval=${interval}ms max=${maxLoops} db=${dbPath}`
);

for (let i = 1; i <= maxLoops; i++) {
  let snap;
  try {
    snap = snapshot();
  } catch (err) {
    console.error(`[watch] 查询失败 (第 ${i} 轮): ${err?.message ?? err}`);
    process.exitCode = 1;
    break;
  }
  if (!snap) {
    console.error(`[watch] featureId 未找到: ${featureId}`);
    process.exit(1);
  }
  const state = snap.feature.state;
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[watch] #${i} ${ts} feature=${state} tasks[${tasksLine(snap.counts)}]`);

  if (state !== "executing") {
    console.log(
      `[watch] 完成：feature=${featureId} state=${state}${TERMINAL.has(state) ? "（终态）" : "（已交宿主）"}`
    );
    process.exit(
      state === "completed" ? 0 : state === "failed" ? 1 : 0
    );
  }
  if (i < maxLoops) {
    await new Promise((r) => setTimeout(r, interval));
  }
}

console.error(`[watch] 达到循环上限 ${maxLoops} 轮仍在 executing（feature=${featureId}），放弃监视（不改动任何状态）`);
process.exit(2);
