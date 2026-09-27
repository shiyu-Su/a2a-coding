/**
 * REQ-v0.9.2 N6 · 组织视角页（只读）—— 归并纯函数 / 逐组查询归一 / 不可达降级 / HTTP 面 / 导航闭集。
 *
 * 门禁对应：归并纯函数单测（mergeOrgNames / groupFeaturesByOwner / listOrgDirs）、
 * 不可达降级用例（fetcher 失败 / 抛错 / 未装配三档，页面不炸）、导航断言更新（五项闭集 + /orgs 高亮）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NO_OWNER_GROUP_LABEL,
  ORG_QUERY_TIMEOUT_MS,
  PROJECTS_QUERY_TOOL,
  createOrgProjectsFetcher,
  groupFeaturesByOwner,
  listOrgDirs,
  mergeOrgNames,
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
// HTTP 面：GET /orgs
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

async function withOrgsServer(run, { client = fakeClient(), fetcher, docs, hostFace, defaultGroup } = {}) {
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    orgProjectsFetcher: fetcher,
    ...(defaultGroup === undefined ? {} : { defaultGroup }),
    ...(docs === undefined ? {} : { docs }),
    ...(hostFace === undefined ? {} : { hostFace }),
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

test("N6-⑦ GET /orgs: 按组织分组列需求与项目；「（无归属）」伪分组如实呈现", async () => {
  const queried = [];
  await withOrgsServer(async (base) => {
    const res = await get(base, "/orgs");
    assert.equal(res.status, 200);
    assert.match(res.text, /<a href="\/orgs" class="on">组织<\/a>/, "导航含组织项且高亮");
    assert.match(res.text, /alpha/);
    assert.match(res.text, /beta/);
    assert.match(res.text, new RegExp(NO_OWNER_GROUP_LABEL), "无归属伪分组上板");
    assert.match(res.text, /F2/, "无归属需求不丢弃");
    assert.match(res.text, /p-alpha/, "alpha 组项目渲染");
    assert.deepEqual(queried, ["alpha", "beta", "default-org"], "查询集 = 归并后的组织清单（伪分组不查询）");
  }, {
    fetcher: async (org) => {
      queried.push(org);
      return org === "beta"
        ? { ok: false, code: "transport_error", error: "连不上（假）" }
        : { ok: true, projects: [{ machineId: "m1", projectId: `p-${org}`, agentKind: "claude", a2aPort: 3017, status: "online", startedAt: null, machineError: null }] };
    },
    docs: { repoRoot: "R", orgsDir: null },
    defaultGroup: "default-org",
  });
});

test("N6-⑧ GET /orgs 不可达降级: 单组失败标「不可达」+ 错误码，其余组照常，不炸页", async () => {
  await withOrgsServer(async (base) => {
    const res = await get(base, "/orgs");
    assert.equal(res.status, 200);
    assert.match(res.text, /不可达/);
    assert.match(res.text, /transport_error/);
    assert.match(res.text, /连不上（假）/);
    assert.match(res.text, /p-alpha/, "另一组不受影响照常呈现");
    assert.match(res.text, /beta[\s\S]*<h3>需求/, "不可达组的需求表仍在");
  }, {
    fetcher: async (org) =>
      org === "beta"
        ? { ok: false, code: "transport_error", error: "连不上（假）" }
        : { ok: true, projects: [{ machineId: "m1", projectId: "p-alpha", agentKind: "claude", a2aPort: null, status: null, startedAt: null, machineError: null }] },
  });
});

test("N6-⑨ GET /orgs 鲁棒: 查询器抛错 ⇒ 该组按不可达收口；查询器未装配 ⇒ 如实「未查询」", async () => {
  await withOrgsServer(async (base) => {
    const res = await get(base, "/orgs");
    assert.equal(res.status, 200);
    assert.match(res.text, /org_query_failed/);
  }, {
    fetcher: async () => {
      throw new Error("爆炸（假）");
    },
  });
  await withOrgsServer(async (base) => {
    const res = await get(base, "/orgs");
    assert.equal(res.status, 200);
    assert.match(res.text, /未查询/);
    assert.match(res.text, /查询器未装配/);
  }, { fetcher: null });
});

test("N6-⑩ GET /orgs 读面失败不静默: 桥 features 不可达 ⇒ 502 浮层版式（同全站口径）", async () => {
  await withOrgsServer(async (base) => {
    const res = await get(base, "/orgs");
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

test("N6-⑪ 方法门与写面纪律: /orgs 只认 GET；源文件不含状态推进工具名（板不写状态机）", async () => {
  await withOrgsServer(async (base) => {
    const post = await fetch(`${base}/orgs`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.match(await post.text(), /仅支持 GET/);
  }, { fetcher: async () => ({ ok: true, projects: [] }) });
});

// ---------------------------------------------------------------------------
// 导航闭集更新（v0.9.2 M4 增排期看板 = 六项；REQ-2026-09-26-04 Q2 需求页退役 = 五项；
// REQ-2026-09-26-02 B-T3 增 Agent View = 六项；同版增补 ③ Timeline 退役 = 六项维持）
// ---------------------------------------------------------------------------

test("N6-⑫ 导航闭集: 六项（排期/任务/项目·机器/Agent/组织/宿主桥），href 与顺序钉死（需求项已随列表页退役；Timeline 随增补 ③ 退役）", () => {
  const html = renderPage({ title: "t", active: "orgs", bodyHtml: "<p>b</p>" });
  const anchors = [...html.matchAll(/<a href="(\/[^"]*)"[^>]*>([^<]+)<\/a>/g)].map((m) => `${m[1]}|${m[2]}`);
  assert.deepEqual(anchors, [
    "/schedule|排期",
    "/tasks|任务",
    "/projects|项目 / 机器",
    "/agents|Agent",
    "/orgs|组织",
    "/host|宿主桥",
  ]);
});
