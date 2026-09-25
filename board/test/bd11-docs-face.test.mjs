/**
 * BD11 用例（REQ-v0.9.1-2026-09-25-04 · 判据 3/4）：读文档面的 **HTTP 层 + 渲染层**。
 *
 * 覆盖：
 * ① 详情页「阶段产出」区块 = 双源清单 + 来源标注 + 分类标注（临时盘真读）；version 不合白名单
 *    ⇒ 区块如实显示「无」且不出链接；
 * ② 详情页「产出登记」区 = decisions 逐条渲染、doc 路径成可点条目、非路径元素原样（判据 3）；
 * ③ `GET /features/:id/docs?file=` = `text/plain; charset=utf-8` + `no-store`、超限截断提示、
 *    `Accept: text/html` ⇒ `<pre>` 转义整页；越界名 / 缺失 ⇒ 4xx **不泄根路径**（判据 1 的 HTTP 档）；
 * ④ 读面恒 GET（非 GET ⇒ 405）、不过 CSRF；`parseFeatureDetail` 补解析 decisions/contracts（容错 null）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";
import { parseFeatureDetail } from "../dist/bridge-client.js";
import { MAX_DOC_FILE_BYTES } from "../dist/docs-read.js";
import { extractDocPath, parseDecisionItems, renderFeatureDetail } from "../dist/web/views.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

/** 建双源临时盘：A = <disk>/doc/{version}/，B = <disk>/orgs/org1/doc/{version}/。 */
function tmpDisk() {
  return mkdtempSync(join(tmpdir(), "board-bd11-"));
}

function put(disk, source, version, name, content = "# doc\n") {
  const base = source === "A" ? join(disk, "doc", version) : join(disk, "orgs", "org1", "doc", version);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, name), content, "utf8");
  return join(base, name);
}

/** 假桥客户端：详情可覆盖 feature 字段（decisions / version / ownerGroup）。 */
function fakeClient(featureOver = {}) {
  const calls = [];
  const feature = {
    featureId: "F1",
    state: "executing",
    title: "阶段产出上板",
    plan: null,
    ownerGroup: "org1",
    stage: "改造方案",
    version: "v1.2.3",
    approval: "已通过",
    decisions: null,
    contracts: null,
    createdAt: "c",
    updatedAt: "u",
    ...featureOver,
  };
  return {
    calls,
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        return { features: [], stateCounts: {} };
      },
      async getFeature(featureId) {
        calls.push(`getFeature:${featureId}`);
        return { feature: { ...feature, featureId }, tasks: [] };
      },
      async getFeatureTrace(featureId) {
        return { featureId, featureState: feature.state, nodes: [] };
      },
      async getProjects() {
        return { source: null, note: null, observedAt: null, machines: [], runners: [] };
      },
      async getTasks(projectId) {
        return { projectId, reachable: true, notice: null, tasks: [] };
      },
    },
  };
}

async function withServer(run, { featureOver, docs } = {}) {
  const { client, calls } = fakeClient(featureOver);
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, client, now: () => NOW, docs });
  try {
    await run(`http://127.0.0.1:${handle.port}`, calls);
  } finally {
    await handle.close();
  }
}

async function fetchText(base, path, headers) {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

// ---------------------------------------------------------------------------
// ① 阶段产出区块（双源清单 + 标注 + 降级）
// ---------------------------------------------------------------------------

test("详情页「阶段产出」：双源清单合并 + 分类标注 + 来源标注 + 链接带 src", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "阶段产出上板-改造文档.md", "# 改造文档 A\n");
    put(disk, "B", "v1.2.3", "改造文档-阶段产出上板.md", "# 改造文档 B\n");
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1");
        assert.equal(res.status, 200);
        assert.match(res.text, /<h2>阶段产出<\/h2>/);
        assert.match(res.text, /阶段产出上板-改造文档\.md/);
        assert.match(res.text, /改造文档-阶段产出上板\.md/);
        assert.match(res.text, /<td>改造文档<\/td>/);
        assert.match(res.text, /<td>主仓<\/td>/);
        assert.match(res.text, /<td>组织工作区<\/td>/);
        assert.match(res.text, /href="\/features\/F1\/docs\?file=%E9%98%B6/);
        assert.match(res.text, /src=B/);
      },
      { docs: { repoRoot: disk, orgsDir: join(disk, "orgs") } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("version 不合白名单 ⇒ 区块如实显示「无」且不出链接", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "ok-改造文档.md");
    await withServer(
      async (base, calls) => {
        const res = await fetchText(base, "/features/F1");
        assert.equal(res.status, 200);
        assert.match(res.text, /<h2>阶段产出<\/h2>\s*<p class="hint">无（版本「v9」/);
        assert.doesNotMatch(res.text, /\/features\/F1\/docs\?file=/);
        assert.deepEqual(calls, ["getFeature:F1"]);
      },
      { featureOver: { version: "v9" }, docs: { repoRoot: disk, orgsDir: join(disk, "orgs") } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("两源皆无目录 ⇒ 区块显示无（不报错、页仍 200）", async () => {
  const disk = tmpDisk();
  try {
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1");
        assert.equal(res.status, 200);
        assert.match(res.text, /<h2>阶段产出<\/h2>\s*<p class="hint">无（两源/);
      },
      { docs: { repoRoot: join(disk, "nope"), orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ② 产出登记区（判据 3：b 案渲染）
// ---------------------------------------------------------------------------

test("产出登记：decisions 逐条渲染 · doc 路径成可点条目 · 非路径元素原样显示", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "阶段产出上板-需求确认单.md", "# 确认单\n正文\n");
    const decisions = JSON.stringify([
      "裁决 ①：文档根取双源合并",
      "产出：doc/v1.2.3/阶段产出上板-需求确认单.md（v2 含裁决记录）",
    ]);
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1");
        assert.match(res.text, /<h2>产出登记（decisions）<\/h2>/);
        const rows = res.text.match(/<ul class="docs">(.*?)<\/ul>/s);
        assert.ok(rows, "产出登记区必须是列表");
        const items = rows[1].split("</li>").filter((s) => s.includes("<li>"));
        assert.equal(items.length, 2, "两条元素逐条渲染");
        assert.match(items[0], /裁决 ①：文档根取双源合并/);
        assert.ok(!/\/docs\?file=/.test(items[0]), "非 doc 路径元素原样显示、不出链接");
        assert.match(items[1], /<a class="fl" href="\/features\/F1\/docs\?file=[^"]*">打开/);
      },
      { featureOver: { decisions }, docs: { repoRoot: disk, orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("产出登记：无 decisions ⇒ 如实显示无（不编造）", async () => {
  await withServer(
    async (base) => {
      const res = await fetchText(base, "/features/F1");
      assert.match(res.text, /<h2>产出登记（decisions）<\/h2>[\s\S]*（无产出登记：decisions 未登记或桥未透出）/);
    },
    { docs: { repoRoot: join(tmpdir(), "board-bd11-不存在"), orgsDir: null } },
  );
});

test("decisions 纯函数：JSON 数组逐元素 · 非 JSON 整段一条 · 空为 []", () => {
  assert.deepEqual(parseDecisionItems('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseDecisionItems("非 JSON 的一段登记"), ["非 JSON 的一段登记"]);
  assert.deepEqual(parseDecisionItems(null), []);
  assert.deepEqual(parseDecisionItems("  "), []);
  assert.deepEqual(extractDocPath("产出：doc/v1.2.3/x-改造文档.md"), { version: "v1.2.3", file: "x-改造文档.md" });
  assert.equal(extractDocPath("没有路径的一句话"), null);
});

test("产出登记区转义：元素里的尖括号不得逃成标签", () => {
  const html = renderFeatureDetail(
    {
      feature: {
        featureId: "F1",
        state: "executing",
        title: "t",
        plan: null,
        ownerGroup: null,
        stage: null,
        version: null,
        approval: null,
        decisions: JSON.stringify(['<img src=x onerror=alert(1)> doc/v1.2.3/a.md']),
        contracts: null,
        createdAt: null,
        updatedAt: null,
      },
      tasks: [],
    },
    null,
    null,
    NOW,
    null,
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// ---------------------------------------------------------------------------
// ③ 单文档 GET
// ---------------------------------------------------------------------------

test("GET /features/:id/docs?file= ⇒ text/plain + no-store + 原文直出（源 A / 源 B）", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "a-改造文档.md", "# A 侧正文 & <tag>\n");
    put(disk, "B", "v1.2.3", "b-需求确认单.md", "# B 侧正文\n");
    await withServer(
      async (base, calls) => {
        const a = await fetchText(base, `/features/F1/docs?file=${encodeURIComponent("a-改造文档.md")}`);
        assert.equal(a.status, 200);
        assert.equal(a.headers.get("content-type"), "text/plain; charset=utf-8");
        assert.equal(a.headers.get("cache-control"), "no-store");
        assert.equal(a.text, "# A 侧正文 & <tag>\n", "原文直出、不转义不渲染");
        const b = await fetchText(
          base,
          `/features/F1/docs?file=${encodeURIComponent("b-需求确认单.md")}&src=B`,
        );
        assert.equal(b.status, 200);
        assert.equal(b.text, "# B 侧正文\n");
        assert.ok(calls.every((c) => c === "getFeature:F1"), "只读详情取版本，不二次查询");
      },
      { docs: { repoRoot: disk, orgsDir: join(disk, "orgs") } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("GET docs 负例：.. / 绝对路径 / 非 .md / 缺失 ⇒ 4xx 且不泄根路径", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "ok.md");
    await withServer(
      async (base) => {
        for (const file of ["..", "../ok.md", "%2e%2e/ok.md", "/etc/passwd.md", "a\\b.md", "x.txt", "nope.md"]) {
          const res = await fetchText(base, `/features/F1/docs?file=${encodeURIComponent(file)}`);
          assert.ok(res.status === 400 || res.status === 404, `${file} ⇒ ${res.status}`);
          assert.equal(res.headers.get("cache-control"), "no-store");
          assert.ok(!res.text.includes(disk), `响应不得泄根路径：${file} → ${res.text}`);
        }
      },
      { docs: { repoRoot: disk, orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("GET docs 超 256KiB ⇒ 只给前段 + 截断提示", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "big.md", "あ".repeat(MAX_DOC_FILE_BYTES));
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1/docs?file=big.md");
        assert.equal(res.status, 200);
        assert.match(res.text, /已截断/);
        assert.ok(Buffer.byteLength(res.text, "utf8") < MAX_DOC_FILE_BYTES + 4096);
      },
      { docs: { repoRoot: disk, orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("GET docs 浏览器档原文视图（mode=raw，BD14 双档之原文档）⇒ 整页 <pre> 转义 + CSP 头", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "esc.md", "<script>alert(1)</script>\n");
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1/docs?file=esc.md&mode=raw", {
          accept: "text/html,application/xhtml+xml",
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /text\/html/);
        assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
        assert.match(res.text, /<pre class="result">&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.doesNotMatch(res.text, /<script>alert\(1\)<\/script>/);
      },
      { docs: { repoRoot: disk, orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("GET docs 未登记版本 ⇒ 结构化 400（白名单优先于任何目录访问）", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "ok.md");
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1/docs?file=ok.md");
        assert.equal(res.status, 400);
        assert.match(res.text, /白名单/);
        assert.ok(!res.text.includes(disk));
      },
      { featureOver: { version: "latest" }, docs: { repoRoot: disk, orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ④ 读面口径：恒 GET、不过 CSRF；解析层补字段
// ---------------------------------------------------------------------------

test("docs 读面：POST ⇒ 405（读面只放开 GET）；GET 无 CSRF 头照样可读", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "ok.md", "# ok\n");
    await withServer(
      async (base) => {
        const post = await fetch(`${base}/features/F1/docs?file=ok.md`, { method: "POST" });
        assert.equal(post.status, 405);
        const get = await fetch(`${base}/features/F1/docs?file=ok.md`);
        assert.equal(get.status, 200);
        assert.equal(await get.text(), "# ok\n");
      },
      { docs: { repoRoot: disk, orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("parseFeatureDetail：decisions / contracts 收下；缺失或非字符串 ⇒ null（不抛）", () => {
  const ok = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F", state: "executing", decisions: '["d1"]', contracts: "c" },
    tasks: [],
  });
  assert.equal(ok.feature.decisions, '["d1"]');
  assert.equal(ok.feature.contracts, "c");
  const missing = parseFeatureDetail({ ok: true, feature: { featureId: "F", state: "executing" }, tasks: [] });
  assert.equal(missing.feature.decisions, null);
  assert.equal(missing.feature.contracts, null);
  const wrong = parseFeatureDetail({
    ok: true,
    feature: { featureId: "F", state: "executing", decisions: 7, contracts: null },
    tasks: [],
  });
  assert.equal(wrong.feature.decisions, null);
  assert.equal(wrong.feature.contracts, null);
});
