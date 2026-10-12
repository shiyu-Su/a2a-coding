/**
 * REQ-2026-09-27-06 · v0.9.4 §9-b N2「组织门户（首页形态 B→A）」专属单测 ——
 * 门禁四项：门户渲染 / 计数摘要派生 / 建项目组表单迁移 / 门户与看板不同构 + NAV 三枚闭集。
 *
 * ① 口径纯函数 `portalOrgNames`（门户卡与顶栏切换器共用）：台账在用 ∪ ownerGroup ∪ 板级默认，
 *    停用名剔除，**磁盘一级目录不再是源**，当前空间组织强制入列（除非停用）；
 * ② 计数派生 `buildOrgPortalCards`：单次归并 ownerGroup（trim）× getFeatures()，无新触桥面；
 * ②b 版本摘要 `orgVersionSummaryOf`（B6）：已发版 = released 里 semver 最大（非登记序）；进行中 =
 *    台账 active ∪ 卡派生（带 `*`），首个最小、其余折叠「另 N」；双空档仍渲行显示「—」；
 * ③ 渲染锚 `renderOrgPortal`：卡头链进 `/org/<名>/`、计数行、版本摘要行、建项目组表单（§9.5：内联回退 + 弹窗骨架）、
 *    **片段零可执行内联脚本**（脚本经宿主页 extraScripts 注入，闭集不扩）；
 *    **件A+B（REQ-2026-10-02-01 增补）**：正文无 `<h2>`（标题去重，页头 `<h1>` = 「项目组门户」）；
 *    **增补三（REQ-2026-10-02-03）**：一句话摘要行与口径折叠体撤除 —— 故障两档（warn / err）裸渲随页、各有正钉；
 * ④ HTTP 面：**v0.9.6 B5a 起** `GET /` = 门户（高亮「门户」、NAV 闭集三枚）、看板宿主 =
 *    `GET /org/<名>/schedule`（全局 `/schedule` 已退役 ⇒ 303）；空间落点不再经 navHrefFor 派生
 *    （该函数与 `ORG_SPACE_VIEWS` 同批删除）；**B6 起门户摘顶栏切换器**（`orgSwitcher="none"`，
 *    整页无 org-switch，动线 = 点卡进空间）。
 * ⑥ **v0.10.0 尾段 N2 —— 摘要换源**：门户版本摘要的台账侧数据 = **引擎版本台账投影**（本地台账降为
 *    「从未读到过投影」的降级读缓存）；投影 fixture 恒注入（不注入会打真实引擎），absent 档 ⇒ 门户
 *    照常 200 + 读缓存出摘要；门户仍是纯读面 ⇒ GET 零写。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { portalOrgNames } from "../dist/orgs-view.js";
import {
  buildOrgPortalCards,
  orgVersionSummaryOf,
  projectionLedgerOf,
  renderOrgPortal,
  renderCreateOrgDialog,
  renderCreateOrgForm,
} from "../dist/web/views.js";
import { NEW_REQUIREMENT_DIALOG_SCRIPT } from "../dist/web/layout.js";
import { createBoardServer } from "../dist/server.js";
import { engineProjectionAbsentFetcher, engineProjectionFetcher } from "./engine-versions-fixture.mjs";
// v0.10.1 C2 专用（只增一行导入，上面既有夹具导入与全部既有期望不动）
import { engineProjectLiveField, engineProjectionOf } from "./engine-versions-fixture.mjs";

function feature(featureId, ownerGroup, version, overrides = {}) {
  return {
    featureId,
    state: "executing",
    title: `需求 ${featureId}`,
    requirement: null,
    taskCount: 1,
    ownerGroup,
    stage: "改造方案",
    version,
    approval: "已通过",
    parentFeatureId: null,
    createdAt: "c",
    updatedAt: "u",
    stateCounts: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ① 口径纯函数
// ---------------------------------------------------------------------------

test("P-① portalOrgNames: 台账在用 ∪ ownerGroup ∪ 默认 归并去重排序；停用名一票否决", () => {
  assert.deepEqual(
    portalOrgNames({
      ledger: ["乙组", "甲组", "停用组"],
      featureGroups: ["甲组", "  ", "丙组"],
      defaultGroup: "board-default",
      disabled: ["停用组"],
    }),
    ["board-default", "丙组", "甲组", "乙组"].sort(),
    "停用名剔除、空归属丢弃、结果有序（mergeOrgNames 口径）",
  );
});

test("P-①b portalOrgNames: 磁盘目录不是源（无 disk 入参可言）；当前组织即使两源皆无也入列，停用则不入", () => {
  assert.deepEqual(portalOrgNames({ ledger: [], featureGroups: [], defaultGroup: null, current: "盘遗留组" }), ["盘遗留组"]);
  assert.deepEqual(
    portalOrgNames({ ledger: [], featureGroups: [], defaultGroup: null, current: "停用组", disabled: ["停用组"] }),
    [],
    "停用名即使是当前组织也不给高亮留口子（点了必 410）",
  );
  assert.deepEqual(portalOrgNames({ ledger: ["甲组"], featureGroups: [], defaultGroup: null, current: "甲组" }), ["甲组"], "已在清单 ⇒ 不重复");
});

// ---------------------------------------------------------------------------
// ② 计数摘要派生
// ---------------------------------------------------------------------------

test("P-② buildOrgPortalCards: 排期中 = version 非空 · 需求 = 总数 · 任务 = taskCount 之和（null 如实 —）", () => {
  const cards = buildOrgPortalCards(["甲组", "乙组", "空组"], [
    feature("F1", "甲组", "v0.9.4", { taskCount: 3 }),
    feature("F2", " 甲组 ", null, { taskCount: 1 }),
    feature("F3", "乙组", "v1.0", { taskCount: null }),
    feature("F4", "丙组", "v1.0"),
  ]);
  assert.deepEqual(cards, [
    { org: "甲组", scheduled: 1, features: 2, tasks: 4, lastReleased: null, active: ["v0.9.4"], activeDerived: ["v0.9.4"], extraActive: 0 },
    { org: "乙组", scheduled: 1, features: 1, tasks: null, lastReleased: null, active: ["v1.0"], activeDerived: ["v1.0"], extraActive: 0 },
    { org: "空组", scheduled: 0, features: 0, tasks: null, lastReleased: null, active: [], activeDerived: [], extraActive: 0 },
  ]);
  assert.ok(!cards.some((c) => c.org === "丙组"), "清单外归属不反向扩卡（盘遗留组织照此不进门户）");
});

// ---------------------------------------------------------------------------
// ③ 渲染锚（纯函数级：无 HTTP、零脚本）
// ---------------------------------------------------------------------------

test("P-③ renderOrgPortal: 卡头链 = /org/<名>/ · 计数行 · 建项目组表单随门户 · 返回片段零可执行内联脚本", () => {
  const html = renderOrgPortal(
    buildOrgPortalCards(["甲组"], [feature("F1", "甲组", "v0.9.4", { taskCount: 2 })]),
    { tier: "ready", orgsDir: "C:/orgs/live" },
  );
  assert.doesNotMatch(html, /<h2>组织门户/, "件B 防回潮：正文不再渲 <h2>组织门户（标题去重，页头 <h1> 承载）");
  assert.match(html, /<div class="kanban" id="org-portal">/);
  assert.match(html, /<a class="fl" href="\/org\/%E7%94%B2%E7%BB%84\/">甲组<\/a>/, "点卡进组织空间");
  assert.match(html, /排期中 1 · 需求 1 · 任务 2/);
  assert.match(html, /<form method="post" action="\/orgs"/, "建项目组表单宿主 = 门户（写口仍 POST /orgs）");
  assert.match(html, /<div id="new-org-inline">/, "§9.5：内联回退表单（无 JS 用）随门户");
  assert.match(html, /<dialog class="fd" id="new-org-dialog">/, "§9.5：建项目组弹窗骨架随门户");
  assert.doesNotMatch(html, /<script/, "门户片段不携带任何脚本（脚本经宿主页 extraScripts 注入，闭集不扩）");
  assert.match(renderOrgPortal([]), /（暂无项目组/, "空态如实");
  assert.equal(renderOrgPortal(buildOrgPortalCards(["甲组"], []), null).includes("orgsDir"), false, "不传状态 ⇒ 不出行");
});

test("P-③c（增补三 REQ-2026-10-02-03 · 用户裁决③）renderOrgPortal: 故障两档原地可见 —— warn / err 正钉", () => {
  const cards = buildOrgPortalCards(["甲组"], [feature("F1", "甲组", "v0.9.4")]);
  const warn = renderOrgPortal(cards, { tier: "not_configured" });
  assert.match(warn, /<p class="hint warn">/, "未装配档 = warn 样式，裸渲随页可见");
  assert.match(warn, /board_orgs_dir_not_configured/);
  const err = renderOrgPortal(cards, { tier: "problem", code: "board_orgs_dir_missing", message: "组织目录根不存在" });
  assert.match(err, /<p class="hint err">/, "配了但不可用档 = err 红字，裸渲随页可见");
  assert.match(err, /board_orgs_dir_missing/);
});

test("P-③b（§9.5）renderCreateOrgDialog：dialog 骨架 + 关闭钮 + 表单区 = renderCreateOrgForm 逐字节复用", () => {
  const form = renderCreateOrgForm();
  const html = renderCreateOrgDialog();
  assert.match(html, /^<dialog class="fd" id="new-org-dialog">/, "骨架 = dialog.fd（错误卡叠加规则同款生效）");
  assert.match(html, /<button type="button" id="new-org-close">关闭<\/button>/, "关闭钮 = dialog 第一枚 button");
  assert.match(html, /<div class="fd-body"><h3>建项目组<\/h3>/, "表单区在 .fd-body 内");
  assert.ok(html.includes(form), "表单不重建：与 renderCreateOrgForm 输出逐字节一致");
  assert.ok(html.endsWith("</dialog>"), "骨架自封闭：错误卡由脚本 append 为 dialog 直接子节点");
  assert.match(form, /<form method="post" action="\/orgs" class="w" data-submit="已提交，建组织中…" data-ov="1">/, "表单函数零改动（字段/校验/action 不变）");
});

// ---------------------------------------------------------------------------
// ⑤ 版本摘要（B6 · 显示派生不执法，门户纯读面）
// ---------------------------------------------------------------------------

/** 造台账（组织作用域记录，schema 2 形状 = VersionsLedgerStore 读面同构）。 */
function ledgerWith(records) {
  return {
    version: 2,
    versions: records.map((r) => ({
      org: r.org,
      version: r.version,
      status: r.status,
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      note: null,
      ...r,
    })),
  };
}

test("P-⑤a orgVersionSummaryOf: 已发版 = released 里 semver 最大（v0.10.0 > v0.9.0），**非登记序**", () => {
  const ledger = ledgerWith([
    { org: "甲组", version: "v0.9.0", status: "released" },
    { org: "甲组", version: "v0.10.0", status: "released" },
    { org: "甲组", version: "v0.9.5", status: "notstart" },
    { org: "乙组", version: "v9.9.9", status: "released" },
  ]);
  const s = orgVersionSummaryOf(ledger, [], "甲组");
  assert.equal(s.lastReleased, "v0.10.0", "后登记的小版本不得因登记序压掉 semver 最大者");
  assert.deepEqual(s.active, [], "notstart 不进进行中");
});

test("P-⑤b orgVersionSummaryOf: active 集 = 台账 active ∪ 卡派生，semver 升序；派生档入 activeDerived", () => {
  const ledger = ledgerWith([
    { org: "甲组", version: "v0.10.2", status: "active" },
    { org: "甲组", version: "v0.9.1", status: "active" },
  ]);
  const s = orgVersionSummaryOf(ledger, [feature("X1", "甲组", "v0.9.3")], "甲组");
  assert.deepEqual(s.active, ["v0.9.1", "v0.9.3", "v0.10.2"], "升序 ⇒ 首个 = 显示档，余者折叠");
  assert.deepEqual(s.activeDerived, ["v0.9.3"], "台账有该 (org, version) 条目 ⇒ 台账态；无条目 ∧ 有已确认卡 ⇒ 派生");
  assert.equal(s.extraActive, 2);
  const idea = orgVersionSummaryOf(ledger, [feature("X2", "甲组", "v0.8.0", { stage: "需求分析" })], "甲组");
  assert.deepEqual(idea.active, ["v0.9.1", "v0.10.2"], "想法卡不落进 active（台账两条目照在，v0.8.0 不入）");
  assert.deepEqual(idea.activeDerived, [], "想法卡（stage=需求分析）不派生 active（判据同列头徽标回落）");
});

test("P-⑤c orgVersionSummaryOf: 双空档如实（无 released 无 active ⇒ null + 空集）；他组织与空白归属不串味", () => {
  const ledger = ledgerWith([{ org: "乙组", version: "v1.0.0", status: "released" }]);
  const s = orgVersionSummaryOf(ledger, [feature("Y1", "  ", "v2.0.0"), feature("Y2", "乙组", "v1.0.0")], "甲组");
  assert.deepEqual(s, { lastReleased: null, active: [], activeDerived: [], extraActive: 0 });
  assert.equal(orgVersionSummaryOf(null, [], "甲组").lastReleased, null, "无台账面 ⇒ 双空");
});

test("P-⑤d 卡派生带 * 与 title 说明；台账态不带（renderOrgPortal 摘要行）", () => {
  const derived = renderOrgPortal(buildOrgPortalCards(["甲组"], [feature("F1", "甲组", "v0.9.4")], null));
  assert.match(derived, /<p class="kmeta" title="带 \* = 台账未登记该版[^"]*">已发版 — · 进行中 v0\.9\.4\*<\/p>/);
  const listed = renderOrgPortal(
    buildOrgPortalCards(["甲组"], [feature("F1", "甲组", "v0.9.4")], ledgerWith([{ org: "甲组", version: "v0.9.4", status: "active" }])),
  );
  assert.match(listed, /<p class="kmeta">已发版 — · 进行中 v0\.9\.4<\/p>/, "台账登记态 ⇒ 无星、无 title");
});

test("P-⑤e 折叠「另 N」与双空档仍渲该行（— · —）", () => {
  const ledger = ledgerWith([
    { org: "甲组", version: "v0.9.0", status: "released" },
    { org: "甲组", version: "v0.9.1", status: "active" },
    { org: "甲组", version: "v0.10.2", status: "active" },
    { org: "甲组", version: "v0.9.3", status: "active" },
  ]);
  const html = renderOrgPortal(buildOrgPortalCards(["甲组"], [], ledger));
  assert.match(html, /<p class="kmeta">已发版 v0\.9\.0 · 进行中 v0\.9\.1 \(另 2\)<\/p>/, "首个最小 + 折叠其余两项");
  const blank = renderOrgPortal(buildOrgPortalCards(["空组"], [], null));
  assert.match(blank, /<p class="kmeta">已发版 — · 进行中 —<\/p>/, "双空档仍渲该行，不整行省略");
});

// ---------------------------------------------------------------------------
// ④ HTTP 面 + NAV
// ---------------------------------------------------------------------------

async function withPortalServer(run, { features, ledgerOrgs, defaultGroup = "板默认", versions, engineVersions } = {}) {  const dir = mkdtempSync(join(tmpdir(), "board-n2-portal-"));
  const orgsRoot = join(dir, "orgs");
  mkdirSync(orgsRoot, { recursive: true });
  mkdirSync(join(orgsRoot, "盘遗留组"), { recursive: true });
  const ledgerFile = join(dir, "orgs.json");
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, orgs: ledgerOrgs ?? [] }), "utf8");
  // B6：门户版本摘要的数据源（建板**之前**落盘 ⇒ 启动迁移按「已存在」边界跳过，fixture 原样生效）
  const versionsFile = versions === undefined ? undefined : join(dir, "versions.json");
  if (versionsFile !== undefined) {
    writeFileSync(versionsFile, JSON.stringify({ version: 2, versions }, null, 2) + "\n", "utf8");
  }
  const client = {
    baseUrl: "http://fake",
    calls: [],
    async getFeatures() {
      client.calls.push("getFeatures");
      return { features, stateCounts: null };
    },
  };
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    docs: { repoRoot: dir, orgsDir: orgsRoot },
    orgsLedgerFile: ledgerFile,
    defaultGroup,
    ...(versionsFile === undefined ? {} : { versionsLedgerFile: versionsFile }),
    // **N2 起摘要的事实源 = 引擎投影 ⇒ 恒注入假投影**（同 `engine-versions-fixture` 纪律：不注入会打
    // 开发机的真实引擎，摘要随本机台账漂移）。缺省喂「零条目投影」= 读到了 ∧ 引擎无版本。
    engineVersionsFetcher: engineVersions ?? engineProjectionFetcher(versions ?? []),
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, client, dir);
  } finally {
    await handle.close();
  }
}

test("P-④（B5a + 件1 改版 + 件A 改名）GET / = 项目组门户（高亮「项目组门户」· 卡来自台账与归属两源 · 盘目录不进 · 停用名不进），GET /org/<名>/schedule = 看板", async () => {
  const features = [
    feature("F1", "甲组", "v0.9.4", { taskCount: 4 }),
    feature("F2", "甲组", null, { taskCount: 1 }),
    feature("F3", "桥托管组", "v1.0"),
  ];
  await withPortalServer(
    async (base, client) => {
      const home = await fetch(`${base}/`);
      const homeHtml = await home.text();
      assert.equal(home.status, 200);
      assert.match(homeHtml, /<title>项目组门户 · board<\/title>/);
      assert.match(homeHtml, /<a href="\/" class="on">项目组门户<\/a>/, "一级菜单 = 「项目组门户」并高亮（件1 显示文案改名 + 收一枚）");
      assert.doesNotMatch(
        (/<nav>([\s\S]*?)<\/nav>/.exec(homeHtml) ?? [, ""])[1],
        /href="\/(projects|agents)"/,
        "件1：「机器与项目」「运行监控」撤出导航（页面保留、深链可达）",
      );
      assert.doesNotMatch(homeHtml, /<a href="\/schedule"|<a href="\/tasks"|<a href="\/host"/, "B5a：NAV 摘 schedule / tasks / host 三条（全局排期页退役）");
      assert.match(homeHtml, /<a class="fl" href="\/org\/%E7%94%B2%E7%BB%84\/">甲组<\/a>/, "ownerGroup 源进门户");
      assert.match(homeHtml, /<a class="fl" href="\/org\/%E5%8F%B0%E8%B4%A6%E7%BB%84\/">台账组<\/a>/, "台账在用名进门户（名下无需求也可见）");
      assert.match(homeHtml, /<a class="fl" href="\/org\/%E6%9D%BF%E9%BB%98%E8%AE%A4\/">板默认<\/a>/, "板级默认进门户");
      assert.doesNotMatch(homeHtml, /盘遗留组/, "磁盘一级目录不再进门户口径");
      assert.doesNotMatch(homeHtml, /停用组/, "停用名不进门户（点了必 410）");
      assert.doesNotMatch(homeHtml, /v9\.9\.9/, "**B6 同口径**：停用组织的台账版本不经任何卡露出（门户卡源 = orgNav.orgs，不暴露停用面）");
      assert.match(homeHtml, /排期中 1 · 需求 2 · 任务 5/, "甲组计数摘要（既有列表派生）");
      assert.match(homeHtml, /排期中 1 · 需求 1 · 任务 1/);
      // B6：版本摘要行（台账按组织切片 —— 甲组台账无 v0.9.4 条目 ⇒ 卡派生带 *；台账组 released 直读）
      assert.match(homeHtml, /<p class="kmeta" title="带 \* = 台账未登记该版[^"]*">已发版 — · 进行中 v0\.9\.4\*<\/p>/, "甲组：卡派生进行中（title 说明在 p 上）");
      assert.match(homeHtml, /<p class="kmeta">已发版 v9\.9\.8 · 进行中 —<\/p>/, "台账组：released 直读，无 active 显 —");
      // 件1：组清单的唯一挂载位 = 侧栏二级菜单（原 B6「门户摘顶栏切换器」的重复入口判据随形态变更重指）；
      // 门户页无当前空间 ⇒ 侧栏二级菜单不出 on 项；回全局动线 = 一级菜单「项目组门户」、进空间动线 = 点卡。
      assert.doesNotMatch(homeHtml, /org-switch/, "原顶栏 / 正文行右的 `.org-switch` 形态整块撤除");
      assert.match(
        (/<aside class="sidebar">([\s\S]*?)<\/aside>/.exec(homeHtml) ?? [, ""])[1],
        /<p class="side-orgs-label">项目组<\/p>/,
        "侧栏二级菜单在位（项目组清单 = 全站唯一组入口）",
      );
      assert.doesNotMatch(homeHtml, /class="on">甲组</, "门户无当前空间 ⇒ 侧栏组清单不标 on");
      assert.match(homeHtml, /<form method="post" action="\/orgs"/, "建项目组表单在门户");
      // §9.5：建项目组改「＋ 建项目组」按钮（服务端 hidden，无 JS 不显死按钮）+ 弹窗；无 JS 回退 = 内联表单
      assert.match(homeHtml, /<button type="button" id="new-org-open" class="header-actions" hidden>＋ 建项目组<\/button>/, "页头「＋ 建项目组」按钮（服务端 hidden）");
      assert.match(homeHtml, /<dialog class="fd" id="new-org-dialog">/, "建项目组弹窗骨架");
      assert.match(homeHtml, /<div id="new-org-inline">/, "无 JS 内联回退表单保留");
      assert.ok(homeHtml.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), "泛化弹窗脚本随门户注入（闭集仍八元）");
      assert.doesNotMatch(homeHtml, /<script[^>]*src=/, "门户无外源脚本（CSP 未动）");
      assert.doesNotMatch(homeHtml, /id="schedule-board"|id="new-req-dialog"/, "门户不渲染看板正文 / 新增需求骨架");
      // 件B（REQ-2026-10-02-02）：全局口径说明（页底 `ul.notes`）只从门户摘除；其余页保留由 server.test.mjs 正向锚守
      assert.doesNotMatch(homeHtml, /<ul class="notes"/, "件B：门户不渲染页底全局口径说明");
      assert.deepEqual(client.calls, ["getFeatures"], "门户零新增触桥面（只复用列表读面）");

      const sched = await fetch(`${base}/org/${encodeURIComponent("甲组")}/schedule`);
      const schedHtml = await sched.text();
      assert.equal(sched.status, 200, "B5a 起看板宿主 = 组织空间排期页");
      assert.match(schedHtml, /<title>空间 · 甲组 · 排期 · board<\/title>/);
      assert.match(
        schedHtml,
        /<a class="fl on" href="\/org\/%E7%94%B2%E7%BB%84\/schedule" style="font-weight:700">排期<\/a>/,
        "「排期」= 空间导航行当前项（原全局 NAV 高亮锚随 B5a 摘条降级到此）",
      );
      assert.match(schedHtml, /<a href="\/">项目组门户<\/a>/, "空间页侧栏一级菜单与门户同源（件1 收一枚）");
      assert.deepEqual(client.calls, ["getFeatures", "getFeatures"], "两页各自复用同一读面，不额外触桥");
    },
    {
      features,
      ledgerOrgs: [
        { org: "台账组" },
        { org: "停用组", disabledAt: "2026-09-27T00:00:00Z" },
      ],
      versions: [
        { org: "甲组", version: "v0.9.0", status: "notstart", createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z", note: null },
        { org: "台账组", version: "v9.9.8", status: "released", createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z", note: null },
        { org: "停用组", version: "v9.9.9", status: "released", createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z", note: null },
      ],
    },
  );
});

// P-④b（NAV「首页」不进组织空间映射 · navHrefFor 空间派生）整枚退役：v0.9.6 B5a 起 NAV 恒三枚全局
// href、`navHrefFor`/`ORG_SPACE_VIEWS` 已删 ⇒ 本锚无对象可钉；闭集逐字节钉在 orgs-page N6-⑫ / web.test。

// ---------------------------------------------------------------------------
// ⑥ v0.10.0 尾段 N2 —— 门户版本摘要**换源引擎投影**（本地台账降为「从未读到过投影」的读缓存）
// ---------------------------------------------------------------------------

/** 引擎投影夹具（`EngineVersionsProjection` 形态，同 `bridge-client.parseEngineVersions` 出参）。 */
function projectionOf(entries, capturedAt = "2026-10-08T00:00:00.000Z") {
  return { entries, capturedAt };
}

test("N2-⑥a projectionLedgerOf：三态全保（released / active 各自归位）；非闭集状态落 notstart", () => {
  const ledger = projectionLedgerOf(
    projectionOf([
      { org: "甲组", version: "v0.9.0", status: "released" },
      { org: "甲组", version: "v0.9.1", status: "active" },
      { org: "甲组", version: "v0.9.2", status: "notstart" },
      { org: "甲组", version: "v0.9.3", status: null },
    ]),
  );
  assert.deepEqual(
    ledger.versions.map((r) => [r.org, r.version, r.status]),
    [
      ["甲组", "v0.9.0", "released"],
      ["甲组", "v0.9.1", "active"],
      ["甲组", "v0.9.2", "notstart"],
      ["甲组", "v0.9.3", "notstart"],
    ],
    "缺状态（老桥）⇒ 既不当已发版、也不当进行中，仅占「台账已登记」一位",
  );
  assert.equal(ledger.versions[0].createdAt, "2026-10-08T00:00:00.000Z", "时刻如实标注为投影捕获时刻");
  assert.equal(ledger.versions[0].note, null, "投影不带 note ⇒ null（不编造留痕）");
});

test("N2-⑥b 摘要判据经投影仍成立：released 取 semver 最大 · active 台账态不派生星 · notstart 不进进行中", () => {
  const ledger = projectionLedgerOf(
    projectionOf([
      { org: "甲组", version: "v0.9.0", status: "released" },
      { org: "甲组", version: "v0.10.0", status: "released" },
      { org: "甲组", version: "v0.9.4", status: "active" },
      { org: "甲组", version: "v0.9.2", status: "notstart" },
      { org: "乙组", version: "v9.9.9", status: "released" },
    ]),
  );
  const s = orgVersionSummaryOf(ledger, [feature("X1", "甲组", "v0.9.3")], "甲组");
  assert.equal(s.lastReleased, "v0.10.0", "已发版 = 投影 released 里 semver 最大");
  assert.deepEqual(s.active, ["v0.9.3", "v0.9.4"], "台账 active ∪ 卡派生；notstart 不入");
  assert.deepEqual(s.activeDerived, ["v0.9.3"], "投影已登记 v0.9.4 ⇒ 无星；v0.9.3 无条目才派生");
});

test("N2-⑥c HTTP：摘要读投影（引擎值与本地台账**不同值** ⇒ 以投影为准；台账登记的 active 不带星）", async () => {
  await withPortalServer(
    async (base) => {
      const html = await (await fetch(`${base}/`)).text();
      assert.match(
        html,
        /<p class="kmeta">已发版 v9\.9\.9 · 进行中 v0\.9\.4<\/p>/,
        "甲组摘要 = 引擎投影（released v9.9.9 / active v0.9.4 无星），本地台账的 v0.9.0 不露出",
      );
    },
    {
      features: [feature("F1", "甲组", "v0.9.4")],
      ledgerOrgs: [{ org: "甲组" }],
      // 本地台账（读缓存档）故意与引擎**反着写**：released v0.9.0 / v0.9.4 未登记
      versions: [{ org: "甲组", version: "v0.9.0", status: "released", createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z", note: null }],
      engineVersions: engineProjectionFetcher([
        { org: "甲组", version: "v9.9.9", status: "released" },
        { org: "甲组", version: "v0.9.4", status: "active" },
      ]),
    },
  );
});

test("N2-⑥d HTTP 降级档：投影从未读到（absent）⇒ 本地台账读缓存照常出摘要，门户不 500（读面不挡）", async () => {
  await withPortalServer(
    async (base) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 200, "拿不到投影不得把门户页打崩");
      const html = await res.text();
      assert.match(
        html,
        /<p class="kmeta">已发版 v0\.9\.0 · 进行中 —<\/p>/,
        "甲组 = 降级读缓存的 released 直读（台账有该条目、名下无卡 ⇒ 进行中 —）",
      );
      assert.match(
        html,
        /<p class="kmeta" title="带 \* = 台账未登记该版[^"]*">已发版 — · 进行中 v0\.9\.4\*<\/p>/,
        "乙组 = 台账无该条目 ⇒ 照旧卡派生带星",
      );
    },
    {
      features: [feature("F1", "乙组", "v0.9.4")],
      ledgerOrgs: [{ org: "甲组" }, { org: "乙组" }],
      versions: [{ org: "甲组", version: "v0.9.0", status: "released", createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z", note: null }],
      engineVersions: engineProjectionAbsentFetcher(),
    },
  );
});

test("N2-⑥e 门户 GET 仍零写（摘要换源不动「纯读面」纪律）", async () => {
  await withPortalServer(
    async (base, client, dir) => {
      const versionsFile = join(dir, "versions.json");
      const before = readFileSync(versionsFile, "utf8");
      await (await fetch(`${base}/`)).text();
      assert.equal(before.includes("v9.9.9"), false, "夹具本地台账本就无引擎那条 released（换源前提）");
      assert.equal(readFileSync(versionsFile, "utf8"), before, "门户为纯读面：读投影不得回写本地台账、不点亮任何档");
      void client;
    },
    {
      features: [feature("F1", "甲组", "v0.9.4")],
      ledgerOrgs: [{ org: "甲组" }],
      versions: [],
      engineVersions: engineProjectionFetcher([{ org: "甲组", version: "v9.9.9", status: "released" }]),
    },
  );
});

// ---------------------------------------------------------------------------
// ⑦ v0.10.1 C2（REQ-2026-10-09-01）—— 门户摘要 × project 面的三条负向钉
//
// 口径（改造文档 §2 C-18④⑥ / C-4 双计数 / §4 实现级 board）：
// **门户摘要 `orgVersionSummaryOf` 不扩 project**；**两级计数不得进同一张表、不得相加、不得互校**；
// **org 切片不串味**（A 组织的投影不喂 B 组织）。
// 与 B1/B2/B3/B4 的分工：三档显示闭集与 org 切片档归 T3/T4 的 project 区块用例；
// 本节点只在**门户面**补「跨三档不变式 + 双计数不相加」两族，且一律走 **live 档**
// （B2-④b 钉的是 project **缺位**档下的门户零变化 —— 缺位档不携带任何可染色的行，测不出「不扩」）。
// ---------------------------------------------------------------------------

/** 门户跨档不变式的 Group 基线行（两组织 + released/active 两态都在内）。 */
const C2_GROUP_ROWS = [
  { org: "甲组", version: "v0.10.1", status: "active" },
  { org: "甲组", version: "v0.9.0", status: "released" },
  { org: "乙组", version: "v0.10.1", status: "released" },
];

/** project 档 live 行：版号（v8.8.8 / v7.7.7）与计数（0+7+3 / 4+5+6 = 25）都是「一旦串门就可见」的探针。 */
const C2_PROJECT_ROWS = [
  { org: "甲组", projectId: "pvorch", version: "v8.8.8", status: "released", releasable: true, openCount: 0, completedCount: 7, cancelledCount: 3 },
  { org: "乙组", projectId: "pvboard", version: "v7.7.7", status: "open", openCount: 4, completedCount: 5, cancelledCount: 6, reason: "归属未收口" },
];

const C2_LIVE_FIELD = engineProjectLiveField(C2_PROJECT_ROWS);

/** 门户卡上的全部数字字段（两级计数若被相加，只会露在这里）。 */
function numericFieldsOf(card) {
  return [card.scheduled, card.features, card.tasks].filter((v) => typeof v === "number");
}

test("C2-⑦a 门户摘要不含 project 行：projectionLedgerOf 只取 Group entries（project 版号 / 两态 / 键集一律不混进台账面）", () => {
  const withProjects = engineProjectionOf(C2_GROUP_ROWS, "", C2_LIVE_FIELD).projection;
  const withoutProjects = engineProjectionOf(C2_GROUP_ROWS).projection;
  assert.deepEqual(
    projectionLedgerOf(withProjects),
    projectionLedgerOf(withoutProjects),
    "project 面在场 / 缺位 ⇒ 门户摘要的台账面逐字段恒等（跨档不变式）",
  );
  const ledger = projectionLedgerOf(withProjects);
  assert.deepEqual(
    ledger.versions.map((r) => `${r.org}@${r.version}@${r.status}`),
    ["甲组@v0.10.1@active", "甲组@v0.9.0@released", "乙组@v0.10.1@released"],
    "同序（投影登记序）+ 同状态，且只有 Group 那三行",
  );
  assert.equal(
    ledger.versions.some((r) => r.version === "v8.8.8" || r.version === "v7.7.7"),
    false,
    "project 独有版号不得成为台账行（否则门户「已发版 / 进行中」会读到一个 project 版号）",
  );
  assert.equal(
    ledger.versions.some((r) => r.status === "open"),
    false,
    "project 档两态（open / released）不得混进 Group 三态（open 既不是 active 也不是 notstart）",
  );
  for (const rec of ledger.versions) {
    assert.deepEqual(
      Object.keys(rec).sort(),
      ["createdAt", "note", "org", "status", "updatedAt", "version"],
      "台账行不带 project 维度键（projectId / releasable / 计数）",
    );
  }
  // 正对照（防上面的负钉空转）：project 版号一旦真被当成 Group 行喂进台账面，摘要就会读出它 —— 探针本身是活的
  const leaked = projectionLedgerOf({
    entries: [...C2_GROUP_ROWS.map((r) => ({ ...r })), { org: "甲组", version: "v8.8.8", status: "released" }],
    capturedAt: "2026-10-09T00:00:00.000Z",
  });
  assert.equal(orgVersionSummaryOf(leaked, [], "甲组").lastReleased, "v8.8.8", "同版号若混进 Group 面即成为「已发版」⇒ 上面那条 doesNotMatch 不是空判");
});

test("C2-⑦b 两级计数不横向相加：门户卡与「无 project 面」基线恒等，project 计数之和不得成为任何字段", () => {
  const features = [
    feature("F1", "甲组", "v0.10.1", { taskCount: 2 }),
    feature("F2", "乙组", "v0.10.1", { taskCount: 3 }),
  ];
  const cards = buildOrgPortalCards(
    ["甲组", "乙组", "板默认"],
    features,
    projectionLedgerOf(engineProjectionOf(C2_GROUP_ROWS, "", C2_LIVE_FIELD).projection),
  );
  const baseline = buildOrgPortalCards(
    ["甲组", "乙组", "板默认"],
    features,
    projectionLedgerOf(engineProjectionOf(C2_GROUP_ROWS).projection),
  );
  assert.deepEqual(cards, baseline, "project 面在场不改任何一张卡（相加 / 互校即破此式）");
  // project 侧计数探针：甲组行 completedCount = 7、甲组行三计数之和 = 10、乙组行三计数之和 = 15、全表总和 = 25
  // （Group 侧字段本档取值都在 0–3，任何一枚命中即说明计数被串 / 相加）
  const projectCounts = [7, 10, 15, 25];
  for (const card of cards) {
    for (const v of numericFieldsOf(card)) {
      assert.equal(projectCounts.includes(v), false, `${card.org} 的数字字段 ${v} 命中 project 侧计数 ⇒ 计数被串了`);
    }
    assert.deepEqual(
      Object.keys(card).sort(),
      ["active", "activeDerived", "extraActive", "features", "lastReleased", "org", "scheduled", "tasks"],
      "门户卡字段集 = Group 侧八枚（两级计数不得进同一张表 · C-18⑥）",
    );
    assert.equal(card.active.some((v) => v === "v8.8.8" || v === "v7.7.7"), false, "进行中清单不得吞进 project 版号");
  }
  assert.deepEqual(
    cards.map((c) => `${c.org}:${c.tasks}:${c.scheduled}:${c.lastReleased}:${c.active.join("/")}`),
    ["甲组:2:1:v0.9.0:v0.10.1", "乙组:3:1:v0.10.1:", "板默认:null:0:null:"],
    "任务数只来自需求列表 taskCount（Group 侧派生），与 project 计数无算术关系；乙组 project 行released 不喂出摘要",
  );
});

test("C2-⑦c org 切片不串味：甲组的 Group 行不喂乙组摘要，乙组自己的 project released 行也不喂（A 组织投影 ≠ B 组织凭据）", () => {
  const ledger = projectionLedgerOf(
    engineProjectionOf(
      [
        { org: "甲组", version: "v0.9.0", status: "released" },
        { org: "甲组", version: "v0.10.1", status: "active" },
      ],
      "",
      engineProjectLiveField([{ org: "乙组", projectId: "pvorch", version: "v8.8.8", status: "released", releasable: true, completedCount: 9 }]),
    ).projection,
  );
  const yi = orgVersionSummaryOf(ledger, [feature("Z1", "乙组", "v0.10.1", { stage: "需求分析" })], "乙组");
  assert.deepEqual(
    yi,
    { lastReleased: null, active: [], activeDerived: [], extraActive: 0 },
    "乙组无 Group 行 ⇒ 摘要双空：甲组的 Group 行不串味，乙组自己的 project released 行也不给它「已发版」",
  );
  const jia = orgVersionSummaryOf(ledger, [], "甲组");
  assert.equal(jia.lastReleased, "v0.9.0", "甲组读到自己那两行（切片正确，不是整体为空）");
  assert.deepEqual(jia.active, ["v0.10.1"]);
  assert.deepEqual(jia.activeDerived, [], "台账登记的 active 不带派生星");
});

test("C2-⑦d HTTP：门户在 project live 档下仍只渲 Group 摘要（project 版号 / projectId / 区块 / 根因码一律不出）", async () => {
  await withPortalServer(
    async (base) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(
        html,
        /<p class="kmeta">已发版 v0\.9\.0 · 进行中 v0\.10\.1<\/p>/,
        "甲组摘要 = Group 档原样（project live 行在场不改摘要行）",
      );
      assert.doesNotMatch(html, /v8\.8\.8|v7\.7\.7/, "project 版号不进门户任何行（C-18④ 门户摘要不扩 project）");
      assert.doesNotMatch(html, /pvorch|pvboard/, "projectId 不进门户");
      assert.doesNotMatch(html, /各 project 版本|class="[^"]*\bpv-block/, "门户不挂 project 版本区块（区块落点 = 组织空间排期页 · C-18①④）；样式规则 .pv-block 在全站 CSS 里，故钉元素级锚");
      assert.doesNotMatch(html, /归属未收口|引擎未给 releasable|不横向相加/, "project 侧的原因 / releasable 过渡档文案 / 两级计数说明不进门户");
      assert.doesNotMatch(html, /project_versions_/, "门户不裸吐 project 根因码");
    },
    {
      features: [feature("F1", "甲组", "v0.10.1", { taskCount: 2 })],
      ledgerOrgs: [{ org: "甲组" }, { org: "乙组" }],
      versions: [],
      engineVersions: engineProjectionFetcher(C2_GROUP_ROWS, "", C2_LIVE_FIELD),
    },
  );
});

