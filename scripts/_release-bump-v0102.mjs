#!/usr/bin/env node
/**
 * v0.10.2 发版版本推进（宿主一次性脚本，不提交）。
 *
 * 口径（按兼容契约分组）：
 *   - 根 `package.json` = 发布列车号 → 0.10.2
 *   - `orch` / `board` / **`machine`：本版三者均有行为变更 → 0.10.2**
 *     （machine 自 0.9.8 首次抬号 —— PjM 结论 `11052640`：roles 配置/模板拆分/守卫触达，抬号属发版动作）
 *   - `flow`：无 package.json（三份 spec 戳已在增补五/六翻 v0.10.2）
 *
 * 用法：node scripts/_release-bump-v0102.mjs [--apply]
 */
import { readFileSync, writeFileSync } from "node:fs";

const TARGET = "0.10.2";
const FILES = [
  { p: "package.json", lock: false },
  { p: "orch/package.json", lock: false },
  { p: "orch/package-lock.json", lock: true },
  { p: "board/package.json", lock: false },
  { p: "board/package-lock.json", lock: true },
  { p: "machine/package.json", lock: false },
  { p: "machine/package-lock.json", lock: true },
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

console.log(`\n[分组核对] orch / board / machine 三单元应同为 ${TARGET}`);
for (const p of ["orch/package.json", "board/package.json", "machine/package.json"]) {
  const j = JSON.parse(readFileSync(p, "utf8"));
  console.log(`  ${p} = ${j.version}`);
}
console.log(`\n${apply ? `已写 ${changed} 个文件` : "dry-run（未写盘）"}`);
