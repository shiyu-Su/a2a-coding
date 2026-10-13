/**
 * v0.9.5 C1 + C3 用例（离线）：自动接力决策器 + 驱动器 + 收口后引擎态重取。
 *
 * 覆盖（改造文档 §2-C1/§2-C3/§2-C4）：
 * - ① `shouldContinue` 各档：succeed 续（进监视）/ awaiting 停 / failed 停 / timeout 停 /
 *      canceled 恒停 / reviewing 停 / 终态停 / 引擎态读面失败停；
 * - ② 驱动器判定序：① 停链标志 → ② 链内计数触顶 → ③ canceled → ④ 判定表（前置档**短路**：
 *      前档命中时不查探针、不点火）；
 * - ③ 驱动器点火：`fire` 走 `submitTurn`（不显式传 round/contextId）、撞 occupant 放弃并停链、
 *      计数触顶放弃、链内计数人工动作清零；
 * - ④ C3：探针缺省 / 抛错 ⇒ 保守停链不点火；
 * - ⑤ `HostTurnManager.onTurnSettled` 收口回调（缺省 no-op；既有行为零变更；queued 档经收口点触发）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RELAY_CHAIN_LIMIT,
  RELAY_PROMPT_TITLE,
  HostRelay,
  buildRelayPrompt,
  createHostRelay,
  shouldContinue,
} from "../dist/host-relay.js";
import { HostTurnManager } from "../dist/host-turn.js";
import { createHostFace } from "../dist/host-face.js";

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

/** 一次 `fire` 用的假轮结果（`submitTurn` 返回形状的最小面）。 */
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

function turnResult(over = {}) {
  return {
    turnId: "turn-1",
    requirementId: "F1",
    org: "g",
    contextId: "ctx-1",
    taskId: "task-1",
    state: "succeeded",
    kind: "succeeded",
    text: "摘要",
    summary: "摘要",
    question: null,
    error: null,
    bridgeNote: null,
    display: "已完成",
    queuedAt: "q",
    startedAt: "s",
    finishedAt: "f",
    ...over,
  };
}

function snap(state, over = {}) {
  return { state, stage: "改造", approval: "已通过", ...over };
}

/** 轮询让事件循环推进直到条件成立（`handleTurnSettled` 内部异步决策）。 */
async function waitUntil(predicate, limit = 500) {
  for (let i = 0; i < limit; i += 1) {
    if (predicate()) return true;
    await new Promise((res) => setImmediate(res));
  }
  return false;
}

// ---------------------------------------------------------------------------
// ① shouldContinue 判定表
// ---------------------------------------------------------------------------

test("C1-① shouldContinue：succeeded + 执行中 ⇒ **续（进监视）**，不立即点火", () => {
  const auto = shouldContinue({ state: "succeeded" }, snap("executing"));
  assert.equal(auto.action, "continue");
  assert.equal(auto.mode, "monitor");
  assert.equal(auto.monitor, "auto", "无 suspend 条目 ⇒ 自动进监视（纯 DAG）");

  const explicit = shouldContinue({ state: "succeeded" }, snap("executing"), { pendingCount: 2 });
  assert.equal(explicit.action, "continue");
  assert.equal(explicit.mode, "monitor");
  assert.equal(explicit.monitor, "suspend", "有显式挂起条目 ⇒ 按 pending 查");
});

test("C1-② shouldContinue：awaiting_answer / failed / timeout ⇒ 交人停链（不重试）", () => {
  for (const state of ["awaiting_answer", "failed", "timeout"]) {
    const d = shouldContinue({ state }, snap("executing"));
    assert.equal(d.action, "stop", `${state} 必须停`);
    assert.equal(d.mode, null);
  }
});

test("C1-③ shouldContinue：canceled 恒停（任意引擎态 / 任意条目）· queued/running 非收口态停", () => {
  for (const engine of [snap("executing"), snap("reviewing"), null]) {
    assert.equal(shouldContinue({ state: "canceled" }, engine).action, "stop");
  }
  assert.equal(shouldContinue({ state: "canceled" }, snap("executing"), { pendingCount: 1 }).action, "stop");
  assert.equal(shouldContinue({ state: "queued" }, snap("executing")).action, "stop");
  assert.equal(shouldContinue({ state: "running" }, snap("executing")).action, "stop");
});

test("C1-④ shouldContinue：succeeded + reviewing / 终态 ⇒ 交人停链（验收/结束）", () => {
  for (const state of ["reviewing", "integrating", "testing", "completed", "failed", "cancelled", "waiting_approval", "version_planning", "decomposing"]) {
    const d = shouldContinue({ state: "succeeded" }, snap(state));
    assert.equal(d.action, "stop", `引擎态 ${state} 必须停`);
  }
});

test("C1-⑤ shouldContinue（C3）：引擎态未知 / 探针未装配 ⇒ 保守停链不点火", () => {
  assert.equal(shouldContinue({ state: "succeeded" }, null).action, "stop");
  assert.equal(shouldContinue(null, snap("executing")).action, "stop", "无轮收口信号 ⇒ 停");
});

// ---------------------------------------------------------------------------
// ② 驱动器判定序（前置档短路：不查探针、不点火）
// ---------------------------------------------------------------------------

test("C1-⑥ 判定序① 停链标志先于一切：置标志后收口 ⇒ 不点火、**不查探针**", async () => {
  const calls = { submit: 0, probe: 0 };
  const relay = createHostRelay({
    submitTurn: () => {
      calls.submit += 1;
      return fakeSubmitted();
    },
    probe: {
      async fetchEngineState() {
        calls.probe += 1;
        return snap("executing");
      },
    },
  });
  relay.requestStop("F1");
  relay.handleTurnSettled(turnResult());
  await new Promise((res) => setImmediate(res));
  assert.equal(calls.probe, 0, "判定序① 命中后不得走到 C3 探针");
  assert.equal(calls.submit, 0);
  assert.equal(relay.isChainStopped("F1"), true);
});

test("C1-⑦ 判定序② 链内计数触顶：到顶后收口 ⇒ 不点火、不查探针", async () => {
  const calls = { submit: 0, probe: 0 };
  const relay = createHostRelay({
    chainLimit: 2,
    submitTurn: () => {
      calls.submit += 1;
      return fakeSubmitted();
    },
    probe: {
      async fetchEngineState() {
        calls.probe += 1;
        return snap("executing");
      },
    },
  });
  assert.equal(relay.fire(turnResult(), snap("executing")).ok, true);
  assert.equal(relay.fire(turnResult(), snap("executing")).ok, true);
  assert.equal(relay.chainCount("F1"), 2);
  assert.equal(relay.fire(turnResult(), snap("executing")).reason, "limit");

  relay.handleTurnSettled(turnResult());
  await new Promise((res) => setImmediate(res));
  assert.equal(calls.probe, 0, "判定序② 命中后不得走到 C3 探针");
  assert.equal(relay.chainCount("F1"), 2, "到顶不发新点火");
});

test("C1-⑧ 判定序③ canceled 先于判定表：canceled 收口 ⇒ 不查探针、不点火（防停链自激）", async () => {
  const calls = { probe: 0 };
  const relay = createHostRelay({
    submitTurn: () => fakeSubmitted(),
    probe: {
      async fetchEngineState() {
        calls.probe += 1;
        return snap("executing");
      },
    },
  });
  relay.handleTurnSettled(turnResult({ state: "canceled", kind: "canceled" }));
  await new Promise((res) => setImmediate(res));
  assert.equal(calls.probe, 0, "判定序③ 命中后不得走到 C3 探针（否则停链→取消→回调→自激）");
});

test("C1-⑨ 判定序④ 判定表：succeeded+执行中 ⇒ 进监视（不立即点火）· reviewing ⇒ 停", async () => {
  const settle = [];
  const relay = createHostRelay({
    submitTurn: () => fakeSubmitted(),
    probe: { async fetchEngineState() { return snap("executing"); } },
    log: (line) => settle.push(line),
  });
  relay.handleTurnSettled(turnResult());
  await waitUntil(() => settle.some((l) => l.includes("判定序④")));
  assert.equal(settle.some((l) => l.includes("continue/auto")), true);
  assert.equal(settle.some((l) => l.includes("进监视")), true, "succeeded+执行中 ⇒ 进监视、不立即点火");

  settle.length = 0;
  const relay2 = createHostRelay({
    submitTurn: () => fakeSubmitted(),
    probe: { async fetchEngineState() { return snap("reviewing"); } },
    log: (line) => settle.push(line),
  });
  relay2.handleTurnSettled(turnResult());
  await waitUntil(() => settle.some((l) => l.includes("判定序④")));
  assert.equal(settle.some((l) => l.includes("stop")), true, "reviewing ⇒ 交人停链");
});

// ---------------------------------------------------------------------------
// ③ 驱动器点火（fire；C8 心跳唤醒复用同一路径）
// ---------------------------------------------------------------------------

test("C1-⑩ fire：只调 submitTurn（同 contextId 复用 / round 自增由轮管理器完成，不显式传）", () => {
  const seen = [];
  const relay = createHostRelay({
    submitTurn: (input) => {
      seen.push(input);
      return fakeSubmitted({ round: 3, turnId: "turn-3" });
    },
  });
  const r = relay.fire(turnResult(), snap("executing"));
  assert.equal(r.ok, true);
  assert.equal(r.round, 3);
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ["org", "requirementId", "text"]);
  assert.equal(seen[0].requirementId, "F1");
  assert.equal(seen[0].org, "g");
  assert.match(seen[0].text, /【板 · 自动接力】/);
  // §3.6：提示词不得出现任何 MCP 工具全名
  for (const bad of ["a2a_feature_approve", "a2a_feature_advance", "a2a_feature_cancel"]) {
    assert.equal(seen[0].text.includes(bad), false);
  }
});

test("C1-⑪ fire：撞 occupant ⇒ 放弃这一发并停链（不重试、不轮询）", () => {
  const relay = createHostRelay({
    submitTurn: () =>
      fakeSubmitted({ occupant: { turnId: "turn-busy", state: "running", round: 2, requirementId: "F1", org: "g", contextId: "c", queuedAt: "q", startedAt: null } }),
  });
  const r = relay.fire(turnResult(), snap("executing"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "occupant");
  assert.equal(relay.isChainStopped("F1"), true, "撞 occupant ⇒ 停链");
});

test("C1-⑫ 链内计数：人工动作清零（fire 计数累计 → noteManualAction 归零）", () => {
  const relay = createHostRelay({ submitTurn: () => fakeSubmitted() });
  relay.fire(turnResult(), null);
  relay.fire(turnResult(), null);
  assert.equal(relay.chainCount("F1"), 2);
  relay.noteManualAction("F1", "supplement");
  assert.equal(relay.chainCount("F1"), 0, "任何人工动作清零链内计数");
  assert.equal(relay.chainLimit(), DEFAULT_RELAY_CHAIN_LIMIT);
});

test("C1-⑬ createHostRelay 与 buildRelayPrompt：把引擎态快照作为结构化事实交给 agent", () => {
  const p = buildRelayPrompt({ featureId: "F1", org: "g", engine: { state: "executing", stage: "改造", approval: "已通过" } });
  assert.match(p, /【板 · 自动接力】/);
  assert.match(p, /state = executing/);
  assert.match(p, /stage = 改造/);
  assert.equal(RELAY_PROMPT_TITLE, "【板 · 自动接力】");
  assert.ok(createHostRelay({ submitTurn: () => fakeSubmitted() }) instanceof HostRelay);
});

// ---------------------------------------------------------------------------
// ④ C3：探针失败 / 缺省 ⇒ 保守停链
// ---------------------------------------------------------------------------

test("C3-⑭ 探针缺省 ⇒ succeeded 收口不点火（判不了引擎态就不烧轮）", async () => {
  let submits = 0;
  const relay = createHostRelay({
    submitTurn: () => {
      submits += 1;
      return fakeSubmitted();
    },
  });
  relay.handleTurnSettled(turnResult());
  await new Promise((res) => setImmediate(res));
  assert.equal(submits, 0);
});

test("C3-⑮ 探针抛错 ⇒ 保守停链（留痕「C3 引擎态重取失败」）", async () => {
  const lines = [];
  const relay = createHostRelay({
    submitTurn: () => fakeSubmitted(),
    probe: { async fetchEngineState() { throw new Error("桥读面不可用（假）"); } },
    log: (line) => lines.push(line),
  });
  relay.handleTurnSettled(turnResult());
  await waitUntil(() => lines.some((l) => l.includes("C3 引擎态重取失败")));
  assert.equal(lines.some((l) => l.includes("保守停链")), true);
  assert.equal(lines.some((l) => l.includes("进监视")), false, "读面失败不得进监视/点火");
});

// ---------------------------------------------------------------------------
// ⑤ HostTurnManager.onTurnSettled 收口回调
// ---------------------------------------------------------------------------

function fakeGateway() {
  return {
    async ensureBridge() {
      return { ok: true, port: 9101, reused: true, error: null };
    },
    beginRound() {},
    endRound() {},
  };
}

/** 每次 `message/send` 造一条脚本化任务；`tasks/get` 按 `pollStates` 推进（含 working 停留）。 */
function fakeBridge(scripts) {
  const tasks = new Map();
  let n = 0;
  let index = 0;
  const rpc = async (body) => {
    const { method, params, id } = body;
    if (method === "message/send") {
      const script = scripts[Math.min(index, scripts.length - 1)] ?? { pollStates: ["completed"], text: "ok" };
      index += 1;
      n += 1;
      const task = { id: `task-${n}`, state: "working", polls: 0, terminal: false, script };
      tasks.set(task.id, task);
      return { jsonrpc: "2.0", id, result: view(task) };
    }
    if (method === "tasks/get") {
      const task = tasks.get(params.id);
      if (task === undefined) return { jsonrpc: "2.0", id, error: { code: -32001, message: "未知任务" } };
      if (!task.terminal) {
        task.polls += 1;
        const plan = task.script.pollStates ?? ["completed"];
        const next = plan[Math.min(task.polls - 1, plan.length - 1)];
        task.state = next;
        if (next !== "working") task.terminal = true;
      }
      return { jsonrpc: "2.0", id, result: view(task) };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "未知方法" } };
  };
  const view = (task) => ({
    id: task.id,
    status: {
      state: task.state,
      ...((task.state === "input-required" || task.state === "failed")
        ? { message: { role: "agent", parts: [{ kind: "text", text: task.script.question ?? task.script.reason ?? "" }], messageId: task.id } }
        : {}),
    },
    artifacts:
      task.state === "completed" || task.state === "canceled"
        ? [{ artifactId: "a", name: "response", parts: [{ kind: "text", text: task.script.text ?? "" }] }]
        : [],
  });
  return rpc;
}

function fakeClock() {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    delay: async (ms) => {
      t += ms;
      await new Promise((res) => setImmediate(res));
    },
  };
}

function manager({ onTurnSettled, scripts = [{ pollStates: ["completed"], text: "ok" }] } = {}) {
  const clock = fakeClock();
  const bridge = fakeBridge(scripts);
  const deps = {
    gateway: fakeGateway(),
    rpcFor: () => bridge,
    ledger: null,
    now: clock.now,
    delay: clock.delay,
    idFactory: (() => {
      let n = 0;
      return () => `id-${String(++n)}`;
    })(),
    pollIntervalMs: 5,
    turnTimeoutMs: 5_000,
  };
  if (onTurnSettled !== undefined) deps.onTurnSettled = onTurnSettled;
  const m = new HostTurnManager(deps);
  return { m, clock };
}

test("C1-⑯ onTurnSettled：缺省 no-op（不传回调照常收口）· setTurnSettledHandler 可后装", async () => {
  const { m } = manager();
  const submitted = m.submitTurn({ org: "g", requirementId: "F1", text: "开始" });
  const result = await submitted.done;
  assert.equal(result.state, "succeeded");

  const seen = [];
  m.setTurnSettledHandler((r) => seen.push(r));
  const s2 = m.submitTurn({ org: "g", requirementId: "F1", text: "再来" });
  await s2.done;
  assert.equal(seen.length, 1, "装回调后每次收口回调一次");
  assert.equal(seen[0].requirementId, "F1");
  assert.equal(seen[0].state, "succeeded");
});

test("C1-⑰ queued 档经收口点触发接力（排队轮终态同样回调）", async () => {
  const seen = [];
  const { m } = manager({
    onTurnSettled: (r) => seen.push(r),
    scripts: [
      { pollStates: ["working", "working", "completed"], text: "A" },
      { pollStates: ["completed"], text: "B" },
    ],
  });
  const a = m.submitTurn({ org: "g", requirementId: "FA", text: "甲" });
  const b = m.submitTurn({ org: "g", requirementId: "FB", text: "乙" });
  assert.equal(a.queued, false);
  assert.equal(b.queued, true, "同一桥同刻只跑一轮 ⇒ 第二条排队");
  await a.done;
  await b.done;
  await waitUntil(() => seen.length === 2);
  assert.equal(seen.length, 2, "queued 档的终态同样经收口点回调（不因挂请求路径而漏）");
  const ids = seen.map((r) => r.requirementId).sort();
  assert.deepEqual(ids, ["FA", "FB"]);
});

// ---------------------------------------------------------------------------
// ⑥ BoardHostFace.startRelay 装配入口 / 停链口
// ---------------------------------------------------------------------------

function fakeTurns(over = {}) {
  const calls = { submit: 0, settledHandler: null };
  const turns = {
    submitTurn() {
      calls.submit += 1;
      return fakeSubmitted();
    },
    answerTurn() {
      return fakeSubmitted();
    },
    latestTurnOf() {
      return null;
    },
    findAwaitingTurn() {
      return null;
    },
    busyTurnOf() {
      return null;
    },
    queueView(org) {
      return { org, running: null, waiting: [], capacity: 1 };
    },
    activeTurns() {
      return [];
    },
    setTurnSettledHandler(handler) {
      calls.settledHandler = handler;
    },
    ...over,
  };
  return { turns, calls };
}

function faceDeps(turns, over = {}) {
  return {
    bridges: { async ensureStarted() { return { ok: true, status: { state: "running", pid: 1, port: 9101, kind: "claude", display: "ok", error: null }, reused: true }; }, async stop() { return null; }, statuses() { return []; }, async health() { return null; } },
    turns,
    orgsDir: "C:/orgs",
    defaultOrg: "g",
    dirKind: () => "dir",
    ...over,
  };
}

test("C1-⑱ startRelay：轮管理器不支持回调 ⇒ 返 null 不装（既有行为零变更）", () => {
  const { turns } = fakeTurns({ setTurnSettledHandler: undefined });
  const face = createHostFace(faceDeps(turns));
  assert.equal(face.startRelay(), null);
  assert.equal(face.relayOf(), null);
});

test("C1-⑲ startRelay：装回调 + 幂等 + 停链口可停 / 可解", () => {
  const { turns, calls } = fakeTurns();
  const face = createHostFace(faceDeps(turns));
  const relay = face.startRelay();
  assert.ok(relay !== null);
  assert.equal(face.startRelay(), relay, "幂等：重复起返回同一实例");
  assert.equal(typeof calls.settledHandler, "function", "已把收口回调接到轮管理器");

  assert.equal(face.chainStopped("F1"), false);
  assert.equal(face.requestStopChain("F1"), true);
  assert.equal(face.chainStopped("F1"), true, "停链口置标志");
  assert.equal(face.clearStopChain("F1"), true);
  assert.equal(face.chainStopped("F1"), false);
});

test("C1-⑳ 人工动作（触发 / 确认 / 回答）⇒ 链内计数清零", async () => {
  const { turns } = fakeTurns();
  const face = createHostFace(faceDeps(turns));
  const relay = face.startRelay();
  relay.fire(turnResult(), null);
  relay.fire(turnResult(), null);
  assert.equal(relay.chainCount("F1"), 2);

  await face.triggerTurn({ featureId: "F1", org: "g" });
  assert.equal(relay.chainCount("F1"), 0, "人工触发 ⇒ 清零");

  relay.fire(turnResult(), null);
  await face.confirmTurn({ featureId: "F1", org: "g" });
  assert.equal(relay.chainCount("F1"), 0, "人工确认 ⇒ 清零");

  relay.fire(turnResult(), null);
  // 回答入口要求存在待澄清轮 ⇒ 用一个假 awaiting 记录放行
  const turns2Calls = fakeTurns({ findAwaitingTurn: () => ({ turnId: "t", requirementId: "F1", org: "g", state: "awaiting_answer", updatedAt: "z" }) });
  const face2 = createHostFace(faceDeps(turns2Calls.turns));
  const relay2 = face2.startRelay();
  relay2.fire(turnResult(), null);
  await face2.answerRequirement({ featureId: "F1", answer: "就这样" });
  assert.equal(relay2.chainCount("F1"), 0, "人工回答 ⇒ 清零");
});
