/**
 * v0.9.5 · T9 用例（离线）：**锚对账后半（C6-C7/C8/C10 部分）+ 判定表行为变更登记核对**。
 *
 * 事实源：改造文档 `doc/v0.9.5/推进流程精简-改造文档.md` §2-C6（锚对账）/ §2-C7 / §2-C8 / §2-C10、
 * §3.1 判定表（v3 修正：`succeeded + executing` 按 suspend 条目分流监视）、§4 验收标准。
 *
 * 本文件**只补齐 T7/T8/T11 未覆盖的锚**，不重复既有用例：
 * - ① **判定表行为变更登记核对**：完整六行表驱动（行为变更行 = `succeeded + executing` 分流监视；
 *      其余五档 `awaiting_answer` / `failed` / `timeout` / `canceled` / `reviewing` 逐字冻结）；
 * - ② **监视归属接线**（C8 规格④ / MON2）：接力决策后经 `onMonitor` 告知 auto / suspend / none，
 *      `canceled` 短路（判定序③）⇒ **不发任何归属通知**；
 * - ③ **`BoardHostFace.wakeTurn`**（C8 唤醒点火面，T8 只测了 `relay.fireWake` 的驱动器层）；
 * - ④ **心跳定时器 `unref()`**（R2 规格①；T8-⑬ 只测了 start/stop，未钉 unref）；
 * - ⑤ **`sweepIdle` 失败容错**（空闲回收异常不得阻断监视；T8-⑧ 只测成功拍）；
 * - ⑥ `parseSuspendForm` 边界（wakeCond **恰好** 400 字节通过 / 401 拒、未知字段忽略）；
 * - ⑦ suspended 台账 **best-effort 落盘**：写失败不得反噬内存事实源（C7「取证面不决定链条生死」）；
 * - ⑧ 组织种子化 **逐组织 fail-open / 根不代建**（C10；T11 测单组织，本处补多组织回填面）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostRelay, shouldContinue } from "../dist/host-relay.js";
import { createHostFace } from "../dist/host-face.js";
import { createHeartbeat } from "../dist/heartbeat.js";
import {
  MAX_SUSPEND_WAKE_COND_BYTES,
  SUSPEND_FORM_INVALID_CODE,
  parseSuspendForm,
} from "../dist/write-guard.js";
import { SuspendLedgerStore } from "../dist/suspend-ledger.js";
import {
  AGENTS_TEMPLATE_FILE,
  backfillOrgWorkspaces,
  orgsToBackfill,
  resolveOrgSeedOptions,
} from "../dist/org-seed.js";

const snap = (state, over = {}) => ({ state, stage: "改造", approval: "已通过", ...over });

function turnResult(over = {}) {
  return {
    turnId: "turn-1",
    requirementId: "F1",
    org: "g",
    contextId: "ctx-1",
    state: "succeeded",
    kind: "succeeded",
    ...over,
  };
}

function fakeSubmitted(over = {}) {
  return {
    turnId: "turn-x",
    requirementId: "F1",
    contextId: "ctx-1",
    round: 1,
    queued: false,
    position: 1,
    display: "进行中",
    occupant: null,
    done: Promise.resolve({}),
    ...over,
  };
}

async function waitUntil(predicate, limit = 500) {
  for (let i = 0; i < limit; i += 1) {
    if (predicate()) return true;
    await new Promise((res) => setImmediate(res));
  }
  return false;
}

// ---------------------------------------------------------------------------
// ① 判定表行为变更登记核对（§3.1 v3）
// ---------------------------------------------------------------------------

test("T9-① 判定表六行表驱动：行为变更行（succeeded+executing 分流监视）+ 其余五档逐字冻结", () => {
  // 每行 = {轮态, 引擎态, suspend 条目, 期望动作/方式/监视种类}
  // 「行为变更行」= v3 修正点：succeeded + 执行中不再「立即续」，而按 suspend 条目分流进监视。
  const ROWS = [
    // —— 其余五档（冻结，不得回归为 continue）——
    { name: "awaiting_answer × 执行中", outcome: "awaiting_answer", engine: snap("executing"), suspend: undefined, action: "stop", mode: null, monitor: null },
    { name: "failed × 执行中", outcome: "failed", engine: snap("executing"), suspend: undefined, action: "stop", mode: null, monitor: null },
    { name: "timeout × 执行中", outcome: "timeout", engine: snap("executing"), suspend: undefined, action: "stop", mode: null, monitor: null },
    { name: "canceled × reviewing", outcome: "canceled", engine: snap("reviewing"), suspend: undefined, action: "stop", mode: null, monitor: null },
    { name: "canceled × 执行中 + 有条目", outcome: "canceled", engine: snap("executing"), suspend: { pendingCount: 1 }, action: "stop", mode: null, monitor: null },
    { name: "succeeded × reviewing", outcome: "succeeded", engine: snap("reviewing"), suspend: undefined, action: "stop", mode: null, monitor: null },
    { name: "succeeded × 终态 completed", outcome: "succeeded", engine: snap("completed"), suspend: undefined, action: "stop", mode: null, monitor: null },
    { name: "succeeded × waiting_approval", outcome: "succeeded", engine: snap("waiting_approval"), suspend: undefined, action: "stop", mode: null, monitor: null },
    // —— 行为变更行：succeeded + 执行中 ⇒ 续 + 进监视（分流）——
    { name: "succeeded × 执行中 × 无条目 ⇒ auto 监视", outcome: "succeeded", engine: snap("executing"), suspend: undefined, action: "continue", mode: "monitor", monitor: "auto" },
    { name: "succeeded × 执行中 × 有挂起条目 ⇒ suspend 监视", outcome: "succeeded", engine: snap("executing"), suspend: { pendingCount: 2 }, action: "continue", mode: "monitor", monitor: "suspend" },
    { name: "succeeded × 执行中 × 空 pending 条目 ⇒ suspend 监视", outcome: "succeeded", engine: snap("executing"), suspend: { pendingCount: 0 }, action: "continue", mode: "monitor", monitor: "suspend" },
  ];

  for (const row of ROWS) {
    const d = shouldContinue({ state: row.outcome }, row.engine, row.suspend);
    assert.equal(d.action, row.action, `${row.name}：action`);
    assert.equal(d.mode, row.mode, `${row.name}：mode`);
    assert.equal(d.monitor, row.monitor, `${row.name}：monitor`);
  }

  // 非收口态 / 未知 / 无信号 / 引擎读面失败 ⇒ 保守停（不属于 §3.1 六行，但同属判定表兜底）
  for (const state of ["queued", "running"]) {
    assert.equal(shouldContinue({ state }, snap("executing")).action, "stop", `${state} 非收口态 ⇒ 停`);
  }
  assert.equal(shouldContinue({ state: "succeeded" }, null).action, "stop", "引擎读面失败 ⇒ 保守停");
  assert.equal(shouldContinue(null, snap("executing")).action, "stop", "无轮收口信号 ⇒ 停");
});

// ---------------------------------------------------------------------------
// ② 监视归属通知（C8 规格④ / MON2）
// ---------------------------------------------------------------------------

test("T9-② onMonitor 接线：auto / suspend / none 三分；canceled 短路不发通知", async () => {
  const mk = (probe, over = {}) => {
    const notices = [];
    const relay = createHostRelay({
      submitTurn: () => fakeSubmitted(),
      probe: { async fetchEngineState() { return probe; } },
      onMonitor: (n) => notices.push(n),
      ...over,
    });
    return { relay, notices };
  };

  // auto：succeeded + 执行中 + 无条目
  {
    const { relay, notices } = mk(snap("executing"));
    relay.handleTurnSettled(turnResult());
    await waitUntil(() => notices.length === 1);
    assert.deepEqual(notices[0], { featureId: "F1", kind: "auto", org: "g", stage: "改造" });
  }
  // suspend：succeeded + 执行中 + 显式挂起条目
  {
    const { relay, notices } = mk(snap("executing"), { suspendLookup: () => ({ pendingCount: 1 }) });
    relay.handleTurnSettled(turnResult());
    await waitUntil(() => notices.length === 1);
    assert.equal(notices[0].kind, "suspend");
  }
  // none：succeeded + reviewing ⇒ 交人停链，撤销任何自动目标
  {
    const { relay, notices } = mk(snap("reviewing"));
    relay.handleTurnSettled(turnResult());
    await waitUntil(() => notices.length === 1);
    assert.equal(notices[0].kind, "none");
  }
  // canceled：判定序③ 短路 ⇒ 不查探针、不发归属通知（否则停链自激）
  {
    let probed = 0;
    const notices = [];
    const relay = createHostRelay({
      submitTurn: () => fakeSubmitted(),
      probe: { async fetchEngineState() { probed += 1; return snap("executing"); } },
      onMonitor: (n) => notices.push(n),
    });
    relay.handleTurnSettled(turnResult({ state: "canceled", kind: "canceled" }));
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    assert.equal(probed, 0, "canceled 短路，不查引擎态探针");
    assert.deepEqual(notices, [], "canceled 不发监视归属通知");
  }
});

// ---------------------------------------------------------------------------
// ③ BoardHostFace.wakeTurn（C8 唤醒点火面）
// ---------------------------------------------------------------------------

function wakeFace(over = {}) {
  const calls = { submit: 0 };
  const turns = {
    submitTurn() {
      calls.submit += 1;
      return fakeSubmitted({ turnId: "turn-wake", round: 7 });
    },
    setTurnSettledHandler() {},
    latestTurnOf() {
      return null;
    },
    findAwaitingTurn() {
      return null;
    },
    busyTurnOf() {
      return null;
    },
    ...over.turns,
  };
  const deps = {
    bridges: {
      async ensureStarted() {
        return { ok: true, status: { state: "running", pid: 1, port: 9101, kind: "claude", display: "ok", error: null }, reused: true };
      },
      async stop() {
        return null;
      },
      statuses() {
        return [];
      },
      async health() {
        return null;
      },
    },
    turns,
    orgsDir: "C:/orgs",
    defaultOrg: over.defaultOrg === undefined ? "g" : over.defaultOrg,
    dirKind: () => "dir",
  };
  return { face: createHostFace(deps), calls };
}

test("T9-③ wakeTurn：已装配接力 ⇒ 经同一刹车点火（ok + turnId/round）；未装配 / 标识缺失 / 组织未定 ⇒ 结构化 false", () => {
  // 已装配
  const { face, calls } = wakeFace();
  assert.ok(face.startRelay() !== null);
  const ok = face.wakeTurn({ featureId: "F1", org: "g", prompt: "唤醒提示词" });
  assert.equal(ok.ok, true);
  assert.equal(ok.turnId, "turn-wake");
  assert.equal(ok.round, 7);
  assert.equal(calls.submit, 1);

  // 组织留空 ⇒ 回落板级默认（defaultOrg="g"）
  const first = fakeSubmitted({ turnId: "turn-2", round: 8 });
  const { face: face2 } = wakeFace();
  face2.startRelay();
  assert.equal(face2.wakeTurn({ featureId: "F1", org: "", prompt: "p" }).ok, true);

  // 标识缺失（先于组织解析）
  assert.deepEqual(face.wakeTurn({ featureId: "  ", org: "g", prompt: "p" }), { ok: false, reason: "request_invalid" });

  // 组织未定：org 空且无板级默认 ⇒ 不猜
  const { face: face3 } = wakeFace({ defaultOrg: null });
  face3.startRelay();
  assert.deepEqual(face3.wakeTurn({ featureId: "F1", org: "", prompt: "p" }), { ok: false, reason: "org_not_resolved" });

  // 未装配接力（轮管理器不支持收口回调）⇒ relay_not_assembled，不假装已点火
  const { face: face4 } = wakeFace({ turns: { setTurnSettledHandler: undefined } });
  assert.equal(face4.startRelay(), null);
  assert.deepEqual(face4.wakeTurn({ featureId: "F1", org: "g", prompt: "p" }), { ok: false, reason: "relay_not_assembled" });
});

// ---------------------------------------------------------------------------
// ④ 心跳定时器 unref（R2 规格①）
// ---------------------------------------------------------------------------

test("T9-④ 心跳 start() 建定时器并调 unref（不握进程退出）；stop() 后 isRunning=false", () => {
  const hb = createHeartbeat({
    ledger: { list: () => [], get: () => null, recordFired: () => false },
    readEngine: async () => null,
    readTaskState: async () => null,
    fire: () => ({ ok: true, reason: "fired" }),
    relay: { chainCount: () => 0, chainLimit: () => 10, isChainStopped: () => false },
    sweepIdle: async () => [],
    intervalMs: 3_600_000,
  });

  const original = globalThis.setInterval;
  let created = 0;
  let unrefCalled = 0;
  globalThis.setInterval = (...args) => {
    created += 1;
    const handle = original(...args);
    const realUnref = handle.unref.bind(handle);
    handle.unref = () => {
      unrefCalled += 1;
      return realUnref();
    };
    return handle;
  };
  try {
    hb.start();
    assert.equal(created, 1, "start 恰好建一个定时器");
    assert.equal(unrefCalled, 1, "必须 unref（否则常驻句柄握进程，板不可优雅退出）");
    assert.equal(hb.isRunning(), true);
    hb.stop();
    assert.equal(hb.isRunning(), false);
  } finally {
    hb.stop();
    globalThis.setInterval = original;
  }
});

// ---------------------------------------------------------------------------
// ⑤ sweepIdle 失败容错（空闲回收异常不阻断监视）
// ---------------------------------------------------------------------------

test("T9-⑤ sweepIdle 抛错 ⇒ 本拍 still 继续扫台账并点火（回收失败不和监视绑死）", async () => {
  const fires = [];
  const ledger = {
    list: () => [{ featureId: "F1", turnId: "t", contextId: "c", pending: ["t1"], firedKeys: [] }],
    get: () => null,
    recordFired: () => true,
  };
  const hb = createHeartbeat({
    ledger,
    readEngine: async () => ({ state: "executing", stage: "需求分析", approval: "已通过", ownerGroup: "o" }),
    readTaskState: async () => "completed",
    fire: (i) => {
      fires.push(i);
      return { ok: true, reason: "fired" };
    },
    relay: { chainCount: () => 0, chainLimit: () => 10, isChainStopped: () => false },
    sweepIdle: async () => {
      throw new Error("空闲回收失败（假）");
    },
  });
  const report = await hb.tick();
  assert.equal(report.skipped, false);
  assert.deepEqual(report.swept, [], "回收失败 ⇒ 本拍回收结果为空，但拍不跳过");
  assert.equal(fires.length, 1, "监视照常命中点火");
  assert.equal(report.fired.length, 1);
});

// ---------------------------------------------------------------------------
// ⑥ parseSuspendForm 边界
// ---------------------------------------------------------------------------

test("T9-⑥ parseSuspendForm：wakeCond 恰好 400 字节通过 / 401 拒；未知字段忽略", () => {
  const exact = parseSuspendForm(new URLSearchParams({ turnId: "t", wakeCond: "a".repeat(MAX_SUSPEND_WAKE_COND_BYTES) }).toString());
  assert.equal(exact.ok, true);
  assert.equal(exact.wakeCond.length, MAX_SUSPEND_WAKE_COND_BYTES);

  const over = parseSuspendForm(new URLSearchParams({ turnId: "t", wakeCond: "a".repeat(MAX_SUSPEND_WAKE_COND_BYTES + 1) }).toString());
  assert.equal(over.ok, false);
  assert.equal(over.status, 400);
  assert.equal(over.code, SUSPEND_FORM_INVALID_CODE);

  const unknown = parseSuspendForm(new URLSearchParams({ turnId: "t", foo: "bar" }).toString());
  assert.equal(unknown.ok, true);
  assert.deepEqual(unknown.pending, []);
});

// ---------------------------------------------------------------------------
// ⑦ suspended 台账 best-effort 落盘（取证面不决定链条生死）
// ---------------------------------------------------------------------------

test("T9-⑦ 台账落盘失败 ⇒ arm/list/recordFired 仍按内存事实源工作（不反噬在飞挂起链）", () => {
  const root = mkdtempSync(join(tmpdir(), "board-t9-ledger-"));
  try {
    // 用一个**普通文件**占住父路径 ⇒ writeFileAtomic 的 mkdirSync / rename 必失败。
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "x", "utf8");
    const file = join(blocker, "sub", "suspended.json"); // 父路径是文件，落盘必失败
    const store = new SuspendLedgerStore(file); // 构造即 reset→persist（失败被吞）

    const entry = store.arm({ featureId: "F1", turnId: "t", contextId: "c", pending: ["t1"] }, "2026-09-28T00:00:00Z");
    assert.equal(entry.featureId, "F1");
    assert.deepEqual(store.list().map((e) => e.featureId), ["F1"], "内存事实源照常");
    assert.equal(store.recordFired("F1", "k1"), true, "去重位照常入库（不因落盘失败而丢）");
    assert.deepEqual(store.get("F1").firedKeys, ["k1"]);
    assert.equal(store.clear("F1"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑧ 组织种子化回填：逐组织 fail-open / 根不代建
// ---------------------------------------------------------------------------

const SPEC_MAIN = "# 需求流程\n\n> **规范版本戳**：v9.9.9（2099-01-01）\n\n正文 A\n";

function seedFixture() {
  const root = mkdtempSync(join(tmpdir(), "board-t9-seed-"));
  const templateRoot = join(root, "templates");
  mkdirSync(templateRoot, { recursive: true });
  writeFileSync(join(templateRoot, AGENTS_TEMPLATE_FILE), "# {ORG_NAME} 工作区\nstamp={FLOW_SPEC_STAMP}\n", "utf8");
  const repoRoot = join(root, "repo");
  mkdirSync(join(repoRoot, "flow", "spec"), { recursive: true });
  writeFileSync(join(repoRoot, "flow", "spec", "需求流程.md"), SPEC_MAIN, "utf8");
  const orgsDir = join(root, "orgs");
  mkdirSync(orgsDir, { recursive: true });
  const options = resolveOrgSeedOptions({ templateRoot, repoRoot, boardVersion: "9.9.9", hostKind: "opencode" }, {});
  return { root, orgsDir, options };
}

test("T9-⑧ 回填逐组织 fail-open：单组织落盘失败只告警、其余组织照补；根不是目录 ⇒ 整体跳过不代建", () => {
  const f = seedFixture();
  try {
    // 好组织 + 坏组织（目录位被普通文件占用）
    mkdirSync(join(f.orgsDir, "好组"), { recursive: true });
    writeFileSync(join(f.orgsDir, "坏组"), "占位文件", "utf8");

    const r = backfillOrgWorkspaces({
      orgsDir: f.orgsDir,
      disk: ["好组", "坏组"],
      ledger: [],
      disabled: [],
      options: f.options,
    });
    assert.deepEqual([...r.orgs].sort(), ["好组", "坏组"].sort());
    assert.match(readFileSync(join(f.orgsDir, "好组", "AGENTS.md"), "utf8"), /# 好组 工作区/);
    assert.ok(r.warnings.some((w) => w.code === "board_org_seed_write_failed" && w.org === "坏组"), "坏组 fail-open 告警");

    // orgsDir 根本身是普通文件 ⇒ 回填整体跳过（不把根建出来）
    const asFile = join(f.root, "root-is-file");
    writeFileSync(asFile, "x", "utf8");
    const skipped = backfillOrgWorkspaces({ orgsDir: asFile, disk: [], ledger: ["台账组"], disabled: [], options: f.options });
    assert.deepEqual(skipped, { orgs: [], results: [], warnings: [] });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("T9-⑧b orgsToBackfill：剔空名与点段（. / ..）后再并集去重", () => {
  assert.deepEqual(
    orgsToBackfill({ disk: ["", "  ", ".", "..", "甲"], ledger: ["乙", "甲", "  "] , disabled: [] }),
    ["乙", "甲"].sort(),
  );
});
