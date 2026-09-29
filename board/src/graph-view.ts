/**
 * 依赖图视图（v0.9.3 T2 · REQ-v0.9.3-2026-09-26-02）：详情页「依赖图」区块。
 *
 * 单需求 DAG：`tasks[].dependencies`（bridge-client 已收，值域非闭 ⇒ 原样消费）→
 * mermaid flowchart 源生成 → 经 `docs-render.mermaidBlockData` 的
 * `<script type="application/json">` 数据通道注入（**非可执行脚本、不入 n3 闭集**），
 * 渲染复用 vendored mermaid 与既有渲染脚本（`mermaidRenderScript` 按 `.mermaid-block[data-src]`
 * 通用扫描，本区块零新 JS）。
 *
 * 边界（改造文档 §2-T2 冻结）：
 * - 跨需求依赖边**不做**（引擎无数据）——依赖指向本需求任务集之外的 id 即丢弃 + 提示行如实标注；
 * - 环防御：引擎正常态无环（DAG 校验），脏数据可出现 —— mermaid 遇环整图不渲染，故成环边不画、
 *   提示行列出；判据 = 反向 Kahn 收敛后残留边 ⇔ 该边处于环上（充分必要）；
 * - 未知任务态 ⇒ 中性色 + 原样态名（不吞不猜，同 views `label()` 口径）。
 *
 * **v0.9.3 增补轨 III N1（节点可读化）**：节点标签 = `project 标识` + `任务要点`（prompt
 * 首行截断换行，数据源 = `/api/features/:id` 出参 tasks[].prompt 既有字段；缺键 ⇒ 回退裸
 * taskId）+ taskId 短标（次要）+ 状态中文；全量 taskId 与 prompt 原文进节点 hover title。
 * 只改 mermaid 源文本的节点标签生成，渲染链 / 数据通道 / 选择器不动（增补轨 II 已验）。
 *
 * **v0.9.3 增补轨 II N1（第二轮修复的真根因）**：mermaid 11 flowchart 的**节点位不接受带引号
 * 字符串**（`"id"["label"]` / `style "id" …` / `"a" --> "b"` 一律 Parse error `got 'STR'`，
 * 经 vendored 11.17.2 headless `mermaid.parse` 实证）⇒ 首轮生成的引用式 id 整图解析失败、
 * 走「保留源文本」降级 = 用户所见「不渲染」。本轮：节点 id 改**裸标识符**（`n_` 前缀避
 * 保留字 `end`、非法字符净化）；标签经 escapeHtml 后入引号位（`"`/`<` 不再劈裂引号）。
 * 换行只用 `<br/>`，**不用裸换行** —— 引号位字符串跨行未经 vendored parse 实证。
 */
import type { FeatureTaskItem } from "./bridge-client.js";
import { mermaidBlockData } from "./docs-render.js";
import { escapeHtml } from "./web/layout.js";

/** 任务态中文（展示层；与 views 任务表同词表）。 */
export const TASK_STATE_LABELS: Readonly<Record<string, string>> = {
  working: "执行中",
  completed: "已完成",
  failed: "失败",
  "input-required": "待澄清",
  blocked: "已阻塞",
};

/** 状态色（mermaid `style` 指令 + 图例色块共用这一处事实源）。 */
export const TASK_STATE_COLORS: Readonly<Record<string, string>> = {
  completed: "#dafbe1",
  working: "#e3eef7",
  failed: "#ffe7e6",
  "input-required": "#fff4ce",
  blocked: "#f3e5d0",
};

export const NEUTRAL_TASK_COLOR = "#f2f3f5";

/** 与 views.ts `shortId` 同口径的节点短标。 */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * mermaid 节点 id（**裸标识符**，N1 二轮根因修复）：`n_` 前缀避开保留字 `end` 与数字开头
 * 的歧义；taskId 值域非闭 ⇒ 非 `[A-Za-z0-9_-]` 字符净化为 `_`
 * （纯展示层映射，同 `shortId` 截断一样不改账面 id）。
 */
function mermaidNodeId(id: string): string {
  return "n_" + id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** 任务要点总量预算（字符，约 40；超预算截断加省略号）。 */
export const TASK_SUMMARY_MAX_CHARS = 40;
/** 任务要点单行宽度（首行了内按词界换行，词界不可得时按字符断）。 */
export const TASK_SUMMARY_LINE_CHARS = 20;

function normalizeWs(s: string): string {
  return s.replace(/[\r\n\t\u000b\f\u2028\u2029]+/g, " ").replace(/ +/g, " ").trim();
}

/**
 * prompt 片段 → 任务要点行（取**首行**起，≤2 行 / 总量 ≤{@link TASK_SUMMARY_MAX_CHARS} 字符，
 * 超预算以 `…` 截断；换行是消息分段的权威边界，故不拼接第二行）。单行内制表符 / 连续空格归一
 * 为单空格 —— 换行只由 `<br/>` 承载，源文本不出裸换行。返回**未转义**文本，转义在标签拼装处统一做。
 * 空 / 全空白 / 缺键 ⇒ null（调用方回退裸 taskId）。
 */
export function taskSummaryLines(prompt: string | null | undefined): string[] | null {
  if (!prompt) return null;
  const firstLine = prompt.split(/[\r\n\u2028\u2029]/, 1)[0]?.replace(/[\t\f\u000b]+/g, " ").replace(/ +/g, " ").trim();
  if (!firstLine) return null;
  const budget = TASK_SUMMARY_MAX_CHARS;
  const width = TASK_SUMMARY_LINE_CHARS;
  const lines: string[] = [];
  let rest = firstLine;
  while (lines.length < 2) {
    if (rest.length <= width) {
      lines.push(rest);
      return lines;
    }
    if (lines.length === 1) {
      // 第二行越宽 ⇒ 预算内硬截断（无第三行可续）
      const room = Math.max(1, budget - (lines[0]?.length ?? 0) - 1);
      lines.push(rest.slice(0, room) + "…");
      return lines;
    }
    let cut = -1;
    for (let i = width; i > 0; i -= 1) {
      if (rest[i] === " ") {
        cut = i;
        break;
      }
    }
    if (cut <= 0) {
      // 词界不可得（连续非空白串 / CJK 无空格）⇒ 按字符断行
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    } else {
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut + 1);
    }
  }
  return lines;
}

export interface TaskGraph {
  /** 图节点 = 任务全集（含孤立节点），按 taskId 升序、id 去重。 */
  readonly nodes: readonly FeatureTaskItem[];
  /** 可画的依赖边（依赖项 → 依赖者），定序去重。 */
  readonly edges: readonly { from: string; to: string }[];
  /** 依赖了本需求任务集之外 id 而被丢弃的边（跨需求依赖：首版不画，如实标注）。 */
  readonly dangling: readonly { from: string; dep: string }[];
  /** 成环而被丢弃的边（引擎正常态为空；出现即脏数据）。 */
  readonly cycleEdges: readonly { from: string; to: string }[];
}

const edgeKey = (e: { from: string; to: string }): string => `${e.from}\u0000${e.to}`;

/**
 * 从任务清单构图（纯函数）。边方向 = 依赖项 → 依赖者（`flowchart LR` 下左到右即执行序）。
 * 悬空边直接丢弃；环判定用**反向 Kahn**：从「无人依赖」的终点沿前驱收敛，
 * 未发出边 ⇔ 其终点未收敛 ⇔ 终点在环上 ⇔ 该边是环边。
 */
export function buildTaskGraph(tasks: readonly FeatureTaskItem[]): TaskGraph {
  const byId = new Map<string, FeatureTaskItem>();
  for (const t of tasks) if (!byId.has(t.taskId)) byId.set(t.taskId, t);
  const nodes = [...byId.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : 1));

  const dangling: { from: string; dep: string }[] = [];
  const seenEdge = new Set<string>();
  const candidates: { from: string; to: string }[] = [];
  for (const n of nodes) {
    for (const dep of n.dependencies ?? []) {
      if (!byId.has(dep)) {
        dangling.push({ from: n.taskId, dep });
        continue;
      }
      const e = { from: dep, to: n.taskId };
      const k = edgeKey(e);
      if (!seenEdge.has(k)) {
        seenEdge.add(k);
        candidates.push(e);
      }
    }
  }
  candidates.sort((a, b) => (edgeKey(a) < edgeKey(b) ? -1 : 1));

  // out[n] = n 尚未收敛的后继数；preds[t] = t 的前驱集
  const out = new Map<string, number>();
  const preds = new Map<string, string[]>();
  for (const e of candidates) {
    out.set(e.from, (out.get(e.from) ?? 0) + 1);
    preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
  }
  const converged = new Set<string>();
  const stack = nodes.filter((n) => (out.get(n.taskId) ?? 0) === 0).map((n) => n.taskId);
  const emitted = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (converged.has(id)) continue;
    converged.add(id);
    for (const p of preds.get(id) ?? []) {
      emitted.add(`${p}\u0000${id}`);
      const left = (out.get(p) ?? 0) - 1;
      out.set(p, left);
      if (left === 0) stack.push(p);
    }
  }
  const edges = candidates.filter((e) => emitted.has(edgeKey(e)));
  const cycleEdges = candidates.filter((e) => !emitted.has(edgeKey(e)));
  dangling.sort((a, b) => (`${a.from}\u0000${a.dep}` < `${b.from}\u0000${b.dep}` ? -1 : 1));
  return { nodes, edges, dangling, cycleEdges };
}

/**
 * 构图 → mermaid flowchart 源（节点 = project 标识 + 任务要点 + taskId 短标 + 状态中文，
 * 全量 taskId / prompt 原文进 hover title；状态色 style）。
 * 空任务集 ⇒ null（区块退化为提示行，不出空图）。
 */
export function taskGraphMermaidSource(graph: TaskGraph): string | null {
  if (graph.nodes.length === 0) return null;
  const lines: string[] = ["flowchart LR"];
  for (const n of graph.nodes) {
    const mid = mermaidNodeId(n.taskId);
    const summary = taskSummaryLines(n.prompt);
    // 有要点：project + 要点（≤2 行）+ taskId 短标（次要）+ 状态；无要点（prompt 缺键）：
    // project + 裸 taskId（本身即次要行，不再叠短标）+ 状态
    const labelParts = summary
      ? [escapeHtml(n.projectId), ...summary.map((l) => escapeHtml(l)), escapeHtml(shortId(n.taskId))]
      : [escapeHtml(n.projectId), escapeHtml(n.taskId)];
    labelParts.push(escapeHtml(TASK_STATE_LABELS[n.state] ?? n.state));
    const label = labelParts.join("<br/>");
    // tip 只在有要点时出（承载全量 taskId + prompt 原文）；回退形态标签已含全量 id，不出冗余 tip
    const tip = summary ? `@{"tip":"${escapeHtml(`${n.taskId} · ${normalizeWs(n.prompt as string)}`)}"}` : "";
    const color = TASK_STATE_COLORS[n.state] ?? NEUTRAL_TASK_COLOR;
    lines.push(`  ${mid}["${label}"]${tip}`);
    lines.push(`  style ${mid} fill:${color},stroke:#8886`);
  }
  for (const e of graph.edges) {
    lines.push(`  ${mermaidNodeId(e.from)} --> ${mermaidNodeId(e.to)}`);
  }
  return lines.join("\n");
}

/** 依赖图区块渲染出口：正文 HTML + 是否需要 mermaid 脚本（页面据此挂资产引用与渲染脚本）。 */
export interface DependencyGraphSection {
  readonly html: string;
  readonly needsMermaid: boolean;
}

/**
 * 详情页「依赖图」区块（`tasks` = 详情出参任务清单）。
 * **v0.9.5 C2 空区块短路③**：无任务 ⇒ 整节不渲染（空图与「（无任务，暂无依赖图）」一行同样零信息量，
 * Step 0 卡上纯属噪声；与任务表 / trace 的短路同一判据）。有任务 ⇒ 标题 + 图例 + mermaid 块
 * （application/json 数据通道）+ 悬空/环边提示行。`idSeq` = 页内序号（数据通道载体 id 后缀，详情页固定 1）。
 */
export function renderDependencyGraphSection(
  tasks: readonly FeatureTaskItem[],
  idSeq: number = 1,
): DependencyGraphSection {
  if (tasks.length === 0) {
    return { html: "", needsMermaid: false };
  }
  const graph = buildTaskGraph(tasks);
  const src = taskGraphMermaidSource(graph);
  if (src === null) return { html: "", needsMermaid: false };
  const states = [...new Set(graph.nodes.map((n) => n.state))].sort();
  const legend = states
    .map((s) => {
      const color = TASK_STATE_COLORS[s] ?? NEUTRAL_TASK_COLOR;
      return `<span class="dg-legend"><i style="background:${color}"></i>${escapeHtml(TASK_STATE_LABELS[s] ?? s)}</span>`;
    })
    .join(" ");
  const notes: string[] = [];
  if (graph.cycleEdges.length > 0) {
    notes.push(
      `环防御：${graph.cycleEdges.length} 条成环依赖边未画（引擎正常态无环，出现即脏数据）：${escapeHtml(
        graph.cycleEdges.map((e) => `${shortId(e.from)} → ${shortId(e.to)}`).join("、"),
      )}`,
    );
  }
  if (graph.dangling.length > 0) {
    notes.push(
      `跨需求/未登记依赖 ${graph.dangling.length} 条不画（引擎无跨需求数据，首版边界）：${escapeHtml(
        graph.dangling.map((e) => `${shortId(e.from)} ⇢ ${shortId(e.dep)}`).join("、"),
      )}`,
    );
  }
  const html =
    `<h2>依赖图（${graph.nodes.length} 节点 · ${graph.edges.length} 边）</h2>\n` +
    `<p class="hint dg-legend-row">${legend}</p>\n` +
    (notes.length > 0 ? `<p class="hint warn">${notes.join(" · ")}</p>\n` : "") +
    `<div class="dep-graph">${mermaidBlockData(`dep-graph-src-${idSeq}`, src)}</div>`;
  return { html, needsMermaid: true };
}
