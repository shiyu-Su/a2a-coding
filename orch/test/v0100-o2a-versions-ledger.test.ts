/**
 * v0.10.0 **O1 + O2a**（REQ-v0.10.0-2026-09-24-01 · 改造文档 §2.1(1)(2)(7)）——
 * 版本面两表地基 + 建/删端点 + 一次性迁移。
 *
 * 锁定的行为面：
 * 1. **两表落地**（O1）：`versions`（可编辑台账）/ `releases`（不可变快照）由 ctor `IF NOT EXISTS`
 *    建起 ⇒ 依赖它们的 O4/O5/O7 读口自动激活；快照表**无 status / 无 updated_at**（不可变的 schema 表达）；
 * 2. **建版判据**（O2a）：shape 不过 ⇒ 400 · `released` 不可建 ⇒ 400 · 重复 ⇒ **409 且不产生第二行**
 *    （幂等：PK 含可空列 ⇒ 判重走 get-then-insert，`NULL` 档不得被唯一约束漏掉）；
 * 3. **删版判据**（O2a）：未知 ⇒ 404 · `released` ⇒ 409（发版事实不可撤销）· 名下有未收口卡 ⇒ 409
 *    （`failed` **不算收口**）· 成功 ⇒ 只删台账行、**不碰快照**；
 * 4. **归属分档**：`(owner_group, version)` 是键 ⇒ 同名版号在各组独立（建 / 删 / 计数互不串味）；
 * 5. **HTTP 面**（O2a）：8787 委托路由 —— 统一信封 `{ok, error:{code,message}}`、`201` / `204`、
 *    方法门 ⇒ 405、**O2c 的 `…/status` 不认领 ⇒ 404**（不预占别人路由）、follower ⇒ 写路 503 而读路放行；
 * 6. **一次性迁移**（O1 §2.1(7)）：主源整表照搬（含 `released` 与原始时间戳）· 补集**只补缺行、
 *    不覆盖 status、永不落 `released`** · **另立哨兵**（不复用台账 `exists()`：手工建版会造出行 ⇒ 假绿）·
 *    dry-run 默认零写入 · 可重入。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  close,
  createFeature,
  ERR_VERSION_EXISTS,
  ERR_VERSION_OPEN_CARDS,
  ERR_VERSION_RELEASED_LOCKED,
  ERR_VERSION_SHAPE,
  ERR_VERSION_STATUS,
  ERR_VERSION_UNKNOWN,
  EVENT_VERSION_LEDGER_CREATED,
  EVENT_VERSION_LEDGER_DELETED,
  EVENT_VERSION_LEDGER_MIGRATED,
  openStoreDatabase,
  SessionStore,
  versionLedgerList,
  versionsLedgerMigrationDone,
} from "../session/store.js";
import type { VersionLedgerWriteResult } from "../session/store.js";
import type { FeatureState } from "../types.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import {
  ERR_VERSIONS_BAD_REQUEST,
  ERR_VERSIONS_METHOD_NOT_ALLOWED,
  ERR_VERSIONS_NOT_OWNER,
  VERSIONS_COLLECTION_PATH,
  createVersionsEndpoints,
  type VersionsEndpointOptions,
} from "../bridge/versions-endpoints.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const transports: HttpTransportHandle[] = [];
const tmpDirs: string[] = [];

after(async () => {
  for (const transport of transports) await transport.close();
  for (const path of tmpDirs) rmSync(path, { recursive: true, force: true });
  resetToMemory();
  close();
});

function newStore(): SessionStore {
  return new SessionStore(":memory:");
}

function resetToMemory(): void {
  process.env["SESSION_DB"] = ":memory:";
  close();
}

function tmpDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `a2a-v0100-o2a-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

/** 建在临时文件上的 store（ctor 落表后关闭，便于另开只读句柄做 schema 断言） */
function fileStore(tag: string): { store: SessionStore; dbPath: string } {
  const dbPath = join(tmpDir(tag), "sessions.sqlite");
  return { store: new SessionStore(dbPath), dbPath };
}

function mustOk(outcome: VersionLedgerWriteResult): Extract<VersionLedgerWriteResult, { ok: true }> {
  if (!outcome.ok) throw new Error(`期望写成功，实际失败：${outcome.code} ${outcome.message}`);
  return outcome;
}

function mustFail(
  outcome: VersionLedgerWriteResult,
): Extract<VersionLedgerWriteResult, { ok: false }> {
  if (outcome.ok) throw new Error("期望写被拒，实际成功");
  return outcome;
}

/** 内核桩：本测试从不触达 MCP 面（仅 `/api/versions*`），故所有方法一律抛错 */
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

async function startHarness(overrides: Partial<VersionsEndpointOptions> = {}): Promise<number> {
  const handle = createVersionsEndpoints({ role: () => "owner", ...overrides });
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
    versions: handle,
  });
  transports.push(transport);
  return transport.port;
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

/** 失败信封形状：`{ok:false, error:{code,message}}`（§2.1(2) 统一信封） */
function assertFailureEnvelope(res: HttpResult, code: string): void {
  assert.equal(res.body?.["ok"], false, `信封 ok 应为 false（实际 ${res.text}）`);
  const error = res.body?.["error"] as { code?: string; message?: string } | undefined;
  assert.equal(typeof error?.code, "string", `信封缺 error.code（实际 ${res.text}）`);
  assert.equal(error?.code, code, `错误码应为 ${code}（实际 ${error?.code}）`);
  assert.equal(typeof error?.message, "string", "信封缺 error.message");
}

function cols(dbPath: string, table: string): string[] {
  const db = openStoreDatabase(dbPath);
  try {
    return db
      .prepare("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((r) => String((r as Record<string, unknown>)["name"]));
  } finally {
    db.close();
  }
}

function tableNames(dbPath: string): string[] {
  const db = openStoreDatabase(dbPath);
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String((r as Record<string, unknown>)["name"]));
  } finally {
    db.close();
  }
}

function scalar(dbPath: string, sql: string, ...params: unknown[]): number {
  const db = openStoreDatabase(dbPath);
  try {
    return Number((db.prepare(sql).get(...(params as never[])) as Record<string, unknown>)["n"]);
  } finally {
    db.close();
  }
}

function seedCard(
  store: SessionStore,
  input: {
    featureId: string;
    ownerGroup: string | null;
    version: string;
    state?: FeatureState;
    createdAt?: string;
  },
): void {
  store.createFeature({
    featureId: input.featureId,
    title: `卡 ${input.featureId}`,
    ownerGroup: input.ownerGroup,
    version: input.version,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt, updatedAt: input.createdAt }),
  });
  if (input.state !== undefined) store.updateFeatureState(input.featureId, input.state);
}

function ledgerEventCount(store: SessionStore, kind: string): number {
  return store.listEvents({ limit: 1000 }).filter((e) => e.kind === kind).length;
}

// ---------------------------------------------------------------------------
// 1：O1 两表落地
// ---------------------------------------------------------------------------

test("O1 两表：ctor 建起 versions / releases；快照表无 status / 无 updated_at（不可变的 schema 表达）", () => {
  const { store, dbPath } = fileStore("tables");
  store.close();

  const names = tableNames(dbPath);
  assert.ok(names.includes("versions") && names.includes("releases"), "版本面两表须由 ctor 建起");

  const versionCols = cols(dbPath, "versions");
  for (const need of ["owner_group", "version", "status", "date", "note", "created_at", "updated_at"]) {
    assert.ok(versionCols.includes(need), `versions 缺列 ${need}`);
  }

  const releaseCols = cols(dbPath, "releases");
  for (const need of ["owner_group", "version", "changelog_anchor", "projects_json", "note", "created_at"]) {
    assert.ok(releaseCols.includes(need), `releases 缺列 ${need}`);
  }
  assert.ok(!releaseCols.includes("status"), "releases 不得带 status（三态归台账，C-3 两表分工）");
  assert.ok(!releaseCols.includes("updated_at"), "releases 不得带 updated_at（快照不可变）");
});

test("O1 落表激活下游读口：O5 存在性 / O4 状态读口从 ledgerReady:false 转为执法", () => {
  const store = newStore();
  try {
    mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version: "0.10.0" }));
    assert.deepEqual(store.versionLedgerHas("g1", "0.10.0"), { exists: true, ledgerReady: true });
    assert.deepEqual(store.versionLedgerHas("g1", "9.9.9"), { exists: false, ledgerReady: true });
    assert.deepEqual(store.versionLedgerStatus("g1", "0.10.0"), {
      status: "notstart",
      ledgerReady: true,
    });
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 2：建版判据（store 写口）
// ---------------------------------------------------------------------------

test("O2a 建版：缺省 notstart · 可建 active · released 不可建 400 · 非法 shape 400 · 写口 trim", () => {
  const store = newStore();
  try {
    const plain = mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version: "1.0.0" }));
    assert.equal(plain.record.status, "notstart", "缺省态 = notstart");
    assert.equal(plain.record.createdAt, plain.record.updatedAt, "建行两戳同刻");

    mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version: "1.1.0", status: "active" }));

    const released = mustFail(
      store.versionLedgerCreate({ ownerGroup: "g1", version: "1.2.0", status: "released" }),
    );
    assert.equal(released.code, ERR_VERSION_STATUS);
    assert.equal(released.status, 400);
    assert.equal(store.versionLedgerGet("g1", "1.2.0"), null, "被拒 ⇒ 零写入");

    for (const bad of ["foo", "1.2", "0.10.0.1", "v1", ""]) {
      const fail = mustFail(store.versionLedgerCreate({ ownerGroup: "g1", version: bad }));
      assert.equal(fail.code, ERR_VERSION_SHAPE, `脏版号 ${JSON.stringify(bad)} 应命中 shape 码`);
      assert.equal(fail.status, 400);
    }

    const trimmed = mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version: "  2.0.0  " }));
    assert.equal(trimmed.record.version, "2.0.0", "写口 trim（读侧不归一 = §2.1(4)）");
  } finally {
    store.close();
  }
});

test("O2a 建版幂等：重复建同键 ⇒ 409 且不产生第二行 / 不改第一行 / 不写第二条事件", () => {
  const store = newStore();
  try {
    mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version: "3.0.0", note: "原始备注" }));
    const eventsBefore = ledgerEventCount(store, EVENT_VERSION_LEDGER_CREATED);

    const dup = mustFail(
      store.versionLedgerCreate({ ownerGroup: "g1", version: "3.0.0", note: "改了" }),
    );
    assert.equal(dup.code, ERR_VERSION_EXISTS);
    assert.equal(dup.status, 409);

    assert.equal(store.versionLedgerList("g1").filter((r) => r.version === "3.0.0").length, 1);
    assert.equal(store.versionLedgerGet("g1", "3.0.0")?.note, "原始备注", "重复建版不得改写第一行");
    assert.equal(ledgerEventCount(store, EVENT_VERSION_LEDGER_CREATED), eventsBefore);
  } finally {
    store.close();
  }
});

test("O2a NULL 档判重：匿名档重复必须被挡（PK 含可空列 ⇒ 禁 ON CONFLICT）；同名版号跨组独立", () => {
  const store = newStore();
  try {
    mustOk(store.versionLedgerCreate({ ownerGroup: null, version: "4.0.0" }));
    assert.equal(
      mustFail(store.versionLedgerCreate({ ownerGroup: null, version: "4.0.0" })).code,
      ERR_VERSION_EXISTS,
    );
    assert.equal(store.versionLedgerList(null).length, 1, "匿名档不得静默插出第二行");
    mustOk(store.versionLedgerCreate({ ownerGroup: "g2", version: "4.0.0" }));
    assert.equal(store.versionLedgerGet("g2", "4.0.0")?.ownerGroup, "g2");
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 3：删版判据（store 写口）
// ---------------------------------------------------------------------------

test("O2a 删版：未知 404 · released 409 · 未收口卡 409（failed 不算收口）· 成功只删台账行不碰快照", () => {
  const { store, dbPath } = fileStore("delete");
  try {
    const unknown = mustFail(store.versionLedgerDelete("g1", "9.9.9"));
    assert.equal(unknown.code, ERR_VERSION_UNKNOWN);
    assert.equal(unknown.status, 404);

    mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version: "5.0.0", status: "active" }));
    // 迁 released 走 O7 的同事务写口（本节点不代发快照，只借用它造「已发版」事实）
    const marked = store.versionLedgerMarkReleased({
      ownerGroup: "g1",
      version: "5.0.0",
      projects: [{ repoId: "repo-a", ref: "v5.0.0" }],
    });
    if (!marked.ok) throw new Error(`期望标记 released 成功，实际失败：${marked.code} ${marked.message}`);
    const locked = mustFail(store.versionLedgerDelete("g1", "5.0.0"));
    assert.equal(locked.code, ERR_VERSION_RELEASED_LOCKED);
    assert.equal(locked.status, 409);
    assert.equal(store.versionLedgerGet("g1", "5.0.0")?.status, "released", "被挡 ⇒ 行仍在");

    mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version: "6.0.0" }));
    seedCard(store, { featureId: "f-open", ownerGroup: "g1", version: "6.0.0", state: "executing" });
    assert.equal(
      mustFail(store.versionLedgerDelete("g1", "6.0.0")).code,
      ERR_VERSION_OPEN_CARDS,
    );
    seedCard(store, { featureId: "f-failed", ownerGroup: "g1", version: "6.0.0", state: "failed" });
    assert.equal(
      mustFail(store.versionLedgerDelete("g1", "6.0.0")).code,
      ERR_VERSION_OPEN_CARDS,
      "failed 不算收口（需求流程.md §8）",
    );
    store.updateFeatureState("f-open", "completed");
    store.updateFeatureState("f-failed", "cancelled");
    mustOk(store.versionLedgerDelete("g1", "6.0.0"));
    assert.equal(store.versionLedgerGet("g1", "6.0.0"), null);

    // 只删台账、不碰快照：台账行**故意不迁** released（released 会被上一段的锁挡死删口），
    // 单测「快照非级联面」这一条 ⇒ 快照经裸 INSERT 造出（等价于迁移补登后的历史形态）。
    mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version: "7.0.0" }));
  } finally {
    store.close();
  }
  const db = openStoreDatabase(dbPath);
  try {
    db.prepare(
      "INSERT INTO releases (owner_group, version, note, created_at) VALUES ('g1','7.0.0','手填快照','2026-10-08T00:00:00.000Z')",
    ).run();
  } finally {
    db.close();
  }
  const reopened = new SessionStore(dbPath);
  try {
    mustOk(reopened.versionLedgerDelete("g1", "7.0.0"));
    assert.equal(reopened.versionLedgerGet("g1", "7.0.0"), null);
  } finally {
    reopened.close();
  }
  assert.equal(
    scalar(dbPath, "SELECT COUNT(*) AS n FROM releases WHERE owner_group = 'g1' AND version = '7.0.0'"),
    1,
    "删版不得级联快照",
  );
});

test("O2a 删版归属分档：只删本档一行；收口计数按档（他组在飞卡不得误挡本组删版）", () => {
  const store = newStore();
  try {
    mustOk(store.versionLedgerCreate({ ownerGroup: null, version: "8.0.0" }));
    mustOk(store.versionLedgerCreate({ ownerGroup: "g3", version: "8.0.0" }));
    mustOk(store.versionLedgerDelete(null, "8.0.0"));
    assert.equal(store.versionLedgerGet(null, "8.0.0"), null);
    assert.ok(store.versionLedgerGet("g3", "8.0.0") !== null, "他组同名版号不得被误删");

    seedCard(store, { featureId: "f-other", ownerGroup: "g3", version: "9.0.0", state: "executing" });
    mustOk(store.versionLedgerCreate({ ownerGroup: null, version: "9.0.0" }));
    mustOk(store.versionLedgerDelete(null, "9.0.0"));
  } finally {
    store.close();
  }
});

test("O2a 列表读投影三档过滤 + 建/删事件留痕", () => {
  const store = newStore();
  try {
    mustOk(store.versionLedgerCreate({ ownerGroup: null, version: "1.0.0" }));
    mustOk(store.versionLedgerCreate({ ownerGroup: "ga", version: "2.0.0" }));
    mustOk(store.versionLedgerCreate({ ownerGroup: "gb", version: "3.0.0" }));

    assert.equal(store.versionLedgerList().length, 3, "缺省 ⇒ 全量（运维视图）");
    assert.deepEqual(store.versionLedgerList("ga").map((r) => r.version), ["2.0.0"]);
    assert.deepEqual(store.versionLedgerList(null).map((r) => r.version), ["1.0.0"]);

    mustOk(store.versionLedgerDelete("gb", "3.0.0"));
    assert.equal(ledgerEventCount(store, EVENT_VERSION_LEDGER_CREATED), 3);
    assert.equal(ledgerEventCount(store, EVENT_VERSION_LEDGER_DELETED), 1);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 4：HTTP 面（8787 委托路由）
// ---------------------------------------------------------------------------

test("O2a HTTP 建 / 读 / 重复 / 删全程：201 → 200 → 409 → 204 → 404，信封统一", async () => {
  resetToMemory();
  const port = await startHarness();

  const created = await request(port, "POST", VERSIONS_COLLECTION_PATH, {
    ownerGroup: "g1",
    version: "0.10.0",
    date: "2026-10-08",
    note: "本版",
  });
  assert.equal(created.status, 201, `建版应 201（实际 ${created.status} ${created.text}）`);
  assert.equal(created.body?.["ok"], true);
  const record = created.body?.["version"] as Record<string, unknown>;
  assert.equal(record["version"], "0.10.0");
  assert.equal(record["status"], "notstart");
  assert.equal(record["ownerGroup"], "g1");
  assert.equal(record["date"], "2026-10-08");

  const list = await request(port, "GET", VERSIONS_COLLECTION_PATH);
  assert.equal(list.status, 200);
  assert.equal(list.body?.["ok"], true);
  assert.equal((list.body?.["versions"] as unknown[]).length, 1);
  assert.equal(list.body?.["count"], 1);

  const scoped = await request(port, "GET", `${VERSIONS_COLLECTION_PATH}?owner_group=g9`);
  assert.equal((scoped.body?.["versions"] as unknown[]).length, 0, "他组读不到本组行");

  const dup = await request(port, "POST", VERSIONS_COLLECTION_PATH, {
    ownerGroup: "g1",
    version: "0.10.0",
  });
  assert.equal(dup.status, 409);
  assertFailureEnvelope(dup, ERR_VERSION_EXISTS);

  const removed = await request(port, "DELETE", `${VERSIONS_COLLECTION_PATH}/0.10.0?owner_group=g1`);
  assert.equal(removed.status, 204, `删版应 204 无体（实际 ${removed.status} ${removed.text}）`);
  assert.equal(removed.text, "");

  const again = await request(port, "DELETE", `${VERSIONS_COLLECTION_PATH}/0.10.0?owner_group=g1`);
  assert.equal(again.status, 404);
  assertFailureEnvelope(again, ERR_VERSION_UNKNOWN);
});

test("O2a HTTP 入参判据：released 400 · 缺 version 400 · 类型错 400 · 非 JSON 400 · 未收口卡 409", async () => {
  resetToMemory();
  const port = await startHarness();

  const asReleased = await request(port, "POST", VERSIONS_COLLECTION_PATH, {
    ownerGroup: "g1",
    version: "1.0.0",
    status: "released",
  });
  assert.equal(asReleased.status, 400);
  assertFailureEnvelope(asReleased, ERR_VERSION_STATUS);

  assertFailureEnvelope(
    await request(port, "POST", VERSIONS_COLLECTION_PATH, { ownerGroup: "g1" }),
    ERR_VERSIONS_BAD_REQUEST,
  );
  assertFailureEnvelope(
    await request(port, "POST", VERSIONS_COLLECTION_PATH, { ownerGroup: 42, version: "2.0.0" }),
    ERR_VERSIONS_BAD_REQUEST,
  );

  const notJson = await fetch(`http://127.0.0.1:${port}${VERSIONS_COLLECTION_PATH}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "not-json",
  });
  assert.equal(notJson.status, 400);
  assertFailureEnvelope(
    { status: notJson.status, body: (await notJson.json()) as Record<string, unknown>, text: "" },
    ERR_VERSIONS_BAD_REQUEST,
  );

  // 端点与 store 同进程同实例 ⇒ 经默认存储面建卡制造「未收口」
  await request(port, "POST", VERSIONS_COLLECTION_PATH, { ownerGroup: "g1", version: "3.0.0" });
  createFeature({ featureId: "f-http-open", title: "在飞", ownerGroup: "g1", version: "3.0.0" });
  const blocked = await request(port, "DELETE", `${VERSIONS_COLLECTION_PATH}/3.0.0?owner_group=g1`);
  assert.equal(blocked.status, 409);
  assertFailureEnvelope(blocked, ERR_VERSION_OPEN_CARDS);
});

test("O2a HTTP 方法门 405；O2c 的设状态路由已由 O2c 认领（未知版号 ⇒ 404 orch_version_unknown）", async () => {
  resetToMemory();
  const port = await startHarness();

  assertFailureEnvelope(
    await request(port, "PATCH", VERSIONS_COLLECTION_PATH),
    ERR_VERSIONS_METHOD_NOT_ALLOWED,
  );
  assertFailureEnvelope(
    await request(port, "PUT", `${VERSIONS_COLLECTION_PATH}/1.0.0`),
    ERR_VERSIONS_METHOD_NOT_ALLOWED,
  );

  // O2c 落地后该两段路由归 O2c：认领 ⇒ 失败信封走版本面闭集（不再是不认领的裸 404）。
  const twoSegment = await request(port, "PATCH", `${VERSIONS_COLLECTION_PATH}/1.0.0/status`, {
    status: "active",
  });
  assert.equal(twoSegment.status, 404, `设状态路由由 O2c 认领（实际 ${twoSegment.status}）`);
  assertFailureEnvelope(twoSegment, ERR_VERSION_UNKNOWN);
});

test("O2a HTTP owner 门闩：follower ⇒ 写路 503、读路仍放行", async () => {
  resetToMemory();
  const port = await startHarness({ role: () => "follower" });

  assertFailureEnvelope(
    await request(port, "POST", VERSIONS_COLLECTION_PATH, { version: "1.0.0" }),
    ERR_VERSIONS_NOT_OWNER,
  );
  assert.equal((await request(port, "DELETE", `${VERSIONS_COLLECTION_PATH}/1.0.0`)).status, 503);
  assert.equal((await request(port, "GET", VERSIONS_COLLECTION_PATH)).status, 200);
});

// ---------------------------------------------------------------------------
// 5：一次性迁移脚本（主源整表 + 补集补缺 + 哨兵）
// ---------------------------------------------------------------------------

/** 源目录里的脚本（`.mjs` 不经 tsc ⇒ dist 下没有，回源目录取） */
function migrationScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "scripts", "migrate-versions-ledger.mjs");
}

/**
 * 造一份「未迁移」的库 + 板台账文件（**板形态 B**：`{schema,source,count,versions[]}`）：
 * 库里一张已派发卡（0.9.7）+ 一张未派发卡（0.9.8）+ 一行手工建版（0.9.6，迁移**不得覆盖**）；
 * 台账文件含 released 行 / 同名行 / 匿名档 / 非法 status 行（应跳过）/ 非 semver 行（应照搬 + warn）。
 */
function migrationFixture(tag: string): { dbPath: string; sourcePath: string } {
  const dir = tmpDir(tag);
  const dbPath = join(dir, "sessions.sqlite");
  const store = new SessionStore(dbPath);
  try {
    seedCard(store, {
      featureId: "f-legacy-active",
      ownerGroup: "g1",
      version: "0.9.7",
      state: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    seedCard(store, {
      featureId: "f-legacy-waiting",
      ownerGroup: "g1",
      version: "0.9.8",
      createdAt: "2026-02-02T00:00:00.000Z",
    });
    mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version: "0.9.6", status: "active" }));
  } finally {
    store.close();
  }
  const sourcePath = join(dir, "versions.json");
  writeFileSync(
    sourcePath,
    JSON.stringify({
      schema: 1,
      source: "board",
      count: 5,
      versions: [
        {
          org: "g1",
          version: "0.9.4",
          status: "released",
          date: "2026-10-01",
          note: "已发版",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-02T03:04:05.000Z",
        },
        { org: "g1", version: "0.9.6", status: "notstart", createdAt: "2026-09-30T00:00:00.000Z" },
        { org: null, version: "0.8.0", status: "active" },
        { org: "g1", version: "0.9.5", status: "bogus" },
        { org: "g1", version: "自由文本", status: "notstart" },
      ],
    }),
    "utf8",
  );
  return { dbPath, sourcePath };
}

function runMigration(dbPath: string, sourcePath: string, extraArgs: string[] = []): string {
  return execFileSync(
    process.execPath,
    [migrationScriptPath(), `--from=${sourcePath}`, ...extraArgs],
    { encoding: "utf8", env: { ...process.env, SESSION_DB: dbPath } },
  );
}

function ledgerRow(dbPath: string, ownerGroup: string | null, version: string): Record<string, unknown> | undefined {
  const db = openStoreDatabase(dbPath);
  try {
    return db
      .prepare("SELECT status, date, note, created_at, updated_at FROM versions WHERE owner_group IS ? AND version = ?")
      .get(ownerGroup, version) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

test("迁移 dry-run：只产出计划、零写入", () => {
  const { dbPath, sourcePath } = migrationFixture("dryrun");
  const out = runMigration(dbPath, sourcePath);
  assert.match(out, /dry-run/);
  assert.match(out, /待导入 3 行/, `主源应计划导入 3 行（bogus 跳过 · 已有 0.9.6 不覆盖）\n${out}`);
  assert.match(out, /跳过 1 行/);
  assert.match(out, /待补登 2 行/);
  assert.equal(scalar(dbPath, "SELECT COUNT(*) AS n FROM versions"), 1, "dry-run 不得写台账");
  assert.equal(scalar(dbPath, "SELECT COUNT(*) AS n FROM events WHERE kind = ?", EVENT_VERSION_LEDGER_MIGRATED), 0, "dry-run 不得写哨兵");
});

test("迁移 --apply：主源整表照搬（含 released 与原始时间戳）· 补集只补缺行不覆盖 status · 永不落 released · 哨兵一条", () => {
  const { dbPath, sourcePath } = migrationFixture("apply");
  const out = runMigration(dbPath, sourcePath, ["--apply"]);
  assert.match(out, /主源导入 3 行/, out);
  assert.match(out, /补集补登 2 行/, out);

  const released = ledgerRow(dbPath, "g1", "0.9.4");
  assert.equal(released?.["status"], "released", "released 行照搬");
  assert.equal(released?.["date"], "2026-10-01");
  assert.equal(released?.["note"], "已发版");
  assert.equal(released?.["created_at"], "2026-10-01T00:00:00.000Z", "createdAt 取源原值、不被 now 覆盖");
  assert.equal(released?.["updated_at"], "2026-10-02T03:04:05.000Z", "updatedAt 取源原值");

  assert.equal(ledgerRow(dbPath, null, "0.8.0")?.["status"], "active", "板 org=null ⇒ 匿名档");
  assert.equal(
    ledgerRow(dbPath, "g1", "0.9.6")?.["status"],
    "active",
    "已存在的行不被覆盖（源里写 notstart）",
  );
  assert.equal(ledgerRow(dbPath, "g1", "0.9.5"), undefined, "非法 status 行被跳过、不静默兜底");

  assert.match(out, /不合 semver 形状但仍照搬/);
  assert.equal(ledgerRow(dbPath, "g1", "自由文本")?.["status"], "notstart", "存量脏版号照搬（§2.1(4) 不归一）");

  const legacyActive = ledgerRow(dbPath, "g1", "0.9.7");
  assert.equal(legacyActive?.["status"], "active", "名下卡已离开 waiting_approval ⇒ 派生 active");
  assert.equal(legacyActive?.["created_at"], "2026-01-01T00:00:00.000Z", "时间戳取名下卡 MIN");
  assert.equal(ledgerRow(dbPath, "g1", "0.9.8")?.["status"], "notstart", "未派发 ⇒ notstart");

  assert.equal(scalar(dbPath, "SELECT COUNT(*) AS n FROM events WHERE kind = ?", EVENT_VERSION_LEDGER_MIGRATED), 1);
  assert.equal(scalar(dbPath, "SELECT COUNT(*) AS n FROM versions"), 6);
  assert.equal(scalar(dbPath, "SELECT COUNT(*) AS n FROM versions WHERE status = 'released'"), 1, "补集永不落 released");
});

test("迁移可重入：二次 --apply 命中哨兵 ⇒ 整体跳过、零新行、不重复哨兵", () => {
  const { dbPath, sourcePath } = migrationFixture("rerun");
  runMigration(dbPath, sourcePath, ["--apply"]);
  const versionsBefore = scalar(dbPath, "SELECT COUNT(*) AS n FROM versions");
  const sentinelBefore = scalar(
    dbPath,
    "SELECT COUNT(*) AS n FROM events WHERE kind = ?",
    EVENT_VERSION_LEDGER_MIGRATED,
  );

  const out = runMigration(dbPath, sourcePath, ["--apply"]);
  assert.match(out, /已迁移过，整体跳过/, out);
  assert.equal(scalar(dbPath, "SELECT COUNT(*) AS n FROM versions"), versionsBefore);
  assert.equal(
    scalar(dbPath, "SELECT COUNT(*) AS n FROM events WHERE kind = ?", EVENT_VERSION_LEDGER_MIGRATED),
    sentinelBefore,
  );
});

test("迁移哨兵判据与台账行数正交：手工建版让台账非空 ⇒ 仍判未迁移（拿 exists() 会假绿）", () => {
  const dir = tmpDir("sentinel");
  const dbPath = join(dir, "sessions.sqlite");
  const store = new SessionStore(dbPath);
  try {
    mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version: "1.0.0" }));
    assert.equal(store.versionLedgerList().length, 1, "台账非空（手工建版造出的行）");
    assert.equal(store.versionsLedgerMigrationDone(), false, "哨兵缺失 ⇒ 仍判未迁移");
  } finally {
    store.close();
  }
  process.env["SESSION_DB"] = dbPath;
  close();
  assert.equal(versionsLedgerMigrationDone(), false, "默认存储面同判据");

  const db = openStoreDatabase(dbPath);
  try {
    db.prepare(
      "INSERT INTO events (feature_id, task_id, kind, state, payload, created_at) VALUES (NULL, NULL, ?, NULL, '{}', ?)",
    ).run(EVENT_VERSION_LEDGER_MIGRATED, "2026-10-08T00:00:00.000Z");
  } finally {
    db.close();
  }
  close();
  assert.equal(versionsLedgerMigrationDone(), true, "哨兵落库后判据翻真");
  resetToMemory();
});

test("迁移脚本交付物：主源路径参数注入、不内建板文件默认路径", () => {
  const src = readFileSync(migrationScriptPath(), "utf8");
  assert.match(src, /--from=/);
  assert.ok(!src.includes("DEFAULT_FROM"), "不得内建默认主源路径");
  assert.ok(!/\.data[\\/]versions\.json/.test(src), "运行时不留读板文件的路径（§2.1(7) 红线）");
});
