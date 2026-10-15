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
 * ↑ 跨框边的 class 已由 **v0.10.6 追加件 n9** 抬为两枚（{@link DG_EDGE_CROSS_CLS} = `dg-edge dg-edge-cross`，
 * 首 token 仍是 `dg-edge`）—— 属性闭集与「只出 class + d」两句**不翻**，翻的只是 class 的取值面。
 * chip 出参字面逐字不动（`⇠#k` 角标**去 sup 内联** ⇒ 移到 cell 的独立角标带 `.dg-deps`，字面与相邻关系不变）。
 * ↑ 本句的**角标落点**已由 **v0.10.6 C5** 推翻 —— `.dg-deps` 角标带整体退役、cell 只剩 chip 一枚子元素，
 * 原 14px 行距改由 `.dg-cell` 的 `padding-top: var(--dg-bh)` 承接（C7）；**「chip 出参字面逐字不动」半句照旧成立**。
 * **带引号属性闭集 = `class` / `title` / `style` / `d`**；inline `style` **只含几何字面**（零 `position:` 声明，
 * 定位归 CSS）。网格几何走**一次预算回灌**（先走线取 lane 数 → 重算网格 → 再走线），与测试面 `g45Layout` 同形态。
 * ↑ 该「一次」只管**框内侧**（列通道 `gapW` / 通道带高，n8a）；**框间带**预算自 v0.10.6 承接轨② n8b 起改走
 * **定序不动点**（≤ {@link DG_BAND_MAX_PASSES} 轮，见 {@link planCanvas}）—— 两面同一「先走线、再按实占重算」的句式，
 * 轮数不同。
 * 跨管道机制（`crossIn` / `crossEdgeTexts` / 底部边清单 / 图例 / `hint warn`）**逐字不动**
 * （**v0.10.5 N2 起本句只指机制** —— 这些面**消费的边集已是约简后 `kept`**：机制逐字不动 ≠ 入边逐字不动，
 * 见下 N2 段与 {@link transitiveReduce}；**本清单首枚 `crossIn` 已由 v0.10.6 C5 退役** ⇒ 现存机制 =
 * `crossEdgeTexts` / 底部边清单 / 图例 / `hint warn` 四项）；
 * **不碰 CSS**（N6）· **零脚本**（八元内联闭集不扩）。
 *
 * **v0.10.5 N2（REQ-2026-10-12-04 · 改造文档 §2.3-2 / §2.3-3）**：section 层在全图**单次**传递约简，
 * 五个消费点（`layerOfGraph` / `crossIn` / `crossEdgeTexts` / `planCanvas` 走线入参 / `h2` 计数）
 * **共用同一份 `kept`** —— 分开跑会让走线与 `⇠#k` 角标互相不一致。（**v0.10.6 C5 后本段现形**：五枚中的
 * `crossIn` 角标取数面**已退役**、`⇠#k` 角标随之消失 ⇒ 消费点余下四处（`layerOfGraph` / `crossEdgeTexts` /
 * `planCanvas` 走线入参 / `h2` 计数），同批 `kept` 单约简的判据**不因此改动**，「互相不一致」的对照面
 * 从「走线 vs 角标」改读为「走线 vs 底部边清单」。）`h2` 抬为**恒全形**
 * `依赖图（N 任务 · M 管道 · 声明 K 边（本质 J · 传递省略 R））`（`R = 0` 也出「传递省略 0」，
 * 它是「已核过、确实不冗余」的正向凭据）；`dropped` **只出计数、不逐条列、不进 `hint warn` 行**
 * （该行语义只列「画不出的边」= `dangling` / `cycleEdges`）。三处审计面（执行明细依赖列 /
 * `renderChip` 依赖段 / 等待列 `blockedOn`）**恒保声明原值** —— 两面口径不同是设计而非缺陷。
 *
 * **v0.10.6 C3（REQ-2026-10-12-06 · 改造文档 §2.2-C3 / §2.3 / §2.5-R2 R5）**：跨框走线纯函数
 * {@link routeCrossFrameEdges} + 原语 {@link crossPath}（(A) 框外公共通道带 · **弧—直—弧—直—弧**，
 * 每处拐角一枚 C 弧、切线连续；含**回流档**走画布左 gutter）。`RoutedEdge.kind` 扩第三值 `"cross"`。
 * **统一装箱**：λ / `busLane` 分席键从「本 grid 列号」抬为「画布通道号」（按 `lane` 栅格把通道基准 x 归一），
 * `intraCeil` 越过框内腿另起 + `packLanes` 同趟复用 ⇒ 跨框线与框内线**互不共段**（同通道 y 区间不交 /
 * 同带 x 区间不交）。端点沿用 I2（源 `chipRight`/`chipMidY` 出、目标 `chipX`/`chipMidY` 入，坐标已含 dx/dy）。
 * **不减交叉**（用户已裁：允许交叉、只禁共段）；**不渲染、不产 HTML、不碰 CSS**；`arcPath` / `busPath` /
 * `arcK` / `packLanes` / `busLaneY` 函数体**逐字不改**（只新增与并列）。
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
/** 列间通道带宽下界 = `2·DG_LANE_MIN + 余量`（`2×22 + 12 = 56`）。 */
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
/** 右内缘 —— 末列 chip 右缘到网格右内缘的留白（与 {@link DG_PAD_L} 对称）。 */
export const DG_PAD_R = 12;

/** 单 cell 盒高（角标带 + chip）。 */
const DG_CELL_H = DG_BADGE_H + DG_NODE_H;

// --- v0.10.6 C1 框级常量（合并单画布 · 改造文档 §2.2 / §2.2.1；数值口径由后续节点消费）---
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
/** 兄弟框间的最小净距（画布堆叠时相邻框矩形的间距下界 —— 防框矩形贴合）。 */
export const DG_FRAME_GAP_MIN = 32;
/** 跨面走线绕出框后进入公共通道带的最短可用段长（水平段太短则视觉粘连、不可辨）。 */
export const DG_CROSS_MIN = 14;
/** 画布外缘留白（所有框整体到画布边缘的下界 —— 画布 width/height 的最外圈加数）。 */
export const DG_CANVAS_GUTTER = 24;
/** 画布内容内边距（框堆叠区到画布内缘的间距 —— 与 GUTTER 分职：GUTTER 管外缘、PAD 管内容盒）。 */
export const DG_CANVAS_PAD = 8;

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
 * - **I4 内容包含**由构造成立：`width = 最右 chip 右缘 + DG_PAD_R`、
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
    width: contentRight + DG_PAD_R,
    height: Math.max(contentBottom, busBandBottom) + DG_PAD_B,
  };
}

// ---------------------------------------------------------------------------
// v0.10.6 C1（REQ-2026-10-12-06 · 改造文档 §2.2 / §2.2.1）：画布空间平移算子
// （纯函数 · 只喂走线，不进 HTML/DOM · pipeGridLayout 本体一行不改）
// ---------------------------------------------------------------------------

/**
 * 把一枚管道网格整体平移 `(dx, dy)` 到画布空间（C1）。**只喂走线** —— 出参仅供统一装箱与
 * I1/I3 核验，DOM 里不出现画布坐标（形态 S1：chip 留在框内、走线抬到画布层）。
 *
 * - **入参 `dx`/`dy` 由调用侧给出，已含「框外缘 `frame.dx/dy` + 框内 origin」**
 *   （{@link DG_GRID_ORIGIN_X} / {@link DG_GRID_ORIGIN_Y}）—— **算子本体不含 origin**，
 *   只管「给定多少就平移多少」，origin 的加法在调用侧（见 {@link planCanvas} 的 `routeAll`）。
 * - **平移集合 = 全部位置量**：`cells` 端点（`x/chipX/chipRight` 加 `dx`、`y/chipY/chipMidY` 加 `dy`）、
 *   `colX` 加 `dx`、`rowY` 加 `dy`、`lanes[]`（x 线）加 `dx`、`busBandTop` 加 `dy`、`busLanes[]`（y 线）加 `dy`。
 *   `colX`/`rowY` **必须随平移** —— 否则不变式 `lanes[c][i] = colX[c] + DG_NODE_W + DG_LANE_MIN + i·DG_LANE_PITCH`
 *   被破（半平移网格 = 走线静默错位）。`cellOf` 重建指向平移后的新 cells（走线经 `grid.cellOf` 取端点）。
 * - **尺寸与计数原样返回**：`width` / `height` / `cols` / `rows` / `gapW` 是内在量、不随平移改变。
 * - **R3 静默几何漂移守卫**：`busBandTop` 必须平移（被 `busLaneY` 直读）—— 漏了不报错、只让水平段静默错位。
 */
export function shiftPipeGrid(grid: PipeGridLayout, dx: number, dy: number): PipeGridLayout {
  const cells: PipeGridCell[] = grid.cells.map((c) => ({
    ...c,
    x: c.x + dx,
    y: c.y + dy,
    chipX: c.chipX + dx,
    chipY: c.chipY + dy,
    chipRight: c.chipRight + dx,
    chipMidY: c.chipMidY + dy,
  }));
  const cellOf = new Map<string, PipeGridCell>();
  for (const c of cells) cellOf.set(c.taskId, c);
  return {
    cells,
    cellOf,
    cols: grid.cols,
    rows: grid.rows,
    colX: grid.colX.map((x) => x + dx),
    rowY: grid.rowY.map((y) => y + dy),
    gapW: grid.gapW,
    lanes: grid.lanes.map((lane) => lane.map((x) => x + dx)),
    busBandTop: grid.busBandTop + dy,
    busLanes: grid.busLanes.map((y) => y + dy),
    width: grid.width,
    height: grid.height,
  };
}

// ---------------------------------------------------------------------------
// v0.10.6 C2（REQ-2026-10-12-06 · 改造文档 §2.2-C2 / §2.2.1 / §2.3）：
// 画布级布局 canvasLayout —— 与 pipeGridLayout 平级的第二枚几何单源
// （纯函数：不走线、不产 HTML、不碰 CSS 文件；尺寸数字只在本块以 DG_* 存在）
// ---------------------------------------------------------------------------

/**
 * 三枚**框内缘** CSS 变量字面（改造文档 §2.2.2「关键」行：`border + title + pad` 三级加数**全部**
 * 由 JS 单源下发 —— CSS 侧的 `--b-sp-*` 一律不得参与坐标推导，否则几何事实源裂成两处）。
 */
export const DG_FRAME_VARS = `--dg-fb:${DG_FRAME_BORDER}px;--dg-fth:${DG_FRAME_TITLE_H}px;--dg-fp:${DG_FRAME_PAD}px`;

/** {@link canvasLayout} 的一枚框（`dx/dy` = 框**外缘**左上角在画布空间的位置）。 */
export interface CanvasFrame {
  readonly projectId: string;
  /** 框左缘横坐标（= {@link DG_CANVAS_GUTTER} —— 回流档走的就是画布左右 gutter）。 */
  readonly dx: number;
  /** 框上缘纵坐标（= 上一框底缘 + 上一枚框间带高；首框 = {@link DG_CANVAS_PAD}）。 */
  readonly dy: number;
  /** 框外宽（`box-sizing:border-box` 的外盒）= `gridW + 2·(DG_FRAME_BORDER + DG_FRAME_PAD)`。 */
  readonly frameW: number;
  /** 框外高 = `gridH + 2·DG_FRAME_BORDER + DG_FRAME_TITLE_H + DG_FRAME_PAD`（标题带只在顶部、下内缘只留 pad）。 */
  readonly frameH: number;
  /** 该框 `.dg-grid` 的内在宽 / 高（原样回显，供渲染层写 inline —— 不另算一份）。 */
  readonly gridW: number;
  readonly gridH: number;
}

/** {@link canvasLayout} 的跨框走线预算入参（lane 数由走线侧回灌，与 {@link PipeGridBudget} 同款：**本函数只消费不推算** ——
 *  「由谁算、算几轮」在调用侧：框间带预算由 {@link planCanvas} 的定序不动点循环逐轮喂，本函数自身仍是一趟构图）。 */
export interface CanvasGapBudget {
  /** 第 `i` 枚**框间**通道带预留的 lane 数（长度 ≤ `框数-1`，缺省项与非正值按 0 计）。 */
  readonly gapLanes?: readonly number[];
}

/** {@link canvasLayout} 出参（全整数值）。 */
export interface CanvasLayout {
  /** 框序 = projectId 升序（与 {@link groupPipelines} 同口径 ⇒ 出参与入参数组序无关）。 */
  readonly frames: readonly CanvasFrame[];
  /** projectId → 框（走线 / 渲染侧取数面）。 */
  readonly frameOf: Map<string, CanvasFrame>;
  /** 第 `i` 枚框间带高（长度 = `框数-1`），恒 ≥ {@link DG_FRAME_GAP_MIN}。 */
  readonly gapH: readonly number[];
  /** 每枚框间带的 lane **y 线**（画布坐标；与 `gapH` 同长 —— {@link PipeGridLayout.lanes} 的换轴同构）。 */
  readonly bandLanes: readonly (readonly number[])[];
  readonly width: number;
  readonly height: number;
  /** 三枚框内缘变量字面（{@link DG_FRAME_VARS}，供渲染层在画布一枚 inline 里**一次下发**）。 */
  readonly frameVars: string;
}

/** 空画布短路出参（无框 ⇒ 宽 0、高 0、无带；每次新建，不共享可变 `frameOf`）。 */
const emptyCanvas = (): CanvasLayout => ({
  frames: [],
  frameOf: new Map(),
  gapH: [],
  bandLanes: [],
  width: 0,
  height: 0,
  frameVars: DG_FRAME_VARS,
});

/**
 * N 条管道 → 一张画布（纯函数，改造文档 §2.2-C2）：逐框固定盒矩形 + 框间通道带 + 画布尺寸。
 *
 * - **框序** = projectId 升序；`grids[i]` 与 `pipes[i]` 下标配对（**须是本框的局部网格**，未平移 ——
 *   平移由 {@link shiftPipeGrid} 在走线侧施，其 `dx/dy` = 出参 `frame.dx/dy` + 框内 origin
 *   {@link DG_GRID_ORIGIN_X}/{@link DG_GRID_ORIGIN_Y}，加法在调用侧、不在本函数）。
 * - **框外尺寸**由网格内在尺寸加框内缘：`frameW = grid.width + 2·(DG_FRAME_BORDER + DG_FRAME_PAD)`、
 *   `frameH = grid.height + 2·DG_FRAME_BORDER + DG_FRAME_TITLE_H + DG_FRAME_PAD`。
 * - **框间带高** `gapH[i] = max(DG_FRAME_GAP_MIN, 2·DG_CROSS_MIN + lanes(i)·DG_BUS_PITCH)` —— 与既有
 *   `gapW[c] = max(DG_COL_GAP_MIN, DG_LANE_MIN·2 + n·DG_LANE_PITCH)` **完全同构**（改造文档 §2.3），
 *   lane 数由走线预算经 `budget.gapLanes` 回灌。
 * - **堆叠递推**：`dy[i+1] = dy[i] + frameH[i] + gapH[i]`、`dx[i] = DG_CANVAS_GUTTER`（固定盒 ⇒ 折叠不位移）。
 * - **画布尺寸**：`width = max(frameW) + 2·DG_CANVAS_GUTTER`、`height = ΣframeH + ΣgapH + 2·DG_CANVAS_PAD`。
 * - 空管道集 ⇒ 短路 {@link emptyCanvas}。
 */
export function canvasLayout(
  pipes: readonly GraphPipeline[],
  grids: readonly PipeGridLayout[],
  budget: CanvasGapBudget = {},
): CanvasLayout {
  if (pipes.length === 0) return emptyCanvas();

  const paired = pipes
    .map((pipe, i) => ({ projectId: pipe.projectId, grid: grids[i] ?? emptyGrid() }))
    .sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));

  const frames: CanvasFrame[] = [];
  const frameOf = new Map<string, CanvasFrame>();
  const gapH: number[] = [];
  const bandLanes: number[][] = [];

  let dy = DG_CANVAS_PAD;
  paired.forEach((p, i) => {
    const frameW = p.grid.width + 2 * (DG_FRAME_BORDER + DG_FRAME_PAD);
    const frameH = p.grid.height + 2 * DG_FRAME_BORDER + DG_FRAME_TITLE_H + DG_FRAME_PAD;
    const frame: CanvasFrame = {
      projectId: p.projectId,
      dx: DG_CANVAS_GUTTER,
      dy,
      frameW,
      frameH,
      gridW: p.grid.width,
      gridH: p.grid.height,
    };
    frames.push(frame);
    frameOf.set(p.projectId, frame);
    if (i === paired.length - 1) return;

    const laneCount = Math.max(0, budget.gapLanes?.[i] ?? 0);
    const bandH = Math.max(DG_FRAME_GAP_MIN, DG_CROSS_MIN * 2 + laneCount * DG_BUS_PITCH);
    gapH.push(bandH);
    // 带内 lane 居中：上下各留 (bandH - laneCount·PITCH)/2，首线再进半格（与 busLanes 同式）
    const firstLaneY = dy + frameH + Math.floor((bandH - laneCount * DG_BUS_PITCH) / 2) + Math.floor(DG_BUS_PITCH / 2);
    bandLanes.push(Array.from({ length: laneCount }, (_, k) => firstLaneY + k * DG_BUS_PITCH));
    dy += frameH + bandH;
  });

  return {
    frames,
    frameOf,
    gapH,
    bandLanes,
    width: Math.max(...frames.map((f) => f.frameW)) + 2 * DG_CANVAS_GUTTER,
    height: frames.reduce((acc, f) => acc + f.frameH, 0) + gapH.reduce((acc, h) => acc + h, 0) + 2 * DG_CANVAS_PAD,
    frameVars: DG_FRAME_VARS,
  };
}

// ---------------------------------------------------------------------------
// v0.10.5 G3（REQ-2026-10-12-02 · 改造文档 §2.4-④ / §2.5-I2 I3 / §2.6）：
// 通道式走线 —— routeIntraEdges / arcPath / busPath（纯函数；不渲染、不产 HTML、不碰 CSS、不减交叉）
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

/**
 * 一条依赖边的走线结果（**只有 path 数据与类名，不含任何 HTML**）。
 * `adjacent` 档不占通道 ⇒ `busLane` / `lambda` / `mu` / `yb` 均为 −1。
 *
 * **v0.10.6 C3（REQ-2026-10-12-06 · 改造文档 §2.2-C3 / §2.3）**：新增第三值 `"cross"` =
 * 跨框边（两端异 project，由 {@link routeCrossFrameEdges} 产出）。该档：
 * - `colSpan` = **跨框档数**（`|目标框序 − 源框序|`，恒 ≥ 1；框序 = projectId 升序）；
 * - `lambda` = 竖直腿所落**画布通道号**（源框右缘通道 / 右 gutter —— 非 `adjacent`/`long` 的「本 grid 列内 lane」，
 *   而是画布统一的通道分席键，见改造文档 §2.3「统一装箱」）；
 * - `mu` = **恒 −1**（跨框边只有一枚竖直腿 + 一枚水平段，目标入射由末弧承接，不占目标侧通道）；
 * - `busLane` = 水平段所落**框间带 lane 号**；`yb` = 该带 lane 的 y 线（画布坐标）。
 */
export interface RoutedEdge {
  readonly from: string;
  readonly to: string;
  /** 管道内档 = 该管道内的列差（`localCol` 差）：1 ⇒ 相邻弧；≥ 2 ⇒ 长边三段。跨框档 = 跨框档数。 */
  readonly colSpan: number;
  readonly kind: "adjacent" | "long" | "cross";
  /** 底部通道带 / 框间带 lane 号（该边水平段所在 y 线的下标）。 */
  readonly busLane: number;
  /** 源侧通道（列 `a.col` 之右）的 lane 号，自源 chip 右缘起算；跨框档 = 画布通道号（见上）。 */
  readonly lambda: number;
  /** 目标侧通道（列 `b.col` 之左）的 lane 号，自目标 chip 左缘起算；跨框档恒 −1。 */
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

// ---------------------------------------------------------------------------
// v0.10.6 C3（REQ-2026-10-12-06 · 改造文档 §2.2-C3 / §2.3 / §2.5-R2 R5）：
// 跨框走线 —— crossPath 原语 + routeCrossFrameEdges（纯函数；(A) 框外公共通道带；含回流档）
// 与 routeIntraEdges **共用同一趟 packLanes**：λ / busLane 的分席键从「本 grid 列号」抬为「画布通道号」
// ⇒ 跨框线与框内线互不共段。不改 arcPath / busPath / arcK / packLanes / busLaneY 的函数体（只并列）。
// ---------------------------------------------------------------------------

/**
 * 跨框边（A 方案）：源框 chip 右缘出 → **竖直腿**（画布通道 / 框右 pad / gutter）→ **水平段**（框间带 y）
 * → **末弧**入目标框 chip 左缘。三段 = **弧—直—弧—直—弧**（每处拐角一枚 C 弧、切线连续、无硬角），
 * 控制点长沿用 {@link arcK}。入参坐标**已含 dx/dy + 框内 origin**（画布空间 —— 由 {@link shiftPipeGrid}
 * 以 `frame.dx + DG_GRID_ORIGIN_X` / `frame.dy + DG_GRID_ORIGIN_Y` 平移后的网格给出）。
 *
 * 端点定义式（I2）：首点 `(x0,y0)` = 源 `chipRight`/`chipMidY`、末点 `(x1,y1)` = 目标 `chipX`/`chipMidY`。
 * `legX` = 竖直腿所在画布通道 x；`bandY` = 水平段所在框间带 y。
 */
export function crossPath(
  x0: number,
  y0: number,
  legX: number,
  bandY: number,
  x1: number,
  y1: number,
): string {
  const sgn = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const sdir = sgn(legX - x0) || 1; // 弧1 的水平进入方向
  const vdir = sgn(bandY - y0) || 1; // 竖直腿方向（下 / 上）
  const k1 = arcK(Math.abs(legX - x0)); // 弧1（水平出 → 竖直腿）
  const k2 = arcK(Math.abs(x1 - legX)); // 弧2（竖直腿 → 水平段，肘部落框间带 y）
  const k3 = arcK(Math.abs(x1 - legX) / 2); // 弧3（水平段 → 目标左缘水平入射）
  const legTopY = y0 + vdir * k1; // 弧1 落点 = 腿起点
  const bendX = legX + sgn(x1 - legX) * k2; // 弧2 落点 = 水平段起点
  const arc3From = Math.max(bendX, x1 - k3); // 弧3 起点 x（不留负长度水平段）
  return (
    `M${x0},${y0}` +
    ` C${x0 + sdir * k1},${y0} ${legX},${y0} ${legX},${legTopY}` +
    ` L${legX},${bandY}` +
    ` C${legX},${bandY} ${legX},${bandY} ${bendX},${bandY}` +
    ` L${arc3From},${bandY}` +
    ` C${arc3From + k3},${bandY} ${x1 - k3},${y1} ${x1},${y1}`
  );
}

// ---------------------------------------------------------------------------
// v0.10.6 增补二 n6（REQ-2026-10-14-02 · 改造文档 §6 第二枚增补 A1 + A2）：
// **走廊序列走线** —— corridorPath（2k+3 段发射器）+ pickCrossCorridors（走廊选取 + 容量不等式单点）。
// 纯新增：不接进 routeCrossFrameEdges（接线 = n7）、不加 class / CSS（= n9）、不动回灌（= n8）、
// 不改 crossPath / arcPath / busPath / arcK / packLanes / busLaneY 的函数体，也不动 DG_CANVAS_* /
// DG_LANE_* / DG_COL_GAP_MIN 的数值（新增常量只**读**它们）。
// ---------------------------------------------------------------------------

/** 转角弧的最小可用段长 = `2·arcK_min`（{@link arcK} 的下界为 6、其函数体不动 ⇒ 本处以字面记其两倍）。 */
export const DG_CORRIDOR_MIN_RUN = 12;
/**
 * 转角弧控制点长的**外扩上界** —— 必须严格小于 {@link DG_LANE_MIN}（22）：弧在斜切线方向上的
 * 横向分量至多 `k`，`k < DG_LANE_MIN` ⇒ 退化段的弧也不会顶到通道两侧的 chip 边。
 */
export const DG_CORRIDOR_BULGE_MAX = 10;
/** 画布**单侧**外缘的硬容量：`DG_CANVAS_PAD + seat·DG_CORRIDOR_MARGIN_STEP` 须严格 < `DG_CANVAS_GUTTER` ⇒ 2 席（左右共 4 席）。 */
export const DG_OUTER_MARGIN_SEATS = 2;
/**
 * 外缘席间距 —— **不取 {@link DG_LANE_PITCH}**：`PAD + 1·PITCH = 22` 距框外缘（`DG_CANVAS_GUTTER = 24`）只剩 2px，
 * 而转角弧相对其弦的横向外扩上界 ≈ `0.29·DG_CORRIDOR_BULGE_MAX ≈ 2.9px` ⇒ 第二席会把弧顶进兄弟框矩形。
 * 取 `floor((GUTTER − PAD) / 2) = 8` ⇒ 席位落在 `PAD` 与带中，最内一席离框外缘留足半个留白，弧不外溢。
 */
export const DG_CORRIDOR_MARGIN_STEP = Math.floor((DG_CANVAS_GUTTER - DG_CANVAS_PAD) / 2);
/** 本框 pad 条带（左右 / 顶底）的容量 —— 一条条带只有一枚中线 ⇒ 1 席。 */
export const DG_PAD_STRIP_SEATS = 1;
/**
 * 【n8d 新增常量（不改动任何既有 `DG_*` 数值）】入点侧向让位的**席位间距**。
 * 取 `floor(DG_NODE_H / 4) = 7` ⇒ 首两席落在**自身行 chip 带内**（`chipMidY ± 7`，该 x 区间在本行
 * 结构性无 chip —— 由入口短桩合法性 `rowLeftLimit` 保证），且行间距 `DG_NODE_H / 2 = 14` 留出半个 chip 高
 * 给转角弧外扩（上界 `DG_CORRIDOR_BULGE_MAX`）。
 */
export const DG_APPROACH_SEAT_PITCH = Math.floor(DG_NODE_H / 4);
/**
 * 【n8d 新增】让位**幅度上界** = `DG_NODE_H / 2` = 自身行 chip 半高 ⇒ 分层线不出自身行的 chip 带，
 * 相邻行 chip 由 `rectFree` 障碍判据兜住（保守含 `DG_CORRIDOR_BULGE_MAX` 外扩余量）。超出 ⇒ 不分层。
 */
export const DG_APPROACH_MAX_OFF = DG_NODE_H / 2;
/**
 * 【n8d 新增】末段折点自目标左缘**提前量** `bendX = x1 − 该量` —— 必须 ≤ 判据面的共端点豁免半径
 * （`G5_END_EXEMPT_PX = 24`，判据常量不入本单元），否则分层后各边自己的入点短桩仍在豁免圈外共段。
 * 取 18 = 24 留 6px 给末弧的外扩。
 */
export const DG_APPROACH_LEAD = 18;

/**
 * 走廊门类（改造文档 §6 第二枚增补「4 走廊清单」的 7 类，左右 / 顶底各占一枚取值 ⇒ 8 枚取值）：
 * `CH` 列间通道 · `PL`/`PR` 本框左右 pad 条带 · `ML`/`MR` 画布左右外缘 ·
 * `BD` 框间带（中段专用）· `PB`/`PT` 本框顶底 pad 横条（超载兜底）。
 */
export type CrossCorridorKind = "CH" | "PL" | "PR" | "ML" | "MR" | "BD" | "PB" | "PT";

/**
 * 一枚走廊 = 画布上一条**结构上无 chip** 的线。
 *
 * 无 chip 性由构造保证（不是运行时校验）：`CH` 在两列 chip 之间（左右各留 ≥ `DG_LANE_MIN`）、
 * `PL`/`PR` 在框边框与本框内容左/右内缘之间（该竖带在所有行上都没有 chip）、`ML`/`MR` 在全部框之外、
 * `BD` 在两框之间的带内、`PB`/`PT` 在本框上下 pad 横条（该 y 上只有本框存在 ⇒ 横向也不会进兄弟框）。
 */
export interface CrossCorridor {
  /** 稳定 id（跨边可比对：同一 id ⇒ 同一条线，装箱据此判共段）。 */
  readonly id: string;
  readonly kind: CrossCorridorKind;
  /** `v` = 竖直腿（`at` 为 x 线）；`h` = 水平段（`at` 为 y 线）。 */
  readonly axis: "v" | "h";
  readonly at: number;
  /** 归属框 projectId；`ML` / `MR` / `BD` 无单一归属 ⇒ 空串。 */
  readonly owner: string;
  /** 该走廊内的席位下标（自 0 起）。 */
  readonly seat: number;
  /** 该走廊的容量（`seat < capacity` 才放得下；超载时本字段就是不等式的右端）。 */
  readonly capacity: number;
}

/** 一条走廊边用到的席号（由调用侧（n7 装箱）给出，缺省全 0 = 首席；本函数**不自己排队**）。 */
export interface CrossCorridorSeats {
  /** 出口竖腿在其降档序列内的席。 */
  readonly exit?: number;
  /** 入口竖腿在其降档序列内的席。 */
  readonly entry?: number;
  /** 长竖腿在画布外缘的总席基准（`0..2·DG_OUTER_MARGIN_SEATS·2−1` 取模；偶数左、奇数右）。 */
  readonly margin?: number;
  /** 长横在各框间带内的 lane 偏移（各带共用同一偏移 ⇒ 多枚边的带内线两两不同 y）。 */
  readonly band?: number;
}

/** {@link pickCrossCorridors} 的入参（端点走**画布坐标** —— 与 {@link CanvasGrids.grids} 同一参照系）。 */
export interface CrossCorridorInput {
  readonly fromProject: string;
  readonly toProject: string;
  /** 源 chip（已含 `frame.dx/dy` + 框内 origin）。 */
  readonly a: PipeGridCell;
  /** 目标 chip（同上）。 */
  readonly b: PipeGridCell;
  /** projectId → 已平移网格（{@link CanvasGrids} 的 `grids`）。 */
  readonly grids: ReadonlyMap<string, PipeGridLayout>;
  readonly layout: CanvasLayout;
  readonly seats?: CrossCorridorSeats;
}

/**
 * {@link pickCrossCorridors} 出参 = **走廊序列 + 每腿坐标**（`corridorPath`、后续装箱、n8 判据的同一数据源）。
 *
 * - `points` = 折线顶点（画布坐标），**枚数 = 2k+4 ⇒ 段数 = 2k+3**（首末各一枚短桩、中间 k 枚带内线交替）；
 * - `corridors` = 段序对应的走廊（**首末短桩为 `null`** —— 短桩的落点由 I2 端点定义式固定、不是走廊），
 *   其中非 null 者共 `2k+1` 枚（竖腿 `k+1` + 带内长横 `k`）；
 * - `overCapacity` = 任一档「席号 ≥ 容量」⇒ 该腿/该带**复用首席**（X3 政策丙：登记超载、不放宽判据、
 *   也不让腿漂进 chip ⇒ 超载只降级为**共段**，不降级为**穿模**）。
 */
export interface CrossCorridorPlan {
  /** 跨框档数 `= |tIdx − sIdx|`（恒 ≥ 1）。 */
  readonly k: number;
  /** `1` = 正向（目标框在下方）；`−1` = 回流。 */
  readonly dir: 1 | -1;
  /** 出口带 index（源框紧邻、朝目标那一侧）。 */
  readonly exitBand: number;
  /** 入口带 index（目标框紧邻、朝源那一侧）；`k === 1` 时与 `exitBand` 同一枚。 */
  readonly entryBand: number;
  readonly points: readonly (readonly [number, number])[];
  /** 与 `corridorPath` 的各段一一对应（长度 = `points.length − 1`；首末短桩 = `null`）。 */
  readonly corridors: readonly (CrossCorridor | null)[];
  readonly overCapacity: boolean;
}

/** 本行 y 上、该 cell 右侧最近一枚 chip 的左缘（无 ⇒ `+Infinity`，即「本行末列」）。 */
const rowRightLimit = (grid: PipeGridLayout, cell: PipeGridCell): number => {
  let lim = Number.POSITIVE_INFINITY;
  for (const c of grid.cells) {
    if (c.chipMidY === cell.chipMidY && c.chipX > cell.chipRight && c.chipX < lim) lim = c.chipX;
  }
  return lim;
};

/** 本行 y 上、该 cell 左侧最近一枚 chip 的右缘（无 ⇒ `−Infinity`，即「本行首列」）。 */
const rowLeftLimit = (grid: PipeGridLayout, cell: PipeGridCell): number => {
  let lim = Number.NEGATIVE_INFINITY;
  for (const c of grid.cells) {
    if (c.chipMidY === cell.chipMidY && c.chipRight < cell.chipX && c.chipRight > lim) lim = c.chipRight;
  }
  return lim;
};

/**
 * 一枚竖腿的**三档降档序列**（改造文档 A2）：`CH(本列通道)` → `PL`/`PR`（本框 pad 条带）→ `ML`/`MR`（画布外缘）。
 *
 * 每档都要过**短桩合法性**这一道：出口短桩自 chip **右缘**向右走到腿 x，入口短桩自腿 x 向右走到 chip
 * **左缘** ⇒ 该 x 与本 chip 之间在本行 y 上不得有任何 chip（`rowRightLimit` / `rowLeftLimit`）。
 * 于是 `PL`/`PR`/`ML`/`MR` 这些「远档」只在**本行首列 / 末列**时合法（= 场景表 g 的降档），
 * 中间列的边即便通道坐满也不会把短桩横压过兄弟 chip。
 */
const legCorridorLadder = (
  grid: PipeGridLayout | undefined,
  frame: CanvasFrame | undefined,
  cell: PipeGridCell,
  side: "exit" | "entry",
  layout: CanvasLayout,
): CrossCorridor[] => {
  if (grid === undefined || frame === undefined) return [];
  const out: CrossCorridor[] = [];
  // ---- 档 1：本列通道（出口 = 本列之右、入口 = 本列之左）----
  const chCol = side === "exit" ? cell.col : cell.col - 1;
  const limit = side === "exit" ? rowRightLimit(grid, cell) : rowLeftLimit(grid, cell);
  const legal = (grid.lanes[chCol] ?? []).filter((x) =>
    side === "exit" ? x > cell.chipRight && x < limit : x < cell.chipX && x > limit,
  );
  // **未预算通道的 λ=0 线兜底（n7 接线面）**：`gapLanes` 的回灌只覆盖**本框有腿落进去的那些通道**
  // （框内 long 腿 + 本框跨框腿 = n8a 框内侧；画布侧不动点 = n8b）⇒ 首 / 末列、以及两端都不在本框的
  // 通道仍可能一席未预算。但通道**仍是结构性无 chip 的**（`gapW ≥ DG_COL_GAP_MIN
  // = 2·DG_LANE_MIN + 12` ⇒ lane0 距两侧 chip 缘分别 ≥ 22 / ≥ 34），故取该通道的 λ=0 线作**单席**候选
  // —— 容量记 1 ⇒ 第二席一律 `overCapacity` 出声并复用首席（X3 丙：降级为共段、不降级为穿模），
  // **不得**让腿因「本列无预算」而整条消失（丢边 = 边不落账，比共段更坏）。
  if (legal.length === 0 && chCol >= 0 && chCol < grid.lanes.length) {
    const base = columnBaseX(grid, chCol);
    if (side === "exit" ? base > cell.chipRight && base < limit : base < cell.chipX && base > limit)
      legal.push(base);
  }
  legal.forEach((x, i) => {
    out.push({ id: `CH:${frame.projectId}:${chCol}:${i}`, kind: "CH", axis: "v", at: x, owner: frame.projectId, seat: i, capacity: legal.length });
  });
  // ---- 档 2 / 档 3：只在「本行首列 / 末列」合法（短桩不得压过任何兄弟 chip）----
  if (Number.isFinite(limit)) return out; // 本行另有兄弟 chip ⇒ 远档结构性不可用
  const isExit = side === "exit";
  const pad = DG_FRAME_BORDER + Math.floor(DG_FRAME_PAD / 2);
  const strip = isExit ? frame.dx + frame.frameW - pad : frame.dx + pad;
  out.push({
    id: `${isExit ? "PR" : "PL"}:${frame.projectId}`,
    kind: isExit ? "PR" : "PL",
    axis: "v",
    at: strip,
    owner: frame.projectId,
    seat: 0,
    capacity: DG_PAD_STRIP_SEATS,
  });
  const marginAt = (seat: number): number =>
    isExit
      ? layout.width - DG_CANVAS_PAD - seat * DG_CORRIDOR_MARGIN_STEP
      : DG_CANVAS_PAD + seat * DG_CORRIDOR_MARGIN_STEP;
  for (let seat = 0; seat < DG_OUTER_MARGIN_SEATS; seat += 1) {
    const at = marginAt(seat);
    // i7 严格不等式：外缘腿须**整个落在框外**（左缘 < 框左缘、右缘 > 框右缘）
    const outside = isExit ? at > frame.dx + frame.frameW : at < frame.dx;
    if (!outside) continue;
    out.push({
      id: `${isExit ? "MR" : "ML"}:${seat}`,
      kind: isExit ? "MR" : "ML",
      axis: "v",
      at,
      owner: "",
      seat,
      capacity: DG_OUTER_MARGIN_SEATS,
    });
  }
  return out;
};

/**
 * 一枚框间带的第 `seat` 线。
 *
 * - 带内**有**预留 lane ⇒ 取该线；`seat ≥ capacity` 复用首席并出声 `over`（X3 丙：共段不穿模）。
 * - 带存在但**未**预留 lane（本版回灌口径 = 现装箱实占数，n8 之前新算法要的带可能还是空的）⇒
 *   取**带中线**：带高恒 ≥ {@link DG_FRAME_GAP_MIN} ⇒ 该 y 上结构性无 chip，但容量记 0 ⇒ 一律出声 `over`
 *   （「用了一条没分配席位的带」必须可见，不得静默）。
 * - 带本身不存在（框缺失 / 带高非正）⇒ `null`，交 `PB`/`PT` 顶底 pad 横条兜底。
 */
const bandCorridor = (layout: CanvasLayout, band: number, seat: number): { corridor: CrossCorridor; over: boolean } | null => {
  const lanes = layout.bandLanes[band];
  const capacity = lanes?.length ?? 0;
  if (lanes !== undefined && capacity > 0) {
    const over = seat >= capacity;
    const at = lanes[over ? 0 : seat] ?? 0;
    return {
      corridor: { id: `BD:${band}:${over ? 0 : seat}`, kind: "BD", axis: "h", at, owner: "", seat: over ? 0 : seat, capacity },
      over,
    };
  }
  const own = layout.frames[band];
  const gapH = layout.gapH[band] ?? 0;
  if (own === undefined || gapH <= 0) return null;
  return {
    corridor: {
      id: `BD:${band}:mid`,
      kind: "BD",
      axis: "h",
      at: own.dy + own.frameH + Math.floor(gapH / 2),
      owner: "",
      seat: 0,
      capacity: 0,
    },
    over: true,
  };
};

/** 超载兜底 = 本框顶 / 底 pad 横条（`PB`/`PT`，1 席）—— 该 y 上只有本框存在 ⇒ 横向也不进兄弟框。 */
const padStripCorridor = (frame: CanvasFrame | undefined, top: boolean): CrossCorridor | null => {
  if (frame === undefined) return null;
  const at = top
    ? frame.dy + DG_FRAME_BORDER + Math.floor(DG_FRAME_PAD / 2)
    : frame.dy + frame.frameH - DG_FRAME_BORDER - Math.floor(DG_FRAME_PAD / 2);
  return {
    id: `${top ? "PT" : "PB"}:${frame.projectId}`,
    kind: top ? "PT" : "PB",
    axis: "h",
    at,
    owner: frame.projectId,
    seat: 0,
    capacity: DG_PAD_STRIP_SEATS,
  };
};

/**
 * 降档取席：`seat` = **展平候选序列的下标**（档 1 的各 lane、档 2 的 pad 条带、档 3 的外缘席依次排开），
 * 越界 ⇒ 复用序列首枚并出声 `over`（X3 政策丙：超载降级为**共段**、绝不降级为**穿模**）。
 * 出参 `corridor.seat` 仍是**该走廊族内的席号**（装箱判共段吃 `id`，不吃下标）。
 */
const pickLadder = (ladder: readonly CrossCorridor[], seat: number): { corridor: CrossCorridor; over: boolean } | null => {
  const hit = ladder[seat];
  if (hit !== undefined) return { corridor: hit, over: false };
  const first = ladder[0];
  if (first === undefined) return null;
  return { corridor: first, over: true };
};

/**
 * **走廊选取 + 容量不等式集中一处**（纯函数，改造文档 §6 第二枚增补 A2）。
 *
 * - 出口带 / 入口带按 `dir` 定（`dir>0` ⇒ 出口带 = `sIdx`、入口带 = `tIdx−1`；回流对称）⇒
 *   竖腿只在「本框 ↔ 紧邻带」之间走，**结构上不会纵穿任何兄弟框**（件一第二机制的消解处）。
 * - `k ≥ 2` 的长竖腿一律落 `ML`/`MR`（画布外缘，硬容量 2+2 = 4 席）—— 中间框的列通道逐框各算、
 *   x 互不对齐 ⇒ 「逐框穿列通道」不在候选里（那也是 §2.4 已裁不走的替代形）。
 * - `k === 1` 时出口带 = 入口带 ⇒ 中段自然只一枚 H（统一律的特例，**不是另一套分支**）。
 * - 出参 `points` / `corridors` 与 {@link corridorPath} 的入参 / 段序**一一对应**（同一数据源）。
 * - 两端同框、任一框取不到 ⇒ `null`（跨框档结构上不成立）。
 */
export function pickCrossCorridors(input: CrossCorridorInput): CrossCorridorPlan | null {
  const { a, b, grids, layout } = input;
  const sIdx = layout.frames.findIndex((f) => f.projectId === input.fromProject);
  const tIdx = layout.frames.findIndex((f) => f.projectId === input.toProject);
  if (sIdx < 0 || tIdx < 0 || sIdx === tIdx) return null;
  const k = Math.abs(tIdx - sIdx);
  const dir: 1 | -1 = tIdx > sIdx ? 1 : -1;
  const exitBand = dir > 0 ? sIdx : sIdx - 1;
  const entryBand = dir > 0 ? tIdx - 1 : tIdx;
  const seats = input.seats ?? {};

  const ga = grids.get(input.fromProject);
  const gb = grids.get(input.toProject);
  const fa = layout.frames[sIdx];
  const fb = layout.frames[tIdx];
  const exitLadder = legCorridorLadder(ga, fa, a, "exit", layout);
  const entryLadder = legCorridorLadder(gb, fb, b, "entry", layout);
  const pickedExit = pickLadder(exitLadder, seats.exit ?? 0);
  let pickedEntry = pickLadder(entryLadder, seats.entry ?? 0);
  if (pickedExit === null || pickedEntry === null) return null;
  // 出口腿与入口腿同 x ⇒ 中段 H 塌成零长、两枚竖腿并成一枚 ⇒ 段数掉到 2k+1。同 x 时入口改取次席（多占一席，不并段）。
  if (pickedEntry.corridor.at === pickedExit.corridor.at) {
    const next = entryLadder.find((c) => c.at !== pickedExit.corridor.at);
    if (next !== undefined) pickedEntry = { corridor: next, over: true };
  }

  const legOver = pickedExit.over || pickedEntry.over;
  const x0 = a.chipRight;
  const y0 = a.chipMidY;
  const x1 = b.chipX;
  const y1 = b.chipMidY;
  const exitX = pickedExit.corridor.at;
  const entryX = pickedEntry.corridor.at;

  /** 第 `j` 枚带（自源侧数到目标侧）的 y 线；带内无 lane ⇒ 带中线（{@link bandCorridor}），带缺失 ⇒ 本框顶 / 底 pad 横条兜底（场景 h 的最后一段）。 */
  const bandAt = (j: number): { corridor: CrossCorridor; over: boolean } => {
    const band = dir > 0 ? sIdx + j : sIdx - 1 - j;
    const hit = bandCorridor(layout, band, seats.band ?? 0);
    if (hit !== null) return hit;
    const own = dir > 0 ? (j === 0 ? fa : fb) : j === k - 1 ? fb : fa;
    const strip = padStripCorridor(own, dir > 0 ? j === 0 : j === k - 1);
    if (strip !== null) return { corridor: strip, over: true };
    // 兜底也取不到（框缺失）⇒ 结构上不成形，交上层按 `null` 处理
    return { corridor: { id: `BD:${band}:-`, kind: "BD", axis: "h", at: y0, owner: "", seat: 0, capacity: 0 }, over: true };
  };

  /** 第 `j` 枚长竖腿（`k ≥ 2` 才有）落的画布外缘席。 */
  const marginAt = (j: number): { corridor: CrossCorridor; over: boolean } => {
    const total = DG_OUTER_MARGIN_SEATS * 2;
    const mSeat = (((seats.margin ?? 0) + (j - 1)) % total + total) % total;
    const left = mSeat < DG_OUTER_MARGIN_SEATS;
    const at = left
      ? DG_CANVAS_PAD + mSeat * DG_CORRIDOR_MARGIN_STEP
      : layout.width - DG_CANVAS_PAD - (mSeat - DG_OUTER_MARGIN_SEATS) * DG_CORRIDOR_MARGIN_STEP;
    // i7 严格不等式：外缘腿须整个落在**全部框之外**（左 < 框左缘、右 > 最右框右缘）—— 违式即硬容量溢出
    const rightEdge = DG_CANVAS_GUTTER + layout.frames.reduce((mx, f) => Math.max(mx, f.frameW), 0);
    return {
      corridor: { id: `${left ? "ML" : "MR"}:${mSeat}`, kind: left ? "ML" : "MR", axis: "v", at, owner: "", seat: mSeat, capacity: total },
      over: left ? at >= DG_CANVAS_GUTTER : at <= rightEdge,
    };
  };

  // ---- 顶点序（**2k+4 枚 ⇒ 段数 2k+3**）----
  // `P0 右缘 → P1 出口腿x（短桩 H）→ P2 带0（V）→ [j=1..k−1: 外缘x（H）→ 带j（V)] → 入口腿x（H）→ y1（V）→ P末 左缘（H）`
  const bands: { corridor: CrossCorridor; over: boolean }[] = [];
  for (let j = 0; j < k; j += 1) bands.push(bandAt(j));
  const longs: { corridor: CrossCorridor; over: boolean }[] = [];
  for (let j = 1; j < k; j += 1) longs.push(marginAt(j));

  // 不变式：`corridors.length === points.length - 1 === 2k+3`（每枚顶点对应一枚**落到该点**的段）
  const points: [number, number][] = [[x0, y0]];
  const corridors: (CrossCorridor | null)[] = [];
  points.push([exitX, y0]);
  corridors.push(null); // 出口短桩：落点由 I2 端点定义式固定 ⇒ 不占走廊
  points.push([exitX, bands[0]?.corridor.at ?? y0]);
  corridors.push(pickedExit.corridor); // 出口竖腿（CH / PL / PR / ML / MR 之一）
  for (let j = 0; j < k - 1; j += 1) {
    const longX = longs[j]?.corridor.at ?? exitX;
    points.push([longX, bands[j]?.corridor.at ?? y0]);
    corridors.push(bands[j]?.corridor ?? null); // 带 j 内长横
    points.push([longX, bands[j + 1]?.corridor.at ?? y1]);
    corridors.push(longs[j]?.corridor ?? null); // 画布外缘长竖
  }
  points.push([entryX, bands[k - 1]?.corridor.at ?? y1]);
  corridors.push(bands[k - 1]?.corridor ?? null); // 最后一枚带内长横
  points.push([entryX, y1]);
  corridors.push(pickedEntry.corridor); // 入口竖腿
  points.push([x1, y1]);
  corridors.push(null); // 入点短桩

  // 统一退化律的**出声面**：任一段短于 `2·arcK_min` ⇒ {@link corridorPath} 会并段（段数 < 2k+3），
  // 与「席不够」同档登记 —— 判据只看构造出的顶点序，不重复一遍几何。
  const tight = points.some((p, i) => {
    if (i === 0) return false;
    const prev = points[i - 1];
    if (prev === undefined) return false;
    return Math.abs(p[0] - prev[0]) + Math.abs(p[1] - prev[1]) < DG_CORRIDOR_MIN_RUN;
  });

  const overCapacity =
    legOver ||
    bands.some((x) => x.over) ||
    longs.some((x) => x.over) ||
    tight;
  return { k, dir, exitBand, entryBand, points, corridors, overCapacity };
}

/** 相邻两顶点的单位方向（零长 ⇒ `null`）。 */
const runUnit = (p: readonly [number, number], q: readonly [number, number]): readonly [number, number] | null => {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return [dx / len, dy / len];
};

/**
 * 转角处的**公共切线** = 入射 / 出射两单位向量的和归一化（两两正交 ⇒ `±45°` 角平分线）。
 * 相邻两段同轴且同向 ⇒ 返回该向（= 该转角被拉平、由 {@link corridorPath} 的塌缩步并段）。
 */
const jointTangent = (
  din: readonly [number, number] | null,
  dout: readonly [number, number] | null,
): readonly [number, number] | null => {
  if (din === null) return dout;
  if (dout === null) return din;
  const sx = din[0] + dout[0];
  const sy = din[1] + dout[1];
  const len = Math.hypot(sx, sy);
  if (len < 1e-9) return dout; // 180° 折返（结构上不该出现）⇒ 沿出射方向，交给塌缩
  return [sx / len, sy / len];
};

/**
 * **走廊序列发射器**（纯函数，改造文档 §6 第二枚增补 A1）：把 {@link pickCrossCorridors} 的顶点序
 * 展成 path 数据 —— **一枚走廊段一枚命令** ⇒ 顶点数 `2k+4` 时命令枚数 = 段数 = `2k+3`、转角 = `2k+2`。
 *
 * - **每转角一枚 C 弧**：相邻两段在转角处共享同一条切线（{@link jointTangent}）⇒ 整条线 **C¹ 连续、无硬角**。
 * - **首弧控制点 y 不再全 = `y0`**（件一根因的单点消解）：首枚弧的第二控制点落在转角切线上
 *   （`P1 − k·t1`，`t1` 是「短桩 H × 竖腿 V」的角平分线 ⇒ 纵分量恒非零）⇒ 曲线**不再贴源行横扫**，
 *   水平位移被拆进「短桩 + 带内长横」两处，中间的长竖只走列通道 / 外缘。
 * - **统一退化律（并段）**：① 重合顶点先删；② 删后三点同轴（同 x 或同 y）⇒ 中间顶点并掉；
 *   ③ 段长 `< 2·arcK_min` 时控制点长被 clamp 到 `段长/2` 以下 ⇒ 该转角弧退化为一枚直段，
 *   不需要为「源 / 目标同高」（场景 f）另开分支。
 * - **不外扩**：控制点长 `= min(arcK(段长), 段长/2, DG_CORRIDOR_BULGE_MAX)`，且
 *   `DG_CORRIDOR_BULGE_MAX < DG_LANE_MIN` ⇒ 弧的横向分量顶不到通道两侧的 chip（穿模判据仍 0）。
 * - 入参坐标 = 画布空间（与 {@link CanvasGrids.grids} 同一参照系）。
 */
export function corridorPath(points: readonly (readonly [number, number])[]): string {
  // ---- 塌缩：删重合顶点，再把同轴的相邻段并成一段 ----
  const pts: [number, number][] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (last !== undefined && Math.abs(last[0] - p[0]) < 1 && Math.abs(last[1] - p[1]) < 1) continue;
    pts.push([p[0], p[1]]);
  }
  for (let i = 1; i + 1 < pts.length; ) {
    const prev = pts[i - 1];
    const mid = pts[i];
    const next = pts[i + 1];
    if (prev === undefined || mid === undefined || next === undefined) break;
    const sameX = Math.abs(prev[0] - mid[0]) < 1 && Math.abs(mid[0] - next[0]) < 1;
    const sameY = Math.abs(prev[1] - mid[1]) < 1 && Math.abs(mid[1] - next[1]) < 1;
    if (sameX || sameY) pts.splice(i, 1);
    else i += 1;
  }
  if (pts.length < 2) return "";
  const head = pts[0];
  const tail = pts[pts.length - 1];
  if (head === undefined || tail === undefined) return "";
  if (pts.length === 2) return arcPath(head[0], head[1], tail[0], tail[1]);

  // ---- 每枚顶点的切线（首末 = 水平 ⇒ I2 端点式；中间 = 转角角平分线）----
  const dirs: (readonly [number, number] | null)[] = [];
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const from = pts[i];
    const to = pts[i + 1];
    dirs.push(from !== undefined && to !== undefined ? runUnit(from, to) : null);
  }
  const tangents: (readonly [number, number])[] = [];
  pts.forEach((_p, i) => {
    if (i === 0) {
      tangents.push([1, 0]);
      return;
    }
    if (i === pts.length - 1) {
      tangents.push([1, 0]);
      return;
    }
    const t = jointTangent(dirs[i - 1] ?? null, dirs[i] ?? null);
    tangents.push(t ?? dirs[i] ?? [1, 0]);
  });

  let d = `M${head[0]},${head[1]}`;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const from = pts[i];
    const to = pts[i + 1];
    const tin = tangents[i];
    const tout = tangents[i + 1];
    if (from === undefined || to === undefined || tin === undefined || tout === undefined) continue;
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const k = Math.min(arcK(len), Math.floor(len / 2), DG_CORRIDOR_BULGE_MAX);
    const c1x = Math.round(from[0] + tin[0] * k);
    const c1y = Math.round(from[1] + tin[1] * k);
    const c2x = Math.round(to[0] - tout[0] * k);
    const c2y = Math.round(to[1] - tout[1] * k);
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${to[0]},${to[1]}`;
  }
  return d;
}

/**
 * **入点侧向让位**（n8d · 目标端口汇聚的「单点共段」消解处）：同一目标 chip 左缘中点汇聚多枚跨框边时，
 * 按调用方给定的**秩**把**接近线**沿 y 分层，末尾再各自弯回 `chipMidY` 水平入射 —— **件三**（起点 = 源右缘中点、
 * 终点 = 目标左缘中点）由「只改末两枚顶点之前、不动末点」由构造保证。
 *
 * - **首席 = 秩 0 ⇒ 逐字不动**（返回入参数组本身）：单入边端口、以及同端口多条边的第一条，走线形状与既有
 *   锚面完全一致。
 * - **分层方向交替、先让到来带一侧**（秩 1 → 来带侧 `+pitch`、秩 2 → 另一侧 `−pitch`、秩 3 → `+2·pitch`…）：
 *   首席的入点短桩其转角弧向**背离来带**那一侧外扩 ⇒ 让位先占来带侧，避免与那道外扩贴线。
 * - **不得漂出通道 / 不得穿兄弟框**：分层几何（横段 + 折点竖段 + 外扩余量 `DG_CORRIDOR_BULGE_MAX`）整块须落在
 *   {@link rectFree} 之外 —— 障碍集 = §2.3 画布障碍集（全部 chip ∪ 兄弟框，本边两枚端点 chip 与本边两框除外）。
 * - **席位不足 ⇒ 不硬挤**：`|off| > DG_APPROACH_MAX_OFF`、或该档放不下（分层横段短于
 *   {@link DG_CORRIDOR_MIN_RUN}）、或落在障碍上 ⇒ 返回原顶点序 = **复用首席的共段形态**（X3 政策丙：
 *   降级为共段、绝不降级为穿模），与 `pickCrossCorridors` 的超载处置同形。
 * - 入参 = {@link pickCrossCorridors} 的 `points`（末两枚恒为 `(entryX, y1)` → `(x1, y1)`）；出参直接交
 *   {@link corridorPath}（其塌缩律会把 `off = 0` 的退化形态并回原两段 ⇒ 无旁路形状）。
 */
export function layerCrossApproach(
  points: readonly (readonly [number, number])[],
  rank: number,
  rectFree: (x0: number, x1: number, y0: number, y1: number) => boolean,
): readonly (readonly [number, number])[] {
  if (rank <= 0 || points.length < 4) return points;
  const end = points[points.length - 1];
  const leg = points[points.length - 2];
  const prev = points[points.length - 3];
  if (end === undefined || leg === undefined || prev === undefined) return points;
  const x1 = end[0] ?? 0;
  const y1 = end[1] ?? 0;
  const entryX = leg[0] ?? 0;
  const bandY = prev[1] ?? 0;
  if (leg[1] !== y1) return points; // 末段形状非「竖腿 → 水平短桩」⇒ 不动（保守）
  const dirX = x1 > entryX ? 1 : x1 < entryX ? -1 : 0;
  if (dirX === 0) return points; // 腿正对左缘 ⇒ 无接近段可分层
  const toBand = bandY > y1 ? 1 : bandY < y1 ? -1 : 1;
  const off = (rank % 2 === 1 ? 1 : -1) * Math.ceil(rank / 2) * DG_APPROACH_SEAT_PITCH * toBand;
  if (Math.abs(off) > DG_APPROACH_MAX_OFF) return points;
  const yApp = y1 + off;
  const bendX = x1 - dirX * DG_APPROACH_LEAD;
  if (Math.abs(bendX - entryX) < DG_CORRIDOR_MIN_RUN) return points;
  const lo = Math.min(entryX, bendX, x1) - DG_CORRIDOR_BULGE_MAX;
  const hi = Math.max(entryX, bendX, x1) + DG_CORRIDOR_BULGE_MAX;
  const yLo = Math.min(y1, yApp) - DG_CORRIDOR_BULGE_MAX;
  const yHi = Math.max(y1, yApp) + DG_CORRIDOR_BULGE_MAX;
  if (!rectFree(lo, hi, yLo, yHi)) return points;
  return [
    ...points.slice(0, points.length - 2),
    [entryX, yApp],
    [bendX, yApp],
    [bendX, y1],
    [x1, y1],
  ];
}

/** 跨框走线的画布几何包（{@link canvasLayout} 出参 + 各框**已平移**网格）。 */
export interface CanvasGrids {
  readonly layout: CanvasLayout;
  /** projectId → 该框在画布空间的网格（{@link shiftPipeGrid} 施过 `frame.dx/dy` + 框内 origin —— 端点已含偏移）。 */
  readonly grids: ReadonlyMap<string, PipeGridLayout>;
}

/** 一条跨框边（两端异 project）—— 端点 taskId + 各自 projectId（取数走 {@link CanvasGrids}）。 */
export interface CrossEdge {
  readonly from: string;
  readonly to: string;
  readonly fromProject: string;
  readonly toProject: string;
}

/** 一列内某框的画布通道基准 x（该列 chip 右缘 + `DG_LANE_MIN` = λ=0 线；{@link pipeGridLayout} 的 `lanes[c][0]` 同式）。 */
const columnBaseX = (grid: PipeGridLayout, col: number): number =>
  (grid.colX[col] ?? grid.colX[grid.colX.length - 1] ?? DG_PAD_L) + DG_NODE_W + DG_LANE_MIN;

/**
 * 全部**跨框边**走线（纯函数，改造文档 §2.2-C3 / §2.3 · **v0.10.6 增补二 n7 接线到走廊序列**）。
 *
 * - 入参 `crossEdges` = `kept` 中两端异 project 者；`canvasGrids` = {@link CanvasGrids}；
 *   `intraRoutes` = {@link routeIntraEdges} 在**同一批已平移网格**上的产出（用于统一装箱、避免共段）。
 * - **端点**沿用 I2：源 `chipRight`/`chipMidY` 出、目标 `chipX`/`chipMidY` 入（坐标**已含 dx/dy**）。
 * - **出参 `d` = {@link corridorPath}(plan.points)**（A1/A2 走廊序列形，`2k+3` 段全 C）：
 *   走廊选取与容量不等式集中在 {@link pickCrossCorridors}，本函数只管**分席（装箱）**。
 * - **(b) 出口带 / 入口带按 `dir` 定**：`dir>0` ⇒ 出口带 `sIdx`、入口带 `tIdx−1`；回流对称
 *   （由 {@link pickCrossCorridors} 单点承载）。同源扇出的多枚边共用出口腿 = **合法共端点**（i4），
 *   装箱**不判叠** —— 同腿只在 y 区间真交叠时才另起席号（{@link packLanes}）。
 * - **(c) 竖腿按三档走廊降档取位**：`CH(本列通道)` → `PL`/`PR`（本框 pad 条带）→ `ML`/`MR`（画布外缘）
 *   （{@link legCorridorLadder}）；本侧新增**装箱前的 i2 预检** —— `PL`/`PR` 的 pad 条带线必须**严格落在
 *   本框矩形内**（`frame.dx < at < frame.dx + frame.frameW`），否则末列腿会落进兄弟框 ⇒ 该档整条剔除。
 *   外缘档的取等边界（i7 **严格 `>`**）在 {@link legCorridorLadder} / {@link pickCrossCorridors} 内，本处不重述。
 * - **(d) 带装箱支持一枚边占两枚带**：`k ≥ 2` ⇒ 出口带 ≠ 入口带 ⇒ 本边**同时登记进两枚带**的装箱组，
 *   `busLane` 取两组的**最大值**（i3：只登记一枚 ⇒ 第二枚带被别边重复分配）。
 * - **(e) λ 不超过该通道已预算的 lane 数**：`λ = intraCeil + 1 + (席号 mod 该通道席数)`
 *   （席号由 {@link packLanes} 给出，可能超出 `grid.lanes` 回灌的容量 ⇒ 按容量取模 = **共段**，不漂出 `gapW`）。
 * - **确定性**：定序 =（源 projectId 升序, 源号序, 目标号序, from, to）⇒ 乱序入参出参逐字段相等。
 * - 不减交叉（用户已裁：允许交叉、只禁共段）；两端任一取不到 cell ⇒ 结构上不入（跳过）。
 * - **i8（白名单）**：跨框腿 / 带内长横与**本框自己的**底部 bus 带允许交叉 —— 画布级判据不吃这一形。
 */
export function routeCrossFrameEdges(
  crossEdges: readonly CrossEdge[],
  canvasGrids: CanvasGrids,
  intraRoutes: readonly RoutedEdge[],
): readonly RoutedEdge[] {
  const { layout, grids } = canvasGrids;

  // projectId → 框序（layout.frames 已 projectId 升序）；taskId → projectId（intra 腿登记用）
  const frameIndex = new Map<string, number>();
  layout.frames.forEach((f, i) => frameIndex.set(f.projectId, i));
  const ownerOf = new Map<string, string>();
  for (const [pid, g] of grids) for (const c of g.cells) ownerOf.set(c.taskId, pid);

  /** 画布通道分席键：把通道基准 x 归一到 lane 栅格（与 `grid.lanes` 同基 ⇒ 同列跨框各框落同键、统一装箱）。 */
  const keyOf = (baseX: number): number => Math.round(baseX / DG_LANE_PITCH);

  type Plan = {
    readonly edge: CrossEdge;
    readonly a: PipeGridCell;
    readonly b: PipeGridCell;
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
    readonly sIdx: number;
    readonly tIdx: number;
    readonly dir: 1 | -1;
    readonly k: number;
    readonly exitBand: number;
    readonly entryBand: number;
    readonly baseX: number;
    readonly channelKey: number;
    /** 出口腿三档降档序列（档 1 `CH` → 档 2 `PL`/`PR` → 档 3 `ML`/`MR`，已过 i2 预检）。 */
    readonly exitLadder: readonly CrossCorridor[];
    /** 入口腿三档降档序列（同上）。 */
    readonly entryLadder: readonly CrossCorridor[];
    /** 出口腿分席组键（同组共用一条走廊族 ⇒ 席号才互相抬）。 */
    readonly exitGroup: string;
    readonly entryGroup: string;
    exitSeat: number;
    entrySeat: number;
    /** 外缘长竖腿席基准（`k ≥ 2` 才有长竖；`pickCrossCorridors` 内按 `+j` 取连续席、超容量共段）。 */
    marginSeat: number;
    busLane: number;
    lambda: number;
    mu: number;
    yb: number;
    /** 【n8d】同目标端口的**秩**（0 = 首席、逐字不动；≥1 = 接近段按 {@link layerCrossApproach} 分层）。 */
    approachRank: number;
  };

  /**
   * **i2 预检**：`legCorridorLadder` 出参里按档剔除**不落在本框水平区间内**的 `PL`/`PR` pad 条带
   * （末列腿落进兄弟框那一形）。`CH` 的短桩合法性与 `ML`/`MR` 的 i7 严格 `>` 已在该函数内建，本处不重复。
   */
  const precheckedLadder = (
    grid: PipeGridLayout | undefined,
    frame: CanvasFrame | undefined,
    cell: PipeGridCell,
    side: "exit" | "entry",
  ): CrossCorridor[] => {
    const ladder = legCorridorLadder(grid, frame, cell, side, layout);
    if (frame === undefined) return ladder;
    return ladder.filter((c) => {
      if (c.kind === "PL" || c.kind === "PR") return c.at > frame.dx && c.at < frame.dx + frame.frameW;
      return true;
    });
  };

  /** 竖腿分席组键：`CH` 取「框:列」（同列同通道一席一线），远档取走廊 id 本身（一族一条线）。 */
  const ladderGroup = (ladder: readonly CrossCorridor[], fallback: string): string => {
    const head = ladder[0];
    if (head === undefined) return fallback;
    return head.kind === "CH" ? head.id.slice(0, head.id.lastIndexOf(":")) : head.id;
  };

  const plans: Plan[] = [];
  for (const e of crossEdges) {
    const ga = grids.get(e.fromProject);
    const gb = grids.get(e.toProject);
    const a = ga?.cellOf.get(e.from);
    const b = gb?.cellOf.get(e.to);
    if (a === undefined || b === undefined || ga === undefined || gb === undefined) continue; // 结构上画不出 ⇒ 跳过（同 intra 口径）
    const sIdx = frameIndex.get(e.fromProject) ?? 0;
    const tIdx = frameIndex.get(e.toProject) ?? 0;
    if (sIdx === tIdx) continue;
    // **(a) 回流档 = 纯框序**（i1 那半句「目标 chip 左缘在源 chip 右缘之左」的过宽判据已删：那只是
    //   行内几何，目标框仍在下方 ⇒ 正向腿不得被误判成回流而走左 gutter）
    const dir: 1 | -1 = tIdx > sIdx ? 1 : -1;
    const k = Math.abs(tIdx - sIdx);
    // **(b) 出口带 / 入口带按 `dir` 定**（与 {@link pickCrossCorridors} 同一式）
    const exitBand = dir > 0 ? sIdx : sIdx - 1;
    const entryBand = dir > 0 ? tIdx - 1 : tIdx;
    const baseX = columnBaseX(ga, a.col);
    const fa = layout.frames[sIdx];
    const fb = layout.frames[tIdx];
    const exitLadder = precheckedLadder(ga, fa, a, "exit");
    const entryLadder = precheckedLadder(gb, fb, b, "entry");
    plans.push({
      edge: e,
      a,
      b,
      x0: a.chipRight,
      y0: a.chipMidY,
      x1: b.chipX,
      y1: b.chipMidY,
      sIdx,
      tIdx,
      dir,
      k,
      exitBand,
      entryBand,
      baseX,
      channelKey: keyOf(baseX),
      exitLadder,
      entryLadder,
      exitGroup: ladderGroup(exitLadder, `CH-ANY:${e.fromProject}:${a.col}`),
      entryGroup: ladderGroup(entryLadder, `CH-ANY:${e.toProject}:${b.col - 1}`),
      exitSeat: 0,
      entrySeat: 0,
      marginSeat: 0,
      busLane: 0,
      lambda: -1,
      mu: -1,
      yb: -1,
      approachRank: 0,
    });
  }

  plans.sort((p, q) => {
    if (p.edge.fromProject !== q.edge.fromProject) return p.edge.fromProject < q.edge.fromProject ? -1 : 1;
    if (p.a.ordinal !== q.a.ordinal) return p.a.ordinal - q.a.ordinal;
    if (p.b.ordinal !== q.b.ordinal) return p.b.ordinal - q.b.ordinal;
    if (p.edge.from !== q.edge.from) return p.edge.from < q.edge.from ? -1 : 1;
    return p.edge.to < q.edge.to ? -1 : p.edge.to > q.edge.to ? 1 : 0;
  });

  // 【n8d】**同端口秩**：在上面已定的序式（源 projectId 升序 → 源号序 → 目标号序 → from → to）上，
  // 按目标端口（同一枚 chip 左缘中点 = `(to, x1, y1)`）计数 ⇒ 首枚 = 秩 0（走线逐字不动），
  // 其后各枚按秩侧向让位。**确定性**：秩只由该序决定，乱序入参出参逐字段相等（与本函数的确定性律同源）。
  const portRank = new Map<string, number>();
  for (const p of plans) {
    const key = `${p.edge.to}@${p.x1},${p.y1}`;
    const n = portRank.get(key) ?? 0;
    p.approachRank = n;
    portRank.set(key, n + 1);
  }

  /**
   * 【n8d】分层用的**障碍判据**（§2.3 画布障碍集的保守形）：矩形内不得有任何 chip（本边两枚端点除外）、
   * 也不得有任何**兄弟框**（本边两框除外）—— 与 G11 / G13① 的穿模判据同一套排除式，不另立口径。
   */
  const rectFree = (p: Plan, x0: number, x1: number, y0: number, y1: number): boolean => {
    for (const g of grids.values()) {
      for (const c of g.cells) {
        if (c.taskId === p.edge.from || c.taskId === p.edge.to) continue;
        if (x0 < c.chipX + DG_NODE_W && c.chipX < x1 && y0 < c.chipY + DG_NODE_H && c.chipY < y1) return false;
      }
    }
    for (let i = 0; i < layout.frames.length; i += 1) {
      if (i === p.sIdx || i === p.tIdx) continue;
      const f = layout.frames[i];
      if (f === undefined) continue;
      if (x0 < f.dx + f.frameW && f.dx < x1 && y0 < f.dy + f.frameH && f.dy < y1) return false;
    }
    return true;
  };

  // ① 画布通道内每枚 lane 的最高占用（把 intra 腿的 λ/μ 抬到画布通道号登记 ⇒ 跨框腿越过它另起，
  //    结构上永不与框内腿共线 ⇒ 与 intra 互不共段）。
  const intraCeil = new Map<number, number>();
  const bump = (key: number, lane: number): void => {
    if (lane < 0) return;
    const cur = intraCeil.get(key) ?? -1;
    if (lane > cur) intraCeil.set(key, lane);
  };
  for (const r of intraRoutes) {
    if (r.kind !== "long") continue;
    const pid = ownerOf.get(r.from);
    const g = pid === undefined ? undefined : grids.get(pid);
    const cellA = g?.cellOf.get(r.from);
    const cellB = g?.cellOf.get(r.to);
    if (g === undefined || cellA === undefined || cellB === undefined) continue;
    bump(keyOf(columnBaseX(g, cellA.col)), r.lambda);
    bump(keyOf(columnBaseX(g, cellB.col)), r.mu);
  }

  // ② 竖直腿装箱（**(c) 三档走廊降档取位**的分席面）：按腿所在走廊组分席，组内 packLanes(腿 y 区间)
  //    ⇒ 同席者 y 两两不交；席号 = 降档序列下标（`CH` 首席 → `CH` 次席 → `PL`/`PR` → `ML`/`MR`）。
  //    同源扇出的多枚边 = **合法共端点**（i4）：packLanes 只在 y 区间真交叠时才抬席号，不判叠。
  /** 第 `band` 枚带的首线（腿 y 区间的估计端点；无预算 lane ⇒ 带中线）。 */
  const bandFirstY = (band: number): number => layout.bandLanes[band]?.[0] ?? bandBaseY(layout, band);
  const packLegSeats = (
    groupOf: (p: Plan) => string,
    spanOf: (p: Plan) => { lo: number; hi: number },
    write: (p: Plan, seat: number) => void,
  ): void => {
    const byGroup = new Map<string, Plan[]>();
    for (const p of plans) {
      const key = groupOf(p);
      const list = byGroup.get(key);
      if (list) list.push(p);
      else byGroup.set(key, [p]);
    }
    for (const group of byGroup.values()) {
      const lanes = packLanes(group.map(spanOf));
      group.forEach((p, i) => write(p, lanes[i] ?? 0));
    }
  };
  packLegSeats((p) => p.exitGroup, (p) => ySpan(p.y0, bandFirstY(p.exitBand)), (p, seat) => { p.exitSeat = seat; });
  packLegSeats((p) => p.entryGroup, (p) => ySpan(bandFirstY(p.entryBand), p.y1), (p, seat) => { p.entrySeat = seat; });

  // **外缘长竖腿分席**（画布外缘族 = 单一组，硬容量 `2·DG_OUTER_MARGIN_SEATS`）：`k ≥ 2` 才有长竖腿，
  // 其 y 并集 = `[出口带, 入口带]`；`packLanes` 只在 y 区间真交叠时抬席 ⇒ **不交叠的边复用同一条外缘线、
  // 交叠的边各占一席**（不分席 ⇒ 全部落席 0 ⇒ 多枚边的长竖腿共段 = 真板叠线一族的根因）。
  // 已知粗化：`k ≥ 3` 的边按**连续席** `+j` 取位，装箱只看整体并集 ⇒ 与邻边可能在**单枚腿**上撞席；
  // 撞席按 X3 政策丙降级为**共段**（不降级为穿模），容量不等式的精算 = 后一枚节点（回灌面）的范围。
  {
    const wide = plans.filter((p) => p.k >= 2);
    const lanes = packLanes(wide.map((p) => ySpan(bandFirstY(p.exitBand), bandFirstY(p.entryBand))));
    wide.forEach((p, i) => { p.marginSeat = lanes[i] ?? 0; });
  }

  // ③ 水平段装箱（**(d) 一枚边占两枚带**）：按框间带分组，`k ≥ 2` ⇒ 本边**同时登记进出口带与入口带**
  //    两组，组内 packLanes(水平段 x 区间) ⇒ 同带同 lane 者 x 两两不交；`busLane` 取两组最大值
  //    （i3：只登记一枚 ⇒ 第二枚带会被别边重复分配）。`k === 1` 两枚带同一 ⇒ 天然只登记一次。
  const byBand = new Map<number, Plan[]>();
  for (const p of plans) {
    for (const band of new Set([p.exitBand, p.entryBand])) {
      if (band < 0) continue;
      const list = byBand.get(band);
      if (list) {
        if (!list.includes(p)) list.push(p);
      } else byBand.set(band, [p]);
    }
  }
  for (const group of byBand.values()) {
    const lanes = packLanes(group.map((p) => ({ lo: Math.min(p.x0, p.x1), hi: Math.max(p.x0, p.x1) })));
    group.forEach((p, i) => {
      const lane = lanes[i] ?? 0;
      if (lane > p.busLane) p.busLane = lane;
    });
  }

  // **(e) λ 不超过该通道已预算的 lane 数**：席号按本腿降档序列的席数取模（超出 ⇒ 复用首席 = **共段**，
  //   不得让腿漂出 `gapW` 落进本框下一列 chip），再抬过 intra 腿上界。
  for (const p of plans) {
    const ceil = intraCeil.get(p.channelKey) ?? -1;
    const capacity = p.exitLadder.length;
    p.lambda = ceil + 1 + (capacity > 0 ? p.exitSeat % capacity : 0);
    p.mu = -1; // 跨框档目标侧无独立 μ 腿线（入口腿席号经 `seats.entry` 直达走廊）
  }

  return plans.flatMap((p) => {
    const plan = pickCrossCorridors({
      fromProject: p.edge.fromProject,
      toProject: p.edge.toProject,
      a: p.a,
      b: p.b,
      grids,
      layout,
      seats: { exit: p.exitSeat, entry: p.entrySeat, band: p.busLane, margin: p.marginSeat },
    });
    if (plan === null) return [];
    const firstBand = plan.corridors.find((c): c is CrossCorridor => c !== null && c.axis === "h");
    // 【n8d】末段侧向让位（件三不动：末点恒 = `(x1, y1)` = 目标 chip 左缘中点）
    const points = layerCrossApproach(plan.points, p.approachRank, (a, b, c, d) => rectFree(p, a, b, c, d));
    return [{
      from: p.edge.from,
      to: p.edge.to,
      colSpan: plan.k || 1,
      kind: "cross" as const,
      busLane: p.busLane,
      lambda: p.lambda,
      mu: p.mu,
      yb: firstBand?.at ?? p.y0,
      cls: DG_EDGE_CROSS_CLS,
      d: corridorPath(points),
    }];
  });
}

/** 第 `band` 枚框间带的中线 y（带内无预算 lane 时的兜底首线；`band` 越界则回落源/目标之间）。 */
function bandBaseY(layout: CanvasLayout, band: number): number {
  const lo = layout.frames[band];
  const hi = layout.frames[band + 1];
  if (lo !== undefined && hi !== undefined) return Math.floor((lo.dy + lo.frameH + hi.dy) / 2);
  const last = layout.frames[layout.frames.length - 1];
  return last === undefined ? DG_CANVAS_PAD : last.dy + last.frameH + DG_FRAME_GAP_MIN / 2;
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

/**
 * 一枚节点格位 = 绝对定位外壳（inline `style` 只给 `left/top` 两枚几何字面）+ chip。
 * **v0.10.6 C5 角标族退役** ⇒ 外壳只剩 chip 一枚子元素；原 `.dg-deps` 带的 14px（{@link DG_BADGE_H}）行距
 * 改由 `.dg-cell` 的 `padding-top: var(--dg-bh)` 承接（C7 / n8），**`chipY` 递推式与 `DG_BADGE_H` 消费面不动**。
 */
function renderPipeCell(cell: PipeGridCell, chip: string): string {
  return (
    `<span class="dg-cell" style="left:${cell.x}px;top:${cell.y}px">` +
    chip +
    `</span>`
  );
}

/**
 * 画布层边线层 = **恰一枚** `<svg class="dg-links">`（v0.10.6 C4：调用点从框内**搬到画布层** ⇒ 每框零 svg；
 * §2.2 命名纪律 1：`<svg>` 不写任何带引号属性，
 * 盒模由 CSS `.dg-links{position:absolute;inset:0;width:100%;height:100%}` 给；不写 `viewBox`
 * ⇒ 用户单位 = CSS px 1:1）。path 只带 `class` + `d`，`d` 字符集 ⊆ `[MLCQHAZ0-9.,\-\s]`（G3 已钉）。
 */
function renderPipeSvg(routes: readonly RoutedEdge[]): string {
  return `<svg class="dg-links">${routes.map((e) => `<path class="${e.cls}" d="${e.d}"/>`).join("")}</svg>`;
}

/**
 * 一条管道的框内网格（改造文档 §2.4-③「一次收敛不迭代」）：
 * 构图 → 走线 → **把 lane 数回灌成预算重算网格**。
 * 回灌只抬 `gapW` / 通道带高，**不改 lane 分配**（λ/μ/`busLane` 由装箱决定，与通道宽无关；G3 已钉）。
 *
 * **列通道 demand = 框内 long 腿 + 本框的跨框腿**（改造文档 §6 第二枚增补 A4 框内侧）：跨框腿与 long 腿
 * 共用同一批列通道席位，漏计 ⇒ 该通道容量只剩 long 腿那一档 ⇒ `exitSeat % capacity` 恒 0 = 腿腿共段。
 * 腿落在哪枚通道由 `cellOf` 的列号定（出口 = 源列之右 `a.col`、入口 = 目标列之左 `b.col − 1`），
 * 首 / 末列那一档结构上没有列通道可落（腿走 `PL`/`PR`/`ML`/`MR` 远档）⇒ 越界的下标一律不计。
 */
function planPipeGrid(
  pipe: GraphPipeline,
  edges: readonly { from: string; to: string }[],
  layers: Map<string, number>,
  ordinals: Map<string, number>,
  crossEdges: readonly CrossEdge[],
): PipeGridLayout {
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
  for (const e of crossEdges) {
    const exit = base.cellOf.get(e.from);
    if (exit !== undefined) {
      const exitGap = exit.col;
      if (exitGap >= 0 && exitGap < gapLanes.length) gapLanes[exitGap] = (gapLanes[exitGap] ?? 0) + 1;
    }
    const entry = base.cellOf.get(e.to);
    if (entry !== undefined) {
      const entryGap = entry.col - 1;
      if (entryGap >= 0 && entryGap < gapLanes.length) gapLanes[entryGap] = (gapLanes[entryGap] ?? 0) + 1;
    }
  }
  return pipeGridLayout(pipe, columns, ordinals, { gapLanes, busLaneCount: longs.length });
}

/** {@link planCanvas} 出参（改造文档 §2.2-C4 / §2.2.1）。 */
export interface CanvasPlan {
  /** 画布几何（框 `{dx,dy}` + 框矩形 + 框间带 + 画布宽高 + 框内缘变量）。 */
  readonly layout: CanvasLayout;
  /** projectId → 该框的**局部**网格（DOM cell 的 `left/top` 事实源 —— S1：画布坐标不进 HTML）。 */
  readonly grids: ReadonlyMap<string, PipeGridLayout>;
  /** 画布层全部 path 的走线（框内 ∪ 跨框，**坐标已含 dx/dy**）。 */
  readonly routes: readonly RoutedEdge[];
  /** 框间带预算实际执行的**回灌轮数**（1 = 首轮回灌即达不动点；上限 {@link DG_BAND_MAX_PASSES}）。 */
  readonly bandPasses: number;
  /**
   * 轮次上限内**未确认**达不动点 ⇒ `true` = **出声标记**（X1 政策「定序 + 固定轮次 + 未收敛即出声」）。
   * 语义 = 「没有拿到收敛凭据」而非「断言发散」⇒ **不得静默返回**（未在最后一轮再做一次比对 ⇒ 一律出声）。
   */
  readonly bandUnconverged: boolean;
}

/**
 * 框间带预算的**定序不动点**轮次上限（改造文档 §6 第二枚增补 A4 画布侧 · 风险 X1 政策的「固定轮次」）。
 * **不做无上限迭代** —— 振荡时在此上限处停手并出声（{@link CanvasPlan.bandUnconverged}），
 * 比「不收敛就不返回」可核，也比「多跑几轮当作收敛」诚实。
 */
export const DG_BAND_MAX_PASSES = 3;

/**
 * 本轮布局上的走线 → 各**框间带**的 `gapLanes` 实占预算（`max(busLane)+1`）——
 * {@link planCanvas} 定序不动点的唯一取数面（改造文档 §6 第二枚增补 A4 画布侧）。
 *
 * - **定序**沿用 {@link routeCrossFrameEdges} 的序式（源 projectId 升序 → 源号序 → 目标号序 → from → to），
 *   逐轮同序：累加本身是 `max` ⇒ 与序无关，但出声判据吃的是**逐字段可比的签名**，故不接受「入参序影响本轮取数」。
 * - 带序 = `s > t ? s − 1 : s`（回流档登记**出口带**，与 §2.3 装箱同判据）；一枚边占两枚带时两枚各自抬位。
 */
function bandDemandOf(
  layout: CanvasLayout,
  routes: readonly RoutedEdge[],
  projectByTask: Map<string, string>,
  ordinals: Map<string, number>,
): number[] {
  const gapLanes = new Array<number>(Math.max(0, layout.frames.length - 1)).fill(0);
  if (gapLanes.length === 0) return gapLanes;
  const frameIndexOf = new Map<string, number>();
  layout.frames.forEach((f, i) => frameIndexOf.set(f.projectId, i));
  const owner = (taskId: string): string => projectByTask.get(taskId) ?? "";
  const ordinal = (taskId: string): number => ordinals.get(taskId) ?? 0;
  for (const r of routes
    .filter((x) => x.kind === "cross")
    .sort((p, q) => {
      const pf = owner(p.from);
      const qf = owner(q.from);
      if (pf !== qf) return pf < qf ? -1 : 1;
      const po = ordinal(p.from);
      const qo = ordinal(q.from);
      if (po !== qo) return po - qo;
      const pt = ordinal(p.to);
      const qt = ordinal(q.to);
      if (pt !== qt) return pt - qt;
      if (p.from !== q.from) return p.from < q.from ? -1 : 1;
      return p.to < q.to ? -1 : p.to > q.to ? 1 : 0;
    })) {
    const s = frameIndexOf.get(owner(r.from));
    const t = frameIndexOf.get(owner(r.to));
    if (s === undefined || t === undefined) continue;
    const band = Math.max(0, Math.min(gapLanes.length - 1, s > t ? s - 1 : s));
    gapLanes[band] = Math.max(gapLanes[band] ?? 0, r.busLane + 1);
  }
  return gapLanes;
}

/**
 * 不动点的**签名** = 画布几何里随框间带预算变化的那几枚（带高 / 带内 lane 线 / 画布宽高）——
 * 逐字段比、不比对象引用（`canvasLayout` 每轮新建对象，引用比必然永不相等）。
 */
const canvasSignature = (layout: CanvasLayout): string =>
  `${layout.gapH.join(",")}\u0000${layout.bandLanes.map((b) => b.join(",")).join("\u0001")}\u0000${layout.width}x${layout.height}`;

/**
 * 一次构图 → **框间带预算的定序不动点（≤ {@link DG_BAND_MAX_PASSES} 轮）**（改造文档 §2.2-C4 / §2.3 ·
 * §6 第二枚增补 A4 画布侧）：
 * ① 框内 `gapLanes`（{@link planPipeGrid}，逐管道，一次）；② 框间 `gapLanes` → 带高（经 {@link canvasLayout}）——
 * **第 ② 次不再只做一趟**：每轮 = 走线 → 按**实占**重算框间带 `gapLanes` 与（经 {@link planPipeGrid} 的 n8a
 * 入口）通道 demand → 重画画布几何 → **比签名**，签名相同即收敛 break；上限内未拿到收敛凭据 ⇒
 * {@link CanvasPlan.bandUnconverged} 出声（X1 政策 = 定序 + 固定轮次 + 未收敛即出声）。
 *
 * **不动点只动画布侧**：框内侧的列通道 demand 由 n8a 入口吃 `crossEdges`（出口 = 源列之右、入口 = 目标列之左），
 * 与本框在画布上的 `dx/dy` 无关 ⇒ 逐轮重算同值，故 {@link planPipeGrid} 仍只跑一趟。
 *
 * 收敛轮 = 2 时，出参与此前「一次构图 → 一趟回灌」的旧形态**逐字段相同**（第 2 轮比对到不动点即停手，
 * 不再改写布局）。
 *
 * **形态 S1（改造文档 §2.1）**：`shiftPipeGrid` 只喂走线 ⇒ 出参 `grids` 是**局部**网格（进 DOM），
 * `routes` 是**画布坐标**（进画布层唯一一枚 svg）。二者不同坐标系是设计而非缺陷。
 * 画布坐标一侧的平移量 = `frame.dx/dy` + 框内 origin（{@link DG_GRID_ORIGIN_X}/{@link DG_GRID_ORIGIN_Y}），
 * DOM 一侧的 cell `left/top` 仍是相对 `.pipe-body` 的局部值、不含 origin —— 两侧各按自己的参照系成立。
 *
 * `maxPasses` = 轮次上限的**测试缝**（缺省 {@link DG_BAND_MAX_PASSES}，生产调用不传 ⇒ 行为逐字不变）：
 * 自然夹具上「跑满上限仍未收敛」这一支**结构上不可达**（实测恒收敛于第 2 轮），无此缝则该支成为永不被执行的
 * 分支 —— 出声判据（{@link CanvasPlan.bandUnconverged}）需要一个可比对的落点才能钉住「未确认收敛即出声、
 * 不得静默返回」（X1）。
 */
export function planCanvas(
  pipes: readonly GraphPipeline[],
  edges: readonly { from: string; to: string }[],
  layers: Map<string, number>,
  ordinals: Map<string, number>,
  crossEdges: readonly CrossEdge[],
  projectByTask: Map<string, string>,
  maxPasses: number = DG_BAND_MAX_PASSES,
): CanvasPlan {
  const grids = new Map<string, PipeGridLayout>();
  for (const pipe of pipes) grids.set(pipe.projectId, planPipeGrid(pipe, edges, layers, ordinals, crossEdges));
  const locals = pipes.map((p) => grids.get(p.projectId) ?? emptyGrid());

  /** 画布几何 → 逐框平移网格 → 全部走线（框内按框序 ∪ 跨框）—— 同一趟装箱。 */
  const routeAll = (layout: CanvasLayout): readonly RoutedEdge[] => {
    const canvasGrids = new Map<string, PipeGridLayout>();
    for (const frame of layout.frames) {
      const grid = grids.get(frame.projectId);
      if (grid !== undefined)
        canvasGrids.set(frame.projectId, shiftPipeGrid(grid, frame.dx + DG_GRID_ORIGIN_X, frame.dy + DG_GRID_ORIGIN_Y));
    }
    const intra: RoutedEdge[] = [];
    for (const frame of layout.frames) {
      const grid = canvasGrids.get(frame.projectId);
      if (grid !== undefined) intra.push(...routeIntraEdges(edges, grid));
    }
    return [...intra, ...routeCrossFrameEdges(crossEdges, { layout, grids: canvasGrids }, intra)];
  };

  let layout = canvasLayout(pipes, locals);
  let routes = routeAll(layout);
  let passes = 0;
  let unconverged = true;
  for (let round = 1; round <= maxPasses; round++) {
    passes = round;
    const next = canvasLayout(pipes, locals, { gapLanes: bandDemandOf(layout, routes, projectByTask, ordinals) });
    if (canvasSignature(next) === canvasSignature(layout)) {
      unconverged = false;
      break;
    }
    layout = next;
    routes = routeAll(layout);
  }
  return { layout, grids, routes, bandPasses: passes, bandUnconverged: unconverged };
}

/** 一枚框 = **今日管道形态原样保留、只搬走 svg**（改造文档 §2.2-C4 / §2.2.1）：
 * `<details class="pipe" open>` + 原 `<summary>` 字面 + `.pipe-body` + `.dg-grid`（inline 只 `width/height`）
 * + cells（`left/top` **逐字沿用局部值** —— S1 折叠有效的根据）。**框内零 svg**。 */
function renderFrame(pipe: GraphPipeline, ctx: RenderCtx): string {
  const grid = ctx.plan.grids.get(pipe.projectId);
  const frame = ctx.plan.layout.frameOf.get(pipe.projectId);
  if (grid === undefined || frame === undefined) return "";
  const taskBy = new Map(pipe.nodes.map((n) => [n.taskId, n] as const));
  const body = grid.cells
    .map((cell) => {
      const task = taskBy.get(cell.taskId) as FeatureTaskItem;
      return renderPipeCell(cell, renderChip(task, ctx.ordinalOf(task.taskId), ctx.stateOf(task)));
    })
    .join("");
  const glyphs = pipe.nodes.map((n) => NODE_STATE_GLYPHS[ctx.stateOf(n).key]).join("");
  return (
    `<details class="pipe" open style="left:${frame.dx}px;top:${frame.dy}px;width:${frame.frameW}px;height:${frame.frameH}px">\n` +
    `<summary>管道 ${escapeHtml(pipe.projectId)}（${pipe.nodes.length}）` +
    `<span class="dg-pipe-states">${glyphs}</span></summary>\n` +
    `<div class="pipe-body">` +
    `<div class="dg-grid" style="width:${frame.gridW}px;height:${frame.gridH}px">` +
    body +
    `</div></div>\n` +
    `</details>`
  );
}

/**
 * 画布层（改造文档 §2.2-C4 / §2.2.1）：`.dg-canvas` 内**恰一枚** `svg.dg-links`
 * （框内 ∪ 跨框全部 path，画布坐标）+ 每管道一枚 {@link renderFrame}。
 * `--dg-nw/--dg-nh/--dg-bh` 与三枚框内缘变量在此**一次下发**（自定义属性天然继承）。
 */
function renderCanvas(pipes: readonly GraphPipeline[], ctx: RenderCtx): string {
  const layout = ctx.plan.layout;
  const style =
    `width:${layout.width}px;height:${layout.height}px;` +
    `--dg-nw:${DG_NODE_W}px;--dg-nh:${DG_NODE_H}px;--dg-bh:${DG_BADGE_H}px;${layout.frameVars}`;
  return (
    `<div class="dg-canvas" style="${style}">\n` +
    renderPipeSvg(ctx.plan.routes) +
    "\n" +
    pipes.map((p) => renderFrame(p, ctx)).join("\n") +
    `\n</div>`
  );
}

/** 渲染取数面（{@link planCanvas} 的不动点出参一次算好后共享，避免每管道重复派生）。 */
interface RenderCtx {
  readonly ordinalOf: (taskId: string) => number;
  readonly stateOf: (task: FeatureTaskItem) => NodeStateInfo;
  readonly plan: CanvasPlan;
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
  // —— 同一批边既是底部边清单的数据源，也是画布层跨框走线（{@link routeCrossFrameEdges}）的入参
  // （**v0.10.6 C5**：角标族退役 ⇒ 原 `crossIn` 取数面随之删除，跨管道依赖改由真连线承载）
  const crossEdgeTexts: string[] = [];
  const crossEdges: CrossEdge[] = [];
  for (const e of kept) {
    const fromProject = projectByTask.get(e.from);
    const toProject = projectByTask.get(e.to);
    const fromOrdinal = ordinals.get(e.from);
    const toOrdinal = ordinals.get(e.to);
    if (!fromProject || !toProject || fromProject === toProject) continue;
    if (fromOrdinal === undefined || toOrdinal === undefined) continue;
    crossEdgeTexts.push(`#${fromOrdinal} ⇢ #${toOrdinal}(${escapeHtml(toProject)})`);
    crossEdges.push({ from: e.from, to: e.to, fromProject, toProject });
  }

  const ctx: RenderCtx = {
    ordinalOf: (taskId) => ordinals.get(taskId) ?? 0,
    stateOf: (task) => nodeStateOf(task, null),
    plan: planCanvas(pipelines, kept, layers, ordinals, crossEdges, projectByTask),
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
    renderCanvas(pipelines, ctx) +
    (crossEdgeTexts.length > 0
      ? `\n<p class="hint dg-edges">跨管道边：${crossEdgeTexts.join("、")}（全量依赖见各节点 title）</p>`
      : "") +
    `\n</div>`;
  return { html };
}
