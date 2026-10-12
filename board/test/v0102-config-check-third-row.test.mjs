/**
 * REQ-2026-10-10-02 · N2「④ 管理页加第三源」—— 第三源的**三态闭集**锚。
 * ★REQ-2026-10-11-05 ⑧b 锚面改判：⑧ 配置核对卡已降级为**页头一条短条**（N9 产出）⇒
 *   本文件的取行对象从卡表 `<tr>` 换成短条内该源的 `<b>` 档位词段 + 其说明 `<li>`；
 *   **判定逻辑与四档语义一条不减**（短条只换包装，原词逐字保留）。
 *
 * 钉住的语义（改造文档 §2.1 落点④ / §2⑧）：
 *  ① 判据序**写死**为「从未读到 → stale → 老引擎 absent → 可读」：
 *     `versionProjectionOf` 读失败时返回的正是**最后一次投影**，所以「从未读到」（投影为 `null`）
 *     与「本次读失败」（`failure` 非空）会**同时成立** ⇒ 颠倒序会渲出**两条根因**；
 *     同理 stale 先于 absent ⇒ stale 档**不叠渲** `project_versions_field_missing`。
 *  ② `empty` = **合法事实**「未登记，本版本起生效」⇒ 与 `live` 同归「可读」，**绝不报读不到**；
 *  ③ **未注入 ⇒ 不参评**：该源整段不出现、也不挡「配置齐备」尾串（`piece5-space-cards` 整页锚的保绿前提）；
 *  ④ **不造「未装配」档**：投影读取器恒在 ⇒ 本源永不显「未装配」，即便声明面 / 运行态两源未装配；
 *  ⑤ 根因码单点：`absent` 两档的文案取自 `server.projectVersionTierOf` +
 *     `projectVersionDegradationText`（**本文件的喂入面与 server 装配同路**，不手抄文案）。
 *
 * **⑧a 包装层锚（本文件承担的新钉）**：短条在场（`核对源健康度：`）∧ 三源逐档 `<b>` 计数 ∧
 *   卡结构不复活（三列表头 `核对源 / 结论 / 说明` 与卡头「配置核对」各一枚**显式负钉**）。
 *
 * 范围外（归它处）：一次渲染**恰一次** `GET /api/versions` 的读数锚与分源锚 = N4
 * （`manage-read-and-origin-anchors`）；项目卡新列 = N3；两源既有行为 = `piece5-space-cards`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderOrgSpaceManagePage } from "../dist/web/views.js";
import { createBoardServer, projectVersionDegradationText, projectVersionTierOf } from "../dist/server.js";
import {
  engineProjectionAbsentFetcher,
  engineProjectionOf,
  engineProjectAbsentField,
  engineProjectEmptyField,
  engineProjectLiveField,
} from "./engine-versions-fixture.mjs";

const OBSERVED_AT = "2026-10-10T00:00:00.000Z";
/** 本次读失败的根因文案（server 侧由 `versionProjectionUnreadableText` 生成，此处同形）。 */
const STALE_FAILURE = "引擎版本台账投影不可读（versions_unreachable · 假投影：引擎版本台账不可达）";

const GROUPS_OK = {
  ok: true,
  warnings: [],
  observedAt: OBSERVED_AT,
  groups: [{ name: "alpha", memberCount: 1, members: [{ machineId: "m1", projectId: "board" }] }],
};
const PROJECTS_OK = {
  ok: true,
  projects: [{ machineId: "m1", projectId: "board", agentKind: "qoder", a2aPort: 1, status: "ok", startedAt: null, machineError: null }],
};

/**
 * 与 `pageOrgSpaceManage` 的装配**同路**构造第三源（`degradationText` 走单点，不手抄）：
 * `projection = null` ⇒ 本进程从未读到过；`failure` ⇒ 本次读失败、值取最后一次投影。
 */
function feed(projection, failure) {
  return { projection, failure, degradationText: projectVersionDegradationText(projectVersionTierOf(projection)) };
}

const liveProjection = engineProjectionOf([], "", engineProjectLiveField([{ org: "alpha", projectId: "board", version: "v0.10.2", status: "released" }])).projection;
const emptyProjection = engineProjectionOf([], "", engineProjectEmptyField()).projection;
/** 老引擎档：Group 面在场 ∧ `projectVersions[]` 缺位。 */
const missingProjection = engineProjectionOf([], "", engineProjectAbsentField()).projection;
/** 形状不合法档：`projectVersions` 在场但非数组。 */
const invalidProjection = engineProjectionOf([], "", engineProjectAbsentField("project_versions_field_invalid", "夹具：projectVersions 不是数组")).projection;

function manageHtml(versionProjection, overrides = {}) {
  const input = { org: "alpha", features: [], groupsOutcome: GROUPS_OK, projectsOutcome: PROJECTS_OK, ...overrides };
  if (versionProjection !== undefined) input.versionProjection = versionProjection;
  return renderOrgSpaceManagePage(input);
}

// ---------------------------------------------------------------------------
// 短条切片 helpers（⑧a：卡表 `<tr>` 退役 ⇒ 取「标签 → `<b>` 档位词」段 + 该源说明 `<li>`）
// 三源标签逐字取自 `views.ts` 短条原词，**不新造文案**；改原词即在此红。
// ---------------------------------------------------------------------------

const LABEL_GROUPS = "声明面成员（3300 <code>GET /api/groups</code>）";
const LABEL_VERSION = "引擎版本台账投影（project 档 · <code>GET /api/versions</code>）";

/** 短条正文（`<p class="hint">核对源健康度：…</p>` 冒号之后）；短条不在场 ⇒ ""。 */
function barText(html) {
  const hit = html.match(/<p class="hint">核对源健康度：([\s\S]*?)<\/p>/);
  return hit === null ? "" : hit[1];
}

/** 短条内某源那一档（从标签起、到其 `<b>` 档位词止）；该源不参评 ⇒ ""。 */
function barSeg(html, label) {
  const bar = barText(html);
  const at = bar.indexOf(label);
  if (at < 0) return "";
  const hit = bar.slice(at).match(/^[\s\S]*?<b>[^<]*<\/b>/);
  return hit === null ? "" : hit[0];
}

/** 短条内某源的档位词（`未装配` / `读不到` / `本次读不到` / `可读` 四值闭集）；不参评 ⇒ ""。 */
function barTier(html, label) {
  const hit = barSeg(html, label).match(/<b>([^<]*)<\/b>/);
  return hit === null ? "" : hit[1];
}

/** 短条在场源数 = 档位词 `<b>` 枚数（旧「卡头两源 / 三源」文案的承载）。 */
function barTierCount(html) {
  return (barText(html).match(/<b>/g) ?? []).length;
}

/** 某源的说明 `<li>`（不可读源才有，可读源不重复啰嗦）；无 ⇒ ""。 */
function barNote(html, label) {
  const at = html.indexOf(`<li>${label}：`);
  if (at < 0) return "";
  const end = html.indexOf("</li>", at);
  return end < 0 ? "" : html.slice(at, end + 5);
}

/**
 * 只看第三源（本源自己的三态不外溢到另两源）—— 取代旧 `versionRow`（卡表行）。
 * = 短条档位段 ∧ 该源说明 `<li>`；未注入 ⇒ ""（不参评）。
 */
function versionBar(html) {
  return barSeg(html, LABEL_VERSION) + barNote(html, LABEL_VERSION);
}

/** 负钉护栏：本组「某串不在场」的断言一律挂在这一段上 ⇒ 段落为空时负钉会退化成恒真，此处先钉住在场。 */
function versionBarPresent(html, label) {
  const seg = versionBar(html);
  assert.notEqual(seg, "", `${label}：第三源短条段须在场（否则本条负钉是恒真锚）`);
  return seg;
}

/** 「配置齐备 · 上次核对时间 …」尾串（旧独立 `<p class="b-note ok">` ⇒ ⑧a 并入短条尾部）。 */
const READY_TAIL = / · 配置齐备 · 上次核对时间 2026-10-10T00:00:00\.000Z$/;

// ---------------------------------------------------------------------------
// 四档各一
// ---------------------------------------------------------------------------

test("④-档1（从未读到）：projection=null ⇒「读不到」+ 根因码 project_versions_group_projection_unreadable", () => {
  const html = manageHtml(feed(null, STALE_FAILURE));
  assert.match(html, /核对源健康度：/, "⑧a 页头短条在场（卡退役后本页唯一的三源健康度承载）");
  assert.equal(barTierCount(html), 3, "注入后短条三源逐档在场（原卡头「本页三源的读取健康度」的承载）");
  const row = versionBarPresent(html, "档1");
  assert.equal(barTier(html, LABEL_VERSION), "读不到");
  assert.match(row, /project_versions_group_projection_unreadable/, "根因码经降级文案单点带出");
  assert.equal(html.includes("配置齐备"), false, "读不到 ⇒ 不得谎报齐备");
});

test("④-档2（stale：本次读失败、值取最后一次投影）⇒「本次读不到 · 值取最后一次投影」+ failure 根因", () => {
  const html = manageHtml(feed(liveProjection, STALE_FAILURE));
  const row = versionBarPresent(html, "档2");
  assert.equal(barTier(html, LABEL_VERSION), "本次读不到");
  assert.match(row, /值取最后一次投影/, "如实标出「值」来自最后一次投影，不当成实时");
  assert.match(row, /versions_unreachable/, "根因 = engineVersionsFailure 原文");
  assert.equal(row.includes("project_versions_group_projection_unreadable"), false, "投影在场 ⇒ 不是「从未读到」档");
  assert.equal(html.includes("配置齐备"), false, "stale 不得谎报齐备");
});

test("④-档3（老引擎 absent）⇒「读不到」+ project_versions_field_missing / _invalid", () => {
  const missing = versionBarPresent(manageHtml(feed(missingProjection, null)), "档3-missing");
  assert.equal(barTier(manageHtml(feed(missingProjection, null)), LABEL_VERSION), "读不到");
  assert.match(missing, /project_versions_field_missing/);
  const invalidHtml = manageHtml(feed(invalidProjection, null));
  const invalid = versionBarPresent(invalidHtml, "档3-invalid");
  assert.match(invalid, /project_versions_field_invalid/, "两类根因分档不混一");
  assert.equal(invalid.includes("project_versions_field_missing"), false, "invalid 档只带自己的根因码（不叠渲 missing）");
  assert.equal(manageHtml(feed(missingProjection, null)).includes("配置齐备"), false);
});

test("④-档4（live / empty）⇒「可读」；empty 是合法事实，**不得报读不到**", () => {
  const liveHtml = manageHtml(feed(liveProjection, null));
  const live = versionBarPresent(liveHtml, "档4-live");
  assert.equal(barTier(liveHtml, LABEL_VERSION), "可读");
  assert.equal(live.includes("读不到"), false, "可读档不得含任何降级档词");
  assert.match(barText(liveHtml), READY_TAIL, "三源齐备 ⇒ 尾串「配置齐备 · 上次核对时间」（⑧a 随卡包装并入短条，判据不变）");

  const emptyHtml = manageHtml(feed(emptyProjection, null));
  const empty = versionBarPresent(emptyHtml, "档4-empty");
  assert.equal(barTier(emptyHtml, LABEL_VERSION), "可读");
  assert.equal(empty.includes("读不到"), false, "empty = 「未登记，本版本起生效」的合法事实，不是降级");
  assert.equal(empty.includes("project_versions_"), false, "empty 档不得带出任何根因码");
});

// ---------------------------------------------------------------------------
// 判据序 / 不参评 / 不造未装配档
// ---------------------------------------------------------------------------

test("④-判据序（★不可颠倒）：null 投影 ∧ failure 非空 ⇒ 只出「从未读到」一条根因，不渲 stale", () => {
  const row = versionBarPresent(manageHtml(feed(null, STALE_FAILURE)), "判据序①");
  assert.match(row, /project_versions_group_projection_unreadable/);
  assert.equal(row.includes("本次读不到"), false, "② 先判 ⇒ 两条根因");
  assert.equal(row.includes("值取最后一次投影"), false, "从未读到时**没有**最后一次投影可取，不得谎称");
});

test("④-判据序（stale 先于 absent）：投影在场 ∧ failure 非空 ∧ project 档 absent ⇒ 只出 stale 一条根因", () => {
  const html = manageHtml(feed(missingProjection, STALE_FAILURE));
  const row = versionBarPresent(html, "判据序②");
  assert.equal(barTier(html, LABEL_VERSION), "本次读不到");
  assert.equal(row.includes("project_versions_field_missing"), false, "③ 先判 ⇒ 两条根因");
});

test("④-未注入不参评：无第三源段 · 短条仍两档 · 「配置齐备」尾串锚零改动", () => {
  const html = manageHtml(undefined);
  assert.equal(versionBar(html), "", "未注入 ⇒ 第三源整段不出现（短条里无该标签、也无其说明 li）");
  assert.equal(barTierCount(html), 2, "未注入 ⇒ 短条只有两源逐档（原卡头「本页两源的读取健康度」的承载）");
  assert.match(barText(html), READY_TAIL, "piece5:110 同形锚：缺席即不参评");
  assert.equal(html.includes("引擎版本台账投影"), false, "不出现也不带任何投影文案");
});

test("④-不造「未装配」档：声明面 / 运行态两源未装配 ⇒ 第三源照常按自己的档给结论", () => {
  const html = manageHtml(feed(liveProjection, null), { groupsOutcome: null, projectsOutcome: null });
  const row = versionBarPresent(html, "不造未装配");
  assert.equal(barTier(html, LABEL_VERSION), "可读");
  assert.equal(row.includes("未装配"), false, "投影读取器恒在 ⇒ null 分支对本源不可达");
  assert.equal(barTier(html, LABEL_GROUPS), "未装配", "对照：另两源照常显自己的「未装配」档（本源特例不外溢）");
  assert.match(html, /部分源未查询/, "两源未装配时短条尾部仍如实标「部分源未查询」（原词保留，既有行为不劣化）");
});

test("④-诚实通道唯一在短条：投影读不到不改写项目卡「不可达」档（两条通路不合流）", () => {
  const html = manageHtml(feed(null, STALE_FAILURE), { projectsOutcome: { ok: true, projects: PROJECTS_OK.projects } });
  assert.match(versionBarPresent(html, "诚实通道"), /project_versions_group_projection_unreadable/, "短条如实报第三源读不到");
  assert.match(html, /运行态 \d+ 项/, "项目卡仍按运行态正常渲染（有行、列全 — 是合法组合）");
  assert.equal(html.includes("不可达（versions_unreachable"), false, "投影根因不得漏进项目卡的 !outcome.ok 分支");
});

// ---------------------------------------------------------------------------
// ⑧a 包装层：卡结构不复活（显式负钉）—— 原「表头 / cardShell 卡痕」类断言的改判落点
// ---------------------------------------------------------------------------

test("⑧a-短条承载 + 核对卡不复活（⑦/⑧ 卡面降级的新增锚与显式负钉）", () => {
  const html = manageHtml(feed(null, STALE_FAILURE));
  assert.match(html, /核对源健康度：/, "⑧a 页头短条在场");
  assert.doesNotMatch(
    html,
    /<table><thead><tr><th>核对源<\/th><th>结论<\/th><th>说明<\/th><\/tr>/,
    "⑧ 核对卡的三列表头随卡整体退役 ⇒ 短条无表结构（该针在原卡形态下为正向锚，此处抬成显式负钉）",
  );
  assert.doesNotMatch(html, /<p class="b-card-h">配置核对/, "卡头「配置核对」不得复活（页头短条不是 b-card）");
  assert.doesNotMatch(html, /本页[两三]源的读取健康度/, "卡头副标文案随卡退役 ⇒ 源数改由短条内 `<b>` 计数承载");
});

/** 归一层可见的本组需求一枚（空间路由按 `ownerGroup` 认组织；形状对齐 `org-pool-two-column` 夹具）。 */
const ALPHA_FEATURE = {
  featureId: "F1",
  state: "executing",
  title: "需求 F1",
  taskCount: 1,
  ownerGroup: "alpha",
  stage: "改造方案",
  version: "v0.10.2",
  approval: "已通过",
  createdAt: "c",
  updatedAt: "u",
  stateCounts: null,
};

test("④-server 装配：管理页取到投影读取面 ⇒ 第三源落短条（不可达档如实降级、不炸页）", async () => {
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        return { features: [ALPHA_FEATURE], stateCounts: null };
      },
    },
    orgProjectsFetcher: async () => ({ ok: true, projects: [] }),
    orgGroupsFetcher: null,
    engineVersionsFetcher: engineProjectionAbsentFetcher(),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/org/alpha/manage`);
    assert.equal(res.status, 200, "投影读不到不得炸页");
    const html = await res.text();
    assert.match(html, /核对源健康度：/, "⑧a 真通路短条在场（非直调夹具）");
    assert.equal(barTier(html, LABEL_VERSION), "读不到", "本进程从未读到过 ⇒ 档1");
    assert.match(versionBarPresent(html, "server 装配"), /project_versions_group_projection_unreadable/);
    assert.equal(html.includes("配置齐备"), false, "第三源参评且读不到 ⇒ 不谎报齐备");
  } finally {
    await handle.close();
  }
});
