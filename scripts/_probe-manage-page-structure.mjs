// 只读探针：解析「项目组管理页」的区块顺序 / 各表表头，回答「成员表 vs 项目表」究竟是什么、去掉哪一个会丢什么。
const BASE = process.env.BOARD_BASE || 'http://127.0.0.1:3400';
const ORG = process.env.ORG || 'a2a-coding';
const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

(async () => {
  const r = await fetch(`${BASE}/org/${ORG}/manage`);
  const t = await r.text();
  console.log(`GET /org/${ORG}/manage → ${r.status} len=${t.length}\n`);

  // 1) b-card 区块顺序 + 每块首个标题
  const cards = [...t.matchAll(/<div class="(b-card[^"]*)"/g)];
  console.log('=== 区块顺序（b-card）===');
  cards.forEach((m, i) => {
    const after = t.slice(m.index, m.index + 400);
    const h = after.match(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/);
    console.log(`  #${i + 1} class="${m[1]}"${h ? `  → ${h[1] ? 'h' + h[1] + ': ' : ''}${strip(h[2])}` : ''}`);
  });

  // 2) 所有表格的表头 + 行数
  const tables = [...t.matchAll(/<table[\s\S]*?<\/table>/g)];
  console.log(`\n=== 表格共 ${tables.length} 张 ===`);
  tables.forEach((m, i) => {
    const ths = [...m[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => strip(x[1]));
    const trs = (m[0].match(/<tr/g) || []).length;
    const at = t.slice(0, m.index).split('<div class="b-card').length - 1;
    console.log(`  表#${i + 1}（位于第 ${at} 个 b-card 内） 行数=${trs}`);
    console.log(`     表头: ${ths.join(' | ') || '(无 th)'}`);
  });

  // 3) 关键词命中：成员增删能力在哪
  console.log('\n=== 成员/增删能力相关关键词 ===');
  for (const k of ['成员', '加成员', '删成员', '移除', '拖拽', 'member-pool', 'b-meta-row', '已发布的最新版本号']) {
    console.log(`  「${k}」×${t.split(k).length - 1}`);
  }
})();
