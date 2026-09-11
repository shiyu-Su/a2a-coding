// TC6: trace 产物处理 — 源头关闭（生成配置）+ bridge 兜底过滤
const { report } = require('../lib/reporter');
const { exist, read } = require('../lib/common');

function run() {
  let ok = true;

  const bridge = 'orch/bridge/index.ts';
  ok = report(`${bridge} 存在`, exist(bridge)) && ok;
  const b = read(bridge);
  ok = report('bridge 含 isTraceArtifact（trace 兜底判定）', b.includes('isTraceArtifact')) && ok;
  ok = report('bridge 过滤 trace. 前缀产物', /startsWith\("trace\."\)/.test(b)) && ok;

  const agentConfig = 'machine/launcher/agent-config.ts';
  ok = report(`${agentConfig} 存在`, exist(agentConfig)) && ok;
  const a = read(agentConfig);
  ok = report('生成配置默认关闭 events 输出（enabled: false）', /events:\s*\{\s*enabled:\s*false\s*\}/.test(a)) && ok;

  return ok;
}

module.exports = { run, name: 'trace 产物处理（源头 + 兜底）' };
