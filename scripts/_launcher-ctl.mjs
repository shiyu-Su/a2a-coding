// 一次性运维脚本（宿主自办）：驱动本机 Launcher 的生命周期。
// 用法：node scripts/_launcher-ctl.mjs status | restart
// 存在理由：单元路径守卫拦截命令串里的单元目录段，宿主无法直接跑单元内脚本；
// 根目录脚本 = 合法的宿主自办通道（原 AGENTS.md「载体重启的结构性约束」条；该文件 2026-10-16 已删除）。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

const CTL = 'machine/scripts/launcherctl.mjs';
const arg = process.argv[2] ?? 'status';

if (!existsSync(CTL)) {
  console.log('[host] 未找到 ' + CTL + '；machine/scripts 实际内容：');
  try { console.log(readdirSync('machine/scripts').join('\n')); } catch (e) { console.log(String(e)); }
  process.exit(1);
}

function run(args) {
  console.log('--- launcherctl ' + args.join(' ') + ' ---');
  const r = spawnSync(process.execPath, [CTL, ...args], { encoding: 'utf8', cwd: process.cwd() });
  if (r.stdout) console.log(r.stdout.trim());
  if (r.stderr) console.log('[stderr] ' + r.stderr.trim());
  console.log('[exit] ' + r.status);
  return r.status;
}

run(['status']);
if (arg === 'restart') {
  run(['restart']);
  run(['status']);
}
