// 只读：S3 改锚前的事实钥匙 —— 三单元模板当前键集 + README/.example 内接应字面的在位情况。
import { readFileSync, existsSync } from 'node:fs';

const j = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return { __err: e.message }; }
};
const has = (s, n) => s.split(n).length - 1;

console.log('== orch/config/config.json.default 顶层键 ==');
const od = j('orch/config/config.json.default');
console.log('  ', od.__err ? `ERR ${od.__err}` : Object.keys(od).join(', '));
console.log('== orch/config/config.json.example 顶层键 ==');
const oe = j('orch/config/config.json.example');
console.log('  ', oe.__err ? `ERR ${oe.__err}` : Object.keys(oe).join(', '));

console.log('\n== machine/config/config.json.default ==');
const md = j('machine/config/config.json.default');
if (md.__err) console.log('  ERR', md.__err);
else {
  console.log('   顶层键:', Object.keys(md).join(', '));
  for (const p of md.projects || []) {
    console.log(`   project ${p.projectId} kind=${p.agentKind} agentConfig键=${p.agentConfig ? Object.keys(p.agentConfig).join(',') : '(无)'}`);
  }
}
console.log('== machine/config/config.json.example ==');
const me = j('machine/config/config.json.example');
if (me.__err) console.log('  ERR', me.__err);
else {
  console.log('   顶层键:', Object.keys(me).join(', '));
  for (const p of me.projects || []) {
    console.log(`   project ${p.projectId} kind=${p.agentKind} agentConfig键=${p.agentConfig ? Object.keys(p.agentConfig).join(',') : '(无)'}`);
  }
}
const meRaw = existsSync('machine/config/config.json.example') ? readFileSync('machine/config/config.json.example', 'utf8') : '';
const mdRaw = existsSync('machine/config/config.json.default') ? readFileSync('machine/config/config.json.default', 'utf8') : '';
console.log('\n== machine .example 内关键literal ==');
for (const n of ['bridge', 'backendCmd', '可选覆盖', 'model', 'maxConcurrentWrites', 'maxConcurrentReads', '_modelComment', '自消费键顶层平铺', '须先增补保留平铺键名清单', 'model-catalog']) {
  console.log(`   ${n} × ${has(meRaw, n)}`);
}
console.log('== machine .default 内关键literal ==');
for (const n of ['bridge', 'backendCmd', '自消费键顶层平铺', '须先增补保留平铺键名清单', 'maxConcurrentWrites', 'opencode-go/']) {
  console.log(`   ${n} × ${has(mdRaw, n)}`);
}

console.log('\n== machine/README.md 接应字面 ==');
const mr = readFileSync('machine/README.md', 'utf8');
for (const n of ['backendCmd', '可选覆盖', 'model-catalog.json', 'machine 侧不校验', '后端用自身默认', 'effort', 'set_config_option', '须先增补保留平铺键名清单', '自消费键顶层平铺', 'agentConfig.<kind>.model', 'maxConcurrentWrites']) {
  console.log(`   ${n} × ${has(mr, n)}`);
}
console.log('\n== orch/README.md 接应字面 ==');
const orr = readFileSync('orch/README.md', 'utf8');
for (const n of ['组数组', 'members', 'group_identity_required', '全量接纳', 'projectGroup']) {
  console.log(`   ${n} × ${has(orr, n)}`);
}
console.log('\n== 根 .gitignore :14-22 ==');
const gi = readFileSync('.gitignore', 'utf8').split(/\r?\n/);
for (let k = 13; k < 22 && k < gi.length; k++) console.log(`  ${k + 1} | ${gi[k]}`);
