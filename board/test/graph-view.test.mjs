/**
 * B-T2 用例（REQ-v0.9.3-2026-09-26-02 · Graph 详情区块）：
 * mermaid 源生成（多节点 / 环防御 / 空依赖 / 悬空边）+ application/json 数据通道断言
 * （非可执行脚本、不入 n3 闭集）+ 区块渲染形态。
 * ⑤ = 增补轨 II N1（裸 id 语法形状白名单）；⑥ = 增补轨 III N1（节点可读化：project + 任务要点）；
 * ⑧ = vendored mermaid headless `parse` 实证（历轮「结构断言过而真浏览器不渲染」的兜底门）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderPage } from "../dist/web/layout.js";
import {
  buildTaskGraph,
  taskGraphMermaidSource,
  taskSummaryLines,
  renderDependencyGraphSection,
  TASK_STATE_COLORS,
  NEUTRAL_TASK_COLOR,
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
  ...extra,
});

/** 与 graph-view/`shortId` 同口径（8 字符截断）。 */
const short = (id) => id.slice(0, 8);

// ---------------------------------------------------------------------------
// ① 源生成 · 多节点
// ---------------------------------------------------------------------------

test("T2-①多节点：3 任务链 a→b→c 的边方向 = 依赖项→依赖者，全节点入图", () => {
  const g = buildTaskGraph([
    task("task-aaaaaaaa", "completed", []),
    task("task-bbbbbbbb", "completed", ["task-aaaaaaaa"]),
    task("task-cccccccc", "working", ["task-bbbbbbbb"]),
  ]);
  assert.equal(g.nodes.length, 3);
  assert.deepEqual(
    g.edges.map((e) => `${e.from}->${e.to}`),
    ["task-aaaaaaaa->task-bbbbbbbb", "task-bbbbbbbb->task-cccccccc"],
  );
  assert.deepEqual(g.cycleEdges, []);
  assert.deepEqual(g.dangling, []);
  const src = taskGraphMermaidSource(g);
  assert.ok(src.startsWith("flowchart LR"));
  assert.match(src, /n_task-aaaaaaaa --> n_task-bbbbbbbb/);
  assert.match(src, /n_task-bbbbbbbb --> n_task-cccccccc/);
  // 节点 = project + taskId 短标 + 状态中文（无 prompt ⇒ 要点回退裸 id）+ 状态色 style（未知态中性色，known 态查表）
  assert.ok(
    src.includes(`["proj-a<br/>task-aaaaaaaa<br/>已完成"]`),
    "节点标签 = project + 要点（回退裸 id）+ 状态中文",
  );
  assert.ok(src.includes(`style n_task-cccccccc fill:${TASK_STATE_COLORS.working}`));
  const isolated = taskGraphMermaidSource(buildTaskGraph([task("task-dddddddd", "weird-state")]));
  assert.ok(isolated.includes(`style n_task-dddddddd fill:${NEUTRAL_TASK_COLOR}`));
  assert.ok(isolated.includes(`<br/>weird-state"]`), "原样态名，不吞不猜");
});

test("T2-①空依赖：全无依赖 ⇒ 全孤立节点、零边、出图不为 null", () => {
  const g = buildTaskGraph([task("task-11111111"), task("task-22222222", "working", null)]);
  assert.deepEqual(g.edges, []);
  assert.deepEqual(g.dangling, []);
  const src = taskGraphMermaidSource(g);
  assert.ok(src.includes(`n_task-11111111["proj-a<br/>task-11111111<br/>已完成"]`));
  assert.ok(!src.includes(" --> "), "无依赖 ⇒ 零边");
});

test("T2-①空任务集（v0.9.5 C2 短路③）⇒ 源为 null、依赖图整节不渲染且不挂 mermaid", () => {
  assert.equal(taskGraphMermaidSource(buildTaskGraph([])), null);
  const s = renderDependencyGraphSection([]);
  assert.equal(s.needsMermaid, false);
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

test("T2-③数据通道：mermaid 源只经 <script type=\"application/json\"> 注入，`<`/`>` 落 \\\\u 形态", () => {
  const s = renderDependencyGraphSection([
    task("task-aaaaaaaa", "completed", []),
    task("task-bbbbbbbb", "working", ["task-aaaaaaaa"]),
  ]);
  assert.equal(s.needsMermaid, true);
  // 通道载体 = application/json（带属性标签 ⇒ 非可执行内联脚本，n3 扫描器不认）
  const m = /<script type="application\/json" id="dep-graph-src-1">([\s\S]*?)<\/script>/.exec(s.html);
  assert.ok(m, "必须存在 application/json 数据通道载体");
  const payload = m[1];
  assert.ok(!payload.includes("<"), "载荷不得含裸 `<`（须为 \\\\u003c 形态）");
  assert.ok(!payload.includes(">"), "载荷不得含裸 `>`（须为 \\\\u003e 形态）");
  assert.ok(payload.includes("\\u003cbr/\\u003e"), "源文本里的 <br/> 在载荷中为 \\u 形态");
  const decoded = JSON.parse(payload);
  assert.match(decoded, /^flowchart LR/);
  assert.match(decoded, /n_task-aaaaaaaa --> n_task-bbbbbbbb/);
  // 全页无新增可执行内联脚本字面量（`<script>` 裸开标签 = 0）
  assert.ok(!/<script>/.test(s.html), "区块不得携带可执行内联脚本（渲染复用既有 mermaidRenderScript）");
});

test("T2-③区块结构：标题计数 + 图例 + 占位 div（降级保留源文本）", () => {
  const s = renderDependencyGraphSection([task("task-aaaaaaaa", "blocked")]);
  assert.match(s.html, /<h2>依赖图（1 节点 · 0 边）<\/h2>/);
  assert.match(s.html, /class="dg-legend"/);
  assert.match(s.html, /已阻塞/);
  assert.match(s.html, /class="mermaid-block" data-src="dep-graph-src-1"/);
  assert.match(s.html, /<pre class="result mermaid-src">flowchart LR/); // 渲染失败时的源文本降级
});

// ---------------------------------------------------------------------------
// ④ 确定性（同输入同输出，供快照式断言与测试稳定）
// ---------------------------------------------------------------------------

test("T2-④构图与源生成对乱序输入确定性一致", () => {
  const tasks = [
    task("task-cccccccc", "completed", ["task-bbbbbbbb"]),
    task("task-aaaaaaaa", "completed", []),
    task("task-bbbbbbbb", "completed", ["task-aaaaaaaa"]),
  ];
  const shuffled = [...tasks].reverse();
  assert.equal(taskGraphMermaidSource(buildTaskGraph(tasks)), taskGraphMermaidSource(buildTaskGraph(shuffled)));
});

// ---------------------------------------------------------------------------
// ⑤ 增补轨 II N1（第二轮根因）：节点 id 必须是裸标识符 —— mermaid 11 flowchart
//    节点位不接受 `"quoted"`（vendored 11.17.2 headless mermaid.parse 实证
//    `"a"["x"]` / `style "a" …` / `"a" --> "b"` 全部 Parse error got 'STR'
//    ⇒ 整图不渲染、走源文本降级 = 真浏览器所见「不渲染」）。
//    本组钉 = 生成源的 id 语法形状白名单（渲染链其余环节：注入 = server pageDetail
//    extraScripts、扫描 = .mermaid-block[data-src] 通用选择器、run = renderBlocks、
//    落点 = PRE 前兄弟容器，见 bd14-markdown-render.test.mjs ④c 各钉）。
// ---------------------------------------------------------------------------

/**
 * 逐行白名单：除首行 `flowchart LR` 外，只允许三种裸 id 形态（id 恒 `n_` 前缀 + [A-Za-z0-9_-]）：
 * 节点行（引号位只包标签，可带 `@{"tip":"…"}` 指令〔引号位同样只包转义后文本〕）、
 * style 行、边行。节点行同时钉住**至少含 project 行 + 状态行**（增补轨 III 的可读性下限）。
 */
const SAFE_ID = "n_[A-Za-z0-9_-]+";
const NODE_LINE_RE = new RegExp(`^  ${SAFE_ID}\\["([^"]*)"\\](?:@\\{"tip":"[^"]*"\\})?$`);
const SAFE_LINE_RE = new RegExp(
  `^(?:  ${SAFE_ID}\\["[^"]*"\\](?:@\\{"tip":"[^"]*"\\})?|  style ${SAFE_ID} fill:#[0-9a-f]{6},stroke:#8886|  ${SAFE_ID} --> ${SAFE_ID})$`,
);

/** 取节点行的标签文本（引号位内容）。 */
function labelsOf(src) {
  return src
    .split("\n")
    .slice(1)
    .map((l) => NODE_LINE_RE.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

test("二轮N1-①零引用式 id：源文本任何位置不得出现「引号包裹的节点 id」形态", () => {
  const src = taskGraphMermaidSource(
    buildTaskGraph([task("98c39da1-1111-2222-3333-444455556666"), task("ab12", "working", ["98c39da1-1111-2222-3333-444455556666"])]),
  );
  for (const line of src.split("\n").slice(1)) {
    assert.ok(SAFE_LINE_RE.test(line), `行不在裸 id 白名单形态内: ${JSON.stringify(line)}`);
  }
  assert.ok(!/^\s*"/m.test(src), "语句起始不得是引号 id（STR 位置 = 首轮 parse fail 的确切形态）");
  assert.ok(!/style\s+"/.test(src), "style 目标不得是引号 id");
  assert.ok(
    !/"/.test(src.replace(/\["[^"]*"\]/g, "").replace(/@\{"tip":"[^"]*"\}/g, "")),
    '引号只允许包标签（["…"]）与 tip（@{"tip":"…"}），不得包 id',
  );
});

test("二轮N1-②保留字与脏字符：end / 引号 / 空格 taskId ⇒ 净化为合法裸 id，引号只包转义后标签", () => {
  const g = buildTaskGraph([
    task("end", "completed", []),
    task('a"b c', "working", ["end"]),
  ]);
  const src = taskGraphMermaidSource(g);
  assert.ok(src.includes('n_end["proj-a<br/>end<br/>已完成"]'), "保留字 end 经 n_ 前缀不再撞词");
  assert.ok(src.includes('n_a_b_c["proj-a<br/>a&quot;b c<br/>执行中"]'), "脏字符入 id 被净化、入标签被 escapeHtml");
  for (const line of src.split("\n").slice(1)) {
    assert.ok(SAFE_LINE_RE.test(line), `行不在裸 id 白名单形态内: ${JSON.stringify(line)}`);
  }
});

// ---------------------------------------------------------------------------
// ⑥ 增补轨 III N1（节点可读化）：标签 = project 标识 + 任务要点（prompt 摘要截断换行）
//    + taskId 次要短标 + 状态中文；prompt 缺键 ⇒ 要点回退裸 taskId。
//    只改源文本的标签生成，渲染链 / 数据通道 / 选择器不动（增补轨 II 已验）。
// ---------------------------------------------------------------------------

test("三轮N1-①project 前缀 + 要点首行：标签首行 = projectId，要点行 = prompt 首行", () => {
  const src = taskGraphMermaidSource(
    buildTaskGraph([task("98c39da1-1111-2222-3333-444455556666", "completed", [], { projectId: "flow", prompt: "修复依赖图节点标签\n第二行不得入要点" })]),
  );
  const [label] = labelsOf(src);
  const parts = label.split("<br/>");
  assert.equal(parts[0], "flow", "首行 = project 标识");
  assert.equal(parts[1], "修复依赖图节点标签", "要点 = prompt 首行（换行归一，不多行原文照抄）");
  assert.equal(parts[2], short("98c39da1-1111-2222-3333-444455556666"), "taskId 降为次要短标");
  assert.equal(parts[3], "已完成");
  assert.ok(/@\{"tip":"98c39da1-1111-2222-3333-444455556666 · 修复依赖图节点标签 第二行不得入要点"\}/.test(src), "全量 taskId 进 hover title");
});

test("三轮N1-②prompt 缺键 / 空 / 全空白 ⇒ 要点回退裸 taskId（不吞不猜）", () => {
  for (const prompt of [null, undefined, "", "   \n  "]) {
    const src = taskGraphMermaidSource(buildTaskGraph([task("task-aaaaaaaa", "working", [], { prompt })]));
    assert.ok(
      src.includes(`["proj-a<br/>task-aaaaaaaa<br/>执行中"]`),
      `prompt=${JSON.stringify(prompt)} ⇒ 回退裸 taskId`,
    );
    assert.ok(!/"tip"/.test(src), "无要点 ⇒ 不出 tip 指令");
  }
});

test("三轮N1-③长文本截断换行：按词界换行、≤2 行、总量 ≤40 字符、超出以 … 收尾", () => {
  const src = taskGraphMermaidSource(
    buildTaskGraph([
      task(
        "task-aaaaaaaa",
        "working",
        [],
        { prompt: "aaaaaaaaa bbbbbbbbbbb ccccccccccc ddddddddddd eeeeeeeeeee fffffffffggg wwwwwwwwwwwww" },
      ),
    ]),
  );
  const parts = labelsOf(src)[0].split("<br/>");
  const summary = parts.slice(1, 3);
  assert.deepEqual(summary, ["aaaaaaaaa", "bbbbbbbbbbb ccccccccccc dddddd…"], "词界断行 + 预算内硬截断");
  assert.ok(summary.join("").replace("…", "").length <= 40, "要点总量 ≤ 40 字符");
  const cjk = taskGraphMermaidSource(
    buildTaskGraph([task("task-bbbbbbbb", "working", [], { prompt: "依赖图节点可读化改造任务要点全文超长示例用于验证按字符断行" })]),
  );
  const cjkParts = labelsOf(cjk)[0].split("<br/>");
  assert.equal(cjkParts[1].length, 20, "CJK 无空格 ⇒ 按字符断行");
  assert.equal(cjkParts[2], "用于验证按字符断行", "余下 9 字符并入第二行（未越行宽）");
  assert.ok(!cjkParts[2].endsWith("…"), "预算内（29 ≤ 40）不截断");
  assert.equal(cjkParts[3], short("task-bbbbbbbb"), "要点两行后接短标 / 状态行");
  assert.equal(cjkParts[4], "执行中");
});

test("三轮N1-④标签与 tip 均经转义：引号 / 尖括号 / & 不劈裂引号位", () => {
  const src = taskGraphMermaidSource(
    buildTaskGraph([task('a"b c', "working", [], { prompt: 'say "hi" <b>&amp;</b>' })]),
  );
  assert.ok(src.includes('say &quot;hi&quot; &lt;b&gt;&amp;amp;&lt;/b&gt;'), "要点入标签被 escapeHtml");
  assert.ok(src.includes('@{"tip":"a&quot;b c · say &quot;hi&quot; &lt;b&gt;&amp;amp;&lt;/b&gt;"}'), "tip 同样转义");
  for (const line of src.split("\n").slice(1)) {
    assert.ok(SAFE_LINE_RE.test(line), `行不在裸 id 白名单形态内: ${JSON.stringify(line)}`);
  }
});

test("三轮N1-⑤数据通道不变：要点入 JSON 载荷、区块 HTML 结构零新增脚本", () => {
  const s = renderDependencyGraphSection([task("task-aaaaaaaa", "completed", [], { prompt: "依赖图节点可读化" })]);
  assert.equal(s.needsMermaid, true);
  const m = /<script type="application\/json" id="dep-graph-src-1">([\s\S]*?)<\/script>/.exec(s.html);
  assert.ok(m, "数据通道载体不变");
  const decoded = JSON.parse(m[1]);
  assert.match(decoded, /^flowchart LR/);
  assert.ok(decoded.includes(`proj-a<br/>依赖图节点可读化<br/>${short("task-aaaaaaaa")}`), "要点经既有通道进载荷");
  assert.ok(!/<script>/.test(s.html), "不得携带可执行内联脚本");
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

test("三轮N1-⑦布局放宽：依赖图 svg 不再整体缩宽（长标签文字可读），CJK 可断词", () => {
  const css = renderPage({ title: "t", active: "features", bodyHtml: "" });
  assert.match(css, /\.dep-graph \.mermaid-block\[data-rendered="1"\] svg \{ max-width: none; height: auto; \}/);
  assert.match(css, /\.dep-graph \.mermaid-block \.nodeLabel \{ font-size: 13px; word-break: break-word; \}/);
  // 文档页（.md）的 mermaid 缩放口径不受影响
  assert.match(css, /\.md \.mermaid-block svg \{ max-width: 100%; height: auto; \}/);
});

// ---------------------------------------------------------------------------
// ⑧ vendored mermaid headless parse 实证：增补轨 I/II 的教训是「结构断言全过、真浏览器整图
//    不渲染」⇒ 语法形状白名单之外，再加一道**用实际打包进板的 mermaid 解析实际生成的源**。
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

test("三轮N1-⑧vendored mermaid headless parse：实际生成的源（含 tip / 多行标签 / 转义）必须可解析", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  installMinimalDom();
  vm.runInThisContext(readFileSync(MERMAID_BUNDLE, "utf8"), { filename: "mermaid.min.js" });
  const mermaid = globalThis.mermaid;
  assert.ok(mermaid?.parse, "vendored 包应导出 mermaid.parse");
  mermaid.initialize({ startOnLoad: false });

  const sources = [
    // 无 prompt ⇒ 回退裸 taskId + tip
    taskGraphMermaidSource(
      buildTaskGraph([
        task("98c39da1-1111-2222-3333-444455556666", "completed", []),
        task("end", "failed", ["98c39da1-1111-2222-3333-444455556666"]),
      ]),
    ),
    // 要点（长文本换行 / CJK / 转义）+ tip 指令
    taskGraphMermaidSource(
      buildTaskGraph([
        task("aaaa1111", "working", [], { prompt: '依赖图节点可读化改造要点，含 <tag> 与 "quote" 及超长中文没有空格需要按字符断行处理' }),
        task("bbbb2222", "completed", ["aaaa1111"], { projectId: 'p"x', prompt: "aaaaaaaaa bbbbbbbbbbb ccccccccccc ddddddddddd eeeee" }),
      ]),
    ),
    // 区块出口实际消费的同一份源（数据通道解出后交给 mermaid 的文本）
    (() => {
      const s = renderDependencyGraphSection([task("cccc3333", "blocked", [], { prompt: "首行要点" })]);
      return JSON.parse(/<script type="application\/json" id="dep-graph-src-1">([\s\S]*?)<\/script>/.exec(s.html)[1]);
    })(),
  ];
  for (const [i, src] of sources.entries()) {
    assert.ok(src, `第 ${i} 份源不得为 null`);
    try {
      const r = await mermaid.parse(src);
      assert.equal(r.diagramType, "flowchart-v2", `第 ${i} 份源应解析为 flowchart`);
    } catch (e) {
      assert.fail(`第 ${i} 份源 mermaid 解析失败（= 真浏览器整图不渲染）：${String((e && e.message) || e)}\n${src}`);
    }
  }
});
