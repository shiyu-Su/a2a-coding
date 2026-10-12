/**
 * REQ-2026-09-26-01 v0.9.4 · BD3「删除 = 台账标记停用 + 停用闸」（改造文档 §2.1-A3/A4）。
 *
 * 四组负例门禁：
 * ① 拒删闸 —— 名下有活跃宿主桥 ⇒ 409 board_org_has_active_bridge + 引导「先逐桥 stop 再删」，零台账写；
 * ② 停用闸 —— host-face orgBridgeConfig 命中停用台账 ⇒ 结构化 board_org_disabled（不起桥、不 spawn）；
 * ③ 过滤两处 —— 停用组织空间 410（§9-c 起 `/orgs` 页退役 ⇒ 停用表单宿主 = 空间管理页）+
 *    建组织查重把停用名视为可重建（同名重建零迁移）；
 * ④ 提需求拒绝 —— handleWriteRequirement 命中停用台账 ⇒ 409 board_org_disabled，不触达写封装。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  emptyOrgsLedger,
  addOrg,
  disableOrg,
  isOrgDisabled,
  enabledOrgNames,
  disabledOrgNames,
  findOrgRecord,
  OrgsLedgerStore,
} from "../dist/orgs-ledger.js";
import { findOrgNameConflict, ORG_ACTION_INVALID_CODE, ORG_NAME_INVALID_CODE } from "../dist/write-guard.js";
import { ORG_DISABLED, isActiveBridgeState, orgBridgeConfig } from "../dist/host-face.js";
import { createBoardServer } from "../dist/server.js";

const NOW_ISO = "2026-09-27T12:00:00.000Z";

// ---------------------------------------------------------------------------
// 台账纯函数层：停用标记 / 幂等 / 同名复活（零迁移）
// ---------------------------------------------------------------------------

test("BD3-台账①：disableOrg —— 在用记录写 disabledAt；未登记名补建停用记录；已停用幂等（保留首次时刻）", () => {
  let { ledger } = addOrg(emptyOrgsLedger(), "甲");
  assert.equal(isOrgDisabled(ledger, "甲"), false);

  const first = disableOrg(ledger, "甲", NOW_ISO);
  assert.equal(first.changed, true);
  assert.equal(isOrgDisabled(first.ledger, "甲"), true);
  assert.deepEqual(disabledOrgNames(first.ledger), ["甲"]);
  assert.deepEqual(enabledOrgNames(first.ledger), []);

  const again = disableOrg(first.ledger, "甲", "2027-01-01T00:00:00.000Z");
  assert.equal(again.changed, false, "已停用 ⇒ 幂等不写");
  assert.equal(again.ledger, first.ledger, "纯函数：幂等路径原样返回");
  assert.equal(findOrgRecord(again.ledger, "甲").disabledAt, NOW_ISO, "保留首次停用时刻");

  const phantom = disableOrg(emptyOrgsLedger(), "从未登记", NOW_ISO);
  assert.equal(phantom.changed, true, "盘上/需求里存在但台账无记录的组织 ⇒ 停用要补建记录");
  assert.equal(isOrgDisabled(phantom.ledger, "从未登记"), true);
});

test("BD3-台账②：addOrg 同名重建 = 复活停用记录（零迁移）；未停用同名仍 added=false", () => {
  const disabled = disableOrg(addOrg(emptyOrgsLedger(), "甲").ledger, "甲", NOW_ISO).ledger;
  const revived = addOrg(disabled, "甲");
  assert.equal(revived.added, true, "停用名 ⇒ 重建放行（复活）");
  assert.equal(findOrgRecord(revived.ledger, "甲").disabledAt, null);
  assert.equal(revived.ledger.orgs.length, 1, "复活是原地改写，不得叠第二条");

  const stillEnabled = addOrg(addOrg(emptyOrgsLedger(), "乙").ledger, "乙");
  assert.equal(stillEnabled.added, false, "在用同名 ⇒ 维持 BD1 幂等拒");
});

test("BD3-过滤②：findOrgNameConflict 停用名豁免三源查重（盘上目录未删也算可重建）", () => {
  const u = { disk: ["甲"], ledger: [], featureGroups: ["甲"], disabled: ["甲"] };
  assert.equal(findOrgNameConflict("甲", u), null, "停用名先于三源豁免（同名重建零迁移）");
  assert.equal(findOrgNameConflict("乙", { ...u, disk: ["乙"] }), "disk", "非停用名照常判重");
  assert.equal(findOrgNameConflict("甲", { disk: ["甲"], ledger: [], featureGroups: [] }), "disk", "缺省无 disabled ⇒ BD1 口径不变");
});

// ---------------------------------------------------------------------------
// 停用闸②（host-face）：spawn/ensure 唯一配置入口命中停用台账
// ---------------------------------------------------------------------------

test("BD3-闸②：orgBridgeConfig —— isOrgDisabled 命中 ⇒ board_org_disabled；未命中 ⇒ 正常配置；prepareWorkspace 不受影响（本函数不 mkdir）", () => {
  const deps = { orgsDir: "/orgs-root", kind: "claude", isOrgDisabled: (org) => org === "停用组" };
  const off = orgBridgeConfig(deps, "停用组");
  assert.equal("error" in off, true);
  assert.equal(off.error.code, ORG_DISABLED);
  assert.equal(ORG_DISABLED, "board_org_disabled");
  assert.match(off.error.message, /不起桥、不 spawn/);
  assert.match(off.error.message, /同名重新建组织/);

  const on = orgBridgeConfig(deps, "在用组");
  assert.equal("error" in on, false);
  assert.equal(on.workspace, resolve("/orgs-root", "在用组"), "workspace = <组织根>/<组织名>（口径不动）");

  const ungated = orgBridgeConfig({ orgsDir: "/orgs-root" }, "停用组");
  assert.equal("error" in ungated, false, "未注入 isOrgDisabled ⇒ 不判停用（BD1–BD2 期间行为）");
});

test("BD3-闸②b：isActiveBridgeState 闭集 —— running/starting/unreachable 活跃；exited/failed 不活跃", () => {
  for (const s of ["running", "starting", "unreachable"]) assert.equal(isActiveBridgeState(s), true, s);
  for (const s of ["exited", "failed"]) assert.equal(isActiveBridgeState(s), false, s);
});

// ---------------------------------------------------------------------------
// HTTP 面脚手架
// ---------------------------------------------------------------------------

function fakeClient(ownerGroups = ["在用组"]) {
  return {
    async getFeatures() {
      return {
        features: ownerGroups.map((g, i) => ({
          featureId: `F${String(i + 1)}`,
          state: "waiting_approval",
          title: `需求${String(i + 1)}`,
          taskCount: 1,
          ownerGroup: g,
          stage: "需求分析",
          version: "",
          approval: "未发起",
          createdAt: "c",
          updatedAt: "u",
        })),
        stateCounts: null,
      };
    },
    async getFeature() { throw new Error("不该被 BD3 用例触达"); },
    async getFeatureTrace() { throw new Error("不该被 BD3 用例触达"); },
    async getProjects() { throw new Error("不该被 BD3 用例触达"); },
    async getTasks() { throw new Error("不该被 BD3 用例触达"); },
  };
}

/** 假宿主面：只实现 BD3 写面与 /orgs 页用到的四个口。 */
function fakeHostFace({ bridges = [], orgsDir = "R/orgs" } = {}) {
  const stops = [];
  return {
    stops,
    activeBridgesFor: (org) => bridges.filter((b) => b.org === org && isActiveBridgeState(b.state)),
    managedOrgs: () => bridges.map((b) => b.org),
    configView: () => ({ orgsDir, defaultOrg: null, kind: "claude" }),
    orgsDirProblem: () => null,
    async stopBridge(org) {
      stops.push(org);
      return { ok: true, org, status: { state: "exited" }, display: "已停" };
    },
  };
}

function tmpEnv() {
  const dir = mkdtempSync(join(tmpdir(), "board-bd3-"));
  const orgsRoot = join(dir, "orgs");
  mkdirSync(orgsRoot, { recursive: true });
  return { dir, orgsRoot, ledgerFile: join(dir, "data", "orgs.json") };
}

/**
 * 假「停用释放成员写」（§9.4-① 注入）：记录每次调用入参与选项，供断言
 * 「停用先调 group.remove」与「O1 失败 ⇒ 停用整体失败（台账零写）」。
 * 缺省成功返回 = 组段存在、真摘除（`changed:true`）。
 */
function fakeRelease({ outcome } = {}) {
  const calls = [];
  const impl = async (input, options) => {
    calls.push({ input, options });
    if (outcome !== undefined) return outcome;
    return { ok: true, op: "group.remove", groupName: input.groupName, changed: true, members: null, backedUpTo: "R/config.json.bak" };
  };
  return { calls, impl };
}

async function withBd3Server(env, run, opts = {}) {
  const release = opts.release ?? fakeRelease();
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: opts.client ?? fakeClient(),
    now: () => Date.parse(NOW_ISO),
    docs: { repoRoot: env.dir, orgsDir: opts.orgsDir === undefined ? env.orgsRoot : opts.orgsDir },
    orgsLedgerFile: env.ledgerFile,
    hostFace: opts.hostFace ?? null,
    ...(opts.createRequirementImpl === undefined ? {} : { createRequirementImpl: opts.createRequirementImpl }),
    ...(opts.defaultGroup === undefined ? {} : { defaultGroup: opts.defaultGroup }),
    // §9.4-①：停用 handler 会调 O1 group.remove —— 离线用例一律注入假实现（不真打桥）。
    releaseOrgGroupImpl: release.impl,
    orgProjectsFetcher: opts.fetcher ?? (async () => ({ ok: true, projects: [] })),
    // §9-c：管理页会查 3300 声明面（项目池右栏 + 配置核对卡首行）⇒ BD3 用例统一不装配（离线确定性；两处如实显示「未查询」）
    orgGroupsFetcher: null,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
}

function postOrg(base, fields, headers = {}) {
  return fetch(`${base}/orgs`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

const JSON_HEADERS = { "x-board-write": "1", accept: "application/json" };
const FORM_ORIGIN = (base) => ({ origin: base });

function readLedgerOrgs(ledgerFile) {
  return JSON.parse(readFileSync(ledgerFile, "utf8")).orgs;
}

// ---------------------------------------------------------------------------
// ① 拒删前置闸：名下有活跃宿主桥 ⇒ 409 + 引导，零台账写
// ---------------------------------------------------------------------------

test("BD3-①（拒删闸 · 正向）：无活跃桥 ⇒ 停用 303 回组织门户 /，台账落 disabledAt（不物理删目录）", async () => {
  const env = tmpEnv();
  mkdirSync(join(env.orgsRoot, "停用组"), { recursive: true });
  await withBd3Server(env, async (base) => {
    const res = await postOrg(base, { action: "disable", org: "停用组" }, FORM_ORIGIN(base));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/", "§9.4-②：停用 303 落点 = 组织门户 /（不再回已退役的 /orgs）");
    assert.deepEqual(readLedgerOrgs(env.ledgerFile), [{ org: "停用组", disabledAt: NOW_ISO, agentKind: null, agentModel: null }]);
    assert.equal(existsSync(join(env.orgsRoot, "停用组")), true, "停用 = 台账标记，不得物理删组织目录");
  }, { hostFace: fakeHostFace({ bridges: [{ org: "停用组", state: "exited" }] }) });
});

test("BD3-①b（拒删闸 · 负向）：名下有 running 桥 ⇒ 409 board_org_has_active_bridge + 引导先逐桥 stop；台账零写、不停桥", async () => {
  const env = tmpEnv();
  const host = fakeHostFace({ bridges: [{ org: "活跃组", state: "running" }, { org: "活跃组", state: "unreachable" }] });
  await withBd3Server(env, async (base) => {
    const res = await postOrg(base, { action: "disable", org: "活跃组" }, JSON_HEADERS);
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.code, "board_org_has_active_bridge");
    assert.match(json.error, /先逐桥 stop/, "文案引导「先逐桥 stop 再删」");
    assert.match(json.error, /不隐式连带停桥/);
    assert.equal(existsSync(env.ledgerFile), false, "被拒的停用请求不得触达台账");
    assert.deepEqual(host.stops, [], "绝不隐式连带停桥");
  }, { hostFace: host });
});

test("BD3-①c（拒删闸）：宿主面未装配 ⇒ 无从有活跃桥，停用照常放行；同桥全 exited 后放行", async () => {
  const env = tmpEnv();
  await withBd3Server(env, async (base) => {
    const res = await postOrg(base, { action: "disable", org: "无桥组" }, JSON_HEADERS);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, { ok: true, org: "无桥组", disabled: true, changed: true, membersReleased: true, ledgerFile: env.ledgerFile });
  }, { hostFace: null });

  const env2 = tmpEnv();
  const host = fakeHostFace({ bridges: [{ org: "刚停组", state: "exited" }] });
  await withBd3Server(env2, async (base) => {
    const res = await postOrg(base, { action: "disable", org: "刚停组" }, JSON_HEADERS);
    assert.equal(res.status, 200);
  }, { hostFace: host });
});

test("BD3-①d（拒删闸 · 幂等）：重复停用 303 且台账逐字节不动（保留首次停用时刻）", async () => {
  const env = tmpEnv();
  await withBd3Server(env, async (base) => {
    const first = await postOrg(base, { action: "disable", org: "停用组" }, FORM_ORIGIN(base));
    assert.equal(first.status, 303);
    const bytes = readFileSync(env.ledgerFile, "utf8");
    const again = await postOrg(base, { action: "disable", org: "停用组" }, FORM_ORIGIN(base));
    assert.equal(again.status, 303);
    assert.equal(readFileSync(env.ledgerFile, "utf8"), bytes, "幂等：文件逐字节不动");
  }, { hostFace: fakeHostFace({}) });
});

// ---------------------------------------------------------------------------
// §9.4-①② 增补五：停用释放成员（原子）+ 停用跳转落点
// ---------------------------------------------------------------------------

test("§9.4-①（停用释放成员 · 序列）：停用先调 O1 group.remove（组身份 = 目标组织名），成功后台账落 disabledAt；JSON 回 membersReleased", async () => {
  const env = tmpEnv();
  const release = fakeRelease();
  await withBd3Server(env, async (base) => {
    const res = await postOrg(base, { action: "disable", org: "释放组" }, JSON_HEADERS);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.disabled, true);
    assert.equal(json.membersReleased, true, "group.remove 真摘除组段 ⇒ membersReleased:true");
    assert.equal(release.calls.length, 1, "停用恰调一次释放（不经成员表单）");
    assert.deepEqual(release.calls[0].input, { groupName: "释放组" }, "入参 = {groupName}（group.remove 不消费成员集）");
    assert.equal(release.calls[0].options.group, "释放组", "组身份 = 目标组织名（显式身份）");
    assert.deepEqual(readLedgerOrgs(env.ledgerFile), [{ org: "释放组", disabledAt: NOW_ISO, agentKind: null, agentModel: null }], "台账在 O1 成功后才落");
  }, { hostFace: fakeHostFace({}), release });
});

test("§9.4-①（原子 · 失败不留半态）：O1 group.remove 失败 ⇒ 停用整体失败（映射状态码），台账零写", async () => {
  const env = tmpEnv();
  const release = fakeRelease({ outcome: { ok: false, code: "config_write_io_failed", error: "写盘失败" } });
  await withBd3Server(env, async (base) => {
    const res = await postOrg(base, { action: "disable", org: "原子组" }, JSON_HEADERS);
    assert.equal(res.status, 500, "闭集 config_write_io_failed ⇒ 500（describeMemberWriteFailure）");
    assert.equal((await res.json()).code, "config_write_io_failed");
    assert.equal(existsSync(env.ledgerFile), false, "原子：O1 失败 ⇒ 台账零写，不留半态");

    const formRes = await postOrg(base, { action: "disable", org: "原子组" }, FORM_ORIGIN(base));
    assert.equal(formRes.status, 500, "表单档同样整体失败（不出 303 成功页）");
    assert.equal(existsSync(env.ledgerFile), false, "两档均零台账写");
    assert.equal(release.calls.length, 2, "每次停用尝试都出网一次（先 O1、后台账）");
  }, { hostFace: fakeHostFace({}), release });
});

test("§9.4-①（桥不可达）：transport_error ⇒ 502 + 不可达引导，停用整体失败、台账零写", async () => {
  const env = tmpEnv();
  const release = fakeRelease({ outcome: { ok: false, code: "transport_error", error: "桥不可达" } });
  await withBd3Server(env, async (base) => {
    const res = await postOrg(base, { action: "disable", org: "断网组" }, JSON_HEADERS);
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.equal(json.code, "transport_error");
    assert.match(json.error, /不会降级去本地直写/, "502 档带「绝不降级本地直写」引导");
    assert.equal(existsSync(env.ledgerFile), false);
  }, { hostFace: fakeHostFace({}), release });
});

test("§9.4-①（组段不存在 · 幂等放行）：O1 回 changed:false 成功 ⇒ 停用照常成功，JSON membersReleased:false", async () => {
  const env = tmpEnv();
  const release = fakeRelease({ outcome: { ok: true, op: "group.remove", groupName: "空组", changed: false, members: null, backedUpTo: null } });
  await withBd3Server(env, async (base) => {
    const res = await postOrg(base, { action: "disable", org: "空组" }, JSON_HEADERS);
    assert.equal(res.status, 200, "组段本不存在 = 无成员可释放 ⇒ 幂等放行视为成功");
    const json = await res.json();
    assert.equal(json.membersReleased, false, "changed:false 如实回显（无实际变更）");
    assert.deepEqual(readLedgerOrgs(env.ledgerFile), [{ org: "空组", disabledAt: NOW_ISO, agentKind: null, agentModel: null }]);
  }, { hostFace: fakeHostFace({}), release });
});

test("§9.4-①（拒删闸优先于释放）：名下有活跃桥 ⇒ 409，O1 一次都不调（零出网、零台账写）", async () => {
  const env = tmpEnv();
  const release = fakeRelease();
  const host = fakeHostFace({ bridges: [{ org: "活跃组", state: "running" }] });
  await withBd3Server(env, async (base) => {
    const res = await postOrg(base, { action: "disable", org: "活跃组" }, JSON_HEADERS);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "board_org_has_active_bridge");
    assert.equal(release.calls.length, 0, "被拒的停用不得触达 O1");
    assert.equal(existsSync(env.ledgerFile), false);
  }, { hostFace: host, release });
});

test("§9.4-②（停用跳转落点）：manage 停用表单带 data-ov-redirect=\"/\"；SUBMIT_GUARD 成功路径支持该属性", async () => {
  const env = tmpEnv();
  const store = new OrgsLedgerStore(env.ledgerFile);
  store.addOrg("跳转组");
  await withBd3Server(env, async (base) => {
    const res = await fetch(`${base}/org/${encodeURIComponent("跳转组")}/manage`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(
      text,
      /<form method="post" action="\/orgs"[^>]*data-ov-redirect="\/"/,
      "停用表单带 data-ov-redirect=\"/\"（成功跳门户，不 reload 刚被停用的空间页）",
    );
    assert.match(text, /getAttribute\("data-ov-redirect"\)/, "SUBMIT_GUARD_SCRIPT 成功路径读取该属性");
    assert.match(text, /location\.href = redirect/, "有该属性 ⇒ location.href 目标（无属性才 reload）");
  }, { client: fakeClient(["跳转组"]) });
});

// ---------------------------------------------------------------------------
// 表单/守卫纪律：CSRF 先于一切；非法名 400；动作闭集外 400 board_org_action_invalid
// ---------------------------------------------------------------------------

test("BD3-⑤（写面纪律）：停用请求跨站 Origin ⇒ 403 CSRF 零写入；非法名 ⇒ 400；动作不在闭集 ⇒ 400 board_org_action_invalid", async () => {
  const env = tmpEnv();
  await withBd3Server(env, async (base) => {
    const csrf = await postOrg(base, { action: "disable", org: "停用组" }, { origin: "http://evil.example" });
    assert.equal(csrf.status, 403);
    assert.equal(existsSync(env.ledgerFile), false);

    const badName = await postOrg(base, { action: "disable", org: "a b" }, JSON_HEADERS);
    assert.equal(badName.status, 400);
    assert.equal((await badName.json()).code, ORG_NAME_INVALID_CODE);

    const badAction = await postOrg(base, { action: "delete", org: "停用组" }, JSON_HEADERS);
    assert.equal(badAction.status, 400);
    assert.equal((await badAction.json()).code, ORG_ACTION_INVALID_CODE, "不猜动作");
    assert.equal(existsSync(env.ledgerFile), false, "三笔负例全零写入");
  }, { hostFace: fakeHostFace({}) });
});

// ---------------------------------------------------------------------------
// ③ 过滤两处之一：停用组织的页面档位（§9-c 翻向：/orgs 页退役 ⇒ 停用表单宿主 = 空间管理页，停用组织 = 410）
// ---------------------------------------------------------------------------

/**
 * **§9-c 翻向记录**：本锚原为「`pageOrgs` 停用行置灰 + 标注（已停用）+ 操作列停用表单」。
 * `/orgs` 页退役后，「同一张总表里并列在用 / 停用两态」的呈现面消失 ⇒ 拆成两格新锚：
 * ① 在用组织的空间管理页照常渲染停用表单（隐藏 `action=disable` + `org`，action 仍 = 全局 `POST /orgs`）；
 * ② 停用组织的空间（含管理页）一律 410（恢复口径进 410 文案，不再靠表格置灰）。
 */
test("BD3-③（过滤 · 页面 · §9-c 翻向）：在用组织管理页给停用表单（隐藏 action=disable）；停用组织管理页 410", async () => {
  const env = tmpEnv();
  const store = new OrgsLedgerStore(env.ledgerFile);
  store.addOrg("停用组");
  store.disableOrg("停用组", () => NOW_ISO);
  store.addOrg("在用组");
  await withBd3Server(env, async (base) => {
    const on = await fetch(`${base}/org/${encodeURIComponent("在用组")}/manage`);
    assert.equal(on.status, 200);
    const text = await on.text();
    assert.match(text, /<input type="hidden" name="action" value="disable">/, "停用 = 同一条 POST /orgs 的动作分流");
    assert.match(text, /action="\/orgs"[\s\S]*?<input type="hidden" name="org" value="在用组"/, "在用组织管理页给停用按钮");
    assert.doesNotMatch(text, /<script src>/, "纯 SSR：零新脚本常量（N3 八元闭集不动）");

    const off = await fetch(`${base}/org/${encodeURIComponent("停用组")}/manage`);
    assert.equal(off.status, 410, "停用组织的空间不再开放 ⇒ 管理页同档位（不另立「置灰」形态）");
    const offText = await off.text();
    assert.match(offText, /board_org_space_gone/);
    assert.match(offText, /台账停用/, "停用标注退到 410 文案里（可见性不丢）");
    assert.match(offText, /管理页.*410/, "410 文案点名管理页同档");
    assert.match(offText, /同名重建/, "恢复口径随档位说明给出");
  }, { client: fakeClient(["在用组"]) });
});

test("BD3-③b（过滤 · 查重豁免）：停用名同名重建 = 复活（303/201），目录与既有需求不动（零迁移）", async () => {
  const env = tmpEnv();
  mkdirSync(join(env.orgsRoot, "复活组"), { recursive: true });
  const store = new OrgsLedgerStore(env.ledgerFile);
  store.addOrg("复活组");
  store.disableOrg("复活组", () => NOW_ISO);
  await withBd3Server(env, async (base) => {
    const res = await postOrg(base, { org: "复活组" }, JSON_HEADERS);
    assert.equal(res.status, 201, "停用名豁免三源查重 ⇒ 同名重建放行");
    const json = await res.json();
    assert.equal(json.org, "复活组");
    assert.deepEqual(readLedgerOrgs(env.ledgerFile), [{ org: "复活组", disabledAt: null, agentKind: null, agentModel: null }]);
    assert.equal(existsSync(join(env.orgsRoot, "复活组")), true, "零迁移：目录原样");
    // 复活后回到在用态 ⇒ 再次同名 = BD1 幂等拒
    const dup = await postOrg(base, { org: "复活组" }, JSON_HEADERS);
    assert.equal(dup.status, 409);
  }, { hostFace: fakeHostFace({}) });
});

// ---------------------------------------------------------------------------
// ④ 停用组织不可提新需求
// ---------------------------------------------------------------------------

async function postRequirement(base, fields, headers = {}) {
  const res = await fetch(`${base}/requirements`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

test("BD3-④（提需求拒绝）：目标组织停用 ⇒ 409 board_org_disabled + 族名与恢复口径，写封装零触达；在用组织照常放行", async () => {
  const env = tmpEnv();
  const store = new OrgsLedgerStore(env.ledgerFile);
  store.addOrg("停用组");
  store.disableOrg("停用组", () => NOW_ISO);
  const seen = [];
  const createRequirementImpl = async (input, options) => {
    seen.push({ input, options });
    return { ok: true, featureId: "F-NEW", state: "waiting_approval", stage: "需求分析", version: input.version, approval: "未发起" };
  };
  await withBd3Server(env, async (base) => {
    const denied = await postRequirement(base, { title: "甲", group: "停用组" }, JSON_HEADERS);
    assert.equal(denied.status, 409);
    const json = JSON.parse(denied.text);
    assert.equal(json.code, ORG_DISABLED);
    assert.match(json.error, /不可提新需求/);
    assert.match(json.error, /同名重新建组织/);

    const formDenied = await postRequirement(base, { title: "甲", group: "停用组" }, FORM_ORIGIN(base));
    assert.equal(formDenied.status, 409);
    assert.match(formDenied.text, /组织已停用/, "族名经 ERROR_FAMILY_LABELS 上板");
    assert.deepEqual(seen, [], "被拒的请求不得触达写封装（零出网）");

    const ok = await postRequirement(base, { title: "乙", group: "在用组" }, JSON_HEADERS);
    assert.equal(ok.status, 201);
    assert.equal(seen.length, 1);
  }, { createRequirementImpl, defaultGroup: null });
});

test("BD3-④b（提需求拒绝）：板级默认组停用 ⇒ 表单未填 group 回落默认同样被拒（判据落在解析后的 form.group）", async () => {
  const env = tmpEnv();
  const store = new OrgsLedgerStore(env.ledgerFile);
  store.addOrg("默认停用组");
  store.disableOrg("默认停用组", () => NOW_ISO);
  const seen = [];
  await withBd3Server(env, async (base) => {
    const res = await postRequirement(base, { title: "甲" }, JSON_HEADERS);
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.text).code, ORG_DISABLED);
    assert.deepEqual(seen, []);
  }, {
    createRequirementImpl: async () => { seen.push("called"); return { ok: true, featureId: "F", state: "waiting_approval", stage: "需求分析", version: "", approval: "未发起" }; },
    defaultGroup: "默认停用组",
  });
});
