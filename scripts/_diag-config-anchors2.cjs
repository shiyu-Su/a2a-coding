// 一次性诊断（只读）：逐文件跑，标出每个根回归文件的失败条数与失败名（定位 S3 真实面）。
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

const origLog = console.log;
(async () => {
  for (const f of FILES) {
    const p = path.join(base, 'tests', f);
    const fails = [];
    let total = 0;
    reset();
    console.log = (...a) => {
      const s = a.join(' ');
      if (s.includes('[FAIL]')) fails.push(s.replace(/^\[FAIL\]\s*/, ''));
      if (/^\[(PASS|FAIL)\]/.test(s)) total++;
    };
    try {
      const mod = require(p);
      if (typeof mod.run === 'function') await mod.run();
    } catch (e) {
      fails.push(`[LOAD/RUN ERROR] ${e.message}`);
    }
    console.log = origLog;
    const s = getSummary();
    origLog(`${f.padEnd(34)} 总计 ${String(total).padStart(4)} 通过 ${String(s.passed).padStart(4)} 失败 ${String(s.failed).padStart(3)}`);
    for (const x of fails.slice(0, 40)) origLog(`      ✗ ${x}`);
  }
})();
