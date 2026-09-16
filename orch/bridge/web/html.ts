/**
 * orch 网页端只读工作台的 HTML 模板（v0.5.0 §2.2；节点 N3）。
 *
 * 形态约束（§2.2「零前端工具链」）：
 * - **无框架 / 无构建 / 无外部资源**：仅一个内联 `<style>` + 一个内联 `<script>`；
 *   不引 CDN / 字体 / 图标，不发任何跨站请求（配套 CSP 由 `transports/web.ts` 下发）。
 * - **纯函数**：`renderIndexHtml(params)` 只做字符串拼接 —— 无 IO、无状态、无副作用，
 *   可直接单测（见 `test/web.test.ts`）。
 * - **与本传输层解耦**：本文件不知道 HTTP / 路由 / 端口 / 内核；由 `bridge/transports/web.ts`
 *   在应答 `GET /` 时调用。
 *
 * 页面语义（§2.2 快照语义，不得呈现为「实时在线」）：
 * - 页头展示桥自身标识（`role` / `pid` / `startedAt`，来自 `RuntimeReadiness`）+ `version`，
 *   供人辨识「这是哪个桥」（多桥 / 常驻化后尤其必要）；未就绪（`readiness = null`）如实标注。
 * - 数据区块一律经 `/api/*` 取；**只发 GET**，页面不持有任何服务端游标。
 * - 自动刷新间隔由服务端下发且**不低于 15s**（下限在 `transports/web.ts` 强制），
 *   页面提供「暂停 / 恢复」。
 *
 * ## 本轮（v0.5.0 §8 增补 · 第 2 次：「需求（Feature）→ 任务（Task）」层级视图）
 *
 * - 页面由三块面板收敛为**两块**：
 *   ① 「项目」（machine + project + 在线态，**保持不变**）；
 *   ② 「**需求 → 任务**」—— 由原「Feature 列表」+「任务」**合并**而来。
 * - **需求行** = `title`（主标识，**不以 UUID 作主标识**；UUID 仅作次要锚点，8 位前缀 + 悬浮全量）
 *   + **中文状态** + **进度**（展开后 `已完成/总数`，展开前 `—/taskCount` 占位）。
 * - **展开**（点需求行）= **懒加载** `GET /api/features/:featureId`，就地渲染其 **Task 行**：
 *   `projectId` / 中文状态 / `createdAt → finishedAt`（缺失显示「未知」）/ 耗时（`finished − started`，
 *   缺失显示「—」）/ prompt 摘要（截断）。
 *   **首屏只发 1 次 `GET /api/features`** —— 绝不为首屏发起 N 次详情请求；展开态与详情缓存
 *   **跨自动刷新保留**（否则每 15s 会被折叠一次）。
 * - **已移除**：手输 `projectId` 输入框 + 「查询任务」按钮（`GET /api/tasks` 路由**保留不变**，
 *   只是本页不再调用）；「本地库 + 只读探测」「快照语义」等术语长句（页头改为一句人话说明）。
 *
 * ## 中文状态映射（**只在展示层**）
 *
 * 映射表在下方内联脚本里（`FEATURE_STATE_LABELS` / `TASK_STATE_LABELS`）；**后端枚举与
 * `/api/*` 出参原样不动**。**未知取值原样显示**（不吞、不静默、不猜）。
 *
 * ## 事件流
 *
 * `GET /api/events` **接口与其行为保留不变**（价值在调试与未来交互面）；仅不由本页渲染 ——
 * 页面因此**不持有**任何事件游标。
 */

/** 桥自身标识（`RuntimeReadiness` 的 role / pid / startedAt；`null` = 尚未就绪） */
export interface WebReadiness {
  role: string;
  pid: number;
  /** UTC ISO 8601 */
  startedAt: string;
}

export interface WebPageParams {
  /** 桥标识；lifecycle 尚未就绪时传 `null`（页面如实标注「starting」） */
  readiness: WebReadiness | null;
  /** 桥版本（`/health` 同源） */
  version: string;
  /** 自动刷新间隔（ms；调用方已按最小间隔收口） */
  refreshMs: number;
}

/** HTML 文本转义（页面内所有动态值在拼进 innerHTML 前必须经此） */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 桥标识行（未就绪时如实退化，不假装有值） */
function identityRows(readiness: WebReadiness | null): string {
  if (readiness === null) {
    return [
      "<dt>role</dt><dd>starting</dd>",
      "<dt>pid</dt><dd>-</dd>",
      "<dt>startedAt</dt><dd>未就绪（lifecycle recover() 尚未完成）</dd>",
    ].join("");
  }
  return [
    `<dt>role</dt><dd>${escapeHtml(readiness.role)}</dd>`,
    `<dt>pid</dt><dd>${escapeHtml(readiness.pid)}</dd>`,
    `<dt>startedAt</dt><dd>${escapeHtml(readiness.startedAt)}</dd>`,
  ].join("");
}

/**
 * 渲染只读工作台首页（内联 HTML，字符串）。
 *
 * 注意：页面内联脚本**刻意不使用模板字符串 / 不改用任何外部资源**，
 * 以便本模板能安全地放在一个 TS 模板字面量里（避免与宿主模板的 `${}` / 反引号冲突）。
 */
export function renderIndexHtml(params: WebPageParams): string {
  const refreshMs = Math.round(params.refreshMs);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>a2a-coding 只读工作台</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px 20px 48px; font: 14px/1.55 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 10px; }
  h2 { font-size: 15px; margin: 26px 0 8px; border-bottom: 1px solid #8884; padding-bottom: 4px; }
  header { border: 1px solid #8884; border-radius: 6px; padding: 12px 14px; }
  dl#identity { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 0; }
  dl#identity dt { color: #888; font-family: ui-monospace, Consolas, monospace; }
  dl#identity dd { margin: 0; font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 10px 0; }
  .hint { color: #777; margin: 6px 0; }
  .hint.err { color: #b42318; }
  table { border-collapse: collapse; width: 100%; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  th, td { border: 1px solid #8884; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #8881; }
  td.empty { color: #888; }
  tr.warn td { color: #b42318; }
  tr.feat-row { cursor: pointer; }
  tr.feat-row:hover td { background: #8882; }
  tr.feat-detail > td { background: #8881; }
  .caret { color: #888; }
  .muted { color: #888; font-size: 11px; }
  table.sub { margin: 0; }
  table.sub th { background: transparent; }
  .status-online { color: #1a7f37; }
  .status-offline { color: #b42318; }
  button, input, select { font: inherit; padding: 3px 8px; }
  code { background: #8881; padding: 0 3px; border-radius: 3px; }
</style>
</head>
<body>
<header>
  <h1>a2a-coding 只读工作台</h1>
  <dl id="identity">
    ${identityRows(params.readiness)}
    <dt>version</dt><dd>${escapeHtml(params.version)}</dd>
  </dl>
  <div class="controls">
    <button id="toggle" type="button">暂停自动刷新</button>
    <span id="refresh-state" class="hint"></span>
    <span id="observed" class="hint"></span>
  </div>
  <p class="hint">本页只读：项目在线态取自最近一次只读探测（非实时），需求与任务取自桥的本地记录。</p>
</header>
<main>
  <section>
    <h2>项目（machine + project + 在线态）</h2>
    <p class="hint" id="projects-note">加载中…</p>
    <table>
      <thead><tr><th>machineId</th><th>projectId</th><th>agentKind</th><th>a2aPort</th><th>status</th><th>endpoint</th><th>startedAt</th></tr></thead>
      <tbody id="projects-body"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
    </table>
  </section>
  <section>
    <h2>需求 → 任务</h2>
    <p class="hint" id="features-note">加载中…</p>
    <table>
      <thead><tr><th>需求（标题）</th><th>状态</th><th>进度</th></tr></thead>
      <tbody id="features-body"><tr><td colspan="3" class="empty">加载中…</td></tr></tbody>
    </table>
  </section>
</main>
<script>
(function () {
  "use strict";
  var REFRESH_MS = ${refreshMs};
  var paused = false;

  /* 中文状态映射：只在展示层做（后端枚举不动）；未命中的取值原样显示 */
  var FEATURE_STATE_LABELS = {
    waiting_approval: "待审批",
    executing: "执行中",
    integrating: "集成中",
    testing: "测试中",
    reviewing: "评审中",
    completed: "已完成",
    needs_input: "待澄清",
    failed: "失败",
    cancelled: "已取消"
  };
  var TASK_STATE_LABELS = {
    working: "执行中",
    completed: "已完成",
    failed: "失败",
    "input-required": "待澄清",
    blocked: "已阻塞"
  };

  /* 展开态 + 详情缓存：跨自动刷新保留（否则每 15s 被折叠一次） */
  var expanded = {};
  var detail = {};
  var loading = {};
  var lastFeatures = [];

  function q(id) { return document.getElementById(id); }
  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function when(iso) { return iso ? new Date(iso).toLocaleString() : "-"; }
  /* 需求/任务时刻：缺值显示「未知」（与项目表沿用同一展示格式，不新增时区逻辑） */
  function stamp(iso) { return iso ? new Date(iso).toLocaleString() : "未知"; }
  function emptyRow(cols, text) { return '<tr><td colspan="' + cols + '" class="empty">' + text + "</td></tr>"; }
  function setNote(id, text) { q(id).textContent = text; }
  function setRows(id, html) { q(id).innerHTML = html; }
  function errText(out) {
    if (out.body && typeof out.body.error === "string") return "HTTP " + out.status + " - " + out.body.error;
    return "HTTP " + out.status;
  }
  function getJson(url) {
    return fetch(url, { cache: "no-store", headers: { accept: "application/json" } }).then(function (res) {
      return res.json().then(function (body) { return { status: res.status, body: body }; }, function () {
        return { status: res.status, body: null };
      });
    });
  }
  /* 状态中文：命中用映射；未命中原样显示（不吞、不静默） */
  function label(map, value) {
    if (value === null || value === undefined || value === "") return "-";
    var key = String(value);
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : key;
  }
  function shortId(id) { return (typeof id === "string" && id.length > 8) ? id.slice(0, 8) : id; }
  /* 耗时 = finished - started；任一缺失 / 非法 / 为负 ⇒ "—" */
  function duration(startedAt, finishedAt) {
    if (!startedAt || !finishedAt) return "—";
    var s = new Date(startedAt).getTime();
    var f = new Date(finishedAt).getTime();
    if (isNaN(s) || isNaN(f) || f < s) return "—";
    var sec = Math.round((f - s) / 1000);
    if (sec < 60) return sec + "s";
    var min = Math.floor(sec / 60);
    if (min < 60) return min + "m" + (sec % 60 ? " " + (sec % 60) + "s" : "");
    var hour = Math.floor(min / 60);
    return hour + "h" + (min % 60 ? " " + (min % 60) + "m" : "");
  }
  function truncate(text, max) {
    if (text === null || text === undefined) return "";
    var s = String(text);
    return s.length > max ? s.slice(0, max) + "…" : s;
  }
  /* 进度：展开后按详情 tasks 统计「已完成/总数」；展开前只用列表的 taskCount 占位（首屏不发详情请求） */
  function progress(f) {
    var d = detail[f.featureId];
    if (d && d.tasks) {
      var done = 0;
      d.tasks.forEach(function (t) { if (t.state === "completed") done += 1; });
      return done + "/" + d.tasks.length;
    }
    var total = (f.taskCount === null || f.taskCount === undefined) ? "?" : f.taskCount;
    return "—/" + total;
  }
  function taskTable(tasks) {
    if (!tasks || tasks.length === 0) return '<p class="hint">（无任务）</p>';
    return '<table class="sub"><thead><tr><th>projectId</th><th>状态</th><th>createdAt → finishedAt</th><th>耗时</th><th>prompt 摘要</th></tr></thead><tbody>' +
      tasks.map(function (t) {
        return "<tr><td>" + esc(t.projectId) +
          "</td><td>" + esc(label(TASK_STATE_LABELS, t.state)) +
          "</td><td>" + esc(stamp(t.createdAt)) + " → " + esc(stamp(t.finishedAt)) +
          "</td><td>" + esc(duration(t.startedAt, t.finishedAt)) +
          "</td><td>" + esc(truncate(t.prompt, 80)) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }
  function detailHtml(featureId) {
    if (loading[featureId] === true) return '<p class="hint">任务加载中…</p>';
    var d = detail[featureId];
    if (!d) return '<p class="hint">任务加载中…</p>';
    if (d.error) return '<p class="hint err">任务读取失败：' + esc(d.error) + "</p>";
    return taskTable(d.tasks);
  }
  function featureRows(list) {
    var rows = [];
    list.forEach(function (f) {
      var open = expanded[f.featureId] === true;
      rows.push('<tr class="feat-row" data-feature-id="' + esc(f.featureId) + '">' +
        '<td><span class="caret">' + (open ? "▾" : "▸") + "</span> " + esc(f.title) +
        ' <span class="muted" title="' + esc(f.featureId) + '">' + esc(shortId(f.featureId)) + "</span></td>" +
        "<td>" + esc(label(FEATURE_STATE_LABELS, f.state)) + "</td>" +
        "<td>" + esc(progress(f)) + "</td></tr>");
      if (open) {
        rows.push('<tr class="feat-detail"><td colspan="3">' + detailHtml(f.featureId) + "</td></tr>");
      }
    });
    return rows.join("");
  }
  function renderFeatures(list) {
    if (list) lastFeatures = list;
    setRows("features-body", lastFeatures.length === 0 ? emptyRow(3, "（无需求）") : featureRows(lastFeatures));
  }
  /* 懒加载单个需求的任务（展开时才发；同一需求同时只飞一个请求） */
  function loadDetail(featureId) {
    if (loading[featureId] === true) return;
    loading[featureId] = true;
    if (!detail[featureId]) renderFeatures();
    getJson("/api/features/" + encodeURIComponent(featureId)).then(function (out) {
      loading[featureId] = false;
      if (!out.body || out.body.ok !== true) {
        detail[featureId] = { error: errText(out) };
      } else {
        detail[featureId] = { tasks: out.body.tasks || [] };
      }
      renderFeatures();
    }).catch(function (e) {
      loading[featureId] = false;
      detail[featureId] = { error: (e && e.message) ? e.message : String(e) };
      renderFeatures();
    });
  }

  function refreshProjects() {
    return getJson("/api/projects").then(function (out) {
      if (!out.body || out.body.ok !== true) {
        setNote("projects-note", "读取失败：" + errText(out));
        setRows("projects-body", emptyRow(7, "读取失败"));
        return;
      }
      var body = out.body;
      var rows = [];
      (body.machines || []).forEach(function (m) {
        if (m.error) {
          rows.push('<tr class="warn"><td>' + esc(m.machineId) + '</td><td colspan="6">机器不可达：' + esc(m.error) + "</td></tr>");
        }
        (m.projects || []).forEach(function (p) {
          rows.push("<tr><td>" + esc(m.machineId) + "</td><td>" + esc(p.projectId) + "</td><td>" + esc(p.agentKind) +
            "</td><td>" + esc(p.a2aPort) + '</td><td class="status-' + esc(p.status) + '">' + esc(p.status) +
            "</td><td>" + esc(p.endpoint) + "</td><td>" + esc(when(p.startedAt)) + "</td></tr>");
        });
      });
      setNote("projects-note", "由 " + body.source + " 派生 - 观测时间 " + when(body.observedAt) + " - 快照语义（非实时在线）");
      setRows("projects-body", rows.length === 0 ? emptyRow(7, "（无项目）") : rows.join(""));
    }).catch(function (e) {
      setNote("projects-note", "请求失败：" + (e && e.message ? e.message : String(e)));
    });
  }

  function refreshFeatures() {
    return getJson("/api/features").then(function (out) {
      if (!out.body || out.body.ok !== true) {
        setNote("features-note", "读取失败：" + errText(out));
        setRows("features-body", emptyRow(3, "读取失败"));
        return;
      }
      var list = out.body.features || [];
      setNote("features-note", "共 " + list.length + " 条需求；点需求行展开其任务（展开时才读该需求详情）");
      renderFeatures(list);
      /* 已展开的需求：随刷新续读（保持展开态，不折叠、不重置） */
      list.forEach(function (f) { if (expanded[f.featureId] === true) loadDetail(f.featureId); });
    }).catch(function (e) {
      setNote("features-note", "请求失败：" + (e && e.message ? e.message : String(e)));
    });
  }

  function updateRefreshState() {
    q("refresh-state").textContent = paused
      ? "自动刷新已暂停"
      : "自动刷新：每 " + (REFRESH_MS / 1000) + "s（最小 15s）";
  }

  function tick() {
    if (paused) return;
    q("observed").textContent = "本页最后刷新：" + new Date().toLocaleTimeString();
    refreshProjects();
    refreshFeatures();
  }

  q("toggle").addEventListener("click", function () {
    paused = !paused;
    q("toggle").textContent = paused ? "恢复自动刷新" : "暂停自动刷新";
    updateRefreshState();
    if (!paused) tick();
  });

  /* 需求行点击 = 展开 / 收起（事件委托：行是随刷新重建的，不能逐行绑） */
  q("features-body").addEventListener("click", function (ev) {
    var el = ev.target;
    var row = (el && typeof el.closest === "function") ? el.closest("tr.feat-row") : null;
    if (!row) return;
    var featureId = row.getAttribute("data-feature-id");
    if (!featureId) return;
    if (expanded[featureId] === true) {
      expanded[featureId] = false;
      renderFeatures();
      return;
    }
    expanded[featureId] = true;
    renderFeatures();
    if (!detail[featureId]) loadDetail(featureId);
  });

  updateRefreshState();
  tick();
  setInterval(tick, REFRESH_MS);
})();
</script>
</body>
</html>
`;
}
