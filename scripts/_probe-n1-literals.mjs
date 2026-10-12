import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const read = (p) => readFileSync(p, "utf8");
const views = read("board/src/web/views.ts");
const n3 = read("board/test/n3-regression-anchors.test.mjs");
const sp = read("board/test/schedule-page.test.mjs");
const w6 = read("board/test/w6-new-version-entry.test.mjs");
const count = (s, needle) => s.split(needle).length - 1;

const checks = [];
const ck = (name, ok, detail) => checks.push({ name, ok, detail });

ck("LIVE_INTERVALS 常量在场", views.includes("LIVE_INTERVALS"), "");
ck("data-live= 出现次数 >= 8", count(views, "data-live=") >= 8, `count=${count(views, "data-live=")}`);
ck("锚 key 集合 8 枚", ["sched-board","steps","turn-prog","turn","graph","exec","tasks-filter","tasks-result"].every(k => views.includes(`data-live="${k}"`)), "");
ck("renderLiveBar helper 在场", views.includes("renderLiveBar"), "");
ck("live-slot 恒在壳", views.includes("live-slot"), "");
ck("data-live-interval 恰 3 处代码", count(views, "data-live-interval") === 3, `count=${count(views, "data-live-interval")}`);
ck("三档周期字面量 30000/15000/15000", views.includes("30000") && views.includes("15000"), "");
ck("过滤卡 <form> 标签未动", views.includes('<form method="get" action="/tasks"'), "");
ck("3 条 needle 已前缀化（去尾 >）", n3.includes('"schedule-board"') && !/id="schedule-board">/.test(n3) && !/id="schedule-board">/.test(sp) && !/id="schedule-board">/.test(w6), "");

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  [" + c.detail + "]" : ""}`);
const allPass = checks.every(c => c.ok);

console.log("\n== 门禁：board 全量 npm test ==");
const r = spawnSync("npm", ["test"], { cwd: "board", encoding: "utf8", shell: true, timeout: 480000 });
const out = (r.stdout || "") + (r.stderr || "");
const m = out.match(/pass (\d+)/i), f = out.match(/fail (\d+)/i);
console.log(m ? `tests pass=${m[1]}${f ? ` fail=${f[1]}` : ""}` : out.slice(-1500));
console.log(allPass && (!f || Number(f[1]) === 0) ? "\n== N1 判据：成立（活已干完，缺回执）==" : "\n== N1 判据：不成立（有缺口，见上）==");
