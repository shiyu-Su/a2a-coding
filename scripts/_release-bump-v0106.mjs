#!/usr/bin/env node
/**
 * v0.10.6 发版版本推进（宿主一次性脚本，不提交）。
 *
 * 口径（按兼容契约分组 · v0.10.6 触达面 = board）：
 *   - 根 `package.json` = 发布列车号 → 0.10.6
 *   - `board` → 0.12.1（Julia 本列车 Project Version = 既有 open 版继承，package.json 已对齐 ⇒ 不动、复核）
 *   - `orch` → 0.11.0 / `machine` → 0.10.2 / `flow` 戳 v0.10.5 —— 本列车零触达 ⇒ 不动（只复核）
 *
 * 用法：node scripts/_release-bump-v0106.mjs [--apply]
 */
import { readFileSync, writeFileSync } from "node:fs";

const TRAIN = "0.10.6";
const WRITE = [{ p: "package.json", target: TRAIN, lock: false }];
const CHECK_ONLY = ["board/package.json", "orch/package.json", "machine/package.json"];

const apply = process.argv.includes("--apply");
let changed = 0;

for (const { p, target, lock } of WRITE) {
  const j = JSON.parse(readFileSync(p, "utf8"));
  const before = j.version;
  if (!apply) { console.log(`[dry  ] ${p}: ${before} -> ${target}`); continue; }
  j.version = target;
  writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  changed++;
  console.log(`[apply] ${p}: ${before} -> ${target}`);
}

console.log("\n[分组核对 / 复核（应保持不动）]");
for (const p of CHECK_ONLY) {
  try {
    const v = JSON.parse(readFileSync(p, "utf8")).version;
    const keep = p.endsWith("package.json") ? { "board/package.json": "0.12.1", "orch/package.json": "0.11.0", "machine/package.json": "0.10.2" }[p] : null;
    const flag = keep && v === keep ? "✓" : "⚠";
    console.log(`  ${p} = ${v}  ${keep ? `${flag}（应 ${keep}）` : ""}`);
  } catch { console.log(`  ${p} = (无)`); }
}
console.log(`\n${apply ? `已写 ${changed} 个文件` : "dry-run（未写盘）"}`);
