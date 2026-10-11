// 一次性只读探针：定位「GET feature 详情」的真实端点（board 报 :3300，而 /api/project-versions 在 :8787）。
const HOSTS = ['http://127.0.0.1:8787', 'http://127.0.0.1:3300'];
const ID = '25aa4b44-fc25-4254-b487-e452be0ec40f';
const PATHS = [
  `/api/features/${ID}`,
  `/api/feature/${ID}`,
  `/api/features?id=${ID}`,
  `/features/${ID}`,
  `/api/versions`,
  `/api/project-versions`,
];

for (const h of HOSTS) {
  for (const p of PATHS) {
    let line = '';
    try {
      const r = await fetch(h + p);
      const t = await r.text();
      let keys = '';
      try {
        const j = JSON.parse(t);
        keys = Array.isArray(j) ? `[array len ${j.length}]` : `keys=${Object.keys(j).slice(0, 14).join(',')}`;
        if (j && typeof j === 'object' && 'projects' in j) {
          keys += ` | projects=${JSON.stringify(j.projects)}`;
        }
      } catch {
        keys = `非JSON ${t.slice(0, 80).replace(/\n/g, ' ')}`;
      }
      line = `${r.status} ${keys}`;
    } catch (e) {
      line = `ERR ${e.message}`;
    }
    console.log(`${h}${p} → ${line}`);
  }
  console.log('');
}
