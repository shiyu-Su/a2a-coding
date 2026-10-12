/**
 * REQ-2026-09-30-04「板样式重构」件5 — 空间·任务页 + 空间·管理页卡化（原型 v2.3 样张④/⑤）。
 *
 * 钉住的语义（改版式前后的**行为边界**，防止后续把写面通路一起改掉）：
 *  ① 任务页选单档 = 过滤卡（GET 表单标记逐字不动，只外套卡）+ 快捷项目 chips + 默认带出结果卡；
 *  ② 默认带出只在**空间档 ∧ 声明面可判定**时发生（C2 读失败档不得外泄项目、也不带出）；
 *  ③ 管理页 = 两栏池卡（⑦b 起加 / 减成员双表单卡与「成员（项目组台账）」卡退役，成员写只剩拖拽）
 *     + 页头核对短条（★⑧a：原「配置核对」卡降级为一条 `<p class="hint">`；正常态尾串「配置齐备」
 *       · warn 档落警示条且仍「不参与任何判定」）；
 *  ④ **写面闭集随 ⑦b 收窄**：manage 页 `data-ov="1"` 恰 2 枚（停用 / agent 配置）、余下表单 action 与 hidden 字段逐字不变。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderTasksPick,
  renderTasks,
  renderOrgSpaceManagePage,
  ORG_HOST_AGENT_KIND_SUGGESTIONS,
} from "../dist/web/views.js";
import { LAST_MEMBER_REMOVE_CODE, LAST_MEMBER_REMOVE_DISPLAY } from "../dist/group-admin.js";
import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-10-02T00:00:00Z");
const ENC_JIA = "%E7%BB%84%E7%BB%87%E7%94%B2"; // 组织甲

const projectsFixture = {
  source: "fake",
  note: null,
  observedAt: "2026-10-02T00:00:00Z",
  machines: [
    {
      machineId: "m1",
      error: null,
      projects: [
        { projectId: "zeta", agentKind: "qoder", a2aPort: 1, status: "ok", endpoint: null, startedAt: null },
        { projectId: "alpha", agentKind: "qoder", a2aPort: 2, status: "ok", endpoint: null, startedAt: null },
      ],
    },
  ],
  runners: [],
};

const tasksFixture = {
  projectId: "alpha",
  reachable: true,
  notice: null,
  tasks: [
    { taskId: "t1", contextId: "ctx1", state: "working", prompt: "做 x", text: null, updatedAt: "2026-10-02T00:00:00Z", stale: false },
  ],
};

// ---------------------------------------------------------------------------
// ① / ③ 纯函数面：卡化后的结构与写面闭集
// ---------------------------------------------------------------------------

test("件5-①（任务页选单档）：过滤卡在位 + GET 表单标记逐字不动 + 无 preview ⇒ 不渲结果卡", () => {
  const html = renderTasksPick(projectsFixture, null);
  assert.match(html, /<div class="b-card b-filter">/, "裸表单升级成过滤卡");
  assert.match(html, /<form method="get" action="\/tasks">/, "读面表单锚逐字保留（零属性改动）");
  assert.match(html, /<button type="submit">查询<\/button>/, "查询钮在卡内");
  assert.match(html, /<div class="b-chips">[\s\S]*?href="\/tasks\?project=alpha"/, "快捷项目 chips 进卡");
  assert.equal(html.includes("默认带出"), false, "未传 preview ⇒ 不渲结果卡（旧「先选项目」形态）");
});

test("件5-①b（默认带出档）：结果卡 + 五列 + 状态徽标 + 当前 chip 高亮 + 重查出口", () => {
  const html = renderTasksPick(projectsFixture, null, null, null, { view: tasksFixture, limit: 10 });
  assert.match(html, /默认带出 <span class="mono">alpha<\/span> 近 10 条（读回 1 条）/, "卡头如实标出带出项目与条数");
  assert.match(html, /<th>taskId<\/th><th>状态<\/th><th>更新<\/th><th>contextId<\/th><th>prompt 摘要<\/th>/, "结果表五列");
  assert.match(html, /<span class="b-badge run">执行中（working）<\/span>/, "状态列走徽标（文案口径不变）");
  assert.match(html, /<a class="on" href="\/tasks\?project=alpha">/, "带出项目的 chip 标当前项");
  assert.match(html, /不带过滤重查/, "卡头留重查出口");
});

test("件5-①c（查询档）：renderTasks 复用同一张结果卡", () => {
  const html = renderTasks(tasksFixture, { limit: 10 });
  assert.match(html, /<div class="b-card">\n<p class="b-card-h">结果/, "结果表在卡内");
  assert.match(html, /共 1 条[\s\S]*?<a class="fl" href="\/tasks">换项目<\/a>/, "计数 + 换项目口在卡头");
  assert.match(html, /过滤：<span class="mono">limit=10<\/span>/, "过滤回显保留");
});

test("件5-③（管理页 · 正常态）：池卡 + 停用表单 + 页头核对短条（⑦b 双表单卡与台账卡退役；★⑧a 核对卡降为短条）", () => {
  const html = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: {
      ok: true,
      projects: [{ machineId: "win-a", projectId: "board", agentKind: "qoder", a2aPort: 1, status: "ok", startedAt: null, machineError: null }],
    },
    groupsOutcome: {
      ok: true,
      warnings: [],
      observedAt: "2026-10-02T01:00:00.000Z",
      groups: [{ name: "alpha", memberCount: 1, members: [{ machineId: "win-a", projectId: "board" }] }],
    },
  });
  assert.doesNotMatch(html, /<div class="b-forms">[\s\S]*?加成员[\s\S]*?删成员/, "⑦b 加 / 减成员双表单卡退役（不复活）");
  assert.doesNotMatch(html, /id="member-forms-fold"/, "⑦b 折叠宿主随表单一起删除");
  assert.doesNotMatch(html, /成员（项目组台账）/, "⑦b 「成员（项目组台账）」卡整块退役 ⇒ 卡头字面亦不得出现（装配序随挂载删除收窄）");
  assert.doesNotMatch(html, /成员（声明态/, "REQ-2026-10-10-03 N2：逐组声明态成员清单卡退役 ⇒ 管理页不再出现该区块（计数与观测时刻改由页头核对短条 / 池卡承载，见 :108）");
  assert.doesNotMatch(
    html,
    new RegExp(`<p class="b-note danger"><b>末位成员不可删</b>[\\s\\S]*?${LAST_MEMBER_REMOVE_CODE}`),
    "⑦b 卡内常驻「末位成员不可删」警示条随表单退役（判据只剩服务端 409 + 末位行不给 draggable）",
  );
  assert.equal(html.includes(LAST_MEMBER_REMOVE_DISPLAY), false, "⑦b 警示条文案（常量逐字）不再出现在管理页（只在 409 浮层档出现）");
  assert.match(
    html,
    /<p class="hint">核对源健康度：[\s\S]*?配置齐备 · 上次核对时间 2026-10-02T01:00:00\.000Z<\/p>/,
    '两源齐备 ⇒ 正常态一行（★REQ-2026-10-11-05 ⑧a：原卡内独立 `<p class="b-note ok">` 并入页头短条尾串，原词逐字保留）',
  );
  assert.equal((html.match(/data-ov="1"/g) ?? []).length, 2, "写面浮层档闭集 = 停用 / agent 配置两枚（⑦b 加 / 删成员表单退役）");
  assert.match(html, /<form method="post" action="\/orgs" class="inline" data-submit="已提交，停用中…" data-ov="1" data-ov-redirect="\/">/, "停用表单标记逐字不动");
  assert.match(html, /<p class="b-card-h">加 \/ 删项目（两栏拖拽）/, "对照：池卡卡头在位（本夹具未装配 poolOutcome ⇒「未查询」档，上面的负锚非空锚）");
  assert.match(html, /<p class="b-card-h">本组织 agent 配置/, "对照：agent 配置卡在位（余下两枚浮层表单的宿主）");
});

test("v0.9.8-agent 配置卡（已配档）：预填当前值 + 来源标注「本组织」；只配 kind ⇒ model 标「后端缺省」（不沿用全局）", () => {
  const html = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: null,
    groupsOutcome: null,
    hostAgent: { orgKind: "qoder", orgModel: null, globalKind: "claude", globalModel: "glob-m" },
  });
  assert.match(html, /<input type="hidden" name="action" value="setHostAgent">/, "分流到既有 POST /orgs（白名单不扩条）");
  assert.match(html, /<label>agentKind（后端适配器）<input name="agentKind" value="qoder"/, "kind 预填当前值");
  assert.match(html, /<label>agentModel（后端模型）<input name="agentModel" value=""/, "model 未配 ⇒ 预填空串");
  assert.match(html, /kind = <code>qoder<\/code>（来源：本组织）/, "回显标「本组织」");
  assert.match(html, /model = <code>（后端缺省）<\/code>（来源：后端缺省）/, "只配 kind ⇒ 全局 model 不沿用（回显缓解静默失效，改造文档 §6）");
  assert.match(html, /全局默认：kind = <code>claude<\/code> · model = <code>glob-m<\/code>/, "全局默认值随卡回显");
  assert.match(html, /停桥后下一轮才用新值/, "hint① 生效口径");
  assert.match(html, /502 <code>spawn_failed<\/code>/, "hint② kind 写错指引");
  assert.match(html, /AGENTS\.md<\/code> 内的后端标识仍为<b>全局值<\/b>/, "hint③ 种子 AGENTS.md 遗留");
});

test("v0.9.8-agent 配置卡（未配档）：两键 null ⇒ 空预填 + 回落全局回显；宿主面未装配如实标注不伪装", () => {
  const html = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: null,
    groupsOutcome: null,
    hostAgent: { orgKind: null, orgModel: null, globalKind: "claude", globalModel: null },
  });
  assert.match(html, /kind = <code>claude<\/code>（来源：全局默认）/, "kind 未配 ⇒ 回显全局值");
  assert.match(html, /model = <code>（后端缺省）<\/code>（来源：后端缺省）/, "全局 hostModel 未配置 ⇒ 后端缺省");
  assert.match(html, /placeholder="留空 = 回落全局默认"/, "留空语义写进 placeholder");
  const absent = renderOrgSpaceManagePage({ org: "alpha", features: [], projectsOutcome: null, groupsOutcome: null });
  assert.match(absent, /kind = <code>（宿主面未装配）<\/code>/, "省略 hostAgent（宿主面未装配）⇒ 不伪装成有全局值");
});

test("v0.9.8-增补（REQ-2026-10-04-01）：agentKind 带板侧建议下拉 —— list 属性 + 同 form 内 datalist 四条 option", () => {
  const html = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: null,
    groupsOutcome: null,
    hostAgent: { orgKind: "claude", orgModel: null, globalKind: "claude", globalModel: null },
  });
  assert.match(
    html,
    /<label>agentKind（后端适配器）<input name="agentKind" value="claude" list="org-host-agent-kind-list" placeholder="留空 = 回落全局默认"><\/label>/,
    "input 仅追加 list（name / value / placeholder 与属性序不动）",
  );
  assert.match(
    html,
    /<\/label>\n<datalist id="org-host-agent-kind-list">/,
    "datalist 紧随该 label 之后（同一 form 内）",
  );
  assert.match(
    html,
    /<datalist id="org-host-agent-kind-list"><option value="claude"><\/option><option value="codex"><\/option><option value="opencode"><\/option><option value="qoder-cn"><\/option><\/datalist>/,
    "四条 option = 板侧常量逐字（序 = 字母序，用户裁定①）",
  );
  assert.match(
    html,
    /<\/datalist>\n<label>agentModel（后端模型）/,
    "datalist 落在 agentKind 与 agentModel 之间（agentModel 一字未改）",
  );
  assert.match(
    html,
    /下拉为<b>板侧维护的建议清单<\/b>（非闭集）：清单外的值仍可手填；后端新增适配器时需同步本清单。<\/li>/,
    "hint② 尾部追加建议清单口径（措辞中性、板侧自持，裁定②）",
  );
  assert.match(
    html,
    /<datalist id="org-host-agent-kind-list">[\s\S]*?<button type="submit">保存 agent 配置<\/button>\n<\/form>/,
    "datalist 仍在该 form 内（提交钮与 </form> 均在其后）",
  );
});

test("v0.9.8-增补 K-5（优先档）：板侧建议清单 == 规范源 PROTOCOL.md `agent-kinds` 锚点（集合比对，不比顺序）", () => {
  // 路径按 test 文件自身位置解析：board/test → board → 仓根（不依赖 process.cwd()）
  const protocolPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "PROTOCOL.md");
  const protocol = readFileSync(protocolPath, "utf8");
  const m = /^<!--\s*agent-kinds:\s*(.+?)\s*-->$/m.exec(protocol);
  assert.ok(m !== null, `${protocolPath} 未匹配到机器可解析规范源锚点 \`<!-- agent-kinds: … -->\`（锚点格式变更须同步本断言）`);
  const specKinds = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  assert.notEqual(specKinds.length, 0, `锚点捕获到空清单（原值 = ${JSON.stringify(m[1])}）`);
  assert.deepEqual(
    [...ORG_HOST_AGENT_KIND_SUGGESTIONS].sort(),
    [...specKinds].sort(),
    "板侧建议清单与规范源集合不一致（后端新增 / 更名适配器后须同步 ORG_HOST_AGENT_KIND_SUGGESTIONS）",
  );
  assert.deepEqual(
    ORG_HOST_AGENT_KIND_SUGGESTIONS,
    [...ORG_HOST_AGENT_KIND_SUGGESTIONS].sort(),
    "板侧清单序 = 字母序（用户裁定①，不得改成后端声明序）",
  );
});

test("件5-③b（管理页 · warn 档）：warnings 落页头核对短条的警示条，仍纯呈现", () => {
  const html = renderOrgSpaceManagePage({
    org: "alpha",
    features: [],
    projectsOutcome: { ok: true, projects: [] },
    groupsOutcome: {
      ok: true,
      warnings: ["组 gamma 缺成员，已忽略"],
      observedAt: null,
      groups: [{ name: "alpha", memberCount: 0, members: [] }],
    },
  });
  assert.match(html, /<b>配置瑕疵 1 条<\/b>[\s\S]*?组 gamma 缺成员，已忽略/, "缺文件 / 缺成员类 warn 落警示条");
  assert.match(html, /不参与任何判定/, "warn 口径钉死为纯呈现");
  assert.equal(html.includes("配置齐备"), false, "有 warn ⇒ 不谎报齐备");
});

// ---------------------------------------------------------------------------
// ② HTTP 面：默认带出的触发条件与降级
// ---------------------------------------------------------------------------

function fakeClient(taskCalls) {
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features: [], stateCounts: null };
    },
    async getProjects() {
      return {
        source: "fake",
        note: null,
        observedAt: "2026-10-02T00:00:00Z",
        machines: [
          {
            machineId: "m1",
            error: null,
            projects: [
              { projectId: "proj-jia", agentKind: "qoder", a2aPort: 1, status: "ok", endpoint: null, startedAt: null },
              { projectId: "proj-yi", agentKind: "qoder", a2aPort: 2, status: "ok", endpoint: null, startedAt: null },
            ],
          },
        ],
        runners: [],
      };
    },
    async getTasks(projectId, options = {}) {
      taskCalls.push(`${projectId}:${options.limit ?? "-"}`);
      return { projectId, reachable: true, notice: null, tasks: [] };
    },
  };
}

async function withServer(overrides, run) {
  const dir = mkdtempSync(join(tmpdir(), "board-piece5-"));
  const orgsRoot = join(dir, "orgs");
  mkdirSync(join(orgsRoot, "组织甲"), { recursive: true });
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: overrides.client,
    now: () => NOW,
    docs: { repoRoot: dir, orgsDir: orgsRoot },
    orgsLedgerFile: join(dir, "data", "orgs.json"),
    orgGroupsFetcher: overrides.orgGroupsFetcher,
    orgProjectsFetcher: async () => ({ ok: true, projects: [] }),
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

test("件5-②a（默认带出）：空间任务页无 project ⇒ 对过滤后首个项目做一次 limit 读取并渲结果卡", async () => {
  const calls = [];
  await withServer(
    {
      client: fakeClient(calls),
      orgGroupsFetcher: async () => ({
        ok: true,
        warnings: [],
        observedAt: null,
        groups: [{ name: "组织甲", memberCount: 1, members: [{ machineId: "m1", projectId: "proj-jia" }] }],
      }),
    },
    async (base) => {
      const pick = await (await fetch(`${base}/org/${ENC_JIA}/tasks`)).text();
      assert.deepEqual(calls, ["proj-jia:10"], "只读本组过滤后首个项目（他组 proj-yi 不触）");
      assert.match(pick, /默认带出 <span class="mono">proj-jia<\/span> 近 10 条/, "首屏不再空屏");
      assert.doesNotMatch(pick, /<details class="calib"/, "增补四：空间任务页口径折叠块已删");
      assert.doesNotMatch(pick, /<ul class="notes"/, "增补四：空间任务页不收全站口径说明");
    },
  );
});

test("件5-②b（降级）：声明面读失败 ⇒ 不带出、不外泄项目", async () => {
  const calls = [];
  await withServer(
    {
      client: fakeClient(calls),
      orgGroupsFetcher: async () => ({ ok: false, code: "groups_unreachable", error: "3300 down" }),
    },
    async (base) => {
      const pick = await (await fetch(`${base}/org/${ENC_JIA}/tasks`)).text();
      assert.deepEqual(calls, [], "清单不可判定时不猜项目、不做带出读取");
      assert.equal(pick.includes("默认带出"), false, "读失败档不渲结果卡");
      assert.match(pick, /项目清单不可判定/);
    },
  );
});
