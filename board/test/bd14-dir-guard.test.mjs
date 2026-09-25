/**
 * BD14 单测（离线 + 一条真进程钉子）：**组织目录根 / 组织目录的存在性校验 + spawn 错误归因**。
 *
 * 起因（真机取证）：`orgsDir` 指向不存在的目录时，启动期零告警、照打「宿主面就绪」，
 * 直到第一次触发一轮才以 502 + `bridge_exited` + `exit=code=-4058` 暴露
 * （`-4058` 是 libuv `ENOENT` 的负 errno 被 win32 当成退出码打印，文案里没有「目录不存在」）。
 *
 * 五组用例（四条负向 + 一条回归锚）：
 * - ① `orgsDir` 不存在 ⇒ 启动期明确 warn（**不再说就绪**）+ 触发期结构化 `board_orgs_dir_missing`；
 * - ② `orgsDir` 在、组织子目录不在 ⇒ **BD15 起由板代建**（收口轨 10）；`org_workspace_missing` 只剩
 *       「**建不出来**」三档（根不可用 / 路径被文件占 / mkdir 失败）· 各档**未 spawn**；
 * - ③ 路径是**文件**而非目录 ⇒ 同两码族，文案说「不是目录」；
 * - ④ spawn ENOENT ⇒ 码可区分（`spawn_enoent`）· 文案含 **cwd 上下文** · 负 errno 不再冒充退出码；
 * - ⑤（回归锚）既有「未配置（`orgsDir === null`）」与「非法组织名」两档行为**逐字不变**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { statDirKind } from "../dist/host-runtime.js";
import { CONFIG_PATH_ENV } from "../dist/config.js";
import { defaultPidfilePath, readPidfile } from "../dist/lifecycle.js";
import {
  HostBridgeManager,
  ORG_WORKSPACE_MISSING,
  prepareWorkspace,
} from "../dist/host-bridge.js";
import { createNodeSpawnBridge, describeSpawnFailure } from "../dist/host-process.js";
import {
  BoardHostFace,
  ORG_NAME_INVALID,
  ORGS_DIR_MISSING,
  ORGS_DIR_NOT_CONFIGURED,
  diagnoseOrgsDir,
  orgBridgeConfig,
} from "../dist/host-face.js";
import { buildHostFace } from "../dist/index.js";
import { renderHostPage } from "../dist/web/views.js";

const boardRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** 一个**真存在**的空临时目录（当「好好的组织根」用）。 */
function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 测试替身
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

/** spawn 失败的真实形状（win32 实测：**没有 exit 事件**，exitCode 被塞成 -4058）。 */
function enoentChild() {
  return {
    pid: null,
    exited: () => true,
    exitInfo: () => ({ code: -4058, signal: null }),
    spawnError: () => ({
      code: "ENOENT",
      errno: -4058,
      message: "spawn C:\\Windows\\system32\\cmd.exe ENOENT",
    }),
    kill: () => true,
    onExit: () => {},
  };
}

/** 桥起来后自己退（spawn 本身成功 ⇒ 无 error 事件）。 */
function crashChild() {
  return {
    pid: 7777,
    exited: () => true,
    exitInfo: () => ({ code: 1, signal: null }),
    kill: () => true,
    onExit: () => {},
  };
}

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    deps: {
      now: () => t,
      delay: async (ms) => {
        t += ms;
      },
    },
  };
}

/** 起桥管理器：`dirKind` / `spawnBridge` 由用例决定，其余全是「别让真进程与真盘进来」。 */
function managerWith({ dirKind, spawnBridge, probe = false }) {
  const spawned = [];
  const clock = fakeClock();
  const manager = new HostBridgeManager({
    machineDistDir: "MACHINE/DIST",
    ledger: null,
    artifactCheck: () => STUB_ARTIFACTS,
    adapters: { getAdapter: (kind) => (kind === "claude" ? fakeAdapter(kind) : undefined) },
    allocatePort: async () => 18999,
    probePort: async () => probe,
    spawnBridge: (input) => {
      spawned.push(input);
      return spawnBridge();
    },
    killTree: async () => {},
    ...clock.deps,
    ...(dirKind === undefined ? {} : { dirKind }),
  });
  return { manager, spawned };
}

function fakeTurns() {
  return {
    submitTurn() {
      throw new Error("BD14：落点不可用 ⇒ 不该走到发轮");
    },
    answerTurn() {
      throw new Error("BD14：落点不可用 ⇒ 不该走到发轮");
    },
    latestTurnOf: () => null,
    findAwaitingTurn: () => null,
        busyTurnOf: () => null,
    queueView: (org) => ({ org, running: null, waiting: [], capacity: 1 }),
    activeTurns: () => [],
  };
}

/** 记录「有没有真的去起桥」的假托管器。 */
function spyBridges() {
  const calls = [];
  return {
    calls,
    result: { ok: true, status: {} },
    async ensureStarted(config) {
      calls.push(config);
      return {
        ok: true,
        reused: false,
        status: { org: config.org, state: "running", pid: 1, port: 9, kind: config.kind, display: "在线", error: null },
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

/** 托管器返回指定失败码（模拟 BD4a 侧的 `org_workspace_missing`）。 */
function failingBridges(code) {
  return {
    async ensureStarted(config) {
      return {
        ok: false,
        reused: false,
        status: {
          org: config.org,
          state: "failed",
          pid: null,
          port: null,
          kind: config.kind,
          display: `${config.org} 宿主桥起不来：${code}`,
          error: { code, message: `模拟 ${code}` },
        },
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

// ---------------------------------------------------------------------------
// ① orgsDir 存在性校验（纯函数 + 触发期 + 状态页）
// ---------------------------------------------------------------------------

test("BD14-①a（纯函数）statDirKind 真查盘三态：目录 / 文件 / 不存在", () => {
  const dir = tmpDir("board-bd14-dir-");
  const file = join(dir, "a-file.txt");
  writeFileSync(file, "x", "utf8");
  try {
    assert.equal(statDirKind(dir), "dir");
    assert.equal(statDirKind(file), "not_dir", "存在但不是目录 ⇒ 单独一档（对策不同：要移开文件，不是 mkdir）");
    assert.equal(statDirKind(join(dir, "nope")), "missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BD14-①b（负向）diagnoseOrgsDir：不存在 ⇒ 新码 + 期望路径 + 两条对策（改配置 / 自己 mkdir）", () => {
  const out = diagnoseOrgsDir(join("Z:", "board_code_missing"), "missing");
  assert.equal(out.code, ORGS_DIR_MISSING);
  assert.notEqual(out.code, ORGS_DIR_NOT_CONFIGURED, "「配了但不存在」与「压根没配」必须是两个码");
  assert.match(out.message, /不存在/);
  assert.match(out.message, /Z:[\\/]board_code_missing/, "文案必须带**期望路径**（否则用户无从对照 config.json）");
  assert.match(out.message, /orgsDir/);
  assert.match(out.message, /mkdir/);
  assert.equal(diagnoseOrgsDir("whatever", "dir"), null, "好好的目录 ⇒ 一律不报");
});

test("BD14-①c（负向）orgsDir 不存在 ⇒ 触发一轮结构化 board_orgs_dir_missing，且一次都不起桥", async () => {
  const bridges = spyBridges();
  const h = new BoardHostFace({
    bridges,
    turns: fakeTurns(),
    orgsDir: join("Z:", "board_code_missing"),
    defaultOrg: "flow",
    dirKind: () => "missing",
  });
  const problem = h.orgsDirProblem();
  assert.equal(problem.code, ORGS_DIR_MISSING);
  const outcome = await h.triggerTurn({ featureId: "F1", org: null });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, ORGS_DIR_MISSING);
  assert.equal(outcome.disposition, "config_error", "落点问题不是「桥已断」");
  assert.match(outcome.display, /组织目录根不存在/);
  assert.deepEqual(bridges.calls, [], "根都不可用 ⇒ 不该 spawn 任何桥");
});

test("BD14-①d orgsDirProblem：未配置（null）⇒ null（不误报，未配置另有其码）· 好目录 ⇒ null", () => {
  const dir = tmpDir("board-bd14-ok-");
  try {
    const mk = (orgsDir, dirKind) =>
      new BoardHostFace({ bridges: spyBridges(), turns: fakeTurns(), orgsDir, defaultOrg: "flow", dirKind });
    assert.equal(mk(null, () => "missing").orgsDirProblem(), null);
    assert.equal(mk(dir, undefined).orgsDirProblem(), null, "不注入桩 = 真查盘：临时目录是真的 ⇒ 好好");
    assert.equal(mk(dir, () => "not_dir").orgsDirProblem().code, ORGS_DIR_MISSING);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BD14-①e（真进程钉子）orgsDir 指向不存在的目录 ⇒ 启动期出明确 warn，且不再打「宿主面就绪」", async () => {
  const dir = tmpDir("board-bd14-boot-");
  const bogus = join(dir, "no-such-orgs-root");
  const port = 18777;
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ port, host: "127.0.0.1", orgsDir: bogus, group: "flow" }), "utf8");
  const child = spawn(process.execPath, [join(boardRoot, "dist", "index.js")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, [CONFIG_PATH_ENV]: cfgPath },
  });
  let out = "";
  let errOut = "";
  child.stdout.on("data", (c) => (out += String(c)));
  child.stderr.on("data", (c) => (errOut += String(c)));
  try {
    const deadline = Date.now() + 15_000;
    let health = null;
    while (Date.now() < deadline && health === null) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        health = await res.json();
      } catch {
        if (child.exitCode !== null) throw new Error(`board 子进程提前退出（code=${child.exitCode}）：${errOut}`);
      }
    }
    assert.ok(health !== null, `目录不存在只该 warn，不该拦停板进程：${errOut}`);
    assert.ok(!out.includes("宿主面就绪"), `目录不存在时不得再打「宿主面就绪」：${out}`);
    assert.match(errOut, /警告/, "启动期必须有一条明确的 warn");
    assert.match(errOut, new RegExp(ORGS_DIR_MISSING));
    assert.ok(errOut.includes(bogus), `warn 里要有那个不存在的绝对路径：${errOut}`);
    assert.match(errOut, /宿主面已装配但\*\*未就绪\*\*/, "装配了 ≠ 就绪");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    const pidPath = defaultPidfilePath(boardRoot);
    const record = readPidfile(pidPath);
    if (record !== null && record.pid === child.pid) rmSync(pidPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ② 组织 workspace 存在性校验（ensureStarted 真正 spawn 之前）
// ---------------------------------------------------------------------------

test("BD14-②a（纯函数）prepareWorkspace：dir 放行 · missing 且根好好 ⇒ 代建 · 建不出来才出账（BD15）", () => {
  const mkdirCalls = [];
  const okMakeDir = (p) => void mkdirCalls.push(p);
  assert.equal(prepareWorkspace("W/alpha", () => "dir", okMakeDir), null, "已有目录 ⇒ 放行且不碰盘");
  assert.deepEqual(mkdirCalls, [], "dir 档一次 mkdir 都不该发生");
  // missing + 父级（组织根）好好 ⇒ 代建一级（非递归：绝不越到 orgsDir 之上）
  assert.equal(prepareWorkspace(join("Z:", "board_code", "flow"), (p) => (p === join("Z:", "board_code") ? "dir" : "missing"), okMakeDir), null);
  assert.deepEqual(mkdirCalls, [join("Z:", "board_code", "flow")]);
  // missing + 父级也不在 ⇒ 「建不出来」档：根是部署面，板刻意不代建
  const noRoot = prepareWorkspace(join("Z:", "board_code", "flow"), () => "missing", okMakeDir);
  assert.equal(noRoot.code, ORG_WORKSPACE_MISSING);
  assert.match(noRoot.message, /Z:[\\/]board_code[\\/]flow/, "文案要给出那个**绝对路径**");
  assert.match(noRoot.message, /组织目录根不可用/);
  assert.match(noRoot.message, /未 spawn 任何进程/);
  // not_dir（路径被文件占）⇒ 同码，文案说「是个文件」
  const notDir = prepareWorkspace(join("Z:", "board_code", "flow"), () => "not_dir", okMakeDir);
  assert.equal(notDir.code, ORG_WORKSPACE_MISSING);
  assert.match(notDir.message, /该路径上是个文件/);
});

test("BD15-②b（BD14 行为翻转）组织子目录缺失且根好好 ⇒ **板代建**（不再要求人工 mkdir）", async () => {
  const root = tmpDir("board-bd15-root-");
  const workspace = join(root, "flow-team");
  try {
    const { manager, spawned } = managerWith({ spawnBridge: () => enoentChild() });
    const out = await manager.ensureStarted({ org: "flow-team", workspace });
    assert.equal(existsSync(workspace), true, "✅ BD15：缺失的组织子目录由板建出来");
    assert.ok(statSync(workspace).isDirectory(), "建出来的是**目录**");
    assert.equal(out.status.error.code, "spawn_enoent", "目录已备好 ⇒ 账面上报的是后一步（起桥）的失败，不再是落点");
    assert.equal(spawned.length, 1, "代建成功后才允许走到 spawn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BD14-②b-anchor（回归锚）组织根不可用 ⇒ org_workspace_missing 语义收窄为「建不出来」· 未 spawn · 不建任何东西", async () => {
  const workspace = join("Z:", "board-bd15-no-such-root", "flow-team");
  const { manager, spawned } = managerWith({ spawnBridge: () => enoentChild() });
  const out = await manager.ensureStarted({ org: "flow-team", workspace });
  assert.equal(out.ok, false);
  assert.equal(out.status.error.code, ORG_WORKSPACE_MISSING);
  assert.ok(out.status.error.message.includes(workspace), `错误文案要含该绝对路径：${out.status.error.message}`);
  assert.deepEqual(spawned, [], "根不可用 ⇒ 一次 spawn 都不该发生");
  assert.equal(existsSync(workspace), false, "⛔ 板不擅自建根（连组织子目录也不在根缺失时顺手建）");
});

test("BD14-②c（负向）workspace 是**文件** ⇒ 同一码族（建不出来档）、文案说「是个文件」、同样不 spawn 不覆盖", async () => {
  const root = tmpDir("board-bd14-file-");
  const workspace = join(root, "flow-team");
  writeFileSync(workspace, "我不是目录", "utf8");
  try {
    const { manager, spawned } = managerWith({ spawnBridge: () => enoentChild() });
    const out = await manager.ensureStarted({ org: "flow-team", workspace });
    assert.equal(out.status.error.code, ORG_WORKSPACE_MISSING);
    assert.ok(out.status.error.message.includes(workspace), `文案要给**绝对路径**：${out.status.error.message}`);
    assert.match(out.status.error.message, /该路径上是个文件/);
    assert.deepEqual(spawned, []);
    assert.equal(readFileSync(workspace, "utf8"), "我不是目录", "板既不建也不覆盖");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BD14-②d 组织目录缺失按**落点问题**分流（config_error / 503），不再混进「宿主桥已断」", async () => {
  const dir = tmpDir("board-bd14-root-");
  try {
    const h = new BoardHostFace({
      bridges: failingBridges(ORG_WORKSPACE_MISSING),
      turns: fakeTurns(),
      orgsDir: dir,
      defaultOrg: "flow",
    });
    const outcome = await h.triggerTurn({ featureId: "F1", org: null });
    assert.equal(outcome.disposition, "config_error");
    assert.equal(outcome.error.code, ORG_WORKSPACE_MISSING);
    assert.notEqual(outcome.disposition, "bridge_down");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ③ + ④ spawn 错误归因与三码分流
// ---------------------------------------------------------------------------

test("BD14-③（负向·真进程）createNodeSpawnBridge 撞不存在的 cwd ⇒ handle 留住 ENOENT 事实", async () => {
  const spawnBridge = createNodeSpawnBridge();
  const handle = spawnBridge({
    command: "node",
    args: ["-v"],
    cwd: join("Z:", "no-such-dir-for-board-bd14"),
    env: process.env,
  });
  await new Promise((r) => setTimeout(r, 300)); // error 事件在下一个 tick 落
  const err = handle.spawnError();
  assert.ok(err !== null, "spawn 失败的事实必须留在 handle 上（过去整个错误对象被丢弃）");
  assert.equal(err.code, "ENOENT");
  assert.equal(typeof err.errno, "number");
  const exit = handle.exitInfo();
  assert.ok(exit === null || exit.code === err.errno, "win32 会把那个负 errno 同时塞进 exitCode（就是账面见过的 -4058）");
  assert.match(err.message, /ENOENT/);
});

test("BD14-④a（纯函数）describeSpawnFailure：ENOENT ⇒ spawn_enoent + cwd 上下文；无 error 事件 ⇒ null", () => {
  const hit = describeSpawnFailure({
    spawnError: { code: "ENOENT", errno: -4058, message: "spawn C:\\Windows\\system32\\cmd.exe ENOENT" },
    cwd: "G:\\board_code\\flow-team",
    command: "node",
  });
  assert.equal(hit.code, "spawn_enoent");
  assert.match(hit.message, /G:[\\/]board_code[\\/]flow-team/, "文案必须带 cwd（Node 自己的报错只提 cmd.exe，会误导）");
  assert.match(hit.message, /errno=-4058/);
  assert.match(hit.message, /落点目录不存在/);
  assert.equal(describeSpawnFailure({ spawnError: null, cwd: "W", command: "node" }), null, "spawn 成功 ⇒ 不归本函数");
});

test("BD14-④b（负向）spawn ENOENT ⇒ 码可区分（spawn_enoent）· 不再以 -4058 冒充退出码", async () => {
  const dir = tmpDir("board-bd14-ws-");
  try {
    const { manager } = managerWith({ dirKind: () => "dir", spawnBridge: enoentChild });
    const out = await manager.ensureStarted({ org: "alpha", workspace: dir });
    assert.equal(out.ok, false);
    assert.equal(out.status.state, "failed", "spawn 没起来不是「桥起来后又退了」（exited）");
    assert.equal(out.status.error.code, "spawn_enoent");
    assert.ok(out.status.error.message.includes(dir), `账面要含 cwd：${out.status.error.message}`);
    assert.doesNotMatch(out.status.error.message, /桥进程启动后即退出/, "不得再走 bridge_exited 那条文案");
    assert.notEqual(out.status.error.code, "bridge_exited");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BD14-④c（回归锚）spawn 成功但桥自己退 ⇒ 仍是 exited + bridge_exited（既有语义一字不动）", async () => {
  const dir = tmpDir("board-bd14-ws-");
  try {
    const { manager } = managerWith({ dirKind: () => "dir", spawnBridge: crashChild });
    const out = await manager.ensureStarted({ org: "alpha", workspace: dir });
    assert.equal(out.status.state, "exited");
    assert.equal(out.status.error.code, "bridge_exited");
    assert.match(out.status.error.message, /桥进程启动后即退出（exit=code=1 signal=null）/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BD14-④d 三档根因不再混同：workspace 缺失 / 命令不存在 / 桥起来即崩 ⇒ 三个不同的码", async () => {
  const dir = tmpDir("board-bd14-ws-");
  try {
    // BD15 后「组织根不可用」才是 org_workspace_missing（子目录缺失会被代建）⇒ 用不存在的根
    const missingWs = await managerWith({ spawnBridge: crashChild }).manager.ensureStarted({
      org: "alpha",
      workspace: join(dir, "no-such-root", "not-created"),
    });
    const enoent = await managerWith({ dirKind: () => "dir", spawnBridge: enoentChild }).manager.ensureStarted({
      org: "alpha",
      workspace: dir,
    });
    const crashed = await managerWith({ dirKind: () => "dir", spawnBridge: crashChild }).manager.ensureStarted({
      org: "alpha",
      workspace: dir,
    });
    const codes = [missingWs.status.error.code, enoent.status.error.code, crashed.status.error.code];
    assert.deepEqual(codes, [ORG_WORKSPACE_MISSING, "spawn_enoent", "bridge_exited"]);
    assert.equal(new Set(codes).size, 3, "三档必须三个码（过去全压进 bridge_exited）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑤ 回归锚 + 显示面
// ---------------------------------------------------------------------------

test("BD14-⑤a（回归锚）orgsDir 未配置（null）⇒ 既有码与文案逐字不变，宿主面仍不装配", () => {
  const config = orgBridgeConfig({ orgsDir: null, kind: "claude" }, "flow");
  assert.equal("error" in config, true);
  assert.equal(config.error.code, ORGS_DIR_NOT_CONFIGURED);
  assert.match(config.error.message, /组织目录根未配置（config\.json 的 orgsDir 留空\/缺键，无缺省值）/);
  assert.equal(buildHostFace({ orgsDir: null, defaultOrg: null, kind: "claude", mcpBaseUrl: "http://127.0.0.1:8787", machineDist: "MACHINE/DIST" }), null);
});

test("BD14-⑤b（回归锚）组织名非法时**先**报防逃逸那一档，与根目录是否存在无关", async () => {
  const bridges = spyBridges();
  const h = new BoardHostFace({
    bridges,
    turns: fakeTurns(),
    orgsDir: join("Z:", "board_code_missing"),
    defaultOrg: null,
    dirKind: () => "missing",
  });
  const outcome = await h.triggerTurn({ featureId: "F1", org: "../escape" });
  assert.equal(outcome.error.code, ORG_NAME_INVALID, "非法组织名 = 安全档，优先级高于存在性校验");
  assert.deepEqual(bridges.calls, []);
});

test("BD14-⑤c 状态页（GET /host）出根因条：新码 + 原话文案；没问题时不出该条", async () => {
  const problem = { code: ORGS_DIR_MISSING, message: '组织目录根不存在：Z:\\board_code" <script>' };
  const html = renderHostPage({
    entries: [],
    config: { orgsDir: "Z:/board_code", defaultOrg: "flow", kind: "claude" },
    notice: null,
    orgsDirProblem: problem,
  });
  assert.ok(html.includes(ORGS_DIR_MISSING));
  assert.ok(html.includes("组织目录根不存在"));
  assert.ok(!html.includes("<script>"), "根因文案一样要过转义");
  const clean = renderHostPage({
    entries: [],
    config: { orgsDir: "G:/board_code", defaultOrg: "flow", kind: "claude" },
    notice: null,
    orgsDirProblem: null,
  });
  assert.ok(!clean.includes("组织目录根不存在"), "目录好好时不得凭空冒出一条告警");
});
