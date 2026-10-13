// 一次性只读盘点（宿主自办 · 主需求 eb86d5e8 收口后）
// 目的：核 Group v0.10.5 名下需求卡的终态分布（发版收口集合 = {completed, cancelled}）。
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('orch/data/sessions.sqlite', { readOnly: true });
const rows = db.prepare(
  `SELECT IFNULL(NULLIF(version,''),'(未排期)') v, state, count(*) c
   FROM features WHERE version IN ('v0.10.5','') OR version IS NULL
   GROUP BY v, state ORDER BY v, state`).all();
console.log('— v0.10.5 / 未排期 卡的状态分布 —');
for (const r of rows) console.log(`${String(r.v).padEnd(12)} ${String(r.state).padEnd(18)} ${r.c}`);

const g = db.prepare(`SELECT version, status FROM versions ORDER BY version`).all();
console.log('\n— Group 台账 —');
for (const r of g) console.log(`${r.version}  ${r.status}`);

const pv = db.prepare(`SELECT project_id, version, status FROM project_versions ORDER BY project_id, version`).all();
console.log('\n— Project 台账 —');
for (const r of pv) console.log(`${r.project_id.padEnd(9)} ${r.version.padEnd(9)} ${r.status}`);
db.close();
