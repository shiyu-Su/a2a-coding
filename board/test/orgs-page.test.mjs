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

test("N3-①（§9-c 新锚）GET /org/<名>/manage: 成员区（声明态清单 + 增删表单）+ 停用表单，表单 action 逐字对齐全局写口", async () => {
  await withOrgsServer(async (base) => {
    const res = await get(base, "/org/alpha/manage");
    assert.equal(res.status, 200);
    assert.match(res.text, /管理 · alpha/, "页标题 = 空间内管理");
    // 成员清单 = 3300 全组枚举的该组投影（本用例 groupsFetcher 未装配 ⇒ 如实「未查询」，见 N3-③）
    assert.match(res.text, /成员（声明态 · <code>GET \/api\/groups<\/code> 该组投影）/);
    // 表单 action **不带空间前缀**：归一层不扩写路由，成员写仍是那一条全局 `POST /orgs/{org}/members`
    assert.match(res.text, /<form method="post" action="\/orgs\/alpha\/members"[^>]*data-submit="已提交，加成员中…" data-ov="1">/);
    assert.match(res.text, /<input type="hidden" name="action" value="add">/);
    assert.match(res.text, /<input type="hidden" name="action" value="remove">/);
    assert.match(res.text, /name="machineId" required/);
    assert.match(res.text, /name="projectId" required/);
    assert.doesNotMatch(res.text, /action="\/org\//, "空间内表单的 action 一律全局路径（不出现 `/org/…` 写径变体）");
    // 停用 = 同一条 `POST /orgs`（action=disable），写路由白名单零扩条
    assert.match(res.text, /<form method="post" action="\/orgs" class="inline" data-submit="已提交，停用中…" data-ov="1" data-ov-redirect="\/">/);
    assert.match(res.text, /<input type="hidden" name="org" value="alpha">/);
    // 空间导航含 manage 入口且高亮
    assert.match(res.text, /<a class="fl" href="\/org\/alpha\/manage" style="font-weight:700">管理<\/a>/);
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
    assert.match(res.text, /成员（声明态/, "成员区照常呈现");
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
// REQ-2026-09-27-06 §9-c 组织管理页退役 ⇒ 摘「组织」= 六项）
// ---------------------------------------------------------------------------

test("N6-⑫（§9-c 翻向）导航闭集: 六项（首页/排期/任务/项目·机器/Agent/宿主桥），href 与顺序钉死；/orgs 链接已摘", () => {
  const html = renderPage({ title: "t", active: "schedule", bodyHtml: "<p>b</p>" });
  const anchors = [...html.matchAll(/<a href="(\/[^"]*)"[^>]*>([^<]+)<\/a>/g)].map((m) => `${m[1]}|${m[2]}`);
  assert.deepEqual(anchors, [
    "/|首页",
    "/schedule|排期",
    "/tasks|任务",
    "/projects|项目 / 机器",
    "/agents|Agent",
    "/host|宿主桥",
  ]);
  assert.doesNotMatch(html, /href="\/orgs"/, "NAV 不得再含 /orgs（页退役 ⇒ 303，链接不留守）");
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
    assert.match(home.text, /<label>组织名 \*<input name="org" required/, "字段名 = write-guard.ORG_FORM_FIELD = org");
    assert.match(home.text, /中文 \/ 字母（Latin）\/ 数字/, "闭集 hint 上板");
    assert.match(home.text, /不触桥、不写状态机、不写 machine 配置/, "写面口径上板");
    assert.doesNotMatch(home.text, /<script src>/, "无外源脚本（§9.5 复用的仍是既有六元常量，未引入新枚）");
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
    assert.match(res.text, /成员（声明态 · <code>GET \/api\/groups<\/code> 该组投影）/, "声明面区块上板");
    assert.match(res.text, /该组声明成员 2 项/);
    assert.match(res.text, /<td>win-a<\/td><td>board<\/td>/, "成员项逐行（machineId / projectId 两列）");
    assert.match(res.text, /组 gamma 缺成员，已忽略/, "warnings 如实呈现");
    assert.match(res.text, /不参与任何判定/, "warnings 口径钉死为纯呈现");
    assert.match(res.text, /观测时刻 2026-09-27T02:00:00.000Z/, "observedAt 上板（声明是快照不是实时）");
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
    assert.match(res.text, /组数据不可用/);
    assert.match(res.text, /groups_unreachable/);
    assert.match(res.text, /ECONNREFUSED/, "错误原文如实带出");
    assert.match(res.text, /p-alpha/, "运行态项目面（a2a_projects）不受声明面故障影响");
    assert.match(res.text, /F1/, "本组需求表照常");
    assert.match(res.text, /<input type="hidden" name="action" value="add">/, "成员写表单照常给出（不因声明面宕机而失去管理入口）");
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
    assert.match(res.text, /全组枚举查询器未装配/);
    assert.match(res.text, /不编造「无成员」/, "未装配 ⇒ 不臆造空清单");
  }, { fetcher: async () => ({ ok: true, projects: [] }), groupsFetcher: null });
});
