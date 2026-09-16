/**
 * `orch/config.ts` 配置解析单元测试（v0.4.1 transport 段；`node:test`，无新依赖）。
 *
 * 覆盖：无 `transport` 段（缺省 stdio，旧配置零改动可用）、显式 stdio、
 * 显式 http（含 `http` 段部分缺省）、空段、非法 mode、非法 http 端口 / 路径。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMachinesConfig } from "../config.js";

/** 在临时目录落一份配置文件并交给回调解析（用例结束即清理） */
function withConfig<T>(raw: unknown, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "orch-config-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(raw), "utf8");
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 最小可用配置（默认不含 transport：模拟旧 config.json） */
function minimalConfig(extra: Record<string, unknown> = {}): unknown {
  return {
    machines: [{ machineId: "m1", launcherUrl: "http://127.0.0.1:3100" }],
    ...extra,
  };
}

const HTTP_DEFAULTS = { host: "127.0.0.1", port: 8787, path: "/mcp" };

test("缺省：无 transport 段 → mode=stdio 且 http 取默认值（旧配置行为不变）", () => {
  const cfg = withConfig(minimalConfig(), loadMachinesConfig);
  assert.equal(cfg.transport.mode, "stdio");
  assert.deepEqual(cfg.transport.http, HTTP_DEFAULTS);
});

test("显式 stdio：mode=stdio 被接受，http 段仍补齐默认值", () => {
  const cfg = withConfig(minimalConfig({ transport: { mode: "stdio" } }), loadMachinesConfig);
  assert.equal(cfg.transport.mode, "stdio");
  assert.deepEqual(cfg.transport.http, HTTP_DEFAULTS);
});

test("显式 http：按声明覆盖 http 段，未声明字段回退默认", () => {
  const full = withConfig(
    minimalConfig({
      transport: { mode: "http", http: { host: "0.0.0.0", port: 9000, path: "/a2a" } },
    }),
    loadMachinesConfig,
  );
  assert.equal(full.transport.mode, "http");
  assert.deepEqual(full.transport.http, { host: "0.0.0.0", port: 9000, path: "/a2a" });

  const partial = withConfig(
    minimalConfig({ transport: { mode: "http", http: { port: 9100 } } }),
    loadMachinesConfig,
  );
  assert.equal(partial.transport.mode, "http");
  assert.deepEqual(partial.transport.http, { host: "127.0.0.1", port: 9100, path: "/mcp" });
});

test("空 transport 段：{} 视同缺省（stdio + http 默认）", () => {
  const cfg = withConfig(minimalConfig({ transport: {} }), loadMachinesConfig);
  assert.equal(cfg.transport.mode, "stdio");
  assert.deepEqual(cfg.transport.http, HTTP_DEFAULTS);
});

test("非法 mode → 结构化报错（[config] 前缀 + 字段路径），不静默接受", () => {
  const bad: unknown[] = ["sse", "HTTP", "", 1, null, true];
  for (const mode of bad) {
    assert.throws(
      () => withConfig(minimalConfig({ transport: { mode } }), loadMachinesConfig),
      /\[config\] transport\.mode 必须是 "stdio" 或 "http"/,
    );
  }
});

test("非法 http 端口 → 结构化报错（非整数 / 越界 / 类型错）", () => {
  const bad: unknown[] = [0, 65536, 1.5, "8787", null];
  for (const port of bad) {
    assert.throws(
      () =>
        withConfig(
          minimalConfig({ transport: { mode: "http", http: { port } } }),
          loadMachinesConfig,
        ),
      /\[config\] transport\.http\.port 必须是 1-65535 的整数/,
    );
  }
});

test("非法 http 路径 → 结构化报错（非空字符串且以 / 开头）", () => {
  const bad: unknown[] = ["mcp", "", 42];
  for (const path of bad) {
    assert.throws(
      () =>
        withConfig(
          minimalConfig({ transport: { mode: "http", http: { path } } }),
          loadMachinesConfig,
        ),
      /\[config\] transport\.http\.path 必须/,
    );
  }
});
