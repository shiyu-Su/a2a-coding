/**
 * REQ-2026-09-27-06 · v0.9.4 §9-b N2「组织门户（首页形态 B→A）」专属单测 ——
 * 门禁四项：门户渲染 / 计数摘要派生 / 建组织表单迁移 / `/schedule` 同构翻向 + NAV。
 *
 * ① 口径纯函数 `portalOrgNames`（门户卡与顶栏切换器共用）：台账在用 ∪ ownerGroup ∪ 板级默认，
 *    停用名剔除，**磁盘一级目录不再是源**，当前空间组织强制入列（除非停用）；
 * ② 计数派生 `buildOrgPortalCards`：单次归并 ownerGroup（trim）× getFeatures()，无新触桥面；
 * ③ 渲染锚 `renderOrgPortal`：卡头链进 `/org/<名>/`、计数行、建组织表单（§9.5：内联回退 + 弹窗骨架）、
 *    **片段零可执行内联脚本**（脚本经宿主页 extraScripts 注入，闭集不扩）；
 * ④ HTTP 面：`GET /` = 门户（高亮「首页」）、`GET /schedule` = 看板（高亮「排期」），
 *    NAV `home` 不进空间映射（空间页「首页」仍回全局门户）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { portalOrgNames } from "../dist/orgs-view.js";
import { buildOrgPortalCards, renderOrgPortal, renderCreateOrgDialog, renderCreateOrgForm } from "../dist/web/views.js";
import { navHrefFor, NEW_REQUIREMENT_DIALOG_SCRIPT } from "../dist/web/layout.js";
import { createBoardServer } from "../dist/server.js";

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
    { org: "甲组", scheduled: 1, features: 2, tasks: 4 },
    { org: "乙组", scheduled: 1, features: 1, tasks: null },
    { org: "空组", scheduled: 0, features: 0, tasks: null },
  ]);
  assert.ok(!cards.some((c) => c.org === "丙组"), "清单外归属不反向扩卡（盘遗留组织照此不进门户）");
});

// ---------------------------------------------------------------------------
// ③ 渲染锚（纯函数级：无 HTTP、零脚本）
// ---------------------------------------------------------------------------

test("P-③ renderOrgPortal: 卡头链 = /org/<名>/ · 计数行 · 建组织表单随门户 · 返回片段零可执行内联脚本", () => {
  const html = renderOrgPortal(
    buildOrgPortalCards(["甲组"], [feature("F1", "甲组", "v0.9.4", { taskCount: 2 })]),
    { tier: "ready", orgsDir: "C:/orgs/live" },
  );
  assert.match(html, /<h2>组织门户<\/h2>/);
  assert.match(html, /<div class="kanban" id="org-portal">/);
  assert.match(html, /<a class="fl" href="\/org\/%E7%94%B2%E7%BB%84\/">甲组<\/a>/, "点卡进组织空间");
  assert.match(html, /排期中 1 · 需求 1 · 任务 2/);
  assert.match(html, /<form method="post" action="\/orgs"/, "建组织表单宿主 = 门户（写口仍 POST /orgs）");
  assert.match(html, /<div id="new-org-inline">/, "§9.5：内联回退表单（无 JS 用）随门户");
  assert.match(html, /<dialog class="fd" id="new-org-dialog">/, "§9.5：建组织弹窗骨架随门户");
  assert.match(html, /组织目录根（orgsDir）<b>就绪<\/b>：/, "orgsDir 状态行随门户");
  assert.doesNotMatch(html, /<script/, "门户片段不携带任何脚本（脚本经宿主页 extraScripts 注入，闭集不扩）");
  assert.match(renderOrgPortal([]), /（暂无组织/, "空态如实");
  assert.equal(renderOrgPortal(buildOrgPortalCards(["甲组"], []), null).includes("orgsDir"), false, "不传状态 ⇒ 不出行");
});

test("P-③b（§9.5）renderCreateOrgDialog：dialog 骨架 + 关闭钮 + 表单区 = renderCreateOrgForm 逐字节复用", () => {
  const form = renderCreateOrgForm();
  const html = renderCreateOrgDialog();
  assert.match(html, /^<dialog class="fd" id="new-org-dialog">/, "骨架 = dialog.fd（错误卡叠加规则同款生效）");
  assert.match(html, /<button type="button" id="new-org-close">关闭<\/button>/, "关闭钮 = dialog 第一枚 button");
  assert.match(html, /<div class="fd-body"><h3>建组织<\/h3>/, "表单区在 .fd-body 内");
  assert.ok(html.includes(form), "表单不重建：与 renderCreateOrgForm 输出逐字节一致");
  assert.ok(html.endsWith("</dialog>"), "骨架自封闭：错误卡由脚本 append 为 dialog 直接子节点");
  assert.match(form, /<form method="post" action="\/orgs" class="w" data-submit="已提交，建组织中…" data-ov="1">/, "表单函数零改动（字段/校验/action 不变）");
});

// ---------------------------------------------------------------------------
// ④ HTTP 面 + NAV
// ---------------------------------------------------------------------------

async function withPortalServer(run, { features, ledgerOrgs, defaultGroup = "板默认" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "board-n2-portal-"));
  const orgsRoot = join(dir, "orgs");
  mkdirSync(orgsRoot, { recursive: true });
  mkdirSync(join(orgsRoot, "盘遗留组"), { recursive: true });
  const ledgerFile = join(dir, "orgs.json");
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, orgs: ledgerOrgs ?? [] }), "utf8");
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
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, client);
  } finally {
    await handle.close();
  }
}

test("P-④ GET / = 组织门户（高亮「首页」· 卡来自台账与归属两源 · 盘目录不进 · 停用名不进），GET /schedule = 看板", async () => {
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
      assert.match(homeHtml, /<title>组织门户 · board<\/title>/);
      assert.match(homeHtml, /<a href="\/" class="on">首页<\/a>/, "首页项指向门户并高亮");
      assert.match(homeHtml, /<a href="\/schedule">排期<\/a>/, "排期项指向 /schedule（不高亮）");
      assert.match(homeHtml, /<a class="fl" href="\/org\/%E7%94%B2%E7%BB%84\/">甲组<\/a>/, "ownerGroup 源进门户");
      assert.match(homeHtml, /<a class="fl" href="\/org\/%E5%8F%B0%E8%B4%A6%E7%BB%84\/">台账组<\/a>/, "台账在用名进门户（名下无需求也可见）");
      assert.match(homeHtml, /<a class="fl" href="\/org\/%E6%9D%BF%E9%BB%98%E8%AE%A4\/">板默认<\/a>/, "板级默认进门户");
      assert.doesNotMatch(homeHtml, /盘遗留组/, "磁盘一级目录不再进门户口径");
      assert.doesNotMatch(homeHtml, /停用组/, "停用名不进门户（点了必 410）");
      assert.match(homeHtml, /排期中 1 · 需求 2 · 任务 5/, "甲组计数摘要（既有列表派生）");
      assert.match(homeHtml, /排期中 1 · 需求 1 · 任务 1/);
      assert.match(homeHtml, /<form method="post" action="\/orgs"/, "建组织表单在门户");
      // §9.5：建组织改「＋ 建组织」按钮（服务端 hidden，无 JS 不显死按钮）+ 弹窗；无 JS 回退 = 内联表单
      assert.match(homeHtml, /<button type="button" id="new-org-open" class="header-actions" hidden>＋ 建组织<\/button>/, "页头「＋ 建组织」按钮（服务端 hidden）");
      assert.match(homeHtml, /<dialog class="fd" id="new-org-dialog">/, "建组织弹窗骨架");
      assert.match(homeHtml, /<div id="new-org-inline">/, "无 JS 内联回退表单保留");
      assert.ok(homeHtml.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), "泛化弹窗脚本随门户注入（闭集仍六元）");
      assert.doesNotMatch(homeHtml, /<script[^>]*src=/, "门户无外源脚本（CSP 未动）");
      assert.doesNotMatch(homeHtml, /id="schedule-board"|id="new-req-dialog"/, "门户不渲染看板正文 / 新增需求骨架");
      assert.deepEqual(client.calls, ["getFeatures"], "门户零新增触桥面（只复用列表读面）");

      const sched = await fetch(`${base}/schedule`);
      const schedHtml = await sched.text();
      assert.equal(sched.status, 200);
      assert.match(schedHtml, /<title>排期看板 · board<\/title>/);
      assert.match(schedHtml, /<a href="\/schedule" class="on">排期<\/a>/);
      assert.match(schedHtml, /<a href="\/">首页<\/a>/);
      assert.deepEqual(client.calls, ["getFeatures", "getFeatures"], "两页各自复用同一读面，不额外触桥");
    },
    {
      features,
      ledgerOrgs: [
        { org: "台账组" },
        { org: "停用组", disabledAt: "2026-09-27T00:00:00Z" },
      ],
    },
  );
});

test("P-④b NAV「首页」不进组织空间映射：空间页的首页项仍回全局门户", () => {
  const jia = { org: "甲组", orgs: ["甲组"] };
  assert.equal(navHrefFor(jia, "home", "/"), "/", "home 无空间档（空间页已有「← 回全局」）");
  assert.equal(navHrefFor(jia, "schedule", "/schedule"), "/org/%E7%94%B2%E7%BB%84/schedule", "排期项仍空间感知");
});
