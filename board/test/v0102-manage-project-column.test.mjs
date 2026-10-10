/**
 * REQ-2026-10-10-02 · N3「① 管理页项目卡加一列『已发布的最新版本号』」—— 取值三子判据 + 列形锚。
 *
 * 钉住的语义（改造文档 §2.1 落点① / §2.2 硬口径 1、2）：
 *  - **子判据 a**：`status = open` 的行**不进该列**（列只答「最近已发布」）；
 *  - **子判据 b**：同 project 多个 `released` ⇒ 取 {@link compareVersionOrder} **最大**，
 *    **不是登记序、不是字面序**（`v0.10.0` 大于 `v0.9.8`，字典序会取错）；
 *  - **子判据 c**：`entry.org !== org` **不得染色**（org 切片 + projectId trim 后精确联键）；
 *  - **显示事实**：一行 = 一 `(machineId, projectId)` ⇒ 同 project 多机时同版号在**多行重复出现**，
 *    **不按 `projectId` 去重**；
 *  - **缺席档同形**：无已发布 / 投影为 `null` / project 档 `absent`·`empty` / 未注入 ⇒ 一律 `—`，
 *    列体**禁词**「未发布 / 缺失 / 降级 / open」、**不加 `title`**（诚实通道唯一在配置核对卡 = N2 的④）；
 *  - **形制**：表头**恰 8 列**（插在 `projectId` 之后）+ 正常分支空态 `emptyRow(8, …)`；
 *    两个**早退分支**（未查询 / 不可达）不补表。
 *
 * 范围外（归它处）：一次渲染**恰一次** `GET /api/versions` 的读数锚 = N4
 * （`manage-read-and-origin-anchors`）；核对卡第三行三档 = N2（`v0102-config-check-third-row`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderOrgSpaceManagePage } from "../dist/web/views.js";
import {
  engineProjectionOf,
  engineProjectAbsentField,
  engineProjectEmptyField,
  engineProjectLiveField,
} from "./engine-versions-fixture.mjs";

const OBSERVED_AT = "2026-10-10T00:00:00.000Z";
const ORG = "alpha";

const GROUPS_OK = {
  ok: true,
  warnings: [],
  observedAt: OBSERVED_AT,
  groups: [{ name: ORG, memberCount: 1, members: [{ machineId: "m1", projectId: "board" }] }],
};

/** 一机一项目（默认）。 */
function projectsOutcome(rows) {
  return {
    ok: true,
    projects: rows.map((r) => ({
      machineId: r.machineId,
      projectId: r.projectId,
      agentKind: "qoder",
      a2aPort: 1,
      status: "ok",
      startedAt: null,
      machineError: null,
    })),
  };
}

const ONE_ROW = projectsOutcome([{ machineId: "m1", projectId: "board" }]);

/** 与 `pageOrgSpaceManage` 的装配同路：投影本体 + failure=null（本文件不测诚实通道）+ 无降级文案。 */
function feed(projectField) {
  return {
    projection: engineProjectionOf([], "", projectField).projection,
    failure: null,
    degradationText: null,
  };
}

function manageHtml(versionProjection, overrides = {}) {
  const input = { org: ORG, features: [], groupsOutcome: GROUPS_OK, projectsOutcome: ONE_ROW, ...overrides };
  if (versionProjection !== undefined) input.versionProjection = versionProjection;
  return renderOrgSpaceManagePage(input);
}

/** 新列所在的那张表（按新表头三段定位，避免命中别处的 machineId 表）。 */
function projectsTable(html) {
  const hit = html.match(
    /<table><thead><tr><th>machineId<\/th><th>projectId<\/th><th>已发布的最新版本号<\/th>[\s\S]*?<\/table>/,
  );
  return hit === null ? "" : hit[0];
}

function headerCells(html) {
  return [...projectsTable(html).matchAll(/<th>([\s\S]*?)<\/th>/g)].map((m) => m[1]);
}

/** 逐数据行的「已发布的最新版本号」单元格内容（第 3 列）。 */
function releasedCells(html) {
  const body = projectsTable(html).split("<tbody>")[1] ?? "";
  return [...body.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map((row) => {
    const tds = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) => t[1]);
    return tds[2];
  });
}

// ---------------------------------------------------------------------------
// 形制：8 列 + 空态 8 + 早退分支不补表
// ---------------------------------------------------------------------------

test("①-形制：表头恰 8 列，新列紧跟 projectId 之后", () => {
  const cells = headerCells(manageHtml(feed(engineProjectLiveField([{ org: ORG, projectId: "board", version: "v0.10.0", status: "released" }]))));
  assert.deepEqual(cells, [
    "machineId",
    "projectId",
    "已发布的最新版本号",
    "agentKind",
    "a2aPort",
    "status",
    "startedAt",
    "机器 error",
  ]);
});

test("①-形制：正常分支空态 = 8 列（源码含 emptyRow(8, 字面）", () => {
  const html = manageHtml(feed(engineProjectEmptyField()), { projectsOutcome: projectsOutcome([]) });
  assert.match(projectsTable(html), /<td colspan="8" class="empty">（该组织快照中无项目）<\/td>/);
  const source = readFileSync(fileURLToPath(new URL("../src/web/views.ts", import.meta.url)), "utf8");
  const fn = source.slice(
    source.indexOf("function renderOrgProjectsTable"),
    source.indexOf("function renderOrgProjectsTable") + 4000,
  );
  assert.match(fn, /emptyRow\(8, "（该组织快照中无项目）"\)/, "空态列数锚只落在项目卡函数内");
});

test("①-形制：两个早退分支（未查询 / 不可达）不补表 ⇒ 不为凑列数出现空表", () => {
  const never = manageHtml(feed(engineProjectLiveField([{ org: ORG, projectId: "board", version: "v0.10.0", status: "released" }])), { projectsOutcome: null });
  const unreachable = manageHtml(feed(engineProjectLiveField([])), {
    projectsOutcome: { ok: false, code: "org_query_failed", error: "夹具：运行态不可达" },
  });
  for (const html of [never, unreachable]) {
    assert.equal(projectsTable(html), "", "早退档不得出现带新列的表");
    assert.equal(html.includes("已发布的最新版本号"), false, "早退档不补表头");
  }
  assert.match(never, /未查询/);
  assert.match(unreachable, /不可达（<code>org_query_failed<\/code>）/);
});

// ---------------------------------------------------------------------------
// 取值三子判据
// ---------------------------------------------------------------------------

test("①-子判据 a：status=open 的行不进该列 ⇒ 显 —，且列体无 open 字样", () => {
  const html = manageHtml(feed(engineProjectLiveField([{ org: ORG, projectId: "board", version: "v0.10.2", status: "open" }])));
  assert.deepEqual(releasedCells(html), ["—"]);
  assert.equal(projectsTable(html).includes("open"), false);
});

test("①-子判据 b：同 project 多个 released 取 semver 最大（非登记序、非字面序）", () => {
  // 登记序把 v0.9.8 放在最后、字面序也让 v0.9.8 > v0.10.0 ⇒ 两种错法都会取到 v0.9.8
  const html = manageHtml(
    feed(
      engineProjectLiveField([
        { org: ORG, projectId: "board", version: "v0.10.0", status: "released" },
        { org: ORG, projectId: "board", version: "v0.1.0", status: "released" },
        { org: ORG, projectId: "board", version: "v0.9.8", status: "released" },
      ]),
    ),
  );
  assert.deepEqual(releasedCells(html), ["v0.10.0"]);
});

test("①-子判据 b：open 混在多 released 中不参与取最大", () => {
  const html = manageHtml(
    feed(
      engineProjectLiveField([
        { org: ORG, projectId: "board", version: "v9.9.9", status: "open" },
        { org: ORG, projectId: "board", version: "v0.10.0", status: "released" },
      ]),
    ),
  );
  assert.deepEqual(releasedCells(html), ["v0.10.0"]);
});

test("①-子判据 c：他 org 的同 projectId 同版号不得染色", () => {
  const html = manageHtml(
    feed(
      engineProjectLiveField([
        { org: "beta", projectId: "board", version: "v9.9.9", status: "released" },
        { org: ORG, projectId: "board", version: "v0.10.0", status: "released" },
      ]),
    ),
  );
  assert.deepEqual(releasedCells(html), ["v0.10.0"], "只取本 org 的行");

  const foreignOnly = manageHtml(
    feed(engineProjectLiveField([{ org: "beta", projectId: "board", version: "v9.9.9", status: "released" }])),
  );
  assert.deepEqual(releasedCells(foreignOnly), ["—"], "本 org 无行 ⇒ 不因他 org 有行而显号");
});

test("①-子判据 c：联键 = projectId trim 后精确相等（引擎侧带空白仍认得上）", () => {
  const html = manageHtml(
    feed(engineProjectLiveField([{ org: ORG, projectId: "board ", version: " v0.10.0 ", status: "released" }])),
  );
  assert.deepEqual(releasedCells(html), ["v0.10.0"]);
});

// ---------------------------------------------------------------------------
// 显示事实：多机重复出现、不去重
// ---------------------------------------------------------------------------

test("①-不去重：同 projectId 双机两行 ⇒ 同版号在两行重复出现", () => {
  const html = manageHtml(
    feed(engineProjectLiveField([{ org: ORG, projectId: "board", version: "v0.10.0", status: "released" }])),
    { projectsOutcome: projectsOutcome([{ machineId: "m1", projectId: "board" }, { machineId: "m2", projectId: "board" }]) },
  );
  assert.deepEqual(releasedCells(html), ["v0.10.0", "v0.10.0"]);
  assert.equal(projectsTable(html).includes("colspan"), false, "有行 ⇒ 不落空态行");
});

// ---------------------------------------------------------------------------
// 缺席档：与「读不到」同显 —，列体不带任何降级语义
// ---------------------------------------------------------------------------

test("①-无已发布 ⇒ —（open 独占 / 空档 / 缺位档 / 投影 null / 未注入，五档同形）", () => {
  const cases = {
    openOnly: feed(engineProjectLiveField([{ org: ORG, projectId: "board", version: "v0.10.0", status: "open" }])),
    emptyField: feed(engineProjectEmptyField()),
    absentField: feed(engineProjectAbsentField()),
    projectionNull: { projection: null, failure: null, degradationText: null },
    notInjected: undefined,
  };
  for (const [name, vp] of Object.entries(cases)) {
    const html = manageHtml(vp);
    assert.deepEqual(releasedCells(html), ["—"], `${name} ⇒ 列在、值为 —`);
  }
});

test("①-禁词与无提示：列体不得出现「未发布 / 缺失 / 降级 / open」，也不加 title", () => {
  for (const vp of [
    feed(engineProjectAbsentField()),
    feed(engineProjectEmptyField()),
    feed(engineProjectLiveField([{ org: ORG, projectId: "board", version: "v0.10.0", status: "open" }])),
    { projection: null, failure: "夹具：本次读不到", degradationText: "夹具降级文案" },
    undefined,
  ]) {
    const table = projectsTable(manageHtml(vp));
    for (const banned of ["未发布", "缺失", "降级", "open", "读不到"]) {
      assert.equal(table.includes(banned), false, `列体禁词「${banned}」`);
    }
    assert.equal(/<th[^>]*title=/.test(table), false, "表头不加 title");
    assert.equal(/<td[^>]*title=/.test(table), false, "单元格不加 title");
    assert.equal(table.includes("夹具：本次读不到"), false, "stale 根因不得漏进列体（诚实通道唯一在核对卡）");
  }
});

test("①-列只认 released：status 为 null（缺键档）的行不进列", () => {
  const html = manageHtml(feed(engineProjectLiveField([{ org: ORG, projectId: "board", version: "v0.10.0" }])));
  assert.deepEqual(releasedCells(html), ["—"]);
});
