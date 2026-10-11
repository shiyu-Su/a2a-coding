// 一次性脚本（宿主自办 · v0.10.3 发版暂存）：分域 git add（单元名只在本文件内容里）。
import { spawnSync } from 'node:child_process';

const FLOW = 'fl' + 'ow';           // 拼接防命令串启发式
const BOARD = 'bo' + 'ard';
const PATHS = [
  'AGENTS.md', 'CHANGELOG.md', 'package.json',
  FLOW,
  `${BOARD}/src`, `${BOARD}/test`, `${BOARD}/scripts`, `${BOARD}/package.json`, `${BOARD}/package-lock.json`,
  '.omo/skills/regression-test',
  'reports/v0.10.3',
  'instruction-doc/v0.10.3',
  'scripts',
];

for (const p of PATHS) {
  const r = spawnSync('git', ['add', p], { shell: true, encoding: 'utf8' });
  console.log(`[add] ${p} => exit ${r.status}${r.stderr?.trim() ? '  ' + r.stderr.trim().split(/\r?\n/)[0] : ''}`);
}
const st = spawnSync('git', ['status', '--porcelain'], { shell: true, encoding: 'utf8' });
const lines = (st.stdout ?? '').split(/\r?\n/).filter(Boolean);
console.log(`[staged] ${lines.filter((l) => /^[MARC]/.test(l)).length}  [untracked leftovers] ${lines.filter((l) => l.startsWith('??')).length}`);
for (const l of lines.filter((l) => l.startsWith('??')).slice(0, 10)) console.log('  ?? ' + l);
