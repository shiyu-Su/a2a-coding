/**
 * 依赖图视图（v0.9.3 T2 · REQ-v0.9.3-2026-09-26-02）：详情页「依赖图」区块。
 *
 * **渲染形态 = 框制 · 单画布 · 真连线自绘 DOM/CSS（零 script 标签）**（v0.10.3 N2b 起自绘，形态经
 * v0.10.5 G5/G2 与 v0.10.6 C4/C5 重写，见文件末「N2b」段与 C3/C4/C5 段）。
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
 * 跨管道依赖只出 chip 右上角标 `⇠#k`（≤3 枚，超出折叠 `⇠+#m`）+ 图区底部一行
 * 边清单，**不画线**（体内零连线坐标层）。
 * ↑ 本段的「位置性箭头」与「体内零连线坐标层」两句已由 **v0.10.5 G5** 推翻（改造文档 §2.1）；
 * 本段末两句「只出角标 `⇠#k`」与「不画线」**整句**另由 **v0.10.6 C5**（REQ-2026-10-12-06 · 改造文档 §2.2-C5）
 * 推翻 —— 跨框依赖现由画布层**真连线**承载，角标族（`renderDepMarks` / `MAX_DEP_MARKS` / `crossIn` 取数面 /
 * `.dg-deps` 外壳）**整体退役**。本段的其余形态（原生 `details.pipe` / `#编号` chip / `title` 全量 /
 * **底部边清单**）**逐字继承**；口径措辞随 C4/C5 由「管道制」抬为「**框制 · 单画布 · 真连线**」
 * （每框一枚 `details.pipe` 的**枚数不变**，改造文档 §4.4「不翻案」条）。
 * **图形 HTML 内不出现 prompt 的任何子串**（负向锚 N-2）；
 * **零 script 标签**（不入 n3 可执行内联闭集，也不出数据通道形态）。
 *
 * **v0.10.5 G1 / G2 / G3（分层 + 网格几何 + 框内走线 · 已整体退休 v0.10.7 N8 · REQ-2026-10-15-01 改造文档 §2.3「删」）**：
 * 自绘时代「全图分层 → 每管道密列 → 网格格位与坐标 → 框内 / 跨框走线」四段纯函数**全部退役** —— 坐标源已由
 * ELK 一趟求解给出（`src/graph-elk.ts`），本仓不再算几何。尺寸数字的单源随之收窄为下方 `DG_*` 常量块里**仍被
 * 渲染侧与 ELK 入参消费**的若干枚（{@link DG_NODE_W} / {@link DG_NODE_H} / {@link DG_BADGE_H} / 三枚框内缘量），
 * 其余尺寸常量与两枚走线 path 原语**已由 v0.10.7 N10 删除**（名单见改造文档 §2.3「删」段；跨框走线一族由 **N9** 删除，见下 C3 段）。
 *
 * **v0.10.5 G5（改造文档 §2.2 / §2.7-④⑤⑥⑦）**：渲染层接管 —— `renderPipeline()` 的病根句
 * `join('<span class="dg-arrow">→</span>')` **退役**，`.pipe-body` 内改三层包裹：`<div class="dg-grid">`
 * （inline 下发 `--dg-nw/--dg-nh/--dg-bh` + `width/height`）内含 **每管道恰一枚** `<svg class="dg-links">`
 * （只出 `<path class="dg-edge" d="…"/>`，**不写** `viewBox` / `width` / `height` / `aria-hidden` ⇒
 * 用户单位 = CSS px 1:1）+ 每节点一枚 `<span class="dg-cell" style="left:…;top:…">`。
 * ↑ 跨框边的 class 已由 **v0.10.6 追加件 n9** 抬为两枚（{@link DG_EDGE_CROSS_CLS} = `dg-edge dg-edge-cross`，
 * 首 token 仍是 `dg-edge`）—— 属性闭集与「只出 class + d」两句**不翻**，翻的只是 class 的取值面。
 * chip 出参字面逐字不动（`⇠#k` 角标**去 sup 内联** ⇒ 移到 cell 的独立角标带 `.dg-deps`，字面与相邻关系不变）。
 * ↑ 本句的**角标落点**已由 **v0.10.6 C5** 推翻 —— `.dg-deps` 角标带整体退役、cell 只剩 chip 一枚子元素，
 * 原 14px 行距改由 `.dg-cell` 的 `padding-top: var(--dg-bh)` 承接（C7）；**「chip 出参字面逐字不动」半句照旧成立**。
 * **带引号属性闭集 = `class` / `title` / `style` / `d`**；inline `style` **只含几何字面**（零 `position:` 声明，
 * 定位归 CSS）。
 * ↑ 本段的「网格几何走一次预算回灌」与「框间带走定序不动点」两句随 **v0.10.7 N8** 退休 —— 预算回灌是**自绘几何**
 * 独有的句式（先走线取 lane 数 → 按实占重算盒模 → 再走线）；坐标源换成 ELK 后一趟求解即出全部坐标，无回灌对象。
 * 跨管道机制（`crossIn` / `crossEdgeTexts` / 底部边清单 / 图例 / `hint warn`）**逐字不动**
 * （**v0.10.5 N2 起本句只指机制** —— 这些面**消费的边集已是约简后 `kept`**：机制逐字不动 ≠ 入边逐字不动，
 * 见下 N2 段与 {@link transitiveReduce}；**本清单首枚 `crossIn` 已由 v0.10.6 C5 退役** ⇒ 现存机制 =
 * `crossEdgeTexts` / 底部边清单 / 图例 / `hint warn` 四项）；
 * **不碰 CSS**（N6）· **零脚本**（八元内联闭集不扩）。
 *
 * **v0.10.5 N2（REQ-2026-10-12-04 · 改造文档 §2.3-2 / §2.3-3）**：section 层在全图**单次**传递约简，
 * 各消费点（**喂 ELK 的边集** / `crossEdgeTexts` 底部边清单 / `h2` 计数）**共用同一份 `kept`**
 * —— 分开跑会让图形面与底部边清单互相不一致。（v0.10.6 C5 摘 `crossIn` 角标取数面、v0.10.7 N8 摘分层与走线入参
 * 之后，同批 `kept` 单约简的判据**不因此改动**，「互相不一致」的对照面读为「图形面 vs 底部边清单」。）`h2` 抬为**恒全形**
 * `依赖图（N 任务 · M 管道 · 声明 K 边（本质 J · 传递省略 R））`（`R = 0` 也出「传递省略 0」，
 * 它是「已核过、确实不冗余」的正向凭据）；`dropped` **只出计数、不逐条列、不进 `hint warn` 行**
 * （该行语义只列「画不出的边」= `dangling` / `cycleEdges`）。三处审计面（执行明细依赖列 /
 * `renderChip` 依赖段 / 等待列 `blockedOn`）**恒保声明原值** —— 两面口径不同是设计而非缺陷。
 *
 * **v0.10.6 C3（跨框走线 + 走廊选型 · 已退休 v0.10.7 N8 · 符号已由 N9 删除）**：跨框边的路由归属已由 ELK 承担
 * （改造文档 §2.1-1），原「框外公共通道带 / 弧—直—弧—直—弧 / 统一装箱 / 走廊降档 / 入点侧向让位」一族不再进 DOM；
 * 其 path 原语、类型与专属常量（走线装箱 / 走廊选型 / 入点让位 / 跨框走廊一族与其路由类型）**已于 v0.10.7 N9 整体删除**
 * —— 逐枚名单见改造文档 §2.3「删」段，本文件不再点名（退休符号零残留判据 = §4 实现级）。
 */
import type { FeatureTaskItem, TraceNode } from "./bridge-client.js";
import {
  layoutGraphGuarded,
  type ElkGraphSource,
  type FlatGraph,
  type FlatLane,
  type FlatNode,
  type FlatPoint,
  type GuardedLayout,
} from "./graph-elk.js";
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
 * 任务编号单点（v0.10.3 N1）：taskId → 1..N 的**登记序编号**，由 `createdAt` 升序派生。
 *
 * 确定性三连（每条都是可单测的字面行为，不依赖输入序）：
 * - `createdAt` 升序 = **登记时刻**升序 —— ISO 串字面序即可（与 `version-order` 无关，不引它）；
 * - 同值 ⇒ 按 `taskId` 升序兜稳 ⇒ 同一入参重复调用逐键相等；**不宣称严格登记先后**（同刻并列只保证序稳定）；
 * - `createdAt` 为 null ⇒ **沉底**（不当 0、不当「最早」——缺时刻不等于最早时刻）；全 null ⇒ 整体沉底、序退化为 `taskId` 字典序（防御支，当前不触发但保留）。
 * 去重口径同 {@link buildTaskGraph} 的 `byId`（首见即留）。纯展示层派生：不改账面 id、不回写任务。
 */
export function taskOrdinalMap(tasks: readonly FeatureTaskItem[]): Map<string, number> {
  const byId = new Map<string, FeatureTaskItem>();
  for (const t of tasks) if (!byId.has(t.taskId)) byId.set(t.taskId, t);
  const ordered = [...byId.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      if (a.createdAt === null) return 1;
      if (b.createdAt === null) return -1;
      return a.createdAt < b.createdAt ? -1 : 1;
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

// ---------------------------------------------------------------------------
// v0.10.5 G2（REQ-2026-10-12-02 · 改造文档 §2.3 / §2.4-③ / §2.5-I4）：
// 尺寸数字的单一事实源 —— `DG_*` 常量块（纯数值；不走线、不产 HTML/CSS）
// ↑ v0.10.7 N8：本块曾与之平级的「网格几何」与「画布级布局」两枚几何函数族已退休（坐标源 = ELK）。
// ↑ v0.10.7 N10（REQ-2026-10-15-01 · 改造文档 §2.3「删」段）：块内**无消费方**的走线 / 通道 / 画布堆叠
//   尺寸常量随走线族整族删除（逐枚名单见改造文档 §2.3「删」段，本文件不点名 ⇒ 退休符号零残留判据 §4）；
//   本块只留 **ELK 入参**与 **DOM 帧壳让位量**两类仍被消费的数值。
// ---------------------------------------------------------------------------

/** chip 盒宽（`box-sizing:border-box` ⇒ 右缘恒 = `x + DG_NODE_W`，与 `#n` 位数无关）。= ELK 节点盒入参。 */
export const DG_NODE_W = 74;
/** chip 盒高。= ELK 节点盒入参。 */
export const DG_NODE_H = 28;
/** 角标带高 —— 每 cell **恒**预留（`⇠#k` 枚数不进 chip 盒，故定宽不被角标撑破）。= 结构事实：外壳恒渲。 */
export const DG_BADGE_H = 14;

// --- v0.10.6 C1 框级常量（合并单画布 · 改造文档 §2.2 / §2.2.1；v0.10.7 N10 起只留 DOM 壳消费面）---
/** 框边框宽（1px 实线 —— 走线端点落边框线中点，边框宽须独立成枚、不混入内边距）。 */
export const DG_FRAME_BORDER = 1;
/** 框标题带高（框顶项目名一行 —— 走线障碍集「框标题带」的高度来源）。 */
export const DG_FRAME_TITLE_H = 20;
/** 框内边距（标题带之下、chip 网格四周留白 —— 框内容到边框的最小间距）。 */
export const DG_FRAME_PAD = 8;
/**
 * DOM 网格原点相对框【外缘】的横向加数 —— `.pipe` 的 1px 边框 + `.pipe-body` 的左内缘
 * （`--dg-fp` = {@link DG_FRAME_PAD}）。走线抬到画布层时，框内网格须由框外缘再偏此量才与
 * DOM 里 chip 的实际落点对齐（DOM 侧 cell 的 `left/top` 相对 `.pipe-body`，天然含此偏移）。
 */
export const DG_GRID_ORIGIN_X = DG_FRAME_BORDER + DG_FRAME_PAD;
/**
 * DOM 网格原点相对框【外缘】的纵向加数 —— `.pipe` 的 1px 边框 + `.pipe-body` 的标题带
 * （`--dg-fth` = {@link DG_FRAME_TITLE_H}；标题带只占顶部，故纵向加数不含 {@link DG_FRAME_PAD}）。
 */
export const DG_GRID_ORIGIN_Y = DG_FRAME_BORDER + DG_FRAME_TITLE_H;

// ---------------------------------------------------------------------------
// v0.10.6 C2（REQ-2026-10-12-06 · 改造文档 §2.2-C2 / §2.2.1 / §2.3）：
// 框内缘 CSS 变量的下发口（v0.10.7 N8 起：本块曾承载的「画布级布局」几何族已退休，坐标源 = ELK）
// ---------------------------------------------------------------------------

/**
 * 三枚**框内缘** CSS 变量字面（改造文档 §2.2.2「关键」行：`border + title + pad` 三级加数**全部**
 * 由 JS 单源下发 —— CSS 侧的 `--b-sp-*` 一律不得参与坐标推导，否则几何事实源裂成两处）。
 */
export const DG_FRAME_VARS = `--dg-fb:${DG_FRAME_BORDER}px;--dg-fth:${DG_FRAME_TITLE_H}px;--dg-fp:${DG_FRAME_PAD}px`;

// ---------------------------------------------------------------------------
// v0.10.5 G3（REQ-2026-10-12-02 · 改造文档 §2.4-④ / §2.5-I2 I3 / §2.6）：
// 边线类名常量（走线几何 → path 的原语族已整族退休）
// ↑ v0.10.7 N8：同块的管道内走线函数已退休（其入参 = 已删除的网格几何类型）。
// ↑ v0.10.7 N9：同块曾并列的跨框走线一族（装箱 / 走廊与让位原语 / 其类型与专属常量）已整体删除
//   —— 跨框路由归 ELK。
// ↑ v0.10.7 N10（REQ-2026-10-15-01 · 改造文档 §2.3「删」段末项）：剩余两枚走线 path 原语
//   （连同其贝塞尔控制点函数与上块唯一消费方常量）删除 —— 逐枚名单见改造文档 §2.3「删」段，
//   本文件不点名（退休符号零残留 = §4 实现级判据）。
//   折线 `d` 的唯一出面 = {@link elkEdgePath}（吃 ELK `sections`）。本块只留两枚类名常量。
// ---------------------------------------------------------------------------

/** 边线类名（§2.2 命名纪律 2：单数 `dg-edge`、不含子串 `dg-edges`；容器类 = `dg-links` 由渲染侧给）。 */
export const DG_EDGE_CLS = "dg-edge";

/**
 * 跨框边的类名 = 基础类 + 追加类（REQ-2026-10-14-02 追加件：跨管道连线单独配色）。
 * **首 token 逐字 = {@link DG_EDGE_CLS}** ⇒ 基础规则 `.dg-links path` 照命中，
 * 追加类只让 CSS 侧多叠一枚 `stroke`（零几何声明、不改走线）。
 * 第二枚类名不得含子串 `dg-edges`（`.dg-edges` 边清单行的在场判据靠这一枚区分）。
 */
export const DG_EDGE_CROSS_CLS = "dg-edge dg-edge-cross";

/** 一条跨框边（两端异 project）—— 端点 taskId + 各自 projectId（供跨管道边清单行取数）。 */
export interface CrossEdge {
  readonly from: string;
  readonly to: string;
  readonly fromProject: string;
  readonly toProject: string;
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
 * 单枚 chip：可见文字 = `#编号`（**定宽盒内恒只此一项**），
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

/** ELK 出参的绝对坐标 → DOM inline 字面（收 0.01px，防 `1e-7` 一类指数串进 `d` / `style`）。 */
const elkNum = (v: number): string => String(Math.round(v * 100) / 100);

/**
 * ELK 一条折线 → path `d`（`M` 起点 + `L` 逐点，正交折线不需要曲线段）。
 * 折线不足两点 ⇒ 空串（该边不进线层；兜底判据不在渲染侧，见 {@link renderDependencyGraphSection}）。
 */
function elkEdgePath(pts: readonly FlatPoint[]): string {
  if (pts.length < 2) return "";
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${elkNum(p[0])},${elkNum(p[1])}`).join(" ");
}

/**
 * ELK 出参边集 → 画布层 path 数据（只出 `cls` / `d` 两枚，由 {@link renderCanvas} 摊进唯一一枚 `svg.dg-links`）。
 * 两端同 lane ⇒ 基础类；异 lane（或端点不可辨）⇒ 追加类 {@link DG_EDGE_CROSS_CLS}（跨管道连线单独配色，
 * 首 token 仍是 `dg-edge` ⇒ `.dg-links path` 基础规则照命中）。
 */
function elkRoutes(ctx: RenderCtx): Readonly<{ cls: string; d: string }>[] {
  const routes: { cls: string; d: string }[] = [];
  for (const edge of ctx.flat.edges) {
    const d = elkEdgePath(edge.pts);
    if (d === "") continue;
    const fromLane = ctx.nodeOf.get(edge.from)?.laneId;
    const toLane = ctx.nodeOf.get(edge.to)?.laneId;
    routes.push({ cls: fromLane !== undefined && fromLane === toLane ? DG_EDGE_CLS : DG_EDGE_CROSS_CLS, d });
  }
  return routes;
}

/** 一枚框 = **管道形态原样保留、只把坐标源换成 ELK**（改造文档 §2.3「改」段 / §2.2-C4）：
 * DOM 壳 `<details class="pipe" open>` + 原 `<summary>` 字面 + `.pipe-body` + `.dg-grid` **逐字照留**
 * （`holdAnchor` 认的是锚内 `.dg-chip.dg-running/.dg-queued`，壳在 ⇒ 语义在）。
 * 框外盒 = ELK 的 lane 盒、cell 的 `left/top` = ELK chip 绝对盒减去帧壳让位量（换算式见 {@link RenderCtx}）——
 * **lane 盒之所以能直接当框外盒用，靠 `graph-elk` 的 lane top padding 与本侧让位量同源**。
 * **框内零 svg**（画布层唯一一枚）。 */
function renderFrame(pipe: GraphPipeline, ctx: RenderCtx): string {
  const lane = ctx.laneOf.get(pipe.projectId);
  if (lane === undefined) return "";
  const taskBy = new Map(pipe.nodes.map((n) => [n.taskId, n] as const));
  const body = ctx.flat.nodes
    .filter((node) => node.laneId === lane.id)
    .map((node) => {
      const task = taskBy.get(node.id);
      if (task === undefined) return "";
      const x = node.x - lane.x - DG_GRID_ORIGIN_X;
      const y = node.y - lane.y - DG_GRID_ORIGIN_Y - DG_BADGE_H;
      const chip = renderChip(task, ctx.ordinalOf(task.taskId), ctx.stateOf(task));
      return `<span class="dg-cell" style="left:${x}px;top:${y}px">${chip}</span>`;
    })
    .join("");
  const glyphs = pipe.nodes.map((n) => NODE_STATE_GLYPHS[ctx.stateOf(n).key]).join("");
  const gridW = lane.w - 2 * DG_GRID_ORIGIN_X;
  const gridH = lane.h - DG_GRID_ORIGIN_Y - (DG_FRAME_BORDER + DG_FRAME_PAD);
  return (
    `<details class="pipe" open style="left:${elkNum(lane.x)}px;top:${elkNum(lane.y)}px;width:${elkNum(lane.w)}px;height:${elkNum(lane.h)}px">\n` +
    `<summary>管道 ${escapeHtml(pipe.projectId)}（${pipe.nodes.length}）` +
    `<span class="dg-pipe-states">${glyphs}</span></summary>\n` +
    `<div class="pipe-body">` +
    `<div class="dg-grid" style="width:${elkNum(gridW)}px;height:${elkNum(gridH)}px">` +
    body +
    `</div></div>\n` +
    `</details>`
  );
}

/**
 * 画布层（改造文档 §2.2-C4 / §2.2.1 · v0.10.7 N5 起坐标源 = ELK）：`.dg-canvas` 内**恰一枚**
 * `svg.dg-links`（全部 path 用 ELK 的**画布绝对折线**）+ 每管道一枚 {@link renderFrame}。
 * 画布宽高 = ELK root 盒；`--dg-nw/--dg-nh/--dg-bh` 与三枚框内缘变量在此**一次下发**（自定义属性天然继承）。
 */
function renderCanvas(pipes: readonly GraphPipeline[], ctx: RenderCtx): string {
  const flat = ctx.flat;
  const style =
    `width:${elkNum(flat.width)}px;height:${elkNum(flat.height)}px;` +
    `--dg-nw:${DG_NODE_W}px;--dg-nh:${DG_NODE_H}px;--dg-bh:${DG_BADGE_H}px;${DG_FRAME_VARS}`;
  return (
    `<div class="dg-canvas" style="${style}">\n` +
    `<svg class="dg-links">${elkRoutes(ctx)
      .map((e) => `<path class="${e.cls}" d="${e.d}"/>`)
      .join("")}</svg>` +
    "\n" +
    pipes.map((p) => renderFrame(p, ctx)).join("\n") +
    `\n</div>`
  );
}

/**
 * 渲染取数面（v0.10.7 N5 起 = ELK 出参一次摊好后共享，避免每管道重复派生）。
 *
 * **两套参照系**（S1 折叠口径随坐标源换血一并保住）：`flat` 里的 lane / node / edge 全是**画布绝对坐标**
 * ⇒ 只有 path 用绝对值；cell 的 `left/top` 是**相对 `.dg-grid` 的局部值**，换算须扣帧壳让位量
 * （横 = {@link DG_GRID_ORIGIN_X}，纵 = {@link DG_GRID_ORIGIN_Y} + 角标带 {@link DG_BADGE_H}，
 * 后者由 `.dg-cell` 的 `padding-top: var(--dg-bh)` 承接 —— 与 `graph-elk` 的 lane padding 同一事实源）。
 */
interface RenderCtx {
  readonly ordinalOf: (taskId: string) => number;
  readonly stateOf: (task: FeatureTaskItem) => NodeStateInfo;
  /** ELK 求解 + 摊平出参 —— 本层唯一几何来源（改造文档 §2.1-1）。 */
  readonly flat: FlatGraph;
  /** projectId → lane 盒（= `details.pipe` 外盒）。 */
  readonly laneOf: ReadonlyMap<string, FlatLane>;
  /** taskId → chip 绝对盒（边线两端定类、cell 坐标换算的取数面）。 */
  readonly nodeOf: ReadonlyMap<string, FlatNode>;
}

/**
 * 详情页「依赖图」区块的**唯一公开口**（`tasks` = 详情出参任务清单）——
 * **v0.10.7 N5（REQ-2026-10-15-01 · 改造文档 §2.2「落点」）起 = async + 坐标源 = ELK 出参**
 * （接管 v0.10.5 G5 的网格 + 通道走线自绘：走线族不再进 DOM，退休属后续节点）。
 * **v0.9.5 C2 空区块短路③**：无任务 ⇒ 整节不渲染（判据与语义不变）。
 * 有任务 ⇒ 标题（任务 / 管道 / 声明·本质·省略三数）+ 图例 + 悬空/环边提示行 + 若干管道 + 跨管道边清单行。
 * **v0.10.5 N2**：图形面吃**约简后边集** `kept`，三处审计面（`renderChip` 的 `依赖：` 段等）仍吃声明原值。
 * `idSeq`（页内序号）**仍不被消费**（原为 mermaid 数据通道载体 id 后缀，摘除待后续节点裁定）。
 *
 * **兜底门（v0.10.7 N4 · 改造文档 §2.4 宿主裁定，N5 合流进本口）**：ELK 求解 / 摊平任一环节抛错 ⇒
 * 整节**只回吐一行**提示（`class="hint warn"`）—— 不抛异常、不静默、页面不 500。
 * 两枚空短路（无任务 / 零节点）**不跑求解** ⇒ 不出提示行。
 * `layout` 仅供测试注入抛错桩，生产侧不传（缺省 {@link layoutGraphGuarded}）。
 */
export async function renderDependencyGraphSection(
  tasks: readonly FeatureTaskItem[],
  idSeq: number = 1,
  layout: ElkLayoutFn = layoutGraphGuarded,
): Promise<DependencyGraphSection> {
  void idSeq;
  if (tasks.length === 0) {
    return { html: "" };
  }
  const graph = buildTaskGraph(tasks);
  if (graph.nodes.length === 0) return { html: "" };

  // 全图**单次**传递约简（改造文档 §2.3-2）：喂 ELK 的边集与底部清单行共用同一份 kept
  const { kept, dropped } = transitiveReduce(graph.edges);
  const ordinals = taskOrdinalMap(tasks);
  const pipelines = groupPipelines(graph, ordinals);

  const laid = await layout({ pipelines, edges: kept });
  if (laid.flat === null) {
    return { html: `<p class="hint warn">依赖图布局失败，本节回吐空图：${escapeHtml(laid.reason ?? "")}</p>` };
  }
  return { html: renderSectionHtml(graph, pipelines, kept, dropped, ordinals, laid.flat) };
}

/**
 * 出图体（几何已在手 ⇒ 同步纯渲染，坐标系换算只发生在 {@link RenderCtx} 一侧）。
 * 标题三数 / 图例 / 环与悬空提示行 / 跨管道边清单行的**文字面逐字沿用**，改的只有画布与框的坐标来源。
 */
function renderSectionHtml(
  graph: TaskGraph,
  pipelines: readonly GraphPipeline[],
  kept: readonly { from: string; to: string }[],
  dropped: readonly { from: string; to: string }[],
  ordinals: ReadonlyMap<string, number>,
  flat: FlatGraph,
): string {
  const projectByTask = new Map<string, string>();
  for (const n of graph.nodes) projectByTask.set(n.taskId, n.projectId);

  // 跨管道边清单行 = kept 中两端不同 project 者（kept 已按 edgeKey 定序去重）
  // —— **v0.10.7 N5**：本批边只剩「底部文字面」一个用途，跨框走线已由 ELK 路由（{@link flat.edges}）
  const crossEdgeTexts: string[] = [];
  for (const e of kept) {
    const fromProject = projectByTask.get(e.from);
    const toProject = projectByTask.get(e.to);
    const fromOrdinal = ordinals.get(e.from);
    const toOrdinal = ordinals.get(e.to);
    if (!fromProject || !toProject || fromProject === toProject) continue;
    if (fromOrdinal === undefined || toOrdinal === undefined) continue;
    crossEdgeTexts.push(`#${fromOrdinal} ⇢ #${toOrdinal}(${escapeHtml(toProject)})`);
  }

  const ctx: RenderCtx = {
    ordinalOf: (taskId) => ordinals.get(taskId) ?? 0,
    stateOf: (task) => nodeStateOf(task, null),
    flat,
    laneOf: new Map(flat.lanes.map((lane) => [lane.projectId, lane] as const)),
    nodeOf: new Map(flat.nodes.map((node) => [node.id, node] as const)),
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

  return (
    `<h2>依赖图（${graph.nodes.length} 任务 · ${pipelines.length} 管道 · 声明 ${graph.edges.length} 边（本质 ${kept.length} · 传递省略 ${dropped.length}））</h2>\n` +
    `<p class="hint dg-legend-row">${renderGraphLegend()}</p>\n` +
    (notes.length > 0 ? `<p class="hint warn">${notes.join(" · ")}</p>\n` : "") +
    `<div class="dep-graph">\n` +
    renderCanvas(pipelines, ctx) +
    (crossEdgeTexts.length > 0
      ? `\n<p class="hint dg-edges">跨管道边：${crossEdgeTexts.join("、")}（全量依赖见各节点 title）</p>`
      : "") +
    `\n</div>`
  );
}

/** {@link renderDependencyGraphSection} 的求解注入面 —— 缺省走兜底面，测试可注入抛错桩。 */
export type ElkLayoutFn = (source: ElkGraphSource) => Promise<GuardedLayout>;
