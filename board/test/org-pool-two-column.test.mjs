/**
 * REQ-2026-10-03-02「项目组加/删项目改两栏拖拽」+ v0.9.8「项目池恒空修复」
 * —— **数据 + SSR 渲染 + HTTP 装配**（无脚本；拖放脚本面在 `org-pool-drag.test.mjs`）。
 *
 * 钉住的语义（改造文档 §2 改动清单 1–3 / §3 固定口径；锚面按 N5 收口到 v0.9.8 新事实）：
 *  ① **池 = 桥注册表全量机器项目 − 全组（含本组）声明面**（纯函数集合差，**差集单点在板**）：
 *     - **左集换源** = `getRegistryProjects()`（`GET /api/registry/projects`，遍历源 = runners 表）
 *       ⇒ 离线机及其项目**照常入池**（C-1：机级 `runnerState="offline"` + `lastHeartbeatAt`，注册表面
 *       **无机器级 error 文案**）；
 *     - 旧源 `getProjects()`（`/api/projects`）的出参 = **全组声明成员的并集**，与减集同域
 *       ⇒ 差集**构造性恒空**（本次病灶）。故本文件既锚「换源后的差集真能出行」（池-⑫），
 *       也锚「池源在装配面**只有一处**、且不再是旧面」（池-⑰）；
 *     - **减集仍取 `/api/groups`**（组声明面）；别组项目在池里**完全不显示**
 *       （用户 2026-10-03 裁，需求确认单 v1）—— 这是**显示层过滤**，不是写入闸门（执法仍在桥 O1 + 板 409）；
 *  ② **不给假池、也不降级成空池**：快照读失败 / 声明面不可达 / 查询器未装配 ⇒ 整块灰化，
 *     **不呈现任何拖拽载荷**，也**不呈现任何空态字面**（B-3：归属未知 ≠「暂无记录」≠「已全部归属」）；
 *  ③ **池行只带一枚时间提示**（B-4）：`最后上报于 {lastReportedAt}（非实时探测）`；
 *     注册表投影**不采信、不渲染** `status` / `online`（会冒充在线），也不带任何组语义字段（C-2）
 *     —— 负锚见池-⑯（含「锚拒得住假出参」的生效证据），正锚见池-⑮；
 *  ④ **回落面不劣化**：手填表单保留 DOM（SSR 直出 `open` 的 `<details>`，无 JS 即常态可见、照常原生提交）；
 *     写面闭集不扩（两栏本身零表单）；
 *  ⑤ **`draggable` 由服务端判据渲染**（末位成员行不给拖）—— 脚本只是体验层；
 *  ⑥ **单面失败不炸页**：池读的 any 失败（含注入 client 缺该方法、桥侧 fail-closed 抛出）一律收口为
 *     池区降级，页面其余照常（本区四档灰化先例）。
 *
 * 范围外（归它处）：MEMBER_DRAG_SCRIPT 行为锚与拖放 fetch 参数（`org-pool-drag.test.mjs`）、
 * 全站内联脚本闭集枚数锚（`n3-regression-anchors.test.mjs`）、`parseRegistryProjects` 出参解析与
 * 缺 `machines[]` fail-closed（`bridge-client.test.mjs`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  computeProjectPool,
  memberPairKey,
  poolProjects,
  poolRowsFromSnapshot,
} from "../dist/orgs-view.js";
import { renderOrgSpaceManagePage } from "../dist/web/views.js";
import { LAST_MEMBER_REMOVE_CODE, MEMBER_GROUP_CONFLICT_CODE } from "../dist/group-admin.js";
import { createBoardServer } from "../dist/server.js";

// ---------------------------------------------------------------------------
// 切片 helper（必须在任何顶层求值之前定义 —— `twoColumnHtml` 在模块顶层渲染，
// helper 定义在其后时仍处于 TDZ，各测试便只能内联重复切片式）
// 界只用两枚稳定 DOM 锚（`data-side` / `member-forms-fold`），样式类锚不作切片界（见文末负向钉）。
// ---------------------------------------------------------------------------

const poolColumn = (html) => html.slice(html.indexOf('data-side="pool"'), html.indexOf('data-side="own"'));
const ownColumn = (html) => html.slice(html.indexOf('data-side="own"'), html.indexOf("member-forms-fold"));

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const OBSERVED = "2026-10-03T01:00:00.000Z";

/** 池行时间提示位的时刻（B-4：注册表 `runnerProjectsReplace` 写入的最后上报时刻）。 */
const REPORTED_A1 = "2026-10-01T08:30:00.000Z";
const REPORTED_FREE = "2026-10-02T09:15:00.000Z";
const REPORTED_C1 = "2026-09-20T23:59:59.000Z";

/** 声明面：alpha 两项（本组）· beta 一项（别组）。 */
function groupsOutcome(...rows) {
  return { ok: true, warnings: [], observedAt: OBSERVED, groups: rows };
}

const ALPHA_TWO = { name: "alpha", memberCount: 2, members: [{ machineId: "m1", projectId: "p-a1" }, { machineId: "m1", projectId: "p-a2" }] };
const BETA_ONE = { name: "beta", memberCount: 1, members: [{ machineId: "m2", projectId: "p-b1" }] };

/** 池的一行（`PoolProjectRow` 出口形状：三键，时间位随行、不参与配对键）。 */
const prow = (machineId, projectId, lastReportedAt = null) => ({ machineId, projectId, lastReportedAt });

/**
 * `getRegistryProjects()` 出口形状（`RegistryProjectsView`，v0.9.8 换源后的池左集）。
 * 与旧 `getProjects()` 快照的**形状差别**就是本节点的锚点：
 * - **机级无 `error` 字段**（C-1：离线机不发 error 文案，靠 `runnerState="offline"` + `lastHeartbeatAt`）；
 * - 无 `runners[]` / `group` 顶层键（那是旧 `/api/projects` 的组视野投影）；
 * - 项目级多一枚 `lastReportedAt`（C-4），并**故意保留** `status` / `agentKind` / `a2aPort`
 *   与组语义假字段（池面一律不消费 ⇒ 由池-⑯负锚证明它们漏不上页面）。
 */
function registryView(machines) {
  const projects = machines.reduce((n, m) => n + (m.projects?.length ?? 0), 0);
  return {
    source: "registry",
    note: null,
    observedAt: OBSERVED,
    machines: machines.map((m) => ({
      machineId: m.machineId,
      runnerState: m.runnerState ?? "online",
      lastHeartbeatAt: m.runnerState === "offline" ? "2026-09-20T23:59:59.000Z" : OBSERVED,
      firstRegisteredAt: "2026-09-01T00:00:00.000Z",
      projects: (m.projects ?? []).map((p) => ({
        projectId: p.projectId,
        agentKind: "qoder",
        a2aPort: 1,
        status: "ok",
        endpoint: null,
        startedAt: null,
        lastReportedAt: p.lastReportedAt ?? null,
        // 越界字段（C-2 出参本不该有；此处刻意塞入，供池-⑯负锚验「板不消费」）
        ...(p.extra ?? {}),
      })),
    })),
    counts: { machines: machines.length, projects },
  };
}

const pool = (rows) => ({ ok: true, rows, observedAt: OBSERVED });

/**
 * 注册表机器清单 → **左集读取结论**（等价于 server.ts 里的 `poolRowsFromSnapshot(await getRegistryProjects())` 一步）。
 * 用途：让 ⑦ / ⑮ 直接喂注册表清单（含离线机 `runnerState` / 各项目的 `lastReportedAt`），
 * 而不是手写已经换了形状的池行对象——锚住的是「新形状经投影进视图」这条真链路。
 */
const snapFromRegistry = (machines) => ({
  ok: true,
  rows: poolRowsFromSnapshot(registryView(machines)),
  observedAt: OBSERVED,
});

// ---------------------------------------------------------------------------
// ① 池集合差纯函数
// ---------------------------------------------------------------------------

test("池-① poolProjects: 注册表全量机器项目 − 全组（含本组）声明面 ⇒ 别组与本组项目都不在池 · lastReportedAt 随行透传", () => {
  const all = [
    prow("m1", "p-a1", REPORTED_A1),
    prow("m1", "p-a2"),
    prow("m1", "p-free", REPORTED_FREE),
    prow("m2", "p-b1"),
    prow("m3", "p-c1", REPORTED_C1),
  ];
  const rows = poolProjects(all, [ALPHA_TWO, BETA_ONE]);
  assert.deepEqual(rows, [prow("m1", "p-free", REPORTED_FREE), prow("m3", "p-c1", REPORTED_C1)], "别组（beta）声明的项目**完全不显示**在池里（用户已裁）· 本组（alpha）项目同理归右栏 · **离线机 m3 的项目照常入池**（换源后的 C-1）");
  assert.deepEqual(
    poolProjects([prow("m2", "p-free"), prow("m1", "p-free", REPORTED_FREE)], [{ name: "beta", memberCount: 1, members: [{ machineId: "m2", projectId: "p-free" }] }]).map((r) => `${r.machineId}/${r.projectId}`),
    ["m1/p-free"],
    "配对按 (machineId, projectId) 经 memberPairKey —— 别组声明 m2/p-free **不得**顺带摘掉同名的 m1/p-free（减集不塌成裸 projectId 集）",
  );
});

test("池-② poolProjects: 输出按 (machineId, projectId) 字典序稳定 + 快照重复行去重", () => {
  const dup = [
    { machineId: "m9", projectId: "b" },
    { machineId: "m1", projectId: "z" },
    { machineId: "m9", projectId: "a" },
    { machineId: "m9", projectId: "b" },
    { machineId: "m1", projectId: "z" },
  ];
  assert.deepEqual(poolProjects(dup, []).map((r) => `${r.machineId}/${r.projectId}`), ["m1/z", "m9/a", "m9/b"], "同机同项目只出一行 · 排序单点（避免逐次渲染抖动）");
});

test("池-③ memberPairKey: 两侧各 trim 且逐段转义 ⇒ 不同 (machine, project) 不撞键", () => {
  assert.equal(memberPairKey(" m1 ", "p1"), memberPairKey("m1", "p1"), "trim 口径同成员写面（isSameMemberPair）");
  assert.notEqual(memberPairKey("m/1", "p"), memberPairKey("m", "1/p"), "分段键不被分隔符伪造（拼接式会撞）");
  const rows = [{ machineId: "m", projectId: "1/p" }, { machineId: "m/1", projectId: "p" }];
  assert.equal(poolProjects(rows, [{ name: "g", memberCount: 1, members: [{ machineId: "m/1", projectId: "p" }] }]).length, 1, "声明面命中只摘掉那一行，另一行照常入池");
});

test("池-④ poolRowsFromSnapshot: 注册表 machines[].projects[] 纯投影 · 离线机项目照常入行 · 零项目机产不出行", () => {
  const view = registryView([
    { machineId: "m1", projects: [{ projectId: "p-a1", lastReportedAt: REPORTED_A1 }, { projectId: "p-free", lastReportedAt: REPORTED_FREE }] },
    { machineId: "m2", projects: [{ projectId: "p-b1" }] },
    { machineId: "m3", runnerState: "offline", projects: [{ projectId: "p-c1", lastReportedAt: REPORTED_C1 }] },
    { machineId: "m4", projects: [] },
  ]);
  assert.deepEqual(poolRowsFromSnapshot(view), [
    prow("m1", "p-a1", REPORTED_A1),
    prow("m1", "p-free", REPORTED_FREE),
    prow("m2", "p-b1"),
    prow("m3", "p-c1", REPORTED_C1),
  ], "**换源后的遍历源 = runners 表**：离线机 m3（`runnerState=offline`）携其注册项目照常入行（旧面靠机级 `error` 条目挡行，注册表面**无 error 文案**，C-1）· 注册过但零项目的 m4 产不出行、也不编造");
  assert.deepEqual(
    [...new Set(poolRowsFromSnapshot(view).flatMap((r) => Object.keys(r)))].sort(),
    ["lastReportedAt", "machineId", "projectId"],
    "只投影三键（agentKind / status / runnerState 及一切组语义字段归下方「项目」区或被负锚拒收，两栏不重复）",
  );
});

test("池-⑤ computeProjectPool: 三档降级各带码（不给假池、不降级成空池）· 真实空池与「不可用」不混写 · 时间位随差集存活", () => {
  const snap = pool([prow("m1", "p-a1", REPORTED_A1), prow("m2", "p-b1")]);
  const declared = [ALPHA_TWO, BETA_ONE];
  assert.deepEqual(computeProjectPool(snap, groupsOutcome(...declared)), { ok: true, rows: [], observedAt: OBSERVED }, "全部项目已归属 ⇒ **真实空池**（ok:true ∧ rows:[]，与「不可用」两回事）");
  assert.deepEqual(
    computeProjectPool(pool([prow("m1", "p-a1", REPORTED_A1), prow("m3", "p-c1", REPORTED_C1)]), groupsOutcome(ALPHA_TWO)).rows,
    [prow("m3", "p-c1", REPORTED_C1)],
    "差集只减键、不洗行：未被声明的离线机行留在池里，**lastReportedAt 一路带到视图**（B-4 的池行提示位靠它）",
  );
  assert.equal(computeProjectPool({ ok: false, code: "snapshot_unreachable", error: "桥断了" }, groupsOutcome(declared)).code, "snapshot_unreachable", "快照读失败 ⇒ 透传码，不拿声明面凑池");
  assert.equal(computeProjectPool(snap, null).code, "groups_not_configured", "声明面未装配 ⇒ 归属未知 ⇒ 降级");
  const down = computeProjectPool(snap, { ok: false, code: "machines_config_error", error: "3300 配置坏" });
  assert.equal(down.ok, false);
  assert.equal(down.code, "machines_config_error", "3300 不可达 ⇒ 连带降级（原样透传桥码）");
});

test("池-⑥ computeProjectPool: 未配组（真实空声明面）⇒ 全量项目（含离线机）入池，不降级、不减成空", () => {
  const snap = pool([prow("m1", "p-a1", REPORTED_A1), prow("m3", "p-c1", REPORTED_C1)]);
  assert.deepEqual(computeProjectPool(snap, groupsOutcome()).rows, snap.rows, "`groups: []` = 桥的全量接纳语义（真实空），不是「读不到」⇒ 左集一项也不减（病灶反例：旧源下这里恒为 []）");
});

// ---------------------------------------------------------------------------
// ② SSR 渲染：两栏 / 拖拽判据 / 降级 / 回落面
// ---------------------------------------------------------------------------

const twoColumnHtml = renderOrgSpaceManagePage({
  org: "alpha",
  features: [],
  projectsOutcome: null,
  groupsOutcome: groupsOutcome(ALPHA_TWO, BETA_ONE),
  poolOutcome: computeProjectPool(
    snapFromRegistry([
      { machineId: "m1", projects: [{ projectId: "p-a1", lastReportedAt: REPORTED_A1 }, { projectId: "p-a2" }] },
      { machineId: "m2", projects: [{ projectId: "p-b1" }] },
      { machineId: "m3", runnerState: "offline", projects: [{ projectId: "p-c1", lastReportedAt: REPORTED_C1 }] },
    ]),
    groupsOutcome(ALPHA_TWO, BETA_ONE),
  ),
  poolSourceCount: 4,
});

test("池-⑦ 两栏 SSR：左池右本组 · 行带 draggable 与载荷属性 · 别组项目不可见 · 离线机项目照常上池", () => {
  assert.match(twoColumnHtml, /<div class="m-pool" id="member-pool" data-org="alpha">/, "两栏容器锚（脚本入口守卫位，页隔离由它承担）");
  assert.match(twoColumnHtml, /<div class="mcol" data-side="pool">[\s\S]*?项目池[\s\S]*?<\/div>\n<div class="mcol" data-side="own">[\s\S]*?本组项目/, "左栏池 / 右栏本组，SSR 直出（无 JS 即静态清单）");
  assert.match(
    twoColumnHtml,
    /<div class="mrow" draggable="true" data-machine="m3" data-project="p-c1">/,
    "池行 draggable 由**服务端判据**渲染 + data-machine/data-project 作拖拽载荷来源",
  );
  const poolSide = poolColumn(twoColumnHtml);
  const ownSide = ownColumn(twoColumnHtml);
  assert.ok(poolSide.includes('data-machine="m3"'), "未归属项来自**注册表投影**（换源前左集构造性恒空 ⇒ 这一行根本进不了池栏）；m3 是**离线机**，仍照常列出（C-1）");
  assert.ok(!poolSide.includes("p-b1") && !poolSide.includes("p-a1"), "别组声明项目与本组项目都**不出现**在左栏（不显示 ≠ 写不进，执法见 hint）");
  assert.ok(ownSide.includes("p-a1") && ownSide.includes("p-a2") && !ownSide.includes("p-c1"), "右栏 = 本组声明面 members，不混入池行");
  assert.match(twoColumnHtml, /池 1 项 · 本组 2 项 · 观测时刻 2026-10-03T01:00:00\.000Z/, "卡头给两侧计数与快照观测时刻");
});

test("池-⑧ hint 一条：三源观测时钟口径 + 以服务端投影与 409 为准（两枚码逐字）", () => {
  assert.match(twoColumnHtml, /三个数据源各有自己的观测时刻/, "快照 / 声明面 / 运行态三个时钟如实标源");
  assert.match(twoColumnHtml, /<b>落点以服务端投影与 409 为准<\/b>/, "拖拽落点不做客户端裁决");
  assert.ok(twoColumnHtml.includes(MEMBER_GROUP_CONFLICT_CODE) && twoColumnHtml.includes(LAST_MEMBER_REMOVE_CODE), "两枚既有的 409 码逐字出现在 hint（复用既有守卫，不新增）");
});

test("池-⑨ 末位成员行不给 draggable（同写前闸判据，拖不动即拖不了）", () => {
  const own = { name: "alpha", memberCount: 1, members: [{ machineId: "m1", projectId: "p-a1" }] };
  const html = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: null,
    groupsOutcome: groupsOutcome(own),
    poolOutcome: computeProjectPool(pool([{ machineId: "m1", projectId: "p-a1" }, { machineId: "m3", projectId: "p-c1" }]), groupsOutcome(own)),
  });
  const ownSide = ownColumn(html);
  assert.match(ownSide, /<div class="mrow"><span class="mono">m1<\/span> \/ <span class="mono">p-a1<\/span><\/div>/, "末位行**无 draggable**（服务端判据先行）");
  assert.match(html, /本组 1 项 · 末位不可移出/, "卡头如实标注不可移出");
  assert.match(html, /<div class="mrow" draggable="true" data-machine="m3" data-project="p-c1">/, "池行照旧可拖（末位闸只管右栏）");
});

test("池-⑩ 降级两档整块灰化且不给出任何拖拽载荷", () => {
  const unavailable = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: null,
    groupsOutcome: { ok: false, code: "machines_config_error", error: "3300 配置坏" },
    poolOutcome: computeProjectPool(pool([{ machineId: "m3", projectId: "p-c1" }]), { ok: false, code: "machines_config_error", error: "3300 配置坏" }),
  });
  assert.match(unavailable, /<span class="b-card-meta">不可用<\/span>/, "声明面不可达 ⇒ 池区「不可用」");
  assert.ok(unavailable.includes("machines_config_error") && unavailable.includes("不给拖拽"), "透传桥码 + 明示不给拖拽");
  assert.equal(unavailable.includes('id="member-pool"'), false, "降级档**不呈现两栏容器**（无载荷可拖 ⇒ 不给假池编造归属）");
  assert.equal(unavailable.includes("draggable="), false, "降级档整块无 draggable");

  const unknown = renderOrgSpaceManagePage({ org: "alpha", features: [], projectsOutcome: null, groupsOutcome: null, poolOutcome: null });
  assert.match(unknown, /<span class="b-card-meta">未查询<\/span>[\s\S]*?<b>未查询<\/b>：全量机器项目快照未装配[\s\S]*?不编造「无项目」/, "快照未装配 ⇒「未查询」（与「无项目」两回事）");
  assert.equal(unknown.includes('id="member-pool"'), false);
});

test("池-⑪ 手填表单保留 DOM 且默认展开（无 JS 回落面不劣化）· 写面闭集不扩", () => {
  for (const html of [twoColumnHtml, renderOrgSpaceManagePage({ org: "alpha", features: [], projectsOutcome: null, groupsOutcome: null, poolOutcome: null })]) {
    assert.match(html, /<details class="m-fold" id="member-forms-fold" open>/, "SSR 直出 **open** ⇒ 折叠只是 JS 可用时的收纳，DOM 未删");
    assert.match(html, /<summary>手填表单（加 \/ 删成员）<\/summary>\n<div class="b-card">[\s\S]*?加成员[\s\S]*?删成员/, "两枚表单紧随折叠条，展开即常态");
    assert.match(html, /<form method="post" action="\/orgs\/alpha\/members"[^>]*data-submit="已提交，加成员中…" data-ov="1">/, "加成员表单 action 逐字对齐全局写口（零改动）");
    assert.match(html, /<input type="hidden" name="action" value="add">[\s\S]*?<input type="hidden" name="action" value="remove">/, "add / remove 两枚隐藏分流字段在位");
  }
  assert.equal((twoColumnHtml.match(/data-ov="1"/g) ?? []).length, 4, "两栏**零表单**：写面浮层档闭集仍是加 / 删 / 停用 / agent 配置四枚，不扩");
});

// ---------------------------------------------------------------------------
// ③ HTTP 面：pageOrgSpaceManage 的装配与降级
// ---------------------------------------------------------------------------

function feature(featureId, ownerGroup) {
  return {
    featureId,
    state: "executing",
    title: `需求 ${featureId}`,
    taskCount: 1,
    ownerGroup,
    stage: "改造方案",
    version: "v0.9.8",
    approval: "已通过",
    createdAt: "c",
    updatedAt: "u",
    stateCounts: null,
  };
}

async function withManagePage(client, run, { groupsFetcher } = {}) {
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    orgProjectsFetcher: async () => ({ ok: true, projects: [] }),
    orgGroupsFetcher: groupsFetcher === undefined ? null : groupsFetcher,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

const manageClient = (extra = {}) => ({
  baseUrl: "http://fake",
  async getFeatures() {
    return { features: [feature("F1", "alpha")], stateCounts: null };
  },
  ...extra,
});

test("池-⑫ 管理页池源 = getRegistryProjects()：注册表全量投影落池（含离线机）· 旧面不再参与装配", async () => {
  let registryReads = 0;
  let legacyReads = 0;
  await withManagePage(
    manageClient({
      async getRegistryProjects() {
        registryReads += 1;
        return registryView([
          { machineId: "m1", projects: [{ projectId: "p-a1", lastReportedAt: REPORTED_A1 }, { projectId: "p-a2" }, { projectId: "p-free", lastReportedAt: REPORTED_FREE }] },
          { machineId: "m2", projects: [{ projectId: "p-b1" }] },
          { machineId: "m3", runnerState: "offline", projects: [{ projectId: "p-c1", lastReportedAt: REPORTED_C1 }] },
        ]);
      },
      async getProjects() {
        legacyReads += 1;
        throw new Error("池左集不得再走旧 /api/projects（与减集同域 ⇒ 差集恒空）");
      },
    }),
    async (base) => {
      const res = await fetch(`${base}/org/alpha/manage`);
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.equal(registryReads, 1, "本节点多**一次**注册表项目读（新只读面 GET /api/registry/projects）");
      assert.equal(legacyReads, 0, "旧面一次都不读（装配单点已换源；池-⑰ 在装配面同锚一处）");
      assert.match(text, /<div class="mrow" draggable="true" data-machine="m1" data-project="p-free">/, "未被任何组声明的项目落到池栏，可拖");
      assert.match(text, /<div class="mrow" draggable="true" data-machine="m3" data-project="p-c1">/, "**离线机 m3 的项目照常进池**（换源前：旧面对离线机发机级 error ⇒ 一行都投影不出）");
      assert.match(text, /最后上报于 2026-09-20T23:59:59\.000Z（非实时探测）/, "弱提示随 HTTP 装配面上页（B-4）");
      const poolSide = poolColumn(text);
      assert.equal(poolSide.includes("p-b1"), false, "别组（beta）声明的项目在池里完全不显示");
      const ownSide = ownColumn(text);
      assert.match(ownSide, /data-machine="m1" data-project="p-a1">/, "本组两项（非末位）落右栏且可拖回池栏");
      assert.match(ownSide, /data-machine="m1" data-project="p-a2">/);
      assert.equal(ownSide.includes("p-b1"), false, "右栏只呈现本组声明面");
      assert.match(text, /池 2 项 · 本组 2 项/, "卡头计数 = 池 2（p-free · m3/p-c1）· 本组 2");
    },
    {
      groupsFetcher: async () =>
        groupsOutcome(ALPHA_TWO, BETA_ONE),
    },
  );
});

test("池-⑬ 快照读失败不炸页：池区降级「不可用」+ 透传码，页面其余照常（钉死单面失败 ⇒ 非 502）", async () => {
  await withManagePage(
    manageClient({
      async getRegistryProjects() {
        throw new Error("快照面爆炸（假）");
      },
    }),
    async (base) => {
      const res = await fetch(`${base}/org/alpha/manage`);
      const text = await res.text();
      assert.equal(res.status, 200, "快照读失败 ⇒ 只降级池区，不整页 502");
      assert.match(text, /<span class="b-card-meta">不可用<\/span>/, "池区档名如实「不可用」");
      assert.match(text, /snapshot_unreachable[\s\S]*?快照面爆炸（假）/, "结构化码 + 根因原文呈现，不静默");
      assert.match(text, /<tr[^>]*><td>声明面成员/, "成员区照常呈现（替身锚 = 配置核对卡首行 <tr><td>，不依赖成员区文案）");
      assert.match(text, /<form method="post" action="\/orgs\/alpha\/members"/, "手填表单在失败档仍是主通路（照常可用）");
    },
  );
});

const EMPTY_NONE = "（机器注册表暂无项目记录）";
const EMPTY_OWNED = "（池为空：桥注册表全集投影中的机器项目已全部归属某个项目组）";

test("池-⑭ 读面缺席 / 缺方法（同步抛错）收口为降级 ⇒ 页面照常 200 · 空态三档互不冒充（B-3）", async () => {
  await withManagePage(manageClient(), async (base) => {
    const res = await fetch(`${base}/org/alpha/manage`);
    const text = await res.text();
    assert.equal(res.status, 200, "读面缺席 = 一种不可用，不得冒成整页 bridge_unreachable");
    assert.match(text, /<span class="b-card-meta">不可用<\/span>/);
    assert.match(text, /snapshot_unreachable/, "缺方法（TypeError）与桥侧 fail-closed 抛出同径收口 —— 都落「不可用」+ 结构化码");
    assert.equal(text.includes('id="member-pool"'), false, "降级档不给拖拽载荷");
    assert.equal(text.includes(EMPTY_NONE), false, "降级 ≠「注册表没有项目」：左集读数拿不到时**不得**输出该空态字面");
    assert.equal(text.includes(EMPTY_OWNED), false, "降级 ≠「全部已归属」：同理不得把读失败洗成「池已清空」");
  });

  // 档 2：左集本身零行（注册表一台机 / 一个项目都没记过）
  const noneHtml = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: null,
    groupsOutcome: groupsOutcome(ALPHA_TWO),
    poolOutcome: computeProjectPool(snapFromRegistry([]), groupsOutcome(ALPHA_TWO)),
    poolSourceCount: 0,
  });
  assert.ok(noneHtml.includes(EMPTY_NONE) && !noneHtml.includes(EMPTY_OWNED), "左集零行 ⇒ 只说「机器注册表暂无项目记录」，不冒充「已归属」");

  // 档 3：左集有行、但全被减（真实空池）
  const ownedHtml = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: null,
    groupsOutcome: groupsOutcome(ALPHA_TWO, BETA_ONE),
    poolOutcome: computeProjectPool(
      snapFromRegistry([
        { machineId: "m1", projects: [{ projectId: "p-a1", lastReportedAt: REPORTED_A1 }, { projectId: "p-a2" }] },
        { machineId: "m2", projects: [{ projectId: "p-b1" }] },
      ]),
      groupsOutcome(ALPHA_TWO, BETA_ONE),
    ),
    poolSourceCount: 3,
  });
  assert.ok(ownedHtml.includes(EMPTY_OWNED) && !ownedHtml.includes(EMPTY_NONE), "有行但全已归属 ⇒ 只说「已全部归属某个项目组」，不得反向说成「注册表没记录」（旧源病灶正是把这一档显示成恒空）");
});

// ---------------------------------------------------------------------------
// ④ v0.9.8「项目池恒空修复」新增三枚：正锚（B-4 字面）/ 负锚（C-2·C-5 禁字）/ 装配锚（C-6 单点）
// ---------------------------------------------------------------------------

test("池-⑮（正锚 · B-4）池行弱提示逐字「最后上报于 {ISO 时刻}（非实时探测）」· 缺值不渲 · 右栏行不带该位", () => {
  const html = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: null,
    groupsOutcome: groupsOutcome(ALPHA_TWO),
    poolOutcome: computeProjectPool(
      snapFromRegistry([
        { machineId: "m1", projects: [{ projectId: "p-a1", lastReportedAt: REPORTED_A1 }] },
        { machineId: "m3", runnerState: "offline", projects: [{ projectId: "p-c1", lastReportedAt: REPORTED_C1 }] },
        { machineId: "m4", projects: [{ projectId: "p-d1" }] },
      ]),
      groupsOutcome(ALPHA_TWO),
    ),
    poolSourceCount: 3,
  });
  const poolSide = poolColumn(html);
  assert.match(poolSide, /<span class="muted">最后上报于 2026-09-20T23:59:59\.000Z（非实时探测）<\/span>/, "字面逐字：前缀 + 原样 ISO 时刻 + 「（非实时探测）」限定语（注册表投影 ≠ 实时探测）");
  assert.match(poolSide, /data-machine="m3" data-project="p-c1">[\s\S]*?最后上报于 2026-09-20T23:59:59\.000Z（非实时探测）/, "提示位落在**本行行内**（离线机的行，随行走）");
  assert.equal((poolSide.match(/最后上报于/g) ?? []).length, 1, "m4/p-d1 无 lastReportedAt ⇒ **不渲**该位（不臆造时刻），也不回落成别的时间字样");
  assert.equal(ownColumn(html).includes("最后上报于"), false, "右栏成员行字面逐字不变（时间位只属池行，声明面成员区不带）");
});

/** 池面禁字（C-2 组语义 + 运行态字样）：出参与渲染两侧都不得出现。 */
const POOL_BANNED_TOKENS = ["status", "online", "declared", "inGroup", "group", "groups", "ownerGroupName"];
const poolFaceViolations = (fragment) => POOL_BANNED_TOKENS.filter((token) => fragment.includes(token));

test("池-⑯（负锚 · C-2 / C-5）池面零运行态字样、零组语义字段 —— 含「锚拒得住含组布尔与 status 的假出参」生效证据", () => {
  // 1) 投影侧：把越界字段塞进假出参，池行只留三键（板不消费 ⇒ 也就无从上页）
  const taintedRows = poolRowsFromSnapshot(
    registryView([
      {
        machineId: "m1",
        runnerState: "offline",
        projects: [
          {
            projectId: "p-free",
            lastReportedAt: REPORTED_FREE,
            extra: { declared: true, inGroup: false, group: "beta", groups: ["beta"], ownerGroupName: "beta", online: true },
          },
        ],
      },
    ]),
  );
  assert.deepEqual(taintedRows.map((r) => Object.keys(r).sort()), [["lastReportedAt", "machineId", "projectId"]], "越界字段（组布尔 / 在线字样）在纯投影处即被丢弃");
  assert.equal(JSON.stringify(taintedRows).includes("beta"), false, "池行连字面值都不带组名（不是「带上了不显示」）");

  // 2) 渲染侧：真 SSR 的左栏一片段零禁字
  const html = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: null,
    groupsOutcome: groupsOutcome(ALPHA_TWO),
    poolOutcome: computeProjectPool({ ok: true, observedAt: OBSERVED, rows: taintedRows }, groupsOutcome(ALPHA_TWO)),
    poolSourceCount: 1,
  });
  assert.deepEqual(poolFaceViolations(poolColumn(html)), [], "池面出参不含 status / online 字样，也不含任何组语义字段（不采信运行态 = 会冒充在线）");

  // 3) 生效证据：同一判据对**故意违规**的池面必须逐字点名（否则本锚是空锚）
  const violating = '<div class="mrow" draggable="true" data-machine="m1" data-project="p-free" status="ok" online="1" declared="true" inGroup="false" group="beta" groups="beta" ownerGroupName="beta">x</div>';
  assert.deepEqual(poolFaceViolations(violating).sort(), [...POOL_BANNED_TOKENS].sort(), "禁字表逐字有牙：假池面只要带任一禁字就被锚拒");
});

test("池-⑰（装配锚 · C-6）src/server.ts 池源**仅一处**经 getRegistryProjects()，装配函数内零旧面残留", () => {
  const serverSource = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
  const start = serverSource.indexOf("async function pageOrgSpaceManage");
  assert.ok(start >= 0, "装配函数在位（锚的切片起点）");
  const rest = serverSource.slice(start);
  const endRel = rest.search(/\n(?:async )?function /);
  const body = endRel === -1 ? rest : rest.slice(0, endRel);
  assert.equal((body.match(/client\.getRegistryProjects\(\)/g) ?? []).length, 1, "池左集 = 唯一一处新 client 方法读（本函数体内）");
  assert.equal((serverSource.match(/client\.getRegistryProjects\(\)/g) ?? []).length, 1, "全文件也只这一处 ⇒ 不存在第二处池源（换源不得留下并存的两条读路）");
  assert.equal((body.match(/client\.getProjects\(\)/g) ?? []).length, 0, "旧面 `getProjects()` 在池装配路径**零残留**（它仍是别的页的读路，故只锚本函数体）");
  assert.equal((body.match(/poolSourceCount:/g) ?? []).length, 1, "左集规模单点随池装配 = 空态两分支的唯一事实源（B-3）");
  assert.equal((body.match(/poolOutcome,/g) ?? []).length, 1, "池结论单点入视图（差集在板、只装配一次）");
});

test("池-⑱（切片负向钉 · REQ-2026-10-10-03 N1）样式类锚不得再充当任何切片界 · 切片式只许写在两枚 helper 定义处", () => {
  const selfSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  // needle 用字符类拆开书写（inde[x]Of / [c]lass），本文件里因此不存在「样式类当界」的那串字面量本身。
  const styleBound = /inde[x]Of\s*\(\s*['"]?[^)'"]*[c]lass=/;
  assert.equal(styleBound.test(selfSource), false, "切片界只用两枚 DOM 锚（data-side / member-forms-fold）；样式类随重构漂移 ⇒ 拿它当界会静默切成空片段，锚看似在跑实则不验任何东西");
  const sliceSites = selfSource.split("\n").filter((line) => /\.slice\([^{]*inde[x]Of/.test(line));
  assert.equal(sliceSites.length, 2, "全文件只有两枚 helper 的定义行取界，测试体内不得再各写一份内联切片式");
  assert.ok(sliceSites.every((line) => /^const (pool|own)Column = /.test(line)), "取界的两行就是 poolColumn / ownColumn 的定义行");
});

/**
 * 池-⑲（迁入锚 · REQ-2026-10-10-03 N3）—— 逐组声明态成员清单卡退役（N2）后，
 * 原挂在该卡上的三条锚迁入本文件（本文件的夹具已装配池，`orgs-page` 的 harness 不装配 ⇒ 承接位只能落这里）：
 *  - 卡头「本组成员计数」（原 `orgs-page:593`「该组声明成员 2 项」）；
 *  - 「本组完整清单不减」（原 `orgs-page:594` 成员行 `<td>win-a</td><td>board</td>`）；
 *  - `observedAt` 上页（原 `orgs-page:597`，摘出 warn 夹具 ⇒ 本用例 warnings 为空，走正常档 summary）。
 */
test("池-⑲（迁入锚 · REQ-2026-10-10-03 N3）本组成员计数 + 本组完整清单 + 观测时刻上页（退役卡三条锚的承接位）", () => {
  const groups = {
    ok: true,
    warnings: [],
    observedAt: "2026-09-27T02:00:00.000Z",
    groups: [{ name: "alpha", memberCount: 2, members: [{ machineId: "win-a", projectId: "board" }, { machineId: "win-a", projectId: "orch" }] }],
  };
  const html = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: { ok: true, projects: [] },
    groupsOutcome: groups,
    poolOutcome: computeProjectPool(
      snapFromRegistry([{ machineId: "win-a", projects: [{ projectId: "board" }, { projectId: "orch" }, { projectId: "free-1" }, { projectId: "free-2" }] }]),
      groups,
    ),
  });
  assert.match(html, /池 2 项 · 本组 2 项/, "卡头计数承载「本组成员计数」（声明面两项不因退役卡而少报一项）");
  assert.match(
    ownColumn(html),
    /<div class="mrow" draggable="true" data-machine="win-a" data-project="board"><span class="mono">win-a<\/span> \/ <span class="mono">board<\/span>/,
    "本组完整清单不减（两项成员行逐条落右栏；两项 ⇒ 非末位 ⇒ 行带 draggable，与末位闸同判据）",
  );
  assert.match(html, /<p class="b-note ok">配置齐备 · 上次核对时间 2026-09-27T02:00:00\.000Z<\/p>/, "observedAt 上页（声明是快照不是实时）—— 无 warn 夹具的正常档一行");
});

// ---------------------------------------------------------------------------
// ⑤ REQ-2026-10-10-03 N4 · 退役卡承接位的两档互斥钉（N-4 / N-5 / N-4b）
// 「组未声明」与「已声明但成员清单为空」是**两个不同的事实**，不得塌成同一句；
// 「未声明」档由池卡**三出口**同渲同一枚 note（未查询 / 不可用 / 右栏空态）。
// ---------------------------------------------------------------------------

/** 声明面可读但**不含 alpha**（= 组未声明）。 */
const UNDECLARED_GROUPS = groupsOutcome(BETA_ONE);
/** 声明面可读且 alpha 已声明、成员清单为空（= 已声明无成员）。 */
const DECLARED_EMPTY_ALPHA = { name: "alpha", memberCount: 0, members: [] };

test("池-⑳（N-4 · REQ-2026-10-10-03 N4）两档互斥钉：组未声明 ⇒ 渲「未声明」，且不得渲成「已声明、成员清单为空」", () => {
  const html = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: null,
    groupsOutcome: UNDECLARED_GROUPS,
    poolOutcome: computeProjectPool(pool([prow("m1", "p-a1"), prow("m9", "p-free")]), UNDECLARED_GROUPS),
  });
  assert.match(html, /<b>未声明<\/b>/, "退役卡的「未声明」档由池卡承接（诚实通道不因删卡失承载）");
  assert.doesNotMatch(
    html,
    /（本组暂无项目：该组已在 orch 声明、成员清单为空/,
    "「组未声明」≠「已声明但成员为空」：两档字面不得互塌（塌成同句即本锚红）",
  );
});

test("池-㉑（N-4b · REQ-2026-10-10-03 N4）三出口的另两个早退出口同样承接「未声明」（快照未装配 / 池不可用）", () => {
  const unassembled = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: null,
    groupsOutcome: UNDECLARED_GROUPS,
    poolOutcome: null,
  });
  assert.match(unassembled, /<b>未声明<\/b>/, "出口一「未查询」档：右栏空态渲不出，仍由早退分支带出未声明 note");
  const unavailable = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: null,
    groupsOutcome: UNDECLARED_GROUPS,
    poolOutcome: { ok: false, code: "snapshot_unreachable", error: "快照面爆炸（假）" },
  });
  assert.match(unavailable, /<b>未声明<\/b>/, "出口二「不可用」档：整块灰化也不得丢掉未声明结论");
});

test("池-㉒（N-5 · REQ-2026-10-10-03 N4）右栏空态正锚：已声明 ∧ members 为空 ⇒ 渲「本组暂无项目…」且不与「建组」引导混写", () => {
  const html = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: null,
    groupsOutcome: groupsOutcome(DECLARED_EMPTY_ALPHA, BETA_ONE),
    poolOutcome: computeProjectPool(pool([prow("m9", "p-free")]), groupsOutcome(DECLARED_EMPTY_ALPHA, BETA_ONE)),
  });
  assert.match(
    ownColumn(html),
    /（本组暂无项目：该组已在 orch 声明、成员清单为空 —— 左栏拖入即加入本组/,
    "已声明空组的右栏空态逐字在位（与池-⑳ 是一对互斥钉的两半）",
  );
  assert.doesNotMatch(ownColumn(html), /建组/, "该档不得冒充「未声明」的建组引导（组已在声明面存在）");
});
