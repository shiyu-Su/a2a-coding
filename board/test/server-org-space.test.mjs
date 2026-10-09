/**
 * BD6（v0.9.4 D 档）组织空间 HTTP 面单测 —— 归一层 + 读面路由族 + 写归一：
 * ① 读面族渲染与 ownerGroup 过滤正确性（空间首页=排期 / features / tasks）；
 * ② 深链透传（/org/<名>/features/:id ⇒ 全局详情，不强制 303）；
 * ③ 404（不存在 / 非法段同码）与 410（台账停用）两档（JSON + 表单浮层）；
 * ④ 写归一：POST 剥前缀命中全局写路由；空间档 mismatch 409、禁板级默认回落；
 *    全局写面行为逐字节不变（WRITE_ROUTES 不扩前缀变体的 HTTP 侧锚）；
 * ⑤ BD8 免选表单：action 带前缀 + hidden 值必发必达、免选态回填隐去组织（全局档对照）；
 * ⑥ **v0.9.6 B3 版本切片读面**：看板列 / 列头徽标 / 删除 × / 提需求锁名单按组织切片，
 *    详情页排期锁按该卡 `ownerGroup`（null ⇒ 未归属空串桶），全局 `/schedule` 仍为跨组织并集。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";
import { engineProjectionFetcher } from "./engine-versions-fixture.mjs";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const WRITE_HEADERS = { "x-board-write": "1", accept: "application/json" };

const feat = (featureId, ownerGroup, version, title) => ({
  featureId,
  state: "executing",
  title,
  requirement: `${title} 原文`,
  taskCount: 1,
  ownerGroup,
  stage: "改造方案",
  version,
  approval: "已通过",
  parentFeatureId: null,
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
  stateCounts: null,
});

function fakeClient(opts = {}) {
  const features = [
    feat("F-A1", "组织甲", "v1.0", "甲一"),
    feat("F-A2", "组织甲", "", "甲二"),
    feat("F-B1", "组织乙", "v1.0", "乙一"),
    feat("F-N1", null, "v1.0", "无归属"),
  ];
  return {
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        if (opts.throwOnFeatures) throw new Error("桥不可达（用例注入）");
        return { features, stateCounts: null };
      },
      async getFeature(featureId) {
        const hit = features.find((f) => f.featureId === featureId);
        if (!hit) throw new Error(`no such feature ${featureId}`);
        return {
          feature: { ...hit, plan: null, decisions: null, contracts: null },
          tasks: [],
          acceptance: null,
        };
      },
      async getFeatureTrace() {
        throw new Error("trace 不应被本用例触达");
      },
      async getProjects() {
        return {
          source: "fake",
          note: null,
          observedAt: "2026-09-27T00:00:00Z",
          machines: [
            {
              machineId: "m1",
              error: null,
              projects: [
                { projectId: "proj-jia", agentKind: "qoder", a2aPort: 1, status: "ok", endpoint: null, startedAt: null },
                { projectId: "proj-yi", agentKind: "qoder", a2aPort: 2, status: "ok", endpoint: null, startedAt: null },
              ],
            },
          ],
          runners: [],
        };
      },
      async getTasks(projectId) {
        return { projectId, reachable: true, notice: null, tasks: [] };
      },
    },
  };
}

function tmpEnv(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "board-orgspace-"));
  const orgsRoot = join(dir, "orgs");
  mkdirSync(orgsRoot, { recursive: true });
  for (const o of opts.diskOrgs ?? []) mkdirSync(join(orgsRoot, o), { recursive: true });
  const ledgerFile = join(dir, "data", "orgs.json");
  if (opts.ledgerOrgs !== undefined) {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(ledgerFile, JSON.stringify({ version: 1, orgs: opts.ledgerOrgs }), "utf8");
  }
  return { dir, orgsRoot, ledgerFile };
}

/**
 * 版本台账夹具（v0.9.4 N3）：锁改读版本台账 ⇒ 预置临时台账文件喂入（`versionsLedgerFile`）。
 * **v0.9.6 B1/B3**：条目唯一键 = `(org, version)`、schema 2 ⇒ 夹具按记录给 `org`
 * （缺省空串 = 未归属桶，只锁「无归属」那一档），`status` 缺省 `released`。
 * 撞锁/切片的用例按该面的归属档布条目（提需求/空间页 = 路径组织，详情页 = 卡的 ownerGroup）。
 */
function versionsLedgerFixture(records) {
  const dir = mkdtempSync(join(tmpdir(), "board-locked-"));
  const file = join(dir, "versions.json");
  const entries = records.map((r) => ({
    org: r.org ?? "",
    version: String(r.version).trim(),
    status: r.status ?? "released",
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    note: r.note ?? null,
  }));
  writeFileSync(file, JSON.stringify({ version: 2, versions: entries }, null, 2) + "\n", "utf8");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withSpaceServer(envOptions, run, serverOverrides = {}) {
  const env = tmpEnv(envOptions);
  const { client } = fakeClient(envOptions.clientOpts);
  const { releasedVersions, releasedOrg, ledgerRecords, ...overrides } = serverOverrides;
  const seed =
    ledgerRecords !== undefined
      ? versionsLedgerFixture(ledgerRecords)
      : releasedVersions === undefined
        ? null
        : versionsLedgerFixture(releasedVersions.map((raw) => ({ org: releasedOrg ?? "", version: raw })));
  // v0.10.0 B4：已发版锁的数据源 = **引擎版本台账投影** ⇒ 与本地台账夹具同源恒注入
  // （不声明锁版的用例喂空投影：既不打开发机的真实引擎，也不因引擎不可达被 fail-closed 挡写）。
  const projectionFeed =
    ledgerRecords !== undefined ? ledgerRecords : (releasedVersions ?? []).map((raw) => ({ org: releasedOrg ?? "", version: raw }));
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    docs: { repoRoot: env.dir, orgsDir: env.orgsRoot },
    orgsLedgerFile: env.ledgerFile,
    ...overrides,
    ...(seed === null ? {} : { versionsLedgerFile: seed.file }),
    engineVersionsFetcher: overrides.engineVersionsFetcher ?? engineProjectionFetcher(projectionFeed),
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, env);
  } finally {
    await handle.close();
    seed?.cleanup();
  }
}

const DISK = { diskOrgs: ["组织甲", "组织乙", "停用组"] };
const LEDGER = { ledgerOrgs: [{ org: "停用组", disabledAt: "2026-09-27T00:00:00Z" }] };

// ---------------------------------------------------------------------------
// ① 读面族渲染 + 过滤正确性
// ---------------------------------------------------------------------------

test("BD6-①（空间首页）：/org/组织甲/ = 排期看板只含本组卡；他组与无归属不串面", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${encodeURIComponent("组织甲")}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /项目组空间 <b>组织甲<\/b>/, "空间导航行（件1 文案改名「组织」→「项目组」，URL /org/<名> 不动）");
    assert.match(html, /甲一/, "本组已排期卡");
    assert.match(html, /甲二/, "本组需求池卡");
    assert.doesNotMatch(html, /乙一/, "他组需求不得进空间");
    assert.doesNotMatch(html, /无归属/, "null 归属不进任何空间");
    assert.match(html, /id="new-req-dialog"/, "提需求弹窗照常挂载（BD8 起为免选形态，见 ⑤）");
  });
});

test("BD6-①b（F2 退役 · B5b）：GET /org/组织甲/features ⇒ 303 落**同空间排期页**（非门户）；非 GET ⇒ 405", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const org = encodeURIComponent("组织甲");
    const raw = await fetch(`${base}/org/${org}/features`, { redirect: "manual" });
    assert.equal(raw.status, 303, "退役清单读面 ⇒ 303，不留 404 死面");
    assert.equal(raw.headers.get("location"), `/org/${org}/schedule`, "落点 = 同空间排期页（不是组织门户 `/`）");
    await raw.body?.cancel();
    const followed = await fetch(`${base}/org/${org}/features`);
    assert.equal(followed.status, 200);
    const html = await followed.text();
    assert.match(html, /项目组空间 <b>组织甲<\/b>/, "跟随重定向 = 空间排期页导航行");
    assert.match(html, /甲一/, "本组卡在排期看板照常可见");
    assert.doesNotMatch(html, /需求 · 组织空间/, "旧需求清单页整枚退役（标题不再出任何面）");
    const post = await fetch(`${base}/org/${org}/features`, { method: "POST", body: "" });
    assert.equal(post.status, 405, "退役形态非 GET ⇒ 复用读面族 405（不当写面放行）");
    assert.match(await post.text(), /仅支持 GET/);
  });
});

test("BD6-①c（任务 · C2 真过滤）：/org/组织甲/tasks 项目清单 = 声明面交集（本组项目出现、他组不出现）；?project= 直查", async () => {
  await withSpaceServer(
    { ...DISK, ...LEDGER },
    async (base) => {
      const org = encodeURIComponent("组织甲");
      const pick = await (await fetch(`${base}/org/${org}/tasks`)).text();
      assert.match(pick, /action="\/org\/%E7%BB%84%E7%BB%87%E7%94%B2\/tasks"/, "选单表单落空间路径");
      assert.match(pick, /href="\/org\/%E7%BB%84%E7%BB%87%E7%94%B2\/tasks\?project=proj-jia"/, "本组声明项目进清单");
      assert.doesNotMatch(
        pick,
        /proj-yi/,
        "C2 真过滤：他组项目（组织乙声明）不得进本空间清单（旧版全量假过滤的缺陷消除）",
      );
      const one = await fetch(`${base}/org/${org}/tasks?project=proj-jia`);
      assert.equal(one.status, 200);
      assert.match(await one.text(), /任务 · 项目/);
    },
    // C2：注入声明面 GET /api/groups（组结构事实源），不触运行态 a2a_projects
    {
      orgGroupsFetcher: async () => ({
        ok: true,
        groups: [
          { name: "组织甲", memberCount: 1, members: [{ machineId: "m1", projectId: "proj-jia" }] },
          { name: "组织乙", memberCount: 1, members: [{ machineId: "m1", projectId: "proj-yi" }] },
        ],
        warnings: [],
        observedAt: null,
      }),
    },
  );
});

// ---------------------------------------------------------------------------
// ② 深链透传 + 空间外子路径 404
// ---------------------------------------------------------------------------

test("BD6-②（深链）：/org/组织甲/features/F-B1 透传全局详情（深链全局唯一，不强制组织一致）", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${encodeURIComponent("组织甲")}/features/F-B1`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /需求 详情|乙一|引擎态/);
  });
});

test("BD6-②b（空间外子路径）：/org/组织甲/projects ⇒ 404 not_found（空间无归一语义的路径不放行）", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${encodeURIComponent("组织甲")}/projects`, { headers: { accept: "application/json" } });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "not_found");
  });
});

// ---------------------------------------------------------------------------
// ③ 404 / 410 两档
// ---------------------------------------------------------------------------

test("BD6-③（404）：盘/台账/归属/默认皆未命中的组织 ⇒ board_org_space_not_found；表单档整页浮层同码", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const json = await fetch(`${base}/org/ghost-team/`, { headers: { accept: "application/json" } });
    assert.equal(json.status, 404);
    assert.equal((await json.json()).code, "board_org_space_not_found");
    const page = await fetch(`${base}/org/ghost-team/`);
    assert.equal(page.status, 404);
    assert.match(await page.text(), /组织空间不存在/, "错误族名（表单档浮层）");
    // 非法段与不存在同档（不给枚举留信号面）
    const bad = await fetch(`${base}/org/bad%20name/`, { headers: { accept: "application/json" } });
    assert.equal(bad.status, 404);
    assert.equal((await bad.json()).code, "board_org_space_not_found");
  });
});

test("BD6-③b（410）：台账停用组织 ⇒ board_org_space_gone（盘目录仍在也不开放空间）", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const json = await fetch(`${base}/org/${encodeURIComponent("停用组")}/`, { headers: { accept: "application/json" } });
    assert.equal(json.status, 410);
    assert.equal((await json.json()).code, "board_org_space_gone");
    const page = await fetch(`${base}/org/${encodeURIComponent("停用组")}/schedule`);
    assert.equal(page.status, 410, "停用判定先于路径归类 ⇒ 换用在途面取样（features 已退役，不再充当样本）");
    assert.match(await page.text(), /组织空间已关闭/);
  });
});

test("§9.4-④（410 出口）：停用空间的错误页带「回门户」链接（浮层卡 + 页面各一处；JSON 档形状不变）", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const page = await fetch(`${base}/org/${encodeURIComponent("停用组")}/manage`);
    assert.equal(page.status, 410);
    const html = await page.text();
    assert.match(html, /<p class="hint"><a class="fl" href="\/">回组织门户<\/a><\/p>/, "关闭浮层后页面仍留出路");
    assert.match(html, /<p class="err-ov-link"><a href="\/">回组织门户<\/a><\/p>/, "浮层卡内同挂出路链接");
    const json = await fetch(`${base}/org/${encodeURIComponent("停用组")}/`, { headers: { accept: "application/json" } });
    assert.equal(json.status, 410);
    assert.deepEqual(Object.keys(await json.json()).sort(), ["code", "error", "ok"], "JSON 档形状不变（不承载 link）");
  });
});

test("BD6-③c（fail-closed）：universe 读不到需求归属 ⇒ 502 bridge_unreachable（不默认放行也不默认 404）", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER, clientOpts: { throwOnFeatures: true } }, async (base) => {
    const res = await fetch(`${base}/org/组织甲/`, { headers: { accept: "application/json" } });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, "bridge_unreachable");
  });
});

// ---------------------------------------------------------------------------
// ④ 写归一 + mismatch 执法 + 全局写面零改动锚
// ---------------------------------------------------------------------------

function fakeCreate() {
  const seen = [];
  const fn = async (input, options) => {
    seen.push({ input, options });
    return {
      ok: true,
      featureId: "F-NEW",
      state: "waiting_approval",
      stage: "需求分析",
      version: input.version,
      approval: "未发起",
    };
  };
  return { fn, seen };
}

test("BD6-④（写归一 + 执法）：POST /org/组织甲/requirements 剥前缀命中全局写路由；组织以路径为准", async () => {
  const { fn, seen } = fakeCreate();
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const post = (path, fields) =>
      fetch(`${base}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: WRITE_HEADERS,
        body: new URLSearchParams(fields).toString(),
      });
    // 一致 ⇒ 放行（组身份 = 路径组织）
    const ok = await post(`/org/${encodeURIComponent("组织甲")}/requirements`, { group: "组织甲", title: "空间提需", version: "" });
    assert.equal(ok.status, 201);
    assert.equal((await ok.json()).group, "组织甲");
    assert.equal(seen[0].options.group, "组织甲");
    // 不一致 ⇒ 409 board_org_mismatch（零出网：封装不再 +1）
    const mismatch = await post(`/org/${encodeURIComponent("组织甲")}/requirements`, { group: "组织乙", title: "串组", version: "" });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).code, "board_org_mismatch");
    assert.equal(seen.length, 1, "mismatch 必须零出网");
    // 空间档禁板级默认回落：不填 group（板级默认=组织乙）⇒ 409 mismatch（不落默认组）
    const noGroup = await post(`/org/${encodeURIComponent("组织甲")}/requirements`, { title: "免选前形态", version: "" });
    assert.equal(noGroup.status, 409);
    assert.equal((await noGroup.json()).code, "board_org_mismatch");
    assert.equal(seen.length, 1, "禁回落亦零出网");
  }, { defaultGroup: "组织乙", createRequirementImpl: fn });
});

test("BD6-④b（全局写面零改动）：POST /requirements 无空间上下文 ⇒ 回落链不变（表单 > 板级默认）", async () => {
  const { fn, seen } = fakeCreate();
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/requirements`, {
      method: "POST",
      redirect: "manual",
      headers: WRITE_HEADERS,
      body: new URLSearchParams({ title: "全局提需", version: "" }).toString(),
    });
    assert.equal(res.status, 201);
    assert.equal(seen[0].options.group, "组织乙", "无空间上下文 ⇒ 板级默认照常生效");
  }, { defaultGroup: "组织乙", createRequirementImpl: fn });
});

test("BD6-④c（写档 410）：POST 前缀组织已停用 ⇒ 410 先于 CSRF 之后的入参校验（不进全局写口）", async () => {
  const { fn, seen } = fakeCreate();
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${encodeURIComponent("停用组")}/requirements`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: new URLSearchParams({ group: "停用组", title: "停用组提需", version: "" }).toString(),
    });
    assert.equal(res.status, 410);
    assert.equal((await res.json()).code, "board_org_space_gone");
    assert.equal(seen.length, 0);
  }, { createRequirementImpl: fn });
});

test("BD6-④d（方法门 · 与全局同口径）：已知空间面非 GET ⇒ 405 列全局 WRITE_ROUTES；空间外子路径 ⇒ 404", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const space = `${base}/org/${encodeURIComponent("组织甲")}`;
    for (const path of ["/", "/features", "/tasks"]) {
      const res = await fetch(`${space}${path}`, { method: "PUT" });
      assert.equal(res.status, 405, `PUT ${path} 必须 405（空间读面族 GET-only）`);
      const text = await res.text();
      assert.match(text, /仅支持 GET/);
      assert.match(text, /POST \/requirements/, "405 文案单点 = WRITE_ROUTES");
      assert.doesNotMatch(text, /POST \/org\//, "写路由白名单不扩前缀变体");
    }
    const off = await fetch(`${space}/requirements`, { method: "PUT", headers: { accept: "application/json" } });
    assert.equal(off.status, 404, "空间外子路径（含写路径裸 GET/PUT）= 未知路径，不给 405 信号");
    assert.equal((await off.json()).code, "not_found");
  });
});

// ---------------------------------------------------------------------------
// ⑤ BD8 提需求免选组织（表单面 + hidden 值必达 + 免选态回填隐去）
// ---------------------------------------------------------------------------

const field = (label, value) =>
  new RegExp(
    `<span class="err-ov-field-label">${label}</span>\\s*<span class="err-ov-field-value mono">${value}</span>`,
  );

test("BD8-⑤（空间首页免选表单 · B5a 改版）：action 带空间前缀 + hidden 值必发；全局看板页退役 ⇒ 全局档表单无 HTTP 宿主（逐字节钉在 web.test BD8）", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const space = await (await fetch(`${base}/org/${encodeURIComponent("组织甲")}/`)).text();
    assert.match(space, /action="\/org\/%E7%BB%84%E7%BB%87%E7%94%B2\/requirements"/, "无 JS 原生 POST 同路命中归一层");
    assert.match(space, /<input type="hidden" name="group" value="组织甲">/, "hidden 值必须仍发出");
    assert.match(space, /组织 = <b>组织甲<\/b>/, "只读展示");
    assert.doesNotMatch(space, /<input name="group"/, "空间页不出可编辑组织输入");
    assert.doesNotMatch(space, /留空 = 用板级默认/, "空间档不提示板级默认");
    // B5a：全局 `/schedule` 退役 ⇒ 提需求表单的 HTTP 宿主只剩空间页（303 空体，不出任何表单）
    const global = await fetch(`${base}/schedule`, { redirect: "manual" });
    assert.equal(global.status, 303, "全局看板页退役 ⇒ 303 回门户");
    const globalBody = await global.text();
    assert.doesNotMatch(globalBody, /<form method="post" action="\/requirements"|<input name="group"/, "退役路径不渲染表单");
    const portal = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(portal, /action="\/requirements"/, "门户不再承载提需求弹窗");
  });
});

test("BD8-⑤b（hidden 值必达）：按表单发出的 group 提交 ⇒ 放行且组身份 = 路径组织；JSON 出参 group 回显保留", async () => {
  const { fn, seen } = fakeCreate();
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${encodeURIComponent("组织甲")}/requirements`, {
      method: "POST",
      redirect: "manual",
      headers: WRITE_HEADERS,
      body: new URLSearchParams({ group: "组织甲", title: "免选提交", version: "" }).toString(),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.group, "组织甲", "JSON 出参 group 回显保留（免选态不回显仅指错误浮层）");
    assert.equal(seen[0].options.group, "组织甲");
  }, { defaultGroup: "组织乙", createRequirementImpl: fn });
});

test("BD8-⑤c（免选态回填隐去组织）：空间锁版 409 浮层无「组织」字段、标题/版本回显；表单档同源 Origin 同口径", async () => {
  const { fn, seen } = fakeCreate();
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${encodeURIComponent("组织甲")}/requirements`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ group: "组织甲", title: "锁版免选", version: "v9.9", requirement: "原文" }).toString(),
    });
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.match(text, /board_version_released/);
    assert.doesNotMatch(text, field("组织", "组织甲"), "免选态隐去组织字段（路径决定、非用户提交值）");
    assert.match(text, field("标题", "锁版免选"));
    assert.match(text, field("版本", "v9\\.9"));
    assert.match(text, field("需求描述", "原文"));
    assert.equal(seen.length, 0);
  }, { releasedVersions: ["v9.9"], releasedOrg: "组织甲", createRequirementImpl: fn });
});

test("BD8-⑤d（回填档位对照）：全局档锁版 409 组织字段照常回填；篡改 hidden ⇒ mismatch 409 也不回显组织", async () => {
  const { fn, seen } = fakeCreate();
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const post = (path, fields) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      });
    const globalRes = await post("/requirements", { group: "组织甲", title: "全局锁版", version: "v9.9" });
    assert.equal(globalRes.status, 409);
    assert.match(await globalRes.text(), field("组织", "组织甲"), "全局档回填含组织");
    const tampered = await post(`/org/${encodeURIComponent("组织甲")}/requirements`, { group: "组织乙", title: "篡改", version: "" });
    assert.equal(tampered.status, 409);
    const text = await tampered.text();
    assert.match(text, /board_org_mismatch/);
    assert.doesNotMatch(text, field("组织", "组织乙"), "免选态错误浮层不回显组织字段");
    assert.match(text, field("标题", "篡改"));
    assert.equal(seen.length, 0, "两档拒绝均零出网");
  }, { releasedVersions: ["v9.9"], releasedOrg: "组织甲", defaultGroup: "组织乙", createRequirementImpl: fn });
});

// ---------------------------------------------------------------------------
// ⑥ v0.9.6 B3 版本切片读面（口径 3 / 29：切片归调用方，纯函数签名不动）
// ---------------------------------------------------------------------------

test("B3-⑥a（空间看板列 = 本组织切片）：他组织的台账版本不进本组织列；本组织 released 出 🔒、未开始的空列出 ×", async () => {
  const records = [
    { org: "组织甲", version: "v1.0", status: "released" },
    { org: "组织甲", version: "v3.1", status: "notstart" },
    { org: "组织乙", version: "v2.0", status: "released" },
  ];
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const jia = await (await fetch(`${base}/org/${encodeURIComponent("组织甲")}/schedule`)).text();
    assert.match(jia, /data-version="v1\.0"/, "本组织台账版本成列");
    assert.match(jia, /v1\.0 <span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span>/, "本组织 released ⇒ 🔒 徽标");
    assert.match(jia, /data-version="v3\.1"/, "本组织未登记的空列（台账独有版本）照常成列");
    assert.match(jia, /v3\.1 <span class="kbadge vbadge notstart"[^>]*>未开始<\/span>/, "notstart ⇒ 未开始");
    assert.match(jia, /<input type="hidden" name="version" value="v3\.1">/, "未开始列出删除 ×（B3 后按 (org,version) 取条目）");
    assert.doesNotMatch(jia, /data-version="v2\.0"/, "他组织的台账版本不得进本组织看板列");
    assert.doesNotMatch(jia, /v1\.0 <span class="kbadge vbadge notstart"[^>]*>/, "本组织条目优先于派生");

    const yi = await (await fetch(`${base}/org/${encodeURIComponent("组织乙")}/schedule`)).text();
    assert.match(yi, /data-version="v2\.0"/, "乙组织看本组织的 v2.0 列");
    assert.match(yi, /v2\.0 <span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span>/, "v2.0 的锁只在乙组织档");
    assert.doesNotMatch(yi, /data-version="v3\.1"/, "甲组织的未开始列不进乙空间");
    assert.match(yi, /data-version="v1\.0"/, "乙名下有 v1.0 卡 ⇒ 该列由卡片派生成列");
    assert.doesNotMatch(yi, /v1\.0 <span class="kbadge vbadge locked"[^>]*>/, "甲的 v1.0 released 条目不进乙的徽标档");
  }, { ledgerRecords: records });
});

test("B3-⑥b（同版号互不锁 · 提需求锁名单按组织）：v1.0 只在乙 released ⇒ 甲页无锁、乙页列 v1.0", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const jia = await (await fetch(`${base}/org/${encodeURIComponent("组织甲")}/schedule`)).text();
    assert.doesNotMatch(jia, /<p class="hint warn">已发版版本（版本台账标记/, "甲的 released 切片为空 ⇒ 提需求锁名单整行不渲");
    assert.match(jia, /v1\.0 <span class="kbadge vbadge wip"[^>]*>进行中<\/span>/, "甲的 v1.0 回落卡片阶段派生（台账无 (甲,v1.0) 条目）");

    const yi = await (await fetch(`${base}/org/${encodeURIComponent("组织乙")}/schedule`)).text();
    assert.match(yi, /<p class="hint warn">已发版版本（版本台账标记[\s\S]{0,80}<code>v1\.0<\/code>/, "乙的锁名单列本组织 released 切片");
  }, { ledgerRecords: [{ org: "组织乙", version: "v1.0", status: "released" }] });
});

test("B3-③（详情页排期锁按该卡 ownerGroup）：甲卡锁 · 乙同版号不锁 · 无归属卡只被空串桶条目锁", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const lockHint = /本需求现排期版本 <code>v1\.0<\/code> <b>已发版（🔒 锁定）<\/b>/;
    const jia = await (await fetch(`${base}/features/F-A1`)).text();
    assert.match(jia, lockHint, "卡归属甲 ∧ (甲,v1.0)=released ⇒ 锁");
    const yi = await (await fetch(`${base}/features/F-B1`)).text();
    assert.doesNotMatch(yi, lockHint, "他组织的同版号条目不锁本卡（口径 3 切片归调用方）");
    const none = await (await fetch(`${base}/features/F-N1`)).text();
    assert.doesNotMatch(none, lockHint, "无归属卡落未归属空串桶 ⇒ 甲的条目够不着它");
    // 深链透传同一条详情面：空间前缀不改变锁档
    const viaSpace = await (await fetch(`${base}/org/${encodeURIComponent("组织甲")}/features/F-A1`)).text();
    assert.match(viaSpace, lockHint, "空间深链 = 同一份切片读面");
  }, { ledgerRecords: [{ org: "组织甲", version: "v1.0", status: "released" }] });

  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const lockHint = /本需求现排期版本 <code>v1\.0<\/code> <b>已发版（🔒 锁定）<\/b>/;
    const none = await (await fetch(`${base}/features/F-N1`)).text();
    assert.match(none, lockHint, "未归属桶（org=\"\"）条目只锁无归属卡（与 migrateLedgerOrgs 的空串桶同构）");
    const jia = await (await fetch(`${base}/features/F-A1`)).text();
    assert.doesNotMatch(jia, lockHint, "反向：空串桶条目不锁有归属的卡");
  }, { ledgerRecords: [{ org: "", version: "v1.0", status: "released" }] });
});

test("B3-⑥c（B5a 改版：并集过渡形态随全局页退役）：`GET /schedule` ⇒ 303 无并集读面；跨组织台账条目在**各自空间页**成列成锁", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const global = await fetch(`${base}/schedule`, { redirect: "manual" });
    assert.equal(global.status, 303, "全局页退役 ⇒ 「跨组织并集」读面整枚消失（不留半退役形态）");
    await global.body?.cancel();
    const jia = await (await fetch(`${base}/org/${encodeURIComponent("组织甲")}/schedule`)).text();
    const yi = await (await fetch(`${base}/org/${encodeURIComponent("组织乙")}/schedule`)).text();
    assert.match(jia, /v9\.0 <span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span>/, "甲的 released 在甲空间页出锁");
    assert.doesNotMatch(jia, /data-version="v9\.1"/, "他组织版本不进甲空间（并集已无承载页）");
    assert.match(yi, /v9\.1 <span class="kbadge vbadge locked"[^>]*>🔒 已发版<\/span>/, "乙的 released 在乙空间页出锁");
    assert.doesNotMatch(yi, /data-version="v9\.0"/, "反向同理");
  }, {
    ledgerRecords: [
      { org: "组织甲", version: "v9.0", status: "released" },
      { org: "组织乙", version: "v9.1", status: "released" },
    ],
  });
});
