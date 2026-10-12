#!/usr/bin/env node
// _serve-doc.mjs — 一次性静态文件服务（宿主原型/对照稿预览用；只读，不写任何状态/文件）。
// 用法：node scripts/_serve-doc.mjs [<dir>] [<port>]   （缺省 dir=doc/v0.10.4, port=3457）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ?? "doc/v0.10.4";
const port = Number(process.argv[3] ?? 3457);
const base = path.resolve(process.cwd(), root);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let fp = path.resolve(base, "." + urlPath);
    if (fp !== base && !fp.startsWith(base + path.sep)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    fs.stat(fp, (err, st) => {
      if (!err && st.isDirectory()) fp = path.join(fp, "index.html");
      fs.readFile(fp, (e, buf) => {
        if (e) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("not found");
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(fp).toLowerCase()] ?? "application/octet-stream" });
        res.end(buf);
      });
    });
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`serving ${base} at http://127.0.0.1:${port}/`);
  });
