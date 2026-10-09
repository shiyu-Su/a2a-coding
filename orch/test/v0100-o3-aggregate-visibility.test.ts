/**
 * v0.10.0 O3（REQ-v0.10.0-2026-09-24-01 · 改造文档 §2.1(5)）——
 * **版本名下卡聚合读面（首刀，零新实体）+ 可见性与 `listFeatures` 同源**。
 *
 * 锁定的行为面：
 * 1. **三桶计数** `{total, completed, cancelled, open}`：`open` = 其余全部态（**含 `failed`**，
 *    `failed` 不计收口，见 `需求流程.md` §8）；与 O4 发版闸判据同源；
 * 2. **未登记版号单列一桶、不静默丢**：`features.version` 为 NULL / 空串 ⇒ `version: null` 桶、
 *    恒**末位**，并由 `unregisteredCount` 表达（存量 NULL 与撤排期 `''` 同归）；
 * 3. **`versions` 升序**（已登记版号全集，供板 §2.3「卡派生版号」并集）；
 * 4. **可见性与 `listFeatures` 同源**（★）：`aggregateFeaturesByVersion(g)` 的卡集合必须与
 *    `listFeatures({ ownerGroup: g })` **逐字相同**（另写一份归属条件 = 两处判据漂移、聚合静默放宽视野）；
 *    他组卡不得冒进本组计数；
 * 5. **未登记桶口径与 O5b 空串过滤同源**：聚合 `version=null` 桶 = `listFeatures({ version: "" })`；
 * 6. **无截断**：聚合不加 `LIMIT`（版号名下卡数天然有界）⇒ 卡清单与计数同源同集、不会打架。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateFeaturesByVersion,
  close,
  createFeature,
  listFeatures,
} from "../session/store.js";
import type { FeatureState } from "../types.js";

function ids(rows: Array<{ featureId: string }>): string[] {
  return rows.map((r) => r.featureId).sort();
}

function seed(
  featureId: string,
  ownerGroup: string | null,
  version: string | null,
  state?: FeatureState,
): void {
  createFeature({
    featureId,
    title: `卡 ${featureId}`,
    ownerGroup,
    ...(version === null ? {} : { version }),
    ...(state === undefined ? {} : { state }),
  });
}

/** 聚合全量卡清单（跨桶拼接、排序，供同源比对） */
function aggregateIds(ownerGroup?: string): string[] {
  return aggregateFeaturesByVersion(ownerGroup)
    .buckets.flatMap((b) => b.features.map((f) => f.featureId))
    .sort();
}

// ---------------------------------------------------------------------------
// 1：三桶计数 + 未登记桶末位 + versions 升序
// ---------------------------------------------------------------------------

test("O3 聚合：三桶计数（open 含 failed）· 未登记桶恒末位 · versions 升序 · unregisteredCount", () => {
  close();
  seed("c1", "g1", "2.0.0", "completed");
  seed("c2", "g1", "2.0.0", "cancelled");
  seed("o1", "g1", "2.0.0", "executing");
  seed("f1", "g1", "2.0.0", "failed"); // failed 属 open，不计收口
  seed("a1", "g1", "1.0.0", "completed");
  seed("u1", "g1", null); // 存量：version 列 NULL
  seed("u2", "g1", ""); // 撤排期：version = ''

  const agg = aggregateFeaturesByVersion("g1");
  assert.deepEqual(agg.versions, ["1.0.0", "2.0.0"], "已登记版号升序全集");
  assert.equal(agg.unregisteredCount, 2, "未登记卡不静默丢（NULL 与 '' 同归）");
  assert.deepEqual(
    agg.buckets.map((b) => b.version),
    ["1.0.0", "2.0.0", null],
    "未登记桶恒末位",
  );

  const v2 = agg.buckets.find((b) => b.version === "2.0.0")!;
  assert.deepEqual(v2.counts, { total: 4, completed: 1, cancelled: 1, open: 2 });
  assert.deepEqual(ids(v2.features), ["c1", "c2", "f1", "o1"]);

  const v1 = agg.buckets.find((b) => b.version === "1.0.0")!;
  assert.deepEqual(v1.counts, { total: 1, completed: 1, cancelled: 0, open: 0 });

  const un = agg.buckets.find((b) => b.version === null)!;
  assert.deepEqual(ids(un.features), ["u1", "u2"]);
  assert.deepEqual(un.counts, { total: 2, completed: 0, cancelled: 0, open: 2 });
  close();
});

// ---------------------------------------------------------------------------
// 2：可见性与 listFeatures 同源（★ 核心锚）
// ---------------------------------------------------------------------------

test("O3 可见性同源：聚合卡集合 = listFeatures 同 ownerGroup 集合；他组不冒计数", () => {
  close();
  seed("g1a", "g1", "1.0.0", "completed");
  seed("g1b", "g1", "1.0.0", "executing");
  seed("g1u", "g1", null);
  seed("g2a", "g2", "1.0.0", "completed");
  seed("g2u", "g2", null);

  const listedG1 = listFeatures({ ownerGroup: "g1" });
  assert.deepEqual(
    aggregateIds("g1"),
    ids(listedG1),
    "聚合卡集合必须与 listFeatures 同 ownerGroup 逐字相同（另写归属条件即红）",
  );
  assert.deepEqual(aggregateIds("g1"), ["g1a", "g1b", "g1u"], "他组卡不冒进本组视野");

  const aggG1 = aggregateFeaturesByVersion("g1");
  const countedG1 = aggG1.buckets.reduce((n, b) => n + b.counts.total, 0);
  assert.equal(countedG1, listedG1.length, "计数与清单同源同集（不打架）");

  // 缺省 = 全量（未配组匿名入口 / 3300 运维视图），仍与 listFeatures 同源
  assert.deepEqual(aggregateIds(), ids(listFeatures()), "undefined ⇒ 全量，仍与 listFeatures 同源");

  // 空组 ⇒ 空聚合（fail-closed：已配组环境查无此组不得回退全量）
  const empty = aggregateFeaturesByVersion("g-none");
  assert.deepEqual(empty.buckets, []);
  assert.equal(empty.unregisteredCount, 0);
  close();
});

// ---------------------------------------------------------------------------
// 3：未登记桶口径与 O5b 版号过滤同源
// ---------------------------------------------------------------------------

test("O3 未登记桶同源：聚合 version=null 桶 = listFeatures({ version: '' })", () => {
  close();
  seed("r1", "g1", "1.0.0");
  seed("n1", "g1", null);
  seed("n2", "g1", "");

  const agg = aggregateFeaturesByVersion("g1");
  const un = agg.buckets.find((b) => b.version === null)!;
  assert.deepEqual(
    ids(un.features),
    ids(listFeatures({ version: "", ownerGroup: "g1" })),
    "未登记桶与 listFeatures 空串过滤同源（NULL 与 '' 同归）",
  );
  assert.equal(agg.unregisteredCount, un.counts.total, "unregisteredCount 与桶计数一致");
  close();
});

// ---------------------------------------------------------------------------
// 4：截断不存在（无 LIMIT）——卡清单与计数同集，足够大也不分裂
// ---------------------------------------------------------------------------

test("O3 无截断：同一版号下 200 张卡 ⇒ 清单与计数同集（聚合不走 LIMIT）", () => {
  close();
  const N = 200;
  for (let i = 0; i < N; i += 1) {
    seed(`big-${String(i).padStart(3, "0")}`, "g1", "9.9.9", i % 2 === 0 ? "completed" : "executing");
  }
  const agg = aggregateFeaturesByVersion("g1");
  const bucket = agg.buckets.find((b) => b.version === "9.9.9")!;
  assert.equal(bucket.counts.total, N, "计数覆盖全部卡（无 LIMIT 截断）");
  assert.equal(bucket.features.length, N, "清单长度 = 计数（同源同集）");
  assert.equal(ids(bucket.features).length, N, "无重复、无丢失");
  // 对照：聚合无 LIMIT（200 全量），与显式放大 limit 的 listFeatures 同集
  assert.equal(ids(bucket.features).length, ids(listFeatures({ ownerGroup: "g1", limit: 1000 })).length);
  close();
});
