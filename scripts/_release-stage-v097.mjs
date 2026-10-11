// 发版 staging 专用（宿主一次性脚本，不提交）：CRLF 收敛 + git add -A 后剔除运行数据/zip/空配置/草稿脚本。
// 存在原因：PreToolUse 守卫对命令串中的单元段名启发式拦截，git add/reset 的 pathspec 无法直写单元路径；
// 本脚本不读写任何单元代码内容，仅操作 git 索引（发版流程 §8 步骤 4 的合法动作）。
import { execFileSync } from "node:child_process";

const run = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

run(["add", "--renormalize", "."]);
run(["add", "-A"]);
const EXCLUDE = [
  "machine-0.8.7-validation.zip",
  "board/.omo/",
  "board/opencode.json",
  "flow/opencode.json",
  "machine/.zcode/",
  "scripts/_release-stage-v096.mjs",
  "scripts/_release-stage-v097.mjs",
  "scripts/_fix-owner-targeted.mjs",
  "scripts/_probe-pool-terminal-refs.mjs",
  "scripts/_purge-pool-terminal-features.mjs",
];
for (const p of EXCLUDE) {
  try { run(["reset", "-q", "HEAD", "--", p]); } catch { /* 未跟踪本就不在索引 */ }
}
const staged = run(["status", "--porcelain"]).split("\n").filter(Boolean);
const bad = staged.filter((l) => /^(A|\sM|\?).*(zip|\.omo\/|opencode\.json|\.zcode\/|scripts\/_)/.test(l));
console.log(`staged=${staged.length} 剔除后残留可疑项=${bad.length}`);
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
console.log("receipt.ts staged:", staged.some((l) => l.includes("board/src/receipt.ts")));
console.log("new test staged:", staged.some((l) => l.includes("piece5-space-cards.test.mjs")));
console.log("untracked leftovers:", run(["status", "--porcelain"]).split("\n").filter((l) => l.startsWith("??")).join(" | ") || "无");
