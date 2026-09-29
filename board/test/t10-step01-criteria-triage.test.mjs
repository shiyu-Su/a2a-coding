/**
 * v0.9.5 增补 · REQ-2026-09-29-03（D3 + D1）用例（离线）：
 * **Step 0/1 监视判据修正** + **唤醒点火撞车分诊** + **结构化留痕**。
 *
 * 事实源：`doc/v0.9.5/推进流程精简-改造文档.md` §增补（三刀：判据 / 分诊 / 留痕）。
 *
 * 覆盖：
 * - **A 判据矩阵（D3）**：有 `pending` ⇒ 只看 pending 是否齐（引擎态非 `executing` 不再恒真命中）；
 *   `pending` 空 ⇒ 纯 DAG 监视语义按原样；
 * - **B `input-required` 口径锚**：闭集**含** `input-required`（定案），单条待裁决即唤、未齐仍不唤；
 * - **C 撞车分诊三行（D1）**：① 自己那一轮 ⇒ 跳过（不停链 / 不计数 / 不起退让计时）；
 *   ② 同需求新一轮 ⇒ 退让等待，**满 20 拍（=10 分钟）才停链 + 交人**；③ 接力路径仍**一撞即停**；
 * - **D 心跳侧**：撞 occupant **不记去重位** ⇒ 下一拍照常重评；条目 `turnId` 透传为分诊身份键；
 * - **E 留痕锚**：每次评估与点火尝试各一行结构化日志（featureId / key / occupant / verdict）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  SETTLED_TASK_STATES,
  Heartbeat,
  evaluateWake,
  isSettledTaskState,
} from "../dist/heartbeat.js";
import { WAKE_OCCUPANT_WAIT_LIMIT_MS, createHostRelay } from "../dist/host-relay.js";

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

const OCC = (turnId) => ({
  turnId,
  requirementId: "F1",
  org: "o",
  contextId: "c",
  round: 3,
  state: "running",
  queuedAt: "q",
  startedAt: null,
});

function fakeSubmitted(over = {}) {
  return {
    turnId: "turn-new",
    requirementId: "F1",
    contextId: "c",
    round: 4,
    queued: false,
    position: 1,
    display: "",
    occupant: null,
    done: Promise.resolve({}),
    ...over,
  };
}

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

function baseDeps(overrides = {}) {
  return {
    ledger: fakeLedger(),
    readEngine: async () => ({ state: "waiting_approval", stage: "需求分析", approval: "未发起", ownerGroup: "o" }),
    readTaskState: async () => "completed",
    fire: () => ({ ok: true, reason: "fired" }),
    relay: { chainCount: () => 0, chainLimit: () => 10, isChainStopped: () => false },
    sweepIdle: async () => [],
    defaultOrg: "o",
    now: Date.now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A 判据矩阵（D3）
// ---------------------------------------------------------------------------

function evalWake(engineState, pending, pendingStates, extra = {}) {
  return evaluateWake({
    featureId: "F1",
    engineState,
    engineStage: "需求分析",
    pending,
    pendingStates,
    auto: false,
    stageUnchangedMs: null,
    fallbackThresholdMs: 300_000,
    ...extra,
  });
}

test("D3-① 判据矩阵：有 pending ⇒ 只看 pending 是否齐（Step 0/1 停靠 waiting_approval 不再恒真命中）", () => {
  const MATRIX = [
    // [引擎态, pending, pendingStates, 期望命中, 期望种类]
    ["waiting_approval", ["t1"], { t1: "working" }, false, null],
    ["waiting_approval", ["t1"], { t1: "completed" }, true, "pending-ready"],
    ["waiting_approval", ["t1", "t2"], { t1: "completed", t2: "working" }, false, null],
    ["waiting_approval", ["t1", "t2"], { t1: "completed", t2: "failed" }, true, "pending-ready"],
    ["needs_input", ["t1"], { t1: "working" }, false, null],
    ["reviewing", ["t1"], { t1: "working" }, false, null],
    ["executing", ["t1"], { t1: "working" }, false, null],
    ["executing", ["t1"], { t1: "blocked" }, true, "pending-ready"],
  ];
  for (const [state, pending, pendingStates, expectHit, expectKind] of MATRIX) {
    const r = evalWake(state, pending, pendingStates);
    assert.equal(r.hit, expectHit, `引擎态 ${state} · pending ${JSON.stringify(pendingStates)} ⇒ hit 应为 ${String(expectHit)}`);
    assert.equal(r.kind, expectKind, `${state} · ${JSON.stringify(pendingStates)} ⇒ kind`);
    if (expectHit) assert.equal(r.key, `pending:${pending.join(",")}`, "去重键仍按 pending 清单");
  }
});

test("D3-② 未齐时判据说明写明「引擎态不参与本档判定」（防止回退成恒真短路）", () => {
  const r = evalWake("waiting_approval", ["t1"], { t1: "working" });
  assert.equal(r.hit, false);
  assert.match(r.reason, /引擎态 waiting_approval 不参与本档判定/);
});

test("D3-③ 引擎终态优先：completed / cancelled 即便 pending 未齐也命中 dag-terminal", () => {
  for (const state of ["completed", "cancelled", "failed"]) {
    const r = evalWake(state, ["t1"], { t1: "working" });
    assert.equal(r.hit, true, `${state} 是终态 ⇒ 该唤宿主收尾`);
    assert.equal(r.kind, "dag-terminal");
    assert.equal(r.key, `state:${state}`);
  }
});

test("D3-④ pending 为空 ⇒ 纯 DAG 监视语义按原样（离开执行中 / DAG 失败 / 全 completed / ⑤ 兜底）", () => {
  // 非执行中 + 无 pending：原「离开执行中」档保留
  const left = evalWake("reviewing", [], {});
  assert.equal(left.hit, true);
  assert.equal(left.kind, "dag-terminal");
  assert.equal(left.key, "state:reviewing");

  // executing + DAG 节点失败 ⇒ dag-failed
  const dagFail = evalWake("executing", [], {}, { dagTasks: [{ taskId: "d1", state: "failed" }] });
  assert.equal(dagFail.hit, true);
  assert.equal(dagFail.key, "dag-failed:d1");

  // executing + DAG 全 completed ⇒ dag-completed
  const dagDone = evalWake("executing", [], {}, { dagTasks: [{ taskId: "d1", state: "completed" }] });
  assert.equal(dagDone.key, "dag-completed");

  // executing + DAG 在飞 ⇒ 不命中（含 waiting_approval 无 pending 无 DAG 的 auto 目标未达阈值）
  assert.equal(evalWake("executing", [], {}, { dagTasks: [{ taskId: "d1", state: "working" }] }).hit, false);

  // ⑤ 兜底仍只对 auto ∧ 无 DAG ∧ stage 长期不动
  const fb = evalWake("executing", [], {}, { auto: true, stageUnchangedMs: 300_000 });
  assert.equal(fb.kind, "fallback");
});

test("D3-⑤ 就绪事实面：Step 0/1 命中时把引擎态与登记 stage 一并交给宿主（不只报子任务）", () => {
  const r = evalWake("waiting_approval", ["t1"], { t1: "completed" }, { engineStage: "需求分析" });
  assert.equal(r.hit, true);
  assert.ok(r.facts.some((f) => f.includes("子任务 t1 state = completed")), "含子任务事实");
  assert.ok(r.facts.some((f) => f.includes("引擎态 state = waiting_approval")), "非执行中时补引擎态事实");
  // executing 档不追加引擎态行（与既有 T8-③ facts.length=2 口径一致）
  assert.equal(evalWake("executing", ["t1"], { t1: "completed" }).facts.length, 1);
});

// ---------------------------------------------------------------------------
// B `input-required` 口径锚（闭集定案 = 含）
// ---------------------------------------------------------------------------

test("B-① 闭集定案：SETTLED_TASK_STATES 含 input-required（四值闭集，逐字锚）", () => {
  assert.deepEqual([...SETTLED_TASK_STATES], ["completed", "failed", "blocked", "input-required"]);
  assert.equal(isSettledTaskState("input-required"), true, "input-required = 子任务停下要人裁决 ⇒ 正是唤醒时机");
  assert.equal(isSettledTaskState("working"), false);
  assert.equal(isSettledTaskState(null), false, "未知 state 一律未就绪（保守）");
});

test("B-② 唤醒时机锚：Step 0/1 单条 pending 落 input-required ⇒ 点火（现场那份 task 的形态）", () => {
  const r = evalWake("waiting_approval", ["83b47ab0"], { "83b47ab0": "input-required" });
  assert.equal(r.hit, true, "input-required 计入就绪 ⇒ 该唤宿主来裁决，不得静默吞掉");
  assert.equal(r.kind, "pending-ready");
  assert.ok(r.facts.some((f) => f.includes("input-required")), "提示词事实面带上该 state");
});

test("B-③ 等齐口径：一条 input-required 但另一条仍 working ⇒ 不点火（不半截唤醒）", () => {
  const r = evalWake("waiting_approval", ["t1", "t2"], { t1: "input-required", t2: "working" });
  assert.equal(r.hit, false);
  assert.match(r.reason, /待 t2/);
});

// ---------------------------------------------------------------------------
// C 撞车分诊三行（D1，接力驱动器层）
// ---------------------------------------------------------------------------

function triageRelay(occupantTurnId, over = {}) {
  const logs = [];
  let now = 0;
  const relay = createHostRelay({
    submitTurn: () => (occupantTurnId === null ? fakeSubmitted() : fakeSubmitted({ occupant: OCC(occupantTurnId) })),
    log: (line) => logs.push(line),
    now: () => now,
    ...over,
  });
  return { relay, logs, tick: (ms) => { now += ms; } };
}

test("C-① 自己那一轮（occupant.turnId == 条目 turnId）⇒ 本拍跳过：不停链、不计数、不起退让计时", () => {
  const { relay } = triageRelay("turn-own");
  const r = relay.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "occupant_self");
  assert.equal(r.occupantTurnId, "turn-own", "撞车身份进结果面（供留痕）");
  assert.equal(relay.isChainStopped("F1"), false, "不再置停链标志");
  assert.equal(relay.chainCount("F1"), 0, "跳过的一发不计数");
  assert.equal(relay.wakeWaitView("F1"), null, "等自己收口不算退让");
});

test("C-② 同需求新一轮 ⇒ 退让等待：前 20 拍只退让，满 10 分钟（≈20 拍）才停链 + 交人", () => {
  const { relay, logs, tick } = triageRelay("turn-busy");
  assert.equal(WAKE_OCCUPANT_WAIT_LIMIT_MS / DEFAULT_HEARTBEAT_INTERVAL_MS, 20, "上限口径 = 心跳 20 拍");

  for (let i = 1; i <= 20; i += 1) {
    tick(DEFAULT_HEARTBEAT_INTERVAL_MS);
    const r = relay.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" });
    assert.equal(r.reason, "occupant_yield", `第 ${String(i)} 拍仍退让`);
    assert.equal(r.ok, false);
    assert.equal(relay.isChainStopped("F1"), false, "未超上限不得停链");
    assert.equal(relay.wakeWaitView("F1").ticks, i, "退让拍数累计");
  }

  tick(DEFAULT_HEARTBEAT_INTERVAL_MS);
  const exceeded = relay.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" });
  assert.equal(exceeded.reason, "occupant_wait_exceeded");
  assert.equal(exceeded.occupantTurnId, "turn-busy");
  assert.equal(relay.isChainStopped("F1"), true, "超总上限 ⇒ 停链交人");
  assert.equal(relay.chainCount("F1"), 0, "退让的二十余拍一发未点 ⇒ 链内计数不动");
  assert.ok(
    logs.some((l) => l.includes("退让等待超上限") && l.includes("turn-busy")),
    `超限留痕含占用轮 id：${logs.join(" | ")}`,
  );
});

test("C-③ 退让是「总」上限：占用者换成又一轮也不重置起算点", () => {
  let now = 0;
  const relays = [];
  const mk = (occupantTurnId) => {
    const relay = createHostRelay({
      submitTurn: () => fakeSubmitted({ occupant: OCC(occupantTurnId) }),
      now: () => now,
    });
    relays.push(relay);
    return relay;
  };
  const first = mk("turn-a");
  now = DEFAULT_HEARTBEAT_INTERVAL_MS;
  assert.equal(first.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" }).reason, "occupant_yield");
  const sinceMs = first.wakeWaitView("F1").sinceMs;

  now = 2 * DEFAULT_HEARTBEAT_INTERVAL_MS;
  const second = mk("turn-b");
  // 同一需求（同一驱动器实例才共享计时）：换占用者后仍按首次起算
  assert.equal(first.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" }).reason, "occupant_yield");
  assert.equal(first.wakeWaitView("F1").sinceMs, sinceMs, "占用者换轮 ⇒ 退让起算点不重置");
  assert.equal(second.wakeWaitView("F1"), null, "计时归驱动器实例持有（按需求一条）");
});

test("C-④ 接力路径（轮收口续轮）保持一撞即停 —— 分诊只改唤醒路径", () => {
  const relay = createHostRelay({
    submitTurn: () => fakeSubmitted({ occupant: OCC("turn-busy") }),
    now: () => 0,
  });
  const r = relay.fire({ requirementId: "F1", org: "o", state: "succeeded" }, { state: "executing", stage: "改造", approval: "已通过" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "occupant", "接力路径原因码不变");
  assert.equal(r.occupantTurnId, "turn-busy");
  assert.equal(relay.isChainStopped("F1"), true, "一撞即停不变");
});

test("C-⑤ 退让计时的清零面：成功点火 / 人工动作 / 解停链 / 该需求有轮收口", () => {
  let now = 0;
  let occupantTurnId = "turn-busy";
  const relay = createHostRelay({
    submitTurn: () => (occupantTurnId === null ? fakeSubmitted() : fakeSubmitted({ occupant: OCC(occupantTurnId) })),
    now: () => now,
  });
  now = DEFAULT_HEARTBEAT_INTERVAL_MS;
  assert.equal(relay.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" }).reason, "occupant_yield");
  assert.notEqual(relay.wakeWaitView("F1"), null);

  relay.noteManualAction("F1", "supplement");
  assert.equal(relay.wakeWaitView("F1"), null, "人工动作清退让计时（链内计数同清）");

  now += DEFAULT_HEARTBEAT_INTERVAL_MS;
  assert.equal(relay.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" }).reason, "occupant_yield");
  relay.clearStop("F1");
  assert.equal(relay.wakeWaitView("F1"), null, "解停链清退让计时");

  now += DEFAULT_HEARTBEAT_INTERVAL_MS;
  assert.equal(relay.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" }).reason, "occupant_yield");
  occupantTurnId = null;
  assert.equal(relay.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" }).ok, true);
  assert.equal(relay.wakeWaitView("F1"), null, "真点着一发 ⇒ 退让结束");
  assert.equal(relay.chainCount("F1"), 1, "成功发计入链内连续点火计数");

  occupantTurnId = "turn-busy";
  now += DEFAULT_HEARTBEAT_INTERVAL_MS;
  assert.equal(relay.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" }).reason, "occupant_yield");
  relay.handleTurnSettled({ requirementId: "F1", org: "o", state: "canceled" });
  assert.equal(relay.wakeWaitView("F1"), null, "该需求有轮收口 ⇒ 所等的占用者已不在场，退让计时清零");
});

test("C-⑥ 退让上限可注入（测试用小值），不改缺省 10 分钟", () => {
  let now = 0;
  const relay = createHostRelay({
    submitTurn: () => fakeSubmitted({ occupant: OCC("turn-busy") }),
    now: () => now,
    wakeOccupantWaitMs: 100,
  });
  now = 99;
  assert.equal(relay.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" }).reason, "occupant_yield");
  now = 200;
  assert.equal(relay.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" }).reason, "occupant_wait_exceeded");
  assert.equal(relay.isChainStopped("F1"), true);
});

// ---------------------------------------------------------------------------
// D 心跳侧：不记去重位 + turnId 作为分诊身份键
// ---------------------------------------------------------------------------

test("D-① 心跳把条目的 turnId 透传给点火面（自动目标 ⇒ null）", async () => {
  const fires = [];
  const ledger = fakeLedger([{ featureId: "F1", turnId: "turn-own", contextId: "ctx-1", pending: ["t1"] }]);
  const hb = new Heartbeat(
    baseDeps({
      ledger,
      fire: (input) => {
        fires.push(input);
        return { ok: true, reason: "fired" };
      },
    }),
  );
  await hb.tick();
  assert.equal(fires.length, 1);
  assert.equal(fires[0].turnId, "turn-own", "分诊身份键 = 条目登记那一发的轮 id");

  const autoFires = [];
  const hbAuto = new Heartbeat(
    baseDeps({
      readEngine: async () => ({ state: "executing", stage: "改造", approval: "已通过", ownerGroup: "o", tasks: [{ taskId: "d1", state: "failed" }] }),
      fire: (input) => {
        autoFires.push(input);
        return { ok: true, reason: "fired" };
      },
    }),
  );
  hbAuto.noteMonitor({ featureId: "F9", kind: "auto", org: "o", stage: "改造" });
  await hbAuto.tick();
  assert.equal(autoFires.length, 1);
  assert.equal(autoFires[0].turnId, null, "自动 armed 无条目 ⇒ null（一律按新一轮退让）");
});

test("D-② 撞 occupant ⇒ 不记去重位，下一拍照常重评（self 与 yield 两档都不记）", async () => {
  for (const reason of ["occupant_self", "occupant_yield"]) {
    const fires = [];
    const ledger = fakeLedger([{ featureId: "F1", turnId: "turn-own", contextId: "ctx-1", pending: ["t1"] }]);
    const hb = new Heartbeat(
      baseDeps({
        ledger,
        fire: (input) => {
          fires.push(input);
          return { ok: false, reason, occupantTurnId: "turn-busy" };
        },
      }),
    );
    const first = await hb.tick();
    assert.equal(first.fired.length, 1, `${reason} ⇒ 记入本拍尝试`);
    assert.equal(first.fired[0].fired, false);
    assert.equal(first.fired[0].occupantTurnId, "turn-busy", "撞车身份回到心跳记录");
    assert.deepEqual(ledger.get("F1").firedKeys, [], `${reason} ⇒ 不记 firedKeys`);

    const second = await hb.tick();
    assert.equal(second.fired.length, 1, "未记去重位 ⇒ 下一拍重新评估并再试");
    assert.equal(fires.length, 2);
  }
});

test("D-③ 成功点火才记去重位（同条件第二拍不再唤）—— 既有去重口径未弱化", async () => {
  const ledger = fakeLedger([{ featureId: "F1", turnId: "turn-own", contextId: "ctx-1", pending: ["t1"] }]);
  const hb = new Heartbeat(baseDeps({ ledger }));
  assert.equal((await hb.tick()).fired.length, 1);
  assert.deepEqual(ledger.get("F1").firedKeys, ["pending:t1"]);
  assert.equal((await hb.tick()).fired.length, 0, "已唤过的条件不重复点火");
});

// ---------------------------------------------------------------------------
// E 留痕锚
// ---------------------------------------------------------------------------

test("E-① 每次评估与点火尝试各一行结构化日志（featureId / key / occupant / verdict），条目被覆盖后仍可回溯", async () => {
  const logs = [];
  const ledger = fakeLedger([{ featureId: "F1", turnId: "turn-own", contextId: "ctx-1", pending: ["t1"] }]);
  let verdict = { ok: false, reason: "occupant_yield", occupantTurnId: "turn-busy" };
  const hb = new Heartbeat(
    baseDeps({
      ledger,
      log: (line) => logs.push(line),
      now: () => 1_700_000_000_000,
      fire: () => verdict,
    }),
  );

  // 第一拍：命中 + 点火尝试撞 occupant
  await hb.tick();
  const attempt = logs.filter((l) => l.includes("verdict=fire-occupant_yield"));
  assert.equal(attempt.length, 1, `点火尝试留痕一行：${logs.join(" | ")}`);
  assert.match(attempt[0], /^\[heartbeat\] /, "可 grep 的行首");
  assert.ok(attempt[0].includes("featureId=F1"), "含 featureId");
  assert.ok(attempt[0].includes("turnId=turn-own"), "含本条目 turnId");
  assert.ok(attempt[0].includes("key=pending:t1"), "含判据 key");
  assert.ok(attempt[0].includes("occupant=turn-busy"), "含占用轮 turnId");
  assert.ok(attempt[0].includes("1970-01-01T") || attempt[0].includes("20"), "含时间戳（可回溯）");

  // 第二拍：改判成功 ⇒ verdict=fired 一行
  logs.length = 0;
  verdict = { ok: true, reason: "fired" };
  await hb.tick();
  assert.equal(logs.filter((l) => l.includes("verdict=fired")).length, 1);
  assert.ok(logs.some((l) => l.includes("eval featureId=F1") && l.includes("key=pending:t1")));

  // 未命中也留痕一行（no-hit）
  logs.length = 0;
  const hbIdle = new Heartbeat(
    baseDeps({
      ledger: fakeLedger([{ featureId: "F2", turnId: "turn-2", contextId: "c", pending: ["t9"] }]),
      readTaskState: async () => "working",
      log: (line) => logs.push(line),
    }),
  );
  await hbIdle.tick();
  assert.equal(logs.filter((l) => l.includes("featureId=F2") && l.includes("verdict=no-hit") && l.includes("key=-")).length, 1);
});

test("E-② 去重命中与停链闸同样出留痕行（结论闭集可见）", async () => {
  const logs = [];
  const ledger = fakeLedger([{ featureId: "F1", turnId: "turn-own", contextId: "ctx-1", pending: ["t1"], firedKeys: ["pending:t1"] }]);
  const hb = new Heartbeat(baseDeps({ ledger, log: (line) => logs.push(line) }));
  await hb.tick();
  assert.ok(logs.some((l) => l.includes("verdict=deduped") && l.includes("key=pending:t1")), `deduped 留痕：${logs.join(" | ")}`);

  const logs2 = [];
  const hbStopped = new Heartbeat(
    baseDeps({
      ledger: fakeLedger([{ featureId: "F1", turnId: "turn-own", contextId: "ctx-1", pending: ["t1"] }]),
      relay: { chainCount: () => 0, chainLimit: () => 10, isChainStopped: () => true },
      log: (line) => logs2.push(line),
    }),
  );
  await hbStopped.tick();
  assert.ok(logs2.some((l) => l.includes("停链标志已置 ⇒ 不点火")), "停链闸仍走原留痕面");
});
