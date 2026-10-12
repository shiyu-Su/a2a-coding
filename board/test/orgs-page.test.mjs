/**
 * REQ-v0.9.2 N6 · 组织视角页 + REQ-2026-09-26-01 v0.9.4 A5/BD2 · 组织管理页 ——
 * 归并纯函数 / 逐组查询归一 / 不可达降级 / HTTP 面 / 导航闭集 / 建组织表单（渲染锚 + 闭环 + 失败回填）。
 *
 * 门禁对应：归并纯函数单测（mergeOrgNames / groupFeaturesByOwner / listOrgDirs）、
 * 不可达降级用例（fetcher 失败 / 抛错 / 未装配三档，页面不炸）、导航断言更新（闭集 + 高亮）、
 * BD2 页面结构单测（表单 action/name 字面锚、成功 303→台账组织可见、4xx 错误浮层回填原输入）。
 *
 * **§9-c（REQ-2026-09-27-06 N3）翻向记录**：`GET /orgs` 页退役 ⇒ 303 回门户（N6-⑦ / BD2-①②），
 * 原「逐组织小节」的页面结构锚整体迁到 `GET /org/<名>/manage`（N6-⑧⑨⑩ / BD5-③④⑤），
 * NAV 闭集摘「组织」项（N6-⑫），另补 manage 专属新锚（N3-①② / BD5-③b）。
 * 纯函数与查询器归一（N6-①…⑥、BD5-①②）不受页面形态影响，原样保留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GROUPS_QUERY_PATH,
  NO_OWNER_GROUP_LABEL,
  ORG_QUERY_TIMEOUT_MS,
  PROJECTS_QUERY_TOOL,
  createOrgGroupsFetcher,
  createOrgProjectsFetcher,
  groupFeaturesByOwner,
  listOrgDirs,
  mergeOrgNames,
  normalizeGroupsOutcome,
  normalizeProjectsOutcome,
} from "../dist/orgs-view.js";
import { createBoardServer } from "../dist/server.js";
import { renderPage } from "../dist/web/layout.js";
import { renderOrgSpaceManagePage, ORG_FEATURES_PAGE_SIZE } from "../dist/web/views.js";

function feature(featureId, ownerGroup, overrides = {}) {
  return {
    featureId,
    state: "executing",
    title: `需求 ${featureId}`,
    taskCount: 1,
    ownerGroup,
    stage: "改造方案",
    version: "v0.9.2",
    approval: "已通过",
    createdAt: "c",
    updatedAt: "u",
    stateCounts: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 归并纯函数
// ---------------------------------------------------------------------------

test("N6-① mergeOrgNames: 四源并集去重、空白/点段丢弃、排序稳定", () => {
  const merged = mergeOrgNames({
    disk: ["beta", " alpha ", "."],
    ledger: ["alpha", "gamma"],
    featureGroups: ["beta", ""],
    defaultGroup: "default-org",
  });
  assert.deepEqual(merged, [" alpha", "beta", "default-org", "gamma"].map((s) => s.trim()));
  assert.deepEqual(mergeOrgNames({ disk: [], ledger: [], featureGroups: [], defaultGroup: null }), []);
});

test("N6-② groupFeaturesByOwner: null/空白归属归「（无归属）」伪分组，不丢弃", () => {
  const groups = groupFeaturesByOwner([
    feature("F1", "alpha"),
    feature("F2", null),
    feature("F3", "  "),
    feature("F4", "alpha"),
  ]);
  assert.deepEqual([...groups.get("alpha")].map((f) => f.featureId), ["F1", "F4"]);
  assert.deepEqual([...groups.get(NO_OWNER_GROUP_LABEL)].map((f) => f.featureId), ["F2", "F3"]);
});

test("N6-③ listOrgDirs: 真临时目录只收一级目录；根缺失 / 未配置 ⇒ 空清单不报错", () => {
  const root = mkdtempSync(join(tmpdir(), "board-n6-"));
  try {
    mkdirSync(join(root, "org-a"));
    mkdirSync(join(root, "org-b"));
    writeFileSync(join(root, "not-a-dir.md"), "x");
    assert.deepEqual(listOrgDirs(root), ["org-a", "org-b"]);
    assert.deepEqual(listOrgDirs(join(root, "ghost")), []);
    assert.deepEqual(listOrgDirs(null), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// a2a_projects 负载归一 + 查询器（callToolRaw 链）
// ---------------------------------------------------------------------------

test("N6-④ normalizeProjectsOutcome: 无 ok 字段的视图 = 成功；ok:false 透传码；缺 machines ⇒ response_invalid", () => {
  const okView = normalizeProjectsOutcome({
    machines: [
      {
        machineId: "m1",
        projects: [
          { projectId: "p1", agentKind: "claude", a2aPort: 3017, status: "online", endpoint: null, startedAt: null },
          { projectId: "p2", agentKind: "qoder", a2aPort: 3018, status: "online", endpoint: null, startedAt: "s" },
        ],
      },
      { machineId: "m2", projects: [], error: "Runner 未注册" },
    ],
    runners: [],
    group: { name: "alpha", selective: false, memberMachines: [] },
  });
  assert.equal(okView.ok, true);
  assert.equal(okView.ok && okView.projects.length, 2);
  assert.equal(okView.ok && okView.projects[0].machineId, "m1");
  assert.equal(okView.ok && okView.projects[1].startedAt, "s");

  const failure = normalizeProjectsOutcome({ ok: false, code: "machines_config_error", error: "配置坏" });
  assert.deepEqual(failure, { ok: false, code: "machines_config_error", error: "配置坏" });

  const bogus = normalizeProjectsOutcome({ hello: "world" });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.code, "response_invalid");
});

test("N6-⑤ createOrgProjectsFetcher: 组身份进 URL 首段、只读工具名、单组超时生效；成功负载无需 ok:true", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)), hasSignal: init.signal instanceof AbortSignal });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ machines: [{ machineId: "m", projects: [{ projectId: "p", agentKind: "claude", a2aPort: 1, status: "online", endpoint: null, startedAt: null }] }], runners: [], group: { name: "alpha", selective: false, memberMachines: [] } }) }], isError: false },
      }),
      { status: 200 },
    );
  };
  const fetcher = createOrgProjectsFetcher({ baseUrl: "http://127.0.0.1:8787", fetchImpl });
  const out = await fetcher("alpha");
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.projects[0].projectId, "p");
  assert.equal(seen[0].url, "http://127.0.0.1:8787/alpha/mcp");
  assert.equal(seen[0].body.params.name, PROJECTS_QUERY_TOOL);
  assert.deepEqual(seen[0].body.params.arguments, {});
  assert.equal(seen[0].hasSignal, true, "fetch 必须带 AbortSignal（超时链路）");
  // 超时真生效：挂起 fetch + 短 timeoutMs ⇒ 被 signal 中止，收口为结构化 transport_error
  const hanging = createOrgProjectsFetcher({
    baseUrl: "http://h:1",
    timeoutMs: 50,
    fetchImpl: (_url, init) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () => rej(new Error("aborted by timeout")));
      }),
  });
  const aborted = await hanging("alpha");
  assert.equal(aborted.ok, false);
  assert.equal(aborted.code, "transport_error");
  assert.ok(ORG_QUERY_TIMEOUT_MS >= 3_000 && ORG_QUERY_TIMEOUT_MS <= 5_000, "N6 口径：缺省单组 timeoutMs 3–5s");
});

test("N6-⑥ createOrgProjectsFetcher 降级: 传输异常 / 桥失败码 / 空组名 ⇒ 结构化不可达，不抛穿", async () => {
  const thrown = await createOrgProjectsFetcher({
    baseUrl: "http://h:1",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  })("alpha");
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, "transport_error");

  const rejected = await createOrgProjectsFetcher({
    baseUrl: "http://h:1",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "project_group_mismatch", error: "非本组" }) }], isError: true } }),
        { status: 200 },
      ),
  })("beta");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "project_group_mismatch");

  const empty = await createOrgProjectsFetcher({ baseUrl: "http://h:1", fetchImpl: async () => new Response("{}", { status: 200 }) })("   ");
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "org_name_invalid");
});

// ---------------------------------------------------------------------------
// HTTP 面：`GET /orgs` 退役（§9-c ⇒ 303 回门户）与 `GET /org/<名>/manage`（承接位）
// ---------------------------------------------------------------------------

function fakeClient(overrides = {}) {
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return {
        features: [feature("F1", "alpha"), feature("F2", null), feature("F3", "beta")],
        stateCounts: null,
      };
    },
    ...overrides,
  };
}

async function withOrgsServer(run, { client = fakeClient(), fetcher, groupsFetcher, docs, hostFace, defaultGroup, orgsLedgerFile } = {}) {
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    orgProjectsFetcher: fetcher,
    // 全组枚举（BD5）缺省按「未装配」走 ⇒ 既有 HTTP 用例零网络（页上如实显示「未查询」）。
    orgGroupsFetcher: groupsFetcher === undefined ? null : groupsFetcher,
    ...(defaultGroup === undefined ? {} : { defaultGroup }),
    ...(docs === undefined ? {} : { docs }),
    ...(hostFace === undefined ? {} : { hostFace }),
    ...(orgsLedgerFile === undefined ? {} : { orgsLedgerFile }),
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

async function get(base, path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, text: await res.text() };
}

test("N6-⑦（§9-c 翻向）GET /orgs ⇒ 303 回门户，重定向不触桥；管理职能的落点 = /org/<名>/manage", async () => {
  await withOrgsServer(async (base) => {
    const res = await fetch(`${base}/orgs`, { redirect: "manual" });
    assert.equal(res.status, 303, "页面退役 = PRG 式 303（板惯例，非 301，留反悔余地）");
    assert.equal(res.headers.get("location"), "/");
    assert.equal(await res.text(), "", "303 无响应体");
  }, {
    // 任何触桥 / 触查询器的实现都抛 ⇒ 若 303 仍回得来即证明「重定向不触桥」
    client: fakeClient({
      async getFeatures() {
        throw new Error("退役页的 303 不得触桥");
      },
    }),
    fetcher: async () => {
      throw new Error("退役页的 303 不得查项目");
    },
  });
});

test("N3-①（§9-c 新锚）GET /org/<名>/manage: 池卡 + 停用表单，写表单 action 逐字对齐全局写口；⑦b 成员手填表单退役", async () => {
  await withOrgsServer(async (base) => {
    const res = await get(base, "/org/alpha/manage");
    assert.equal(res.status, 200);
    assert.match(res.text, /管理 · alpha/, "页标题 = 空间内管理");
    // 成员清单 = 3300 全组枚举的该组投影（本用例 groupsFetcher 未装配 ⇒ 如实「未查询」，见 N3-③）
    assert.doesNotMatch(res.text, /成员（声明态/, "REQ-2026-10-10-03 N2：逐组声明态成员清单卡退役 ⇒ 整页不得再出现该区块（声明面健康度改由配置核对卡首行承载，见 N6-⑧）");
    // ⑦b（REQ-2026-10-11-05 N8）：加 / 删成员两枚手填表单与其折叠宿主退役 ⇒ 原「表单在场」正锚翻向显式负钉
    //（写路由本身不删：拖拽脚本仍 POST 同一条全局 `POST /orgs/{org}/members`，见 org-pool-drag 拖-②③）
    assert.doesNotMatch(
      res.text,
      /<form method="post" action="\/orgs\/alpha\/members"/,
      "⑦b 成员写表单不复活（拖拽 = 本页唯一成员写通路）",
    );
    assert.doesNotMatch(res.text, /id="member-forms-fold"/, "⑦b 手填表单的折叠宿主已删");
    assert.doesNotMatch(res.text, /<summary>手填表单/, "⑦b 折叠条文案不再出现");
    assert.doesNotMatch(res.text, /name="machineId"/, "⑦b 手填字段 machineId 随表单删除");
    assert.doesNotMatch(res.text, /name="projectId"/, "⑦b 手填字段 projectId 随表单删除");
    assert.doesNotMatch(res.text, /<form method="post"[^>]*action="\/org\//, "空间内**写**表单的 action 一律全局路径（不出现 `/org/…` 写径变体）");
    // GET 正锚（同裁定 A）：刷新表单的 action **须**带空间前缀 = 本页自身 ⇒ 防后人误改回全局 `/manage`（该路由不存在 ⇒ 404）
    assert.match(res.text, /<form method="get" action="\/org\/alpha\/manage" class="m-refresh">/, "v0.10.4 项目池刷新表单 = 原生 GET、action 指回本页空间路径");
    // 停用 = 同一条 `POST /orgs`（action=disable），写路由白名单零扩条
    assert.match(res.text, /<form method="post" action="\/orgs" class="inline" data-submit="已提交，停用中…" data-ov="1" data-ov-redirect="\/">/);
    assert.match(res.text, /<input type="hidden" name="org" value="alpha">/);
    // 空间导航含 manage 入口且高亮
    assert.match(res.text, /<a class="fl on" href="\/org\/alpha\/manage" style="font-weight:700">管理<\/a>/);
    // 增补四（REQ-2026-10-02-04）：管理页不收全站口径说明、无口径折叠块
    assert.doesNotMatch(res.text, /<details class="calib"/, "增补四：管理页口径折叠块已删");
    assert.doesNotMatch(res.text, /<ul class="notes"/, "增补四：管理页不收全站口径说明");
    assert.doesNotMatch(res.text, /<script src>/, "纯 SSR：不扩内联脚本闭集（N3-⑦/⑧ 纪律）");
  }, { fetcher: async () => ({ ok: true, projects: [] }) });
});

test("N3-②（§9-c 新锚）停用组织访问 manage ⇒ 410 board_org_space_gone（同归一层空间口径，管理页不另立档位）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-n3-gone-"));
  try {
    writeFileSync(
      join(dir, "orgs.json"),
      JSON.stringify({ version: 1, orgs: [{ org: "旧组织", disabledAt: "2026-09-27T00:00:00Z" }] }, null, 2),
      "utf8",
    );
    await withOrgsServer(async (base) => {
      const res = await fetch(`${base}/org/${encodeURIComponent("旧组织")}/manage`);
      assert.equal(res.status, 410);
      assert.match(await res.text(), /board_org_space_gone/);
    }, {
      fetcher: async () => ({ ok: true, projects: [] }),
      orgsLedgerFile: join(dir, "orgs.json"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N6-⑧（§9-c 翻向到 manage）项目面不可达降级: 「不可达」+ 错误码，本页其余区块照常，不炸页", async () => {
  await withOrgsServer(async (base) => {
    const res = await get(base, "/org/beta/manage");
    assert.equal(res.status, 200);
    assert.match(res.text, /不可达/);
    assert.match(res.text, /transport_error/);
    assert.match(res.text, /连不上（假）/);
    assert.match(res.text, /F3/, "本组需求表不受项目面失败影响");
    assert.match(
      res.text,
      /<p class="hint">核对源健康度：[\s\S]*?运行态项目（逐组 <code>a2a_projects<\/code>） <b>读不到<\/b>/,
      "运行态源不可达 ⇒ 短条第二档如实「读不到」（★REQ-2026-10-11-05 ⑧a：原核对卡第二行 danger 徽标 ⇒ 短条 `<b>` 档；原词逐字保留。本夹具 groupsFetcher 未装配 ⇒ 首档是「未装配」，故不得整页 `includes` 口径判档）",
    );
    assert.match(
      res.text,
      /<li>运行态项目（逐组 <code>a2a_projects<\/code>）：<code>transport_error<\/code> 连不上（假）<\/li>/,
      "根因码 + 错误原文落短条的该源说明 `<li>`（原「说明」列内容照搬，换 `<ul>` 承载）",
    );
    assert.equal(
      /核对源健康度：[\s\S]*?配置齐备/.test(res.text),
      false,
      "运行态读不到 ⇒ 短条不得谎报「配置齐备」（原「核对卡结论行」锚的同款判据，换包装后仍在）",
    );
  }, {
    fetcher: async (org) =>
      org === "beta"
        ? { ok: false, code: "transport_error", error: "连不上（假）" }
        : { ok: true, projects: [{ machineId: "m1", projectId: `p-${org}`, agentKind: "claude", a2aPort: 3017, status: "online", startedAt: null, machineError: null }] },
  });
});

test("N6-⑨（§9-c 翻向到 manage）鲁棒: 查询器抛错 ⇒ 按不可达收口；查询器未装配 ⇒ 如实「未查询」", async () => {
  await withOrgsServer(async (base) => {
    const res = await get(base, "/org/alpha/manage");
    assert.equal(res.status, 200);
    assert.match(res.text, /org_query_failed/);
  }, {
    fetcher: async () => {
      throw new Error("爆炸（假）");
    },
  });
  await withOrgsServer(async (base) => {
    const res = await get(base, "/org/alpha/manage");
    assert.equal(res.status, 200);
    assert.match(res.text, /未查询/, "项目区未装配 ⇒ 如实「未查询」（不编造无项目）");
  }, { fetcher: null });
});

test("N6-⑩（§9-c 翻向到 manage）读面失败不静默: 桥 features 不可达 ⇒ 502 浮层版式（空间存在性判定 fail-closed）", async () => {
  await withOrgsServer(async (base) => {
    const res = await get(base, "/org/alpha/manage");
    assert.equal(res.status, 502);
    assert.match(res.text, /bridge_unreachable/);
  }, {
    client: fakeClient({
      async getFeatures() {
        throw new Error("桥没起（假）");
      },
    }),
    fetcher: async () => ({ ok: true, projects: [] }),
  });
});

test("N6-⑪ 方法门与写面纪律: /orgs 退役后 GET ⇒ 303、POST 写径原样保留（裸 POST 无守卫 ⇒ 403 CSRF）、PUT 仍 405；源文件不含状态推进工具名（板不写状态机）", async () => {
  await withOrgsServer(async (base) => {
    const post = await fetch(`${base}/orgs`, { method: "POST" });
    assert.equal(post.status, 403, "POST /orgs 已登记为写路径 ⇒ 过 CSRF 守卫，无来源证据一律 403（与其余六条写径同口径）");
    assert.match(await post.text(), /CSRF 来源不可判定/);
    const put = await fetch(`${base}/orgs`, { method: "PUT" });
    assert.equal(put.status, 405, "PUT /orgs 不放开（写面只认 POST），仍落读面方法门");
    assert.match(await put.text(), /仅支持 GET/);
  }, { fetcher: async () => ({ ok: true, projects: [] }) });
});

// ---------------------------------------------------------------------------
// 导航闭集更新（v0.9.2 M4 增排期看板 = 六项；REQ-2026-09-26-04 Q2 需求页退役 = 五项；
// REQ-2026-09-26-02 B-T3 增 Agent View = 六项；同版增补 ③ Timeline 退役 = 六项维持；
// REQ-2026-09-27-06 §9-b 首页形态 B→A 增「首页」= 七项；
// REQ-2026-09-27-06 §9-c 组织管理页退役 ⇒ 摘「组织」= 六项；
// REQ-2026-09-28-07 v0.9.6 B5a ⇒ 摘「排期 / 任务 / 宿主桥」+ 文案改字面（口径 37/38）= 三枚）
// ---------------------------------------------------------------------------

test("N6-⑫（B5a 收三枚 · 件1 收一枚）导航闭集: 仅「项目组门户」一项，href、文案与顺序钉死；/projects、/agents 同撤，/schedule、/tasks、/host 链接已摘", () => {
  const html = renderPage({ title: "t", active: "projects", bodyHtml: "<p>b</p>" });
  const anchors = [...html.matchAll(/<a href="(\/[^"]*)"[^>]*>([^<]+)<\/a>/g)].map((m) => `${m[1]}|${m[2]}`);
  assert.deepEqual(anchors, ["/|项目组门户"]);
  assert.doesNotMatch(html, /href="\/(orgs|schedule|projects|agents)"/, "§9-c / B5a / 件1：/orgs 与 /schedule 退役、/projects 与 /agents 撤出导航（路由不退 ⇒ 深链照旧可达）");
  assert.doesNotMatch(html, /href="\/tasks"|href="\/host"/, "B5a 口径 33/38：路由不退但 NAV 摘条（可达面 = 正文深链）");
});

// ---------------------------------------------------------------------------
// v0.9.4 A5 / BD2 · 建组织表单（渲染锚 / 成功闭环 / 失败回填）
// §9-b（REQ-2026-09-27-06 N2）：表单宿主自 `/orgs` **迁至组织门户 `/`** ⇒ 本组锚随迁
// （写口 `POST /orgs` 与其成功 303 目标零改动，见 BD2-② 仍钉 `/orgs`）
// ---------------------------------------------------------------------------

test("BD2-①（§9-b 翻向 · §9-c 再翻）建组织表单渲染锚在门户 `/`：action/name 与写口逐字对齐 + 闭集 hint；`/orgs` 整页下架", async () => {
  await withOrgsServer(async (base) => {
    const home = await get(base, "/");
    assert.equal(home.status, 200);
    assert.match(home.text, /<form method="post" action="\/orgs"[^>]*data-submit="已提交，建组织中…" data-ov="1">/, "同源 SSR 表单（增补二 §9.1-②：data-ov 浮层报错，无新脚本常量）");
    assert.match(home.text, /<label>项目组名 \*<input name="org" required/, "字段名 = write-guard.ORG_FORM_FIELD = org（标签文案 v0.9.7 增补改「项目组名」，字段名不变）");
    assert.match(home.text, /中文 \/ 字母（Latin）\/ 数字/, "闭集 hint 上板");
    assert.match(home.text, /不触桥、不写状态机、不写 machine 配置/, "写面口径上板");
    assert.doesNotMatch(home.text, /<script src>/, "无外源脚本（§9.5 复用的仍是既有八元闭集内的常量，未引入新枚）");
    const res = await fetch(`${base}/orgs`, { redirect: "manual" });
    assert.equal(res.status, 303, "§9-c：/orgs 页退役 ⇒ 无任何页面结构可断言（原「不再渲染表单」的负向锚升级为整页下架）");
    assert.equal(res.headers.get("location"), "/");
  }, { fetcher: async () => ({ ok: true, projects: [] }) });
});

test("BD2-②（§9-c 翻向）成功闭环: 表单档 POST /orgs 仍 303 → /orgs（写口零改动）→ 跟随后门户出现台账组织", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-bd2-"));
  try {
    const orgsRoot = join(dir, "orgs");
    mkdirSync(orgsRoot, { recursive: true });
    mkdirSync(join(orgsRoot, "磁盘组"), { recursive: true });
    await withOrgsServer(async (base) => {
      const post = await fetch(`${base}/orgs`, {
        method: "POST",
        redirect: "manual",
        headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ org: "新建组" }).toString(),
      });
      assert.equal(post.status, 303);
      assert.equal(post.headers.get("location"), "/orgs", "写口的 303 目标不因页面退役而改（§9-c 不做服务端写面任何改动）");
      // 浏览器跟随 303 → /orgs → 再 303 → /：落点 = 组织门户（台账源可见）
      const page = await get(base, post.headers.get("location"));
      assert.equal(page.status, 200);
      assert.match(page.text, /新建组/, "台账组织经门户清单呈现（§9-b 口径 = 台账在用 ∪ 需求归属）");
      assert.doesNotMatch(page.text, /磁盘组/, "盘一级目录不进门户清单（§9-d 既定：盘遗留不构成板可见组织）");
      const hop = await fetch(`${base}/orgs`, { redirect: "manual" });
      assert.equal(new URL(hop.headers.get("location"), base).pathname, "/", "两跳的终点 = 门户");
    }, {
      fetcher: async () => ({ ok: true, projects: [] }),
      docs: { repoRoot: dir, orgsDir: orgsRoot },
      orgsLedgerFile: join(dir, "data", "orgs.json"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BD2-③ 写失败不丢原输入: 非法名表单档 ⇒ 400 错误浮层（族名「组织名不合法」+ code + 回填原输入）", async () => {
  await withOrgsServer(async (base) => {
    const res = await fetch(`${base}/orgs`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ org: "a b" }).toString(),
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.match(text, /id="err-ov"/, "错误走既有 errorPage/浮层同规格");
    assert.match(text, /组织名不合法/, "族名 = views.ERROR_FAMILY_LABELS");
    assert.match(text, /board_org_name_invalid/);
    assert.match(text, /<span class="err-ov-field-value mono">a b<\/span>/, "回填原输入（写失败不丢）");
  }, { fetcher: async () => ({ ok: true, projects: [] }) });
});

test("BD2-④ 重名表单档 ⇒ 409 浮层点名命中源 + 回填；台账源命中也算重名", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-bd2-conflict-"));
  try {
    const orgsRoot = join(dir, "orgs");
    mkdirSync(orgsRoot, { recursive: true });
    await withOrgsServer(async (base) => {
      const first = await fetch(`${base}/orgs`, {
        method: "POST",
        redirect: "manual",
        headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ org: "唯一组" }).toString(),
      });
      assert.equal(first.status, 303);
      const again = await fetch(`${base}/orgs`, {
        method: "POST",
        redirect: "manual",
        headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ org: "唯一组" }).toString(),
      });
      assert.equal(again.status, 409);
      const text = await again.text();
      assert.match(text, /组织已存在/);
      assert.match(text, /board_org_exists/);
      assert.match(
        text,
        /组织目录根下的一级目录/,
        "§9-a 起建组织即建目录 ⇒ 两面同建，固定序下盘源先点名（原「仅台账」形态退为遗留态，见下）",
      );
      assert.match(text, /<span class="err-ov-field-value mono">唯一组<\/span>/, "回填原输入");

      // 台账源单独命中 = 「台账有、盘没有」（§9-a 前的存量台账 / 建目录失败态）⇒ 直接播种一条记录。
      mkdirSync(join(dir, "data"), { recursive: true });
      writeFileSync(
        join(dir, "data", "orgs.json"),
        JSON.stringify({ version: 1, orgs: [{ org: "遗留台账组", disabledAt: null }] }, null, 2) + "\n",
        "utf8",
      );
      const legacy = await fetch(`${base}/orgs`, {
        method: "POST",
        redirect: "manual",
        headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ org: "遗留台账组" }).toString(),
      });
      assert.equal(legacy.status, 409);
      assert.match(await legacy.text(), /板组织台账/, "台账源命中也算重名（点名台账）");
    }, {
      fetcher: async () => ({ ok: true, projects: [] }),
      docs: { repoRoot: dir, orgsDir: orgsRoot },
      orgsLedgerFile: join(dir, "data", "orgs.json"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v0.9.4 C 档 / BD5 · 全组枚举消费（3300 GET /api/groups）
// ---------------------------------------------------------------------------

const GROUPS_OK_BODY = {
  ok: true,
  source: "config.json:projectGroup",
  observedAt: "2026-09-27T02:00:00.000Z",
  groups: [
    { name: "alpha", memberCount: 2, members: [{ machineId: "win-a", projectId: "board" }, { machineId: "win-a", projectId: "orch" }] },
    { name: "beta", memberCount: 0, members: [] },
    { name: null, memberCount: 1, members: [{ machineId: "m", projectId: "p" }] },
  ],
  warnings: ["组 gamma 缺成员，已忽略"],
};

test("BD5-① normalizeGroupsOutcome: 正常投影（白名单字段 + name 非串跳过 + 未配组 = 真实空）", () => {
  const out = normalizeGroupsOutcome(GROUPS_OK_BODY);
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.ok && out.groups.map((g) => [g.name, g.memberCount]),
    [["alpha", 2], ["beta", 0]],
    "name 非字符串的条目跳过（无法归组身份），其余按声明序",
  );
  assert.deepEqual(out.ok && out.groups[0].members[1], { machineId: "win-a", projectId: "orch" });
  assert.deepEqual(out.ok && out.warnings, ["组 gamma 缺成员，已忽略"]);
  assert.equal(out.ok && out.observedAt, "2026-09-27T02:00:00.000Z");

  const none = normalizeGroupsOutcome({ ok: true, groups: [], warnings: [] });
  assert.deepEqual(none, { ok: true, groups: [], warnings: [], observedAt: null }, "未配组 = 真实空清单（不是缺位）");

  const countMissing = normalizeGroupsOutcome({ ok: true, groups: [{ name: "g", members: [{ machineId: "m", projectId: "p" }] }] });
  assert.equal(countMissing.ok && countMissing.groups[0].memberCount, 1, "缺 memberCount ⇒ 与 members 同源回退，不臆造 0");

  const shapeBad = normalizeGroupsOutcome({ ok: true, note: "没 groups" });
  assert.equal(shapeBad.ok, false);
  assert.equal(shapeBad.code, "response_invalid", "缺 groups 数组不臆造空清单");

  const rejected = normalizeGroupsOutcome({ ok: false, code: "machines_config_error", error: "配置坏" });
  assert.deepEqual(rejected, { ok: false, code: "machines_config_error", error: "配置坏" });

  assert.equal(normalizeGroupsOutcome(null).ok, false);
  assert.equal(normalizeGroupsOutcome([]).code, "response_invalid");
});

test("BD5-② createOrgGroupsFetcher: 只读 GET 3300 聚合面 · 带超时 · 宕机/超时/500 一律收口不抛穿", async () => {
  const seen = [];
  const ok = await createOrgGroupsFetcher({
    baseUrl: "http://127.0.0.1:3300/",
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), method: init.method, hasSignal: init.signal instanceof AbortSignal });
      return new Response(JSON.stringify(GROUPS_OK_BODY), { status: 200 });
    },
  })();
  assert.deepEqual(seen[0], { url: "http://127.0.0.1:3300/api/groups", method: "GET", hasSignal: true });
  assert.equal(GROUPS_QUERY_PATH, "/api/groups");
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.groups.length, 2);

  const down = await createOrgGroupsFetcher({
    baseUrl: "http://127.0.0.1:3300",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:3300");
    },
  })();
  assert.equal(down.ok, false);
  assert.equal(down.code, "groups_unreachable");
  assert.match(down.ok === false ? down.error : "", /ECONNREFUSED/);

  const http500 = await createOrgGroupsFetcher({
    baseUrl: "http://h:1",
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, code: "machines_config_error", error: "加载机器清单失败" }), { status: 500 }),
  })();
  assert.equal(http500.ok, false);
  assert.equal(http500.code, "machines_config_error", "非 2xx 优先取响应体错误码（不只落 http_500）");

  const timeout = await createOrgGroupsFetcher({
    baseUrl: "http://h:1",
    timeoutMs: 30,
    fetchImpl: (_url, init) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () => rej(new Error("This operation was aborted")));
      }),
  })();
  assert.equal(timeout.ok, false);
  assert.equal(timeout.code, "groups_timeout");

  const garbage = await createOrgGroupsFetcher({ baseUrl: "http://h:1", fetchImpl: async () => new Response("<html>-proxy</html>", { status: 200 }) })();
  assert.equal(garbage.ok, false);
  assert.equal(garbage.code, "response_invalid");
});

test("BD5-③（§9-c 翻向）manage 页消费声明面: 该组成员清单 + 成员数 + warnings 小字如实呈现（不入判定）", async () => {
  await withOrgsServer(async (base) => {
    const res = await get(base, "/org/alpha/manage");
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /成员（声明态/, "REQ-2026-10-10-03 N2：退役清单卡的负向钉（本 fixture 版独立钉，与 N3-① 各自成条、条数不折）");
    // 原「本组成员计数 / 本组完整清单 / observedAt 上页」三条锚随该卡退役迁出 ⇒ 落 org-pool-two-column 池-⑲（N3 迁入位）
    assert.match(res.text, /组 gamma 缺成员，已忽略/, "warnings 如实呈现");
    assert.match(res.text, /不参与任何判定/, "warnings 口径钉死为纯呈现");
    assert.doesNotMatch(res.text, /gamma-only/, "别组的声明条目不渗进本组空间（不扩呈现面）");
  }, {
    fetcher: async () => ({ ok: true, projects: [] }),
    groupsFetcher: async () => ({
      ok: true,
      observedAt: "2026-09-27T02:00:00.000Z",
      warnings: ["组 gamma 缺成员，已忽略"],
      groups: [
        { name: "alpha", memberCount: 2, members: [{ machineId: "win-a", projectId: "board" }, { machineId: "win-a", projectId: "orch" }] },
        { name: "gamma-only", memberCount: 0, members: [] },
      ],
    }),
  });
});

test("BD5-③b（§9-c 新锚）声明面无该组 ⇒「未声明」如实呈现（不编造空组，并指向加成员即建组的 §9-a 兜底）", async () => {
  await withOrgsServer(async (base) => {
    const res = await get(base, "/org/beta/manage");
    assert.equal(res.status, 200);
    // 承载已迁至池卡三出口（REQ-2026-10-10-03 N2 §2.2：「未查询」/「不可用」/ 右栏空态同渲一枚 note）
    assert.match(res.text, /<b>未声明<\/b>/);
    assert.match(res.text, /首次写入即建组带首成员/);
  }, {
    fetcher: async () => ({ ok: true, projects: [] }),
    groupsFetcher: async () => ({
      ok: true,
      observedAt: null,
      warnings: [],
      groups: [{ name: "alpha", memberCount: 1, members: [{ machineId: "win-a", projectId: "board" }] }],
    }),
  });
});

test("BD5-④（§9-c 翻向）3300 宕机降级: 成员区整块灰显「组数据不可用」，manage 页其余照常（不阻断）", async () => {
  await withOrgsServer(async (base) => {
    const res = await get(base, "/org/alpha/manage");
    assert.equal(res.status, 200, "3300 挂了不炸页");
    assert.match(
      res.text,
      /<p class="hint">核对源健康度：声明面成员（3300 <code>GET \/api\/groups<\/code>） <b>读不到<\/b>/,
      "声明面不可达的结论档 = 页头核对短条首档的档位词（★REQ-2026-10-11-05 ⑧a：原「组数据不可用」区块 ⇒ 配置核对卡 danger 徽标 ⇒ 短条 `<b>` 档；原词「读不到」逐字保留）",
    );
    assert.match(res.text, /groups_unreachable/);
    assert.match(res.text, /ECONNREFUSED/, "错误原文如实带出");
    assert.match(res.text, /p-alpha/, "运行态项目面（a2a_projects）不受声明面故障影响");
    assert.match(res.text, /F1/, "本组需求表照常");
    assert.doesNotMatch(
      res.text,
      /<input type="hidden" name="action" value="add">/,
      "⑦b 成员手填表单退役 ⇒ 声明面宕机档也不给表单兜底（本页唯一写通路是拖拽，降级档无写面；登记改造文档 §6）",
    );
  }, {
    fetcher: async (org) =>
      org === "alpha"
        ? { ok: true, projects: [{ machineId: "m1", projectId: "p-alpha", agentKind: "claude", a2aPort: null, status: null, startedAt: null, machineError: null }] }
        : { ok: true, projects: [] },
    groupsFetcher: async () => ({ ok: false, code: "groups_unreachable", error: "ECONNREFUSED 127.0.0.1:3300" }),
  });
});

test("BD5-⑤（§9-c 翻向）全组枚举降级鲁棒 + 未装配: 查询器抛错收口「组数据不可用」；未装配如实「未查询」（不编造无组）", async () => {
  await withOrgsServer(async (base) => {
    const res = await get(base, "/org/alpha/manage");
    assert.equal(res.status, 200);
    assert.match(res.text, /groups_query_failed/);
  }, {
    fetcher: async () => ({ ok: true, projects: [] }),
    groupsFetcher: async () => {
      throw new Error("爆炸（假）");
    },
  });
  await withOrgsServer(async (base) => {
    const res = await get(base, "/org/alpha/manage");
    assert.equal(res.status, 200);
    assert.match(
      res.text,
      /<p class="hint">核对源健康度：声明面成员（3300 <code>GET \/api\/groups<\/code>） <b>未装配<\/b>/,
      "未装配 ⇒ 页头核对短条首档如实标「未装配」（不伪装成有读数；★⑧a 随卡降级换包装，原词保留）",
    );
    assert.match(res.text, /本区不查询（不编造「齐备」也不编造「缺失」）/, "未装配 ⇒ 不臆造任何一侧结论（原「不编造无成员」语义等价、字面换新）");
  }, { fetcher: async () => ({ ok: true, projects: [] }), groupsFetcher: null });
});

// ---------------------------------------------------------------------------
// REQ-2026-10-10-03 N4 · 管理页项目表置顶的新增锚（N-1 首卡 / N-2 相对序 / N-3 删卡负锚新锚位）
// 局部夹具 = 直调 `renderOrgSpaceManagePage`（本文件的 harness 不装配池 ⇒ `id="member-pool"`
// 只在这次直调里存在；不改既有 `withOrgsServer` 夹具结构）。
// ---------------------------------------------------------------------------

const PIN_PROJECTS_OK = {
  ok: true,
  projects: [{ machineId: "m1", projectId: "p-a1", agentKind: "claude", a2aPort: 3017, status: "online", startedAt: null, machineError: null }],
};
const PIN_GROUPS_DECLARED = {
  ok: true,
  observedAt: "2026-10-10T00:00:00.000Z",
  warnings: [],
  groups: [{ name: "alpha", memberCount: 1, members: [{ machineId: "m1", projectId: "p-a1" }] }],
};
const PIN_POOL_OK = { ok: true, rows: [{ machineId: "m9", projectId: "p-free", lastReportedAt: null }], observedAt: null };

const pinHtml = renderOrgSpaceManagePage({
  org: "alpha",
  features: [],
  projectsOutcome: PIN_PROJECTS_OK,
  groupsOutcome: PIN_GROUPS_DECLARED,
  poolOutcome: PIN_POOL_OK,
  poolSourceCount: 2,
});

/** 卡头起点（`b-card-h` 内层标题的字面）—— N-2 的五个比较对象就是其余五块（⑦b 台账卡退役后）。 */
const cardHeadAt = (label) => pinHtml.indexOf(`b-card-h">${label}`);

test("置顶-①（N-1 · REQ-2026-10-10-03）项目卡 = 整页第一张 b-card（防「首卡错」）", () => {
  const i = pinHtml.indexOf('<div class="b-card"');
  assert.ok(i >= 0, "夹具页至少渲出一张 b-card（切片起点在位）");
  // 窗口取 80 而非 60：needle 自卡起点偏移 21（`<div class="b-card">` + 换行）起、长 48 ⇒ 60 会截断 needle 本身。
  assert.ok(
    pinHtml.slice(i, i + 80).includes('<p class="b-card-h">项目<span class="b-card-meta">'),
    "第一张卡的卡头逐字为「项目 + b-card-meta」⇒ 项目表置顶成立",
  );
});

test("置顶-②（N-2 · REQ-2026-10-10-03）项目卡先于池卡与其余四块（防「相对序错」，与置顶-① 分工不同；⑦b 台账卡退役后计数 -1；★⑧a 核对卡降为页头短条后计数再 -1）", () => {
  const projectIdx = cardHeadAt("项目");
  assert.ok(projectIdx >= 0, "项目卡卡头在位");
  assert.ok(projectIdx < pinHtml.indexOf('id="member-pool"'), "项目卡先于两栏池容器（置顶后第一块 = 项目）");
  for (const label of [
    "加 / 删项目（两栏拖拽）",
    "本组织 agent 配置",
    "停用本组织",
    "需求",
  ]) {
    const at = cardHeadAt(label);
    assert.ok(at >= 0, `其余块「${label}」仍在页上（缺席不得当成「排在后面」）`);
    assert.ok(projectIdx < at, `项目卡必须先于「${label}」`);
  }
  // ★⑧a 改判：原第五块「配置核对」**卡**已降级为页头短条 ⇒ 不再参与卡序比较；
  //   它的承载改钉两件事：① 短条在场且**先于**项目卡（页头位，不是卡位）；② 卡头字面「配置核对」不复活。
  const barIdx = pinHtml.indexOf('<p class="hint">核对源健康度：');
  assert.ok(barIdx >= 0, "⑧a 页头核对短条在场（缺席不得当成「排在前面」）");
  assert.ok(barIdx < projectIdx, "核对短条落在页头（`<h2>管理 · …` 之后、项目卡之前）");
  assert.equal(cardHeadAt("配置核对"), -1, "⑧ 核对卡不复活：整页无「配置核对」卡头");
});

test("置顶-③（N-3 · REQ-2026-10-10-03 新锚位）退役卡不复活：整页不出现「成员（声明态」（与 N3-① / BD5-③ 各自成条）", () => {
  assert.doesNotMatch(pinHtml, /成员（声明态/, "本夹具（项目面可读 + 声明面已装配 + 池已装配）下同样不得渲出退役的逐组声明态成员清单卡");
});

test("置顶-④（⑦b · REQ-2026-10-11-05 N8 新锚位）成员手填表单与「成员（项目组台账）」卡不复活（同夹具另成一条）", () => {
  assert.equal(cardHeadAt("成员（项目组台账）"), -1, "台账卡卡头整块退役 ⇒ 卡头字面在夹具页零命中（拿它当排序对象会静默失效，见置顶-②）");
  assert.doesNotMatch(pinHtml, /id="member-forms-fold"/, "折叠宿主不复活");
  assert.doesNotMatch(pinHtml, /<form method="post" action="\/orgs\/alpha\/members"/, "两枚手填表单不复活（拖拽是唯一成员写通路）");
  assert.doesNotMatch(pinHtml, /<b>末位成员不可删<\/b>/, "卡内常驻「末位不可删」警示条随表单退役（口径只剩服务端 409，登记改造文档 §6）");
});

// ---------------------------------------------------------------------------
// ⑨ 管理页需求表链接式分页（REQ-2026-10-11-05 · N11 · 每页 10 条 · 零脚本）
// ---------------------------------------------------------------------------

/**
 * 造 n 条某组织的需求，`createdAt` 逐日**递增** ⇒ 复用需求池那把尺（`comparePoolEntry` = createdAt 降序）
 * 排完后**新号在前**（PF25 第一条），页序可机械核对。
 */
const pagedFeatures = (n, org = "alpha", prefix = "PF") =>
  Array.from({ length: n }, (_, i) =>
    feature(`${prefix}${String(i + 1).padStart(2, "0")}`, org, {
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
    }),
  );

/** 需求卡整块（卡头 → 该卡收尾 `</div>`，含表体与表尾翻页链）。 */
function featuresCardRegion(html) {
  const start = html.indexOf('<p class="b-card-h">需求<span class="b-card-meta">');
  assert.ok(start >= 0, "需求卡卡头在位（缺席不得当成「行数为 0」）");
  const end = html.indexOf("</div>", start);
  assert.ok(end >= 0, "需求卡有收尾");
  return html.slice(start, end);
}

const featureRowCount = (html) => (featuresCardRegion(html).match(/<tr><td/g) ?? []).length;
const pagerOf = (html) => {
  const region = featuresCardRegion(html);
  const i = region.indexOf('<nav class="pager">');
  return i < 0 ? "" : region.slice(i, region.indexOf("</nav>", i) + "</nav>".length);
};
/** 翻页链 href 里的 page 尾值（注入面判据：只能是归一后的整数）。 */
const pagerQueryValues = (html) => [...featuresCardRegion(html).matchAll(/\?page=([^"&]*)/g)].map((m) => m[1]);

const viewPage = (features, paging = {}) =>
  renderOrgSpaceManagePage({
    org: "alpha",
    features,
    projectsOutcome: PIN_PROJECTS_OK,
    groupsOutcome: PIN_GROUPS_DECLARED,
    poolOutcome: PIN_POOL_OK,
    poolSourceCount: 2,
    ...paging,
  });

/** 25 条 alpha 需求的服务端夹具（三页：PF25–16 / PF15–06 / PF05–01）。 */
function serverWithFeatures(n = 25, org = "alpha", prefix = "PF") {
  const all = pagedFeatures(n, org, prefix);
  return {
    client: fakeClient({
      async getFeatures() {
        return { features: all, stateCounts: null };
      },
    }),
    fetcher: async () => ({ ok: true, projects: [] }),
  };
}

test("⑨-①（新锚 · 页链在场）total > pageSize ⇒ 翻页链在场、含第二页链、「共 N 条」总数文案；首/末页方向钮不渲灰壳", () => {
  const all = pagedFeatures(25);
  const first = viewPage(all.slice(15, 25), { page: 1, pageSize: ORG_FEATURES_PAGE_SIZE, total: 25 });
  const pager = pagerOf(first);
  assert.ok(pager !== "", "正常档翻页链必须在场（缺席不得当成「只有一页」）");
  assert.match(first, /href="\/org\/alpha\/manage\?page=2"/, "第二页链走 orgSpaceLink 口径（路径段 + query）");
  assert.match(pager, /共 25 条/, "总数文案 = 全量条数（不是本页行数）");
  assert.match(pager, /第 1\/3 页/);
  assert.doesNotMatch(pager, /上一页/, "首页 ⇒「上一页」不渲（不渲灰壳）");
  assert.match(pager, /下一页/, "非末页 ⇒「下一页」在场");
  const last = viewPage(all.slice(20, 25), { page: 3, pageSize: ORG_FEATURES_PAGE_SIZE, total: 25 });
  assert.match(pagerOf(last), /上一页/);
  assert.doesNotMatch(pagerOf(last), /下一页/, "末页 ⇒「下一页」不渲");
  assert.doesNotMatch(pagerOf(last), /\?page=4/, "末页之后不得有链");
});

test("⑨-②（新锚 · 行数 = 每页条数 + 排序同尺）HTTP 真通路表体恰 ORG_FEATURES_PAGE_SIZE 行，页序 = comparePoolEntry 的 createdAt 降序", async () => {
  assert.equal(ORG_FEATURES_PAGE_SIZE, 10, "用户裁定 = 每页 10 条（单点常量唯一定义处）");
  await withOrgsServer(async (base) => {
    const p1 = await get(base, "/org/alpha/manage");
    assert.equal(p1.status, 200);
    assert.equal(featureRowCount(p1.text), ORG_FEATURES_PAGE_SIZE, "未带 query ⇒ 第 1 页恰每页条数行");
    assert.match(p1.text, /\/features\/PF25"/, "第 1 页首位 = createdAt 最新者（降序 = 池同一把尺）");
    assert.match(p1.text, /\/features\/PF16"/, "第 1 页末位 = PF16（切页边界内）");
    assert.doesNotMatch(p1.text, /\/features\/PF15"/, "PF15 不得出现在第 1 页");
    const p2 = await get(base, "/org/alpha/manage?page=2");
    assert.equal(featureRowCount(p2.text), ORG_FEATURES_PAGE_SIZE, "第 2 页同样恰每页条数行");
    assert.match(p2.text, /\/features\/PF15"/, "第 2 页首位 = PF15（连续序无重排无漏项）");
    assert.doesNotMatch(p2.text, /\/features\/PF25"/, "第 2 页不得重复第 1 页内容");
  }, serverWithFeatures());
});

test("⑨-③（新锚 · 空态）total=0 ⇒ 不渲翻页链，空态行文案逐字未变；不足一页同样不渲链", () => {
  const empty = viewPage([], { page: 1, pageSize: ORG_FEATURES_PAGE_SIZE, total: 0 });
  assert.equal(pagerOf(empty), "", "空态不渲链（不得改成「空态 + 一条 1/1 链」）");
  assert.match(empty, /<tr><td colspan="6" class="empty">（该组织暂无需求）<\/td><\/tr>/, "既有空态行原文案保留（含 colspan 6）");
  assert.match(empty, /本组 0 条/, "卡头报全量条数（0）");
  const single = viewPage(pagedFeatures(3), { page: 1, pageSize: ORG_FEATURES_PAGE_SIZE, total: 3 });
  assert.equal(pagerOf(single), "", "单页档 ⇒ 不渲噪音链");
  assert.equal(featureRowCount(single), 3);
});

test("⑨-④（新锚 · fail-closed 回落）非法 / 越界 page ⇒ 一律第 1 页照常渲染，页面不回显原值", async () => {
  await withOrgsServer(async (base) => {
    for (const raw of ["abc", "%3Cscript%3Ealert(1)%3C%2Fscript%3E", "0", "-3", "2.5", "", "99"]) {
      const res = await get(base, `/org/alpha/manage?page=${raw}`);
      assert.equal(res.status, 200, `非法/越界 page=${raw} ⇒ 不 400`);
      assert.equal(featureRowCount(res.text), ORG_FEATURES_PAGE_SIZE, `page=${raw} ⇒ 回落第 1 页且满页渲染（不得空白页）`);
      assert.match(res.text, /第 1\/3 页/, `page=${raw} ⇒ 归一为第 1 页`);
      assert.match(res.text, /\/features\/PF25"/, `page=${raw} ⇒ 渲的是第 1 页内容`);
      for (const v of pagerQueryValues(res.text)) {
        assert.match(v, /^\d*$/, `href 里的 page 只能是归一后的整数（原值 ${raw} 不得进拼接）`);
      }
    }
    const inj = await get(base, "/org/alpha/manage?page=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    assert.doesNotMatch(inj.text, /alert\(1\)/, "反射型注入面：原样回显零命中");
    assert.doesNotMatch(inj.text, /page=abc/, "非法原值不得出现在任何 href / 文案里");
  }, serverWithFeatures());
});

test("⑨-⑤（新锚 · 缺省向后兼容）三参数全不传 ⇒ 全量渲染 + 零翻页链 + 卡头文案逐字不变", () => {
  const all = pagedFeatures(25);
  const full = viewPage(all);
  assert.equal(featureRowCount(full), 25, "缺省 ⇒ 全量渲染（不切页）");
  assert.equal(pagerOf(full), "", "缺省 ⇒ 不渲链（既有形态零变化）");
  assert.match(full, /本组 25 条/, "卡头文案与本节点改动前逐字一致");
  assert.doesNotMatch(full, /\?page=/, "缺省档整页零 query ⇒ 老锚面不可能因本节点被改判");
});

test("⑨-⑥（新锚 · 零脚本负钉）分页无任何脚本承载（内联闭集八元不扩）", () => {
  const paged = viewPage(pagedFeatures(25).slice(15, 25), {
    page: 2,
    pageSize: ORG_FEATURES_PAGE_SIZE,
    total: 25,
  });
  assert.doesNotMatch(paged, /<script[^>]*page/, "分页无脚本承载（翻页链只可能是 <a href>）");
  assert.doesNotMatch(featuresCardRegion(paged), /<script/, "需求卡区块（表体 + 翻页链）零 <script");
  assert.doesNotMatch(paged, /data-live/, "本节点不接 live 槽（页级就地刷新是 N5 的形态，不扩锚）");
});

test("⑨-⑦（新锚 · PRG 保页码）agent 配置写成功 303 回带原页码；无 page / 非法 page ⇒ 干净 URL（既有 303 锚逐字不变）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-n11-prg-"));
  try {
    mkdirSync(join(dir, "data"), { recursive: true });
    const ledgerFile = join(dir, "data", "orgs.json");
    writeFileSync(
      ledgerFile,
      JSON.stringify({ version: 2, orgs: [{ org: "alpha", disabledAt: null, agentKind: null, agentModel: null }] }, null, 2) + "\n",
      "utf8",
    );
    await withOrgsServer(
      async (base) => {
        const post = (referer) =>
          fetch(`${base}/orgs`, {
            method: "POST",
            redirect: "manual",
            headers: { origin: base, referer, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ org: "alpha", action: "setHostAgent", agentKind: "qoder", agentModel: "" }).toString(),
          });
        const kept = await post(`${base}/org/alpha/manage?page=3`);
        assert.equal(kept.status, 303);
        assert.equal(kept.headers.get("location"), "/org/alpha/manage?page=3", "PRG 回带原页码 ⇒ 写后不跳回第 1 页");
        const clean = await post(`${base}/org/alpha/manage`);
        assert.equal(clean.headers.get("location"), "/org/alpha/manage", "无 page 键 ⇒ 干净 URL（既有 HA-① 锚不变）");
        const bogus = await post(`${base}/org/alpha/manage?page=%3Cscript%3E`);
        assert.equal(bogus.headers.get("location"), "/org/alpha/manage", "非法页码不进 Location（不回显原值）");
      },
      { fetcher: async () => ({ ok: true, projects: [] }), orgsLedgerFile: ledgerFile },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑨-⑧（新锚 · 编码自测）org 名需百分号编码时第 2 页链 round-trip 仍在同一 org 的第 2 页（段编码不被 query 吞）", async () => {
  // 闭集内合法、且 URL 段必须百分号编码的档位 = 中文名。空格 / `/` 不在组织名闭集内（validateOrgName
  // 禁 空格 # ? % /），故那两档在**运行态不可达**（见回执「自测项结论」），此处取段编码的真实档。
  const org = "研发一组";
  const encoded = encodeURIComponent(org);
  await withOrgsServer(async (base) => {
    const p2 = await get(base, `/org/${encoded}/manage?page=2`);
    assert.equal(p2.status, 200, "编码段 + query 组合仍命中同一 org 的 manage 页（不掉门户、不 404）");
    assert.equal(featureRowCount(p2.text), ORG_FEATURES_PAGE_SIZE);
    assert.match(p2.text, /\/features\/CF15"/, "第 2 页内容 = 连续序第 11–20 条");
    assert.ok(
      featuresCardRegion(p2.text).includes(`href="/org/${encoded}/manage?page=3"`),
      `链里的路径段按 orgSpaceLink 编码、query 未被吞（实测 href=${featuresCardRegion(p2.text).match(/href="[^"]*page=3"/)?.[0] ?? "无"}）`,
    );
    assert.doesNotMatch(p2.text, /%25/, "不得二次编码（%E7… 不得变 %25E7…）");
    const p3 = await get(base, `/org/${encoded}/manage?page=3`);
    assert.equal(p3.status, 200);
    assert.match(p3.text, /第 3\/3 页/);
  }, serverWithFeatures(25, org, "CF"));
});
