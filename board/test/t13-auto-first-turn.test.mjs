/**
 * v0.9.5 增补三用例（离线）：**建卡即自动首轮** —— `POST /requirements` 建卡成功后对同一需求
 * 自动点一发纯触发（复用宿主面 `triggerTurn` 现成通道）。
 *
 * 钉的四条口径（改造文档 §增补三）：
 * - ① **不阻塞建卡**：点火是 fire-and-forget，建卡响应的时延与语义（JSON 201 / 表单 303）与首轮无关；
 * - ② **不污染建卡**：宿主面未装配 / 桥不可达 / 起桥抛错 ⇒ 建卡仍成功，各留一行结构化日志；
 * - ③ **防重**：同需求已有在飞 / 排队轮 ⇒ 放弃点火（复用宿主面既有 occupant 判定，**不发轮、不起桥**）；
 * - ④ **不带补充文本**：点火入参无 `supplement` 键，轮消息逐字节 = 既有纯触发提示词。
 *
 * 边界锚：人工入口 `/features/:id/turn`（动作区「让 agent 继续」）不受影响；建卡校验失败 ⇒ 零点火。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";
import { BoardHostFace, TURN_BUSY, TURN_PROMPT_TITLE, buildTurnPrompt } from "../dist/host-face.js";
import { renderActionArea } from "../dist/web/views.js";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const LOG_TAG = "[auto-first-turn]";

/** 等微任务 + 一个宏任务拍，让 fire-and-forget 的迟到日志先落进捕获器。 */
async function settleTicks(ms = 30) {
  await new Promise((res) => setTimeout(res, ms));
}

/**
 * stderr 捕获器（只留 `[auto-first-turn]` 行）：自动首轮的结论**迟到**于响应，
 * 故收口前统一排空若干拍，断言的是「留痕行在、字段齐」，不是「留痕早于响应」。
 */
async function withLogCapture(run) {
  const lines = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk, ...rest) => {
    lines.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  try {
    await run();
    await settleTicks();
  } finally {
    process.stderr.write = original;
  }
  return lines.filter((l) => l.includes(LOG_TAG));
}

function fakeClient(featureOver = {}) {
  return {
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        return { features: [], stateCounts: null };
      },
      async getFeature(featureId) {
        return {
          feature: {
            featureId,
            state: "waiting_approval",
            title: "需求甲",
            ownerGroup: "g",
            stage: "需求分析",
            version: "v0.9.5",
            approval: "未发起",
            createdAt: "c",
            updatedAt: "u",
            ...featureOver,
          },
          tasks: [],
        };
      },
      async getFeatureTrace() {
        throw new Error("不该被本文件触达");
      },
      async getProjects() {
        throw new Error("不该被本文件触达");
      },
      async getTasks() {
        throw new Error("不该被本文件触达");
      },
    },
  };
}

/** 假写封装：恒成功建卡（featureId 可控）。 */
function fakeCreate(featureId = "F-NEW") {
  const seen = [];
  const fn = async (input) => {
    seen.push(input);
    return {
      ok: true,
      featureId,
      state: "waiting_approval",
      stage: "需求分析",
      version: input.version,
      approval: "未发起",
    };
  };
  return { fn, seen };
}

function okOutcome(featureId, over = {}) {
  return {
    ok: true,
    org: "g",
    featureId,
    disposition: "succeeded",
    queued: false,
    turnId: "turn-1",
    contextId: "ctx-1",
    round: 1,
    state: "succeeded",
    display: "已完成",
    summary: "首轮已推进",
    question: null,
    error: null,
    bridge: null,
    ...over,
  };
}

/** 假宿主面：`settleInMs` > 0 ⇒ 该时长后才收口（用于「响应不被阻塞」正锚）。 */
function fakeFace({ settleInMs = 0, outcome, fails = false } = {}) {
  const calls = [];
  const face = {
    async triggerTurn(input) {
      calls.push(input);
      if (fails) throw new Error("起桥抛错（假）");
      if (outcome !== undefined) return outcome;
      if (settleInMs > 0) await new Promise((res) => setTimeout(res, settleInMs));
      return okOutcome(input.featureId);
    },
    async confirmTurn(input) {
      return okOutcome(input.featureId);
    },
    async answerRequirement(input) {
      return okOutcome(input.featureId);
    },
    awaitingTurnOf() {
      return null;
    },
    busyTurnOf() {
      return null;
    },
    latestTurnOf() {
      return null;
    },
    queueView(org) {
      return { org, running: null, waiting: [], capacity: 1 };
    },
    async statusView() {
      return [];
    },
    configView() {
      return { orgsDir: "C:/orgs", defaultOrg: "g", kind: "claude" };
    },
    orgsDirProblem() {
      return null;
    },
    async stopBridge() {
      return null;
    },
  };
  return { face, calls };
}

// ---------------------------------------------------------------------------
// 真宿主面夹具（不起真桥、不打真 RPC）—— 防重与「无补充文本」两条锚要落到真实判定
// ---------------------------------------------------------------------------

function fakeBridges() {
  const calls = [];
  return {
    calls,
    async ensureStarted(config) {
      calls.push(config);
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

function fakeTurns(options = {}) {
  const calls = [];
  return {
    calls,
    submitTurn(input) {
      calls.push(input);
      return {
        turnId: "turn-1",
        requirementId: input.requirementId,
        contextId: "ctx-1",
        round: 1,
        queued: false,
        position: 1,
        display: "进行中",
        occupant: null,
        done: Promise.resolve({
          turnId: "turn-1",
          requirementId: input.requirementId,
          org: input.org,
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
        }),
      };
    },
    answerTurn(input) {
      throw new Error(`不该走 answer 通道：${input.requirementId}`);
    },
    latestTurnOf() {
      return null;
    },
    findAwaitingTurn() {
      return null;
    },
    busyTurnOf(requirementId) {
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

function realFace(turnOptions = {}) {
  const bridges = fakeBridges();
  const turns = fakeTurns(turnOptions);
  const face = new BoardHostFace({
    bridges,
    turns,
    orgsDir: "C:/tmp/orgs",
    defaultOrg: "g",
    dirKind: () => "dir",
  });
  return { face, bridges, turns };
}

async function withServer(run, { hostFace, create, extraOptions } = {}) {
  const { client } = fakeClient();
  const { fn, seen } = create ?? fakeCreate();
  const dir = mkdtempSync(join(tmpdir(), "board-t13-"));
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    defaultGroup: "g",
    createRequirementImpl: fn,
    ...(hostFace === undefined ? {} : { hostFace }),
    // 两把台账一律喂临时空文件（不读开发机 `.data/`，锁与停用判据不随本机状态漂移）
    versionsLedgerFile: join(dir, "versions.json"),
    orgsLedgerFile: join(dir, "orgs.json"),
    ...extraOptions,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, seen);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

function postRequirement(base, fields = {}, headers = {}) {
  return fetch(`${base}/requirements`, {
    method: "POST",
    redirect: "manual",
    headers: { "x-board-write": "1", ...FORM_HEADERS, ...headers },
    body: new URLSearchParams({ group: "g", title: "自动首轮探针", version: "v0.9.5", ...fields }).toString(),
  });
}

// ---------------------------------------------------------------------------
// ① 正锚：建卡成功 ⇒ 恰好一次点火，且**响应先于该轮收口**（未被阻塞）
// ---------------------------------------------------------------------------

test("T13-① 建卡 201 ⇒ 宿主面恰好点火一次，入参无 supplement（纯触发）", async () => {
  const { face, calls } = fakeFace();
  await withServer(
    async (base) => {
      const res = await postRequirement(base, {}, { accept: "application/json" });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.featureId, "F-NEW");
      assert.equal(calls.length, 1, "建卡成功须自动点一发首轮");
      assert.equal(calls[0].featureId, "F-NEW");
      assert.equal(calls[0].org, "g", "组织 = 本条实际生效的表单组织");
      assert.equal(calls[0].version, "v0.9.5");
      assert.equal("supplement" in calls[0], false, "自动首轮不带补充文本（也不新增表单字段）");
    },
    { hostFace: face },
  );
});

test("T13-② 建卡不被阻塞：假首轮 3s 才收口 ⇒ 201 先行返回（点火不等 `submitted.done`）", async () => {
  const { face, calls } = fakeFace({ settleInMs: 3000 });
  await withServer(
    async (base) => {
      const startedAt = Date.now();
      const res = await postRequirement(base, {}, { accept: "application/json" });
      const elapsed = Date.now() - startedAt;
      assert.equal(res.status, 201);
      await res.text();
      assert.ok(elapsed < 1000, `建卡响应被首轮收口拖住了（耗时 ${String(elapsed)}ms）`);
      assert.equal(calls.length, 1);
    },
    { hostFace: face },
  );
});

test("T13-③ 表单档：建卡成功仍 303 跳详情页（Location 形状不变）+ 照常点火一次", async () => {
  const { face, calls } = fakeFace();
  await withServer(
    async (base) => {
      const res = await postRequirement(base);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), "/features/F-NEW");
      assert.equal(await res.text(), "", "303 无响应体（PRG 语义不变）");
      assert.equal(calls.length, 1);
    },
    { hostFace: face },
  );
});

// ---------------------------------------------------------------------------
// ② 负例：点火失败 / 放弃不得污染建卡结果（各留一行留痕）
// ---------------------------------------------------------------------------

test("T13-④ 桥不可用（bridge_down）⇒ 建卡仍 201，留痕一行含 featureId / 结果 / 原因", async () => {
  const { face } = fakeFace({
    outcome: okOutcome("F-NEW", {
      ok: false,
      disposition: "bridge_down",
      turnId: null,
      state: null,
      display: "宿主桥已断",
      error: { code: "spawn_failed", message: "起不来" },
    }),
  });
  const logs = await withLogCapture(async () => {
    await withServer(
      async (base) => {
        const res = await postRequirement(base, {}, { accept: "application/json" });
        assert.equal(res.status, 201);
        assert.equal((await res.json()).featureId, "F-NEW");
      },
      { hostFace: face },
    );
  });
  assert.equal(logs.length, 1, "一次点火失败一行留痕");
  assert.match(logs[0], /失败 featureId=F-NEW org=g 结果=bridge_down/);
  assert.match(logs[0], /spawn_failed 起不来/, "留痕含根因（失败原因可回溯）");
});

test("T13-⑤ 起桥抛错 ⇒ 建卡仍 201 / 303，无异常冒泡，留痕一行结果=throw", async () => {
  const { face } = fakeFace({ fails: true });
  const logs = await withLogCapture(async () => {
    await withServer(
      async (base) => {
        const json = await postRequirement(base, {}, { accept: "application/json" });
        assert.equal(json.status, 201);
        await json.text();
        const form = await postRequirement(base);
        assert.equal(form.status, 303);
        assert.equal(form.headers.get("location"), "/features/F-NEW");
      },
      { hostFace: face },
    );
  });
  assert.equal(logs.length, 2, "两次点火各一行");
  assert.match(logs[0], /失败 featureId=F-NEW org=g 结果=throw :: 起桥抛错（假）/);
});

test("T13-⑥ 宿主面未装配（hostFace=null）⇒ 建卡仍 201、零点火，留痕一行放弃", async () => {
  const logs = await withLogCapture(async () => {
    await withServer(async (base) => {
      const res = await postRequirement(base, {}, { accept: "application/json" });
      assert.equal(res.status, 201);
      assert.equal((await res.json()).featureId, "F-NEW");
    });
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /放弃 featureId=F-NEW org=g 结果=未点火 :: 宿主面未装配/);
});

// ---------------------------------------------------------------------------
// ③ 防重：真宿主面 + 假轮次口 —— 已有在飞 / 排队轮 ⇒ 不发轮、不起桥
// ---------------------------------------------------------------------------

test("T13-⑦ 防重（真宿主面）：同需求已有在飞轮 ⇒ 建卡仍 201，submitTurn / ensureStarted 零调用", async () => {
  const { face, bridges, turns } = realFace({
    busy: {
      turnId: "turn-running",
      requirementId: "F-NEW",
      org: "g",
      contextId: "ctx-old",
      round: 1,
      state: "running",
      queuedAt: "q",
      startedAt: "s",
    },
  });
  const logs = await withLogCapture(async () => {
    await withServer(
      async (base) => {
        const res = await postRequirement(base, {}, { accept: "application/json" });
        assert.equal(res.status, 201);
        await res.text();
      },
      { hostFace: face },
    );
  });
  assert.equal(turns.calls.length, 0, "已有在飞轮 ⇒ 不得再入队第二轮");
  assert.equal(bridges.calls.length, 0, "撞 occupant 时不起桥（口径同人工触发）");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /放弃 featureId=F-NEW org=g 结果=busy/);
  assert.ok(logs[0].includes(TURN_BUSY), "留痕点名防重错误码（与人工触发同一判据）");
});

test("T13-⑧ 无在飞轮（真宿主面）⇒ 恰好发一轮，轮消息逐字节 = 既有纯触发提示词", async () => {
  const { face, bridges, turns } = realFace();
  await withServer(
    async (base) => {
      const res = await postRequirement(base, {}, { accept: "application/json" });
      assert.equal(res.status, 201);
      await res.text();
      await settleTicks();
      assert.equal(bridges.calls.length, 1);
      assert.equal(turns.calls.length, 1);
      const sent = turns.calls[0];
      assert.equal(sent.org, "g");
      assert.equal(sent.requirementId, "F-NEW");
      assert.equal(sent.text, buildTurnPrompt({ featureId: "F-NEW", org: "g", version: "v0.9.5" }));
      assert.ok(sent.text.startsWith(TURN_PROMPT_TITLE));
      assert.equal(sent.text.includes("用户补充"), false, "自动首轮不含补充块（留空 = 纯触发）");
    },
    { hostFace: face },
  );
});

// ---------------------------------------------------------------------------
// ④ 边界：建卡未成功 ⇒ 零点火；人工入口未被动
// ---------------------------------------------------------------------------

test("T13-⑨ 建卡失败（400 无 title / 502 写封装失败）⇒ 宿主面零调用（无卡可点）", async () => {
  const { face, calls } = fakeFace();
  await withServer(
    async (base) => {
      const bad = await postRequirement(base, { title: "  " }, { accept: "application/json" });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).code, "requirement_form_invalid");
      const failed = await postRequirement(base, {}, { accept: "application/json" });
      assert.equal(failed.status, 502);
      await failed.json();
      assert.deepEqual(calls, [], "建卡未成功不得点火（无 featureId 可点）");
    },
    { hostFace: face, create: { fn: async () => ({ ok: false, code: "bridge_write_failed", error: "写封装失败（假）" }), seen: [] } },
  );
});

test("T13-⑩ 人工入口未动：动作区仍渲染「触发一轮」表单（补充口 + 留空 = 只说继续）· 非监视态", () => {
  // 入参未带 chainMonitoring（缺省 undefined = 未接线/非监视态）⇒ -04 监视中短路不触发；
  // 本锚的语义边界 = **非监视态下**建卡自动首轮接入未吃掉人工入口（-04 §3⑥ 限域）。
  const html = renderActionArea("F1", {
    hostFaceAssembled: true,
    awaitingAnswer: false,
    approval: "未发起",
    state: "waiting_approval",
  });
  assert.match(html, /action="\/features\/F1\/turn"/, "人工触发口仍在原路由");
  assert.match(html, /<textarea name="supplement"/, "补充字段仍由人工表单携带");
  assert.match(html, /留空 = 只说「继续」/);
});

test("T13-⑩b 监视态（-04 §3⑥ 新例）：chainMonitoring=true ⇒ 人工入口整块离场（无人工触发 / 无补充框）", () => {
  // 与 ⑩ 同入参、只多一个 chainMonitoring=true：短路语义交给 derive 的监视中分支（-04 T1 已落）；
  // 本例把「监视中 ⇒ 人工入口缺席」这条页级判据钉在 t13 面，防有人日后把建卡自动首轮的锚扩到监视态。
  const html = renderActionArea("F1", {
    hostFaceAssembled: true,
    awaitingAnswer: false,
    approval: "未发起",
    state: "waiting_approval",
    chainMonitoring: true,
  });
  assert.equal(html, "", "监视中 ⇒ renderActionArea 空串（人工触发 + 补充框整块离场）");
  assert.equal(html.includes('action="/features/F1/turn"'), false, "无「触发一轮」路由");
  assert.equal(html.includes("name=\"supplement\""), false, "无补充字段");
});
