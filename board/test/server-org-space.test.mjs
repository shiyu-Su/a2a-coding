/**
 * BD6（v0.9.4 D 档）组织空间 HTTP 面单测 —— 归一层 + 读面路由族 + 写归一：
 * ① 读面族渲染与 ownerGroup 过滤正确性（空间首页=排期 / features / tasks）；
 * ② 深链透传（/org/<名>/features/:id ⇒ 全局详情，不强制 303）；
 * ③ 404（不存在 / 非法段同码）与 410（台账停用）两档（JSON + 表单浮层）；
 * ④ 写归一：POST 剥前缀命中全局写路由；空间档 mismatch 409、禁板级默认回落；
 *    全局写面行为逐字节不变（WRITE_ROUTES 不扩前缀变体的 HTTP 侧锚）；
 * ⑤ BD8 免选表单：action 带前缀 + hidden 值必发必达、免选态回填隐去组织（全局档对照）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";

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

/** 已发版锁夹具（v0.9.4 N3）：锁改读版本台账 ⇒ 预置临时台账文件喂入（`versionsLedgerFile`）。 */
function releasedLedgerFixture(versions) {
  const dir = mkdtempSync(join(tmpdir(), "board-locked-"));
  const file = join(dir, "versions.json");
  const entries = versions.map((raw) => ({
    version: String(raw).trim(),
    status: "released",
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    note: null,
  }));
  writeFileSync(file, JSON.stringify({ version: 1, versions: entries }, null, 2) + "\n", "utf8");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withSpaceServer(envOptions, run, serverOverrides = {}) {
  const env = tmpEnv(envOptions);
  const { client } = fakeClient(envOptions.clientOpts);
  const { releasedVersions, ...overrides } = serverOverrides;
  const seed = releasedVersions === undefined ? null : releasedLedgerFixture(releasedVersions);
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    docs: { repoRoot: env.dir, orgsDir: env.orgsRoot },
    orgsLedgerFile: env.ledgerFile,
    ...overrides,
    ...(seed === null ? {} : { versionsLedgerFile: seed.file }),
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
    assert.match(html, /组织空间 <b>组织甲<\/b>/, "空间导航行");
    assert.match(html, /甲一/, "本组已排期卡");
    assert.match(html, /甲二/, "本组需求池卡");
    assert.doesNotMatch(html, /乙一/, "他组需求不得进空间");
    assert.doesNotMatch(html, /无归属/, "null 归属不进任何空间");
    assert.match(html, /id="new-req-dialog"/, "提需求弹窗照常挂载（BD8 起为免选形态，见 ⑤）");
  });
});

test("BD6-①b（需求列表）：/org/组织甲/features 仅本组两项；点卡 = 全局深链", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${encodeURIComponent("组织甲")}/features`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /需求 · 组织空间/);
    assert.match(html, /F-A1|甲一/);
    assert.doesNotMatch(html, /乙一/);
    assert.match(html, /href="\/features\/F-A1"/, "深链全局详情、不回 303");
  });
});

test("BD6-①c（任务）：/org/组织甲/tasks 选单按快照渲染且 action/链接落空间路径；?project= 直查", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const org = encodeURIComponent("组织甲");
    const pick = await (await fetch(`${base}/org/${org}/tasks`)).text();
    assert.match(pick, /action="\/org\/%E7%BB%84%E7%BB%87%E7%94%B2\/tasks"/, "选单表单落空间路径");
    assert.match(pick, /href="\/org\/%E7%BB%84%E7%BB%87%E7%94%B2\/tasks\?project=proj-jia"/, "选单项落空间路径");
    const one = await fetch(`${base}/org/${org}/tasks?project=proj-jia`);
    assert.equal(one.status, 200);
    assert.match(await one.text(), /任务 · 项目/);
  });
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
    const page = await fetch(`${base}/org/${encodeURIComponent("停用组")}/features`);
    assert.equal(page.status, 410);
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

test("BD8-⑤（空间首页免选表单）：action 带空间前缀 + hidden 值必发；全局看板页（/schedule）表单不受扰", async () => {
  await withSpaceServer({ ...DISK, ...LEDGER }, async (base) => {
    const space = await (await fetch(`${base}/org/${encodeURIComponent("组织甲")}/`)).text();
    assert.match(space, /action="\/org\/%E7%BB%84%E7%BB%87%E7%94%B2\/requirements"/, "无 JS 原生 POST 同路命中归一层");
    assert.match(space, /<input type="hidden" name="group" value="组织甲">/, "hidden 值必须仍发出");
    assert.match(space, /组织 = <b>组织甲<\/b>/, "只读展示");
    assert.doesNotMatch(space, /<input name="group"/, "空间页不出可编辑组织输入");
    assert.doesNotMatch(space, /留空 = 用板级默认/, "空间档不提示板级默认");
    // §9-b：全局提需求弹窗宿主 = `/schedule`（首页已改渲染组织门户，不含该表单）
    const global = await (await fetch(`${base}/schedule`)).text();
    assert.match(global, /<form method="post" action="\/requirements"/, "全局页 action 零改动");
    assert.match(global, /<input name="group"/, "全局页组织字段照旧可编辑");
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
  }, { releasedVersions: ["v9.9"], createRequirementImpl: fn });
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
  }, { releasedVersions: ["v9.9"], defaultGroup: "组织乙", createRequirementImpl: fn });
});
