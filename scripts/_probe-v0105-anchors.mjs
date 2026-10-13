// 只读：发版前核验 —— 根回归涉及的关键字面（宿主自办）
import { readFileSync } from 'node:fs';
const show = (f, re, label) => {
  let src; try { src = readFileSync(f, 'utf8'); } catch { console.log(`(缺文件 ${f})`); return; }
  console.log(`\n=== ${label} :: ${f} ===`);
  src.split(/\r?\n/).forEach((l, i) => { if (re.test(l)) console.log(`${i + 1}: ${l.trim().slice(0, 200)}`); });
};

show('orch/types.ts', /DEFAULT_FEATURE_STAGE|DEFAULT_FEATURE_APPROVAL|FEATURE_STAGES|FEATURE_APPROVALS/, 'orch 登记字段闭集/缺省');
show('orch/bridge/feature-tools.ts', /需求分析|未发起|缺省|DEFAULT_FEATURE/, 'orch create 初值');
show('flow/spec/引擎映射.md', /主链|6 态|8 态|六态|八态/, '引擎映射 主链措辞');
show('flow/spec/需求流程.md', /规范版本戳/, '需求流程 戳');
show('flow/spec/引擎映射.md', /规范版本戳/, '引擎映射 戳');
show('flow/spec/文档模板.md', /规范版本戳/, '文档模板 戳');
show('flow/README.md', /规范版本戳|v0\.10\./, 'flow README 戳');
show('scripts/_seed-project-versions.mjs', /0\.1[0-9]\.[0-9]|v0\.1[0-9]\.[0-9]/, 'seed 脚本 pin');
show('scripts/_probe-spec-stamp-pin.mjs', /v0\.1[0-9]\.[0-9]/, 'stamp-pin 脚本 pin');
