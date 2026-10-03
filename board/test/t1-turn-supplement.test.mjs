/**
 * v0.9.5 C2 用例（离线）：触发一轮的**可选补充文本**（补充口常驻）。
 *
 * 覆盖三条口径（改造文档 §2-C2）：
 * - ① `buildTurnPrompt` 把补充文本拼进本轮 prompt；空 / 缺省 ⇒ 逐字节等同既有纯触发提示词；
 * - ② `POST /features/:id/turn` 读 body 的 `supplement` 透传到宿主面触发口（同路由、不改 answer 路由）；
 * - ③ 该字段独立上限 8 KiB ⇒ 超限结构化 400 且**不触宿主面**；留空 = 纯触发合法。
 * - ④ **C6 锚对账**：动作区 turn 档渲染面真的出补充字段（textarea name=supplement · 无 maxlength）；
 *      确认档不出现该字段（与 trigger 分道）。
 *
 * 边界锚：`confirm` 通道是固定指令模板、表单无补充字段 ⇒ 不消费 supplement（与 trigger 分道）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createBoardServer } from "../dist/server.js";
import { buildTurnPrompt, buildConfirmPrompt } from "../dist/host-face.js";
import { TURN_FORM_SUPPLEMENT_FIELD } from "../dist/write-guard.js";
import { renderActionArea } from "../dist/web/views.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");

/** v0.9.5 C5：动作区入参（缺省 = 预审闲置档 ⇒ turn 通道）。 */
function actionInput(over = {}) {
  return { hostFaceAssembled: true, awaitingAnswer: false, approval: "未发起", state: "waiting_approval", ...over };
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
            stage: "改造方案",
            version: "v0.9.5",
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
    summary: "agent 已核对",
    question: null,
    error: null,
    bridge: null,
    ...over,
  };
}

function fakeFace() {
  const calls = { triggerTurn: [], confirmTurn: [] };
  const face = {
    async triggerTurn(input) {
      calls.triggerTurn.push(input);
      return okOutcome(input.featureId);
    },
    async confirmTurn(input) {
      calls.confirmTurn.push(input);
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

async function withServer(run, { feature, failFeature } = {}) {
  const { client } = fakeClient(feature ?? {});
  if (failFeature === true) client.getFeature = async () => {
    throw new Error("编排桥读面不可用（假）");
  };
  const { face, calls } = fakeFace();
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    defaultGroup: "g",
    hostFace: face,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, calls);
  } finally {
    await handle.close();
  }
}

async function req(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, options);
  return { status: res.status, text: await res.text() };
}

const WRITE_HEADERS = { "x-board-write": "1", accept: "application/json" };
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

// ---------------------------------------------------------------------------
// ① 纯函数：补充文本拼入
// ---------------------------------------------------------------------------

test("C2-① buildTurnPrompt：空 / 缺省 / 纯空白 supplement ⇒ 逐字节等同纯触发提示词", () => {
  const base = buildTurnPrompt({ featureId: "F1", org: "g" });
  assert.equal(buildTurnPrompt({ featureId: "F1", org: "g", supplement: "" }), base);
  assert.equal(buildTurnPrompt({ featureId: "F1", org: "g", supplement: "   " }), base);
  assert.equal(buildTurnPrompt({ featureId: "F1", org: "g", supplement: null }), base);
});

test("C2-② buildTurnPrompt：非空 supplement ⇒ 追加显式标注来源的补充块（保留用户原文）", () => {
  const p = buildTurnPrompt({ featureId: "F1", org: "g", supplement: " 方向应是 B 而不是 A " });
  assert.match(p, /【用户补充（本轮随附，来自板上补充口）】/);
  assert.match(p, /方向应是 B 而不是 A/);
  // §3.6 硬口径：提示词不硬编码任何 MCP 工具全名（补充块也不引入）
  for (const forbidden of ["a2a_feature_approve", "a2a_feature_advance", "a2a_feature_cancel"]) {
    assert.equal(p.includes(forbidden), false, `提示词不得出现工具全名 ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// ②③ HTTP：body.supplement → 宿主面触发口
// ---------------------------------------------------------------------------

test("C2-③ HTTP：POST turn 带 supplement ⇒ 透传到 triggerTurn（同路由读 body）", async () => {
  await withServer(async (base, calls) => {
    const body = new URLSearchParams({ supplement: " 用 v0.9.5 而不是 v0.9.4 " }).toString();
    const res = await req(base, "/features/F1/turn", { method: "POST", headers: { ...WRITE_HEADERS, ...FORM_HEADERS }, body });
    assert.equal(res.status, 200);
    assert.equal(calls.triggerTurn.length, 1);
    assert.equal(calls.triggerTurn[0].supplement, "用 v0.9.5 而不是 v0.9.4");
  });
});

test("C2-④ HTTP：POST turn 留空 ⇒ 纯触发合法（supplement = 空串，仍到达宿主面）", async () => {
  await withServer(async (base, calls) => {
    const res = await req(base, "/features/F1/turn", {
      method: "POST",
      headers: { ...WRITE_HEADERS, ...FORM_HEADERS },
      body: "",
    });
    assert.equal(res.status, 200);
    assert.equal(calls.triggerTurn.length, 1);
    assert.equal(calls.triggerTurn[0].supplement, "");
  });
});

test("C2-⑤ HTTP：POST turn supplement 超 8 KiB ⇒ 400 board_turn_supplement_too_large 且宿主面零调用", async () => {
  await withServer(async (base, calls) => {
    const body = new URLSearchParams({ supplement: "甲".repeat(8192) }).toString();
    const res = await req(base, "/features/F1/turn", { method: "POST", headers: { ...WRITE_HEADERS, ...FORM_HEADERS }, body });
    assert.equal(res.status, 400);
    const parsed = JSON.parse(res.text);
    assert.equal(parsed.code, "board_turn_supplement_too_large");
    assert.deepEqual(calls.triggerTurn, [], "超限不得触宿主面（不白烧一轮）");
  });
});

test("C2-⑥ HTTP：confirm 通道不消费 supplement（固定指令模板；入参不含该字段）", async () => {
  await withServer(async (base, calls) => {
    const res = await req(base, "/features/F1/confirm", {
      method: "POST",
      headers: { ...WRITE_HEADERS, ...FORM_HEADERS },
      body: new URLSearchParams({ supplement: "不应影响确认指令" }).toString(),
    });
    assert.equal(res.status, 200);
    assert.equal(calls.confirmTurn.length, 1);
    assert.equal("supplement" in calls.confirmTurn[0], false, "confirm 入参不含 supplement（固定模板）");
    assert.equal(buildConfirmPrompt({ featureId: "F1", org: "g" }).includes("用户补充"), false);
  });
});

test("C2-⑦ HTTP：桥读面失败 ⇒ 降级放行（补充文本照常透传；不得新增误挡）", async () => {
  await withServer(
    async (base, calls) => {
      const res = await req(base, "/features/F1/turn", {
        method: "POST",
        headers: { ...WRITE_HEADERS, ...FORM_HEADERS },
        body: new URLSearchParams({ supplement: "视情况定" }).toString(),
      });
      assert.equal(res.status, 200);
      assert.equal(calls.triggerTurn[0].supplement, "视情况定");
    },
    { failFeature: true },
  );
});

// ---------------------------------------------------------------------------
// ④ C6 锚对账：动作区 turn 档**渲染**出可选补充字段（与 HTTP / 纯函数用例互补）
// ---------------------------------------------------------------------------

test("C2-⑧ 页面：动作区 turn 档渲染可选补充字段（textarea name=supplement · 留空=纯触发）· 非监视态", () => {
  // 本锚语义边界（-04 §3⑥ 限定）：**非监视态下** turn 档出补充框（actionInput 缺省不带
  // chainMonitoring = 未接线/缺席 ⇒ fail-open 走原路径）；监视态 ⇒ 整块离场，见 ⑧b。
  // 字段名单点 = write-guard 常量（渲染面与服务端解析面同一事实源，防两处漂移）
  assert.equal(TURN_FORM_SUPPLEMENT_FIELD, "supplement");
  const html = renderActionArea("F1", actionInput());
  assert.match(html, new RegExp(`<textarea name="${TURN_FORM_SUPPLEMENT_FIELD}"`), "表单须含补充文本域");
  assert.match(html, /留空 = 只说「继续」/, "文案写明留空语义（= 纯触发）");
  assert.doesNotMatch(html, /maxlength/i, "不设前端 maxlength：超限失败交服务端结构化 400 收口（可见）");
  assert.match(html, /action="\/features\/F1\/turn"/, "turn 档仍发向既有路由");

  // 与 trigger 分道：确认档是固定指令模板，渲染面同样无补充字段
  assert.doesNotMatch(
    renderActionArea("F1", actionInput({ approval: "待审批" })),
    new RegExp(TURN_FORM_SUPPLEMENT_FIELD),
    "确认档不得出现补充字段（固定模板）",
  );
});

test("C2-⑧b 页面（-04 监视态负锚）：chainMonitoring=true ⇒ renderActionArea 空串（补充框随动作区整块离场）", () => {
  // 补充框嵌在 renderActionArea 内部 ⇒ derive 的监视中短路返 null 即无，无需单独执法（-04 §2.1）；
  // 本锚把「监视中 ⇒ 无补充框」钉死，防日后把补充框拆成独立区块绕过短路。
  assert.equal(renderActionArea("F1", actionInput({ chainMonitoring: true })), "", "turn 档监视态：整块空串");
  assert.equal(
    renderActionArea("F1", actionInput({ chainMonitoring: true, approval: "待审批" })),
    "",
    "确认档监视态：一并离场（不开例外，-04 §2.2）",
  );
  // fail-open 负锚：显式 false 与缺席同档（补充框照旧在场）
  assert.match(
    renderActionArea("F1", actionInput({ chainMonitoring: false })),
    new RegExp(`<textarea name="${TURN_FORM_SUPPLEMENT_FIELD}"`),
    "chainMonitoring=false ⇒ 补充框照旧在场",
  );
});
