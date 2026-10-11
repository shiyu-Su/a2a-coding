// v0.10.2 发版文档入库（宿主交付活）：doc/ 整树 gitignored ⇒ 按 v0.10.1 先例搬 instruction-doc/<版本>/ 并 force-add。
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';

const SRC = 'doc/v0.10.2';
const DST = 'instruction-doc/v0.10.2';
mkdirSync(DST, { recursive: true });
const files = readdirSync(SRC).filter((f) => f.endsWith('.md'));
for (const f of files) copyFileSync(`${SRC}/${f}`, `${DST}/${f}`);
console.log('copied:', files.join('  '));
execFileSync('git', ['add', '-f', DST], { stdio: ['ignore', 'pipe', 'inherit'] });
const staged = execFileSync('git', ['status', '--porcelain', '--', DST], { encoding: 'utf8' }).trim();
console.log('\nstaged:\n' + staged);
