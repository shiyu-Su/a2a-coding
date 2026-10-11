// 一次性只读探针：三单元模板实物状态（判断 S1/S2 是否已落地 ⇒ 根回归旧锚是否已过期）。
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';

const DIRS = ['orch/config', 'machine/config', 'board/config'];
for (const d of DIRS) {
  console.log(`--- ${d}`);
  if (!existsSync(d)) {
    console.log('   (不存在)');
    continue;
  }
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = `${d}/${e.name}`;
    const st = statSync(p);
    let extra = '';
    try {
      const src = readFileSync(p, 'utf8');
      const lines = src.split(/\r?\n/).length;
      const commentKeys = (src.match(/"_[\w]+"\s*:/g) || []).length;
      const releasedVersions = src.includes('releasedVersions');
      const angle = /[<>]/.test(src);
      extra = ` lines=${lines} _keys=${commentKeys} hasReleasedVersions=${releasedVersions} hasAngle=${angle}`;
    } catch {
      /* ignore */
    }
    console.log(`   ${e.name} ${st.size}B${extra}`);
  }
}
