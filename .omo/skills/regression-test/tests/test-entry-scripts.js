// TC8: 入口脚本契约 — 运行构建产物，禁止 --experimental-strip-types 直跑 TS
const { report } = require('../lib/reporter');
const { readJson } = require('../lib/common');

const CHECKS = [
  { unit: 'orch', script: 'bridge', expected: /node\s+dist\/bridge\/index\.js/ },
  { unit: 'machine', script: 'launcher', expected: /node\s+dist\/launcher\/index\.js/ },
];

function run() {
  let ok = true;

  for (const { unit, script, expected } of CHECKS) {
    const pkg = readJson(`${unit}/package.json`);
    const cmd = pkg && pkg.scripts ? pkg.scripts[script] : null;
    const isStr = typeof cmd === 'string' && cmd.length > 0;

    ok = report(`${unit} scripts.${script} 存在`, isStr, isStr ? cmd : '缺失') && ok;
    ok = report(`${unit} scripts.${script} 运行构建产物（node dist/...）`, isStr && expected.test(cmd), isStr ? cmd : '') && ok;
    ok = report(`${unit} scripts.${script} 不使用 --experimental-strip-types`, isStr && !cmd.includes('--experimental-strip-types'), isStr ? '' : '缺失') && ok;
  }

  return ok;
}

module.exports = { run, name: '入口脚本契约' };
