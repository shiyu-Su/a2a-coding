#!/usr/bin/env node
/**
 * v0.10.3 发版版本推进（宿主一次性脚本，不提交）。
 *
 * 口径（按兼容契约分组 · v0.10.3 触达面 = flow + board 单侧）：
 *   - 根 `package.json` = 发布列车号 → 0.10.3
 *   - `board` → 0.10.3（本版有真实行为变更：详情页依赖图重做 + 执行明细重构；PjM 结论 1a55deac）
 *   - `orch` / `machine`：本版零触达 → **保持 0.10.2 不动**（停同升分组：只动谁谁 bump）
 *   - `flow`：无 package.json（规范四戳已由节点 N-4 翻 v0.10.3）
 *
 * 用法：node scripts/_release-bump-v0103.mjs [--apply]
 */
import { readFileSync, writeFileSync } from "node:fs";

const TARGET = "0.10.3";
const FILES = [
  { p: "package.json", lock: false },
  { p: "board/package.json", lock: false },
  { p: "board/package-lock.json", lock: true },
];

const apply = process.argv.includes("--apply");
let changed = 0;

for (const { p, lock } of FILES) {
  const j = JSON.parse(readFileSync(p, "utf8"));
  const before = j.version;
  const beforePkg = lock ? j.packages?.[""]?.version : undefined;
  const line = `${p}: ${before} -> ${TARGET}` + (lock ? `  (packages[""] ${beforePkg} -> ${TARGET})` : "");
  if (!apply) {
    console.log(`[dry  ] ${line}`);
    continue;
  }
  j.version = TARGET;
  if (lock && j.packages?.[""]) j.packages[""].version = TARGET;
  writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  changed++;
  console.log(`[apply] ${line}`);
}

console.log(`\n[分组核对] 根列车 = ${TARGET}；board = ${TARGET}；orch/machine 应保持 0.10.2`);
for (const p of ["package.json", "board/package.json", "orch/package.json", "machine/package.json"]) {
  const j = JSON.parse(readFileSync(p, "utf8"));
  console.log(`  ${p} = ${j.version}`);
}
console.log(`\n${apply ? `已写 ${changed} 个文件` : "dry-run（未写盘）"}`);
