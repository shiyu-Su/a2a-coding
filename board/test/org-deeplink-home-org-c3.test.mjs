/**
 * v0.9.6 C3（§4 · 口径 34）— 深链改指 + 所属组织标注。
 *
 * 目标链路：
 *  ① `GET /tasks?project=X`（C1 深链存活例外）页头加「所属组织：<org>」行 ——
 *     org = `ctx.orgGroups()`（声明面 3300 `GET /api/groups`）内 `members[].projectId === X`
 *     命中的 `GroupRow.name`；命中不到 ⇒「无归属组织」（**不臆造默认组**，即便 `defaultGroup` 已配置）；
 *     声明面不可判定（查询器未装配）⇒ 不渲该行（不猜）。
 *  ② manage 页（`GET /org/<名>/manage`，org 已知）项目表深链改指空间任务页
 *     `/org/<名>/tasks?project=…`（不再落全局 `/tasks`）。
 *  ③ 全局三处 `/tasks?project=` 深链复核保留（renderProjects / renderAgentsPage 在飞区 / 选单全局档）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const ENC_JIA = "%E7%BB%84%E7%BB%87%E7%94%B2"; // 组织甲

const feat = (featureId, ownerGroup, title) => ({
  featureId,
  state: "executing",
  title,
  requirement: `${title} 原文`,
  taskCount: 1,
  ownerGroup,
  stage: "改造方案",
  version: "v1.0",
  approval: "已通过",
  parentFeatureId: null,
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
  stateCounts: null,
});

/**
 * 运行态：proj-jia / proj-yi 挂在不同 machineId 上（钉住「命中只认 projectId，不要求 machineId 相等」）。
 * proj-lost 两项目都不属于 —— 声明面无命中（用于「无归属组织」档）。
 */
function fakeClient() {
  const features = [feat("F-A1", "组织甲", "甲一")];
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features, stateCounts: null };
    },
    async getProjects() {
      return {
        source: "fake",
        note: null,
        observedAt: "2026-09-30T00:00:00Z",
        machines: [
          {
            machineId: "m1",
            error: null,
            projects: [
              { projectId: "proj-jia", agentKind: "qoder", a2aPort: 1, status: "ok", endpoint: null, startedAt: null },
              { projectId: "proj-lost", agentKind: "qoder", a2aPort: 2, status: "ok", endpoint: null, startedAt: null },
            ],
          },
          {
            machineId: "m2",
            error: null,
            projects: [
              { projectId: "proj-yi", agentKind: "qoder", a2aPort: 3, status: "ok", endpoint: null, startedAt: null },
            ],
          },
        ],
        runners: [],
      };
    },
    async getTasks(projectId) {
      return { projectId, reachable: true, notice: null, tasks: [] };
    },
  };
}

/** 声明面：组织甲={m2/proj-jia}，组织乙={m1/proj-yi}（proj-jia 的 machine 登记与运行态不一致 ⇒ 只按 projectId 命中）。 */
const declaredGroups = () => [
  { name: "组织甲", memberCount: 1, members: [{ machineId: "m2", projectId: "proj-jia" }] },
  { name: "组织乙", memberCount: 1, members: [{ machineId: "m1", projectId: "proj-yi" }] },
];

async function withC3Server(serverOverrides, run) {
  const dir = mkdtempSync(join(tmpdir(), "board-c3link-"));
  const orgsRoot = join(dir, "orgs");
  mkdirSync(join(orgsRoot, "组织甲"), { recursive: true });
  mkdirSync(join(orgsRoot, "组织乙"), { recursive: true });
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: fakeClient(),
    now: () => NOW,
    docs: { repoRoot: dir, orgsDir: orgsRoot },
    orgsLedgerFile: join(dir, "data", "orgs.json"),
    ...serverOverrides,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

const groupsOk = {
  orgGroupsFetcher: async () => ({ ok: true, groups: declaredGroups(), warnings: [], observedAt: null }),
};

// ---------------------------------------------------------------------------
// ① 所属组织标注 —— 命中
// ---------------------------------------------------------------------------

test("C3-①（命中）：/tasks?project=proj-jia 页头渲「所属组织：组织甲」（machineId 不一致仍按 projectId 命中）", async () => {
  await withC3Server(
    { ...groupsOk, orgProjectsFetcher: async () => ({ ok: true, projects: [] }) },
    async (base) => {
      const html = await (await fetch(`${base}/tasks?project=proj-jia`)).text();
      assert.match(html, /所属组织：组织甲/, "声明面命中组名进页头");
      assert.doesNotMatch(html, /无归属组织/, "命中档不得落无归属文案");
    },
  );
});

// ---------------------------------------------------------------------------
// ② 所属组织标注 —— 无归属（不臆造默认组）
// ---------------------------------------------------------------------------

test("C3-②（无归属）：声明面无命中的项目 ⇒「无归属组织」（defaultGroup 已配置也不臆造）", async () => {
  await withC3Server(
    { ...groupsOk, orgProjectsFetcher: async () => ({ ok: true, projects: [] }), defaultGroup: "组织甲" },
    async (base) => {
      const html = await (await fetch(`${base}/tasks?project=proj-lost`)).text();
      assert.match(html, /所属组织：无归属组织/, "命中不到 ⇒ 如实标无归属");
      assert.doesNotMatch(html, /所属组织：组织甲/, "板级默认组不参与归属判定（不臆造）");
    },
  );
});

test("C3-②b（不可判定不猜）：orgGroupsFetcher 未装配 ⇒ 页头不渲「所属组织」行", async () => {
  await withC3Server(
    { orgGroupsFetcher: null, orgProjectsFetcher: async () => ({ ok: true, projects: [] }) },
    async (base) => {
      const html = await (await fetch(`${base}/tasks?project=proj-jia`)).text();
      assert.doesNotMatch(html, /所属组织/, "声明面不可判定 ⇒ 不渲该行（既不点名也不谎报无归属）");
    },
  );
});

// ---------------------------------------------------------------------------
// ③ manage 页项目表深链改指空间任务页
// ---------------------------------------------------------------------------

test("C3-③（manage 改指）：/org/组织甲/manage 项目表链接落 /org/组织甲/tasks?project=", async () => {
  await withC3Server(
    {
      ...groupsOk,
      orgProjectsFetcher: async () => ({
        ok: true,
        projects: [
          {
            machineId: "m2",
            projectId: "proj-jia",
            agentKind: "qoder",
            a2aPort: 1,
            status: "ok",
            startedAt: null,
            machineError: null,
          },
        ],
      }),
    },
    async (base) => {
      const html = await (await fetch(`${base}/org/${ENC_JIA}/manage`)).text();
      assert.match(
        html,
        /href="\/org\/%E7%BB%84%E7%BB%87%E7%94%B2\/tasks\?project=proj-jia"/,
        "manage 页内 org 已知 ⇒ 深链落空间任务页",
      );
      assert.doesNotMatch(html, /href="\/tasks\?project=/, "不再指全局 /tasks（改指后全局深链不得残留于项目表）");
    },
  );
});

// ---------------------------------------------------------------------------
// ④ 全局三处 /tasks?project= 深链复核保留（全局语义不变）
// ---------------------------------------------------------------------------

test("C3-④（全局深链保留）：/projects 项目表与 /agents 页仍指全局 /tasks?project=", async () => {
  await withC3Server(
    { ...groupsOk, orgProjectsFetcher: async () => ({ ok: true, projects: [] }) },
    async (base) => {
      const projects = await (await fetch(`${base}/projects`)).text();
      assert.match(projects, /href="\/tasks\?project=proj-jia"/, "renderProjects 深链保留（全局语义不变）");
      const agents = await (await fetch(`${base}/agents`)).text();
      assert.match(agents, /href="\/tasks\?project=proj-jia"/, "renderAgentsPage（机器表 + 在飞区）深链保留");
      const deep = await (await fetch(`${base}/tasks?project=proj-jia`)).text();
      assert.match(deep, /href="\/tasks"[^>]*>换项目/, "深链任务表页内「换项目」仍落全局选单口径");
    },
  );
});
