/**
 * REQ-2026-09-27-05 §2.2 N2 —— 版本列并集（台账条目 ∪ 需求卡派生）+ 列头三态徽标（单件）。
 *
 * 判据（改造文档 §2.2）：
 * - 版本列 = 台账条目 ∪ 需求卡派生**并集**（`groupFeaturesByVersion` 改造）：
 *   台账独有 ⇒ 空列现形；卡独有（历史脏列）⇒ 保留显示；交集 ⇒ 并作一列；
 * - 列头状态徽标三态：notstart=未开始 / active=进行中 / released=🔒（`renderVersionBadge` 扩展）；
 * - **读面不突变**：并集/徽标是纯读、零写（惰性状态转换归 N3），GET 不改台账文件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { groupFeaturesByVersion, projectionLedgerOf, projectionVersionNames, renderSchedule } from "../dist/web/views.js";
import {
  createVersion,
  emptyVersionsLedger,
  releasedVersionNames,
  serializeVersionsLedger,
  setVersionStatus,
} from "../dist/versions-ledger.js";
import { createBoardServer } from "../dist/server.js";
import { engineProjectionAbsentFetcher, engineProjectionFetcher, engineEnvelopeFetcher, engineEnvelopeOf, engineProjectionOf, engineProjectLiveField } from "./engine-versions-fixture.mjs";

const NOW = "2026-09-27T12:00:00.000Z";
/**
 * B5a 起全局 `/schedule` 退役 ⇒ N2-⑤ HTTP 面的看板宿主 = 空间排期页 `/org/alpha/schedule`；
 * 台账 B1 起按 `(org, version)` 成域 ⇒ 条目须带本组织 org 才能在该页成列（纯函数面 org 传
 * `undefined` = 不限组织，故本文件 ①–④ 单元锚不受影响）。
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

/** entries: [[version, status], ...]（notstart 走 create，其余补 setStatus）。 */
function ledgerWith(entries) {
  let l = emptyVersionsLedger();
  for (const [v, status] of entries) {
    l = createVersion(l, v, NOW, ORG).ledger;
    if (status !== "notstart") l = setVersionStatus(l, v, status, NOW).ledger;
  }
  return l;
}

/** 取某版本列头 `<h3>…</h3>` 段。 */
function headOf(html, version) {
  const at = html.indexOf(`<h3>${version}`);
  assert.ok(at !== -1, `未找到 <h3>${version} 列头`);
  return html.slice(at, html.indexOf("</h3>", at));
}

// ---------------------------------------------------------------------------
// N2-① 并集三例：台账独有 / 卡独有 / 交集
// ---------------------------------------------------------------------------

test("N2-① groupFeaturesByVersion 并集：台账独有出空列 / 卡独有（历史脏列）保留 / 交集并作一列", () => {
  const cards = [feature("F1", "v0.9.4"), feature("F9", "dirty-old")];
  const ledgerNames = ["v0.9.4", "v0.9.5", "v0.9.3"];
  const cols = groupFeaturesByVersion(cards, ledgerNames);
  assert.deepEqual(
    cols.map((c) => c.version),
    ["v0.9.3", "v0.9.4", "v0.9.5", "dirty-old"],
    "台账独有 v0.9.3/v0.9.5 + 交集 v0.9.4 + 卡独有 dirty-old，列序 = semver 数值序（脏列垫底）",
  );
  const byName = Object.fromEntries(cols.map((c) => [c.version, c.features.map((f) => f.featureId)]));
  assert.deepEqual(byName["v0.9.5"], [], "台账独有 ⇒ 空列（新版本入口的落点，尚无卡）");
  assert.deepEqual(byName["v0.9.3"], [], "台账独有 ⇒ 空列");
  assert.deepEqual(byName["v0.9.4"], ["F1"], "交集 ⇒ 并作一列（不重复出列）");
  assert.deepEqual(byName["dirty-old"], ["F9"], "卡独有（台账无登记）⇒ 历史脏列保留显示");
  assert.equal(new Set(cols.map((c) => c.version)).size, cols.length, "同版本不重复出列");
  // 纯函数：不改动入参
  assert.equal(cards.length, 2, "不得改动入参 features");
  assert.deepEqual(cards.map((f) => f.featureId), ["F1", "F9"], "入参顺序与数量不变");
});

test("N2-② 未排期（null/空串/纯空格）仍滤除；台账空串/纯空白版本忽略（不自成一列）；缺省无台账行为不变", () => {
  assert.deepEqual(groupFeaturesByVersion([feature("F1", null), feature("F2", "  ")], ["", "   "]), []);
  assert.deepEqual(groupFeaturesByVersion([feature("F1", null)]), [], "缺省 ledgerVersions=[] ⇒ 与改造前同");
  const cols = groupFeaturesByVersion([], ["v0.9.5"]);
  assert.deepEqual(cols.map((c) => c.version), ["v0.9.5"], "只有台账条目也出列（空列）");
});

// ---------------------------------------------------------------------------
// N2-③ 三态徽标渲染
// ---------------------------------------------------------------------------

test("N2-③ renderVersionBadge 三态：notstart=未开始 / active=进行中 / released=🔒 已发版（样式分立）", () => {
  const ledger = ledgerWith([
    ["v0.9.3", "released"],
    ["v0.9.4", "active"],
    ["v0.9.5", "notstart"],
  ]);
  const html = renderSchedule(groupFeaturesByVersion([], ["v0.9.3", "v0.9.4", "v0.9.5"]), [], [], ledger);
  assert.match(headOf(html, "v0.9.5"), /<span class="kbadge vbadge notstart"[^>]*>未开始<\/span>/);
  assert.match(headOf(html, "v0.9.4"), /<span class="kbadge vbadge wip"[^>]*>进行中<\/span>/);
  assert.match(headOf(html, "v0.9.3"), /<span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span>/);
  assert.match(headOf(html, "v0.9.3"), /title="[^"]*已发版[^"]*"/, "tooltip 携台账状态说明");
  assert.match(headOf(html, "v0.9.5"), /<span class="muted">\(0\)<\/span>/, "空列仍带卡片数（0）");
});

test("N2-④ 交集列：徽标以台账状态为准（卡在场但台账 notstart ⇒ 未开始）；无台账记录回落既有派生（读面不突变）", () => {
  const ledger = ledgerWith([["v0.9.4", "notstart"]]);
  const withLedger = renderSchedule(groupFeaturesByVersion([feature("F1", "v0.9.4")], ["v0.9.4"]), [], [], ledger);
  assert.match(headOf(withLedger, "v0.9.4"), />未开始<\/span>/, "台账 notstart 优先于卡片派生");
  // 无台账列（老桥 / 历史列）⇒ 原派生路径不变；config releasedVersions 命中仍「🔒 已发版」
  const noLedger = renderSchedule(groupFeaturesByVersion([feature("F2", "v0.9.4")]), [], []);
  assert.match(headOf(noLedger, "v0.9.4"), /<span class="kbadge vbadge wip"[^>]*>进行中<\/span>/, "无台账 ⇒ 回落派生（进行中）");
  const lockedNoLedger = renderSchedule(groupFeaturesByVersion([feature("F3", "v0.9.1")]), [], ["v0.9.1"]);
  assert.match(headOf(lockedNoLedger, "v0.9.1"), />🔒 已发版<\/span>/, "无台账但 config 锁版 ⇒ 派生徽标不变");
});

// ---------------------------------------------------------------------------
// N2-⑤ HTTP 接线 + 读面零写
// ---------------------------------------------------------------------------

test("N2-⑤（B5a 改版）HTTP：空间排期页台账独有列现形 + 三态徽标；GET 不改写台账文件（读面零写）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-n2-"));
  try {
    const ledgerFile = join(dir, ".data", "versions.json");
    mkdirSync(join(dir, ".data"), { recursive: true });
    writeFileSync(
      ledgerFile,
      serializeVersionsLedger(
        ledgerWith([
          ["v0.9.3", "released"],
          ["v0.9.5", "notstart"],
        ]),
      ),
      "utf8",
    );
    const before = readFileSync(ledgerFile, "utf8");
    const client = {
      baseUrl: "http://fake",
      async getFeatures() {
        return { features: [feature("F1", "v0.9.4")], stateCounts: null };
      },
    };
    const handle = await createBoardServer({
      host: "127.0.0.1",
      port: 0,
      client,
      versionsLedgerFile: ledgerFile,
      // v0.10.0 尾段 N1：版本列的台账侧版号事实源 = 引擎清单 ⇒ 与本地台账夹具**同源同值**恒注入
      // （不注入会打开发机的真实引擎：列随本机台账漂移，且降级档（读缓存）永不被测到）。
      engineVersionsFetcher: engineProjectionFetcher([
        { org: ORG, version: "v0.9.3", status: "released" },
        { org: ORG, version: "v0.9.5", status: "notstart" },
      ]),
    });
    try {
      const text = await (await fetch(`http://127.0.0.1:${handle.port}/org/${ORG}/schedule`)).text();
      assert.match(
        text,
        /<h3>v0\.9\.5 <span class="kbadge vbadge notstart"[^>]*>未开始<\/span>/,
        "台账独有 v0.9.5 ⇒ 空列 + 未开始徽标",
      );
      assert.match(text, /<h3>v0\.9\.3 <span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span>/, "台账 released ⇒ 🔒");
      assert.match(text, /<h3>v0\.9\.4 <span class="kbadge vbadge wip"/, "卡独有 v0.9.4 保留显示（无台账记录回落派生）");
    } finally {
      await handle.close();
    }
    assert.equal(readFileSync(ledgerFile, "utf8"), before, "GET 排期页不得改写台账（并集/徽标为纯读）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v0.10.0 尾段 N1 —— 版本列并集换源：**引擎 Release 清单 ∪ 卡派生版号**（并集留板）
//   ① 引擎清单是台账侧版号的事实源（板本地台账降为「从未读到过投影」的降级读缓存）；
//   ② 绝不「只渲染引擎清单」：引擎无 Release 条目 ∧ 卡有 `version` ⇒ 该版仍须成列
//      （否则该卡在版本面失去清单读面）。
// ---------------------------------------------------------------------------

/** 引擎投影（`EngineVersionsProjection` 形态，同 `bridge-client.parseEngineVersions` 出参）。 */
function projectionOf(entries) {
  return { entries, capturedAt: NOW };
}

test("N1-① projectionVersionNames：null ⇒ 空清单；条目按登记序去重；空版号忽略；org 切片档同 ledgerVersionNames", () => {
  assert.deepEqual(projectionVersionNames(null), [], "从未读到过投影 ⇒ 空清单（不当作「引擎零版本」）");
  assert.deepEqual(projectionVersionNames(projectionOf([])), [], "空台账 = 合法零条目");
  const p = projectionOf([
    { org: "alpha", version: "v0.9.9", status: "notstart" },
    { org: "beta", version: "v0.9.8", status: "released" },
    { org: "alpha", version: "v0.9.9", status: "active" },
    { org: "", version: "v1.0.0", status: "active" },
    { org: "alpha", version: "   ", status: null },
  ]);
  assert.deepEqual(projectionVersionNames(p), ["v0.9.9", "v0.9.8", "v1.0.0"], "不限组织：跨组织同名折叠为一、保持登记序、空版号丢");
  assert.deepEqual(projectionVersionNames(p, "alpha"), ["v0.9.9"], "切片档 = 只取本组织条目");
  assert.deepEqual(projectionVersionNames(p, ""), ["v1.0.0"], "空串 = 未归属桶精确档");
  assert.deepEqual(projectionVersionNames(p, "gamma"), [], "该组织无条目 ⇒ 空清单");
});

test("N1-② 并集（定向核心）：引擎清单空 ∧ 卡有 version ⇒ 该版仍成列；引擎独有条目 ⇒ 空列；交集并作一列；两路版号不重复出列", () => {
  assert.deepEqual(
    groupFeaturesByVersion([feature("F1", "v0.9.4"), feature("F9", "dirty-old")], [], []).map((c) => c.version),
    ["v0.9.4", "dirty-old"],
    "引擎无 Release 条目 ⇒ 卡派生版号照旧成列（含历史脏列）",
  );
  const cols = groupFeaturesByVersion([feature("F1", "v0.9.4")], [], ["v0.9.5", "v0.9.4"]);
  assert.deepEqual(cols.map((c) => c.version), ["v0.9.4", "v0.9.5"], "引擎独有 v0.9.5 成空列；交集 v0.9.4 并作一列");
  assert.deepEqual(cols[1].features, [], "引擎独有能力 ⇒ 空列（尚无卡）");
  const both = groupFeaturesByVersion([feature("F2", "v0.9.4")], ["v0.9.3"], ["v0.9.5", "v0.9.3"]);
  assert.deepEqual(both.map((c) => c.version), ["v0.9.3", "v0.9.4", "v0.9.5"], "两路台账版号同给 ⇒ 并集不重复出列");
});

test("N1-③ HTTP：引擎清单独有版本（本地台账零条目）⇒ 空间排期页出空列；卡派生版号同时在列（并集留板）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-n1-"));
  try {
    const ledgerFile = join(dir, "versions.json");
    writeFileSync(ledgerFile, serializeVersionsLedger(emptyVersionsLedger()), "utf8");
    const client = {
      baseUrl: "http://fake",
      async getFeatures() {
        return { features: [feature("F1", "v0.9.4")], stateCounts: null };
      },
    };
    const handle = await createBoardServer({
      host: "127.0.0.1",
      port: 0,
      client,
      versionsLedgerFile: ledgerFile,
      engineVersionsFetcher: engineProjectionFetcher([{ org: ORG, version: "v2.0.0", status: "notstart" }]),
    });
    try {
      const text = await (await fetch(`http://127.0.0.1:${handle.port}/org/${ORG}/schedule`)).text();
      assert.match(
        text,
        /<h3>v2\.0\.0 <span class="kbadge vbadge notstart"[^>]*>未开始<\/span> <span class="muted">\(0\)<\/span>/,
        "引擎清单独有版本 ⇒ 空列现形（本地台账无该条目）",
      );
      assert.match(text, /<h3>v0\.9\.4 <span class="kbadge vbadge wip"/, "卡派生版号仍在列（并集不因引擎清单在场而收缩）");
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N1-④ HTTP 降级档：投影从未读到（absent）⇒ 本地台账读缓存照常成列（读面不挡）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-n1d-"));
  try {
    const ledgerFile = join(dir, "versions.json");
    writeFileSync(ledgerFile, serializeVersionsLedger(ledgerWith([["v0.9.5", "notstart"]])), "utf8");
    const client = {
      baseUrl: "http://fake",
      async getFeatures() {
        return { features: [feature("F1", "v0.9.4")], stateCounts: null };
      },
    };
    const handle = await createBoardServer({
      host: "127.0.0.1",
      port: 0,
      client,
      versionsLedgerFile: ledgerFile,
      engineVersionsFetcher: engineProjectionAbsentFetcher(),
    });
    try {
      const text = await (await fetch(`http://127.0.0.1:${handle.port}/org/${ORG}/schedule`)).text();
      assert.match(text, /<h3>v0\.9\.5 /, "拿不到投影 ⇒ 台账读缓存仍贡献版号（不退化成只渲染卡派生）");
      assert.match(text, /<h3>v0\.9\.4 /, "卡派生版号不受影响");
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v0.10.1 B5 —— 版本列侧的**两族负向钉**（改造文档 §2 C-1 / C-7「`versions[]` 成员与语义零改动」
//   / §3 board 段「project 行混入 versions[] ⇒ 不出列」+「同名 group / project 版号互不染色」）：
//   ① 脏形状（project 行混进 `versions[]`）必须走**真解析层**才作数 —— 手拼 projection 会绕过
//     解析层那道裁撤、断言变成自证 ⇒ 经夹具 `engineEnvelopeFetcher` / `engineEnvelopeOf` 喂原始信封；
//   ② 同名版号在两级之间**互不染色**：project 侧 `released` 不把 Group 列头染成 🔒，
//     Group 侧 `released` 也不因 project 侧 `open` 而退色。
// ---------------------------------------------------------------------------

/** 同一组 Group 行的干净信封与脏信封（脏 = 尾部混入两条 project 形状行）。 */
const CLEAN_GROUP_ROWS = [
  { owner_group: "alpha", version: "v0.10.0", status: "active" },
  { owner_group: "alpha", version: "v0.9.9", status: "released" },
];
const DIRTY_ENVELOPE = {
  ok: true,
  versions: [
    ...CLEAN_GROUP_ROWS,
    { owner_group: "alpha", project_id: "board", version: "v9.9.9", status: "released" },
    { owner_group: "alpha", project_id: "machine", version: "v8.8.8", status: "open" },
  ],
};

test("B5-①（负向钉 a·纯函数面）project 行混入 versions[] ⇒ 整条不进投影 ⇒ 版本列清单无其版号；Group 面 entries 与干净信封逐字节同", () => {
  const dirty = engineEnvelopeOf(DIRTY_ENVELOPE);
  assert.equal(dirty.kind, "projection", "混入行不改变 Group 面的投影成立");
  assert.deepEqual(
    projectionVersionNames(dirty.projection),
    ["v0.10.0", "v0.9.9"],
    "project 版号 v9.9.9 / v8.8.8 一条都不进版本列清单（带非空白 project_id ⇒ 解析层整条丢弃）",
  );
  assert.deepEqual(
    dirty.projection.entries,
    engineEnvelopeOf({ ok: true, versions: CLEAN_GROUP_ROWS }).projection.entries,
    "versions[] 成员与语义零改动：脏信封与干净信封解析出同一份 Group entries（同序、同状态）",
  );
});

test("B5-②（负向钉 a·HTTP 面）脏信封喂空间排期页 ⇒ project 版号不成列；同名 project released 不把 Group 列头染成 🔒", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-b5-"));
  try {
    const ledgerFile = join(dir, "versions.json");
    writeFileSync(ledgerFile, serializeVersionsLedger(emptyVersionsLedger()), "utf8");
    const client = {
      baseUrl: "http://fake",
      async getFeatures() {
        return { features: [feature("F1", "v0.10.0")], stateCounts: null };
      },
    };
    // 脏信封：versions[] 混入 project 行（v9.9.9 released）+ projectVersions[] 另带同名 v0.10.0 released
    const handle = await createBoardServer({
      host: "127.0.0.1",
      port: 0,
      client,
      versionsLedgerFile: ledgerFile,
      engineVersionsFetcher: engineEnvelopeFetcher({
        ok: true,
        versions: [...CLEAN_GROUP_ROWS, { owner_group: "alpha", project_id: "board", version: "v9.9.9", status: "released" }],
        projectVersions: [{ owner_group: "alpha", project_id: "board", version: "v0.10.0", status: "released" }],
      }),
    });
    try {
      const text = await (await fetch(`http://127.0.0.1:${handle.port}/org/${ORG}/schedule`)).text();
      assert.doesNotMatch(text, /<h3>v9\.9\.9/, "混入的 project 版号不出现在版本列");
      assert.match(text, /<h3>v0\.10\.0 <span class="kbadge vbadge wip"/, "同名互不染色：Group active ∧ project released ⇒ 列头仍是「进行中」");
      assert.doesNotMatch(text, /<h3>v0\.10\.0 <span class="kbadge vbadge locked"/, "project 侧 released 不得把 Group 列头染成 🔒");
      assert.match(text, /<h3>v0\.9\.9 <span class="kbadge vbadge locked"/, "Group 侧 released 照常上锁样式（对照组：本钉不是「一律不上锁」）");
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5-③（负向钉 b·反向不染色）Group released ∧ project 同名未 released ⇒ 列头 🔒 照常（project 不松 Group）", () => {
  const { projection } = engineProjectionOf(
    [{ org: ORG, version: "v0.10.0", status: "released" }],
    ORG,
    engineProjectLiveField([{ org: ORG, projectId: "board", version: "v0.10.0", status: "open" }]),
  );
  const lockedVersions = releasedVersionNames(projectionLedgerOf(projection), ORG);
  assert.deepEqual(lockedVersions, ["v0.10.0"], "锁名单只由 Group 条目派生（project 侧 open 不把它摘掉）");
  const html = renderSchedule(groupFeaturesByVersion([feature("F1", "v0.10.0")], [], projectionVersionNames(projection)), [], lockedVersions, ledgerWith([]));
  assert.match(headOf(html, "v0.10.0"), /<span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span>/);
});
