// TC10: 文档收尾 — 改造文档修订历史 final + planlog 需求完成标记
const { report } = require('../lib/reporter');
const { read, exist, getVersion } = require('../lib/common');

function run() {
  let ok = true;

  const ver = getVersion();
  const verLabel = ver || 'unknown';
  ok = report('版本号可解析（根 package.json，回退 CHANGELOG）', typeof ver === 'string' && ver.length > 0, `v${verLabel}`) && ok;

  const doc = `doc/v${verLabel}/A2A最小闭环-改造文档.md`;
  ok = report(`doc/v${verLabel}/ 含改造文档`, exist(doc), doc) && ok;

  const docSrc = read(doc);
  ok = report('改造文档含「修订历史」', docSrc.includes('修订历史')) && ok;
  ok = report('修订历史含 final 行（用户测试通过）', /^\|\s*final\s*\|/mi.test(docSrc)) && ok;

  const planlog = read('planlog.md');
  const top = planlog.split(/\n---\n/)[0]; // 顶部版本待办区
  const released = top.includes(`v${verLabel}`) && /已发布/.test(top);
  const hasDone = /\|\s*✅\s*已完成\s*\|/.test(top);
  ok = report(
    'planlog 顶部反映当前版本状态（已发布 / 含 ✅ 已完成）',
    released || hasDone,
    released ? '已发布' : hasDone ? '含 ✅ 已完成' : '顶部未见发布/完成标记',
  ) && ok;

  return ok;
}

module.exports = { run, name: '文档收尾（final / planlog）' };
