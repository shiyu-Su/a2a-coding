/**
 * v0.10.1 **O7**（REQ-2026-10-09-01 · 改造文档 §2 C-19 / §3 orch 段「feature 侧归属只读面」）
 * —— `a2a_feature_status` 的**归属（承诺集）只读面两处**。
 *
 * 锁定的行为面（节点验收判据逐条）：
 * ① **详情路径**出参含 `projects`，内容 = 该需求触达的 project 与其 **Project Version**
 *    （键名与 MCP 写面入参 `projectVersions[]` 单条对齐 ⇒ 读回可原样重发）；
 * ② **列表路径**为**单条 SQL**：归属查询语句恒 1 条，且整次列表读的语句总数**不随 Feature 数
 *    增长**（防 1+N 回归，照 v0.9.0 B3″ `stateCounts` 先例）；
 * ③ **无归属的需求 ⇒ 空数组** —— 详情键恒在、列表 map 里每个列出的 Feature 都有键，不报错、不省略；
 * ④ 既有出参面**只增不改**（`feature` / `tasks` / `artifacts` / `acceptance` / `features[].stateCounts`
 *    与 `test/v090-o2-read-plane.test.ts` 的口径继续成立，本文件只钉新增面与视野同源）。
 *
 * 另钉两条边界：**归属谓词与 `listFeatures` 同源**（他组 Feature 不进 map、组视野不放行 ⇒ 不冒归属）、
 * **详情面与列表面同值**（同一需求两个出口读的是同一批行）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ERR_PROJECT_VERSION_EXISTS,
  ERR_VERSION_EXISTS,
  featureProjectDelete,
  featureProjectListByFeature,
  featureProjectUpsert,
  getDefaultStore,
  projectVersionCreate,
  versionLedgerCreate,
} from "../session/store.js";
import {
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCreate,
  handleFeatureStatus,
  type FeatureStatusSuccess,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";

const GROUP = "g-o7";
const OTHER = "g-o7-other";

function mustOk<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) {
    const f = outcome as unknown as { code?: string; error?: string; message?: string };
    throw new Error(`期望成功，实际失败：${f.code} ${f.error ?? f.message}`);
  }
  return outcome as Extract<T, { ok: true }>;
}

function mustSucceed(outcome: FeatureStatusSuccess | FeatureToolFailure): FeatureStatusSuccess {
  if (!outcome.ok) throw new Error(`feature_status 失败：${outcome.code} ${outcome.error}`);
  return outcome;
}

/** 组台账灌版号（`handleFeatureCreate` 带 `version` 需版号已登记；已存在 ⇒ 幂等放行） */
function seedGroupVersion(group: string, version: string): void {
  const out = versionLedgerCreate({ ownerGroup: group, version });
  if (!out.ok && out.code !== ERR_VERSION_EXISTS) mustOk(out);
}

/** project 台账灌版本行（建版走显式写口 ⇒ 缺省 `open`；已存在 ⇒ 幂等放行） */
function seedProjectVersion(group: string, projectId: string, version: string): void {
  const out = projectVersionCreate({ ownerGroup: group, projectId, version });
  if (!out.ok && out.code !== ERR_PROJECT_VERSION_EXISTS) mustOk(out);
}

let seq = 0;
function nextTitle(tag: string): string {
  seq += 1;
  return `o7-${tag}-${seq}`;
}

/** 跳板归属的身份（只服务过格 ⇒ 落库后立即经 store 数据面删除，不进任何读面断言） */
const GATE_PROJECT = "o5-gate";
const GATE_PROJECT_VERSION = "9.9.9";

/**
 * 抬 `stage` 那一单携带的产出物登记夹具 —— 门① 第二前提（增补 `bbc7ea28` O3）要《需求确认单》、
 * 门② 的 ⑥（增补 `ec93e1bd`）要《改造文档》。两枚必须**同单在册**：`decisions` 是整值替换，
 * 过门时按当场值逐枚查 ⇒ 只登记其一不放行。
 */
const CONFIRMATION_DECISIONS = '["doc/v0.10.1/夹具-需求确认单.md","doc/v0.10.1/夹具-改造文档.md"]';

/**
 * 一张已过门的卡（`executing` + `已通过`，归属集为空）。
 *
 * **v0.10.5 O5 过门序列（新契约定稿，写死照用）**：`create`（**不传** `stage` / `approval` ⇒ 初值恒定
 * `需求分析` / `未发起`）→ `advance(to=当前态, version=<非空>)` →
 * `advance(to=当前态, stage="改造方案", approval="待审批")` → `approve` ⇒ `version_planning`；
 * 再借一枚跳板归属跨 O4 的**归属门双挂**两格出口（`version_planning → decomposing → executing`）、
 * 过完即删 —— 本文件测的是读面，「无归属」档必须真的是零行。
 */
function approvedFeature(group: string, version: string, tag = "main"): string {
  const featureId = mustOk(
    handleFeatureCreate({ title: nextTitle(tag), version }, group),
  ).featureId;
  mustOk(handleFeatureAdvance({ featureId, to: "waiting_approval", version }, group));
  mustOk(
    handleFeatureAdvance(
      {
        featureId,
        to: "waiting_approval",
        stage: "改造方案",
        approval: "待审批",
        decisions: CONFIRMATION_DECISIONS,
      },
      group,
    ),
  );
  mustOk(handleFeatureApprove({ featureId }, group));
  mustOk(
    featureProjectUpsert({
      ownerGroup: group,
      featureId,
      projectId: GATE_PROJECT,
      projectVersion: GATE_PROJECT_VERSION,
      groupVersion: version,
      source: "o5-gate",
    }),
  );
  mustOk(handleFeatureAdvance({ featureId, to: "decomposing" }, group));
  mustOk(handleFeatureAdvance({ featureId, to: "executing" }, group));
  assert.equal(featureProjectDelete(group, featureId, GATE_PROJECT).deleted, true);
  return featureId;
}

/** 过门 + 落全量归属 */
function attributedFeature(
  group: string,
  version: string,
  projectVersions: Array<{ projectId: string; version: string }>,
  tag = "attr",
): string {
  const featureId = approvedFeature(group, version, tag);
  mustOk(handleFeatureAdvance({ featureId, to: "executing", projectVersions }, group));
  return featureId;
}

// ---------------------------------------------------------------------------
// 捕获 store 的 SQL 语句（② 的机械核验面：私有 `db` 只在运行期可见）
// ---------------------------------------------------------------------------

interface PrepareLike {
  prepare(sql: string): unknown;
}

/** 包住默认存储的 `prepare`，收集本次调用内实际执行的 SQL 文本 */
function captureSql<T>(fn: () => T): { result: T; sqls: string[] } {
  const db = (getDefaultStore() as unknown as { db: PrepareLike }).db;
  const sqls: string[] = [];
  const original = db.prepare;
  Object.defineProperty(db, "prepare", {
    configurable: true,
    writable: true,
    value: (sql: string) => {
      sqls.push(sql);
      return original.call(db, sql);
    },
  });
  try {
    return { result: fn(), sqls };
  } finally {
    delete (db as unknown as Record<string, unknown>)["prepare"];
  }
}

/** 其中打到 `feature_projects`（归属表）的语句条数 */
function attributionSqlCount(sqls: readonly string[]): number {
  return sqls.filter((sql) => sql.includes("feature_projects")).length;
}

// ---------------------------------------------------------------------------
// ① 详情路径：projects 出参且内容正确
// ---------------------------------------------------------------------------

test("① 详情路径 projects = 触达的 project 与其 Project Version（键名与写面入参对齐）", () => {
  const version = "0.10.1-r10";
  seedGroupVersion(GROUP, version);
  seedProjectVersion(GROUP, "orch", "0.10.1");
  seedProjectVersion(GROUP, "board", "0.3.0");
  const featureId = attributedFeature(GROUP, version, [
    { projectId: "board", version: "0.3.0" },
    { projectId: "orch", version: "0.10.1" },
  ]);

  const detail = mustSucceed(handleFeatureStatus({ featureId }, GROUP));
  assert.deepEqual(
    detail.projects,
    [
      { projectId: "board", version: "0.3.0" },
      { projectId: "orch", version: "0.10.1" },
    ],
    "projects 内容 = 归属行，按 projectId 字典序",
  );
  // 出参里的 version 是 **Project Version**，不得被 Group Version 染色
  assert.equal(detail.projects?.[1]?.version, "0.10.1", "取 project 台账的号，不是 Group Version");
  // 与 store 读口同值（只读面不另起一套事实源）
  assert.equal(featureProjectListByFeature(featureId).length, 2, "归属表确为两行");
  // 既有面不受影响（只增不改）
  assert.equal(detail.feature?.featureId, featureId);
  assert.ok(detail.tasks && detail.artifacts && detail.acceptance, "既有四块出参恒在");
  assert.equal(detail.attributionsByFeature, undefined, "批量 map 只属列表路径，详情路径不带");
});

test("① 详情路径投影形状 = 单条 {projectId, version}（不带 groupVersion / source / 时间戳）", () => {
  const version = "0.10.1-r11";
  seedGroupVersion(GROUP, version);
  seedProjectVersion(GROUP, "flow", "0.10.1");
  const featureId = attributedFeature(GROUP, version, [{ projectId: "flow", version: "0.10.1" }]);

  const detail = mustSucceed(handleFeatureStatus({ featureId }, GROUP));
  assert.deepEqual(detail.projects, [{ projectId: "flow", version: "0.10.1" }], "投影按用途收窄");
});

// ---------------------------------------------------------------------------
// ③ 无归属 ⇒ 空数组（不报错、不省略键）
// ---------------------------------------------------------------------------

test("③ 无归属的需求 ⇒ 详情 projects = 空数组（键恒在）", () => {
  const version = "0.10.1-r12";
  seedGroupVersion(GROUP, version);
  const featureId = approvedFeature(GROUP, version, "bare");

  const detail = mustSucceed(handleFeatureStatus({ featureId }, GROUP));
  assert.ok("projects" in detail, "详情出参恒带 projects 键");
  assert.deepEqual(detail.projects, [], "未落归属 ⇒ 空数组，不是 undefined / 不是报错");
});

test("③ 无归属的需求 ⇒ 列表 attributionsByFeature 该键 = 空数组（列出的每个 Feature 都有键）", () => {
  const version = "0.10.1-r13";
  seedGroupVersion(GROUP, version);
  seedProjectVersion(GROUP, "machine", "0.9.8");
  const bareId = approvedFeature(GROUP, version, "bare2");
  const withId = attributedFeature(GROUP, version, [{ projectId: "machine", version: "0.9.8" }]);

  const list = mustSucceed(handleFeatureStatus({}, GROUP));
  const map = list.attributionsByFeature;
  assert.ok(map, "列表出参带 attributionsByFeature");
  assert.deepEqual(map?.[bareId], [], "无归属 → 空数组（键不省略）");
  assert.deepEqual(map?.[withId], [{ projectId: "machine", version: "0.9.8" }]);
  // 键集与 features 清单逐一对齐（不多不少 ⇒ 不会「静默漏一个需求」）
  assert.deepEqual(
    Object.keys(map ?? {}).sort(),
    (list.features ?? []).map((f) => f.featureId).sort(),
    "map 键集 = 本次列出的 Feature 集",
  );
});

// ---------------------------------------------------------------------------
// ② 列表路径 = 单条 SQL（查询次数不随 Feature 数增长）
// ---------------------------------------------------------------------------

test("② 列表路径：归属查询恒一条 SQL，整次列表读的语句总数不随 Feature 数增长（防 1+N）", () => {
  const version = "0.10.1-r14";
  seedGroupVersion(GROUP, version);
  seedProjectVersion(GROUP, "orch", "0.10.1");
  seedProjectVersion(GROUP, "board", "0.3.0");

  // 先 3 张带归属的卡（各 2 条）+ 2 张无归属
  let lastAttrId = "";
  for (let i = 0; i < 3; i += 1) {
    lastAttrId = attributedFeature(
      GROUP,
      version,
      [
        { projectId: "orch", version: "0.10.1" },
        { projectId: "board", version: "0.3.0" },
      ],
      `s${i}`,
    );
  }
  for (let i = 0; i < 2; i += 1) approvedFeature(GROUP, version, `sbare${i}`);

  const first = captureSql(() => mustSucceed(handleFeatureStatus({}, GROUP)));
  assert.equal(
    attributionSqlCount(first.sqls),
    1,
    "列表归属 = 一条 SQL（照 B3″ 先例，不得逐 Feature 查）",
  );

  // 再灌 6 张带归属的卡 ⇒ Feature 数与归属行数都翻倍
  for (let i = 0; i < 6; i += 1) {
    attributedFeature(
      GROUP,
      version,
      [
        { projectId: "orch", version: "0.10.1" },
        { projectId: "board", version: "0.3.0" },
      ],
      `g${i}`,
    );
  }
  const second = captureSql(() => mustSucceed(handleFeatureStatus({}, GROUP)));

  assert.equal(attributionSqlCount(second.sqls), 1, "Feature 变多后归属查询仍是一条 SQL");
  assert.equal(
    second.sqls.length,
    first.sqls.length,
    "整次列表读的语句总数不随 Feature 数增长（1+N 回归的机械钉）",
  );
  // 内容侧同步核对：后一次确实多列出了 Feature（否则上面的常数断言是空转），且归属照读
  assert.ok(
    (second.result.features?.length ?? 0) > (first.result.features?.length ?? 0),
    "两次列表读确实跨了规模",
  );
  assert.equal((second.result.attributionsByFeature?.[lastAttrId] ?? []).length, 2);
});

test("② 详情路径同样只发一条归属查询（按 feature_id 定位，不扫全表）", () => {
  const version = "0.10.1-r15";
  seedGroupVersion(GROUP, version);
  seedProjectVersion(GROUP, "orch", "0.10.1");
  const featureId = attributedFeature(GROUP, version, [{ projectId: "orch", version: "0.10.1" }]);

  const cap = captureSql(() => mustSucceed(handleFeatureStatus({ featureId }, GROUP)));
  assert.equal(attributionSqlCount(cap.sqls), 1, "详情路径一条归属 SQL");
  assert.match(cap.sqls.find((sql) => sql.includes("feature_projects")) ?? "", /feature_id = \?/);
});

// ---------------------------------------------------------------------------
// 边界：视野判据与 listFeatures 同源 + 两面同值
// ---------------------------------------------------------------------------

test("边界 归属谓词与列表读同源 ⇒ 他组 Feature 不进 map；无身份（运维视图）⇒ 全量", () => {
  const version = "0.10.1-r16";
  seedGroupVersion(GROUP, version);
  seedGroupVersion(OTHER, version);
  seedProjectVersion(GROUP, "orch", "0.10.1");
  seedProjectVersion(OTHER, "machine", "0.9.8");
  const mineId = attributedFeature(GROUP, version, [{ projectId: "orch", version: "0.10.1" }]);
  const theirsId = attributedFeature(OTHER, version, [{ projectId: "machine", version: "0.9.8" }]);

  const asMine = mustSucceed(handleFeatureStatus({}, GROUP));
  assert.ok(asMine.attributionsByFeature?.[mineId], "本组 Feature 有归属键");
  assert.equal(
    asMine.attributionsByFeature?.[theirsId],
    undefined,
    "他组 Feature 不冒键（视野不外扩）",
  );
  assert.ok(!(theirsId in (asMine.attributionsByFeature ?? {})));

  // 详情路径：他组 Feature 直接不可见（既有 ownershipFailure 判据，不因新字段放宽）
  const asOther = handleFeatureStatus({ featureId: theirsId }, GROUP);
  assert.equal(asOther.ok, false, "他组 Feature 详情仍被归属校验挡住");

  // 无身份 ⇒ 全量视野，两组的归属都读得到
  const asAll = mustSucceed(handleFeatureStatus({}, null));
  assert.deepEqual(asAll.attributionsByFeature?.[mineId], [
    { projectId: "orch", version: "0.10.1" },
  ]);
  assert.deepEqual(asAll.attributionsByFeature?.[theirsId], [
    { projectId: "machine", version: "0.9.8" },
  ]);
});

test("边界 详情面与列表面同值 + 与 store 读口一致（两个出口零第二套事实源）", () => {
  const version = "0.10.1-r17";
  seedGroupVersion(GROUP, version);
  seedProjectVersion(GROUP, "orch", "0.10.1");
  seedProjectVersion(GROUP, "board", "0.3.0");
  const featureId = attributedFeature(GROUP, version, [
    { projectId: "orch", version: "0.10.1" },
    { projectId: "board", version: "0.3.0" },
  ]);

  const detail = mustSucceed(handleFeatureStatus({ featureId }, GROUP));
  const list = mustSucceed(handleFeatureStatus({}, GROUP));
  assert.deepEqual(
    list.attributionsByFeature?.[featureId],
    detail.projects,
    "同一需求两个出口的归属清单逐字同值",
  );

  // 全量重发（同值幂等）后读面不变 —— 重发安全在只读面的表现
  mustOk(
    handleFeatureAdvance(
      {
        featureId,
        to: "executing",
        projectVersions: [
          { projectId: "board", version: "0.3.0" },
          { projectId: "orch", version: "0.10.1" },
        ],
      },
      GROUP,
    ),
  );
  const reread = mustSucceed(handleFeatureStatus({ featureId }, GROUP));
  assert.deepEqual(reread.projects, detail.projects, "同值重发不改只读面");
});
