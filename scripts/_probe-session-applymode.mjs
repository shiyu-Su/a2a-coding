// 一次性只读探针：判断 applyModel / applyMode 断言的失败是「真缺口」还是「探针假象」。
import { existsSync, readFileSync } from 'node:fs';

const cands = [
  'machine/acp-bridge/session.ts',
  'machine/acp-bridge/index.ts',
  'machine/acp-bridge/outcome.ts',
];
const KEYS = ['applyModel', 'applyMode', 'configId', 'set_config_option', 'this.model', 'systemPromptMode', 'roles'];
for (const p of cands) {
  console.log(`--- ${p} ${existsSync(p) ? '' : '(缺失)'}`);
  if (!existsSync(p)) continue;
  const s = readFileSync(p, 'utf8');
  console.log(`   lines=${s.split(/\r?\n/).length} bytes=${s.length}`);
  for (const k of KEYS) console.log(`   contains ${k} = ${s.includes(k)}`);
}
