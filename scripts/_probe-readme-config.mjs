// 一次性探针（宿主自办）：核三单元 README 是否有「配置块 / 配置项」的说明。
import { readFileSync, existsSync } from 'node:fs';

const files = ['orch/README.md', 'machine/README.md', 'board/README.md', 'README.md'];
const needles = ['配置项', '默认值', '填写示例', '不同 Agent', 'agentKind', 'agentConfig', 'config.json.example', 'config.json.default'];

for (const f of files) {
  if (!existsSync(f)) { console.log('\n== ' + f + ' == 缺失'); continue; }
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  console.log('\n== ' + f + ' == 共 ' + lines.length + ' 行');

  const heads = [];
  lines.forEach((l, i) => { if (/^#{1,4}\s/.test(l) && l.includes('配置')) heads.push((i + 1) + ': ' + l.trim()); });
  console.log('  含「配置」的标题 ' + heads.length + ' 条:');
  for (const h of heads) console.log('    ' + h);

  const counts = needles.map((n) => n + '=' + lines.filter((l) => l.includes(n)).length).join('  ');
  console.log('  关键词命中: ' + counts);
}
