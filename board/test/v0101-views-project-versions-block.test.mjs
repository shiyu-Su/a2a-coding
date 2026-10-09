/**
 * REQ-2026-10-09-01 · v0.10.1 · board **B3** —— project 级版本区块的**三档显示闭集**渲染。
 *
 * 判据（改造文档 §2 C-7 / C-18② / §3 board 段 / §4 T3）：
 * 1. **三档各自可核**：投影在场有行 ⇒ 逐行 `{projectId, version, status, releasable}`；
 *    在场无行 ⇒ 「未登记（本版本起生效）」；读不到 ⇒ 降级条 + **根因码**；
 * 2. **org 切片**：A 组织的投影不喂 B 组织（两组织同版号互不可见、互不锁）；
 * 3. `releasable` **缺键 ⇒ `—`**，**不得**渲染成否定档（未知 ≠ 假否定）；
 * 4. 新区块的样式类**不等于** `.draglocked` / `kbadge draglock`（排期拖拽闸的显示语言不得复用）；
 * 5. 无行 ⇒ 输出**不得**出现 `notstart` 字样（绝不合成假行）；
 * 6. project 级 `released` **只显样式、不参与任何判定**（无锁语义外溢）。
 *
 * 数据面（解析 / 两档分立 / 降级文案单点）归 B1 / B2，本文件只钉**显示**；
 * 三档入参一律经 `parseEngineVersions` 真链路构造，不手拼字段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEngineVersions } from "../dist/bridge-client.js";
import { renderProjectVersionsBlock } from "../dist/web/views.js";
import { renderPage } from "../dist/web/layout.js";
import { projectVersionDegradationText, projectVersionTierOf } from "../dist/server.js";

const ORG_A = "a2a-coding";
const ORG_B = "shop-image";

/** 由**原始 JSON** 走真链路取 project 档（缺字段 / 假形状都用这条路构造，不臆造中间态）。 */
function fieldOf(json) {
  const outcome = parseEngineVersions(json);
  assert.equal(outcome.kind, "projection", "Group 面必须读到投影（project 档测试不测 Group 缺位）");
  return projectVersionTierOf(outcome.projection);
}

/** 在场有行档：org A 两行（一行 `releasable=true`、一行缺键）+ org B 一行。 */
function liveField() {
  return fieldOf({
    ok: true,
    versions: [{ owner_group: ORG_A, version: "v0.10.1", status: "active" }],
    projectVersions: [
      { owner_group: ORG_A, project_id: "board", version: "v0.10.0", status: "released", releasable: true, open_count: 0, completed_count: 3, cancelled_count: 0, repo_id: "a2a-coding/board", ref: "board/v0.10.0" },
      { owner_group: ORG_A, project_id: "machine", version: "v0.10.1", status: "open" },
      { owner_group: ORG_B, project_id: "shop-image-bakserver", version: "v0.10.0", status: "open", releasable: false, reason: "名下仍有在途需求" },
    ],
  });
}

/** 「读不到」档的降级文案（单点在 B2，本文件只透传，不另写一套）。 */
const ABSENT_TEXT = projectVersionDegradationText(fieldOf({ ok: true, versions: [] }));

test("档①：投影在场且有行 ⇒ 逐行显示最小键集（含 org A 切片 2 行）", () => {
  const html = renderProjectVersionsBlock(liveField(), ORG_A);
  assert.match(html, /各 project 版本/);
  assert.match(html, /board/);
  assert.match(html, /machine/);
  assert.match(html, /a2a-coding\/board/, "repo 标识透传显示");
  assert.match(html, /board\/v0\.10\.0/, "交付 ref 透传显示");
  assert.match(html, /本组 2 行/);
  assert.doesNotMatch(html, /shop-image-bakserver/, "org 切片：他组织行不进本区");
});

test("档②：投影在场但无行 ⇒ 「未登记（本版本起生效）」，且不出现 notstart 假行", () => {
  const empty = fieldOf({ ok: true, versions: [], projectVersions: [] });
  assert.equal(empty.status, "empty");
  const html = renderProjectVersionsBlock(empty, ORG_A);
  assert.match(html, /未登记（本版本起生效）/);
  assert.doesNotMatch(html, /notstart/, "绝不合成 notstart 假行");
  assert.doesNotMatch(html, /<tr>/, "无行档不得渲染任何数据行");
  assert.doesNotMatch(html, /project_versions_/, "empty 档不出降级条（不带根因码）");
});

test("档②补：live 档内他组织行被切光 ⇒ 同样落「未登记」文案（不合成假行）", () => {
  const html = renderProjectVersionsBlock(liveField(), "no-such-org");
  assert.match(html, /未登记（本版本起生效）/);
  assert.doesNotMatch(html, /notstart/);
  assert.doesNotMatch(html, /<tr>/);
});

test("档③：读不到（absent / 未装配）⇒ 降级条 + 根因码，文案单点经 B2 透传", () => {
  const field = fieldOf({ ok: true, versions: [] });
  assert.equal(field.status, "absent");
  const html = renderProjectVersionsBlock(field, ORG_A, ABSENT_TEXT);
  assert.match(html, /project_versions_field_missing/, "降级条必须带根因码");
  assert.equal(ABSENT_TEXT.includes("project_versions_field_missing"), true, "根因码来自 B2 单点");
  assert.doesNotMatch(html, /<tr>/, "降级档不得编造行");
  assert.doesNotMatch(html, /notstart/);
});

test("org 切片断言：A 组织的投影不喂 B 组织（同版号互不可见）", () => {
  const htmlB = renderProjectVersionsBlock(liveField(), ORG_B, ABSENT_TEXT);
  assert.match(htmlB, /shop-image-bakserver/);
  assert.match(htmlB, /名下仍有在途需求/, "reason 透传显示");
  assert.doesNotMatch(htmlB, /board/, "A 组织行不喂 B 组织区块");
  assert.doesNotMatch(htmlB, /machine/);
  const htmlUndefined = renderProjectVersionsBlock(liveField(), undefined, ABSENT_TEXT);
  assert.match(htmlUndefined, /本组 3 行/, "org 省略 = 不限组织（全局并集档）");
});

test("releasable 缺键 ⇒ 显示 — 档，不渲染成否定档（未知 ≠ 假否定）", () => {
  const html = renderProjectVersionsBlock(liveField(), ORG_A, ABSENT_TEXT);
  assert.match(html, /class="pvbadge tu"[^>]*>—</, "缺键 ⇒ tu 档 + —");
  assert.match(html, /class="pvbadge tr">是</, "显式 true ⇒ 是");
  assert.doesNotMatch(html, /不可发版/, "缺键档绝不得落成否定文案");
  // 只有 false 一行的档 ⇒ 才出「否」
  const falseOnly = fieldOf({
    ok: true,
    versions: [],
    projectVersions: [{ owner_group: ORG_A, project_id: "flow", version: "v0.10.1", status: "open", releasable: false, reason: "未收口" }],
  });
  const h2 = renderProjectVersionsBlock(falseOnly, ORG_A);
  assert.match(h2, /class="pvbadge tf">否</);
});

test("新样式类另立一族：不复用 .draglocked / kbadge draglock（C-18②）", () => {
  const html = renderProjectVersionsBlock(liveField(), ORG_A, ABSENT_TEXT);
  assert.doesNotMatch(html, /draglocked/, "拖拽闸的压暗类不得出现在 project 区块");
  assert.doesNotMatch(html, /draglock/, "拖拽闸的徽标类不得出现在 project 区块");
  assert.doesNotMatch(html, /kbadge/, "project 区块不用看板卡徽标基元");
  assert.match(html, /pvbadge/, "另立 .pvbadge 显示族");
  const page = renderPage({ title: "t", active: "schedule", bodyHtml: "" });
  const style = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
  assert.ok(style.length > 0, "页面样式表须可切出");
  assert.match(style, /\.pvbadge\.treleased/, "新区块样式类已进页面样式表");
  assert.match(style, /\.pv-block/, "区块容器类已进页面样式表");
  assert.doesNotMatch(style, /pvbadge[^{\n]*\{[^}]*draglock/, "新样式类定义不得引 draglock 的取色");
  assert.match(style, /\.kcard\.draglocked/, "对照：拖拽闸类仍在（未被本区块挪用/覆盖）");
});

test("project 级 released 只显样式、不参与判定（无锁语义外溢）", () => {
  const html = renderProjectVersionsBlock(liveField(), ORG_A, ABSENT_TEXT);
  assert.match(html, /class="pvbadge treleased"/, "released ⇒ 只落显示档");
  assert.match(html, /class="pvbadge topen"/, "open ⇒ 另一显示档");
  assert.doesNotMatch(html, /🔒/, "project 区块不借用 Group 发版锁的显示语言");
  assert.doesNotMatch(html, /排期已锁/);
});

test("状态值域不归一：未知 / 缺位状态 ⇒ 如实显示，不回落 Group 三态", () => {
  const field = fieldOf({
    ok: true,
    versions: [],
    projectVersions: [
      { owner_group: ORG_A, project_id: "orch", version: "v0.10.1", status: "shipping" },
      { owner_group: ORG_A, project_id: "flow", version: "v0.10.2" },
    ],
  });
  const html = renderProjectVersionsBlock(field, ORG_A);
  assert.match(html, />shipping</, "引擎自报的未知状态原样显示");
  assert.doesNotMatch(html, /未开始|进行中|已发版/, "不映射成 Group 三态文案");
  assert.match(html, /class="pvbadge tunknown"[^>]*>—</, "状态缺位 ⇒ 中性 — 档");
});

test("计数只透传不重算、不与 Group 计数互校（C-18⑥）", () => {
  const html = renderProjectVersionsBlock(liveField(), ORG_A);
  assert.match(html, />0 \/ 3 \/ 0</, "引擎自报三计数原样落格");
  assert.match(html, /— \/ — \/ —/, "缺键计数 ⇒ —");
});

test("转义：行内值经 escapeHtml，不产可执行注入面", () => {
  const field = fieldOf({
    ok: true,
    versions: [],
    projectVersions: [
      { owner_group: ORG_A, project_id: "<script>x</script>", version: "v1", status: "open", reason: "<img src=x onerror=alert(1)>" },
    ],
  });
  const html = renderProjectVersionsBlock(field, ORG_A);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.doesNotMatch(html, /<img src=x/, "原始值不得未转义进 HTML");
  assert.match(html, /&lt;script&gt;/);
});
