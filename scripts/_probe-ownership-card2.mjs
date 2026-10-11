// 正确的归属卡标记探针：卡实体 = <h2>归属（project 版本）</h2> + dl.b-meta 的 b-meta-row 行。
const BASE = process.env.BOARD_BASE || 'http://127.0.0.1:3400';
const ENGINE = process.env.ENGINE_BASE || 'http://127.0.0.1:3300';
const FEATS = [
  ['25aa4b44-fc25-4254-b487-e452be0ec40f', '期望 3 行'],
  ['f2dcb141-a315-4c48-9c8d-ae5400cc18c8', '期望 1 行'],
  ['7521c5a9-ebb5-49c4-84f1-ed45dd16011c', '期望 0 行 + 中性文案（pool 卡）'],
];
for (const [id, label] of FEATS) {
  const e = await (await fetch(`${ENGINE}/api/features/${id}`)).json();
  const b = await fetch(`${BASE}/features/${id}`);
  const t = await b.text();
  const head = t.indexOf('归属（project 版本）');
  const rows = (t.match(/b-meta-row/g) || []).length;
  console.log(`\n[${label}] ${id.slice(0, 8)}  board.status=${b.status}`);
  console.log(`   引擎 projects = ${JSON.stringify(e.projects)}`);
  console.log(`   归属卡标题命中 index = ${head}  ·  全页 b-meta-row = ${rows}`);
  if (head >= 0) console.log(`   → ${t.slice(head, head + 400).replace(/\s+/g, ' ')}`);
}
