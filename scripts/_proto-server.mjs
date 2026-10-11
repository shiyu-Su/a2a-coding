// 一次性静态服务（宿主通道）：为 doc/v0.10.3/ 下的原型 HTML 提供本机预览。
// 用法：node scripts/_proto-server.mjs   （Ctrl+C 停止；仅 loopback）
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = 'doc/v0.10.3';
const PORT = 3456;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = p === '/' ? 'proto-detail-v1.html' : p.slice(1);
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(normalize(ROOT))) { res.statusCode = 403; res.end('forbidden'); return; }
    const body = await readFile(file);
    res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404; res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[proto] http://127.0.0.1:${PORT}/  (root=${ROOT})`));
