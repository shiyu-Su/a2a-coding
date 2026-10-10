/**
 * REQ-2026-10-10-02 · N7「② 归属卡渲染」—— `renderFeatureOwnershipCard` 的三态与卡位锚。
 *
 * 钉住的语义（改造文档 §2.1 落点② · §2.2 硬口径 5）：
 *  ① **三态闭集**：`null` / `undefined` ⇒ **整卡不渲**（C2 空区块短路，连卡头也不出）；
 *     `[]` ⇒ **零行 + 中性文案**（「未归属」是合法事实）；有行 ⇒ **逐行、行数 == `projects.length`**。
 *     「缺面 ≠ 空面」由 N6 的解析层承载，本文件只钉渲染层两档的可区分性。
 *  ② **行序 = 引擎原序**：刻意**不排序** —— 排序会把归属集伪装成版本列车序，而引擎侧无序承诺。
 *  ③ **卡位**：侧栏装配串里落在 `feat-meta` **之后**、`feat-outputs` **之前**。
 *  ④ **两个数据源、两个切片**：卡体只消费 `projects[]` 的 `projectId` / `version` 两键，
 *     **不去 `projectVersions[]` join 状态** ⇒ 卡内零状态字样、零 `status` 键名。
 *  ⑤ `null` 档**真机不可触**（引擎恒发该键）⇒ 以合成信封代测（§4.2 判据 9）。
 *
 * 范围外（归它处）：`projects[]` 的解析三态 = N6（`bridge-client.test.mjs` /
 * `v0102-parse-feature-projects`）；排期页 `.pv-block` 摘除 = N5；管理页新列 = N3。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderFeatureDetail, renderFeatureOwnershipCard } from "../dist/web/views.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");

/** 最小 detail 信封（形状照 `bd11-docs-face` 的直调先例；`projects` 由用例显式给定）。 */
function detail(projects) {
  return {
    feature: {
      featureId: "F1",
      state: "executing",
      title: "t",
      plan: null,
      ownerGroup: "g1",
      stage: "改造方案",
      version: "v0.10.2",
      approval: "已通过",
      parentFeatureId: null,
      requirement: null,
      decisions: null,
      contracts: null,
      createdAt: null,
      updatedAt: null,
    },
    tasks: [],
    acceptance: null,
    projects,
  };
}

function renderDetail(projects) {
  return renderFeatureDetail(detail(projects), null, null, NOW);
}

/** 卡体内的 `b-meta-row` 行数（一行 = 一条归属）。 */
function metaRows(html) {
  return html.match(/<div class="b-meta-row">/g) ?? [];
}

test("三态之 null：整卡不渲（连卡头也不出，C2 空区块短路）", () => {
  assert.equal(renderFeatureOwnershipCard(null), "");
  const html = renderDetail(null);
  assert.doesNotMatch(html, /feat-ownership/, "null 档不得留空卡壳");
  assert.doesNotMatch(html, /归属（project 版本）/, "null 档不得只吞内容、留下孤零零的卡头");
  assert.doesNotMatch(html, /暂无 project 归属记录/, "缺面 ≠ 空面：null 不得走 `[]` 档的中性文案");
});

test("三态之 undefined：手搭 detail 无 `projects` 键 ⇒ 同样整卡不渲（既有直调测试零改绿的保绿前提）", () => {
  assert.equal(renderFeatureOwnershipCard(undefined), "");
  const legacy = detail(undefined);
  delete legacy.projects;
  const html = renderFeatureDetail(legacy, null, null, NOW);
  assert.doesNotMatch(html, /feat-ownership/);
  assert.match(html, /需求信息/, "既有侧栏卡不受影响");
});

test("三态之 []：零行 + 中性文案，不是降级样式", () => {
  const html = renderFeatureOwnershipCard([]);
  assert.equal(metaRows(html).length, 0);
  assert.match(html, /（暂无 project 归属记录）/);
  assert.doesNotMatch(html, /class="[^"]*err/, "中性文案不得渲成降级 / 错误样式");
  assert.doesNotMatch(html, /读不到|降级|缺失|不可达/, "空面是合法事实，不报读不到");
});

test("有行：逐行、行数 == projects.length，两列 = projectId（左）/ version（右）", () => {
  const rows = [
    { projectId: "board", version: "v0.10.2" },
    { projectId: "orch", version: "v0.9.1" },
    { projectId: "flow", version: "v0.10.2" },
  ];
  const html = renderFeatureOwnershipCard(rows);
  assert.equal(metaRows(html).length, rows.length);
  assert.match(html, /<dt>board<\/dt><dd>v0\.10\.2<\/dd>/);
  assert.match(html, /<dt>orch<\/dt><dd>v0\.9\.1<\/dd>/);
  assert.match(html, /<dt>flow<\/dt><dd>v0\.10\.2<\/dd>/);
});

test("行序 = 引擎返回原序：刻意不排序（逆序 / 乱号输入照原序逐行出）", () => {
  const rows = [
    { projectId: "zzz", version: "v9.9.9" },
    { projectId: "aaa", version: "v0.0.1" },
    { projectId: "mmm", version: "v5.0.0" },
  ];
  const html = renderFeatureOwnershipCard(rows);
  const dts = [...html.matchAll(/<dt>([^<]*)<\/dt>/g)].map((m) => m[1]);
  assert.deepEqual(dts, ["zzz", "aaa", "mmm"]);
  const dds = [...html.matchAll(/<dd>([^<]*)<\/dd>/g)].map((m) => m[1]);
  assert.deepEqual(dds, ["v9.9.9", "v0.0.1", "v5.0.0"]);
});

test("卡位：侧栏装配串里归属卡在 feat-meta 之后、feat-outputs 之前", () => {
  const html = renderDetail([{ projectId: "board", version: "v0.10.2" }]);
  const meta = html.indexOf("feat-meta");
  const ownership = html.indexOf("feat-ownership");
  const outputs = html.indexOf("feat-outputs");
  assert.ok(meta > -1 && ownership > -1 && outputs > -1, "三张卡都要在场");
  assert.ok(meta < ownership, "归属卡必须晚于需求信息卡");
  assert.ok(ownership < outputs, "归属卡必须早于产出登记卡");
});

test("两个数据源：卡体零状态字样，不去 projectVersions[] join（§2.2 硬口径 5）", () => {
  const html = renderFeatureOwnershipCard([{ projectId: "board", version: "v0.10.2" }]);
  assert.doesNotMatch(html, /status|released|open/, "不得把版本台账的状态列搬进归属卡");
  assert.doesNotMatch(html, /projectVersions/, "归属卡的数据源只有 projects[]");
  assert.doesNotMatch(html, /<table/, "侧栏 320px + 浮层内不用 table（会挤破）");
});

test("不切 org：ownerGroup ≠ 页面 org 时合法行不清零（单需求维度直出）", () => {
  const rows = [
    { projectId: "board", version: "v0.10.2" },
    { projectId: "machine", version: "v0.9.8" },
  ];
  const html = renderFeatureOwnershipCard(rows);
  assert.equal(metaRows(html).length, 2);
});

test("转义：projectId / version 原文里的尖括号不得逃成标签", () => {
  const html = renderFeatureOwnershipCard([{ projectId: "<img src=x onerror=alert(1)>", version: 'v"1' }]);
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
