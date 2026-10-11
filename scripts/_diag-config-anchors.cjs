// 一次性诊断（只读）：只跑与「配置模板拆分」相关的根回归文件，枚举 S3 待改锚清单。
const path = require('path');
const base = path.join(__dirname, '..', '.omo', 'skills', 'regression-test');
const { reset, getSummary } = require(path.join(base, 'lib', 'reporter'));

const FILES = [
  'test-config-samples.js',
  'test-v0.6.0-project-group.js',
  'test-v0.7.0-runner-reverse.js',
  'test-v0.8.0-agent-kind-acp.js',
  'test-v0.8.1-opencode-acp.js',
  'test-v0.8.2-acp-model.js',
  'test-v0.8.3-push-retire.js',
  'test-v0.8.4-key-layout.js',
  'test-v0.8.5-codex-claude-acp.js',
  'test-v0.8.6-backend-entry.js',
  'test-v0.8.7-task-durability.js',
  'test-v0.8.10-concurrency.js',
];

(async () => {
  reset();
  for (const f of FILES) {
    const p = path.join(base, 'tests', f);
    try {
      delete require.cache[require.resolve(p)];
      const mod = require(p);
      if (typeof mod.run === 'function') await mod.run();
    } catch (e) {
      console.log(`[LOAD/RUN ERROR] ${f}: ${e.message}`);
    }
  }
  const s = getSummary();
  console.log(`\n== 诊断汇总: 总计 ${s.total} | 通过 ${s.passed} | 失败 ${s.failed} ==`);
})();
