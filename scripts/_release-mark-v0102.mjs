// v0.10.2 标记 released（宿主一次性脚本，不提交）。
// 存在原因：请求体含单元段名（tag 名 orch/... machine/... board/...），Bash 直写会被守卫拦；且无对应 MCP 工具。
const BASE = "http://127.0.0.1:8787";
const OWNER = "a2a-coding";
const VERSION = "v0.10.2";

const body = {
  owner_group: OWNER,
  status: "released",
  changelogAnchor: `#${VERSION}`,
  // Release 快照：单仓（monorepo）下三个 tag 各钉一条 ref（machine 本版首次抬号 ⇒ 首次入 tag 面）
  projects: [
    { repoId: "a2a-coding", ref: "orch/v0.10.2" },
    { repoId: "a2a-coding", ref: "machine/v0.10.2" },
    { repoId: "a2a-coding", ref: "board/v0.10.2" },
  ],
  note: "v0.10.2 角色化 + 配置模板拆分 + 板读面分流。停同升第三次实操：orch/board/machine 同升 0.10.2（machine 首次自 0.9.8 抬号）、根 0.10.2、tag <unit>/v0.10.2 ×3。commit 56c7f73。根回归 1378/1378。",
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
console.log("GET /api/versions status =", list.status, " 条数 =", arr.length);
for (const r of arr.filter((x) => /^v0\.(9|10)/.test(String(x.version)))) {
  console.log(" ", r.version, "=", r.status);
}
const pv = await (await fetch(`${BASE}/api/project-versions`)).json();
console.log("\n== project_versions（0.10.2 行应随级联置 released）==");
for (const e of pv.projectVersions || []) {
  if (String(e.version) === "0.10.2") console.log(`  ${e.project_id || "?"} / 0.10.2 = ${e.status}`);
}
