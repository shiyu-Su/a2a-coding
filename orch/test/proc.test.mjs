#!/usr/bin/env node
/**
 * proc.test.mjs —— `scripts/lib/proc.mjs` 注入式**结构级**用例（REQ-v0.7.2-2026-09-18-01 · K8）。
 *
 * 诚实口径（改造文档 §2.2 K8 / §4.2 条件 B）：本文件用 `{ platform, kill, spawnSync }`
 * 注入断言**分支选择与信号参数**（win32 → taskkill `/T /F`；POSIX → `kill(-pid, "SIGKILL")`
 * 组杀 + `ESRCH` 回落单 pid；`isPidAlive` 三态），**不真正执行 POSIX 分支**、不真正投递信号、
 * 不真正调用 taskkill —— 不得把这些结构级断言伪装成真机 POSIX 验证。
 * 真实信号投递 / 真实 taskkill 的集成用例以 `skip` 标注，仅在其平台可触发时运行（本文件
 * 另含一条「import bridgectl.mjs 零副作用」用例，佐证 K8 的 entry guard 前置）。
 *
 * 运行：node --test test/proc.test.mjs（或 `npm run test:proc`）。
 * 约定：不开无人释放的句柄 —— 集成用例 await 子进程 `exit` 后才结束，`node --test` 自然退出。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { isPidAlive, killForce } from "../scripts/lib/proc.mjs";

const PID = 4242;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 造带 `code` 的错误（模拟 Node 的 `process.kill` 失败态） */
function codeError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

// ── killForce：win32 分支（结构级） ───────────────────────────────────────────

test("killForce(win32)：taskkill /PID <pid> /T /F，ok:true", () => {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, error: undefined };
  };

  const result = killForce(PID, { platform: "win32", spawnSync, kill: () => {} });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "taskkill");
  assert.deepEqual(calls[0].args, ["/PID", String(PID), "/T", "/F"]);
  assert.equal(result.ok, true);
  assert.equal(result.method, "taskkill");
  assert.equal(result.fallback, false);
});

test("killForce(win32)：taskkill 非零退出 ⇒ ok:false（不静默）", () => {
  const result = killForce(PID, {
    platform: "win32",
    spawnSync: () => ({ status: 128, error: undefined }),
    kill: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.method, "taskkill");
  assert.match(String(result.error?.message), /128/);
});

test("killForce(win32)：spawnSync 抛错 / result.error ⇒ ok:false", () => {
  const thrown = killForce(PID, {
    platform: "win32",
    spawnSync: () => {
      throw codeError("ENOENT");
    },
    kill: () => {},
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error?.code, "ENOENT");

  const errored = killForce(PID, {
    platform: "win32",
    spawnSync: () => ({ status: null, error: codeError("EACCES") }),
    kill: () => {},
  });
  assert.equal(errored.ok, false);
  assert.equal(errored.error?.code, "EACCES");
});

// ── killForce：POSIX 分支（结构级） ──────────────────────────────────────────

test("killForce(posix/linux)：组杀 kill(-pid, SIGKILL)，不回落、不触达 spawnSync", () => {
  const calls = [];
  const kill = (target, signal) => {
    calls.push([target, signal]);
  };

  const result = killForce(PID, {
    platform: "linux",
    kill,
    spawnSync: () => {
      throw new Error("POSIX 分支不得调用 spawnSync");
    },
  });

  assert.deepEqual(calls, [[-PID, "SIGKILL"]]);
  assert.equal(result.ok, true);
  assert.equal(result.method, "kill-group");
  assert.equal(result.fallback, false);
});

test("killForce(posix/darwin)：组杀 ESRCH ⇒ 回落 kill(pid, SIGKILL)", () => {
  const calls = [];
  const kill = (target, signal) => {
    calls.push([target, signal]);
    if (target === -PID) throw codeError("ESRCH");
  };

  const result = killForce(PID, { platform: "darwin", kill });

  assert.deepEqual(calls, [
    [-PID, "SIGKILL"],
    [PID, "SIGKILL"],
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.method, "kill-pid");
  assert.equal(result.fallback, true);
  assert.equal(result.gone, false);
});

test("killForce(posix)：组杀非 ESRCH（EPERM）⇒ 不回落、ok:false", () => {
  const calls = [];
  const kill = (target, signal) => {
    calls.push([target, signal]);
    throw codeError("EPERM");
  };

  const result = killForce(PID, { platform: "linux", kill });

  assert.deepEqual(calls, [[-PID, "SIGKILL"]]);
  assert.equal(result.ok, false);
  assert.equal(result.method, "kill-group");
  assert.equal(result.error?.code, "EPERM");
});

test("killForce(posix)：组杀与回落均 ESRCH（进程已不存在）⇒ ok:true, gone:true", () => {
  const kill = () => {
    throw codeError("ESRCH");
  };

  const result = killForce(PID, { platform: "linux", kill });

  assert.equal(result.ok, true);
  assert.equal(result.method, "kill-pid");
  assert.equal(result.fallback, true);
  assert.equal(result.gone, true);
});

test("killForce(posix)：回落非 ESRCH（EPERM）⇒ ok:false", () => {
  const kill = (target) => {
    if (target === -PID) throw codeError("ESRCH");
    throw codeError("EPERM");
  };

  const result = killForce(PID, { platform: "linux", kill });

  assert.equal(result.ok, false);
  assert.equal(result.method, "kill-pid");
  assert.equal(result.fallback, true);
});

// ── killForce：非法 pid 防护（0 / 负数会误伤进程组） ─────────────────────────

test("killForce：非法 pid ⇒ method:none 且不触发 kill / spawnSync", () => {
  for (const bad of [undefined, null, 0, -1, 1.5, "42", Number.NaN]) {
    let touched = false;
    const result = killForce(bad, {
      platform: "linux",
      kill: () => {
        touched = true;
      },
      spawnSync: () => {
        touched = true;
        return { status: 0 };
      },
    });

    assert.equal(result.ok, false, `pid=${String(bad)} 应判非法`);
    assert.equal(result.method, "none");
    assert.equal(touched, false, `pid=${String(bad)} 不得触发任何副作用`);
  }
});

// ── isPidAlive：三态（结构级） ───────────────────────────────────────────────

test("isPidAlive：ESRCH ⇒ false；EPERM ⇒ true；EINVAL ⇒ true（保守判活）", () => {
  assert.equal(
    isPidAlive(PID, {
      kill: () => {
        throw codeError("ESRCH");
      },
    }),
    false,
  );
  assert.equal(
    isPidAlive(PID, {
      kill: () => {
        throw codeError("EPERM");
      },
    }),
    true,
  );
  assert.equal(
    isPidAlive(PID, {
      kill: () => {
        throw codeError("EINVAL");
      },
    }),
    true,
  );
});

test("isPidAlive：kill 正常返回 ⇒ true；非法 pid ⇒ false 且不调用 kill", () => {
  assert.equal(isPidAlive(PID, { kill: () => {} }), true);

  let touched = false;
  assert.equal(
    isPidAlive(0, {
      kill: () => {
        touched = true;
      },
    }),
    false,
  );
  assert.equal(touched, false);
});

// ── K8 前置：entry guard（import bridgectl.mjs 零副作用） ────────────────────

test("entry guard：import scripts/bridgectl.mjs 不执行 main（无副作用）", async () => {
  const mod = await import("../scripts/bridgectl.mjs");
  // 无顶层 `await main()` 副作用（否则本用例会因解析 argv 失败而 exit / 报错）
  assert.equal(typeof mod, "object");
});

// ── 集成（真信号 / 真 taskkill）：仅本平台可触发时运行 ───────────────────────

test(
  "集成（Windows 真 taskkill）：/T /F 强杀真实子进程并确认退出",
  { skip: process.platform !== "win32", timeout: 10_000 },
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const pid = child.pid;
    assert.equal(typeof pid, "number");
    const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));

    await sleep(300);
    const result = killForce(pid);

    assert.equal(result.ok, true);
    assert.equal(result.method, "taskkill");
    await exited; // 等真实子进程收尾，确保不留未释放句柄
    assert.equal(isPidAlive(pid), false);
  },
);

test(
  "集成（POSIX 真 SIGKILL）：组杀独立进程组组长并确认退出",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const pid = child.pid;
    assert.equal(typeof pid, "number");
    const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
    child.unref();

    await sleep(300);
    const result = killForce(pid);

    assert.equal(result.ok, true);
    assert.equal(result.method, "kill-group"); // detached ⇒ 本进程为组长，组杀成立
    await exited; // 等真实子进程被回收（否则 POSIX 僵尸仍占 pid、判活失真）
    assert.equal(isPidAlive(pid), false);
  },
);
