// 一次性探针（宿主自办）：把三单元 README 里「配置」相关章节的正文打出来，核是否含「含义/默认值/示例」。
import { readFileSync } from 'node:fs';

const files = ['orch/README.md', 'machine/README.md', 'board/README.md'];

function levelOf(h) { const m = h.match(/^(#{1,6})\s/); return m ? m[1].length : 99; }

for (const f of files) {
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  console.log('\n\n################ ' + f + ' ################');
  lines.forEach((l, i) => {
    if (!/^#{1,4}\s/.test(l) || !l.includes('配置')) return;
    const lv = levelOf(l);
    console.log('\n---- ' + (i + 1) + ' ' + l.trim() + ' ----');
    let printed = 0;
    for (let j = i + 1; j < lines.length && printed < 34; j++) {
      const s = lines[j];
      if (/^#{1,4}\s/.test(s) && levelOf(s) <= lv) break;
      console.log((j + 1) + ': ' + s);
      printed++;
    }
  });
}
