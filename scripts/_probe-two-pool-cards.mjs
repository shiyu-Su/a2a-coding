// 只读：拉两张池卡的 requirement/plan，供合并可能性评估。
const ENGINE = process.env.ENGINE_BASE || 'http://127.0.0.1:3300';
const IDS = [
  ['63ecefc8-', '63ecefc8 引擎原语：超时节点可被「拆小」消解'],
  ['917514aa-', '917514aa 假完成处置 + 记录落点纪律'],
];
(async () => {
  const all = await (await fetch(`${ENGINE}/api/features`)).json();
  for (const [pre, label] of IDS) {
    const f = (all.features || []).find((x) => x.featureId.startsWith(pre));
    console.log(`\n########## ${label}`);
    if (!f) {
      console.log('  (未找到)');
      continue;
    }
    console.log(`id=${f.featureId}  state=${f.state}  stage=${f.stage}  version=${f.version || '(空)'}  approval=${f.approval}  parent=${f.parentFeatureId || '-'}`);
    console.log(`--- title: ${f.title}`);
    console.log(`--- requirement:\n${f.requirement}`);
    if (f.plan) console.log(`--- plan:\n${f.plan}`);
  }
})();
