#!/usr/bin/env node
/**
 * v0.10.4 发版版本推进（宿主一次性脚本，不提交）。
 *
 * 口径（按兼容契约分组 · v0.10.4 触达面 = board 单侧）：
 *   - 根 `package.json` = 发布列车号 → 0.10.4
 *   - `board` → **0.11.0**（用户 2026-10-11 在乙卡 858e9e46 的 PjM 工序 4c93e0d8 上显式裁定；
 *     PjM 原建议 0.10.4 被覆盖。本版 board 有真实行为变更：免手刷 / 卡片呈现统一 / 分色修复 / 项目池刷新）
 *   - `orch` / `machine`：本版零触达 → **保持 0.10.2 不动**（停同升分组：只动谁谁 bump）
 *   - `flow`：本版零触达（无 package.json；规范四戳不翻）
 *
 * 用法：node scripts/_release-bump-v0104.mjs [--apply]
 */
import { readFileSync, writeFileSync } from "node:fs";

const TRAIN = "0.10.4";
const FILES = [
  { p: "package.json", target: TRAIN, lock: false },
  { p: "board/package.json", target: "0.11.0", lock: false },
  { p: "board/package-lock.json", target: "0.11.0", lock: true },
];

const apply = process.argv.includes("--apply");
let changed = 0;

for (const { p, target, lock } of FILES) {
  const j = JSON.parse(readFileSync(p, "utf8"));
  const before = j.version;
  const beforePkg = lock ? j.packages?.[""]?.version : undefined;
  const line = `${p}: ${before} -> ${target}` + (lock ? `  (packages[""] ${beforePkg} -> ${target})` : "");
  if (!apply) {
    console.log(`[dry  ] ${line}`);
    continue;
  }
  j.version = target;
  if (lock && j.packages?.[""]) j.packages[""].version = target;
  writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  changed++;
  console.log(`[apply] ${line}`);
}

console.log(`\n[分组核对] 根列车 = ${TRAIN}；board = 0.11.0；orch/machine 应保持 0.10.2`);
for (const p of ["package.json", "board/package.json", "orch/package.json", "machine/package.json"]) {
  const j = JSON.parse(readFileSync(p, "utf8"));
  console.log(`  ${p} = ${j.version}`);
}
console.log(`\n${apply ? `已写 ${changed} 个文件` : "dry-run（未写盘）"}`);
