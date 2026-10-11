// 只读诊断：N2 超时前是否留下部分落盘（判「原地重派」vs「拆小」）。
// 只取 git 元数据 + 关键字面的布尔/计数，不 dump 代码正文。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const run = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return `ERR ${String(e.message).slice(0, 120)}`;
  }
};

const U = process.env.UNIT_DIR || 'board';
console.log(`== git status --porcelain -- ${U}/ ==`);
console.log(run(['status', '--porcelain', '--', `${U}/`]) || '(无改动)');

console.log(`\n== git diff --stat -- ${U}/ ==`);
console.log(run(['diff', '--stat', '--', `${U}/`]) || '(无改动)');

console.log(`\n== 关键字面计数（判 N2 各步是否落盘）==`);
const files = [
  [`${U}/src/web/views.ts`, [
    ['renderOrgMemberSection', 'N2-2 删函数（应为 0）'],
    ['成员（声明态', 'N2-2 删面（应为 0）'],
    ['成员区', 'N2-4 悬挂文字（应为 0）'],
    ['<b>未声明</b>', 'N2-3 三出口承接位（应 ≥1）'],
    ['本组暂无项目：该组已在', 'N2-3 空态拆档（应 ≥1）'],
    ['上面各区', 'N2-5 去位置化（应为 0）'],
  ]],
  [`${U}/src/server.ts`, [['成员区', 'N2-4（应为 0）']]],
  [`${U}/README.md`, [['成员区', 'N5（应为 0，未跑则仍 1）']]],
];
for (const [p, keys] of files) {
  console.log(`--- ${p} ${existsSync(p) ? '' : '(缺失)'}`);
  if (!existsSync(p)) continue;
  const s = readFileSync(p, 'utf8');
  for (const [k, note] of keys) {
    const n = s.split(k).length - 1;
    console.log(`    ${JSON.stringify(k)} × ${n}   ${note}`);
  }
}
