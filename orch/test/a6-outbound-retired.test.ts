/**
 * v0.7.0 A6 · 防 vacuous 静态回归：`bridge/index.ts` **无「桥 → machine 出站」残留**。
 *
 * 读构建产物 `dist/bridge/index.js`（与运行时同源）。因 `tsc` 保留注释、且注释里会**提及**
 * 已退役符号名（历史说明），本用例只断言**代码形态**上不可能出现的出站符号：
 * - `fetch(`：任何出站 HTTP 调用的唯一入口（`fetchJson` / A2A client 均经它）；
 * - `launcherUrl`：出站契约字段（A6 已使 `types.ts` 中该字段可选且桥内零消费方）；
 * - `@a2a-js/sdk/client`：A2A 出站 client 的模块入口（已整体删除）。
 *
 * 另配正向对照（防「读了个空文件」）：新读侧符号（`listRunners` / `listRunnerProjects`）在位。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../bridge/index.js", import.meta.url)),
  "utf8",
);

test("A6 防 vacuous：index.ts 无桥→machine 出站 fetch / launcherUrl / A2A client 残留", () => {
  for (const forbidden of [/\bfetch\s*\(/, /launcherUrl/, /@a2a-js\/sdk\/client/]) {
    assert.equal(
      forbidden.test(source),
      false,
      `index.ts 不得残留出站符号：${forbidden}（出站应已随 A6 退役）`,
    );
  }
  // 正向对照：新读侧确实在读注册表（否则上面的「无残留」可能是空文件导致的空洞断言）
  assert.ok(source.includes("listRunners"), "防 vacuous：应含注册表读口 listRunners");
  assert.ok(source.includes("listRunnerProjects"), "防 vacuous：应含注册表项目读口 listRunnerProjects");
});
