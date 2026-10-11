// v0.10.2 三载体升级（宿主自办）：build + 重启 + /health 行为核验（看版本串——本步核的就是版本串本身随构建翻新）。
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
  try { const r = await fetch(url); const j = await r.json(); return `${r.status} ${JSON.stringify(j).slice(0, 120)}`; }
  catch (e) { return `ERR ${e.message}`; }
};

console.log('══ ① board：build + restart ══');
console.log('  build:', sh('npm run build', { cwd: 'board' }).ok ? 'OK' : 'FAIL');
console.log('  restart:', sh('node scripts/boardctl.mjs restart', { cwd: 'board' }).out.split('\n').slice(-1)[0]);
await new Promise((r) => setTimeout(r, 3000));
console.log('  /health:', await health('http://127.0.0.1:3400/health'));

console.log('\n══ ② orch 桥：build + restart ══');
console.log('  build:', sh('npm run build', { cwd: 'orch' }).ok ? 'OK' : 'FAIL');
console.log('  restart:', sh('node scripts/bridgectl.mjs restart', { cwd: 'orch' }).out.split('\n').slice(-2).join(' | ').slice(0, 200));
await new Promise((r) => setTimeout(r, 4000));
console.log('  /health:', await health('http://127.0.0.1:8787/health'));

console.log('\n══ ③ machine Launcher：build + restart ══');
console.log('  build:', sh('npm run build', { cwd: 'machine' }).ok ? 'OK' : 'FAIL');
console.log('  restart:', sh('node scripts/launcherctl.mjs restart', { cwd: 'machine' }).out.split('\n').slice(-2).join(' | ').slice(0, 200));
await new Promise((r) => setTimeout(r, 6000));
console.log('  /health:', await health('http://127.0.0.1:3010/health'));
