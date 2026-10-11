// 校验：增补 39248358 的归属是否已写、board 版行计数是否随之上升。
const ENGINE = process.env.ENGINE_BASE || 'http://127.0.0.1:3300';
const TARGET = process.env.PROJECT_ID || 'board';
const FEATS = [
  ['39248358-cd0e-4d84-b84e-73289ae27477', '增补 39248358'],
  ['f2dcb141-a315-4c48-9c8d-ae5400cc18c8', '主轨 f2dcb141'],
];
for (const [id, label] of FEATS) {
  const j = await (await fetch(`${ENGINE}/api/features/${id}`)).json();
  console.log(`${label}  state=${j.feature.state}  stage=${j.feature.stage}  approval=${j.feature.approval}`);
  console.log(`   projects = ${JSON.stringify(j.projects)}`);
}
const pv = await (await fetch(`${ENGINE}/api/project-versions`)).json();
const rows = pv.projectVersions || [];
console.log(`\n--- /api/project-versions 返回 ${rows.length} 行；首行键 = ${rows.length ? Object.keys(rows[0]).join(', ') : '(空)'}`);
console.log(`首行原样 = ${JSON.stringify(rows[0] || null)}`);
// 项目标识可能在别的字段名里 ⇒ 同时按 reason 文本匹配兜底
console.log(`\n--- 含 ${TARGET} 的版行：`);
for (const e of rows) {
  const hit = JSON.stringify(e).includes(`"${TARGET}"`) || JSON.stringify(e).includes(`project_id="${TARGET}"`);
  if (hit) console.log(`   版本 ${e.version} status=${e.status} releasable=${e.releasable}\n      ${(e.reason || '').slice(0, 140)}`);
}
