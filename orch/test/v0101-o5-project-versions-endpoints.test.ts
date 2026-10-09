/**
 * v0.10.1 **O5**（REQ-2026-10-09-01 · 改造文档 §2 C-6 / C-7 / C-13 / §3 orch 段）
 * —— **`/api/project-versions` 三路**（建 / 删 / 只读）+ **`GET /api/versions` 扩顶层字段
 * `projectVersions[]`**。
 *
 * 锁定的行为面（对应节点验收判据 ①–⑤）：
 * 1. **建版**（①）：`201` + 单行（恒 `status = open`）· semver 形状非法 ⇒ `400`
 *    `orch_project_version_invalid_shape` · 同 `(owner_group, project_id, version)` 重复 ⇒ `409`
 *    `orch_project_version_exists` 且**不产生第二行** · 缺 `project_id` ⇒ `400` · 带 `status` 入参
 *    ⇒ `400`（**本口无发版语义**，C-4）；
 * 2. **归属 + 第四源解析**（同族）：body `ownerGroup` / body `owner_group` / 查询参数
 *    `?owner_group=` 三源，`project_id` 走**同一实现**的 body camel / body snake /
 *    查询参数三式；皆缺 ⇒ 匿名档 `NULL`；
 * 3. **删版**（②）：干净行 ⇒ `204` 无体 · 无此行 ⇒ `404` `orch_project_version_unknown` ·
 *    **名下有归属** ⇒ `409` `orch_project_attribution_conflict`（行不动）· **已 `released`**
 *    ⇒ `409` `orch_project_version_released_locked`（发版事实不可撤销）· 撤掉归属后同键即可删；
 * 4. **`versions[]` 逐字段不变**（③ **硬约束**）：扩字段只加**顶层** `projectVersions[]`，
 *    `versions[]` 与 `session/store.ts#versionLedgerList` 的结果**深相等**、且 Group 行
 *    **绝不含 `project_id` 键**（板侧负向钉依赖此）；`count` 仍是 Group 档行数（两档计数不相加）；
 *    `source` **文案**补 project 档说明；无 project 行 ⇒ `[]`（在场无行档，不缺键）；
 * 5. **`projectVersions[]` 每条最小键集**（C-7）：`releasable` **有行时必给布尔**，判据唯一来源
 *    = `evaluateProjectReleaseGate`（本层不重算）；
 * 6. **`?owner_group=` 可选、缺省全表**（④）+ **未配组档不产生重复行**（⑤，NULL-safe `IS`：
 *    同名版号在 `g1` 与匿名档各自独立、彼此不染色）；
 * 7. **路由认领与门闩**：方法不符 ⇒ `405` · 形状不认领（一段 / 三段）⇒ 落根 `404`
 *    （**本档无 `…/status` 设状态口**）· follower ⇒ 写路 `503` `orch_versions_not_owner` 而读路放行。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  close,
  createFeature,
  ERR_PROJECT_VERSION_EXISTS,
  ERR_PROJECT_VERSION_SHAPE,
  ERR_PROJECT_VERSION_UNKNOWN,
  featureProjectDelete,
  featureProjectUpsert,
  projectVersionCreate,
  projectVersionGet,
  projectVersionList,
  updateFeatureState,
  versionLedgerCreate,
  versionLedgerList,
  versionLedgerMarkReleased,
} from "../session/store.js";
import type { FeatureProjectUpsertInput, ProjectVersionCreateInput } from "../session/store.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import {
  ERR_VERSIONS_BAD_REQUEST,
  ERR_VERSIONS_METHOD_NOT_ALLOWED,
  ERR_VERSIONS_NOT_OWNER,
  createVersionsEndpoints,
} from "../bridge/versions-endpoints.js";
import {
  PROJECT_VERSIONS_COLLECTION_PATH,
  createProjectVersionsEndpoints,
} from "../bridge/project-versions-endpoints.js";
import {
  ERR_ATTRIBUTION_CONFLICT,
  ERR_PROJECT_VERSION_RELEASED_LOCKED,
  evaluateProjectReleaseGate,
} from "../bridge/feature-tools.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const transports: HttpTransportHandle[] = [];

after(async () => {
  for (const transport of transports) await transport.close();
  close();
});

/** 内核桩：本测试从不触达 MCP 面（仅 `/api/versions*` 与 `/api/project-versions*`） */
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

/** 挂**两档**端点的桥（Group + project 同端口委托，与 `index.ts` 生产接线同形） */
async function startHarness(role: "owner" | "follower" = "owner"): Promise<number> {
  const transport = await startHttpTransport({
    core: fakeCore(),
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    isReady: () => true,
    role: () => role,
    version: "test",
    onShutdown: () => {
      /* 测试不触发停机 */
    },
    versions: createVersionsEndpoints({ role: () => role }),
    projectVersions: createProjectVersionsEndpoints({ role: () => role }),
  });
  transports.push(transport);
  return transport.port;
}

/**
 * 每个用例起一份**干净的默认存储**（`:memory:` 是进程内单例 ⇒ 不重开则用例间串味）。
 * `close()` 后下一次访问按 `SESSION_DB` 重建 ⇒ 空表。
 */
function fresh(role: "owner" | "follower" = "owner"): Promise<number> {
  process.env["SESSION_DB"] = ":memory:";
  close();
  return startHarness(role);
}

function mustOk(outcome: { ok: boolean; code?: string; message?: string }): void {
  if (!outcome.ok) throw new Error(`期望写成功，实际失败：${outcome.code} ${outcome.message}`);
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
    /* 204 无体 / 非 JSON */
  }
  return { status: res.status, body: parsed, text };
}

/** 失败信封形状：`{ok:false, error:{code,message}}` */
function assertFailure(res: HttpResult, status: number, code: string, note = ""): void {
  const where = note.length > 0 ? `（${note}）` : "";
  assert.equal(res.status, status, `状态码应为 ${status}${where}（实际 ${res.status}：${res.text}）`);
  assert.equal(res.body?.["ok"], false, `信封 ok 应为 false（实际 ${res.text}）`);
  const error = res.body?.["error"] as { code?: string; message?: string } | undefined;
  assert.equal(error?.code, code, `错误码应为 ${code}${where}（实际 ${error?.code}：${res.text}）`);
  assert.equal(typeof error?.message, "string", "信封缺 error.message");
}

function createProjectVersion(input: ProjectVersionCreateInput): void {
  mustOk(projectVersionCreate(input));
}

/** 建一张已 completed 的卡（归属计数的分母），不经 MCP 门（本文件测 HTTP 面，不测 O3 的门） */
function completedFeature(featureId: string, ownerGroup: string | null, groupVersion: string): void {
  const rec = createFeature({ featureId, title: "O5 夹具需求", ownerGroup, version: groupVersion });
  updateFeatureState(rec.featureId, "completed");
}

/** 归属直写 store 口（绕开 O3 的门）；返回入参以便后续撤销 */
function attribute(input: Omit<FeatureProjectUpsertInput, "source">): FeatureProjectUpsertInput {
  const full: FeatureProjectUpsertInput = { ...input, source: "o5-fixture" };
  mustOk(featureProjectUpsert(full));
  return full;
}

function rows(body: HttpResult): Array<Record<string, unknown>> {
  return body.body?.["projectVersions"] as Array<Record<string, unknown>>;
}

/** 出参的 `releasable` / 计数 / `reason` 判据单点（本层不重算 ⇒ 测试直接对照引擎口） */
function expectGate(ownerGroup: string | null, projectId: string, version: string) {
  return evaluateProjectReleaseGate({ ownerGroup, projectId, projectVersion: version });
}

/** 「建版 + 一张 completed 卡 + 一条归属」的最小发版夹具 */
function releaseFixture(ownerGroup: string, projectId: string, version: string): FeatureProjectUpsertInput {
  versionLedgerCreate({ ownerGroup, version, status: "active" });
  createProjectVersion({ ownerGroup, projectId, version });
  completedFeature(`f-${ownerGroup}-${version}`, ownerGroup, version);
  return attribute({
    ownerGroup,
    featureId: `f-${ownerGroup}-${version}`,
    projectId,
    projectVersion: version,
    groupVersion: version,
  });
}

// ---------------------------------------------------------------------------
// 1：建版（验收 ①）—— 201 / 形状 400 / 重复 409
// ---------------------------------------------------------------------------

test("O5 建版：201 + 单行（恒 open）并落库；body camel + snake + query 第四源同族解析", async () => {
  const port = await fresh();
  const res = await request(port, "POST", PROJECT_VERSIONS_COLLECTION_PATH, {
    owner_group: "g1",
    projectId: "orch",
    version: "1.1.0",
    date: "2026-10-09",
    note: "O5 建版",
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body?.["ok"], true);
  const record = res.body?.["projectVersion"] as Record<string, unknown>;
  assert.equal(record["ownerGroup"], "g1");
  assert.equal(record["projectId"], "orch");
  assert.equal(record["version"], "1.1.0");
  assert.equal(record["status"], "open", "建版恒 open（本口无发版语义，C-4）");
  assert.equal(record["date"], "2026-10-09");
  assert.equal(record["note"], "O5 建版");
  assert.equal(projectVersionGet("g1", "orch", "1.1.0")?.status, "open", "已落库");

  // 第四源走查询参数 `?project_id=`（与归属三源同一实现）
  const viaQuery = await request(
    port,
    "POST",
    `${PROJECT_VERSIONS_COLLECTION_PATH}?owner_group=g1&project_id=board`,
    { version: "0.2.0" },
  );
  assert.equal(viaQuery.status, 201, viaQuery.text);
  assert.ok(projectVersionGet("g1", "board", "0.2.0"), "query 第四源已落库");

  // body camel 归属写法同样生效
  const camel = await request(port, "POST", PROJECT_VERSIONS_COLLECTION_PATH, {
    ownerGroup: "g2",
    project_id: "orch",
    version: "1.0.0",
  });
  assert.equal(camel.status, 201, camel.text);
  assert.ok(projectVersionGet("g2", "orch", "1.0.0"), "body camelCase 归属已落库");
});

test("O5 建版判据：semver 形状非法 ⇒ 400 orch_project_version_invalid_shape；同键重复 ⇒ 409 且不产生第二行", async () => {
  const port = await fresh();
  for (const bad of ["1.2", "abc", "1.2.3.4"]) {
    assertFailure(
      await request(port, "POST", PROJECT_VERSIONS_COLLECTION_PATH, {
        owner_group: "g1",
        project_id: "orch",
        version: bad,
      }),
      400,
      ERR_PROJECT_VERSION_SHAPE,
      `非法版号 ${bad}`,
    );
  }
  const first = await request(port, "POST", PROJECT_VERSIONS_COLLECTION_PATH, {
    owner_group: "g1",
    project_id: "orch",
    version: "2.0.0",
  });
  assert.equal(first.status, 201, first.text);
  assertFailure(
    await request(port, "POST", PROJECT_VERSIONS_COLLECTION_PATH, {
      owner_group: "g1",
      project_id: "orch",
      version: "2.0.0",
    }),
    409,
    ERR_PROJECT_VERSION_EXISTS,
  );
  assert.equal(projectVersionList("g1").length, 1, "重复建版不产生第二行");
});

test("O5 建版入参面：缺 project_id ⇒ 400；带 status ⇒ 400；空白 project_id ⇒ 400 形状码 ⇒ 皆零写入", async () => {
  const port = await fresh();
  assertFailure(
    await request(port, "POST", PROJECT_VERSIONS_COLLECTION_PATH, {
      owner_group: "g1",
      version: "1.0.0",
    }),
    400,
    ERR_VERSIONS_BAD_REQUEST,
  );
  assertFailure(
    await request(port, "POST", PROJECT_VERSIONS_COLLECTION_PATH, {
      owner_group: "g1",
      project_id: "orch",
      version: "1.0.0",
      status: "released",
    }),
    400,
    ERR_VERSIONS_BAD_REQUEST,
    "本口无发版语义 ⇒ status 不是入参",
  );
  assertFailure(
    await request(port, "POST", PROJECT_VERSIONS_COLLECTION_PATH, {
      owner_group: "g1",
      project_id: "   ",
      version: "1.0.0",
    }),
    400,
    ERR_PROJECT_VERSION_SHAPE,
  );
  assertFailure(
    await request(port, "POST", PROJECT_VERSIONS_COLLECTION_PATH, {
      owner_group: 7,
      project_id: "orch",
      version: "1.0.0",
    }),
    400,
    ERR_VERSIONS_BAD_REQUEST,
    "归属类型非法 ⇒ invalid 分支",
  );
  assert.equal(projectVersionList().length, 0, "四次被拒 ⇒ 零写入");
});

// ---------------------------------------------------------------------------
// 2：删版（验收 ②）—— 204 / 404 / 有归属拒 / released 拒
// ---------------------------------------------------------------------------

test("O5 删版：干净行 ⇒ 204 无体；再删 ⇒ 404 orch_project_version_unknown（不是 500）", async () => {
  const port = await fresh();
  createProjectVersion({ ownerGroup: "g1", projectId: "orch", version: "1.0.0" });

  const del = await request(
    port,
    "DELETE",
    `${PROJECT_VERSIONS_COLLECTION_PATH}/orch/1.0.0?owner_group=g1`,
  );
  assert.equal(del.status, 204, del.text);
  assert.equal(del.text, "", "204 无体");
  assert.equal(projectVersionGet("g1", "orch", "1.0.0"), null, "行已删");

  assertFailure(
    await request(port, "DELETE", `${PROJECT_VERSIONS_COLLECTION_PATH}/orch/1.0.0?owner_group=g1`),
    404,
    ERR_PROJECT_VERSION_UNKNOWN,
  );
});

test("O5 删版拒：名下有归属 ⇒ 409 orch_project_attribution_conflict，行不动（C-6 ③）", async () => {
  const port = await fresh();
  releaseFixture("g1", "orch", "1.0.0");

  assertFailure(
    await request(port, "DELETE", `${PROJECT_VERSIONS_COLLECTION_PATH}/orch/1.0.0?owner_group=g1`),
    409,
    ERR_ATTRIBUTION_CONFLICT,
  );
  assert.ok(projectVersionGet("g1", "orch", "1.0.0"), "被拒 ⇒ 行仍在");
});

test("O5 删版拒：已 released ⇒ 409 orch_project_version_released_locked（O4 级联置入后冻结，C-6 ④）", async () => {
  const port = await fresh();
  releaseFixture("g1", "orch", "1.0.0");
  mustOk(versionLedgerMarkReleased({ ownerGroup: "g1", version: "1.0.0" }));
  assert.equal(
    projectVersionGet("g1", "orch", "1.0.0")?.status,
    "released",
    "前置：O4 级联已置 released",
  );

  assertFailure(
    await request(port, "DELETE", `${PROJECT_VERSIONS_COLLECTION_PATH}/orch/1.0.0?owner_group=g1`),
    409,
    ERR_PROJECT_VERSION_RELEASED_LOCKED,
  );
  assert.equal(projectVersionGet("g1", "orch", "1.0.0")?.status, "released", "发版事实不可撤销");
});

test("O5 删版可撤销性：归属撤干净 ⇒ 同键即可删（拒因消失而非粘性）", async () => {
  const port = await fresh();
  const attribution = releaseFixture("g1", "orch", "3.0.0");
  assertFailure(
    await request(port, "DELETE", `${PROJECT_VERSIONS_COLLECTION_PATH}/orch/3.0.0?owner_group=g1`),
    409,
    ERR_ATTRIBUTION_CONFLICT,
  );
  assert.ok(
    featureProjectDelete(
      attribution.ownerGroup,
      attribution.featureId,
      attribution.projectId,
    ).deleted,
    "前置：归属已撤",
  );
  assert.equal(
    (
      await request(port, "DELETE", `${PROJECT_VERSIONS_COLLECTION_PATH}/orch/3.0.0?owner_group=g1`)
    ).status,
    204,
    "无归属 ⇒ 可删",
  );
});

// ---------------------------------------------------------------------------
// 3：GET /api/project-versions（验收 ④⑤）—— 可选过滤、缺省全表、匿名档不重复
// ---------------------------------------------------------------------------

test("O5 GET：?owner_group= 可选、缺省全表；未配组（NULL）档不产生重复行、与具名档互不染色", async () => {
  const port = await fresh();
  createProjectVersion({ ownerGroup: "g1", projectId: "orch", version: "1.0.0" });
  createProjectVersion({ ownerGroup: "g1", projectId: "board", version: "0.5.0" });
  createProjectVersion({ ownerGroup: null, projectId: "orch", version: "1.0.0" }); // 同名版号 + 同 project
  assert.equal(projectVersionList().length, 3, "前置：三行（NULL-safe 键 ⇒ 匿名档与 g1 各自独立）");

  const all = rows(await request(port, "GET", PROJECT_VERSIONS_COLLECTION_PATH));
  assert.equal(all.length, 3, "缺省 ⇒ 全表");
  assert.equal(new Set(all.map((r) => `${r.owner_group}|${r.project_id}|${r.version}`)).size, 3, "无重复行");
  assert.equal(all.filter((r) => r["owner_group"] === null).length, 1, "匿名档恰一行 ⇒ 不被 g1 染色");

  const onlyG1 = rows(
    await request(port, "GET", `${PROJECT_VERSIONS_COLLECTION_PATH}?owner_group=g1`),
  );
  assert.equal(onlyG1.length, 2, "?owner_group=g1 ⇒ 收窄到本组");
  assert.ok(onlyG1.every((r) => r["owner_group"] === "g1"));

  const byProject = rows(
    await request(port, "GET", `${PROJECT_VERSIONS_COLLECTION_PATH}?project_id=orch`),
  );
  assert.equal(byProject.length, 2, "?project_id= 收窄（跨 owner_group）");
  assert.ok(byProject.every((r) => r["project_id"] === "orch"));
});

test("O5 GET：每条含最小键集，releasable 有行时必给布尔且 = evaluateProjectReleaseGate（本层不重算）", async () => {
  const port = await fresh();
  releaseFixture("g1", "orch", "1.0.0"); // 有归属且已收口
  createProjectVersion({ ownerGroup: "g1", projectId: "board", version: "1.0.0" }); // 无归属
  const all = rows(await request(port, "GET", `${PROJECT_VERSIONS_COLLECTION_PATH}?owner_group=g1`));
  assert.equal(all.length, 2);
  for (const row of all) {
    for (const key of [
      "owner_group",
      "project_id",
      "version",
      "status",
      "releasable",
      "open_count",
      "completed_count",
      "cancelled_count",
      "reason",
    ]) {
      assert.ok(key in row, `最小键集缺 ${key}（实际 ${JSON.stringify(row)}）`);
    }
    assert.equal(typeof row["releasable"], "boolean", "releasable 有行时必给布尔");
    assert.equal(typeof row["reason"], "string");
  }
  const gate = evaluateProjectReleaseGate({
    ownerGroup: "g1",
    projectId: "orch",
    projectVersion: "1.0.0",
  });
  const orch = all.find((r) => r["project_id"] === "orch");
  assert.equal(orch?.["releasable"], gate.releasable, "与判据单点一致");
  assert.equal(orch?.["completed_count"], 1);
  const board = all.find((r) => r["project_id"] === "board");
  assert.equal(board?.["releasable"], false, "无归属 ⇒ 未触达");
  assert.match(String(board?.["reason"]), /无归属/);
});

// ---------------------------------------------------------------------------
// 4：GET /api/versions 扩字段（验收 ③ —— 硬约束：versions[] 逐字段不变）
// ---------------------------------------------------------------------------

test("O5 扩字段：GET /api/versions 出 projectVersions[]，且 versions[] 与 store 结果深相等、Group 行无 project_id 键", async () => {
  const port = await fresh();
  versionLedgerCreate({ ownerGroup: "g1", version: "1.0.0", status: "active" });
  versionLedgerCreate({ ownerGroup: "g1", version: "2.0.0" });
  createProjectVersion({ ownerGroup: "g1", projectId: "orch", version: "1.0.0" });

  const res = await request(port, "GET", "/api/versions");
  assert.equal(res.status, 200, res.text);
  const body = res.body as Record<string, unknown>;
  assert.ok(Array.isArray(body["projectVersions"]), "顶层键 projectVersions[] 已出");
  assert.deepEqual(body["versions"], versionLedgerList(), "versions[] 逐字段不变（深相等）");
  assert.equal(body["count"], 2, "count 仍是 Group 档行数（两档计数不相加）");
  for (const groupRow of body["versions"] as unknown[]) {
    assert.ok(!("project_id" in (groupRow as object)), "Group 行绝不带 project_id（板的负向钉）");
  }
  const gate = expectGate("g1", "orch", "1.0.0");
  assert.deepEqual(
    rows(res),
    [
      {
        owner_group: "g1",
        project_id: "orch",
        version: "1.0.0",
        status: "open",
        releasable: gate.releasable,
        open_count: gate.open,
        completed_count: gate.completed,
        cancelled_count: gate.cancelled,
        reason: gate.reason,
      },
    ],
    "projectVersions[] 条目 = project 台账行 + 判据单点结果（逐字段）",
  );
  assert.match(String(body["source"]), /project/, "source 文案补 project 档说明");
});

test("O5 扩字段向后兼容：无 project 行 ⇒ projectVersions[] = 空数组（在场无行档），Group 面照常", async () => {
  const port = await fresh();
  versionLedgerCreate({ ownerGroup: "g1", version: "1.0.0" });
  const res = await request(port, "GET", "/api/versions");
  assert.deepEqual(res.body?.["projectVersions"], [], "在场无行 ⇒ 空数组（不是缺键）");
  assert.equal((res.body?.["versions"] as unknown[]).length, 1);
});

test("O5 扩字段跟随过滤：?owner_group= 两档同收窄；缺省两档皆全表", async () => {
  const port = await fresh();
  versionLedgerCreate({ ownerGroup: "g1", version: "1.0.0" });
  versionLedgerCreate({ ownerGroup: "g2", version: "1.0.0" });
  createProjectVersion({ ownerGroup: "g1", projectId: "orch", version: "1.0.0" });
  createProjectVersion({ ownerGroup: "g2", projectId: "orch", version: "1.0.0" });
  createProjectVersion({ ownerGroup: null, projectId: "orch", version: "1.0.0" });

  const narrowed = await request(port, "GET", "/api/versions?owner_group=g1");
  assert.equal((narrowed.body?.["versions"] as unknown[]).length, 1);
  const narrowedRows = rows(narrowed);
  assert.equal(narrowedRows.length, 1, "?owner_group= 同样收窄 project 档");
  assert.equal(narrowedRows[0]?.["owner_group"], "g1");

  const wide = await request(port, "GET", "/api/versions");
  assert.equal((wide.body?.["versions"] as unknown[]).length, 2, "缺省 ⇒ Group 档全表");
  assert.equal(rows(wide).length, 3, "缺省 ⇒ project 档全表（向后兼容）");
});

// ---------------------------------------------------------------------------
// 5：路由认领 / 方法门 / owner 门闩
// ---------------------------------------------------------------------------

test("O5 路由：集合路径非 GET/POST ⇒ 405；单行路径非 DELETE ⇒ 405；一段 / 三段不认领 ⇒ 404", async () => {
  const port = await fresh();
  assertFailure(await request(port, "PUT", PROJECT_VERSIONS_COLLECTION_PATH), 405, ERR_VERSIONS_METHOD_NOT_ALLOWED);
  assertFailure(await request(port, "PATCH", PROJECT_VERSIONS_COLLECTION_PATH), 405, ERR_VERSIONS_METHOD_NOT_ALLOWED);
  assertFailure(
    await request(port, "GET", `${PROJECT_VERSIONS_COLLECTION_PATH}/orch/1.0.0`),
    405,
    ERR_VERSIONS_METHOD_NOT_ALLOWED,
  );
  // **无设状态口**（project 侧 released 只经 Group 级联）⇒ `…/status` 三段不认领 ⇒ 落根 404
  const three = await request(
    port,
    "PATCH",
    `${PROJECT_VERSIONS_COLLECTION_PATH}/orch/1.0.0/status`,
    { status: "released" },
  );
  assert.equal(three.status, 404, `三段形状不认领应落 404（实际 ${three.status}：${three.text}）`);
  const one = await request(port, "DELETE", `${PROJECT_VERSIONS_COLLECTION_PATH}/orch`);
  assert.equal(one.status, 404, `一段形状不认领应落 404（实际 ${one.status}：${one.text}）`);
});

test("O5 门闩：follower ⇒ 写路 503 orch_versions_not_owner、读路放行（含 Group 面扩字段）", async () => {
  const port = await fresh("follower");
  assertFailure(
    await request(port, "POST", PROJECT_VERSIONS_COLLECTION_PATH, {
      owner_group: "g1",
      project_id: "orch",
      version: "1.0.0",
    }),
    503,
    ERR_VERSIONS_NOT_OWNER,
  );
  createProjectVersion({ ownerGroup: "g1", projectId: "orch", version: "9.9.9" });
  assertFailure(
    await request(port, "DELETE", `${PROJECT_VERSIONS_COLLECTION_PATH}/orch/9.9.9?owner_group=g1`),
    503,
    ERR_VERSIONS_NOT_OWNER,
  );
  assert.ok(projectVersionGet("g1", "orch", "9.9.9"), "follower 写被拒 ⇒ 行不动");
  assert.equal((await request(port, "GET", PROJECT_VERSIONS_COLLECTION_PATH)).status, 200);
  const groupRead = await request(port, "GET", "/api/versions");
  assert.equal(groupRead.status, 200, groupRead.text);
  assert.ok(Array.isArray(groupRead.body?.["projectVersions"]), "follower 读面照出扩字段");
});

test("O5 收尾：删空后读投影即时回落空数组（不残留陈旧行）", async () => {
  const port = await fresh();
  createProjectVersion({ ownerGroup: "g1", projectId: "orch", version: "1.0.0" });
  assert.equal(rows(await request(port, "GET", "/api/versions")).length, 1);
  const del = await request(
    port,
    "DELETE",
    `${PROJECT_VERSIONS_COLLECTION_PATH}/orch/1.0.0?owner_group=g1`,
  );
  assert.equal(del.status, 204, del.text);
  assert.deepEqual(rows(await request(port, "GET", "/api/versions")), [], "删后读投影即时回落");
});
