import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";
import {
  MEMBER_OP_ADD,
  MEMBER_OP_REMOVE,
  GROUP_NOT_FOUND_DISPLAY,
  LAST_MEMBER_REMOVE_DISPLAY,
  MEMBER_GROUP_CONFLICT_CODE,
  MEMBER_GROUP_CONFLICT_GENERIC,
} from "../dist/group-admin.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const WRITE_HEADERS = { "x-board-write": "1", accept: "application/json" };

/** 成员写以目标组织名为连接身份；页面条目只需一条假需求 + 空项目清单。 */
function fakeClient() {
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return {
        features: [
          {
            featureId: "F1", state: "waiting_approval", title: "甲", taskCount: 1,
            ownerGroup: "flow-team", stage: "需求分析", version: "", approval: "未发起",
            createdAt: "c", updatedAt: "u",
          },
        ],
        stateCounts: null,
      };
    },
    async getProjects() {
      return { projects: [] };
    },
  };
}

/** 可注入的成员写实现：记录每次调用入参，按脚本依次返回 outcome（末值复用）。 */
function memberWriteStub(scripts) {
  const calls = [];
  let i = 0;
  const impl = async (input, options) => {
    calls.push({ input, options });
    const script = scripts[Math.min(i, scripts.length - 1)];
    i += 1;
    if (typeof script === "function") return script(input, options);
    return script;
  };
  return { calls, impl };
}

const okSuccess = (over = {}) => ({
  outcome: {
    ok: true,
    op: MEMBER_OP_ADD,
    groupName: "flow-team",
    changed: true,
    members: [{ machineId: "win-a", projectId: "board" }],
    backedUpTo: "G:/orch/config.json.bak-2026-09-27",
    ...over,
  },
  retriedOnce: false,
  groupCreatedOnce: false,
});

const failWith = (code, error = "桥侧原文") => ({
  outcome: { ok: false, code, error },
  retriedOnce: false,
  groupCreatedOnce: false,
});

async function withServer(memberWriteImpl, run, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "board-members-http-"));
  const orgsRoot = join(dir, "orgs");
  mkdirSync(orgsRoot, { recursive: true });
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: fakeClient(),
    now: () => NOW,
    docs: { repoRoot: dir, orgsDir: orgsRoot },
    orgsLedgerFile: join(dir, "data", "orgs.json"),
    orgProjectsFetcher: async () => ({ ok: true, projects: [] }),
    orgGroupsFetcher: async () => ({ ok: true, groups: [], warnings: [], observedAt: null }),
    groupMemberWriteImpl: memberWriteImpl,
    ...extra,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, dir);
  } finally {
    await handle.close();
  }
}

function postMembers(base, org, form, headers = {}) {
  return fetch(`${base}/orgs/${encodeURIComponent(org)}/members`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

// ---------------------------------------------------------------------------
// ① CSRF 先于一切，且不消耗注入实现
// ---------------------------------------------------------------------------

test("BD4-①（负向）：跨站 Origin ⇒ 403 CSRF，成员写实现零触达、台账不写", async () => {
  const { calls, impl } = memberWriteStub([okSuccess()]);
  await withServer(impl, async (base, dir) => {
    const res = await postMembers(
      base, "flow-team", { action: "add", machineId: "win-a", projectId: "board" },
      { origin: "http://evil.example:80" },
    );
    assert.equal(res.status, 403);
    assert.deepEqual(calls, [], "未认证的写请求不得出网");
    assert.equal(existsSync(join(dir, "data", "orgs.json")), false, "成员写不动板台账");
  });
});

// ---------------------------------------------------------------------------
// ② 校验闭集：URL 段组织名 / action / 成员对
// ---------------------------------------------------------------------------

test("BD4-②（负向）：URL 段非法组织名 ⇒ 400 board_org_name_invalid（单一事实源，不出网）", async () => {
  const { calls, impl } = memberWriteStub([okSuccess()]);
  await withServer(impl, async (base) => {
    // 点段（`.` / `..`）在 URL 归一层即被消解（请求根本到不了本路由），板侧闭集校验的该档由 write-guard 单测钉住；
    // 纯空白段 = 空段 ⇒ 径不匹配落 404（同样到不了校验器）
    for (const org of ["a b", "a#b", "a?b", "a%b", "a/b", "a\\b", "a..b"]) {
      const res = await postMembers(base, org, { action: "add", machineId: "m", projectId: "p" }, WRITE_HEADERS);
      assert.equal(res.status, 400, JSON.stringify(org));
      assert.equal((await res.json()).code, "board_org_name_invalid", JSON.stringify(org));
    }
    assert.deepEqual(calls, []);
  });
});

test("BD4-③（负向 · action 闭集）：缺失 / 越界（create、group.add…）⇒ 400 board_member_action_invalid，不猜动作", async () => {
  const { calls, impl } = memberWriteStub([okSuccess()]);
  await withServer(impl, async (base) => {
    for (const action of ["", "group.add", "create", "disable", "ADD"]) {
      const form = { machineId: "m", projectId: "p" };
      if (action !== "") form.action = action;
      const res = await postMembers(base, "flow-team", form, WRITE_HEADERS);
      assert.equal(res.status, 400, `action=${JSON.stringify(action)} 必须 400`);
      assert.equal((await res.json()).code, "board_member_action_invalid", action);
    }
    assert.deepEqual(calls, [], "动作不合法 ⇒ 绝不向桥发任何 op");
  });
});

test("BD4-④（负向）：成员对不全（缺 machineId / 空 projectId）⇒ 400 board_member_pair_missing，不出网", async () => {
  const { calls, impl } = memberWriteStub([okSuccess()]);
  await withServer(impl, async (base) => {
    for (const form of [
      { action: "add", machineId: "m" },
      { action: "add", projectId: "p" },
      { action: "add", machineId: "  ", projectId: "p" },
      { action: "remove" },
    ]) {
      const res = await postMembers(base, "flow-team", form, WRITE_HEADERS);
      assert.equal(res.status, 400, JSON.stringify(form));
      assert.equal((await res.json()).code, "board_member_pair_missing", JSON.stringify(form));
    }
    assert.deepEqual(calls, []);
  });
});

// ---------------------------------------------------------------------------
// ③ 出网入参：action → op 双子集映射 · 组身份 = 目标组织名
// ---------------------------------------------------------------------------

test("BD4-⑤（正向 · 入参映射）：add→group.member.add / remove→group.member.remove，组身份 = 组织名", async () => {
  const { calls, impl } = memberWriteStub([okSuccess(), okSuccess({ op: MEMBER_OP_REMOVE, backedUpTo: null })]);
  await withServer(impl, async (base) => {
    const add = await postMembers(base, "flow-team", { action: "add", machineId: " win-a ", projectId: "board " }, WRITE_HEADERS);
    assert.equal(add.status, 200);
    const rm = await postMembers(base, "flow-team", { action: "remove", machineId: "win-a", projectId: "board" }, WRITE_HEADERS);
    assert.equal(rm.status, 200);
    assert.equal(calls[0].input.op, MEMBER_OP_ADD);
    assert.equal(calls[1].input.op, MEMBER_OP_REMOVE);
    assert.deepEqual(calls[0].input.members, [{ machineId: "win-a", projectId: "board" }], "提交前 trim");
    assert.equal(calls[0].input.groupName, "flow-team");
    assert.equal(calls[0].options.group, "flow-team", "连接身份 = 目标组织");
    assert.notEqual(calls[0].options.baseUrl, undefined, " baseUrl 随板配置传入（可切端点）");
  });
});

// ---------------------------------------------------------------------------
// ④ 错误映射读面（HTTP 状态 + 保守文案 + 不可达引导）
// ---------------------------------------------------------------------------

test("BD4-⑥（错误映射）：闭集码按表给状态；group_not_found 走保守文案（不转译桥原文）", async () => {
  const cases = [
    ["config_write_dry_run_rejected", 422, "组段校验未过：members 含未知机器"],
    ["config_write_unknown_machine", 422, "机器 win-z 不在桥配置"],
    ["config_write_io_failed", 500, "写盘失败，当前 config 原样"],
  ];
  for (const [code, status, bridgeText] of cases) {
    const { impl } = memberWriteStub([failWith(code, bridgeText)]);
    await withServer(impl, async (base) => {
      const res = await postMembers(base, "flow-team", { action: "add", machineId: "m", projectId: "p" }, WRITE_HEADERS);
      assert.equal(res.status, status, code);
      const json = await res.json();
      assert.equal(json.code, code, "错误码原样可排查");
      assert.equal(json.error, bridgeText, "其余闭集码透传桥原文");
    });
  }
  const { impl } = memberWriteStub([failWith("config_write_group_not_found", "bridge internal path /abs/orch/config.json")]);
  await withServer(impl, async (base) => {
    const res = await postMembers(base, "ghost", { action: "add", machineId: "m", projectId: "p" }, WRITE_HEADERS);
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.error, GROUP_NOT_FOUND_DISPLAY);
    assert.match(json.error, /目标组不存在（或已被移除）/);
    assert.ok(!json.error.includes("/abs/orch"), "桥原文不渗到板读面");
  });
});

test("§9.4-③（正向 · 互斥业务化）：add 撞 duplicate + 声明面命中 X ⇒ 409 board_member_group_conflict + 点名文案 + X 管理页链接", async () => {
  const bridgeText = "组间成员互斥：{mac-dev, shop-image-bakserver} 同时出现在 projectGroup[1] 与 [2]";
  const withOwner = {
    orgGroupsFetcher: async () => ({
      ok: true,
      observedAt: null,
      warnings: [],
      groups: [
        {
          name: "shop-image-org",
          members: [{ machineId: "mac-dev", projectId: "shop-image-bakserver" }],
          memberCount: 1,
          observedAt: null,
          warnings: [],
        },
      ],
    }),
  };
  // JSON 档：新业务码 + 点名文案 + 不透传桥原文
  const { impl } = memberWriteStub([failWith("config_write_duplicate_member", bridgeText)]);
  await withServer(
    impl,
    async (base) => {
      const res = await postMembers(base, "new-org", { action: "add", machineId: "mac-dev", projectId: "shop-image-bakserver" }, WRITE_HEADERS);
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.code, MEMBER_GROUP_CONFLICT_CODE);
      assert.match(body.error, /该项目当前属于组织 shop-image-org/);
      assert.match(body.error, /移除成员/);
      assert.ok(!body.error.includes("projectGroup"), "桥的 projectGroup 不变量原文不进读面");
    },
    withOwner,
  );
  // 表单档：卡内 + 页面上均带 X 的 manage 页链接
  const { impl: impl2 } = memberWriteStub([failWith("config_write_duplicate_member", bridgeText)]);
  await withServer(
    impl2,
    async (base) => {
      const res = await postMembers(
        base,
        "new-org",
        { action: "add", machineId: "mac-dev", projectId: "shop-image-bakserver" },
        { "x-board-write": "1", accept: "text/html" },
      );
      assert.equal(res.status, 409);
      const text = await res.text();
      assert.match(text, /board_member_group_conflict/);
      assert.match(text, /href="\/org\/shop-image-org\/manage"/);
      assert.match(text, /打开 shop-image-org 管理页/);
      assert.ok(!text.includes("projectGroup"), "桥原文不渗到浮层");
    },
    withOwner,
  );
});

test("§9.4-③（退化）：add 撞 duplicate 但声明面查不到 X ⇒ 通用文案、不给假链接（仍用业务码）", async () => {
  const { impl } = memberWriteStub([failWith("config_write_duplicate_member", "duplicate 桥原文")]);
  await withServer(impl, async (base) => {
    const res = await postMembers(
      base,
      "new-org",
      { action: "add", machineId: "m", projectId: "p" },
      { "x-board-write": "1", accept: "text/html" },
    );
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.match(text, /board_member_group_conflict/);
    assert.match(text, /已在某个组织的成员登记中/);
    assert.ok(!/\/org\/[^"]+\/manage/.test(text), "不臆造组织名 ⇒ 不给 manage 链接");
  });
});

test("§9.4-③（负向 · 仅 add 路径）：remove 撞 duplicate ⇒ 仍原码透传（互斥引导不服务删路径）", async () => {
  const { impl } = memberWriteStub([failWith("config_write_duplicate_member", "成员已在组内")]);
  await withServer(impl, async (base) => {
    const res = await postMembers(base, "flow-team", { action: "remove", machineId: "m", projectId: "p" }, WRITE_HEADERS);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "config_write_duplicate_member");
    assert.equal(body.error, "成员已在组内");
  });
});

test("BD4-⑦（不可达档）：非闭集码（transport / http_503 / 坏信封）⇒ 502 + 「不降级本地直写」引导", async () => {
  for (const code of ["transport_error", "http_503", "response_invalid"]) {
    const { impl } = memberWriteStub([failWith(code, "桥不可达")]);
    await withServer(impl, async (base) => {
      const res = await postMembers(base, "flow-team", { action: "add", machineId: "m", projectId: "p" }, WRITE_HEADERS);
      assert.equal(res.status, 502, code);
      const json = await res.json();
      assert.equal(json.code, code);
      assert.match(json.error, /编排桥（MCP 面）不可达/);
      assert.match(json.error, /不会降级去本地直写/);
    });
  }
});

test("BD4-⑧（并发档）：重投仍被拒 ⇒ 状态按闭集 + 浮层 hint 说明已自动重试一次", async () => {
  const { calls, impl } = memberWriteStub([
    { ...failWith("config_write_concurrent_modification", "并发"), retriedOnce: true },
  ]);
  await withServer(impl, async (base) => {
    const res = await postMembers(
      base, "flow-team", { action: "remove", machineId: "m", projectId: "p" },
      { "x-board-write": "1", accept: "text/html" },
    );
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.match(text, /config_write_concurrent_modification/);
    assert.match(text, /自动重读重试一次/);
    assert.equal(calls.length, 1, "重试策略在封装内，路由层不再重投");
  });
});

// ---------------------------------------------------------------------------
// ⑤ 成功回执：JSON 载荷 / 表单档整页卡片（backedUpTo 展示 + G11 引导）
// ---------------------------------------------------------------------------

test("BD4-⑨（正向 · JSON 档）：200 载荷含 op/changed/members/backedUpTo/retriedOnce；add 带 G11 引导，remove 不带", async () => {
  const { impl } = memberWriteStub([okSuccess(), okSuccess({ op: MEMBER_OP_REMOVE, changed: false, backedUpTo: null })]);
  await withServer(impl, async (base) => {
    const add = await postMembers(base, "flow-team", { action: "add", machineId: "win-a", projectId: "board" }, WRITE_HEADERS);
    assert.equal(add.status, 200);
    const aj = await add.json();
    assert.equal(aj.ok, true);
    assert.equal(aj.op, MEMBER_OP_ADD);
    assert.equal(aj.changed, true);
    assert.deepEqual(aj.members, [{ machineId: "win-a", projectId: "board" }]);
    assert.equal(aj.backedUpTo, "G:/orch/config.json.bak-2026-09-27");
    assert.equal(aj.retriedOnce, false);
    assert.match(aj.note, /重启该机 Launcher/);

    const rm = await postMembers(base, "flow-team", { action: "remove", machineId: "win-a", projectId: "board" }, WRITE_HEADERS);
    const rj = await rm.json();
    assert.equal("note" in rj, false, "删成员无驻留尾巴 ⇒ 不塞引导");
    assert.equal(rj.changed, false, "幂等零写入如实回报");
  });
});

test("BD4-⑩（正向 · 表单档）：200 整页含成功卡（备份路径 + 成员清单 + G11），不写板台账", async () => {
  const { impl } = memberWriteStub([okSuccess()]);
  await withServer(impl, async (base, dir) => {
    const res = await postMembers(
      base, "flow-team", { action: "add", machineId: "win-a", projectId: "board" },
      { origin: base, accept: "text/html" },
    );
    assert.equal(res.status, 200, "有内容回执的档仍出整页（N7 口径），不 303");
    const text = await res.text();
    assert.match(text, /成员写成功/);
    assert.match(text, /G:\/orch\/config\.json\.bak-2026-09-27/);
    assert.match(text, /重启该机 Launcher/);
    assert.match(text, /win-a/);
    // §9-c：成员写的成功回执宿主页 = 该组织空间的管理页（`/orgs` 页退役 ⇒ 落点随宿主迁）
    assert.match(text, /<a class="fl on" href="\/org\/flow-team\/manage" style="font-weight:700">管理<\/a>/, "回执整页带空间管理页导航（当前视图 = 管理）");
    assert.equal(existsSync(join(dir, "data", "orgs.json")), false, "成员写落点在 orch，不动板台账");
  });
});

test("BD4-⑨b（正向 · §9-a 兜底回显）：封装报告已建组 ⇒ JSON 带 groupCreated=true（普通加成员为 false）", async () => {
  const { impl } = memberWriteStub([
    { ...okSuccess({ op: "group.add" }), groupCreatedOnce: true },
    okSuccess({ op: MEMBER_OP_REMOVE }),
  ]);
  await withServer(impl, async (base) => {
    const first = await postMembers(base, "新组织", { action: "add", machineId: "win-a", projectId: "board" }, WRITE_HEADERS);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).groupCreated, true, "建组带首成员一事须在回执上可见");
    const second = await postMembers(base, "flow-team", { action: "add", machineId: "win-a", projectId: "board" }, WRITE_HEADERS);
    assert.equal((await second.json()).groupCreated, false);
  });
});

// ---------------------------------------------------------------------------
// ⑥ 方法门锚：八条写路径清单
// ---------------------------------------------------------------------------
test("BD4-⑪（方法门锚）：PUT /orgs ⇒ 405 文案列全八条（含 POST /orgs/{org}/members）；成员径 PUT ⇒ 404", async () => {
  const { calls, impl } = memberWriteStub([okSuccess()]);
  await withServer(impl, async (base) => {
    const res = await fetch(`${base}/orgs`, { method: "PUT" });
    assert.equal(res.status, 405);
    const text = await res.text();
    assert.match(text, /仅支持 GET/);
    assert.ok(text.includes("POST /orgs/{org}/members"), "405 文案单点 = WRITE_ROUTES，须随白名单同步");
    for (const p of [
      "POST /requirements",
      "POST /features/{id}/turn",
      "POST /host/{org}/stop",
      "POST /features/{id}/confirm",
      "POST /features/{id}/answer",
      "POST /features/{id}/schedule",
      "POST /orgs",
    ]) {
      assert.ok(text.includes(p), `405 文案须含 ${p}`);
    }
    // 成员径不是读面页路径 ⇒ 非 POST 方法落 404（不新增任何隐式写径）
    for (const method of ["PUT", "DELETE", "GET"]) {
      const miss = await fetch(`${base}/orgs/flow-team/members`, { method });
      assert.equal(miss.status, 404, method);
    }
    assert.deepEqual(calls, [], "非 POST 方法不出网");
  });
});

// ---------------------------------------------------------------------------
// ⑦ 末位成员写前闸（v0.9.4 增补二 §9.1-①：业务化拒写 · 不调 O1 · 不出网）
// ---------------------------------------------------------------------------

/** 声明面投影构造（3300 `GET /api/groups` 形状）。 */
const declaredGroups = (...groups) => async () => ({ ok: true, groups, warnings: [], observedAt: null });
const soloGroup = {
  name: "shop-image",
  memberCount: 1,
  members: [{ machineId: "mac-dev", projectId: "shop-image-bakserver" }],
};
const SOLO_PAIR = { action: "remove", machineId: "mac-dev", projectId: "shop-image-bakserver" };

test("BD4-⑫（末位闸 · 表单档）：单成员组 remove ⇒ 409 浮层业务文案，成员写实现零触达，桥原文不进浮层", async () => {
  const { calls, impl } = memberWriteStub([failWith("config_write_dry_run_rejected", "projectGroup[].members 必须是非空数组")]);
  await withServer(impl, async (base) => {
    const res = await postMembers(
      base, "shop-image", SOLO_PAIR,
      { "x-board-write": "1", accept: "text/html" },
    );
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.match(text, /board_last_member_remove/);
    assert.match(text, /组织内仅剩一项目时，无法删除项目，请选择停用组织/);
    assert.match(text, /组织仅剩一项目/, "错误卡族名（中文族，不是桥术语）");
    assert.ok(!text.includes("projectGroup[].members"), "桥不变量原文绝不进浮层");
    assert.ok(!text.includes("config_write_dry_run_rejected"), "桥错误码不进浮层");
    assert.deepEqual(calls, [], "写前闸 ⇒ 不调 O1、不出网");
  }, { orgGroupsFetcher: declaredGroups(soloGroup) });
});

test("BD4-⑫b（末位闸 · JSON 档）：同一业务拒绝载荷（码 + 文案），不出网", async () => {
  const { calls, impl } = memberWriteStub([okSuccess()]);
  await withServer(impl, async (base) => {
    const res = await postMembers(base, "shop-image", SOLO_PAIR, WRITE_HEADERS);
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.code, "board_last_member_remove");
    assert.equal(json.error, LAST_MEMBER_REMOVE_DISPLAY);
    assert.deepEqual(calls, []);
  }, { orgGroupsFetcher: declaredGroups(soloGroup) });
});

test("BD4-⑬（负向护栏）：多成员组 remove 照旧出网 · 声明面无该组不拦（幂等零写入）· add 不经闸", async () => {
  const { calls, impl } = memberWriteStub([okSuccess({ op: MEMBER_OP_REMOVE })]);
  const groups = declaredGroups({
    name: "flow",
    memberCount: 2,
    members: [{ machineId: "win-a", projectId: "board" }, { machineId: "mac-b", projectId: "orch" }],
  });
  await withServer(impl, async (base) => {
    const rm = await postMembers(base, "flow", { action: "remove", machineId: "win-a", projectId: "board" }, WRITE_HEADERS);
    assert.equal(rm.status, 200);
    const ghost = await postMembers(base, "nosuch", { action: "remove", machineId: "m", projectId: "p" }, WRITE_HEADERS);
    assert.equal(ghost.status, 200, "声明面无该组 = 幂等零写入，仍交 O1 判");
    const add = await postMembers(base, "flow", { action: "add", machineId: "win-c", projectId: "x" }, WRITE_HEADERS);
    assert.equal(add.status, 200);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].input.op, MEMBER_OP_REMOVE);
  }, { orgGroupsFetcher: groups });
});

test("BD4-⑭（降级档）：3300 聚合面不可达 ⇒ 闸不拦（照旧出网交 O1），页面不炸", async () => {
  const { calls, impl } = memberWriteStub([failWith("config_write_dry_run_rejected", "projectGroup[].members 必须是非空数组")]);
  await withServer(impl, async (base) => {
    const res = await postMembers(base, "shop-image", SOLO_PAIR, WRITE_HEADERS);
    assert.equal(res.status, 422, "闸失效时退回既有桥错误映射档（不静默放行成功）");
    assert.equal((await res.json()).code, "config_write_dry_run_rejected");
    assert.equal(calls.length, 1, "闸只读声明面，不吞出网调用");
  }, { orgGroupsFetcher: async () => ({ ok: false, code: "groups_unreachable", error: "3300 down" }) });
});
