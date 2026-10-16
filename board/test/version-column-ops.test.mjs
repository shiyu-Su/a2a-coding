/**
 * REQ-2026-09-28-01 增补七 b（父改造文档 §9.1-b）—— **版本列头操作接线**（单件）。
 *
 * 判据（§9.1-b 要点内嵌）：
 * - 排期看板**版本列头**下挂一行操作（纯 SSR 小表单），三操作全部提交到**既有的那条**
 *   `POST /versions`，靠隐藏字段 `action` 分流 ⇒ 服务端写口与闸语义**零改动**（本件只接线）；
 *   1. 删除版本 = `action=remove`（增补十一 E2 起 = 框头 ×；闸见下方 REQ-2026-10-15-05 B-N2 条）；
 *   2. 标记已发版 = `action=setStatus` + `status=released`（闸 = 名下全部收尾〔completed+cancelled〕∧ completed > 0，板既有执法；
 *      **增补十一 E3 起前台不出入口，仅后台表单直投**）；
 *   3. 重开 = `setStatus` + `status=active`（**增补十起前台不出入口，仅后台表单直投**）；
 * - 入口可见性与迁移矩阵同源（`notstart → released` 矩阵禁止 ⇒ 该列不出「标记已发版」）；
 * - 台账无登记的列（历史脏列 = 只由卡片派生）⇒ 无操作（台账里无可删 / 可改状态的条目）；
 * - **内联脚本闭集八元不扩**（列头操作零 `<script>`；「二次确认」由明确文案承担）；
 * - 读面不突变：GET 排期页（B5a 后 = `/org/<名>/schedule`）渲染操作行不得改写台账文件。
 *
 * **REQ-2026-09-28-04 增补十（父改造文档 §9.5）改口本件**：已发版为终态 ⇒ `released` 列**不再渲染
 * 任何操作入口**（「重开」从前台退役，A2-③ / A2-⑥ / A2-⑧ 三处锚按新口径收口）；**服务端零改动**
 * ⇒ `POST /versions` 的 `setStatus`（released → active）保留为**后台纠错入口**，A2-⑦ 的正例即证其在位。
 *
 * **REQ-2026-09-28-06 增补十一 E2（父改造文档 §9.6）改口本件**：删除入口由操作行的「删除版本」按钮
 * **上框**为版本框头右上角的 **×**，且**仅未开始的版本出现**（名下无已确认卡）⇒ 服务端可删闸同批改口径
 * （「名下无任何卡」→「名下无已确认卡」+ 想法卡自动回池），锚见 A2-⑦ / E2-①b / E2-⑦b。
 *
 * **REQ-2026-10-15-05 B-N2 改口本件的 × 可见性**：显示谓词与引擎删版放行判据**逐字同构** ——
 * `version ∈ 可删版号集合`（页级由投影原始 entries 按白名单裁，`status ∈ {notstart, active}`）
 * ∧ 名下**每张卡**满足「`state = cancelled` ∨ 排期闸开（`derive.ts` 单一规则源）」⇒
 * **`active` 列入可删集**（旧句「仅未开始的版本出 ×」作废），挡删改由**卡条件**承担；
 * 判据原文见规范 §7「版本删除纪律」（板只裁显示、写闸归引擎）。锚见 ⑤ 段 B-N2-①…⑥。
 *
 * **REQ-2026-10-15-05 B-N7a 锚面翻案留痕（逐条「旧判据 → 新判据」；静默改绿 = 判失败）**：
 * - `A2-①`：旧「`notstart` ⇒ 该版未开始 ⇒ 出 ×（**版本状态单枚即判**）」→ 新「版号 ∈ 可删集 ∧ 名下无挡删卡
 *   ⇒ 出 ×」（本例 notstart ∧ 零卡，结论同向、判据来源已换）。
 * - `E2-①b`：旧「想法卡不算**已确认** ⇒ 该版仍是未开始 ⇒ 出 ×」+ title 正则 `/想法卡自动回需求池/`
 *   → 新「想法卡**过排期闸** ⇒ 不挡删」+ title 终稿正则 `/名下想法卡退回需求池/`。
 * - `A2-②`：旧「active **不在**可删面（仅未开始可删）⇒ 不出 ×」→ 新「active **在白名单内**、
 *   由**卡条件**（名下闸关非取消卡）挡删」；正向对照（同档版号可点）由 `A2-④` / `B-N2-①` 钉住。
 * - `A2-④`：旧「同页台账列照常出 ×（名下无**已确认卡**）」→ 新「active 入可删集 ∧ 名下无卡 ⇒ 卡条件**恒真** ⇒ 出 ×」。
 * - `A2-⑤`：入参形状随 B-N1 换 6 元（见下条）；「脏值列仍出 ×」的判据来源由「notstart = 未开始」
 *   改「版号在白名单内 ∧ 零卡」；**转义断言 `doesNotMatch(nasty, /<script>alert/)` 原样保留**（安全锚不是判据锚）。
 * - `A2-⑥`：旧 title 正则 `/仅未开始的版本可删/`（正向锚）→ 新 title 终稿正则
 *   `/名下想法卡退回需求池；已取消卡随本版清除版本归属/`，并把旧句式 `/服务端拒绝|仅未开始的版本可删/`
 *   **翻为负向锚**（板不代判引擎写闸）。
 * - 全部 `renderSchedule(...)` 调用点（本件 9 处）：旧 4 入参 `columns, pool, released, ledger`
 *   → 新 6 入参（第 5 = `org`、第 6 = `deletableVersions`），收敛到 `boardHtml()` 单点喂源。
 * - **未翻、原样保留**（不得当已翻案读）：A2-⑤ 转义断言；E3 / D1 的「零 `setStatus` 入口 / 无操作行」族；
 *   A2-⑦ / E2-⑦b / D1-⑩ / E3-⑪ 的 HTTP 写面族（写闸归引擎，本版零改动）。
 *
 * **REQ-2026-10-15-05 B-N7a 新增 ⑥ 段**：`{stage} × {approval}` **表驱动恒等锚**（改造文档 §2.2 N10 /
 * §4 回归级 2）—— 期望值就地调 `deriveScheduleGateOpen`，含 `approval = null`（混跑期 / 老桥）与
 * 未知值两行，外加四枚 state 边界档（`null` 门态全档不可点 · 未知 state · `completed` · `cancelled`）。
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
import { deriveScheduleGateOpen } from "../dist/derive.js";
import { createVersion, emptyVersionsLedger, serializeVersionsLedger, setVersionStatus } from "../dist/versions-ledger.js";
import { createBoardServer } from "../dist/server.js";
import { engineProjectionFetcher } from "./engine-versions-fixture.mjs";

const NOW = "2026-09-28T12:00:00.000Z";
/**
 * B5a 起全局 `/schedule` 退役 ⇒ 本文件 HTTP 面的看板宿主 = 该组织的空间排期页
 * `/org/alpha/schedule`（台账 B1 起按 `(org, version)` 成域 ⇒ 条目须带本组织 org 才在该页成列）。
 */
const ORG = "alpha";

function feature(featureId, version, overrides = {}) {
  return {
    featureId,
    state: "executing",
    title: `需求 ${featureId}`,
    requirement: null,
    taskCount: 1,
    ownerGroup: ORG,
    stage: "改造方案",
    version,
    approval: "已通过",
    createdAt: "c",
    updatedAt: "u",
    stateCounts: null,
    ...overrides,
  };
}

/** entries: [[version, status], ...]（notstart 走 create，其余补 setStatus）；条目挂 ORG 桶。 */
function ledgerWith(entries) {
  let l = emptyVersionsLedger();
  for (const [v, status] of entries) {
    l = createVersion(l, v, NOW, ORG).ledger;
    if (status !== "notstart") l = setVersionStatus(l, v, status, NOW).ledger;
  }
  return l;
}

/**
 * 纯函数面的**可删版号集合**夹具（REQ-2026-10-15-05 B-N2）：页级判据由
 * `server.ts` 的 `deletableVersionSetOf` 从投影原始 entries 按白名单裁出，
 * 纯函数只消费集合。本夹具照**同一白名单**（`status ∈ {notstart, active}`）从台账夹具裁出，
 * 逐条喂入 —— **released 不入集**（负判据靠这里出）。
 */
function deletableOf(ledger) {
  return new Set(
    ledger.versions
      .filter((r) => r.org === ORG && (r.status === "notstart" || r.status === "active"))
      .map((r) => r.version),
  );
}

/** 纯函数渲染的固定入参序（B-N2 起第 6 位 = 可删集）：本文件各处只换 columns / ledger / 卡集。 */
function boardHtml(columns, ledger, pool = [], released = []) {
  return renderSchedule(columns, pool, released, ledger, undefined, deletableOf(ledger));
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
  const html = boardHtml(groupFeaturesByVersion([], ["v0.9.7"]), ledger);
  assert.equal(delOf(html, "v0.9.7") !== "", true, "未开始的列框头右上角出 ×");
  const f = formsOf(html, "v0.9.7");
  assert.deepEqual(
    f.map((x) => [x.inHeader, x.action, x.status, x.button]),
    [[true, "remove", null, "×"]],
    "× 是本列唯一表单（remove 不带 status）",
  );
  assert.doesNotMatch(colHtml(html, "v0.9.7"), /<div class="vops">|value="setStatus"|标记已发版/, "未开始的版不出操作行 / 发版 / 重开入口");
});

test("E2-①b 想法卡不挡删：白名单列 ∧ 名下全想法卡 ⇒ × 在位（删除时想法卡退回需求池）", () => {
  const ledger = ledgerWith([["v0.9.7", "notstart"]]);
  const html = boardHtml(
    groupFeaturesByVersion([feature("F1", "v0.9.7", { stage: "需求分析", approval: "未发起" })], ["v0.9.7"]),
    ledger,
  );
  assert.match(delOf(html, "v0.9.7"), /name="action" value="remove"/, "想法卡（排期闸开）⇒ 出 ×");
  assert.match(delOf(html, "v0.9.7"), /名下想法卡退回需求池/, "× 的 title 写明回池口径");
});

test("A2-② active 列（名下有已过门的卡在占）：**零表单**（B-N2 卡条件 + E3 撤「标记已发版」）", () => {
  const ledger = ledgerWith([["v0.9.6", "active"]]);
  const html = boardHtml(groupFeaturesByVersion([feature("F1", "v0.9.6")], ["v0.9.6"]), ledger);
  assert.equal(delOf(html, "v0.9.6"), "", "负向锚：版号在白名单内、但名下有未过排期闸的非取消卡 ⇒ 不出删除入口");
  assert.deepEqual(formsOf(html, "v0.9.6"), [], "active 列零版本写表单（操作行已整体撤除）");
  const col = colHtml(html, "v0.9.6");
  assert.doesNotMatch(col, /<div class="vops">/, "负向锚：不再渲染列头操作行");
  assert.doesNotMatch(col, /name="action" value="setStatus"|name="status"|标记已发版/, "负向锚：前台无 status=released 表单");
  assert.match(col, /vbadge wip/, "进行中列仍出徽标（撤入口不等于撤显示）");
});

test("A2-③ released 列：**零操作**（增补十 §9.5 纯只读 + B-N2 白名单不入集 ⇒ 不出 ×）", () => {
  const ledger = ledgerWith([["v0.9.3", "released"]]);
  const html = boardHtml(groupFeaturesByVersion([feature("F1", "v0.9.3")], ["v0.9.3"]), ledger);
  assert.deepEqual(formsOf(html, "v0.9.3"), [], "released 列零表单");
  const col = colHtml(html, "v0.9.3");
  assert.doesNotMatch(col, /<div class="vops">/, "released 列不出操作行（仅 🔒 徽标）");
  assert.doesNotMatch(col, /value="remove"|删除版本|vdel/, "负向锚：released 列不渲染删除入口");
  assert.doesNotMatch(col, /name="action" value="setStatus"/, "负向锚：不再渲染 setStatus 入口");
  assert.doesNotMatch(col, /name="status" value="active"/, "负向锚：不再渲染 released → active（重开）");
  assert.match(col, /vbadge locked/, "已发版列仍有 🔒 徽标（只读不等于不显示状态）");
});

test("A2-④ 台账无该版（历史脏列 = 只由卡片派生）⇒ 无 × 也无任何写表单", () => {
  const ledger = ledgerWith([["v0.9.6", "active"]]);
  const html = boardHtml(groupFeaturesByVersion([feature("F9", "dirty-old")], ["v0.9.6"]), ledger);
  assert.deepEqual(formsOf(html, "dirty-old"), [], "台账无可删条目 ⇒ 无死按钮");
  assert.deepEqual(
    formsOf(html, "v0.9.6").map((f) => [f.inHeader, f.action]),
    [[true, "remove"]],
    "同页白名单空列照常出 ×（脏列不影响他列；B-N2 起 active 也在可删集内，名下无卡 ⇒ 卡条件恒真）· E3 后无 setStatus 表单",
  );
});

// ---------------------------------------------------------------------------
// ② 接线口径：同一条 POST /versions + 明确文案 + 零新脚本
// ---------------------------------------------------------------------------

test("A2-⑤ 表单都打既有的 POST /versions（隐藏字段 action 分流）· data-ov=1 · 值经转义", () => {
  const ledger = ledgerWith([["v0.9.6", "active"], ["v0.9.7", "notstart"]]);
  const html = boardHtml(groupFeaturesByVersion([feature("F1", "v0.9.6")], ["v0.9.6", "v0.9.7"]), ledger);
  const all = formsOf(html, "v0.9.6").concat(formsOf(html, "v0.9.7"));
  assert.equal(all.length, 1, "E3 后全页版本写表单只剩 v0.9.7 的框头 ×");
  for (const f of all) {
    assert.match(f.html, /method="post"/, "原生 POST（无 JS 亦可用）");
    assert.match(f.html, /action="\/versions"/, `动作 ${f.action} 复用既有写口，零新端点`);
    assert.match(f.html, /data-ov="1"/, "提交守卫档：4xx/5xx 出浮层卡不跳页（闸文案可见）");
    assert.match(f.html, /data-submit="/, "提交回显文案（防连点 + 明确动作）");
  }
  const nastyLedger = ledgerWith([['v"><script>alert(1)</script>', "notstart"]]);
  const nasty = boardHtml(groupFeaturesByVersion([], ['v"><script>alert(1)</script>']), nastyLedger);
  assert.match(nasty, /vdel/, "脏值列仍出 ×（入口在位）");
  assert.doesNotMatch(nasty, /<script>alert/, "台账脏值进隐藏字段与 title 必须转义");
});

test("A2-⑥ 零脚本（内联闭集八元不扩）+ 文案由框头 title/aria 写明", () => {
  const ledger = ledgerWith([["v0.9.7", "notstart"], ["v0.9.3", "released"]]);
  const html = boardHtml(groupFeaturesByVersion([], ["v0.9.7", "v0.9.3"]), ledger);
  assert.doesNotMatch(html, /<script/, "本件纯 SSR：删除入口不引入任何脚本常量");
  assert.match(
    delOf(html, "v0.9.7"),
    /title="[^"]*名下想法卡退回需求池；已取消卡随本版清除版本归属[^"]*"/,
    "× 的 title 终稿：只述本侧善后，不替引擎承诺判据",
  );
  assert.doesNotMatch(
    delOf(html, "v0.9.7"),
    /服务端拒绝|仅未开始的版本可删/,
    "负向锚：title 不写引擎侧拒因句式（板只裁显示、不代判写闸）",
  );
  assert.match(delOf(html, "v0.9.7"), /aria-label="删除版本 v0\.9\.7"/, "× 有无障碍标签（按钮正文只有符号）");
  assert.doesNotMatch(html, /<div class="vops">|class="inline vop"/, "E3：整页不再有列头操作行（含已发版列）");
  assert.doesNotMatch(html, /<b>重开<\/b>/, "负向锚：页提示不再把「重开」当前台入口");
  assert.match(html, /<h3>v0\.9\.7 <span class="kbadge vbadge notstart"/, "列头徽标不被 × 挤掉（h3 结构原样）");
});

// ---------------------------------------------------------------------------
// ③ HTTP 接线：入口 → 服务端既有闸
// ---------------------------------------------------------------------------

async function withBoard(run, features, ledger, serverOverrides = {}, engineImpl = {}) {
  const dir = mkdtempSync(join(tmpdir(), "board-a2-"));
  const file = join(dir, "data", "versions.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeVersionsLedger(ledger), "utf8");
  const engine = fakeEngine(engineImpl);
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    now: () => Date.parse(NOW),
    versionsLedgerFile: file,
    // v0.10.0 B2：版本写面改道引擎（注入假引擎，离线自证「只发意图」）。
    versionsWriteImpl: engine.client,
    // v0.10.0 尾段 N1：版本列的台账侧版号事实源 = 引擎清单 ⇒ 与本地台账夹具**同源同值**恒注入
    // （不注入会打开发机的真实引擎 ⇒ 空列随本机台账漂移）。
    engineVersionsFetcher: engineProjectionFetcher(ledger.versions.map((r) => ({ org: r.org, version: r.version, status: r.status }))),
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
    await run(`http://127.0.0.1:${handle.port}`, file, engine);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 假引擎版本写客户端（v0.10.0 B2）：记录逐次 `{kind, input}`，缺省成功档。 */
function fakeEngine(impl = {}) {
  const calls = [];
  const make = (kind) => async (input) => {
    calls.push({ kind, input });
    const r = impl[kind];
    if (typeof r === "function") return r(input);
    if (r !== undefined) return r;
    return {
      ok: true,
      httpStatus: kind === "create" ? 201 : 200,
      version: input.version,
      status: kind === "remove" ? null : (input.status ?? "notstart"),
    };
  };
  return { calls, client: { create: make("create"), remove: make("remove"), setStatus: make("setStatus") } };
}

function postVersions(base, body) {
  return fetch(`${base}/versions`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-board-write": "1", accept: "text/html" },
    body: new URLSearchParams(body).toString(),
  });
}

test("A2-⑦（v0.10.0 B2 改道）HTTP 接线：三写面只发引擎意图、错误码原样展示、本地台账零写", async () => {
  const ledger = ledgerWith([["v0.9.6", "active"], ["v0.9.3", "released"]]);
  await withBoard(
    async (base, file, engine) => {
      // 删除：名下未收口 ⇒ 引擎 409（板不再自判「已确认卡」，闸归引擎）
      const del = await postVersions(base, { action: "remove", version: "v0.9.6" });
      assert.equal(del.status, 409);
      const delText = await del.text();
      assert.match(delText, /orch_version_open_cards/, "引擎码原样（板本地码已退役）");
      assert.match(delText, /未收口/, "走显示映射表给业务化文案");
      assert.match(delText, /class="err-ov-card"/, "错误卡族在 ⇒ data-ov 档可抽出做浮层");

      // 后台直投发版（active → released）：闸归引擎
      const rel = await postVersions(base, { action: "setStatus", version: "v0.9.6", status: "released" });
      assert.equal(rel.status, 409);
      assert.match(await rel.text(), /orch_version_not_converged/, "引擎发版闸码原样");

      // 重开（released → active）：引擎放行 ⇒ 板 PRG 303
      const reopen = await postVersions(base, { action: "setStatus", version: "v0.9.3", status: "active" });
      assert.equal(reopen.status, 303);
      assert.equal(reopen.headers.get("location"), "/schedule");

      assert.deepEqual(
        engine.calls.map((c) => [c.kind, c.input.version, c.input.status ?? null]),
        [
          ["remove", "v0.9.6", null],
          ["setStatus", "v0.9.6", "released"],
          ["setStatus", "v0.9.3", "active"],
        ],
        "三笔意图均发引擎（板零本地台账写）",
      );
      assert.equal(readFileSync(file, "utf8"), serializeVersionsLedger(ledger), "本地台账逐字节不动");
    },
    [feature("F1", "v0.9.6")],
    ledger,
    {},
    {
      remove: { ok: false, httpStatus: 409, code: "orch_version_open_cards", message: "open" },
      setStatus: (input) =>
        input.version === "v0.9.6"
          ? { ok: false, httpStatus: 409, code: "orch_version_not_converged", message: "gate" }
          : { ok: true, httpStatus: 200, version: input.version, status: input.status },
    },
  );
});

test("E2-⑦b（v0.10.0 B2 改道）HTTP 接线：× 删只发引擎删意图（回池语义随本地写口退役），本地台账零写", async () => {
  const ledger = ledgerWith([["v0.9.7", "notstart"]]);
  await withBoard(
    async (base, file, engine) => {
      const res = await postVersions(base, { action: "remove", version: "v0.9.7" });
      assert.equal(res.status, 303, "表单档 = PRG 回 /schedule（无 JS 亦可用）");
      assert.deepEqual(
        engine.calls,
        [{ kind: "remove", input: { ownerGroup: null, version: "v0.9.7" } }],
        "只发删意图：不再逐张回池（闸与删语义归引擎）",
      );
      assert.equal(readFileSync(file, "utf8"), serializeVersionsLedger(ledger), "本地台账零写");
    },
    [feature("F1", "v0.9.7", { stage: "需求分析", approval: "未发起" })],
    ledger,
  );
});

test("A2-⑧（B5a 改版）读面不突变：GET 空间排期页渲染删除入口零写台账", async () => {
  const ledger = ledgerWith([["v0.9.6", "active"], ["v0.9.7", "notstart"], ["v0.9.3", "released"]]);
  await withBoard(
    async (base, file) => {
      const before = readFileSync(file, "utf8");
      const text = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
      assert.doesNotMatch(text, /<button type="submit">标记已发版<\/button>/, "E3：active 列无「标记已发版」按钮");
      assert.doesNotMatch(text, /<button type="submit">删除版本<\/button>|class="inline vop"|<div class="vops">/, "E3：操作行整体不渲染（真页面无残留）");
      assert.match(text, /class="inline vdel"/, "真页面上白名单列 v0.9.7（零挡删卡）出 ×（非仅纯函数）");
      assert.doesNotMatch(text, /<button type="submit">重开<\/button>/, "已发版列无重开按钮（增补十）");
      const activeCol = colSliceOf(text, "v0.9.6");
      assert.doesNotMatch(activeCol, /vdel|删除版本|<form/, "active 列零表单（B-N2：版号在白名单内、名下闸关非取消卡 ⇒ 卡条件挡删；E3 ⇒ 无发版）");
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
  const html = boardHtml(groupFeaturesByVersion([feature("F1", "v0.9.6")], ["v0.9.7", "v0.9.6", "v0.9.3"]), ledger);
  assert.deepEqual(
    formsOf(html, "v0.9.7").map((f) => [f.inHeader, f.action, f.status, f.button]),
    [[true, "remove", null, "×"]],
    "notstart 列 = 框头 × 一枚（操作行不渲染）",
  );
  assert.deepEqual(formsOf(html, "v0.9.6"), [], "active 列 ops 全空（B-N2 卡条件挡删 + E3 撤「标记已发版」）");
  assert.deepEqual(formsOf(html, "v0.9.3"), [], "released 列 ops 全空（白名单不入集 ⇒ 无 ×；🔒 徽标仍在、ops 全无）");
  assert.match(colHtml(html, "v0.9.3"), /vbadge locked/, "徽标未被连带删掉");
});

test("D1-⑩（v0.10.0 B2 改道）前台无重开，后台 setStatus 直投经引擎（released → active）", async () => {
  const ledger = ledgerWith([["v0.9.3", "released"]]);
  await withBoard(
    async (base, file, engine) => {
      const text = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
      assert.doesNotMatch(text, /value="active"/, "前台页面上没有任何指向 status=active 的表单");
      assert.doesNotMatch(text, /name="action" value="setStatus"/, "E3：前台页面上没有任何 setStatus 表单");
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.3", status: "active" });
      assert.equal(res.status, 303, "引擎放行 ⇒ 板 PRG 303");
      assert.deepEqual(engine.calls, [
        { kind: "setStatus", input: { ownerGroup: null, version: "v0.9.3", status: "active" } },
      ]);
      assert.equal(readFileSync(file, "utf8"), serializeVersionsLedger(ledger), "本地台账零写");
    },
    [],
    ledger,
  );
});

test("E3-⑪（v0.10.0 B2 改道）后台 setStatus 正向 active → released 经引擎（闸归引擎）", async () => {
  const ledger = ledgerWith([["v0.9.6", "active"]]);
  await withBoard(
    async (base, file, engine) => {
      const text = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
      assert.doesNotMatch(text, /name="status" value="released"|标记已发版<\/button>/, "负向锚：前台无 status=released 表单");
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.6", status: "released" });
      assert.equal(res.status, 303, "引擎放行 ⇒ 板 PRG 303");
      assert.equal(res.headers.get("location"), "/schedule");
      assert.deepEqual(engine.calls, [
        { kind: "setStatus", input: { ownerGroup: null, version: "v0.9.6", status: "released" } },
      ]);
      assert.equal(readFileSync(file, "utf8"), serializeVersionsLedger(ledger), "本地台账零写");
    },
    [feature("F1", "v0.9.6", { state: "completed" })],
    ledger,
  );
});

// ---------------------------------------------------------------------------
// ⑤ REQ-2026-10-15-05 B-N2：× 的**卡条件**四枚边界档
//    （判据 = 版号在可删集 ∧ 名下每张卡「cancelled ∨ 排期闸开」；闸条件只调用
//     `derive.ts` 的单一规则源，视图层不复制登记字段字面量）
// ---------------------------------------------------------------------------

test("B-N2-① 纯想法卡列（需求分析 ∧ 未发起）⇒ 出 ×", () => {
  const ledger = ledgerWith([["v0.9.7", "notstart"]]);
  const html = boardHtml(
    groupFeaturesByVersion([feature("F1", "v0.9.7", { stage: "需求分析", approval: "未发起" })], ["v0.9.7"]),
    ledger,
  );
  assert.notEqual(delOf(html, "v0.9.7"), "", "想法卡排期闸开 ⇒ × 在位");
});

test("B-N2-② 含「需求分析 ∧ 待审批」卡 ⇒ 不出 ×（钉「不产生回池死卡」）", () => {
  const ledger = ledgerWith([["v0.9.7", "notstart"]]);
  const html = boardHtml(
    groupFeaturesByVersion([feature("F1", "v0.9.7", { stage: "需求分析", approval: "待审批" })], ["v0.9.7"]),
    ledger,
  );
  assert.equal(delOf(html, "v0.9.7"), "", "负向锚：approval 非未发起 ⇒ 闸不开 ⇒ 一个 × 都不出");
});

test("B-N2-③ 含 completed 卡 ⇒ 不出 ×", () => {
  const ledger = ledgerWith([["v0.9.7", "notstart"]]);
  const html = boardHtml(
    groupFeaturesByVersion([feature("F1", "v0.9.7", { state: "completed" })], ["v0.9.7"]),
    ledger,
  );
  assert.equal(delOf(html, "v0.9.7"), "", "负向锚：已交付卡挡删（清 version 会使其落入无清单读面档）");
});

test("B-N2-④ 含 failed 卡 ⇒ 不出 ×（failed 不算收口）", () => {
  const ledger = ledgerWith([["v0.9.7", "notstart"]]);
  const html = boardHtml(
    groupFeaturesByVersion([feature("F1", "v0.9.7", { state: "failed" })], ["v0.9.7"]),
    ledger,
  );
  assert.equal(delOf(html, "v0.9.7"), "", "负向锚：非 cancelled 且闸不开 ⇒ 不出 ×");
});

test("B-N2-⑤ cancelled 卡不挡删（随本版清除版本归属）", () => {
  const ledger = ledgerWith([["v0.9.7", "notstart"]]);
  const html = boardHtml(
    groupFeaturesByVersion(
      [
        feature("F1", "v0.9.7", { state: "cancelled" }),
        feature("F2", "v0.9.7", { stage: "需求分析", approval: "未发起" }),
      ],
      ["v0.9.7"],
    ),
    ledger,
  );
  assert.notEqual(delOf(html, "v0.9.7"), "", "取消卡 ∨ 闸开卡 混列 ⇒ × 仍在");
});

test("B-N2-⑥ 视图层不复制排期闸的登记字段字面量（条件单点 = derive.ts）", () => {
  const src = readFileSync(new URL("../src/web/views.ts", import.meta.url), "utf8");
  const at = src.indexOf("function renderVersionDelete");
  assert.notEqual(at, -1, "找到 renderVersionDelete");
  const body = src.slice(at, src.indexOf("\n}\n", at));
  assert.match(body, /deriveScheduleGateOpen\(f\.stage, f\.approval\)/, "卡条件直接调用单一规则源");
  assert.doesNotMatch(body, /"未发起"|"需求分析"/, "负向锚：视图层不出现两枚登记字段字面量");
});

// ---------------------------------------------------------------------------
// ⑥ REQ-2026-10-15-05 B-N7a（改造文档 §2.2 N10 / §4 回归级 2）：**双侧判据恒等锚**
//    表驱动 `{stage} × {approval}`（含 `null` 与未知值两行）⇒ 期望「**可回池档 ⇔
//    `deriveScheduleGateOpen`**」**恒等**。期望值**就地调用单一规则源**（不在本文件另存
//    条件字面量），因此本锚钉的是「视图谓词 = 规则源」这一等式本身，而非某个具体取值；
//    规则源若漂，两侧同漂 ⇒ 由 ① 的「恰一格可点」计数锚兜住（防矩阵退化为全不可点）。
//    引擎侧同一判据的正式文本 = 规范 §7「版本删除纪律」放行判据 2（甲档 / 乙档）。
// ---------------------------------------------------------------------------

/** 恒等锚的固定版号（列名与版号入参须一致，卡片按此挂列）。 */
const MTX_V = "v0.9.9";

/** `{stage}` 值域：六枚在册 + `null`（老桥缺列）+ 未知值。 */
const MTX_STAGES = ["需求分析", "改造方案", "改造", "回归", "验收", "发版", null, "未知阶段"];
/** `{approval}` 值域：三枚在册 + `null`（老桥缺列）+ 未知值。 */
const MTX_APPROVALS = ["未发起", "待审批", "已通过", null, "未知门态"];

/**
 * 单卡（或多卡）列 ⇒ 该列的 × 是否**可点**（出表单）。
 * `status` = 台账状态档，经 `deletableOf` 按白名单裁 ⇒ 版号维度自动进出（`released` 不入集）。
 */
function clickable(cards, status = "active") {
  const ledger = ledgerWith([[MTX_V, status]]);
  const html = boardHtml(groupFeaturesByVersion(cards, [MTX_V]), ledger);
  return delOf(html, MTX_V) !== "";
}

/** 单卡档快捷构造。 */
function oneCard(overrides) {
  return [feature("F1", MTX_V, overrides)];
}

test("B-N7a-① 恒等锚（表驱动 {stage}×{approval} 全 40 格 · 在途卡）：× 可点 ⇔ deriveScheduleGateOpen", () => {
  let openCells = 0;
  for (const stage of MTX_STAGES) {
    for (const approval of MTX_APPROVALS) {
      const got = clickable(oneCard({ state: "executing", stage, approval }));
      const want = deriveScheduleGateOpen(stage, approval);
      if (want) openCells += 1;
      assert.equal(
        got,
        want,
        `state=executing · stage=${String(stage)} · approval=${String(approval)} ⇒ × ${got ? "可点" : "不可点"}（期望 ${want ? "可点" : "不可点"}）`,
      );
    }
  }
  assert.equal(openCells, 1, "计数锚：40 格中恰一枚可点（需求分析 ∧ 未发起）⇒ 矩阵不得退化为全不可点");
});

test("B-N7a-② approval = null 整行（混跑期 / 老桥缺登记字段）⇒ 全 stage 档不可点（fail-closed）", () => {
  for (const stage of MTX_STAGES) {
    assert.equal(deriveScheduleGateOpen(stage, null), false, `规则源：stage=${String(stage)} ∧ approval=null ⇒ 闸不开`);
    assert.equal(
      clickable(oneCard({ state: "executing", stage, approval: null })),
      false,
      "× 的卡条件随规则源一起消失（N9「混跑期 × 对所有版本消失」的谓词级锚）",
    );
  }
});

test("B-N7a-③ state 维度四枚边界档（改造文档 §4 验收 2 点名的四枚）", () => {
  // 1) 未知 state ∧ 闸关 ⇒ 不可点（板不猜 state，条件只认「cancelled ∨ 闸开」）
  assert.equal(clickable(oneCard({ state: "some_future_state" })), false, "负向锚：未知 state ∧ 闸关 ⇒ 不可点");
  // 2) 未知 state ∧ 闸开 ⇒ 可点（与引擎 B-2「state ∉ {completed,cancelled} ∧ 闸开 ⇒ 清卡集」同向）
  assert.equal(
    clickable(oneCard({ state: "some_future_state", stage: "需求分析", approval: "未发起" })),
    true,
    "未知 state 不额外挡删：闸开即回池档",
  );
  // 3) completed ⇒ 不可点
  assert.equal(clickable(oneCard({ state: "completed" })), false, "负向锚：已交付卡挡删");
  // 4) cancelled ⇒ 可点（甲档无条件）
  assert.equal(clickable(oneCard({ state: "cancelled" })), true, "取消卡不挡删");
  assert.equal(
    clickable(oneCard({ state: "cancelled", stage: "改造方案", approval: "已通过" })),
    true,
    "甲档无条件：闸关也回池（清 version、文档不搬）",
  );
});

test("B-N7a-④ cancelled（甲档）对 {stage}×{approval} 全 40 格恒可点 · 非取消卡全格不可点", () => {
  for (const stage of MTX_STAGES) {
    for (const approval of MTX_APPROVALS) {
      assert.equal(clickable(oneCard({ state: "cancelled", stage, approval })), true, `甲档恒可点：${String(stage)} / ${String(approval)}`);
      const gateOpen = deriveScheduleGateOpen(stage, approval);
      assert.equal(
        clickable(oneCard({ state: "waiting_approval", stage, approval })),
        gateOpen,
        `非取消卡 ⇔ 闸（${String(stage)} / ${String(approval)}）`,
      );
    }
  }
});

test("B-N7a-⑤ 版号维度：可删集是**必要条件**（同一张闸开卡，released / 台账无行 ⇒ 不可点）", () => {
  const open = oneCard({ state: "executing", stage: "需求分析", approval: "未发起" });
  assert.equal(clickable(open, "notstart"), true, "notstart 在白名单内 ⇒ 可点");
  assert.equal(clickable(open, "active"), true, "active 在白名单内 ⇒ 可点（旧句「仅未开始可删」已作废）");
  assert.equal(clickable(open, "released"), false, "负向锚：released 不入集（四条规则第 4 款冻结）");
  // 台账无该行（脏列 = 只由卡片派生）⇒ 版号取不到状态 ⇒ 不入集（只紧不松）
  const html = boardHtml(groupFeaturesByVersion(open, [MTX_V]), emptyVersionsLedger());
  assert.equal(delOf(html, MTX_V), "", "负向锚：无台账条目 ⇒ 无可删判据来源 ⇒ 不出 ×");
});

test("B-N7a-⑥ 登记不同构格（completed ∧ 闸开）：板侧现行为 = 可点，运行态不可达", () => {
  // §2.2 N2 的板侧谓词是「cancelled ∨ 闸开」，未含 §2.1 引擎挡删集 B-3 的**无条件** completed 支；
  // 二者仅在「completed ∧ stage=需求分析 ∧ approval=未发起」这一格不同构 —— 该卡形**不可达**
  // （能到 completed 必已过门② ⇒ stage 恒非「需求分析」），故不构成本版「板可点 / 引擎拒删」窗口。
  // 本锚**显式钉住现行为**：任一侧（views 或引擎 B-3）收紧即转红，强制复核而非静默分叉。回传登记见回执。
  assert.equal(
    clickable(oneCard({ state: "completed", stage: "需求分析", approval: "未发起" })),
    true,
    "已知不同构格（不可达）：板谓词只看「cancelled ∨ 闸开」，不判 completed 单枚",
  );
});
