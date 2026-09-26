/**
 * BD9 服务端用例（离线）：`POST /features/:id/confirm` 与 `POST /features/:id/answer`
 * 的方法门 / CSRF 守卫（**与 BD7 同规格**）、结构化状态透传，以及详情页两个入口的显示纪律
 * （确认按钮恒在宿主面装配时出现；**回答框仅在存在 `awaiting_answer` 轮时出现**）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

function fakeClient(featureOver = {}, { failFeature = false } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        calls.push("getFeatures");
        return { features: [], stateCounts: null };
      },
      async getFeature(featureId) {
        calls.push(`getFeature:${featureId}`);
        if (failFeature) throw new Error("编排桥读面不可用（假）");
        return {
          feature: {
            featureId,
            state: "waiting_approval",
            title: "需求甲",
            ownerGroup: "g",
            stage: "改造方案",
            version: "v0.9.0",
            approval: "待审批",
            createdAt: "c",
            updatedAt: "u",
            ...featureOver,
          },
          tasks: [],
        };
      },
      async getFeatureTrace(featureId) {
        throw new Error(`trace 不可用：${featureId}`);
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

function okOutcome(featureId, over = {}) {
  return {
    ok: true,
    org: "g",
    featureId,
    disposition: "succeeded",
    queued: false,
    turnId: "turn-1",
    contextId: "ctx-1",
    round: 2,
    state: "succeeded",
    display: "已完成",
    summary: "agent 已核对并放行",
    question: null,
    error: null,
    bridge: null,
    ...over,
  };
}

/** 假宿主面：记录实收入参，出参可控。 */
function fakeFace(outcomes = {}) {
  const calls = {
    triggerTurn: [],
    confirmTurn: [],
    answerRequirement: [],
    awaitingTurnOf: [],
    queueView: [],
  };
  const face = {
    async triggerTurn(input) {
      calls.triggerTurn.push(input);
      return outcomes.trigger ?? okOutcome(input.featureId);
    },
    async confirmTurn(input) {
      calls.confirmTurn.push(input);
      return outcomes.confirm ?? okOutcome(input.featureId);
    },
    async answerRequirement(input) {
      calls.answerRequirement.push(input);
      return outcomes.answer ?? okOutcome(input.featureId);
    },
    awaitingTurnOf(requirementId) {
      calls.awaitingTurnOf.push(requirementId);
      return outcomes.awaiting ?? null;
    },
    busyTurnOf() {
      return outcomes.busy ?? null;
    },
    queueView(org) {
      calls.queueView.push(org);
      return outcomes.queue ?? { org, running: null, waiting: [], capacity: 1 };
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

async function withServer(run, { outcomes, extraServerOptions, feature, failFeature } = {}) {
  const { client, calls } = fakeClient(feature ?? {}, { failFeature: failFeature === true });
  const { face, calls: faceCalls } = fakeFace(outcomes ?? {});
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    defaultGroup: "g",
    hostFace: face,
    ...extraServerOptions,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, calls, faceCalls);
  } finally {
    await handle.close();
  }
}

async function req(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, options);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const WRITE_HEADERS = { "x-board-write": "1" };
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

// ---------------------------------------------------------------------------
// ⑤ 写端点安全：与 BD7 同规格（缺自定义头 / 异源 ⇒ 拒；且**不触面**）
// ---------------------------------------------------------------------------

test("BD9-⑤（负向）confirm/answer：无守卫头无来源 ⇒ 403 write_guard_origin_unknown；跨站 Origin ⇒ 403 write_guard_origin；宿主面零调用", async () => {
  await withServer(async (base, _clientCalls, faceCalls) => {
    for (const path of ["/features/F1/confirm", "/features/F1/answer"]) {
      const bare = await req(base, path, { method: "POST", body: "answer=甲" });
      assert.equal(bare.status, 403, `${path} 裸 POST 必须拒`);
      assert.match(bare.text, /CSRF 来源不可判定/);

      const crossSite = await req(base, path, {
        method: "POST",
        headers: { origin: "http://evil.example:9999" },
        body: "answer=甲",
      });
      assert.equal(crossSite.status, 403, `${path} 跨站 Origin 必须拒`);
      assert.match(crossSite.text, /CSRF 来源校验拒绝/);
    }
    assert.deepEqual(faceCalls.confirmTurn, [], "被守卫拒的请求不得到达宿主面");
    assert.deepEqual(faceCalls.answerRequirement, []);
  });
});

test("BD9-⑤b 守卫头档与同源 Origin 档放行（与 BD7 同规格）", async () => {
  await withServer(async (base, _c, faceCalls) => {
    const withHeader = await req(base, "/features/F1/confirm", {
      method: "POST",
      headers: { ...WRITE_HEADERS, accept: "application/json" },
    });
    assert.equal(withHeader.status, 200);
    assert.equal(JSON.parse(withHeader.text).disposition, "succeeded");

    const originSelf = await req(base, "/features/F1/confirm", {
      method: "POST",
      headers: { ...FORM_HEADERS, origin: new URL(base).origin },
      redirect: "manual",
    });
    assert.equal(originSelf.status, 200, "同源 Origin（本板页面表单）放行");
    assert.equal(faceCalls.confirmTurn.length, 2);
  });
});

// ---------------------------------------------------------------------------
// ①（服务端段）confirm ⇒ 经宿主面确认指令口；org/version 取桥侧 detail
// ---------------------------------------------------------------------------

test("BD9-①s confirm：入参带 featureId + 桥侧 ownerGroup/version；结果如实回显（含 agent 回复摘要）", async () => {
  await withServer(async (base, clientCalls, faceCalls) => {
    const res = await req(base, "/features/F1/confirm", {
      method: "POST",
      headers: { ...WRITE_HEADERS, accept: "application/json" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      { featureId: faceCalls.confirmTurn[0].featureId, org: faceCalls.confirmTurn[0].org, version: faceCalls.confirmTurn[0].version },
      { featureId: "F1", org: "g", version: "v0.9.0" },
    );
    assert.equal(faceCalls.triggerTurn.length, 0, "确认口与首轮触发口在 HTTP 层不混用（face 内部复用同一通道）");
    assert.match(res.text, /agent 已核对并放行/);
    assert.ok(clientCalls.includes("getFeature:F1"), "归属组织取桥侧 detail（身份链 S1）");
  });
});

// ---------------------------------------------------------------------------
// ③（服务端段）answer 无 awaiting 轮 ⇒ 结构化 409；空答案 ⇒ 400 不触面
// ---------------------------------------------------------------------------

test("BD9-③s（负向）answer：无 awaiting 轮 ⇒ 结构化 409 not_awaiting（错误码 board_no_awaiting_turn）", async () => {
  await withServer(
    async (base, _c, faceCalls) => {
      const res = await req(base, "/features/F1/answer", {
        method: "POST",
        headers: { ...WRITE_HEADERS, accept: "application/json" },
        body: new URLSearchParams({ answer: "用 v0.9.0" }).toString(),
      });
      assert.equal(res.status, 409);
      const body = JSON.parse(res.text);
      assert.equal(body.disposition, "not_awaiting");
      assert.equal(body.error.code, "board_no_awaiting_turn");
      assert.equal(body.ok, false);
      assert.equal(faceCalls.answerRequirement.length, 1, "判据在宿主面（假面返回 not_awaiting），HTTP 层只透传");
    },
    {
      outcomes: {
        answer: okOutcome("F1", {
          ok: false,
          disposition: "not_awaiting",
          summary: null,
          error: { code: "board_no_awaiting_turn", message: "该需求当前没有待澄清的一轮（最近轮态 = 无记录）" },
          display: "回答未投递：当前没有待澄清的一轮",
        }),
      },
    },
  );
});

test("BD9-③t（负向）answer：空答案 ⇒ 400 answer_empty，不触宿主面", async () => {
  await withServer(async (base, _c, faceCalls) => {
    for (const body of ["", "answer=", "answer=%20%20"]) {
      const res = await req(base, "/features/F1/answer", {
        method: "POST",
        headers: WRITE_HEADERS,
        accept: "application/json",
        body,
      });
      assert.equal(res.status, 400, `空答案体「${body}」必须 400`);
      assert.match(res.text, /answer_empty/);
    }
    assert.deepEqual(faceCalls.answerRequirement, []);
  });
});

// ---------------------------------------------------------------------------
// 收口轨 16 ③（服务端兜底）：引擎终态需求 ⇒ turn / confirm / answer 三入口 409
// board_feature_terminal，**不触宿主面**（防绕过页面直调 API 白烧一轮）
// ---------------------------------------------------------------------------

for (const terminalState of ["completed", "failed", "cancelled"]) {
  test(`轨16-HTTP（负向）引擎态 ${terminalState} ⇒ turn/confirm/answer 三入口同返 409 board_feature_terminal，宿主面零调用`, async () => {
    await withServer(
      async (base, _c, faceCalls) => {
        const cases = [
          ["/features/F1/turn", undefined],
          ["/features/F1/confirm", undefined],
          ["/features/F1/answer", new URLSearchParams({ answer: "用 v0.9.0" }).toString()],
        ];
        for (const [path, body] of cases) {
          const json = await req(base, path, {
            method: "POST",
            headers: { ...WRITE_HEADERS, accept: "application/json" },
            body,
          });
          assert.equal(json.status, 409, `${path} 终态需求必须 409`);
          const parsed = JSON.parse(json.text);
          assert.equal(parsed.disposition, "terminal");
          assert.equal(parsed.error.code, "board_feature_terminal");
          assert.match(parsed.error.message, new RegExp(terminalState), "载荷回显引擎终态原值");
          assert.equal(parsed.turnId, null, "未开轮 ⇒ 无轮 id");
        }
        assert.deepEqual(faceCalls.triggerTurn, [], "终态拒单不得到达宿主面（一轮都不烧）");
        assert.deepEqual(faceCalls.confirmTurn, []);
        assert.deepEqual(faceCalls.answerRequirement, []);
      },
      { feature: { state: terminalState } },
    );
  });
}

test("轨16-HTTP：终态拒单 HTML 档同样 409（不伪装成 200）+ 页面说清「未投递 / 重新提需求」", async () => {
  await withServer(
    async (base) => {
      const page = await req(base, "/features/F1/turn", {
        method: "POST",
        headers: WRITE_HEADERS,
        body: undefined,
      });
      assert.equal(page.status, 409);
      assert.match(page.text, /board_feature_terminal/);
      assert.match(page.text, /未投递/);
      assert.match(page.text, /重新提需求/);
    },
    { feature: { state: "completed" } },
  );
});

test("轨16-HTTP（降级放行锚）编排桥读面失败 ⇒ 判不了终态，按既有链路放行（不得新增误挡）", async () => {
  await withServer(
    async (base, _c, faceCalls) => {
      const res = await req(base, "/features/F1/answer", {
        method: "POST",
        headers: { ...WRITE_HEADERS, accept: "application/json" },
        body: new URLSearchParams({ answer: "用 v0.9.0" }).toString(),
      });
      assert.equal(res.status, 200, "读面失败时回答照常交宿主面（其自身 awaiting 判据兜底）");
      assert.equal(faceCalls.answerRequirement.length, 1);
    },
    { failFeature: true },
  );
});

test("BD9-④s answer：有内容 ⇒ 交 answerRequirement（同 contextId 续推由面侧用例钉）；结果如实回显", async () => {
  await withServer(async (base, _c, faceCalls) => {
    const res = await req(base, "/features/F1/answer", {
      method: "POST",
      headers: { ...WRITE_HEADERS, accept: "application/json" },
      body: new URLSearchParams({ answer: "以 v0.9.0 落" }).toString(),
    });
    assert.equal(res.status, 200);
    assert.equal(faceCalls.answerRequirement.length, 1);
    assert.deepEqual(
      { featureId: faceCalls.answerRequirement[0].featureId, answer: faceCalls.answerRequirement[0].answer },
      { featureId: "F1", answer: "以 v0.9.0 落" },
    );
    assert.equal(JSON.parse(res.text).contextId, "ctx-1");
  });
});

// ---------------------------------------------------------------------------
// 页面：确认按钮（文案诚实）+ 回答框（仅在适用时出现）
// ---------------------------------------------------------------------------

test("BD9-页面：详情页恒有确认指令入口（文案 = 给 agent 的指令，非「板上批准」）；无 awaiting 轮 ⇒ 不显示回答框", async () => {
  await withServer(async (base) => {
    const page = await req(base, "/features/F1");
    assert.equal(page.status, 200);
    assert.match(page.text, /action="\/features\/F1\/confirm"/);
    assert.match(page.text, /发送确认指令给 agent（由 agent 核对后决定是否放行）/);
    assert.match(page.text, /给 agent 的指令/);
    assert.match(page.text, /不存在「板上批准」/);
    assert.match(page.text, /feature_approval_not_ready|approval 非「待审批」/, "文案须明说 agent 可能不放行的例子");
    assert.equal(page.text.includes('action="/features/F1/answer"'), false, "无 awaiting 轮不得显示回答框");
  });
});

test("BD9-页面b：存在 awaiting_answer 轮 ⇒ 显示回答框（textarea name=answer + 问题原文 + 同 contextId 提示）", async () => {
  await withServer(
    async (base) => {
      const page = await req(base, "/features/F1");
      assert.equal(page.status, 200);
      assert.match(page.text, /action="\/features\/F1\/answer"/);
      assert.match(page.text, /<textarea name="answer"/);
      assert.match(page.text, /改造文档以哪个版本落？/, "问题原文如实显示");
      assert.match(page.text, /续接同一 contextId/);
    },
    {
      outcomes: {
        awaiting: {
          turnId: "turn-old",
          requirementId: "F1",
          org: "g",
          contextId: "ctx-1",
          taskId: "t-old",
          state: "awaiting_answer",
          summary: null,
          question: "改造文档以哪个版本落？",
          error: null,
          bridgeNote: null,
          queuedAt: "q",
          startedAt: "s",
          finishedAt: null,
          updatedAt: "u",
        },
      },
    },
  );
});

// ---------------------------------------------------------------------------
// 收口轨 16 ①（页面）：引擎终态优先 —— 台账里的陈旧 awaiting 残留不再渲染表单/引导
// ---------------------------------------------------------------------------

test("轨16-页面：终态需求（completed）∧ 宿主面仍能给 awaiting 记录 ⇒ 不渲染回答框、引导行是终态文案、且根本不查 awaiting 轮", async () => {
  await withServer(
    async (base, _c, faceCalls) => {
      const page = await req(base, "/features/F1");
      assert.equal(page.status, 200);
      assert.equal(page.text.includes('action="/features/F1/answer"'), false, "终态需求不得渲染回答表单（残留脏账不作数）");
      assert.match(page.text, /<p class="hint nextstep">本需求已完成/, "引导行 = 终态文案");
      assert.doesNotMatch(page.text, /回答上方问题/);
      assert.equal(faceCalls.awaitingTurnOf.length, 0, "终态判据在服务端先行：连 awaiting 轮都不查");
    },
    {
      feature: { state: "completed" },
      outcomes: {
        awaiting: {
          turnId: "turn-1",
          requirementId: "F1",
          org: "g",
          contextId: "ctx-1",
          taskId: "t-1",
          state: "awaiting_answer",
          summary: null,
          question: "改造文档以哪个版本落？",
          error: null,
          bridgeNote: null,
          queuedAt: "q",
          startedAt: "s",
          finishedAt: null,
          updatedAt: "u",
        },
      },
    },
  );
});

// ---------------------------------------------------------------------------
// 方法门：新写路径只认 POST（其余落未知路径 404，读面不破）
// ---------------------------------------------------------------------------

test("BD9-方法门：GET/PUT /features/F1/confirm|answer 不放行（404，未知路径先行）；405 文案列出五条写路径", async () => {
  await withServer(async (base, _c, faceCalls) => {
    for (const [method, path] of [
      ["GET", "/features/F1/confirm"],
      ["PUT", "/features/F1/confirm"],
      ["GET", "/features/F1/answer"],
      ["DELETE", "/features/F1/answer"],
    ]) {
      const res = await req(base, path, { method });
      assert.equal(res.status, 404, `${method} ${path} 不得落入写面`);
    }
    const postRoot = await req(base, "/", { method: "POST" });
    assert.equal(postRoot.status, 405);
    assert.match(postRoot.text, /POST \/features\/\{id\}\/confirm/);
    assert.match(postRoot.text, /POST \/features\/\{id\}\/answer/);
    assert.equal(faceCalls.confirmTurn.length, 0);
    assert.equal(faceCalls.answerRequirement.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 收口轨 14 ③（服务端段）：同需求已有在飞 / 排队轮 ⇒ 409 board_turn_busy 三入口同形
// ---------------------------------------------------------------------------

const BUSY = {
  turnId: "turn-run",
  requirementId: "F1",
  org: "g",
  contextId: "ctx-1",
  round: 2,
  state: "running",
  queuedAt: "q",
  startedAt: "s",
};

function busyOutcome(featureId, state) {
  return okOutcome(featureId, {
    ok: false,
    disposition: "busy",
    state,
    turnId: "turn-run",
    error: { code: "board_turn_busy", message: `该需求已有${state === "queued" ? "排队" : "在飞"}的一轮（第 2 轮 · turn-run）⇒ 本次不再入队` },
    summary: null,
  });
}

test("轨14-HTTP（负向）turn / confirm / answer 三入口在占用时同返 409 + board_turn_busy（载荷含占用轮 id 与 kind）", async () => {
  await withServer(
    async (base) => {
      const cases = [
        ["/features/F1/turn", undefined],
        ["/features/F1/confirm", undefined],
        ["/features/F1/answer", new URLSearchParams({ answer: "用 v0.9.0" }).toString()],
      ];
      for (const [path, body] of cases) {
        const json = await req(base, path, {
          method: "POST",
          headers: { "x-board-write": "1", accept: "application/json" },
          body,
        });
        assert.equal(json.status, 409, `${path} 占用时必须 409（与 board_no_awaiting_turn 同族）`);
        const parsed = JSON.parse(json.text);
        assert.equal(parsed.disposition, "busy");
        assert.equal(parsed.error.code, "board_turn_busy");
        assert.equal(parsed.turnId, "turn-run", "载荷回显占用轮 id");
        assert.equal(parsed.state, "running", "载荷回显占用轮 kind");
        const page = await req(base, path, { method: "POST", headers: { "x-board-write": "1" }, body });
        assert.equal(page.status, 409, "HTML 档与 JSON 档同码（不伪装成 200）");
        assert.match(page.text, /board_turn_busy/);
        assert.match(page.text, /未入队/, "页面须明说本次没有入队");
      }
    },
    { outcomes: { trigger: busyOutcome("F1", "running"), confirm: busyOutcome("F1", "running"), answer: busyOutcome("F1", "running") } },
  );
});

test("轨14-HTTP（正向锚）awaiting_answer 不被当成占用 ⇒ 回答照常 200（防重不误锁澄清链路）", async () => {  await withServer(
    async (base) => {
      const res = await req(base, "/features/F1/answer", {
        method: "POST",
        headers: { "x-board-write": "1", accept: "application/json" },
        body: new URLSearchParams({ answer: "用 v0.9.0" }).toString(),
      });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.text).disposition, "succeeded");
    },
    {
      outcomes: {
        busy: null,
        awaiting: {
          turnId: "turn-old",
          requirementId: "F1",
          org: "g",
          contextId: "ctx-1",
          taskId: "t-old",
          state: "awaiting_answer",
          summary: null,
          question: "以哪个版本落？",
          error: null,
          bridgeNote: null,
          queuedAt: "q",
          startedAt: "s",
          finishedAt: null,
          updatedAt: "u",
        },
      },
    },
  );
});

// ---------------------------------------------------------------------------
// REQ-v0.9.2 N7：turn / confirm / answer 的 HTML 档分流 —— 受理成功（排队）⇒ 303 回详情页；
// 有内容回执（摘要 / 澄清问题 / 失败根因）⇒ 仍出整页（跳转不得吞掉 agent 的回答）
// ---------------------------------------------------------------------------

const QUEUED = okOutcome("F1", {
  disposition: "queued",
  queued: true,
  state: "queued",
  round: 3,
  turnId: "turn-q3",
  summary: null,
  display: "已排队（同组织一时刻只跑一轮）",
});

function turnPost(base, headers, body, redirect = "follow") {
  return req(base, "/features/F1/turn", { method: "POST", headers, body, redirect });
}

test("N7-HTTP 受理成功（queued）HTML 档 ⇒ 303 + Location 详情页（PRG：刷新不重复烧一轮）、无正文", async () => {
  await withServer(
    async (base) => {
      const res = await turnPost(base, { ...WRITE_HEADERS, accept: "text/html" }, undefined, "manual");
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), "/features/F1");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.text, "", "303 不出正文（内容在详情页的轮次进度行）");
    },
    { outcomes: { trigger: QUEUED } },
  );
});

test("N7-HTTP 受理成功 JSON 档不变（202 + 结构化载荷）；confirm / answer 同规则", async () => {
  await withServer(
    async (base, _c, faceCalls) => {
      const json = await turnPost(base, { ...WRITE_HEADERS, accept: "application/json" });
      assert.equal(json.status, 202, "JSON 档仍是 202（受理语义不因 303 而丢）");
      assert.equal(JSON.parse(json.text).disposition, "queued");

      const confirm = await req(base, "/features/F1/confirm", {
        method: "POST",
        headers: { ...WRITE_HEADERS, accept: "text/html" },
        redirect: "manual",
      });
      assert.equal(confirm.status, 303, "确认走的同一条触发通道 ⇒ 受理成功同样 303 回详情页");
      assert.equal(confirm.headers.get("location"), "/features/F1");

      const followed = await turnPost(base, { ...WRITE_HEADERS, accept: "text/html" });
      assert.equal(followed.status, 200, "浏览器跟随 303 ⇒ 落在详情页");
      assert.match(followed.text, /轮次进度：<b>第 3 轮 排队中<\/b>/, "落点必须看得见轮次（queued 时队列面查不到位次 ⇒ 只说排队中）");

      const answer = await req(base, "/features/F1/answer", {
        method: "POST",
        headers: { ...WRITE_HEADERS, accept: "text/html" },
        body: new URLSearchParams({ answer: "以 v0.9.0 落" }).toString(),
      });
      assert.equal(answer.status, 200, "回答档出的是 agent 的产出（摘要）⇒ 仍整页，不跳转");
      assert.match(answer.text, /agent 已核对并放行/);
      assert.equal(faceCalls.answerRequirement.length, 1);
    },
    {
      outcomes: {
        trigger: QUEUED,
        confirm: QUEUED,
        // 303 的落点：台账侧这条排队轮就是详情页要显示的「第 3 轮 排队中」
        busy: {
          turnId: "turn-q3",
          requirementId: "F1",
          org: "g",
          contextId: "ctx-1",
          round: 3,
          state: "queued",
          queuedAt: "q",
          startedAt: null,
        },
      },
    },
  );
});

test("N7-HTTP（负向锚）有内容回执仍整页：succeeded 摘要 / awaiting_answer 问题 / turn_failed 根因", async () => {
  const succeeded = okOutcome("F1", { round: 5, summary: "改造文档已落 doc/v0.9.2/" });
  await withServer(
    async (base) => {
      const res = await turnPost(base, { ...WRITE_HEADERS, accept: "text/html" });
      assert.equal(res.status, 200);
      assert.match(res.text, /本轮产出（摘要）/);
      assert.match(res.text, /改造文档已落 doc\/v0\.9\.2\//, "agent 的回答不得被 303 丢掉");
    },
    { outcomes: { trigger: succeeded } },
  );

  const awaiting = okOutcome("F1", {
    disposition: "awaiting_answer",
    state: "awaiting_answer",
    summary: null,
    question: "改造文档以哪个版本落？",
    display: "需要你回答",
  });
  await withServer(
    async (base) => {
      const res = await turnPost(base, { ...WRITE_HEADERS, accept: "text/html" });
      assert.equal(res.status, 200);
      assert.match(res.text, /要你回答的问题/);
      assert.match(res.text, /改造文档以哪个版本落？/);
    },
    { outcomes: { trigger: awaiting } },
  );

  const failed = okOutcome("F1", {
    ok: false,
    disposition: "turn_failed",
    state: "failed",
    summary: null,
    error: { code: "turn_failed", message: "后端 agent 未收敛" },
    display: "本轮失败",
  });
  await withServer(
    async (base) => {
      const res = await turnPost(base, { ...WRITE_HEADERS, accept: "text/html" });
      assert.equal(res.status, 502, "失败不伪装成 2xx，也不借 303 把根因藏掉");
      assert.match(res.text, /后端 agent 未收敛/);
    },
    { outcomes: { trigger: failed } },
  );
});

test("N7-页面 详情页轮次进度：在飞轮 ⇒「第 N 轮 在飞」；排队轮 ⇒ 队列位次", async () => {
  const running = {
    turnId: "turn-run",
    requirementId: "F1",
    org: "g",
    contextId: "ctx-1",
    round: 4,
    state: "running",
    queuedAt: "q",
    startedAt: "s",
  };
  await withServer(
    async (base, _c, faceCalls) => {
      const res = await req(base, "/features/F1");
      assert.equal(res.status, 200);
      assert.match(res.text, /轮次进度：<b>第 4 轮 在飞<\/b>/);
      assert.match(res.text, /<span class="mono">turn-run<\/span>/);
      assert.equal(faceCalls.queueView.length, 0, "在飞不查队列（没有位次可言）");
    },
    { outcomes: { busy: running } },
  );

  const waiting = {
    turnId: "turn-queue",
    requirementId: "F1",
    org: "g",
    contextId: "ctx-1",
    round: 2,
    state: "queued",
    queuedAt: "q",
    startedAt: null,
  };
  await withServer(
    async (base) => {
      const res = await req(base, "/features/F1");
      assert.match(res.text, /轮次进度：<b>第 2 轮 排队中 · 队列第 2 位<\/b>/);
    },
    {
      outcomes: {
        busy: waiting,
        queue: {
          org: "g",
          running: { turnId: "turn-other", requirementId: "F2", taskId: "t", startedAt: "s" },
          waiting: [
            { turnId: "turn-a", requirementId: "F3", queuedAt: "q1", display: "排队中" },
            { turnId: "turn-queue", requirementId: "F1", queuedAt: "q2", display: "排队中" },
          ],
          capacity: 1,
        },
      },
    },
  );
});

test("N7-页面（负向）无在飞 / 排队轮 ⇒ 不渲染进度行；队列面里查不到这条轮 ⇒ 不臆造位次", async () => {
  await withServer(async (base) => {
    const res = await req(base, "/features/F1");
    assert.doesNotMatch(res.text, /轮次进度：/);
  });

  const waiting = {
    turnId: "turn-gone",
    requirementId: "F1",
    org: "g",
    contextId: "ctx-1",
    round: 1,
    state: "queued",
    queuedAt: "q",
    startedAt: null,
  };
  await withServer(
    async (base) => {
      const res = await req(base, "/features/F1");
      assert.match(res.text, /轮次进度：<b>第 1 轮 排队中<\/b>/, "队列面没有它 ⇒ 只说排队中，不给位次");
      assert.doesNotMatch(res.text, /队列第/);
    },
    { outcomes: { busy: waiting } },
  );
});

