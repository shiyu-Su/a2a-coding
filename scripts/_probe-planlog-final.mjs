// 只读：在 planlog 终版归档 + v0.9.1 备份里，取「未排期需求」段与「接入新 agent」相关条目的完整正文。
import { readFileSync, existsSync } from 'node:fs';

const TARGETS = [
  ['doc/_archive/planlog-终版归档-退役-2026-09-27.md', ['未排期', 'agent', 'Agent', 'kind', 'CLI', '接入']],
  ['doc/_archive/planlog-v0.9.1版本待办-备份-2026-09-25.md', ['B5', 'kind 无关', '接入新 agent', 'dsh', 'kimicode', 'pi 家族', '自注册']],
];

for (const [f, keys] of TARGETS) {
  console.log(`\n########## ${f}  ${existsSync(f) ? '' : '(缺失)'}`);
  if (!existsSync(f)) continue;
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  console.log(`(${lines.length} 行)`);
  // 先列小节标题，便于定位「未排期需求」段
  const heads = [];
  lines.forEach((ln, i) => {
    if (/^#{1,4}\s|^\*\*[^*]{2,40}\*\*\s*$|^>\s*\*\*未排期/.test(ln.trim())) heads.push(`  :${i + 1} ${ln.trim().slice(0, 120)}`);
  });
  console.log('--- 小节/粗体标题：');
  console.log(heads.slice(0, 40).join('\n'));

  console.log('--- 关键词命中行（含后续 2 行上下文）：');
  lines.forEach((ln, i) => {
    if (keys.filter((k) => ln.includes(k)).length >= 1 && keys.some((k) => ['B5', 'kind 无关', '接入新 agent', 'dsh', 'kimicode', 'pi 家族', '自注册'].includes(k) ? ln.includes(k) : false)) {
      console.log(`  :${i + 1} ${ln.trim().slice(0, 300)}`);
    }
  });
}
