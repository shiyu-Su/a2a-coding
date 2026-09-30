import { test } from "node:test";
import assert from "node:assert/strict";

import { renderPage, renderOrgSwitcher, escapeHtml, BOARD_CSP, BOARD_REFERRER_POLICY, SUBMIT_GUARD_SCRIPT, FEATURE_DETAIL_OVERLAY_SCRIPT, NEW_REQUIREMENT_DIALOG_SCRIPT } from "../dist/web/layout.js";
import {
  renderFeatureDetail,
  renderTasksPick,
  renderTasks,
  renderProjects,
  renderHostPage,
  renderRequirementForm,
  renderScheduleForm,
  renderVersionSwitchWarningLine,
  registeredDecisionDocVersions,
  renderActionArea,
  renderTurnProgress,
  renderTurnOutcome,
  renderAnswerForm,
  renderNextStepGuide,
  renderTurnTrace,
  renderAcceptanceSection,
  renderNewRequirementDialog,
  renderOrgSpaceManagePage,
  renderOrgPortal,
  buildOrgPortalCards,
  VIEW_NOTES,
} from "../dist/web/views.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

/**
 * v0.9.5 C5：动作区唯一入参构造（档位化前的 `renderTurnForm` / `renderConfirmForm` 两形态已合并）。
 * 缺省 = 预审闲置档（approval 未发起 ∧ 无产出 ∧ 无占用）。
 */
function actionInput(over = {}) {
  return { hostFaceAssembled: true, awaitingAnswer: false, approval: "未发起", state: "waiting_approval", ...over };
}

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
    active: "projects",
    bodyHtml: "<p>正文</p>",
    notes: ["注 A", "注 <B>"],
  });
  assert.match(html, /<title>页 &lt;x&gt; · board<\/title>/);
  assert.match(html, /<a href="\/projects" class="on">项目<\/a>/);
  assert.match(html, /<li>注 A<\/li>/);
  assert.match(html, /<li>注 &lt;B&gt;<\/li>/);
});

test("REQ-04 Q2：导航「需求」项退役 ⇒ 页面不含 /requirements 链接（v0.9.6 B5a 闭集六 → 三枚：摘排期/任务/宿主桥）", () => {
  const html = renderPage({ title: "t", active: "projects", bodyHtml: "<p>b</p>" });
  assert.doesNotMatch(html, /href="\/requirements"/);
  assert.doesNotMatch(html, /\/timeline|Timeline/, "Timeline 导航已退役（增补 ③）");
  assert.doesNotMatch(html, /href="\/orgs"/, "§9-c：组织管理页退役 ⇒ NAV「组织」项摘除（管理职能迁空间内 /org/<名>/manage）");
  assert.doesNotMatch(html, /href="\/schedule"/, "B5a：全局排期页退役 ⇒ NAV「排期」项摘除（排期面唯一承载位 = /org/<名>/schedule）");
  assert.doesNotMatch(html, /href="\/tasks"/, "B5a 口径 33：「任务」摘条（路由不退 ⇒ 深链可达，不留 NAV 入口）");
  assert.doesNotMatch(html, /href="\/host"/, "B5a 口径 38：「宿主桥」摘条（路由不退 ⇒ 正文链接可达，不留 NAV 入口）");
  for (const [href, text] of [
    ["/", "门户"],
    ["/projects", "项目"],
    ["/agents", "Agent"],
  ]) {
    assert.ok(html.includes(`<a href="${href}"`), `导航含 ${href}`);
    assert.ok(html.includes(`>${text}</a>`), `导航含 ${text}`);
  }
  // 正文为纯 <p> ⇒ 全页锚点 = 导航闭集，多一枚即「需求」退役不彻底
  assert.equal((html.match(/<a href=/g) ?? []).length, 3, "导航闭集 = 3 项（B5a 收三枚：门户 / 项目 / Agent）");
});

// --- v0.9.6 B5b：组织切换器挂位三态（口径 19 / 20）--------------------------

const ORG_NAV_2 = { org: "组织甲", orgs: ["组织甲", "组织乙"] };

test("B5b-① 切换器三态：缺省 top 顶栏渲 / body 顶栏不渲（正文自挂）/ none 整页不渲 —— 判据是字段，**不是**「org 非空」", () => {
  const top = renderPage({ title: "t", active: "home", bodyHtml: "<p>b</p>", orgNav: ORG_NAV_2 });
  const body = renderPage({ title: "t", active: "home", bodyHtml: "<p>b</p>", orgNav: ORG_NAV_2, orgSwitcher: "body" });
  const none = renderPage({ title: "t", active: "home", bodyHtml: "<p>b</p>", orgNav: ORG_NAV_2, orgSwitcher: "none" });
  assert.match(top, /<header>[\s\S]*?class="org-switch"/, "top（缺省）：顶栏渲");
  assert.doesNotMatch(body.slice(0, body.indexOf("<main>")), /class="org-switch/, "body：顶栏不渲");
  assert.doesNotMatch(none, /class="org-switch/, "none：整页不渲");
  // 反向钉「不得按 org 非空隐藏」：org 非空 + 缺省档 ⇒ 仍须顶栏渲（空间错误页族的唯一组织出路）
  assert.notEqual(ORG_NAV_2.org, null, "本钉的前提 = org 非空");
  assert.equal(body.slice(body.indexOf("<main>")), none.slice(none.indexOf("<main>")), "body 与 none 的正文一致（区别只在顶栏）");
});

test("B5b-② 切换器单点复用 + 行右修饰类：extraClass 只改 class 一枚，顶栏档输出逐字节不变（CSS 另挂 .org-switch.right）", () => {
  assert.equal(
    renderOrgSwitcher(ORG_NAV_2),
    '<span class="org-switch"> <span class="muted">组织</span> <a href="/org/%E7%BB%84%E7%BB%87%E7%94%B2/" class="on">组织甲</a><a href="/org/%E7%BB%84%E7%BB%87%E4%B9%99/">组织乙</a></span>',
    "缺省档 = 移位前逐字节（顶栏不收影响）",
  );
  assert.match(renderOrgSwitcher(ORG_NAV_2, "right"), /^<span class="org-switch right">/, "行右档只加修饰类");
  const css = renderPage({ title: "t", active: "home", bodyHtml: "" });
  assert.match(css, /\.org-switch\.right \{ float: right; \}/, "行右靠 CSS 一枚，不复用 .header-actions");
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

test("轨14+BD14-CSP：script-src 放开 'unsafe-inline' + 'self'（vendored 同源资产），不引入任何外源主机", () => {
  const dir = /(^|;)\s*script-src([^;]*)/.exec(BOARD_CSP)?.[2]?.trim() ?? null;
  assert.ok(dir !== null);
  // BD14 明示放宽：'self' 只放行同源（板恒绑 loopback）的 /static/ vendored 资产；一档一义，不多放
  assert.deepEqual(dir.split(/\s+/).sort(), ["'self'", "'unsafe-inline'"]);
  assert.doesNotMatch(BOARD_CSP, /https?:\/\//, "CSP 里不得出现任何主机名/URL");
  assert.doesNotMatch(BOARD_CSP, /\*/);
  // 其余硬指令不因这两轨松动
  assert.match(BOARD_CSP, /default-src 'none'/);
  assert.match(BOARD_CSP, /base-uri 'none'/);
  assert.match(BOARD_CSP, /form-action 'self'/);
});

// --- 增补轨 2：详情浮层 fetch 的第三处明示放宽 = connect-src 'self' ----------

test("增补轨2-CSP：页面 CSP 含 connect-src 'self'（浮层同源 fetch），且只放开同源一档", () => {
  assert.match(BOARD_CSP, /connect-src 'self'/);
  const dir = /(^|;)\s*connect-src([^;]*)/.exec(BOARD_CSP)?.[2]?.trim() ?? null;
  assert.ok(dir !== null);
  // 一档一义：只放行同源 fetch（板恒绑 loopback），不多放、不引外源
  assert.deepEqual(dir.split(/\s+/), ["'self'"]);
});

test("轨14-守卫脚本：一段内联 · 零外源 · 零求值 · 只作用于 POST 表单", () => {
  assert.match(SUBMIT_GUARD_SCRIPT, /^<script>/);
  assert.doesNotMatch(SUBMIT_GUARD_SCRIPT, /<script[^>]*src=/);
  assert.doesNotMatch(SUBMIT_GUARD_SCRIPT, /eval|new Function|document\.write/);
  assert.match(SUBMIT_GUARD_SCRIPT, /"post"/, "非 POST 表单不得被动（读面表单不受影响）");
  assert.match(SUBMIT_GUARD_SCRIPT, /getAttribute\("data-submit"\)/, "就地文案 = 表单自带的 data-submit");
  assert.match(SUBMIT_GUARD_SCRIPT, /\.disabled = true/, "禁用的是提交按钮");
});

// --- v0.9.4 增补二 §9.1-②：data-ov 写表单的 fetch 报错呈现（闭集六元内扩写，不新枚） -------

test("增补二/五-守卫脚本扩写：data-ov 表单 = fetch 提交 · 成功按 data-ov-redirect 跳转（缺省 reload）· 4xx 抽 .err-ov-card 浮层不跳页 · 让位已拦截事件", () => {
  const s = SUBMIT_GUARD_SCRIPT;
  assert.match(s, /getAttribute\("data-ov"\)/, "按表单标记分流（无标记表单路径逐字节不变）");
  assert.match(s, /method:\s*"POST",\s*\n\s*body: data,\s*\n\s*credentials: "same-origin",\s*\n\s*headers: \{ Accept: "text\/html" \}/, "urlencoded 同源 fetch（Accept 必带，服务端按档分流）");
  assert.match(s, /var redirect = form\.getAttribute\("data-ov-redirect"\) \|\| "";/, "增补五 §9.4-②：成功路径读取 data-ov-redirect");
  assert.match(s, /if \(r\.ok\) \{ gotoAfterSubmit\(redirect\); return; \}/, "成功 ⇒ 走 gotoAfterSubmit（有 redirect 跳目标、无则 reload）");
  assert.match(s, /if \(redirect !== ""\) \{ window\.location\.href = redirect; return; \}\s*\n\s*window\.location\.reload\(\);/, "有该属性 ⇒ location.href 目标；无 ⇒ 维持整页刷新");
  assert.match(s, /querySelector\("\.err-ov-card"\)/, "失败 = 抽错误卡浮层呈现");
  assert.match(s, /ovShowCard\(card\)/, "失败不跳页：卡叠加为 body 直接子元素");
  assert.match(s, /e\.defaultPrevented/, "详情浮层 / 新增需求弹窗已拦截时让位（不抢事件）");
  assert.match(s, /data-ov-pending/, "提交标记防连点双发");
  assert.doesNotMatch(s, /getElementById\("(feat-dialog|new-req-dialog|schedule-board|err-ov)"\)/, "不踩其它五枚常量的单点标记（N3-⑦ 闭集归类唯一）");
});

// --- v0.9.4 增补三 §9.2：form.action 同名遮蔽修复（双锚 = 正向取属性 + 负向禁直读） -------

test("增补三-ovSubmit 目标 URL = getAttribute(\"action\") 属性值 · 空 ⇒ form.submit() 原生回落", () => {
  const s = SUBMIT_GUARD_SCRIPT;
  // 定向锚（fixture 形态 = 含 name="action" 隐藏字段的成员/停用表单：views.ts 三枚表单均带，
  // 遮蔽只对属性读取成立 ⇒ 断言脚本取的是属性值即覆盖该形态；本仓测试基建为字符串锚，无 DOM 运行器）
  assert.match(s, /var action = form\.getAttribute\("action"\) \|\| "";/, "提交目标经属性读取取得（同名字段遮蔽不了 getAttribute）");
  assert.match(s, /fetch\(action, \{/, "fetch 直接用该属性值（不另拼端点、不回读 form.action）");
  assert.match(s, /if \(data === null \|\| action === ""\) \{ ovRestore\(form\); form\.submit\(\); return; \}/, "action 属性缺失 ⇒ 回落原生提交（不劣化）");
});

// --- v0.9.4 增补四 §9.3：浮层卡「知道了」委托关闭（闭集六元内扩写，不新枚） -------

test("增补四-守卫脚本扩写：document 级委托摘 .err-ov-card「知道了」（closest 口径对齐 /schedule 侧）", () => {
  const s = SUBMIT_GUARD_SCRIPT;
  assert.match(s, /document\.addEventListener\("click"/, "document 级委托（动态注入卡天然覆盖，非直接绑定）");
  assert.match(s, /closest\("#err-ov-close"\)/, "只认「知道了」按钮（与 /schedule 侧浮层脚本同款 id 判据）");
  assert.match(s, /closest\("\.err-ov-card"\)/, "委托关闭 = closest + err-ov-card 组合");
  assert.match(s, /card\.parentNode\.removeChild\(card\)/, "命中 ⇒ 从 DOM 摘除该卡片");
  // 闭集六元不扩：不引入其它五枚常量的单点标记
  assert.doesNotMatch(s, /getElementById\("(feat-dialog|new-req-dialog|schedule-board|err-ov)"\)/, "不踩其余五枚常量归类标记（N3-⑦ 闭集唯一）");
});

test("增补三-负向锚：三枚 fetch 拦截常量直读 form.action 零出现（遮蔽缺陷防复发）", () => {
  for (const [label, s] of [
    ["SUBMIT_GUARD_SCRIPT", SUBMIT_GUARD_SCRIPT],
    ["FEATURE_DETAIL_OVERLAY_SCRIPT", FEATURE_DETAIL_OVERLAY_SCRIPT],
    ["NEW_REQUIREMENT_DIALOG_SCRIPT", NEW_REQUIREMENT_DIALOG_SCRIPT],
  ]) {
    assert.doesNotMatch(s, /form\.action/, `${label} 不得直读 form.action（name="action" 字段会遮蔽该属性 ⇒ 伪 URL 405）`);
  }
});

test("增补二-表单标记：manage 成员增删 / 停用 + 门户建组织带 data-ov=\"1\"（其余写表单不扩）", () => {
  const manage = renderOrgSpaceManagePage({ org: "alpha", features: [], projectsOutcome: null, groupsOutcome: null });
  assert.equal((manage.match(/data-ov="1"/g) ?? []).length, 3, "加 / 删 / 停用三枚表单");
  assert.match(manage, /action="\/orgs\/alpha\/members"[^>]*data-ov="1"/);
  assert.match(manage, /action="\/orgs" class="inline" data-submit="已提交，停用中…" data-ov="1" data-ov-redirect="\/"/, "停用表单带 data-ov-redirect=/（§9.4-② 成功跳门户）");
  const portal = renderOrgPortal(buildOrgPortalCards(["甲"], []));
  assert.match(portal, /action="\/orgs" class="w"[^>]*data-ov="1"/, "门户建组织同口径");
  assert.doesNotMatch(renderRequirementForm("flow"), /data-ov/, "提需求弹窗自带脚本，不经本通道");
  assert.doesNotMatch(renderActionArea("F1", actionInput()), /data-ov/, "动作区（长任务整页档）不扩浮层标记");
});

test("轨14-页面（v0.9.5 C5 档位化）：每类写表单都带 data-submit 文案（提需求 / 动作区两档 / 回答 / 停桥）", () => {
  assert.match(renderRequirementForm("flow"), /data-submit="[^"]+"/);
  assert.match(renderActionArea("F1", actionInput()), /action="\/features\/F1\/turn"[^>]*data-submit="[^"]+"/);
  assert.match(
    renderActionArea("F1", actionInput({ approval: "待审批" })),
    /action="\/features\/F1\/confirm"[^>]*data-submit="[^"]+"/,
    "确认档仍发向既有 /confirm 路由（写路由零改动）",
  );
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

test("轨14-页面（v0.9.5 C5 渲染禁用）：占用轮 ⇒ 当前档位按钮 disabled + 原因（不撤档）；无占用 ⇒ 可点", () => {
  const busyTurn = { turnId: "turn-run", requirementId: "F1", org: "flow", contextId: "c", round: 4, state: "running", queuedAt: "q", startedAt: "s" };
  const html = renderActionArea("F1", actionInput({ turnBusy: true, busyTurn }));
  assert.match(html, /<button type="submit" disabled aria-disabled="true">让 agent 继续/);
  assert.match(html, /本轮进行中（第 4 轮 · turn-run）/);
  assert.match(html, /action="\/features\/F1\/turn"/, "禁用不隐藏入口（占用只置灰，不改档）");
  assert.doesNotMatch(renderActionArea("F1", actionInput()), /disabled/);

  // 确认档：占用原因优先于 approval 判据（它直接对应「点了会白点」）
  const conf = renderActionArea("F1", actionInput({ approval: "待审批", turnBusy: true, busyTurn }));
  assert.match(conf, /disabled/);
  assert.match(conf, /本轮进行中/);
  assert.match(conf, /aria-disabled="true">确认改造文档 → 放行执行<\/button>/, "占用时按钮文案仍是确认档");
  assert.match(conf, /action="\/features\/F1\/confirm"/);
  assert.doesNotMatch(conf, /审批门 = 待审批/, "占用时不显示 approval 那条原因");
  assert.match(renderActionArea("F1", actionInput({ approval: "待审批" })), /<button type="submit">确认改造文档 → 放行执行/);
});

test("轨17-页面（v0.9.5 C5 墓碑）：引擎终态 ⇒ 动作区整体不渲染，终态事实由引导行承载（原「灰态按钮 + 原因」定向推翻）", () => {
  for (const [state, re] of [
    ["completed", /本需求已完成（引擎态 completed），板上无需再操作/],
    ["cancelled", /本需求已取消（终态），板上无需再操作/],
    ["failed", /本需求已进入失败终态，板上无需再操作/],
  ]) {
    assert.equal(renderActionArea("F1", actionInput({ approval: "待审批", state })), "", `${state} 终态不得出现动作区`);
    assert.match(renderNextStepGuide(actionInput({ state })), re, `${state} 终态结论仍看得见`);
  }
});

test("轨17-页面：终态判据优先于占用（终态需求不渲染动作区，也不出占用文案）", () => {
  const busyTurn = { turnId: "turn-run", requirementId: "F1", org: "flow", contextId: "c", round: 4, state: "running", queuedAt: "q", startedAt: "s" };
  assert.equal(renderActionArea("F1", actionInput({ approval: "待审批", state: "completed", turnBusy: true, busyTurn })), "");
  const guide = renderNextStepGuide(actionInput({ state: "completed", turnBusy: true, busyTurn }));
  assert.match(guide, /本需求已完成/);
  assert.doesNotMatch(guide, /本轮进行中/, "陈旧占用台账不得解释终态需求的显示");
});

test("轨17-页面（正向锚）非终态 / null / 未知态 ⇒ 动作区回到既有档位判据（轨14/BD18 语义不回归）", () => {
  const busyTurn = { turnId: "turn-run", requirementId: "F1", org: "flow", contextId: "c", round: 4, state: "running", queuedAt: "q", startedAt: "s" };
  assert.doesNotMatch(renderActionArea("F1", actionInput({ state: "executing" })), /disabled/);
  assert.match(renderActionArea("F1", actionInput({ approval: "待审批", state: "executing" })), /<button type="submit">确认改造文档 → 放行执行/);
  assert.match(renderActionArea("F1", actionInput({ state: "some-future-state", turnBusy: true, busyTurn })), /本轮进行中/, "未知态按非终态放行 ⇒ 占用判据照常");
  const idle = renderActionArea("F1", actionInput({ approval: null, state: null }));
  assert.match(idle, /<button type="submit">让 agent 继续<\/button>/, "approval 缺值 ⇒ 走闲置档，不渲染确认块");
  assert.doesNotMatch(idle, /触发一轮|方案未就绪/, "底层机制词与旧灰态文案一律不出");
});

// ---------------------------------------------------------------------------
// REQ-v0.9.2 N7：详情页轮次进度行（303 回详情页后的可见落点）
// ---------------------------------------------------------------------------

test("N7-页面 在飞轮 ⇒ 「第 N 轮 在飞」+ 轮 id，不显示位次", () => {
  const html = renderTurnProgress({ turnId: "turn-run", round: 4, state: "running", position: null });
  assert.match(html, /<p class="hint turn-progress">轮次进度：<b>第 4 轮 在飞<\/b>/);
  assert.match(html, /<span class="mono">turn-run<\/span>/);
  assert.doesNotMatch(html, /队列第/);
});

test("N7-页面 排队轮 ⇒ 「第 N 轮 排队中 · 队列第 K 位」；位次查不到 ⇒ 只说排队中（不臆造第 1 位）", () => {
  assert.match(
    renderTurnProgress({ turnId: "turn-q", round: 2, state: "queued", position: 3 }),
    /<b>第 2 轮 排队中 · 队列第 3 位<\/b>/,
  );
  const noPos = renderTurnProgress({ turnId: "turn-q", round: 2, state: "queued", position: null });
  assert.match(noPos, /第 2 轮 排队中/);
  assert.doesNotMatch(noPos, /队列第/);
});

test("N7-页面（负向）无在飞 / 排队轮 ⇒ 整行不渲染；进度行自带零刷新（刷新全在浮层脚本侧）", () => {
  assert.equal(renderTurnProgress(null), "");
  const html = renderTurnProgress({ turnId: "turn-run", round: 1, state: "running", position: null });
  assert.doesNotMatch(html, /http-equiv|setTimeout|location\.reload/i, "进度行不得自带刷新");
});

// REQ-2026-09-29-02 件D：口径行由「板不自动刷新」改为准确两档表述（动作区自动刷新 / 其余不自动刷新）。
test("N7-页面（件D 新口径文案锚）动作区提交后自动刷新进度至本轮收口，其余内容仍需重载本页", () => {
  const html = renderTurnProgress({ turnId: "turn-run", round: 4, state: "running", position: null });
  assert.match(html, /轮次进度：<b>第 4 轮 在飞<\/b>/, "在飞档主体不变（既有口径不弱化）");
  assert.match(html, /浮层内提交后动作区自动刷新进度至本轮收口/, "自动档 = 浮层动作区");
  assert.match(html, /其余内容重载本页看最新/, "静态档 = 其余内容仍须重载");
  assert.doesNotMatch(html, /板不自动刷新/, "旧的笼统表述已退役（与件B 行为矛盾的根因文案）");
});

// --- REQ-v0.9.2 N8：详情页验收轨迹块（消费 acceptance，板不重算） ---------------- --------

test("N8-验收轨迹：acceptance 缺位（老桥 null / undefined）⇒ 整块不渲染（现行为）", () => {
  assert.equal(renderAcceptanceSection(null), "");
  assert.equal(renderAcceptanceSection(undefined), "");
});

test("N8-验收轨迹：未知/退役态原样灰化、末段 leftAt=null=当前停留、同态重复段不合并", () => {
  const html = renderAcceptanceSection({
    stages: [
      { state: "analyzing", enteredAt: "e0", leftAt: "e1" },
      { state: "executing", enteredAt: "e1", leftAt: "e2" },
      { state: "needs_input", enteredAt: "e2", leftAt: "e3" },
      { state: "executing", enteredAt: "e3", leftAt: null },
    ],
    failures: [],
    stateCounts: { completed: 2 },
  });
  assert.match(html, /<span class="muted">analyzing<\/span>/, "值域非封闭 ⇒ 未命中标签表原样显示 + 灰化");
  assert.match(html, /<span class="warn">当前停留<\/span>/);
  assert.equal(html.split("执行中（executing）").length - 1, 2, "同名 executing 两段如实显示，不合并");
  assert.match(html, /失败账单：<b>0 条<\/b>/);
  assert.match(html, /已完成（completed） × 2/);
});

test("N8-验收轨迹：failures 计数 + payload 防御式摘要（坏 JSON 原文截断、null ⇒ —）", () => {
  const html = renderAcceptanceSection({
    stages: [],
    failures: [
      { eventId: 7, at: "a1", payload: '{"failed":["t1","t2"],"blockedSet":[]}' },
      { eventId: null, at: null, payload: "{坏 JSON" },
      { eventId: 9, at: "a3", payload: null },
    ],
    stateCounts: {},
  });
  assert.match(html, /（无段轨迹）/);
  assert.match(html, /失败账单：<b>3 条<\/b>/);
  assert.match(html, /failed×2 · blockedSet×0/);
  assert.match(html, /\{坏 JSON/, "坏 JSON 不抛不吞，原文如实显示");
  assert.match(html, /<td class="mono">—<\/td><\/tr>/, "payload=null ⇒ —");
});

test("轨14-页面骨架：提交后的就地提示有样式（.submit-pending）+ 守卫脚本随每页注入一次", () => {
  const page = renderPage({ title: "t", active: "features", bodyHtml: "<p>b</p>" });
  assert.match(page, /p\.submit-pending\s*{/);
  assert.match(page, /button:disabled\s*{/);
  assert.equal(page.split("<script>").length - 1, 1, "每页只注入一段守卫脚本");
  assert.ok(page.includes(SUBMIT_GUARD_SCRIPT), "脚本 = 单点常量，不在各处复制");
});

// ---------------------------------------------------------------------------
// 新增需求弹窗（REQ-v0.9.3-2026-09-26-04 Q1 · 需求列表页 V1 已退役 Q2/Q3，表单进弹窗）
// ---------------------------------------------------------------------------

test("REQ-04 renderNewRequirementDialog：dialog 骨架 + 关闭钮 + 表单区 = renderRequirementForm 逐字节复用", () => {
  const form = renderRequirementForm("flow", null, ["v0.9.0"]);
  const html = renderNewRequirementDialog("flow", null, ["v0.9.0"]);
  assert.match(html, /^<dialog class="fd" id="new-req-dialog">/, "骨架 = dialog.fd（错误卡叠加规则同款生效）");
  assert.match(html, /<button type="button" id="new-req-close">关闭<\/button>/);
  assert.match(html, /<div class="fd-body"><h2>提需求<\/h2>/, "表单区在 .fd-body 内");
  assert.ok(html.includes(form), "表单不重建：与 renderRequirementForm 输出逐字节一致");
  assert.ok(html.endsWith("</dialog>"), "骨架自封闭：错误卡由脚本 append 为 dialog 直接子节点");
});

test("REQ-04 renderNewRequirementDialog：字段/校验/组织选择器/锁版警示原样在弹窗内", () => {
  const html = renderNewRequirementDialog("flow-team", { tier: "ready", orgsDir: "C:/tmp/orgs" }, ["v0.9.0"]);
  assert.match(html, /name="group"/);
  assert.doesNotMatch(html, /name="group"[^>]*required/, "有默认组织 ⇒ 组织名允许留空（选择器逻辑不变）");
  assert.match(html, /留空 = 用板级默认 flow-team/);
  assert.match(html, /name="title" required/);
  assert.match(html, /name="version"/);
  assert.match(html, /name="requirement"/);
  assert.match(html, /<form method="post" action="\/requirements"/, "提交端点仍是 POST /requirements（Q2 保留）");
  assert.match(html, /data-submit="已提交，建需求中…"/);
  assert.match(html, /排期锁定.*v0\.9\.0/s, "已发版锁警示随表单进弹窗");
  assert.match(html, /组织目录根（orgsDir）<b>就绪<\/b>/, "orgsDir 三档提示随表单进弹窗");
});

test("REQ-04 renderNewRequirementDialog：未配默认组织 ⇒ 组织名必填；不传 orgsStatus ⇒ 无 orgsDir 行（同表单口径）", () => {
  const bare = renderNewRequirementDialog(null);
  assert.match(bare, /name="group" required/, "未配默认 ⇒ 必填（校验规则未变）");
  assert.doesNotMatch(bare, /组织目录根/);
});

// ---------------------------------------------------------------------------
// BD8（v0.9.4 D 档）提需求免选组织：只读展示 + hidden 值必发 + action 带空间前缀
// ---------------------------------------------------------------------------

test("BD8 renderRequirementForm（空间免选）：hidden group 值必发 + 只读展示 + action = /org/<名>/requirements", () => {
  const html = renderRequirementForm("组织乙", null, [], "组织甲");
  assert.match(html, /<form method="post" action="\/org\/%E7%BB%84%E7%BB%87%E7%94%B2\/requirements"/, "action 带组织前缀（无 JS 原生 POST 同路命中归一层）");
  assert.match(html, /<input type="hidden" name="group" value="组织甲">/, "hidden 值必须仍发出（回落链不可绕过）");
  assert.doesNotMatch(html, /<input name="group"/, "免选态不出可编辑组织输入");
  assert.doesNotMatch(html, /placeholder="如 flow-team"/, "placeholder 一并不出（非可填字段）");
  assert.match(html, /组织 = <b>组织甲<\/b>/, "只读展示路径组织");
  assert.match(html, /board_org_mismatch/, "mismatch 执法提示在表单内");
  assert.doesNotMatch(html, /留空 = 用板级默认/, "空间档不提示板级默认");
});

test("BD8 renderRequirementForm（空间免选）：hidden 值随 FormData 发出（URLSearchParams 形状钉）", () => {
  const html = renderRequirementForm(null, null, [], "组织甲");
  const m = html.match(/<input type="hidden" name="(\w+)" value="([^"]*)">/);
  assert.ok(m !== null, "hidden 字段形状 = name/value 字面量");
  const data = new URLSearchParams();
  data.append(m[1], m[2]);
  assert.equal(data.get("group"), "组织甲", "组织值可被表单序列化携带");
});

test("BD8 renderRequirementForm（空间免选）：组织名 HTML 转义进 hidden/展示（含引号与尖括号不出结构）", () => {
  const html = renderRequirementForm(null, null, [], 'a"b<c>');
  assert.match(html, /value="a&quot;b&lt;c&gt;"/);
  assert.doesNotMatch(html, /value="a"b/);
});

test("BD8 renderRequirementForm（全局档零改动）：spaceOrg 缺省/空白 ⇒ 与既有可编辑组织字段逐字节同形", () => {
  const before = renderRequirementForm("flow");
  assert.match(before, /<form method="post" action="\/requirements"/, "全局页 action 不带前缀");
  assert.match(before, /<label>组织名 <input name="group" placeholder="如 flow-team"><\/label>/);
  assert.equal(renderRequirementForm("flow", null, [], null), before, "spaceOrg=null 显式传 ⇒ 与缺省一致");
  assert.equal(renderRequirementForm("flow", null, [], "   "), before, "纯空白 spaceOrg ⇒ 视同全局档");
});

test("BD8 renderNewRequirementDialog：spaceOrg 透传表单区（骨架其余不变）", () => {
  const html = renderNewRequirementDialog("组织乙", null, [], "组织甲");
  assert.ok(html.includes(renderRequirementForm("组织乙", null, [], "组织甲")), "表单不重建：逐字节复用");
  assert.match(html, /^<dialog class="fd" id="new-req-dialog">/);
});

test("REQ-04 renderPage：headerActions 随标题渲染（页头「＋ 新增需求」按钮位）；缺省不出该元素", () => {
  const withBtn = renderPage({
    title: "排期看板",
    active: "schedule",
    bodyHtml: "<p>b</p>",
    headerActions: '<button type="button" id="new-req-open" class="header-actions">＋ 新增需求</button>',
  });
  assert.match(withBtn, /<h1>排期看板<\/h1><button type="button" id="new-req-open"/, "按钮紧随标题在页头");
  const plain = renderPage({ title: "t", active: "schedule", bodyHtml: "<p>b</p>" });
  assert.doesNotMatch(plain, /new-req-open/, "其它页无该按钮（不注入按钮位）");
});

test("B1 renderFeatureDetail: parentFeatureId 非空 ⇒ 标题徽标 + 深链；null ⇒ 无", () => {
  const html = renderFeatureDetail(
    { ...detailFixture, feature: { ...detailFixture.feature, parentFeatureId: "P1" } },
    null,
    "trace 关闭",
    NOW,
  );
  const head = html.slice(0, html.indexOf("</h2>"));
  assert.match(head, /增补 · 父需求 <a class="fl" href="\/features\/P1">P1<\/a>/);
  assert.doesNotMatch(renderFeatureDetail(detailFixture, traceFixture, null, NOW), /增补 · 父需求/);
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

// --- v0.9.5 C4：需求原文上详情页（常驻层 · 120 字截断 + 原生 details 展开全文，零脚本） ------

test("C4 renderFeatureDetail: 需求原文常驻层 —— 短文本直显 / 超长截断进 details / 转义 / 缺值不渲染", () => {
  const short = renderFeatureDetail(
    { ...detailFixture, feature: { ...detailFixture.feature, requirement: "要一个只读的排期导出" } },
    traceFixture,
    null,
    NOW,
  );
  assert.match(short, /<h2>需求原文<\/h2>\n<pre class="result">要一个只读的排期导出<\/pre>/);
  assert.doesNotMatch(short, /<details class="req-src">/, "不超长 ⇒ 不套折叠层（一眼看完的东西不该多点一下）");

  const long = renderFeatureDetail(
    { ...detailFixture, feature: { ...detailFixture.feature, requirement: "甲".repeat(200) } },
    traceFixture,
    null,
    NOW,
  );
  assert.match(long, /<details class="req-src"><summary>甲{120}…<\/summary><pre class="result">甲{200}<\/pre>/, "折叠态 = 截断 120 字，展开 = 全文");

  const unsafe = renderFeatureDetail(
    { ...detailFixture, feature: { ...detailFixture.feature, requirement: '<img src=x onerror="alert(1)">' } },
    traceFixture,
    null,
    NOW,
  );
  assert.doesNotMatch(unsafe, /<img src=x/, "原文一律转义（用户可控文本不得出结构）");
  assert.match(unsafe, /&lt;img src=x/);

  for (const requirement of [null, undefined, "", "  \n "]) {
    const html = renderFeatureDetail(
      { ...detailFixture, feature: { ...detailFixture.feature, requirement } },
      traceFixture,
      null,
      NOW,
    );
    assert.equal(html.includes("<h2>需求原文</h2>"), false, `${JSON.stringify(requirement)} ⇒ 整区不渲染（C2 空区块不渲染同款）`);
  }
});

// --- v0.9.5 T2 正锚：C1 第一屏拼接序 / C2 空区块短路 / C6 轮留痕 ---------------------------

test("C1 renderFeatureDetail 第一屏：字段表 → 引导行 → 需求原文（拼接序即「第一屏可见」的结构锚）", () => {
  const html = renderFeatureDetail(
    { ...detailFixture, feature: { ...detailFixture.feature, requirement: "要一个只读的排期导出" } },
    traceFixture,
    null,
    NOW,
    false,
    [],
    { nextStepHtml: '<p class="hint nextstep">下一步：等你 —— 测试引导行</p>' },
  );
  const marks = [
    html.indexOf("<h2>甲"),
    html.indexOf('<p class="hint nextstep">'),
    html.indexOf("<h2>需求原文</h2>"),
    html.indexOf('<details class="fold"'),
  ];
  assert.equal(marks.every((i) => i >= 0), true, "四层都在场");
  assert.deepEqual(
    [...marks].sort((a, b) => a - b),
    marks,
    "拼接序 = 字段表 → 引导行 → 需求原文 → 折叠层（引导行不上第一屏即回归）",
  );
});

test("C2 renderFeatureDetail 空区块短路：任务 0 ⇒ 任务表不出；trace 空节点 ⇒ 三面表不出；trace 读失败 ⇒ 不短路", () => {
  const empty = renderFeatureDetail({ ...detailFixture, tasks: [] }, { ...traceFixture, nodes: [] }, null, NOW);
  assert.equal(empty.includes("<h2>任务（"), false, "任务 0 ⇒ 任务表整节不渲染");
  assert.equal(empty.includes('<td class="mono">read_lane_running</td>'), false, "trace 成功但空 ⇒ 三面表不出");
  assert.equal(empty.includes("执行明细"), false, "任务 0 ∧ trace 空 ⇒ 执行明细区整体消失（C2 的验收面）");

  const withTask = renderFeatureDetail(detailFixture, traceFixture, null, NOW);
  assert.match(withTask, /<h2>任务（1）<\/h2>/, "对照：有任务照常渲染");
  assert.match(withTask, /<td class="mono">read_lane_running<\/td>/, "对照：trace 有非终态节点照常渲染");

  const failed = renderFeatureDetail(detailFixture, null, "桥返回 HTTP 500", NOW);
  assert.match(failed, /进展三面.*trace 读取失败/s, "读失败不属短路范围（不静默，既有锚同款）");
});

test("C2 renderAcceptanceSection 短路④：单段 ∧ 零失败 ⇒ 整节不渲染；多段或有失败 ⇒ 照渲染", () => {
  assert.equal(
    renderAcceptanceSection({
      stages: [{ state: "waiting_approval", enteredAt: "e0", leftAt: null }],
      failures: [],
      stateCounts: {},
    }),
    "",
    "单段零失败 = 零信息量 ⇒ 不渲染",
  );
  assert.match(
    renderAcceptanceSection({
      stages: [
        { state: "waiting_approval", enteredAt: "e0", leftAt: "e1" },
        { state: "executing", enteredAt: "e1", leftAt: null },
      ],
      failures: [],
      stateCounts: {},
    }),
    /验收轨迹/,
    "对照：多段轨迹照常渲染",
  );
  assert.match(
    renderAcceptanceSection({
      stages: [{ state: "executing", enteredAt: "e0", leftAt: null }],
      failures: [{ eventId: 7, at: "e1", payload: null }],
      stateCounts: {},
    }),
    /验收轨迹/,
    "对照：有失败账单 ⇒ 单段也不短路",
  );
});

test("C6 renderTurnTrace 轮留痕：state/轮 id/时间一行 + 摘要折叠展开全文；null ⇒ 不渲染；未知态原样", () => {
  assert.equal(renderTurnTrace(null), "", "从未起轮 / 宿主面未装配 ⇒ 整行缺席（缺席不是错误）");

  const html = renderTurnTrace({
    turnId: "turn-0123456789abcdef",
    state: "succeeded",
    summary: "本轮结论：门禁全绿",
    at: "2026-09-29T08:00:00Z",
    errorCode: null,
  });
  assert.match(html, /<h2>最近一轮<\/h2>/);
  assert.match(html, /class="hint turn-trace"><b>有结论（succeeded）<\/b>/, "state = 中文（原值）双语口径");
  assert.match(html, /<span class="mono">turn-012<\/span>/, "轮 id 短形可核对");
  assert.match(html, /2026-09-29T08:00:00Z/, "时间 = 该轮最近一次时刻原样");
  assert.match(html, /<details class="fold turn-summary"><summary>本轮结论：门禁全绿<\/summary><pre class="result">本轮结论：门禁全绿<\/pre><\/details>/, "摘要折叠层展开 = 全文");
  assert.equal(html.includes("触发一轮"), false, "留痕行不得带回底层机制词");

  const long = renderTurnTrace({
    turnId: "t2",
    state: "failed",
    summary: "故".repeat(200),
    at: "2026-09-29T09:00:00Z",
    errorCode: "turn_upstream_unreachable",
  });
  assert.match(long, /<summary>故{120}…<\/summary><pre class="result">故{200}<\/pre>/, "折叠态 = 截断 120 字");
  assert.match(long, /失败（failed）/);
  assert.match(long, /<span class="mono">turn_upstream_unreachable<\/span>/, "失败轮带结构化错误码");

  const noTime = renderTurnTrace({ turnId: "t3", state: "已重试", summary: null, at: null, errorCode: null });
  assert.match(noTime, /<b>已重试<\/b>/, "未知轮态原样显示，不吞不猜");
  assert.match(noTime, /· —/, "at 缺 ⇒ 时间如实 —（不推算）");
  assert.equal(noTime.includes("turn-summary"), false, "无摘要 ⇒ 不套空折叠层");
});

// --- v0.9.6 N4（REQ-2026-09-30-02）：详情页「最近一轮」回执卡（两处渲染点之一，另一处见结果页锚） ----

const RECEIPT = { head: ["改了 views 与 server 装配", "补了四条锚"], todo: ["是否发版", "回执卡文案是否要调"], next: "等用户真机验收" };

test("N4 renderTurnTrace：有 receipt ⇒ 渲结构化回执卡（三行 + 待用户逐条 ①② + 展开指引 + 完整摘要折叠）", () => {
  const html = renderTurnTrace({
    turnId: "turn-0123456789abcdef",
    state: "succeeded",
    summary: "本轮结论：门禁全绿",
    at: "2026-09-30T08:00:00Z",
    errorCode: null,
    receipt: RECEIPT,
  });
  assert.match(html, /<div class="receipt-card">/, "回执卡容器");
  assert.match(html, /<p class="hint receipt-row"><b>要点<\/b> · 改了 views 与 server 装配<br>补了四条锚<\/p>/, "要点逐行");
  assert.match(html, /<b>待用户<\/b> · ① 是否发版<br>② 回执卡文案是否要调<\/p>/, "待用户逐条带圈号");
  assert.match(html, /<b>下一步<\/b> · 等用户真机验收<\/p>/, "下一步一句话");
  assert.match(html, /📄 文档产出见『阶段产出』区，展开查看/, "产出指引 = 静态行，且措辞含「展开」（该区默认收起）");
  assert.match(
    html,
    /<details class="fold turn-summary"><summary>完整摘要<\/summary><pre class="result">本轮结论：门禁全绿<\/pre><\/details>/,
    "摘要退入「完整摘要」折叠，内容仍是现状那枚 pre",
  );
  assert.equal(html.includes("<script"), false, "回执卡零脚本（折叠只用原生 details · N3 内联脚本闭集不扩）");
});

test("N4 renderTurnTrace：待用户「无」/ 要点缺 ⇒ 三行照常在场（不空渲、不臆造）", () => {
  const html = renderTurnTrace({
    turnId: "t4",
    state: "succeeded",
    summary: null,
    at: null,
    errorCode: null,
    receipt: { head: [], todo: [], next: "" },
  });
  assert.match(html, /<b>要点<\/b> · —<\/p>/);
  assert.match(html, /<b>待用户<\/b> · 无<\/p>/, "空清单 = 「无」（与 receipt.ts 契约同口径）");
  assert.match(html, /<b>下一步<\/b> · —<\/p>/);
  assert.equal(html.includes("turn-summary"), false, "无摘要 ⇒ 不套空折叠层");
});

test("N4 renderTurnTrace：无 receipt（null / 键缺席 / agent 漏遵）⇒ 渲染与现状逐字节一致", () => {
  const base = {
    turnId: "t5",
    state: "failed",
    summary: "故".repeat(200),
    at: "2026-09-30T09:00:00Z",
    errorCode: "turn_upstream_unreachable",
  };
  const legacy = renderTurnTrace({ ...base });
  assert.equal(renderTurnTrace({ ...base, receipt: null }), legacy, "receipt = null ⇒ 与历史轮同一渲染");
  assert.equal(
    legacy,
    `<h2>最近一轮</h2>\n<p class="hint turn-trace"><b>失败（failed）</b> · <span class="mono">t5</span> · 2026-09-30T09:00:00Z · <span class="mono">turn_upstream_unreachable</span></p>\n<details class="fold turn-summary"><summary>故${"故".repeat(119)}…</summary><pre class="result">${"故".repeat(200)}</pre></details>`,
    "无回执 = C6 现状逐字节（容错退回，不劣于今天）",
  );
  assert.equal(legacy.includes("receipt-card"), false, "现状渲染不得带出回执卡痕迹");
});

// --- B-T4（3300 收编补差）：详情页任务行「三时刻 + 排队/执行时长」 --------------------------

const timingsTask = {
  taskId: "t9",
  projectId: "p",
  state: "completed",
  lane: "write",
  failureKind: null,
  retryCount: null,
  dependencies: null,
  createdAt: "2026-09-26T00:00:00Z",
  startedAt: "2026-09-26T00:01:30Z",
  finishedAt: "2026-09-26T00:06:30Z",
  queueState: "settled",
  queuedAt: "2026-09-26T00:00:00Z",
  claimedAt: "2026-09-26T00:01:00Z",
  claimedBy: "m1",
};

test("renderFeatureDetail: 任务行三时刻 + 排队时长（queuedAt→claimedAt）/ 执行时长（startedAt→finishedAt）", () => {
  const html = renderFeatureDetail(
    { ...detailFixture, tasks: [timingsTask] },
    null,
    "trace 关闭",
    NOW,
  );
  assert.match(html, /<th>创建<\/th><th>开始<\/th><th>结束<\/th><th>排队时长<\/th><th>执行时长<\/th>/);
  assert.match(html, /2026-09-26T00:01:30Z/);
  assert.match(html, /<td>1m 0s<\/td>/); // 排队时长 queuedAt→claimedAt = 60s
  assert.match(html, /<td>5m 0s<\/td>/); // 执行时长 startedAt→finishedAt = 300s
});

test("renderFeatureDetail: 任务行时刻/时长缺字段 ⇒ 新增 5 列全容错为 —（老桥容错，不炸页、不推算）", () => {
  const html = renderFeatureDetail(detailFixture, null, "trace 关闭", NOW);
  const start = html.indexOf('<tr><td class="mono">t1</td>');
  const end = html.indexOf("</tr>", start);
  const row = html.slice(start, end);
  const cells = row.slice("<tr>".length).split("</td>").slice(0, -1);
  assert.equal(cells.length, 12, "任务行固定 12 列（7 原有 + 三时刻 + 两时长）");
  assert.deepEqual(cells.slice(-5), ["<td>—", "<td>—", "<td>—", "<td>—", "<td>—"], "末 5 列（创建/开始/结束/排队/执行）缺字段 ⇒ 全 —");
});

test("renderFeatureDetail: 在飞任务（有 startedAt 无 finishedAt）执行时长如实 —（不做至 now 推算）", () => {
  const html = renderFeatureDetail(
    { ...detailFixture, tasks: [{ ...timingsTask, state: "working", finishedAt: null }] },
    null,
    "trace 关闭",
    NOW,
  );
  assert.doesNotMatch(html, /<td>5m 0s<\/td>/);
  assert.match(html, /<td>1m 0s<\/td>/); // 排队时长 queuedAt→claimedAt 不受在飞影响
  assert.ok(html.includes("<td>—</td></tr>"), "末列执行时长 = —");
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

// ---------------------------------------------------------------------------
// v0.9.2 M6：提需求 version 去必填 + 排期表单 GET 面 + 改版失联警示行
// ---------------------------------------------------------------------------

test("M6 renderRequirementForm：version 去必填（无 required、label 无 *），placeholder 提示「留空 = 未排期」", () => {
  const html = renderRequirementForm("flow");
  assert.match(html, /<label>版本<input name="version"[^>]*>/, "label 不得带 *");
  assert.doesNotMatch(html, /name="version"[^>]*required/, "version 不得再 required");
  assert.match(html, /name="version"[^>]*placeholder="[^"]*留空 = 未排期/);
  assert.match(html, /<label>标题 \*<input name="title" required/, "title 仍必填（回归锚）");
});

test("M6 renderScheduleForm：单输入 + version 键恒携带 + 当前值回填 + POST 到排期写端点", () => {
  const html = renderScheduleForm("F1", "v0.9.2");
  assert.match(html, /action="\/features\/F1\/schedule"[^>]*data-submit="[^"]+"/, "写表单恒带防连点文案（轨14 同规格）");
  assert.match(html, /name="version" value="v0\.9\.2"/, "当前版本回填");
  assert.match(html, /留空 = 删除排期/);
  assert.match(renderScheduleForm("F1", null), /name="version" value=""/, "未排期 ⇒ 空值回填（键仍恒在）");
});

test("M6 registeredDecisionDocVersions：取 decisions 里的文档版本段（去重、无 .md ⇒ 空）", () => {
  const decisions = JSON.stringify([
    "doc/v0.9.1/甲-改造文档.md 已确认",
    "doc/v0.9.1/甲-需求确认单.md",
    "doc/v0.9.2/乙-改造文档.md",
    "无路径的一条 note",
  ]);
  assert.deepEqual(registeredDecisionDocVersions(decisions), ["v0.9.1", "v0.9.2"]);
  assert.deepEqual(registeredDecisionDocVersions(null), []);
});

test("M6 renderVersionSwitchWarningLine：登记版本 ≠ 当前版本 ⇒ 警示行；一致 / 无登记 ⇒ 空串", () => {
  const decisions = JSON.stringify(["doc/v0.9.1/甲-改造文档.md"]);
  const warn = renderVersionSwitchWarningLine(decisions, "v0.9.2");
  assert.match(warn, /文档读锚将随版本切换/);
  assert.match(warn, /class="hint warn"/);
  assert.match(warn, /v0\.9\.1/, "点名失联的旧版本");
  assert.match(warn, /不搬文档目录/);
  assert.equal(renderVersionSwitchWarningLine(decisions, "v0.9.1"), "", "版本一致 ⇒ 不警示");
  assert.equal(renderVersionSwitchWarningLine(null, "v0.9.2"), "", "无文档登记 ⇒ 不警示");
  assert.equal(renderVersionSwitchWarningLine(JSON.stringify(["纯 note，无文档"]), "v0.9.2"), "");
  assert.match(renderVersionSwitchWarningLine(decisions, ""), /当前版本（<code>未排期<\/code>）/, "改到未排期也如实点名");
});

test("renderFeatureDetail 阶段产出（按需求归约）：警示行 + 清单 + note 条目三区共存", () => {
  const detail = structuredClone(detailFixture);
  detail.feature.version = "v0.9.2";
  detail.feature.decisions = JSON.stringify([
    "本轮裁决：数据源改 decisions 驱动",
    "产出：doc/v0.9.1/甲-改造文档.md",
  ]);
  const html = renderFeatureDetail(detail, null, null, NOW);
  assert.match(html, /<h2>阶段产出<\/h2>/);
  assert.match(html, /class="hint warn"[\s\S]*文档读锚将随版本切换/, "失联警示在区内");
  assert.match(html, />甲-改造文档\.md<\/a>/, "警示不吞条目");
  assert.match(html, /本轮裁决：数据源改 decisions 驱动/, "非 doc 条目同区保留");
  assert.doesNotMatch(html, /产出登记（decisions）/, "旧第二区已合并消失");
});

test("registeredDecisionDocVersions 只认 doc/ 前缀登记：裸版本目录形态与提及 README 不计警示", () => {
  const decisions = JSON.stringify(["参照 v0.9.1/乙-改造文档.md（他需求路径，非本需求登记）", "口径见 README.md", "doc/v0.9.1/甲-需求确认单.md"]);
  assert.deepEqual(registeredDecisionDocVersions(decisions), ["v0.9.1"]);
  assert.equal(registeredDecisionDocVersions(JSON.stringify(["doc/甲-需求确认单.md"])).length, 0, "单段无版本 ⇒ 不产警示版本段");
});

test("M6 renderFeatureDetail：withScheduleForm=true ⇒ 排期表单在本页（GET 面）；缺省不渲染（向后兼容）", () => {
  const withForm = renderFeatureDetail(detailFixture, null, null, NOW, true);
  assert.match(withForm, /action="\/features\/F1\/schedule"/);
  assert.match(withForm, /<h2>排期<\/h2>/);
  const without = renderFeatureDetail(detailFixture, null, null, NOW);
  assert.doesNotMatch(without, /\/features\/F1\/schedule/, "调用方未接线 ⇒ 不渲染（旧行为不变）");
});

test("N3 renderRequirementForm：orgsDir 三档提示（未装配 / 配了但不可用 / 就绪）；不传 ⇒ 不出行", () => {
  const bare = renderRequirementForm(null);
  assert.doesNotMatch(bare, /组织目录根/, "未传状态 ⇒ 不渲染提示行（向后兼容）");

  const notConfigured = renderRequirementForm(null, { tier: "not_configured" });
  assert.match(notConfigured, /board_orgs_dir_not_configured/, "未装配档沿用闭集 code");
  assert.match(notConfigured, /未装配/, "未装配档文案可见");

  const problem = renderRequirementForm(null, {
    tier: "problem",
    code: "board_orgs_dir_missing",
    message: "组织目录根不存在：C:/tmp/no-such ⇒ 不 spawn 进程",
  });
  assert.match(problem, /class="hint err"/, "不可用档走红字错误样式");
  assert.match(problem, /board_orgs_dir_missing/);
  assert.match(problem, /组织目录根不存在/, "diagnoseOrgsDir 原文照登");

  const ready = renderRequirementForm(null, { tier: "ready", orgsDir: "C:/tmp/orgs" });
  assert.match(ready, /就绪/);
  assert.match(ready, /C:\/tmp\/orgs/);
  assert.doesNotMatch(ready, /class="hint err"/, "就绪档不出错误样式");
});

test("BD11 renderHostPage 配置行：默认组织未配置时如实显示「由提需求表单给出」，不编造兜底组名", () => {
  const bare = renderHostPage({ entries: [], config: { orgsDir: "C:/tmp/orgs", defaultOrg: null, kind: "claude" }, notice: null });
  assert.match(bare, /默认组织 = <code>（未配置 ⇒ 组织名由提需求表单给出）<\/code>/);
  assert.match(bare, /组织目录根 = <code>C:\/tmp\/orgs<\/code>/);

  const withDefault = renderHostPage({ entries: [], config: { orgsDir: null, defaultOrg: "flow-team", kind: "claude" }, notice: null });
  assert.match(withDefault, /默认组织 = <code>flow-team<\/code>/);
  assert.match(withDefault, /组织目录根 = <code>（未配置 ⇒ 详情页动作区提交将结构化 503）<\/code>/);
  // v0.9.5 C5：底层机制词从 UI 退场（本页与详情页同一个动作，说法必须一致）
  assert.doesNotMatch(bare, /触发一轮/);
  assert.doesNotMatch(withDefault, /触发一轮/);
});

test("C5 renderTurnOutcome：display 缺省时标题落「本轮结果：<结局>」，全页无「触发一轮」", () => {
  const outcome = (over = {}) => ({
    ok: true,
    org: "flow-team",
    featureId: "F1",
    disposition: "completed",
    queued: false,
    turnId: "turn-1",
    contextId: "ctx-1",
    round: 2,
    state: "completed",
    display: "",
    summary: "产出摘要",
    question: null,
    error: null,
    bridge: { pid: 4242, port: 8790, kind: "claude" },
    ...over,
  });
  const plain = renderTurnOutcome(outcome());
  assert.match(plain, /<h2>本轮结果：completed<\/h2>/, "display 为空 ⇒ 标题用「本轮结果」");
  assert.match(plain, /产出摘要/);
  assert.doesNotMatch(plain, /触发一轮/, "结果页与详情页同一个动作，说法不得回退");

  const withDisplay = renderTurnOutcome(outcome({ display: "需要你回答", disposition: "awaiting_answer" }));
  assert.match(withDisplay, /<h2>需要你回答<\/h2>/, "display 有值 ⇒ 如实显示，不被兜底覆盖");
  assert.doesNotMatch(withDisplay, /触发一轮/);
});

test("N4 renderTurnOutcome：结果页带回执 ⇒ 渲「本轮回执」卡（摘要退入完整摘要）；无回执 ⇒ 现状平铺", () => {
  const outcome = (over = {}) => ({
    ok: true,
    org: "flow-team",
    featureId: "F1",
    disposition: "completed",
    queued: false,
    turnId: "turn-1",
    contextId: "ctx-1",
    round: 2,
    state: "completed",
    display: "",
    summary: "产出摘要",
    question: null,
    receipt: null,
    error: null,
    bridge: { pid: 4242, port: 8790, kind: "claude" },
    ...over,
  });

  const plain = renderTurnOutcome(outcome());
  assert.match(plain, /<h2>本轮产出（摘要）<\/h2><pre class="result">产出摘要<\/pre>/, "无回执 ⇒ 摘要平铺 = 现状");
  assert.equal(plain.includes("receipt-card"), false, "拒单/无回执档不得带出回执卡痕迹");

  const keyed = renderTurnOutcome(outcome({ receipt: RECEIPT }));
  assert.match(keyed, /<h2>本轮回执<\/h2>/, "有回执 ⇒ 标题换「本轮回执」");
  assert.match(keyed, /<div class="receipt-card">[\s\S]*<b>要点<\/b> · 改了 views 与 server 装配[\s\S]*<b>下一步<\/b> · 等用户真机验收[\s\S]*<\/div>/);
  assert.match(keyed, /📄 文档产出见『阶段产出』区，展开查看/);
  assert.match(keyed, /<details class="fold turn-summary"><summary>完整摘要<\/summary><pre class="result">产出摘要<\/pre><\/details>/, "摘要不丢：折叠层内仍是现状 pre");
  assert.equal(keyed.includes("<script"), false, "结果页同样零脚本");

  const noKey = { ...outcome() };
  delete noKey.receipt;
  assert.equal(renderTurnOutcome(noKey), plain, "receipt 键缺席（老调用方）⇒ 与现状逐字节一致");
});

// ---------------------------------------------------------------------------
// BD18 → v0.9.5 C5 档位化：确认档只在审批门出现 + 「下一步」引导行（视图层）
// ---------------------------------------------------------------------------

test("BD18（档位化）：待审批 ⇒ 确认档按钮可点（无 disabled）+ 诚实口径仍在折叠层 + 无补充框", () => {
  const html = renderActionArea("F1", actionInput({ approval: "待审批" }));
  assert.match(html, /<button type="submit">确认改造文档 → 放行执行<\/button>/);
  assert.doesNotMatch(html, /disabled/, "待审批档不得出现 disabled");
  assert.match(html, /action="\/features\/F1\/confirm"/);
  assert.match(html, /不存在「板上批准」/, "既有的诚实文案不丢（折叠层里，展开可见）");
  assert.match(html, /feature_approval_not_ready/, "文案仍明说 agent 可能不放行的例子");
  assert.doesNotMatch(html, /name="supplement"/, "确认档是固定指令模板通道，不掺自由文本");
});

test("BD18（负向 · 原「禁用不隐藏」定向推翻）：未发起 ⇒ 不出现确认入口，改出闲置档（可点 + 补充框）", () => {
  const html = renderActionArea("F1", actionInput({ approval: "未发起" }));
  assert.doesNotMatch(html, /action="\/features\/F1\/confirm"/, "非确认门不渲染确认块");
  assert.doesNotMatch(html, /disabled/, "闲置档不是灰态");
  assert.match(html, /<button type="submit">让 agent 继续<\/button>/);
  assert.match(html, /<textarea name="supplement"/, "turn 档带补充框");
  assert.doesNotMatch(html, /触发一轮/, "UI 不出现底层机制词");
});

test("BD18（档位化）：已通过 / 未知 approval 值 ⇒ 一律不渲染确认块（门只开一次，未知值不猜）", () => {
  for (const approval of ["已通过", "X<Y"]) {
    const html = renderActionArea("F1", actionInput({ approval, state: "executing" }));
    assert.doesNotMatch(html, /action="\/features\/F1\/confirm"/, `${approval} 不得出现确认入口`);
    assert.doesNotMatch(html, /X<Y|X&lt;Y/, "未知 approval 值不进动作区文案（不自造解释）");
  }
});

test("BD18（负向）：宿主面未装配 ⇒ 动作区不渲染（无 turn/confirm 入口），引导行说明原因", () => {
  assert.equal(renderActionArea("F1", actionInput({ hostFaceAssembled: false, approval: "待审批" })), "");
  assert.match(renderNextStepGuide(actionInput({ hostFaceAssembled: false })), /宿主面未装配/);
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
