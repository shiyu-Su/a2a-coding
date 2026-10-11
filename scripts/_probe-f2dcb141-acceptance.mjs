// 宿主侧验收探针（只读 HTTP）：直连板进程核 f2dcb141 的三条行为判据 + 载体现状。
const BOARD = process.env.BOARD_BASE || 'http://127.0.0.1:3400';
const ORG = process.env.ORG || 'a2a-coding';
const FEAT = '25aa4b44-fc25-4254-b487-e452be0ec40f'; // 已归属 3 行，用于验归属卡

const get = async (p) => {
  try {
    const r = await fetch(BOARD + p, { redirect: 'manual' });
    const t = await r.text();
    return { status: r.status, body: t };
  } catch (e) {
    return { status: 0, body: `ERR ${e.message}` };
  }
};
const count = (s, needle) => s.split(needle).length - 1;

(async () => {
  console.log(`BOARD=${BOARD} ORG=${ORG}\n`);

  const h = await get('/health');
  console.log(`[health] status=${h.status} body=${h.body.slice(0, 200).replace(/\n/g, ' ')}`);

  const manage = await get(`/org/${ORG}/manage`);
  console.log(`\n[① 管理页] /org/${ORG}/manage status=${manage.status} len=${manage.body.length}`);
  console.log(`   新列字面「已发布的最新版本号」命中 = ${count(manage.body, '已发布的最新版本号')}`);
  console.log(`   管理页是否出现根因码前缀 project_versions_ = ${count(manage.body, 'project_versions_')}`);
  console.log(`   含「配置核对」= ${count(manage.body, '配置核对')}  「三源」= ${count(manage.body, '三源')}`);

  const sched = await get(`/org/${ORG}/schedule`);
  console.log(`\n[② 排期页] /org/${ORG}/schedule status=${sched.status} len=${sched.body.length}`);
  for (const n of ['pv-block', 'pvbadge', '各 project 版本', 'project_versions_']) {
    console.log(`   禁项「${n}」命中 = ${count(sched.body, n)}  ${count(sched.body, n) === 0 ? '(零处 ✓)' : '(应为 0 ✗)'}`);
  }
  console.log(`   Group 面仍在？ 含「已发版」= ${count(sched.body, '已发版')}`);

  const det = await get(`/features/${FEAT}`);
  console.log(`\n[③ 需求详情] /features/${FEAT.slice(0, 8)} status=${det.status} len=${det.body.length}`);
  for (const n of ['projectId', 'version', '0.10.2', 'feat-side', '归属']) {
    console.log(`   「${n}」命中 = ${count(det.body, n)}`);
  }
  const i = det.body.indexOf('feat-side');
  if (i >= 0) console.log(`   feat-side 后 500 字窗口:\n${det.body.slice(i, i + 500).replace(/\s+/g, ' ')}`);
})();
