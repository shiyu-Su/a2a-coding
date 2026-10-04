/**
 * v0.9.5 C8 · T8 用例（离线）：**心跳监视 + 唤醒点火**。
 *
 * 事实源：改造文档 `doc/v0.9.5/推进流程精简-改造文档.md` §2-C8（v5）；确认单 §6/§7.3/§8。
 * 覆盖：
 * - ① 评估纯函数各档（DAG 终态命中 / pending 就绪 / 未命中）+ 引擎读面失败保守；
 * - ② 唤醒提示词（含「到 X 态 / 子任务 Y 就绪，请处理」结构化事实；不含编排桥工具全名）；
 * - ③ 去重键（同一条件只唤一次）；
 * - ④ R2 规格①定时器生命周期（stop 后不再点火）；②in-flight 防叠拍；⑤sweepIdle 确被调用（回归断言）；
 * - ⑤ 兜底条三条规格（阈值 ≥ 数分钟量级可注入 / (featureId,stage) 去重只兜底一次 / 唤醒词显式标签）；
 * - ⑥ `BridgeClient.getTask` 只读探针（404 ⇒ null），供 pending 就绪判定；
 * - ⑦ **交人闸（v0.9.8 心跳自火交人闸）**：板侧有待澄清轮 ⇒ 三档命中（pending-ready / fallback / 引擎终态）
 *   一律不自火，且**绝不记去重键**（解除后同条件照唤）；谓词抛错 fail-closed；未注入 ⇒ 行为零变更。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_FALLBACK_THRESHOLD_MS,
  FALLBACK_WAKE_LABEL,
  HEARTBEAT_PROMPT_TITLE,
  Heartbeat,
  SETTLED_TASK_STATES,
  buildWakePrompt,
  createHeartbeat,
  evaluateWake,
  isFired,
  isSettledTaskState,
} from "../dist/heartbeat.js";
import { createBridgeClient, parseTaskState } from "../dist/bridge-client.js";
import { createHostRelay } from "../dist/host-relay.js";
import { SuspendLedgerStore } from "../dist/suspend-ledger.js";
import { createBoardServer } from "../dist/server.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 内存台账（结构满足 `HeartbeatLedger`）。 */
function fakeLedger(entries = []) {
  const list = entries.map((e) => ({ pending: [], wakeCond: null, firedKeys: [], createdAt: "t", ...e }));
  return {
    list: () => list,
    get: (id) => list.find((e) => e.featureId === id) ?? null,
    recordFired: (id, key) => {
      const e = list.find((x) => x.featureId === id);
      if (e === undefined || e.firedKeys.includes(key)) return false;
      e.firedKeys.push(key);
      return true;
    },
    _list: list,
  };
}

function fakeRelay(overrides = {}) {
  return {
    chainCount: () => 0,
    chainLimit: () => 10,
    isChainStopped: () => false,
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  return {
    ledger: fakeLedger(),
    readEngine: async () => ({ state: "executing", stage: "需求分析", approval: "已通过", ownerGroup: "o" }),
    readTaskState: async () => "completed",
    fire: () => ({ ok: true, reason: "fired" }),
    relay: fakeRelay(),
    sweepIdle: async () => [],
    defaultOrg: "o",
    now: Date.now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ① 评估纯函数各档
// ---------------------------------------------------------------------------

test("T8-① SETTLED_TASK_STATES 与 watch-task 闭集逐字同源；未知 state 一律未就绪", () => {
  assert.deepEqual([...SETTLED_TASK_STATES], ["completed", "failed", "blocked", "input-required"]);
  for (const s of SETTLED_TASK_STATES) assert.equal(isSettledTaskState(s), true, `${s} 应就绪`);
  for (const s of ["working", "unknown", "", null, undefined, "queued"]) {
    assert.equal(isSettledTaskState(s), false, `${String(s)} 不得判就绪`);
  }
});

test("T8-② evaluateWake：引擎终态 / 离开执行中 ⇒ dag-terminal（键 state:<state>）", () => {
  const evalAt = (engineState, extra = {}) =>
    evaluateWake({
      featureId: "F1",
      engineState,
      engineStage: "改造",
      pending: [],
      pendingStates: {},
      auto: false,
      stageUnchangedMs: null,
      fallbackThresholdMs: DEFAULT_FALLBACK_THRESHOLD_MS,
      ...extra,
    });

  const reviewing = evalAt("reviewing");
  assert.equal(reviewing.hit, true);
  assert.equal(reviewing.kind, "dag-terminal");
  assert.equal(reviewing.key, "state:reviewing");

  const completed = evalAt("completed");
  assert.equal(completed.hit, true);
  assert.equal(completed.key, "state:completed");

  const needs = evalAt("needs_input");
  assert.equal(needs.hit, true, "needs_input 亦属离开执行中");
  assert.equal(needs.key, "state:needs_input");

  // 引擎读面失败 ⇒ 保守不点火
  const unknown = evalAt(null);
  assert.equal(unknown.hit, false);
  assert.equal(unknown.key, null);
});

test("T8-③ evaluateWake：executing + pending ⇒ 全部就绪才 pending-ready（键 pending:<ids>）", () => {
  const evalP = (pendingStates, pending = ["t1", "t2"]) =>
    evaluateWake({
      featureId: "F1",
      engineState: "executing",
      engineStage: "需求分析",
      pending,
      pendingStates,
      auto: false,
      stageUnchangedMs: null,
      fallbackThresholdMs: DEFAULT_FALLBACK_THRESHOLD_MS,
    });

  const ready = evalP({ t1: "completed", t2: "failed" });
  assert.equal(ready.hit, true);
  assert.equal(ready.kind, "pending-ready");
  assert.equal(ready.key, "pending:t1,t2");
  assert.equal(ready.facts.length, 2);

  assert.equal(evalP({ t1: "working", t2: "completed" }).hit, false, "任一未就绪 ⇒ 不唤醒");
  assert.equal(evalP({ t2: "completed" }).hit, false, "未知 id（读不到）按未就绪，不假唤醒");
  assert.equal(evalP({ t1: "completed", t2: "blocked" }).hit, true, "blocked 属就绪");
});

test("T8-④ evaluateWake：executing + 无 pending 且非 auto ⇒ 未命中（兜底只对自动 armed）", () => {
  const r = evaluateWake({
    featureId: "F1",
    engineState: "executing",
    engineStage: "需求分析",
    pending: [],
    pendingStates: {},
    auto: false,
    stageUnchangedMs: 10 * DEFAULT_FALLBACK_THRESHOLD_MS,
    fallbackThresholdMs: DEFAULT_FALLBACK_THRESHOLD_MS,
  });
  assert.equal(r.hit, false);
  assert.equal(r.key, null);
});

test("T8-④b evaluateWake：纯 DAG 轨——节点失败/阻塞 ⇒ dag-terminal（键 dag-failed:<ids>）；全 completed ⇒ dag-completed", () => {
  const evalDag = (dagTasks) =>
    evaluateWake({
      featureId: "F1",
      engineState: "executing",
      engineStage: "改造",
      pending: [],
      pendingStates: {},
      dagTasks,
      auto: false,
      stageUnchangedMs: null,
      fallbackThresholdMs: DEFAULT_FALLBACK_THRESHOLD_MS,
    });

  const failed = evalDag([{ taskId: "d1", state: "completed" }, { taskId: "d2", state: "failed" }]);
  assert.equal(failed.hit, true);
  assert.equal(failed.kind, "dag-terminal");
  assert.equal(failed.key, "dag-failed:d2");

  assert.equal(evalDag([{ taskId: "d3", state: "blocked" }]).key, "dag-failed:d3");
  assert.equal(evalDag([{ taskId: "d4", state: "input-required" }]).key, "dag-failed:d4");

  const done = evalDag([{ taskId: "d1", state: "completed" }, { taskId: "d2", state: "completed" }]);
  assert.equal(done.hit, true);
  assert.equal(done.key, "dag-completed");

  assert.equal(evalDag([{ taskId: "d1", state: "working" }]).hit, false, "运行中不命中");
});

test("T8-④c evaluateWake：改造轨（有 DAG 节点运行中）stage 长期不动也不兜底（防正常长任务被误判）", () => {
  const r = evaluateWake({
    featureId: "F1",
    engineState: "executing",
    engineStage: "改造方案",
    pending: [],
    pendingStates: {},
    dagTasks: [{ taskId: "d1", state: "working" }],
    auto: true,
    stageUnchangedMs: 10 * DEFAULT_FALLBACK_THRESHOLD_MS,
    fallbackThresholdMs: DEFAULT_FALLBACK_THRESHOLD_MS,
  });
  assert.equal(r.hit, false, "有 DAG 节点的改造轨不得被 ⑤ 兜底误唤");
});

// ---------------------------------------------------------------------------
// ② 唤醒提示词
// ---------------------------------------------------------------------------

test("T8-⑤ buildWakePrompt：pending-ready 带「子任务就绪 + 请处理」结构化事实；不含编排桥工具全名", () => {
  const p = buildWakePrompt({
    featureId: "F1",
    org: "o",
    kind: "pending-ready",
    reason: "pending 清单全部就绪（1 项）",
    facts: ["子任务 t1 state = completed"],
  });
  assert.ok(p.startsWith(`${HEARTBEAT_PROMPT_TITLE} 需求 F1 · 组织 o`), "标题行含需求与组织");
  assert.ok(p.includes("子任务"), "含子任务事实");
  assert.ok(p.includes("请处理"), "含「请处理」指引");
  assert.ok(p.includes("t1"), "含具体 taskId");
  assert.ok(!p.includes("a2a_"), "不得出现编排桥工具全名");
});

test("T8-⑥ buildWakePrompt：fallback 显式声明「疑似漏调挂起口·仅异常兜底」", () => {
  const p = buildWakePrompt({
    featureId: "F1",
    org: "o",
    kind: "fallback",
    reason: "stage 长期不动（400s ≥ 300s）⇒ 异常兜底",
    facts: [FALLBACK_WAKE_LABEL],
  });
  assert.ok(p.includes(FALLBACK_WAKE_LABEL), "兜底标签必须显式出现");
  assert.ok(p.includes("stage 长期未动"), "明示疑似误判来源");
});

// ---------------------------------------------------------------------------
// ③ 去重键
// ---------------------------------------------------------------------------

test("T8-⑦ isFired：同一条件键命中即去重；空 / null 键恒 false", () => {
  assert.equal(isFired(["pending:t1"], "pending:t1"), true);
  assert.equal(isFired(["pending:t1"], "pending:t2"), false);
  assert.equal(isFired([], null), false);
  assert.equal(isFired([""], ""), false);
});

// ---------------------------------------------------------------------------
// ④ 心跳：sweepIdle 回归 / 条目唤醒一次 / 防叠拍 / 生命周期
// ---------------------------------------------------------------------------

test("T8-⑧ Heartbeat.tick：同拍驱动 sweepIdle（回归断言：欠账确被调用一次）", async () => {
  let sweeps = 0;
  const hb = createHeartbeat(baseDeps({ sweepIdle: async () => { sweeps += 1; return []; } }));
  const report = await hb.tick();
  assert.equal(sweeps, 1, "每拍调用 sweepIdle 一次");
  assert.deepEqual(report.swept, []);
  assert.equal(report.skipped, false);
});

test("T8-⑨ Heartbeat.tick：pending 就绪 ⇒ 经 fire 点火一次；同条件第二拍不再唤（firedKeys 去重）", async () => {
  const fires = [];
  const ledger = fakeLedger([
    { featureId: "F1", turnId: "turn-1", contextId: "ctx-1", pending: ["t1"] },
  ]);
  const hb = createHeartbeat(baseDeps({
    ledger,
    fire: (input) => { fires.push(input); return { ok: true, reason: "fired" }; },
  }));
  const first = await hb.tick();
  assert.equal(first.fired.length, 1);
  assert.equal(first.fired[0].kind, "pending-ready");
  assert.equal(fires.length, 1);
  assert.equal(fires[0].org, "o");
  assert.ok(fires[0].prompt.includes("请处理"));
  assert.deepEqual(ledger.get("F1").firedKeys, ["pending:t1"]);

  const second = await hb.tick();
  assert.equal(second.fired.length, 0, "已唤条件不重复点火");
  assert.equal(fires.length, 1);
});

test("T8-⑩ Heartbeat：停链标志 / 链内计数触顶 ⇒ 不点火（只读挂接，不另造载体）", async () => {
  const fires = [];
  const reviewingEngine = async () => ({ state: "reviewing", stage: "改造", approval: "已通过", ownerGroup: "o" });
  const entry = { featureId: "F1", turnId: "t", contextId: "c", pending: [] };

  const stopped = createHeartbeat(baseDeps({
    ledger: fakeLedger([entry]),
    relay: fakeRelay({ isChainStopped: () => true }),
    readEngine: reviewingEngine,
    fire: (i) => { fires.push(i); return { ok: true, reason: "fired" }; },
  }));
  assert.equal((await stopped.tick()).fired.length, 0, "停链标志 ⇒ 不点火");

  const capped = createHeartbeat(baseDeps({
    ledger: fakeLedger([entry]),
    relay: fakeRelay({ chainCount: () => 10, chainLimit: () => 10 }),
    readEngine: reviewingEngine,
    fire: (i) => { fires.push(i); return { ok: true, reason: "fired" }; },
  }));
  assert.equal((await capped.tick()).fired.length, 0, "计数触顶 ⇒ 交人停链");
  assert.equal(fires.length, 0);
});

test("T8-⑪ Heartbeat：引擎读面失败 ⇒ 保守不点火", async () => {
  const fires = [];
  const hb = createHeartbeat(baseDeps({
    ledger: fakeLedger([{ featureId: "F1", turnId: "t", contextId: "c", pending: ["t1"] }]),
    readEngine: async () => null,
    fire: (i) => { fires.push(i); return { ok: true, reason: "fired" }; },
  }));
  const r = await hb.tick();
  assert.equal(r.fired.length, 0);
  assert.equal(fires.length, 0);
});

test("T8-⑫ Heartbeat：in-flight 防叠拍（上一拍未跑完 ⇒ 本拍 skipped，readEngine 只调一次）", async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  let calls = 0;
  const hb = createHeartbeat(baseDeps({
    ledger: fakeLedger([{ featureId: "F1", turnId: "t", contextId: "c", pending: ["t1"] }]),
    readEngine: async () => { calls += 1; await gate; return { state: "executing", stage: "需求分析", approval: "已通过", ownerGroup: "o" }; },
  }));
  const p1 = hb.tick();
  await sleep(5); // 确认第一拍已进入
  const p2 = await hb.tick();
  assert.equal(p2.skipped, true, "上一拍未跑完 ⇒ 本拍跳过");
  release();
  await p1;
  assert.equal(calls, 1, "防叠拍下 readEngine 至多一次");
});

test("T8-⑬ Heartbeat 生命周期：start 建定时器，stop 后不再触发（clearInterval）", async () => {
  let sweeps = 0;
  const hb = createHeartbeat(baseDeps({
    intervalMs: 10,
    sweepIdle: async () => { sweeps += 1; return []; },
  }));
  assert.equal(hb.isRunning(), false);
  hb.start();
  assert.equal(hb.isRunning(), true);
  await sleep(60);
  assert.ok(sweeps >= 2, `start 后应周期性触发（实际 ${sweeps}）`);
  hb.stop();
  assert.equal(hb.isRunning(), false);
  const atStop = sweeps;
  await sleep(60);
  assert.equal(sweeps, atStop, "stop 后 clearInterval ⇒ 不再触发");
  hb.stop(); // 幂等
});

// ---------------------------------------------------------------------------
// ⑤ 兜底条三条规格
// ---------------------------------------------------------------------------

test("T8-⑭ 兜底三条规格：阈值（≥数分钟量级可注入）/ (featureId,stage) 只兜底一次 / 唤醒词显式标签", async () => {
  let now = 1_000_000;
  const fires = [];
  let engineStage = "需求分析";
  const hb = createHeartbeat(baseDeps({
    now: () => now,
    fallbackThresholdMs: 60_000, // 可注入（生产缺省 = DEFAULT_FALLBACK_THRESHOLD_MS ≥ 数分钟）
    readEngine: async () => ({ state: "executing", stage: engineStage, approval: "已通过", ownerGroup: "o" }),
    fire: (i) => { fires.push(i); return { ok: true, reason: "fired" }; },
  }));
  // 自动 armed（无台账条目；宿主「忘调挂起口」的形态）
  hb.noteMonitor({ featureId: "F1", kind: "auto", org: "o", stage: "需求分析" });
  assert.equal(hb.autoArmedCount(), 1);

  // 规格1：未达阈值不唤
  now += 59_999;
  assert.equal((await hb.tick()).fired.length, 0, "未达阈值不兜底");

  // 规格1：达阈值唤醒一次
  now += 1;
  const hitOnce = await hb.tick();
  assert.equal(hitOnce.fired.length, 1);
  assert.equal(hitOnce.fired[0].kind, "fallback");
  assert.equal(hitOnce.fired[0].key, "fallback:需求分析");
  assert.equal(fires.length, 1);

  // 规格2：同条件第二拍不再唤
  now += 120_000;
  assert.equal((await hb.tick()).fired.length, 0, "同 (featureId,stage) 只兜底一次");
  assert.equal(fires.length, 1);

  // 规格3：唤醒词显式标签
  assert.ok(fires[0].prompt.includes(FALLBACK_WAKE_LABEL), "兜底唤醒词含显式标签");

  // stage 变化 ⇒ 新条件（计时重置 + 新去重键）
  engineStage = "改造方案";
  now += 10_000;
  assert.equal((await hb.tick()).fired.length, 0, "stage 变化即重置计时");
  now += 60_000;
  const nextStage = await hb.tick();
  assert.equal(nextStage.fired.length, 1, "新 stage 独立兜底一次");
  assert.equal(nextStage.fired[0].key, "fallback:改造方案");
});

test("T8-⑮ 兜底：有显式挂起条目时不走 auto（条目优先，撤销自动目标）", async () => {
  let now = 0;
  const hb = createHeartbeat(baseDeps({
    now: () => now,
    fallbackThresholdMs: 1000,
    ledger: fakeLedger([{ featureId: "F1", turnId: "t", contextId: "c", pending: [] }]),
    readEngine: async () => ({ state: "executing", stage: "需求分析", approval: "已通过", ownerGroup: "o" }),
  }));
  hb.noteMonitor({ featureId: "F1", kind: "auto", org: "o", stage: "需求分析" });
  hb.noteMonitor({ featureId: "F1", kind: "suspend", org: "o", stage: "需求分析" });
  assert.equal(hb.autoArmedCount(), 0, "显式挂起接管 ⇒ 自动目标撤销");
  now += 1000;
  assert.equal((await hb.tick()).fired.length, 0, "显式纯 DAG 条目不适用 ⑤ 兜底");
});

// ---------------------------------------------------------------------------
// ⑥ getTask 只读探针
// ---------------------------------------------------------------------------

test("T8-⑯ parseTaskState：只取 state；缺 state ⇒ unknown", () => {
  assert.deepEqual(parseTaskState({ ok: true, task: { taskId: "t1", state: "completed" } }), { taskId: "t1", state: "completed" });
  assert.deepEqual(parseTaskState({ ok: true, task: {} }), { taskId: null, state: "unknown" });
});

test("T8-⑰ BridgeClient.getTask：GET /api/tasks/:id；404 / task_not_found ⇒ null（不抛）", async () => {
  const seen = [];
  const mk = (status, body) =>
    createBridgeClient({
      baseUrl: "http://127.0.0.1:3300",
      fetchImpl: async (url, init) => {
        seen.push({ url, method: init?.method });
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => JSON.stringify(body),
        };
      },
    });

  const ok = await mk(200, { ok: true, task: { taskId: "t1", state: "completed" } }).getTask("t 1");
  assert.deepEqual(ok, { taskId: "t1", state: "completed" });
  assert.equal(seen[0].method, "GET");
  assert.ok(seen[0].url.includes("/api/tasks/t%201"), `URL 应编码 taskId：${seen[0].url}`);

  assert.equal(await mk(404, { ok: false, code: "task_not_found" }).getTask("gone"), null);
  assert.equal(await mk(200, { ok: false, code: "task_not_found" }).getTask("gone"), null);
});

// ---------------------------------------------------------------------------
// ⑦ 服务侧台账注入（装配层单实例）
// ---------------------------------------------------------------------------

test("T8-⑱ createBoardServer：注入的 suspendLedgerStore 原样暴露在 handle（心跳与服务共用单实例）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-t8-"));
  const store = new SuspendLedgerStore(join(dir, "suspended.json"));
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, suspendLedgerStore: store });
  try {
    assert.equal(handle.suspendLedger, store, "handle.suspendLedger 必须是注入的同一实例");
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑧ 验收补充：唤醒计入链内计数（经同一刹车）+ 只读不碰活动时间写入面
// ---------------------------------------------------------------------------

test("T8-⑲ HostRelay.fireWake：唤醒经同一刹车并计入链内连续点火计数；撞 occupant ⇒ 放弃这一发（增补 D1 后**不再停链**）", () => {
  const submissions = [];
  const relay = createHostRelay({
    submitTurn: (input) => {
      submissions.push(input);
      return {
        turnId: `turn-${submissions.length}`,
        requirementId: input.requirementId,
        contextId: "ctx",
        round: submissions.length,
        queued: false,
        position: 1,
        display: "",
        occupant: null,
        done: Promise.resolve({}),
      };
    },
  });
  assert.equal(relay.chainCount("F1"), 0);
  const r = relay.fireWake({ requirementId: "F1", org: "o", prompt: "唤醒提示词" });
  assert.equal(r.ok, true);
  assert.equal(relay.chainCount("F1"), 1, "唤醒计入链内连续点火计数（载体单一定义）");
  assert.equal(submissions[0].text, "唤醒提示词", "fireWake 原样投递已组装提示词");
  assert.equal(submissions[0].org, "o");

  const occupant = {
    turnId: "turn-o",
    requirementId: "F2",
    org: "o",
    contextId: "c",
    round: 1,
    state: "running",
    queuedAt: "t",
    startedAt: null,
  };
  const relay2 = createHostRelay({
    submitTurn: () => ({
      turnId: "turn-y",
      requirementId: "F2",
      contextId: "c",
      round: 1,
      queued: false,
      position: 0,
      display: "",
      occupant,
      done: Promise.resolve({}),
    }),
  });
  const r2 = relay2.fireWake({ requirementId: "F2", org: "o", prompt: "p" });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "occupant_yield", "增补 D1：唤醒无条目 turnId ⇒ 按同需求新一轮退让等待");
  assert.equal(r2.occupantTurnId, "turn-o", "撞车身份回结果面（供留痕）");
  assert.equal(relay2.isChainStopped("F2"), false, "唤醒路径不再一撞即置停链标志（接力路径的「一撞即停」归 T2 C1-⑪）");
  assert.equal(relay2.chainCount("F2"), 0, "失败发不计数");
});

test("T8-⑳（回归）心跳只读：源码不触碰桥活动时间写入面（不刷新 lastActivityAt ⇒ idle 不被心跳搅乱）", () => {
  const src = readFileSync(new URL("../dist/heartbeat.js", import.meta.url), "utf8");
  for (const token of [".beginRound(", ".endRound(", ".ensureStarted(", ".lastActivityAt", ".stopInternal("]) {
    assert.ok(!src.includes(token), `heartbeat.js 不得出现桥活动 / 生命周期写面 ${token}`);
  }
});

// ---------------------------------------------------------------------------
// ⑨ 交人闸（v0.9.8 心跳自火交人闸）：板侧有待澄清轮 ⇒ 本拍不自火
// ---------------------------------------------------------------------------

test("T8-㉑ 交人闸：pending-ready 已命中但 awaitingHeld=true ⇒ 不自火（不 fire、不计入 fired[]、**不记 firedKeys**）", async () => {
  const fires = [];
  const logs = [];
  const ledger = fakeLedger([{ featureId: "F1", turnId: "turn-1", contextId: "ctx-1", pending: ["t1"] }]);
  const hb = createHeartbeat(baseDeps({
    ledger,
    awaitingHeld: () => true,
    fire: (i) => { fires.push(i); return { ok: true, reason: "fired" }; },
    log: (line) => { logs.push(line); },
  }));
  const r = await hb.tick();
  assert.equal(r.fired.length, 0, "被挡 ⇒ 不计入 fired[]（同 no-hit 形态）");
  assert.equal(fires.length, 0, "不组装提示词、不调 fire");
  assert.deepEqual(ledger.get("F1").firedKeys, [], "绝不记去重键（记了会让答完后的同一条件永久失声）");
  assert.ok(
    logs.some((l) => l.includes("verdict=awaiting-held")),
    `须经 evalTrace 留痕 verdict=awaiting-held（实际：${logs.join(" / ")}）`,
  );
});

test("T8-㉒ 交人闸：被挡后 awaitingHeld 解除 ⇒ 同条件可正常唤（反证未记去重键；挡后下一拍照旧重评）", async () => {
  const fires = [];
  let held = true;
  const ledger = fakeLedger([{ featureId: "F1", turnId: "turn-1", contextId: "ctx-1", pending: ["t1"] }]);
  const hb = createHeartbeat(baseDeps({
    ledger,
    awaitingHeld: () => held,
    fire: (i) => { fires.push(i); return { ok: true, reason: "fired" }; },
  }));
  assert.equal((await hb.tick()).fired.length, 0, "有待澄清轮 ⇒ 本拍不自火");
  assert.equal(fires.length, 0);

  held = false; // 用户已回答
  const after = await hb.tick();
  assert.equal(after.fired.length, 1, "解除后同条件照唤（去重键未被挡时消费）");
  assert.equal(after.fired[0].kind, "pending-ready");
  assert.equal(fires.length, 1);
  assert.deepEqual(ledger.get("F1").firedKeys, ["pending:t1"], "点火成功才记去重位");
});

test("T8-㉓ 交人闸：fallback（⑤ 兜底）路径同样被挡，解除后自动目标照唤", async () => {
  let now = 1_000_000;
  const fires = [];
  let held = true;
  const hb = createHeartbeat(baseDeps({
    now: () => now,
    fallbackThresholdMs: 60_000,
    awaitingHeld: () => held,
    readEngine: async () => ({ state: "executing", stage: "需求分析", approval: "已通过", ownerGroup: "o" }),
    fire: (i) => { fires.push(i); return { ok: true, reason: "fired" }; },
  }));
  hb.noteMonitor({ featureId: "F1", kind: "auto", org: "o", stage: "需求分析" });
  now += 60_000;
  assert.equal((await hb.tick()).fired.length, 0, "兜底命中也被交人闸挡（不烧掉自动目标的一轮）");
  assert.equal(fires.length, 0);

  held = false;
  now += 1;
  const after = await hb.tick();
  assert.equal(after.fired.length, 1, "自动目标自己的 firedKeys 同样不得在挡时记录");
  assert.equal(after.fired[0].kind, "fallback");
});

test("T8-㉔ 交人闸：引擎终态路径（dag-terminal · 待裁 C4）一并挡 —— 有待澄清轮时不自火去收尾", async () => {
  const fires = [];
  const ledger = fakeLedger([{ featureId: "F1", turnId: "turn-1", contextId: "ctx-1", pending: [] }]);
  const hb = createHeartbeat(baseDeps({
    ledger,
    awaitingHeld: () => true,
    readEngine: async () => ({ state: "completed", stage: "改造", approval: "已通过", ownerGroup: "o" }),
    fire: (i) => { fires.push(i); return { ok: true, reason: "fired" }; },
  }));
  const r = await hb.tick();
  assert.equal(r.fired.length, 0);
  assert.equal(fires.length, 0, "引擎终态命中同样交人");
  assert.deepEqual(ledger.get("F1").firedKeys, [], "不记 state:completed 去重键");
});

test("T8-㉕ 交人闸：awaitingHeld 抛错 ⇒ fail-closed 按「有待澄清轮」处置（不点火、不记去重键）", async () => {
  const fires = [];
  const ledger = fakeLedger([{ featureId: "F1", turnId: "turn-1", contextId: "ctx-1", pending: ["t1"] }]);
  const hb = createHeartbeat(baseDeps({
    ledger,
    awaitingHeld: () => {
      throw new Error("turn 读面炸了");
    },
    fire: (i) => { fires.push(i); return { ok: true, reason: "fired" }; },
  }));
  const r = await hb.tick();
  assert.equal(r.fired.length, 0, "谓词抛错不得放行自火（宁可不唤）");
  assert.equal(fires.length, 0);
  assert.deepEqual(ledger.get("F1").firedKeys, []);
});

test("T8-㉖ 交人闸：未注入 awaitingHeld ⇒ 既有行为零变更（向后兼容 + 可选字段）", async () => {
  const fires = [];
  const logs = [];
  const ledger = fakeLedger([{ featureId: "F1", turnId: "turn-1", contextId: "ctx-1", pending: ["t1"] }]);
  const hb = createHeartbeat(baseDeps({
    ledger,
    fire: (i) => { fires.push(i); return { ok: true, reason: "fired" }; },
    log: (line) => { logs.push(line); },
  }));
  const r = await hb.tick();
  assert.equal(r.fired.length, 1, "未注入 ⇒ 照旧点火");
  assert.equal(fires.length, 1);
  assert.deepEqual(ledger.get("F1").firedKeys, ["pending:t1"]);
  assert.ok(!logs.some((l) => l.includes("awaiting-held")), "未注入 ⇒ 不出 awaiting-held 留痕");
});
