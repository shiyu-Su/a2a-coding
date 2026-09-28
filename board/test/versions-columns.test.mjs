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

import { groupFeaturesByVersion, renderSchedule } from "../dist/web/views.js";
import {
  createVersion,
  emptyVersionsLedger,
  serializeVersionsLedger,
  setVersionStatus,
} from "../dist/versions-ledger.js";
import { createBoardServer } from "../dist/server.js";

const NOW = "2026-09-27T12:00:00.000Z";

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

test("N2-⑤ HTTP：/schedule 台账独有列现形 + 三态徽标；GET 不改写台账文件（读面零写）", async () => {
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
    const handle = await createBoardServer({ host: "127.0.0.1", port: 0, client, versionsLedgerFile: ledgerFile });
    try {
      const text = await (await fetch(`http://127.0.0.1:${handle.port}/schedule`)).text();
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
    assert.equal(readFileSync(ledgerFile, "utf8"), before, "GET /schedule 不得改写台账（并集/徽标为纯读）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
