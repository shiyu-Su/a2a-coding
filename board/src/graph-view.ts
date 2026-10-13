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
 * 边清单，**不画线**（体内零连线坐标层）。
 * ↑ 本段的「位置性箭头」与「体内零连线坐标层」两句已由 **v0.10.5 G5** 推翻（改造文档 §2.1），管道制
 * 的其余形态（原生 `details.pipe` / `#编号` chip / `title` 全量 / 角标族 / 底部边清单）**逐字继承**。
 * **图形 HTML 内不出现 prompt 的任何子串**（负向锚 N-2）；
 * **零 script 标签**（不入 n3 可执行内联闭集，也不出数据通道形态）。
 *
 * **v0.10.5 G1（REQ-2026-10-12-02 · 改造文档 §2.4-①②）**：渲染层之前补两枚**分层纯函数** ——
 * {@link layerOfGraph}（全图 Kahn + longest-path，**层距吃全 `edges`** 含跨管道边；**v0.10.5 N2 起入边 = 约简后
 * `kept`**，层号与吃全边集逐键相同 —— 见测试面「N1约简-④层号差分不变」）与
 * {@link compressPipeLayers}（每管道把全局层号压成密列）。本节点**不算几何、不渲染、不碰 CSS**。
 *
 * **v0.10.5 G2（改造文档 §2.3 / §2.4-③ / §2.5-I4）**：网格几何的**单一事实源** —— `DG_*` 常量块
 * 与 {@link pipeGridLayout}（列内号序 → `cells[]` + `colX/rowY` + 通道 `lanes[]` / 带 `busLanes[]`
 * + `width/height`，全整数）。尺寸数字**只在此处存在**，渲染侧经 inline CSS 变量下发；
 * 本节点**不走线、不产 HTML / CSS、不引布局库**。
 *
 * **v0.10.5 G3（改造文档 §2.4-④ / §2.5-I2 I3 / §2.6）**：管道内走线纯函数 {@link routeIntraEdges}
 * —— 相邻边一枚三次贝塞尔、长边三段（下降弧 → 通道带水平段 → 上升弧，Q1/Q2 处切线同为水平
 * ⇒ C¹ 连续），出参只给 `d` / `cls`（**不带 HTML**）；`busLane` 按 x 区间装箱、`λ/μ` 按同通道
 * y 区间装箱。端点 = {@link PipeGridCell} 的边框中点定义式（I2）。**不渲染、不产 HTML、不碰 CSS、
 * 不画跨管道边、不上减交叉**（用户已裁：允许交叉、只禁共段）。
 *
 * **v0.10.5 G5（改造文档 §2.2 / §2.7-④⑤⑥⑦）**：渲染层接管 —— `renderPipeline()` 的病根句
 * `join('<span class="dg-arrow">→</span>')` **退役**，`.pipe-body` 内改三层包裹：`<div class="dg-grid">`
 * （inline 下发 `--dg-nw/--dg-nh/--dg-bh` + `width/height`）内含 **每管道恰一枚** `<svg class="dg-links">`
 * （只出 `<path class="dg-edge" d="…"/>`，**不写** `viewBox` / `width` / `height` / `aria-hidden` ⇒
 * 用户单位 = CSS px 1:1）+ 每节点一枚 `<span class="dg-cell" style="left:…;top:…">`。
 * chip 出参字面逐字不动（`⇠#k` 角标**去 sup 内联** ⇒ 移到 cell 的独立角标带 `.dg-deps`，字面与相邻关系不变）。
 * **带引号属性闭集 = `class` / `title` / `style` / `d`**；inline `style` **只含几何字面**（零 `position:` 声明，
 * 定位归 CSS）。网格几何走**一次预算回灌**（先走线取 lane 数 → 重算网格 → 再走线），与测试面 `g45Layout` 同形态。
 * 跨管道机制（`crossIn` / `crossEdgeTexts` / 底部边清单 / 图例 / `hint warn`）**逐字不动**
 * （**v0.10.5 N2 起本句只指机制** —— 这些面**消费的边集已是约简后 `kept`**：机制逐字不动 ≠ 入边逐字不动，
 * 见下 N2 段与 {@link transitiveReduce}）；
 * **不碰 CSS**（N6）· **零脚本**（八元内联闭集不扩）。
 *
 * **v0.10.5 N2（REQ-2026-10-12-04 · 改造文档 §2.3-2 / §2.3-3）**：section 层在全图**单次**传递约简，
 * 五个消费点（`layerOfGraph` / `crossIn` / `crossEdgeTexts` / `planPipe` 走线入参 / `h2` 计数）
 * **共用同一份 `kept`** —— 分开跑会让走线与 `⇠#k` 角标互相不一致。`h2` 抬为**恒全形**
 * `依赖图（N 任务 · M 管道 · 声明 K 边（本质 J · 传递省略 R））`（`R = 0` 也出「传递省略 0」，
 * 它是「已核过、确实不冗余」的正向凭据）；`dropped` **只出计数、不逐条列、不进 `hint warn` 行**
 * （该行语义只列「画不出的边」= `dangling` / `cycleEdges`）。三处审计面（执行明细依赖列 /
 * `renderChip` 依赖段 / 等待列 `blockedOn`）**恒保声明原值** —— 两面口径不同是设计而非缺陷。
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

// ---------------------------------------------------------------------------
// v0.10.5 N1（REQ-2026-10-12-04 · 改造文档 §2.3-1）：传递约简（构图之后、分层之前的纯函数，无渲染接线）
// ---------------------------------------------------------------------------

/** {@link transitiveReduce} 出参：本质边集 `kept` 与传递省略边集 `dropped`（两集均按 {@link edgeKey} 定序）。 */
export interface TransitiveReduction {
  readonly kept: readonly { from: string; to: string }[];
  readonly dropped: readonly { from: string; to: string }[];
}

/**
 * `to` 在 `E ∖ {(from,to)}` 上是否仍自 `from` 可达 —— 删边测试的单边判据。
 * 起点 `from` 自身先入 `visited`（既排除「空路径自可达」，也保证脏入参含环时必终止）；
 * 源点的直接后继先剔掉 `to` 一枚 ⇒ 「本边自己一跳」不计入替代路径。
 */
function reachableWithoutEdge(successors: Map<string, string[]>, from: string, to: string): boolean {
  const visited = new Set<string>([from]);
  const stack = (successors.get(from) ?? []).filter((t) => t !== to);
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === to) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of successors.get(id) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }
  return false;
}

/**
 * 传递约简（改造文档 §2.3-1）：保留 `(u,v)` ⟺ 在 `E ∖ {(u,v)}` 上 `v ∉ reach(u)`。
 *
 * **前置条件**：入参已由 {@link buildTaskGraph} 去重 + 滤环 + 去悬空 ⇒ 恒为 DAG；
 * **不得**以 `cycleEdges` / `dangling` 为输入。
 * - **在只读原边集上算一次、不得边删边判**：DAG 上任何长度 ≥2 的 `u⇝v` 路径都不经过 `(u,v)` 自身
 *   ⇒「是否冗余」是**原边集 `E` 上的不变量**、与判边序无关 ⇒ 结果即极大元唯一表示（贪心原地删边
 *   会把 `b→c` 这类本质边一并吞掉）。
 * - 出参两集按 {@link edgeKey} 定序 ⇒ 同一边集任意数组序、重复调用逐字相等；入参数组与边对象只读、不回写。
 * - 消费方 = 渲染层五个消费点共用同一 `kept`（§2.3-2）；三处审计面仍取声明原值（§2.3-5）。
 */
export function transitiveReduce(edges: readonly { from: string; to: string }[]): TransitiveReduction {
  const successors = new Map<string, string[]>();
  for (const e of edges) {
    const list = successors.get(e.from);
    if (list) list.push(e.to);
    else successors.set(e.from, [e.to]);
  }
  const kept: { from: string; to: string }[] = [];
  const dropped: { from: string; to: string }[] = [];
  for (const e of edges) {
    if (reachableWithoutEdge(successors, e.from, e.to)) dropped.push(e);
    else kept.push(e);
  }
  const byKey = (a: { from: string; to: string }, b: { from: string; to: string }): number =>
    edgeKey(a) < edgeKey(b) ? -1 : 1;
  return { kept: kept.sort(byKey), dropped: dropped.sort(byKey) };
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
 * `queueState`「已认领」档字面值白名单。值域事实源 = **引擎读面真机回执**
 * （`GET /api/features/:id` 的 `tasks[].queueState`，REQ-2026-10-11-04 核实）：
 * `claimed` = 在飞（已认领）、`settled` = 排队（未派发，`claimedAt` 与 `queuedAt` 皆可为 null）。
 * `running` 是**板历史口径的同义词**，保留在白名单内（档位语义成立、成本 0 行；删除会连带翻
 * 夹具与 trace 面锚，无收益）。
 * **禁止再以板内测试夹具 / 派发消息文本充当「值域样本」** —— 此前 M-3 定档即因此写错。
 * 命中集之外的非空原值 ⇒ 回落 `unknown` 出「原样值」，不吞不猜（本文件唯一兜底，纪律不动）。
 */
export const QUEUE_STATE_RUNNING: ReadonlySet<string> = new Set(["claimed", "running"]);
/** `queueState`「排队（被挡）」档字面值白名单（`settled` = 实测值 + `queued` = 历史同义词，口径同上）。 */
export const QUEUE_STATE_QUEUED: ReadonlySet<string> = new Set(["settled", "queued"]);

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

// ---------------------------------------------------------------------------
// v0.10.5 G1（REQ-2026-10-12-02 · 改造文档 §2.4-①②）：全局分层 + 密列压缩（纯派生，无几何 / 无 HTML）
// ---------------------------------------------------------------------------

/** 号序比较（`ordinals` 缺号 ⇒ `+∞` 沉底、同值按 `taskId` 升序兜稳）—— 与 {@link groupPipelines} 同口径。 */
const byOrdinal = (ordinals: Map<string, number>) => (a: string, b: string): number => {
  const oa = ordinals.get(a) ?? Number.POSITIVE_INFINITY;
  const ob = ordinals.get(b) ?? Number.POSITIVE_INFINITY;
  if (oa !== ob) return oa < ob ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * 全局层号（taskId → 层号，0 起）—— **全图** Kahn 拓扑 + longest-path（改造文档 §2.4-①）。
 *
 * - **层距吃全 `edges`（含跨管道边，C3 采纳口径）** ⇒「只依赖他管道节点」的节点照被抬层，
 *   不会因本管道内无入边而落 layer 0（负钉，由 {@link compressPipeLayers} 侧的列号承接）。
 * - 入参 `edges` 已由 {@link buildTaskGraph} 滤环 + 去悬空 ⇒ 恒为 DAG，**本函数不再自行净化**
 *   （无环检测、无环边丢弃）；端点不在 `nodes` 全集的边不入邻接（边集按契约已是节点集的子集）。
 * - 确定性 = **就绪集按 `ordinals` 号序取**；longest-path 的层号只由前驱集决定 ⇒ 同一图的
 *   任意入参数组序、重复调用均逐键相等。
 * - 出参键 = `nodes` 全集 taskId（无入边者 ⇒ 0，含孤立节点，不吞不猜）；节点对象只读、不回写。
 */
export function layerOfGraph(
  nodes: readonly FeatureTaskItem[],
  ordinals: Map<string, number>,
  edges: readonly { from: string; to: string }[],
): Map<string, number> {
  const layer = new Map<string, number>();
  const successors = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const n of nodes) {
    layer.set(n.taskId, 0);
    successors.set(n.taskId, []);
    remaining.set(n.taskId, 0);
  }
  for (const e of edges) {
    if (!layer.has(e.from) || !layer.has(e.to)) continue;
    successors.get(e.from)?.push(e.to);
    remaining.set(e.to, (remaining.get(e.to) ?? 0) + 1);
  }
  const order = byOrdinal(ordinals);
  while (remaining.size > 0) {
    let pick: string | null = null;
    for (const [id, left] of remaining) {
      if (left !== 0) continue;
      if (pick === null || order(id, pick) < 0) pick = id;
    }
    if (pick === null) break;
    remaining.delete(pick);
    const next = (layer.get(pick) ?? 0) + 1;
    for (const succ of successors.get(pick) ?? []) {
      if (next > (layer.get(succ) ?? 0)) layer.set(succ, next);
      remaining.set(succ, (remaining.get(succ) ?? 0) - 1);
    }
  }
  return layer;
}

/**
 * 密列压缩（taskId → 该管道内的**列号**）—— 把管道内节点的全局层号压成密列
 * （该管道无节点的中间列不占位，改造文档 §2.4-②）。可证性质：
 * - **每列非空**、列号从 0 起且连续（值域 = `0..K-1`，K = 该管道出现过的层号枚数）；
 * - **保序**：全局层号升序 ⇔ 列号严格升序 ⇒「画线边列差 ≥2 ⇔ 中间必有本管道节点」成立；
 * - 出参插入序 = 列号升序、同列内沿用 `pipe.nodes` 的号序（{@link groupPipelines} 已排）。
 * 层号缺失 ⇒ 按 0 档（`layerOfGraph` 出参恒覆盖 `nodes` 全集，此路只对窄 `layers` 手工入参生效）。
 */
export function compressPipeLayers(pipe: GraphPipeline, layers: Map<string, number>): Map<string, number> {
  const columnNodes = new Map<number, string[]>();
  for (const n of pipe.nodes) {
    const lv = layers.get(n.taskId) ?? 0;
    const list = columnNodes.get(lv);
    if (list) list.push(n.taskId);
    else columnNodes.set(lv, [n.taskId]);
  }
  const out = new Map<string, number>();
  [...columnNodes.keys()]
    .sort((a, b) => a - b)
    .forEach((lv, col) => {
      for (const id of columnNodes.get(lv) ?? []) out.set(id, col);
    });
  return out;
}

// ---------------------------------------------------------------------------
// v0.10.5 G2（REQ-2026-10-12-02 · 改造文档 §2.3 / §2.4-③ / §2.5-I4）：
// 网格几何单一事实源 —— DG_* 常量块 + pipeGridLayout（纯几何；不走线、不产 HTML/CSS）
// ---------------------------------------------------------------------------

/** chip 盒宽（`box-sizing:border-box` ⇒ 右缘恒 = `x + DG_NODE_W`，与 `#n` 位数无关）。 */
export const DG_NODE_W = 74;
/** chip 盒高。 */
export const DG_NODE_H = 28;
/** 角标带高 —— 每 cell **恒**预留（`⇠#k` 枚数不进 chip 盒，故定宽不被角标撑破）。= 结构事实：外壳恒渲。 */
export const DG_BADGE_H = 14;
/** 同列相邻 cell 的纵距。 */
export const DG_ROW_GAP = 4;
/** 列间通道带宽下界（吃角标越界：`DG_BADGE_MAX_W - DG_NODE_W = 56 ≤ 56` —— **取等**，不是余量）。 */
export const DG_COL_GAP_MIN = 56;
/** 通道内相邻 lane 的 x 间距（λ / μ 的步长）。 */
export const DG_LANE_PITCH = 14;
/** 首 lane 距 chip 边的下界（一个通道两侧各留一枚 ⇒ 公式里的 `DG_LANE_MIN * 2`）。 */
export const DG_LANE_MIN = 22;
/** 贝塞尔首段控制点长上界（走线侧消费；定义在此，几何单源）。 */
export const DG_ARC_K_MAX = 34;
/** 底部通道带每 lane 的高。 */
export const DG_BUS_PITCH = 12;
/** 左内缘（= `COL_X[0]`）。 */
export const DG_PAD_L = 12;
/** 上内缘（= `ROW_Y[0]`）。 */
export const DG_PAD_T = 12;
/** 下内缘（I4 的高度加数）。 */
export const DG_PAD_B = 12;
/** 右内缘 —— 最后一列角标越界的**下界**（上界由 I4 用 {@link DG_BADGE_MAX_W} 算足）。 */
export const DG_PAD_R = 96;
/**
 * 角标带越界的**设计界**（改造文档 §2.3 C2：`MAX_DEP_MARKS`=3 + 1 枚折叠 ⇒ 至多 4 枚 × ~32px ≤ 130）。
 * 供 I4 算足宽度用；**不是机器度量**（SSR 侧无 DOM 度量，真机目测 = G6）。
 */
export const DG_BADGE_MAX_W = 130;

/** 单 cell 盒高（角标带 + chip）。 */
const DG_CELL_H = DG_BADGE_H + DG_NODE_H;

/** {@link pipeGridLayout} 的一枚格位（`x/y` = cell 盒左/上缘；chip 盒在角标带之下）。 */
export interface PipeGridCell {
  readonly taskId: string;
  /** `taskOrdinalMap` 号（纯标识 —— 分层后列序由依赖决定，号序只管列内排布）。 */
  readonly ordinal: number;
  readonly col: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** chip 左缘（= `x`）。 */
  readonly chipX: number;
  /** chip 顶缘（= `y + DG_BADGE_H`）。 */
  readonly chipY: number;
  /** 端点定义式的源侧横坐标：chip 右缘。 */
  readonly chipRight: number;
  /** 端点定义式的纵坐标：chip 右边（左边同）中点。 */
  readonly chipMidY: number;
}

/** {@link pipeGridLayout} 的走线预算入参（lane 数由走线侧回灌，**一次收敛不迭代**）。 */
export interface PipeGridBudget {
  /** 第 `c` 枚列间通道预留的 lane 数（长度 ≤ `cols-1`，缺省项与非正值按 0 计）。 */
  readonly gapLanes?: readonly number[];
  /** 底部通道带的 lane 数（缺省 0 ⇒ 带高 0）。 */
  readonly busLaneCount?: number;
}

/** {@link pipeGridLayout} 出参（全整数值；I4 两条不等式由构造保证）。 */
export interface PipeGridLayout {
  /** 格位序 = 列号升序、同列内号序升序。 */
  readonly cells: readonly PipeGridCell[];
  /** taskId → 格位（走线 / 渲染侧的取数面）。 */
  readonly cellOf: Map<string, PipeGridCell>;
  readonly cols: number;
  readonly rows: number;
  readonly colX: readonly number[];
  readonly rowY: readonly number[];
  /** 第 `c` 枚通道宽（长度 = `cols-1`），恒 ≥ {@link DG_COL_GAP_MIN}。 */
  readonly gapW: readonly number[];
  /** 每枚通道的 lane **x 线**（与 `gapW` 同长；λ 即其下标）。 */
  readonly lanes: readonly (readonly number[])[];
  readonly busBandTop: number;
  /** 底部通道带的 lane **y 线**（长度 = 预算的带内 lane 数；busLane 即其下标）。 */
  readonly busLanes: readonly number[];
  readonly width: number;
  readonly height: number;
}

/** 空网格短路出参（无 cell ⇒ 无列、无行、宽高 0；每次新建，不共享可变 `cellOf`）。 */
const emptyGrid = (): PipeGridLayout => ({
  cells: [],
  cellOf: new Map(),
  cols: 0,
  rows: 0,
  colX: [],
  rowY: [],
  gapW: [],
  lanes: [],
  busBandTop: 0,
  busLanes: [],
  width: 0,
  height: 0,
});

/**
 * 一条管道的网格几何（纯函数，改造文档 §2.4-③）：{@link compressPipeLayers} 的列号 → 格位 / 坐标 / 通道。
 *
 * - **列内按号序**（`ordinals` 升序、缺号沉底、同值按 `taskId` 兜稳 —— 与 {@link groupPipelines}
 *   同口径）⇒ 出参与入参数组序无关；`row` = 列内下标 ⇒ 同列格位两两不同，`rows` = 最大列容量。
 * - **每列非空**：入参列号按出现值升序重编号（已是密列 ⇒ 恒等），空列在结构上不可表示。
 * - **通道宽** `gapW[c] = max(DG_COL_GAP_MIN, DG_LANE_MIN*2 + lanes(c)*DG_LANE_PITCH)` —— lane 数由
 *   走线预算经 `budget.gapLanes` 回灌，本函数**只消费不推算、不迭代**。
 * - **I4 内容包含**由构造成立：`width = 最右 chip 右缘 + max(DG_PAD_R, DG_BADGE_MAX_W)`、
 *   `height = max(最后一格底缘, 通道带底) + DG_PAD_B`。
 * - 空管道 ⇒ 短路 {@link emptyGrid}（渲染侧 `tasks.length===0` 的短路不受影响）。
 */
export function pipeGridLayout(
  pipe: GraphPipeline,
  columns: Map<string, number>,
  ordinals: Map<string, number>,
  budget: PipeGridBudget = {},
): PipeGridLayout {
  if (pipe.nodes.length === 0) return emptyGrid();

  const colOf = (taskId: string): number => columns.get(taskId) ?? 0;
  const colKeys: number[] = [];
  for (const n of pipe.nodes) {
    const c = colOf(n.taskId);
    if (!colKeys.includes(c)) colKeys.push(c);
  }
  colKeys.sort((a, b) => a - b);

  const order = byOrdinal(ordinals);
  const groups: string[][] = colKeys.map(() => []);
  for (const n of [...pipe.nodes].sort((a, b) => order(a.taskId, b.taskId))) {
    groups[colKeys.indexOf(colOf(n.taskId))]?.push(n.taskId);
  }

  const cols = colKeys.length;
  const rows = Math.max(...groups.map((g) => g.length));

  const gapCount: number[] = [];
  const gapW: number[] = [];
  for (let c = 0; c < cols - 1; c += 1) {
    const n = Math.max(0, budget.gapLanes?.[c] ?? 0);
    gapCount.push(n);
    gapW.push(Math.max(DG_COL_GAP_MIN, DG_LANE_MIN * 2 + n * DG_LANE_PITCH));
  }

  const colX: number[] = [DG_PAD_L];
  for (let c = 1; c < cols; c += 1) {
    colX.push((colX[c - 1] ?? DG_PAD_L) + DG_NODE_W + (gapW[c - 1] ?? DG_COL_GAP_MIN));
  }
  const lanes: number[][] = gapCount.map((n, c) =>
    Array.from({ length: n }, (_, i) => (colX[c] ?? DG_PAD_L) + DG_NODE_W + DG_LANE_MIN + i * DG_LANE_PITCH),
  );

  const rowY = Array.from({ length: rows }, (_, r) => DG_PAD_T + r * (DG_BADGE_H + DG_NODE_H + DG_ROW_GAP));

  const cellOf = new Map<string, PipeGridCell>();
  const cells: PipeGridCell[] = [];
  groups.forEach((ids, c) => {
    ids.forEach((taskId, r) => {
      const x = colX[c] ?? DG_PAD_L;
      const y = rowY[r] ?? DG_PAD_T;
      const chipY = y + DG_BADGE_H;
      const cell: PipeGridCell = {
        taskId,
        ordinal: ordinals.get(taskId) ?? 0,
        col: c,
        row: r,
        x,
        y,
        w: DG_NODE_W,
        h: DG_CELL_H,
        chipX: x,
        chipY,
        chipRight: x + DG_NODE_W,
        chipMidY: chipY + DG_NODE_H / 2,
      };
      cells.push(cell);
      cellOf.set(taskId, cell);
    });
  });

  const contentRight = (colX[cols - 1] ?? DG_PAD_L) + DG_NODE_W;
  const contentBottom = (rowY[rows - 1] ?? DG_PAD_T) + DG_CELL_H;
  const busBandTop = contentBottom + DG_ROW_GAP;
  const busCount = Math.max(0, budget.busLaneCount ?? 0);
  const busLanes = Array.from({ length: busCount }, (_, i) => busBandTop + Math.floor(DG_BUS_PITCH / 2) + i * DG_BUS_PITCH);
  const busBandBottom = busBandTop + busCount * DG_BUS_PITCH;

  return {
    cells,
    cellOf,
    cols,
    rows,
    colX,
    rowY,
    gapW,
    lanes,
    busBandTop,
    busLanes,
    width: contentRight + Math.max(DG_PAD_R, DG_BADGE_MAX_W),
    height: Math.max(contentBottom, busBandBottom) + DG_PAD_B,
  };
}

// ---------------------------------------------------------------------------
// v0.10.5 G3（REQ-2026-10-12-02 · 改造文档 §2.4-④ / §2.5-I2 I3 / §2.6）：
// 通道式走线 —— routeIntraEdges / arcPath / busPath（纯函数；不渲染、不产 HTML、不碰 CSS、不减交叉）
// ---------------------------------------------------------------------------

/** 边线类名（§2.2 命名纪律 2：单数 `dg-edge`、不含子串 `dg-edges`；容器类 = `dg-links` 由渲染侧给）。 */
export const DG_EDGE_CLS = "dg-edge";

/**
 * 一条管道内一条依赖边的走线结果（**只有 path 数据与类名，不含任何 HTML**）。
 * `adjacent` 档不占通道 ⇒ `busLane` / `lambda` / `mu` / `yb` 均为 −1。
 */
export interface RoutedEdge {
  readonly from: string;
  readonly to: string;
  /** 该管道内的列差（`localCol` 差）：1 ⇒ 相邻弧；≥ 2 ⇒ 长边三段。 */
  readonly colSpan: number;
  readonly kind: "adjacent" | "long";
  /** 底部通道带 lane 号（该边水平段所在 y 线的下标）。 */
  readonly busLane: number;
  /** 源侧通道（列 `a.col` 之右）的 lane 号，自源 chip 右缘起算。 */
  readonly lambda: number;
  /** 目标侧通道（列 `b.col` 之左）的 lane 号，自目标 chip 左缘起算。 */
  readonly mu: number;
  /** 该边水平段的 y 线（= `busLaneY(grid, busLane)`）。 */
  readonly yb: number;
  readonly cls: string;
  readonly d: string;
}

/** 底部通道带第 `lane` 枚的 y 线 —— 与 {@link pipeGridLayout} 的 `busLanes[lane]` 同式。 */
const busLaneY = (grid: PipeGridLayout, lane: number): number =>
  grid.busBandTop + Math.floor(DG_BUS_PITCH / 2) + lane * DG_BUS_PITCH;

/** 贝塞尔控制点长 `K = clamp(dx/3, 6, DG_ARC_K_MAX)`（取整 ⇒ 全整数几何）。 */
const arcK = (dx: number): number => Math.max(6, Math.min(DG_ARC_K_MAX, Math.round(dx / 3)));

/** 相邻边（列差 1）：一枚三次贝塞尔，**两端切线水平** ⇒ 端点即边框中点（判据 1）。 */
export function arcPath(x0: number, y0: number, x1: number, y1: number): string {
  const k = arcK(x1 - x0);
  return `M${x0},${y0} C${x0 + k},${y0} ${x1 - k},${y1} ${x1},${y1}`;
}

/**
 * 长边（列差 ≥ 2）三段：下降弧 `P0→Q1` ⇒ 通道带水平段 `Q1→Q2` ⇒ 上升弧 `Q2→P1`。
 * Q1/Q2 两侧切线同为水平 ⇒ **C¹ 连续（无硬角）**。
 */
export function busPath(x0: number, y0: number, tx: number, yb: number, tx2: number, x1: number, y1: number): string {
  const k1 = arcK(tx - x0);
  const k2 = arcK(x1 - tx2);
  return (
    `M${x0},${y0} C${x0 + k1},${y0} ${tx - k1},${yb} ${tx},${yb}` +
    ` L${tx2},${yb} C${tx2 + k2},${yb} ${x1 - k2},${y1} ${x1},${y1}`
  );
}

/**
 * 区间装箱（贪心）：按入参序取「与同 lane 已放区间**两两不交**」的首枚，不交 ⇒ 复用，否则另开一枚。
 * 出参下标 = 入参下标（lane 号自 0 起）。**相切按不交的反面处理**（保守另开 ⇒ 只多占 lane、不叠线）。
 */
const packLanes = (items: readonly { lo: number; hi: number }[]): number[] => {
  const used: { lo: number; hi: number }[][] = [];
  const out: number[] = [];
  for (const it of items) {
    let lane = used.length;
    for (let i = 0; i < used.length; i += 1) {
      const slots = used[i];
      if (slots !== undefined && slots.every((s) => it.hi < s.lo || it.lo > s.hi)) {
        lane = i;
        break;
      }
    }
    if (lane === used.length) used.push([]);
    used[lane]?.push({ lo: it.lo, hi: it.hi });
    out.push(lane);
  }
  return out;
};

const ySpan = (ya: number, yb: number): { lo: number; hi: number } => ({
  lo: Math.min(ya, yb),
  hi: Math.max(ya, yb),
});

/** 装箱前的可写计划（`lane` 号在装箱阶段回填）。 */
interface RoutePlan {
  readonly a: PipeGridCell;
  readonly b: PipeGridCell;
  readonly kind: "adjacent" | "long";
  busLane: number;
  lambda: number;
  mu: number;
  yb: number;
}

/**
 * 一枚管道的全部**管道内边**走线（纯函数，改造文档 §2.4-④）。
 *
 * - 入参 = 图的边集 + {@link pipeGridLayout} 的网格；两端不同都落在这枚网格里的边（**跨管道边**）
 *   直接跳过 ⇒ 结构上不可能画线（跨管道只留角标 + 底部边清单，机制逐字不变）。
 * - **定序** = （源号序, 目标号序）升序、同值按 taskId 兜稳 ⇒ 出参与入参数组序无关（确定性可单测）。
 * - 相邻边 = {@link arcPath}；长边 = {@link busPath}，`tx = x0 + DG_LANE_MIN + λ·DG_LANE_PITCH`、
 *   `tx2 = x1 − DG_LANE_MIN − μ·DG_LANE_PITCH`（与网格 `lanes[]` 的 x 线同式）、`yb` = 通道带 lane 线。
 * - **装箱**：`busLane` 复用条件 = x 区间两两不交；`λ`（源侧通道）与 `μ`（目标侧通道）**分席各自装箱**，
 *   复用条件 = 两条边在该通道的 y 区间不交。分席 ⇒ 同一通道的预算取「λ 枚数 + μ 枚数」即无 x 碰撞
 *   （λ 自左起算、μ 自右起算，各自的下标区间在通道内首尾相接、不重叠）。
 * - 列差 ≤ 1 的边不占任何 lane；**不减交叉**（§2.6：允许交叉、只禁共段）。
 */
export function routeIntraEdges(
  edges: readonly { from: string; to: string }[],
  grid: PipeGridLayout,
): readonly RoutedEdge[] {
  const plans: RoutePlan[] = [];
  for (const e of edges) {
    const a = grid.cellOf.get(e.from);
    const b = grid.cellOf.get(e.to);
    if (a === undefined || b === undefined) continue;
    plans.push({
      a,
      b,
      kind: b.col - a.col >= 2 ? "long" : "adjacent",
      busLane: -1,
      lambda: -1,
      mu: -1,
      yb: -1,
    });
  }
  plans.sort((x, y) => {
    if (x.a.ordinal !== y.a.ordinal) return x.a.ordinal - y.a.ordinal;
    if (x.b.ordinal !== y.b.ordinal) return x.b.ordinal - y.b.ordinal;
    if (x.a.taskId !== y.a.taskId) return x.a.taskId < y.a.taskId ? -1 : 1;
    return x.b.taskId < y.b.taskId ? -1 : x.b.taskId > y.b.taskId ? 1 : 0;
  });

  const longs = plans.filter((p) => p.kind === "long");
  const busPacked = packLanes(longs.map((p) => ({ lo: p.a.chipRight, hi: p.b.chipX })));
  longs.forEach((p, i) => {
    p.busLane = busPacked[i] ?? 0;
    p.yb = busLaneY(grid, p.busLane);
  });

  const grouped = (keyOf: (p: RoutePlan) => number): Map<number, RoutePlan[]> => {
    const out = new Map<number, RoutePlan[]>();
    for (const p of longs) {
      const k = keyOf(p);
      const list = out.get(k);
      if (list) list.push(p);
      else out.set(k, [p]);
    }
    return out;
  };
  for (const group of grouped((p) => p.a.col).values()) {
    const packed = packLanes(group.map((p) => ySpan(p.a.chipMidY, p.yb)));
    group.forEach((p, i) => {
      p.lambda = packed[i] ?? 0;
    });
  }
  for (const group of grouped((p) => p.b.col - 1).values()) {
    const packed = packLanes(group.map((p) => ySpan(p.b.chipMidY, p.yb)));
    group.forEach((p, i) => {
      p.mu = packed[i] ?? 0;
    });
  }

  return plans.map((p) => {
    const x0 = p.a.chipRight;
    const y0 = p.a.chipMidY;
    const x1 = p.b.chipX;
    const y1 = p.b.chipMidY;
    const d =
      p.kind === "adjacent"
        ? arcPath(x0, y0, x1, y1)
        : busPath(
            x0,
            y0,
            x0 + DG_LANE_MIN + p.lambda * DG_LANE_PITCH,
            p.yb,
            x1 - DG_LANE_MIN - p.mu * DG_LANE_PITCH,
            x1,
            y1,
          );
    return {
      from: p.a.taskId,
      to: p.b.taskId,
      colSpan: p.b.col - p.a.col,
      kind: p.kind,
      busLane: p.busLane,
      lambda: p.lambda,
      mu: p.mu,
      yb: p.yb,
      cls: DG_EDGE_CLS,
      d,
    };
  });
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
 * 单枚 chip：可见文字 = `#编号`（**定宽盒内恒只此一项**，角标已移出到 cell 的 `.dg-deps` 带），
 * 全量 taskId / 状态中文 / waitReason / **依赖原值**只进 `title`（整串经 escapeHtml）。
 * 可见文字与 title 都不含 prompt 的任何子串（负向锚 N-2）。
 * **出参字面与 N2b 逐字相同**（仅不再内联 `<sup>`）⇒ chip 字面族 / `title` 族锚零翻案。
 */
function renderChip(task: FeatureTaskItem, ordinal: number, info: NodeStateInfo): string {
  const deps = task.dependencies ?? [];
  const titleParts = [task.taskId, `#${ordinal}`, info.label];
  if (info.waitReason !== null) titleParts.push(`被挡：${info.waitReason}`);
  titleParts.push(deps.length > 0 ? `依赖：${deps.join("、")}` : "依赖：无");
  return `<span class="dg-chip dg-${info.key}" title="${escapeHtml(titleParts.join(" · "))}">#${ordinal}</span>`;
}

/**
 * 跨管道依赖角标串（≤{@link MAX_DEP_MARKS} 枚 `⇠#k` + 超出折叠 `⇠+#m`）——
 * `<sup>` 的**字面与相邻关系与 N2b 逐字一致**，只是落点从 chip 内移到 cell 的角标带。
 * 无角标 ⇒ 空串，外壳照出（空带 —— 预留由 {@link DG_BADGE_H} 一侧的结构保证）。
 */
function renderDepMarks(crossFromOrdinals: readonly number[]): string {
  const marks = [...crossFromOrdinals].sort((a, b) => a - b);
  const shown = marks.slice(0, MAX_DEP_MARKS);
  const hidden = marks.length - shown.length;
  return (
    shown.map((o) => `<sup class="dg-dep">⇠#${o}</sup>`).join("") +
    (hidden > 0 ? `<sup class="dg-dep dg-dep-more">⇠+${hidden}</sup>` : "")
  );
}

/** 一枚节点格位 = 绝对定位外壳（inline `style` 只给 `left/top` 两枚几何字面）+ chip + 角标带（**恒渲**，无角标 ⇒ 空带）。 */
function renderPipeCell(cell: PipeGridCell, chip: string, marks: string): string {
  return (
    `<span class="dg-cell" style="left:${cell.x}px;top:${cell.y}px">` +
    chip +
    `<span class="dg-deps">${marks}</span>` +
    `</span>`
  );
}

/**
 * 一条管道的边线层 = **恰一枚** `<svg class="dg-links">`（§2.2 命名纪律 1：`<svg>` 不写任何带引号属性，
 * 盒模由 CSS `.dg-links{position:absolute;inset:0;width:100%;height:100%}` 给；不写 `viewBox`
 * ⇒ 用户单位 = CSS px 1:1）。path 只带 `class` + `d`，`d` 字符集 ⊆ `[MLCQHAZ0-9.,\-\s]`（G3 已钉）。
 */
function renderPipeSvg(routes: readonly RoutedEdge[]): string {
  return `<svg class="dg-links">${routes.map((e) => `<path class="${e.cls}" d="${e.d}"/>`).join("")}</svg>`;
}

/** 一条管道的渲染预案 = 网格几何（含一次预算回灌）+ 管道内走线（跨管道边在 `routeIntraEdges` 侧结构上不入）。 */
interface PipePlan {
  readonly grid: PipeGridLayout;
  readonly routes: readonly RoutedEdge[];
}

/**
 * 一次构图 → 走线 → **把 lane 数回灌成预算重算网格** → 再走线（改造文档 §2.4-③「一次收敛不迭代」）。
 * 回灌只抬 `gapW` / 通道带高，**不改 lane 分配**（λ/μ/`busLane` 由装箱决定，与通道宽无关；G3 已钉）。
 */
function planPipe(
  pipe: GraphPipeline,
  edges: readonly { from: string; to: string }[],
  layers: Map<string, number>,
  ordinals: Map<string, number>,
): PipePlan {
  const columns = compressPipeLayers(pipe, layers);
  const base = pipeGridLayout(pipe, columns, ordinals);
  const longs = routeIntraEdges(edges, base).filter((e) => e.kind === "long");
  const gapLanes = new Array<number>(Math.max(0, base.cols - 1)).fill(0);
  for (const e of longs) {
    const a = base.cellOf.get(e.from);
    const b = base.cellOf.get(e.to);
    if (a === undefined || b === undefined) continue;
    gapLanes[a.col] = (gapLanes[a.col] ?? 0) + 1;
    const targetGap = b.col - 1;
    if (targetGap >= 0 && targetGap < gapLanes.length) gapLanes[targetGap] = (gapLanes[targetGap] ?? 0) + 1;
  }
  const grid = pipeGridLayout(pipe, columns, ordinals, { gapLanes, busLaneCount: longs.length });
  return { grid, routes: routeIntraEdges(edges, grid) };
}

/** 单条管道 = 一个原生 `<details class="pipe" open>`（体内 = `.dg-grid`：一枚边线层 + 每节点一枚 cell）。 */
function renderPipeline(pipe: GraphPipeline, ctx: RenderCtx): string {
  const { grid, routes } = ctx.planOf(pipe);
  const taskBy = new Map(pipe.nodes.map((n) => [n.taskId, n] as const));
  const body = grid.cells
    .map((cell) => {
      const task = taskBy.get(cell.taskId) as FeatureTaskItem;
      return renderPipeCell(
        cell,
        renderChip(task, ctx.ordinalOf(task.taskId), ctx.stateOf(task)),
        renderDepMarks(ctx.crossIn(task.taskId)),
      );
    })
    .join("");
  const glyphs = pipe.nodes.map((n) => NODE_STATE_GLYPHS[ctx.stateOf(n).key]).join("");
  return (
    `<details class="pipe" open>\n` +
    `<summary>管道 ${escapeHtml(pipe.projectId)}（${pipe.nodes.length}）` +
    `<span class="dg-pipe-states">${glyphs}</span></summary>\n` +
    `<div class="pipe-body">` +
    `<div class="dg-grid" style="--dg-nw:${DG_NODE_W}px;--dg-nh:${DG_NODE_H}px;--dg-bh:${DG_BADGE_H}px;width:${grid.width}px;height:${grid.height}px">` +
    renderPipeSvg(routes) +
    body +
    `</div></div>\n` +
    `</details>`
  );
}

/** {@link renderPipeline} 的取数面（一次构图后共享，避免每管道重复派生）。 */
interface RenderCtx {
  readonly ordinalOf: (taskId: string) => number;
  readonly stateOf: (task: FeatureTaskItem) => NodeStateInfo;
  readonly crossIn: (taskId: string) => readonly number[];
  readonly planOf: (pipe: GraphPipeline) => PipePlan;
}

/**
 * 详情页「依赖图」区块（`tasks` = 详情出参任务清单）—— **v0.10.5 G5 网格 + 通道走线自绘**
 * （v0.10.3 N2b 管道制自绘的接管版）。
 * **v0.9.5 C2 空区块短路③**：无任务 ⇒ 整节不渲染（判据与语义不变）。
 * 有任务 ⇒ 标题（任务 / 管道 / 声明·本质·省略三数）+ 图例 + 悬空/环边提示行 + 若干管道 + 跨管道边清单行。
 * **v0.10.5 N2**：图形面吃**约简后边集** `kept`（全图单次约简、五消费点共用），
 * 三处审计面（`renderChip` 的 `依赖：` 段等）仍吃声明原值。
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

  // 全图**单次**传递约简（改造文档 §2.3-2）：管道内边与跨管道边共用同一份 kept
  const { kept, dropped } = transitiveReduce(graph.edges);
  const ordinals = taskOrdinalMap(tasks);
  const pipelines = groupPipelines(graph, ordinals);
  const layers = layerOfGraph(graph.nodes, ordinals, kept);
  const projectByTask = new Map<string, string>();
  for (const n of graph.nodes) projectByTask.set(n.taskId, n.projectId);

  // 跨管道边 = kept 中两端不同 project 者（kept 已按 edgeKey 定序去重）
  const crossIn = new Map<string, number[]>();
  const crossEdgeTexts: string[] = [];
  for (const e of kept) {
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
    planOf: (pipe) => planPipe(pipe, kept, layers, ordinals),
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
    `<h2>依赖图（${graph.nodes.length} 任务 · ${pipelines.length} 管道 · 声明 ${graph.edges.length} 边（本质 ${kept.length} · 传递省略 ${dropped.length}））</h2>\n` +
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
