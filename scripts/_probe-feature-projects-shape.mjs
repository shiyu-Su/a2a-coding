// 一次性只读探针：取引擎 GET /api/features/:id 的 projects[] 真实字段形状（键名 camel/snake 一手事实）
// 目的：R2 收敛里回给 board 一份真实样例（板侧无一手事实）。
const BASE = process.env.ENGINE_BASE || 'http://127.0.0.1:8787';
const ids = [
  ['25aa4b44-fc25-4254-b487-e452be0ec40f', '已归属(3)'],
  ['f2dcb141-a315-4c48-9c8d-ae5400cc18c8', '未归属'],
];
for (const [id, label] of ids) {
  const url = `${BASE}/api/features/${id}`;
  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    console.log(`--- ${label} ${id} → FETCH ERROR ${e.message}`);
    continue;
  }
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    console.log(`--- ${label} ${id} → status=${r.status} 非 JSON: ${text.slice(0, 200)}`);
    continue;
  }
  console.log(`--- ${label} ${id} status=${r.status}`);
  console.log('  顶层键:', Object.keys(j).join(', '));
  const projish = Object.keys(j).filter((k) => /project/i.test(k));
  console.log('  含 project 的顶层键:', projish.join(', ') || '(无)');
  console.log('  projects 键存在?', 'projects' in j, '| 值 =', JSON.stringify(j.projects));
  // 递归找 camelCase 与 snake_case 变体，确认引擎实际发的是哪一套
  const raw = JSON.stringify(j);
  for (const cand of ['projectId', 'project_id', 'releasedAt', 'released_at', 'ownerGroup', 'owner_group', 'repoId', 'repo_id']) {
    const n = raw.split(cand).length - 1;
    if (n > 0) console.log(`    命中 "${cand}" × ${n}`);
  }
}
