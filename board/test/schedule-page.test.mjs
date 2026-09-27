/**
 * REQ-v0.9.2-2026-09-25-02 · M4 排期看板页 `/schedule`（只读）+ M5 需求池 ——
 * 分组纯函数（version-order 数值序 + 未排期滤除）/ 卡片渲染（状态徽标 · 无按状态分列）/
 * 需求池（判据单一、池序 createdAt 降序 null 落底 featureId 兜底、卡上需求原文截断转义）/
 * HTTP 面（GET 200 + 导航高亮 / 方法门 405 / 桥不可达 502）/ 导航闭集六项。
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
  renderPage,
} from "../dist/web/layout.js";
import { createBoardServer } from "../dist/server.js";

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

test("M4-④ renderSchedule: 列头 = 版本号 + 卡片数；卡 = title + 状态徽标 + stage/approval + taskCount", () => {
  const cols = groupFeaturesByVersion([
    feature("F1", "v0.9.2"),
    feature("F2", "v0.9.2", { state: "waiting_approval", approval: "待审批", taskCount: null }),
  ]);
  const html = renderSchedule(cols);
  assert.match(html, /<h3>v0\.9\.2 <span class="kbadge vbadge wip"[^>]*>进行中<\/span> <span class="muted">\(2\)<\/span><\/h3>/, "列头 = 版本号 + 状态徽标（增补 ② 后恒有）+ 卡片数");
  assert.match(html, /href="\/features\/F1"/, "卡标题链详情页");
  assert.match(html, /<span class="kbadge">执行中（executing）<\/span>/, "状态作徽标");
  assert.match(html, /待审批（waiting_approval）/, "第二卡徽标 = 待审批");
  assert.match(html, /阶段：改造方案（登记）/, "stage 展示沿用 derive 口径");
  assert.match(html, /审批门：已通过 · 任务数：1<\/p>/, "approval + taskCount 上卡");
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

test("M5-① selectRequirementPool: 判据单一 trim()===\"\"；池序 createdAt 降序、null 落底、featureId 兜底稳定", () => {
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
  const versionCol = html.slice(0, html.indexOf("<h3>需求池"));
  assert.doesNotMatch(versionCol, /需求：/, "版本列卡不出需求原文行（池卡专属）");
});

test("M5-③ renderSchedule 池列恒在: 空池如实「无未排期需求」；无版本列时提示都在池", () => {
  assert.match(renderSchedule([], []), /<h3>需求池 <span class="muted">\(0\)<\/span><\/h3>/);
  assert.match(renderSchedule([], []), /（无未排期需求）/);
  const html = renderSchedule([], selectRequirementPool([feature("F1", null)]));
  assert.match(html, /无已排期需求.*都在需求池列/s);
  assert.match(html, /\/features\/F1/);
});

// ---------------------------------------------------------------------------
// v0.9.3 B1 增补徽标（排期卡 / 池卡 · fixture 自构造，不依赖真桥 O1）
// ---------------------------------------------------------------------------

test("B1-① renderSchedule 卡: parentFeatureId 非空 ⇒「增补 · 父需求」徽标 + 单跳深链", () => {
  const html = renderSchedule(
    groupFeaturesByVersion([feature("A1", "v0.9.3", { parentFeatureId: "P1" })]),
    selectRequirementPool([feature("A2", null, { parentFeatureId: "P2" })]),
  );
  assert.match(html, /<span class="kbadge">增补 · 父需求 <a class="fl" href="\/features\/P1">P1<\/a><\/span>/);
  assert.match(html, /增补 · 父需求 <a class="fl" href="\/features\/P2">P2<\/a>/, "池卡同款徽标");
});

test("B1-② renderSchedule 卡: 无 parentFeatureId（缺省 null）⇒ 不徽标（老桥口径）", () => {
  const html = renderSchedule(groupFeaturesByVersion([feature("A1", "v0.9.3")]), []);
  assert.doesNotMatch(html, /增补 · 父需求/);
});

test("B1-③ 增补徽标只取一层不递归：父链 href 只做编码拼接 + 文本转义", () => {
  const html = renderSchedule(
    groupFeaturesByVersion([feature("A1", "v0.9.3", { parentFeatureId: `P/x"><script>` })]),
    [],
  );
  assert.match(
    html,
    /href="\/features\/P%2Fx%22%3E%3Cscript%3E"/,
    "href 经 encodeURIComponent，不注入原串",
  );
  assert.doesNotMatch(html, /<script>/, "徽标文本不得逃逸成脚本");
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
  assert.match(idea, /^" draggable="true"/, "想法卡可拖（属性挂在卡根节点上）");
  assert.match(idea, /data-feature="IDEA"/);
  assert.match(idea, /data-version="v0\.9\.3"/, "卡片带现版本 ⇒ 拖同列 = 无操作（脚本早退）");
  assert.doesNotMatch(idea, /draglocked|🔒 排期已锁/, "放行卡不置灰、不出锁定标记");
  const locked = cardOf(html, "CONFIRMED");
  assert.doesNotMatch(locked, /draggable=/, "已确认卡不出拖拽属性（不是「拖了再拒」）");
  assert.match(locked, /^ draglocked"/, "置灰类（cardOf 以 kcard 起头切段 ⇒ 段首是类名余部）");
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

      // 脚本侧：两处 fetch（链接导航 + 浮层内提交）都显式声明 HTML 档 ⇒ 缺一条即回归跳页缺陷
      const accepts = FEATURE_DETAIL_OVERLAY_SCRIPT.match(/Accept: "text\/html"/g) ?? [];
      assert.equal(accepts.length, 2, "open() 与 postForm() 两处 fetch 均须发 Accept: text/html");
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
  // 提交走 fetch，POST + form.action + 同源凭据；成功（303 自动跟随后）与 4xx/5xx 共用换入通路
  assert.match(s, /fetch\(form\.action, \{/, "fetch 表单 action（不另拼端点）");
  assert.match(s, /method: "POST"/);
  assert.match(s, /credentials: "same-origin"/);
  assert.match(s, /e\.preventDefault\(\);\n    postForm\(form\);/, "拦下 submit 后进浮层提交通路");
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
  assert.match(s, /if \(parsed\.card !== null\) \{ showCard\(parsed\.card\); return; \}/, "抽到卡 ⇒ 只叠加，不替换 body");
  assert.match(s, /function dropCard\(\) \{\n    var kids = dlg\.children;/, "摘卡只扫 dialog 直接子元素（不碰 .fd-body）");
  assert.match(s, /function showCard\(card\) \{\n    dropCard\(\);\n    dlg\.appendChild\(card\);/, "错误卡 = dialog 直接子元素（覆盖层，非内容流），重提交前摘旧卡");
  assert.doesNotMatch(s, /body\.insertBefore\(card/, "不再把错误卡前置进 .fd-body 文档流（反馈 ① 的根因）");
  assert.match(CSS, /dialog\.fd > \.err-ov-card \{[^}]*position: fixed/, "错误卡 fixed 定位（盖在浮层内容之上）");
  assert.match(CSS, /dialog\.fd > \.err-ov-card \{[^}]*box-shadow: 0 0 0 100vmax/, "半透明遮罩 = 超大 spread shadow（不用 transform，避免打断 fixed 包含块）");
  assert.match(s, /if \(!swapPage\(r\.text\)\) \{ nativeSubmit\(form\); \}\n        return;/, "抽不到卡 ⇒ 回退换入错误页 main（现行为）");
  assert.match(s, /closest\("#feat-dialog #err-ov-close"\)/, "浮层内「知道了」有委托处理");
  assert.match(s, /card\.parentNode\.removeChild\(card\);/, "点「知道了」= 摘掉错误卡（浮层不关）");
  // 反馈 ②：浮层内提交不跳页 ⇒ 提交守卫的禁用/提示行无人复位，本脚本处理完响应后主动恢复表单
  assert.match(s, /function restoreForm\(form\) \{/, "提交后恢复收口 restoreForm");
  assert.match(s, /querySelectorAll\("button\[disabled\]"\)/, "重新启用被守卫禁用的提交按钮");
  assert.match(s, /btns\[i\]\.removeAttribute\("aria-disabled"\);/, "连 aria-disabled 一起摘（否则读屏仍报禁用）");
  assert.match(s, /querySelector\("\.submit-pending"\)/, "摘掉「已提交，排期写入中」提示行");
  assert.match(s, /if \(!swapPage\(r\.text\)\) \{ nativeSubmit\(form\); \}\n    \}\)\.then\(function \(\) \{\n      restoreForm\(form\);\n    \}\)/, "响应处理完之后恢复表单（成功 / 错误叠加两档共用一个落点）");
  // 降级面：结构不可解析 / fetch 异常 ⇒ 原生提交（此前不动 body ⇒ 表单仍在文档内可 submit）
  assert.match(s, /function nativeSubmit\(form\) \{ restoreForm\(form\); form\.submit\(\); \}/, "降级 = 先恢复表单再原生 form.submit()");
  assert.match(s, /if \(data === null\) \{ nativeSubmit\(form\); return; \}/);
  assert.match(s, /if \(!swapPage\(r\.text\)\) \{ nativeSubmit\(form\); \}/, "响应不可解析 ⇒ 降级原生提交");
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
  const cardPath = errBranch.slice(0, errBranch.indexOf("showCard(parsed.card); return;") + "showCard(parsed.card); return;".length);
  assert.doesNotMatch(cardPath, /swapPage/, "抽到卡的路径不整体替换 body（重复内容缺陷的根因已除）");
  assert.match(cardPath, /showCard\(parsed\.card\); return;/, "有卡 ⇒ 唯一动作 = 叠加错误卡后立即返回");
  // swapPage 只允许出现在无卡的回退位（卡判之后）
  assert.match(errBranch.slice(errBranch.indexOf("showCard")), /if \(!swapPage\(r\.text\)\)/, "无卡 ⇒ 回退才换入错误页 main");
  // 成功分支维持现状：抽最终页 main 换入 body（详情在浮层内刷新）
  const okBranch = s.slice(s.indexOf("if (r.err) {") + 10, s.indexOf("}).catch(function () { nativeSubmit(form); });"));
  assert.match(okBranch, /if \(!swapPage\(r\.text\)\) \{ nativeSubmit\(form\); \}/, "2xx/3xx 成功分支 = swapPage 换入（维持现状）");
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

test("N4-② renderSchedule: 未锁版全终态且有 completed ⇒「已收尾」徽标（仅提示）；缺省 releasedVersions=[] 无锁", () => {
  const cols = groupFeaturesByVersion([
    feature("F1", "v0.9.0", { state: "completed" }),
    feature("F2", "v0.9.0", { state: "cancelled" }),
    feature("F3", "v0.9.2"),
  ]);
  const html = renderSchedule(cols);
  const closedH3 = html.slice(html.indexOf("<h3>v0.9.0"), html.indexOf("</h3>", html.indexOf("<h3>v0.9.0")));
  assert.match(closedH3, /<span class="kbadge vbadge closed"[^>]*>已收尾<\/span>/);
  assert.doesNotMatch(closedH3, /locked/, "已收尾不加锁样式（未登记 releasedVersions ⇒ 不锁）");
});

test("N4-③ renderSchedule: 徽标不吞版本号与卡片数（列头判据原样），需求池列无徽标", () => {
  const html = renderSchedule(groupFeaturesByVersion([feature("F1", "v0.9.1")]), [feature("F2", null)], ["v0.9.1"]);
  assert.match(html, /<h3>v0\.9\.1 <span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span> <span class="muted">\(1\)<\/span><\/h3>/);
  const poolH3 = html.slice(html.indexOf("<h3>需求池"));
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

test("M4-⑥ GET /schedule: 200 + 导航「排期」高亮 + 版本列有序；未排期卡在需求池列、不占版本列", async () => {
  const client = fakeClient([
    feature("F1", "v0.10.0"),
    feature("F2", "v0.9.2"),
    feature("F3", null),
    feature("F4", "  "),
  ]);
  await withScheduleServer(client, async (base) => {
    const res = await fetch(`${base}/schedule`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /<a href="\/schedule" class="on">排期<\/a>/);
    assert.match(text, /<h3>v0\.9\.2/, "v0.9.2 列在左");
    assert.match(text, /<h3>v0\.10\.0/, "v0.10.0 列在右（数值序）");
    assert.ok(
      text.indexOf("<h3>v0.9.2") < text.indexOf("<h3>v0.10.0"),
      "列从左到右按 semver 数值序",
    );
    assert.match(text, /<h3>需求池 <span class="muted">\(2\)<\/span><\/h3>/, "F3/F4 入池");
    assert.ok(
      text.indexOf("/features/F3") > text.indexOf("<h3>需求池"),
      "未排期卡链在需求池列内（版本列不出现）",
    );
    assert.ok(text.indexOf("/features/F4") > text.indexOf("<h3>需求池"), "纯空格 version 同判未排期");
    assert.ok(
      text.indexOf("<h3>v0.10.0") < text.indexOf("<h3>需求池"),
      "需求池列在版本列右侧（并列末列）",
    );
    assert.match(text, /<dialog class="fd" id="feat-dialog">/, "排期页带浮层骨架");
    assert.ok(
      text.includes(FEATURE_DETAIL_OVERLAY_SCRIPT),
      "脚本 = 单点常量经 sendPage 的 extraScripts 通路注入，不在各处复制",
    );
  });
});

test("N2-④ 注入面 = schedule kind 页：`/` 与 `/schedule` 都注入；非看板页不注入（REQ-04：新增需求弹窗脚本同注入面）", async () => {
  await withScheduleServer(fakeClient([feature("F1", "v0.9.2"), feature("F3", null)]), async (base) => {
    for (const path of ["/", "/schedule"]) {
      const text = await (await fetch(`${base}${path}`)).text();
      assert.ok(text.includes(FEATURE_DETAIL_OVERLAY_SCRIPT), `${path} 含浮层脚本`);
      assert.match(text, /<dialog class="fd" id="feat-dialog">/, `${path} 含 dialog 骨架`);
      assert.ok(text.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), `${path} 含新增需求弹窗脚本`);
      assert.match(text, /<dialog class="fd" id="new-req-dialog">/, `${path} 含新增需求 dialog 骨架`);
      assert.match(text, /<button type="button" id="new-req-open"/, `${path} 页头有「＋ 新增需求」按钮`);
    }
    for (const path of ["/tasks", "/projects", "/orgs", "/host"]) {
      const text = await (await fetch(`${base}${path}`)).text();
      assert.ok(!text.includes(FEATURE_DETAIL_OVERLAY_SCRIPT), `${path} 不注入浮层脚本`);
      assert.ok(!text.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), `${path} 不注入弹窗脚本`);
    }
    // 退役页 = 303 回 `/`（跟随后落看板 ⇒ 脚本随首页注入，但重定向本身不渲染正文）
    const redicted = await fetch(`${base}/requirements`, { redirect: "manual" });
    assert.equal(redicted.status, 303);
    assert.equal(redicted.headers.get("location"), "/");
  });
});

test("增补② 注入面：排期页同挂 vendored mermaid + 渲染脚本（浮层换入的依赖图补渲）；非看板页不挂", async () => {
  await withScheduleServer(fakeClient([feature("F1", "v0.9.2")]), async (base) => {
    const text = await (await fetch(`${base}/schedule`)).text();
    assert.match(text, /<script src="\/static\/mermaid\.min\.js" defer><\/script>/, "库先（defer 于解析末段执行）");
    assert.match(text, /window\.a2aRenderMermaid = renderBlocks/, "渲染脚本（含补渲钩子）随后");
    assert.ok(
      text.indexOf('/static/mermaid.min.js') < text.indexOf("window.a2aRenderMermaid = renderBlocks"),
      "注入顺序 = 先库后渲染脚本（浮层脚本只**引用**钩子名，不含赋值，故以赋值为序标）",
    );
    const other = await (await fetch(`${base}/tasks`)).text();
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
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, client });
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const cardText = await (await fetch(`${base}/schedule`)).text();
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
  }
});

test("N4-④ HTTP 面：config 登记的已发版版本在 /schedule 列头显示「已发版」；未登记版标「进行中」（增补 ②）", async () => {
  const client = fakeClient([feature("F1", "v0.9.1"), feature("F2", "v0.9.2")]);
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, client, releasedVersions: ["v0.9.1"] });
  try {
    const text = await (await fetch(`http://127.0.0.1:${handle.port}/schedule`)).text();
    assert.match(text, /<h3>v0\.9\.1 <span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span>/);
    assert.match(text, /<h3>v0\.9\.2 <span class="kbadge vbadge wip"[^>]*>进行中<\/span>/, "未登记版列头 = 进行中徽标");
  } finally {
    await handle.close();
  }
});

test("M4-⑦ 方法门与错误面: POST /schedule ⇒ 405；桥不可达 ⇒ 502 且高亮留在排期页", async () => {
  await withScheduleServer(fakeClient([feature("F1", "v0.9.2")]), async (base) => {
    const post = await fetch(`${base}/schedule`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.match(await post.text(), /仅支持 GET/);
  });
  const broken = {
    baseUrl: "http://fake",
    async getFeatures() {
      throw new Error("桥没起（假）");
    },
  };
  await withScheduleServer(broken, async (base) => {
    const res = await fetch(`${base}/schedule`);
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.match(text, /bridge_unreachable/);
    assert.match(text, /<a href="\/schedule" class="on">排期<\/a>/, "宕页高亮随发起页，不跳回需求");
  });
});
