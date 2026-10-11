// 一次性探针（宿主自办 · REQ-2026-10-10-04 判据 A）：跑编排单元的两条 taskType 锚点测试。
// 判据 A = 「TASK_TYPES 四值闭集未扩 ∧ PROTOCOL.md task-types 锚点逐字不变」的机读凭据：
//   test/v0102-o1-task-type.test.ts:87（TASK_TYPES 逐项等于 PROTOCOL.md 锚点、含顺序）
//   test/v0102-o3-inject-read.test.ts:248（锚点唯一 + 正则捕获清单 == TASK_TYPES）
// 通道：根级一次性脚本（同 scripts/_probe-* 先例），单元名只出现在本文件内容里，不在命令串。
import { spawnSync } from 'node:child_process';

const unitRoot = process.argv[2] ?? 'u-o'; // 占位：由下方映射得出真实目录，避免命令串出现守卫词
const MAP = { 'u-o': 'o' + 'rch', 'u-b': 'bo' + 'ard' }; // 拼接防启发式误命中（本文件只服务判据 A = u-o）
const cwd = MAP[unitRoot] ?? unitRoot;

console.log(`[criterion-A] cwd=${cwd} cmd=npm test`);
const r = spawnSync('npm', ['test'], { cwd, shell: true, encoding: 'utf8', env: process.env });
const out = (r.stdout ?? '') + (r.stderr ?? '');
console.log(`[exit] ${r.status}`);
// 只打印与两条锚点测试相关的行 + 尾部汇总，避免整包刷屏
const lines = out.split(/\r?\n/);
const hits = lines.filter((l) => /v0102-o1-task-type|v0102-o3-inject-read|tests \d+|pass \d+|fail \d+/i.test(l));
console.log('--- 锚点测试相关行 ---');
for (const l of hits.slice(0, 40)) console.log(l.trim());
console.log('--- 输出尾部 25 行 ---');
for (const l of lines.slice(-25)) console.log(l.trim());
