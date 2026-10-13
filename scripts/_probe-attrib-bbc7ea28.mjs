// 只读探针：主轨 eb86d5e8 与增补 bbc7ea28 的归属（projects）记录现状。
const E = process.env.ENGINE_BASE || 'http://127.0.0.1:3300';
const ids = [
  ['eb86d5e8-d9d0-4892-a870-27f41df82ec2', 'main  eb86d5e8'],
  ['bbc7ea28-ea0f-470e-80f0-4aea92ccea43', 'supp  bbc7ea28'],
];
for (const [id, l] of ids) {
  const j = await (await fetch(`${E}/api/features/${id}`)).json();
  const f = j.feature || {};
  console.log(`${l}  state=${f.state}  stage=${f.stage}  approval=${f.approval}  version=${f.version}`);
  console.log(`   projects(归属) = ${JSON.stringify(j.projects)}`);
}
const pv = await (await fetch(`${E}/api/project-versions`)).json();
const rows = pv.projectVersions || [];
console.log(`\n--- project-versions: ${rows.length} 行`);
for (const e of rows.filter((x) => x.project_id === 'orch' || (x.reason || '').includes('orch'))) {
  console.log(`   ${e.project_id}@${e.version} status=${e.status}`);
}
