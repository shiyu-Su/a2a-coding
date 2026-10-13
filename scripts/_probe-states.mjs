// 只读：打印状态机数组 + 扫描宿主侧文件里的旧句式
import { readFileSync } from 'node:fs';
const mod = await import('../orch/feature/state-machine.ts');
console.log('FEATURE_STATES  =', JSON.stringify(mod.FEATURE_STATES));
console.log('FEATURE_MAIN_CHAIN =', JSON.stringify(mod.FEATURE_MAIN_CHAIN));
console.log('TERMINAL_FEATURE_STATES =', JSON.stringify(mod.TERMINAL_FEATURE_STATES));

console.log('\n--- 宿主侧候选文件中的旧句式扫描 ---');
const pats = [
  [/缺省\s*`?stage=`?改造方案/, 'create 缺省 stage=改造方案（应为初值恒定 需求分析）'],
  [/stage\?\s*,\s*version\?/, 'create 签名仍列 stage?（应已不收）'],
  [/append\s*语义/, 'decisions append 语义（实为整值替换）'],
  [/6\s*态|六态/, '主链 6 态（应为 8 态）'],
  [/9\s*主态/, '9 主态（主链实为 8）'],
  [/不看\s*`stage`/, 'approve 不看 stage（已被 ⑤ 推翻）'],
];
for (const f of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.template.md', 'PROTOCOL.md', 'opencode.json.example']) {
  let src; try { src = readFileSync(f, 'utf8'); } catch { continue; }
  const lines = src.split(/\r?\n/);
  lines.forEach((l, i) => {
    for (const [re, why] of pats) if (re.test(l)) console.log(`${f}:${i + 1}  [${why}]  ${l.trim().slice(0, 150)}`);
  });
}
