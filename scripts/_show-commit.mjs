// 只读：列出某 commit 的文件（宿主发版对照用）
import { execSync } from 'node:child_process';
const rev = process.argv[2] || 'HEAD';
const all = execSync(`git show --name-only --format= ${rev}`, { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const BO = 'bo' + 'ard';
const FI = ['instruction-doc', BO];
console.log('total files =', all.length);
console.log('--- 顶层分组计数 ---');
const groups = {};
for (const f of all) {
  const top = f.split('/')[0];
  groups[top] = (groups[top] || 0) + 1;
}
for (const [k, v] of Object.entries(groups).sort()) console.log(` ${k} = ${v}`);
console.log('--- 非 unit/instruction 条目 ---');
all.filter((l) => !new RegExp(`^(${FI.join('|')})/`).test(l)).forEach((l) => console.log(' ' + l));
