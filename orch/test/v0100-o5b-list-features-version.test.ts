/**
 * v0.10.0 O5b（REQ-v0.10.0-2026-09-24-01 · 改造文档 §2.1(4)）——
 * **`listFeatures` 版本过滤四处同改 + 触顶去重键补 `version`**。
 *
 * 锁定的行为面（「四处」= 入参类型 / WHERE 片段 / 绑定参数 / 去重键）：
 * 1. **版号过滤三档**（与 O3 聚合面「未登记桶」口径同源）：`undefined` ⇒ 全量；非空 ⇒ 精确匹配
 *    （trim 归一）；空串 / 纯空白 ⇒ 只返未登记卡（**NULL 与 `''` 同归**，存量 NULL 行不得漏）；
 * 2. **组合过滤不串位**：`state ∧ version ∧ owner` 同给时，WHERE 片段序与绑定参数序由同一份
 *    条件清单派生（串位表现为「查不到」而非报错 ⇒ 必须用交叉数据反向锁定）；
 * 3. **去重键补 `version`**（行为变更）：旧键 `(state, owner, limit)` 不含版号 ⇒ 不同版号过滤
 *    **共用一个 key**，第一个版号触顶后其余版号的触顶被 `truncationWarned` **静默吞**；
 *    补键后各版号**独立截断**，同版号重复触顶仍只一条（去重不放大）；
 * 4. **total 校验同口径**：触顶事件 payload 的 `total` = **过滤后**总数（COUNT(*) 走同一 WHERE），
 *    不得把版号过滤前的全量当成 total；
 * 5. **调度热路径无回归**：`listFeatures({ state: "executing", limit })`（scheduler 两处调用形态）
 *    **不带 `version`** ⇒ 语义与改前逐字一致（NULL / 各版号一并返回）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  close,
  createFeature,
  EVENT_LIST_TRUNCATED,
  listEvents,
  listFeatures,
  updateFeatureRegistration,
} from "../session/store.js";

const V10 = "v0.10.0";
const V11 = "v0.11.0";

function ids(rows: Array<{ featureId: string }>): string[] {
  return rows.map((f) => f.featureId).sort();
}

/** `store.list_truncated` 事件 payload 的字段面 */
type TruncationPayload = { list: string; limit: number; returned: number; total: number };

/** 触顶告警事件（payload 已解析） */
function truncations(): TruncationPayload[] {
  return listEvents({ since: 0, limit: 500 })
    .filter((e) => e.kind === EVENT_LIST_TRUNCATED)
    .map((e) => JSON.parse(e.payload ?? "{}") as TruncationPayload);
}

// ---------------------------------------------------------------------------
// 1：版号过滤三档
// ---------------------------------------------------------------------------

test("O5b 版号过滤：undefined ⇒ 全量；非空 ⇒ 精确；空串 ⇒ 未登记桶（NULL 与 '' 同归，不漏存量）", () => {
  close();
  createFeature({ featureId: "a", title: "A", version: V10 });
  createFeature({ featureId: "b", title: "B", version: V10 });
  createFeature({ featureId: "c", title: "C", version: V11 });
  createFeature({ featureId: "d", title: "D" }); // 存量：不传 version ⇒ 落 NULL
  createFeature({ featureId: "e", title: "E", version: V11 });
  updateFeatureRegistration("e", { version: "" }); // 撤排期 ⇒ 落 ''

  assert.deepEqual(ids(listFeatures({ version: V10 })), ["a", "b"], "非空版号 ⇒ 精确命中该版");
  assert.deepEqual(
    ids(listFeatures({ version: " " + V11 + " " })),
    ["c"],
    "trim 归一（与写口同口径）",
  );
  assert.deepEqual(
    ids(listFeatures({ version: "" })),
    ["d", "e"],
    "空串 ⇒ 未登记桶：NULL（存量）与 ''（撤排期）都要进来",
  );
  assert.deepEqual(ids(listFeatures()), ["a", "b", "c", "d", "e"], "undefined ⇒ 不筛版号（全量）");
  assert.deepEqual(
    ids(listFeatures({ version: "v9.9.9" })),
    [],
    "台账外的合法版号 ⇒ 空集（不误配）",
  );
  close();
});

// ---------------------------------------------------------------------------
// 2：组合过滤（绑定参数顺序）
// ---------------------------------------------------------------------------

test("O5b 组合过滤：state ∧ version ∧ owner 同给 ⇒ 绑定参数不串位", () => {
  close();
  createFeature({
    featureId: "hit",
    title: "H",
    state: "executing",
    version: V10,
    ownerGroup: "g1",
  });
  createFeature({
    featureId: "otherOwner",
    title: "O",
    state: "executing",
    version: V10,
    ownerGroup: "g2",
  });
  createFeature({
    featureId: "otherVersion",
    title: "V",
    state: "executing",
    version: V11,
    ownerGroup: "g1",
  });
  createFeature({
    featureId: "otherState",
    title: "S",
    state: "waiting_approval",
    version: V10,
    ownerGroup: "g1",
  });
  createFeature({ featureId: "unregistered", title: "U", state: "executing", ownerGroup: "g1" });

  assert.deepEqual(
    ids(listFeatures({ state: "executing", version: V10, ownerGroup: "g1" })),
    ["hit"],
    "三条件同给 ⇒ 恰交集一条（任一处串位都会查空或越界）",
  );
  assert.deepEqual(
    ids(listFeatures({ state: "executing", ownerGroup: "g1" })),
    ["hit", "otherVersion", "unregistered"],
    "去掉 version ⇒ 同 state/owner 全返（含未登记行）",
  );
  assert.deepEqual(
    ids(listFeatures({ version: V10, ownerGroup: "g1" })),
    ["hit", "otherState"],
    "state 与 version 不互吞（跨态同版号照常返）",
  );
  assert.deepEqual(
    ids(listFeatures({ state: "executing", version: "", ownerGroup: "g1" })),
    ["unregistered"],
    "未登记桶 + 其它条件可叠加",
  );
  close();
});

// ---------------------------------------------------------------------------
// 3+4：去重键补 version（行为变更）+ total 同口径
// ---------------------------------------------------------------------------

test("O5b 去重键补 version：不同版号过滤各自独立截断（不再静默吞）；同版号重复触顶仍只一条", () => {
  close();
  for (const [fid, version] of [
    ["x1", V10],
    ["x2", V10],
    ["y1", V11],
    ["y2", V11],
    ["z1", ""],
  ] as Array<[string, string]>) {
    createFeature({ featureId: fid, title: fid, version: version === "" ? undefined : version });
  }

  // 1) 版号 v0.10.0 触顶 ⇒ 第一条（total = 过滤后条数，不是全量 5）
  assert.deepEqual(ids(listFeatures({ version: V10, limit: 2 })), ["x1", "x2"]);
  let events = truncations();
  assert.equal(events.length, 1, "首个版号触顶 ⇒ 恰一条");
  assert.equal(events[0]?.total, 2, "total 走同一 WHERE ⇒ 过滤后总数");

  // 2) 换版号 v0.11.0 触顶 ⇒ **必须再一条**（旧键 `(state,owner,limit)` 会把它吞掉）
  assert.deepEqual(ids(listFeatures({ version: V11, limit: 2 })), ["y1", "y2"]);
  events = truncations();
  assert.equal(events.length, 2, "去重键含 version ⇒ 不同版号过滤各自独立截断");
  assert.equal(events[1]?.total, 2, "第二条 total 同样按本版号过滤");

  // 3) 同版号重复触顶 ⇒ 不放大（去重仍在，只是键更细）
  listFeatures({ version: V11, limit: 2 });
  listFeatures({ version: V11, limit: 2 });
  assert.equal(truncations().length, 2, "同 (state,owner,version,limit) 只告警一次");

  // 4) 未登记桶（空串）与「不筛版号」是两个不同过滤面 ⇒ 各自一条
  assert.deepEqual(ids(listFeatures({ version: "", limit: 1 })), ["z1"]);
  assert.equal(truncations().length, 3, "空串过滤 ⇒ 独立键（与 `*` 不共用）");
  assert.equal(listFeatures({ limit: 1 }).length, 1, "不筛版号亦触顶");
  events = truncations();
  assert.equal(events.length, 4, '全量过滤与未登记桶各自独立（键段 `""` ≠ `*`）');
  assert.equal(events[3]?.total, 5, "全量面 total = 5（未被版号过滤收窄）");

  // 5) 未触顶 ⇒ 不误报（同 limit 换版号也不发）
  listFeatures({ version: V10, limit: 1000 });
  assert.equal(truncations().length, 4, "未触顶不告警");
  close();
});

// ---------------------------------------------------------------------------
// 5：调度热路径无回归
// ---------------------------------------------------------------------------

test("O5b 调度热路径：scheduler 两处调用形态（不带 version）语义与改前逐字一致", () => {
  close();
  createFeature({ featureId: "e1", title: "E1", state: "executing", version: V10 });
  createFeature({ featureId: "e2", title: "E2", state: "executing" }); // NULL 版号
  createFeature({ featureId: "e3", title: "E3", state: "executing", version: V11 });
  createFeature({ featureId: "w1", title: "W1", state: "waiting_approval", version: V10 });

  // scheduler.ts:713 / :784 的调用形态
  const executing = listFeatures({ state: "executing", limit: 1000 });
  assert.deepEqual(
    ids(executing),
    ["e1", "e2", "e3"],
    "版号 NULL 与各版号一并返（版号不参与过滤）",
  );
  assert.deepEqual(
    ids(listFeatures({ state: "executing" })),
    ids(executing),
    "limit 缺省亦同（去重键段为 `*`）",
  );
  // 反向：按版号收窄确实收窄，说明「不带 ⇒ 不收窄」不是碰巧
  assert.deepEqual(ids(listFeatures({ state: "executing", version: V10, limit: 1000 })), ["e1"]);
  close();
});
