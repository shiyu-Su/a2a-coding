/**
 * REQ-2026-10-09-01 · v0.10.1 · board **B4** —— project 版本区块**接线**进组织空间排期页。
 *
 * 判据（改造文档 §2 C-18① / §3 board 段「容器落在 `#schedule-board` 之外」）：
 * ① 排期页 HTML 里 project 区块**不在** `#schedule-board` 容器内（**结构断言** = 按 div 嵌套深度
 *    摘出看板区间，三档（live / empty / absent）各自都不含本区块）；
 * ② 拖拽脚本入口守卫仍**只认** `#schedule-board`（常量零改动）+ 区块体内**不带任何拖拽落点/把手**
 *    （`data-version` / `draggable` / `kcol` 三者皆无 ⇒ 即便脚本扩了守卫也碰不到本区）；
 * ③ 空间三枚 tab 闭集未变（`排期 / 任务 / 管理`，区块接线不扩 tab、不改 `OrgSpaceView`）；
 * ④ 接线不改既有排期列渲染：版本列 / 已发版锁样式照常，一次渲染仍**只打一次**上游，
 *    区块**零新增内联脚本**（内联七元闭集不动，见 `n3-regression-anchors` N3-⑦）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";
import { DRAG_SCHEDULE_SCRIPT } from "../dist/web/layout.js";
import {
  engineProjectEmptyField,
  engineProjectionFetcher,
  engineProjectionWithProjectAbsentFetcher,
  engineProjectionWithProjectsFetcher,
} from "./engine-versions-fixture.mjs";

const ORG = "alpha";
const BOARD_OPEN = '<div class="kanban" id="schedule-board">';
const PV_OPEN = '<div class="b-card pv-block">';

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

/**
 * **结构**摘取看板区间：从 `#schedule-board` 开标签起按 `<div>` / `</div>` 深度扫描到自身闭合。
 * 用深度扫描而非「切到下一个 `<dialog`」，是因为区块一旦落在看板与 dialog 之间就会被后者掩盖 ⇒
 * 「区块不在看板内」这条判据必须靠闭合位置来判。
 */
function kanbanRange(html) {
  const start = html.indexOf(BOARD_OPEN);
  assert.notEqual(start, -1, "排期页必须存在 #schedule-board 容器");
  const tag = /<div\b[^>]*>|<\/div>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(html); m !== null; m = tag.exec(html)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return { start, end: tag.lastIndex };
  }
  return assert.fail("看板容器未闭合 ⇒ 结构断言失效");
}

/** 摘取 project 区块区间（开标签到其闭合 `</div>`；区块体内无嵌套 div）。 */
function pvRange(html) {
  const start = html.indexOf(PV_OPEN);
  assert.notEqual(start, -1, "排期页必须渲出 project 版本区块（B4 接线点）");
  const end = html.indexOf("</div>", start);
  assert.notEqual(end, -1, "区块必须闭合");
  return { start, end: end + "</div>".length };
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
// ① 结构：区块不在 #schedule-board 内（三档各自判）
// ---------------------------------------------------------------------------

for (const [label, fetcher] of [
  ["live", engineProjectionWithProjectsFetcher([], [])],
  ["empty", engineProjectionFetcher([], "", engineProjectEmptyField())],
  ["absent", engineProjectionWithProjectAbsentFetcher([])],
]) {
  test(`B4-①（${label} 档）区块与 #schedule-board 是**同级 section**：看板闭合之后才出现，看板区间内不含区块`, async () => {
    await withServer(typeof fetcher === "function" ? fetcher() : fetcher, async (base) => {
      const html = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
      const board = kanbanRange(html);
      const pv = pvRange(html);
      assert.ok(pv.start > board.end, "区块起点必须在看板闭合之后（嵌进看板 = 拖拽脚本会误触 POST）");
      assert.ok(!html.slice(board.start, board.end).includes("pv-block"), "看板区间内不得出现区块标记");
      assert.ok(!html.slice(board.start, board.end).includes("各 project 版本"), "看板区间内不得出现区块标题");
    });
  });
}

test("B4-①b live 档：区块逐行喂入排期页并按本组切片（他组织行不现形）", async () => {
  await withServer(LIVE_FETCHER(), async (base) => {
    const html = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
    const pv = pvRange(html);
    const block = html.slice(pv.start, pv.end);
    assert.match(block, />board</, "本组 project 行照渲");
    assert.match(block, />orch</);
    assert.doesNotMatch(block, />other</, "他组织的 project 行不进本空间（org 切片单点）");
    assert.doesNotMatch(block, /v9\.9\.9/, "他组织同版号不染色到本区块");
    assert.match(block, /<span class="pvbadge treleased"/, "project 级 released 只显样式");
    assert.match(block, /<span class="pvbadge tu"/, "releasable 缺键 ⇒ — 档（未知 ≠ 假否定）");
  });
});

// ---------------------------------------------------------------------------
// ② 拖拽脚本入口守卫仍只认 #schedule-board；区块体内零拖拽落点
// ---------------------------------------------------------------------------

test("B4-② 拖拽脚本零改动：入口守卫仍只认 #schedule-board，不扩 pv-block", () => {
  assert.match(DRAG_SCHEDULE_SCRIPT, /getElementById\("schedule-board"\)/, "既有锚（n3-regression-anchors N3-⑥c）");
  assert.doesNotMatch(DRAG_SCHEDULE_SCRIPT, /pv-block|project|Project/, "守卫不因本区块扩识别面（区块不是看板的一部分）");
});

test("B4-②b 区块体内不带任何拖拽落点 / 把手（data-version · draggable · kcol 三者皆无）", async () => {
  await withServer(LIVE_FETCHER(), async (base) => {
    const html = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
    const pv = pvRange(html);
    const block = html.slice(pv.start, pv.end);
    for (const marker of ["data-version", "draggable", "kcol", "kcard"]) {
      assert.ok(!block.includes(marker), `区块体内不得出现 ${marker}（拖拽落点/把手 = 看板专属）`);
    }
    const board = html.slice(kanbanRange(html).start, kanbanRange(html).end);
    assert.match(board, /data-version="v1\.0\.0"/, "看板侧落点照常（本节点不动排期列渲染）");
  });
});

// ---------------------------------------------------------------------------
// ③ 三枚 tab 闭集未变
// ---------------------------------------------------------------------------

test("B4-③ 空间 tab 仍是闭集三枚（排期 / 任务 / 管理），区块接线不扩 tab、不改当前项", async () => {
  await withServer(LIVE_FETCHER(), async (base) => {
    const html = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
    const row = html.match(/<div class="b-tabs">[\s\S]*?<\/div>/);
    assert.ok(row !== null, "空间导航行必须在位");
    const links = row[0].match(/<a class="fl[^"]*"[^>]*>[^<]*<\/a>/g) ?? [];
    assert.deepEqual(links.map((s) => s.replace(/<[^>]+>/g, "")), ["排期", "任务", "管理"], "tab 闭集三枚，不随区块扩");
    assert.equal((row[0].match(/class="fl on"/g) ?? []).length, 1, "当前项仍唯一 = 排期");
    assert.match(row[0], /<a class="fl on" href="\/org\/alpha\/schedule" style="font-weight:700">排期<\/a>/);
    pvRange(html);
  });
});

test("B4-③b 门户 `/` 不喂区块（C-7 门户摘要不扩 project）", async () => {
  await withServer(LIVE_FETCHER(), async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.equal(html.indexOf(PV_OPEN), -1, "区块只随组织空间排期页出（门户不接）");
    assert.doesNotMatch(html, /各 project 版本/);
  });
});

// ---------------------------------------------------------------------------
// ④ 既有排期渲染与上游读取次数不受接线影响
// ---------------------------------------------------------------------------

test("B4-④ Group 面照常：版本列 / 已发版锁样式与区块在场互不牵连；absent 档仍出降级条带根因码", async () => {
  await withServer(LIVE_FETCHER(), async (base) => {
    const html = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
    assert.match(html, /<h3>v1\.0\.0/, "Group 版本列照常");
    assert.match(html, /🔒 已发版/, "Group 已发版锁照常（project 在场不改锁判定）");
    assert.match(html, /<h3>需求池/, "需求池列照常");
  });
  const absent = engineProjectionWithProjectAbsentFetcher([{ org: ORG, version: "v1.0.0", status: "released" }]);
  await withServer(absent, async (base) => {
    const html = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
    const block = html.slice(pvRange(html).start, pvRange(html).end);
    assert.match(block, /project_versions_field_missing/, "absent 档的降级条带根因码，只落在区块体内");
    assert.match(html, /🔒 已发版/, "project 降级不外溢成 Group 面停摆");
  });
});

test("B4-④b 接线零新增上游读取、零新增内联脚本（一次渲染仍只打一次 /api/versions；内联闭集仍七元）", async () => {
  const fetcher = LIVE_FETCHER();
  await withServer(fetcher, async (base) => {
    const before = fetcher.calls;
    const html = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
    assert.equal(fetcher.calls, before + 1, "区块共用 Group 那次投影，不另打一枪");
    const block = html.slice(pvRange(html).start, pvRange(html).end);
    assert.ok(!block.includes("<script"), "区块体内零脚本（纯 SSR）");
  });
});
