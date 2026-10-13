/**
 * v0.10.1 **O8**（REQ-2026-10-09-01 · 改造文档 §2 C-3 / C-4 / C-13 / C-16 / C-21 / §3 orch 段「测试族」/ §4 实现级）
 * —— **跨层测试族 + 只增不改对照的负向钉**。
 *
 * 本文件**不重复** O1–O7 各节点的切片用例（两表 DDL / 门判据 / 级联 SQL / 端点形状 / 3300 投影 /
 * feature 读面各自已有专档），只补那些**切片测不到**的面：
 *
 * 1. **E2E 生命周期链**（§4 实现级「归属写两处 + 级联 + 三处读面同源」）：一张需求卡从
 *    提卡（未过门）→ 两道门 → **过门初版归属** → **执行期增量的全量重发** → 主链收口 →
 *    Group 发版 → **同事务级联** project 版本 `released` → 交付快照新形状回读 →
 *    **引擎三处读面（HTTP `GET /api/versions` / feature 详情 / feature 列表）读到同一批行** →
 *    冻结后再写归属被拒且**主链零迁移**；
 * 2. **五条归属判据在 MCP 出口的补档**（O3 已在该出口钉了 (a) 未过门 / (c) 不隐式建版 /
 *    (e) 异值冲突三档）：本文件补 **(b) released 门 / (d) 不变式继承 / `cancelled` 卡新写 /
 *    空串身份 / 无 Group Version（C-21）**，每档同钉「拒在任何写入之前」；
 * 3. **三条负向钉**（§4 回归级 + C-4 / C-20）：**归属拒 ⇒ 主链零迁移**（逐档）·
 *    **双计数不横向相加**（同一响应内两档计数源独立，撤归属不动 Group 面）·
 *    **同名 Group / Project 版号互不染色**（级联按 `(owner_group, group_version)` 的**触达集**
 *    JOIN，**不按版号字符串匹配**）；另钉 **全 `cancelled` 轨的 project 照级联变 `released`**
 *    （C-4 采纳理由 ②「结构性洞」在级联档下已闭）；
 * 4. **错误码闭集钉**（C-13 ★收敛-3）：project 档码恰为保留的六枚；级联档撤销的
 *    `orch_project_version_not_converged` / `orch_project_version_all_cancelled`
 *    **在任何产码路径中不存在**。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  close,
  createFeature,
  ERR_PROJECT_VERSION_SHAPE,
  featureProjectDelete,
  featureProjectListByFeature,
  featureProjectUpsert,
  getFeature,
  projectVersionCreate,
  projectVersionGet,
  projectVersionList,
  releaseSnapshotGet,
  updateFeatureRegistration,
  updateFeatureState,
  versionLedgerCreate,
  versionLedgerGet,
} from "../session/store.js";
import type { ProjectVersionCreateInput } from "../session/store.js";
import {
  ERR_ATTRIBUTION_CONFLICT,
  ERR_ATTRIBUTION_STATE_LOCKED,
  ERR_PROJECT_VERSION_RELEASED_LOCKED,
  evaluateProjectReleaseGate,
  evaluateReleaseGate,
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCancel,
  handleFeatureCreate,
  handleFeatureStatus,
  type FeatureAdvanceSuccess,
  type FeatureStatusSuccess,
  type FeatureToolFailure,
  type ProjectVersionAdvanceItem,
} from "../bridge/feature-tools.js";
import { markVersionReleased } from "../bridge/versions-release.js";
import { createVersionsEndpoints } from "../bridge/versions-endpoints.js";
import {
  PROJECT_VERSIONS_COLLECTION_PATH,
  createProjectVersionsEndpoints,
} from "../bridge/project-versions-endpoints.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const GROUP = "g-o8";

const transports: HttpTransportHandle[] = [];

after(async () => {
  for (const transport of transports) await transport.close();
  close();
});

/** 内核桩：本文件的 HTTP 面只碰 `/api/versions*` 与 `/api/project-versions*` */
function unused(name: string): never {
  throw new Error(`unused BridgeCore method: ${name}`);
}

function fakeCore(): BridgeCore {
  return {
    projects: async () => unused("projects"),
    tasks: async () => unused("tasks"),
    call: async () => unused("call"),
    registerFeatureNode: () => unused("registerFeatureNode"),
    taskStatus: async () => unused("taskStatus"),
    cancel: async () => unused("cancel"),
    events: () => unused("events"),
    wait: async () => unused("wait"),
    featureCreate: () => unused("featureCreate"),
    featureStatus: () => unused("featureStatus"),
    featureAdvance: () => unused("featureAdvance"),
    featureApprove: () => unused("featureApprove"),
    featureCancel: () => unused("featureCancel"),
    featureTrace: () => unused("featureTrace"),
    configWriteGroup: async () => unused("configWriteGroup"),
    kickScheduler: () => unused("kickScheduler"),
  };
}

/** 每用例一份干净的默认存储（`:memory:` 是进程内单例 ⇒ 必须重开） */
async function fresh(): Promise<number> {
  process.env["SESSION_DB"] = ":memory:";
  close();
  const transport = await startHttpTransport({
    core: fakeCore(),
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    isReady: () => true,
    role: () => "owner",
    version: "test",
    onShutdown: () => {
      /* 测试不触发停机 */
    },
    versions: createVersionsEndpoints({ role: () => "owner" }),
    projectVersions: createProjectVersionsEndpoints({ role: () => "owner" }),
  });
  transports.push(transport);
  return transport.port;
}

function resetMemory(): void {
  process.env["SESSION_DB"] = ":memory:";
  close();
}

interface HttpResult {
  status: number;
  body: Record<string, unknown> | null;
  text: string;
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* 204 无体 */
  }
  return { status: res.status, body: parsed, text };
}

function mustOk<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) {
    const f = outcome as unknown as { code?: string; error?: string; message?: string };
    throw new Error(`期望成功，实际失败：${f.code} ${f.error ?? f.message}`);
  }
  return outcome as Extract<T, { ok: true }>;
}

function mustFail(outcome: { ok: boolean } | FeatureToolFailure): FeatureToolFailure {
  if (outcome.ok) throw new Error("期望被拒，实际成功");
  return outcome as FeatureToolFailure;
}

function mustSucceed(outcome: FeatureStatusSuccess | FeatureToolFailure): FeatureStatusSuccess {
  if (!outcome.ok) throw new Error(`feature_status 失败：${outcome.code} ${outcome.error}`);
  return outcome;
}

/** Group 台账灌版号（`handleFeatureCreate` 带 `version` 需版号已登记） */
function seedGroupVersion(version: string, group = GROUP): void {
  mustOk(versionLedgerCreate({ ownerGroup: group, version, status: "active" }));
}

/** project 台账灌版本行（显式写口 ⇒ 恒 `open`） */
function seedProjectVersion(input: ProjectVersionCreateInput): void {
  mustOk(projectVersionCreate(input));
}

let seq = 0;
function nextTitle(tag: string): string {
  seq += 1;
  return `o8-${tag}-${seq}`;
}

/** 一张提卡即入板、**未过门**的卡（`waiting_approval` + `未发起` = v0.10.5 O4 起的 create 初值） */
function poolFeature(version: string, group = GROUP): string {
  return mustOk(handleFeatureCreate({ title: nextTitle("pool"), version }, group)).featureId;
}

/** 一张已过门（`executing` + `已通过`）的卡（过门序列见下 {@link passGate}） */
function approvedFeature(version: string, group = GROUP): string {
  const featureId = mustOk(handleFeatureCreate({ title: nextTitle("main"), version }, group)).featureId;
  passGate(featureId, group);
  return featureId;
}

/** 跳板归属的身份（只服务过格 ⇒ 落库后立即经数据面删除，不进任何归属计数） */
const GATE_PROJECT = "o5-gate";
const GATE_PROJECT_VERSION = "9.9.9";

/**
 * 抬 `stage` 那一单携带的产出物登记夹具 —— 门① 第二前提（增补 `bbc7ea28` O3）要《需求确认单》、
 * 门② 的 ⑥（增补 `ec93e1bd`）要《改造文档》。两枚必须**同单在册**：`decisions` 是整值替换，
 * 过门时按当场值逐枚查 ⇒ 只登记其一不放行。
 */
const CONFIRMATION_DECISIONS = '["doc/v0.10.1/夹具-需求确认单.md","doc/v0.10.1/夹具-改造文档.md"]';

/**
 * 过门序列（v0.10.5 O5 新契约定稿，写死照用）：
 * `advance(to=当前态, version=<非空>)` → `advance(to=当前态, stage="改造方案", approval="待审批")` →
 * `approve` ⇒ `version_planning`（**create 不传 `stage` / `approval`**，初值恒定「需求分析 / 未发起」）。
 * 随后跨 O4 的**归属门双挂**两格出口落 `executing`：门判据 = 归属非空，而本文件的用例要的是「过门本身
 * 不落归属」（C-3 写点在过门之后）⇒ 借一枚跳板归属过 `version_planning → decomposing → executing`，
 * 过完立即经 store 数据面删除（不经本文件的执法面）。
 * 无 Group Version 的卡（跳板归属无处落 `group_version`）不过格，停在 `version_planning`。
 */
function passGate(featureId: string, group = GROUP): void {
  const feature = getFeature(featureId);
  const groupVersion = feature?.version ?? "";
  if (groupVersion !== "") {
    mustOk(handleFeatureAdvance({ featureId, to: "waiting_approval", version: groupVersion }, group));
  }
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
  if (groupVersion === "") return;
  mustOk(
    featureProjectUpsert({
      ownerGroup: group,
      featureId,
      projectId: GATE_PROJECT,
      projectVersion: GATE_PROJECT_VERSION,
      groupVersion,
      source: "o5-gate",
    }),
  );
  mustOk(handleFeatureAdvance({ featureId, to: "decomposing" }, group));
  mustOk(handleFeatureAdvance({ featureId, to: "executing" }, group));
  assert.equal(featureProjectDelete(group, featureId, GATE_PROJECT).deleted, true);
}

/** 归属写的成功出口（`to` = 当前态 ⇒ 只写归属、不动主链）；期望被拒的用例走 `tryAttribute` */
function attribute(featureId: string, items: ProjectVersionAdvanceItem[], group = GROUP): FeatureAdvanceSuccess {
  return mustOk(tryAttribute(featureId, items, group));
}

/** 归属写的原样出口 —— **不抛**，供负向档断言拒绝码 */
function tryAttribute(
  featureId: string,
  items: ProjectVersionAdvanceItem[],
  group = GROUP,
): FeatureAdvanceSuccess | FeatureToolFailure {
  return handleFeatureAdvance({ featureId, to: "executing", projectVersions: items }, group);
}

/** 显式删归属（store 数据面写口，不经 O2 的门）⇒ 回「本次是否真删了一行」 */
function deleteAttribution(featureId: string, projectId: string): boolean {
  return featureProjectDelete(GROUP, featureId, projectId).deleted;
}

/** 主链收口（`executing → integrating → testing → reviewing → completed`，宿主 advance 逐格） */
function converge(featureId: string, group = GROUP): void {
  for (const to of ["integrating", "testing", "reviewing", "completed"] as const) {
    mustOk(handleFeatureAdvance({ featureId, to }, group));
  }
}

const VIEW_KEYS = [
  "owner_group",
  "project_id",
  "version",
  "status",
  "releasable",
  "open_count",
  "completed_count",
  "cancelled_count",
  "reason",
] as const;

function projectRows(body: HttpResult | null): Array<Record<string, unknown>> {
  return (body?.body?.["projectVersions"] ?? []) as Array<Record<string, unknown>>;
}

function groupRows(body: HttpResult | null): Array<Record<string, unknown>> {
  return (body?.body?.["versions"] ?? []) as Array<Record<string, unknown>>;
}

/** 读投影里按 `(project_id, version)` 取一行 */
function rowOf(rows: Array<Record<string, unknown>>, projectId: string, version: string) {
  const hit = rows.find((r) => r["project_id"] === projectId && r["version"] === version);
  assert.ok(hit, `读投影缺行 ${projectId}@${version}（实际 ${JSON.stringify(rows)}）`);
  return hit;
}

// ---------------------------------------------------------------------------
// 1：E2E 生命周期链 —— 归属两处 → 收口 → Group 发版级联 → 三处读面同源 → 冻结拒写
// ---------------------------------------------------------------------------

test("O8 E2E：一张卡从提卡到发版级联，归属写两处（过门初版 + 执行期增量）后三处读面同源", async () => {
  const port = await fresh();
  const gv = "0.10.1-e2e";
  try {
    seedGroupVersion(gv);
    // project 台账经**显式写口**建四行（orch / board / machine 会被触达，flow 不会）
    for (const [projectId, version, status] of [
      ["orch", "0.1.0", 201],
      ["board", "0.2.0", 201],
      ["machine", "0.9.8", 201],
      ["flow", "0.3.3", 201],
    ] as Array<[string, string, number]>) {
      const res = await request(port, "POST", PROJECT_VERSIONS_COLLECTION_PATH, {
        owner_group: GROUP,
        project_id: projectId,
        version,
      });
      assert.equal(res.status, status, `建 project 版本 ${projectId}@${version}（${res.text}）`);
    }
    assert.equal(projectVersionList(GROUP).length, 4, "四行皆 open（发版前）");

    // ① 提卡即入板 ⇒ 归属写被挡（未过门），主链一格未动
    const featureId = poolFeature(gv);
    const early = mustFail(
      handleFeatureAdvance(
        { featureId, to: "waiting_approval", projectVersions: [{ projectId: "orch", version: "0.1.0" }] },
        GROUP,
      ),
    );
    assert.equal(early.code, ERR_ATTRIBUTION_STATE_LOCKED);
    assert.equal(featureProjectListByFeature(featureId).length, 0, "未过门 ⇒ 归属零落库");

    // ② 过门（两道确认门）⇒ `executing`
    passGate(featureId);
    assert.equal(featureProjectListByFeature(featureId).length, 0, "过门本身不落归属（写点在过门之后）");

    // ③ **第一处写点**：过门同轮的全量归属（初版 = 改造文档 §3.1 触达面）
    const first = attribute(featureId, [
      { projectId: "orch", version: "0.1.0" },
      { projectId: "board", version: "0.2.0" },
    ]);
    assert.deepEqual(first.attribution, { created: 2, updated: 0, noop: 0 });
    assert.equal(first.state, "executing", "归属分支不动主链");

    // ④ **第二处写点**：执行期新增执行节点 ⇒ 同轮**重发全量**（旧两条 noop、新一条 created）
    const second = attribute(featureId, [
      { projectId: "orch", version: "0.1.0" },
      { projectId: "board", version: "0.2.0" },
      { projectId: "machine", version: "0.9.8" },
    ]);
    assert.deepEqual(second.attribution, { created: 1, updated: 0, noop: 2 }, "重发安全（C-3 ★R3）");
    assert.equal(featureProjectListByFeature(featureId).length, 3);

    // ⑤ 主链收口
    converge(featureId);
    assert.equal(versionLedgerGet(GROUP, gv)?.status, "active", "收口不改 Group 台账态");

    // ⑥ **唯一发版动作** = 标 Group `released` ⇒ 同事务级联触达的 project 版本
    const released = mustOk(
      markVersionReleased({
        ownerGroup: GROUP,
        version: gv,
        projects: [
          { projectId: "orch", version: "0.1.0", repoId: "repo-orch", ref: "aaaa111" },
          { projectId: "board", version: "0.2.0", repoId: null, ref: "bbbb222" },
          { projectId: "machine", version: "0.9.8", repoId: "repo-machine", ref: null },
        ],
        note: "O8 E2E 发版",
      }),
    );
    assert.equal(released.statusMigrated, true);
    assert.equal(versionLedgerGet(GROUP, gv)?.status, "released");
    for (const [projectId, version] of [
      ["orch", "0.1.0"],
      ["board", "0.2.0"],
      ["machine", "0.9.8"],
    ] as const) {
      assert.equal(
        projectVersionGet(GROUP, projectId, version)?.status,
        "released",
        `被触达的 ${projectId}@${version} 同事务变 released`,
      );
    }
    assert.equal(projectVersionGet(GROUP, "flow", "0.3.3")?.status, "open", "未触达者不动");
    assert.equal(projectVersionList(GROUP).length, 4, "发版不建版、不删版");

    // 交付快照承载 project 的交付事实（C-5：`{projectId, version, repoId, ref}` 原值回读、不回查注册表）
    const snapshot = releaseSnapshotGet(GROUP, gv);
    assert.deepEqual(
      snapshot?.projects.map((p) => [p.projectId, p.version, p.repoId, p.ref]),
      [
        ["orch", "0.1.0", "repo-orch", "aaaa111"],
        ["board", "0.2.0", null, "bbbb222"],
        ["machine", "0.9.8", "repo-machine", null],
      ],
    );

    // ⑦ **三处读面读到同一批行**（HTTP 扩字段 / feature 详情 / feature 列表）
    const versions = await request(port, "GET", `/api/versions?owner_group=${GROUP}`);
    const view = projectRows(versions);
    assert.deepEqual(
      view.map((r) => [r["project_id"], r["status"]]).sort(),
      [
        ["board", "released"],
        ["flow", "open"],
        ["machine", "released"],
        ["orch", "released"],
      ],
      "读投影与级联结果同值",
    );
    for (const r of view) {
      assert.deepEqual(Object.keys(r).sort(), [...VIEW_KEYS].sort(), "读投影九键形状");
    }
    const detail = mustSucceed(handleFeatureStatus({ featureId }, GROUP));
    assert.deepEqual(
      (detail.projects ?? []).map((p) => [p.projectId, p.version]).sort(),
      [
        ["board", "0.2.0"],
        ["machine", "0.9.8"],
        ["orch", "0.1.0"],
      ],
      "归属不随发版消失（C-16）",
    );
    const list = mustSucceed(handleFeatureStatus({}, GROUP));
    assert.deepEqual(
      list.attributionsByFeature?.[featureId],
      detail.projects,
      "详情面与列表面在发版后仍同值（零第二套事实源）",
    );

    // ⑧ 冻结后（`released` 已置）再写归属 ⇒ 挡，且**主链零迁移**
    const frozen = mustFail(
      handleFeatureAdvance({
        featureId,
        to: "completed",
        projectVersions: [{ projectId: "orch", version: "0.1.0" }],
      }),
    );
    assert.equal(frozen.code, ERR_PROJECT_VERSION_RELEASED_LOCKED);
    assert.equal(getFeature(featureId)?.state, "completed", "★N-8：冻结拒写不动主链");
    assert.equal(featureProjectListByFeature(featureId).length, 3, "拒在写入之前 ⇒ 归属行数不变");
  } finally {
    resetMemory();
  }
});

// ---------------------------------------------------------------------------
// 2：五条归属判据在 MCP 出口的补档（每档同钉「拒在任何写入之前」）
// ---------------------------------------------------------------------------

test("O8 判据 (b) released 门经 MCP 出口：已冻结的 Project Version 不得复用为后续归属目标（C-6 ④ / C-15）", async () => {
  await fresh();
  const gv1 = "0.10.1-rel";
  const gv2 = "0.10.1-rel2";
  try {
    seedGroupVersion(gv1);
    seedProjectVersion({ ownerGroup: GROUP, projectId: "orch", version: "0.1.0" });
    const carrier = approvedFeature(gv1); // 用它把 orch@0.1.0 发出去（级联置 released）
    attribute(carrier, [{ projectId: "orch", version: "0.1.0" }]);
    converge(carrier);
    mustOk(markVersionReleased({ ownerGroup: GROUP, version: gv1, projects: [] }));
    assert.equal(projectVersionGet(GROUP, "orch", "0.1.0")?.status, "released");

    // **另一条需求排到下一列车** ⇒ 仍不得复用已冻结的 Project Version（代行档预检的兜底门）
    seedGroupVersion(gv2);
    const later = approvedFeature(gv2);
    const failure = mustFail(tryAttribute(later, [{ projectId: "orch", version: "0.1.0" }]));
    assert.equal(failure.code, ERR_PROJECT_VERSION_RELEASED_LOCKED);
    assert.equal(featureProjectListByFeature(later).length, 0, "已冻结的号不得复用为归属目标");
    assert.equal(getFeature(later)?.state, "executing", "★N-8：主链一格未动");

    // 抬到未 released 的号即可（C-6 ④「改版须抬至未 released 的号」）
    seedProjectVersion({ ownerGroup: GROUP, projectId: "orch", version: "0.2.0" });
    assert.deepEqual(attribute(later, [{ projectId: "orch", version: "0.2.0" }]).attribution, {
      created: 1,
      updated: 0,
      noop: 0,
    });
  } finally {
    resetMemory();
  }
});

test("O8 判据 (d) 不变式继承经 MCP 出口：同 (组, 组版号, project) 已有承诺 ⇒ 必须同值（C-2）", async () => {
  await fresh();
  const gv = "0.10.1-inherit";
  try {
    seedGroupVersion(gv);
    seedProjectVersion({ ownerGroup: GROUP, projectId: "orch", version: "0.1.0" });
    seedProjectVersion({ ownerGroup: GROUP, projectId: "orch", version: "0.2.0" });
    const first = approvedFeature(gv);
    attribute(first, [{ projectId: "orch", version: "0.1.0" }]);

    const second = approvedFeature(gv);
    const conflict = mustFail(tryAttribute(second, [{ projectId: "orch", version: "0.2.0" }]));
    assert.equal(conflict.code, ERR_ATTRIBUTION_CONFLICT);
    assert.equal(featureProjectListByFeature(second).length, 0, "异值 ⇒ 第二张卡归属零落库");
    assert.equal(getFeature(second)?.state, "executing", "★N-8：主链零迁移");

    // 继承同值 ⇒ 放行（「已存在则继承」，无前瞻）
    assert.deepEqual(attribute(second, [{ projectId: "orch", version: "0.1.0" }]).attribution, {
      created: 1,
      updated: 0,
      noop: 0,
    });
    assert.equal(featureProjectListByFeature(second)[0]?.projectVersion, "0.1.0");
  } finally {
    resetMemory();
  }
});

test("O8 判据 (a) 补档：`cancelled` 卡一律不得新写归属；同值幂等重发也挡（★R3）", async () => {
  await fresh();
  const gv = "0.10.1-cancelled";
  try {
    seedGroupVersion(gv);
    seedProjectVersion({ ownerGroup: GROUP, projectId: "orch", version: "0.1.0" });
    const featureId = approvedFeature(gv);
    attribute(featureId, [{ projectId: "orch", version: "0.1.0" }]); // 过门后的归属留在轨上
    mustOk(handleFeatureCancel({ featureId }, GROUP));

    const failure = mustFail(tryAttribute(featureId, [{ projectId: "orch", version: "0.1.0" }]));
    assert.equal(failure.code, ERR_ATTRIBUTION_STATE_LOCKED);
    assert.equal(featureProjectListByFeature(featureId).length, 1, "已落行不删，但本档一律挡新写");
    assert.equal(getFeature(featureId)?.state, "cancelled");
  } finally {
    resetMemory();
  }
});

test("O8 判据 (0) 空串身份经 MCP 出口：400 形状码且零写入（不落裸错）", async () => {
  await fresh();
  const gv = "0.10.1-blank";
  try {
    seedGroupVersion(gv);
    const featureId = approvedFeature(gv);
    for (const item of [
      { projectId: "  ", version: "0.1.0" },
      { projectId: "orch", version: " " },
    ] as ProjectVersionAdvanceItem[]) {
      const failure = mustFail(tryAttribute(featureId, [item]));
      assert.equal(failure.code, ERR_PROJECT_VERSION_SHAPE, JSON.stringify(item));
    }
    assert.equal(featureProjectListByFeature(featureId).length, 0);
    assert.equal(projectVersionList(GROUP).length, 0, "空串身份不隐式建版");
    assert.equal(getFeature(featureId)?.state, "executing");
  } finally {
    resetMemory();
  }
});

test("O8 判据 (a) 差集档：无 Group Version 的需求落不下归属（C-21「无 Group Version ⇒ 无归属记录」）", async () => {
  await fresh();
  try {
    seedProjectVersion({ ownerGroup: GROUP, projectId: "orch", version: "0.1.0" });
    const featureId = mustOk(handleFeatureCreate({ title: nextTitle("noversion") }, GROUP)).featureId;
    // 无 Group Version ⇒ 走不了门①（`stage` 迁移被 version 守卫挡）；本档只把 `approval` 写足再过审，
    // 卡停在 `version_planning`（跳板归属无处落 `group_version` ⇒ 不过格）——归属写仍须被同一码挡。
    // 「无 version 却已过审」这一形态自增补 `ec93e1bd`（门② 六条的 ③）起**不可由 `approve` 产出**
    // ⇒ 本档要钉的是归属写锁的判据（`version` 为空即挡），改由 store 直写铺出，判据本身不变。
    updateFeatureRegistration(featureId, { approval: "已通过" });
    updateFeatureState(featureId, "version_planning");
    const failure = mustFail(tryAttribute(featureId, [{ projectId: "orch", version: "0.1.0" }]));
    assert.equal(failure.code, ERR_ATTRIBUTION_STATE_LOCKED);
    assert.equal(featureProjectListByFeature(featureId).length, 0);
  } finally {
    resetMemory();
  }
});

// ---------------------------------------------------------------------------
// 3：负向钉 —— 同名版号不染色 + 双计数不相加 + 全 cancelled 轨照级联
// ---------------------------------------------------------------------------

test("O8 负向钉：级联按触达集 JOIN，不按版号字符串匹配 ⇒ 同名 Group / Project 版号互不染色（C-4 / C-20）", async () => {
  const port = await fresh();
  const gv = "9.9.9";
  try {
    seedGroupVersion(gv);
    seedProjectVersion({ ownerGroup: GROUP, projectId: "orch", version: gv }); // 与 Group 版号**同串**
    seedProjectVersion({ ownerGroup: GROUP, projectId: "board", version: gv }); // 同串、**未触达**
    seedProjectVersion({ ownerGroup: GROUP, projectId: "flow", version: "1.0.0" });

    const a = approvedFeature(gv);
    attribute(a, [{ projectId: "orch", version: gv }]);
    converge(a);

    const b = approvedFeature(gv);
    attribute(b, [{ projectId: "flow", version: "1.0.0" }]); // 归属写在 cancel 之前（C-3）
    mustOk(handleFeatureCancel({ featureId: b }, GROUP));

    mustOk(markVersionReleased({ ownerGroup: GROUP, version: gv, projects: [] }));
    assert.equal(
      projectVersionGet(GROUP, "orch", gv)?.status,
      "released",
      "被触达的同名 project 版本级联 released",
    );
    assert.equal(
      projectVersionGet(GROUP, "board", gv)?.status,
      "open",
      "★同名不同触达 ⇒ 不得按版号字符串批量染色",
    );
    assert.equal(projectVersionGet(GROUP, "flow", "1.0.0")?.status, "released");

    // 全 `cancelled` 轨的 project 也级联 released（C-4 采纳理由 ②：结构性洞已闭）+ 判据不作门
    const gate = evaluateProjectReleaseGate({ ownerGroup: GROUP, projectId: "flow", projectVersion: "1.0.0" });
    assert.equal(gate.releasable, true, "flow 名下唯一归属是 cancelled ⇒ 级联档前提判 releasable");
    assert.match(gate.reason, /全 cancelled/);
    assert.equal(projectVersionGet(GROUP, "flow", "1.0.0")?.status, "released", "Group 发版不因它被挡");

    // 读面同形：`versions[]` 只有 Group 行、`projectVersions[]` 逐行按 status 分开
    const body = await request(port, "GET", `/api/versions?owner_group=${GROUP}`);
    assert.deepEqual(
      groupRows(body).map((r) => [r.version, r.status]),
      [[gv, "released"]],
      "Group 档只有一行（project 行不混入）",
    );
    for (const r of groupRows(body)) {
      assert.equal("project_id" in r, false, "Group 行绝不含 project_id 键（板负向钉的前提）");
    }
    assert.deepEqual(
      projectRows(body)
        .map((r) => [r["project_id"], r.version, r.status])
        .sort(),
      [
        ["board", gv, "open"],
        ["flow", "1.0.0", "released"],
        ["orch", gv, "released"],
      ],
    );
  } finally {
    resetMemory();
  }
});

test("O8 负向钉：双计数同一响应内各自派生 —— 撤归属不动 Group 面，两数不得相加 / 相等校验（C-4 ★R2）", async () => {
  const port = await fresh();
  const gv = "7.7.7";
  try {
    seedGroupVersion(gv);
    seedProjectVersion({ ownerGroup: GROUP, projectId: "orch", version: "0.1.0" });
    seedProjectVersion({ ownerGroup: GROUP, projectId: "orch", version: "0.2.0" });
    // A 收口且触达 orch；B 收口但**不**触达任何 project（Group 分母 2、project 分母 1）
    const a = approvedFeature(gv);
    attribute(a, [{ projectId: "orch", version: "0.1.0" }]);
    converge(a);
    const b = createFeature({ featureId: "o8-b-noattr", title: "B 无归属", ownerGroup: GROUP, version: gv });
    updateFeatureState(b.featureId, "completed");

    const before = await request(port, "GET", `/api/versions?owner_group=${GROUP}`);
    const orchRow = rowOf(projectRows(before), "orch", "0.1.0");
    assert.deepEqual(
      [orchRow.releasable, orchRow.completed_count, orchRow.cancelled_count, orchRow.open_count],
      [true, 1, 0, 0],
      "project 计数 = 归属表派生（只 A 一张）",
    );
    const groupBefore = JSON.stringify(groupRows(before));
    assert.equal(before.body?.["count"], 1, "顶层 count 仍是 Group 档行数（不把 project 行加进来）");
    const groupGate = evaluateReleaseGate({ ownerGroup: GROUP, version: gv });
    if (!groupGate.ok) throw new Error(`Group 闸应放行，实际 ${groupGate.code}：${groupGate.error}`);
    assert.equal(groupGate.counts.total, 2, "Group 计数 = `features.version` 派生（A + B 两张）");
    assert.notEqual(
      orchRow.completed_count,
      groupGate.counts.total,
      "★两个分母各自派生、天然不等 ⇒ 不得相加、不得相等校验",
    );

    // 撤归属（异值改写先被 (e) 挡 ⇒ 只能显式删行）⇒ project 侧计数归零、Group 面**逐字不变**
    const oddValue = mustFail(
      handleFeatureAdvance({
        featureId: a,
        to: "completed",
        projectVersions: [{ projectId: "orch", version: "0.2.0" }],
      }),
    );
    assert.equal(oddValue.code, ERR_ATTRIBUTION_CONFLICT, "(e) 异值 ⇒ 整单拒、不隐式改口");
    assert.equal(getFeature(a)?.state, "completed", "★N-8：主链零迁移");
    assert.equal(featureProjectListByFeature(a)[0]?.projectVersion, "0.1.0", "原承诺不动");
    assert.equal(deleteAttribution(a, "orch"), true, "显式删行（撤销承诺的唯一路径）");
    assert.equal(deleteAttribution(a, "orch"), false, "二次删 ⇒ 幂等零副作用");
    const after = await request(port, "GET", `/api/versions?owner_group=${GROUP}`);
    const orchRowAfter = rowOf(projectRows(after), "orch", "0.1.0");
    assert.equal(orchRowAfter.releasable, false, "无归属 ⇒ 未触达（展示字段，不产拒绝码）");
    assert.equal(orchRowAfter.completed_count, 0);
    assert.equal(orchRowAfter.open_count, 0);
    assert.equal(JSON.stringify(groupRows(after)), groupBefore, "★Group 计数源不含归属表 ⇒ 撤归属零影响");
    assert.equal(getFeature(b.featureId)?.version, gv, "features.version 未被归属面反向改写");
  } finally {
    resetMemory();
  }
});

// ---------------------------------------------------------------------------
// 4：错误码闭集钉（C-13 ★收敛-3）
// ---------------------------------------------------------------------------

test("O8 码闭集：project 档保留六枚逐字同值；级联档撤销的两枚不在任何产码路径中（C-13）", () => {
  const retained = new Set([
    ERR_ATTRIBUTION_CONFLICT,
    ERR_ATTRIBUTION_STATE_LOCKED,
    ERR_PROJECT_VERSION_RELEASED_LOCKED,
    ERR_PROJECT_VERSION_SHAPE,
    "orch_project_version_exists",
    "orch_project_version_unknown",
  ]);
  assert.deepEqual(
    [...retained].sort(),
    [
      "orch_project_attribution_conflict",
      "orch_project_attribution_state_locked",
      "orch_project_version_exists",
      "orch_project_version_invalid_shape",
      "orch_project_version_released_locked",
      "orch_project_version_unknown",
    ],
    "闭集 = 改造文档 C-13 保留档（板永不产 `orch_project_attribution_state_locked` ⇒ 无 board_ 前缀）",
  );

  const retired = ["orch_project_version_not_converged", "orch_project_version_all_cancelled"];
  const scanned: string[] = [];
  for (const rel of ["../bridge/", "../session/", "../feature/"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".js")) continue;
      const text = readFileSync(join(dir, name), "utf8");
      for (const code of retired) {
        if (text.includes(code)) scanned.push(`${name} → ${code}`);
      }
    }
  }
  assert.deepEqual(
    scanned,
    [],
    "★撤销档（project 判据降为展示字段）不得留下产码路径（收敛-3）",
  );
});
