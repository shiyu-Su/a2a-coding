#!/usr/bin/env node
/**
 * v0.10.3 一次性脚本：经编排桥 HTTP 写口为 a2a-coding 组建 project 版本行。
 * 依据：PjM 版本规划评估（Feature edca37b1 节点 59e323f1）结论——
 *   flow 落 Project Version v0.10.3（与 Group 列车同号、保留 flow 的 v 前缀口径）；
 *   flow v0.10.3 行当前不存在（现读台账 count=7 中 flow 仅 v0.10.1 released）。
 * 口径同 scripts/_seed-project-versions.mjs（v0.10.1 先例）：这是「根级一次性脚本」通道，
 * 只调编排桥的 HTTP 写口，不读不写任何单元代码。
 *
 * 用法：node scripts/_create-v0103-version-row.mjs            # dry-run（只 GET 现状）
 *       node scripts/_create-v0103-version-row.mjs --apply    # 建版并回读
 */
const BASE = process.env.ENGINE_BASE ?? "http://127.0.0.1:8787";
const ORG = "a2a-coding";
// v0.10.3 起参数化：node scripts/_create-v0103-version-row.mjs --apply --project=board --version=0.10.3
// 缺省仍 = flow v0.10.3（本脚本首跑行为，保持可复现）
const argOf = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt;
const WANT = [{ projectId: argOf("project", "flow"), version: argOf("version", "v0.10.3") }];

const apply = process.argv.includes("--apply");

async function call(url, init) {
  const r = await fetch(url, init);
  const t = await r.text();
  let body;
  try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body };
}

function summarize(rows) {
  return (rows ?? []).map((x) => `${x.project_id}@${x.version}:${x.status}`).join(", ");
}

(async () => {
  console.log(`[base] ${BASE}  apply=${apply}`);

  const before = await call(`${BASE}/api/project-versions?owner_group=${ORG}`);
  console.log(`[before] http=${before.status} count=${before.body?.count} => ${summarize(before.body?.projectVersions)}`);

  for (const w of WANT) {
    if (!apply) {
      console.log(`[dry-run] would POST ${w.projectId} version=${w.version}`);
      continue;
    }
    const res = await call(`${BASE}/api/project-versions?owner_group=${ORG}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(w),
    });
    console.log(`[POST] ${w.projectId} ${w.version} => http=${res.status} body=${JSON.stringify(res.body).slice(0, 320)}`);
  }

  const after = await call(`${BASE}/api/project-versions?owner_group=${ORG}`);
  console.log(`[after] http=${after.status} count=${after.body?.count}`);
  for (const x of after.body?.projectVersions ?? []) {
    if (x.project_id === "flow") console.log(`    ${x.project_id} ${x.version} status=${x.status}`);
  }
})().catch((e) => {
  console.error("[ERR]", e.message);
  process.exit(1);
});
