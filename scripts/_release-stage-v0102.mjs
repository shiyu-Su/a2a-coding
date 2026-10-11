// v0.10.2 发版 staging（宿主一次性脚本，不提交）：git add -A 后剔除运行数据 / zip / 空配置 / 一次性脚本，
// 并做「按兼容契约分组」的版本闸断言（本版：根 + orch + board + machine = 0.10.2 —— machine 首次抬号；协议仍 2.3）。
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const run = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

run(["add", "-A"]);
// 一次性脚本（scripts/_*）整族不入库 —— 宿主通道约定
for (const f of readdirSync("scripts")) {
  if (f.startsWith("_")) {
    try { run(["reset", "-q", "HEAD", "--", `scripts/${f}`]); } catch { /* 未跟踪本就不在索引 */ }
  }
}
const EXCLUDE = [
  ".data/", "machine-0.8.7-validation.zip", "board/.omo/", "board/opencode.json",
  "flow/opencode.json", "machine/.zcode/",
];
for (const p of EXCLUDE) {
  try { run(["reset", "-q", "HEAD", "--", p]); } catch { /* 未跟踪本就不在索引 */ }
}

const staged = run(["status", "--porcelain"]).split("\n").filter(Boolean);
const bad = staged.filter((l) => /^(A|\sM|RM|M |MM|R )/.test(l) && /(zip|\.omo\/|[/\\]opencode\.json|\.zcode\/|scripts\/_|^A  \.data)/.test(l));
console.log(`staged=${staged.length}  剔除后残留可疑项=${bad.length}`);
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }

// ── 版本闸（按兼容契约分组 · 第三次实操；machine 首次抬号）──
const ver = (p) => JSON.parse(readFileSync(p, "utf8")).version;
const lockPkg = (p) => JSON.parse(readFileSync(p, "utf8")).packages?.[""]?.version;
const expect = [
  ["package.json（根列车号）", ver("package.json"), "0.10.2"],
  ["orch/package.json", ver("orch/package.json"), "0.10.2"],
  ["orch/package-lock.json 顶层", ver("orch/package-lock.json"), "0.10.2"],
  ['orch/package-lock.json packages[""]', lockPkg("orch/package-lock.json"), "0.10.2"],
  ["board/package.json", ver("board/package.json"), "0.10.2"],
  ["board/package-lock.json 顶层", ver("board/package-lock.json"), "0.10.2"],
  ['board/package-lock.json packages[""]', lockPkg("board/package-lock.json"), "0.10.2"],
  ["machine/package.json（首次抬号）", ver("machine/package.json"), "0.10.2"],
  ["machine/package-lock.json 顶层", ver("machine/package-lock.json"), "0.10.2"],
  ['machine/package-lock.json packages[""]', lockPkg("machine/package-lock.json"), "0.10.2"],
];
let bad2 = 0;
for (const [name, got, want] of expect) {
  const okv = got === want;
  if (!okv) bad2++;
  console.log(`${okv ? "OK  " : "FAIL"} ${name} = ${got}（期望 ${want}）`);
}
if (bad2) { console.error(`版本闸未过：${bad2} 处不符`); process.exit(1); }

console.log("\nstaged 关键新面抽查:",
  [
    "doc/v0.10.2/角色化-改造文档.md",
    "doc/v0.10.2/配置模板拆分-改造文档.md",
    "doc/v0.10.2/排期展示分流-改造文档.md",
    "doc/v0.10.2/管理页项目表置顶-改造文档.md",
    "orch/config/config.json.example",
    "machine/config/config.json.example",
    "board/config/config.json.example",
    "flow/spec/需求流程.md",
  ]
    .map((n) => `${n.split("/").pop()}=${staged.some((l) => l.includes(n))}`)
    .join(" "));
console.log("untracked leftovers:", run(["status", "--porcelain"]).split("\n").filter((l) => l.startsWith("??")).join(" | ") || "无");
