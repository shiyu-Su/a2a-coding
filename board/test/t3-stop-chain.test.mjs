/**
 * v0.9.5 C4 · T3 用例（离线）：**按需求停链口**（`POST /features/:id/stop-chain`）——
 * 白名单九→十、路由归一、置内存停链标志 + 复用 `cancelTurn` 清该需求在飞/排队轮、
 * 「停链后不再续火」、判定序 ①标志→②计数→③canceled→④判定表 的短路次序，以及 HTTP 路由面。
 *
 * 事实源：改造文档 `doc/v0.9.5/推进流程精简-改造文档.md` §2-C4（v5）。
 * 停链标志**落内存、不落 `.data/`、不跨重启持久** —— 与 R1/R2 同口径，用例按此钉死。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STOP_CHAIN_WRITE_PATH_TEMPLATE,
  WRITE_ROUTES,
  isWriteRoute,
  parseWriteRoute,
} from "../dist/write-guard.js";
import { RELAY_NOT_ASSEMBLED, createHostFace } from "../dist/host-face.js";
import { createHostRelay, shouldContinue } from "../dist/host-relay.js";
import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");

// ---------------------------------------------------------------------------
// 替身（与 t2-host-relay.test.mjs 同口径：只造该测例用到的最小面）
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

async function waitUntil(predicate, limit = 500) {
  for (let i = 0; i < limit; i += 1) {
    if (predicate()) return true;
    await new Promise((res) => setImmediate(res));
  }
  return false;
}

function fakeTurns(over = {}) {
  const calls = { submit: 0, cancel: [], settledHandler: null };
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
    setTurnSettledHandler(handler) {
      calls.settledHandler = handler;
    },
    ...over,
  };
  return { turns, calls };
}

function faceDeps(turns, over = {}) {
  return {
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
    defaultOrg: "g",
    dirKind: () => "dir",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// ① 白名单九→十 + 路由归一
// ---------------------------------------------------------------------------

test("T3-① WRITE_ROUTES 白名单十条（含 POST /features/{id}/stop-chain；T7 再扩挂起口 ⇒ 十一条），405 文案单点共用", () => {
  assert.equal(STOP_CHAIN_WRITE_PATH_TEMPLATE, "/features/{id}/stop-chain");
  assert.equal(WRITE_ROUTES.length, 11, JSON.stringify(WRITE_ROUTES));
  assert.ok(WRITE_ROUTES.includes("POST /features/{id}/stop-chain"), "停链口在清单内");
  assert.ok(WRITE_ROUTES.includes("POST /features/{id}/suspend"), "v0.9.5 C7（T7）挂起口在清单内");
  // 既有九条一条不少（回归：只增不改；T3 原十条 + T7 挂起口 = 十一）
  for (const route of [
    "POST /requirements",
    "POST /features/{id}/turn",
    "POST /host/{org}/stop",
    "POST /features/{id}/confirm",
    "POST /features/{id}/answer",
    "POST /features/{id}/schedule",
    "POST /orgs",
    "POST /orgs/{org}/members",
    "POST /versions",
  ]) {
    assert.ok(WRITE_ROUTES.includes(route), `既有写路由 ${route} 不得丢`);
  }
});

test("T3-② parseWriteRoute：stop-chain 归一为 {kind:'stop_chain',featureId}；近似路径 / 非 POST 不放行", () => {
  assert.deepEqual(parseWriteRoute("POST", "/features/F1/stop-chain"), { kind: "stop_chain", featureId: "F1" });
  // 后缀互不抢：turn / schedule / confirm / answer 归一不变
  assert.deepEqual(parseWriteRoute("POST", "/features/F1/turn"), { kind: "turn", featureId: "F1" });
  assert.deepEqual(parseWriteRoute("POST", "/features/F1/schedule"), { kind: "schedule", featureId: "F1" });
  assert.deepEqual(parseWriteRoute("POST", "/features/F1/confirm"), { kind: "confirm", featureId: "F1" });
  assert.deepEqual(parseWriteRoute("POST", "/features/F1/answer"), { kind: "answer", featureId: "F1" });
  for (const [method, path] of [
    ["GET", "/features/F1/stop-chain"],
    ["PUT", "/features/F1/stop-chain"],
    ["DELETE", "/features/F1/stop-chain"],
    ["POST", "/features/F1/stop-chain/"],
    ["POST", "/features//stop-chain"],
    ["POST", "/features/F1/x/stop-chain"],
    ["POST", "/stop-chain"],
    ["POST", "/features/stop-chain"],
    [undefined, "/features/F1/stop-chain"],
  ]) {
    assert.equal(isWriteRoute(method, path), false, `${method} ${path} 不得放行`);
    assert.equal(parseWriteRoute(method, path), null, `${method} ${path} 归一须为 null`);
  }
});

// ---------------------------------------------------------------------------
// ② 宿主面 stopChain：置标志 + 复用 cancelTurn 清该需求在飞/排队轮
// ---------------------------------------------------------------------------

test("T3-③ stopChain：置内存停链标志 + 复用 cancelTurn 清该需求占闸轮（排队先于开跑 ⇒ 一条也不发）", async () => {
  const { turns, calls } = fakeTurns({
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
  assert.ok(face.startRelay() !== null);
  assert.equal(face.chainStopped("F1"), false);

  const out = await face.stopChain("F1");
  assert.equal(out.ok, true);
  assert.equal(out.chainStopped, true);
  assert.equal(out.cancelledTurnId, "turn-busy");
  assert.equal(out.cancelDisplay, "已取消（未开跑，已从队列移除）");
  assert.deepEqual(calls.cancel, ["turn-busy"], "恰好复用 cancelTurn 清那一轮");
  assert.equal(face.chainStopped("F1"), true, "标志已置");
  assert.match(out.display, /已停链/);
  assert.equal(out.error, null);
});

test("T3-④ stopChain：无在飞/排队轮 ⇒ 仅置标志（幂等、不调 cancelTurn）· 标识缺失 ⇒ 结构化失败", async () => {
  const { turns, calls } = fakeTurns();
  const face = createHostFace(faceDeps(turns));
  face.startRelay();

  const first = await face.stopChain("F1");
  assert.equal(first.ok, true);
  assert.equal(first.cancelledTurnId, null);
  assert.equal(calls.cancel.length, 0, "无占用轮不取消任何东西");
  const second = await face.stopChain("F1");
  assert.equal(second.ok, true, "重复停链幂等");
  assert.equal(face.chainStopped("F1"), true);

  const empty = await face.stopChain("   ");
  assert.equal(empty.ok, false);
  assert.equal(empty.chainStopped, false);
});

test("T3-⑤ stopChain：接力未装配 ⇒ 结构化 board_relay_not_assembled（不假装已停）", async () => {
  const { turns } = fakeTurns({ setTurnSettledHandler: undefined });
  const face = createHostFace(faceDeps(turns));
  assert.equal(face.startRelay(), null, "轮管理器不支持收口回调 ⇒ 接力不装");

  const out = await face.stopChain("F1");
  assert.equal(out.ok, false);
  assert.equal(out.chainStopped, false);
  assert.equal(out.error.code, RELAY_NOT_ASSEMBLED);
  assert.equal(face.chainStopped("F1"), false);
});

// ---------------------------------------------------------------------------
// ③ 停链后不再续火 + 判定序 ①→②→③→④ 短路次序
// ---------------------------------------------------------------------------

test("T3-⑥ 停链后不再续火：置标志 ⇒ fire 被拒（reason=stopped）+ 收口不点火、不查探针", async () => {
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
  // 未停链时 fire 正常（对照）
  assert.equal(relay.fire(turnResult(), snap("executing")).ok, true);
  relay.requestStop("F1", "route");
  assert.equal(relay.chainCount("F1"), 0, "停链清零链内计数");

  assert.equal(relay.fire(turnResult(), snap("executing")).reason, "stopped", "停链后 fire 被拒");
  relay.handleTurnSettled(turnResult());
  await new Promise((res) => setImmediate(res));
  assert.equal(calls.probe, 0, "判定序① 命中 ⇒ 不走到 C3 探针");
  assert.equal(calls.submit, 1, "停链后不再新增点火（只有对照那一次）");
});

test("T3-⑦ 判定序短路：①标志 → ②计数 → ③canceled → ④判定表，前档命中即停、不进后档", async () => {
  // ① 标志 > ② 计数：标志置 + 计数也到顶 ⇒ 文案出「判定序①」，不出②
  {
    const lines = [];
    const relay = createHostRelay({
      chainLimit: 0,
      submitTurn: () => fakeSubmitted(),
      probe: { async fetchEngineState() { return snap("executing"); } },
      log: (l) => lines.push(l),
    });
    relay.requestStop("F1", "route");
    relay.handleTurnSettled(turnResult());
    await new Promise((res) => setImmediate(res));
    assert.equal(lines.some((l) => l.includes("判定序①")), true, "①须先出");
    assert.equal(lines.some((l) => l.includes("判定序②")), false, "①命中后不得进②");
  }
  // ② 计数 > ③ canceled：计数到顶 + canceled 收口 ⇒ 文案出②、不出③
  {
    const lines = [];
    const relay = createHostRelay({
      chainLimit: 1,
      submitTurn: () => fakeSubmitted(),
      probe: { async fetchEngineState() { return snap("executing"); } },
      log: (l) => lines.push(l),
    });
    assert.equal(relay.fire(turnResult(), null).ok, true);
    relay.handleTurnSettled(turnResult({ state: "canceled", kind: "canceled" }));
    await new Promise((res) => setImmediate(res));
    assert.equal(lines.some((l) => l.includes("判定序②")), true, "②须先出");
    assert.equal(lines.some((l) => l.includes("判定序③")), false, "②命中后不得进③");
  }
  // ③ canceled > ④ 判定表：无标志、计数未顶、canceled ⇒ 文案出③、不进④（防自激）
  {
    const lines = [];
    const relay = createHostRelay({
      submitTurn: () => fakeSubmitted(),
      probe: { async fetchEngineState() { return snap("executing"); } },
      log: (l) => lines.push(l),
    });
    relay.handleTurnSettled(turnResult({ state: "canceled", kind: "canceled" }));
    await new Promise((res) => setImmediate(res));
    assert.equal(lines.some((l) => l.includes("判定序③")), true, "③须先出");
    assert.equal(lines.some((l) => l.includes("判定序④")), false, "③命中后不得进④");
  }
  // ④ 判定表：前③档都不命中 ⇒ 走到④（succeeded+执行中 ⇒ 进监视）
  {
    const lines = [];
    const relay = createHostRelay({
      submitTurn: () => fakeSubmitted(),
      probe: { async fetchEngineState() { return snap("executing"); } },
      log: (l) => lines.push(l),
    });
    relay.handleTurnSettled(turnResult());
    await waitUntil(() => lines.some((l) => l.includes("判定序④")));
    assert.equal(lines.some((l) => l.includes("判定序④")), true);
    assert.equal(lines.some((l) => l.includes("进监视")), true, "succeeded+执行中 ⇒ 进监视（T3 不立即点火，监视分流归 C7/C8）");
  }
});

test("T3-⑧ 五档冻结回归：awaiting / failed / timeout / canceled / reviewing 逐字仍为「停」· succeeded+executing 仍按「续」", () => {
  // 其余五档逐字冻结（与 T2 断言同源，T3 不得回归）：一律 stop、不点火
  for (const state of ["awaiting_answer", "failed", "timeout", "canceled"]) {
    const d = shouldContinue({ state }, snap("executing"));
    assert.equal(d.action, "stop", `${state} 必须停`);
    assert.equal(d.mode, null);
  }
  for (const engine of ["reviewing", "integrating", "testing", "completed", "failed", "cancelled"]) {
    const d = shouldContinue({ state: "succeeded" }, snap(engine));
    assert.equal(d.action, "stop", `succeeded + 引擎态 ${engine} 必须停（等验收 / 结束）`);
  }
  // succeeded + executing ⇒ 动作是「续」（action=continue）；监视分流（suspend/auto）归 C7/C8，本节点不抢点火
  const cont = shouldContinue({ state: "succeeded" }, snap("executing"));
  assert.equal(cont.action, "continue", "succeeded+执行中 ⇒ 续");
  assert.equal(cont.mode, "monitor", "本节点按监视档续（不立即点火，负载分流归 C7/C8）");
});

// ---------------------------------------------------------------------------
// ④ HTTP 路由面：POST /features/:id/stop-chain
// ---------------------------------------------------------------------------

/** 空版本台账夹具（避免读开发机真实 `.data/versions.json`）。 */
function emptyVersionsLedger() {
  const dir = mkdtempSync(join(tmpdir(), "board-t3-"));
  const file = join(dir, "versions.json");
  writeFileSync(file, JSON.stringify({ version: 1, versions: [] }, null, 2) + "\n", "utf8");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function minimalClient() {
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features: [], stateCounts: null };
    },
    async getFeature() {
      throw new Error("停链口不读引擎态");
    },
    async getFeatureTrace() {
      throw new Error("不该被触达");
    },
    async getProjects() {
      throw new Error("不该被触达");
    },
    async getTasks() {
      throw new Error("不该被触达");
    },
  };
}

function okStopOutcome(featureId) {
  return {
    ok: true,
    featureId,
    chainStopped: true,
    cancelledTurnId: "turn-busy",
    cancelDisplay: "已取消（未开跑，已从队列移除）",
    error: null,
    display: `已停链：已取消该需求第 3 轮（turn-busy）；此后不再自动点火（重启板进程即恢复）`,
  };
}

function fakeServerFace(impl) {
  const calls = { stopChain: [] };
  return {
    calls,
    face: {
      async stopChain(featureId) {
        calls.stopChain.push(featureId);
        return impl === undefined ? okStopOutcome(featureId) : impl(featureId);
      },
    },
  };
}

async function withServer(run, { face } = {}) {
  const seed = emptyVersionsLedger();
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: minimalClient(),
    now: () => NOW,
    defaultGroup: "g",
    versionsLedgerFile: seed.file,
    hostFace: face === undefined ? fakeServerFace().face : face,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
    seed.cleanup();
  }
}

function post(base, path, headers) {
  return fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers });
}

test("T3-⑨ HTTP：POST /features/F1/stop-chain（守卫头档）⇒ 200 + 调用宿主面 stopChain", async () => {
  const { face, calls } = fakeServerFace();
  await withServer(async (base) => {
    const res = await post(base, "/features/F1/stop-chain", { "x-board-write": "1", accept: "application/json" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.chainStopped, true);
    assert.equal(body.cancelledTurnId, "turn-busy");
    assert.deepEqual(calls.stopChain, ["F1"]);
  }, { face });
});

test("T3-⑩ HTTP（负向）：缺守卫头 / 跨站 Origin ⇒ 403，且不触宿主面（CSRF 先于一切）", async () => {
  const { face, calls } = fakeServerFace();
  await withServer(async (base) => {
    const noProof = await post(base, "/features/F1/stop-chain", { accept: "application/json" });
    assert.equal(noProof.status, 403);
    assert.equal((await noProof.json()).code, "write_guard_origin_unknown");

    const crossSite = await post(base, "/features/F1/stop-chain", { origin: "http://evil.example", accept: "application/json" });
    assert.equal(crossSite.status, 403);
    assert.equal((await crossSite.json()).code, "write_guard_origin");

    assert.equal(calls.stopChain.length, 0, "被拒请求不得触达宿主面");
  }, { face });
});

test("T3-⑪ HTTP：GET 同径 ⇒ 404（非写路由、非页面路由）；宿主面未装配 ⇒ 503 host_face_disabled", async () => {
  await withServer(async (base) => {
    const get = await fetch(`${base}/features/F1/stop-chain`);
    assert.equal(get.status, 404);
  });
  await withServer(async (base) => {
    const res = await post(base, "/features/F1/stop-chain", { "x-board-write": "1", accept: "application/json" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "host_face_disabled");
  }, { face: null });
});

test("T3-⑫ HTTP：接力未装配 ⇒ 503 board_relay_not_assembled（结构化，不假装已停）", async () => {
  const { face } = fakeServerFace((featureId) => ({
    ok: false,
    featureId,
    chainStopped: false,
    cancelledTurnId: null,
    cancelDisplay: null,
    error: { code: "board_relay_not_assembled", message: "自动接力驱动器未装配（宿主面在、但接力未起）⇒ 无内存链可停，不假装已停" },
    display: "停链失败：自动接力未装配",
  }));
  await withServer(async (base) => {
    const res = await post(base, "/features/F1/stop-chain", { "x-board-write": "1", accept: "application/json" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "board_relay_not_assembled");
  }, { face });
});

test("T3-⑬ 停链标志落内存、不跨重启：宿主面实例间零共享（新实例/新接力 ⇒ 未停）", async () => {
  const { turns } = fakeTurns();
  const faceA = createHostFace(faceDeps(turns));
  faceA.startRelay();
  await faceA.stopChain("F1");
  assert.equal(faceA.chainStopped("F1"), true);

  const { turns: turnsB } = fakeTurns();
  const faceB = createHostFace(faceDeps(turnsB));
  faceB.startRelay();
  assert.equal(faceB.chainStopped("F1"), false, "不落任何持久面 ⇒ 另一实例（等价于重启后）无停链标志");
});
