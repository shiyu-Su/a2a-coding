/**
 * 板文档渲染面（BD14 · REQ-v0.9.1-2026-09-25-04 增补 · **纯函数**，零 HTTP —— HTTP 归 server.ts）。
 *
 * ## markdown 子集渲染器（需求 3 文档页由 `<pre>` 原文直出升级为渲染）
 *
 * **escape-first 纪律**：输入先**整体 HTML 转义**，再按白名单语法加格式 —— 未识别语法
 * （HTML 内联块、脚注、任务列表、图集……）转义后按段落原样呈现，天然不可能开标签。
 * 白名单：标题（#..######）、有序/无序列表（两级）、粗体/斜体、行内码、围栏代码块、
 * 表格、引用块、链接（href 只放行 http/https/站内相对路径/锚点，`javascript:` 等协议整串降级为纯文本）。
 *
 * ## mermaid（vendored 本地资产，板首个第三方静态资产）
 *
 * ```mermaid 围栏块 ⇒ 占位 `<div class="mermaid-block">` + 源文本经
 * `<script type="application/json">` 安全通道注入（JSON 串中 `<`/`>` 落为 `\u003c`/`\u003e`，
 * **绝不拼进 HTML**），页面脚本读 textContent → JSON.parse → `mermaid.render`，
 * 配置 `securityLevel: 'strict'`。资产由 {@link VENDORED_ASSETS} 钉死，服务端点 `/static/<名>`。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "./web/layout.js";

/** 渲染结果：安全 HTML + 是否含 mermaid 块（页面据此决定是否挂 mermaid 资产与渲染脚本）。 */
export interface MarkdownHtml {
  readonly html: string;
  readonly hasMermaid: boolean;
}

// ---------------------------------------------------------------------------
// vendored 静态资产（版本钉与升级纪律见 README「vendored 静态资产」）
// ---------------------------------------------------------------------------

export interface VendoredAsset {
  /** 板内文件名（= `/static/` 端点的名字段，白名单键）。 */
  readonly file: string;
  readonly contentType: string;
  /** 上游版本（钉死；升级走 README 纪律，整文件替换后核对本字段）。 */
  readonly upstreamVersion: string;
}

export const MERMAID_ASSET: VendoredAsset = {
  file: "mermaid.min.js",
  contentType: "text/javascript; charset=utf-8",
  upstreamVersion: "11.17.2",
};

/** `/static/` 端点的文件名闭集：白名单外的名字一律 404（列目录与越界读取无从谈起）。 */
export const VENDORED_ASSETS: readonly VendoredAsset[] = [MERMAID_ASSET];

/**
 * 静态资产目录缺省 = 模块旁 `web/static/`。
 * 资产**只存于 `src/`**（tsc 不拷非 ts 文件），故 dist 运行（模块落 `dist/`）时把锚点
 * 目录换回 `src/` —— 两种运行方式解析到同一文件。
 */
export function defaultStaticRoot(metaUrl: string = import.meta.url): string {
  const modDir = dirname(fileURLToPath(metaUrl));
  const srcDir = /[\\/]dist$/.test(modDir) ? `${modDir.replace(/[\\/]dist$/, "")}/src` : modDir;
  return join(srcDir, "web", "static");
}

/** 资产在盘与否（页面据此决定是否引用 `/static/`；缺文件 ⇒ 只出 markdown 渲染，不挂 404 脚本）。 */
export function vendoredAssetExists(staticRoot: string, file: string): boolean {
  try {
    return existsSync(join(resolve(staticRoot), file));
  } catch {
    return false;
  }
}

/**
 * `/static/` 端点的取文件（纯查白名单，不碰盘）：`name` 命中 {@link VENDORED_ASSETS} ⇒ 返回
 * 该资产与其绝对路径；否则 null（调用方出 404）。名字进正则前先过段卫生（防越界拼接）。
 */
export function findVendoredAsset(
  staticRoot: string,
  name: string,
): { asset: VendoredAsset; absPath: string } | null {
  const hit = VENDORED_ASSETS.find((a) => a.file === name);
  if (hit === undefined) return null;
  return { asset: hit, absPath: join(resolve(staticRoot), hit.file) };
}

// ---------------------------------------------------------------------------
// markdown 子集
// ---------------------------------------------------------------------------

const CODE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const UL_ITEM_RE = /^( *)([-*+])[ \t]+(.*)$/;
const OL_ITEM_RE = /^( *)(\d+)[.)][ \t]+(.*)$/;
const TABLE_DELIM_RE = /^ {0,3}\|?[ \t:|-]*-[ \t:|-]*\|[ \t:|-]*$/;

/** 行内码（escape-first 下的唯一例外段：内容本身是代码，格式化不越界进去）。 */
const INLINE_CODE_RE = /`([^`\n]+)`/g;

/** 链接协议白名单：http/https 绝对链接、站内相对路径与锚点；其余 ⇒ null（整串降级纯文本）。 */
function safeHref(href: string): string | null {
  const h = href.trim();
  if (h === "") return null;
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("//")) return null; // 协议相对 = 外源
  if (/^(?:\/|\.\/|\.\.\/|#)/.test(h)) return h;
  return null;
}

/**
 * 已转义文本上的行内格式化（白名单）：先按 `` ` `` 行内码切段，**非代码段**才跑
 * 链接/粗体/斜体（格式化不跨越代码区、也不消费代码内容 —— 防「代码里的 `**` / 占位串」
 * 反向合成标签），代码段本身整体 escapeHtml 后包 `<code>`。
 */
function renderInline(escaped: string): string {
  const parts: string[] = [];
  let last = 0;
  INLINE_CODE_RE.lastIndex = 0;
  for (;;) {
    const m = INLINE_CODE_RE.exec(escaped);
    if (m === null) break;
    parts.push(`TXT:${escaped.slice(last, m.index)}`, `CODE:${m[1]}`);
    last = m.index + m[0].length;
  }
  parts.push(`TXT:${escaped.slice(last)}`);
  return parts
    .map((p) => {
      if (p.startsWith("CODE:")) return `<code>${p.slice(5)}</code>`; // 内容已在整行 escape-first 里转过，不再二次转义
      let s = p.slice(4);
      s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, text: string, href: string) => {
        const safe = safeHref(href.replace(/&amp;/g, "&"));
        if (safe === null) return whole;
        return `<a class="fl" href="${escapeHtml(safe)}">${text}</a>`;
      });
      s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
      s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
      s = s.replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/g, "$1<em>$2</em>");
      return s;
    })
    .join("");
}

/** mermaid 源文本 → `<script type="application/json">` 载荷（`<`/`>` 落 \u 形态，杜绝提前闭合标签）。 */
function mermaidJsonPayload(source: string): string {
  return JSON.stringify(source).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

/**
 * mermaid 块安全通道（**单点发射器**，BD14；T2 依赖图复用同一通道）：
 * 占位 div + 源文本经 `<script type="application/json">` 注入（`id` = 占位 `data-src` 指向的载体）。
 * JSON 载荷中 `<`/`>` 落 \u 形态 ⇒ 数据通道不是可执行脚本（n3 闭集锚口径），源文本绝不拼进 HTML。
 */
export function mermaidBlockData(id: string, source: string): string {
  return (
    `<div class="mermaid-block" data-src="${escapeHtml(id)}" data-rendered="0" role="img" aria-label="mermaid 图` +
    `（渲染失败时保留源文本）"><pre class="result mermaid-src">${escapeHtml(source)}</pre></div>` +
    `<script type="application/json" id="${escapeHtml(id)}">${mermaidJsonPayload(source)}</script>`
  );
}

interface ListItem {
  readonly indent: number;
  readonly ordered: boolean;
  readonly escapedText: string;
}

/** 列表树渲染（两级：缩进更深的项并入其所属顶层项的嵌套子表；归属 = 之前最近的顶层项）。 */
function renderListTree(items: ListItem[]): string {
  const base = (items[0] as ListItem).indent;
  const groups: { item: ListItem; kids: ListItem[] }[] = [];
  for (const it of items) {
    if (it.indent <= base || groups.length === 0) {
      groups.push({ item: it.indent > base ? { ...it, indent: base } : it, kids: [] });
    } else {
      (groups[groups.length - 1] as { kids: ListItem[] }).kids.push(it);
    }
  }
  const tag = (items[0] as ListItem).ordered ? "ol" : "ul";
  const lis = groups
    .map(
      (g) =>
        `<li>${renderInline(g.item.escapedText)}${g.kids.length > 0 ? renderListTree(g.kids) : ""}</li>`,
    )
    .join("");
  return `<${tag}>${lis}</${tag}>`;
}

/**
 * markdown 子集 → 安全 HTML（判据：产出中的任何标签字面量都出自本文件的白名单模板）。
 * 未识别语法 = 转义后的段落文本，原样呈现。
 */
export function renderMarkdown(src: string): MarkdownHtml {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let hasMermaid = false;
  let mermaidSeq = 0;
  let i = 0;

  const isBlockStart = (l: string): boolean =>
    l.trim() === "" ||
    HEADING_RE.test(l) ||
    CODE_FENCE_RE.test(l) ||
    QUOTE_RE.test(l) ||
    UL_ITEM_RE.test(l) ||
    OL_ITEM_RE.test(l);

  while (i < lines.length) {
    const raw = lines[i] as string;

    // —— 围栏代码块：内部行不做任何解析，原样出槽（mermaid 围栏走安全注入通道）——
    const fm = CODE_FENCE_RE.exec(raw);
    if (fm !== null) {
      const marker = fm[1] as string;
      const info = (fm[2] ?? "").toLowerCase();
      const buf: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        const cm = FENCE_CLOSE_RE.exec(lines[i] as string);
        if (cm !== null && (cm[1] as string)[0] === marker[0] && (cm[1] as string).length >= marker.length) {
          i += 1;
          closed = true;
          break;
        }
        buf.push(lines[i] as string);
        i += 1;
      }
      void closed; // 未闭合围栏按到文件尾收口（降级呈现，不报错）
      const text = buf.join("\n");
      if (info === "mermaid") {
        hasMermaid = true;
        mermaidSeq += 1;
        blocks.push(mermaidBlockData(`mermaid-src-${mermaidSeq}`, text));
      } else {
        blocks.push(`<pre class="result"><code>${escapeHtml(text)}</code></pre>`);
      }
      continue;
    }

    if (raw.trim() === "") {
      i += 1;
      continue;
    }

    // —— 标题 ——
    const hm = HEADING_RE.exec(raw);
    if (hm !== null) {
      const level = (hm[1] as string).length;
      blocks.push(`<h${level}>${renderInline(escapeHtml(hm[2] ?? ""))}</h${level}>`);
      i += 1;
      continue;
    }

    // —— 水平线 ——
    if (HR_RE.test(raw)) {
      blocks.push("<hr>");
      i += 1;
      continue;
    }

    // —— 引用块（连续 `>` 行，行内照常加格式）——
    if (QUOTE_RE.test(raw)) {
      const buf: string[] = [];
      while (i < lines.length) {
        const qm = QUOTE_RE.exec(lines[i] as string);
        if (qm === null) break;
        buf.push(renderInline(escapeHtml(qm[1] ?? "")));
        i += 1;
      }
      blocks.push(`<blockquote class="md-q">${buf.join("<br>")}</blockquote>`);
      continue;
    }

    // —— 表格（表头行 + 分隔行成立才认；行首 `|` 优先，无裸表格误判）——
    if (
      raw.trimStart().startsWith("|") &&
      i + 1 < lines.length &&
      TABLE_DELIM_RE.test(lines[i + 1] as string)
    ) {
      const splitRow = (line: string): string[] => {
        let s = line.trim();
        if (s.startsWith("|")) s = s.slice(1);
        if (s.endsWith("|")) s = s.slice(0, -1);
        return s.split("|").map((c) => c.trim());
      };
      const head = splitRow(raw);
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && (lines[i] as string).includes("|") && (lines[i] as string).trim() !== "") {
        const cells = splitRow(lines[i] as string);
        rows.push(
          "<tr>" +
            head
              .map((_, k) => `<td>${renderInline(escapeHtml(cells[k] ?? ""))}</td>`)
              .join("") +
            "</tr>",
        );
        i += 1;
      }
      blocks.push(
        `<table class="md-t"><thead><tr>${head
          .map((c) => `<th>${renderInline(escapeHtml(c))}</th>`)
          .join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`,
      );
      continue;
    }

    // —— 列表（同种连续成一段；有序↔无序切换即断段）——
    {
      const ulm = UL_ITEM_RE.exec(raw);
      const olm = ulm === null ? OL_ITEM_RE.exec(raw) : null;
      if (ulm !== null || olm !== null) {
        const ordered = ulm === null;
        const items: ListItem[] = [];
        while (i < lines.length) {
          const l = lines[i] as string;
          const u = UL_ITEM_RE.exec(l);
          const o = OL_ITEM_RE.exec(l);
          if ((ordered ? o : u) === null) break;
          const m = (ordered ? o : u) as RegExpExecArray;
          items.push({
            indent: (m[1] ?? "").length,
            ordered,
            escapedText: escapeHtml(m[3] ?? ""),
          });
          i += 1;
        }
        blocks.push(renderListTree(items));
        continue;
      }
    }

    // —— 段落：连续普通行，行间以 <br> 相接（保持源排版）——
    const buf: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i] as string)) {
      buf.push(renderInline(escapeHtml(lines[i] as string)));
      i += 1;
    }
    if (buf.length === 0) {
      buf.push(renderInline(escapeHtml(raw)));
      i += 1;
    }
    blocks.push(`<p>${buf.join("<br>")}</p>`);
  }

  return { html: `<div class="md">${blocks.join("\n")}</div>`, hasMermaid };
}

// ---------------------------------------------------------------------------
// mermaid 页面脚本（一段内联字面量 + 一条同源资产引用；与 SUBMIT_GUARD_SCRIPT 同规格）
// ---------------------------------------------------------------------------

/**
 * 文档页 mermaid 渲染脚本：源文本只经 JSON 安全通道取回（textContent → JSON.parse），不拼 HTML。
 *
 * **v0.9.3 增补 ②（依赖图修根因）**：
 * - 扫描**幂等化**（`data-rendered="1"` 的块跳过）并暴露全局钩子 `window.a2aRenderMermaid` ——
 *   排期页详情浮层把详情页 `<main>` 经 DOMParser 搬入时**搬运节点不执行脚本**，
 *   依赖图/文档 mermaid 停在源文本；浮层在 `showModal()` 之后调用本钩子补渲
 *   （可见容器在先，不重犯 98c39da1「渲染进 display:none 容器」）；
 * - 触发 = DOMContentLoaded（defer 库先于本事件执行 ⇒ 常规整页档库已就位）∧ window load 兜底
 *   （未DOMContentLoaded 立即补试 / 已越过则同步补试）。
 */
export function mermaidRenderScript(): string {
  return `<script>
(function () {
  function renderBlocks() {
    if (typeof window.mermaid === "undefined") { return false; }
    try { window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict" }); } catch (e) { return false; }
    var nodes = document.querySelectorAll('.mermaid-block[data-src]:not([data-rendered="1"])');
    var seq = 0;
    Array.prototype.forEach.call(nodes, function (host) {
      var srcEl = document.getElementById(host.getAttribute("data-src"));
      if (srcEl === null) { return; }
      var def;
      try { def = JSON.parse(srcEl.textContent || ""); } catch (e) { return; }
      var pre = host.querySelector("pre.mermaid-src");
      if (pre === null) { return; }
      seq += 1;
      var id = "a2a-mermaid-" + seq;
      window.mermaid.render(id, def).then(function (r) {
        /* SVG 必须落在 PRE 之外的可见兄弟容器：pre.result 在 data-rendered=1 时隐藏，嵌套进去即不可见 */
        var out = document.createElement("div");
        out.className = "mermaid-svg";
        out.innerHTML = r.svg;
        host.insertBefore(out, pre);
        host.setAttribute("data-rendered", "1");
      }, function () { /* 渲染失败：保留源文本，不整页崩 */ });
    });
    return true;
  }
  /* 浮层补渲钩子：FEATURE_DETAIL_OVERLAY_SCRIPT 换入 <main>（showModal 之后）调用；幂等，已渲染块不重复扫 */
  window.a2aRenderMermaid = renderBlocks;
  /* defer 库先于 DOMContentLoaded 执行 ⇒ DC 一次；load 再兜一次（幂等扫描，防极迟就绪的加载形态） */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderBlocks);
  } else { renderBlocks(); }
  window.addEventListener("load", renderBlocks);
})();
</script>`;
}

/** 引用同源 vendored 资产（仅当页含 mermaid 块且资产在盘；加载顺序 = 先库后渲染脚本）。 */
export function mermaidAssetScriptTag(): string {
  return `<script src="/static/${MERMAID_ASSET.file}" defer></script>`;
}
