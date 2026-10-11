// 只读：在 planlog 存档里定位「接入更多 agent 的前置改进项」。
import { readdirSync, readFileSync } from 'node:fs';

const DIR = 'doc/_archive';
const files = readdirSync(DIR).filter((f) => /planlog/i.test(f));
const NEEDLES = ['更多', 'agent', 'Agent', 'CLI', 'cli', '前置', '未排期', '未来', '接入'];

for (const f of files) {
  const src = readFileSync(`${DIR}/${f}`, 'utf8');
  const lines = src.split(/\r?\n/);
  const hits = [];
  lines.forEach((ln, i) => {
    const hit = NEEDLES.filter((n) => ln.includes(n));
    if (hit.length >= 2) hits.push({ i: i + 1, ln, hit });
  });
  console.log(`\n===== ${f}  (${lines.length} 行，多关键词命中 ${hits.length} 处)`);
  for (const h of hits.slice(0, 25)) console.log(`  :${h.i} [${h.hit.join(',')}] ${h.ln.trim().slice(0, 220)}`);
}
