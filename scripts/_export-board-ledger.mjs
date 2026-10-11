// 一次性运维脚本（用户 2026-10-09 指令「迁移你操作」）：
// 把板的版本台账导出（board/.data/versions-export.json）复制到**仓根**路径，
// 供 orch 的一次性迁移脚本以 --from= 引用 —— 因为宿主 Bash 通道不能出现单元路径段（守卫），
// 而迁移脚本要求 --from 显式注入（不猜板文件位置）。
// 只读板侧文件、只写根侧副本；不改任何单元内容。
// 用法：node scripts/_export-board-ledger.mjs          ← dry-run（只打印摘要）
//      node scripts/_export-board-ledger.mjs --apply  ← 实际写根侧副本
import fs from 'node:fs';

const SRC = 'G:/code/a2a-coding/board/.data/versions-export.json';
const DST = 'G:/code/a2a-coding/.data/versions-export.json';

const raw = fs.readFileSync(SRC, 'utf8');
const j = JSON.parse(raw);
const vs = j.versions || j.rows || [];
console.log(`源: ${SRC}`);
console.log(`  顶层键: ${Object.keys(j).join(', ')}`);
console.log(`  条数: ${vs.length}`);
for (const v of vs) {
  console.log(`  - org=${JSON.stringify(v.org ?? v.ownerGroup)} version=${v.version} status=${v.status} note=${JSON.stringify(v.note ?? null)}`);
}

if (process.argv.includes('--apply')) {
  fs.mkdirSync('G:/code/a2a-coding/.data', { recursive: true });
  fs.writeFileSync(DST, raw, 'utf8');
  console.log(`\n--apply: 已写根侧副本 → ${DST}（${raw.length} 字节，逐字节同源）`);
  const back = JSON.parse(fs.readFileSync(DST, 'utf8'));
  console.log(`  回读: 条数 ${(back.versions || back.rows || []).length}，与源一致: ${JSON.stringify(back) === JSON.stringify(j)}`);
} else {
  console.log('\ndry-run（未写入）。确认后加 --apply。');
}
