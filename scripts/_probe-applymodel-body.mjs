// 只读：看 applyModel 函数体内 value / configId 的真实字面。
import { readFileSync } from 'node:fs';
const s = readFileSync('machine/acp-bridge/acp/session.ts', 'utf8');
const body = (s.match(/private async applyModel\([\s\S]*?(?=private async applyMode\()/) || [''])[0];
console.log('body length =', body.length);
body.split(/\r?\n/).forEach((l, i) => {
  if (/value|configId|set_config_option/.test(l)) console.log(`${i + 1} | ${l.trim().slice(0, 180)}`);
});
