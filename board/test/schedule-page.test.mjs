/**
 * REQ-v0.9.2-2026-09-25-02 · M4 排期看板（只读）+ M5 需求池 ——
 * 分组纯函数（version-order 数值序 + 未排期滤除）/ 卡片渲染（状态徽标 · 无按状态分列）/
 * 需求池（判据 = 未排期 ∧ 非终态（三终态不进池）、池序 createdAt 降序 null 落底 featureId 兜底、卡上需求原文截断转义）/
 * HTTP 面（**v0.9.6 B5a**：全局 `/schedule` 退役 ⇒ GET 303 回门户、非 GET 405；看板宿主 = 空间排期页
 * `/org/alpha/schedule` 200 + 空间导航当前项 / 桥不可达 502）/ 导航闭集三枚（见 `orgs-page` N6-⑫）。
 * REQ-v0.9.2-2026-09-26-02 增补 ④ —— 详情浮层：dialog 骨架 + 内联脚本常量规格 + `<a>` 回退。
 * REQ-2026-09-26-02 T5 —— 拖拽排期视图闸：可拖属性仅「想法挪版」态出、锁态置灰 + 紧凑标记（增补 ①
 * 降噪：长说明只在 409 错误卡）、
 * `#schedule-board` / 列 `data-version`（池列空串）落点、拖拽脚本常量规格（与浮层常量分立）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  groupFeaturesByVersion,
  renderSchedule,
  selectRequirementPool,
} from "../dist/web/views.js";
import {
  DRAG_SCHEDULE_SCRIPT,
  FEATURE_DETAIL_OVERLAY_SCRIPT,
  NEW_REQUIREMENT_DIALOG_SCRIPT,
  SUBMIT_GUARD_SCRIPT,
  renderPage,
} from "../dist/web/layout.js";
import { createBoardServer } from "../dist/server.js";
import { engineNoLockFetcher } from "./engine-versions-fixture.mjs";

function feature(featureId, version, overrides = {}) {
  return {
    featureId,
    state: "executing",
    title: `需求 ${featureId}`,
    requirement: null,
    taskCount: 1,
    ownerGroup: "alpha",
    stage: "改造方案",
    version,
    approval: "已通过",
    createdAt: "c",
    updatedAt: "u",
    stateCounts: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 分组纯函数
// ---------------------------------------------------------------------------

test("M4-① groupFeaturesByVersion: 未排期（null/空串/纯空格）滤除，trim 归一并列", () => {
  const cols = groupFeaturesByVersion([
    feature("F1", null),
    feature("F2", ""),
    feature("F3", "   "),
    feature("F4", " v0.9.2 "),
    feature("F5", "v0.9.2"),
  ]);
  assert.deepEqual(cols.map((c) => c.version), ["v0.9.2"]);
  assert.deepEqual(cols[0].features.map((f) => f.featureId), ["F4", "F5"], "归一后同版并入同一列");
});

test("M4-② groupFeaturesByVersion: 列序 = semver 数值序（v0.9.x 在 v0.10.0 左），非 x.y.z 字典序垫底", () => {
  const cols = groupFeaturesByVersion([
    feature("F1", "v0.10.0"),
    feature("F2", "v0.9.0"),
    feature("F3", "v0.9.2"),
    feature("F4", "backlog-x"),
    feature("F5", "backlog-a"),
    feature("F6", "v1.0.0"),
  ]);
  assert.deepEqual(cols.map((c) => c.version), [
    "v0.9.0",
    "v0.9.2",
    "v0.10.0",
    "v1.0.0",
    "backlog-a",
    "backlog-x",
  ]);
});

test("M4-③ groupFeaturesByVersion: 列内保持入参顺序（不做列内二次排序，卡片不跳位）", () => {
  const cols = groupFeaturesByVersion([
    feature("F2", "v0.9.2", { updatedAt: "2026-01-01" }),
    feature("F1", "v0.9.2", { updatedAt: "2026-09-09" }),
  ]);
  assert.deepEqual(cols[0].features.map((f) => f.featureId), ["F2", "F1"]);
});

// ---------------------------------------------------------------------------
// 渲染纯函数
// ---------------------------------------------------------------------------

test("M4-④ renderSchedule: 列头 = 版本号 + 卡片数；卡固定四行（增补五 件A）= 名称 / id 行 / 状态徽标 / 一行元信息（阶段 + 任务数）", () => {
  const cols = groupFeaturesByVersion([
    feature("F1", "v0.9.2"),
    feature("F2", "v0.9.2", { state: "waiting_approval", approval: "待审批", taskCount: null }),
  ]);
  const html = renderSchedule(cols);
  assert.match(html, /<h3>v0\.9\.2 <span class="kbadge vbadge wip"[^>]*>进行中<\/span> <span class="muted">\(2\)<\/span><\/h3>/, "列头 = 版本号 + 状态徽标（增补 ② 后恒有）+ 卡片数");
  assert.match(html, /href="\/features\/F1"/, "卡标题链详情页");
  assert.match(html, /<span class="kbadge">执行中（executing）<\/span>/, "状态作徽标");
  assert.match(html, /待审批（waiting_approval）/, "第二卡徽标 = 待审批（审批门摘出元信息行后仍由状态徽标承载）");
  assert.match(html, /阶段：改造中 · 任务数：1<\/p>/, "元信息行 = 阶段 + 任务数（件3 一行 11px；派生档不带后缀）");
  assert.match(html, /阶段：改造方案 · 任务数：—<\/p>/, "第二卡：登记档 + taskCount null 如实「—」");
  assert.doesNotMatch(html, /审批门：/, "审批门不再上卡面（其值 = 状态徽标，登记字段原样在详情页）");
  assert.doesNotMatch(html, /（登记）|（派生）/, "阶段档的「派生 / 登记」后缀摘出卡面");
  assert.match(html, /任务数：—<\/p>/, "taskCount null 如实「—」");
  assert.doesNotMatch(html, /class="kcol"[^>]*><h3>[^<]*待审批/, "按状态分列不做：列头只有版本号");
});

test("M4-⑤ renderSchedule: 空看板如实文案（未排期不进本页，归需求池）；标题 XSS 转义", () => {
  assert.match(renderSchedule([]), /无已排期需求/);
  assert.match(renderSchedule([]), /需求池/);
  const html = renderSchedule(groupFeaturesByVersion([feature("F1", "v0.9.2", { title: '<img src=x onerror="1">' })]));
  assert.doesNotMatch(html, /<img src=x/, "title 原文不得进 HTML");
  assert.match(html, /&lt;img src=x/, "title 转义后呈现");
});

// ---------------------------------------------------------------------------
// M5 需求池
// ---------------------------------------------------------------------------

test("M5-① selectRequirementPool: 判据 = 未排期 trim()===\"\"（且非终态，见 M5-④）；池序 createdAt 降序、null 落底、featureId 兜底稳定", () => {
  const pool = selectRequirementPool([
    feature("F-b", null, { createdAt: "2026-09-01T00:00:00Z" }),
    feature("F-d", "  ", { createdAt: null }),
    feature("F-a", "v0.9.2", { createdAt: "2026-09-05T00:00:00Z" }),
    feature("F-c", "", { createdAt: "2026-09-09T00:00:00Z" }),
    feature("F-e", "", { createdAt: undefined }),
  ]);
  assert.deepEqual(
    pool.map((f) => f.featureId),
    ["F-c", "F-b", "F-d", "F-e"],
    "新在前；null/undefined 落底且按 featureId 兜底（F-d < F-e）；已排期 F-a 不入池",
  );
  const again = selectRequirementPool([...pool].reverse());
  assert.deepEqual(again.map((f) => f.featureId), pool.map((f) => f.featureId), "结果与输入顺序无关（不依赖 orch 列表序）");
});

test("M5-② renderSchedule 池卡: 需求原文截断 120 字 + 转义 + 链详情页；空 requirement 不出行", () => {
  const long = "甲".repeat(130);
  const pool = selectRequirementPool([
    feature("F1", null, { requirement: long }),
    feature("F2", "", { requirement: `<img src=x onerror="1">` }),
    feature("F3", null, { requirement: "" }),
    feature("F4", null, { requirement: null }),
  ]);
  const html = renderSchedule(groupFeaturesByVersion([feature("F9", "v0.9.2", { requirement: long })]), pool);
  assert.match(html, /甲{120}…/, "截断 120 字 + 省略号");
  assert.doesNotMatch(html, /甲{121}/, "第 121 字不得泄漏");
  assert.doesNotMatch(html, /<img src=x/, "requirement 原文不得进 HTML");
  assert.match(html, /&lt;img src=x/, "requirement 转义后呈现");
  const f1seg = html.slice(html.indexOf('href="/features/F1"'), html.indexOf('href="/features/F2"'));
  assert.match(f1seg, /需求：甲{120}…/, "池卡 = 标题链详情页 + 需求原文行");
  const f3seg = html.slice(html.indexOf('href="/features/F3"'), html.indexOf('href="/features/F4"'));
  assert.doesNotMatch(f3seg, /需求：/, "空串 requirement 不出行");
  const f4seg = html.slice(html.indexOf('href="/features/F4"'));
  assert.doesNotMatch(f4seg, /需求：/, "null requirement 不出行");
  const versionCol = html.slice(html.indexOf('<div class="kcol" data-version="v'));
  assert.doesNotMatch(versionCol, /需求：/, "版本列卡不出需求原文行（池卡专属）");
});

test("M5-③ renderSchedule 池列恒在: 空池如实提示（含终态卡不进池）；无版本列时提示都在池", () => {
  assert.match(renderSchedule([], []), /<h3>需求池 <span class="muted">\(0\)<\/span><\/h3>/);
  assert.match(renderSchedule([], []), /（无未排期的在途需求 · 终态卡不进需求池）/);
  const html = renderSchedule([], selectRequirementPool([feature("F1", null)]));
  assert.match(html, /无已排期需求.*都在需求池列/s);
  assert.match(html, /\/features\/F1/);
});

test("M5-④ selectRequirementPool: 三终态（completed/failed/cancelled）不进池；非终态与 state=null 照入", () => {
  const pool = selectRequirementPool([
    feature("F-done", "", { state: "completed" }),
    feature("F-fail", null, { state: "failed" }),
    feature("F-cancel", "  ", { state: "cancelled" }),
    feature("F-wait", "", { state: "waiting_approval" }),
    feature("F-run", "", { state: "executing" }),
    feature("F-int", "", { state: "integrating" }),
    feature("F-input", "", { state: "needs_input" }),
    feature("F-rev", "", { state: "reviewing" }),
    feature("F-null", "", { state: null }),
    feature("F-unknown", "", { state: "some-future-state" }),
  ]);
  assert.deepEqual(
    pool.map((f) => f.featureId).sort(),
    ["F-input", "F-int", "F-null", "F-rev", "F-run", "F-unknown", "F-wait"],
    "终态三卡被滤；非终态、state=null 与未知态一律放行（不吞不猜）",
  );
});

test("M5-⑤ 终态过滤只管池列：已排终态卡仍占版本列（不改 groupFeaturesByVersion）", () => {
  const features = [
    feature("F-done", "v0.9.4", { state: "completed" }),
    feature("F-cancel", "v0.9.4", { state: "cancelled" }),
    feature("F-open", "", { state: "executing" }),
  ];
  const html = renderSchedule(
    groupFeaturesByVersion(features),
    selectRequirementPool(features),
  );
  assert.match(html, /\/features\/F-done/, "版本列仍显示 completed 卡");
  assert.match(html, /\/features\/F-cancel/, "版本列仍显示 cancelled 卡");
});

// ---------------------------------------------------------------------------
// v0.9.3 B1 增补标注（排期卡 / 池卡 · fixture 自构造，不依赖真桥 O1）
// 增补五 件A（REQ-2026-10-02-05）：标注形态由「.khd 首因子 .kbadge 徽标」并入卡内第 2 行 id 行
// ---------------------------------------------------------------------------
test("B1-① renderSchedule 卡: parentFeatureId 非空 ⇒ 关联需求 id 并入第 2 行（不再单独置顶徽标）+ 单跳深链", () => {
  const html = renderSchedule(
    groupFeaturesByVersion([feature("A1", "v0.9.3", { parentFeatureId: "P1" })]),
    selectRequirementPool([feature("A2", null, { parentFeatureId: "P2" })]),
  );
  assert.match(
    html,
    /<span class="mono muted" title="P1"><a class="fl" href="\/features\/P1">P1<\/a><\/span>/,
    "版本列卡：关联需求 id = mono muted 短标 + 深链",
  );
  assert.match(html, /title="P2"><a class="fl" href="\/features\/P2">P2<\/a><\/span>/, "池卡同款关联需求 id");
  assert.doesNotMatch(html, /<span class="kbadge">增补 · 父需求/, "「增补 · 父需求」徽标形态退役（排期卡不再单独置顶）");
});

test("B1-② renderSchedule 卡: 无 parentFeatureId（缺省 null）⇒ 不出关联需求 id（老桥口径）", () => {
  const html = renderSchedule(groupFeaturesByVersion([feature("A1", "v0.9.3")]), []);
  assert.doesNotMatch(html, /增补 · 父需求/);
  assert.match(html, /<p class="kmeta"><span class="mono muted" title="A1">A1<\/span><\/p>/, "id 行只有本卡短 id");
});

test("B1-③ 关联需求 id 只取一层不递归：父链 href 只做编码拼接 + 文本转义", () => {
  const html = renderSchedule(
    groupFeaturesByVersion([feature("A1", "v0.9.3", { parentFeatureId: `P/x"><script>` })]),
    [],
  );
  assert.match(
    html,
    /href="\/features\/P%2Fx%22%3E%3Cscript%3E"/,
    "href 经 encodeURIComponent，不注入原串",
  );
  assert.doesNotMatch(html, /<script>/, "关联需求 id 文本不得逃逸成脚本");
});

// ---------------------------------------------------------------------------
// 增补五 件A（REQ-2026-10-02-05）：排期卡固定四行序（SSR 显示层）
// ---------------------------------------------------------------------------

test("增补五A-① 卡内行序 = 名称 → id 行 → 状态徽标 → 阶段+任务数（徽标搬出 .khd）", () => {
  const html = renderSchedule(groupFeaturesByVersion([feature("F1", "v0.9.7")]), []);
  const card = cardOf(html, "F1");
  const rows = [
    `<div class="khd"><a class="fl" href="/features/F1">需求 F1</a></div>`,
    `<p class="kmeta"><span class="mono muted" title="F1">F1</span></p>`,
    // 闸锁卡：紧凑锁定标记与状态徽标同处徽标行（两者字面未改）
    `<p class="kbadge-line"><span class="kbadge draglock">🔒 排期已锁</span><span class="kbadge">执行中（executing）</span></p>`,
    `<p class="kmeta">阶段：改造中 · 任务数：1</p>`,
  ];
  const at = rows.map((r) => card.indexOf(r));
  assert.ok(at.every((i) => i >= 0), `四行齐备：${JSON.stringify(at)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "行序固定（名称 → id → 徽标 → 元信息）");
  assert.doesNotMatch(card.slice(0, at[1]), /<span class="kbadge">/, "状态徽标不再与标题同层");
});

test("增补五A-② 样式面：徽标行新选择器在场 · .khd 首因子规则随徽标搬离而退役", () => {
  const page = renderPage({ title: "t", active: "features", bodyHtml: renderSchedule([], []) });
  assert.match(page, /\.kcard > \.kbadge-line {[^}]*justify-content: flex-end/);
  assert.doesNotMatch(page, /\.kcard > \.khd > \.kbadge:first-child/, "失效规则已删");
  assert.match(page, /\.kcard > \.khd > a {[^}]*-webkit-line-clamp: 2/, "名称 ≤2 行截断保留");
});

// ---------------------------------------------------------------------------
// 增补五 件B（REQ-2026-10-02-05）：排期卡按状态着色（9 态 → 6 档，左缘色条）
// ---------------------------------------------------------------------------

/** 取某张卡的卡根 class 属性值（cardOf 以 `<div class="kcard` 切段 ⇒ 段首到首个 `"` 即类名余部）。 */
function cardClasses(html, featureId) {
  const seg = cardOf(html, featureId);
  const m = /^([^"]*)"/.exec(seg);
  assert.ok(m, `${featureId} 卡根 class 属性未闭合`);
  return `kcard${m[1]}`;
}

test("增补五B-① 卡根档类 = 状态族（6 档闭集）· 行为判据字面未动", () => {
  const cases = [
    ["executing", "kst-brand"],
    ["integrating", "kst-brand"],
    ["testing", "kst-brand"],
    ["reviewing", "kst-brand"],
    ["waiting_approval", "kst-warn"],
    ["completed", "kst-ok"],
    ["failed", "kst-danger"],
    ["needs_input", "kst-neutral"],
    ["cancelled", "kst-neutral"],
    [null, "kst-neutral"],
    ["some-future-state", "kst-neutral"],
  ];
  for (const [state, tier] of cases) {
    const id = state ?? "NULL";
    // 闸锁形态（stage/approval 非「想法挪版」）⇒ 档类在 draglocked 之后，两态均出档
    const locked = cardClasses(renderSchedule(groupFeaturesByVersion([feature(id, "v0.9.7", { state })]), []), id);
    assert.equal(locked, `kcard draglocked ${tier}`);
    const openHtml = renderSchedule(
      groupFeaturesByVersion([feature(id, "v0.9.7", { state, stage: "需求分析", approval: "未发起" })]),
      [],
    );
    assert.equal(cardClasses(openHtml, id), `kcard ${tier}`, `放行卡 ${state} ⇒ ${tier}`);
    // 行为判据不回归：档类只是追加，draggable / data-feature / data-version 原样紧跟卡根 class 属性
    assert.match(
      cardOf(openHtml, id),
      new RegExp(`^ kst-[a-z]+" draggable="true" data-feature="${id}" data-version="v0\\.9\\.7"`),
      `放行卡 ${state} 的拖拽属性未因档类而位移`,
    );
  }
});

test("增补五B-② 样式面：六档左缘 3px 色条 + soft 底色 · 取色只引 --b- token（零新色值负钉）· 压暗降至 .75", () => {
  const page = renderPage({ title: "t", active: "features", bodyHtml: renderSchedule([], []) });
  const tiers = {
    brand: "--b-brand",
    warn: "--b-warn",
    ok: "--b-ok",
    locked: "--b-locked",
    danger: "--b-danger",
    neutral: "--b-line",
  };
  for (const [tier, token] of Object.entries(tiers)) {
    assert.match(
      page,
      new RegExp(`\\.kcard\\.kst-${tier} \\{[^}]*border-left: 3px solid var\\(${token}\\)[^}]*background: var\\(`),
      `${tier} 档：色条 + soft 底色`,
    );
    assert.doesNotMatch(
      page,
      new RegExp(`\\.kcard\\.kst-${tier} \\{[^}]*#[0-9a-fA-F]{3,8}`),
      `${tier} 档不得出现新色值字面`,
    );
  }
  assert.match(page, /\.kcard\.draglocked \{ opacity: \.75/);
  assert.doesNotMatch(page, /\.kcard\.draglocked \{ opacity: \.55/, "旧压暗档已退役（色条优先可见）");
  // 六档闭集不扩：档类名不得含 newver 子串（撞 w6 建版入口锚）
  assert.doesNotMatch(page, /kst-[a-z]*newver/, "档类名不占用 newver 子串");
});

// ---------------------------------------------------------------------------
// v0.9.3 B-T5 拖拽排期（视图层闸：可拖 = 想法挪版 · 置灰 = 需求已确认）
// ---------------------------------------------------------------------------

/** 取某张卡的完整 HTML（卡内无嵌套 div ⇒ 以 `<div class="kcard` 切段即可定位）。 */
function cardOf(html, featureId) {
  const cards = html.split('<div class="kcard').slice(1);
  const hit = cards.find((c) => c.includes(`href="/features/${featureId}"`));
  assert.ok(hit !== undefined, `未找到 ${featureId} 的卡片`);
  return hit;
}

test("T5-① 卡片拖拽属性: 仅「stage=需求分析 ∧ approval=未发起」出 draggable + data-feature/data-version；闸锁卡只留紧凑标记", () => {
  const html = renderSchedule(
    groupFeaturesByVersion([
      feature("IDEA", "v0.9.3", { stage: "需求分析", approval: "未发起" }),
      feature("CONFIRMED", "v0.9.3", { stage: "改造方案", approval: "已通过" }),
    ]),
    [],
  );
  const idea = cardOf(html, "IDEA");
  // 增补五 件B：卡根在 .kcard 之后追加 `kst-${档}`（纯显示类），拖拽属性紧随其后 ⇒ 锚容许档类
  assert.match(idea, /^ kst-[a-z]+" draggable="true"/, "想法卡可拖（属性挂在卡根节点上）");
  assert.match(idea, /data-feature="IDEA"/);
  assert.match(idea, /data-version="v0\.9\.3"/, "卡片带现版本 ⇒ 拖同列 = 无操作（脚本早退）");
  assert.doesNotMatch(idea, /draglocked|🔒 排期已锁/, "放行卡不置灰、不出锁定标记");
  const locked = cardOf(html, "CONFIRMED");
  assert.doesNotMatch(locked, /draggable=/, "已确认卡不出拖拽属性（不是「拖了再拒」）");
  assert.match(locked, /^ draglocked kst-[a-z]+"/, "置灰类（cardOf 以 kcard 起头切段 ⇒ 段首是类名余部）");
  // 增补 ① 降噪：卡面 = 紧凑标记（🔒 + 短文案），完整说明只随拖拽被拒的 409 错误卡呈现
  assert.match(locked, /<span class="kbadge draglock">🔒 排期已锁<\/span>/, "紧凑锁定标记在场");
  assert.doesNotMatch(locked, /需求确认单|本板不提供解除入口|Step 0/, "长文案（为何锁/解除入口/去处）不上卡面");
  assert.match(locked, /href="\/features\/CONFIRMED"/, "卡片仍可点击（拖不动 ≠ 打不开）");
});

test("T5-② 闸判据两条件缺一即锁（含老桥 null ⇒ fail-closed），与池卡同口径", () => {
  const cases = [
    ["approval 已发起", { stage: "需求分析", approval: "待审批" }],
    ["stage 已进改造方案", { stage: "改造方案", approval: "未发起" }],
    ["老桥缺登记字段", { stage: null, approval: null }],
  ];
  for (const [label, over] of cases) {
    const html = renderSchedule([], selectRequirementPool([feature("P1", null, over)]));
    assert.doesNotMatch(html, /draggable=/, `${label} ⇒ 池卡同样不可拖`);
    assert.match(html, /draglocked/, `${label} ⇒ 置灰`);
  }
  const open = renderSchedule([], selectRequirementPool([feature("P1", null, { stage: "需求分析", approval: "未发起" })]));
  assert.match(open, /draggable="true" data-feature="P1" data-version=""/, "池卡现版本 = 空串，仍带 data-version（拖到版本列才生效）");
});

test("T5-③ 看板容器与列落点: #schedule-board + 每列 data-version（池列 = 空串 = 清空排期）", () => {
  const html = renderSchedule(
    groupFeaturesByVersion([feature("F1", "v0.9.3"), feature("F2", "backlog-x")]),
    selectRequirementPool([feature("F3", null)]),
  );
  assert.match(html, /<div class="kanban" id="schedule-board">/, "拖拽脚本的单点锚");
  assert.match(html, /<div class="kcol" data-version="v0\.9\.3">/);
  assert.match(html, /<div class="kcol" data-version="backlog-x">/, "非 semver 列同样是落点");
  assert.match(html, /<div class="kcol" data-version="">\s*<h3>需求池/, "池列 data-version 空串 ⇒ 拖入 = 清空排期");
  assert.match(html, /data-version="backlog-x"/, "列版本经转义（不裸拼）");
});

test("T5-④ 拖拽脚本常量规格（与弹窗常量分立）：一段内联 · 零外源 · 零求值 · 不含用户数据", () => {
  assert.match(DRAG_SCHEDULE_SCRIPT, /^<script>/);
  assert.doesNotMatch(DRAG_SCHEDULE_SCRIPT, /<script[^>]*src=/, "无 src=（CSP 资产白名单不扩）");
  assert.doesNotMatch(DRAG_SCHEDULE_SCRIPT, /eval|new Function|document\.write/);
  const body = DRAG_SCHEDULE_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "");
  assert.doesNotMatch(body, /<\/script/, "脚本体内不得出现 </script 字面量");
  assert.doesNotMatch(DRAG_SCHEDULE_SCRIPT, /F1|v0\.9\./, "不嵌任何用户数据（列/卡数据只经 data-* 属性读取）");
  assert.notEqual(DRAG_SCHEDULE_SCRIPT, FEATURE_DETAIL_OVERLAY_SCRIPT, "与详情浮层常量分立、不可共置");
  assert.ok(!DRAG_SCHEDULE_SCRIPT.includes("feat-dialog"), "不含浮层逻辑（各管一事）");
});

// ---------------------------------------------------------------------------
// 增补 ④ 详情浮层（dialog 骨架 + 内联脚本常量 + 无 JS 回退）
// ---------------------------------------------------------------------------

test("N2-① 浮层脚本常量：一段内联 · 零外源 · 零求值 · 不含用户数据（SUBMIT_GUARD 同规格）", () => {
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /^<script>/);
  assert.doesNotMatch(FEATURE_DETAIL_OVERLAY_SCRIPT, /<script[^>]*src=/);
  assert.doesNotMatch(FEATURE_DETAIL_OVERLAY_SCRIPT, /eval|new Function|document\.write/);
  const body = FEATURE_DETAIL_OVERLAY_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "");
  assert.doesNotMatch(body, /<\/script/, "脚本体内不得出现 </script 字面量");
});

test("N2-② 浮层脚本行为锚：委托拦截 .kcard 详情链 / fetch+DOMParser 抽 main / showModal / 失败降级原生导航", () => {
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /addEventListener\("click"/, "document 级事件委托");
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /closest\("\.kcard"\)/, "只拦看板卡片内的链接");
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /a\[href\^="\/features\/"\]/, "拦截目标 = 详情页链");
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /preventDefault\(\)/);
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /fetch\(href/, "fetch 同 URL（不另拼端点）");
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /DOMParser/);
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /querySelector\("main"\)/, "抽取详情页 <main> 内层");
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /showModal\(\)/);
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /window\.location\.href = a\.href/, "fetch 失败 ⇒ 降级原生导航");
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /res\.ok/, "非 2xx 也走降级");
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /addEventListener\("cancel"/, "Esc 收起（returnValue 归零，不残留 closed-by）");
  // 旧口径「浮层内表单提交不拦截（整页 POST + PRG 落整页）」已被真浏览器反馈推翻（409 时主页面
  // 跳到错误页）：现行为 = dialog 内 POST 表单拦下来在浮层内提交，逐锚见 N2-⑦。
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /addEventListener\("submit"/, "浮层内表单拦截提交（旧「不拦截」口径已废）");
});

test("N2-⑤ 浮层脚本行为锚（增补轨）：浮层内同源内部链接 = 浮层内导航，卡片分支不变", () => {
  // 浮层内导航分支：#feat-dialog 内任意 a[href^="/"]（文档页 / 回到需求详情 / 渲染原文切换…）
  assert.match(
    FEATURE_DETAIL_OVERLAY_SCRIPT,
    /closest\('#feat-dialog a\[href\^="\/"\]'\)/,
    "浮层内同源内部链接拦截分支",
  );
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /hasAttribute\("target"\)/, "带 target 的链接不拦（让浏览器原生开新窗）");
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /open\(nav, false\)/, "浮层内导航复用同一 fetch+抽 main+搬运通路，且不做 toggle 关闭");
  // 卡片分支不变：仍拦 .kcard 详情链，且保留「同链再点 = 收起」的 toggle 行为
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /open\(a, true\)/, "卡片分支保留 toggle 收起 + 行为不变");
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /closest\("\.kcard"\)/, "卡片分支判据未动");
  // 两分支顺序：dialog 分支在前（浮层内链接先命中浮层分支），卡片分支兜后
  const dlgAt = FEATURE_DETAIL_OVERLAY_SCRIPT.indexOf('#feat-dialog a[href^="/"]');
  const cardAt = FEATURE_DETAIL_OVERLAY_SCRIPT.indexOf('a[href^="/features/"]');
  assert.ok(dlgAt !== -1 && cardAt !== -1 && dlgAt < cardAt, "浮层分支在卡片分支之前");
  // 浮层内导航不拦表单的旧口径已废（现行为浮层内提交 ⇒ 逐锚见 N2-⑦）
  // 根因锚（本轮）：浮层内导航的 fetch **必须**声明 Accept: "text/html" ⇒ 见 N2-⑥
});

test("N2-⑥ 根因锚（真浏览器反馈 ①）：文档读面按 Accept 双档分流 ⇒ 浮层 fetch 必须发 text/html", async () => {
  // 服务端事实（`handleFeatureDoc`）：Accept 含 text/html ⇒ 整页；否则 ⇒ text/plain 原文。
  // 浏览器 fetch() 缺省发 `Accept: */*` ⇒ 拿到纯文本 ⇒ DOMParser 无 <main> ⇒ 走 fallback()
  // 整页跳转（= 用户反馈「浮层内点文档链接仍跳页」）。本锚钉住两档差异 + 脚本发的是 HTML 档。
  const disk = mkdtempSync(join(tmpdir(), "board-n26-"));
  try {
    mkdirSync(join(disk, "doc", "v1.2.3"), { recursive: true });
    writeFileSync(join(disk, "doc", "v1.2.3", "probe.md"), "# 探针\n\n正文\n", "utf8");
    const client = {
      baseUrl: "http://fake",
      async getFeatures() {
        return { features: [feature("F1", "v1.2.3", { ownerGroup: "org1" })], stateCounts: null };
      },
      async getFeature(id) {
        return {
          feature: feature(id, "v1.2.3", {
            ownerGroup: "org1",
            decisions: JSON.stringify(["doc/v1.2.3/probe.md"]),
          }),
          tasks: [],
          acceptance: null,
        };
      },
      async getFeatureTrace() {
        return null;
      },
    };
    const handle = await createBoardServer({
      host: "127.0.0.1",
      port: 0,
      client,
      docs: { repoRoot: disk, orgsDir: join(disk, "orgs") },
    });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const docUrl = `${base}/features/F1/docs?file=probe.md`;
      const plain = await fetch(docUrl);
      const plainText = await plain.text();
      assert.equal(plain.status, 200, "缺省 Accept（*/*）⇒ 文档读面仍 200（不是错误面，纯靠档位区分）");
      assert.match(plain.headers.get("content-type") ?? "", /^text\/plain/, "缺省 Accept ⇒ text/plain 原文档");
      assert.ok(!plainText.includes("<main>"), "text/plain 档无 <main> ⇒ 浮层摘不到内容（本锚的反面）");

      const htmlRes = await fetch(docUrl, { headers: { accept: "text/html" } });
      const htmlText = await htmlRes.text();
      assert.equal(htmlRes.status, 200);
      assert.match(htmlRes.headers.get("content-type") ?? "", /^text\/html/, "Accept 含 text/html ⇒ 整页档");
      assert.ok(htmlText.includes("<main>"), "HTML 档含 <main> ⇒ 浮层可摘");

      // 脚本侧：三处 fetch（链接导航 + 浮层内提交 + 件B 进度轮询）都显式声明 HTML 档 ⇒ 缺一条即回归跳页缺陷
      const accepts = FEATURE_DETAIL_OVERLAY_SCRIPT.match(/Accept: "text\/html"/g) ?? [];
      assert.equal(accepts.length, 3, "open() / postForm() / pollOnce() 三处 fetch 均须发 Accept: text/html");
      assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /headers: \{ Accept: "text\/html" \} \}\)/, "链接分支带 Accept");
      assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /headers: \{ Accept: "text\/html" \},/, "提交分支带 Accept");
      // DOMParser 只在 parsePage 一处使用 ⇒ 换入/叠加两档共用同一摘取通路
      assert.equal((FEATURE_DETAIL_OVERLAY_SCRIPT.match(/new DOMParser\(\)/g) ?? []).length, 1, "摘取通路单点");
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("N2-⑦ 浮层内表单提交锚（真浏览器反馈 ②③）：只拦 dialog 内 POST · urlencoded · 成功换入浮层 / 4xx 错误卡叠加为 dialog 直接子元素 · 处理完恢复表单 · 降级原生提交", () => {
  const s = FEATURE_DETAIL_OVERLAY_SCRIPT;
  const CSS = renderPage({ title: "t", active: "schedule", bodyHtml: "" });
  // 委托 submit，且**只**拦浮层内的表单（dialog 外的表单与卡片分支行为不变 ⇒ 反馈 ③）
  assert.match(s, /addEventListener\("submit"/, "document 级 submit 委托");
  assert.match(s, /form\.closest\("#feat-dialog"\) === null\) return;/, "dialog 外表单直接放行（不拦）");
  assert.match(s, /toLowerCase\(\)\ !== "post"\) return;/, "非 POST 不拦（同提交守卫判据）");
  // 提交走 fetch，POST + **属性读取**的 action + 同源凭据；成功（303 自动跟随后）与 4xx/5xx 共用换入通路
  // （增补三 §9.2：不得直读 form.action —— 表单带 name="action" 字段时同名字段遮蔽该属性）
  assert.match(s, /var action = form\.getAttribute\("action"\) \|\| "";/, "提交目标 = getAttribute(\"action\")（属性读取防遮蔽）");
  assert.match(s, /fetch\(action, \{/, "fetch 表单 action 属性值（不另拼端点）");
  assert.match(s, /method: "POST"/);
  assert.match(s, /credentials: "same-origin"/);
  assert.match(s, /e\.preventDefault\(\);[\s\S]{0,400}?postForm\(form\);/, "拦下 submit 后进浮层提交通路（件A 的就地反馈插在两者之间）");
  // 件A（REQ-2026-09-29-02）：浮层分支**自带**就地反馈（整页档 SUBMIT_GUARD 对本表单 defaultPrevented 早退）
  assert.match(s, /function markPending\(form\) \{/, "件A 落点：markPending（浮层侧复刻提交守卫两动作）");
  assert.match(s, /if \(form\.getAttribute\("data-ov-pending"\) === "1"\) return;/, "件A 连点拦截：挂起标记二次到达即吞掉");
  assert.match(s, /if \(!markPending\(form\)\) return;/, "件A 反馈未落地（无提示行）⇒ 不发请求");
  assert.match(s, /form\.setAttribute\("data-ov-pending", "1"\);\n    postForm\(form\);/, "件A 顺序：先反馈后置挂起并派发（fetch 前完成）");
  // 编码钉：服务端写面用 new URLSearchParams(raw) 解析 ⇒ 必须 urlencoded，FormData 直投会发 multipart
  assert.match(s, /new URLSearchParams\(new FormData\(form\)\)/, "表单体 = urlencoded（非 multipart）");
  assert.doesNotMatch(s, /body: new FormData\(form\)/, "不得把 FormData 直接当 body（multipart ⇒ 字段全丢）");
  // 4xx/5xx（用户裁决 (a) + 真浏览器复测反馈 ①）：浮层保持原需求页（body 不替换 ⇒ 表单与已填输入
  // 原样不动），只抽 .err-ov-card **叠加为 dialog 直接子元素**（fixed 居中盖在内容之上，不进 .fd-body
  // 文档流）；「知道了」由委托摘卡（浮层不关），提交后表单由 restoreForm 复位 ⇒ 可改后重提交
  assert.match(s, /function parsePage\(html\)/, "解析收口 parsePage：main 与 .err-ov-card 一起摘");
  assert.match(s, /querySelector\("\.err-ov-card"\)/, "错误页 errorOverlay 卡单独可摘");
  assert.match(s, /if \(!res\.ok\) \{ return res\.text\(\)\.then/, "4xx/5xx 先取响应文本再走叠加通路（不再无脑换 body）");
  assert.match(s, /if \(r\.err\) \{/, "提交响应两档分流：err 分支存在");
  assert.match(s, /if \(parsed\.card !== null\) \{ showCard\(parsed\.card\); restoreForm\(form\); return; \}/, "抽到卡 ⇒ 只叠加并复位表单（不替换 body）");
  assert.match(s, /function dropCard\(\) \{\n    var kids = dlg\.children;/, "摘卡只扫 dialog 直接子元素（不碰 .fd-body）");
  assert.match(s, /function showCard\(card\) \{\n    dropCard\(\);\n    dlg\.appendChild\(card\);/, "错误卡 = dialog 直接子元素（覆盖层，非内容流），重提交前摘旧卡");
  assert.doesNotMatch(s, /body\.insertBefore\(card/, "不再把错误卡前置进 .fd-body 文档流（反馈 ① 的根因）");
  assert.match(CSS, /dialog\.fd > \.err-ov-card \{[^}]*position: fixed/, "错误卡 fixed 定位（盖在浮层内容之上）");
  assert.match(CSS, /dialog\.fd > \.err-ov-card \{[^}]*box-shadow: 0 0 0 100vmax/, "半透明遮罩 = 超大 spread shadow（不用 transform，避免打断 fixed 包含块）");
  assert.match(s, /if \(swapPage\(r\.text\)\) \{ restoreForm\(form\); \} else \{ nativeSubmit\(form\); \}\n        return;/, "抽不到卡 ⇒ 回退换入错误页 main（现行为）+ 复位表单；换不入才降级原生");
  assert.match(s, /closest\("#feat-dialog #err-ov-close"\)/, "浮层内「知道了」有委托处理");
  assert.match(s, /card\.parentNode\.removeChild\(card\);/, "点「知道了」= 摘掉错误卡（浮层不关）");
  // 反馈 ②：浮层内提交不跳页 ⇒ 提交守卫的禁用/提示行无人复位，本脚本处理完响应后主动恢复表单
  assert.match(s, /function restoreForm\(form\) \{/, "提交后恢复收口 restoreForm");
  assert.match(s, /querySelectorAll\("button\[disabled\]"\)/, "重新启用被守卫禁用的提交按钮");
  assert.match(s, /btns\[i\]\.removeAttribute\("aria-disabled"\);/, "连 aria-disabled 一起摘（否则读屏仍报禁用）");
  assert.match(s, /querySelector\("\.submit-pending"\)/, "摘掉「已提交，排期写入中」提示行");
  assert.match(s, /      startPoll\(okMain\);\n      restoreForm\(form\);/, "成功档：交棒轮询后复位表单（件B 起轮在前，复位不抢跑）");
  // 降级面：结构不可解析 / fetch 异常 ⇒ 原生提交（此前不动 body ⇒ 表单仍在文档内可 submit）
  assert.match(s, /function nativeSubmit\(form\) \{ restoreForm\(form\); form\.submit\(\); \}/, "降级 = 先恢复表单再原生 form.submit()");
  assert.match(s, /if \(data === null \|\| action === ""\) \{ nativeSubmit\(form\); return; \}/, "FormData 不可构造 / action 属性缺失 ⇒ 降级原生提交（不劣化）");
  assert.match(s, /if \(!swapPage\(r\.text\)\) \{ nativeSubmit\(form\); return; \}/, "响应不可解析 ⇒ 降级原生提交");
  assert.match(s, /\.catch\(function \(\) \{ nativeSubmit\(form\); \}\)/, "fetch 网络异常 ⇒ 降级原生提交");
  // 提交期间不改 body ⇒ 降级时表单仍是活节点（form.submit() 对未连接表单是空操作）
  assert.doesNotMatch(s, /body\.textContent = "提交中…"/, "提交前不清空 body（否则降级路径的表单已被摘走）");
  // 卡片分支 + dialog 内导航分支判据原样在位（反馈 ③）
  assert.match(s, /closest\('#feat-dialog a\[href\^="\/"\]'\)/, "浮层内链接分支未动");
  assert.match(s, /a\.closest\("\.kcard"\) === null\) return;/, "卡片分支未动");
});

test("N2-⑧ 浮层 409 错误卡去重（用户裁决 (a)）：有卡路径不触碰 swapPage ⇒ body 不被替换，只叠加卡", () => {
  const s = FEATURE_DETAIL_OVERLAY_SCRIPT;
  const at = s.indexOf("if (r.err) {");
  assert.ok(at !== -1, "postForm 的 4xx/5xx err 分支在位");
  const errBranch = s.slice(at, s.indexOf("return;\n      }", at));
  assert.ok(errBranch.length > 50, "err 分支体可切取");
  const cardPath = errBranch.slice(0, errBranch.indexOf("showCard(parsed.card); restoreForm(form); return;") + "showCard(parsed.card); restoreForm(form); return;".length);
  assert.doesNotMatch(cardPath, /swapPage/, "抽到卡的路径不整体替换 body（重复内容缺陷的根因已除）");
  assert.match(cardPath, /showCard\(parsed\.card\); restoreForm\(form\); return;/, "有卡 ⇒ 动作 = 叠加错误卡 + 复位表单后立即返回（不换 body）");
  // swapPage 只允许出现在无卡的回退位（卡判之后）
  assert.match(errBranch.slice(errBranch.indexOf("showCard")), /if \(swapPage\(r\.text\)\) \{ restoreForm\(form\); \} else \{ nativeSubmit\(form\); \}/, "无卡 ⇒ 回退才换入错误页 main（换入后复位表单）");
  // 成功分支维持现状：抽最终页 main 换入 body（详情在浮层内刷新）
  const okBranch = s.slice(s.indexOf("if (r.err) {") + 10, s.indexOf("}).catch(function () { nativeSubmit(form); });"));
  assert.match(okBranch, /if \(!swapPage\(r\.text\)\) \{ nativeSubmit\(form\); return; \}/, "2xx/3xx 成功分支 = swapPage 换入（换不入 ⇒ 降级原生提交后立即返回，不再走轮询）");
});

// REQ-2026-09-29-02 增补 · 件A：浮层提交就地反馈（整页档两动作复刻到浮层分支）
test("件A 浮层提交就地反馈锚：preventDefault 后 · fetch 前禁用提交钮并挂提示行（文案取 data-submit）", () => {
  const s = FEATURE_DETAIL_OVERLAY_SCRIPT;
  assert.match(s, /function markPending\(form\) \{/, "件A 落点 = markPending");
  assert.match(s, /if \(all\[i\]\.type !== "submit"\) continue;/, "只禁提交按钮（.type 属性判定）");
  assert.doesNotMatch(s, /button\[type=submit\]/, "浮层脚本内不得出现提交守卫的归类标记串（N3-⑦ 每枚恰好 1 处）");
  assert.match(s, /all\[i\]\.disabled = true;\n      all\[i\]\.setAttribute\("aria-disabled", "true"\);/, "禁用 + aria-disabled 同步（读屏一致）");
  assert.match(s, /p\.className = "hint submit-pending";/, "提示行 class 与整页档同名（restoreForm 一处摘净）");
  assert.match(s, /var note = form\.getAttribute\("data-submit"\)/, "提示文案取服务端 data-submit（动作区档 = 本轮可能跑数分钟）");
  // 时序钉：反馈必须在发 fetch 之前完成（否则数分钟窗口内仍无回执 = 本件要修的缺陷）
  const preventAt = s.indexOf("e.preventDefault();\n    // 件A");
  const markAt = s.indexOf("if (!markPending(form)) return;");
  const dispatchAt = s.indexOf("postForm(form);");
  const fetchAt = s.indexOf("fetch(action, {");
  assert.ok(preventAt > 0, "拦下 submit 的锚点在位（防被无声改写）");
  assert.ok(markAt > preventAt && markAt < dispatchAt, "先 preventDefault → 挂反馈 → 再进 postForm");
  assert.ok(s.indexOf("function postForm(form) {") < fetchAt, "fetch(action) 在 postForm 体内 ⇒ 只可能在挂载之后执行");
  // 连点防护归本分支（挂起标记 + 服务端 409）；整页档 SUBMIT_GUARD 的 defaultPrevented 早退语义不动
  assert.match(s, /if \(form\.getAttribute\("data-ov-pending"\) === "1"\) return;/, "二次提交直接吞掉（浮层侧自带）");
  assert.match(SUBMIT_GUARD_SCRIPT, /if \(e\.defaultPrevented\) return;/, "整页档守卫仍对已拦下的事件早退（整页行为零变化）");
  assert.match(s, /if \(parsed\.card !== null\) \{ showCard\(parsed\.card\); restoreForm\(form\); return; \}/, "失败档复位表单（可改后重提）");
});

// REQ-2026-09-29-02 增补 · 件B：就地进度轮询（复用既有详情读面，零新端点、有界、收口即停）
test("件B 就地进度轮询锚：提交成功后交棒轮询 · 读面 = GET 既有详情 URL · 有界 · 收口即停 · 零新端点", () => {
  const s = FEATURE_DETAIL_OVERLAY_SCRIPT;
  assert.match(s, /var POLL_INTERVAL_MS = \d+;/, "轮询间隔为常量（有界之一）");
  assert.match(s, /var POLL_MAX_TICKS = \d+;/, "轮数上限为常量（有界之二：窗口耗尽自然停）");
  assert.match(s, /if \(pollTicks >= POLL_MAX_TICKS\) \{ stopPoll\(\); return; \}/, "到顶即停，不再排下一拍");
  assert.match(s, /pollTicks \+= 1;/, "每拍计数（上限据此生效）");
  // 挂载：成功换页后按回包动作区决定起轮
  assert.match(s, /lastHref = action;\n      startPoll\(okMain\);/, "件B 挂载点 = 提交成功档（读面 URL 对齐本需求详情）");
  assert.match(s, /function startPoll\(main\) \{\n    stopPoll\(\);/, "起轮前先停旧轮 ⇒ 恒只一条链（连点不叠加）");
  assert.match(s, /if \(main === null \|\| !stillBusy\(main\)\) return;/, "回包已收口 ⇒ 根本不起轮");
  // 收口判据 = 读面动作区不再显示在飞 / 排队的轮次进度行
  assert.match(s, /function stillBusy\(main\) \{[\s\S]{0,160}\.turn-progress[\s\S]{0,80}在飞[\s\S]{0,40}排队中/, "收口判据取自 .turn-progress 文案（在飞 / 排队中）");
  assert.match(s, /if \(main === null \|\| !stillBusy\(main\)\) \{ stopPoll\(\); return; \}/, "收口 ⇒ 停轮（轮收口即停，不空转）");
  assert.match(s, /swapPage\(r\.text, false\);\n      schedulePoll\(\);/, "未收口 ⇒ 经既有 swapPage 刷真实进度后续排");
  // 零新增端点 / 零新增写面：轮询只用 GET 详情读面
  const poll = s.slice(s.indexOf("function pollOnce()"), s.indexOf("function startPoll("));
  assert.match(poll, /fetch\(pollUrl, \{ credentials: "same-origin", headers: \{ Accept: "text\/html" \} \}\)/, "轮询 = 同源 GET 既有详情读面（带 Accept ⇒ 与 open() 同规格）");
  assert.doesNotMatch(poll, /method: "POST"/, "轮询不得是写面（不重复起轮）");
  assert.doesNotMatch(s, /fetch\("\/api|fetch\(`\/|new WebSocket|EventSource|setInterval/, "零新端点、零新通道、零常驻定时器（闭集内自限）");
});

// REQ-2026-09-29-02 增补 · 件C：收口渲染不得把已关闭的浮层重新弹开
test("件C 竞态锚：swapPage 收 reopen 第二参 · 轮询传 false · 关浮层只 stopPoll 不 showModal · 关闭三路径停轮", () => {
  const s = FEATURE_DETAIL_OVERLAY_SCRIPT;
  assert.match(s, /function swapPage\(html, reopen\) \{/, "swapPage 增第二参 reopen");
  assert.match(s, /if \(reopen !== false && !dlg\.open\) \{ dlg\.showModal\(\); \}/, "仅显式 false 才抑制自弹开（用户动作档行为不变）");
  assert.match(s, /swapPage\(r\.text, false\);/, "后台轮询档 = reopen false");
  const poll = s.slice(s.indexOf("function pollOnce()"), s.indexOf("function startPoll("));
  assert.equal((poll.match(/dlg\.showModal\(\)/g) ?? []).length, 0, "轮询路径内零 showModal");
  assert.match(poll, /if \(!dlg\.open \|\| pollUrl === ""\) \{ stopPoll\(\); return; \}/, "浮层已关 ⇒ 停轮（发请求前与回包后各一道）");
  assert.ok((poll.match(/!dlg\.open/g) ?? []).length >= 2, "在飞期间被关闭也覆盖（回包后二次判定）");
  // 三条关闭路径都须停轮，防关窗后仍有后台 GET 打点
  assert.match(s, /closeBtn\.addEventListener\("click", function \(\) \{ stopPoll\(\); dlg\.close\(\);/, "关闭钮 ⇒ 先停轮");
  assert.match(s, /dlg\.addEventListener\("cancel", function \(\) \{ stopPoll\(\);/, "Esc ⇒ 先停轮");
  assert.match(s, /if \(!inBox\) \{ stopPoll\(\); dlg\.close\(\);/, "点遮罩 ⇒ 先停轮");
  assert.match(s, /if \(toggle && href === lastHref && dlg\.open\) \{ dlg\.close\(\);/, "卡片二次点击关闭的既有语义未动");
});

test("N2-③ renderSchedule：dialog 骨架恒空（不嵌用户数据）+ 卡片 <a href> 回退仍在", () => {

  const html = renderSchedule(
    groupFeaturesByVersion([feature("F1", "v0.9.2", { title: '<img src=x onerror="1">' })]),
    selectRequirementPool([feature("F2", null)]),
  );
  assert.match(html, /<dialog class="fd" id="feat-dialog">/);
  assert.match(html, /<div class="fd-body"><\/div>/, "骨架内容恒空，运行时才搬入节点");
  assert.match(html, /<a class="fl" href="\/features\/F1">/, "无 JS 回退：卡片标题仍是真链接");
  assert.match(html, /<a class="fl" href="\/features\/F2">/, "池卡同样保留真链接");
});

// ---------------------------------------------------------------------------
// 增补 ⑤ N4 列头版本状态徽标（仅显示，不执法）
// ---------------------------------------------------------------------------

test("N4-① renderSchedule: 锁版列头标「🔒 已发版」（title 提示排期锁定）；未锁版标「进行中」（增补 ② 补渲染，样式区分）", () => {
  const cols = groupFeaturesByVersion([feature("F1", "v0.9.1"), feature("F2", "v0.9.2")]);
  const html = renderSchedule(cols, [], ["v0.9.1"]);
  const lockedH3 = html.slice(html.indexOf("<h3>v0.9.1"), html.indexOf("</h3>", html.indexOf("<h3>v0.9.1")));
  assert.match(lockedH3, /<span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span>/, "锁版列头 = 已发版徽标");
  assert.match(lockedH3, /title="[^"]*锁定[^"]*"/, "徽标 title 提示锁语义");
  const openH3 = html.slice(html.indexOf("<h3>v0.9.2"), html.indexOf("</h3>", html.indexOf("<h3>v0.9.2")));
  assert.match(openH3, /<span class="kbadge vbadge wip"[^>]*>进行中<\/span>/, "未锁版（有未完成需求）列头 = 进行中徽标");
  assert.doesNotMatch(openH3, /vbadge locked|🔒/, "进行中不加锁样式、不显示锁标");
});

test("N4-② renderSchedule: 派生列（台账无该版）全终态卡 ⇒ 按阶段判「进行中」，不再出「已收尾」徽标（§9.4 增补九）", () => {
  const cols = groupFeaturesByVersion([
    feature("F1", "v0.9.0", { state: "completed" }),
    feature("F2", "v0.9.0", { state: "cancelled" }),
    feature("F3", "v0.9.2"),
  ]);
  const html = renderSchedule(cols);
  const closedH3 = html.slice(html.indexOf("<h3>v0.9.0"), html.indexOf("</h3>", html.indexOf("<h3>v0.9.0")));
  assert.match(closedH3, /<span class="kbadge vbadge wip"[^>]*>进行中<\/span>/, "已确认卡在场 ⇒ 进行中");
  assert.doesNotMatch(closedH3, /vbadge closed|已收尾/, "派生徽标闭集不再含「已收尾」（收尾与否由台账 released 表达）");
  assert.doesNotMatch(closedH3, /locked/, "未登记 releasedVersions ⇒ 不加锁样式");
});

test("N4-③ renderSchedule: 徽标不吞版本号与卡片数（列头判据原样），需求池列无徽标", () => {
  const html = renderSchedule(groupFeaturesByVersion([feature("F1", "v0.9.1")]), [feature("F2", null)], ["v0.9.1"]);
  assert.match(html, /<h3>v0\.9\.1 <span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span> <span class="muted">\(1\)<\/span><\/h3>/);
  // 件3 起需求池是**首列** ⇒ 池列段以「下一枚 `<div class="kcol"`」为右界（不得切到文档尾，否则会把版本列头的 vbadge 误算进来）
  const poolAt = html.indexOf("<h3>需求池");
  const poolH3 = html.slice(poolAt, html.indexOf('<div class="kcol"', poolAt));
  assert.doesNotMatch(poolH3, /vbadge/, "需求池列不出版本徽标");
});

// ---------------------------------------------------------------------------
// HTTP 面
// ---------------------------------------------------------------------------

function fakeClient(features, overrides = {}) {
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features, stateCounts: null };
    },
    ...overrides,
  };
}

async function withScheduleServer(client, run) {
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, client });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

test("M4-⑥（B5a 重指空间排期页）GET /org/alpha/schedule: 200 + 空间导航「排期」为当前项 + 列序（需求池最左 · 版本由大到小）；未排期卡在需求池列、不占版本列", async () => {
  const client = fakeClient([
    feature("F1", "v0.10.0"),
    feature("F2", "v0.9.2"),
    feature("F3", null),
    feature("F4", "  "),
  ]);
  await withScheduleServer(client, async (base) => {
    const res = await fetch(`${base}/org/alpha/schedule`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /<a class="fl on" href="\/org\/alpha\/schedule" style="font-weight:700">排期<\/a>/, "空间导航当前项 = 排期（B5a 起 NAV 无排期条 ⇒ 锚落空间导航行）");
    assert.doesNotMatch(text, /<a href="\/schedule"/, "NAV 不含 /schedule（B5a 摘条）");
    assert.match(text, /<h3>v0\.10\.0/, "v0.10.0 列在左（件3 由大到小）");
    assert.match(text, /<h3>v0\.9\.2/, "v0.9.2 列在右（较大版之后）");
    assert.ok(
      text.indexOf("<h3>v0.10.0") < text.indexOf("<h3>v0.9.2"),
      "版本列从左到右 = semver 数值序降序（件3：大版在左）",
    );
    assert.match(text, /<h3>需求池 <span class="muted">\(2\)<\/span><\/h3>/, "F3/F4 入池");
    assert.ok(
      text.indexOf("/features/F3") > text.indexOf("<h3>需求池"),
      "未排期卡链在需求池列内（版本列不出现）",
    );
    assert.ok(text.indexOf("/features/F4") > text.indexOf("<h3>需求池"), "纯空格 version 同判未排期");
    assert.ok(
      text.indexOf("<h3>需求池") < text.indexOf("<h3>v0.10.0"),
      "件3 列序：需求池最左，版本列依次由大到小排其右",
    );
    assert.match(text, /<dialog class="fd" id="feat-dialog">/, "排期页带浮层骨架");
    assert.ok(
      text.includes(FEATURE_DETAIL_OVERLAY_SCRIPT),
      "脚本 = 单点常量经 sendPage 的 extraScripts 通路注入，不在各处复制",
    );
  });
});

test("N2-④ 注入面：`/org/<名>/schedule` = 看板四枚脚本（B5a 起唯一宿主）；门户 `/` 只多一枚泛化弹窗脚本（§9.5）；其余页零页面脚本", async () => {
  await withScheduleServer(fakeClient([feature("F1", "v0.9.2"), feature("F3", null)]), async (base) => {
    for (const path of ["/org/alpha/schedule"]) {
      const text = await (await fetch(`${base}${path}`)).text();
      assert.ok(text.includes(FEATURE_DETAIL_OVERLAY_SCRIPT), `${path} 含浮层脚本`);
      assert.match(text, /<dialog class="fd" id="feat-dialog">/, `${path} 含 dialog 骨架`);
      assert.ok(text.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), `${path} 含新增需求弹窗脚本`);
      assert.match(text, /<dialog class="fd" id="new-req-dialog">/, `${path} 含新增需求 dialog 骨架`);
      assert.match(text, /<button type="button" id="new-req-open"/, `${path} 页头有「＋ 新增需求」按钮`);
    }
    for (const path of ["/tasks?project=p", "/projects", "/host"]) {
      const text = await (await fetch(`${base}${path}`)).text();
      assert.ok(!text.includes(FEATURE_DETAIL_OVERLAY_SCRIPT), `${path} 不注入浮层脚本`);
      assert.ok(!text.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), `${path} 不注入弹窗脚本`);
    }
    // §9.5：门户 = 提交守卫 + 泛化弹窗脚本两枚（建组织 dialog）；看板专属浮层 / 拖拽 / mermaid 三枚仍不跟
    const portal = await (await fetch(`${base}/`)).text();
    assert.ok(portal.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), "门户注入泛化弹窗脚本（接 #new-org-dialog）");
    assert.doesNotMatch(portal, /getElementById\("feat-dialog"\)/, "门户不含浮层脚本");
    assert.doesNotMatch(portal, /getElementById\("schedule-board"\)/, "门户不含排期拖拽脚本");
    assert.doesNotMatch(portal, /window\.mermaid\.render\(/, "门户不含 mermaid 渲染脚本");
    assert.doesNotMatch(portal, /<script[^>]*src=/, "门户无外源脚本（CSP 未动）");
    assert.equal((portal.match(/<script>/g) ?? []).length, 2, "门户可执行内联脚本 = 提交守卫 + 泛化弹窗脚本两枚");
    // 退役页 = 303 回 `/`（跟随后落门户；重定向本身不渲染正文）
    const redicted = await fetch(`${base}/requirements`, { redirect: "manual" });
    assert.equal(redicted.status, 303);
    assert.equal(redicted.headers.get("location"), "/");
  });
});

test("增补② 注入面：排期页同挂 vendored mermaid + 渲染脚本（浮层换入的依赖图补渲）；非看板页不挂", async () => {
  await withScheduleServer(fakeClient([feature("F1", "v0.9.2")]), async (base) => {
    const text = await (await fetch(`${base}/org/alpha/schedule`)).text();
    assert.match(text, /<script src="\/static\/mermaid\.min\.js" defer><\/script>/, "库先（defer 于解析末段执行）");
    assert.match(text, /window\.a2aRenderMermaid = renderBlocks/, "渲染脚本（含补渲钩子）随后");
    assert.ok(
      text.indexOf('/static/mermaid.min.js') < text.indexOf("window.a2aRenderMermaid = renderBlocks"),
      "注入顺序 = 先库后渲染脚本（浮层脚本只**引用**钩子名，不含赋值，故以赋值为序标）",
    );
    // C1：全局 /tasks 裸页退役 ⇒ 对照样本换深链存活档 `?project=x`（本夹具无 getTasks ⇒ 落桥宕档，同样零脚本）
    const other = await (await fetch(`${base}/tasks?project=x`)).text();
    assert.ok(!other.includes("a2aRenderMermaid"), "非浮层承载页不挂 mermaid 脚本");
  });
});

test("增补① 锁定说明归属：409 服务端文案完整保留（卡面降噪后此文案是长说明唯一落点）", async () => {
  const client = fakeClient([feature("LOCKED", "v0.9.2", { stage: "改造方案", approval: "已通过" })], {
    // 排期写的前置读走 getFeature（不提供 ⇒ 读面失败落 502，见 server-schedule-write M3-⑤b）
    async getFeature(featureId) {
      return {
        feature: {
          featureId,
          state: "executing",
          title: "已确认需求",
          plan: null,
          ownerGroup: "alpha",
          stage: "改造方案",
          version: "v0.9.2",
          approval: "已通过",
          decisions: null,
          contracts: null,
          createdAt: "c",
          updatedAt: "u",
        },
        tasks: [],
        acceptance: null,
      };
    },
  });
  // 锁夹具两档恒注入（v0.10.0 B4：已发版锁的**事实源 = 引擎版本台账投影**，本地台账不再参与锁判）：
  // 本用例断的是「排期状态锁」，两把锁叠加时**版本锁先判**（见 server-schedule-write G-⑥）⇒ 除空本地
  // 台账外，还须喂**空引擎投影**（「读到了 ∧ 零个已发版」的合法事实），否则开发机真实引擎把 v0.9.2
  // 标 released 会抢判成 409 board_version_released，状态锁的文案永远断不到。
  const lockFree = mkdtempSync(join(tmpdir(), "board-locked-"));
  const lockFreeFile = join(lockFree, "versions.json");
  writeFileSync(lockFreeFile, JSON.stringify({ version: 1, versions: [] }, null, 2) + "\n", "utf8");
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    versionsLedgerFile: lockFreeFile,
    engineVersionsFetcher: engineNoLockFetcher(),
  });
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const cardText = await (await fetch(`${base}/org/alpha/schedule`)).text();
    assert.ok(!/本板不提供解除入口|需求确认单经用户确认后/.test(cardText), "长文案不在排期页卡面");
    const res = await fetch(`${base}/features/LOCKED/schedule`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ version: "v0.9.9" }).toString(),
    });
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.match(text, /board_schedule_state_locked/);
    assert.match(text, /需求确认单经用户确认后（stage 迁「改造方案」\/ approval 过门）该需求的排期即不可在本板改动/, "409 错误卡携完整为何锁说明");
    assert.match(text, /主需求 cancel 后从 Step 0 新建[\s\S]*本板不提供解除入口/, "409 错误卡携去处");
  } finally {
    await handle.close();
    rmSync(lockFree, { recursive: true, force: true });
  }
});

test("N4-④（B5a 重指空间排期页）HTTP 面：版本台账 released 条目在 /org/alpha/schedule 列头显示「已发版」；未登记版标「进行中」（v0.9.4 N3 锁读台账，config releasedVersions 退役）", async () => {
  const client = fakeClient([feature("F1", "v0.9.1"), feature("F2", "v0.9.2")]);
  const dir = mkdtempSync(join(tmpdir(), "board-locked-"));
  const ledgerFile = join(dir, "versions.json");
  writeFileSync(
    ledgerFile,
    JSON.stringify(
      { version: 2, versions: [{ org: "alpha", version: "v0.9.1", status: "released", createdAt: "c", updatedAt: "u", note: null }] },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, client, versionsLedgerFile: ledgerFile });
  try {
    const text = await (await fetch(`http://127.0.0.1:${handle.port}/org/alpha/schedule`)).text();
    assert.match(text, /<h3>v0\.9\.1 <span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span>/);
    assert.match(text, /<h3>v0\.9\.2 <span class="kbadge vbadge wip"[^>]*>进行中<\/span>/, "未登记版列头 = 进行中徽标");
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M4-⑦（B5a 改版）方法门与错误面: GET /schedule ⇒ 303 回门户（不触桥）、POST /schedule ⇒ 405 带退役文案；空间排期页桥不可达 ⇒ 502 且正文结构在", async () => {
  await withScheduleServer(fakeClient([feature("F1", "v0.9.2")]), async (base) => {
    // 新锚 ①：退役路径 GET ⇒ 303（不 404、不触桥）
    const get = await fetch(`${base}/schedule`, { redirect: "manual" });
    assert.equal(get.status, 303, "B5a：/schedule 整页退役 ⇒ 303（板惯例，留反悔余地）");
    assert.equal(get.headers.get("location"), "/", "303 目标 = 门户");
    assert.equal(get.headers.get("cache-control"), "no-store");
    await get.body?.cancel();
    // 新锚 ②：退役路径非 GET ⇒ 405（文案列全写面，同 /requirements、/orgs 形制）
    const post = await fetch(`${base}/schedule`, { method: "POST" });
    assert.equal(post.status, 405);
    const postText = await post.text();
    assert.match(postText, /GET \/schedule 已改 303 回门户（排期面迁 \/org\/&lt;名&gt;\/schedule）/, "405 文案 = 退役说明（表驱动逐路径一条）");
    assert.match(postText, /仅支持 GET（写面 = /, "405 文案列全写面（表驱动后与旧两条同形制）");
  });
  const broken = {
    baseUrl: "http://fake",
    async getFeatures() {
      throw new Error("桥没起（假）");
    },
  };
  await withScheduleServer(broken, async (base) => {
    const res = await fetch(`${base}/org/alpha/schedule`);
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.match(text, /bridge_unreachable/);
    // B5a：NAV 摘「排期」条 ⇒ 原「宕页高亮随发起页」锚降级为正文结构锚（桥宕页仍是板页外壳）
    assert.match(text, /<nav>/, "宕页仍出板壳（导航结构在，不跳回需求）");
    assert.doesNotMatch(text, /<a href="\/schedule"/, "宕页不再给「排期」留 NAV 入口（退役闭集钉）");
  });
});
