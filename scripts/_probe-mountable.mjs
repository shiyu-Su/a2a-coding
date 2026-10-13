// 只读：核 flow spec 中 approve/挂载门相关的新措辞（发版门用）
import { readFileSync } from 'node:fs';
for (const f of ['flow/spec/引擎映射.md', 'flow/spec/需求流程.md']) {
  console.log(`\n=== ${f} ===`);
  readFileSync(f, 'utf8').split(/\r?\n/).forEach((l, i) => {
    if (/唯一准入|approval_required|绕门|挂载白名单|MOUNTABLE|都被拒|改动\s*`?state`?/.test(l)) {
      console.log(`${i + 1}: ${l.trim().slice(0, 220)}`);
    }
  });
}
console.log('\n=== orch register-tools.ts MOUNTABLE ===');
readFileSync('orch/bridge/register-tools.ts', 'utf8').split(/\r?\n/).forEach((l, i) => {
  if (/MOUNTABLE_FEATURE_STATES/.test(l)) console.log(`${i + 1}: ${l.trim().slice(0, 200)}`);
});
