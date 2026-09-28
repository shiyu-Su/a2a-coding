/**
 * v0.9.4 B 档 · BD4 —— 板第三个 MCP 写封装（`src/group-admin.ts`）离线单测。
 * 覆盖：action 与 O1 的**恰双子集**映射 · 入参装配闭集 · 出网工具名与 arguments ·
 * 错误码 → HTTP 状态映射（含 group_not_found 保守文案与不可达引导）·
 * `config_write_concurrent_modification` 的**单次**自动重读重试（其余码不重试）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildConfigWriteGroupArgs,
  buildConfigCreateGroupArgs,
  buildConfigRemoveGroupArgs,
  buildMcpEndpoint,
  buildToolsCallRequest,
  memberActionToOp,
  normalizeWriteGroupOutcome,
  parseToolCallEnvelope,
  describeMemberWriteFailure,
  describeMemberGroupConflict,
  ownerOrgOfProject,
  orgManageHref,
  removesLastGroupMember,
  releaseOrgGroup,
  LAST_MEMBER_REMOVE_CODE,
  LAST_MEMBER_REMOVE_DISPLAY,
  MEMBER_GROUP_CONFLICT_CODE,
  MEMBER_GROUP_CONFLICT_GENERIC,
  DUPLICATE_MEMBER_CODE,
  writeGroupMembers,
  writeGroupMembersWithRetry,
  CONFIG_WRITE_GROUP_TOOL,
  CONFIG_WRITE_OPS_NOT_CONSUMED_BY_MEMBER_FORM,
  GROUP_ADD_OP,
  GROUP_REMOVE_OP,
  MEMBER_OP_ADD,
  MEMBER_OP_REMOVE,
  CONCURRENT_MODIFICATION_CODE,
  GROUP_NOT_FOUND_CODE,
  GROUP_NOT_FOUND_DISPLAY,
  GroupAdminConfigError,
} from "../dist/group-admin.js";

function okEnvelope(payload) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false },
  };
}

/** 记录每次出网调用的假 fetch（可编排逐次响应）。 */
function recordingFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses[calls.length - 1] ?? responses[0];
    return new Response(JSON.stringify(next), { status: 200 });
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// ① action ↔ op：恰双子集（板不消费 group.add/update/remove）
// ---------------------------------------------------------------------------

test("memberActionToOp: add / remove 恰双子集映射", () => {
  assert.equal(memberActionToOp("add"), MEMBER_OP_ADD);
  assert.equal(memberActionToOp("remove"), MEMBER_OP_REMOVE);
  assert.notEqual(MEMBER_OP_ADD, MEMBER_OP_REMOVE);
});

test("CONFIG_WRITE_OPS_NOT_CONSUMED_BY_MEMBER_FORM 登记 = 五操作减去成员表单消费的二字集", () => {
  assert.deepEqual(CONFIG_WRITE_OPS_NOT_CONSUMED_BY_MEMBER_FORM.slice().sort(), [
    "group.add",
    "group.remove",
    "group.update",
  ]);
});

// ---------------------------------------------------------------------------
// ② 入参装配（纯函数）
// ---------------------------------------------------------------------------

test("buildConfigWriteGroupArgs: 键集合恰好 = {op, groupName, members}（不携带任何其它配置段）", () => {
  const args = buildConfigWriteGroupArgs({
    op: MEMBER_OP_ADD,
    groupName: "flow-team",
    members: [{ machineId: " win-a ", projectId: "board" }],
  });
  assert.deepEqual(Object.keys(args).sort(), ["groupName", "members", "op"]);
  assert.equal(args.op, MEMBER_OP_ADD);
  assert.deepEqual(args.members, [{ machineId: "win-a", projectId: "board" }], "成员对发送前 trim（同排期写口径）");
});

test("buildConfigWriteGroupArgs: 越界 op（成员表单无法产出的三操作）在装配层即拒", () => {
  for (const op of CONFIG_WRITE_OPS_NOT_CONSUMED_BY_MEMBER_FORM) {
    assert.throws(
      () => buildConfigWriteGroupArgs({ op, groupName: "g", members: [{ machineId: "m", projectId: "p" }] }),
      GroupAdminConfigError,
      `${op} 不得由板侧成员写装配产出`,
    );
  }
});

test("buildConfigWriteGroupArgs: 空组名 / 空成员集 / 残缺成员对 = 编程错误抛出（不发半截写）", () => {
  assert.throws(
    () => buildConfigWriteGroupArgs({ op: MEMBER_OP_ADD, groupName: "  ", members: [{ machineId: "m", projectId: "p" }] }),
    GroupAdminConfigError,
  );
  assert.throws(
    () => buildConfigWriteGroupArgs({ op: MEMBER_OP_ADD, groupName: "g", members: [] }),
    GroupAdminConfigError,
  );
  assert.throws(
    () => buildConfigWriteGroupArgs({ op: MEMBER_OP_REMOVE, groupName: "g", members: [{ machineId: "m", projectId: " " }] }),
    GroupAdminConfigError,
  );
});

test("buildConfigCreateGroupArgs（§9-a 兜底装配）：键集合同形 · op = group.add · 成员校验口径共用", () => {
  const args = buildConfigCreateGroupArgs({ groupName: " flow-team ", members: [{ machineId: "m", projectId: "p" }] });
  assert.deepEqual(Object.keys(args).sort(), ["groupName", "members", "op"]);
  assert.equal(args.op, GROUP_ADD_OP);
  assert.deepEqual(args.members, [{ machineId: "m", projectId: "p" }]);
  for (const bad of [{ groupName: "", members: [{ machineId: "m", projectId: "p" }] }, { groupName: "g", members: [] }]) {
    assert.throws(() => buildConfigCreateGroupArgs(bad), GroupAdminConfigError);
  }
});

test("buildToolsCallRequest: 工具名 = a2a_config_write_group（纪律扫描锚）", () => {
  const req = buildToolsCallRequest({ op: MEMBER_OP_ADD }, 9);
  assert.equal(req.method, "tools/call");
  assert.equal(req.id, 9);
  assert.equal(req.params.name, CONFIG_WRITE_GROUP_TOOL);
});

// ---------------------------------------------------------------------------
// ③ 结果归一（含 backedUpTo 仅透传展示）
// ---------------------------------------------------------------------------

test("parseToolCallEnvelope: 成功归一 op/groupName/changed/members/backedUpTo", () => {
  const got = parseToolCallEnvelope(
    okEnvelope({
      ok: true,
      op: MEMBER_OP_ADD,
      groupName: "flow-team",
      changed: true,
      members: [{ machineId: "win-a", projectId: "board" }, { bad: 1 }, { machineId: "", projectId: "x" }],
      backedUpTo: "D:/orch/config.json.bak-2026-09-27",
    }),
  );
  assert.equal(got.ok, true);
  assert.equal(got.changed, true);
  assert.equal(got.backedUpTo, "D:/orch/config.json.bak-2026-09-27");
  assert.deepEqual(got.members, [{ machineId: "win-a", projectId: "board" }], "非法成员项剔除，不臆造");
});

test("parseToolCallEnvelope: 桥未回列成员 ⇒ members = null（不编造空清单）", () => {
  const got = normalizeWriteGroupOutcome({ ok: true, payload: { op: MEMBER_OP_REMOVE, changed: false } });
  assert.equal(got.ok, true);
  assert.equal(got.members, null);
  assert.equal(got.changed, false, "缺 changed ⇒ 按未写入处理（不假装成功改动）");
  assert.equal(got.backedUpTo, null);
});

test("parseToolCallEnvelope: 失败结构化透传闭集码，不吞", () => {
  const got = parseToolCallEnvelope({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify({ ok: false, code: "config_write_duplicate_member", error: "重复添加拒绝" }) }],
      isError: true,
    },
  });
  assert.equal(got.ok, false);
  assert.equal(got.code, "config_write_duplicate_member");
  assert.equal(got.error, "重复添加拒绝");
});

// ---------------------------------------------------------------------------
// ④ 错误映射读面（HTTP 状态归板）
// ---------------------------------------------------------------------------

test("describeMemberWriteFailure: 闭集六元按表给状态", () => {
  assert.deepEqual(
    {
      dry_run: describeMemberWriteFailure("config_write_dry_run_rejected", "x").status,
      unknown_machine: describeMemberWriteFailure("config_write_unknown_machine", "x").status,
      not_found: describeMemberWriteFailure("config_write_group_not_found", "x").status,
      duplicate: describeMemberWriteFailure("config_write_duplicate_member", "x").status,
      concurrent: describeMemberWriteFailure("config_write_concurrent_modification", "x").status,
      io: describeMemberWriteFailure("config_write_io_failed", "x").status,
    },
    { dry_run: 422, unknown_machine: 422, not_found: 409, duplicate: 409, concurrent: 409, io: 500 },
  );
});

test("describeMemberWriteFailure: group_not_found 走保守文案（不转译桥原文）", () => {
  const got = describeMemberWriteFailure("config_write_group_not_found", "bridge internal path leak /abs/orch/config.json");
  assert.equal(got.error, GROUP_NOT_FOUND_DISPLAY);
  assert.ok(!got.error.includes("/abs/orch"), "桥原文不得渗到浮层");
  assert.match(got.error, /目标组不存在/);
});

test("describeMemberWriteFailure: 非闭集码（传输 / JSON-RPC / 坏信封）⇒ 502 档 + 「绝不降级本地直写」引导", () => {
  for (const code of ["transport_error", "http_503", "jsonrpc_-32602", "response_invalid", "internal_error"]) {
    const got = describeMemberWriteFailure(code, "桥不可达");
    assert.equal(got.status, 502, code);
    assert.equal(got.code, code, "错误码原样保留（可排查）");
    assert.match(got.error, /不会降级去本地直写/, code);
  }
});

// ---------------------------------------------------------------------------
// ④′ 末位成员写前闸（v0.9.4 增补二 §9.1-① · 纯判据）
// ---------------------------------------------------------------------------

const grp = (name, members, memberCount) => ({
  name,
  members,
  memberCount: memberCount ?? members.length,
});

test("removesLastGroupMember: 声明面持组且仅剩一员 ⇒ remove 被拦（memberCount 为事实源；零成员坏态同样拦）", () => {
  const one = grp("shop-image", [{ machineId: "mac-dev", projectId: "shop-image-bakserver" }]);
  assert.equal(
    removesLastGroupMember({
      action: "remove",
      groupName: "shop-image",
      member: { machineId: "mac-dev", projectId: "shop-image-bakserver" },
      groups: [one],
    }),
    true,
  );
  assert.equal(
    removesLastGroupMember({
      action: "remove",
      groupName: "shop-image",
      member: { machineId: "mac-dev ", projectId: " shop-image-bakserver" },
      groups: [one],
    }),
    true,
    "成员对比较与出网前同口径（trim）",
  );
  assert.equal(
    removesLastGroupMember({ action: "remove", groupName: "g", member: { machineId: "m", projectId: "p" }, groups: [grp("g", [], 0)] }),
    true,
    "声明面持组却零成员 = 坏态，删谁都撞不变量 ⇒ 拦",
  );
});

test("removesLastGroupMember: 多成员组 / 增员 / 无该组 / 他组末位 ⇒ 不拦（remove 路径与既有语义不变）", () => {
  const two = grp("flow", [{ machineId: "a", projectId: "pa" }, { machineId: "b", projectId: "pb" }]);
  assert.equal(
    removesLastGroupMember({ action: "remove", groupName: "flow", member: { machineId: "a", projectId: "pa" }, groups: [two] }),
    false,
    "多成员组 remove 照旧出网",
  );
  assert.equal(
    removesLastGroupMember({ action: "add", groupName: "flow", member: { machineId: "a", projectId: "pa" }, groups: [grp("flow", [{ machineId: "a", projectId: "pa" }])] }),
    false,
    "增员不经本闸",
  );
  assert.equal(
    removesLastGroupMember({ action: "remove", groupName: "ghost", member: { machineId: "m", projectId: "p" }, groups: [two] }),
    false,
    "声明面无该组 = 幂等零写入，不得翻译成「末位不可删」",
  );
  assert.equal(
    removesLastGroupMember({ action: "remove", groupName: "flow", member: { machineId: "x", projectId: "y" }, groups: [two, grp("solo", [{ machineId: "m", projectId: "p" }])] }),
    false,
    "他组的末位不牵连本组；且删的不是本组在册成员 ⇒ 不拦",
  );
});

test("末位拒写文案 = 业务化单一口径（族名 + 展示句），不透传桥原文", () => {
  assert.equal(LAST_MEMBER_REMOVE_CODE, "board_last_member_remove");
  assert.equal(LAST_MEMBER_REMOVE_DISPLAY, "组织内仅剩一项目时，无法删除项目，请选择停用组织");
  assert.doesNotMatch(LAST_MEMBER_REMOVE_DISPLAY, /config_write|projectGroup|非空数组/, "浮层文案不出现桥术语");
});

// ---------------------------------------------------------------------------
// ④″ 加成员撞组间互斥的业务化文案（v0.9.4 增补五 §9.4-③ · 纯函数）
// ---------------------------------------------------------------------------

test("ownerOrgOfProject: 成员对精确命中优先；退而按 projectId 命中；皆无 ⇒ null（不臆造组织）", () => {
  const a = grp("org-a", [{ machineId: "mac-dev", projectId: "shop-image-bakserver" }]);
  const b = grp("org-b", [{ machineId: "mac-dev", projectId: "shop-image-bakserver" }]);
  assert.equal(ownerOrgOfProject([a, b], { machineId: "mac-dev", projectId: "shop-image-bakserver" }), "org-a", "首个配对命中");
  assert.equal(
    ownerOrgOfProject([a], { machineId: "other-machine", projectId: "shop-image-bakserver" }),
    "org-a",
    "同项目换了 machineId 登记 ⇒ 退 projectId 命中，仍能讲清在哪一组",
  );
  assert.equal(ownerOrgOfProject([a], { machineId: "m", projectId: "unknown-project" }), null, "查不到 ⇒ null");
  assert.equal(ownerOrgOfProject([], { machineId: "m", projectId: "p" }), null, "空投影 ⇒ null");
});

test("describeMemberGroupConflict: 命中 X ⇒ 新错误码 + 点名文案 + X 管理页链接（透传不出现桥原文）", () => {
  const groups = [grp("shop-image", [{ machineId: "mac-dev", projectId: "shop-image-bakserver" }])];
  const got = describeMemberGroupConflict({
    member: { machineId: "mac-dev", projectId: "shop-image-bakserver" },
    groups,
  });
  assert.equal(got.code, MEMBER_GROUP_CONFLICT_CODE);
  assert.equal(MEMBER_GROUP_CONFLICT_CODE, "board_member_group_conflict");
  assert.match(got.error, /该项目当前属于组织 shop-image/);
  assert.match(got.error, /移除成员/);
  assert.match(got.error, /停用会释放其成员/);
  assert.deepEqual(got.link, { href: "/org/shop-image/manage", label: "打开 shop-image 管理页" });
});

test("describeMemberGroupConflict: 查不到 X ⇒ 退通用文案、不给假链接（code 仍为业务码）", () => {
  const got = describeMemberGroupConflict({ member: { machineId: "m", projectId: "p" }, groups: [] });
  assert.equal(got.code, MEMBER_GROUP_CONFLICT_CODE);
  assert.equal(got.error, MEMBER_GROUP_CONFLICT_GENERIC);
  assert.equal(got.link, null, "不臆造组织名 ⇒ 不给链接");
  assert.doesNotMatch(got.error, /projectGroup|成员互斥：/, "不透传桥的不变量原文");
});

test("orgManageHref: 组织名 encodeURIComponent 进路径（含中文 / 特殊字符）", () => {
  assert.equal(orgManageHref("shop-image"), "/org/shop-image/manage");
  assert.equal(orgManageHref("组织甲"), "/org/%E7%BB%84%E7%BB%87%E7%94%B2/manage");
  assert.equal(orgManageHref("a b"), "/org/a%20b/manage");
});

test("DUPLICATE_MEMBER_CODE = 桥的重复成员码（同组重复与跨组互斥共用一码，板侧按声明面分流）", () => {
  assert.equal(DUPLICATE_MEMBER_CODE, "config_write_duplicate_member");
});

// ---------------------------------------------------------------------------
// ⑤ 出网链路（组身份 = 目标组织名；工具名单点）
// ---------------------------------------------------------------------------

test("writeGroupMembers: 出网 URL 带组身份首段 · arguments 恰三键 · 结果归一", async () => {
  const { fetchImpl, calls } = recordingFetch([
    okEnvelope({ ok: true, op: MEMBER_OP_REMOVE, groupName: "flow-team", changed: true, members: [], backedUpTo: "/bak/1" }),
  ]);
  const got = await writeGroupMembers(
    { op: MEMBER_OP_REMOVE, groupName: "flow-team", members: [{ machineId: "win-a", projectId: "board" }] },
    { group: "flow-team", baseUrl: "http://127.0.0.1:8787", fetchImpl },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/flow-team\/mcp$/);
  assert.equal(calls[0].body.params.name, CONFIG_WRITE_GROUP_TOOL);
  assert.deepEqual(Object.keys(calls[0].body.params.arguments).sort(), ["groupName", "members", "op"]);
  assert.equal(got.ok, true);
  assert.equal(got.changed, true);
  assert.deepEqual(got.members, []);
});

test("writeGroupMembers: 空组身份（null 身份不可用）先于网络抛出", async () => {
  let fetched = 0;
  await assert.rejects(
    writeGroupMembers(
      { op: MEMBER_OP_ADD, groupName: "g", members: [{ machineId: "m", projectId: "p" }] },
      { group: "  ", fetchImpl: async () => { fetched += 1; return new Response("{}"); } },
    ),
    GroupAdminConfigError,
  );
  assert.equal(fetched, 0);
});

test("buildMcpEndpoint: 组名编码进路径首段", () => {
  assert.equal(buildMcpEndpoint("http://h:8787", " flow-team "), "http://h:8787/flow-team/mcp");
});

// ---------------------------------------------------------------------------
// ⑥ 并发冲突的单次自动重读重试（其余码一律不重试）
// ---------------------------------------------------------------------------

test("writeGroupMembersWithRetry: concurrent_modification ⇒ 恰好重投一次（同一 op / 同一成员对）", async () => {
  const { fetchImpl, calls } = recordingFetch([
    okEnvelope({ ok: false, code: CONCURRENT_MODIFICATION_CODE, error: "处理途中被外部改动" }),
    okEnvelope({ ok: true, op: MEMBER_OP_ADD, groupName: "g", changed: true, members: [{ machineId: "m", projectId: "p" }], backedUpTo: "/bak/2" }),
  ]);
  const input = { op: MEMBER_OP_ADD, groupName: "g", members: [{ machineId: "m", projectId: "p" }] };
  const got = await writeGroupMembersWithRetry(input, { group: "g", fetchImpl });
  assert.equal(got.retriedOnce, true);
  assert.equal(calls.length, 2, "至多一次重投");
  assert.equal(got.outcome.ok, true);
  assert.deepEqual(calls[0].body.params.arguments, calls[1].body.params.arguments, "重投不改用户意图（同 op 同成员对）");
});

test("writeGroupMembersWithRetry: 重试仍并发冲突 ⇒ 如实上报（不循环重试）", async () => {
  const { fetchImpl, calls } = recordingFetch([
    okEnvelope({ ok: false, code: CONCURRENT_MODIFICATION_CODE, error: "a" }),
    okEnvelope({ ok: false, code: CONCURRENT_MODIFICATION_CODE, error: "b" }),
  ]);
  const got = await writeGroupMembersWithRetry(
    { op: MEMBER_OP_ADD, groupName: "g", members: [{ machineId: "m", projectId: "p" }] },
    { group: "g", fetchImpl },
  );
  assert.equal(calls.length, 2);
  assert.equal(got.outcome.ok, false);
  assert.equal(got.outcome.code, CONCURRENT_MODIFICATION_CODE);
});

test("writeGroupMembersWithRetry: 非并发码（duplicate / transport）零重试", async () => {
  for (const code of ["config_write_duplicate_member", "transport_error"]) {
    const { fetchImpl, calls } = recordingFetch([okEnvelope({ ok: false, code, error: "x" })]);
    const got = await writeGroupMembersWithRetry(
      { op: MEMBER_OP_ADD, groupName: "g", members: [{ machineId: "m", projectId: "p" }] },
      { group: "g", fetchImpl },
    );
    assert.equal(calls.length, 1, `${code} 不得触发重试`);
    assert.equal(got.retriedOnce, false);
    assert.equal(got.outcome.code, code);
  }
});

// ---------------------------------------------------------------------------
// ⑦ 死锁兜底（v0.9.4 §9-a）：member.add 撞组不存在 ⇒ 改发一次 group.add
// ---------------------------------------------------------------------------

test("§9-a 兜底：member.add 撞 group_not_found ⇒ 改发 group.add 带同一成员条目，成功即当成功", async () => {
  const { fetchImpl, calls } = recordingFetch([
    okEnvelope({ ok: false, code: GROUP_NOT_FOUND_CODE, error: "组不存在" }),
    okEnvelope({ ok: true, op: GROUP_ADD_OP, groupName: "g", changed: true, members: [{ machineId: "m", projectId: "p" }], backedUpTo: "/bak/9" }),
  ]);
  const got = await writeGroupMembersWithRetry(
    { op: MEMBER_OP_ADD, groupName: "g", members: [{ machineId: "m", projectId: "p" }] },
    { group: "g", fetchImpl },
  );
  assert.deepEqual(
    calls.map((c) => c.body.params.arguments.op),
    [MEMBER_OP_ADD, GROUP_ADD_OP],
    "调用序列 = 先 member.add、被拒后改发 group.add（唯一改发点）",
  );
  assert.equal(calls.every((c) => c.body.params.name === CONFIG_WRITE_GROUP_TOOL), true, "仍单工具、O1 契约零改动");
  assert.deepEqual(calls[1].body.params.arguments, { op: GROUP_ADD_OP, groupName: "g", members: [{ machineId: "m", projectId: "p" }] }, "兜底不改用户意图（同一成员条目）");
  assert.equal(got.outcome.ok, true);
  assert.equal(got.groupCreatedOnce, true);
  assert.equal(got.retriedOnce, false, "兜底 ≠ 并发重试（两码各自独立计数）");
});

test("§9-a 兜底只一次：group.add 仍被拒 ⇒ 如实上报该次失败，不再第三次出网", async () => {
  const { fetchImpl, calls } = recordingFetch([
    okEnvelope({ ok: false, code: GROUP_NOT_FOUND_CODE, error: "组不存在" }),
    okEnvelope({ ok: false, code: "config_write_io_failed", error: "写盘失败" }),
  ]);
  const got = await writeGroupMembersWithRetry(
    { op: MEMBER_OP_ADD, groupName: "g", members: [{ machineId: "m", projectId: "p" }] },
    { group: "g", fetchImpl },
  );
  assert.equal(calls.length, 2, "兜底仅一次，不级联");
  assert.equal(got.outcome.ok, false);
  assert.equal(got.outcome.code, "config_write_io_failed");
  assert.equal(got.groupCreatedOnce, false);
});

test("§9-a 兜底不作用于 remove（删不存在组的成员 ≠ 建组）· 也不作用于 add 之外的其它码", async () => {
  const rm = recordingFetch([okEnvelope({ ok: false, code: GROUP_NOT_FOUND_CODE, error: "组不存在" })]);
  const got = await writeGroupMembersWithRetry(
    { op: MEMBER_OP_REMOVE, groupName: "g", members: [{ machineId: "m", projectId: "p" }] },
    { group: "g", fetchImpl: rm.fetchImpl },
  );
  assert.equal(rm.calls.length, 1, "remove 撞组不存在 ⇒ 原样上报 409，绝不建组");
  assert.equal(got.outcome.code, GROUP_NOT_FOUND_CODE);
});

test("§9-a 与并发重试不叠加：member.add 先撞 concurrent 重投后仍 concurrent ⇒ 不落入组兜底分支", async () => {
  const { fetchImpl, calls } = recordingFetch([
    okEnvelope({ ok: false, code: CONCURRENT_MODIFICATION_CODE, error: "a" }),
    okEnvelope({ ok: false, code: GROUP_NOT_FOUND_CODE, error: "组被并发移除" }),
  ]);
  const got = await writeGroupMembersWithRetry(
    { op: MEMBER_OP_ADD, groupName: "g", members: [{ machineId: "m", projectId: "p" }] },
    { group: "g", fetchImpl },
  );
  assert.equal(calls.length, 2, "重投消费掉唯一一次 ⇒ 组不存在按原样上报");
  assert.equal(got.retriedOnce, true);
  assert.equal(got.groupCreatedOnce, false);
  assert.equal(got.outcome.code, GROUP_NOT_FOUND_CODE);
});

// ---------------------------------------------------------------------------
// ⑧ 停用释放成员（v0.9.4 增补五 §9.4-①）：group.remove 装配 + 幂等放行
// ---------------------------------------------------------------------------

test("buildConfigRemoveGroupArgs: 键集合恰好 = {op, groupName}（不携带 members 与任何其它配置段）· op = group.remove", () => {
  const args = buildConfigRemoveGroupArgs({ groupName: " flow-team " });
  assert.deepEqual(Object.keys(args).sort(), ["groupName", "op"]);
  assert.equal(args.op, GROUP_REMOVE_OP);
  assert.equal(GROUP_REMOVE_OP, "group.remove");
  assert.equal(args.groupName, "flow-team", "组名 trim（同成员写口径）");
  assert.equal("members" in args, false, "group.remove 不消费成员集（O1 契约）");
});

test("buildConfigRemoveGroupArgs: 空组名 = 编程错误抛出（不发半截写）", () => {
  assert.throws(() => buildConfigRemoveGroupArgs({ groupName: "  " }), GroupAdminConfigError);
  assert.throws(() => buildConfigRemoveGroupArgs({ groupName: "" }), GroupAdminConfigError);
});

test("releaseOrgGroup: 出网 URL 带组身份首段 · arguments 恰 {op:group.remove, groupName} · 成功归一", async () => {
  const { fetchImpl, calls } = recordingFetch([
    okEnvelope({ ok: true, op: GROUP_REMOVE_OP, groupName: "shop-image", changed: true, backedUpTo: "/bak/rm" }),
  ]);
  const got = await releaseOrgGroup({ groupName: "shop-image" }, { group: "shop-image", baseUrl: "http://127.0.0.1:8787", fetchImpl });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/shop-image\/mcp$/);
  assert.equal(calls[0].body.params.name, CONFIG_WRITE_GROUP_TOOL, "仍单工具单封装（O1 契约零改动）");
  assert.deepEqual(calls[0].body.params.arguments, { op: GROUP_REMOVE_OP, groupName: "shop-image" });
  assert.equal(got.ok, true);
  assert.equal(got.changed, true);
  assert.equal(got.backedUpTo, "/bak/rm");
});

test("releaseOrgGroup: 组段本不存在（group_not_found）⇒ 幂等放行（ok:true / changed:false），不上报 409", async () => {
  const { fetchImpl, calls } = recordingFetch([
    okEnvelope({ ok: false, code: GROUP_NOT_FOUND_CODE, error: "组不存在" }),
  ]);
  const got = await releaseOrgGroup({ groupName: "新建未挂成员" }, { group: "新建未挂成员", fetchImpl });
  assert.equal(calls.length, 1, "幂等放行不重试（非并发码）");
  assert.equal(got.ok, true, "组段本不存在 = 停用前无成员可释放 ⇒ 视为成功");
  assert.equal(got.changed, false, "changed:false = 无实际变更（幂等）");
  assert.equal(got.op, GROUP_REMOVE_OP);
  assert.equal(got.groupName, "新建未挂成员");
});

test("releaseOrgGroup: 其余失败码原样上报（由停用 handler 判「停用整体失败」，不吞不降级）", async () => {
  for (const code of ["config_write_io_failed", CONCURRENT_MODIFICATION_CODE, "config_write_dry_run_rejected", "transport_error"]) {
    const { fetchImpl, calls } = recordingFetch([okEnvelope({ ok: false, code, error: "x" })]);
    const got = await releaseOrgGroup({ groupName: "g" }, { group: "g", fetchImpl });
    assert.equal(calls.length, 1, `${code} 不得触发重试/兜底（group.remove 无重试路径）`);
    assert.equal(got.ok, false, code);
    assert.equal(got.code, code, "失败码原样上报");
  }
});

test("releaseOrgGroup: 空组身份（null 身份不可用）先于网络抛出", async () => {
  let fetched = 0;
  await assert.rejects(
    releaseOrgGroup({ groupName: "g" }, { group: "  ", fetchImpl: async () => { fetched += 1; return new Response("{}"); } }),
    GroupAdminConfigError,
  );
  assert.equal(fetched, 0);
});
