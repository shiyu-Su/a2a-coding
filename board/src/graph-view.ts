/**
 * 依赖图视图（v0.9.3 T2 · REQ-v0.9.3-2026-09-26-02）：详情页「依赖图」区块。
 *
 * **渲染形态 = 管道制自绘 DOM/CSS（零 script 标签）**（v0.10.3 N2b 落地，见文件末「N2b」段）。
 * 构图纯函数（`buildTaskGraph` / 环防御 / 悬空丢弃）与要点纯函数照旧沿用。
 *
 * **v0.10.3 N2c 摘除 mermaid 出口**（改造文档 §2-8「mermaid 摘除 · 只摘详情页」）：本文件不再产出
 * mermaid 源文本、不再 import `docs-render.mermaidBlockData`，出参也不再声明是否需要 mermaid 脚本。
 * **文档页的 mermaid 资产面与本视图无关** —— `schedulePageScripts`（排期页浮层补渲）、
 * `mermaidBlockData`、V1 清洗管线、vendored `mermaid.min.js` 全部零改动。
 *
 * 摘除理由（历史根因，增补轨 I–III 三轮的结论）：mermaid 11 flowchart 的**节点位不接受带引号
 * 字符串**（`"id"["label"]` / `style "id" …` / `"a" --> "b"` 一律 Parse error `got 'STR'`，经
 * vendored 11.17.2 headless `mermaid.parse` 实证）⇒ 脏 prompt 入标签位会整图不渲染、走「保留源
 * 文本」降级 = 用户所见「不渲染」；且 mermaid 承载不了管道制（无泳道原语 / tip 死键 / 闭集挡死交互）。
 *
 * 边界（改造文档 §2-T2 冻结）：
 * - 跨需求依赖边**不做**（引擎无数据）——依赖指向本需求任务集之外的 id 即丢弃 + 提示行如实标注；
 * - 环防御：引擎正常态无环（DAG 校验），脏数据可出现 —— 成环边不画、提示行列出；
 *   判据 = 反向 Kahn 收敛后残留边 ⇔ 该边处于环上（充分必要）；
 * - 未知任务态 ⇒ 中性色 + 原样态名（不吞不猜，同 views `label()` 口径）。
 *
 * **v0.9.3 增补轨 III N1（要点纯函数，本节点全部保留）**：{@link taskSummaryLines} = prompt 首行
 * 截断换行（数据源 = `/api/features/:id` 出参 tasks[].prompt 既有字段；空 / 缺键 ⇒ null ⇒ 调用方
 * 回退裸 taskId），预算与行宽见 {@link TASK_SUMMARY_MAX_CHARS} / {@link TASK_SUMMARY_LINE_CHARS}；
 * 换行只用 `<br/>`，**不用裸换行**。自绘图形 HTML 内**不含 prompt 的任何子串**（负向锚 N-2），
 * 要点列的消费方 = 执行明细单表（N3）。
 *
 * **v0.10.3 N2a（构图与六态纯函数层）**：`TaskGraph` 之外新增**派生层** —— `groupPipelines`
 * （projectId 分组的有序管道）与 `buildGraphWithPipelines` wrapper（`buildTaskGraph` 本体、
 * 签名、排序**一行不改**）；`nodeStateOf` = 六态 + 一回落闭集（queueState 字面值以 N1 探针 /
 * 改造文档 §2 M-3 为准：`running / queued / settled`，**无 `claimed`、不得硬编码**）。
 * 本层不含任何 HTML / CSS（渲染 = N2b/N2c）。
 *
 * **v0.10.3 N2b（管道制自绘渲染）**：{@link renderDependencyGraphSection} 为**自绘 DOM/CSS**
 * —— 管道 = 每 project 一个原生 `<details class="pipe" open>`，节点 = 只标 `#编号` 的 chip
 * （全量 taskId / 状态 / 依赖原值进 `title`）；同管道相邻 chip 间插 `<span class="dg-arrow">→</span>`；
 * 跨管道依赖只出 chip 右上角标 `⇠#k`（≤{@link MAX_DEP_MARKS} 枚，超出折叠 `⇠+#m`）+ 图区底部一行
 * 边清单，**不画线**（体内零连线坐标层）。**图形 HTML 内不出现 prompt 的任何子串**（负向锚 N-2）；
 * **零 script 标签**（不入 n3 可执行内联闭集，也不出数据通道形态）。
 */
import type { FeatureTaskItem, TraceNode } from "./bridge-client.js";
import { escapeHtml } from "./web/layout.js";

/** 任务态中文（展示层；与 views 任务表同词表）。 */
export const TASK_STATE_LABELS: Readonly<Record<string, string>> = {
  working: "执行中",
  completed: "已完成",
  failed: "失败",
  "input-required": "待澄清",
  blocked: "已阻塞",
};

/** 状态色（图例色块的 inline `background` 与状态档配色共用这一处事实源；CSS 侧不新造色值）。 */
export const TASK_STATE_COLORS: Readonly<Record<string, string>> = {
  completed: "#dafbe1",
  working: "#e3eef7",
  failed: "#ffe7e6",
  "input-required": "#fff4ce",
  blocked: "#f3e5d0",
};

export const NEUTRAL_TASK_COLOR = "#f2f3f5";

/** 与 views.ts `shortId` 同口径的节点短标（提示行展示 id 用；chip 不展 id）。 */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** 任务要点总量预算（字符，约 40；超预算截断加省略号）。 */
export const TASK_SUMMARY_MAX_CHARS = 40;
/** 任务要点单行宽度（首行了内按词界换行，词界不可得时按字符断）。 */
export const TASK_SUMMARY_LINE_CHARS = 20;

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

/** 派发模板固定首行的壳（`【`U+3010 / `】`U+3011 / `·`U+00B7 逐字；`Step` 后段位数为变项）。 */
const TASK_HEAD_SHELL = /^【需求\s+\S+\s+\u00B7\s+Step\s+\S+\s+节点\s+([^】]*)】/;

/**
 * 派发消息「需求壳」→ 要点标签（v0.10.3 N3 · 改造文档 §2-5）。
 *
 * 识别形态 = `flow/spec/文档模板.md` §3 派发消息模板的固定首行
 * `【需求 {REQ-ID} · Step 2 节点 {标签}】`（`【`U+3010 / `】`U+3011 / `·`U+00B7 逐字对齐，
 * `Step` 后段位数为变项）⇒ 取 `{标签}`；**不匹配 ⇒ 原样回落该行**（绝不吞、绝不返回空串）。
 * 首行为空白时顺延到下一条非空行，避免「回落首行」正好落回空串把内容吞掉。
 *
 * **返回未转义文本**（先剥后转义，转义只在拼装处统一做）；null / 全空白 ⇒ null（同
 * {@link taskSummaryLines} 的调用方回退口径）。只服务执行明细的「要点」列，图形面零 prompt。
 * 派发侧结构化根治（池卡 `770de678`）落地后，本函数与其单测组一并摘除。
 */
export function taskDigest(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  const lines = prompt.split(/[\r\n\u2028\u2029]/);
  const head = lines.find((l) => l.trim() !== "")?.trim();
  if (!head) return null;
  const hit = TASK_HEAD_SHELL.exec(head);
  const label = hit?.[1]?.trim();
  if (hit !== null && label !== undefined && label !== "") return label;
  return head;
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
 * 任务编号单点（v0.10.3 N1）：taskId → 1..N 的**执行序编号**，由 `queuedAt` 升序派生。
 *
 * 确定性三连（每条都是可单测的字面行为，不依赖输入序）：
 * - `queuedAt` 升序 —— ISO 串字面序即可（与 `version-order` 无关，不引它）；
 * - `queuedAt` 为 null ⇒ **沉底**（不当 0、不当「最早」——缺时刻不等于最早时刻）；
 * - 同值 ⇒ 按 `taskId` 升序兜稳 ⇒ 同一入参重复调用逐键相等。
 * 去重口径同 {@link buildTaskGraph} 的 `byId`（首见即留）。纯展示层派生：不改账面 id、不回写任务。
 */
export function taskOrdinalMap(tasks: readonly FeatureTaskItem[]): Map<string, number> {
  const byId = new Map<string, FeatureTaskItem>();
  for (const t of tasks) if (!byId.has(t.taskId)) byId.set(t.taskId, t);
  const ordered = [...byId.values()].sort((a, b) => {
    if (a.queuedAt !== b.queuedAt) {
      if (a.queuedAt === null) return 1;
      if (b.queuedAt === null) return -1;
      return a.queuedAt < b.queuedAt ? -1 : 1;
    }
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
  const out = new Map<string, number>();
  ordered.forEach((t, i) => out.set(t.taskId, i + 1));
  return out;
}

// ---------------------------------------------------------------------------
// v0.10.3 N2a：管道构图（派生层，不动 buildTaskGraph 本体）+ 六态 + 一回落
// ---------------------------------------------------------------------------

/**
 * `queueState`「已认领」档字面值（N1 真机探针 / 改造文档 §2 M-3 定档：板内样本 =
 * `running / queued / settled`，**无 `claimed`** —— 不得硬编码它）。值域归桥：
 * 命中集之外的非空原值 ⇒ 回落 `unknown` 出「原样值」，不吞不猜。
 */
export const QUEUE_STATE_RUNNING: ReadonlySet<string> = new Set(["running"]);
/** `queueState`「排队（被挡）」档字面值（同上 M-3）。 */
export const QUEUE_STATE_QUEUED: ReadonlySet<string> = new Set(["queued"]);

/** 六态 + 一回落的闭集键（渲染层据此查展示词表；`ask` = input-required）。 */
export type NodeState = "done" | "running" | "queued" | "failed" | "frozen" | "ask" | "unknown";

/** {@link nodeStateOf} 出参：`key` 闭集 + `label` 展示词 + `waitReason`（仅 trace 兜底来的）。 */
export interface NodeStateInfo {
  readonly key: NodeState;
  /** 展示词（六档 + 回落「执行中（不可辨）」；未知原样值出「执行中(原样值)」延续不吞不猜）。 */
  readonly label: string;
  /** 排队格的被挡摘要入参（八值闭集原样透传，值域归桥）；非排队格 / 无 ⇒ null。 */
  readonly waitReason: string | null;
}

export interface GraphPipeline {
  readonly projectId: string;
  /** 组内节点序 = `taskOrdinalMap` 号序（渲染层**不得重排**）。 */
  readonly nodes: readonly FeatureTaskItem[];
}

/** {@link buildGraphWithPipelines} 出参 = 既有图 + 派生管道（`TaskGraph` 本体与 `buildTaskGraph` 签名不动）。 */
export type TaskGraphWithPipelines = TaskGraph & { readonly pipelines: readonly GraphPipeline[] };

/**
 * 按 projectId 分组的有序管道（纯派生，确定性不依赖入参序）：
 * 管道序 = projectId 升序；组内节点序 = `ordinals` 号升序（缺号节点沉底、同值按 taskId 兜稳）。
 * 节点对象原样引用（不克隆、不回写）；`nodes` 全集语义不变（孤立节点仍在其内，管道同样收录全部节点）。
 */
export function groupPipelines(graph: TaskGraph, ordinals: Map<string, number>): readonly GraphPipeline[] {
  const byProject = new Map<string, FeatureTaskItem[]>();
  for (const n of graph.nodes) {
    const list = byProject.get(n.projectId);
    if (list) list.push(n);
    else byProject.set(n.projectId, [n]);
  }
  const ordinalOf = (t: FeatureTaskItem): number => ordinals.get(t.taskId) ?? Number.POSITIVE_INFINITY;
  return [...byProject.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([projectId, list]) => ({
      projectId,
      nodes: [...list].sort((x, y) => {
        const ox = ordinalOf(x);
        const oy = ordinalOf(y);
        if (ox !== oy) return ox < oy ? -1 : 1;
        return x.taskId < y.taskId ? -1 : x.taskId > y.taskId ? 1 : 0;
      }),
    }));
}

/** `buildTaskGraph`（本体一行不改）+ `taskOrdinalMap` + `groupPipelines` 的一次性 wrapper。 */
export function buildGraphWithPipelines(tasks: readonly FeatureTaskItem[]): TaskGraphWithPipelines {
  const graph = buildTaskGraph(tasks);
  const ordinals = taskOrdinalMap(tasks);
  return { ...graph, pipelines: groupPipelines(graph, ordinals) };
}

/**
 * 任务 → 六态 + 一回落（v0.10.3 N2a；改造文档 §2 M-3 冻结映射）。
 *
 * - `queueState` 读取优先级：`task.queueState` 非空 ⇒ 用它；为 null ∧ 给了 trace 节点 ⇒ 用 trace 的；
 *   两者皆无 ⇒ 回落 `unknown`。**`claimedAt` 不作主判**（可作辅证）。
 * - `working ∧ queueState ∈ QUEUE_STATE_RUNNING` ⇒ `running`；`∈ QUEUE_STATE_QUEUED` ⇒ `queued`
 *   （waitReason 优先取 task 侧；task 侧没有才取 trace 的八值原样）。
 * - `working ∧ 其余值/null` ⇒ `unknown`「执行中（不可辨）」——配色 `NEUTRAL_TASK_COLOR`，
 *   同文件头注「未知任务态 ⇒ 中性色 + 原样态名」的延续，不是新纪律。
 * - `blocked` ⇒ `frozen`（良性终态、不算在飞，沿用 agent-view 既有口径）。
 */
export function nodeStateOf(
  task: Pick<FeatureTaskItem, "state" | "queueState"> & Partial<FeatureTaskItem>,
  traceNode: Pick<TraceNode, "queueState" | "waitReason"> | null,
): NodeStateInfo {
  const qs =
    typeof task.queueState === "string" && task.queueState !== ""
      ? task.queueState
      : traceNode && typeof traceNode.queueState === "string" && traceNode.queueState !== ""
        ? traceNode.queueState
        : null;
  const rawWait =
    typeof (task as { waitReason?: unknown }).waitReason === "string"
      ? ((task as { waitReason?: string }).waitReason as string)
      : (traceNode?.waitReason ?? null);
  switch (task.state) {
    case "completed":
      return { key: "done", label: TASK_STATE_LABELS.completed ?? "已完成", waitReason: null };
    case "failed":
      return { key: "failed", label: TASK_STATE_LABELS.failed ?? "失败", waitReason: null };
    case "blocked":
      return { key: "frozen", label: TASK_STATE_LABELS.blocked ?? "已阻塞", waitReason: null };
    case "input-required":
      return { key: "ask", label: TASK_STATE_LABELS["input-required"] ?? "待澄清", waitReason: null };
    case "working": {
      if (qs !== null && QUEUE_STATE_RUNNING.has(qs)) {
        return { key: "running", label: "执行中·已认领", waitReason: null };
      }
      if (qs !== null && QUEUE_STATE_QUEUED.has(qs)) {
        return { key: "queued", label: "排队·被挡", waitReason: rawWait };
      }
      if (qs === null) {
        return { key: "unknown", label: "执行中（不可辨）", waitReason: null };
      }
      return { key: "unknown", label: `执行中(${qs})`, waitReason: null };
    }
    default:
      return { key: "unknown", label: task.state, waitReason: null };
  }
}

/** 依赖图区块渲染出口：正文 HTML（自绘 DOM/CSS，零脚本）。 */
export interface DependencyGraphSection {
  readonly html: string;
}

// ---------------------------------------------------------------------------
// v0.10.3 N2b：管道制自绘渲染（零脚本 · 图形 HTML 内不出现 prompt）
// ---------------------------------------------------------------------------

/** 图例的固定枚举序（六态 + 回落，与 {@link nodeStateOf} 的 key 闭集同序、不多不少）。 */
export const NODE_STATE_ORDER: readonly NodeState[] = [
  "done",
  "running",
  "queued",
  "failed",
  "frozen",
  "ask",
  "unknown",
] as const;

/**
 * 六态 + 回落的图例展示词 —— **与 {@link nodeStateOf} 的 `label` 逐字同面**
 * （done/failed/frozen/ask 沿用 `TASK_STATE_LABELS` 的既有中文，三档 working 变体沿用
 * nodeStateOf 的字面；单测钉住两侧不漂移）。
 */
export const NODE_STATE_LEGEND_LABELS: Readonly<Record<NodeState, string>> = {
  done: TASK_STATE_LABELS.completed ?? "已完成",
  running: "执行中·已认领",
  queued: "排队·被挡",
  failed: TASK_STATE_LABELS.failed ?? "失败",
  frozen: TASK_STATE_LABELS.blocked ?? "已阻塞",
  ask: TASK_STATE_LABELS["input-required"] ?? "待澄清",
  unknown: "执行中（不可辨）",
};

/**
 * 六态 + 回落的状态符 —— 只出在**管道头的状态摘要串**里（chip 可见文字恒等 `#编号`，
 * 状态由 `dg-<态>` 类与 title 承载）。
 */
export const NODE_STATE_GLYPHS: Readonly<Record<NodeState, string>> = {
  done: "●",
  running: "◐",
  queued: "○",
  failed: "✕",
  frozen: "▨",
  ask: "?",
  unknown: "·",
};

const stateColorOf = (rawState: string): string => TASK_STATE_COLORS[rawState] ?? NEUTRAL_TASK_COLOR;

/**
 * 图例色块：既有五色按六态重新指派（原 `input-required` 的黄档转给 `queued`〔同为等待档〕）
 * + `ask` 一枚新色 + 回落沿用 `NEUTRAL_TASK_COLOR`。**色值单一出处仍是 {@link TASK_STATE_COLORS}**，
 * 本表只做重新指派，不另存一份调色板。
 */
export const NODE_STATE_COLORS: Readonly<Record<NodeState, string>> = {
  done: stateColorOf("completed"),
  running: stateColorOf("working"),
  queued: stateColorOf("input-required"),
  failed: stateColorOf("failed"),
  frozen: stateColorOf("blocked"),
  ask: "#ece2fb",
  unknown: NEUTRAL_TASK_COLOR,
};

/** 跨管道依赖角标的封顶枚数（超出折叠为 `⇠+#m`）。 */
export const MAX_DEP_MARKS = 3;

/** 图例行（六态 + 回落全枚举，定序 ⇒ 同一入参重复渲染逐字相等）。 */
function renderGraphLegend(): string {
  return NODE_STATE_ORDER.map(
    (k) =>
      `<span class="dg-legend"><i style="background:${NODE_STATE_COLORS[k]}"></i>${escapeHtml(
        NODE_STATE_LEGEND_LABELS[k],
      )}</span>`,
  ).join(" ");
}

/**
 * 单枚 chip：可见文字 = `#编号`（+ 至多 {@link MAX_DEP_MARKS} 枚跨管道角标），
 * 全量 taskId / 状态中文 / waitReason / **依赖原值**只进 `title`（整串经 escapeHtml）。
 * 可见文字与 title 都不含 prompt 的任何子串（负向锚 N-2）。
 */
function renderChip(
  task: FeatureTaskItem,
  ordinal: number,
  info: NodeStateInfo,
  crossFromOrdinals: readonly number[],
): string {
  const deps = task.dependencies ?? [];
  const titleParts = [task.taskId, `#${ordinal}`, info.label];
  if (info.waitReason !== null) titleParts.push(`被挡：${info.waitReason}`);
  titleParts.push(deps.length > 0 ? `依赖：${deps.join("、")}` : "依赖：无");
  const marks = [...crossFromOrdinals].sort((a, b) => a - b);
  const shown = marks.slice(0, MAX_DEP_MARKS);
  const hidden = marks.length - shown.length;
  const sup =
    shown.map((o) => `<sup class="dg-dep">⇠#${o}</sup>`).join("") +
    (hidden > 0 ? `<sup class="dg-dep dg-dep-more">⇠+${hidden}</sup>` : "");
  return `<span class="dg-chip dg-${info.key}" title="${escapeHtml(titleParts.join(" · "))}">#${ordinal}${sup}</span>`;
}

/** 单条管道 = 一个原生 `<details class="pipe" open>`（体内只有 chip 与箭头，零连线坐标层）。 */
function renderPipeline(pipe: GraphPipeline, ctx: RenderCtx): string {
  const chips = pipe.nodes
    .map((n) => renderChip(n, ctx.ordinalOf(n.taskId), ctx.stateOf(n), ctx.crossIn(n.taskId)))
    .join('<span class="dg-arrow">→</span>');
  const glyphs = pipe.nodes.map((n) => NODE_STATE_GLYPHS[ctx.stateOf(n).key]).join("");
  return (
    `<details class="pipe" open>\n` +
    `<summary>管道 ${escapeHtml(pipe.projectId)}（${pipe.nodes.length}）` +
    `<span class="dg-pipe-states">${glyphs}</span></summary>\n` +
    `<div class="pipe-body">${chips}</div>\n` +
    `</details>`
  );
}

/** {@link renderPipeline} 的取数面（一次构图后共享，避免每管道重复派生）。 */
interface RenderCtx {
  readonly ordinalOf: (taskId: string) => number;
  readonly stateOf: (task: FeatureTaskItem) => NodeStateInfo;
  readonly crossIn: (taskId: string) => readonly number[];
}

/**
 * 详情页「依赖图」区块（`tasks` = 详情出参任务清单）—— **v0.10.3 N2b 管道制自绘**。
 * **v0.9.5 C2 空区块短路③**：无任务 ⇒ 整节不渲染（判据与语义不变）。
 * 有任务 ⇒ 标题（任务 / 管道 / 边三元计数）+ 图例 + 悬空/环边提示行 + 若干管道 + 跨管道边清单行。
 * `idSeq`（页内序号）自 N2b 起**不再被消费**（原为 mermaid 数据通道载体 id 后缀）——
 * N2c 未摘本参数（本节点在 graph-view.ts 的范围 = mermaid 声明键与出口），
 * 摘除待后续节点裁定。
 */
export function renderDependencyGraphSection(
  tasks: readonly FeatureTaskItem[],
  idSeq: number = 1,
): DependencyGraphSection {
  void idSeq;
  if (tasks.length === 0) {
    return { html: "" };
  }
  const graph = buildTaskGraph(tasks);
  if (graph.nodes.length === 0) return { html: "" };

  const ordinals = taskOrdinalMap(tasks);
  const pipelines = groupPipelines(graph, ordinals);
  const projectByTask = new Map<string, string>();
  for (const n of graph.nodes) projectByTask.set(n.taskId, n.projectId);

  // 跨管道边 = edges 中两端不同 project 者（edges 已按 edgeKey 定序去重）
  const crossIn = new Map<string, number[]>();
  const crossEdgeTexts: string[] = [];
  for (const e of graph.edges) {
    const fromProject = projectByTask.get(e.from);
    const toProject = projectByTask.get(e.to);
    const fromOrdinal = ordinals.get(e.from);
    const toOrdinal = ordinals.get(e.to);
    if (!fromProject || !toProject || fromProject === toProject) continue;
    if (fromOrdinal === undefined || toOrdinal === undefined) continue;
    crossIn.set(e.to, [...(crossIn.get(e.to) ?? []), fromOrdinal]);
    crossEdgeTexts.push(`#${fromOrdinal} ⇢ #${toOrdinal}(${escapeHtml(toProject)})`);
  }

  const ctx: RenderCtx = {
    ordinalOf: (taskId) => ordinals.get(taskId) ?? 0,
    stateOf: (task) => nodeStateOf(task, null),
    crossIn: (taskId) => crossIn.get(taskId) ?? [],
  };

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
    `<h2>依赖图（${graph.nodes.length} 任务 · ${pipelines.length} 管道 · ${graph.edges.length} 边）</h2>\n` +
    `<p class="hint dg-legend-row">${renderGraphLegend()}</p>\n` +
    (notes.length > 0 ? `<p class="hint warn">${notes.join(" · ")}</p>\n` : "") +
    `<div class="dep-graph">\n` +
    pipelines.map((p) => renderPipeline(p, ctx)).join("\n") +
    (crossEdgeTexts.length > 0
      ? `\n<p class="hint dg-edges">跨管道边：${crossEdgeTexts.join("、")}（全量依赖见各节点 title）</p>`
      : "") +
    `\n</div>`;
  return { html };
}
