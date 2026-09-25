/**
 * BD9 单测（离线）：人工确认入口 + 澄清回答入口。
 *
 * 口径（改造文档 §1.2「按钮 = 给 agent 的指令」）：
 * - confirm = 走 **BD8 同一条触发通道**（同一假托管器 + submitTurn）投一轮「请核对后执行放行」的消息，
 *   提示词含 approve 语义、**不含任何 MCP 工具全名**；
 * - answer = 仅当最新轮 `awaiting_answer` 才续推，且**复用同一 contextId**（用真实 HostTurnManager
 *   + 假桥 RPC 证明，不靠假 TurnOps 自证）；无该轮 ⇒ 结构化 409 一族错误，**一条消息都不投**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BoardHostFace,
  CONFIRM_PROMPT_TITLE,
  NO_AWAITING_TURN,
  ORG_NOT_RESOLVED,
  TURN_BUSY,
  TURN_PROMPT_TITLE,
  buildConfirmPrompt,
  dispositionHttpStatus,
} from "../dist/host-face.js";
import { HostTurnManager } from "../dist/host-turn.js";
import { HOST_BRIDGE_DOWN_MESSAGE } from "../dist/host-bridge.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

function seqFactory() {
  let n = 0;
  return () => `id-${String(++n)}`;
}

function fakeClock(start = NOW) {
  let t = start;
  return {
    now: () => t,
    delay: async (ms) => {
      t += ms;
      await new Promise((res) => setImmediate(res));
    },
  };
}

// ---------------------------------------------------------------------------
// 假托管器（BridgeOps）与假轮次口（TurnOps）—— 不起真桥、不打真 RPC
// ---------------------------------------------------------------------------

function fakeBridges(options = {}) {
  const calls = [];
  return {
    calls,
    async ensureStarted(config) {
      calls.push(config);
      if (options.fail === true) {
        return {
          ok: false,
          reused: false,
          status: { org: config.org, state: "failed", pid: null, port: null, kind: config.kind, display: "宿主桥已断", error: { code: "spawn_failed", message: "起不来" } },
        };
      }
      return {
        ok: true,
        reused: true,
        status: { org: config.org, state: "running", pid: 4242, port: 9101, kind: config.kind, display: "在线", error: null },
      };
    },
    async stop() {
      return null;
    },
    statuses: () => [],
    async health() {
      return null;
    },
  };
}

function turnResult(over = {}) {
  return {
    turnId: "turn-x",
    requirementId: "F1",
    org: "flow",
    contextId: "ctx-1",
    taskId: "task-1",
    state: "succeeded",
    kind: "succeeded",
    text: "结果",
    summary: "结果",
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

function fakeTurns(options = {}) {
  const calls = { submitTurn: [], answerTurn: [], latestTurnOf: [], findAwaitingTurn: [], busyTurnOf: [] };
  const latestOf = (requirementId) =>
    typeof options.latest === "function" ? options.latest(requirementId) : (options.latest ?? null);
  // 假面的"当前待澄清"判据与真实现同语义：awaiting_answer ∧ options.awaitingSuperseded !== true
  const awaitingOf = (requirementId) => {
    const l = latestOf(requirementId);
    if (l === null || l.state !== "awaiting_answer") return null;
    return options.awaitingSuperseded === true ? null : l;
  };
  const submitted = (text) => ({
    turnId: "turn-1",
    requirementId: "F1",
    contextId: "ctx-1",
    round: 1,
    queued: false,
    position: 1,
    display: "进行中",
    occupant: null,
    done: Promise.resolve(turnResult(options.result ?? {})),
  });
  return {
    calls,
    submitTurn(input) {
      calls.submitTurn.push(input);
      return submitted(input.text);
    },
    answerTurn(input) {
      calls.answerTurn.push(input);
      return submitted(input.answer);
    },
    latestTurnOf(requirementId) {
      calls.latestTurnOf.push(requirementId);
      return latestOf(requirementId);
    },
    findAwaitingTurn(requirementId) {
      calls.findAwaitingTurn.push(requirementId);
      return awaitingOf(requirementId);
    },
    busyTurnOf(requirementId) {
      calls.busyTurnOf.push(requirementId);
      return options.busy ?? null;
    },
    queueView(org) {
      return { org, running: null, waiting: [], capacity: 1 };
    },
    activeTurns() {
      return [];
    },
  };
}

function face({ bridges = fakeBridges(), turns, orgsDir = "C:/tmp/orgs", defaultOrg = "flow", dirKind = () => "dir" } = {}) {
  return {
    face: new BoardHostFace({ bridges, turns, orgsDir, defaultOrg, dirKind }),
    bridges,
    turns,
  };
}

function awaitingRecord(over = {}) {
  return {
    turnId: "turn-old",
    requirementId: "F1",
    org: "flow",
    contextId: "ctx-reuse-me",
    taskId: "task-old",
    state: "awaiting_answer",
    summary: null,
    question: "用哪个版本？",
    error: null,
    bridgeNote: null,
    queuedAt: "q",
    startedAt: "s",
    finishedAt: null,
    updatedAt: "u",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// ① confirm 发的轮消息含 "approve" 语义，且走既有触发通道（复用断言）
// ---------------------------------------------------------------------------

test("BD9-① confirmTurn：走 BD8 同一条触发通道（ensureStarted + submitTurn 各一次），轮消息含 approve 语义", async () => {
  const { face: h, bridges, turns } = face({ turns: fakeTurns() });
  const outcome = await h.confirmTurn({ featureId: "F1", org: "flow", version: "v0.9.0" });

  // 复用断言：起桥与发轮都是 BD8 触发一轮的那两个口，且各只一次
  assert.equal(bridges.calls.length, 1, "确认指令必须复用 BD8 的起桥口（ensureStarted）");
  assert.equal(turns.calls.submitTurn.length, 1, "确认 = 投一轮消息（submitTurn），不是第二次链");
  assert.equal(turns.calls.answerTurn.length, 0);
  const sent = turns.calls.submitTurn[0];
  assert.equal(sent.org, "flow");
  assert.equal(sent.requirementId, "F1");
  assert.match(sent.text, /approve/, "轮消息须含 approve 语义（让 agent 执行放行）");
  assert.ok(sent.text.startsWith(CONFIRM_PROMPT_TITLE), "确认指令有专属标题行，与首轮触发可区分");
  // §3.6 直接约束 3：提示词不硬编码工具全名
  for (const forbidden of ["a2a_feature_approve", "a2a_feature_advance", "a2a_feature_cancel"]) {
    assert.equal(sent.text.includes(forbidden), false, `轮消息不得出现工具全名 ${forbidden}`);
  }
  // 诚实口径：明示「不是板上批准」「条件不满足就不要放行」
  assert.match(sent.text, /不是板上批准/);
  assert.match(sent.text, /不要放行|不得为迎合按钮硬推/);
  assert.equal(outcome.disposition, "succeeded");
});

test("BD9-①b buildConfirmPrompt：首轮触发提示词（缺省通道）不受影响；确认词含版本行", () => {
  const p = buildConfirmPrompt({ featureId: "F1", org: "flow", version: "v0.9.0" });
  assert.match(p, /版本 v0\.9\.0/);
  const plain = new BoardHostFace({
    bridges: fakeBridges(),
    turns: fakeTurns(),
    orgsDir: "C:/tmp/orgs",
    defaultOrg: "flow",
    dirKind: () => "dir",
  });
  return plain.triggerTurn({ featureId: "F1", org: "flow" }).then((o) => {
    assert.equal(o.disposition, "succeeded");
  });
});

// ---------------------------------------------------------------------------
// ③ answer 在无 awaiting_answer 轮时 ⇒ 结构化错误（负向）
// ---------------------------------------------------------------------------

test("BD9-③（负向）answer：无轮记录 ⇒ 结构化 not_awaiting（409），不起桥、一条消息都不投", async () => {
  const { face: h, bridges, turns } = face({ turns: fakeTurns({ latest: null }) });
  const outcome = await h.answerRequirement({ featureId: "F1", answer: "用 v0.9.0" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.disposition, "not_awaiting");
  assert.equal(dispositionHttpStatus(outcome.disposition), 409);
  assert.equal(outcome.error.code, NO_AWAITING_TURN);
  assert.match(outcome.error.message, /无记录/);
  assert.equal(bridges.calls.length, 0, "判据不满足时不得惊动托管器");
  assert.equal(turns.calls.submitTurn.length, 0);
  assert.equal(turns.calls.answerTurn.length, 0);
});

test("BD9-③b（负向）answer：最新轮是 succeeded（澄清已被上一轮消化）⇒ 同样结构化拒绝", async () => {
  const latest = awaitingRecord({ state: "succeeded" });
  const { face: h, turns } = face({ turns: fakeTurns({ latest }) });
  const outcome = await h.answerRequirement({ featureId: "F1", answer: "晚了" });
  assert.equal(outcome.disposition, "not_awaiting");
  assert.match(outcome.error.message, /succeeded/);
  assert.equal(turns.calls.answerTurn.length, 0);
});

test("BD9-③c（负向）answer：空答案 ⇒ TURN_REQUEST_INVALID，不查轮不投消息", async () => {
  const { face: h, turns } = face({ turns: fakeTurns({ latest: awaitingRecord() }) });
  const outcome = await h.answerRequirement({ featureId: "F1", answer: "   " });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error.code, /request_invalid/);
  assert.equal(turns.calls.latestTurnOf.length, 0);
  assert.equal(turns.calls.answerTurn.length, 0);
});

// ---------------------------------------------------------------------------
// ④ answer 在有该轮时 ⇒ 经 answerTurn 续推（假托管器层）
// ---------------------------------------------------------------------------

test("BD9-④a answer（口面层）：有 awaiting_answer 轮 ⇒ 经 answerTurn 续推，组织取该轮记录的 org", async () => {
  const { face: h, turns } = face({
    turns: fakeTurns({ latest: awaitingRecord({ org: "flow" }) }),
  });
  const outcome = await h.answerRequirement({ featureId: "F1", answer: "用 v0.9.0" });
  assert.equal(outcome.ok, true);
  assert.equal(turns.calls.answerTurn.length, 1, "必须走 BD4b 的 answerTurn 口，不自造发轮");
  assert.equal(turns.calls.submitTurn.length, 0);
  assert.deepEqual(
    { org: turns.calls.answerTurn[0].org, requirementId: turns.calls.answerTurn[0].requirementId, answer: turns.calls.answerTurn[0].answer },
    { org: "flow", requirementId: "F1", answer: "用 v0.9.0" },
  );
});

test("BD9-④b awaitingTurnOf：awaiting_answer ⇒ 给出记录（回答框判据）；其余态 ⇒ null", () => {
  const hit = face({ turns: fakeTurns({ latest: awaitingRecord() }) });
  assert.equal(hit.face.awaitingTurnOf("F1")?.state, "awaiting_answer");
  const miss = face({ turns: fakeTurns({ latest: awaitingRecord({ state: "failed" }) }) });
  assert.equal(miss.face.awaitingTurnOf("F1"), null);
  assert.equal(face({ turns: fakeTurns({ latest: null }) }).face.awaitingTurnOf("F1"), null);
});

// ---------------------------------------------------------------------------
// ④（真机语义）：真实 HostTurnManager + 假桥 RPC ⇒ 续推复用**同一 contextId**
// ---------------------------------------------------------------------------

/** 按派发次序出剧本的两轮假桥：第 1 轮 input-required，第 2 轮 completed；记录每次 send 的 contextId/text。 */
function scriptedBridge(scripts) {
  const sends = [];
  let sendIndex = 0;
  let polls = 0;
  let taskN = 0;
  const rpc = async (body) => {
    const { method, params, id } = body;
    if (method === "message/send") {
      sends.push({ contextId: params.message.contextId, text: params.message.parts[0].text });
      sendIndex += 1;
      polls = 0;
      taskN += 1;
      return { jsonrpc: "2.0", id, result: { id: `task-${String(taskN)}`, status: { state: "working" } } };
    }
    if (method === "tasks/get") {
      const plan = scripts[Math.min(sendIndex - 1, scripts.length - 1)];
      polls += 1;
      const state = plan[Math.min(polls - 1, plan.length - 1)];
      const task = { id: `task-${String(taskN)}`, status: { state } };
      if (state === "completed") {
        task.artifacts = [{ name: "response", parts: [{ kind: "text", text: "放行完成" }] }];
      } else if (state === "input-required") {
        task.status.message = { role: "agent", parts: [{ kind: "text", text: "改造文档以哪个版本落？" }] };
      }
      return { jsonrpc: "2.0", id, result: task };
    }
    if (method === "tasks/cancel") {
      return { jsonrpc: "2.0", id, result: { id: `task-${String(taskN)}`, status: { state: "canceled" } } };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "未知方法" } };
  };
  return { rpc, sends };
}

function managerFace(bridge) {
  const clock = fakeClock();
  const manager = new HostTurnManager({
    gateway: {
      async ensureBridge(org) {
        return { ok: true, port: 9101, reused: true, error: null };
      },
      beginRound() {},
      endRound() {},
    },
    rpcFor: () => bridge.rpc,
    ledger: null, // 纯内存会话（contextId 分配纪律不变）
    now: clock.now,
    delay: clock.delay,
    idFactory: seqFactory(),
    pollIntervalMs: 10,
    turnTimeoutMs: 5_000,
  });
  const dir = mkdtempSync(join(tmpdir(), "board-bd9-"));
  const h = new BoardHostFace({
    bridges: {
      async ensureStarted(config) {
        return { ok: true, reused: true, status: { org: config.org, state: "running", pid: 1, port: 9101, kind: config.kind, display: "在线", error: null } };
      },
      async stop() {
        return null;
      },
      statuses: () => [],
      async health() {
        return null;
      },
    },
    turns: manager,
    orgsDir: dir,
    defaultOrg: "flow",
  });
  return { h, manager };
}

test("BD9-④ 续推同一 contextId（真 HostTurnManager + 假桥）：触发轮 input-required ⇒ 回答以同 contextId 落回同会话", async () => {
  const bridge = scriptedBridge([["input-required"], ["completed"]]);
  const { h } = managerFace(bridge);

  const first = await h.triggerTurn({ featureId: "F1", org: "flow", version: "v0.9.0" });
  assert.equal(first.disposition, "awaiting_answer", "首轮以桥的 input-required 收口 = 待澄清（不是失败）");
  assert.ok(first.contextId !== null && first.contextId !== "");
  assert.match(first.question ?? "", /哪个版本/);
  assert.equal(bridge.sends.length, 1);
  assert.ok(bridge.sends[0].text.startsWith(TURN_PROMPT_TITLE));

  const awaiting = h.awaitingTurnOf("F1");
  assert.equal(awaiting?.state, "awaiting_answer");
  assert.equal(awaiting.contextId, first.contextId, "回答入口判据与触发轮同源");

  const answered = await h.answerRequirement({ featureId: "F1", answer: "以 v0.9.0 落" });
  assert.equal(answered.disposition, "succeeded");
  assert.equal(bridge.sends.length, 2);
  assert.equal(bridge.sends[1].contextId, bridge.sends[0].contextId, "⭐ 澄清回答必须续推同一 contextId");
  assert.equal(bridge.sends[1].text, "以 v0.9.0 落", "回答原文即本轮消息");
  assert.equal(h.awaitingTurnOf("F1"), null, "回答被消化后，回答框判据回到 null");
});

// ---------------------------------------------------------------------------
// BD10-②b（负向）：组织名缺失（defaultOrg = null）⇒ 宿主面结构化 503，**不猜组织**
// ---------------------------------------------------------------------------

test("BD10-②b（负向）：桥侧 ownerGroup 为空 ∧ 板级组织名未配置 ⇒ board_org_not_resolved（503），不起桥不发轮", async () => {
  const { face: h, bridges, turns } = face({ turns: fakeTurns(), defaultOrg: null });
  const outcome = await h.triggerTurn({ featureId: "F1", org: null });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.disposition, "config_error");
  assert.equal(dispositionHttpStatus(outcome.disposition), 503, "HTTP 层据此回结构化 503");
  assert.equal(outcome.error.code, ORG_NOT_RESOLVED);
  assert.match(outcome.error.message, /板级组织名未配置/);
  assert.equal(bridges.calls.length, 0, "组织未定 ⇒ 一条命令都不 spawn");
  assert.equal(turns.calls.submitTurn.length, 0);
});

test("BD10-②c：defaultOrg = null 但桥侧给了 ownerGroup ⇒ 照常触发（组织缺失只挡「无org」那一路）", async () => {
  const { face: h, turns } = face({ turns: fakeTurns(), defaultOrg: null });
  const outcome = await h.triggerTurn({ featureId: "F1", org: "flow" });
  assert.equal(outcome.disposition, "succeeded");
  assert.equal(turns.calls.submitTurn.length, 1);
});

test("BD10-②d configView：组织名未配置如实报 null（状态页显示「未配置」，不伪装成兜底组名）", () => {
  const { face: h } = face({ turns: fakeTurns(), defaultOrg: null });
  assert.deepEqual(h.configView(), { orgsDir: "C:/tmp/orgs", defaultOrg: null, kind: "claude" });
});

test("BD9-④c 续推时桥已断 ⇒ 如实 bridge_down（宿主桥已断一族），不吞不假成功", async () => {
  let submitCalled = 0;
  const h = new BoardHostFace({
    bridges: {
      async ensureStarted(config) {
        return { ok: false, reused: false, status: { org: config.org, state: "failed", pid: null, port: null, kind: config.kind, display: HOST_BRIDGE_DOWN_MESSAGE, error: { code: "spawn_failed", message: "起不来" } } };
      },
      async stop() {
        return null;
      },
      statuses: () => [],
      async health() {
        return null;
      },
    },
    turns: {
      ...fakeTurns({ latest: awaitingRecord() }),
      submitTurn() {
        submitCalled += 1;
        throw new Error("桥断时不应走到发轮");
      },
    },
    orgsDir: mkdtempSync(join(tmpdir(), "board-bd9-")),
    defaultOrg: "flow",
  });
  const outcome = await h.answerRequirement({ featureId: "F1", answer: "甲" });
  assert.equal(outcome.disposition, "bridge_down");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "spawn_failed");
  assert.equal(submitCalled, 0);
});

// ---------------------------------------------------------------------------
// 收口轨 14 ③：服务端防重（同需求已有在飞 / 排队轮 ⇒ 409 `board_turn_busy`，不重复入队）
// ---------------------------------------------------------------------------

const BUSY_RUNNING = {
  turnId: "turn-run",
  requirementId: "F1",
  org: "flow",
  contextId: "ctx-1",
  round: 3,
  state: "running",
  queuedAt: "q",
  startedAt: "s",
};
const BUSY_QUEUED = { ...BUSY_RUNNING, turnId: "turn-queue", state: "queued", startedAt: null };

test("轨14（负向）在飞轮占用 ⇒ triggerTurn 结构化 409 board_turn_busy：不起桥、不发轮", async () => {
  const { face: h, bridges, turns } = face({ turns: fakeTurns({ busy: BUSY_RUNNING }) });
  const outcome = await h.triggerTurn({ featureId: "F1", org: "flow", version: "v0.9.0" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.disposition, "busy");
  assert.equal(dispositionHttpStatus(outcome.disposition), 409);
  assert.equal(outcome.error.code, TURN_BUSY);
  // 载荷含占用轮的 id 与 kind（用户据此看清"被谁占住"）
  assert.equal(outcome.turnId, "turn-run");
  assert.equal(outcome.state, "running");
  assert.equal(outcome.round, 3);
  assert.match(outcome.error.message, /turn-run/);
  assert.match(outcome.error.message, /在飞/);
  assert.match(outcome.display, /触发未提交/);
  assert.equal(bridges.calls.length, 0, "判据不满足不得惊动托管器（连点不起桥）");
  assert.equal(turns.calls.submitTurn.length, 0, "**不重复入队**");
});

test("轨14（负向）排队轮同样占：confirm 走同一通道 ⇒ 同一 409 形状", async () => {
  const { face: h, bridges, turns } = face({ turns: fakeTurns({ busy: BUSY_QUEUED }) });
  const outcome = await h.confirmTurn({ featureId: "F1", org: "flow", version: "v0.9.0" });
  assert.equal(outcome.disposition, "busy");
  assert.equal(outcome.error.code, TURN_BUSY);
  assert.equal(outcome.state, "queued");
  assert.match(outcome.error.message, /排队的/);
  assert.match(outcome.display, /^确认未提交/, "确认入口的占用文案说「确认」，不套「触发」的字");
  assert.equal(bridges.calls.length, 0);
  assert.equal(turns.calls.submitTurn.length, 0);
});

test("轨14（负向）answer 也被占：有 awaiting_answer 轮但新轮已在飞 ⇒ 409 busy（不投回答）", async () => {
  const { face: h, turns } = face({ turns: fakeTurns({ latest: awaitingRecord(), busy: BUSY_RUNNING }) });
  const outcome = await h.answerRequirement({ featureId: "F1", answer: "用 v0.9.0" });
  assert.equal(outcome.disposition, "busy");
  assert.equal(dispositionHttpStatus(outcome.disposition), 409);
  assert.equal(outcome.error.code, TURN_BUSY);
  assert.equal(outcome.org, "flow", "回答口的 org 取该轮记录（不重猜）");
  assert.equal(turns.calls.answerTurn.length, 0);
});

test("轨14（正向锚）无占用轮 ⇒ 三入口照常提交（防重不得误挡正常路径）", async () => {
  const { face: h, turns } = face({ turns: fakeTurns({ latest: awaitingRecord(), busy: null }) });
  assert.equal((await h.triggerTurn({ featureId: "F1", org: "flow" })).disposition, "succeeded");
  assert.equal((await h.confirmTurn({ featureId: "F1", org: "flow" })).disposition, "succeeded");
  assert.equal((await h.answerRequirement({ featureId: "F1", answer: "甲" })).disposition, "succeeded");
  assert.equal(turns.calls.submitTurn.length, 2);
  assert.equal(turns.calls.answerTurn.length, 1);
});

test("轨14 连点竞态兜底：前置判据放行后 submitTurn 仍带回 occupant ⇒ 同样收口成 409", async () => {
  const turns = fakeTurns();
  // 前置查为 null（两发都通过前置），发轮时才被同步段挡下
  turns.submitTurn = () => ({
    turnId: "turn-reject",
    requirementId: "F1",
    contextId: "ctx-1",
    round: 3,
    queued: false,
    position: 0,
    display: "本轮未提交",
    occupant: BUSY_RUNNING,
    done: Promise.resolve(turnResult({})),
  });
  const { face: h } = face({ turns });
  const outcome = await h.triggerTurn({ featureId: "F1", org: "flow" });
  assert.equal(outcome.disposition, "busy");
  assert.equal(outcome.error.code, TURN_BUSY);
  assert.equal(outcome.turnId, "turn-run", "回显的是占用轮 id，不是被拒提交自己的 id");
});

test("轨14 busyTurnOf 转发口：详情页判据与防重同源（不自造第二套事实）", () => {
  const { face: h, turns } = face({ turns: fakeTurns({ busy: BUSY_QUEUED }) });
  assert.deepEqual(h.busyTurnOf("F1"), BUSY_QUEUED);
  assert.equal(turns.calls.busyTurnOf.length, 1);
});

// ---------------------------------------------------------------------------
// 收口轨 16 ②：陈旧的 awaiting 残留（已被更新轮取代）不再算「当前待澄清」
// ---------------------------------------------------------------------------

test("轨16（负向）answer：最近记录是 awaiting_answer 但已被更新轮取代 ⇒ not_awaiting，文案点破「陈旧残留」，不投回答", async () => {
  const { face: h, bridges, turns } = face({
    turns: fakeTurns({ latest: awaitingRecord(), awaitingSuperseded: true }),
  });
  const outcome = await h.answerRequirement({ featureId: "F1", answer: "用 v0.9.0" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.disposition, "not_awaiting");
  assert.equal(outcome.error.code, NO_AWAITING_TURN);
  assert.match(outcome.error.message, /已被更新轮取代/);
  assert.match(outcome.error.message, /陈旧残留/);
  assert.match(outcome.error.message, /turn-old/, "回显残留轮 id，便于对账");
  assert.equal(turns.calls.answerTurn.length, 0, "残留脏账不得续推");
  assert.equal(bridges.calls.length, 0, "判据不满足不得惊动托管器");
});

test("轨16 awaitingTurnOf 走取代判据：只认 findAwaitingTurn（残留 ⇒ null ⇒ 详情页不渲染回答框）", () => {
  const stale = face({ turns: fakeTurns({ latest: awaitingRecord(), awaitingSuperseded: true }) });
  assert.equal(stale.face.awaitingTurnOf("F1"), null);
  assert.deepEqual(stale.turns.calls.findAwaitingTurn, ["F1"], "判据源 = findAwaitingTurn，不再拿 latestTurnOf 凑");
  const fresh = face({ turns: fakeTurns({ latest: awaitingRecord() }) });
  assert.equal(fresh.face.awaitingTurnOf("F1")?.turnId, "turn-old");
});
