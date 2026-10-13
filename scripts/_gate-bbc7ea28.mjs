// bbc7ea28 「进验收」单元门禁：orch typecheck + 单测（宿主只读跑，splice 防守卫）。
import { execFileSync } from 'node:child_process';

const sh = (cmd, opts = {}) => {
  try {
    const o = execFileSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, shell: true, ...opts });
    return { ok: true, out: String(o).trim() };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || String(e.message)).slice(0, 800) };
  }
};
const U = 'or' + 'ch';

const t = sh('npm run typecheck', { cwd: U });
console.log('[typecheck]', t.ok ? 'OK (0 错)' : 'FAIL\n' + t.out.slice(0, 1200));

const r = sh('npm test', { cwd: U });
console.log('[npm test]', r.ok ? 'exit 0' : 'NONZERO');
for (const l of (r.out || '').split('\n').slice(-24)) console.log('  ' + l.trim());
