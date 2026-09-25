/**
 * BD11 单测（离线）：**组织名由表单/默认给出**之后，宿主面的组织目录落点与防逃逸。
 *
 * 口径（改造文档 S1 身份链 + 本节点「组织目录 = `<orgs-dir>/<该组织名>`」）：
 * - ⑤ 宿主面按**表单所填组织名**（桥侧 `ownerGroup`）解析 workspace；`ownerGroup` 缺失时按**板级默认组织**；
 * - ④（负向）组织名非法（分隔符 / `.` / `..` / 空）⇒ 复用既有 `board_org_name_invalid` 一族，
 *   **一条命令都不 spawn**（防的是「板被诱导往任意目录起后端进程」）；
 * - 组织目录根未配置 ⇒ 仍是 `board_orgs_dir_not_configured`（本节点**不动** `resolveOrgsDir`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  BoardHostFace,
  ORG_NAME_INVALID,
  ORGS_DIR_NOT_CONFIGURED,
  orgBridgeConfig,
  resolveOrgWorkspace,
} from "../dist/host-face.js";

/** 统一成 `src/xxx.ts` 风格的正斜杠相对路径比较，避免 Windows 分隔符影响断言。 */
function fwd(p) {
  return p.split(sep).join("/");
}

function fakeBridges() {
  const calls = [];
  return {
    calls,
    async ensureStarted(config) {
      calls.push(config);
      return {
        ok: true,
        reused: true,
        status: { org: config.org, state: "running", pid: 4242, port: 9101, kind: config.kind, display: "在线", error: null },
      };
    },
    async stop() {
      return null;
    },
    statuses: () => [],
    async health() {
      return null;
    },
  };
}

function fakeTurns() {
  const calls = { submitTurn: [] };
  return {
    calls,
    submitTurn(input) {
      calls.submitTurn.push(input);
      return {
        turnId: "turn-1",
        requirementId: input.requirementId,
        contextId: "ctx-1",
        round: 1,
        queued: false,
        position: 1,
        display: "已完成",
        occupant: null,
        done: Promise.resolve({
          turnId: "turn-1",
          state: "succeeded",
          display: "已完成",
          summary: "结果",
          question: null,
          error: null,
          contextId: "ctx-1",
        }),
      };
    },
    answerTurn() {
      throw new Error("本文件不测回答");
    },
    latestTurnOf: () => null,
    findAwaitingTurn: () => null,
        busyTurnOf: () => null,
    queueView: (org) => ({ org, running: null, waiting: [], capacity: 1 }),
    activeTurns: () => [],
  };
}

// ---------------------------------------------------------------------------
// ⑤ 组织目录 = `<orgs-dir>/<组织名>`（纯函数面）
// ---------------------------------------------------------------------------

test("BD11-⑤a resolveOrgWorkspace: 组织名直接落为组织根下的同名目录（表单所填组名 = 目录名 = S1）", () => {
  const root = mkdtempSync(join(tmpdir(), "board-bd11-"));
  const out = resolveOrgWorkspace(root, "flow-team");
  assert.equal(out.ok, true);
  assert.equal(fwd(out.workspace), fwd(resolve(root, "flow-team")));
  const cn = resolveOrgWorkspace(root, "中文组织名");
  assert.equal(cn.ok, true, "组织名可含非 ASCII（首次填写即创建该组织）");
});

test("BD11-⑤b orgBridgeConfig: 同一组织名同时决定 org / workspace / 宿主桥 --workspace 落点", () => {
  const root = mkdtempSync(join(tmpdir(), "board-bd11-"));
  const config = orgBridgeConfig({ orgsDir: root, kind: "claude" }, "表单组织");
  assert.equal("error" in config, false);
  assert.equal(config.org, "表单组织");
  assert.equal(fwd(config.workspace), fwd(join(root, "表单组织")));
});

test("BD11-⑤c 宿主面按桥侧 ownerGroup（= 表单组织名）起桥；ownerGroup 缺失才用板级默认组织", async () => {
  const root = mkdtempSync(join(tmpdir(), "board-bd11-"));
  const bridges = fakeBridges();
  const h = new BoardHostFace({ bridges, turns: fakeTurns(), orgsDir: root, defaultOrg: "默认组织" });

  const viaForm = await h.triggerTurn({ featureId: "F1", org: "表单组织" });
  assert.equal(viaForm.disposition, "succeeded");
  assert.equal(bridges.calls[0].org, "表单组织");
  assert.equal(fwd(bridges.calls[0].workspace), fwd(join(root, "表单组织")), "⭐ 宿主桥 --workspace 随表单组织名");

  const viaDefault = await h.triggerTurn({ featureId: "F2", org: null });
  assert.equal(viaDefault.disposition, "succeeded");
  assert.equal(fwd(bridges.calls[1].workspace), fwd(join(root, "默认组织")), "ownerGroup 缺失 ⇒ 回落板级默认组织");
});

// ---------------------------------------------------------------------------
// ④（负向）非法组织名 ⇒ 既有 board_org_name_invalid 一族（含防逃逸）
// ---------------------------------------------------------------------------

test("BD11-④a（负向）resolveOrgWorkspace 拒分隔符 / 相对段 / 盘符 / 空 / 纯空白", () => {
  const root = mkdtempSync(join(tmpdir(), "board-bd11-"));
  for (const bad of ["", "   ", ".", "..", "../evil", "a/b", "a\\b", "C:x", "sub/dir/org", "..\\..\\x"]) {
    const out = resolveOrgWorkspace(root, bad);
    assert.equal(out.ok, false, `组织名 ${JSON.stringify(bad)} 必须被拒`);
    assert.equal(out.code, ORG_NAME_INVALID, `必须是既有 ${ORG_NAME_INVALID} 一族，不是新码`);
  }
});

test("BD11-④b（负向）非法组织名 ⇒ orgBridgeConfig 结构化错误，且不产出任何 workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "board-bd11-"));
  for (const bad of ["..", "a/b"]) {
    const config = orgBridgeConfig({ orgsDir: root, kind: "claude" }, bad);
    assert.equal("error" in config, true, `${bad} 不得生成起桥配置`);
    assert.equal(config.error.code, ORG_NAME_INVALID);
    assert.equal(config.workspace, undefined);
  }
});

test("BD11-④c（负向）触发一轮携非法组织名 ⇒ 结构化错误收口，一条命令都不 spawn、不发轮", async () => {
  const root = mkdtempSync(join(tmpdir(), "board-bd11-"));
  const bridges = fakeBridges();
  const turns = fakeTurns();
  const h = new BoardHostFace({ bridges, turns, orgsDir: root, defaultOrg: "默认组织" });
  const outcome = await h.triggerTurn({ featureId: "F1", org: "../escape" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, ORG_NAME_INVALID);
  assert.equal(bridges.calls.length, 0, "防逃逸：不得在组织根之外 spawn 后端进程");
  assert.equal(turns.calls.submitTurn.length, 0);
});

test("BD11-④d 组织目录根未配置的既有口径不变（本节点不动 resolveOrgsDir）", () => {
  const config = orgBridgeConfig({ orgsDir: null, kind: "claude" }, "表单组织");
  assert.equal("error" in config, true);
  assert.equal(config.error.code, ORGS_DIR_NOT_CONFIGURED);
});
