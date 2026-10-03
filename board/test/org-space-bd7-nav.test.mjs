/**
 * BD7（v0.9.4 D 档）导航组织感知 + 组切换 —— 单测（**v0.9.6 B5a 改版 · REQ-2026-09-30-04 件1 再改版**）：
 * ① ~~navHrefFor 纯函数口径~~ **整枚退役**（NAV 恒全局 href，函数与 ORG_SPACE_VIEWS 同批删除）；
 * ② 空间页导航行（renderSpaceNav）承载「排期 / 任务 / 管理」三枚组织落点与当前项加粗（「需求」枚随 B5b F2 退役）；
 *    **件1**：本行只留三枚 tab，行右组清单撤除 ⇒ 显示文案改名「组织空间」→「项目组空间」；
 * ③ 组切换 = **侧栏二级菜单**（纯 SSR 链接列表 / 当前组织标 on / 停用名不进清单 / 零新脚本）——
 *    件1 的形态变更：原「顶栏文字组 + 空间正文行右档」（`.org-switch`）整块撤除，功能语义逐条不变；
 * ④ 全局页旧锚随 `/schedule` 退役改 303；**件1 再改版**：`/projects`、`/agents` **撤出导航**（页面保留、
 *    深链可达）⇒ 一级菜单仅「项目组门户」一枚；侧栏组清单全站同挂（全局页 org=null ⇒ 不标 on）；
 * ⑤ 错误出口透传（空间 405 / 空间深链桥宕页 / mismatch 409 浮层页均带侧栏当前组织标记 + NAV 一枚闭集）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const ENC_JIA = "%E7%BB%84%E7%BB%87%E7%94%B2"; // 组织甲
const WRITE_HEADERS = { "x-board-write": "1", accept: "application/json" };

const feat = (featureId, ownerGroup, version, title) => ({
  featureId,
  state: "executing",
  title,
  requirement: `${title} 原文`,
  taskCount: 1,
  ownerGroup,
  stage: "改造方案",
  version,
  approval: "已通过",
  parentFeatureId: null,
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
  stateCounts: null,
});

function fakeClient(opts = {}) {
  const features = [
    feat("F-A1", "组织甲", "v1.0", "甲一"),
    feat("F-B1", "组织乙", "v1.0", "乙一"),
  ];
  return {
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        return { features, stateCounts: null };
      },
      async getFeature(featureId) {
        const hit = features.find((f) => f.featureId === featureId);
        if (!hit) throw new Error(`no such feature ${featureId}`);
        return {
          feature: { ...hit, plan: null, decisions: null, contracts: null },
          tasks: [],
          acceptance: null,
        };
      },
      async getProjects() {
        return { source: "fake", note: null, observedAt: "2026-09-27T00:00:00Z", machines: [], runners: [] };
      },
      async getTasks(projectId) {
        if (opts.throwOnTasks) throw new Error("任务面读取失败（用例注入）");
        return { projectId, reachable: true, notice: null, tasks: [] };
      },
    },
  };
}

function tmpEnv(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "board-bd7nav-"));
  const orgsRoot = join(dir, "orgs");
  mkdirSync(orgsRoot, { recursive: true });
  for (const o of opts.diskOrgs ?? []) mkdirSync(join(orgsRoot, o), { recursive: true });
  const ledgerFile = join(dir, "data", "orgs.json");
  if (opts.ledgerOrgs !== undefined) {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(ledgerFile, JSON.stringify({ version: 1, orgs: opts.ledgerOrgs }), "utf8");
  }
  return { dir, orgsRoot, ledgerFile };
}

async function withNavServer(envOptions, run, serverOverrides = {}) {
  const env = tmpEnv(envOptions);
  const { client } = fakeClient(envOptions.clientOpts);
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    docs: { repoRoot: env.dir, orgsDir: env.orgsRoot },
    orgsLedgerFile: env.ledgerFile,
    ...serverOverrides,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

const DISK = { diskOrgs: ["组织甲", "组织乙", "停用组"] };
const LEDGER = { ledgerOrgs: [{ org: "停用组", disabledAt: "2026-09-27T00:00:00Z" }] };
// 台账在用名进清单（侧栏组清单源 = 台账在用 ∪ ownerGroup ∪ 板级默认）：件1 起侧栏全站同挂
// ⇒ 本喂料钉的是「全局档（org=null）侧栏清单在位、不标 on」（BD7-②c / ④），
// 否则清单为空、本就不渲
const LEDGER_LIVE = {
  ledgerOrgs: [{ org: "组织甲" }, { org: "组织乙" }, { org: "停用组", disabledAt: "2026-09-27T00:00:00Z" }],
};

// ① navHrefFor 纯函数口径 —— 整枚退役（B5a ⑥：函数与 ORG_SPACE_VIEWS 同批删，NAV 恒全局路径；
//    **件1 再收一枚** ⇒ 恒「项目组门户」一条）
// ---------------------------------------------------------------------------
// 空间落点不再由 NAV 派生 ⇒ 本枚无钉对象；一枚闭集逐字节锚在 orgs-page N6-⑫ / web.test，
// 空间导航行的组织落点锚在下列 ②。

// ---------------------------------------------------------------------------
// ② 空间页导航行（B5a 起 = 组织落点的唯一承载位；**B5b 改版**：三枚 tab + 切换器移位到本行右；
//    **件1**：行右组清单再撤 ⇒ 本行只剩三枚 tab，组切换归侧栏二级菜单）
// ---------------------------------------------------------------------------

/**
 * 从整页 HTML 截出侧栏一级菜单 `<nav>` 段（**件1 改版**：`<nav>` 由自己的 `</nav>` 收尾 ——
 * 顶栏切换器已随外壳退役，段内不再混装别的东西，定界不再需要 `</header>` 右界）。
 */
const navLinksOf = (html) => {
  const m = /<nav>([\s\S]*?)<\/nav>/.exec(html);
  assert.ok(m !== null, "页面必须含 <nav> 段");
  return m[1];
};

/** NAV 的「形状」= 链接段摘掉当前项高亮（`class="on"` 随页而变，不是 NAV 形状；口径 37/38 全站同形）并去首尾空白。 */
const navShapeOf = (html) => navLinksOf(html).replace(/ class="on"/g, "").trim();

/** 侧栏二级菜单（组清单）段 = `<div class="side-orgs">…</div>`；未挂出时整块不渲染。 */
const sideOrgsOf = (html) => (/<div class="side-orgs">([\s\S]*?)<\/div><\/aside>/.exec(html) ?? [, ""])[1];

test("BD7-②（B5b 改版 · 空间排期页 · 件1 再改版）：三枚 tab 且「排期」为当前项；行右组清单撤除；NAV 一枚闭集且与门户同形", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const html = await (await fetch(`${base}/org/${ENC_JIA}/`)).text();
    assert.match(
      html,
      new RegExp(`<a class="fl on" href="/org/${ENC_JIA}/schedule" style="font-weight:700">排期</a>`),
      "空间行当前项 = 排期（B5b 起另挂 class=fl on 作位置钩子）",
    );
    assert.match(html, new RegExp(`<a class="fl" href="/org/${ENC_JIA}/tasks">任务</a>`), "任务落本空间");
    // §9-c：空间内导航行增「管理」入口（未高亮 ⇒ 不加粗；管理页本体见 orgs-page N3-①）
    assert.match(html, new RegExp(`<a class="fl" href="/org/${ENC_JIA}/manage">管理</a>`), "空间行含管理入口");
    // F2：需求枚随 `/org/<名>/features` 整页退役 ⇒ 空间行不出第三枚之外的「需求」tab
    assert.doesNotMatch(
      html,
      new RegExp(`<a class="fl" href="/org/${ENC_JIA}/features">需求</a>`),
      "「需求」枚整删（OrgSpaceView 收窄三元）",
    );
    // 件1：/projects、/agents 撤出导航（页面保留、深链可达）⇒ NAV 段内不得出现二者 href
    const navSegment = navLinksOf(html);
    assert.doesNotMatch(navSegment, /href="\/projects"/, "件1：「项目」条撤出导航");
    assert.doesNotMatch(navSegment, /href="\/agents"/, "件1：「Agent」条撤出导航");
    assert.doesNotMatch(html, /<a href="\/host">宿主桥<\/a>/, "B5a：NAV 摘「宿主桥」条（路由与页函数不随摘，可达面 = 正文链接）");
    assert.doesNotMatch(html, /<a href="\/orgs">组织<\/a>/, "§9-c：全局 NAV「组织」项摘除（/orgs 页退役）");
    assert.doesNotMatch(html, /← 回全局/, "B5b ②：末段「回全局」整撤（回全局动线由侧栏一级菜单承担）");
    // 件1 ①：`.org-switch` 整块退役（顶栏档 + 空间正文行右档同撤）⇒ 全页零命中（含 <style> 选择器）
    assert.doesNotMatch(html, /org-switch/, "件1：`.org-switch` 形态与样式一并撤除");
    assert.doesNotMatch(navSegment, /class="on"/, "空间页 NAV 落空不高亮（口径 2 / 20；active=空间视图不在一枚闭集内）");
    // ① 替代锚（navHrefFor 退役后）：NAV 段不随空间上下文变化 ⇒ 与门户页同形（一枚链接逐字节相等）
    const home = await (await fetch(`${base}/`)).text();
    assert.equal(navShapeOf(html), navShapeOf(home), "空间页与门户页的 NAV 段逐字节相等（全站同形）");
    // 件1 ②：组清单只在侧栏 —— 正文（`<main>` 起）不重复挂组链接
    const body = html.slice(html.indexOf("<main>"));
    assert.doesNotMatch(body, /<a href="\/org\//, "正文不重复挂组清单（唯一承载位 = 侧栏）");
    assert.match(sideOrgsOf(html), new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "侧栏二级菜单标当前组织");
  });
});

test("BD7-②c（B5b 改版 · 空间任务页 · 件1 再改版）：二级导航行在位且当前项 = 任务；组清单归侧栏并标当前组织；NAV 一枚闭集", async () => {
  await withNavServer({ ...DISK, ...LEDGER_LIVE }, async (base) => {
    const pick = await (await fetch(`${base}/org/${ENC_JIA}/tasks`)).text();
    assert.equal(pick.includes("<a href=\"/tasks\""), false, "B5a：NAV 无「任务」条 ⇒ 全局 /tasks href 不出现在空间任务页");
    // B5b ④：空间任务页补二级导航行（全局 /tasks 档不渲，见 ④b 对照）
    assert.match(
      pick,
      new RegExp(`<a class="fl on" href="/org/${ENC_JIA}/tasks" style="font-weight:700">任务</a>`),
      "空间任务页渲 renderSpaceNav(org,\"tasks\") 且当前项 = 任务",
    );
    assert.match(pick, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "侧栏仍标当前组织（空间上下文不丢）");
    // C1：全局裸 /tasks 退役 ⇒ 全局档对照样本换深链存活档（渲染分支同一条：org=null ∧ 带 project）
    const globalPick = await (await fetch(`${base}/tasks?project=p`)).text();
    assert.doesNotMatch(globalPick, /项目组空间 <b>/, "全局档不渲二级导航行");
    // 件1：原「全局任务页切换器在顶栏（top 档）」改档 = 侧栏组清单在位、org=null ⇒ 不标 on
    assert.match(globalPick, /<aside class="sidebar">[\s\S]*?<div class="side-orgs">/, "全局任务页组清单在侧栏");
    assert.doesNotMatch(globalPick, /<a href="\/org\/[^"]*" class="on">/, "全局档无当前组织（一枚闭集内无高亮可落）");
    const navSegment = navLinksOf(pick);
    assert.deepEqual(
      [...navSegment.matchAll(/<a href="(\/[^"]*)"/g)].map((m) => m[1]),
      ["/"],
      "空间任务页 NAV 同为一枚闭集（全站同形 · 件1）",
    );
  });
});

// ---------------------------------------------------------------------------
// ③ 侧栏二级菜单（SSR 链接列表 / 当前组织 / 停用隔离 / 零新脚本）
// ---------------------------------------------------------------------------

test("BD7-③（侧栏组清单）：空间页含全部在用组织、当前组织标 on；停用名不进清单", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const html = await (await fetch(`${base}/org/${ENC_JIA}/`)).text();
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "当前组织标记");
    assert.match(html, /<a href="\/org\/%E7%BB%84%E7%BB%87%E4%B9%99\/">组织乙<\/a>/);
    assert.doesNotMatch(html, /停用组/, "停用组织不进侧栏清单（点了必 410）");
    // 件1：清单的承载位 = 侧栏（`.side-orgs`），文案改「项目组」；原 `org-switch right` 档撤
    assert.match(html, /<div class="side-orgs"><p class="side-orgs-label">项目组<\/p>/, "侧栏二级菜单带「项目组」小标");
    assert.doesNotMatch(html, /org-switch/, "原切换器形态（顶栏 / 行右）整撤");
  });
});

test("BD7-③b（零新脚本 · 件1 改版）：同族两空间页 script 数相等 + 侧栏段与导航行段内零脚本", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const jia = await (await fetch(`${base}/org/${ENC_JIA}/`)).text();
    const yi = await (await fetch(`${base}/org/%E7%BB%84%E7%BB%87%E4%B9%99/`)).text();
    const count = (s) => (s.match(/<script/g) ?? []).length;
    assert.equal(count(jia), count(yi), "侧栏组清单/NAV 不得按组织维引入新 <script>");
    // 导航行窗口定界到本段 `</p>`；件1 起组清单已撤出该行 ⇒ 断言行内只有三枚 tab、无组链接
    const pick = await (await fetch(`${base}/org/${ENC_JIA}/tasks`)).text();
    const row = /<p class="hint">项目组空间[\s\S]*?<\/p>/.exec(pick);
    assert.ok(row !== null, "空间任务页必须含二级导航行");
    assert.doesNotMatch(row[0], /side-orgs|<a href="\/org\/[^"]*">组织/, "组清单撤出导航行（改挂侧栏）");
    assert.doesNotMatch(row[0], /<script|<select|onchange=/, "导航行段内零脚本（禁 select+onchange 形态）");
    const sidebar = /<aside class="sidebar">[\s\S]*?<\/aside>/.exec(jia);
    assert.ok(sidebar !== null, "外壳必须含侧栏段");
    assert.doesNotMatch(sidebar[0], /<script|<select|onchange=/, "侧栏段内零脚本（切换 = 纯 SSR 链接）");
  });
});

// ---------------------------------------------------------------------------
// ④ 全局页旧锚随退役改档 + 侧栏组清单的挂出面
// ---------------------------------------------------------------------------

test("BD7-④（口径 42 改版 · 件1 再改版）全局 `/schedule` ⇒ 303；`/projects` 与 `/agents` 撤出导航但侧栏组清单照挂（固定外壳全站同形）", async () => {
  await withNavServer({ ...DISK, ...LEDGER_LIVE }, async (base) => {
    const retired = await fetch(`${base}/schedule`, { redirect: "manual" });
    assert.equal(retired.status, 303, "全局排期页退役 ⇒ 旧「NAV 六条逐字节」锚无宿主");
    await retired.body?.cancel();
    for (const path of ["/projects", "/agents"]) {
      const html = await (await fetch(`${base}${path}`)).text();
      // 件1 改版：原口径 42「两页摘顶栏切换器」随固定侧栏失效 —— 侧栏二级菜单全站同挂、
      // 全局页 org=null ⇒ 不标 on（翻向逐条见回执；不再断言整页无组清单）
      assert.doesNotMatch(html, /class="org-switch/, `${path} 原切换器形态整撤`);
      assert.match(html, /<div class="side-orgs"><p class="side-orgs-label">项目组<\/p>/, `${path} 侧栏组清单在位`);
      assert.doesNotMatch(html, /<a href="\/org\/[^"]*" class="on">/, `${path} 无当前空间（org=null ⇒ 不标 on）`);
      // 件1：本二页撤出导航（路由与页函数不随摘 ⇒ 深链照旧可达，只是 NAV 不出条目）
      const navSegment = navLinksOf(html);
      assert.deepEqual(
        [...navSegment.matchAll(/<a href="(\/[^"]*)"/g)].map((m) => m[1]),
        ["/"],
        `${path} NAV = 一枚闭集（「项目」「Agent」撤出导航）`,
      );
    }
  });
});

test("BD7-④b（§9-b 翻向 · B5a 重指看板宿主 ·  B6 门户摘切换器 · 件1 一级菜单改文案）：`/` = 项目组门户、`/org/<名>/schedule` = 排期看板；组织名门户经卡头链可见、空间页经侧栏清单可见", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const home = await (await fetch(`${base}/`)).text();
    const sched = await (await fetch(`${base}/org/${ENC_JIA}/schedule`)).text();
    assert.notEqual(home, sched, "N3-② 旧「逐字节同构」锚随首页形态翻向");
    assert.match(home, /<title>项目组门户 · board<\/title>/);
    assert.match(home, /<a href="\/" class="on">项目组门户<\/a>/, "门户高亮唯一一级项（件1 文案「门户」→「项目组门户」）");
    assert.match(sched, /<title>空间 · 组织甲 · 排期 · board<\/title>/, "看板宿主 = 空间排期页");
    // 口径同源（B6 改版）：门户与侧栏清单仍共用 portalOrgNames（台账未停用 ∪ ownerGroup）；
    // 件1 起门户不再单独摘挂 —— 门户的 orgNav 装配照旧（它是卡区数据源），
    // 组织名在门户的**卡面**可见面 = 卡头链（.fl 形态）
    assert.match(home, new RegExp(`<a class="fl" href="/org/${ENC_JIA}/">组织甲</a>`), "B6：ownerGroup 源组织经门户卡头链可见");
    assert.match(home, /<div class="side-orgs">/, "件1：门户侧栏挂项目组清单（原 B6「整页无切换器」锚随形态翻向）");
    assert.match(sched, new RegExp(`<a href="/org/${ENC_JIA}/"`), "ownerGroup 源组织在空间页侧栏清单");
    assert.match(sched, new RegExp(`<a href="/org/%E7%BB%84%E7%BB%87%E4%B9%99/">组织乙</a>`), "另一组织同为纯链接（无当前标记）");
    for (const html of [home, sched]) {
      assert.doesNotMatch(html, /停用组/, "停用名两页都不进（同源口径）");
    }
    assert.doesNotMatch(home, /class="on">组织甲/, "门户无当前组织（org=null ⇒ 侧栏清单不标 on）");
    assert.match(sched, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "空间页侧栏清单标当前组织");
    assert.match(home, /id="org-portal"/, "门户卡区容器（看板页无此锚）");
    assert.doesNotMatch(sched, /id="org-portal"/);
  });
});

// ---------------------------------------------------------------------------
// ④c 件2：需求详情页也携带空间 tab 行（无激活态，作空间上下文与返回口）
// ---------------------------------------------------------------------------

test("BD7-④c（件2）：详情页带空间 tab 行且**无激活态**；归属缺失或已停用 ⇒ 不给死链", async () => {
  await withNavServer({ ...DISK, ...LEDGER_LIVE }, async (base) => {
    const globalPage = await (await fetch(`${base}/features/F-A1`)).text();
    const row = /<div class="b-tabs">[\s\S]*?<\/div>/.exec(globalPage);
    assert.ok(row !== null, "全局详情页按卡面 ownerGroup 带出空间 tab 行");
    assert.match(row[0], /项目组空间 <b>组织甲<\/b>/, "行内组织 = 该卡归属组（不臆造默认组）");
    assert.doesNotMatch(row[0], /class="fl on"/, "详情页不属于任何一档视图 ⇒ 三枚皆无激活态");
    assert.match(row[0], /<a class="fl" href="\/org\/%E7%BB%84%E7%BB%87%E7%94%B2\/schedule">排期<\/a>/);
    const spacePage = await (await fetch(`${base}/org/${ENC_JIA}/features/F-A1`)).text();
    assert.match(
      spacePage,
      /<div class="b-tabs"><p class="hint">项目组空间 <b>组织甲<\/b>/,
      "空间档同形（路由组织优先，行仍是无激活态档）",
    );
    assert.doesNotMatch(spacePage, /class="fl on"[^>]*>排期</, "空间详情页不得把「排期」误标为当前档");
    // 浮层换页容器取的是 `<main>` 正文 ⇒ tab 行随正文一起进浮层（返回口在浮层内可用）
    assert.ok(globalPage.indexOf('<div class="b-tabs">') < globalPage.indexOf('<div class="b-steps">'), "tab 行在正文最前");
  });
  // 组织乙在台账里停用 ⇒ 其卡的详情页不带该行（空间路由点了必 410，不给死链）
  await withNavServer(
    { ...DISK, ledgerOrgs: [{ org: "组织甲" }, { org: "组织乙", disabledAt: "2026-09-27T00:00:00Z" }] },
    async (base) => {
      const page = await (await fetch(`${base}/features/F-B1`)).text();
      assert.equal(page.includes('class="b-tabs"'), false, "归属组织已停用 ⇒ 不渲空间 tab 行");
    },
  );
});

// ---------------------------------------------------------------------------
// ⑤ 错误出口透传（侧栏当前组织标记随空间所有出口走；NAV 恒一枚）
// ---------------------------------------------------------------------------

test("BD7-⑤（B5a 改版 · 空间 405 表单页）：非 GET 命中空间读面 ⇒ 错误页带侧栏当前组织 + NAV 一枚闭集", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${ENC_JIA}/`, { method: "PUT" });
    assert.equal(res.status, 405);
    const html = await res.text();
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "空间上下文仍透传（原高亮锚降级到侧栏清单）");
    assert.doesNotMatch(html, /<a href="\/schedule" class="on">排期<\/a>/, "B5a：全局「排期」NAV 条已摘 ⇒ 空间错误页不出该高亮");
  });
});

test("BD7-⑤b（空间深链桥宕页 · B5a 改版 · 件1 一枚闭集）：/org/组织甲/features/不存在 ⇒ 宕页仍带侧栏当前组织与一枚 NAV", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${ENC_JIA}/features/F-NOPE`);
    assert.equal(res.status, 502);
    const html = await res.text();
    assert.match(html, /桥不可达/);
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "侧栏当前组织标记不丢");
    assert.deepEqual(
      [...navLinksOf(html).matchAll(/<a href="(\/[^"]*)"/g)].map((m) => m[1]),
      ["/"],
      "宕页 NAV = 一枚闭集（原「排期」空间 href 锚随摘条失效）",
    );
  });
});

test("BD7-⑤c（空间写 mismatch 409 浮层页 · B5a 改版）：表单档错误页带侧栏当前组织与一枚 NAV", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${ENC_JIA}/requirements`, {
      method: "POST",
      headers: { "x-board-write": "1" },
      body: new URLSearchParams({ group: "组织乙", title: "串组", version: "" }).toString(),
    });
    assert.equal(res.status, 409);
    const html = await res.text();
    assert.match(html, /board_org_mismatch/);
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "409 浮层页侧栏标记不丢");
    assert.doesNotMatch(html, /<a href="\/schedule" class="on">排期<\/a>/, "B5a：NAV 无「排期」条");
  });
});
