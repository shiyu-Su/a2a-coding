/**
 * REQ-2026-10-10-02 · N4「① / ④ 的**读数与分源**锚」—— ★**纯测试节点**（零 `src/**` 改动）。
 *
 * **A. 读数锚** —— 管理页（`GET /org/<名>/manage`）**一次渲染 = 恰一次** `GET /api/versions`。
 *  本页 fan-out = **4 枪闭集**（声明面 groups · 运行态 projects · 注册表快照 registry · 版本投影 versions）；
 *  N2 之前是 3 枪，第 4 枪是 8787 上的**第二条 HTTP 读路**，**不新增上游主机**。
 *  ★本锚**承接**改造文档 §2.3 B-2 —— 原「共用 Group 那次投影、零新增上游」的锚（`v0101-server-project-block-wiring`）
 *  随 ③ 区块退役后由本文件在管理页承接（两处交叉注明；被承接侧的摘除 = N5）。
 *  **防后人加第 5 枪**两头钉：运行时计数（一次渲染 ⇒ versions 恰 1）+ 源码单点
 *  （全文件 `ctx.engineVersions()` 恰一处 = 在途共用的 `versionProjectionOf`；页内 `versionProjectionOf(ctx)` 恰一处）。
 *
 * **B. 硬口径 8 · 钉一（不同通路不得合流）** —— 「版本投影读不到」走 `/api/versions` **HTTP 面**、
 *  「项目卡不可达」走 `a2a_projects` **MCP 面**，两条通路各判各的：
 *  · 正向 ⇒ 允许「**有行 + 列全 `—` + 短条报读不到**」这一**合法组合**（投影根因码不得漏进项目卡）；
 *  · 反向 ⇒ 项目卡不可达**不得**把短条第三源拖成读不到（第三源照常「可读」）；
 *  · stale 档 ⇒ 列取**最后一次投影**照常显号、不带提示，同轮短条报「本次读不到」（两源结论不同源）。
 *
 * **C. 硬口径 8 · 钉二（不得加第 5 档）** —— 8787 **整挂**时两路同源失败，新列**自然不现**：
 *  该不现由「**无表**」产生（项目卡走自己的「不可达」早退分支、表根本不渲），**不是列自己判的**
 *  ⇒ 项目卡分档恒为**三档闭集**（未查询 / 不可达 / 运行态 N 项）；源码形状与渲出口径两头钉住，
 *  **不得**为「8787 整挂」增设第 4 / 5 档。
 *
 * 范围外（归它处）：列的取值三子判据与形制 = N3（`v0102-manage-project-column`）；
 * 第三源的三态闭集与判据序 = N2（`v0102-config-check-third-row`）；排期页零处钉 = N5。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderOrgSpaceManagePage } from "../dist/web/views.js";
import { createBoardServer } from "../dist/server.js";
import {
  engineProjectionAbsentFetcher,
  engineProjectionFetcher,
  engineProjectionOf,
  engineProjectAbsentField,
  engineProjectLiveField,
} from "./engine-versions-fixture.mjs";

const OBSERVED_AT = "2026-10-10T00:00:00.000Z";
const ORG = "alpha";
/** ④ 档1（本进程从未读到过投影）的根因码 —— 诚实通道的唯一落点在页头核对短条。 */
const NEVER_CODE = "project_versions_group_projection_unreadable";

const GROUPS_OK = {
  ok: true,
  warnings: [],
  observedAt: OBSERVED_AT,
  groups: [{ name: ORG, memberCount: 1, members: [{ machineId: "m1", projectId: "board" }] }],
};
const PROJECTS_OK = {
  ok: true,
  projects: [
    { machineId: "m1", projectId: "board", agentKind: "qoder", a2aPort: 1, status: "ok", startedAt: null, machineError: null },
  ],
};
const RELEASED_ROWS = [{ org: ORG, projectId: "board", version: "v0.10.2", status: "released" }];

/** 归一层可见的本组需求一枚（空间路由按 `ownerGroup` 认组织；本节点只借它把路由打开）。 */
const ALPHA_FEATURE = {
  featureId: "F1",
  state: "executing",
  title: "需求 F1",
  taskCount: 1,
  ownerGroup: ORG,
  stage: "改造方案",
  version: "v0.10.2",
  approval: "已通过",
  createdAt: "c",
  updatedAt: "u",
  stateCounts: null,
};

// ---------------------------------------------------------------------------
// 投影本体（复用夹具的同步构造器，不手抄投影形状）
// ---------------------------------------------------------------------------

const liveProjection = engineProjectionOf([], "", engineProjectLiveField(RELEASED_ROWS)).projection;
const absentProjection = engineProjectionOf([], "", engineProjectAbsentField()).projection;

/** 与 `pageOrgSpaceManage` 的装配同路：投影本体 + 本次读失败根因 + 降级文案（本文件不测文案单点）。 */
function feed(projection, failure = null) {
  return { projection, failure, degradationText: null };
}

// ---------------------------------------------------------------------------
// 纯视图面 harness
// ---------------------------------------------------------------------------

function manageHtml(versionProjection, overrides = {}) {
  const input = { org: ORG, features: [], groupsOutcome: GROUPS_OK, projectsOutcome: PROJECTS_OK, ...overrides };
  if (versionProjection !== undefined) input.versionProjection = versionProjection;
  return renderOrgSpaceManagePage(input);
}

// ---------------------------------------------------------------------------
// HTML 切片 helpers（区域分立：项目卡 / 新列表 / 短条第三源 / 短条第一源）
// ★REQ-2026-10-11-05 ⑧b：⑧ 核对卡已降级为页头短条 ⇒ 取行对象从卡表 `<tr>` 换成
//   「标签 → `<b>` 档位词」段 + 该源说明 `<li>`（与 `v0102-config-check-third-row` 同法）。
// ---------------------------------------------------------------------------

/** 新列所在的表（按新表头三段定位，与 N3 同法）。 */
function projectsTable(html) {
  const hit = html.match(
    /<table><thead><tr><th>machineId<\/th><th>projectId<\/th><th>已发布的最新版本号<\/th>[\s\S]*?<\/table>/,
  );
  return hit === null ? "" : hit[0];
}

/** 「项目」卡整块（卡题字面恰为「项目」⇒ 不误取「项目池」/「成员（项目组台账）」）。 */
function projectCard(html) {
  const hit = html.match(/<div class="b-card(?: [a-z-]+)*">\n<p class="b-card-h">项目<span class="b-card-meta">[\s\S]*?\n<\/div>/);
  return hit === null ? "" : hit[0];
}

/** 项目卡卡头副标 = 该卡分档的渲出口径。 */
function projectCardMeta(html) {
  const hit = projectCard(html).match(/<p class="b-card-h">项目<span class="b-card-meta">([\s\S]*?)<\/span><\/p>/);
  return hit === null ? null : hit[1];
}

const LABEL_GROUPS = "声明面成员（3300 <code>GET /api/groups</code>）";
const LABEL_VERSION = "引擎版本台账投影（project 档 · <code>GET /api/versions</code>）";

/** 页头短条正文（`<p class="hint">核对源健康度：…</p>` 冒号之后）；短条不在场 ⇒ ""。 */
function barText(html) {
  const hit = html.match(/<p class="hint">核对源健康度：([\s\S]*?)<\/p>/);
  return hit === null ? "" : hit[1];
}

/** 短条内某源那一档（标签起 → 其 `<b>` 档位词止）+ 该源的说明 `<li>`；该源不参评 ⇒ ""。 */
function barFace(html, label) {
  const bar = barText(html);
  const at = bar.indexOf(label);
  if (at < 0) return "";
  const segHit = bar.slice(at).match(/^[\s\S]*?<b>[^<]*<\/b>/);
  const liAt = html.indexOf(`<li>${label}：`);
  const liEnd = liAt < 0 ? -1 : html.indexOf("</li>", liAt);
  const note = liEnd < 0 ? "" : html.slice(liAt, liEnd + 5);
  return (segHit === null ? "" : segHit[0]) + note;
}

/** 短条内某源的档位词（`未装配` / `读不到` / `本次读不到` / `可读`）；不参评 ⇒ ""。 */
function barTier(html, label) {
  const hit = barFace(html, label).match(/<b>([^<]*)<\/b>/);
  return hit === null ? "" : hit[1];
}

/** 负钉护栏：短条段为空时「某串不在场」的断言会退化成恒真 ⇒ 先钉住在场。 */
function barFacePresent(html, label, where) {
  const face = barFace(html, label);
  assert.notEqual(face, "", `${where}：「${label.slice(0, 8)}…」短条段须在场（否则本条负钉是恒真锚）`);
  return face;
}

// ---------------------------------------------------------------------------
// 真通路 harness：四个注入面各记一枪 ⇒ 一次请求一份调用账
// ---------------------------------------------------------------------------

async function withManageServer(opts, run) {
  const dir = mkdtempSync(join(tmpdir(), "board-n4-"));
  mkdirSync(join(dir, "orgs"), { recursive: true });
  const calls = { features: 0, groups: 0, projects: 0, registry: 0 };
  /** versions 的计数面**只用夹具自带的那一份**（同事实不两处各记，免得两账打架）。 */
  const versionsFetcher = opts.engineVersionsFetcher ?? engineProjectionFetcher([], "", engineProjectLiveField(RELEASED_ROWS));
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        calls.features += 1;
        return { features: [ALPHA_FEATURE], stateCounts: null };
      },
      async getRegistryProjects() {
        calls.registry += 1;
        return {
          source: "fake",
          note: null,
          observedAt: OBSERVED_AT,
          machines: [
            {
              machineId: "m1",
              error: null,
              projects: [{ projectId: "board", agentKind: "qoder", a2aPort: 1, status: "ok", endpoint: null, startedAt: null }],
            },
          ],
          runners: [],
        };
      },
    },
    now: () => Date.parse(OBSERVED_AT),
    docs: { repoRoot: dir, orgsDir: join(dir, "orgs") },
    orgsLedgerFile: join(dir, "data", "orgs.json"),
    orgGroupsFetcher: async () => {
      calls.groups += 1;
      return opts.groupsOutcome === undefined ? GROUPS_OK : opts.groupsOutcome;
    },
    orgProjectsFetcher: async () => {
      calls.projects += 1;
      if (opts.projectsFetcherThrows === true) throw new Error("夹具：a2a_projects（MCP 面）不可达");
      return opts.projectsOutcome === undefined ? PROJECTS_OK : opts.projectsOutcome;
    },
    engineVersionsFetcher: versionsFetcher,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, calls, versionsFetcher);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// 源码锚 helpers
// ---------------------------------------------------------------------------

const SERVER_TS = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
const VIEWS_TS = readFileSync(fileURLToPath(new URL("../src/web/views.ts", import.meta.url)), "utf8");

/** 取某个顶层函数的源码切片（到下一个顶层 `function` 声明之前）。 */
function sourceSlice(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `源码锚：${declaration} 已不存在（改名 / 删除须同步本锚）`);
  const rest = source.slice(start + declaration.length);
  const next = rest.search(/\n(?:export )?(?:async )?function /);
  return source.slice(start, next === -1 ? source.length : start + declaration.length + next);
}

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// ===========================================================================
// A. 读数锚 —— 一次渲染 = 恰一次 `GET /api/versions`（4 枪闭集）
// ===========================================================================

test("N4-A1（★核心）真通路一次渲染 = 恰一次 /api/versions，且页内 fan-out 是 4 源各一枪的闭集", async () => {
  await withManageServer({}, async (base, calls, versionsFetcher) => {
    const res = await fetch(`${base}/org/${ORG}/manage`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(projectsTable(html), /<th>已发布的最新版本号<\/th>/, "本档确实渲出了新列（计数锚不得空转）");
    assert.match(projectsTable(html), /<td>v0\.10\.2<\/td>/, "新列确实吃到了这一枪取回的投影");
    assert.equal(versionsFetcher.calls, 1, "★GET /api/versions 恰一枪");
    assert.deepEqual(calls, { features: 1, groups: 1, projects: 1, registry: 1 }, "其余三枪 + 归一层各一枪 ⇒ 加第 5 枪即在此红");
  });
});

test("N4-A2 在途共用只在同一次渲染内 ⇒ 两次渲染 = 两枪（跨渲染不缓存、不落库）", async () => {
  await withManageServer({}, async (base, calls, versionsFetcher) => {
    await (await fetch(`${base}/org/${ORG}/manage`)).text();
    assert.equal(versionsFetcher.calls, 1);
    await (await fetch(`${base}/org/${ORG}/manage`)).text();
    assert.equal(versionsFetcher.calls, 2, "每次渲染各打一枪：没有「整进程一枪」的隐性缓存");
    assert.equal(calls.registry, 2, "同一次渲染的其余各源同样按渲染次数计（对照锚，防把计数器写歪）");
  });
});

test("N4-A3（★源码单点钉）全文件 ctx.engineVersions() 恰一处 ⇒ 取数单点唯一 = versionProjectionOf", () => {
  assert.equal(countOf(SERVER_TS, "ctx.engineVersions()"), 1, "第二处直打投影读取面 = 第 5 枪的根（消费点须经在途共用的单点）");
  const hit = SERVER_TS.match(/.{0,200}ctx\.engineVersions\(\).{0,60}/s);
  assert.ok(hit !== null);
  assert.ok(hit[0].includes("const outcome = await ctx.engineVersions();"), "唯一那一处须在 versionProjectionOf 的在途装配内");
  assert.ok(hit[0].includes("await ctx.engineVersions();"), "按调用式核，不被注释或字符串里的同名提及蒙过");
});

test("N4-A4（★页内单点钉）pageOrgSpaceManage 的 fan-out 内 versionProjectionOf(ctx) 恰一处、零直打读取面", () => {
  const body = sourceSlice(SERVER_TS, "async function pageOrgSpaceManage");
  assert.equal(countOf(body, "versionProjectionOf(ctx)"), 1, "本页第二次取投影 = 多消费点没共用同一在途结果");
  assert.equal(countOf(body, "ctx.engineVersions("), 0, "页内不得绕过单点直打投影读取面");
  assert.equal(countOf(body, "ctx.engineVersions"), 1, "唯一的 `ctx.engineVersions*` 引用 = 读根因字段 engineVersionsFailure（不是第二枪）");
  assert.match(body, /const \[groups, projects, snapshot, projection\] = await Promise\.all\(\[/, "四路仍是同一次并行 fan-out（串行化会翻倍等待）");
});

// ===========================================================================
// B. 硬口径 8 · 钉一 —— 投影读不到 ⇎ 项目卡不可达（两条通路不得合流）
// ===========================================================================

test("N4-B1（★合法组合 · 真通路）投影读不到 ∧ 运行态可读 ⇒「有行 + 列全 — + 短条报读不到」", async () => {
  await withManageServer({ engineVersionsFetcher: engineProjectionAbsentFetcher() }, async (base) => {
    const res = await fetch(`${base}/org/${ORG}/manage`);
    assert.equal(res.status, 200, "HTTP 面读不到不得炸页");
    const html = await res.text();
    const table = projectsTable(html);
    assert.match(table, /<th>已发布的最新版本号<\/th>/, "列照渲 —— MCP 面那一路不受牵连");
    assert.match(table, /<td>—<\/td>/, "无号可取 ⇒ 列显 —");
    assert.equal(projectCardMeta(html), "运行态 1 项", "项目卡走自己的正常档");
    assert.equal(projectCard(html).includes("不可达"), false, "★投影根因不得并入项目卡的 !outcome.ok 分支");
    assert.equal(projectCard(html).includes(NEVER_CODE), false, "根因码唯一落点 = 页头核对短条，不得漏进列体");
    assert.equal(barTier(html, LABEL_VERSION), "读不到", "短条走第三源自己的档");
    assert.match(barFacePresent(html, LABEL_VERSION, "B1"), new RegExp(NEVER_CODE), "短条如实报第三源读不到");
    assert.equal(html.includes("配置齐备"), false, "第三源读不到 ⇒ 不谎报齐备");
  });
});

test("N4-B1b 同档的纯视图面：projection=null 与老引擎 absent 两档都不改写项目卡分支", () => {
  for (const [name, vp] of Object.entries({ null档: feed(null), absent档: feed(absentProjection) })) {
    const html = manageHtml(vp);
    assert.equal(projectCardMeta(html), "运行态 1 项", `${name} ⇒ 项目卡仍走正常档`);
    assert.match(projectsTable(html), /<th>已发布的最新版本号<\/th>/, `${name} ⇒ 列照渲`);
    assert.match(projectsTable(html), /<td>—<\/td>/, `${name} ⇒ 列显 —`);
    assert.equal(barTier(html, LABEL_VERSION), "读不到", `${name} ⇒ 短条走自己的档（原卡表 danger 徽标）`);
    barFacePresent(html, LABEL_VERSION, `${name} B1b`);
  }
  const absent = manageHtml(feed(absentProjection));
  assert.equal(projectCard(absent).includes("project_versions_field_missing"), false, "老引擎根因码不落项目卡");
  assert.match(barFace(absent, LABEL_VERSION), /project_versions_field_missing/, "根因码在页头核对短条（唯一诚实通道）");
});

test("N4-B2（★反向不合流 · 真通路）项目卡不可达 ∧ 投影可读 ⇒ 短条第三源照常「可读」", async () => {
  await withManageServer({ projectsFetcherThrows: true }, async (base) => {
    const res = await fetch(`${base}/org/${ORG}/manage`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(projectCard(html), /不可达（<code>org_query_failed<\/code>）/, "MCP 面失败走项目卡自己的档");
    assert.equal(projectsTable(html), "", "不可达档不补表");
    assert.equal(barTier(html, LABEL_VERSION), "可读", "★HTTP 面不受牵连");
    assert.equal(barFacePresent(html, LABEL_VERSION, "B2").includes("org_query_failed"), false, "项目卡根因不得并进第三源档");
    assert.equal(html.includes(NEVER_CODE), false, "投影读到了 ⇒ 不出「从未读到」根因");
  });
});

test("N4-B3（stale 也是合法组合）列取最后一次投影照常显号、不带提示 ∧ 短条报「本次读不到」", () => {
  const html = manageHtml(feed(liveProjection, "引擎版本台账投影不可读（versions_unreachable · 夹具）"));
  assert.match(projectsTable(html), /<td>v0\.10\.2<\/td>/, "值取最后一次投影 ⇒ 列不空、也不因 stale 退成 —");
  assert.equal(projectsTable(html).includes("versions_unreachable"), false, "列体不带根因");
  assert.equal(projectsTable(html).includes("本次读不到"), false, "列不带 stale 提示（裁定④）");
  const face = barFacePresent(html, LABEL_VERSION, "B3");
  assert.equal(barTier(html, LABEL_VERSION), "本次读不到");
  assert.match(face, /值取最后一次投影/);
  assert.equal(projectCardMeta(html), "运行态 1 项", "stale 不改写项目卡分支（同一合流禁令）");
  assert.equal(html.includes("配置齐备"), false, "两源结论不同源 ⇒ 不谎报齐备");
});

// ===========================================================================
// C. 硬口径 8 · 钉二 —— 8787 整挂时新列「自然不现」由无表产生，不得加第 5 档
// ===========================================================================

test("N4-C1（★8787 整挂）两路同源失败 ⇒ 无表 + 全页零处新列字面 + 各按自己的档如实降级", async () => {
  await withManageServer(
    { projectsFetcherThrows: true, engineVersionsFetcher: engineProjectionAbsentFetcher() },
    async (base) => {
      const res = await fetch(`${base}/org/${ORG}/manage`);
      assert.equal(res.status, 200, "整挂不得炸页");
      const html = await res.text();
      assert.equal(html.includes("已发布的最新版本号"), false, "★新列不现 —— 由「无表」产生（全页零处表头字面），不是列自己判的");
      assert.equal(projectsTable(html), "");
      assert.equal(projectCardMeta(html), "不可达", "走既有早退档，不是新增档");
      assert.match(projectCard(html), /不可达（<code>org_query_failed<\/code>）/);
      assert.match(barFacePresent(html, LABEL_VERSION, "C1"), new RegExp(NEVER_CODE), "短条走既有档1");
      assert.equal(html.includes("配置齐备"), false);
    },
  );
});

test("N4-C1b 整挂只挂 8787：声明面（3300）那一档照常可读 ⇒ 降级按源收口、不陪绑", async () => {
  await withManageServer(
    { projectsFetcherThrows: true, engineVersionsFetcher: engineProjectionAbsentFetcher() },
    async (base) => {
      const html = await (await fetch(`${base}/org/${ORG}/manage`)).text();
      assert.equal(barTier(html, LABEL_GROUPS), "可读", "3300 没挂 ⇒ 第一源不得陪绑降级");
      barFacePresent(html, LABEL_GROUPS, "C1b");
    },
  );
});

test("N4-C2（★无第 5 档 · 源码形状）项目卡出口恰三档，且视图层零触面", () => {
  const body = sourceSlice(VIEWS_TS, "function renderOrgProjectsTable");
  assert.equal(countOf(body, "return cardShell("), 3, "未查询 / 不可达 / 正常 = 闭集三档；加第 4 档（如「整挂」档）即在此红");
  assert.deepEqual(
    [...body.matchAll(/return cardShell\(\r?\n\s*"项目",\r?\n\s*(`[^`]*`|"[^"]*"),/g)].map((m) => m[1]),
    ['"未查询"', '"不可达"', "`运行态 ${String(outcome.projects.length)} 项`"],
    "三档副标字面逐字（复用既有档也在此现形）",
  );
  assert.equal(countOf(body, "projectVersionsOf("), 1, "投影只在一处被消费（共用宿主本次取回的那份）");
  assert.equal(body.includes("engineVersions"), false, "视图层不得触达注入面（本函数零打上游）");
  assert.equal(body.includes("fetch("), false, "视图层零触面");
});

test("N4-C3（★无第 5 档 · 渲出口径）七种入参档的卡头副标恒落三档闭集", () => {
  const tiers = {
    未注入投影: manageHtml(undefined),
    投影null: manageHtml(feed(null)),
    absent: manageHtml(feed(absentProjection)),
    stale: manageHtml(feed(liveProjection, "夹具 stale")),
    未查询: manageHtml(feed(liveProjection), { projectsOutcome: null }),
    不可达: manageHtml(feed(liveProjection), { projectsOutcome: { ok: false, code: "org_query_failed", error: "夹具" } }),
    正常零行: manageHtml(feed(liveProjection), { projectsOutcome: { ok: true, projects: [] } }),
  };
  for (const [name, html] of Object.entries(tiers)) {
    const meta = projectCardMeta(html);
    assert.notEqual(meta, null, `${name} ⇒ 项目卡必须在位（不得整卡消失）`);
    assert.match(meta, /^(?:未查询|不可达|运行态 \d+ 项)$/, `${name} ⇒ 卡头副标落在三档闭集外：${meta}`);
  }
  assert.equal(projectCardMeta(tiers.不可达), "不可达");
  assert.equal(projectCardMeta(tiers.未查询), "未查询");
});
