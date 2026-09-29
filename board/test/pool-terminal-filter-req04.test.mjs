/**
 * REQ-2026-09-29-04 · 需求池隐藏已取消需求 —— 「未排期 ∧ 终态」卡的两面夹具（HTTP 面）。
 *
 * 存在理由：N1 已删除那 5 张探针卡 ⇒ 活数据里不再有「未排期 ∧ 终态」样本，
 * 板页真机机判只能证明「池列计数与可见卡符合预期」，**过滤行为本身**与
 * **组织空间列表仍渲染该类卡（第 6 项负向断言）**必须由夹具承载（改造文档 §4.2）。
 *
 * 两面判据：
 * ① `GET /schedule` 需求池列 = 未排期 ∧ **非**终态（三终态不进池，池头计数同步）；
 * ② 已排期终态卡仍在其版本列显示（过滤只作用于池列）；
 * ③ `GET /org/<名>/features`（`renderOrgSpaceFeaturesList`，不经 `selectRequirementPool`）
 *    仍渲染「未排期 ∧ 终态」卡 —— 该类卡的历史读面不因此次过滤而失联。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const ORG = "alpha";

const feat = (featureId, state, version) => ({
  featureId,
  state,
  title: `需求 ${featureId}`,
  requirement: `${featureId} 原文`,
  taskCount: 1,
  ownerGroup: ORG,
  stage: "改造方案",
  version,
  approval: "已通过",
  parentFeatureId: null,
  createdAt: "2026-09-29T00:00:00Z",
  updatedAt: "2026-09-29T00:00:00Z",
  stateCounts: null,
});

/** 夹具清单：未排期三终态 + 未排期非终态 + 已排期终态 + 已排期非终态。 */
const FIXTURES = [
  feat("P-CANCELLED", "cancelled", ""),
  feat("P-COMPLETED", "completed", ""),
  feat("P-FAILED", "failed", ""),
  feat("P-OPEN", "waiting_approval", ""),
  feat("V-CANCELLED", "cancelled", "v9.9"),
  feat("V-OPEN", "waiting_approval", "v9.9"),
];

function fakeClient() {
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features: FIXTURES, stateCounts: null };
    },
    async getFeature(featureId) {
      const hit = FIXTURES.find((f) => f.featureId === featureId);
      if (!hit) throw new Error(`no such feature ${featureId}`);
      return { feature: { ...hit, plan: null, decisions: null, contracts: null }, tasks: [], acceptance: null };
    },
    async getFeatureTrace() {
      throw new Error("trace 不应被本用例触达");
    },
    async getProjects() {
      return { source: "fake", note: null, observedAt: "2026-09-29T00:00:00Z", machines: [], runners: [] };
    },
    async getTasks(projectId) {
      return { projectId, reachable: true, notice: null, tasks: [] };
    },
  };
}

async function withFixtureServer(run) {
  const dir = mkdtempSync(join(tmpdir(), "board-pool-terminal-"));
  const orgsRoot = join(dir, "orgs");
  mkdirSync(join(orgsRoot, ORG), { recursive: true });
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: fakeClient(),
    now: () => NOW,
    docs: { repoRoot: dir, orgsDir: orgsRoot },
    orgsLedgerFile: join(dir, "data", "orgs.json"),
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 摘出 `/schedule` 池列正文（`data-version=""` 那一列）。 */
function poolColumnOf(html) {
  const kanban = html.slice(html.indexOf('id="schedule-board"'));
  const hit = kanban.match(/<div class="kcol" data-version="">([\s\S]*?)(?=<div class="kcol" data-version=|<dialog)/);
  assert.ok(hit !== null, "池列必须存在（data-version 空串）");
  return hit[1];
}

test("REQ04-① 池列：三终态未排期卡不进池；非终态照入且池头计数 = 可见卡数", async () => {
  await withFixtureServer(async (base) => {
    const html = await (await fetch(`${base}/schedule`)).text();
    const pool = poolColumnOf(html);
    assert.match(pool, /href="\/features\/P-OPEN"/, "未排期非终态卡照入池");
    for (const gone of ["P-CANCELLED", "P-COMPLETED", "P-FAILED"]) {
      assert.ok(!pool.includes(`/features/${gone}`), `${gone} 为终态 ⇒ 不得进池列`);
    }
    assert.match(pool, /<h3>需求池 <span class="muted">\(1\)<\/span>/, "池头计数 = 池内可见卡数（1）");
    assert.doesNotMatch(pool, /<h3>需求池 <span class="muted">\(4\)/, "计数不得按「未排期全量」算（4）");
  });
});

test("REQ04-② 版本列：已排期终态卡照旧显示（过滤只作用于池列）", async () => {
  await withFixtureServer(async (base) => {
    const html = await (await fetch(`${base}/schedule`)).text();
    const versionCols = html.slice(html.indexOf('id="schedule-board"')).split('<div class="kcol" data-version="">')[0];
    assert.match(versionCols, /href="\/features\/V-CANCELLED"/, "已排期 cancelled 卡仍在其版本列");
    assert.match(versionCols, /href="\/features\/V-OPEN"/, "同列非终态卡不受影响");
    assert.match(versionCols, /<span class="kbadge">已取消（cancelled）<\/span>/, "终态徽标照常上卡");
  });
});

test("REQ04-③ 负向断言（第 6 项）：/org/<名>/features 仍渲染「未排期 ∧ 终态」卡（历史读面不失联）", async () => {
  await withFixtureServer(async (base) => {
    const res = await fetch(`${base}/org/${encodeURIComponent(ORG)}/features`);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const kept of ["P-CANCELLED", "P-COMPLETED", "P-FAILED"]) {
      assert.match(html, new RegExp(`href="/features/${kept}"`), `${kept} = 未排期 ∧ 终态 ⇒ 空间列表须仍渲染`);
    }
    assert.match(html, /href="\/features\/P-OPEN"/, "未排期非终态卡同样在空间列表");
    assert.equal(
      ["P-CANCELLED", "P-COMPLETED", "P-FAILED", "P-OPEN", "V-CANCELLED", "V-OPEN"].filter((id) =>
        html.includes(`/features/${id}`),
      ).length,
      6,
      "空间列表 = 本组全量（六张全在，终态不过滤）",
    );
  });
});
