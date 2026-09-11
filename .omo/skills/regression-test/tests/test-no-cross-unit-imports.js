// TC3: 单元间无交叉 import — orch 不得 import machine，machine 不得 import orch
// 仅匹配 import/from 语句的模块说明符；先剥掉注释，忽略注释中的路径提及。
const path = require('path');
const { report } = require('../lib/reporter');
const { ROOT, read, findFilesRecursive } = require('../lib/common');

/** 去掉块注释与整行行注释，避免注释中的路径造成误报 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 提取所有 import / from / import() 的模块说明符 */
function importSpecifiers(src) {
  const specs = [];
  const re = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) specs.push(m[1]);
  return specs;
}

/** 扫描单元下所有 .ts（跳过 node_modules/点目录/dist），返回跨单元引用清单 */
function scan(unitDir, forbiddenRe) {
  const files = findFilesRecursive(unitDir, n => n.endsWith('.ts'))
    .filter(p => !/[\\/]dist[\\/]/.test(p));
  const offenders = [];
  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    const specs = importSpecifiers(stripComments(read(rel)));
    for (const s of specs) {
      if (forbiddenRe.test(s)) offenders.push(`${rel} → ${s}`);
    }
  }
  return { count: files.length, offenders };
}

function run() {
  let ok = true;

  const checks = [
    { dir: 'orch', forbiddenRe: /machine\//, label: 'orch 不得 import machine 单元' },
    { dir: 'machine', forbiddenRe: /orch\//, label: 'machine 不得 import orch 单元' },
  ];

  for (const { dir, forbiddenRe, label } of checks) {
    const { count, offenders } = scan(dir, forbiddenRe);
    ok = report(
      `${label}（扫描 ${count} 个 .ts）`,
      count > 0 && offenders.length === 0,
      offenders.length > 0 ? offenders.join('; ') : '无跨单元引用',
    ) && ok;
  }

  return ok;
}

module.exports = { run, name: '单元间无交叉 import' };
