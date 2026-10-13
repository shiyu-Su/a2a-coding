// 只读探针：列出增补 bbc7ea28 的 DAG 节点状态，定位 input-required 节点。
const E = process.env.ENGINE_BASE || 'http://127.0.0.1:3300';
const j = await (await fetch(`${E}/api/features/bbc7ea28-ea0f-470e-80f0-4aea92ccea43`)).json();
console.log(`feature.state = ${j.feature?.state}`);
const ts = j.tasks || [];
console.log(`tasks = ${ts.length}`);
for (const t of ts) {
  console.log(`[${t.state}] ${t.projectId}  ${t.taskId}  taskType=${t.taskType}  retry=${t.retryCount} fk=${t.failureKind}`);
  console.log(`     ${(t.prompt || '').replace(/\s+/g, ' ').slice(0, 120)}`);
}
