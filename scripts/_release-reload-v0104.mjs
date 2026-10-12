// v0.10.4 载体升级（宿主自办，本版仅 board 触达）：build + 重启 + /health 行为核验（版本串随构建翻新）。
import { execFileSync } from 'node:child_process';

const sh = (cmd, opts = {}) => {
  const [c, ...args] = cmd.split(' ');
  try {
    const out = execFileSync(c, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, ...opts });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || String(e.message)).slice(0, 400) };
  }
};
const health = async (url) => {
  try { const r = await fetch(url); const j = await r.json(); return `${r.status} ${JSON.stringify(j).slice(0, 160)}`; }
  catch (e) { return `ERR ${e.message}`; }
};

console.log('══ board：build + restart ══');
const b = sh('npm run build', { cwd: 'board' });
console.log('  build:', b.ok ? 'OK' : 'FAIL\n' + b.out);
console.log('  restart:', sh('node scripts/boardctl.mjs restart', { cwd: 'board' }).out.split('\n').slice(-1)[0]);
await new Promise((r) => setTimeout(r, 3000));
console.log('  /health:', await health('http://127.0.0.1:3400/health'));

console.log('\n══ orch / machine：本版零触达 ⇒ 不动（只报现状对齐）══');
console.log('  orch /health:', await health('http://127.0.0.1:8787/health'));
console.log('  machine /health:', await health('http://127.0.0.1:3010/health'));
