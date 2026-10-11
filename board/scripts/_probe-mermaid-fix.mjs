/**
 * 临时探针 #3（REQ v0.10.3 · 卡 fbce0b37 Step 0 核实项 3/4）：只读，不改任何产物。
 * 目的 = 在真实数据 + 对抗样本上验证方案 A 的清洗/截断实现，并检查是否翻既有测试锚白名单。
 * 用法：node scripts/_probe-mermaid-fix.mjs [featureId]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

import { buildTaskGraph, taskGraphMermaidSource } from "../dist/graph-view.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MERMAID_BUNDLE = join(HERE, "..", "src", "web", "static", "mermaid.min.js");
const FEATURE_ID = process.argv[2] || "3b7ea660-a5e8-4c85-ba7a-35d01c043080";
const BRIDGE = "http://127.0.0.1:3300";

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
    /* noop */
  }
}
installMinimalDom();
vm.runInThisContext(readFileSync(MERMAID_BUNDLE, "utf8"), { filename: "mermaid.min.js" });
const mermaid = globalThis.mermaid;
mermaid.initialize({ startOnLoad: false });

const escapeHtml = (v) =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const normalizeWs = (s) => s.replace(/[\r\n\t\v\f\u2028\u2029]+/g, " ").replace(/ +/g, " ").trim();

/** 候选实现：tip 体 = normalizeWs → 截断 → escapeHtml → 反斜杠双写 → 剔控制字符（截断在转义之前） */
function tipBodyV1(raw, cap = 120) {
  const ws = normalizeWs(raw);
  const cut = ws.length > cap ? ws.slice(0, cap) + "…" : ws;
  return escapeHtml(cut).replace(/\\/g, "\\\\").replace(/[\u0000-\u001f\u007f]/g, " ");
}
/** 反例：先转义（反斜杠已变两字符）再截断 ⇒ 可能在两个反斜杠之间切断，留下悬挂单反斜杠 */
function tipBodyBad(raw, cap = 120) {
  const esc = escapeHtml(normalizeWs(raw)).replace(/\\/g, "\\\\");
  return esc.length > cap ? esc.slice(0, cap) + "…" : esc;
}
/** 纯 JSON.stringify 路线（不 HTML 转义） */
function tipBodyJsonOnly(raw, cap = 120) {
  const ws = normalizeWs(raw);
  const cut = ws.length > cap ? ws.slice(0, cap) + "…" : ws;
  return JSON.stringify(cut);
}

async function parse(name, src) {
  try {
    const r = await mermaid.parse(src);
    return { name, ok: true, info: r?.diagramType ?? "" };
  } catch (e) {
    return { name, ok: false, info: String((e && e.message) || e).split("\n")[0].slice(0, 100) };
  }
}
function show(r) {
  console.log(`  [${r.ok ? "OK  " : "FAIL"}] ${r.name}${r.ok ? "" : `   ⇒ ${r.info}`}`);
}

/** 既有测试锚白名单（test/graph-view.test.mjs:181/183） */
const SAFE_ID = "n_[A-Za-z0-9_-]+";
const NODE_LINE_RE = new RegExp(`^  ${SAFE_ID}\\["([^"]*)"\\](?:@\\{"tip":"[^"]*"\\})?$`);
const tipSpanRe = /@\{"tip":"[^"]*"\}/g;

/** 用替换后的 tip 体重写整份源（只动 tip 字面量）。 */
function reTip(src, bodyFor) {
  return src.replace(/@\{"tip":"([^"]*)"\}/g, (m, body) => {
    const decoded = body
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    const idPart = decoded.split(" · ")[0] ?? "";
    const rest = decoded.slice(idPart.length + 3);
    const rebuilt = `${idPart} · ${bodyFor(rest)}`;
    return `@{"tip":"${rebuilt}"}`;
  });
}

console.log("=== A. 真实数据：候选实现整份源 ===");
let tasks = [];
try {
  tasks = (await fetch(`${BRIDGE}/api/features/${FEATURE_ID}`, { method: "GET" })).ok
    ? (await (await fetch(`${BRIDGE}/api/features/${FEATURE_ID}`, { method: "GET" })).json()).tasks ?? []
    : [];
} catch {
  /* 下面回退 */
}
if (tasks.length === 0) {
  try {
    tasks = JSON.parse(readFileSync(join(HERE, "_probe-fd.json"), "utf8")).tasks ?? [];
    console.log("  （用本地快照 _probe-fd.json）");
  } catch {
    /* noop */
  }
}
const realSrc = taskGraphMermaidSource(buildTaskGraph(tasks));
const realTipRaw = (realSrc.match(/@\{"tip":"([^"]*)"\}/g) ?? []).map((s) => s.slice(9, -2));
console.log(`  任务数=${tasks.length}  tip 数=${realTipRaw.length}  最长 tip 长度=${Math.max(...realTipRaw.map((s) => s.length))}`);
show(await parse("现状（基线）", realSrc));
show(await parse("V1 normalizeWs→截断120→escapeHtml→双写反斜杠→剔控制", reTip(realSrc, (r) => tipBodyV1(r))));
show(await parse("V2 只双写反斜杠（不截断、不剔控制）", realSrc.replace(/@\{"tip":"([^"]*)"\}/g, (m, b) => `@{"tip":"${b.replace(/\\/g, "\\\\")}"}`)));
show(await parse("BAD 先双写反斜杠再截断120", realSrc.replace(/@\{"tip":"([^"]*)"\}/g, (m, b) => {
  const esc = b.replace(/\\/g, "\\\\");
  return `@{"tip":"${esc.length > 120 ? esc.slice(0, 120) + "…" : esc}"}`;
})));

console.log("\n=== B. 截断/转义顺序危害的定向复现（反斜杠正好落在切断边界）===");
for (const cap of [118, 119, 120, 121]) {
  const raw = "依".repeat(cap - 1) + "\\`尾";
  const good = `flowchart LR\n  n_zz["flow<br/>x<br/>已完成"]@{"tip":"${tipBodyV1(raw, cap)}"}`;
  const bad = `flowchart LR\n  n_zz["flow<br/>x<br/>已完成"]@{"tip":"${tipBodyBad(raw, cap)}"}`;
  show(await parse(`cap=${cap} 截断在转义之前`, good));
  show(await parse(`cap=${cap} 截断在转义之后`, bad));
}

console.log("\n=== C. 对抗样本（单节点，tip 走 V1）===");
const ADV = [
  ["悬挂反斜杠结尾", "head\nx\\"],
  ["null 字节", "head\nx\u0000y"],
  ["控制字符 \\u0001", "head\nx\u0001y"],
  ["裸双引号", 'head\nsay "hi"'],
  ["script 标签", "head\n<script>alert(1)</script>"],
  ["花括号与 @{", "head\n@{\"tip\":\"x}"],
  ["合法 JSON 转义 \\n \\\\ \\u0041", "head\na\\nb\\\\c\\u0041"],
  ["markdown 转义反引号（真实形态）", "head\n见 \\`需求流程.md\\` 块"],
  ["超长 + 反斜杠", "head\n" + "x".repeat(3000) + "\\y"],
];
for (const [label, prompt] of ADV) {
  const s = taskGraphMermaidSource(buildTaskGraph([{ taskId: "adv1", projectId: "p", state: "completed", lane: "write", failureKind: null, retryCount: null, dependencies: null, prompt }]));
  show(await parse(label + "（现状生成）", s));
  show(await parse(label + "（V1 重建 tip）", reTip(s, (r) => tipBodyV1(r))));
}

console.log("\n=== D. 既有测试锚白名单是否被 V1 翻掉 ===");
const candidates = {
  现状: realSrc,
  V1: reTip(realSrc, (r) => tipBodyV1(r)),
  "只双写反斜杠": realSrc.replace(/@\{"tip":"([^"]*)"\}/g, (m, b) => `@{"tip":"${b.replace(/\\/g, "\\\\")}"}`),
  "JSON.stringify 路线（不 HTML 转义）": reTip(realSrc, (r) => tipBodyJsonOnly(normalizeWs(String(r)).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"))),
};
for (const [name, src] of Object.entries(candidates)) {
  const lines = src.split("\n").slice(1);
  const badLines = lines.filter((l) => !NODE_LINE_RE.test(l) && !new RegExp(`^(?:  ${SAFE_ID}\\["[^"]*"\\](?:@\\{"tip":"[^"]*"\\})?|  style ${SAFE_ID} fill:#[0-9a-f]{6},stroke:#8886|  ${SAFE_ID} --> ${SAFE_ID})$`).test(l));
  const residualQuote = src.replace(/\["[^"]*"\]/g, "").replace(tipSpanRe, "").includes('"');
  console.log(`  ${name}: 白名单不过行数=${badLines.length}  引号残差=${residualQuote}`);
  if (badLines.length > 0) console.log("      首例: " + JSON.stringify(badLines[0].slice(0, 160)));
}

console.log("\n=== E. 「截断是否等价于修复」的反证（反斜杠落在 120 以内）===");
const EARLY = "head\n见 \\`需求流程.md\\` 与 x\\y 两段反斜杠都在前 120 字符内";
const eSrc = taskGraphMermaidSource(buildTaskGraph([{ taskId: "e1", projectId: "p", state: "completed", lane: "write", failureKind: null, retryCount: null, dependencies: null, prompt: EARLY }]));
console.log("  tip 体长度 = " + (eSrc.match(/@\{"tip":"([^"]*)"\}/)[1].length));
show(await parse("E1 只截断 120（不清洗反斜杠）", eSrc.replace(/@\{"tip":"([^"]*)"\}/g, (m, b) => {
  const t = b.length > 120 ? b.slice(0, 120) + "…" : b;
  return `@{"tip":"${t}"}`;
})));
show(await parse("E2 只清洗反斜杠（不截断）", eSrc.replace(/@\{"tip":"([^"]*)"\}/g, (m, b) => `@{"tip":"${b.replace(/\\/g, "\\\\")}"}`)));
show(await parse("E3 两者都不做（基线）", eSrc));

const EARLY_LONG = "head\\`y " + "依".repeat(400);
const lSrc = taskGraphMermaidSource(buildTaskGraph([{ taskId: "e2", projectId: "p", state: "completed", lane: "write", failureKind: null, retryCount: null, dependencies: null, prompt: EARLY_LONG }]));
console.log("  tip 体长度（E4/E5）= " + (lSrc.match(/@\{"tip":"([^"]*)"\}/)[1].length) + "（反斜杠在第 5 字符）");
show(await parse("E4 只截断 120 · 长 tip 且反斜杠在头部", lSrc.replace(/@\{"tip":"([^"]*)"\}/g, (m, b) => `@{"tip":"${b.length > 120 ? b.slice(0, 120) + "…" : b}"}`)));
show(await parse("E5 截断120 + 双写反斜杠（V1 顺序）", reTip(lSrc, (r) => tipBodyV1(r))));
