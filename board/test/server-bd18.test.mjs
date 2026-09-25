/**
 * BD18 服务端用例（离线）：详情页可用性 —— **「确认」按钮按 `approval` 条件化**（禁用/灰态
 * + 原因，不隐藏）与**「下一步」引导行**逐态断言；负向：`approval = 未发起` 时确认按钮
 * 不可点且给出理由；宿主面未装配时不给 turn/confirm 入口并说明原因。
 * **只测渲染与可用性**：端点语义不变（confirm POST 仍原样经宿主面，由 agent 核对）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

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
            version: "v0.9.0",
            approval: "未发起",
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

/** 最小假宿主面：页面只触 `awaitingTurnOf` / `busyTurnOf`；`awaiting` / `busyTurn` 可控。 */
function fakeFace(awaiting = null, busyTurn = null) {
  return {
    awaitingTurnOf() {
      return awaiting;
    },
    busyTurnOf() {
      return busyTurn;
    },
    async triggerTurn(input) {
      return { ok: true, featureId: input.featureId };
    },
    async confirmTurn(input) {
      return { ok: true, featureId: input.featureId };
    },
    async answerRequirement(input) {
      return { ok: true, featureId: input.featureId };
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
}

async function withServer(run, { feature, hostFace } = {}) {
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: fakeClient(feature ?? {}).client,
    now: () => NOW,
    defaultGroup: "g",
    ...(hostFace === undefined ? { hostFace: fakeFace() } : hostFace === null ? {} : { hostFace }),
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

async function detail(base) {
  const res = await fetch(`${base}/features/F1`);
  return { status: res.status, text: await res.text() };
}

const CONFIRM_DISABLED = /<button type="submit" disabled aria-disabled="true">发送确认指令给 agent/;
const CONFIRM_ENABLED = /<button type="submit">发送确认指令给 agent/;

// ---------------------------------------------------------------------------
// approval 三态逐态断言（按钮可用性 + 提示文案）
// ---------------------------------------------------------------------------

test("BD18-页面（负向）：approval = 未发起 ⇒ 确认按钮禁用但入口不隐藏 + 原因「方案未就绪」+ 下一步指向「触发一轮」", async () => {
  await withServer(async (base) => {
    const { status, text } = await detail(base);
    assert.equal(status, 200);
    assert.match(text, /action="\/features\/F1\/confirm"/, "不得隐藏入口（看不见更迷惑）");
    assert.match(text, CONFIRM_DISABLED);
    assert.doesNotMatch(text, CONFIRM_ENABLED);
    assert.match(text, /方案未就绪（approval = 未发起）/);
    assert.match(text, /<p class="hint nextstep">下一步：点「触发一轮」/);
    assert.match(text, /<button type="submit">触发一轮<\/button>/, "触发一轮不受影响");
  }, { feature: { approval: "未发起" } });
});

test("BD18-页面：approval = 待审批 ⇒ 确认按钮可点 + 下一步「核对改造文档后点确认」", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, CONFIRM_ENABLED);
    assert.doesNotMatch(text, CONFIRM_DISABLED);
    assert.match(text, /审批门 = 待审批/);
    assert.match(text, /nextstep">下一步：核对改造文档后点「确认」/);
  }, { feature: { approval: "待审批", stage: "改造方案" } });
});

test("BD18-页面：approval = 已通过 ⇒ 确认按钮禁用（已放行无回边）+ 下一步指向引擎执行", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, CONFIRM_DISABLED);
    assert.match(text, /审批门已是「已通过」[^<]*无需再次确认/);
    assert.match(text, /nextstep">下一步：审批门已通过，引擎/);
  }, { feature: { approval: "已通过", state: "executing", stage: "改造" } });
});

// ---------------------------------------------------------------------------
// awaiting_answer 有/无 × 引导优先级
// ---------------------------------------------------------------------------

test("BD18-页面：存在 awaiting_answer 轮 ⇒ 引导行 = 回答（优先于 approval 分支），确认按钮仍按 approval 禁用", async () => {
  const awaiting = {
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
  };
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, /<p class="hint nextstep">下一步：回答上方问题/);
    assert.match(text, /action="\/features\/F1\/answer"/);
    assert.match(text, CONFIRM_DISABLED, "待澄清不改变确认按钮的 approval 判据");
  }, { feature: { approval: "未发起" }, hostFace: fakeFace(awaiting) });
});

test("BD18-页面：无 awaiting 轮 ⇒ 不显示回答框，引导行走 approval 分支（对照锚）", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.equal(text.includes('action="/features/F1/answer"'), false);
    assert.match(text, /nextstep">下一步：点「触发一轮」/);
  }, { feature: { approval: "未发起" } });
});

// ---------------------------------------------------------------------------
// 宿主面未装配（负向：不给 turn/confirm 入口并说明原因）
// ---------------------------------------------------------------------------

test("BD18-页面（负向）：宿主面未装配 ⇒ 无触发一轮/确认入口 + 明示「宿主面未装配，需先配 orgsDir」", async () => {
  await withServer(async (base) => {
    const { status, text } = await detail(base);
    assert.equal(status, 200, "只缺引导，页面其余只读面不坏");
    assert.equal(text.includes('/features/F1/turn'), false, "未装配不得出现 turn 入口");
    assert.equal(text.includes('/features/F1/confirm'), false, "未装配不得出现 confirm 入口");
    assert.match(text, /<p class="hint nextstep">下一步：宿主面未装配/);
    assert.match(text, /需先在 config.json 配 orgsDir/);
  }, { hostFace: null });
});

// ---------------------------------------------------------------------------
// 收口轨 14 ②：详情页写按钮叠加「轮占用」判据（在飞 / 排队 ⇒ disabled + 原因）
// ---------------------------------------------------------------------------

const TURN_BUTTON_DISABLED = /<button type="submit" disabled aria-disabled="true">触发一轮/;
const TURN_BUTTON_ENABLED = /<button type="submit">触发一轮<\/button>/;

const BUSY_RUNNING = {
  turnId: "turn-run",
  requirementId: "F1",
  org: "g",
  contextId: "ctx-1",
  round: 2,
  state: "running",
  queuedAt: "q",
  startedAt: "s",
};

test("轨14-页面（负向）在飞轮占用 ⇒ 「触发一轮」也禁用（原先只有 confirm 判）+ 原因含轮次与轮 id", async () => {
  await withServer(async (base) => {
    const { status, text } = await detail(base);
    assert.equal(status, 200);
    assert.match(text, TURN_BUTTON_DISABLED);
    assert.doesNotMatch(text, TURN_BUTTON_ENABLED);
    assert.match(text, /本轮进行中（第 2 轮 · turn-run）/);
    assert.match(text, /action="\/features\/F1\/turn"/, "入口不隐藏（看不见更迷惑）");
    assert.match(text, CONFIRM_DISABLED, "同一占用判据同样挡确认入口");
    assert.match(text, /本轮进行中/, "confirm 的原因行显示占用（优先于 approval 判据）");
  }, { feature: { approval: "待审批" }, hostFace: fakeFace(null, BUSY_RUNNING) });
});

test("轨14-页面：排队轮占用 ⇒ 文案说「排队中」，与在飞可分辨", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, /本轮排队中（第 2 轮 · turn-run）/);
    assert.doesNotMatch(text, /本轮进行中/);
    assert.match(text, TURN_BUTTON_DISABLED);
  }, { feature: { approval: "待审批" }, hostFace: fakeFace(null, { ...BUSY_RUNNING, state: "queued", startedAt: null }) });
});

test("轨14-页面（正向锚）无占用轮 ⇒ 两按钮回到各自既有判据（approval 档不受本轨影响）", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, TURN_BUTTON_ENABLED);
    assert.match(text, CONFIRM_ENABLED);
    assert.doesNotMatch(text, /本轮进行中|本轮排队中/);
  }, { feature: { approval: "待审批" } });
});

test("轨14-页面：awaiting_answer 轮不算占用 ⇒ 触发一轮仍可点（否则澄清链路被锁死）", async () => {
  const awaiting = {
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
  };
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, TURN_BUTTON_ENABLED, "等人回答不占闸位 ⇒ 按钮不锁");
    assert.match(text, /action="\/features\/F1\/answer"/);
  }, { feature: { approval: "待审批" }, hostFace: fakeFace(awaiting, null) });
});

// ---------------------------------------------------------------------------
// 收口轨 14 ①：写表单的提交守卫（内联脚本 + data-submit 文案）落在页面上
// ---------------------------------------------------------------------------

test("轨14-页面：写表单带 data-submit 就地反馈文案 + 页面含一段内联提交守卫（无外源脚本）", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, /action="\/features\/F1\/turn"[^>]*data-submit="已提交，本轮可能跑数分钟…"/);
    assert.match(text, /action="\/features\/F1\/confirm"[^>]*data-submit="已提交，处理中…"/);
    assert.match(text, /<script>/);
    assert.doesNotMatch(text, /<script[^>]*src=/, "不得引入外源脚本");
    assert.match(text, /querySelectorAll\("button\[type=submit\]"\)/, "守卫的落点 = 禁用提交按钮");
  });
});

// ---------------------------------------------------------------------------
// 收口轨 17：引擎终态需求 ⇒「触发一轮 / 发送确认指令」渲染禁用（服务端 409 已由轨 16 ③ 钉）
// ---------------------------------------------------------------------------

for (const [terminalState, note] of [
  ["completed", "本需求已完成（引擎态 completed），板上无需再操作"],
  ["cancelled", "本需求已取消（终态），板上无需再操作"],
  ["failed", "本需求已进入失败终态，板上无需再操作"],
]) {
  test(`轨17-页面（负向）引擎态 ${terminalState} ⇒ 两按钮 disabled + 原因行「${note.slice(0, 12)}…」`, async () => {
    await withServer(async (base) => {
      const { status, text } = await detail(base);
      assert.equal(status, 200);
      assert.match(text, TURN_BUTTON_DISABLED);
      assert.doesNotMatch(text, TURN_BUTTON_ENABLED);
      assert.match(text, CONFIRM_DISABLED);
      assert.doesNotMatch(text, CONFIRM_ENABLED);
      assert.match(text, new RegExp(note.replace(/[（）]/g, "[（）]")), "原因行含终态文案");
      assert.equal((text.match(new RegExp(note.slice(0, 6), "g")) ?? []).length >= 2, true, "两表单各一行原因");
      assert.match(text, /action="\/features\/F1\/turn"/, "入口不隐藏（看不见更迷惑）");
      assert.match(text, /action="\/features\/F1\/confirm"/);
      assert.doesNotMatch(text, /审批门 = 待审批/, "终态时不再展示 approval 那条原因");
    }, { feature: { state: terminalState, approval: "待审批" } });
  });
}

test("轨17-页面：终态判据优先于轮占用（终态需求的陈旧占用台账不再解释按钮）", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, TURN_BUTTON_DISABLED);
    assert.match(text, CONFIRM_DISABLED);
    assert.match(text, /本需求已完成（引擎态 completed）/);
    assert.doesNotMatch(text, /本轮进行中/, "终态原因覆盖占用原因");
  }, { feature: { state: "completed", approval: "待审批" }, hostFace: fakeFace(null, BUSY_RUNNING) });
});

test("轨17-页面（正向锚）非终态 + 未知态 ⇒ 两按钮回到既有判据，不出现终态原因行", async () => {
  for (const state of ["executing", "some-future-state"]) {
    await withServer(async (base) => {
      const { text } = await detail(base);
      assert.match(text, TURN_BUTTON_ENABLED, `${state} 非终态 ⇒ 触发一轮可点`);
      assert.match(text, CONFIRM_ENABLED, `${state} 非终态 ⇒ 确认可点（approval = 待审批）`);
      assert.doesNotMatch(text, /板上无需再操作/, `${state} 不得套终态文案`);
    }, { feature: { state, approval: "待审批" } });
  }
});
