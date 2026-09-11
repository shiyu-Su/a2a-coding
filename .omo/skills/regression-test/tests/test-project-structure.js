// TC1: 项目结构完整性 — a2a-coding
const { report } = require('../lib/reporter');
const { exist } = require('../lib/common');

const REQUIRED_FILES = [
  'package.json',
  'planlog.md',
  'CLAUDE.md',
  'doc/v0.1.0/A2A最小闭环-需求确认单.md',
  'doc/v0.1.0/A2A最小闭环-改造文档.md',
];

const REQUIRED_DIRS = [
  'orch',
  'machine',
];

function run() {
  let ok = true;
  for (const f of REQUIRED_FILES) {
    ok = report(`文件存在: ${f}`, exist(f)) && ok;
  }
  for (const d of REQUIRED_DIRS) {
    ok = report(`目录存在: ${d}/`, exist(d)) && ok;
  }
  return ok;
}

module.exports = { run, name: '项目结构完整性' };
