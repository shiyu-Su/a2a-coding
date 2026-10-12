/**
 * REQ-2026-10-03-02「项目组加/删项目改两栏拖拽」N2 半场 —— **拖放写路径**（脚本 → 既有路由）。
 *
 * N1 钉的是 SSR 面（池集合差 / 两栏渲染 / 服务端 draggable 判据 / 降级不炸页），本文件钉的是
 * 第七枚常量 {@link MEMBER_DRAG_SCRIPT} 与**真实写径**的接缝，改造文档 §3 固定口径逐条：
 *  ① **分层**：拖拽只是体验层，落点仍以服务端投影与 409 为准 ⇒ 脚本提交的请求形状必须与
 *     **既有写路由逐字一致**（同路由、同三参数、同编码），服务端零改动即可服务拖放（拖-②③；
 *     ⑦b 起手填表单已退役 ⇒ 对账对象从「表单字段」改为「路由入参」）；
 *  ② **失败可见**：409 冲突卡 / 末位闸卡必须在 `Accept: text/html` 档里以 `.err-ov-card`
 *     出现（脚本据此叠浮层），且冲突卡自带所属组链接（拖-④⑤）；
 *  ③ **不放宽 CSRF**：同源 `Origin` 档承担认证，跨站仍 403 且零出网 —— 拖放路径不是后门（拖-⑥）；
 *  ④ **页隔离**：第七枚只随 `/org/<名>/manage` 注入（门户 / 排期 / 详情 / 项目 / Agent 页一律不带），
 *     闭集八元但**按页注入**，不给任何页面白扩脚本面（拖-①）；
 *  ⑤ **⑦b 起拖拽是唯一成员写通路**：无 JS / 无 DnD ⇒ 该页无成员写面（两枚手填表单与其折叠宿主已退役，
 *     快照面降级档同样不再有表单兜底）—— 负锚见拖-⑦，登记改造文档 §6。
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
      6,
      // v0.10.4 REQ-2026-10-11-03 N5：计数翻新（八枚闭集内、非野长）= 看板注入面四枚 + mermaid 渲染 +
      // 提交守卫/err-ov + 页级就地刷新第八枚；上方「不带第七枚」的页隔离负钉逐字不动。
      "空间排期页计数 = 六枚（v0.10.4 起含页级就地刷新第八枚；排期拖拽仍是独立枚，闭集八元不野扩）",
    );
  });
});

// ---------------------------------------------------------------------------
// ②③ 拖放写路径 = 既有路由逐字复用
// ---------------------------------------------------------------------------

test("拖-② 拖放左→右（add）：同源 Origin + 无守卫头 + urlencoded 三参数 ⇒ 路由接受、出网入参与既有写路由同形、回执页仍可继续拖", async () => {
  const { calls, impl } = memberWriteStub([okAdd]);
  await withBoard({ groupMemberWriteImpl: impl }, async (base) => {
    const res = await postLikeScript(base, "alpha", { action: "add", machineId: "m1", projectId: "p-free" });
    assert.equal(res.status, 200, "脚本档 `res.ok` ⇒ 前端 location.reload()（成功以刷新后回读为事实源）");
    assert.equal(calls.length, 1, "一次拖放 = 一次出网");
    assert.deepEqual(calls[0].input, {
      op: MEMBER_OP_ADD,
      groupName: "alpha",
      members: [{ machineId: "m1", projectId: "p-free" }],
    }, "拖放的三参数经既有解析路径落到该路由的出网载荷（服务端零改动 ⇒ ⑦b 后这是唯一一发）");
    assert.equal(calls[0].options.group, "alpha", "组身份 = 目标组织（取自 data-org，非表单可见字段）");
    const html = await res.text();
    assert.ok(html.includes('id="member-pool"'), "有内容回执页复用管理页装配 ⇒ 拖完接着拖，不必二次导航");
    assert.ok(html.includes(MEMBER_DRAG_SCRIPT), "回执页同样注入第七枚（同一条页注入单点）");
  });
});

test("拖-③ 拖放右→左（remove）与 add 同径同参；脚本载荷三键 = 闭集（不新增第四参数，⑦ 起无表单可对账）", async () => {
  const { calls, impl } = memberWriteStub([okRemove]);
  await withBoard({ groupMemberWriteImpl: impl }, async (base) => {
    const res = await postLikeScript(base, "alpha", { action: "remove", machineId: "m1", projectId: "p-a1" });
    assert.equal(res.status, 200);
    assert.equal(calls[0].input.op, MEMBER_OP_REMOVE, "remove ⇒ group.member.remove（同一条路由靠 action 分流）");
    assert.deepEqual(calls[0].input.members, [{ machineId: "m1", projectId: "p-a1" }]);

    const manage = await (await fetch(`${base}/org/alpha/manage`)).text();
    const [, scriptKeysRaw] = /new URLSearchParams\(\{([^}]*)\}\)/.exec(MEMBER_DRAG_SCRIPT) ?? [];
    const scriptKeys = [...new Set((scriptKeysRaw ?? "").match(/(\w+)\s*:/g)?.map((k) => k.slice(0, -1)) ?? [])].sort();
    assert.deepEqual(scriptKeys, ["action", "machineId", "projectId"], "拖拽载荷闭集 = 三键（既是唯一写通路，闭集也不得野扩第四参数）");
    // ⑦b（REQ-2026-10-11-05 N8）：两枚手填表单退役 ⇒ 原「与表单字段逐字相等」的对账锚改判为**显式负钉**
    assert.equal(
      manage.includes('<form method="post" action="/orgs/alpha/members"'),
      false,
      "⑦b 成员手填表单退役 ⇒ 拖拽是本页唯一成员写通路（表单若复活，本条红）",
    );
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
// ⑥ CSRF 不放宽（⑦「无 JS 回落 = 手填表单」整条随 ⑦b 表单退役删除，见 §2⑦ / §6）
// ---------------------------------------------------------------------------

test("拖-⑥（负向）跨站 Origin ⇒ 403 CSRF、成员写零触达（同源档承载拖放认证，但不放宽）", async () => {
  const { calls, impl } = memberWriteStub([okAdd]);
  await withBoard({ groupMemberWriteImpl: impl }, async (base) => {
    const res = await postLikeScript(base, "alpha", { action: "add", machineId: "m1", projectId: "p-free" }, { origin: "http://evil.example" });
    assert.equal(res.status, 403);
    assert.deepEqual(calls, [], "未认证写请求不得出网");
  });
});

test("拖-⑦ ⑦b 退役钉：折叠宿主与两枚手填表单不复活（拖拽是唯一成员写通路）· 内联脚本枚数不随退役变", async () => {
  await withBoard({}, async (base) => {
    const html = await (await fetch(`${base}/org/alpha/manage`)).text();
    assert.equal(html.includes('id="member-forms-fold"'), false, "⑦b 折叠宿主已删（复活即红）");
    assert.equal(html.includes('<details class="m-fold"'), false, "⑦b 不再有任何 .m-fold 折叠宿主");
    assert.equal(html.includes("<summary>手填表单"), false, "⑦b 折叠条文案不再出现");
    assert.equal(html.includes('action="/orgs/alpha/members"'), false, "⑦b 页内不再有成员写表单（POST 该路由只剩拖拽脚本一发）");
    assert.equal(html.includes('<div class="b-forms">'), false, "⑦b 双表单宿主 div.b-forms 随卡删除");
    assert.equal(bareScriptCount(html), 2, "退役不改变内联脚本枚数（提交守卫 + 成员两栏拖拽）");
    assert.ok(html.includes('id="member-pool"'), "对照：两栏池容器仍在（否则上面负锚是空锚）");
  });
  // 快照读失败（无池可拖）⇒ 拖拽入口消失，且**没有手填表单兜底**（⑦ 裁定的降级面消失，登记 §6）
  await withBoard(
    { client: fakeClient({ async getRegistryProjects() { throw new Error("快照面爆炸（假）"); } }) },
    async (base) => {
      const html = await (await fetch(`${base}/org/alpha/manage`)).text();
      assert.equal(html.includes('id="member-pool"'), false, "降级档不给拖拽载荷");
      assert.equal(
        html.includes('<form method="post" action="/orgs/alpha/members"'),
        false,
        "⑦b 降级档无成员写通路（原「表单仍是主通路」锚随退役翻向）",
      );
    },
  );
});
