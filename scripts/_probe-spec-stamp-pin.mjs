// 只读：定位「文档模板.md 规范版本戳」pin 的位置与上下文。
import { readdirSync, readFileSync } from 'node:fs';
const DIR = '.omo/skills/regression-test/tests';
for (const f of readdirSync(DIR)) {
  if (!/^test-.*\.js$/.test(f)) continue;
  const lines = readFileSync(`${DIR}/${f}`, 'utf8').split(/\r?\n/);
  lines.forEach((ln, i) => {
    if (ln.includes('规范版本戳')) console.log(`${f}:${i + 1} | ${ln.trim().slice(0, 220)}`);
  });
}
