/**
 * v0.9.5 推进流程精简 · 增补二 T3（Feature `fbaa15aa`，单节点 D2）用例（离线）。
 *
 * 事实源：`doc/v0.9.5/推进流程精简-改造文档.md` §增补（T3 条）。
 * 三件：① **停链标志来源可分**（`user` / `auto`）+ 人工动作（补充 / 确认 / 回答）**只清 auto**；
 * ② 详情页**链状态一行**（监视中·N / 链已停·来源），读面只读、快照缺席不渲染不报错；
 * ③ 留痕四行（置位 / 清除 / 解冻 / 快照取值失败）。
 *
 * **不弱化既有锚**：T1（`heartbeat.evaluateWake` 判据分流）、T2（唤醒撞车分诊 +
 * `WAKE_OCCUPANT_WAIT_LIMIT_MS`）、停链口（t3）、链内计数与去重（t2）、白名单十一条在本文件里
 * 只作正向复核；本节点未改这些逻辑与锚。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostRelay } from "../dist/host-relay.js";
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "../dist/heartbeat.js";
import { createHostFace } from "../dist/host-face.js";
import { deriveChainStateLine } from "../dist/derive.js";
import { renderChainStateLine } from "../dist/web/views.js";
import { composeChainSnapshot, buildHostFace } from "../dist/index.js";
import { SuspendLedgerStore } from "../dist/suspend-ledger.js";
import { WRITE_ROUTES } from "../dist/write-guard.js";
import { createBoardServer } from "../dist/server.js";

// ---------------------------------------------------------------------------
// 替身（照 t2 / t3 口径：只造该测例用到的最小面）
// ---------------------------------------------------------------------------

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

const OCC = (turnId) => ({ turnId, round: 2, state: "running", contextId: "ctx-1", requirementId: "F1" });

function snap(state, over = {}) {
  return { state, stage: "改造", approval: "已通过", ...over };
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

/** 收口日志收集器（留痕断言用）。 */
function logBox() {
  const lines = [];
  return { lines, log: (l) => lines.push(l), has: (sub) => lines.some((l) => l.includes(sub)) };
}

function fakeTurns(over = {}) {
  const calls = { submit: 0, cancel: [] };
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
    async cancelTurn(turnId) {
      calls.cancel.push(turnId);
      return { ok: true, turnId, state: "canceled", error: null, display: "已取消（未开跑，已从队列移除）" };
    },
    queueView(org) {
      return { org, running: null, waiting: [], capacity: 1 };
    },
    activeTurns() {
      return [];
    },
    setTurnSettledHandler() {},
    ...over,
  };
  return { turns, calls };
}

function faceDeps(turns, over = {}) {
  return {
    bridges: {
      async ensureStarted() {
        return {
          ok: true,
          status: { state: "running", pid: 1, port: 9101, kind: "claude", display: "ok", error: null },
          reused: true,
        };
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
    defaultOrg: "g",
    dirKind: () => "dir",
    ...over,
  };
}

// ===========================================================================
// 件1 —— 停链标志来源可分 + 人工动作只清 auto
// ===========================================================================

test("D2-① requestStop 缺省来源 = auto；stopView 给出 {reason, source}（只读拷贝）", () => {
  const relay = createHostRelay({ submitTurn: () => fakeSubmitted() });
  relay.requestStop("F1", "退让超上限");
  assert.equal(relay.isChainStopped("F1"), true);
  assert.deepEqual(relay.stopView("F1"), { reason: "退让超上限", source: "auto" });
  const view = relay.stopView("F1");
  view.source = "user";
  assert.equal(relay.stopView("F1").source, "auto", "stopView 返回拷贝 ⇒ 读面改不动内存标志");
  assert.equal(relay.stopView("OTHER"), null, "未置标志 ⇒ null（不臆造）");
});

test("D2-② 停链口（route）置的来源 = user：face.stopChain 与 requestStopChain 两条写面同来源", async () => {
  const { turns } = fakeTurns();
  const face = createHostFace(faceDeps(turns));
  const relay = face.startRelay();
  assert.notEqual(relay, null);

  await face.stopChain("F1");
  const stop = relay.stopView("F1");
  assert.equal(stop.source, "user", "HTTP 停链口 = 用户显式停链");
  assert.equal(
    stop.reason,
    "用户经链状态行「停链」· 该需求无在飞 / 排队轮",
    "停链原因人话化（04 §2.5）：无占用轮档如实交代，供链状态行直接显示",
  );
  assert.equal(stop.reason.includes("route"), false, "机器词不上面");

  face.clearStopChain("F1");
  face.requestStopChain("F2");
  assert.equal(relay.stopView("F2").source, "user", "写面口一律 user 来源");
});

test("D2-②b 停链原因含被取消轮次（04 §2.5 三档：有占用轮 + 取消可用 ⇒ 原因带第 N 轮与 turnId）", async () => {
  const { turns } = fakeTurns({
    busyTurnOf: (id) => ({
      turnId: "turn-busy",
      requirementId: id,
      org: "g",
      contextId: "ctx-1",
      round: 3,
      state: "queued",
      queuedAt: "q",
      startedAt: null,
    }),
  });
  const face = createHostFace(faceDeps(turns));
  const relay = face.startRelay();
  await face.stopChain("F1");
  assert.equal(
    relay.stopView("F1").reason,
    "用户经链状态行「停链」· 同时取消第 3 轮（turn-busy）",
    "原因带「第 N 轮 + turnId」（原独立结果页的信息量迁到链状态行）",
  );
});

test("D2-③ 负例：`user` 停链**不被人工动作清除**（三种人工动作都不解），且点火仍被拒", () => {
  const box = logBox();
  const relay = createHostRelay({ submitTurn: () => fakeSubmitted(), log: box.log });
  relay.requestStop("F1", "route", "user");
  relay.fire(turnResult(), snap("executing")); // 预置一发计数（清零判据用）

  for (const kind of ["supplement", "confirm", "answer"]) {
    relay.noteManualAction("F1", kind);
    assert.equal(relay.isChainStopped("F1"), true, `人工动作（${kind}）不得清除 user 停链`);
    assert.equal(relay.chainCount("F1"), 0, "链内计数照常清零（本条只说标志不清）");
  }
  assert.equal(relay.fire(turnResult(), snap("executing")).reason, "stopped", "user 停链后一点即停、不再复活");
  assert.equal(box.has("不清"), true, "留痕写明「不清」");
});

test("D2-④ 正例：`auto` 停链可被人工动作清除，且解冻后可再点火（计入链内计数）", () => {
  const box = logBox();
  const relay = createHostRelay({ submitTurn: () => fakeSubmitted(), log: box.log });
  relay.requestStop("F1", "点火撞 occupant（turn-b）", "auto");
  assert.equal(relay.fire(turnResult(), snap("executing")).reason, "stopped");

  relay.noteManualAction("F1", "answer");
  assert.equal(relay.isChainStopped("F1"), false, "auto 停链被人工动作解冻");
  assert.equal(box.has("解冻自动停链"), true, "解冻留痕一行（含原原因）");
  assert.equal(box.lines.filter((l) => l.includes("解冻自动停链")).length, 1, "解冻留痕恰好一行");

  const fired = relay.fire(turnResult(), snap("executing"));
  assert.equal(fired.ok, true, "解冻后链条可再点火");
  assert.equal(relay.chainCount("F1"), 1, "再点火计入链内连续点火计数（上限执法不变）");
});

test("D2-⑤ 接力路径「一撞即停」的来源 = auto（T2 锚不弱化：撞 occupant ⇒ 置标志 + reason=occupant）", () => {
  const relay = createHostRelay({ submitTurn: () => fakeSubmitted({ occupant: OCC("turn-busy") }) });
  const r = relay.fire({ requirementId: "F1", org: "o", state: "succeeded" }, snap("executing"));
  assert.equal(r.reason, "occupant", "接力路径原因码不变（t10 C-④）");
  assert.equal(relay.isChainStopped("F1"), true, "一撞即停不变");
  assert.equal(relay.stopView("F1").source, "auto", "自动置位 ⇒ 来源 auto");
  relay.noteManualAction("F1", "supplement");
  assert.equal(relay.isChainStopped("F1"), false, "故人工动作可解冻");
});

test("D2-⑥ 唤醒退让超上限的停链来源 = auto（分诊逻辑与 WAKE_OCCUPANT_WAIT_LIMIT_MS 未动）", () => {
  let now = 0;
  const relay = createHostRelay({
    submitTurn: () => fakeSubmitted({ occupant: OCC("turn-busy") }),
    now: () => now,
    wakeOccupantWaitMs: 100,
  });
  assert.equal(relay.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" }).reason, "occupant_yield");
  now += 100;
  const out = relay.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" });
  assert.equal(out.reason, "occupant_wait_exceeded", "超限才停链（T2 口径原样）");
  assert.equal(relay.isChainStopped("F1"), true);
  assert.equal(relay.stopView("F1").source, "auto");
});

test("D2-⑦ 显式解停链（新起接力）仍可解 `user` 标志 —— 既有语义不动", () => {
  const relay = createHostRelay({ submitTurn: () => fakeSubmitted() });
  relay.requestStop("F1", "route", "user");
  relay.clearStop("F1", "route");
  assert.equal(relay.isChainStopped("F1"), false, "clearStop 是显式解链动作，两种来源都解");
  assert.equal(relay.stopView("F1"), null);
});

test("D2-⑧ 留痕：置位行带来源 · 清除行带原来源 · 未置时如实标「原本未置」", () => {
  const box = logBox();
  const relay = createHostRelay({ submitTurn: () => fakeSubmitted(), log: box.log });
  relay.requestStop("F1", "route", "user");
  assert.equal(box.has("停链标志已置（来源 user · route）"), true);
  relay.clearStop("F1", "route");
  assert.equal(box.has("停链标志已解（route · 原来源 user · 原原因 route）"), true);
  relay.clearStop("F9", "route");
  assert.equal(box.has("原本未置"), true);
});

test("D2-⑨ user 停链后判定序① 照旧短路（不查探针、不点火）+ 写路由白名单仍十一条", async () => {
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
  relay.requestStop("F1", "route", "user");
  relay.noteManualAction("F1", "confirm");
  relay.handleTurnSettled(turnResult());
  await new Promise((res) => setImmediate(res));
  assert.equal(calls.probe, 0, "判定序① 命中 ⇒ 不进 C3 探针（t3-⑥ 口径不弱化）");
  assert.equal(calls.submit, 0);
  assert.equal(WRITE_ROUTES.length, 11, "白名单仍十一条（本节点零写面新增）");
});

// ===========================================================================
// 件2 —— 读面链状态一行（derive + render 三态 / 缺席不渲染）
// ===========================================================================

test("D2-⑩ 读面三态之一：监视中 · 等 N 个子任务", () => {
  const line = deriveChainStateLine({ chainState: "monitoring", reason: null, source: null, pendingCount: 3 });
  const html = renderChainStateLine(line);
  assert.match(html, /链状态：/);
  assert.match(html, /<b>监视中<\/b>/);
  assert.match(html, /等 3 个子任务/);
  assert.equal(html.includes("链已停"), false);
});

test("D2-⑪ 监视档的「读不到就不说」：pendingCount = null ⇒ 无个数；0 ⇒ 按 DAG 监视；非整数 / 负数 ⇒ 视同读不到", () => {
  assert.match(renderChainStateLine(deriveChainStateLine({ chainState: "monitoring", pendingCount: null })), /<b>监视中<\/b>/);
  assert.equal(
    renderChainStateLine(deriveChainStateLine({ chainState: "monitoring", pendingCount: null })).includes("个子任务"),
    false,
    "null ⇒ 不显示个数（不臆造）",
  );
  assert.match(renderChainStateLine(deriveChainStateLine({ chainState: "monitoring", pendingCount: 0 })), /无待回子任务/);
  for (const bad of [-1, 2.5, "3", NaN]) {
    const view = deriveChainStateLine({ chainState: "monitoring", pendingCount: bad });
    assert.equal(view.pendingCount, null, `pendingCount = ${String(bad)} ⇒ 按读不到处理`);
  }
});

test("04-① 监视档 + featureId 在场 ⇒ 链状态行挂停链表单（空表单 POST 既有写口，零脚本零新写面）", () => {
  const html = renderChainStateLine(
    deriveChainStateLine({ chainState: "monitoring", reason: null, source: null, pendingCount: 2 }),
    "F1",
  );
  assert.match(html, /<b>监视中<\/b>/);
  assert.match(html, /等 2 个子任务/);
  assert.match(html, /<form method="post" action="\/features\/F1\/stop-chain"/, "纯表单过 CSRF Origin/Referer 档");
  assert.match(html, /data-submit="[^"]+"/, "提交即时反馈口（v0.9.5 复用）");
  assert.match(html, /<button type="submit"[^>]*>停链/, "按钮文案含「停链」（引导行指路的对象必须真在场）");
  assert.equal(html.includes("name="), false, "空表单：零 body 字段（停链按需求定位，id 走路径）");
  assert.equal(html.includes("<script"), false, "零脚本（内联脚本闭集不扩）");
});

test("04-② 停链表单的 fail-open 三档：不传 featureId / 空白标识 / 非监视档 ⇒ 均不出表单", () => {
  const mon = deriveChainStateLine({ chainState: "monitoring", reason: null, source: null, pendingCount: 1 });
  assert.equal(renderChainStateLine(mon).includes("stop-chain"), false, "既有 8 处调用点（不传第二参）零改动");
  assert.equal(renderChainStateLine(mon, "").includes("stop-chain"), false, "空串标识 ⇒ 不出表单");
  assert.equal(renderChainStateLine(mon, "   ").includes("stop-chain"), false, "纯空白标识 ⇒ 不出表单");
  const stopped = renderChainStateLine(
    deriveChainStateLine({ chainState: "stopped", reason: "用户经链状态行「停链」", source: "user", pendingCount: null }),
    "F1",
  );
  assert.equal(stopped.includes("stop-chain"), false, "链已停 ⇒ 无「再停一次」入口（球已在用户手里）");
  assert.equal(deriveChainStateLine(null), null, "快照缺席 ⇒ 整行不渲染（含表单）");
  assert.equal(renderChainStateLine(deriveChainStateLine(null), "F1"), "", "缺席档即便传 id 也不出表单");
});

test("05-① 监视档感知 awaiting：monitoring ∧ awaiting=true ⇒ 标签换「等你回答」、计数子串与停链入口照旧", () => {
  const mon = deriveChainStateLine({ chainState: "monitoring", reason: null, source: null, pendingCount: 2 });
  const html = renderChainStateLine(mon, "F1", true);
  assert.match(html, /链状态：<b>等你回答<\/b>/, "组合态档位标签 = 等你回答");
  assert.match(html, /等 2 个子任务/, "waiting 计数子串逐字不动（链仍在监视）");
  assert.match(html, /要插话请点「停链」/, "stopHint 逐字保留");
  assert.match(html, /<form method="post" action="\/features\/F1\/stop-chain"/, "停链表单出条件不变（monitoring ∧ featureId 在场）");
  assert.equal(html.includes("<b>监视中</b>"), false, "组合态不再显示「监视中」");
});

test("05-② 组合态负锚：awaiting=true ∧ 不传 featureId ⇒ 换标签但不臆造停链入口（指路文案与表单同进同出）", () => {
  const mon = deriveChainStateLine({ chainState: "monitoring", reason: null, source: null, pendingCount: 2 });
  const noId = renderChainStateLine(mon, undefined, true);
  assert.match(noId, /<b>等你回答<\/b>/, "档位标签与 awaiting 无关地渲染");
  assert.equal(noId.includes("stop-chain"), false, "无表单 ⇒ 不出停链表单");
  assert.equal(noId.includes("要插话请点「停链」"), false, "无表单 ⇒ 指路文案同离场");
});

test("05-③ 纯监视档逐字不变负锚：第三参缺省 / false ⇒ 输出与既往逐字一致（既有调用点零改动）", () => {
  const mon = deriveChainStateLine({ chainState: "monitoring", reason: null, source: null, pendingCount: 3 });
  const baseline = renderChainStateLine(mon, "F1");
  assert.equal(renderChainStateLine(mon, "F1", false), baseline, "显式 false ⇒ 逐字一致");
  assert.equal(renderChainStateLine(mon, "F1", undefined), baseline, "显式 undefined ⇒ 逐字一致");
  assert.match(baseline, /<b>监视中<\/b>/);
  const nullMon = renderChainStateLine(deriveChainStateLine({ chainState: "monitoring", pendingCount: null }), "F1", true);
  assert.equal(nullMon.includes("个子任务"), false, "awaiting 档不改变 pendingCount null 的「读不到不臆造」");
  assert.match(nullMon, /<b>等你回答<\/b>/);
});

test("D2-⑫ 读面三态之二 / 之三：链已停 · 来源 user（不解冻）/ 来源 auto（可解冻），均带原因", () => {
  const userLine = renderChainStateLine(
    deriveChainStateLine({ chainState: "stopped", reason: "用户经停链口停链", source: "user", pendingCount: null }),
  );
  assert.match(userLine, /<b>链已停<\/b>/);
  assert.match(userLine, /用户经停链口停链/);
  assert.match(userLine, /来源：用户（停链口）· 人工动作不解冻/);

  const autoLine = renderChainStateLine(
    deriveChainStateLine({ chainState: "stopped", reason: "唤醒退让超上限", source: "auto", pendingCount: 2 }),
  );
  assert.match(autoLine, /来源：自动 · 补充 \/ 回答可解冻/);
  assert.match(autoLine, /唤醒退让超上限/);
});

test("D2-⑬ 原因与来源缺失 ⇒ 如实兜字（不臆造）", () => {
  const line = renderChainStateLine(deriveChainStateLine({ chainState: "stopped", reason: "  ", source: null }));
  assert.match(line, /原因未记录/);
  assert.match(line, /来源：未知/);
});

test("D2-⑭ 快照缺席 / 坏形状 ⇒ 不渲染该行、不报错", () => {
  for (const absent of [null, undefined]) {
    assert.equal(deriveChainStateLine(absent), null, `${String(absent)} ⇒ null`);
    assert.equal(renderChainStateLine(deriveChainStateLine(absent)), "", "缺席 ⇒ 空串（整行不渲染）");
  }
  assert.equal(deriveChainStateLine({ chainState: "queued", reason: "x", source: null, pendingCount: 1 }), null, "非闭集态 ⇒ 不渲染");
  assert.equal(deriveChainStateLine({}), null);
});

test("D2-⑮ 宿主面回落：未注入快照 ⇒ 由接力内存态派生（未置标志 = 监视中；置了 = 已停 + 来源）；接力未装配 ⇒ null", async () => {
  const { turns } = fakeTurns();
  const face = createHostFace(faceDeps(turns));
  assert.equal(face.chainSnapshotOf("F1"), null, "接力未起 ⇒ 无链知识 ⇒ null（读面不出该行）");

  const relay = face.startRelay();
  assert.deepEqual(face.chainSnapshotOf("F1"), { chainState: "monitoring", reason: null, source: null, pendingCount: null });
  await face.stopChain("F1");
  const stopped = face.chainSnapshotOf("F1");
  assert.equal(stopped.chainState, "stopped");
  assert.equal(stopped.source, "user", "回落路径同样带来源");
  assert.equal(typeof stopped.reason, "string");
});

test("D2-⑯ 注入闭包优先 + 抛错 ⇒ null 不崩，并留痕一行「链状态快照取值失败」", () => {
  const box = logBox();
  const { turns } = fakeTurns();
  const face = createHostFace({
    ...faceDeps(turns),
    chainSnapshot: () => ({ chainState: "monitoring", reason: null, source: null, pendingCount: 7 }),
  });
  face.startRelay({ log: box.log });
  assert.equal(face.chainSnapshotOf("F1").pendingCount, 7, "装配层注入的快照优先（含 pending 条数）");

  const bad = createHostFace({ ...faceDeps(turns), chainSnapshot: () => { throw new Error("台账不可读"); } });
  const relay = bad.startRelay({ log: box.log });
  assert.equal(bad.chainSnapshotOf("F1"), null, "取值抛错 ⇒ null（读面不渲染、不带上 500）");
  assert.equal(box.has("链状态快照取值失败"), true);
  assert.equal(box.has("台账不可读"), true);
  assert.equal(relay.isChainStopped("F1"), false, "读面失败不改任何链状态");
});

test("D2-⑰ 读面不得写状态：连读 user 停链的快照五次，标志与来源原样不动", async () => {
  const { turns } = fakeTurns();
  const face = createHostFace(faceDeps(turns));
  face.startRelay();
  await face.stopChain("F1");
  for (let i = 0; i < 5; i += 1) {
    assert.equal(face.chainSnapshotOf("F1").chainState, "stopped");
  }
  assert.equal(face.chainStopped("F1"), true, "只读口不产生解冻副作用");
});

test("D2-⑱ 装配层快照归一（composeChainSnapshot）：停链优先 / 条目给 N / 自动 armed 给 0 / 无知识 ⇒ null", () => {
  const stoppedRelay = createHostRelay({ submitTurn: () => fakeSubmitted() });
  stoppedRelay.requestStop("F1", "route", "user");
  const monitoringRelay = createHostRelay({ submitTurn: () => fakeSubmitted() });
  const ledger = { get: (id) => (id === "F1" ? { pending: ["t1", "t2", "t3"] } : null) };

  assert.deepEqual(
    composeChainSnapshot({ relay: stoppedRelay, ledger, heartbeat: { isAutoArmed: () => false } }, "F1"),
    { chainState: "stopped", reason: "route", source: "user", pendingCount: 3 },
    "停链标志优先，pending 条数一并给出",
  );
  assert.deepEqual(
    composeChainSnapshot({ relay: monitoringRelay, ledger, heartbeat: { isAutoArmed: () => false } }, "F1"),
    { chainState: "monitoring", reason: null, source: null, pendingCount: 3 },
  );
  assert.deepEqual(
    composeChainSnapshot({ relay: monitoringRelay, ledger: { get: () => null }, heartbeat: { isAutoArmed: () => true } }, "F9"),
    { chainState: "monitoring", reason: null, source: null, pendingCount: 0 },
    "自动 armed 无条目 ⇒ 纯 DAG 监视（0）",
  );
  assert.equal(composeChainSnapshot({ relay: monitoringRelay, ledger: { get: () => null }, heartbeat: null }, "F9"), null);
  assert.equal(composeChainSnapshot({ relay: null, ledger: null, heartbeat: null }, "F1"), null, "接力未装配 ⇒ null");
  assert.equal(composeChainSnapshot({ relay: monitoringRelay, ledger, heartbeat: null }, "  "), null, "标识缺失 ⇒ null");
});

test("D2-⑲ 挂起台账条数走真 store（内存事实源）：arm ⇒ N，clear ⇒ 无条目", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-d2-"));
  try {
    const store = new SuspendLedgerStore(join(dir, "suspended.json"));
    store.arm({ featureId: "F1", turnId: "turn-1", contextId: "ctx-1", pending: ["a", "b"] });
    const relay = createHostRelay({ submitTurn: () => fakeSubmitted() });
    assert.equal(
      composeChainSnapshot({ relay, ledger: store, heartbeat: null }, "F1").pendingCount,
      2,
      "pending 条数 = 台账条目原样（2）",
    );
    assert.equal(composeChainSnapshot({ relay, ledger: store, heartbeat: null }, "F2"), null, "无条目无 armed ⇒ 不渲染");
    store.clear("F1");
    assert.equal(composeChainSnapshot({ relay, ledger: store, heartbeat: null }, "F1"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 件2（HTTP 面）+ T1/T2 锚复核
// ===========================================================================

const NOW = Date.parse("2026-09-29T12:00:00Z");

function detailClient(featureOver = {}) {
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features: [], stateCounts: null };
    },
    async getFeature(featureId) {
      return {
        feature: {
          featureId,
          state: "executing",
          title: "需求甲",
          ownerGroup: "g",
          stage: "改造",
          version: "v0.9.5",
          approval: "已通过",
          createdAt: "c",
          updatedAt: "u",
          ...featureOver,
        },
        tasks: [],
      };
    },
    async getFeatureTrace() {
      return { nodes: [], waitingCount: 0, dispatchedCount: 0, runningCount: 0, failedCount: 0 };
    },
    async getProjects() {
      throw new Error("不该被本文件触达");
    },
    async getTasks() {
      throw new Error("不该被本文件触达");
    },
  };
}

function emptyVersionsLedger() {
  const dir = mkdtempSync(join(tmpdir(), "board-d2-http-"));
  const file = join(dir, "versions.json");
  writeFileSync(file, JSON.stringify({ version: 1, versions: [] }, null, 2) + "\n", "utf8");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withServer(run, hostFace) {
  const seed = emptyVersionsLedger();
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: detailClient(),
    now: () => NOW,
    defaultGroup: "g",
    versionsLedgerFile: seed.file,
    ...(hostFace === undefined ? {} : { hostFace }),
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
    seed.cleanup();
  }
}

async function getDetail(base) {
  const res = await fetch(`${base}/features/F1`);
  return { status: res.status, text: await res.text() };
}

test("D2-⑳ HTTP 详情页：停链后渲染「链已停 · 来源」一行；监视态渲染「监视中」；两者皆无 ⇒ 不出该行且 200", async () => {
  const { turns } = fakeTurns();
  const face = createHostFace(faceDeps(turns));
  face.startRelay();
  await withServer(async (base) => {
    const monitoring = await getDetail(base);
    assert.equal(monitoring.status, 200);
    assert.match(monitoring.text, /链状态：<b>监视中<\/b>/);
    assert.equal(monitoring.text.includes("链已停"), false);
    // -04 页级复核：监视档 ⇒ 停链表单在场（同一 `chainStateHtml` 单元，`workspace` 拼装顺序不变）
    assert.match(monitoring.text, /<form method="post" action="\/features\/F1\/stop-chain"/, "04 §3⑥：监视态页级出表单");
    assert.equal(monitoring.text.includes("<h2>动作</h2>"), false, "04 §3⑥：监视中 ⇒ 动作区不出 DOM（页级短路）");

    await face.stopChain("F1");
    const stopped = await getDetail(base);
    assert.equal(stopped.status, 200);
    assert.match(stopped.text, /链状态：<b>链已停<\/b>/);
    assert.match(stopped.text, /来源：用户（停链口）· 人工动作不解冻/);
    // -04 页级负锚：stopped 档不出停链表单（球已回用户手里 ⇒ 无「再停一次」入口）∧ 动作区回来
    assert.equal(stopped.text.includes("/features/F1/stop-chain"), false, "04 §3⑥：stopped 档无停链表单（页级负锚）");
    assert.match(stopped.text, /<h2>动作<\/h2>/, "04 §3⑥：停链后动作区回来（页级）");
  }, face);

  const noRelay = createHostFace(faceDeps(fakeTurns().turns));
  await withServer(async (base) => {
    const res = await getDetail(base);
    assert.equal(res.status, 200, "接力未装配 ⇒ 不报错");
    assert.equal(res.text.includes("链状态："), false, "快照缺席 ⇒ 整行不渲染");
    assert.equal(res.text.includes("/features/F1/stop-chain"), false, "快照缺席 ⇒ 表单同离场");
    assert.match(res.text, /<h2>动作<\/h2>/, "04 fail-open 页级：快照缺席 ⇒ 动作区照旧在场");
  }, noRelay);

  await withServer(async (base) => {
    const res = await getDetail(base);
    assert.equal(res.status, 200);
    assert.equal(res.text.includes("链状态："), false, "宿主面未装配 ⇒ 同样不出该行");
    assert.equal(res.text.includes("/features/F1/stop-chain"), false, "宿主面未装配 ⇒ 无表单");
  }, null);
});

test("D2-ㄑ 详情页既有档位与按钮文案未被本节点改动（5c739397 读面精简锚复核）", async () => {
  const { turns } = fakeTurns();
  const face = createHostFace(faceDeps(turns));
  face.startRelay();
  await withServer(async (base) => {
    const res = await getDetail(base);
    assert.equal(res.status, 200);
    assert.equal(res.text.includes("触发一轮"), false, "底层机制词仍不得上页（C5 负锚）");
    assert.match(res.text, /轮次进度：|链状态：/, "轮次进度区与链状态行同区渲染");
    // -04 §3⑥：`workspace` 拼装顺序不变 —— turnTrace → turnProgress → chainState（含停链表单）→ 动作区/澄清框
    // 监视态页面上：链状态行的 stop-chain 表单必须**早于**任何动作区/澄清框锚点（此处后者缺席，只钉前者在场）。
    const stopChainPos = res.text.indexOf("/features/F1/stop-chain");
    const chainStatePos = res.text.indexOf("链状态：");
    assert.ok(chainStatePos >= 0 && stopChainPos > chainStatePos, "停链表单紧随链状态行（chainStateHtml 内部序）");
    assert.equal(res.text.includes("<h2>动作</h2>"), false, "监视态 ⇒ 动作区在 workspace 尾部整块缺席（顺序不变、内容退场）");
  }, face);
});

test("D2-ㄒ buildHostFace 不注入 chainSnapshot 时行为不变（既有装配方零改动）", () => {
  const { turns } = fakeTurns();
  const built = buildHostFace({
    orgsDir: "C:/orgs",
    defaultOrg: "g",
    kind: "claude",
    mcpBaseUrl: "http://127.0.0.1:8787",
    machineDist: "C:/machine/dist",
  });
  assert.notEqual(built, null);
  assert.equal(built.face.chainSnapshotOf("F1"), null, "未起接力 ⇒ null（不渲染）");
  const withSnap = buildHostFace({
    orgsDir: "C:/orgs",
    defaultOrg: "g",
    kind: "claude",
    mcpBaseUrl: "http://127.0.0.1:8787",
    machineDist: "C:/machine/dist",
    chainSnapshot: () => ({ chainState: "monitoring", reason: null, source: null, pendingCount: 1 }),
  });
  assert.equal(withSnap.face.chainSnapshotOf("F1").pendingCount, 1, "注入透到 faceDeps");
});

test("D2-ㄓ T1 判据分流与 T2 分诊常量未被本节点触碰（正向复核）", () => {
  assert.equal(DEFAULT_HEARTBEAT_INTERVAL_MS, 30_000, "心跳间隔口径不变");
  const relay = createHostRelay({
    submitTurn: () => fakeSubmitted({ occupant: OCC("turn-own") }),
    now: () => 0,
  });
  const r = relay.fireWake({ requirementId: "F1", org: "o", prompt: "p", turnId: "turn-own" });
  assert.equal(r.reason, "occupant_self", "占用者 = 本条目那一轮 ⇒ 跳过、不停链（T2 锚）");
  assert.equal(relay.isChainStopped("F1"), false);
  assert.equal(relay.stopView("F1"), null);
});
