/**
 * REQ-v0.9.2-2026-09-26-02 增补 ④ · N3 回归补钉（纯测试锚，不动生产代码）——
 * REQ-v0.9.3-2026-09-26-04（排期页新增需求弹窗）同步：需求列表页退役，`GET /requirements` ⇒ 303 回首页。
 *
 * ① 路由面（N1）：`GET /` = 排期看板结构 + 「排期」高亮 + 新增需求弹窗（页头按钮 + dialog 表单）；
 *    `GET /requirements` = 303 重定向（Q2，退役不 404、不触桥）；`GET /schedule` 与 `GET /` 同构渲染
 *    （别名兼容）；桥不可达 502 页面语义随迁（`/` 与 `/schedule` 高亮「排期」）。
 * ② 浮层三锚（N2）：排期页含 `<dialog` 骨架（详情浮层 + 新增需求弹窗）；开关脚本 = 单点内联字面量
 *    常量（`^<script>`、无 `src=`、不含用户数据）；卡片保留 `<a href="/features/:id">` 无 JS 回退。
 * ③ 纪律钉（本需求最重要的长效锚，BD14 mermaid 白名单先例模式复制）：
 *    「全站 `src/**` 可执行内联脚本字面量清单 ⊆ {提交守卫, err-ov 关闭, mermaid 渲染, 浮层开关, 新增需求弹窗, 排期拖拽}」
 *    —— 防 JS 野长；mermaid 的 `<script type="application/json">` 数据通道不是可执行脚本，不在闭集。
 *    v0.9.3 B-T5 起闭集 = **六元**（新增「排期拖拽」`DRAG_SCHEDULE_SCRIPT`，与弹窗常量分立、不可共置）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DRAG_SCHEDULE_SCRIPT,
  FEATURE_DETAIL_OVERLAY_SCRIPT,
  NEW_REQUIREMENT_DIALOG_SCRIPT,
  SUBMIT_GUARD_SCRIPT,
} from "../dist/web/layout.js";
import { createBoardServer } from "../dist/server.js";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function feature(featureId, version, overrides = {}) {
  return {
    featureId,
    state: "executing",
    title: `需求 ${featureId}`,
    requirement: null,
    taskCount: 1,
    ownerGroup: "alpha",
    stage: "改造方案",
    version,
    approval: "已通过",
    createdAt: "c",
    updatedAt: "u",
    stateCounts: null,
    ...overrides,
  };
}

function fakeClient(features, overrides = {}) {
  const client = {
    baseUrl: "http://fake",
    calls: [],
    async getFeatures() {
      client.calls.push("getFeatures");
      return { features, stateCounts: null };
    },
    ...overrides,
  };
  return client;
}

const BROKEN_CLIENT = {
  baseUrl: "http://fake",
  async getFeatures() {
    throw new Error("桥没起（假）");
  },
};

async function withServer(client, run) {
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, client });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

async function getHtml(base, path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, text: await res.text() };
}

// ---------------------------------------------------------------------------
// ① 路由面：GET / = 排期看板首页
// ---------------------------------------------------------------------------

test("N3-① GET / = 排期看板结构 + 「排期」高亮（浮层 dialog 骨架与 `<a>` 无 JS 回退随首页在；REQ-04 起弹窗也在首页）", async () => {
  const client = fakeClient([
    feature("F1", "v0.9.2"),
    feature("F2", "v0.10.0"),
    feature("F3", null),
  ]);
  await withServer(client, async (base) => {
    const res = await getHtml(base, "/");
    assert.equal(res.status, 200);
    assert.match(res.text, /<title>排期看板 · board<\/title>/, "首页标题 = 排期看板");
    assert.match(res.text, /<a href="\/schedule" class="on">排期<\/a>/, "「排期」导航高亮");
    assert.doesNotMatch(res.text, /<a href="\/requirements"[^>]*>需求<\/a>/, "「需求」导航入口已删（REQ-04 Q2）");
    assert.ok(
      res.text.indexOf("<h3>v0.9.2") < res.text.indexOf("<h3>v0.10.0"),
      "版本列 = semver 数值序（看板结构，不是列表表格）",
    );
    assert.match(res.text, /<h3>需求池 <span class="muted">\(1\)<\/span><\/h3>/, "未排期 F3 进需求池列");
    assert.doesNotMatch(res.text, /<h2>需求列表<\/h2>/, "列表页已退役：不再随任何页渲染");
    assert.match(res.text, /<dialog class="fd" id="feat-dialog">/, "浮层骨架在首页");
    assert.match(res.text, /<button type="button" id="new-req-open"[^>]*>＋ 新增需求<\/button>/, "页头「＋ 新增需求」按钮（REQ-04 Q1）");
    assert.match(res.text, /<dialog class="fd" id="new-req-dialog">/, "新增需求弹窗骨架在首页");
    assert.match(res.text, /<h2>提需求<\/h2>/, "提需求表单进弹窗（自列表页迁入）");
    assert.match(res.text, /<form method="post" action="\/requirements"/, "弹窗表单仍同源 POST /requirements");
    assert.ok(
      res.text.includes(FEATURE_DETAIL_OVERLAY_SCRIPT),
      "浮层脚本随 schedule kind 页注入（首页不例外 · 增补轨锚）",
    );
    assert.ok(
      res.text.includes(NEW_REQUIREMENT_DIALOG_SCRIPT),
      "新增需求弹窗脚本随首页注入（单点常量经 extraScripts 通路）",
    );
    assert.match(res.text, /<a class="fl" href="\/features\/F1">/, "卡片真链接（无 JS 回退）");
  });
});

test("N3-② GET /schedule 与 GET / 同构渲染（别名兼容，深链零红面）", async () => {
  const client = fakeClient([feature("F1", "v0.9.2"), feature("F3", null)]);
  await withServer(client, async (base) => {
    const root = await getHtml(base, "/");
    const alias = await getHtml(base, "/schedule");
    assert.equal(alias.status, 200, "深链 /schedule 不红");
    assert.equal(alias.text, root.text, "两个 URL 渲染逐字节同构（同 kind 同页）");
    // 同构必须是「正向」同构：逐字节相等也可以是「两页都没有浮层脚本」⇒ 单独钉脚本段与骨架段都在
    for (const [label, html] of [["/", root.text], ["/schedule", alias.text]]) {
      assert.ok(html.includes(FEATURE_DETAIL_OVERLAY_SCRIPT), `${label} 含浮层脚本`);
      assert.match(html, /<dialog class="fd" id="feat-dialog">/, `${label} 含 dialog 骨架`);
      assert.ok(html.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), `${label} 含新增需求弹窗脚本`);
      assert.match(html, /<dialog class="fd" id="new-req-dialog">/, `${label} 含新增需求 dialog 骨架`);
    }
  });
});

// ---------------------------------------------------------------------------
// ① 路由面：GET /requirements 退役（303 回首页）+ POST /requirements 保留（REQ-04 Q2）
// ---------------------------------------------------------------------------

test("N3-③（REQ-04 Q2）GET /requirements ⇒ 303 回 /（不 404、不触桥、不渲染列表页）", async () => {
  const client = fakeClient([feature("F1", "v0.9.2")]);
  await withServer(client, async (base) => {
    const res = await fetch(`${base}/requirements`, { redirect: "manual" });
    assert.equal(res.status, 303, "旧深链 303（板惯例，留反悔余地；R1 裁决替代 301）");
    assert.equal(res.headers.get("location"), "/", "303 目标 = 首页（排期看板 + 弹窗）");
    assert.equal(res.headers.get("cache-control"), "no-store");
    await res.body?.cancel();
    assert.deepEqual(client.calls, [], "重定向不触桥");
    const followed = await fetch(`${base}/requirements`);
    assert.equal(followed.status, 200);
    const text = await followed.text();
    assert.match(text, /<title>排期看板 · board<\/title>/, "跟随后落在首页");
    assert.doesNotMatch(text, /<h2>需求列表<\/h2>|class="filter-form"/, "列表页与过滤表单已彻底退役");
  });
});

test("N3-④（REQ-04 Q2）POST /requirements 保留断言：端点仍放开 · 已发版锁 409 原样执法（错误卡进响应页供弹窗叠加）", async () => {
  const client = fakeClient([]);
  const seen = [];
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    defaultGroup: "g",
    releasedVersions: ["v0.9.0"],
    createRequirementImpl: async (input) => {
      seen.push(input);
      return {
        ok: true,
        featureId: "F-NEW",
        state: "waiting_approval",
        stage: "需求分析",
        version: input.version,
        approval: "未发起",
      };
    },
  });
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const hit = await fetch(`${base}/requirements`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "撞锁", version: "v0.9.0" }).toString(),
    });
    assert.equal(hit.status, 409, "弹窗提交仍走 POST /requirements：已发版锁原样生效");
    const text = await hit.text();
    assert.match(text, /board_version_released/, "错误码在响应页");
    assert.match(text, /class="err-ov-card"/, "错误卡可被弹窗脚本摘取叠加（65cd03e1 先例口径）");
    assert.deepEqual(seen, [], "锁版提交零出网：写封装未被调用");
    const miss = await fetch(`${base}/requirements`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "未排期" }).toString(),
    });
    assert.equal(miss.status, 303, "非锁版提交仍走既有 PRG 303 跳详情页");
    assert.equal(miss.headers.get("location"), "/features/F-NEW");
    await miss.body?.cancel();
    assert.equal(seen.length, 1, "未撞锁的提交才触达写封装（端点未被退役误伤）");
  } finally {
    await handle.close();
  }
});

test("N3-④b（REQ-04 Q3）退役三函数零引用：src/** 不残留 parseFeaturesFilter / applyFeaturesFilter / renderFeaturesList", () => {
  const offenders = [];
  for (const file of listTsFiles(srcRoot)) {
    const source = readFileSync(file, "utf8");
    for (const name of ["parseFeaturesFilter", "applyFeaturesFilter", "renderFeaturesList"]) {
      // 允许出现在「退役登记」注释行（以 // 开头），不得有声明 / 导入 / 调用等代码位引用
      const codeHits = source
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/**") && l.includes(name));
      for (const l of codeHits) offenders.push(`${relative(srcRoot, file).split(sep).join("/")}: ${l}`);
    }
  }
  assert.deepEqual(offenders, [], "退役函数在 src/** 代码位必须零引用（无迁移、无兼容层）");
});

// ---------------------------------------------------------------------------
// ① 路由面：桥不可达 502 语义随迁
// ---------------------------------------------------------------------------

test("N3-⑤ 桥不可达 502：`/` 与 `/schedule` 高亮「排期」（宕页高亮随发起页；「需求」导航已随 REQ-04 Q2 退役）", async () => {
  await withServer(BROKEN_CLIENT, async (base) => {
    for (const [path, nav, href] of [
      ["/", "排期", "/schedule"],
      ["/schedule", "排期", "/schedule"],
    ]) {
      const res = await getHtml(base, path);
      assert.equal(res.status, 502, `${path} 桥不可达 = 502`);
      assert.match(res.text, /bridge_unreachable/, `${path} 错误码在页面`);
      assert.match(
        res.text,
        new RegExp(`<a href="${href}" class="on">${nav}</a>`),
        `${path} 宕页高亮留在「${nav}」`,
      );
      assert.doesNotMatch(res.text, /<a href="\/requirements"/, `${path} 宕页不再给「需求」导航留入口`);
    }
  });
});

// ---------------------------------------------------------------------------
// ② 浮层三锚（dialog 骨架 / 单点常量 / 无 JS 回退）—— HTTP 面钉在 N3-①，此处补常量规格
// ---------------------------------------------------------------------------

test("N3-⑥ 浮层/弹窗/拖拽脚本 = 单点内联字面量常量（规格钉：^<script>、无 src=、可执行体不含用户数据插值）", async () => {
  for (const script of [FEATURE_DETAIL_OVERLAY_SCRIPT, NEW_REQUIREMENT_DIALOG_SCRIPT, DRAG_SCHEDULE_SCRIPT]) {
    assert.match(script, /^<script>/);
    assert.match(script, /<\/script>$/);
    assert.doesNotMatch(script, /<script[^>]*src=/);
    const body = script.slice(8, -9);
    assert.doesNotMatch(body, /\$\{/, "常量体内不得有模板插值（单点常量 = 零用户数据注入面）");
    assert.doesNotMatch(body, /<\/script/, "脚本体内不得出现 </script 字面量（裸标签分割前提）");
  }
  // 「单点」的事实源在下面的 N3-⑧ 全站扫描：字面量在 src/** 恰好出现 1 次。
});

test("N3-⑥b（REQ-04 Q1）新增需求弹窗脚本行为锚：开关委托 · fetch 同源 POST · 成功关弹窗刷新 · 4xx 错误卡叠加 · 表单恢复 · urlencoded · 无 JS 降级", () => {
  const s = NEW_REQUIREMENT_DIALOG_SCRIPT;
  // 开关：页头按钮 showModal / 关闭钮 + backdrop + cancel 关弹窗
  assert.match(s, /getElementById\("new-req-open"\)/, "页头按钮委托");
  assert.match(s, /dlg\.showModal\(\)/);
  assert.match(s, /getElementById\("new-req-close"\)|closest\("#new-req-close"\)/, "关闭钮委托");
  assert.match(s, /addEventListener\("cancel"/, "Esc 关闭清 returnValue");
  // 提交：只拦本弹窗表单，fetch POST form.action（= /requirements）+ 同源凭据 + Accept
  assert.match(s, /form\.addEventListener\("submit"/, "表单 submit 拦截（非 document 委托 ⇒ 不碰 #feat-dialog 分支）");
  assert.match(s, /e\.preventDefault\(\)/);
  assert.match(s, /fetch\(form\.action, \{/);
  assert.match(s, /method: "POST"/);
  assert.match(s, /credentials: "same-origin"/);
  assert.match(s, /headers: \{ Accept: "text\/html" \},/, "错误页整页档须含 text/html ⇒ .err-ov-card 可摘");
  // 编码钉：服务端写面用 new URLSearchParams(raw) 解析 ⇒ 必须 urlencoded
  assert.match(s, /new URLSearchParams\(new FormData\(form\)\)/, "表单体 = urlencoded（非 multipart）");
  assert.doesNotMatch(s, /body: new FormData\(form\)/, "不得把 FormData 直接当 body");
  // 成功（303 被 fetch 自动跟随 ⇒ 最终页 ok）⇒ 关弹窗 + 刷新（新卡落需求池立即可见）
  assert.match(s, /function closeAndReload\(\) \{ dlg\.close\(\); dlg\.returnValue = ""; window\.location\.reload\(\); \}/, "成功 = 关弹窗刷新");
  assert.match(s, /if \(!r\.ok\) \{/, "响应两档分流");
  // 4xx/5xx ⇒ 错误卡叠加为 dialog 直接子元素（65cd03e1 先例），弹窗不关、「知道了」委托摘卡
  assert.match(s, /querySelector\("\.err-ov-card"\)/, "错误卡单独可摘");
  assert.match(s, /function showCard\(card\) \{\n    dropCard\(\);\n    dlg\.appendChild\(card\);/, "错误卡 = dialog 直接子元素（覆盖层，不进内容流）");
  assert.match(s, /closest\("#new-req-dialog #err-ov-close"\)/, "弹窗内「知道了」有委托处理");
  // 提交后表单状态恢复（提交守卫禁用态无人复位 ⇒ 本脚本主动恢复，错误路径可改后重提）
  assert.match(s, /function restoreForm\(\) \{/, "恢复收口 restoreForm");
  assert.match(s, /querySelectorAll\("button\[disabled\]"\)/);
  assert.match(s, /querySelector\("\.submit-pending"\)/);
  assert.match(s, /showCard\(card\);\n          restoreForm\(\);/, "错误卡路径 = 叠卡后恢复表单（可重提交）");
  // 降级面：无卡 / fetch 异常 ⇒ 关弹窗刷新（错误整页可见，不静默）；FormData 不可构造 ⇒ 原生提交
  assert.match(s, /if \(card === null\) \{ closeAndReload\(\); return; \}/);
  assert.match(s, /\}\)\.catch\(function \(\) \{ closeAndReload\(\); \}\);/, "fetch 网络异常 ⇒ 不静默");
  assert.match(s, /if \(data === null\) \{ submitNative\(\); return; \}/, "极端环境降级原生提交（无 JS 回退面同旧表单）");
  assert.match(s, /form\.submit\(\)/);
});

// v0.9.3 B-T5：排期拖拽脚本行为锚（提交复用既有写路由 · 成功刷新 · 失败错误卡叠加 · 同版不发 · 闸锁卡不响应）
test("N3-⑥c（B-T5）DRAG_SCHEDULE_SCRIPT 行为锚：POST 复用 /features/:id/schedule · urlencoded version · 成功 reload · 4xx 抽 .err-ov-card 叠加 · 同版零请求 · 只认 draggable=true 卡", () => {
  const s = DRAG_SCHEDULE_SCRIPT;
  assert.match(s, /getElementById\("schedule-board"\)/, "无看板容器（非排期页）⇒ 整段空转");
  assert.match(
    s,
    /fetch\("\/features\/" \+ encodeURIComponent\(featureId\) \+ "\/schedule"/,
    "提交 = 复用既有写路由（不新增写路由、不落第二种 kind）",
  );
  assert.match(s, /method: "POST"/);
  assert.match(s, /new URLSearchParams\(\{ version: version \}\)/, "载荷 urlencoded（服务端按 x-www-form-urlencoded 解析）");
  assert.match(s, /if \(res\.ok\) \{ window\.location\.reload\(\); return null; \}/, "成功 = 整页刷新（列归组以引擎回写后列表为事实源）");
  assert.match(s, /doc\.querySelector\("\.err-ov-card"\)/, "失败 = 抽错误卡");
  assert.match(s, /document\.body\.appendChild\(card\)/, "错误卡叠加到 body（409 闸/锁可见）");
  assert.match(s, /closest\("\.kcard\[draggable=true\]"\)/, "只响应服务端放行（draggable）的卡 ⇒ 闸锁卡拖不动");
  assert.match(s, /if \(\(card\.getAttribute\("data-version"\) \|\| ""\) === \(target \|\| ""\)\) return;/, "目标列 = 现版本 ⇒ 零请求（同版重提无意义）");
  assert.match(s, /e\.preventDefault\(\);\s*\n\s*e\.dataTransfer\.dropEffect = "move";/, "dragover 需 preventDefault 才能落地");
  // 载荷只带 version —— 不得夹带 stage/approval（登记字段不进写面）
  assert.doesNotMatch(s, /stage|approval/, "拖拽载荷仍仅 version（stage/approval 只作服务端读判）");
});

// ---------------------------------------------------------------------------
// ③ 纪律钉：全站内联脚本字面量闭集
// ---------------------------------------------------------------------------
/**
 * 可执行内联脚本闭集：字面量必须命中且只命中下列一枚体标记（多余命中 = 归类歧义，同样红）。
 * 标记取**转义无关**片段（源码模板字面量里的引号带 `\`，运行时常量不带，两种形态都含这些子串）。
 * v0.9.3 B-T5 起闭集 = **六元**（新增「排期拖拽」，与「新增需求弹窗」分立两枚、不可共置）。
 */
const INLINE_SCRIPT_ALLOWLIST = [
  { key: "提交守卫", marker: "button[type=submit]" },
  { key: "err-ov 关闭", marker: 'getElementById(\\"err-ov\\")', runtime: 'getElementById("err-ov")' },
  { key: "mermaid 渲染", marker: "window.mermaid.render(" },
  { key: "浮层开关", marker: 'getElementById(\\"feat-dialog\\")', runtime: 'getElementById("feat-dialog")' },
  { key: "新增需求弹窗", marker: 'getElementById(\\"new-req-dialog\\")', runtime: 'getElementById("new-req-dialog")' },
  { key: "排期拖拽", marker: 'getElementById(\\"schedule-board\\")', runtime: 'getElementById("schedule-board")' },
];

function listTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * 扫 src/**\/*.ts 的源码文本，抽出所有**可执行内联脚本块**（`<script>` 裸开标签 → 最近 `</script>`）；
 * `<script src=...>`（外源）与 `<script type="application/json">`（mermaid 数据通道）不是可执行内联，不入清单。
 */
function collectInlineScriptBlocks() {
  const blocks = [];
  for (const file of listTsFiles(srcRoot)) {
    const source = readFileSync(file, "utf8");
    for (const seg of source.split("</script>")) {
      const open = seg.lastIndexOf("<script");
      if (open === -1) continue;
      const tag = seg.slice(open);
      if (!/^<script>/.test(tag)) continue; // 带属性（src= / type=）⇒ 非可执行内联
      const nl = seg.indexOf("\n", open);
      blocks.push({ rel: relative(srcRoot, file).split(sep).join("/"), body: seg.slice(nl + 1) });
    }
  }
  return blocks;
}

test("N3-⑦（纪律钉）全站可执行内联脚本字面量 ⊆ 六元闭集，且每枚恰好 1 处（防 JS 野长 / 防复制）", () => {
  const blocks = collectInlineScriptBlocks();
  assert.ok(blocks.length > 0, "扫描器必须真的见到字面量（0 = 扫描失效，本锚不许空转）");
  const tally = new Map(INLINE_SCRIPT_ALLOWLIST.map((e) => [e.key, 0]));
  for (const b of blocks) {
    const hits = INLINE_SCRIPT_ALLOWLIST.filter(
      (e) => b.body.includes(e.marker) || (e.runtime !== undefined && b.body.includes(e.runtime)),
    );
    assert.equal(
      hits.length,
      1,
      `${b.rel} 的内联脚本块${hits.length === 0 ? "不在闭集内（新 JS 野长）" : "命中多枚标记（归类歧义）"}：\n${b.body.slice(0, 200)}`,
    );
    tally.set(hits[0].key, tally.get(hits[0].key) + 1);
  }
  assert.equal(
    blocks.length,
    INLINE_SCRIPT_ALLOWLIST.length,
    `清单必须与闭集一一对应（实际 ${blocks.length} 处）`,
  );
  for (const [key, n] of tally) {
    assert.equal(n, 1, `「${key}」源码字面量应恰好 1 处（单点常量），实际 ${n} 处`);
  }
});

test("N3-⑧（纪律钉·单点钉）四枚导出常量：声明唯一、renderPage 注入点只引常量，正文不在他处复制", () => {
  const layout = readFileSync(join(srcRoot, "web", "layout.ts"), "utf8");
  const server = readFileSync(join(srcRoot, "server.ts"), "utf8");
  const count = (s, re) => (s.match(re) ?? []).length;
  for (const name of [
    "SUBMIT_GUARD_SCRIPT",
    "FEATURE_DETAIL_OVERLAY_SCRIPT",
    "NEW_REQUIREMENT_DIALOG_SCRIPT",
    "DRAG_SCHEDULE_SCRIPT",
  ]) {
    assert.equal(
      count(layout, new RegExp(`export const ${name} = \`<script>`, "g")),
      1,
      `${name} 只允许一处声明`,
    );
  }
  // 提交守卫全站随 renderPage 注入 ⇒ 唯一插值点；页面脚本按页注入（pageSchedule 的 extraScripts），
  // layout.ts 内不得出现其正文的第二次裸 `<script>` 字面量（N3-⑦ 的全站计数已封死复制面）。
  assert.equal(count(layout, /\$\{SUBMIT_GUARD_SCRIPT\}/g), 1, "renderPage 只经常量插值注入提交守卫");
  assert.equal(
    count(
      server,
      /FEATURE_DETAIL_OVERLAY_SCRIPT \+\s*\n\s*NEW_REQUIREMENT_DIALOG_SCRIPT \+\s*\n\s*DRAG_SCHEDULE_SCRIPT/g,
    ),
    1,
    "server.ts 只经 pageSchedule 一处按常量注入三枚脚本（同页、同通路；拖拽常量与弹窗常量分立不可共置）",
  );
  // v0.9.3 增补 ②：排期页同挂 vendored mermaid（浮层换入的依赖图经 a2aRenderMermaid 钩子补渲）⇒ 常量注入各恰好 1 处
  assert.equal(
    count(server, /mermaidAssetScriptTag\(\) \+ mermaidRenderScript\(\)/g),
    2,
    "mermaid 资产+渲染脚本常量注入 = pageSchedule（浮层补渲）与 pageFeatureDetail（整页档）两处",
  );
});
