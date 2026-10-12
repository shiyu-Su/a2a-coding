#!/usr/bin/env node
/**
 * v0.10.4 发版门（宿主 S3/B 类）：给本版 4 份改造文档补「修订历史 final 行」。
 *
 * 背景：根回归 TC10（`.omo/skills/regression-test/tests/test-doc-final.js:26`）的口径是
 *   `/^\|\s*final\s*\|/mi` —— 要求**表格行首格恰为 `final`**（`| final | 日期 | 说明 |`）。
 *   本版 4 份文档此前只写了头部「状态: final」/ 行内提「标 final」，不匹配该正则。
 * 这 4 张卡均已于 2026-10-12 用户验收通过 ⇒ 补的是本该有的收尾行，非新增结论。
 *
 * 用法：node scripts/_release-final-rows-v0104.mjs [--apply]
 */
import { readFileSync, writeFileSync } from "node:fs";

const DATE = "2026-10-12";
const DOCS = [
  [
    "doc/v0.10.4/依赖图分色失效-改造文档.md",
    "**用户验收通过**（原话「5a6ed454 验收通过」）—— final 行对照最新实现一致（补键 `QUEUE_STATE_RUNNING` 并入 `claimed` / `QUEUE_STATE_QUEUED` 并入 `settled` + `size===2` 硬钉；板全量 1558/1558；载体 pid 25712）；归属 board `0.11.0` 同轮补写；无未收口增补",
  ],
  [
    "doc/v0.10.4/卡片状态排序-改造文档.md",
    "**用户验收通过**（原话「验收通过」）—— final 行对照最新实现一致（真机凭据 = 序探针 91 → 0 逆序对；落点 = `version-order.ts` 状态档比较器 + `views.ts:2338` 呈现侧接线）；归属 board `0.11.0`；无未收口增补",
  ],
  [
    "doc/v0.10.4/板卡片呈现统一-改造文档.md",
    "**用户验收通过**（原话「4ca97bcd 验收通过」）—— final 行对照**含两条增补后**的最新实现一致（增补 `28df8a08` 验收反馈三件 / 增补 `076bbb84` 需求卡按状态排序）；12/12 DAG 节点全 completed；归属 board `0.11.0` 同轮补写；④ Apple 风已拆独立池卡 `7de376ba`；无未收口增补",
  ],
  [
    "doc/v0.10.4/板面免手刷-改造文档.md",
    "**用户验收通过**（原话「c997a0bb 858e9e46 验收通过」）—— final 行对照**含增补 07/08 后**的最新实现一致（第八枚页级脚本三页八锚 / 撤浮层自动刷新 / 浮层死钟隐藏；板全量 1558/1558；载体 pid 25712）；归属 board `0.11.0`；无未收口增补",
  ],
];

const apply = process.argv.includes("--apply");
const FINAL_RE = /^\|\s*final\s*\|/im;

for (const [p, note] of DOCS) {
  const src = readFileSync(p, "utf8");
  if (FINAL_RE.test(src)) {
    console.log(`[skip ] ${p}  （已有 final 行）`);
    continue;
  }
  const lines = src.split(/\r?\n/);
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (/^\|/.test(lines[i])) last = i;
  if (last < 0) {
    console.log(`[FAIL ] ${p}  （找不到表格行）`);
    process.exitCode = 1;
    continue;
  }
  const row = `| final | ${DATE} | ${note} |`;
  if (!apply) {
    console.log(`[dry  ] ${p}  → 在第 ${last + 1} 行后插入: ${row.slice(0, 80)}…`);
    continue;
  }
  lines.splice(last + 1, 0, row);
  writeFileSync(p, lines.join("\n"));
  console.log(`[apply] ${p}  （第 ${last + 1} 行后插入 final 行）`);
}

console.log(`\n${apply ? "已写盘" : "dry-run（未写盘）"}`);
