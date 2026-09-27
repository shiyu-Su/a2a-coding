/**
 * BD14 用例（REQ-v0.9.1-2026-09-25-04 增补 · 判据 5）：**markdown 子集渲染器 + mermaid 占位 + 双档切换**。
 *
 * 覆盖：
 * ① 渲染器语法白名单逐项（标题 / 有序·无序列表 / 粗体·斜体 / 行内码 / 围栏 / 表格 / 引用 / 链接）；
 * ② **注入负例**：`<img onerror>` / `<script>` / `javascript:` 链接 / 协议相对链接 / HTML 标签
 *    在渲染输出中**必须为转义文本**，且产出标签集合 ⊆ 白名单（escape-first 的可核对形态）；
 * ③ mermaid 围栏 ⇒ 占位 div + `<script type="application/json">` **安全注入**（源文本不拼 HTML、
 *    `<`/`>` 落 \u 形态），hasMermaid 标记；非 mermaid 围栏照常 `<pre><code>`；
 * ④ vendored 资产：`defaultStaticRoot` 解析到 `src/web/static/`、`findVendoredAsset` 白名单闭集、
 *    `mermaidRenderScript` 走 textContent→JSON.parse（不出现 innerHTML=源文本拼接）；
 * ⑤ 双档切换：`renderDocPage` render/raw 两档 + 页头互链（HTTP 档见 bd14-docs-face.test.mjs）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MERMAID_ASSET,
  VENDORED_ASSETS,
  defaultStaticRoot,
  findVendoredAsset,
  mermaidAssetScriptTag,
  mermaidRenderScript,
  renderMarkdown,
  vendoredAssetExists,
} from "../dist/docs-render.js";
import { renderDocPage } from "../dist/web/views.js";

// ---------------------------------------------------------------------------
// ① 语法白名单
// ---------------------------------------------------------------------------

test("渲染器：标题 #/##/### 映射 h1/h2/h3，尾部 # 剥离", () => {
  const { html } = renderMarkdown("# 一级\n\n## 二级\n\n### 三级标题 ###");
  assert.match(html, /<h1>一级<\/h1>/);
  assert.match(html, /<h2>二级<\/h2>/);
  assert.match(html, /<h3>三级标题<\/h3>/);
});

test("渲染器：无序列表（- * +）成 <ul><li>，有序列表成 <ol>", () => {
  const ul = renderMarkdown("- 甲\n- 乙\n").html;
  assert.match(ul, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/);
  const ol = renderMarkdown("1. 第一\n2. 第二\n").html;
  assert.match(ol, /<ol><li>第一<\/li><li>第二<\/li><\/ol>/);
});

test("渲染器：二级嵌套列表归并到父项（两级）", () => {
  const { html } = renderMarkdown("- 父\n  - 子一\n  - 子二\n");
  assert.match(html, /<li>父<ul><li>子一<\/li><li>子二<\/li><\/ul><\/li>/);
});

test("渲染器：粗体 **x** / 斜体 *x* / 下划线粗体 __x__", () => {
  const { html } = renderMarkdown("**粗** 与 *斜* 与 __粗2__");
  assert.match(html, /<strong>粗<\/strong>/);
  assert.match(html, /<em>斜<\/em>/);
  assert.match(html, /<strong>粗2<\/strong>/);
});

test("渲染器：行内码内容不被格式化，整体转义", () => {
  const { html } = renderMarkdown("用 `a < b && c` 判断");
  assert.match(html, /<code>a &lt; b &amp;&amp; c<\/code>/);
  // 反例：行内码里的 `**` 不得被加成粗体
  assert.doesNotMatch(html, /<strong>/);
});

test("渲染器：围栏代码块照常 <pre><code>，内部不解析", () => {
  const { html } = renderMarkdown("```js\nconst a = 1; // **not bold**\n```");
  assert.match(html, /<pre class="result"><code>const a = 1; \/\/ \*\*not bold\*\*<\/code><\/pre>/);
  assert.doesNotMatch(html, /<strong>/);
});

test("渲染器：表格 thead/tbody，列数以表头为准", () => {
  const { html } = renderMarkdown("| 名 | 值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |");
  assert.match(html, /<table class="md-t"><thead><tr><th>名<\/th><th>值<\/th><\/tr><\/thead>/);
  assert.match(html, /<tbody><tr><td>甲<\/td><td>1<\/td><\/tr><tr><td>乙<\/td><td>2<\/td><\/tr><\/tbody>/);
});

test("渲染器：引用块 blockquote，多行以 <br> 相接", () => {
  const { html } = renderMarkdown("> 引用一\n> 引用二");
  assert.match(html, /<blockquote class="md-q">引用一<br>引用二<\/blockquote>/);
});

test("渲染器：链接白名单 —— http/https/站内相对/锚点 放行成 <a>", () => {
  const ok = renderMarkdown("[文档](https://example.com/x)");
  assert.match(ok.html, /<a class="fl" href="https:\/\/example\.com\/x">文档<\/a>/);
  const rel = renderMarkdown("[详情页](/features/F1)");
  assert.match(rel.html, /<a class="fl" href="\/features\/F1">详情页<\/a>/);
  const anchor = renderMarkdown("[锚点](#section)");
  assert.match(anchor.html, /<a class="fl" href="#section">锚点<\/a>/);
});

test("渲染器：水平线与段落（行间 <br>，段间分块）", () => {
  const { html } = renderMarkdown("第一行\n第二行\n\n---\n\n新段落");
  assert.match(html, /<p>第一行<br>第二行<\/p>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<p>新段落<\/p>/);
});

// ---------------------------------------------------------------------------
// ② 注入负例（escape-first 的核心判据）
// ---------------------------------------------------------------------------

test("注入负例：<img onerror> 在渲染输出中为转义文本，不成标签", () => {
  const { html } = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/, "不得开 <img> 标签");
  assert.doesNotMatch(html, /<[^>]*\bonerror\s*=/, "onerror 不得出现在任何开标签的属性位（仅存于转义文本）");
});

test("注入负例：<script> 在渲染输出中为转义文本", () => {
  const { html } = renderMarkdown("<script>alert(document.cookie)</script>");
  assert.match(html, /&lt;script&gt;alert\(document\.cookie\)&lt;\/script&gt;/);
  assert.equal(html.includes("<script"), false, "不得出现任何真实 <script 开标签（mermaid 用例另测）");
});

test("注入负例：javascript: 链接整串降级为纯文本，不出 <a href>", () => {
  const { html } = renderMarkdown("[点我](javascript:alert(1))");
  assert.doesNotMatch(html, /<a /);
  assert.doesNotMatch(html, /href="javascript/i);
  assert.match(html, /\[点我\]\(javascript:alert\(1\)\)/, "未放行 ⇒ 原样（转义后）呈现");
});

test("注入负例：协议相对 //host 与 data: 链接同样降级", () => {
  assert.doesNotMatch(renderMarkdown("[x](//evil.example/a)").html, /<a /);
  assert.doesNotMatch(renderMarkdown("[x](data:text/html,<script>1</script>)").html, /<a /);
});

test("注入负例：属性断裂企图（引号 / >）在 href 白名单文本里被转义", () => {
  const { html } = renderMarkdown('[x](https://ok.example/"onmouseover="alert(1))');
  // 允许成链，但引号必须转义，不得开新属性
  assert.doesNotMatch(html, /"\s*onmouseover=/);
  assert.doesNotMatch(html, /\sonmouseover=/);
});

test("注入负例：产出标签集合恒 ⊆ 白名单（未识别语法不得开任何标签）", () => {
  const nasty = [
    "<div onclick=1>",
    "<iframe src=//evil>",
    "</textarea><script>x</script>",
    "<svg/onload=alert(1)>",
    "![img](javascript:alert(1))",
    "%%{eval}%%",
  ].join("\n\n");
  const { html } = renderMarkdown(nasty);
  const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
  const ALLOWED = new Set([
    "div", "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li",
    "strong", "em", "code", "pre", "blockquote", "table", "thead", "tbody",
    "tr", "th", "td", "a", "br", "hr",
  ]);
  for (const t of tags) {
    assert.ok(ALLOWED.has(t), `产出出现白名单外标签 <${t}>：${html}`);
  }
});

// ---------------------------------------------------------------------------
// ③ mermaid 占位 + 安全注入
// ---------------------------------------------------------------------------

test("mermaid 围栏 ⇒ 占位 div + application/json 安全注入，hasMermaid=true", () => {
  const src = "```mermaid\ngraph TD; A-->B;\n```";
  const { html, hasMermaid } = renderMarkdown(src);
  assert.equal(hasMermaid, true);
  assert.match(html, /<div class="mermaid-block" data-src="mermaid-src-1" data-rendered="0"/);
  assert.match(html, /<script type="application\/json" id="mermaid-src-1">/, "源文本走 JSON 安全通道");
  // 源文本在占位 <pre> 里是转义形态（可见但不执行）
  assert.match(html, /<pre class="result mermaid-src">graph TD; A--&gt;B;<\/pre>/);
});

test("mermaid JSON 载荷：`<`/`>` 落 \\u 形态，杜绝提前闭合 script 标签", () => {
  const { html } = renderMarkdown('```mermaid\nA["<script>alert(1)</script>"]\n```');
  const m = /<script type="application\/json" id="mermaid-src-1">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "应有 JSON 载荷标签");
  const payload = m[1];
  assert.ok(!payload.includes("<"), "JSON 载荷内不得出现裸 `<`（会提前闭合标签）");
  assert.ok(payload.includes("\\u003c"), "`<` 必须是 \\u003c 转义形态");
  // 且这段 JSON 仍可被浏览器 JSON.parse 还原成含 <script> 的源文本
  assert.equal(JSON.parse(payload).includes("<script>"), true, "转义形态可无损还原");
});

test("mermaid 页缺多个块 ⇒ 序号 id 递增、占位与 JSON 一一对应", () => {
  const { html } = renderMarkdown("```mermaid\nA\n```\n\n```mermaid\nB\n```");
  assert.match(html, /data-src="mermaid-src-1"/);
  assert.match(html, /data-src="mermaid-src-2"/);
  assert.match(html, /id="mermaid-src-1"/);
  assert.match(html, /id="mermaid-src-2"/);
});

test("非 mermaid 围栏不误判为 mermaid（hasMermaid=false，照常显示）", () => {
  const { html, hasMermaid } = renderMarkdown("```text\nmermaid-ish content\n```");
  assert.equal(hasMermaid, false);
  assert.doesNotMatch(html, /mermaid-block/);
  assert.match(html, /<pre class="result"><code>mermaid-ish content<\/code><\/pre>/);
});

// ---------------------------------------------------------------------------
// ④ vendored 资产 + 渲染脚本口径
// ---------------------------------------------------------------------------

test("vendored 资产：白名单闭集含 mermaid，文件名 / 版本钉已登记", () => {
  assert.deepEqual(VENDORED_ASSETS.map((a) => a.file), ["mermaid.min.js"]);
  assert.equal(MERMAID_ASSET.file, "mermaid.min.js");
  assert.match(MERMAID_ASSET.upstreamVersion, /^11\./, "钉 11.x 稳定版");
});

test("defaultStaticRoot：src 与 dist 两种运行方式解析到同一 src/web/static", () => {
  const base = fileURLToPath(new URL(".", import.meta.url)).replace(/[\\/]test[\\/]?$/, "");
  const fromSrc = defaultStaticRoot(pathToFileURL(join(base, "src", "docs-render.js")).href);
  const fromDist = defaultStaticRoot(pathToFileURL(join(base, "dist", "docs-render.js")).href);
  assert.equal(fromSrc, join(base, "src", "web", "static"));
  assert.equal(fromDist, fromSrc, "dist 运行须回落 src（tsc 不拷非 ts 资产）");
});

test("findVendoredAsset：命中白名单给绝对路径；白名单外 / 越界名 ⇒ null", () => {
  const hit = findVendoredAsset(defaultStaticRoot(), "mermaid.min.js");
  assert.ok(hit);
  assert.equal(hit.asset, MERMAID_ASSET);
  assert.equal(findVendoredAsset(defaultStaticRoot(), "../server.js"), null);
  assert.equal(findVendoredAsset(defaultStaticRoot(), "other.js"), null);
  assert.equal(vendoredAssetExists(defaultStaticRoot(), "mermaid.min.js"), true, "资产须已入仓");
});

test("mermaidAssetScriptTag：指向同源 /static/，defer 加载（无外源主机）", () => {
  const tag = mermaidAssetScriptTag();
  assert.match(tag, /^<script src="\/static\/mermaid\.min\.js" defer><\/script>$/);
  assert.doesNotMatch(tag, /https?:\/\//);
});

test("mermaidRenderScript：securityLevel strict + textContent→JSON.parse，不拼源文本进 HTML", () => {
  const script = mermaidRenderScript();
  assert.match(script, /securityLevel:\s*"strict"/);
  assert.match(script, /JSON\.parse\(srcEl\.textContent/, "源文本只经 textContent 安全通道取回");
  assert.match(script, /window\.mermaid\.render\(/);
  assert.doesNotMatch(script, /document\.write|eval\(|new Function/, "脚本内零动态求值");
});

// ---------------------------------------------------------------------------
// ④b BD16：mermaid SVG 落点结构不变式（SVG 容器 ≠ PRE.result 子孙；PRE 保持隐藏兜底）
// ---------------------------------------------------------------------------

test("BD16 静态结构：占位内只有源文本 PRE，不含任何 svg（服务端产出即无嵌套）", () => {
  const { html } = renderMarkdown("```mermaid\ngraph TD; A-->B;\n```");
  const block = /<div class="mermaid-block"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
  assert.ok(block.length > 0, "占位 div 须在");
  assert.equal(/<svg/i.test(block), false, "占位内不得有 svg");
  assert.match(block, /^<div class="mermaid-block"[^>]*><pre class="result mermaid-src">/, "占位的唯一子节点是源文本 PRE");
});

test("BD16 init 脚本：SVG 写入 PRE 之外的兄弟容器（insertBefore 到 host），不再写进 pre", () => {
  const script = mermaidRenderScript();
  assert.doesNotMatch(script, /pre\.innerHTML\s*=/, "不得把 SVG 写进隐藏的 PRE（display:none 祖先 ⇒ 图永不可见）");
  assert.match(script, /createElement\("div"\)/, "SVG 落点为新建 div 容器");
  assert.match(script, /className\s*=\s*"mermaid-svg"/, "容器 class 与 CSS 兜底规则（:empty 隐藏）挂钩");
  assert.match(script, /host\.insertBefore\(out,\s*pre\)/, "容器插为 PRE 的可见兄弟节点");
});

test("BD16 CSS：data-rendered=1 隐藏源文本 PRE（兜底不显示）+ SVG 容器空时隐藏（不留空盒）", async () => {
  const { renderPage } = await import("../dist/web/layout.js");
  const page = renderPage({ title: "t", active: "features", bodyHtml: "" });
  assert.match(
    page,
    /\.md \.mermaid-block\[data-rendered="1"\] pre\.mermaid-src \{ display: none; \}/,
    "渲染成功后 PRE 保持 hidden 兜底",
  );
  assert.match(
    page,
    /\.md \.mermaid-block\[data-rendered="1"\] \.mermaid-svg:empty \{ display: none; \}/,
    "空 SVG 容器不得占高",
  );
});

// ---------------------------------------------------------------------------
// ④c v0.9.3 增补 ②：依赖图渲染修复（幂等补渲钩子 + 加载时机 + 可见容器不变式）
// ---------------------------------------------------------------------------

test("增补② 渲染脚本：幂等扫描（跳过 data-rendered=1）+ 全局补渲钩子 a2aRenderMermaid", () => {
  const script = mermaidRenderScript();
  assert.match(
    script,
    /querySelectorAll\('\.mermaid-block\[data-src\]:not\(\[data-rendered="1"\]\)'\)/,
    "扫描须排除已渲染块（钩子可反复调用、不重复渲染）",
  );
  assert.match(script, /window\.a2aRenderMermaid = renderBlocks/, "钩子单点暴露（浮层换入 <main> 后补渲）");
  assert.match(script, /addEventListener\("DOMContentLoaded", renderBlocks\)/, "defer 库先于 DOMContentLoaded ⇒ DC 首渲");
  assert.match(script, /addEventListener\("load", renderBlocks\)/, "window load 兜底（幂等补试，防库迟就绪）");
});

test("增补② 容器可见性不变式：补渲钩子只在 showModal 之后调用（防「渲染进 display:none 容器」复发，98c39da1 前科）", async () => {
  const { FEATURE_DETAIL_OVERLAY_SCRIPT } = await import("../dist/web/layout.js");
  const showModalAt = FEATURE_DETAIL_OVERLAY_SCRIPT.indexOf("dlg.showModal()");
  const hookAt = FEATURE_DETAIL_OVERLAY_SCRIPT.indexOf("a2aRenderMermaid");
  assert.ok(showModalAt > 0 && hookAt > 0, "浮层含 showModal 与补渲钩子两处");
  assert.ok(hookAt > showModalAt, "钩子调用在 showModal 之后（容器已可见才渲染）");
  assert.match(
    FEATURE_DETAIL_OVERLAY_SCRIPT,
    /if \(typeof window\.a2aRenderMermaid === "function"\)/,
    "无 mermaid 页（未挂渲染脚本）⇒ 钩子缺席不报错",
  );
});

test("增补② 落点结构：SVG 容器插为 PRE 之前的可见兄弟（不落隐藏 PRE 子孙）", () => {
  const script = mermaidRenderScript();
  assert.match(script, /host\.insertBefore\(out, pre\)/, "落点 = host 直接子节点、PRE 的兄弟");
  assert.doesNotMatch(script, /pre\.appendChild\(|pre\.innerHTML\s*=/, "不得把 SVG 塞进（会被隐藏的）源文本 PRE");
});

// ---------------------------------------------------------------------------
// ⑤ 双档切换（视图层；HTTP 档见 bd14-docs-face.test.mjs）
// ---------------------------------------------------------------------------

test("renderDocPage render 档：渲染 HTML + 页头切「原文视图」链接（mode=raw）", () => {
  const view = renderDocPage("F1", "x-改造文档.md", "A", "# 标题\n正文", false, "render", join("no-such-root"));
  assert.match(view.bodyHtml, /<h1>标题<\/h1>/);
  assert.match(view.bodyHtml, /<a[^>]*href="[^"]*mode=raw[^"]*">原文视图<\/a>/);
  assert.match(view.bodyHtml, /当前：<b>渲染<\/b>/);
});

test("renderDocPage raw 档：现行 <pre> 原文视图原样保留 + 切「渲染视图」链接", () => {
  const view = renderDocPage("F1", "x.md", "A", "<script>alert(1)</script>", false, "raw", join("no-such-root"));
  assert.match(view.bodyHtml, /<pre class="result">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/pre>/);
  assert.match(view.bodyHtml, /<a[^>]*href="[^"]*mode=render[^"]*">渲染视图<\/a>/);
  assert.match(view.bodyHtml, /当前：<b>原文<\/b>/);
  assert.equal(view.extraScripts, "", "原文档不挂任何渲染脚本");
});

test("renderDocPage render 档含 mermaid：资产缺失 ⇒ 降级提示、不挂 404 脚本", () => {
  const view = renderDocPage("F1", "x.md", "A", "```mermaid\nA-->B\n```", false, "render", join("no-such-root"));
  assert.match(view.bodyHtml, /mermaid-block/, "占位仍渲染");
  assert.match(view.extraScripts, /流程图按源文本显示|mermaid 静态资产缺失/);
  assert.doesNotMatch(view.extraScripts, /<script src="\/static/, "缺资产 ⇒ 不引用 /static（免 404）");
});
