/**
 * BD14 用例（判据 5 · HTTP 档）：`/static/` vendored 资产端点 + 文档页渲染/原文双档切换。
 *
 * 覆盖：
 * ① `GET /static/mermaid.min.js` ⇒ 200 + `text/javascript` + CSP 头（含 script-src 'self'）；
 *    白名单外 / 越界名 / 缺文件 ⇒ 404（不列目录）；非 GET ⇒ 405；
 * ② 文档页缺省 render 档 ⇒ markdown 渲染（`<h1>` 等）+ 页头「原文视图」链接；
 * ③ `mode=raw` ⇒ 现行 `<pre>` 原文视图（转义）+ 「渲染视图」链接；
 * ④ mermaid 文档页 ⇒ 占位 div + application/json 安全注入 + 同源 `<script src="/static/...">`；
 *    资产根缺失 ⇒ 降级提示、不引用 /static。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";
import { defaultStaticRoot } from "../dist/docs-render.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

function fakeClient(featureOver = {}) {
  const feature = {
    featureId: "F1", state: "executing", title: "t", plan: null, ownerGroup: null,
    stage: "改造方案", version: "v1.2.3", approval: "已通过", decisions: null, contracts: null,
    createdAt: "c", updatedAt: "u", ...featureOver,
  };
  return {
    async getFeatures() { return { features: [], stateCounts: {} }; },
    async getFeature(id) { return { feature: { ...feature, featureId: id }, tasks: [] }; },
    async getFeatureTrace(id) { return { featureId: id, featureState: feature.state, nodes: [] }; },
    async getProjects() { return { source: null, note: null, observedAt: null, machines: [], runners: [] }; },
    async getTasks(p) { return { projectId: p, reachable: true, notice: null, tasks: [] }; },
  };
}

function put(disk, version, name, content) {
  const base = join(disk, "doc", version);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, name), content, "utf8");
}

async function withServer(run, { featureOver, docs, staticRoot } = {}) {
  const handle = await createBoardServer({
    host: "127.0.0.1", port: 0, client: fakeClient(featureOver), now: () => NOW, docs, staticRoot,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// ① /static 端点
// ---------------------------------------------------------------------------

test("GET /static/mermaid.min.js ⇒ 200 + text/javascript + CSP（script-src 含 'self'）+ 非空体", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/static/mermaid.min.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(res.headers.get("content-security-policy"), /script-src 'unsafe-inline' 'self'/);
    const body = await res.text();
    assert.ok(body.length > 100_000, "vendored 资产须是真实 mermaid 包（非占位）");
  });
});

test("/static 负例：白名单外名 / 越界段 / 非 GET ⇒ 404 / 405（不列目录、不越界读）", async () => {
  await withServer(async (base) => {
    for (const p of ["/static/nope.js", "/static/../server.js", "/static/%2e%2e/server.js", "/static/"]) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 404, `${p} ⇒ 404`);
    }
    const post = await fetch(`${base}/static/mermaid.min.js`, { method: "POST" });
    assert.equal(post.status, 405);
  });
});

test("/static 资产文件缺失 ⇒ 404（白名单命中但盘上无文件，不 500）", async () => {
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/static/mermaid.min.js`);
      assert.equal(res.status, 404);
    },
    { staticRoot: join(tmpdir(), "board-bd14-不存在") },
  );
});

// ---------------------------------------------------------------------------
// ②③ 双档切换
// ---------------------------------------------------------------------------

test("文档页缺省 render 档 ⇒ markdown 渲染（<h1>/<li>）+ 页头「原文视图」链接", async () => {
  const disk = mkdtempSync(join(tmpdir(), "board-bd14-"));
  try {
    put(disk, "v1.2.3", "d.md", "# 标题\n\n- 甲\n- 乙\n");
    await withServer(
      async (base) => {
        const res = await fetch(`${base}/features/F1/docs?file=d.md`, { headers: { accept: "text/html" } });
        const html = await res.text();
        assert.match(html, /<h1>标题<\/h1>/);
        assert.match(html, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/);
        assert.match(html, /当前：<b>渲染<\/b>/);
        assert.match(html, /mode=raw[^"]*">原文视图/);
      },
      { docs: { repoRoot: disk, orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("文档页 mode=raw ⇒ 现行 <pre> 转义原文 + 「渲染视图」链接", async () => {
  const disk = mkdtempSync(join(tmpdir(), "board-bd14-"));
  try {
    put(disk, "v1.2.3", "d.md", "# 标题\n<script>alert(1)</script>\n");
    await withServer(
      async (base) => {
        const res = await fetch(`${base}/features/F1/docs?file=d.md&mode=raw`, { headers: { accept: "text/html" } });
        const html = await res.text();
        assert.match(html, /<pre class="result"># 标题\n&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.doesNotMatch(html, /<h1>标题<\/h1>/, "raw 档不做 markdown 渲染");
        assert.match(html, /当前：<b>原文<\/b>/);
        assert.match(html, /mode=render[^"]*">渲染视图/);
      },
      { docs: { repoRoot: disk, orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("mermaid 文档页 render 档 ⇒ 占位 + JSON 安全注入 + 同源 <script src=/static>（资产在盘）", async () => {
  const disk = mkdtempSync(join(tmpdir(), "board-bd14-"));
  try {
    put(disk, "v1.2.3", "flow.md", "# 流程\n\n```mermaid\ngraph TD; A-->B;\n```\n");
    await withServer(
      async (base) => {
        const res = await fetch(`${base}/features/F1/docs?file=flow.md`, { headers: { accept: "text/html" } });
        const html = await res.text();
        assert.match(html, /<div class="mermaid-block" data-src="mermaid-src-1"/);
        assert.match(html, /<script type="application\/json" id="mermaid-src-1">/);
        assert.match(html, /<script src="\/static\/mermaid\.min\.js" defer><\/script>/);
        assert.match(html, /securityLevel:\s*"strict"/);
        // 源文本不以可执行形态进入 HTML（`>` 在 JSON 载荷里为 \u003e）
        assert.doesNotMatch(html, /application\/json[^>]*>[^<]*A-->B/, "mermaid 源不得裸拼进 HTML");
      },
      { docs: { repoRoot: disk, orgsDir: null }, staticRoot: defaultStaticRoot() },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("mermaid 文档页 + 资产根缺失 ⇒ 降级提示、不引用 /static（免 404 脚本）", async () => {
  const disk = mkdtempSync(join(tmpdir(), "board-bd14-"));
  try {
    put(disk, "v1.2.3", "flow.md", "```mermaid\nA-->B\n```");
    await withServer(
      async (base) => {
        const res = await fetch(`${base}/features/F1/docs?file=flow.md`, { headers: { accept: "text/html" } });
        const html = await res.text();
        assert.match(html, /mermaid-block/, "占位仍渲染");
        assert.match(html, /mermaid 静态资产缺失|流程图按源文本显示/);
        assert.doesNotMatch(html, /<script src="\/static/, "缺资产 ⇒ 不引用 /static");
      },
      { docs: { repoRoot: disk, orgsDir: null }, staticRoot: join(tmpdir(), "board-bd14-空根") },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("text/plain 档不受 mode 影响：带 mode=render 仍原文直出", async () => {
  const disk = mkdtempSync(join(tmpdir(), "board-bd14-"));
  try {
    put(disk, "v1.2.3", "d.md", "# 标题\n");
    await withServer(
      async (base) => {
        const res = await fetch(`${base}/features/F1/docs?file=d.md&mode=render`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
        assert.equal(await res.text(), "# 标题\n");
      },
      { docs: { repoRoot: disk, orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});
