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
  taskSummaryLines,
  TASK_SUMMARY_MAX_CHARS,
  TASK_SUMMARY_LINE_CHARS,
  taskOrdinalMap,
  groupPipelines,
  buildGraphWithPipelines,
  nodeStateOf,
  renderDependencyGraphSection,
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
  assert.match(s.html, /<h2>依赖图（3 任务 · 1 管道 · 2 边）<\/h2>/, "同 project ⇒ 单条管道");
  assert.equal(
    (s.html.match(/<span class="dg-arrow">→<\/span>/g) ?? []).length,
    2,
    "同管道相邻 chip 之间各一枚箭头（位置性画法，管道内序 = 编号序）",
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
  assert.match(s.html, /<h2>依赖图（2 任务 · 1 管道 · 0 边）<\/h2>/, "零边进三元计数（原「源内无 -->」的自绘等价）");
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

test("T2-③区块结构（N2b 自绘）：三元计数标题 + 六态图例 + 原生管道 details + chip，零 mermaid 块", () => {
  const s = renderDependencyGraphSection([task("task-aaaaaaaa", "blocked")]);
  assert.match(s.html, /<h2>依赖图（1 任务 · 1 管道 · 0 边）<\/h2>/, "标题计数三元 = 任务 / 管道 / 边");
  assert.match(s.html, /class="hint dg-legend-row"/);
  assert.equal(
    (s.html.match(/class="dg-legend"/g) ?? []).length,
    NODE_STATE_ORDER.length,
    "图例 = 六态 + 回落全枚举（复用既有 .dg-legend 类名）",
  );
  assert.match(s.html, /已阻塞/);
  assert.match(s.html, /<details class="pipe" open>/, "管道 = 原生 details（不折叠单个节点）");
  assert.match(s.html, /<summary>管道 proj-a（1）<span class="dg-pipe-states">▨<\/span><\/summary>/);
  assert.match(s.html, /<div class="pipe-body"><span class="dg-chip dg-frozen"[^>]*>#1<\/span><\/div>/);
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

/** 剥掉全部属性值后剩下的裸 HTML —— 用于「引号只包属性值」的正面证明。 */
const stripAttrs = (html) => html.replace(/(?:class|title|style)="[^"]*"/g, "");

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

test("三轮N1-⑦布局与取色（N2c 重指向）：横滚职责迁到 .pipe-body、六条旧 mermaid 规则退役、新规则零字面色值", () => {
  const css = renderPage({ title: "t", active: "features", bodyHtml: "" });
  assert.match(css, /\.pipe-body \{[^}]*overflow-x: auto;[^}]*\}/, "管道体内横滚（承接原 .dep-graph .mermaid-block 的 scroll 职责）");
  assert.match(css, /\.pipe \{/, "管道容器类名与 graph-view 输出同面");
  assert.match(css, /\.dg-chip \{[^}]*white-space: nowrap;/, "chip 不折行（长任务名不撑破编号）");
  assert.match(css, /\.dg-arrow \{/);
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
  assert.equal(/position:\s*absolute/.test(block), false, "新规则零绝对定位连线层");
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
  assert.match(s.html, /<h2>依赖图（6 任务 · 3 管道 · 5 边）<\/h2>/);
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
    3,
    "箭头只插在同管道相邻 chip 之间（board 3 枚→2 + orch 1 枚→0 + flow 2 枚→1）",
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

test("N2b-N6跨管道边只出角标与边清单：体内零连线坐标层（无绝对定位 / 无 svg），角标 ≤3 枚超出折叠", () => {
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
  assert.equal(s.html.includes("position:absolute"), false, "体内零 position:absolute（防后人补 SVG 绝对坐标层）");
  assert.equal(s.html.includes("position: absolute"), false, "同上不认带空格形态");
  assert.equal(s.html.includes("<svg"), false, "自绘零 svg 层");
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
