// 只读探针：统计「未排期 ∧ 终态」Feature 及其引用面（不写入）
// 用法：node scripts/_probe-pool-terminal-refs.mjs
import { createRequire } from 'node:module';
import path from 'node:path';

const DB = 'G:/code/a2a-coding/orch/data/sessions.sqlite';
let db;
try {
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(DB);
} catch {
  const req = createRequire(path.join(DB, '..') + '/');
  db = new (req('better-sqlite3'))(DB);
}

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
console.log('表:', tables.join(', '));

const TERM = "('completed','cancelled','failed')";
const targets = db.prepare(
  `SELECT COUNT(*) AS n FROM features WHERE COALESCE(TRIM(version),'')='' AND state IN ${TERM}`
).get();
console.log('目标行数（未排期 ∧ 终态）:', targets.n);

for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  const fkCols = cols.filter(c => /feature_id|featureId/i.test(c));
  if (fkCols.length) {
    for (const c of fkCols) {
      const r = db.prepare(
        `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} IN (SELECT feature_id FROM features WHERE COALESCE(TRIM(version),'')='' AND state IN ${TERM})`
      ).get();
      console.log(`引用面 ${t}.${c} = ${r.n}`);
    }
  }
}
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  if (cols.some(c => /task_id/i.test(c)) === false) continue;
  const r = db.prepare(
    `SELECT COUNT(*) AS n FROM ${t} WHERE ${cols.find(c => /task_id/i.test(c))} IN (SELECT task_id FROM tasks WHERE feature_id IN (SELECT feature_id FROM features WHERE COALESCE(TRIM(version),'')='' AND state IN ${TERM}))`
  ).get();
  if (r.n > 0) console.log(`二级引用 ${t}.${cols.find(c => /task_id/i.test(c))} = ${r.n}`);
}

// 目标按 state 与标题类别
const byState = db.prepare(
  `SELECT state, COUNT(*) AS n FROM features WHERE COALESCE(TRIM(version),'')='' AND state IN ${TERM} GROUP BY state`
).all();
console.log('按状态:', JSON.stringify(byState));
db.close();
