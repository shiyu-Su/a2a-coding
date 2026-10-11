// 只读检索：找回「planlog」里遗留的「接入更多 agent 的前置改进项」。
// 范围限定非守卫区（doc/ · .omo/ · 根级文档）+ 全仓「文件名含 planlog」的清单；不读单元代码正文。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '.';
const SKIP = new Set(['node_modules', '.git', 'dist', '.data']);
const NAME_HITS = [];

function walk(dir, depth = 0) {
  if (depth > 6) return [];
  let ents = [];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, depth + 1));
    else {
      if (/planlog/i.test(e.name)) NAME_HITS.push(p);
      out.push(p);
    }
  }
  return out;
}

const all = walk(ROOT);
console.log(`== 文件名含 planlog 的（全仓，含守卫区只列名不读）==`);
console.log(NAME_HITS.length ? NAME_HITS.map((p) => '  ' + p).join('\n') : '  (无)');

// 只在这些前缀下读正文
const READ_PREFIXES = ['doc/', '.omo/'];
const READ_ROOT_FILES = ['README.md', 'CLAUDE.md', 'AGENTS.md', 'CHANGELOG.md', 'opencode.json.example'];
const NEEDLES = ['planlog', '接入更多', '更多 agent', '更多agent', '前置改进', '前置项'];

console.log(`\n== 正文命中（仅 doc/ · .omo/ · 根级文档）==`);
let hits = 0;
for (const p of all) {
  const p2 = p.replace(/\\/g, '/').replace(/^\.\//, '');
  const inScope = READ_PREFIXES.some((x) => p2.startsWith(x)) || READ_ROOT_FILES.includes(p2);
  if (!inScope) continue;
  if (!/\.(md|txt|json|json5|ya?ml)$/i.test(p2) && !/planlog/i.test(p2)) continue;
  let src;
  try {
    src = readFileSync(p, 'utf8');
  } catch {
    continue;
  }
  const lines = src.split(/\r?\n/);
  lines.forEach((ln, i) => {
    for (const n of NEEDLES) {
      if (ln.includes(n)) {
        console.log(`  [${n}] ${p2}:${i + 1}: ${ln.trim().slice(0, 180)}`);
        hits++;
        break;
      }
    }
  });
}
console.log(`\n命中合计 ${hits} 处`);

// 顺带：git 历史里被删除的 planlog 文件
import('node:child_process').then(({ execFileSync }) => {
  const git = (args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) {
      return `ERR ${e.message}`;
    }
  };
  console.log(`\n== git 历史：路径含 planlog 的文件 ==`);
  console.log(git(['log', '--all', '--diff-filter=AD', '--name-only', '--format=%h|%ad|%s', '--date=short', '--', '*planlog*']).split('\n').slice(0, 40).join('\n') || '(无)');
});
