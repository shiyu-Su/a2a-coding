/**
 * _probe-detail-overflow.mjs —— 只读探针（本卡 Step 0 核实②，不落任何产物文件改动）。
 *
 * 目的：把「执行明细展开后表格过大，被阶段产出等卡片遮挡」这句反馈**定量**成可复核的宽度算术 ——
 *   ① 从 3300 只读面取真实 feature detail + trace；
 *   ② 走产品自身的渲染路径（dist/web/views.js `renderFeatureDetail`）拿到两张表的**实际单元格文本**；
 *   ③ 逐列算 min-content 宽度（两种断行口径），求和；
 *   ④ 与各承载面（独立详情页 / 排期页 dialog 浮层）的**左栏轨道宽度**比对，判是否溢出。
 * 结论口径：min-content 之和 > 轨道宽度 ⇒ 表格撑破 `.feat-main`（Grid 首轨 `minmax(0,1fr)` 可无限收缩），
 *   向右溢出的部分压在 `.feat-side`（position: sticky ⇒ 定位元素，绘制序在文档流之上）之下 = 遮挡。
 *
 * 无浏览器 ⇒ 字符宽度按 CSS 口径估算（见 CHAR_W），这是估算而非实测，回执中如实标注。
 */
import { renderFeatureDetail } from "../dist/web/views.js";
import { parseFeatureDetail, parseTrace } from "../dist/bridge-client.js";

const BRIDGE = "http://127.0.0.1:3300";
const FID = process.argv[2] ?? "3b7ea660-a5e8-4c85-ba7a-35d01c043080";

async function get(path) {
  const r = await fetch(BRIDGE + path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

const detailRaw = await get(`/api/features/${encodeURIComponent(FID)}`);
const traceRaw = await get(`/api/features/${encodeURIComponent(FID)}/trace`).catch((e) => {
  console.warn("trace 读取失败（不影响任务表面测量）：" + String(e && e.message));
  return null;
});
const detail = parseFeatureDetail(detailRaw);
const trace = traceRaw === null ? null : parseTrace(traceRaw);

// ---- 渲染路径复用：extras 传图不影响两张表，releasedVersions 关闭排期表单 ----------------------
const html = renderFeatureDetail(detail, trace, null, Date.now(), false, []);

/** 取 `<h2>标题` 之后第一张表的 thead th 与 tbody td 文本（去标签）。 */
function grabTable(afterHeading) {
  const at = html.indexOf(afterHeading);
  if (at < 0) return null;
  const start = html.indexOf("<table>", at);
  const end = html.indexOf("</table>", start);
  if (start < 0 || end < 0) return null;
  const seg = html.slice(start, end);
  const strip = (s) =>
    s
      .replace(/<[^>]*>/g, "")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim();
  const head = [...seg.matchAll(/<th>([\s\S]*?)<\/th>/g)].map((m) => strip(m[1]));
  const rows = [...seg.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => strip(c[1])))
    .filter((r) => r.length > 0);
  return { head, rows };
}

// ---- 宽度模型（估算）：表 font-family ui-monospace/Consolas ⇒ 等宽 0.6em；CJK 回退 ~1em ----------
const FS = 12; // table 字号 px（layout.ts:1091）
const MONO_W = FS * 0.6; // ≈ 7.2px
const CJK_W = FS * 1.0; // 中日韩全宽 ≈ 12px（CJK 可在任意两字间断行）
const PADDING = 12 + 1; // td 左右 padding 4px 6px + border-collapse 边 ≈ 13px

const isCJK = (ch) => /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef\u2e80-\u2eff]/.test(ch);

function tokenWidth(tok) {
  let w = 0;
  for (const ch of tok) w += isCJK(ch) ? CJK_W : MONO_W;
  return w;
}
/** 口径 A（保守上界）：只在空白处断行。 */
const minA = (s) => s.split(/\s+/).reduce((m, t) => Math.max(m, tokenWidth(t)), 0);
/** 口径 B（乐观下界）：额外允许在连字符之后、CJK 字之间断行。 */
function minB(s) {
  let best = 0;
  let cur = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (/\s/.test(ch) || /-/.test(ch) || isCJK(ch)) {
      best = Math.max(best, cur);
      cur = 0;
    } else cur += MONO_W;
  }
  return Math.max(best, cur);
}

function measure(name, t) {
  if (t === null) {
    console.log(`\n== ${name}：该面本次无数据（未渲染）==`);
    return null;
  }
  const ncol = t.head.length;
  const cols = [];
  for (let c = 0; c < ncol; c += 1) {
    let a = 0;
    let b = 0;
    for (const cell of [...t.rows, t.head]) {
      const v = cell[c] ?? "";
      if (v === "") continue;
      a = Math.max(a, minA(v));
      b = Math.max(b, minB(v));
    }
    cols.push({ head: t.head[c], a: a + PADDING, b: b + PADDING });
  }
  const sumA = cols.reduce((s, x) => s + x.a, 0);
  const sumB = cols.reduce((s, x) => s + x.b, 0);
  console.log(`\n== ${name}：${ncol} 列 × ${t.rows.length} 行 ==`);
  console.log(cols.map((x) => `${x.head}: A=${x.a.toFixed(0)} B=${x.b.toFixed(0)}`).join("  |  "));
  console.log(`min-content 合计：口径A(仅空白断行)=${sumA.toFixed(0)}px  口径B(含连字符/CJK 断行)=${sumB.toFixed(0)}px`);
  return { sumA, sumB, ncol };
}

const taskT = measure("① 任务表（执行明细折叠内）", grabTable("<h2>任务（"));
let traceT = measure("② 进展三面表（执行明细折叠内）", grabTable("<h2>进展三面"));

// 三面表在 `integrating` 之后节点全终态 ⇒ C2 短路② 不渲 ⇒ 线上取不到实测。
// 补一发**合成最坏值**（同样走产品渲染路径，字段形态取自 derive.ts:129-148 与 test/derive.test.mjs）：
if (traceT === null) {
  const UUID = "98c39da1-1111-2222-3333-444455556666";
  const ISO = "2026-10-11T02:26:14.079Z";
  const synth = {
    nodes: [
      {
        taskId: UUID,
        projectId: "test_opencode",
        state: "blocked",
        lane: "read",
        waitReason: "ready_pending_dispatch",
        position: 3,
        waitedSince: ISO,
        projectBusy: { busy: true, taskId: UUID, machineId: "win-dev" },
        readOccupants: [
          { taskId: UUID, featureId: null, queueState: "running", machineId: "win-dev", queuedAt: ISO },
          { taskId: UUID, featureId: null, queueState: "running", machineId: "win-dev", queuedAt: ISO },
        ],
        blockedOn: [UUID, UUID],
      },
    ],
  };
  const synthHtml = renderFeatureDetail(detail, synth, null, Date.now(), false, []);
  const at = synthHtml.indexOf("<h2>进展三面");
  const start = synthHtml.indexOf("<table>", at);
  const end = synthHtml.indexOf("</table>", start);
  const strip = (s) => s.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
  const seg = synthHtml.slice(start, end);
  const head = [...seg.matchAll(/<th>([\s\S]*?)<\/th>/g)].map((m) => strip(m[1]));
  const rows = [...seg.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
  traceT = measure("② 进展三面表（合成最坏值 · 同渲染路径）", { head, rows: [rows] });
}

// ---- 承载面轨道宽度 -------------------------------------------------------------
const SIDEBAR = 216; // body grid 首轨（layout.ts:1065）
const MAIN_PAD = 24 * 2; // .main-col 左右 padding（:1082）
const FEAT_SIDE = 320; // --b-feat-side（:1059）
const GAP = 16; // .feat-cols gap（:1285）
const FOLD_PAD = 10 * 2 + 2; // details.fold padding + border（:1110）

function tracks(vp) {
  const pageMain = vp - SIDEBAR - MAIN_PAD;
  const pageLeft = pageMain - FEAT_SIDE - GAP;
  const dlgW = Math.min(880, vp * 0.92);
  const dlgBody = dlgW - (18 + 18); // dialog.fd padding（:1225）
  const dlgLeft = dlgBody - FEAT_SIDE - GAP;
  const collapsed = vp <= 900; // @media (max-width:900px)（:1288）
  return {
    pageLeft: collapsed ? pageMain - FOLD_PAD : pageLeft - FOLD_PAD,
    pageLeftRaw: pageLeft,
    dlgLeft: dlgLeft - FOLD_PAD,
    dlgLeftRaw: dlgLeft,
    collapsed,
    vp,
  };
}

console.log("\n== 轨道宽度 vs 表格 min-content ==");
console.log("viewport | 独立页左栏 | 浮层左栏 | 任务表A/B | 三面表A/B | 独立页溢出 | 浮层溢出");
for (const vp of [900, 1024, 1280, 1440, 1600, 1920]) {
  const t = tracks(vp);
  const worst = Math.max(taskT ? taskT.sumB : 0, traceT ? traceT.sumB : 0);
  const worstA = Math.max(taskT ? taskT.sumA : 0, traceT ? traceT.sumA : 0);
  console.log(
    `${vp} | ${t.pageLeft.toFixed(0)} | ${t.dlgLeft.toFixed(0)} | ${taskT ? taskT.sumA.toFixed(0) + "/" + taskT.sumB.toFixed(0) : "-"} | ${traceT ? traceT.sumA.toFixed(0) + "/" + traceT.sumB.toFixed(0) : "-"} | A:${worstA > t.pageLeft ? "溢出" : "不溢"} B:${worst > t.pageLeft ? "溢出" : "不溢"} | A:${worstA > t.dlgLeft ? "溢出" : "不溢"} B:${worst > t.dlgLeft ? "溢出" : "不溢"}`,
  );
}
console.log("\n注：@media (max-width:900px) 判的是**视口**宽度，dialog.fd 宽 min(880px,92vw) 是**容器**宽度");
console.log("   ⇒ 视口 >900 而浮层只有 880 时，两栏形态在浮层内**永不回落**为单列。");
