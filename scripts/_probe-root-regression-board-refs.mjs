// 一次性只读探针：根回归套件是否锚了 board 侧的测试文件名 / 测试枚举面。
// 目的：回答 board 提出的板外事实问题（退役 board 测试文件是否有根侧枚举阻塞）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2] || '.omo/skills/regression-test';

const NEEDLES = [
  'v0101-views-project-versions-block',
  'v0101-server-project-block-wiring',
  'v0101-server-projection-two-tier',
  'n3-regression-anchors',
  'piece5-space-cards',
  'versions-columns',
  'org-portal',
  'host-model-passthrough-reconcile',
];

function walk(dir, out = []) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(m?js|ts|cjs|json|md)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
console.log(`扫描根: ${ROOT} · 文件数 ${files.length}`);

let needleHits = 0;
let enumHits = 0;
for (const f of files) {
  let src;
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const lines = src.split(/\r?\n/);
  lines.forEach((ln, i) => {
    for (const n of NEEDLES) {
      if (ln.includes(n)) {
        console.log(`[NEEDLE ${n}] ${f}:${i + 1}: ${ln.trim().slice(0, 160)}`);
        needleHits++;
      }
    }
    // 测试文件枚举面：出现 board/...test 或 test 目录 glob 的迹象
    if (/(board)[\\/](test|scripts)/i.test(ln) || /(test)[\\/]\*\.test\./i.test(ln) || /\bboard\/test\b/i.test(ln)) {
      console.log(`[ENUM] ${f}:${i + 1}: ${ln.trim().slice(0, 160)}`);
      enumHits++;
    }
  });
}
console.log(`\n汇总：NEEDLE 命中 ${needleHits} 处 · 枚举面疑似命中 ${enumHits} 处`);

// 另：该套件自身是否有 「board npm test」/ 「单元测试文件清单」 之类
console.log('\n--- 目录顶层文件 ---');
try {
  for (const e of readdirSync(ROOT, { withFileTypes: true })) {
    console.log(`  ${e.isDirectory() ? 'd' : 'f'} ${e.name}`);
  }
} catch (e) {
  console.log('  读不到:', e.message);
}
