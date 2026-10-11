// v0.10.1 发版 staging（宿主一次性脚本，不提交）：git add -A 后剔除运行数据 / zip / 空配置 / 一次性脚本，
// 并做「按兼容契约分组」的版本闸断言（本版：根 + orch + board = 0.10.1；machine 保持 0.9.8；协议仍 2.3）。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

run(["add", "-A"]);
const EXCLUDE = [
  ".data/",
  "machine-0.8.7-validation.zip",
  "board/.omo/",
  "board/opencode.json",
  "flow/opencode.json",
  "machine/.zcode/",
  "scripts/_export-board-ledger.mjs",
  "scripts/_fix-owner-targeted.mjs",
  "scripts/_fix-v010-version-tag.mjs",
  "scripts/_probe-pool-terminal-refs.mjs",
  "scripts/_purge-pool-terminal-features.mjs",
  "scripts/_seed-project-versions.mjs",
  "scripts/_release-bump-v0101.mjs",
  "scripts/_release-stage-v096.mjs",
  "scripts/_release-stage-v097.mjs",
  "scripts/_release-stage-v098.mjs",
  "scripts/_release-stage-v0100.mjs",
  "scripts/_release-stage-v0101.mjs",
  "scripts/_release-commit-v0100.mjs",
  "scripts/_release-mark-v0100.mjs",
  "scripts/_release-msg-v098.txt",
  "scripts/_release-msg-v0100.txt",
];
for (const p of EXCLUDE) {
  try { run(["reset", "-q", "HEAD", "--", p]); } catch { /* 未跟踪本就不在索引 */ }
}

const staged = run(["status", "--porcelain"]).split("\n").filter(Boolean);
const bad = staged.filter((l) => /^(A|\sM|RM|M |MM|R )/.test(l) && /(zip|\.omo\/|[/\\]opencode\.json|\.zcode\/|_release-|_fix-|_probe-pool|_purge-pool|_seed-project|^A  \.data)/.test(l));
console.log(`staged=${staged.length}  剔除后残留可疑项=${bad.length}`);
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }

// ── 版本闸（按兼容契约分组 · 第二次实操）──
const ver = (p) => JSON.parse(readFileSync(p, "utf8")).version;
const lockPkg = (p) => JSON.parse(readFileSync(p, "utf8")).packages?.[""]?.version;
const expect = [
  ["package.json（根列车号）", ver("package.json"), "0.10.1"],
  ["orch/package.json", ver("orch/package.json"), "0.10.1"],
  ["orch/package-lock.json 顶层", ver("orch/package-lock.json"), "0.10.1"],
  ['orch/package-lock.json packages[""]', lockPkg("orch/package-lock.json"), "0.10.1"],
  ["board/package.json", ver("board/package.json"), "0.10.1"],
  ["board/package-lock.json 顶层", ver("board/package-lock.json"), "0.10.1"],
  ['board/package-lock.json packages[""]', lockPkg("board/package-lock.json"), "0.10.1"],
  ["machine/package.json（本版不升）", ver("machine/package.json"), "0.9.8"],
  ["machine/package-lock.json 顶层（本版不升）", ver("machine/package-lock.json"), "0.9.8"],
  ['machine/package-lock.json packages[""]（本版不升）', lockPkg("machine/package-lock.json"), "0.9.8"],
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
    "board/test/v0101-engine-project-versions-parse.test.mjs",
    "board/test/v0101-views-project-versions-block.test.mjs",
    "board/src/versions-write.ts",
    "flow/spec/需求流程.md",
    "instruction-doc/v0.10.1-版本下沉project-改造文档.md",
  ]
    .map((n) => `${n.split("/").pop()}=${staged.some((l) => l.includes(n))}`)
    .join(" "));
console.log("untracked leftovers:", run(["status", "--porcelain"]).split("\n").filter((l) => l.startsWith("??")).join(" | ") || "无");
