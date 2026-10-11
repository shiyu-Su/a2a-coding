// 只读：查 doc/ flow/spec/ CHANGELOG 的 gitignore 状态 + tracked 状态 + instruction-doc 结构。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const git = (args) => {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (e) { return `ERR ${String(e.message).slice(0, 150)}`; }
};

console.log('== .gitignore 全文 ==');
console.log(readFileSync('.gitignore', 'utf8'));

console.log('== check-ignore ==');
for (const p of ['doc/v0.10.2/角色化-改造文档.md', 'doc/v0.10.2/', 'flow/spec/需求流程.md', 'CHANGELOG.md', 'instruction-doc/']) {
  console.log(`  ${p} → ${git(['check-ignore', '-v', p]) || '(未被忽略)'}`);
}

console.log('\n== 这些路径的 tracked 状态 ==');
for (const p of ['doc/v0.10.2/角色化-改造文档.md', 'flow/spec/需求流程.md', 'flow/spec/引擎映射.md', 'CHANGELOG.md']) {
  console.log(`  ${p} → ${git(['status', '--porcelain', '--', p]) || '(无变化/未跟踪?)'}`);
}
console.log('\n  git ls-files 计数: doc/ =', git(['ls-files', 'doc/']).split('\n').filter(Boolean).length,
  '· flow/ =', git(['ls-files', 'flow/']).split('\n').filter(Boolean).length,
  '· instruction-doc/ =', git(['ls-files', 'instruction-doc/']).split('\n').filter(Boolean).length);

console.log('\n== instruction-doc/ 顶层 ==');
if (existsSync('instruction-doc')) console.log('  ' + readdirSync('instruction-doc').join('  '));
