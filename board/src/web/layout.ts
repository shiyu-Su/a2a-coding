/**
 * 板页面模板骨架（BD3）—— 照 `orch/bridge/web/html.ts` 路线：
 * **同源、无构建、无框架**（内联 style、单文件模板字面量）。BD14 起文档页另可引用**一条同源
 * vendored 资产**（`/static/mermaid.min.js`，CSP 放宽见 {@link BOARD_CSP}），仍无任何外源主机。
 * 服务器端渲染；页面脚本 = **白名单化内联字面量常量**（无 `src=`、不含用户数据、单点常量可审计；
 * 纪律钉 = `test/n3-regression-anchors.test.mjs` N3-⑦/⑧，闭集 = 提交守卫 {@link SUBMIT_GUARD_SCRIPT}
 * + 错误浮层关闭 + mermaid 渲染 + 排期页详情浮层 {@link FEATURE_DETAIL_OVERLAY_SCRIPT}
 * + 新增需求弹窗 {@link NEW_REQUIREMENT_DIALOG_SCRIPT}
 * + 排期拖拽 {@link DRAG_SCHEDULE_SCRIPT}（v0.9.3 B-T5，闭集五→六元；与弹窗常量分立、不可共置））；
 * 刷新 = 浏览器重载；**唯一例外** = 浮层动作区提交后的**有界进度轮询**（复用既有详情读面 +
 * 既有 {@link FEATURE_DETAIL_OVERLAY_SCRIPT} 的 `swapPage` 通路，零新端点、零新枚脚本，见该常量注记）。
 */

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

export type NavKey = "home" | "features" | "schedule" | "tasks" | "projects" | "agents" | "host";

/**
 * **组织上下文（v0.9.4 D 档 · BD7）**：`renderPage` 的 NAV 组织感知与顶栏组织切换器的唯一输入。
 *
 * - `org` = 当前页面所处的组织空间（`null` ⇒ 全局页面，NAV 落全局路径）；
 * - `orgs` = 顶栏切换器的组织清单（**服务端渲染的链接列表**，跳转 = 全页刷新 ⇒
 *   零新脚本，内联脚本闭集保持六元，见 {@link PageParams.orgNav}）。
 */
export interface PageOrgNav {
  org: string | null;
  orgs: readonly string[];
}

/** NAV 全局路径 → 组织空间路径的映射（`ORG_SPACE_VIEWS`）与 {@link navHrefFor} 已随 v0.9.6 B5a 退役：
 * NAV 收三枚后全站同形，组织空间不再派生 NAV 落点（空间内导航 = `renderSpaceNav` 自己的链接行）。 */

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
 *
 * **增补二 §9.1-② 的扩写（闭集六元不扩，在本常量体内扩）**：带 `data-ov="1"` 标记的写表单
 * （manage 成员增删 / 停用 + 门户建组织）改 **fetch 提交 + 浮层报错**，口径对齐改版排期表单：
 * - **2xx/3xx（303 被 fetch 自动跟随 ⇒ 最终页 ok）⇒ 整页刷新**（成功回执以服务端重渲染为事实源）；
 * - **4xx/5xx ⇒ 页面不跳**：抽错误页 `.err-ov-card` 叠加为 `document.body` 直接子元素
 *   （`.ov-err-overlay` = 与拖拽错误卡同款 fixed 居中 + 遮罩），「知道了」由错误页自带脚本摘除；
 *   抽不到卡 ⇒ 刷新兜底（错误可见，不静默）；
 * - fetch 网络异常 ⇒ 刷新（同拖拽口径）；`e.defaultPrevented` ⇒ 让位（详情浮层 / 新增需求弹窗
 *   各有自己的 submit 委托，先注册先处理，本守卫不抢）；
 * - 提交标记 `data-ov-pending` 防连点双发（原生 `form.submit()` 路径不派发 submit 事件 ⇒ 天然不双提交）；
 * - **无 JS / 脚本失效 = 原生 PRG 整页回显**（标记只是体验层，回退面不劣化、不扩内联脚本闭集）。
 *
 * **增补三 §9.2（form.action 遮蔽修复）**：fetch 目标 URL 一律读**属性**
 * `form.getAttribute("action")`，**不得直读 `form.action`** —— 成员/停用表单带
 * `name="action"` 隐藏字段，`HTMLFormElement` 的 `[LegacyOverrideBuiltIns]` 使同名字段
 * 遮蔽 `action` 属性，直读拿到的是 input 元素 ⇒ 强转成伪 URL（405 实证根因）；
 * 属性读为空 ⇒ 回落 `form.submit()` 原生提交（不劣化）。负向锚见 `test/web.test.mjs`。
 *
 * **增补四 §9.3 的扩写（闭集六元不扩，在本常量体内扩）**：注入卡上的「知道了」按钮点了不关
 * —— 关闭逻辑原靠「错误页自带脚本」（`renderErrorOverlay` 的直接绑定），而卡片是经
 * `DOMParser` 惰性文档摘入本文档的：**搬运节点不跑 `<script>`** ⇒ 按钮无处理器
 * （manage / 门户两页各只注入本枚脚本，没有 /schedule 侧三枚浮层脚本的委托兜底）。
 * 补一条 **document 级 click 委托**：命中 `#err-ov-close` ⇒ `closest(".err-ov-card")` 摘除该卡
 * （动态注入天然覆盖），口径对齐 /schedule 侧 `closest(...err-ov-card...)` 委托先例。
 *
 * **增补五 §9.4-② 的扩写（闭集六元不扩，在本常量体内扩）**：成功路径支持 `data-ov-redirect` 属性
 * —— 停用表单提交成功后**当前页就是刚被关掉的空间页**，`reload()` 必落 410 ⇒ 有该属性则
 * `location.href = 该值`（停用表单给 `/` = 门户，与服务端 303 落点同口径），
 * 无该属性 ⇒ 维持原 reload 行为（建组织 / 成员增删的成功页就在本处）。
 * **只在成功（2xx/3xx）路径生效**：4xx/5xx 与网络异常仍留在本页出浮层（失败不跳走）。
 */
export const SUBMIT_GUARD_SCRIPT = `<script>
(function () {
  function ovShowCard(card) {
    var old = document.querySelectorAll("body > .err-ov-card.ov-err-overlay");
    for (var i = 0; i < old.length; i += 1) { if (old[i].parentNode !== null) { old[i].parentNode.removeChild(old[i]); } }
    card.classList.add("ov-err-overlay");
    document.body.appendChild(card);
  }
  function ovRestore(form) {
    form.removeAttribute("data-ov-pending");
    var btns = form.querySelectorAll("button[disabled]");
    for (var i = 0; i < btns.length; i += 1) {
      btns[i].disabled = false;
      btns[i].removeAttribute("aria-disabled");
    }
    var p = form.querySelector(".submit-pending");
    if (p !== null && p.parentNode !== null) { p.parentNode.removeChild(p); }
  }
  function ovSubmit(form) {
    var data;
    try { data = new URLSearchParams(new FormData(form)); } catch (err) { data = null; }
    // 增补三 §9.2：必须 getAttribute —— 成员/停用表单带 name="action" 字段，
    // HTMLFormElement 的 [LegacyOverrideBuiltIns] 会让同名字段遮蔽 action 属性直读。
    var action = form.getAttribute("action") || "";
    if (data === null || action === "") { ovRestore(form); form.submit(); return; }
    fetch(action, {
      method: "POST",
      body: data,
      credentials: "same-origin",
      headers: { Accept: "text/html" }
    }).then(function (res) {
      return res.text().then(function (text) { return { ok: res.ok, text: text }; });
    }).then(function (r) {
      // 增补五 §9.4-②：表单带 data-ov-redirect 时成功改跳该落点（停用后刷新当前空间页必 410），
      // 无该属性 ⇒ 维持原 reload 口径。
      var redirect = form.getAttribute("data-ov-redirect") || "";
      if (r.ok) { gotoAfterSubmit(redirect); return; }
      var doc = new DOMParser().parseFromString(r.text, "text/html");
      var card = doc.querySelector(".err-ov-card");
      if (card === null) { window.location.reload(); return; }
      ovRestore(form);
      ovShowCard(card);
    }).catch(function () { gotoAfterSubmit(""); });
  }
  function gotoAfterSubmit(redirect) {
    if (redirect !== "") { window.location.href = redirect; return; }
    window.location.reload();
  }
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || typeof form.querySelectorAll !== "function") return;
    if ((form.getAttribute("method") || "").toLowerCase() !== "post") return;
    if (e.defaultPrevented) return;
    if ((form.getAttribute("data-ov") || "") === "1") {
      if (form.getAttribute("data-ov-pending") === "1") { e.preventDefault(); return; }
      form.setAttribute("data-ov-pending", "1");
    }
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
    if (form.getAttribute("data-ov") === "1") { e.preventDefault(); ovSubmit(form); }
  });
  // 增补四 §9.3：document 级委托摘「知道了」（DOMParser 搬入的卡不跑自带脚本；
  // 委托天然覆盖动态注入卡，口径对齐 /schedule 侧 closest(...err-ov-card...) 先例）。
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t === null || typeof t.closest !== "function") return;
    var btn = t.closest("#err-ov-close");
    if (btn === null) return;
    var card = btn.closest(".err-ov-card");
    if (card !== null && card.parentNode !== null) { card.parentNode.removeChild(card); }
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
 * `preventDefault()` → `fetch(form.getAttribute("action"), POST, body)`（属性读取防同名字段遮蔽，
 * 见 {@link SUBMIT_GUARD_SCRIPT} 注记；增补三 §9.2）。响应分两档：
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
 * **提交后的表单状态恢复**（{@link restoreForm}）：浮层分支自行完成 SUBMIT_GUARD 的同款两动作
 * （禁用提交按钮 + 挂 `.submit-pending` 提示行，见下「提交即时反馈」条），其复位在本脚本响应处理
 * 完之后主动执行（重新启用 `button[disabled]` + 摘提示行）；
 * 错误路径必须恢复（用户要改后重提），成功路径 body 已被替换 ⇒ 恢复落在已摘走的表单上，自然无效。
 * 降级 `form.submit()` **之前**同样先恢复（防「禁用态提交」与后续 UI 卡在灰态）。
 *
 * **浮层内提交的连点防护归属（REQ-2026-09-29-02 件D 改述，替换旧的「连点防护仍靠 SUBMIT_GUARD」表述）**：
 * 本分支已 `preventDefault()` ⇒ {@link SUBMIT_GUARD_SCRIPT} 的 submit 委托按 `e.defaultPrevented`
 * **早退**（其语义未动，整页档行为零变化），故浮层内 POST 的防护**不经过**提交守卫，由本分支自带：
 * `data-ov-pending` 挂起标记拦下二次提交 + 按钮即时禁用 + 服务端 409 `board_turn_busy` 硬闸。
 * CSRF 不因此改变：同源 fetch 自动带 `Origin`（`Referrer-Policy: same-origin` 下另带同源
 * `Referer`），`checkWriteAuth` 两档原样工作。
 * 卡片分支与浮层外一切表单**不变**（无 JS 回退面保持整页 POST）。
 *
 * **提交即时反馈 + 第 N 轮进度轮询（REQ-2026-09-29-02 增补，件A / 件B / 件C）**：
 * - **件A（就地反馈）**：submit 委托在 `preventDefault()` 之后、发 fetch **之前**复刻整页档
 *   SUBMIT_GUARD 的两动作（{@link markPending}：提交按钮置灰禁用 + 就地挂 `.submit-pending` 提示行，
 *   文案取表单自带 `data-submit`，动作区档位即「已提交，本轮可能跑数分钟…」）。旧形态下点击后
 *   直到 fetch 返回（触发一轮可数分钟）界面毫无反应 ⇒ 用户以为没生效而连点。提示行的使命到
 *   响应回来为止：成功档整个动作区被服务端重渲染换新（禁用态与提示行随之离场），此后进度由件B 承载；
 *   失败档（409 等）由 `restoreForm` 复位表单供改后重提。
 * - **件B（真实进度）**：成功换页后若回包动作区仍含 `.turn-progress`（= 本轮仍 `running` / `queued`），
 *   起一条**有界**轮询（{@link POLL_INTERVAL_MS} × {@link POLL_MAX_TICKS}，20 分钟量级 = 与宿主 turn
 *   窗口同量级），每拍 `GET` 本详情 URL（带 `Accept: "text/html"`，与 `open()` 同规格）经 `swapPage`
 *   刷回动作区，用户看到真实「第 N 轮 在飞 / 排队中」。收口判据 = 回包**不再**含在飞 / 排队的
 *   `.turn-progress` ⇒ 停；浮层已关 / 窗口耗尽 ⇒ 同样停。**零新增端点、零新增写面**：复用
 *   `GET /features/:id` 读面与既有 `swapPage` 渲染通路；轮询只活在浮层脚本内（无 `#feat-dialog`
 *   的页面整段空转），故不存在「整页自动刷新」。
 * - **件C（竞态）**：`swapPage(html, reopen)` 增第二参 —— 后台轮询传 `false`，**浮层已被用户关闭时
 *   不得 `showModal()` 把它重新弹开**（原实现每次 `swapPage` 末尾无条件补弹，与关闭动作竞态）；
 *   轮询命中「已关浮层」时只 `stopPoll`，不改 `dlg.open`、不落渲染。
 *
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
    form.removeAttribute("data-ov-pending");
  }
  // 件A：浮层分支自行完成整页档 SUBMIT_GUARD 的两动作（该守卫对本表单已 defaultPrevented 早退）。
  // 按钮判定走 .type 属性而非选择器串 —— 提交守卫的闭集归类标记正是那个选择器字面量（N3-⑦ 每枚
  // 恰好 1 处），本常量体内再写一遍会造成两枚脚本归类歧义；属性口径也天然盖住「隐式提交」的单按钮表单。
  function markPending(form) {
    if (form.querySelector(".submit-pending") !== null) return false;
    var note = form.getAttribute("data-submit") || "已提交，处理中…";
    var all = form.querySelectorAll("button");
    for (var i = 0; i < all.length; i += 1) {
      if (all[i].type !== "submit") continue;
      all[i].disabled = true;
      all[i].setAttribute("aria-disabled", "true");
    }
    var p = document.createElement("p");
    p.className = "hint submit-pending";
    p.textContent = note;
    form.appendChild(p);
    return true;
  }
  // 件B：有界进度轮询 —— 复用既有详情读面 GET + swapPage 通路，零新端点、零新写面。
  // 上界 5s × 240 = 20 分钟 = 与宿主 turn 窗口同量级（窗上限 10min、含结构余量的最坏总框 25min）；
  // 收口 / 关浮层任一命中即提前停，故这只是一个"漏停 also 停"的兜底天花板。
  var POLL_INTERVAL_MS = 5000;
  var POLL_MAX_TICKS = 240;
  var pollTimer = null;
  var pollTicks = 0;
  var pollUrl = "";
  function stopPoll() {
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
    pollTicks = 0;
  }
  function stillBusy(main) {
    var m = main.querySelector(".turn-progress");
    return m !== null && (m.textContent.indexOf("在飞") !== -1 || m.textContent.indexOf("排队中") !== -1);
  }
  function schedulePoll() {
    if (pollTicks >= POLL_MAX_TICKS) { stopPoll(); return; }
    pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }
  function pollOnce() {
    pollTimer = null;
    // 件C：浮层已被用户关闭 ⇒ 停轮即可，**不得 showModal 把它重新弹开**，也不改 dlg.open。
    if (!dlg.open || pollUrl === "") { stopPoll(); return; }
    pollTicks += 1;
    fetch(pollUrl, { credentials: "same-origin", headers: { Accept: "text/html" } }).then(function (res) {
      return res.text().then(function (text) { return { ok: res.ok, text: text }; });
    }).then(function (r) {
      if (!r.ok) { schedulePoll(); return; }
      // 读面不可解析（拿不到 main）⇒ 无从判收口，保守续轮，窗口耗尽自然停
      var main = parsePage(r.text).main;
      // 件C：这一拍之间用户可能已关浮层 ⇒ 只停轮，收口渲染不落 showModal
      if (!dlg.open || pollUrl === "") { stopPoll(); return; }
      // 收口（本轮不再在飞 / 排队）⇒ 停轮，末次真实进度已由服务端渲染留在动作区
      if (main === null || !stillBusy(main)) { stopPoll(); return; }
      swapPage(r.text, false);
      schedulePoll();
    }).catch(function () { schedulePoll(); });
  }
  function startPoll(main) {
    stopPoll();
    if (main === null || !stillBusy(main)) return;
    pollUrl = lastHref;
    pollTicks = 1;
    schedulePoll();
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
  function swapPage(html, reopen) {
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
    // 件C：reopen 传 false（后台轮询）时**绝不**把已关闭的浮层重新弹开。
    if (reopen !== false && !dlg.open) { dlg.showModal(); }
    // 搬运节点不跑内联 script（DOMParser 惰性文档）⇒ 详情页依赖图/文档 mermaid 换入后
    // 须主动补渲（钩子由 docs-render.mermaidRenderScript 暴露；无该全局 = 本页未挂 mermaid，跳过）。
    // showModal 在先：渲染不得落在 display:none 容器（98c39da1 前科口径）。
    if (typeof window.a2aRenderMermaid === "function") { try { window.a2aRenderMermaid(); } catch (err) {} }
    return true;
  }
  function open(a, toggle) {
    var href = a.getAttribute("href") || "";
    if (toggle && href === lastHref && dlg.open) { dlg.close(); dlg.returnValue = ""; return; }
    stopPoll();
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
    // 增补三 §9.2：action 走 getAttribute（同名字段遮蔽属性直读），空 ⇒ 原生提交回落
    var action = form.getAttribute("action") || "";
    if (data === null || action === "") { nativeSubmit(form); return; }
    dlg.returnValue = "";
    fetch(action, {
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
        if (parsed.card !== null) { showCard(parsed.card); restoreForm(form); return; }
        if (swapPage(r.text)) { restoreForm(form); } else { nativeSubmit(form); }
        return;
      }
      // 成功（303 跟随后即详情页）：抽 main 换入 body ⇒ 旧表单连同禁用态与提示行一并离场。
      var okMain = parsePage(r.text).main;
      if (!swapPage(r.text)) { nativeSubmit(form); return; }
      // 件B：换入页动作区仍是「在飞 / 排队」⇒ 交棒有界轮询（读面 = 本表单的详情 URL）；
      // 已收口 / 摘不到 main ⇒ 不起轮，静态读面即最新事实。startPoll 内先 stopPoll ⇒ 恒只一条链。
      lastHref = action;
      startPoll(okMain);
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
    // 件A：就地即时反馈（禁用提交按钮 + 挂提示行）+ 连点拦截（挂起标记二次到达即吞掉）。
    // 整页档的 SUBMIT_GUARD 因本行 preventDefault 而早退（defaultPrevented 语义未动）。
    if (form.getAttribute("data-ov-pending") === "1") return;
    if (!markPending(form)) return;
    form.setAttribute("data-ov-pending", "1");
    postForm(form);
  });
  var closeBtn = document.getElementById("feat-dialog-close");
  if (closeBtn !== null) closeBtn.addEventListener("click", function () { stopPoll(); dlg.close(); dlg.returnValue = ""; });
  dlg.addEventListener("cancel", function () { stopPoll(); dlg.returnValue = ""; });
  dlg.addEventListener("click", function (e) {
    if (e.target !== dlg) return;
    var r = dlg.getBoundingClientRect();
    var inBox = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inBox) { stopPoll(); dlg.close(); dlg.returnValue = ""; }
  });
})();
</script>`;

/**
 * **弹窗开/关脚本**（REQ-2026-09-26-04 Q1 起为「新增需求弹窗」；v0.9.4 增补六 §9.5 泛化为
 * **两枚 dialog 共用**）：页头按钮 → `showModal()` 打开对应 dialog ——
 * - `#new-req-dialog`（骨架 = `views.renderNewRequirementDialog`，内嵌 `views.renderRequirementForm`；
 *   宿主 = `/schedule` 页头「＋ 新增需求」）；
 * - `#new-org-dialog`（§9.5；骨架 = `views.renderCreateOrgDialog`，内嵌 `views.renderCreateOrgForm`；
 *   宿主 = 门户 `/` 页头「＋ 建组织」，无 JS 回退 = 门户内联表单 `#new-org-inline`）。
 *
 * 字段/校验均由各自表单函数复用，不改写。
 *
 * **提交 = 同源 fetch POST `/requirements`**（照 {@link FEATURE_DETAIL_OVERLAY_SCRIPT}
 * 增补轨 `65cd03e1` 的先例口径）：
 * - **2xx/3xx（303 被 fetch 自动跟随 ⇒ 最终页 ok）⇒ 关弹窗 + 整页刷新**——新卡落需求池立即可见；
 * - **4xx/5xx ⇒ 只抽 `.err-ov-card` 叠加为 dialog 直接子元素**（fixed 居中盖在内容之上，
 *   不进 `.fd-body` 文档流；样式复用 `dialog.fd > .err-ov-card`），「知道了」经委托摘卡、
 *   弹窗不关、表单值保留可改后重提；抽不到卡 ⇒ 关弹窗原生提交（整页错误页可见，不静默）；
 * - **提交后表单状态恢复**：{@link SUBMIT_GUARD_SCRIPT} 在 submit 时禁用提交按钮并挂
 *   `.submit-pending` 提示行，弹窗内提交不跳页 ⇒ 本脚本处理完响应主动恢复（错误路径必须恢复）；
 * - 编码纪律：body 必须 urlencoded（`new URLSearchParams(new FormData(form))`），服务端写面
 *   用 `new URLSearchParams(raw)` 解析，FormData 直投会发成 multipart ⇒ 字段全丢；
 *   fetch 网络异常 ⇒ 降级 `form.submit()` 原生提交（行为同无 JS）。
 *
 * **为什么是独立 dialog id `#new-req-dialog` 而不是复用 `#feat-dialog`**：详情浮层脚本的 submit
 * 委托拦截 `#feat-dialog` 内全部 POST 表单并做「成功换入 body」——提需求 303 跟随后会把详情页
 * 换进浮层，与「关弹窗刷新看板」的语义冲突；两脚本互不拦截、各管各的 dialog。
 *
 * CSRF 不依赖本脚本：同源 fetch 自动带 `Origin`（`Referrer-Policy: same-origin` 下另带同源
 * `Referer`），`checkWriteAuth` 两档原样工作。脚本字面量不含用户数据 ⇒ 无注入面
 * （与 {@link SUBMIT_GUARD_SCRIPT} 同规格：单点常量、纯内联、无 `src=`、无 `</script` 字面量）。
 *
 * **v0.9.4 增补六 §9.5 的泛化（闭集六元不扩，在本常量体内泛化）**：门户页 `/` 的「＋ 建组织」按钮
 * 需另一枚 `<dialog id="new-org-dialog">`（表单同 `renderCreateOrgForm`）—— 本常量由「单 dialog」
 * 泛化为**一个 `wire(dlg, openBtn, inline)` 同时接两枚 dialog**（`new-req-dialog` / `new-org-dialog`），
 * **不新增第七枚脚本常量、CSP 一律不动**。原 `new-req-*` 行为逐条不变；新增两点：
 * - **按钮服务端 `hidden`、脚本显形**：门户「＋ 建组织」按钮初始 `hidden`（无 JS 不显死按钮），
 *   `openBtn.hidden = false` 显形；`inline` 非空（门户内联回退表单 `#new-org-inline`）⇒ 脚本隐藏之；
 * - **关闭钮改按 dialog 自身子按钮绑定**（`dlg.querySelector("button")` = 骨架上第一枚 `*-close`），
 *   「知道了」摘卡委托按 `dlgId` 派生选择器（替换原写死的 `#new-req-dialog #err-ov-close`）。
 *
 * **v0.9.4 W6（§2.6）入口交互扩写（仍在闭集六元内，不新枚；增补七 a §9.1-a 把落点由门户迁到排期看板；
 * 增补八 §9.3 把交互由原生 `prompt()` 改为同款弹窗）**：
 * 排期看板页头挂一枚 `#new-version-open` 按钮（server 渲染、服务端 `hidden`；无 JS 不显死按钮），
 * `wireNewVersion` 经 `wire()` 接第三枚 `#new-version-dialog`（骨架 = `views.renderNewVersionDialog`，
 * 结构对齐 `#new-req-dialog`）：点击 ⇒ `showModal()`；表单提交同走本常量既有 fetch 通路
 * ⇒ `POST /versions`（隐藏字段 `action=create` + `version`，urlencoded 同源 fetch，零新端点）⇒ 台账落
 * `notstart` 条目、看板出现空列；成功 ⇒ 关弹窗整页刷新；失败抽 `.err-ov-card` 叠加为 dialog 直接子元素
 * （弹窗不关、「知道了」委托摘卡）。无 JS 回落 = 表单原生 POST（整页 PRG）。
 * **v0.9.4 增补十一 E1（§9.6）**：看板尾虚列拖拽 `prompt()` 入口一并撤除 ⇒ 本按钮 + 弹窗是
 * 创建版本的**唯一入口**。「＋ 建组织」两枚 dialog 行为逐条不变。
 */
export const NEW_REQUIREMENT_DIALOG_SCRIPT = `<script>
(function () {
  function wire(dlg, openBtn, inline) {
    if (dlg === null || typeof dlg.showModal !== "function") return;
    var dlgId = dlg.getAttribute("id") || "";
    var form = dlg.querySelector("form");
    function restoreForm() {
      if (form === null) return;
      var btns = form.querySelectorAll("button[disabled]");
      for (var i = 0; i < btns.length; i += 1) {
        btns[i].disabled = false;
        btns[i].removeAttribute("aria-disabled");
      }
      var p = form.querySelector(".submit-pending");
      if (p !== null && p.parentNode !== null) { p.parentNode.removeChild(p); }
    }
    function closeAndReload() { dlg.close(); dlg.returnValue = ""; window.location.reload(); }
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
    function submitNative() {
      if (form === null) return;
      restoreForm();
      form.submit();
    }
    var closeBtn = dlg.querySelector("button");
    if (closeBtn !== null) {
      closeBtn.addEventListener("click", function () { dlg.close(); dlg.returnValue = ""; });
    }
    if (openBtn !== null) {
      openBtn.hidden = false;
      openBtn.addEventListener("click", function () {
        dropCard();
        dlg.returnValue = "";
        dlg.showModal();
      });
    }
    if (inline !== null) inline.hidden = true;
    document.addEventListener("click", function (e) {
      var t = e.target;
      if (t === null || typeof t.closest !== "function") return;
      var dismiss = dlgId === "" ? null : t.closest("#" + dlgId + " #err-ov-close");
      if (dismiss === null) return;
      e.preventDefault();
      var card = dismiss.closest(".err-ov-card");
      if (card !== null && card.parentNode !== null) { card.parentNode.removeChild(card); }
    });
    if (form !== null) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var data;
        try { data = new URLSearchParams(new FormData(form)); } catch (err) { data = null; }
        // 增补三 §9.2：action 走 getAttribute（同名字段遮蔽属性直读），空 ⇒ 原生提交回落
        var action = form.getAttribute("action") || "";
        if (data === null || action === "") { submitNative(); return; }
        dlg.returnValue = "";
        fetch(action, {
          method: "POST",
          body: data,
          credentials: "same-origin",
          headers: { Accept: "text/html" },
        }).then(function (res) {
          return res.text().then(function (text) { return { ok: res.ok, text: text }; });
        }).then(function (r) {
          if (!r.ok) {
            var doc = new DOMParser().parseFromString(r.text, "text/html");
            var card = doc.querySelector(".err-ov-card");
            if (card === null) { closeAndReload(); return; }
            showCard(card);
            restoreForm();
            return;
          }
          closeAndReload();
        }).catch(function () { closeAndReload(); });
      });
    }
    dlg.addEventListener("cancel", function () { dlg.returnValue = ""; });
    dlg.addEventListener("click", function (e) {
      if (e.target !== dlg) return;
      var rect = dlg.getBoundingClientRect();
      var inBox = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (!inBox) { dlg.close(); dlg.returnValue = ""; }
    });
  }
  wire(document.getElementById("new-req-dialog"), document.getElementById("new-req-open"), null);
  wire(document.getElementById("new-org-dialog"), document.getElementById("new-org-open"), document.getElementById("new-org-inline"));
  // 增补七 a（§9.1-a）+ 增补八（§9.3）+ 增补十一 E1（§9.6）：「＋ 新版本」按钮**在排期看板页头**
  // （原门户首页那处已撤除；看板尾虚列拖拽建版本入口已撤 ⇒ 本按钮是全站唯一创建入口）——
  // 点击 ⇒ showModal() 打开 #new-version-dialog（与「＋ 新增需求」同款弹窗）；
  // 表单提交复用 wire()：POST /versions(action=create) → 新版本空列出现。
  // 成功（303 跟随后 ok）⇒ 关弹窗整页刷新（本页即 /schedule，语义同跳看板）；失败抽 .err-ov-card
  // 叠加为 dialog 直接子元素（弹窗不关、「知道了」委托摘卡、表单值保留可改后重提）。
  // 无 JS ⇒ 按钮服务端 hidden 且表单原生 POST 回落（整页 PRG，不显死按钮）；非排期页无此按钮 ⇒ 早退空转。
  function wireNewVersion(btn) {
    if (btn === null) return;
    var dlg = document.getElementById("new-version-dialog");
    if (dlg === null || typeof dlg.showModal !== "function") { btn.hidden = false; return; }
    wire(dlg, btn, null);
  }
  wireNewVersion(document.getElementById("new-version-open"));
})();
</script>`;

/**
 * **排期拖拽脚本**（v0.9.3 B-T5 · REQ-2026-09-26-02 T5）：排期看板卡拖到目标版本列
 * （需求池列 = `data-version=""` ⇒ 清空排期）⇒ `fetch` POST **复用**
 * `POST /features/:id/schedule`（`version=<目标>` urlencoded，与详情页排期表单同载荷、
 * 同 write-guard kind=schedule ⇒ **不新增写路由**）。**成功 = 整页刷新**（列归组以
 * 引擎回写后的列表为事实源，板不本地乐观挪卡）；**失败 = 抽错误页 `.err-ov-card`
 * 叠加为 `document.body` 直接子元素**（fixed 居中，复用 `dialog.fd > .err-ov-card`
 * 的遮罩先例 ⇒ 409 双条件闸 / 已发版锁可见、「知道了」经委托摘卡）；抽不到卡 ⇒
 * 原生整页导航到错误页兜底可见；fetch 网络异常 ⇒ 提示行后刷新（不静默）。
 *
 * 执法永远在服务端（本脚本只是体验层）：闸锁卡片服务端渲染为**无 `draggable` 属性**
 * （`views.ts` 的 `deriveScheduleGateOpen` 判据），拖不动即拖不了；
 * 目标列与卡片现版本相同 ⇒ 不发请求（同版重提本为幂等，省一跳）。
 * `dragover` 需 `preventDefault()` 才能落地；版本列与池列都带 `data-version`，
 * 以属性存在而非 class 判定，避免与列头徽标样式耦合。
 *
 * **v0.9.4 增补十一 E1（§9.6）**：尾列「新版本」虚列的 drop-建版本分支（含 `window.prompt()`
 * 输入路径）已随虚列一并撤除 —— 创建版本的唯一入口 = 页头「＋ 新版本」按钮 + 弹窗
 * （{@link NEW_REQUIREMENT_DIALOG_SCRIPT}）；本脚本只做「拖到已有版本列 / 池列 = 改排期」一件事。
 *
 * 与 {@link FEATURE_DETAIL_OVERLAY_SCRIPT} / {@link NEW_REQUIREMENT_DIALOG_SCRIPT}
 * 同规格：单点常量、纯内联、无 `src=`、不含用户数据、体内无 `</script` 字面量；
 * **与弹窗常量分立、不可共置**（闭集钉「每枚恰好 1 处」，N3-⑦/⑧）。
 */
export const DRAG_SCHEDULE_SCRIPT = `<script>
(function () {
  var board = document.getElementById("schedule-board");
  if (board === null || typeof fetch !== "function" || typeof DragEvent !== "function") return;
  function colOf(node) {
    var el = node;
    while (el !== null && el !== board) {
      if (el.nodeType === 1 && typeof el.getAttribute === "function" && el.getAttribute("data-version") !== null) return el;
      el = el.parentNode;
    }
    return null;
  }
  function dropCard() {
    var kids = document.body.children;
    for (var i = kids.length - 1; i >= 0; i -= 1) {
      if (kids[i].classList && kids[i].classList.contains("err-ov-card") && kids[i].parentNode !== null) { kids[i].parentNode.removeChild(kids[i]); }
    }
  }
  function showCard(card) {
    dropCard();
    card.classList.add("drag-err-overlay");
    document.body.appendChild(card);
    var btn = card.querySelector("#err-ov-close");
    if (btn !== null) btn.addEventListener("click", dropCard);
  }
  function submitDrag(featureId, version) {
    fetch("/features/" + encodeURIComponent(featureId) + "/schedule", {
      method: "POST",
      body: new URLSearchParams({ version: version }),
      credentials: "same-origin",
      headers: { Accept: "text/html" }
    }).then(function (res) {
      if (res.ok) { window.location.reload(); return null; }
      return res.text();
    }).then(function (text) {
      if (text === null || text === undefined) return;
      var doc = new DOMParser().parseFromString(text, "text/html");
      var card = doc.querySelector(".err-ov-card");
      if (card === null) { window.location.reload(); return; }
      showCard(card);
    }).catch(function () { window.location.reload(); });
  }
  document.addEventListener("dragstart", function (e) {
    var card = e.target !== null && typeof e.target.closest === "function" ? e.target.closest(".kcard[draggable=true]") : null;
    if (card === null) return;
    var id = card.getAttribute("data-feature");
    if (id === null) return;
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  });
  document.addEventListener("dragover", function (e) {
    var col = colOf(e.target);
    if (col === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    col.classList.add("dragover");
  });
  document.addEventListener("dragleave", function (e) {
    var col = colOf(e.target);
    if (col !== null) col.classList.remove("dragover");
  });
  document.addEventListener("drop", function (e) {
    var col = colOf(e.target);
    if (col === null) return;
    e.preventDefault();
    col.classList.remove("dragover");
    var id = e.dataTransfer.getData("text/plain");
    if (id === "") return;
    var card = document.querySelector('.kcard[data-feature="' + id + '"]');
    if (card === null) return;
    var target = col.getAttribute("data-version");
    if ((card.getAttribute("data-version") || "") === (target || "")) return;
    submitDrag(id, target === null ? "" : target);
  });
  document.addEventListener("dragend", function (e) {
    if (e.target !== null && typeof e.target.closest === "function" && e.target.closest(".kcard[draggable=true]") !== null) {
      var cols = board.querySelectorAll(".kcol.dragover");
      for (var i = 0; i < cols.length; i += 1) cols[i].classList.remove("dragover");
    }
  });
})();
</script>`;

/** 导航单点（三条 = 全局路径单点事实源；v0.9.6 B5a 起全站同形，空间落点不再派生）。 */
const NAV: ReadonlyArray<{ key: NavKey; href: string; text: string }> = [
  // v0.9.4 §9-b（首页形态 B→A）：「门户」= 组织门户 `/`（不再是排期看板）。
  // v0.9.6 B5a（口径 37/38）闭集六 → 三枚：摘「排期」（`/schedule` 页退役）、「任务」（路由留、口径 33 深链可达）、
  // 「宿主桥」（口径 38：`/host` 路由不退、NAV 摘条）；「项目 / 机器」→「项目」（全局 `/tasks*` 高亮并入本条）。
  { key: "home", href: "/", text: "门户" },
  { key: "projects", href: "/projects", text: "项目" },
  // v0.9.3 B-T3：Agent View（机器表 + 逐项目在飞任务 + 3300 收编的桥身份头）
  { key: "agents", href: "/agents", text: "Agent" },
];

/**
 * **顶栏组织切换器**（BD7 · §9-d 起清单口径与组织门户同源 = 台账未停用 ∪ 需求归属）：
 * 各组织 → `/org/<名>/` 的**服务端渲染链接**（跳转即全页刷新）⇒ **零新脚本**，
 * 不扩内联脚本闭集；清单为空 ⇒ 整块不渲染（无组织可切时不留空占位）。
 * 导出 = B5b 起空间二级导航行也复用本函数（同一实现，不在空间侧复制 HTML）。
 * `extraClass` = 挂位修饰类（空间正文的二级导航行传 `"right"` 靠右；顶栏调用不传 ⇒ 输出与移位前逐字节相同）。
 */
export function renderOrgSwitcher(orgNav: PageOrgNav, extraClass = ""): string {
  const items = orgNav.orgs
    .map(
      (o) =>
        `<a href="/org/${encodeURIComponent(o)}/"${o === orgNav.org ? ' class="on"' : ""}>${escapeHtml(o)}</a>`,
    )
    .join("");
  return `<span class="org-switch${extraClass === "" ? "" : ` ${extraClass}`}"> <span class="muted">组织</span> ${items}</span>`;
}

export interface PageParams {
  title: string;
  active: NavKey;
  /** 已转义的正文 HTML 片段 */
  bodyHtml: string;
  /** 页面级口径脚注（B13 / 并行度等，逐条渲染，内部已转义） */
  notes?: readonly string[];
  /** 页头动作区（随标题渲染的**字面量**按钮等，REQ-2026-09-26-04「＋ 新增需求」；不承载用户数据） */
  headerActions?: string;
  /** 错误浮层（REQ 弹窗化 · 表单档错误出口专用；全部字段在本函数内 escapeHtml，调用方传原始值） */
  errorOverlay?: ErrorOverlayParams;
  /**
   * **组织上下文（BD7）**：给出当前组织空间（可空）+ 切换器组织清单。
   * 切换器 = **纯服务端渲染的链接列表**（各组织 → `/org/<名>/` 整页跳转）⇒
   * 零新脚本，内联脚本闭集保持**六元**（N3-⑦/⑧ 纪律锚）。
   */
  orgNav?: PageOrgNav;
  /**
   * **组织切换器的挂位三态（v0.9.6 B5b）**：`top`（缺省，顶栏渲）/ `body`（正文的二级导航行已挂，顶栏不重复）/ `none`（整页不渲）。
   * 判据 = 「本页是否渲 `renderSpaceNav`」，**不得**按「org 非空」隐藏 —— 空间内详情页 / 桥宕页 / 410 页的
   * 唯一组织出路就在顶栏切换器上。
   */
  orgSwitcher?: "top" | "body" | "none";
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
  /**
   * 可选**出路链接**（v0.9.4 增补五 §9.4-③④）：跨组织成员互斥 ⇒ 指向所属组织管理页；
   * 停用空间的 410 ⇒ 指向门户。`href` 与 `label` 均转义（不接收未转义 HTML）。
   */
  link?: { href: string; label: string };
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
${o.link === undefined ? "" : `<p class="err-ov-link"><a href="${escapeHtml(o.link.href)}">${escapeHtml(o.link.label)}</a></p>`}
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
    (n) => `<a href="${n.href}"${n.key === params.active ? ' class="on"' : ""}>${escapeHtml(n.text)}</a>`,
  ).join("");
  const switcher =
    params.orgNav === undefined ||
    params.orgNav.orgs.length === 0 ||
    params.orgSwitcher === "body" ||
    params.orgSwitcher === "none"
      ? ""
      : renderOrgSwitcher(params.orgNav);
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
  .org-switch { margin-left: 8px; font-size: 12px; }
  .org-switch a { color: #567; text-decoration: none; padding: 1px 6px; border-radius: 4px; }
  .org-switch a.on { background: #5b86a8; color: #fff; }
  /* v0.9.6 B5b（口径 20）：空间二级导航行的切换器靠行右（只此一处挂 right；顶栏不浮） */
  .org-switch.right { float: right; }
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
  /* v0.9.5 C3/C5/C6：原生 details 折叠（零脚本）+ 档位化动作区按钮 */
  details.fold { margin: 10px 0; border: 1px solid #8884; border-radius: 6px; padding: 6px 10px; background: #8881; }
  details.fold > summary { cursor: pointer; font-size: 14px; font-weight: 600; color: #567; }
  details.fold[open] > summary { margin-bottom: 6px; border-bottom: 1px solid #8884; padding-bottom: 4px; }
  details.fold h2 { display: inline; font-size: 14px; margin: 0; border: none; }
  details.fold h3 { font-size: 13px; margin: 14px 0 6px; }
  details.calib { margin: 6px 0; font-size: 11px; color: #888; }
  details.calib > summary { cursor: pointer; font-style: italic; }
  details.req-src { margin: 6px 0; }
  details.req-src > summary { cursor: pointer; color: #667; background: #8881; border: 1px dashed #8884; border-radius: 6px; padding: 6px 10px; white-space: pre-wrap; word-break: break-word; }
  button.quiet { align-self: flex-start; font-size: 12px; padding: 2px 10px; opacity: .7; }
  p.turn-trace { color: #667; }
  details.turn-summary { margin: 4px 0 0; }
  details.turn-summary > summary { cursor: pointer; color: #667; background: #8881; border: 1px solid #8884; border-radius: 6px; padding: 4px 8px; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
  /* v0.9.6 N4：轮回执卡（要点 / 待用户 / 下一步三行 + 产出指引）—— 零脚本，折叠沿用上面的 details 口径 */
  div.receipt-card { border: 1px solid #8884; border-left: 3px solid #5678; border-radius: 6px; padding: 6px 10px; margin: 6px 0; background: #8881; }
  div.receipt-card p.receipt-row { margin: 2px 0; color: #445; font-size: 13px; }
  div.receipt-card p.receipt-row b { color: #567; }
  div.receipt-card p.receipt-docs { margin: 6px 0 2px; font-size: 12px; }
  div.receipt-card + details.turn-summary { margin-top: 6px; }
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
  /* T2 详情页依赖图：与 .md 文档页同构的 mermaid 块样式（选择器另起一行，不并入上行锚定口径） */
  .dep-graph .mermaid-block { margin: 10px 0; overflow-x: auto; }
  .dep-graph .mermaid-block[data-rendered="1"] pre.mermaid-src { display: none; }
  .dep-graph .mermaid-block[data-rendered="1"] .mermaid-svg:empty { display: none; }
  .dep-graph .mermaid-block svg { max-width: 100%; height: auto; }
  /* 增补轨 III N1 节点布局放宽：长标签（project + 要点）使画布变宽，整体缩到容器宽会让
     节点文字不可读 ⇒ 依赖图按原生尺寸渲染、超宽由上面的 overflow-x 横向滚动承担 */
  .dep-graph .mermaid-block[data-rendered="1"] svg { max-width: none; height: auto; }
  .dep-graph .mermaid-block .nodeLabel { font-size: 13px; word-break: break-word; }
  .dg-legend { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; font-size: 12px; color: #667; }
  .dg-legend i { display: inline-block; width: 12px; height: 12px; border: 1px solid #8886; border-radius: 3px; }
  a.fl { color: inherit; }
  /* v0.9.6 B5b（口径 22）：空间二级导航行的当前视图钩子（inline font-weight 保留，本行只管可点态颜色） */
  a.fl.on { color: inherit; }
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
  .kcol > h3 { font-size: 13px; margin: 2px 0 8px; border-bottom: 1px solid #8884; padding-bottom: 4px; position: relative; padding-right: 22px; }
  .kcard { border: 1px solid #8884; border-radius: 6px; background: Canvas; padding: 6px 8px; margin: 0 0 6px; font-size: 12px; }
  .kcard[draggable="true"] { cursor: grab; }
  .kcard.draglocked { opacity: .55; }
  .kcard .draglock { color: #b26a00; border-color: #b26a0088; }
  .kcol.dragover { outline: 2px dashed #5b86a8; outline-offset: -2px; }
  .err-ov-card.drag-err-overlay { position: fixed; inset: 0; margin: auto; height: fit-content; max-height: 80vh; overflow-y: auto; width: min(560px, 92vw); z-index: 70; box-shadow: 0 0 0 100vmax #0006, 0 6px 24px #0004; }
  /* 增补二 §9.1-②：data-ov 写表单 fetch 报错的浮层卡（与拖拽错误卡同款版式，不跳页） */
  .err-ov-card.ov-err-overlay { position: fixed; inset: 0; margin: auto; height: fit-content; max-height: 80vh; overflow-y: auto; width: min(560px, 92vw); z-index: 70; box-shadow: 0 0 0 100vmax #0006, 0 6px 24px #0004; }
  .kbadge { float: right; margin-left: 6px; font-size: 11px; color: #567; border: 1px solid #8886; border-radius: 8px; padding: 0 6px; white-space: nowrap; }
  .vbadge { float: none; cursor: help; }
  .vbadge.locked { color: #654321; border-color: #a67c52; background: #f3e5d0; font-weight: 600; }
  .vbadge.wip { color: #25567a; border-color: #5b86a8; background: #e3eef7; }
  .vbadge.closed { color: #3a5a40; border-color: #6b8f71; background: #e6f0e8; }
  .vbadge.notstart { color: #666; border-color: #9996; background: #ddd4; }
  /* 增补十一 E2（§9.6）：删除入口 × 钉在版本框头右上角（仅未开始版本渲染本表单）
     —— E3 撤除列头操作行（.vops / form.vop）后，版本列头仅剩本一处写入口 */
  .kcol > h3 form.vdel { position: absolute; top: -2px; right: 0; margin: 0; }
  .kcol > h3 form.vdel button { font-size: 12px; line-height: 1; padding: 0 5px; color: #a33; background: transparent; border: 1px solid #a336; border-radius: 4px; }
  .kmeta { margin: 4px 0 0; color: #667; font-size: 11px; }
  .tpoints { margin: 4px 0 0; padding-left: 16px; color: #667; font-size: 11px; }
  .tpoints li { margin: 1px 0; }
  .tpoints .tcurrent { color: inherit; font-weight: 600; }
  dialog.fd { width: min(880px, 92vw); max-height: 86vh; overflow-y: auto; margin: auto; border: 1px solid #8888; border-radius: 8px; padding: 12px 18px 16px; background: Canvas; color: CanvasText; box-shadow: 0 8px 32px #0005; }
  dialog.fd::backdrop { background: #0006; }
  dialog.fd > button { margin: 0 0 8px; }
  dialog.fd .fd-body > h2:first-child { margin-top: 0; }
  dialog.fd > .err-ov-card { position: fixed; inset: 0; margin: auto; height: fit-content; max-height: 80vh; overflow-y: auto; z-index: 60; box-shadow: 0 0 0 100vmax #0006, 0 6px 24px #0004; }
  .header-actions { float: right; margin-top: 2px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(params.title)}</h1>${params.headerActions ?? ""}
  <nav>${nav}${switcher}</header>
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
