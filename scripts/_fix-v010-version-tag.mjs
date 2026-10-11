// 一次性运维脚本（用户 2026-10-08 指令）：
//  1) 把「尾段承接」Feature 42cbd9db 的 version 从空串挪入 v0.10.0（改库方式，绕过 owner_group 存在性校验的写口缺陷）
//  2) 把引擎版本台账里 v0.10.0 那行的 owner_group 从 NULL 补成 a2a-coding
//     （该行先前由 HTTP 建版号端点创建；端点不落 owner_group ⇒ 校验按 owner_group 精确匹配永远查不到 ⇒ 「先建版号」走不通）
// 用法：node scripts/_fix-v010-version-tag.mjs          ← dry-run，只读打印
//      node scripts/_fix-v010-version-tag.mjs --apply  ← 实际写入
import { createRequire } from 'node:module';
import path from 'node:path';

const DB = 'G:/code/a2a-coding/orch/data/sessions.sqlite';
const FEATURE = '42cbd9db-dca8-4849-a9ce-eccaaff31c96';
const VERSION = 'v0.10.0';
const GROUP = 'a2a-coding';

let db;
try {
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(DB);
} catch {
  const req = createRequire(path.join(DB, '..') + '/');
  db = new (req('better-sqlite3'))(DB);
}

const dump = (label) => {
  console.log(`--- ${label} ---`);
  console.log('versions:');
  for (const r of db.prepare('SELECT * FROM versions').all()) console.log('  ', JSON.stringify(r));
  console.log('feature:');
  for (const r of db.prepare('SELECT feature_id, state, owner_group, version, updated_at FROM features WHERE feature_id = ?').all(FEATURE)) {
    console.log('  ', JSON.stringify(r));
  }
};

dump('改前');

if (process.argv.includes('--apply')) {
  const r1 = db.prepare("UPDATE versions SET owner_group = ? WHERE version = ? AND (owner_group IS NULL OR owner_group = '')").run(GROUP, VERSION);
  console.log(`--apply: versions.owner_group 更新 ${r1.changes} 行（NULL → ${GROUP}，仅 version=${VERSION}）`);
  const r2 = db.prepare('UPDATE features SET version = ?, updated_at = ? WHERE feature_id = ?').run(VERSION, new Date().toISOString(), FEATURE);
  console.log(`--apply: features.version 更新 ${r2.changes} 行（→ ${VERSION}）`);
  dump('改后');
} else {
  console.log('dry-run（未写入）。确认后加 --apply 执行。');
}
db.close();
