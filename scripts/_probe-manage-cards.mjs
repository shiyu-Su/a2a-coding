// 只读探针 #2：逐 b-card 取文本前缀 + 打印「成员表」原始 HTML，判断去掉它会不会丢能力（增删成员）。
const BASE = process.env.BOARD_BASE || 'http://127.0.0.1:3400';
const ORG = process.env.ORG || 'a2a-coding';
const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const t = await (await fetch(`${BASE}/org/${ORG}/manage`)).text();
  const idx = [...t.matchAll(/<div class="b-card[^"]*"/g)].map((m) => m.index);
  console.log('=== 逐 b-card 文本前缀（截 120 字）===');
  idx.forEach((start, i) => {
    const end = i + 1 < idx.length ? idx[i + 1] : t.length;
    const seg = t.slice(start, end);
    console.log(`  #${i + 1}  len=${String(seg.length).padStart(6)}  ${strip(seg).slice(0, 120)}`);
  });

  // 成员表原始 HTML
  const tables = [...t.matchAll(/<table[\s\S]*?<\/table>/g)];
  console.log('\n=== 第 1 张表（成员表）原始 HTML ===');
  console.log(tables[0][0]);
  console.log('\n=== 该表所在 b-card 的原始 HTML（整块）===');
  const cs = idx[0];
  const ce = idx[1] || t.length;
  console.log(t.slice(cs, ce));
})();
