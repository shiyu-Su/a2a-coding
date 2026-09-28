import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ORGS_WRITE_PATH,
  WRITE_ROUTES,
  isWriteRoute,
  parseWriteRoute,
  validateOrgName,
  findOrgNameConflict,
  parseOrgForm,
  ORG_NAME_INVALID_CODE,
  ORG_EXISTS_CODE,
  ORG_ACTION_INVALID_CODE,
  MAX_REQUIREMENT_BODY_BYTES,
} from "../dist/write-guard.js";

// ---------------------------------------------------------------------------
// A1/A2 路由白名单 6→7：POST /orgs 精确放行，近似路径不放行
// ---------------------------------------------------------------------------

test("A1-WRITE_ROUTES 六→七→八→九：新增 POST /orgs 与 POST /orgs/{org}/members，及版本台账写 POST /versions（405 文案单点共用此清单）", () => {
  // BD4（v0.9.4 B 档）在 BD1 的第七条之外再扩一条成员写路由；v0.9.4 版本管理面（REQ-2026-09-27-05 §2.4）
  // 再扩一条版本台账写路由 ⇒ 九条；405 文案与 methods.ts 共用同一清单
  assert.equal(WRITE_ROUTES.length, 9, JSON.stringify(WRITE_ROUTES));
  assert.ok(WRITE_ROUTES.includes("POST /orgs"));
  assert.ok(WRITE_ROUTES.includes("POST /versions"), "版本台账写路由在清单内（V4 ⇒ 7→8 叠加后共九条）");
  assert.deepEqual(parseWriteRoute("POST", ORGS_WRITE_PATH), { kind: "orgs" });
  for (const [method, path] of [
    ["GET", "/orgs"],
    ["PUT", "/orgs"],
    ["DELETE", "/orgs"],
    ["POST", "/orgs/"],
    ["POST", "/orgs/x"],
    ["POST", "/orgs/new-org"],
    [undefined, "/orgs"],
  ]) {
    assert.equal(isWriteRoute(method, path), false, `${method} ${path} 不得放行`);
    assert.equal(parseWriteRoute(method, path), null);
  }
});

test("A1-方法门既有锚不动：/host/{org}/stop 等六条路径判定不受新精确路径影响", () => {
  assert.deepEqual(parseWriteRoute("POST", "/host/flow/stop"), { kind: "host_stop", org: "flow" });
  assert.deepEqual(parseWriteRoute("POST", "/requirements"), { kind: "requirement" });
  assert.deepEqual(parseWriteRoute("POST", "/features/F1/schedule"), { kind: "schedule", featureId: "F1" });
});

// ---------------------------------------------------------------------------
// A2 组织名校验单一纯函数：正例 + 负例闭集（空格/#/?/%/../跨目录）
// ---------------------------------------------------------------------------

test("A2-正例：中文 / Latin 字母 / 数字 / - _ . 组合放行；首尾空白 trim 后通过", () => {
  for (const raw of ["flow-team", "Org_1", "中文组织", "a.b", "A9_z.Y-1", "团队甲", "  spaced-ok  "]) {
    const r = validateOrgName(raw);
    assert.equal(r.ok, true, `${raw} 应通过: ${r.error ?? ""}`);
  }
  assert.equal(validateOrgName("  spaced-ok  ").name, "spaced-ok", "返回值必须是 trim 后的名字");
});

test("A2-负例闭集：空/空格/#/?/%/../点段/跨目录/反斜杠/冒号/全角 一律 400 码 board_org_name_invalid", () => {
  const negatives = [
    "",
    "   ",
    "a b",
    "a\tb",
    "a#b",
    "a?b",
    "a%b",
    ".",
    "..",
    "a..b",
    "../etc",
    "a/../../b",
    "a\\b",
    "a:b",
    "a+b",
    "Ｏｒｇ",
    "a b",
    "café",
  ];
  for (const raw of negatives) {
    const r = validateOrgName(raw);
    assert.equal(r.ok, false, `${JSON.stringify(raw)} 必须被拒`);
    assert.equal(r.code, ORG_NAME_INVALID_CODE, JSON.stringify(raw));
    assert.ok(typeof r.error === "string" && r.error.length > 0, "拒绝必须带原因");
  }
  assert.equal(ORG_NAME_INVALID_CODE, "board_org_name_invalid");
  assert.equal(ORG_EXISTS_CODE, "board_org_exists");
});

// ---------------------------------------------------------------------------
// A2 三源重名闸（盘枚举 ∪ 板台账 ∪ 需求 ownerGroup）
// ---------------------------------------------------------------------------

test("A2-重名闸：三源任一命中即拒（返回首个命中源，序 = 盘→台账→需求归属）；全不中 ⇒ null", () => {
  const u = { disk: ["disk-org"], ledger: ["ledger-org", "both"], featureGroups: ["feat-org"] };
  assert.equal(findOrgNameConflict("disk-org", u), "disk");
  assert.equal(findOrgNameConflict("ledger-org", u), "ledger");
  assert.equal(findOrgNameConflict("feat-org", u), "featureGroup");
  assert.equal(findOrgNameConflict("both", u), "ledger", "多源命中按固定序取首源（文案确定性）");
  assert.equal(findOrgNameConflict("fresh", u), null);
});

// ---------------------------------------------------------------------------
// A2 建组织表单（parseOrgForm）：超限 413 / 校验不过 400 / 键缺失 = 空 ⇒ 400
//（BD3 起返回 `{name, action}`：缺省动作 = create，动作闭集见下）
// ---------------------------------------------------------------------------

test("A2-parseOrgForm：合法 org 经 URL 解码 + trim；缺键 = 空串 ⇒ 400；超限 ⇒ 413", () => {
  const ok = parseOrgForm("org=%E4%B8%AD%E6%96%87%E7%BB%84%E7%BB%87");
  assert.deepEqual(ok, { ok: true, name: "中文组织", action: "create" });
  const trimmed = parseOrgForm("org=++flow-team++");
  assert.deepEqual(trimmed, { ok: true, name: "flow-team", action: "create" });
  assert.deepEqual(parseOrgForm("org=ok&action=disable"), { ok: true, name: "ok", action: "disable" });
  assert.deepEqual(parseOrgForm("org=ok&action=create"), { ok: true, name: "ok", action: "create" });
  const badAction = parseOrgForm("org=ok&action=delete");
  assert.equal(badAction.ok, false, "动作不在闭集 ⇒ 拒（不猜动作）");
  assert.equal(badAction.status, 400);
  assert.equal(badAction.code, ORG_ACTION_INVALID_CODE);

  const missing = parseOrgForm("title=x");
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 400);
  assert.equal(missing.code, ORG_NAME_INVALID_CODE, "缺 org 键 = 空名 ⇒ 走同一校验，不做缺键语义");

  const bad = parseOrgForm("org=a%20b");
  assert.equal(bad.ok, false, "含空格必须拒（decode 后再校验）");
  assert.equal(bad.code, ORG_NAME_INVALID_CODE);

  const tooLong = "org=" + encodeURIComponent("x".repeat(MAX_REQUIREMENT_BODY_BYTES + 1));
  const big = parseOrgForm(tooLong);
  assert.equal(big.ok, false);
  assert.equal(big.status, 413);
  assert.equal(big.code, "payload_too_large");
  const byHeader = parseOrgForm("org=ok", MAX_REQUIREMENT_BODY_BYTES + 1);
  assert.equal(byHeader.status, 413, "content-length 超限同样拒（口径同 parseRequirementForm）");
});
