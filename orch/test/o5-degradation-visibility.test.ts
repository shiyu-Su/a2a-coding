/**
 * v0.8.8 O5 · 降级可见（orch 面）验收单测。
 *
 * 覆盖改造文档 §2.8 验收判据：
 * ① 坏配置期间 ⇒ `/health` 的 `degraded[]` 出现对应项且带原因；
 * ② 修好后 ⇒ 该项消失；
 * ③ 降级期间 `/health` 仍返回 200 且 `status` 语义不变（只加键不改值）。
 *
 * 三处降级 catch + 看护门闩 + 登记表语义 + /health 出口，逐项断言（不为过测试弱化断言）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { MachinesConfig } from "../types.js";
import { DegradationRegistry } from "../bridge/index.js";
import type { BridgeCore } from "../bridge/index.js";
import {
  createRunnerEndpoints,
  type RunnerEndpointHandle,
  type RunnerStorePort,
} from "../bridge/runner.js";
import { startHttpTransport, type HttpTransportHandle } from "../bridge/transports/http.js";
import {
  isTaskWatcherEnabled,
  setTaskWatcherDegradationSink,
  setTaskWatcherEnabled,
  TASK_WATCHER_DEGRADED_KEY,
} from "../bridge/task-watcher.js";

const HEARTBEAT_KEY = "runner.heartbeat-sweep";
const ORPHAN_KEY = "runner.orphan-sweep";
const CLAIM_KEY = "claim.stale-criterion";

function cfg(): MachinesConfig {
  return {
    runner: { holdMs: 25_000, heartbeatTimeoutMs: 30_000, orphanTimeoutMs: 30 * 60_000 },
  } as unknown as MachinesConfig;
}

/** 只暴露两清算读口的假 store（其余端口本用例不触达） */
function fakeStore(
  impl: Partial<Pick<RunnerStorePort, "listRunners" | "listOrphanedTasks">>,
): RunnerStorePort {
  return impl as unknown as RunnerStorePort;
}

function makeHandle(
  degradation: DegradationRegistry,
  config: () => MachinesConfig,
  store: RunnerStorePort,
): RunnerEndpointHandle {
  return createRunnerEndpoints({
    role: () => "owner",
    config,
    store,
    degradation,
    sweepIntervalMs: 3_600_000, // 关闭自动循环：由用例显式调用 sweep 确定性驱动
  });
}

function findKey(reg: DegradationRegistry, key: string) {
  return reg.snapshot().find((i) => i.key === key);
}

test("登记表语义：mark 粘滞 since、重复 mark 只更新 reason、clear 移除", () => {
  const reg = new DegradationRegistry();
  assert.deepEqual(reg.snapshot(), []);
  reg.mark(CLAIM_KEY, "第一次原因");
  const first = findKey(reg, CLAIM_KEY);
  assert.ok(first, "mark 后应存在该项");
  assert.equal(first.reason, "第一次原因");
  assert.equal(typeof first.since, "number");
  // 重复 mark：reason 更新，since 不变（粘滞首次观测）
  reg.mark(CLAIM_KEY, "第二次原因");
  const second = findKey(reg, CLAIM_KEY);
  assert.ok(second, "重复 mark 后应仍存在");
  assert.equal(second.reason, "第二次原因");
  assert.equal(second.since, first.since);
  reg.clear(CLAIM_KEY);
  assert.equal(findKey(reg, CLAIM_KEY), undefined);
});

test("①②③ 心跳超期清算：坏配置 ⇒ mark（带原因）；修好 ⇒ clear；返回空结果语义不变", () => {
  const reg = new DegradationRegistry();
  let broken = true;
  const config = (): MachinesConfig => {
    if (broken) throw new Error("config 不可读");
    return cfg();
  };
  const handle = makeHandle(reg, config, fakeStore({ listRunners: () => [] }));

  const res = handle.sweepStale();
  assert.deepEqual(res, { offlineRunners: [], requeuedTasks: [] }, "降级返回值语义不变");
  const item = findKey(reg, HEARTBEAT_KEY);
  assert.ok(item, "坏配置期间 degraded[] 应出现心跳清算项");
  assert.match(item.reason, /心跳超期清算读取配置失败/);

  broken = false;
  const ok = handle.sweepStale();
  assert.deepEqual(ok, { offlineRunners: [], requeuedTasks: [] });
  assert.equal(findKey(reg, HEARTBEAT_KEY), undefined, "修好后该项应消失");
});

test("①② 心跳清算：Runner 注册表读取失败 ⇒ mark；成功 tick ⇒ clear", () => {
  const reg = new DegradationRegistry();
  let broken = true;
  const store = fakeStore({
    listRunners: () => {
      if (broken) throw new Error("db down");
      return [];
    },
  });
  const handle = makeHandle(reg, cfg, store);

  handle.sweepStale();
  assert.ok(findKey(reg, HEARTBEAT_KEY), "读库失败应标降级");
  broken = false;
  handle.sweepStale();
  assert.equal(findKey(reg, HEARTBEAT_KEY), undefined, "成功 tick 应清除降级");
});

test("①② 孤儿墙钟清算：在飞任务读取失败 ⇒ mark；成功 tick ⇒ clear", () => {
  const reg = new DegradationRegistry();
  let broken = true;
  const store = fakeStore({
    listOrphanedTasks: () => {
      if (broken) throw new Error("db down");
      return [];
    },
  });
  const handle = makeHandle(reg, cfg, store);

  const res = handle.sweepOrphanedTasks();
  assert.deepEqual(res, { orphanedTasks: [] }, "降级返回值语义不变");
  assert.ok(findKey(reg, ORPHAN_KEY), "读库失败应标降级");
  broken = false;
  handle.sweepOrphanedTasks();
  assert.equal(findKey(reg, ORPHAN_KEY), undefined, "成功 tick 应清除降级");
});

test("④ 看护 owner 门闩接线：停用 ⇒ degraded 增 watcher 项；恢复 ⇒ 消失", () => {
  const reg = new DegradationRegistry();
  setTaskWatcherDegradationSink(reg);
  try {
    setTaskWatcherEnabled(false);
    assert.equal(isTaskWatcherEnabled(), false);
    const item = findKey(reg, TASK_WATCHER_DEGRADED_KEY);
    assert.ok(item, "follower 停用期间应出现 watcher 降级项");
    assert.match(item.reason, /owner 门闩停用/);

    setTaskWatcherEnabled(true);
    assert.equal(findKey(reg, TASK_WATCHER_DEGRADED_KEY), undefined, "恢复后 watcher 项应消失");
  } finally {
    setTaskWatcherDegradationSink({ mark: () => {}, clear: () => {} });
    setTaskWatcherEnabled(true);
  }
});

const fakeCore = (): BridgeCore => ({}) as unknown as BridgeCore;

async function health(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "GET" });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status ?? 0, body };
}

test("③ /health：注入降级快照 ⇒ degraded[] 带项且仍 200 / status=ok；未注入 ⇒ 空数组", async () => {
  const reg = new DegradationRegistry();
  reg.mark(HEARTBEAT_KEY, "心跳超期清算读取配置失败：boom");
  const transports: HttpTransportHandle[] = [];

  const withDegraded = await startHttpTransport({
    core: fakeCore(),
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    isReady: () => true,
    role: () => "owner",
    version: "test",
    onShutdown: () => {},
    degraded: () => reg.snapshot(),
  });
  transports.push(withDegraded);
  const h1 = await health(withDegraded.port);
  assert.equal(h1.status, 200, "降级期间 /health 仍 200");
  assert.equal(h1.body.status, "ok", "status 语义不变");
  assert.equal(h1.body.role, "owner");
  const degraded = h1.body.degraded as Array<Record<string, unknown>>;
  assert.equal(degraded.length, 1);
  const item = degraded[0];
  assert.ok(item);
  assert.equal(item.key, HEARTBEAT_KEY);
  assert.equal(item.reason, "心跳超期清算读取配置失败：boom");
  assert.equal(typeof item.since, "number");

  const bare = await startHttpTransport({
    core: fakeCore(),
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    isReady: () => true,
    role: () => "owner",
    version: "test",
    onShutdown: () => {},
  });
  transports.push(bare);
  const h2 = await health(bare.port);
  assert.equal(h2.status, 200);
  assert.deepEqual(h2.body.degraded, [], "未注入 getter ⇒ 空数组");

  for (const t of transports) await t.close();
});
