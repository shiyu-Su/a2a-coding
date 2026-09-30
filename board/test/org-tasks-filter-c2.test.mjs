/**
 * v0.9.6 C2（§4 · 口径 6）— 组织空间任务页「交集式真过滤」。
 *
 * 目标链路：`GET /org/<名>/tasks`（无 `?project=` 的选单档）项目清单 =
 *   `getProjects()` 快照的 projectId ∩ 声明面 `GET /api/groups`（{@link OrgGroupsFetcher}）该组 `members[].projectId`。
 *
 * 钉住的语义（旧版缺陷 = 只改标题/链接、清单仍全量 ⇒ 他组项目串面）：
 *  ① 本组织声明的项目出现在清单；
 *  ② 他组织声明的项目不出现在本空间清单；
 *  ③ 归属数据源 = **声明面**（orgGroups），**不用**逐组 `a2a_projects` 运行态（orgProjects，桥抖动 ⇒ 清单抖动）；
 *  ④ 声明面读失败 ⇒ 不猜、不外泄他组（清空 + 如实标注）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const ENC_JIA = "%E7%BB%84%E7%BB%87%E7%94%B2"; // 组织甲

const feat = (featureId, ownerGroup, version, title) => ({
  featureId,
  state: "executing",
  title,
  requirement: `${title} 原文`,
  taskCount: 1,
  ownerGroup,
  stage: "改造方案",
  version,
  approval: "已通过",
  parentFeatureId: null,
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
  stateCounts: null,
});

/** 运行态快照：proj-jia / proj-yi 都在 m1 上真实存在（归属由声明面区分，不由此区分）。 */
function fakeClient() {
  const features = [feat("F-A1", "组织甲", "v1.0", "甲一"), feat("F-B1", "组织乙", "v1.0", "乙一")];
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features, stateCounts: null };
    },
    async getFeature(featureId) {
      const hit = features.find((f) => f.featureId === featureId);
      if (!hit) throw new Error(`no such feature ${featureId}`);
      return { feature: { ...hit, plan: null, decisions: null, contracts: null }, tasks: [], acceptance: null };
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
              { projectId: "proj-yi", agentKind: "qoder", a2aPort: 2, status: "ok", endpoint: null, startedAt: null },
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

/** 声明面：组织甲={proj-jia}，组织乙={proj-yi}（两项目跨组互斥）。 */
const declaredGroups = () => [
  { name: "组织甲", memberCount: 1, members: [{ machineId: "m1", projectId: "proj-jia" }] },
  { name: "组织乙", memberCount: 1, members: [{ machineId: "m1", projectId: "proj-yi" }] },
];

async function withC2Server(serverOverrides, run) {
  const dir = mkdtempSync(join(tmpdir(), "board-c2tasks-"));
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

// ---------------------------------------------------------------------------
// ① 本组织项目出现
// ---------------------------------------------------------------------------

test("C2-①（本组进面）：/org/组织甲/tasks 清单含本组织声明的 proj-jia", async () => {
  await withC2Server(
    {
      orgGroupsFetcher: async () => ({ ok: true, groups: declaredGroups(), warnings: [], observedAt: null }),
      orgProjectsFetcher: async () => ({ ok: true, projects: [] }),
    },
    async (base) => {
      const pick = await (await fetch(`${base}/org/${ENC_JIA}/tasks`)).text();
      assert.match(
        pick,
        /href="\/org\/%E7%BB%84%E7%BB%87%E7%94%B2\/tasks\?project=proj-jia"/,
        "本组织声明项目进清单（落空间路径）",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// ② 他组织项目不出现
// ---------------------------------------------------------------------------

test("C2-②（他组隔面）：/org/组织甲/tasks 清单不含组织乙声明的 proj-yi", async () => {
  await withC2Server(
    {
      orgGroupsFetcher: async () => ({ ok: true, groups: declaredGroups(), warnings: [], observedAt: null }),
      orgProjectsFetcher: async () => ({ ok: true, projects: [] }),
    },
    async (base) => {
      const pick = await (await fetch(`${base}/org/${ENC_JIA}/tasks`)).text();
      assert.doesNotMatch(pick, /proj-yi/, "他组项目不得串进本空间清单（旧版全量假过滤的缺陷消除）");
    },
  );
});

// ---------------------------------------------------------------------------
// ③ 声明面口径：用 GET /api/groups（orgGroups），不用逐组 a2a_projects（orgProjects）
// ---------------------------------------------------------------------------

test("C2-③（数据源口径）：真过滤走声明面 orgGroups、零触运行态 orgProjects", async () => {
  let groupsCalls = 0;
  let projectsCalls = 0;
  await withC2Server(
    {
      orgGroupsFetcher: async () => {
        groupsCalls += 1;
        return { ok: true, groups: declaredGroups(), warnings: [], observedAt: null };
      },
      orgProjectsFetcher: async () => {
        projectsCalls += 1;
        return { ok: true, projects: [{ machineId: "m1", projectId: "proj-yi", agentKind: "qoder" }] };
      },
    },
    async (base) => {
      const pick = await (await fetch(`${base}/org/${ENC_JIA}/tasks`)).text();
      assert.ok(groupsCalls >= 1, "归属判定必须读声明面 GET /api/groups");
      assert.equal(projectsCalls, 0, "不得用逐组 a2a_projects 运行态做归属（桥抖动 ⇒ 清单抖动）");
      // 运行态桩里 proj-yi「在组织甲可见」也不得进面 —— 归属只认声明面
      assert.doesNotMatch(pick, /proj-yi/, "运行态数据即便声称含 proj-yi 也不影响声明面过滤结果");
      assert.match(pick, /proj-jia/);
    },
  );
});

// ---------------------------------------------------------------------------
// ④ 声明面读失败 ⇒ 不猜、不外泄他组（清空 + 如实标注）
// ---------------------------------------------------------------------------

test("C2-④（读失败降级）：orgGroups ok=false ⇒ 清单清空且不外泄任何项目 + 标注不可判定", async () => {
  await withC2Server(
    {
      orgGroupsFetcher: async () => ({ ok: false, code: "groups_unreachable", error: "3300 down" }),
      orgProjectsFetcher: async () => ({ ok: true, projects: [] }),
    },
    async (base) => {
      const pick = await (await fetch(`${base}/org/${ENC_JIA}/tasks`)).text();
      assert.doesNotMatch(pick, /proj-jia/, "不可判定时不得凭运行态快照外泄项目（本组的也不列）");
      assert.doesNotMatch(pick, /proj-yi/, "不可判定时不得外泄他组项目");
      assert.match(pick, /项目清单不可判定/, "如实标注声明面读取失败（不谎报「本组织无项目」）");
    },
  );
});
