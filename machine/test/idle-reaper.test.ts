/**
 * `machine/launcher/manager.ts` 空闲回收判据单元测试（v0.7.0 · 节点 M5·MC1）。
 *
 * 门禁判据（新口径 = `inflight==0 && (now - lastActivity) >= idleStopMs`）：
 * - `inflight>0` 时**任何时长都不触发** stop（等价「心跳失败只降注册态字段、不触发 stop」——
 *   IdleReaper 不接收任何 bridge / 网络输入，回收决策与 bridge 可达性天然解耦）；
 * - `inflight==0` 且静默超时 ⇒ 触发一次本地回收回调；
 * - 未满静默 / `noteActivity` 复位 / `clear` / `idleStopMs<=0` 禁用 的边界。
 *
 * 用假时钟 + 假定时器驱动（不真实等待）。运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { IdleReaper, isIdleStopDue, type IdleTimerHandle } from "../launcher/manager.js";

/** 假时钟 / 假定时器：`advance(ms)` 按时间顺序触发到期回调（支持回调内重新计时） */
function makeFakeClock(): {
  now: () => number;
  setTimer: (callback: () => void, ms: number) => IdleTimerHandle;
  advance: (ms: number) => void;
} {
  let now = 0;
  const pending: { at: number; callback: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    setTimer: (callback, ms) => {
      const entry = { at: now + ms, callback, cancelled: false };
      pending.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = pending
          .filter((entry) => !entry.cancelled && entry.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        now = due.at;
        due.cancelled = true;
        due.callback();
      }
      now = target;
    },
  };
}

test("isIdleStopDue：inflight==0 且静默达阈值 ⇒ true；未达阈值 / 有在飞 / 禁用 ⇒ false", () => {
  // 达到阈值（边界含）
  assert.equal(
    isIdleStopDue({ inFlightCount: 0, lastActivityMs: 0, nowMs: 100, idleStopMs: 100 }),
    true,
  );
  // 未达阈值
  assert.equal(
    isIdleStopDue({ inFlightCount: 0, lastActivityMs: 0, nowMs: 99, idleStopMs: 100 }),
    false,
  );
  // 有在飞任务：即使静默远超阈值也不回收
  assert.equal(
    isIdleStopDue({ inFlightCount: 1, lastActivityMs: 0, nowMs: 100_000, idleStopMs: 100 }),
    false,
  );
  // 禁用
  assert.equal(
    isIdleStopDue({ inFlightCount: 0, lastActivityMs: 0, nowMs: 100_000, idleStopMs: 0 }),
    false,
  );
  // 负值同样视为禁用
  assert.equal(
    isIdleStopDue({ inFlightCount: 0, lastActivityMs: 0, nowMs: 100_000, idleStopMs: -1 }),
    false,
  );
});

test("inflight>0：长时间不触发 stop（与 bridge/心跳无关，判据只看在飞与静默）", () => {
  const clock = makeFakeClock();
  let inflight = 1;
  const stopped: string[] = [];
  const reaper = new IdleReaper({
    idleStopMs: 100,
    inFlightCount: () => inflight,
    onIdle: (projectId) => stopped.push(projectId),
    now: clock.now,
    setTimer: clock.setTimer,
    log: () => {},
  });

  reaper.noteActivity("alpha");
  clock.advance(10_000); // 远超 idleStopMs，且反复重查
  assert.deepEqual(stopped, []);

  // 在飞任务结束 ⇒ 下一次重查即回收
  inflight = 0;
  clock.advance(100);
  assert.deepEqual(stopped, ["alpha"]);
});

test("inflight==0：静默达阈值 ⇒ 触发一次本地 stop；未达阈值不触发", () => {
  const clock = makeFakeClock();
  const stopped: string[] = [];
  const reaper = new IdleReaper({
    idleStopMs: 100,
    inFlightCount: () => 0,
    onIdle: (projectId) => stopped.push(projectId),
    now: clock.now,
    setTimer: clock.setTimer,
    log: () => {},
  });

  reaper.noteActivity("alpha");
  clock.advance(99);
  assert.deepEqual(stopped, []);

  clock.advance(1);
  assert.deepEqual(stopped, ["alpha"]);
});

test("noteActivity 复位静默基准并重新计时（ensure 复用续期）", () => {
  const clock = makeFakeClock();
  const stopped: string[] = [];
  const reaper = new IdleReaper({
    idleStopMs: 100,
    inFlightCount: () => 0,
    onIdle: (projectId) => stopped.push(projectId),
    now: clock.now,
    setTimer: clock.setTimer,
    log: () => {},
  });

  reaper.noteActivity("alpha");
  clock.advance(80);
  reaper.noteActivity("alpha"); // 续期
  clock.advance(80);
  assert.deepEqual(stopped, []); // 距第二次活动仅 80 < 100

  clock.advance(20);
  assert.deepEqual(stopped, ["alpha"]);
});

test("clear 取消计时 ⇒ 不再触发 stop", () => {
  const clock = makeFakeClock();
  const stopped: string[] = [];
  const reaper = new IdleReaper({
    idleStopMs: 100,
    inFlightCount: () => 0,
    onIdle: (projectId) => stopped.push(projectId),
    now: clock.now,
    setTimer: clock.setTimer,
    log: () => {},
  });

  reaper.noteActivity("alpha");
  reaper.clear("alpha");
  clock.advance(1_000);
  assert.deepEqual(stopped, []);
});

test("idleStopMs<=0：禁用空闲回收（不排计时、不触发）", () => {
  const clock = makeFakeClock();
  const stopped: string[] = [];
  const reaper = new IdleReaper({
    idleStopMs: 0,
    inFlightCount: () => 0,
    onIdle: (projectId) => stopped.push(projectId),
    now: clock.now,
    setTimer: clock.setTimer,
    log: () => {},
  });

  reaper.noteActivity("alpha");
  clock.advance(100_000);
  assert.deepEqual(stopped, []);
});
