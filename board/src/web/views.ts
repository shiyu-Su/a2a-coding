/**
 * 板只读视图（BD3）：需求列表 / 需求详情（含 trace 三面）/ 任务 / 项目·机器。
 *
 * 全部为**纯函数**（输入已归一的视图数据，输出正文 HTML 片段），规则一律取自
 * `derive.ts`，不散落在模板字符串里。所有动态值经 `escapeHtml`。
 */
import type {
  FeatureDetailView,
  FeaturesListView,
  FeatureTraceView,
  ProjectTasksView,
  ProjectsView,
} from "../bridge-client.js";
import {
  B13_CALIBRATION_NOTES,
  INFLIGHT_CALIBRATION_NOTE,
  PARALLELISM_NOTE,
  deriveConfirmAffordance,
  deriveDisplayStage,
  deriveNextStepHint,
  deriveTerminalFeatureAffordance,
  deriveTurnBusyAffordance,
  traceWaitDisplay,
} from "../derive.js";
import type { ConfirmAffordance, NextStepInput } from "../derive.js";
import type { OccupantTurnView } from "../host-turn.js";
import type { HostStatusEntry, StopBridgeOutcome, TriggerTurnOutcome } from "../host-face.js";
import { emptyRow, escapeHtml } from "./layout.js";

/** 引擎态中文（**仅展示层**，照 orch 网页面先例；未命中原样显示，不吞不猜）。 */
const FEATURE_STATE_LABELS: Readonly<Record<string, string>> = {
  waiting_approval: "待审批",
  executing: "执行中",
  integrating: "集成中",
  testing: "测试中",
  reviewing: "评审中",
  completed: "已完成",
  needs_input: "待澄清",
  failed: "失败",
  cancelled: "已取消",
};

const TASK_STATE_LABELS: Readonly<Record<string, string>> = {
  working: "执行中",
  completed: "已完成",
  failed: "失败",
  "input-required": "待澄清",
  blocked: "已阻塞",
};

function label(map: Readonly<Record<string, string>>, value: string | null): string {
  if (value === null || value === "") return "—";
  return Object.prototype.hasOwnProperty.call(map, value) ? `${map[value]}（${value}）` : value;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function stamp(iso: string | null): string {
  return iso ?? "—";
}

function featureLink(featureId: string, text?: string): string {
  return `<a class="fl" href="/features/${encodeURIComponent(featureId)}">${escapeHtml(text ?? shortId(featureId))}</a>`;
}

// ---------------------------------------------------------------------------
// 提需求表单（BD7 · 板唯一写控件；同源 POST，服务器端渲染）
// ---------------------------------------------------------------------------

/**
 * `POST /requirements` 的同源表单（**提交体验靠 `layout.ts` 的内联提交守卫防连点**，
 * 无 JS 时仍可正常提交 —— CSRF 防线因此走「同源 Origin」档，
 * 自定义头 `X-Board-Write` 留给 API 调用方，见 `write-guard.ts`）。
 *
 * **组织名进表单（BD11）**：它是身份链 S1 的**来源**（= MCP URL 首段 = 组织目录名），由用户在板上
 * 创建/指定 —— 首次填写某组织名即在板上创建该组织。板级配置只是**可选默认**：配置了则占位提示、
 * 允许留空；未配置则该字段 `required`（服务端另在请求期硬校验，缺 ⇒ 400，**不猜不回落**）。
 */
export function renderRequirementForm(defaultGroup: string | null): string {
  const cfg = (defaultGroup ?? "").trim();
  const orgHint =
    cfg === ""
      ? "组织名 *（必填：本板未配默认组织 · 首次填写即创建该组织）"
      : `组织名（留空 = 用板级默认 ${cfg}；填写其它名字 = 在板上创建该组织）`;
  return `<h2>提需求</h2>
<p class="hint">建一条需求 = 以<b>表单所填组织名</b>（留空则板级默认）经唯一写封装（<code>requirement.ts</code>）在桥侧建 Feature，落初态 <code>waiting_approval</code>（登记 <code>stage=需求分析</code> · <code>approval=未发起</code>）。板<b>不写状态机</b>：审批 / 推进 / 取消一律归编排 agent。</p>
<form method="post" action="/requirements" class="w" data-submit="已提交，建需求中…">
<label>组织名 ${cfg === "" ? "*" : ""}<input name="group" ${cfg === "" ? "required " : ""}placeholder="如 flow-team"></label>
<label>标题 *<input name="title" required placeholder="需求的简短摘要"></label>
<label>版本 *<input name="version" required placeholder="v0.9.0"></label>
<label>需求原文<textarea name="requirement" rows="3" placeholder="可选"></textarea></label>
<p class="hint">${escapeHtml(orgHint)}</p>
<button type="submit">提交需求</button>
</form>`;
}

// ---------------------------------------------------------------------------
// 需求列表（视图 V1 · §2.2-9）
// ---------------------------------------------------------------------------

export function renderFeaturesList(view: FeaturesListView): string {
  const rows = view.features.map((f) => {
    const d = deriveDisplayStage(f.state, f.stage);
    const derivedMark = d.basis === "derived" ? "派生" : "登记";
    return (
      "<tr>" +
      `<td>${featureLink(f.featureId, f.title === "" ? f.featureId : f.title)} <span class="muted" title="${escapeHtml(f.featureId)}">${escapeHtml(shortId(f.featureId))}</span></td>` +
      `<td>${escapeHtml(label(FEATURE_STATE_LABELS, f.state))}</td>` +
      `<td>${escapeHtml(d.label)} <span class="muted">${derivedMark}</span></td>` +
      `<td>${escapeHtml(f.stage ?? "—")}</td>` +
      `<td>${escapeHtml(f.version === null || f.version === "" ? "—" : f.version)}</td>` +
      `<td>${escapeHtml(f.approval ?? "—")}</td>` +
      `<td>${f.taskCount === null ? "—" : f.taskCount}</td>` +
      `<td>${escapeHtml(stamp(f.updatedAt))}</td>` +
      "</tr>"
    );
  });
  const countsNote =
    view.stateCounts === null
      ? `<p class="hint">各态分布：桥 <code>GET /api/features</code> 未透出 per-feature <code>stateCounts</code>（老桥）⇒ 本板不显示（板不做 N 次查询补齐）。</p>`
      : `<p class="hint">各态分布：${escapeHtml(
          Object.entries(view.stateCounts)
            .map(([k, v]) => `${k}=${v}`)
            .join(" · ") || "（空分布 · 无任务）",
        )} <span class="muted">（本地聚合自列表各项 <code>stateCounts</code>）</span></p>`;
  return `<h2>需求列表</h2>
<p class="hint">共 ${view.features.length} 条；「阶段」列 = 登记值 + 引擎态派生（派生规则集中于 <code>derive.ts</code>）；任务数取列表自带 <code>taskCount</code>（无逐行二次查询）。</p>
${countsNote}
<table><thead><tr><th>需求</th><th>引擎态</th><th>阶段（显示）</th><th>阶段（登记）</th><th>版本</th><th>审批门</th><th>任务数</th><th>更新</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(8, "（无需求）") : rows.join("")}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// 需求详情（单 Feature + 任务 + trace 三面）
// ---------------------------------------------------------------------------

export function renderFeatureDetail(
  detail: FeatureDetailView,
  trace: FeatureTraceView | null,
  traceError: string | null,
  nowMs: number,
): string {
  const f = detail.feature;
  const d = deriveDisplayStage(f.state, f.stage);
  const head = `<h2>${escapeHtml(f.title === "" ? f.featureId : f.title)} <span class="muted mono" title="${escapeHtml(f.featureId)}">${escapeHtml(f.featureId)}</span></h2>
<table><tbody>
<tr><th>引擎态</th><td>${escapeHtml(label(FEATURE_STATE_LABELS, f.state))}</td><th>阶段（显示）</th><td>${escapeHtml(d.label)} <span class="muted">${d.basis === "derived" ? "派生" : "登记"}</span></td></tr>
<tr><th>阶段（登记）</th><td>${escapeHtml(f.stage ?? "—")}</td><th>版本</th><td>${escapeHtml(f.version === null || f.version === "" ? "—" : f.version)}</td></tr>
<tr><th>审批门（approval）</th><td>${escapeHtml(f.approval ?? "—")}</td><th>归属组</th><td>${escapeHtml(f.ownerGroup ?? "—")}</td></tr>
<tr><th>创建</th><td>${escapeHtml(stamp(f.createdAt))}</td><th>更新</th><td>${escapeHtml(stamp(f.updatedAt))}</td></tr>
</tbody></table>`;

  const taskRows = detail.tasks.map((t) => {
    return (
      "<tr>" +
      `<td class="mono">${escapeHtml(shortId(t.taskId))}</td>` +
      `<td>${escapeHtml(t.projectId)}</td>` +
      `<td>${escapeHtml(label(TASK_STATE_LABELS, t.state))}</td>` +
      `<td>${escapeHtml(t.lane)}</td>` +
      `<td>${escapeHtml(t.failureKind ?? "—")}</td>` +
      `<td>${t.retryCount === null ? "—" : t.retryCount}</td>` +
      `<td>${escapeHtml(t.dependencies === null ? "—" : t.dependencies.map(shortId).join(", "))}</td>` +
      "</tr>"
    );
  });
  const tasks = `<h2>任务（${detail.tasks.length}）</h2>
<table><thead><tr><th>taskId</th><th>项目</th><th>状态</th><th>档</th><th>失败类</th><th>重派</th><th>依赖</th></tr></thead>
<tbody>${taskRows.length === 0 ? emptyRow(7, "（无任务）") : taskRows.join("")}</tbody></table>`;

  let traceHtml: string;
  if (trace === null) {
    traceHtml = `<h2>进展三面（在等谁 / 位次 / 为什么没跑）</h2><p class="hint err">trace 读取失败：${escapeHtml(traceError ?? "未知错误")}（桥 trace 接口不可达时如实显示，不静默）</p>`;
  } else {
    const rows = trace.nodes.map((n) => {
      const w = traceWaitDisplay(n, nowMs);
      return (
        "<tr>" +
        `<td class="mono">${escapeHtml(shortId(n.taskId))}</td>` +
        `<td>${escapeHtml(n.projectId)}</td>` +
        `<td>${escapeHtml(label(TASK_STATE_LABELS, n.state))}</td>` +
        `<td>${escapeHtml(n.lane)}</td>` +
        `<td class="mono">${escapeHtml(w.waitReason)}</td>` +
        `<td>${escapeHtml(w.writeGate)}</td>` +
        `<td>${escapeHtml(w.readOccupants)}</td>` +
        `<td>${escapeHtml(w.position)}</td>` +
        `<td>${escapeHtml(w.waited)} <span class="muted">自 ${escapeHtml(w.waitedSince)}</span></td>` +
        `<td>${escapeHtml(w.blockedOn)}</td>` +
        "</tr>"
      );
    });
    traceHtml = `<h2>进展三面（在等谁 / 位次 / 为什么没跑）</h2>
<p class="hint">数据 = <code>GET /api/features/:id/trace</code> 原样复用；<code>waitReason</code> 为八值闭集，原样显示。</p>
<table><thead><tr><th>taskId</th><th>项目</th><th>状态</th><th>档</th><th>waitReason</th><th>写门（projectBusy）</th><th>读档占位（readOccupants）</th><th>位次</th><th>已等待（只取 waitedSince）</th><th>在等谁</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(10, "（无非终态节点）") : rows.join("")}</tbody></table>`;
  }
  return `${head}\n${tasks}\n${traceHtml}`;
}

// ---------------------------------------------------------------------------
// 任务视图（复用 GET /api/tasks，project 必填）
// ---------------------------------------------------------------------------

export function renderTasksPick(projects: ProjectsView | null, pickError: string | null): string {
  const list =
    projects !== null
      ? projects.machines
          .flatMap((m) => m.projects.map((p) => p.projectId))
          .sort()
          .map((pid) => `<li><a class="fl" href="/tasks?project=${encodeURIComponent(pid)}">${escapeHtml(pid)}</a></li>`)
          .join("")
      : "";
  const err =
    pickError !== null
      ? `<p class="hint err">项目清单读取失败：${escapeHtml(pickError)}（不影响手工输入项目名查询）</p>`
      : "";
  return `<h2>任务视图</h2>
${err}
<p class="hint">桥 <code>GET /api/tasks</code> 以 <code>project</code> 为必填参数 ⇒ 先选/输项目。</p>
<form method="get" action="/tasks"><label>projectId <input name="project" placeholder="项目 id"></label><button type="submit">查询</button></form>
${list === "" ? "" : `<p class="hint">当前快照中的项目：</p><ul>${list}</ul>`}`;
}

export function renderTasks(view: ProjectTasksView): string {
  const rows = view.tasks.map((t) => {
    return (
      "<tr>" +
      `<td class="mono">${escapeHtml(shortId(t.taskId))}</td>` +
      `<td class="mono">${escapeHtml(shortId(t.contextId ?? ""))}</td>` +
      `<td>${escapeHtml(label(TASK_STATE_LABELS, t.state))}</td>` +
      `<td>${t.stale ? '<span class="warn">stale</span>' : "—"}</td>` +
      `<td>${escapeHtml(stamp(t.updatedAt))}</td>` +
      `<td>${escapeHtml(t.prompt === null ? "—" : truncate(t.prompt, 80))}</td>` +
      "</tr>"
    );
  });
  const reach = view.reachable
    ? ""
    : `<p class="hint err">项目 ${escapeHtml(view.projectId)} 当前不可达${view.notice !== null ? `：${escapeHtml(view.notice)}` : ""}</p>`;
  return `<h2>任务 · 项目 <span class="mono">${escapeHtml(view.projectId)}</span></h2>
<p class="hint"><a class="fl" href="/tasks">换项目</a> · 共 ${view.tasks.length} 条</p>
${reach}
<table><thead><tr><th>taskId</th><th>contextId</th><th>状态</th><th>stale</th><th>更新</th><th>prompt 摘要</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(6, "（无任务）") : rows.join("")}</tbody></table>
<p class="hint">${escapeHtml(INFLIGHT_CALIBRATION_NOTE)}</p>`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// 项目 / 机器视图（复用 GET /api/projects）
// ---------------------------------------------------------------------------

export function renderProjects(view: ProjectsView): string {
  const rows: string[] = [];
  for (const m of view.machines) {
    if (m.error !== null) {
      rows.push(
        `<tr class="warn"><td>${escapeHtml(m.machineId)}</td><td colspan="5">机器不可达：${escapeHtml(m.error)}</td></tr>`,
      );
    }
    for (const p of m.projects) {
      rows.push(
        "<tr>" +
          `<td>${escapeHtml(m.machineId)}</td>` +
          `<td><a class="fl" href="/tasks?project=${encodeURIComponent(p.projectId)}">${escapeHtml(p.projectId)}</a></td>` +
          `<td>${escapeHtml(p.agentKind ?? "—")}</td>` +
          `<td>${p.a2aPort === null ? "—" : p.a2aPort}</td>` +
          `<td>${escapeHtml(p.status ?? "—")}</td>` +
          `<td>${escapeHtml(p.startedAt ?? "—")}` +
          "</tr>",
      );
    }
  }
  const runners = view.runners
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.machineId)}</td><td>${r.online ? "在线" : "离线"}</td><td>${escapeHtml(r.lastHeartbeatAt ?? "—")}</td></tr>`,
    )
    .join("");
  const snapshot = `<p class="hint">${escapeHtml(view.note ?? "快照语义（非实时在线）")}${view.observedAt !== null ? ` · 观测时间 <span class="mono">${escapeHtml(view.observedAt)}</span>` : ""}</p>`;
  return `<h2>项目 / 机器</h2>
${snapshot}
<table><thead><tr><th>machineId</th><th>projectId</th><th>agentKind</th><th>a2aPort</th><th>status</th><th>startedAt</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(6, "（无项目）") : rows.join("")}</tbody></table>
<h2>Runner 注册面</h2>
<table><thead><tr><th>machineId</th><th>online</th><th>lastHeartbeatAt</th></tr></thead>
<tbody>${runners === "" ? emptyRow(3, "（无 runner）") : runners}</tbody></table>
<p class="hint">${escapeHtml(INFLIGHT_CALIBRATION_NOTE)}</p>`;
}

// ---------------------------------------------------------------------------
// 触发一轮（BD8 · 宿主桥写控件；同源 POST，服务器端渲染）
// ---------------------------------------------------------------------------

/**
 * 需求详情页上的「触发一轮」表单：`POST /features/:id/turn`。
 * 表单只有一个提交按钮，无字段；澄清回答入口见 {@link renderAnswerForm}（BD9）。
 *
 * **收口轨 14 ②**：`busy`（该需求已有在飞 / 排队轮）⇒ 按钮渲染为 disabled + 原因
 * （规则源 = {@link deriveTurnBusyAffordance}；服务端另有 409 `board_turn_busy` 硬闸）。
 * **收口轨 17**：`featureState` 为引擎终态 ⇒ 同样 disabled + 原因，且**优先于**占用判据
 * （规则源 = {@link deriveTerminalFeatureAffordance}；服务端 409 `board_feature_terminal` 兜底直调）。
 */
export function renderTurnForm(
  featureId: string,
  busy: OccupantTurnView | null = null,
  featureState: string | null = null,
): string {
  const a =
    deriveTerminalFeatureAffordance(featureState) ??
    deriveTurnBusyAffordance(busy) ?? { enabled: true, note: "" };
  const button = a.enabled
    ? `<button type="submit">触发一轮</button>`
    : `<button type="submit" disabled aria-disabled="true">触发一轮</button>`;
  const reasonLine = a.enabled ? "" : `<p class="hint warn">${escapeHtml(a.note)}</p>`;
  return `<h2>宿主轮</h2>
<p class="hint">触发一轮 = 板按该需求的<b>归属组织</b>起（或复用）宿主桥，以<b>本需求 id 对应的 contextId</b> 发一轮提示词；板的推进只是「投消息给 agent」，<b>状态机仍由 agent 经 MCP 走</b>。同组织一时刻只跑一轮 ⇒ 被占用时本轮排队。</p>
${reasonLine}<form method="post" action="/features/${encodeURIComponent(featureId)}/turn" class="w" data-submit="已提交，本轮可能跑数分钟…">
${button}
</form>`;
}

/**
 * 需求详情页上的「人工确认」表单：`POST /features/:id/confirm`（BD9）。
 * **文案必须诚实**：按钮 = 给宿主 agent 的一轮<b>指令消息</b>，不是板上批准；
 * 放不放行由 agent 核对后判断（条件不满足它会拒绝放行并回报原因）。
 *
 * **BD18：按钮按 `approval` 条件化** —— 仅「待审批」可点；其余档位**禁用/灰态 + 一行原因**
 * （刻意不隐藏：看不到入口更迷惑）。规则源 = {@link deriveConfirmAffordance}。
 * **收口轨 14 ②：再叠加轮状态判据** —— 该需求已有在飞 / 排队轮时同样禁用（占用原因优先展示，
 * 因为它直接对应「点了会白点」）。端点语义不变（板不写状态机；禁用只是可用性层，
 * 服务端防重由 `board_turn_busy` 409 承担）。
 * **收口轨 17**：引擎终态判据**优先于**占用与 approval —— 终态需求两按钮一律 disabled + 原因
 * （规则源 = {@link deriveTerminalFeatureAffordance}，与引导行、服务端 409 同一判据）。
 */
export function renderConfirmForm(
  featureId: string,
  approval: string | null,
  busy: OccupantTurnView | null = null,
  featureState: string | null = null,
): string {
  const busyA = deriveTurnBusyAffordance(busy);
  const a: ConfirmAffordance =
    deriveTerminalFeatureAffordance(featureState) ?? busyA ?? deriveConfirmAffordance(approval);
  const button = a.enabled
    ? `<button type="submit">发送确认指令给 agent（由 agent 核对后决定是否放行）</button>`
    : `<button type="submit" disabled aria-disabled="true">发送确认指令给 agent（由 agent 核对后决定是否放行）</button>`;
  const stateLine = `<p class="hint${a.enabled ? "" : " warn"}">${escapeHtml(a.note)}</p>`;
  return `<h2>人工确认（给 agent 的指令）</h2>
${stateLine}
<p class="hint">点击 = 板把「用户已确认改造文档，请核对后执行放行（approve 语义）」作为<b>一轮消息投给该需求的宿主 agent</b>。<b>板不写引擎状态机，不存在「板上批准」</b>：agent 会先只读核对（改造文档是否落文件、审批门是否处于「待审批」），条件不满足（例如 approval 非「待审批」）时它<b>有权不放行</b>并在本轮结论里说明缺什么 —— 结果如实回显。同组织一时刻只跑一轮 ⇒ 被占用时排队。</p>
<form method="post" action="/features/${encodeURIComponent(featureId)}/confirm" class="w" data-submit="已提交，处理中…">
${button}
</form>`;
}

/**
 * 详情页「下一步」引导行（BD18 ②）：一行可操作提示，判序与文案规则见
 * {@link deriveNextStepHint}。放在正文按钮区之前，让用户先看到"该点哪个"。
 */
export function renderNextStepGuide(input: NextStepInput): string {
  return `<p class="hint nextstep">${escapeHtml(deriveNextStepHint(input))}</p>`;
}

/**
 * 需求详情页上的「澄清回答」表单：`POST /features/:id/answer`（BD9）。
 * **仅在存在 `awaiting_answer` 轮时渲染**（调用方判据 = {@link BoardHostFace.awaitingTurnOf}）；
 * 回答将以同一 `contextId` 续接该需求的宿主会话（澄清续推口径）。
 */
export function renderAnswerForm(featureId: string, question: string | null): string {
  const q = question === null || question.trim() === ""
    ? ""
    : `<pre class="result">${escapeHtml(question)}</pre>`;
  return `<h2>回答待澄清的问题</h2>
${q}<p class="hint">回答将<b>续接同一 contextId</b>（同一逻辑任务的澄清续推复用会话），提交后本轮结果如实回显。</p>
<form method="post" action="/features/${encodeURIComponent(featureId)}/answer" class="w" data-submit="已提交，回答续推中…">
<textarea name="answer" rows="4" cols="60" required placeholder="输入回答"></textarea>
<button type="submit">发送回答</button>
</form>`;
}

/**
 * 触发一轮的结果页正文（BD8）：**终态 + display 如实显示**。
 * `awaiting_answer` 由 BD4b 的 display 承载「需要你回答」（**不是失败**）；
 * `queued` 显示「排队中」并指向状态页（本节点不等排队轮的终态）。
 */
export function renderTurnOutcome(o: TriggerTurnOutcome): string {
  const bad =
    o.disposition === "bridge_down" ||
    o.disposition === "turn_failed" ||
    o.disposition === "timeout" ||
    o.disposition === "not_awaiting" ||
    o.disposition === "busy" ||
    o.disposition === "terminal" ||
    o.disposition === "config_error";
  const hintClass = bad ? "hint err" : "hint";
  const rows = [
    ["组织", o.org],
    ["需求", o.featureId],
    ["轮次", o.turnId ?? "—"],
    ["contextId", o.contextId ?? "—"],
    ["第几轮", o.round === null ? "—" : `第 ${String(o.round)} 轮`],
    ["轮态", o.state ?? "—"],
    ["结局", o.disposition],
    ["桥 pid:port", o.bridge === null ? "—" : `${String(o.bridge.pid)}:${String(o.bridge.port)}（${o.bridge.kind}）`],
  ]
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td class="mono">${escapeHtml(v)}</td></tr>`)
    .join("");
  const summary =
    o.summary !== null ? `<h2>本轮产出（摘要）</h2><pre class="result">${escapeHtml(o.summary)}</pre>` : "";
  const question =
    o.question !== null
      ? `<h2>要你回答的问题</h2><pre class="result">${escapeHtml(o.question)}</pre>`
      : "";
  const error =
    o.error !== null
      ? `<p class="hint err">错误码 <code>${escapeHtml(o.error.code)}</code>：${escapeHtml(o.error.message)}</p>`
      : "";
  const note =
    o.disposition === "awaiting_answer"
      ? `<p class="hint">「需要你回答」= 后端按 A2A 的 <code>input-required</code> 收口，<b>不是失败</b>；回答入口 = 需求详情页下方的「回答待澄清的问题」表单（同 contextId 续推）。本轮记录已落板侧台账。</p>`
      : o.disposition === "not_awaiting"
        ? `<p class="hint">回答入口只服务<b>当前待澄清的一轮</b>：该需求现在没有 <code>awaiting_answer</code> 的轮 ⇒ 本次回答<b>未投递</b>（结构化 409），板不会把答案投进一个不在澄清中的会话。</p>`
        : o.disposition === "busy"
          ? `<p class="hint">该需求已有<b>在飞或排队</b>的一轮 ⇒ 本次提交<b>未入队</b>（结构化 409 <code>board_turn_busy</code>，防连点重复烧一轮）；等上一轮结束后可到<a class="fl" href="/host">宿主桥状态</a>页确认队列。</p>`
          : o.disposition === "terminal"
            ? `<p class="hint">该需求已进入<b>引擎终态</b>（completed / failed / cancelled）⇒ 本次提交<b>未投递</b>（结构化 409 <code>board_feature_terminal</code>，防 API 直调为已结束的需求白烧一轮）；如需继续请重新提需求。</p>`
            : o.disposition === "queued"
          ? `<p class="hint">本轮<b>排队中</b>（同组织一时刻只跑一轮）⇒ 本响应未等它的终态；到<a class="fl" href="/host">宿主桥状态</a>页刷新可看队列。本轮记录已落板侧台账。</p>`
          : `<p class="hint">本轮终态与摘要已落板侧台账，板<b>不写引擎状态机</b>（审批 / 推进 / 取消归编排 agent）。</p>`;
  const back = `<p class="hint"><a class="fl" href="/features/${encodeURIComponent(o.featureId)}">回到需求详情</a> · <a class="fl" href="/host">宿主桥状态</a></p>`;
  return `<h2>${escapeHtml(o.display === "" ? `触发一轮：${o.disposition}` : o.display)}</h2>
<p class="${hintClass}">结局 = <code>${escapeHtml(o.disposition)}</code>${o.queued ? " · 未开跑（排队）" : ""}</p>
${error}
${question}
${summary}
<table><tbody>${rows}</tbody></table>
${note}
${back}`;
}

/** 停桥结果横幅（同页显示；失败如实带错误码，不伪装成「已停」）。 */
export function renderHostNotice(o: StopBridgeOutcome): string {
  return o.ok
    ? `已停桥：${o.org} · ${o.display}`
    : `停桥未成功（${o.error?.code ?? "unknown"}）：${o.error?.message ?? o.display}`;
}

// ---------------------------------------------------------------------------
// 宿主桥状态页（BD8 · 故障可见是本页重点）
// ---------------------------------------------------------------------------

/** 宿主桥五态中文（**仅展示层**；未命中原样显示，不吞不猜）。 */
const HOST_STATE_LABELS: Readonly<Record<string, string>> = {
  running: "在线",
  starting: "启动中",
  unreachable: "进程在但连不上",
  exited: "进程已消失",
  failed: "起不来",
};

function hostStateCell(state: string): string {
  const label = Object.prototype.hasOwnProperty.call(HOST_STATE_LABELS, state)
    ? `${HOST_STATE_LABELS[state]}（${state}）`
    : state;
  const cls = state === "running" || state === "starting" ? "" : ' class="warn"';
  return `<td${cls}>${escapeHtml(label)}</td>`;
}

function dash(v: string | number | null | undefined): string {
  return v === null || v === undefined || v === "" ? "—" : String(v);
}

export interface HostPageInput {
  entries: HostStatusEntry[];
  config: { orgsDir: string | null; defaultOrg: string | null; kind: string };
  /** 最近一次写面动作的回显（触发结果 / 停桥结果），无 ⇒ null。 */
  notice: string | null;
  /**
   * 组织目录根的不可用结论（BD14）：非空 ⇒ 本页顶部出**根因**条，
   * 不得只留一句「未托管任何宿主桥」让人去猜是桥坏还是目录没建。
   */
  orgsDirProblem?: { code: string; message: string } | null;
}

/**
 * `GET /host`：逐组织一行桥状态（五态 + 结构化 error + pid/port/kind/起停时刻）
 * 外加该组织的轮队列。**故障可见是本页重点** —— 断链组织必须落 `.warn` 行 +
 * 「宿主桥已断」文案 + 原始错误码，**不得静默、不得假数据**。
 */
export function renderHostPage(input: HostPageInput): string {
  const cfg = input.config;
  const cfgLine = `<p class="hint">组织目录根 = <code>${escapeHtml(cfg.orgsDir ?? "（未配置 ⇒ 触发一轮将结构化 503）")}</code> · 默认组织 = <code>${escapeHtml(cfg.defaultOrg ?? "（未配置 ⇒ 组织名由提需求表单给出）")}</code> · 缺省 kind = <code>${escapeHtml(cfg.kind)}</code></p>`;
  const problem = input.orgsDirProblem ?? null;
  const problemLine =
    problem === null
      ? ""
      : `<p class="hint err"><code>${escapeHtml(problem.code)}</code> ${escapeHtml(problem.message)}</p>`;
  const notice =
    input.notice === null ? "" : `<p class="hint">${escapeHtml(input.notice)}</p>`;
  if (input.entries.length === 0) {
    return `<h2>宿主桥</h2>
${cfgLine}
${problemLine}
${notice}
<p class="hint">当前进程未托管任何宿主桥 ⇒ 无状态可显示（本页面<b>不编造数据</b>）。到需求详情页「触发一轮」即会按组织起桥。</p>`;
  }
  const rows = input.entries.map((e) => {
    const s = e.status;
    const down = s.state === "unreachable" || s.state === "exited" || s.state === "failed";
    const errCell =
      s.error === null
        ? "—"
        : `<span class="err">${escapeHtml(s.error.code)}</span> ${escapeHtml(s.error.message)}`;
    const waiting = e.queue.waiting
      .map((w) => `${escapeHtml(w.requirementId)} <span class="muted">${escapeHtml(w.turnId)}</span>`)
      .join("、");
    const runningTurn =
      e.queue.running === null
        ? "—"
        : `在飞：<code>${escapeHtml(e.queue.running.requirementId)}</code> <span class="muted">${escapeHtml(e.queue.running.turnId)}</span>`;
    const idle = s.idleMs === null ? "—" : `${String(Math.floor(s.idleMs / 1000))}s`;
    const stopForm = `<form method="post" action="/host/${encodeURIComponent(s.org)}/stop" data-submit="已提交，停桥中…"><button type="submit">停桥</button></form>`;
    return (
      `<tr${down ? ' class="warn"' : ""}>` +
      `<td>${escapeHtml(s.org)}</td>` +
      hostStateCell(s.state) +
      `<td>${escapeHtml(s.display)}</td>` +
      `<td class="mono">${dash(s.pid)}</td>` +
      `<td class="mono">${dash(s.port)}</td>` +
      `<td>${escapeHtml(s.kind)}</td>` +
      `<td>${dash(s.inFlightRounds)} / 阈值 ${escapeHtml(s.idleStopMs === 0 ? "常驻" : `${String(Math.round(s.idleStopMs / 1000))}s`)}</td>` +
      `<td>${escapeHtml(stamp(s.startedAt))} / ${escapeHtml(stamp(s.lastActivityAt))} / ${escapeHtml(idle)}</td>` +
      `<td>${runningTurn}${waiting === "" ? "" : `<br>排队（${String(e.queue.waiting.length)}）：${waiting}`}</td>` +
      `<td>${errCell}</td>` +
      `<td>${stopForm}</td>` +
      "</tr>"
    );
  });
  return `<h2>宿主桥</h2>
${cfgLine}
${problemLine}
${notice}
<p class="hint">状态取 BD4a 的五态闭集（<code>running / starting / unreachable / exited / failed</code>）· 队列取 BD4b 的闸位视图（<b>容量恒 1</b>：同组织一时刻只跑一轮）· 后端 CLI 一律 <b>SIGTERM 后超时树杀</b>（桥 + 后端两级）。</p>
<table><thead><tr><th>组织</th><th>状态</th><th>显示文案</th><th>pid</th><th>port</th><th>kind</th><th>在飞轮 / 回收</th><th>起 / 末次活动 / 空闲</th><th>轮队列</th><th>结构化错误</th><th>动作</th></tr></thead>
<tbody>${rows.join("")}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// 口径脚注（每个数据页统一挂）
// ---------------------------------------------------------------------------

export const VIEW_NOTES: readonly string[] = [...B13_CALIBRATION_NOTES, PARALLELISM_NOTE];
