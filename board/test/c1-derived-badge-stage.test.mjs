/**
 * REQ-2026-09-28-03 增补九 C1 —— 非台账版本（由卡片 `version` 派生的列）的列头徽标
 * **按卡片阶段判定**（父改造文档 §9.4）。
 *
 * 判据（与需求确认单 v5 迁移矩阵「`notstart → active` 触发 = 首卡过 Step 0 确认门」同源）：
 * - 名下**存在 `stage ≠ 需求分析` 的卡** ⇒ 进行中（`wip`）；
 * - 全是想法卡（`stage = 需求分析`）**或无卡** ⇒ 未开始（`notstart`）；
 * - **台账条目**仍以台账态为准（`released` 优先）；锁版（已发版集命中、台账读不到条目）仍 🔒；
 * - 需求池列（空 `version`）不受影响；`data-newversion` 虚列已于增补十一 E1 撤除（此处补负向锚）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveVersionBadgeStatus, groupFeaturesByVersion, renderSchedule } from "../dist/web/views.js";
import { createVersion, emptyVersionsLedger, serializeVersionsLedger, setVersionStatus } from "../dist/versions-ledger.js";
import { createBoardServer } from "../dist/server.js";

const NOW = "2026-09-28T12:00:00.000Z";
const IDEA = "需求分析";
/** B5a 后 HTTP 面唯一看板宿主 = 该组织的空间排期页（与 feature() 缺省 ownerGroup 同源）。 */
const ORG = "alpha";

function feature(featureId, version, overrides = {}) {
  return {
    featureId,
    state: "waiting_approval",
    title: `需求 ${featureId}`,
    requirement: null,
    taskCount: 1,
    ownerGroup: ORG,
    stage: IDEA,
    version,
    approval: "未发起",
    createdAt: "c",
    updatedAt: "u",
    stateCounts: null,
    ...overrides,
  };
}

/** 取某版本列头 `<h3>…</h3>` 段。 */
function headOf(html, version) {
  const at = html.indexOf(`<h3>${version}`);
  assert.ok(at !== -1, `未找到 <h3>${version} 列头`);
  return html.slice(at, html.indexOf("</h3>", at));
}

// ---------------------------------------------------------------------------
// ① 无卡（台账未登记该版 / 台账 notstart）
// ---------------------------------------------------------------------------

test("C1-① 无卡派生列 ⇒ 未开始（台账未登记 / 台账 notstart 两形）", () => {
  assert.equal(deriveVersionBadgeStatus([]), "notstart", "纯函数：无卡 ⇒ notstart");
  // 台账未登记该版、名下也无卡（脏列被移空 / 老桥）⇒ 派生未开始
  const html = renderSchedule(groupFeaturesByVersion([], []), [], [], emptyVersionsLedger());
  assert.doesNotMatch(html, /vbadge wip/, "无卡不判进行中");
  // 台账 notstart 条目（新版本入口的落点）⇒ 仍以台账态为准
  const ledger = emptyVersionsLedger();
  const l2 = createVersion(ledger, "v0.9.9", NOW).ledger;
  const html2 = renderSchedule(groupFeaturesByVersion([], ["v0.9.9"]), [], [], l2);
  assert.match(headOf(html2, "v0.9.9"), /<span class="kbadge vbadge notstart"[^>]*>未开始<\/span>/);
});

// ---------------------------------------------------------------------------
// ② 仅想法卡
// ---------------------------------------------------------------------------

test("C1-② 仅想法卡（stage=需求分析）⇒ 未开始；stage 缺失（老桥）fail-closed 判进行中", () => {
  const html = renderSchedule(
    groupFeaturesByVersion([feature("F1", "v0.9.7"), feature("F2", "v0.9.7", { state: "executing" })]),
    [],
    [],
    emptyVersionsLedger(),
  );
  assert.match(headOf(html, "v0.9.7"), /<span class="kbadge vbadge notstart"[^>]*>未开始<\/span>/, "全想法卡 ⇒ 未开始");
  assert.equal(deriveVersionBadgeStatus([feature("F9", "v0.9.7", { stage: null })]), "active", "stage=null ⇒ 视作已确认");
});

// ---------------------------------------------------------------------------
// ③ 含已确认卡
// ---------------------------------------------------------------------------

test("C1-③ 含已确认卡（stage ≠ 需求分析）⇒ 进行中（想法卡在场不抵消）", () => {
  assert.equal(deriveVersionBadgeStatus([feature("F1", "v0.9.7"), feature("F2", "v0.9.7", { stage: "改造方案", approval: "已通过" })]), "active");
  const html = renderSchedule(
    groupFeaturesByVersion([feature("F1", "v0.9.7"), feature("F2", "v0.9.7", { stage: "改造方案", approval: "已通过" })]),
    [],
    [],
    emptyVersionsLedger(),
  );
  assert.match(headOf(html, "v0.9.7"), /<span class="kbadge vbadge wip"[^>]*>进行中<\/span>/);
  assert.doesNotMatch(headOf(html, "v0.9.7"), /vbadge notstart/, "已确认卡 ⇒ 不再显示未开始");
});

// ---------------------------------------------------------------------------
// ④ / ⑤ 现况断言：v0.9.5（唯一想法卡）/ v0.9.4（卡均已确认）
// ---------------------------------------------------------------------------

test("C1-④ v0.9.5 现况：唯一卡 stage=需求分析 且台账无条目 ⇒ 未开始（用户 2026-09-28 验收问题）", () => {
  const cards = [feature("F-style", "v0.9.5", { title: "板样式优化" })];
  const html = renderSchedule(groupFeaturesByVersion(cards, []), [], [], emptyVersionsLedger());
  assert.match(headOf(html, "v0.9.5"), /<span class="kbadge vbadge notstart"[^>]*>未开始<\/span>/);
  assert.doesNotMatch(headOf(html, "v0.9.5"), />进行中<\/span>/, "修复前一刀切 wip 的回归锚");
});

test("C1-⑤ v0.9.4 现况：卡均 stage=改造方案 ⇒ 进行中；台账态优先；released 优先于卡片派生", () => {
  const confirmed = [feature("F1", "v0.9.4", { stage: "改造方案", approval: "已通过", state: "executing" })];
  const noLedger = renderSchedule(groupFeaturesByVersion(confirmed, []), [], [], emptyVersionsLedger());
  assert.match(headOf(noLedger, "v0.9.4"), /<span class="kbadge vbadge wip"[^>]*>进行中<\/span>/);

  const notstartLedger = createVersion(emptyVersionsLedger(), "v0.9.4", NOW).ledger;
  const withLedger = renderSchedule(groupFeaturesByVersion(confirmed, ["v0.9.4"]), [], [], notstartLedger);
  assert.match(headOf(withLedger, "v0.9.4"), /<span class="kbadge vbadge notstart"[^>]*>未开始<\/span>/, "台账态优先于卡片派生");

  const releasedLedger = setVersionStatus(
    createVersion(emptyVersionsLedger(), "v0.9.4", NOW).ledger,
    "v0.9.4",
    "released",
    NOW,
  ).ledger;
  const releasedHtml = renderSchedule(
    groupFeaturesByVersion([feature("I1", "v0.9.4", { stage: IDEA })], ["v0.9.4"]),
    [],
    [],
    releasedLedger,
  );
  assert.match(headOf(releasedHtml, "v0.9.4"), /<span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span>/, "台账 released 优先");

  // 台账读不到（老桥 ledger=null）但已发版集命中 ⇒ 仍 🔒
  const lockedNoLedger = renderSchedule(groupFeaturesByVersion([feature("I2", "v0.9.1")]), [], ["v0.9.1"], null);
  assert.match(headOf(lockedNoLedger, "v0.9.1"), /<span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span>/);
});

// ---------------------------------------------------------------------------
// ⑥ HTTP 面 + 不受影响面（需求池列 / 新版本虚列）
// ---------------------------------------------------------------------------

test("C1-⑥（B5a 改版：全局 /schedule 退役 ⇒ 宿主 = 空间排期页）HTTP：想法卡列未开始、已确认列进行中；需求池列与虚列不受影响", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-c1-"));
  const ledgerFile = join(dir, "versions.json");
  // B1 起台账按 (org, version) 键 ⇒ 空间页只切本组织桶，台账条目须带 org 才在 alpha 列现形
  writeFileSync(ledgerFile, serializeVersionsLedger(createVersion(emptyVersionsLedger(), "v0.9.9", NOW, ORG).ledger), "utf8");
  const cards = [
    feature("F1", "v0.9.5"),
    feature("F2", "v0.9.4", { stage: "改造方案", approval: "已通过", state: "executing" }),
    feature("F3", null),
  ];
  const client = {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features: cards, stateCounts: null };
    },
  };
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, client, versionsLedgerFile: ledgerFile });
  try {
    const text = await (await fetch(`http://127.0.0.1:${handle.port}/org/${ORG}/schedule`)).text();
    assert.match(text, /<h3>v0\.9\.5 <span class="kbadge vbadge notstart"[^>]*>未开始<\/span>/);
    assert.match(text, /<h3>v0\.9\.4 <span class="kbadge vbadge wip"[^>]*>进行中<\/span>/);
    assert.match(headOf(text, "v0.9.9"), /<span class="kbadge vbadge notstart"[^>]*>未开始<\/span>/, "台账 notstart 空列照旧");
    assert.match(text, /<h3>需求池 <span class="muted">\(1\)<\/span><\/h3>/, "需求池列无版本徽标");
    const poolAt = text.indexOf("<h3>需求池");
    assert.doesNotMatch(text.slice(poolAt, text.indexOf('<div class="kcol"', poolAt)), /vbadge/, "件3 起池列是最左列 ⇒ 右界取下一枚 kcol（不吞版本列头徽标）");
    assert.doesNotMatch(text, /data-newversion/, "新版本虚列已撤（E1 §9.6）⇒ 徽标派生不受影响");
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
