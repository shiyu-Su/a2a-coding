import { test } from "node:test";
import assert from "node:assert/strict";

import { renderPage, escapeHtml, BOARD_CSP, BOARD_REFERRER_POLICY, SUBMIT_GUARD_SCRIPT } from "../dist/web/layout.js";
import {
  renderFeaturesList,
  renderFeatureDetail,
  renderTasksPick,
  renderTasks,
  renderProjects,
  renderHostPage,
  renderRequirementForm,
  renderConfirmForm,
  renderTurnForm,
  renderAnswerForm,
  renderNextStepGuide,
  VIEW_NOTES,
} from "../dist/web/views.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

test("escapeHtml: 五字符全转义；null/undefined 为空串", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("renderPage: 标题转义 + 导航高亮 + 口径脚注逐条渲染", () => {
  const html = renderPage({
    title: `页 <x>`,
    active: "features",
    bodyHtml: "<p>正文</p>",
    notes: ["注 A", "注 <B>"],
  });
  assert.match(html, /<title>页 &lt;x&gt; · board<\/title>/);
  assert.match(html, /<a href="\/" class="on">需求<\/a>/);
  assert.match(html, /<li>注 A<\/li>/);
  assert.match(html, /<li>注 &lt;B&gt;<\/li>/);
});

test("BOARD_CSP: 无外部资源（default-src none + 仅内联 style + 同源表单）", () => {
  assert.match(BOARD_CSP, /default-src 'none'/);
  assert.match(BOARD_CSP, /style-src 'unsafe-inline'/);
  assert.ok(!BOARD_CSP.includes("http://") && !BOARD_CSP.includes("https://"));
});

// --- BD17：Referrer-Policy 不得掐掉写面表单档的同源 Referer 兜底 -----------

test("BD17-①（正例）BOARD_REFERRER_POLICY = same-origin；页面 meta 与响应头常量同源单点", () => {
  assert.equal(BOARD_REFERRER_POLICY, "same-origin");
  const html = renderPage({ title: "t", active: "features", bodyHtml: "<p>b</p>" });
  assert.match(html, /<meta name="referrer" content="same-origin">/);
});

test("BD17-②（负向锚）页面 HTML 不含任何 no-referrer 的 meta —— 有则同源表单发不出 Referer", () => {
  const html = renderPage({ title: "t", active: "features", bodyHtml: "<p>b</p>" });
  assert.doesNotMatch(html, /<meta\s+name="referrer"[^>]*content="no-referrer/i);
  assert.doesNotMatch(html, /no-referrer/i);
});

test("BD17-③（负向锚）CSP 不含 referrer 指令 —— 含则它会盖过 meta 的 same-origin", () => {
  assert.doesNotMatch(BOARD_CSP, /(^|;)\s*referrer\s/i);
});

// --- 收口轨 14 ①：提交守卫（内联脚本）与 CSP 的**最小**放宽 ----------------

test("轨14-CSP：script-src 只放开一档 'unsafe-inline'（与 style-src 同款内联程度），不引入任何外源", () => {
  const dir = /(^|;)\s*script-src([^;]*)/.exec(BOARD_CSP)?.[2]?.trim() ?? null;
  assert.equal(dir, "'unsafe-inline'", "放宽只到既有页面同款内联程度");
  assert.doesNotMatch(BOARD_CSP, /https?:\/\//, "CSP 里不得出现任何主机名/URL");
  assert.doesNotMatch(BOARD_CSP, /\*/);
  // 其余硬指令不因本轨松动
  assert.match(BOARD_CSP, /default-src 'none'/);
  assert.match(BOARD_CSP, /base-uri 'none'/);
  assert.match(BOARD_CSP, /form-action 'self'/);
});

test("轨14-守卫脚本：一段内联 · 零外源 · 零求值 · 只作用于 POST 表单", () => {
  assert.match(SUBMIT_GUARD_SCRIPT, /^<script>/);
  assert.doesNotMatch(SUBMIT_GUARD_SCRIPT, /<script[^>]*src=/);
  assert.doesNotMatch(SUBMIT_GUARD_SCRIPT, /eval|new Function|document\.write/);
  assert.match(SUBMIT_GUARD_SCRIPT, /"post"/, "非 POST 表单不得被动（读面表单不受影响）");
  assert.match(SUBMIT_GUARD_SCRIPT, /getAttribute\("data-submit"\)/, "就地文案 = 表单自带的 data-submit");
  assert.match(SUBMIT_GUARD_SCRIPT, /\.disabled = true/, "禁用的是提交按钮");
});

test("轨14-页面：每类写表单都带 data-submit 文案（提需求 / 触发一轮 / 确认 / 回答 / 停桥）", () => {
  assert.match(renderRequirementForm("flow"), /data-submit="[^"]+"/);
  assert.match(renderTurnForm("F1"), /action="\/features\/F1\/turn"[^>]*data-submit="[^"]+"/);
  assert.match(renderConfirmForm("F1", "待审批"), /action="\/features\/F1\/confirm"[^>]*data-submit="[^"]+"/);
  assert.match(renderAnswerForm("F1", "问题"), /action="\/features\/F1\/answer"[^>]*data-submit="[^"]+"/);
  const host = renderHostPage({
    entries: [
      {
        status: { org: "flow", state: "running", pid: 1, port: 9101, kind: "claude", display: "在线", error: null },
        queue: { org: "flow", running: null, waiting: [], capacity: 1 },
      },
    ],
    config: { orgsDir: "C:/tmp/orgs", defaultOrg: "flow", kind: "claude" },
    notice: null,
  });
  assert.match(host, /action="\/host\/flow\/stop"[^>]*data-submit="[^"]+"/);
});

test("轨14-页面（渲染禁用）：占用轮 ⇒ 触发一轮 disabled + 原因；无占用 ⇒ 原样可点", () => {
  const busy = { turnId: "turn-run", requirementId: "F1", org: "flow", contextId: "c", round: 4, state: "running", queuedAt: "q", startedAt: "s" };
  const html = renderTurnForm("F1", busy);
  assert.match(html, /<button type="submit" disabled aria-disabled="true">触发一轮/);
  assert.match(html, /本轮进行中（第 4 轮 · turn-run）/);
  assert.match(html, /action="\/features\/F1\/turn"/, "禁用不隐藏入口");
  assert.doesNotMatch(renderTurnForm("F1", null), /disabled/);

  // confirm：占用原因优先于 approval 判据（它直接对应「点了会白点」）
  const conf = renderConfirmForm("F1", "待审批", busy);
  assert.match(conf, /disabled/);
  assert.match(conf, /本轮进行中/);
  assert.doesNotMatch(conf, /审批门 = 待审批/, "占用时不显示 approval 那条原因");
  assert.match(renderConfirmForm("F1", "待审批", null), /<button type="submit">发送确认指令给 agent/);
});

test("轨17-页面（渲染禁用）：引擎终态 ⇒ 两按钮 disabled + 原因行，入口不隐藏", () => {
  const turn = renderTurnForm("F1", null, "completed");
  assert.match(turn, /<button type="submit" disabled aria-disabled="true">触发一轮/);
  assert.match(turn, /<p class="hint warn">本需求已完成（引擎态 completed），板上无需再操作/);
  assert.match(turn, /action="\/features\/F1\/turn"/, "禁用不隐藏入口");

  const conf = renderConfirmForm("F1", "待审批", null, "cancelled");
  assert.match(conf, /<button type="submit" disabled aria-disabled="true">发送确认指令给 agent/);
  assert.match(conf, /本需求已取消（终态），板上无需再操作/);
  assert.doesNotMatch(conf, /审批门 = 待审批/, "终态时不展示 approval 原因");

  assert.match(renderTurnForm("F1", null, "failed"), /本需求已进入失败终态/);
});

test("轨17-页面：终态判据优先于占用（占用文案被终态文案覆盖）", () => {
  const busy = { turnId: "turn-run", requirementId: "F1", org: "flow", contextId: "c", round: 4, state: "running", queuedAt: "q", startedAt: "s" };
  const turn = renderTurnForm("F1", busy, "completed");
  assert.match(turn, /本需求已完成/);
  assert.doesNotMatch(turn, /本轮进行中/);
  const conf = renderConfirmForm("F1", "待审批", busy, "completed");
  assert.match(conf, /本需求已完成/);
  assert.doesNotMatch(conf, /本轮进行中/);
});

test("轨17-页面（正向锚）非终态 / null / 未知态 ⇒ 两表单回到既有判据（轨14/BD18 语义不回归）", () => {
  const busy = { turnId: "turn-run", requirementId: "F1", org: "flow", contextId: "c", round: 4, state: "running", queuedAt: "q", startedAt: "s" };
  assert.doesNotMatch(renderTurnForm("F1", null, "executing"), /disabled/);
  assert.match(renderConfirmForm("F1", "待审批", null, "executing"), /<button type="submit">发送确认指令给 agent/);
  assert.match(renderTurnForm("F1", busy, "some-future-state"), /本轮进行中/, "未知态按非终态放行 ⇒ 占用判据照常");
  assert.match(renderConfirmForm("F1", "未发起", null, null), /方案未就绪/, "缺省参数不改变 approval 判据");
});

test("轨14-页面骨架：提交后的就地提示有样式（.submit-pending）+ 守卫脚本随每页注入一次", () => {
  const page = renderPage({ title: "t", active: "features", bodyHtml: "<p>b</p>" });
  assert.match(page, /p\.submit-pending\s*{/);
  assert.match(page, /button:disabled\s*{/);
  assert.equal(page.split("<script>").length - 1, 1, "每页只注入一段守卫脚本");
  assert.ok(page.includes(SUBMIT_GUARD_SCRIPT), "脚本 = 单点常量，不在各处复制");
});

// ---------------------------------------------------------------------------
// 需求列表（V1）
// ---------------------------------------------------------------------------

const listFixture = {
  features: [
    {
      featureId: "F1-long-uuid",
      state: "executing",
      title: "改造 <甲>",
      taskCount: 7,
      ownerGroup: "g",
      stage: "改造方案",
      version: "v0.9.0",
      approval: "已通过",
      createdAt: "c",
      updatedAt: "u",
      stateCounts: { completed: 5, working: 2 },
    },
    {
      featureId: "F2",
      state: "waiting_approval",
      title: "乙",
      taskCount: null,
      ownerGroup: null,
      stage: "需求分析",
      version: "",
      approval: "未发起",
      createdAt: null,
      updatedAt: null,
      stateCounts: {},
    },
  ],
  stateCounts: { completed: 5, working: 2 },
};

test("renderFeaturesList: 派生阶段 + 登记列 + version + taskCount（列表自带、无二次查询）", () => {
  const html = renderFeaturesList(listFixture);
  assert.match(html, /改造中 <span class="muted">派生<\/span>/);
  assert.match(html, /需求分析 <span class="muted">登记<\/span>/);
  assert.match(html, /v0\.9\.0/);
  assert.match(html, /<td>7<\/td>/);
  assert.match(html, /改造 &lt;甲&gt;/);
});

test("renderFeaturesList: stateCounts = null（老桥字段整体缺失）⇒ 如实降级，无 TODO 文案", () => {
  const html = renderFeaturesList({ ...listFixture, stateCounts: null });
  assert.match(html, /各态分布：/);
  assert.match(html, /未透出 per-feature/);
  assert.ok(!/TODO/.test(html));
});

test("renderFeaturesList: stateCounts 有值 ⇒ 渲染聚合后的分布", () => {
  const html = renderFeaturesList({ ...listFixture, stateCounts: { executing: 2, completed: 5 } });
  assert.match(html, /各态分布：executing=2 · completed=5/);
  assert.match(html, /本地聚合/);
  assert.ok(!/TODO/.test(html));
});

test("renderFeaturesList: stateCounts = {} ⇒ 显示空分布，不得报缺位（BD6 回归锚）", () => {
  const html = renderFeaturesList({ ...listFixture, stateCounts: {} });
  assert.match(html, /各态分布：（空分布 · 无任务）/);
  assert.ok(!/未透出/.test(html));
  assert.ok(!/TODO/.test(html));
});

// ---------------------------------------------------------------------------
// 需求详情 + trace 三面
// ---------------------------------------------------------------------------

const detailFixture = {
  feature: {
    featureId: "F1",
    state: "executing",
    title: "甲",
    plan: null,
    ownerGroup: "g",
    stage: "改造方案",
    version: "v0.9.0",
    approval: "已通过",
    createdAt: "c",
    updatedAt: "u",
  },
  tasks: [
    {
      taskId: "t1",
      projectId: "p",
      state: "failed",
      lane: "read",
      failureKind: "timeout",
      retryCount: 1,
      dependencies: ["t0"],
    },
  ],
};

const traceFixture = {
  featureId: "F1",
  featureState: "executing",
  nodes: [
    {
      taskId: "t2",
      projectId: "p",
      state: "submitted",
      lane: "read",
      queueState: "queued",
      waitReason: "read_lane_running",
      blockedOn: [],
      projectBusy: { busy: false, taskId: null, machineId: null },
      readOccupants: [
        { taskId: "r1", featureId: null, queueState: "running", machineId: "m1", queuedAt: "q" },
      ],
      position: 3,
      waitedSince: "2026-09-24T11:55:00Z",
    },
  ],
};

test("renderFeatureDetail: state/stage/version/approval 全显示 + 派生标注", () => {
  const html = renderFeatureDetail(detailFixture, traceFixture, null, NOW);
  assert.match(html, /执行中（executing）/);
  assert.match(html, /改造中/);
  assert.match(html, /改造方案/);
  assert.match(html, /v0\.9\.0/);
  assert.match(html, /已通过/);
});

test("renderFeatureDetail: B13-③ 三面表 —— waitReason 原样 + 读档占位 + 写门未挡", () => {
  const html = renderFeatureDetail(detailFixture, traceFixture, null, NOW);
  assert.match(html, /read_lane_running/);
  assert.doesNotMatch(html, /读闸运行中|等待远程/);
  assert.match(html, /写门未挡/);
  assert.match(html, /读档占位 1 个：r1@m1/);
  assert.match(html, /位次/);
  assert.match(html, /<td>3<\/td>/);
});

test("renderFeatureDetail: B13-① 等待时长只由 waitedSince 单时钟派生（显示原值可核对）", () => {
  const html = renderFeatureDetail(detailFixture, traceFixture, null, NOW);
  assert.match(html, /5m 0s/);
  assert.match(html, /自 2026-09-24T11:55:00Z/);
});

test("renderFeatureDetail: trace 读取失败 ⇒ 可见错误，不静默", () => {
  const html = renderFeatureDetail(detailFixture, null, "桥返回 HTTP 500", NOW);
  assert.match(html, /class="hint err"/);
  assert.match(html, /trace 读取失败：桥返回 HTTP 500/);
});

test("VIEW_NOTES: 每页统一挂 B13 三条 + 并行度文案", () => {
  assert.equal(VIEW_NOTES.length, 4);
  assert.match(VIEW_NOTES.join("\n"), /编排侧并行 ≠ 改造侧并行/);
});

// ---------------------------------------------------------------------------
// 任务 / 项目视图
// ---------------------------------------------------------------------------

test("renderTasksPick: project 必填说明 + GET 表单 + 快照项目链接", () => {
  const projects = {
    source: "s",
    note: "快照语义",
    observedAt: "o",
    machines: [
      {
        machineId: "m1",
        error: null,
        projects: [
          { projectId: "zeta", agentKind: "claude", a2aPort: 9, status: "online", endpoint: null, startedAt: null },
          { projectId: "alpha", agentKind: "qoder-cn", a2aPort: 8, status: "offline", endpoint: null, startedAt: null },
        ],
      },
    ],
    runners: [],
  };
  const html = renderTasksPick(projects, null);
  assert.match(html, /<code>project<\/code> 为必填/);
  assert.match(html, /<form method="get" action="\/tasks">/);
  assert.match(html, /href="\/tasks\?project=alpha"/);
  assert.match(html, /href="\/tasks\?project=zeta"/);
});

test("renderTasks: 行渲染 + 不可达提示 + inFlightCount 口径标注", () => {
  const view = {
    projectId: "p",
    reachable: false,
    notice: "项目 p 当前非在线（status=offline）",
    tasks: [
      { taskId: "t1", contextId: "ctx1", state: "working", prompt: "做 x", text: null, updatedAt: "u", stale: true },
    ],
  };
  const html = renderTasks(view);
  assert.match(html, /执行中（working）/);
  assert.match(html, /stale/);
  assert.match(html, /当前不可达/);
  assert.match(html, /inFlightCount[^<]*≠ 实际在跑数|≠ 实际在跑数/);
});

test("renderProjects: 机器不可达行 + runner 在线态 + 快照注", () => {
  const view = {
    source: "桥注册表",
    note: "快照语义（非实时在线）",
    observedAt: "2026-09-24T00:00:00Z",
    machines: [
      { machineId: "m2", error: "unreachable", projects: [] },
      {
        machineId: "m1",
        error: null,
        projects: [
          { projectId: "p1", agentKind: "claude", a2aPort: 3017, status: "online", endpoint: "e", startedAt: "s" },
        ],
      },
    ],
    runners: [{ machineId: "m1", online: true, lastHeartbeatAt: "h" }],
  };
  const html = renderProjects(view);
  assert.match(html, /class="warn"><td>m2<\/td><td colspan="5">机器不可达：unreachable/);
  assert.match(html, /p1/);
  assert.match(html, /在线/);
  assert.match(html, /快照语义（非实时在线）/);
});

// ---------------------------------------------------------------------------
// BD11：组织名进表单 ⇒ 表单与 `GET /host` 配置行都如实反映「默认组织」的两态
// ---------------------------------------------------------------------------

test("BD11 renderRequirementForm：未配默认组织 ⇒ group 必填 + 首次填写即创建；配了 ⇒ 允许留空并显示默认", () => {
  const noDefault = renderRequirementForm(null);
  assert.match(noDefault, /name="group"[^>]*required/, "未配默认 ⇒ 组织名字段必填");
  assert.match(noDefault, /首次填写即创建该组织/, "须说明「首次使用该组织名 = 创建该组织」");
  assert.doesNotMatch(noDefault, /留空 = 用板级默认/, "无默认可回落时不得出现回落文案");

  const withDefault = renderRequirementForm("  flow-team  ");
  assert.doesNotMatch(withDefault, /name="group"[^>]*required/, "有默认 ⇒ 允许留空");
  assert.match(withDefault, /留空 = 用板级默认 flow-team/);

  assert.equal(renderRequirementForm("   ").includes("留空 = 用板级默认"), false, "纯空白默认等同未配置");
});

test("BD11 renderHostPage 配置行：默认组织未配置时如实显示「由提需求表单给出」，不编造兜底组名", () => {
  const bare = renderHostPage({ entries: [], config: { orgsDir: "C:/tmp/orgs", defaultOrg: null, kind: "claude" }, notice: null });
  assert.match(bare, /默认组织 = <code>（未配置 ⇒ 组织名由提需求表单给出）<\/code>/);
  assert.match(bare, /组织目录根 = <code>C:\/tmp\/orgs<\/code>/);

  const withDefault = renderHostPage({ entries: [], config: { orgsDir: null, defaultOrg: "flow-team", kind: "claude" }, notice: null });
  assert.match(withDefault, /默认组织 = <code>flow-team<\/code>/);
  assert.match(withDefault, /组织目录根 = <code>（未配置 ⇒ 触发一轮将结构化 503）<\/code>/);
});

// ---------------------------------------------------------------------------
// BD18：确认按钮按 approval 条件化 + 「下一步」引导行（视图层）
// ---------------------------------------------------------------------------

test("BD18 renderConfirmForm：待审批 ⇒ 按钮可点（无 disabled）+ 状态行指向 agent 核对", () => {
  const html = renderConfirmForm("F1", "待审批");
  assert.match(html, /<button type="submit">发送确认指令给 agent/);
  assert.doesNotMatch(html, /disabled/, "待审批档不得出现 disabled");
  assert.match(html, /审批门 = 待审批/);
  assert.match(html, /不存在「板上批准」/, "既有的诚实文案不丢");
});

test("BD18 renderConfirmForm（负向）：未发起 ⇒ 按钮禁用 + 可见原因（看得见、明确不可用、给下一步）", () => {
  const html = renderConfirmForm("F1", "未发起");
  assert.match(html, /<button type="submit" disabled aria-disabled="true">/, "禁用而非隐藏");
  assert.match(html, /action="\/features\/F1\/confirm"/, "入口仍在（不隐藏）");
  assert.match(html, /class="hint warn">方案未就绪/, "原因行走 .warn 样式");
  assert.match(html, /触发一轮/, "说明里给出下一步");
});

test("BD18 renderConfirmForm：已通过 / 未知值 ⇒ 同样禁用并说明（未知值原样透出）", () => {
  assert.match(renderConfirmForm("F1", "已通过"), /disabled/);
  assert.match(renderConfirmForm("F1", "已通过"), /无需再次确认/);
  const odd = renderConfirmForm("F1", "X<Y");
  assert.match(odd, /disabled/);
  assert.match(odd, /X&lt;Y/, "approval 原值经转义透出");
});

test("BD18 renderNextStepGuide：渲染 derive 引导行为 .nextstep 行且转义", () => {
  const html = renderNextStepGuide({
    hostFaceAssembled: false,
    awaitingAnswer: false,
    approval: "未发起",
    state: "waiting_approval",
  });
  assert.match(html, /^<p class="hint nextstep">下一步：宿主面未装配/);
  assert.match(html, /orgsDir/);
  const esc = renderNextStepGuide({
    hostFaceAssembled: true,
    awaitingAnswer: false,
    approval: "<b>",
    state: null,
  });
  assert.match(esc, /&lt;b&gt;/);
});

test("BD18 页面样式：button:disabled 灰态 + .nextstep 引导行样式在骨架内", () => {
  const page = renderPage({ title: "t", active: "features", bodyHtml: "<p>b</p>" });
  assert.match(page, /button:disabled\s*{[^}]*cursor: not-allowed/);
  assert.match(page, /p\.nextstep/);
});
