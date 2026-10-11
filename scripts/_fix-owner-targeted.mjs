// 一次性运维脚本：精准把 9 条被归属闸挡住的存量 Feature 归属改到 a2a-coding（用户 2026-09-27 指令：脏账清理）。
// 与 orch/scripts/migrate-feature-owner.mjs 同机制，但只动显式列出的 9 行（全量回填会连带 124 条历史完结行，超出授权范围）。
// 用法：node scripts/_fix-owner-targeted.mjs          ← dry-run，只读打印
//      node scripts/_fix-owner-targeted.mjs --apply  ← 实际写入 owner_group
import { createRequire } from 'node:module';
import path from 'node:path';

const DB = 'G:/code/a2a-coding/orch/data/sessions.sqlite';
const IDS = [
  // feature_unowned（owner_group IS NULL，7 条，v0.8.x 时代存量）
  'ff8c33ed-74e5-4ea7-81ec-52874499cc21',
  '6fb3bf45-9366-4bbc-94e7-784a1d0bbf67',
  '760ece21-83b9-4c4a-b5bb-7e1bc7c84568',
  '4e638b28-b122-466b-b588-0b92d13ab363',
  'f79844a8-75e2-4fd9-b10a-6e376dfd27e3',
  '9e11b1de-fb7a-4858-ba7c-d1e2b9997da9',
  '8059fb14-c1dd-4a18-8bce-796f3e415238',
  // feature_not_owned（属另一项目组，2 条：探针卡 + v0.5.0 残留）
  '64c9d8ea-ab6f-469f-ad44-1a726b34f5da',
  'd36185e7-02f3-4284-aed0-331cc8144a8c',
];

let db;
try {
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(DB);
} catch {
  const req = createRequire(path.join(DB, '..') + '/');
  db = new (req('better-sqlite3'))(DB);
}

const ph = IDS.map(() => '?').join(',');
const rows = db.prepare(`SELECT feature_id, state, owner_group, version, title FROM features WHERE feature_id IN (${ph})`).all(...IDS);
console.log(`命中 ${rows.length}/${IDS.length} 行：`);
for (const r of rows) console.log(`  ${r.feature_id.slice(0, 8)} | state=${r.state} | owner_group=${JSON.stringify(r.owner_group)} | version=${r.version ?? '-'} | ${r.title}`);

if (process.argv.includes('--apply')) {
  const upd = db.prepare(`UPDATE features SET owner_group = 'a2a-coding' WHERE feature_id IN (${ph})`);
  const res = upd.run(...IDS);
  console.log(`--apply：已更新 ${res.changes} 行 owner_group → 'a2a-coding'`);
} else {
  console.log('dry-run（未写入）。确认后加 --apply 执行。');
}
db.close();
