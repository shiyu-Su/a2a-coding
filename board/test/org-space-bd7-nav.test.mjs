/**
 * BD7（v0.9.4 D 档）导航组织感知 + 顶栏切换器 —— 单测（**v0.9.6 B5a 改版**）：
 * ① ~~navHrefFor 纯函数口径~~ **整枚退役**（NAV 恒三枚全局 href，函数与 ORG_SPACE_VIEWS 同批删除）；
 * ② 空间页导航行（renderSpaceNav）承载「排期 / 任务 / 管理」三枚组织落点与当前项加粗（「需求」枚随 B5b F2 退役）；
 * ③ 顶栏切换器 = 纯 SSR 链接列表（当前组织标 on / 停用名不进清单 / 零新脚本）；
 * ④ 全局页旧锚随 `/schedule` 退役改 303；**口径 42 改版**：`/projects`、`/agents` 摘顶栏切换器
 *    （orgSwitcher=none ⇒ 整页无 org-switch；深链 `/tasks?project=X` 的 top 档保留，见 ②c）；门户 `/` 切换器不标当前组织；
 * ⑤ 错误出口透传（空间 405 / 空间深链桥宕页 / mismatch 409 浮层页均带切换器当前组织标记 + NAV 三枚闭集）。
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
// 台账在用名进清单（切换器源 = 台账在用 ∪ ownerGroup ∪ 板级默认）：口径 42 起 /projects、/agents 已摘
// 顶栏切换器（none）⇒ 本喂料只为钉「全局 /tasks?project=X 深链 = top 档切换器在顶栏」（BD7-②c），
// 否则清单为空、切换器本就不渲
const LEDGER_LIVE = {
  ledgerOrgs: [{ org: "组织甲" }, { org: "组织乙" }, { org: "停用组", disabledAt: "2026-09-27T00:00:00Z" }],
};

// ---------------------------------------------------------------------------
// ① navHrefFor 纯函数口径 —— 整枚退役（B5a ⑥：函数与 ORG_SPACE_VIEWS 同批删，NAV 恒全局三枚）
// ---------------------------------------------------------------------------
// 空间落点不再由 NAV 派生 ⇒ 本枚无钉对象；三枚闭集逐字节锚在 orgs-page N6-⑫ / web.test，
// 空间导航行的组织落点锚在下列 ②。

// ---------------------------------------------------------------------------
// ② 空间页导航行（B5a 起 = 组织落点的唯一承载位；**B5b 改版**：三枚 tab + 切换器移位到本行右）
// ---------------------------------------------------------------------------

/**
 * 从整页 HTML 截出顶栏 NAV 链接段（板壳的 `<nav>` 由 `</header>` 收尾、顶栏切换器（若有）在同一 `<nav>` 内
 * ⇒ 以这两者为右界定界；裸 `</nav>` 匹配不到，全站同形的比较面只能取这一段。
 * 口径 43：版本说明串已全站移除 ⇒ 定界不再钉 `<span class="muted mono">`）。
 */
const navLinksOf = (html) => {
  const m = /<nav>([\s\S]*?)(?=<span class="org-switch|<\/header>)/.exec(html);
  assert.ok(m !== null, "页面必须含 <nav> 段");
  return m[1];
};

/** NAV 的「形状」= 链接段摘掉当前项高亮（`class="on"` 随页而变，不是 NAV 形状；口径 37/38 三枚全站同形）并去首尾空白（切换器在不在顶栏只影响段尾那个分隔空格）。 */
const navShapeOf = (html) => navLinksOf(html).replace(/ class="on"/g, "").trim();

test("BD7-②（B5b 改版 · 空间排期页）：三枚 tab 且「排期」为当前项（class=fl on + inline 加粗）；「← 回全局」整撤；顶栏不再挂切换器；NAV 段与门户同形", async () => {
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
    assert.match(html, /<a href="\/projects">项目<\/a>/, "全局 NAV 文案收口（原「项目 / 机器」）");
    assert.match(html, /<a href="\/agents">Agent<\/a>/);
    assert.doesNotMatch(html, /<a href="\/host">宿主桥<\/a>/, "B5a：NAV 摘「宿主桥」条（路由与页函数不随摘，可达面 = 正文链接）");
    assert.doesNotMatch(html, /<a href="\/orgs">组织<\/a>/, "§9-c：全局 NAV「组织」项摘除（/orgs 页退役）");
    assert.doesNotMatch(html, /← 回全局/, "B5b ②：末段「回全局」整撤（回全局动线由顶栏「门户」承担）");
    // B5b ①：本页 orgSwitcher = body ⇒ 切换器只出现在正文导航行（右挂），顶栏 `<nav>` 内不重复挂
    // （定界用 `class="org-switch`：裸 "org-switch" 会先命中 <style> 里的同名选择器）
    assert.doesNotMatch(html.slice(0, html.indexOf("<main>")), /class="org-switch/, "空间页顶栏不渲切换器");
    assert.match(html.slice(html.indexOf("<main>")), /class="org-switch right"/, "切换器在正文二级导航行右");
    // ① 替代锚（navHrefFor 退役后）：NAV 段不随空间上下文变化 ⇒ 与门户页同形（三枚链接逐字节相等）
    const home = await (await fetch(`${base}/`)).text();
    assert.equal(navShapeOf(html), navShapeOf(home), "空间页与门户页的 NAV 段逐字节相等（全站同形）");
    assert.doesNotMatch(navLinksOf(html), /class="on"/, "空间页 NAV 落空不高亮（口径 2 / 20）");
  });
});

test("BD7-②c（B5b 改版 · 空间任务页）：二级导航行在位且当前项 = 任务；切换器随本行挂出并标当前组织；NAV 三枚闭集", async () => {
  await withNavServer({ ...DISK, ...LEDGER_LIVE }, async (base) => {
    const pick = await (await fetch(`${base}/org/${ENC_JIA}/tasks`)).text();
    assert.equal(pick.includes("<a href=\"/tasks\""), false, "B5a：NAV 无「任务」条 ⇒ 全局 /tasks href 不出现在空间任务页");
    // B5b ④：空间任务页补二级导航行（全局 /tasks 档不渲，见 ④b 对照）
    assert.match(
      pick,
      new RegExp(`<a class="fl on" href="/org/${ENC_JIA}/tasks" style="font-weight:700">任务</a>`),
      "空间任务页渲 renderSpaceNav(org,\"tasks\") 且当前项 = 任务",
    );
    assert.match(pick, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "切换器仍标当前组织（空间上下文不丢）");
    assert.doesNotMatch(pick.slice(0, pick.indexOf("<main>")), /class="org-switch/, "顶栏不重复挂切换器");
    // C1：全局裸 /tasks 退役 ⇒ 全局档对照样本换深链存活档（渲染分支同一条：org=null ∧ 带 project）
    const globalPick = await (await fetch(`${base}/tasks?project=p`)).text();
    assert.doesNotMatch(globalPick, /组织空间 <b>/, "全局档不渲二级导航行");
    assert.match(globalPick, /<header>[\s\S]*?class="org-switch"/, "全局任务页切换器照旧在顶栏（top 档）");
    const navSegment = (/<nav>([\s\S]*?)(?=<span class="org-switch">|<\/header>)/.exec(pick) ?? [, ""])[1];
    assert.deepEqual(
      [...navSegment.matchAll(/<a href="(\/[^"]*)"/g)].map((m) => m[1]),
      ["/", "/projects", "/agents"],
      "空间任务页 NAV 同为三枚闭集（全站同形）",
    );
  });
});

// ---------------------------------------------------------------------------
// ③ 顶栏切换器（SSR 链接列表 / 当前组织 / 停用隔离 / 零新脚本）
// ---------------------------------------------------------------------------

test("BD7-③（切换器）：空间页含全部在用组织、当前组织标 on；停用名不进清单", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const html = await (await fetch(`${base}/org/${ENC_JIA}/`)).text();
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "当前组织标记");
    assert.match(html, /<a href="\/org\/%E7%BB%84%E7%BB%87%E4%B9%99\/">组织乙<\/a>/);
    assert.doesNotMatch(html, /停用组/, "停用组织不进切换器（点了必 410）");
    assert.match(html, /class="org-switch right"/, "空间页切换器随二级导航行挂出");
  });
});

test("BD7-③b（零新脚本 · B5b 改版）：同族两空间页 script 数相等 + 导航行段内零脚本（窗口以 `</p>` 定界）", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const jia = await (await fetch(`${base}/org/${ENC_JIA}/`)).text();
    const yi = await (await fetch(`${base}/org/%E7%BB%84%E7%BB%87%E4%B9%99/`)).text();
    const count = (s) => (s.match(/<script/g) ?? []).length;
    assert.equal(count(jia), count(yi), "切换器/NAV 不得按组织维引入新 <script>");
    // 对照页换空间任务页（零脚本正文）+ 窗口定界到本段 `</p>`：切换器移位后它就在导航行段内，
    // 定界保证断言只看这一段（不再靠 800 字符的经验窗口）
    const pick = await (await fetch(`${base}/org/${ENC_JIA}/tasks`)).text();
    const row = /<p class="hint">组织空间[\s\S]*?<\/p>/.exec(pick);
    assert.ok(row !== null, "空间任务页必须含二级导航行");
    assert.match(row[0], /class="org-switch right"/, "切换器挂在本行右");
    assert.doesNotMatch(row[0], /<script|<select|onchange=/, "导航行段内零脚本（禁 select+onchange 形态）");
  });
});

// ---------------------------------------------------------------------------
// ④ 全局页旧锚随退役改档 + 门户仅增切换器
// ---------------------------------------------------------------------------

test("BD7-④（口径 42 改版）全局 `/schedule` ⇒ 303；`/projects` 与 `/agents` 摘顶栏组织切换器（orgSwitcher=none ⇒ 整页无 org-switch）", async () => {
  await withNavServer({ ...DISK, ...LEDGER_LIVE }, async (base) => {
    const retired = await fetch(`${base}/schedule`, { redirect: "manual" });
    assert.equal(retired.status, 303, "全局排期页退役 ⇒ 旧「NAV 六条逐字节」锚无宿主");
    await retired.body?.cancel();
    for (const path of ["/projects", "/agents"]) {
      const html = await (await fetch(`${base}${path}`)).text();
      // 口径 42：两页摘除顶栏切换器 ⇒ 整页不渲 org-switch（NAV 三枚闭集仍在，仅切换器撤）
      assert.doesNotMatch(html, /class="org-switch/, `${path} 整页不渲组织切换器（口径 42）`);
      assert.doesNotMatch(html, /<a href="\/org\//, `${path} 不再有组织切换器链接`);
      // NAV 三枚闭集仍逐字节在场（口径 42 只摘切换器，不动 NAV；当前页高亮 class=on 不在钉的范围）
      assert.match(html, /<a href="\/projects"[^>]*>项目<\/a>/, `${path} NAV「项目」条保留`);
      assert.match(html, /<a href="\/agents"[^>]*>Agent<\/a>/, `${path} NAV「Agent」条保留`);
    }
  });
});

test("BD7-④b（§9-b 翻向 · B5a 重指看板宿主 ·  B6 门户摘切换器）：`/` = 组织门户、`/org/<名>/schedule` = 排期看板；组织名门户经卡头链可见、空间页经切换器可见", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const home = await (await fetch(`${base}/`)).text();
    const sched = await (await fetch(`${base}/org/${ENC_JIA}/schedule`)).text();
    assert.notEqual(home, sched, "N3-② 旧「逐字节同构」锚随首页形态翻向");
    assert.match(home, /<title>组织门户 · board<\/title>/);
    assert.match(home, /<a href="\/" class="on">门户<\/a>/, "门户高亮首页项（B5a 文案「首页」→「门户」）");
    assert.match(sched, /<title>空间 · 组织甲 · 排期 · board<\/title>/, "看板宿主 = 空间排期页");
    // 口径同源（B6 改版）：门户与切换器仍共用 portalOrgNames（台账未停用 ∪ ownerGroup），
    // 但**门户不再渲切换器**（orgSwitcher=none）⇒ 组织名在门户的可见面 = 卡头链（.fl 形态）
    assert.match(home, new RegExp(`<a class="fl" href="/org/${ENC_JIA}/">组织甲</a>`), "B6：ownerGroup 源组织经门户卡头链可见（切换器已摘）");
    assert.doesNotMatch(home, /class="org-switch/, "B6：门户整页不渲切换器");
    assert.match(sched, new RegExp(`<a href="/org/${ENC_JIA}/"`), "ownerGroup 源组织在空间页切换器");
    assert.match(sched, new RegExp(`<a href="/org/%E7%BB%84%E7%BB%87%E4%B9%99/">组织乙</a>`), "另一组织同为纯链接（无当前标记）");
    for (const html of [home, sched]) {
      assert.doesNotMatch(html, /停用组/, "停用名两页都不进（同源口径）");
    }
    assert.doesNotMatch(home, /class="on">组织甲/, "门户无当前组织（B6 起整页无切换器，本锚退化为恒真守卫，保留防回归）");
    assert.match(sched, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "空间页切换器标当前组织");
    assert.match(home, /id="org-portal"/, "门户卡区容器（看板页无此锚）");
    assert.doesNotMatch(sched, /id="org-portal"/);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 错误出口透传（切换器当前组织标记随空间所有出口走；NAV 恒三枚）
// ---------------------------------------------------------------------------

test("BD7-⑤（B5a 改版 · 空间 405 表单页）：非 GET 命中空间读面 ⇒ 错误页带切换器当前组织 + NAV 三枚闭集", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${ENC_JIA}/`, { method: "PUT" });
    assert.equal(res.status, 405);
    const html = await res.text();
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "空间上下文仍透传（原高亮锚降级到切换器）");
    assert.doesNotMatch(html, /<a href="\/schedule" class="on">排期<\/a>/, "B5a：全局「排期」NAV 条已摘 ⇒ 空间错误页不出该高亮");
  });
});

test("BD7-⑤b（空间深链桥宕页 · B5a 改版）：/org/组织甲/features/不存在 ⇒ 宕页仍带切换器当前组织与三枚 NAV", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${ENC_JIA}/features/F-NOPE`);
    assert.equal(res.status, 502);
    const html = await res.text();
    assert.match(html, /桥不可达/);
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "切换器当前组织标记不丢");
    const navSegment = (/<nav>([\s\S]*?)(?=<span class="org-switch">|<\/header>)/.exec(html) ?? [, ""])[1];
    assert.deepEqual(
      [...navSegment.matchAll(/<a href="(\/[^"]*)"/g)].map((m) => m[1]),
      ["/", "/projects", "/agents"],
      "宕页 NAV = 三枚闭集（原「排期」空间 href 锚随摘条失效）",
    );
  });
});

test("BD7-⑤c（空间写 mismatch 409 浮层页 · B5a 改版）：表单档错误页带切换器当前组织与三枚 NAV", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${ENC_JIA}/requirements`, {
      method: "POST",
      headers: { "x-board-write": "1" },
      body: new URLSearchParams({ group: "组织乙", title: "串组", version: "" }).toString(),
    });
    assert.equal(res.status, 409);
    const html = await res.text();
    assert.match(html, /board_org_mismatch/);
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "409 浮层页切换器标记不丢");
    assert.doesNotMatch(html, /<a href="\/schedule" class="on">排期<\/a>/, "B5a：NAV 无「排期」条");
  });
});
