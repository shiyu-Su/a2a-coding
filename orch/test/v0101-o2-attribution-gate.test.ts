/**
 * v0.10.1 **O2**（REQ-2026-10-09-01 · 改造文档 §2 C-2 / C-3 / C-4 / C-15 / C-21 / §3 orch 段 / §5 T2）
 * —— **归属写执法** + **project 侧 `releasable` 判据**。
 *
 * 锁定的行为面：
 * 1. **(a) 未过门挡归属写** `orch_project_attribution_state_locked`：判据 = `approval = 已通过`，
 *    **不看 `stage`**（`stage = 需求分析` 但已过 `approve` ⇒ 放行；`stage = 改造方案` 未过门 ⇒ 挡）；
 *    `cancelled` **不得新写**（含「同值重发」也不放开）；`completed` 未发版**仍可补写**；
 *    无 Group Version（`features.version` 空）⇒ 落不下归属（C-21）。
 * 2. **(b) 归属 released 门** `orch_project_version_released_locked`（目标行已 `released` ⇒ 冻结）。
 * 3. **(c) 不隐式建版** `orch_project_version_unknown`：拒绝后 `project_versions` **仍无该行**。
 * 4. **(d) 不变式继承判据**：同 `(owner_group, group_version, project_id)` 已有**他人**承诺 ⇒ 必须同值；
 *    不同 `group_version` / 无承诺 ⇒ 不约束（**不做前瞻**）；无父主轨首条归属自选。
 * 5. **(e) 幂等 / 重放**：同值重发 = **零写入**（`noop` + `updated_at` 不动 + `source` 沿用）；
 *    异值 ⇒ `orch_project_attribution_conflict`（own row 原样不动）；改归属走显式**先删后建**两笔；
 *    单内同 project 异值 ⇒ 矛盾拒、同值 ⇒ 去重；空身份字段 ⇒ `orch_project_version_invalid_shape`。
 * 6. **★N-8 fail-fast**：归属校验失败 ⇒ **Feature `state` 逐字不变 + 归属零落库**（含「批里第 2 条
 *    非法 ⇒ 第 1 条也不落」）；`checkFeatureAttributionWrites` 是**纯校验**（自身不写库）；
 *    他组身份 ⇒ 归属校验先挡（fail-closed，不泄漏他组）。
 * 7. **`releasable` 计数**（C-4 展示档）：判据 `total>0 ∧ completed+cancelled===total`（**不含
 *    `completed>0`**）⇒ **全 `cancelled` 的 project 也判 `true`**（级联档前提）；`open` 含 `failed`。
 * 8. **双计数不互校 / 不横向相加**（★R2）：Group 闸从 `features.version` 派生、project 从归属表派生
 *    ⇒ 同一张卡两处计数分母可不同、一个挡另一个可放行；**同名版号在两级互不染色**。
 * 9. **O2 边界钉**：Group 闸判据**未被放宽**（全 `cancelled` 的 Group 仍 `orch_version_all_cancelled`）、
 *    排期锁与 `features` 登记列不受归属写影响（归属写**不动** `features` 任何列）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateFeaturesByVersion,
  close,
  ERR_PROJECT_VERSION_SHAPE,
  ERR_PROJECT_VERSION_UNKNOWN,
  featureProjectDelete,
  featureProjectListByFeature,
  featureProjectUpsert,
  getFeature,
  openStoreDatabase,
  projectVersionCreate,
  projectVersionGet,
  versionLedgerCreate,
} from "../session/store.js";
import {
  applyFeatureAttributions,
  checkFeatureAttributionWrites,
  ERR_ATTRIBUTION_CONFLICT,
  ERR_ATTRIBUTION_STATE_LOCKED,
  ERR_PROJECT_VERSION_RELEASED_LOCKED,
  evaluateProjectReleaseGate,
  evaluateReleaseGate,
  handleFeatureApprove,
  handleFeatureAdvance,
  handleFeatureCancel,
  handleFeatureCreate,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";
import type { FeatureStage } from "../types.js";

// ---------------------------------------------------------------------------
// 脚手架（照 v0100-o4 的 file-DB + 灌数据 + 重开默认存储口径）
// ---------------------------------------------------------------------------

function mustOk<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) {
    const f = outcome as unknown as { code?: string; error?: string; message?: string };
    throw new Error(`期望成功，实际失败：${f.code} ${f.error ?? f.message}`);
  }
  return outcome as Extract<T, { ok: true }>;
}

function mustFail(outcome: { ok: boolean } | FeatureToolFailure): FeatureToolFailure {
  if (outcome.ok) throw new Error("期望失败，实际成功");
  return outcome as FeatureToolFailure;
}

function tmpDbPath(tag: string): string {
  return join(
    tmpdir(),
    `a2a-v0101-o2-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

function rmDb(dbPath: string): void {
  // 本文件的读封装按 env 惰性重开默认存储 ⇒ 收尾时存储可能仍开在该文件上；
  // Windows 下锁着的 sqlite 文件删不掉（EPERM）⇒ **必须先 close() 再删**。
  close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
}

function reopenDefault(dbPath: string): void {
  process.env["SESSION_DB"] = dbPath;
  close();
}

/** 建库（跑既有 DDL / 两表）后关闭，供灌数据 */
function bootstrap(dbPath: string): void {
  reopenDefault(dbPath);
  mustOk(handleFeatureCreate({ title: "bootstrap" }));
  close();
}

/** Group 台账灌版号（`handleFeatureCreate` 带 version 需版号已登记） */
function seedGroup(dbPath: string, rows: Array<[ownerGroup: string | null, version: string]>): void {
  reopenDefault(dbPath);
  for (const [ownerGroup, version] of rows) {
    mustOk(versionLedgerCreate({ ownerGroup, version }));
  }
  close();
}

/** project 台账灌版本行（建版走 O1 显式写口 ⇒ 缺省 `open`） */
function seedProject(
  dbPath: string,
  rows: Array<[ownerGroup: string | null, projectId: string, version: string]>,
): void {
  reopenDefault(dbPath);
  for (const [ownerGroup, projectId, version] of rows) {
    mustOk(projectVersionCreate({ ownerGroup, projectId, version }));
  }
  close();
}

/**
 * 把 project 版本行置 `released` —— **不经 store 写口**（`released` 只由 Group 级发版同事务级联
 * 置入，那是 T3 的面；本节点只测门判据）⇒ 走裸连接 UPDATE，先 `close()` 再重开。
 */
function markProjectReleased(
  dbPath: string,
  rows: Array<[ownerGroup: string | null, projectId: string, version: string]>,
): void {
  close();
  const db = openStoreDatabase(dbPath);
  try {
    const upd = db.prepare(
      "UPDATE project_versions SET status = 'released' WHERE owner_group IS ? AND project_id = ? AND version = ?",
    );
    for (const [ownerGroup, projectId, version] of rows) upd.run(ownerGroup, projectId, version);
  } finally {
    db.close();
  }
}

/** 一张「已过门」的卡（create 缺省 = 改造方案 / 待审批 → approve → `executing` + `已通过`） */
function approvedFeature(
  dbPath: string,
  group: string | null,
  version: string,
  title: string,
  stage?: FeatureStage,
): string {
  reopenDefault(dbPath);
  const created = mustOk(
    handleFeatureCreate(
      stage === undefined
        ? { title, version }
        : { title, version, stage, approval: "待审批" },
      group,
    ),
  );
  mustOk(handleFeatureApprove({ featureId: created.featureId }, group));
  close();
  return created.featureId;
}

/** 推进到 `completed`（主链逐格，不经 store 直写 ⇒ 与真实验收路径同形） */
function toCompleted(dbPath: string, featureId: string, group: string | null): void {
  reopenDefault(dbPath);
  for (const to of ["integrating", "testing", "reviewing", "completed"] as const) {
    mustOk(handleFeatureAdvance({ featureId, to }, group));
  }
  close();
}

function cancelFeature(dbPath: string, featureId: string, group: string | null): void {
  reopenDefault(dbPath);
  mustOk(handleFeatureCancel({ featureId }, group));
  close();
}

/** 直灌归属（走 O1 数据面，绕开本节点的执法 ⇒ 用作「已存在的承诺」前提） */
function seedAttribution(
  dbPath: string,
  input: {
    ownerGroup: string | null;
    featureId: string;
    projectId: string;
    projectVersion: string;
    groupVersion: string;
    source?: string | null;
  },
): void {
  reopenDefault(dbPath);
  mustOk(featureProjectUpsert(input));
  close();
}

function attributions(featureId: string): number {
  reopenDefault(process.env["SESSION_DB"] ?? ":memory:");
  const n = featureProjectListByFeature(featureId).length;
  return n;
}

// ---------------------------------------------------------------------------
// 1 (a)：未过门挡归属写（判据看 `approval`、不看 `stage`）
// ---------------------------------------------------------------------------

test("O2 (a) 未过门 ⇒ orch_project_attribution_state_locked；判据 = approval=已通过 ∧ 不看 stage", () => {
  const dbPath = tmpDbPath("state-locked");
  try {
    bootstrap(dbPath);
    seedGroup(dbPath, [["g1", "1.0.0"]]);
    seedProject(dbPath, [["g1", "orch", "0.1.0"]]);

    // ① 想法卡（需求分析 / 未发起）⇒ 挡
    reopenDefault(dbPath);
    const idea = mustOk(
      handleFeatureCreate(
        { title: "想法卡", stage: "需求分析", approval: "未发起", version: "1.0.0" },
        "g1",
      ),
    );
    close();
    let fail = mustFail(
      applyFeatureAttributions(
        { featureId: idea.featureId, projectVersions: [{ projectId: "orch", projectVersion: "0.1.0" }] },
        "g1",
      ),
    );
    assert.equal(fail.code, ERR_ATTRIBUTION_STATE_LOCKED);
    assert.equal(attributions(idea.featureId), 0, "未过门 ⇒ 归属零落库");

    // ② 改造方案 / 待审批（门未过）⇒ 挡
    reopenDefault(dbPath);
    const pending = mustOk(handleFeatureCreate({ title: "待审批卡", version: "1.0.0" }, "g1"));
    close();
    fail = mustFail(
      applyFeatureAttributions(
        { featureId: pending.featureId, projectVersions: [{ projectId: "orch", projectVersion: "0.1.0" }] },
        "g1",
      ),
    );
    assert.equal(fail.code, ERR_ATTRIBUTION_STATE_LOCKED, "approval=待审批 ⇒ 未过门");

    // ③ **不看 stage**：stage 停在「需求分析」但已过 approve ⇒ 放行
    const earlyStage = approvedFeature(dbPath, "g1", "1.0.0", "stage未迁但已过门", "需求分析");
    reopenDefault(dbPath);
    assert.equal(getFeature(earlyStage)?.stage, "需求分析", "前提：stage 确实未迁");
    mustOk(
      applyFeatureAttributions(
        { featureId: earlyStage, projectVersions: [{ projectId: "orch", projectVersion: "0.1.0" }] },
        "g1",
      ),
    );
    close();
    assert.equal(attributions(earlyStage), 1, "门看 approval、不看 stage ⇒ 放行");

    // ④ 无 Group Version（version 空）⇒ 落不下归属（C-21）
    reopenDefault(dbPath);
    const unversioned = mustOk(handleFeatureCreate({ title: "未排期卡" }, "g1"));
    mustOk(handleFeatureApprove({ featureId: unversioned.featureId }, "g1"));
    close();
    fail = mustFail(
      applyFeatureAttributions(
        { featureId: unversioned.featureId, projectVersions: [{ projectId: "orch", projectVersion: "0.1.0" }] },
        "g1",
      ),
    );
    assert.equal(fail.code, ERR_ATTRIBUTION_STATE_LOCKED, "无 Group Version ⇒ 无归属");
    assert.equal(attributions(unversioned.featureId), 0);

    // ⑤ `cancelled` 不得新写（★R3）：**同值重发也不放开**
    const cancelled = approvedFeature(dbPath, "g1", "1.0.0", "取消轨");
    reopenDefault(dbPath);
    mustOk(
      applyFeatureAttributions(
        { featureId: cancelled, projectVersions: [{ projectId: "orch", projectVersion: "0.1.0" }], source: "mcp" },
        "g1",
      ),
    );
    close();
    cancelFeature(dbPath, cancelled, "g1");
    fail = mustFail(
      applyFeatureAttributions(
        { featureId: cancelled, projectVersions: [{ projectId: "orch", projectVersion: "0.1.0" }] },
        "g1",
      ),
    );
    assert.equal(fail.code, ERR_ATTRIBUTION_STATE_LOCKED, "cancelled ⇒ 不得新写（同值重发亦拒）");
    reopenDefault(dbPath);
    const ownRow = featureProjectListByFeature(cancelled)[0];
    assert.ok(ownRow !== undefined, "前提：取消前已落 1 行");
    assert.equal(ownRow.source, "mcp", "拒绝 ⇒ 既有行逐字不动（含 source / updated_at）");
    close();

    // ⑥ `completed` 未发版**仍可补写**（执行期新增节点后补承诺）
    const done = approvedFeature(dbPath, "g1", "1.0.0", "已完成补写");
    toCompleted(dbPath, done, "g1");
    reopenDefault(dbPath);
    assert.equal(getFeature(done)?.state, "completed");
    const late = mustOk(
      applyFeatureAttributions(
        { featureId: done, projectVersions: [{ projectId: "orch", projectVersion: "0.1.0" }] },
        "g1",
      ),
    );
    close();
    assert.equal(late.created, 1, "completed 未发版 ⇒ 归属可补写");

    // ⑦ 空数组 = 零写 no-op，**不是**「清空归属」
    assert.equal(attributions(done), 1, "前提：已有 1 行");
    reopenDefault(dbPath);
    const empty = mustOk(applyFeatureAttributions({ featureId: done, projectVersions: [] }, "g1"));
    close();
    assert.equal(empty.noop, 0);
    assert.equal(empty.created, 0);
    assert.equal(attributions(done), 1, "空数组不得当成清空");
  } finally {
    rmDb(dbPath);
    process.env["SESSION_DB"] = ":memory:";
    close();
  }
});

// ---------------------------------------------------------------------------
// 2 (b)(c)：归属 released 门 + 不隐式建版（含匿名档 NULL-safe `IS`）
// ---------------------------------------------------------------------------

test("O2 (b)(c) 目标版本行不存在 ⇒ orch_project_version_unknown 且不隐式建版；已 released ⇒ 冻结门", () => {
  const dbPath = tmpDbPath("released-gate");
  try {
    bootstrap(dbPath);
    seedGroup(dbPath, [
      ["g1", "1.0.0"],
      [null, "1.0.0"],
    ]);
    seedProject(dbPath, [
      ["g1", "orch", "0.1.0"],
      ["g1", "orch", "9.9.9"],
      [null, "flow", "0.1.0"],
    ]);
    markProjectReleased(dbPath, [["g1", "orch", "9.9.9"]]);

    const feature = approvedFeature(dbPath, "g1", "1.0.0", "门判据");
    const anonymous = approvedFeature(dbPath, null, "1.0.0", "匿名档门判据");

    // (c) 未登记的 project 版本 ⇒ 拒，**且不得把该行建出来**
    reopenDefault(dbPath);
    let fail = mustFail(
      applyFeatureAttributions(
        { featureId: feature, projectVersions: [{ projectId: "orch", projectVersion: "0.9.0" }] },
        "g1",
      ),
    );
    assert.equal(fail.code, ERR_PROJECT_VERSION_UNKNOWN, "C-15：建版只走显式写口");
    assert.equal(projectVersionGet("g1", "orch", "0.9.0"), null, "拒绝 ⇒ 不隐式建版（台账仍无此行）");
    close();
    assert.equal(attributions(feature), 0);

    // (b) 目标行已 released ⇒ 冻结门
    fail = mustFail(
      applyFeatureAttributions(
        { featureId: feature, projectVersions: [{ projectId: "orch", projectVersion: "9.9.9" }] },
        "g1",
      ),
    );
    assert.equal(fail.code, ERR_PROJECT_VERSION_RELEASED_LOCKED);
    assert.equal(attributions(feature), 0, "released 门 ⇒ 零落库");

    // 匿名档：`owner_group IS NULL` 命中 released 行 ⇒ 走**门**码（若用 `=` 会读成「不存在」⇒ 错码变 unknown）
    markProjectReleased(dbPath, [[null, "flow", "0.1.0"]]);
    fail = mustFail(
      applyFeatureAttributions(
        { featureId: anonymous, projectVersions: [{ projectId: "flow", projectVersion: "0.1.0" }] },
        null,
      ),
    );
    assert.equal(fail.code, ERR_PROJECT_VERSION_RELEASED_LOCKED, "匿名档 NULL-safe IS 必须命中 released 行");

    // 对照：open 行放行
    reopenDefault(dbPath);
    mustOk(
      applyFeatureAttributions(
        { featureId: feature, projectVersions: [{ projectId: "orch", projectVersion: "0.1.0" }] },
        "g1",
      ),
    );
    close();
    assert.equal(attributions(feature), 1, "open 版本行 ⇒ 归属放行");
  } finally {
    rmDb(dbPath);
    process.env["SESSION_DB"] = ":memory:";
    close();
  }
});

// ---------------------------------------------------------------------------
// 3 (d)：不变式继承判据（已存在则继承、不做前瞻）
// ---------------------------------------------------------------------------

test("O2 (d) 继承判据：同 (组, 组版号, project) 已有他人承诺 ⇒ 必须同值；跨组版号 / 无承诺 ⇒ 不约束", () => {
  const dbPath = tmpDbPath("inheritance");
  try {
    bootstrap(dbPath);
    seedGroup(dbPath, [
      ["g1", "1.0.0"],
      ["g1", "2.0.0"],
    ]);
    seedProject(dbPath, [
      ["g1", "orch", "0.1.0"],
      ["g1", "orch", "0.2.0"],
      ["g1", "board", "0.1.0"],
    ]);

    const first = approvedFeature(dbPath, "g1", "1.0.0", "主轨A");
    const second = approvedFeature(dbPath, "g1", "1.0.0", "主轨B（同版同 project）");
    const otherVersion = approvedFeature(dbPath, "g1", "2.0.0", "另一组版号");

    // 先落一条承诺（自选 0.1.0 —— 无既有承诺 ⇒ 不受约束，「不做前瞻」的反面）
    reopenDefault(dbPath);
    mustOk(
      applyFeatureAttributions(
        { featureId: first, projectVersions: [{ projectId: "orch", projectVersion: "0.1.0" }] },
        "g1",
      ),
    );
    close();

    // 同 Group Version + 同 project ⇒ 异值被挡
    let fail = mustFail(
      applyFeatureAttributions(
        { featureId: second, projectVersions: [{ projectId: "orch", projectVersion: "0.2.0" }] },
        "g1",
      ),
    );
    assert.equal(fail.code, ERR_ATTRIBUTION_CONFLICT, "C-2 不变式：已存在则继承");
    assert.ok(fail.error.includes("0.1.0"), "文案须指名被继承的既有承诺");
    assert.equal(attributions(second), 0, "拒绝 ⇒ 零落库");

    // 同值 ⇒ 放行（继承成功）
    reopenDefault(dbPath);
    mustOk(
      applyFeatureAttributions(
        { featureId: second, projectVersions: [{ projectId: "orch", projectVersion: "0.1.0" }] },
        "g1",
      ),
    );
    close();
    assert.equal(attributions(second), 1);

    // **不同 Group Version 的同 project 不受该不变式约束**（承诺集按 (组, 组版号, project) 归并）
    reopenDefault(dbPath);
    mustOk(
      applyFeatureAttributions(
        { featureId: otherVersion, projectVersions: [{ projectId: "orch", projectVersion: "0.2.0" }] },
        "g1",
      ),
    );
    close();
    assert.equal(attributions(otherVersion), 1, "跨 Group Version ⇒ 另起承诺，不自选继承");

    // 无父主轨（parent_feature_id 为空）不受「必须继承父轨」的额外约束 —— 判据只读已存在承诺
    reopenDefault(dbPath);
    assert.equal(getFeature(otherVersion)?.parentFeatureId, null, "前提：无父主轨");
    const mustTrack = approvedFeature(dbPath, "g1", "1.0.0", "增补轨");
    close();
    fail = mustFail(
      applyFeatureAttributions(
        { featureId: mustTrack, projectVersions: [{ projectId: "orch", projectVersion: "0.2.0" }] },
        "g1",
      ),
    );
    assert.equal(fail.code, ERR_ATTRIBUTION_CONFLICT, "同轨档：0.1.0 已承诺 ⇒ 仍须继承（无父与否不改变判据）");
  } finally {
    rmDb(dbPath);
    process.env["SESSION_DB"] = ":memory:";
    close();
  }
});

// ---------------------------------------------------------------------------
// 4 (e)：幂等重发 / 异值冲突 / 先删后建 / 单内矛盾 / 空身份
// ---------------------------------------------------------------------------

test("O2 (e) 同值重发零写入、异值冲突拒、改归属走显式先删后建；单内矛盾与空身份先挡", () => {
  const dbPath = tmpDbPath("idempotency");
  try {
    bootstrap(dbPath);
    seedGroup(dbPath, [["g1", "1.0.0"]]);
    seedProject(dbPath, [
      ["g1", "orch", "0.1.0"],
      ["g1", "orch", "0.2.0"],
      ["g1", "board", "0.1.0"],
    ]);
    const feature = approvedFeature(dbPath, "g1", "1.0.0", "幂等轨");

    // 首写 ⇒ created
    reopenDefault(dbPath);
    const first = mustOk(
      applyFeatureAttributions(
        {
          featureId: feature,
          projectVersions: [
            { projectId: "orch", projectVersion: "0.1.0" },
            { projectId: "board", projectVersion: "0.1.0" },
          ],
          source: "mcp_advance",
        },
        "g1",
      ),
    );
    close();
    assert.equal(first.created, 2);
    assert.equal(first.noop, 0);
    const createdAt = featureProjectListByFeatureAt(feature, dbPath, "orch").createdAt;
    const sourceAt = featureProjectListByFeatureAt(feature, dbPath, "orch").source;

    // 全量重发同值 ⇒ **零写入**（noop=2、updated_at / created_at / source 逐字不动）
    reopenDefault(dbPath);
    const resend = mustOk(
      applyFeatureAttributions(
        {
          featureId: feature,
          projectVersions: [
            { projectId: "orch", projectVersion: "0.1.0" },
            { projectId: "board", projectVersion: "0.1.0" },
          ],
          source: "board_ui", // 即便来源不同，同值档也必须沿用既有 source ⇒ 零写入
        },
        "g1",
      ),
    );
    close();
    assert.equal(resend.noop, 2, "同值 upsert = no-op（重发不制造活动痕迹）");
    assert.equal(resend.created, 0);
    assert.equal(resend.updated, 0);
    const afterResend = featureProjectListByFeatureAt(feature, dbPath, "orch");
    assert.equal(afterResend.createdAt, createdAt);
    assert.equal(afterResend.source, sourceAt, "同值重发不得改写 source");
    assert.equal(afterResend.updatedAt, createdAt, "同值重发 ⇒ updated_at 不动");

    // 异值 ⇒ 冲突（own row 不动 ⇒ 改归属必须显式两笔）
    let fail = mustFail(
      applyFeatureAttributions(
        { featureId: feature, projectVersions: [{ projectId: "orch", projectVersion: "0.2.0" }] },
        "g1",
      ),
    );
    assert.equal(fail.code, ERR_ATTRIBUTION_CONFLICT);
    assert.equal(featureProjectListByFeatureAt(feature, dbPath, "orch").projectVersion, "0.1.0");
    assert.equal(attributions(feature), 2, "冲突 ⇒ 既不新增也不改写");

    // 显式「先删后建」两笔 ⇒ 成功（留痕 = 新行 created_at 新起）
    reopenDefault(dbPath);
    assert.equal(featureProjectDelete("g1", feature, "orch").deleted, true);
    const moved = mustOk(
      applyFeatureAttributions(
        { featureId: feature, projectVersions: [{ projectId: "orch", projectVersion: "0.2.0" }] },
        "g1",
      ),
    );
    close();
    assert.equal(moved.created, 1, "先删后建 ⇒ 改口成立（不留隐式改口路径）");

    // 单内同 project 异值 ⇒ 矛盾拒（不得「后者覆盖前者」）
    fail = mustFail(
      applyFeatureAttributions(
        {
          featureId: feature,
          projectVersions: [
            { projectId: "board", projectVersion: "0.1.0" },
            { projectId: "orch", projectVersion: "0.1.0" },
            { projectId: "orch", projectVersion: "0.2.0" },
          ],
        },
        "g1",
      ),
    );
    assert.equal(fail.code, ERR_ATTRIBUTION_CONFLICT, "单内自相矛盾");

    // 单内同值重复 ⇒ 去重（只写一行）
    reopenDefault(dbPath);
    const dedup = mustOk(
      applyFeatureAttributions(
        {
          featureId: feature,
          projectVersions: [
            { projectId: "board", projectVersion: "0.1.0" },
            { projectId: "board", projectVersion: "0.1.0" },
          ],
        },
        "g1",
      ),
    );
    close();
    assert.equal(dedup.created + dedup.noop, 1);
    assert.equal(featureProjectListByFeatureAt(feature, dbPath, "board").projectVersion, "0.1.0");

    // 空身份字段 ⇒ invalid_shape（先于任何门判据；空串走到 store 只会抛裸错）
    fail = mustFail(
      applyFeatureAttributions(
        { featureId: feature, projectVersions: [{ projectId: "  ", projectVersion: "0.1.0" }] },
        "g1",
      ),
    );
    assert.equal(fail.code, ERR_PROJECT_VERSION_SHAPE);
  } finally {
    rmDb(dbPath);
    process.env["SESSION_DB"] = ":memory:";
    close();
  }
});

/** 按 (feature, project) 取归属行（测试内直读默认存储的便利封装） */
function featureProjectListByFeatureAt(
  featureId: string,
  dbPath: string,
  projectId: string,
): { createdAt: string; updatedAt: string; source: string | null; projectVersion: string } {
  reopenDefault(dbPath);
  const row = featureProjectListByFeature(featureId).find((r) => r.projectId === projectId);
  close();
  if (row === undefined) throw new Error(`归属行不存在：${featureId} / ${projectId}`);
  return {
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    source: row.source,
    projectVersion: row.projectVersion,
  };
}

// ---------------------------------------------------------------------------
// 5 ★N-8：归属拒 ⇒ 主链零迁移 + 零写入（fail-fast）
// ---------------------------------------------------------------------------

test("O2 ★N-8 fail-fast：归属校验失败 ⇒ Feature 态逐字不变、归属零落库（含批内第 2 条非法 ⇒ 第 1 条不落）", () => {
  const dbPath = tmpDbPath("fail-fast");
  try {
    bootstrap(dbPath);
    seedGroup(dbPath, [["g1", "1.0.0"]]);
    seedProject(dbPath, [["g1", "orch", "0.1.0"]]);
    const feature = approvedFeature(dbPath, "g1", "1.0.0", "fail-fast");

    // ① 混合批次：第 1 条合法（orch@0.1.0）、第 2 条不在台账（ghost@0.1.0）⇒ 整单拒、**一条不落**
    reopenDefault(dbPath);
    const before = getFeature(feature);
    assert.ok(before !== null);
    const fail = mustFail(
      applyFeatureAttributions(
        {
          featureId: feature,
          projectVersions: [
            { projectId: "orch", projectVersion: "0.1.0" },
            { projectId: "ghost", projectVersion: "0.1.0" },
          ],
        },
        "g1",
      ),
    );
    assert.equal(fail.code, ERR_PROJECT_VERSION_UNKNOWN);
    assert.equal(featureProjectListByFeature(feature).length, 0, "拒绝 ⇒ 合法那条也不落（无半摊状态）");
    assert.equal(projectVersionGet("g1", "ghost", "0.1.0"), null, "拒绝 ⇒ 不隐式建版");
    // 主链零迁移 + 登记列零变更
    const after = getFeature(feature);
    assert.equal(after?.state, before!.state, "归属拒 ⇒ state 不变");
    assert.equal(after?.version, before!.version, "归属写不动 features.version");
    assert.equal(after?.approval, before!.approval, "归属写不动 features.approval");
    assert.equal(after?.stage, before!.stage, "归属写不动 features.stage");
    close();

    // ② `check*` 是**纯校验**：同一批合法数据走 check ⇒ 通过但**不写库**
    reopenDefault(dbPath);
    const plan = mustOk(
      checkFeatureAttributionWrites(getFeature(feature)!, [
        { projectId: "orch", projectVersion: "0.1.0" },
      ]),
    );
    assert.equal(plan.entries.length, 1);
    const planned = plan.entries[0];
    assert.ok(planned !== undefined);
    assert.equal(planned.groupVersion, "1.0.0", "groupVersion 由 features.version 派生（入参不带）");
    assert.equal(featureProjectListByFeature(feature).length, 0, "check 自身零写入");
    close();

    // ③ 他组身份 ⇒ 归属校验先挡（fail-closed，不到门判据）
    const crossGroup = mustFail(
      applyFeatureAttributions(
        { featureId: feature, projectVersions: [{ projectId: "orch", projectVersion: "0.1.0" }] },
        "g2",
      ),
    );
    assert.equal(crossGroup.code, "feature_not_owned");
    assert.equal(attributions(feature), 0);
    // 未知 Feature ⇒ feature_not_found（不新建、不猜）
    const missing = mustFail(
      applyFeatureAttributions({ featureId: "no-such", projectVersions: [{ projectId: "orch", projectVersion: "0.1.0" }] }),
    );
    assert.equal(missing.code, "feature_not_found");
  } finally {
    rmDb(dbPath);
    process.env["SESSION_DB"] = ":memory:";
    close();
  }
});

// ---------------------------------------------------------------------------
// 6：`releasable` 计数四态（★全 cancelled 也判 true —— 级联档前提）
// ---------------------------------------------------------------------------

test("O2 releasable：total>0 ∧ completed+cancelled===total（不含 completed>0）；open 含 failed", () => {
  const dbPath = tmpDbPath("releasable");
  try {
    bootstrap(dbPath);
    seedGroup(dbPath, [["g1", "1.0.0"]]);
    seedProject(dbPath, [
      ["g1", "p-none", "0.1.0"],
      ["g1", "p-done", "0.1.0"],
      ["g1", "p-mixed", "0.1.0"],
      ["g1", "p-cancel", "0.1.0"],
      ["g1", "p-open", "0.1.0"],
    ]);

    const mk = (project: string, state: "completed" | "cancelled" | "open") => {
      const id = approvedFeature(dbPath, "g1", "1.0.0", `${project}/${state}`);
      if (state === "completed") toCompleted(dbPath, id, "g1");
      if (state === "cancelled") cancelFeature(dbPath, id, "g1");
      seedAttribution(dbPath, {
        ownerGroup: "g1",
        featureId: id,
        projectId: project,
        projectVersion: "0.1.0",
        groupVersion: "1.0.0",
        source: "test",
      });
      return id;
    };
    mk("p-done", "completed");
    mk("p-mixed", "completed");
    mk("p-mixed", "cancelled");
    mk("p-cancel", "cancelled");
    mk("p-open", "open"); // 停在 executing
    // 同 project 再加一张 `failed`（open 桶含 failed 的口径钉）
    reopenDefault(dbPath);
    const failedCard = mustOk(handleFeatureCreate({ title: "failed 卡", version: "1.0.0" }, "g1"));
    mustOk(handleFeatureApprove({ featureId: failedCard.featureId }, "g1"));
    mustOk(handleFeatureAdvance({ featureId: failedCard.featureId, to: "failed" }, "g1"));
    close();
    seedAttribution(dbPath, {
      ownerGroup: "g1",
      featureId: failedCard.featureId,
      projectId: "p-open",
      projectVersion: "0.1.0",
      groupVersion: "1.0.0",
    });

    const gate = (projectId: string) =>
      evaluateProjectReleaseGate({ ownerGroup: "g1", projectId, projectVersion: "0.1.0" });

    // ① 无归属 ⇒ false（未触达不产生发版事实）
    reopenDefault(dbPath);
    const none = gate("p-none");
    close();
    assert.equal(none.releasable, false);
    assert.equal(none.total, 0);
    assert.ok(none.reason.includes("无归属"));

    // ② 全 completed ⇒ true
    reopenDefault(dbPath);
    const done = gate("p-done");
    close();
    assert.deepEqual(
      [done.releasable, done.total, done.completed, done.cancelled, done.open],
      [true, 1, 1, 0, 0],
    );

    // ③ completed + cancelled ⇒ true
    reopenDefault(dbPath);
    const mixed = gate("p-mixed");
    close();
    assert.deepEqual(
      [mixed.releasable, mixed.total, mixed.completed, mixed.cancelled, mixed.open],
      [true, 2, 1, 1, 0],
    );

    // ④ **全 cancelled ⇒ true**（级联档前提：若此处要求 completed>0，全取消轨的 project 会永久 open）
    reopenDefault(dbPath);
    const allCancelled = gate("p-cancel");
    close();
    assert.equal(allCancelled.releasable, true, "★全 cancelled 的 project 也判 releasable（C-4 级联档）");
    assert.deepEqual([allCancelled.total, allCancelled.completed, allCancelled.cancelled], [1, 0, 1]);
    assert.ok(allCancelled.reason.includes("级联档"), "reason 须点明这是级联档前提");

    // ⑤ 有 open（含 failed）⇒ false，open 计数含 failed
    reopenDefault(dbPath);
    const open = gate("p-open");
    close();
    assert.equal(open.releasable, false);
    assert.deepEqual([open.total, open.completed, open.cancelled, open.open], [2, 0, 0, 2]);
    assert.ok(open.reason.includes("未收口"));

    // ⑥ 出参形状 = 展示字段（**没有 ok / code**）⇒ 不构成发版口、不产拒绝码
    assert.deepEqual(Object.keys(open).sort(), [
      "cancelled",
      "completed",
      "open",
      "reason",
      "releasable",
      "total",
    ]);
  } finally {
    rmDb(dbPath);
    process.env["SESSION_DB"] = ":memory:";
    close();
  }
});

// ---------------------------------------------------------------------------
// 7：双计数不横向相加 / 不相等校验 / 同名版号互不染色（★R2）
// ---------------------------------------------------------------------------

test("O2 双计数：Group 闸挡而 project releasable 放行、两个分母不得相加；同名版号互不染色", () => {
  const dbPath = tmpDbPath("two-tier-counts");
  try {
    bootstrap(dbPath);
    seedGroup(dbPath, [["g1", "1.0.0"]]);
    seedProject(dbPath, [
      ["g1", "orch", "0.1.0"],
      ["g1", "orch", "1.0.0"], // 与 Group 版号**同名**的 project 版本（互不染色）
    ]);

    // A：收口 + 归属 orch@0.1.0；B：过门但停在 executing，**不**归属
    const a = approvedFeature(dbPath, "g1", "1.0.0", "A 收口已归属");
    toCompleted(dbPath, a, "g1");
    seedAttribution(dbPath, {
      ownerGroup: "g1",
      featureId: a,
      projectId: "orch",
      projectVersion: "0.1.0",
      groupVersion: "1.0.0",
    });
    const b = approvedFeature(dbPath, "g1", "1.0.0", "B 未收口未归属");

    reopenDefault(dbPath);
    const projectSide = evaluateProjectReleaseGate({
      ownerGroup: "g1",
      projectId: "orch",
      projectVersion: "0.1.0",
    });
    const groupGate = evaluateReleaseGate({ ownerGroup: "g1", version: "1.0.0" });
    const sameNameProject = evaluateProjectReleaseGate({
      ownerGroup: "g1",
      projectId: "orch",
      projectVersion: "1.0.0",
    });
    close();

    // project 侧：只数**归属到该 project 版本**的卡（= A 一张）⇒ 收口
    assert.deepEqual(
      [projectSide.releasable, projectSide.total, projectSide.completed, projectSide.cancelled],
      [true, 1, 1, 0],
    );
    // Group 侧：数 `features.version = 1.0.0` 的两张（A + B）⇒ 未收口、挡闸
    assert.equal(groupGate.ok, false, "Group 名下仍有 open 卡 ⇒ 挡闸");
    assert.equal((groupGate as FeatureToolFailure).code, "orch_version_not_converged");

    // **两个分母各自派生、不得相等校验**：Group 由 `features.version` 派生（= A + B 两张），
    // project 由归属表派生（= 只 A 一张）⇒ 两个计数**天然不等**，且**任何一侧都不以此拒另一侧**。
    assert.equal(getFeature(b)?.version, "1.0.0");
    assert.equal(featureProjectListByFeature(b).length, 0, "B 无归属 ⇒ 不进 project 计数");
    const groupBucket = aggregateFeaturesByVersion("g1").buckets.find((bk) => bk.version === "1.0.0");
    assert.deepEqual(
      [groupBucket?.counts.total, groupBucket?.counts.completed, groupBucket?.counts.open],
      [2, 1, 1],
      "Group 计数 = 该组版号名下两张",
    );
    assert.notEqual(
      projectSide.total,
      groupBucket?.counts.total,
      "★双计数不横向相加 / 不相等校验：两个分母不同是**正常形态**，不得要求相等",
    );

    // **同名版号互不染色**：project 台账 orch@1.0.0 无归属 ⇒ false，与 Group 1.0.0 有卡无关
    assert.equal(sameNameProject.releasable, false);
    assert.equal(sameNameProject.total, 0);
  } finally {
    rmDb(dbPath);
    process.env["SESSION_DB"] = ":memory:";
    close();
  }
});

// ---------------------------------------------------------------------------
// 8：O2 边界钉 —— Group 闸判据不变、归属写不动 features / 不动排期锁
// ---------------------------------------------------------------------------

test("O2 边界钉：Group 闸仍挡全 cancelled（判据未被本节点放宽）；归属写不碰 features 任何列", () => {
  const dbPath = tmpDbPath("group-gate-untouched");
  try {
    bootstrap(dbPath);
    seedGroup(dbPath, [["g1", "7.0.0"]]);
    seedProject(dbPath, [["g1", "orch", "0.1.0"]]);

    // Group 名下唯一一张卡被 cancel ⇒ Group 闸 `orch_version_all_cancelled`（§8「无交付不得 released」不变）
    const only = approvedFeature(dbPath, "g1", "7.0.0", "唯一卡");
    cancelFeature(dbPath, only, "g1");
    reopenDefault(dbPath);
    const groupGate = evaluateReleaseGate({ ownerGroup: "g1", version: "7.0.0" });
    assert.equal(groupGate.ok, false, "Group 闸判据不变：全 cancelled ⇒ 挡");
    assert.equal((groupGate as FeatureToolFailure).code, "orch_version_all_cancelled");
    const before = getFeature(only)!;
    close();

    // 归属写在 `cancelled` 卡上被挡（(a)），且**不改** features 任何列（不动排期锁 / 登记字段）
    const fail = mustFail(
      applyFeatureAttributions(
        { featureId: only, projectVersions: [{ projectId: "orch", projectVersion: "0.1.0" }] },
        "g1",
      ),
    );
    assert.equal(fail.code, ERR_ATTRIBUTION_STATE_LOCKED);
    reopenDefault(dbPath);
    const after = getFeature(only)!;
    close();
    assert.equal(after.state, before.state);
    assert.equal(after.version, before.version);
    assert.equal(after.approval, before.approval);
    assert.equal(after.stage, before.stage);
    assert.equal(after.updatedAt, before.updatedAt, "归属写 ⇒ features.updated_at 不动（零碰 features 表）");
  } finally {
    rmDb(dbPath);
    process.env["SESSION_DB"] = ":memory:";
    close();
  }
});
