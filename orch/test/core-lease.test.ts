/**
 * `orch/runtime/core-lease.ts` 单元测试（REQ-v0.4.1-2026-09-15-02，`node:test`，无新依赖）。
 *
 * 覆盖：
 * - 首次抢锁 → `owner`，锁内容 `{ pid, mode, startedAt }` 正确；
 * - 活锁存在（本进程 pid）→ 第二个 core 得 `follower`；
 * - **owner 退出（陈旧锁）→ 新进程可接管**（真实用已退出子进程的 pid 造锁）；
 * - 损坏 / 空锁文件 → 判为陈旧，清掉后接管；
 * - `releaseCoreLease` 删锁、幂等、且**不删他进程的活锁**；
 * - `dataDir` 不存在时自动创建。
 *
 * 隔离：每个用例用独立临时目录（`os.tmpdir()` 下），互不影响。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acquireCoreLease,
  coreLockPath,
  isProcessAlive,
  readCoreLease,
  releaseCoreLease,
} from "../runtime/core-lease.js";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `a2a-core-lease-${name}-`));
}

/**
 * 造一把「owner 已退出」的锁：让子进程以**自己的 pid** 写锁后立即退出，
 * 返回其 pid（此刻已 ESRCH）。这是「owner 退出后新进程接管」的真实前态。
 */
function writeLockFromExitedProcess(lockPath: string): number {
  const script = [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const p=process.argv[1];",
    "fs.mkdirSync(path.dirname(p),{recursive:true});",
    "fs.writeFileSync(p, JSON.stringify({pid:process.pid,mode:'http',startedAt:new Date().toISOString()}));",
  ].join("");
  const result = spawnSync(process.execPath, ["-e", script, lockPath], { stdio: "ignore" });
  if (result.pid === undefined || result.pid <= 0) {
    throw new Error(`无法造陈旧锁：spawn 失败（status=${String(result.status)}）`);
  }
  return result.pid;
}

test("首次抢锁 → owner，锁内容含 pid / mode / startedAt", () => {
  const dir = tempDir("first");
  try {
    const result = acquireCoreLease(dir, "http");
    assert.equal(result.role, "owner");
    const lockPath = coreLockPath(dir);
    assert.ok(existsSync(lockPath), "core.lock 应存在");
    const info = readCoreLease(dir);
    assert.notEqual(info, null);
    assert.equal(info?.pid, process.pid);
    assert.equal(info?.mode, "http");
    assert.equal(typeof info?.startedAt, "string");
    assert.ok((info?.startedAt ?? "").length > 0);
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("活锁存在 → 第二个 core 得 follower（不覆盖锁）", () => {
  const dir = tempDir("follower");
  try {
    const first = acquireCoreLease(dir, "http");
    assert.equal(first.role, "owner");
    const second = acquireCoreLease(dir, "http");
    assert.equal(second.role, "follower");
    assert.equal(second.role === "follower" ? second.holder?.pid : null, process.pid);
    // 锁仍属第一持有者
    assert.equal(readCoreLease(dir)?.pid, process.pid);
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owner 退出（陈旧锁）→ 新进程可接管（role=owner 且锁被重写）", () => {
  const dir = tempDir("stale");
  try {
    const lockPath = coreLockPath(dir);
    const deadPid = writeLockFromExitedProcess(lockPath);
    const stale = readCoreLease(dir);
    assert.equal(stale?.pid, deadPid);
    assert.equal(isProcessAlive(deadPid), false, "已退出的子进程 pid 应判为死");

    const result = acquireCoreLease(dir, "http");
    assert.equal(result.role, "owner", "陈旧锁应被清理并接管");
    assert.equal(readCoreLease(dir)?.pid, process.pid);
    assert.equal(readCoreLease(dir)?.mode, "http");
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏 / 空锁文件 → 判为陈旧并接管", () => {
  const dir = tempDir("corrupt");
  try {
    const lockPath = coreLockPath(dir);
    writeFileSync(lockPath, "not-json", "utf8");
    assert.equal(readCoreLease(dir), null);
    assert.equal(acquireCoreLease(dir, "http").role, "owner");

    writeFileSync(lockPath, "", "utf8");
    releaseCoreLease(dir);
    assert.equal(acquireCoreLease(dir, "http").role, "owner");
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseCoreLease：幂等，且不删他进程的活锁", () => {
  const dir = tempDir("release");
  try {
    // 未持锁 → false（幂等）
    assert.equal(releaseCoreLease(dir), false);

    // 他进程的锁（用本进程的父 pid 之外的任意 pid 表示）→ 拒绝删除
    const lockPath = coreLockPath(dir);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid + 1, mode: "http", startedAt: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    assert.equal(releaseCoreLease(dir), false, "他进程的锁不得被删");
    assert.ok(existsSync(lockPath), "他进程的锁应保留");
    rmSync(lockPath, { force: true }); // 清掉测试夹具，验证"自己的锁"路径

    // 自己的锁 → 删除且幂等
    const result = acquireCoreLease(dir, "http");
    assert.equal(result.role, "owner");
    assert.equal(releaseCoreLease(dir), true);
    assert.equal(releaseCoreLease(dir), false);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dataDir 不存在时自动创建后再建锁", () => {
  const base = tempDir("mkdir");
  const dir = join(base, "nested", "data");
  try {
    assert.equal(existsSync(dirname(coreLockPath(dir))), false);
    const result = acquireCoreLease(dir, "http");
    assert.equal(result.role, "owner");
    assert.ok(existsSync(dir), "dataDir 应被创建");
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
