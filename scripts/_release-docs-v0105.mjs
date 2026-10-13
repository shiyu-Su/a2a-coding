// v0.10.5 发版文档入库（宿主交付活）：doc/ 整树 gitignored ⇒ 搬 instruction-doc/v0.10.5/ 并 force-add。
// 只搬 doc/v0.10.5/*.md（html 原型不搬）。
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";

const SRC = "doc/v0.10.5";
const DST = "instruction-doc/v0.10.5";
mkdirSync(DST, { recursive: true });
const files = readdirSync(SRC).filter((f) => f.endsWith(".md"));
for (const f of files) copyFileSync(`${SRC}/${f}`, `${DST}/${f}`);
console.log("copied:", files.length, "份");
console.log(files.join("\n"));
execFileSync("git", ["add", "-f", DST], { stdio: ["ignore", "pipe", "inherit"] });
const staged = execFileSync("git", ["status", "--porcelain", "--", DST], { encoding: "utf8" }).trim();
console.log("\nstaged:\n" + staged);
