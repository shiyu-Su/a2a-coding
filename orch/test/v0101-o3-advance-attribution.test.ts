/**
 * v0.10.1 **O3**（REQ-2026-10-09-01 · 改造文档 §2 C-17 / §3 orch 段 / §4「MCP `advance` 归属独立分支」）
 * —— **MCP `a2a_feature_advance` 的归属独立分支接线**。
 *
 * 锁定的行为面（节点验收判据逐条）：
 * ① `to` = 当前态 ∧ `projectVersions` **非空** ⇒ 归属落库、**`state` 逐字不变**、主链零事件；
 *    同值全量重发 ⇒ `noop`（重发安全，C-3 ★R3）；
 * ② `to` = 当前态 ∧ `projectVersions` **空数组 / 缺省** ⇒ **不触发**归属分支 ⇒ 落回 `canTransition`
 *    被拒（`executing → executing` 无路径 ⇒ **转移表零改动**的正面证据）；
 * ③ 与**合法流转同单** ⇒ 归属与主链迁移**同一次调用**内双双生效；
 * ④ **归属被拒 ⇒ 主链零迁移**（★N-8 fail-fast：不隐式建版 / 未过门 / 异值改写三档，
 *    均 `state` 不变 + 归属零落库；released 门的判据本身归 O2 用例，本节点只接同一出口）；
 * ⑤ MCP 工具面**不增**（Feature 工具组仍 6 个；`projectVersions` 只是既有工具的一个可选入参键），
 *    且该键**逐字透传**到 `core.featureAdvance`（`repoId` / `ref` 到归属层不落库）。
 *
 * 另钉两条边界：`hasRegistration` **未被扩**（带登记字段的特例语义不变：只写登记 + 同单归属互不污染）、
 * 归属写**不动** `features` 任何列（登记字段与主链态均逐字不变）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ERR_PROJECT_VERSION_UNKNOWN,
  featureProjectListByFeature,
  getFeature,
  projectVersionCreate,
  versionLedgerCreate,
} from "../session/store.js";
import {
  ERR_ATTRIBUTION_STATE_LOCKED,
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCreate,
  type FeatureAdvanceSuccess,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";
import { createServer } from "../bridge/register-tools.js";
import type { BridgeCore } from "../bridge/index.js";

const GROUP = "g-o3";

function mustOk<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) {
    const f = outcome as unknown as { code?: string; error?: string; message?: string };
    throw new Error(`期望成功，实际失败：${f.code} ${f.error ?? f.message}`);
  }
  return outcome as Extract<T, { ok: true }>;
}

function mustFail(outcome: { ok: boolean } | FeatureToolFailure): FeatureToolFailure {
  if (outcome.ok) throw new Error("期望失败，实际成功");
  return outcome as FeatureToolFailure;
}

/** 组台账灌版号（`handleFeatureCreate` 带 `version` 需版号已登记） */
function seedGroupVersion(version: string): void {
  mustOk(versionLedgerCreate({ ownerGroup: GROUP, version }));
}

/** project 台账灌版本行（建版走显式写口 ⇒ 缺省 `open`） */
function seedProjectVersion(projectId: string, version: string): void {
  mustOk(projectVersionCreate({ ownerGroup: GROUP, projectId, version }));
}

let seq = 0;
function nextTitle(tag: string): string {
  seq += 1;
  return `o3-${tag}-${seq}`;
}

/** 一张已过门（`executing` + `已通过`）的卡 */
function approvedFeature(version: string, tag = "main"): string {
  const created = mustOk(handleFeatureCreate({ title: nextTitle(tag), version }, GROUP));
  mustOk(handleFeatureApprove({ featureId: created.featureId }, GROUP));
  return created.featureId;
}

/** 一张未过门的卡（`waiting_approval` + `未发起`） */
function unapprovedFeature(version: string, tag = "pending"): string {
  const created = mustOk(
    handleFeatureCreate({ title: nextTitle(tag), version, stage: "需求分析", approval: "未发起" }, GROUP),
  );
  return created.featureId;
}

// ---------------------------------------------------------------------------
// ① `to` = 当前态 ∧ projectVersions 非空 ⇒ 归属落库、state 不变
// ---------------------------------------------------------------------------

test("① to=当前态 + projectVersions 非空 ⇒ 归属落库且 state 逐字不变（不触发 canTransition）", () => {
  const version = "0.10.1-r1";
  seedGroupVersion(version);
  seedProjectVersion("orch", "0.10.1");
  seedProjectVersion("board", "0.3.0");
  const featureId = approvedFeature(version);

  const outcome = mustOk(
    handleFeatureAdvance(
      {
        featureId,
        to: "executing",
        projectVersions: [
          { projectId: "orch", version: "0.10.1" },
          { projectId: "board", version: "0.3.0", repoId: "repo-1", ref: "abc123" },
        ],
      },
      GROUP,
    ),
  );
  assert.equal(outcome.state, "executing", "归属分支不动主链");
  assert.equal(outcome.from, "executing");
  assert.deepEqual(outcome.attribution, { created: 2, updated: 0, noop: 0 });

  const rows = featureProjectListByFeature(featureId);
  assert.equal(rows.length, 2, "两条归属落库");
  const orchRow = rows.find((r) => r.projectId === "orch");
  assert.ok(orchRow, "orch 行在");
  assert.equal(orchRow.projectVersion, "0.10.1", "入参 version ⇒ 落库 projectVersion");
  assert.equal(orchRow.groupVersion, version, "groupVersion 由 features.version 派生（不在入参里）");
  const boardRow = rows.find((r) => r.projectId === "board");
  assert.ok(boardRow);
  assert.equal(boardRow.groupVersion, version);

  // 归属写**不动 features 任何列**（观测面与主链均逐字不变）
  const feature = getFeature(featureId);
  assert.equal(feature?.state, "executing");
  assert.equal(feature?.approval, "已通过");
  assert.equal(feature?.version, version);
});

test("①b 同值全量重发 ⇒ 全部 noop（重发安全，不制造活动痕迹）", () => {
  const version = "0.10.1-r2";
  seedGroupVersion(version);
  seedProjectVersion("machine", "0.9.8");
  const featureId = approvedFeature(version);
  const args = {
    featureId,
    to: "executing" as const,
    projectVersions: [{ projectId: "machine", version: "0.9.8" }],
  };
  const first = mustOk(handleFeatureAdvance(args, GROUP));
  assert.deepEqual(first.attribution, { created: 1, updated: 0, noop: 0 });
  const second = mustOk(handleFeatureAdvance(args, GROUP));
  assert.deepEqual(second.attribution, { created: 0, updated: 0, noop: 1 });
  assert.equal(second.state, "executing");
  assert.equal(featureProjectListByFeature(featureId).length, 1, "重发不增行");
});

// ---------------------------------------------------------------------------
// ② projectVersions 空 / 缺省 ⇒ 不触发归属分支（转移表零改动的正面证据）
// ---------------------------------------------------------------------------

test("② to=当前态 + projectVersions 缺省 ⇒ 落回 canTransition 被拒（executing→executing 无路径）", () => {
  const version = "0.10.1-r3";
  seedGroupVersion(version);
  const featureId = approvedFeature(version);
  const failure = mustFail(handleFeatureAdvance({ featureId, to: "executing" }, GROUP));
  assert.equal(failure.code, "feature_transition_invalid");
  assert.equal(getFeature(featureId)?.state, "executing");
  assert.equal(featureProjectListByFeature(featureId).length, 0, "缺省 = 完全不触发归属面");
});

test("②b to=当前态 + projectVersions 空数组 ⇒ 同样不触发（空数组 ≠ 清空归属）", () => {
  const version = "0.10.1-r4";
  seedGroupVersion(version);
  seedProjectVersion("flow", "0.10.0");
  const featureId = approvedFeature(version);
  mustOk(
    handleFeatureAdvance(
      { featureId, to: "executing", projectVersions: [{ projectId: "flow", version: "0.10.0" }] },
      GROUP,
    ),
  );
  assert.equal(featureProjectListByFeature(featureId).length, 1);

  const failure = mustFail(
    handleFeatureAdvance({ featureId, to: "executing", projectVersions: [] }, GROUP),
  );
  assert.equal(failure.code, "feature_transition_invalid", "空数组走的是既有主链路径");
  assert.equal(featureProjectListByFeature(featureId).length, 1, "空数组不清空既有归属");
});

// ---------------------------------------------------------------------------
// ③ 与合法流转同单 ⇒ 归属 + 主链迁移同一次调用生效
// ---------------------------------------------------------------------------

test("③ 归属与合法流转同单 ⇒ 同一次调用内双双生效", () => {
  const version = "0.10.1-r5";
  seedGroupVersion(version);
  seedProjectVersion("orch", "0.5.0");
  const featureId = approvedFeature(version);
  mustOk(handleFeatureAdvance({ featureId, to: "integrating" }, GROUP));

  const outcome = mustOk(
    handleFeatureAdvance(
      { featureId, to: "testing", projectVersions: [{ projectId: "orch", version: "0.5.0" }] },
      GROUP,
    ),
  );
  assert.equal(outcome.state, "testing", "主链迁移照旧生效");
  assert.deepEqual(outcome.attribution, { created: 1, updated: 0, noop: 0 });
  assert.equal(getFeature(featureId)?.state, "testing");
  assert.equal(featureProjectListByFeature(featureId)[0]?.projectVersion, "0.5.0");
});

test("③b 登记字段 + 归属同单（to=当前态）⇒ 两笔都落、互不污染（hasRegistration 判据未扩）", () => {
  const version = "0.10.1-r6";
  seedGroupVersion(version);
  seedProjectVersion("board", "0.6.0");
  const featureId = approvedFeature(version);
  const outcome = mustOk(
    handleFeatureAdvance(
      {
        featureId,
        to: "executing",
        stage: "改造方案",
        projectVersions: [{ projectId: "board", version: "0.6.0" }],
      },
      GROUP,
    ),
  );
  assert.equal(outcome.state, "executing");
  assert.deepEqual(outcome.attribution, { created: 1, updated: 0, noop: 0 });
  assert.equal(getFeature(featureId)?.stage, "改造方案");
});

// ---------------------------------------------------------------------------
// ④ ★N-8：归属被拒 ⇒ 主链零迁移（任何写入之前拒绝）
// ---------------------------------------------------------------------------

test("④a 不隐式建版拒（orch_project_version_unknown）⇒ 主链零迁移 + 归属零落库", () => {
  const version = "0.10.1-r7";
  seedGroupVersion(version);
  const featureId = approvedFeature(version);
  mustOk(handleFeatureAdvance({ featureId, to: "integrating" }, GROUP));

  const failure = mustFail(
    handleFeatureAdvance(
      { featureId, to: "testing", projectVersions: [{ projectId: "nosuch", version: "9.9.9" }] },
      GROUP,
    ),
  );
  assert.equal(failure.code, ERR_PROJECT_VERSION_UNKNOWN);
  assert.equal(getFeature(featureId)?.state, "integrating", "★N-8：主链一格未动");
  assert.equal(featureProjectListByFeature(featureId).length, 0, "拒在写入之前");
});

test("④b 未过门拒（orch_project_attribution_state_locked）⇒ 主链零迁移", () => {
  const version = "0.10.1-r8";
  seedGroupVersion(version);
  seedProjectVersion("orch", "0.7.0");
  const featureId = unapprovedFeature(version);
  const failure = mustFail(
    handleFeatureAdvance(
      { featureId, to: "waiting_approval", projectVersions: [{ projectId: "orch", version: "0.7.0" }] },
      GROUP,
    ),
  );
  assert.equal(failure.code, ERR_ATTRIBUTION_STATE_LOCKED);
  assert.equal(getFeature(featureId)?.state, "waiting_approval");
  assert.equal(featureProjectListByFeature(featureId).length, 0);
});

test("④c 异值改写拒（承诺集可改须先删后建）⇒ 主链零迁移 + 原归属不动", () => {
  const version = "0.10.1-r10";
  seedGroupVersion(version);
  seedProjectVersion("orch", "1.0.0");
  seedProjectVersion("orch", "1.1.0");
  const featureId = approvedFeature(version);
  mustOk(
    handleFeatureAdvance(
      { featureId, to: "executing", projectVersions: [{ projectId: "orch", version: "1.0.0" }] },
      GROUP,
    ),
  );
  const failure = mustFail(
    handleFeatureAdvance(
      { featureId, to: "integrating", projectVersions: [{ projectId: "orch", version: "1.1.0" }] },
      GROUP,
    ),
  );
  assert.equal(failure.code, "orch_project_attribution_conflict");
  assert.equal(getFeature(featureId)?.state, "executing", "★N-8：带合法 to 也一样先拒");
  assert.equal(featureProjectListByFeature(featureId)[0]?.projectVersion, "1.0.0");
});

// ---------------------------------------------------------------------------
// ⑤ MCP 工具面不增 + 入参透传
// ---------------------------------------------------------------------------

test("⑤ MCP 工具清单不增（Feature 组仍 6 个）；advance inputSchema 含 projectVersions 键", async () => {
  const core = new Proxy(
    {},
    {
      get: (_t, prop) => () => {
        throw new Error(`本用例只查工具面，不得触碰：${String(prop)}`);
      },
    },
  ) as unknown as BridgeCore;

  const server: McpServer = createServer(core);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "v0101-o3-test", version: "1.0.0" }, {});
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = (await client.listTools()).tools;
  const names = tools.map((t) => t.name);
  const featureTools = names.filter((n) => n.startsWith("a2a_feature_")).sort();
  assert.deepEqual(featureTools, [
    "a2a_feature_advance",
    "a2a_feature_approve",
    "a2a_feature_cancel",
    "a2a_feature_create",
    "a2a_feature_status",
    "a2a_feature_trace",
  ]);
  assert.equal(names.length, 14, "泛型 7 + Feature 6 + 配置面 1（归属写不开新工具）");

  const advance = tools.find((t) => t.name === "a2a_feature_advance");
  assert.ok(advance);
  const props = (advance.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  assert.ok(props && "projectVersions" in props, "advance 入参新增可选键 projectVersions");
  // approve **不加参**（宿主在过门同轮发 advance + projectVersions）
  const approve = tools.find((t) => t.name === "a2a_feature_approve");
  const approveProps = (approve?.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  assert.deepEqual(Object.keys(approveProps ?? {}), ["featureId"], "approve 入参面零改动");
});

test("⑤b callTool 直通：projectVersions 逐字透传给 core.featureAdvance（repoId / ref 到归属层不落库）", async () => {
  type AdvanceArgs = Parameters<BridgeCore["featureAdvance"]>[0];
  const calls: AdvanceArgs[] = [];
  const core = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "featureAdvance") {
          return (a: AdvanceArgs) => {
            calls.push(a);
            return {
              ok: true,
              featureId: a.featureId,
              from: "executing",
              state: "executing",
              attribution: { created: 1, updated: 0, noop: 0 },
            } satisfies FeatureAdvanceSuccess;
          };
        }
        if (prop === "kickScheduler") return () => undefined;
        return () => {
          throw new Error(`不得触碰其它 BridgeCore 方法：${String(prop)}`);
        };
      },
    },
  ) as unknown as BridgeCore;

  const server: McpServer = createServer(core);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "v0101-o3-call", version: "1.0.0" }, {});
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const res = await client.callTool({
    name: "a2a_feature_advance",
    arguments: {
      featureId: "F-o3",
      to: "executing",
      projectVersions: [{ projectId: "orch", version: "0.10.1", repoId: "r1", ref: "deadbee" }],
    },
  });
  assert.notEqual(res.isError, true, "成功路径出 textResult");
  assert.equal(calls.length, 1);
  const item = calls[0]?.projectVersions?.[0];
  assert.equal(item?.projectId, "orch");
  assert.equal(item?.version, "0.10.1");
  assert.equal(calls[0]?.to, "executing", "既有键不受影响");

  // 未声明的未知键仍被 strip（SDK 默认语义，防升级改 strict 时静默改变入参面）
  const stripped = await client.callTool({
    name: "a2a_feature_advance",
    arguments: {
      featureId: "F-o3",
      to: "executing",
      projectVersions: [{ projectId: "orch", version: "0.10.1", notAKey: 1 }],
    },
  });
  assert.notEqual(stripped.isError, true);
  assert.equal(calls[1]?.projectVersions?.[0]?.projectId, "orch");
  assert.equal(
    Object.prototype.hasOwnProperty.call(calls[1]?.projectVersions?.[0] ?? {}, "notAKey"),
    false,
    "未知键被丢弃（不透传、不报错）",
  );

  // 空数组 = 零写 no-op 通道路径：**不触发**归属分支（与 ② 同判据，走主链被拒 ⇒ 但那是 core 的事，
  // 本用例只证明 MCP 层把空数组原样交出、不静默转成 undefined）
  await client.callTool({
    name: "a2a_feature_advance",
    arguments: { featureId: "F-o3", to: "executing", projectVersions: [] },
  });
  assert.deepEqual(calls[2]?.projectVersions, []);
});
