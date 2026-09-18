/**
 * `orch/runtime/lifecycle.ts` 单元测试（REQ-v0.4.1-2026-09-15-02，`node:test`，无新依赖）。
 *
 * 覆盖（对齐验收 §4.1 第 5 / 11 条）：
 * ① **第二个 core 抢不到租约 → `role=follower` 且不启动 scheduler / watcher**；
 * ② **owner 退出（陈旧锁）后新进程可接管**（`role=owner`，正常启动后台循环）；
 * ③ **`unref` 恒 false**：桥恒常驻 http（stdio 已退役），定时器不 unref（由 HTTP listener 持住进程）；
 * ④ 启停顺序：owner 停机走「停调度 → 排空 → 停 watcher → 关 store → 释放租约 → 删 pidfile」；
 * ⑤ `task-watcher` owner 门闩：follower 下 `startTaskWatcher` 一律拒绝。
 *
 * 隔离：scheduler / watcher / store 全部注入替身（不落真库、不起真循环），每个用例独立临时目录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTaskWatcherEnabled,
  drainTaskWatchers,
  setTaskWatcherEnabled,
  startTaskWatcher,
} from "../bridge/task-watcher.js";
import {
  acquireCoreLease,
  coreLockPath,
  readCoreLease,
  releaseCoreLease,
} from "../runtime/core-lease.js";
import {
  BridgeRuntime,
  type LifecycleScheduler,
  type LifecycleWatcher,
} from "../runtime/lifecycle.js";

interface SchedulerCalls {
  starts: number;
  stops: number;
  recovers: number;
  drains: number;
  lastUnref: boolean | undefined;
  lastRole: string | undefined;
  drainResult: boolean;
}

function fakeScheduler(calls: SchedulerCalls): LifecycleScheduler {
  return {
    start(options): void {
      calls.starts += 1;
      calls.lastUnref = options?.unref;
      calls.lastRole = options?.role;
    },
    stop(): void {
      calls.stops += 1;
    },
    recover(): unknown {
      calls.recovers += 1;
      return { scanned: 0, failedFeatures: 0, interruptedTasks: 0 };
    },
    async drain(): Promise<boolean> {
      calls.drains += 1;
      return calls.drainResult;
    },
  };
}

function newCalls(): SchedulerCalls {
  return {
    starts: 0,
    stops: 0,
    recovers: 0,
    drains: 0,
    lastUnref: undefined,
    lastRole: undefined,
    drainResult: true,
  };
}

interface WatcherCalls {
  enabled: boolean[];
  drains: number;
}

function fakeWatcher(calls: WatcherCalls): LifecycleWatcher {
  return {
    setEnabled(enabled: boolean): void {
      calls.enabled.push(enabled);
    },
    async drain(): Promise<{ drained: boolean; remaining: number; waitedMs: number }> {
      calls.drains += 1;
      return { drained: true, remaining: 0, waitedMs: 0 };
    },
  };
}

function newWatcherCalls(): WatcherCalls {
  return { enabled: [], drains: 0 };
}

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `a2a-lifecycle-${name}-`));
}

/** 造「owner 已退出」的陈旧锁（子进程写锁后退出），返回其 pid */
function writeLockFromExitedProcess(lockPath: string): number {
  const script = [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const p=process.argv[1];",
    "fs.mkdirSync(path.dirname(p),{recursive:true});",
    "fs.writeFileSync(p, JSON.stringify({pid:process.pid,mode:'http',startedAt:new Date().toISOString()}));",
  ].join("");
  const result = spawnSync(process.execPath, ["-e", script, lockPath], { stdio: "ignore" });
  if (result.pid === undefined || result.pid <= 0) throw new Error("造陈旧锁失败");
  return result.pid;
}

test("① 第二个 core（活锁存在）→ role=follower，且不启动 scheduler / watcher", async () => {
  const dir = tempDir("follower");
  const calls = newCalls();
  const watcherCalls = newWatcherCalls();
  try {
    // 第一把锁（模拟已在运行的 core，pid 为本进程 → 判活）
    assert.equal(acquireCoreLease(dir, "http").role, "owner");

    const runtime = new BridgeRuntime({
      dataDir: dir,
      mode: "http",
      scheduler: fakeScheduler(calls),
      watcher: fakeWatcher(watcherCalls),
      openStore: () => undefined,
      closeStore: () => undefined,
    });
    const readiness = runtime.start();

    assert.equal(readiness.role, "follower");
    assert.equal(calls.starts, 0, "follower 不得启动 scheduler");
    assert.equal(calls.recovers, 0, "follower 不得执行 recover");
    assert.deepEqual(watcherCalls.enabled, [false], "follower 应关闭 watcher 门闩");
    assert.equal(watcherCalls.drains, 0);

    const summary = await runtime.stop();
    assert.equal(summary.role, "follower");
    assert.equal(calls.stops, 0, "follower 不触碰调度器");
    // follower 停机不得删 owner 的活锁
    assert.notEqual(readCoreLease(dir), null, "owner 的锁必须保留");
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("② owner 退出（陈旧锁）→ 新进程接管并正常启动后台循环", async () => {
  const dir = tempDir("takeover");
  const calls = newCalls();
  const watcherCalls = newWatcherCalls();
  let storeClosed = 0;
  try {
    const deadPid = writeLockFromExitedProcess(coreLockPath(dir));
    assert.equal(readCoreLease(dir)?.pid, deadPid);

    const runtime = new BridgeRuntime({
      dataDir: dir,
      mode: "http",
      scheduler: fakeScheduler(calls),
      watcher: fakeWatcher(watcherCalls),
      openStore: () => undefined,
      closeStore: () => {
        storeClosed += 1;
      },
      drainGraceMs: 50,
    });
    const readiness = runtime.start();

    assert.equal(readiness.role, "owner", "陈旧锁应被接管");
    assert.equal(readiness.holder?.pid, process.pid);
    assert.equal(calls.starts, 1);
    assert.equal(calls.recovers, 1);
    assert.equal(calls.lastUnref, false, "常驻 http 不得 unref");
    assert.equal(calls.lastRole, "owner");
    assert.deepEqual(watcherCalls.enabled, [true], "owner 应打开 watcher 门闩");
    assert.ok(existsSync(join(dir, "bridge.pid")), "owner 应写 pidfile");

    const summary = await runtime.stop();
    assert.equal(summary.role, "owner");
    assert.equal(summary.schedulerDrained, true);
    assert.equal(summary.watcherDrained, true);
    assert.equal(calls.stops, 1);
    assert.equal(calls.drains, 1);
    assert.equal(watcherCalls.drains, 1);
    assert.equal(storeClosed, 1, "停机应关 store");
    assert.equal(existsSync(join(dir, "bridge.pid")), false, "停机应删 pidfile");
    assert.equal(readCoreLease(dir), null, "停机应释放租约");

    // 租约释放后，同一 dataDir 可再被接管（owner 退出 → 新进程接管的闭环）
    assert.equal(acquireCoreLease(dir, "http").role, "owner");
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("③ 启停顺序：owner 停机 = 停调度 → 排空 → 停 watcher → 关 store → 释放租约 → 删 pidfile", async () => {
  const dir = tempDir("order");
  const events: string[] = [];
  let lastUnref: boolean | undefined;
  try {
    const scheduler: LifecycleScheduler = {
      start(options): void {
        lastUnref = options?.unref;
        events.push("scheduler.start");
      },
      stop(): void {
        events.push("scheduler.stop");
      },
      recover(): unknown {
        events.push("scheduler.recover");
        return null;
      },
      async drain(): Promise<boolean> {
        events.push("scheduler.drain");
        return true;
      },
    };
    const watcher: LifecycleWatcher = {
      setEnabled(enabled: boolean): void {
        events.push(`watcher.enable:${enabled}`);
      },
      async drain(): Promise<{ drained: boolean; remaining: number; waitedMs: number }> {
        events.push("watcher.drain");
        return { drained: true, remaining: 0, waitedMs: 0 };
      },
    };
    const runtime = new BridgeRuntime({
      dataDir: dir,
      mode: "http",
      scheduler,
      watcher,
      openStore: () => {
        events.push("store.open");
      },
      closeStore: () => {
        events.push("store.close");
      },
      drainGraceMs: 50,
    });
    const readiness = runtime.start();
    assert.equal(readiness.role, "owner");
    assert.equal(lastUnref, false, "桥恒常驻：定时器不 unref");
    await runtime.stop();
    assert.deepEqual(events, [
      "store.open",
      "watcher.enable:true",
      "scheduler.start",
      "scheduler.recover",
      "scheduler.stop",
      "scheduler.drain",
      "watcher.drain",
      "watcher.enable:false",
      "store.close",
    ]);
    assert.equal(readCoreLease(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("④ task-watcher owner 门闩：follower 下拒绝启动看护", async () => {
  try {
    setTaskWatcherEnabled(false);
    assert.equal(isTaskWatcherEnabled(), false);
    const started = startTaskWatcher({
      taskId: "t-follower",
      poll: () => {
        throw new Error("follower 不得轮询");
      },
      isSettled: () => true,
      persist: () => undefined,
      pollIntervalMs: 1,
      maxConsecutiveFailures: 1,
    });
    assert.equal(started, false, "follower 必须被拒绝");
  } finally {
    setTaskWatcherEnabled(true);
  }
  // 无在飞看护时排空立即成功
  const drain = await drainTaskWatchers(50);
  assert.equal(drain.drained, true);
  assert.equal(drain.remaining, 0);
});
