// 增补 39248358 的宿主侧验收探针（直连板，独立复验四条判据）。
const BASE = process.env.BOARD_BASE || 'http://127.0.0.1:3400';
const ORG = process.env.ORG || 'a2a-coding';
const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const count = (s, n) => s.split(n).length - 1;

(async () => {
  const h = await fetch(`${BASE}/health`);
  console.log(`[health] ${h.status} ${ (await h.text()).slice(0, 120) }`);

  const r = await fetch(`${BASE}/org/${ORG}/manage`);
  const t = await r.text();
  console.log(`\n[判据① 首卡=项目卡]  GET /org/${ORG}/manage → ${r.status} len=${t.length}`);
  const i = t.indexOf('<div class="b-card');
  const head = t.slice(i, i + 300);
  console.log(`   首个 b-card 片段: ${strip(head).slice(0, 120)}`);
  console.log(`   ⤷ b-card-h 以「项目」开头 = ${strip(head).startsWith('项目') || strip(head).includes('项目 运行态') ? '✓' : '✗'}`);
  console.log(`   新列「已发布的最新版本号」命中 = ${count(t, '已发布的最新版本号')}`);

  console.log(`\n[判据② 删卡负锚]  「成员（声明态」命中 = ${count(t, '成员（声明态')}  ${count(t, '成员（声明态') === 0 ? '(零处 ✓)' : '(应为 0 ✗)'}`);
  console.log(`   「成员区」命中 = ${count(t, '成员区')}`);
  console.log(`   「未声明」档字面命中（本组已声明有成员，应为 0）= ${count(t, 'projectGroup</code> 段尚无名为')}`);

  console.log(`\n[判据③ 写面照常]  「加 / 删项目」= ${count(t, '加 / 删项目')} · member-pool = ${count(t, 'member-pool')} · 加成员表单 = ${count(t, '加成员')} · 删成员表单 = ${count(t, '删成员')} · 末位拒写口径 = ${count(t, 'board_last_member_remove')}`);

  console.log(`\n[判据④ 其余卡面]  配置核对（三源）= ${count(t, '声明面成员（3300')} / ${count(t, '运行态项目（逐组')} / ${count(t, '引擎版本台账投影')} · 需求简表 = ${count(t, '引擎态')} · agent 配置卡 = ${count(t, 'setHostAgent')} · 停用卡 = ${count(t, '停用本组织')}`);

  // 区块顺序
  const idx = [...t.matchAll(/<div class="b-card[^"]*"/g)].map((m) => m.index);
  console.log(`\n[区块顺序]  共 ${idx.length} 张卡；首卡片段如上；第 2 卡片段: ${strip(t.slice(idx[1], idx[1] + 200)).slice(0, 80)}`);
})();
