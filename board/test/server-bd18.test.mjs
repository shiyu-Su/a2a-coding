/**
 * BD18 服务端用例（离线）：详情页可用性 —— **v0.9.5 C5 档位化改写**。
 *
 * **定向推翻记录（用户裁定 2026-09-29，改造文档 §2 C5）**：BD18 原口径「确认按钮恒显示、仅按
 * `approval` 置灰 + 原因（不隐藏：看不到入口更迷惑）」与收口轨 14 ② / 17 的「灰态按钮 + 原因行」
 * 一并改为**按档位收合** —— 「确认改造文档 → 放行执行」只在 `approval = 待审批` 出现；
 * 终态 / 宿主面未装配 ⇒ **整个动作区不渲染**（墓碑档）；轮占用仍渲染但 disabled + 原因。
 * 「触发一轮」这一底层机制词从 UI 消失（本文件页级负锚钉住）。
 *
 * **不变的判据（不得弱化）**：① 服务端 409 硬闸一条未减（`board_turn_busy` / `board_feature_terminal`
 * 由轨 16 ③ 与写面用例钉，本文件只测显示）；② 写路由一对一（`/turn` 与 `/confirm`）不变；
 * ③ 档位规则源在 `derive.ts`（本文件断言**页面真的按那张档位表渲染**）；④ 内联提交守卫 +
 * data-submit 就地反馈仍在位（无外源脚本）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

function fakeClient(featureOver = {}, traceReturn = undefined, tasksReturn = []) {
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
          tasks: tasksReturn,
        };
      },
      async getFeatureTrace(featureId) {
        if (traceReturn !== undefined) return traceReturn;
        throw new Error(`trace 不可用：${featureId}`);
      },      async getProjects() {
        throw new Error("不该被本文件触达");
      },
      async getTasks() {
        throw new Error("不该被本文件触达");
      },
    },
  };
}

/**
 * 最小假宿主面：详情页只触 `awaitingTurnOf` / `busyTurnOf` / `latestTurnOf`（C6 留痕行）与
 * `chainSnapshotOf`（REQ-2026-09-30-04 监视档）；前四者可控，缺省全空 ⇒ 页面无在飞轮、无待澄清、
 * 无历史轮次、无链快照。
 *
 * **`chainSnapshotOf` 注入档（04 §3⑥）**：第四参 `chainSnapshot` 三态区分 ——
 * - `undefined`（缺省）⇒ **假面不实现该方法**（服务端 `hostChainSnapshotOf` try/catch 兜成 null）
 *   = fail-open 负锚的注入点（-04 页级：动作区照旧在场）；
 * - `null` ⇒ 方法在场但返回 null（宿主面无链知识，快照缺席）；
 * - 对象 ⇒ 直接透传（构造监视 / 停链两档）。
 */
function fakeFace(awaiting = null, busyTurn = null, latest = null, chainSnapshot = undefined) {
  const face = {
    awaitingTurnOf() {
      return awaiting;
    },
    busyTurnOf() {
      return busyTurn;
    },
    latestTurnOf() {
      return latest;
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
  if (chainSnapshot !== undefined) {
    face.chainSnapshotOf = () => chainSnapshot;
  }
  return face;
}

async function withServer(run, { feature, hostFace, trace, tasks } = {}) {
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: fakeClient(feature ?? {}, trace, tasks ?? []).client,
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

/**
 * 详情页的**动作区块**（`<h2>动作</h2>` 起、至第一个折叠区〔阶段产出〕止 = 动作区 + 回答框）；
 * 无动作区（终态 / 宿主面未装配）⇒ `null`。按钮可用性断言一律在本块内做 —— 整页文本里
 * 「disabled」还会命中样式表与内联守卫脚本，拿整页断言等于没断。
 */
function actionBlock(text) {
  const start = text.indexOf("<h2>动作</h2>");
  if (start < 0) return null;
  const rest = text.slice(start);
  const end = rest.indexOf('<details class="fold"');
  return end < 0 ? rest : rest.slice(0, end);
}

// 档位按钮的确切形状（可点 / 低调 / 禁用）—— 与 `renderActionArea` 的渲染式一一对应。
const CONFIRM_TIER = /<button type="submit">确认改造文档 → 放行执行<\/button>/;
const IDLE_TIER = /<button type="submit">让 agent 继续<\/button>/;
const IDLE_TIER_QUIET = /<button type="submit" class="quiet">让 agent 继续<\/button>/;
const SUBMIT_TIER = /<button type="submit">提交给 agent<\/button>/;
const CONFIRM_DISABLED =
  /<button type="submit" disabled aria-disabled="true">确认改造文档 → 放行执行<\/button>/;
const IDLE_DISABLED = /<button type="submit" disabled aria-disabled="true">让 agent 继续<\/button>/;

// ---------------------------------------------------------------------------
// approval 三态逐态断言（档位 + 引导行文案）
// ---------------------------------------------------------------------------

test("C5-页面（原「禁用不隐藏」定向推翻）：approval = 未发起 ⇒ 不出确认块 · 出可点闲置档 + 补充框", async () => {
  await withServer(async (base) => {
    const { status, text } = await detail(base);
    assert.equal(status, 200);
    assert.equal(text.includes('/features/F1/confirm'), false, "非确认门不得渲染确认块");
    assert.match(text, /<h2>动作<\/h2>/, "动作区本体在（换档不换区）");
    assert.match(text, /action="\/features\/F1\/turn"/);
    assert.match(text, IDLE_TIER);
    assert.doesNotMatch(actionBlock(text), /disabled/, "闲置档不是灰态");
    assert.match(text, /<textarea name="supplement"/, "turn 档带补充框");
    assert.match(text, /<p class="hint nextstep">下一步：等你 —— 本卡尚无产出 ⇒ 点「让 agent 继续」/);
    assert.doesNotMatch(text, /方案未就绪/, "旧灰态原因行随 BD18 一并退役");
  }, { feature: { approval: "未发起" } });
});

test("C5-页面：approval = 待审批 ⇒ 唯一出现确认档（可点 · 去向 confirm · 无补充框）+ 引导行点名放行档位", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, CONFIRM_TIER);
    assert.doesNotMatch(actionBlock(text), /disabled/, "待审批档不得出现 disabled");
    assert.match(text, /action="\/features\/F1\/confirm"/);
    assert.doesNotMatch(text, /name="supplement"/, "确认档走固定指令模板通道");
    assert.match(text, /<p class="hint nextstep">下一步：等你 —— 改造文档已落文件 ⇒ 核对后点「确认改造文档 → 放行执行」/);
  }, { feature: { approval: "待审批", stage: "改造方案" } });
});

test("C5-页面：approval = 已通过 + executing ⇒ 无确认块 · 兜底档低调（quiet）+ 引导行指向引擎接力", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.equal(text.includes('/features/F1/confirm'), false, "审批门单向无回边 ⇒ 不再出确认入口");
    assert.match(text, IDLE_TIER_QUIET, "执行中的手动入口低调保留（卡滞兜底，永久在位）");
    assert.doesNotMatch(actionBlock(text), /disabled/, "兜底档是可点的低调档，不是灰态");
    assert.match(text, /审批门已通过，引擎按 DAG 自动接力/);
  }, { feature: { approval: "已通过", state: "executing", stage: "改造" } });
});

// ---------------------------------------------------------------------------
// awaiting_answer 有/无 × 引导优先级
// ---------------------------------------------------------------------------

const AWAITING = {
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

test("C5/REQ-03-页面：存在 awaiting_answer 轮 ⇒ 引导行 = 回答（优先于 approval 分支）· 澄清框在场 · 动作区不出 DOM（输入面互斥）", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, /<p class="hint nextstep">下一步：等你回答上方问题/);
    assert.match(text, /action="\/features\/F1\/answer"/, "awaiting ⇒ 澄清框在场");
    assert.equal(text.includes("<h2>动作</h2>"), false, "REQ-03 互斥：awaiting 时动作区不出 DOM（非隐藏）");
    assert.equal(text.includes('/features/F1/confirm'), false, "未发起仍不出确认块");
  }, { feature: { approval: "未发起" }, hostFace: fakeFace(AWAITING) });
});

test("C5-页面：无 awaiting 轮 ⇒ 不显示回答框，引导行走 approval 分支（对照锚）", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.equal(text.includes('action="/features/F1/answer"'), false);
    assert.match(text, /nextstep">下一步：等你 —— 本卡尚无产出 ⇒ 点「让 agent 继续」/);
  }, { feature: { approval: "未发起" } });
});

// ---------------------------------------------------------------------------
// 宿主面未装配（负向：不给任何动作入口并说明原因）
// ---------------------------------------------------------------------------

test("C5-页面（负向）：宿主面未装配 ⇒ 动作区整体不渲染 + 明示「宿主面未装配，需先配 orgsDir」", async () => {
  await withServer(async (base) => {
    const { status, text } = await detail(base);
    assert.equal(status, 200, "只缺动作区，页面其余只读面不坏");
    assert.equal(text.includes('/features/F1/turn'), false, "未装配不得出现 turn 入口");
    assert.equal(text.includes('/features/F1/confirm'), false, "未装配不得出现 confirm 入口");
    assert.equal(text.includes("<h2>动作</h2>"), false, "未装配 ⇒ 整区不渲染（不再摆灰按钮）");
    assert.match(text, /<p class="hint nextstep">下一步：宿主面未装配/);
    assert.match(text, /需先在 config.json 配 orgsDir/);
  }, { hostFace: null });
});

// ---------------------------------------------------------------------------
// 收口轨 14 ② → C5：轮占用 = 当前档 disabled + 原因（不换档、不撤入口）
// ---------------------------------------------------------------------------

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

test("轨14-页面（负向）在飞轮占用 ⇒ 当前档按钮 disabled + 原因含轮次与轮 id · 入口不隐藏", async () => {
  await withServer(async (base) => {
    const { status, text } = await detail(base);
    assert.equal(status, 200);
    assert.match(text, CONFIRM_DISABLED, "占用只把当前档置灰，不改档");
    assert.doesNotMatch(text, CONFIRM_TIER);
    assert.match(text, /本轮进行中（第 2 轮 · turn-run）/);
    assert.match(text, /action="\/features\/F1\/confirm"/, "占用期的入口必须可见（点了会白点 ⇒ 灰 + 原因）");
    assert.equal(text.includes('action="/features/F1/turn"'), false, "确认门期不出 turn 表单（一区一档）");
  }, { feature: { approval: "待审批" }, hostFace: fakeFace(null, BUSY_RUNNING) });
});

test("轨14-页面：排队轮占用 ⇒ 文案说「排队中」，与在飞可分辨", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, /本轮排队中（第 2 轮 · turn-run）/);
    assert.doesNotMatch(text, /本轮进行中/);
    assert.match(text, CONFIRM_DISABLED);
  }, { feature: { approval: "待审批" }, hostFace: fakeFace(null, { ...BUSY_RUNNING, state: "queued", startedAt: null }) });
});

test("轨14-页面（正向锚）无占用轮 ⇒ 档位回到 approval 判据，不出现占用原因行", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, CONFIRM_TIER);
    assert.doesNotMatch(actionBlock(text), /disabled/, "无占用 ⇒ 档位可点");
    assert.doesNotMatch(text, /本轮进行中|本轮排队中/);
  }, { feature: { approval: "待审批" } });
});

test("轨14/REQ-03-页面：awaiting_answer 轮不算占用（busy 闸内核不丢）· 澄清框在场（澄清链路不锁死）· 动作区不出 DOM（互斥）", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    // busy 闸内核（原「按钮仍可点」在新形态下的等价断言）：awaiting 轮不得被当作出占用 / 在飞 / 排队
    assert.doesNotMatch(text, /本轮进行中|本轮排队中/, "awaiting 轮不占 busy 闸 ⇒ 不出占用文案");
    assert.doesNotMatch(text, CONFIRM_DISABLED, "awaiting 轮不得把确认档渲染成 disabled 占用态");
    assert.doesNotMatch(text, IDLE_DISABLED, "awaiting 轮不得把闲置档渲染成 disabled 占用态");
    // 澄清链路不锁死：输入面 = 澄清框在场且可用
    assert.match(text, /action="\/features\/F1\/answer"/, "澄清框在场 = 澄清链路未被锁死");
    // REQ-03 输入面互斥正向：存在 awaiting 轮 ⇒ 页面无 <h2>动作</h2>
    assert.equal(text.includes("<h2>动作</h2>"), false, "awaiting ⇒ 动作区不出 DOM");
  }, { feature: { approval: "待审批" }, hostFace: fakeFace(AWAITING, null) });
});

// ---------------------------------------------------------------------------
// REQ-2026-09-30-03：输入面互斥（动作区 ↔ 澄清框恒为一个）+ 件B 轮询锚防回归
// ---------------------------------------------------------------------------

test("REQ-03-页面（输入面互斥 · 恰一为真）：awaiting ⇒ 只出澄清框；无 awaiting ⇒ 只出动作区", async () => {
  const faces = (t) => [t.includes("<h2>动作</h2>"), t.includes('action="/features/F1/answer"')];
  await withServer(async (base) => {
    const { text } = await detail(base);
    const [action, answer] = faces(text);
    assert.equal(action, false, "awaiting ⇒ 动作区不出 DOM");
    assert.equal(answer, true, "awaiting ⇒ 澄清框在场");
    assert.notEqual(action, answer, "两输入面恰一为真");
  }, { feature: { approval: "待审批" }, hostFace: fakeFace(AWAITING, null) });
  await withServer(async (base) => {
    const { text } = await detail(base);
    const [action, answer] = faces(text);
    assert.equal(action, true, "无 awaiting ⇒ 动作区在场");
    assert.equal(answer, false, "无 awaiting ⇒ 澄清框不出 DOM");
    assert.notEqual(action, answer, "两输入面恰一为真");
  }, { feature: { approval: "待审批" }, hostFace: fakeFace(null, null) });
});

test("REQ-03-页面（件B 轮询锚防回归）：awaiting 态提交后仍在飞 ⇒ .turn-progress 留在 main 且在互斥尾部之外", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    const mainStart = text.indexOf("<main>");
    const mainEnd = text.indexOf("</main>");
    assert.ok(mainStart >= 0 && mainEnd > mainStart, "详情页有 <main>");
    const tp = text.indexOf('class="hint turn-progress"');
    assert.ok(tp > mainStart && tp < mainEnd, ".turn-progress 在 main 内（件B 收口判据锚不丢）");
    // 互斥尾部 = 动作区 / 澄清框；turn-progress 须在其之前（不被收进 terminal-gated 互斥分支）
    const answerPos = text.indexOf('action="/features/F1/answer"');
    assert.ok(answerPos >= 0 && tp < answerPos, "turn-progress 出现在澄清框（互斥尾部）之外/之前");
    assert.equal(text.includes("<h2>动作</h2>"), false, "awaiting ⇒ 动作区缺席，但 turn-progress 仍在");
  }, { feature: { approval: "待审批" }, hostFace: fakeFace(AWAITING, BUSY_RUNNING) });
});

// ---------------------------------------------------------------------------
// REQ-2026-09-30-04：监视中短路的页级断言（chainSnapshotOf 注入档 + fail-open 负锚）
// ---------------------------------------------------------------------------

test("04-页面（监视中短路 · 假面注入 monitoring）：无动作区 DOM ∧ 无补充框 ∧ 停链表单在场 ∧ 引导行落监视档", async () => {
  const snap = { chainState: "monitoring", reason: null, source: null, pendingCount: 2 };
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.equal(text.includes("<h2>动作</h2>"), false, "监视中 ⇒ 动作区不出 DOM（renderActionArea 返空串）");
    assert.equal(text.includes('name="supplement"'), false, "补充框在 renderActionArea 内部 ⇒ 随动作区整块离场");
    assert.match(text, /链状态：<b>监视中<\/b>（等 2 个子任务）/, "快照事实如实渲染（含 pendingCount）");
    assert.match(text, /<form method="post" action="\/features\/F1\/stop-chain"/, "停链表单在场 = 插话逃生门");
    assert.match(text, /<button type="submit"[^>]*>停链/, "按钮文案在场（引导行指路的对象必须真在场）");
    assert.match(text, /<p class="hint nextstep">下一步：链监视中（等 2 个子任务回传）/, "引导行落监视档");
    assert.match(text, /动作区与提交口暂时退场/, "交代审批门/提交口退场（待审批组合一并说明）");
    assert.match(text, /要插话请点本页链状态行的「停链」按钮/, "指路唯一在场入口");
    assert.doesNotMatch(text, /<p class="hint nextstep">[^<]*自动接力/, "监视档不预测唤醒时机（不留第二套「等不等唤醒」口径）");
  }, { feature: { approval: "已通过", state: "executing", stage: "改造" }, hostFace: fakeFace(null, null, null, snap) });
});

test("04-页面（待审批不开例外 · 页级）：monitoring ∧ approval=待审批 ⇒ 确认档一并退场，唯一入口 = 停链", async () => {
  const snap = { chainState: "monitoring", reason: null, source: null, pendingCount: 1 };
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.equal(text.includes("<h2>动作</h2>"), false, "监视优先于 approval 三态：确认档一并退场");
    assert.equal(text.includes("/features/F1/confirm"), false, "确认块不得渲染（无后门可点）");
    assert.match(text, /action="\/features\/F1\/stop-chain"/, "唯一在场入口 = 停链");
    assert.match(text, /<p class="hint nextstep">下一步：链监视中/, "引导行仍是监视档（不出待审批确认文案）");
    assert.doesNotMatch(text, /核对后点「确认改造文档/, "待审批档文案被监视档遮蔽");
  }, { feature: { approval: "待审批", state: "waiting_approval", stage: "改造方案" }, hostFace: fakeFace(null, null, null, snap) });
});

test("04-页面（fail-open 负锚 · 假面未实现 chainSnapshotOf）：方法缺席 ⇒ 服务端兜 null ⇒ 动作区照旧在场（缺省语义锁在页面层）", async () => {
  await withServer(async (base) => {
    const { status, text } = await detail(base);
    assert.equal(status, 200, "假面缺方法不得带崩详情页（hostChainSnapshotOf try/catch 兜 null）");
    assert.match(text, /<h2>动作<\/h2>/, "快照读不到 ⇒ fail-open：动作区照旧在场（未接线调用方不回归）");
    assert.match(text, /<textarea name="supplement"/, "补充框照旧在场");
    assert.doesNotMatch(text, /action="\/features\/F1\/stop-chain"/, "非监视档 ⇒ 停链表单不出");
    assert.doesNotMatch(text, /链状态：/, "快照缺席 ⇒ 整行不渲染");
    assert.match(text, /<p class="hint nextstep">[^<]*审批门已通过/, "引导行落回 approval 三态（照旧，非监视档）");
  }, { feature: { approval: "已通过", state: "executing", stage: "改造" }, hostFace: fakeFace() });
});

test("04-页面（fail-open 负锚 · 方法在场但返回 null）：宿主面无链知识同样兜 null ⇒ 动作区照旧在场", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, /<h2>动作<\/h2>/, "chainSnapshotOf() → null 与缺席同档：fail-open");
    assert.doesNotMatch(text, /action="\/features\/F1\/stop-chain"/);
    assert.doesNotMatch(text, /链状态：/);
  }, { feature: { approval: "已通过", state: "executing", stage: "改造" }, hostFace: fakeFace(null, null, null, null) });
});

test("04-页面（stopped 快照档 · 非监视）：链状态行「链已停」在场 ∧ 无停链表单 ∧ 动作区照旧在场（球已回用户）", async () => {
  const snap = { chainState: "stopped", reason: "用户经链状态行「停链」· 该需求无在飞 / 排队轮", source: "user", pendingCount: null };
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, /链状态：<b>链已停<\/b>/, "停链档仍渲染链状态行");
    assert.doesNotMatch(text, /action="\/features\/F1\/stop-chain"/, "已停 ⇒ 无「再停一次」入口");
    assert.match(text, /<h2>动作<\/h2>/, "chainMonitoring=false ⇒ 短路不触发，动作区回来（球在用户手里的读面）");
  }, { feature: { approval: "已通过", state: "executing", stage: "改造" }, hostFace: fakeFace(null, null, null, snap) });
});

test("04-页面（监视 ∧ awaiting 优先序）：-03 锚不翻 · awaiting 短路排前 ⇒ 澄清框在场 + 停链表单并存", async () => {
  const snap = { chainState: "monitoring", reason: null, source: null, pendingCount: 4 };
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.equal(text.includes("<h2>动作</h2>"), false, "两条短路任一命中都撤动作区");
    assert.match(text, /action="\/features\/F1\/answer"/, "awaiting ⇒ 澄清框在场（球在你手里 = 回答）");
    assert.match(text, /action="\/features\/F1\/stop-chain"/, "停链表单同页在场（快照监视中）");
    assert.match(text, /<p class="hint nextstep">下一步：等你回答上方问题/, "引导行判序 awaiting > 监视中");
    assert.doesNotMatch(text, /<p class="hint nextstep">[^<]*链监视中/, "监视档文案被 awaiting 档遮蔽");
    // 05 增补：链状态行同步感知 awaiting（消除「等你回答」引导行 vs 「监视中」链状态行同页矛盾）
    assert.match(text, /链状态：<b>等你回答<\/b>（等 4 个子任务）/, "组合态链状态行换档标签、计数子串照旧");
    assert.doesNotMatch(text, /链状态：<b>监视中<\/b>/, "组合态页面上「监视中」档位标签离场");
  }, { feature: { approval: "待审批", state: "waiting_approval", stage: "改造方案" }, hostFace: fakeFace(AWAITING, null, null, snap) });
});

// ---------------------------------------------------------------------------
// 收口轨 14 ①：写表单的提交守卫（内联脚本 + data-submit 文案）落在页面上
// ---------------------------------------------------------------------------

test("轨14-页面：写表单带 data-submit 就地反馈文案 + 页面含一段内联提交守卫（无外源脚本）", async () => {
  // 一区一档 ⇒ 两条通道的 data-submit 分两页各钉一次（档位不同，路由不变）。
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, /action="\/features\/F1\/turn"[^>]*data-submit="已提交，本轮可能跑数分钟…"/);
    assert.match(text, /<script>/);
    assert.doesNotMatch(text, /<script[^>]*src=/, "不得引入外源脚本");
    assert.match(text, /querySelectorAll\("button\[type=submit\]"\)/, "守卫的落点 = 禁用提交按钮");
  }, { feature: { approval: "未发起" } });
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, /action="\/features\/F1\/confirm"[^>]*data-submit="已提交，处理中…"/);
  }, { feature: { approval: "待审批", stage: "改造方案" } });
});

// ---------------------------------------------------------------------------
// 收口轨 17 → C5 墓碑：引擎终态 ⇒ 动作区整体不渲染，终态事实由引导行一行承载
// ---------------------------------------------------------------------------

for (const [terminalState, note] of [
  ["completed", "本需求已完成（引擎态 completed），板上无需再操作"],
  ["cancelled", "本需求已取消（终态），板上无需再操作"],
  ["failed", "本需求已进入失败终态，板上无需再操作"],
]) {
  test(`轨17-页面（C5 墓碑）引擎态 ${terminalState} ⇒ 动作区不渲染（原两枚灰态按钮退役）+ 一行终态摘要`, async () => {
    await withServer(async (base) => {
      const { status, text } = await detail(base);
      assert.equal(status, 200);
      assert.equal(text.includes("/features/F1/turn"), false, "终态不得留 turn 入口");
      assert.equal(text.includes("/features/F1/confirm"), false, "终态不得留 confirm 入口");
      assert.equal(actionBlock(text), null, "终态 = 墓碑，无操作区");
      assert.doesNotMatch(text, /<button[^>]*aria-disabled/, "终态不再摆灰按钮");
      assert.match(text, new RegExp(`<p class="hint nextstep">${note}`), "一行终态摘要（引导位）");
      assert.equal(text.includes('action="/features/F1/answer"'), false, "终态不渲染回答框");
    }, { feature: { state: terminalState, approval: "待审批" } });
  });
}

test("轨17-页面：终态判据优先于轮占用（终态需求的陈旧占用台账不再解释按钮）", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.equal(text.includes("<h2>动作</h2>"), false, "终态 ⇒ 整区不渲染");
    assert.match(text, /本需求已完成（引擎态 completed）/);
    assert.doesNotMatch(text, /本轮进行中/, "终态原因覆盖占用原因");
  }, { feature: { state: "completed", approval: "待审批" }, hostFace: fakeFace(null, BUSY_RUNNING) });
});

test("轨17-页面（正向锚）非终态 + 未知态 ⇒ 动作区回到档位判据，不出现终态摘要", async () => {
  for (const state of ["executing", "some-future-state"]) {
    await withServer(async (base) => {
      const { text } = await detail(base);
      assert.match(text, /<h2>动作<\/h2>/, `${state} 非终态 ⇒ 动作区在位`);
      assert.match(text, CONFIRM_TIER, `${state} 非终态 + 待审批 ⇒ 出确认档（可点）`);
      assert.doesNotMatch(text, /板上无需再操作/, `${state} 不得套终态文案`);
    }, { feature: { state, approval: "待审批" } });
  }
});

// ---------------------------------------------------------------------------
// C5 页级负锚：底层机制词「触发一轮」整页零出现（按钮文案是意图，不是机制）
// ---------------------------------------------------------------------------

test("C5-页面（负锚）任何档位的详情页都不出现「触发一轮」字样", async () => {
  for (const feature of [
    { approval: "未发起" },
    { approval: "待审批", stage: "改造方案" },
    { approval: "已通过", state: "executing", stage: "改造" },
    { approval: "已通过", state: "reviewing", stage: "改造" },
    { approval: "已通过", state: "completed", stage: "发版" },
  ]) {
    await withServer(async (base) => {
      const { status, text } = await detail(base);
      assert.equal(status, 200);
      assert.doesNotMatch(text, /触发一轮/, `${feature.approval}/${feature.state ?? "waiting_approval"} 档`);
    }, { feature });
  }
});

// ---------------------------------------------------------------------------
// C4 页级（① 只允许一层折叠）：需求原文 = 主栏折叠层首节（默认收起，正文直显全文）
// ---------------------------------------------------------------------------

test("C4-页面：桥详情出参含 requirement ⇒ 需求原文在外层折叠层内直显全文；缺字段 ⇒ 整区不渲染", async () => {
  const long = "板「标记 released」的闸判据对曾有取消轨的版本永久失真：".repeat(6);
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(
      text,
      /<details class="fold"><summary>需求原文<\/summary>[\s\S]*?<h2>需求原文<\/h2>/,
      "件2：需求原文进主栏折叠层（默认收起），区内标题仍在场",
    );
    // 负钉抬为**区域结构**口径（不钉类名字面量 ⇒ 改版后不转恒真）：原文区内 `<details` 计数 = 1
    const originHead = '<details class="fold"><summary>需求原文</summary>';
    const originStart = text.indexOf(originHead);
    assert.ok(originStart >= 0, "原文正文落在外层折叠层内");
    const nextFold = text.indexOf('<details class="fold">', originStart + originHead.length);
    const sideStart = text.indexOf('<div class="feat-side">');
    assert.ok(originStart < sideStart, "原文块在主栏内（侧栏之前）");
    const originRegion = text.slice(originStart, nextFold >= 0 ? nextFold : sideStart);
    assert.equal(originRegion.split("<details").length - 1, 1, "原文区只允许一层折叠（内层折叠已摘）");
    assert.ok(
      originRegion.indexOf("</summary>") < originRegion.indexOf('<pre class="result">'),
      "序判据保留：外层折叠的 summary 早于正文",
    );
    assert.ok(
      originRegion.indexOf('<h2>需求原文</h2>\n<pre class="result">') > 0,
      "原文折叠体内 = 直显全文的 <pre>",
    );
    assert.ok(originRegion.includes(long), "长原文全文直显（120 字截断档已取消）");
    assert.ok(
      text.indexOf('<p class="hint nextstep">') < text.indexOf("<h2>需求原文</h2>"),
      "件2 主栏序：引导卡在原文折叠层之前",
    );
  }, { feature: { requirement: long } });

  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, /<h2>需求原文<\/h2>\n<pre class="result">要一个只读的排期导出<\/pre>/, "短原文直显，不套 details");
  }, { feature: { requirement: "要一个只读的排期导出" } });

  for (const requirement of [undefined, null, "", "   "]) {
    await withServer(async (base) => {
      const { text } = await detail(base);
      assert.equal(text.includes("<h2>需求原文</h2>"), false, `${String(requirement)} ⇒ 不渲染空区块`);
    }, { feature: { requirement } });
  }
});

// ---------------------------------------------------------------------------
// C1 页级正锚（件2 改版）：主栏序 = 步条 → 引导卡 → 动作区 → 最近一轮 → 折叠 → 侧栏元数据卡
// ---------------------------------------------------------------------------

test("C1-页面（正锚）：两栏拼接序 = 阶段步条 → 引导行 → 动作区 → 最近一轮 → 依赖图 → 侧栏元数据卡", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    const marks = [
      text.indexOf('<div class="b-steps">'),
      text.indexOf('<p class="hint nextstep">'),
      text.indexOf("<h2>动作</h2>"),
      text.indexOf("<h2>最近一轮</h2>"),
      text.indexOf("<h2>依赖图"),
      text.indexOf('<div class="feat-side">'),
      text.indexOf("<dt>审批门（approval）</dt>"),
    ];
    assert.equal(marks.every((i) => i >= 0), true, "七处结构锚都在场");
    assert.deepEqual(
      [...marks].sort((a, b) => a - b),
      marks,
      "引导行不在动作区之前 / 依赖图在主栏（侧栏之前）/ 元数据卡不在侧栏 ⇒ 件2 + N2c 两栏序回归",
    );
    assert.equal(text.includes("<th>阶段（显示）</th>"), false, "阶段双行已由阶段步条替代");
  }, {
    feature: { approval: "待审批", requirement: "要一个只读的排期导出" },
    // v0.10.3 N2c：依赖图卡要有内容才在场 ⇒ 喂一枚最小任务（缺省 tasks=[] ⇒ 图卡短路不渲）
    tasks: [
      {
        taskId: "task-depgraph",
        projectId: "p",
        state: "completed",
        lane: "write",
        failureKind: null,
        retryCount: null,
        dependencies: null,
        prompt: null,
        createdAt: "c",
        startedAt: null,
        finishedAt: null,
        queueState: null,
        queuedAt: "2026-09-24T00:00:00Z",
        claimedAt: null,
        claimedBy: null,
        taskType: null,
      },
    ],
    hostFace: fakeFace(null, null, {
      turnId: "turn-page-1",
      state: "succeeded",
      summary: "本轮结论：锚已合入",
      finishedAt: "2026-09-29T08:00:00Z",
      updatedAt: "2026-09-29T08:00:00Z",
      error: null,
    }),
  });
});

// ---------------------------------------------------------------------------
// C2 页级正锚：空区块短路（Step 0 卡瘦一屏的落点）
// ---------------------------------------------------------------------------

test("C2-页面（正锚）：任务 0 ⇒ 任务表不出 · trace 空节点 ⇒ 三面表不出 · trace 读失败 ⇒ 不短路照出", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.equal(text.includes("<h2>任务（"), false, "默认桥 tasks=[] ⇒ 任务表整节不渲染");
    assert.match(text, /trace 读取失败/, "读失败不属短路范围（R1 执行注记：不静默）");
  });

  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.equal(text.includes("<h2>任务（"), false, "任务 0 ⇒ 不出");
    assert.equal(text.includes("执行明细"), false, "trace 空 + 任务 0 ⇒ 执行明细区整体消失");
  }, { trace: { featureId: "F1", featureState: "waiting_approval", nodes: [] } });
});

// ---------------------------------------------------------------------------
// C6 页级正锚：最近一轮留痕（state / 轮 id / 时间 / 摘要，重载不丢）
// ---------------------------------------------------------------------------

test("C6-页面（正锚）：latestTurnOf 有轮 ⇒ 详情页显示最近一轮 state+轮 id+时间+摘要；无轮 ⇒ 整行不渲染", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, /<h2>最近一轮<\/h2>/);
    assert.match(text, /<p class="hint turn-trace"><b>失败（failed）<\/b>/, "轮态 = 中文（原值）");
    assert.match(text, /<span class="mono">turn-012<\/span>/, "轮 id 短形可核对");
    assert.match(text, /2026-09-29T08:30:00Z/, "时间 = finishedAt 原样");
    assert.match(text, /<span class="mono">turn_upstream_unreachable<\/span>/, "失败轮带结构化错误码");
    assert.match(text, /<details class="fold turn-summary"><summary>本轮结论：锚已合入<\/summary>/, "摘要进折叠层");
  }, {
    hostFace: fakeFace(null, null, {
      turnId: "turn-0123456789abcdef",
      state: "failed",
      summary: "本轮结论：锚已合入",
      finishedAt: "2026-09-29T08:30:00Z",
      updatedAt: "2026-09-29T08:31:00Z",
      error: { code: "turn_upstream_unreachable" },
    }),
  });

  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.equal(text.includes("<h2>最近一轮</h2>"), false, "默认 fakeFace latest=null ⇒ 留痕行缺席（缺席不是错误）");
  });
});

// ---------------------------------------------------------------------------
// v0.9.6 N4 页级锚：台账 → 详情页装配层的 receipt 透传（漏一行 = 回执卡永不出现且无告警）
// ---------------------------------------------------------------------------

test("N4-页面（正锚）：latestTurnOf 带回执 ⇒ 详情页出现回执卡；无回执 ⇒ 保持现状折叠摘要", async () => {
  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.match(text, /<div class="receipt-card">/, "装配层透传的 receipt 必须一路到页面");
    assert.match(text, /<b>要点<\/b> · 改完两处渲染点<br>补了页级锚/);
    assert.match(text, /<b>待用户<\/b> · ① 是否发版<br>② 文案是否要调/);
    assert.match(text, /<b>下一步<\/b> · 等用户真机验收/);
    assert.match(text, /📄 文档产出见『阶段产出』区，展开查看/);
    assert.match(text, /<details class="fold turn-summary"><summary>完整摘要<\/summary><pre class="result">本轮结论：锚已合入<\/pre><\/details>/, "400 字摘要仍在（退入折叠）");
  }, {
    hostFace: fakeFace(null, null, {
      turnId: "turn-0123456789abcdef",
      state: "succeeded",
      summary: "本轮结论：锚已合入",
      finishedAt: "2026-09-30T08:30:00Z",
      updatedAt: "2026-09-30T08:31:00Z",
      error: null,
      receipt: { head: ["改完两处渲染点", "补了页级锚"], todo: ["是否发版", "文案是否要调"], next: "等用户真机验收" },
    }),
  });

  await withServer(async (base) => {
    const { text } = await detail(base);
    assert.equal(text.includes('<div class="receipt-card">'), false, "无回执（历史轮 / agent 漏遵）⇒ 卡片不出现（整页含样式表，故锚到卡片标记本身）");
    assert.match(text, /<details class="fold turn-summary"><summary>本轮结论：锚已合入<\/summary>/, "无回执 = C6 现状折叠");
  }, {
    hostFace: fakeFace(null, null, {
      turnId: "turn-0123456789abcdef",
      state: "succeeded",
      summary: "本轮结论：锚已合入",
      finishedAt: "2026-09-30T08:30:00Z",
      updatedAt: "2026-09-30T08:31:00Z",
      error: null,
    }),
  });
});
