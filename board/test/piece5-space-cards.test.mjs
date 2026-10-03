/**
 * REQ-2026-09-30-04「板样式重构」件5 — 空间·任务页 + 空间·管理页卡化（原型 v2.3 样张④/⑤）。
 *
 * 钉住的语义（改版式前后的**行为边界**，防止后续把写面通路一起改掉）：
 *  ① 任务页选单档 = 过滤卡（GET 表单标记逐字不动，只外套卡）+ 快捷项目 chips + 默认带出结果卡；
 *  ② 默认带出只在**空间档 ∧ 声明面可判定**时发生（C2 读失败档不得外泄项目、也不带出）；
 *  ③ 管理页 = 成员表卡 + 加/减成员双表单卡（末位成员 409 落成卡内 `.b-note danger`）
 *     + 配置核对卡（正常态一行「配置齐备」· warn 档落警示条且仍「不参与任何判定」）；
 *  ④ **写面闭集不劣化**：manage 页 `data-ov="1"` 恰 3 枚、表单 action 与 hidden 字段逐字不变。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderTasksPick, renderTasks, renderOrgSpaceManagePage } from "../dist/web/views.js";
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

test("件5-③（管理页 · 正常态）：成员表卡 + 双表单卡 + 末位 409 警示条 + 配置核对卡", () => {
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
  assert.match(html, /<div class="b-forms">[\s\S]*?加成员[\s\S]*?删成员/, "加 / 减成员双表单卡并列");
  assert.match(html, /该组声明成员 1 项 · 观测时刻 2026-10-02T01:00:00\.000Z/, "成员表卡带计数与读取时间");
  assert.match(
    html,
    new RegExp(`<p class="b-note danger"><b>末位成员不可删</b>[\\s\\S]*?${LAST_MEMBER_REMOVE_CODE}`),
    "末位成员 409 口径落成卡内警示条",
  );
  assert.ok(html.includes(LAST_MEMBER_REMOVE_DISPLAY), "警示条文案 = 常量逐字（锚同步不重写）");
  assert.match(html, /<p class="b-note ok">配置齐备 · 上次核对时间 2026-10-02T01:00:00\.000Z<\/p>/, "两源齐备 ⇒ 正常态一行");
  assert.equal((html.match(/data-ov="1"/g) ?? []).length, 3, "写面浮层档闭集不劣化（加 / 删 / 停用恰三枚）");
  assert.match(html, /<form method="post" action="\/orgs" class="inline" data-submit="已提交，停用中…" data-ov="1" data-ov-redirect="\/">/, "停用表单标记逐字不动");
});

test("件5-③b（管理页 · warn 档）：warnings 落配置核对卡警示条，仍纯呈现", () => {
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
