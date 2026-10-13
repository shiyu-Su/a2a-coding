/**
 * v0.10.0 **F1**（缺陷修复 · 版本台账 `owner_group` 写口缺失）——
 * `POST /api/versions` 建版时**归属不落库**（恒 `NULL`）⇒ 该行的 `(owner_group, version)` 键
 * 永远匹配不上后续写口的**精确匹配**校验 ⇒ 「先经板/宿主建版号」这条路走不通
 * （建带 `version` 的卡 / `advance` 补挂 version / 板侧排期改版全被 `orch_version_unknown` 拒）。
 *
 * 锁定的行为面：
 * 1. **归属三源解析**：body `ownerGroup`（既有 camelCase 契约）/ body `owner_group`（板与宿主实际
 *    发出的写法）/ 查询参数 `?owner_group=` —— 任一路子都**真落库**（经 store 读回，不只看 201 回显，
 *    回显是内存构造的 record，证明不了 INSERT）；
 * 2. **建后即被引用**（缺陷的验收面）：用 snake_case 建出的版号，随后带 `version` 的 `advance`
 *    登记写**不再被 `orch_version_unknown` 拒**；未建版号同写仍被拒（反证，判据没被放宽）；
 * 3. **缺省仍落匿名档**（§2.1(2)「不猜默认组」契约不变，只加 warn）；空串视同未提供
 *    （`owner_group = ""` 的行既不命中身份档也不命中匿名档 ⇒ 垃圾行）；非字符串 ⇒ 400；
 * 4. **`PATCH …/status` 同族写法**（≤3 行同口径修复）；
 * 5. **不改校验匹配语义**：`owner_group` 仍精确匹配 ⇒ 同版号各组独立、重复 ⇒ 409（message 报**真**
 *    归属，不再报 NULL）、存量行不受影响。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  close,
  ERR_VERSION_EXISTS,
  getFeature,
  SessionStore,
  versionLedgerGet,
  versionLedgerList,
} from "../session/store.js";
import { handleFeatureAdvance, handleFeatureCreate } from "../bridge/feature-tools.js";
import type { FeatureToolFailure } from "../bridge/feature-tools.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import {
  ERR_VERSIONS_BAD_REQUEST,
  VERSIONS_COLLECTION_PATH,
  createVersionsEndpoints,
} from "../bridge/versions-endpoints.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const transports: HttpTransportHandle[] = [];

after(async () => {
  for (const transport of transports) await transport.close();
  resetToMemory();
  close();
});

function resetToMemory(): void {
  process.env["SESSION_DB"] = ":memory:";
  close();
}

/** 内核桩：本测试只触达 `/api/versions*`，MCP 面一律抛错 */
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

async function startHarness(): Promise<number> {
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
  });
  transports.push(transport);
  return transport.port;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown> | null;
  text: string;
}

async function request(port: number, method: string, path: string, body?: unknown): Promise<HttpResult> {
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

function errorCode(res: HttpResult): string | undefined {
  return (res.body?.["error"] as { code?: string } | undefined)?.code;
}

/** 真回读落库列（`versionLedgerGet` = `SELECT … WHERE owner_group IS ? AND version = ?`） */
function readBack(ownerGroup: string | null, version: string): string | undefined {
  return versionLedgerGet(ownerGroup, version)?.ownerGroup ?? undefined;
}

function mustOkFeatureCreate(args: Parameters<typeof handleFeatureCreate>[0], identity: string): string {
  const out = handleFeatureCreate(args, identity);
  if (!out.ok) throw new Error(`create 应放行，实际被拒：${out.code} ${out.error}`);
  return out.featureId;
}

function failure(out: ReturnType<typeof handleFeatureAdvance>): FeatureToolFailure {
  if (out.ok) throw new Error("期望被拒，实际放行");
  return out;
}

// ---------------------------------------------------------------------------
// 1：归属三源都真落库
// ---------------------------------------------------------------------------

test("F1 建版：body owner_group（snake_case）⇒ 201 且落库列 = 该组（含匿名档不得有行）", async () => {
  resetToMemory();
  const port = await startHarness();

  const created = await request(port, "POST", VERSIONS_COLLECTION_PATH, {
    owner_group: "a2a-coding",
    version: "0.10.1",
  });
  assert.equal(created.status, 201, `建版应 201（实际 ${created.status} ${created.text}）`);
  assert.equal((created.body?.["version"] as Record<string, unknown>)["ownerGroup"], "a2a-coding");

  assert.equal(readBack("a2a-coding", "0.10.1"), "a2a-coding", "落库列必须是该组（真回读，非回显）");
  assert.equal(versionLedgerGet(null, "0.10.1"), null, "不得再落匿名档 NULL");
  assert.deepEqual(
    versionLedgerList("a2a-coding").map((r) => r.version),
    ["0.10.1"],
  );

  // 读投影（GET 走同一张表）按组可读到这行
  const scoped = await request(port, "GET", `${VERSIONS_COLLECTION_PATH}?owner_group=a2a-coding`);
  assert.equal((scoped.body?.["versions"] as unknown[]).length, 1, "板读投影按组应命中");
});

test("F1 建版：查询参数 ?owner_group= 同样落库（与 GET / DELETE 同写法）", async () => {
  resetToMemory();
  const port = await startHarness();

  const created = await request(
    port,
    "POST",
    `${VERSIONS_COLLECTION_PATH}?owner_group=g9`,
    { version: "1.1.0" },
  );
  assert.equal(created.status, 201, `建版应 201（实际 ${created.status} ${created.text}）`);
  assert.equal(readBack("g9", "1.1.0"), "g9");
  assert.equal(versionLedgerGet(null, "1.1.0"), null);
});

test("F1 建版：body ownerGroup（camelCase 既有契约）不回归；body 优先于查询参数", async () => {
  resetToMemory();
  const port = await startHarness();

  const camel = await request(port, "POST", VERSIONS_COLLECTION_PATH, {
    ownerGroup: "g8",
    version: "2.0.0",
  });
  assert.equal(camel.status, 201);
  assert.equal(readBack("g8", "2.0.0"), "g8");

  const both = await request(
    port,
    "POST",
    `${VERSIONS_COLLECTION_PATH}?owner_group=fromQuery`,
    { ownerGroup: "fromBody", version: "2.1.0" },
  );
  assert.equal(both.status, 201);
  assert.equal(readBack("fromBody", "2.1.0"), "fromBody", "body 写法优先于查询参数");
});

// ---------------------------------------------------------------------------
// 2：建后即被校验接受（缺陷的验收判据）
// ---------------------------------------------------------------------------

test("F1 建后即被引用：snake_case 建的版号，带 version 的 advance 登记写不再被 orch_version_unknown 拒", async () => {
  resetToMemory();
  const port = await startHarness();

  const created = await request(port, "POST", VERSIONS_COLLECTION_PATH, {
    owner_group: "a2a-coding",
    version: "0.10.1",
  });
  assert.equal(created.status, 201);

  const featureId = mustOkFeatureCreate({ title: "F1 排期卡" }, "a2a-coding");
  const advanced = handleFeatureAdvance(
    { featureId, to: "waiting_approval", version: "0.10.1" },
    "a2a-coding",
  );
  if (!advanced.ok) throw new Error(`advance 写 version 应放行，实际 ${advanced.code} ${advanced.error}`);
  assert.equal(getFeature(featureId)?.version, "0.10.1", "排期写须落库");

  // 反证：校验语义未放宽 —— 未登记的版号同写仍被拒
  const miss = failure(
    handleFeatureAdvance({ featureId, to: "waiting_approval", version: "9.9.9" }, "a2a-coding"),
  );
  assert.equal(miss.code, "orch_version_unknown", "未登记版号仍须被挡（精确匹配语义不变）");
});

test("F1 建后即被引用：带 version 建卡（create 路径）同享新登记的版号", async () => {
  resetToMemory();
  const port = await startHarness();
  await request(port, "POST", VERSIONS_COLLECTION_PATH, { owner_group: "a2a-coding", version: "0.10.2" });

  const featureId = mustOkFeatureCreate(
    { title: "F1 建卡即带版号", version: "0.10.2" },
    "a2a-coding",
  );
  assert.equal(getFeature(featureId)?.version, "0.10.2");
});

// ---------------------------------------------------------------------------
// 3：缺省 / 非法归属（契约与边界）
// ---------------------------------------------------------------------------

test("F1 缺省 owner_group ⇒ 仍落匿名档 NULL（不猜默认组，契约不变）；空串视同未提供", async () => {
  resetToMemory();
  const port = await startHarness();

  const bare = await request(port, "POST", VERSIONS_COLLECTION_PATH, { version: "3.0.0" });
  assert.equal(bare.status, 201, `未带归属应照旧建匿名档 201（实际 ${bare.status} ${bare.text}）`);
  assert.ok(versionLedgerGet(null, "3.0.0") !== null, "缺省 = 匿名档（行为不变，另落 warn 留痕）");

  const empty = await request(port, "POST", VERSIONS_COLLECTION_PATH, {
    owner_group: "",
    version: "3.1.0",
  });
  assert.equal(empty.status, 201);
  assert.ok(versionLedgerGet(null, "3.1.0") !== null, "空串视同未提供 ⇒ 不得造出 owner_group 为空串的垃圾行");
  assert.equal(versionLedgerList().filter((r) => r.ownerGroup === "").length, 0);

  const explicitNull = await request(port, "POST", VERSIONS_COLLECTION_PATH, {
    owner_group: null,
    version: "3.2.0",
  });
  assert.equal(explicitNull.status, 201);
  assert.ok(versionLedgerGet(null, "3.2.0") !== null, "显式 null = 指名匿名档");
});

test("F1 归属类型非法 ⇒ 400 orch_versions_bad_request（零写入）", async () => {
  resetToMemory();
  const port = await startHarness();

  for (const bad of [42, true, { a: 1 }]) {
    const res = await request(port, "POST", VERSIONS_COLLECTION_PATH, {
      owner_group: bad,
      version: "4.0.0",
    });
    assert.equal(res.status, 400, `owner_group=${JSON.stringify(bad)} 应 400（实际 ${res.status}）`);
    assert.equal(errorCode(res), ERR_VERSIONS_BAD_REQUEST);
  }
  assert.equal(versionLedgerList().length, 0, "被拒的建版不得留下任何行");
});

// ---------------------------------------------------------------------------
// 4：PATCH 设状态同族写法 + 校验语义不变（回归）
// ---------------------------------------------------------------------------

test("F1 PATCH 设状态同样接受 owner_group（snake_case / 查询参数）", async () => {
  resetToMemory();
  const port = await startHarness();
  await request(port, "POST", VERSIONS_COLLECTION_PATH, { owner_group: "a2a-coding", version: "5.0.0" });

  const byBody = await request(port, "PATCH", `${VERSIONS_COLLECTION_PATH}/5.0.0/status`, {
    owner_group: "a2a-coding",
    status: "active",
  });
  assert.equal(byBody.status, 200, `设状态应 200（实际 ${byBody.status} ${byBody.text}）`);
  assert.equal(versionLedgerGet("a2a-coding", "5.0.0")?.status, "active");

  await request(port, "POST", `${VERSIONS_COLLECTION_PATH}?owner_group=g7`, { version: "5.1.0" });
  const byQuery = await request(
    port,
    "PATCH",
    `${VERSIONS_COLLECTION_PATH}/5.1.0/status?owner_group=g7`,
    { status: "active" },
  );
  assert.equal(byQuery.status, 200, `查询参数归属设状态应 200（实际 ${byQuery.status} ${byQuery.text}）`);
  assert.equal(versionLedgerGet("g7", "5.1.0")?.status, "active");

  // 归属精确匹配未放宽：拿别组身份设状态 ⇒ 404（不是误改本组行）
  const wrong = await request(port, "PATCH", `${VERSIONS_COLLECTION_PATH}/5.0.0/status`, {
    owner_group: "other",
    status: "active",
  });
  assert.equal(wrong.status, 404);
});

test("F1 校验语义不变：同版号各组独立、重复 ⇒ 409 且 message 报真归属、存量行不受影响", async () => {
  resetToMemory();
  const port = await startHarness();

  // 判据 3 的回归面：先有两行存量（一 camelCase、一 store 直写）
  const g1 = await request(port, "POST", VERSIONS_COLLECTION_PATH, { ownerGroup: "g1", version: "1.0.0" });
  assert.equal(g1.status, 201);
  const coding = await request(port, "POST", VERSIONS_COLLECTION_PATH, {
    owner_group: "a2a-coding",
    version: "0.10.0",
  });
  assert.equal(coding.status, 201);
  const seeded = versionLedgerList().map((r) => `${r.ownerGroup}/${r.version}`);
  assert.deepEqual(seeded, ["a2a-coding/0.10.0", "g1/1.0.0"]);

  // 同名版号在他组可独立建（精确匹配，不落 NULL）
  const other = await request(port, "POST", VERSIONS_COLLECTION_PATH, {
    owner_group: "g2",
    version: "1.0.0",
  });
  assert.equal(other.status, 201);
  assert.equal(readBack("g2", "1.0.0"), "g2");

  // 重复 ⇒ 409，且 message 报**真**归属（缺陷现场报的是 NULL）
  const dup = await request(port, "POST", VERSIONS_COLLECTION_PATH, {
    owner_group: "a2a-coding",
    version: "0.10.0",
  });
  assert.equal(dup.status, 409);
  assert.equal(errorCode(dup), ERR_VERSION_EXISTS);
  assert.match(String((dup.body?.["error"] as { message?: string })?.message), /owner_group="a2a-coding"/);

  assert.equal(versionLedgerGet("g1", "1.0.0")?.status, "notstart", "存量行不受影响");
  assert.equal(versionLedgerGet("a2a-coding", "0.10.0")?.status, "notstart", "存量行不受影响");
  assert.equal(versionLedgerList().length, 3, "除新建的 g2 行外不得多出任何行");
});

test("F1 落库面直证：新实例 store 的 INSERT 带 owner_group（读回列 = 入参，无归一）", () => {
  const store = new SessionStore(":memory:");
  try {
    const outcome = store.versionLedgerCreate({ ownerGroup: "a2a-coding", version: "0.10.1" });
    if (!outcome.ok) throw new Error(`建版失败：${outcome.code} ${outcome.message}`);
    const row = store.versionLedgerGet("a2a-coding", "0.10.1");
    assert.equal(row?.ownerGroup, "a2a-coding");
    assert.equal(store.versionLedgerGet(null, "0.10.1"), null);
  } finally {
    store.close();
  }
});
