// TC7: 空闲回收（用完退出）+ 桥轮询期租约续约
const { report } = require('../lib/reporter');
const { exist, read } = require('../lib/common');

function run() {
  let ok = true;

  const manager = 'machine/launcher/manager.ts';
  ok = report(`${manager} 存在`, exist(manager)) && ok;
  const m = read(manager);
  ok = report('manager 含 idleStopMs（空闲阈值可配）', m.includes('idleStopMs')) && ok;
  ok = report('manager 含 resetIdleTimer（每次调用重置计时）', m.includes('resetIdleTimer')) && ok;
  ok = report('manager 含「空闲超时」回收日志', m.includes('空闲超时')) && ok;

  const bridge = 'orch/bridge/index.ts';
  const b = read(bridge);
  ok = report('bridge 含 LEASE_RENEW_INTERVAL_MS（续约间隔）', b.includes('LEASE_RENEW_INTERVAL_MS')) && ok;
  ok = report('bridge 轮询期 renew 回调（续约租约）', /renew\?\s*:\s*\(\s*\)\s*=>\s*Promise<void>/.test(b)) && ok;

  return ok;
}

module.exports = { run, name: '空闲回收与租约续约' };
