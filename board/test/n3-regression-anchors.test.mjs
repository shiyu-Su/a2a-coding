/**
 * REQ-v0.9.2-2026-09-26-02 增补 ④ · N3 回归补钉（纯测试锚，不动生产代码）——
 *
 * ① 路由面（N1）：`GET /` = 排期看板结构 + 「排期」高亮；`GET /requirements` = 提需求表单 +
 *    列表 + 过滤；`GET /schedule` 与 `GET /` 同构渲染（别名兼容）；桥不可达 502 页面语义随迁
 *    （`/` 与 `/schedule` 高亮「排期」、`/requirements` 高亮「需求」）。
 * ② 浮层三锚（N2）：排期页含 `<dialog` 骨架；开关脚本 = 单点内联字面量常量（`^<script>`、
 *    无 `src=`、不含用户数据）；卡片保留 `<a href="/features/:id">` 无 JS 回退。
 * ③ 纪律钉（本需求最重要的长效锚，BD14 mermaid 白名单先例模式复制）：
 *    「全站 `src/**` 可执行内联脚本字面量清单 ⊆ {提交守卫, err-ov 关闭, mermaid 渲染, 浮层开关}」
 *    —— 防 JS 野长；mermaid 的 `<script type="application/json">` 数据通道不是可执行脚本，不在闭集。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FEATURE_DETAIL_OVERLAY_SCRIPT,
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
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features, stateCounts: null };
    },
    ...overrides,
  };
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

test("N3-① GET / = 排期看板结构 + 「排期」高亮（浮层 dialog 骨架与 `<a>` 无 JS 回退随首页在）", async () => {
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
    assert.doesNotMatch(res.text, /<a href="\/requirements" class="on">/, "「需求」不高亮");
    assert.ok(
      res.text.indexOf("<h3>v0.9.2") < res.text.indexOf("<h3>v0.10.0"),
      "版本列 = semver 数值序（看板结构，不是列表表格）",
    );
    assert.match(res.text, /<h3>需求池 <span class="muted">\(1\)<\/span><\/h3>/, "未排期 F3 进需求池列");
    assert.doesNotMatch(res.text, /<h2>需求列表<\/h2>|<form method="post" action="\/requirements"/, "提需求表单不随首页迁走");
    assert.match(res.text, /<dialog class="fd" id="feat-dialog">/, "浮层骨架在首页");
    assert.ok(
      res.text.includes(FEATURE_DETAIL_OVERLAY_SCRIPT),
      "浮层脚本随 schedule kind 页注入（首页不例外 · 增补轨锚）",
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
    }
  });
});

// ---------------------------------------------------------------------------
// ① 路由面：GET /requirements = 需求页（表单 + 列表 + 过滤）
// ---------------------------------------------------------------------------

test("N3-③ GET /requirements = 提需求表单 + 需求列表 + 过滤表单，「需求」高亮", async () => {
  const client = fakeClient([feature("F1", "v0.9.2")]);
  await withServer(client, async (base) => {
    const res = await getHtml(base, "/requirements");
    assert.equal(res.status, 200);
    assert.match(res.text, /<a href="\/requirements" class="on">需求<\/a>/);
    assert.match(res.text, /<h2>提需求<\/h2>/);
    assert.match(res.text, /<form method="post" action="\/requirements"/, "表单同源 POST 到 /requirements");
    assert.match(res.text, /<h2>需求列表<\/h2>/);
    assert.match(res.text, /class="filter-form"/, "过滤表单随列表页在");
    assert.match(res.text, /href="\/features\/F1"/, "列表行链详情页");
  });
});

test("N3-④ 过滤语义在 /requirements 生效（回归门）；`/` 不消费过滤参数（当前行为登记）", async () => {
  const client = fakeClient([
    feature("F1", "v0.9.2", { state: "executing" }),
    feature("F2", "v0.9.2", { state: "waiting_approval", approval: "待审批" }),
  ]);
  await withServer(client, async (base) => {
    const filtered = await getHtml(base, "/requirements?state=executing");
    assert.equal(filtered.status, 200);
    assert.match(filtered.text, /过滤后 1 \/ 共 2 条/, "板内存过滤收敛渲染");
    assert.match(filtered.text, /清除过滤/);
    assert.doesNotMatch(filtered.text, /需求 F2/, "非匹配行不出现在表格里");
    // 回归门（增补 ④ N1 迁移遗留已修）：过滤表单 action 与「清除过滤」必须指向需求页 ——
    // `/` 已是排期看板且不消费过滤参数，指回 `/` 即静默失效（本锚钉死不再回退）。
    assert.match(filtered.text, /<form method="get" action="\/requirements" class="filter-form">/);
    assert.match(filtered.text, /<a class="fl" href="\/requirements">清除过滤<\/a>/);
    // 当前行为如实登记（非断言目标）：`/` 收到过滤 query 不报 404，只是静默忽略。
    const rootWithQuery = await getHtml(base, "/?state=executing");
    assert.equal(rootWithQuery.status, 200);
    assert.match(rootWithQuery.text, /<title>排期看板 · board<\/title>/, "/ 恒渲染看板，过滤参数无效果");
  });
});

// ---------------------------------------------------------------------------
// ① 路由面：桥不可达 502 语义随迁
// ---------------------------------------------------------------------------

test("N3-⑤ 桥不可达 502：`/` 与 `/schedule` 高亮「排期」、`/requirements` 高亮「需求」（宕页高亮随发起页）", async () => {
  await withServer(BROKEN_CLIENT, async (base) => {
    for (const [path, nav, href] of [
      ["/", "排期", "/schedule"],
      ["/schedule", "排期", "/schedule"],
      ["/requirements", "需求", "/requirements"],
    ]) {
      const res = await getHtml(base, path);
      assert.equal(res.status, 502, `${path} 桥不可达 = 502`);
      assert.match(res.text, /bridge_unreachable/, `${path} 错误码在页面`);
      assert.match(
        res.text,
        new RegExp(`<a href="${href}" class="on">${nav}</a>`),
        `${path} 宕页高亮留在「${nav}」`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// ② 浮层三锚（dialog 骨架 / 单点常量 / 无 JS 回退）—— HTTP 面钉在 N3-①，此处补常量规格
// ---------------------------------------------------------------------------

test("N3-⑥ 浮层开关脚本 = 单点内联字面量常量（规格钉：^<script>、无 src=、可执行体不含用户数据插值）", async () => {
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /^<script>/);
  assert.match(FEATURE_DETAIL_OVERLAY_SCRIPT, /<\/script>$/);
  assert.doesNotMatch(FEATURE_DETAIL_OVERLAY_SCRIPT, /<script[^>]*src=/);
  const body = FEATURE_DETAIL_OVERLAY_SCRIPT.slice(8, -9);
  assert.doesNotMatch(body, /\$\{/, "常量体内不得有模板插值（单点常量 = 零用户数据注入面）");
  // 「单点」的事实源在下面的 N3-⑧ 全站扫描：字面量在 src/** 恰好出现 1 次。
});

// ---------------------------------------------------------------------------
// ③ 纪律钉：全站内联脚本字面量闭集
// ---------------------------------------------------------------------------

/**
 * 可执行内联脚本闭集：字面量必须命中且只命中下列一枚体标记（多余命中 = 归类歧义，同样红）。
 * 标记取**转义无关**片段（源码模板字面量里的引号带 `\`，运行时常量不带，两种形态都含这些子串）。
 */
const INLINE_SCRIPT_ALLOWLIST = [
  { key: "提交守卫", marker: "button[type=submit]" },
  { key: "err-ov 关闭", marker: 'getElementById(\\"err-ov\\")', runtime: 'getElementById("err-ov")' },
  { key: "mermaid 渲染", marker: "window.mermaid.render(" },
  { key: "浮层开关", marker: 'getElementById(\\"feat-dialog\\")', runtime: 'getElementById("feat-dialog")' },
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

test("N3-⑦（纪律钉）全站可执行内联脚本字面量 ⊆ 四元闭集，且每枚恰好 1 处（防 JS 野长 / 防复制）", () => {
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

test("N3-⑧（纪律钉·单点钉）两枚导出常量：声明唯一、renderPage 注入点只引常量，正文不在他处复制", () => {
  const layout = readFileSync(join(srcRoot, "web", "layout.ts"), "utf8");
  const server = readFileSync(join(srcRoot, "server.ts"), "utf8");
  const count = (s, re) => (s.match(re) ?? []).length;
  for (const name of ["SUBMIT_GUARD_SCRIPT", "FEATURE_DETAIL_OVERLAY_SCRIPT"]) {
    assert.equal(
      count(layout, new RegExp(`export const ${name} = \`<script>`, "g")),
      1,
      `${name} 只允许一处声明`,
    );
  }
  // 提交守卫全站随 renderPage 注入 ⇒ 唯一插值点；浮层脚本按页注入（pageSchedule 的 extraScripts），
  // layout.ts 内不得出现其正文的第二次裸 `<script>` 字面量（N3-⑦ 的全站计数已封死复制面）。
  assert.equal(count(layout, /\$\{SUBMIT_GUARD_SCRIPT\}/g), 1, "renderPage 只经常量插值注入提交守卫");
  assert.equal(count(server, /extraScripts: FEATURE_DETAIL_OVERLAY_SCRIPT/g), 1, "server.ts 只经 pageSchedule 一处按常量注入浮层脚本");
});
