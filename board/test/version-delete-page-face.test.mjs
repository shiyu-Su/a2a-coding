/**
 * REQ-2026-10-15-05 · **B-N12** —— 版本删除入口 `×` 的**页级喂源锚**（本版根因锚 · 净新增）。
 *
 * **为什么有本文件**（改造文档 §1 根因）：`×` 的可见性判据查的是**已退役的事实源** —— 页级喂进
 * `renderSchedule` 的 `ledger` 取自板本地 `.data/versions.json`（已冻结、无任何 v0.10.x 条目），
 * 而 `renderVersionDelete` 首句 `findVersionRecord(ledger, …) === null ⇒ 返回空串` ⇒
 * **真机排期页全页 `class="inline vdel"` = 0，连零卡版本 `v0.11.0` 也没有 `×`**。
 * 症状掩盖 8 个版本的原因是**回归只有纯函数级锚、无页级喂源锚** —— 纯函数锚自己喂 ledger，
 * 喂对了就永远绿，看不见「页级把哪份数据喂进来」这一层。本文件补的正是那一层：
 * **断言面 = 整页渲染里 `class="inline vdel"` 的枚数与落点**（经 `createBoardServer` 的 HTTP 面，
 * 投影由 `engineVersionsFetcher` 夹具喂入，本地台账由 `versionsLedgerFile` 喂入 —— 两份夹具**故意不同源**，
 * 谁的 × 出/不出才由「页级吃哪一份」决定）。
 *
 * **反向自证（锚有效性的判据，改造文档 §4 真机验收清单 1/5）**：旧码在本文件 ①/③ 两枚断言下**必红** ——
 * ① 零卡 `notstart` 版（只在投影里）旧码查本地台账落空 ⇒ 无 `×` ⇒ `>= 1` 挂；
 * ③ 桥宕档旧码查本地读缓存**照样出** `×` ⇒ `= 0` 挂。两枚反向钉住「判据来源 = 投影、且读不到即全挡」。
 *
 * **本文件覆盖的判据面**（B-N1 页级换源 + B-N2 `×` 谓词，改造文档 §2.2 N1/N2/N9）：
 * - ① live 投影里的**零卡 `notstart` 版** ⇒ 整页 `×` 枚数 `>= 1`，且该枚落在该列列头；
 *   ①b 同一页里**只在本地台账登记**（投影无行）的版 ⇒ 该列**无** `×`（钉「`×` 判据不得经本地台账取数」，
 *   规范 §7「版本删除纪律」放行判据 1 的「表无行 ⇒ 拒」在显示面的同构形）；
 * - ② `released` 版（不在白名单）与「白名单内 ∧ 名下有 `completed` 挡删卡」的 `active` 版 ⇒ 两列**无** `×`；
 * - ③ 投影不可达档（夹具置 fail）⇒ 整页 `×` 枚数 **= 0**（fail-closed：读不到投影时一个 `×` 都不出）
 *   ∧ 版本列照常渲染（本地台账的**降级读缓存角色不废** —— 撤它会同时打掉桥宕时的版本列渲染）；
 *   ③b 同档页头应给**原因短条**（改造文档 §2.2 N9：复用 `ctx.engineVersionsFailure` /
 *   `versionProjectionUnreadableText`）—— **B-N13 落地本锚转正**（原 `skip` 出声已摘，断言本体逐字未动）。
 *
 * **不做什么**（本节点边界）：不改任何 `src/`（断言跑不绿 ⇒ 回传实现缺陷，不自行修）；不动既有五文件
 * （与 B-N7a `version-column-ops` / B-N7b 文档族锚文件面互斥）；不引入真机 HTTP（全部走既有 stub 夹具）。
 * （**B-N13 增量**：本节点摘掉上面 ③b 的 `skip` 并在 `src/server.ts` 的 `pageOrgSpaceSchedule` 落地短条 ——
 * 除该处与删 `skip` 行外，本文件的断言与夹具**逐字未动**。）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createBoardServer } from "../dist/server.js";
import { createVersion, emptyVersionsLedger, serializeVersionsLedger, setVersionStatus } from "../dist/versions-ledger.js";
import { engineProjectionAbsentFetcher, engineProjectionFetcher } from "./engine-versions-fixture.mjs";

const NOW = "2026-10-16T00:00:00.000Z";
/** 空间排期页 = `×` 的唯一页级宿主（B5a 起全局 `/schedule` 退役）；投影与本地台账的 org 切片按本组织。 */
const ORG = "alpha";
/** 本地台账夹具的「已冻结」形态 = 只有 v0.9.x 条目（照 §1 根因里那份真实本地文件的最大版号）。 */
const LOCAL_ONLY_VERSION = "v0.9.7";
/** 投影里的零卡 `notstart` 版（真机取证的那枚症状：该版有 `×` 才对）。 */
const LIVE_ZERO_CARD_VERSION = "v0.11.0";
/** 投影里的 `active` 版 + 名下 `completed` 卡（在白名单内、由**卡条件**挡删）。 */
const LIVE_ACTIVE_VERSION = "v0.10.7";
/** 投影里的 `released` 版（不在白名单）。 */
const LIVE_RELEASED_VERSION = "v0.9.9";

function feature(featureId, version, overrides = {}) {
  return {
    featureId,
    state: "executing",
    title: `需求 ${featureId}`,
    requirement: null,
    taskCount: 1,
    ownerGroup: ORG,
    stage: "需求分析",
    version,
    approval: "未发起",
    createdAt: "c",
    updatedAt: "u",
    stateCounts: null,
    ...overrides,
  };
}

/** 本地台账夹具：`[[version, status], …]`，条目挂 ORG 桶（`notstart` 走 create，其余补 setStatus）。 */
function localLedger(entries) {
  let l = emptyVersionsLedger();
  for (const [v, status] of entries) {
    l = createVersion(l, v, NOW, ORG).ledger;
    if (status !== "notstart") l = setVersionStatus(l, v, status, NOW).ledger;
  }
  return l;
}

/** **本次渲染的固定夹具组合**：本地台账只含 v0.9.x，投影含三枚 v0.10.x/v0.11.x —— 两份**故意不同源**。 */
const LOCAL = localLedger([[LOCAL_ONLY_VERSION, "notstart"]]);
const LIVE_PROJECTION = [
  { org: ORG, version: LIVE_ZERO_CARD_VERSION, status: "notstart" },
  { org: ORG, version: LIVE_ACTIVE_VERSION, status: "active" },
  { org: ORG, version: LIVE_RELEASED_VERSION, status: "released" },
];
const CARDS = [
  // ①b 的卡：只在本地台账登记的版号，卡本身**不挡删**（想法卡、排期闸开）⇒ 旧码在此出 `×`
  feature("F-local-only", LOCAL_ONLY_VERSION),
  // ② 的卡：`completed` ∧ 已过门 ⇒ 非 `cancelled` ∧ 闸关 ⇒ 卡条件挡删
  feature("F-done", LIVE_ACTIVE_VERSION, { state: "completed", stage: "改造方案", approval: "已通过" }),
];

/** 整页 `×` 枚数（断言面 = 页级渲染里的表单数，不是纯函数返回值）。 */
function vdelCount(html) {
  return (html.match(/class="inline vdel"/g) ?? []).length;
}

/** 从整页 HTML 里切出某版本列（列头 + 卡），到下一列 / dialog 骨架为止。 */
function colSlice(html, version) {
  const at = html.indexOf(`<div class="kcol" data-version="${version}">`);
  assert.notEqual(at, -1, `未找到 ${version} 列（版本列并集失效？）`);
  const ends = [html.indexOf('<div class="kcol"', at + 5), html.indexOf("<dialog", at)]
    .filter((n) => n !== -1)
    .concat(html.length);
  return html.slice(at, Math.min(...ends));
}

/**
 * 起板、取 `/org/alpha/schedule` 整页文本。
 * `fetcher` 显式传入（live 档 / 桥宕档各一枚）⇒ 本单点不留缺省，避免用例拿错夹具。
 */
async function schedulePage(fetcher, ledger = LOCAL) {
  const dir = mkdtempSync(join(tmpdir(), "board-b12-"));
  const file = join(dir, "data", "versions.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeVersionsLedger(ledger), "utf8");
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    now: () => Date.parse(NOW),
    versionsLedgerFile: file,
    engineVersionsFetcher: fetcher,
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        return { features: CARDS, stateCounts: null };
      },
      async getFeature() {
        throw new Error("B-N12 是纯读面用例：不该触达单卡读面");
      },
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/org/${ORG}/schedule`);
    assert.equal(res.status, 200, "排期页应 200");
    return await res.text();
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ① 页级喂源正向锚（旧码在此必红）
// ---------------------------------------------------------------------------

test("B-N12-① live 投影里的零卡 notstart 版 ⇒ 整页 × 枚数 ≥ 1（根因锚：旧码查本地台账 ⇒ 0 枚 ⇒ 必红）", async () => {
  const html = await schedulePage(engineProjectionFetcher(LIVE_PROJECTION));
  assert.ok(
    vdelCount(html) >= 1,
    `整页 × 枚数 = ${String(vdelCount(html))}，应为 ≥ 1 —— 页级判据来源若退回本地台账（已冻结、无 ${LIVE_ZERO_CARD_VERSION}）即为本版原 bug`,
  );
  const col = colSlice(html, LIVE_ZERO_CARD_VERSION);
  assert.match(col, /class="inline vdel"/, `${LIVE_ZERO_CARD_VERSION}（零卡 ∧ 在白名单）列头应出 ×`);
  assert.match(col, /<input type="hidden" name="version" value="v0\.11\.0">/, "× 提交的版号 = 本列版号");
});

test("B-N12-①b 只在本地台账登记的版号（投影无行）⇒ 该列无 ×（钉「× 判据不得经本地台账取数」）", async () => {
  const html = await schedulePage(engineProjectionFetcher(LIVE_PROJECTION));
  const col = colSlice(html, LOCAL_ONLY_VERSION);
  assert.doesNotMatch(col, /class="inline vdel"/, "投影无行 ⇒ 不可删档（规范 §7 放行判据 1「表无行 ⇒ 拒」的显示面同构形）");
  // 该列不挡删的卡（想法卡、闸开）⇒ 旧码仅凭本地 notstart 条目就出 ×，反向钉住「已换源」
  assert.match(col, /需求 F-local-only/, "夹具自证：该列有名下卡");
});

// ---------------------------------------------------------------------------
// ② 负向锚：白名单外 / 卡条件挡删
// ---------------------------------------------------------------------------

test("B-N12-② released 版与「白名单内 ∧ 名下 completed 卡」的 active 版 ⇒ 两列都无 ×", async () => {
  const html = await schedulePage(engineProjectionFetcher(LIVE_PROJECTION));
  const released = colSlice(html, LIVE_RELEASED_VERSION);
  assert.doesNotMatch(released, /class="inline vdel"/, "released 不在白名单 ⇒ 无 ×");
  const active = colSlice(html, LIVE_ACTIVE_VERSION);
  assert.doesNotMatch(active, /class="inline vdel"/, "active 在白名单内，但名下有非 cancelled ∧ 闸关的卡 ⇒ 卡条件挡删");
  assert.equal(vdelCount(html), 1, `整页恰 1 枚 ×（其余档全挡），实得 ${String(vdelCount(html))} 枚`);
});

// ---------------------------------------------------------------------------
// ③ 桥宕档（fail-closed）
// ---------------------------------------------------------------------------

test("B-N12-③ 投影不可达档 ⇒ 整页 × 枚数 = 0（旧码查本地读缓存照样出 × ⇒ 必红）且版本列照常渲染", async () => {
  const html = await schedulePage(engineProjectionAbsentFetcher());
  assert.equal(vdelCount(html), 0, "读不到投影 ⇒ 一个 × 都不出（fail-closed，不得把「拿不到台账」当「全可删」）");
  assert.ok(
    html.includes(`<div class="kcol" data-version="${LOCAL_ONLY_VERSION}">`),
    "本地台账的降级读缓存角色不废：桥宕时版本列仍由本地条目撑起（撤它会打掉这一渲染）",
  );
});

test("B-N12-③b 投影不可达档 ⇒ 排期页头给原因短条（改造文档 §2.2 N9）", async () => {
  const html = await schedulePage(engineProjectionAbsentFetcher());
  const head = html.slice(html.indexOf("<h2>排期看板</h2>"), html.indexOf('<div class="kanban"'));
  assert.ok(head !== "", "页头区段可切（夹具自证）");
  assert.match(
    head,
    /引擎版本台账投影不可读（versions_unreachable/,
    "页头应含 versionProjectionUnreadableText(`${code} · ${error}`) 透出的原因文案",
  );
});
