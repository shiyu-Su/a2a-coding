import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeVersion,
  isUnscheduled,
  parseVersion,
  compareVersionOrder,
  sortVersions,
  comparePoolEntry,
  sortPoolEntries,
  compareFeatureCard,
  sortFeatureCards,
} from "../dist/version-order.js";

// ---------------------------------------------------------------------------
// 归一 + 解析
// ---------------------------------------------------------------------------

test("normalizeVersion: 唯一 trim，null/undefined 归一为空串", () => {
  assert.equal(normalizeVersion("  v0.9.2  "), "v0.9.2");
  assert.equal(normalizeVersion(""), "");
  assert.equal(normalizeVersion("   "), "");
  assert.equal(normalizeVersion(null), "");
  assert.equal(normalizeVersion(undefined), "");
});

test("parseVersion: 命中 x.y.z 与 v 前缀，逐段取数值", () => {
  assert.deepEqual(parseVersion("0.9.2"), { major: 0, minor: 9, patch: 2 });
  assert.deepEqual(parseVersion("v0.9.2"), { major: 0, minor: 9, patch: 2 });
  assert.deepEqual(parseVersion(" v10.20.30 "), { major: 10, minor: 20, patch: 30 });
  assert.deepEqual(parseVersion("v0.0.0"), { major: 0, minor: 0, patch: 0 });
});

test("parseVersion: 非 x.y.z 一律 null（不做 semver 全规范）", () => {
  for (const bad of ["V0.9.2", "v0.9", "0.9", "0.9.2.1", "0.9.2-beta", "v0.9.2+build",
                     "^0.9.2", "~0.9.2", ">=1.0.0", "v0.10", "abc", "v 0.9.2",
                     "", null, undefined]) {
    assert.equal(parseVersion(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(parseVersion("0.9.2 "), { major: 0, minor: 9, patch: 2 });
});

// ---------------------------------------------------------------------------
// 未排期判据：单一路径 trim() === ""
// ---------------------------------------------------------------------------

test("isUnscheduled: 空串 / 空白 / null / undefined 同为未排期；有内容即已排期", () => {
  for (const empty of ["", "   ", "\t\n", null, undefined]) {
    assert.equal(isUnscheduled(empty), true, `expected unscheduled for ${JSON.stringify(empty)}`);
  }
  assert.equal(isUnscheduled("v0.9.2"), false);
  assert.equal(isUnscheduled("  v0.9.2 "), false);
  assert.equal(isUnscheduled("待定"), false);
  assert.equal(isUnscheduled("0"), false);
});

// ---------------------------------------------------------------------------
// 版本序：数值序 + 非 x.y.z 字典序垫底
// ---------------------------------------------------------------------------

test("compareVersionOrder: 两位数字大于个位数字（v0.10.0 > v0.9.0）", () => {
  assert.equal(compareVersionOrder("v0.9.0", "v0.10.0"), -1);
  assert.equal(compareVersionOrder("v0.10.0", "v0.9.0"), 1);
  assert.equal(compareVersionOrder("v1.0.0", "v0.99.99"), 1);
  assert.equal(compareVersionOrder("v0.9.1", "v0.9.2"), -1);
  assert.equal(compareVersionOrder("v0.9.10", "v0.9.9"), 1);
});

test("compareVersionOrder: 带 v 与不带 v 同版相等；自身比较为 0", () => {
  assert.equal(compareVersionOrder("v0.9.2", "0.9.2"), 0);
  assert.equal(compareVersionOrder("  v0.9.2  ", "0.9.2"), 0);
  assert.equal(compareVersionOrder("v0.9.2", "v0.9.2"), 0);
});

test("compareVersionOrder: 数值组在前，非 x.y.z 组字典序垫底", () => {
  assert.equal(compareVersionOrder("v99.0.0", "nightly"), -1);
  assert.equal(compareVersionOrder("nightly", "v99.0.0"), 1);
  assert.equal(compareVersionOrder("alpha", "beta"), -1);
  assert.equal(compareVersionOrder("beta", "alpha"), 1);
  assert.equal(compareVersionOrder("alpha", "alpha"), 0);
});

test("sortVersions: 看板列序（升序）· 归一后输出去重前的完整序列", () => {
  assert.deepEqual(
    sortVersions(["v0.10.0", "v0.9.0", "v1.0.0", "v0.9.10", "v0.9.2"]),
    ["v0.9.0", "v0.9.2", "v0.9.10", "v0.10.0", "v1.0.0"],
  );
  assert.deepEqual(
    sortVersions(["nightly", "v1.0.0", "alpha", "0.2.0", "beta"]),
    ["0.2.0", "v1.0.0", "alpha", "beta", "nightly"],
  );
});

test("sortVersions: 混合 v 前缀归一后同版相邻；空数组稳定", () => {
  assert.deepEqual(sortVersions([]), []);
  assert.deepEqual(sortVersions([" 1.0.0 ", "v1.0.0"]), ["1.0.0", "v1.0.0"]);
  assert.deepEqual(sortVersions([null, "v0.1.0", undefined]), ["v0.1.0", "", ""]);
});

test("sortVersions: 不改动入参数组", () => {
  const input = ["v0.10.0", "v0.9.0"];
  sortVersions(input);
  assert.deepEqual(input, ["v0.10.0", "v0.9.0"]);
});

// ---------------------------------------------------------------------------
// 需求池序：createdAt 降序 · null 落底 · featureId 兜底稳定
// ---------------------------------------------------------------------------

test("comparePoolEntry: createdAt 降序（新在前）", () => {
  const a = { createdAt: "2026-09-25T00:00:00Z", featureId: "F-a" };
  const b = { createdAt: "2026-09-26T00:00:00Z", featureId: "F-b" };
  assert.equal(comparePoolEntry(a, b), 1);
  assert.equal(comparePoolEntry(b, a), -1);
});

test("comparePoolEntry: null / 非法时间落底，两者皆缺时按 featureId", () => {
  const ok = { createdAt: "2026-01-01T00:00:00Z", featureId: "F-z" };
  const nil = { createdAt: null, featureId: "F-a" };
  const bad = { createdAt: "not-a-date", featureId: "F-b" };
  assert.equal(comparePoolEntry(ok, nil), -1);
  assert.equal(comparePoolEntry(nil, ok), 1);
  assert.equal(comparePoolEntry(nil, bad), -1);
  assert.equal(comparePoolEntry(bad, nil), 1);
  assert.equal(comparePoolEntry({ createdAt: null, featureId: "F-a" }, { createdAt: null, featureId: "F-b" }), -1);
});

test("comparePoolEntry: 同时间以 featureId 兜底成全序（与输入顺序无关）", () => {
  const t = "2026-09-25T12:00:00Z";
  const x = { createdAt: t, featureId: "F-x" };
  const y = { createdAt: t, featureId: "F-y" };
  assert.equal(comparePoolEntry(x, y), -1);
  assert.equal(comparePoolEntry(y, x), 1);
  assert.deepEqual(sortPoolEntries([y, x]).map((e) => e.featureId), ["F-x", "F-y"]);
  assert.deepEqual(sortPoolEntries([x, y]).map((e) => e.featureId), ["F-x", "F-y"]);
});

test("sortPoolEntries: 混排（降序 + 缺值垫底 + 同值稳定）· 不改入参", () => {
  const entries = [
    { createdAt: null, featureId: "F-null" },
    { createdAt: "2026-09-24T00:00:00Z", featureId: "F-old" },
    { createdAt: "2026-09-26T00:00:00Z", featureId: "F-new" },
    { createdAt: "2026-09-25T00:00:00Z", featureId: "F-b" },
    { createdAt: "2026-09-25T00:00:00Z", featureId: "F-a" },
  ];
  assert.deepEqual(sortPoolEntries(entries).map((e) => e.featureId), [
    "F-new", "F-a", "F-b", "F-old", "F-null",
  ]);
  assert.deepEqual(entries.map((e) => e.featureId), ["F-null", "F-old", "F-new", "F-b", "F-a"]);
});

test("sortPoolEntries: 保留条目其它字段", () => {
  const out = sortPoolEntries([
    { createdAt: "2026-09-25T00:00:00Z", featureId: "F-a", title: "甲" },
    { createdAt: "2026-09-26T00:00:00Z", featureId: "F-b", title: "乙" },
  ]);
  assert.deepEqual(out.map((e) => [e.featureId, e.title]), [["F-b", "乙"], ["F-a", "甲"]]);
});

// ---------------------------------------------------------------------------
// 版本列卡序（REQ-2026-10-12-02）：六档序 · 同档二级键复用池尺 · 未列值兜底
// ---------------------------------------------------------------------------

test("sortFeatureCards: 六档序全序锚（十二张卡 createdAt 同值 ⇒ 唯一变量 = 状态档）· 档序相邻值两两相异", () => {
  const t = "2026-10-12T00:00:00Z";
  // 档位：failed ｜ waiting_approval·reviewing·needs_input ｜ version_planning·decomposing·executing·integrating·testing ｜ completed ｜ cancelled ｜ 未列值兜底
  // 同档 createdAt 同值 ⇒ 档内二级键 = featureId 字典序：卡 id 按期望序编为 F-a…F-l，档内序即书写序
  const seq = [
    "failed", "waiting_approval", "reviewing", "needs_input",
    "version_planning", "decomposing", "executing", "integrating", "testing",
    "completed", "cancelled", "unlisted",
  ];
  const fid = (i) => `F-${"abcdefghijkl"[i]}`;
  const cards = seq.map((state, i) => ({ state, createdAt: t, featureId: fid(i) }));
  const shuffled = [
    cards[11], cards[3], cards[7], cards[0], cards[9], cards[4],
    cards[10], cards[2], cards[6], cards[1], cards[8], cards[5],
  ];
  assert.deepEqual(
    sortFeatureCards(shuffled).map((e) => e.featureId),
    seq.map((_, i) => fid(i)),
  );
  // 防「两档共用一秩」的哑实现：相邻取值两两比较，前必须严格小于后（全序 + 反对称 ⇒ 秩严格递增）
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = { state: seq[i], createdAt: t, featureId: "F-a" };
    const b = { state: seq[i + 1], createdAt: t, featureId: "F-b" };
    assert.equal(compareFeatureCard(a, b), -1, `rank(${seq[i]}) 须严格小于 rank(${seq[i + 1]})`);
    assert.equal(compareFeatureCard(b, a), 1, `rank(${seq[i + 1]}) 须严格大于 rank(${seq[i]})`);
  }
});

test("compareFeatureCard: 同档二级键 = createdAt 降序 · 缺值/非法沉底 · 全缺按 featureId · 与输入顺序无关", () => {
  const mk = (featureId, createdAt) => ({ state: "executing", createdAt, featureId });
  const nu = mk("F-new", "2026-10-12T00:00:00Z");
  const od = mk("F-old", "2026-10-01T00:00:00Z");
  const nl = mk("F-null", null);
  const bd = mk("F-bad", "c"); // Date.parse("c") = NaN ⇒ 视同缺值
  // 缺值与非法同秩 ⇒ 二者之间落回池尺 featureId 兜底（F-bad < F-null）
  assert.deepEqual(
    sortFeatureCards([nl, bd, od, nu]).map((e) => e.featureId),
    ["F-new", "F-old", "F-bad", "F-null"],
  );
  assert.deepEqual(
    sortFeatureCards([bd, nu, nl, od]).map((e) => e.featureId),
    ["F-new", "F-old", "F-bad", "F-null"],
  );
  // 全缺 ⇒ 档内落回池尺 featureId 兜底（与输入顺序无关）
  const allNil = [mk("F-d", null), mk("F-b", undefined), mk("F-c", "nope"), mk("F-a", null)];
  assert.deepEqual(
    sortFeatureCards(allNil).map((e) => e.featureId),
    ["F-a", "F-b", "F-c", "F-d"],
  );
  assert.deepEqual(
    sortFeatureCards([...allNil].reverse()).map((e) => e.featureId),
    ["F-a", "F-b", "F-c", "F-d"],
  );
});

test("sortFeatureCards: 未列值兜底一律沉 cancelled 之下（含 constructor 原型链负钉）· 不改入参 · 保留其它字段", () => {
  const t = "2026-10-12T00:00:00Z";
  const unlisted = [
    { state: "", createdAt: t, featureId: "F-emp" },
    { state: "weird", createdAt: t, featureId: "F-weird" },
    { state: null, createdAt: t, featureId: "F-null" },
    { state: "constructor", createdAt: t, featureId: "F-ctor" }, // 原型链负钉：字面量表会命中 Object.prototype.constructor ⇒ NaN 秩、比较器失全序
    { state: "cancelled", createdAt: t, featureId: "F-cancelled" },
  ];
  const shuffled = [unlisted[3], unlisted[0], unlisted[4], unlisted[2], unlisted[1]];
  const out = sortFeatureCards(shuffled);
  const states = out.map((e) => e.state);
  // 四枚未列值（含 null）一律沉 cancelled 之下；未列值之间档内同秩 ⇒ 落回池尺 featureId 字典序
  assert.deepEqual(states, ["cancelled", "constructor", "", null, "weird"]);
  // 不改入参（照 sortPoolEntries「不改动入参」写法）
  assert.deepEqual(shuffled.map((e) => e.state), ["constructor", "", "cancelled", null, "weird"]);
  // 保留其它字段（照 sortPoolEntries「保留其它字段」写法）
  const withExtra = sortFeatureCards([
    { state: "failed", createdAt: t, featureId: "F-a", title: "甲" },
    { state: "unlisted-z", createdAt: t, featureId: "F-b", title: "乙" },
  ]);
  assert.deepEqual(withExtra.map((e) => [e.featureId, e.title]), [["F-a", "甲"], ["F-b", "乙"]]);
});
