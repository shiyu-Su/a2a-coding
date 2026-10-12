/**
 * REQ-2026-10-09-01 · v0.10.1 · board **B4** —— project 版本区块**接线**进组织空间排期页。
 * ★v0.10.2 落点③ 摘块后本档改判：区块已不存在 ⇒ 原「结构位置」类判据（① / ②b / ③b / ④ 的区块体段）
 * 一并退役，其**守门语义不消失**，按改造文档 §2.3 A-2 / B-2 的「重指向不删条」口径落到：
 * - **B4-①（区块不得嵌进看板）** ⇒ 由 `n3-regression-anchors` **N3-⑩ / ⑩b 改判后的「排期页整页零 pv
 *   元素」四件闭集钉**严格覆盖（区块不存在 ⇒ 嵌位不存在）；
 * - **B4-④b（共用 Group 那次投影、零新增上游）** ⇒ 由**管理页**「一次渲染 = 恰一次 `/api/versions`」锚
 *   承接（N4 `manage-read-and-origin-anchors`；排期页侧同一读数由 two-tier **B2-④** 存续）。
 * 本档**存续**的判据：② 拖拽脚本入口守卫（★必须保留，摘块后更有守门价值）· ③ 空间三枚 tab 闭集 ·
 * ④ Group 面（版本列 / 已发版锁 / 需求池）照常 + 排期页不裸吐 project 根因码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";
import { DRAG_SCHEDULE_SCRIPT } from "../dist/web/layout.js";
import {
  engineProjectionWithProjectAbsentFetcher,
  engineProjectionWithProjectsFetcher,
} from "./engine-versions-fixture.mjs";

const ORG = "alpha";
// ★v0.10.2 落点③：`BOARD_OPEN` / `PV_OPEN` 两枚结构常量与下面的 `kanbanRange()` / `pvRange()` helper
//   一并撤除 —— 原用途 = 按 div 嵌套深度摘出看板 / 区块区间，判「区块不得嵌进 `#schedule-board`」；
//   摘块后该判据的主语已不存在，其守门语义由 `n3-regression-anchors` **N3-⑩ 改判后的「排期页整页零
//   pv 元素」四件闭集钉**严格覆盖（改造文档 §2.3 A-2：重指向、非净丢失）。

function feature(featureId, version) {
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
    decisions: null,
    createdAt: "c",
    updatedAt: "u",
  };
}

function fakeClient() {
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features: [feature("F1", "v1.0.0"), feature("F2", null)], stateCounts: null };
    },
    async getFeature(featureId) {
      return { feature: feature(featureId, "v1.0.0"), tasks: [], acceptance: null };
    },
    async getFeatureTrace() {
      return null;
    },
    async getProjects() {
      return { projects: [] };
    },
    async getTasks() {
      return { tasks: [] };
    },
  };
}

async function withServer(fetcher, run) {
  const dir = mkdtempSync(join(tmpdir(), "board-b4-"));
  const ledgerFile = join(dir, "versions.json");
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, versions: [] }, null, 2) + "\n", "utf8");
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: fakeClient(),
    versionsLedgerFile: ledgerFile,
    engineVersionsFetcher: fetcher,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const LIVE_FETCHER = () =>
  engineProjectionWithProjectsFetcher(
    [{ org: ORG, version: "v1.0.0", status: "released" }, { org: ORG, version: "v1.0.1", status: "active" }],
    [
      { org: ORG, projectId: "board", version: "v1.0.0", status: "released", releasable: true, openCount: 0, completedCount: 2, cancelledCount: 0, repoId: "board", ref: "board/v1.0.0" },
      { org: ORG, projectId: "orch", version: "v1.0.1", status: "open", releasable: null, openCount: 1, completedCount: 0, cancelledCount: 0 },
      { org: "乙组", projectId: "other", version: "v9.9.9", status: "open", releasable: false },
    ],
  );

// ---------------------------------------------------------------------------
// ① 结构判据（★v0.10.2 落点③ · 原 B4-① / B4-①b 退役，语义并入零处钉）
// ---------------------------------------------------------------------------
// 原 B4-①（live / empty / absent 三档各自判「区块与 `#schedule-board` 是**同级 section**：看板闭合之后
// 才出现，且看板区间内不含 `pv-block` / 不含标题「各 project 版本」）与原 B4-①b（live 档逐行喂入 +
// org 切片 + `.pvbadge` 显示档）随 `.pv-block` 摘除一并退役。
// ★**原 B4-① 语义并入排期页零处钉**：「区块不得嵌进看板」由 `test/n3-regression-anchors.test.mjs`
//   的 **N3-⑩ / ⑩b 改判后「排期页整页零 pv 元素」四件闭集钉**严格覆盖 —— 区块不存在 ⇒ 嵌位不存在，
//   新锚是**更强的**负向钉（改造文档 §2.3 A-2：重指向不删条，非净丢失）。
//   原 B4-①b 的「org 切片 / 他组织不染色 / `released` 只显样式」语义归**管理页新列**（落点①，
//   锚 = `test/v0102-manage-project-column.test.mjs`）。

// ---------------------------------------------------------------------------
// ② 拖拽脚本入口守卫仍只认 #schedule-board；区块体内零拖拽落点
// ---------------------------------------------------------------------------

test("B4-② 拖拽脚本零改动：入口守卫仍只认 #schedule-board，不扩 pv-block", () => {
  assert.match(DRAG_SCHEDULE_SCRIPT, /getElementById\("schedule-board"\)/, "既有锚（n3-regression-anchors N3-⑥c）");
  assert.doesNotMatch(DRAG_SCHEDULE_SCRIPT, /pv-block|project|Project/, "守卫不因本区块扩识别面（区块不是看板的一部分）");
});

test("B4-②b（★v0.10.2 改判）看板侧拖拽落点照常；原「区块体内零拖拽落点 / 把手」随区块退役", async () => {
  await withServer(LIVE_FETCHER(), async (base) => {
    const html = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
    // 原「区块体内不得出现 data-version / draggable / kcol / kcard」四条的判据主语 = 已摘除的区块体 ⇒ 退役；
    // 存续的守门语义 = 摘块**不动**排期列渲染（看板侧落点照旧在位）。
    assert.match(html, /data-version="v1\.0\.0"/, "看板侧落点照常（摘块不动排期列渲染）");
    assert.doesNotMatch(html, /pv-block|pvbadge/, "排期页无区块残留（详见 n3 N3-⑩ 四件闭集钉）");
  });
});

// ---------------------------------------------------------------------------
// ③ 三枚 tab 闭集未变
// ---------------------------------------------------------------------------

test("B4-③ 空间 tab 仍是闭集三枚（排期 / 任务 / 管理），接线与摘块均不扩 tab、不改当前项", async () => {
  await withServer(LIVE_FETCHER(), async (base) => {
    const html = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
    const row = html.match(/<div class="b-tabs">[\s\S]*?<\/div>/);
    assert.ok(row !== null, "空间导航行必须在位");
    const links = row[0].match(/<a class="fl[^"]*"[^>]*>[^<]*<\/a>/g) ?? [];
    assert.deepEqual(links.map((s) => s.replace(/<[^>]+>/g, "")), ["排期", "任务", "管理"], "tab 闭集三枚，不随区块扩");
    assert.equal((row[0].match(/class="fl on"/g) ?? []).length, 1, "当前项仍唯一 = 排期");
    assert.match(row[0], /<a class="fl on" href="\/org\/alpha\/schedule" style="font-weight:700">排期<\/a>/);
  });
});

test("B4-③b 门户 `/` 不喂 project 版本面（C-7 门户摘要不扩 project）", async () => {
  await withServer(LIVE_FETCHER(), async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    // 原「PV_OPEN 恰零处」的元素级判据换写成四件闭集全缺（常量已随 pvRange() 撤）；
    // `test/org-portal.test.mjs` 的既有元素级负向锚存续，两处不互替（一为闭集、一为元素锚）。
    for (const needle of ["pv-block", "pvbadge", "各 project 版本", "project_versions_"]) {
      assert.ok(!html.includes(needle), `门户不得出现「${needle}」（project 版本面不挂门户）`);
    }
  });
});

// ---------------------------------------------------------------------------
// ④ 既有排期渲染与上游读取次数不受接线影响
// ---------------------------------------------------------------------------

test("B4-④ Group 面照常：版本列 / 已发版锁 / 需求池与 project 档在场互不牵连；absent 档根因码不落排期页", async () => {
  await withServer(LIVE_FETCHER(), async (base) => {
    const html = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
    assert.match(html, /<h3>v1\.0\.0/, "Group 版本列照常");
    assert.match(html, /🔒 已发版/, "Group 已发版锁照常（project 在场不改锁判定）");
    assert.match(html, /<h3>需求池/, "需求池列照常");
  });
  const absent = engineProjectionWithProjectAbsentFetcher([{ org: ORG, version: "v1.0.0", status: "released" }]);
  await withServer(absent, async (base) => {
    const html = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
    // 原「absent 档降级条带根因码，只落在区块体内」⇒ ★v0.10.2 改判：区块已摘，排期页**整页**不出根因码；
    // 根因码的唯一合法落点 = 管理页「配置核对」卡第三行（正向锚 = v0102-config-check-third-row + n3 N3-⑩b 对照段）。
    assert.doesNotMatch(html, /project_versions_/, "absent 档根因码不落排期页（降级条随区块摘除改道管理页）");
    assert.match(html, /🔒 已发版/, "project 降级不外溢成 Group 面停摆");
  });
});

// ---------------------------------------------------------------------------
// ★v0.10.2 落点③ · 原 B4-④b 退役（语义由管理页锚承接，非净丢失）
// ---------------------------------------------------------------------------
// 原 B4-④b：「接线零新增上游读取、零新增内联脚本 —— 一次渲染仍只打一次 `/api/versions`；区块体内零脚本」。
// **语义由管理页「恰一次 `/api/versions`」锚承接**（改造文档 §2.3 B-2，两处交叉注明）：
//   · 管理页侧 = N4 `manage-read-and-origin-anchors` 新增的「一次渲染 = 恰一次 `/api/versions`」读数锚；
//   · 排期页侧 = `test/v0101-server-projection-two-tier.test.mjs` 的 **B2-④**（同判据存续，未随本档退役）；
//   · 「零新增内联脚本」= `test/n3-regression-anchors.test.mjs` 的 **N3-⑪**（全站八元闭集锚）。
// 区块体内脚本判据的主语已不存在 ⇒ 一并退役，守门语义由上述三处吸收。
