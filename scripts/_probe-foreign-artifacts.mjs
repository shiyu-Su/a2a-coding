import { execSync } from "node:child_process";
import { statSync, readdirSync } from "node:fs";

const gs = execSync("git status --porcelain", { encoding: "utf8" }).trim().split("\n");
console.log("== 工作树改动（含未跟踪）==");
for (const line of gs) {
  const p = line.slice(3).trim();
  let mt = "";
  try { mt = statSync(p).mtime.toISOString().slice(11, 19); } catch { mt = "(dir)"; }
  console.log(`${line.slice(0, 2)}  ${mt}  ${p}`);
}
console.log("\n== doc/v0.10.4 目录 ==");
try { for (const f of readdirSync("doc/v0.10.4")) console.log("  ", f); } catch (e) { console.log("  (无)", e.message); }
console.log("\n== 含「项目池」字样的最近文件（board/ + doc/）==");
try {
  const out = execSync(`grep -rl "项目池手动刷新" board doc 2>/dev/null | head -20`, { encoding: "utf8" });
  console.log(out || "  (无)");
} catch { console.log("  (grep 无命中或失败)"); }
