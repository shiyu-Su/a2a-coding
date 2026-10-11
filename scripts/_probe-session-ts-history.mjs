// 一次性只读探针：git 历史，判断 machine/acp-bridge/session.ts 何时消失（区分「S3 范围外既有红」vs「本版引入」）。
import { execFileSync } from 'node:child_process';

const git = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return `ERR ${e.message}`;
  }
};

console.log('== HEAD ==');
console.log(git(['log', '-1', '--format=%h %ad %s', '--date=short']));

for (const p of ['machine/acp-bridge/session.ts', 'machine/acp-bridge/session-map.ts', 'machine/acp-bridge/index.ts']) {
  console.log(`\n== ${p} ==`);
  const last = git(['log', '-1', '--format=%h|%ad|%s', '--date=short', '--', p]);
  console.log(last || '(无历史)');
}

console.log('\n== 被删除的文件里含 session.ts 的 ==');
console.log(git(['log', '--diff-filter=D', '--name-only', '--format=%h|%ad|%s', '--date=short', '--', 'machine/acp-bridge/']).split('\n').filter((l) => /session\.ts|^[0-9a-f]{7}\|/.test(l)).slice(0, 40).join('\n') || '(无)');

console.log('\n== 最近 8 次 commit ==');
console.log(git(['log', '--oneline', '-8']));
