// 只读：S3 改锚前的最后四个事实。
const { readFileSync } = require('fs');
const has = (s, n) => s.split(n).length - 1;

// a. test-v0.6.0 的 helper
const v60 = readFileSync('.omo/skills/regression-test/tests/test-v0.6.0-project-group.js', 'utf8');
console.log('== v0.6.0 helpers ==');
for (const n of ["require('../lib/common')", 'read(', 'readJson(', 'body(']) console.log(`   ${n} × ${has(v60, n)}`);
console.log(v60.split(/\r?\n/).filter((l) => /const \{.*lib\.common|function (read|readJson|body)/.test(l)).slice(0, 4).join('\n'));

// b. machine/README 邻近度与其余 needle
const mr = readFileSync('machine/README.md', 'utf8');
console.log('\n== machine/README 其余 needle ==');
for (const n of ['--model', 'configId', 'resolveAcpModel', 'agentConfig.model', 'agentConfig"` 的 `model']) console.log(`   ${n} × ${has(mr, n)}`);
console.log(`   邻近正则 backendCmd↔可选覆盖(120字) = ${/backendCmd[\s\S]{0,120}可选覆盖|可选覆盖[\s\S]{0,120}backendCmd/.test(mr)}`);
console.log(`   邻近正则 backendCmd↔可选覆盖(300字) = ${/backendCmd[\s\S]{0,300}可选覆盖|可选覆盖[\s\S]{0,300}backendCmd/.test(mr)}`);
const i1 = mr.indexOf('可选覆盖');
console.log('   首个「可选覆盖」上下文:', JSON.stringify(mr.slice(Math.max(0, i1 - 160), i1 + 80)));

// c. .example 的 model 值
const me = JSON.parse(readFileSync('machine/config/config.json.example', 'utf8'));
for (const p of me.projects || []) console.log(`\n== .example ${p.projectId} (${p.agentKind}) model = ${JSON.stringify(p.agentConfig && p.agentConfig.model)} backendCmd = ${JSON.stringify(p.agentConfig && p.agentConfig.backendCmd)}`);
const cat = JSON.parse(readFileSync('machine/config/model-catalog.json', 'utf8'));
console.log('   catalog qoder-cn ids =', Object.keys(cat['qoder-cn'] || {}).join(','));

// d. test-v0.8.1 的未守卫 backendCmd 读取点
const v81 = readFileSync('.omo/skills/regression-test/tests/test-v0.8.1-opencode-acp.js', 'utf8');
const lines = v81.split(/\r?\n/);
console.log('\n== v0.8.1 内 backendCmd / agentConfig 出现行 ==');
lines.forEach((ln, i) => { if (/backendCmd|\.agentConfig/.test(ln)) console.log(`   :${i + 1} | ${ln.trim().slice(0, 190)}`); });
