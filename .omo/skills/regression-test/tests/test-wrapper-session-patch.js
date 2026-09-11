// TC5: a2a-opencode 会话持久化补丁（patch-package）
const { report } = require('../lib/reporter');
const { exist, read, findFilesRecursive } = require('../lib/common');

const SESSION_MANAGER = 'machine/node_modules/a2a-opencode/dist/opencode/session-manager.js';

function run() {
  let ok = true;

  const patches = findFilesRecursive('machine/patches', n => /^a2a-opencode\+.*\.patch$/.test(n));
  ok = report(
    'machine/patches/ 存在 a2a-opencode+*.patch',
    patches.length > 0,
    patches.length > 0 ? patches.map(p => p.replace(/.*[\\/]/, '')).join(', ') : '缺失',
  ) && ok;

  if (!exist(SESSION_MANAGER)) {
    ok = report('会话补丁生效校验（session-manager.js）', true, 'node_modules 未安装，跳过') && ok;
    return ok;
  }

  const src = read(SESSION_MANAGER);
  ok = report('session-manager.js 含 loadPersisted（启动恢复会话）', src.includes('loadPersisted')) && ok;
  ok = report('session-manager.js 含 persist( 调用（变更落盘）', src.includes('persist(')) && ok;

  return ok;
}

module.exports = { run, name: 'a2a-opencode 会话持久化补丁' };
