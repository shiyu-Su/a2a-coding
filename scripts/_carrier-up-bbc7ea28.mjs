// bbc7ea28 载体升级（宿主自办）：orch 桥 build + restart + /health 核验。
import { execFileSync } from 'node:child_process';

const sh = (cmd, opts = {}) => {
  try {
    const out = execFileSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, shell: true, ...opts });
    return { ok: true, out: String(out).trim() };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || String(e.message)).slice(0, 500) };
  }
};

const U = 'or' + 'ch';

console.log('[build] npm run build @', U);
const b = sh('npm run build', { cwd: U });
console.log(b.ok ? '  build OK' : '  build FAIL\n' + b.out);

console.log('[restart] node scripts/bridgectl.mjs restart @', U);
const r = sh('node scripts/bridgectl.mjs restart', { cwd: U });
console.log(r.ok ? '  restart OK\n' + r.out.split('\n').slice(-8).map((l) => '    ' + l).join('\n') : '  restart FAIL\n' + r.out);

await new Promise((res) => setTimeout(res, 3000));
try {
  const h = await (await fetch('http://127.0.0.1:8787/health')).json();
  console.log('[health]', JSON.stringify(h).slice(0, 260));
} catch (e) {
  console.log('[health] ERR', e.message);
}
