// 只读：对每条失败断言，打印其在测试文件中的位置与上下文（供宿主逐条精确改锚）。
const path = require('path');
const base = path.join(__dirname, '..', '.omo', 'skills', 'regression-test');
const { readFileSync } = require('fs');

const FILES = {
  'test-v0.6.0-project-group.js': ['新增惰性样例键 _projectGroupExample', '样例键为**组数组**且每组含 members', '_comment 承载「组数组」口径', '_comment 仍承载 projectGroup 说明', '顶层键集合与预期一致（结构锁）'],
  'test-v0.7.0-runner-reverse.js': ['launcher.bridge 占位样例'],
  'test-v0.8.0-agent-kind-acp.js': ['qoder-cn 条目含 agentConfig.backendCmd', 'qoder-cn 条目含「可选覆盖」说明'],
  'test-v0.8.1-opencode-acp.js': ['opencode 条目含 agentConfig.backendCmd', 'opencode 条目说明把 backendCmd 标为可选覆盖'],
  'test-v0.8.2-acp-model.js': ['_modelComment 注记', '注记指向同目录 model-catalog', 'machine 侧口径三要素', '协议面链路', '明确不做项', '顶层平铺键', '真实 modelId', 'applyModel', 'configId:"model"'],
  'test-v0.8.4-key-layout.js': ['自消费键顶层平铺', '为平铺示例（段内无 model）', 'kind 扩展须先增补保留集'],
  'test-v0.8.5-codex-claude-acp.js': ['applyMode'],
  'test-v0.8.6-backend-entry.js': ['backendCmd` 为可选覆盖', 'backendCmd` 为可选覆盖（正面锚）'],
  'test-v0.8.10-concurrency.js': ['载明两把闸键'],
};

for (const [f, needles] of Object.entries(FILES)) {
  const src = readFileSync(path.join(base, 'tests', f), 'utf8');
  const lines = src.split(/\r?\n/);
  console.log(`\n########## ${f} (${lines.length} 行)`);
  const used = new Set();
  for (const n of needles) {
    lines.forEach((ln, i) => {
      if (!ln.includes(n)) return;
      const key = Math.floor(i / 12);
      if (used.has(key)) return;
      used.add(key);
      console.log(`  ---- 命中「${n}」@:${i + 1}，上下文 ${Math.max(0, i - 4) + 1}..${Math.min(lines.length, i + 9)}`);
      for (let k = Math.max(0, i - 4); k < Math.min(lines.length, i + 9); k++) {
        console.log(`  ${String(k + 1).padStart(5)} | ${lines[k].slice(0, 200)}`);
      }
    });
  }
}
