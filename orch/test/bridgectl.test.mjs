#!/usr/bin/env node
/**
 * bridgectl.test.mjs —— `scripts/bridgectl.mjs` **退出卫生**契约用例（v0.7.2 X1 增量）。
 *
 * 覆盖：
 *   1) 源码契约：主流程**不得**再出现 `process.exit` 调用（改用 `process.exitCode` 自然排空）；
 *   2) 退出码契约（{0,1} 不变）：`--help` ⇒ 0；无参 ⇒ 1；
 *   3) 退出卫生：`status`（隔离配置 / 未监听端口）⇒ 退出码 0 且 **stderr 无 libuv 断言**
 *      —— 治 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 污染退出码为 0xC0000409。
 *
 * 运行：node --test test/bridgectl.test.mjs。
 * 约定：所有子进程 await `exit` 后才返回，确保不留未释放句柄。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "scripts", "bridgectl.mjs");

/** 跑 bridgectl 子进程并回收 stdout / stderr / 退出码（等 exit，确保句柄收尾） */
function runCtl(args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("源码契约：bridgectl.mjs 主流程无 process.exit 调用（自然排空退出）", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const matches = source.match(/process\.exit\s*\(/g) ?? [];
  assert.deepEqual(matches, [], `不应再有 process.exit 调用，实际 ${matches.length} 处`);
});

test("退出码契约：help 子命令 ⇒ 0（无参 / 裸 --help 无命令 ⇒ 1，契约不变）", async () => {
  const help = await runCtl(["help"]);
  assert.equal(help.code, 0, `stderr=${help.stderr}`);
  const bareHelp = await runCtl(["--help"]);
  assert.equal(bareHelp.code, 1, `stderr=${bareHelp.stderr}`);
});

test("退出码契约：无参 ⇒ 1", async () => {
  const result = await runCtl([]);
  assert.equal(result.code, 1, `stderr=${result.stderr}`);
});

test("退出卫生：status（隔离配置 / 未监听端口）⇒ exit 0 且无 libuv 断言", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridgectl-test-"));
  try {
    const configPath = join(dir, "config.json");
    // 端口 1（loopback）不会有本桥监听 ⇒ 「未运行」⇒ 按契约 exit 0
    writeFileSync(
      configPath,
      JSON.stringify({ transport: { http: { host: "127.0.0.1", port: 1 } } }),
    );
    const result = await runCtl(["status"], {
      MACHINES_CONFIG: configPath,
      SESSION_DB: join(dir, "sessions.sqlite"),
    });
    assert.equal(result.code, 0, `stderr=${result.stderr}`);
    assert.doesNotMatch(result.stderr, /Assertion failed|UV_HANDLE_CLOSING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
