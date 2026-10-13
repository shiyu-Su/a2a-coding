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
  DG_EDGE_CLS,
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
  DG_BADGE_MAX_W,
  NODE_STATE_ORDER,
  NODE_STATE_LEGEND_LABELS,
  NODE_STATE_GLYPHS,
  NODE_STATE_COLORS,
  MAX_DEP_MARKS,
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
  createdAt: null,
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
    (s.html.match(/<path class="dg-edge" d="/g) ?? []).length,
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
  assert.match(s.html, /<details class="pipe" open>/, "管道 = 原生 details（不折叠单个节点）");
  assert.match(s.html, /<summary>管道 proj-a（1）<span class="dg-pipe-states">▨<\/span><\/summary>/);
  assert.match(
    s.html,
    /<div class="pipe-body"><div class="dg-grid" style="[^"]*"><svg class="dg-links"><\/svg><span class="dg-cell" style="left:12px;top:12px"><span class="dg-chip dg-frozen"[^>]*>#1<\/span><span class="dg-deps"><\/span><\/span><\/div><\/div>/,
    "G5 翻案（②）+ 件一翻案（增补 §6.1）：结构 = pipe-body › dg-grid（零边的空 svg 照出）› dg-cell › chip + 角标带外壳（无角标 ⇒ 空带照出）",
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

test("三轮N1-⑦布局与取色（N2c 重指向 · G6 再指向）：横滚职责迁到 .pipe-body、位置性箭头规则退役、新规则零字面色值、绝对定位恰两条", () => {
  const css = renderPage({ title: "t", active: "features", bodyHtml: "" });
  assert.match(css, /\.pipe-body \{[^}]*overflow-x: auto;[^}]*\}/, "管道体内横滚（承接原 .dep-graph .mermaid-block 的 scroll 职责）");
  assert.match(css, /\.pipe \{/, "管道容器类名与 graph-view 输出同面");
  assert.match(css, /\.dg-chip \{[^}]*white-space: nowrap;/, "chip 不折行（长任务名不撑破编号）");
  assert.equal(css.includes(".dg-arrow"), false, "G6 翻案（③）：`.dg-arrow` 整条退役（图面已由 G5 改真依赖边线 ⇒ 无此类可着色）");
  assert.match(css, /\.dg-dep \{/);
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
  // ⇒ 现钉「绝对定位恰两枚规则 = 边线层 .dg-links + 节点格位 .dg-cell」（溢出第三枚即红）
  const absRules = block
    .split("\n")
    .filter((l) => /position:\s*absolute/.test(l))
    .map((l) => l.trim().replace(/\s*\{.*$/, ""));
  assert.deepEqual(absRules, [".dg-links", ".dg-cell"], "绝对定位恰两条（边线层 + 格位）；坐标原点 = 非定位的 .dg-grid（position:relative）");
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
    assert.equal(block.includes(`${v}px`), false, `CSS 区间零尺寸字面（不得内嵌 ${v}px；下发面 = .dg-grid inline）`);
  const inline = renderDependencyGraphSection([task("t-here", "completed", [])]).html.match(/<div class="dg-grid" style="([^"]*)">/);
  assert.ok(inline !== null, "下发面在场（几何变量的唯一出口）");
  assert.ok(
    inline[1].includes(`--dg-nw:${DG_NODE_W}px;--dg-nh:${DG_NODE_H}px;--dg-bh:${DG_BADGE_H}px`),
    "下发三键的数值逐字取自导出常量（改常量 ⇒ 板面自动跟随，改 CSS 数字 ⇒ 本条红）",
  );
});

test("G6-同源②新规则零盒模字面 + 消费键 ⊆ / = 下发键；z-index 分野与坐标原点在 .dg-grid", () => {
  const block = pipeCssBlock();
  // ① 新规则的 width / height 声明只许两种形态：下发变量 或 100%（父盒 = .dg-grid 自身）
  for (const sel of [".dg-grid", ".dg-cell", ".dg-links", ".dg-links path", ".dg-deps"]) {
    const sizes = cssDecls(cssRule(block, sel)).filter((d) => /^(width|height):/.test(d));
    for (const d of sizes)
      assert.match(d, /^(width|height): (var\(--dg-(nw|nh|bh)\)|100%)$/, `${sel} 的盒模声明不得写数字：${d}`);
  }
  assert.deepEqual(cssDecls(cssRule(block, ".dg-deps")).filter((d) => /^height:/.test(d)), ["height: var(--dg-bh)"], "角标带高与 DG_BADGE_H 同源");
  // ② 消费键 = 下发键（多一个悬空键 / 少一个未被消费 ⇒ 本条红）
  const consumed = [...new Set([...block.matchAll(/var\(--dg-(\w+)\)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(consumed, ["bh", "nh", "nw"], "CSS 消费的 --dg-* 键闭集 = 下发的三枚");
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
  assert.ok(grid.includes("flex: none"), ".pipe-body 是 flex 容器 ⇒ 网格不得被压缩（压缩即 svg 视口小于网格 ⇒ 长边被裁）");
  // ④ 既有面不破：横滚声明独立保留、七条变体与图例一律不动
  assert.match(cssRule(block, ".pipe-body"), /overflow-x: auto/, "横滚声明独立保留（未并入其它声明）");
  assert.equal((block.match(/^[ \t]*\.dg-chip\.dg-\w+ \{/gm) ?? []).length, 7, "七条 chip 状态变体一条不动");
  assert.equal(block.includes(".dg-arrow"), false, "位置性箭头规则已整条退役（与 ⑦ 翻案③同锚）");
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

test("N2a-N5排序键确定性：queuedAt 升序 / null 沉底 / 同值按 taskId 兜稳；乱序入参全等；本体未动（环边同值）", () => {
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

  // 组内排序键同口径：queuedAt null 的管道节点在缺号断言下仍沉底
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
  assert.equal((s.html.match(/<details class="pipe" open>/g) ?? []).length, 3, "每 project 一枚管道且默认展开");
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
  assert.equal((s.html.match(/<div class="pipe-body">/g) ?? []).length, 3, "每管道一枚 pipe-body（滚动职责归 N2c 的 CSS）");

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
    3,
    "边线层按管道分席 ⇒ 每 project 恰一枚（board 1 条板内边 / orch 与 flow 零板内边 ⇒ 空 svg 照出）",
  );
  assert.equal(
    (s.html.match(/<path class="dg-edge" d="/g) ?? []).length,
    1,
    "五边中只有 t-b1→t-b2 两端同管道 ⇒ 全图恰一枚 path（跨管道边结构上不入走线）",
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

test("N2b-N6跨管道边只出角标与边清单：坐标层按管道分席（inline 零 position，每管道恰一枚 svg），角标 ≤3 枚超出折叠", () => {
  const s = renderDependencyGraphSection(pipe6Tasks());
  // 4 条跨管道边（第 5 条 t-b1→t-b2 同管道）⇒ 4 枚角标 + 一行边清单
  assert.equal(
    (s.html.match(/<sup class="dg-dep">⇠#\d+<\/sup>/g) ?? []).length,
    4,
    "角标枚数 === 跨管道边枚数",
  );
  assert.match(
    s.html,
    /<p class="hint dg-edges">跨管道边：#1 ⇢ #4\(flow\)、#2 ⇢ #3\(orch\)、#4 ⇢ #6\(board\)、#3 ⇢ #5\(flow\)（全量依赖见各节点 title）<\/p>/,
    "边清单 = 图区底部一行（列全部跨管道边，不受角标封顶影响）",
  );
  assert.ok(s.html.indexOf("dg-edges") > s.html.indexOf("</details>"), "边清单在管道之后（图区底部）");
  assert.equal(s.html.includes("position:absolute"), false, "inline style 零 position 声明（cell 只带 left/top，定位归 CSS）");
  assert.equal(s.html.includes("position: absolute"), false, "同上不认带空格形态");
  assert.equal(
    (s.html.match(/<svg class="dg-links">/g) ?? []).length,
    (s.html.match(/<details class="pipe" open>/g) ?? []).length,
    "G5 翻案（⑧）：原「自绘零 svg 层」原地重指向为「每管道恰一枚 dg-links」（与管道枚数同源 ⇒ 不多不少）",
  );
  assert.equal(s.html.includes("<script"), false, "零 script 标签（n3 内联闭集不扩）");
  // 无跨管道边 ⇒ 整行不渲
  const noCross = renderDependencyGraphSection([task("a1"), task("a2", "completed", ["a1"])]);
  assert.equal(noCross.html.includes("dg-edges"), false, "全无跨管道边 ⇒ 边清单整行不渲");
  // 角标封顶：5 枚跨管道依赖 ⇒ 3 枚 + ⇠+2
  const many = renderDependencyGraphSection([
    ...[1, 2, 3, 4, 5].map((i) =>
      task(`m${i}`, "completed", [], { projectId: "src", queuedAt: `2026-10-11T00:00:0${i}Z` }),
    ),
    task("tgt", "completed", ["m1", "m2", "m3", "m4", "m5"], {
      projectId: "dst",
      queuedAt: "2026-10-11T00:00:06Z",
    }),
  ]);
  assert.equal(MAX_DEP_MARKS, 3, "角标封顶枚数 = 3（与派发消息一致）");
  assert.ok(
    many.html.includes('<sup class="dg-dep">⇠#3</sup><sup class="dg-dep dg-dep-more">⇠+2</sup>'),
    "第 4 枚起折叠为 ⇠+#m",
  );
  assert.equal(many.html.includes("⇠#4"), false, "被折叠的来源不再逐枚出角标");
  assert.equal((many.html.match(/⇢/g) ?? []).length, 5, "边清单仍列全 5 条（折叠只作用于角标）");
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
  assert.equal((s.html.match(/<details class="pipe" open>/g) ?? []).length, 1);
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
  assert.ok(L.width >= rightmost + DG_BADGE_MAX_W, `I4 宽：${L.width} ≥ 最右 chip 右缘 ${rightmost} + ${DG_BADGE_MAX_W}`);
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

test("G7-定宽①设计界关系式：角标越界 ≤ 通道下界 ⇒ 定宽不破、右侧留白足够", () => {
  const marks = MAX_DEP_MARKS + 1; // 3 枚原值 + 1 枚折叠 = 至多 4 枚
  assert.equal(marks, 4, "角标枚数上界 = MAX_DEP_MARKS + 1");
  assert.ok(marks * BADGE_MARK_DESIGN_W <= DG_BADGE_MAX_W, `${marks} 枚 × ${BADGE_MARK_DESIGN_W}px ≤ DG_BADGE_MAX_W（设计界）`);
  const overhang = DG_BADGE_MAX_W - DG_NODE_W;
  assert.ok(overhang <= DG_COL_GAP_MIN, "列间：角标越界 ≤ 通道宽下界 ⇒ 不越入下一列 chip");
  assert.ok(overhang <= DG_PAD_R, "末列：角标越界 ≤ 右内缘下界");
  assert.equal(DG_NODE_W, 74, "chip 定宽 = 74（box-sizing:border-box）");
  assert.equal(DG_NODE_H, 28);
  assert.equal(DG_BADGE_H, 14);
  assert.equal(DG_ROW_GAP, 4);
  assert.equal(DG_COL_GAP_MIN, 56);
  assert.equal(DG_LANE_PITCH, 14);
  assert.equal(DG_LANE_MIN, 22);
  assert.equal(DG_ARC_K_MAX, 34);
  assert.equal(DG_BUS_PITCH, 12);
  assert.equal(DG_PAD_L, 12);
  assert.equal(DG_PAD_T, 12);
  assert.equal(DG_PAD_B, 12);
  assert.equal(DG_PAD_R, 96);
  assert.equal(DG_BADGE_MAX_W, 130);
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
// 坐标**按管道分席**：每管道一枚独立 `.dg-grid`，跨管道的 left/top 不可横向比 ⇒ 逐 `pipe-body` 各对各的。
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

/** 渲染态 chip 的纵中点（列向 flex + `order:-1` ⇒ 角标带压在 chip 之上；无外壳 ⇒ 不带那 14px）。 */
const renderedChipMidY = (c) => c.top + (c.hasBand ? DG_BADGE_H : 0) + DG_NODE_H / 2;

test("件一②模型↔渲染：每条 d 的首末点 === 渲染 HTML 里两端 cell 的 chip 右缘/左缘中点（按管道分席）", () => {
  /** @param tasks 夹具 @param label 夹具名 @param minChecked 空转守卫下界 */
  const reconcile = (tasks, label, minChecked) => {
    // 取数源 = 约简后 `kept`（与渲染层五消费点同源）；照吃声明原边集 ⇒ 约简一发生本条必红
    const edges = transitiveReduce(buildGraphWithPipelines(tasks).edges).kept;
    const { html } = renderDependencyGraphSection(tasks);
    const bodies = html.split('<div class="pipe-body">').slice(1);
    assert.ok(bodies.length >= 1, `${label}：确有管道体（每管道一枚独立坐标层）`);
    let checked = 0;
    for (const b of bodies) {
      const cells = renderedCells(b);
      assert.ok(cells.size > 0, `${label}：本管道体内确有 cell（逐边核对不得空跑）`);
      const ds = (b.match(/<path class="dg-edge" d="([^"]*)"/g) ?? []).map((s) => dPoints(/d="([^"]*)"/.exec(s)[1]));
      const intra = edges.filter((e) => cells.has(e.from) && cells.has(e.to));
      assert.equal(
        ds.length,
        intra.length,
        `${label}：本管道 path 枚数 === 板内**本质**边枚数（跨管道边结构上不入走线、传递省略边不入图形面 ⇒ 不得多画或少画）`,
      );
      for (const e of intra) {
        const a = cells.get(e.from);
        const c = cells.get(e.to);
        const first = [a.left + DG_NODE_W, renderedChipMidY(a)];
        const last = [c.left, renderedChipMidY(c)];
        const hit = ds.find((pts) => String(pts[0]) === String(first) && String(pts[pts.length - 1]) === String(last));
        assert.ok(
          hit !== undefined,
          `${label} ${e.from}→${e.to}：渲染 cell 几何推出的端点 [${first}]→[${last}] 必有一条 d 与之逐点相等` +
            `（实得首末点族 = ${ds.map((p) => `[${p[0]}]→[${p[p.length - 1]}]`).join(" ")}）`,
        );
        checked += 1;
      }
    }
    assert.ok(checked >= minChecked, `空转守卫：${label} 逐边核对真的跑了 ${checked} 条（下界 ${minChecked}）`);
    return checked;
  };
  assert.equal(reconcile(sample076bbb84(), "样本076bbb84", 8), 8, "单管道声明 10 边 → 本质 8 边、7 cell ⇒ 全数对账（改前全 10 条偏 14）");
  assert.equal(reconcile(pipe6Tasks(), "pipe6", 1), 1, "副夹具只有 board 的 t-b1→t-b2 一枚板内边 ⇒ 覆盖「外壳在场（哪怕是空带）的 cell 也必须对齐」");
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
    const grid = html.match(/<div class="dg-grid" style="([^"]*)">/);
    assert.ok(grid !== null, "网格壳在场（几何变量的唯一下发面）");
    const decls = grid[1].split(";").filter((s) => s !== "");
    assert.deepEqual(
      decls.map((s) => s.slice(0, s.indexOf(":"))),
      ["--dg-nw", "--dg-nh", "--dg-bh", "width", "height"],
      "下发键闭集 = 三枚尺寸变量 + 盒模两枚（顺序固定 ⇒ 渲染确定性）",
    );
    for (const d of decls) assert.match(d, /^[\w-]+:\d+px$/, `声明 = 名:整数px：${d}`);
  }
});

test("G8-svg负钉③：每管道恰一枚 dg-links + 一枚 dg-grid；cell 枚数 === 节点枚数、每 cell 恰一枚 chip", () => {
  for (const [tasks, pipes, nodes] of [
    [pipe6Tasks(), 3, 6],
    [sample076bbb84(), 1, 7],
  ]) {
    const { html } = renderDependencyGraphSection(tasks);
    const bodies = html.split('<div class="pipe-body">').slice(1);
    assert.equal(bodies.length, pipes, "pipe-body 枚数 === 管道枚数");
    for (const b of bodies) {
      assert.equal((b.match(/<svg class="dg-links">/g) ?? []).length, 1, "每段（= 每管道）恰一枚边线层");
      assert.equal((b.match(/<div class="dg-grid" style="/g) ?? []).length, 1, "每段恰一枚网格壳");
    }
    assert.equal((html.match(/<span class="dg-cell" style="/g) ?? []).length, nodes, "cell 枚数 === 节点枚数（不丢不重）");
    const chips = html.match(/<span class="dg-chip dg-\w+" title="[^"]*">#\d+<\/span>/g) ?? [];
    assert.equal(chips.length, nodes, "每 cell 恰一枚 chip，出参字面与 N2b 逐字相同（角标已去内联）");
    assert.equal(html.includes("dg-edges"), html.includes('<p class="hint dg-edges">'), "新类名不含子串 dg-edges ⇒ 边清单在场判据仍逐字可用");
  }
});

// 件一（增补 §6.1 · 取 (A) 外壳恒渲）新增锚①：**DOM 侧枚数对账 + 机制侧两枚声明**。
// 外壳恒渲把「每 cell 恒预留 `DG_BADGE_H`」从**约定**升为**结构事实** ⇒ 本条两半缺一不可：
// DOM 半（外壳枚数 === cell 枚数，空带也在场）钉「渲了什么」，机制半（`.dg-cell` 列向 flex +
// `.dg-deps` `order:-1`）钉「为什么预留落在 chip 之上」—— 只钉 DOM 不钉布局 = 锚②的递推式无据。

test("件一①外壳恒渲：.dg-deps 外壳枚数 === cell 枚数（空带照出）+ 列向排布两枚声明钉字面", () => {
  for (const [tasks, label, cells, nonEmpty] of [
    [pipe6Tasks(), "pipe6（4 枚跨管道角标 ⇒ 有带 / 空带同场）", 6, 4],
    [sample076bbb84(), "样本076bbb84（角标恒 0 ⇒ 全空带）", 7, 0],
  ]) {
    const { html } = renderDependencyGraphSection(tasks);
    const cellCount = (html.match(/<span class="dg-cell" style="/g) ?? []).length;
    assert.ok(cellCount > 0, "空转守卫：确有 cell（枚数相等不得靠两侧同零成立）");
    assert.equal(cellCount, cells, `${label}：cell 枚数 === 节点枚数`);
    const shells = (html.match(/<span class="dg-deps">/g) ?? []).length;
    assert.equal(shells, cellCount, `${label}：角标带外壳枚数 === cell 枚数（无角标 ⇒ 出空带，不再连外壳一起省掉）`);
    assert.equal((html.match(/<span class="dg-deps"><sup/g) ?? []).length, nonEmpty, `${label}：非空带枚数 === 有跨管道角标的 cell 枚数`);
    assert.equal(
      (html.match(/<span class="dg-deps"><\/span>/g) ?? []).length,
      cellCount - nonEmpty,
      `${label}：空带枚数 === 无角标的 cell 枚数（预留由空带承担）`,
    );
  }
  // 机制侧：预留为什么落在 chip **之上**（列向排布 + order:-1），且带高与 DG_BADGE_H 同源（G6-同源② 既有锚不重复）
  const block = pipeCssBlock();
  assert.deepEqual(
    cssDecls(cssRule(block, ".dg-cell")).filter((d) => /^flex-direction:/.test(d)),
    ["flex-direction: column"],
    ".dg-cell 列向排布（横排 ⇒ 空带不再抬 chip 顶缘 ⇒ 锚②递推式失效）",
  );
  assert.deepEqual(
    cssDecls(cssRule(block, ".dg-deps")).filter((d) => /^order:/.test(d)),
    ["order: -1"],
    ".dg-deps 排在 chip 之前（DOM 序 chip→带、视觉序 带→chip ⇒ 带压在 chip 之上）",
  );
});

// ---------------------------------------------------------------------------
// G9（v0.10.5 · REQ-2026-10-12-02 · 改造文档 §5 锚账「完备性总账」· **N2 换口径 = 方案 B**）：
// 每条**本质边**（`kept`）在图形面**恰有一个出口** —— 两端同管道 ⇒ 一枚 `path`；两端异管道 ⇒ 一枚角标。
// 约简在场后总账拆三段：**主账** `paths + marks === J`；**对账锚①** `原边数 === J + 省略清单长度`
// （抓住「约简自己吞边」）；**对账锚②** 每条省略边 `(u,v)` 满足 `v ∈ reach_kept(u)`
// （= 「省略的边都还能由 kept 推出」，约简不丢真实等待的机器判据）。
// 吞边 / 重边两种形态仍由主账抓；**双出口非空转守卫**保留（`paths>0 && marks>0`）。
// 两枚枚数按 class / 字面串定位（不写行号）。
// ---------------------------------------------------------------------------

/**
 * 图形面两枚出口的枚数（**v0.10.5 N2 起**：两枚出口共同覆盖的是**约简后边集 `kept`**，
 * 不再是声明原边集 —— 传递省略的边结构上不入图形面，由对账锚① 单独收口）。
 * 角标只认 `⇠#k` 形态 —— 折叠枚 `⇠+m` 的出参枚数依赖 `MAX_DEP_MARKS` 封顶，
 * 与边数不成一比一（折叠形态由 N2b-N6 单独钉），故不入总账。
 */
const graphFaceLedger = (html) => ({
  paths: (html.match(/<path class="dg-edge" d="/g) ?? []).length,
  marks: (html.match(/<sup class="dg-dep">⇠#\d+<\/sup>/g) ?? []).length,
});

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

test("G9-完备总账①管道制夹具（6 任务 / 3 管道 / 声明 5 边 · 本质 5）：path 枚数 + 角标枚数 === kept 枚数", () => {
  const tasks = pipe6Tasks();
  const { html } = renderDependencyGraphSection(tasks);
  const { paths, marks } = graphFaceLedger(html);
  const { declared, kept, dropped } = edgeLedgers(tasks);
  assert.deepEqual([paths, marks, kept.length], [1, 4, 5], "夹具现态 = 1 枚板内 path + 4 枚跨管道角标 / 5 条本质边");
  assert.ok(paths > 0 && marks > 0, "空转守卫：两枚出口在本夹具各有实例 ⇒ 漏任一侧必被本条抓住");
  assert.equal(paths + marks, kept.length, "主账：同管道边出 line、跨管道边出角标 ⇒ 每条本质边恰一个出口，不吞不重");
  assert.equal(declared.length, kept.length + dropped.length, "对账锚①：声明数 === 本质 + 省略");
  assert.equal(dropped.length, 0, "本夹具无冗余 ⇒ 省略清单空（主账与旧口径同值，不因此空转）");
});

test("G9-完备总账②单管道夹具（sample076bbb84，7 任务 / 1 管道 / 声明 10 边 → 本质 8）：本质边全入走线、角标恒 0 而总账仍成立", () => {
  const tasks = sample076bbb84();
  const { html } = renderDependencyGraphSection(tasks);
  const { paths, marks } = graphFaceLedger(html);
  const { declared, kept, dropped } = edgeLedgers(tasks);
  assert.ok(kept.length > 1, "空转守卫：本夹具确有本质边");
  assert.deepEqual([declared.length, kept.length, dropped.length], [10, 8, 2], "夹具现态 = 声明 10 → 本质 8 · 省略 2");
  assert.deepEqual(
    dropped.map((e) => `${e.from}→${e.to}`),
    ["n1→n6", "n2→n6"],
    "省略的两条 = n1→n6（经 n2/n3 可推）与 n2→n6（经 n3 可推）",
  );
  assert.equal(marks, 0, "单 project ⇒ 结构上无跨管道边 ⇒ 角标零枚（角标族不被本夹具误触发）");
  assert.equal(html.includes("dg-edges"), false, "无跨管道边 ⇒ 边清单整行不渲（与①的对照面）");
  assert.equal(paths + marks, kept.length, "主账：本质边全入走线 ⇒ path 枚数即本质边数（照吃声明原边集会在此判红）");
  assert.equal(declared.length, kept.length + dropped.length, "对账锚①：10 === 8 + 2");
  for (const e of dropped) {
    assert.ok(reachFrom(kept, e.from).has(e.to), `对账锚②：省略边 ${e.from}→${e.to} 在 kept 上仍传递可达（约简不吞边）`);
  }
});

test("G9-完备总账③空图短路：零任务 ⇒ 区块空串（两枚出口各 0、边数 0，总账不作真而通过）", () => {
  const { html } = renderDependencyGraphSection([]);
  const { paths, marks } = graphFaceLedger(html);
  const { kept, dropped } = edgeLedgers([]);
  assert.equal(html, "", "v0.9.5 C2 短路③：无任务 ⇒ 依赖图整节不渲染");
  assert.deepEqual([kept.length, dropped.length], [0, 0], "空任务集 ⇒ 零本质边、零省略边（取数源 = 约简集）");
  assert.deepEqual([paths, marks], [0, 0], "空图 ⇒ 两枚出口各零枚（无吞边、无凭空出的线 / 角标）");
  assert.equal(paths + marks, kept.length, "总账在短路形态同样成立（0 + 0 === 0）");
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

test("N1约简-⑤纯定序边（C1 关键）：单枚跨管道边、无平行路径 ⇒ R=0、kept 含该边（角标族的入边不被误删）", () => {
  const graph = buildTaskGraph(pureOrderTasks());
  assert.equal(graph.edges.length, 1, "夹具现态 = 恰一枚跨管道边");
  assert.notEqual(
    graph.nodes.find((n) => n.taskId === "t-src").projectId,
    graph.nodes.find((n) => n.taskId === "t-dst").projectId,
    "两端异 project ⇒ 该边在图形面走角标出口（不是 path）",
  );
  const { kept, dropped } = transitiveReduce(graph.edges);
  assert.deepEqual(edgeTexts(kept), ["t-src→t-dst"], "为定序而声明的边照留（误删 ⇒ 角标族整族空转）");
  assert.deepEqual(edgeTexts(dropped), [], "R=0 —— 无平行可达路径 ⇒ 删边测试判不出冗余");
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

/** 区块 HTML → 边线清单 `{isLong, first, last, cells}`（长边 = `d` 含水平段命令 `L`；按管道分席）。 */
function renderedEdges(html) {
  const out = [];
  for (const b of html.split('<div class="pipe-body">').slice(1)) {
    const cells = renderedCells(b);
    for (const raw of b.match(/<path class="dg-edge" d="([^"]*)"/g) ?? []) {
      const d = /d="([^"]*)"/.exec(raw)[1];
      const pts = dPoints(d);
      out.push({ isLong: dCmds(d).includes("L"), first: pts[0], last: pts[pts.length - 1], cells });
    }
  }
  return out;
}

/** 渲染态端点坐标 → taskId（右缘中点 = 源、左缘中点 = 目标；两侧都用**渲染 HTML** 的 left/top 反查）。 */
function taskIdByEdgePoint(cells, point, side) {
  for (const [taskId, c] of cells) {
    const x = side === "from" ? c.left + DG_NODE_W : c.left;
    if (x === point[0] && renderedChipMidY(c) === point[1]) return taskId;
  }
  assert.fail(`端点 [${point}]（${side} 侧）在渲染 cell 里反查不到 ⇒ 线头悬空`);
}

/** 区块 HTML → 跨管道边的两枚出口计数（`.dg-edges` 清单枚数 / 角标**原值**枚数 = 显示枚 + 折叠枚）。 */
function crossFaceCounts(html) {
  const row = /<p class="hint dg-edges">([^<]*)<\/p>/.exec(html);
  const list = row === null ? 0 : (row[1].match(/⇢/g) ?? []).length;
  const shown = (html.match(/<sup class="dg-dep">⇠#\d+<\/sup>/g) ?? []).length;
  const hidden = (html.match(/<sup class="dg-dep dg-dep-more">⇠\+(\d+)<\/sup>/g) ?? []).reduce(
    (acc, s) => acc + Number(/⇠\+(\d+)/.exec(s)[1]),
    0,
  );
  return { list, marksShown: shown, marksRaw: shown + hidden };
}

/** 本质边里的跨管道边清单（与渲染层同一取数源：先约简、再分跨管道 / 板内）。 */
function crossKeptEdges(tasks) {
  const graph = buildTaskGraph(tasks);
  const projectOf = new Map(graph.nodes.map((n) => [n.taskId, n.projectId]));
  return transitiveReduce(graph.edges).kept.filter((e) => projectOf.get(e.from) !== projectOf.get(e.to));
}

/**
 * 折叠 + 约简**同时在场**的组合夹具（改造文档 §4 同源对锚③）：
 * `src` 管道内 `a1→a2` 已成链 ⇒ `a1⇢t1` 可经 `a1→a2→t1` 推出（省略 1 枚）；
 * 余下 4 枚跨管道本质边 > `MAX_DEP_MARKS` ⇒ 折叠枚 `⇠+1` 同场。
 * （现 `many` 夹具无冗余 ⇒ 折叠锚测不到约简交互，故另立本夹具。）
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
 * 被删的是**跨管道**边（若 `c` 也放 `board`，`a→c` 就成板内边、测不到角标与清单的同步）。
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

test("N2对锚①区块面长边枚数 = 1（约简把样本的 3 枚长边降到 1；走线族入参照旧不翻向）", () => {
  const tasks = sample076bbb84();
  const { html } = renderDependencyGraphSection(tasks);
  assert.deepEqual(
    g3Sample().routes.filter((e) => e.kind === "long").map((e) => `${e.from}→${e.to}`),
    ["n1→n6", "n2→n6", "n5→n6"],
    "G3/G4/G5 走线族仍吃**声明原边集** ⇒ 路由器侧长边 3 枚不变（本需求不翻向）",
  );
  const edges = renderedEdges(html);
  assert.equal(edges.length, 8, "区块面边线枚数 === 本质边数 8（不是声明数 10）");
  const longs = edges.filter((e) => e.isLong);
  assert.equal(longs.length, 1, "区块面长边由 3 降到 1（约简掉的正是那两枚跨列长边）");
  const e = longs[0];
  const from = taskIdByEdgePoint(e.cells, e.first, "from");
  const to = taskIdByEdgePoint(e.cells, e.last, "to");
  assert.deepEqual([from, to], ["n5", "n6"], "幸存的长边 = n5→n6（端点反查渲染 cell，不是从模型直取）");
  assert.equal(edges.filter((x) => !x.isLong).length, 7, "其余 7 枚相邻弧不变 ⇒ 约简只削长边、不短化相邻边");
});

test("N2对锚②`.dg-edges` 清单枚数 === 角标原值枚数（同集合同源，折叠不改原值）", () => {
  for (const [label, tasks] of [
    ["pipe6（4 枚跨管道边、无折叠）", pipe6Tasks()],
    ["样本076bbb84（零跨管道边 ⇒ 两侧同 0）", sample076bbb84()],
    ["折叠+约简组合（原值 4 · 显示 3 + 折叠 1）", foldReduceTasks()],
    ["跨管道同集（原值 2 · 无折叠）", crossReduceTasks()],
  ]) {
    const { html } = renderDependencyGraphSection(tasks);
    const { list, marksRaw, marksShown } = crossFaceCounts(html);
    const cross = crossKeptEdges(tasks);
    assert.equal(list, cross.length, `${label}：底部清单枚数 === 本质跨管道边枚数`);
    assert.equal(marksRaw, cross.length, `${label}：角标原值枚数（显示 + 折叠）=== 本质跨管道边枚数 ⇒ 不会出现「图上没线、清单还列着」`);
    assert.equal(list, marksRaw, `${label}：两枚出口同数（折叠只压显示枚、不动原值）`);
    assert.ok(marksShown <= cross.length, `${label}：显示枚 ≤ 原值枚`);
  }
  // 非空转：夹具里确有「折叠在场」与「两侧同零」两种形态
  const folded = crossFaceCounts(renderDependencyGraphSection(foldReduceTasks()).html);
  assert.deepEqual([folded.marksShown, folded.marksRaw, folded.list], [3, 4, 4], "空转守卫：折叠形态真的发生过（显示 3 / 原值 4 / 清单 4）");
  const none = crossFaceCounts(renderDependencyGraphSection(sample076bbb84()).html);
  assert.deepEqual([none.marksRaw, none.list], [0, 0], "空转守卫的另一侧：单管道 ⇒ 两枚出口同零（不得只靠一侧零成立）");
});

test("N2对锚③折叠 + 约简同时在场：被省略的 a1⇢t1 既不入清单、也不占角标位（折叠数按约简后原值算）", () => {
  const { html } = renderDependencyGraphSection(foldReduceTasks());
  const ordinals = taskOrdinalMap(foldReduceTasks());
  assert.equal(ordinals.get("a1"), 1, "夹具基线：a1 = #1");
  assert.equal(html.includes("⇠#1"), false, "省略边的来源不再出角标（原值 4 枚 = a2/b1/b2/b3）");
  assert.equal(html.includes("#1 ⇢"), false, "省略边的来源不再进底部清单");
  assert.ok(html.includes('<sup class="dg-dep dg-dep-more">⇠+1</sup>'), "折叠枚 = 原值 4 − 封顶 3 = 1（约简在前、折叠在后）");
  assert.equal((html.match(/<sup class="dg-dep">⇠#\d+<\/sup>/g) ?? []).length, MAX_DEP_MARKS, "显示角标恰吃满封顶 3 枚");
  assert.equal((html.match(/<path class="dg-edge" d="/g) ?? []).length, 1, "板内边只 a1→a2 一枚（t1 的入边全是跨管道边 ⇒ 不入走线）");
});

test("N2跨管道同集：约简在全图上做一次 ⇒ 角标与 `.dg-edges` 清单同步减一（管道内边与跨管道边共用同一约简集）", () => {
  const tasks = crossReduceTasks();
  const { html } = renderDependencyGraphSection(tasks);
  const graph = buildTaskGraph(tasks);
  assert.equal(graph.edges.length, 3, "夹具现态 = 3 条声明边（全部跨管道）");
  assert.deepEqual(
    transitiveReduce(graph.edges).dropped.map((e) => `${e.from}→${e.to}`),
    ["x-a→x-c"],
    "被删的是**跨管道**边 x-a→x-c（经 x-b 可推出）",
  );
  const { list, marksRaw } = crossFaceCounts(html);
  assert.deepEqual([list, marksRaw], [2, 2], "两枚出口从 3 同步降到 2 ⇒ 分开跑约简会在此判红（走线与角标互相不一致）");
  /** 一枚 taskId 的角标带内文（渲染 HTML 反查 ⇒ 能定位「谁挂了哪几枚来源」，不只看总数）。 */
  const bandOf = (taskId) => {
    const m = new RegExp(
      `title="${taskId} · [^"]*">#\\d+<\\/span><span class="dg-deps">((?:<sup[^>]*>[^<]*<\\/sup>)*[^<]*)<\\/span>`,
    ).exec(html);
    assert.ok(m !== null, `${taskId} 的角标带在场`);
    return m[1];
  };
  assert.equal(bandOf("x-b"), '<sup class="dg-dep">⇠#1</sup>', "b 的角标 = a（本质边 a→b 照出）");
  assert.equal(bandOf("x-c"), '<sup class="dg-dep">⇠#2</sup>', "c 的角标只剩 b（#2）⇒ 省略的 a→c 不占角标位");
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
  // 并存不冲突：区块面（渲染层，吃 kept）长边 1 枚 vs 走线族（入参面，吃声明集）长边 ≥2 枚 —— 两个面各钉各的
  const blockFace = renderedEdges(renderDependencyGraphSection(sample076bbb84()).html);
  assert.equal(blockFace.filter((e) => e.isLong).length, 1, "区块面长边枚数 = 1（N2对锚① 口径，与上面两面并存）");
  assert.ok(g45Layout(sample076bbb84()).routes.filter((e) => e.kind === "long").length >= 2, "走线族载体断言「≥2 条长边」仍在场（未被区块面的 1 枚带跑）");
});
