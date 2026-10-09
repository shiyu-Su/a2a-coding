/**
 * v0.10.1 **O6**（REQ-2026-10-09-01 · 改造文档 §3 orch 段「3300 project 只读投影」/ §5 T6）
 * —— **3300 只读工作台的 project 级版本只读入口**（`GET /api/project-versions`）。
 *
 * 锁定的行为面：
 * 1. **① 逐字段同源**：3300 的 `projectVersions[]` 与 8787 `GET /api/project-versions`、
 *    8787 `GET /api/versions` 顶层 `projectVersions[]`、以及形状单点 `projectVersionsView()`
 *    **四处 deep-equal**（同源保证 = 同一实现，不是同一份手抄形状）；单条键集钉死为 C-7 的
 *    九个 snake_case 键（多一键 / 少一键皆红）；
 * 2. **② 3300 仍是只读面**：新入口非 GET（POST / PUT / PATCH / DELETE）⇒ **405**
 *    `method_not_allowed`（既有口径不变，不为 project 档开口子）；未注册子路径仍 404；
 * 3. **④ 无任何写行为**：反复读不改 `project_versions` 行数与 `updated_at`、不落新事件行；
 *    读一个不存在的 `project_id` ⇒ `count=0` 且**不隐式建版**；
 * 4. **过滤语义照 8787 同档**：`owner_group` 缺省 / 空串 ⇒ 全表、给定 ⇒ 仅本组
 *    （NULL-safe ⇒ 匿名档与他组不被染色）；`project_id` 可选收窄（精确匹配、不 trim）；
 * 5. **`releasable` 是展示字段、不构成门**：未收口行照常出参（HTTP 200），判据现算
 *    （open 计数 / reason 来自归属表）；
 * 6. **③ 只增不改**：既有 `/api/features-by-version` 出参语义不受影响
 *    （该面的原断言在 `test/web.test.ts` 内原样保留并照常通过）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  close,
  createFeature,
  featureProjectUpsert,
  latestEventId,
  projectVersionCreate,
  projectVersionList,
} from "../session/store.js";
import type { FeatureProjectUpsertResult, ProjectVersionWriteResult } from "../session/store.js";
import { startWebTransport } from "../bridge/transports/web.js";
import type { WebTransportHandle } from "../bridge/transports/web.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import {
  createProjectVersionsEndpoints,
  PROJECT_VERSIONS_COLLECTION_PATH,
} from "../bridge/project-versions-endpoints.js";
import { createVersionsEndpoints, projectVersionsView } from "../bridge/versions-endpoints.js";
import type { ProjectVersionViewEntry } from "../bridge/versions-endpoints.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

/** C-7 单条键集（**逐字钉死**：同源断言之外再加一道形状负向钉） */
const PROJECT_VERSION_ENTRY_KEYS = [
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

const WEB_PATH = "/api/project-versions";

interface ProjectVersionsBody {
  ok: boolean;
  source: string;
  observedAt: string;
  note: string;
  ownerGroup: string | null;
  projectId: string | null;
  count: number;
  projectVersions: ProjectVersionViewEntry[];
}

/** 8787 两个口的出参只吃 `projectVersions` 键，其余形状本节点不依赖 */
interface EngineVersionsBody {
  ok: boolean;
  projectVersions?: ProjectVersionViewEntry[];
}

interface ErrorBody {
  ok: boolean;
  code: string;
  error: string;
}

const webHandles: WebTransportHandle[] = [];
const httpHandles: HttpTransportHandle[] = [];

after(async () => {
  for (const handle of webHandles) await handle.close();
  for (const handle of httpHandles) await handle.close();
  resetStore();
});

function resetStore(): void {
  process.env["SESSION_DB"] = ":memory:";
  close();
}

/** 本测试从不触达 MCP 面（只读投影 + 版本台账两口）⇒ 任何内核方法被调用即红 */
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

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // 非 JSON ⇒ 保留 null，由调用方断言
  }
  return { status: res.status, body };
}

function json<T>(res: { status: number; body: unknown }): T {
  assert.notEqual(res.body, null, "响应体应为 JSON");
  return res.body as T;
}

/** 取数组元素（`noUncheckedIndexedAccess` 下的显式断言） */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  assert.ok(value !== undefined, `list[${index}] 应存在`);
  return value;
}

function mustOkWrite(outcome: ProjectVersionWriteResult): void {
  if (!outcome.ok)
    throw new Error(`期望 project 台账写成功，实际失败：${outcome.code} ${outcome.message}`);
}

function mustOkAttribution(outcome: FeatureProjectUpsertResult): void {
  if (!outcome.ok) throw new Error(`期望归属写成功，实际失败：${outcome.code} ${outcome.message}`);
}

/** 3300 只读接面（本节点主角） */
async function startWeb(): Promise<WebTransportHandle> {
  const outcome = await startWebTransport({
    core: fakeCore(),
    host: "127.0.0.1",
    port: 0,
    version: "0.10.1-test",
  });
  assert.equal(outcome.enabled, true, `期望网页接面启用：${outcome.enabled ? "" : outcome.error}`);
  if (!outcome.enabled) throw new Error("网页接面未启用（不可达）");
  webHandles.push(outcome);
  return outcome;
}

/**
 * 8787 可写面（同源对照的右半）：Group 档 + project 档两口**同时注入**，
 * 于是「3300 / 8787 集合口 / 8787 合并口 / 形状单点函数」四条读路在同一进程、同一库上一次比对。
 */
async function startEngine(): Promise<number> {
  const handle = await startHttpTransport({
    core: fakeCore(),
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    isReady: () => true,
    role: () => "owner",
    version: "0.10.1-test",
    onShutdown: () => {
      /* 测试不触发停机 */
    },
    versions: createVersionsEndpoints({ role: () => "owner" }),
    projectVersions: createProjectVersionsEndpoints({ role: () => "owner" }),
  });
  httpHandles.push(handle);
  return handle.port;
}

// ---------------------------------------------------------------------------
// 数据种子（每组各自命名，避免与同库其它用例串味）
// ---------------------------------------------------------------------------

/**
 * 种下的承诺集（三档，覆盖 `releasable` 的三个可分辨形态）：
 * - `g6 / orch / 0.10.1` ⇒ 名下 1 条 `completed` ⇒ **releasable = true**；
 * - `g6 / board / 0.10.1` ⇒ 名下 1 条 `executing` ⇒ **releasable = false**（未收口，**仍出参**）；
 * - `g6 / flow / 0.10.1` ⇒ **无归属** ⇒ releasable = false（未触达）；
 * - `g6x / orch / 0.10.1` ⇒ 他组同名版号（组隔离钉）；
 * - 匿名档 `null / orch / 0.9.0` ⇒ NULL-safe 钉（不得被 `?owner_group=g6` 吃进、也不得被排除出全表）。
 *
 * 本文件全部用例共用一个进程内 `:memory:` 库 ⇒ **只种一次**（重复建版会 409）。
 */
function seed(): void {
  createFeature({
    featureId: "o6-done",
    title: "O6 done",
    version: "0.10.1",
    state: "completed",
    ownerGroup: "g6",
  });
  createFeature({
    featureId: "o6-open",
    title: "O6 open",
    version: "0.10.1",
    state: "executing",
    ownerGroup: "g6",
  });

  for (const input of [
    { ownerGroup: "g6", projectId: "orch", version: "0.10.1" },
    { ownerGroup: "g6", projectId: "board", version: "0.10.1" },
    { ownerGroup: "g6", projectId: "flow", version: "0.10.1" },
    { ownerGroup: "g6x", projectId: "orch", version: "0.10.1" },
    { ownerGroup: null, projectId: "orch", version: "0.9.0" },
  ] as const) {
    mustOkWrite(projectVersionCreate(input));
  }

  mustOkAttribution(
    featureProjectUpsert({
      ownerGroup: "g6",
      featureId: "o6-done",
      projectId: "orch",
      projectVersion: "0.10.1",
      groupVersion: "0.10.1",
      source: "test",
    }),
  );
  mustOkAttribution(
    featureProjectUpsert({
      ownerGroup: "g6",
      featureId: "o6-open",
      projectId: "board",
      projectVersion: "0.10.1",
      groupVersion: "0.10.1",
      source: "test",
    }),
  );
}

function findRow(
  rows: readonly ProjectVersionViewEntry[],
  ownerGroup: string | null,
  projectId: string,
) {
  const hit = rows.find((r) => r.owner_group === ownerGroup && r.project_id === projectId);
  assert.ok(hit !== undefined, `应有一行 owner_group=${ownerGroup} project_id=${projectId}`);
  return hit;
}

seed(); // 全文件共用一个进程内 `:memory:` 库 ⇒ 只种一次（各用例只起自己的读面）

// ---------------------------------------------------------------------------
// ① 逐字段同源（四处 deep-equal + 键集钉）
// ---------------------------------------------------------------------------

test("GET /api/project-versions（3300）与 8787 两口、projectVersionsView 四处逐字段同源 + 九键形状钉（v0.10.1 O6）", async () => {
  const web = await startWeb();
  const enginePort = await startEngine();

  const webBody = json<ProjectVersionsBody>(await get(web.port, WEB_PATH));
  assert.equal(webBody.ok, true);
  assert.equal(
    webBody.count,
    webBody.projectVersions.length,
    "count = 出实行数（project 档自持，不与 Group 计数相加）",
  );
  assert.match(webBody.source, /project_versions/, "source 须声明事实源 = 引擎 project 台账");
  assert.match(webBody.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  // 同源四处：形状单点函数 / 8787 project 集合口 / 8787 Group 合并口的顶层键
  const viewAll = projectVersionsView();
  const engineCollection = json<EngineVersionsBody>(
    await get(enginePort, PROJECT_VERSIONS_COLLECTION_PATH),
  );
  const engineMerged = json<EngineVersionsBody>(await get(enginePort, "/api/versions"));

  assert.ok(
    engineCollection.projectVersions !== undefined,
    "8787 project 集合口应出 projectVersions 键",
  );
  assert.ok(
    engineMerged.projectVersions !== undefined,
    "8787 GET /api/versions 应出 projectVersions 键",
  );
  assert.deepEqual(
    webBody.projectVersions,
    viewAll,
    "3300 出参 = projectVersionsView() 全表（形状单点，零手写形状）",
  );
  assert.deepEqual(
    webBody.projectVersions,
    engineCollection.projectVersions,
    "3300 出参 = 8787 GET /api/project-versions",
  );
  assert.deepEqual(
    webBody.projectVersions,
    engineMerged.projectVersions,
    "3300 出参 = 8787 GET /api/versions 的 projectVersions[]",
  );

  // 单条键集：多一键 / 少一键 / 改名皆红
  for (const entry of webBody.projectVersions) {
    assert.deepEqual(
      Object.keys(entry).slice().sort(),
      [...PROJECT_VERSION_ENTRY_KEYS].sort(),
      `键集漂移：${JSON.stringify(entry)}`,
    );
  }

  // releasable 现算（展示字段、不是门）：三档可分辨
  const orch = findRow(webBody.projectVersions, "g6", "orch");
  assert.equal(orch.releasable, true, "名下全收口 ⇒ releasable true");
  assert.equal(orch.completed_count, 1);
  assert.equal(orch.open_count, 0);
  const board = findRow(webBody.projectVersions, "g6", "board");
  assert.equal(
    board.releasable,
    false,
    "名下有 open ⇒ releasable false，但**照常出参**（不构成门）",
  );
  assert.equal(board.open_count, 1);
  assert.match(board.reason, /未收口/);
  const flow = findRow(webBody.projectVersions, "g6", "flow");
  assert.equal(flow.releasable, false, "无归属 ⇒ 未触达");
  assert.equal(flow.status, "open", "建版恒 open（project 侧无独立发版口，C-4）");
});

// ---------------------------------------------------------------------------
// 过滤语义（照 8787 同档）
// ---------------------------------------------------------------------------

test("3300 project 投影：owner_group 收窄（NULL-safe 组隔离 + 空串 = 全表）与 project_id 可选收窄（v0.10.1 O6）", async () => {
  const handle = await startWeb();

  const all = json<ProjectVersionsBody>(await get(handle.port, WEB_PATH));
  assert.equal(all.ownerGroup, null, "缺省 ⇒ 全表（3300 = 运维全量视图，非身份面）");
  assert.equal(all.projectId, null);
  assert.equal(all.count, 5);

  // 给定组 ⇒ 仅本组（他组同名版号 + 匿名档都不被吃进）
  const g6 = json<ProjectVersionsBody>(await get(handle.port, `${WEB_PATH}?owner_group=g6`));
  assert.equal(g6.ownerGroup, "g6");
  assert.deepEqual(
    g6.projectVersions.map((r) => `${r.owner_group}/${r.project_id}`).sort(),
    ["g6/board", "g6/flow", "g6/orch"],
    "组隔离：g6x 同名版号与匿名档不得染色",
  );
  assert.deepEqual(g6.projectVersions, projectVersionsView("g6"), "收窄档同样与形状单点同源");

  // 空串 = 缺省（照 8787 readOwnerGroupParam 口径，不落「匿名档专用」这种第二语义）
  const emptyOwner = json<ProjectVersionsBody>(await get(handle.port, `${WEB_PATH}?owner_group=`));
  assert.equal(emptyOwner.ownerGroup, null);
  assert.deepEqual(emptyOwner.projectVersions, all.projectVersions, "owner_group= 空串 ⇒ 全表");

  // project_id 收窄（精确匹配）
  const oneProject = json<ProjectVersionsBody>(
    await get(handle.port, `${WEB_PATH}?project_id=orch`),
  );
  assert.equal(oneProject.projectId, "orch");
  assert.deepEqual(
    oneProject.projectVersions.map((r) => `${r.owner_group}/${r.version}`).sort(),
    ["g6/0.10.1", "g6x/0.10.1", "null/0.9.0"],
    "project_id 收窄跨组（组档未给 ⇒ 全表内筛）",
  );

  // 两参叠加
  const both = json<ProjectVersionsBody>(
    await get(handle.port, `${WEB_PATH}?owner_group=g6&project_id=orch`),
  );
  assert.equal(both.count, 1);
  assert.equal(at(both.projectVersions, 0).project_id, "orch");
});

// ---------------------------------------------------------------------------
// ② 只读契约：非 GET ⇒ 405；未注册子路径 ⇒ 404
// ---------------------------------------------------------------------------

test("3300 project 投影入口非 GET 一律 405（只读面不破）+ 未注册子路径仍 404（v0.10.1 O6）", async () => {
  const handle = await startWeb();

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = await fetch(`http://127.0.0.1:${handle.port}${WEB_PATH}`, { method });
    const text = await res.text();
    assert.equal(res.status, 405, `${method} 应被只读接面挡成 405，实际 ${res.status}：${text}`);
    assert.equal((JSON.parse(text) as ErrorBody).code, "method_not_allowed");
  }

  // 带查询参数的非 GET 同样挡（写意图不因参数而放行）
  const deleteWithQuery = await fetch(
    `http://127.0.0.1:${handle.port}${WEB_PATH}?owner_group=g6&project_id=orch&version=0.10.1`,
    { method: "DELETE" },
  );
  assert.equal(deleteWithQuery.status, 405);
  await deleteWithQuery.text();

  // 新路径不得吞子树（8787 的单行 DELETE 形状在 3300 不存在 ⇒ 404）
  assert.equal((await get(handle.port, `${WEB_PATH}/orch/0.10.1`)).status, 404);
  assert.equal((await get(handle.port, "/api/project-version")).status, 404);
});

// ---------------------------------------------------------------------------
// ④ 零写行为（读面不产生事实）
// ---------------------------------------------------------------------------

test("3300 project 投影只读：反复读零副作用（行数 / updated_at / 事件游标不动、不隐式建版）（v0.10.1 O6）", async () => {
  const handle = await startWeb();

  const before = projectVersionList();
  assert.equal(before.length, 5, "种子行数");
  const eventsBefore = latestEventId();

  const paths = [
    WEB_PATH,
    `${WEB_PATH}?owner_group=g6`,
    `${WEB_PATH}?owner_group=g6&project_id=orch`,
    `${WEB_PATH}?project_id=nope`,
    `${WEB_PATH}?owner_group=g6&version=0.10.1`, // 未认的参数 ⇒ 不参与筛选，也不建行
  ];
  for (const path of paths) {
    for (let i = 0; i < 2; i += 1) {
      const res = json<ProjectVersionsBody>(await get(handle.port, path));
      assert.equal(res.ok, true, `${path} 应 200`);
    }
  }

  // 不存在的 project_id ⇒ 空清单（**不是** 404、也不建行）
  const none = json<ProjectVersionsBody>(await get(handle.port, `${WEB_PATH}?project_id=nope`));
  assert.equal(none.count, 0);
  assert.deepEqual(none.projectVersions, []);

  const after = projectVersionList();
  assert.equal(after.length, before.length, "读面不得建版（行数不变）");
  assert.deepEqual(
    after.map((r) => `${r.ownerGroup}|${r.projectId}|${r.version}|${r.status}|${r.updatedAt}`),
    before.map((r) => `${r.ownerGroup}|${r.projectId}|${r.version}|${r.status}|${r.updatedAt}`),
    "读面不得改态 / 不得刷 updated_at",
  );
  assert.equal(
    latestEventId(),
    eventsBefore,
    "读面不落事件行（与 registry / features-by-version 面同口径）",
  );

  // 台账写口在 3300 不存在：即便带上写意图的参数也只按只读投影回答
  const sameAsPlainGet = json<ProjectVersionsBody>(await get(handle.port, WEB_PATH));
  assert.deepEqual(
    sameAsPlainGet.projectVersions,
    projectVersionsView(),
    "出参恒等于全表投影（幂等读）",
  );
});
