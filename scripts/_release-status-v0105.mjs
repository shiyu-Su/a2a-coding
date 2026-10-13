// 只读：列出工作树改动/未跟踪（宿主发版核对 add 面）
import { execSync } from 'node:child_process';
const lines = execSync('git status --porcelain', { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
for (const top of ['AGENTS.md', 'CHANGELOG.md', 'README.md', 'package.json', 'scripts', 'instruction-doc']) {
  const hit = lines.filter((l) => l.slice(3).split('/')[0] === top || l.slice(3) === top);
  console.log(`\n### ${top} (${hit.length})`);
  hit.forEach((l) => console.log('  ' + l));
}
for (const unit of ['orch', 'flow', 'board', 'machine']) {
  const hit = lines.filter((l) => l.slice(3) === unit || l.slice(3).startsWith(unit + '/'));
  console.log(`\n### ${unit} (${hit.length})`);
  hit.forEach((l) => console.log('  ' + l));
}
console.log('\n### 其他（未归入上面任何组）');
lines.filter((l) => {
  const p = l.slice(3);
  const tops = ['AGENTS.md', 'CHANGELOG.md', 'README.md', 'package.json', 'scripts', 'instruction-doc', 'orch', 'flow', 'board', 'machine'];
  return !tops.some((t) => p === t || p.startsWith(t + '/'));
}).forEach((l) => console.log('  ' + l));
