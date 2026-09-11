// TC2: 两个部署单元（orch / machine）各自自包含
// 每单元独立 package.json / tsconfig.json / node_modules / dist
const { report } = require('../lib/reporter');
const { exist, readJson } = require('../lib/common');

const UNITS = [
  { dir: 'orch', scripts: ['bridge', 'build', 'typecheck'] },
  { dir: 'machine', scripts: ['launcher', 'build', 'typecheck'] },
];

function run() {
  let ok = true;

  for (const unit of UNITS) {
    for (const f of ['package.json', 'tsconfig.json']) {
      const rel = `${unit.dir}/${f}`;
      const json = readJson(rel);
      ok = report(`${rel} 存在且为合法 JSON`, json !== null, json === null ? '不存在或解析失败' : '') && ok;
    }

    const pkg = readJson(`${unit.dir}/package.json`) || {};
    const scripts = pkg.scripts || {};
    for (const s of unit.scripts) {
      const cmd = scripts[s];
      ok = report(`${unit.dir}/package.json 含 scripts.${s}`, typeof cmd === 'string' && cmd.length > 0, typeof cmd === 'string' ? cmd : '缺失') && ok;
    }

    for (const d of ['node_modules', 'dist']) {
      ok = report(`${unit.dir}/${d}/ 存在（单元自包含）`, exist(`${unit.dir}/${d}`)) && ok;
    }
  }

  const mpkg = readJson('machine/package.json') || {};
  const hasPostinstall = !!(mpkg.scripts && mpkg.scripts.postinstall === 'patch-package');
  ok = report('machine/package.json 含 "postinstall": "patch-package"', hasPostinstall, hasPostinstall ? '' : '缺失') && ok;
  const hasPatchDep = !!(mpkg.devDependencies && mpkg.devDependencies['patch-package']);
  ok = report('machine/package.json devDependencies 声明 patch-package', hasPatchDep, hasPatchDep ? '' : '缺失') && ok;

  return ok;
}

module.exports = { run, name: '单元自包含（orch / machine）' };
