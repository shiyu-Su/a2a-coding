import { readFileSync } from "node:fs";
const views = readFileSync("board/src/web/views.ts", "utf8");
const lines = views.split("\n");

console.log("== data-live-interval 出现的行（含行号）==");
lines.forEach((l, i) => { if (l.includes("data-live-interval")) console.log(`${i + 1}: ${l.trim().slice(0, 160)}`); });

console.log("\n== 过滤卡 form 标签相关行 ==");
lines.forEach((l, i) => { if (/<form/i.test(l)) console.log(`${i + 1}: ${l.trim().slice(0, 160)}`); });

console.log("\n== liveSlot/壳 helper 定义行 ==");
lines.forEach((l, i) => { if (/liveSlot|live-slot|renderLiveBar/.test(l)) console.log(`${i + 1}: ${l.trim().slice(0, 160)}`); });
