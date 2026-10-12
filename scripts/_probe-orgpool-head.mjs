import { readFileSync } from "node:fs";
const s = readFileSync("board/test/org-pool-refresh.test.mjs", "utf8");
console.log(s.split("\n").slice(0, 40).join("\n"));
console.log("--- test( 条数:", (s.match(/^test\(/gm) || []).length);
console.log("--- 引用关键词:", ["c997a0bb", "c35b4192", "858e9e46", "REQ-2026-10-11"].map(k => k + "=" + (s.includes(k) ? "有" : "无")).join(" "));
