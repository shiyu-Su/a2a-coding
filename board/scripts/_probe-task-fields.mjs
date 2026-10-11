/**
 * _probe-task-fields.mjs —— 只读探针（本卡 Step 0 核实①：依赖图信息增强的数据可得性）。
 *
 * 三面同列比对，逐字段定档：
 *   L1 = 引擎只读面 `GET :3300/api/features/:id` 的 tasks[] **实际出参键**
 *   L2 = 板 `bridge-client.FeatureTaskItem`（板侧类型 + parseFeatureDetail 装配）
 *   L3 = 板消费面：任务表 / 三面表 / 依赖图节点标签 实际用到的字段
 * 并附「引擎有但板未透传」「板透传了但类型未声明」两类差集，以及 taskType 是否可读。
 */
import { readFileSync } from "node:fs";

const BRIDGE = process.env.A2A_BRIDGE ?? "http://127.0.0.1:3300";
const FID = process.argv[2] ?? "3b7ea660-a5e8-4c85-ba7a-35d01c043080";

const r = await fetch(`${BRIDGE}/api/features/${encodeURIComponent(FID)}`, {
  headers: { Accept: "application/json" },
});
if (!r.ok) throw new Error(`HTTP ${r.status}`);
const j = await r.json();

console.log("== 详情出参顶层键 ==");
console.log(Object.keys(j).join(", "));
console.log("\n== feature 对象键 ==");
console.log(Object.keys(j.feature ?? {}).join(", "));
console.log("\n== tasks[] 键（并集，逐任务实际键数）==");
const keyUnion = new Set();
for (const t of j.tasks ?? []) for (const k of Object.keys(t)) keyUnion.add(k);
console.log([...keyUnion].sort().join(", "));
console.log("\n== 逐任务样例（截断 60 字符）==");
for (const t of j.tasks ?? []) {
  const o = {};
  for (const [k, v] of Object.entries(t)) {
    const s = Array.isArray(v) ? JSON.stringify(v) : String(v);
    o[k] = s.length > 60 ? s.slice(0, 60) + "…" : s;
  }
  console.log(o.taskId, JSON.stringify(o, null, 0));
}

// 归因面（同响应体或独立端点，探一遍）
console.log("\n== attributions / versions 面 ==");
for (const k of ["attributions", "projects", "versions", "attributionsByFeature"]) {
  if (k in j) console.log(`${k}: ${JSON.stringify(j[k]).slice(0, 200)}`);
}
const listRaw = await fetch(`${BRIDGE}/api/features`, { headers: { Accept: "application/json" } });
if (listRaw.ok) {
  const lj = await listRaw.json();
  console.log("列表面顶层键：", Object.keys(lj).join(", "));
  if (lj.attributionsByFeature) {
    const e = Object.entries(lj.attributionsByFeature).slice(0, 2);
    console.log("attributionsByFeature 样例：", JSON.stringify(e).slice(0, 300));
  }
  const f0 = (lj.features ?? [])[0];
  if (f0) console.log("列表项键：", Object.keys(f0).join(", "));
}

// 板侧类型面：从源码抽 FeatureTaskItem 字段清单（只读文本扫描）
const bc = readFileSync(new URL("../src/bridge-client.ts", import.meta.url), "utf8");
const iface = /export interface FeatureTaskItem \{([\s\S]*?)\n\}/.exec(bc);
console.log("\n== 板 FeatureTaskItem 声明字段 ==");
const declared = iface
  ? [...iface[1].matchAll(/^\s{2}(\w+)(\?)?:/gm)].map((m) => m[1] + (m[2] ? "?" : ""))
  : [];
console.log(declared.join(", "));
const declBare = new Set(declared.map((s) => s.replace("?", "")));
const engineOnly = [...keyUnion].filter((k) => !declBare.has(k));
const boardOnly = [...declBare].filter((k) => !keyUnion.has(k));
console.log("\n引擎有、板类型未声明：", engineOnly.join(", ") || "（无）");
console.log("板声明了、本次引擎出参没有：", boardOnly.join(", ") || "（无）");
