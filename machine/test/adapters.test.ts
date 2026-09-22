/**
 * v0.8.5（REQ-v0.8.5-2026-09-21-01 · M2 codex / M3 claude）：**wrapper 族两家断言由 wrapper 翻向 ACP**
 * （`protocol:"acp"` / 拉桥进程 / `--risk`+`--mode` 三档 / 平铺 model / 段与配置通道（M4）退役；
 * M3 另含 claude full 档 `--session-meta-json`）。播报面归 M6、**全量全绿归 M7**。
 * 锁 ACP 族（opencode / qoder-cn / codex / claude）的 `buildLaunch` 命令与参数形状、
 * `permission` 三档映射**逐字**断言；并锁协议维度与 backendCmd 的**三态解析**（v0.8.6 起）。
 * `getAdapter` 四家可达、恰 4 个不同实例。
 *
 * v0.8.6（REQ-v0.8.6-2026-09-21-02 · N2）：**`backendCmd` 由「四 kind 必填」翻向「可选覆盖 + 逐层自动解析」**
 * ⇒ 原「缺 `backendCmd` ⇒ 抛」类断言一律翻成**三态**（见本文件「入口解析三态锚」段）：
 * 命中 ⇒ 不抛（脚本入口 = `process.execPath` / 可执行体 = 真身直调）· 未命中 ⇒ 抛且文案含**分层摘要** ·
 * `backendCmd: ""` ⇒ **回落解析**而非抛。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AGENT_KINDS } from "../agent-kinds.js";
import { getAdapter } from "../adapters/index.js";

import { appRootFromModule } from "../launcher/app-root.js";
import { resolveBackendSpawn, SCRIPT_BACKEND_EXTS } from "../adapters/backend-command.js";
import { BACKEND_LOOKUP_BY_KIND } from "../adapters/backend-entry.js";
import { SESSION_TIMEOUT_MS_CAP } from "../launcher/agent-config.js";

import type { AgentKind } from "../types.js";
import type { LaunchRequest, LaunchSpec } from "../adapters/types.js";

// ---------- REQ-v0.8.6-2026-09-21-02 · N2：adapter 层「入口解析三态」的沙箱 ----------
// adapter 的 `buildLaunch` 不接 `deps` 形参（纯 fs 注入面在 `test/backend-entry.test.ts`）⇒
// 本文件的注入面 = **进程环境**（解析器缺省读 `process.env` + 真实 fs）：
//   `NPM_CONFIG_PREFIX`（L2 首候选）· `APPDATA`（win32 L2 次候选）· `PATH`（L3）·
//   `HOME` / `USERPROFILE`（qoder `knownPaths` 的 `~` 展开）。
// ⚠ 残留（改造文档 §5.2-2 / §5.2-4）：L1 = `machine/node_modules`、posix 的两个系统级 npm root
// **不可由环境覆盖** ⇒ 「逐层均未命中」在本机（win32 + machine 零后端依赖）确定性成立。

/** 沙箱根（进程级唯一，退出时删除）。 */
const SANDBOX = mkdtempSync(join(tmpdir(), "a2a-adapters-entry-"));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

/** 空的封层目录（PATH / APPDATA / home 都指向它 ⇒ 除被测层外全部必然 miss）。 */
const SANDBOX_EMPTY = join(SANDBOX, "empty");
mkdirSync(SANDBOX_EMPTY, { recursive: true });

/** 落一个 L0 显式夹具（沙箱内真实空文件），返回其绝对路径。
 *  v0.8.6 真机补正：L0 显式 `backendCmd` **必须存在且是文件**（`rejected-missing` 不回落下层）
 *  ⇒ 显式值一律用沙箱真文件，不再用假路径 / 裸命令名（裸名 = 删键走 L3 才是 PATH 的正确表达）。 */
function writeExplicitFixture(rel: string): string {
  const abs = join(SANDBOX, "explicit", rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "", "utf8");
  return abs;
}

/** 在沙箱内落真实文件并保持字符串形态为 POSIX 斜杠（与原假夹具 `C:/…` 书写习惯一致）。 */
function posixFixture(rel: string): string {
  return writeExplicitFixture(rel).split("\\").join("/");
}

/** npm 包根的落点：win32 = 前缀目录本身、posix = `前缀/node_modules`（与解析器 `defaultNpmRoots` 同口径）。 */
function npmRootFor(prefix: string): string {
  return process.platform === "win32" ? prefix : join(prefix, "node_modules");
}

/** 在覆盖后的环境下执行 `fn`，结束（含抛错）一律恢复原值。 */
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) saved.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 落一个 npm 包素材（`bin` 单条目 + 真身文件），返回 bin 的绝对路径。 */
function writeNpmPackage(root: string, pkg: string, binKey: string, binRel: string): string {
  const pkgDir = join(root, ...pkg.split("/"));
  const binAbs = resolve(pkgDir, binRel);
  mkdirSync(dirname(binAbs), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: pkg, bin: { [binKey]: binRel } }),
    "utf8",
  );
  writeFileSync(binAbs, "", "utf8");
  return binAbs;
}

/** 落一个 qoder 真身素材（按平台取 `BACKEND_LOOKUP_BY_KIND` 的 knownPaths 项），返回其绝对路径。 */
function writeKnownPackage(home: string): string {
  const spec = BACKEND_LOOKUP_BY_KIND["qoder-cn"];
  const known = (spec.knownPaths ?? []).find((k) =>
    k.platform === "win32" ? process.platform === "win32" : process.platform !== "win32",
  );
  assert.ok(known, "qoder-cn 表须登记本平台 knownPath");
  const abs = join(home, ...known.path.slice(2).split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "", "utf8");
  return abs;
}

/** 封空的沙箱环境：只留 `prefix` 这一条 L2 根，其余层（L3 / known / win 全局根）一律指向空目录。 */
function sealedEnv(prefix: string): Record<string, string> {
  return {
    NPM_CONFIG_PREFIX: prefix,
    APPDATA: SANDBOX_EMPTY,
    PATH: SANDBOX_EMPTY,
    HOME: SANDBOX_EMPTY,
    USERPROFILE: SANDBOX_EMPTY,
  };
}

/** 取 `--backend-cmd` / `--backend-args` 的实际值（args[0] 是桥入口绝对路径，运行环境相关）。 */
function backendPair(spec: LaunchSpec): { cmd: string; args: string[] } {
  const i = spec.args.indexOf("--backend-cmd");
  const j = spec.args.indexOf("--backend-args");
  return {
    cmd: spec.args[i + 1] ?? "",
    args: JSON.parse((spec.args[j + 1] ?? "[]") as string) as string[],
  };
}

/** 三态锚共用的最小请求（无 `agentConfig`）。 */
const BARE_REQUEST: LaunchRequest = { projectId: "p1", workspace: "/ws/p1", a2aPort: 4100 };

/** 某 kind 在「逐层均未命中」的沙箱里 `buildLaunch` 的抛错文案。 */
function missMessage(kind: AgentKind): string {
  const env = sealedEnv(join(SANDBOX, "miss-prefix"));
  try {
    withEnv(env, () => getAdapter(kind).buildLaunch(BARE_REQUEST));
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`${kind}：沙箱内应当解析失败而未失败`);
}

/** codex ACP 后端命令样例 = **适配器入口脚本路径**（v0.8.5 · M8 形态归一：`.js` ⇒ 适配器自动以 node 拉起；
 *  v0.8.6 真机补正：L0 存在性门 ⇒ 沙箱真实文件）。 */
const CODEX_BACKEND_CMD_SAMPLE = posixFixture("codex-acp-entry.js");

/** claude 显式夹具 = 本机 node 真身（可执行体形态 ⇒ `--backend-cmd` 原样透传 + `--backend-args '[]'`）。 */
const CLAUDE_NODE_CMD = process.execPath;

/** qoder-cn 显式夹具（可执行体真身名，无扩展名 ⇒ 直调 + 桥缺省 `["--acp"]`）。 */
const QODER_EXPLICIT = posixFixture("qoderclicn");

/** opencode 显式夹具（`.exe` 可执行体 ⇒ 直调 + `["acp"]`）。 */
const OPENCODE_EXE = posixFixture("opencode.exe");

/** codex 未配 model 时的桥侧参数基线（args[0]=桥入口绝对路径，运行环境相关，单列剔除）。 */
const CODEX_NO_MODEL_BASELINE = [
  "--port",
  "4100",
  "--workspace",
  "/ws/p1",
  "--project-id",
  "p1",
  "--backend-cmd",
  process.execPath,
  "--backend-args",
  JSON.stringify([CODEX_BACKEND_CMD_SAMPLE]),
];

function codexBridgeArgs(agentConfig: Record<string, unknown> | undefined): string[] {
  return getAdapter("codex")
    .buildLaunch({ projectId: "p1", workspace: "/ws/p1", a2aPort: 4100, agentConfig })
    .args.slice(1);
}

test("getAdapter：AGENT_KINDS 每个成员可达、kind 对应、恰 4 个不同实例", () => {
  assert.equal(AGENT_KINDS.length, 4);
  const adapters = AGENT_KINDS.map((kind) => getAdapter(kind));
  assert.deepEqual(
    adapters.map((a) => a.kind),
    [...AGENT_KINDS],
  );
  assert.equal(new Set(adapters).size, AGENT_KINDS.length);
});

test('协议维度：opencode/qoder-cn/claude = "acp"（v0.8.5 M3 claude 迁桥）', () => {
  for (const kind of ["opencode", "qoder-cn", "claude"] as const) {
    assert.equal(getAdapter(kind).protocol, "acp");
  }
});

test('协议维度：codex = "acp"（v0.8.5 M2 codex 迁桥）', () => {
  assert.equal(getAdapter("codex").protocol, "acp");
});

test("codex buildLaunch（ACP 族）逐字锁定：拉起仓内桥进程 + --backend-args 形态归一（脚本入口 ⇒ node + 脚本路径）", () => {
  const spec = getAdapter("codex").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: CODEX_BACKEND_CMD_SAMPLE },
    permissionArgs: getAdapter("codex").permission("read").args,
  });
  assert.equal(spec.command, "node");
  // 桥入口为绝对路径（appRoot 取决运行环境），只断言尾部稳定段
  assert.ok((spec.args[0] ?? "").endsWith(join("dist", "acp-bridge", "index.js")));
  assert.deepEqual(spec.args.slice(1), [
    ...CODEX_NO_MODEL_BASELINE,
    "--risk",
    "read",
    "--mode",
    "read-only",
    "--collaboration-mode",
    "plan",
  ]);
});

test("claude buildLaunch（ACP 族）：拉起仓内桥进程 + 可执行体形态 --backend-args '[]' + 平铺 model 透传", () => {
  const spec = getAdapter("claude").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: CLAUDE_NODE_CMD, model: "sonnet", sessionTimeoutMs: 720000 },
  });
  assert.equal(spec.command, "node");
  assert.ok((spec.args[0] ?? "").endsWith(join("dist", "acp-bridge", "index.js")));
  assert.deepEqual(spec.args.slice(1), [
    "--port",
    "4100",
    "--workspace",
    "/ws/p1",
    "--project-id",
    "p1",
    "--backend-cmd",
    CLAUDE_NODE_CMD,
    "--backend-args",
    "[]",
    "--model",
    "sonnet",
    // v0.8.7 M2：--session-timeout 紧随 --model 下发；未配 sessionTimeoutMs ⇒ 无该旗标。
    "--session-timeout",
    "720000",
  ]);
});

test("codex buildLaunch：configPath 退役 ⇒ 不产出 --config / --config-file / --config-segment", () => {
  const spec = getAdapter("codex").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: CODEX_BACKEND_CMD_SAMPLE },
  });
  assert.ok(!spec.args.includes("--config"));
  assert.ok(!spec.args.includes("--config-file"));
  assert.ok(!spec.args.includes("--config-segment"));
});

test("claude buildLaunch（ACP 族）：configPath 退役 ⇒ 不产出 --config / --config-file", () => {
  const spec = getAdapter("claude").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: CLAUDE_NODE_CMD },
  });
  assert.ok(!spec.args.includes("--config"));
  assert.ok(!spec.args.includes("--config-file"));
  assert.ok(!spec.args.includes("--config-segment"));
});

// ◄ v0.8.6 反转（REQ-v0.8.6-2026-09-21-02）：原「claude 无 agentConfig ⇒ 抛 /backendCmd/」（必填语义）
// ⇒ 三态：命中不抛（脚本入口 ⇒ node）/ 未命中抛且文案含分层摘要 / 空串回落解析。
test("claude buildLaunch：无 agentConfig · L2 命中 ⇒ 不抛，--backend-cmd = node + 脚本入口；全 miss ⇒ 抛且含分层摘要", () => {
  const prefix = join(SANDBOX, "claude-prefix");
  const binAbs = writeNpmPackage(
    npmRootFor(prefix),
    "@agentclientprotocol/claude-agent-acp",
    "claude-agent-acp",
    "dist/index.js",
  );
  const spec = withEnv(sealedEnv(prefix), () => getAdapter("claude").buildLaunch(BARE_REQUEST));
  const pair = backendPair(spec);
  assert.equal(pair.cmd, process.execPath, "脚本入口 ⇒ 以 node 拉起");
  assert.deepEqual(pair.args, [binAbs]);

  const msg = missMessage("claude");
  assert.match(msg, /backendCmd/);
  assert.match(msg, /L0[\s\S]*L1[\s\S]*L2[\s\S]*L3/, "文案含分层摘要");
  assert.ok(
    msg.length <= 300,
    `分层清单不进 message（self-check singleLine 截 300）：实际 ${msg.length}`,
  );
});

test("claude buildLaunch：backendCmd 空串 ⇒ 回落解析而非抛（与读取器宽容口径一致）", () => {
  const prefix = join(SANDBOX, "claude-prefix");
  writeNpmPackage(
    npmRootFor(prefix),
    "@agentclientprotocol/claude-agent-acp",
    "claude-agent-acp",
    "dist/index.js",
  );
  const spec = withEnv(sealedEnv(prefix), () =>
    getAdapter("claude").buildLaunch({ ...BARE_REQUEST, agentConfig: { backendCmd: "" } }),
  );
  assert.equal(backendPair(spec).cmd, process.execPath);
});

// REQ-v0.8.6-2026-09-21-02 真机补正①：L0 显式值必须存在且是文件；不满足 ⇒ 项目级失败收口，
// **不得静默回落**下层（即使下层备好可命中素材）。裸命令名同样被拒（走 PATH 的正确表达 = 删键）。
test("L0 显式路径不存在 ⇒ rejected-missing：抛专项文案（含原样路径），下层备好可命中素材也不回落", () => {
  const prefix = join(SANDBOX, "l0-reject-prefix");
  writeNpmPackage(
    npmRootFor(prefix),
    "@agentclientprotocol/claude-agent-acp",
    "claude-agent-acp",
    "dist/index.js",
  );
  const fake = join(SANDBOX, "explicit", "not-exists-entry.js");
  let msg = "";
  withEnv(sealedEnv(prefix), () => {
    assert.throws(
      () => getAdapter("claude").buildLaunch({ ...BARE_REQUEST, agentConfig: { backendCmd: fake } }),
      /显式 agentConfig\.backendCmd 指向的 ACP 后端入口不存在/,
    );
    try {
      getAdapter("claude").buildLaunch({ ...BARE_REQUEST, agentConfig: { backendCmd: fake } });
    } catch (err) {
      msg = (err as Error).message;
    }
  });
  assert.ok(msg.includes(fake.replace(/\\/g, "/")) || msg.includes(fake), `文案须含原样配置值：${msg}`);
  assert.match(msg, /删除 backendCmd 键/, "文案须引导删键走自动解析");
  assert.ok(msg.length <= 300, `分层清单不进 message：实际 ${msg.length}`);
});

test("claude buildLaunch：未配平铺 model ⇒ argv 无 --model（零回退）", () => {
  const spec = getAdapter("claude").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: CLAUDE_NODE_CMD },
  });
  assert.ok(!spec.args.includes("--model"));
  assert.ok(!spec.args.includes("--session-timeout"), "v0.8.7 M2：未配 sessionTimeoutMs ⇒ 零下发");
});

test("codex permission 三档映射逐字锁定（v0.8.5 M2：--risk + --mode [+ plan]）", () => {
  assert.deepEqual(getAdapter("codex").permission("read"), {
    args: ["--risk", "read", "--mode", "read-only", "--collaboration-mode", "plan"],
  });
  assert.deepEqual(getAdapter("codex").permission("write"), {
    args: ["--risk", "write", "--mode", "agent"],
  });
  assert.deepEqual(getAdapter("codex").permission("full"), {
    args: ["--risk", "full", "--mode", "agent-full-access"],
  });
});

test("claude permission 三档逐字：--risk <档> + --mode <modeId>（三档同名对齐）", () => {
  assert.deepEqual(getAdapter("claude").permission("read"), {
    args: ["--risk", "read", "--mode", "plan"],
  });
  assert.deepEqual(getAdapter("claude").permission("write"), {
    args: ["--risk", "write", "--mode", "acceptEdits"],
  });
  // full 档：`--risk full` + `--mode bypassPermissions` + `--session-meta-json`（_meta 承载）
  const full = getAdapter("claude").permission("full");
  assert.deepEqual(full.args.slice(0, 4), ["--risk", "full", "--mode", "bypassPermissions"]);
  assert.equal(full.args[4], "--session-meta-json");
  assert.equal(full.args.length, 6, "full 档恰多一枚 --session-meta-json <值>");
  // 值必须是**可解析的合法 JSON**（桥侧 parseSessionMetaArg 会 fail-fast 校验）
  assert.deepEqual(JSON.parse(full.args[5] ?? ""), {
    claudeCode: { options: { allowDangerouslySkipPermissions: true } },
  });
  // read / write 档**不含** `_meta` 承载
  assert.ok(!getAdapter("claude").permission("read").args.includes("--session-meta-json"));
  assert.ok(!getAdapter("claude").permission("write").args.includes("--session-meta-json"));
});

test("qoder-cn buildLaunch（ACP 族）：拉起仓内桥进程（node + dist/acp-bridge/index.js）", () => {
  const spec = getAdapter("qoder-cn").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: QODER_EXPLICIT },
  });
  assert.equal(spec.command, "node");
  // 桥入口为绝对路径（appRoot 取决运行环境），只断言尾部稳定段
  assert.ok((spec.args[0] ?? "").endsWith(join("dist", "acp-bridge", "index.js")));
  assert.deepEqual(spec.args.slice(1), [
    "--port",
    "4100",
    "--workspace",
    "/ws/p1",
    "--project-id",
    "p1",
    "--backend-cmd",
    QODER_EXPLICIT,
    // ◄ v0.8.6 反转（REQ-v0.8.6-2026-09-21-02）：接形态归一后 `--backend-args` **显式下发**
    // （值 = 原桥缺省 ["--acp"] ⇒ 后端命令行逐字不变）。
    "--backend-args",
    '["--acp"]',
  ]);
});

test("qoder-cn buildLaunch：permissionArgs（--risk <档>）追加在基础参数之后", () => {
  const spec = getAdapter("qoder-cn").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: QODER_EXPLICIT },
    permissionArgs: getAdapter("qoder-cn").permission("read").args,
  });
  assert.deepEqual(spec.args.slice(-2), ["--risk", "read"]);
});

test("qoder-cn permission 三档映射：read/write/full → --risk <档>", () => {
  assert.deepEqual(getAdapter("qoder-cn").permission("read"), { args: ["--risk", "read"] });
  assert.deepEqual(getAdapter("qoder-cn").permission("write"), { args: ["--risk", "write"] });
  assert.deepEqual(getAdapter("qoder-cn").permission("full"), { args: ["--risk", "full"] });
});

test("qoder-cn buildLaunch：agentConfig.backendCmd 原样透传（绝对路径）", () => {
  const spec = getAdapter("qoder-cn").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: QODER_EXPLICIT },
  });
  assert.equal(spec.args[spec.args.indexOf("--backend-cmd") + 1], QODER_EXPLICIT);
});

// ---- REQ-v0.8.2-2026-09-20-01 · M1（协议面增补）：model 走桥 `--model` ⇒ ACP set_config_option ----
// ---- REQ-v0.8.4-2026-09-20-01 · M3 翻向：读点 = 顶层平铺 agentConfig.model，段内 model = 遗留键 ----

/** ACP 族未配 model 时的桥侧参数基线（args[0]=桥入口绝对路径，运行环境相关，单列剔除）。 */
const QODER_CN_NO_MODEL_BASELINE = [
  "--port",
  "4100",
  "--workspace",
  "/ws/p1",
  "--project-id",
  "p1",
  "--backend-cmd",
  QODER_EXPLICIT,
  // ◄ v0.8.6 反转（REQ-v0.8.6-2026-09-21-02）：qoder 也接形态归一 ⇒ `--backend-args` 显式下发。
  "--backend-args",
  '["--acp"]',
];

function qoderCnBridgeArgs(agentConfig: Record<string, unknown> | undefined): string[] {
  const spec = getAdapter("qoder-cn").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig,
  });
  return spec.args.slice(1);
}

test("qoder-cn 平铺 model 已配 ⇒ 下发 --model，值逐字 = 配置值（不再拼后端 argv）", () => {
  assert.deepEqual(
    qoderCnBridgeArgs({
      backendCmd: QODER_EXPLICIT,
      model: "provider/model-x",
      sessionTimeoutMs: 720000,
    }),
    [
      ...QODER_CN_NO_MODEL_BASELINE,
      "--model",
      "provider/model-x",
      // v0.8.7 M2：平铺 sessionTimeoutMs ⇒ `--session-timeout <ms>`，紧随 --model。
      "--session-timeout",
      "720000",
    ],
  );
});

test("qoder-cn 平铺 model 已配 + permissionArgs：--model 在 --backend-cmd 后、--risk 前", () => {
  const spec = getAdapter("qoder-cn").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: QODER_EXPLICIT, model: "m1", sessionTimeoutMs: 30000 },
    permissionArgs: getAdapter("qoder-cn").permission("read").args,
  });
  assert.deepEqual(spec.args.slice(1), [
    ...QODER_CN_NO_MODEL_BASELINE,
    "--model",
    "m1",
    "--session-timeout",
    "30000",
    "--risk",
    "read",
  ]);
});

// ◄ v0.8.6 反转（REQ-v0.8.6-2026-09-21-02）：原锚同时负向锁「不下发 --backend-args」（qoder 由桥缺省兜底）
// ⇒ 现由 adapter 显式下发（值不变）；本用例保留「未配 model ⇒ 无 --model、argv 逐字 = 基线」的主轴。
test("qoder-cn model 未配 ⇒ 不下发 --model（argv 逐字 = 基线，桥不发 set）", () => {
  const args = qoderCnBridgeArgs({ backendCmd: QODER_EXPLICIT });
  assert.deepEqual(args, QODER_CN_NO_MODEL_BASELINE);
  assert.ok(!args.includes("--model"));
  assert.ok(!args.includes("--session-timeout"), "未配 sessionTimeoutMs ⇒ argv 逐字含负向锚");
  assert.equal(
    args[args.indexOf("--backend-args") + 1],
    '["--acp"]',
    "kind 级参数由 adapter 显式下发",
  );
});

test("qoder-cn 平铺 model 非法值（缺键 / 空串 / 非字符串）⇒ 与未配置同路径逐字一致", () => {
  const invalidCases: Record<string, Record<string, unknown>> = {
    缺键: { backendCmd: QODER_EXPLICIT },
    空串: { backendCmd: QODER_EXPLICIT, model: "" },
    数字: { backendCmd: QODER_EXPLICIT, model: 42 },
    null: { backendCmd: QODER_EXPLICIT, model: null },
  };
  for (const [name, agentConfig] of Object.entries(invalidCases)) {
    assert.deepEqual(
      qoderCnBridgeArgs(agentConfig),
      QODER_CN_NO_MODEL_BASELINE,
      `非法值「${name}」应走未配置路径`,
    );
  }
});

test("qoder-cn 遗留段内 model（v0.8.4 翻向）⇒ 不生效：argv 逐字 = 未配置基线", () => {
  assert.deepEqual(
    qoderCnBridgeArgs({ backendCmd: QODER_EXPLICIT, "qoder-cn": { model: "provider/model-x" } }),
    QODER_CN_NO_MODEL_BASELINE,
  );
});

test("qoder-cn 旧 -m argv 拼装已撤除（model 唯一通道 = 协议面 set）", () => {
  const args = qoderCnBridgeArgs({ backendCmd: QODER_EXPLICIT, model: "provider/model-x" });
  assert.ok(!args.includes("-m"), "不得再出现后端 -m 旗标");
  assert.ok(!args.some((a) => a.includes('"-m"')), "不得再出现 --backend-args 内的 -m 拼装");
});

/** opencode 未配 model 时的桥侧参数基线（`acp` 子命令恒定）。 */
const OPENCODE_NO_MODEL_BASELINE = [
  "--port",
  "4100",
  "--workspace",
  "/ws/p1",
  "--project-id",
  "p1",
  "--backend-cmd",
  OPENCODE_EXE,
  "--backend-args",
  '["acp"]',
];

function opencodeBridgeArgs(agentConfig: Record<string, unknown>): string[] {
  return getAdapter("opencode")
    .buildLaunch({ projectId: "p1", workspace: "/ws/p1", a2aPort: 4100, agentConfig })
    .args.slice(1);
}

test("opencode 平铺 model 已配 ⇒ 下发 --model（协议面通路对两家同方言启用）", () => {
  assert.deepEqual(opencodeBridgeArgs({ backendCmd: OPENCODE_EXE, model: "provider/model-x" }), [
    ...OPENCODE_NO_MODEL_BASELINE,
    "--model",
    "provider/model-x",
  ]);
});

test("opencode 平铺 model 已配 + permissionArgs：--model 在 --backend-args 后、--risk 前", () => {
  const spec = getAdapter("opencode").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: OPENCODE_EXE, model: "m1" },
    permissionArgs: getAdapter("opencode").permission("read").args,
  });
  assert.deepEqual(spec.args.slice(1), [
    ...OPENCODE_NO_MODEL_BASELINE,
    "--model",
    "m1",
    "--risk",
    "read",
  ]);
});

test("opencode 遗留段内 model（v0.8.4 翻向）⇒ 不生效：argv 逐字 = 未配置基线", () => {
  assert.deepEqual(
    opencodeBridgeArgs({ backendCmd: OPENCODE_EXE, opencode: { model: "provider/model-x" } }),
    OPENCODE_NO_MODEL_BASELINE,
  );
});

test('opencode 平铺 model 未配 / 非法 ⇒ argv 逐字 = 基线（后端 argv 恒 ["acp"]，不含 --model）', () => {
  const cases: Record<string, Record<string, unknown>> = {
    未配: { backendCmd: OPENCODE_EXE },
    空串: { backendCmd: OPENCODE_EXE, model: "" },
    数字: { backendCmd: OPENCODE_EXE, model: 7 },
    非字符串: { backendCmd: OPENCODE_EXE, model: null },
  };
  for (const [name, agentConfig] of Object.entries(cases)) {
    assert.deepEqual(
      opencodeBridgeArgs(agentConfig),
      OPENCODE_NO_MODEL_BASELINE,
      `「${name}」应走未配置路径`,
    );
  }
});

// ---------- REQ-v0.8.4-2026-09-20-01 · M3：遗留键告警锚（段内 model ⇒ ACP 族告警 / wrapper 族不告警）----------

test("遗留键不生效（谓词口径，与 manager.start 告警同源）：ACP 族 adapter 不消费段内 model", () => {
  assert.ok(
    !qoderCnBridgeArgs({ backendCmd: QODER_EXPLICIT, "qoder-cn": { model: "legacy-m" } }).includes(
      "--model",
    ),
  );
  assert.ok(
    !opencodeBridgeArgs({ backendCmd: OPENCODE_EXE, opencode: { model: "legacy-m" } }).includes(
      "--model",
    ),
  );
  // 平铺 + 段内并存 ⇒ 只透传平铺值（段内不掺入、不双读）
  assert.deepEqual(
    qoderCnBridgeArgs({
      backendCmd: QODER_EXPLICIT,
      model: "flat-m",
      "qoder-cn": { model: "legacy-m" },
    }),
    [...QODER_CN_NO_MODEL_BASELINE, "--model", "flat-m"],
  );
});

test("codex 段内 model（遗留键）⇒ 不生效、不消费（读点 = 顶层平铺 agentConfig.model）", () => {
  const spec = getAdapter("codex").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: CODEX_BACKEND_CMD_SAMPLE, codex: { model: "seg-model" } },
  });
  assert.ok(!spec.args.includes("--model"), "codex：adapter 不得消费段内 model");
  // M4 源码锚：段退役后 manager.start 的遗留键告警分支已删除（无段可告警）。
  const managerSrc = readFileSync(
    join(appRootFromModule(import.meta.url), "launcher", "manager.ts"),
    "utf8",
  );
  assert.ok(!managerSrc.includes("遗留键告警"), "M4：遗留键告警分支已随段退役删除");
});

test("claude 段内 model = 外部契约 ⇒ 不生效（只读平铺 agentConfig.model；段已随本版退役）", () => {
  const only = getAdapter("claude").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: CLAUDE_NODE_CMD, claude: { model: "seg-model" } },
  });
  assert.ok(!only.args.includes("--model"), "claude：adapter 不得消费段内 model（只读平铺）");
  // 平铺 + 段内并存 ⇒ 只透传平铺值
  const both = getAdapter("claude").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: CLAUDE_NODE_CMD, model: "flat-m", claude: { model: "seg-model" } },
  });
  assert.equal(both.args[both.args.indexOf("--model") + 1], "flat-m");
});

// ◄ v0.8.6 反转（REQ-v0.8.6-2026-09-21-02）：原两条「qoder 无 agentConfig / 缺 backendCmd ⇒ 抛」
// （kind 级必填语义）⇒ 三态。qoder 无 npm 包 ⇒ 命中层 = knownPaths（`~` 由 HOME/USERPROFILE 注入），
// 形态 = **可执行体真身直调**（`.exe` / posix 无扩展名）。
test("qoder-cn buildLaunch：无 agentConfig · knownPaths 命中 ⇒ 不抛且真身直调；全 miss ⇒ 抛且含分层摘要", () => {
  const home = join(SANDBOX, "qoder-home");
  const known = writeKnownPackage(home);
  const spec = withEnv(
    { ...sealedEnv(join(SANDBOX, "qoder-prefix")), HOME: home, USERPROFILE: home },
    () => getAdapter("qoder-cn").buildLaunch(BARE_REQUEST),
  );
  const pair = backendPair(spec);
  assert.equal(pair.cmd, known, "可执行体形态 ⇒ 真身原样直调（不套 node）");
  assert.deepEqual(pair.args, ["--acp"]);

  const msg = missMessage("qoder-cn");
  assert.match(msg, /backendCmd/);
  assert.match(msg, /L0[\s\S]*known[\s\S]*L3/, "文案含分层摘要（qoder 无 npm 包 ⇒ 不列 L1/L2）");
  assert.match(msg, /qoderclicn/, "文案点到命令名（≠ kind 名）");
  assert.ok(msg.length <= 300, `分层清单不进 message：实际 ${msg.length}`);
});

test("qoder-cn buildLaunch：backendCmd 缺键 / 空串 ⇒ 一律回落解析，不抛（◄ v0.8.6 反转「必填」）", () => {
  const home = join(SANDBOX, "qoder-home");
  const known = writeKnownPackage(home);
  const env = { ...sealedEnv(join(SANDBOX, "qoder-prefix")), HOME: home, USERPROFILE: home };
  for (const agentConfig of [{ systemPromptAppend: "x" }, { backendCmd: "" }]) {
    const spec = withEnv(env, () =>
      getAdapter("qoder-cn").buildLaunch({ ...BARE_REQUEST, agentConfig }),
    );
    assert.equal(backendPair(spec).cmd, known, "缺键 / 空串均应回落解析");
  }
});

// ---------- v0.8.1 M4：opencode 迁 ACP 桥（与 qoder 同构，差异 = --backend-args + 配置面） ----------

test('opencode buildLaunch（ACP 族）逐字锁定：桥进程 + --backend-args ["acp"] + --risk（--config-file/segment 已退役）', () => {
  const spec = getAdapter("opencode").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    permissionArgs: getAdapter("opencode").permission("write").args,
    agentConfig: { backendCmd: OPENCODE_EXE },
  });
  assert.equal(spec.command, "node");
  // 桥入口为绝对路径（appRoot 取决运行环境），只断言尾部稳定段
  assert.ok((spec.args[0] ?? "").endsWith(join("dist", "acp-bridge", "index.js")));
  assert.deepEqual(spec.args.slice(1), [
    "--port",
    "4100",
    "--workspace",
    "/ws/p1",
    "--project-id",
    "p1",
    "--backend-cmd",
    OPENCODE_EXE,
    "--backend-args",
    '["acp"]',
    "--risk",
    "write",
  ]);
});

test("opencode buildLaunch：无平铺 systemPrompt ⇒ 不注入 --system-prompt（桥缺省注入）", () => {
  const spec = getAdapter("opencode").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: OPENCODE_EXE },
  });
  assert.ok(!spec.args.includes("--system-prompt"));
  assert.ok(!spec.args.includes("--system-prompt-mode"));
  assert.deepEqual(spec.args.slice(-2), ["--backend-args", '["acp"]']);
});

test("opencode permission 三档映射：read/write/full → --risk <档>（替代旧 --auto-approve 二值）", () => {
  assert.deepEqual(getAdapter("opencode").permission("read"), { args: ["--risk", "read"] });
  assert.deepEqual(getAdapter("opencode").permission("write"), { args: ["--risk", "write"] });
  assert.deepEqual(getAdapter("opencode").permission("full"), { args: ["--risk", "full"] });
});

// ◄ v0.8.6 反转（REQ-v0.8.6-2026-09-21-02）：原「opencode backendCmd 必填、缺省 / 空串 ⇒ 抛」
// ⇒ 三态；「Windows 须 .exe 绝对路径」的探针实证**保留为未命中时的指引**（不再出现在成功路径）。
test('opencode buildLaunch：无 agentConfig · L2 命中 ⇒ 不抛且真身直调 + ["acp"]；全 miss ⇒ 抛且含分层摘要与 .exe 指引', () => {
  const prefix = join(SANDBOX, "opencode-prefix");
  const binAbs = writeNpmPackage(npmRootFor(prefix), "opencode-ai", "opencode", "bin/opencode.exe");
  const spec = withEnv(sealedEnv(prefix), () => getAdapter("opencode").buildLaunch(BARE_REQUEST));
  const pair = backendPair(spec);
  assert.equal(pair.cmd, binAbs, "可执行体形态 ⇒ 真身原样直调（不套 node）");
  assert.deepEqual(pair.args, ["acp"], "kind 级子命令 acp 由形态归一后置");

  const msg = missMessage("opencode");
  assert.match(msg, /backendCmd/);
  assert.match(msg, /L0[\s\S]*L1[\s\S]*L2[\s\S]*L3/, "文案含分层摘要");
  assert.match(msg, /Windows.*\.exe|\.exe.*绝对路径/, "未命中时的 Windows 形态指引仍在文案内");
  assert.ok(msg.length <= 300, `分层清单不进 message：实际 ${msg.length}`);
});

test("opencode buildLaunch：backendCmd 空串 ⇒ 回落解析而非抛（◄ v0.8.6 反转「必填」）", () => {
  const prefix = join(SANDBOX, "opencode-prefix");
  const binAbs = writeNpmPackage(npmRootFor(prefix), "opencode-ai", "opencode", "bin/opencode.exe");
  const spec = withEnv(sealedEnv(prefix), () =>
    getAdapter("opencode").buildLaunch({ ...BARE_REQUEST, agentConfig: { backendCmd: "" } }),
  );
  assert.equal(backendPair(spec).cmd, binAbs);
});

// ---------- v0.8.5-2026-09-21-01 · M2：codex 迁 ACP 桥（wrapper → acp） ----------

test("codex buildLaunch（ACP 族）：脚本入口形态 --backend-args [<入口>]（无 kind 级子命令）", () => {
  assert.deepEqual(
    codexBridgeArgs({ backendCmd: CODEX_BACKEND_CMD_SAMPLE }),
    CODEX_NO_MODEL_BASELINE,
  );
});

test("codex 平铺 model 已配 ⇒ 下发 --model（复用 resolveAcpModel，kind 无关）", () => {
  assert.deepEqual(
    codexBridgeArgs({ backendCmd: CODEX_BACKEND_CMD_SAMPLE, model: "deepseek-v4-pro" }),
    [...CODEX_NO_MODEL_BASELINE, "--model", "deepseek-v4-pro"],
  );
});

test("codex 平铺 model 未配 / 非法 ⇒ 不下发 --model（零回退，argv 逐字 = 基线）", () => {
  const cases: Record<string, Record<string, unknown>> = {
    未配: { backendCmd: CODEX_BACKEND_CMD_SAMPLE },
    空串: { backendCmd: CODEX_BACKEND_CMD_SAMPLE, model: "" },
    数字: { backendCmd: CODEX_BACKEND_CMD_SAMPLE, model: 7 },
    非字符串: { backendCmd: CODEX_BACKEND_CMD_SAMPLE, model: null },
  };
  for (const [name, agentConfig] of Object.entries(cases)) {
    assert.deepEqual(
      codexBridgeArgs(agentConfig),
      CODEX_NO_MODEL_BASELINE,
      `「${name}」应走未配置路径`,
    );
  }
});

test("codex 平铺 + 段内 model 并存 ⇒ 只透传平铺值（段内不掺入、不双读）", () => {
  assert.deepEqual(
    codexBridgeArgs({
      backendCmd: CODEX_BACKEND_CMD_SAMPLE,
      model: "flat-m",
      codex: { model: "seg-model" },
    }),
    [...CODEX_NO_MODEL_BASELINE, "--model", "flat-m"],
  );
});

// 可判据点（派发消息 §门禁与判据）：read 档 argv 同时含 --risk read + --mode read-only +
// --collaboration-mode plan；write / full 档不含 --collaboration-mode。
test("codex 三档 argv：read 含 --risk read + --mode read-only + --collaboration-mode plan；write/full 不含 --collaboration-mode", () => {
  const argsFor = (risk: "read" | "write" | "full"): string[] =>
    getAdapter("codex").buildLaunch({
      projectId: "p1",
      workspace: "/ws/p1",
      a2aPort: 4100,
      agentConfig: { backendCmd: CODEX_BACKEND_CMD_SAMPLE },
      permissionArgs: getAdapter("codex").permission(risk).args,
    }).args;

  const read = argsFor("read");
  for (const token of ["--risk", "read", "--mode", "read-only", "--collaboration-mode", "plan"]) {
    assert.ok(read.includes(token), `read 档 argv 应含 ${token}`);
  }

  const write = argsFor("write");
  assert.deepEqual(write.slice(-4), ["--risk", "write", "--mode", "agent"]);
  assert.ok(!write.includes("--collaboration-mode"), "write 档不得下发 --collaboration-mode");

  const full = argsFor("full");
  assert.deepEqual(full.slice(-4), ["--risk", "full", "--mode", "agent-full-access"]);
  assert.ok(!full.includes("--collaboration-mode"), "full 档不得下发 --collaboration-mode");
});

// ◄ v0.8.6 反转（REQ-v0.8.6-2026-09-21-02）：原「codex backendCmd 必填（缺键 / 空串 ⇒ 抛）」⇒ 三态。
// 文案仍指到适配器 `dist/index.js` 入口（未命中指引，锚 #6 重测正则）。
test("codex buildLaunch：无 agentConfig · L2 命中 ⇒ 不抛且 node + 脚本入口；全 miss ⇒ 抛且含分层摘要与 dist/index.js 指引", () => {
  const prefix = join(SANDBOX, "codex-prefix");
  const binAbs = writeNpmPackage(
    npmRootFor(prefix),
    "@agentclientprotocol/codex-acp",
    "codex-acp",
    "dist/index.js",
  );
  const spec = withEnv(sealedEnv(prefix), () => getAdapter("codex").buildLaunch(BARE_REQUEST));
  const pair = backendPair(spec);
  assert.equal(pair.cmd, process.execPath, "脚本入口 ⇒ 以 node 拉起");
  assert.deepEqual(pair.args, [binAbs]);

  const msg = missMessage("codex");
  assert.match(msg, /backendCmd/);
  assert.match(msg, /dist\/index\.js/);
  assert.match(msg, /L0[\s\S]*L1[\s\S]*L2[\s\S]*L3/, "文案含分层摘要");
  assert.ok(msg.length <= 300, `分层清单不进 message：实际 ${msg.length}`);
});

test("codex buildLaunch：backendCmd 空串 ⇒ 回落解析而非抛（◄ v0.8.6 反转「必填」）", () => {
  const prefix = join(SANDBOX, "codex-prefix");
  const binAbs = writeNpmPackage(
    npmRootFor(prefix),
    "@agentclientprotocol/codex-acp",
    "codex-acp",
    "dist/index.js",
  );
  const spec = withEnv(sealedEnv(prefix), () =>
    getAdapter("codex").buildLaunch({ ...BARE_REQUEST, agentConfig: { backendCmd: "" } }),
  );
  assert.deepEqual(backendPair(spec), { cmd: process.execPath, args: [binAbs] });
});

// ---------- v0.8.5-2026-09-21-01 · M8 实现级增补：`backendCmd` 形态归一 ----------

test("resolveBackendSpawn：脚本形态（.js/.mjs/.cjs）⇒ node + 脚本路径；其余 ⇒ 直调原样", () => {
  assert.deepEqual(SCRIPT_BACKEND_EXTS, [".js", ".mjs", ".cjs"]);
  for (const ext of [".js", ".mjs", ".cjs"]) {
    assert.deepEqual(resolveBackendSpawn(`/opt/adapter/entry${ext}`), {
      command: process.execPath,
      args: [`/opt/adapter/entry${ext}`],
    });
  }
  // 扩展名大小写不敏感
  assert.equal(resolveBackendSpawn("C:/x/ENTRY.JS").command, process.execPath);
  // 可执行体 / 裸名 ⇒ 直调（原样，args 空）
  for (const exe of ["C:/npm/opencode.exe", "qoderclicn", "/usr/local/bin/node"]) {
    assert.deepEqual(resolveBackendSpawn(exe), { command: exe, args: [] });
  }
  // kindArgs 串接顺序：脚本路径在前、kind 参数在后
  assert.deepEqual(resolveBackendSpawn("/x/entry.js", ["acp"]), {
    command: process.execPath,
    args: ["/x/entry.js", "acp"],
  });
  assert.deepEqual(resolveBackendSpawn("C:/x/opencode.exe", ["acp"]), {
    command: "C:/x/opencode.exe",
    args: ["acp"],
  });
});

test("codex/claude：backendCmd 为脚本入口 ⇒ --backend-cmd <node 绝对路径> + --backend-args [<脚本入口>]", () => {
  const script = CODEX_BACKEND_CMD_SAMPLE;
  assert.deepEqual(codexBridgeArgs({ backendCmd: script }), [
    "--port",
    "4100",
    "--workspace",
    "/ws/p1",
    "--project-id",
    "p1",
    "--backend-cmd",
    process.execPath,
    "--backend-args",
    JSON.stringify([script]),
  ]);

  const claudeArgs = getAdapter("claude")
    .buildLaunch({
      projectId: "p1",
      workspace: "/ws/p1",
      a2aPort: 4100,
      agentConfig: { backendCmd: script },
    })
    .args.slice(1);
  assert.deepEqual(claudeArgs, [
    "--port",
    "4100",
    "--workspace",
    "/ws/p1",
    "--project-id",
    "p1",
    "--backend-cmd",
    process.execPath,
    "--backend-args",
    JSON.stringify([script]),
  ]);
});

test("codex/claude：backendCmd 为可执行体 ⇒ 直调 + --backend-args '[]'（旧形态逐字不变）", () => {
  const exe = posixFixture("pureexe-form.exe");
  assert.deepEqual(codexBridgeArgs({ backendCmd: exe }), [
    "--port",
    "4100",
    "--workspace",
    "/ws/p1",
    "--project-id",
    "p1",
    "--backend-cmd",
    exe,
    "--backend-args",
    "[]",
  ]);
  const claudeArgs = getAdapter("claude")
    .buildLaunch({
      projectId: "p1",
      workspace: "/ws/p1",
      a2aPort: 4100,
      agentConfig: { backendCmd: exe },
    })
    .args.slice(1);
  assert.equal(claudeArgs[claudeArgs.indexOf("--backend-cmd") + 1], exe);
  assert.equal(claudeArgs[claudeArgs.indexOf("--backend-args") + 1], "[]");
});

// ---------- v0.8.5 增补轨（Feature c0e388d7 · 节点 N1）：codex / claude 平铺 systemPrompt(Mode) 接线 ----------

/** claude 未配 model 时的桥侧参数基线（`backendCmd` = node 真身 ⇒ 可执行体形态，`--backend-args '[]'`）。 */
const CLAUDE_BASELINE_N1 = [
  "--port",
  "4100",
  "--workspace",
  "/ws/p1",
  "--project-id",
  "p1",
  "--backend-cmd",
  CLAUDE_NODE_CMD,
  "--backend-args",
  "[]",
];

function claudeBridgeArgsN1(agentConfig: Record<string, unknown>): string[] {
  return getAdapter("claude")
    .buildLaunch({ projectId: "p1", workspace: "/ws/p1", a2aPort: 4100, agentConfig })
    .args.slice(1);
}

test("codex 平铺 systemPrompt 已配 ⇒ argv 含 --system-prompt <值>；未配 ⇒ 无该 flag", () => {
  assert.deepEqual(
    codexBridgeArgs({ backendCmd: CODEX_BACKEND_CMD_SAMPLE, systemPrompt: "be terse" }),
    [...CODEX_NO_MODEL_BASELINE, "--system-prompt", "be terse"],
  );
  const unset = codexBridgeArgs({ backendCmd: CODEX_BACKEND_CMD_SAMPLE });
  assert.deepEqual(unset, CODEX_NO_MODEL_BASELINE);
  assert.ok(!unset.includes("--system-prompt"));
  assert.ok(!unset.includes("--system-prompt-mode"));
  assert.ok(!unset.includes("--model"), "负向锚保留：未配 model ⇒ 无 --model");
});

test("codex 平铺 systemPromptMode 已配 ⇒ 下发 --system-prompt-mode（append / replace 原样）", () => {
  assert.deepEqual(
    codexBridgeArgs({
      backendCmd: CODEX_BACKEND_CMD_SAMPLE,
      systemPrompt: "sp",
      systemPromptMode: "replace",
    }),
    [...CODEX_NO_MODEL_BASELINE, "--system-prompt", "sp", "--system-prompt-mode", "replace"],
  );
  assert.deepEqual(
    codexBridgeArgs({
      backendCmd: CODEX_BACKEND_CMD_SAMPLE,
      systemPrompt: "sp",
      systemPromptMode: "append",
    }),
    [...CODEX_NO_MODEL_BASELINE, "--system-prompt", "sp", "--system-prompt-mode", "append"],
  );
});

test("codex 平铺 systemPrompt 非法（空串 / 数字 / null）⇒ 与未配同路径逐字一致；mode 非法 ⇒ 只下发 systemPrompt", () => {
  const invalid: Record<string, Record<string, unknown>> = {
    空串: { backendCmd: CODEX_BACKEND_CMD_SAMPLE, systemPrompt: "" },
    数字: { backendCmd: CODEX_BACKEND_CMD_SAMPLE, systemPrompt: 42 },
    非字符串: { backendCmd: CODEX_BACKEND_CMD_SAMPLE, systemPrompt: null },
  };
  for (const [name, agentConfig] of Object.entries(invalid)) {
    assert.deepEqual(
      codexBridgeArgs(agentConfig),
      CODEX_NO_MODEL_BASELINE,
      `「${name}」应走未配置路径`,
    );
  }
  assert.deepEqual(
    codexBridgeArgs({
      backendCmd: CODEX_BACKEND_CMD_SAMPLE,
      systemPrompt: "sp",
      systemPromptMode: "prepend",
    }),
    [...CODEX_NO_MODEL_BASELINE, "--system-prompt", "sp"],
  );
});

test("codex systemPrompt 与 --backend-args / permissionArgs 共存互不覆盖（N1 硬边界 ⑤）", () => {
  const spec = getAdapter("codex").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: {
      backendCmd: CODEX_BACKEND_CMD_SAMPLE,
      systemPrompt: "sp",
      systemPromptMode: "append",
    },
    permissionArgs: getAdapter("codex").permission("read").args,
  });
  assert.deepEqual(spec.args.slice(1), [
    ...CODEX_NO_MODEL_BASELINE,
    "--system-prompt",
    "sp",
    "--system-prompt-mode",
    "append",
    "--risk",
    "read",
    "--mode",
    "read-only",
    "--collaboration-mode",
    "plan",
  ]);
});

test("claude 平铺 systemPrompt 已配 ⇒ argv 含 --system-prompt <值>；未配 ⇒ 无该 flag", () => {
  assert.deepEqual(claudeBridgeArgsN1({ backendCmd: CLAUDE_NODE_CMD, systemPrompt: "be terse" }), [
    ...CLAUDE_BASELINE_N1,
    "--system-prompt",
    "be terse",
  ]);
  const unset = claudeBridgeArgsN1({ backendCmd: CLAUDE_NODE_CMD });
  assert.deepEqual(unset, CLAUDE_BASELINE_N1);
  assert.ok(!unset.includes("--system-prompt"));
  assert.ok(!unset.includes("--system-prompt-mode"));
  assert.ok(!unset.includes("--model"), "负向锚保留：未配 model ⇒ 无 --model");
});

test("claude 平铺 systemPromptMode 已配 ⇒ 下发 --system-prompt-mode；非法 ⇒ 不下发（只留 systemPrompt）", () => {
  assert.deepEqual(
    claudeBridgeArgsN1({ backendCmd: CLAUDE_NODE_CMD, systemPrompt: "sp", systemPromptMode: "replace" }),
    [...CLAUDE_BASELINE_N1, "--system-prompt", "sp", "--system-prompt-mode", "replace"],
  );
  assert.deepEqual(
    claudeBridgeArgsN1({ backendCmd: CLAUDE_NODE_CMD, systemPrompt: "sp", systemPromptMode: "bogus" }),
    [...CLAUDE_BASELINE_N1, "--system-prompt", "sp"],
  );
});

test("claude systemPrompt 与 --backend-args / permissionArgs（full 档）共存互不覆盖", () => {
  const spec = getAdapter("claude").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: CLAUDE_NODE_CMD, systemPrompt: "sp" },
    permissionArgs: getAdapter("claude").permission("full").args,
  });
  assert.deepEqual(spec.args.slice(1, 11), CLAUDE_BASELINE_N1);
  assert.deepEqual(spec.args.slice(11), [
    "--system-prompt",
    "sp",
    "--risk",
    "full",
    "--mode",
    "bypassPermissions",
    "--session-meta-json",
    JSON.stringify({ claudeCode: { options: { allowDangerouslySkipPermissions: true } } }),
  ]);
});

test("平铺 systemPrompt(Mode) 读点 = 4 家（opencode/qoder-cn/codex/claude）且与 backend-args 形态解析无耦合（N1 接线锚）", () => {
  const root = appRootFromModule(import.meta.url);
  for (const kind of ["opencode", "qoder-cn", "codex", "claude"]) {
    const src = readFileSync(join(root, "adapters", `${kind}.ts`), "utf8");
    assert.ok(
      src.includes("resolveSystemPrompt(request.agentConfig)"),
      `${kind} 应读平铺 systemPrompt`,
    );
    assert.ok(
      src.includes("resolveSystemPromptMode(request.agentConfig)"),
      `${kind} 应读平铺 systemPromptMode`,
    );
    assert.ok(src.includes('"--system-prompt"'), `${kind} 应下发 --system-prompt`);
    assert.ok(src.includes('"--system-prompt-mode"'), `${kind} 应下发 --system-prompt-mode`);
  }
  const backendSrc = readFileSync(join(root, "adapters", "backend-command.ts"), "utf8");
  assert.ok(!backendSrc.includes("resolveSystemPrompt"), "backend-command 不得耦合 systemPrompt");
});

// ---------- REQ-v0.8.7-2026-09-22-01 · M2：平铺 sessionTimeoutMs ⇒ 桥 `--session-timeout <ms>` ----------

test("M2 接线锚：sessionTimeoutMs 读点 + 下发 = 4 家（opencode/qoder-cn/codex/claude）", () => {
  const root = appRootFromModule(import.meta.url);
  for (const kind of ["opencode", "qoder-cn", "codex", "claude"]) {
    const src = readFileSync(join(root, "adapters", `${kind}.ts`), "utf8");
    assert.ok(
      src.includes("resolveSessionTimeoutMs(request.agentConfig)"),
      `${kind} 应读平铺 sessionTimeoutMs`,
    );
    assert.ok(src.includes('"--session-timeout"'), `${kind} 应下发 --session-timeout`);
  }
});

test("M2 逐字锚：4 家已配 ⇒ --session-timeout <ms> 恰在 permissionArgs 前；未配 ⇒ 零下发", () => {
  const cases: Array<{ kind: AgentKind; agentConfig: Record<string, unknown> }> = [
    { kind: "qoder-cn", agentConfig: { backendCmd: QODER_EXPLICIT, sessionTimeoutMs: 300000 } },
    { kind: "opencode", agentConfig: { backendCmd: OPENCODE_EXE, sessionTimeoutMs: 300000 } },
    {
      kind: "codex",
      agentConfig: { backendCmd: CODEX_BACKEND_CMD_SAMPLE, sessionTimeoutMs: 300000 },
    },
    { kind: "claude", agentConfig: { backendCmd: CLAUDE_NODE_CMD, sessionTimeoutMs: 300000 } },
  ];
  for (const { kind, agentConfig } of cases) {
    const adapter = getAdapter(kind);
    const perm = adapter.permission("write").args;
    const withTimeout = adapter
      .buildLaunch({ ...BARE_REQUEST, agentConfig, permissionArgs: perm })
      .args.slice(1);
    const i = withTimeout.indexOf("--session-timeout");
    assert.ok(i >= 0, `${kind}：已配 ⇒ 应下发 --session-timeout`);
    assert.equal(withTimeout[i + 1], "300000");
    assert.deepEqual(withTimeout.slice(i + 2), perm, `${kind}：--session-timeout 恰在 permissionArgs 前`);
    const without = adapter.buildLaunch({
      ...BARE_REQUEST,
      agentConfig: { ...agentConfig, sessionTimeoutMs: undefined },
    }).args.slice(1);
    assert.ok(!without.includes("--session-timeout"), `${kind}：未配 ⇒ 不下发旗标（桥落缺省）`);
  }
});

test("M2 值形态：数字 ms 原样十进制字符串下发（上限 900000 边界值可透传）", () => {
  const args = getAdapter("qoder-cn")
    .buildLaunch({
      ...BARE_REQUEST,
      agentConfig: { backendCmd: QODER_EXPLICIT, sessionTimeoutMs: SESSION_TIMEOUT_MS_CAP },
    })
    .args.slice(1);
  assert.equal(args[args.indexOf("--session-timeout") + 1], "900000");
});
