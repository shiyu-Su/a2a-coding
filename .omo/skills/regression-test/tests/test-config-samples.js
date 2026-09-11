// TC4: 配置样例 — orch 机器清单 + machine 启动器配置
// 被检路径为入库模板 config.json.default；若本地存在实际 config.json（git 忽略），一并校验其为合法 JSON
const { report } = require('../lib/reporter');
const { readJson, exist } = require('../lib/common');

function run() {
  let ok = true;

  // orch/config/config.json.default — 静态分布：机器清单（模板，入库）
  const machines = readJson('orch/config/config.json.default');
  const machinesActualBad = exist('orch/config/config.json') && readJson('orch/config/config.json') === null;
  ok = report('orch/config/config.json.default 存在且为合法 JSON', machines !== null && !machinesActualBad, machines === null ? '模板不存在或解析失败' : (machinesActualBad ? '本地 config.json 存在但解析失败' : '')) && ok;

  const machineList = machines && Array.isArray(machines.machines) ? machines.machines : null;
  ok = report('config.json.default 含非空 machines[]', Array.isArray(machineList) && machineList.length > 0, Array.isArray(machineList) ? `${machineList.length} 项` : '缺失') && ok;

  if (Array.isArray(machineList)) {
    const bad = machineList.filter(m => !m || typeof m.machineId !== 'string' || typeof m.launcherUrl !== 'string');
    ok = report('machines[] 每项含 machineId + launcherUrl', bad.length === 0, bad.length > 0 ? JSON.stringify(bad) : '') && ok;
  } else {
    ok = report('machines[] 每项含 machineId + launcherUrl', false, 'machines 缺失') && ok;
  }

  // machine/config/config.json.default — 本机绑定 + 项目清单（模板，入库）
  const launcher = readJson('machine/config/config.json.default');
  const launcherActualBad = exist('machine/config/config.json') && readJson('machine/config/config.json') === null;
  ok = report('machine/config/config.json.default 存在且为合法 JSON', launcher !== null && !launcherActualBad, launcher === null ? '模板不存在或解析失败' : (launcherActualBad ? '本地 config.json 存在但解析失败' : '')) && ok;

  const machineIdOk = !!(launcher && typeof launcher.machineId === 'string' && launcher.machineId.length > 0);
  ok = report('config.json.default 含 machineId', machineIdOk, machineIdOk ? launcher.machineId : '缺失') && ok;

  const port = launcher && launcher.launcher ? launcher.launcher.port : undefined;
  const portOk = typeof port === 'number' && port > 0;
  ok = report('config.json.default 含 launcher.port（数值）', portOk, portOk ? String(port) : '缺失') && ok;

  const projects = launcher && Array.isArray(launcher.projects) ? launcher.projects : null;
  ok = report('config.json.default 含非空 projects[]', Array.isArray(projects) && projects.length > 0, Array.isArray(projects) ? `${projects.length} 项` : '缺失') && ok;

  if (Array.isArray(projects)) {
    const bad = projects.filter(p =>
      !p || typeof p.projectId !== 'string' || typeof p.workspace !== 'string'
      || typeof p.agentKind !== 'string' || typeof p.a2aPort !== 'number');
    ok = report('projects[] 每项含 projectId/workspace/agentKind/a2aPort', bad.length === 0, bad.length > 0 ? JSON.stringify(bad) : '') && ok;
  } else {
    ok = report('projects[] 每项含 projectId/workspace/agentKind/a2aPort', false, 'projects 缺失') && ok;
  }

  return ok;
}

module.exports = { run, name: '配置样例（机器清单 / 启动器）' };
