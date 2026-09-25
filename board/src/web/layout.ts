/**
 * 板页面模板骨架（BD3）—— 照 `orch/bridge/web/html.ts` 路线：
 * **同源、无构建、无框架、无外部资源**（内联 style、单文件模板字面量）。
 * 服务器端渲染；页面脚本 = **零依赖的一段内联提交守卫**（收口轨 14，见 {@link SUBMIT_GUARD_SCRIPT}）；
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
 */
export const BOARD_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'";

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

export type NavKey = "features" | "tasks" | "projects" | "host";

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

const NAV: ReadonlyArray<{ key: NavKey; href: string; text: string }> = [
  { key: "features", href: "/", text: "需求" },
  { key: "tasks", href: "/tasks", text: "任务" },
  { key: "projects", href: "/projects", text: "项目 / 机器" },
  { key: "host", href: "/host", text: "宿主桥" },
];

export interface PageParams {
  title: string;
  active: NavKey;
  /** 已转义的正文 HTML 片段 */
  bodyHtml: string;
  /** 页面级口径脚注（B13 / 并行度等，逐条渲染，内部已转义） */
  notes?: readonly string[];
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
  textarea { resize: vertical; }
  code { background: #8881; padding: 0 3px; border-radius: 3px; }
  a.fl { color: inherit; }
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
