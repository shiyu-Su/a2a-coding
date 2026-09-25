/**
 * BD15 单测（收口轨 10 · v0.9.0）：**组织子目录改由板自动创建**。
 *
 * 起因（现状拧着）：BD14 把两层目录都要求预先存在 ⇒ 用户在板上第一次用某组织名时
 * 先撞 `org_workspace_missing`、得回终端 `mkdir`。BD15 分职：
 * - `orgsDir` 根 = **部署面**，必须预先存在（配错即报错 —— 收口轨 9 的行为与文案不变）；
 * - `<orgsDir>/<组织名>` = **数据**，缺失时由板创建（`org_workspace_missing` 语义收窄为「建不出来」）。
 *
 * 五组用例：
 * - ① 组织子目录缺失 ⇒ **被创建**（先断不存在、调一次、断已存在且是目录）；
 * - ②（**回归锚**）根缺失 ⇒ 仍硬报错 `board_orgs_dir_missing`、**且不创建任何东西**；
 * - ③（负向）创建失败（mkdir 报错 / 路径被文件占）⇒ `org_workspace_missing` + 文案含**绝对路径** + 根因；
 * - ④（负向）组织名非法（防逃逸那一档）**先于任何创建动作**；
 * - ⑤ 已有目录**不被破坏**（幂等）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostBridgeManager, ORG_WORKSPACE_MISSING, prepareWorkspace } from "../dist/host-bridge.js";
import { BoardHostFace, ORG_NAME_INVALID, ORGS_DIR_MISSING } from "../dist/host-face.js";

// ---------------------------------------------------------------------------
// 测试替身（与 BD14 同规格：进程与产物全桩掉，只让**目录供给**这一段是真的）
// ---------------------------------------------------------------------------

const STUB_ARTIFACTS = {
  ok: true,
  distDir: "MACHINE/DIST",
  bridgeEntry: "MACHINE/DIST/acp-bridge/index.js",
  adaptersEntry: "MACHINE/DIST/adapters/index.js",
};

function fakeAdapter(kind = "claude") {
  return {
    kind,
    protocol: "acp",
    permission: (risk) => ({ args: ["--risk", risk] }),
    buildLaunch: (request) => ({
      command: "node",
      args: ["--port", String(request.a2aPort), "--workspace", request.workspace],
    }),
  };
}

function crashChild() {
  return {
    pid: 7777,
    exited: () => true,
    exitInfo: () => ({ code: 1, signal: null }),
    kill: () => true,
    onExit: () => {},
  };
}

/**
 * 「目录供给为真、其余全假」的托管器：dirKind **不注入**（真查盘 ⇒ 建没建看得见）、
 * ledger 纯内存（不污染仓内 .data）、spawn 桩只记录不真起。
 */
function realDirManager() {
  const spawned = [];
  let t = 1_700_000_000_000;
  const manager = new HostBridgeManager({
    machineDistDir: "MACHINE/DIST",
    ledger: null,
    artifactCheck: () => STUB_ARTIFACTS,
    adapters: { getAdapter: (kind) => (kind === "claude" ? fakeAdapter(kind) : undefined) },
    allocatePort: async () => 18999,
    probePort: async () => false,
    spawnBridge: (input) => {
      spawned.push(input);
      return crashChild();
    },
    killTree: async () => {},
    now: () => t,
    delay: async (ms) => {
      t += ms;
    },
  });
  return { manager, spawned };
}

function fakeTurns() {
  return {
    submitTurn() {
      throw new Error("BD15：本轨只验目录供给，不该走到发轮");
    },
    answerTurn() {
      throw new Error("BD15：本轨只验目录供给，不该走到发轮");
    },
    latestTurnOf: () => null,
    findAwaitingTurn: () => null,
        busyTurnOf: () => null,
    queueView: (org) => ({ org, running: null, waiting: [], capacity: 1 }),
    activeTurns: () => [],
  };
}

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// ① 组织子目录缺失 ⇒ 被创建
// ---------------------------------------------------------------------------

test("BD15-①（正向）<orgsDir>/<组织名> 缺失 ⇒ 触发一轮后被板创建（先断不存在 → 调一次 → 断是目录）", async () => {
  const root = tmpRoot("board-bd15-①-");
  const workspace = join(root, "首用组织");
  try {
    assert.equal(existsSync(workspace), false, "前置：组织目录不存在");
    const { manager, spawned } = realDirManager();
    const h = new BoardHostFace({ bridges: manager, turns: fakeTurns(), orgsDir: root, defaultOrg: "首用组织" });
    const outcome = await h.triggerTurn({ featureId: "F-BD15", org: null });
    assert.equal(existsSync(workspace), true, "✅ BD15：用户第一次在板上用某组织名 ⇒ 目录由板建出来，不必回终端 mkdir");
    assert.ok(statSync(workspace).isDirectory(), "建出来的是**目录**");
    assert.equal(spawned.length, 1, "落点备好 ⇒ 才允许走到 spawn（本桩随后崩，属下游，不在本轨辖区）");
    assert.notEqual(outcome.error?.code, ORG_WORKSPACE_MISSING, "落点这一档必须让位给真实根因");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ② 回归锚：根缺失 ⇒ 仍硬报错、且不创建任何东西（收口轨 9 行为不变）
// ---------------------------------------------------------------------------

test("BD15-②（回归锚）orgsDir 根不存在 ⇒ 仍报 board_orgs_dir_missing、文案不变、**一个目录都不建**", async () => {
  const parent = tmpRoot("board-bd15-②-");
  const bogusRoot = join(parent, "no-such-orgs-root");
  try {
    const { manager, spawned } = realDirManager();
    const h = new BoardHostFace({ bridges: manager, turns: fakeTurns(), orgsDir: bogusRoot, defaultOrg: "flow" });
    const outcome = await h.triggerTurn({ featureId: "F-BD15", org: null });
    assert.equal(outcome.error.code, ORGS_DIR_MISSING, "根坏了报**根**的码（BD14 收口轨 9 口径），不是 org_workspace_missing");
    assert.match(outcome.error.message, /组织目录根不存在/, "文案与收口轨 9 一致");
    assert.match(outcome.error.message, /板不会代建/, "根 = 部署面，板刻意不代建");
    assert.equal(existsSync(bogusRoot), false, "⛔ 板不擅自建根");
    assert.deepEqual(readdirSync(parent), [], "连根之下的任何目录都不该出现（零创建）");
    assert.deepEqual(spawned, [], "一次 spawn 都不该发生");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ③ 负向：创建失败 ⇒ org_workspace_missing + 绝对路径 + 根因
// ---------------------------------------------------------------------------

test("BD15-③a（负向·纯函数）mkdir 抛错（权限不足）⇒ org_workspace_missing · 文案含绝对路径 + 根因", () => {
  const eacces = Object.assign(new Error("EACCES: permission denied, mkdir 'X'"), { code: "EACCES" });
  const out = prepareWorkspace(
    join("Z:", "orgs", "flow"),
    (p) => (p === join("Z:", "orgs") ? "dir" : "missing"),
    () => {
      throw eacces;
    },
  );
  assert.equal(out.code, ORG_WORKSPACE_MISSING);
  assert.ok(out.message.includes(join("Z:", "orgs", "flow")), `文案要给**绝对路径**：${out.message}`);
  assert.match(out.message, /mkdir 失败/);
  assert.match(out.message, /EACCES/, "根因要原样带出（否则用户只能猜）");
  assert.match(out.message, /未 spawn 任何进程/);
});

test("BD15-③b（负向·真盘）探得缺失但建不出来（mkdir 实抛 EEXIST）⇒ 同码 · 绝对路径 · 根因", async () => {
  const root = tmpRoot("board-bd15-③-");
  const workspace = join(root, "ghost");
  mkdirSync(workspace); // 真存在，但探针故意说「missing」⇒ 板去建会撞 EEXIST（模拟探测与落盘不一致）
  try {
    const manager = new HostBridgeManager({
      machineDistDir: "MACHINE/DIST",
      ledger: null,
      artifactCheck: () => STUB_ARTIFACTS,
      adapters: { getAdapter: (kind) => (kind === "claude" ? fakeAdapter(kind) : undefined) },
      allocatePort: async () => 18999,
      probePort: async () => false,
      spawnBridge: () => crashChild(),
      killTree: async () => {},
      now: () => 1_700_000_000_000,
      delay: async () => {},
      dirKind: (p) => (p === workspace ? "missing" : "dir"),
    });
    const out = await manager.ensureStarted({ org: "ghost", workspace });
    assert.equal(out.ok, false);
    assert.equal(out.status.error.code, ORG_WORKSPACE_MISSING);
    assert.ok(out.status.error.message.includes(workspace), `文案含绝对路径：${out.status.error.message}`);
    assert.match(out.status.error.message, /EEXIST/, "根因（mkdir 实错）要进账");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ④ 负向：组织名非法（防逃逸那一档）先于任何创建动作
// ---------------------------------------------------------------------------

test("BD15-④（负向）非法组织名 ⇒ ORG_NAME_INVALID 先于任何创建（好好存在的根之下零新建）", async () => {
  const root = tmpRoot("board-bd15-④-");
  try {
    const { manager, spawned } = realDirManager();
    const h = new BoardHostFace({ bridges: manager, turns: fakeTurns(), orgsDir: root, defaultOrg: null });
    const outcome = await h.triggerTurn({ featureId: "F-BD15", org: "../escape" });
    assert.equal(outcome.error.code, ORG_NAME_INVALID, "防逃逸档位优先级最高，先于目录供给");
    assert.deepEqual(readdirSync(root), [], "非法名 ⇒ 板的创建动作一次都没发生");
    assert.equal(existsSync(join(root, "..", "escape")), false, "更不得逃逸到根之外");
    assert.deepEqual(spawned, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑤ 幂等：已有目录不被破坏
// ---------------------------------------------------------------------------

test("BD15-⑤（幂等）组织目录已存在且有内容 ⇒ 触发一轮不碰它（文件原样、子目录原样）", async () => {
  const root = tmpRoot("board-bd15-⑤-");
  const workspace = join(root, "老组织");
  const keep = join(workspace, "doc", "v0.9.0", "改造文档.md");
  mkdirSync(join(workspace, "doc", "v0.9.0"), { recursive: true });
  writeFileSync(keep, "一字都不能动", "utf8");
  try {
    const { manager, spawned } = realDirManager();
    const h = new BoardHostFace({ bridges: manager, turns: fakeTurns(), orgsDir: root, defaultOrg: "老组织" });
    const outcome = await h.triggerTurn({ featureId: "F-BD15", org: null });
    assert.notEqual(outcome.error?.code, ORG_WORKSPACE_MISSING, "已有目录 ⇒ 落点这一档不该出账");
    assert.equal(readFileSync(keep, "utf8"), "一字都不能动", "⛔ 幂等：板对已存在目录零写入、零清空");
    assert.deepEqual(readdirSync(workspace), ["doc"], "目录内容不得被增删");
    assert.equal(spawned.length, 1, "老目录照常放行（幂等 ≠ 拒绝）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
