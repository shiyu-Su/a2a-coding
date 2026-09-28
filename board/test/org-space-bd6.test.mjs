/**
 * BD6（v0.9.4 D 档）归一层单测 —— 纯函数面：
 * 前缀剥离 / 段解码校验 / 存在性（404 档）/ 停用（410 档）/ 读面族与深链归类 /
 * 写归一（WRITE_ROUTES 不扩前缀变体的正向锚）/ ownerGroup 过滤正确性 / 编码往返。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ORG_SPACE_GONE_CODE,
  ORG_SPACE_NOT_FOUND_CODE,
  orgSpaceLink,
  orgSpaceUniverseOf,
  parseOrgSpacePath,
  resolveOrgSpaceRoute,
} from "../dist/org-space.js";
import { emptyOrgsLedger, parseOrgsLedger } from "../dist/orgs-ledger.js";
import { featuresOfOrg } from "../dist/orgs-view.js";

assert.ok(ORG_SPACE_NOT_FOUND_CODE === "board_org_space_not_found");
assert.ok(ORG_SPACE_GONE_CODE === "board_org_space_gone");

const f = (featureId, ownerGroup, version = "", createdAt = "2026-09-27T00:00:00Z") => ({
  featureId,
  state: "waiting_approval",
  title: featureId,
  requirement: null,
  taskCount: 0,
  ownerGroup,
  stage: "需求分析",
  version,
  approval: "未发起",
  parentFeatureId: null,
  createdAt,
  updatedAt: createdAt,
  stateCounts: null,
});

function universe(opts = {}) {
  const ledger = parseOrgsLedger({
    version: 1,
    orgs: [
      ...(opts.disabled ?? []).map((org) => ({ org, disabledAt: "2026-09-27T00:00:00Z" })),
      ...(opts.enabled ?? []).map((org) => ({ org, disabledAt: null })),
    ],
  });
  return orgSpaceUniverseOf({
    disk: opts.disk ?? [],
    ledger,
    featureGroups: opts.featureGroups ?? [],
    defaultGroup: opts.defaultGroup ?? null,
  });
}

// ---------------------------------------------------------------------------
// ① 正例：前缀剥离 + 读面族归类
// ---------------------------------------------------------------------------

test("BD6-①（正例）：读面族路径剥离并归 view，首页对 `/org/<名>` 与 `/org/<名>/` 同义", () => {
  const u = universe({ disk: ["flow-team"] });
  for (const [p, view] of [
    ["/org/flow-team/", "schedule"],
    ["/org/flow-team", "schedule"],
    ["/org/flow-team/schedule", "schedule"],
    ["/org/flow-team/features", "features"],
    ["/org/flow-team/tasks", "tasks"],
    // §9-c：`/orgs` 页退役 ⇒ 管理职能落空间内第四枚视图
    ["/org/flow-team/manage", "manage"],
  ]) {
    assert.deepEqual(resolveOrgSpaceRoute(p, u, "GET"), { kind: "view", org: "flow-team", view }, p);
  }
  // 解析层的 remainder 口径
  assert.deepEqual(parseOrgSpacePath("/org/flow-team/features"), { org: "flow-team", remainder: "/features" });
  assert.deepEqual(parseOrgSpacePath("/org/flow-team"), { org: "flow-team", remainder: "" });
});

test("BD6-①b（非空间路径）：不以 /org/ 开头 ⇒ unknown（既有通路零改动）；/orge 不误命中", () => {
  const u = universe({ disk: ["flow-team"] });
  for (const p of ["/", "/schedule", "/orgs", "/features/F1", "/orge/x"]) {
    assert.deepEqual(resolveOrgSpaceRoute(p, u, "GET"), { kind: "unknown" }, p);
  }
});

test("BD6-①c（深链策略）：/org/<名>/features/:id ⇒ feature_detail 透传全局详情；其余子路径 ⇒ other", () => {
  const u = universe({ disk: ["flow-team"] });
  assert.deepEqual(resolveOrgSpaceRoute("/org/flow-team/features/F1", u, "GET"), {
    kind: "feature_detail",
    org: "flow-team",
    featureId: "F1",
  });
  assert.deepEqual(resolveOrgSpaceRoute("/org/flow-team/features/F1%20", u, "GET").kind !== "unknown", true);
  assert.deepEqual(resolveOrgSpaceRoute("/org/flow-team/projects", u, "GET"), { kind: "other", org: "flow-team" });
  assert.deepEqual(resolveOrgSpaceRoute("/org/flow-team/docs/x", u, "GET"), { kind: "other", org: "flow-team" });
});

// ---------------------------------------------------------------------------
// ② 404 档：组织不存在 / 段非法（同档不区分，不给枚举留信号）
// ---------------------------------------------------------------------------

test("BD6-②（404）：universe 未命中的组织 ⇒ not_found", () => {
  const u = universe({ disk: ["flow-team"] });
  const r = resolveOrgSpaceRoute("/org/不存在组织/", u, "GET");
  assert.equal(r.kind, "failure");
  assert.equal(r.failure, "not_found");
  assert.equal(r.orgRaw, "不存在组织");
});

test("BD6-②b（404 · 负例闭集）：空格/#/?/%/../点段/跨目录/坏编码 ⇒ invalid_name（与不存在同 HTTP 档）", () => {
  const u = universe({ disk: ["a"] });
  for (const seg of ["a%20b", "a%23b", "a%3Fb", "a%25b", "..", "%2e%2e", "a..b", "%zz", ".", ""]) {
    const p = `/org/${seg}${seg === "" ? "" : "/"}`;
    const parsed = parseOrgSpacePath(p);
    assert.ok(parsed !== null && "invalid" in parsed, `${p} 必须判非法段`);
    const r = resolveOrgSpaceRoute(p, u, "GET");
    assert.equal(r.kind, "failure", p);
    assert.ok(r.failure === "invalid_name" || r.failure === "not_found", `${p} ⇒ ${r.failure}`);
  }
  // 跨目录注入的剩余段不改变「首段非法即拒」
  assert.ok("invalid" in parseOrgSpacePath("/org/..%2f..%2fetc/passwd"));
});

// ---------------------------------------------------------------------------
// ③ 410 档：停用组织（台账唯一判据；停用标记先于存在性）
// ---------------------------------------------------------------------------

test("BD6-③（410）：台账停用名 ⇒ gone（即便盘上目录仍在）", () => {
  const u = universe({ disk: ["旧组织"], disabled: ["旧组织"] });
  const r = resolveOrgSpaceRoute("/org/旧组织/features", u, "GET");
  assert.equal(r.kind, "failure");
  assert.equal(r.failure, "gone");
});

test("BD6-③b（410 先判）：停用名不在 universe（台账停用即出「在用」源）仍报 gone 不报 404", () => {
  const u = universe({ disabled: ["旧组织"] });
  assert.equal(resolveOrgSpaceRoute("/org/旧组织/", u, "GET").failure, "gone");
  // 在用名不受影响
  const u2 = universe({ enabled: ["在用"], disabled: ["旧组织"] });
  assert.equal(resolveOrgSpaceRoute("/org/在用/", u2, "GET").kind, "view");
});

// ---------------------------------------------------------------------------
// ④ universe：四源并集口径（盘 ∪ 台账在用 ∪ 需求归属 ∪ 板级默认）
// ---------------------------------------------------------------------------

test("BD6-④（universe 装配）：四源逐一可解析；停用名不出现在 orgNames 但走 410", () => {
  const u = universe({
    disk: ["盘组"],
    enabled: ["台账组"],
    featureGroups: ["归属组"],
    defaultGroup: "默认组",
    disabled: ["停用组"],
  });
  for (const org of ["盘组", "台账组", "归属组", "默认组"]) {
    assert.equal(resolveOrgSpaceRoute(`/org/${encodeURIComponent(org)}/`, u, "GET").kind, "view", org);
  }
  assert.equal(u.orgNames.includes("停用组"), false);
  assert.equal(resolveOrgSpaceRoute("/org/停用组/", u, "GET").failure, "gone");
});

// ---------------------------------------------------------------------------
// ⑤ 写归一：WRITE_ROUTES 全局集合不扩前缀变体 —— 剥前缀后原样命中
// ---------------------------------------------------------------------------

test("BD6-⑤（写归一）：POST /org/<名>/requirements ⇒ write + remainder=/requirements（全局路由零变体）", () => {
  const u = universe({ disk: ["flow-team"] });
  assert.deepEqual(resolveOrgSpaceRoute("/org/flow-team/requirements", u, "POST"), {
    kind: "write",
    org: "flow-team",
    remainder: "/requirements",
  });
  for (const [rem, tail] of [
    ["/features/F1/turn", "turn"],
    ["/features/F1/confirm", "confirm"],
    ["/features/F1/answer", "answer"],
    ["/features/F1/schedule", "schedule"],
  ]) {
    const r = resolveOrgSpaceRoute(`/org/flow-team${rem}`, u, "POST");
    assert.equal(r.kind, "write", `${rem} 应经写归一`);
    assert.equal(r.remainder, rem, tail);
  }
  // GET 档不开写通道（POST-only 语义由 method 参数承载）
  assert.deepEqual(resolveOrgSpaceRoute("/org/flow-team/requirements", u, "GET"), { kind: "other", org: "flow-team" });
});

// ---------------------------------------------------------------------------
// ⑥ 编码往返：link 拼装 → path 解析恒等（含空格/中文/#-禁）
// ---------------------------------------------------------------------------

test("BD6-⑥（编码往返）：orgSpaceLink 拼出的每一枚读面链接都能被解析回同一组织", () => {
  const names = ["flow-team", "组织甲", "a.b_c-1", "汉字", "FlowTeam2"];
  const u = universe({ disk: names });
  for (const org of names) {
    for (const view of ["", "schedule", "features", "tasks"]) {
      const link = orgSpaceLink(org, view === "" ? "" : view);
      // 链接的段必须已百分号编码（无裸空格），且 HTTP request-target 解析回同一组织
      const seg = link.slice("/org/".length).split("/")[0];
      assert.ok(!seg.includes(" "), `${link} 段内不得有裸空格`);
      assert.equal(decodeURIComponent(seg), org, link);
      const parsed = parseOrgSpacePath(link);
      assert.ok(parsed !== null && !("invalid" in parsed), `${link} 必须可解析`);
      assert.equal(parsed.org, org, link);
      const r = resolveOrgSpaceRoute(link, u, "GET");
      assert.equal(r.kind, "view", link);
      assert.equal(r.org, org, link);
      assert.equal(r.view, view === "" ? "schedule" : view, link);
    }
  }
  // 闭集一致性：带空格的组织名即便编码正确也须被拒（与 BD1 validateOrgName 单一事实源同步）
  assert.ok("invalid" in parseOrgSpacePath("/org/%E7%BB%84%E7%BB%87%20%E7%94%B2/"));
});

// ---------------------------------------------------------------------------
// ⑦ 过滤正确性（featuresOfOrg）
// ---------------------------------------------------------------------------

test("BD6-⑦（过滤）：trim 后精确匹配 ownerGroup；null/空白归属不入任何空间；跨组不漏不串", () => {
  const features = [
    f("F1", " flow-team ", "v0.9.4"),
    f("F2", "flow-team", ""),
    f("F3", "other-team"),
    f("F4", null),
    f("F5", "   "),
  ];
  assert.deepEqual(
    featuresOfOrg(features, "flow-team").map((x) => x.featureId),
    ["F1", "F2"],
  );
  assert.deepEqual(featuresOfOrg(features, "other-team").map((x) => x.featureId), ["F3"]);
  assert.deepEqual(featuresOfOrg(features, "不存在的组"), []);
  assert.deepEqual(featuresOfOrg(features, ""), [], "空组织名不匹配任何项（含 null 归属）");
  assert.equal(emptyOrgsLedger().orgs.length, 0);
});
