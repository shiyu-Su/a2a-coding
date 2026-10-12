import { execSync } from "node:child_process";
import { statSync, existsSync } from "node:fs";
const f = "board/test/org-pool-refresh.test.mjs";
console.log("exists:", existsSync(f));
if (existsSync(f)) {
  const st = statSync(f);
  console.log("mtime:", st.mtime.toISOString(), "size:", st.size);
}
const gs = execSync("git status --porcelain -- board/test/", { encoding: "utf8" });
console.log("--- git status board/test ---\n" + gs);
const log = execSync(`git log --oneline -1 --format="%h %ad %s" --date=iso -- ${f} 2>/dev/null || echo NONE`, { encoding: "utf8" });
console.log("--- git log for file ---\n" + log);
