/**
 * REQ-2026-10-10-02 · N2「④ 管理页配置核对卡加第三行」—— 第三行的**三态闭集**锚。
 *
 * 钉住的语义（改造文档 §2.1 落点④）：
 *  ① 判据序**写死**为「从未读到 → stale → 老引擎 absent → 可读」：
 *     `versionProjectionOf` 读失败时返回的正是**最后一次投影**，所以「从未读到」（投影为 `null`）
 *     与「本次读失败」（`failure` 非空）会**同时成立** ⇒ 颠倒序会渲出**两条根因**；
 *     同理 stale 先于 absent ⇒ stale 档**不叠渲** `project_versions_field_missing`。
 *  ② `empty` = **合法事实**「未登记，本版本起生效」⇒ 与 `live` 同归「可读」，**绝不报读不到**；
 *  ③ **未注入 ⇒ 不参评**：第三行不出现、也不挡「配置齐备」闸（`piece5-space-cards` 整页锚的保绿前提）；
 *  ④ **不造「未装配」档**：投影读取器恒在 ⇒ 本源永不显「未装配」，即便声明面 / 运行态两源未装配；
 *  ⑤ 根因码单点：`absent` 两档的文案取自 `server.projectVersionTierOf` +
 *     `projectVersionDegradationText`（**本文件的喂入面与 server 装配同路**，不手抄文案）。
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

/** 只看第三行（本源自己的三态不外溢到另两行）。 */
function versionRow(html) {
  const hit = html.match(/<tr[^>]*><td>引擎版本台账投影[\s\S]*?<\/tr>/);
  return hit === null ? "" : hit[0];
}

// ---------------------------------------------------------------------------
// 四档各一
// ---------------------------------------------------------------------------

test("④-档1（从未读到）：projection=null ⇒「读不到」+ 根因码 project_versions_group_projection_unreadable", () => {
  const html = manageHtml(feed(null, STALE_FAILURE));
  assert.match(html, /本页三源的读取健康度/, "注入后卡头「两源」→「三源」");
  const row = versionRow(html);
  assert.match(row, /<span class="b-badge danger">读不到<\/span>/);
  assert.match(row, /project_versions_group_projection_unreadable/, "根因码经降级文案单点带出");
  assert.equal(html.includes("配置齐备"), false, "读不到 ⇒ 不得谎报齐备");
});

test("④-档2（stale：本次读失败、值取最后一次投影）⇒「本次读不到 · 值取最后一次投影」+ failure 根因", () => {
  const html = manageHtml(feed(liveProjection, STALE_FAILURE));
  const row = versionRow(html);
  assert.match(row, /<span class="b-badge danger">本次读不到<\/span>/);
  assert.match(row, /值取最后一次投影/, "如实标出「值」来自最后一次投影，不当成实时");
  assert.match(row, /versions_unreachable/, "根因 = engineVersionsFailure 原文");
  assert.equal(row.includes("project_versions_group_projection_unreadable"), false, "投影在场 ⇒ 不是「从未读到」档");
  assert.equal(html.includes("配置齐备"), false, "stale 不得谎报齐备");
});

test("④-档3（老引擎 absent）⇒「读不到」+ project_versions_field_missing / _invalid", () => {
  const missing = versionRow(manageHtml(feed(missingProjection, null)));
  assert.match(missing, /<span class="b-badge danger">读不到<\/span>/);
  assert.match(missing, /project_versions_field_missing/);
  const invalid = versionRow(manageHtml(feed(invalidProjection, null)));
  assert.match(invalid, /project_versions_field_invalid/, "两类根因分档不混一");
  assert.equal(invalid.includes("project_versions_field_missing"), false);
  assert.equal(manageHtml(feed(missingProjection, null)).includes("配置齐备"), false);
});

test("④-档4（live / empty）⇒「可读」；empty 是合法事实，**不得报读不到**", () => {
  const live = versionRow(manageHtml(feed(liveProjection, null)));
  assert.match(live, /<span class="b-badge ok">可读<\/span>/);
  assert.equal(live.includes("读不到"), false);
  assert.match(manageHtml(feed(liveProjection, null)), /<p class="b-note ok">配置齐备 · 上次核对时间 2026-10-10T00:00:00\.000Z<\/p>/);

  const empty = versionRow(manageHtml(feed(emptyProjection, null)));
  assert.match(empty, /<span class="b-badge ok">可读<\/span>/);
  assert.equal(empty.includes("读不到"), false, "empty = 「未登记，本版本起生效」的合法事实，不是降级");
  assert.equal(empty.includes("project_versions_"), false, "empty 档不得带出任何根因码");
});

// ---------------------------------------------------------------------------
// 判据序 / 不参评 / 不造未装配档
// ---------------------------------------------------------------------------

test("④-判据序（★不可颠倒）：null 投影 ∧ failure 非空 ⇒ 只出「从未读到」一条根因，不渲 stale", () => {
  const row = versionRow(manageHtml(feed(null, STALE_FAILURE)));
  assert.match(row, /project_versions_group_projection_unreadable/);
  assert.equal(row.includes("本次读不到"), false, "② 先判 ⇒ 两条根因");
  assert.equal(row.includes("值取最后一次投影"), false, "从未读到时**没有**最后一次投影可取，不得谎称");
});

test("④-判据序（stale 先于 absent）：投影在场 ∧ failure 非空 ∧ project 档 absent ⇒ 只出 stale 一条根因", () => {
  const row = versionRow(manageHtml(feed(missingProjection, STALE_FAILURE)));
  assert.match(row, /本次读不到/);
  assert.equal(row.includes("project_versions_field_missing"), false, "③ 先判 ⇒ 两条根因");
});

test("④-未注入不参评：无第三行 · 卡头仍「两源」 · 「配置齐备」整行锚零改动", () => {
  const html = manageHtml(undefined);
  assert.equal(versionRow(html), "", "未注入 ⇒ 第三行整行不出现");
  assert.match(html, /本页两源的读取健康度/);
  assert.match(html, /<p class="b-note ok">配置齐备 · 上次核对时间 2026-10-10T00:00:00\.000Z<\/p>/, "piece5:107 同形锚：缺席即不参评");
  assert.equal(html.includes("引擎版本台账投影"), false, "不出现也不带任何投影文案");
});

test("④-不造「未装配」档：声明面 / 运行态两源未装配 ⇒ 第三行照常按自己的档给结论", () => {
  const html = manageHtml(feed(liveProjection, null), { groupsOutcome: null, projectsOutcome: null });
  const row = versionRow(html);
  assert.match(row, /<span class="b-badge ok">可读<\/span>/);
  assert.equal(row.includes("未装配"), false, "投影读取器恒在 ⇒ null 分支对本源不可达");
  assert.match(html, /部分源未查询/, "两源未装配时卡头仍如实标「部分源未查询」（既有行为不劣化）");
});

test("④-诚实通道唯一在本卡：投影读不到不改写项目卡「不可达」档（两条通路不合流）", () => {
  const html = manageHtml(feed(null, STALE_FAILURE), { projectsOutcome: { ok: true, projects: PROJECTS_OK.projects } });
  assert.match(versionRow(html), /project_versions_group_projection_unreadable/, "核对卡报读不到");
  assert.match(html, /运行态 \d+ 项/, "项目卡仍按运行态正常渲染（有行、列全 — 是合法组合）");
  assert.equal(html.includes("不可达（versions_unreachable"), false, "投影根因不得漏进项目卡的 !outcome.ok 分支");
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

test("④-server 装配：管理页取到投影读取面 ⇒ 第三行落页面（不可达档如实降级、不炸页）", async () => {
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
    const row = versionRow(html);
    assert.match(row, /<span class="b-badge danger">读不到<\/span>/, "本进程从未读到过 ⇒ 档1");
    assert.match(row, /project_versions_group_projection_unreadable/);
    assert.equal(html.includes("配置齐备"), false, "第三源参评且读不到 ⇒ 不谎报齐备");
  } finally {
    await handle.close();
  }
});
