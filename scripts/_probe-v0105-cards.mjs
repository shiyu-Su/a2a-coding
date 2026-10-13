// 一次性只读：schema + v0.10.5 卡清单（宿主自办）
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('orch/data/sessions.sqlite', { readOnly: true });
const cols = db.prepare("PRAGMA table_info(features)").all().map((c) => c.name);
console.log('features columns:', cols.join(', '));

const idCol = cols.includes('feature_id') ? 'feature_id' : (cols.includes('id') ? 'id' : cols[0]);
console.log('using id col =', idCol);

console.log('\n— v0.10.5 卡清单 —');
const rows = db.prepare(
  `SELECT ${idCol} id, title, state, stage, approval, parent_feature_id, version, created_at
   FROM features WHERE version='v0.10.5' ORDER BY created_at`).all();
console.log('count=', rows.length);
for (const r of rows) {
  console.log([String(r.state).padEnd(16), r.parent_feature_id ? '[增补]' : '[主轨]',
    String(r.id).slice(0, 8), String(r.stage).padEnd(10), String(r.approval).padEnd(8), r.title].join('  '));
}

console.log('\n— 终态统计 —');
const st = db.prepare(`SELECT state, count(*) c FROM features WHERE version='v0.10.5' GROUP BY state`).all();
for (const r of st) console.log(' ', r.state, r.c);

console.log('\n— feature_projects 归属 —');
try {
  const fp = db.prepare('SELECT * FROM feature_projects ORDER BY feature_id, project_id').all();
  console.log('rows=', fp.length);
  for (const r of fp) console.log(JSON.stringify(r));
} catch (e) { console.log('(表缺失:', e.message, ')'); }

db.close();
