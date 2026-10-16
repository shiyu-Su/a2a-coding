/**
 * v0.10.7 **n1**（REQ-2026-10-15-05 · 改造文档 §2.1 n1）—— 删版分档**纯读**函数
 * `SessionStore.classifyVersionCardsForDelete`。
 *
 * 锁定的行为面（本版 n1 **零行为变更**：`versionLedgerDelete` 尚未接线）：
 * 1. **四桶判据**（§2.0 伪码照抄）—— 挡删 = `completed` ∪（未收口 ∧ ¬可回池档）；
 *    清卡 = `cancelled` ∪（未收口 ∧ 可回池档）；可回池档 = `stage=需求分析 ∧ approval=未发起`
 *    （两枚**同时**成立，不得以单枚代判）；
 * 2. **四桶互斥且并集 = 名下全部卡**（分档不得静默丢卡 ⇒ 拒因清单恒完整）；
 * 3. **键口径 = NULL-safe `owner_group IS ?` 精确一档**（`null` ⇒ 仅匿名档；别组同名版号卡
 *    不得串味 ⇒ 否则误挡删版）；
 * 4. **读侧归一即 fail-closed**（`stage`/`approval` 的 NULL / 脏值归一到 `改造方案`/`待审批`
 *    ⇒ 恒不满足可回池档 ⇒ 进挡删集）；
 * 5. **`state` 列原值参与分档**（闭集外的脏值不 throw、按「非 completed/cancelled」落未收口两桶）；
 * 6. **纯读零副作用**（不改 `version`、不写事件）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { close, openStoreDatabase, SessionStore } from "../session/store.js";
import type { VersionDeleteCard, VersionDeleteClassification } from "../session/store.js";
import type { FeatureState } from "../types.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

after(() => {
  for (const path of tmpDirs) rmSync(path, { recursive: true, force: true });
  close();
});

function newStore(): SessionStore {
  return new SessionStore(":memory:");
}

function fileStore(tag: string): { store: SessionStore; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `a2a-v0107-n1-${tag}-`));
  tmpDirs.push(dir);
  return {
    store: new SessionStore(join(dir, "sessions.sqlite")),
    dbPath: join(dir, "sessions.sqlite"),
  };
}

interface SeedInput {
  featureId: string;
  version: string;
  ownerGroup?: string | null;
  state?: FeatureState;
  /** 显式传 `null` ⇒ 落 NULL 列（读侧归一路径） */
  stage?: string | null;
  approval?: string | null;
  decisions?: string | null;
}

function seedCard(store: SessionStore, input: SeedInput): void {
  store.createFeature({
    featureId: input.featureId,
    title: `卡 ${input.featureId}`,
    ownerGroup: input.ownerGroup ?? null,
    version: input.version,
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...(input.approval === undefined ? {} : { approval: input.approval }),
  });
  if (input.state !== undefined) store.updateFeatureState(input.featureId, input.state);
  if (input.decisions !== undefined) {
    store.updateFeatureContext(input.featureId, { decisions: input.decisions });
  }
}

/** 四桶 ⇒ 「featureId → 桶名」映射（断言逐卡落点，比读数组长度信息量大） */
function bucketOfCards(
  result: VersionDeleteClassification,
): Record<string, keyof VersionDeleteClassification> {
  const map: Record<string, keyof VersionDeleteClassification> = {};
  for (const key of ["blockedCompleted", "blockedOpen", "clearPool", "clearCancelled"] as const) {
    for (const card of result[key]) map[card.featureId] = key;
  }
  return map;
}

function ids(cards: VersionDeleteCard[]): string[] {
  return cards.map((c) => c.featureId);
}

// ---------------------------------------------------------------------------
// 1：六类卡的落点（改造文档 §2.1 n1 验收判据 1 列举的六枚）
// ---------------------------------------------------------------------------

test("分档六类：completed 挡删 / cancelled 清卡 / executing∧改造 挡删 / 未收口∧回池档 清池 / 待审批 挡删 / 改造方案 挡删", () => {
  const store = newStore();
  seedCard(store, {
    featureId: "c-completed",
    version: "1.0.0",
    state: "completed",
    stage: "改造方案",
    approval: "已通过",
  });
  seedCard(store, {
    featureId: "c-cancelled",
    version: "1.0.0",
    state: "cancelled",
    stage: "改造方案",
    approval: "已通过",
  });
  seedCard(store, {
    featureId: "c-executing",
    version: "1.0.0",
    state: "executing",
    stage: "改造",
    approval: "已通过",
  });
  seedCard(store, {
    featureId: "c-pool",
    version: "1.0.0",
    state: "waiting_approval",
    stage: "需求分析",
    approval: "未发起",
  });
  seedCard(store, {
    featureId: "c-pending-approval",
    version: "1.0.0",
    state: "waiting_approval",
    stage: "需求分析",
    approval: "待审批",
  });
  seedCard(store, {
    featureId: "c-stage-raised",
    version: "1.0.0",
    state: "waiting_approval",
    stage: "改造方案",
    approval: "未发起",
  });

  const result = store.classifyVersionCardsForDelete(null, "1.0.0");
  const bucket = bucketOfCards(result);

  assert.deepEqual(
    bucket,
    {
      "c-completed": "blockedCompleted",
      "c-cancelled": "clearCancelled",
      "c-executing": "blockedOpen",
      "c-pool": "clearPool",
      "c-pending-approval": "blockedOpen",
      "c-stage-raised": "blockedOpen",
    },
    "六类卡的落点必须与 §2.0 伪码逐字同构",
  );
  assert.deepEqual(ids(result.blockedCompleted), ["c-completed"]);
  assert.deepEqual(ids(result.clearCancelled), ["c-cancelled"]);
  assert.deepEqual(ids(result.clearPool), ["c-pool"]);
  assert.deepEqual(ids(result.blockedOpen), [
    "c-executing",
    "c-pending-approval",
    "c-stage-raised",
  ]);
  store.close();
});

// ---------------------------------------------------------------------------
// 2：可回池档 = 两枚登记字段的同时合取（不得以单枚代判）
// ---------------------------------------------------------------------------

test("可回池档两枚合取：`需求分析∧未发起` 清池；任一枚换成他值（含 待审批 / 已通过 / 改造）⇒ 挡删", () => {
  const store = newStore();
  const combos: Array<[string, string, string]> = [
    ["需求分析", "未发起", "clearPool"],
    ["需求分析", "待审批", "blockedOpen"],
    ["需求分析", "已通过", "blockedOpen"],
    ["改造方案", "未发起", "blockedOpen"],
    ["改造", "未发起", "blockedOpen"],
    ["验收", "未发起", "blockedOpen"],
    ["发版", "未发起", "blockedOpen"],
  ];
  for (const [stage, approval, expected] of combos) {
    seedCard(store, {
      featureId: `k-${stage}-${approval}`,
      version: "2.0.0",
      state: "waiting_approval",
      stage,
      approval,
    });
    const result = store.classifyVersionCardsForDelete(null, "2.0.0");
    assert.equal(bucketOfCards(result)[`k-${stage}-${approval}`], expected);
  }
  store.close();
});

test("可回池档不看 state 的未收口子类：executing / failed / needs_input / reviewing ∧ 回池档 ⇒ 一律清池", () => {
  const store = newStore();
  for (const state of [
    "waiting_approval",
    "version_planning",
    "decomposing",
    "executing",
    "needs_input",
    "failed",
    "reviewing",
  ] as FeatureState[]) {
    seedCard(store, {
      featureId: `s-${state}`,
      version: "3.0.0",
      state,
      stage: "需求分析",
      approval: "未发起",
    });
  }
  // `cancelled` 先行占位：终态优先于回池档（清卡内两桶不得合并）
  seedCard(store, {
    featureId: "s-cancelled",
    version: "3.0.0",
    state: "cancelled",
    stage: "需求分析",
    approval: "未发起",
  });
  const result = store.classifyVersionCardsForDelete(null, "3.0.0");
  assert.deepEqual(ids(result.clearPool), [
    "s-decomposing",
    "s-executing",
    "s-failed",
    "s-needs_input",
    "s-reviewing",
    "s-version_planning",
    "s-waiting_approval",
  ]);
  assert.deepEqual(ids(result.clearCancelled), ["s-cancelled"]);
  assert.deepEqual(result.blockedCompleted, []);
  assert.deepEqual(result.blockedOpen, []);
  store.close();
});

// ---------------------------------------------------------------------------
// 3：四桶互斥且并集 = 名下全部卡（分档不得静默丢卡）
// ---------------------------------------------------------------------------

test("四桶闭合：任一卡集上「四桶长度之和 = 名下全部卡」且无卡跨两桶", () => {
  const store = newStore();
  const seeds: Array<[string, FeatureState, string, string]> = [
    ["a", "completed", "改造方案", "已通过"],
    ["b", "cancelled", "改造方案", "已通过"],
    ["c", "executing", "改造", "已通过"],
    ["d", "waiting_approval", "需求分析", "未发起"],
    ["e", "waiting_approval", "需求分析", "待审批"],
    ["f", "failed", "需求分析", "未发起"],
    ["g", "testing", "验收", "已通过"],
  ];
  for (const [id, state, stage, approval] of seeds) {
    seedCard(store, {
      featureId: id,
      version: "4.0.0",
      state,
      stage,
      approval,
    });
  }
  const result = store.classifyVersionCardsForDelete(null, "4.0.0");
  const all = [
    ...result.blockedCompleted,
    ...result.blockedOpen,
    ...result.clearPool,
    ...result.clearCancelled,
  ];
  assert.equal(all.length, seeds.length, "四桶并集长度 = 名下卡数（不得静默丢卡）");
  assert.equal(new Set(ids(all)).size, seeds.length, "四桶互斥（同一卡不得出现在两桶）");
  const bucket = bucketOfCards(result);
  for (const [id] of seeds) assert.ok(id in bucket, `卡 ${id} 未落任何桶`);
  store.close();
});

// ---------------------------------------------------------------------------
// 4：键口径 = NULL-safe `owner_group IS ?` 精确一档
// ---------------------------------------------------------------------------

test("归属精确档：null ⇒ 仅匿名档；组名 ⇒ 仅本组；别组同名版号卡不串味（误挡删版的根因）", () => {
  const store = newStore();
  seedCard(store, {
    featureId: "anon-pool",
    version: "5.0.0",
    stage: "需求分析",
    approval: "未发起",
  });
  seedCard(store, {
    featureId: "g1-pool",
    version: "5.0.0",
    ownerGroup: "g1",
    stage: "需求分析",
    approval: "未发起",
  });
  seedCard(store, {
    featureId: "g2-completed",
    version: "5.0.0",
    ownerGroup: "g2",
    state: "completed",
    stage: "改造方案",
    approval: "已通过",
  });

  assert.deepEqual(ids(store.classifyVersionCardsForDelete(null, "5.0.0").clearPool), [
    "anon-pool",
  ]);
  assert.deepEqual(ids(store.classifyVersionCardsForDelete("g1", "5.0.0").clearPool), ["g1-pool"]);
  assert.deepEqual(ids(store.classifyVersionCardsForDelete("g2", "5.0.0").blockedCompleted), [
    "g2-completed",
  ]);
  // 空档：不存在的组 ⇒ 四桶全空（不得兜底成全量，也不得把匿名档算进来）
  assert.deepEqual(store.classifyVersionCardsForDelete("g-none", "5.0.0"), {
    blockedCompleted: [],
    blockedOpen: [],
    clearPool: [],
    clearCancelled: [],
  });
  store.close();
});

test("版号精确匹配：名下只取该 version 的卡（空串 = 未登记档，不与任何版号混读）", () => {
  const store = newStore();
  seedCard(store, {
    featureId: "v-target",
    version: "6.0.0",
    stage: "需求分析",
    approval: "未发起",
  });
  seedCard(store, {
    featureId: "v-other",
    version: "6.0.1",
    stage: "需求分析",
    approval: "未发起",
  });
  seedCard(store, { featureId: "v-none", version: "", stage: "需求分析", approval: "未发起" });

  const result = store.classifyVersionCardsForDelete(null, "6.0.0");
  assert.deepEqual(ids(result.clearPool), ["v-target"]);
  assert.deepEqual(store.classifyVersionCardsForDelete(null, "6.0.2"), {
    blockedCompleted: [],
    blockedOpen: [],
    clearPool: [],
    clearCancelled: [],
  });
  store.close();
});

// ---------------------------------------------------------------------------
// 5：出参形状（featureId / state / stage / approval / decisions 五枚，供 n2 事件装配）
// ---------------------------------------------------------------------------

test("出参形状：卡面五枚字段如实带出，decisions 为列原值（不解析、不搬运）", () => {
  const store = newStore();
  seedCard(store, {
    featureId: "shape-1",
    version: "7.0.0",
    stage: "需求分析",
    approval: "未发起",
    decisions: '["doc/v7.0.0/x-需求确认单.md"]',
  });
  seedCard(store, {
    featureId: "shape-2",
    version: "7.0.0",
    stage: "需求分析",
    approval: "未发起",
  });

  const [first, second] = store.classifyVersionCardsForDelete(null, "7.0.0").clearPool;
  assert.deepEqual(first, {
    featureId: "shape-1",
    state: "waiting_approval",
    stage: "需求分析",
    approval: "未发起",
    decisions: '["doc/v7.0.0/x-需求确认单.md"]',
  });
  assert.equal(second?.decisions, null, "未登记 decisions ⇒ null（列原值，不折叠成空数组串）");
  store.close();
});

test("桶内序 = feature_id 升序（n2 事件 payload 的 cleared[] 可比对）", () => {
  const store = newStore();
  for (const id of ["zeta", "alpha", "mid"]) {
    seedCard(store, { featureId: id, version: "8.0.0", stage: "需求分析", approval: "未发起" });
  }
  assert.deepEqual(ids(store.classifyVersionCardsForDelete(null, "8.0.0").clearPool), [
    "alpha",
    "mid",
    "zeta",
  ]);
  store.close();
});

// ---------------------------------------------------------------------------
// 6：fail-closed 与「不改读侧归一」
// ---------------------------------------------------------------------------

test("NULL 登记字段（存量行）⇒ 读侧归一即挡删：不得因归一前的 NULL 判成可回池档", () => {
  const store = newStore();
  store.createFeature({ featureId: "legacy", title: "存量卡", version: "9.0.0" }); // stage / approval 落 NULL
  const result = store.classifyVersionCardsForDelete(null, "9.0.0");
  assert.deepEqual(result.clearPool, [], "NULL 档不得清池");
  assert.deepEqual(ids(result.blockedOpen), ["legacy"]);
  const [card] = result.blockedOpen;
  assert.equal(card?.stage, "改造方案", "归一走既有 readStage 缺省（本节点不改读侧归一）");
  assert.equal(card?.approval, "待审批", "同上 readApproval");
  store.close();
});

test("脏登记值 ⇒ 同归一挡删（不因脏值 throw、也不静默清池）", () => {
  const store = newStore();
  seedCard(store, {
    featureId: "dirty",
    version: "9.1.0",
    stage: "进行中",
    approval: "approved",
  });
  assert.deepEqual(ids(store.classifyVersionCardsForDelete(null, "9.1.0").blockedOpen), ["dirty"]);
  store.close();
});

test("脏 state 值 ⇒ 不 throw，按「非 completed / cancelled」落未收口两桶", () => {
  const { store, dbPath } = fileStore("dirty-state");
  seedCard(store, {
    featureId: "bogus-pool",
    version: "9.2.0",
    stage: "需求分析",
    approval: "未发起",
  });
  seedCard(store, {
    featureId: "bogus-block",
    version: "9.2.0",
    stage: "改造方案",
    approval: "已通过",
  });
  const db = openStoreDatabase(dbPath);
  try {
    db.prepare("UPDATE features SET state = 'bogus' WHERE feature_id IN (?, ?)").run(
      "bogus-pool",
      "bogus-block",
    );
  } finally {
    db.close();
  }

  const result = store.classifyVersionCardsForDelete(null, "9.2.0");
  assert.deepEqual(ids(result.clearPool), ["bogus-pool"]);
  assert.deepEqual(ids(result.blockedOpen), ["bogus-block"]);
  assert.deepEqual(result.blockedCompleted, []);
  assert.deepEqual(result.clearCancelled, []);
  store.close();
});

// ---------------------------------------------------------------------------
// 7：纯读零副作用（n1 不接删版口）
// ---------------------------------------------------------------------------

test("纯读：分档不改 features.version、不写任何事件", () => {
  const store = newStore();
  seedCard(store, { featureId: "p1", version: "10.0.0", stage: "需求分析", approval: "未发起" });
  seedCard(store, {
    featureId: "p2",
    version: "10.0.0",
    state: "completed",
    stage: "改造方案",
    approval: "已通过",
  });
  const eventsBefore = store.listEvents({ limit: 1000 }).length;
  const versionsBefore = ["p1", "p2"].map((id) => store.getFeature(id)?.version);
  const approvalBefore = ["p1", "p2"].map((id) => store.getFeature(id)?.approval);

  store.classifyVersionCardsForDelete(null, "10.0.0");
  store.classifyVersionCardsForDelete(null, "10.0.0"); // 重复调用 ⇒ 仍零副作用

  assert.equal(store.listEvents({ limit: 1000 }).length, eventsBefore, "分档不得产生事件");
  assert.deepEqual(
    ["p1", "p2"].map((id) => store.getFeature(id)?.version),
    versionsBefore,
  );
  assert.deepEqual(
    ["p1", "p2"].map((id) => store.getFeature(id)?.approval),
    approvalBefore,
    "不得回写 approval（单向无回边）",
  );
  store.close();
});

// ---------------------------------------------------------------------------
// 8：与既有三桶计数口径同源（扩列后 countVersionCards 不得漂移）
// ---------------------------------------------------------------------------

test("计数同源：收口三桶与分档对同一卡集给出一致读数（completed / cancelled / open）", () => {
  const store = newStore();
  seedCard(store, {
    featureId: "n1-completed",
    version: "11.0.0",
    state: "completed",
    stage: "改造方案",
    approval: "已通过",
  });
  seedCard(store, {
    featureId: "n1-cancelled",
    version: "11.0.0",
    state: "cancelled",
    stage: "改造方案",
    approval: "已通过",
  });
  seedCard(store, {
    featureId: "n1-failed",
    version: "11.0.0",
    state: "failed",
    stage: "改造方案",
    approval: "已通过",
  });
  seedCard(store, {
    featureId: "n1-pool",
    version: "11.0.0",
    stage: "需求分析",
    approval: "未发起",
  });

  const result = store.classifyVersionCardsForDelete(null, "11.0.0");
  const total =
    result.blockedCompleted.length +
    result.blockedOpen.length +
    result.clearPool.length +
    result.clearCancelled.length;
  assert.equal(total, 4);
  assert.equal(result.blockedCompleted.length, 1, "completed 计数 = 挡删 B-3");
  assert.equal(result.clearCancelled.length, 1, "cancelled 计数 = 清卡 B-4 甲档");
  assert.equal(
    result.blockedOpen.length + result.clearPool.length,
    2,
    "未收口两桶 = 计数面的 open（failed 不算收口）",
  );
  store.close();
});
