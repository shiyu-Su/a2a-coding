// 一次性探针（宿主自办）：读 machine Launcher 日志尾部，核 M1 守卫是否出声。
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

const p = 'machine/.a2a/logs/launcher.log';
const fd = openSync(p, 'r');
const size = fstatSync(fd).size;
const len = Math.min(size, 3 * 1024 * 1024);
const buf = Buffer.alloc(len);
readSync(fd, buf, 0, len, size - len);
closeSync(fd);

const lines = buf.toString('utf8').split(/\r?\n/);
console.log('log size=' + size + '  tail lines=' + lines.length);

const hits = lines.filter((l) => l.includes('同会话换职责位'));
console.log('=== 命中「同会话换职责位」: ' + hits.length + ' 条 ===');
for (const l of hits.slice(-10)) console.log('  ' + l.trim());

console.log('=== tail 22 ===');
const tail = lines.slice(-22);
for (let i = 0; i < tail.length; i++) console.log('  ' + tail[i].trim());
