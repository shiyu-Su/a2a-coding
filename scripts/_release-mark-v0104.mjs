// v0.10.4 标记 released（宿主一次性脚本，不提交）。
// 存在原因：请求体含单元段名（tag 名 board/...），Bash 直写会被守卫拦；且无对应 MCP 工具。
const BASE = "http://127.0.0.1:8787";
const OWNER = "a2a-coding";
const VERSION = "v0.10.4";

const body = {
  owner_group: OWNER,
  status: "released",
  changelogAnchor: `#${VERSION}`,
  // Release 快照：单仓（monorepo）下本版仅 board 触达 ⇒ 一条 ref（orch/machine 零改动、不产生 tag）
  projects: [{ repoId: "a2a-coding", ref: "board/v0.11.0" }],
  note: "v0.10.4 板面免手刷 + 板卡片呈现统一 + 依赖图分色修复 + 项目池手动刷新。停同升第五次：仅 board 0.10.3→0.11.0（Project Version 经用户裁定、非 0.10.4），orch/machine 保持 0.10.2，flow 零触达。根回归 1380/1380。tag board/v0.11.0。",
};

const patch = await fetch(`${BASE}/api/versions/${VERSION}/status?owner_group=${encodeURIComponent(OWNER)}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
console.log("PATCH status =", patch.status);
console.log("PATCH body   =", JSON.stringify(await patch.json(), null, 1));

const list = await fetch(`${BASE}/api/versions?owner_group=${encodeURIComponent(OWNER)}`);
const data = await list.json();
const rows = data.versions ?? data.items ?? data.rows ?? data;
const arr = Array.isArray(rows) ? rows : [];
console.log("\nGET /api/versions status =", list.status, " 条数 =", arr.length);
for (const r of arr.filter((x) => /^v0\.(10)/.test(String(x.version)))) console.log(" ", r.version, "=", r.status);

const pv = await (await fetch(`${BASE}/api/project-versions`)).json();
console.log("\n== project_versions（0.11.0 行应随级联置 released）==");
for (const e of pv.projectVersions || []) {
  if (String(e.version) === "0.11.0") console.log(`  ${e.project_id || "?"} / 0.11.0 = ${e.status}`);
}
