/**
 * REQ-2026-10-09-01 · v0.10.1 · board **B2** —— 投影消费**两档分立**（server 侧）。
 *
 * 判据（改造文档 §2 C-7 / C-12 / §3 board 段）：
 * ① `projectVersions[]` 缺位（老引擎 / 未上线）⇒ **Group 面零影响**（版本列 / 已发版锁 / 门户摘要 /
 *    写门照旧）+ project 档出**降级条带根因码**；
 * ② `projectVersions[]` 在场 ⇒ project 档正常（`live` / `empty` **都不出**降级条 —— `empty` 是合法事实）；
 * ③ **排期写门不因 project 降级被挡**（与 Group 面 503 `board_version_projection_unavailable` **分档**）；
 * ④ 一次渲染仍**只打一次** `/api/versions`（project 档共用同一在途结果，不新增上游请求）。
 *
 * 硬约束核对：Group 面消费点（`versionProjectionLedgerOf` / `projectionVersionNames` /
 * `portalSummaryLedgerOf` / 启动日志）**语义零改动** —— 本文件只断言「project 档不牵连它们」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer, projectVersionTierOf, projectVersionDegradationText } from "../dist/server.js";
import { parseEngineVersions } from "../dist/bridge-client.js";
import { projectionVersionNames } from "../dist/web/views.js";
import {
  engineProjectAbsentField,
  engineProjectEmptyField,
  engineProjectLiveField,
  engineProjectionAbsentFetcher,
  engineProjectionFetcher,
  engineProjectionWithProjectAbsentFetcher,
  engineProjectionWithProjectsFetcher,
} from "./engine-versions-fixture.mjs";

const NOW = "2026-10-09T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const ORG = "alpha";

/** 夹具读取器（或已构造好的 outcome）→ 投影；非 projection 档直接失败。 */
async function projectionOf(source) {
  const outcome = await (typeof source === "function" ? source() : source);
  assert.equal(outcome.kind, "projection", "本组用例只喂 Group 在场的投影");
  return outcome.projection;
}

/** 原始信封 → 投影（走真实解析层，钉「消费侧拿到的是解析后的形状」）。 */
async function parsedProjection(envelopeJson) {
  return projectionOf(parseEngineVersions(envelopeJson, NOW));
}

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
    decisions: null,
    createdAt: "c",
    updatedAt: "u",
    ...overrides,
  };
}

/** 只读面假客户端（排期页 / 门户 + 排期写前置 getFeature）。 */
function fakeClient(over = {}) {
  const featureRec = {
    featureId: "F1",
    state: "executing",
    title: "需求甲",
    ownerGroup: ORG,
    stage: "需求分析",
    version: "v0.9.1",
    approval: "未发起",
    decisions: null,
    createdAt: "c",
    updatedAt: "u",
    ...over,
  };
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features: [feature("F1", over.version ?? "v0.9.1")], stateCounts: null };
    },
    async getFeature(featureId) {
      return { feature: { ...featureRec, featureId }, tasks: [], acceptance: null };
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

/** 假排期封装：记录实收调用（写门放行与否的凭据）。 */
function fakeSchedule() {
  const seen = [];
  const fn = async (input) => {
    seen.push(input);
    return { ok: true, featureId: input.featureId, state: input.to, version: input.version };
  };
  return { fn, seen };
}

async function withServer(run, serverOptions = {}, client = fakeClient()) {
  const dir = mkdtempSync(join(tmpdir(), "board-b2-"));
  const ledgerFile = join(dir, "versions.json");
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, versions: [] }, null, 2) + "\n", "utf8");
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW_MS,
    versionsLedgerFile: ledgerFile,
    ...serverOptions,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ① project 缺位 ⇒ Group 面零影响 + project 档出降级条（带根因码）
// ---------------------------------------------------------------------------

test("B2-① 解析层 project 缺位：project 档 = absent 带根因码，Group entries / 版本列零影响", async () => {
  const p = await parsedProjection({ ok: true, versions: [{ owner_group: ORG, version: "v1.0.0", status: "released" }] });
  const field = projectVersionTierOf(p);
  assert.equal(field.status, "absent", "老引擎信封（无 projectVersions[]）⇒ absent");
  assert.equal(field.code, "project_versions_field_missing", "降级条须带根因码");
  // Group 面零影响：entries 与版号列并集与「带 project 档」的信封逐字节同值
  const withProjects = await parsedProjection({
    ok: true,
    versions: [{ owner_group: ORG, version: "v1.0.0", status: "released" }],
    projectVersions: [{ project_id: "board", version: "v1.0.0" }],
  });
  assert.deepEqual(p.entries, withProjects.entries, "Group entries 不因 project 档在场/缺位而变");
  assert.deepEqual(projectionVersionNames(p, ORG), projectionVersionNames(withProjects, ORG), "版本列并集不受 project 档影响");
});

test("B2-①b 降级条文案：absent ⇒ 一行含根因码；live / empty ⇒ 无降级条（empty 是合法事实）", async () => {
  const text = projectVersionDegradationText(projectVersionTierOf(await parsedProjection({ ok: true, versions: [] })));
  assert.ok(text !== null, "老引擎档必须出降级条");
  assert.match(text, /project_versions_field_missing/, "文案带根因码");
  assert.match(text, /不影响 Group 面/, "文案如实点出「不外溢」");
  assert.match(text, /不挡排期写/);

  assert.equal(projectVersionDegradationText(engineProjectEmptyField()), null, "empty ≠ 降级（零条目是合法事实）");
  assert.equal(projectVersionDegradationText(engineProjectLiveField([{ org: ORG, projectId: "board", version: "v1.0.0" }])), null);
  const custom = engineProjectAbsentField("project_versions_field_invalid", "假形状：非数组");
  assert.match(projectVersionDegradationText(custom) ?? "", /project_versions_field_invalid/, "降级条透传解析层的根因码，不另立一套");
  assert.match(projectVersionDegradationText(custom) ?? "", /假形状：非数组/, "根因文案一并透传");
});

test("B2-①c Group 投影从未读到过 ⇒ project 档合成 absent（独立根因码，不冒充「面未上线」）", () => {
  const field = projectVersionTierOf(null);
  assert.equal(field.status, "absent");
  assert.equal(field.code, "project_versions_group_projection_unreadable", "「整面读不到」与「老引擎不带字段」两档不得混一");
  assert.match(projectVersionDegradationText(field) ?? "", /project_versions_group_projection_unreadable/);
});

// ---------------------------------------------------------------------------
// ② project 在场 ⇒ 正常
// ---------------------------------------------------------------------------

test("B2-② project 在场：live 条目原样可读、不出降级条；形状不合法 ⇒ absent + invalid 码", async () => {
  const live = await projectionOf(
    engineProjectionWithProjectsFetcher([{ org: ORG, version: "v1.0.0", status: "active" }], [
      { org: ORG, projectId: "board", version: "v1.0.0", status: "open", releasable: true },
      { org: ORG, projectId: "orch", version: "v1.0.0", status: "released", releasable: false },
    ]),
  );
  const field = projectVersionTierOf(live);
  assert.equal(field.status, "live");
  assert.deepEqual(field.entries.map((e) => [e.projectId, e.version, e.status, e.releasable]), [
    ["board", "v1.0.0", "open", true],
    ["orch", "v1.0.0", "released", false],
  ]);
  assert.equal(projectVersionDegradationText(field), null, "在场 ⇒ 无降级条");

  const invalid = await parsedProjection({ ok: true, versions: [], projectVersions: "不是数组" });
  const invalidField = projectVersionTierOf(invalid);
  assert.equal(invalidField.status, "absent");
  assert.equal(invalidField.code, "project_versions_field_invalid");

  const empty = await projectionOf(
    engineProjectionFetcher([{ org: ORG, version: "v1.0.0", status: "active" }], "", engineProjectEmptyField()),
  );
  assert.equal(projectVersionTierOf(empty).status, "empty", "字段在场零条目 ⇒ empty（与 absent 可区分）");
  assert.equal(projectVersionDegradationText(projectVersionTierOf(empty)), null);
});

// ---------------------------------------------------------------------------
// ③ 排期写门不因 project 降级被挡（与 Group 面 503 分档）
// ---------------------------------------------------------------------------

const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded", "x-board-write": "1", accept: "application/json" };

async function schedulePost(base, body) {
  return fetch(`${base}/features/F1/schedule`, {
    method: "POST",
    redirect: "manual",
    headers: FORM_HEADERS,
    body,
  });
}

test("B2-③（核心）Group 在场 ∧ project 未上线 ⇒ 排期写正常放行（绝不因 project 降级 503）", async () => {
  const { fn, seen } = fakeSchedule();
  const fetcher = engineProjectionWithProjectAbsentFetcher([{ org: ORG, version: "v9.9.9", status: "released" }]);
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.2");
      assert.notEqual(res.status, 503, "project 档降级不得外溢成排期写停摆（C-12 两档分立）");
      assert.equal(res.status, 200);
      const json = JSON.parse(await res.text());
      assert.equal(json.ok, true);
    },
    { scheduleFeatureImpl: fn, engineVersionsFetcher: fetcher, defaultGroup: ORG },
  );
  assert.deepEqual(seen.map((s) => s.version), ["v0.9.2"], "写口照常触达排期封装");
});

test("B2-③b 同档下 Group 锁仍执法：目标 ∈ released ⇒ 409（project 缺位不放松任何锁）", async () => {
  const { fn, seen } = fakeSchedule();
  const fetcher = engineProjectionWithProjectAbsentFetcher([{ org: ORG, version: "v9.9.9", status: "released" }]);
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v9.9.9");
      assert.equal(res.status, 409);
      const json = JSON.parse(await res.text());
      assert.equal(json.code, "board_version_released");
    },
    { scheduleFeatureImpl: fn, engineVersionsFetcher: fetcher, defaultGroup: ORG },
    fakeClient({ version: "v0.9.1" }),
  );
  assert.deepEqual(seen, [], "锁判定前置于出网，project 档在场与否不改此判据");
});

test("B2-③c 分档核对：Group 读不到 ⇒ 写口 503 board_version_projection_unavailable（project 档不参与此判据）", async () => {
  const { fn, seen } = fakeSchedule();
  await withServer(
    async (base) => {
      const res = await schedulePost(base, "version=v0.9.2");
      assert.equal(res.status, 503);
      const json = JSON.parse(await res.text());
      assert.equal(json.code, "board_version_projection_unavailable");
    },
    { scheduleFeatureImpl: fn, engineVersionsFetcher: engineProjectionAbsentFetcher(), defaultGroup: ORG },
    fakeClient({ version: "v0.9.1" }),
  );
  assert.deepEqual(seen, [], "fail-closed 零出网");
});

// ---------------------------------------------------------------------------
// ④ 一次渲染只打一次上游
// ---------------------------------------------------------------------------

test("B2-④ 一次渲染只打一次 /api/versions：project 档共用 Group 的在途结果，不新增上游请求", async () => {
  const fetcher = engineProjectionWithProjectsFetcher([{ org: ORG, version: "v1.0.0", status: "active" }], [
    { org: ORG, projectId: "board", version: "v1.0.0", status: "open" },
  ]);
  // 负向钉：project 档取数是**纯函数**（入参 = Group 已取的投影），逐次调用**一律不再打上游**
  // —— 防后人把它改成「自己 fetch 一次」而破「一次渲染只打一次」。
  const p = await projectionOf(fetcher);
  const afterFirst = fetcher.calls;
  projectVersionTierOf(p);
  projectVersionTierOf(p);
  projectVersionDegradationText(projectVersionTierOf(p));
  assert.equal(fetcher.calls, afterFirst, "project 档消费不新增上游读取");

  await withServer(
    async (base) => {
      const before = fetcher.calls;
      const html = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
      assert.equal(fetcher.calls, before + 1, "排期页一次渲染 = 一次上游读取（版本列 + 锁 + project 档共用）");
      assert.match(html, /<h3>v1\.0\.0/, "Group 版本列照常现形（project 档在场不影响列并集）");
      assert.doesNotMatch(html, /project_versions_/, "读面不裸吐根因码（★v0.10.2 落点③ 摘块后本锚升为**整页**范围 —— 根因码唯一合法落点 = 管理页「配置核对」卡第三行）");
    },
    { engineVersionsFetcher: fetcher },
  );
});

test("B2-④b project 缺位档：门户与排期页各自只打一次，Group 面（摘要 / 列 / 锁样式）零变化", async () => {
  const fetcher = engineProjectionWithProjectAbsentFetcher([{ org: ORG, version: "v9.9.9", status: "released" }]);
  await withServer(
    async (base) => {
      const schedule = await (await fetch(`${base}/org/${ORG}/schedule`)).text();
      assert.match(schedule, /🔒 已发版/, "Group 已发版锁样式照常");
      assert.match(schedule, /<h3>v9\.9\.9/, "Group 版本列照常");
      // ★v0.10.2 落点③ 改判：`.pv-block` 区块已摘 ⇒ 原「blockStart 之前 = Group 面」的分档面收窄**作废**，
      // 本锚恢复为**整页**负向钉（与同文件 B2-④ 同范围）。范围仍是「排期页 + 门户」两页 ——
      // 管理页「配置核对」卡第三行**合法**出现该根因码（锚 = v0102-config-check-third-row），故不写成全站。
      assert.doesNotMatch(schedule, /project_versions_/, "project 缺位档：排期页整页不裸吐 project 根因码（区块摘除后无降级条落点）");
      assert.doesNotMatch(schedule, /board_version_projection_unavailable|已发版锁无法判定/, "project 缺位不外溢成排期页停摆文案");

      const portal = await (await fetch(`${base}/`)).text();
      assert.match(portal, /v9\.9\.9/, "门户版本摘要照常读 Group 档");
      assert.doesNotMatch(portal, /project_versions_|版本面降级/, "门户摘要不扩 project（C-7 不做什么）");
      assert.equal(fetcher.calls, 2, "两次渲染 = 两次上游（页内多消费点共用，不各打一枪）");
    },
    { engineVersionsFetcher: fetcher },
  );
});
