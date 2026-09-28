/**
 * BD7（v0.9.4 D 档）导航组织感知 + 顶栏切换器 —— 单测：
 * ① navHrefFor 纯函数口径（schedule/tasks 空间映射；其余键与无上下文 ⇒ 全局）；
 * ② 空间页 NAV：本空间落点 + active 高亮组织感知，全局四页不动；
 * ③ 顶栏切换器 = 纯 SSR 链接列表（当前组织标 on / 停用名不进清单 / 零新脚本）；
 * ④ 全局页保持旧锚（NAV 全局 href 逐字节不变，仅新增切换器且不标当前组织）；
 * ⑤ 错误出口透传（空间 405 表单页 / 空间深链桥宕页 / mismatch 409 浮层页均带空间导航）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";
import { navHrefFor } from "../dist/web/layout.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const ENC_JIA = "%E7%BB%84%E7%BB%87%E7%94%B2"; // 组织甲
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
    feat("F-B1", "组织乙", "v1.0", "乙一"),
  ];
  return {
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
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
      async getProjects() {
        return { source: "fake", note: null, observedAt: "2026-09-27T00:00:00Z", machines: [], runners: [] };
      },
      async getTasks(projectId) {
        if (opts.throwOnTasks) throw new Error("任务面读取失败（用例注入）");
        return { projectId, reachable: true, notice: null, tasks: [] };
      },
    },
  };
}

function tmpEnv(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "board-bd7nav-"));
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

async function withNavServer(envOptions, run, serverOverrides = {}) {
  const env = tmpEnv(envOptions);
  const { client } = fakeClient(envOptions.clientOpts);
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    docs: { repoRoot: env.dir, orgsDir: env.orgsRoot },
    orgsLedgerFile: env.ledgerFile,
    ...serverOverrides,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

const DISK = { diskOrgs: ["组织甲", "组织乙", "停用组"] };
const LEDGER = { ledgerOrgs: [{ org: "停用组", disabledAt: "2026-09-27T00:00:00Z" }] };

// ---------------------------------------------------------------------------
// ① navHrefFor 纯函数口径
// ---------------------------------------------------------------------------

test("BD7-①（navHrefFor）：仅 schedule/tasks 两键组织感知；其余键与无上下文 ⇒ 全局 href 原样", () => {
  const jia = { org: "组织甲", orgs: ["组织甲"] };
  assert.equal(navHrefFor(jia, "schedule", "/schedule"), `/org/${ENC_JIA}/schedule`);
  assert.equal(navHrefFor(jia, "tasks", "/tasks"), `/org/${ENC_JIA}/tasks`);
  for (const key of ["projects", "agents", "manage", "host"]) {
    // §9-c：「orgs」随 NAV 摘除；「manage」不属全局 NAV 键（空间内链接行直达），二者同样不进空间映射
    assert.equal(navHrefFor(jia, key, `/${key}`), `/${key}`, `${key} 不进空间映射`);
  }
  // 无空间上下文（org null / orgNav undefined）⇒ 一律全局
  assert.equal(navHrefFor({ org: null, orgs: ["组织甲"] }, "schedule", "/schedule"), "/schedule");
  assert.equal(navHrefFor(undefined, "tasks", "/tasks"), "/tasks");
});

// ---------------------------------------------------------------------------
// ② 空间页 NAV（组织感知 + active 高亮）
// ---------------------------------------------------------------------------

test("BD7-②（空间排期页）：排期/任务落本空间且排期高亮；全局四页 href 不动", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const html = await (await fetch(`${base}/org/${ENC_JIA}/`)).text();
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/schedule" class="on">排期</a>`), "空间内高亮 = 空间 href");
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/tasks">任务</a>`));
    assert.match(html, /<a href="\/projects">项目 \/ 机器<\/a>/);
    assert.match(html, /<a href="\/agents">Agent<\/a>/);
    assert.match(html, /<a href="\/host">宿主桥<\/a>/);
    assert.doesNotMatch(html, /<a href="\/orgs">组织<\/a>/, "§9-c：全局 NAV「组织」项摘除（/orgs 页退役）");
    assert.match(html, /<a class="fl" href="\/schedule">← 回全局<\/a>/, "空间行回全局链接保持全局 href");
    // §9-c：空间内导航行增「管理」入口（未高亮 ⇒ 不加粗；管理页本体见 orgs-page N3-①）
    assert.match(html, new RegExp(`<a class="fl" href="/org/${ENC_JIA}/manage">管理</a>`), "空间行含管理入口");
  });
});

test("BD7-②b（空间需求页）：active 仍挂排期 ⇒ 高亮落空间排期 href", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const html = await (await fetch(`${base}/org/${ENC_JIA}/features`)).text();
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/schedule" class="on">排期</a>`));
  });
});

test("BD7-②c（空间任务页）：任务高亮落空间 href；?project= 详情「换项目」回空间选单", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const pick = await (await fetch(`${base}/org/${ENC_JIA}/tasks`)).text();
    assert.match(pick, new RegExp(`<a href="/org/${ENC_JIA}/tasks" class="on">任务</a>`));
    assert.match(pick, new RegExp(`<a href="/org/${ENC_JIA}/schedule">排期</a>`));
  });
});

// ---------------------------------------------------------------------------
// ③ 顶栏切换器（SSR 链接列表 / 当前组织 / 停用隔离 / 零新脚本）
// ---------------------------------------------------------------------------

test("BD7-③（切换器）：空间页含全部在用组织、当前组织标 on；停用名不进清单", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const html = await (await fetch(`${base}/org/${ENC_JIA}/`)).text();
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "当前组织标记");
    assert.match(html, /<a href="\/org\/%E7%BB%84%E7%BB%87%E4%B9%99\/">组织乙<\/a>/);
    assert.doesNotMatch(html, /停用组/, "停用组织不进切换器（点了必 410）");
    assert.match(html, /class="org-switch"/);
  });
});

test("BD7-③b（零新脚本）：空间页 script 数与全局排期页一致（切换器为纯 SSR 链接）", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const spaceHtml = await (await fetch(`${base}/org/${ENC_JIA}/`)).text();
    const globalHtml = await (await fetch(`${base}/schedule`)).text();
    const count = (s) => (s.match(/<script/g) ?? []).length;
    assert.equal(count(spaceHtml), count(globalHtml), "切换器/NAV 不得引入新 <script>");
    assert.doesNotMatch(spaceHtml.slice(spaceHtml.indexOf("org-switch"), spaceHtml.indexOf("org-switch") + 800), /<script/, "切换器块内无脚本");
  });
});

// ---------------------------------------------------------------------------
// ④ 全局页旧锚不动 + 仅增切换器
// ---------------------------------------------------------------------------

test("BD7-④（全局排期页）：NAV 六条全局 href 逐字节旧形态；切换器在场且不标当前组织", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const html = await (await fetch(`${base}/schedule`)).text();
    assert.match(html, /<a href="\/schedule" class="on">排期<\/a>/, "N3-⑤ 全局高亮锚");
    assert.match(html, /<a href="\/tasks">任务<\/a>/);
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/">组织甲</a>`), "全局页切换器不带 class=on（无当前组织）");
    assert.doesNotMatch(html, /class="on">组织甲/, "全局页不得把任何组织标成当前");
  });
});

test("BD7-④b（§9-b 翻向：门户 vs 看板不再逐字节同）：`/` = 组织门户、`/schedule` = 排期看板，NAV 与切换器仍同源", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const home = await (await fetch(`${base}/`)).text();
    const sched = await (await fetch(`${base}/schedule`)).text();
    assert.notEqual(home, sched, "N3-② 旧「逐字节同构」锚随首页形态翻向");
    assert.match(home, /<title>组织门户 · board<\/title>/);
    assert.match(home, /<a href="\/" class="on">首页<\/a>/, "门户高亮首页项");
    assert.match(sched, /<a href="\/schedule" class="on">排期<\/a>/, "看板高亮排期项");
    // 口径同源：门户卡清单与顶栏切换器都由 portalOrgNames（台账未停用 ∪ ownerGroup）给出
    for (const html of [home, sched]) {
      assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/">组织甲</a>`), "ownerGroup 源组织在切换器（门户同清单）");
      assert.doesNotMatch(html, /停用组/, "停用名两页都不进（同源口径）");
    }
    assert.match(home, /id="org-portal"/, "门户卡区容器（看板页无此锚）");
    assert.doesNotMatch(sched, /id="org-portal"/);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 错误出口透传（空间导航随空间内所有页面走）
// ---------------------------------------------------------------------------

test("BD7-⑤（空间 405 表单页）：非 GET 命中空间读面 ⇒ 错误页 NAV 组织感知", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${ENC_JIA}/`, { method: "PUT" });
    assert.equal(res.status, 405);
    const html = await res.text();
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/schedule" class="on">排期</a>`));
  });
});

test("BD7-⑤b（空间深链桥宕页）：/org/组织甲/features/不存在 ⇒ 宕页仍带空间导航", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${ENC_JIA}/features/F-NOPE`);
    assert.equal(res.status, 502);
    const html = await res.text();
    assert.match(html, /桥不可达/);
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/schedule">排期</a>`), "宕页 NAV 落空间 href");
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/" class="on">组织甲</a>`), "切换器当前组织标记不丢");
  });
});

test("BD7-⑤c（空间写 mismatch 409 浮层页）：表单档错误页带空间导航与当前组织标记", async () => {
  await withNavServer({ ...DISK, ...LEDGER }, async (base) => {
    const res = await fetch(`${base}/org/${ENC_JIA}/requirements`, {
      method: "POST",
      headers: { "x-board-write": "1" },
      body: new URLSearchParams({ group: "组织乙", title: "串组", version: "" }).toString(),
    });
    assert.equal(res.status, 409);
    const html = await res.text();
    assert.match(html, /board_org_mismatch/);
    assert.match(html, new RegExp(`<a href="/org/${ENC_JIA}/schedule" class="on">排期</a>`));
  });
});
