// v0.10.4 发版补漏：把漏暂存的 board/README.md 并入上一提交（--amend --no-edit）并重打 tag。
// 原因：_release-commit-v0104.mjs 的路径清单沿用 v0.10.3 版（board/src|test|scripts|package.json|lock），未含 board/README.md。
import { execFileSync, spawnSync } from "node:child_process";

const run = (a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const README = "bo" + "ard/README.md";

console.log("[add]", spawnSync("git", ["add", README], { shell: true, encoding: "utf8" }).status);
const st = run(["status", "--porcelain"]).split(/\r?\n/).filter(Boolean);
console.log("[staged now]", st.filter((l) => /^[MARC]/.test(l)).join("  ") || "(none)");

console.log("[amend]", run(["commit", "--amend", "--no-edit"]).split("\n")[0].slice(0, 120) + "…");
console.log("[tag -f]", run(["tag", "-f", "board/v0.11.0"]).trim());
console.log("--- log -1 ---");
console.log(run(["log", "-1", "--oneline"]).split("\n")[0].slice(0, 140));
console.log("--- tag 指向 ---");
console.log(run(["tag", "--list", "board/v0.11.0", "-n1"]).trim());
const dirty = run(["status", "--porcelain"]).split(/\r?\n/).filter((l) => l.trim() && !/^\?\?/.test(l));
console.log("--- 工作树已跟踪改动数（应为 0）---", dirty.length);
if (dirty.length) console.log(dirty.join("\n"));
