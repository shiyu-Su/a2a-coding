/**
 * REQ-2026-10-09-01 · v0.10.1 · board B1 —— 引擎版本台账读取面的 **project 档扩解析 + 独立缺位档 + 负向钉**。
 *
 * 判据（改造文档 §2 C-7 / C-12 / §3 board 段 / §5 B1）：
 * 1. 顶层 `projectVersions[]` 在场 ⇒ 解析出 project 条目（最小键集 + 缺键 ⇒ `null` ⇒ 显示 `—`、不猜）；
 * 2. `versions[]` 在场 ∧ `projectVersions[]` **缺位** ⇒ **独立 absent 档**，Group 面（entries / 锁 /
 *    列并集）**一切照常**，不外溢成排期写停摆；
 * 3. `projectVersions[]` **空数组 = 合法事实**，与「缺位」**两种显示必须可区分**；
 * 4. **负向钉 (a)**：project 行混入 `versions[]` ⇒ 既不出现在版本列、也不命中排期锁；
 * 5. **负向钉 (b)**：同名 group / project 版号**互不染色**（两级计数不横向相加、不互校，C-18⑥）。
 *
 * 硬约束核对：`versions[]` 的成员与语义**零改动** —— 本文件只断言「新增字段不牵动 Group 面」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEngineVersions, parseProjectVersionsField, projectVersionsOf } from "../dist/bridge-client.js";
import { projectionLedgerOf, projectionVersionNames } from "../dist/web/views.js";
import { isVersionLocked } from "../dist/version-status.js";
import { releasedVersionNames } from "../dist/versions-ledger.js";

const CAPTURED_AT = "2026-10-09T00:00:00.000Z";

/** 信封快捷构造：只给 Group 面（老引擎档 = 不带 `projectVersions`）。 */
function envelope(versions, extra = {}) {
  return { ok: true, versions, ...extra };
}

/** 投影档取出（非 projection ⇒ 直接失败，附上如实的 code/error）。 */
function projectionOf(json) {
  const outcome = parseEngineVersions(json, CAPTURED_AT);
  assert.equal(outcome.kind, "projection", `期望 projection，实得 ${JSON.stringify(outcome)}`);
  return outcome.projection;
}

/**
 * 排期锁的**真实喂入路**（同 `server.ts` 的 `releasedVersionNames(versionProjectionLedgerOf(
 * projection), org)`）—— 负向钉必须走这条链，不得自造第二套判据。
 */
function lockHit(projection, version, org) {
  return isVersionLocked(version, releasedVersionNames(projectionLedgerOf(projection), org));
}

// ---------------------------------------------------------------------------
// ① 新字段在场 ⇒ 解析出 project 条目
// ---------------------------------------------------------------------------

test("B1-① projectVersions[] 在场 ⇒ 解析出条目（最小键集 + snake_case 全键）", () => {
  const p = projectionOf(
    envelope([{ owner_group: "alpha", version: "0.10.1", status: "active" }], {
      projectVersions: [
        {
          owner_group: "alpha",
          project_id: "board",
          version: "0.10.1",
          status: "open",
          releasable: false,
          open_count: 2,
          completed_count: 1,
          cancelled_count: 0,
          reason: "仍有未收口归属",
          repo_id: "repo-1",
          ref: "abc123",
        },
      ],
    }),
  );
  assert.equal(p.projectVersions.status, "live");
  assert.equal(p.projectVersions.entries.length, 1);
  assert.deepEqual(p.projectVersions.entries[0], {
    org: "alpha",
    projectId: "board",
    version: "0.10.1",
    status: "open",
    releasable: false,
    openCount: 2,
    completedCount: 1,
    cancelledCount: 0,
    reason: "仍有未收口归属",
    repoId: "repo-1",
    ref: "abc123",
  });
  // Group 面不受新字段影响（硬约束：成员与语义零改动）
  assert.deepEqual(p.entries, [{ org: "alpha", version: "0.10.1", status: "active" }]);
});

test("B1-①b camelCase 两式键都认（口径同 Group 面 owner_group/ownerGroup）", () => {
  const p = projectionOf(
    envelope([], {
      projectVersions: [{ ownerGroup: "beta", projectId: "orch", version: "1.2.3", repoId: "r2" }],
    }),
  );
  assert.equal(p.projectVersions.status, "live");
  assert.equal(p.projectVersions.entries[0].org, "beta");
  assert.equal(p.projectVersions.entries[0].projectId, "orch");
  assert.equal(p.projectVersions.entries[0].repoId, "r2");
});

test("B1-①c 缺键 ⇒ null（显示 `—`、不猜）；releasable 缺位不得当成 false", () => {
  const p = projectionOf(
    envelope([], { projectVersions: [{ owner_group: "", project_id: "flow", version: "0.10.1" }] }),
  );
  const e = p.projectVersions.entries[0];
  assert.equal(e.org, "");
  assert.equal(e.status, null);
  assert.equal(e.releasable, null, "缺 releasable ⇒ null（过渡档），不得渲染成「不可发版」");
  assert.equal(e.openCount, null);
  assert.equal(e.completedCount, null);
  assert.equal(e.cancelledCount, null);
  assert.equal(e.reason, null);
  assert.equal(e.repoId, null);
  assert.equal(e.ref, null);
});

test("B1-①d 非法条目整条丢弃（缺 project_id / 缺 version / 非对象），其余照收", () => {
  const p = projectionOf(
    envelope([], {
      projectVersions: [
        { project_id: "a", version: " " },
        { version: "9.9.9" },
        "junk",
        null,
        { project_id: "ok", version: "9.9.9" },
      ],
    }),
  );
  assert.equal(p.projectVersions.status, "live");
  assert.deepEqual(
    p.projectVersions.entries.map((e) => `${e.projectId}@${e.version}`),
    ["ok@9.9.9"],
  );
});

// ---------------------------------------------------------------------------
// ② 缺位 ⇒ 独立 absent 档，且 Group 面不受影响
// ---------------------------------------------------------------------------

test("B1-② versions[] 在场 ∧ projectVersions[] 缺位 ⇒ projection + project absent，Group 面照常", () => {
  const p = projectionOf(envelope([{ owner_group: "alpha", version: "0.9.9", status: "released" }]));
  // 独立缺位档（不动 kind）
  assert.equal(p.projectVersions.status, "absent");
  assert.equal(p.projectVersions.code, "project_versions_field_missing");
  assert.match(p.projectVersions.error, /引擎 project 版本面未上线/);
  // Group 面一切照常：投影 / 版本列 / 锁
  assert.deepEqual(p.entries, [{ org: "alpha", version: "0.9.9", status: "released" }]);
  assert.deepEqual(projectionVersionNames(p, "alpha"), ["0.9.9"]);
  assert.equal(lockHit(p, "0.9.9", "alpha"), true, "老引擎档下 Group 锁照常执法（project 缺位不放松 Group 锁）");
});

test("B1-②b projectVersions 非数组 ⇒ absent（形状不合法档），Group 面照常", () => {
  const p = projectionOf(envelope([{ owner_group: "alpha", version: "0.9.9", status: "released" }], {
    projectVersions: { project_id: "board" },
  }));
  assert.equal(p.projectVersions.status, "absent");
  assert.equal(p.projectVersions.code, "project_versions_field_invalid");
  assert.deepEqual(p.entries, [{ org: "alpha", version: "0.9.9", status: "released" }]);
});

test("B1-②c versions[] 缺位仍走现档（kind absent；project 面不另立停摆）", () => {
  const outcome = parseEngineVersions({ ok: true, projectVersions: [{ project_id: "a", version: "1" }] }, CAPTURED_AT);
  assert.equal(outcome.kind, "absent");
  assert.equal(outcome.code, "versions_field_missing");
});

test("B1-②d 信封 ok:false / 非对象 ⇒ 走现档（两档分立下 absent 只由 Group 面决定）", () => {
  for (const json of [{ ok: false, code: "boom", error: "引擎报错" }, null, "junk", 42]) {
    assert.equal(parseEngineVersions(json, CAPTURED_AT).kind, "absent");
  }
});

// ---------------------------------------------------------------------------
// ③ 空数组 ≠ 缺位（两种显示必须可区分）
// ---------------------------------------------------------------------------

test("B1-③ 空数组 = 合法事实（empty）；缺位 = absent —— 两档 status 必须不同", () => {
  const emptyP = projectionOf(envelope([], { projectVersions: [] }));
  const absentP = projectionOf(envelope([]));
  assert.equal(emptyP.projectVersions.status, "empty");
  assert.equal(absentP.projectVersions.status, "absent");
  assert.notEqual(emptyP.projectVersions.status, absentP.projectVersions.status);
  // empty 档不携带降级根因（在场无行 ⇒ 显示「未登记，本版本起生效」，不是「未上线」）
  assert.equal("code" in emptyP.projectVersions, false);
});

test("B1-③b 全为非法条目的数组仍算 empty（在场无合法行 ≠ 缺位）", () => {
  const p = projectionOf(envelope([], { projectVersions: [{}, { version: "1" }, 7] }));
  assert.equal(p.projectVersions.status, "empty");
});

test("B1-③c parseProjectVersionsField 可单独调用（纯函数面钉三态）", () => {
  assert.deepEqual(parseProjectVersionsField({}), {
    status: "absent",
    code: "project_versions_field_missing",
    error: "响应无 projectVersions[]（引擎 project 版本面未上线）",
  });
  assert.deepEqual(parseProjectVersionsField({ projectVersions: [] }), { status: "empty" });
  assert.equal(parseProjectVersionsField({ projectVersions: [{ project_id: "a", version: "1" }] }).status, "live");
});

test("B1-③d projectVersionsOf 归一：不带字段的投影 ⇒ absent（绝不当成 empty 放行）", () => {
  // 夹具默认档 / 历史最后一次投影 = 不带该字段
  const legacy = { entries: [{ org: "alpha", version: "0.9.9", status: "released" }], capturedAt: CAPTURED_AT };
  assert.equal(projectVersionsOf(legacy).status, "absent");
  assert.equal(projectVersionsOf(null).status, "absent");
  assert.equal(projectVersionsOf(undefined).status, "absent");
  // 三态原样透传
  assert.equal(projectVersionsOf({ ...legacy, projectVersions: { status: "empty" } }).status, "empty");
  // 解析结果恒带该字段 ⇒ 归一后仍是 live/absent，不额外造档
  assert.equal(projectVersionsOf(projectionOf(envelope([], { projectVersions: [] }))).status, "empty");
  assert.equal(projectVersionsOf(projectionOf(envelope([]))).code, "project_versions_field_missing");
});

// ---------------------------------------------------------------------------
// ④ 负向钉 (a)：project 行混入 versions[] ⇒ 不出列、不命中锁
// ---------------------------------------------------------------------------

test("B1-④a project 行混入 versions[] ⇒ 既不出现在版本列、也不命中排期锁", () => {
  const p = projectionOf(
    envelope([
      { owner_group: "alpha", version: "0.10.0", status: "released" },
      // 误混入 Group 面的 project 档行（带 project_id 即 project 形状行）
      { owner_group: "alpha", project_id: "board", version: "0.10.1", status: "released", releasable: true },
      { ownerGroup: "alpha", projectId: "orch", version: "0.10.2", status: "released" },
    ]),
  );
  // ① Group 投影：project 行整条不进 entries（解析层不认带 project_id 的行 ⇒ 无法成为锁数据源）
  assert.deepEqual(p.entries, [{ org: "alpha", version: "0.10.0", status: "released" }]);
  // ② 版本列不含这两个 project 版号
  assert.deepEqual(projectionVersionNames(p, "alpha"), ["0.10.0"]);
  // ③ 排期锁不命中（走 server 的真实喂入链 projectionLedgerOf → releasedVersionNames → isVersionLocked）
  assert.equal(lockHit(p, "0.10.1", "alpha"), false);
  assert.equal(lockHit(p, "0.10.2", "alpha"), false);
  assert.equal(lockHit(p, "0.10.0", "alpha"), true, "同信封里的真 Group released 行照常锁");
  // ④ 该行为不污染 project 档（顶层无 projectVersions ⇒ 依旧 absent）
  assert.equal(p.projectVersions.status, "absent");
});

test("B1-④a2 project_id 缺键 / null / 空白 ⇒ 仍按 Group 行处理（不改 versions[] 既有语义）", () => {
  const p = projectionOf(
    envelope([
      { owner_group: "alpha", version: "0.1.0", status: "released" },
      { owner_group: "alpha", project_id: null, version: "0.2.0", status: "released" },
      { owner_group: "alpha", project_id: "  ", version: "0.3.0", status: "released" },
    ]),
  );
  assert.deepEqual(projectionVersionNames(p, "alpha"), ["0.1.0", "0.2.0", "0.3.0"]);
});

// ---------------------------------------------------------------------------
// ⑤ 负向钉 (b)：同名 group / project 版号互不染色
// ---------------------------------------------------------------------------

test("B1-⑤b1 Group 未 released ∧ project 同名 released ⇒ Group 不锁（project 不染色 Group）", () => {
  const p = projectionOf(
    envelope([{ owner_group: "alpha", version: "0.10.1", status: "active" }], {
      projectVersions: [{ owner_group: "alpha", project_id: "board", version: "0.10.1", status: "released" }],
    }),
  );
  assert.deepEqual(projectionVersionNames(p, "alpha"), ["0.10.1"], "Group 面仍只有自己那一行");
  assert.equal(lockHit(p, "0.10.1", "alpha"), false, "project 同名行不得把 Group 版号染成已发版");
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0].status, "active", "Group 条目状态不被 project 行改写");
  assert.equal(p.projectVersions.status, "live");
  assert.equal(p.projectVersions.entries[0].status, "released", "project 行只活在自己的档里");
});

test("B1-⑤b2 Group released ∧ project 同名未 released ⇒ Group 锁照常（project 不松 Group）", () => {
  const p = projectionOf(
    envelope([{ owner_group: "alpha", version: "0.10.1", status: "released" }], {
      projectVersions: [{ owner_group: "alpha", project_id: "board", version: "0.10.1", status: "open" }],
    }),
  );
  assert.equal(lockHit(p, "0.10.1", "alpha"), true);
  assert.equal(p.projectVersions.entries[0].status, "open", "project 行不被 Group 状态改写");
});

test("B1-⑤b3 双计数不得横向相加 / 互校：Group 条目数与 project 条目数各自独立", () => {
  const p = projectionOf(
    envelope(
      [
        { owner_group: "alpha", version: "0.10.1", status: "active" },
        { owner_group: "alpha", version: "0.10.0", status: "released" },
      ],
      {
        projectVersions: [
          { owner_group: "alpha", project_id: "board", version: "0.10.1", completed_count: 3 },
          { owner_group: "alpha", project_id: "orch", version: "0.10.1", completed_count: 5 },
        ],
      },
    ),
  );
  // Group 侧 = 2 个版号（与 project 的 2 行 / 计数 3+5 无任何算术关系）
  assert.deepEqual(projectionVersionNames(p, "alpha"), ["0.10.1", "0.10.0"]);
  assert.equal(p.entries.length, 2);
  assert.equal(p.projectVersions.entries.length, 2);
  assert.equal(p.projectVersions.entries[0].completedCount, 3);
  assert.equal(p.projectVersions.entries[1].completedCount, 5);
  // Group 条目不带 project 字段；project 计数不回流 Group 面
  for (const e of p.entries) assert.equal("projectId" in e, false);
});

test("B1-⑤b4 同名版号跨 org：Group 列 / 锁按 org 切片，project 面不参与切片判定", () => {
  const p = projectionOf(
    envelope(
      [
        { owner_group: "alpha", version: "0.10.1", status: "released" },
        { owner_group: "beta", version: "0.10.1", status: "active" },
      ],
      // beta 的 project 档同名行 released ⇒ 不得让 beta 的 Group 面锁上
      {
        projectVersions: [{ owner_group: "beta", project_id: "board", version: "0.10.1", status: "released" }],
      },
    ),
  );
  assert.deepEqual(projectionVersionNames(p, "alpha"), ["0.10.1"]);
  assert.deepEqual(projectionVersionNames(p, "beta"), ["0.10.1"], "列 = 该 org 的 Group 行（active 也成列）");
  assert.equal(lockHit(p, "0.10.1", "alpha"), true);
  assert.equal(lockHit(p, "0.10.1", "beta"), false, "beta 的 Group 行未 released ⇒ 不锁，project 同名行不染色");
});
