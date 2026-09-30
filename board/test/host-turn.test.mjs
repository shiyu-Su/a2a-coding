import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  A2A_JSONRPC_PATH,
  AWAITING_ANSWER_DISPLAY,
  BOARD_CONTEXT_ID_PREFIX,
  BRIDGE_RESTART_NOTE,
  HostTurnError,
  HostTurnManager,
  QUEUED_DISPLAY,
  buildMessageSendRequest,
  buildTasksCancelRequest,
  buildTasksGetRequest,
  classifyTaskState,
  createHostBridgeGateway,
  isTerminalTaskState,
  newBoardContextId,
  parseTaskResponse,
  summarizeTurnText,
  turnStateOfKind,
} from "../dist/host-turn.js";
import { HostTurnLedgerStore, findTurn } from "../dist/host-turn-ledger.js";
import { HOST_BRIDGE_DOWN_MESSAGE } from "../dist/host-bridge.js";

// ---------------------------------------------------------------------------
// 测试替身 —— **本节点不起真桥**：RPC / 端口 / 时钟全部注入
// ---------------------------------------------------------------------------

/**
 * 假桥的 A2A 面（形状逐字对齐 `machine/acp-bridge/a2a-server.ts` + `task-registry.ts`）：
 * - 只认 `message/send` / `tasks/get` / `tasks/cancel`；
 * - `completed` 的全文只放 `artifacts[name="response"]`（`status.message` 刻意不带）；
 * - `input-required` / `failed` 的短文放 `status.message`；
 * - 在飞计数：`send` 时 +1、首次读到终态（或被 cancel）时 -1 ⇒ 用于钉死「同刻在飞 ≤ 1」。
 */
function fakeBridge(scripts = []) {
  const log = {
    calls: [],
    sends: [],
    inFlight: 0,
    maxInFlight: 0,
    taskCount: 0,
  };
  const tasks = new Map();
  let sendIndex = 0;

  const view = (task) => {
    const status = { state: task.state };
    if (task.state === "input-required" || task.state === "failed") {
      status.message = {
        role: "agent",
        parts: [{ kind: "text", text: task.state === "input-required" ? task.question : task.reason }],
        messageId: task.id,
      };
    }
    return {
      id: task.id,
      status,
      artifacts:
        task.state === "completed" || task.state === "canceled"
          ? [{ artifactId: `a-${task.id}`, name: "response", parts: [{ kind: "text", text: task.text ?? "" }] }]
          : [],
    };
  };

  const rpc = async (body) => {
    const { method, params, id } = body;
    log.calls.push({ method, id });
    if (method === "message/send") {
      const script = scripts[Math.min(sendIndex, scripts.length - 1)] ?? { pollStates: ["completed"], text: "结果" };
      sendIndex += 1;
      log.taskCount += 1;
      const task = {
        id: `task-${String(log.taskCount)}`,
        contextId: params.message.contextId,
        state: "working",
        polls: 0,
        terminal: false,
        script,
        text: script.text ?? null,
        question: script.question ?? null,
        reason: script.reason ?? null,
      };
      tasks.set(task.id, task);
      log.inFlight += 1;
      log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
      log.sends.push({
        contextId: params.message.contextId,
        messageId: params.message.messageId,
        text: params.message.parts[0].text,
        blocking: params.configuration?.blocking,
      });
      return { jsonrpc: "2.0", id, result: view(task) };
    }
    if (method === "tasks/get") {
      const task = tasks.get(params.id);
      if (task === undefined) {
        return { jsonrpc: "2.0", id, error: { code: -32001, message: `未知任务 ${String(params.id)}` } };
      }
      if (!task.terminal) {
        task.polls += 1;
        const plan = task.script.pollStates ?? ["completed"];
        const next = plan[Math.min(task.polls - 1, plan.length - 1)];
        task.state = next;
        if (next !== "working") {
          task.terminal = true;
          log.inFlight -= 1;
        }
      }
      return { jsonrpc: "2.0", id, result: view(task) };
    }
    if (method === "tasks/cancel") {
      const task = tasks.get(params.id);
      if (task === undefined) {
        return { jsonrpc: "2.0", id, error: { code: -32001, message: `未知任务 ${String(params.id)}` } };
      }
      if (!task.terminal) {
        task.state = "canceled";
        task.terminal = true;
        log.inFlight -= 1;
      }
      return { jsonrpc: "2.0", id, result: view(task) };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `未知方法 ${String(method)}` } };
  };

  return { rpc, log, count: (method) => log.calls.filter((c) => c.method === method).length };
}

/** 假 BD4a 出口：端口可给、`reused` 可控，并记录 beginRound/endRound 配对。 */
function fakeGateway(options = {}) {
  const { ok = true, error = null, portOf = () => 9101, reusedOf = () => true } = options;
  const events = [];
  let roundInFlight = 0;
  let maxRoundInFlight = 0;
  return {
    events,
    get roundInFlight() {
      return roundInFlight;
    },
    get maxRoundInFlight() {
      return maxRoundInFlight;
    },
    async ensureBridge(org) {
      events.push({ fn: "ensureBridge", org });
      if (!ok) return { ok: false, port: null, reused: false, error };
      return { ok: true, port: portOf(org), reused: reusedOf(org), error: null };
    },
    beginRound(org) {
      events.push({ fn: "beginRound", org });
      roundInFlight += 1;
      maxRoundInFlight = Math.max(maxRoundInFlight, roundInFlight);
    },
    endRound(org) {
      events.push({ fn: "endRound", org });
      roundInFlight -= 1;
    },
  };
}

/**
 * 单时钟假时间：`delay` **推进时钟并让出宏任务队列**（`setImmediate`）——
 * 否则「只推进时钟的立即 resolve」会让轮询变成纯微任务热循环，测试观察不到
 * 「同刻在飞 ≤ 1」这类中间态（在飞/排队态会被一次性跑光）。
 */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    delay: async (ms) => {
      t += ms;
      await new Promise((res) => setImmediate(res));
    },
  };
}

function tempLedger() {
  const dir = mkdtempSync(join(tmpdir(), "board-host-turn-"));
  return new HostTurnLedgerStore(join(dir, "host-turns.json"));
}

/** 单桥（默认 org = flow）常用组合；多组织场景自行 new HostTurnManager。 */
function harness({ scripts = [], bridge = fakeBridge(scripts), gateway = {}, ledger, pollIntervalMs = 10, turnTimeoutMs = 5_000 } = {}) {
  const gw = fakeGateway(gateway);
  const clock = fakeClock();
  const ledgerStore = ledger === undefined ? tempLedger() : ledger;
  const manager = new HostTurnManager({
    gateway: gw,
    rpcFor: () => bridge.rpc,
    ledger: ledgerStore,
    now: clock.now,
    delay: clock.delay,
    idFactory: seqFactory(),
    pollIntervalMs,
    turnTimeoutMs,
  });
  return { manager, bridge, log: bridge.log, count: bridge.count, gw, clock, ledger: ledgerStore };
}

/** 确定性 id 源：同一序列按调用序取号（turn / contextId 共用）。 */
function seqFactory() {
  let n = 0;
  return () => `id-${String(++n)}`;
}

/** 让出事件循环直到条件成立（带次数上限防测试挂死）。 */
async function waitUntil(predicate, limit = 2000) {
  for (let i = 0; i < limit; i += 1) {
    if (predicate()) return true;
    await new Promise((res) => setImmediate(res));
  }
  return false;
}

/** 等到收口；附带提交时的身份字段（`round` / `queued` / `position`），便于逐条断言。 */
async function settled(submitted) {
  const result = await submitted.done;
  return { ...result, round: submitted.round, queued: submitted.queued, position: submitted.position };
}

// ---------------------------------------------------------------------------
// 纯函数（报文 / 状态归一 / 摘要）
// ---------------------------------------------------------------------------

test("报文构造：message/send 非 blocking + messageId 必填 + contextId 落位（桥的硬校验）", () => {
  const body = buildMessageSendRequest({ contextId: "board-ctx-1", text: "开始访谈", messageId: "turn-1" }, 7);
  assert.equal(body.method, "message/send");
  assert.equal(body.params.message.configuration ?? undefined, undefined);
  assert.deepEqual(body.params.message.parts, [{ kind: "text", text: "开始访谈" }]);
  assert.equal(body.params.configuration.blocking, false);
  assert.equal(body.params.message.contextId, "board-ctx-1");
  assert.throws(() => buildMessageSendRequest({ contextId: " ", text: "x", messageId: "m" }), /contextId/);
  assert.throws(() => buildMessageSendRequest({ contextId: "c", text: " ", messageId: "m" }), /文本为空/);
  assert.throws(() => buildMessageSendRequest({ contextId: "c", text: "x", messageId: "" }), /messageId/);
});

test("报文构造：tasks/get 与 tasks/cancel 同形状（只 id 一个参数）", () => {
  assert.deepEqual(buildTasksGetRequest("task-1", 3), {
    jsonrpc: "2.0",
    id: 3,
    method: "tasks/get",
    params: { id: "task-1" },
  });
  assert.deepEqual(buildTasksCancelRequest("task-1", 2), {
    jsonrpc: "2.0",
    id: 2,
    method: "tasks/cancel",
    params: { id: "task-1" },
  });
  assert.throws(() => buildTasksCancelRequest("", 2), /缺失任务 id/);
});

test("状态归一：input-required ⇒ awaiting_answer（**不是失败**）· 未知态不吞成成功", () => {
  assert.equal(classifyTaskState("completed"), "succeeded");
  assert.equal(classifyTaskState("input-required"), "awaiting_answer");
  assert.equal(classifyTaskState("canceled"), "canceled");
  assert.equal(classifyTaskState("failed"), "failed");
  assert.equal(classifyTaskState("rejected"), "failed");
  assert.equal(classifyTaskState("auth-required"), "failed");
  assert.equal(classifyTaskState("some-future-state"), "failed");
  assert.equal(turnStateOfKind("awaiting_answer"), "awaiting_answer");
  // 桥的终态闭集：working 之外全终态；桥**不产出 blocked**（见 host-turn.ts 文件头）
  assert.equal(isTerminalTaskState("working"), false);
  assert.equal(isTerminalTaskState("blocked"), true, "未知终态按终态收（防无限等）");
  assert.equal(classifyTaskState("blocked"), "failed");
});

test("响应解析：completed 取 artifact 全文 · input-required 取 status.message 短文 · RPC 错误结构化抛", () => {
  const done = parseTaskResponse({
    jsonrpc: "2.0",
    id: 3,
    result: {
      id: "task-9",
      status: { state: "completed" },
      artifacts: [{ artifactId: "a", name: "response", parts: [{ kind: "text", text: "需求确认单已落文件" }] }],
    },
  });
  assert.equal(done.terminal, true);
  assert.equal(done.kind, "succeeded");
  assert.equal(done.text, "需求确认单已落文件");
  assert.equal(done.question, null);

  const clarify = parseTaskResponse({
    result: {
      id: "task-10",
      status: {
        state: "input-required",
        message: { role: "agent", parts: [{ kind: "text", text: "版本是 v0.9.0 吗？" }], messageId: "task-10" },
      },
      artifacts: [],
    },
  });
  assert.equal(clarify.terminal, true);
  assert.equal(clarify.kind, "awaiting_answer");
  assert.equal(clarify.question, "版本是 v0.9.0 吗？");

  const working = parseTaskResponse({ result: { id: "task-11", status: { state: "working" }, artifacts: [] } });
  assert.equal(working.terminal, false);
  assert.equal(working.kind, "failed", "未收口时 kind 不参与判定，只有 terminal 驱动轮询");

  assert.throws(
    () => parseTaskResponse({ error: { code: -32001, message: "未知任务 task-x" } }),
    (err) => err.code === "task_not_found" && err.rpcCode === -32001,
  );
  assert.throws(() => parseTaskResponse("not json"), /不是 JSON 对象/);
  assert.throws(() => parseTaskResponse({ result: {} }), /缺 result.id/);
});

test("摘要与 contextId 前缀：折叠空白 + 截断 · 板侧会话一眼可辨", () => {
  assert.equal(summarizeTurnText("  多行\n\n文本  "), "多行 文本");
  assert.equal(summarizeTurnText(null), null);
  assert.equal(summarizeTurnText("   "), null);
  assert.match(summarizeTurnText("x".repeat(500), 400), /…$/);
  assert.match(newBoardContextId(() => "abc"), new RegExp(`^${BOARD_CONTEXT_ID_PREFIX}`));
  assert.equal(A2A_JSONRPC_PATH, "/a2a/jsonrpc");
});

// ---------------------------------------------------------------------------
// ① contextId 纪律
// ---------------------------------------------------------------------------

test("① 新需求 ⇒ 板分配新 contextId（每需求一个，且落板侧台账）", async () => {
  const h = harness({ scripts: [{ pollStates: ["completed"], text: "ok" }] });
  const r1 = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A 的需求" }));
  const r2 = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-B", text: "B 的需求" }));
  assert.match(r1.contextId, new RegExp(`^${BOARD_CONTEXT_ID_PREFIX}`));
  assert.notEqual(r1.contextId, r2.contextId, "跨需求绝不共享 contextId");
  assert.equal(h.log.sends[0].contextId, r1.contextId);
  assert.equal(h.log.sends[1].contextId, r2.contextId);
  assert.equal(r1.round, 1);
  assert.equal(r2.round, 1);
  // 台账里就是这两个会话（事实源在板侧，不写引擎）
  assert.equal(h.manager.sessionOf("REQ-A").contextId, r1.contextId);
  assert.equal(h.manager.sessionOf("REQ-B").contextId, r2.contextId);
});

test("① 同需求续推 ⇒ 复用同一 contextId（澄清续推 / 失败重派同一条会话）", async () => {
  const h = harness({
    scripts: [
      { pollStates: ["input-required"], question: "确认版本？" },
      { pollStates: ["completed"], text: "已确认 v0.9.0" },
    ],
  });
  const first = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "开始" }));
  const second = await settled(h.manager.answerTurn({ org: "flow", requirementId: "REQ-A", answer: "v0.9.0" }));
  assert.equal(second.contextId, first.contextId, "同一需求的后续轮必须落回同一会话");
  assert.equal(second.round, 2);
  assert.equal(h.log.sends.length, 2);
  assert.equal(h.log.sends[1].contextId, first.contextId);
  assert.equal(h.log.sends[1].text, "v0.9.0", "续发的正文就是回答");
  assert.equal(h.manager.sessionOf("REQ-A").round, 2);
});

// ---------------------------------------------------------------------------
// ② 单飞闸（§3.4 硬口径）
// ---------------------------------------------------------------------------

test("② 单飞闸：同桥第二个需求排队而非并发（任意时刻在飞 prompt ≤ 1）", async () => {
  const h = harness({
    scripts: [
      { pollStates: ["working", "working", "completed"], text: "第一轮" },
      { pollStates: ["completed"], text: "第二轮" },
    ],
  });
  const a = h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" });
  const b = h.manager.submitTurn({ org: "flow", requirementId: "REQ-B", text: "B" });
  assert.equal(a.queued, false);
  assert.equal(a.position, 1);
  assert.equal(b.queued, true, "第二个需求必须落在闸后");
  assert.equal(b.position, 1, "队列里第一位");
  assert.equal(b.display, QUEUED_DISPLAY);
  const view = h.manager.queueView("flow");
  assert.equal(view.capacity, 1, "并发上限恒 1（§3.4：挂在桥上）");
  assert.equal(view.running.turnId, a.turnId);
  assert.equal(view.running.requirementId, "REQ-A");
  assert.deepEqual(
    view.waiting,
    [{ turnId: b.turnId, requirementId: "REQ-B", queuedAt: view.waiting[0].queuedAt, display: QUEUED_DISPLAY }],
    "闸位与队列可见面：running 一个 + waiting 一个（界面据此显示「排队中」）",
  );
  assert.equal(h.manager.activeTurns("flow").length, 2);

  const ra = await a.done;
  const rb = await b.done;
  assert.equal(ra.state, "succeeded");
  assert.equal(rb.state, "succeeded");
  assert.equal(h.log.maxInFlight, 1, "**同桥同刻在飞必须 ≤ 1**（桥内零并发闸）");
  assert.equal(h.log.sends.length, 2);
  assert.equal(h.gw.maxRoundInFlight, 1, "BD4a 的在飞轮数同样不越 1");
  assert.equal(h.gw.roundInFlight, 0, "全部收口后在飞计数归零");
});

test("② 前一轮收口后闸位交出（含 awaiting_answer：等人不占桥）", async () => {
  const h = harness({
    scripts: [
      { pollStates: ["input-required"], question: "要澄清" },
      { pollStates: ["completed"], text: "B 跑完了" },
    ],
  });
  const a = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" }));
  assert.equal(a.state, "awaiting_answer");
  const b = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-B", text: "B" }));
  assert.equal(b.state, "succeeded");
  assert.equal(h.log.maxInFlight, 1);
  assert.equal(h.gw.roundInFlight, 0, "待澄清那一轮已交闸（人回答的时间不能占住整条桥）");
});

test("② 跨组织各自在飞 ⇒ 并行的唯一来源是多组织（闸按桥 keyed）", async () => {
  const one = fakeBridge([{ pollStates: ["working", "working", "completed"], text: "flow" }]);
  const two = fakeBridge([{ pollStates: ["working", "working", "completed"], text: "other" }]);
  const gw = fakeGateway({ portOf: (org) => (org === "flow" ? 9101 : 9102) });
  const clock = fakeClock();
  const manager = new HostTurnManager({
    gateway: gw,
    rpcFor: (port) => (port === 9101 ? one.rpc : two.rpc),
    ledger: null,
    now: clock.now,
    delay: clock.delay,
    idFactory: seqFactory(),
    pollIntervalMs: 10,
  });
  const a = manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" });
  const b = manager.submitTurn({ org: "other", requirementId: "REQ-B", text: "B" });
  assert.equal(a.queued, false);
  assert.equal(b.queued, false, "不同桥 ⇒ 不必排队");
  await Promise.all([a.done, b.done]);
  assert.equal(one.log.maxInFlight, 1);
  assert.equal(two.log.maxInFlight, 1);
  assert.equal(gw.maxRoundInFlight, 2, "两条桥各自一个在飞（全局在飞 2，桥侧各 1）");
});

// ---------------------------------------------------------------------------
// ③ 轮询终态即停 + 超时有界
// ---------------------------------------------------------------------------

test("③ tasks/get 轮询到终态即停（终态后一次也不多发）", async () => {
  const h = harness({ scripts: [{ pollStates: ["working", "working", "completed"], text: "三轮读取" }] });
  const r = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" }));
  assert.equal(r.state, "succeeded");
  assert.equal(h.log.sends.length, 1);
  assert.equal(h.count("tasks/get"), 3, "两次 working + 一次 completed ⇒ 恰三次读取");
  assert.equal(r.text, "三轮读取");
  assert.equal(r.taskId, "task-1");
});

test("③ 超时有界：到点停止轮询 + 尽力 tasks/cancel + 落 timeout（不无限等）", async () => {
  const h = harness({ scripts: [{ pollStates: ["working"] }], turnTimeoutMs: 50, pollIntervalMs: 10 });
  const r = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "永不结束的轮" }));
  assert.equal(r.state, "timeout");
  assert.equal(r.kind, "failed");
  assert.equal(r.error.code, "turn_timeout");
  assert.match(r.error.message, /有界上限/);
  assert.equal(h.count("tasks/cancel"), 1, "超时须尽力取消，防后端那一轮继续烧");
  assert.equal(h.log.inFlight, 0, "闸位已交出");
  assert.ok(h.count("tasks/get") <= 8, "读取次数受窗口约束（不得无限轮询）");
});

test("③ 桥不再认识该任务（-32001）⇒ 判失败，不谎报成功", async () => {
  const gw = fakeGateway();
  const clock = fakeClock();
  let gets = 0;
  const manager = new HostTurnManager({
    gateway: gw,
    rpcFor: () => async (body) => {
      if (body.method === "message/send") {
        return { result: { id: "task-vanished", status: { state: "working" }, artifacts: [] } };
      }
      if (body.method === "tasks/get") {
        gets += 1;
        if (gets === 1) return { result: { id: "task-vanished", status: { state: "working" }, artifacts: [] } };
        return { jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "未知任务 task-vanished" } };
      }
      return { result: { id: "task-vanished", status: { state: "working" }, artifacts: [] } };
    },
    ledger: null,
    now: clock.now,
    delay: clock.delay,
    pollIntervalMs: 10,
  });
  const r = await settled(manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" }));
  assert.equal(r.state, "failed");
  assert.equal(r.error.code, "task_not_found");
  assert.equal(r.kind, "failed");
  assert.equal(gets, 2, "读到桥侧不再认识的任务即停，不再继续轮询到超时");
});

// ---------------------------------------------------------------------------
// ④ input-required
// ---------------------------------------------------------------------------

test("④ input-required 不被当失败：落 awaiting_answer + 问题原文 + 显示「需要你回答」", async () => {
  const h = harness({ scripts: [{ pollStates: ["input-required"], question: "本需求归哪个版本？" }] });
  const r = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "开始" }));
  assert.equal(r.state, "awaiting_answer");
  assert.equal(r.kind, "awaiting_answer");
  assert.equal(r.error, null, "**不得把它记成失败**");
  assert.equal(r.question, "本需求归哪个版本？");
  assert.match(r.display, new RegExp(AWAITING_ANSWER_DISPLAY));
  const rec = findTurn(h.ledger.load().ledger, r.turnId);
  assert.equal(rec.state, "awaiting_answer");
  assert.equal(rec.finishedAt, null, "待澄清不是终态：没有 finishedAt");
});

test("④ 待澄清后可续发同一 contextId 的一轮（answerTurn）", async () => {
  const h = harness({
    scripts: [
      { pollStates: ["input-required"], question: "确认版本？" },
      { pollStates: ["completed"], text: "已按 v0.9.0 落文件" },
    ],
  });
  const first = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "开始" }));
  const queued = h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "v0.9.0" });
  assert.equal(queued.queued, false, "上一轮已交闸 ⇒ 续发不必排队");
  const second = await queued.done;
  assert.equal(second.contextId, first.contextId);
  assert.equal(second.state, "succeeded");
  assert.equal(second.text, "已按 v0.9.0 落文件");
});

// ---------------------------------------------------------------------------
// ⑤ tasks/cancel
// ---------------------------------------------------------------------------

test("⑤ 在飞轮停止：发 tasks/cancel + 落 canceled + 交闸（台账同步）", async () => {
  const h = harness({ scripts: [{ pollStates: ["working"] }, { pollStates: ["completed"], text: "B" }] });
  const running = h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" });
  const waiting = h.manager.submitTurn({ org: "flow", requirementId: "REQ-B", text: "B" });
  // 等本轮真的拿到 taskId（已进入在飞）再取消
  assert.equal(await waitUntil(() => h.log.sends.length === 1 && h.count("tasks/get") >= 1), true);
  const cancel = await h.manager.cancelTurn(running.turnId);
  assert.equal(cancel.ok, true);
  assert.equal(cancel.state, "canceled");
  const r = await running.done;
  assert.equal(r.state, "canceled");
  assert.equal(r.kind, "canceled");
  assert.equal(h.count("tasks/cancel"), 1);
  assert.equal(findTurn(h.ledger.load().ledger, running.turnId).state, "canceled");
  const b = await waiting.done;
  assert.equal(b.state, "succeeded", "被取消的轮交出闸位，排队的轮照常跑");
});

test("⑤ 排队中的轮取消：出队且**不发 RPC**（桥侧还没有这条任务）", async () => {
  const h = harness({ scripts: [{ pollStates: ["working"] }, { pollStates: ["completed"], text: "B" }] });
  const running = h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" });
  const waiting = h.manager.submitTurn({ org: "flow", requirementId: "REQ-B", text: "B" });
  const cancel = await h.manager.cancelTurn(waiting.turnId);
  assert.equal(cancel.ok, true);
  assert.equal(cancel.state, "canceled");
  const r = await waiting.done;
  assert.equal(r.state, "canceled");
  assert.equal(r.taskId, null, "未开跑的轮没有任务 id");
  // 收口幂等：再取消一次不改写
  const again = await h.manager.cancelTurn(waiting.turnId);
  assert.equal(again.state, "canceled");
  assert.equal(await waitUntil(() => h.log.sends.length === 1), true);
  assert.equal(h.log.sends.length, 1, "只发出去了 A 的一轮");
  assert.equal(h.count("tasks/cancel"), 0);
  // A 仍在飞 ⇒ 取消 A：cancelTurn 只报本地裁决，收口由轮自身完成（`done` 解决时闸位一定已交出）
  assert.equal(await waitUntil(() => h.count("tasks/get") >= 1), true);
  const cancelA = await h.manager.cancelTurn(running.turnId);
  assert.equal(cancelA.state, "canceled");
  const ra = await running.done;
  assert.equal(ra.state, "canceled");
  assert.equal(h.gw.roundInFlight, 0, "`done` 解决在交闸之后（调用方看不到「已结束但闸仍占」）");
  assert.equal(h.manager.queueView("flow").running, null, "闸位已空");
});

test("⑤ 未知轮次 / 桥端口不可得时取消：如实结构化回报，不静默", async () => {
  const h = harness({ scripts: [{ pollStates: ["completed"], text: "x" }] });
  const bad = await h.manager.cancelTurn("turn-nope");
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "turn_not_found");
});

// ---------------------------------------------------------------------------
// ⑥ 结果回写台账 / 故障可见 / BD4a 接线
// ---------------------------------------------------------------------------

test("⑥ 结果回写板侧台账：终态 + 摘要 + contextId + taskId（含排队态可见）", async () => {
  const h = harness({
    scripts: [
      { pollStates: ["working", "completed"], text: "需求确认单已写入 doc/v0.9.0/x.md\n第二行细节" },
      { pollStates: ["completed"], text: "B" },
    ],
  });
  const a = h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "开始" });
  const b = h.manager.submitTurn({ org: "flow", requirementId: "REQ-B", text: "B" });
  assert.equal(findTurn(h.ledger.load().ledger, a.turnId).state, "queued");
  const ra = await a.done;
  const rb = await b.done;
  const { ledger } = h.ledger.load();
  const recA = findTurn(ledger, ra.turnId);
  assert.equal(recA.state, "succeeded");
  assert.equal(recA.taskId, "task-1");
  assert.equal(recA.contextId, ra.contextId);
  assert.equal(recA.summary, "需求确认单已写入 doc/v0.9.0/x.md 第二行细节", "摘要折叠换行");
  assert.ok(recA.finishedAt !== null);
  assert.ok(Date.parse(recA.updatedAt) >= Date.parse(recA.queuedAt));
  assert.equal(findTurn(ledger, rb.turnId).state, "succeeded");
  assert.equal(ledger.requirements.length, 2);
});

test("⑥ 桥不可用 ⇒ 结构化「宿主桥已断」可见，且不影响后续轮排队", async () => {
  const h = harness({
    scripts: [{ pollStates: ["completed"], text: "x" }],
    gateway: { ok: false, error: "bridge_start_timeout: 等待端口就绪超时" },
  });
  const r = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" }));
  assert.equal(r.state, "failed");
  assert.equal(r.error.code, "bridge_unavailable");
  assert.match(r.error.message, new RegExp(HOST_BRIDGE_DOWN_MESSAGE));
  assert.match(r.error.message, /bridge_start_timeout/);
  assert.equal(h.log.sends.length, 0, "桥没起来就不得发轮");
  assert.equal(h.gw.roundInFlight, 0, "未 beginRound ⇒ 也不 endRound");
});

test("⑥ 发轮抛错也严格配对 beginRound/endRound（在飞计数不得泄漏，否则桥永不回收）", async () => {
  const gw = fakeGateway();
  const clock = fakeClock();
  const manager = new HostTurnManager({
    gateway: gw,
    rpcFor: () => async (body) => {
      // 与 createHttpRpc 同一形态：传输层异常包成 HostTurnError（错误码结构化上账）
      if (body.method === "message/send") throw new HostTurnError("transport_error", "fetch failed: ECONNRESET");
      return { result: { id: "t", status: { state: "working" }, artifacts: [] } };
    },
    ledger: null,
    now: clock.now,
    delay: clock.delay,
    pollIntervalMs: 10,
  });
  const r = await settled(manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" }));
  assert.equal(r.state, "failed");
  assert.equal(r.error.code, "transport_error");
  assert.equal(gw.events.filter((e) => e.fn === "beginRound").length, 1);
  assert.equal(gw.events.filter((e) => e.fn === "endRound").length, 1);
  assert.equal(gw.roundInFlight, 0);
});

test("⑥ 桥重拉后的第 2 轮挂可见提示（§2.2-7「会话可能回退为新建」须让用户看见）", async () => {
  const h = harness({
    scripts: [
      { pollStates: ["completed"], text: "第一轮" },
      { pollStates: ["completed"], text: "第二轮" },
    ],
    gateway: { reusedOf: (org) => false },
  });
  const first = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" }));
  assert.equal(first.bridgeNote, null, "第 1 轮无需提示");
  const second = await settled(h.manager.answerTurn({ org: "flow", requirementId: "REQ-A", answer: "续" }));
  assert.equal(second.bridgeNote, BRIDGE_RESTART_NOTE);
  assert.equal(second.contextId, first.contextId, "提示只说明「可能回退」，会话仍按同 contextId 续");
  assert.equal(findTurn(h.ledger.load().ledger, second.turnId).bridgeNote, BRIDGE_RESTART_NOTE);
});

test("⑥ 台账写失败 ⇒ 降级可见（不改判结果，也不静默）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-turn-bad-"));
  const store = new HostTurnLedgerStore(dir); // 目录当文件 ⇒ 写必抛
  const h = harness({ scripts: [{ pollStates: ["completed"], text: "结果" }], ledger: store });
  const r = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" }));
  assert.equal(r.state, "succeeded", "台账坏不伪装成轮失败");
  assert.equal(r.error.code, "ledger_write_failed");
  assert.match(r.error.message, /对话轮台账写入失败/);
});

test("⑥ 复用 BD4a 出口：createHostBridgeGateway 只做 ensureStarted + begin/endRound", async () => {
  const calls = [];
  const bridges = {
    async ensureStarted(config) {
      calls.push({ fn: "ensureStarted", org: config.org });
      return { ok: true, reused: true, status: { port: 9333, error: null } };
    },
    beginRound: (org) => calls.push({ fn: "beginRound", org }),
    endRound: (org) => calls.push({ fn: "endRound", org }),
  };
  const gateway = createHostBridgeGateway(bridges, (org) => ({ org, workspace: `W:${org}` }));
  assert.deepEqual(await gateway.ensureBridge("flow"), { ok: true, port: 9333, reused: true, error: null });
  gateway.beginRound("flow");
  gateway.endRound("flow");
  assert.deepEqual(calls, [
    { fn: "ensureStarted", org: "flow" },
    { fn: "beginRound", org: "flow" },
    { fn: "endRound", org: "flow" },
  ]);
  const down = createHostBridgeGateway(
    {
      async ensureStarted() {
        return { ok: false, reused: false, status: { port: null, error: { code: "spawn_failed", message: "起不来" } } };
      },
      beginRound() {},
      endRound() {},
    },
    () => ({ org: "flow", workspace: "W" }),
  );
  const failed = await down.ensureBridge("flow");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /spawn_failed: 起不来/);
});

// ---------------------------------------------------------------------------
// 收口轨 14：同需求防重（连点第二发不建 job、不入队、不发 RPC）
// ---------------------------------------------------------------------------

test("轨14 同需求连点（同一 tick）⇒ 第二发带 occupant、桥只收到一轮、台账只多一条", async () => {
  const h = harness({ scripts: [{ pollStates: ["working", "completed"], text: "第一轮结果" }] });
  const first = h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" });
  const second = h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A-连点" });

  assert.equal(first.occupant, null, "第一发正常提交 ⇒ 无占用轮");
  assert.notEqual(second.occupant, null, "第二发必须被防重挡住");
  assert.equal(second.occupant.turnId, first.turnId, "载荷回显的是**占用中那一轮**的 id");
  assert.equal(second.occupant.requirementId, "REQ-A");
  assert.equal(second.occupant.round, first.round);
  assert.ok(["running", "queued"].includes(second.occupant.state), "kind 闭集 = 在飞 / 排队");
  assert.equal(second.queued, false, "被拒不产生排队位次");
  assert.match(second.display, /本轮未提交/);
  // 同一轮的第二发不改会话：不新建 job ⇒ 桥侧只收到一条 message/send
  await first.done;
  assert.equal(await waitUntil(() => h.count("message/send") === 1), true);
  assert.equal(h.count("message/send"), 1, "**不得重复入队**（多烧一轮 = 本轨要修的缺陷）");
  assert.equal(h.manager.activeTurns("flow").filter((t) => t.turnId === second.turnId).length, 0, "被拒的提交不落轮");
  const rec = h.ledger.load().ledger.turns.filter((t) => t.requirementId === "REQ-A");
  assert.equal(rec.length, 1, "台账只有一条 REQ-A 的轮");
  assert.equal(rec[0].turnId, first.turnId);
});

test("轨14 排队轮也算占用：同需求在闸后再次提交 ⇒ 同样被拒（kind = queued 或 running）", async () => {
  const h = harness({
    scripts: [
      { pollStates: ["working", "completed"], text: "A" },
      { pollStates: ["completed"], text: "B" },
    ],
  });
  const a = h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" });
  const b = h.manager.submitTurn({ org: "flow", requirementId: "REQ-B", text: "B" });
  assert.equal(b.queued, true, "跨需求仍照常排队（本轨不收窄跨需求语义）");
  assert.equal(b.occupant, null, "跨需求排队不是防重");
  const b2 = h.manager.submitTurn({ org: "flow", requirementId: "REQ-B", text: "B-连点" });
  assert.notEqual(b2.occupant, null, "排队中的轮同样占住该需求");
  assert.equal(b2.occupant.turnId, b.turnId);
  assert.equal(b2.occupant.state, "queued");
  await Promise.all([a.done, b.done]);
  assert.equal(h.count("message/send"), 2, "只有 A、B 两轮真发出去");
});

test("轨14（正向锚）awaiting_answer **不占**：待澄清后仍可续发同一 contextId 的一轮", async () => {
  const h = harness({
    scripts: [
      { pollStates: ["input-required"], question: "确认版本？" },
      { pollStates: ["completed"], text: "已按 v0.9.0 落文件" },
    ],
  });
  const first = h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "开始" });
  await first.done;
  assert.equal(h.manager.busyTurnOf("REQ-A"), null, "等人回答不占闸位 ⇒ 回答入口不得被防重锁死");
  const again = h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "v0.9.0" });
  assert.equal(again.occupant, null);
  assert.equal(again.contextId, first.contextId, "澄清续推仍是同 contextId（复用纪律不受防重影响）");
  const r = await again.done;
  assert.equal(r.state, "succeeded");
});

test("轨14 busyTurnOf：终态轮不占 · 需求间互不串味", async () => {
  const h = harness({ scripts: [{ pollStates: ["completed"], text: "A" }, { pollStates: ["working"] }] });
  const a = h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" });
  await a.done;
  assert.equal(h.manager.busyTurnOf("REQ-A"), null, "已收口的轮不占");
  const b = h.manager.submitTurn({ org: "flow", requirementId: "REQ-B", text: "B" });
  assert.equal(h.manager.busyTurnOf("REQ-A"), null, "别的需求在飞不冒充本需求的占用轮");
  const busyB = h.manager.busyTurnOf("REQ-B");
  assert.equal(busyB.turnId, b.turnId);
  await h.manager.cancelTurn(b.turnId);
  await b.done;
});

// ---------------------------------------------------------------------------
// 收口轨 16 ②：findAwaitingTurn = 「当前待澄清」判据（awaiting ∧ 未被更新轮取代）
// ---------------------------------------------------------------------------

test("轨16 findAwaitingTurn（正向）：无更新轮的 awaiting 轮 ⇒ 命中且带问题原文 · busyTurnOf 同刻为 null（不互相污染）", async () => {
  const h = harness({ scripts: [{ pollStates: ["input-required"], question: "本需求归哪个版本？" }] });
  const r = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "开始" }));
  assert.equal(r.state, "awaiting_answer");
  const awaiting = h.manager.findAwaitingTurn("REQ-A");
  assert.equal(awaiting?.turnId, r.turnId);
  assert.equal(awaiting?.question, "本需求归哪个版本？");
  assert.equal(h.manager.busyTurnOf("REQ-A"), null, "awaiting 不占闸的既有语义不因本轨改变");
});

test("轨16 findAwaitingTurn（负向）：awaiting 被回答续推消化（第 2 轮已收口）⇒ 不再命中", async () => {
  const h = harness({
    scripts: [{ pollStates: ["input-required"], question: "确认版本？" }, { pollStates: ["completed"], text: "完成" }],
  });
  const first = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "开始" }));
  assert.equal(h.manager.findAwaitingTurn("REQ-A")?.turnId, first.turnId, "续推前该轮就是当前待澄清");
  const second = await settled(h.manager.answerTurn({ org: "flow", requirementId: "REQ-A", answer: "以 v0.9.0 落" }));
  assert.equal(second.state, "succeeded");
  assert.equal(h.manager.findAwaitingTurn("REQ-A"), null, "第 2 轮已开跑并收口 ⇒ 第 1 轮的 awaiting 记录不再是当前");
});

test("轨16 findAwaitingTurn（真机复现画像 850b3aa9）：轮史被裁剩最老 awaiting 残留 + 会话记录已到第 10 轮 ⇒ latestTurnOf 仍取残留、findAwaitingTurn 不取", () => {
  const ledgerStore = tempLedger();
  ledgerStore.save({
    version: 1,
    requirements: [
      {
        requirementId: "REQ-A",
        org: "flow",
        contextId: "ctx-1",
        round: 10,
        firstTurnAt: "2026-09-25T00:00:00.000Z",
        updatedAt: "2026-09-25T09:00:00.000Z",
      },
    ],
    turns: [
      {
        turnId: "turn-1",
        requirementId: "REQ-A",
        org: "flow",
        contextId: "ctx-1",
        taskId: "t-1",
        state: "awaiting_answer",
        summary: null,
        question: "本需求归哪个版本？",
        error: null,
        bridgeNote: null,
        queuedAt: "2026-09-25T00:00:00.000Z",
        startedAt: "2026-09-25T00:00:01.000Z",
        finishedAt: null,
        updatedAt: "2026-09-25T00:05:00.000Z",
      },
    ],
  });
  const h = harness({ ledger: ledgerStore });
  assert.equal(h.manager.latestTurnOf("REQ-A")?.turnId, "turn-1", "账面序：裁剪后残留就是「最近一条」（旧判据的病根）");
  assert.equal(h.manager.findAwaitingTurn("REQ-A"), null, "会话记录 updatedAt 晚于残留轮 ⇒ 判为已被取代");
  assert.equal(h.manager.busyTurnOf("REQ-A"), null, "残留也不占闸（闸位判据与本轨判据互不污染）");
});

// ---------------------------------------------------------------------------
// 收口接线（v0.9.6 REQ-2026-09-30-02 · §2-2）：回执块解析落 pollUntilTerminal 终态分支
// ---------------------------------------------------------------------------

const RECEIPT_TAIL = [
  "【回执】",
  "要点:",
  "- 读了改造文档",
  "- 改了 host-turn.ts",
  "待用户: ① 是否重启板 ② 要不要补测试",
  "下一步: 等 N4 渲染",
].join("\n");

test("回执收口：succeeded 轮从 artifact 全文解析入账（TurnResult 透传 · 400 字摘要口径零改）", async () => {
  const h = harness({ scripts: [{ pollStates: ["completed"], text: `本轮把确认单落了文件。\n\n${RECEIPT_TAIL}` }] });
  const r = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" }));
  assert.deepEqual(r.receipt, {
    head: ["读了改造文档", "改了 host-turn.ts"],
    todo: ["是否重启板", "要不要补测试"],
    next: "等 N4 渲染",
  });
  const rec = findTurn(h.ledger.load().ledger, r.turnId);
  assert.deepEqual(rec.receipt, r.receipt, "台账与结果同源");
  assert.equal(
    rec.summary,
    "本轮把确认单落了文件。 【回执】 要点: - 读了改造文档 - 改了 host-turn.ts 待用户: ① 是否重启板 ② 要不要补测试 下一步: 等 N4 渲染",
    "摘要仍走 summarizeTurnText 前段取法（未超 400 ⇒ 折叠全文），不受回执解析影响、也不剥回执块",
  );
});

test("回执收口：待澄清轮从 question 原文解析（artifact 全文仅解析即弃的已裁口径不扩到 question 面）", async () => {
  const h = harness({ scripts: [{ pollStates: ["input-required"], question: `要不要按 v0.9.6 发布？\n\n${RECEIPT_TAIL.slice(RECEIPT_TAIL.indexOf("【回执】"))}` }] });
  const r = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" }));
  assert.equal(r.state, "awaiting_answer");
  assert.equal(r.question.startsWith("要不要按 v0.9.6 发布？"), true, "交人面的问题原文不被改写");
  assert.deepEqual(r.receipt?.head, ["读了改造文档", "改了 host-turn.ts"]);
});

test("回执收口：无回执块 / cancel / timeout 出口 ⇒ receipt=null 落账（旧记录兼容）", async () => {
  const h = harness({
    scripts: [
      { pollStates: ["completed"], text: "普通结果，无回执块" },
      { pollStates: ["working"] },
      { pollStates: ["working"] },
    ],
    turnTimeoutMs: 50,
    pollIntervalMs: 10,
  });
  const plain = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-A", text: "A" }));
  assert.equal(plain.receipt, null);
  assert.equal(findTurn(h.ledger.load().ledger, plain.turnId).receipt, null);
  const never = h.manager.submitTurn({ org: "flow", requirementId: "REQ-B", text: "永不结束的轮" });
  assert.equal(await waitUntil(() => h.count("tasks/get") >= 1), true);
  await h.manager.cancelTurn(never.turnId);
  const c = await never.done;
  assert.equal(c.state, "canceled");
  assert.equal(c.receipt, null);
  const t = await settled(h.manager.submitTurn({ org: "flow", requirementId: "REQ-C", text: "超时轮" }));
  assert.equal(t.state, "timeout");
  assert.equal(t.receipt, null);
});

// ---------------------------------------------------------------------------
// 硬约束面（源码扫描：不写引擎状态机 · 不走 Launcher · 不自行管进程）
// ---------------------------------------------------------------------------

const src = readFileSync(fileURLToPath(new URL("../src/host-turn.ts", import.meta.url)), "utf8");

test("⑥ 源码扫描：本节点不写引擎状态机、不碰 MCP 写面、不自行 spawn", () => {
  for (const forbidden of [
    "a2a_feature_approve",
    "a2a_feature_advance",
    "a2a_feature_cancel",
    "a2a_feature_create",
    "a2a_call",
    "tools/call",
    "child_process",
    "spawn(",
  ]) {
    assert.equal(src.includes(forbidden), false, `host-turn.ts 不得出现「${forbidden}」`);
  }
  // 引擎那侧仍由 agent 经 MCP 推进：板只写自己的台账
  assert.match(src, /HOST_BRIDGE_DOWN_MESSAGE/);
  assert.match(src, /A2A_JSONRPC_PATH = "\/a2a\/jsonrpc"/);
});
