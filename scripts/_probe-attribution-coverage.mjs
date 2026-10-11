// 只读探针：核对「各需求 ↔ 各 project 版本」归属记录的实际覆盖面（回答 4d7cf009 为何无归属）。
const ENGINE = process.env.ENGINE_BASE || 'http://127.0.0.1:3300';

(async () => {
  // 1) 全量：features + attributionsByFeature
  const all = await (await fetch(`${ENGINE}/api/features`)).json();
  const feats = all.features || [];
  const map = all.attributionsByFeature || {};
  console.log(`features=${feats.length}  attributionsByFeature 键数=${Object.keys(map).length}\n`);

  console.log('=== 有归属记录的需求 ===');
  for (const f of feats) {
    const a = map[f.featureId];
    if (a && a.length) {
      console.log(`  ${f.featureId.slice(0, 8)} [${f.state}] ver=${f.version || '-'} → ${a.map((x) => x.projectId + '@' + x.version).join(', ')}  · ${String(f.title).slice(0, 32)}`);
    }
  }
  console.log('\n=== 无归属记录的需求（含 4d7cf009）===');
  for (const f of feats) {
    const a = map[f.featureId];
    if (!a || !a.length) {
      console.log(`  ${f.featureId.slice(0, 8)} [${f.state}] stage=${f.stage} ver=${f.version || '(空)'} appr=${f.approval} · ${String(f.title).slice(0, 40)}`);
    }
  }

  // 2) 4d7cf009 单看
  const id = '4d7cf009-72d9-45c3-96a6-66f9fb96b296';
  const d = await (await fetch(`${ENGINE}/api/features/${id}`)).json();
  console.log(`\n=== 4d7cf009 详情 ===`);
  console.log(`  state=${d.feature && d.feature.state} stage=${d.feature && d.feature.stage} version=${d.feature && d.feature.version} approval=${d.feature && d.feature.approval}`);
  console.log(`  projects = ${JSON.stringify(d.projects)}`);
  console.log(`  tasks = ${(d.tasks || []).length} 个`);

  // 3) project 版本台账
  const pv = await (await fetch(`${ENGINE}/api/project-versions`)).json();
  console.log(`\n=== project 版本台账（count=${pv.count}）===`);
  for (const e of pv.projectVersions || []) {
    console.log(`  ${e.org || pv.ownerGroup} / ${e.projectId} / ${e.version} / status=${e.status} / releasable=${e.releasable} / reason=${e.reason || '-'}`);
  }
})();
