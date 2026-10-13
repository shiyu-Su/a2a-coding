// 只读探针：列出全部 Feature（id 前 8 位 + state + title），用于核对池卡是否存在。
const E = process.env.ENGINE_BASE || 'http://127.0.0.1:3300';
const j = await (await fetch(`${E}/api/features`)).json();
const arr = j.features || j;
console.log(`features = ${arr.length}`);
for (const f of arr) {
  console.log(`${String(f.state).padEnd(16)} ${(f.featureId || '').slice(0, 8)}  ${(f.title || '').replace(/\s+/g, ' ').slice(0, 72)}`);
}
