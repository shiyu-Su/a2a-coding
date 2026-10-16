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
  DG_EDGE_CLS,
  DG_EDGE_CROSS_CLS,
  DG_NODE_W,
  DG_NODE_H,
  DG_BADGE_H,
  DG_FRAME_BORDER,
  DG_FRAME_TITLE_H,
  DG_FRAME_PAD,
  DG_GRID_ORIGIN_X,
  DG_GRID_ORIGIN_Y,
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
import { layoutGraphGuarded } from "../dist/graph-elk.js";
import { devOf, overlap, penCount } from "./helpers/geom-assert.mjs";

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
// v0.10.7 承接轨 N6：**行为级取数面**（改造文档 §4「行为级四把尺」的喂数侧）
//
// 本面对象 = **渲染出参 HTML / SVG**，不碰任何布局函数或路由原语。几何尺度只从 `.dg-canvas`
// 的 style 里那六枚 CSS 变量反解（`--dg-nw/--dg-nh/--dg-bh/--dg-fb/--dg-fth/--dg-fp`）——
// 渲染层下发它们正是为了让 CSS 与 JS 同源，测试面据此同源 ⇒ §2.3 的退休清单落地、`DG_*` 常量
// 从导出面消失之后，本面照跑（这是「降级为行为级」的实际含义，不只是把断言换成人话）。
// ---------------------------------------------------------------------------

/** 画布 style 里的六枚几何 CSS 变量（缺任一枚即红 —— 本面唯一的尺度源不得静默兜底）。 */
function canvasVarsOf(html) {
  const m = /<div class="dg-canvas" style="([^"]*)">/.exec(html);
  assert.ok(m !== null, "画布层在场且带 style（行为级取数面的入口）");
  const vars = {};
  for (const kv of m[1].split(";")) {
    const i = kv.indexOf(":");
    if (i < 0) continue;
    const key = kv.slice(0, i).trim();
    if (key.startsWith("--dg-")) vars[key] = parseFloat(kv.slice(i + 1));
  }
  for (const key of ["--dg-nw", "--dg-nh", "--dg-bh", "--dg-fb", "--dg-fth", "--dg-fp"])
    assert.ok(Number.isFinite(vars[key]), `画布下发几何变量 ${key}（本面唯一尺度源，缺即判红不兜底）`);
  return vars;
}

/**
 * 渲染出参 HTML → 行为级场景 `{ vars, originX, originY, frames, chips, paths }`（全部**画布坐标**）。
 *
 * - `frames` = 每枚 `details.pipe` 的外缘固定盒；`cells` = 该框子树内的**局部** cell（复用 `renderedCells`）。
 * - `chips` = cell 局部值 → 画布盒：`x = 框 left + originX + cell.left`、`y = 框 top + originY + 角标带 + cell.top`，
 *   宽高取 CSS 变量 —— 与渲染层同一换算，但加数全部来自出参。
 * - `titleBand` = 该框的标题带盒（外缘起、到网格原点止）；「容器标题不被节点压住」（真机验收清单 #4）
 *   在 DOM 侧就是 chip 盒与它的零交。
 */
function behaviorSceneOf(html) {
  const vars = canvasVarsOf(html);
  const originX = vars["--dg-fb"] + vars["--dg-fp"];
  const originY = vars["--dg-fb"] + vars["--dg-fth"];
  const box = /<div class="dg-canvas" style="width:(-?\d+(?:\.\d+)?)px;height:(-?\d+(?:\.\d+)?)px/.exec(html);
  assert.ok(box !== null, "画布固定盒声明 width / height（零出血判据的容器）");
  const canvas = /<div class="dg-canvas"[^>]*>\s*<svg class="dg-links">([\s\S]*?)<\/svg>/.exec(html);
  assert.ok(canvas !== null, "画布级边线层恰一枚 svg.dg-links（全部 path 同池）");
  const paths = edgePaths(canvas[1]);
  const frames = [];
  for (const chunk of html.split('<details class="pipe" open style="').slice(1)) {
    const body = chunk.slice(0, chunk.indexOf("</details>"));
    const m = /^left:(-?\d+(?:\.\d+)?)px;top:(-?\d+(?:\.\d+)?)px;width:(-?\d+(?:\.\d+)?)px;height:(-?\d+(?:\.\d+)?)px">\s*<summary>管道 ([^（]+)（/.exec(
      body,
    );
    assert.ok(m !== undefined, `框 = 固定盒四枚几何字面（left/top/width/height）+ summary（实得 ${body.slice(0, 80)}…）`);
    frames.push({ projectId: m[5], box: { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }, cells: renderedCells(body) });
  }
  const chips = [];
  for (const f of frames) {
    for (const [taskId, c] of f.cells) {
      chips.push({
        taskId,
        projectId: f.projectId,
        box: { x: f.box.x + originX + c.left, y: f.box.y + originY + vars["--dg-bh"] + c.top, w: vars["--dg-nw"], h: vars["--dg-nh"] },
        titleBand: { x: f.box.x, y: f.box.y, w: f.box.w, h: originY },
        frame: f.box,
      });
    }
  }
  return {
    vars,
    originX,
    originY,
    canvas: { w: Number(box[1]), h: Number(box[2]) },
    frames,
    chips,
    paths,
  };
}

/** 行为级场景里的 taskId → chip 盒（`undefined` = 该 id 不在任何框内，调用侧断言存在）。 */
const chipOf = (scene, taskId) => scene.chips.find((c) => c.taskId === taskId);

/**
 * 折线首末点 → 两端 chip（**几何反查**，不读 `d` 里的 id 也不读模型）：
 * 首点须贴在某盒的右缘中点、末点贴在某盒的左缘中点（容差 0.6px = 出参两位小数收拢的余量）。
 * 找不到 ⇒ null（调用侧判红，不得静默跳过）。
 */
function chipByEndpoint(scene, p, side) {
  return (
    scene.chips.find((c) => {
      const x = side === "from" ? c.box.x + c.box.w : c.box.x;
      return Math.abs(p[0] - x) < 0.6 && Math.abs(p[1] - (c.box.y + c.box.h / 2)) < 0.6;
    }) ?? null
  );
}

/** 全部折线段是否**轴对齐**（ELK ORTHOGONAL 的行为级读面：无斜段 = 无「不直」）。 */
const allAxisAligned = (pts) =>
  pts.every((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1][0]) < 0.01 || Math.abs(p[1] - pts[i - 1][1]) < 0.01);

// ---------------------------------------------------------------------------
// ① 构图 · 多节点（N2c 起：边方向钉构图面，形态钉自绘面）
// ---------------------------------------------------------------------------

test("T2-①多节点：3 任务链 a→b→c 的边方向 = 依赖项→依赖者，全节点入图", async () => {
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
  const s = (await renderDependencyGraphSection(tasks));
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
  const isolated = (await renderDependencyGraphSection([task("task-dddddddd", "weird-state")]));
  assert.ok(
    isolated.html.includes('<span class="dg-chip dg-unknown" title="task-dddddddd · #1 · weird-state · 依赖：无">'),
    "未知态回落 unknown 档",
  );
  assert.ok(isolated.html.includes("weird-state"), "原样态名，不吞不猜");
});

test("T2-①空依赖：全无依赖 ⇒ 全孤立节点、零边、出图不为空", async () => {
  const g = buildTaskGraph([task("task-11111111"), task("task-22222222", "working", null)]);
  assert.deepEqual(g.edges, []);
  assert.deepEqual(g.dangling, []);
  const s = (await renderDependencyGraphSection(g.nodes));
  assert.notEqual(s.html, "", "有任务 ⇒ 区块不为空（原「源不为 null」的自绘等价）");
  assert.match(s.html, /<h2>依赖图（2 任务 · 1 管道 · 声明 0 边（本质 0 · 传递省略 0））<\/h2>/, "零边进标题计数（原「源内无 -->」的自绘等价；N2 起边数恒出「声明 / 本质 / 省略」三数）");
  assert.equal(s.html.includes("dg-edges"), false, "无跨管道边 ⇒ 边清单整行不渲");
  assert.ok(s.html.includes('title="task-11111111 · #1 · 已完成 · 依赖：无"'), "孤立节点仍入图（不吞）");
});

test("T2-①空任务集（v0.9.5 C2 短路③）⇒ 依赖图整节不渲染", async () => {
  const s = (await renderDependencyGraphSection([]));
  assert.equal(s.html, "", "空图连「（无任务，暂无依赖图）」的提示行都不出（Step 0 卡零信息量）");
});

// ---------------------------------------------------------------------------
// ② 环防御
// ---------------------------------------------------------------------------

test("T2-②环防御：a⇄b 互依赖 ⇒ 成环边不画 + cycleEdges 登记，其余节点照画", async () => {
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

test("T2-②自依赖也算环边（防御性），不产出自环画法", async () => {
  const g = buildTaskGraph([task("task-aaaaaaaa", "working", ["task-aaaaaaaa"])]);
  assert.deepEqual(g.cycleEdges, [{ from: "task-aaaaaaaa", to: "task-aaaaaaaa" }]);
  assert.deepEqual(g.edges, []);
});

test("T2-②悬空依赖（跨需求/未登记 id）⇒ 不画边 + dangling 登记", async () => {
  const g = buildTaskGraph([
    task("task-aaaaaaaa", "completed", ["task-external0"]),
    task("task-bbbbbbbb", "completed", ["task-aaaaaaaa"]),
  ]);
  assert.deepEqual(g.dangling, [{ from: "task-aaaaaaaa", dep: "task-external0" }]);
  assert.deepEqual(g.edges.map((e) => `${e.from}->${e.to}`), ["task-aaaaaaaa->task-bbbbbbbb"]);
  const s = (await renderDependencyGraphSection(g.nodes.map((n) => ({ ...n }))));
  assert.match(s.html, /class="hint warn"/);
  assert.ok(s.html.includes(`${short("task-aaaaaaaa")} ⇢ ${short("task-external0")}`));
});

// ---------------------------------------------------------------------------
// ③ application/json 数据通道（不入闭集、源文本不拼 HTML）
// ---------------------------------------------------------------------------

test("T2-③零 script 面（N2b 自绘取代数据通道）：区块不出任何 script 标签，脏字符入 title 落实体形态", async () => {
  const s = (await renderDependencyGraphSection([
    task("task-aaaaaaaa", "completed", []),
    task('x"b<c', "working", ["task-aaaaaaaa"]),
  ]));
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

test("T2-③区块结构（N2b 自绘）：标题计数 + 六态图例 + 原生管道 details + chip，零 mermaid 块", async () => {
  const s = (await renderDependencyGraphSection([task("task-aaaaaaaa", "blocked")]));
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
    /<div class="dep-graph">\n<div class="dg-canvas" style="[^"]*">\n<svg class="dg-links"><\/svg>\n<details class="pipe" open style="[^"]*">\n<summary>管道 proj-a（1）<span class="dg-pipe-states">▨<\/span><\/summary>\n<div class="pipe-body"><div class="dg-grid" style="[^"]*"><span class="dg-cell" style="[^"]*"><span class="dg-chip dg-frozen"[^>]*>#1<\/span><\/span><\/div><\/div>\n<\/details>\n<\/div>\n<\/div>/,
    "G10 翻案（⑦(ii) 合并单画布 S1 · 改造文档 §2.2.1 / §4.4，承原 G5 翻案（②）+ 件一翻案（增补 §6.1）原地重指向）：结构 = dep-graph › dg-canvas ›【画布级 svg.dg-links —— **已从框内搬出**、零边时空 svg 照出】› details.pipe（固定盒）› summary + pipe-body › dg-grid › dg-cell › chip；cell 的 left/top 局部值随坐标源（v0.10.7 N5 起 = ELK 出参，本枚只钉结构不钉字面）；`.dg-deps` 角标带外壳随 C5 退役（14px 行距改由 `.dg-cell` 的 `padding-top` 承接，见件一① 翻案）",
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

test("T2-④构图与渲染对乱序输入确定性一致", async () => {
  const tasks = [
    task("task-cccccccc", "completed", ["task-bbbbbbbb"]),
    task("task-aaaaaaaa", "completed", []),
    task("task-bbbbbbbb", "completed", ["task-aaaaaaaa"]),
  ];
  const shuffled = [...tasks].reverse();
  assert.deepEqual(buildTaskGraph(shuffled).edges, buildTaskGraph(tasks).edges, "构图面：边定序不依赖入参序");
  assert.equal((await renderDependencyGraphSection(shuffled)).html, (await renderDependencyGraphSection(tasks)).html);
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

test("二轮N1-①（DOM 面重指向）脏字符 id 不进任何语法位：引号只包属性值，可见文字恒 #编号", async () => {
  const s = (await renderDependencyGraphSection([
    task("98c39da1-1111-2222-3333-444455556666"),
    task('a"b<c', "working", ["98c39da1-1111-2222-3333-444455556666"]),
  ]));
  assert.equal(s.html.includes('a"b<c'), false, "原值不得未转义出现（会劈开 title 属性 = 原「STR 劈裂」的 DOM 等价）");
  assert.ok(s.html.includes("a&quot;b&lt;c"), "id 的引号 / 尖括号入 title 前经 escapeHtml");
  assert.equal((s.html.match(/title="[^"]*"/g) ?? []).length, 2, "每枚 chip 恰一个可数的 title 属性");
  assert.equal((s.html.match(/>#\d+/g) ?? []).length, 2, "可见文字 = #编号（原 id 不上图形面 ⇒ 无引号位）");
  assert.equal(/"/.test(stripAttrs(s.html)), false, "剥掉属性值后不得再残留任何裸引号");
  assert.equal(s.html.includes("<script"), false, "零 script 标签（n3 内联闭集不扩）");
});

test("二轮N1-②（DOM 面重指向）保留字与脏字符 taskId：不再需要净化，原值进 title、入面先转义", async () => {
  const s = (await renderDependencyGraphSection([
    task("end", "completed", [], { queuedAt: "2026-10-11T00:00:01Z" }),
    task('a"b c', "working", ["end"], { queuedAt: "2026-10-11T00:00:02Z" }),
  ]));
  assert.ok(
    s.html.includes('<span class="dg-chip dg-done" title="end · #1 · 已完成 · 依赖：无">#1</span>'),
    "保留字 end 原样进 title（无解析器可撞词 ⇒ n_ 前缀净化面随源生成一并退役）",
  );
  assert.ok(s.html.includes("a&quot;b c"), "脏字符入 title 前先 escapeHtml");
  const other = (await renderDependencyGraphSection([
    task("t-x", "completed", [], { projectId: 'p"x', queuedAt: "2026-10-11T00:00:01Z" }),
  ]));
  assert.ok(other.html.includes("<summary>管道 p&quot;x（1）"), "projectId 入管道头同样转义");
  assert.equal(/"/.test(stripAttrs(other.html)), false, "同①：剥属性后无裸引号");
});

// ---------------------------------------------------------------------------
// ⑥ 增补轨 III N1（节点可读化）：原锚 = 标签四行「project 标识 + 任务要点（prompt 摘要截断换行）
//    + taskId 次要短标 + 状态中文」。v0.10.3 N2c 起图形面**不再承载要点**（可见文字 = `#编号`、
//    project 标识升为管道头、全量 taskId 进 title；负向钉见文末 N2b-N2 组）⇒ 本组 ①②③④
//    重指向到保留层 = `taskSummaryLines` 要点纯函数本体 + 管道头 / title 的落位与转义面。
// ---------------------------------------------------------------------------

test("三轮N1-①要点首行 + project 落位：要点 = prompt 首行（换行不拼接）；project 在管道头、全量 taskId 进 title", async () => {
  assert.deepEqual(
    taskSummaryLines("修复依赖图节点标签\n第二行不得入要点"),
    ["修复依赖图节点标签"],
    "要点 = prompt 首行（换行归一，不多行原文照抄）",
  );
  const s = (await renderDependencyGraphSection([
    task("98c39da1-1111-2222-3333-444455556666", "completed", [], {
      projectId: "flow",
      prompt: "修复依赖图节点标签\n第二行不得入要点",
    }),
  ]));
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

test("三轮N1-②prompt 缺键 / 空 / 全空白 ⇒ 要点为 null（不吞不猜），图形面对 prompt 零依赖", async () => {
  for (const prompt of [null, undefined, "", "   \n  "]) {
    assert.equal(
      taskSummaryLines(prompt),
      null,
      `prompt=${JSON.stringify(prompt)} ⇒ 要点 null（原「回退裸 taskId」的纯函数等价）`,
    );
    const withPrompt = (await renderDependencyGraphSection([task("task-aaaaaaaa", "working", [], { prompt })]));
    assert.equal(
      withPrompt.html,
      (await renderDependencyGraphSection([task("task-aaaaaaaa", "working", [], { prompt: null })])).html,
      `prompt=${JSON.stringify(prompt)} ⇒ 渲染与无 prompt 逐字同文`,
    );
    assert.ok(
      withPrompt.html.includes('title="task-aaaaaaaa · #1 · 执行中（不可辨） · 依赖：无"'),
      "全量 taskId 恒在 title（不吞不猜）",
    );
  }
});

test("三轮N1-③长文本截断换行：按词界换行、≤2 行、总量 ≤40 字符、超出以 … 收尾", async () => {
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

test("三轮N1-④title 与管道头均经转义：引号 / 尖括号 / & 不劈裂属性位", async () => {
  const s = (await renderDependencyGraphSection([
    task('a"b c', "working", ["d<e&f"], { projectId: 'p"1', prompt: 'say "hi" <b>&amp;</b>' }),
  ]));
  assert.ok(s.html.includes("a&quot;b c"), "taskId 入 title 被 escapeHtml");
  assert.ok(s.html.includes("d&lt;e&amp;f"), "依赖原值入 title 同样转义");
  assert.ok(s.html.includes("<summary>管道 p&quot;1（1）"), "projectId 入管道头被 escapeHtml");
  assert.equal(
    /"/.test(stripAttrs(s.html)),
    false,
    "剥掉属性值后不得残留裸引号（原「引号只包标签与 tip」白名单的 DOM 等价）",
  );
});

test("三轮N1-⑤容器与确定性（N2b 自绘）：.dep-graph 图区照旧、区块零 script；同入参两次渲染逐字相等、乱序入参等值", async () => {
  const tasks = [
    task("t-1", "completed", [], { projectId: "p1", queuedAt: "2026-10-11T00:00:01Z", prompt: "依赖图节点可读化" }),
    task("t-2", "working", ["t-1"], { projectId: "p2", queuedAt: "2026-10-11T00:00:02Z" }),
  ];
  const s = (await renderDependencyGraphSection(tasks));
  assert.match(s.html, /<div class="dep-graph">/, "图区容器类名不变（N2c 的 CSS 挂点）");
  assert.equal(s.html.includes("<script"), false, "不得携带可执行内联脚本，也不出数据通道");
  assert.equal(s.html.includes("依赖图节点可读化"), false, "要点不进图形 HTML（图形面零 prompt）");
  assert.equal((await renderDependencyGraphSection([...tasks].reverse())).html, s.html, "乱序入参 ⇒ 渲染逐字相等");
  assert.equal((await renderDependencyGraphSection([...tasks].sort((a, b) => (a.taskId < b.taskId ? 1 : -1)))).html, s.html);
});

test("三轮N1-⑥要点纯函数：首行边界 / 行宽与预算 / 空态 ⇒ null", async () => {
  assert.deepEqual(taskSummaryLines("甲\n乙"), ["甲"], "换行 = 消息分段边界，只取首行");
  assert.deepEqual(taskSummaryLines("  带\t制表符  与多空格  "), ["带 制表符 与多空格"], "行内空白归一");
  assert.deepEqual(taskSummaryLines("一二三四五六七八九十甲乙丙丁戊己庚辛壬癸"), ["一二三四五六七八九十甲乙丙丁戊己庚辛壬癸"], "20 字符内单行");
  assert.equal(taskSummaryLines("short one")?.length, 1);
  assert.deepEqual(taskSummaryLines("   "), null);
  assert.deepEqual(taskSummaryLines(""), null);
  assert.deepEqual(taskSummaryLines(null), null);
  assert.deepEqual(taskSummaryLines(undefined), null);
});

test("三轮N1-⑦布局与取色（N2c 重指向 · G6 再指向 · 增补件二订正）：横滚职责迁到 .dep-graph、位置性箭头规则退役、新规则零字面色值、绝对定位恰两条", async () => {
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

test("G6-同源①chip 盒模 = 下发变量（width/height 逐字 var(--dg-nw)/var(--dg-nh) ⇒ CSS 侧不存第二份数字）", async () => {
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
  const inline = (await renderDependencyGraphSection([task("t-here", "completed", [])])).html.match(/<div class="dg-canvas" style="([^"]*)">/);
  assert.ok(inline !== null, "下发面在场（几何变量的唯一出口 = 画布那一枚 inline）");
  assert.ok(
    inline[1].includes(`--dg-nw:${DG_NODE_W}px;--dg-nh:${DG_NODE_H}px;--dg-bh:${DG_BADGE_H}px`),
    "下发三键的数值逐字取自导出常量（改常量 ⇒ 板面自动跟随，改 CSS 数字 ⇒ 本条红）",
  );
  const gridInline = /<div class="dg-grid" style="([^"]*)">/.exec(
    (await renderDependencyGraphSection([task("t-here", "completed", [])])).html,
  );
  assert.ok(gridInline !== null, "框内网格仍在场（S1 下每框恰一枚 .dg-grid）");
  assert.equal(/--dg-/.test(gridInline[1]), false, "逐框不再重复下发变量（第二份下发面 = 双事实源，§2.2.1-2 只许画布一枚）");
});

test("G6-同源②新规则零盒模字面 + 消费键 ⊆ / = 下发键；z-index 分野与坐标原点在 .dg-grid", async () => {
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
    (await renderDependencyGraphSection([task("t-here", "completed", [])])).html,
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
test("R8 框层堆叠纪律（n14 收口新增）：.pipe / .pipe-body / .dg-grid 全部规则体零 z-index / transform / opacity", async () => {
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
  const s = (await renderDependencyGraphSection([task("cccc3333", "blocked", [], { prompt: "首行要点" })]));
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

test("N2a-N3六态映射：completed/working×queueState/failed/blocked/input-required 逐格 + 回落不吞不猜", async () => {
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

test("REQ-04真机值域补键：claimed/settled 映射 + 补键不误染 state 五档 + 图上不带被挡原因", async () => {
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

test("N2a-N4管道分组与编号一致性：6 任务 / 3 project ⇒ 3 条管道 projectId 升序、组内序 = taskOrdinalMap 号序、节点集不丢不重", async () => {
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

test("N2a-N5排序键确定性：createdAt 升序 / null 沉底 / 同值按 taskId 兜稳；乱序入参全等；本体未动（环边同值）", async () => {
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

test("N2b-N1管道制：6 任务 / 3 project ⇒ 3 枚原生 details.pipe，管道头 = 名称 + 计数 + 状态摘要串", async () => {
  const s = (await renderDependencyGraphSection(pipe6Tasks()));
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

test("N2b-N2负向钉：图形 HTML 内不得出现任何 prompt 文本子串（反斜杠 / 控制字符 / 【】壳 / script 字面全不含）", async () => {
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
  const s = (await renderDependencyGraphSection(tasks));
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
  const noPrompt = (await renderDependencyGraphSection(tasks.map((t) => ({ ...t, prompt: null }))));
  assert.equal(noPrompt.html, s.html, "要点完全不进图形 HTML ⇒ 有无 prompt 渲染同文");
  assert.equal(s.html.includes("#1"), true, "自绘形态本身在场（负向钉不许空转）");
  assert.equal(s.html.includes("dg-edges"), true, "两条任务分属两 project ⇒ 跨管道边清单行在场（钉本锚非空转）");
});

test("N2b-N6跨框边只出真走线与边清单：inline 零 position + 画布恰一枚 svg（G10·⑦(ii) 单画布），角标封顶退役 ⇒ 逐枚全落线", async () => {
  const s = (await renderDependencyGraphSection(pipe6Tasks()));
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
  const noCross = (await renderDependencyGraphSection([task("a1"), task("a2", "completed", ["a1"])]));
  assert.equal(noCross.html.includes("dg-edges"), false, "全无跨框边 ⇒ 边清单整行不渲");
  // 旧「角标封顶 3 枚、第 4 枚起折叠」的下界场景：5 枚跨框入边 ⇒ 逐枚全落线、零折叠形态
  const many = (await renderDependencyGraphSection([
    ...[1, 2, 3, 4, 5].map((i) =>
      task(`m${i}`, "completed", [], { projectId: "src", queuedAt: `2026-10-11T00:00:0${i}Z` }),
    ),
    task("tgt", "completed", ["m1", "m2", "m3", "m4", "m5"], {
      projectId: "dst",
      queuedAt: "2026-10-11T00:00:06Z",
    }),
  ]));
  const manyFace = crossFaceCounts(many.html);
  assert.deepEqual(
    [manyFace.cross, manyFace.paths, manyFace.list],
    [5, 5, 5],
    "v0.10.6 翻案（封顶 / 折叠档）：5 枚跨框边**逐枚**落成 5 条 path ⇒ 不存在「图上少画、靠折叠吞掉」的形态（旧锚的折叠记号已无对应出口）",
  );
  assert.equal(many.html.includes("<sup"), false, "角标 DOM 退役 ⇒ 折叠壳（dg-dep-more）也无从在场");
  assert.equal(many.html.includes("⇠"), false, "负向一侧：折叠记号整族不再出现（本锚不空转，正向由上面 5 枚承担）");
});

test("N2b-提示行照旧：环 / 悬空入参 ⇒ hint warn 行在场且两个既有起头串齐（自绘不改提示面）", async () => {
  const s = (await renderDependencyGraphSection([
    task("c-a", "completed", ["c-b"]),
    task("c-b", "completed", ["c-a", "c-external"]),
  ]));
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

test("增补A1-chip 七态变体规则齐：七枚全在场、border+background = 图例同一事实源（NODE_STATE_COLORS）", async () => {
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
  const s = (await renderDependencyGraphSection([
    task("a1-run", "working", [], { projectId: "p", queuedAt: "2026-10-11T00:00:01Z", queueState: "running" }),
    task("a1-fail", "failed", [], { projectId: "p", queuedAt: "2026-10-11T00:00:02Z" }),
  ]));
  assert.ok(s.html.includes('class="dg-chip dg-running"'), "running 档 chip 类名与 CSS 变体同名");
  assert.ok(s.html.includes('class="dg-chip dg-failed"'), "failed 档 chip 类名与 CSS 变体同名");
});

// ---------------------------------------------------------------------------
// G2（v0.10.5 · REQ-2026-10-12-02 · 改造文档 §2.3 / §2.4-③ / §2.5-I4）：
// 网格几何单一事实源 —— DG_* 常量 + pipeGridLayout（cells / colX / rowY / 通道 / 宽高）。
// 本组只算几何，**不走线、不产 HTML/CSS**（渲染 = G3，走线 = G2 之后的 routeIntraEdges）。
// ---------------------------------------------------------------------------

/** 角标单枚的**设计宽度**（改造文档 §2.3 C2：`⇠#k` 至多 4 枚 × ~32px ≤ `DG_BADGE_MAX_W`）。 */
const BADGE_MARK_DESIGN_W = 32;

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

// ---------------------------------------------------------------------------
// G3（v0.10.5 · REQ-2026-10-12-02 · 改造文档 §2.4-④ / §2.5-I2 I3 / §2.6）：
// 原锚吃通道式走线的两枚纯函数（只出 path 数据与类名，不渲染、不产 HTML / CSS、不减交叉）。
// ↑ v0.10.7 N10（REQ-2026-10-15-01 · 改造文档 §2.3「删」段末项）：该两枚 path 原语随走线族
//   整族退休（折线 `d` 的唯一出面 = ELK `sections`）⇒ 本块只留 **path 读数工具**，供 N5 起的
//   ELK 折线锚复用。
// ---------------------------------------------------------------------------

/** `d` 里的全部坐标对（按出现序）。v0.10.7 N5 起坐标源 = ELK ⇒ 几何可为小数（`elkNum` 收 0.01px）。 */
const dPoints = (d) => (d.match(/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g) ?? []).map((p) => p.split(",").map(Number));
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
      /^left:(-?\d+(?:\.\d+)?)px;top:(-?\d+(?:\.\d+)?)px"><span class="dg-chip dg-\w+" title="([^"]*)">#\d+<\/span>(<span class="dg-deps">)?/.exec(chunk);
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

test("件一②模型↔渲染（S1 加偏）：每条 d 的首末点 === 渲染 cell 的 chip 右缘/左缘中点 + 所属框 origin(dx/dy)", async () => {
  /** @param tasks 夹具 @param label 夹具名 @param minChecked 空转守卫下界 */
  const reconcile = async (tasks, label, minChecked) => {
    // 取数源 = 约简后 `kept`（与渲染层五消费点同源）；照吃声明原边集 ⇒ 约简一发生本条必红
    const graph = buildGraphWithPipelines(tasks);
    const edges = transitiveReduce(graph.edges).kept;
    const { html } = (await renderDependencyGraphSection(tasks));
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
  assert.equal(await reconcile(sample076bbb84(), "样本076bbb84", 8), 8, "单管道声明 10 边 → 本质 8 边、7 cell ⇒ 全数对账（加偏后逐点相等）");
  assert.equal(
    await reconcile(pipe6Tasks(), "pipe6", 5),
    5,
    "副夹具多框 ⇒ 板内边 + 跨框边**同池**全数对账（跨框那几条是「加偏」的唯一硬证据：两端的 dx/dy 不同）",
  );
});

// 件一③（增补 §6 件一 A6）：**origin 三方同源钉**。上一条锚抓的是「端点算得对不对」，本条抓的是
// 「算式里的 origin 从哪来」—— JS 常量 / 画布下发变量 / CSS 消费变量名三处必须是同一枚事实源。
// 缺这一钉时的失败形态：有人把 `DG_GRID_ORIGIN_*` 改成硬编码 9/21（改了 pad 不跟随），或把 CSS 的
// `left: var(--dg-fp)` 写成 `left: 8px`（DOM 内缘与走线内缘分家 ⇒ 件一② 依旧全绿而线上错位）。
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
  const nums = dPoints(d);
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

test("G8-svg负钉①：svg 开标签逐字唯一 = <svg class=\"dg-links\">（零 viewBox / width / height / aria-hidden ⇒ 用户单位 = CSS px 1:1）", async () => {
  for (const tasks of [pipe6Tasks(), sample076bbb84()]) {
    const { html } = (await renderDependencyGraphSection(tasks));
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

test("G8-svg负钉②：带引号属性闭集 = {class,title,style,d}；cell 的 style 恰 left/top 两枚几何字面、零 position 声明", async () => {
  for (const tasks of [pipe6Tasks(), sample076bbb84()]) {
    const { html } = (await renderDependencyGraphSection(tasks));
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

test("G8-svg负钉③：画布恰一枚 dg-links + 每框恰一枚 dg-grid；cell 枚数 === 节点枚数、每 cell 恰一枚 chip", async () => {
  for (const [tasks, pipes, nodes] of [
    [pipe6Tasks(), 3, 6],
    [sample076bbb84(), 1, 7],
  ]) {
    const { html } = (await renderDependencyGraphSection(tasks));
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

test("件一①外壳退役（负向钉）：渲染 HTML 零 .dg-deps / 零角标 + 14px 行距改由 .dg-cell 的 padding-top 承接", async () => {
  for (const [tasks, label, cells, cross] of [
    [pipe6Tasks(), "pipe6（4 枚跨框边 ⇒ 改由画布真连线承载）", 6, 4],
    [sample076bbb84(), "样本076bbb84（零跨框边）", 7, 0],
  ]) {
    const { html } = (await renderDependencyGraphSection(tasks));
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

test("G9-完备总账①管道制夹具（6 任务 / 3 管道 / 声明 5 边 · 本质 5）：path 枚数 === kept 枚数（同框 + 跨框同一出口）", async () => {
  const tasks = pipe6Tasks();
  const { html } = (await renderDependencyGraphSection(tasks));
  const { paths, cross } = graphFaceLedger(html);
  const { declared, kept, dropped } = edgeLedgers(tasks);
  assert.deepEqual([paths, cross, kept.length], [5, 4, 5], "夹具现态 = 5 枚画布 path（其中 4 枚跨框）/ 5 条本质边");
  assert.ok(paths > 0 && cross > 0 && paths - cross > 0, "空转守卫：同框边与跨框边两类在本夹具各有实例 ⇒ 漏任一类必被本条抓住");
  assert.equal(paths, kept.length, "主账（v0.10.6 C5 单出口）：每条本质边恰落一枚画布 path，不吞不重");
  assertFramePairLedger(html, tasks, "①");
  assert.equal(declared.length, kept.length + dropped.length, "对账锚①：声明数 === 本质 + 省略");
  assert.equal(dropped.length, 0, "本夹具无冗余 ⇒ 省略清单空（主账与旧口径同值，不因此空转）");
});

test("G9-完备总账②单管道夹具（sample076bbb84，7 任务 / 1 管道 / 声明 10 边 → 本质 8）：本质边全入走线、跨框边恒 0 而总账仍成立", async () => {
  const tasks = sample076bbb84();
  const { html } = (await renderDependencyGraphSection(tasks));
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

test("G9-完备总账③空图短路：零任务 ⇒ 区块空串（出口 0 枚、边数 0，总账不作真而通过）", async () => {
  const { html } = (await renderDependencyGraphSection([]));
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

test("N1约简-③多冗余并存不链式：J=3 / R=3（贪心原地删边会吞掉本质边 b→c ⇒ 在此判红）；乱序入参等值", async () => {
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

test("N1约简-⑤纯定序边（C1 关键）：单枚跨框边、无平行路径 ⇒ R=0、kept 含该边 ⇒ 落成一条真 path", async () => {
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
  const { html } = (await renderDependencyGraphSection(pureOrderTasks()));
  const { paths, pairs } = graphFaceLedger(html);
  assert.equal(paths, 1, "该纯定序边在画布层恰落一枚 path（R=0 且 kept 含它 ⇒ 必须看得见）");
  assert.deepEqual(
    pairs.map((p) => `${p.from}→${p.to}`),
    ["proj-src→proj-dst"],
    "唯一一枚 path 的端点落框对 = 该边两端 project（同向 ⇒ 不是框内线、不是画反）",
  );
  assert.equal(graphFaceLedger(html).cross, 1, "跨框档恰一枚 ⇒ 定序边不再靠角标承载、也不再「清单有线没」");
});

test("N1约简-⑥闭包恒等（不丢真实等待）：六枚夹具约简前后全对可达关系完全相同", async () => {
  for (const [label, tasks] of reduceFixtures()) {
    const { edges } = buildTaskGraph(tasks);
    const { kept } = transitiveReduce(edges);
    assert.deepEqual(reachPairs(kept), reachPairs(edges), `${label}：传递闭包逐对相等 ⇒ 就绪集 / 派发序 / 冻结闭包的输入不变`);
  }
});

test("N1约简-⑦不吞边：每条 dropped (u,v) 在 kept 上仍传递推出（v ∈ reach_kept(u)）", async () => {
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

test("N1约简-⑧含环入参负钉：cycleEdges 原样、约简只在 edges 上跑（且脏边集入参不吞环、不死循环）", async () => {
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
    const m = /^left:(-?\d+(?:\.\d+)?)px;top:(-?\d+(?:\.\d+)?)px;width:(-?\d+(?:\.\d+)?)px;height:(-?\d+(?:\.\d+)?)px">\s*<summary>管道 ([^（]+)（/.exec(body);
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

test("N2-h2自洽：五数从渲染 HTML 反向解析、按位取，断言 声明 === 本质 + 省略（四枚夹具，不得从约简对象直取）", async () => {
  for (const [label, tasks, want] of [
    ["pipe6（无冗余 ⇒ R=0 仍出全形）", pipe6Tasks(), [6, 3, 5, 5, 0]],
    ["样本076bbb84（10 → 8 · 省 2）", sample076bbb84(), [7, 1, 10, 8, 2]],
    ["折叠+约简组合（6 → 5 · 省 1）", foldReduceTasks(), [6, 2, 6, 5, 1]],
    ["跨管道同集（3 → 2 · 省 1）", crossReduceTasks(), [3, 3, 3, 2, 1]],
  ]) {
    const { html } = (await renderDependencyGraphSection(tasks));
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

test("N2-h2全形单一形态：R=0 的夹具也出「传递省略 0」，无短形态残留（区块恰一枚 h2 且必成全形）", async () => {
  for (const [label, tasks] of [
    ["pipe6", pipe6Tasks()],
    ["样本076bbb84", sample076bbb84()],
    ["零边单节点", [task("z-1")]],
  ]) {
    const { html } = (await renderDependencyGraphSection(tasks));
    const heads = html.match(/<h2>[^<]*<\/h2>/g) ?? [];
    assert.equal(heads.length, 1, `${label}：区块恰一枚 h2`);
    assert.match(heads[0], /^<h2>依赖图（\d+ 任务 · \d+ 管道 · 声明 \d+ 边（本质 \d+ · 传递省略 \d+））<\/h2>$/, `${label}：恒全形（采短形态 ⇒ 本条红）`);
  }
  // 省略只出计数、不逐条列，也不进「画不出的边」那一行（§2.3-4）
  const { html } = (await renderDependencyGraphSection(sample076bbb84()));
  assert.ok(html.includes("传递省略 2"), "省略数在场（计数）");
  assert.equal(/<p class="hint warn">/.test(html), false, "无悬空 / 环边 ⇒ 单管道样本不出 warn 行（dropped 不得挤进该行）");
  assert.equal(html.includes("n1→n6"), false, "省略边不逐条列（图形面既不画线也不报名）");
});

test("N2对锚②`.dg-edges` 清单枚数 === 跨框 path 枚数（文本面与几何面同源，v0.10.6 C5 角标退役后锚强度上升）", async () => {
  for (const [label, tasks] of [
    ["pipe6（4 枚跨框边）", pipe6Tasks()],
    ["样本076bbb84（零跨框边 ⇒ 两枚出口同 0）", sample076bbb84()],
    ["约简+跨框组合（省略 1 · 跨框 4）", foldReduceTasks()],
    ["跨管道同集（省略 1 · 跨框 2）", crossReduceTasks()],
  ]) {
    const { html } = (await renderDependencyGraphSection(tasks));
    const { list, cross, paths } = crossFaceCounts(html);
    const model = crossKeptEdges(tasks).length;
    assert.equal(list, model, `${label}：底部清单枚数 === 本质跨框边枚数（文本面 ↔ 模型面）`);
    assert.equal(cross, model, `${label}：跨框 path 枚数 === 本质跨框边枚数（几何面 ↔ 模型面 —— 端点落框分类，不吃角标）`);
    assert.equal(list, cross, `${label}：两枚出口同数 ⇒ 不会出现「清单列着、图上没线」，也不会「线上画着、清单漏报」`);
    assert.ok(cross <= paths, `${label}：跨框枚数 ≤ 画布 path 总枚数（同框边共用同一出口，只许少不许多）`);
  }
  // 非空转：夹具里确有「跨框在场」与「两枚出口同零」两种形态
  const combo = crossFaceCounts((await renderDependencyGraphSection(foldReduceTasks())).html);
  assert.deepEqual([combo.cross, combo.intra, combo.list], [4, 1, 4], "空转守卫：跨框形态真的发生过（跨框 4 / 同框 1 / 清单 4）");
  const none = crossFaceCounts((await renderDependencyGraphSection(sample076bbb84())).html);
  assert.deepEqual([none.cross, none.list], [0, 0], "空转守卫的另一侧：单管道 ⇒ 两枚出口同零（不得只靠一侧零成立）");
  assert.equal(none.paths, 8, "另一侧仍有实线（同框 8 枚本质边全落 path ⇒ 同零不是「整图没画」）");
});

test("N2对锚③约简 + 跨框同时在场：被省略的 a1⇢t1 既不入清单、也不占跨框 path 位（跨框数按约简后算）", async () => {
  const { html } = (await renderDependencyGraphSection(foldReduceTasks()));
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

test("N2跨管道同集：约简在全图上做一次 ⇒ 跨框走线与 `.dg-edges` 清单同步减一（同框边与跨框边共用同一约简集）", async () => {
  const tasks = crossReduceTasks();
  const { html } = (await renderDependencyGraphSection(tasks));
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

test("F1稳定性钉：createdAt 不变 ⇒ queuedAt（null→实值）与 claimedAt（再变动）三轮前后，编号逐键全等（渲染层 #n 同源）", async () => {
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
    assert.deepEqual(f1ChipNumbers((await renderDependencyGraphSection(tasks)).html), want, `${label}：渲染层可见 #n 与单点 map 同源同值`);
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

test("D-①（v0.10.6 等式钉）`<details` 枚数 === `.pipe open` 枚数 === `<summary>` 枚数 === 管道枚数（任一框丢 .pipe / 画布外多出 details 立刻判红）", async () => {
  for (const [label, tasks, wantPipes] of [
    ["pipe6（3 管道 · 5 边）", pipe6Tasks(), 3],
    ["样本076bbb84（单管道 · 10 边）", sample076bbb84(), 1],
    ["跨管道同集（3 管道 · 约简 1）", crossReduceTasks(), 3],
    ["单任务（1 管道 · 零边 ⇒ 零 path 也不脱钉）", [task("task-aaaaaaaa", "blocked")], 1],
  ]) {
    const { html } = (await renderDependencyGraphSection(tasks));
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

test("D-②（v0.10.6 切片钉）`.dep-graph` 容器起点之外的区段零 `<details` ⇒ 框层是区块内 details 的唯一出现层", async () => {
  for (const [label, tasks, wantWarn, wantCross] of [
    ["pipe6（无提示行 · 有跨框边清单）", pipe6Tasks(), false, true],
    ["样本076bbb84（单管道 ⇒ 两区段皆无）", sample076bbb84(), false, false],
    ["hint warn + 跨框边清单同时在场", d2WarnAndCrossTasks(), true, true],
    ["单任务（零边 ⇒ 切片内仍有一枚框）", [task("task-aaaaaaaa", "blocked")], false, false],
  ]) {
    const { html } = (await renderDependencyGraphSection(tasks));
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

test("G13-夹具①：真板集可读入且三数自洽", async () => {
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

test("G11-夹具①五形结构钉：frames 枚数 / crossEdges 枚数 / 同框归属 / 框序 = projectId 升序 / 跨度逐枚对账（本枚零几何）", async () => {
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
    const rendered = [...(await renderDependencyGraphSection(tasks)).html.matchAll(/<summary>管道 ([^（]+)（/g)].map((m) => m[1].trim());
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
async function canvasSceneOf(tasks) {
  const html = (await renderDependencyGraphSection(tasks)).html;
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
    const m = /^[^>]*style="left:(-?\d+(?:\.\d+)?)px;top:(-?\d+(?:\.\d+)?)px;width:(-?\d+(?:\.\d+)?)px;height:(-?\d+(?:\.\d+)?)px">\s*<summary>管道 ([^（]+)（/.exec(body);
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
async function canvasObstaclesOf(tasks, edge, unbanded = false) {
  const scene = await canvasSceneOf(tasks);
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

test("G11-画布穿模②（本枚极性 = **必为 0** · n7 与算法同轮翻转）：渲染层全部跨框边在 A6 带域障碍集上 canvasHits 恒 0", async () => {
  const shapes = canvasFixtures();
  assert.ok(shapes.length >= 5, `五形都在册（F1 相邻正向 / F2 相邻回流 / F3 跨 3 框正向 / F4 跨 3 框回流 / F5 超载与单列框，实得 ${shapes.length} 形）`);
  let edges = 0;
  for (const { key, label, tasks } of shapes) {
    const scene = await canvasSceneOf(tasks);
    assert.ok(scene.cross.length >= 1, `${label}：跨框边在册（0 枚 ⇒ 本形对 I1′ 空转，回到 i6 的旧缺口）`);
    for (const r of scene.cross) {
      const obstacles = await canvasObstaclesOf(tasks, r);
      assert.ok(obstacles.length >= 1, `${key}/${r.from}→${r.to}：带域障碍集非空（空集 ⇒ 下面那个 0 是空转）`);
      const hits = canvasHits(r.d, obstacles);
      assert.deepEqual(
        hits,
        [],
        `${key} k=${r.span}：${r.from}(${r.fromProject})→${r.to}(${r.toProject}) 渲染层走廊须 **0 命中**（实得 ${hitTexts(hits).join(" ")}）`,
      );
      edges += 1;
    }
  }
  assert.ok(edges >= 6, `被测跨框边枚数 ${edges} ≥ 6 ⇒ 五形边集全入走线（丢边会同时把本枚测空）`);
});

test("G11-画布穿模③（本枚极性 = **必为 0** · n7 与算法同轮翻转）：n1 真板集全部路由的画布级命中边集合为空", async () => {
  const tasks = realTasks();
  const scene = await canvasSceneOf(tasks);
  const intra = scene.routes.filter((r) => r.fromProject === r.toProject);
  assert.equal(scene.routes.length, scene.cross.length + intra.length, "对账前提：路由集 = 跨框档 ∪ 同框档（不重不漏，同一取数面）");
  assert.ok(scene.cross.length >= 1, `真板集确有跨框边 ${scene.cross.length} 枚（0 枚 ⇒ 本条对 I1′ 空转，回到 i6 的旧缺口）`);
  assert.ok(intra.length >= 1, `真板集确有同框边 ${intra.length} 枚 ⇒ 下面那条「路由集全入判据面」不是只测了跨框档`);

  const hitEdges = [];
  let obstacleRows = 0;
  for (const r of scene.routes) {
    const obstacles = await canvasObstaclesOf(tasks, r);
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
async function realPenetrationCounts() {
  const tasks = realTasks();
  const scene = await canvasSceneOf(tasks);
  const edges = [];
  const chips = new Set();
  let hits = 0;
  for (const r of scene.routes) {
    const found = canvasHits(r.d, await canvasObstaclesOf(tasks, r));
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
async function realOverlapCounts() {
  const routes = (await canvasSceneOf(realTasks())).routes;
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

test("G13-真板复现①（改后 golden · 极性 = **必为 0 / 0**，n7 与算法同轮翻转）：真板集画布级穿模 = 0 边 / 0 chip", async () => {
  const first = await realPenetrationCounts();
  const second = await realPenetrationCounts();
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

/** 走廊门类闭集（改造文档 A2 的 7 类 ⇒ 8 枚取值；出现第 9 枚即本钉红）。 */
const CROSS_CORRIDOR_KINDS = ["CH", "PL", "PR", "ML", "MR", "BD", "PB", "PT"];

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
const renderColGapsOf = async (tasks, projectId) => {
  const frame = (await canvasSceneOf(tasks)).frames.find((f) => f.projectId === projectId);
  assert.ok(frame !== undefined, `${projectId} 框在渲染层在册`);
  const xs = [...new Set([...frame.cells.values()].map((c) => c.left))].sort((a, b) => a - b);
  return xs.slice(1).map((x, i) => x - xs[i] - DG_NODE_W);
};

/** 跨框 path 的**出口腿 x** = 顶点 1 的横坐标（`corridorPath` 每段一枚 C ⇒ 顶点落在下标 `3i`）。 */
const exitLegX = (d) => dPoints(d)[3]?.[0];

/** 场景内全部跨框腿所用的出口 x 集合（「分席 / 共段」的读数面）。 */
const crossLegXs = (scene) => new Set(scene.routes.filter((r) => r.kind === "cross").map((r) => exitLegX(r.d)));

// ---------------------------------------------------------------------------
// G11-走廊⑩⑪⑫⑬（REQ-2026-10-14-02 · 承接轨② n8b · 改造文档 §6 第二枚增补 A4「画布侧」）——
// ↑ v0.10.7 N10（REQ-2026-10-15-01 · §2.3「删」段）：四枚钉的凭据面 `planCanvas` / `canvasLayout` 与
//   其带高公式的三枚入参常量已随走线族整族退休 ⇒
//   本块的镜像 `planFaceOf` / 夹具集 `bandFixtures` / 公式反证面 `bandHFor` 三枚死重照本族删除
//   （⑩⑪⑫⑬ 的测试本体已在 N6 / N9 摘除）。画布几何的行为级判据保留在 N6 降级后的四把尺上。
// ---------------------------------------------------------------------------

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

test("G14-①类名常量面：DG_EDGE_CROSS_CLS 首 token = DG_EDGE_CLS、恰两枚 class、不含子串 dg-edges；DG_EDGE_CLS 逐字未动", async () => {
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

test("G14-③CSS 面：跨框着色规则恰一条、声明闭集 = 只一枚 stroke、引既有 token、零几何声明；基础规则与图例枚数逐字不变", async () => {
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
  const withCross = (await renderDependencyGraphSection(pipe6Tasks())).html;
  const noCross = (await renderDependencyGraphSection(sample076bbb84())).html;
  assert.equal((withCross.match(/class="dg-legend"/g) ?? []).length, NODE_STATE_ORDER.length, "图例枚数 = NODE_STATE_ORDER 枚数（不加行）");
  assert.equal(legendRow(withCross), legendRow(noCross), "图例行逐字未变（跨框侧与单管道侧同形 ⇒ 未为连线色另立条目）");
  assert.equal(withCross.includes("dg-edge-cross"), true, "空转守卫：对照面确有跨框线（图例不变不是「没东西可着色」）");
});

test("G14-④三面同源钉：类面（path class）=== 几何面（端点落框）=== 文本面（`.dg-edges` 清单）=== 模型面（本质跨框边）", async () => {
  for (const [label, tasks] of g14Fixtures()) {
    const { html } = (await renderDependencyGraphSection(tasks));
    const { list, cross, cls, paths } = crossFaceCounts(html);
    const model = crossKeptEdges(tasks).length;
    assert.equal(cls, cross, `${label}：类面 === 几何面（换了色却没连线、或连了线却没换色，都在此判红）`);
    assert.equal(cls, list, `${label}：类面 === 文本面（清单列几条，就有几条带追加类）`);
    assert.equal(cls, model, `${label}：类面 === 本质跨框边枚数（模型面，四面对齐）`);
    assert.ok(cls <= paths, `${label}：类面 ≤ 画布 path 总枚数（框内线共用同一出口，只许少不许多）`);
  }
  // 非空转两侧：跨框在场形与单管道形各钉一面
  const combo = crossFaceCounts((await renderDependencyGraphSection(pipe6Tasks())).html);
  assert.deepEqual([combo.cls, combo.cross, combo.list, combo.intra], [4, 4, 4, 1], "跨框侧三面同为 4（框内 1 枚不带追加类）");
  const none = crossFaceCounts((await renderDependencyGraphSection(sample076bbb84())).html);
  assert.deepEqual([none.cls, none.cross, none.list], [0, 0, 0], "单管道侧三面同零");
  assert.ok(none.paths > 0, "同零不是「整图没画」（框内线照在，只是都不带追加类）");
});

// ---------------------------------------------------------------------------
// G15 · 承接轨③ n8d「入点侧向让位」（REQ-2026-10-14-02 · 改造文档 §6 承接节）
//
// v0.10.7 N9：本块原 ①「形状与降级」锚吃的是跨框走线一族里的让位纯函数（已随该族删除）⇒ 该锚与
//   其取数夹具（`g15Points` / `g15Tail` / `approachReadOf` 等）一并退休；下方 G15-②③ 两枚已由 N6
//   降级为行为级四把尺（不依赖让位原语）。跨框路由归 ELK，让位不再是板侧构造。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v0.10.7 N4（REQ-2026-10-15-01 · 改造文档 §2.4 兜底条）：async 出口 = 出错回吐空图 + 一行提示
//   判据 = 注入**抛错桩**（经 graph-elk 真 catch 面）⇒ 出口 **resolve 不 reject**、整节只一行
//          `class="hint warn"`、无未闭合标签 / 无裸引号；**负钉** = 正常路径不出该行、出参与同步版逐字相等。
// ---------------------------------------------------------------------------

/** 抛错桩工厂：求解子步骤当场抛 ⇒ catch 面回 `{ flat: null, reason }`，出口只可能拿到出错信号。 */
const throwingLayoutFn = (message) => (source) =>
  layoutGraphGuarded(source, async () => {
    throw new Error(message);
  });

/** 兜底用例的干净夹具：同管道两枚链任务（无环 / 无悬空 ⇒ 正常路径本就不出 hint warn 行）。 */
const n4Tasks = () => [task("task-aaaaaaaa", "completed", []), task("task-bbbbbbbb", "completed", ["task-aaaaaaaa"])];

test("N4出口-① 注入抛错桩 ⇒ resolve 不 reject、整节只回吐一行 hint warn", async () => {
  const section = await renderDependencyGraphSection(n4Tasks(), 1, throwingLayoutFn('solve blew up: "q" <t>'));
  assert.match(section.html, /^<p class="hint warn">[\s\S]*<\/p>$/);
  assert.equal((section.html.match(/class="hint warn"/g) ?? []).length, 1);
});

test("N4出口-② 兜底行 p 一对一闭合、错因转义（无裸引号）、零图形壳", async () => {
  const section = await renderDependencyGraphSection(n4Tasks(), 1, throwingLayoutFn('solve blew up: "q" <t>'));
  assert.equal(section.html.split("<p").length - 1, 1, "开始标签 <p> 恰一枚");
  assert.equal(section.html.split("</p>").length - 1, 1, "闭合标签 </p> 恰一枚（未闭合 ⇒ 本条红）");
  assert.equal((section.html.match(/"/g) ?? []).length, 2, "裸引号只允许 class 属性那一对");
  assert.ok(section.html.includes("&quot;") && section.html.includes("&lt;"), "错因里的引号 / 尖括号须转义后入面");
  for (const shell of ['<div class="dep-graph"', "<svg", "<h2", "<details"]) {
    assert.equal(section.html.includes(shell), false, `兜底面不得带图形壳：${shell}`);
  }
});

test("N4出口-③ 负钉：正常路径（缺省真求解）不出兜底行，且出参与同步版逐字相等", async () => {
  const section = await renderDependencyGraphSection(n4Tasks());
  assert.equal(section.html.includes("布局失败"), false);
  assert.equal(section.html.includes('class="hint warn"'), false);
  assert.ok(section.html.includes('<div class="dg-canvas"'), "正常路径照出图形面");
  assert.equal(section.html, (await renderDependencyGraphSection(n4Tasks())).html, "兜底门不得改动正常路径的任何一个字节");
});

test("N4出口-④ 空短路 ⇒ 整节不渲染且一律不跑求解（桩被调用即红）", async () => {
  let calls = 0;
  const spy = async (source) => {
    calls += 1;
    return layoutGraphGuarded(source);
  };
  assert.deepEqual(await renderDependencyGraphSection([], 1, spy), { html: "" });
  assert.equal(calls, 0);
});

test("N4出口-⑤ 页面接线源面锚：详情页走 await 的 async 出口（「不 500」的前提）", async () => {
  const serverSrc = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.ok(serverSrc.includes("await renderDependencyGraphSection("), "详情页未经 async 出口 ⇒ ELK 出错仍会 500");
  // v0.10.7 N5：async 过渡别名已合流进唯一公开口 ⇒ 「清零」的对象不再是某个名字，而是**任何未被 await 的调用点**
  const bare = [];
  for (let i = serverSrc.indexOf("renderDependencyGraphSection("); i >= 0; i = serverSrc.indexOf("renderDependencyGraphSection(", i + 1)) {
    if (!serverSrc.slice(0, i).endsWith("await ")) bare.push(i);
  }
  assert.deepEqual(bare, [], "server.ts 内不得出现不带 await 的 renderDependencyGraphSection 调用点");
});

// ---------------------------------------------------------------------------
// N5（v0.10.7 承接轨）接线正钉：渲染层坐标源 = ELK 出参（三管道夹具 · 四条机械判据）
// ---------------------------------------------------------------------------

const n5Tasks = () => [
  task("n5aaaaaaaa", "completed", [], { projectId: "proj-a", createdAt: "2026-10-13T00:00:01Z" }),
  task("n5bbbbbbbb", "completed", ["n5aaaaaaaa"], { projectId: "proj-a", createdAt: "2026-10-13T00:00:02Z" }),
  task("n5cccccccc", "completed", ["n5bbbbbbbb"], { projectId: "proj-b", createdAt: "2026-10-13T00:00:03Z" }),
  task("n5dddddddd", "completed", ["n5cccccccc"], { projectId: "proj-c", createdAt: "2026-10-13T00:00:04Z" }),
];

test("N5接线① DOM 壳与层枚数：三管道夹具 ⇒ 恰一枚 svg.dg-links + 三枚 details.pipe + 零 script", async () => {
  const { html } = await renderDependencyGraphSection(n5Tasks());
  assert.equal((html.match(/<svg class="dg-links">/g) ?? []).length, 1, "画布级边线层恰一枚（框内不再出 svg —— S1 单画布）");
  assert.equal((html.match(/<details class="pipe"/g) ?? []).length, 3, "三管道 ⇒ 三枚框（DOM 壳 details.pipe 照留）");
  assert.equal(html.includes("<script"), false, "SSR 零脚本（读面不注入 JS，holdAnchor 前提不破）");
});

test("N5接线② 正钉：框盒 / cell 局部坐标逐枚等于同夹具现算的 ELK 出参（不抄字面）", async () => {
  const tasks = n5Tasks();
  const graph = buildGraphWithPipelines(tasks);
  const ordinals = taskOrdinalMap(tasks);
  const pipelines = groupPipelines(graph, ordinals);
  const { kept } = transitiveReduce(graph.edges);
  const laid = await layoutGraphGuarded({ pipelines, edges: kept });
  assert.ok(laid.flat !== null, `ELK 求解不得走兜底面（错因 ${String(laid.reason)}）`);
  const flat = laid.flat;
  const { html } = await renderDependencyGraphSection(tasks);
  assert.equal(flat.lanes.length, 3, "夹具确有 3 枚 lane（单框夹具测不出跨框坐标源）");
  for (const lane of flat.lanes) {
    const style = `left:${lane.x}px;top:${lane.y}px;width:${lane.w}px;height:${lane.h}px`;
    assert.ok(
      html.includes(`<details class="pipe" open style="${style}">`),
      `${lane.projectId} 框的 inline 盒 === ELK lane 盒（实得样式串未在 HTML 中在册：${style}）`,
    );
  }
  for (const node of flat.nodes) {
    const lane = flat.lanes.find((l) => l.id === node.laneId);
    assert.ok(lane !== undefined, `${node.id} 的所属 lane 在册`);
    const localX = node.x - lane.x - DG_GRID_ORIGIN_X;
    const localY = node.y - lane.y - DG_GRID_ORIGIN_Y - DG_BADGE_H;
    assert.ok(localX >= 0 && localY >= 0, `${node.id} cell 局部坐标不得为负（负值 = 节点压进标题带）：${localX},${localY}`);
    assert.ok(
      html.includes(`<span class="dg-cell" style="left:${localX}px;top:${localY}px">`),
      `${node.id} 的 cell 局部坐标 = ELK 绝对盒换算值（${localX},${localY}）`,
    );
  }
});

test("N5接线③ 反锚：框位不再是 planCanvas 的 gutter 累加等式（坐标源真换了，不是同值巧合）", async () => {
  const tasks = n5Tasks();
  const { html } = await renderDependencyGraphSection(tasks);
  const frames = [...html.matchAll(/<details class="pipe" open style="left:([-\d.]+)px;top:([-\d.]+)px;width:([-\d.]+)px/g)].map(
    (m) => ({ left: Number(m[1]), top: Number(m[2]), width: Number(m[3]) }),
  );
  assert.equal(frames.length, 3);
  // 旧 planCanvas（v0.10.7 N10 已退休）：横向堆叠 ⇒ left[i] = gutter + Σ(left[j]+width[j]+gutter)（j<i），且 top 同值
  // 该画布留白常量随走线族删除 ⇒ 本反锚改吃其**面值**（原值 = 24），判据不变（仍要求等式不成立）
  const OLD_CANVAS_GUTTER = 24;
  let acc = OLD_CANVAS_GUTTER;
  const oldLefts = frames.map((f) => {
    const v = acc;
    acc += f.width + OLD_CANVAS_GUTTER;
    return v;
  });
  const topsAllEqual = new Set(frames.map((f) => f.top)).size === 1;
  assert.equal(
    frames.every((f, i) => f.left === oldLefts[i]) && topsAllEqual,
    false,
    `渲染层框位仍逐枚等于 planCanvas 的 gutter 累加等式（${JSON.stringify(frames.map((f) => [f.left, f.top]))} vs ${JSON.stringify(oldLefts)}）⇒ 坐标源未换`,
  );
});

// ===========================================================================
// 承接轨 N6（REQ-2026-10-15-01 · 改造文档 §4「行为级四把尺」）：**十四枚输出形状锚的降级落点**
//
// 原锚钉的是走线族**内部形状**（2k+3 段数 / 走廊 at 线 / 通道席位数 / 弧控制点 / 入点让位档）——
// 这些量随 §2.3 退休清单整族消失，且其中一部分在 ELK 形态下**语义不再成立**：多枚入边汇入同一枚
// 目标 chip 的左缘中点 ⇒ 共段是原生形态而非缺陷（原「汇聚端口至多一条直通」正是被这一条推翻的）。
// 本块把每一枚**逐条换成四把尺** ——
//   `overlap`（节点盒两两零交 · 节点盒不压标题带）· `segRect`/`penCount`（边段穿节点 / 穿框 = 0）
//   · `devOf`（连线两端贴 chip 缘中点 = 0.0px）· 同 project 节点同框（「带序断言」的替代形）。
// 取数面 = {@link behaviorSceneOf}：只读 HTML / SVG 出参 + 画布下发的六枚 CSS 变量 ⇒ 对退休符号零引用
// （§2.3 落地、`DG_*` 从导出面消失之后，本块照跑 —— 这才是「降级为行为级」的可核含义）。
// ===========================================================================

/** 行为级四把尺的吃数夹具（真板全量集另在 G13/G15 两枚里单独吃）。 */
const RULER_FIXTURES = () => [
  ["pipe6（3 框 · 跨框 4）", pipe6Tasks()],
  ["样本076bbb84（单框 7 节点 · 声明 10 / 本质 8）", sample076bbb84()],
  ["折叠+约简（2 框 · 省略 1 · 跨框 4）", foldReduceTasks()],
  ["跨管道同集（3 框 · 省略 1 · 全跨框）", crossReduceTasks()],
];

const htmlOfTasks = async (tasks) => (await renderDependencyGraphSection(tasks)).html;
const sceneOfTasks = async (tasks) => behaviorSceneOf(await htmlOfTasks(tasks));

/** 两点同位（出参坐标收拢到 0.01px ⇒ 0.6px 容差只吃这一层收拢，不构成放宽）。 */
const samePt = (a, b) => Math.abs(a[0] - b[0]) < 0.6 && Math.abs(a[1] - b[1]) < 0.6;

/** 折线两端 → 两端 chip（**几何反查**；查不到即判红，不得静默当成「这条边不存在」）。 */
function needEnds(scene, pts, label) {
  const from = chipByEndpoint(scene, pts[0], "from");
  const to = chipByEndpoint(scene, pts[pts.length - 1], "to");
  assert.ok(from !== null, `${label}：首点须贴在某枚 chip 的右缘中点（实得 ${JSON.stringify(pts[0])}）`);
  assert.ok(to !== null, `${label}：末点须贴在某枚 chip 的左缘中点（实得 ${JSON.stringify(pts[pts.length - 1])}）`);
  return { from, to };
}

/** 一枚折线的障碍集（A6 带域的行为级同形）：chip 除本线两端、框除两端所属框（腿的首段必然在本框内）。 */
function obstaclesFor(scene, pts, label = "障碍集取端点") {
  const ends = needEnds(scene, pts, label);
  const ownProjects = new Set([ends.from.projectId, ends.to.projectId]);
  return {
    ends,
    chips: scene.chips.filter((c) => c.taskId !== ends.from.taskId && c.taskId !== ends.to.taskId).map((c) => c.box),
    frames: scene.frames.filter((f) => !ownProjects.has(f.projectId)).map((f) => f.box),
  };
}

/**
 * 四把尺的一次全量读数：
 * `penChip` = 全部折线穿入**他人节点盒**的段数之和 · `penFrame` = 穿入**他人框盒**的段数之和 ·
 * `devMax` = 端点偏差最大值（0.1px 精度）· `boxPairs` = 节点盒两两真相交对数 ·
 * `pressed` = 压进本框标题带的节点数。
 */
function rulerReadout(scene) {
  let penChip = 0;
  let penFrame = 0;
  let devMax = 0;
  for (const { d } of scene.paths) {
    const pts = dPoints(d);
    const { ends, chips, frames } = obstaclesFor(scene, pts);
    const dev = devOf(pts, ends.from.box, ends.to.box);
    assert.ok(dev !== null, `path ${d.slice(0, 20)}… 的端点偏差可核（点列 ≥ 2 且两端盒在手）`);
    devMax = Math.max(devMax, dev);
    penChip += penCount(pts, chips);
    penFrame += penCount(pts, frames);
  }
  const boxPairs = [];
  for (let i = 0; i < scene.chips.length; i += 1) {
    for (let j = i + 1; j < scene.chips.length; j += 1) {
      if (overlap(scene.chips[i].box, scene.chips[j].box)) boxPairs.push(`${scene.chips[i].taskId}×${scene.chips[j].taskId}`);
    }
  }
  return { penChip, penFrame, devMax, boxPairs, pressed: scene.chips.filter((c) => overlap(c.box, c.titleBand)) };
}

/** 把声明边集里的**可推出边**就地删掉 ⇒ 得到「约简后作为声明」的同形夹具（约简前后对照用）。 */
function dropRedundant(tasks) {
  const dropped = new Set(transitiveReduce(buildTaskGraph(tasks).edges).dropped.map((e) => `${e.from}>${e.to}`));
  return tasks.map((t) => ({ ...t, dependencies: (t.dependencies ?? []).filter((d) => !dropped.has(`${d}>${t.taskId}`)) }));
}

test("G11-走廊①（N6 降级为行为级 · 原「统一律段数 = 2k+3」随走线族退休）：全部折线段轴对齐 ⇒ 读面无斜段", async () => {
  let segments = 0;
  for (const [label, tasks] of [...RULER_FIXTURES(), ["真板全量集", realTasks()]]) {
    const scene = await sceneOfTasks(tasks);
    for (const { d } of scene.paths) {
      const pts = dPoints(d);
      assert.ok(pts.length >= 2, `${label}：path ${d.slice(0, 20)}… 至少两点`);
      assert.equal(allAxisAligned(pts), true, `${label}：折线必须处处正交（出现斜段 = 「不直」回退）：${d}`);
      segments += pts.length - 1;
    }
  }
  assert.ok(segments > 100, `空转守卫：正交性真的数到了 ${segments} 段`);
});

test("G11-走廊②（N6 降级为行为级 · 原「骨架两端落在走廊 at 线上」）：devOf 尺 = 连线两端贴 chip 缘中点 ⇒ 逐条 0.0px", async () => {
  for (const [label, tasks] of [...RULER_FIXTURES(), ["真板全量集", realTasks()]]) {
    const scene = await sceneOfTasks(tasks);
    assert.ok(scene.paths.length > 0, `${label}：确有边线可核（0 枚即空转）`);
    for (const { d } of scene.paths) {
      const pts = dPoints(d);
      const { from, to } = needEnds(scene, pts, `${label} path ${d.slice(0, 20)}…`);
      assert.equal(devOf(pts, from.box, to.box), 0, `${label}：${from.taskId}→${to.taskId} 端点偏差 = 0（尺 = devOf，0.1px 精度）`);
    }
  }
});

test("G11-走廊③（N6 降级为行为级 · 原「canvasHits 恒 0 于 A6 带域 + 直落形反对照」）：penCount 尺逐夹具恒 0，且合成直贯形必判红", async () => {
  for (const [label, tasks] of RULER_FIXTURES()) {
    const scene = await sceneOfTasks(tasks);
    const read = rulerReadout(scene);
    assert.equal(read.penChip, 0, `${label}：全部折线穿入他人节点盒的段数 = 0（实得 ${read.penChip}）`);
    assert.equal(read.penFrame, 0, `${label}：全部折线穿入他人框盒的段数 = 0（实得 ${read.penFrame}）`);
    // 反对照（防空转）：人造一段直贯某枚 chip 盒心 ⇒ 同一把尺必须数到 ≥ 1
    const victim = scene.chips[0];
    const midY = victim.box.y + victim.box.h / 2;
    const fake = [[victim.box.x - 20, midY], [victim.box.x + victim.box.w + 20, midY]];
    assert.ok(penCount(fake, [victim.box]) >= 1, `${label}：反对照失配 ⇒ penCount 尺本身失效（穿盒心的一段被数成 0）`);
  }
});

test("G11-走廊④（N6 降级为行为级 · 原「首弧第二控制点 y ≠ y0 + 转角 2k+2 + 弧不外扩」随弧族退休）：出参命令族闭集 = {{M, L}}，零曲线命令", async () => {
  let paths = 0;
  for (const [label, tasks] of [...RULER_FIXTURES(), ["真板全量集", realTasks()]]) {
    const scene = await sceneOfTasks(tasks);
    for (const { d } of scene.paths) {
      const cmds = new Set(dCmds(d));
      for (const c of cmds) assert.ok(c === "M" || c === "L", `${label}：命令族只许 M / L（实得 ${c} ⇒ 曲线族复活，正交描边失效）：${d}`);
      assert.equal(dCmds(d)[0], "M", `${label}：每枚 path 以 M 起手`);
      paths += 1;
    }
  }
  assert.ok(paths > 20, `空转守卫：命令族面真的核了 ${paths} 枚 path`);
});

test("G11-走廊⑧（N6 降级为行为级 · 原「列宽预算式（gapW ≥ 2·列通道宽 + n·节距）」随列预算退休）：overlap 尺 ⇒ 节点盒两两零交 + 同 project 节点同框", async () => {
  for (const [label, tasks] of [...RULER_FIXTURES(), ["真板全量集", realTasks()]]) {
    const scene = await sceneOfTasks(tasks);
    const read = rulerReadout(scene);
    assert.deepEqual(read.boxPairs, [], `${label}：节点盒两两零交（列宽够不够的最终读面就是这个）`);
    // 带序断言的替代形（改造文档 §4「行为级四把尺」第四条）：同 project 的节点恒在同一枚框里
    const perProject = new Map();
    for (const n of buildTaskGraph(tasks).nodes) perProject.set(n.projectId, (perProject.get(n.projectId) ?? 0) + 1);
    assert.equal(scene.frames.length, perProject.size, `${label}：每 project 恰一枚框`);
    for (const f of scene.frames)
      assert.equal(f.cells.size, perProject.get(f.projectId), `${label}：框 ${f.projectId} 的 cell 枚数 === 该 project 节点数`);
    const ids = scene.chips.map((c) => c.taskId);
    assert.equal(new Set(ids).size, ids.length, `${label}：chip 全集不重不漏`);
  }
});

test("G12-③（N6 降级为行为级 · 原「外缘硬容量 4 席 · seat < 4 严格不等式」随走廊选型退休）：跨框折线不得穿入非两端所属框，人造越界形判红", async () => {
  let crossTotal = 0;
  for (const [label, tasks] of [...RULER_FIXTURES(), ["真板全量集", realTasks()]]) {
    const scene = await sceneOfTasks(tasks);
    const cross = scene.paths.filter((p) => {
      const pts = dPoints(p.d);
      const { from, to } = needEnds(scene, pts, label);
      return from.projectId !== to.projectId;
    });
    crossTotal += cross.length;
    for (const { d } of cross) {
      const pts = dPoints(d);
      const { frames } = obstaclesFor(scene, pts, label);
      assert.equal(penCount(pts, frames), 0, `${label}：跨框折线穿入他人框盒 = 0（实得 ${penCount(pts, frames)}）：${d}`);
    }
    // 反对照：把一条腿硬拖进一枚框的盒心 ⇒ 同一把尺判红（尺失效 ⇒ 上面的 0 是空转）
    const foreign = scene.frames[scene.frames.length - 1];
    const midY = foreign.box.y + foreign.box.h / 2;
    assert.ok(
      penCount([[foreign.box.x - 30, midY], [foreign.box.x + foreign.box.w + 30, midY]], [foreign.box]) >= 1,
      `${label}：反对照失配 ⇒ 框级 penCount 失效`,
    );
  }
  assert.ok(crossTotal >= 8, `空转守卫：跨框边真的核了 ${crossTotal} 枚（单框夹具贡献 0，靠跨框夹具与真板集兜住）`);
});

test("G11-画布穿模①（N6 降级为行为级 · 原「手写 7 段走廊在带域障碍集上 0 命中」的走廊入参退休）：尺的判据自证 —— 正反两形同枚成立", async () => {
  const scene = await sceneOfTasks(pipe6Tasks());
  const read = rulerReadout(scene);
  // 正形：真出参四把尺全 0
  assert.deepEqual([read.penChip, read.penFrame, read.devMax, read.boxPairs.length, read.pressed.length], [0, 0, 0, 0, 0], "正形：真出参全 0");
  // 反形 A：把一段横拖过某枚 chip ⇒ 穿节点计数升
  const victim = scene.chips.find((c) => c.projectId === "orch") ?? scene.chips[0];
  const midY = victim.box.y + victim.box.h / 2;
  assert.ok(penCount([[victim.box.x - 5, midY], [victim.box.x + victim.box.w + 5, midY]], [victim.box]) >= 1, "反形 A：穿节点的一段必被数到");
  // 反形 B：把首点从缘中点挪开 1px ⇒ devOf 尺判红（不得仍是 0）
  const pts = dPoints(scene.paths[0].d);
  const { from, to } = needEnds(scene, pts, "pipe6");
  assert.equal(devOf(pts, from.box, to.box), 0, "原形偏差 = 0");
  const shifted = [[pts[0][0] + 1, pts[0][1]], ...pts.slice(1)];
  assert.ok((devOf(shifted, from.box, to.box) ?? 0) > 0, "反形 B：端点挪 1px 必被 devOf 数出非零");
});

test("G13-真板复现②（N6 降级为行为级 · 原「叠线段对 = 0（G5 采样叠点法 · 豁免共用端点 24px）」随共段禁令退休）：真板集全四把尺读数 = 0", async () => {
  const scene = await sceneOfTasks(realTasks());
  const read = rulerReadout(scene);
  assert.equal(scene.paths.length > 0, true, "真板集确有边线");
  assert.equal(read.penChip, 0, `真板：穿节点段数 = 0（实得 ${read.penChip}）`);
  assert.equal(read.penFrame, 0, `真板：穿框段数 = 0（实得 ${read.penFrame}）`);
  assert.equal(read.devMax, 0, `真板：端点偏差最大值 = 0.0px（实得 ${read.devMax}）`);
  assert.deepEqual(read.boxPairs, [], `真板：节点盒零相交（实得 ${read.boxPairs.join("、")}）`);
  assert.deepEqual(read.pressed, [], `真板：无节点压进标题带（实得 ${read.pressed.map((c) => c.taskId).join("、")}）`);
});

test("G14-②（N6 降级为行为级 · 原「模型出参 cls 分席」的模型对账退休）：class 面 ⇔ 端点落框，从 HTML 反查零模型", async () => {
  for (const [label, tasks] of [...RULER_FIXTURES(), ["真板全量集", realTasks()]]) {
    const scene = await sceneOfTasks(tasks);
    let cross = 0;
    for (const { cls, d } of scene.paths) {
      const tokens = cls.split(" ");
      assert.equal(tokens[0], "dg-edge", `${label}：首 token 恒为基础类（CSS 基础规则照命中）：${cls}`);
      assert.ok(tokens.length === 1 || (tokens.length === 2 && tokens[1] === "dg-edge-cross"), `${label}：类面闭集两枚（实得 ${cls}）`);
      const pts = dPoints(d);
      const { from, to } = needEnds(scene, pts, label);
      const isCross = tokens.length === 2;
      assert.equal(isCross, from.projectId !== to.projectId, `${label}：追加类 ⇔ 两端异框（实得 ${from.taskId}@${from.projectId} → ${to.taskId}@${to.projectId} / class ${cls}）`);
      if (isCross) cross += 1;
    }
    if (label.startsWith("pipe6")) assert.equal(cross, 4, "空转守卫：跨框着色真的发生过 4 枚");
  }
});

test("G15-②（N6 降级为行为级 · 原「件三让位不得动端点 ±1px」的让位前提退休）：全部夹具全部路由端点偏差 = 0.0px", async () => {
  let checked = 0;
  for (const [label, tasks] of [...RULER_FIXTURES(), ["真板全量集", realTasks()]]) {
    const scene = await sceneOfTasks(tasks);
    const read = rulerReadout(scene);
    assert.equal(read.devMax, 0, `${label}：端点偏差最大值 = 0（原 ±1px 余量在 ELK 面用不上）`);
    checked += scene.paths.length;
  }
  assert.ok(checked >= 20, `空转守卫：端点偏差真的逐条核了 ${checked} 枚`);
});

test("G15-③（N6 降级为行为级 · 原「汇聚端口至多一条首席直通、其余各让一档」在 ELK 面语义不成立 ⇒ 共段是原生形态）：改钉四把尺全 0 + 乱序入参同读数", async () => {
  const tasks = realTasks();
  const scene = await sceneOfTasks(tasks);
  const read = rulerReadout(scene);
  assert.equal(read.penChip, 0, "真板：共段不得越界成穿模");
  assert.equal(read.devMax, 0, "真板：汇聚端口的每一枚入边仍贴左缘中点（共段 ≠ 端点漂移）");
  // 汇聚形态本身如实登记（>= 2 枚入边贴同一左缘中点 = 合法原生形态，不再是缺陷）
  const byTail = new Map();
  for (const { d } of scene.paths) {
    const pts = dPoints(d);
    const tail = pts[pts.length - 1];
    const key = `${tail[0]},${tail[1]}`;
    byTail.set(key, (byTail.get(key) ?? 0) + 1);
  }
  const converged = [...byTail.values()].filter((n) => n >= 2).length;
  assert.ok(converged >= 1, `真板确有 ≥1 处多入边汇聚端口（实得 ${converged} 处）⇒ 本枚钉的是共段合法化后的新判据，不是空壳`);
  // 确定性：入参乱序 ⇒ 折线集合与节点集合逐字同形
  const shuffled = await sceneOfTasks([...tasks].reverse());
  assert.equal(shuffled.chips.length, scene.chips.length, "乱序入参 ⇒ chip 全集同数");
  assert.deepEqual(
    shuffled.paths.map((p) => p.d).sort(),
    scene.paths.map((p) => p.d).sort(),
    "乱序入参 ⇒ 折线集合逐字相等（几何不随入参序漂）",
  );
});

test("N2对锚①（N6 降级为行为级 · 原「画布面长边枚数 3 → 1」的长/短分档随走线族退休）：图形面吃本质边、被省略者在图形面零痕迹", async () => {
  const tasks = sample076bbb84();
  const scene = await sceneOfTasks(tasks);
  const graph = buildTaskGraph(tasks);
  const { kept, dropped } = transitiveReduce(graph.edges);
  assert.deepEqual([graph.edges.length, kept.length, dropped.length], [10, 8, 2], "夹具基线：声明 10 / 本质 8 / 省略 2");
  assert.equal(scene.paths.length, kept.length, "画布 path 枚数 === 本质边数（不是声明数）");
  const keptKeys = new Set(kept.map((e) => `${e.from}>${e.to}`));
  const drawn = scene.paths.map((p) => {
    const { from, to } = needEnds(scene, dPoints(p.d), "样本076bbb84");
    return `${from.taskId}>${to.taskId}`;
  });
  for (const key of drawn) assert.ok(keptKeys.has(key), `图形面只可能出现本质边（实得 ${key}）`);
  for (const e of dropped) assert.equal(drawn.includes(`${e.from}>${e.to}`), false, `被省略的 ${e.from}→${e.to} 在图形面零痕迹`);
  assert.equal(new Set(drawn).size, drawn.length, "本质边与折线一对一（同一枚不被画两次）");
});

test("N3对锚④（N6 降级为行为级 · 原「约简后网格 width/height ≤ 约简前」的网格盒模退休）：删冗余边不放大画布盒 + 画布固定盒零出血", async () => {
  for (const [label, tasks] of [...RULER_FIXTURES(), ["真板全量集", realTasks()]]) {
    const withRedundant = behaviorSceneOf(await htmlOfTasks(tasks));
    const withoutRedundant = behaviorSceneOf(await htmlOfTasks(dropRedundant(tasks)));
    assert.ok(
      withoutRedundant.canvas.w <= withRedundant.canvas.w + 0.01 && withoutRedundant.canvas.h <= withRedundant.canvas.h + 0.01,
      `${label}：约简后画布盒不放大（${withRedundant.canvas.w}×${withRedundant.canvas.h} → ${withoutRedundant.canvas.w}×${withoutRedundant.canvas.h}）`,
    );
    for (const f of withRedundant.frames)
      assert.ok(
        f.box.x >= 0 && f.box.y >= 0 && f.box.x + f.box.w <= withRedundant.canvas.w + 0.01 && f.box.y + f.box.h <= withRedundant.canvas.h + 0.01,
        `${label}：框盒 ${f.projectId} 完全落在画布固定盒内（出血 = 出参被裁掉）`,
      );
    for (const { d } of withRedundant.paths)
      for (const [x, y] of dPoints(d))
        assert.ok(x >= 0 && y >= 0 && x <= withRedundant.canvas.w + 0.01 && y <= withRedundant.canvas.h + 0.01, `${label}：折线点 ${x},${y} 不出画布盒`);
  }
});

test("N3不翻向确认（N6 降级为行为级 · 原「走线族三处载体仍吃声明原边集」的载体退休）：图形面吃本质边、审计面（h2 三数 + chip 依赖段）仍吃声明原值", async () => {
  const tasks = sample076bbb84();
  const html = await htmlOfTasks(tasks);
  const scene = behaviorSceneOf(html);
  const graph = buildTaskGraph(tasks);
  const { kept, dropped } = transitiveReduce(graph.edges);
  assert.equal(scene.paths.length, kept.length, "图形面 = 本质边集（约简确实发生在描边之前）");
  const h2 = parseH2(html);
  assert.equal(h2.declared, graph.edges.length, "审计面 h2「声明」仍吃原值 10");
  assert.equal(h2.omitted, dropped.length, "审计面 h2「传递省略」如实报 2");
  const n6Title = [...scene.chips].find((c) => c.taskId === "n6");
  assert.ok(n6Title !== undefined, "n6 在图形面在场");
  const depsSeg = /依赖：([^"]*)/.exec(html.split('title="n6 · ')[1] ?? "")?.[1] ?? "";
  for (const dep of ["n1", "n2", "n3", "n4", "n5"])
    assert.ok(depsSeg.includes(dep), `审计面（chip title 的依赖段）仍列声明原值 ⇒ 被省略的 ${dep} 不得从 title 里消失：实得「${depsSeg}」`);
});

// ---------------------------------------------------------------------------
// v0.10.7 N11（REQ-2026-10-15-01 · 承接轨 · 改造文档 §4「测试锚面 · 补 2 枚」）
//   补负钉锚 + 恢复全量口径（**根列车同族 2 枚负钉属宿主主笔 `.omo/skills/regression-test/`，
//   本节点只落板侧用例、不碰根列车**）：
//   ① 退休符号（阵型/画布族 + `DG_APPROACH_*` 三枚 + `layerCrossApproach`）在**去注释后**的
//      `src/graph-view.ts` 内各命中 0；
//   ② `elkjs` 在 `board/package.json.dependencies` 在册（§2.1-5 · ELK 求解器接线凭据）；
//   ③ N4 空图负钉（全量口径）：真板夹具 eb86d5e8（28 节点）走缺省求解 ⇒ 出口 HTML 不得含
//      「依赖图布局失败」/「回吐空图」两串（此前 N4出口-③ 只用 `n4Tasks` 两枚链任务，本枚补到全量面）；
//   ④ 体量登记（快照）：`src/graph-view.ts` 行数 ≤ 1200 且本文件顶层 test 枚数 ≥ 85
//      （§2.3 退休清单落地后从 v0.10.5 走线族时代 ≈ 2400 行回落到 ~860 行，反弹 = 走线族回填 = 本枚红）。
// ---------------------------------------------------------------------------

/** 去块注释（`/* … * /`）与去 `//` 到行尾的粗筛（与 §4 判据「去注释 grep」同口径 · 本节点唯一用途）。 */
const stripTsComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("N11负钉① 退休符号在去注释后的 src/graph-view.ts 内各命中 0（阵型/画布族 + DG_APPROACH 三枚 + layerCrossApproach）", () => {
  const code = stripTsComments(readFileSync(new URL("../src/graph-view.ts", import.meta.url), "utf8"));
  for (const sym of [
    "layerCrossApproach",
    "DG_APPROACH_SNAP_PX",
    "DG_APPROACH_LATERAL_PX",
    "DG_APPROACH_STUB_PX",
    "planCanvas",
    "pipeGridLayout",
  ]) {
    const hits = code.split(sym).length - 1;
    assert.equal(hits, 0, `退休符号 ${sym} 在去注释后的 src/graph-view.ts 不得残留（实得 ${hits} 处）`);
  }
});

test("N11负钉② elkjs 在 board/package.json dependencies 在册（§2.1-5 · ELK 求解器接线凭据）", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(typeof pkg.dependencies?.elkjs, "string", "dependencies.elkjs 必须是版本串");
  assert.match(pkg.dependencies.elkjs, /^\^?\d+\.\d+\.\d+/, `dependencies.elkjs 须为 semver（实得 ${pkg.dependencies?.elkjs}）`);
});

test("N11负钉③ N4 空图负钉（真板全量口径）：eb86d5e8 走缺省求解 ⇒ 出口 HTML 不含兜底两串", async () => {
  const { html } = await renderDependencyGraphSection(realTasks());
  assert.ok(html.length > 0, "真板必有出参（本枚负钉的前提，html 若空 = 出图塌 · 非「未触发兜底」）");
  assert.equal(html.includes("依赖图布局失败"), false, "N4 兜底行的字面不得出现在正常路径（真板 28 节点面）");
  assert.equal(html.includes("回吐空图"), false, "「回吐空图」四字属 catch 面独占，正常路径不得染指");
});

test("N11登记④ 体量快照：src/graph-view.ts 行数 ≤ 1200 · 本文件顶层 test 枚数 ≥ 85（退休清单落地后的回落档不得反弹）", () => {
  const viewLines = readFileSync(new URL("../src/graph-view.ts", import.meta.url), "utf8").split("\n").length;
  const testPins = readFileSync(new URL("./graph-view.test.mjs", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => /^test\(/.test(l)).length;
  assert.ok(viewLines <= 1200, `src/graph-view.ts 行数 ${viewLines} > 1200 ⇒ 退休清单落地后的回落档反弹（v0.10.5 走线族时代 ≈ 2400）`);
  assert.ok(
    testPins >= 85,
    `graph-view.test.mjs 顶层 test 枚数 ${testPins} < 85 ⇒ N11 补钉 4 枚不得摘除（N10 收口基线 82 + 本节点 4 = 86）`,
  );
});


