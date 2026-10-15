/**
 * B-T2 用例（REQ-v0.9.3-2026-09-26-02 · Graph 详情区块）：
 * 构图（多节点 / 环防御 / 空依赖 / 悬空边）+ 自绘区块渲染形态（零 script、不入 n3 闭集）+ 要点纯函数。
 * ⑤ = 增补轨 II N1（原「裸 id 语法形状白名单」）；⑥ = 增补轨 III N1（节点可读化：project + 任务要点）；
 * ⑧ = 历轮「结构断言过而真浏览器不渲染」的兜底门。
 * **v0.10.3 N2b**：区块出口改**管道制自绘 DOM/CSS** ⇒ ③/⑤/⑧ 三组里「经数据通道看区块」的锚
 * 重写为自绘形态锚（零 script / 三元计数 / 管道 + chip 结构）。
 * **v0.10.3 N2c**：`taskGraphMermaidSource` 与 `.dep-graph .mermaid-block` 六条 CSS 已**摘除**
 * （解析链退役 ⇒ 原「引号包 id 的 Parse error」根因在结构上不可复现）⇒ ①②④⑤⑥⑦⑧ 里仍钉源文本
 * 形态的锚**逐条重指向**到保留层（`buildTaskGraph` 构图 / `renderDependencyGraphSection` 自绘 HTML /
 * `taskSummaryLines` 要点纯函数 / 新 `.pipe*`·`.dg-*` CSS / vendored 资产完好性），**不删条 ⇒ 条数不减**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { renderPage } from "../dist/web/layout.js";
import {
  buildTaskGraph,
  transitiveReduce,
  taskSummaryLines,
  TASK_SUMMARY_MAX_CHARS,
  TASK_SUMMARY_LINE_CHARS,
  taskOrdinalMap,
  groupPipelines,
  buildGraphWithPipelines,
  nodeStateOf,
  renderDependencyGraphSection,
  layerOfGraph,
  compressPipeLayers,
  pipeGridLayout,
  routeIntraEdges,
  arcPath,
  busPath,
  crossPath,
  DG_EDGE_CLS,
  DG_EDGE_CROSS_CLS,
  DG_NODE_W,
  DG_NODE_H,
  DG_BADGE_H,
  DG_ROW_GAP,
  DG_COL_GAP_MIN,
  DG_LANE_PITCH,
  DG_LANE_MIN,
  DG_ARC_K_MAX,
  DG_BUS_PITCH,
  DG_PAD_L,
  DG_PAD_T,
  DG_PAD_B,
  DG_PAD_R,
  DG_FRAME_BORDER,
  DG_FRAME_TITLE_H,
  DG_FRAME_PAD,
  DG_GRID_ORIGIN_X,
  DG_GRID_ORIGIN_Y,
  DG_CANVAS_GUTTER,
  DG_CANVAS_PAD,
  canvasLayout,
  planCanvas,
  DG_BAND_MAX_PASSES,
  DG_FRAME_GAP_MIN,
  DG_CROSS_MIN,
  shiftPipeGrid,
  routeCrossFrameEdges,
  pickCrossCorridors,
  corridorPath,
  DG_CORRIDOR_MIN_RUN,
  DG_CORRIDOR_BULGE_MAX,
  DG_CORRIDOR_MARGIN_STEP,
  DG_OUTER_MARGIN_SEATS,
  DG_PAD_STRIP_SEATS,
  layerCrossApproach,
  DG_APPROACH_SEAT_PITCH,
  DG_APPROACH_MAX_OFF,
  DG_APPROACH_LEAD,
  NODE_STATE_ORDER,
  NODE_STATE_LEGEND_LABELS,
  NODE_STATE_GLYPHS,
  NODE_STATE_COLORS,
  TASK_STATE_COLORS,
  TASK_STATE_LABELS,
  NEUTRAL_TASK_COLOR,
  QUEUE_STATE_RUNNING,
  QUEUE_STATE_QUEUED,
} from "../dist/graph-view.js";

const task = (taskId, state = "completed", dependencies = [], extra = {}) => ({
  taskId,
  projectId: "proj-a",
  state,
  lane: "write",
  failureKind: null,
  retryCount: null,
  dependencies,
  prompt: null,
  // v0.10.6 F1：编号键从 `queuedAt` 抬为 `createdAt`（登记时刻）。本文件既有用例的序语义写在
  // `queuedAt` 上 ⇒ 夹具给 `createdAt` 兜一层同名别名，使保序不依赖逐处翻案（显式传 `createdAt` 者优先）。
  createdAt: extra.createdAt ?? extra.queuedAt ?? null,
  startedAt: null,
  finishedAt: null,
  queueState: null,
  queuedAt: null,
  claimedAt: null,
  claimedBy: null,
  taskType: null,
  ...extra,
});

/** 与 graph-view/`shortId` 同口径（8 字符截断）。 */
const short = (id) => id.slice(0, 8);

/**
 * 边线 path 的取数字面单源（n2 取数面单源化 · 追加件 n9 把 class 面并进同一枚单源）。
 * 旧形态 `<path class="dg-edge" d="..."` 曾散落于多处内联正则；追加件（n9）给跨框边换 class
 * 取值（追加 ` dg-edge-cross`），故此处用可选后缀 `(?: dg-edge-cross)?` —— **类面与几何面
 * 由同一次 matchAll 取出**，两处不得各存一份字面（后缀写错 ⇒ 类面数不到、当场红）。
 * 捕获组 1 = `class` 值、2 = `d` 值。同源的整标签形状钉见 `live-refresh.test.mjs` 的 `EDGE_PATH_TAG_EXACT_RE`。
 */
const EDGE_PATH_RE = /<path class="(dg-edge(?: dg-edge-cross)?)" d="([^"]*)"/g;

/** 任意 HTML 片段 → 边线 path 序列 `[{ cls, d }]`（取值面单源，出参顺序 = HTML 出现序）。 */
const edgePaths = (html) => [...html.matchAll(EDGE_PATH_RE)].map((m) => ({ cls: m[1], d: m[2] }));

/** 边线 path 序列 → **类面**的跨框枚数（追加类 `dg-edge-cross` 在场者）。 */
const crossClsCount = (paths) => paths.filter((e) => e.cls === DG_EDGE_CROSS_CLS).length;

// ---------------------------------------------------------------------------
// ① 构图 · 多节点（N2c 起：边方向钉构图面，形态钉自绘面）
// ---------------------------------------------------------------------------

test("T2-①多节点：3 任务链 a→b→c 的边方向 = 依赖项→依赖者，全节点入图", () => {
  const tasks = [
    task("task-aaaaaaaa", "completed", []),
    task("task-bbbbbbbb", "completed", ["task-aaaaaaaa"]),
    task("task-cccccccc", "working", ["task-bbbbbbbb"]),
  ];
  const g = buildTaskGraph(tasks);
  assert.equal(g.nodes.length, 3);
  assert.deepEqual(
    g.edges.map((e) => `${e.from}->${e.to}`),
    ["task-aaaaaaaa->task-bbbbbbbb", "task-bbbbbbbb->task-cccccccc"],
  );
  assert.deepEqual(g.cycleEdges, []);
  assert.deepEqual(g.dangling, []);
  const s = renderDependencyGraphSection(tasks);
  assert.match(s.html, /<h2>依赖图（3 任务 · 1 管道 · 声明 2 边（本质 2 · 传递省略 0））<\/h2>/, "同 project ⇒ 单条管道");
  assert.equal(
    (s.html.match(/<span class="dg-arrow">→<\/span>/g) ?? []).length,
    0,
    "G5 翻案（②）：位置性箭头族整条退役 ⇒ 图面不再出 `→` 串",
  );
  assert.equal(
    edgePaths(s.html).length,
    2,
    "边线 = 真依赖边（a→b→c 两条管道内边各一枚 path，与 graph.edges 有交集）",
  );
  assert.equal(s.html.includes("dg-edges"), false, "无跨管道边 ⇒ 边清单整行不渲");
  // 节点 = 状态档类名 + 可见 #编号；全量 taskId / 状态中文 / 依赖原值只进 title
  assert.ok(
    s.html.includes('<span class="dg-chip dg-done" title="task-aaaaaaaa · #1 · 已完成 · 依赖：无">#1</span>'),
    "首节点 chip 形态 = 状态档类名 + title 全量信息 + 可见编号",
  );
  assert.ok(
    s.html.includes('title="task-cccccccc · #3 · 执行中（不可辨） · 依赖：task-bbbbbbbb">#3</span>'),
    "末节点状态中文按六态档（working 无 queueState ⇒ 回落档）",
  );
  const isolated = renderDependencyGraphSection([task("task-dddddddd", "weird-state")]);
  assert.ok(
    isolated.html.includes('<span class="dg-chip dg-unknown" title="task-dddddddd · #1 · weird-state · 依赖：无">'),
    "未知态回落 unknown 档",
  );
  assert.ok(isolated.html.includes("weird-state"), "原样态名，不吞不猜");
});

test("T2-①空依赖：全无依赖 ⇒ 全孤立节点、零边、出图不为空", () => {
  const g = buildTaskGraph([task("task-11111111"), task("task-22222222", "working", null)]);
  assert.deepEqual(g.edges, []);
  assert.deepEqual(g.dangling, []);
  const s = renderDependencyGraphSection(g.nodes);
  assert.notEqual(s.html, "", "有任务 ⇒ 区块不为空（原「源不为 null」的自绘等价）");
  assert.match(s.html, /<h2>依赖图（2 任务 · 1 管道 · 声明 0 边（本质 0 · 传递省略 0））<\/h2>/, "零边进标题计数（原「源内无 -->」的自绘等价；N2 起边数恒出「声明 / 本质 / 省略」三数）");
  assert.equal(s.html.includes("dg-edges"), false, "无跨管道边 ⇒ 边清单整行不渲");
  assert.ok(s.html.includes('title="task-11111111 · #1 · 已完成 · 依赖：无"'), "孤立节点仍入图（不吞）");
});

test("T2-①空任务集（v0.9.5 C2 短路③）⇒ 依赖图整节不渲染", () => {
  const s = renderDependencyGraphSection([]);
  assert.equal(s.html, "", "空图连「（无任务，暂无依赖图）」的提示行都不出（Step 0 卡零信息量）");
});

// ---------------------------------------------------------------------------
// ② 环防御
// ---------------------------------------------------------------------------

test("T2-②环防御：a⇄b 互依赖 ⇒ 成环边不画 + cycleEdges 登记，其余节点照画", () => {
  const g = buildTaskGraph([
    task("task-aaaaaaaa", "completed", ["task-bbbbbbbb"]),
    task("task-bbbbbbbb", "failed", ["task-aaaaaaaa"]),
    task("task-cccccccc", "completed", ["task-aaaaaaaa"]), // 挂在环节点下游的非环边
  ]);
  const key = (e) => `${e.from}->${e.to}`;
  assert.deepEqual(g.cycleEdges.map(key).sort(), ["task-aaaaaaaa->task-bbbbbbbb", "task-bbbbbbbb->task-aaaaaaaa"]);
  assert.deepEqual(g.edges.map(key), ["task-aaaaaaaa->task-cccccccc"]);
  assert.ok(g.nodes.length === 3);
});

test("T2-②自依赖也算环边（防御性），不产出自环画法", () => {
  const g = buildTaskGraph([task("task-aaaaaaaa", "working", ["task-aaaaaaaa"])]);
  assert.deepEqual(g.cycleEdges, [{ from: "task-aaaaaaaa", to: "task-aaaaaaaa" }]);
  assert.deepEqual(g.edges, []);
});

test("T2-②悬空依赖（跨需求/未登记 id）⇒ 不画边 + dangling 登记", () => {
  const g = buildTaskGraph([
    task("task-aaaaaaaa", "completed", ["task-external0"]),
    task("task-bbbbbbbb", "completed", ["task-aaaaaaaa"]),
  ]);
  assert.deepEqual(g.dangling, [{ from: "task-aaaaaaaa", dep: "task-external0" }]);
  assert.deepEqual(g.edges.map((e) => `${e.from}->${e.to}`), ["task-aaaaaaaa->task-bbbbbbbb"]);
  const s = renderDependencyGraphSection(g.nodes.map((n) => ({ ...n })));
  assert.match(s.html, /class="hint warn"/);
  assert.ok(s.html.includes(`${short("task-aaaaaaaa")} ⇢ ${short("task-external0")}`));
});

// ---------------------------------------------------------------------------
// ③ application/json 数据通道（不入闭集、源文本不拼 HTML）
// ---------------------------------------------------------------------------

test("T2-③零 script 面（N2b 自绘取代数据通道）：区块不出任何 script 标签，脏字符入 title 落实体形态", () => {
  const s = renderDependencyGraphSection([
    task("task-aaaaaaaa", "completed", []),
    task('x"b<c', "working", ["task-aaaaaaaa"]),
  ]);
  assert.equal(s.html.includes("<script"), false, "零 script 标签（含 application/json 数据通道形态）");
  assert.equal(s.html.includes("mermaid-block"), false, "不再出 mermaid 块容器");
  assert.equal(s.html.includes("dg-edges"), false, "同管道 ⇒ 无跨管道边 ⇒ 边清单整行不渲");
  // 脏字符只进 title，且整串经 escapeHtml ⇒ 劈不开属性
  assert.ok(
    s.html.includes('x&quot;b&lt;c · #2 · 执行中（不可辨） · 依赖：task-aaaaaaaa'),
    "全量 taskId / 状态 / 依赖原值进 title 且经转义",
  );
  assert.equal(s.html.includes('"b<c'), false, "title 内不得出现未转义的裸引号 / 尖括号");
});

test("T2-③区块结构（N2b 自绘）：标题计数 + 六态图例 + 原生管道 details + chip，零 mermaid 块", () => {
  const s = renderDependencyGraphSection([task("task-aaaaaaaa", "blocked")]);
  assert.match(s.html, /<h2>依赖图（1 任务 · 1 管道 · 声明 0 边（本质 0 · 传递省略 0））<\/h2>/, "标题计数 = 任务 / 管道 + 边三数（声明 / 本质 / 省略，v0.10.5 N2 恒全形）");
  assert.match(s.html, /class="hint dg-legend-row"/);
  assert.equal(
    (s.html.match(/class="dg-legend"/g) ?? []).length,
    NODE_STATE_ORDER.length,
    "图例 = 六态 + 回落全枚举（复用既有 .dg-legend 类名）",
  );
  assert.match(s.html, /已阻塞/);
  assert.match(
    s.html,
    /<details class="pipe" open style="[^"]*">/,
    "管道 = 原生 details（不折叠单个节点）；G10 翻案（⑦(ii)）：框抬为画布内绝对定位固定盒 ⇒ 正字面多出 `style` 段",
  );
  assert.match(s.html, /<summary>管道 proj-a（1）<span class="dg-pipe-states">▨<\/span><\/summary>/);
  assert.match(
    s.html,
    /<div class="dep-graph">\n<div class="dg-canvas" style="[^"]*">\n<svg class="dg-links"><\/svg>\n<details class="pipe" open style="[^"]*">\n<summary>管道 proj-a（1）<span class="dg-pipe-states">▨<\/span><\/summary>\n<div class="pipe-body"><div class="dg-grid" style="[^"]*"><span class="dg-cell" style="left:12px;top:12px"><span class="dg-chip dg-frozen"[^>]*>#1<\/span><\/span><\/div><\/div>\n<\/details>\n<\/div>\n<\/div>/,
    "G10 翻案（⑦(ii) 合并单画布 S1 · 改造文档 §2.2.1 / §4.4，承原 G5 翻案（②）+ 件一翻案（增补 §6.1）原地重指向）：结构 = dep-graph › dg-canvas ›【画布级 svg.dg-links —— **已从框内搬出**、零边时空 svg 照出】› details.pipe（固定盒）› summary + pipe-body › dg-grid › dg-cell › chip；cell 的 left/top 局部值逐字不变；`.dg-deps` 角标带外壳随 C5 退役（14px 行距改由 `.dg-cell` 的 `padding-top` 承接，见件一① 翻案）",
  );
  assert.equal(s.html.includes("mermaid-block"), false);
  assert.equal(s.html.includes("data-src"), false);
  // 图例展示词与 nodeStateOf 的 label 同面（两侧不漂移）
  const probes = {
    done: task("t", "completed"),
    running: task("t", "working", [], { queueState: "running" }),
    queued: task("t", "working", [], { queueState: "queued" }),
    failed: task("t", "failed"),
    frozen: task("t", "blocked"),
    ask: task("t", "input-required"),
    unknown: task("t", "working", [], { queueState: null }),
  };
  for (const key of NODE_STATE_ORDER) {
    assert.equal(
      NODE_STATE_LEGEND_LABELS[key],
      nodeStateOf(probes[key], null).label,
      `图例词与 nodeStateOf(${key}).label 逐字同面`,
    );
    assert.ok(s.html.includes(NODE_STATE_LEGEND_LABELS[key]), "图例七档中文全在场");
  }
  assert.equal(new Set(Object.values(NODE_STATE_COLORS)).size, 7, "图例七档色块互异（同色 = 状态不可辨）");
  assert.deepEqual(Object.keys(NODE_STATE_GLYPHS).sort(), [...NODE_STATE_ORDER].sort(), "状态符表与六态闭集同键");
});

// ---------------------------------------------------------------------------
// ④ 确定性（同输入同输出，供快照式断言与测试稳定）
// ---------------------------------------------------------------------------

test("T2-④构图与渲染对乱序输入确定性一致", () => {
  const tasks = [
    task("task-cccccccc", "completed", ["task-bbbbbbbb"]),
    task("task-aaaaaaaa", "completed", []),
    task("task-bbbbbbbb", "completed", ["task-aaaaaaaa"]),
  ];
  const shuffled = [...tasks].reverse();
  assert.deepEqual(buildTaskGraph(shuffled).edges, buildTaskGraph(tasks).edges, "构图面：边定序不依赖入参序");
  assert.equal(renderDependencyGraphSection(shuffled).html, renderDependencyGraphSection(tasks).html);
});

// ---------------------------------------------------------------------------
// ⑤ 增补轨 II N1（第二轮根因）：原锚 = 「mermaid 11 flowchart 节点位不接受 `"quoted"` ⇒
//    Parse error got 'STR' ⇒ 整图不渲染」（headless parse 实证）。v0.10.3 N2c 摘除源生成后
//    **该根因在结构上不可复现**（图形面无任何需语法净化的位置）⇒ 本组锚重指向到 DOM 面等价形态：
//    「taskId / projectId / 依赖原值的任何字符都不得劈开属性位，可见文字恒为 `#编号`」。
//    （渲染链其余环节仍由 bd14-markdown-render.test.mjs ④c 各钉，本组只管详情页图形面。）
// ---------------------------------------------------------------------------

/** 剥掉全部属性值后剩下的裸 HTML —— 用于「引号只包属性值」的正面证明。
 *  **v0.10.5 G5 翻案（§2.2 命名纪律 1 / 锚账第 9 条）**：白名单加 `d` —— `<path>` 的 `d` 是新增的
 *  第四个带引号属性（字符集 ⊆ `[MLCQHAZ0-9.,\-\s]` 由 G8-负钉① 钉住）；`viewBox` / `width` /
 *  `aria-hidden` 一律**不进**白名单也**不出现**（svg 盒模归 CSS）。 */
const stripAttrs = (html) => html.replace(/(?:class|title|style|d)="[^"]*"/g, "");

test("二轮N1-①（DOM 面重指向）脏字符 id 不进任何语法位：引号只包属性值，可见文字恒 #编号", () => {
  const s = renderDependencyGraphSection([
    task("98c39da1-1111-2222-3333-444455556666"),
    task('a"b<c', "working", ["98c39da1-1111-2222-3333-444455556666"]),
  ]);
  assert.equal(s.html.includes('a"b<c'), false, "原值不得未转义出现（会劈开 title 属性 = 原「STR 劈裂」的 DOM 等价）");
  assert.ok(s.html.includes("a&quot;b&lt;c"), "id 的引号 / 尖括号入 title 前经 escapeHtml");
  assert.equal((s.html.match(/title="[^"]*"/g) ?? []).length, 2, "每枚 chip 恰一个可数的 title 属性");
  assert.equal((s.html.match(/>#\d+/g) ?? []).length, 2, "可见文字 = #编号（原 id 不上图形面 ⇒ 无引号位）");
  assert.equal(/"/.test(stripAttrs(s.html)), false, "剥掉属性值后不得再残留任何裸引号");
  assert.equal(s.html.includes("<script"), false, "零 script 标签（n3 内联闭集不扩）");
});

test("二轮N1-②（DOM 面重指向）保留字与脏字符 taskId：不再需要净化，原值进 title、入面先转义", () => {
  const s = renderDependencyGraphSection([
    task("end", "completed", [], { queuedAt: "2026-10-11T00:00:01Z" }),
    task('a"b c', "working", ["end"], { queuedAt: "2026-10-11T00:00:02Z" }),
  ]);
  assert.ok(
    s.html.includes('<span class="dg-chip dg-done" title="end · #1 · 已完成 · 依赖：无">#1</span>'),
    "保留字 end 原样进 title（无解析器可撞词 ⇒ n_ 前缀净化面随源生成一并退役）",
  );
  assert.ok(s.html.includes("a&quot;b c"), "脏字符入 title 前先 escapeHtml");
  const other = renderDependencyGraphSection([
    task("t-x", "completed", [], { projectId: 'p"x', queuedAt: "2026-10-11T00:00:01Z" }),
  ]);
  assert.ok(other.html.includes("<summary>管道 p&quot;x（1）"), "projectId 入管道头同样转义");
  assert.equal(/"/.test(stripAttrs(other.html)), false, "同①：剥属性后无裸引号");
});

// ---------------------------------------------------------------------------
// ⑥ 增补轨 III N1（节点可读化）：原锚 = 标签四行「project 标识 + 任务要点（prompt 摘要截断换行）
//    + taskId 次要短标 + 状态中文」。v0.10.3 N2c 起图形面**不再承载要点**（可见文字 = `#编号`、
//    project 标识升为管道头、全量 taskId 进 title；负向钉见文末 N2b-N2 组）⇒ 本组 ①②③④
//    重指向到保留层 = `taskSummaryLines` 要点纯函数本体 + 管道头 / title 的落位与转义面。
// ---------------------------------------------------------------------------

test("三轮N1-①要点首行 + project 落位：要点 = prompt 首行（换行不拼接）；project 在管道头、全量 taskId 进 title", () => {
  assert.deepEqual(
    taskSummaryLines("修复依赖图节点标签\n第二行不得入要点"),
    ["修复依赖图节点标签"],
    "要点 = prompt 首行（换行归一，不多行原文照抄）",
  );
  const s = renderDependencyGraphSection([
    task("98c39da1-1111-2222-3333-444455556666", "completed", [], {
      projectId: "flow",
      prompt: "修复依赖图节点标签\n第二行不得入要点",
    }),
  ]);
  assert.ok(s.html.includes("<summary>管道 flow（1）"), "project 标识由逐节点前缀升为管道头");
  assert.ok(
    s.html.includes('title="98c39da1-1111-2222-3333-444455556666 · #1 · 已完成 · 依赖：无"'),
    "全量 taskId 进 hover title（原 tip 指令的落点）",
  );
  assert.equal(
    s.html.includes("修复依赖图节点标签"),
    false,
    "要点不进图形 HTML（原「tip 含要点」随图形面零 prompt 退役 ⇒ 正向钉改由 N2b-N2 承担）",
  );
});

test("三轮N1-②prompt 缺键 / 空 / 全空白 ⇒ 要点为 null（不吞不猜），图形面对 prompt 零依赖", () => {
  for (const prompt of [null, undefined, "", "   \n  "]) {
    assert.equal(
      taskSummaryLines(prompt),
      null,
      `prompt=${JSON.stringify(prompt)} ⇒ 要点 null（原「回退裸 taskId」的纯函数等价）`,
    );
    const withPrompt = renderDependencyGraphSection([task("task-aaaaaaaa", "working", [], { prompt })]);
    assert.equal(
      withPrompt.html,
      renderDependencyGraphSection([task("task-aaaaaaaa", "working", [], { prompt: null })]).html,
      `prompt=${JSON.stringify(prompt)} ⇒ 渲染与无 prompt 逐字同文`,
    );
    assert.ok(
      withPrompt.html.includes('title="task-aaaaaaaa · #1 · 执行中（不可辨） · 依赖：无"'),
      "全量 taskId 恒在 title（不吞不猜）",
    );
  }
});

test("三轮N1-③长文本截断换行：按词界换行、≤2 行、总量 ≤40 字符、超出以 … 收尾", () => {
  const summary = taskSummaryLines(
    "aaaaaaaaa bbbbbbbbbbb ccccccccccc ddddddddddd eeeeeeeeeee fffffffffggg wwwwwwwwwwwww",
  );
  assert.deepEqual(summary, ["aaaaaaaaa", "bbbbbbbbbbb ccccccccccc dddddd…"], "词界断行 + 预算内硬截断");
  assert.ok(summary.join("").replace("…", "").length <= TASK_SUMMARY_MAX_CHARS, "要点总量 ≤ 40 字符");
  assert.equal(summary.length, 2, "≤2 行（无第三行可续）");
  const cjk = taskSummaryLines("依赖图节点可读化改造任务要点全文超长示例用于验证按字符断行");
  assert.equal(cjk[0].length, TASK_SUMMARY_LINE_CHARS, "CJK 无空格 ⇒ 按字符断行");
  assert.equal(cjk[1], "用于验证按字符断行", "余下 9 字符并入第二行（未越行宽）");
  assert.ok(!cjk[1].endsWith("…"), "预算内（29 ≤ 40）不截断");
});

test("三轮N1-④title 与管道头均经转义：引号 / 尖括号 / & 不劈裂属性位", () => {
  const s = renderDependencyGraphSection([
    task('a"b c', "working", ["d<e&f"], { projectId: 'p"1', prompt: 'say "hi" <b>&amp;</b>' }),
  ]);
  assert.ok(s.html.includes("a&quot;b c"), "taskId 入 title 被 escapeHtml");
  assert.ok(s.html.includes("d&lt;e&amp;f"), "依赖原值入 title 同样转义");
  assert.ok(s.html.includes("<summary>管道 p&quot;1（1）"), "projectId 入管道头被 escapeHtml");
  assert.equal(
    /"/.test(stripAttrs(s.html)),
    false,
    "剥掉属性值后不得残留裸引号（原「引号只包标签与 tip」白名单的 DOM 等价）",
  );
});

test("三轮N1-⑤容器与确定性（N2b 自绘）：.dep-graph 图区照旧、区块零 script；同入参两次渲染逐字相等、乱序入参等值", () => {
  const tasks = [
    task("t-1", "completed", [], { projectId: "p1", queuedAt: "2026-10-11T00:00:01Z", prompt: "依赖图节点可读化" }),
    task("t-2", "working", ["t-1"], { projectId: "p2", queuedAt: "2026-10-11T00:00:02Z" }),
  ];
  const s = renderDependencyGraphSection(tasks);
  assert.match(s.html, /<div class="dep-graph">/, "图区容器类名不变（N2c 的 CSS 挂点）");
  assert.equal(s.html.includes("<script"), false, "不得携带可执行内联脚本，也不出数据通道");
  assert.equal(s.html.includes("依赖图节点可读化"), false, "要点不进图形 HTML（图形面零 prompt）");
  assert.equal(renderDependencyGraphSection([...tasks].reverse()).html, s.html, "乱序入参 ⇒ 渲染逐字相等");
  assert.equal(renderDependencyGraphSection([...tasks].sort((a, b) => (a.taskId < b.taskId ? 1 : -1))).html, s.html);
});

test("三轮N1-⑥要点纯函数：首行边界 / 行宽与预算 / 空态 ⇒ null", () => {
  assert.deepEqual(taskSummaryLines("甲\n乙"), ["甲"], "换行 = 消息分段边界，只取首行");
  assert.deepEqual(taskSummaryLines("  带\t制表符  与多空格  "), ["带 制表符 与多空格"], "行内空白归一");
  assert.deepEqual(taskSummaryLines("一二三四五六七八九十甲乙丙丁戊己庚辛壬癸"), ["一二三四五六七八九十甲乙丙丁戊己庚辛壬癸"], "20 字符内单行");
  assert.equal(taskSummaryLines("short one")?.length, 1);
  assert.deepEqual(taskSummaryLines("   "), null);
  assert.deepEqual(taskSummaryLines(""), null);
  assert.deepEqual(taskSummaryLines(null), null);
  assert.deepEqual(taskSummaryLines(undefined), null);
});

test("三轮N1-⑦布局与取色（N2c 重指向 · G6 再指向 · 增补件二订正）：横滚职责迁到 .dep-graph、位置性箭头规则退役、新规则零字面色值、绝对定位恰两条", () => {
  const css = renderPage({ title: "t", active: "features", bodyHtml: "" });
  // v0.10.6 增补 `a0682281` 件二订正（改造文档 §2.2.2「横滚壳」行 / §4.4 `:417`）：
  // 横滚落**图区父层** `.dep-graph` —— `.dg-canvas` 按内容定宽（inline `width:{W}px`）⇒ 在其上写 `overflow-x` 恒 inert
  assert.match(css, /\.dep-graph \{[^}]*overflow-x: auto;[^}]*\}/, "图区级横滚（父层宽度受外部约束 ⇒ 溢出成立；承接原 .dep-graph .mermaid-block / .pipe-body 的 scroll 职责）");
  assert.equal(/\.pipe-body \{[^}]*overflow-x: auto;[^}]*\}/.test(css), false, "框内不再横滚（负钉：旧声明不得原地留存成第二份 scroll 面）");
  // 增补 B5 负钉①：画布只当坐标系承载者 —— 声明体零 `overflow`（补一份即第二 scroll 面，且因定宽而恒 inert）
  const canvasDecls = cssDecls(cssRule(css, ".dg-canvas"));
  assert.equal(canvasDecls.some((d) => /^overflow\b/.test(d)), false, "`.dg-canvas` 声明体零 overflow（横滚已上收父层 `.dep-graph`，不得留第二份）");
  assert.ok(canvasDecls.includes("position: relative"), "`.dg-canvas` 仍是坐标系承载者（绝对定位框的包含块 —— 摘横滚不摘这一枚）");
  assert.match(css, /\.pipe \{/, "管道容器类名与 graph-view 输出同面");
  assert.match(css, /\.dg-chip \{[^}]*white-space: nowrap;/, "chip 不折行（长任务名不撑破编号）");
  assert.equal(css.includes(".dg-arrow"), false, "G6 翻案（③）：`.dg-arrow` 整条退役（图面已由 G5 改真依赖边线 ⇒ 无此类可着色）");
  // v0.10.6 C5 / §2.2.2 翻案（n14 收口，改造文档 §2.2.2「`.dg-dep`/`.dg-deps` 摘除」行）：
  // 原正钉 `assert.match(css, /\.dg-dep \{/)` 的对象已整条摘除 ⇒ 改**负钉**（规则面不得再出现任一枚）
  assert.equal(/^\s*\.dg-dep\s*\{/m.test(css), false, "角标族退役 ⇒ `.dg-dep` 基础规则整条摘除（留存即第二份行距事实源）");
  assert.equal(/^\s*\.dg-deps\s*\{/m.test(css), false, "角标带外壳规则 `.dg-deps` 同批摘除（行距改由 .dg-cell 的 padding-top 承接）");
  assert.match(css, /\.dg-edges \{/);
  assert.match(css, /\.dg-legend \{/, "图例类名保留（N2b 已钉其复用）");
  assert.match(css, /\.dg-legend i \{/);
  // 六条旧规则整块退役（选择器形态不残留；注释里提一次不构成规则）
  assert.equal(/^\s*\.dep-graph \.mermaid-block\s*[,{]/m.test(css), false, "旧 .dep-graph .mermaid-block 规则块已退场");
  // 文档页（.md）的 mermaid 缩放口径不受影响
  assert.match(css, /\.md \.mermaid-block svg \{ max-width: 100%; height: auto; \}/);
  // 新增块取色只引既有 token（色值事实源 = graph-view 的 TASK_STATE_COLORS，经图例 inline style 落面）
  const blockFrom = css.indexOf("  .pipe {");
  const blockTo = css.indexOf("  .dg-legend {");
  assert.ok(blockFrom >= 0 && blockTo > blockFrom, "新规则块可切出（.pipe → .dg-legend 之前）");
  const block = css.slice(blockFrom, blockTo);
  // 唯一例外 = 增补 A1 的七条 chip 状态变体：色值不新造，逐字复用 NODE_STATE_COLORS（同源由 A1 锚钉住）
  const tokenOnly = block.replace(/^[ \t]*\.dg-chip\.dg-\w+ \{[^}]*\}[^\n]*\n/gm, "");
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(tokenOnly), false, "除 chip 状态变体外新规则零字面色值");
  assert.notEqual(tokenOnly, block, "变体规则确在本块内（防上条剥离空转）");
  // G6 翻案（④）：原「新规则零绝对定位连线层」已被 §2.2 形态 α（固定网格 + 通道走线）推翻
  // v0.10.6 C7 / §2.2.1 翻案（n14 收口）：形态 S1 下「框 = 画布内绝对定位固定盒」是新硬约束（§2.1 R7 的消解手段）
  // ⇒ 绝对定位由恰两条抬为**恰四条**（固定盒两枚 + 边线层 + 节点格位），第五枚即红
  const absRules = block
    .split("\n")
    .filter((l) => /position:\s*absolute/.test(l))
    .map((l) => l.trim().replace(/\s*\{.*$/, ""));
  assert.deepEqual(
    absRules,
    [".dg-canvas .pipe", ".dg-canvas .pipe-body", ".dg-links", ".dg-cell"],
    "绝对定位恰四条（框固定盒 + 框内定位壳 + 边线层 + 格位）；坐标原点仍 = 非定位的 .dg-grid（position:relative）",
  );
  assert.equal(/position:\s*(fixed|sticky)/.test(block), false, "本区间零 fixed / sticky");
  assert.deepEqual(
    [
      NODE_STATE_COLORS.done,
      NODE_STATE_COLORS.running,
      NODE_STATE_COLORS.queued,
      NODE_STATE_COLORS.failed,
      NODE_STATE_COLORS.frozen,
      NODE_STATE_COLORS.unknown,
    ],
    [
      TASK_STATE_COLORS.completed,
      TASK_STATE_COLORS.working,
      TASK_STATE_COLORS["input-required"],
      TASK_STATE_COLORS.failed,
      TASK_STATE_COLORS.blocked,
      NEUTRAL_TASK_COLOR,
    ],
    "六态色 = 既有五色的重新指派 + 回落中性色（不另存调色板）",
  );
});

// ---------------------------------------------------------------------------
// G6（v0.10.5 CSS 区间与样式同源）：双事实源风险（改造文档 §6「风险①」）的机器把门 ——
// chip / 角标带的**盒模尺寸只许来自 `.dg-grid` inline 下发的 CSS 变量**，CSS 侧一律不写数字；
// 下发键与消费键互为闭集（少发 ⇒ chip 塌成内容宽、走线端点漂移；多消费 ⇒ 变量悬空取初值）。
// ---------------------------------------------------------------------------

/** CSS 区间切出（与 ⑦ 同一把锚：`  .pipe {` → `  .dg-legend {`）。 */
function pipeCssBlock() {
  const css = renderPage({ title: "t", active: "features", bodyHtml: "" });
  const from = css.indexOf("  .pipe {");
  const to = css.indexOf("  .dg-legend {");
  assert.ok(from >= 0 && to > from, "CSS 区间切出锚成立（.pipe → .dg-legend 之前）");
  return css.slice(from, to);
}

/** 区间内按选择器取单行规则体（选择器逐字匹配 ⇒ `.dg-dep` 不会误吞 `.dg-deps`）。 */
function cssRule(block, selector) {
  const hits = block
    .split("\n")
    .filter((l) => l.trim().startsWith(`${selector} {`))
    .map((l) => l.trim().replace(/^[^{]*\{([^}]*)\}.*$/, "$1"));
  assert.equal(hits.length, 1, `${selector} 基础规则恰一条（实得 ${hits.length} 条）`);
  return hits[0];
}

/** 规则体内全部 `名:值` 声明（去注释、按分号切）。 */
const cssDecls = (rule) =>
  rule
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "");

test("G6-同源①chip 盒模 = 下发变量（width/height 逐字 var(--dg-nw)/var(--dg-nh) ⇒ CSS 侧不存第二份数字）", () => {
  const block = pipeCssBlock();
  const decls = cssDecls(cssRule(block, ".dg-chip"));
  // 唯二盒模声明：值必须是下发变量本身（写成 `74px` / `28px` 或改动 box-sizing ⇒ 本条红）
  assert.deepEqual(
    decls.filter((d) => /^(width|height):/.test(d)),
    ["width: var(--dg-nw)", "height: var(--dg-nh)"],
    "chip 宽高只引 --dg-nw / --dg-nh（与 graph-view 导出的 DG_NODE_W / DG_NODE_H 同源）",
  );
  assert.ok(decls.includes("box-sizing: border-box"), "定宽含边框 ⇒ 右缘恒 = x + DG_NODE_W（走线端点定义式的前提）");
  assert.ok(decls.includes("justify-content: center"), "定宽盒内 #编号居中（位数变化 ⇒ 坐标零变化）");
  assert.equal(decls.some((d) => /^position:/.test(d)), false, "chip 自身不加 position（格位定位只在 .dg-cell 一枚）");
  // 原序三串不动（翻案前的既有锚语义：border → background → white-space:nowrap 的相对次序）
  const order = decls.filter((d) => /^(border|background|white-space):/.test(d)).map((d) => d.split(":")[0]);
  assert.deepEqual(order, ["border", "background", "white-space"], "基础规则原序三串不动（新声明只追加在后）");
  // 数字只在唯一下发面：区间内不得出现三枚常量的 px 字面（两处各写一份 ⇒ 本条红）
  for (const v of [DG_NODE_W, DG_NODE_H, DG_BADGE_H])
    assert.equal(block.includes(`${v}px`), false, `CSS 区间零尺寸字面（不得内嵌 ${v}px；下发面 = .dg-canvas inline）`);
  // v0.10.6 C4 / §2.2.1-2 翻案（n14 收口）：三枚几何变量从逐框 `.dg-grid` **上抬到画布一枚 `.dg-canvas`**
  // 一次下发（自定义属性天然继承）⇒ 下发面锚随之上收一层；「消费侧不翻」半句（上面两条）仍逐字成立
  const inline = renderDependencyGraphSection([task("t-here", "completed", [])]).html.match(/<div class="dg-canvas" style="([^"]*)">/);
  assert.ok(inline !== null, "下发面在场（几何变量的唯一出口 = 画布那一枚 inline）");
  assert.ok(
    inline[1].includes(`--dg-nw:${DG_NODE_W}px;--dg-nh:${DG_NODE_H}px;--dg-bh:${DG_BADGE_H}px`),
    "下发三键的数值逐字取自导出常量（改常量 ⇒ 板面自动跟随，改 CSS 数字 ⇒ 本条红）",
  );
  const gridInline = /<div class="dg-grid" style="([^"]*)">/.exec(
    renderDependencyGraphSection([task("t-here", "completed", [])]).html,
  );
  assert.ok(gridInline !== null, "框内网格仍在场（S1 下每框恰一枚 .dg-grid）");
  assert.equal(/--dg-/.test(gridInline[1]), false, "逐框不再重复下发变量（第二份下发面 = 双事实源，§2.2.1-2 只许画布一枚）");
});

test("G6-同源②新规则零盒模字面 + 消费键 ⊆ / = 下发键；z-index 分野与坐标原点在 .dg-grid", () => {
  const block = pipeCssBlock();
  // ① 新规则的 width / height 声明只许两种形态：下发变量 或 100%（父盒 = .dg-grid 自身）
  // v0.10.6 C5 / §2.2.2 翻案（n14 收口）：`.dg-deps` 角标带外壳随 C5 整条摘除 ⇒ 从盒模声明表里删该枚
  //（14px 行距的承接者改判 `.dg-cell` 的 padding-top，见下 F3a 那条）
  for (const sel of [".dg-grid", ".dg-cell", ".dg-links", ".dg-links path"]) {
    const sizes = cssDecls(cssRule(block, sel)).filter((d) => /^(width|height):/.test(d));
    for (const d of sizes)
      assert.match(d, /^(width|height): (var\(--dg-(nw|nh|bh)\)|100%)$/, `${sel} 的盒模声明不得写数字：${d}`);
  }
  // 承上：行距的唯一样式落点从 DOM 外壳迁到格位内边距（几何值仍只从画布下发的 --dg-bh 取）
  assert.deepEqual(
    cssDecls(cssRule(block, ".dg-cell")).filter((d) => /^padding-top:/.test(d)),
    ["padding-top: var(--dg-bh)"],
    "14px 行距与 DG_BADGE_H 同源（新落点 = .dg-cell 的 padding-top，替代已退役的 .dg-deps 盒高）",
  );
  assert.equal(/^\s*\.dg-deps\s*\{/m.test(block), false, "`.dg-deps` 基础规则不再在场（原「角标带高 === --dg-bh」那条锚的重指向凭据）");
  // ② 消费键 = 下发键（多一个悬空键 / 少一个未被消费 ⇒ 本条红）
  // v0.10.6 C7 / §2.2.2 翻案（n14 收口）：框内缘三级加数（--dg-fb / --dg-fth / --dg-fp）抬为新的下发键
  // ⇒ 消费闭集随之下移一行；键名集合以**画布那一枚 inline** 为对照（下发面 ⇄ 消费面同源，两处不得差一枚）
  const consumed = [...new Set([...block.matchAll(/var\(--dg-(\w+)\)/g)].map((m) => m[1]))].sort();
  const canvasInline = /<div class="dg-canvas" style="([^"]*)">/.exec(
    renderDependencyGraphSection([task("t-here", "completed", [])]).html,
  );
  assert.ok(canvasInline !== null, "画布下发面在场（消费键闭集的对照组）");
  const downlinked = [...new Set([...canvasInline[1].matchAll(/--dg-(\w+):/g)].map((m) => m[1]))].sort();
  assert.deepEqual(consumed, ["bh", "fb", "fp", "fth", "nh", "nw"], "CSS 消费的 --dg-* 键闭集 = 六枚（三枚节点 + 三枚框内缘）");
  assert.deepEqual(consumed, downlinked, "消费键集合 === 下发键集合（悬空键 = 双事实源或漏消费）");
  // ③ 分层与原点：边线层在下、格位在上；cell 与 svg 的定位上下文 = .dg-grid（网格几何的坐标原点）
  assert.match(cssRule(block, ".dg-links"), /inset: 0/, "边线层铺满网格盒（不写 viewBox ⇒ 用户单位 = CSS px 1:1）");
  assert.deepEqual(
    block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("z-index:"))
      .map((l) => `${l.slice(1, l.indexOf(" "))}:${l.match(/z-index: (\d+)/)[1]}`),
    ["dg-links:1", "dg-cell:2"],
    "z-index 分野恰两条（边线在 chip 之下，且不得有第三枚着色层抢序）",
  );
  const grid = cssDecls(cssRule(block, ".dg-grid"));
  assert.ok(grid.includes("position: relative"), ".dg-grid = 绝对定位子（边线层 + 格位）的包含块（cell 的 left/top 出自网格函数）");
  // v0.10.6 C7 翻案（改造文档 §4.4 `:542`）：框走绝对定位固定盒 ⇒ `.pipe-body` 不再是 flex 容器
  // ⇒ `.dg-grid` 的 `flex: none` 失去存在理由、声明**摘除**（留存即第二份布局事实源）。
  assert.equal(grid.includes("flex: none"), false, "flex:none 已摘除（框 = 固定盒 ⇒ 网格不再被压缩，长边被裁的旧因由不再存在）");
  // ④ 既有面不破：横滚声明独立保留（v0.10.6 增补 `a0682281` 件二订正起落图区父层 `.dep-graph`，§4.4 `:593`）、七条变体与图例一律不动
  const cssFull = renderPage({ title: "t", active: "features", bodyHtml: "" });
  const graphRule = /^\s*\.dep-graph \{([^}]*)\}/m.exec(cssFull);
  assert.ok(graphRule !== null, ".dep-graph 基础规则在场（图区父层 = 横滚的唯一落点）");
  const graphDecls = cssDecls(graphRule[1]);
  assert.ok(graphDecls.includes("overflow-x: auto"), "横滚声明独立保留（上收至图区父层、未并入其它声明）");
  // 增补 B5 负钉②：滚动容器不得被内容定宽 —— `.dep-graph` 声明体零 `width`
  // （钉死根因：补上 width ⇒ 容器与被滚内容合并成一个元素 ⇒ 改了类名、缺陷照在）
  assert.equal(graphDecls.some((d) => /^width\b/.test(d)), false, "`.dep-graph` 声明体零 width（宽度须受外部约束 ⇒ 溢出成立）");
  assert.equal((block.match(/^[ \t]*\.dg-chip\.dg-\w+ \{/gm) ?? []).length, 7, "七条 chip 状态变体一条不动");
  assert.equal(block.includes(".dg-arrow"), false, "位置性箭头规则已整条退役（与 ⑦ 翻案③同锚）");
});

// n14 收口新增锚（改造文档 §2.1「一条 CSS 警告」/ §2.5 R8）：doc 原记「离线单测抓不到、须真机目测」，
// 但**框层是否被写了堆叠属性**这件事在 CSS 文本面上是可抓的 ⇒ 本条把 R8 从真机项前移一枚离线钉。
// 语义：画布线 svg.dg-links(z-index:1) 与 .dg-cell(z-index:2) 的比序，只在二者**同处一个堆叠上下文**时成立；
// 框层任一选择器（.pipe / .pipe-body / .dg-grid，含 `.dg-canvas …` 覆盖形）落了 z-index / transform / opacity
// ⇒ 该框自成上下文 ⇒ 线被关在框下、真机上压在 chip 上（浏览器才看得见的那一半，本条先把「谁改的」当场判红）。
test("R8 框层堆叠纪律（n14 收口新增）：.pipe / .pipe-body / .dg-grid 全部规则体零 z-index / transform / opacity", () => {
  const css = renderPage({ title: "t", active: "features", bodyHtml: "" });
  const FRAME_LAYER = new Set([".pipe", ".pipe-body", ".dg-grid"]);
  // 选择器**主体**（末段）落在这三枚者才算框层 ⇒ `.pipe > summary` 那类子元素规则不在本钉射程
  const isFrameRule = (line) => {
    const i = line.indexOf("{");
    if (i < 0 || !line.trimEnd().endsWith("}")) return false;
    return line
      .slice(0, i)
      .split(",")
      .some((sel) => {
        const last = sel
          .trim()
          .split(/[\s>]+/)
          .filter(Boolean)
          .pop();
        return last !== undefined && FRAME_LAYER.has(last);
      });
  };
  const frameRules = css.split("\n").map((l) => l.trim()).filter(isFrameRule);
  assert.ok(frameRules.length >= 4, `空转守卫：框层规则确有在场（基类三枚 + 画布覆盖两枚，实得 ${frameRules.length} 条）`);
  for (const rule of frameRules) {
    const body = rule.slice(rule.indexOf("{"));
    for (const prop of ["z-index", "transform", "opacity"])
      assert.equal(
        new RegExp(`(^|[;\\s])${prop}\\s*:`).test(body),
        false,
        `框层不得设 ${prop}（自成堆叠上下文 ⇒ 画布线压在 chip 上，§2.1 CSS 警告 / R8）：${rule.slice(0, 60)}…`,
      );
  }
  // 正面对照：抢序的两枚仍只有边线层与格位（第三枚即红），且它们都在框层之外
  const block = pipeCssBlock();
  const zOwners = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("z-index:"))
    .map((l) => l.slice(0, l.indexOf(" ")));
  assert.deepEqual(zOwners, [".dg-links", ".dg-cell"], "z-index 只许边线层与格位两枚持有（框层持有任何一枚即破坏本钉）");
});

// ---------------------------------------------------------------------------
// ⑧ vendored mermaid 资产完好性：历轮教训是「结构断言全过、真浏览器整图不渲染」，故一直留着
//    「用实际打包进板的 mermaid 解析」这道兜底门。N2c 起详情页不再产源 ⇒ 本组改钉两件事：
//    **资产未被摘除误伤**（仍能解析文档页形态的源）+ **区块 HTML 内已无源可解析**（退役正面证据）。
//    Node 无 DOM ⇒ 最小 DOM 桩 + vm 求值 UMD（DOMPurify 需 window.Element / document.nodeType=9
//    才返回带 addHook 的真实实例，否则退化为无 hook 的桩）。解析失败即整图不渲染（历轮根因）。
// ---------------------------------------------------------------------------

const MERMAID_BUNDLE = new URL("../src/web/static/mermaid.min.js", import.meta.url);

function installMinimalDom() {
  class FNode {
    constructor() {
      this.nodeType = 1;
      this.childNodes = [];
      this.parentNode = null;
    }
  }
  class FElement extends FNode {
    constructor() {
      super();
      this.tagName = "DIV";
      this.attributes = [];
      this.style = {};
    }
    hasAttribute() {
      return false;
    }
    setAttribute() {}
    getAttribute() {
      return null;
    }
    removeAttribute() {}
    cloneNode() {
      return new FElement();
    }
    querySelectorAll() {
      return [];
    }
    getElementsByTagName() {
      return [];
    }
    addEventListener() {}
    removeEventListener() {}
  }
  const g = globalThis;
  g.window = g;
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  g.Element = FElement;
  g.Node = FNode;
  g.DocumentFragment = class extends FNode {};
  g.HTMLTemplateElement = class extends FElement {};
  g.HTMLFormElement = class extends FElement {};
  g.NamedNodeMap = class {};
  g.NodeFilter = { SHOW_ALL: 0xffffffff, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
  g.DOMParser = class {
    parseFromString() {
      const el = new FElement();
      return { documentElement: el, body: el };
    }
  };
  g.document = {
    nodeType: 9,
    addEventListener() {},
    cookie: "",
    createElement: () => new FElement(),
    createTextNode: () => new FNode(),
    createDocumentFragment: () => new FNode(),
    createNSNode: () => new FElement(),
    createRange: () => ({ selectNodeContents() {}, cloneRange() {}, detach() {}, setEnd() {}, setStart() {} }),
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    getElementsByTagName: () => [],
    documentElement: Object.assign(new FElement(), { nodeType: 9 }),
    head: new FElement(),
    body: new FElement(),
  };
  try {
    Object.defineProperty(g, "navigator", { value: { userAgent: "node" }, configurable: true });
  } catch {
    /* Node 已内置只读 navigator ⇒ 用其原值 */
  }
}

test("三轮N1-⑧vendored mermaid 资产完好性（N2c 摘除只及详情页）：包体仍可 headless 解析；自绘区块内已无源可解析", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  installMinimalDom();
  vm.runInThisContext(readFileSync(MERMAID_BUNDLE, "utf8"), { filename: "mermaid.min.js" });
  const mermaid = globalThis.mermaid;
  assert.ok(mermaid?.parse, "vendored 包应导出 mermaid.parse（文档页与排期页浮层仍靠它渲染）");
  mermaid.initialize({ startOnLoad: false });

  // 详情页不再产出源 ⇒ 本组改钉「资产未被摘除误伤」：文档页形态的源照常可解析
  const sources = [
    'flowchart LR\n  a["甲"] --> b["乙"]',
    'flowchart TD\n  a["含 <tag> 与 &amp; 转义的标签"] --> b["end"]\n  b --> c["丙"]',
  ];
  for (const [i, src] of sources.entries()) {
    try {
      const r = await mermaid.parse(src);
      assert.equal(r.diagramType, "flowchart-v2", `第 ${i} 份源应解析为 flowchart（失败 = N2c 摘除越界伤及文档页资产）`);
    } catch (e) {
      assert.fail(`第 ${i} 份源 mermaid 解析失败：${String((e && e.message) || e)}\n${src}`);
    }
  }
  // 历史根因留档（摘除理由的实证）：引号包 id 至今仍是 Parse error ⇒ 不得有人把源生成再接回来
  await assert.rejects(
    () => mermaid.parse('flowchart LR\n  "a"["x"] --> "b"["y"]'),
    "引号包 id 的源必须被拒（= 当年整图不渲染的确切形态）",
  );

  // 解析链退役的正面证据：区块 HTML 内已无源可解析
  const s = renderDependencyGraphSection([task("cccc3333", "blocked", [], { prompt: "首行要点" })]);
  for (const needle of ["<script", "mermaid", "data-src"]) {
    assert.equal(s.html.toLowerCase().includes(needle), false, `区块不得再含 ${JSON.stringify(needle)}`);
  }
  assert.ok(s.html.includes("#1"), "自绘形态本身在场（负向钉不许空转）");
});

// ---------------------------------------------------------------------------
// N2a（v0.10.3 板详情页重构 · 构图与六态纯函数层）：
// N-3 六态映射逐格 / N-4 编号一致性 / N-5 排序键确定性。
// queueState 值域事实源 = 引擎读面真机回执（REQ-2026-10-11-04 核实）= claimed（在飞）/
// settled（排队，未派发）；running / queued 是板历史同义词，仍在白名单内。
// ---------------------------------------------------------------------------

test("N2a-N3六态映射：completed/working×queueState/failed/blocked/input-required 逐格 + 回落不吞不猜", () => {
  // 白名单 = 实测值 + 历史同义词（若桥侧值域漂移，本条先红）
  assert.deepEqual([...QUEUE_STATE_RUNNING].sort(), ["claimed", "running"], "「已认领」档 = 实测 claimed + 板历史同义词 running（闭合，不多不少）");
  assert.equal(QUEUE_STATE_RUNNING.size, 2, "白名单不得静默长第三枚同义词（新增须过边界轮）");
  assert.deepEqual([...QUEUE_STATE_QUEUED].sort(), ["queued", "settled"], "「排队」档 = 实测 settled + 板历史同义词 queued（闭合，不多不少）");
  assert.equal(QUEUE_STATE_QUEUED.size, 2, "白名单不得静默长第三枚同义词（新增须过边界轮）");
  assert.ok(QUEUE_STATE_RUNNING.has("claimed"), "claimed = 实测在飞档（M-3 翻案，REQ-2026-10-11-04 核实）");
  assert.ok(QUEUE_STATE_QUEUED.has("settled"), "settled = 实测排队档");

  assert.equal(nodeStateOf(task("t1", "completed"), null).key, "done");
  assert.equal(nodeStateOf(task("t1", "failed"), null).key, "failed");
  assert.equal(nodeStateOf(task("t1", "blocked"), null).key, "frozen", "blocked = 良性终态不算在飞（agent-view 口径）");
  assert.equal(nodeStateOf(task("t1", "input-required"), null).key, "ask");
  assert.equal(nodeStateOf(task("t1", "working", [], { queueState: "running" }), null).key, "running");
  assert.equal(nodeStateOf(task("t1", "working", [], { queueState: "queued" }), null).key, "queued");
  // 回落格：null / 命中集之外的值 ⇒ unknown，**不得判成 queued**
  assert.equal(nodeStateOf(task("t1", "working", [], { queueState: null }), null).key, "unknown", "null ⇒ 回落，不是 queued");
  assert.equal(nodeStateOf(task("t1", "working", [], { queueState: "settled" }), null).key, "queued", "settled 命中第 3 档（补键前误落回落）");
  assert.equal(nodeStateOf(task("t1", "working", [], { queueState: "" }), null).key, "unknown", "空串按缺省处理 ⇒ 回落");
  assert.equal(nodeStateOf(task("t1", "working"), null).key, "unknown");
  // claimedAt 非空不作主判（不得据此判 running）
  assert.equal(nodeStateOf(task("t1", "working", [], { claimedAt: "2026-10-11T00:00:00Z" }), null).key, "unknown");
  // trace 兜底：task.queueState null ⇒ 用 trace 的；两者皆无 ⇒ unknown
  assert.equal(nodeStateOf(task("t1", "working"), { queueState: "running", waitReason: "project_busy" }).key, "running");
  assert.equal(nodeStateOf(task("t1", "working", [], { queueState: "queued" }), { queueState: "running", waitReason: "queued" }).key, "queued", "task 侧优先于 trace");
  assert.equal(nodeStateOf(task("t1", "working"), { queueState: "queued", waitReason: "upstream_dependencies" }).waitReason, "upstream_dependencies", "被挡摘要经入参带出（八值原样透传）");
  assert.equal(nodeStateOf(task("t1", "working"), null).waitReason, null);
  // 展示词：六档中文 + 回落「执行中（不可辨）」+ 未知原样值不吞不猜
  assert.equal(nodeStateOf(task("t1", "completed"), null).label, TASK_STATE_LABELS.completed);
  assert.equal(nodeStateOf(task("t1", "working", [], { queueState: "queued" }), null).label, "排队·被挡");
  assert.equal(nodeStateOf(task("t1", "working", [], { queueState: null }), null).label, "执行中（不可辨）");
  assert.equal(nodeStateOf(task("t1", "working", [], { queueState: "weird" }), null).label, "执行中(weird)", "未知原样值出「原样值」，不吞不猜");
  assert.equal(nodeStateOf(task("t1", "mystery-state"), null).label, "mystery-state", "未知 state 延续原样态名口径");
});

test("REQ-04真机值域补键：claimed/settled 映射 + 补键不误染 state 五档 + 图上不带被挡原因", () => {
  // 实测在飞档 claimed ⇒ running
  assert.equal(nodeStateOf(task("t1", "working", [], { queueState: "claimed" }), null).key, "running", "claimed = 实测在飞档");
  assert.equal(nodeStateOf(task("t1", "working", [], { queueState: "claimed" }), null).label, "执行中·已认领", "claimed 走既有 running 展示词");
  // 实测排队档 settled ⇒ queued
  assert.equal(nodeStateOf(task("t1", "working", [], { queueState: "settled" }), null).key, "queued", "settled = 实测排队档");
  // 交叉例：settled ∧ claimedAt/queuedAt 皆 null ⇒ 仍 queued（主判只认 queueState，缺时刻不降档）
  assert.equal(
    nodeStateOf(task("t1", "working", [], { queueState: "settled", claimedAt: null, queuedAt: null }), null).key,
    "queued",
    "实测 settled 行可无 claimedAt/queuedAt ⇒ 主判只认 queueState，缺时刻不降档",
  );
  // 不反推例：claimed 行也带 finishedAt ⇒ 不得用时间戳反推在飞
  assert.equal(
    nodeStateOf(
      task("t1", "working", [], {
        queueState: "claimed",
        startedAt: "2026-10-11T00:00:00Z",
        finishedAt: "2026-10-11T00:05:00Z",
      }),
      null,
    ).key,
    "running",
    "实测 claimed 行也带 finishedAt ⇒ 主判只认 queueState，不得用时间戳反推在飞",
  );
  // 补键不误染 state 五档：blocked / completed 分支先于 working
  assert.equal(nodeStateOf(task("t1", "blocked", [], { queueState: "settled" }), null).key, "frozen", "补 settled 不误染冻结节点");
  assert.equal(nodeStateOf(task("t1", "completed", [], { queueState: "settled" }), null).key, "done", "补 settled 不误染已完成节点");
  // trace 兜底取数路径同样吃到补键
  assert.equal(
    nodeStateOf(task("t1", "working"), { queueState: "claimed", waitReason: "ready_pending_dispatch" }).key,
    "running",
    "trace 兜底路径的 claimed 同样命中 running",
  );
  // 可证伪例：详情面 tasks 行无 waitReason 键 ⇒ 图面第 3 档不带被挡原因（enrichment 未纳入本卡）
  assert.equal(
    nodeStateOf(task("t1", "working", [], { queueState: "settled" }), null).waitReason,
    null,
    "详情面 tasks 行不带 waitReason ⇒ 图面 queued 档无被挡原因（enrichment 未纳入本卡，不得视为已落地）",
  );
});

test("N2a-N4管道分组与编号一致性：6 任务 / 3 project ⇒ 3 条管道 projectId 升序、组内序 = taskOrdinalMap 号序、节点集不丢不重", () => {
  const tasks = [
    task("t-f1", "completed", [], { projectId: "flow", queuedAt: "2026-10-11T00:03:00Z" }),
    task("t-b1", "working", [], { projectId: "board", queuedAt: "2026-10-11T00:01:00Z" }),
    task("t-o1", "completed", [], { projectId: "orch", queuedAt: "2026-10-11T00:05:00Z" }),
    task("t-b2", "working", [], { projectId: "board", queuedAt: "2026-10-11T00:02:00Z" }),
    task("t-o2", "failed", [], { projectId: "orch", queuedAt: "2026-10-11T00:04:00Z" }),
    task("t-f2", "blocked", [], { projectId: "flow", queuedAt: null }),
  ];
  const shuffled = [...tasks].reverse();
  const g = buildGraphWithPipelines(tasks);
  const gs = buildGraphWithPipelines(shuffled);

  assert.deepEqual(g.nodes.map((n) => n.taskId), [...g.nodes].map((n) => n.taskId).sort(), "nodes 全集仍按 taskId 升序（语义不变）");
  assert.equal(g.pipelines.length, 3);
  assert.deepEqual(g.pipelines.map((p) => p.projectId), ["board", "flow", "orch"], "管道序 = projectId 升序（不依赖入参序）");
  assert.deepEqual(gs.pipelines, g.pipelines, "乱序入参两次调用结果全等");

  // 同一 taskId 在 pipelines 与 taskOrdinalMap 指向同一号，且组内号严格升序
  const ord = taskOrdinalMap(tasks);
  const seen = new Set();
  for (const p of g.pipelines) {
    let prev = 0;
    for (const n of p.nodes) {
      const o = ord.get(n.taskId);
      assert.ok(typeof o === "number", `${n.taskId} 须在编号单点内`);
      assert.ok(o > prev, "组内节点序 = 号序升序");
      prev = o;
      seen.add(n.taskId);
    }
  }
  assert.equal(seen.size, 6, "节点不丢不重");
  assert.deepEqual([...g.pipelines[0].nodes].map((n) => n.taskId), ["t-b1", "t-b2"]);
  assert.deepEqual([...g.pipelines[1].nodes].map((n) => n.taskId), ["t-f1", "t-f2"], "queuedAt null 沉底");

  // 孤立节点仍在 nodes 全集、也照样入管道
  const iso = buildGraphWithPipelines([task("x1", "completed", [], { projectId: "p1", queuedAt: "2026-10-11T00:00:00Z" })]);
  assert.equal(iso.nodes.length, 1);
  assert.deepEqual(iso.pipelines.map((p) => p.projectId), ["p1"]);
  assert.deepEqual([...iso.pipelines[0].nodes].map((n) => n.taskId), ["x1"]);

  // 管道节点 = 原对象引用（不克隆）
  assert.ok(g.pipelines[0].nodes[0] === g.nodes.find((n) => n.taskId === "t-b1"), "节点对象原样引用");
});

test("N2a-N5排序键确定性：createdAt 升序 / null 沉底 / 同值按 taskId 兜稳；乱序入参全等；本体未动（环边同值）", () => {
  const mk = (id, q) => task(id, "completed", [], { projectId: "p", queuedAt: q });
  const tasks = [
    mk("t3", "2026-10-11T00:00:10Z"),
    mk("t1", null),
    mk("t2", "2026-10-11T00:00:10Z"),
    mk("t0", "2026-10-11T00:00:05Z"),
  ];
  const ord = taskOrdinalMap(tasks);
  assert.deepEqual([...ord.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id), ["t0", "t2", "t3", "t1"], "同值按 taskId 兜稳、null 沉底");
  const ord2 = taskOrdinalMap([...tasks].reverse());
  assert.deepEqual([...ord2.entries()].sort((a, b) => a[1] - b[1]), [...ord.entries()].sort((a, b) => a[1] - b[1]), "乱序入参两次调用结果全等");

  // 组内排序键同口径：createdAt null（夹具经 queuedAt 别名仍为 null）的管道节点在缺号断言下仍沉底
  const g = buildGraphWithPipelines(tasks);
  assert.deepEqual([...g.pipelines[0].nodes].map((n) => n.taskId), ["t0", "t2", "t3", "t1"]);

  // 本体未动的证明：环样例 cycleEdges/edges/dangling 与改前逐字段同值
  const cyc = buildTaskGraph([
    task("a", "completed", ["b"]),
    task("b", "completed", ["a"]),
    task("c", "completed", ["a", "x-external"]),
  ]);
  assert.deepEqual(cyc.cycleEdges, [
    { from: "a", to: "b" },
    { from: "b", to: "a" },
  ]);
  assert.deepEqual(cyc.edges, [{ from: "a", to: "c" }], "edges 不含环边");
  assert.deepEqual(cyc.dangling, [{ from: "c", dep: "x-external" }]);
  const gcy = buildGraphWithPipelines([
    task("a", "completed", ["b"]),
    task("b", "completed", ["a"]),
    task("c", "completed", ["a", "x-external"]),
  ]);
  assert.deepEqual({ nodes: gcy.nodes, edges: gcy.edges, dangling: gcy.dangling, cycleEdges: gcy.cycleEdges }, cyc);
  assert.ok(gcy.pipelines.length === 1 && gcy.pipelines[0].nodes.length === 3, "wrapper 只加 pipelines，四字段照旧");
});

// ---------------------------------------------------------------------------
// N2b（v0.10.3 板详情页重构 · 管道制自绘渲染）：
// N-1 每 project 一管道（管道头含 projectId 与计数）· N-2 负向钉（图形 HTML 零 prompt 子串）
// · N-6 跨管道边只出角标与边清单、体内零连线坐标层。
// ---------------------------------------------------------------------------

/** 6 任务 / 3 project / 5 边（1 条同管道 + 4 条跨管道）—— N-1 / N-6 共用的夹具。 */
const pipe6Tasks = () => [
  task("t-b1", "completed", [], { projectId: "board", queuedAt: "2026-10-11T00:00:01Z" }),
  task("t-b2", "working", ["t-b1"], { projectId: "board", queuedAt: "2026-10-11T00:00:02Z", queueState: "running" }),
  task("t-o1", "completed", ["t-b2"], { projectId: "orch", queuedAt: "2026-10-11T00:00:03Z" }),
  task("t-f1", "completed", ["t-b1"], { projectId: "flow", queuedAt: "2026-10-11T00:00:04Z" }),
  task("t-f2", "blocked", ["t-o1"], { projectId: "flow", queuedAt: "2026-10-11T00:00:05Z" }),
  task("t-b3", "working", ["t-f1"], {
    projectId: "board",
    queuedAt: "2026-10-11T00:00:06Z",
    queueState: "queued",
    waitReason: "project_busy",
  }),
];

test("N2b-N1管道制：6 任务 / 3 project ⇒ 3 枚原生 details.pipe，管道头 = 名称 + 计数 + 状态摘要串", () => {
  const s = renderDependencyGraphSection(pipe6Tasks());
  assert.match(s.html, /<h2>依赖图（6 任务 · 3 管道 · 声明 5 边（本质 5 · 传递省略 0））<\/h2>/);
  assert.equal(
    (s.html.match(/<details class="pipe" open style="[^"]*">/g) ?? []).length,
    3,
    "每 project 一枚管道且默认展开（G10 · ⑦(ii)：**枚数期望 3 不翻** —— 框制与管道制同数；正字面随固定盒多出 `style` 段）",
  );
  assert.match(
    s.html,
    /<div class="dg-canvas" style="[^"]*">\n<svg class="dg-links">(<path class="[^"]*" d="[^"]*"\/>)*<\/svg>\n<details class="pipe" open style="[^"]*">/,
    "G10 翻案（⑦(ii) · nesting 半句）：首枚 `details` 的父 = `.dg-canvas` —— 画布开标签与框之间只隔画布级那一枚 `svg.dg-links`（原「框在 `.dep-graph` 块流里」的层阶上收一层）",
  );
  const heads = [
    ["board", 3, "●◐○"],
    ["orch", 1, "●"],
    ["flow", 2, "●▨"],
  ];
  for (const [proj, cnt, glyphs] of heads) {
    const head = `<summary>管道 ${proj}（${cnt}）<span class="dg-pipe-states">${glyphs}</span></summary>`;
    assert.ok(s.html.includes(head), `管道 ${proj} 的头在场：${head}`);
  }
  assert.ok(s.html.indexOf("<summary>管道 board") < s.html.indexOf("<summary>管道 flow"), "管道序 = projectId 升序");
  assert.equal(
    (s.html.match(/<div class="pipe-body">/g) ?? []).length,
    3,
    "每框一枚 `.pipe-body`（G10 · ⑦(ii)：**枚数不翻、声明不翻** —— 本锚只改口径：体壳仍在框子树内，**滚动职责已上收图区父层 `.dep-graph`**（基类 `overflow-x:auto` 迁出，改造文档 §2.2.2 / 增补 `a0682281` 件二订正），原「滚动职责归 N2c 的 CSS」那句指的是已退役的逐框横滚）",
  );

  const chips = s.html.match(/<span class="dg-chip dg-\w+" title="[^"]*">#\d+/g) ?? [];
  assert.equal(chips.length, 6, "chip 数 === 任务数");
  for (const c of chips) assert.match(c, />#\d+$/, `chip 可见文字形如 #3：${c}`);
  for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(chips.some((c) => c.endsWith(`#${n}`)), `#${n} 在场（编号连续）`);
  assert.equal(
    (s.html.match(/<span class="dg-arrow">→<\/span>/g) ?? []).length,
    0,
    "G5 翻案（②）：位置性箭头退役（原锚钉「箭头只插在同管道相邻 chip 之间」= 3 枚）",
  );
  assert.equal(
    (s.html.match(/<svg class="dg-links">/g) ?? []).length,
    1,
    "G10 翻案（⑦(ii)，承原「边线层按管道分席 ⇒ 每 project 恰一枚」）：合并单画布 ⇒ 全图恰一枚 `dg-links`，框内零枚（枚数与 `.dg-canvas` 同源，逐框零枚另由 G8-svg负钉③ 钉）",
  );
  // v0.10.6 §2.3 翻案（n14 收口，改造文档 §2.3 走线取 (A) 框外公共通道带）：
  // 旧口径「跨管道边结构上不入走线 ⇒ 全图恰一枚 path」正是本需求要消解的对象
  // ⇒ 现钉「本质边全部入走线」= 框内 1（t-b1→t-b2）+ 跨框 4 = 5（跨框 / 框内按端点落框分类，与 N2对锚② 同一账）
  const face = graphFaceLedger(s.html);
  assert.equal(face.paths, 5, "五边全入走线（跨框边不再是「画不出」的那一枚）");
  assert.deepEqual(
    [face.paths - face.cross, face.cross],
    [1, 4],
    "分席 = 框内恰 1 枚 + 跨框恰 4 枚（同管道两端者仅 t-b1→t-b2）",
  );
  assert.ok(s.html.includes('class="dg-chip dg-queued"'), "排队档类名 dg-queued（chip 类名 = dg-<态>）");
  assert.ok(
    s.html.includes("#6 · 排队·被挡 · 被挡：project_busy · 依赖：t-f1"),
    "全量 taskId / 状态 / 依赖原值只进 title",
  );
});

test("N2b-N2负向钉：图形 HTML 内不得出现任何 prompt 文本子串（反斜杠 / 控制字符 / 【】壳 / script 字面全不含）", () => {
  const hostile = [
    "依赖图修复",
    "\\\\ 含裸反斜杠",
    String.fromCharCode(1) + "含控制字符",
    "【需求 REQ-2026-10-11-02 · Step 2 节点 X】壳",
    "<script>alert(1)</script>",
    String.fromCharCode(9) + "含制表符",
  ].join(" ");
  const tasks = [
    task("p-1", "completed", [], { projectId: "proj-a", queuedAt: "2026-10-11T00:00:01Z", prompt: hostile }),
    task("p-2", "working", ["p-1"], { projectId: "proj-b", queuedAt: "2026-10-11T00:00:02Z", prompt: hostile }),
  ];
  const s = renderDependencyGraphSection(tasks);
  for (const t of tasks) {
    assert.equal(
      s.html.indexOf(t.prompt.slice(0, 6)),
      -1,
      `每条任务的 prompt 前 6 字符都不得出现在图形 HTML（可见文字与 title 同样不含）`,
    );
  }
  for (const needle of ["依赖图修复", "【需求", "alert(1)", "<script", "</script>", "\\", String.fromCharCode(1), String.fromCharCode(9)]) {
    assert.equal(s.html.includes(needle), false, `图形 HTML 不得出现 ${JSON.stringify(needle)}`);
  }
  // 最强的正向证明：同一夹具把 prompt 全置 null ⇒ 渲染逐字相等（图形面对 prompt 零依赖）
  const noPrompt = renderDependencyGraphSection(tasks.map((t) => ({ ...t, prompt: null })));
  assert.equal(noPrompt.html, s.html, "要点完全不进图形 HTML ⇒ 有无 prompt 渲染同文");
  assert.equal(s.html.includes("#1"), true, "自绘形态本身在场（负向钉不许空转）");
  assert.equal(s.html.includes("dg-edges"), true, "两条任务分属两 project ⇒ 跨管道边清单行在场（钉本锚非空转）");
});

test("N2b-N6跨框边只出真走线与边清单：inline 零 position + 画布恰一枚 svg（G10·⑦(ii) 单画布），角标封顶退役 ⇒ 逐枚全落线", () => {
  const s = renderDependencyGraphSection(pipe6Tasks());
  // 4 条跨框边（第 5 条 t-b1→t-b2 同框）⇒ 4 枚跨框 path + 一行边清单（角标那枚出口整体退役，见 C5）
  const face = crossFaceCounts(s.html);
  assert.deepEqual(
    [face.cross, face.list],
    [4, 4],
    "v0.10.6 翻案（角标档）：跨框边的「逐枚可见」改由几何面承担 ⇒ 跨框 path 枚数 === 清单枚数 === 4",
  );
  assert.equal(face.intra, 1, "同框只 t-b1→t-b2 一枚 ⇒ 4 枚跨框不是把同框边也算进来的凑数");
  assert.match(
    s.html,
    /<p class="hint dg-edges">跨管道边：#1 ⇢ #4\(flow\)、#2 ⇢ #3\(orch\)、#4 ⇢ #6\(board\)、#3 ⇢ #5\(flow\)（全量依赖见各节点 title）<\/p>/,
    "边清单 = 图区底部一行（列全部跨框边 · 文本面不翻案，与几何面并列同源）",
  );
  assert.ok(s.html.indexOf("dg-edges") > s.html.indexOf("</details>"), "边清单在管道之后（图区底部）");
  assert.equal(s.html.includes("position:absolute"), false, "inline style 零 position 声明（cell 只带 left/top，定位归 CSS · 本句不翻）");
  assert.equal(s.html.includes("position: absolute"), false, "同上不认带空格形态");
  assert.equal(
    (s.html.match(/<svg class="dg-links">/g) ?? []).length,
    1,
    "G10 翻案（⑦(ii)，原 G5 翻案（⑧）「每管道恰一枚 dg-links」）：合并单画布 ⇒ 画布恰一枚边线层（与框枚数脱钩，只与 `.dg-canvas` 同源）",
  );
  assert.equal(
    s.html.split('<div class="pipe-body">').slice(1).filter((b) => b.includes('<svg class="dg-links">')).length,
    0,
    "G10 翻案（⑦(ii) · svg 半句的另一半）：每框体壳内零枚边线层 —— svg 已从「框 › pipe-body › dg-grid」搬到画布层（inline 零 position 半句不翻，见上两条）",
  );
  assert.equal(s.html.includes("<script"), false, "零 script 标签（n3 内联闭集不扩）");
  // 无跨框边 ⇒ 整行不渲
  const noCross = renderDependencyGraphSection([task("a1"), task("a2", "completed", ["a1"])]);
  assert.equal(noCross.html.includes("dg-edges"), false, "全无跨框边 ⇒ 边清单整行不渲");
  // 旧「角标封顶 3 枚、第 4 枚起折叠」的下界场景：5 枚跨框入边 ⇒ 逐枚全落线、零折叠形态
  const many = renderDependencyGraphSection([
    ...[1, 2, 3, 4, 5].map((i) =>
      task(`m${i}`, "completed", [], { projectId: "src", queuedAt: `2026-10-11T00:00:0${i}Z` }),
    ),
    task("tgt", "completed", ["m1", "m2", "m3", "m4", "m5"], {
      projectId: "dst",
      queuedAt: "2026-10-11T00:00:06Z",
    }),
  ]);
  const manyFace = crossFaceCounts(many.html);
  assert.deepEqual(
    [manyFace.cross, manyFace.paths, manyFace.list],
    [5, 5, 5],
    "v0.10.6 翻案（封顶 / 折叠档）：5 枚跨框边**逐枚**落成 5 条 path ⇒ 不存在「图上少画、靠折叠吞掉」的形态（旧锚的折叠记号已无对应出口）",
  );
  assert.equal(many.html.includes("<sup"), false, "角标 DOM 退役 ⇒ 折叠壳（dg-dep-more）也无从在场");
  assert.equal(many.html.includes("⇠"), false, "负向一侧：折叠记号整族不再出现（本锚不空转，正向由上面 5 枚承担）");
});

test("N2b-提示行照旧：环 / 悬空入参 ⇒ hint warn 行在场且两个既有起头串齐（自绘不改提示面）", () => {
  const s = renderDependencyGraphSection([
    task("c-a", "completed", ["c-b"]),
    task("c-b", "completed", ["c-a", "c-external"]),
  ]);
  assert.match(s.html, /class="hint warn"/);
  assert.ok(s.html.includes("环防御："), "既有起头串「环防御」保留");
  assert.ok(s.html.includes("跨需求/未登记依赖 1 条不画"), "既有起头串「跨需求/未登记依赖」保留");
  assert.ok(s.html.includes(`${short("c-a")} → ${short("c-b")}`), "仍用 shortId 展示 id");
  assert.ok(s.html.includes(`${short("c-b")} ⇢ ${short("c-external")}`), "悬空行仍用 shortId 展示 id");
  // 提示行在场不影响管道结构
  assert.equal(
    (s.html.match(/<details class="pipe" open style="[^"]*">/g) ?? []).length,
    1,
    "G10 连带（⑦(ii) · 结构字面族同一事实）：管道枚数期望 1 **不翻**，仅正字面随固定盒多出 `style` 段",
  );
});

// ---------------------------------------------------------------------------
// 增补 A1（v0.10.3 · REQ-2026-10-11-02）chip 六态着色补齐：
// `.dg-chip` 基础规则只给中性 border/background ⇒ `dg-<态>` 状态类是空钩子、任何状态 chip 恒白。
// 本锚钉七条变体规则齐（缺一即红）且色值与图例同一事实源不漂移。
// 类名以代码实际产出为准 = `dg-${nodeStateOf().key}`（NodeState 闭集 done/running/queued/
// failed/frozen/ask/unknown）；派发消息的 dg-run / dg-fail 是简写，宿主 2026-10-11 裁定 A 更正。
// ---------------------------------------------------------------------------

test("增补A1-chip 七态变体规则齐：七枚全在场、border+background = 图例同一事实源（NODE_STATE_COLORS）", () => {
  const css = renderPage({ title: "t", active: "features", bodyHtml: "" });
  assert.equal(NODE_STATE_ORDER.length, 7, "枚数基线 = 六态 + 回落七档闭集");
  const missing = [];
  for (const key of NODE_STATE_ORDER) {
    const color = NODE_STATE_COLORS[key];
    const rule = new RegExp(`\\.dg-chip\\.dg-${key} \\{ border-color: ${color}; background: ${color}; \\}`);
    if (!rule.test(css)) missing.push(key);
  }
  assert.deepEqual(missing, [], "七条 `.dg-chip.dg-<态>` 变体齐且色值逐字同源（缺枚或色漂移 ⇒ 本条红）");
  // 基础规则的中性配色不被动过：未命中状态类时 chip 仍回落中性
  assert.match(
    css,
    /\.dg-chip \{[^}]*border: 1px solid var\(--b-line\)[^}]*background: var\(--b-surface\)[^}]*white-space: nowrap;/,
    "基础规则原样（变体靠双类选择器更高优先级生效）",
  );
  // 图形 HTML 侧的钩子名与本锚同源（chip 类名 = dg-<key>，防两侧类名漂移）
  const s = renderDependencyGraphSection([
    task("a1-run", "working", [], { projectId: "p", queuedAt: "2026-10-11T00:00:01Z", queueState: "running" }),
    task("a1-fail", "failed", [], { projectId: "p", queuedAt: "2026-10-11T00:00:02Z" }),
  ]);
  assert.ok(s.html.includes('class="dg-chip dg-running"'), "running 档 chip 类名与 CSS 变体同名");
  assert.ok(s.html.includes('class="dg-chip dg-failed"'), "failed 档 chip 类名与 CSS 变体同名");
});

// ---------------------------------------------------------------------------
// G1（v0.10.5 · REQ-2026-10-12-02「依赖图按真依赖边绘制」· 改造文档 §2.4-①②）：
// 两枚分层纯函数 —— layerOfGraph（全图 Kahn + longest-path，层距吃全 edges）
// 与 compressPipeLayers（每管道压成密列）。本组只算层号 / 列号，**不算几何、不渲染**。
// ---------------------------------------------------------------------------

/** 一次构好图（`buildGraphWithPipelines` + `taskOrdinalMap`）并把「按 project 取密列」封成可调函数。 */
const g1Fixture = (tasks) => {
  const graph = buildGraphWithPipelines(tasks);
  const layers = layerOfGraph(graph.nodes, taskOrdinalMap(tasks), graph.edges);
  const colsOf = (projectId) => {
    const pipe = graph.pipelines.find((p) => p.projectId === projectId);
    return pipe ? compressPipeLayers(pipe, layers) : null;
  };
  return { graph, layers, colsOf };
};

test("G1-①分层：同管道链 a→b→c 层号 0/1/2；无依赖的孤立节点落 0（不吞）", () => {
  const { layers } = g1Fixture([
    task("g1-a", "completed", [], { queuedAt: "2026-10-12T00:00:01Z" }),
    task("g1-b", "completed", ["g1-a"], { queuedAt: "2026-10-12T00:00:02Z" }),
    task("g1-c", "working", ["g1-b"], { queuedAt: "2026-10-12T00:00:03Z" }),
    task("g1-z", "completed", null, { queuedAt: "2026-10-12T00:00:04Z" }),
  ]);
  assert.equal(layers.get("g1-a"), 0, "链首 = 0 起");
  assert.equal(layers.get("g1-b"), 1);
  assert.equal(layers.get("g1-c"), 2);
  assert.equal(layers.get("g1-z"), 0, "孤立节点 ⇒ 0（层号只由 edges 决定，不由 queuedAt 决定）");
});

test("G1-②层距吃全 edges（C3 采纳口径）：只依赖他管道节点的节点，全局层号必须 > 0", () => {
  const { graph, layers } = g1Fixture([
    task("x-b1", "completed", [], { projectId: "board", queuedAt: "2026-10-12T00:00:01Z" }),
    task("x-o1", "completed", ["x-b1"], { projectId: "orch", queuedAt: "2026-10-12T00:00:02Z" }),
    task("x-b2", "working", ["x-o1"], { projectId: "board", queuedAt: "2026-10-12T00:00:03Z" }),
  ]);
  assert.equal(graph.pipelines.length, 2, "夹具确为两管道（否则本锚空转）");
  assert.ok(layers.get("x-b2") > 0, "负钉：本管道内无入边 ⇒ 不得落 layer 0");
  assert.equal(layers.get("x-o1"), 1);
  assert.equal(layers.get("x-b2"), 2, "跨管道边照抬层 ⇒ 全图层号连续可比，跨管道前后关系以层距体现");
});

test("G1-③longest-path：汇合节点取最长前驱路径（不是最早可达、不是入度）", () => {
  const { layers } = g1Fixture([
    task("lp-r", "completed", [], { queuedAt: "2026-10-12T00:00:01Z" }),
    task("lp-x", "completed", ["lp-r"], { queuedAt: "2026-10-12T00:00:02Z" }),
    task("lp-y", "completed", ["lp-x"], { queuedAt: "2026-10-12T00:00:03Z" }),
    task("lp-d", "working", ["lp-y", "lp-r"], { queuedAt: "2026-10-12T00:00:04Z" }),
  ]);
  assert.equal(layers.get("lp-y"), 2);
  assert.equal(layers.get("lp-d"), 3, "d 依赖 y(2) 与 r(0) ⇒ 取最长 = 3，不是最早可达的 1");
});

test("G1-④确定性：入参数组序无关、重复调用逐键相等（就绪集按 taskOrdinalMap 号序取）", () => {
  const graph = buildGraphWithPipelines(pipe6Tasks());
  const ordinals = taskOrdinalMap(pipe6Tasks());
  const once = layerOfGraph(graph.nodes, ordinals, graph.edges);
  const shuffled = layerOfGraph([...graph.nodes].reverse(), ordinals, [...graph.edges].reverse());
  assert.deepEqual(shuffled, once, "打乱 nodes / edges 数组序 ⇒ 层号逐键相等");
  assert.deepEqual([...layerOfGraph(graph.nodes, ordinals, graph.edges).keys()], [...once.keys()], "重复调用出参键序亦相等");
  assert.deepEqual([...once.keys()], graph.nodes.map((n) => n.taskId), "出参键序 = 入参 nodes 序（调用方可直接遍历）");
});

test("G1-⑤净化归构图层：layerOfGraph 不自检环、不丢边 —— 脏入参不死循环且不吞键；经 buildTaskGraph 后恒为 DAG", () => {
  const dirtyNodes = [task("cy-a"), task("cy-b"), task("cy-c", "completed", ["cy-a"])];
  const cyclicEdges = [
    { from: "cy-a", to: "cy-b" },
    { from: "cy-b", to: "cy-a" },
    { from: "cy-a", to: "cy-c" },
  ];
  const raw = layerOfGraph(dirtyNodes, taskOrdinalMap(dirtyNodes), cyclicEdges);
  assert.deepEqual([...raw.keys()], ["cy-a", "cy-b", "cy-c"], "残留环也不吞键（出参恒覆盖 nodes 全集）");
  const dirtyTasks = [
    task("cy-a", "completed", ["cy-b"]),
    task("cy-b", "completed", ["cy-a"]),
    task("cy-c", "completed", ["cy-a"]),
  ];
  const g = buildTaskGraph(dirtyTasks);
  assert.deepEqual(
    g.cycleEdges.map((e) => `${e.from}->${e.to}`),
    ["cy-a->cy-b", "cy-b->cy-a"],
    "环边由 buildTaskGraph 丢弃（分工所在）",
  );
  const clean = layerOfGraph(g.nodes, taskOrdinalMap(dirtyTasks), g.edges);
  assert.deepEqual([...clean.entries()], [["cy-a", 0], ["cy-b", 0], ["cy-c", 1]], "滤环后的 edges 入分层 ⇒ 恒为 DAG、无残留");
});

test("G1-⑥密列压缩：该管道无节点的中间列不占位 ⇒ 列号从 0 起、连续 0..K-1、每列非空", () => {
  const { layers, colsOf } = g1Fixture([
    task("s-b1", "completed", [], { projectId: "board", queuedAt: "2026-10-12T00:00:01Z" }),
    task("s-f1", "completed", ["s-b1"], { projectId: "flow", queuedAt: "2026-10-12T00:00:02Z" }),
    task("s-b2", "completed", ["s-f1"], { projectId: "board", queuedAt: "2026-10-12T00:00:03Z" }),
    task("s-f2", "completed", ["s-b2"], { projectId: "flow", queuedAt: "2026-10-12T00:00:04Z" }),
    task("s-f3", "completed", ["s-f2"], { projectId: "flow", queuedAt: "2026-10-12T00:00:05Z" }),
    task("s-b3", "working", ["s-f3"], { projectId: "board", queuedAt: "2026-10-12T00:00:06Z" }),
  ]);
  assert.deepEqual(
    ["s-b1", "s-f1", "s-b2", "s-f2", "s-f3", "s-b3"].map((id) => [id, layers.get(id)]),
    [["s-b1", 0], ["s-f1", 1], ["s-b2", 2], ["s-f2", 3], ["s-f3", 4], ["s-b3", 5]],
    "board 独占的中间层 1/3/4 归 flow ⇒ board 全局层 = {0,2,5}",
  );
  const cols = colsOf("board");
  assert.deepEqual([...cols.entries()], [["s-b1", 0], ["s-b2", 1], ["s-b3", 2]], "空列不占位 ⇒ 压成 0/1/2");
  const k = Math.max(...cols.values()) + 1;
  assert.equal(new Set(cols.values()).size, k, "值域连续 0..K-1");
  for (let c = 0; c < k; c += 1) assert.ok([...cols.values()].includes(c), `第 ${c} 列非空（每列至少一节点）`);
});

test("G1-⑦密列保序：全局层升序 ⇔ 列号严格升序；同层两节点同列；出参插入序 = 列号升序", () => {
  const { layers, colsOf } = g1Fixture([
    task("pm-a", "completed", [], { queuedAt: "2026-10-12T00:00:01Z" }),
    task("pm-b1", "completed", ["pm-a"], { queuedAt: "2026-10-12T00:00:02Z" }),
    task("pm-b2", "completed", ["pm-a"], { queuedAt: "2026-10-12T00:00:03Z" }),
    task("pm-c", "working", ["pm-b1", "pm-b2"], { queuedAt: "2026-10-12T00:00:04Z" }),
  ]);
  const cols = colsOf("proj-a");
  assert.equal(layers.get("pm-b1"), 1);
  assert.equal(cols.get("pm-b1"), cols.get("pm-b2"), "并列的两节点同列（并行节点呈并列）");
  assert.equal(cols.get("pm-a"), 0, "列号从 0 起");
  assert.equal(cols.get("pm-c"), 2, "单管道满层 ⇒ 列号 === 全局层号（无空列可压）");
  assert.ok(cols.get("pm-b1") > cols.get("pm-a") && cols.get("pm-c") > cols.get("pm-b1"), "保序：层升 ⇒ 列严格升");
  assert.deepEqual([...cols.keys()], ["pm-a", "pm-b1", "pm-b2", "pm-c"], "插入序 = 列号升序、同列按管道号序");
});

test("G1-⑧负钉实测（pipe6 夹具）：board t-b3 只依赖 flow 的 t-f1 ⇒ 压缩后列号 2（≠0）；单节点管道 ⇒ 列 0", () => {
  const { layers, colsOf } = g1Fixture(pipe6Tasks());
  assert.equal(layers.get("t-b1"), 0);
  assert.equal(layers.get("t-b2"), 1);
  assert.equal(layers.get("t-f1"), 1);
  assert.equal(layers.get("t-o1"), 2);
  assert.equal(layers.get("t-b3"), 2, "b3 的本管道内无入边、但有跨管道入边 ⇒ 层号 2");
  assert.equal(layers.get("t-f2"), 3);
  const board = colsOf("board");
  assert.ok(board.get("t-b3") === 2 && board.get("t-b3") !== 0, "板内任务不被压回首列（负钉的列号形式：≠0）");
  assert.deepEqual([...board.entries()], [["t-b1", 0], ["t-b2", 1], ["t-b3", 2]]);
  assert.deepEqual([...colsOf("orch").entries()], [["t-o1", 0]], "单节点管道 ⇒ 唯一列 0（跨管道层号不残留空列）");
  assert.deepEqual([...colsOf("flow").entries()], [["t-f1", 0], ["t-f2", 1]]);
});

// ---------------------------------------------------------------------------
// G2（v0.10.5 · REQ-2026-10-12-02 · 改造文档 §2.3 / §2.4-③ / §2.5-I4）：
// 网格几何单一事实源 —— DG_* 常量 + pipeGridLayout（cells / colX / rowY / 通道 / 宽高）。
// 本组只算几何，**不走线、不产 HTML/CSS**（渲染 = G3，走线 = G2 之后的 routeIntraEdges）。
// ---------------------------------------------------------------------------

/** 角标单枚的**设计宽度**（改造文档 §2.3 C2：`⇠#k` 至多 4 枚 × ~32px ≤ `DG_BADGE_MAX_W`）。 */
const BADGE_MARK_DESIGN_W = 32;

/** 一次构图 + 分层 + 密列，并把「按 project 取网格几何」封成可调函数。 */
const g2Fixture = (tasks, budget = {}) => {
  const graph = buildGraphWithPipelines(tasks);
  const ordinals = taskOrdinalMap(tasks);
  const layers = layerOfGraph(graph.nodes, ordinals, graph.edges);
  const layoutOf = (projectId) => {
    const pipe = graph.pipelines.find((p) => p.projectId === projectId);
    if (!pipe) return null;
    return pipeGridLayout(pipe, compressPipeLayers(pipe, layers), ordinals, budget);
  };
  return { graph, ordinals, layers, layoutOf };
};

/** 需求 `076bbb84` 的真实 DAG（原型对照稿 §样本：7 节点 / 10 条真依赖边，单管道）。 */
const sample076bbb84 = () => {
  const deps = { 1: [], 2: ["n1"], 3: ["n2"], 4: ["n2"], 5: ["n1"], 6: ["n1", "n2", "n3", "n4", "n5"], 7: ["n6"] };
  return Object.entries(deps).map(([n, ds]) =>
    task(`n${n}`, Number(n) === 7 ? "working" : "completed", ds, {
      projectId: "board",
      queuedAt: `2026-10-12T00:00:0${n}Z`,
    }),
  );
};

test("G2-①确定性：同入参重复调用逐字段相等、乱序入参等值；cells 序 = 列升序 + 同列号序", () => {
  const { graph, ordinals, layers } = g2Fixture(sample076bbb84());
  const pipe = graph.pipelines.find((p) => p.projectId === "board");
  const columns = compressPipeLayers(pipe, layers);
  const once = pipeGridLayout(pipe, columns, ordinals);
  const twice = pipeGridLayout(pipe, columns, ordinals);
  assert.deepEqual(twice, once, "重复调用 ⇒ 出参逐字段相等");
  const fromShuffled = pipeGridLayout({ projectId: pipe.projectId, nodes: [...pipe.nodes].reverse() }, columns, ordinals);
  assert.deepEqual(fromShuffled, once, "管道内数组序反转 ⇒ 几何逐字段相等（列内序由号序决定，不由入参数组序决定）");
  assert.deepEqual(
    once.cells.map((c) => `${c.col}:${c.ordinal}`),
    ["0:1", "1:2", "1:5", "2:3", "2:4", "3:6", "4:7"],
    "格位序 = 列号升序、同列内号序升序",
  );
  assert.equal(once.cells.length, 7, "格位数 === 节点数（不丢不重）");
});

test("G2-②每列非空 + 格位两两不同：COL_X[0]=PAD_L、ROW_Y 递推式、rows=最大列容量", () => {
  const { layoutOf } = g2Fixture(sample076bbb84());
  const L = layoutOf("board");
  assert.equal(L.colX[0], DG_PAD_L, "COL_X[0] = PAD_L（左内缘即首列）");
  for (let c = 1; c < L.cols; c += 1) {
    assert.equal(L.colX[c], L.colX[c - 1] + DG_NODE_W + L.gapW[c - 1], `colX[${c}] 由前列右缘 + 通道宽递推`);
    assert.ok(L.gapW[c - 1] >= DG_COL_GAP_MIN, `通道 ${c - 1} 宽恒 ≥ DG_COL_GAP_MIN`);
  }
  assert.equal(L.rowY[0], DG_PAD_T, "ROW_Y[0] = PAD_T");
  L.rowY.forEach((y, r) => {
    assert.equal(y, DG_PAD_T + r * (DG_BADGE_H + DG_NODE_H + DG_ROW_GAP), `ROW_Y[${r}] 递推式`);
  });
  assert.equal(L.rows, 2, "rows = 最大列容量（本样本两列各 2 枚）");
  const seen = new Set();
  for (const cell of L.cells) {
    const key = `${cell.col}:${cell.row}`;
    assert.ok(!seen.has(key), `格位 ${key} 不重复`);
    seen.add(key);
    assert.ok(cell.col >= 0 && cell.col < L.cols, "列号在值域内");
    assert.ok(cell.row >= 0 && cell.row < L.rows, "行号在值域内");
    assert.equal(cell.x, L.colX[cell.col], "cell.x === COL_X[col]");
    assert.equal(cell.y, L.rowY[cell.row], "cell.y === ROW_Y[row]");
    assert.equal(cell.chipY, cell.y + DG_BADGE_H, "chip 顶缘 = cell 顶缘 + 角标带（角标带恒预留）");
    assert.equal(cell.chipRight, cell.x + DG_NODE_W, "chip 右缘 = x + DG_NODE_W（定宽 ⇒ 与内容无关）");
    assert.equal(cell.chipMidY, cell.y + DG_BADGE_H + DG_NODE_H / 2, "端点定义式纵坐标 = ROW_Y + BADGE_H + NODE_H/2");
    for (const v of [cell.x, cell.y, cell.chipY, cell.chipRight, cell.chipMidY, cell.w, cell.h]) {
      assert.ok(Number.isInteger(v), `全整数几何（无半像素）：${v}`);
    }
    assert.ok(L.cellOf.get(cell.taskId) === cell, "cellOf 取数面与 cells 同引用");
  }
  const byCol = new Map();
  for (const cell of L.cells) byCol.set(cell.col, (byCol.get(cell.col) ?? 0) + 1);
  assert.equal(byCol.size, L.cols, "每列非空（列数 === 有格位的列数）");
  for (let c = 0; c < L.cols; c += 1) assert.ok((byCol.get(c) ?? 0) > 0, `第 ${c} 列非空`);
});

test("G2-③I4 内容包含 + 通道 lane 预算回灌：width/height 两条不等式、lane 线落在通道内", () => {
  const budget = { gapLanes: [3, 1, 4, 2], busLaneCount: 3 };
  const { layoutOf } = g2Fixture(sample076bbb84(), budget);
  const L = layoutOf("board");
  const rightmost = Math.max(...L.cells.map((c) => c.chipRight));
  // v0.10.6 C6 翻案（改造文档 §2.2-C6 / §4.4）：角标族退役 ⇒ `width = contentRight + DG_PAD_R`
  // —— 式形（不等式、加数为右内缘）逐字保留，只把加数从 `DG_BADGE_MAX_W` 换成 `DG_PAD_R`。
  assert.ok(L.width >= rightmost + DG_PAD_R, `I4 宽：${L.width} ≥ 最右 chip 右缘 ${rightmost} + ${DG_PAD_R}（右内缘 = DG_PAD_R，不含角标越界加数）`);
  const busBandBottom = L.busBandTop + L.busLanes.length * DG_BUS_PITCH;
  assert.ok(L.height >= busBandBottom + DG_PAD_B, `I4 高：${L.height} ≥ 通道带底 ${busBandBottom} + ${DG_PAD_B}`);
  const bottom = Math.max(...L.cells.map((c) => c.y + c.h));
  assert.ok(L.height >= bottom + DG_PAD_B, "I4 高（无带时亦盖过最后一格底缘）");
  for (const cell of L.cells) {
    assert.ok(cell.x + cell.w <= L.width, "格位不越右边界（防 overflow 裁切）");
    assert.ok(cell.y + cell.h <= L.height, "格位不越下边界");
  }
  assert.equal(L.gapW.length, L.cols - 1, "通道数 = 列数 - 1");
  L.gapW.forEach((w, c) => {
    const n = L.lanes[c].length;
    assert.equal(w, Math.max(DG_COL_GAP_MIN, DG_LANE_MIN * 2 + n * DG_LANE_PITCH), `gapW[${c}] 公式`);
    assert.ok(w >= DG_COL_GAP_MIN, `gapW[${c}] 恒 ≥ 下界`);
    L.lanes[c].forEach((x, i) => {
      assert.equal(x, L.colX[c] + DG_NODE_W + DG_LANE_MIN + i * DG_LANE_PITCH, `通道 ${c} 第 ${i} 枚 lane 的 x 线`);
      assert.ok(x > L.colX[c] + DG_NODE_W && x < L.colX[c + 1], "lane 线落在两列 chip 之间的通道内");
    });
  });
  assert.equal(L.busLanes.length, budget.busLaneCount, "带内 lane 数 = 预算回灌数");
  L.busLanes.forEach((y, i) => {
    assert.ok(y >= L.busBandTop && y < L.busBandTop + L.busLanes.length * DG_BUS_PITCH, `带内 lane ${i} 落在通道带里`);
    assert.ok(Number.isInteger(y), "带内 lane 线为整数");
    if (i > 0) assert.equal(y - L.busLanes[i - 1], DG_BUS_PITCH, `lane ${i} 间距 = DG_BUS_PITCH`);
  });
  const zero = g2Fixture(sample076bbb84()).layoutOf("board");
  assert.deepEqual(zero.lanes.map((l) => l.length), [0, 0, 0, 0], "缺省预算 ⇒ 各通道 0 枚 lane（走线侧再回灌）");
  assert.deepEqual(zero.busLanes, [], "缺省预算 ⇒ 通道带空");
  zero.gapW.forEach((w) => assert.equal(w, DG_COL_GAP_MIN, "缺省 ⇒ 通道宽取下界"));
});

test("G2-④空管道短路：零 cell ⇒ 零列零行、宽高 0（渲染侧短路不受影响）", () => {
  const L = pipeGridLayout({ projectId: "empty", nodes: [] }, new Map(), new Map());
  assert.deepEqual(L.cells, [], "无格位");
  assert.equal(L.cols, 0);
  assert.equal(L.rows, 0);
  assert.equal(L.width, 0);
  assert.equal(L.height, 0);
  assert.deepEqual([...L.cellOf.keys()], [], "取数面空且每次新建（不共享可变对象）");
  assert.deepEqual([...L.gapW], [], "无通道");
  assert.deepEqual([...L.lanes], [], "无 lane");
  assert.deepEqual([...L.colX], [], "无 COL_X");
  const still = renderDependencyGraphSection([]);
  assert.equal(still.html, "", "tasks.length===0 的整节短路照旧（G2 未触碰渲染面）");
});

test("G2-样本076bbb84：列分布 {0:#1}{1:#2,#5}{2:#3,#4}{3:#6}{4:#7}、R=2、长边 3", () => {
  const tasks = sample076bbb84();
  const graph = buildGraphWithPipelines(tasks);
  const ordinals = taskOrdinalMap(tasks);
  const layers = layerOfGraph(graph.nodes, ordinals, graph.edges);
  assert.equal(graph.edges.length, 10, "样本 = 10 条真依赖边（原型对照稿同数）");
  const pipe = graph.pipelines[0];
  const columns = compressPipeLayers(pipe, layers);
  const L = pipeGridLayout(pipe, columns, ordinals);
  const dist = new Map();
  for (const cell of L.cells) dist.set(cell.col, [...(dist.get(cell.col) ?? []), `#${cell.ordinal}`]);
  assert.deepEqual(
    [...dist.entries()].sort((a, b) => a[0] - b[0]),
    [[0, ["#1"]], [1, ["#2", "#5"]], [2, ["#3", "#4"]], [3, ["#6"]], [4, ["#7"]]],
    "五列分布（#6 的 5 枚入边 = 宽 fan-in 夹具）",
  );
  assert.equal(L.cols, 5);
  assert.equal(L.rows, 2, "R = 2（两列各并列两枚）");
  const longEdges = graph.edges.filter((e) => (columns.get(e.to) ?? 0) - (columns.get(e.from) ?? 0) >= 2);
  assert.deepEqual(
    longEdges.map((e) => `#${ordinals.get(e.from)}→#${ordinals.get(e.to)}`),
    ["#1→#6", "#2→#6", "#5→#6"],
    "长边 3 条（列差 ≥2 ⇒ 走通道带；其余 7 条为相邻弧）",
  );
});

test("G7-定宽①设计界关系式：框右缘内缘式 + 通道带宽下界 ⇒ 定宽不破、右侧留白足够", () => {
  // v0.10.6 C5/C6 翻案：旧式「角标越界（DG_BADGE_MAX_W − DG_NODE_W）≤ 通道下界」随角标族退役而**取等式失效**
  // （`DG_BADGE_MAX_W` 已摘除）⇒ 本条改钉两件事：① 最右 chip 右缘到**框右缘**的内缘式；② 通道带宽下界仍兜住两侧 lane。
  const { graph, layoutOf } = g2Fixture(sample076bbb84());
  const L = layoutOf("board");
  const pipe = graph.pipelines.find((p) => p.projectId === "board");
  const rightmost = Math.max(...L.cells.map((c) => c.chipRight));
  // ① 网格右内缘：`width = contentRight + DG_PAD_R`（加数唯一 ⇒ 定宽与「本列有几枚角标」彻底脱钩）
  assert.equal(L.width - rightmost, DG_PAD_R, "chip 右缘 → 网格右缘 = DG_PAD_R（唯一加数）");
  // ② 框右缘内缘式（canvasLayout 的 frameW 定义式）：网格右缘 → 框右缘 = pad + border（左右各一级）
  const frame = canvasLayout([pipe], [L]).frameOf.get("board");
  assert.ok(frame !== undefined, "board 框在册（canvasLayout 的 frameOf 取数面）");
  assert.equal(frame.frameW, L.width + 2 * (DG_FRAME_BORDER + DG_FRAME_PAD), "框外宽 = 网格宽 + 2·(DG_FRAME_BORDER + DG_FRAME_PAD)");
  assert.equal(
    frame.frameW - rightmost,
    DG_PAD_R + 2 * (DG_FRAME_BORDER + DG_FRAME_PAD),
    "chip 右缘 → 框右缘 = DG_PAD_R + 2·(border + pad)（框右边线不切 chip 的定义式）",
  );
  assert.ok(frame.frameW - rightmost > DG_FRAME_TITLE_H, "右侧留白足够（不亚于标题带高 ⇒ 框内不出现「右边比上边紧」）");
  // ③ 列间通道：`DG_COL_GAP_MIN` **数值不动（56）**，语义重定为「2·DG_LANE_MIN + 余量」的带宽下界
  assert.ok(DG_COL_GAP_MIN >= 2 * DG_LANE_MIN, `通道带宽下界 ${DG_COL_GAP_MIN} ≥ 两侧各一枚 lane 的下界 2×${DG_LANE_MIN}`);
  assert.equal(DG_COL_GAP_MIN - 2 * DG_LANE_MIN, 12, "余量 = 12（抬 56 ⇒ colX 递推全体横坐标漂移 ⇒ 本版刻意不动）");
  L.gapW.forEach((w, c) => {
    assert.ok(w >= DG_COL_GAP_MIN, `gapW[${c}] 恒 ≥ 下界`);
    assert.equal(L.colX[c + 1] - (L.colX[c] + DG_NODE_W), w, `通道 ${c} 的宽 = 相邻两列 chip 边的净距（与递推式同源）`);
  });
  assert.equal(DG_NODE_W, 74, "chip 定宽 = 74（box-sizing:border-box）");
  assert.equal(DG_NODE_H, 28);
  assert.equal(DG_BADGE_H, 14, "行距常量保留（§2.4「刻意不动」第二条：S1 下 cell 的 top 逐字进 DOM）");
  assert.equal(DG_ROW_GAP, 4);
  assert.equal(DG_COL_GAP_MIN, 56, "通道带宽下界 = 56（数值不动）");
  assert.equal(DG_LANE_PITCH, 14);
  assert.equal(DG_LANE_MIN, 22);
  assert.equal(DG_ARC_K_MAX, 34);
  assert.equal(DG_BUS_PITCH, 12);
  assert.equal(DG_PAD_L, 12);
  assert.equal(DG_PAD_T, 12);
  assert.equal(DG_PAD_B, 12);
  assert.equal(DG_PAD_R, 12, "v0.10.6 C6：96 → 12（角标族退役 ⇒ 右内缘与左内缘对称）");
  // 件二（b2′）：对齐用户已批准原型 dep-graph-proto.html C 版 —— 列距 130 / 行距 46
  assert.equal(DG_NODE_W + DG_COL_GAP_MIN, 130, "列距 = chip 宽 + 通道下界 = 130（原型 C）");
  assert.equal(DG_BADGE_H + DG_NODE_H + DG_ROW_GAP, 46, "行距 = cell 盒高 + 纵距 = 46（原型 C）");
});

test("G7-定宽②位数无关：#n 由 1 位升到 3 位 ⇒ chip 盒与全部坐标零变化", () => {
  const base = [
    task("dw-a", "completed", [], { projectId: "board", queuedAt: "2026-10-12T00:00:01Z" }),
    task("dw-b", "working", ["dw-a"], { projectId: "board", queuedAt: "2026-10-12T00:00:02Z" }),
  ];
  const geom = (tasks) => {
    const graph = buildGraphWithPipelines(tasks);
    const ordinals = taskOrdinalMap(tasks);
    const layers = layerOfGraph(graph.nodes, ordinals, graph.edges);
    const pipe = graph.pipelines[0];
    const L = pipeGridLayout(pipe, compressPipeLayers(pipe, layers), ordinals);
    return { ordinals: [...L.cells.map((c) => c.ordinal)], geom: L.cells.map((c) => [c.x, c.y, c.w, c.h, c.chipRight, c.chipMidY]), width: L.width, height: L.height };
  };
  const two = geom(base);
  // 同一拓扑、号序不变，只把标识撑到 3 位（位数只影响可见文字，不进几何）
  const padded = [
    task("pad-aaaaaaaa", "completed", [], { projectId: "board", queuedAt: "2026-10-12T00:00:01Z", prompt: "1".repeat(100) }),
    task("pad-bbbbbbbb", "working", ["pad-aaaaaaaa"], { projectId: "board", queuedAt: "2026-10-12T00:00:02Z", prompt: "2".repeat(100) }),
  ];
  const wide = geom(padded);
  assert.deepEqual(wide.geom, two.geom, "格位坐标与盒模零变化（尺寸只在 JS 常量、与内容无关）");
  assert.equal(wide.width, two.width, "网格宽不随位数变");
  assert.equal(wide.height, two.height, "网格高不随位数变");
  assert.deepEqual(wide.ordinals, two.ordinals, "号序不变（位数不改编号）");
});
// ---------------------------------------------------------------------------
// G3（v0.10.5 · REQ-2026-10-12-02 · 改造文档 §2.4-④ / §2.5-I2 I3 / §2.6）：
// 通道式走线纯函数 routeIntraEdges / arcPath / busPath —— 只出 path 数据与类名，
// 不渲染、不产 HTML / CSS、不减交叉（§2.6：允许交叉、只禁共段）。
// ---------------------------------------------------------------------------

/** `d` 里的全部坐标对（按出现序）。几何全整数 ⇒ 无需处理小数。 */
const dPoints = (d) => (d.match(/-?\d+,-?\d+/g) ?? []).map((p) => p.split(",").map(Number));
/** `d` 里的全部命令字母（按出现序）。 */
const dCmds = (d) => d.match(/[A-Za-z]/g) ?? [];

/** 端点定义式（I2 判据 1 的**重算面**：只吃 `colX/rowY` + 常量，不吃 cell 字段）。 */
const rightMidOf = (grid, cell) => [
  (grid.colX[cell.col] ?? 0) + DG_NODE_W,
  (grid.rowY[cell.row] ?? 0) + DG_BADGE_H + DG_NODE_H / 2,
];
const leftMidOf = (grid, cell) => [
  grid.colX[cell.col] ?? 0,
  (grid.rowY[cell.row] ?? 0) + DG_BADGE_H + DG_NODE_H / 2,
];

/** 样本 076bbb84 的单管道网格 + 走线（缺省预算 ⇒ 通道带尚未回灌）。 */
const g3Sample = (budget = {}) => {
  const { graph, ordinals, layers } = g2Fixture(sample076bbb84());
  const pipe = graph.pipelines.find((p) => p.projectId === "board");
  const columns = compressPipeLayers(pipe, layers);
  const grid = pipeGridLayout(pipe, columns, ordinals, budget);
  return { graph, grid, routes: routeIntraEdges(graph.edges, grid) };
};

test("G3-端点①（I2 逐边恒等 + 空转守卫）：每条 d 的首点 = 源右缘中点、末点 = 目标左缘中点（按 colX/rowY 重算）", () => {
  const { graph, grid, routes } = g3Sample();
  assert.ok(routes.length > 0, "空转守卫：出参非空（逐边断言不得空跑）");
  assert.equal(routes.length, graph.edges.length, "样本 10 条边全在单管道内 ⇒ 全走线（零跨管道丢弃）");
  let checked = 0;
  for (const e of routes) {
    const a = grid.cellOf.get(e.from);
    const b = grid.cellOf.get(e.to);
    assert.ok(a !== undefined && b !== undefined, `${e.from}→${e.to} 两端都在网格内`);
    const pts = dPoints(e.d);
    assert.ok(pts.length >= 2, `${e.from}→${e.to} 的 d 至少含首末两点`);
    assert.deepEqual(pts[0], rightMidOf(grid, a), `${e.from}→${e.to} 首点 = 源 chip 右缘中点（重算式）`);
    assert.deepEqual(pts[pts.length - 1], leftMidOf(grid, b), `${e.from}→${e.to} 末点 = 目标 chip 左缘中点（重算式）`);
    assert.deepEqual(pts[0], [a.chipRight, a.chipMidY], `${e.from} 的两种右缘中点算法必须等值（几何单源）`);
    assert.deepEqual(pts[pts.length - 1], [b.chipX, b.chipMidY], `${e.to} 的两种左缘中点算法必须等值`);
    checked += 1;
  }
  assert.equal(checked, 10, "空转守卫：逐边遍历真的跑了 10 条");
});

// 件一（增补 §6.1 · 外壳恒渲）新增锚②：**模型 ↔ 渲染**端点对账。
// 与 G3-端点① 的分野 = ① 拿几何函数的 `colX/rowY` 重算（模型自洽）；本条拿**渲染 HTML 里 cell 的
// `left/top` 两枚几何字面 + 角标带外壳是否在场**重算（递推式 `chipMidY = top + 带壳?DG_BADGE_H:0 + DG_NODE_H/2`
// 依赖「每 cell 恒有一枚 `.dg-deps` 排在 chip 之上」这一**结构事实** —— 件一之前无角标的 cell 不出外壳，
// 于是渲染态 chip 比走线端点高整整一枚 `DG_BADGE_H`=14，而模型侧毫无察觉）。单管道 10 边 ⇒ 改前全红。
// 坐标**按框分席 + 加偏**（v0.10.6 C4 形态 S1）：DOM cell 的 left/top 仍是**框内局部值**、path 的 d 是**画布值**
// ⇒ 二者不可直接比，必须 `局部值 + 框外缘 dx/dy + 框内 origin` 后再比（换算单源 = 上 `canvasEdgePoint`，
//   改造文档 §4.4「件一②」+ §6 增补件一 A4/A5）。
// **不加偏比对是非法形态**（跨框错位无人可抓）⇒ 本条另设**两形**反向钉：未加偏的局部端点不得命中任何 path，
// **只加外缘 dx/dy、不加框内 origin** 的半偏端点同样不得命中（后者 = 本次回归的机械凭据）。
// **v0.10.5 N2 取数源翻向**：本条是五个消费点里的**测试面那一处** —— 模型侧喂给渲染的边集已被
// `transitiveReduce` 约简 ⇒ 对账必须吃**同一份 `kept`**（照吃声明原边集会在约简发生的那一刻必红）。

/**
 * 一枚管道体 HTML → `taskId → {left, top, hasBand}`（**渲染态结构事实**，不读几何函数）。
 * chip `title` 首段 = 全量 taskId（夹具用干净 id ⇒ 无转义歧义）。
 */
function renderedCells(bodyHtml) {
  const out = new Map();
  for (const chunk of bodyHtml.split('<span class="dg-cell" style="').slice(1)) {
    const m =
      /^left:(\d+)px;top:(\d+)px"><span class="dg-chip dg-\w+" title="([^"]*)">#\d+<\/span>(<span class="dg-deps">)?/.exec(chunk);
    assert.ok(m !== undefined, `cell 出参形态 = style 的 left/top 两枚几何字面 + 一枚 chip（实得 ${chunk.slice(0, 80)}…）`);
    const taskId = m[3].split(" · ")[0];
    assert.equal(out.has(taskId), false, `同一管道内 taskId 不得重复出现：${taskId}`);
    out.set(taskId, { left: Number(m[1]), top: Number(m[2]), hasBand: m[4] !== undefined });
  }
  return out;
}

/**
 * 渲染态 chip 的纵中点。
 * **v0.10.6 C5 / S1 翻案（n14 收口）**：`hasBand ? … : 0` 的分叉已消 —— 角标带外壳整条退役后，
 * 行距由 `.dg-cell` 的 `padding-top: var(--dg-bh)` **恒**承接 ⇒ 每枚 cell 都带那一枚 `DG_BADGE_H`，
 * 无「不带」的那一档（写成条件式会把「外壳复活」这一缺陷读成正常态）。
 */
const renderedChipMidY = (c) => c.top + DG_BADGE_H + DG_NODE_H / 2;

/**
 * **换算单源（增补 `a0682281` 件一 A4）**：渲染态 cell 的**局部**几何 → **画布**坐标的边端点。
 * 平移量 = **框外缘** `f.dx/f.dy`（`renderFrame` 的 inline `left/top`，DOM 事实源）+ **框内 origin**
 * （{@link DG_GRID_ORIGIN_X}/{@link DG_GRID_ORIGIN_Y} = `border + pad` / `border + title`）——
 * 只加前者 ⇒ 全图端点系统偏 `(-DG_GRID_ORIGIN_X, -DG_GRID_ORIGIN_Y)`，正是本次回归的形态。
 * 逐边换算式（件一② 正钉）与 `taskIdByEdgePoint`（N2对锚① 反查）**必须共吃这一枚**：
 * 两处各存一份算式 = 「锚与实现同错」得以并存的结构因（改造文档 §6 增补节 A4）。
 * `side`：`"from"` = 源 chip **右缘**中点、`"to"` = 目标 chip **左缘**中点。
 * 纵中点的**局部**递推式仍只由 {@link renderedChipMidY} 承载（它不加 origin，两侧语义不得混用）。
 */
const canvasEdgePoint = (f, c, side) => [
  (side === "from" ? c.left + DG_NODE_W : c.left) + f.dx + DG_GRID_ORIGIN_X,
  renderedChipMidY(c) + f.dy + DG_GRID_ORIGIN_Y,
];

test("件一②模型↔渲染（S1 加偏）：每条 d 的首末点 === 渲染 cell 的 chip 右缘/左缘中点 + 所属框 origin(dx/dy)", () => {
  /** @param tasks 夹具 @param label 夹具名 @param minChecked 空转守卫下界 */
  const reconcile = (tasks, label, minChecked) => {
    // 取数源 = 约简后 `kept`（与渲染层五消费点同源）；照吃声明原边集 ⇒ 约简一发生本条必红
    const graph = buildGraphWithPipelines(tasks);
    const edges = transitiveReduce(graph.edges).kept;
    const { html } = renderDependencyGraphSection(tasks);
    // **C4 后 path 池只在画布层**（svg 从「框 › pipe-body › dg-grid」搬到 `.dg-canvas` ⇒ 每框零 svg）
    const canvas = /<div class="dg-canvas"[^>]*>\s*<svg class="dg-links">([\s\S]*?)<\/svg>/.exec(html);
    assert.ok(canvas !== null, `${label}：画布级边线层在场（框内不再取池 —— 逐框池恒为空）`);
    const ds = edgePaths(canvas[1]).map((e) => dPoints(e.d));
    assert.equal(
      ds.length,
      edges.length,
      `${label}：画布 path 枚数 === **本质**边枚数（框内 ∪ 跨框同池 ⇒ 不得多画或少画；跨管道边今天也入图形面）`,
    );
    // 逐框切片 = **框 origin(dx/dy)** + 该框子树内的**局部** cell ⇒ S1 的两处事实源（DOM 局部 / path 画布）
    const frames = new Map();
    for (const chunk of html.split('<details class="pipe" open style="').slice(1)) {
      const body = chunk.slice(0, chunk.indexOf("</details>"));
      const m = /^left:(\d+)px;top:(\d+)px;width:(\d+)px;height:(\d+)px">\s*<summary>管道 ([^（]+)（/.exec(body);
      assert.ok(m !== undefined, `${label}：框 = 固定盒四枚几何字面（left/top/width/height）+ summary（实得 ${body.slice(0, 80)}…）`);
      frames.set(m[5], { dx: Number(m[1]), dy: Number(m[2]), cells: renderedCells(body) });
      assert.ok(frames.get(m[5]).cells.size > 0, `${label}：本框子树内确有 cell（逐边核对不得空跑）`);
    }
    const projectByTask = new Map();
    for (const n of graph.nodes) projectByTask.set(n.taskId, n.projectId);
    let checked = 0;
    for (const e of edges) {
      const fa = frames.get(projectByTask.get(e.from));
      const fb = frames.get(projectByTask.get(e.to));
      assert.ok(fa !== undefined && fb !== undefined, `${label} ${e.from}→${e.to}：两端各自落在自己框的 cell 表里`);
      const a = fa.cells.get(e.from);
      const c = fb.cells.get(e.to);
      assert.ok(a !== undefined && c !== undefined, `${label} ${e.from}→${e.to}：两端 cell 的 left/top 都在渲染 HTML 里`);
      // 换算式（改造文档 §4.4「件一②」+ §6 增补件一 A4）：首点 = 源 cell 右缘中点**加本框 origin**、
      // 末点 = 目标 cell 左缘中点同款 ⇒ 两侧都走 {@link canvasEdgePoint} 这一枚单源（不得在此重写算式）
      const first = canvasEdgePoint(fa, a, "from");
      const last = canvasEdgePoint(fb, c, "to");
      const hit = ds.find((pts) => String(pts[0]) === String(first) && String(pts[pts.length - 1]) === String(last));
      assert.ok(
        hit !== undefined,
        `${label} ${e.from}→${e.to}：局部端点加本框 origin 后得 [${first}]→[${last}]，必有一条 d 与之逐点相等` +
          `（实得首末点族 = ${ds.map((p) => `[${p[0]}]→[${p[p.length - 1]}]`).join(" ")}）`,
      );
      // **反向钉 ①（防本条被静默改回「比局部值」）**：完全不加偏的局部端点必不得命中任何 path。
      // 跨框错位正是这么漏掉的 —— 若哪天有人删掉换算式里的 `+ f.dx + f.dy`，本钉不保他（局部值恰好命中 ⇒ 已翻红）。
      const bare = [a.left + DG_NODE_W, renderedChipMidY(a)];
      assert.equal(
        ds.some((pts) => String(pts[0]) === String(bare)),
        false,
        `${label} ${e.from}→${e.to}：**未加偏**的局部首点 [${bare}] 不得命中画布 path（命中即坐标系混用，跨框错位无人可抓）`,
      );
      // **反向钉 ②（本次回归的机械凭据 · 增补 §6 件一 A5 第 ② 形）**：只加**框外缘** `dx/dy`、
      // **不加框内 origin** 的「半偏」首点同样不得命中任何 path —— 现网缺陷就是这个形态
      // （`shiftPipeGrid` 只喂 `frame.dx/dy` ⇒ 全图端点系统偏 `(-${DG_GRID_ORIGIN_X},-${DG_GRID_ORIGIN_Y})`，
      //  锚与实现同错 ⇒ 84/84 全绿而线上错位）。① 抓不到它（① 连 dx/dy 都没加），故必须另立这一形。
      const half = [a.left + DG_NODE_W + fa.dx, renderedChipMidY(a) + fa.dy];
      assert.equal(
        ds.some((pts) => String(pts[0]) === String(half)),
        false,
        `${label} ${e.from}→${e.to}：**只加框外缘 dx/dy、不加框内 origin** 的半偏首点 [${half}] 不得命中画布 path` +
          `（命中 = 回归到增补 a0682281 的「漏框内缘」形态；框内 origin 是换算式的必要加数）`,
      );
      checked += 1;
    }
    assert.ok(checked >= minChecked, `空转守卫：${label} 逐边核对真的跑了 ${checked} 条（下界 ${minChecked}）`);
    return checked;
  };
  assert.equal(reconcile(sample076bbb84(), "样本076bbb84", 8), 8, "单管道声明 10 边 → 本质 8 边、7 cell ⇒ 全数对账（加偏后逐点相等）");
  assert.equal(
    reconcile(pipe6Tasks(), "pipe6", 5),
    5,
    "副夹具多框 ⇒ 板内边 + 跨框边**同池**全数对账（跨框那几条是「加偏」的唯一硬证据：两端的 dx/dy 不同）",
  );
});

// 件一③（增补 §6 件一 A6）：**origin 三方同源钉**。上一条锚抓的是「端点算得对不对」，本条抓的是
// 「算式里的 origin 从哪来」—— JS 常量 / 画布下发变量 / CSS 消费变量名三处必须是同一枚事实源。
// 缺这一钉时的失败形态：有人把 `DG_GRID_ORIGIN_*` 改成硬编码 9/21（改了 pad 不跟随），或把 CSS 的
// `left: var(--dg-fp)` 写成 `left: 8px`（DOM 内缘与走线内缘分家 ⇒ 件一② 依旧全绿而线上错位）。
test("件一③origin 三方同源（JS 恒等式 · 画布下发键值 · CSS 消费变量名）：框内 origin 只有一个事实源", () => {
  // —— (i) JS 侧：origin 必须是**表达式**，不得写成硬编码数字
  assert.equal(
    DG_GRID_ORIGIN_X,
    DG_FRAME_BORDER + DG_FRAME_PAD,
    `横内缘 = border(${DG_FRAME_BORDER}) + pad(${DG_FRAME_PAD})（写死 9 ⇒ 改 pad 时走线一侧不跟随）`,
  );
  assert.equal(
    DG_GRID_ORIGIN_Y,
    DG_FRAME_BORDER + DG_FRAME_TITLE_H,
    `纵内缘 = border(${DG_FRAME_BORDER}) + 标题带(${DG_FRAME_TITLE_H})（标题带只在上 ⇒ 加数不含 pad）`,
  );
  // —— 下发侧：键名 ⇄ 常量的**配对**也钉住（配错了，下面的「吃 var(--dg-fp)」会指向错加数）
  const inline = /<div class="dg-canvas" style="([^"]*)">/.exec(
    renderDependencyGraphSection([task("t-origin", "completed", [])]).html,
  );
  assert.ok(inline !== null, "画布那一枚 inline 在场（几何变量的唯一下发面）");
  for (const [key, val] of [
    ["--dg-fb", DG_FRAME_BORDER],
    ["--dg-fth", DG_FRAME_TITLE_H],
    ["--dg-fp", DG_FRAME_PAD],
  ])
    assert.ok(
      inline[1].includes(`${key}:${val}px`),
      `下发键 ${key} 的值逐字 === 常量 ${val}（改常量 ⇒ 板面自动跟随；两处不同 ⇒ 本条红）`,
    );
  // —— (ii) CSS 侧：**抓变量名不抓值**（先例 = G6-同源① 的 `width: var(--dg-nw)` 逐字锚）
  const block = pipeCssBlock();
  const borderDecls = cssDecls(cssRule(block, ".pipe")).filter((d) => /^border:/.test(d));
  assert.equal(borderDecls.length, 1, "框边框声明恰一条（多条 = 第二份线宽事实源）");
  assert.match(
    borderDecls[0],
    /^border: var\(--dg-fb\) solid /,
    "框边框线宽只引 --dg-fb（写 1px 字面 ⇒ 与 DG_FRAME_BORDER 分家：origin 加了 border、绘制侧没加）",
  );
  assert.deepEqual(
    cssDecls(cssRule(block, ".dg-canvas .pipe-body")).filter((d) => /^(left|top):/.test(d)),
    ["left: var(--dg-fp)", "top: var(--dg-fth)"],
    "框内定位壳的 left/top 只引 --dg-fp / --dg-fth（= origin 的两枚加数，DOM 内缘与走线内缘同名同源）",
  );
});

test("G3-端点②（长边三段 + busLane 独占 + 预算回灌落线）：样本 3 枚长边各占一枚独立 busLane", () => {
  const { graph, grid, routes } = g3Sample();
  const longs = routes.filter((e) => e.kind === "long");
  assert.deepEqual(
    longs.map((e) => `${e.from}→${e.to}`),
    ["n1→n6", "n2→n6", "n5→n6"],
    "长边 = 列差 ≥2 的三条（与 G2 样本锚同源）",
  );
  assert.deepEqual([...new Set(longs.map((e) => e.busLane))].sort(), [0, 1, 2], "三条长边的 busLane 两两不同（x 区间相交 ⇒ 不复用）");
  for (const e of longs) {
    assert.deepEqual(dCmds(e.d), ["M", "C", "L", "C"], `${e.from}→${e.to} 长边 = 下降弧 → 水平段 → 上升弧`);
    const pts = dPoints(e.d);
    assert.equal(pts.length, 8, "三段共 8 枚坐标对（P0 C1 C2 Q1 Q2 C3 C4 P1）");
    const q1 = pts[3];
    const q2 = pts[4];
    assert.equal(q1[1], e.yb, "Q1 落在该边的通道带 y 线上");
    assert.equal(q2[1], e.yb, "Q2 与 Q1 同 y ⇒ 中间段水平");
    assert.equal(pts[2][1], e.yb, "下降弧末控制点同 y ⇒ Q1 处切线水平（C¹ 连续）");
    assert.equal(pts[5][1], e.yb, "上升弧首控制点同 y ⇒ Q2 处切线水平（C¹ 连续）");
    const a = grid.cellOf.get(e.from);
    const b = grid.cellOf.get(e.to);
    assert.equal(q1[0], a.chipRight + DG_LANE_MIN + e.lambda * DG_LANE_PITCH, "tx = x0 + LANE_MIN + λ·LANE_PITCH");
    assert.equal(q2[0], b.chipX - DG_LANE_MIN - e.mu * DG_LANE_PITCH, "tx2 = x1 − LANE_MIN − μ·LANE_PITCH");
    assert.ok(q1[0] < q2[0], `${e.from}→${e.to} 水平段不自交（tx < tx2）`);
    assert.ok(q1[0] > a.chipRight && q1[0] < b.chipX, "tx 落在源右缘与目标左缘之间（通道内）");
    assert.ok(q2[0] > a.chipRight && q2[0] < b.chipX, "tx2 落在通道内");
    assert.equal(
      e.yb,
      grid.busBandTop + Math.floor(DG_BUS_PITCH / 2) + e.busLane * DG_BUS_PITCH,
      "yb = 通道带 lane 线（与 pipeGridLayout 的 busLanes 同式）",
    );
  }
  // 一次收敛：把走线要的 lane 数回灌成预算重算网格 ⇒ lane 分配不变、走线坐标落进网格 lane 线
  const gapLanes = new Array(Math.max(0, grid.cols - 1)).fill(0);
  for (const e of longs) {
    gapLanes[grid.cellOf.get(e.from).col] += 1;
    gapLanes[grid.cellOf.get(e.to).col - 1] += 1;
  }
  const fed = g3Sample({ gapLanes, busLaneCount: longs.length });
  assert.deepEqual(fed.routes.map((e) => [e.busLane, e.lambda, e.mu, e.yb]), routes.map((e) => [e.busLane, e.lambda, e.mu, e.yb]), "预算回灌不改 lane 分配（一次收敛、不迭代）");
  assert.ok(fed.grid.height > grid.height, "回灌后通道带高进高度 ⇒ height 抬升（I4 不被裁）");
  const laneXs = new Set(fed.grid.lanes.flat());
  for (const e of fed.routes.filter((x) => x.kind === "long")) {
    const a = fed.grid.cellOf.get(e.from);
    assert.ok(laneXs.has(a.chipRight + DG_LANE_MIN + e.lambda * DG_LANE_PITCH), `${e.from}→${e.to} 的 tx 命中网格 lane 线（λ 侧）`);
    assert.ok(fed.grid.busLanes.includes(e.yb), `${e.from}→${e.to} 的 yb 命中通道带 lane 线`);
    assert.ok(e.yb <= fed.grid.height - DG_PAD_B, "水平段落在内容包含线之内（I4）");
  }
  assert.equal(graph.edges.length, 10, "样本边数基线（防夹具漂移）");
});

test("G3-端点③（相邻弧切线水平 + K 公式 + 跨管道不画 + 确定性 + d 字符集与类名纪律）", () => {
  const { graph, grid, routes } = g3Sample();
  const adj = routes.filter((e) => e.kind === "adjacent");
  assert.equal(adj.length, 7, "其余 7 条为相邻弧（列差 1）");
  for (const e of adj) {
    assert.equal(e.busLane, -1, "相邻边不占通道带 lane");
    assert.equal(e.lambda, -1, "相邻边不占 λ lane");
    assert.equal(e.mu, -1, "相邻边不占 μ lane");
    assert.deepEqual(dCmds(e.d), ["M", "C"], `${e.from}→${e.to} 相邻边 = 一枚三次贝塞尔`);
    const [p0, c1, c2, p1] = dPoints(e.d);
    assert.equal(c1[1], p0[1], "首控制点与源端点同 y ⇒ 源侧切线水平（贴右缘中点）");
    assert.equal(c2[1], p1[1], "末控制点与目标端点同 y ⇒ 目标侧切线水平（贴左缘中点）");
    const k = c1[0] - p0[0];
    const dx = p1[0] - p0[0];
    assert.equal(c2[0], p1[0] - k, "两端控制点等长（对称弧）");
    assert.equal(k, Math.max(6, Math.min(DG_ARC_K_MAX, Math.round(dx / 3))), "K = clamp(dx/3, 6, DG_ARC_K_MAX)");
    assert.ok(k >= 6 && k <= DG_ARC_K_MAX, `K=${k} 在 [6, ${DG_ARC_K_MAX}] 内`);
    assert.equal(arcPath(p0[0], p0[1], p1[0], p1[1]), e.d, "d 与 arcPath(端点) 逐字等值（走线只经该式）");
  }
  const fromN1 = adj.filter((e) => e.from === "n1");
  assert.equal(fromN1.length, 2, "n1 ⇒ n2 / n5 两条相邻弧（分支可见）");
  assert.notEqual(fromN1[0].d, fromN1[1].d, "同源两条相邻边的 d 不得相同（并列节点不叠成一条）");
  // 跨管道边不画：pipe6 夹具只喂 board 的网格 ⇒ 他管道端点直接跳过
  const tasks6 = pipe6Tasks();
  const g6 = buildGraphWithPipelines(tasks6);
  const o6 = taskOrdinalMap(tasks6);
  const l6 = layerOfGraph(g6.nodes, o6, g6.edges);
  const boardPipe = g6.pipelines.find((p) => p.projectId === "board");
  const boardGrid = pipeGridLayout(boardPipe, compressPipeLayers(boardPipe, l6), o6);
  const boardRoutes = routeIntraEdges(g6.edges, boardGrid);
  assert.equal(g6.edges.length, 5, "pipe6 = 5 条边（1 条板内 + 4 条跨管道）");
  assert.deepEqual(
    boardRoutes.map((e) => `${e.from}→${e.to}`),
    ["t-b1→t-b2"],
    "只画板内那一条 ⇒ 跨管道边（t-b1→t-f1 / t-b2→t-o1 / t-f1→t-b3 / t-o1→t-f2）结构上不入走线",
  );
  // 确定性：入参边序无关 ⇒ 出参逐字段相等（走线前按（源号序, 目标号序）定序）
  assert.deepEqual(routeIntraEdges([...graph.edges].reverse(), grid), routes, "边数组反转 ⇒ 出参逐字段相等");
  assert.deepEqual(routeIntraEdges(graph.edges, grid), routes, "重复调用逐字段相等");
  // 命名纪律（§2.2）：类名单数、不含子串 dg-edges；d 字符集只吃几何字符
  assert.equal(DG_EDGE_CLS, "dg-edge", "边线类名 = dg-edge（单数）");
  assert.equal(DG_EDGE_CLS.includes("dg-edges"), false, "类名不得含子串 dg-edges（防四条边清单负钉误判）");
  for (const e of routes) {
    assert.equal(e.cls, DG_EDGE_CLS, "每条出参带同一类名，供渲染侧直嵌");
    assert.equal(/[^MLCQHAZ0-9.,\-\s]/.test(e.d), false, `d 字符集越界：${e.d}`);
    assert.equal(e.d.includes('"'), false, "d 不出引号（带引号属性闭集纪律）");
  }
});

// ---------------------------------------------------------------------------
// G4 / G5（v0.10.5 · REQ-2026-10-12-02 · 改造文档 §2.5 I1/I3 / §2.6 判据 2）：
// **机器判据面** —— 只加断言、不改算法（本组对 src/** 零行改动）。
//   G4 = I1 通道包含（段 bbox 不得进入非本边两端 chip 的**内部**）；
//   G5 = I3 不共段（结构面 λ/μ 单射 + busLane x 区间不交；兜底面 = 采样叠点计数）。
//
// **口径钉死（§2.6，防后人当缺陷顺手加固）**：
//   **允许交叉；只禁叠线 —— 共端点不算重叠、共段才算重叠、孤立交点允许。**
//   因此兜底面的「一枚叠点」定义为：两点距离 < 1.5px **且** 不在两条边共用端点的近旁
//   （共端点不算重叠）**且** 两点处切线近平行（孤立交点是穿越、不是叠线）。
//   计数阈值（每段 24 点 / 1.5px / ≥2 枚）**逐字照派发消息，未放宽**。
//   实测必要性（常驻正钉见 G5-重叠③）：样本 076bbb84 上有 7 对**合法交叉**段对，
//   若不加这两条区分，字面规则会把它们全部误判红 ⇒ 与本口径直接冲突。
//
// **反例的成立前提（N5 探针实证、N4 重派修好的三条，改判据前先读这三句）**：
//   ① 贴边 / 越缘反例的载体 chip 必须与反例 box **同一 y 带**（取末行中间列），否则两条一起空转；
//   ② 空转守卫**分两面** —— λ/μ 单射数「同通道 ∧ y 区间相交」的边对（样本 4 / 压力 2 枚），
//      busReuse 夹具按设计同源通道各 1 条 ⇒ 该项恒 0，其结构面载重在 busLane 复用对（1 枚）；
//   ③ 「μ 同值」本身**不构成叠线**（两弧只共 x、y 起止不同 ⇒ 兜底面放行是几何正确的，由结构面抓）；
//      兜底面的反例须 **μ ∧ yb 同值**（实测：水平段同线 ⇒ 叠点 3 枚 ⇒ 判红）。
// ---------------------------------------------------------------------------

/** 兜底面常量（定义式来自派发消息 / 改造文档 §2.6，不得为凑绿而放宽）。 */
const G5_SAMPLES = 24;
const G5_NEAR_PX = 1.5;
const G5_RED_MIN = 2;
/** 「共端点不算重叠」的执行半径：两枚采样点若都落在两条边共用端点的该半径内 ⇒ 不计叠点。 */
const G5_END_EXEMPT_PX = 24;
/** 「孤立交点允许」的执行界：|sinΔθ| 超过此值 ⇒ 判为穿越、不计叠线。 */
const G5_PARALLEL_SIN_MAX = 0.2;

/** 从 `d` 解出段序列（弧 = 4 控制点 / 直线 = 2 端点）—— 判据只吃算法真实产出的 path。 */
const dSegments = (d) => {
  const nums = (d.match(/-?\d+,-?\d+/g) ?? []).map((s) => s.split(",").map(Number));
  const cmds = dCmds(d);
  const segs = [];
  let ci = 0;
  let cur = null;
  for (const c of cmds) {
    if (c === "M") cur = nums[ci++];
    else if (c === "C") {
      const pts = [cur, nums[ci++], nums[ci++], nums[ci++]];
      segs.push({ kind: "cubic", pts });
      cur = pts[3];
    } else if (c === "L") {
      const e = nums[ci++];
      segs.push({ kind: "line", pts: [cur, e] });
      cur = e;
    } else assert.fail(`未预期的 path 命令 ${c}（判据面需同步）`);
  }
  return segs;
};

/** 点集 bbox = `[x0, x1, y0, y1]`（x1 ≥ x0、y1 ≥ y0；退化段允许 x0===x1 / y0===y1）。 */
const boxOfPts = (pts) => [
  Math.min(...pts.map((p) => p[0])),
  Math.max(...pts.map((p) => p[0])),
  Math.min(...pts.map((p) => p[1])),
  Math.max(...pts.map((p) => p[1])),
];

/** 一条边的段 bbox 清单（I1 的度量对象；弧取 4 控制点 ⇒ 凸包性质保证曲线 ⊆ bbox）。 */
const edgeBoxes = (e) => dSegments(e.d).map((s) => ({ kind: s.kind, box: boxOfPts(s.pts) }));

/** chip 盒（**内部**判据用的就是这一枚矩形：`box-sizing:border-box` 的定宽定高）。 */
const chipBox = (cell) => [cell.chipX, cell.chipX + DG_NODE_W, cell.chipY, cell.chipY + DG_NODE_H];

/** 内部相交（严格不等式 ⇒ 边界接触不算相交，正是「只许边界接触」的数学形）。 */
const interiorOverlap = (a, b) => a[0] < b[1] && b[0] < a[1] && a[2] < b[3] && b[2] < a[3];

/** I1 判据：返回全部「段 bbox × 非本边两端 chip」的越界项。 */
const findPenetrations = (routes, grid) => {
  const hits = [];
  let checked = 0;
  for (const e of routes) {
    for (const { kind, box } of edgeBoxes(e)) {
      for (const cell of grid.cells) {
        if (cell.taskId === e.from || cell.taskId === e.to) continue;
        checked += 1;
        if (interiorOverlap(box, chipBox(cell))) hits.push({ edge: `${e.from}→${e.to}`, kind, box, chip: cell.taskId });
      }
    }
  }
  return { hits, checked };
};

/** 段采样（每段 24 点；贝塞尔按伯恩斯坦、直线按参数线性）。 */
const sampleSegment = (seg) => {
  const out = [];
  for (let i = 0; i < G5_SAMPLES; i += 1) {
    const t = i / (G5_SAMPLES - 1);
    const m = 1 - t;
    if (seg.kind === "cubic") {
      const [p0, c1, c2, p1] = seg.pts;
      out.push([
        m * m * m * p0[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t * t * t * p1[0],
        m * m * m * p0[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t * t * t * p1[1],
      ]);
    } else {
      const [a, b] = seg.pts;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
};

/** 离散切线（中心差分、端点单侧）—— 单位向量。 */
const tangentAt = (pts, i) => {
  const hi = Math.min(pts.length - 1, i + 1);
  const lo = Math.max(0, i - 1);
  const dx = pts[hi][0] - pts[lo][0];
  const dy = pts[hi][1] - pts[lo][1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
};

const sinBetween = (a, b) => Math.abs(a[0] * b[1] - a[1] * b[0]);

/**
 * 一枚段对的两层计数：
 * - `raw`  = 字面「距离 < 1.5px 的采样点对」数（**只作留痕**：合法交叉也命中）；
 * - `overlap` = 叠点数（按钉死口径剔掉「共用端点近旁」与「非近平行」两类 ⇒ 这才是判红依据）。
 */
const countNearPairs = (A, B) => {
  const ea = [A[0], A[A.length - 1]];
  const eb = [B[0], B[B.length - 1]];
  let raw = 0;
  let overlap = 0;
  for (let i = 0; i < A.length; i += 1) {
    for (let j = 0; j < B.length; j += 1) {
      const d = Math.hypot(A[i][0] - B[j][0], A[i][1] - B[j][1]);
      if (!(d < G5_NEAR_PX)) continue;
      raw += 1;
      let sharedEnd = false;
      for (const e of ea) {
        for (const f of eb) {
          if (Math.hypot(e[0] - f[0], e[1] - f[1]) <= 0.01
            && Math.hypot(A[i][0] - e[0], A[i][1] - e[1]) <= G5_END_EXEMPT_PX
            && Math.hypot(B[j][0] - e[0], B[j][1] - e[1]) <= G5_END_EXEMPT_PX) {
            sharedEnd = true;
            break;
          }
        }
        if (sharedEnd) break;
      }
      if (sharedEnd) continue;
      if (sinBetween(tangentAt(A, i), tangentAt(B, j)) > G5_PARALLEL_SIN_MAX) continue;
      overlap += 1;
    }
  }
  return { raw, overlap };
};

/** I3 兜底面：全部跨边段对（同一条边的相邻段本就共端点，不参与）。 */
const findOverlaps = (routes) => {
  const segs = routes.map((e) => dSegments(e.d).map(sampleSegment));
  const hits = [];
  let rawHits = 0;
  let pairs = 0;
  for (let i = 0; i < routes.length; i += 1) {
    for (let j = i + 1; j < routes.length; j += 1) {
      for (let x = 0; x < segs[i].length; x += 1) {
        for (let y = 0; y < segs[j].length; y += 1) {
          pairs += 1;
          const { raw, overlap } = countNearPairs(segs[i][x], segs[j][y]);
          if (raw >= G5_RED_MIN) rawHits += 1;
          if (overlap >= G5_RED_MIN) {
            hits.push({ a: `${routes[i].from}→${routes[i].to}`, b: `${routes[j].from}→${routes[j].to}`, seg: [x, y], raw, overlap });
          }
        }
      }
    }
  }
  return { hits, rawHits, pairs };
};

const xSpanOf = (grid, e) => {
  const a = grid.cellOf.get(e.from);
  const b = grid.cellOf.get(e.to);
  return [a.chipRight, b.chipX];
};
const ySpanOf = (ya, yb) => [Math.min(ya, yb), Math.max(ya, yb)];
const yIntersect = (s, t) => s[0] < t[1] && t[0] < s[1];

/** I3 结构面：λ / μ 在同通道内对「y 区间相交」的边单射；busLane 内 x 区间两两不交。 */
const findLaneCollisions = (grid, routes) => {
  const longs = routes.filter((e) => e.kind === "long");
  const key = (e) => `${e.from}→${e.to}`;
  const laneCollisions = [];
  let yPairsChecked = 0;
  for (const [label, groupKey, laneOf] of [
    ["λ", (e) => grid.cellOf.get(e.from).col, (e) => e.lambda],
    ["μ", (e) => grid.cellOf.get(e.to).col - 1, (e) => e.mu],
  ]) {
    const groups = new Map();
    for (const e of longs) {
      const k = groupKey(e);
      const list = groups.get(k);
      if (list) list.push(e);
      else groups.set(k, [e]);
    }
    for (const list of groups.values()) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const A = list[i];
          const B = list[j];
          const sa = ySpanOf(grid.cellOf.get(label === "λ" ? A.from : A.to).chipMidY, A.yb);
          const sb = ySpanOf(grid.cellOf.get(label === "λ" ? B.from : B.to).chipMidY, B.yb);
          if (!yIntersect(sa, sb)) continue;
          yPairsChecked += 1;
          if (laneOf(A) === laneOf(B)) laneCollisions.push(`${label} 通道 ${groupKey(A)}：${key(A)} 与 ${key(B)} 同 lane 且 y 区间相交`);
        }
      }
    }
  }
  const busGroups = new Map();
  for (const e of longs) {
    const list = busGroups.get(e.busLane);
    if (list) list.push(e);
    else busGroups.set(e.busLane, [e]);
  }
  const busCollisions = [];
  let busPairs = 0;
  let reusedLanes = 0;
  for (const [lane, list] of busGroups) {
    if (list.length > 1) reusedLanes += 1;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        busPairs += 1;
        const [a0, a1] = xSpanOf(grid, list[i]);
        const [b0, b1] = xSpanOf(grid, list[j]);
        // 相切按「相交的反面」处理（与 packLanes 的保守装箱同口径）⇒ 必须严格分离
        if (!(a1 < b0 || b1 < a0)) busCollisions.push(`busLane ${lane}：${key(list[i])} 与 ${key(list[j])} 的 x 区间 [${a0},${a1}] / [${b0},${b1}] 不分离`);
      }
    }
  }
  return { laneCollisions, busCollisions, yPairsChecked, busPairs, reusedLanes, longCount: longs.length };
};

/** 构图 → 分层 → 网格 → 走线 → **一次预算回灌**（渲染侧真正落地的形态）。 */
const g45Layout = (tasks, feed = true) => {
  const graph = buildGraphWithPipelines(tasks);
  const ordinals = taskOrdinalMap(tasks);
  const layers = layerOfGraph(graph.nodes, ordinals, graph.edges);
  const pipe = graph.pipelines.find((p) => p.projectId === "board");
  assert.ok(pipe !== undefined, "夹具须含 board 管道");
  const columns = compressPipeLayers(pipe, layers);
  let grid = pipeGridLayout(pipe, columns, ordinals);
  let routes = routeIntraEdges(graph.edges, grid);
  if (feed) {
    const gapLanes = new Array(Math.max(0, grid.cols - 1)).fill(0);
    const longs = routes.filter((e) => e.kind === "long");
    for (const e of longs) {
      gapLanes[grid.cellOf.get(e.from).col] += 1;
      gapLanes[grid.cellOf.get(e.to).col - 1] += 1;
    }
    grid = pipeGridLayout(pipe, columns, ordinals, { gapLanes, busLaneCount: longs.length });
    routes = routeIntraEdges(graph.edges, grid);
  }
  return { grid, routes };
};

/** busLane **复用**夹具：两条长边同 lane、x 区间不相交（列区间首尾分离）。 */
const busReuseTasks = () => [
  task("r1", "completed", [], { projectId: "board", queuedAt: "2026-10-12T00:02:01Z" }),
  task("r2", "completed", ["r1"], { projectId: "board", queuedAt: "2026-10-12T00:02:02Z" }),
  task("r3", "completed", ["r2", "r1"], { projectId: "board", queuedAt: "2026-10-12T00:02:03Z" }),
  task("r4", "completed", ["r3"], { projectId: "board", queuedAt: "2026-10-12T00:02:04Z" }),
  task("r5", "completed", ["r4"], { projectId: "board", queuedAt: "2026-10-12T00:02:05Z" }),
  task("r6", "completed", ["r5", "r4"], { projectId: "board", queuedAt: "2026-10-12T00:02:06Z" }),
];

/** 压力夹具：4 列 × 多行 + 宽 fan-in（λ/μ 装箱与通道带都吃满）。 */
const g45StressTasks = () => {
  const q = (i) => `2026-10-12T00:01:${String(i).padStart(2, "0")}Z`;
  const rows = [
    ["a1", []],
    ["a2", []],
    ["a3", []],
    ["a4", []],
    ["b1", ["a1", "a2"]],
    ["b2", ["a2", "a3"]],
    ["b3", ["a1", "a4"]],
    ["b4", ["a3", "a4"]],
    ["c1", ["b1", "b2"]],
    ["c2", ["b2", "b3"]],
    ["c3", ["b1", "b4"]],
    ["c4", ["b3", "b4"]],
    ["d1", ["a1", "c1", "c2", "c3", "c4"]],
    ["d2", ["a2", "c1", "c4"]],
  ];
  return rows.map(([id, ds], i) => task(id, "completed", ds, { projectId: "board", queuedAt: q(i + 1) }));
};

/** 三枚夹具（回灌后形态）统一跑判据用。 */
const g45Fixtures = () => [
  ["样本076bbb84", g45Layout(sample076bbb84())],
  ["压力14节点", g45Layout(g45StressTasks())],
  ["busReuse", g45Layout(busReuseTasks())],
];

test("G4-穿节点①段 bbox 定义式：弧取 4 控制点、水平段取 2 端点；相邻 1 段 / 长边 3 段（空转守卫在内）", () => {
  const { routes } = g45Layout(sample076bbb84());
  const counts = routes.map((e) => edgeBoxes(e).length);
  const adjacent = routes.filter((e) => e.kind === "adjacent");
  const longs = routes.filter((e) => e.kind === "long");
  assert.equal(adjacent.length, 7, "样本相邻弧 7 条（夹具基线，防漂移）");
  assert.equal(longs.length, 3, "样本长边 3 条");
  assert.deepEqual(counts, routes.map((e) => (e.kind === "long" ? 3 : 1)), "相邻 = 1 段、长边 = 3 段（下降弧 / 水平段 / 上升弧）");
  assert.equal(counts.reduce((s, n) => s + n, 0), 16, "段总数 = 16（度量对象非空）");
  for (const e of longs) {
    const segs = dSegments(e.d);
    assert.deepEqual(segs.map((s) => s.kind), ["cubic", "line", "cubic"], `${e.from}→${e.to} 长边段型序列`);
    const mid = edgeBoxes(e)[1];
    assert.equal(mid.box[2], mid.box[3], "水平段 y0===y1 ⇒ 中段真是水平（2 端点退化 bbox）");
    assert.ok(mid.box[1] > mid.box[0], "水平段 bbox 宽 = |tx2 − tx| > 0（非退化成点）");
    const first = segs[0].pts;
    assert.equal(first.length, 4, "下降弧 4 控制点");
    assert.equal(edgeBoxes(e)[0].box[1], Math.max(first[0][0], first[1][0], first[2][0], first[3][0]), "弧 bbox 的右界 = 4 控制点最大 x（凸包包含曲线）");
  }
  for (const e of adjacent) {
    const pts = dSegments(e.d)[0].pts;
    assert.equal(pts.length, 4, "相邻弧 4 控制点");
    const b = edgeBoxes(e)[0].box;
    assert.deepEqual(b, boxOfPts(pts), "相邻弧 bbox 由 4 控制点定义式给出");
  }
});

test("G4-穿节点②I1 通道包含·正向：三夹具 × 两种网格 ⇒ 段 bbox ∩ 非本边两端 chip 内部 = ∅", () => {
  const ran = [];
  for (const feed of [false, true]) {
    for (const [label, tasks] of [["样本076bbb84", sample076bbb84()], ["压力14节点", g45StressTasks()], ["busReuse", busReuseTasks()]]) {
      const { grid, routes } = g45Layout(tasks, feed);
      const { hits, checked } = findPenetrations(routes, grid);
      assert.ok(checked > 0, `${label}(feed=${feed}) 空转守卫：非端点 chip × 段 的比较数须 > 0，实得 ${checked}`);
      assert.deepEqual(hits.map((h) => [h.edge, h.chip, h.kind]), [], `I1 越界项须为空 —— ${label}（回灌态=${feed ? "渲染形态" : "未回灌"}）`);
      ran.push(checked);
    }
  }
  assert.ok(ran.every((n) => n > 0) && Math.max(...ran) > 100, "度量规模：三夹具回灌态下比较数须上量级（防判据只在极少样本上空转）");
});

test("G4-穿节点③与本边两端只许边界接触：首段左界 = 源 chip 右缘、末段右界 = 目标 chip 左缘，且自身两端也不入内部", () => {
  const { grid, routes } = g45Layout(sample076bbb84());
  let contacts = 0;
  for (const e of routes) {
    const a = grid.cellOf.get(e.from);
    const b = grid.cellOf.get(e.to);
    const boxes = edgeBoxes(e);
    assert.equal(boxes[0].box[0], a.chipRight, `${e.from}→${e.to} 首段左界 === 源 chip 右缘（边界接触）`);
    assert.equal(boxes[boxes.length - 1].box[1], b.chipX, `${e.from}→${e.to} 末段右界 === 目标 chip 左缘（边界接触）`);
    for (const { box } of boxes) {
      assert.equal(interiorOverlap(box, chipBox(a)), false, `${e.from}→${e.to} 段 bbox 不得进入**源** chip 内部（只许边界接触）`);
      assert.equal(interiorOverlap(box, chipBox(b)), false, `${e.from}→${e.to} 段 bbox 不得进入**目标** chip 内部`);
    }
    contacts += 2;
  }
  assert.equal(contacts, routes.length * 2, "每边两端各一次边界接触被真正检查过（非空转）");
  // 内部判据的方向性：同一枚 chip，把 bbox 往内挪 1px 就须判为穿模（否则「只许边界接触」是空话）
  const cell = grid.cells[0];
  const cb = chipBox(cell);
  assert.equal(interiorOverlap([cb[0] - 10, cb[0], cb[2], cb[3]], cb), false, "左界恰贴 chip 左缘 ⇒ 边界接触，不判穿模");
  assert.equal(interiorOverlap([cb[0] - 10, cb[0] + 1, cb[2], cb[3]], cb), true, "越过左缘 1px ⇒ 判穿模（判据真的在管内部）");
});

test("G4-穿节点④造反例·常驻：把长边水平段抬进 chip 行 ⇒ 必抓穿模；贴边形态必放行（两头都不许空转）", () => {
  const { grid, routes } = g45Layout(sample076bbb84());
  const long = routes.find((e) => e.kind === "long");
  assert.ok(long !== undefined, "夹具须含长边（否则本条退化为空转）");
  const a = grid.cellOf.get(long.from);
  const b = grid.cellOf.get(long.to);
  const mid = edgeBoxes(long)[1];
  // 反例 A（几何可达的错误形态）：水平段 y 从通道带被抬到最后一行 chip 的中线 ⇒ 必穿中间列 chip
  const badY = grid.rowY[grid.rows - 1] + DG_BADGE_H + DG_NODE_H / 2;
  const lifted = { box: [mid.box[0], mid.box[1], badY, badY], kind: "line" };
  const victims = grid.cells
    .filter((c) => c.taskId !== long.from && c.taskId !== long.to)
    .filter((c) => interiorOverlap(lifted.box, chipBox(c)));
  assert.ok(victims.length > 0, `抬进 chip 行的水平段必须抓到穿模（实得 ${victims.length} 枚被穿 chip）`);
  assert.ok(victims.every((c) => c.col > a.col && c.col < b.col), "被穿的必是**中间列**的非本边两端 chip（穿节点的定义）");
  // 反例 B（判据实现自检）：同一段若留在通道带（真实形态）⇒ 一枚都不穿
  const kept = grid.cells
    .filter((c) => c.taskId !== long.from && c.taskId !== long.to)
    .filter((c) => interiorOverlap(mid.box, chipBox(c)));
  assert.deepEqual(kept.map((c) => c.taskId), [], "同一段在未改动形态下零穿模 ⇒ 上条抓的确实是「抬 y」这件事");
  // 反例 C（贴边必须放行，防判据过紧把合法形态也判红）：bbox 右界正好落在某中间列 chip 的左缘
  // **必须取与 badY 同一行（末行）的中间列 chip** —— 否则 y 带根本不相干，两条断言一起空转（历轮实测踩到）
  const midCol = grid.cells.find((c) => c.col > a.col && c.col < b.col && c.row === grid.rows - 1);
  assert.ok(midCol !== undefined, "夹具须含**末行**的中间列 chip（贴边反例的载体，与 badY 同一 y 带）");
  assert.ok(badY > midCol.chipY && badY < midCol.chipY + DG_NODE_H, "反例载体自检：badY 确实落在该 chip 的 y 内部（否则①②都是空话）");
  const tangentBox = [midCol.chipX - 40, midCol.chipX, badY, badY + 1];
  assert.equal(interiorOverlap(tangentBox, chipBox(midCol)), false, "右界 === chip 左缘 ⇒ 边界接触放行（与 I1 的「内部」措辞一致）");
  const crossingBox = [midCol.chipX - 40, midCol.chipX + 0.5, badY, badY + 1];
  assert.equal(interiorOverlap(crossingBox, chipBox(midCol)), true, "越缘 ⇒ 判红（同一条判据的两侧都验到）");
});

test("G5-重叠①结构面 λ/μ 单射：同通道内 y 区间相交的两条边不得共用同一枚 lane（空转正钉）", () => {
  const seen = {};
  for (const [label, tasks] of [["样本076bbb84", sample076bbb84()], ["压力14节点", g45StressTasks()], ["busReuse", busReuseTasks()]]) {
    const { grid, routes } = g45Layout(tasks);
    const r = findLaneCollisions(grid, routes);
    assert.deepEqual(r.laneCollisions, [], `${label} λ/μ 不得与同通道内 y 区间相交的边共 lane（I3 结构面）`);
    seen[label] = r;
  }
  // 空转守卫**分两面**（历轮实测）：λ/μ 单射的载重 = 「同一通道 ∧ y 区间相交」的边对数；
  // busReuse 夹具按设计两条长边**源通道各异、x 分离** ⇒ 该项恒 0，它的结构面载重在 busLane 复用面。
  // 拿同一把尺量三夹具会把「夹具形态」误读成「判据空转」，故各自钉各自的载重项。
  assert.ok(seen["样本076bbb84"].yPairsChecked >= 1, `空转守卫：样本须存在「同通道 ∧ y 区间相交」的边对（实得 ${seen["样本076bbb84"].yPairsChecked}，否则单射断言是空话）`);
  assert.ok(seen["压力14节点"].yPairsChecked >= 1, `空转守卫：压力夹具同样有被测 λ/μ 边对（实得 ${seen["压力14节点"].yPairsChecked}）`);
  assert.ok(
    seen["busReuse"].busPairs >= 1 && seen["busReuse"].reusedLanes >= 1,
    `空转守卫：busReuse 的结构面载重 = busLane 复用被真正比较过（busPairs=${seen["busReuse"].busPairs} / reusedLanes=${seen["busReuse"].reusedLanes}）`,
  );
  // 装箱守恒的第二证：同一 λ 组内 lane 号互不相同（与 packLanes 的复用条件同义）
  const { grid, routes } = g45Layout(sample076bbb84());
  const bySrcCol = new Map();
  for (const e of routes.filter((x) => x.kind === "long")) {
    const k = grid.cellOf.get(e.from).col;
    const list = bySrcCol.get(k) ?? [];
    list.push(e);
    bySrcCol.set(k, list);
  }
  for (const [col, list] of bySrcCol) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const sa = ySpanOf(grid.cellOf.get(list[i].from).chipMidY, list[i].yb);
        const sb = ySpanOf(grid.cellOf.get(list[j].from).chipMidY, list[j].yb);
        if (!yIntersect(sa, sb)) continue;
        assert.notEqual(list[i].lambda, list[j].lambda, `源通道 ${col}：y 区间相交的两条边 λ 必须不同`);
      }
    }
  }
});

test("G5-重叠②结构面 busLane：同一 busLane 内的 x 区间两两严格不交（含复用真的发生过）", () => {
  const { grid, routes } = g45Layout(busReuseTasks());
  const r = findLaneCollisions(grid, routes);
  assert.equal(r.longCount, 2, "busReuse 夹具 = 2 条长边（列区间首尾分离）");
  assert.ok(r.reusedLanes >= 1, `空转守卫：须有 busLane 被两条边复用（实得 ${r.reusedLanes}），否则本锚只测了单例`);
  assert.ok(r.busPairs >= 1, "同 lane 内确有边对被比较过");
  assert.deepEqual(r.busCollisions, [], "busLane 复用的前提 = x 区间两两不交（I3 结构面）");
  // 两条长边确实共用 lane，且 x 区间分离（正向说明「复用」不是巧合而是装箱结果）
  const longs = routes.filter((e) => e.kind === "long");
  const [e1, e2] = longs;
  assert.equal(e1.busLane, e2.busLane, "夹具的两条长边同 busLane（复用形态）");
  const [a0, a1] = xSpanOf(grid, e1);
  const [b0, b1] = xSpanOf(grid, e2);
  assert.ok(a1 < b0 || b1 < a0, `同 lane 的两条边 x 区间必须严格分离：[${a0},${a1}] vs [${b0},${b1}]`);
  for (const [label, tasks] of [["样本076bbb84", sample076bbb84()], ["压力14节点", g45StressTasks()]]) {
    const one = findLaneCollisions(...Object.values(g45Layout(tasks)));
    assert.deepEqual(one.busCollisions, [], `${label} busLane 内不得出现重叠 x 区间`);
  }
});

test("G5-重叠③兜底采样面：叠点 ≥2 判红 · 且合法交叉与孤立交点必须放行（口径常驻正钉）", () => {
  let rawOnly = 0;
  for (const [label, { grid, routes }] of g45Fixtures().map(([n, v]) => [n, v])) {
    void grid;
    const { hits, rawHits, pairs } = findOverlaps(routes);
    assert.ok(pairs > 0, `${label} 空转守卫：段对比较数须 > 0`);
    assert.deepEqual(hits, [], `${label} 不得有共段（叠点 ≥${G5_RED_MIN} 即判红）`);
    rawOnly += rawHits;
    if (label === "样本076bbb84") {
      assert.ok(rawHits >= 1, "常驻正钉：样本上确有「字面近点对 ≥2」的合法交叉段对 ⇒ 证明叠点口径的两条区分是**载重**的，不是装饰");
      assert.ok(rawHits > hits.length, "合法交叉段对全部被放行（若相等即说明判据退化成了字面规则）");
    }
  }
  assert.ok(rawOnly >= 7, `样本实测 7 对合法交叉（raw ≥2 但未判红的段对数，实得 ${rawOnly}）`);
  // 逐字复核口径四句在实现上的落点
  const { routes } = g45Layout(sample076bbb84());
  const segs = routes.map((e) => dSegments(e.d).map(sampleSegment));
  const sharedEndPair = (() => {
    for (let i = 0; i < routes.length; i += 1) {
      for (let j = i + 1; j < routes.length; j += 1) {
        for (const A of segs[i]) {
          for (const B of segs[j]) {
            const ea = [A[0], A[A.length - 1]];
            const eb = [B[0], B[B.length - 1]];
            if (ea.some((p) => eb.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= 0.01))) return [A, B];
          }
        }
      }
    }
    return null;
  })();
  assert.ok(sharedEndPair !== null, "夹具须含共端点段对（「共端点不算重叠」的实测载体）");
  const { raw, overlap } = countNearPairs(sharedEndPair[0], sharedEndPair[1]);
  assert.equal(overlap < G5_RED_MIN, true, `共端点近旁 raw=${raw} 但未判红 ⇒ 「共端点不算重叠」成立`);
});

test("G5-重叠④造反例·常驻：长边 μ 改成与它边同值 ⇒ 结构面与兜底面至少各一条判红", () => {
  const { grid, routes } = g45Layout(sample076bbb84());
  const longs = routes.filter((e) => e.kind === "long");
  assert.ok(longs.length >= 2, "夹具须含 ≥2 条长边（反例的载体）");
  const A = longs[0];
  const B = longs[longs.length - 1];
  assert.notEqual(A.mu, B.mu, "夹具原态两条长边的 μ 本就不同（否则反例无意义）");
  assert.deepEqual(findLaneCollisions(grid, routes).laneCollisions, [], "原态：结构面干净");
  assert.deepEqual(findOverlaps(routes).hits, [], "原态：兜底面干净");

  // 反例 ①：把 B 的 μ 强改成 A 的 μ ⇒ 同一目标通道的 lane 撞车（结构面判红）
  const fakeB = { ...B, mu: A.mu };
  const coll = findLaneCollisions(grid, [A, fakeB]);
  assert.ok(coll.laneCollisions.length >= 1, `μ 同值必须被结构面抓住（实得 ${coll.laneCollisions.length} 条）`);

  // 反例 ②：把 B 的 μ **与 yb** 一起改成 A 的值，再用 busPath 按同式重算出真实 path ⇒ 兜底采样面判红。
  // **前提须写全（历轮实测）**：只改 μ 而 yb 不同时，两条上升弧只是「同一条竖直通道上的不同高度」
  // —— 共 x 不共段，兜底面不判红是**几何正确**的（口径 = 共段才算重叠），不该拿它当兜底面的反例；
  // 那种形态由反例 ①（结构面）负责抓。μ ∧ yb 同值 ⇒ 水平段同线、上升弧逐点重合 ⇒ 才是兜底面意义上的叠线。
  const fakeB2 = { ...B, mu: A.mu, yb: A.yb };
  const b = grid.cellOf.get(fakeB2.to);
  const a = grid.cellOf.get(fakeB2.from);
  const tx2 = b.chipX - DG_LANE_MIN - fakeB2.mu * DG_LANE_PITCH;
  const dFake = busPath(a.chipRight, a.chipMidY, a.chipRight + DG_LANE_MIN + fakeB2.lambda * DG_LANE_PITCH, fakeB2.yb, tx2, b.chipX, b.chipMidY);
  const fakeRoutes = [{ ...A, d: A.d }, { ...fakeB2, d: dFake }];
  const sampled = findOverlaps(fakeRoutes);
  assert.ok(sampled.hits.length >= 1, `μ ∧ yb 同值后水平段同线 / 上升弧重合须被兜底面抓住（实得 ${sampled.hits.length} 条）`);
  // 同一条反例的「只改 μ」对照面：兜底面**必须放行**（证明判据只禁叠线、不把共通道当叠线）
  const onlyMu = findOverlaps([{ ...A, d: A.d }, { ...fakeB, d: busPath(a.chipRight, a.chipMidY, a.chipRight + DG_LANE_MIN + fakeB.lambda * DG_LANE_PITCH, fakeB.yb, b.chipX - DG_LANE_MIN - fakeB.mu * DG_LANE_PITCH, b.chipX, b.chipMidY) }]);
  assert.deepEqual(onlyMu.hits, [], "只改 μ（yb 不同）⇒ 共通道不共段 ⇒ 兜底面放行（口径负钉，防判据过紧）");

  // 反例 ③：整条边重合（λ/μ/busLane 全同）⇒ 兜底面判红，且叠点数远大于阈值
  const dup = findOverlaps([A, { ...A }]);
  assert.ok(dup.hits.length >= 1, "完全重合的两条边必须判红");
  assert.ok(dup.hits[0].overlap > G5_RED_MIN * 2, "重合形态的叠点数应显著超阈（判据不是擦线通过）");

  // 反例 ④：busLane 强同值 ⇒ 结构面抓 x 区间
  const fakeBus = { ...B, busLane: A.busLane };
  assert.ok(findLaneCollisions(grid, [A, fakeBus]).busCollisions.length >= 1, "busLane 同值 ∧ x 区间相交 ⇒ 结构面判红");
});

// ---------------------------------------------------------------------------
// G8（v0.10.5 · REQ-2026-10-12-02 · 改造文档 §2.2 两条硬命名纪律 / §2.7-⑤⑥）：
// 渲染层属性纪律的负钉 —— ① svg 零盒模属性（不写 viewBox ⇒ 用户单位 = CSS px 1:1）；
// ② 带引号属性闭集 = {class, title, style, d}（helper 白名单同源，翻案 ⑨）；
// ③ 边线层每管道恰一枚（容器类 `dg-links`、边线类 `dg-edge`，均不含子串 `dg-edges`）。
// ---------------------------------------------------------------------------

/** 一枚 HTML 里全部开始标签内出现过的**属性名**（升序去重；布尔属性 `open` 无 `=` ⇒ 不入集合）。 */
const attrNamesIn = (html) => {
  const out = new Set();
  for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    for (const m of tag.matchAll(/([\w:-]+)=/g)) out.add(m[1]);
  }
  return [...out].sort();
};

test("G8-svg负钉①：svg 开标签逐字唯一 = <svg class=\"dg-links\">（零 viewBox / width / height / aria-hidden ⇒ 用户单位 = CSS px 1:1）", () => {
  for (const tasks of [pipe6Tasks(), sample076bbb84()]) {
    const { html } = renderDependencyGraphSection(tasks);
    const tags = html.match(/<svg[^>]*>/g) ?? [];
    assert.ok(tags.length > 0, "空转守卫：确有 svg 层");
    assert.deepEqual(
      [...new Set(tags)],
      ['<svg class="dg-links">'],
      "svg 除 class 外零属性（补 viewBox / width / height / aria-hidden 任一枚 ⇒ 本条红，且三条裸引号负钉集体红）",
    );
    assert.equal(/<svg[^>]*\s(viewBox|width|height|aria-hidden)\s*=/.test(html), false, "逐名点名：四枚属性一律不出现");
    assert.equal(/<path[^>]*\s(viewBox|stroke|fill|style)\s*=/.test(html), false, "path 只带 class + d（配色与盒模归 CSS）");
  }
});

test("G8-svg负钉②：带引号属性闭集 = {class,title,style,d}；cell 的 style 恰 left/top 两枚几何字面、零 position 声明", () => {
  for (const tasks of [pipe6Tasks(), sample076bbb84()]) {
    const { html } = renderDependencyGraphSection(tasks);
    assert.deepEqual(attrNamesIn(html), ["class", "d", "style", "title"], "属性名集合 === 闭集四枚（溢出第五枚带引号属性即红）");
    assert.equal(/"/.test(stripAttrs(html)), false, "剥掉闭集属性值后零裸引号（stripAttrs 白名单加 d = 翻案 ⑨）");
    const cells = html.match(/<span class="dg-cell" style="[^"]*">/g) ?? [];
    assert.ok(cells.length > 0, "空转守卫：确有 cell");
    for (const c of cells) assert.match(c, /^<span class="dg-cell" style="left:\d+px;top:\d+px">$/, `cell 的 style 只含几何字面：${c}`);
    assert.equal(html.includes("position:"), false, "区块 HTML 零 position 声明（定位由 CSS 给，inline 只给坐标）");
    // v0.10.6 §2.2.1-3 翻案（n14 收口）：inline 几何字面由「一枚网格」改为**三档分工**，逐档各钉其键闭集
    // ① 画布 = 盒模两枚 + 变量六枚（几何唯一下发面）② 网格 = 盒模两枚（零变量）③ 框 = 四枚定位尺寸
    // 「带引号属性闭集四枚」半句（上面 attrNamesIn 那条）**不翻** —— doc §2.2.1-4 明写不新增第五枚
    const canvas = html.match(/<div class="dg-canvas" style="([^"]*)">/);
    assert.ok(canvas !== null, "画布壳在场（几何变量的唯一下发面，S1 下从逐框上抬为逐画布一枚）");
    const canvasDecls = canvas[1].split(";").filter((s) => s !== "");
    assert.deepEqual(
      canvasDecls.map((s) => s.slice(0, s.indexOf(":"))),
      ["width", "height", "--dg-nw", "--dg-nh", "--dg-bh", "--dg-fb", "--dg-fth", "--dg-fp"],
      "画布下发键闭集 = 盒模两枚在前 + 六枚变量在后（顺序固定 ⇒ 渲染确定性）",
    );
    for (const d of canvasDecls) assert.match(d, /^[\w-]+:\d+px$/, `声明 = 名:整数px：${d}`);
    const grid = html.match(/<div class="dg-grid" style="([^"]*)">/);
    assert.ok(grid !== null, "网格壳在场（每框恰一枚，枚数另由 G8-svg负钉③ 钉）");
    assert.deepEqual(
      grid[1].split(";").filter((s) => s !== "").map((s) => s.slice(0, s.indexOf(":"))),
      ["width", "height"],
      "网格 inline 只剩盒模两枚（变量已上抬到画布 ⇒ 此处再现即第二份下发面）",
    );
    for (const f of html.match(/<details class="pipe" open style="([^"]*)">/g) ?? [])
      assert.match(
        f,
        /^<details class="pipe" open style="left:\d+px;top:\d+px;width:\d+px;height:\d+px">$/,
        `框 inline 恰四枚（固定盒 = §2.1 R7 的消解手段）：${f}`,
      );
  }
});

test("G8-svg负钉③：画布恰一枚 dg-links + 每框恰一枚 dg-grid；cell 枚数 === 节点枚数、每 cell 恰一枚 chip", () => {
  for (const [tasks, pipes, nodes] of [
    [pipe6Tasks(), 3, 6],
    [sample076bbb84(), 1, 7],
  ]) {
    const { html } = renderDependencyGraphSection(tasks);
    const bodies = html.split('<div class="pipe-body">').slice(1);
    assert.equal(bodies.length, pipes, "pipe-body 枚数 === 管道枚数");
    assert.equal((html.match(/<div class="dg-canvas"/g) ?? []).length, 1, "G10（⑦(ii)）：画布恰一枚");
    assert.equal(
      (html.match(/<svg class="dg-links">/g) ?? []).length,
      1,
      "G10 翻案（⑦(ii)，原「每管道恰一枚 dg-links」）：画布恰一枚边线层 —— 框内边与跨框边同入这一枚 svg、共用同一趟装箱（I3 才可机械核验）",
    );
    for (const b of bodies) {
      assert.equal((b.match(/<svg class="dg-links">/g) ?? []).length, 0, "G10 翻案（⑦(ii)）：每框体壳内零枚边线层（svg 已搬到画布层）");
      assert.equal((b.match(/<div class="dg-grid" style="/g) ?? []).length, 1, "每段恰一枚网格壳（G10 **不翻** 半句：dg-grid 枚数仍与框同源）");
    }
    assert.equal((html.match(/<span class="dg-cell" style="/g) ?? []).length, nodes, "cell 枚数 === 节点枚数（不丢不重）");
    const chips = html.match(/<span class="dg-chip dg-\w+" title="[^"]*">#\d+<\/span>/g) ?? [];
    assert.equal(chips.length, nodes, "每 cell 恰一枚 chip，出参字面与 N2b 逐字相同（角标已去内联）");
    assert.equal(html.includes("dg-edges"), html.includes('<p class="hint dg-edges">'), "新类名不含子串 dg-edges ⇒ 边清单在场判据仍逐字可用");
  }
});

// 件一（增补 §6.1 · 原取 (A) 外壳恒渲）锚①：**v0.10.6 C5 起改写为负向钉**（本条不删，只翻向）。
// 旧半句「外壳恒渲 = 每 cell 恒预留 14px」的**结构事实仍在**（14px 照留），承载者从 DOM 外壳 `.dg-deps`
// 换成 `.dg-cell` 的 `padding-top: var(--dg-bh)` ⇒ 本条两半照旧缺一不可：DOM 半钉「角标族整体不在场」
// （外壳 / sup / 角标字形三者皆零），机制半钉「14px 由谁承接」；负向钉必须配一枚**正数**（跨框真连线枚数）
// 才不是「什么都没画」的空负向。CSS 侧 `.dg-dep*` 的规则条目数归 G6-同源②，本条不重复。

test("件一①外壳退役（负向钉）：渲染 HTML 零 .dg-deps / 零角标 + 14px 行距改由 .dg-cell 的 padding-top 承接", () => {
  for (const [tasks, label, cells, cross] of [
    [pipe6Tasks(), "pipe6（4 枚跨框边 ⇒ 改由画布真连线承载）", 6, 4],
    [sample076bbb84(), "样本076bbb84（零跨框边）", 7, 0],
  ]) {
    const { html } = renderDependencyGraphSection(tasks);
    const cellCount = (html.match(/<span class="dg-cell" style="/g) ?? []).length;
    assert.ok(cellCount > 0, "空转守卫：确有 cell（零枚不得被负向钉当成通过）");
    assert.equal(cellCount, cells, `${label}：cell 枚数 === 节点枚数（外壳退役只删 chip 的兄弟节点，不删 cell）`);
    assert.equal(
      (html.match(/<span class="dg-chip dg-\w+" title="[^"]*">#\d+<\/span>/g) ?? []).length,
      cells,
      `${label}：每 cell 恰一枚 chip ⇒ cell 只剩 chip 一枚子元素`,
    );
    assert.equal(html.includes("dg-deps"), false, `${label}：角标带外壳不再出现（旧「外壳恒渲」翻为负向钉）`);
    assert.equal(html.includes("<sup"), false, `${label}：角标 sup 整族不出现`);
    assert.equal(html.includes("⇠"), false, `${label}：角标字形在渲染 HTML 内零出现（负向钉的期望串）`);
    assert.equal(graphFaceLedger(html).cross, cross, `${label}：跨框边确有等数真连线 ⇒ 本条不是「什么都没画」的空负向`);
  }
  // 机制侧：14px 行距的承接者（引下发键、CSS 侧不写数字）与随外壳退役的排布声明
  const block = pipeCssBlock();
  const cellDecls = cssDecls(cssRule(block, ".dg-cell"));
  assert.deepEqual(
    cellDecls.filter((d) => /^padding-top:/.test(d)),
    ["padding-top: var(--dg-bh)"],
    "cell 顶缘的 14px 由 padding-top 承接（值 = 下发的 --dg-bh，与 DG_BADGE_H 同源）",
  );
  assert.equal(
    cellDecls.filter((d) => /^order:/.test(d)).length,
    0,
    "order 声明随角标带外壳退役（cell 只剩 chip 一枚子元素 ⇒ 无需调视觉序）",
  );
  assert.equal(DG_BADGE_H, 14, "14px 预留量不动（C5 只换承载者、不改行距）");
});

// ---------------------------------------------------------------------------
// G9（v0.10.5 · REQ-2026-10-12-02 · 改造文档 §5 锚账「完备性总账」· **v0.10.6 C5 单出口改写**）：
// 每条**本质边**（`kept`）在图形面**恰有一个出口** —— v0.10.6 起角标族退役 ⇒ 同框边与跨框边
// **同一枚出口** = 画布层 `path`（跨框边不再「画不出、只报名」，改由框外公共通道带真连线承载）。
// 约简在场后总账拆三段：**主账** `paths === J`（原 `paths + marks === J` 的两出口合一）；
// **对账锚①** `原边数 === J + 省略清单长度`
// （抓住「约简自己吞边」）；**对账锚②** 每条省略边 `(u,v)` 满足 `v ∈ reach_kept(u)`
// （= 「省略的边都还能由 kept 推出」，约简不丢真实等待的机器判据）。
// 吞边 / 重边两种形态仍由主账抓；**非空转守卫**由旧的「两枚出口各非空」改为
// 「**同框边与跨框边两类各有实例**」（两类现走同一出口 ⇒ 漏任一类照样在 `paths` 或框对账上判红）。
// 枚数按 class / 字面串定位（不写行号）。
// ---------------------------------------------------------------------------

/**
 * 画布层各框的矩形（`<details class="pipe" open style="left/top/width/height">` + `summary` 的管道名）。
 * 单画布下 `path` 用**画布坐标**、cell 用**框内局部坐标** ⇒ 两者的唯一桥 = 框矩形。本锚只吃框矩形、
 * 不吃任何网格常量（改 PAD / 改列距 ⇒ 本锚不漂，坐标换算面归件一②）。
 */
function canvasFrameRects(html) {
  return [
    ...html.matchAll(
      /<details class="pipe" open style="left:(-?\d+)px;top:(-?\d+)px;width:(-?\d+)px;height:(-?\d+)px">\s*<summary>管道 ([^（]+)（/g,
    ),
  ].map((m) => ({
    projectId: m[5].trim(),
    x0: Number(m[1]),
    y0: Number(m[2]),
    x1: Number(m[1]) + Number(m[3]),
    y1: Number(m[2]) + Number(m[4]),
  }));
}

/** 端点 → 所属框（落不到框 / 落进两框 ⇒ 直接判红：线头悬空，或框矩形重叠到不可分类）。 */
function frameOfPoint(rects, point) {
  const hits = rects.filter((f) => point[0] >= f.x0 && point[0] <= f.x1 && point[1] >= f.y0 && point[1] <= f.y1);
  assert.equal(hits.length, 1, `端点 [${point}] 须恰好落进一枚框（实得 ${hits.length} 枚 ⇒ 线头悬空或框重叠）`);
  return hits[0].projectId;
}

/**
 * 图形面出口的账（**v0.10.6 C5 起单出口**）：`paths` = 画布 `path` 总枚数；`pairs` = 逐条 path 的
 * **端点落框对**（首点框 → 末点框，与模型边的 `from → to` 同向）；`cross` = 两端异框的枚数。
 * 旧口径的角标计数随角标族退役而删 ⇒ 出口枚数不再与「框内 / 框外」挂钩，
 * 跨框与否改由**几何面**（端点落框）判，比旧的角标计数强一档（角标只报「有来源」，线报「从哪到哪」）。
 */
function graphFaceLedger(html) {
  const rects = canvasFrameRects(html);
  const pairs = [];
  for (const e of edgePaths(html)) {
    const pts = dPoints(e.d);
    pairs.push({ from: frameOfPoint(rects, pts[0]), to: frameOfPoint(rects, pts[pts.length - 1]) });
  }
  return { paths: pairs.length, pairs, cross: pairs.filter((p) => p.from !== p.to).length };
}

/** 本质边 → 端点落框对（与渲染侧同一取数源：先约简、再按两端 project 组对 ⇒ 跨面账可比）。 */
function keptFramePairs(tasks) {
  const graph = buildTaskGraph(tasks);
  const projectOf = new Map(graph.nodes.map((n) => [n.taskId, n.projectId]));
  return transitiveReduce(graph.edges).kept.map((e) => ({ from: projectOf.get(e.from), to: projectOf.get(e.to) }));
}

/** 框对 → 可读字面（`a→b`），供逐条对账。 */
const pairTexts = (pairs) => pairs.map((p) => `${p.from}\u2192${p.to}`).sort();

/**
 * 框对账（**旧「双出口分席」的继承者**）：渲染侧 `path` 的端点落框对（多重集）=== 模型侧本质边的
 * 两端 project 对 ⇒ 抓住三种形态：漏画某条边（少一枚）、把跨框边画成框内线（框对错）、凭空多画（多一枚）。
 */
const assertFramePairLedger = (html, tasks, label) => {
  assert.deepEqual(pairTexts(graphFaceLedger(html).pairs), pairTexts(keptFramePairs(tasks)), `${label}：path 端点落框对 === 本质边两端 project 对`);
};

/** 边集上 `from` 的传递可达集（**不含**起点空路径自可达）—— 对账锚② 判据。 */
const reachFrom = (edges, from) => {
  const succ = new Map();
  for (const { from: a, to: b } of edges) succ.set(a, [...(succ.get(a) ?? []), b]);
  const seen = new Set();
  const stack = [...(succ.get(from) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of succ.get(id) ?? []) if (!seen.has(next)) stack.push(next);
  }
  return seen;
};

/** 一枚夹具 → 三份边账（声明原值 / 本质 / 传递省略），与渲染层同一判据同源。 */
const edgeLedgers = (tasks) => {
  const declared = buildTaskGraph(tasks).edges;
  const { kept, dropped } = transitiveReduce(declared);
  return { declared, kept, dropped };
};

test("G9-完备总账①管道制夹具（6 任务 / 3 管道 / 声明 5 边 · 本质 5）：path 枚数 === kept 枚数（同框 + 跨框同一出口）", () => {
  const tasks = pipe6Tasks();
  const { html } = renderDependencyGraphSection(tasks);
  const { paths, cross } = graphFaceLedger(html);
  const { declared, kept, dropped } = edgeLedgers(tasks);
  assert.deepEqual([paths, cross, kept.length], [5, 4, 5], "夹具现态 = 5 枚画布 path（其中 4 枚跨框）/ 5 条本质边");
  assert.ok(paths > 0 && cross > 0 && paths - cross > 0, "空转守卫：同框边与跨框边两类在本夹具各有实例 ⇒ 漏任一类必被本条抓住");
  assert.equal(paths, kept.length, "主账（v0.10.6 C5 单出口）：每条本质边恰落一枚画布 path，不吞不重");
  assertFramePairLedger(html, tasks, "①");
  assert.equal(declared.length, kept.length + dropped.length, "对账锚①：声明数 === 本质 + 省略");
  assert.equal(dropped.length, 0, "本夹具无冗余 ⇒ 省略清单空（主账与旧口径同值，不因此空转）");
});

test("G9-完备总账②单管道夹具（sample076bbb84，7 任务 / 1 管道 / 声明 10 边 → 本质 8）：本质边全入走线、跨框边恒 0 而总账仍成立", () => {
  const tasks = sample076bbb84();
  const { html } = renderDependencyGraphSection(tasks);
  const { paths, cross } = graphFaceLedger(html);
  const { declared, kept, dropped } = edgeLedgers(tasks);
  assert.ok(kept.length > 1, "空转守卫：本夹具确有本质边");
  assert.deepEqual([declared.length, kept.length, dropped.length], [10, 8, 2], "夹具现态 = 声明 10 → 本质 8 · 省略 2");
  assert.deepEqual(
    dropped.map((e) => `${e.from}→${e.to}`),
    ["n1→n6", "n2→n6"],
    "省略的两条 = n1→n6（经 n2/n3 可推）与 n2→n6（经 n3 可推）",
  );
  assert.equal(cross, 0, "单 project ⇒ 结构上无跨框边 ⇒ 八枚 path 的端点全落同一框（跨框档不被本夹具误触发）");
  assert.equal(html.includes("dg-edges"), false, "无跨管道边 ⇒ 边清单整行不渲（与①的对照面）");
  assert.equal(paths, kept.length, "主账：本质边全入走线 ⇒ path 枚数即本质边数（照吃声明原边集会在此判红）");
  assertFramePairLedger(html, tasks, "②");
  assert.equal(declared.length, kept.length + dropped.length, "对账锚①：10 === 8 + 2");
  for (const e of dropped) {
    assert.ok(reachFrom(kept, e.from).has(e.to), `对账锚②：省略边 ${e.from}→${e.to} 在 kept 上仍传递可达（约简不吞边）`);
  }
});

test("G9-完备总账③空图短路：零任务 ⇒ 区块空串（出口 0 枚、边数 0，总账不作真而通过）", () => {
  const { html } = renderDependencyGraphSection([]);
  const { paths, cross } = graphFaceLedger(html);
  const { kept, dropped } = edgeLedgers([]);
  assert.equal(html, "", "v0.9.5 C2 短路③：无任务 ⇒ 依赖图整节不渲染");
  assert.deepEqual([kept.length, dropped.length], [0, 0], "空任务集 ⇒ 零本质边、零省略边（取数源 = 约简集）");
  assert.deepEqual([paths, cross], [0, 0], "空图 ⇒ 出口零枚（无吞边、无凭空出的线）");
  assert.equal(paths, kept.length, "总账在短路形态同样成立（0 === 0）");
});

// ---------------------------------------------------------------------------
// N1约简（v0.10.5 · REQ-2026-10-12-04 · 改造文档 §2.3-1）：transitiveReduce 纯函数
// 性质 / 反例八条 —— 本组**自证、无渲染接线**（`h2` 自洽与跨管道同集两条属渲染面，归 N2）。
// 判据 = 删边测试：保留 (u,v) ⟺ 在 E ∖ {(u,v)} 上 v ∉ reach(u)。
// ---------------------------------------------------------------------------

/** 边 → 可读字面（`u→v`），供逐条对账。 */
const edgeTexts = (edges) => edges.map((e) => `${e.from}\u2192${e.to}`);

/**
 * 边集 → **全对传递闭包**（`start→id` 有序对清单，含多跳、**不含空路径自可达**）。
 * 「约简前后闭包恒等」与「每条 dropped 在 kept 上仍传递推出」两条共用此判据。
 */
const reachPairs = (edges) => {
  const succ = new Map();
  for (const { from, to } of edges) {
    const list = succ.get(from);
    if (list) list.push(to);
    else succ.set(from, [to]);
  }
  const pairs = [];
  for (const start of [...succ.keys()].sort()) {
    const seen = new Set();
    const stack = [...(succ.get(start) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of succ.get(id) ?? []) if (!seen.has(next)) stack.push(next);
    }
    for (const id of [...seen].sort()) pairs.push(`${start}\u2192${id}`);
  }
  return pairs;
};

/** ① 纯链 a→b→c（零冗余）。 */
const chainTasks = () => [task("a", "completed", []), task("b", "completed", ["a"]), task("c", "completed", ["b"])];

/** ② 菱形长边 a→b→c + a→c（冗余恰一枚 a→c）。 */
const diamondTasks = () => [task("a", "completed", []), task("b", "completed", ["a"]), task("c", "completed", ["b", "a"])];

/** ③ 多冗余并存不链式：a→b→c→d 全链 + a→c / a→d / b→d 三枚冗余。 */
const multiRedundantTasks = () => [
  task("a", "completed", []),
  task("b", "completed", ["a"]),
  task("c", "completed", ["a", "b"]),
  task("d", "completed", ["a", "b", "c"]),
];

/** ⑤ 纯定序边：两 project 各一节点、只一枚跨管道边、无任何平行路径。 */
const pureOrderTasks = () => [
  task("t-src", "completed", [], { projectId: "proj-src", queuedAt: "2026-10-12T00:00:01Z" }),
  task("t-dst", "completed", ["t-src"], { projectId: "proj-dst", queuedAt: "2026-10-12T00:00:02Z" }),
];

/** ⑧ 含环入参：t-a⇄t-b 成环（被构图层丢弃）+ t-a→t-c 一枚干净边。 */
const cyclicTasks = () => [
  task("t-a", "completed", ["t-b"]),
  task("t-b", "completed", ["t-a"]),
  task("t-c", "completed", ["t-a"]),
];

/** 六枚夹具全集（⑥⑦两条对每一条断言）。 */
const reduceFixtures = () => [
  ["纯链", chainTasks()],
  ["菱形长边", diamondTasks()],
  ["多冗余不链式", multiRedundantTasks()],
  ["纯定序边", pureOrderTasks()],
  ["含环入参（净化后）", cyclicTasks()],
  ["样本076bbb84", sample076bbb84()],
];

test("N1约简-①纯链：J=2 / R=0 且层号 {a:0,b:1,c:2}（双抓「方向写反」与「含自身可达性」）", () => {
  const tasks = chainTasks();
  const graph = buildTaskGraph(tasks);
  const { kept, dropped } = transitiveReduce(graph.edges);
  assert.deepEqual(edgeTexts(kept), ["a→b", "b→c"], "纯链两枚都是本质边（J=2）——判据写成「u ∈ reach(v)」的方向反版会把每边判成可推出 ⇒ R=2 在此判红");
  assert.deepEqual(edgeTexts(dropped), [], "R=0（把本边自己一跳也算进 reach 的版本会全删 ⇒ dropped 两枚在此判红）");
  const layers = layerOfGraph(graph.nodes, taskOrdinalMap(tasks), kept);
  assert.deepEqual(
    [...layers.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    [["a", 0], ["b", 1], ["c", 2]],
    "层号不塌（全删 ⇒ 每节点无入边 ⇒ 层号全塌 0，与 R=2 同抓）",
  );
});

test("N1约简-②菱形长边：dropped 恰 {a→c} 一枚、层号逐键不变", () => {
  const tasks = diamondTasks();
  const graph = buildTaskGraph(tasks);
  const ordinals = taskOrdinalMap(tasks);
  const { kept, dropped } = transitiveReduce(graph.edges);
  assert.deepEqual(edgeTexts(kept), ["a→b", "b→c"], "保留的是链上两枚本质边");
  assert.deepEqual(edgeTexts(dropped), ["a→c"], "长边 a→c 已由 a→b→c 推出 ⇒ 恰省略一枚");
  assert.deepEqual(
    layerOfGraph(graph.nodes, ordinals, kept),
    layerOfGraph(graph.nodes, ordinals, graph.edges),
    "约简不改变 longest-path 层号",
  );
});

test("N1约简-③多冗余并存不链式：J=3 / R=3（贪心原地删边会吞掉本质边 b→c ⇒ 在此判红）；乱序入参等值", () => {
  const tasks = multiRedundantTasks();
  const graph = buildTaskGraph(tasks);
  assert.equal(graph.edges.length, 6, "夹具现态 = 3 枚链边 + 3 枚冗余边");
  const { kept, dropped } = transitiveReduce(graph.edges);
  assert.deepEqual(edgeTexts(kept), ["a→b", "b→c", "c→d"], "本质边一枚不吞（原地删边版删掉 a→c 后会把 b→c 也判成冗余）");
  assert.deepEqual(edgeTexts(dropped), ["a→c", "a→d", "b→d"], "三枚冗余并存、互不牵连");
  const fromShuffled = transitiveReduce([...graph.edges].reverse());
  assert.deepEqual(edgeTexts(fromShuffled.kept), edgeTexts(kept), "入参数组序反转 ⇒ kept 逐字相等（冗余性是原边集 E 上的不变量）");
  assert.deepEqual(edgeTexts(fromShuffled.dropped), edgeTexts(dropped), "入参数组序反转 ⇒ dropped 逐字相等");
});

test("N1约简-④层号差分不变：layerOfGraph(全 edges) 与 (kept) 在四枚夹具上逐键相等", () => {
  for (const [label, tasks] of [
    ["纯链", chainTasks()],
    ["菱形长边", diamondTasks()],
    ["多冗余不链式", multiRedundantTasks()],
    ["样本076bbb84", sample076bbb84()],
  ]) {
    const graph = buildTaskGraph(tasks);
    const ordinals = taskOrdinalMap(tasks);
    const { kept, dropped } = transitiveReduce(graph.edges);
    assert.deepEqual(
      layerOfGraph(graph.nodes, ordinals, kept),
      layerOfGraph(graph.nodes, ordinals, graph.edges),
      `${label}：chip 位置不变（层号逐键相等）`,
    );
    assert.equal(kept.length + dropped.length, graph.edges.length, `${label}：kept ∪ dropped 恰 partition 原边集（不丢不重）`);
  }
  const sample = buildTaskGraph(sample076bbb84());
  const { kept, dropped } = transitiveReduce(sample.edges);
  assert.deepEqual([sample.edges.length, kept.length, dropped.length], [10, 8, 2], "样本076bbb84 现态读数 = 声明 10 / 本质 8 / 省略 2（n1→n6、n2→n6）");
});

test("N1约简-⑤纯定序边（C1 关键）：单枚跨框边、无平行路径 ⇒ R=0、kept 含该边 ⇒ 落成一条真 path", () => {
  const graph = buildTaskGraph(pureOrderTasks());
  assert.equal(graph.edges.length, 1, "夹具现态 = 恰一枚跨框边");
  assert.notEqual(
    graph.nodes.find((n) => n.taskId === "t-src").projectId,
    graph.nodes.find((n) => n.taskId === "t-dst").projectId,
    "两端异 project ⇒ 该边在图形面走**跨框真连线**出口（v0.10.6 C5 起角标退役，跨框边不再「只报名不画线」）",
  );
  const { kept, dropped } = transitiveReduce(graph.edges);
  assert.deepEqual(edgeTexts(kept), ["t-src→t-dst"], "为定序而声明的边照留（误删 ⇒ 跨框走线族整族空转）");
  assert.deepEqual(edgeTexts(dropped), [], "R=0 —— 无平行可达路径 ⇒ 删边测试判不出冗余");
  // 语义重指向（v0.10.6 C5）：旧口径只要求「该边入角标清单」；单画布合并后要求「该边落成一条真 path」
  // ⇒ 判据从「报名」抬到「画线」，且由端点落框分类钉死它确实**跨**了两枚框（不是被误画成框内线）。
  const { html } = renderDependencyGraphSection(pureOrderTasks());
  const { paths, pairs } = graphFaceLedger(html);
  assert.equal(paths, 1, "该纯定序边在画布层恰落一枚 path（R=0 且 kept 含它 ⇒ 必须看得见）");
  assert.deepEqual(
    pairs.map((p) => `${p.from}→${p.to}`),
    ["proj-src→proj-dst"],
    "唯一一枚 path 的端点落框对 = 该边两端 project（同向 ⇒ 不是框内线、不是画反）",
  );
  assert.equal(graphFaceLedger(html).cross, 1, "跨框档恰一枚 ⇒ 定序边不再靠角标承载、也不再「清单有线没」");
});

test("N1约简-⑥闭包恒等（不丢真实等待）：六枚夹具约简前后全对可达关系完全相同", () => {
  for (const [label, tasks] of reduceFixtures()) {
    const { edges } = buildTaskGraph(tasks);
    const { kept } = transitiveReduce(edges);
    assert.deepEqual(reachPairs(kept), reachPairs(edges), `${label}：传递闭包逐对相等 ⇒ 就绪集 / 派发序 / 冻结闭包的输入不变`);
  }
});

test("N1约简-⑦不吞边：每条 dropped (u,v) 在 kept 上仍传递推出（v ∈ reach_kept(u)）", () => {
  let pins = 0;
  for (const [label, tasks] of reduceFixtures()) {
    const { edges } = buildTaskGraph(tasks);
    const { kept, dropped } = transitiveReduce(edges);
    const keptPairs = new Set(reachPairs(kept));
    for (const e of dropped) {
      pins += 1;
      assert.ok(keptPairs.has(`${e.from}→${e.to}`), `${label}：省略边 ${e.from}→${e.to} 在 kept 上不可推出 ⇒ 约简吞掉了真实等待`);
    }
  }
  assert.ok(pins >= 5, `空转守卫：省略边对账确有实例（实测 ${pins} 枚）而非「dropped 恒空」蒙过`);
});

test("N1约简-⑧含环入参负钉：cycleEdges 原样、约简只在 edges 上跑（且脏边集入参不吞环、不死循环）", () => {
  const graph = buildTaskGraph(cyclicTasks());
  assert.deepEqual(edgeTexts(graph.cycleEdges), ["t-a→t-b", "t-b→t-a"], "环边由构图层丢弃、原样在场");
  const snapshot = edgeTexts(graph.cycleEdges);
  const { kept, dropped } = transitiveReduce(graph.edges);
  assert.deepEqual(edgeTexts(kept), ["t-a→t-c"], "干净边照留（约简的输入只有已净化的 edges）");
  assert.deepEqual(edgeTexts(dropped), [], "dropped 内不得出现任何环边");
  assert.deepEqual(edgeTexts(graph.cycleEdges), snapshot, "调用 transitiveReduce 不回写入参、不动 cycleEdges");
  const dirty = transitiveReduce([{ from: "x", to: "y" }, { from: "y", to: "x" }]);
  assert.deepEqual(edgeTexts(dirty.kept), ["x→y", "y→x"], "越契约的脏入参（含环）⇒ 不吞任一边、不死循环（净化归构图层，同 G1-⑤ 口径）");
  assert.deepEqual(edgeTexts(dirty.dropped), [], "脏入参下不产出省略边");
});

// ---------------------------------------------------------------------------
// N2渲染接线（v0.10.5 · REQ-2026-10-12-04 · 改造文档 §2.3-2 / §2.3-3 / §4 同源对锚）：
// 五消费点共用同一份 `kept` ⇒ 图形面（走线 / 角标 / 边清单 / 层号 / h2）只画**本质边**；
// 本组钉「**同源**」—— 任何一处仍在吃声明原边集，都会在约简发生的那一刻被下面的对锚抓住。
// h2 三数**从渲染 HTML 反向解析**（不得从约简对象直取 ⇒ 抓「拼装侧把 K/J 写串」）。
// ---------------------------------------------------------------------------

/**
 * `h2` 恒全形的反向解析（五数按位取；短路形态 ⇒ 抛断言，不许静默返回全 0）。
 * 判据 = 改造文档 §2.3-3：`声明 K 边（本质 J · 传递省略 R）`，`R = 0` 也出「传递省略 0」。
 */
function parseH2(html) {
  const m = /<h2>依赖图（(\d+) 任务 · (\d+) 管道 · 声明 (\d+) 边（本质 (\d+) · 传递省略 (\d+)））<\/h2>/.exec(html);
  assert.ok(m !== null, `h2 恒全形在场且五数齐（实得首行 = ${html.split("\n")[0]}…）`);
  return { nodes: Number(m[1]), pipes: Number(m[2]), declared: Number(m[3]), essential: Number(m[4]), omitted: Number(m[5]) };
}

/**
 * 区块 HTML → 画布面边线清单 `{isLong, first, last, frames}`
 * （长边 = `d` 含水平段命令 `L`；v0.10.6 C4 / 形态 S1 翻案 · n14 收口）。
 * **旧形态按 `<div class="pipe-body">` 在框面找 path** —— S1 下 `svg.dg-links` 已从框内搬到画布层
 * （每框零枚，枚数另由 G8-svg负钉③ 钉），框面切片恒得 0 枚 ⇒ 本 helper 若不改即「什么都没数到」的空钉。
 * 取数面随之上收一层：path 池 = `.dg-canvas` 那一枚 svg；端点反查配 **件一② 的加偏换算式**（下 `taskIdByEdgePoint`）。
 */
function renderedEdges(html) {
  const canvas = /<div class="dg-canvas"[^>]*>\s*<svg class="dg-links">([\s\S]*?)<\/svg>/.exec(html);
  assert.ok(canvas !== null, "画布级边线层在场（框内不再取池 —— 逐框池恒为空）");
  /** 逐框 origin(dx/dy) + 该框子树内的**局部** cell（与件一② 同一对事实源，DOM 局部 / path 画布） */
  const frames = new Map();
  for (const chunk of html.split('<details class="pipe" open style="').slice(1)) {
    const body = chunk.slice(0, chunk.indexOf("</details>"));
    const m = /^left:(\d+)px;top:(\d+)px;width:(\d+)px;height:(\d+)px">\s*<summary>管道 ([^（]+)（/.exec(body);
    assert.ok(m !== undefined, `框 = 固定盒四枚几何字面（left/top/width/height）+ summary（实得 ${body.slice(0, 80)}…）`);
    frames.set(m[5], { dx: Number(m[1]), dy: Number(m[2]), cells: renderedCells(body) });
  }
  const out = [];
  for (const { d } of edgePaths(canvas[1])) {
    const pts = dPoints(d);
    out.push({ isLong: dCmds(d).includes("L"), first: pts[0], last: pts[pts.length - 1], frames });
  }
  return out;
}

/**
 * 画布面端点坐标 → taskId（右缘中点 = 源、左缘中点 = 目标）。
 * **换算式 = 改造文档 §4.4「件一②」**，且与件一② 的正钉**共吃 {@link canvasEdgePoint} 一枚单源**：
 * 画布点 = cell **局部值** + **框外缘** `dx/dy`（= `renderFrame` inline 的 left/top）+ **框内 origin**
 * （`DG_GRID_ORIGIN_X = border + pad`、`DG_GRID_ORIGIN_Y = border + title`）—— 只加外缘是本次回归的错形，
 * 少任一加数即「线头悬空」。
 * 纵中点 = 局部 `top` + `DG_BADGE_H`（C5 后恒由 `.dg-cell` 的 `padding-top: var(--dg-bh)` 承接
 * ⇒ 旧 `hasBand` 分叉已消）+ `DG_NODE_H / 2`。
 */
function taskIdByEdgePoint(frames, point, side) {
  for (const f of frames.values()) {
    for (const [taskId, c] of f.cells) {
      if (String(canvasEdgePoint(f, c, side)) === String(point)) return taskId;
    }
  }
  assert.fail(
    `端点 [${point}]（${side} 侧）在画布面（cell 局部值 + 框外缘 dx/dy + 框内 origin）里反查不到 ⇒ 线头悬空`,
  );
}

/**
 * 区块 HTML → 跨框边的**三枚出口**计数（**v0.10.6 C5 起**：文本面 = `.dg-edges` 清单枚数，
 * 几何面 = 端点落框分类出的**跨框 path 枚数**；旧口径的角标原值 / 显示枚随角标族退役而删 ——
 * 折叠概念一并退役，跨框边不再「显示到第 3 枚就压掉」，逐条都画得出。
 * **追加件 n9 起增第三面**：类面 = path 的 class 取值为 {@link DG_EDGE_CROSS_CLS} 的枚数 ——
 * 三面同源钉（`N2对锚③` 同族）见 G14 块。
 */
function crossFaceCounts(html) {
  const row = /<p class="hint dg-edges">([^<]*)<\/p>/.exec(html);
  const list = row === null ? 0 : (row[1].match(/⇢/g) ?? []).length;
  const { paths, cross } = graphFaceLedger(html);
  const cls = crossClsCount(edgePaths(html));
  return { list, paths, cross, cls, intra: paths - cross };
}

/** 本质边里的跨管道边清单（与渲染层同一取数源：先约简、再分跨管道 / 板内）。 */
function crossKeptEdges(tasks) {
  const graph = buildTaskGraph(tasks);
  const projectOf = new Map(graph.nodes.map((n) => [n.taskId, n.projectId]));
  return transitiveReduce(graph.edges).kept.filter((e) => projectOf.get(e.from) !== projectOf.get(e.to));
}

/**
 * 约简 + 跨框边**同时在场**的组合夹具（改造文档 §4 同源对锚③）：
 * `src` 管道内 `a1→a2` 已成链 ⇒ `a1⇢t1` 可经 `a1→a2→t1` 推出（省略 1 枚）；
 * 余下 4 枚跨框本质边**全部逐条画成真连线**（v0.10.6 C5：旧口径此处压折叠枚，现无封顶可言）。
 * （夹具名里的「fold」= 旧角标折叠时代的遗留称谓，现测的是「约简在前、走线在后」的两面同步。）
 */
const foldReduceTasks = () => [
  task("a1", "completed", [], { projectId: "src", queuedAt: "2026-10-12T00:00:01Z" }),
  task("a2", "completed", ["a1"], { projectId: "src", queuedAt: "2026-10-12T00:00:02Z" }),
  task("b1", "completed", [], { projectId: "src", queuedAt: "2026-10-12T00:00:03Z" }),
  task("b2", "completed", [], { projectId: "src", queuedAt: "2026-10-12T00:00:04Z" }),
  task("b3", "completed", [], { projectId: "src", queuedAt: "2026-10-12T00:00:05Z" }),
  task("t1", "working", ["a1", "a2", "b1", "b2", "b3"], { projectId: "dst", queuedAt: "2026-10-12T00:00:06Z" }),
];

/**
 * 跨管道同集夹具（改造文档 §4「全图单次约简 · 跨管道同集」）：
 * `a(board) → b(orch) → c(flow)` 三枚边**全是跨管道边**，`a→c` 是其中可推出的那一枚 ⇒
 * 被删的是**跨框**边（若 `c` 也放 `board`，`a→c` 就成板内边、测不到跨框走线与清单的同步）。
 */
const crossReduceTasks = () => [
  task("x-a", "completed", [], { projectId: "board", queuedAt: "2026-10-12T00:00:01Z" }),
  task("x-b", "completed", ["x-a"], { projectId: "orch", queuedAt: "2026-10-12T00:00:02Z" }),
  task("x-c", "working", ["x-b", "x-a"], { projectId: "flow", queuedAt: "2026-10-12T00:00:03Z" }),
];

test("N2-h2自洽：五数从渲染 HTML 反向解析、按位取，断言 声明 === 本质 + 省略（四枚夹具，不得从约简对象直取）", () => {
  for (const [label, tasks, want] of [
    ["pipe6（无冗余 ⇒ R=0 仍出全形）", pipe6Tasks(), [6, 3, 5, 5, 0]],
    ["样本076bbb84（10 → 8 · 省 2）", sample076bbb84(), [7, 1, 10, 8, 2]],
    ["折叠+约简组合（6 → 5 · 省 1）", foldReduceTasks(), [6, 2, 6, 5, 1]],
    ["跨管道同集（3 → 2 · 省 1）", crossReduceTasks(), [3, 3, 3, 2, 1]],
  ]) {
    const { html } = renderDependencyGraphSection(tasks);
    const got = parseH2(html);
    assert.deepEqual([got.nodes, got.pipes, got.declared, got.essential, got.omitted], want, `${label}：h2 五数现态`);
    assert.equal(got.declared, got.essential + got.omitted, `${label}：自洽式 K === J + R（拼装侧把 K/J 写串 ⇒ 在此判红）`);
    const graph = buildTaskGraph(tasks);
    const { kept, dropped } = transitiveReduce(graph.edges);
    assert.equal(got.declared, graph.edges.length, `${label}：K = 声明边数（取数源 = graph.edges）`);
    assert.equal(got.essential, kept.length, `${label}：J = kept 枚数`);
    assert.equal(got.omitted, dropped.length, `${label}：R = dropped 枚数`);
  }
});

test("N2-h2全形单一形态：R=0 的夹具也出「传递省略 0」，无短形态残留（区块恰一枚 h2 且必成全形）", () => {
  for (const [label, tasks] of [
    ["pipe6", pipe6Tasks()],
    ["样本076bbb84", sample076bbb84()],
    ["零边单节点", [task("z-1")]],
  ]) {
    const { html } = renderDependencyGraphSection(tasks);
    const heads = html.match(/<h2>[^<]*<\/h2>/g) ?? [];
    assert.equal(heads.length, 1, `${label}：区块恰一枚 h2`);
    assert.match(heads[0], /^<h2>依赖图（\d+ 任务 · \d+ 管道 · 声明 \d+ 边（本质 \d+ · 传递省略 \d+））<\/h2>$/, `${label}：恒全形（采短形态 ⇒ 本条红）`);
  }
  // 省略只出计数、不逐条列，也不进「画不出的边」那一行（§2.3-4）
  const { html } = renderDependencyGraphSection(sample076bbb84());
  assert.ok(html.includes("传递省略 2"), "省略数在场（计数）");
  assert.equal(/<p class="hint warn">/.test(html), false, "无悬空 / 环边 ⇒ 单管道样本不出 warn 行（dropped 不得挤进该行）");
  assert.equal(html.includes("n1→n6"), false, "省略边不逐条列（图形面既不画线也不报名）");
});

test("N2对锚①画布面长边枚数 = 1（约简把样本的 3 枚长边降到 1；取数面随 S1 上收到画布层）", () => {
  const tasks = sample076bbb84();
  const { html } = renderDependencyGraphSection(tasks);
  assert.deepEqual(
    g3Sample().routes.filter((e) => e.kind === "long").map((e) => `${e.from}→${e.to}`),
    ["n1→n6", "n2→n6", "n5→n6"],
    "G3/G4/G5 走线族仍吃**声明原边集** ⇒ 路由器侧长边 3 枚不变（本夹具为单管道，不涉跨框边）",
  );
  // v0.10.6 C4 / 形态 S1 翻案（n14 收口，改造文档 §2.2.1）：path 池只在画布层 ⇒ 「区块面」抬为「画布面」
  const edges = renderedEdges(html);
  assert.equal(edges.length, 8, "画布面边线枚数 === 本质边数 8（不是声明数 10）");
  const longs = edges.filter((e) => e.isLong);
  assert.equal(longs.length, 1, "画布面长边由 3 降到 1（约简掉的正是那两枚跨列长边）");
  const e = longs[0];
  const from = taskIdByEdgePoint(e.frames, e.first, "from");
  const to = taskIdByEdgePoint(e.frames, e.last, "to");
  assert.deepEqual([from, to], ["n5", "n6"], "幸存的长边 = n5→n6（端点反查渲染 cell **加框 origin 后**，不是从模型直取）");
  assert.equal(edges.filter((x) => !x.isLong).length, 7, "其余 7 枚相邻弧不变 ⇒ 约简只削长边、不短化相邻边");
});

test("N2对锚②`.dg-edges` 清单枚数 === 跨框 path 枚数（文本面与几何面同源，v0.10.6 C5 角标退役后锚强度上升）", () => {
  for (const [label, tasks] of [
    ["pipe6（4 枚跨框边）", pipe6Tasks()],
    ["样本076bbb84（零跨框边 ⇒ 两枚出口同 0）", sample076bbb84()],
    ["约简+跨框组合（省略 1 · 跨框 4）", foldReduceTasks()],
    ["跨管道同集（省略 1 · 跨框 2）", crossReduceTasks()],
  ]) {
    const { html } = renderDependencyGraphSection(tasks);
    const { list, cross, paths } = crossFaceCounts(html);
    const model = crossKeptEdges(tasks).length;
    assert.equal(list, model, `${label}：底部清单枚数 === 本质跨框边枚数（文本面 ↔ 模型面）`);
    assert.equal(cross, model, `${label}：跨框 path 枚数 === 本质跨框边枚数（几何面 ↔ 模型面 —— 端点落框分类，不吃角标）`);
    assert.equal(list, cross, `${label}：两枚出口同数 ⇒ 不会出现「清单列着、图上没线」，也不会「线上画着、清单漏报」`);
    assert.ok(cross <= paths, `${label}：跨框枚数 ≤ 画布 path 总枚数（同框边共用同一出口，只许少不许多）`);
  }
  // 非空转：夹具里确有「跨框在场」与「两枚出口同零」两种形态
  const combo = crossFaceCounts(renderDependencyGraphSection(foldReduceTasks()).html);
  assert.deepEqual([combo.cross, combo.intra, combo.list], [4, 1, 4], "空转守卫：跨框形态真的发生过（跨框 4 / 同框 1 / 清单 4）");
  const none = crossFaceCounts(renderDependencyGraphSection(sample076bbb84()).html);
  assert.deepEqual([none.cross, none.list], [0, 0], "空转守卫的另一侧：单管道 ⇒ 两枚出口同零（不得只靠一侧零成立）");
  assert.equal(none.paths, 8, "另一侧仍有实线（同框 8 枚本质边全落 path ⇒ 同零不是「整图没画」）");
});

test("N2对锚③约简 + 跨框同时在场：被省略的 a1⇢t1 既不入清单、也不占跨框 path 位（跨框数按约简后算）", () => {
  const { html } = renderDependencyGraphSection(foldReduceTasks());
  const ordinals = taskOrdinalMap(foldReduceTasks());
  assert.equal(ordinals.get("a1"), 1, "夹具基线：a1 = #1");
  assert.equal(html.includes("⇠"), false, "省略边的来源不再出角标（角标族整体退役 ⇒ 本面对所有边一律零）");
  assert.equal(html.includes("<sup"), false, "同上的 DOM 面：无角标 sup");
  assert.equal(html.includes("#1 ⇢"), false, "省略边的来源不再进底部清单");
  const { list, cross, intra, paths } = crossFaceCounts(html);
  assert.deepEqual([list, cross], [4, 4], "清单 4 = 跨框 4（省略在前、两枚出口在后 ⇒ 两侧同步少一枚 a1）");
  assert.deepEqual([intra, paths], [1, 5], "同框只 a1→a2 一枚、总枚数 === 本质 5（约简没把跨框边挤成同框边）");
  assertFramePairLedger(html, foldReduceTasks(), "③");
});

test("N2跨管道同集：约简在全图上做一次 ⇒ 跨框走线与 `.dg-edges` 清单同步减一（同框边与跨框边共用同一约简集）", () => {
  const tasks = crossReduceTasks();
  const { html } = renderDependencyGraphSection(tasks);
  const graph = buildTaskGraph(tasks);
  assert.equal(graph.edges.length, 3, "夹具现态 = 3 条声明边（全部跨框）");
  assert.deepEqual(
    transitiveReduce(graph.edges).dropped.map((e) => `${e.from}→${e.to}`),
    ["x-a→x-c"],
    "被删的是**跨框**边 x-a→x-c（经 x-b 可推出）",
  );
  const { list, cross } = crossFaceCounts(html);
  assert.deepEqual([list, cross], [2, 2], "两枚出口从 3 同步降到 2 ⇒ 分开跑约简会在此判红（走线与清单互相不一致）");
  /**
   * `taskId → 所在框`（按 `<details>` 分段做**文本归属** ⇒ 不吃坐标换算，与本族其余锚正交）。
   * 旧口径读该 cell 的角标带内文；角标退役后同一问句改由**几何面**回答（线落进哪枚框），锚强度上升、不删。
   */
  const frameOfTask = new Map();
  for (const seg of html.split('<details class="pipe" open').slice(1)) {
    const head = /^\s*style="[^"]*">\s*<summary>管道 ([^（]+)（(\d+)）/.exec(seg);
    assert.ok(head !== null, `分段须以「框头 + 计数」起始（实得 ${seg.slice(0, 60)}…）`);
    const cells = [...seg.matchAll(/class="dg-chip[^"]*" title="([^"]+?) · #/g)];
    assert.equal(cells.length, Number(head[2]), `${head[1].trim()}：分段内 cell 枚数 === summary 计数 ⇒「框 ← cell」的归属不靠巧合`);
    for (const c of cells) {
      assert.equal(frameOfTask.has(c[1]), false, `同一 taskId 不得跨框重复出现：${c[1]}`);
      frameOfTask.set(c[1], head[1].trim());
    }
  }
  assert.equal(frameOfTask.size, 3, "夹具基线：三枚 cell 各在一框（本锚的问句才落在「框」这一层）");
  /** 该 taskId 所在框的**入线来源框**（几何面：path 末点落进该框、首点落进哪枚框）。 */
  const inboundFrames = (taskId) => {
    const own = frameOfTask.get(taskId);
    assert.ok(own !== undefined, `${taskId} 的 cell 在场`);
    return graphFaceLedger(html)
      .pairs.filter((p) => p.to === own)
      .map((p) => p.from);
  };
  assert.deepEqual(inboundFrames("x-b").sort(), ["board"], "b 的入线来自 a 那一框（本质边 a→b 照画）");
  assert.deepEqual(inboundFrames("x-c").sort(), ["orch"], "c 的入线只剩 b 那一框 ⇒ 省略的 a→c 不占走线位");
  assert.deepEqual(inboundFrames("x-a"), [], "a 无入边 ⇒ 入线亦零枚（负向一侧，防「整框都挂着线」的空转）");
  assert.equal(html.includes("#1 ⇢ #3"), false, "省略的 a→c 不在清单");
  const row = /<p class="hint dg-edges">([^<]*)<\/p>/.exec(html)[1];
  assert.ok(row.includes("#1 ⇢ #2(orch)"), "a→b 照列");
  assert.ok(row.includes("#2 ⇢ #3(flow)"), "b→c 照列");
  assert.equal(parseH2(html).omitted, 1, "h2 的省略数与两枚出口的减量同源（都来自同一份 kept）");
});

// ---------------------------------------------------------------------------
// N3收口（v0.10.5 · REQ-2026-10-12-04 · 改造文档 §4 同源对锚④ / §5 风险②）：
// **尺寸单调不增** —— 约简后网格的 `width` / `height` 只许 **≤** 约简前，**不钉等值**。
// 理由 = 通道宽由 lane 预算回灌（`gapW[c] = max(DG_COL_GAP_MIN, DG_LANE_MIN*2 + n*DG_LANE_PITCH)`）
// ⇒ 长边枚数减少**应**下降，但降幅受 `DG_COL_GAP_MIN` 地板截断 ⇒ **不是常量**，只能钉方向。
// 走线族入参照旧（G3/G4/G5 三族仍吃**声明原边集**，见 N2对锚① 首条断言）⇒ 本锚只量渲染层。
// ---------------------------------------------------------------------------

/**
 * 渲染层 `planPipe` 的同形态驱动（构图 → 走线 → lane 数回灌 → 重算网格 → 再走线），
 * **唯一差别 = 边集由入参给定** ⇒ 可把「声明原边集」与「约简后 `kept`」灌进同一条流水线对照尺寸。
 */
function planWithEdges(tasks, projectId, edges) {
  const graph = buildGraphWithPipelines(tasks);
  const ordinals = taskOrdinalMap(tasks);
  const layers = layerOfGraph(graph.nodes, ordinals, edges);
  const pipe = graph.pipelines.find((p) => p.projectId === projectId);
  assert.ok(pipe !== undefined, `夹具须含 ${projectId} 管道`);
  const columns = compressPipeLayers(pipe, layers);
  const base = pipeGridLayout(pipe, columns, ordinals);
  const longs = routeIntraEdges(edges, base).filter((e) => e.kind === "long");
  const gapLanes = new Array(Math.max(0, base.cols - 1)).fill(0);
  for (const e of longs) {
    const a = base.cellOf.get(e.from);
    const b = base.cellOf.get(e.to);
    if (a === undefined || b === undefined) continue;
    gapLanes[a.col] += 1;
    const targetGap = b.col - 1;
    if (targetGap >= 0 && targetGap < gapLanes.length) gapLanes[targetGap] += 1;
  }
  return {
    grid: pipeGridLayout(pipe, columns, ordinals, { gapLanes, busLaneCount: longs.length }),
    longCount: longs.length,
  };
}

/** 区块 HTML → 各管道 `.dg-grid` 实际下发的盒模两枚（渲染侧的 width / height 字面）。 */
function renderedGridBox(html) {
  return (html.match(/<div class="dg-grid" style="([^"]*)">/g) ?? []).map((raw) => {
    const decls = /style="([^"]*)"/.exec(raw)[1].split(";").filter((s) => s !== "");
    const num = (name) => {
      const d = decls.find((x) => x.startsWith(`${name}:`));
      assert.ok(d !== undefined, `盒模声明 ${name} 在场（实得 ${decls.join(";")}）`);
      return Number(/:(\d+)px$/.exec(d)[1]);
    };
    return { width: num("width"), height: num("height") };
  });
}

test("N3对锚④尺寸单调不增：约简后 width / height ≤ 约简前（不等式钉 · 三夹具 + 渲染下发值同源 + 降幅非退化）", () => {
  let strict = 0;
  for (const [label, tasks] of [
    ["样本076bbb84（10 → 8 · 省 2 · 长边 3 → 1）", sample076bbb84()],
    ["busReuse（6 → 4 · 省 2）", busReuseTasks()],
    ["压力14节点（14 枚宽 fan-in）", g45StressTasks()],
  ]) {
    const declared = buildGraphWithPipelines(tasks).edges;
    const { kept, dropped } = transitiveReduce(declared);
    assert.ok(dropped.length > 0, `${label} 空转守卫：夹具确有省略边（无省略的夹具两侧同值，不构成对本不等式的度量）`);
    const before = planWithEdges(tasks, "board", declared);
    const after = planWithEdges(tasks, "board", kept);
    assert.ok(after.grid.width <= before.grid.width, `${label}：width 单调不增 —— 约简后 ${after.grid.width} ≤ 约简前 ${before.grid.width}`);
    assert.ok(after.grid.height <= before.grid.height, `${label}：height 单调不增 —— 约简后 ${after.grid.height} ≤ 约简前 ${before.grid.height}`);
    // 只紧不松的对照面：降的是**通道宽 / 带高**，不是列数与行距（约简不得塌层）
    assert.equal(after.grid.cols, before.grid.cols, `${label}：列数不变（约简不塌层 ⇒ 降幅不得来自少列）`);
    assert.equal(after.grid.rows, before.grid.rows, `${label}：行数不变`);
    assert.deepEqual([...after.grid.rowY], [...before.grid.rowY], `${label}：行 y 线逐枚不变`);
    assert.deepEqual(
      after.grid.cells.map((c) => [c.taskId, c.col, c.row]),
      before.grid.cells.map((c) => [c.taskId, c.col, c.row]),
      `${label}：格位归属不变（同一节点仍在同一列同一行）`,
    );
    assert.ok(after.longCount <= before.longCount, `${label}：回灌给 lane 预算的长边枚数不增（${before.longCount} → ${after.longCount}）`);
    after.grid.gapW.forEach((w, i) => {
      assert.ok(w <= before.grid.gapW[i], `${label}：通道 ${i} 宽不增（${before.grid.gapW[i]} → ${w}）`);
    });
    assert.ok(after.grid.busLanes.length <= before.grid.busLanes.length, `${label}：通道带 lane 枚数不增`);
    if (after.grid.width < before.grid.width || after.grid.height < before.grid.height) strict += 1;
  }
  assert.ok(strict >= 1, `非退化守卫：至少一枚夹具确有下降（三枚全取等号 ⇒ 本锚退化成恒等式，实得 ${strict} 枚有降幅）`);

  // 渲染侧实际下发的盒模 === **kept 驱动**的那一枚网格（若渲染层被误接回声明原边集，在此分叉）
  const tasks = sample076bbb84();
  const { html } = renderDependencyGraphSection(tasks);
  const decl = planWithEdges(tasks, "board", buildGraphWithPipelines(tasks).edges);
  const red = planWithEdges(tasks, "board", transitiveReduce(buildGraphWithPipelines(tasks).edges).kept);
  assert.ok(red.grid.width < decl.grid.width, "样本夹具确有宽降幅（否则下面那条同源断言两侧同值、测不出翻向）");
  assert.ok(red.grid.height < decl.grid.height, "样本夹具确有高降幅");
  assert.deepEqual(renderedGridBox(html), [{ width: red.grid.width, height: red.grid.height }], "区块盒模 = 约简后网格（五消费点同一份 kept 的几何那一枚）");

  // ---- v0.10.6 C2/C4 重指向（改造文档 §2.5 R4「画布尺寸膨胀 ⇒ 尺寸单调钉 N3对锚④ 重指向」）----
  // 自 C2 起「框高」只是画布高的**加数** ⇒ 本锚的度量面须同时抬到画布盒：
  // 约简若真缩了框高，画布高（= Σ框高 + Σ框间带高 + 2·画布内缘）**必须同向不增**，否则降幅停在框内、画布白占位。
  const pipes = buildGraphWithPipelines(tasks).pipelines;
  assert.equal(pipes.length, 1, "本夹具为单框 ⇒ 画布尺寸不含框间带项（只加 gutter/内缘，可逐字取等）");
  const beforeCanvas = canvasLayout(pipes, [decl.grid]);
  const afterCanvas = canvasLayout(pipes, [red.grid]);
  assert.ok(afterCanvas.height <= beforeCanvas.height, `画布高单调不增 —— 约简后 ${afterCanvas.height} ≤ 约简前 ${beforeCanvas.height}`);
  assert.ok(afterCanvas.width <= beforeCanvas.width, `画布宽单调不增 —— 约简后 ${afterCanvas.width} ≤ 约简前 ${beforeCanvas.width}`);

  // 框内缘式（§2.2-C2 出参定义）：**画布尺寸是框尺寸的机械加数**，不是第二份自由几何
  const f = afterCanvas.frameOf.get("board");
  assert.ok(f !== undefined, "单框画布含 board 框");
  assert.equal(f.frameW, red.grid.width + 2 * (DG_FRAME_BORDER + DG_FRAME_PAD), `框外宽 = 网格宽 + 2·(边框 ${DG_FRAME_BORDER} + 内缘 ${DG_FRAME_PAD})`);
  assert.equal(
    f.frameH,
    red.grid.height + 2 * DG_FRAME_BORDER + DG_FRAME_TITLE_H + DG_FRAME_PAD,
    `框外高 = 网格高 + 2·边框 ${DG_FRAME_BORDER} + 标题带 ${DG_FRAME_TITLE_H} + 下内缘 ${DG_FRAME_PAD}（标题带只在上、不在下 ⇒ 非对称加数）`,
  );
  assert.equal(afterCanvas.width, f.frameW + 2 * DG_CANVAS_GUTTER, `画布宽 = 框宽 + 左右两枚 gutter ${DG_CANVAS_GUTTER}（回流档走的就是这两枚）`);
  assert.equal(afterCanvas.height, f.frameH + 2 * DG_CANVAS_PAD, `画布高 = 框高 + 上下两枚画布内缘 ${DG_CANVAS_PAD}（单框 ⇒ 无框间带项）`);

  // 画布级同源：渲染 HTML 里 `.dg-canvas` 的 inline width/height === **kept 驱动**的那次 canvasLayout
  const cv = /<div class="dg-canvas" style="width:(\d+)px;height:(\d+)px;/.exec(html);
  assert.ok(cv !== null, "画布 inline 前两枚声明 = width/height（§2.2.1 三档几何字面之首档，逐字可解析）");
  assert.deepEqual(
    [Number(cv[1]), Number(cv[2])],
    [afterCanvas.width, afterCanvas.height],
    "画布盒模 = 约简后网格经 canvasLayout 的推面值（渲染层若自算一份尺寸，在此分叉）",
  );
});

test("N3不翻向确认：走线族三处载体仍吃声明原边集（约简只发生在 section 层，路由器入参照旧）", () => {
  const declared = buildGraphWithPipelines(sample076bbb84()).edges;
  const { kept } = transitiveReduce(declared);
  assert.notEqual(kept.length, declared.length, "夹具前提：样本确有省略（否则两面同集、本条测不到分野）");
  const grid = planWithEdges(sample076bbb84(), "board", declared).grid;
  // 三族共用的载体读数 = 声明集长边 3 枚；约简集只有 1 枚 ⇒ 一旦有人把入参翻成 kept，此条先红
  const longsOf = (edges) => routeIntraEdges(edges, grid).filter((e) => e.kind === "long").map((e) => `${e.from}→${e.to}`);
  assert.deepEqual(longsOf(declared), ["n1→n6", "n2→n6", "n5→n6"], "声明原边集 = 3 枚长边（G3/G4/G5 的载体断言基线）");
  assert.deepEqual(longsOf(kept), ["n5→n6"], "约简集 = 1 枚长边（两面读数**必须**不同 ⇒ 本条是分野钉，不是重复钉）");
  assert.deepEqual(
    g3Sample().routes.filter((e) => e.kind === "long").map((e) => `${e.from}→${e.to}`),
    longsOf(declared),
    "G3 夹具 `g3Sample()` 的入参 = `routeIntraEdges(graph.edges, …)`（声明集，未翻向）",
  );
  assert.deepEqual(
    g45Layout(sample076bbb84()).routes.filter((e) => e.kind === "long").map((e) => `${e.from}→${e.to}`),
    longsOf(declared),
    "G4/G5 夹具 `g45Layout()` 的入参 = 声明集（未翻向 ⇒「≥2 条长边」的反例载体不缩）",
  );
  // 并存不冲突：画布面（渲染层，吃 kept）长边 1 枚 vs 走线族（入参面，吃声明集）长边 ≥2 枚 —— 两个面各钉各的
  // v0.10.6 C4 / S1 措辞订正（n14 收口）：渲染层取数面已由「区块（框）面」上收为「画布面」，分野语义不变
  const canvasFace = renderedEdges(renderDependencyGraphSection(sample076bbb84()).html);
  assert.equal(canvasFace.filter((e) => e.isLong).length, 1, "画布面长边枚数 = 1（N2对锚① 口径，与上面两面并存）");
  assert.ok(g45Layout(sample076bbb84()).routes.filter((e) => e.kind === "long").length >= 2, "走线族载体断言「≥2 条长边」仍在场（未被区块面的 1 枚带跑）");
});

// ---------------------------------------------------------------------------
// F1稳定性钉（v0.10.6 · 依赖图编号漂移 · 改造文档 §4 新增锚①）：
// 用户需求定义 = 「已在跑的节点号，不得因为排队 / 认领时刻的变化而漂移」。编号键抬为
// `createdAt`（登记时刻）后 ⇒ 同一 `taskId` 集合的号，在 `queuedAt` 由 `null` → 实值、
// 再动 `claimedAt` 的**三轮前后逐键全等**（渲染层 chip 的可见 `#n` 与单点 map 同源）。
// 夹具刻意让 `queuedAt` 序 **≠** `createdAt` 序 ⇒ 比较器若改回 `queuedAt`，本条先红（自证）。
// ---------------------------------------------------------------------------

/** 登记序固定的四枚节点（`createdAt` 升序 = a<b<c<d）；三轮只动排队 / 认领两枚时刻。 */
const F1_FIX = [
  { taskId: "t-a", createdAt: "2026-10-12T00:00:01Z", dependencies: [] },
  { taskId: "t-b", createdAt: "2026-10-12T00:00:02Z", dependencies: ["t-a"] },
  { taskId: "t-c", createdAt: "2026-10-12T00:00:03Z", dependencies: ["t-a"] },
  { taskId: "t-d", createdAt: "2026-10-12T00:00:04Z", dependencies: ["t-b", "t-c"] },
];

/** 一轮 = 同一批 taskId、同一登记序，只把 `queuedAt` / `claimedAt` 换成给定的两张表。 */
const f1Round = (queuedAt, claimedAt) =>
  F1_FIX.map(({ taskId, createdAt, dependencies }) =>
    task(taskId, "completed", dependencies, {
      projectId: "p",
      createdAt,
      queuedAt: queuedAt[taskId],
      claimedAt: claimedAt[taskId],
    }),
  );

/** `taskId → 号` 的稳定读数（按 taskId 排序成串 ⇒ 比较不受插入序影响，只比号本身）。 */
const f1Numbers = (map) =>
  [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([taskId, ordinal]) => `${taskId}=#${String(ordinal)}`);

/** 渲染层 chip 的可见编号（`title` 首段 = 全量 taskId，夹具 id 干净 ⇒ 无转义歧义）。 */
function f1ChipNumbers(html) {
  const out = new Map();
  for (const m of html.matchAll(/title="([^"]*)">#(\d+)<\/span>/g)) {
    out.set(m[1].split(" · ")[0], Number(m[2]));
  }
  assert.equal(out.size, F1_FIX.length, `渲染层须出满 ${F1_FIX.length} 枚编号 chip（实得 ${out.size} 枚 ⇒ 取数落空即判红）`);
  return f1Numbers(out);
}

test("F1稳定性钉：createdAt 不变 ⇒ queuedAt（null→实值）与 claimedAt（再变动）三轮前后，编号逐键全等（渲染层 #n 同源）", () => {
  // 三轮的入队 / 认领时刻表（逐轮显式给全四枚，缺项即 null）
  const NONE = { "t-a": null, "t-b": null, "t-c": null, "t-d": null };
  const Q_REVERSED = { "t-a": "2026-10-12T00:10:04Z", "t-b": "2026-10-12T00:10:03Z", "t-c": "2026-10-12T00:10:02Z", "t-d": "2026-10-12T00:10:01Z" };
  const C_SHUFFLED = { "t-a": "2026-10-12T00:20:01Z", "t-b": "2026-10-12T00:20:04Z", "t-c": "2026-10-12T00:20:02Z", "t-d": "2026-10-12T00:20:03Z" };
  const three = [
    ["R1 刚登记（queuedAt / claimedAt 皆缺）", f1Round(NONE, NONE)],
    ["R2 已入队（queuedAt 补齐，序与 createdAt **相反**）", f1Round(Q_REVERSED, NONE)],
    ["R3 已认领（claimedAt 再乱序动一次）", f1Round(Q_REVERSED, C_SHUFFLED)],
  ];

  // 空转守卫：夹具的 queuedAt 升序确实 ≠ createdAt 升序 ⇒ 「三轮相等」不是两侧同键的恒等式
  assert.deepEqual(
    Object.keys(Q_REVERSED).sort((a, b) => (Q_REVERSED[a] < Q_REVERSED[b] ? -1 : 1)),
    ["t-d", "t-c", "t-b", "t-a"],
    "queuedAt 序 = 与登记序完全相反（改回以 queuedAt 为键 ⇒ 下面两条必红，本条不红 ⇒ 夹具确有度量力）",
  );

  const want = ["t-a=#1", "t-b=#2", "t-c=#3", "t-d=#4"];
  for (const [label, tasks] of three) {
    assert.deepEqual(f1Numbers(taskOrdinalMap(tasks)), want, `${label}：单点 map 的号 = 登记序（queuedAt / claimedAt 不参与）`);
    assert.deepEqual(f1ChipNumbers(renderDependencyGraphSection(tasks).html), want, `${label}：渲染层可见 #n 与单点 map 同源同值`);
  }
  const ords = three.map(([, tasks]) => f1Numbers(taskOrdinalMap(tasks)));
  assert.deepEqual(ords[0], ords[1], "R1 → R2（queuedAt null → 实值）逐键全等");
  assert.deepEqual(ords[1], ords[2], "R2 → R3（claimedAt 变动）逐键全等");
});

// ---------------------------------------------------------------------------
// D-① / D-②（v0.10.6 · REQ-2026-10-12-06 n12 · 改造文档 §4.4「新增 3 条」前两枚）：
// 等价强度钉，替代旧设想「区块内 `details` 枚数 ∈ {0,1}」—— ⑦(ii) 保留逐框折叠后每个框都是
// 一枚 `<details class="pipe" open>` ⇒ 枚数恒为 N，只能钉**等式**与**出现层**。纯字符串断言、零 DOM。
// ---------------------------------------------------------------------------

/** 同时逼出 hint warn 行（悬空边）与跨管道边清单行的夹具 —— D-② 的两枚命名区段都得真在场。 */
const d2WarnAndCrossTasks = () => [
  task("d2-a", "completed", [], { projectId: "p1", queuedAt: "2026-10-12T00:00:01Z" }),
  task("d2-b", "completed", ["d2-a", "d2-external"], { projectId: "p2", queuedAt: "2026-10-12T00:00:02Z" }),
];

test("D-①（v0.10.6 等式钉）`<details` 枚数 === `.pipe open` 枚数 === `<summary>` 枚数 === 管道枚数（任一框丢 .pipe / 画布外多出 details 立刻判红）", () => {
  for (const [label, tasks, wantPipes] of [
    ["pipe6（3 管道 · 5 边）", pipe6Tasks(), 3],
    ["样本076bbb84（单管道 · 10 边）", sample076bbb84(), 1],
    ["跨管道同集（3 管道 · 约简 1）", crossReduceTasks(), 3],
    ["单任务（1 管道 · 零边 ⇒ 零 path 也不脱钉）", [task("task-aaaaaaaa", "blocked")], 1],
  ]) {
    const { html } = renderDependencyGraphSection(tasks);
    const pipes = groupPipelines(buildTaskGraph(tasks), taskOrdinalMap(tasks)).length;
    assert.equal(pipes, wantPipes, `${label}：夹具确有 ${wantPipes} 枚管道（本钉的空转守卫，0 枚则三面同数为恒等式）`);
    const details = (html.match(/<details/g) ?? []).length;
    const pipeOpen = (html.match(/<details class="pipe" open[> ]/g) ?? []).length;
    const summaries = (html.match(/<summary>/g) ?? []).length;
    assert.equal(details, pipeOpen, `${label}：每一枚 <details 都必须带 class="pipe" open ⇒「丢 .pipe 类」由构造钉死`);
    assert.equal(pipeOpen, summaries, `${label}：每枚框壳恰一枚 <summary>（多一枚 = 框层之外冒出 details/summary）`);
    assert.equal(summaries, pipes, `${label}：details / .pipe open / summary 三数 === 管道枚数（逐字等式）`);
  }
});

test("D-②（v0.10.6 切片钉）`.dep-graph` 容器起点之外的区段零 `<details` ⇒ 框层是区块内 details 的唯一出现层", () => {
  for (const [label, tasks, wantWarn, wantCross] of [
    ["pipe6（无提示行 · 有跨框边清单）", pipe6Tasks(), false, true],
    ["样本076bbb84（单管道 ⇒ 两区段皆无）", sample076bbb84(), false, false],
    ["hint warn + 跨框边清单同时在场", d2WarnAndCrossTasks(), true, true],
    ["单任务（零边 ⇒ 切片内仍有一枚框）", [task("task-aaaaaaaa", "blocked")], false, false],
  ]) {
    const { html } = renderDependencyGraphSection(tasks);
    const at = html.indexOf('<div class="dep-graph">');
    assert.notEqual(at, -1, `${label}：容器起点摘不到 ⇒ 本钉空转，判红`);
    const outside = html.slice(0, at);
    assert.equal(outside.includes("<details"), false, `${label}：dep-graph 之前（h2 / 图例行 / hint warn）不得出 <details`);
    assert.equal(
      outside.includes('<p class="hint warn">'),
      wantWarn,
      `${label}：hint warn 行按夹具现态在场（切片覆盖面不空转）`,
    );
    const crossRow = /<p class="hint dg-edges">[\s\S]*?<\/p>/.exec(html);
    assert.equal(crossRow !== null, wantCross, `${label}：跨管道边清单行按夹具现态在场`);
    if (crossRow !== null) {
      assert.equal(crossRow[0].includes("<details"), false, `${label}：跨管道边清单行自身不得夹带 <details`);
    }
    assert.ok(html.slice(at).includes("<details"), `${label}：切片之内确有 <details（负钉不许靠「什么都没画」通过）`);
  }
});

// ---------------------------------------------------------------------------
// G13 真板夹具（REQ-2026-10-14-02 · 增补 n1）
// 任务集来自真板 Feature `eb86d5e8` 的依赖图导出裁剪集（零合成 —— 本节点只落盘，
// 不增删改任何字段值）；后续节点（画布级 I1′ / 回灌不动点 / 叠线反例）在此集上取证。
// ---------------------------------------------------------------------------

const REAL_FIXTURE = new URL("fixtures/eb86d5e8-tasks.json", import.meta.url);

/** 整份夹具（含 `_meta` 自校三数）。 */
const realFixture = () => JSON.parse(readFileSync(REAL_FIXTURE, "utf8"));

/** 真板任务集（`_meta` 是夹具自校数，不进任务集）。 */
const realTasks = () => realFixture().tasks;

test("G13-夹具①：真板集可读入且三数自洽", () => {
  const { _meta } = realFixture();
  const tasks = realTasks();
  assert.equal(_meta.frameCount >= 3, true, "夹具必须跨框（≥3 枚管道）⇒ 否则 crossEdges 恒空，本卡作用域缺口照旧复现不出");
  assert.equal(tasks.length, _meta.nodeCount, "节点数自洽：tasks.length === _meta.nodeCount");
  assert.equal(
    tasks.reduce((sum, t) => sum + t.dependencies.length, 0),
    _meta.edgeCount,
    "边数自洽：Σ dependencies.length === _meta.edgeCount（声明边，未约简）",
  );
  assert.equal(new Set(tasks.map((t) => t.projectId)).size, _meta.frameCount, "框数自洽：去重 projectId 数 === _meta.frameCount");
  const ids = new Set(tasks.map((t) => t.taskId));
  assert.equal(ids.size, tasks.length, "taskId 两两不同（重复 id ⇒ 取数面出现第二份节点集，夹具自校数失去意义）");
  assert.deepEqual(
    tasks.flatMap((t) => t.dependencies.filter((dep) => !ids.has(dep)).map((dep) => `${t.taskId} → ${dep}`)),
    [],
    "无悬空依赖 id：每个 dependencies 元素都在本任务集内（悬空 ⇒ buildTaskGraph 丢边，夹具退化成少边集）",
  );
});

// ---------------------------------------------------------------------------
// G11 跨框夹具五形（REQ-2026-10-14-02 · 增补 n3 · 改造文档 §6 第二枚增补「锚账」ANCHOR-2）
// **作用域缺口①** = 现三夹具（样本076bbb84 / 压力14节点 / busReuse）全单 project ⇒ `crossEdges` 恒空
// ⇒ 跨框档在旧锚面上从未被取到（本卡的穿模 / 叠线正落在这一档）。本块只落**合成五形 + 结构钉**：
// 每形钉 `frames` 枚数、`crossEdges` 枚数、同框归属、框序（= projectId 升序）、逐枚边的框跨度 |tIdx − sIdx|。
// **本枚不写任何穿模 / 叠线几何判据** —— 画布级 I1′ 归 n4、回灌不动点与容量不等式归 n8；
// 场景表行号与统一律 `2k+3` 的**段数期望**（b/c ⇒ 5 段 · d/e ⇒ 7 段 · g ⇒ 兜底 9 段）只随 label 登记在此，
// 由 n4 / n8 在同一批夹具上取证。
// ---------------------------------------------------------------------------

/** 画布框序 = projectId 升序（`groupPipelines` 出参序 === `canvasLayout.frames` 序，框纵向堆叠）。 */
const CANVAS_FRAMES = ["board", "flow", "orch"];

/** 外缘竖跨硬容量 = `ML` 2 席 + `MR` 2 席（改造文档 §6 第二枚增补 X3；i7 取等边界 = **严格 >**）。 */
const OUTER_LANE_CAPACITY = 4;

/** 五形共用的行构造器：`[taskId, projectId, deps]` → 任务对象（登记序 = 表内行序 ⇒ 号序自洽）。 */
const canvasRow = ([taskId, projectId, deps], i) =>
  task(taskId, "completed", deps, { projectId, queuedAt: `2026-10-14T00:03:${String(i + 1).padStart(2, "0")}Z` });

/**
 * 一枚任务集 → **画布框结构账**（纯结构、零几何）。分席判据与渲染层同源：先全图约简
 * （`transitiveReduce`），再按 kept 两端 `projectId` 是否同框分成 `crossEdges` / `intraEdges`
 * （= `renderDependencyGraphSection` 的跨管道边取数面）。
 * 定序 =（源框序 → 目标框序 → from → to）⇒ 出参与入参数组序无关，`spans` 可逐位对账。
 */
function canvasFrameLedger(tasks) {
  const graph = buildTaskGraph(tasks);
  const ordinals = taskOrdinalMap(tasks);
  const frames = groupPipelines(graph, ordinals).map((p) => p.projectId);
  const frameIdx = new Map(frames.map((projectId, i) => [projectId, i]));
  const projectOf = new Map(graph.nodes.map((n) => [n.taskId, n.projectId]));
  const { kept, dropped } = transitiveReduce(graph.edges);
  const rows = kept.map((e) => {
    const fromProject = projectOf.get(e.from);
    const toProject = projectOf.get(e.to);
    const sIdx = frameIdx.get(fromProject);
    const tIdx = frameIdx.get(toProject);
    return { from: e.from, to: e.to, fromProject, toProject, sIdx, tIdx, span: Math.abs(tIdx - sIdx) };
  });
  const byOrder = (a, b) =>
    a.sIdx - b.sIdx || a.tIdx - b.tIdx || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0);
  return {
    graph,
    frames,
    kept: kept.length,
    dropped: dropped.length,
    crossEdges: rows.filter((r) => r.fromProject !== r.toProject).sort(byOrder),
    intraEdges: rows.filter((r) => r.fromProject === r.toProject).sort(byOrder),
  };
}

/** 边 → 可读字面（`from:源框→to:目标框`），供逐条对账。 */
const crossEdgeTexts = (edges) => edges.map((e) => `${e.from}:${e.sIdx}→${e.to}:${e.tIdx}`);

/**
 * 一枚框在画布里的**列账**（与渲染层同一条驱动：构图 → kept 层号 → 压列 → 网格）。
 * 本块只读 `cols` / `gapW` 两枚（= g 档「腿有没有列间通道可用」的结构前提），不读任何坐标。
 */
function canvasPipeColumns(tasks, projectId) {
  const graph = buildGraphWithPipelines(tasks);
  const { kept } = transitiveReduce(graph.edges);
  const ordinals = taskOrdinalMap(tasks);
  const layers = layerOfGraph(graph.nodes, ordinals, kept);
  const pipe = graph.pipelines.find((p) => p.projectId === projectId);
  assert.ok(pipe !== undefined, `夹具须含 ${projectId} 管道`);
  return pipeGridLayout(pipe, compressPipeLayers(pipe, layers), ordinals);
}

/** F1 相邻正向（场景表 b · k=1 ⇒ 2k+3 = 5 段）：board → flow → orch 逐框向前。 */
const f1AdjacentForward = () => [["f1a", "board", []], ["f1b", "flow", ["f1a"]], ["f1c", "orch", ["f1b"]]].map(canvasRow);

/** F2 相邻回流（场景表 c · k=1 ⇒ 5 段）：同一串边逐框向回走（目标框在源上方）。 */
const f2AdjacentBackflow = () => [["f2a", "orch", []], ["f2b", "flow", ["f2a"]], ["f2c", "board", ["f2b"]]].map(canvasRow);

/** F3 跨 3 框正向（场景表 d · k=2 ⇒ 7 段）：board 直跳 orch，中间框 flow 自带一枚同框边。 */
const f3SpanTwoForward = () =>
  [["f3a", "board", []], ["f3b", "orch", ["f3a"]], ["f3c", "flow", []], ["f3d", "flow", ["f3c"]]].map(canvasRow);

/** F4 跨 3 框回流（场景表 e · k=2 ⇒ 7 段）：同源扇出两枚边 = i4 合法共端点（真板 `eb86d5e8` 一族形态）。 */
const f4SpanTwoBackflow = () => [["f4a", "orch", []], ["f4b", "board", ["f4a"]], ["f4c", "flow", ["f4a"]]].map(canvasRow);

/** F5-超载（场景表 h）：一枚源扇出三框对 + 两枚单边源 ⇒ 五枚回流边同时挤同一枚外缘通道（5 > 4 席）。 */
const f5OuterOverload = () =>
  [
    ["f5o1", "orch", []],
    ["f5o2", "orch", []],
    ["f5o3", "orch", []],
    ["f5m1", "flow", []],
    ["f5b1", "board", ["f5o1"]],
    ["f5b2", "board", ["f5o1"]],
    ["f5b3", "board", ["f5o1", "f5o2", "f5o3"]],
  ].map(canvasRow);

/** F5-单列框（场景表 g）：中间框 flow 只有两枚互不依赖的节点 ⇒ 一列 ⇒ 腿无列间通道可用（`CH → PL/PR`）。 */
const f5SingleColumnFrame = () =>
  [["f5s1", "board", []], ["f5s2", "orch", ["f5s1"]], ["f5m1", "flow", []], ["f5m2", "flow", []]].map(canvasRow);

/**
 * 五形（F1..F5 · F5 含两形 ⇒ 六枚条目）。`pins` = 本枚要钉的结构读数（渲染层同一取数面的期望）。
 * `spans` 与 `crossEdges` 同序（定序式见 {@link canvasFrameLedger}）⇒ 跨度与边集逐位对账。
 */
const canvasFixtures = () => [
  {
    key: "F1",
    label: "F1 相邻正向（场景表 b · k=1 ⇒ 5 段）",
    tasks: f1AdjacentForward(),
    pins: { frames: 3, cross: 2, intra: 0, dropped: 0, spans: [1, 1], forward: 2, backflow: 0 },
  },
  {
    key: "F2",
    label: "F2 相邻回流（场景表 c · k=1 ⇒ 5 段）",
    tasks: f2AdjacentBackflow(),
    pins: { frames: 3, cross: 2, intra: 0, dropped: 0, spans: [1, 1], forward: 0, backflow: 2 },
  },
  {
    key: "F3",
    label: "F3 跨 3 框正向（场景表 d · k=2 ⇒ 7 段）",
    tasks: f3SpanTwoForward(),
    pins: { frames: 3, cross: 1, intra: 1, dropped: 0, spans: [2], forward: 1, backflow: 0 },
  },
  {
    key: "F4",
    label: "F4 跨 3 框回流（场景表 e · k=2 ⇒ 7 段 · 同源扇出两枚边）",
    tasks: f4SpanTwoBackflow(),
    pins: { frames: 3, cross: 2, intra: 0, dropped: 0, spans: [2, 1], forward: 0, backflow: 2 },
  },
  {
    key: "F5a",
    label: "F5 超载形（场景表 h · 外缘并发 > 4 席）",
    tasks: f5OuterOverload(),
    pins: { frames: 3, cross: 5, intra: 0, dropped: 0, spans: [2, 2, 2, 2, 2], forward: 0, backflow: 5 },
  },
  {
    key: "F5b",
    label: "F5 单列框形（场景表 g · 中间框只有一列）",
    tasks: f5SingleColumnFrame(),
    pins: { frames: 3, cross: 1, intra: 0, dropped: 0, spans: [2], forward: 1, backflow: 0 },
  },
];

test("G11-夹具①五形结构钉：frames 枚数 / crossEdges 枚数 / 同框归属 / 框序 = projectId 升序 / 跨度逐枚对账（本枚零几何）", () => {
  const shapes = canvasFixtures();
  assert.equal(shapes.length, 6, "五形 = 六枚条目（F1..F4 各一形 + F5 两形〔超载 / 单列框〕）");
  let fanOutCarriers = 0;
  let intraCarriers = 0;
  for (const { label, tasks, pins } of shapes) {
    const led = canvasFrameLedger(tasks);
    const { frames, crossEdges, intraEdges } = led;
    // 前提面：零环、零悬空（成环 / 悬空 ⇒ kept 边集缩水，下面的枚数钉会退化成少边集）
    assert.deepEqual(led.graph.cycleEdges, [], `${label}：无成环依赖边`);
    assert.deepEqual(
      led.graph.dangling.map((e) => `${e.taskId} → ${e.dep}`),
      [],
      `${label}：无悬空依赖（悬空 ⇒ 该边不入图，枚数钉失真）`,
    );
    // 框数与框序：去重 projectId 数 === pins.frames，且画布框序 = projectId 升序
    assert.deepEqual([...new Set(tasks.map((t) => t.projectId))].sort(), frames, `${label}：frames === 去重 projectId 升序`);
    assert.deepEqual(frames, CANVAS_FRAMES, `${label}：框序 = projectId 升序（board→flow→orch，纵向堆叠）`);
    assert.equal(frames.length, pins.frames, `${label}：frames 枚数 === ${pins.frames}（真跨框须 ≥3 枚框）`);
    assert.ok(pins.frames >= 3, `${label}：本卡夹具的立身前提 = 至少 3 枚框（单框 ⇒ 跨框档结构上不可达）`);
    // 枚数与分席：cross + intra === kept，且无省略边（约简不改跨框集 ⇒ n4/n8 取证时两面同数）
    assert.equal(crossEdges.length, pins.cross, `${label}：crossEdges 枚数 === ${pins.cross}`);
    assert.equal(intraEdges.length, pins.intra, `${label}：同框边（intra）枚数 === ${pins.intra}`);
    assert.equal(crossEdges.length + intraEdges.length, led.kept, `${label}：两分席恰覆盖 kept（不重不漏）`);
    assert.equal(led.dropped, pins.dropped, `${label}：传递省略 0 枚 ⇒ 约简前后跨框集恒等（结构钉不随约简漂移）`);
    // 判据①：每枚 cross 边两端异框且 |tIdx − sIdx| ≥ 1；跨度逐位对账
    for (const e of crossEdges) {
      assert.notEqual(e.fromProject, e.toProject, `${label}：cross 边两端必须异框（${e.from}→${e.to}）`);
      assert.ok(e.span >= 1, `${label}：cross 边 |tIdx − sIdx| ≥ 1（实得 ${e.span}）`);
      // 同框归属：边的两端各自落在「自己 project 的那一框」，框序下标由 frames 派生
      assert.equal(frames[e.sIdx], e.fromProject, `${label}：源端归属 = frames[${e.sIdx}] === ${e.fromProject}`);
      assert.equal(frames[e.tIdx], e.toProject, `${label}：目标端归属 = frames[${e.tIdx}] === ${e.toProject}`);
      const src = tasks.find((t) => t.taskId === e.from);
      const dst = tasks.find((t) => t.taskId === e.to);
      assert.equal(src.projectId, e.fromProject, `${label}：源任务 ${e.from} 的 projectId === 边上报的 fromProject`);
      assert.equal(dst.projectId, e.toProject, `${label}：目标任务 ${e.to} 的 projectId === 边上报的 toProject`);
    }
    assert.deepEqual(crossEdges.map((e) => e.span), pins.spans, `${label}：跨度序列逐位对账（${crossEdgeTexts(crossEdges).join(" ")}）`);
    // 判据②：正向档（tIdx > sIdx）与回流档（tIdx < sIdx）各自的枚数 === 期望
    const forward = crossEdges.filter((e) => e.tIdx > e.sIdx).length;
    const backflow = crossEdges.filter((e) => e.tIdx < e.sIdx).length;
    assert.deepEqual([forward, backflow], [pins.forward, pins.backflow], `${label}：正向 / 回流两档的枚数对账`);
    assert.equal(forward + backflow, pins.cross, `${label}：跨框边只此两档（回流判据 = 框序，不含 i1 的「chip 在左」几何半句）`);
    // 同框边的负向面：同框边一律不在 crossEdges 里（否则跨框判据退化）
    assert.deepEqual(
      crossEdges.filter((e) => intraEdges.some((x) => x.from === e.from && x.to === e.to)).map((e) => `${e.from}→${e.to}`),
      [],
      `${label}：同框边不得混入 crossEdges`,
    );
    if (pins.intra > 0) intraCarriers += 1;
    // i4 合法共端点：同源扇出 = 两枚 cross 边共用同一个源 taskId
    const bySource = new Map();
    for (const e of crossEdges) bySource.set(e.from, [...(bySource.get(e.from) ?? []), e.to]);
    const fan = [...bySource.entries()].filter(([, tos]) => tos.length >= 2);
    if (fan.length > 0) {
      fanOutCarriers += 1;
      assert.equal(fan.length, 1, `${label}：扇出源恰一枚（多枚 ⇒ 本枚形态越界）`);
      assert.ok(fan[0][1].every((to) => to !== fan[0][0]), `${label}：共端点合法（源 ≠ 各目标）`);
    }
    // 框序在渲染层同源：区块 HTML 的 `<summary>管道 X（` 出现序 === frames 升序（只钉序与枚数，不钉坐标）
    const rendered = [...renderDependencyGraphSection(tasks).html.matchAll(/<summary>管道 ([^（]+)（/g)].map((m) => m[1].trim());
    assert.deepEqual(rendered, frames, `${label}：渲染层框序（summary 出现序）=== 模型侧 frames`);
  }
  // 判据①的另一侧 + 空转守卫
  for (const { label, pins } of shapes.filter((s) => !s.key.startsWith("F5"))) {
    assert.ok(pins.cross >= 1, `${label}：F1..F4 每形至少一枚跨框边（本卡作用域缺口的被测对象，0 枚即夹具退化）`);
  }
  for (const { label, pins } of shapes.filter((s) => s.key === "F3" || s.key === "F4")) {
    assert.ok(pins.spans.some((n) => n === 2), `${label}：至少一枚 |tIdx − sIdx| === 2（k=2 ⇒ 7 段档的载体）`);
  }
  for (const { label, pins } of shapes.filter((s) => s.key === "F2" || s.key === "F4")) {
    assert.ok(pins.backflow >= 1, `${label}：回流档确有覆盖（至少一枚 tIdx < sIdx）`);
  }
  assert.ok(intraCarriers >= 1, "空转正钉：至少一形含同框边 ⇒「同框边不入 crossEdges」不是恒空断言");
  assert.ok(fanOutCarriers >= 1, "空转正钉：至少一形含同源扇出 ⇒ i4「合法共端点」有实测载体");
});

test("G11-夹具②F5 两形各自触发对应降档前提：外缘并发严格 > 4 席（i7）· 中间框列数 = 1 ⇒ 无列间通道（g 档）", () => {
  const shapes = canvasFixtures();
  // ---- 超载形（场景表 h）：外缘竖跨的并发需求 > 硬容量 ----
  const over = shapes.find((s) => s.key === "F5a");
  assert.ok(over !== undefined, "五形须含超载形（F5a）");
  const overLed = canvasFrameLedger(over.tasks);
  assert.equal(
    overLed.crossEdges.length,
    over.pins.backflow,
    "超载形的前提 = 全部跨框边都走外缘（同一路向：目标框在源框之上 ⇒ 回流档）⇒ 并发数即跨框边数",
  );
  const sameFramePair = new Set(overLed.crossEdges.map((e) => `${e.fromProject}>${e.toProject}`));
  assert.deepEqual([...sameFramePair], ["orch>board"], "超载形的回流边同一框对（同一枚外缘通道的分席键 ⇒ 并发才叠得起来）");
  assert.equal(overLed.crossEdges.length > OUTER_LANE_CAPACITY, true, `外缘并发 ${overLed.crossEdges.length} 席 **严格 >** 硬容量 ${OUTER_LANE_CAPACITY} 席（取等不算超载，i7）`);
  // 需求侧的规模自证：拿 4 席去量则夹具退化（本形要测的是「超出去」那一部分）
  assert.equal(overLed.crossEdges.length - OUTER_LANE_CAPACITY, 1, "超出量 = 1 席（n8 的容量不等式与超载登记据此取证，本枚不判观感）");

  // ---- 单列框形（场景表 g）：被跨越的那枚中间框只有一列 ⇒ 无 `CH` 可用 ----
  const single = shapes.find((s) => s.key === "F5b");
  assert.ok(single !== undefined, "五形须含单列框形（F5b）");
  const singleLed = canvasFrameLedger(single.tasks);
  assert.equal(singleLed.crossEdges.length, 1, "单列框形 = 一枚 k=2 边（board→orch）");
  const { sIdx, tIdx } = singleLed.crossEdges[0];
  assert.ok(sIdx < 1 && 1 < tIdx, `中间框（框序 1 = ${singleLed.frames[1]}）确实落在本边的两框之间（sIdx=${sIdx} < 1 < tIdx=${tIdx}）`);
  const midCols = canvasPipeColumns(single.tasks, singleLed.frames[1]);
  assert.equal(midCols.cells.length, 2, "空转守卫：该框确有 2 枚 cell（零 cell 的框 cols=0，不构成对「一列」的度量）");
  assert.equal(midCols.cols, 1, "单列框形的前提 = 该框只有一列（两枚互不依赖的节点同层 ⇒ 压列后一列）");
  assert.deepEqual([...new Set(midCols.cells.map((c) => c.col))], [0], "两枚 cell 同列（列号集合 = {0}）");
  assert.equal(midCols.gapW.length, midCols.cols - 1, "列间通道数 === cols − 1（`pipeGridLayout` 的通道定义式）");
  assert.equal(midCols.gapW.length, 0, "该框**无列间通道可用** ⇒ g 档降档前提（`CH → PL/PR`，兜底 9 段归 n4/n8 取证）");
  // 对照面：同一批五形里 F3 的中间框（两枚节点成链 ⇒ 两列）确有列间通道
  // ⇒ 「无通道」是 F5b 的特例而非常态，本形不是「所有框都只有一列」的恒真
  const three = shapes.find((s) => s.key === "F3");
  const threeLed = canvasFrameLedger(three.tasks);
  const threeMid = canvasPipeColumns(three.tasks, threeLed.frames[1]);
  assert.equal(threeMid.cells.length, 2, "对照形 F3 的中间框同样 2 枚 cell（与 F5b 只差依赖形状 ⇒ 对照是**同规模**的）");
  assert.equal(threeMid.cols, 2, "对照：F3 中间框两列（链式两节点分层）⇒ 通道可用");
  assert.equal(threeMid.gapW.length, 1, "对照：F3 中间框通道 1 枚 ≥ 1 ⇒ 与 F5b 的 0 枚确有分野");
});

test("G11-夹具③i6 正对照：现三夹具全单 project ⇒ crossEdges 恒 0（防新判据日后空转）", () => {
  const legacy = [
    ["样本076bbb84", sample076bbb84()],
    ["压力14节点", g45StressTasks()],
    ["busReuse", busReuseTasks()],
  ];
  assert.deepEqual(
    legacy.map(([label, tasks]) => label),
    g45Fixtures().map(([label]) => label),
    "三夹具清单与 `g45Fixtures()` 同源（本正对照管的正是那三枚）",
  );
  for (const [label, tasks] of legacy) {
    const led = canvasFrameLedger(tasks);
    assert.deepEqual(
      [...new Set(tasks.map((t) => t.projectId))],
      ["board"],
      `${label}：夹具现态 = 全单 project（board）⇒ 跨框档结构上不可达`,
    );
    assert.equal(led.frames.length, 1, `${label}：frames 枚数 === 1（单框 ⇒ 无框间带、无外缘走廊）`);
    assert.deepEqual(crossEdgeTexts(led.crossEdges), [], `${label}：crossEdges 恒空（i6 正对照的期望值）`);
    assert.ok(led.intraEdges.length >= 1, `${label}：空转正钉 —— 同框边确有 ${led.intraEdges.length} 枚 ⇒ 本条不是「无边可分」的空断言`);
    assert.ok(led.kept > 0, `${label}：kept 边集非空（否则上面两条一起退化成恒真）`);
  }
  // 两面的分野：跨框枚数在「单 project 三夹具」与「五形」上必须不同，否则新判据无度量力
  const legacyCross = legacy.reduce((sum, [, tasks]) => sum + canvasFrameLedger(tasks).crossEdges.length, 0);
  const shapeCross = canvasFixtures().reduce((sum, s) => sum + canvasFrameLedger(s.tasks).crossEdges.length, 0);
  assert.deepEqual([legacyCross, shapeCross], [0, 13], "正对照 = 0 枚跨框边，五形 = 13 枚 ⇒ 跨框档的度量只在新夹具上生效（旧锚面照旧不碰这一档）");
});

// ---------------------------------------------------------------------------
// G11-画布穿模①②③（REQ-2026-10-14-02 · 增补 n4 · 锚账 ANCHOR-1 · 改造文档 §2.3「障碍集带域化」A6 + §6 第二枚增补）
// **画布级 I1′** —— 旧 I1（`findPenetrations`）只在**单框网格**内度量，跨框边的竖直腿 / 末弧走的是
// **画布空间**（框外通道带 + 框间带 + gutter），旧锚结构性看不见 ⇒ 本卡复现的穿模正是这一档。
//
// **障碍集按 A6 带域定义（不得照字面「全体矩形」）**：
//   `O1` = 全体 chip **除本边两端**；`O2` = **非本边两端所属框**的整块矩形（含边框与标题带）。
//   理由机械可核：`2k+3` 段形的**出口 / 入口腿必然穿过自己框的边框与标题带**（入口腿就是从框间带进框），
//   照字面把本边两端所属框也计入 ⇒ **正确形态判红**（本块 ① 的「不分域 ⇒ >0」那一条就是这个反例的常驻钉）。
//
// **混合判据（不用 bbox）**：直线段 = 解析几何判交叠（H/V 与矩形边的严格内交）；弧段 = 24 点采样
//   （沿用 {@link G5_SAMPLES}）。**不得改成「弧也取 bbox」** —— 修复形末弧的 bbox 是**保守盒**
//   （它纵向跨整段 y 落差），会把正确形态一并判红（改造文档 §6 第二枚增补 ANCHOR-1「混合判据」句）。
//
// **极性钉（本枚 = 复现锚）**：②③ 写「**存在 hits**」⇒ 在**现实现**上是绿的。
//   「必为 0」的翻转在 **n7 与算法同轮**做（不拆第三枚节点 —— 否则中间存在一枚「旧码 × 新不变式」的必红节点）。
//   ① 是判据**自证**（正对照 = 正确形态不得判红），与本枚极性无关，n7 翻转后**仍然应为 0**（不得删）。
//
// **i5（折叠态无关）**：判据吃的是 **SSR 全展开形态**的 chip 全集（`O1` 枚数 === 节点数 − 2），
//   不读任何折叠状态 —— 框是固定盒（改造文档 §2.1 硬约束），折叠只让框体变空、不移动坐标系。
// ---------------------------------------------------------------------------

/**
 * 一枚任务集 → **画布空间场景**（框矩形 / chip 矩形 / 逐本质边的画布 path）。
 * 取数面 = `renderDependencyGraphSection` 出的**渲染 HTML**（与件一② / N2 对锚同一事实源）：
 * - 框矩形 = `<details class="pipe" …>` 的 inline `left/top/width/height` 四枚（S1 固定盒）；
 * - chip 矩形 = 该框子树内 cell 的**局部** `left/top` 经 {@link canvasEdgePoint} 换算（**单源**，不另存算式）；
 * - path ↔ 边对账 = 首末点与两端换算后的 `from`/`to` 侧逐点相等 ⇒ **每条本质边恰命中一枚 path**（不许多也不许少）。
 */
function canvasSceneOf(tasks) {
  const html = renderDependencyGraphSection(tasks).html;
  const canvas = /<div class="dg-canvas"[^>]*>\s*<svg class="dg-links">([\s\S]*?)<\/svg>/.exec(html);
  assert.ok(canvas !== null, "画布级边线层在场（跨框与框内 path 同池，框内不再取池）");
  const ds = edgePaths(canvas[1]).map((e) => e.d);

  const graph = buildGraphWithPipelines(tasks);
  const edges = transitiveReduce(graph.edges).kept;
  const projectByTask = new Map(graph.nodes.map((n) => [n.taskId, n.projectId]));

  /** 框序 = 渲染出现序 = projectId 升序（与 n3 `canvasFrameLedger` 同一序式）；矩形含边框与标题带。 */
  const frames = [];
  for (const chunk of html.split('<details class="pipe"').slice(1)) {
    const body = chunk.slice(0, chunk.indexOf("</details>"));
    // 属性面写成 `[^>]*` 而非逐字 `open`：本判据**不读折叠状态**（i5），固定盒几何与 `open` 有无无关
    const m = /^[^>]*style="left:(\d+)px;top:(\d+)px;width:(\d+)px;height:(\d+)px">\s*<summary>管道 ([^（]+)（/.exec(body);
    assert.ok(m !== undefined, `框 = 固定盒四枚几何字面（left/top/width/height）+ summary（实得 ${body.slice(0, 80)}…）`);
    const dx = Number(m[1]);
    const dy = Number(m[2]);
    // `dx/dy` 供 {@link canvasEdgePoint}（换算单源吃 `f.dx/f.dy`）、`rect` 供 O2 框矩形（S1 固定盒 = 外缘 + 宽深）
    frames.push({
      projectId: m[5],
      dx,
      dy,
      rect: [dx, dx + Number(m[3]), dy, dy + Number(m[4])],
      cells: renderedCells(body),
    });
    assert.ok(frames[frames.length - 1].cells.size > 0, `本框子树内确有 cell（${m[5]}）`);
  }
  const frameIdx = new Map(frames.map((f, i) => [f.projectId, i]));

  /** chip 画布矩形：左缘 x / 纵中点取自换算单源，宽高取常量 ⇒ 与走线端点同一参照系。 */
  const chips = [];
  for (const f of frames) {
    for (const [taskId, c] of f.cells) {
      const left = canvasEdgePoint(f, c, "to");
      const right = canvasEdgePoint(f, c, "from");
      assert.equal(left[1], right[1], `chip ${taskId} 左/右缘中点同 y（换算单源自洽）`);
      assert.equal(right[0] - left[0], DG_NODE_W, `chip ${taskId} 宽 === DG_NODE_W`);
      chips.push({ taskId, projectId: f.projectId, rect: [left[0], right[0], left[1] - DG_NODE_H / 2, left[1] + DG_NODE_H / 2] });
    }
  }
  // **i5 全集钉**：SSR 一次下发全部框与全部 chip ⇒ 判据吃的是「可见与不可见」的并集（折叠只是客户端态）
  assert.equal(chips.length, graph.nodes.length, "chip 全集 === 图节点数（有 cell 漏出即 O1 面漏度量，判据静默空转）");

  const routes = edges.map((e) => {
    const fa = frames.find((f) => f.projectId === projectByTask.get(e.from));
    const fb = frames.find((f) => f.projectId === projectByTask.get(e.to));
    assert.ok(fa !== undefined && fb !== undefined, `${e.from}→${e.to}：两端各自落在自己框的 cell 表里`);
    const first = canvasEdgePoint(fa, fa.cells.get(e.from), "from");
    const last = canvasEdgePoint(fb, fb.cells.get(e.to), "to");
    const hit = ds.filter((d) => {
      const p = dPoints(d);
      return String(p[0]) === String(first) && String(p[p.length - 1]) === String(last);
    });
    assert.equal(hit.length, 1, `${e.from}→${e.to}：画布 path 与本质边**一对一**（实得 ${hit.length} 枚 ⇒ 对账面漏边或多画）`);
    return {
      from: e.from,
      to: e.to,
      d: hit[0],
      fromProject: fa.projectId,
      toProject: fb.projectId,
      sIdx: frameIdx.get(fa.projectId),
      tIdx: frameIdx.get(fb.projectId),
      span: Math.abs(frameIdx.get(fb.projectId) - frameIdx.get(fa.projectId)),
    };
  });
  return { frames, chips, routes, cross: routes.filter((r) => r.fromProject !== r.toProject) };
}

/**
 * **障碍集（A6 带域）**：`O1` = 全体 chip 除本边两端；`O2` = 非本边两端所属框的整块矩形。
 * 出参每项带 `id`（`chip:` / `frame:` 前缀）⇒ 命中项可逐条打印（③ 的可读性判据）。
 * @param unbanded 仅 ① 的反例用：`true` ⇒ 照**字面「全体矩形」**（不剔本边两端所属框）
 */
function canvasObstaclesOf(tasks, edge, unbanded = false) {
  const scene = canvasSceneOf(tasks);
  const ends = new Set([edge.from, edge.to]);
  const ownFrames = new Set(
    scene.chips.filter((c) => ends.has(c.taskId)).map((c) => c.projectId),
  );
  assert.equal(ownFrames.size >= 1, true, `本边 ${edge.from}→${edge.to} 两端所属框在册（框集合不得为空）`);
  return [
    ...scene.chips.filter((c) => !ends.has(c.taskId)).map((c) => ({ id: `chip:${c.taskId}`, rect: c.rect })),
    ...scene.frames
      .filter((f) => unbanded || !ownFrames.has(f.projectId))
      .map((f) => ({ id: `frame:${f.projectId}`, rect: f.rect })),
  ];
}

/**
 * **画布级穿模判据（混合）**：直线段解析判交叠（H/V × 矩形严格内交，复用 {@link interiorOverlap}）；
 * 弧段 24 点采样逐点判「严格落进矩形内部」（复用 {@link sampleSegment} / {@link G5_SAMPLES}）。
 * 出参每条 = `{ edge 由调用方持有, seg, kind, obstacle }` ⇒ **枚数 = 命中数**（不预设 0）。
 */
function canvasHits(pathD, obstacles) {
  const hits = [];
  dSegments(pathD).forEach((seg, i) => {
    if (seg.kind === "line") {
      const [a, b] = seg.pts;
      assert.ok(a[0] === b[0] || a[1] === b[1], `直线段 ${i} 须轴对齐（H/V）—— 斜段不属走线原语族（实得 [${a}]→[${b}]）`);
      for (const o of obstacles) {
        if (interiorOverlap(boxOfPts(seg.pts), o.rect)) hits.push({ seg: i, kind: "line", obstacle: o.id });
      }
      return;
    }
    const pts = sampleSegment(seg);
    assert.equal(pts.length, G5_SAMPLES, `弧段 ${i} 采样点数 === ${G5_SAMPLES}（判据宽度不得随手放宽）`);
    for (const [j, p] of pts.entries()) {
      for (const o of obstacles) {
        if (o.rect[0] < p[0] && p[0] < o.rect[1] && o.rect[2] < p[1] && p[1] < o.rect[3]) {
          hits.push({ seg: i, kind: "arc", at: j, obstacle: o.id });
        }
      }
    }
  });
  return hits;
}

/** 命中项 → 可读字面（`被穿者@段号/形`）—— ③ 的「逐条可打印」用的就是这一枚。 */
const hitTexts = (hits) => [...new Set(hits.map((h) => `${h.obstacle}#${h.seg}${h.kind}`))].sort();

test("G11-画布穿模①判据自证：手写 7 段走廊（首弧控制点 y ≠ y0）在带域障碍集上 canvasHits === 0，且不分域 / 真穿模两形都判红", () => {
  const tasks = f3SpanTwoForward();
  const scene = canvasSceneOf(tasks);
  const edge = scene.cross.find((r) => r.span === 2);
  assert.ok(edge !== undefined, "F3 确有 k=2 的跨框边（7 段档的载体）");
  assert.deepEqual([edge.from, edge.to], ["f3a", "f3b"], "本条被测边 = f3a(board)→f3b(orch)，中间框 flow 被跨越");

  const obstacles = canvasObstaclesOf(tasks, edge);
  const ids = obstacles.map((o) => o.id);
  // ---- 带域构成的正 / 负两面（A6 的机械凭据）----
  assert.deepEqual(
    ids,
    ["chip:f3c", "chip:f3d", "frame:flow"],
    "O1 = 全体 chip 除本边两端（f3a/f3b 不入集）∪ O2 = **仅非本边两端所属框**（board / orch 不入集、flow 入集）",
  );
  assert.equal(scene.chips.length, 4, "i5：chip 全集 === 节点数（SSR 全展开，判据与折叠态无关）");
  assert.equal(
    scene.chips.length - 2,
    obstacles.filter((o) => o.id.startsWith("chip:")).length,
    "O1 枚数 === 节点数 − 2（除本边两端 ⇒ 不是「全体 chip」的字面照抄）",
  );

  // ---- 手写修复形走廊：`2k+3 = 7` 段（C L C L C L C），沿「出口带 → 右 gutter → 框间带 → 左 gutter → 入口」 ----
  // 逐段坐标即 F3 场景的几何读数：源右缘中点 (119,69) / 目标左缘中点 (45,341) / flow 框 [24,270]×[148,248] / 画布宽 294
  const corridor =
    "M119,69" +
    " C155,69 290,80 290,105" + // 弧1（H→V）：**第二控制点 y=80 ≠ y0=69** = 件一根因的反面
    " L290,264" + // 竖直腿①：右 gutter（x=290 > flow 框右缘 270 ⇒ 不进任何框矩形）
    " C290,264 290,264 264,264" + // 弧2（V→H）
    " L44,264" + // 水平段：flow/orch 之间的框间带（y=264 ∈ (248,280)）
    " C20,264 20,264 20,288" + // 弧3（H→V）
    " L20,317" + // 竖直腿②：左 gutter（x=20 < 框左缘 24）
    " C20,341 20,341 45,341"; // 弧4（V→H）入目标 chip 左缘中点
  const segs = dSegments(corridor);
  assert.equal(segs.length, 7, `走廊段数 === 2k+3 = 7（k=${edge.span}）`);
  assert.deepEqual(
    [segs.filter((s) => s.kind === "cubic").length, segs.filter((s) => s.kind === "line").length],
    [4, 3],
    "7 段 = 4 弧 + 3 直（`C L C L C L C`）⇒ 相邻段间恰 6 处切线接续 = 2k+2 转角（每转角一枚 C 弧）",
  );
  assert.equal(segs[0].kind, "cubic", "首段 = 弧（切线水平出射，端点 = 源 chip 右缘中点）");
  assert.equal(segs[0].pts[0][1], 69, "首弧起点 y === 源 chipMidY（I2 端点定义式，件三一行不改）");
  assert.equal(
    segs[0].pts.slice(1, 3).every((p) => p[1] === 69),
    false,
    "**首弧两控制点不得全 = y0**（现实现正是这一形 ⇒ 本走廊是「修复形」的样本，不是现码的复刻）",
  );

  // ---- ① 的正钉：正确形态在带域障碍集上 0 命中（判据不把正确形态判红）----
  assert.deepEqual(canvasHits(corridor, obstacles), [], "手写走廊在带域障碍集上须 0 命中（否则判据过紧，n7 的新不变式无从谈起）");

  // ---- ① 的两条空转守卫：判据不是恒 0，带域不是白写的 ----
  const straightThrough = "M100,69 L100,220"; // 竖直硬穿 flow 框（y 148→248 之间长段）⇒ 必须判红
  const throughHits = canvasHits(straightThrough, obstacles);
  assert.ok(throughHits.length >= 1, `空转守卫：一条直穿 flow 框的硬线段必须命中（实得 ${throughHits.length}）`);
  assert.deepEqual(
    hitTexts(throughHits),
    ["chip:f3c#0line", "frame:flow#0line"],
    "命中项可读 = `被穿者#段号形`，且 **O1（兄弟 chip）与 O2（兄弟框矩形）两面同时参与判定**（只中其一即说明另一面没接线）",
  );
  const unbandedHits = canvasHits(corridor, canvasObstaclesOf(tasks, edge, true));
  assert.ok(
    unbandedHits.length > 0,
    "A6 带域必要性：同一走廊在**字面「全体矩形」**下判红（正确形态被自己框的边框 / 标题带冤枉 ⇒ 障碍集必须带域）",
  );
});

test("G11-画布穿模②（本枚极性 = **必为 0** · n7 与算法同轮翻转）：渲染层全部跨框边在 A6 带域障碍集上 canvasHits 恒 0", () => {
  const shapes = canvasFixtures();
  assert.ok(shapes.length >= 5, `五形都在册（F1 相邻正向 / F2 相邻回流 / F3 跨 3 框正向 / F4 跨 3 框回流 / F5 超载与单列框，实得 ${shapes.length} 形）`);
  let edges = 0;
  let controls = 0;
  let controlsHit = 0;
  for (const { key, label, tasks } of shapes) {
    const scene = canvasSceneOf(tasks);
    assert.ok(scene.cross.length >= 1, `${label}：跨框边在册（0 枚 ⇒ 本形对 I1′ 空转，回到 i6 的旧缺口）`);
    for (const r of scene.cross) {
      const obstacles = canvasObstaclesOf(tasks, r);
      assert.ok(obstacles.length >= 1, `${key}/${r.from}→${r.to}：带域障碍集非空（空集 ⇒ 下面那个 0 是空转）`);
      const hits = canvasHits(r.d, obstacles);
      assert.deepEqual(
        hits,
        [],
        `${key} k=${r.span}：${r.from}(${r.fromProject})→${r.to}(${r.toProject}) 渲染层走廊须 **0 命中**（实得 ${hitTexts(hits).join(" ")}）`,
      );
      edges += 1;
      // ---- 反对照（「0」不得是判据退化的 0）：把同一条边压回**改前那一形** —— 竖腿直落、不绕画布外缘、
      //      水平段落在两框之间（正落在被跨越的兄弟框矩形里）⇒ 同一障碍集上必判红。k≥2 才有被跨越的框。
      if (r.span < 2) continue;
      const pts = dPoints(r.d);
      const head = pts[0];
      const tail = pts[pts.length - 1];
      const oldForm = crossPath(
        head[0],
        head[1],
        head[0] + DG_LANE_MIN,
        Math.round((head[1] + tail[1]) / 2),
        tail[0],
        tail[1],
      );
      controls += 1;
      if (canvasHits(oldForm, obstacles).length > 0) controlsHit += 1;
    }
  }
  assert.ok(edges >= 6, `被测跨框边枚数 ${edges} ≥ 6 ⇒ 五形边集全入走线（丢边会同时把本枚测空）`);
  assert.ok(
    controls >= 1 && controlsHit >= 1,
    `改前直落形反对照判红 ${controlsHit}/${controls} ⇒ 判据真的在拦「腿纵穿兄弟框」这一形，② 的 0 才有意义`,
  );
});

test("G11-画布穿模③（本枚极性 = **必为 0** · n7 与算法同轮翻转）：n1 真板集全部路由的画布级命中边集合为空", () => {
  const tasks = realTasks();
  const scene = canvasSceneOf(tasks);
  const intra = scene.routes.filter((r) => r.fromProject === r.toProject);
  assert.equal(scene.routes.length, scene.cross.length + intra.length, "对账前提：路由集 = 跨框档 ∪ 同框档（不重不漏，同一取数面）");
  assert.ok(scene.cross.length >= 1, `真板集确有跨框边 ${scene.cross.length} 枚（0 枚 ⇒ 本条对 I1′ 空转，回到 i6 的旧缺口）`);
  assert.ok(intra.length >= 1, `真板集确有同框边 ${intra.length} 枚 ⇒ 下面那条「路由集全入判据面」不是只测了跨框档`);

  const hitEdges = [];
  let obstacleRows = 0;
  for (const r of scene.routes) {
    const obstacles = canvasObstaclesOf(tasks, r);
    assert.ok(obstacles.length >= 1, `${r.from}→${r.to}：带域障碍集非空（空集 ⇒ 该边的 0 命中是空转）`);
    obstacleRows += 1;
    const hits = canvasHits(r.d, obstacles);
    if (hits.length === 0) continue;
    hitEdges.push({
      text: `${r.from}→${r.to}（${r.fromProject}>${r.toProject} · span=${r.span}）穿 ${hitTexts(hits).join(" ")}`,
      cross: r.fromProject !== r.toProject,
      chips: [...new Set(hits.map((h) => h.obstacle))].filter((x) => x.startsWith("chip:")).map((x) => x.slice(5)),
    });
  }
  // ---- 主钉（翻转后）：真板集命中边集合 === 空 ----
  assert.deepEqual(
    hitEdges.map((e) => e.text),
    [],
    `真板集在画布级判据下须 **0 命中边**（实得 ${hitEdges.length} 枚：${hitEdges.map((e) => e.text).join(" | ")}）`,
  );
  // ---- 覆盖面钉：判据真的逐条跑过（不是「无路由 ⇒ 无命中」）----
  assert.equal(obstacleRows, scene.routes.length, `逐条边账 ${obstacleRows} 枚 === 路由集枚数（每条都过了带域判据）`);
  // ---- 反对照：把真板 k≥2 的跨框边压回改前一形（腿直落、水平段落带间）⇒ 同一障碍集上必判红 ----
  let controls = 0;
  let controlsHit = 0;
  for (const r of scene.cross.filter((x) => x.span >= 2)) {
    const pts = dPoints(r.d);
    const head = pts[0];
    const tail = pts[pts.length - 1];
    const oldForm = crossPath(
      head[0],
      head[1],
      head[0] + DG_LANE_MIN,
      Math.round((head[1] + tail[1]) / 2),
      tail[0],
      tail[1],
    );
    controls += 1;
    const hits = canvasHits(oldForm, canvasObstaclesOf(tasks, r));
    if (hits.length === 0) continue;
    controlsHit += 1;
    // 红字面的可读性口径随本枚保留（将来若红，必须点名被穿者）
    assert.ok(
      hits.every((h) => h.obstacle.startsWith("chip:") || h.obstacle.startsWith("frame:")),
      `${r.from}→${r.to}：命中项须点名被穿者（chip / 框矩形）`,
    );
  }
  assert.ok(controls >= 1, `真板集确有 k≥2 的跨框边可作反对照（实得 ${controls} 枚）`);
  assert.ok(
    controlsHit >= 1,
    `真板集上改前一形判红 ${controlsHit}/${controls} ⇒ ③ 的 0 是「同一判据、同一障碍集、换了走线」的结果，不是判据在真板几何上失灵`,
  );
});

// ---------------------------------------------------------------------------
// G13-真板复现①②（REQ-2026-10-14-02 · 增补 n5 · 锚账 ANCHOR-5「复现锚 L1 / L2」· 改造文档 §6 第二枚增补「改前两条计数」）
// **本枚只管「真板复现数值」**，不管判据函数本身（判据 = n4 的 `canvasSceneOf` / `canvasObstaclesOf` /
// `canvasHits` 与 G5 的 `findOverlaps`，本枚零新判据、零 `src/` 改动、不与 n4 三枚合并 —— 面不同）。
//
// **golden 的来源**：`GOLDEN_BEFORE` 三数由本文件判据函数在 **n1 真板集**上**当场量一次**后写入，
//   **不是文档抄数**。改造文档 §6 的原型口径预期是「穿模 3 边 / 13 chip · 叠线 14 对」，实测得
//   **3 边 / 10 chip · 4 对** ⇒ **以实测为准，判据函数未为凑数放宽**。两边**不是同一量法**（原型那两数
//   = 真板页面 DOM 直读的浏览器量法，本枚 = 离线判据面 + `G5_END_EXEMPT_PX = 24` 共端点豁免 +
//   `G5_PARALLEL_SIN_MAX` 平行判据），差因**未在本枚坐实** ⇒ 已随本节点回传实测，
//   **§6 / §4.4 的文档数须由宿主按实测订正**（或另立量法分野说明）。
//
// **本枚极性 = 改后锚**（n7 与算法**同轮**由「复现锚（实测 === 改前 golden）」翻转为「必为 0 / 0」——
//   不拆第三枚节点，故不存在「旧码 × 新不变式」的中间红节点）。改前 golden **留在账面**作基线，
//   判据仍咬人的凭据由 G11②③ 的**改前一形反对照**承担（同一判据、同一障碍集、换了走线 ⇒ 那边红这边 0）。
// ---------------------------------------------------------------------------

/**
 * 改前 golden（**实测写入**，非文档口径）：
 * `hitsEdges` 穿模边数 / `hitChips` 被穿 chip 枚数（**去重**）/ `overlapPairs` 叠线段对数。
 * **n7 起只作基线登记**（不再被测量）—— 其非零性正是「翻转真实发生」的凭据。
 */
const GOLDEN_BEFORE = Object.freeze({ hitsEdges: 3, hitChips: 10, overlapPairs: 4 });

/** 改后 golden（n7 极性）：穿模 0 边 / 0 chip、叠线 0 段对（改造文档 §6 锚账 ⑤「改后 0 / 0」）。 */
const GOLDEN_AFTER = Object.freeze({ hitsEdges: 0, hitChips: 0, overlapPairs: 0 });

/**
 * 真板集 → **画布级穿模计数**（L1）：逐条本质边吃 n4 的带域障碍集与混合判据，零新度量。
 * 出参含逐条明细 ⇒ 复核失败时能直接点名是哪条边、哪枚 chip。
 */
function realPenetrationCounts() {
  const tasks = realTasks();
  const scene = canvasSceneOf(tasks);
  const edges = [];
  const chips = new Set();
  let hits = 0;
  for (const r of scene.routes) {
    const found = canvasHits(r.d, canvasObstaclesOf(tasks, r));
    if (found.length === 0) continue;
    hits += found.length;
    const victims = [...new Set(found.map((h) => h.obstacle))];
    edges.push(`${r.from}→${r.to}(${r.fromProject}>${r.toProject}·span=${r.span}·命中${found.length}点·被穿${victims.length}项)`);
    for (const id of victims) {
      if (!id.startsWith("chip:")) continue;
      const chip = id.slice(5);
      assert.ok(tasks.some((t) => t.taskId === chip), `被穿 chip 须是真板集内的 taskId：${chip}`);
      chips.add(chip);
    }
  }
  return {
    hitsEdges: edges.length,
    hitChips: chips.size,
    hits,
    edges,
    chipIds: [...chips].sort(),
    routes: scene.routes.length,
    cross: scene.cross.length,
  };
}

/**
 * 真板集 → **叠线计数**（L2）：G5 采样叠点法搬到**画布路径全集**（`scene.routes` = 同框 + 跨框同一取数面），
 * 常量逐字沿用 `G5_SAMPLES / G5_NEAR_PX / G5_RED_MIN / G5_END_EXEMPT_PX / G5_PARALLEL_SIN_MAX` ——
 * 其中「显式豁免共用端点 24px」由 {@link countNearPairs} 承担（同源扇出 = 合法共端点，不是叠线）。
 */
function realOverlapCounts() {
  const routes = canvasSceneOf(realTasks()).routes;
  const byEdge = new Map(routes.map((r) => [`${r.from}→${r.to}`, r]));
  const { hits, rawHits, pairs } = findOverlaps(routes);
  /** 余对**逐条点名**（段形 + 跨度 + 是否跨框档）—— X3 丙「登记超载」的取证面，红字直读不用二次量。 */
  const segKind = (label, index) => {
    const r = byEdge.get(label);
    const seg = r === undefined ? undefined : dSegments(r.d)[index];
    return `${seg?.kind ?? "?"}@span${r?.span ?? "?"}${r !== undefined && r.fromProject !== r.toProject ? "x" : "内"}`;
  };
  return {
    overlapPairs: hits.length,
    rawPairHits: rawHits,
    pairs,
    crossOnly: hits.filter((h) => byEdge.get(h.a)?.span >= 1 && byEdge.get(h.b)?.span >= 1).length,
    detail: hits.map(
      (h) =>
        `${h.a} || ${h.b} seg=${h.seg[0]},${h.seg[1]}（${segKind(h.a, h.seg[0])} / ${segKind(h.b, h.seg[1])}）叠点=${h.overlap}（raw=${h.raw}）`,
    ),
  };
}

test("G13-真板复现①（改后 golden · 极性 = **必为 0 / 0**，n7 与算法同轮翻转）：真板集画布级穿模 = 0 边 / 0 chip", () => {
  const first = realPenetrationCounts();
  const second = realPenetrationCounts();
  // ---- golden 可复核（①）：同轮**二次运行**实测逐字段相等（判据确定性，非一次采样噪声）----
  assert.deepEqual(second, first, "同轮二次运行实测须逐字段相等 —— 不等 ⇒ 走线含非确定量，golden 无从谈起");
  // ---- 覆盖面钉：0 不得是「没边可测」的 0 ----
  assert.ok(first.routes >= 1 && first.cross >= 1, `真板集确有路由 ${first.routes} 枚（其中跨框 ${first.cross} 枚）⇒ 判据面非空`);
  // ---- ②：两条计数各自钉到**改后 golden = 0** ----
  assert.equal(first.hitsEdges, GOLDEN_AFTER.hitsEdges, `穿模边数须 === 改后 golden 0（实得 ${first.hitsEdges}：${first.edges.join(" / ") || "无命中"}）`);
  assert.equal(first.hitChips, GOLDEN_AFTER.hitChips, `被穿 chip 枚数（去重）须 === 改后 golden 0（实得 ${first.hitChips}）`);
  assert.equal(first.hits, 0, `命中点总数逐枚须为 0（实得 ${first.hits}）`);
  // ---- 改前基线**留在账面**（本枚不再测它；③ 的反对照负责证明判据仍咬人）----
  assert.ok(GOLDEN_BEFORE.hitsEdges >= 1 && GOLDEN_BEFORE.hitChips >= 1, "改前 golden 是非零命中数 ⇒ 「0/0」是一次真实的翻转，不是把判据调空");
  assert.ok(first.routes >= GOLDEN_BEFORE.hitsEdges, `路由面枚数须容得下改前那 ${GOLDEN_BEFORE.hitsEdges} 枚命中边（否则改前值无从产生）`);
});

test("G13-真板复现②（改后 golden · G5 采样叠点法搬画布全集 · 显式豁免共用端点 24px）：真板集叠线 = 0 段对", () => {
  assert.equal(G5_END_EXEMPT_PX, 24, "共用端点豁免半径逐字 = 24px（G5 常量沿用，本枚不另立值）");
  const first = realOverlapCounts();
  const second = realOverlapCounts();
  // ---- golden 可复核（①）----
  assert.deepEqual(second, first, "同轮二次运行叠线实测须逐字段相等");
  // ---- ③：叠线段对数钉到**改后 golden = 0** ----
  assert.equal(
    first.overlapPairs,
    GOLDEN_AFTER.overlapPairs,
    `叠线段对数须 === 改后 golden 0（实得 ${first.overlapPairs}：${first.detail.join(" / ") || "无叠线"}）`,
  );
  // ---- 两头不许空转：段对面非空（测过）+ raw 面确有被豁免剔掉的共端点 ----
  assert.ok(first.pairs > 0, `段对检查面非空（画布路径全集 ${first.pairs} 段对）`);
  assert.ok(
    first.rawPairHits > first.overlapPairs,
    `raw 面（不剔共端点、不判平行）命中 ${first.rawPairHits} 段对 > 判红 ${first.overlapPairs} 段对 ⇒ 24px 共端点豁免确有生效（同源扇出未被计成叠线）`,
  );
  // ---- 改前基线留在账面：判红数从 ${GOLDEN_BEFORE.overlapPairs} 段对真降到 0 ----
  assert.ok(GOLDEN_BEFORE.overlapPairs >= 1, "改前 golden 是非零段对数 ⇒ 本枚的 0 是一次真实的翻转");
});

// ---------------------------------------------------------------------------
// G12-画布叠线与容量（REQ-2026-10-14-02 · 承接轨② n8c · 改造文档 §6 第二枚增补 ANCHOR-4）
// 三条**由构造成立**的容量不等式，按现码构造式逐式实测（本族**只读构造、不改算法**）：
//   ① **带高式** `gapH ≥ 2·DG_CROSS_MIN + lanes·DG_BUS_PITCH` —— 消费面 = `canvasLayout`
//   ② **列宽式** `gapW ≥ DG_LANE_MIN·2 + n·DG_LANE_PITCH` —— 消费面 = `pipeGridLayout`
//   ③ **外缘** `seat < DG_OUTER_MARGIN_SEATS·2 = 4` 的**严格**不等式 —— 消费面 = `pickCrossCorridors`
//     的 i7 严格 `>`（`legCorridorLadder` 同式），`OUTER_LANE_CAPACITY` 逐字 **4**
// 三式共用同一句反面：**席数不够 ⇒ 只能共段 ⇒ 代价落在「叠线账」上、绝不落在「穿模账」上**（X3 丙）。
// **两头不许空转**（照 `G4-穿节点④` / `G11-走廊③④` 先例，每式各配一枚当场判红的违反形）：
//   ① 兜底宽 `DG_FRAME_GAP_MIN` 承载 `G12_SHORT_BAND_SEATS` 席 ⇒ 同一中线分布式把首条 lane 抬回**源框矩形**；
//   ② n8a 之前的旧式预算（列通道只数框内 long 腿 ⇒ 需求 > 预算）⇒ 同列两条跨框腿**共段** ⇒ 叠线账判红；
//   ③ 第 5 席 `at` **恰贴**最右框右缘（贴边即拒 ⇒ 严格 `>` 当场破）· 第 6 席落进框内 ⇒ 画该 x 的竖腿判红。
// **不另立常量**：叠线判据原样吃 `G5_SAMPLES / G5_NEAR_PX / G5_RED_MIN / G5_END_EXEMPT_PX / G5_PARALLEL_SIN_MAX`
// （24px 共端点豁免沿用），穿模判据原样吃 `canvasHits` 的 A6 带域混合判据。
// ---------------------------------------------------------------------------

/** 框间带在带高 `gapH` 上**可容的席数**（① 的容量读法：不等式 ⇔ 「这条带放得下几条线」同一句话）。 */
const bandSeatsAt = (gapH) => Math.floor((gapH - DG_CROSS_MIN * 2) / DG_BUS_PITCH);

/** 列间通道在列距 `gapW` 上**可容的席数**（② 的容量读法，同款）。 */
const columnSeatsAt = (gapW) => Math.floor((gapW - DG_LANE_MIN * 2) / DG_LANE_PITCH);

/** 框间带第 `j` 条 lane 的 y —— 与 `canvasLayout` 的中线分布式逐字同式（① 的正反两面共用这一把尺）。 */
const bandLaneYAt = (bandTop, gapH, seats, j) =>
  bandTop + Math.floor((gapH - seats * DG_BUS_PITCH) / 2) + Math.floor(DG_BUS_PITCH / 2) + j * DG_BUS_PITCH;

/** 列间通道第 `i` 条 lane 的 x —— 与 `pipeGridLayout` 的分布式逐字同式（② 用；入参 = 本列 chip 右缘）。 */
const columnLaneXAt = (chipRight, i) => chipRight + DG_LANE_MIN + i * DG_LANE_PITCH;

/**
 * 画布外缘第 `seat` 席的 x —— 与 `pickCrossCorridors.marginAt` / `legCorridorLadder` 的席→线算式同式
 * （左族 `seat < DG_OUTER_MARGIN_SEATS`、右族取 `seat − DG_OUTER_MARGIN_SEATS` 偏移）。
 * **本函数按席号直算、不取模** ⇒ 喂 `seat ≥ OUTER_LANE_CAPACITY` 得到的正是「硬容量之外那一席」的位置，
 * ③ 的违反形吃的就是这一枚差别（实现里的取模复用 = 共段，见 `G11-走廊⑤`）。
 */
const outerMarginXAt = (layout, seat) =>
  seat < DG_OUTER_MARGIN_SEATS
    ? DG_CANVAS_PAD + seat * DG_CORRIDOR_MARGIN_STEP
    : layout.width - DG_CANVAS_PAD - (seat - DG_OUTER_MARGIN_SEATS) * DG_CORRIDOR_MARGIN_STEP;

/** 最右框右缘（i7 严格不等式的右端点；与 `G11-走廊⑤` 的 `rightEdge` 同一算式）。 */
const outerRightEdgeOf = (layout) =>
  DG_CANVAS_GUTTER + layout.frames.reduce((mx, f) => Math.max(mx, f.frameW), 0);

/**
 * **全体框矩形**障碍面（不剔本边两端所属框）—— 只在 ①③ 的**违反形**上用：违反形的内容恰是「腿进了不该进的框」，
 * 带域豁免（A6 的 O2 只数非本边两端所属框）在此不适用。正反面因此各吃各的障碍面，不共用一条放宽的判据。
 */
const frameRectsOf = (layout) =>
  layout.frames.map((f) => ({ id: `frame:${f.projectId}`, rect: [f.dx, f.dx + f.frameW, f.dy, f.dy + f.frameH] }));

/** ① 的违反形超载席数：兜底宽可容 `bandSeatsAt(DG_FRAME_GAP_MIN) = 0` 席 ⇒ 任何正数都违反，取 5 使分布式**溢出到框内**（几何面也判红）。 */
const G12_SHORT_BAND_SEATS = 5;

test("G12-①带高式（gapH ≥ 2·DG_CROSS_MIN + lanes·DG_BUS_PITCH · 消费 canvasLayout）：逐带实测式子成立 ∧ lane y === 中线分布式 ∧ 距上下框缘 ≥ DG_CROSS_MIN；兜底宽承载 5 席的违反形必判红", () => {
  const bands = [];
  const ledger = { linear: 0, floored: 0 };
  for (const [label, tasks] of bandFixtures()) {
    const layout = fixedPointOf(tasks).layout;
    assert.equal(layout.bandLanes.length, layout.gapH.length, `${label}：带 lane 集与带高数组同长（逐带对账的前提）`);
    layout.bandLanes.forEach((lanes, i) => {
      const own = layout.frames[i];
      const next = layout.frames[i + 1];
      assert.ok(own !== undefined && next !== undefined, `${label} 带 ${i}：一枚带须夹在两枚框之间`);
      const bandTop = own.dy + own.frameH;
      const nextTop = next.dy;
      const gapH = layout.gapH[i];
      const seats = lanes.length;
      bands.push(`${label}#${i}:${seats}席/${gapH}px`);
      // ---- 式子本体 + 同一句话的容量读法 ----
      assert.ok(
        gapH >= DG_CROSS_MIN * 2 + seats * DG_BUS_PITCH,
        `${label} 带 ${i}：带高式成立否 —— gapH=${gapH} 须 ≥ 2·DG_CROSS_MIN(${DG_CROSS_MIN * 2}) + ${seats}·DG_BUS_PITCH(${seats * DG_BUS_PITCH}) = ${DG_CROSS_MIN * 2 + seats * DG_BUS_PITCH}`,
      );
      assert.ok(
        bandSeatsAt(gapH) >= seats,
        `${label} 带 ${i}：可容席数 ${bandSeatsAt(gapH)} 须 ≥ 实占席数 ${seats}（容量读法与上式同一句）`,
      );
      assert.equal(
        nextTop - bandTop,
        gapH,
        `${label} 带 ${i}：带高 = 上下框缘之间那段净空（式子消费的量，不留第二份口径）`,
      );
      // ---- 「由构造成立」的直接凭据：实占 lane y 逐条 === 中线分布式；净空 ≥ DG_CROSS_MIN ----
      [...lanes].forEach((y, j) => {
        assert.equal(y, bandLaneYAt(bandTop, gapH, seats, j), `${label} 带 ${i} lane ${j}：y === canvasLayout 的中线分布式`);
        const clearance = Math.min(y - bandTop, nextTop - y);
        assert.ok(
          clearance >= DG_CROSS_MIN,
          `${label} 带 ${i} lane ${j}：y=${y} 距上下框缘的净空 ${clearance} 须 ≥ DG_CROSS_MIN(${DG_CROSS_MIN}) —— 横腿才不进框`,
        );
      });
      if (seats >= 1) ledger.linear += 1;
      else ledger.floored += 1;
    });
  }
  assert.ok(ledger.linear >= 3, `线性区实测 ${ledger.linear} 枚带 ≥ 3（逐条 lane y 对账真跑到，${bands.join("、")}）`);
  assert.ok(ledger.floored >= 1, `兜底档实测 ${ledger.floored} 枚空带 ≥ 1（两档都覆盖，不得只测富余侧）`);

  // ---- 违反形必判红：兜底宽承载 5 席 ⇒ 同一把尺把首条线抬回**源框矩形**（正反面共用分布式，只差带高）----
  assert.ok(
    bandSeatsAt(DG_FRAME_GAP_MIN) < G12_SHORT_BAND_SEATS,
    `兜底宽 ${DG_FRAME_GAP_MIN} 可容 ${bandSeatsAt(DG_FRAME_GAP_MIN)} 席 < ${G12_SHORT_BAND_SEATS} 席 ⇒ 该形在算术上就站不住`,
  );
  let red = 0;
  for (const [label, tasks] of [["F1", f1AdjacentForward()], ["F5a", f5OuterOverload()], ["真板 eb86d5e8", realTasks()]]) {
    const layout = fixedPointOf(tasks).layout;
    const own = layout.frames[0];
    assert.ok(own !== undefined && layout.frames.length >= 2, `${label}：违反形须有框间带可借（至少两框）`);
    const bandTop = own.dy + own.frameH;
    const yBad = bandLaneYAt(bandTop, DG_FRAME_GAP_MIN, G12_SHORT_BAND_SEATS, 0);
    assert.ok(
      yBad < bandTop,
      `${label}：兜底宽承载 ${G12_SHORT_BAND_SEATS} 席 ⇒ 首条 lane y=${yBad} 已越过带上缘 ${bandTop}（落进源框 ${own.dy}..${bandTop}）`,
    );
    const obstacles = frameRectsOf(layout);
    const bad = `M${own.dx + 1},${yBad} L${own.dx + own.frameW - 1},${yBad}`;
    const badHits = canvasHits(bad, obstacles);
    assert.ok(badHits.length >= 1, `${label}：违反形的横腿须判红（实得 ${hitTexts(badHits).join(", ") || "零命中 ⇒ 判据空转"}）`);
    // 同一枚横腿搬到**实态带高**给出的 lane y 上 ⇒ 0 命中 ⇒ 判红来自带高不足、不来自尺子偏紧
    const yGood = (layout.bandLanes[0] ?? [])[0];
    if (yGood !== undefined) {
      assert.deepEqual(
        canvasHits(`M${own.dx + 1},${yGood} L${own.dx + own.frameW - 1},${yGood}`, obstacles),
        [],
        `${label}：实态那条带 lane 上的横腿 0 命中（对照面 ⇒ 上句的判红确由带高式所挡）`,
      );
    }
    red += 1;
  }
  assert.equal(red, 3, `违反形实测 ${red} 枚（F1 / F5a / 真板）都判红`);
});

test("G12-②列宽式（gapW ≥ DG_LANE_MIN·2 + n·DG_LANE_PITCH · 消费 pipeGridLayout）：逐列实测式子成立 ∧ lane x === 通道分布式 ∧ 距左右 chip 缘 ≥ DG_LANE_MIN；旧式预算（需求 > 预算）⇒ 同列两腿共段必判红", () => {
  const columns = [];
  for (const [label, tasks] of bandFixtures()) {
    const { grids } = fixedPointOf(tasks);
    for (const [projectId, grid] of grids) {
      assert.equal(grid.gapW.length, Math.max(0, grid.colX.length - 1), `${label}/${projectId}：列距枚数 === 列数 − 1`);
      assert.equal(grid.lanes.length, grid.gapW.length, `${label}/${projectId}：通道集与列距集同长（逐列对账的前提）`);
      grid.gapW.forEach((gapW, c) => {
        const seats = (grid.lanes[c] ?? []).length;
        const chipRight = grid.colX[c] + DG_NODE_W;
        const nextColLeft = grid.colX[c + 1];
        assert.ok(nextColLeft !== undefined, `${label}/${projectId} 列 ${c}：右邻列在册（末列无通道，不进本账）`);
        columns.push(`${label}/${projectId}#${c}:${seats}席/${gapW}px`);
        // ---- 式子本体 + 容量读法 + 「列距就是式子消费的那枚量」 ----
        assert.ok(
          gapW >= DG_LANE_MIN * 2 + seats * DG_LANE_PITCH,
          `${label}/${projectId} 列 ${c}：列宽式成立否 —— gapW=${gapW} 须 ≥ 2·DG_LANE_MIN(${DG_LANE_MIN * 2}) + ${seats}·DG_LANE_PITCH(${seats * DG_LANE_PITCH}) = ${DG_LANE_MIN * 2 + seats * DG_LANE_PITCH}`,
        );
        assert.ok(
          columnSeatsAt(gapW) >= seats,
          `${label}/${projectId} 列 ${c}：可容席数 ${columnSeatsAt(gapW)} 须 ≥ 实占席数 ${seats}`,
        );
        assert.equal(nextColLeft - chipRight, gapW, `${label}/${projectId} 列 ${c}：列距 = 本列 chip 右缘到右邻列 chip 左缘`);
        [...(grid.lanes[c] ?? [])].forEach((x, i) => {
          assert.equal(x, columnLaneXAt(chipRight, i), `${label}/${projectId} 列 ${c} lane ${i}：x === pipeGridLayout 的通道分布式`);
          assert.ok(
            Math.min(x - chipRight, nextColLeft - x) >= DG_LANE_MIN,
            `${label}/${projectId} 列 ${c} lane ${i}：x=${x} 距左右 chip 缘的净空 ${Math.min(x - chipRight, nextColLeft - x)} 须 ≥ DG_LANE_MIN(${DG_LANE_MIN})`,
          );
        });
      });
    }
  }
  assert.ok(columns.length >= 4, `列面实测 ${columns.length} 枚通道（${columns.slice(0, 6).join("、")}…）⇒ 本钉非空转`);

  // ---- 违反形必判红 = n8a 之前的旧式预算面：列宽式对「真需求」不成立 ⇒ 腿只能共段 ⇒ 代价落在叠线账 ----
  const tasks8b = f8ChannelTwoLegs();
  const on = corridorSceneOf(tasks8b, true);
  const off = corridorSceneOf(tasks8b, false);
  const onGrid = on.grids.get("board");
  const offGrid = off.grids.get("board");
  assert.ok(onGrid !== undefined && offGrid !== undefined, "F8b board 网格在两侧都在册");
  const demand = onGrid.lanes[1].length;
  assert.ok(demand >= 3, `F8b 列 1 的真需求 === ${demand} 席（1 条框内 long 腿 + 2 条本框跨框腿）`);
  assert.ok(
    columnSeatsAt(offGrid.gapW[1]) < demand,
    `旧式列宽 gapW=${offGrid.gapW[1]} 只可容 ${columnSeatsAt(offGrid.gapW[1])} 席 < 真需求 ${demand} 席 ⇒ 列宽式在旧式上**不成立**（本枚的违反形）`,
  );
  assert.ok(columnSeatsAt(onGrid.gapW[1]) >= demand, `新式 gapW=${onGrid.gapW[1]} 可容 ${columnSeatsAt(onGrid.gapW[1])} 席 ≥ 真需求 ${demand} 席`);
  const offLegX = [...crossLegXs(off)];
  assert.equal(offLegX.length, 1, `旧式两腿共用同一条通道线（出口 x 实得 ${offLegX.join(",")}）⇒ 结构上就是共段`);
  const offOverlap = findOverlaps(off.routes);
  const onOverlap = findOverlaps(on.routes);
  assert.ok(
    offOverlap.hits.length >= 1,
    `旧式（列宽式被违反）在叠线账上须判红（实得 ${offOverlap.hits.length} 段对）—— 违反形不判红 ⇒ 本钉空转`,
  );
  assert.equal(
    onOverlap.hits.length,
    0,
    `新式（列宽式成立）叠线 = 0 段对（实得 ${onOverlap.hits.map((h) => `${h.a}||${h.b}`).join(" / ") || "无"}）⇒ 抬列宽确实把共段消掉了`,
  );
});

test("G12-③外缘硬容量 4 · 严格不等式（seat < DG_OUTER_MARGIN_SEATS·2 = 4 · 消费 pickCrossCorridors 的 i7 严格 >）：四席逐条整个落在框外 ∧ 出参只取这四条线；第 5 席恰贴框缘、第 6 席落进框内 ⇒ 判红；超载只共段不穿模", () => {
  assert.equal(DG_OUTER_MARGIN_SEATS * 2, OUTER_LANE_CAPACITY, "外缘硬容量 === 2+2");
  assert.equal(OUTER_LANE_CAPACITY, 4, "外缘硬容量逐字 4（改造文档 X3 / i7 的取值面）");
  assert.equal(
    DG_CANVAS_GUTTER,
    DG_CANVAS_PAD + DG_OUTER_MARGIN_SEATS * DG_CORRIDOR_MARGIN_STEP,
    `4 席之界由构造钉死：${DG_CANVAS_GUTTER} === DG_CANVAS_PAD(${DG_CANVAS_PAD}) + ${DG_OUTER_MARGIN_SEATS}·DG_CORRIDOR_MARGIN_STEP(${DG_OUTER_MARGIN_SEATS * DG_CORRIDOR_MARGIN_STEP}) ⇒ 第 5 席的 x **恰落**最右框右缘（贴边即拒）`,
  );
  const clearanceMin = Math.ceil(DG_CORRIDOR_BULGE_MAX / 2);
  const lineSets = [];
  for (const shape of corridorFixtures()) {
    const scene = corridorSceneOf(shape.tasks);
    const minDx = Math.min(...scene.layout.frames.map((f) => f.dx));
    const rightEdge = outerRightEdgeOf(scene.layout);
    const four = [];
    for (let seat = 0; seat < OUTER_LANE_CAPACITY; seat += 1) {
      const at = outerMarginXAt(scene.layout, seat);
      four.push(at);
      // ---- i7 严格不等式（**逐字不等**：贴边即不算在外）；席→线分族同实现（前 2 席左族、后 2 席右族）----
      if (seat < DG_OUTER_MARGIN_SEATS) {
        assert.ok(at < minDx, `${shape.key} 左席 ${seat}：x=${at} 须严格 < 框左缘 ${minDx}`);
        assert.ok(minDx - at >= clearanceMin, `${shape.key} 左席 ${seat}：净空 ${minDx - at} 须 ≥ ${clearanceMin}（转角弧外扩上界）`);
      } else {
        assert.ok(at > rightEdge, `${shape.key} 右席 ${seat}：x=${at} 须严格 > 最右框右缘 ${rightEdge}`);
        assert.ok(at - rightEdge >= clearanceMin, `${shape.key} 右席 ${seat}：净空 ${at - rightEdge} 须 ≥ ${clearanceMin}（转角弧外扩上界）`);
      }
    }
    lineSets.push(new Set(four));
    // ---- 出参面：任何边任何席号取到的 ML/MR 线，都只能是上面这四条（不凭空造第五种线）----
    for (const seat of [0, 1, 2, 3, 4, 9, 99]) {
      for (const row of corridorRowsOf(shape.tasks)) {
        const picked = corridorOf(scene, row.edge, { margin: seat }).plan;
        for (const c of picked.corridors.filter((x) => x !== null && (x.kind === "ML" || x.kind === "MR"))) {
          assert.equal(c.capacity, OUTER_LANE_CAPACITY, `${shape.key}：出参外缘走廊 ${c.id} 容量逐字 = 4`);
          assert.ok(c.seat >= 0 && c.seat < OUTER_LANE_CAPACITY, `${shape.key}：出参席号 ${c.seat} ∈ [0,4)`);
          assert.equal(
            four.includes(c.at),
            true,
            `${shape.key} margin=${seat}：出参 ${c.id}（at=${c.at}）须命中四条外缘线之一（${four.join(",")}）`,
          );
        }
      }
    }
  }
  assert.ok(lineSets.length >= 6, `外缘线集实测 ${lineSets.length} 形 ⇒ 正面覆盖面非空`);

  // ---- 违反形必判红：硬容量之外的席（第 5 席贴边 / 第 6 席进框）在同一把尺上当场破 ----
  let red = 0;
  for (const [label, tasks] of [["F3", f3SpanTwoForward()], ["F4", f4SpanTwoBackflow()], ["真板 eb86d5e8", realTasks()]]) {
    const scene = corridorSceneOf(tasks);
    const minDx = Math.min(...scene.layout.frames.map((f) => f.dx));
    const rightEdge = outerRightEdgeOf(scene.layout);
    const fifth = outerMarginXAt(scene.layout, OUTER_LANE_CAPACITY);
    const sixth = outerMarginXAt(scene.layout, OUTER_LANE_CAPACITY + 1);
    assert.equal(fifth, rightEdge, `${label}：右族第 5 席 x=${fifth} **恰贴**最右框右缘 ${rightEdge} ⇒ 严格不等号不成立（贴边即拒，正是 i7 用严格号的理由）`);
    assert.ok(sixth < rightEdge, `${label}：右族第 6 席 x=${sixth} 已落进框内（< ${rightEdge}）`);
    assert.ok(
      DG_CANVAS_PAD + OUTER_LANE_CAPACITY * DG_CORRIDOR_MARGIN_STEP > minDx,
      `${label}：左族第 5 席 x=${DG_CANVAS_PAD + OUTER_LANE_CAPACITY * DG_CORRIDOR_MARGIN_STEP} 亦不严格在框左缘 ${minDx} 之外 ⇒ 两族同界`,
    );
    const top = Math.min(...scene.layout.frames.map((f) => f.dy));
    const bottom = Math.max(...scene.layout.frames.map((f) => f.dy + f.frameH));
    const hits = canvasHits(`M${sixth},${top + 1} L${sixth},${bottom - 1}`, frameRectsOf(scene.layout));
    assert.ok(hits.length >= 1, `${label}：画在第 6 席 x=${sixth} 的竖腿须判红（实得 ${hitTexts(hits).join(", ") || "零命中 ⇒ 判据空转"}）`);
    red += 1;
  }
  assert.equal(red, 3, `外缘违反形实测 ${red} 枚（F3 / F4 / 真板）都判红`);

  // ---- 超载只共段、不穿模（容量吃紧的那一形：F5a 五枚跨框边 > 4 席）----
  const f5a = f5OuterOverload();
  const rows5 = corridorRowsOf(f5a);
  assert.ok(rows5.length > OUTER_LANE_CAPACITY, `F5a 确有 ${rows5.length} 枚跨框边 > 外缘 4 席 ⇒ 容量吃紧的形在册`);
  const usedXs = new Set(
    rows5.flatMap((r) => r.plan.corridors.filter((c) => c !== null && (c.kind === "ML" || c.kind === "MR")).map((c) => c.at)),
  );
  assert.ok(usedXs.size <= OUTER_LANE_CAPACITY, `五枚边所用的外缘 x 至多 4 条（实得 ${usedXs.size}）⇒ 超出部分只能共段、不新造线`);
  assert.equal(
    rows5.reduce((n, r) => n + canvasHits(r.d, r.obstacles).length, 0),
    0,
    "超载形在 A6 带域障碍集上全 0 命中 ⇒ **不降级为穿模**（X3 丙的几何面）",
  );
  const squeezed = rows5.map((r) => corridorOf(corridorSceneOf(f5a), r.edge, { band: 99, exit: 99, entry: 99 }));
  assert.ok(
    squeezed.every((r) => r.plan.overCapacity === true),
    "越界席号逐枚出声（不得静默）⇒ 超载是**登记**过的共段",
  );
  assert.deepEqual(
    squeezed.map((r) => r.segs.length),
    rows5.map((r) => r.plan.points.length - 1),
    "超载档段数与首席档逐位相同（仍 2k+3 ⇒ 降级只发生在共段，不塌段）",
  );
});

test("G12-④兜底档 ⇔ 0 席 + 判据面未放宽 + 真板集三式容量账：bandSeatsAt(DG_FRAME_GAP_MIN) === 0 ∧ columnSeatsAt(DG_COL_GAP_MIN) === 0 ∧ G5 常量逐字沿用（24px 豁免不另立值）", () => {
  // ---- 两式的兜底档都恰是「0 席」⇒ 兜底宽只服务空带，一有需求即抬宽（式子与档位是同一句话）----
  assert.equal(bandSeatsAt(DG_FRAME_GAP_MIN), 0, `带高式兜底档：${DG_FRAME_GAP_MIN}px 恰可容 0 席`);
  assert.equal(bandHFor(1) > DG_FRAME_GAP_MIN, true, `一席即抬宽：bandHFor(1)=${bandHFor(1)} > 兜底宽 ${DG_FRAME_GAP_MIN}`);
  assert.equal(columnSeatsAt(DG_COL_GAP_MIN), 0, `列宽式兜底档：${DG_COL_GAP_MIN}px 恰可容 0 席`);
  assert.equal(
    DG_LANE_MIN * 2 + DG_LANE_PITCH > DG_COL_GAP_MIN,
    true,
    `一席即抬宽：2·DG_LANE_MIN + DG_LANE_PITCH = ${DG_LANE_MIN * 2 + DG_LANE_PITCH} > 兜底列距 ${DG_COL_GAP_MIN}`,
  );
  // ---- 判据面逐字沿用 G5（本族不另立常量、不放宽半径）----
  assert.equal(G5_SAMPLES, 24, "采样点数沿用 G5");
  assert.equal(G5_NEAR_PX, 1.5, "近距阈值沿用 G5");
  assert.equal(G5_RED_MIN, 2, "判红门槛沿用 G5（≥ 2 枚叠点才算一段对）");
  assert.equal(G5_END_EXEMPT_PX, 24, "共端点豁免半径沿用 G5 = 24px（本枚不另立值）");
  assert.ok(G5_PARALLEL_SIN_MAX > 0 && G5_PARALLEL_SIN_MAX < 1, `平行判据沿用 G5（sin 上界 ${G5_PARALLEL_SIN_MAX}）`);

  // ---- 真板集上的三式容量账（逐式给出实占 / 可容两枚读数，不留「按公式推断」的空洞）----
  const tasks = realTasks();
  const layout = fixedPointOf(tasks).layout;
  layout.bandLanes.forEach((lanes, i) => {
    const gapH = layout.gapH[i];
    assert.ok(
      gapH >= DG_CROSS_MIN * 2 + lanes.length * DG_BUS_PITCH,
      `真板带 ${i}：${lanes.length} 席 ⇒ 带高式（gapH=${gapH}，可容 ${bandSeatsAt(gapH)}）`,
    );
    assert.ok(bandSeatsAt(gapH) >= lanes.length, `真板带 ${i}：实占 ${lanes.length} ≤ 可容 ${bandSeatsAt(gapH)}`);
  });
  assert.ok(layout.bandLanes.reduce((n, b) => n + b.length, 0) >= 1, "真板确有已分配席位的带（空账不构凭据）");
  let columnRows = 0;
  for (const [, grid] of fixedPointOf(tasks).grids) {
    grid.gapW.forEach((gapW, c) => {
      const seats = (grid.lanes[c] ?? []).length;
      assert.ok(gapW >= DG_LANE_MIN * 2 + seats * DG_LANE_PITCH, `真板列 ${c}：${seats} 席 ⇒ 列宽式（gapW=${gapW}，可容 ${columnSeatsAt(gapW)}）`);
      assert.ok(columnSeatsAt(gapW) >= seats, `真板列 ${c}：实占 ${seats} ≤ 可容 ${columnSeatsAt(gapW)}`);
      columnRows += 1;
    });
  }
  assert.ok(columnRows >= 1, `真板列面实测 ${columnRows} 枚通道`);
  const minDx = Math.min(...layout.frames.map((f) => f.dx));
  const rightEdge = outerRightEdgeOf(layout);
  for (let seat = 0; seat < OUTER_LANE_CAPACITY; seat += 1) {
    const at = outerMarginXAt(layout, seat);
    if (seat < DG_OUTER_MARGIN_SEATS) {
      assert.ok(at < minDx, `真板左席 ${seat}：x=${at} 须严格 < 框左缘 ${minDx}`);
    } else {
      assert.ok(at > rightEdge, `真板右席 ${seat}：x=${at} 须严格 > 最右框右缘 ${rightEdge}`);
    }
  }
  assert.ok(
    outerMarginXAt(layout, OUTER_LANE_CAPACITY) <= rightEdge,
    `真板第 5 席 x=${outerMarginXAt(layout, OUTER_LANE_CAPACITY)} 不再严格在外 ⇒ 硬容量 4 在真板读数上成立`,
  );
});

// ---------------------------------------------------------------------------
// G11-走廊①..⑤（REQ-2026-10-14-02 · 增补 n6 · 改造文档 §6 第二枚增补 A1 + A2 / ANCHOR-3 + ANCHOR-4）
// **本枚 = 正极性锚**（与 n4 / n5 的复现锚相反）：被测对象是**新增的两枚纯函数**
// `pickCrossCorridors`（走廊选取 + 容量不等式单点）与 `corridorPath`（2k+3 段发射器）。
// **未接进 `routeCrossFrameEdges`** ⇒ 渲染层仍是现实现（接线 = n7）⇒ 本块只在**测试侧**驱动新函数。
//
// **段数怎么实测（验收 ① 的口径钉）**：`corridorPath` 的发射手径 = **一枚走廊段一枚 C 命令**，
// 相邻段在转角处**共享同一条切线**（角平分线）⇒ 整条线 C¹ 连续、`dSegments(d).length === 2k+3`，
// 且 `C` 枚数 === 段数、`L` 枚数 === 0 —— 「命令枚数」逐字成立（改造文档 §6 第二枚增补 A1）。
//
// **几何同源性**：走廊场景（{@link corridorSceneOf}）是 `planCanvas` 的测试侧同构（框内一次回灌 + 框间带
// **≤ `DG_BAND_MAX_PASSES` 轮定序不动点**、同一序式），每枚边都拿**渲染层**的 path 首末点对账
// ⇒ 两套几何一旦漂移当场红；障碍集取的是渲染 HTML 的 A6 带域集
// （事实源始终是渲染层，③ 的「0 命中」才不是在自造场景里空转）。
//
// **k=3→9 档的载体**：F1..F5 最大跨度 = 2（只有三框）⇒ 9 段档在六形上**结构上不可测**。本块另落一枚
// 四框形 `F6`（board→orch 直跳、中间插 flow / link）把该档真测出来，不留「按公式推断」的空洞。
// ---------------------------------------------------------------------------

/** F6 跨 4 框正向（k=3 ⇒ 2k+3 = 9 段）：框序 board(0) / flow(1) / link(2) / orch(3)，f6a→f6b 直跳三档。 */
const f6SpanThreeForward = () =>
  [["f6a", "board", []], ["f6b", "orch", ["f6a"]], ["f6c", "flow", []], ["f6d", "link", []]].map(canvasRow);

/**
 * F7 列间通道形（**档 1 `CH` 的唯一载体**）：board 三列 `X(0)→Y(1)→R(2)` + 一枚同框长边 `P(0)→R(2)`
 * （列差 2 ⇒ `routeIntraEdges` 判 `long` ⇒ `gapLanes` 回灌出**列通道 lane**），跨框边取自**非末列**的
 * `Y(1)→O` ⇒ `legCorridorLadder` 的档 1 命中 `CH:board:1`。
 * **为何 F1..F6 全测不到 CH**：它们的每枚跨框边源/目标都在**本框首列 / 末列**（各框单列链）⇒ 竖腿只能落
 * `PL`/`PR`/`ML`/`MR`（远档），档 1 的结构前提「本列之右另有列通道」永不成立。本形补上这一档，不留死档。
 */
const f7ColumnChannel = () =>
  [["g7X", "board", []], ["g7P", "board", []], ["g7Y", "board", ["g7X"]], ["g7R", "board", ["g7Y", "g7P"]], ["g7O", "orch", ["g7Y"]]].map(canvasRow);

/** 走廊块夹具 = n3 五形（六枚条目）+ F6（k=3 档的唯一载体）+ F7（档 1 `CH` 的唯一载体）。 */
const corridorFixtures = () => [
  ...canvasFixtures(),
  { key: "F6", label: "F6 跨 4 框正向（k=3 ⇒ 9 段 · 验收 ① 的第三档）", tasks: f6SpanThreeForward() },
  { key: "F7", label: "F7 列间通道形（档 1 CH 的唯一载体 · 长边造列通道 + 非末列出腿）", tasks: f7ColumnChannel() },
];

/**
 * 一枚任务集 → 画布层 `planCanvas` 的**同款入参**（= `renderDependencyGraphSection` 内部那一趟的前导：
 * 约简 → 号序 → 分层 → 管道 → 跨框边 → taskId→project）。镜像与真实现共用这一枚前导 ⇒
 * 「镜像跑的是同一张图」是同一份入参、不是叙述。
 */
function canvasSceneInputsOf(tasks) {
  const graph = buildGraphWithPipelines(tasks);
  const { kept } = transitiveReduce(graph.edges);
  const ordinals = taskOrdinalMap(tasks);
  const layers = layerOfGraph(graph.nodes, ordinals, kept);
  const pipes = graph.pipelines;
  const projectByTask = new Map(graph.nodes.map((n) => [n.taskId, n.projectId]));
  const crossEdges = kept
    .filter((e) => projectByTask.get(e.from) !== projectByTask.get(e.to))
    .map((e) => ({ from: e.from, to: e.to, fromProject: projectByTask.get(e.from), toProject: projectByTask.get(e.to) }));
  return { graph, kept, ordinals, layers, pipes, projectByTask, crossEdges };
}

/**
 * `bandDemandOf` 的测试侧同构：本轮布局上的跨框走线 → 各框间带 `max(busLane)+1`。
 * **定序与真实现同式**（源 projectId 升序 → 源号序 → 目标号序 → from → to）。
 */
function bandDemandOfScene(layout, routes, projectByTask, ordinals) {
  const bandLanes = new Array(Math.max(0, layout.frames.length - 1)).fill(0);
  if (bandLanes.length === 0) return bandLanes;
  const frameIndexOf = new Map(layout.frames.map((f, i) => [f.projectId, i]));
  const owner = (taskId) => projectByTask.get(taskId) ?? "";
  const ordinal = (taskId) => ordinals.get(taskId) ?? 0;
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
    const band = Math.max(0, Math.min(bandLanes.length - 1, s > t ? s - 1 : s));
    bandLanes[band] = Math.max(bandLanes[band] ?? 0, r.busLane + 1);
  }
  return bandLanes;
}

/** `canvasSignature` 的测试侧同构（带高 / 带内 lane 线 / 画布宽高逐字段比，不比对象引用）。 */
const sceneSignature = (layout) =>
  `${layout.gapH.join(",")}\u0000${layout.bandLanes.map((b) => b.join(",")).join("\u0001")}\u0000${layout.width}x${layout.height}`;

/**
 * 一枚任务集 → **走廊可用的画布场景**（`{ layout, grids, routes, bandPasses, bandUnconverged }`，全部画布坐标）。
 * `planCanvas` 的测试侧同构：逐框 `gapLanes` 回灌（= `planPipeGrid`）→ 画布几何 → 平移网格
 * （`frame.dx/dy` + 框内 origin）→ 走线 → 框间带实占回灌 → **≤ `maxPasses` 轮定序不动点**。
 * 出参 `grids` 即 {@link CanvasGrids} 的那份已平移网格（`pickCrossCorridors` 的入参参照系）。
 * `crossDemand = false` ⇒ **退回 n8a 之前的旧式**（列通道只数框内 long 腿）—— 只供 ⑦ 的恒等式反锚
 * 当对照面用，默认 `true` 与实现逐字同式。
 * `maxPasses = 1` ⇒ **退回 n8b 之前的单趟形态**（回灌一趟即返回、不再比签名）—— 只供 ④ 的
 * 「不动点态 ≥ 单趟态」与 ⑫ 的「收敛于第 2 轮 ⇒ 出参逐字等于单趟态」当对照面用。
 */
function corridorSceneOf(tasks, crossDemand = true, maxPasses = DG_BAND_MAX_PASSES) {
  const { kept, ordinals, layers, pipes, projectByTask, crossEdges } = canvasSceneInputsOf(tasks);

  // 回灌 ①：框内列通道 —— 与 `planPipeGrid` 逐字同式（**n8a 框内侧**：long 腿按 `a.col` 与 `b.col−1`
  // 各占一枚 lane，**本框的跨框腿同样占席位**（出口 = 源列之右、入口 = 目标列之左，越界的首 / 末列不计））。
  // 该 demand 只吃 `crossEdges`、与画布几何无关 ⇒ **逐轮同值**，故不动点循环不重算网格（与实现同款）。
  const grids = new Map();
  for (const pipe of pipes) {
    const columns = compressPipeLayers(pipe, layers);
    const base = pipeGridLayout(pipe, columns, ordinals);
    const longs = routeIntraEdges(kept, base).filter((e) => e.kind === "long");
    const gapLanes = new Array(Math.max(0, base.cols - 1)).fill(0);
    for (const e of longs) {
      const a = base.cellOf.get(e.from);
      const b = base.cellOf.get(e.to);
      if (a === undefined || b === undefined) continue;
      gapLanes[a.col] = (gapLanes[a.col] ?? 0) + 1;
      const targetGap = b.col - 1;
      if (targetGap >= 0 && targetGap < gapLanes.length) gapLanes[targetGap] = (gapLanes[targetGap] ?? 0) + 1;
    }
    for (const e of (crossDemand ? crossEdges : [])) {
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
    grids.set(pipe.projectId, pipeGridLayout(pipe, columns, ordinals, { gapLanes, busLaneCount: longs.length }));
  }
  const locals = pipes.map((p) => grids.get(p.projectId) ?? emptyGridForTest());

  const routeAll = (layout) => {
    const canvasGrids = new Map();
    for (const frame of layout.frames) {
      const grid = grids.get(frame.projectId);
      if (grid !== undefined)
        canvasGrids.set(frame.projectId, shiftPipeGrid(grid, frame.dx + DG_GRID_ORIGIN_X, frame.dy + DG_GRID_ORIGIN_Y));
    }
    const intra = [];
    for (const frame of layout.frames) {
      const grid = canvasGrids.get(frame.projectId);
      if (grid !== undefined) intra.push(...routeIntraEdges(kept, grid));
    }
    return { canvasGrids, routes: [...intra, ...routeCrossFrameEdges(crossEdges, { layout, grids: canvasGrids }, intra)] };
  };

  // 回灌 ②：框间带 lane 占用 → **定序不动点**（与 `planCanvas` 同判据：每轮据实占重画几何、比签名，
  // 签名相同即收敛；`maxPasses` 轮内未拿到收敛凭据 ⇒ `bandUnconverged` 出声，不得静默返回）
  let layout = canvasLayout(pipes, locals);
  let done = routeAll(layout);
  let bandPasses = 0;
  let bandUnconverged = true;
  for (let round = 1; round <= maxPasses; round++) {
    bandPasses = round;
    const next = canvasLayout(pipes, locals, { gapLanes: bandDemandOfScene(layout, done.routes, projectByTask, ordinals) });
    if (sceneSignature(next) === sceneSignature(layout)) {
      bandUnconverged = false;
      break;
    }
    layout = next;
    done = routeAll(layout);
  }
  return { layout, grids: done.canvasGrids, routes: done.routes, bandPasses, bandUnconverged };
}

/** 空网格（`pipeGridLayout` 的空管道短路出参在测试侧的同构件 —— 只为 `locals` 定长占位）。 */
const emptyGridForTest = () => pipeGridLayout({ projectId: "empty", nodes: [] }, new Map(), new Map());

/**
 * 一条跨框边 → `{ plan, d, segs, a, b }`（走廊序列 → path 的唯一序式）。
 * `seats` 原样透传给 {@link pickCrossCorridors}（缺省全 0 = 首席；超载档由 ⑤ 显式喂越界席号）。
 */
function corridorOf(scene, edge, seats) {
  const a = scene.grids.get(edge.fromProject)?.cellOf.get(edge.from);
  const b = scene.grids.get(edge.toProject)?.cellOf.get(edge.to);
  assert.ok(a !== undefined && b !== undefined, `两端 cell 须在画布网格内在册（${edge.from} / ${edge.to}）`);
  const plan = pickCrossCorridors({
    fromProject: edge.fromProject,
    toProject: edge.toProject,
    a,
    b,
    grids: scene.grids,
    layout: scene.layout,
    ...(seats === undefined ? {} : { seats }),
  });
  assert.ok(plan !== null, `跨框档成立 ⇒ pickCrossCorridors 不得返回 null（${edge.from}→${edge.to}）`);
  const d = corridorPath(plan.points);
  return { plan, d, segs: dSegments(d), a, b };
}

/**
 * 一枚任务集的全部跨框边 → 逐边 `{ edge, plan, d, segs, obstacles, a, b }`。
 * **几何同源性钉在本函数里**：走廊场景的端点须逐字等于渲染层 path 的首末点。
 */
function corridorRowsOf(tasks) {
  const render = canvasSceneOf(tasks);
  const scene = corridorSceneOf(tasks);
  return render.cross.map((edge) => {
    const row = corridorOf(scene, edge);
    const rp = dPoints(edge.d);
    assert.deepEqual(row.plan.points[0], rp[0], `${edge.from}→${edge.to}：走廊首顶点 === 渲染层起点（I2 端点式未动）`);
    assert.deepEqual(
      row.plan.points[row.plan.points.length - 1],
      rp[rp.length - 1],
      `${edge.from}→${edge.to}：走廊末顶点 === 渲染层终点（I2 端点式未动）`,
    );
    return { edge, obstacles: canvasObstaclesOf(tasks, edge), ...row };
  });
}

/** 走廊门类闭集（改造文档 A2 的 7 类 ⇒ 8 枚取值；出现第 9 枚即本钉红）。 */
const CROSS_CORRIDOR_KINDS = ["CH", "PL", "PR", "ML", "MR", "BD", "PB", "PT"];

test("G11-走廊①统一律段数 = 2k+3：七形逐边实测（顶点 2k+4 · 走廊 2k+3 · 非 null 2k+1 · C 枚数 === 段数 · L 枚数 === 0）", () => {
  let edges = 0;
  const kSeen = new Set();
  const perK = new Map();
  for (const shape of corridorFixtures()) {
    const rows = corridorRowsOf(shape.tasks);
    assert.ok(rows.length >= 1, `${shape.key} 确有跨框边（无跨框边 ⇒ 本形对走廊块空转）`);
    for (const { plan, d, segs, edge } of rows) {
      const k = plan.k;
      assert.equal(k, edge.span, `${edge.from}→${edge.to}：plan.k === 渲染层跨度 |tIdx − sIdx|`);
      assert.ok(k >= 1, "跨框档数恒 ≥ 1（两端同框由 plan 短路 null，不入本面）");
      assert.equal(plan.points.length, 2 * k + 4, `${shape.key}/${edge.from}→${edge.to}：顶点枚数 === 2k+4`);
      assert.equal(plan.corridors.length, 2 * k + 3, "走廊序与段序一一对应 ⇒ 枚数 === 段数 === 2k+3");
      assert.equal(
        plan.corridors.filter((c) => c !== null).length,
        2 * k + 1,
        "非 null 走廊 = 竖腿 k+1 + 带内长横 k = 2k+1（首末短桩不占走廊 ⇒ 由 I2 端点式固定）",
      );
      assert.equal(segs.length, 2 * k + 3, `${shape.key}/${edge.from}→${edge.to}：k=${k} ⇒ 段数实测 === ${2 * k + 3}`);
      const cmds = dCmds(d);
      assert.equal(cmds.filter((c) => c === "C").length, 2 * k + 3, "「命令枚数」逐字成立：一枚走廊段一枚 C ⇒ C 枚数 === 段数");
      assert.equal(cmds.filter((c) => c === "L").length, 0, "走廊形不产 L（转角两段共享同一条切线 ⇒ C¹ 连续）");
      assert.deepEqual(cmds.filter((c) => c !== "M" && c !== "C"), [], "path 命令族 ⊆ {M, C}");
      perK.set(k, (perK.get(k) ?? 0) + 1);
      kSeen.add(k);
      edges += 1;
    }
  }
  // ---- 三档都真被测到（k=3→9 由 F6 承载；F1..F5 只覆盖 5 / 7 两档）----
  assert.deepEqual([...kSeen].sort((a, b) => a - b), [1, 2, 3], "验收 ① 的 k=1→5 / k=2→7 / k=3→9 三档全部实测到");
  assert.ok(perK.get(1) >= 1 && perK.get(2) >= 1 && perK.get(3) >= 1, "每档至少一枚边（不得只靠一档推全式）");
  assert.ok(edges >= 12, `被测跨框边总数 ${edges} ≥ 12（七形边集非空 ⇒ 本锚不空转）`);
});

test("G11-走廊②端点落线：每段骨架两端都落在该段走廊的 at 线上；短桩内端落相邻腿线 ⇒ 固定坐标集合 ⊂ 走廊 at 值集合", () => {
  const kindsSeen = new Set();
  let stubs = 0;
  for (const shape of corridorFixtures()) {
    for (const { plan, segs, edge } of corridorRowsOf(shape.tasks)) {
      assert.equal(segs.length, plan.corridors.length, `${shape.key}/${edge.from}→${edge.to}：段与走廊一一对应（②的前提）`);
      const corridors = plan.corridors.filter((c) => c !== null);
      const atSet = new Set(corridors.map((c) => c.at));
      assert.ok(corridors.every((c) => Number.isInteger(c.at)), "走廊线全整数（与网格同一数值面）");
      plan.corridors.forEach((c, i) => {
        const seg = segs[i];
        assert.ok(seg !== undefined, `第 ${i} 段在册`);
        const p = seg.pts[0];
        const q = seg.pts[seg.pts.length - 1];
        if (c === null) {
          // 短桩：水平、y = 端点 chipMidY；**内端**（靠腿那一头）x = 相邻那枚竖腿的 at
          stubs += 1;
          assert.equal(p[1], q[1], `短桩段 ${i} 须水平（I2：端点 = chip 缘中点 ⇒ 桩只走 x）`);
          const first = i === 0;
          const neighbor = first ? plan.corridors[1] : plan.corridors[plan.corridors.length - 2];
          assert.ok(neighbor !== null && neighbor !== undefined, `短桩 ${i} 的邻段是竖腿`);
          const inner = first ? q : p;
          assert.equal(
            inner[0],
            neighbor.at,
            `短桩 ${i} 的内端 x === 邻腿走廊 at（${neighbor.id}，实得 ${inner[0]} vs ${neighbor.at}）`,
          );
          return;
        }
        kindsSeen.add(c.kind);
        assert.ok(CROSS_CORRIDOR_KINDS.includes(c.kind), `走廊门类 ${c.kind} ⊂ 闭集 ${CROSS_CORRIDOR_KINDS.join("/")}`);
        assert.ok(c.seat >= 0 && c.capacity >= 0, `走廊 ${c.id} 席号 / 容量非负`);
        assert.equal(
          c.axis === "v" ? p[0] === c.at && q[0] === c.at : p[1] === c.at && q[1] === c.at,
          true,
          `段 ${i}（走廊 ${c.id}，轴 ${c.axis}）两端须落在 at=${c.at} 这条线上（实得 [${p}]→[${q}]）`,
        );
      });
      // 逐字面「端点 ⊂ 走廊集合」：每段那条固定坐标都出现在走廊 at 值集合里（短桩的固定量 = 端点 chipMidY）
      segs.forEach((seg, i) => {
        const c = plan.corridors[i];
        const p = seg.pts[0];
        if (c === null) return; // 短桩不占走廊（其固定坐标 = 端点 chipMidY，由上面的邻腿 at 钉覆盖）
        const fixed = c.axis === "v" ? p[0] : p[1];
        assert.equal(fixed, c.at, `段 ${i} 的固定坐标须等于该段走廊 at（${c.id}）`);
        assert.ok(atSet.has(fixed), `段 ${i} 的固定坐标 ${fixed} ⊂ 走廊 at 值集合`);
      });
    }
  }
  assert.equal(stubs % 2, 0, "短桩按边成对（每边首末各一枚）");
  assert.ok(stubs >= 24, `短桩枚数实测 ${stubs} ⇒ 首末桩面被度量到（每边 2 枚）`);
  // `MR`（出口侧远档外缘）在**首席** corpus 里永不被自然取到 —— 出口腿恒先降 `PR`（本框 pad 条带），
  // 只有出口席溢出（seat ≥ 本框 `PR` 之后的外缘档）才够到 `MR`。⇒ 用一枚**显式出口席**探针把该档钉实
  // （与 ⑤ 的超载档同源，但这里只取 `k === 1` 相邻形：`exit:1` 即把出口腿压到画布右外缘）。
  {
    const f1 = corridorFixtures().find((s) => s.key === "F1");
    const scene = corridorSceneOf(f1.tasks);
    const edge = canvasSceneOf(f1.tasks).cross[0];
    const row = corridorOf(scene, edge, { exit: 1 });
    const exitLeg = row.plan.corridors[1];
    assert.ok(exitLeg !== null && exitLeg !== undefined, "出口竖腿在册");
    assert.equal(exitLeg.kind, "MR", `出口席 1 ⇒ 竖腿降到底档 MR（实得 ${exitLeg.kind}）`);
    kindsSeen.add(exitLeg.kind);
  }
  assert.equal(
    ["CH", "PL", "PR", "ML", "MR", "BD"].every((kk) => kindsSeen.has(kk)),
    true,
    `三档降档 + 中段带全部真被取到（实得 ${[...kindsSeen].sort().join("/")}）—— MR 经显式出口席探针、PB/PT 只在带缺失时出现不要求`,
  );
});

test("G11-走廊③canvasHits 恒 0（A6 带域障碍集）：七形全部新路径零命中，且 k≥2 的「直落形」反对照必判红（防空转）", () => {
  let rows = 0;
  let controls = 0;
  let controlsHit = 0;
  for (const shape of corridorFixtures()) {
    for (const row of corridorRowsOf(shape.tasks)) {
      const { edge, plan, d, obstacles, a, b } = row;
      assert.ok(obstacles.length >= 1, `${shape.key}/${edge.from}→${edge.to}：带域障碍集非空（空集 ⇒ ③ 恒真是空转）`);
      const hits = canvasHits(d, obstacles);
      assert.deepEqual(hits, [], `${shape.key} k=${plan.k}：新走廊在 A6 带域障碍集上须 0 命中（实得 ${hitTexts(hits).join(", ")}）`);
      rows += 1;
      // ---- 反对照：只用出口腿「直落」到目标行（不绕外缘 / 不进带）⇒ 必穿中间框 ----
      if (plan.k < 2) continue;
      const exitLeg = plan.corridors[1];
      assert.ok(exitLeg !== null && exitLeg !== undefined, "出口竖腿在册（反对照沿用它那条 x）");
      const straight =
        `M${a.chipRight},${a.chipMidY} L${exitLeg.at},${a.chipMidY}` +
        ` L${exitLeg.at},${b.chipMidY} L${b.chipX},${b.chipMidY}`;
      controls += 1;
      if (canvasHits(straight, obstacles).length > 0) controlsHit += 1;
    }
  }
  assert.ok(rows >= 12, `新路径实测 ${rows} 枚 ⇒ ③ 覆盖面非空`);
  assert.ok(controls >= 1, `k≥2 的直落反对照 ${controls} 枚`);
  assert.ok(
    controlsHit >= 1,
    `反对照至少一枚判红（实得 ${controlsHit}/${controls}）⇒ 判据真的在拦「腿纵穿兄弟框」这一形，③ 的 0 才有意义`,
  );
});

test("G11-走廊④首弧第二控制点 y ≠ y0（件一根因单点消解）+ 转角 2k+2 + 弧不外扩（≤ DG_CORRIDOR_BULGE_MAX < DG_LANE_MIN）", () => {
  assert.equal(DG_CORRIDOR_MIN_RUN, 12, "并段门槛 = 2·arcK_min（arcK 下界 6 ⇒ 12；arcK 函数体不动）");
  assert.ok(
    DG_CORRIDOR_BULGE_MAX < DG_LANE_MIN,
    `外扩上界须严格小于半格通道宽（${DG_CORRIDOR_BULGE_MAX} < ${DG_LANE_MIN}）⇒ 退化弧也顶不到两侧 chip`,
  );
  let oldTotal = 0;
  let oldDefect = 0;
  for (const shape of corridorFixtures()) {
    for (const { plan, segs, a, b } of corridorRowsOf(shape.tasks)) {
      const y0 = plan.points[0]?.[1] ?? Number.NaN;
      const head = segs[0];
      assert.equal(head.kind, "cubic", "首段 = 弧（源 chip 右缘中点水平出射）");
      assert.equal(head.pts[0][1], y0, "起点 y === 源 chipMidY（I2 端点式）");
      assert.equal(head.pts[1][1], y0, "第一控制点仍在 y0 ⇒ 出射切线水平（端点式不变）");
      assert.notEqual(
        head.pts[2][1],
        y0,
        `**第二控制点须离开 y0**（实得 ${head.pts[2][1]} vs ${y0}）—— 旧原语 crossPath 的「贴行横扫」正是两枚控制点全 = y0（下面逐枚对照的就是那一形）`,
      );
      assert.equal(segs.length - 1, 2 * plan.k + 2, `转角枚数 === 2k+2（每转角一枚 C 弧）`);
      segs.forEach((seg, i) => {
        const p = seg.pts[0];
        const q = seg.pts[seg.pts.length - 1];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const bulgeIn = Math.hypot(seg.pts[1][0] - p[0], seg.pts[1][1] - p[1]);
        const bulgeOut = Math.hypot(seg.pts[2][0] - q[0], seg.pts[2][1] - q[1]);
        assert.ok(bulgeIn <= DG_CORRIDOR_BULGE_MAX + 1, `段 ${i} 首控制点外扩越界（${bulgeIn}）`);
        assert.ok(bulgeOut <= DG_CORRIDOR_BULGE_MAX + 1, `段 ${i} 末控制点外扩越界（${bulgeOut}）`);
        assert.ok(bulgeIn <= len / 2 + 1, `段 ${i} 控制点长须 ≤ 半段长（不越过中点 ⇒ 不自交）`);
      });
      // **对照面改吃旧原语**（n7 接线后渲染层不再产「贴行横扫」形 ⇒ 若还从渲染面读数，本锚会在正确的码上判空转）。
      // 同一端点集用未动的 `crossPath` 发射 ⇒ 首弧两控制点**恒** = y0（件一根因的常驻反例）。
      const bandY =
        plan.corridors.find((c) => c !== null && c.axis === "h")?.at ?? Math.round((y0 + b.chipMidY) / 2);
      const oldHead = dSegments(
        crossPath(a.chipRight, a.chipMidY, a.chipRight + DG_LANE_MIN, bandY, b.chipX, b.chipMidY),
      )[0];
      oldTotal += 1;
      if (oldHead !== undefined && oldHead.kind === "cubic" && oldHead.pts[1][1] === y0 && oldHead.pts[2][1] === y0)
        oldDefect += 1;
    }
  }
  assert.ok(oldTotal >= 1, `对照面在七形上确有边可测（实得 ${oldTotal} 枚）`);
  assert.equal(oldDefect, oldTotal, `旧原语的首弧**逐枚**是「两控制点全 = y0」的贴行横扫形（${oldDefect}/${oldTotal}）⇒ 本锚对照的是缺陷形本身，而上面逐边正钉的是新发射器`);
});

test("G11-走廊⑤三档降档 · 外缘硬容量 2+2 · 超载只共段不穿模（X3 丙：越界席号 ⇒ overCapacity 出声、几何面 0 命中且仍 2k+3）", () => {
  assert.equal(DG_OUTER_MARGIN_SEATS * 2, OUTER_LANE_CAPACITY, "外缘硬容量逐字 = 2+2 = 4 席（改造文档 X3 / i7）");
  assert.equal(DG_PAD_STRIP_SEATS, 1, "单条 pad 条带只有一枚中线 ⇒ 1 席");
  const rightEdge = (layout) => DG_CANVAS_GUTTER + layout.frames.reduce((mx, f) => Math.max(mx, f.frameW), 0);
  // 外缘席位离框外缘的**净空**须容得下转角弧的横向外扩（弧相对弦的外扩上界 ≈ `BULGE_MAX/2`）——
  // 本锚是「第二席取 `PAD + PITCH = 22`（离框 2px）⇒ 弧顶进兄弟框」这一形的常驻钉。
  const marginClearanceMin = Math.ceil(DG_CORRIDOR_BULGE_MAX / 2);
  let marginRows = 0;
  let overRows = 0;
  for (const shape of corridorFixtures()) {
    const scene = corridorSceneOf(shape.tasks);
    const edgeMinDx = Math.min(...scene.layout.frames.map((f) => f.dx));
    for (const row of corridorRowsOf(shape.tasks)) {
      const { plan } = row;
      const margins = plan.corridors.filter((c) => c !== null && (c.kind === "ML" || c.kind === "MR"));
      for (const c of margins) {
        marginRows += 1;
        assert.equal(c.capacity, OUTER_LANE_CAPACITY, `外缘走廊 ${c.id} 容量逐字 = 4`);
        assert.ok(c.seat >= 0 && c.seat < OUTER_LANE_CAPACITY, `${c.id} 席号 ∈ [0,4)`);
        assert.equal(
          c.at < edgeMinDx || c.at > rightEdge(scene.layout),
          true,
          `i7 严格不等式：外缘腿 ${c.id}（at=${c.at}）须整个落在全部框之外（框左缘 ${edgeMinDx} / 最右框右缘 ${rightEdge(scene.layout)}）`,
        );
        assert.ok(
          Math.min(Math.abs(c.at - edgeMinDx), Math.abs(c.at - rightEdge(scene.layout))) >= marginClearanceMin,
          `外缘腿 ${c.id}（at=${c.at}）离框外缘的净空须 ≥ ${marginClearanceMin}px（弧外扩上界）—— 否则转角弧顶进兄弟框矩形`,
        );
      }
      if (plan.overCapacity) overRows += 1;
    }
  }
  assert.ok(marginRows >= 1, `k≥2 的长竖腿真落外缘（实得 ${marginRows} 枚）`);
  assert.ok(overRows >= 1, `七形里确有出声超载的边（实得 ${overRows} 枚 —— 现回灌未给新算法留带席位，必须可见）`);

  // ---- X3 丙的执行面：喂越界席号 ⇒ 复用首席（共段），几何面不得变成穿模 ----
  const f3 = f3SpanTwoForward();
  const overEdge = canvasSceneOf(f3).cross.find((r) => r.span === 2);
  assert.ok(overEdge !== undefined, "F3 确有 k=2 边（超载档载体）");
  const scene = corridorSceneOf(f3);
  const base = corridorOf(scene, overEdge);
  const over = corridorOf(scene, overEdge, { exit: 99, entry: 99, band: 99 });
  assert.equal(over.plan.overCapacity, true, "越界席号 ⇒ overCapacity 必须出声（不得静默）");
  assert.equal(over.segs.length, base.segs.length, "超载只降级为**共段**：段数不塌（仍 2k+3）");
  assert.equal(over.segs.length, 2 * overEdge.span + 3, `超载档段数 === ${2 * overEdge.span + 3}（实得 ${over.segs.length}）`);
  const obstacles = canvasObstaclesOf(f3, overEdge);
  assert.deepEqual(canvasHits(over.d, obstacles), [], "超载档在 A6 带域障碍集上仍 0 命中 ⇒ **不降级为穿模**");
  assert.deepEqual(canvasHits(base.d, obstacles), [], "同边首席档同样 0 命中（对照面）");
  assert.deepEqual(
    over.plan.corridors.map((c) => (c === null ? null : c.kind)),
    base.plan.corridors.map((c) => (c === null ? null : c.kind)),
    "复用首席 ⇒ 门类序列与首席档逐位相同（降级只发生在「共段」，不在「换走廊族」）",
  );
  // 外缘席号按**硬容量取模**（4 席一圈）⇒ `margin: 4` 与首席同席 = 共段；`margin: 1` 换到第二席、不越框
  assert.deepEqual(
    corridorOf(scene, overEdge, { margin: 4 }).plan.corridors.map((c) => (c === null ? null : c.at)),
    base.plan.corridors.map((c) => (c === null ? null : c.at)),
    "margin 席号按 4 取模 ⇒ 第 5 席回到首席（共段，不新增第五种线）",
  );
  const second = corridorOf(scene, overEdge, { margin: 1 });
  assert.equal(
    second.plan.corridors.some((c) => c !== null && (c.kind === "ML" || c.kind === "MR")),
    true,
    "margin: 1 确有外缘长竖腿（换席面的前提）",
  );
  assert.deepEqual(canvasHits(second.d, obstacles), [], "第二席同样 0 命中 ⇒ 换席只在留足净空的那两条线之间移动");

  // ---- 多边共段：F5a 五枚回流边挤同一批外缘 ⇒ 所用外缘 x 至多 4 条、且全 0 命中 ----
  const f5a = f5OuterOverload();
  const rows5a = corridorRowsOf(f5a);
  assert.equal(rows5a.length, 5, "F5a 确有 5 枚跨框边（超载档的载体）");
  const xs = new Set(
    rows5a.flatMap((r) =>
      r.plan.corridors.filter((c) => c !== null && (c.kind === "ML" || c.kind === "MR")).map((c) => c.at),
    ),
  );
  assert.ok(xs.size <= OUTER_LANE_CAPACITY, `五枚边所用的外缘 x 至多 ${OUTER_LANE_CAPACITY} 条（实得 ${xs.size}）⇒ 共段而非漂进 chip`);
  assert.deepEqual(
    rows5a.reduce((n, r) => n + canvasHits(r.d, canvasObstaclesOf(f5a, r.edge)).length, 0),
    0,
    "F5a 五枚新路径全 0 命中",
  );
});

test("G11-走廊⑥旧原语未动钉：crossPath 的产出与走廊发射器互不串味（n7 只换出参指向、旧函数体零改动）", () => {
  // n7 的改动面 = `routeCrossFrameEdges` 出参由 `crossPath` **切到** `corridorPath`；旧原语**仍在册可调**、
  // 函数体一行未动 ⇒ 本枚吃的是「两形并存、各走各的」这一结构凭据（加 class = n9 的活，本枚不加）。
  assert.equal(DG_EDGE_CLS, "dg-edge", "DG_EDGE_CLS 逐字未动（n7 不加 class / 不改类名）");
  const tasks = f3SpanTwoForward();
  const cross = canvasSceneOf(tasks).cross;
  assert.equal(cross.length >= 1, true, "渲染层仍画跨框边（接线只换形、不换枚数 ⇒ 丢边会当场红在本枚）");
  const d = cross[0]?.d ?? "";
  const pts = dPoints(d);
  const head = pts[0];
  const tail = pts[pts.length - 1];
  assert.ok(head !== undefined && tail !== undefined, "渲染层跨框 path 首末点在册（I2 端点式可读）");
  // ---- 接线已发生的反向凭据：渲染层命令族 ⊆ {M, C}（旧形含 L ⇒ 现形不含）----
  assert.deepEqual(
    dCmds(d).filter((c) => c !== "M" && c !== "C"),
    [],
    `渲染层跨框 path 命令族须 ⊆ {M, C}（走廊发射器不产 L，实得 ${dCmds(d).join("")}）`,
  );
  // ---- 旧原语仍产旧形（同一端点集、函数体未动 ⇒ 与走廊形可辨、互不串味）----
  const oldD = crossPath(head[0], head[1], head[0] + DG_LANE_MIN, Math.round((head[1] + tail[1]) / 2), tail[0], tail[1]);
  assert.ok(dCmds(oldD).includes("L"), `旧原语 crossPath 未被走廊形污染（须仍含 L，实得 ${dCmds(oldD).join("")}）`);
  assert.notEqual(oldD, d, "同一端点：旧原语形 ≠ 渲染层走廊形（两形并存，接线不是「把旧函数改了」）");
  assert.equal(oldD.startsWith(`M${head[0]},${head[1]}`), true, "旧原语端点式 = 走廊形端点式（件三 I2 单源未动）");
  // ---- 测试侧走廊场景（`corridorSceneOf`）与渲染层同源：起点逐字相等 ----
  const newD = corridorOf(corridorSceneOf(tasks), cross[0]).d;
  assert.equal(dCmds(newD).includes("L"), false, "走廊发射器不产 L（本枚锚吃的是新函数、不是旧 path）");
  assert.equal(newD.startsWith(`M${head[0]},${head[1]}`), true, "新路径起点 = 渲染层起点（I2 端点定义式单源未动）");
});

// ---------------------------------------------------------------------------
// G11-走廊⑦⑧⑨（REQ-2026-10-14-02 · 承接轨② n8a · 改造文档 §6 第二枚增补 A4「框内侧」）：
// **列通道 demand 计入本框的跨框腿** —— `gapLanes` 此前只数框内 long 腿 ⇒ 该列 `CH` 的 `capacity` 恒 1
// ⇒ `exitSeat % capacity` 恒 0 ⇒ 同列多条跨框腿**共段**（第三处穿模机制）。本枚只在 `planPipeGrid`
// 的列级计数式上追加跨框腿（出口 = 源列之右、入口 = 目标列之左，首 / 末列越界不计），
// `pipeGridLayout` 的 `budget.gapLanes` / `busLaneCount` 消费面**只喂不改**、回灌**仍是一次**。
// 三枚钉：**⑦ 恒等式反锚**（跨框腿 demand 为空 ⇒ 列通道 / 框宽高 / 全部 path 逐字不变 ⇒
//   现三枚单 project 夹具的坐标字面锚零翻案）· **⑧ 计入钉**（同一列 1 条 intra-long + 1 条本框跨框腿
//   ⇒ 该列 `lanes.length === 2` ∧ `gapW` 照式抬宽 ∧ 渲染层列距同值；F8b 两腿**分席**而旧式**共段**）
// · **⑨ 不漂钉**（跨框腿落的通道线 x ∈ 本框该列 `gapW` 区间内 —— 不漂出通道、不落进右邻列 chip，
//   超载席号复用首席同样不破）。
// ---------------------------------------------------------------------------

/**
 * F8 列通道 demand 形（**框内侧的最小载体**）：board 三列 `X(0)→Y(1)→R(2)` + 一枚框内长边
 * `P(0)→R(2)`（列 1 已占 1 席）+ 一枚取自**非末列**的跨框边 `Y(1)→O`（列 1 再占 1 席 = **2 席**）。
 * 与 F7 同形 —— F7 只管「档 1 命中不命中」，本形管「命中之前先预算了几席」。
 */
const f8ChannelDemand = () =>
  [["g8X", "board", []], ["g8P", "board", []], ["g8Y", "board", ["g8X"]], ["g8R", "board", ["g8Y", "g8P"]], ["g8O", "orch", ["g8Y"]]].map(canvasRow);

/**
 * F8b 两腿共列分席形：F8 再加一枚同源跨框边 `Y(1)→Q` ⇒ 列 1 的 demand = 1 long + 2 跨框 = **3 席**。
 * 「`capacity > 1` ⇒ `exitSeat % capacity` 真分席」只有本形测得到（旧式两腿恒落同一 x = 共段）。
 */
const f8ChannelTwoLegs = () =>
  [["g8X", "board", []], ["g8P", "board", []], ["g8Y", "board", ["g8X"]], ["g8R", "board", ["g8Y", "g8P"]], ["g8O", "orch", ["g8Y"]], ["g8Q", "orch", ["g8Y"]]].map(canvasRow);

/**
 * 场景网格面 = ⑦ 恒等式的对账面（逐框列几何 + 全部 path 的 `d` 字面，一趟对账两样东西）。
 * `laneCounts` 单独列一枚：它是「本列预留了几席」的直接读数（`gapW` 是它的派生结果，两者都得等）。
 */
const gridFaceOf = (scene) => ({
  grids: [...scene.grids.entries()].map(([pid, g]) => ({
    pid,
    cols: g.cols,
    rows: g.rows,
    gapW: [...g.gapW],
    laneCounts: g.lanes.map((l) => l.length),
    lanes: g.lanes.map((l) => [...l]),
    width: g.width,
    height: g.height,
  })),
  routes: scene.routes.map((r) => `${r.from}\u2192${r.to}#${r.kind}:${r.d}`),
});

/** 渲染层列距（chip **局部**左缘升序的相邻差 − `DG_NODE_W`）⇒ 与网格 `gapW` 同一判据面。 */
const renderColGapsOf = (tasks, projectId) => {
  const frame = canvasSceneOf(tasks).frames.find((f) => f.projectId === projectId);
  assert.ok(frame !== undefined, `${projectId} 框在渲染层在册`);
  const xs = [...new Set([...frame.cells.values()].map((c) => c.left))].sort((a, b) => a - b);
  return xs.slice(1).map((x, i) => x - xs[i] - DG_NODE_W);
};

/** 跨框 path 的**出口腿 x** = 顶点 1 的横坐标（`corridorPath` 每段一枚 C ⇒ 顶点落在下标 `3i`）。 */
const exitLegX = (d) => dPoints(d)[3]?.[0];

/** 场景内全部跨框腿所用的出口 x 集合（「分席 / 共段」的读数面）。 */
const crossLegXs = (scene) => new Set(scene.routes.filter((r) => r.kind === "cross").map((r) => exitLegX(r.d)));

test("G11-走廊⑦恒等式反锚：跨框腿 demand 为空 ⇒ 列通道 / 框宽高 / 全部 path 逐字不变（本枚只动「有跨框腿」那一侧）", () => {
  // 现三枚夹具全单 project ⇒ `crossEdges` 恒空 ⇒ 新式（计入跨框腿）与旧式（只数 long 腿）**必须逐字相等**
  // ⇒ 全量既有坐标字面锚零翻案（这是「本枚不改单 project 形态」的机械凭据，不靠人工核）。
  for (const [label, tasks] of [["样本076bbb84", sample076bbb84()], ["压力14节点", g45StressTasks()], ["busReuse", busReuseTasks()]]) {
    assert.equal(canvasSceneOf(tasks).cross.length, 0, `${label} 确为零跨框边形（「demand 为空」的前提成立）`);
    const on = gridFaceOf(corridorSceneOf(tasks, true));
    const off = gridFaceOf(corridorSceneOf(tasks, false));
    assert.ok(on.routes.length >= 5, `${label} 走线面对账非空（空面比恒等 = 假凭据，实得 ${on.routes.length} 条）`);
    assert.ok(on.grids.reduce((n, g) => n + g.lanes.length, 0) >= 1, `${label} 通道面在册（零通道夹具测不出「等」的意义）`);
    assert.deepEqual(on, off, `${label}：跨框腿 demand 为空 ⇒ 列通道 / 宽高 / path 逐字相等`);
  }
  // ---- 两头不许空转：真有跨框腿的形上两式**必分叉**（否则本枚是空改）----
  for (const [label, tasks] of [["F8", f8ChannelDemand()], ["F8b", f8ChannelTwoLegs()]]) {
    assert.equal(canvasSceneOf(tasks).cross.length >= 1, true, `${label} 确有跨框边`);
    assert.notEqual(
      JSON.stringify(gridFaceOf(corridorSceneOf(tasks, true))),
      JSON.stringify(gridFaceOf(corridorSceneOf(tasks, false))),
      `${label}：跨框腿在场 ⇒ 新式网格必与旧式分叉（demand 真被计入）`,
    );
  }
});

test("G11-走廊⑧计入钉：一列 1 条 intra-long + 1 条本框跨框腿 ⇒ lanes.length === 2 ∧ gapW === max(DG_COL_GAP_MIN, 2·DG_LANE_MIN + 2·DG_LANE_PITCH)（F8b 分席 · 旧式共段）", () => {
  const gapWFor = (n) => Math.max(DG_COL_GAP_MIN, DG_LANE_MIN * 2 + n * DG_LANE_PITCH);
  // ---- F8：列 1 从 1 席抬到 2 席（本枚的全部语义就在这一枚加数上）----
  const f8 = f8ChannelDemand();
  const on8 = corridorSceneOf(f8, true).grids.get("board");
  const off8 = corridorSceneOf(f8, false).grids.get("board");
  assert.equal(on8.cols, 3, "F8 board 三列（列 1 = long 腿与跨框腿的公共出口列）");
  assert.equal(on8.lanes[1].length, 2, `F8 列 1 通道席数 === 2（1 条 intra-long + 1 条跨框腿，实得 ${on8.lanes[1]?.length}）`);
  assert.equal(on8.gapW[1], gapWFor(2), `F8 列 1 gapW === ${gapWFor(2)}（实得 ${on8.gapW[1]}）`);
  assert.equal(off8.lanes[1].length, 1, "旧式同列只 1 席（long 腿那一席 ⇒ 跨框腿无席可分，正是共段的结构因）");
  assert.equal(off8.gapW[1], gapWFor(1), `旧式列宽 === ${gapWFor(1)}`);
  assert.equal(on8.width - off8.width, on8.gapW[1] - off8.gapW[1], "框宽增量 === 该列通道增量（宽度只从 gapW 来，无第二处加数）");
  assert.equal(on8.height, off8.height, `带高不受本枚影响（height 逐字相等，实得 ${on8.height}）`);
  assert.deepEqual([...renderColGapsOf(f8, "board")], [...on8.gapW], "渲染层列距 === 网格 gapW（多预算的那一席真留出来了）");
  // ---- F8b：同列两条跨框腿 ⇒ 三席 ⇒ **分席**（旧式两腿共段）----
  const f8b = f8ChannelTwoLegs();
  const onB = corridorSceneOf(f8b, true);
  const offB = corridorSceneOf(f8b, false);
  const gridB = onB.grids.get("board");
  assert.equal(gridB.lanes[1].length, 3, `F8b 列 1 席数 === 3（1 long + 2 跨框腿，实得 ${gridB.lanes[1]?.length}）`);
  assert.equal(gridB.gapW[1], gapWFor(3), `F8b 列 1 gapW === ${gapWFor(3)}（实得 ${gridB.gapW[1]}）`);
  assert.deepEqual([...renderColGapsOf(f8b, "board")], [...gridB.gapW], "F8b 渲染层列距 === 网格 gapW");
  const legsOf = (scene) =>
    scene.routes
      .filter((r) => r.kind === "cross")
      .map((r) => `${r.from}\u2192${r.to}@${exitLegX(r.d)}`);
  const onLegs = crossLegXs(onB);
  const offLegs = crossLegXs(offB);
  assert.equal(onLegs.size, 2, `demand 计入后两腿**分席**（所用出口 x 两枚，实得 ${[...onLegs].join(",")}）`);
  assert.equal(offLegs.size, 1, `旧式两腿**共段**（出口 x 同一枚，实得 ${[...offLegs].join(",")} ⇒ 本锚的真凭据是「由 1 变 2」）`);
  assert.deepEqual(
    legsOf(onB).map((s) => Number(s.split("@")[1])).sort((a, b) => a - b),
    [...gridB.lanes[1]].slice(0, 2).sort((a, b) => a - b),
    "两腿所用 x === 本列预算线的前两席（分席取自预留面、不是凭空造坐标）",
  );
});

test("G11-走廊⑨不漂钉：跨框腿落的通道线 x ∈ 本框该列 gapW 区间（第二 / 第三席与超载复用首席同样不漂出通道）", () => {
  /** 一枚走廊序里的 `CH` 档（档 1 = 列间通道，本钉只管这一档）。 */
  const chOf = (plan) => plan.corridors.filter((c) => c !== null && c.kind === "CH");
  const measured = { seats: 0, rendered: 0 };
  for (const [label, tasks] of [["F8", f8ChannelDemand()], ["F8b", f8ChannelTwoLegs()], ["F7", f7ColumnChannel()]]) {
    const scene = corridorSceneOf(tasks);
    for (const edge of canvasSceneOf(tasks).cross) {
      const grid = scene.grids.get(edge.fromProject);
      const a = grid?.cellOf.get(edge.from);
      assert.ok(grid !== undefined && a !== undefined, `${label}/${edge.from}→${edge.to}：源框网格与 cell 在册`);
      const chief = corridorOf(scene, edge, { exit: 0 }).plan;
      const capacity = chOf(chief)[0]?.capacity ?? 0;
      // 「跨框腿自己占的那一席须在」= 本枚的正面读数（旧式 capacity 恒 1 ⇒ 当场红）
      assert.ok(capacity >= 2, `${label}/${edge.from}→${edge.to}：档 1 容量 ≥ 2（intra-long 1 席 + 跨框腿 ≥ 1 席，实得 ${capacity}）`);
      // 席号面：首席 / 第二席 / 末席 / 越界席 —— 凡落在 `CH` 的 x 都须在本框通道区间内
      for (const seat of [0, 1, capacity - 1, capacity, capacity + 5]) {
        const row = corridorOf(scene, edge, { exit: seat });
        for (const ch of chOf(row.plan)) {
          const col = grid.lanes.findIndex((l) => l.includes(ch.at));
          assert.ok(col >= 0, `${label}/${edge.from}→${edge.to} 席 ${seat}：通道线 x=${ch.at} 必是本框某列的预算线（不得凭空造 x）`);
          const left = (grid.colX[col] ?? 0) + DG_NODE_W;
          const right = grid.colX[col + 1];
          assert.ok(right !== undefined, `${label}：CH 只在本列右邻有列时成立（末列档 1 结构性不可用）`);
          assert.ok(
            ch.at > left && ch.at < right,
            `${label}/${edge.from}→${edge.to} 席 ${seat}：通道段 x=${ch.at} 须 ∈ (${left}, ${right}) = 本框 gapW=${grid.gapW[col]} 的通道区间`,
          );
          measured.seats += 1;
        }
      }
      // 越界席号的降级形态 = **复用首席**（X3 丙：只共段、不穿模）⇒ 既不新增线种、也不漂出通道
      const last = corridorOf(scene, edge, { exit: capacity + 5 });
      assert.equal(last.plan.overCapacity, true, `${label}/${edge.from}→${edge.to}：越界席号须出声（不得静默）`);
      assert.deepEqual(
        chOf(last.plan).map((c) => c?.at),
        chOf(chief).map((c) => c?.at),
        `${label}：越界席复用首席 x（共段而非穿模 —— 本枚抬的是容量、不是降级形态）`,
      );
      // 渲染层同判据：真画出的那条腿也须落在本列通道区间内
      const rendered = scene.routes.find((r) => r.kind === "cross" && r.from === edge.from && r.to === edge.to);
      assert.ok(rendered !== undefined, `${label}/${edge.from}→${edge.to}：渲染层确有该跨框 path`);
      const x = exitLegX(rendered.d);
      const right = grid.colX[a.col + 1];
      assert.ok(
        x > a.chipRight && (right === undefined || x < right),
        `${label}/${edge.from}→${edge.to}：渲染层出口腿 x=${x} 须 > 本 chip 右缘 ${a.chipRight}${right === undefined ? "（末列无右邻）" : ` 且 < 右邻列 chip 左缘 ${right}`}`,
      );
      if (right !== undefined) measured.rendered += 1;
    }
  }
  assert.ok(measured.seats >= 6, `席号面实测 ${measured.seats} 枚通道段 ≥ 6（本钉非空转）`);
  assert.ok(measured.rendered >= 3, `渲染层实测 ${measured.rendered} 条腿 ≥ 3（两面对账都真跑到）`);
});

// ---------------------------------------------------------------------------
// G11-走廊⑩⑪⑫⑬（REQ-2026-10-14-02 · 承接轨② n8b · 改造文档 §6 第二枚增补 A4「画布侧」· 风险 X1 / X2）：
// `planCanvas` 的**框间带**预算由「一趟回灌」抬为 **≤ `DG_BAND_MAX_PASSES`（= 3）轮的定序不动点** ——
// 每轮 = 走线 → 据实占重算各带 lane 数 → `canvasLayout` 重画几何 → **比签名**；签名相同即收敛 break，
// 上限内未拿到收敛凭据 ⇒ 出参 `bandUnconverged` **出声**（X1 政策 = 定序 + 固定轮次 + 未收敛即出声）。
// **不动点只动画布侧**：框内侧（n8a）的列通道 demand 只吃 `crossEdges`、与本框 `dx/dy` 无关 ⇒ 逐轮同值，
// 故本块的轮次读数全部落在 `layout.gapH` / `bandLanes` 上，不重算网格。
// 四枚钉：**⑩ 确定性**（乱序 tasks + 乱序 crossEdges 两形都逐字段等 ⇒ X1「非确定」的反面；另逐字钉上限 = 3）
//   · **⑪ 轮次可观测**（**线性区**（该带实占 ≥ 1 席）带 lane 增量 1 席 ⇒ `bandH` 增量恰 `DG_BUS_PITCH`；
//     空席带落 `DG_FRAME_GAP_MIN` 兜底宽 —— 是既有消费面公式 `max` 的结构行为、本枚只喂不改，故另钉一档；
//     且夹具**收敛于第 2 轮**、第 1 轮真把带抬过 ⇒ 防「跑满 3 轮当作收敛」掩盖未收敛）
//   · **⑫ 未收敛出声**（轮次上限收到 1 ⇒ 真实现的出声支被跑到、几何面与 cap=2 逐字段等 ⇒ 出声只改标记；
//     cap=2 即不出声 ⇒ 判据真挂在「不收敛」上）
//   · **⑬ 单调不缩**（现三夹具 + 走廊七形 + 真板的不动点态 `height` ≥ 单趟态、`width` 逐字等 ⇒ X2 反锚）。
// **凭据面 = 真实现 `planCanvas`**（本枚起该函数随 `CanvasPlan` 一并导出）；测试侧镜像 `corridorSceneOf`
//   在 {@link fixedPointOf} 里逐字段对账 ⇒ 镜像一旦漂移，⑩⑪⑫⑬ 一起红（同源钉随本族四枚钉同批跑，不另立一族）。
// **实测分野登记**：自然夹具上「跑满上限仍未收敛」这一支**结构上不可达**（六千形搜索 ⇒ 带跨框边的形一律
//   收敛于第 2 轮），故 ⑫ 经 `planCanvas` 的 `maxPasses` 测试缝取证 —— 无该缝则 X1 的出声判据是一条永不被
//   执行的分支（生产调用不传该参 ⇒ 行为逐字不变）。
// ---------------------------------------------------------------------------

/** 不动点出参的**面值面**（逐字段、不比对象引用 —— `canvasLayout` 每轮新建对象）。 */
const planFaceOf = (plan) => ({
  frames: plan.layout.frames.map((f) => [f.projectId, f.dx, f.dy, f.frameW, f.frameH, f.gridW, f.gridH]),
  gapH: [...plan.layout.gapH],
  bandLanes: plan.layout.bandLanes.map((b) => [...b]),
  width: plan.layout.width,
  height: plan.layout.height,
  routes: plan.routes.map((r) => `${r.from}\u2192${r.to}#${r.kind}:${r.d}@\u03bb${r.lambda}\u03bc${r.mu}y${r.yb}b${r.busLane}`),
  bandPasses: plan.bandPasses,
  bandUnconverged: plan.bandUnconverged,
});

/** 真实现那一趟：`tasks` → `planCanvas` 入参（= `renderDependencyGraphSection` 内部同一前导）。 */
function realPlanOf(tasks, maxPasses = DG_BAND_MAX_PASSES) {
  const { kept, ordinals, layers, pipes, projectByTask, crossEdges } = canvasSceneInputsOf(tasks);
  return planCanvas(pipes, kept, layers, ordinals, crossEdges, projectByTask, maxPasses);
}

/**
 * **不动点态（含同源对账）**：真实现 `planCanvas` 与测试侧镜像 `corridorSceneOf` 在同一 cap 下逐字段相等
 * ⇒ 本块四枚钉的凭据始终落在真实现上，镜像只作对照面（漂移当场红）。
 */
function fixedPointOf(tasks, maxPasses = DG_BAND_MAX_PASSES) {
  const real = realPlanOf(tasks, maxPasses);
  const scene = corridorSceneOf(tasks, true, maxPasses);
  assert.deepEqual(
    planFaceOf(real),
    planFaceOf({
      layout: scene.layout,
      routes: scene.routes,
      bandPasses: scene.bandPasses,
      bandUnconverged: scene.bandUnconverged,
    }),
    `镜像与真实现逐字段同源（cap=${maxPasses}）`,
  );
  return real;
}

/** 本块的对账夹具集 = 现三枚单 project 形 + 走廊七形 + 真板集。 */
const bandFixtures = () => [
  ["样本076bbb84", sample076bbb84()],
  ["压力14节点", g45StressTasks()],
  ["busReuse", busReuseTasks()],
  ...corridorFixtures().map((f) => [f.key, f.tasks]),
  ["真板 eb86d5e8", realTasks()],
];

/**
 * 一枚夹具的**喂数面**：`{ pipes, locals }` —— `locals` 取自不动点出参的**局部**网格（S1 那份），
 * 故 ⑪ 的「多喂一席」用的就是本形自己的实占数、不凭空造网格。
 */
function canvasFeedsOf(tasks) {
  const { pipes } = canvasSceneInputsOf(tasks);
  const plan = realPlanOf(tasks);
  return { pipes, locals: pipes.map((p) => plan.grids.get(p.projectId) ?? emptyGridForTest()), plan };
}

/** 带高消费面公式（改造文档 §2.3 —— 本枚**只喂不改**，故此式即「未改公式」的反证面）。 */
const bandHFor = (n) => Math.max(DG_FRAME_GAP_MIN, DG_CROSS_MIN * 2 + n * DG_BUS_PITCH);

test("G11-走廊⑩确定性钉（X1 反面）：乱序 tasks / 乱序 crossEdges 两形跑不动点 ⇒ layout 与 routes 逐字段相等；轮次上限常量 === 3", () => {
  assert.equal(DG_BAND_MAX_PASSES, 3, "X1「固定轮次」= 3 轮逐字钉（抬 / 降上限须连带翻本钉）");
  for (const [label, tasks] of bandFixtures()) {
    const base = fixedPointOf(tasks);
    // ---- (a) 乱序入参（沿用现「乱序入参出参逐字段相等」锚形）----
    assert.deepEqual(planFaceOf(fixedPointOf([...tasks].reverse())), planFaceOf(base), `${label}：tasks 乱序 ⇒ 不动点出参逐字段相等`);
    assert.equal(
      renderDependencyGraphSection([...tasks].reverse()).html,
      renderDependencyGraphSection(tasks).html,
      `${label}：渲染层逐字相等（同一份不动点经 SSR 出口）`,
    );
    // ---- (b) 只乱序 `crossEdges`：本枚新增取数面的定序凭据 ----
    const inputs = canvasSceneInputsOf(tasks);
    const shuffled = planCanvas(
      inputs.pipes,
      inputs.kept,
      inputs.layers,
      inputs.ordinals,
      [...inputs.crossEdges].reverse(),
      inputs.projectByTask,
    );
    assert.deepEqual(
      planFaceOf(shuffled),
      planFaceOf(base),
      `${label}：crossEdges 乱序 ⇒ 不动点出参逐字段相等（带实占的定序在取数内自持、不吃入参序）`,
    );
  }
});

test("G11-走廊⑪轮次可观测：线性区（≥1 席）带 lane 增量 1 席 ⇒ bandH 增量恰 DG_BUS_PITCH（空席带落兜底宽另钉一档）；夹具**收敛于第 2 轮**且第 1 轮真抬过带（防「跑满 3 轮当作收敛」）", () => {
  const measured = [];
  const flooredTags = [];
  for (const [label, tasks] of [["F1", f1AdjacentForward()], ["F3", f3SpanTwoForward()], ["F8b", f8ChannelTwoLegs()], ["真板", realTasks()]]) {
    const { pipes, locals, plan } = canvasFeedsOf(tasks);
    assert.equal(plan.bandPasses, 2, `${label}：收敛于第 2 轮（实得 ${plan.bandPasses}）—— 「跑满上限即算收敛」的读法在此当场红`);
    assert.equal(plan.bandUnconverged, false, `${label}：第 2 轮拿到收敛凭据 ⇒ 不出声`);
    assert.ok(plan.layout.gapH.length >= 1, `${label}：框间带在册（零带夹具测不出轮次意义）`);
    // ---- 第 1 轮非空转：无预算构图态各带全落兜底宽 ⇒ 回灌真改变过布局 ----
    const bare = canvasLayout(pipes, locals);
    assert.ok(bare.gapH.every((h) => h === DG_FRAME_GAP_MIN), `${label}：构图态各带 === ${DG_FRAME_GAP_MIN}（兜底宽 ⇒ 第 1 轮回灌确已改写过布局）`);
    // ---- 消费面公式未改 + **线性区**增量恰一席 ----
    //   公式 `bandH = max(DG_FRAME_GAP_MIN, 2·DG_CROSS_MIN + n·DG_BUS_PITCH)`：`n = 0` 时 `2·DG_CROSS_MIN = 28 < 32`
    //   ⇒ 空席带落**兜底宽**，该档 +1 席的增量被 `max` 吃掉一截（32 → 40 只涨 8）—— 这是既有消费面公式的
    //   结构性行为（本枚**只喂不改**公式），不是本枚引入。故「增量恰 `DG_BUS_PITCH`」的增量钉挂在**线性区**
    //   （`n ≥ 1`）；兜底档改钉「仍 === 兜底宽 ∧ 涨后仍 === 公式值」，两档都不许静默放行。
    const seats = plan.layout.bandLanes.map((b) => b.length);
    const linear = [];
    const floored = [];
    plan.layout.gapH.forEach((h, i) => {
      const n = seats[i] ?? 0;
      assert.equal(h, bandHFor(n), `${label} 带 ${i}：gapH === 消费面公式（${n} 席 ⇒ ${h}）`);
      const plus = seats.map((v, j) => (j === i ? v + 1 : v));
      const hPlus = canvasLayout(pipes, locals, { gapLanes: plus }).gapH[i];
      assert.equal(hPlus, bandHFor(n + 1), `${label} 带 ${i}：+1 席后带高仍 === 同一公式值（只喂、不改公式）`);
      if (n >= 1) {
        assert.equal(hPlus - h, DG_BUS_PITCH, `${label} 带 ${i}（线性区 ${n} 席）：+1 席 ⇒ bandH 增量恰 DG_BUS_PITCH（实得 ${hPlus} − ${h} = ${hPlus - h}）`);
        linear.push(`${label}#${i}@${n}`);
      } else {
        assert.equal(h, DG_FRAME_GAP_MIN, `${label} 带 ${i}：空席带 === 兜底宽 ${DG_FRAME_GAP_MIN}（实得 ${h}）`);
        floored.push(`${label}#${i}`);
      }
    });
    for (const tag of linear) measured.push(tag);
    flooredTags.push(...floored);
  }
  assert.ok(measured.length >= 4, `线性区实测 ${measured.length} 枚带（${measured.join("、")}）≥ 4（增量钉非空转）`);
  assert.ok(flooredTags.length >= 1, `兜底档实测 ${flooredTags.length} 枚带 ≥ 1（两档分流都真跑到，${flooredTags.join("、")}）`);
  // ---- 跨夹具读数：F1 带 0 = 1 席 / F8b 带 0 = 2 席 ⇒ 席数增量 1、bandH 增量恰 12 ----
  const f1 = fixedPointOf(f1AdjacentForward());
  const f8b = fixedPointOf(f8ChannelTwoLegs());
  assert.equal(f1.layout.bandLanes[0].length, 1, "F1 带 0 实占 1 席");
  assert.equal(f8b.layout.bandLanes[0].length, 2, "F8b 带 0 实占 2 席（n8a 抬列通道、本枚抬框间带）");
  assert.equal(f8b.layout.gapH[0] - f1.layout.gapH[0], DG_BUS_PITCH, "带 lane 数增量 = 1 ⇒ bandH 增量恰 DG_BUS_PITCH");
});

test("G11-走廊⑫未收敛出声锚：cap 收到 1 ⇒ 真实现出参带可见出声标记（几何面与 cap=2 逐字段等 ⇒ 出声只改标记；cap=2 即不出声 ⇒ 判据真挂在不收敛上）", () => {
  for (const [label, tasks] of [["F1", f1AdjacentForward()], ["F3", f3SpanTwoForward()], ["F8b", f8ChannelTwoLegs()], ["真板", realTasks()]]) {
    const loud = fixedPointOf(tasks, 1);
    const calm = fixedPointOf(tasks, 2);
    assert.equal(loud.bandPasses, 1, `${label}：cap=1 ⇒ 只跑一轮回灌`);
    assert.equal(loud.bandUnconverged, true, `${label}：一轮内未拿到收敛凭据 ⇒ **必须出声**（不得静默返回）`);
    assert.equal(calm.bandUnconverged, false, `${label}：同一形第 2 轮拿到凭据 ⇒ 不出声（出声不是「cap 没跑满」的副产物）`);
    assert.deepEqual(
      planFaceOf(loud),
      { ...planFaceOf(calm), bandPasses: 1, bandUnconverged: true },
      `${label}：出声只改两枚标记，几何面与走线逐字段不变（本枚不引入第二套布局形态）`,
    );
    // ---- 「本轮必变」的凭据面：无预算构图态与回灌态签名不等 ⇒ cap=1 确是「未确认收敛」而非「无需求」 ----
    const { pipes, locals } = canvasFeedsOf(tasks);
    assert.notEqual(
      sceneSignature(canvasLayout(pipes, locals, { gapLanes: [1] })),
      sceneSignature(canvasLayout(pipes, locals)),
      `${label}：带预算 +1 席必然改写签名 ⇒ 不动点的比对面有效（签名恒等 = 本钉空转）`,
    );
  }
  // ---- 零跨框的一侧：第 1 轮即达不动点 ⇒ 不出声（不得把「无带可抬」误报成发散） ----
  for (const [label, tasks] of [["样本076bbb84", sample076bbb84()], ["压力14节点", g45StressTasks()], ["busReuse", busReuseTasks()]]) {
    const plan = fixedPointOf(tasks, 1);
    assert.equal(plan.bandPasses, 1, `${label}：零跨框 ⇒ 首轮回灌即等值`);
    assert.equal(plan.bandUnconverged, false, `${label}：零跨框不得误报未收敛`);
  }
});

test("G11-走廊⑬单调不缩（X2 反锚）：现三夹具 + 走廊七形 + 真板的不动点态 layout.width/height ≥ 单趟态（只松不紧；width 逐字等）", () => {
  for (const [label, tasks] of bandFixtures()) {
    const one = fixedPointOf(tasks, 1); // 单趟态 = n8b 之前的旧形态（一趟回灌、不验证）
    const fp = fixedPointOf(tasks); // 不动点态（cap = DG_BAND_MAX_PASSES）
    assert.equal(fp.layout.width, one.layout.width, `${label}：宽度只从框宽来 ⇒ 逐字等（本枚不抬 gapW，坐标字面锚不连带翻案）`);
    assert.ok(fp.layout.height >= one.layout.height, `${label}：height 只松不紧（不动点 ${fp.layout.height} vs 单趟 ${one.layout.height}）`);
    assert.equal(fp.layout.gapH.length, one.layout.gapH.length, `${label}：带枚数不随轮次变`);
    fp.layout.gapH.forEach((h, i) => {
      assert.ok(h >= (one.layout.gapH[i] ?? 0), `${label} 带 ${i}：带高同样只松不紧（${h} vs ${one.layout.gapH[i]}）`);
    });
    // ---- 同一参照系下的走线面：枚数不许多不许少（回灌只松不紧 ⇒ 不得吞边、也不得造第二枚 path） ----
    assert.equal(fp.routes.length, one.routes.length, `${label}：路由枚数逐字等`);
  }
});

// ---------------------------------------------------------------------------
// G14（v0.10.6 追加件 n9 · REQ-2026-10-14-02 · 改造文档 §6 增补节第二块「追加件」）：
// **跨管道连线单独配色** —— 用户裁定「只改线条颜色、图例不加行」。
// 改动面 = 跨框出参的 `cls` 换一枚常量 + CSS 叠一条 `stroke` ⇒ 走线几何零改动。
// 五枚钉：① 类名常量面（含 `dg-edges` 子串负钉）· ② 出参类名分席（cross 正钉 + intra 反向钉）
//   · ③ CSS 面（恰一条 / 只 stroke / 零几何声明 / 零字面色值 / 图例枚数不变）
//   · ④ 三面同源（类面 === 几何面 === 文本面）· ⑤ 反证钉（归一前后 `d` 序列逐字相等）。
// ---------------------------------------------------------------------------

/** 追加件的夹具集 = 「跨框在场」四形 + 「跨框为零」的反证侧（取夹具口径与 {@link N2对锚②} 同款）。 */
const g14Fixtures = () => [
  ["pipe6（跨框 4 / 框内 1）", pipe6Tasks()],
  ["约简+跨框组合（跨框 4 / 框内 1）", foldReduceTasks()],
  ["跨管道同集（跨框 2 / 框内 0）", crossReduceTasks()],
  ["F3 跨 2 框正向（k=2 档）", f3SpanTwoForward()],
  ["样本076bbb84（零跨框 ⇒ 追加类必不出场的一侧）", sample076bbb84()],
];

test("G14-①类名常量面：DG_EDGE_CROSS_CLS 首 token = DG_EDGE_CLS、恰两枚 class、不含子串 dg-edges；DG_EDGE_CLS 逐字未动", () => {
  assert.equal(DG_EDGE_CLS, "dg-edge", "基础类名逐字未动（追加件不改它，只在其下并列第二枚导出）");
  assert.equal(DG_EDGE_CROSS_CLS, "dg-edge dg-edge-cross", "跨框类名 = 基础类 + 追加类（渲染侧直嵌、零拼接）");
  assert.equal(
    DG_EDGE_CROSS_CLS.split(" ")[0],
    DG_EDGE_CLS,
    "首 token = DG_EDGE_CLS ⇒ 基础规则 `.dg-links path` 照命中（新选择器只叠加 stroke、不替换基础规则）",
  );
  assert.equal(DG_EDGE_CROSS_CLS.split(" ").length, 2, "恰两枚 class（第三枚 = 样式面失控）");
  assert.equal(DG_EDGE_CROSS_CLS.includes("dg-edges"), false, "类名不得含子串 dg-edges（否则 `.dg-edges` 边清单的在场判据被图形面染色）");
});

test("G14-②出参类名分席：cross 出参 cls = DG_EDGE_CROSS_CLS（正钉）、intra 出参仍 = DG_EDGE_CLS（反向钉，不得被顺手换色）", () => {
  let seenCross = 0;
  for (const [label, tasks] of g14Fixtures()) {
    const routes = corridorSceneOf(tasks).routes;
    const paths = edgePaths(renderDependencyGraphSection(tasks).html);
    assert.equal(routes.length, paths.length, `${label}：模型出参枚数 === 画布 path 枚数（分席对账前先确认同一池）`);
    const modelCross = routes.filter((e) => e.kind === "cross");
    const modelIntra = routes.filter((e) => e.kind !== "cross");
    seenCross += modelCross.length;
    for (const e of modelCross)
      assert.equal(e.cls, DG_EDGE_CROSS_CLS, `${label}：跨框出参 cls 须指向 DG_EDGE_CROSS_CLS（${e.from}→${e.to}）`);
    for (const e of modelIntra) {
      assert.equal(e.cls, DG_EDGE_CLS, `${label}：框内出参 cls 逐字未动（${e.from}→${e.to}）`);
      assert.equal(e.cls.includes("dg-edge-cross"), false, `${label}：框内出参不得带追加类（反向钉）`);
    }
    // 渲染面同席：出参序（intra 在前、cross 在后）= HTML 出现序 ⇒ class 由渲染侧逐字直嵌
    paths.forEach((p, i) =>
      assert.equal(p.cls, routes[i].cls, `${label}：第 ${i} 枚 path 的 class === 同序出参的 cls（零 kind 判断、零拼接）`),
    );
    assert.equal(crossClsCount(paths), modelCross.length, `${label}：类面跨框枚数 === 模型面跨框枚数`);
  }
  assert.ok(seenCross > 0, "空转守卫：确有跨框边进过类面（全为零时上面那枚正钉会空转）");
});

test("G14-③CSS 面：跨框着色规则恰一条、声明闭集 = 只一枚 stroke、引既有 token、零几何声明；基础规则与图例枚数逐字不变", () => {
  const css = renderPage({ title: "t", active: "features", bodyHtml: "" });
  const block = pipeCssBlock();
  const lines = block.split("\n").filter((l) => l.trim().startsWith(".dg-links path"));
  assert.equal(lines.length, 2, "`.dg-links path` 族规则恰两条 = 基础 + 跨框追加（第三行即第二份着色面）");
  assert.deepEqual(
    lines.map((l) => l.trim()),
    [
      ".dg-links path { fill: none; stroke: var(--b-line); stroke-width: 1.5px; }",
      ".dg-links path.dg-edge-cross { stroke: var(--b-brand); }",
    ],
    "两条逐字在册：基础规则原样未动（fill / stroke-width 不得搬进追加条），追加条只叠一枚 stroke",
  );
  assert.deepEqual(
    cssDecls(cssRule(block, ".dg-links path.dg-edge-cross")),
    ["stroke: var(--b-brand)"],
    "追加条声明闭集 = 单枚 stroke（零几何声明 ⇒ 不改走线、不做线宽 / 虚实分级）",
  );
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(lines[1]), false, "追加条零字面色值（`:447` 同族负钉不破）");
  assert.equal((css.match(/--b-brand:/g) ?? []).length, 1, "不新增 :root 条目（--b-brand 的定义面仍恰一枚，本条只消费）");
  assert.equal(
    cssDecls(cssRule(block, ".dg-links path")).length,
    3,
    "cssRule 的选择器逐字取数仍恰命中基础条（追加条不得被算成第二份基础规则）",
  );
  // 待裁 ⑥ 已裁 = 图例不加行：跨框换色不新增图例条目 ⇒ 枚数与图例行字面均逐字不变
  const legendRow = (html) => /<p class="hint dg-legend-row">([\s\S]*?)<\/p>/.exec(html)[1];
  const withCross = renderDependencyGraphSection(pipe6Tasks()).html;
  const noCross = renderDependencyGraphSection(sample076bbb84()).html;
  assert.equal((withCross.match(/class="dg-legend"/g) ?? []).length, NODE_STATE_ORDER.length, "图例枚数 = NODE_STATE_ORDER 枚数（不加行）");
  assert.equal(legendRow(withCross), legendRow(noCross), "图例行逐字未变（跨框侧与单管道侧同形 ⇒ 未为连线色另立条目）");
  assert.equal(withCross.includes("dg-edge-cross"), true, "空转守卫：对照面确有跨框线（图例不变不是「没东西可着色」）");
});

test("G14-④三面同源钉：类面（path class）=== 几何面（端点落框）=== 文本面（`.dg-edges` 清单）=== 模型面（本质跨框边）", () => {
  for (const [label, tasks] of g14Fixtures()) {
    const { html } = renderDependencyGraphSection(tasks);
    const { list, cross, cls, paths } = crossFaceCounts(html);
    const model = crossKeptEdges(tasks).length;
    assert.equal(cls, cross, `${label}：类面 === 几何面（换了色却没连线、或连了线却没换色，都在此判红）`);
    assert.equal(cls, list, `${label}：类面 === 文本面（清单列几条，就有几条带追加类）`);
    assert.equal(cls, model, `${label}：类面 === 本质跨框边枚数（模型面，四面对齐）`);
    assert.ok(cls <= paths, `${label}：类面 ≤ 画布 path 总枚数（框内线共用同一出口，只许少不许多）`);
  }
  // 非空转两侧：跨框在场形与单管道形各钉一面
  const combo = crossFaceCounts(renderDependencyGraphSection(pipe6Tasks()).html);
  assert.deepEqual([combo.cls, combo.cross, combo.list, combo.intra], [4, 4, 4, 1], "跨框侧三面同为 4（框内 1 枚不带追加类）");
  const none = crossFaceCounts(renderDependencyGraphSection(sample076bbb84()).html);
  assert.deepEqual([none.cls, none.cross, none.list], [0, 0, 0], "单管道侧三面同零");
  assert.ok(none.paths > 0, "同零不是「整图没画」（框内线照在，只是都不带追加类）");
});

test("G14-⑤反证钉：把追加类归一回基础类后 path 枚数与 `d` 序列逐字相等 ⇒ 本件纯描边、不改走线", () => {
  for (const [label, tasks] of g14Fixtures()) {
    const { html } = renderDependencyGraphSection(tasks);
    const after = edgePaths(html);
    // 「改色前」的形态 = 同一份 HTML 里把跨框 class 换回基础 class —— 本件的全部 DOM 面改动就这一处
    const before = edgePaths(html.split(`class="${DG_EDGE_CROSS_CLS}"`).join(`class="${DG_EDGE_CLS}"`));
    assert.deepEqual(before.map((e) => e.d), after.map((e) => e.d), `${label}：归一前后 d 序列逐字相等（走线 / 顺序 / 端点零变化）`);
    assert.equal(before.length, after.length, `${label}：归一前后 path 枚数相等（换色不增删线）`);
    assert.deepEqual(
      after.map((e) => e.d),
      corridorSceneOf(tasks).routes.map((e) => e.d),
      `${label}：画布 d 序列 === 模型走线 d 序列（同序 ⇒ class 不参与几何）`,
    );
    const tags = html.match(/<path[^>]*>/g) ?? [];
    assert.ok(tags.length > 0, `${label}：空转守卫 —— 确有 path 可核`);
    for (const t of tags)
      assert.match(t, /^<path class="[^"]*" d="[^"]*"\/>$/, `${label}：path 仍只带 class + d 两枚属性（追加类写在 class 值内，不得另起属性）：${t}`);
  }
});

// ---------------------------------------------------------------------------
// G15 · 承接轨③ n8d「入点侧向让位」（REQ-2026-10-14-02 · 改造文档 §6 承接节）
//
// 残差定性（n8c 取证）：真板 `G13-真板复现②` 的唯一红是**单点端口汇聚**（两条跨框腿共用同一枚目标 chip
// 左缘中点的水平入点短桩，重叠 134px）—— A5 三式由构造成立、实占 ≤ 可容 ⇒ **不是容量欠账**，
// 加席 / 抬宽无从下手。合规修法只有一条：**接近段侧向让位**（同端口多条边各走自己的接近 y，末尾再各自
// 弯回 chip 中点），使任意两条只在距端点 ≤ `G5_END_EXEMPT_PX = 24px` 内合流。
//
// 本块三枚锚各自钉一层：
//   ① 形状与降级（纯函数面 `layerCrossApproach`）：首席（秩 0）逐字不动；分层只改末两枚顶点之前；
//      凡「放不下」（幅度超界 / 折点间距不足 / 落进障碍集）⇒ 返回原顶点序 = **复用首席的共段形态**
//      （X3 政策丙：降级为共段、绝不降级为穿模）—— 与 `pickCrossCorridors` 超载处置同形。
//   ② 件三回归面（全部夹具、全部路由）：连线两端仍 = 源 chip 右缘中点 → 目标 chip 左缘中点，偏差 ≤ ±1px；
//      让位**不得**把入点沿 chip 缘分布。
//   ③ 真板实占 + 确定性：真板确有 ≥1 条让位线在位（接近段 y ≠ chipMidY、其末段长 ≤ 24px 豁免圈内）——
//      防「写了机制没人走到」；乱序入参 ⇒ 走线读数逐字段同形（秩由既定序式导出，不含输入序噪声）。
//
// **本块零放宽**：`G5_*` 五枚常量、`G5_END_EXEMPT_PX`、`GOLDEN_BEFORE` 与 `G13②` 的「必为 0」极性均未动。
// ---------------------------------------------------------------------------

/** 一枚 k=1 走廊顶点序的最小形状（`pickCrossCorridors` 出参形：短桩 → 出口腿 → 带 → 入口腿 → 短桩）。 */
const g15Points = (o = {}) => {
  const { x0 = 100, y0 = 60, exitX = 150, bandY = 300, entryX = 200, x1 = 300, y1 = 60 } = o;
  return [[x0, y0], [exitX, y0], [exitX, bandY], [entryX, bandY], [entryX, y1], [x1, y1]];
};
const G15_FREE = () => true;
const g15Tail = (pts) => pts.slice(pts.length - 4);

/** 段首 / 段末点（`dSegments` 对弧给 4 枚控制点、对直给 2 枚端点 ⇒ 两端恒在 `[0]` 与 `[len-1]`）。 */
const segBegin = (seg) => seg.pts[0];
const segEnd = (seg) => seg.pts[seg.pts.length - 1];

/**
 * 一条 path 的**让位读数**：`null` = 首席直通（接近段即入点短桩、落 chip 中线）；
 * 否则 = `{ y, lead }` —— 分层接近线的 y 与其后那枚短桩的长度。
 *
 * 分层形的段尾三枚恒为 **水平接近段（y=让位线）→ 竖直到位折点 → 水平短桩（y=chip 中线）**；
 * 未分层形的段尾三枚是「带内长横 → 入口竖腿 → 入点短桩」—— 两者靠**折点长度 ≤ 让位幅度上界**
 * 与**短桩长恰 = 折点提前量**两式分开（单看「倒数第三段水平」会误读未分层形）。
 */
const approachReadOf = (d) => {
  const segs = dSegments(d);
  const run = segs[segs.length - 3];
  const jog = segs[segs.length - 2];
  const stub = segs[segs.length - 1];
  if (run === undefined || jog === undefined || stub === undefined) return null;
  const yR = segBegin(run)[1];
  const yEnd = segEnd(stub)[1];
  if (segEnd(run)[1] !== yR || yR === yEnd) return null; // 接近段须水平、且不在中线上
  if (segBegin(jog)[0] !== segEnd(jog)[0]) return null; // 折点段须竖直
  const off = Math.abs(segBegin(jog)[1] - segEnd(jog)[1]);
  if (off > DG_APPROACH_MAX_OFF) return null;
  const lead = Math.abs(segEnd(stub)[0] - segBegin(stub)[0]);
  if (Math.abs(lead - DG_APPROACH_LEAD) > 1) return null;
  if (Math.abs(segBegin(jog)[0] - segEnd(run)[0]) > 1) return null;
  return { y: yR, lead };
};

test("G15-①形状与降级：`layerCrossApproach` 首席恒等 / 秩 1–3 交替让位 / 三形放不下各回原顶点序（共段不穿模）+ 末段长 ∈ 豁免圈", () => {
  // ---- 常量耦合面（本单元只导出几何量，判据常量在测试侧 ⇒ 不等式只能在这里钉）----
  assert.ok(DG_APPROACH_LEAD <= G5_END_EXEMPT_PX, `折点提前量 ${DG_APPROACH_LEAD} ≤ 共端点豁免半径 ${G5_END_EXEMPT_PX} ⇒ 分层后各边自己的入点短桩整段落进豁免圈（否则 G13② 无从翻 0）`);
  assert.ok(DG_APPROACH_LEAD >= DG_CORRIDOR_MIN_RUN, `折点提前量 ${DG_APPROACH_LEAD} ≥ 最小可用段长 ${DG_CORRIDOR_MIN_RUN} ⇒ 让位后的末弧不退化成尖角`);
  assert.equal(DG_APPROACH_MAX_OFF, DG_NODE_H / 2, `让位幅度上界 === 自身行 chip 半高 ${DG_NODE_H / 2} ⇒ 分层线不出自身行 chip 带（该 x 区间本行结构性无 chip）`);
  assert.equal(DG_APPROACH_MAX_OFF % DG_APPROACH_SEAT_PITCH, 0, "上界为席距整数倍 ⇒ 交替分层恰得 ±1 / ±2 共 4 席");

  // ---- ① 首席恒等（秩 0 ⇒ 返回入参本身，走线逐字不变）----
  const pts = g15Points();
  assert.equal(layerCrossApproach(pts, 0, G15_FREE), pts, "秩 0 = 首席 ⇒ 返回同一数组引用（单入边端口零改动）");

  // ---- ② 秩 1–3：来带侧优先、两侧交替、按档抬升（`bandY > y1` ⇒ 来带在下）----
  const bendX = 300 - DG_APPROACH_LEAD;
  const seats = [
    [1, 60 + DG_APPROACH_SEAT_PITCH],
    [2, 60 - DG_APPROACH_SEAT_PITCH],
    [3, 60 + 2 * DG_APPROACH_SEAT_PITCH],
  ];
  for (const [rank, yApp] of seats) {
    const out = layerCrossApproach(pts, rank, G15_FREE);
    assert.deepEqual(out.slice(0, pts.length - 2), pts.slice(0, pts.length - 2), `秩 ${rank}：末两枚顶点之前逐字不动`);
    assert.deepEqual(
      g15Tail(out),
      [[200, yApp], [bendX, yApp], [bendX, 60], [300, 60]],
      `秩 ${rank}：接近线落 y=${yApp}、折点 x=${bendX}、末段仍水平入 (300,60)`,
    );
    assert.deepEqual(out[out.length - 1], [300, 60], `秩 ${rank}：末点 = 目标左缘中点（件三由构造不动）`);
    assert.equal(Math.abs(yApp - 60) <= DG_APPROACH_MAX_OFF, true, `秩 ${rank}：让位幅度在界内`);
    const layered = corridorPath(out);
    assert.equal((layered.match(/L/g) ?? []).length, 0, `秩 ${rank}：走廊形照旧不产 L（C¹ 连续不因分层破）`);
    assert.equal(dSegments(layered).length, dSegments(corridorPath(pts)).length + 2, `秩 ${rank}：分层恰添两段（接近横段 + 折点竖段），塌缩律未吃掉新顶点`);
    assert.equal(approachReadOf(layered)?.y, yApp, `秩 ${rank}：渲染层读数与顶点序同值（本锚的读法不是纸面形）`);
  }

  // ---- ③ 三形「放不下」⇒ 各回原顶点序（降级为共段，不穿模、不硬挤）----
  assert.equal(layerCrossApproach(pts, 5, G15_FREE), pts, "秩 5 ⇒ |off| 越上界 ⇒ 原顶点序（席位不足 = 共段，与 X3 丙同形）");
  assert.equal(layerCrossApproach(pts, 1, () => false), pts, "障碍挡住 ⇒ 原顶点序（分层几何落进 §2.3 障碍集即让位作废）");
  assert.equal(layerCrossApproach(g15Points({ entryX: bendX }), 1, G15_FREE)?.length, 6, "折点与腿重合（分层横段 < 最小可用段长）⇒ 不硬挤");
  assert.equal(layerCrossApproach(g15Points({ entryX: 300 }), 1, G15_FREE)?.length, 6, "腿正对左缘 ⇒ 无接近段可分层，原样返回");
  // 长档形（k=2 ⇒ 顶点 8 枚）同样只在末两枚顶点之前动手：中段的外缘长竖与带内线逐字不动
  const wide = [
    [100, 60], [150, 60], [150, 200], [40, 200], [40, 300], [200, 300], [200, 60], [300, 60],
  ];
  const wideOut = layerCrossApproach(wide, 1, G15_FREE);
  assert.deepEqual(wideOut.slice(0, wide.length - 2), wide.slice(0, wide.length - 2), "k=2 形：末两枚之前逐字不动（外缘长竖与带内长横不被让位面牵动）");
  assert.deepEqual(g15Tail(wideOut), [[200, 67], [282, 67], [282, 60], [300, 60]], "k=2 形：让位只发生在入口侧");
  assert.equal(approachReadOf(corridorPath(wideOut))?.y, 67, "k=2 形的渲染层读数与顶点序同值");

  // ---- ④ 障碍判据的矩形须盖住转角弧外扩（保守面，不含 `DG_CORRIDOR_BULGE_MAX` 即漏量）----
  let box = null;
  layerCrossApproach(pts, 1, (x0, x1, y0, y1) => {
    box = [x0, x1, y0, y1];
    return true;
  });
  assert.ok(box !== null, "分层在位 ⇒ 障碍判据确被调用（不是写完没查）");
  assert.equal(box[0], 200 - DG_CORRIDOR_BULGE_MAX, `矩形左界 = min(entryX,bendX,x1) − 外扩上界（实得 ${box[0]}）`);
  assert.equal(box[1], 300 + DG_CORRIDOR_BULGE_MAX, "矩形右界盖到端点 x1 + 外扩上界");
  assert.equal(box[2], 60 - DG_CORRIDOR_BULGE_MAX, "矩形下界含 chip 中线一侧的外扩余量");
  assert.equal(box[3], 60 + DG_APPROACH_SEAT_PITCH + DG_CORRIDOR_BULGE_MAX, "矩形上界含接近线一侧的外扩余量");
});

test("G15-②件三回归面（让位不得动端点）：真板 + 走廊七形 + 组合夹具的全部路由两端 = 源右缘中点 → 目标左缘中点（≤ ±1px）", () => {
  const shapes = [
    ["真板 eb86d5e8", realTasks()],
    ...g14Fixtures(),
    ...corridorFixtures().map((f) => [`${f.key}`, f.tasks]),
  ];
  const midY = (c) => (c.rect[2] + c.rect[3]) / 2;
  let routes = 0;
  let cross = 0;
  let layered = 0;
  for (const [label, tasks] of shapes) {
    const scene = canvasSceneOf(tasks);
    const chip = new Map(scene.chips.map((c) => [c.taskId, c]));
    for (const r of scene.routes) {
      const a = chip.get(r.from);
      const b = chip.get(r.to);
      assert.ok(a !== undefined && b !== undefined, `${label}/${r.from}→${r.to}：两端 chip 矩形在册`);
      const p = dPoints(r.d);
      const first = p[0];
      const last = p[p.length - 1];
      assert.ok(
        Math.abs(first[0] - a.rect[1]) <= 1 && Math.abs(first[1] - midY(a)) <= 1,
        `${label}/${r.from}→${r.to}：起点 = 源 chip 右缘中点（实得 ${first}，期望 ${[a.rect[1], midY(a)]}）`,
      );
      assert.ok(
        Math.abs(last[0] - b.rect[0]) <= 1 && Math.abs(last[1] - midY(b)) <= 1,
        `${label}/${r.from}→${r.to}：**件三** 终点 = 目标 chip 左缘中点（实得 ${last}，期望 ${[b.rect[0], midY(b)]}）`,
      );
      const read = r.fromProject === r.toProject ? null : approachReadOf(r.d);
      if (read !== null) {
        layered += 1;
        assert.ok(Math.abs(read.y - midY(b)) > 1, `${label}/${r.from}→${r.to}：让位线不得仍贴 chip 中线`);
        assert.ok(Math.abs(read.lead - DG_APPROACH_LEAD) <= 1, `${label}/${r.from}→${r.to}：让位后的入点短桩长 ${read.lead} 须恰 = 折点提前量 ${DG_APPROACH_LEAD}（≤ 豁免半径 ${G5_END_EXEMPT_PX}）`);
      }
      routes += 1;
      if (r.fromProject !== r.toProject) cross += 1;
    }
  }
  assert.ok(routes >= 40 && cross >= 8, `覆盖面非空：路由 ${routes} 枚 / 跨框 ${cross} 枚 ⇒ 本锚不是「无面可测」`);
  assert.ok(layered >= 1, `让位在实测面真发生（${layered} 枚跨框边走分层接近线）⇒ 件三钉的不是恒等式的空壳`);
});

test("G15-③真板实占 + 确定性：汇聚端口至多一条首席直通、其余各让一档（叠线 0 的成因面）；乱序入参读数逐字段同形", () => {
  const sceneOf = (tasks) => {
    const scene = canvasSceneOf(tasks);
    const chip = new Map(scene.chips.map((c) => [c.taskId, c]));
    return scene.cross.map((r) => ({
      key: `${r.from}→${r.to}`,
      port: chip.get(r.to).rect[0] + "," + (chip.get(r.to).rect[2] + chip.get(r.to).rect[3]) / 2,
      approach: approachReadOf(r.d)?.y ?? "mid",
      d: r.d,
    }));
  };
  const rows = sceneOf(realTasks());
  const byPort = new Map();
  for (const r of rows) {
    const list = byPort.get(r.port);
    if (list) list.push(r);
    else byPort.set(r.port, [r]);
  }
  const busy = [...byPort].filter(([, v]) => v.length >= 2);
  assert.ok(busy.length >= 1, "真板确有汇聚端口（≥2 枚跨框边同落一枚 chip 左缘中点）⇒ 本锚不空转");
  for (const [port, list] of busy) {
    const direct = list.filter((r) => r.approach === "mid");
    assert.ok(
      direct.length <= 1,
      `端口 ${port}：贴中线的直通形至多一枚（其余须各自让位一档，实得 ${direct.length} 枚：${list.map((r) => `${r.key}@${r.approach}`).join(" / ")}）`,
    );
    const yields = list.filter((r) => r.approach !== "mid");
    if (yields.length >= 1)
      assert.equal(new Set(yields.map((r) => r.approach)).size, yields.length, `端口 ${port}：各让位边接近线两两不同 y（让位若塌回同档 = 叠线复发）`);
  }
  // ---- 确定性：乱序入参 ⇒ 同集合的 (边, 端口, 接近线) 读数逐条相等 ----
  const shuffled = [...realTasks()].reverse();
  const a = [...rows].sort((p, q) => (p.key < q.key ? -1 : 1));
  const b = [...sceneOf(shuffled)].sort((p, q) => (p.key < q.key ? -1 : 1));
  assert.deepEqual(b.map((r) => `${r.key}|${r.port}|${r.approach}`), a.map((r) => `${r.key}|${r.port}|${r.approach}`), "乱序 tasks ⇒ 每条跨框边的端口与接近线读数逐字段相等（秩不含输入序噪声）");
});
