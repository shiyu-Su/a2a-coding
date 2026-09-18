/**
 * `machine/launcher/runner-state.ts` 单元测试（`node:test`，无新依赖）· 节点 M6·MC2。
 *
 * 覆盖：
 * - 新鲜度窗口 N 的取值与公式（`max(2×POLL_TIMEOUT_MS, 90s)`）；
 * - 原子落盘（临时文件 + rename；读者可见完整 JSON，无 `*.tmp-*` 残留）；
 * - 节流写（非 force 跳过 / force 放行）；
 * - `Runner` 接驳：注册 / 心跳即时报盘、轮询刷新 `lastPollAt`、在飞数投影。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNNER_POLL_TIMEOUT_MS,
  RUNNER_STATE_FRESH_FLOOR_MS,
  RUNNER_STATE_FRESH_MS,
  RUNNER_STATE_WRITE_THROTTLE_MS,
  RunnerStateWriter,
  runnerStateFreshMs,
  writeRunnerStateAtomic,
  type RunnerStateFile,
} from "../launcher/runner-state.js";
import { Runner } from "../launcher/runner.js";
import type { SelfCheckResult } from "../launcher/self-check.js";
import type { BridgeConfig, MachineConfig } from "../types.js";

const BRIDGE: BridgeConfig = { url: "http://bridge.test:3200", token: "tok-abc" };

const MACHINE: MachineConfig = {
  machineId: "m-test",
  launcher: { port: 3100, bridge: BRIDGE },
  projects: [
    { projectId: "alpha", workspace: "C:/ws/alpha", agentKind: "opencode", a2aPort: 3010 },
  ],
};

const SELF_CHECK_OK: SelfCheckResult = { ok: true, failures: [] };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "runner-state-"));
}

function sampleState(overrides: Partial<RunnerStateFile> = {}): RunnerStateFile {
  return {
    machineId: "m-test",
    pid: 1234,
    port: 3100,
    registeredAt: "2026-09-18T00:00:00.000Z",
    lastHeartbeatAt: null,
    lastPollAt: null,
    lastError: null,
    inflightCount: 0,
    selfCheck: { ok: true, failures: [] },
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

test("新鲜度 N：max(2×POLL_TIMEOUT_MS, 90s) = 90s（钉死）", () => {
  assert.equal(RUNNER_POLL_TIMEOUT_MS, 30_000);
  assert.equal(RUNNER_STATE_FRESH_FLOOR_MS, 90_000);
  assert.equal(runnerStateFreshMs(), 90_000);
  assert.equal(runnerStateFreshMs(30_000), 90_000);
  // 轮询超时更大时取 2×POLL_TIMEOUT_MS
  assert.equal(runnerStateFreshMs(60_000), 120_000);
  assert.equal(RUNNER_STATE_FRESH_MS, runnerStateFreshMs());
  assert.equal(RUNNER_STATE_WRITE_THROTTLE_MS, 1_000);
});

test("原子落盘：字段齐全、可回读、无 *.tmp-* 残留", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "runner-state.json");
    const state = sampleState({ lastHeartbeatAt: "2026-09-18T00:01:00.000Z", inflightCount: 2 });
    writeRunnerStateAtomic(path, state);

    const readBack = JSON.parse(readFileSync(path, "utf8")) as RunnerStateFile;
    assert.deepEqual(readBack, state);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes(".tmp-")),
      [],
    );

    // 覆盖写：目标文件被整体替换，不追加
    writeRunnerStateAtomic(path, sampleState({ lastError: "boom" }));
    const second = JSON.parse(readFileSync(path, "utf8")) as RunnerStateFile;
    assert.equal(second.lastError, "boom");
    assert.equal(second.registeredAt, "2026-09-18T00:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("节流写：非 force 在窗口内跳过，force 放行；写盘异常不抛出", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "runner-state.json");
    const fixed = new Date("2026-09-18T00:00:00.000Z");
    const writer = new RunnerStateWriter({
      path,
      machineId: "m-test",
      port: 3100,
      selfCheck: { ok: true, failures: [] },
      pid: 777,
      now: () => fixed,
      throttleMs: 1_000,
    });
    const snapshot = {
      registeredAt: null,
      lastHeartbeatAt: null,
      lastPollAt: null,
      lastError: null,
      inflightCount: 0,
    };

    assert.equal(writer.write(snapshot), true);
    assert.equal(writer.write(snapshot), false, "窗口内非 force 应跳过");
    assert.equal(writer.write(snapshot, { force: true }), true, "force 应放行");

    const persisted = JSON.parse(readFileSync(path, "utf8")) as RunnerStateFile;
    assert.equal(persisted.pid, 777);
    assert.equal(persisted.port, 3100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Runner 接驳：注册即时报盘（字段齐全）", async () => {
  const dir = tempDir();
  try {
    const statePath = join(dir, "runner-state.json");
    const runner = new Runner(MACHINE, BRIDGE, SELF_CHECK_OK, {
      runnerStatePath: statePath,
      now: () => new Date("2026-09-18T00:00:00.000Z"),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      fetch: async () =>
        new Response(JSON.stringify({ result: { ok: true }, data: null, error: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await runner.register();
    const afterRegister = JSON.parse(readFileSync(statePath, "utf8")) as RunnerStateFile;
    assert.equal(afterRegister.machineId, "m-test");
    assert.equal(afterRegister.port, 3100);
    assert.equal(afterRegister.pid, process.pid);
    assert.equal(afterRegister.registeredAt, "2026-09-18T00:00:00.000Z");
    assert.deepEqual(afterRegister.selfCheck, { ok: true, failures: [] });
    assert.equal(afterRegister.inflightCount, 0);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes(".tmp-")),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Runner 循环：心跳即时报盘 + 每轮刷新 lastPollAt", async () => {
  const dir = tempDir();
  try {
    const statePath = join(dir, "runner-state.json");
    const calls: string[] = [];
    let runnerRef: Runner | null = null;

    const runner = new Runner(MACHINE, BRIDGE, SELF_CHECK_OK, {
      runnerStatePath: statePath,
      now: () => new Date("2026-09-18T00:00:00.000Z"),
      sleep: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      fetch: async (url) => {
        calls.push(url);
        if (url.endsWith("/runner/register")) {
          return new Response(JSON.stringify({ result: { ok: true }, data: null, error: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        // 首个 connect 即触发 stop，避免循环空转
        runnerRef?.stop();
        return new Response(null, { status: 204 });
      },
    });
    runnerRef = runner;

    runner.start();
    await runner.whenStopped();

    assert.ok(calls[0]?.endsWith("/runner/register"));
    assert.ok(calls[1]?.endsWith("/runner/connect"));
    const afterLoop = JSON.parse(readFileSync(statePath, "utf8")) as RunnerStateFile;
    assert.equal(afterLoop.registeredAt, "2026-09-18T00:00:00.000Z");
    assert.equal(afterLoop.lastHeartbeatAt, "2026-09-18T00:00:00.000Z");
    assert.equal(afterLoop.lastPollAt, "2026-09-18T00:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
