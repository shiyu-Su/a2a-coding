// 一次性数据清理：删除「未排期 ∧ 终态」Feature 及其引用面（用户 2026-09-28 指令，REQ-2026-09-28-05 案 B）
// 用法：node scripts/_purge-pool-terminal-features.mjs            ← dry-run（只打印范围）
//      node scripts/_purge-pool-terminal-features.mjs --apply    ← 备份 + 单事务删除 + 复核
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const DB = 'G:/code/a2a-coding/orch/data/sessions.sqlite';
const TERM = "('completed','cancelled','failed')";
const SELECT_TARGETS = `SELECT feature_id FROM features WHERE COALESCE(TRIM(version),'')='' AND state IN ${TERM}`;

let db;
try {
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(DB);
} catch {
  const req = createRequire(path.join(DB, '..') + '/');
  db = new (req('better-sqlite3'))(DB);
}

const count = (sql) => db.prepare(sql).get().n;
const scope = () => ({
  features: count(`SELECT COUNT(*) AS n FROM features WHERE feature_id IN (${SELECT_TARGETS})`),
  tasks: count(`SELECT COUNT(*) AS n FROM tasks WHERE feature_id IN (${SELECT_TARGETS})`),
  artifacts: count(`SELECT COUNT(*) AS n FROM artifacts WHERE feature_id IN (${SELECT_TARGETS})`),
  events_byFeature: count(`SELECT COUNT(*) AS n FROM events WHERE feature_id IN (${SELECT_TARGETS})`),
  events_byTask: count(`SELECT COUNT(*) AS n FROM events WHERE task_id IN (SELECT task_id FROM tasks WHERE feature_id IN (${SELECT_TARGETS}))`),
  integrationOps: count(`SELECT COUNT(*) AS n FROM integration_ops WHERE feature_id IN (${SELECT_TARGETS})`),
  tracks: count(`SELECT COUNT(*) AS n FROM tracks WHERE feature_id IN (${SELECT_TARGETS})`),
});

const before = scope();
console.log('删除范围（dry-run 与 apply 同口径）:', JSON.stringify(before));

if (!process.argv.includes('--apply')) {
  const sample = db.prepare(`SELECT feature_id, state, title FROM features WHERE feature_id IN (${SELECT_TARGETS}) ORDER BY created_at LIMIT 8`).all();
  console.log('样本 8 条:'); for (const r of sample) console.log('  ', r.feature_id.slice(0, 8), r.state, (r.title || '').slice(0, 40));
  console.log('dry-run（未写入）。确认后加 --apply。');
  db.close();
  process.exit(0);
}

// 1) 一致性备份（VACUUM INTO，含 WAL 已提交内容）
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `G:/code/a2a-coding/orch/data/sessions.sqlite.bak-${stamp}`;
db.exec(`VACUUM INTO '${backup}'`);
console.log('备份完成:', backup, fs.statSync(backup).size, 'bytes');

// 2) 单事务删除（先子后父）
db.exec('BEGIN');
try {
  db.exec(`DELETE FROM events WHERE feature_id IN (${SELECT_TARGETS})`);
  db.exec(`DELETE FROM events WHERE task_id IN (SELECT task_id FROM tasks WHERE feature_id IN (${SELECT_TARGETS}))`);
  db.exec(`DELETE FROM artifacts WHERE feature_id IN (${SELECT_TARGETS})`);
  db.exec(`DELETE FROM integration_ops WHERE feature_id IN (${SELECT_TARGETS})`);
  db.exec(`DELETE FROM tracks WHERE feature_id IN (${SELECT_TARGETS})`);
  db.exec(`DELETE FROM tasks WHERE feature_id IN (${SELECT_TARGETS})`);
  db.exec(`DELETE FROM features WHERE feature_id IN (${SELECT_TARGETS})`);
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('删除失败已回滚:', e.message);
  db.close();
  process.exit(1);
}

// 3) 复核
const after = scope();
console.log('删除后残留:', JSON.stringify(after));
const total = db.prepare('SELECT COUNT(*) AS n FROM features').get().n;
const openLeft = db.prepare(`SELECT COUNT(*) AS n FROM features WHERE COALESCE(TRIM(version),'')='' AND state NOT IN ${TERM}`).get().n;
console.log('features 剩余总数:', total, '| 池内未终态剩余:', openLeft);
db.close();
