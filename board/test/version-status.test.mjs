/**
 * REQ-v0.9.2-2026-09-26-03 / N1 版本状态单点用例（version-status.ts 纯函数）。
 *
 * 四组：① isVersionLocked 精确匹配（含两侧 trim）② 前缀不连坐（`v0.9.0-probe`）
 * ③ 空串 / 未排期恒 false ④ deriveVersionStatus 仅显示用（锁 > 未排期 > 已收尾 > 进行中，判不出回落）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveVersionStatus, isVersionLocked } from "../dist/version-status.js";

const RELEASED = ["v0.9.0", "v0.9.1"];

test("① isVersionLocked：trim 后精确串匹配命中即锁（两侧空白不影响判据）", () => {
  assert.equal(isVersionLocked("v0.9.1", RELEASED), true);
  assert.equal(isVersionLocked("  v0.9.1  ", RELEASED), true);
  assert.equal(isVersionLocked("v0.9.2", RELEASED), false);
  assert.equal(isVersionLocked("v0.9.1", []), false, "未登记任何版 ⇒ 无锁");
});

test("②（负向·防连坐）前缀匹配一律不算锁：v0.9.0-probe / 大小写 / 缺 v 前缀都不连坐", () => {
  assert.equal(isVersionLocked("v0.9.0-probe", RELEASED), false, "probe 版不得被 v0.9.0 连坐");
  assert.equal(isVersionLocked("V0.9.0", RELEASED), false, "大小写不同 = 不同串");
  assert.equal(isVersionLocked("0.9.0", RELEASED), false, "登记带 v 前缀、查询缺 v ⇒ 不匹配（不做归一）");
  assert.equal(isVersionLocked("v0.9", RELEASED), false);
  assert.equal(isVersionLocked("v0.9.1", [" v0.9.1 "]), true, "登记侧也 trim ⇒ 带空白的登记仍精确命中");
  assert.equal(isVersionLocked("v0.9.1", ["v0.9.1+ee"]), false, "登记侧多后缀 = 不等长 ⇒ 不匹配（禁前缀连坐）");
});

test("③ 空串 / null / undefined（未排期）恒 false，永不参与锁", () => {
  for (const v of ["", "   ", null, undefined]) {
    assert.equal(isVersionLocked(v, RELEASED), false, `未排期 ${JSON.stringify(v)} ⇒ 不锁`);
    assert.equal(isVersionLocked(v, ["", "  "]), false, "即便登记里有空白元素也不锁");
  }
});

test("④ deriveVersionStatus：锁优先（已发版），只显示不执法", () => {
  const feats = [
    { state: "completed", version: "v0.9.1" },
    { state: "cancelled", version: "v0.9.1" },
  ];
  const locked = deriveVersionStatus("v0.9.1", feats, RELEASED);
  assert.equal(locked.status, "已发版");
  assert.equal(locked.total, 2);
  assert.equal(locked.completed, 1);
  assert.equal(locked.terminal, 2);

  const closed = deriveVersionStatus("v0.9.1", feats, []);
  assert.equal(closed.status, "已收尾", "完成集合（completed + cancelled）覆盖全部且至少一条 completed ⇒ 已收尾（仅提示，未登记 releasedVersions 不加锁）");

  const running = deriveVersionStatus("v0.9.1", [...feats, { state: "executing", version: "v0.9.1" }], []);
  assert.equal(running.status, "进行中");
  assert.equal(running.terminal, 2);
  assert.equal(running.total, 3);

  const allFailed = deriveVersionStatus("v1.0.0", [{ state: "failed", version: "v1.0.0" }], []);
  assert.equal(allFailed.status, "进行中", "failed 不计入完成集合 ⇒ 呈现为未收口，回落进行中");

  const allCancelled = deriveVersionStatus("v1.0.1", [
    { state: "cancelled", version: "v1.0.1" },
    { state: "cancelled", version: "v1.0.1" },
  ], []);
  assert.equal(allCancelled.status, "进行中", "completed > 0 不丢：全 cancelled 版零交付 ⇒ 不显示「已收尾」");

  const empty = deriveVersionStatus("v1.1.0", [], []);
  assert.equal(empty.status, "进行中", "空版 ⇒ 进行中，不猜已收尾");
});

test("⑤ deriveVersionStatus：未排期分支 + 按 version 过滤成员（混版集合只算本版本）", () => {
  const mixed = [
    { state: "completed", version: "v0.9.1" },
    { state: "executing", version: "v0.9.2" },
    { state: null, version: "" },
  ];
  const unscheduled = deriveVersionStatus("", mixed, RELEASED);
  assert.equal(unscheduled.status, "未排期");
  assert.equal(unscheduled.total, 1, "空串成员只算归一后的未排期组");

  assert.equal(deriveVersionStatus("v0.9.2", mixed, RELEASED).status, "进行中");
  assert.equal(deriveVersionStatus("v0.9.2", mixed, RELEASED).total, 1);

  const one = deriveVersionStatus("  v0.9.1 ", [{ state: "completed", version: "v0.9.1" }], RELEASED);
  assert.equal(one.status, "已发版", "查询串两侧空白不影响锁判定与成员归属");
});

test("⑥ 调用方已分组（成员不带 version 字段）时全量入算", () => {
  const view = deriveVersionStatus("v0.9.1", [{ state: "completed" }, { state: "completed" }], RELEASED);
  assert.equal(view.status, "已发版");
  assert.equal(view.total, 2);
  assert.equal(view.completed, 2);
});
