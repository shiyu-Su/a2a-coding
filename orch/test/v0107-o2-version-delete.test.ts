/**
 * v0.10.7 **n6a**（REQ-2026-10-15-05 · 改造文档 §2.1 n6 删除侧四枚新锚）——
 * `SessionStore.versionLedgerDelete`（`DELETE /api/versions/{version}`）在 n2 重写后的四个新语义。
 *
 * 锁定的行为面：
 * 1. **放行档**（可删集内）：`ok` / HTTP `204` 无体 ∧ 名下卡 `version` 同事务清空（读侧落
 *    **未登记桶**）∧ payload `returnedToPool` = 可回池档张数（`⊆ cleared[]`，两长度不得相加）∧
 *    `cleared[]` 带 `cardClass` 分档 ∧ **每卡恰好一条 `feature.stage` diff 事件** ∧ **同键可重新建版**；
 * 2. **B-2 防死卡**：`stage = 需求分析 ∧ approval = 待审批`（及反例形 `改造方案 ∧ 未发起`）的
 *    未收口卡 ⇒ **拒删** —— 清了 `version` 就造出「回池 ∧ 排期锁永久关死」的死卡；
 * 3. **白名单不折叠放行**：裸 UPDATE 造非法 `status` ⇒ 拒删、**零副作用**（钉「脏值折叠成 `null`
 *    同拒」；`ledgerReady = false`（无表）档**不新造夹具** —— 以 `versionLedgerStatus` 既有语义为凭）；
 * 4. **B-3 与撤销位**：名下含 `completed` 卡 ⇒ 拒删；且**成功删除后名下不存在任何仍带该版号的卡**
 *    —— 钉 `settledCardsReferencing` 恒空 ⇒ n2 撤掉该 payload 键成立。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  close,
  createFeature,
  ERR_VERSION_OPEN_CARDS,
  ERR_VERSION_UNKNOWN,
  EVENT_FEATURE_STAGE,
  EVENT_VERSION_LEDGER_DELETED,
  getFeature,
  openStoreDatabase,
  SessionStore,
  versionLedgerGet,
} from "../session/store.js";
import type { VersionLedgerWriteResult } from "../session/store.js";
import type { FeatureApproval, FeatureStage, FeatureState } from "../types.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import {
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

function fileStore(tag: string): { store: SessionStore; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `a2a-v0107-n6a-${tag}-`));
  tmpDirs.push(dir);
  const dbPath = join(dir, "sessions.sqlite");
  return { store: new SessionStore(dbPath), dbPath };
}

function resetToMemory(): void {
  process.env["SESSION_DB"] = ":memory:";
  close();
}

function mustOk(
  outcome: VersionLedgerWriteResult,
): Extract<VersionLedgerWriteResult, { ok: true }> {
  if (!outcome.ok) throw new Error(`期望删版放行，实际被拒：${outcome.code} ${outcome.message}`);
  return outcome;
}

function mustFail(
  outcome: VersionLedgerWriteResult,
): Extract<VersionLedgerWriteResult, { ok: false }> {
  if (outcome.ok) throw new Error("期望删版被拒，实际放行");
  return outcome;
}

interface SeedInput {
  featureId: string;
  ownerGroup: string | null;
  version: string;
  state?: FeatureState;
  stage?: FeatureStage;
  approval?: FeatureApproval;
  decisions?: string;
}

function seedCard(store: SessionStore, input: SeedInput): void {
  store.createFeature({
    featureId: input.featureId,
    title: `卡 ${input.featureId}`,
    ownerGroup: input.ownerGroup,
    version: input.version,
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...(input.approval === undefined ? {} : { approval: input.approval }),
  });
  if (input.decisions !== undefined) {
    store.updateFeatureContext(input.featureId, { decisions: input.decisions });
  }
}

function eventCount(store: SessionStore, kind: string): number {
  return store.listEvents({ limit: 1000 }).filter((e) => e.kind === kind).length;
}

/** `version.ledger_deleted` 的 payload（最近一条，解析后） */
interface ClearedEntry {
  featureId: string;
  cardClass: string;
  state: string;
  stage: string;
  approval: string;
  decisions: string | null;
}
interface DeletedPayload {
  ownerGroup: string | null;
  version: string;
  status: string;
  returnedToPool: number;
  cleared: ClearedEntry[];
}

function lastDeletedPayload(store: SessionStore): DeletedPayload {
  const events = store
    .listEvents({ limit: 1000 })
    .filter((e) => e.kind === EVENT_VERSION_LEDGER_DELETED);
  assert.equal(events.length, 1, `删版事件应恰好一条（实际 ${events.length}）`);
  const raw = events[0]?.payload;
  assert.equal(typeof raw, "string", "删版事件 payload 必须是 JSON 串");
  return JSON.parse(String(raw)) as DeletedPayload;
}

/** `feature.stage` diff 事件 → 「featureId → 该卡的 version 段变化」清单 */
function stageDiffByFeature(
  store: SessionStore,
): Map<string, Array<{ field: string; from: string; to: string }>> {
  const map = new Map<string, Array<{ field: string; from: string; to: string }>>();
  for (const event of store.listEvents({ limit: 1000 })) {
    if (event.kind !== EVENT_FEATURE_STAGE || event.featureId === null) continue;
    const payload = JSON.parse(String(event.payload)) as {
      fields: Array<{ field: string; from: string; to: string }>;
    };
    map.set(event.featureId, [...(map.get(event.featureId) ?? []), ...payload.fields]);
  }
  return map;
}

/** 内核桩：本测试只触达 `/api/versions*`，其余方法一律抛错 */
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

async function httpDelete(
  port: number,
  version: string,
  ownerGroup: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(
    `http://127.0.0.1:${port}${VERSIONS_COLLECTION_PATH}/${version}?owner_group=${ownerGroup}`,
    {
      method: "DELETE",
    },
  );
  return { status: res.status, text: await res.text() };
}

// ---------------------------------------------------------------------------
// 锚①：放行（同事务清 version + returnedToPool + cardClass 分档 + 每卡一条 diff 事件 + 可重建版）
// ---------------------------------------------------------------------------

test("锚① 放行：可删集 ⇒ ok ∧ 卡落未登记桶 ∧ returnedToPool = 回池档数 ∧ cleared 带 cardClass ∧ 每卡一条 diff 事件 ∧ 同键可重建版", () => {
  const store = newStore();
  try {
    const version = "21.0.0";
    mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version }));
    // 乙档两枚（可回池档：需求分析 ∧ 未发起；state 取其未收口子类）
    seedCard(store, {
      featureId: "a-pool-waiting",
      ownerGroup: "g1",
      version,
      state: "waiting_approval",
      stage: "需求分析",
      approval: "未发起",
      decisions: '["doc/v21.0.0/a-需求确认单.md"]',
    });
    seedCard(store, {
      featureId: "b-pool-executing",
      ownerGroup: "g1",
      version,
      state: "executing",
      stage: "需求分析",
      approval: "未发起",
    });
    // 甲档一枚（cancelled：清 version 但不回池 ⇒ cardClass 分档在册）
    seedCard(store, {
      featureId: "c-cancelled",
      ownerGroup: "g1",
      version,
      state: "cancelled",
      stage: "改造方案",
      approval: "已通过",
      decisions: '["doc/v21.0.0/c-改造文档.md"]',
    });
    // 干扰项：同版号但别组（NULL-safe `IS` 精确档 ⇒ 不得被本档删除牵连）
    seedCard(store, {
      featureId: "z-other-group",
      ownerGroup: "g2",
      version,
      stage: "需求分析",
      approval: "未发起",
    });

    const diffBefore = stageDiffByFeature(store);
    mustOk(store.versionLedgerDelete("g1", version));

    // 台账行已消
    assert.equal(store.versionLedgerGet("g1", version), null);
    // 名下卡 version 已清 ⇒ 读侧落「未登记桶」
    for (const id of ["a-pool-waiting", "b-pool-executing", "c-cancelled"]) {
      assert.equal(store.getFeature(id)?.version, "", `卡 ${id} 的 version 应被清空`);
    }
    const aggregate = store.aggregateFeaturesByVersion("g1");
    assert.ok(!aggregate.versions.includes(version), "已删版号不得再出现在卡派生版号集");
    const unregistered = aggregate.buckets.find((b) => b.version === null);
    assert.deepEqual(
      unregistered?.features.map((f) => f.featureId).sort(),
      ["a-pool-waiting", "b-pool-executing", "c-cancelled"],
      "三张清卡必须落未登记桶（板需求池读面）",
    );
    // 别组同名版号卡不受牵连
    assert.equal(store.getFeature("z-other-group")?.version, version, "他组同名版号卡不得被清");

    // payload：returnedToPool 只计回池档；cleared[] 含 cancelled 档且带 cardClass
    const payload = lastDeletedPayload(store);
    assert.equal(payload.ownerGroup, "g1");
    assert.equal(payload.version, version);
    assert.equal(payload.status, "notstart", "payload 的 status = 删前的台账行值");
    assert.equal(
      payload.returnedToPool,
      2,
      "returnedToPool = 可回池档张数（甲档 cancelled 不计入）",
    );
    assert.equal(
      payload.cleared.length,
      3,
      "cleared[] = 回池档 + 甲档全集（returnedToPool ⊆ cleared）",
    );
    assert.deepEqual(
      payload.cleared.map((c) => c.featureId),
      ["a-pool-waiting", "b-pool-executing", "c-cancelled"],
      "cleared[] 序 = feature_id 升序",
    );
    assert.deepEqual(
      payload.cleared.map((c) => c.cardClass),
      ["pool", "pool", "cancelled"],
      "cardClass 分档在册（甲档 = cancelled）",
    );
    const [firstEntry] = payload.cleared;
    assert.deepEqual(
      firstEntry,
      {
        featureId: "a-pool-waiting",
        cardClass: "pool",
        state: "waiting_approval",
        stage: "需求分析",
        approval: "未发起",
        decisions: '["doc/v21.0.0/a-需求确认单.md"]',
      },
      "cleared[] 逐卡带写前五枚（decisions = 已删版号下残留文档的追溯锚）",
    );

    // 每卡恰好一条 feature.stage diff 事件（复用 updateFeatureRegistration 的既有事件面）
    const diffAfter = stageDiffByFeature(store);
    for (const id of ["a-pool-waiting", "b-pool-executing", "c-cancelled"]) {
      const before = diffBefore.get(id) ?? [];
      const after = diffAfter.get(id) ?? [];
      assert.equal(
        after.length - before.length,
        1,
        `卡 ${id} 应恰好新增一条 feature.stage diff 事件`,
      );
      const added = after[after.length - 1];
      assert.equal(added?.field, "version");
      assert.equal(added?.from, version);
      assert.equal(added?.to, "", "diff 落撤排期语义（空串），不是 NULL 专列");
    }

    // 撤销位：名下不存在任何仍带该版号的卡（本档）
    assert.deepEqual(
      store.listFeatures({ ownerGroup: "g1", version }),
      [],
      "删版后 g1 名下不得有任何卡仍带该版号（= 同事务成立）",
    );

    // 同键可重新建版（台账行已彻底消解）
    const rebuilt = mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version }));
    assert.equal(rebuilt.record.status, "notstart");
  } finally {
    store.close();
  }
});

test("锚① HTTP 面：可删集 ⇒ 204 无体（维持不扩 200 回执）", async () => {
  resetToMemory();
  const port = await startHarness();
  const version = "22.0.0";

  const created = await fetch(`http://127.0.0.1:${port}${VERSIONS_COLLECTION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerGroup: "g1", version }),
  });
  assert.equal(created.status, 201, `建版应 201（实际 ${created.status}）`);

  createFeature({
    featureId: "h-pool",
    title: "回池卡",
    ownerGroup: "g1",
    version,
    stage: "需求分析",
    approval: "未发起",
  });
  createFeature({
    featureId: "h-cancelled",
    title: "已取消卡",
    ownerGroup: "g1",
    version,
    state: "cancelled",
    stage: "改造方案",
    approval: "已通过",
  });

  const removed = await httpDelete(port, version, "g1");
  assert.equal(removed.status, 204, `删版应 204（实际 ${removed.status} ${removed.text}）`);
  assert.equal(removed.text, "", "204 无体");

  const again = await httpDelete(port, version, "g1");
  assert.equal(again.status, 404, "删后再删 ⇒ 无行、白名单只紧不松");

  // 端点与默认存储同进程同实例 ⇒ 清卡效果直接读默认模块面
  assert.equal(versionLedgerGet("g1", version), null, "台账行已删");
  assert.equal(getFeature("h-pool")?.version, "", "回池档卡的 version 已清");
  assert.equal(getFeature("h-cancelled")?.version, "", "甲档卡的 version 已清");
});

// ---------------------------------------------------------------------------
// 锚②：B-2 防死卡（未收口 ∧ 非可回池档 ⇒ 拒删）
// ---------------------------------------------------------------------------

test("锚② B-2：未收口 ∧ `需求分析 ∧ 待审批` ⇒ 拒删（不清 version、不回写 approval ⇒ 不产生排期锁永久关死的死卡）", () => {
  const store = newStore();
  try {
    const version = "23.0.0";
    mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version }));
    seedCard(store, {
      featureId: "dead-pending",
      ownerGroup: "g1",
      version,
      state: "waiting_approval",
      stage: "需求分析",
      approval: "待审批",
    });
    // 同版另放一张本可回池的卡：证明拒的是整单，不是只挡那一枚
    seedCard(store, {
      featureId: "would-be-pool",
      ownerGroup: "g1",
      version,
      state: "waiting_approval",
      stage: "需求分析",
      approval: "未发起",
    });

    const fail = mustFail(store.versionLedgerDelete("g1", version));
    assert.equal(fail.code, ERR_VERSION_OPEN_CARDS);
    assert.equal(fail.status, 409);
    assert.match(fail.message, /dead-pending/, "拒因 message 须点名挡删卡");

    assert.ok(store.versionLedgerGet("g1", version) !== null, "被拒 ⇒ 台账行仍在（零写入）");
    assert.equal(store.getFeature("dead-pending")?.version, version);
    assert.equal(
      store.getFeature("would-be-pool")?.version,
      version,
      "整单零写入：可回池档也不得被清",
    );
    assert.equal(
      store.getFeature("dead-pending")?.approval,
      "待审批",
      "不回写 approval（单向无回边）—— 否则该卡清版后既回池又关死排期锁",
    );
    assert.equal(eventCount(store, EVENT_VERSION_LEDGER_DELETED), 0, "被拒 ⇒ 零事件");
    assert.equal(eventCount(store, EVENT_FEATURE_STAGE), 0, "被拒 ⇒ 零登记字段 diff 事件");
  } finally {
    store.close();
  }
});

test("锚② 反例形两点名：`改造方案 ∧ 未发起` 与 `需求分析 ∧ 待审批` 同样挡删（两枚登记字段不保证同序 ⇒ 不得以 stage 单枚代判）", () => {
  const store = newStore();
  try {
    const version = "23.1.0";
    mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version }));
    seedCard(store, {
      featureId: "stage-raised",
      ownerGroup: "g1",
      version,
      state: "waiting_approval",
      stage: "改造方案",
      approval: "未发起",
    });
    assert.equal(
      mustFail(store.versionLedgerDelete("g1", version)).code,
      ERR_VERSION_OPEN_CARDS,
      "stage 已抬、approval 未发起 ⇒ 挡删（门① 已过 ≠ 可回池）",
    );
    store.updateFeatureRegistration("stage-raised", { version: "" }); // 手工撤出该版
    seedCard(store, {
      featureId: "approval-pending",
      ownerGroup: "g1",
      version,
      state: "waiting_approval",
      stage: "需求分析",
      approval: "待审批",
    });
    assert.equal(
      mustFail(store.versionLedgerDelete("g1", version)).code,
      ERR_VERSION_OPEN_CARDS,
      "stage 未抬、approval 已置待审批 ⇒ 同样挡删",
    );
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 锚③：白名单不折叠放行（非法 status ⇒ 拒删、零副作用）
// ---------------------------------------------------------------------------

test("锚③ 白名单不折叠放行：裸写非法 status ⇒ 拒删 404 + 零副作用（无表档不新造夹具，凭 ledgerReady 既有语义）", () => {
  const { store, dbPath } = fileStore("dirty-status");
  const version = "24.0.0";
  mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version }));
  seedCard(store, {
    featureId: "dirty-pool",
    ownerGroup: "g1",
    version,
    state: "waiting_approval",
    stage: "需求分析",
    approval: "未发起",
  });
  seedCard(store, {
    featureId: "dirty-cancelled",
    ownerGroup: "g1",
    version,
    state: "cancelled",
    stage: "改造方案",
    approval: "已通过",
  });
  const ledgerDeletedBefore = eventCount(store, EVENT_VERSION_LEDGER_DELETED);
  const stageDiffBefore = eventCount(store, EVENT_FEATURE_STAGE);
  store.close();

  const db = openStoreDatabase(dbPath);
  try {
    // 夹具只造「非法 status」一档；`ledgerReady = false`（无表）档不在此处重造 ——
    // 该档由 versionLedgerStatus 的既有语义承载（no such table ⇒ ledgerReady:false），
    // 删版口对它的处置见 store.versionLedgerDelete 内判据注释。
    db.prepare("UPDATE versions SET status = 'bogus' WHERE owner_group = ? AND version = ?").run(
      "g1",
      version,
    );
  } finally {
    db.close();
  }

  const reopened = new SessionStore(dbPath);
  try {
    assert.deepEqual(
      reopened.versionLedgerStatus("g1", version),
      { status: null, ledgerReady: true },
      "脏 status 在读侧折叠成 null（白名单吃的正是这枚折叠值 —— 不是 versionLedgerGet 的 throw 路径）",
    );
    // 名下确属可删集 ⇒ 本次拒删的原因只能是白名单（分档判据没被绕过）
    const buckets = reopened.classifyVersionCardsForDelete("g1", version);
    assert.deepEqual([buckets.blockedCompleted.length, buckets.blockedOpen.length], [0, 0]);

    const fail = mustFail(reopened.versionLedgerDelete("g1", version));
    assert.equal(fail.code, ERR_VERSION_UNKNOWN, "折叠成 null ⇒ 白名单不放行（只紧不松）");
    assert.equal(fail.status, 404);

    // 零副作用：卡仍带版号、零事件
    assert.equal(reopened.getFeature("dirty-pool")?.version, version);
    assert.equal(reopened.getFeature("dirty-cancelled")?.version, version);
    assert.equal(eventCount(reopened, EVENT_VERSION_LEDGER_DELETED), ledgerDeletedBefore);
    assert.equal(eventCount(reopened, EVENT_FEATURE_STAGE), stageDiffBefore);
  } finally {
    reopened.close();
  }
  // 「台账行仍在」走裸读 —— `versionLedgerGet` 对脏 status **throw**（删版判据因此只读 versionLedgerStatus）
  const check = openStoreDatabase(dbPath);
  try {
    const row = check
      .prepare("SELECT status FROM versions WHERE owner_group IS ? AND version = ?")
      .get("g1", version) as { status: string } | undefined;
    assert.equal(row?.status, "bogus", "被拒 ⇒ 台账行不删、status 不被归一改写");
  } finally {
    check.close();
  }
});

// ---------------------------------------------------------------------------
// 锚④：B-3（completed 挡删）+ 撤销位
// ---------------------------------------------------------------------------

test("锚④ B-3：名下含 completed ⇒ 拒删并点名（已交付卡清 version 会断交付账）；撤出后放行 ⇒ 名下再无该版号卡", () => {
  const store = newStore();
  try {
    const version = "25.0.0";
    mustOk(store.versionLedgerCreate({ ownerGroup: "g1", version, status: "active" }));
    seedCard(store, {
      featureId: "done-card",
      ownerGroup: "g1",
      version,
      state: "completed",
      stage: "改造方案",
      approval: "已通过",
    });
    seedCard(store, {
      featureId: "pool-card",
      ownerGroup: "g1",
      version,
      stage: "需求分析",
      approval: "未发起",
    });

    const fail = mustFail(store.versionLedgerDelete("g1", version));
    assert.equal(fail.code, ERR_VERSION_OPEN_CARDS);
    assert.equal(fail.status, 409);
    assert.match(
      fail.message,
      /completed\[1\]=\[done-card\]/,
      "拒因分档须点名 completed 桶与其卡 id",
    );
    assert.match(fail.message, /未收口且不可回池\[0\]=\[\]/, "空档也点名（可逐档点数）");
    assert.equal(store.versionLedgerGet("g1", version)?.status, "active", "被拒 ⇒ 行仍在");
    assert.equal(store.getFeature("done-card")?.version, version);
    assert.equal(store.getFeature("pool-card")?.version, version);
    assert.equal(eventCount(store, EVENT_VERSION_LEDGER_DELETED), 0);

    // completed 挡删的出路 = 既有撤排期语义（不是清版牵连）
    store.updateFeatureRegistration("done-card", { version: "" });
    mustOk(store.versionLedgerDelete("g1", version));

    const payload = lastDeletedPayload(store);
    assert.deepEqual(
      payload.cleared.map((c) => [c.featureId, c.cardClass]),
      [["pool-card", "pool"]],
      "completed 卡不得进 cleared[]（它挡删，不是被清）",
    );
    assert.equal(payload.returnedToPool, 1);
    // 撤销位：成功删除后名下不存在任何仍带该版号的卡
    assert.deepEqual(store.listFeatures({ ownerGroup: "g1", version }), []);
    assert.ok(!store.aggregateFeaturesByVersion("g1").versions.includes(version));
    // 撤出的 completed 卡仍在账面（版号清空、交付账不断）
    const withdrawn = store.getFeature("done-card");
    assert.equal(withdrawn?.state, "completed");
    assert.equal(withdrawn?.version, "");
  } finally {
    store.close();
  }
});
