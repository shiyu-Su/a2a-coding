#!/usr/bin/env node
// a2a-coding — 回归测试入口
// 自动发现并执行 tests/ 下所有顶层 test-*.js（支持 async run）
// 版本源：根 package.json 的 version（回退 CHANGELOG.md）

const fs = require('fs');
const path = require('path');
const { reset, getSummary, writeReport } = require('./lib/reporter');
const { getVersion } = require('./lib/common');

const testDir = path.join(__dirname, 'tests');

// 顺序加载并执行（async run 会被 await）
async function runAll(testFiles) {
  for (const file of testFiles) {
    const mod = require(path.join(testDir, file));
    if (typeof mod.run === 'function') {
      await mod.run();
    }
  }
}

async function main() {
  const ver = getVersion();
  console.log(`a2a-coding 回归测试 v${ver || 'unknown'}`);
  console.log('时间: ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));

  reset();

  // 仅发现 tests/ 顶层的 test-*.js（不进入子目录）
  const testFiles = fs.readdirSync(testDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.startsWith('test-') && e.name.endsWith('.js'))
    .map(e => e.name)
    .sort();

  await runAll(testFiles);

  // 汇总
  const summary = getSummary();
  console.log('\n==============================');
  console.log('总计: ' + summary.total + '  |  通过: ' + summary.passed + '  |  失败: ' + summary.failed);
  console.log('==============================');

  writeReport();

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('回归测试执行异常:', e);
  process.exit(1);
});
