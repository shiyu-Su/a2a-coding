#!/usr/bin/env node
/**
 * v0.10.1 发版版本推进（宿主一次性脚本，不提交）。
 *
 * 口径（按兼容契约分组 · v0.10.0 起；本次第二次实操）：
 *   - 根 `package.json` = 发布列车号 → 0.10.1
 *   - `orch` / `board`：本版**有行为变更** → 0.10.0 → 0.10.1（package.json + lock 顶层 + lock packages[""]）
 *   - `machine`：**本版只动注释/文档、协议未变（仍 2.3）** → **保持 0.9.8 不动**
 *   - `flow`：无 package.json（其四戳已由 F2 翻 v0.10.1）
 *
 * 用法：
 *   node scripts/_release-bump-v0101.mjs            # dry-run
 *   node scripts/_release-bump-v0101.mjs --apply    # 写盘
 */
import { readFileSync, writeFileSync } from "node:fs";

const TARGET = "0.10.1";
const FILES = [
  { p: "package.json", lock: false },
  { p: "orch/package.json", lock: false },
  { p: "orch/package-lock.json", lock: true },
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

console.log(`\n[分组核对] machine 必须保持 0.9.8（协议未变 2.3）`);
for (const p of ["machine/package.json", "machine/package-lock.json"]) {
  const j = JSON.parse(readFileSync(p, "utf8"));
  const pkg = j.packages?.[""]?.version;
  console.log(`  ${p} = ${j.version}` + (pkg !== undefined ? `  (packages[""] = ${pkg})` : ""));
}
console.log(`\n${apply ? `已写 ${changed} 个文件` : "dry-run（未写盘）"}`);
