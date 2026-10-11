// 定位需求详情页「归属卡」实体（打印 projectId 每次出现处的上下文）。
const BASE = process.env.BOARD_BASE || 'http://127.0.0.1:3400';
const FEATS = [
  ['25aa4b44-fc25-4254-b487-e452be0ec40f', '已归属 3 行'],
  ['f2dcb141-a315-4c48-9c8d-ae5400cc18c8', '已归属 1 行'],
];
(async () => {
  for (const [id, label] of FEATS) {
    const r = await fetch(`${BASE}/features/${id}`);
    const t = await r.text();
    console.log(`\n===== ${label} /features/${id.slice(0, 8)} status=${r.status} len=${t.length}`);
    let from = 0;
    let n = 0;
    while (n < 6) {
      const i = t.indexOf('projectId', from);
      if (i < 0) break;
      n++;
      console.log(`--- 命中#${n} @${i}: ...${t.slice(Math.max(0, i - 220), i + 260).replace(/\s+/g, ' ')}...`);
      from = i + 9;
    }
    if (n === 0) console.log('  (无 projectId 命中)');
    // 空态文案（未归属卡用）
    const emptyText = '（暂无 project 归属记录）';
    console.log(`  空态文案「${emptyText}」命中 = ${t.split(emptyText).length - 1}`);
  }
})();
