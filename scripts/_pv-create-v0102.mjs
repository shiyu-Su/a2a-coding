// 一次性运维脚本（宿主自办）：为 25aa4b44 的三单元建 Project Version（先建版，后写归属）。
import { readFileSync } from 'node:fs';

const URL = 'http://127.0.0.1:8787/api/project-versions';
const rows = [
  { owner_group: 'a2a-coding', project_id: 'orch', version: '0.10.2' },
  { owner_group: 'a2a-coding', project_id: 'machine', version: '0.10.2' },
  { owner_group: 'a2a-coding', project_id: 'board', version: '0.10.2' },
];

for (const body of rows) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  console.log('POST ' + body.project_id + ' ' + body.version + ' -> ' + r.status + ' ' + txt.slice(0, 300));
}

// 建版后回读，确认三行都在（owner_group + project_id + version）
const g = await fetch(URL, { method: 'GET' });
const gt = await g.text();
console.log('\nGET /api/project-versions -> ' + g.status);
try {
  const j = JSON.parse(gt);
  const list = j.projectVersions ?? j.items ?? j.rows ?? j;
  console.log(JSON.stringify(list, null, 1).slice(0, 1500));
} catch {
  console.log(gt.slice(0, 1500));
}
