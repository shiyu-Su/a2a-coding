/**
 * 台账脱敏单测（REQ-v0.8.5-2026-09-21-01 · 节点 M7）
 *
 * `launcher/manager.ts` 的 `redactArgv()` 在把启动 argv 写进进程台账（`trackChild` 的
 * `command` 字段）之前，必须把 `--session-meta-json` 的**取值**遮蔽为 `<redacted>` ——
 * 该取值承载 claude `_meta` 注入（如 `allowDangerouslySkipPermissions`），属敏感面，
 * 不得落台账 / 日志 / 接口返回。
 *
 * 判据：
 * - `--session-meta-json <值>` ⇒ flag 保留、**取值被遮蔽**；明文逐字不可见。
 * - 真实 claude `full` 档 argv（由 adapter 产出）经脱敏后，明文 JSON 不可见。
 * - 不含该 flag 的 argv（codex / qoder / opencode）逐字不变（零副作用）。
 * - 边界：flag 位于末尾（无取值）不崩、不臆造 `<redacted>`；多次出现逐处遮蔽。
 * - 结构锚：台账写入点确为 `redactArgv(...)`（防「脱敏函数在、调用点被摘」）。
 *
 * 运行：`npm test`（先 `tsc` 编译，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactArgv } from "../launcher/manager.js";
import { appRootFromModule } from "../launcher/app-root.js";
import { getAdapter } from "../adapters/index.js";

const META_JSON = JSON.stringify({
  claudeCode: { options: { allowDangerouslySkipPermissions: true } },
});

test("redactArgv：`--session-meta-json` 取值 ⇒ `<redacted>`（flag 保留、明文不可见）", () => {
  const out = redactArgv(["--risk", "full", "--session-meta-json", META_JSON]);

  assert.equal(out, "--risk full --session-meta-json <redacted>");
  assert.ok(!out.includes(META_JSON), "台账不得出现明文取值");
  assert.ok(!out.includes("allowDangerouslySkipPermissions"), out);
});

test("redactArgv：真实 claude full 档 argv（adapter 产出）⇒ 明文 JSON 不可见", () => {
  const args = [
    "node",
    join("dist", "acp-bridge", "index.js"),
    ...getAdapter("claude").permission("full").args,
  ];

  // 前置（否则本用例无意义）：full 档确实带 `--session-meta-json <明文 JSON>`
  const index = args.indexOf("--session-meta-json");
  assert.ok(index >= 0, "前置：full 档应带 --session-meta-json");
  const raw = args[index + 1] ?? "";
  assert.notEqual(raw, "", "前置：flag 后应有取值");
  assert.doesNotThrow(() => JSON.parse(raw), "前置：取值应为合法 JSON");

  const out = redactArgv(args);
  assert.ok(out.includes("--session-meta-json <redacted>"), out);
  assert.ok(!out.includes(raw), `脱敏后不得出现明文取值：${out}`);
  assert.ok(!out.includes("allowDangerouslySkipPermissions"), out);
});

test("redactArgv：不含该 flag 的 argv 逐字不变（codex / qoder / opencode 零副作用）", () => {
  const samples: ReadonlyArray<readonly string[]> = [
    ["node", "bridge.js", ...getAdapter("codex").permission("read").args],
    ["node", "bridge.js", ...getAdapter("qoder").permission("full").args],
    ["node", "bridge.js", ...getAdapter("opencode").permission("write").args],
  ];

  for (const args of samples) {
    assert.ok(!args.includes("--session-meta-json"), `前置：样本不应带该 flag（${args.join(" ")}）`);
    assert.equal(redactArgv(args), args.join(" "));
  }
});

test("redactArgv：边界 —— flag 位于末尾（无取值）不崩、不臆造；多次出现逐处遮蔽", () => {
  assert.equal(redactArgv(["--session-meta-json"]), "--session-meta-json");
  assert.equal(
    redactArgv(["--session-meta-json", META_JSON, "--x", "1", "--session-meta-json", "b"]),
    "--session-meta-json <redacted> --x 1 --session-meta-json <redacted>",
  );
});

test("结构锚：台账 command 写入点确为 redactArgv（防脱敏函数在而调用点被摘）", () => {
  const src = readFileSync(
    join(appRootFromModule(import.meta.url), "launcher", "manager.ts"),
    "utf8",
  );
  assert.ok(src.includes("command: redactArgv("), "台账 command 必须经 redactArgv");
});