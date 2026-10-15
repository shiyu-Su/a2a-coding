#!/usr/bin/env node
// v0.10.6 发版：staged 分域 add + commit + tag（宿主一次性脚本，走根级通道绕过单元路径守卫）。
// 触达面 = board 单侧（§8 步骤 4/5）：CHANGELOG + 根列车号 + board 单元（src/test 含夹具）+ instruction-doc 镜像 + 本次发版脚本。
// 用法：node scripts/_release-commit-v0106.mjs [--apply]
import { execFileSync, spawnSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");

const PATHS = [
  "CHANGELOG.md",
  "package.json",
  "instruction-doc/v0.10.6",
  "board/README.md",
  "board/package.json",
  "board/src",
  "board/test",
  "scripts/_release-bump-v0106.mjs",
  "scripts/_release-commit-v0106.mjs",
  "scripts/_release-mark-v0106.mjs",
  "scripts/_release-reload-v0106.mjs",
];

const MSG = [
  "v0.10.6: 依赖图读面重构（合并为单画布 + 管道框 [4bb23554 15 节点]，跨管道真连线替代 ⇠#k 角标 + 接点右/左缘中点件三 + 跨框穿模归零 + 编号登记序 [9b51af16] + 拖拽落点修复 [c53c09fd]）",
  "+ 增补 a0682281（连线两端接点错位 + 框宽溢出无横滚，final）+ 承接轨 65766f95（n8d 入点侧向让位 layerCrossApproach/三枚 DG_APPROACH_* 使 G13② 翻绿；真机 3 条穿模边命中 0、点名对共段 9.5px、62 端点偏差 0.00px、cross 色 --b-brand 图例不加；经 435b8695/e4e18e6f/d401b379 三次承接收敛，均归档）",
  "+ 板全量 1667/1667；根回归 1391/1391（含本版新增 irreducible 用例 test-v0.10.6-dep-graph.js）；board 载体 build+restart pid 56164 行为探针 dg-edge-cross；未收口项登记 ec20e577 / 2bbc0f0f / f55d46af；tag board/v0.12.1 + v0.10.6",
].join("\n");

const TAGS = ["board/v0.12.1", "v0.10.6"];

if (!APPLY) {
  console.log("[dry] 将 add 路径：\n  " + PATHS.join("\n  "));
  console.log("\n[dry] commit message（首行）：\n  " + MSG.split("\n")[0].slice(0, 170) + "…");
  console.log("[dry] tags: " + TAGS.join(" · "));
  const dr = spawnSync("git", ["add", "--dry-run", ...PATHS], { encoding: "utf8" });
  const staged = (dr.stdout ?? "").split(/\r?\n/).filter(Boolean);
  console.log("\n[dry] git add --dry-run 命中文件数 =", staged.length, "（摘 24 行）：");
  for (const l of staged.slice(0, 24)) console.log("  ", l);
  process.exit(0);
}

for (const p of PATHS) {
  const r = spawnSync("git", ["add", p], { encoding: "utf8" });
  console.log(`[add] ${p} => exit ${r.status}${r.stderr?.trim() ? "  " + r.stderr.trim().split(/\r?\n/)[0] : ""}`);
}
const st = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
const lines = (st.stdout ?? "").split(/\r?\n/).filter(Boolean);
console.log(`[staged] ${lines.filter((l) => /^[MARC]/.test(l)).length}  [untracked leftovers] ${lines.filter((l) => l.startsWith("??")).length}`);
lines.filter((l) => l.startsWith("??")).forEach((l) => console.log("  ?? " + l.slice(3)));

const run = (a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
console.log("\n[commit]", run(["commit", "-m", MSG]).split("\n")[0].slice(0, 150) + "…");
for (const t of TAGS) { run(["tag", t]); console.log("[tag]", t); }
console.log("--- log -1 ---");
console.log(run(["log", "-1", "--oneline"]).split("\n")[0].slice(0, 170));
const dirty = run(["status", "--porcelain"]).split(/\r?\n/).filter((l) => l.trim() && !/^\?\?/.test(l));
console.log("--- 工作树已跟踪改动（应为 0）---", dirty.length, dirty.join("\n"));
