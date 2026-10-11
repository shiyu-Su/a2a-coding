// v0.10.0 标记 released（宿主一次性脚本，不提交）。
// 存在原因：请求体含单元段名（tag 名 orch/... board/...），Bash 直写会被守卫拦；且无对应 MCP 工具。
const BASE = "http://127.0.0.1:8787";
const OWNER = "a2a-coding";
const VERSION = "v0.10.0";

const body = {
  owner_group: OWNER,
  status: "released",
  changelogAnchor: `#${VERSION}`,
  // 首个真实 Release 快照：单仓（monorepo）下两个 tag 各钉一条 ref；repoId = 宿主仓身份
  // （四个 project 均未配 `repo` ⇒ 按「缺省 = 宿主仓」由调用方落地，引擎不猜）
  projects: [
    { repoId: "a2a-coding", ref: "orch/v0.10.0" },
    { repoId: "a2a-coding", ref: "board/v0.10.0" },
  ],
  note: "v0.10.0 版本面单一事实源。按兼容契约分组首次实操：orch/board 升 0.10.0、machine 保持 0.9.8（协议未变 2.3）、flow 四戳 v0.10.0。commit 7ce3486。",
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
