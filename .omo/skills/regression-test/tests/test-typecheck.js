// TC9: 两单元类型检查（tsc --noEmit，不启动任何服务）
const path = require('path');
const { execSync } = require('child_process');
const { report } = require('../lib/reporter');
const { ROOT, exist } = require('../lib/common');

const UNITS = ['orch', 'machine'];
const TIMEOUT_MS = 180000;

function runTypecheck(unit) {
  if (!exist(`${unit}/node_modules`)) {
    return { ok: false, detail: `${unit}/node_modules 缺失，请先在 ${unit}/ 执行 npm install` };
  }
  try {
    execSync('npm run typecheck', {
      cwd: path.join(ROOT, unit),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
      encoding: 'utf8',
    });
    return { ok: true, detail: 'tsc --noEmit 通过' };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim();
    const tail = (out || e.message || '').split('\n').slice(-3).join(' / ');
    return { ok: false, detail: tail };
  }
}

function run() {
  let ok = true;
  for (const unit of UNITS) {
    const r = runTypecheck(unit);
    ok = report(`${unit}/ npm run typecheck`, r.ok, r.detail) && ok;
  }
  return ok;
}

module.exports = { run, name: 'TypeScript 类型检查（两单元）' };
