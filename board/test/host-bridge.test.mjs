import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  HostBridgeManager,
  buildBridgeLaunchPlan,
  buildMcpServersPayload,
  defaultMcpUrlForOrg,
  decideIdleReclaim,
  formatLaunchCommand,
  hostProjectId,
  DEFAULT_IDLE_STOP_MS,
  DEFAULT_HOST_AGENT_KIND,
  HOST_BRIDGE_DOWN_MESSAGE,
  HOST_MCP_SERVER_NAME,
  HOST_PROJECT_ID_PREFIX,
} from "../dist/host-bridge.js";

import { HostBridgeLedgerStore, findHost } from "../dist/host-bridge-ledger.js";

// ---------------------------------------------------------------------------
// 测试替身 —— **本节点不起真桥**：spawn / 探活 / 树杀 / 时钟全部注入
// ---------------------------------------------------------------------------

/** 假适配器：记录板传进来的 request（真适配器的 argv 板无权也无需拼）。 */
function fakeAdapter(kind = "claude") {
  const calls = [];
  return {
    kind,
    protocol: "acp",
    calls,
    permission(risk) {
      calls.push({ fn: "permission", risk });
      return { args: ["--risk", risk, "--mode", risk === "write" ? "acceptEdits" : "plan"] };
    },
    buildLaunch(request) {
      calls.push({ fn: "buildLaunch", request });
      return {
        command: "node",
        args: [
          "MACHINE/DIST/ACP-BRIDGE/INDEX.JS",
          "--port", String(request.a2aPort),
          "--workspace", request.workspace,
          "--project-id", request.projectId,
          "--backend-cmd", "NODE.EXE",
          "--backend-args", "[\"BACKEND/ENTRY.JS\"]",
          ...(request.permissionArgs ?? []),
        ],
      };
    },
  };
}

function fakeAdaptersModule(adapter, log) {
  return {
    getAdapter(kind) {
      log.getAdapterCalls.push(kind);
      return kind === adapter.kind ? adapter : undefined;
    },
  };
}

/** 假子进程：退出时机由测试决定（`exitOnTerm` = 桥有优雅停机的形态）。 */
function fakeChild({ pid = 4242, exitOnTerm = false } = {}) {
  const state = { exited: false, code: null, signal: null, signals: [] };
  const listeners = [];
  return {
    pid,
    state,
    kill(signal = "SIGTERM") {
      state.signals.push(signal);
      if (exitOnTerm) {
        state.exited = true;
        state.signal = signal;
        for (const l of [...listeners]) l({ code: null, signal });
      }
      return true;
    },
    exited: () => state.exited,
    exitInfo: () => (state.exited ? { code: state.code, signal: state.signal } : null),
    onExit: (l) => listeners.push(l),
    die(code = 1) {
      state.exited = true;
      state.code = code;
      for (const l of [...listeners]) l({ code, signal: null });
    },
  };
}

/** 可推进的假时钟 + 不真等价的 delay ⇒ 超时时序可确定断言（不留定时器）。 */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    advance: (ms) => {
      t += ms;
    },
    deps: {
      now: () => t,
      delay: async (ms) => {
        t += ms;
      },
    },
  };
}

/** 产物检查桩：单测不碰真 dist（真查行为的断言在「dist 缺失」那两条里）。 */
const STUB_ARTIFACTS = {
  ok: true,
  distDir: "MACHINE/DIST",
  bridgeEntry: "MACHINE/DIST/acp-bridge/index.js",
  adaptersEntry: "MACHINE/DIST/adapters/index.js",
};

/** BD14 目录探针桩：单测的组织目录是假路径（如 `ORG/DIR/alpha`），不查真盘。 */
const STUB_DIR_OK = () => "dir";

function makeManager({ adapter = fakeAdapter("claude"), child = fakeChild(), probe = null, ports = null, ...rest } = {}) {
  const log = { getAdapterCalls: [], spawn: [], probePorts: [], killTree: [] };
  const clock = fakeClock();
  // `probe` = 可变闸门（测试随时翻转探活结论）；`log` = 各类动作的调用记录
  const gate = probe ?? { ok: true };
  const manager = new HostBridgeManager({
    machineDistDir: "MACHINE/DIST",
    ledger: null,
    termGraceMs: 1_000,
    startTimeoutMs: 1_000,
    artifactCheck: () => STUB_ARTIFACTS,
    dirKind: STUB_DIR_OK,
    ...clock.deps,
    adapters: fakeAdaptersModule(adapter, log),
    allocatePort: ports ?? (async () => 18901),
    spawnBridge: (input) => {
      log.spawn.push(input);
      return child;
    },
    probePort: async (port) => {
      log.probePorts.push(port);
      return gate.ok;
    },
    killTree: async (pid) => {
      log.killTree.push(pid);
      child.state.exited = true;
      child.state.signal = "SIGKILL-TREE";
      void 0;
    },
    ...rest,
  });
  return { manager, log, clock, child, adapter, gate };
}

const ORG_CFG = { org: "alpha", workspace: "ORG/DIR/alpha" };

// ---------------------------------------------------------------------------
// 1) 参数拼装：4 必填 flag + `--mcp-servers-json` 的 shape + `--risk=write`
// ---------------------------------------------------------------------------

test("buildBridgeLaunchPlan: 带齐 4 必填 flag（--port / --workspace / --project-id / --backend-cmd）", () => {
  const adapter = fakeAdapter("claude");
  const plan = buildBridgeLaunchPlan(adapter, { org: "alpha", workspace: "ORG/DIR/alpha" }, 18901, "http://127.0.0.1:8787/alpha/mcp");
  for (const flag of ["--port", "--workspace", "--project-id", "--backend-cmd"]) {
    assert.ok(plan.args.includes(flag), `缺必填 flag ${flag}`);
  }
  assert.equal(plan.args[plan.args.indexOf("--port") + 1], "18901");
  assert.equal(plan.args[plan.args.indexOf("--workspace") + 1], "ORG/DIR/alpha");
  assert.equal(plan.args[plan.args.indexOf("--project-id") + 1], "host-alpha");
  assert.equal(plan.projectId, "host-alpha");
  assert.equal(plan.port, 18901);
});

test("buildBridgeLaunchPlan: risk 恒取 write（宿主必须能写文件），且经 permission() 出口、非板自拼", () => {
  const adapter = fakeAdapter("claude");
  const plan = buildBridgeLaunchPlan(adapter, { org: "alpha", workspace: "W" }, 1, "URL");
  assert.deepEqual(adapter.calls[0], { fn: "permission", risk: "write" });
  assert.equal(plan.args.filter((a) => a === "--risk").length, 1, "--risk 只应出现一次");
  assert.equal(plan.args[plan.args.indexOf("--risk") + 1], "write");
  assert.ok(!plan.args.includes("read"));
  // permission() 的产物原样进 buildLaunch ⇒ 板不重排、不改写
  assert.deepEqual(adapter.calls[1].request.permissionArgs, ["--risk", "write", "--mode", "acceptEdits"]);
});

test("buildBridgeLaunchPlan: --mcp-servers-json 追加在尾部，且值是 ACP tagged-union", () => {
  const adapter = fakeAdapter("claude");
  const url = "http://127.0.0.1:8787/alpha/mcp";
  const plan = buildBridgeLaunchPlan(adapter, { org: "alpha", workspace: "W" }, 18901, url);
  const tail = plan.args.slice(-2);
  assert.equal(tail[0], "--mcp-servers-json");
  assert.equal(tail[1], JSON.stringify(buildMcpServersPayload(url)));
  const payload = JSON.parse(tail[1]);
  assert.deepEqual(payload, [{ type: "http", name: "a2a", url, headers: [] }]);
  assert.equal(payload[0].type, "http", "type 判别键必须在（缺它 ⇒ 运行期 session/new 才炸）");
  assert.equal(payload[0].name, HOST_MCP_SERVER_NAME);
  assert.deepEqual(payload[0].headers, []);
  assert.deepEqual(plan.mcpServers, payload);
  // adapter 给的前半段一字未动（板只在尾部追加）
  assert.deepEqual(plan.args.slice(0, -2), FAKE_HEAD_ARGS(18901));
});

function FAKE_HEAD_ARGS(port) {
  return [
    "MACHINE/DIST/ACP-BRIDGE/INDEX.JS",
    "--port", String(port),
    "--workspace", "W",
    "--project-id", "host-alpha",
    "--backend-cmd", "NODE.EXE",
    "--backend-args", "[\"BACKEND/ENTRY.JS\"]",
    "--risk", "write", "--mode", "acceptEdits",
  ];
}

test("buildMcpServersPayload: 唯一形状 = [{type:http,name:a2a,url,headers:[]}]", () => {
  assert.deepEqual(buildMcpServersPayload("http://h:1/g/mcp"), [
    { type: "http", name: "a2a", url: "http://h:1/g/mcp", headers: [] },
  ]);
});

test("defaultMcpUrlForOrg: 组名写在路径首段（与建需求同一身份链口径）", () => {
  assert.equal(defaultMcpUrlForOrg("alpha"), "http://127.0.0.1:8787/alpha/mcp");
  assert.equal(defaultMcpUrlForOrg("org A", "http://h:2/"), "http://h:2/org%20A/mcp");
  assert.throws(() => defaultMcpUrlForOrg("   "), /组身份/);
});

test("hostProjectId: 组织级 project-id = host-<组织名>", () => {
  assert.equal(hostProjectId("alpha"), `${HOST_PROJECT_ID_PREFIX}alpha`);
  assert.equal(hostProjectId("  my org  "), "host-my-org");
});

test("agentConfig 原样透传给 buildLaunch（板不解释其内容）", () => {
  const adapter = fakeAdapter("opencode");
  buildBridgeLaunchPlan(adapter, { org: "a", workspace: "W", agentConfig: { model: "m1" } }, 7, "U");
  assert.deepEqual(adapter.calls[1].request.agentConfig, { model: "m1" });
});

test("formatLaunchCommand: 给出可贴出的完整命令行形状（脱敏参数）", () => {
  const adapter = fakeAdapter("claude");
  const plan = buildBridgeLaunchPlan(adapter, { org: "alpha", workspace: "W" }, 18901, "http://127.0.0.1:8787/alpha/mcp");
  const line = formatLaunchCommand(plan);
  assert.match(line, /^node MACHINE\/DIST\/ACP-BRIDGE\/INDEX\.JS --port 18901/);
  assert.match(line, /--risk write --mode acceptEdits --mcp-servers-json \[\{"type":"http"/);
});

// ---------------------------------------------------------------------------
// 起：走注入的 spawn，参数确实落到 spawn 上
// ---------------------------------------------------------------------------

test("ensureStarted: 起一次即在线，spawn 收到的参数 = buildBridgeLaunchPlan 的产物", async () => {
  const { manager, log, adapter } = makeManager();
  const out = await manager.ensureStarted(ORG_CFG);
  assert.equal(out.ok, true);
  assert.equal(out.reused, false);
  assert.equal(out.status.state, "running");
  assert.equal(log.spawn.length, 1);
  assert.equal(log.spawn[0].command, "node");
  assert.equal(log.spawn[0].cwd, "ORG/DIR/alpha");
  assert.ok(log.spawn[0].args.includes("--mcp-servers-json"));
  assert.deepEqual(log.getAdapterCalls, ["claude"]);
  assert.equal(out.status.kind, DEFAULT_HOST_AGENT_KIND);
  assert.equal(adapter.calls[1].request.workspace, "ORG/DIR/alpha");
});

test("ensureStarted: 已在线 ⇒ 复用，不再 spawn（一组织一桥）", async () => {
  const { manager, log } = makeManager();
  await manager.ensureStarted(ORG_CFG);
  const again = await manager.ensureStarted(ORG_CFG);
  assert.equal(again.reused, true);
  assert.equal(again.status.state, "running");
  assert.equal(log.spawn.length, 1, "第二次不得再起进程");
});

test("ensureStarted: 两个组织 ⇒ 两个桥（各自 project-id）", async () => {
  let next = 18901;
  const { manager, log } = makeManager({ ports: async () => (next += 1) });
  await manager.ensureStarted({ org: "alpha", workspace: "W/alpha" });
  await manager.ensureStarted({ org: "beta", workspace: "W/beta" });
  assert.equal(log.spawn.length, 2);
  assert.deepEqual(manager.statuses().map((s) => s.projectId).sort(), ["host-alpha", "host-beta"]);
  assert.deepEqual(manager.statuses().map((s) => s.port).sort((a, b) => a - b), [18902, 18903]);
});

// ---------------------------------------------------------------------------
// 2) getAdapter() 的唯一调用点（证明板没有自拼 argv）
// ---------------------------------------------------------------------------

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

function walkTs(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walkTs(full, acc);
    else if (ent.name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

function relFromSrc(full) {
  return relative(SRC_DIR, full).split(sep).join("/");
}

test("纪律扫描：src/** 中 `.getAdapter(` 调用点唯一，且落在 host-bridge.ts", () => {
  const files = walkTs(SRC_DIR);
  assert.ok(files.length > 0);
  const hits = files.filter((f) => readFileSync(f, "utf8").includes(".getAdapter(")).map(relFromSrc);
  assert.deepEqual(hits, ["host-bridge.ts"], "kind 归一唯一事实源 = getAdapter()，调用点必须收敛在托管器内");
});

test("纪律扫描：板不复制 kind→argv 映射（后端命令与权限模式字面量不得出现在 src/**）", () => {
  // 这些字面量一旦出现 ⇒ 板在抄第二份映射表（§3.4 明令禁止：会立刻踩 Windows 两坑）
  const forbidden = [
    "claude-agent-acp",
    "codex-acp",
    "opencode.exe",
    "qoderclicn",
    "acceptEdits",
    "bypassPermissions",
    "--backend-args",
  ];
  const offenders = [];
  for (const f of walkTs(SRC_DIR)) {
    const src = readFileSync(f, "utf8");
    for (const tok of forbidden) {
      if (src.includes(tok)) offenders.push(`${relFromSrc(f)} -> ${tok}`);
    }
  }
  assert.deepEqual(offenders, [], "板是 getAdapter() 的消费方，不是实现方");
});

// ---------------------------------------------------------------------------
// 停：先 SIGTERM，超时才树杀（覆盖「桥 + 后端」两级）
// ---------------------------------------------------------------------------

test("stop: 桥在 SIGTERM 内优雅退出 ⇒ 不触发树杀", async () => {
  const child = fakeChild({ exitOnTerm: true });
  const { manager, log } = makeManager({ child });
  await manager.ensureStarted(ORG_CFG);
  const status = await manager.stop("alpha", "manual");
  assert.deepEqual(child.state.signals, ["SIGTERM"]);
  assert.deepEqual(log.killTree, [], "优雅退出路径不得树杀（否则后端来不及清理）");
  assert.equal(status.state, "exited");
  assert.equal(status.pid, null);
});

test("stop: SIGTERM 满宽限无回应 ⇒ 才树杀（板管两级进程，只杀桥会留后端孤儿）", async () => {
  const child = fakeChild({ pid: 4242, exitOnTerm: false });
  const { manager, log } = makeManager({ child });
  await manager.ensureStarted(ORG_CFG);
  await manager.stop("alpha", "manual");
  // 顺序断言：先 SIGTERM，后树杀（killTree 替身里才把进程标成已退）
  assert.deepEqual(child.state.signals, ["SIGTERM"]);
  assert.deepEqual(log.killTree, [4242]);
  assert.equal(manager.statusOf("alpha").pid, null);
});

test("stop: 未托管的组织 ⇒ null（不抛、不臆造记录）", async () => {
  const { manager } = makeManager();
  assert.equal(await manager.stop("nobody"), null);
});

test("stopAll: 收尾停掉所有在线桥（不留常驻进程）", async () => {
  const a = fakeChild({ pid: 1, exitOnTerm: true });
  const b = fakeChild({ pid: 2, exitOnTerm: true });
  let idx = 0;
  const children = [a, b];
  const clock = fakeClock();
  const manager = new HostBridgeManager({
    machineDistDir: "MACHINE/DIST",
    ledger: null,
    artifactCheck: () => STUB_ARTIFACTS,
    dirKind: STUB_DIR_OK,
    ...clock.deps,
    adapters: fakeAdaptersModule(fakeAdapter("claude"), { getAdapterCalls: [] }),
    allocatePort: async () => 19000,
    spawnBridge: () => children[idx++],
    probePort: async () => true,
  });
  await manager.ensureStarted({ org: "alpha", workspace: "W" });
  await manager.ensureStarted({ org: "beta", workspace: "W" });
  await manager.stopAll("shutdown");
  assert.deepEqual([a.state.signals, b.state.signals], [["SIGTERM"], ["SIGTERM"]]);
  assert.deepEqual(manager.statuses().map((s) => s.state), ["exited", "exited"]);
});

// ---------------------------------------------------------------------------
// 3) 空闲回收判据：在飞 > 0 ⇒ 不收
// ---------------------------------------------------------------------------

test("decideIdleReclaim: 在飞 > 0 ⇒ 不收（判据 = 板自己的在飞轮数，不是 Launcher 台账）", () => {
  assert.deepEqual(decideIdleReclaim({ idleStopMs: 1000, inFlightRounds: 3, idleMs: 999_999 }), {
    reclaim: false,
    reason: "in_flight",
  });
});

test("decideIdleReclaim: 0 = 常驻不收 · 未达阈值不收 · 达阈值收", () => {
  assert.deepEqual(decideIdleReclaim({ idleStopMs: 0, inFlightRounds: 0, idleMs: 10 ** 9 }), {
    reclaim: false,
    reason: "resident",
  });
  assert.deepEqual(decideIdleReclaim({ idleStopMs: 5000, inFlightRounds: 0, idleMs: 4999 }), {
    reclaim: false,
    reason: "below_threshold",
  });
  assert.deepEqual(decideIdleReclaim({ idleStopMs: 5000, inFlightRounds: 0, idleMs: 5000 }), {
    reclaim: true,
    reason: "idle_timeout",
  });
  assert.deepEqual(decideIdleReclaim({ idleStopMs: 5000, inFlightRounds: 0, idleMs: null }), {
    reclaim: false,
    reason: "below_threshold",
  });
});

test("回收阈值：缺省 15 分钟，且按组织可覆盖", async () => {
  assert.equal(DEFAULT_IDLE_STOP_MS, 15 * 60_000);
  const { manager } = makeManager();
  await manager.ensureStarted(ORG_CFG);
  assert.equal(manager.statusOf("alpha").idleStopMs, DEFAULT_IDLE_STOP_MS);
  await manager.ensureStarted({ org: "alpha", workspace: "ORG/DIR/alpha", idleStopMs: 0 });
  assert.equal(manager.statusOf("alpha").idleStopMs, 0, "组织级覆盖未生效");
});

test("sweepIdle: 有在飞轮次 ⇒ 不收；轮次结束且满阈值才收", async () => {
  const child = fakeChild({ exitOnTerm: true });
  const { manager, clock } = makeManager({ child });
  await manager.ensureStarted({ org: "alpha", workspace: "W", idleStopMs: 10_000 });

  manager.beginRound("alpha");
  clock.advance(60_000); // 远超阈值
  assert.deepEqual(await manager.sweepIdle(), [], "有在飞轮次时不得回收（会腰斩会话）");
  assert.equal(manager.statusOf("alpha").state, "running");
  assert.deepEqual(manager.reclaimDecision("alpha"), { reclaim: false, reason: "in_flight" });

  manager.endRound("alpha");
  assert.deepEqual(await manager.sweepIdle(), [], "endRound 把空闲计时推到当下 ⇒ 此刻不收");
  clock.advance(10_000);
  assert.deepEqual(await manager.sweepIdle(), ["alpha"]);
  assert.equal(manager.statusOf("alpha").state, "exited");
  assert.equal(child.state.signals.at(-1), "SIGTERM");
});

test("sweepIdle: 常驻组织（idleStopMs=0）永不进回收结果", async () => {
  const { manager, clock } = makeManager({ child: fakeChild({ exitOnTerm: true }) });
  await manager.ensureStarted({ org: "alpha", workspace: "W", idleStopMs: 0 });
  clock.advance(10 ** 9);
  assert.deepEqual(await manager.sweepIdle(), []);
  assert.equal(manager.statusOf("alpha").state, "running");
});

// ---------------------------------------------------------------------------
// 4) 故障可见：不可达 / 起不来 / 中途消失 ⇒ 结构化状态，不得静默
// ---------------------------------------------------------------------------

test("起不来（端口迟迟不就绪）⇒ failed + bridge_start_timeout + 显示「宿主桥已断」", async () => {
  const { manager } = makeManager({ probe: { ok: false } });
  const out = await manager.ensureStarted(ORG_CFG);
  assert.equal(out.ok, false);
  assert.equal(out.status.state, "failed");
  assert.equal(out.status.error.code, "bridge_start_timeout");
  assert.match(out.status.display, new RegExp(HOST_BRIDGE_DOWN_MESSAGE));
});

test("进程起来就退 ⇒ exited + bridge_exited（不当作在线）", async () => {
  const child = fakeChild();
  const clock = fakeClock();
  const manager = new HostBridgeManager({
    machineDistDir: "MACHINE/DIST",
    ledger: null,
    artifactCheck: () => STUB_ARTIFACTS,
    dirKind: STUB_DIR_OK,
    ...clock.deps,
    adapters: fakeAdaptersModule(fakeAdapter("claude"), { getAdapterCalls: [] }),
    allocatePort: async () => 18901,
    startTimeoutMs: 1_000,
    spawnBridge: () => {
      child.die(3);
      return child;
    },
    probePort: async () => false,
  });
  const out = await manager.ensureStarted(ORG_CFG);
  assert.equal(out.ok, false);
  assert.equal(out.status.state, "exited");
  assert.equal(out.status.error.code, "bridge_exited");
  assert.match(out.status.display, /code=3/);
});

test("health: 进程在但端口连不上 ⇒ unreachable + bridge_unreachable + 桥已断文案", async () => {
  const gate = { ok: true };
  const { manager } = makeManager({ probe: gate });
  await manager.ensureStarted({ org: "beta", workspace: "W" });
  assert.equal(manager.statusOf("beta").state, "running");
  gate.ok = false;
  const health = await manager.health("beta");
  assert.equal(health.state, "unreachable");
  assert.equal(health.error.code, "bridge_unreachable");
  assert.match(health.display, new RegExp(HOST_BRIDGE_DOWN_MESSAGE));
});

test("health: 进程中途消失 ⇒ exited + 账单带退出码（不静默留在 running）", async () => {
  const child = fakeChild();
  const { manager } = makeManager({ child });
  await manager.ensureStarted({ org: "alpha", workspace: "W" });
  child.die(7);
  const health = await manager.health("alpha");
  assert.equal(health.state, "exited");
  assert.equal(health.error.code, "bridge_exited");
  assert.match(health.error.message, /code=7/);
});

test("ensureStarted 复用前探活：端口不通 ⇒ 判桥已断、重拉并恢复在线", async () => {
  const first = fakeChild({ pid: 111, exitOnTerm: true });
  const second = fakeChild({ pid: 222 });
  const spawned = [];
  const gate = { ok: true };
  const clock = fakeClock();
  const manager = new HostBridgeManager({
    machineDistDir: "MACHINE/DIST",
    ledger: null,
    artifactCheck: () => STUB_ARTIFACTS,
    dirKind: STUB_DIR_OK,
    ...clock.deps,
    startTimeoutMs: 1_000,
    adapters: fakeAdaptersModule(fakeAdapter("claude"), { getAdapterCalls: [] }),
    allocatePort: async () => 18902,
    spawnBridge: (input) => {
      spawned.push(input);
      // 重拉后端口恢复可连（模拟「换进程就好了」）
      if (spawned.length > 1) gate.ok = true;
      return spawned.length === 1 ? first : second;
    },
    probePort: async () => gate.ok,
    killTree: async () => {
      first.state.exited = true;
    },
  });
  await manager.ensureStarted({ org: "alpha", workspace: "W" });
  assert.equal(manager.statusOf("alpha").pid, 111);
  gate.ok = false;
  const out = await manager.ensureStarted({ org: "alpha", workspace: "W" });
  assert.equal(spawned.length, 2, "探活失败后必须重拉");
  assert.equal(out.status.state, "running");
  assert.equal(out.status.pid, 222);
});

test("未知 kind ⇒ 结构化 failed（错误文案把值域甩回 getAdapter）", async () => {
  const log = { getAdapterCalls: [] };
  const clock = fakeClock();
  const manager = new HostBridgeManager({
    machineDistDir: "MACHINE/DIST",
    ledger: null,
    artifactCheck: () => STUB_ARTIFACTS,
    dirKind: STUB_DIR_OK,
    ...clock.deps,
    adapters: fakeAdaptersModule(fakeAdapter("claude"), log),
    allocatePort: async () => 1,
    spawnBridge: () => fakeChild(),
    probePort: async () => true,
  });
  const out = await manager.ensureStarted({ org: "alpha", workspace: "W", kind: "no-such-kind" });
  assert.equal(out.ok, false);
  assert.equal(out.status.state, "failed");
  assert.match(out.status.error.message, /no-such-kind/);
  assert.match(out.status.error.message, /getAdapter\(\)/);
  assert.deepEqual(log.getAdapterCalls, ["no-such-kind"]);
});

// ---------------------------------------------------------------------------
// 5) dist 缺失 ⇒ 清晰报错（不静默）
// ---------------------------------------------------------------------------

test("machine dist 缺失 ⇒ code=machine_dist_missing 且文案给出补救路径", async () => {
  const log = { getAdapterCalls: [] };
  const clock = fakeClock();
  let spawned = false;
  const manager = new HostBridgeManager({
    machineDistDir: join("Z:", "no", "such", "machine-dist"),
    ledger: null,
    dirKind: STUB_DIR_OK,
    ...clock.deps,
    adapters: fakeAdaptersModule(fakeAdapter("claude"), log),
    spawnBridge: () => {
      spawned = true;
      return fakeChild();
    },
    probePort: async () => true,
  });
  const out = await manager.ensureStarted(ORG_CFG);
  assert.equal(out.ok, false);
  assert.equal(out.status.error.code, "machine_dist_missing");
  assert.match(out.status.error.message, /npm run build/);
  assert.match(out.status.error.message, /BOARD_MACHINE_DIST/);
  assert.equal(spawned, false, "产物缺失时不应继续走 spawn");
  assert.deepEqual(log.getAdapterCalls, [], "产物缺失时不应继续加载适配器");
});

test("checkRuntime: 产物缺失即抛（供板启动期单独查；不注入桩 = 真查）", () => {
  const { manager } = makeManager({ artifactCheck: undefined });
  assert.throws(() => manager.checkRuntime(), /machine 运行时产物缺失/);
});

test("checkRuntime: 产物在位时返回两个入口的绝对路径", () => {
  const { manager } = makeManager();
  assert.deepEqual(manager.checkRuntime(), STUB_ARTIFACTS);
});

test("参数前置校验：空组织名 / 空 workspace ⇒ 直接抛（编程错误先于进程动作）", async () => {
  const { manager } = makeManager();
  await assert.rejects(() => manager.ensureStarted({ org: "  ", workspace: "W" }), /组织名缺失/);
  await assert.rejects(() => manager.ensureStarted({ org: "alpha", workspace: "  " }), /workspace/);
});

// ---------------------------------------------------------------------------
// 6) 依赖解析：machine dist 路径可配置（+ 缺省由仓根推导）
// ---------------------------------------------------------------------------

test("distDir(): 显式配置优先（machine/dist 是运行时产物，路径必须可配）", () => {
  const { manager } = makeManager({ machineDistDir: "D:/elsewhere/machine/dist" });
  assert.equal(manager.distDir(), "D:/elsewhere/machine/dist");
});

test("distDir(): 未配置 ⇒ 落到 <仓根>/machine/dist（不是 <仓根>/../machine/dist）", () => {
  const { manager } = makeManager({ machineDistDir: undefined });
  // 本测试文件位于 <仓根>/board/test ⇒ 上两级即仓根
  const testDir = dirname(fileURLToPath(import.meta.url));
  assert.equal(manager.distDir(), join(dirname(dirname(testDir)), "machine", "dist"));
});

// ---------------------------------------------------------------------------
// 7) 板侧私有台账（**不用引擎 features 表**）：起停记账 + 句柄不被生命周期写抹掉
// ---------------------------------------------------------------------------

test("台账记账：起桥即落 pid / port / workspace / kind，回收即落 stoppedAt / stopReason", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "board-mgr-ledger-")), ".data", "host-bridges.json");
  const store = new HostBridgeLedgerStore(file);
  const { manager } = makeManager({ ledger: store });
  await manager.ensureStarted(ORG_CFG);
  let rec = findHost(store.load().ledger, "alpha");
  assert.equal(rec.pid, 4242);
  assert.equal(rec.port, 18901);
  assert.equal(rec.workspace, "ORG/DIR/alpha");
  assert.equal(rec.kind, "claude");
  assert.equal(rec.stoppedAt, null);
  assert.ok(rec.startedAt !== null);
  await manager.stop("alpha", "manual");
  rec = findHost(store.load().ledger, "alpha");
  assert.equal(rec.stoppedAt !== null, true);
  assert.equal(rec.stopReason, "manual");
  assert.equal(rec.pid, null, "回收后 pid 清空，避免重启后误认旧进程还在");
});

test("台账记账：CLI 会话句柄与文档路径只落板侧私有文件（后续生命周期写不抹、也不进 Feature）", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "board-mgr-ledger2-")), ".data", "host-bridges.json");
  const store = new HostBridgeLedgerStore(file);
  const { manager } = makeManager({ ledger: store });
  await manager.ensureStarted(ORG_CFG);
  store.update({ org: "alpha", cliSessionId: "sess-77", docPath: "doc/v0.9.0/x-改造文档.md" });
  await manager.stop("alpha", "idle");
  const rec = findHost(store.load().ledger, "alpha");
  assert.deepEqual(rec.cliSessionIds, ["sess-77"], "回收写生命周期字段时句柄须原样留着");
  assert.deepEqual(rec.docPaths, ["doc/v0.9.0/x-改造文档.md"]);
});

test("台账写失败 ⇒ 降级可见（挂 error=ledger_write_failed），但不把在跑的桥伪装成起不来", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-mgr-ledger3-"));
  // 把台账路径做成一个**目录** ⇒ update() 的写入必失败
  const store = new HostBridgeLedgerStore(dir);
  const { manager, child } = makeManager({ ledger: store });
  const out = await manager.ensureStarted(ORG_CFG);
  assert.equal(out.ok, true, "进程真的起来了 ⇒ 状态不得因记账失败而退化");
  assert.equal(out.status.state, "running");
  assert.equal(out.status.error.code, "ledger_write_failed");
  assert.equal(child.pid, 4242);
});
