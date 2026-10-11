#!/usr/bin/env node
// v0.10.3 一次性脚本（第 2 行）：为 a2a-coding 组建 project 版本行。
// 依据：PjM 版本规划评估（Feature 5b980baf 节点 1a55deac）结论——
//   board 落 Project Version 0.10.3（裸 semver 不带 v，与 Group 列车数值对齐）；
//   (a2a-coding, board, 0.10.3) 行现读不存在（board 仅 0.10.1/0.10.2 released）。
// 先例：scripts/_seed-project-versions.mjs（v0.10.1）/ _create-v0103-version-row.mjs（flow 行）。
// 用法：node scripts/_create-v0103-version-row-2.mjs [--apply]
const BASE = process.env.ENGINE_BASE ?? 'http://127.0.0.1:8787';
const ORG = 'a2a-coding';
const WANT = [{ projectId: 'board', version: '0.10.3' }];
const apply = process.argv.includes('--apply');

async function call(url, init) {
  const r = await fetch(url, init);
  const t = await r.text();
  let body; try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body };
}
const summarize = (rows) => (rows ?? []).map((x) => `${x.project_id}@${x.version}:${x.status}`).join(', ');

const before = await call(`${BASE}/api/project-versions?owner_group=${ORG}`);
console.log(`[before] http=${before.status} count=${before.body?.count} => ${summarize(before.body?.projectVersions)}`);
for (const w of WANT) {
  if (!apply) { console.log(`[dry-run] would POST ${w.projectId} version=${w.version}`); continue; }
  const res = await call(`${BASE}/api/project-versions?owner_group=${ORG}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(w),
  });
  console.log(`[POST] ${w.projectId} ${w.version} => http=${res.status} body=${JSON.stringify(res.body).slice(0, 320)}`);
}
const after = await call(`${BASE}/api/project-versions?owner_group=${ORG}`);
console.log(`[after] http=${after.status} count=${after.body?.count}`);
for (const x of after.body?.projectVersions ?? []) {
  if (x.project_id === 'board' || x.project_id === 'flow') console.log(`    ${x.project_id} ${x.version} status=${x.status}`);
}
