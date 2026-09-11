// 测试报告模块 — a2a-coding
const fs = require('fs');
const path = require('path');
const { ROOT, getVersion } = require('./common');

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const results = [];
let passed = 0;
let failed = 0;

/**
 * 记录一条测试结果
 * @param {string} name - 测试名称
 * @param {boolean} ok - 是否通过
 * @param {string} [detail] - 附加说明
 * @returns {boolean} ok
 */
function report(name, ok, detail) {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name}${detail ? ' | ' + detail : ''}`);
  results.push({ name, ok, detail: detail || '' });
  if (ok) passed++; else failed++;
  return ok;
}

/** 获取汇总数据 */
function getSummary() {
  return { total: results.length, passed, failed, results };
}

/** 重置所有状态（用于多次执行场景） */
function reset() {
  results.length = 0;
  passed = 0;
  failed = 0;
}

/** 写入结构化 JSON 报告到 reports/v{version}/regression-report.json */
function writeReport() {
  const ver = getVersion();
  const reportData = {
    project: 'a2a-coding',
    version: ver || 'unknown',
    timestamp: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    results: results.map(r => ({ ...r })),
  };
  const reportsDir = path.resolve(ROOT, 'reports', `v${ver || 'unknown'}`);
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, 'regression-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
  console.log(`报告已写入: ${reportPath}`);
}

module.exports = { report, getSummary, reset, writeReport };
