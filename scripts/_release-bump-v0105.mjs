#!/usr/bin/env node
/**
 * v0.10.5 发版版本推进（宿主一次性脚本，不提交）。
 *
 * 口径（按兼容契约分组 · v0.10.5 触达面 = orch + flow + board）：
 *   - 根 `package.json` = 发布列车号 → 0.10.5
 *   - `orch` → 0.11.0（本版 orch 有真实行为变更：两态 version_planning/decomposing、
 *     门① version 守卫、approve 六条过门条件、advance 阶段明细七枚）
 *   - `board` → 0.12.0（本版 board 有真实行为变更：依赖图按真实依赖边绘制 + 接点/疏密）
 *   - `flow`：无 package.json；本版四戳已随版翻至 v0.10.5（规范正文改动）
 *   - `machine`：本版零触达 → 保持 0.10.2 不动
 *
 * 用法：node scripts/_release-bump-v0105.mjs [--apply]
 */
import { readFileSync, writeFileSync } from "node:fs";

const TRAIN = "0.10.5";
const FILES = [
  { p: "package.json", target: TRAIN, lock: false },
  { p: "orch/package.json", target: "0.11.0", lock: false },
  { p: "orch/package-lock.json", target: "0.11.0", lock: true },
  { p: "board/package.json", target: "0.12.0", lock: false },
  { p: "board/package-lock.json", target: "0.12.0", lock: true },
];

const apply = process.argv.includes("--apply");
let changed = 0;

for (const { p, target, lock } of FILES) {
  let j;
  try { j = JSON.parse(readFileSync(p, "utf8")); } catch (e) { console.log(`[skip ] ${p}: ${e.message}`); continue; }
  const before = j.version;
  const beforePkg = lock ? j.packages?.[""]?.version : undefined;
  const line = `${p}: ${before} -> ${target}` + (lock ? `  (packages[""] ${beforePkg} -> ${target})` : "");
  if (!apply) { console.log(`[dry  ] ${line}`); continue; }
  j.version = target;
  if (lock && j.packages?.[""]) j.packages[""].version = target;
  writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  changed++;
  console.log(`[apply] ${line}`);
}

console.log(`\n[分组核对] 根列车 = ${TRAIN}；orch = 0.11.0；board = 0.12.0；machine 应保持 0.10.2`);
for (const p of ["package.json", "orch/package.json", "board/package.json", "machine/package.json"]) {
  try { console.log(`  ${p} = ${JSON.parse(readFileSync(p, "utf8")).version}`); } catch { /* */ }
}
console.log(`\n${apply ? `已写 ${changed} 个文件` : "dry-run（未写盘）"}`);
