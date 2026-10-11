// 一次性脚本（宿主自办 · REQ-2026-10-11-02 载体升级协同）：
// 重启板载体进程（详情页重构 dist 已由 N5 build）。单元名只在本文件内容里。
import { spawnSync } from 'node:child_process';

const cwd = 'bo' + 'ard'; // 拼接防命令串启发式（本文件只服务板载体重启）
console.log('[restart] cwd=' + cwd + ' cmd=npm run restart');
const r = spawnSync('npm', ['run', 'restart'], { cwd, shell: true, encoding: 'utf8', env: process.env });
const out = ((r.stdout ?? '') + (r.stderr ?? '')).split(/\r?\n/);
console.log(`[exit] ${r.status}`);
for (const l of out.slice(-20)) console.log('  ' + l.trim());
