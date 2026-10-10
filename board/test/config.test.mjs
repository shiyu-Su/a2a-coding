/**
 * BD12″ 板配置化用例（config.ts 加载器 + index.ts 装配 + 真进程钉子）。
 *
 * 八组：① 完整配置逐键生效（含 `_comment` 族被忽略）② 缺 config.json ⇒ 明确错误文案（不裸崩）
 * ③ 坏 JSON ⇒ `[config]` 前缀错误 ④ 非法值 ⇒ 结构化 fail-fast ⑤ 未知键 ⇒ 忽略不影响解析
 * ⑥ orgsDir 留空 ⇒ 宿主面不装配 ⑦ env 只覆盖路径；argv 传配置内容一律不生效（真进程）
 * ⑧ 拆分不变量（REQ-2026-10-10-01 配置模板拆分）：模板两文件无 `_` 键 / 缺省常量键值 == 常量
 *    / 叶子值无尖括号 / 键集 ⊆ 内联白名单。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  CONFIG_PATH_ENV,
  CONFIG_TEMPLATE_NAME,
  DEFAULT_HOST,
  DEFAULT_PORT,
  loadConfig,
  parseLegacyReleasedVersions,
  resolveConfigPath,
  validateConfig,
} from "../dist/config.js";
import { DEFAULT_BRIDGE_BASE_URL } from "../dist/bridge-client.js";
import { buildHostFace } from "../dist/index.js";
import { DEFAULT_HOST_AGENT_KIND } from "../dist/host-bridge.js";
import { DEFAULT_TURN_TIMEOUT_MS } from "../dist/host-turn.js";
import { DEFAULT_MCP_BASE_URL } from "../dist/requirement.js";
import { defaultPidfilePath, readPidfile } from "../dist/lifecycle.js";
import { resolveMachineDistDir } from "../dist/host-runtime.js";

const boardRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** 写一份临时配置文件，返回其路径（loadConfig 经 BOARD_CONFIG 指过去）。 */
function tmpConfig(objOrText) {
  const dir = mkdtempSync(join(tmpdir(), "board-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, typeof objOrText === "string" ? objOrText : JSON.stringify(objOrText), "utf8");
  return { dir, path };
}

function load(objOrText) {
  const { dir, path } = tmpConfig(objOrText);
  try {
    return loadConfig({ [CONFIG_PATH_ENV]: path });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("①完整配置：逐键生效，`_` 前缀注释键（_comment 族）被忽略", () => {
  const orgs = mkdtempSync(join(tmpdir(), "board-orgs-"));
  try {
    const cfg = load({
      _comment: "模板注释不该参与解析",
      _portComment: "这条也一样",
      port: 4599,
      host: "::1",
      orgsDir: orgs,
      group: "表单兜底组",
      hostKind: "codex",
      bridgeUrl: "http://127.0.0.1:3999",
      mcpBaseUrl: "http://10.0.0.5:9000",
      machineDist: "D:/custom/machine-dist",
      turnTimeoutMs: 123456,
    });
    assert.equal(cfg.port, 4599);
    assert.equal(cfg.host, "::1");
    assert.equal(cfg.orgsDir, orgs);
    assert.equal(cfg.group, "表单兜底组");
    assert.equal(cfg.hostKind, "codex");
    assert.equal(cfg.bridgeUrl, "http://127.0.0.1:3999");
    assert.equal(cfg.mcpBaseUrl, "http://10.0.0.5:9000");
    assert.equal(cfg.machineDist, "D:/custom/machine-dist");
    assert.equal(cfg.turnTimeoutMs, 123456);
    assert.ok(cfg.sourcePath.endsWith("config.json"));
  } finally {
    rmSync(orgs, { recursive: true, force: true });
  }
});

test("①b缺省值逐项与 BD12″ 之前一致（空对象 = 全缺省）", () => {
  const cfg = load({});
  assert.equal(cfg.port, DEFAULT_PORT);
  assert.equal(cfg.host, DEFAULT_HOST);
  assert.equal(cfg.orgsDir, null);
  assert.equal(cfg.group, null);
  assert.equal(cfg.hostKind, "claude");
  assert.equal(cfg.bridgeUrl, "http://127.0.0.1:3300");
  assert.equal(cfg.mcpBaseUrl, "http://127.0.0.1:8787");
  assert.equal(cfg.machineDist, resolveMachineDistDir({}));
  assert.equal(cfg.turnTimeoutMs, null);
});

test("②（负向）缺 config.json ⇒ [config] 明确文案 + 提示从模板复制，不裸崩", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "board-nocfg-")), "config.json");
  assert.throws(
    () => loadConfig({ [CONFIG_PATH_ENV]: missing }),
    (err) =>
      err instanceof Error &&
      /^\[config\]/.test(err.message) &&
      err.message.includes("配置文件不存在") &&
      err.message.includes(CONFIG_TEMPLATE_NAME),
    "缺文件必须是可读文案（指向 .default），不得裸 ENOENT 崩",
  );
});

test("③（负向）坏 JSON ⇒ [config] 前缀错误 + 指向模板", () => {
  assert.throws(
    () => load('{ "port": 3400,,, }'),
    (err) => err instanceof Error && /^\[config\]/.test(err.message) && err.message.includes(CONFIG_TEMPLATE_NAME),
  );
});

test("④（负向）非法值 ⇒ `[config] <字段路径>` 结构化拒绝，不静默降级", () => {
  const cases = [
    [{ port: "3400" }, /^\[config\] port/],
    [{ port: 70000 }, /^\[config\] port/],
    [{ port: 34.5 }, /^\[config\] port/],
    [{ turnTimeoutMs: 0 }, /^\[config\] turnTimeoutMs/],
    [{ turnTimeoutMs: -5 }, /^\[config\] turnTimeoutMs/],
    [{ hostKind: 5 }, /^\[config\] hostKind/],
    [{ bridgeUrl: "127.0.0.1:3300" }, /^\[config\] bridgeUrl/],
    [{ mcpBaseUrl: "ftp://x/" }, /^\[config\] mcpBaseUrl/],
    [{ orgsDir: 123 }, /^\[config\] orgsDir/],
  ];
  for (const [obj, re] of cases) {
    assert.throws(() => validateConfig(obj, "t://x"), (err) => re.test(err.message), `非法 ${JSON.stringify(obj)} 必须被拒`);
  }
  assert.throws(() => validateConfig([], "t://x"), (err) => /^\[config\]/.test(err.message), "顶层数组也是 [config] 口径");
});

test("⑤未知键 ⇒ 忽略、不影响解析", () => {
  const cfg = load({ futureKnob: { deep: true }, anotherString: "x", port: 4601 });
  assert.equal(cfg.port, 4601);
  assert.equal(cfg.orgsDir, null);
});

test("⑤b releasedVersions（退役键 · v0.9.4 N3）：parseLegacyReleasedVersions 缺省 = []；合法登记 trim + 去重后原样生效", () => {
  assert.deepEqual(parseLegacyReleasedVersions({}), [], "整键缺失 ⇒ 缺省空 = 无锁版");
  assert.deepEqual(parseLegacyReleasedVersions({ releasedVersions: null }), [], "null 同缺省");
  assert.deepEqual(parseLegacyReleasedVersions({ releasedVersions: [] }), []);
  assert.deepEqual(
    parseLegacyReleasedVersions({ releasedVersions: ["v0.9.0", " v0.9.1 ", "v0.9.0", "v0.9.2 "] }),
    ["v0.9.0", "v0.9.1", "v0.9.2"],
    "元素 trim 后保序去重（先到先得）",
  );
  // 运行时锁改读版本台账 ⇒ 该键不再进入 BoardConfig（validateConfig 只作未知键忽略）
  assert.equal(
    "releasedVersions" in validateConfig({ releasedVersions: ["v0.9.0"] }, "t://x"),
    false,
    "退役后运行时配置面不再承载 releasedVersions（仅一次性迁移读取）",
  );
});

test("⑤c（负向）退役键 releasedVersions 非法 ⇒ parseLegacyReleasedVersions 抛 `[config] releasedVersions` fail-fast", () => {
  const cases = [
    { releasedVersions: "v0.9.1" },
    { releasedVersions: 42 },
    { releasedVersions: {} },
    { releasedVersions: ["v0.9.0", 7] },
    { releasedVersions: [""] },
    { releasedVersions: ["   "] },
    { releasedVersions: ["v0.9.0", null] },
  ];
  for (const obj of cases) {
    assert.throws(
      () => parseLegacyReleasedVersions(obj),
      (err) => err instanceof Error && /^\[config\] releasedVersions/.test(err.message),
      `非法 ${JSON.stringify(obj)} 必须被拒（不静默降级）`,
    );
  }
});

test("⑥（负向）orgsDir 留空 / 缺键 ⇒ 宿主面不装配（buildHostFace 返 null）", () => {
  for (const orgsDir of [undefined, "", "   "]) {
    const cfg = validateConfig(orgsDir === undefined ? {} : { orgsDir }, "t://x");
    assert.equal(cfg.orgsDir, null, `orgsDir=${JSON.stringify(orgsDir)} ⇒ 未配置（无缺省兜底）`);
    assert.equal(
      buildHostFace({ orgsDir: cfg.orgsDir, defaultOrg: null, kind: cfg.hostKind, mcpBaseUrl: cfg.mcpBaseUrl, machineDist: cfg.machineDist }),
      null,
      "未配置组织目录根 ⇒ 宿主面不装配、不建任何托管器",
    );
  }
});

test("⑦env 只覆盖配置文件路径；BOARD_* env 与 argv 的配置内容通道一律不生效", () => {
  const p = resolveConfigPath({ [CONFIG_PATH_ENV]: "D:/my/board-config.json" });
  assert.equal(p, "D:\\my\\board-config.json", "绝对路径按平台规范原样生效");
  // 相对路径按 cwd 解析
  assert.ok(resolveConfigPath({ [CONFIG_PATH_ENV]: "x/y.json" }).includes(join("x", "y.json")));
  // 空白 = 未设置 ⇒ 回落仓内缺省 <board>/config/config.json
  assert.equal(resolveConfigPath({ [CONFIG_PATH_ENV]: "  " }), join(boardRoot, "config", "config.json"));
  // 其余 BOARD_* env 不再影响任何解析结果（旧通道已撤）—— 用一个空配置文件隔离仓内活配置
  const { dir, path } = tmpConfig({});
  try {
    const cfg = loadConfig({
      [CONFIG_PATH_ENV]: path,
      BOARD_PORT: "5999",
      PORT: "5998",
      BOARD_HOST: "0.0.0.0",
      BOARD_MCP_GROUP: "env组",
      BOARD_ORGS_DIR: "Z:/env",
      BOARD_HOST_KIND: "envkind",
      BOARD_BRIDGE_URL: "http://1.2.3.4:1",
      BOARD_MCP_URL: "http://1.2.3.4:2",
      BOARD_TURN_TIMEOUT_MS: "1",
      BOARD_MACHINE_DIST: "Z:/env-dist",
    });
    assert.equal(cfg.port, DEFAULT_PORT);
    assert.equal(cfg.host, DEFAULT_HOST);
    assert.equal(cfg.group, null);
    assert.equal(cfg.orgsDir, null);
    assert.equal(cfg.hostKind, "claude");
    assert.equal(cfg.bridgeUrl, "http://127.0.0.1:3300");
    assert.equal(cfg.mcpBaseUrl, "http://127.0.0.1:8787");
    assert.equal(cfg.turnTimeoutMs, null);
    assert.equal(cfg.machineDist, resolveMachineDistDir({}), "BOARD_MACHINE_DIST 不得生效（启动路径的 machineDist 恒由配置加载器显式给出）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑦b（真进程钉子）argv 传配置内容一律不生效：--port / --group / --orgs-dir 全被忽略", async () => {
  const port = 18653;
  const { dir, path } = tmpConfig({ port });
  const child = spawn(
    process.execPath,
    [join(boardRoot, "dist", "index.js"), "--port=12345", "--group=argv组", "--orgs-dir=Z:/argv", String(port + 1)],
    {
      // cwd 必须离开真实板根：启动路径的台账 / 挂起台账落点按 `process.cwd()/.data` 解析，
      // 用板根当 cwd ⇒ 本钉子会改写**生产台账**（v0.9.6 B1 migrateLedgerOrgs 暴露）。
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, [CONFIG_PATH_ENV]: path, BOARD_PORT: String(port + 2) },
    },
  );
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
    assert.ok(health !== null, `配置文件端口 ${port} 应在监听（argv/env 端口一律无效）：${errOut}`);
    assert.equal(health.port, port, "生效端口 = 配置文件值，不是 --port= / 位置参数 / BOARD_PORT");
    assert.ok(out.includes(`配置来源 = ${path}`), `横幅须回显配置来源路径：${out}`);
    assert.ok(!out.includes("argv组"), `--group= 不得生效：${out}`);
    assert.ok(out.includes("宿主面未装配"), "--orgs-dir= 不得生效（配置文件未配 orgsDir ⇒ 仍不装配）");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    // 子进程**自己**写的是仓根 pidfile（Windows 的 SIGTERM 不走优雅停机链 ⇒ 会留陈旧文件）：
    // 只删「记录里的 pid 恰是本次子进程」那一个，绝不误删他人现场。
    const pidPath = defaultPidfilePath(boardRoot);
    const record = readPidfile(pidPath);
    if (record !== null && record.pid === child.pid) rmSync(pidPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑧ 拆分不变量（REQ-2026-10-10-01 · 配置模板拆分 S2 · board b2）
// ---------------------------------------------------------------------------

/** 板可配键白名单（本用例内联 = 唯一落点；新增 / 改名配置键须同轮改这里 + README）。 */
const TEMPLATE_KEYS = [
  "port",
  "host",
  "orgsDir",
  "group",
  "hostKind",
  "hostModel",
  "bridgeUrl",
  "mcpBaseUrl",
  "machineDist",
  "repoRoot",
  "turnTimeoutMs",
];

/** `.default` 里「有代码缺省常量」的键 → 常量本身（按常量比对，用例内零字面量；板例外集 = 空）。 */
const CODE_DEFAULTS = {
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  hostKind: DEFAULT_HOST_AGENT_KIND,
  bridgeUrl: DEFAULT_BRIDGE_BASE_URL,
  mcpBaseUrl: DEFAULT_MCP_BASE_URL,
  turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
};

/** 递归收集 [键路径, 值]（含中间层，板模板现为扁平）。 */
function keyEntries(node, prefix = "", out = []) {
  if (node === null || typeof node !== "object") return out;
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    out.push([path, value]);
    keyEntries(value, path, out);
  }
  return out;
}

test("⑧拆分不变量：两模板无 `_` 前缀键 · 缺省常量键值逐等于常量 · 递归叶子值无尖括号 · 键集 ⊆ 白名单", () => {
  const files = ["config.json.default", "config.json.example"].map((name) => [
    name,
    JSON.parse(readFileSync(join(boardRoot, "config", name), "utf8")),
  ]);
  for (const [name, parsed] of files) {
    for (const [path] of keyEntries(parsed)) {
      assert.ok(
        path.split(".").every((segment) => !segment.startsWith("_")),
        `${name}：不得出现 _ 前缀键（说明位 = README）⇒ ${path}`,
      );
      assert.ok(TEMPLATE_KEYS.includes(path.split(".").pop()), `${name}：键 ${path} 不在可配键白名单内`);
    }
    const angled = keyEntries(parsed)
      .filter(([, v]) => typeof v === "string" && /[<>]/.test(v))
      .map(([p]) => p);
    assert.deepEqual(angled, [], `${name}：递归叶子值不得含 < > 形态占位`);
  }

  const defaults = files[0][1];
  for (const [key, constant] of Object.entries(CODE_DEFAULTS)) {
    assert.ok(key in defaults, `.default 须留缺省常量键 ${key}`);
    assert.equal(defaults[key], constant, `.default 的 ${key} 须逐等于代码缺省常量（板例外集 = 空）`);
  }
});
