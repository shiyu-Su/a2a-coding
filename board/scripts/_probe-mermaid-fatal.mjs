/**
 * 临时探针 #2（REQ v0.10.3 · 卡 fbce0b37 Step 0 核实项 3）：只读，不改任何产物。
 * 目标 = 精确定位 mermaid 11.17.2 解析杀手 + 验证方案 A 各候选清洗手段是否奏效。
 * 用法：node scripts/_probe-mermaid-fatal.mjs [featureId]
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
    /* navigator 只读 */
  }
}
installMinimalDom();
vm.runInThisContext(readFileSync(MERMAID_BUNDLE, "utf8"), { filename: "mermaid.min.js" });
const mermaid = globalThis.mermaid;
mermaid.initialize({ startOnLoad: false });

const mkTask = (taskId, prompt, extra = {}) => ({
  taskId,
  projectId: "flow",
  state: "completed",
  lane: "write",
  failureKind: null,
  retryCount: null,
  dependencies: null,
  prompt,
  ...extra,
});
const srcOf = (taskId, prompt) => taskGraphMermaidSource(buildTaskGraph([mkTask(taskId, prompt)]));

async function probe(name, src) {
  try {
    const r = await mermaid.parse(src);
    return { name, ok: true, info: r?.diagramType ?? "" };
  } catch (e) {
    return { name, ok: false, info: String((e && e.message) || e).split("\n").slice(0, 2).join(" | ").slice(0, 120) };
  }
}
function show(res) {
  console.log(`  [${res.ok ? "OK  " : "FAIL"}] ${res.name}${res.ok ? "" : `   ⇒ ${res.info}`}`);
}

// ---------------------------------------------------------------------------
console.log("=== A. 字符类矩阵（探针只在 tip 面：放 prompt 第二行，首行走标签）===");
const TIP_PROBES = [
  ["反斜杠+反引号  \\` ", "l1\nx\\`y\\`z"],
  ["反斜杠+字母  \\x ", "l1\nx\\y"],
  ["反斜杠+CJK  \\依 ", "l1\nx\\依"],
  ["反斜杠+n  \\n（合法 JSON 转义）", "l1\nx\\ny"],
  ["反斜杠+反斜杠  \\\\（合法）", "l1\nx\\\\y"],
  ["反斜杠+u 短十六进制  \\u12", "l1\nx\\u12y"],
  ["反斜杠结尾（悬挂）", "l1\nx\\"],
  ["控制字符 \\u0000", "l1\nx\u0000y"],
  ["控制字符 \\u0001", "l1\nx\u0001y"],
  ["控制字符 \\u001f", "l1\nx\u001fy"],
  ["DEL \\u007f", "l1\nx\u007fy"],
  ["配对代理 \\ud800（裸高代理）", "l1\nx\ud800y"],
  ["emoji 😀", "l1\nx😀y"],
  ["花括号 {…}", "l1\nx{y}z"],
  ["反引号 `", "l1\nx`y`z"],
  ["双引号 \"", "l1\nx\"y\"z"],
  ["竖线 |", "l1\nx|y"],
  ["箭头 -->", "l1\nx --> y"],
  ["分号 ;", "l1\nx;y"],
  ["@{ 序列", "l1\nx@{y"],
  ["方括号 [x]", "l1\nx[y]z"],
  ["超长 tip 4000 字符", "l1\n" + "依".repeat(4000)],
];
for (const [label, prompt] of TIP_PROBES) {
  show(await probe("tip: " + label, srcOf("c1a00001", prompt)));
}

console.log("\n=== A2. 同一批探针只放首行（⇒ 进 label 面；tip 同步有，故再看 A3 差分）===");
for (const [label, p] of TIP_PROBES) {
  const prompt = p.replace("l1\n", "");
  show(await probe("label+tip: " + label, srcOf("c1a00002", prompt)));
}

console.log("\n=== A3. 纯 label 面（把 tip 从源里剥掉，只看标签位是否会被同字符劈裂）===");
for (const [label, p] of TIP_PROBES) {
  const prompt = p.replace("l1\n", "");
  const s = (srcOf("c1a00003", prompt) ?? "").replace(/@\{"tip":"[^"]*"\}/, "");
  show(await probe("label only: " + label, s));
}

// ---------------------------------------------------------------------------
console.log("\n=== B. 真实数据逐节点定位 ===");
let tasks = [];
try {
  const res = await fetch(`${BRIDGE}/api/features/${FEATURE_ID}`, { method: "GET" });
  tasks = (await res.json()).tasks ?? [];
} catch (e) {
  console.log("  桥不可达：", String(e).slice(0, 60));
}
console.log(`  任务数=${tasks.length}`);
const full = taskGraphMermaidSource(buildTaskGraph(tasks));
show(await probe("整份源（现状）", full));

console.log("\n  —— 逐节点单飞 ——");
for (const t of tasks) {
  const s = srcOf(t.taskId, t.prompt);
  show(await probe("节点 " + t.taskId.slice(0, 8), s));
}

console.log("\n  —— 真实 prompt 里的反斜杠与控制字符盘点 ——");
for (const t of tasks) {
  const p = String(t.prompt ?? "");
  const bs = [...p.matchAll(/\\(.)/gs)].map((m) => JSON.stringify(m[0]) + "→下字符U+" + (m[1].codePointAt(0) ?? 0).toString(16));
  const ctrl = [...p].filter((c) => c.codePointAt(0) < 0x20 && !"\r\n\t".includes(c)).map((c) => "U+" + c.codePointAt(0).toString(16));
  const otherWs = [...p].filter((c) => c.codePointAt(0) >= 0x2028 && c.codePointAt(0) <= 0x202f).map((c) => "U+" + c.codePointAt(0).toString(16));
  console.log(
    `  ${t.taskId.slice(0, 8)}: 反斜杠数=${(p.match(/\\/g) ?? []).length} [${bs.slice(0, 6).join(", ")}]` +
      ` 控制字符=${ctrl.length ? ctrl.join(",") : "无"} 其他空白=${otherWs.length ? otherWs.join(",") : "无"}`,
  );
}

console.log("\n  —— 报错位置回查（整份源 line 2 col 417 附近）——");
const lines = (full ?? "").split("\n");
const L = lines[1] ?? "";
console.log("  line2[400..440] = " + JSON.stringify(L.slice(400, 440)));

// ---------------------------------------------------------------------------
console.log("\n=== C. 方案 A 候选清洗手段 · 在真实整份源上验证 ===");
const escHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function withTip(src, transform) {
  return src.replace(/@\{"tip":"([^"]*)"\}/g, (_m, body) => `@{"tip":"${transform(body)}"}`);
}

const CAND = [
  ["F0 不动（基线）", (s) => s],
  ["F1 tip 反斜杠转义为 \\\\", (s) => s.replace(/\\/g, "\\\\")],
  ["F2 tip 反斜杠→全角 ＼", (s) => s.replace(/\\/g, "＼")],
  ["F3 tip 截断 120 字符（不清洗）", (s) => (s.length > 120 ? s.slice(0, 120) + "…" : s)],
  ["F4 截断120 + 反斜杠→＼", (s) => {
    const t = s.replace(/\\/g, "＼");
    return t.length > 120 ? t.slice(0, 120) + "…" : t;
  }],
  ["F5 全清洗：压空白 + 剔控制字符 + 反斜杠→＼ + 截断120", (s) => {
    let t = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\\/g, "＼");
    return t.length > 120 ? t.slice(0, 120) + "…" : t;
  }],
  ["F6 只剔非空白控制字符（不碰反斜杠）", (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")],
  ["F7 先截断到 120 再全清洗（含 JSON 双转义）", (s) => {
    const t = s.replace(/[\u0000-\u001f\u007f]+/g, " ");
    const cut = t.length > 120 ? t.slice(0, 120) + "…" : t;
    return cut.replace(/\\/g, "\\\\");
  }],
];
for (const [name, fn] of CAND) {
  show(await probe(name, withTip(full, fn)));
}

console.log("\n=== D. label 面候选（首行含反斜杠时）===");
const LBL = [
  ["label 原样含反斜杠", "前＼后 x\\`y 尾部", "l2\n尾"],
  ["label 清洗后", "前＼后 x`y 尾部", "l2\n尾"],
];
for (const [name, firstLine, rest] of LBL) {
  const s = srcOf("c1a00004", firstLine + "\n" + rest);
  show(await probe(name + "（tip 同步有）", s));
  show(await probe(name + "（剥 tip）", s.replace(/@\{"tip":"[^"]*"\}/, "")));
}
