/**
 * 板页面模板骨架（BD3）—— 照 `orch/bridge/web/html.ts` 路线：
 * **同源、无构建、无框架**（内联 style、单文件模板字面量）。BD14 起文档页另可引用**一条同源
 * vendored 资产**（`/static/mermaid.min.js`，CSP 放宽见 {@link BOARD_CSP}），仍无任何外源主机。
 * 服务器端渲染；页面脚本 = **白名单化内联字面量常量**（无 `src=`、不含用户数据、单点常量可审计；
 * 纪律钉 = `test/n3-regression-anchors.test.mjs` N3-⑦/⑧，闭集 = 提交守卫 {@link SUBMIT_GUARD_SCRIPT}
 * + 错误浮层关闭 + mermaid 渲染 + 排期页详情浮层 {@link FEATURE_DETAIL_OVERLAY_SCRIPT}
 * + 新增需求弹窗 {@link NEW_REQUIREMENT_DIALOG_SCRIPT}
 * + 排期拖拽 {@link DRAG_SCHEDULE_SCRIPT}（v0.9.3 B-T5 增枚；与弹窗常量分立、不可共置）
 * + 成员两栏拖拽 {@link MEMBER_DRAG_SCRIPT}（v0.9.8 REQ-2026-10-03-02，闭集六→**七元**；
 *   与排期拖拽常量分立、不可共置 —— 那枚的入口守卫 `#schedule-board` 不因本页而扩）
 * + 页级就地刷新 {@link PAGE_LIVE_SCRIPT}（v0.10.4 REQ-2026-10-11-03，闭集七→**八元**；
 *   入口守卫 = 页面上有无 `[data-live]` 锚，不复用他枚的页专属 `getElementById` 锚））；
 * 刷新 = 浏览器重载；**自动更新只有两档**（v0.10.4 · REQ-2026-10-11-03 件D 校准，旧口径
 * 「唯一例外 = 浮层动作区轮询」已随之退役）=
 * ① **浮层动作区** = 件B 提交后的**有界进度轮询**（复用既有详情读面 +
 * 既有 {@link FEATURE_DETAIL_OVERLAY_SCRIPT} 的 `swapPage` 通路，零新端点、零新枚脚本，见该常量注记）；
 * ② **只读页的锚级就地换块** = 第八枚 {@link PAGE_LIVE_SCRIPT}，周期取 `views.ts` `LIVE_INTERVALS`
 * 单点经 SSR 属性下发，只替换 `[data-live]` 锚的子节点 ⇒ **不是整页重载**；**写面**表单（侧栏四卡的
 * 排期表单 / 宿主轮三入口 / 成员与组织表单）不在锚内 ⇒ 仍须重载本页。**唯一含输入的锚** = 任务页的只读
 * GET 过滤卡 `tasks-filter`：它按改造文档 §2.2 就在锚内，其保护靠**焦点态跳拍**（`activeElement` 落在锚
 * 子树内 ⇒ 该锚该拍跳过）而非「排除在锚外」。除此之外不存在第三种自动刷新。
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
 * **组织上下文（v0.9.4 D 档 · BD7；REQ-2026-09-30-04 件1 起 = 侧栏二级菜单的唯一输入）**：
 * `renderPage` 侧栏项目组清单与当前空间高亮的唯一输入。
 *
 * - `org` = 当前页面所处的组织空间（`null` ⇒ 全局页面，侧栏不出当前态）；
 * - `orgs` = 侧栏二级菜单的项目组清单（**服务端渲染的链接列表**，跳转 = 全页刷新 ⇒
 *   零新脚本，内联脚本闭集保持七元，见 {@link PageParams.orgNav}）。
 */
export interface PageOrgNav {
  org: string | null;
  orgs: readonly string[];
}

/** NAV 全局路径 → 组织空间路径的映射（`ORG_SPACE_VIEWS`）与 {@link navHrefFor} 已随 v0.9.6 B5a 退役；
 * REQ-2026-09-30-04 件1 起「项目 / Agent」两条也撤出导航（页面保留、深链可达）⇒ 一级菜单仅「项目组门户」一枚，
 * 组织切换的形态由「顶栏文字组」改为**侧栏二级菜单**（{@link renderSideOrgs}，功能语义不变）。 */

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
 * **增补二 §9.1-② 的扩写（闭集不扩，在本常量体内扩）**：带 `data-ov="1"` 标记的写表单
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
 * **增补四 §9.3 的扩写（闭集不扩，在本常量体内扩）**：注入卡上的「知道了」按钮点了不关
 * —— 关闭逻辑原靠「错误页自带脚本」（`renderErrorOverlay` 的直接绑定），而卡片是经
 * `DOMParser` 惰性文档摘入本文档的：**搬运节点不跑 `<script>`** ⇒ 按钮无处理器
 * （manage / 门户两页各只注入本枚脚本，没有 /schedule 侧三枚浮层脚本的委托兜底）。
 * 补一条 **document 级 click 委托**：命中 `#err-ov-close` ⇒ `closest(".err-ov-card")` 摘除该卡
 * （动态注入天然覆盖），口径对齐 /schedule 侧 `closest(...err-ov-card...)` 委托先例。
 *
 * **增补五 §9.4-② 的扩写（闭集不扩，在本常量体内扩）**：成功路径支持 `data-ov-redirect` 属性
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
 * - **件B（真实进度）**：成功换页后若回包 `<main>` 仍含 `.turn-progress`（收口判据 `stillBusy`
 *   实查**整个 `<main>`**〔页面级，非仅动作区——见下方 `stillBusy`〕，= 本轮仍 `running` / `queued`），
 *   起一条**有界**轮询（{@link POLL_INTERVAL_MS} × {@link POLL_MAX_TICKS}，20 分钟量级 = 与宿主 turn
 *   窗口同量级），每拍 `GET` 本详情 URL（带 `Accept: "text/html"`，与 `open()` 同规格）经 `swapPage`
 *   刷回**浮层编辑区**（准确口径：`swapPage` 是整份回包 `<main>` 的**全子节点逐个替换** `.fd-body`
 *   —— 不止动作区，页面级进度行 / 依赖图 / 执行明细一并换；旧的「刷回动作区」是低估，v0.10.4 校正），
 *   用户看到真实「第 N 轮 在飞 / 排队中」。收口判据 = 回包**不再**含在飞 / 排队的
 *   `.turn-progress`（且执行明细也无在飞 / 排队 chip，见下方「起轮 / 收口判据的第二来源」）⇒ 停；
 *   浮层已关 / 窗口耗尽 ⇒ 同样停。**零新增端点、零新增写面**：复用
 *   `GET /features/:id` 读面与既有 `swapPage` 渲染通路；轮询只活在浮层脚本内（无 `#feat-dialog`
 *   的页面整段空转）。
 *   **准确表述（v0.10.4 · REQ-2026-10-11-03）**：本枚不是、也从未是「整页自动刷新」—— 它只在
 *   **浮层开着**时把详情读面的回包经 `swapPage` 换进浮层动作区；浮层之外那侧的页面级自动更新由
 *   **第八枚「页级就地刷新」脚本**承担，其形态同样是**锚级就地换块**（只替换 `[data-live]` 锚的
 *   子节点），**不是整页重载** —— 两枚之间零耦合（本枚不引用第八枚的任何符号）。
 *   **起轮一档 = 提交档（v0.10.4 · REQ-2026-10-11-06 增补 c35b4192 撤「打开档」）**：件B 的起轮**只**在
 *   「浮层内提交成功」后发生 —— 曾于 REQ-2026-10-11-05 增补 B-1 加过「打开档」（`open()` 成功换页后
 *   按回包是否仍忙起轮，用户**打开即跟刷**），**该档已随 c35b4192 整体撤销**：打开的详情页一律**不**
 *   自动跟刷，要看最新进度就重开浮层或提交一轮。`open()` 内 `lastHref = href` **保留**（它是二次点击
 *   同卡关闭 toggle 的判据，与起轮无关）。提交档复用同一条有界链（startPoll 内先 stopPoll ⇒ 恒只一条）。
 * - **拍级 held 闸（v0.10.4 · REQ-2026-10-11-05 增补 B-2；一路判据随 REQ-2026-10-11-06 T3 收窄）**：
 *   因 `swapPage` 换的是**整份 `<main>` 全子节点替换 `.fd-body`**（见上条校正），用户正在浮层里填表时
 *   换页 = 连同表单与已填输入一起冲掉。故每拍换页**之前**先过 {@link heldBody} 闸，两路**分档**：
 *   **一路 = 焦点落在「输入面」**（{@link isInputFace} 白名单 = `INPUT` / `TEXTAREA` / `SELECT` /
 *   `contentEditable`，且焦点须在 `.fd-body` 子树内）⇒ 正在填；**链接 / 按钮的焦点不算在填**（否则
 *   「点卡片开浮层 ⇒ 浏览器把焦点还原到那张 `<a>`」会让闸自我维持地永停，与第八枚同族缺陷）；
 *   **二路 = 任一 `textarea`/`input` 的 value 非空**（**已填失焦也挡**；本路判据面随 T3 **未扩**）。
 *   任一成立 ⇒ 本拍**不换页**，只 `schedulePoll` 排下一拍。
 *   闸内**零请求、零 `showModal`、不改 `dlg.open`**；不判 `data-ov-pending`（拍级闸只判「填没填」），
 *   也**不加第三路**（`details[open]` 不算在填）。上界 20 分钟触顶即停 = 已裁的已知上界，只登记不调数值。
 *   已知副作用（已裁、留此登记）：收口那一拍若被 held 挡住 ⇒ 本轮不再强渲收口末态（收口检查在闸
 *   **之前**，二者不冲突：收口拍仍正常停轮；仅「未收口 ∧ held」拍跳过换页），浮层重开 / 下次提交即见最新。
 * - **件C（竞态 · 「关了又被弹开」）**：`swapPage(html, reopen)` 的第二参 —— 传 `false` ⇒ **浮层已被
 *   用户关闭时不得 `showModal()` 把它重新弹开**（原实现每次 `swapPage` 末尾无条件补弹，与关闭动作竞态）。
 *   **三个弹开点逐一列全**：① `pollOnce` 后台轮询档传 `false`（v0.10.4 既有）；② `postForm` **两档**
 *   （4xx 回包档与成功档）均传 `false`（v0.10.4 · REQ-2026-10-11-06 增补）—— 提交在飞时用户关掉浮层，
 *   回包不得把它弹回，抽不到的错误卡同理（卡不可见 ⇒ 重开重提，已登记 §6）；③ `showCard` 的无条件补弹
 *   **已删**（挂卡不改变开关态）。**反向硬约束**：`open()` 里那处 `swapPage(text)` **必须保持 reopen 缺省**
 *   —— 它是浮层唯一的开启路径，「三处一律传 `false`」是误读，会把整条浮层链路杀死。
 *   轮询命中「已关浮层」时只 `stopPoll`，不改 `dlg.open`、不落渲染。
 * - **起轮 / 收口判据的第二来源（v0.10.4 · REQ-2026-10-11-03 · 件B 扩写）**：两条判据除上述
 *   `.turn-progress` 文案外，**∨** `main.querySelector(".dg-chip.dg-running, .dg-chip.dg-queued")`
 *   —— 事实源 = **v0.10.3 详情页状态六态着色**已有的 chip class（`src/graph-view.ts` 与执行明细单表
 *   渲染的 `dg-${info.key}`），**零新标记**。三条纪律：
 *   ① **起轮（{@link startPoll}）与收口（{@link stillBusy}）必须认同一串选择器** —— 只扩起轮不扩收口
 *   ⇒ 起了轮的第一拍即判「已收口」自停（本节点要防的真实缺陷）；
 *   ② 两处选择器串**逐字相同**，且各只出现一次（合计 2 处）；
 *   ③ 件B 仍按**文本子串**判第一来源 ⇒ `在飞` / `排队中` 二字面**不得**从 `stillBusy` 体内移除
 *   （改名即静默失效；与整站文案改档〔N6〕共享此约束，故 N6 须排本节点之后）。
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
  // 件B 收口判据两来源（v0.10.4 · REQ-2026-10-11-03）：① 动作区文案 —— 文本子串「在飞 / 排队中」
  // 是判据，改名即静默失效，故两字面不得移出本体；② 执行明细六态 chip —— 选择器串必须与
  // startPoll 起轮判据**逐字相同**（只扩起轮不扩收口 ⇒ 起了轮第一拍即判收口自停）。
  function stillBusy(main) {
    var m = main.querySelector(".turn-progress");
    if (m !== null && (m.textContent.indexOf("在飞") !== -1 || m.textContent.indexOf("排队中") !== -1)) return true;
    return main.querySelector(".dg-chip.dg-running, .dg-chip.dg-queued") !== null;
  }
  function schedulePoll() {
    if (pollTicks >= POLL_MAX_TICKS) { stopPoll(); return; }
    pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }
  // 「输入面」白名单（v0.10.4 · REQ-2026-10-11-06 T3）：只有真在填的焦点才算 held，
  // 链接 / 按钮的焦点不算 —— 否则「点卡片开浮层 ⇒ 焦点还原到那张 <a>」会让闸自我维持地永停。
  // ⚠ 本 helper 与第八枚（页级就地刷新）常量内**同名同体**（两枚独立 IIFE 无法函数级共享 ⇒ 双份同体，
  // 件B chip 串双写先例同形）；逐字一致由跨枚钉 live-refresh N-6 钉死 —— **勿合并、勿全局化、勿单改**。
  function isInputFace(node) { if (node === null || node === undefined) return false; var tag = node.tagName; if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true; return node.isContentEditable === true; }
  // 拍级 held 闸（v0.10.4 · REQ-2026-10-11-05 增补 B-2 · 一路随 REQ-2026-10-11-06 T3 收窄）：
  // swapPage 换的是整份 <main> 全子节点替换 .fd-body —— 用户正在浮层里填表时换页 = 连同表单与已填
  // 输入一起冲掉。两路判据：① 焦点落在**输入面**且在本编辑区子树内（正在填；链接 / 按钮焦点不算）；
  // ② 任一 textarea/input 的 value 非空（已填失焦也挡；本路未扩）。
  // 只判这两路，不扩其它控件、不加第三路（details[open] 不算在填）、不判挂起标记（口径见 JSDoc「拍级 held 闸」段）。
  function heldBody() {
    if (body === null) return false;
    var ae = document.activeElement;
    if (ae !== null && isInputFace(ae) && body.contains(ae)) return true;
    var f = body.querySelectorAll("textarea, input");
    for (var i = 0; i < f.length; i += 1) { if (f[i].value !== "") return true; }
    return false;
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
      // 拍级 held 闸：本拍若用户正在/已在浮层内填写 ⇒ 不换页，只排下一拍（零请求增量、不自弹开）
      if (heldBody()) { schedulePoll(); return; }
      swapPage(r.text, false);
      schedulePoll();
    }).catch(function () { schedulePoll(); });
  }
  // 起轮判据 = 仍忙（动作区文案 ∨ 执行明细 chip）；chip 串与 stillBusy 逐字相同
  // ⇒ 起轮与收口不会各执一套判据（只扩起轮 ⇒ 起了轮第一拍即判收口自停，本节点要防的缺陷）。
  function startPoll(main) {
    stopPoll();
    if (main === null) return;
    if (!stillBusy(main) && main.querySelector(".dg-chip.dg-running, .dg-chip.dg-queued") === null) return;
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
      // 打开档已撤（v0.10.4 · REQ-2026-10-11-06 c35b4192）：这里**不起轮**，打开只渲染静态读面；
      // lastHref = href 必须保留 —— 它是二次点击同卡关闭 toggle 的判据，与起轮无关。
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
        // 件C：错误档不补弹（浮层已被用户关闭 ⇒ 卡只挂上、不自弹开）
        if (swapPage(r.text, false)) { restoreForm(form); } else { nativeSubmit(form); }
        return;
      }
      // 成功（303 跟随后即详情页）：抽 main 换入 body ⇒ 旧表单连同禁用态与提示行一并离场。
      var okMain = parsePage(r.text).main;
      // 件C：成功档同样不补弹 —— 提交在飞时用户已关浮层 ⇒ 回包不得把它重新弹开
      if (!swapPage(r.text, false)) { nativeSubmit(form); return; }
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
    if (e.button !== 0 || e.metaKey === true || e.ctrlKey === true || e.shiftKey === true || e.altKey === true) return;
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
 * **v0.9.4 增补六 §9.5 的泛化（闭集不扩，在本常量体内泛化）**：门户页 `/` 的「＋ 建组织」按钮
 * 需另一枚 `<dialog id="new-org-dialog">`（表单同 `renderCreateOrgForm`）—— 本常量由「单 dialog」
 * 泛化为**一个 `wire(dlg, openBtn, inline)` 同时接两枚 dialog**（`new-req-dialog` / `new-org-dialog`），
 * **不新增第七枚脚本常量、CSP 一律不动**。原 `new-req-*` 行为逐条不变；新增两点：
 * - **按钮服务端 `hidden`、脚本显形**：门户「＋ 建组织」按钮初始 `hidden`（无 JS 不显死按钮），
 *   `openBtn.hidden = false` 显形；`inline` 非空（门户内联回退表单 `#new-org-inline`）⇒ 脚本隐藏之；
 * - **关闭钮改按 dialog 自身子按钮绑定**（`dlg.querySelector("button")` = 骨架上第一枚 `*-close`），
 *   「知道了」摘卡委托按 `dlgId` 派生选择器（替换原写死的 `#new-req-dialog #err-ov-close`）。
 *
 * **v0.9.4 W6（§2.6）入口交互扩写（仍在闭集内，不新枚；增补七 a §9.1-a 把落点由门户迁到排期看板；
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
 * `dragover` 需 `preventDefault()` 才能落地；落点单点 = `.kcol` 类（版本列与池列同 class），
 * 以 class 而非 `data-version` 属性判定 —— 卡片自身也带 `data-version`，按属性判定会把落点
 * 误认成卡片；列头徽标等非列节点不参与命中判定。同一时刻至多一列挂高亮（`over` 单列跟踪）。
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
  var over = null;
  function colOf(node) {
    var el = node;
    while (el !== null && el !== board) {
      if (el.nodeType === 1 && el.classList && el.classList.contains("kcol")) return el;
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
    if (over !== col) {
      if (over !== null) over.classList.remove("dragover");
      over = col;
    }
    col.classList.add("dragover");
  });
  document.addEventListener("dragleave", function (e) {
    var col = colOf(e.target);
    if (col === null) return;
    if (colOf(e.relatedTarget) === col) return;
    col.classList.remove("dragover");
  });
  document.addEventListener("drop", function (e) {
    var col = colOf(e.target);
    if (col === null) return;
    e.preventDefault();
    col.classList.remove("dragover");
    over = null;
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
      over = null;
    }
  });
})();
</script>`;

/**
 * **成员两栏拖拽**（v0.9.8 · REQ-2026-10-03-02 · 页面脚本闭集**第七枚**）：
 * `/org/<名>/manage` 的「加 / 删项目（两栏拖拽）」区（`views.ts` 的 {@link renderMemberPoolColumns}）
 * 的**体验层增强** —— 拖左→右 = `action=add`、拖右→左 = `action=remove`，落定走**既有**写路由
 * `POST /orgs/{org}/members`（urlencoded `action` / `machineId` / `projectId`，**与手填表单同参数**，
 * 服务端零改动、不新增预检闸）。
 *
 * 口径逐条对齐排期拖拽先例 {@link DRAG_SCHEDULE_SCRIPT}（**不复用它、也不扩它** —— 那枚常量的入口守卫
 * `#schedule-board` 与页隔离锚一旦扩，排期页与本页互相牵连，故本枚独立立）：
 * - 入口守卫 = `getElementById("member-pool")`（**仅 manage 页有此锚** ⇒ 页隔离即由它承担，
 *   注入单点 = `server.ts` 的 `pageOrgSpaceManage` 的 `Page.extraScripts`）；
 *   `typeof fetch` / `typeof DragEvent` 任一缺失 ⇒ 直接 return（无 JS / 老浏览器 = 两栏静态清单 + 表单照常）；
 * - `dataTransfer` 走 `text/plain`，载荷 = `URLSearchParams` 序列化的 `action` / `machineId` / `projectId`
 *   （值全部来自**服务端渲染的 `data-*` 属性** ⇒ 脚本字面量本身不含用户数据）；
 * - 提交 = 同源 `fetch`（`credentials:"same-origin"`，**不带 `x-board-write` 头** ⇒ CSRF 走 Origin 同源档，
 *   与 `SUBMIT_GUARD_SCRIPT` 的表单档同一条防线）；
 * - **成功 ⇒ `location.reload()`**（声明面回读为事实源，板不做乐观 DOM 移动）；
 * - **失败 ⇒ 抽响应 `.err-ov-card` 叠既有浮层**（`.drag-err-overlay`，「知道了」同款委托摘卡）——
 *   409 `board_member_group_conflict` 冲突卡自带所属组链接、409 `board_last_member_remove` 自带引导；
 *   **DOM 从未被移动 ⇒ 失败无需回弹**；抽不到卡 / 网络异常 ⇒ reload 兜底（错误可见，不静默）。
 *
 * 执法永远在服务端与桥 O1（本脚本只是体验层）：**能不能拖由服务端渲染判据决定** ——
 * 末位成员行不带 `draggable`、池不可用时整块不带 `data-machine`，拖不动即拖不了。
 *
 * 与 {@link DRAG_SCHEDULE_SCRIPT} 同规格：单点常量、纯内联、无 `src=`、不含用户数据、
 * 体内无 `</script` 字面量；**闭集钉「每枚恰好 1 处」**（N3-⑦/⑧/⑨）。
 */
export const MEMBER_DRAG_SCRIPT = `<script>
(function () {
  var pool = document.getElementById("member-pool");
  if (pool === null || typeof fetch !== "function" || typeof DragEvent !== "function") return;
  var org = pool.getAttribute("data-org");
  if (org === null || org === "") return;
  function colOf(node) {
    var el = node;
    while (el !== null && el !== document) {
      if (el.nodeType === 1 && typeof el.getAttribute === "function" && el.getAttribute("data-side") !== null) return el;
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
  function submitMember(action, machineId, projectId) {
    fetch("/orgs/" + encodeURIComponent(org) + "/members", {
      method: "POST",
      body: new URLSearchParams({ action: action, machineId: machineId, projectId: projectId }),
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
    var row = e.target !== null && typeof e.target.closest === "function" ? e.target.closest(".mrow[draggable=true]") : null;
    if (row === null || e.dataTransfer === null) return;
    var machineId = row.getAttribute("data-machine");
    var projectId = row.getAttribute("data-project");
    if (machineId === null || projectId === null) return;
    var from = colOf(row);
    if (from === null) return;
    var action = from.getAttribute("data-side") === "pool" ? "add" : "remove";
    e.dataTransfer.setData("text/plain", new URLSearchParams({ action: action, machineId: machineId, projectId: projectId }).toString());
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
    var raw = e.dataTransfer.getData("text/plain");
    if (raw === "") return;
    var qs = new URLSearchParams(raw);
    var action = qs.get("action");
    var machineId = qs.get("machineId");
    var projectId = qs.get("projectId");
    if (action !== "add" && action !== "remove") return;
    if (machineId === null || projectId === null || machineId === "" || projectId === "") return;
    if (action === "add" && col.getAttribute("data-side") !== "own") return;
    if (action === "remove" && col.getAttribute("data-side") !== "pool") return;
    submitMember(action, machineId, projectId);
  });
  document.addEventListener("dragend", function () {
    var cols = pool.querySelectorAll(".mcol.dragover");
    for (var i = 0; i < cols.length; i += 1) cols[i].classList.remove("dragover");
  });
})();
</script>`;

/**
 * **页级就地刷新**（v0.10.4 · REQ-2026-10-11-03 · 页面脚本闭集**第八枚**）：排期 / 详情整页 /
 * 任务三处只读页进页即常驻**一条** `setTimeout` 自递归链，按页周期 `GET` **当前 URL**，`DOMParser`
 * 解析回包后逐锚（`[data-live]`，key = 其 `data-live` 值）以**节点搬运只换其子节点** ⇒ 数据变化
 * 就地可见，不整页重载、不换 `<main>`、不本地乐观改 DOM。
 *
 * 判据要点（形态由改造文档 §2 定，此处只记本枚的执法面）：
 * - **入口守卫** = `[data-live]` 数量为 0 ⇒ 立即 return（不收 `#schedule-board` / `#member-pool`
 *   一类页专属锚，故与既有七枚互不牵连；页隔离由本守卫承担，非刷新页整段空转）；
 * - **周期** = 第一枚带 `data-live-interval` 的锚（数值来自 `views.ts` 的 `LIVE_INTERVALS` 单点，
 *   **不进本常量体**）；取不到 ⇒ 整段不起轮；
 * - **跳拍判据四条（v0.10.4 · REQ-2026-10-11-06 T3 收窄）**：锚级（只跳该锚）= ① 焦点落在**本锚子树内
 *   的输入面**（{@link isInputFace} 白名单 = `INPUT` / `TEXTAREA` / `SELECT` / `contentEditable`）
 *   ⇒ 跳该锚；**链接 / 按钮的焦点不算在填**（旧判据「锚子树含 `document.activeElement`」把「焦点还原到
 *   卡片链 / 列头钮」误当正在填 ⇒ 整板无声永停 = 本卡修的根因；白名单**不含 `closest("form")`**，
 *   纳入即复发）② 锚内含 `details[open]:not(.pipe)` ⇒ 跳该锚（已展开的执行明细 / 最近一轮摘要；`pipe` =
 *   依赖图管道，服务端默认 `open`，是唯一豁免类，否则 graph 锚永不刷新）；
 *   **已裁代价**（用户 2026-10-11 裁接受）：用户手动收起的管道在下一拍被服务端默认 `open` 重刷回来；
 *   整拍级 = ③ 拖拽进行中（本枚自挂一对被动 `dragstart` / `dragend` 布尔标记，不 preventDefault、
 *   不读别的常量的 `.dragover` class ⇒ 零跨枚耦合）④ `document.hidden`；`visibilitychange` 回前台 ⇒
 *   立即补一拍。**已撤两样**：旧「任一 `dialog.open` ⇒ 让位」（浮层档自有节奏，本枚不为它让位）与
 *   「整拍闸挡在 fetch **之前**」（改到换块**之前**复查，见下条结构性兜底）。
 *   另有**换块跳过** = 回包摘不到同 key 锚 ⇒ 跳过该锚、**绝不清空**；
 * - **结构性兜底（`tick` 终体，同条 T3）**：链的每一路出口都必须排下一拍，且失败要出声 ——
 *   ① `busy` 早退 ⇒ 排拍不发请求（fetch 永不 settle 时 ⟳ 不被吞的唯一解）；② 回包不可读 / 整拍闸 /
 *   换块之后三档全部 `scheduleNext`（出声不吞拍）；③ `busy = false` 必在 handler 首行（否则 swapAll
 *   真抛时 catch 无它 = 一次异常永停）；④ `scheduleNext` 为 clear-then-set（`busy` 分支与回包 handler
 *   抢同一 timer 单槽 ⇒ 必清才恒一条链；排拍字面量仍恰 1 处）。零换块 / swapAll 抛错 / 回包不可读 /
 *   fetch 异常各经 `console.warn` / `console.error` 出声，不得静默；**不加第三个拖拽监听**；
 * - **滚动保护** = 换块前按 `.kcol` 的 `data-version` **为键**记 `scrollTop`、换后同键回填
 *   （以列索引为键会在新增/删除列时错位 ⇒ 禁）；key 集合变化的列不回填；
 * - **时钟单一写入者** = 本脚本：**至少一枚锚成功换块**的那一拍才拨 `.live-clock`（零换块 ⇒ 不拨并
 *   `console.warn` 出声，不静默）；`⟳`（`.live-now`）由服务端渲染为 `hidden` ⇒ 本脚本显形（无 JS 不出
 *   死钮，口径照 `#new-req-open` 先例），点击 = 跑同一拍函数，**不起第二条链**；详情浮层内的那份控制条
 *   是**死钟**（浮层自有件B 的节奏）⇒ 由 CSS 整条隐藏（`dialog.fd .live-bar`），不为此加任何 JS 判据；
 * - **只读** = `GET` 当前 URL（`credentials:"same-origin"` + `Accept: "text/html"`，**无 `method:`**），
 *   打的仍是既有 GET 面；零 `setInterval` / 零 `WebSocket` / 零 `EventSource` / 零 `innerHTML` /
 *   零 `meta-refresh`；在飞一拍未回 ⇒ 不叠第二拍（回包后统一排下拍 ⇒ 全页恒一条链）。
 *
 * **任务页三动线已在本常量体内补齐**（委托 + `pushState` / `popstate`，`click` 恒一条 = ⟳ 亦并入该委托）：
 * 注入点（三处按页）仍由 N5 承 ⇒ **本轮产物在各页尚未生效**（预期状态，不 `import` 进 `server.ts`）。
 * 与其余七枚同规格：单点常量、纯内联字面量、无 `src=`、体内零插值零用户数据、零裸结束标签；
 * **闭集钉「每枚恰好 1 处」**（N3-⑥/⑦/⑧/⑨/⑪）。取容器一律走 `[data-live]` / `closest` 选择器，
 * 不得复用他枚的 `getElementById` 锚（否则 N3-⑦ 归类歧义）。
 */
export const PAGE_LIVE_SCRIPT = `<script>
(function () {
  if (document.querySelectorAll("[data-live]").length === 0 || typeof fetch !== "function" || typeof DOMParser !== "function") return;
  var timed = document.querySelector("[data-live-interval]");
  var intervalMs = timed === null ? 0 : parseInt(timed.getAttribute("data-live-interval"), 10);
  if (!(intervalMs > 0)) return;
  var timer = null;
  var busy = false;
  var dragging = false;
  // 「输入面」白名单（v0.10.4 · REQ-2026-10-11-06 T3）：只有真在填的焦点才算 held，
  // 链接 / 按钮的焦点不算 —— 否则「点开卡片 ⇒ 焦点还原到那条 <a>」「列头删除钮拿到焦点」会让本枚
  // 自我维持地永停（本卡修的根因）。⚠ 白名单**不含「焦点在本锚内某 form 中」这一档**（不写 closest 到
  // form 的解法）：纳入 ⇒ 列头删除钮拿到焦点 = 整板再次无声永停，根因复发。
  // ⚠ 本 helper 与件B（详情浮层）常量内**同名同体**（两枚独立 IIFE 无法函数级共享 ⇒ 双份同体，
  // 件B chip 串双写先例同形）；逐字一致由跨枚钉 live-refresh N-6 钉死 —— **勿合并、勿全局化、勿单改**。
  function isInputFace(node) { if (node === null || node === undefined) return false; var tag = node.tagName; if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true; return node.isContentEditable === true; }
  // 跳拍判据（锚级）：① 焦点落在**本锚子树内的输入面** = 用户正在填；② 本锚含已展开折叠 = 用户正在看；
  // ③ 带 data-live-lock 的锚**继承整页展开态** —— 页面上任一非 pipe 折叠开着 ⇒ 本锚该拍跳过
  //（图与表分两枚锚、各自刷新 ⇒ 不同快照；本路让带标记的锚跟着整页展开态一起停）。
  // 豁免类只有 pipe（依赖图管道，src/graph-view.ts:471 渲为默认 open）**保留**，且 ②③ 同排它
  // ⇒ graph 锚不因自家默认展开态自冻（自冻 = 永不刷新）。
  // ⚠ 跨浮层语义（如实登记 · 不得当缺陷修）：③ 是**整篇作用域**的判据，而详情浮层（件B）把回包整份
  // main 的子节点搬进 .fd-body，那份 graph 锚**同样带**本属性 ⇒ 浮层内展开折叠会牵住页面级 lock 锚，
  // 反向同理。判定 = 可接受：① 浮层是模态、背后不可见，关掉即恢复；② 浮层内的图与表本就由件B **原子换
  // 整份 main** ⇒ 天然同快照，本路在浮层内不构成第二道保证、也不制造新错位。收窄备选（把整页判据限定到
  // 页面级 main 内）不采用：更复杂且对浮层内零增益。
  function holdAnchor(el) { var ae = document.activeElement; if (ae !== null && isInputFace(ae) && el.contains(ae)) return true; if (el.querySelector("details[open]:not(.pipe)") !== null) return true; return el.hasAttribute("data-live-lock") && document.querySelector("details[open]:not(.pipe)") !== null; }
  function keyOf(el) { return el.getAttribute("data-live") || ""; }
  function findAnchor(doc, key) {
    var list = doc.querySelectorAll("[data-live]");
    for (var i = 0; i < list.length; i += 1) { if (keyOf(list[i]) === key) return list[i]; }
    return null;
  }
  function scrollMap(root) {
    var map = {};
    var cols = root.querySelectorAll(".kcol");
    for (var i = 0; i < cols.length; i += 1) {
      var v = cols[i].getAttribute("data-version");
      if (v !== null) map[v] = cols[i].scrollTop;
    }
    return map;
  }
  function restoreScroll(root, map) {
    var cols = root.querySelectorAll(".kcol");
    for (var i = 0; i < cols.length; i += 1) {
      var v = cols[i].getAttribute("data-version");
      if (v === null || !Object.prototype.hasOwnProperty.call(map, v)) continue;
      cols[i].scrollTop = map[v];
    }
  }
  // 只搬子节点、**不替换锚元素本身**（拖拽脚本加载期缓存了 #schedule-board 作上溯边界）
  function swapChildren(target, source) {
    var before = scrollMap(target);
    while (target.firstChild !== null) { target.removeChild(target.firstChild); }
    while (source.firstChild !== null) { target.appendChild(source.firstChild); }
    restoreScroll(target, before);
  }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function writeClock() {
    var el = document.querySelector(".live-clock");
    if (el === null) return;
    var t = new Date();
    el.textContent = pad2(t.getHours()) + ":" + pad2(t.getMinutes()) + ":" + pad2(t.getSeconds());
  }
  function swapAll(text) {
    var doc = new DOMParser().parseFromString(text, "text/html");
    var live = document.querySelectorAll("[data-live]");
    var changed = 0;
    for (var i = 0; i < live.length; i += 1) {
      var el = live[i];
      var key = keyOf(el);
      if (key === "" || holdAnchor(el)) continue;
      var src = findAnchor(doc, key);
      if (src === null) continue;
      swapChildren(el, src);
      changed += 1;
    }
    if (changed > 0) { writeClock(); } else { console.warn("[live] 本拍零换块（全部锚 held 或回包摘不到同 key）"); }
  }
  // 排拍 = clear-then-set：busy 早退分支与回包 handler 抢的是**同一个 timer 单槽**，不先清就可能出现
  // 两条链并存；字面量仍恰 1 处（B7 排拍单点不破）。
  function scheduleNext() { if (timer !== null) clearTimeout(timer); timer = setTimeout(tick, intervalMs); }
  // 结构性兜底（v0.10.4 · REQ-2026-10-11-06 T3）：本链任何一路出口都必须排下一拍，且失败要出声。
  // 四条所以然钉死形态，改动前请对照 live-refresh N-3 / N-4：
  //   ① busy 早退**排拍**（不是 return）—— fetch 永不 settle（悬挂连接）时 ⟳ 不被吞的唯一解：
  //      这一拍不发请求，但链还得续着，否则整页从此不再自动更新；
  //   ② 三档出口（回包不可读 / 整拍闸 / 换块之后）全部 scheduleNext ⇒ 出声不吞拍；
  //   ③ busy = false 必在 handler **首行** —— 放在 swapAll 之后的话，swapAll 真抛时 catch 里
  //      没有它，busy 永真 = 一次异常把整条链永停；
  //   ④ 整拍闸（hidden / dragging）从 fetch **之前**挪到换块**之前**（回包后复查）—— 在飞期间
  //      用户切后台 / 起拖 ⇒ 回包也不再动 DOM。**不加第三个拖拽监听**：dragging 的唯一致因是
  //      「回包在拖拽中摘走拖拽源」，由本复查堵住 ⇒ addEventListener 仍恰 6（B7）。
  function tick() {
    timer = null;
    if (busy) { scheduleNext(); return; }
    busy = true;
    fetch(location.pathname + location.search, { credentials: "same-origin", headers: { Accept: "text/html" } }).then(function (res) {
      return res.ok ? res.text() : null;
    }).then(function (text) {
      busy = false;
      if (text === null || text === undefined || text === "") {
        console.warn("[live] 回包不可读（非 2xx 或空体），本拍跳过");
        scheduleNext();
        return;
      }
      if (document.hidden || dragging) { scheduleNext(); return; }
      try { swapAll(text); } catch (err) { console.error("[live] swapAll 抛错，本拍跳过", err); }
      scheduleNext();
    }).catch(function (err) {
      busy = false;
      console.warn("[live] fetch 异常，本拍跳过", err);
      scheduleNext();
    });
  }
  function runOneTick() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    tick();
  }
  document.addEventListener("dragstart", function () { dragging = true; });
  document.addEventListener("dragend", function () { dragging = false; });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) runOneTick(); });
  var nowBtn = document.querySelector(".live-now");
  if (nowBtn !== null) { nowBtn.hidden = false; }
  // ── 任务页局部动线：三条委托（chips / 不带过滤重查·换项目 / 过滤表单）+ pushState · popstate ──
  // 共同闸 = 目标 pathname ∈ {/tasks, /org/<名>/tasks} ∧ 当前页也在这两档 ⇒ 才拦并局部化；
  // 其余（含需求详情一类的跨页链）一律放行原生导航 ⇒ 全站 pushState 只发生在任务页三动线。
  // 本枚活在 TS 模板字符串内：单反斜杠转义斜杠会被源码层当 NonEscapeCharacter 吃掉 ⇒ 运行值成裸斜杠
  // 即整枚 parse 不过（钉 = live-refresh B4 / B8），故此处必须双写反斜杠。
  function onTasksPath(p) {
    return p === "/tasks" || /^\\/org\\/[^/]+\\/tasks$/.test(p);
  }
  function tasksUrl(raw) {
    if (raw === null || raw === undefined || raw === "" || onTasksPath(location.pathname) === false) return null;
    var url = null;
    try { url = new URL(raw, location.href); } catch (e) { return null; }
    if (url.origin !== location.origin) return null;
    return onTasksPath(url.pathname) ? url : null;
  }
  // 跨档回落判据（不猜）：回包与当前页的 [data-live] key 集合必须**完全相同** —— 少一枚 = 摘不到，
  // 多一枚 = 当前页无该壳（换了地址栏却补不出过滤卡）⇒ 两种都交回整页导航。
  function sameKeySet(text) {
    var doc = new DOMParser().parseFromString(text, "text/html");
    var now = document.querySelectorAll("[data-live]");
    var next = doc.querySelectorAll("[data-live]");
    var have = 0;
    for (var i = 0; i < now.length; i += 1) { if (keyOf(now[i]) !== "") have += 1; }
    var got = 0;
    for (var j = 0; j < next.length; j += 1) {
      var key = keyOf(next[j]);
      if (key === "") continue;
      got += 1;
      if (findAnchor(document, key) === null) return false;
    }
    return have === got;
  }
  // 打新 URL → 成功且同档 ⇒ 复用主体换锚（跳拍判据 / 滚动回填 / 时钟单一写入者）→ pushState → 回排下拍。
  // 清掉待发的定时拍再跑 ⇒ 与常驻链共用同一条链，绝不并起两条（在飞一拍未回 ⇒ 交回整页导航）。
  function liveGo(url, push) {
    var target = url.pathname + url.search;
    if (busy === true) { location.assign(target); return; }
    if (timer !== null) { clearTimeout(timer); timer = null; }
    busy = true;
    fetch(target, { credentials: "same-origin", headers: { Accept: "text/html" } }).then(function (res) {
      return res.ok ? res.text() : null;
    }).then(function (text) {
      busy = false;
      if (text === null || text === undefined || sameKeySet(text) === false) { scheduleNext(); location.assign(target); return; }
      if (push === true) history.pushState(null, "", target);
      swapAll(text);
      scheduleNext();
    }).catch(function () { busy = false; scheduleNext(); });
  }
  document.addEventListener("click", function (ev) {
    if (ev.target === null || ev.target.closest === undefined) return;
    // ⟳ 立即更新：原直绑并入本条委托 ⇒ 全常量体 click 恒一条
    if (ev.target.closest(".live-now") !== null) { runOneTick(); return; }
    if (ev.button !== 0 || ev.metaKey === true || ev.ctrlKey === true || ev.shiftKey === true || ev.altKey === true) return;
    var link = ev.target.closest(".b-chips a, .b-card a.fl");
    if (link === null) return;
    var url = tasksUrl(link.getAttribute("href"));
    if (url === null) return;
    ev.preventDefault();
    liveGo(url, true);
  });
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (form === null || form.tagName !== "FORM") return;
    if (form.closest('[data-live="tasks-filter"]') === null) return;
    if ((form.getAttribute("method") || "").toLowerCase() !== "get") return;
    var url = tasksUrl(form.getAttribute("action"));
    if (url === null) return;
    var query = "";
    try { query = new URLSearchParams(new FormData(form)).toString(); } catch (e) { return; }
    url.search = query;
    ev.preventDefault();
    liveGo(url, true);
  });
  window.addEventListener("popstate", function () {
    var url = tasksUrl(location.href);
    if (url === null) return;
    liveGo(url, false);
  });
  scheduleNext();
})();
</script>`;

/**
 * 一级导航单点（REQ-2026-09-30-04 件1 · 件1 口径：全站唯一侧栏的**一级菜单仅一枚**）。
 * 历史：v0.9.4 §9-b 首页 = 组织门户；v0.9.6 B5a 闭集六 → 三枚（摘排期 / 任务 / 宿主桥）；
 * 本轮三 → 一枚 —— 「项目」（`/projects`）与「Agent」（`/agents`）**只撤导航、不撤路由**
 * （深链与正文链接照常可达，口径 33/38 同款处置）。
 */
const NAV: ReadonlyArray<{ key: NavKey; href: string; text: string }> = [
  { key: "home", href: "/", text: "项目组门户" },
];

/**
 * **侧栏二级菜单 = 各项目组**（REQ-2026-09-30-04 件1，替换原「顶栏组织切换器」形态）：
 * 各组织 → `/org/<名>/`（= 该空间排期）的**服务端渲染链接列表**，当前空间项挂 `class="on"`
 * （样式给出左侧圆点高亮）⇒ **零新脚本**，内联脚本闭集不扩（现八元）（N3-⑦/⑧ 纪律锚）。
 * 清单为空 ⇒ 整块不渲染（无组可切时不留空占位，同原切换器口径）。
 * 原 {@link renderOrgSwitcher}（顶栏文字组 + 空间正文行右档）随本形态变更删除 ——
 * 空间正文的二级导航行（`server.ts` 的 `renderSpaceNav`）不再重复挂组清单。
 */
function renderSideOrgs(orgNav: PageOrgNav | undefined): string {
  if (orgNav === undefined || orgNav.orgs.length === 0) return "";
  const items = orgNav.orgs
    .map(
      (o) =>
        `<a href="/org/${encodeURIComponent(o)}/"${o === orgNav.org ? ' class="on"' : ""}>${escapeHtml(o)}</a>`,
    )
    .join("");
  return `<div class="side-orgs"><p class="side-orgs-label">项目组</p>${items}</div>`;
}

export interface PageParams {
  title: string;
  active: NavKey;
  /** 已转义的正文 HTML 片段 */
  bodyHtml: string;
  /** 页头动作区（随标题渲染的**字面量**按钮等，REQ-2026-09-26-04「＋ 新增需求」；不承载用户数据） */
  headerActions?: string;
  /** 错误浮层（REQ 弹窗化 · 表单档错误出口专用；全部字段在本函数内 escapeHtml，调用方传原始值） */
  errorOverlay?: ErrorOverlayParams;
  /**
   * **组织上下文（BD7；REQ-2026-09-30-04 件1 起 = 侧栏二级菜单数据源）**：
   * 给出当前组织空间（可空）+ 项目组清单。清单 = **纯服务端渲染的链接列表**
   * （各组织 → `/org/<名>/` 整页跳转）⇒ 零新脚本，内联脚本闭集不扩（现八元）（N3-⑦/⑧ 纪律锚）。
   * 件1 起原「组织切换器挂位三态」（`orgSwitcher`）随顶栏形态一并退役：全站只有一处侧栏，
   * 组清单不再需要在正文里重复挂载。
   */
  orgNav?: PageOrgNav;
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
  const sideOrgs = renderSideOrgs(params.orgNav);
  const overlay = params.errorOverlay === undefined ? "" : renderErrorOverlay(params.errorOverlay);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="referrer" content="${BOARD_REFERRER_POLICY}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(params.title)} · board</title>
<style>
  /* REQ-2026-09-30-04 §2.0：--b- 设计 token 层（浅色单档，值取自原型稿 v2.3）。
     本层是「唯一取色/取尺度入口」的预备件：既有规则内的字面量替换属后续节点，本轮只建层。 */
  :root {
    color-scheme: light;
    /* 品牌 */
    --b-brand: #2f6f9e;
    --b-brand-ink: #1f4f73;
    --b-brand-soft: #e8f1f8;
    --b-brand-line: #b7d2e6;
    /* 语义（前景 / 底 / 线 三档一组）：ok · warn · danger · locked */
    --b-ok: #1f7a44;
    --b-ok-bg: #e7f4ec;
    --b-ok-line: #a9d8ba;
    --b-warn: #9a6100;
    --b-warn-bg: #fbf1e0;
    --b-warn-line: #e6c489;
    --b-danger: #b42318;
    --b-danger-bg: #fbe9e7;
    --b-danger-line: #e8a29c;
    --b-locked: #6f4e21;
    --b-locked-bg: #f3e5d0;
    --b-locked-line: #a67c52;
    /* 文本（1 主 · 2 次 · 3 弱 · 4 最弱） */
    --b-text: #28323c;
    --b-text-2: #46586a;
    --b-text-3: #64727d;
    --b-text-4: #7d8794;
    /* 面与线 */
    --b-bg: #f4f6f8;
    --b-surface: #ffffff;
    --b-surface-2: #f8fafc;
    --b-line: #d8dee4;
    --b-overlay: rgba(15, 23, 32, .45);
    /* 尺度 · 字号 */
    --b-fs-11: 11px;
    --b-fs-12: 12px;
    --b-fs-13: 13px;
    --b-fs-14: 14px;
    --b-fs-15: 15px;
    --b-fs-18: 18px;
    /* 尺度 · 间距 */
    --b-sp-4: 4px;
    --b-sp-6: 6px;
    --b-sp-8: 8px;
    --b-sp-12: 12px;
    --b-sp-16: 16px;
    --b-sp-24: 24px;
    /* 尺度 · 圆角 */
    --b-r-3: 3px;
    --b-r-4: 4px;
    --b-r-6: 6px;
    --b-r-8: 8px;
    /* 尺度 · 列宽与投影 */
    --b-kcol-w: 264px;
    --b-feat-side: 264px;
    --b-shadow-1: 0 1px 2px rgba(15, 23, 32, .08);
    --b-shadow-2: 0 6px 24px rgba(15, 23, 32, .16);
  }
  * { box-sizing: border-box; }
  /* REQ-2026-09-30-04 件1：全站外壳 = grid〔216px 固定侧栏 | 主区〕（原型 v2.3 样张①） */
  body { margin: 0; display: grid; grid-template-columns: 216px minmax(0, 1fr); min-height: 100vh; font: 14px/1.55 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--b-text); background: var(--b-bg); }
  h1 { font-size: 18px; margin: 0 0 6px; }
  h2 { font-size: 15px; margin: 24px 0 8px; border-bottom: 1px solid #8884; padding-bottom: 4px; }
  /* ── 件1 外壳：侧栏（品牌 / 一级菜单 / 二级项目组菜单）── */
  .sidebar { position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto; background: var(--b-surface); border-right: 1px solid var(--b-line); padding: var(--b-sp-16) 0 var(--b-sp-24); }
  .brand { padding: 0 var(--b-sp-16) var(--b-sp-12); font-size: var(--b-fs-15); font-weight: 700; letter-spacing: .02em; color: var(--b-brand-ink); }
  .sidebar nav { display: block; margin: 0 0 var(--b-sp-4); }
  .sidebar nav a { display: block; padding: var(--b-sp-6) var(--b-sp-16); font-size: var(--b-fs-13); color: var(--b-text-2); text-decoration: none; border-left: 2px solid transparent; }
  /* 当前态 = 品牌浅底 + 左侧 2px 色条 */
  .sidebar nav a.on { background: var(--b-brand-soft); border-left-color: var(--b-brand); color: var(--b-brand-ink); font-weight: 600; }
  .side-orgs { margin-top: var(--b-sp-12); }
  .side-orgs-label { margin: 0 var(--b-sp-16) var(--b-sp-4); font-size: var(--b-fs-11); color: var(--b-text-4); }
  .side-orgs a { display: block; padding: var(--b-sp-4) var(--b-sp-16) var(--b-sp-4) var(--b-sp-24); font-size: var(--b-fs-13); color: var(--b-text-2); text-decoration: none; }
  /* 当前空间 = 缩进项高亮圆点 */
  .side-orgs a.on { color: var(--b-brand-ink); font-weight: 600; }
  .side-orgs a.on::before { content: "●"; font-size: 8px; color: var(--b-brand); margin-right: var(--b-sp-6); vertical-align: 2px; }
  /* ── 件1 外壳：主区（页标题栏 + 内容画布）── */
  .main-col { min-width: 0; padding: var(--b-sp-16) var(--b-sp-24) 0; }
  .page-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--b-sp-12); margin: 0 0 var(--b-sp-12); }
  .page-head h1 { margin: 0; }
  .page-actions { display: flex; gap: var(--b-sp-8); }
  main { padding-bottom: var(--b-sp-24); }
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
  /* v0.10.3 N3 遮挡治理的主机制：宽表的溢出带被折叠体自己的横滚吃掉，不再压进相邻轨
     （.feat-side 是 sticky 定位元素，绘制序在文档流之上 ⇒ 溢出即遮挡）。
     下方的 @container 回落只管观感，不承担遮挡治理；无 @container 支持时本条依旧成立。 */
  .fold-body { overflow-x: auto; }
  details.calib { margin: 6px 0; font-size: 11px; color: #888; }
  details.calib > summary { cursor: pointer; font-style: italic; }
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
  /* v0.10.3 N2c 依赖图管道制（自绘 DOM/CSS · 零脚本）：管道 = 每 project 一枚原生 details。
     v0.10.6 C7 单画布（改造文档 §2.2.2 · 形态 S1）· 件二订正：横滚最终落外层 .dep-graph；
     .dg-canvas 只当坐标系承载者（position:relative，零 overflow）—— 它是绝对定位框的包含块，不再兼作 scroll 面。
     框与框内网格的定位只由画布级后代选择器给（inline style 零 position 声明），框级不新增元素类。
     堆叠纪律：框层三选择器（.pipe / .pipe-body / .dg-grid）**零 z-index / transform / opacity** ——
     任一被设即自成堆叠上下文 ⇒ 画布 svg 的 z-index:1 与 .dg-cell 的 z-index:2 比序失效（线盖在 chip 上）。
     取色只引既有 --b-* token —— 状态色的事实源仍是 graph-view 的 TASK_STATE_COLORS（图例 inline style）。 */
  .dg-canvas { position: relative; }
  .dep-graph { overflow-x: auto; }
  .pipe { border: var(--dg-fb) solid var(--b-line); border-radius: var(--b-r-6); background: var(--b-surface-2); }
  .dg-canvas .pipe { position: absolute; box-sizing: border-box; }
  .pipe > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: var(--b-sp-8); padding: var(--b-sp-6) var(--b-sp-12); font-size: var(--b-fs-13); font-weight: 600; color: var(--b-text); height: var(--dg-fth); box-sizing: border-box; }
  .pipe > summary::-webkit-details-marker { display: none; }
  .pipe-body { display: flex; align-items: center; flex-wrap: wrap; gap: 0; padding: var(--b-sp-8) var(--b-sp-12) var(--b-sp-12); position: relative; }
  /* 框内 origin = border + title + pad 三级加数全部是 JS 常量（DG_FRAME_BORDER / DG_FRAME_TITLE_H /
     DG_FRAME_PAD → 经 --dg-fb / --dg-fth / --dg-fp 下发）⇒ 本条不得留 --b-sp-* 作加数。 */
  .dg-canvas .pipe-body { position: absolute; left: var(--dg-fp); top: var(--dg-fth); padding: 0; overflow: visible; }
  /* v0.10.5 G6 依赖图按真依赖边绘制（形态 α = 固定网格 + 通道走线 + 内联 SVG · 样式同源）：
     几何唯一下发面 = 画布一枚 inline 变量 --dg-nw / --dg-nh / --dg-bh 与盒模 width / height
     ⇒ 本区间不写 chip / 角标带的任何宽高数字（chip 盒与 graph-view 的 DG_NODE_W / DG_NODE_H 同源，
     角标带高与 DG_BADGE_H 同源；坐标原点 = .dg-grid，cell 的 left / top 出自网格函数）。 */
  .dg-grid { position: relative; }
  .dg-links { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; pointer-events: none; }
  .dg-links path { fill: none; stroke: var(--b-line); stroke-width: 1.5px; }
  /* v0.10.6 追加件 n9（REQ-2026-10-14-02）：跨管道连线单独配色 —— 只叠 stroke、零几何声明；
     跨框 path 的 class 首 token 仍是 dg-edge ⇒ 上面基础规则照命中，取色引既有 token。 */
  .dg-links path.dg-edge-cross { stroke: var(--b-brand); }
  .dg-cell { position: absolute; z-index: 2; display: flex; flex-direction: column; align-items: flex-start; padding-top: var(--dg-bh); }
  .dg-chip { display: inline-flex; align-items: center; gap: var(--b-sp-4); border: 1px solid var(--b-line); border-radius: var(--b-r-8); padding: 2px var(--b-sp-8); font-size: var(--b-fs-12); background: var(--b-surface); color: var(--b-text); white-space: nowrap; box-sizing: border-box; width: var(--dg-nw); height: var(--dg-nh); justify-content: center; }
  /* v0.10.3 增补 A1 chip 七态着色补齐：上条基础规则只给中性 border/background ⇒ 状态类是空钩子。
     本组七条 = dg-<NodeState key> 闭集（done/running/queued/failed/frozen/ask/unknown，与 graph-view
     NODE_STATE_ORDER 同序）；色值逐字复用图例在用的同一事实源 graph-view NODE_STATE_COLORS
     （其值 = TASK_STATE_COLORS 的重新指派 + ask 既有色 + 回落 NEUTRAL_TASK_COLOR），CSS 侧不新造色值。
     chip 可见文字仍恒为 #编号（不加 ●◐○ 状态符，状态由本组配色与 title 承载）。
     v0.10.6 C5 角标族退役：原角标带的两条规则随之整条摘除
     （行距改由 dg-cell 的 padding-top: var(--dg-bh) 承接，数值只从画布 inline 下发）。 */
  .dg-chip.dg-done { border-color: #dafbe1; background: #dafbe1; }      /* ← TASK_STATE_COLORS.completed */
  .dg-chip.dg-running { border-color: #e3eef7; background: #e3eef7; }   /* ← TASK_STATE_COLORS.working */
  .dg-chip.dg-queued { border-color: #fff4ce; background: #fff4ce; }    /* ← TASK_STATE_COLORS 的 input-required 档（图例同档转派） */
  .dg-chip.dg-failed { border-color: #ffe7e6; background: #ffe7e6; }    /* ← TASK_STATE_COLORS.failed */
  .dg-chip.dg-frozen { border-color: #f3e5d0; background: #f3e5d0; }    /* ← TASK_STATE_COLORS.blocked */
  .dg-chip.dg-ask { border-color: #ece2fb; background: #ece2fb; }       /* ← NODE_STATE_COLORS.ask（图例在用的既有色） */
  .dg-chip.dg-unknown { border-color: #f2f3f5; background: #f2f3f5; }   /* ← NEUTRAL_TASK_COLOR（不可辨，不表具体态） */
  .dg-edges { margin-top: var(--b-sp-4); font-size: var(--b-fs-12); color: var(--b-text-3); }
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
  /* 件3（REQ-2026-09-30-04）：卡两层化（标题行 ≤2 行截断 + 一行元信息）
     增补五 件A（REQ-2026-10-02-05）：卡内固定四行序（名称 → id 行 → 状态徽标 → 阶段+任务数）
     —— 行为类 .kcard / .kcard[draggable="true"] / .kcol / .kcol.dragover 逐字未改（拖拽双条件闸契约） */
  .kcol > h3 { font-size: 13px; margin: 2px 0 8px; border-bottom: 1px solid #8884; padding: 2px 22px 4px 2px; position: sticky; top: 0; z-index: 1; background: var(--b-surface); border-radius: 4px; }
  /* 件3 列头 sticky 的滚动面：.kanban 的 overflow-x:auto 使它成为滚动祖先，而它纵向永不滚 ⇒ 列内 sticky 悬不住。
     故把纵向滚动收到列上（max-height + overflow-y），列头随列内滚动常驻。
     选择器锁 #schedule-board ⇒ 组织门户（#org-portal）版式零影响。 */
  /* REQ-2026-10-13-04 件B：min-height 只抬**列**的下界（空列/短列也有可命中高度的拖拽落点），
     **不改** .kanban 的 align-items（仍 flex-start）⇒ 各列按内容各自高、列高仍不齐，是预期形态。 */
  #schedule-board > .kcol { max-height: calc(100vh - 120px); overflow-y: auto; padding-top: 0; min-height: 160px; }
  #schedule-board > .kcol > h3 { margin-top: 0; padding-top: 6px; }
  .kcard { border: 1px solid #8884; border-radius: 6px; background: Canvas; padding: 6px 8px; margin: 0 0 6px; font-size: 12px; }
  .kcard > .khd { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; }
  .kcard > .khd > a { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; word-break: break-word; }
  /* 增补五 件A：状态徽标搬出 .khd 独立成行 ⇒ 行内容右靠（.kbadge 的全局 float: right 在 flex 容器内不生效，无需改基元） */
  .kcard > .kbadge-line { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px 6px; margin: 4px 0 0; }
  .kcard[draggable="true"] { cursor: grab; }
  /* 增补五 件B（REQ-2026-10-02-05）：按状态着色 —— 卡根档类 kst-档（七档闭集，
     规则源 derive.ts 的 deriveCardColorTier）= 左缘 3px 色条 + soft 底色；
     取色一律引既有 --b- token，零新色值。locked 档为显式锁定语义预留；
     「已发版」（completed ∧ stage=发版）的派生显示归 ok。 */
  .kcard.draglocked { opacity: .75; } /* 件B：.55 → .75 —— 状态色条优先，避免双层压暗致色条不可见 */
  .kcard .draglock { color: #b26a00; border-color: #b26a0088; }
  .kcard.kst-brand { border-left: 3px solid var(--b-brand); background: var(--b-brand-soft); }
  .kcard.kst-warn { border-left: 3px solid var(--b-warn); background: var(--b-warn-bg); }
  .kcard.kst-ok { border-left: 3px solid var(--b-ok); background: var(--b-ok-bg); }
  .kcard.kst-locked { border-left: 3px solid var(--b-locked); background: var(--b-locked-bg); }
  .kcard.kst-danger { border-left: 3px solid var(--b-danger); background: var(--b-danger-bg); }
  .kcard.kst-cancelled { border-left: 3px solid var(--b-text-4); background: var(--b-line); }
  .kcard.kst-neutral { border-left: 3px solid var(--b-line); background: var(--b-surface-2); }
  .kcol.dragover { outline: 2px dashed #5b86a8; outline-offset: -2px; }
  /* v0.9.8 两栏拖拽增删项目（REQ-2026-10-03-02）：池 / 本组两栏与拖拽态 ——
     行为类另立一族（.m-pool / .mcol / .mrow），.kcol / .kcard 的排期拖拽契约逐字不动；
     取色一律引既有 --b- token（同增补五 件B 口径）。 */
  .m-pool { display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap; }
  .mcol { flex: 1 1 240px; min-width: 0; border: 1px solid var(--b-line); border-radius: 6px; background: var(--b-surface-2); padding: 6px 8px 8px; min-height: 84px; }
  .mcol-h { font-size: 12px; font-weight: 600; margin: 0 0 6px; color: #567; }
  .mcol-sub { font-weight: 400; color: #778; font-size: 11px; margin-left: 6px; }
  .mrow { border: 1px solid #8884; border-radius: 6px; background: Canvas; padding: 4px 7px; margin: 0 0 5px; font-size: 12px; }
  .mrow[draggable="true"] { cursor: grab; }
  .mcol.dragover { outline: 2px dashed #5b86a8; outline-offset: -2px; }
  .m-fold { margin: 6px 0 0; }
  .m-fold > summary { cursor: pointer; color: #567; font-size: 12px; }
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
  /* v0.10.4 · REQ-2026-10-11-06 T3：浮层内那份控制条是死钟（第八枚只服务页侧，浮层档自有件B 节奏）
     ⇒ 整条隐藏。特异性 0-2-1 高于页侧同名规则（0-1-0），与书写序无关，故不动页侧那条；
     同一段落里的 ⟳ 钮一并隐藏 —— 副本无损失，该耦合只登记、不加出口。 */
  dialog.fd .live-bar { display: none; }
  /* 件1：页头动作钮改由 .page-head 的 flex 归位到标题右侧（原 float: right 随顶栏形态退役） */
  /* ── 件5（REQ-2026-09-30-04）：页面卡片基元（空间·任务页 / 空间·管理页）──
     取色与取尺度一律走 --b- token；与看板 .kcard 分立（看板卡有拖拽语义，不互用）。 */
  .b-card { border: 1px solid var(--b-line); border-radius: var(--b-r-8); background: var(--b-surface); box-shadow: var(--b-shadow-1); padding: var(--b-sp-12) var(--b-sp-16) var(--b-sp-16); margin: 0 0 var(--b-sp-16); }
  .b-card > .b-card-h { display: flex; align-items: baseline; justify-content: space-between; gap: var(--b-sp-8); margin: 0 0 var(--b-sp-12); padding-bottom: var(--b-sp-6); border-bottom: 1px solid var(--b-line); font-size: var(--b-fs-14); font-weight: 600; color: var(--b-brand-ink); }
  .b-card-h > .b-card-meta { font-weight: 400; font-size: var(--b-fs-12); color: var(--b-text-4); }
  .b-card > :last-child { margin-bottom: 0; }
  .b-card th { background: var(--b-surface-2); }
  .b-card th, .b-card td { border-color: var(--b-line); }
  /* 过滤卡：GET 查询表单不加任何属性（写/读面表单锚逐字保留），靠后代选择器排版 */
  .b-filter form { flex-wrap: wrap; align-items: flex-end; margin: 0; }
  .b-filter form label { display: flex; flex-direction: column; gap: 2px; font-size: var(--b-fs-12); color: var(--b-text-3); }
  .b-filter form input, .b-filter form select { min-width: 150px; }
  /* 快捷项目 chips（当前项 = 品牌浅底） */
  .b-chips { display: flex; flex-wrap: wrap; gap: var(--b-sp-6); align-items: center; margin: var(--b-sp-8) 0 0; }
  .b-chips-label { font-size: var(--b-fs-11); color: var(--b-text-4); margin-right: var(--b-sp-4); }
  .b-chips a { display: inline-block; padding: 2px 10px; border: 1px solid var(--b-line); border-radius: 999px; background: var(--b-surface-2); color: var(--b-text-2); font-size: var(--b-fs-12); text-decoration: none; }
  .b-chips a:hover { border-color: var(--b-brand-line); color: var(--b-brand-ink); }
  .b-chips a.on { border-color: var(--b-brand-line); background: var(--b-brand-soft); color: var(--b-brand-ink); font-weight: 600; }
  /* 增补③′（REQ-2026-10-12-01）：翻页链版式 —— 裸 nav 元素选择器收敛到 .sidebar 后
     本族补回 flex 一行（此前全站无任何 .pager 规则 ⇒ 链上 <a> 落回默认块化，竖排）。
     取色一律引既有 --b- token；a.fl 须带 .pager 前缀才压得过全站 a.fl{color:inherit} 的特异性。 */
  .pager { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--b-sp-4) var(--b-sp-6); margin: var(--b-sp-8) 0 0; font-size: var(--b-fs-12); color: var(--b-text-3); }
  .pager a.fl { color: var(--b-text-2); text-decoration: none; }
  .pager a.fl:hover { color: var(--b-brand-ink); }
  /* 并列表单（加 / 减成员双卡）；嵌套在卡内的子卡换浅面，避免与外卡同色失边 */
  .b-forms { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--b-sp-12); align-items: start; }
  .b-forms > .b-card { margin: 0; }
  .b-card .b-card { background: var(--b-surface-2); }
  /* 卡内警示条（缺文件 / 末位成员 409 口径 / 齐备态一行） */
  .b-note { border: 1px solid var(--b-warn-line); border-left: 3px solid var(--b-warn); background: var(--b-warn-bg); color: var(--b-warn); border-radius: var(--b-r-6); padding: var(--b-sp-6) var(--b-sp-12); margin: var(--b-sp-8) 0; font-size: var(--b-fs-12); }
  .b-note.danger { border-color: var(--b-danger-line); border-left-color: var(--b-danger); background: var(--b-danger-bg); color: var(--b-danger); }
  .b-note.ok { border-color: var(--b-ok-line); border-left-color: var(--b-ok); background: var(--b-ok-bg); color: var(--b-ok); }
  /* 状态徽标（任务态 / 核对态） */
  .b-badge { display: inline-block; padding: 0 var(--b-sp-6); border: 1px solid var(--b-line); border-radius: var(--b-r-3); background: var(--b-surface-2); color: var(--b-text-2); font-size: var(--b-fs-11); white-space: nowrap; }
  .b-badge.run { border-color: var(--b-brand-line); background: var(--b-brand-soft); color: var(--b-brand-ink); }
  .b-badge.ok { border-color: var(--b-ok-line); background: var(--b-ok-bg); color: var(--b-ok); }
  .b-badge.warn { border-color: var(--b-warn-line); background: var(--b-warn-bg); color: var(--b-warn); }
  .b-badge.danger { border-color: var(--b-danger-line); background: var(--b-danger-bg); color: var(--b-danger); }
  .b-badge.mute { color: var(--b-text-4); }
  /* ── REQ-2026-10-11-03 件E：页级就地刷新的恒在壳 / 「上次更新」条 ──
     壳恒在、内容可空（0→N 首现也能刷出）；取色一律引既有 --b- token，**零新色值**；
     零新脚本（交互面 = 页面脚本闭集第八枚 {@link PAGE_LIVE_SCRIPT}）。 */
  .live-slot { display: block; }
  .live-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--b-sp-6); font-size: var(--b-fs-12); color: var(--b-text-3); }
  .live-clock { color: var(--b-text-2); }
  .live-now { margin: 0; padding: 0 var(--b-sp-6); border: 1px solid var(--b-line); border-radius: var(--b-r-3); background: var(--b-surface-2); color: var(--b-text-2); font-size: var(--b-fs-11); cursor: pointer; }
  /* ── 件2（REQ-2026-09-30-04）：空间 tab 行 / 阶段步条 / 需求详情主·侧两栏 ──
     取色与取尺度一律走 --b- token；**零新脚本**（tab 高亮 = 服务端渲染的 class，折叠仍是原生 details）。 */
  /* 空间 tab 行（当前 tab = 品牌浅底 + 下沿 2px；详情页携带本行时无激活态 ⇒ 三枚皆为普通链接） */
  .b-tabs { margin: 0 0 var(--b-sp-12); padding: 0 var(--b-sp-4) var(--b-sp-4); border-bottom: 1px solid var(--b-line); }
  .b-tabs > .hint { margin: 0; }
  .b-tabs a.fl { display: inline-block; margin: 0 var(--b-sp-4); padding: var(--b-sp-4) var(--b-sp-12); border-radius: var(--b-r-4) var(--b-r-4) 0 0; border-bottom: 2px solid transparent; color: var(--b-text-2); text-decoration: none; }
  .b-tabs a.fl:hover { color: var(--b-brand-ink); background: var(--b-surface-2); }
  .b-tabs a.fl.on { background: var(--b-brand-soft); border-bottom-color: var(--b-brand); color: var(--b-brand-ink); }
  /* 阶段步条：六段圆点 + 连线（完成段打勾、当前段实底），替代元数据表的阶段双行 */
  .b-steps { display: flex; flex-wrap: wrap; align-items: center; gap: var(--b-sp-4); margin: 0 0 var(--b-sp-16); padding: var(--b-sp-8) var(--b-sp-12); border: 1px solid var(--b-line); border-radius: var(--b-r-8); background: var(--b-surface); box-shadow: var(--b-shadow-1); font-size: var(--b-fs-12); }
  .b-step { display: inline-flex; align-items: center; gap: var(--b-sp-4); color: var(--b-text-3); white-space: nowrap; }
  .b-step-dot { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border: 1px solid var(--b-line); border-radius: 50%; background: var(--b-surface-2); color: var(--b-ok); font-size: var(--b-fs-11); font-style: normal; }
  .b-step-name { font-weight: 400; }
  .b-step.done .b-step-dot { border-color: var(--b-ok-line); background: var(--b-ok-bg); }
  .b-step.done .b-step-name { color: var(--b-text-2); }
  .b-step.cur .b-step-dot { border-color: var(--b-brand); background: var(--b-brand); }
  .b-step.cur .b-step-name { color: var(--b-brand-ink); font-weight: 600; }
  .b-step-line { display: inline-block; width: 18px; height: 1px; background: var(--b-line); }
  .b-step-line.done { background: var(--b-brand-line); }
  .b-steps-cur { margin-left: auto; color: var(--b-text-3); }
  /* 两栏：主栏自适应 + 侧栏定宽；窄窗（含浮层 dialog 收窄时）回落单列 */
  .feat-cols { display: grid; grid-template-columns: minmax(0, 1fr) var(--b-feat-side); gap: var(--b-sp-16); align-items: start; }
  .feat-main, .feat-side { min-width: 0; }
  .feat-side { position: sticky; top: var(--b-sp-16); }
  @media (max-width: 900px) {
    .feat-cols { grid-template-columns: minmax(0, 1fr); }
    .feat-side { position: static; }
  }
  /* v0.10.3 N3 回落单列的**观感**面（原型 v1 锁定：机制 = 容器查询、阈值 = 1000px）：
     @media 判的是视口宽度，而排期浮层 dialog.fd 宽 min(880px, 92vw) ⇒ 视口 >900 时浮层内
     **永不回落**；把浮层体声明为 query container 后，回落按**容器**宽度判。
     ⚠ 本块不治理遮挡（遮挡由上面 .fold-body{overflow-x:auto} 治好）—— 浏览器不认 @container
     时这里整块失效，观感退回两栏，遮挡不因此复现，故**不得把它当承重墙**。 */
  dialog.fd .fd-body { container-type: inline-size; }
  @container (max-width: 1000px) {
    .feat-cols { grid-template-columns: minmax(0, 1fr); }
    .feat-side { position: static; }
  }
  /* 各块自带原生 <h2> ⇒ 卡头就是它（不叠第二层标题，标题文案与 class 一律不动） */
  .feat-card > h2:first-child { margin: 0 0 var(--b-sp-12); padding-bottom: var(--b-sp-6); border-bottom: 1px solid var(--b-line); border-radius: 0; font-size: var(--b-fs-14); color: var(--b-brand-ink); }
  /* 引导卡 = 品牌浅底（引导行文案与 class 不变，只换承载面） */
  .feat-guide { background: var(--b-brand-soft); border-color: var(--b-brand-line); }
  .feat-guide > .nextstep { margin: 0; border-left-color: var(--b-brand); background: transparent; }
  /* 侧栏元数据卡：compact 两列（名 / 值），替代原 4×2 大表 */
  .b-meta { display: grid; gap: var(--b-sp-4); margin: 0; font-size: var(--b-fs-12); }
  .b-meta-row { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: var(--b-sp-8); }
  .b-meta-row dt { color: var(--b-text-3); }
  .b-meta-row dd { margin: 0; font-family: ui-monospace, Consolas, monospace; word-break: break-word; }
  /* 侧栏定宽里的表：不撑破卡（依赖图已上移主栏，横滚归 .dep-graph） */
  .feat-side table { font-size: var(--b-fs-11); }
</style>
</head>
<body>
<aside class="sidebar">
<div class="brand">board</div>
<nav>${nav}</nav>
${sideOrgs}</aside>
<div class="main-col">
<header class="page-head">
<h1>${escapeHtml(params.title)}</h1><div class="page-actions">${params.headerActions ?? ""}</div>
</header>
<main>
${params.bodyHtml}
</main>
</div>
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
