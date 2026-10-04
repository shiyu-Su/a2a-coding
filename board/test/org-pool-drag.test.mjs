/**
 * REQ-2026-10-03-02「项目组加/删项目改两栏拖拽」N2 半场 —— **拖放写路径**（脚本 → 既有路由）。
 *
 * N1 钉的是 SSR 面（池集合差 / 两栏渲染 / 服务端 draggable 判据 / 降级不炸页），本文件钉的是
 * 第七枚常量 {@link MEMBER_DRAG_SCRIPT} 与**真实写径**的接缝，改造文档 §3 固定口径逐条：
 *  ① **分层**：拖拽只是体验层，落点仍以服务端投影与 409 为准 ⇒ 脚本提交的请求形状必须与
 *     手填表单**逐字一致**（同路由、同三参数、同编码），服务端零改动即可服务拖放（拖-②③）；
 *  ② **失败可见**：409 冲突卡 / 末位闸卡必须在 `Accept: text/html` 档里以 `.err-ov-card`
 *     出现（脚本据此叠浮层），且冲突卡自带所属组链接（拖-④⑤）；
 *  ③ **不放宽 CSRF**：同源 `Origin` 档承担认证，跨站仍 403 且零出网 —— 拖放路径不是后门（拖-⑥）；
 *  ④ **页隔离**：第七枚只随 `/org/<名>/manage` 注入（门户 / 排期 / 详情 / 项目 / Agent 页一律不带），
 *     闭集七元但**按页注入**，不给任何页面白扩脚本面（拖-①）；
 *  ⑤ **无 JS 回落**：两枚手填表单保留 DOM 且可原生提交；快照面降级档表单仍是主通路（拖-⑦）。
 *
 * 范围外（归 N1 / 闭集锚）：池集合差纯函数、两栏渲染结构、N3-⑦/⑧ 全站闭集枚数锚（在 n3-regression-anchors）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MEMBER_DRAG_SCRIPT } from "../dist/web/layout.js";
import { createBoardServer } from "../dist/server.js";
import {
  LAST_MEMBER_REMOVE_CODE,
  MEMBER_GROUP_CONFLICT_CODE,
  MEMBER_OP_ADD,
  MEMBER_OP_REMOVE,
  DUPLICATE_MEMBER_CODE,
} from "../dist/group-admin.js";

const OBSERVED = "2026-10-03T01:00:00.000Z";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function groupsOutcome(...rows) {
  return { ok: true, warnings: [], observedAt: OBSERVED, groups: rows };
}

const ALPHA_TWO = {
  name: "alpha",
  memberCount: 2,
  members: [
    { machineId: "m1", projectId: "p-a1" },
    { machineId: "m1", projectId: "p-a2" },
  ],
};
const BETA_ONE = { name: "beta", memberCount: 1, members: [{ machineId: "m2", projectId: "p-b1" }] };

function snapshotView(machines) {
  return {
    source: "fake",
    note: null,
    observedAt: OBSERVED,
    machines: machines.map((m) => ({
      machineId: m.machineId,
      error: m.error ?? null,
      projects: (m.projects ?? []).map((projectId) => ({
        projectId,
        agentKind: "qoder",
        a2aPort: 1,
        status: "ok",
        endpoint: null,
        startedAt: null,
      })),
    })),
    runners: [],
    group: null,
  };
}

/**
 * 池左集换源后的读面出参（v0.9.8「项目池恒空修复」N3）：`GET /api/registry/projects` 形状
 * —— 机级 `runnerState` / 无 `error` 字段、项目级带 `lastReportedAt`。
 * **本文件的桩只是让池栏装配得起来（拖拽面在场），拖放写径的断言不消费这些字段。**
 */
function registryView(machines) {
  return {
    source: "registry",
    note: null,
    observedAt: OBSERVED,
    machines: machines.map((m) => ({
      machineId: m.machineId,
      runnerState: m.runnerState ?? "online",
      lastHeartbeatAt: OBSERVED,
      firstRegisteredAt: OBSERVED,
      projects: (m.projects ?? []).map((projectId) => ({
        projectId,
        agentKind: "qoder",
        a2aPort: 1,
        status: "ok",
        endpoint: null,
        startedAt: null,
        lastReportedAt: OBSERVED,
      })),
    })),
    counts: { machines: machines.length, projects: machines.reduce((n, m) => n + (m.projects?.length ?? 0), 0) },
  };
}

function feature(featureId, ownerGroup) {
  return {
    featureId,
    state: "executing",
    title: `需求 ${featureId}`,
    taskCount: 1,
    ownerGroup,
    stage: "改造方案",
    version: "v0.9.8",
    approval: "已通过",
    createdAt: "c",
    updatedAt: "u",
    stateCounts: null,
  };
}

function fakeClient(extra = {}) {
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features: [feature("F1", "alpha"), feature("F2", "beta")], stateCounts: null };
    },
    async getProjects() {
      return snapshotView([
        { machineId: "m1", projects: ["p-a1", "p-a2", "p-free"] },
        { machineId: "m2", projects: ["p-b1"] },
      ]);
    },
    // v0.9.8 池左集换源：管理页的池读的是这一面（不再读上面的 getProjects）
    async getRegistryProjects() {
      return registryView([
        { machineId: "m1", projects: ["p-a1", "p-a2", "p-free"] },
        { machineId: "m2", projects: ["p-b1"] },
      ]);
    },
    ...extra,
  };
}

/** 成员写桩：记录出网入参，按脚本依次返回 outcome（末值复用）。 */
function memberWriteStub(scripts) {
  const calls = [];
  let i = 0;
  const impl = async (input, options) => {
    calls.push({ input, options });
    const script = scripts[Math.min(i, scripts.length - 1)];
    i += 1;
    return typeof script === "function" ? script(input, options) : script;
  };
  return { calls, impl };
}

const okAdd = {
  outcome: {
    ok: true,
    op: MEMBER_OP_ADD,
    groupName: "alpha",
    changed: true,
    members: [...ALPHA_TWO.members, { machineId: "m1", projectId: "p-free" }],
    backedUpTo: "G:/orch/config.json.bak-2026-10-03",
  },
  retriedOnce: false,
  groupCreatedOnce: false,
};
const okRemove = {
  outcome: {
    ok: true,
    op: MEMBER_OP_REMOVE,
    groupName: "alpha",
    changed: true,
    members: [{ machineId: "m1", projectId: "p-a2" }],
    backedUpTo: null,
  },
  retriedOnce: false,
  groupCreatedOnce: false,
};
const dupFail = {
  outcome: { ok: false, code: DUPLICATE_MEMBER_CODE, error: "桥原文：projectGroup 不变量句（不得进浮层）" },
  retriedOnce: false,
  groupCreatedOnce: false,
};

async function withBoard(opts, run) {
  const dir = mkdtempSync(join(tmpdir(), "board-drag-"));
  const orgsRoot = join(dir, "orgs");
  mkdirSync(orgsRoot, { recursive: true });
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: fakeClient(),
    docs: { repoRoot: dir, orgsDir: orgsRoot },
    orgsLedgerFile: join(dir, "data", "orgs.json"),
    orgProjectsFetcher: async () => ({ ok: true, projects: [] }),
    orgGroupsFetcher: async () => groupsOutcome(ALPHA_TWO, BETA_ONE),
    ...opts,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

/**
 * **逐字复刻脚本发出的请求**（MEMBER_DRAG_SCRIPT 的 submitMember）：
 * 同源 fetch 会自动带 `Origin` = 本页 origin、`credentials:"same-origin"` 带同源凭据、
 * `Accept: text/html`、body = urlencoded 三参数、**不带 x-board-write**。
 */
function postLikeScript(base, org, form, extraHeaders = {}) {
  return fetch(`${base}/orgs/${encodeURIComponent(org)}/members`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: base,
      referer: `${base}/org/${encodeURIComponent(org)}/manage`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      ...extraHeaders,
    },
    body: new URLSearchParams(form).toString(),
  });
}

const bareScriptCount = (html) => (html.match(/<script>/g) ?? []).length;

// ---------------------------------------------------------------------------
// ④ 页隔离：第七枚只随 manage 页
// ---------------------------------------------------------------------------

test("拖-① 页隔离：第七枚常量只在 /org/alpha/manage 注入（门户 / 空间排期 / 项目 / Agent / 空间任务页一律不带）", async () => {
  await withBoard({}, async (base) => {
    const manage = await (await fetch(`${base}/org/alpha/manage`)).text();
    assert.ok(manage.includes(MEMBER_DRAG_SCRIPT), "manage 页注入第七枚（经 extraScripts 单点）");
    assert.equal(bareScriptCount(manage), 2, "manage 页可执行内联脚本 = 提交守卫 + 成员两栏拖拽两枚（不野扩）");

    for (const path of ["/", "/org/alpha/schedule", "/projects", "/agents", "/org/alpha/tasks"]) {
      const res = await fetch(`${base}${path}`);
      const html = await res.text();
      assert.equal(res.status, 200, `${path} 可达（本锚不靠 404 蒙混）`);
      assert.equal(html.includes(MEMBER_DRAG_SCRIPT), false, `${path} 不带第七枚（入口锚 #member-pool 也不在其上）`);
      assert.equal(html.includes('id="member-pool"'), false, `${path} 无两栏容器 ⇒ 页隔离由入口守卫双保险`);
    }
    assert.equal(bareScriptCount(await (await fetch(`${base}/`)).text()), 2, "门户计数不因本需求扩（提交守卫 + 泛化弹窗）");
    assert.equal(
      bareScriptCount(await (await fetch(`${base}/org/alpha/schedule`)).text()),
      5,
      "空间排期页计数不因本需求扩（看板注入面五枚，排期拖拽仍是独立第六枚）",
    );
  });
});

// ---------------------------------------------------------------------------
// ②③ 拖放写路径 = 既有路由逐字复用
// ---------------------------------------------------------------------------

test("拖-② 拖放左→右（add）：同源 Origin + 无守卫头 + urlencoded 三参数 ⇒ 路由接受、出网入参与手填表单同形、回执页仍可继续拖", async () => {
  const { calls, impl } = memberWriteStub([okAdd]);
  await withBoard({ groupMemberWriteImpl: impl }, async (base) => {
    const res = await postLikeScript(base, "alpha", { action: "add", machineId: "m1", projectId: "p-free" });
    assert.equal(res.status, 200, "脚本档 `res.ok` ⇒ 前端 location.reload()（成功以刷新后回读为事实源）");
    assert.equal(calls.length, 1, "一次拖放 = 一次出网");
    assert.deepEqual(calls[0].input, {
      op: MEMBER_OP_ADD,
      groupName: "alpha",
      members: [{ machineId: "m1", projectId: "p-free" }],
    }, "拖放的三参数经既有解析路径落到与表单**同一**出网载荷（服务端零改动）");
    assert.equal(calls[0].options.group, "alpha", "组身份 = 目标组织（取自 data-org，非表单可见字段）");
    const html = await res.text();
    assert.ok(html.includes('id="member-pool"'), "有内容回执页复用管理页装配 ⇒ 拖完接着拖，不必二次导航");
    assert.ok(html.includes(MEMBER_DRAG_SCRIPT), "回执页同样注入第七枚（同一条页注入单点）");
  });
});

test("拖-③ 拖放右→左（remove）与 add 同径同参；且脚本载荷三键与手填表单字段逐项相等（不新增第四参数）", async () => {
  const { calls, impl } = memberWriteStub([okRemove]);
  await withBoard({ groupMemberWriteImpl: impl }, async (base) => {
    const res = await postLikeScript(base, "alpha", { action: "remove", machineId: "m1", projectId: "p-a1" });
    assert.equal(res.status, 200);
    assert.equal(calls[0].input.op, MEMBER_OP_REMOVE, "remove ⇒ group.member.remove（同一条路由靠 action 分流）");
    assert.deepEqual(calls[0].input.members, [{ machineId: "m1", projectId: "p-a1" }]);

    const manage = await (await fetch(`${base}/org/alpha/manage`)).text();
    const [, scriptKeysRaw] = /new URLSearchParams\(\{([^}]*)\}\)/.exec(MEMBER_DRAG_SCRIPT) ?? [];
    const scriptKeys = [...new Set((scriptKeysRaw ?? "").match(/(\w+)\s*:/g)?.map((k) => k.slice(0, -1)) ?? [])].sort();
    const memberForms = [...manage.matchAll(/<form method="post" action="\/orgs\/alpha\/members"[\s\S]*?<\/form>/g)].map((m) => m[0]);
    assert.equal(memberForms.length, 2, "加 / 删两枚成员表单在位（本锚只与它们对账，不涉停用 / agent 配置表单）");
    const formKeys = [...new Set(memberForms.flatMap((f) => [...f.matchAll(/<input[^>]*name="(\w+)"/g)].map((m) => m[1])))].sort();
    assert.deepEqual(scriptKeys, ["action", "machineId", "projectId"], "拖拽载荷闭集 = 三键");
    assert.deepEqual(formKeys, scriptKeys, "拖拽参数与成员表单字段**逐字相等** ⇒ 两输入面共用同一条写径，无第四参数");
    assert.match(manage, /data-org="alpha"/, "脚本提交的 org 来自服务端渲染的 data-org");
  });
});

// ---------------------------------------------------------------------------
// ④⑤ 失败档：409 必须带可摘的 .err-ov-card
// ---------------------------------------------------------------------------

test("拖-④ 加成员撞组间互斥 ⇒ 409 + Accept: text/html 档出 `.err-ov-card` + 点名所属组链接（脚本叠浮层的事实源）", async () => {
  const { calls, impl } = memberWriteStub([dupFail]);
  await withBoard({ groupMemberWriteImpl: impl }, async (base) => {
    const res = await postLikeScript(base, "alpha", { action: "add", machineId: "m2", projectId: "p-b1" });
    assert.equal(res.status, 409);
    const html = await res.text();
    assert.match(html, /class="err-ov-card"/, "错误卡单独可摘 ⇒ 脚本 DOMParser 后叠 body");
    assert.ok(html.includes(MEMBER_GROUP_CONFLICT_CODE), "业务化码在卡上");
    assert.match(html, /\/org\/beta\/manage/, "冲突卡自带所属组（beta）链接（照既有 §9.4-③ 文案，不为拖拽改）");
    assert.equal(html.includes("projectGroup 不变量句"), false, "桥原文只进日志，不进浮层");
    assert.equal(calls.length, 1, "板不吞失败：出网一次、按 O1 结论回 409");
    assert.match(html, /err-ov-field-value[^>]*>m2</, "失败档回显拖拽原字段（表单回填在位 ⇒ 改得动、可重提）");
    assert.match(html, /err-ov-field-value[^>]*>p-b1</);
  });
});

test("拖-⑤ 末位成员移出 ⇒ 板侧写前闸 409 + 浮层卡 + 零出网（拖拽不绕过写前闸）", async () => {
  const { calls, impl } = memberWriteStub([okRemove]);
  const lone = { name: "alpha", memberCount: 1, members: [{ machineId: "m1", projectId: "p-a1" }] };
  await withBoard({ groupMemberWriteImpl: impl, orgGroupsFetcher: async () => groupsOutcome(lone, BETA_ONE) }, async (base) => {
    const res = await postLikeScript(base, "alpha", { action: "remove", machineId: "m1", projectId: "p-a1" });
    assert.equal(res.status, 409);
    const html = await res.text();
    assert.match(html, /class="err-ov-card"/);
    assert.ok(html.includes(LAST_MEMBER_REMOVE_CODE), "末位闸码逐字（与拖拽行不带 draggable 同判据）");
    assert.deepEqual(calls, [], "写前闸在出网前拦截 ⇒ 拖放路径不成为后门");
  });
});

// ---------------------------------------------------------------------------
// ⑥ CSRF 不放宽 / ⑦ 无 JS 回落
// ---------------------------------------------------------------------------

test("拖-⑥（负向）跨站 Origin ⇒ 403 CSRF、成员写零触达（同源档承载拖放认证，但不放宽）", async () => {
  const { calls, impl } = memberWriteStub([okAdd]);
  await withBoard({ groupMemberWriteImpl: impl }, async (base) => {
    const res = await postLikeScript(base, "alpha", { action: "add", machineId: "m1", projectId: "p-free" }, { origin: "http://evil.example" });
    assert.equal(res.status, 403);
    assert.deepEqual(calls, [], "未认证写请求不得出网");
  });
});

test("拖-⑦ 无 JS 回落：SSR 直出 open 的折叠宿主 + 两枚原生可提交表单（含降级档），DOM 未删", async () => {
  await withBoard({}, async (base) => {
    const html = await (await fetch(`${base}/org/alpha/manage`)).text();
    assert.match(html, /<details class="m-fold" id="member-forms-fold" open>/, "SSR 直出 open ⇒ 折叠只在 JS 可用时发生，无 JS 即原样展开");
    const add = /<form method="post" action="\/orgs\/alpha\/members"[^>]*>[\s\S]*?<\/form>/.exec(html);
    assert.ok(add, "加成员表单在页面里（原生 method/action 齐备 ⇒ 无 JS 照常提交）");
    assert.match(add[0], /<input type="hidden" name="action" value="add">/);
    assert.match(html, /<input type="hidden" name="action" value="remove">/, "删成员表单同径");
    assert.equal(bareScriptCount(html), 2, "回落面不靠脚本：第七枚只是增强");
  });
  // 快照读失败（无池可拖）⇒ 拖拽入口消失，表单照在（回落面反而是唯一通路）
  await withBoard(
    { client: fakeClient({ async getRegistryProjects() { throw new Error("快照面爆炸（假）"); } }) },
    async (base) => {
      const html = await (await fetch(`${base}/org/alpha/manage`)).text();
      assert.equal(html.includes('id="member-pool"'), false, "降级档不给拖拽载荷");
      assert.match(html, /<form method="post" action="\/orgs\/alpha\/members"/, "降级档表单仍是主通路");
    },
  );
});
