/**
 * BD11 用例（REQ-v0.9.1-2026-09-25-04 · 判据 3/4；REQ-v0.9.2-2026-09-26-01 按需求归约改写）：
 * 读文档面的 **HTTP 层 + 渲染层**。
 *
 * 覆盖：
 * ① 详情页「阶段产出」区 = **decisions 驱动**（与旧「产出登记」合并为单区）：登记条目逐条渲染、
 *    含 `doc/…/*.md` 路径者成可点条目、非 doc 路径条目原样、版本目录 flat 清单已作废；
 * ② 未登记降级 ⇒ 「无（本需求未登记产出）」；登记版本 ≠ 当前版本 ⇒ 失联警示行与清单共存；
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
import {
  extractDocPath,
  extractRegisteredDocPath,
  parseDecisionItems,
  renderFeatureDetail,
} from "../dist/web/views.js";

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
// ① 阶段产出区（decisions 驱动 · 单区合并 · 版本清单作废）
// ---------------------------------------------------------------------------

test("阶段产出：decisions 1 条 doc 登记 ⇒ 单链接（链接文字 = 文件名，无路径行、无「打开」前缀）", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "归约-需求确认单.md", "# 确认单\n");
    put(disk, "A", "v1.2.3", "未登记-改造文档.md", "# 未被 decisions 登记\n");
    const decisions = JSON.stringify(["产出：doc/v1.2.3/归约-需求确认单.md"]);
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1");
        assert.equal(res.status, 200);
        assert.match(res.text, /<h2>阶段产出<\/h2>/);
        assert.match(res.text, /<li><a class="fl" href="\/features\/F1\/docs\?file=[^"]*">归约-需求确认单\.md<\/a><\/li>/);
        assert.doesNotMatch(res.text, />打开 /, "条目不再带「打开 」前缀");
        assert.doesNotMatch(res.text, /<li>[^<]*doc\/v1\.2\.3\//, "条目不再展示路径行");
        assert.doesNotMatch(res.text, /未登记-改造文档/, "版本目录 flat 清单已作废：未登记文档不得出现在区块");
        assert.ok(!/docs\?file=[^"]*src=B/.test(res.text), "打开链接不带 src ⇒ 服务端 A→B 回落");
      },
      { featureOver: { decisions }, docs: { repoRoot: disk, orgsDir: join(disk, "orgs") } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("阶段产出：N 条逐条渲染 · 非 doc 路径条目原样不出链接 · doc 条目成可点", async () => {
  const disk = tmpDisk();
  try {
    const decisions = JSON.stringify([
      "裁决 ①：数据源改 decisions 驱动",
      "产出：doc/v1.2.3/归约-需求确认单.md（v1 含裁决记录）",
      "产出：doc/v1.2.3/归约-改造文档.md",
    ]);
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1");
        const rows = res.text.match(/<ul class="docs">(.*?)<\/ul>/s);
        assert.ok(rows, "阶段产出区必须是列表");
        const items = rows[1].split("</li>").filter((s) => s.includes("<li>"));
        assert.equal(items.length, 3, "三条登记逐条渲染");
        assert.ok(!/\/docs\?file=/.test(items[0]), "非 doc 路径条目原样显示、不出链接");
        assert.match(items[1], /<li><a class="fl" href="\/features\/F1\/docs\?file=[^"]*">归约-需求确认单\.md<\/a>/);
        assert.match(items[2], /<a class="fl" href="\/features\/F1\/docs\?file=[^"]*">归约-改造文档\.md<\/a>/);
      },
      { featureOver: { decisions }, docs: { repoRoot: disk, orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("阶段产出：旧「产出登记」区已合并 —— 全页只有一个产出 h2，decisions 不重复两处", async () => {
  const decisions = JSON.stringify(["产出：doc/v1.2.3/a-改造文档.md"]);
  await withServer(
    async (base) => {
      const res = await fetchText(base, "/features/F1");
      const h2s = res.text.match(/<h2>[^<]*产出[^<]*<\/h2>/g) ?? [];
      assert.deepEqual(h2s, ["<h2>阶段产出</h2>"], "不得再出现「产出登记（decisions）」第二区");
    },
    { featureOver: { decisions }, docs: { repoRoot: join(tmpdir(), "board-bd11-不存在"), orgsDir: null } },
  );
});

// ---------------------------------------------------------------------------
// ② 未登记降级 + 改版失联警示共存
// ---------------------------------------------------------------------------

test("未登记降级：无 decisions / 仅非 doc 条目 ⇒ 「无（本需求未登记产出）」+ 口径，不回落目录", async () => {
  for (const decisions of [null, JSON.stringify(["本轮无文档产出，仅口径调整"])] ) {
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1");
        assert.equal(res.status, 200);
        assert.match(res.text, /<h2>阶段产出<\/h2>[\s\S]*无（本需求未登记产出）/);
        assert.match(res.text, /advance/);
        assert.doesNotMatch(res.text, /\/features\/F1\/docs\?file=/, "未登记 ⇒ 区块内不得有任何打开链接");
      },
      { featureOver: { decisions }, docs: { repoRoot: join(tmpdir(), "board-bd11-不存在"), orgsDir: null } },
    );
  }
});

test("登记版本 ≠ 当前版本 ⇒ 失联警示行与产出清单共存，链接仍按现行端点规则", async () => {
  const decisions = JSON.stringify(["产出：doc/v0.9.1/上板-改造文档.md"]);
  await withServer(
    async (base) => {
      const res = await fetchText(base, "/features/F1");
      assert.match(res.text, /class="hint warn"[\s\S]*文档读锚将随版本切换/);
      assert.match(res.text, />上板-改造文档\.md<\/a>/, "警示不吞条目：链接仍在，点开 404 属已知语义");
    },
    { featureOver: { decisions, version: "v0.9.2" }, docs: { repoRoot: join(tmpdir(), "board-bd11-不存在"), orgsDir: null } },
  );
});

test("阶段产出纯函数：JSON 数组逐元素 · 非 JSON 整段一条 · 空为 []；登记路径只认 doc/ 前缀", () => {
  assert.deepEqual(parseDecisionItems('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseDecisionItems("非 JSON 的一段登记"), ["非 JSON 的一段登记"]);
  assert.deepEqual(parseDecisionItems(null), []);
  assert.deepEqual(parseDecisionItems("  "), []);
  assert.deepEqual(extractDocPath("产出：doc/v1.2.3/x-改造文档.md"), { version: "v1.2.3", file: "x-改造文档.md" });
  assert.equal(extractDocPath("没有路径的一句话"), null);
  assert.deepEqual(extractRegisteredDocPath("产出：doc/v1.2.3/x-改造文档.md"), { version: "v1.2.3", file: "x-改造文档.md" });
  assert.equal(extractRegisteredDocPath("参照 v1.2.3/x-改造文档.md（裸版本目录形态，非本需求登记）"), null);
  assert.equal(extractRegisteredDocPath("结论见 README.md 一句话"), null);
});

test("阶段产出区转义：非 doc 条目原文里的尖括号不得逃成标签；doc 条目为单链接文件名", () => {
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
        decisions: JSON.stringify([
          '<img src=x onerror=alert(1)> 本轮裁决',
          "产出：doc/v1.2.3/a.md",
        ]),
        contracts: null,
        createdAt: null,
        updatedAt: null,
      },
      tasks: [],
    },
    null,
    null,
    NOW,
  );
  assert.doesNotMatch(html, /<img /, "条目不得放出未转义标签");
  assert.match(html, /<li>&lt;img src=x onerror=alert\(1\)&gt; 本轮裁决<\/li>/, "非 doc 条目原文转义保留");
  assert.match(html, /<li><a class="fl" href="[^"]*">a\.md<\/a><\/li>/, "doc 条目 = 单链接、文字为文件名");
});

test("登记路径形态归一：`doc/x.md` 单段 / `doc/{v}/x.md` 两段都提文件名；`README.md` 提及不成链接", async () => {
  const decisions = JSON.stringify(["产出：doc/归约-需求确认单.md", "产出：doc/v1.2.3/归约-改造文档.md", "口径同步 README.md"]);
  const html = renderFeatureDetail(
    {
      feature: {
        featureId: "F1",
        state: "executing",
        title: "t",
        plan: null,
        ownerGroup: null,
        stage: null,
        version: "v1.2.3",
        approval: null,
        decisions,
        contracts: null,
        createdAt: null,
        updatedAt: null,
      },
      tasks: [],
    },
    null,
    null,
    NOW,
  );
  assert.match(html, />归约-需求确认单\.md<\/a>/, "单段 doc/x.md ⇒ 版本缺省由当前值承载");
  assert.match(html, />归约-改造文档\.md<\/a>/);
  assert.ok(!/>README\.md<\/a>/.test(html), "正文提及 README.md 不构成产出条目");
  const links = html.match(/docs\?file=[^"]*/g) ?? [];
  assert.equal(links.length, 2, "仅两条 doc 登记成链接");
});

test("版本不合白名单不再作为区块判据：未登记 ⇒ 仍是「本需求未登记产出」（旧目录文案已退场）", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "ok-改造文档.md", "# ok\n");
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1");
        assert.equal(res.status, 200);
        assert.match(res.text, /无（本需求未登记产出）/);
        assert.doesNotMatch(res.text, /不符合 <code>v\{major/, "旧「版本不合白名单 ⇒ 不打开目录」文案随扫描一并退场");
        assert.doesNotMatch(res.text, /两源/, "旧双源清单文案退场");
      },
      { featureOver: { version: "v9" }, docs: { repoRoot: disk, orgsDir: join(disk, "orgs") } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("真机形态回归：一条登记 2 份文档 ⇒ 恰 2 个打开链接、点开可读全文（守卫端点复用）", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "归约-需求确认单.md", "# 确认单正文\n");
    put(disk, "A", "v1.2.3", "归约-改造文档.md", "# 改造文档正文\n");
    const decisions = JSON.stringify([
      "产出登记：doc/v1.2.3/归约-需求确认单.md",
      "产出登记：doc/v1.2.3/归约-改造文档.md",
    ]);
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1");
        const links = res.text.match(/href="\/features\/F1\/docs\?file=[^"]*"/g) ?? [];
        assert.equal(links.length, 2, "两份文档 = 两个打开链接，无多余条目");
        for (const [file, expect] of [
          ["归约-需求确认单.md", "# 确认单正文\n"],
          ["归约-改造文档.md", "# 改造文档正文\n"],
        ]) {
          const doc = await fetchText(base, `/features/F1/docs?file=${encodeURIComponent(file)}`);
          assert.equal(doc.status, 200);
          assert.equal(doc.text, expect);
        }
      },
      { featureOver: { decisions }, docs: { repoRoot: disk, orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("版本不合白名单不打折产出清单：登记条目照常列出，点开由守卫端点 400（版本门在端点不在区块）", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "ok-改造文档.md", "# ok\n");
    const decisions = JSON.stringify(["产出：doc/v9/ok-改造文档.md"]);
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1");
        assert.match(res.text, />ok-改造文档\.md<\/a>/);
        const doc = await fetchText(base, "/features/F1/docs?file=ok-改造文档.md");
        assert.equal(doc.status, 400);
        assert.match(doc.text, /白名单/);
      },
      { featureOver: { decisions, version: "v9" }, docs: { repoRoot: disk, orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
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
