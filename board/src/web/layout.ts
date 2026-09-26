/**
 * 板页面模板骨架（BD3）—— 照 `orch/bridge/web/html.ts` 路线：
 * **同源、无构建、无框架**（内联 style、单文件模板字面量）。BD14 起文档页另可引用**一条同源
 * vendored 资产**（`/static/mermaid.min.js`，CSP 放宽见 {@link BOARD_CSP}），仍无任何外源主机。
 * 服务器端渲染；页面脚本 = **白名单化内联字面量常量**（无 `src=`、不含用户数据、单点常量可审计；
 * 纪律钉 = `test/n3-regression-anchors.test.mjs` N3-⑦/⑧，闭集 = 提交守卫 {@link SUBMIT_GUARD_SCRIPT}
 * + 错误浮层关闭 + mermaid 渲染 + 排期页详情浮层 {@link FEATURE_DETAIL_OVERLAY_SCRIPT}）；
 * 刷新 = 浏览器重载。
 */
import { readVersion } from "../version.js";

/**
 * 与 orch 网页面同构的强 CSP。
 *
 * **收口轨 14 的明示放宽**：为杜绝写表单连点，页面新增**一段同源内联脚本**（提交守卫，见
 * {@link SUBMIT_GUARD_SCRIPT}）—— 原 CSP 无 `script-src` 指令时脚本落 `default-src 'none'` 被全拒，
 * 故新增 `script-src 'unsafe-inline'`：**只放行页面内联脚本，仍无任何外源**（`'unsafe-inline'`
 * 仅作用于本仓服务端自己渲染的字面量，不加载任何 URL；其余指令一概未动）。
 *
 * **BD14 的第二次明示放宽**：文档页渲染流程图需加载**同源 vendored 资产**
 * （`/static/mermaid.min.js`，版本钉与升级纪律见 README「vendored 静态资产」），
 * 故 `script-src` 追加 `'self'`。放宽面**仅此一条**：`'self'` = 同源（板恒绑 loopback），
 * 仍无任何外源主机可加载；`default-src 'none'` / `style-src` / `base-uri` / `form-action` 未动，
 * 文档内容不进 `<script>` 字面量（mermaid 源文本走 `<script type="application/json">` 安全通道）。
 *
 * **增补轨 2 的第三次明示放宽**：排期页详情浮层（{@link FEATURE_DETAIL_OVERLAY_SCRIPT}）以
 * `fetch(同 URL)` 拉取整页再摘取详情区，而本 CSP 此前**无 `connect-src` 指令** ⇒ 回落到
 * `default-src 'none'`，同源 fetch 被浏览器静默拦截、浮层永远走降级整页导航。
 * 故新增 **`connect-src 'self'`**：仅放行**同源**请求（板恒绑 loopback），仍无任何外源主机
 * 可被 fetch；其余指令一概未动。
 */
export const BOARD_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'";

/**
 * 本板文档的 Referer 送出策略（BD17）：**同时**以响应头与 `<meta name=referrer>` 给出（同值单点）。
 *
 * `same-origin` = **同源请求发 Referer、跨站不发**。不得回退成 `no-referrer`：写面守卫的表单档兜底
 * 第二档就是「同源 Referer」（`write-guard.ts` 的 `checkWriteAuth`），而**无 JS 的表单在隐私扩展 /
 * sandboxed iframe 下 `Origin` 会是字面 `null`** ⇒ 若此处禁掉 Referer，两档来源信号同时归零，
 * 板会把自己的「页面上提交需求」这条路掐死（v0.9.0 收口轨 11 修了判定、轨 12 才修到信号源）。
 * CSRF 不受削弱：跨站请求本来就发不出可冒充同源的 Referer，第一档自定义头同样发不出。
 */
export const BOARD_REFERRER_POLICY = "same-origin";

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type NavKey = "features" | "schedule" | "tasks" | "projects" | "orgs" | "host";

/**
 * **提交守卫**（收口轨 14 ①）：页面全部写表单共用的**一段内联脚本**。
 *
 * 背景：写表单提交后是**整页跳转 + 服务端同步等**（触发一轮可跑数分钟），期间零反馈 ⇒
 * 用户「点了像没点」而连点，第二发进了排队多烧一轮。本脚本在 `submit` 时**立即禁用该表单的
 * 提交按钮**并就地显示提示行（文案 = 表单的 `data-submit` 属性，逐表单定制），整页跳转后
 * 新页面自然复位。禁用只是**体验层**——无 JS / JS 失效时照常提交（服务端防重另有
 * `board_turn_busy` 409 硬闸），CSRF 判定也不依赖本脚本（表单档同源 Origin/Referer 照旧成立）。
 *
 * 与页面同字面量渲染（不含用户数据 ⇒ 无注入面；脚本内不得出现 `</script` 字面量）。
 */
export const SUBMIT_GUARD_SCRIPT = `<script>
(function () {
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || typeof form.querySelectorAll !== "function") return;
    if ((form.getAttribute("method") || "").toLowerCase() !== "post") return;
    var note = form.getAttribute("data-submit") || "已提交，处理中…";
    var btns = form.querySelectorAll("button[type=submit]");
    for (var i = 0; i < btns.length; i += 1) {
      btns[i].disabled = true;
      btns[i].setAttribute("aria-disabled", "true");
    }
    if (form.querySelector(".submit-pending") === null) {
      var p = document.createElement("p");
      p.className = "hint submit-pending";
      p.textContent = note;
      form.appendChild(p);
    }
  });
})();
</script>`;

/**
 * **排期页详情浮层脚本**（REQ-v0.9.2-2026-09-26-02 增补 ④）：渐进增强 —— 卡片标题仍是
 * `<a href="/features/:id">`（禁 JS / 脚本失效 = 整页详情，回退面不受影响）。JS 可用时，
 * 委托监听 `.kcard` 内指向详情页的链接点击：`preventDefault()` → fetch 同 URL →
 * `DOMParser` 抽 `<main>` 内层 → 节点搬进 `#feat-dialog` 的 body（不用 innerHTML 字符串
 * 重解析）→ `showModal()`；fetch 失败 / 响应非 2xx / 解析不到 `<main>` ⇒ 降级为原生导航
 * （`location.href`）。
 *
 * **浮层内导航**（增补轨 · 本轮修根因）：委托同时拦截 `#feat-dialog` 内任意同源内部链接
 * （`a[href^="/"]` 且无 `target` 属性）—— 文档页 /「回到需求详情」/ 渲染原文切换等点击
 * 同样 fetch + 抽 `<main>` 替换 body，URL 不变，降级口径同上。两分支互斥：dialog 内
 * 链接先命中浮层分支（卡片在 dialog 外，不受影响）。
 *
 * **`Accept: "text/html"` 不是装饰，是这个分支能否工作的条件**（真浏览器反馈的根因）：
 * 文档读面 `GET /features/:id/docs` 按 `Accept` **双档分流**（`server.ts` 的 `handleFeatureDoc`：
 * 含 `text/html` ⇒ 整页；否则 ⇒ `text/plain` 原文）。而 `fetch()` 缺省的 `Accept` 是通配
 * （不含 `text/html`）⇒ 拿到的是纯文本 ⇒ `DOMParser` 里**没有 `<main>`** ⇒ 走 `fallback()`
 * **整页跳转**
 * —— 分支代码在、`preventDefault()` 也调了，用户看到的仍是跳页（详情页 / 排期页两条路由
 * 无 Accept 分流，所以卡片打开浮层一直是好的，只有文档链跳）。故两处 fetch **必须**显式声明
 * `Accept: "text/html"`；缺省头一恢复即回归本缺陷（锚见 `test/schedule-page.test.mjs` N2-⑥/⑦）。
 *
 * **浮层内表单提交 = 浮层内完成**（增补轨 · 推翻旧「不拦截」口径）：委托 `submit` 事件，
 * **只拦 `#feat-dialog` 内的 POST 表单**（触发一轮 / 发送确认指令 / 澄清回答 / 保存排期）→
 * `preventDefault()` → `fetch(form.action, POST, body)`。响应分两档：
 * **2xx/3xx（含 303 自动跟随后的最终页）⇒ 抽 `<main>` 换入浮层 body**（详情在浮层内刷新）；
 * **4xx/5xx ⇒ 不替换 body**（保表单与已填输入），只抽 `.err-ov-card` **作为 dialog 的直接子元素
 * 叠加**（`position: fixed` 居中 + 超大 spread shadow 当遮罩 ⇒ 悬浮在浮层内容之上，**不挤占
 * `.fd-body` 文档流**；dialog 在 top-layer 内，fixed 相对视口生效，样式见 `dialog.fd > .err-ov-card`），
 * 「知道了」点击经委托摘卡（浮层不关），用户可改后重提交 —— 旧口径「错误页 main 也换入 body」
 * 作废（那是「重复内容」缺陷的根因：表单页主体 + 错误卡两份）；旧口径「错误卡前置进 `.fd-body`」
 * 同样作废（那是「错误卡出现在弹窗页最上面而非上层」的根因 —— 挤进内容流、把表单顶下去）。
 * 抽不到 `.err-ov-card`
 * ⇒ 回退为「换入错误页 main」（现行为，保错误信息不丢）。
 * 搬入的错误卡里「知道了」按钮的原页面脚本不会执行（搬运节点不跑 `<script>`），
 * 故本脚本自带一条委托把它摘掉卡片。浮层内换页 / 换入新内容（{@link swapPage}）时先摘残留的
 * 叠加卡（{@link dropCard}），不让旧错误卡在 top-layer 上钉死。
 * 编码纪律：**body 必须 urlencoded**
 * （`new URLSearchParams(new FormData(form))`）—— 服务端写面用 `new URLSearchParams(raw)` 解析，
 * `FormData` 直投会发成 `multipart/form-data` ⇒ 字段全丢。fetch 网络异常 / 响应结构不可解析
 * ⇒ 降级 `form.submit()` 原生提交（行为同无 JS；此前不动 body，表单仍在文档内，submit 可执行）。
 * **提交后的表单状态恢复**（{@link restoreForm}）：{@link SUBMIT_GUARD_SCRIPT} 在 submit 时禁用
 * 提交按钮并挂 `.submit-pending` 提示行，其复位依赖「整页跳转后新页面自然复位」—— 浮层内提交
 * **不跳页**，故本脚本在响应处理完之后对该 form 主动恢复（重新启用 `button[disabled]` + 摘提示行）；
 * 错误路径必须恢复（用户要改后重提），成功路径 body 已被替换 ⇒ 恢复落在已摘走的表单上，自然无效。
 * 降级 `form.submit()` **之前**同样先恢复（防「禁用态提交」与后续 UI 卡在灰态）。
 * CSRF 不因此改变：同源 fetch 自动带 `Origin`（`Referrer-Policy: same-origin` 下另带同源
 * `Referer`），`checkWriteAuth` 两档原样工作；连点防护仍靠 {@link SUBMIT_GUARD_SCRIPT}
 * （与本脚本同事件、不同注册点，`preventDefault()` 不互相阻断）+ 服务端 409 硬闸。
 * 卡片分支与浮层外一切表单**不变**（无 JS 回退面保持整页 POST）。
 * 脚本字面量本身不含用户数据 ⇒ 无注入面
 * （与 {@link SUBMIT_GUARD_SCRIPT} 同规格：单点常量、纯内联、无 `src=`、无 `</script` 字面量）。
 */
export const FEATURE_DETAIL_OVERLAY_SCRIPT = `<script>
(function () {
  var dlg = document.getElementById("feat-dialog");
  if (dlg === null || typeof dlg.showModal !== "function" || typeof fetch !== "function") return;
  var body = dlg.querySelector(".fd-body");
  var lastHref = "";
  function fallback(a) { window.location.href = a.href; }
  function restoreForm(form) {
    var btns = form.querySelectorAll("button[disabled]");
    for (var i = 0; i < btns.length; i += 1) {
      btns[i].disabled = false;
      btns[i].removeAttribute("aria-disabled");
    }
    var p = form.querySelector(".submit-pending");
    if (p !== null && p.parentNode !== null) { p.parentNode.removeChild(p); }
  }
  function nativeSubmit(form) { restoreForm(form); form.submit(); }
  function parsePage(html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    return { main: doc.querySelector("main"), card: doc.querySelector(".err-ov-card") };
  }
  function dropCard() {
    var kids = dlg.children;
    for (var i = kids.length - 1; i >= 0; i -= 1) {
      if (kids[i].classList.contains("err-ov-card") && kids[i].parentNode !== null) { kids[i].parentNode.removeChild(kids[i]); }
    }
  }
  function showCard(card) {
    dropCard();
    dlg.appendChild(card);
    if (!dlg.open) dlg.showModal();
  }
  function swapPage(html) {
    var parsed = parsePage(html);
    var main = parsed.main;
    var card = parsed.card;
    if (main === null && card === null) return false;
    dropCard();
    if (body !== null) {
      while (body.firstChild !== null) { body.removeChild(body.firstChild); }
      if (card !== null) { body.appendChild(card); }
      if (main !== null) { while (main.firstChild !== null) { body.appendChild(main.firstChild); } }
    }
    if (!dlg.open) dlg.showModal();
    return true;
  }
  function open(a, toggle) {
    var href = a.getAttribute("href") || "";
    if (toggle && href === lastHref && dlg.open) { dlg.close(); dlg.returnValue = ""; return; }
    dlg.returnValue = "";
    if (body !== null) body.textContent = "加载中…";
    fetch(href, { credentials: "same-origin", headers: { Accept: "text/html" } }).then(function (res) {
      if (!res.ok) { fallback(a); return null; }
      return res.text();
    }).then(function (text) {
      if (text === null || text === undefined) return;
      if (swapPage(text)) { lastHref = href; } else { fallback(a); }
    }).catch(function () { fallback(a); });
  }
  function postForm(form) {
    var data;
    try { data = new URLSearchParams(new FormData(form)); } catch (err) { data = null; }
    if (data === null) { nativeSubmit(form); return; }
    dlg.returnValue = "";
    fetch(form.action, {
      method: "POST",
      body: data,
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    }).then(function (res) {
      if (!res.ok) { return res.text().then(function (text) { return { err: true, text: text }; }); }
      return res.text().then(function (text) { return { err: false, text: text }; });
    }).then(function (r) {
      if (r.err) {
        var parsed = parsePage(r.text);
        if (parsed.card !== null) { showCard(parsed.card); return; }
        if (!swapPage(r.text)) { nativeSubmit(form); }
        return;
      }
      if (!swapPage(r.text)) { nativeSubmit(form); }
    }).then(function () {
      restoreForm(form);
    }).catch(function () { nativeSubmit(form); });
  }
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t === null || typeof t.closest !== "function") return;
    var dismiss = t.closest("#feat-dialog #err-ov-close");
    if (dismiss !== null) {
      e.preventDefault();
      var card = dismiss.closest(".err-ov-card");
      if (card !== null && card.parentNode !== null) { card.parentNode.removeChild(card); }
      return;
    }
    var nav = t.closest('#feat-dialog a[href^="/"]');
    if (nav !== null) {
      if (nav.hasAttribute("target")) return;
      e.preventDefault();
      open(nav, false);
      return;
    }
    var a = t.closest('a[href^="/features/"]');
    if (a === null || a.closest(".kcard") === null) return;
    e.preventDefault();
    open(a, true);
  });
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (form === null || typeof form.closest !== "function") return;
    if (form.closest("#feat-dialog") === null) return;
    if ((form.getAttribute("method") || "").toLowerCase() !== "post") return;
    e.preventDefault();
    postForm(form);
  });
  var closeBtn = document.getElementById("feat-dialog-close");
  if (closeBtn !== null) closeBtn.addEventListener("click", function () { dlg.close(); dlg.returnValue = ""; });
  dlg.addEventListener("cancel", function () { dlg.returnValue = ""; });
  dlg.addEventListener("click", function (e) {
    if (e.target !== dlg) return;
    var r = dlg.getBoundingClientRect();
    var inBox = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inBox) { dlg.close(); dlg.returnValue = ""; }
  });
})();
</script>`;

const NAV: ReadonlyArray<{ key: NavKey; href: string; text: string }> = [
  { key: "features", href: "/requirements", text: "需求" },
  { key: "schedule", href: "/schedule", text: "排期" },
  { key: "tasks", href: "/tasks", text: "任务" },
  { key: "projects", href: "/projects", text: "项目 / 机器" },
  { key: "orgs", href: "/orgs", text: "组织" },
  { key: "host", href: "/host", text: "宿主桥" },
];

export interface PageParams {
  title: string;
  active: NavKey;
  /** 已转义的正文 HTML 片段 */
  bodyHtml: string;
  /** 页面级口径脚注（B13 / 并行度等，逐条渲染，内部已转义） */
  notes?: readonly string[];
  /** 错误浮层（REQ 弹窗化 · 表单档错误出口专用；全部字段在本函数内 escapeHtml，调用方传原始值） */
  errorOverlay?: ErrorOverlayParams;
}

export interface ErrorOverlayField {
  label: string;
  value: string;
}

export interface ErrorOverlayParams {
  /** 标题 = 错误码中文族名（views.errorFamilyLabel 给出，无命中回退原文 code） */
  family: string;
  /** 正文 = 错误文案（原始值，本函数转义） */
  error: string;
  /** mono 小字 = 错误码（原始值，本函数转义） */
  code: string;
  /** 可选补充行（如「刷新本页重试」），同样转义 */
  hint?: string;
  /** 回填字段（REQ-v0.9.2 N1）：表单写路径失败时回显用户刚提交值，逐字段转义（空值由调用方省略） */
  fields?: readonly ErrorOverlayField[];
}

function renderErrorOverlay(o: ErrorOverlayParams): string {
  const fields =
    o.fields === undefined || o.fields.length === 0
      ? ""
      : o.fields
          .map(
            (x) =>
              `<p class="err-ov-field"><span class="err-ov-field-label">${escapeHtml(x.label)}</span>` +
              `<span class="err-ov-field-value mono">${escapeHtml(x.value)}</span></p>`,
          )
          .join("\n") +
        "\n";
  return `<div class="err-ov" id="err-ov" role="alertdialog" aria-modal="true">
<div class="err-ov-card">
<h2>${escapeHtml(o.family)}</h2>
<p>${escapeHtml(o.error)}</p>
${o.hint === undefined ? "" : `<p class="hint">${escapeHtml(o.hint)}</p>`}
<p class="err-ov-code mono">${escapeHtml(o.code)}</p>
${fields}<button type="button" id="err-ov-close">知道了</button>
</div>
</div>
<script>
(function () {
  var ov = document.getElementById("err-ov");
  var btn = document.getElementById("err-ov-close");
  if (ov !== null && btn !== null) {
    btn.addEventListener("click", function () { ov.parentNode.removeChild(ov); });
  }
})();
</script>`;
}

export function renderPage(params: PageParams): string {
  const nav = NAV.map(
    (n) =>
      `<a href="${n.href}"${n.key === params.active ? ' class="on"' : ""}>${escapeHtml(n.text)}</a>`,
  ).join("");
  const notes =
    params.notes && params.notes.length > 0
      ? `<ul class="notes">${params.notes.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
      : "";
  const overlay = params.errorOverlay === undefined ? "" : renderErrorOverlay(params.errorOverlay);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="referrer" content="${BOARD_REFERRER_POLICY}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(params.title)} · board</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px 20px 48px; font: 14px/1.55 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  h2 { font-size: 15px; margin: 24px 0 8px; border-bottom: 1px solid #8884; padding-bottom: 4px; }
  nav { display: flex; gap: 12px; margin: 0 0 14px; }
  nav a { color: #567; text-decoration: none; padding: 2px 8px; border-radius: 4px; }
  nav a.on { background: #8882; color: inherit; }
  .hint { color: #777; margin: 6px 0; }
  .hint.err { color: #b42318; }
  .hint.warn { color: #b26a00; }
  pre.result { background: #8881; border: 1px solid #8884; border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Consolas, monospace; font-size: 12px; margin: 6px 0; }
  table { border-collapse: collapse; width: 100%; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  th, td { border: 1px solid #8884; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #8881; }
  td.empty { color: #888; }
  tr.warn td { color: #b42318; }
  .muted { color: #888; font-size: 11px; }
  .mono { font-family: ui-monospace, Consolas, monospace; }
  ul.notes { color: #777; font-size: 12px; margin: 10px 0 0; padding-left: 18px; }
  form { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  form.w { flex-direction: column; align-items: stretch; gap: 6px; padding: 10px 12px; border: 1px solid #8884; border-radius: 6px; }
  form.w label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: #667; }
  form.w button { align-self: flex-start; }
  input, button, select, textarea { font: inherit; padding: 3px 8px; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  p.submit-pending { color: #b26a00; font-weight: 600; }
  p.nextstep { border-left: 3px solid #5678; padding: 4px 10px; background: #8881; border-radius: 0 6px 6px 0; }
  p.turn-progress { border-left: 3px solid #b26a0088; padding: 4px 10px; background: #8881; border-radius: 0 6px 6px 0; color: #b26a00; }
  textarea { resize: vertical; }
  code { background: #8881; padding: 0 3px; border-radius: 3px; }
  .md h1 { font-size: 17px; margin: 18px 0 6px; }
  .md h2 { font-size: 15px; }
  .md h3 { font-size: 14px; }
  .md h4, .md h5, .md h6 { font-size: 13px; margin: 16px 0 6px; }
  .md p { margin: 8px 0; }
  .md ul, .md ol { margin: 8px 0; padding-left: 22px; }
  .md li { margin: 2px 0; }
  .md-t th, .md-t td { font-family: inherit; font-size: 13px; }
  blockquote.md-q { margin: 8px 0; padding: 4px 10px; border-left: 3px solid #8886; color: #667; background: #8881; border-radius: 0 6px 6px 0; }
  .md .mermaid-block { margin: 10px 0; overflow-x: auto; }
  .md .mermaid-block[data-rendered="1"] pre.mermaid-src { display: none; }
  .md .mermaid-block[data-rendered="1"] .mermaid-svg:empty { display: none; }
  .md .mermaid-block svg { max-width: 100%; height: auto; }
  a.fl { color: inherit; }
  .err-ov { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: #0006; padding: 16px; }
  .err-ov-card { max-width: 560px; width: 100%; background: Canvas; border: 1px solid #b4231888; border-radius: 8px; padding: 14px 18px 16px; box-shadow: 0 6px 24px #0004; }
  .err-ov-card h2 { font-size: 15px; margin: 0 0 8px; border: none; color: #b42318; padding: 0; }
  .err-ov-card p { margin: 4px 0; white-space: pre-wrap; word-break: break-word; }
  .err-ov-card .err-ov-code { color: #888; font-size: 11px; }
  .err-ov-field { font-size: 12px; margin: 2px 0; }
  .err-ov-field-label { color: #888; margin-right: 6px; }
  .err-ov-field-value { color: inherit; word-break: break-word; }
  .err-ov-card button { margin-top: 10px; }
  .kanban { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding-bottom: 6px; }
  .kcol { flex: 0 0 260px; border: 1px solid #8884; border-radius: 6px; background: #8881; padding: 6px 8px 8px; }
  .kcol > h3 { font-size: 13px; margin: 2px 0 8px; border-bottom: 1px solid #8884; padding-bottom: 4px; }
  .kcard { border: 1px solid #8884; border-radius: 6px; background: Canvas; padding: 6px 8px; margin: 0 0 6px; font-size: 12px; }
  .kbadge { float: right; margin-left: 6px; font-size: 11px; color: #567; border: 1px solid #8886; border-radius: 8px; padding: 0 6px; white-space: nowrap; }
  .vbadge { float: none; cursor: help; }
  .vbadge.locked { color: #654321; border-color: #a67c52; background: #f3e5d0; font-weight: 600; }
  .vbadge.wip { color: #25567a; border-color: #5b86a8; background: #e3eef7; }
  .vbadge.closed { color: #3a5a40; border-color: #6b8f71; background: #e6f0e8; }
  .kmeta { margin: 4px 0 0; color: #667; font-size: 11px; }
  dialog.fd { width: min(880px, 92vw); max-height: 86vh; overflow-y: auto; margin: auto; border: 1px solid #8888; border-radius: 8px; padding: 12px 18px 16px; background: Canvas; color: CanvasText; box-shadow: 0 8px 32px #0005; }
  dialog.fd::backdrop { background: #0006; }
  dialog.fd > button { margin: 0 0 8px; }
  dialog.fd .fd-body > h2:first-child { margin-top: 0; }
  dialog.fd > .err-ov-card { position: fixed; inset: 0; margin: auto; height: fit-content; max-height: 80vh; overflow-y: auto; z-index: 60; box-shadow: 0 0 0 100vmax #0006, 0 6px 24px #0004; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(params.title)}</h1>
  <nav>${nav} <span class="muted mono">board v${escapeHtml(readVersion())} · 只读 + 提需求</span></header>
<main>
${params.bodyHtml}
${notes}
</main>
${overlay}
${SUBMIT_GUARD_SCRIPT}
</body>
</html>
`;
}

export function emptyRow(cols: number, text: string): string {
  return `<tr><td colspan="${cols}" class="empty">${escapeHtml(text)}</td></tr>`;
}

/** 通用错误正文（桥不可达等 —— 必须可见，不得静默）。 */
export function errorBody(message: string, hint: string): string {
  return `<p class="hint err">${escapeHtml(message)}</p><p class="hint">${escapeHtml(hint)}</p>`;
}
