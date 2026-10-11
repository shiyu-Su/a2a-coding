#!/usr/bin/env node
/**
 * v0.10.1 一次性脚本：为 a2a-coding 组建 project 版本行。
 *
 * 口径（用户 2026-10-09 裁「按推荐」）：
 *   - project 版本号**以各 project 自己的 package.json 为准**；
 *   - **谁真动了产品行为谁 bump**；
 *   - 无 package.json 载体者（flow）按规范版本戳取同值。
 *
 * 本次（v0.10.1）实际取值：
 *   orch    0.10.0 -> 0.10.1   （有行为变更）
 *   board   0.10.0 -> 0.10.1   （有行为变更）
 *   machine 0.9.8（不动）       （本版只有 4 处注释/文档，无行为变更）
 *   flow    v0.10.1（戳）       （本单元无 package.json）
 *
 * 用法：
 *   node scripts/_seed-project-versions.mjs            # dry-run（只 GET 现状）
 *   node scripts/_seed-project-versions.mjs --probe    # 只 POST 第一条，打印原始响应（摸契约）
 *   node scripts/_seed-project-versions.mjs --apply    # 建全部四条并回读
 *
 * 说明：这是「根级一次性脚本」通道（同 scripts/_export-board-ledger.mjs 先例）——
 * 它只调编排桥的 HTTP 只写口，不读不写任何单元代码。
 */
const BASE = process.env.ENGINE_BASE ?? "http://127.0.0.1:8787";
const ORG = "a2a-coding";

const WANT = [
  { projectId: "orch", version: "0.10.1" },
  { projectId: "board", version: "0.10.1" },
  { projectId: "machine", version: "0.9.8" },
  { projectId: "flow", version: "v0.10.1" },
];

const apply = process.argv.includes("--apply");
const probe = process.argv.includes("--probe");

async function call(url, init) {
  const r = await fetch(url, init);
  const t = await r.text();
  let body;
  try {
    body = JSON.parse(t);
  } catch {
    body = t;
  }
  return { status: r.status, body };
}

function summarize(rows) {
  return (rows ?? []).map((x) => `${x.project_id}@${x.version}:${x.status}`).join(", ");
}

(async () => {
  console.log(`[base] ${BASE}  apply=${apply}  probe=${probe}`);

  const before = await call(`${BASE}/api/project-versions?owner_group=${ORG}`);
  console.log(`[before] http=${before.status} count=${before.body?.count} => ${summarize(before.body?.projectVersions)}`);

  const targets = probe ? [WANT[0]] : WANT;

  for (const w of targets) {
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

  if (apply || probe) {
    const after = await call(`${BASE}/api/project-versions?owner_group=${ORG}`);
    console.log(`[after] http=${after.status} count=${after.body?.count}`);
    for (const x of after.body?.projectVersions ?? []) {
      console.log(`    ${x.project_id} ${x.version} status=${x.status} releasable=${x.releasable}`);
    }
  }
})().catch((e) => {
  console.error("[ERR]", e.message);
  process.exit(1);
});
