/**
 * REQ-2026-09-28-01 增补七 b（父改造文档 §9.1-b）—— **版本列头操作接线**（单件）。
 *
 * 判据（§9.1-b 要点内嵌）：
 * - 排期看板**版本列头**下挂一行操作（纯 SSR 小表单），三操作全部提交到**既有的那条**
 *   `POST /versions`，靠隐藏字段 `action` 分流 ⇒ 服务端写口与闸语义**零改动**（本件只接线）；
 *   1. 删除版本 = `action=remove`（增补十一 E2 起 = 框头 ×，闸 = 名下无已确认卡；想法卡自动回池）；
 *   2. 标记已发版 = `action=setStatus` + `status=released`（闸 = 名下全部收尾〔completed+cancelled〕∧ completed > 0，板既有执法；
 *      **增补十一 E3 起前台不出入口，仅后台表单直投**）；
 *   3. 重开 = `setStatus` + `status=active`（**增补十起前台不出入口，仅后台表单直投**）；
 * - 入口可见性与迁移矩阵同源（`notstart → released` 矩阵禁止 ⇒ 该列不出「标记已发版」）；
 * - 台账无登记的列（历史脏列 = 只由卡片派生）⇒ 无操作（台账里无可删 / 可改状态的条目）；
 * - **内联脚本闭集六元不扩**（列头操作零 `<script>`；「二次确认」由明确文案承担）；
 * - 读面不突变：GET /schedule 渲染操作行不得改写台账文件。
 *
 * **REQ-2026-09-28-04 增补十（父改造文档 §9.5）改口本件**：已发版为终态 ⇒ `released` 列**不再渲染
 * 任何操作入口**（「重开」从前台退役，A2-③ / A2-⑥ / A2-⑧ 三处锚按新口径收口）；**服务端零改动**
 * ⇒ `POST /versions` 的 `setStatus`（released → active）保留为**后台纠错入口**，A2-⑦ 的正例即证其在位。
 *
 * **REQ-2026-09-28-06 增补十一 E2（父改造文档 §9.6）改口本件**：删除入口由操作行的「删除版本」按钮
 * **上框**为版本框头右上角的 **×**，且**仅未开始的版本出现**（名下无已确认卡）⇒ 服务端可删闸同批改口径
 * （「名下无任何卡」→「名下无已确认卡」+ 想法卡自动回池），锚见 A2-⑦ / E2-①b / E2-⑦b。
 *
 * **REQ-2026-09-28-06 增补十一 E3（父改造文档 §9.6）改口本件**：用户裁「标记已发版按钮没啥用」⇒
 * **列头操作行 `.vops` 整体撤除**（active 列的「标记已发版」为该行最后一枚，撤后该行恒不渲染，
 * 连 CSS 一并去）⇒ **前台零 `setStatus` 入口**（三态列全锚为负向）；**服务端零改动** ⇒
 * `POST /versions` 的 `setStatus` 仍可达（released → active 与 active → released 双向直投均通，
 * 发版闸照旧执法），锚见 A2-⑦ / D1-⑩ / E3-⑪。真发版动作待「发版」按钮（另立需求 · 归 v0.9.5）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { groupFeaturesByVersion, renderSchedule } from "../dist/web/views.js";
import { createVersion, emptyVersionsLedger, serializeVersionsLedger, setVersionStatus } from "../dist/versions-ledger.js";
import { createBoardServer } from "../dist/server.js";

const NOW = "2026-09-28T12:00:00.000Z";

function feature(featureId, version, overrides = {}) {
  return {
    featureId,
    state: "executing",
    title: `需求 ${featureId}`,
    requirement: null,
    taskCount: 1,
    ownerGroup: "alpha",
    stage: "改造方案",
    version,
    approval: "已通过",
    createdAt: "c",
    updatedAt: "u",
    stateCounts: null,
    ...overrides,
  };
}

/** entries: [[version, status], ...]（notstart 走 create，其余补 setStatus）。 */
function ledgerWith(entries) {
  let l = emptyVersionsLedger();
  for (const [v, status] of entries) {
    l = createVersion(l, v, NOW).ledger;
    if (status !== "notstart") l = setVersionStatus(l, v, status, NOW).ledger;
  }
  return l;
}

/** 取某版本列的整段 HTML（从本列起，到下一列 / dialog 骨架 / 文档尾）。 */
function colHtml(html, version) {
  const at = html.indexOf(`<div class="kcol" data-version="${version}">`);
  assert.ok(at !== -1, `未找到 ${version} 列`);
  const ends = [html.indexOf('<div class="kcol"', at + 5), html.indexOf("<dialog", at)]
    .filter((n) => n !== -1)
    .concat(html.length);
  return html.slice(at, Math.min(...ends));
}

/** 框头删除入口 ×（`h3` 内的 `.vdel` 表单整段），无入口 ⇒ 空串。 */
function delOf(html, version) {
  const h3 = colHtml(html, version);
  const at = h3.indexOf('<form method="post" action="/versions" class="inline vdel"');
  if (at === -1) return "";
  return h3.slice(at, h3.indexOf("</form>", at) + "</form>".length);
}

/** 列出某版本列的全部版本写表单（增补十一 E3 起只剩框头 ×），逐项给出 action / status / 按钮。 */
function formsOf(html, version) {
  const col = colHtml(html, version);
  return [...col.matchAll(/<form method="post" action="\/versions"[\s\S]*?<\/form>/g)].map((m) => {
    const s = m[0];
    return {
      html: s,
      inHeader: s.includes('class="inline vdel"'),
      action: /name="action" value="([^"]*)"/.exec(s)?.[1] ?? null,
      status: /name="status" value="([^"]*)"/.exec(s)?.[1] ?? null,
      version: /name="version" value="([^"]*)"/.exec(s)?.[1] ?? null,
      button: /<button type="submit"[^>]*>([^<]*)<\/button>/.exec(s)?.[1] ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// ① 三态 × 入口可见性
// ---------------------------------------------------------------------------

test("A2-① notstart 列：删除入口 = 框头 ×（action=remove），不出「标记已发版」（E3 前台整体撤除）", () => {
  const ledger = ledgerWith([["v0.9.7", "notstart"]]);
  const html = renderSchedule(groupFeaturesByVersion([], ["v0.9.7"]), [], [], ledger);
  assert.equal(delOf(html, "v0.9.7") !== "", true, "未开始的列框头右上角出 ×");
  const f = formsOf(html, "v0.9.7");
  assert.deepEqual(
    f.map((x) => [x.inHeader, x.action, x.status, x.button]),
    [[true, "remove", null, "×"]],
    "× 是本列唯一表单（remove 不带 status）",
  );
  assert.doesNotMatch(colHtml(html, "v0.9.7"), /<div class="vops">|value="setStatus"|标记已发版/, "未开始的版不出操作行 / 发版 / 重开入口");
});

test("E2-①b 想法卡不算已确认：notstart 列有想法卡 ⇒ × 仍在（删除时想法卡自动回池）", () => {
  const ledger = ledgerWith([["v0.9.7", "notstart"]]);
  const html = renderSchedule(
    groupFeaturesByVersion([feature("F1", "v0.9.7", { stage: "需求分析", approval: "未发起" })], ["v0.9.7"]),
    [],
    [],
    ledger,
  );
  assert.match(delOf(html, "v0.9.7"), /name="action" value="remove"/, "全想法卡 ⇒ 该版仍是「未开始」⇒ 出 ×");
  assert.match(delOf(html, "v0.9.7"), /想法卡自动回需求池/, "× 的 title 写明回池口径");
});

test("A2-② active 列（名下有已确认卡）：**零表单**（E3 撤「标记已发版」+ E2 无 ×）", () => {
  const ledger = ledgerWith([["v0.9.6", "active"]]);
  const html = renderSchedule(groupFeaturesByVersion([feature("F1", "v0.9.6")], ["v0.9.6"]), [], [], ledger);
  assert.equal(delOf(html, "v0.9.6"), "", "负向锚：已确认卡存在的版本不出删除入口");
  assert.deepEqual(formsOf(html, "v0.9.6"), [], "active 列零版本写表单（操作行已整体撤除）");
  const col = colHtml(html, "v0.9.6");
  assert.doesNotMatch(col, /<div class="vops">/, "负向锚：不再渲染列头操作行");
  assert.doesNotMatch(col, /name="action" value="setStatus"|name="status"|标记已发版/, "负向锚：前台无 status=released 表单");
  assert.match(col, /vbadge wip/, "进行中列仍出徽标（撤入口不等于撤显示）");
});

test("A2-③ released 列：**零操作**（增补十 §9.5 纯只读 + 增补十一 E2 已发版不出 ×）", () => {
  const ledger = ledgerWith([["v0.9.3", "released"]]);
  const html = renderSchedule(groupFeaturesByVersion([feature("F1", "v0.9.3")], ["v0.9.3"]), [], [], ledger);
  assert.deepEqual(formsOf(html, "v0.9.3"), [], "released 列零表单");
  const col = colHtml(html, "v0.9.3");
  assert.doesNotMatch(col, /<div class="vops">/, "released 列不出操作行（仅 🔒 徽标）");
  assert.doesNotMatch(col, /value="remove"|删除版本|vdel/, "负向锚：released 列不渲染删除入口");
  assert.doesNotMatch(col, /name="action" value="setStatus"/, "负向锚：不再渲染 setStatus 入口");
  assert.doesNotMatch(col, /name="status" value="active"/, "负向锚：不再渲染 released → active（重开）");
  assert.match(col, /vbadge locked/, "已发版列仍有 🔒 徽标（只读不等于不显示状态）");
});

test("A2-④ 台账无该版（历史脏列 = 只由卡片派生）⇒ 无 × 也无任何写表单", () => {
  const html = renderSchedule(
    groupFeaturesByVersion([feature("F9", "dirty-old")], ["v0.9.6"]),
    [],
    [],
    ledgerWith([["v0.9.6", "active"]]),
  );
  assert.deepEqual(formsOf(html, "dirty-old"), [], "台账无可删条目 ⇒ 无死按钮");
  assert.deepEqual(
    formsOf(html, "v0.9.6").map((f) => [f.inHeader, f.action]),
    [[true, "remove"]],
    "同页台账列照常出 ×（脏列不影响他列；本列名下无已确认卡 ⇒ × 在位）· E3 后无 setStatus 表单",
  );
});

// ---------------------------------------------------------------------------
// ② 接线口径：同一条 POST /versions + 明确文案 + 零新脚本
// ---------------------------------------------------------------------------

test("A2-⑤ 表单都打既有的 POST /versions（隐藏字段 action 分流）· data-ov=1 · 值经转义", () => {
  const ledger = ledgerWith([["v0.9.6", "active"], ["v0.9.7", "notstart"]]);
  const html = renderSchedule(groupFeaturesByVersion([feature("F1", "v0.9.6")], ["v0.9.6", "v0.9.7"]), [], [], ledger);
  const all = formsOf(html, "v0.9.6").concat(formsOf(html, "v0.9.7"));
  assert.equal(all.length, 1, "E3 后全页版本写表单只剩 v0.9.7 的框头 ×");
  for (const f of all) {
    assert.match(f.html, /method="post"/, "原生 POST（无 JS 亦可用）");
    assert.match(f.html, /action="\/versions"/, `动作 ${f.action} 复用既有写口，零新端点`);
    assert.match(f.html, /data-ov="1"/, "提交守卫档：4xx/5xx 出浮层卡不跳页（闸文案可见）");
    assert.match(f.html, /data-submit="/, "提交回显文案（防连点 + 明确动作）");
  }
  const nasty = renderSchedule(
    groupFeaturesByVersion([], ['v"><script>alert(1)</script>']),
    [],
    [],
    ledgerWith([['v"><script>alert(1)</script>', "notstart"]]),
  );
  assert.match(nasty, /vdel/, "脏值列仍出 ×（入口在位）");
  assert.doesNotMatch(nasty, /<script>alert/, "台账脏值进隐藏字段与 title 必须转义");
});

test("A2-⑥ 零脚本（内联闭集六元不扩）+ 闸文案在框头与页提示双处可辨", () => {
  const ledger = ledgerWith([["v0.9.7", "notstart"], ["v0.9.3", "released"]]);
  const html = renderSchedule(groupFeaturesByVersion([], ["v0.9.7", "v0.9.3"]), [], [], ledger);
  assert.doesNotMatch(html, /<script/, "本件纯 SSR：删除入口不引入任何脚本常量");
  assert.match(delOf(html, "v0.9.7"), /title="[^"]*仅未开始的版本可删[^"]*"/, "× 的 title 写明闸");
  assert.match(delOf(html, "v0.9.7"), /aria-label="删除版本 v0\.9\.7"/, "× 有无障碍标签（按钮正文只有符号）");
  assert.doesNotMatch(html, /<div class="vops">|class="inline vop"/, "E3：整页不再有列头操作行（含已发版列）");
  assert.match(html, /<b>删除版本<\/b>[\s\S]*<b>本版撤除「标记已发版」前台入口<\/b>[\s\S]*<b>已发版（🔒）列为纯只读<\/b>/, "页提示写明删除入口 + 发版入口已撤 + 已发版只读（执法在服务端）");
  assert.match(html, /版本框头右上角的 <b>×<\/b>/, "页提示写明删除入口位置");
  assert.doesNotMatch(html, /<b>重开<\/b>/, "负向锚：页提示不再把「重开」当前台入口");
  assert.match(html, /<h3>v0\.9\.7 <span class="kbadge vbadge notstart"/, "列头徽标不被 × 挤掉（h3 结构原样）");
});

// ---------------------------------------------------------------------------
// ③ HTTP 接线：入口 → 服务端既有闸
// ---------------------------------------------------------------------------

async function withBoard(run, features, ledger, serverOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "board-a2-"));
  const file = join(dir, "data", "versions.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeVersionsLedger(ledger), "utf8");
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    now: () => Date.parse(NOW),
    versionsLedgerFile: file,
    ...serverOverrides,
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        return { features, stateCounts: null };
      },
      async getFeature() {
        throw new Error("不该被版本写面触达");
      },
      async getFeatureTrace() {
        throw new Error("不该被版本写面触达");
      },
      async getProjects() {
        throw new Error("不该被版本写面触达");
      },
      async getTasks() {
        throw new Error("不该被版本写面触达");
      },
    },
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, file);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function postVersions(base, body) {
  return fetch(`${base}/versions`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-board-write": "1", accept: "text/html" },
    body: new URLSearchParams(body).toString(),
  });
}

test("A2-⑦ HTTP 接线：既有闸逐条落位 —— 有已确认卡删⇒409 业务文案 / 未全 completed 发版⇒409 / 后台直投重开⇒303 + 台账真变", async () => {
  const ledger = ledgerWith([["v0.9.6", "active"], ["v0.9.3", "released"]]);
  await withBoard(
    async (base, file) => {
      // 删除：名下有已确认卡 ⇒ 服务端闸拒（口径变更 E2；文案业务化，浮层可呈）
      const del = await postVersions(base, { action: "remove", version: "v0.9.6" });
      assert.equal(del.status, 409, "有已确认需求 ⇒ 不可删（闸在服务端，入口只是接线）");
      const delText = await del.text();
      assert.match(delText, /board_version_remove_confirmed_cards/, "新错误码原样");
      assert.match(delText, /该版本下还有已确认需求（1 条）⇒ 请先移出后再删/, "业务化文案（不透传内部细节）");
      assert.match(delText, /class="err-ov-card"/, "错误卡族在 ⇒ data-ov=1 的 fetch 档可抽出来做浮层");

      // 后台直投发版（active → released）：名下未全部 completed ⇒ 既有闸拒（E3 只撤入口、不撤闸）
      const rel = await postVersions(base, { action: "setStatus", version: "v0.9.6", status: "released" });
      assert.equal(rel.status, 409);
      assert.match(await rel.text(), /board_version_transition_release_incomplete/, "发版闸文案（completed 0 / total 1）");

      // 重开（**后台入口**：前台已无按钮，此表单直投即数据订正通道）：released → active
      const reopen = await postVersions(base, { action: "setStatus", version: "v0.9.3", status: "active" });
      assert.equal(reopen.status, 303);
      assert.equal(reopen.headers.get("location"), "/schedule");
      const after = readFileSync(file, "utf8");
      assert.match(after, /"version": "v0\.9\.3",\s*"status": "active"/, "重开确实落台账（入口 → 写口 → 台账连通）");
      assert.match(after, /"version": "v0\.9\.6",\s*"status": "active"/, "被拒的两笔零写入");
    },
    [feature("F1", "v0.9.6")],
    ledger,
  );
});

test("E2-⑦b HTTP 接线：× 删「仅想法卡」的版本 ⇒ 200 + 卡自动回池（version 清空）+ 台账摘除", async () => {
  const seen = [];
  const ledger = ledgerWith([["v0.9.7", "notstart"]]);
  await withBoard(
    async (base, file) => {
      const res = await postVersions(base, { action: "remove", version: "v0.9.7" });
      assert.equal(res.status, 303, "表单档 = PRG 回 /schedule（无 JS 亦可用）");
      assert.deepEqual(
        seen.map((s) => [s.input.featureId, s.input.version]),
        [["F1", ""], ["F2", ""]],
        "两张想法卡各发一次排期写清空 version（不丢卡）",
      );
      assert.equal(readFileSync(file, "utf8").includes("v0.9.7"), false, "台账条目摘除");
    },
    [
      feature("F1", "v0.9.7", { stage: "需求分析", approval: "未发起" }),
      feature("F2", "v0.9.7", { stage: "需求分析", approval: "未发起" }),
    ],
    ledger,
    {
      scheduleFeatureImpl: async (input) => {
        seen.push({ input });
        return { ok: true, featureId: input.featureId, state: input.to, version: input.version };
      },
    },
  );
});

test("A2-⑧ 读面不突变：GET /schedule 渲染删除入口零写台账", async () => {
  const ledger = ledgerWith([["v0.9.6", "active"], ["v0.9.7", "notstart"], ["v0.9.3", "released"]]);
  await withBoard(
    async (base, file) => {
      const before = readFileSync(file, "utf8");
      const text = await (await fetch(`${base}/schedule`)).text();
      assert.doesNotMatch(text, /<button type="submit">标记已发版<\/button>/, "E3：active 列无「标记已发版」按钮");
      assert.doesNotMatch(text, /<button type="submit">删除版本<\/button>|class="inline vop"|<div class="vops">/, "E3：操作行整体不渲染（真页面无残留）");
      assert.match(text, /class="inline vdel"/, "真页面上未开始的 v0.9.7 列出 ×（非仅纯函数）");
      assert.doesNotMatch(text, /<button type="submit">重开<\/button>/, "已发版列无重开按钮（增补十）");
      const activeCol = colSliceOf(text, "v0.9.6");
      assert.doesNotMatch(activeCol, /vdel|删除版本|<form/, "active 列零表单（有已确认卡 ⇒ 无 ×；E3 ⇒ 无发版）");
      const releasedCol = colSliceOf(text, "v0.9.3");
      assert.doesNotMatch(releasedCol, /删除版本|重开|<form/, "released 列纯只读：无删除、无重开、零表单");
      const notstartCol = colSliceOf(text, "v0.9.7");
      assert.doesNotMatch(notstartCol, /<div class="vops">/, "v0.9.7 仅剩框头 × ⇒ 无操作行（E3）");
      assert.equal(readFileSync(file, "utf8"), before, "GET 不得改写台账");
    },
    [feature("F1", "v0.9.6")],
    ledger,
  );
});

/** 从整页 HTML 里切出某版本列（列头 + 卡），到下一列 / dialog 为止。 */
function colSliceOf(html, version) {
  const at = html.indexOf(`<div class="kcol" data-version="${version}">`);
  assert.ok(at !== -1, `未找到 ${version} 列`);
  const ends = [html.indexOf('<div class="kcol"', at + 5), html.indexOf("<dialog", at)].filter((n) => n !== -1);
  return html.slice(at, ends.length ? Math.min(...ends) : html.length);
}

// ---------------------------------------------------------------------------
// ④ REQ-2026-09-28-04 增补十（§9.5）：已发版列去「重开」入口（后台保留）
//    + 增补十一 E2（§9.6）：删除入口上框为 ×
//    + 增补十一 E3（§9.6）：列头操作行整体撤除（前台零 setStatus，后台写口保留）
// ---------------------------------------------------------------------------

test("D1-⑨ 同屏三态：notstart 只有框头 ×、active 与 released 全空（E3）", () => {
  const ledger = ledgerWith([["v0.9.7", "notstart"], ["v0.9.6", "active"], ["v0.9.3", "released"]]);
  const html = renderSchedule(groupFeaturesByVersion([feature("F1", "v0.9.6")], ["v0.9.7", "v0.9.6", "v0.9.3"]), [], [], ledger);
  assert.deepEqual(
    formsOf(html, "v0.9.7").map((f) => [f.inHeader, f.action, f.status, f.button]),
    [[true, "remove", null, "×"]],
    "notstart 列 = 框头 × 一枚（操作行不渲染）",
  );
  assert.deepEqual(formsOf(html, "v0.9.6"), [], "active 列 ops 全空（E3 撤「标记已发版」）");
  assert.deepEqual(formsOf(html, "v0.9.3"), [], "released 列 ops 全空（🔒 徽标仍在、ops 全无）");
  assert.match(colHtml(html, "v0.9.3"), /vbadge locked/, "徽标未被连带删掉");
});

test("D1-⑩ 服务端零改动：前台无重开入口，后台 setStatus 直投仍 released → active（数据纠错通道在位）", async () => {
  const ledger = ledgerWith([["v0.9.3", "released"]]);
  await withBoard(
    async (base, file) => {
      const text = await (await fetch(`${base}/schedule`)).text();
      assert.doesNotMatch(text, /value="active"/, "前台页面上没有任何指向 status=active 的表单");
      assert.doesNotMatch(text, /name="action" value="setStatus"/, "E3：前台页面上没有任何 setStatus 表单");
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.3", status: "active" });
      assert.equal(res.status, 303, "setStatus 写口与闸语义不变（released → active 无闸）");
      assert.match(readFileSync(file, "utf8"), /"version": "v0\.9\.3",\s*"status": "active"/, "后台直投确实落台账");
    },
    [],
    ledger,
  );
});

test("E3-⑪ 前台撤「标记已发版」后，后台 setStatus 正向仍通（active → released，名下全收尾且有交付）", async () => {
  const ledger = ledgerWith([["v0.9.6", "active"]]);
  await withBoard(
    async (base, file) => {
      const text = await (await fetch(`${base}/schedule`)).text();
      assert.doesNotMatch(text, /name="status" value="released"|标记已发版<\/button>/, "负向锚：前台无 status=released 表单");
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.6", status: "released" });
      assert.equal(res.status, 303, "后台入口在位：active → released 直投放行（闸 = 名下全部收尾〔completed+cancelled〕∧ completed > 0，本例满足）");
      assert.equal(res.headers.get("location"), "/schedule");
      assert.match(readFileSync(file, "utf8"), /"version": "v0\.9\.6",\s*"status": "released"/, "直投落台账（发版锁随之生效）");
    },
    [feature("F1", "v0.9.6", { state: "completed" })],
    ledger,
  );
});
