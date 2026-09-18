/**
 * `machine/scripts/reaper.mjs` 闸门判据单元测试（`node:test`，无新依赖）· 节点 M6·MC2。
 *
 * 直接 import（动态 URL）脚本源码，仅调用其**导出的纯函数**（`main` 有 direct-run 守卫，
 * import 不触发任何 IO）。覆盖：
 * - 新鲜度 N = max(2×POLL_TIMEOUT_MS, 90s) 与时钟回拨语义；
 * - **5 档闸门逐档**：pidfile-alive / runner-live / state-undecidable / health-live / reapable；
 * - 两条关键验收场景：`pid 存活 + state 新鲜 = 零组杀`、`state 陈旧 + pid 死 = 正常清`。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

interface GateDecision {
  tier: string;
  canClean: boolean;
  detail: string;
}

interface GateInput {
  pidfileAlive: boolean;
  runnerState: unknown;
  runnerStateDegraded?: boolean;
  isAlive: (pid: number) => boolean;
  nowMs: number;
  freshMs?: number;
  healthState?: string;
}

interface ReaperGateModule {
  RUNNER_STATE_FRESH_MS: number;
  isRunnerStateFresh(state: unknown, nowMs: number, freshMs?: number): boolean;
  runnerStatePidOf(state: unknown): number | null;
  decideGate(input: GateInput): GateDecision;
}

/** 编译产物在 `machine/dist/test/`，上溯两级即 `machine/scripts/reaper.mjs` */
const REAPER_URL = new URL("../../scripts/reaper.mjs", import.meta.url);
const reaper = (await import(REAPER_URL.href)) as unknown as ReaperGateModule;

const NOW = Date.parse("2026-09-18T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const NEVER_ALIVE = (): boolean => false;

function runnerState(pid: number, lastPollAt: string | null): Record<string, unknown> {
  return {
    machineId: "m-test",
    pid,
    port: 3100,
    registeredAt: null,
    lastHeartbeatAt: null,
    lastPollAt,
    lastError: null,
    inflightCount: 0,
    selfCheck: { ok: true, failures: [] },
    updatedAt: lastPollAt ?? iso(NOW),
  };
}

test("新鲜度 N：max(2×30s, 90s) = 90s", () => {
  assert.equal(reaper.RUNNER_STATE_FRESH_MS, 90_000);
});

test("新鲜度判定：窗口内新鲜 / 超窗陈旧 / 边界不含 / 时钟回拨视为新鲜 / 不可判不新鲜", () => {
  // 窗口内
  assert.equal(reaper.isRunnerStateFresh(runnerState(1, iso(NOW - 1_000)), NOW), true);
  // 恰好等于 N（不算新鲜）
  assert.equal(reaper.isRunnerStateFresh(runnerState(1, iso(NOW - 90_000)), NOW), false);
  // 超窗
  assert.equal(reaper.isRunnerStateFresh(runnerState(1, iso(NOW - 90_001)), NOW), false);
  // 时钟回拨 / 时间在未来 ⇒ 视为新鲜
  assert.equal(reaper.isRunnerStateFresh(runnerState(1, iso(NOW + 5_000)), NOW), true);
  // 取 max(lastHeartbeatAt, lastPollAt)
  const state = { lastHeartbeatAt: iso(NOW - 1_000), lastPollAt: iso(NOW - 500_000) };
  assert.equal(reaper.isRunnerStateFresh(state, NOW), true);
  // 两时间戳均不可判 ⇒ 不新鲜
  assert.equal(reaper.isRunnerStateFresh({ lastHeartbeatAt: null, lastPollAt: null }, NOW), false);
  assert.equal(
    reaper.isRunnerStateFresh({ lastHeartbeatAt: "not-a-date", lastPollAt: "" }, NOW),
    false,
  );
  // 非对象 / null
  assert.equal(reaper.isRunnerStateFresh(null, NOW), false);
});

test("runnerStatePidOf：仅接受正整数 / 安全整数", () => {
  assert.equal(reaper.runnerStatePidOf(runnerState(4321, null)), 4321);
  assert.equal(reaper.runnerStatePidOf({ pid: 0 }), null);
  assert.equal(reaper.runnerStatePidOf({ pid: -1 }), null);
  assert.equal(reaper.runnerStatePidOf({ pid: "4321" }), null);
  assert.equal(reaper.runnerStatePidOf(null), null);
});

test("闸门档 ①：pidfile pid 存活 ⇒ 禁清（红线，优先于一切）", () => {
  const gate = reaper.decideGate({
    pidfileAlive: true,
    runnerState: null,
    runnerStateDegraded: false,
    isAlive: NEVER_ALIVE,
    nowMs: NOW,
    healthState: "unreachable",
  });
  assert.equal(gate.tier, "pidfile-alive");
  assert.equal(gate.canClean, false);
});

test("闸门档 ②：runner-state 新鲜 + pid 存活 ⇒ 活 Runner，禁清（零组杀）", () => {
  const gate = reaper.decideGate({
    pidfileAlive: false,
    runnerState: runnerState(4321, iso(NOW - 1_000)),
    runnerStateDegraded: false,
    isAlive: (pid) => pid === 4321,
    nowMs: NOW,
    healthState: "unreachable",
  });
  assert.equal(gate.tier, "runner-live");
  assert.equal(gate.canClean, false);
});

test("闸门档 ②（边界）：state 陈旧时即使 pid 存活也不认活 Runner（回落可清档）", () => {
  const gate = reaper.decideGate({
    pidfileAlive: false,
    runnerState: runnerState(4321, iso(NOW - 200_000)),
    runnerStateDegraded: false,
    isAlive: (pid) => pid === 4321,
    nowMs: NOW,
    healthState: "unreachable",
  });
  assert.equal(gate.tier, "reapable");
  assert.equal(gate.canClean, true);
});

test("闸门档 ③：runner-state 存在但不可解析 ⇒ 禁清（宁漏勿误杀）", () => {
  const gate = reaper.decideGate({
    pidfileAlive: false,
    runnerState: null,
    runnerStateDegraded: true,
    isAlive: NEVER_ALIVE,
    nowMs: NOW,
    healthState: "unreachable",
  });
  assert.equal(gate.tier, "state-undecidable");
  assert.equal(gate.canClean, false);
});

test("闸门档 ④：/health 可达（次要佐证）⇒ 禁清", () => {
  for (const healthState of ["starting", "not-ready", "ready"]) {
    const gate = reaper.decideGate({
      pidfileAlive: false,
      runnerState: runnerState(4321, iso(NOW - 500_000)),
      runnerStateDegraded: false,
      isAlive: NEVER_ALIVE,
      nowMs: NOW,
      healthState,
    });
    assert.equal(gate.tier, "health-live", `healthState=${healthState}`);
    assert.equal(gate.canClean, false);
  }
});

test("闸门档 ⑤：state 陈旧 + pid 死 + /health 不可达 ⇒ 允许清理（正常清）", () => {
  // 有 state 但陈旧、其 pid 已死
  const withState = reaper.decideGate({
    pidfileAlive: false,
    runnerState: runnerState(4321, iso(NOW - 500_000)),
    runnerStateDegraded: false,
    isAlive: NEVER_ALIVE,
    nowMs: NOW,
    healthState: "unreachable",
  });
  assert.equal(withState.tier, "reapable");
  assert.equal(withState.canClean, true);

  // 旧行为兼容：无 state 文件（首次运行 / 尚未落盘）亦走可清档
  const withoutState = reaper.decideGate({
    pidfileAlive: false,
    runnerState: null,
    runnerStateDegraded: false,
    isAlive: NEVER_ALIVE,
    nowMs: NOW,
    healthState: "unreachable",
  });
  assert.equal(withoutState.tier, "reapable");
  assert.equal(withoutState.canClean, true);
});

test("闸门档 ⑤（未探测 health）：healthState 缺省不阻断可清", () => {
  const gate = reaper.decideGate({
    pidfileAlive: false,
    runnerState: null,
    runnerStateDegraded: false,
    isAlive: NEVER_ALIVE,
    nowMs: NOW,
  });
  assert.equal(gate.tier, "reapable");
  assert.equal(gate.canClean, true);
});
