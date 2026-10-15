/**
 * REQ-2026-10-11-03（板面免手刷）· N8 新档行为与结构锚 —— `data-live` 刷新面（SSR 档）
 * + 第八枚 `PAGE_LIVE_SCRIPT` 与件B 扩写（脚本字面量档）。
 *
 * 本档**只钉结构、不验运行时**：SSR 面 = 真起板取 HTML，脚本面 = 钉内联常量的字面量
 * （风格照 `n3-regression-anchors.test.mjs` 的 N3-⑥b/c/d）。真机项在改造文档 §4 清单，不在本档伪造通过。
 *
 * 三组锚：
 *  · **A. SSR 面** —— 恰 8 枚锚 key / 三档周期字面量与任务页 ≥15000 硬下限 / 控制条（时钟+⟳钮）
 *    / 控制条不入锚的结构负钉 / 零 `data-live` 页清单；
 *  · **B. 脚本面** —— 只读钉 / 换块协议（容器节点永不被替换）/ 跳拍判据四条 / 任务页动线与
 *    pushState·popstate 恰 1 / `.kcol` 滚动以 `data-version` 为键 / 件B 扩写而周期未动 /
 *    **B8 脚本体可被 JS 解析**（本档补强：SSR 锚只钉「页面长什么样」，钉不出「浏览器肯不肯执行这段」
 *    —— 模板字符串会吃掉正则里的单反斜杠，parse 不过则整枚免手刷在真机上静默死）/
 *    **N-1…N-6（v0.10.4 · REQ-2026-10-11-06 T3）** 焦点收窄、撤让位、结构性兜底、timer 单槽、死钟 CSS、
 *    跨枚 helper 逐字一致；
 *    **L-1 / L-2（v0.10.6 · REQ-2026-10-12-05 (c) 配对同跳）** `holdAnchor` 第三路的脚本面单点钉
 *    （`data-live-lock` + 整篇展开态，含「不收窄 `closest("main")`」与件B 零耦合两条反向钉）与
 *    SSR 面的属性恰 1 处钉（只落 graph 锚开标签 · 详情页其余四枚逐枚点名不带 · 排期页与任务页零命中）；
 *  · **D. 跨面字面钉（v0.10.6 · REQ-2026-10-12-06 n12）** —— **D-③** 一枚：第八枚体内零
 *    `.dg-canvas` / 零 `.dg-frame`（豁免类闭集不因依赖图换容器而扩集）+ 既有两处
 *    `details[open]:not(.pipe)` 字面逐字不变（判据本身零改动）+ 渲染面全部 `<path>` 只带
 *    `class` 与 `d`（禁 `data-*` 第五枚属性）；
 *  · **C. 自证** —— 扫描器不许空转（0 命中 = 扫描失效，不是通过）。
 *
 * **字样级负钉（v0.10.4 · REQ-2026-10-11-06 T3 翻新注-a）**：本档旧文写的是「不给第八枚加不含
 * `feat-dialog` 一类**字样级**负钉 —— 跳拍判据本就要求读 `dialog.open`」；该让位判据已随 T3
 * **整体撤销** ⇒ 现钉**dialog 字样级负钉**（见 N-2：第八枚体内 `dialog` 不分大小写命中数 = 0）。
 * 跨枚分立的判据仍由「不含 `showModal(`」+ 拖拽处理器字面量（不 `preventDefault`）把门。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FEATURE_DETAIL_OVERLAY_SCRIPT, PAGE_LIVE_SCRIPT, renderPage } from "../dist/web/layout.js";
import { renderDependencyGraphSection } from "../dist/graph-view.js";
import { createBoardServer } from "../dist/server.js";
import { LIVE_INTERVALS, renderLiveBar, renderTurnOutcome } from "../dist/web/views.js";
import { engineNoLockFetcher } from "./engine-versions-fixture.mjs";

/**
 * 边线 path 的**整标签形状钉**单源（n2 取数面单源化，与 `graph-view.test.mjs` 的 `EDGE_PATH_RE`
 * 同源）。保留旧内联正则的「逐字整标签 `^<path … d="…" />$`」语义（D-③ path 属性闭集：只带
 * class 与 d 两枚属性）；可选后缀 `(?: dg-edge-cross)?` 为追加件（n9）跨框边换 class 预留 ——
 * 旧码上该后缀不出现 ⇒ 匹配结果与旧内联正则完全一致（等价改写）。
 */
const EDGE_PATH_TAG_EXACT_RE = /^<path class="dg-edge(?: dg-edge-cross)?" d="[^"]*"\/>$/;

/** 本文件声明的锚条数（C2 自证钉：`test()` 实数必须等于它，防「写了不跑 / 写了不报」。） */
const DECLARED_ANCHOR_TESTS = 26;

const NOW = Date.parse("2026-10-11T12:00:00Z");
const FEATURE_VERSION = "v1.2.3";
const DOC_FILE = "live-改造文档.md";

/** 刷新面三页（+ 任务页两档）的宿主路径 —— 恰这四条 URL 带 `data-live`。 */
const LIVE_PAGES = {
  schedule: "/org/alpha/schedule",
  detail: "/features/F1",
  tasksPick: "/org/alpha/tasks",
  tasksDeep: "/tasks?project=board",
};

/** 8 枚锚 key 的闭集（改造文档 §2.2 终版）。 */
const LIVE_KEYS = [
  "sched-board",
  "steps",
  "turn-prog",
  "turn",
  "graph",
  "exec",
  "tasks-filter",
  "tasks-result",
];

/** 负钉页（改造文档 §3「不做什么」：门户/管理/agents/projects/宿主桥/文档页一律不进刷新面）。 */
const NEGATIVE_PAGES = {
  门户: "/",
  管理页: "/org/alpha/manage",
  agents页: "/agents",
  projects页: "/projects",
  宿主桥页: "/host",
  文档页: `/features/F1/docs?file=${encodeURIComponent(DOC_FILE)}&mode=raw`,
};

/** 写面回执页（纯函数档：本卡绝不给写面加刷新锚，故直接钉渲染结果）。 */
const WRITE_RECEIPT_HTML = renderTurnOutcome({
  ok: true,
  org: "alpha",
  featureId: "F1",
  disposition: "succeeded",
  queued: false,
  turnId: "T1",
  contextId: "ctx-1",
  round: 1,
  state: "completed",
  display: "本轮已收口",
  summary: "本轮产出摘要",
  question: null,
  receipt: null,
  error: null,
  bridge: null,
});

function feature(overrides = {}) {
  return {
    featureId: "F1",
    state: "executing",
    title: "板面免手刷",
    requirement: "需求原文",
    plan: null,
    decisions: null,
    contracts: null,
    taskCount: 1,
    ownerGroup: "alpha",
    stage: "改造方案",
    version: FEATURE_VERSION,
    approval: "已通过",
    parentFeatureId: null,
    createdAt: "c",
    updatedAt: "u",
    stateCounts: null,
    ...overrides,
  };
}

function fakeClient() {
  const f = feature();
  const projectsView = {
    source: "fake",
    note: null,
    observedAt: "2026-10-11T00:00:00Z",
    machines: [
      {
        machineId: "m1",
        error: null,
        projects: [{ projectId: "board", agentKind: "qoder", a2aPort: 1, status: "ok", endpoint: null, startedAt: null }],
      },
    ],
    runners: [],
  };
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features: [f], stateCounts: null };
    },
    async getFeature(featureId) {
      return { feature: { ...f, featureId }, tasks: [], acceptance: null };
    },
    async getFeatureTrace(featureId) {
      return { featureId, featureState: f.state, nodes: [] };
    },
    async getProjects() {
      return projectsView;
    },
    async getTasks(projectId) {
      return { projectId, reachable: true, notice: null, tasks: [] };
    },
  };
}

/** 非重叠子串计数（字面量钉不用正则转义，读起来就是它在钉的东西）。 */
function countAll(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * 摘掉全部 `<script…>…</script>` 块 ⇒ SSR 断言只数**标记面**，不把注入脚本里的
 * `'data-live="tasks-filter"'` 之类**选择器字面量**误当锚（那是脚本，不是页面结构）。
 */
function stripScripts(html) {
  return html.replace(/<script[\s\S]*?<\/script>/g, "");
}

/**
 * 页面**正文面**（`<main>…</main>`）—— 「上次更新」这类**展示串**的计数必须在正文面：
 * `<style>` 里的 CSS 注释（layout.ts:1517「上次更新」条）也随每页下发，整页计数会把它误当第二处
 * （同族坑：N1 探针把 `data-live-interval` 的注释命中误当锚）。
 */
function bodyOf(html) {
  const start = html.indexOf("<main");
  const end = html.lastIndexOf("</main>");
  assert.notEqual(start, -1, "页面必须有 <main>（取不到 = 正文面扫描失效）");
  assert.notEqual(end, -1, "页面必须有 </main>（取不到 = 正文面扫描失效）");
  return html.slice(start, end);
}

/**
 * 摘锚法：从 `data-live="<key>"` 的开标签扫到其**配对闭合** `</div>`（八枚锚全是 div 元素，
 * 嵌套计数即配对）。返回 null ⇒ 摘不到（判红，不当「无内容」放过）。
 */
function anchorFragment(html, key) {
  const attr = ` data-live="${key}"`;
  let openAt = -1;
  let from = 0;
  while (true) {
    const i = html.indexOf("<div", from);
    if (i === -1) break;
    const end = html.indexOf(">", i);
    if (end === -1) break;
    if (html.slice(i, end + 1).includes(attr)) {
      openAt = i;
      break;
    }
    from = end + 1;
  }
  if (openAt === -1) return null;
  const tagRe = /<div\b|<\/div\s*>/g;
  tagRe.lastIndex = openAt;
  let depth = 0;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return html.slice(openAt, tagRe.lastIndex);
    } else {
      depth += 1;
    }
  }
  return null;
}

/** 控制条（时钟 + ⟳ 钮）那一段 HTML。 */
function liveBarFragment(html) {
  const m = /<p class="hint live-bar"[\s\S]*?<\/p>/.exec(html);
  return m === null ? null : m[0];
}

async function withPages(run) {
  const disk = mkdtempSync(join(tmpdir(), "board-live-refresh-"));
  mkdirSync(join(disk, "doc", FEATURE_VERSION), { recursive: true });
  writeFileSync(join(disk, "doc", FEATURE_VERSION, DOC_FILE), "# 免手刷\n", "utf8");
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: fakeClient(),
    now: () => NOW,
    engineVersionsFetcher: engineNoLockFetcher(),
    docs: { repoRoot: disk, orgsDir: null },
  });
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const pages = {};
    for (const [key, path] of Object.entries(LIVE_PAGES)) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, `${path} 必须 200 可达（锚不许靠宕页/宕桥蒙混）`);
      const raw = await res.text();
      assert.ok(raw.includes("data-live"), `${path} 原文必须带 data-live —— 取到空页 = 本档扫描失效，不是通过`);
      pages[key] = { path, raw, html: stripScripts(raw), body: bodyOf(stripScripts(raw)) };
    }
    const negatives = {};
    for (const [label, path] of Object.entries(NEGATIVE_PAGES)) {
      const res = await fetch(`${base}${path}`, { headers: { Accept: "text/html" } });
      assert.equal(res.status, 200, `${label}（${path}）必须 200 可达（负钉同样不许靠宕页蒙混）`);
      negatives[label] = await res.text();
    }
    await run(pages, negatives);
  } finally {
    await handle.close();
    rmSync(disk, { recursive: true, force: true });
  }
}

/** 页面周期属性值（每页恰 1 处；取属性值转 int 比较用）。 */
function intervalValues(html) {
  return [...html.matchAll(/ data-live-interval="(\d+)"/g)].map((m) => Number.parseInt(m[1], 10));
}

// ---------------------------------------------------------------------------
// A. SSR 面
// ---------------------------------------------------------------------------

test("A1（§2.2 终版）三页合计恰 8 枚 data-live 锚 key，每枚在其所属页恰 1 处（不重复、不漏、不多）", async () => {
  await withPages((pages) => {
    const perPage = {
      schedule: ["sched-board"],
      detail: ["steps", "turn-prog", "turn", "graph", "exec"],
      tasksPick: ["tasks-filter", "tasks-result"],
      tasksDeep: ["tasks-result"],
    };
    const seen = new Set();
    for (const [page, keys] of Object.entries(perPage)) {
      const found = [...pages[page].html.matchAll(/ data-live="([^"]*)"/g)].map((m) => m[1]).sort();
      assert.deepEqual(
        found,
        [...keys].sort(),
        `${pages[page].path} 本页锚集合必须恰为 ${keys.join(" / ")}（多一枚 = 面出界，少一枚 = 刷新缩水）`,
      );
      for (const key of keys) seen.add(key);
    }
    assert.deepEqual(
      [...seen].sort(),
      [...LIVE_KEYS].sort(),
      "三页（四档）合计必须恰好覆盖 8 枚闭集 —— 少一枚 = 刷新面缩水，多一枚 = 面出界",
    );
  });
});

test("A2（§2.1 周期单点）三档 data-live-interval 字面量 = 排期 30000 / 任务 15000 / 详情 15000，每页恰 1 处", async () => {
  await withPages((pages) => {
    assert.deepEqual(intervalValues(pages.schedule.html), [30000], "排期页恰 1 枚周期属性且 = 30000（挂第一枚锚）");
    assert.deepEqual(intervalValues(pages.detail.html), [15000], "详情整页恰 1 枚周期属性且 = 15000");
    assert.deepEqual(intervalValues(pages.tasksPick.html), [15000], "任务页选单档恰 1 枚（挂 tasks-filter）");
    assert.deepEqual(intervalValues(pages.tasksDeep.html), [15000], "任务页深链档恰 1 枚（挂唯一锚 tasks-result）");
    assert.deepEqual(LIVE_INTERVALS, { schedule: 30000, tasks: 15000, feature: 15000 }, "views.ts 单点常量三档逐字");
    assert.equal(
      countAll(PAGE_LIVE_SCRIPT, "30000") + countAll(PAGE_LIVE_SCRIPT, "15000"),
      0,
      "周期不进脚本字面量（只经 SSR 属性下发 ⇒ 改周期不动脚本）",
    );
  });
});

test("A3（唯一硬约束源）任务页周期取属性值转 int 比较 ⇒ 数值下限 ≥ 15000（两档都钉，防后人调到 5s）", async () => {
  await withPages((pages) => {
    for (const key of ["tasksPick", "tasksDeep"]) {
      const values = intervalValues(pages[key].html);
      assert.equal(values.length, 1, `${pages[key].path} 周期属性必须恰 1 枚（取不到值 = 下限钉空转）`);
      const value = values[0];
      assert.ok(Number.isFinite(value) && value >= 15000, `${pages[key].path} 任务页周期 = ${String(value)}ms，不得 < 15000ms（每次 GET /api/tasks 带 pruneTasks 写）`);
    }
    assert.ok(LIVE_INTERVALS.tasks >= 15000, "LIVE_INTERVALS.tasks 单点常量同样不得 < 15000");
  });
});

test("A4（原型 v1 控制条）data-live-note / data-live-now 三页各恰 1 处；上次更新串每页正文面恰 1 处；钮带 type=button + hidden", async () => {
  await withPages((pages) => {
    for (const key of ["schedule", "detail", "tasksPick", "tasksDeep"]) {
      const body = bodyOf(pages[key].html);
      assert.equal(countAll(body, "data-live-note"), 1, `${pages[key].path} 时钟标记恰 1 处（多枚 = 多处写时钟）`);
      assert.equal(countAll(body, "data-live-now"), 1, `${pages[key].path} ⟳ 钮标记恰 1 处`);
      assert.equal(
        countAll(body, "上次更新"),
        1,
        `${pages[key].path} 正文面「上次更新」串恰 1 处（CSS 注释里那一处不计 ⇒ 本钉作用域 = <main>，整页计数会误报）`,
      );
      const bar = liveBarFragment(body);
      assert.ok(bar !== null, `${pages[key].path} 必须摘到控制条（摘不到 = 本钉空转）`);
      assert.ok(bar.includes('type="button"'), `${pages[key].path} ⟳ 钮 = type="button"（绝不提交表单）`);
      assert.ok(bar.includes(" hidden>"), `${pages[key].path} ⟳ 钮缺省 hidden（无 JS 不出死钮）`);
    }
    assert.equal(countAll(liveBarFragment(renderLiveBar(15000)) ?? "", "data-live-interval"), 0, "控制条不承载周期（周期只挂锚 ⇒ 单点属性不双写）");
  });
});

test("A5（控制条零写面）控制条 HTML 内零 method=\"post\" / 零 type=\"submit\"（刷新面绝不小心变成提交面）", async () => {
  await withPages((pages) => {
    for (const key of Object.keys(pages)) {
      const bar = liveBarFragment(pages[key].html);
      assert.ok(bar !== null, `${pages[key].path} 必须摘到控制条`);
      assert.equal(countAll(bar, "method="), 0, `${pages[key].path} 控制条内零 method=（更不许 post）`);
      assert.equal(countAll(bar, 'type="submit"'), 0, `${pages[key].path} 控制条内零 type="submit"`);
    }
  });
});

test("A6（结构负钉 · 摘锚法）任一 data-live 锚的子树内不得含 live-bar（控制条必须常驻在锚之外）", async () => {
  await withPages((pages) => {
    const owner = {
      "sched-board": "schedule",
      steps: "detail",
      "turn-prog": "detail",
      turn: "detail",
      graph: "detail",
      exec: "detail",
      "tasks-filter": "tasksPick",
      "tasks-result": "tasksPick",
    };
    for (const key of LIVE_KEYS) {
      const page = pages[owner[key]];
      const frag = anchorFragment(page.html, key);
      assert.ok(frag !== null, `${page.path} 摘不到锚「${key}」（摘不到 ⇒ 判红，不得当「子树为空」放过）`);
      assert.equal(countAll(frag, 'class="hint live-bar"'), 0, `锚「${key}」子树内不得有控制条（控制条入锚 = 换块会连时钟一起搬走）`);
      assert.equal(countAll(frag, "data-live-note"), 0, `锚「${key}」子树内不得有 data-live-note`);
    }
  });
});

test("A7（覆盖面恰三页 · 负钉）门户/管理/agents/projects/宿主桥/文档页与写面回执页 ⇒ data-live 命中数 = 0", async () => {
  await withPages((pages, negatives) => {
    void pages;
    for (const [label, html] of Object.entries(negatives)) {
      assert.equal(countAll(html, "data-live"), 0, `${label} 零 data-live（本页不进刷新面）`);
    }
    assert.equal(countAll(WRITE_RECEIPT_HTML, "data-live"), 0, "写面回执页零 data-live（动作/回执面不就地刷）");
  });
});

// ---------------------------------------------------------------------------
// B. 脚本面
// ---------------------------------------------------------------------------

test("B1（只读红线）fetch 目标 = location.pathname + location.search · same-origin · Accept text/html；体内零 method:/setInterval/WebSocket/EventSource/innerHTML/meta-refresh", () => {
  assert.match(
    PAGE_LIVE_SCRIPT,
    /fetch\(location\.pathname \+ location\.search, \{ credentials: "same-origin", headers: \{ Accept: "text\/html" \} \}\)/,
    "定时拍 = GET 当前 URL（同源凭据 + text/html）",
  );
  assert.equal(countAll(PAGE_LIVE_SCRIPT, "fetch("), 2, "fetch 恰两处（定时拍 + 动线拍），不多打第三种请求");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /method\s*:/, "体内零 method:（只 GET，不碰任何写面）");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /setInterval/, "零 setInterval（周期链 = setTimeout 自递归）");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /WebSocket|EventSource/, "零长连面（不做 SSE/WebSocket = 方案边界）");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /innerHTML/, "零 innerHTML（只搬节点，不拼 HTML 字符串）");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /<meta http-equiv/, "零 meta-refresh（免手刷不走 meta 跳转）");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /a2a_events|\/api\/events/, "不打推进宿主收件箱游标的面（轮询安全红线）");
});

test("B2（换块协议 + 容器不可替换红线）只换锚的子节点：firstChild+removeChild 搬运 · 摘不到锚即跳过；负钉 outerHTML / replaceChild( / <main；正钉 sched-board 与 #schedule-board 同元素", async () => {
  await withPages((pages) => {
    assert.match(
      PAGE_LIVE_SCRIPT,
      /while \(target\.firstChild !== null\) \{ target\.removeChild\(target\.firstChild\); \}/,
      "清空 = 逐个搬掉子节点（不整体替换元素）",
    );
    assert.match(
      PAGE_LIVE_SCRIPT,
      /while \(source\.firstChild !== null\) \{ target\.appendChild\(source\.firstChild\); \}/,
      "回填 = 把回包子节点逐个搬进**同一个**锚元素",
    );
    assert.doesNotMatch(PAGE_LIVE_SCRIPT, /replaceChild\(/, "不得用 replaceChild 替换被换元素自身（replaceChildren 亦不得拿来整替锚）");
    assert.doesNotMatch(PAGE_LIVE_SCRIPT, /replaceChildren\(/, "本实现走 firstChild+removeChild 搬运（钉住单一写法，防两法并存）");
    assert.doesNotMatch(PAGE_LIVE_SCRIPT, /outerHTML/, "绝不写 outerHTML（写它 = 容器节点被替换 = 拖拽缓存悬空）");
    assert.doesNotMatch(PAGE_LIVE_SCRIPT, /<main/, "不换 <main>（刷新面只在锚级）");
    assert.ok(
    PAGE_LIVE_SCRIPT.includes('      var src = findAnchor(doc, key);\n      if (src === null) continue;'),
    "摘不到同 key 锚 ⇒ 本拍跳过该锚、绝不清空",
  );
    assert.match(
      pages.schedule.raw,
      /<div class="kanban" id="schedule-board" data-live="sched-board"/,
      "正钉：排期页锚 = 拖拽脚本缓存的那个容器元素本身（同元素并挂两属性 ⇒ 容器永不被替换）",
    );
  });
});

test("B3（跳拍判据四条 · 锚级 + 整拍级）输入面焦点 / details[open]:not(.pipe) / dragstart·dragend 标记 / document.hidden + visibilitychange", () => {
  assert.match(PAGE_LIVE_SCRIPT, /ae !== null && isInputFace\(ae\) && el\.contains\(ae\)/, "判据①（T3 收窄）：焦点须**同时**是输入面且在本锚子树内 ⇒ 该锚该拍跳过（不打断输入）");
  assert.match(PAGE_LIVE_SCRIPT, /el\.querySelector\("details\[open\]:not\(\.pipe\)"\) !== null/, "判据②：锚内含非 pipe 的已展开折叠 ⇒ 该锚该拍跳过（用户正在看；`pipe` = 依赖图管道默认 open，唯一豁免，否则 graph 锚永不刷新）");
  assert.ok(
    PAGE_LIVE_SCRIPT.includes('el.hasAttribute("data-live-lock") && document.querySelector("details[open]:not(.pipe)") !== null'),
    "判据② 的第三路（REQ-2026-10-12-05 (c) 配对同跳）：本锚带 data-live-lock ∧ **整篇**有非 pipe 已展开折叠 ⇒ 该锚该拍跳过（图跟着表一起停）。判据② 那一枚正钉**逐字未翻案** ⇒ 第三路是**追加**、不是替换",
  );
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /querySelector\("details\[open\]"\)/, "负钉：判据②不得回退裸形 details[open]（回退 = graph 锚冻结复发）");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /el\.contains\(document\.activeElement\)/, "反向钉（翻-2）：旧裸形「锚子树含 activeElement」已撤 —— 链接 / 按钮的焦点不得再算在填（整板无声永停的根因）");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /if \(el\.contains\(document\.activeElement\)\) return true;/, "反向钉（翻-2）：旧正钉那一行逐字不得复活（焦点判据必须走 isInputFace）");
  assert.match(PAGE_LIVE_SCRIPT, /document\.addEventListener\("dragstart", function \(\) \{ dragging = true; \}\)/, "判据③：本枚自持被动 dragstart 标记（不 preventDefault ⇒ 不抢拖拽行为）");
  assert.match(PAGE_LIVE_SCRIPT, /document\.addEventListener\("dragend", function \(\) \{ dragging = false; \}\)/, "判据③：dragend 落标记");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /function anyDialogOpen\(\)/, "反向钉（翻-3 · 撤让位）：整拍级不再判「任一 dialog 开着 ⇒ 让位」（件B 浮层档自有节奏）");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /document\.querySelectorAll\("dialog"\)/, "反向钉（翻-4 · 撤让位）：本枚不再读 dialog 集合（与件B 零耦合的执法面）");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /\.open === true/, "反向钉（翻-5 · 撤让位）：不得再判 dialog 的 .open 属性");
  assert.match(PAGE_LIVE_SCRIPT, /if \(document\.hidden \|\| dragging\) \{ scheduleNext\(\); return; \}/, "判据④：后台页 / 拖拽中 ⇒ 整拍让位（两条件；dialog 让位一项已撤）");
  const gateAt = PAGE_LIVE_SCRIPT.indexOf("if (document.hidden || dragging) { scheduleNext(); return; }");
  const swapAt = PAGE_LIVE_SCRIPT.indexOf("try { swapAll(text); }");
  assert.ok(gateAt !== -1 && swapAt !== -1, "整拍闸或换块点摘不到 ⇒ 本钉空转，判红");
  assert.ok(gateAt < swapAt, "结构性兜底：整拍闸必须在换块**之前**（回包后复查），不得退回 fetch 之前");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /if \(document\.hidden \|\| dragging \|\| anyDialogOpen\(\)\)/, "反向钉（翻-6）：fetch 之前不得再留三条件整拍闸");
  assert.match(PAGE_LIVE_SCRIPT, /addEventListener\("visibilitychange", function \(\) \{ if \(!document\.hidden\) runOneTick\(\); \}\)/, "回前台立即补一拍");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /showModal\(/, "本枚不开别人的 dialog（跨枚分立：不开 Modal、不动别枚浮层）");
});

test("B4（任务页动线）history.pushState 恰 1 处 · addEventListener(\"popstate\") 恰 1 条 · pathname 白名单含 /tasks 与 /org · 负钉无 /features/ 拦截分支", () => {
  assert.equal(countAll(PAGE_LIVE_SCRIPT, "history.pushState"), 1, "pushState 全站恰 1 处（只落任务页动线）");
  assert.equal(countAll(PAGE_LIVE_SCRIPT, 'addEventListener("popstate"'), 1, "popstate 全站恰 1 条（后退 = 用当前 URL 重跑同一函数）");
  assert.ok(PAGE_LIVE_SCRIPT.includes('p === "/tasks"'), "动线白名单含 /tasks");
  assert.ok(
    PAGE_LIVE_SCRIPT.includes("/^\\/org\\/[^/]+\\/tasks$/"),
    "动线白名单含 /org/<名>/tasks ⇒ 运行值必须带**转义后的**正则源（模板字符串里 `\\/` 会被吃掉 ⇒ 落到浏览器变成裸 `/` 即整枚 parse 不过，见 B8）",
  );
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /\/features\//, "负钉：无 /features/ 拦截分支（详情类链接一律放行原生导航）");
  assert.ok(PAGE_LIVE_SCRIPT.includes('.b-chips a, .b-card a.fl'), "三条链动线 = 委托选择器（不给链接加任何新属性）");
  assert.ok(PAGE_LIVE_SCRIPT.includes('form.closest(\'[data-live="tasks-filter"]\')'), "过滤表单动线只认本锚内表单（不抢他页表单）");
  assert.ok(
    PAGE_LIVE_SCRIPT.includes('if ((form.getAttribute("method") || "").toLowerCase() !== "get") return;'),
    "过滤表单动线只接 GET 表单（method 走属性读取 ⇒ 不改 `<form>` 标签任何属性）",
  );
});

test("B5（.kcol 滚动回填以 data-version 为键）scrollTop 读写各 ≥1 · 键 = data-version；负钉不得以 indexOf / 列序号为键", () => {
  const reads = countAll(PAGE_LIVE_SCRIPT, "= cols[i].scrollTop;");
  const writes = countAll(PAGE_LIVE_SCRIPT, "cols[i].scrollTop = map[v];");
  assert.ok(reads >= 1 && writes >= 1, `scrollTop 必须读写各 ≥1（读 ${String(reads)} / 写 ${String(writes)}）`);
  assert.ok(countAll(PAGE_LIVE_SCRIPT, 'getAttribute("data-version")') >= 2, "取列键 = data-version（换拍前后同一把键）");
  assert.ok(
    PAGE_LIVE_SCRIPT.includes('      var v = cols[i].getAttribute("data-version");\n      if (v !== null) map[v] = cols[i].scrollTop;'),
    "scrollMap：以 data-version 为键记 scrollTop",
  );
  assert.ok(
    PAGE_LIVE_SCRIPT.includes('      if (v === null || !Object.prototype.hasOwnProperty.call(map, v)) continue;'),
    "data-version 集合变化的列不回填（新列没有旧位置可还）",
  );
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /indexOf/, "负钉：不以 indexOf 为键（列序会变 ⇒ 按序号还位置会串列）");
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /map\[i\]/, "负钉：不以列序号为键");
});

test("B6（件B 只扩判据、周期上界逐字未动）.dg-chip.dg-running 在件B 体恰 2 处 · POLL_INTERVAL_MS=5000 / POLL_MAX_TICKS=240 未动 · stillBusy 仍含在飞与排队中两子串", () => {
  const overlay = FEATURE_DETAIL_OVERLAY_SCRIPT;
  assert.equal(countAll(overlay, ".dg-chip.dg-running"), 2, "起轮与收口认同一串选择器（恰 2 处；只扩一处 = 起轮不收口的死轮）");
  assert.equal(countAll(overlay, ".dg-chip.dg-queued"), 2, "dg-queued 与 dg-running 同串（两来源必须成对）");
  assert.ok(overlay.includes("var POLL_INTERVAL_MS = 5000;"), "件B 周期 HEAD 字面量逐字未动");
  assert.ok(overlay.includes("var POLL_MAX_TICKS = 240;"), "件B 上界 HEAD 字面量逐字未动");
  assert.doesNotMatch(overlay, /POLL_INTERVAL_MS\s*=\s*(?!5000)\d/, "周期不得被顺手改写");
  assert.doesNotMatch(overlay, /POLL_MAX_TICKS\s*=\s*(?!240)\d/, "上界不得被顺手改写");
  const stillBusy = /function stillBusy\(main\) \{[\s\S]*?\n  \}/.exec(overlay);
  assert.ok(stillBusy !== null, "摘不到 stillBusy（本钉空转 ⇒ 判红）");
  assert.ok(stillBusy[0].includes("在飞") && stillBusy[0].includes("排队中"), "件D 后果：件B 按文本子串判收口 ⇒ 二子串不得从 stillBusy 体内移除");
});

test("B7（脚本面计数钉）第八枚 addEventListener 恰 6 条 · setTimeout 自递归链恰 1 处排拍 · 常驻入口守卫只认 [data-live]", () => {
  assert.equal(countAll(PAGE_LIVE_SCRIPT, "addEventListener("), 6, "六条 = dragstart / dragend / visibilitychange / click / submit / popstate（多一条 = 面出界）");
  assert.equal(countAll(PAGE_LIVE_SCRIPT, "timer = setTimeout(tick, intervalMs)"), 1, "排拍单点：setTimeout 自递归（周期值来自属性，不写字面量）");
  assert.match(PAGE_LIVE_SCRIPT, /if \(document\.querySelectorAll\("\[data-live\]"\)\.length === 0 \|\| typeof fetch !== "function" \|\| typeof DOMParser !== "function"\) return;/, "入口守卫只认本枚页专属锚 [data-live]（不收他枚锚 ⇒ 页隔离）");
  assert.equal(countAll(PAGE_LIVE_SCRIPT, "location.reload("), 0, "跨档回落走 location.assign（不 reload 当前页）");
  assert.ok(countAll(PAGE_LIVE_SCRIPT, "location.assign(") >= 2, "回落档 = 交回整页导航（在飞未回 / 跨档两路都要有）");
});

test("B8（离线可执行性钉 · 本档补强）第八枚脚本体必须能被 JS 解析（`new Function` 不抛）；件B 同钉作对照 —— 浏览器侧 parse 不过 = 整枚免手刷静默死", () => {
  const body = PAGE_LIVE_SCRIPT.slice("<script>".length, -"</script>".length);
  assert.ok(body.length > 2000, `第八枚体非空（实际 ${String(body.length)} 字符）`);
  let error = null;
  try {
    new Function(body);
  } catch (e) {
    error = e;
  }
  assert.equal(error, null, `第八枚脚本体 parse 不过 ⇒ 浏览器根本不执行它（SSR 锚全绿也照不出）：${String(error?.message)}`);
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /\/\^\/org\//, "白名单正则的 `/` 必须带转义落到运行值（`/^/org/` 这个裸形 = 反斜杠被模板字符串吃掉）");
  const overlayBody = FEATURE_DETAIL_OVERLAY_SCRIPT.slice("<script>".length, -"</script>".length);
  assert.doesNotThrow(() => new Function(overlayBody), "件B 脚本体同样须 parse 得过（对照：本钉不是只挑第八枚的写法）");
});

// ---------------------------------------------------------------------------
// B'. N-1…N-6（v0.10.4 · REQ-2026-10-11-06 T3 焦点收窄 / 撤让位 / 结构性兜底 / 死钟 / 跨枚一致）
// ---------------------------------------------------------------------------

test("N-1（T3 焦点收窄 · 正反钉）isInputFace 白名单四值齐在 + 负钉不含 closest(form) + holdAnchor 三路逐字", () => {
  const face = /function isInputFace\(node\) \{[^\n]*\}/.exec(PAGE_LIVE_SCRIPT);
  assert.ok(face !== null, "摘不到 isInputFace（本钉空转 ⇒ 判红）");
  for (const piece of [
    "node === null",
    "node === undefined",
    "var tag = node.tagName",
    'tag === "INPUT"',
    'tag === "TEXTAREA"',
    'tag === "SELECT"',
    "node.isContentEditable === true",
  ]) {
    assert.ok(face[0].includes(piece), `白名单缺「${piece}」—— 少一枚 = 该类焦点不再算在填`);
  }
  assert.doesNotMatch(PAGE_LIVE_SCRIPT, /closest\(["']form["']\)/, "反向钉：白名单不得纳入 closest(\"form\") —— 纳入 ⇒ 列头删除钮拿到焦点 = 整板再次无声永停（根因复发）");
  assert.match(
    PAGE_LIVE_SCRIPT,
    /function holdAnchor\(el\) \{ var ae = document\.activeElement; if \(ae !== null && isInputFace\(ae\) && el\.contains\(ae\)\) return true; if \(el\.querySelector\("details\[open\]:not\(\.pipe\)"\) !== null\) return true; return el\.hasAttribute\("data-live-lock"\) && document\.querySelector\("details\[open\]:not\(\.pipe\)"\) !== null; \}/,
    "锚级三路同体（逐字 · REQ-2026-10-12-05 (c) 配对同跳后）：① 输入面焦点在本锚内 ② 锚内含非 pipe 已展开折叠 ③ 带 data-live-lock 的锚继承整页展开态 —— ①② 两路**逐字未动**（本钉即「零翻案」的执法面）",
  );
  assert.equal(countAll(PAGE_LIVE_SCRIPT, "isInputFace(ae)"), 1, "本枚一路调用恰 1 处（不在别处另加判据）");
});

test("N-2（撤整拍让位 · 反向钉）第八枚体内 dialog 字样（不分大小写）归零 · anyDialogOpen 归零 · 不读 dialog 集合", () => {
  assert.equal(countAll(PAGE_LIVE_SCRIPT.toLowerCase(), "dialog"), 0, "体内 dialog 字样命中数必须为 0（让位判据一撤，任何 dialog 读取 / 注记都是复发）");
  assert.equal(countAll(PAGE_LIVE_SCRIPT, "anyDialogOpen"), 0, "anyDialogOpen 不得残留（定义或调用皆零）");
  assert.equal(countAll(PAGE_LIVE_SCRIPT, 'querySelectorAll("dialog")'), 0, "不得再读 dialog 集合");
});

test("N-3（结构性兜底 · 三路出声）console.error 恰 1 · console.warn 恰 3 · busy = false 在 handler 首行 · busy 早退排拍 · 五路出口全排拍", () => {
  assert.equal(countAll(PAGE_LIVE_SCRIPT, "console.error"), 1, "swapAll 抛错一路出声（恰 1，不多打第二种错误面）");
  assert.equal(countAll(PAGE_LIVE_SCRIPT, "console.warn"), 3, "回包不可读 / fetch 异常 / 零换块 三路各一（恰 3）");
  assert.match(PAGE_LIVE_SCRIPT, /try \{ swapAll\(text\); \} catch \(err\) \{ console\.error\(/, "swapAll 用 try 包住并 catch 出声（异常不再静默、不再永停）");
  assert.match(PAGE_LIVE_SCRIPT, /console\.warn\("\[live\] 本拍零换块/, "零换块要出声（全锚 held / 回包摘不到同 key 都不得静默算成功）");
  const tick = /function tick\(\) \{[\s\S]*?\n  \}/.exec(PAGE_LIVE_SCRIPT);
  assert.ok(tick !== null, "摘不到 tick（本钉空转 ⇒ 判红）");
  assert.match(tick[0], /\.then\(function \(text\) \{\n      busy = false;/, "busy = false 必在回包 handler **首行**（否则 swapAll 真抛时 catch 无它 = 一次异常永停）");
  assert.match(tick[0], /if \(busy\) \{ scheduleNext\(\); return; \}/, "busy 早退 = 排拍（fetch 永不 settle 时 ⟳ 不被吞的唯一解；排拍 ≠ 发请求）");
  assert.doesNotMatch(tick[0], /if \(busy\) return;/, "反向钉：不得退回裸 return（那会吞掉整条链）");
  assert.equal(countAll(tick[0], "scheduleNext();"), 5, "tick 五路出口（busy 早退 / 回包不可读 / 整拍闸 / 换块后 / fetch 异常）全部排下一拍 ⇒ 出声不吞拍");
  assert.match(tick[0], /\}\)\.catch\(function \(err\) \{\n      busy = false;\n      console\.warn\("\[live\] fetch 异常，本拍跳过", err\);\n      scheduleNext\(\);/, "fetch 异常档：先释放 busy、再出声、再排拍");
});

test("N-4（timer 单槽 ⇒ 恒一条链）排拍字面量恰 1 处 · scheduleNext 体为 clear-then-set", () => {
  assert.equal(countAll(PAGE_LIVE_SCRIPT, "timer = setTimeout(tick, intervalMs)"), 1, "排拍字面量仍恰 1 处（B7 单点不破）");
  const fn = /function scheduleNext\(\) \{[^\n]*\}/.exec(PAGE_LIVE_SCRIPT);
  assert.ok(fn !== null, "摘不到 scheduleNext（本钉空转 ⇒ 判红）");
  assert.ok(fn[0].includes("clearTimeout(timer)"), "scheduleNext = clear-then-set（busy 分支与回包 handler 抢同一 timer 单槽 ⇒ 必清才恒一条链）");
  assert.match(fn[0], /if \(timer !== null\) clearTimeout\(timer\);/, "清槽判据在前、排在后（逐字形态）");
});

test("N-5（浮层死钟隐藏 · CSS 面）dialog.fd .live-bar 整条隐藏 · 页侧 .live-bar 的 display: flex 仍在", () => {
  const css = renderPage({ title: "t", active: "features", bodyHtml: "" });
  assert.match(css, /dialog\.fd \.live-bar \{[^{}]*display: none;[^{}]*\}/, "浮层内那份控制条 = 死钟 ⇒ CSS 整条隐藏（不为此加任何 JS 判据）");
  assert.match(css, /\.live-bar \{ display: flex;/, "页侧 .live-bar 未动 —— 隐藏靠特异性（0-2-1 > 0-1-0），与书写序无关");
});

test("N-6（跨枚 helper 逐字一致 · 双份同体）两枚各恰 1 处 isInputFace · 两份函数体逐字相等 · 各一路调用形 · 件B 二路未改", () => {
  const re = /function isInputFace\(node\) \{[^\n]*\}/g;
  const eighth = PAGE_LIVE_SCRIPT.match(re) ?? [];
  const overlay = FEATURE_DETAIL_OVERLAY_SCRIPT.match(re) ?? [];
  assert.equal(eighth.length, 1, "第八枚内 isInputFace 恰 1 处");
  assert.equal(overlay.length, 1, "件B 内 isInputFace 恰 1 处");
  assert.equal(eighth[0], overlay[0], "两份函数体必须逐字相等 —— 双份同体是刻意（两枚独立 IIFE 无法函数级共享）；勿合并、勿全局化、勿单改");
  assert.match(PAGE_LIVE_SCRIPT, /if \(ae !== null && isInputFace\(ae\) && el\.contains\(ae\)\) return true;/, "第八枚一路调用形 = 本锚子树（el）");
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /if \(ae !== null && isInputFace\(ae\) && body\.contains\(ae\)\) return true;/, "件B 一路调用形 = 本编辑区（body），未被本卡顺手改动");
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /var f = body\.querySelectorAll\("textarea, input"\);/, "件B 二路（已填失焦也挡）逐字未改 ⇒ 两枚零耦合两钉不破");
});

// ---------------------------------------------------------------------------
// L. L-1 / L-2（v0.10.6 · REQ-2026-10-12-05 (c) 配对同跳 —— 图与表止住发散）
// ---------------------------------------------------------------------------

test("L-1（配对同跳 · 脚本面单点与跨枚零耦合）hasAttribute 恰 1 处 · document 侧 querySelector 恰 1 处 · 负钉不收窄 closest(\"main\") · 件B 零 data-live-lock", () => {
  assert.equal(
    countAll(PAGE_LIVE_SCRIPT, 'el.hasAttribute("data-live-lock")'),
    1,
    "第三路在本枚恰 1 处（不在别处另加 lock 判据 ⇒ 一条判据一个调用点）",
  );
  assert.equal(
    countAll(PAGE_LIVE_SCRIPT, 'document.querySelector("details[open]:not(.pipe)")'),
    1,
    "整篇展开态读取恰 1 处（只落第三路；.pipe 豁免同排它 ⇒ graph 锚不因自家默认展开自冻）",
  );
  assert.doesNotMatch(
    PAGE_LIVE_SCRIPT,
    /closest\(["']main["']\)/,
    "反向钉：不得收窄成 closest(\"main\") —— 备选 c-scope 已被否决（更复杂且对浮层内零增益）；跨浮层泄漏是 §2.3 **如实登记的代价**，不得当缺陷修",
  );
  assert.equal(
    countAll(FEATURE_DETAIL_OVERLAY_SCRIPT, "data-live-lock"),
    0,
    "件B 零耦合：浮层脚本不读 lock 属性（浮层内图与表本就由件B 原子换整份 main ⇒ 天然同快照，本卡不在浮层内立第二道保证）",
  );
});

test("L-2（属性恰 1 处 · SSR 面）详情页 data-live-lock 恰 1 枚且只落 graph 锚开标签；exec / steps / turn / turn-prog 逐枚不带；排期页与任务页零命中", async () => {
  await withPages((pages) => {
    assert.equal(
      countAll(pages.detail.html, "data-live-lock"),
      1,
      "详情页标记面 data-live-lock 恰 1 处（多一枚 = lock 扩散到别的锚，摘掉 = 配对同跳在运行态打不通）",
    );
    const graph = anchorFragment(pages.detail.html, "graph");
    assert.ok(graph !== null, "摘不到 graph 锚（本钉空转 ⇒ 判红）");
    assert.ok(
      graph.slice(0, graph.indexOf(">") + 1).includes(' data-live="graph" data-live-lock>'),
      "那一枚就落在 graph 锚开标签上（属性无值形态、紧随 data-live ⇒ 与 holdAnchor 第三路 hasAttribute 同一读法）",
    );
    for (const key of ["exec", "steps", "turn", "turn-prog"]) {
      const frag = anchorFragment(pages.detail.html, key);
      assert.ok(frag !== null, `${pages.detail.path} 摘不到锚「${key}」（摘不到 ⇒ 判红，不得当「无该锚」放过）`);
      assert.equal(
        countAll(frag.slice(0, frag.indexOf(">") + 1), "data-live-lock"),
        0,
        `锚「${key}」开标签不得带 data-live-lock（§3「不做什么」逐枚点名：只有 graph 加，其余照常刷）`,
      );
    }
    for (const key of ["schedule", "tasksPick", "tasksDeep"]) {
      assert.equal(
        countAll(pages[key].html, "data-live-lock"),
        0,
        `${pages[key].path} 零 data-live-lock（lock 只服务详情页图/表配对，不外溢到排期页与任务页）`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// D. D-③（v0.10.6 · REQ-2026-10-12-06 n12 跨面字面钉 —— 改造文档 §4.4「新增 3 条」第 3 条）
// ---------------------------------------------------------------------------

/** 渲染面取数：三 project 链（两枚跨框边）+ 同框一枚边 ⇒ 框内与跨框 path 各有载体。 */
function graphHtmlForCrossFace() {
  const t = (taskId, projectId, dependencies, createdAt) => ({
    taskId,
    projectId,
    state: "completed",
    lane: "write",
    failureKind: null,
    retryCount: null,
    dependencies,
    prompt: null,
    createdAt,
    startedAt: null,
    finishedAt: null,
    queueState: null,
    queuedAt: null,
    claimedAt: null,
    claimedBy: null,
    taskType: null,
  });
  return renderDependencyGraphSection([
    t("s1", "src", [], "2026-10-12T00:00:01Z"),
    t("s2", "src", ["s1"], "2026-10-12T00:00:02Z"),
    t("o1", "orch", ["s2"], "2026-10-12T00:00:03Z"),
    t("f1", "flow", ["o1"], "2026-10-12T00:00:04Z"),
  ]).html;
}

test("D-③（v0.10.6 跨面字面钉）第八枚体内零 .dg-canvas / 零 .dg-frame · not(.pipe) 两处字面逐字不变 · 全部 path 只带 class 与 d（禁 data-*）", () => {
  // ① 豁免类闭集不随新类名扩集：免手刷那枚脚本体不认识依赖图的新容器类
  assert.equal(PAGE_LIVE_SCRIPT.includes(".dg-canvas"), false, "第八枚体内不得出现 .dg-canvas（跳拍判据不认新类）");
  assert.equal(PAGE_LIVE_SCRIPT.includes(".dg-frame"), false, "第八枚体内不得出现 .dg-frame（该类本卡不引入 ⇒ 更不得进判据）");
  assert.equal(PAGE_LIVE_SCRIPT.includes("dg-canvas"), false, "去点形态一并负钉：判据里不存画布类名");
  assert.equal(PAGE_LIVE_SCRIPT.includes("dg-frame"), false, "同上不认 dg-frame");
  // ② 既有两处 not(.pipe) 字面逐字不变（判据本身零改动 ⇒ 本钉只追加、不翻案 B3 / L-1）
  assert.ok(
    PAGE_LIVE_SCRIPT.includes('el.querySelector("details[open]:not(.pipe)") !== null'),
    "判据② 那一处（锚级）字面逐字不变",
  );
  assert.ok(
    PAGE_LIVE_SCRIPT.includes('el.hasAttribute("data-live-lock") && document.querySelector("details[open]:not(.pipe)") !== null'),
    "第三路（REQ-2026-10-12-05 (c)）那一处字面逐字不变",
  );
  assert.equal(
    countAll(PAGE_LIVE_SCRIPT, "details[open]:not(.pipe)"),
    2,
    "该谓词在本枚恰 2 处 ⇒ 豁免类闭集仍是单元素 .pipe（框默认 open 不自冻）；扩集或回退裸形一律判红",
  );
  // ③ path 属性闭集：折叠留悬空线是已裁代价（§2.5-5.2），唯一救法是给 path 标 data-* ⇒ 必须钉死为不可
  const paths = graphHtmlForCrossFace().match(/<path[^>]*>/g) ?? [];
  assert.ok(paths.length >= 2, `空转守卫：确有 >=2 枚 path（实得 ${String(paths.length)} 枚 ⇒ 取数落空即本钉空转）`);
  for (const p of paths) {
    assert.match(p, EDGE_PATH_TAG_EXACT_RE, `path 只带 class 与 d 两枚属性：${p}`);
  }
  assert.equal(/<path[^>]*\sdata-/.test(graphHtmlForCrossFace()), false, "零 data-* 第五枚属性（G8-svg负钉② 的四元闭集不因本卡破）");
});

// ---------------------------------------------------------------------------
// C. 自证
// ---------------------------------------------------------------------------
test("C1（自证 · 扫描器不许空转）三条取面各自必须真见到字面量：常量非空、锚 key 摘到、负钉页真取到正文", async () => {
  assert.ok(PAGE_LIVE_SCRIPT.length > 2000, `第八枚常量体非空（实际 ${String(PAGE_LIVE_SCRIPT.length)} 字符）`);
  assert.match(PAGE_LIVE_SCRIPT, /^<script>/, "常量 = 裸 <script> 开标签（无 src / 无 type）");
  assert.match(PAGE_LIVE_SCRIPT, /<\/script>$/, "常量以 </script> 收尾");
  const layoutSource = readFileSync(new URL("../src/web/layout.ts", import.meta.url), "utf8");
  assert.ok(countAll(layoutSource, "[data-live]") >= 1, "源码里必须真见到 [data-live] 选择器（0 = 扫描失效，本钉不得空转）");
  assert.ok(countAll(layoutSource, "PAGE_LIVE_SCRIPT") >= 2, "源码里必须真见到第八枚（常量声明 + 注记/引用）");
  await withPages((pages, negatives) => {
    for (const key of Object.keys(pages)) {
      assert.ok(pages[key].raw.includes("<main"), `${pages[key].path} 取到的是整页（含 <main>），不是片段`);
      assert.ok(pages[key].html.includes("<main"), `${pages[key].path} 摘脚本后正文仍在（strip 没把页面吃掉）`);
    }
    for (const [label, html] of Object.entries(negatives)) {
      assert.ok(html.length > 200, `${label} 真取到正文（长度 ${String(html.length)}；0 则 A7 负钉是空转）`);
    }
    assert.notEqual(anchorFragment(pages.detail.html, "steps"), null, "摘锚函数在真页面上取得到锚（取不到 = A6 整组空转）");
  });
});

test("C2（本档自钉）test() 条数 = 声明的锚数 ⇒ 写了就必须报", () => {
  const self = readFileSync(new URL(import.meta.url), "utf8");
  const declared = self.split("\n").filter((line) => line.startsWith("test(")).length;
  assert.ok(declared > 0, "扫描器必须真的见到 test() 声明（0 = 本钉空转）");
  assert.equal(declared, DECLARED_ANCHOR_TESTS, `本档实有 ${String(declared)} 条 test()，与声明的 ${String(DECLARED_ANCHOR_TESTS)} 不符 ⇒ 改锚须同步改条数`);
});
