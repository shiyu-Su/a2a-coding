/**
 * REQ-2026-10-11-06「项目池手动刷新」· N2 —— 管理页项目池卡的**手动刷新表单**（SSR 面）
 * · N3 同档续写 —— 同表单的 **HTTP 装配面 + 负锚（P3 / P4 / P5 / P7 / P8）**。
 *
 * 钉住的语义（改造文档 §2 / §4.1 实现级 P1 · P2 · P6 · P9）：
 *  · **D 零脚本档** —— 刷新 = 一枚原生 `method="get"` 表单，提交即整页重载；表单**不带**
 *    `data-ov` / `data-submit` / `data-live` / `hidden` / `onclick` 任一（GET 无覆盖层报错语义）；
 *  · **不进第八枚刷新面** —— 不蹭 `.live-now` / `.b-card a.fl`（那两个是 `PAGE_LIVE_SCRIPT` 的
 *    委托选择器，蹭上即把零脚本档悄悄接回脚本面）；
 *  · **三档统一** —— 未查询 / 不可用 / 正常三档**各有且仅有一枚**该表单（灰化档不得顺手摘掉刷新口）；
 *  · **表单落卡体不落 meta** —— 位置在 `<p class="b-card-h">` 之后、`class="m-pool"` 容器之前，
 *    且在两栏切片**之外**（卡头 meta 不承载写/刷面）；
 *  · **不冒充在线** —— 刷新只重跑服务端读取，池行仍只带「最后上报于 …（非实时探测）」，
 *    不采信 `status` / `online`（该口径的负锚在 `org-pool-two-column.test.mjs` 池-⑯，本档不重钉）。
 *
 * **本档只钉结构、不验运行时**（口径照 `live-refresh.test.mjs`）：SSR 面 = 真渲染取 HTML；
 * HTTP 装配面（P3 / P4 / P5 / P7 / P8，N3 续写）= 真起板取 HTML，**不验浏览器行为**
 * （脚本执行面在 `n3-regression-anchors.test.mjs` 与 `org-pool-drag.test.mjs`，本档不起脚本）。
 *
 * **P4 的测量域（N3 定样，与节点要点原文有一处口径修正）**：要点写「`.live-now` 类名恒 0」，
 * 整页 HTML 实测恒 **1** —— 那一处是**全站样式常量**里的 `.live-now { … }` 规则（`layout.ts:1561`，
 * 属第八枚 `PAGE_LIVE_SCRIPT` 的既有件，早于本卡且本卡未碰）。故本锚把测量域收到
 * **样式块之外的 markup**（`stripStyle` 后计数恒 0），并同轮钉住「样式块内确有 1 处 `.live-now`」
 * 作对照 —— 拆两段计数既不放水也不空转。判 `data-live` 不必拆：整页实测恒 0。
 *
 * 夹具**各档自建**（不 import 别的 `.test.mjs` 的私有 helper）：形状抄自
 * `org-pool-two-column.test.mjs`，抄写不得反向污染那份文件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeProjectPool, poolRowsFromSnapshot } from "../dist/orgs-view.js";
import { renderOrgSpaceManagePage } from "../dist/web/views.js";
import { createBoardServer } from "../dist/server.js";

/** 本文件声明的锚条数（P9 自证钉：`test()` 实数必须等于它，防「写了不跑 / 写了不报」。） */
const DECLARED_ANCHOR_TESTS = 9;

// ---------------------------------------------------------------------------
// 切片 helper（界只用两枚稳定 DOM 锚 `data-side` / `org-host-agent-kind-list`，样式类锚不作切片界）
// ---------------------------------------------------------------------------

const poolColumn = (html) => html.slice(html.indexOf('data-side="pool"'), html.indexOf('data-side="own"'));
const ownColumn = (html) => html.slice(html.indexOf('data-side="own"'), html.indexOf('id="org-host-agent-kind-list"'));

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const OBSERVED = "2026-10-03T01:00:00.000Z";
const REPORTED_A1 = "2026-10-01T08:30:00.000Z";
const REPORTED_C1 = "2026-09-20T23:59:59.000Z";

/** 声明面：alpha 两项（本组）· beta 一项（别组）。 */
function groupsOutcome(...rows) {
  return { ok: true, warnings: [], observedAt: OBSERVED, groups: rows };
}

const ALPHA_TWO = { name: "alpha", memberCount: 2, members: [{ machineId: "m1", projectId: "p-a1" }, { machineId: "m1", projectId: "p-a2" }] };
const BETA_ONE = { name: "beta", memberCount: 1, members: [{ machineId: "m2", projectId: "p-b1" }] };

/** 池的一行（`PoolProjectRow` 出口形状：三键，时间位随行、不参与配对键）。 */
const prow = (machineId, projectId, lastReportedAt = null) => ({ machineId, projectId, lastReportedAt });

const pool = (rows) => ({ ok: true, rows, observedAt: OBSERVED });

/** 注册表机器清单的出参形状（`RegistryProjectsView` = 池左集读取源）。 */
function registryView(machines) {
  const projects = machines.reduce((n, m) => n + (m.projects?.length ?? 0), 0);
  return {
    source: "registry",
    note: null,
    observedAt: OBSERVED,
    machines: machines.map((m) => ({
      machineId: m.machineId,
      runnerState: m.runnerState ?? "online",
      lastHeartbeatAt: m.runnerState === "offline" ? REPORTED_C1 : OBSERVED,
      firstRegisteredAt: "2026-09-01T00:00:00.000Z",
      projects: (m.projects ?? []).map((p) => ({
        projectId: p.projectId,
        agentKind: "qoder",
        a2aPort: 1,
        status: "ok",
        endpoint: null,
        startedAt: null,
        lastReportedAt: p.lastReportedAt ?? null,
      })),
    })),
    counts: { machines: machines.length, projects },
  };
}

/** 注册表清单 → 左集读取结论（等价 server.ts 里的 `poolRowsFromSnapshot(await getRegistryProjects())`）。 */
const snapFromRegistry = (machines) => ({ ok: true, rows: poolRowsFromSnapshot(registryView(machines)), observedAt: OBSERVED });

// ---------------------------------------------------------------------------
// 三档页面（P2 逐档各数一枚；正常档另供 P1 / P6）
// ---------------------------------------------------------------------------

const GROUPS_OK = groupsOutcome(ALPHA_TWO, BETA_ONE);
const REGISTRY_ROWS = [
  { machineId: "m1", projects: [{ projectId: "p-a1", lastReportedAt: REPORTED_A1 }, { projectId: "p-a2" }] },
  { machineId: "m2", projects: [{ projectId: "p-b1" }] },
  { machineId: "m3", runnerState: "offline", projects: [{ projectId: "p-c1", lastReportedAt: REPORTED_C1 }] },
];

const normalHtml = renderOrgSpaceManagePage({
  org: "alpha",
  features: [],
  projectsOutcome: null,
  groupsOutcome: GROUPS_OK,
  poolOutcome: computeProjectPool(snapFromRegistry(REGISTRY_ROWS), GROUPS_OK),
  poolSourceCount: REGISTRY_ROWS.reduce((n, m) => n + m.projects.length, 0),
});
const unknownHtml = renderOrgSpaceManagePage({ org: "alpha", features: [], projectsOutcome: null, groupsOutcome: null, poolOutcome: null });
const unavailableGroups = { ok: false, code: "machines_config_error", error: "3300 配置坏" };
const unavailableHtml = renderOrgSpaceManagePage({
  org: "alpha",
  features: [],
  projectsOutcome: null,
  groupsOutcome: unavailableGroups,
  poolOutcome: computeProjectPool(pool([prow("m3", "p-c1", REPORTED_C1)]), unavailableGroups),
});

const FORM_RE = /<form method="get" action="\/org\/alpha\/manage" class="m-refresh">/g;
const BUTTON_RE = /<button type="submit">⟳ 刷新项目池<\/button>/g;
const TIERS = { 未查询: unknownHtml, 不可用: unavailableHtml, 正常: normalHtml };

// ---------------------------------------------------------------------------
// 锚
// ---------------------------------------------------------------------------

test("P1（正锚 · 形态逐字）正常档恰 1 枚 GET 刷新表单 + 恰 1 枚提交钮；落卡在卡头之后、m-pool 之前；表单串内零 data-ov/data-submit/data-live/hidden/onclick", () => {
  assert.equal((normalHtml.match(FORM_RE) ?? []).length, 1, "刷新表单恰 1 枚（0 = 面没出，≥2 = 重复出）");
  assert.equal((normalHtml.match(BUTTON_RE) ?? []).length, 1, "「⟳ 刷新项目池」提交钮恰 1 枚");
  const at = normalHtml.indexOf('<form method="get" action="/org/alpha/manage" class="m-refresh">');
  assert.ok(at > normalHtml.indexOf('<p class="b-card-h">'), "表单在卡头之后 ⇒ 不在 meta 位");
  assert.ok(at < normalHtml.indexOf('class="m-pool"'), "表单在 m-pool 容器之前 ⇒ 落在卡体首段，刷新口先于数据可见");
  const form = normalHtml.slice(at, normalHtml.indexOf("</form>", at) + 7);
  for (const token of ["data-ov", "data-submit", "data-live", "hidden", "onclick", "live-now", ".b-card a.fl"]) {
    assert.equal(form.includes(token), false, `D 零脚本档：表单串内不得含「${token}」（蹭上即把零脚本档接回脚本/浮层面）`);
  }
  assert.equal(poolColumn(normalHtml).includes("<form"), false, "左栏切片内零表单（表单在两栏容器之外）");
  // ⑦a（REQ-2026-10-11-05 N7 · 用户 2026-10-12 裁甲案）：右界换成 agent 配置卡内的 datalist 后，
  // 「右栏切片内零表单」不再可持（datalist 落在该卡 `<form>` 开标签之后）⇒ 本锚改判为下面两条。
  assert.ok(
    normalHtml.indexOf('id="org-host-agent-kind-list"') > normalHtml.indexOf('data-side="own"'),
    "右界锚在位且在右栏之后（界坏 ⇒ indexOf = -1 ⇒ 本条红）",
  );
  assert.equal(
    ownColumn(normalHtml).includes('<input type="hidden" name="action" value="disable">'),
    false,
    "右栏切片不越界吃到停用卡（界坏 ⇒ 切片延至文末 ⇒ 本条红）",
  );
});

test("P2（正锚 · 三档统一）未查询 / 不可用 / 正常三档各含恰 1 枚刷新表单；两枚灰化档仍不给出 id=\"member-pool\"（池-⑩ 口径不破）", () => {
  for (const [label, html] of Object.entries(TIERS)) {
    assert.equal((html.match(FORM_RE) ?? []).length, 1, `${label}档刷新表单恰 1 枚（灰化档不得顺手摘掉刷新口 —— 重查正是它唯一的出路）`);
    assert.equal((html.match(BUTTON_RE) ?? []).length, 1, `${label}档提交钮恰 1 枚`);
  }
  for (const label of ["未查询", "不可用"]) {
    assert.equal(TIERS[label].includes('id="member-pool"'), false, `${label}档不呈现两栏容器（降级不给假池编造归属，本卡加表单不破该口径）`);
  }
  assert.equal(normalHtml.includes('id="member-pool"'), true, "对照：正常档两栏容器仍在（否则上面两枚负锚是空锚）");
});

test("P6（负锚 · 写面闭集重钉）正常档 data-ov=\"1\" 计数恒 2 —— ⑦b 退役两枚成员手填表单后，浮层档闭集只剩停用 + agent 配置", () => {
  assert.equal((normalHtml.match(/data-ov="1"/g) ?? []).length, 2, "写面浮层档闭集 = 停用 / agent 配置两枚（⑦b 加 / 删成员表单退役）；GET 刷新表单不带 data-ov");
});

// ---------------------------------------------------------------------------
// N3 追加夹具：本地 HTTP 面（形状照 `org-pool-two-column.test.mjs` 的 withManagePage / manageClient，
// 各档自建、不 import 那份文件的私有 helper）
// ---------------------------------------------------------------------------

/** 需求投影的最小形状（空间归一 `featureOrgGroups` 只吃 `ownerGroup`）。 */
const feature = (featureId, ownerGroup) => ({
  featureId,
  state: "executing",
  title: `需求 ${featureId}`,
  taskCount: 1,
  ownerGroup,
  stage: "改造方案",
  version: "v0.10.4",
  approval: "已通过",
  createdAt: "c",
  updatedAt: "u",
  stateCounts: null,
});

/** 起一次板（port 0）⇒ 跑 `run(base)` ⇒ 无论如何关 handle。 */
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

const get = async (url) => {
  const res = await fetch(url);
  return { status: res.status, text: await res.text() };
};

/** 可执行内联脚本枚数（口径照 `org-pool-drag.test.mjs:227`；本档自建，不跨文件取私有 helper）。 */
const bareScriptCount = (html) => (html.match(/<script>/g) ?? []).length;

/** 全站样式常量（`<style>…</style>`）与页面 markup 分离 —— P4 的测量域（见文件头「P4 的测量域」）。 */
const STYLE_RE = /<style>[\s\S]*?<\/style>/g;
const styleBlocks = (html) => html.match(STYLE_RE) ?? [];
const markupOf = (html) => html.replace(STYLE_RE, "");

/** 刷新表单片段（`<form …>` 到 `</form>`，含钮）；form 锚点用 DOM 属性锚、不用样式类锚。 */
const refreshFormFragment = (html) => {
  const at = html.indexOf('<form method="get" action="');
  if (at === -1) return "";
  const end = html.indexOf("</form>", at);
  return end === -1 ? html.slice(at) : html.slice(at, end + 7);
};

/** 池面禁字表（复用 `org-pool-two-column.test.mjs:465` 的同一枚闭集，扩到钮区判据）。 */
const POOL_BANNED_TOKENS = ["status", "online", "declared", "inGroup", "group", "groups", "ownerGroupName"];
const bannedHits = (fragment) => POOL_BANNED_TOKENS.filter((token) => fragment.includes(token));

/** 中文组织名（编码锚）：SSR 与 HTTP 两档必须同形。 */
const CN_ORG = "组织甲";
const CN_ORG_ENCODED = "%E7%BB%84%E7%BB%87%E7%94%B2";
const CN_FORM_OPEN = `<form method="get" action="/org/${CN_ORG_ENCODED}/manage" class="m-refresh">`;

// ---------------------------------------------------------------------------
// N3 锚（P3 / P4 / P5 / P7 / P8）
// ---------------------------------------------------------------------------

test("P7（正+负合钉 · 一次点击 = 一次读）同一 handle 连发两次 GET ⇒ 注册表读 2、旧面读 0；src/server.ts 全文件池读恰 1 处", async () => {
  let registryReads = 0;
  let legacyReads = 0;
  await withManagePage(
    manageClient({
      async getRegistryProjects() {
        registryReads += 1;
        return registryView(REGISTRY_ROWS);
      },
      async getProjects() {
        legacyReads += 1;
        throw new Error("刷新一次不得再读旧面（差集恒空的老病灶）");
      },
    }),
    async (base) => {
      const first = await get(`${base}/org/alpha/manage`);
      assert.equal(first.status, 200, "第一次 GET 可达（不靠 404 蒙混计数）");
      assert.match(first.text, FORM_RE, "第一次 GET 已把刷新表单装上页");
      const second = await get(`${base}/org/alpha/manage`);
      assert.equal(second.status, 200, "第二次 GET（= 点一次刷新）可达");
      assert.equal(registryReads, 2, "一次页面装载 = 恰一次池读 ⇒ 两次装载两次读（不多读、不漏读）");
      assert.equal(legacyReads, 0, "本卡不新增第二条池读路 ⇒ 旧 `/api/projects` 一次都不碰");
    },
    { groupsFetcher: async () => GROUPS_OK },
  );
  const serverSource = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.equal(
    (serverSource.match(/client\.getRegistryProjects\(\)/g) ?? []).length,
    1,
    "全文件只这一处池读（回指池-⑰ 判据：加刷新口不得另立第二条读路）",
  );
});

test("P8（正锚 · 编码）中文组织名两档同形：SSR 档 action 出 /org/<ENC>/manage；HTTP 档 GET 同 URL ⇒ 200 且刷新表单在位", async () => {
  assert.equal(CN_ORG_ENCODED, encodeURIComponent(CN_ORG), "锚里的编码字面量与该组织名的 encodeURIComponent 一致（防抄错编码）");
  const ssr = renderOrgSpaceManagePage({ org: CN_ORG, features: [], projectsOutcome: null, groupsOutcome: null, poolOutcome: null });
  assert.ok(ssr.includes(CN_FORM_OPEN), `SSR 档 action 必须是编码形态（实际片段：${refreshFormFragment(ssr).slice(0, 90)}）`);
  assert.equal(refreshFormFragment(ssr).includes(CN_ORG), false, "编码档里不得出现未编码的中文组织名（浏览器与原生 GET 都按 percent-encoding 走）");
  await withManagePage(
    manageClient({
      async getFeatures() {
        return { features: [feature("F2", CN_ORG)], stateCounts: null };
      },
      async getRegistryProjects() {
        return registryView(REGISTRY_ROWS);
      },
    }),
    async (base) => {
      const res = await get(`${base}/org/${CN_ORG_ENCODED}/manage`);
      assert.equal(res.status, 200, "编码 URL 经空间归一命中管理页（照 web.test.mjs:541 的编码先例）");
      assert.ok(res.text.includes(CN_FORM_OPEN), "HTTP 档与 SSR 档逐字同形（同一渲染单点）");
    },
    { groupsFetcher: async () => groupsOutcome({ name: CN_ORG, memberCount: 0, members: [] }) },
  );
});

test("P3（负锚 · 零脚本）管理页 HTTP 面可执行内联脚本恒 2；layout.ts 脚本常量体枚数未扩（八元闭集由 N3-⑦/⑪ 自证）", async () => {
  await withManagePage(
    manageClient({
      async getRegistryProjects() {
        return registryView(REGISTRY_ROWS);
      },
    }),
    async (base) => {
      const res = await get(`${base}/org/alpha/manage`);
      assert.equal(res.status, 200);
      assert.equal(bareScriptCount(res.text), 2, "管理页 = 提交守卫 + 成员两栏拖拽两枚（D 零脚本档：刷新表单不得带来第三枚）");
      assert.equal(markupOf(res.text).includes("data-live-interval"), false, "第八枚的入口特征也不在页上（与 P4 同一条防线）");
    },
    { groupsFetcher: async () => GROUPS_OK },
  );
  const layout = readFileSync(new URL("../src/web/layout.ts", import.meta.url), "utf8");
  assert.equal(
    (layout.match(/export const \w+_SCRIPT = `<script>/g) ?? []).length,
    6,
    "layout.ts 脚本常量声明恒六枚（闭集另两枚在他处文件；本卡未扩枚 ⇒ 不得为刷新表单新写一枚）",
  );
  assert.equal(
    (layout.match(/<script>/g) ?? []).length,
    10,
    "layout.ts 全文裸 `<script>` 字面量枚数与本节点前一致（八元闭集未扩、正文未被复制）",
  );
});

test("P5（负锚 · 禁字表扩到钮区 + 生效证据）刷新表单片段零池面禁字（三档 + 中文名档）；同判据对违规假串逐字点名七枚禁字", () => {
  const fragments = [
    ["正常档", refreshFormFragment(normalHtml)],
    ["未查询档", refreshFormFragment(unknownHtml)],
    ["不可用档", refreshFormFragment(unavailableHtml)],
    ["中文组织名档", refreshFormFragment(renderOrgSpaceManagePage({ org: CN_ORG, features: [], projectsOutcome: null, groupsOutcome: null, poolOutcome: null }))],
  ];
  for (const [label, fragment] of fragments) {
    assert.ok(fragment.length > 0, `${label}必须取到非空表单片段（空片段 = 本锚空转）`);
    assert.deepEqual(bannedHits(fragment), [], `${label}刷新表单不带任何池面禁字（刷新只重跑读取，不得顺手把运行态 / 组语义字样带上钮区）`);
  }
  const violating =
    '<form method="get" action="/org/alpha/manage" class="m-refresh" status="ok" online="1" declared="true" inGroup="false" group="beta" groups="beta" ownerGroupName="beta">';
  assert.deepEqual(
    bannedHits(violating).sort(),
    [...POOL_BANNED_TOKENS].sort(),
    "禁字表在钮区逐字有牙：假表单只要带任一禁字就被锚拒（否则上面四条是空锚）",
  );
});

test("P4（负锚 · 不进第八枚刷新面 + 生效证据）管理页 markup 零 data-live、样式块外零 live-now；同判据对塞了 live 锚的假串必报非零", async () => {
  const liveHits = (html) => (html.match(/data-live/g) ?? []).length;
  const nowHits = (html) => (markupOf(html).match(/live-now/g) ?? []).length;

  const ssr = markupOf(normalHtml);
  assert.equal(liveHits(normalHtml), 0, "SSR 档整页零 `data-live`（管理页不属 live 三页）");
  assert.equal(nowHits(normalHtml), 0, "SSR 档 markup 零 `live-now`（SSR 片段本就不含样式块 ⇒ 与 HTTP 档同一谓词）");
  assert.ok(ssr.includes('class="m-refresh"'), "对照：SSR 片段里刷新表单确实在位（否则上面两枚是空锚）");

  await withManagePage(
    manageClient({
      async getRegistryProjects() {
        return registryView(REGISTRY_ROWS);
      },
    }),
    async (base) => {
      const res = await get(`${base}/org/alpha/manage`);
      assert.equal(res.status, 200);
      assert.equal(liveHits(res.text), 0, "HTTP 档整页零 `data-live` ⇒ 刷新口没蹭上第八枚的委托选择器");
      assert.equal(nowHits(res.text), 0, "HTTP 档样式块之外零 `live-now`（钮类名走新的 `m-refresh`，不复用 live 面）");
      const styles = styleBlocks(res.text);
      assert.equal(styles.length, 1, "全站样式常量恰一块（P4 的两段计数以此为界）");
      assert.equal(((styles[0].match(/\.live-now/g) ?? []).length), 1, "对照：`.live-now` 确在全站样式里 1 处 ⇒「样式块外为 0」是真判据、不是因为该字样根本不存在");
      const fake = `${res.text}<div class="live-slot" data-live="steps"><button type="button" class="fl live-now">⟳</button></div>`;
      assert.ok(liveHits(fake) > 0, "生效证据：塞一枚 `data-live` 锚的假页必须被报非零");
      assert.ok(nowHits(fake) > 0, "生效证据：塞一枚 live-now 类名的假页必须被报非零");
    },
    { groupsFetcher: async () => GROUPS_OK },
  );
});

test("P9（自证钉）本文件 test() 实数 = DECLARED_ANCHOR_TESTS ⇒ 写了就必须报", () => {
  const self = readFileSync(new URL(import.meta.url), "utf8");
  const declared = self.split("\n").filter((line) => line.startsWith("test(")).length;
  assert.ok(declared > 0, "扫描器必须真的见到 test() 声明（0 = 本钉空转）");
  assert.equal(declared, DECLARED_ANCHOR_TESTS, `本档实有 ${String(declared)} 条 test()，与声明的 ${String(DECLARED_ANCHOR_TESTS)} 不符 ⇒ 改锚须同步改条数`);
});
