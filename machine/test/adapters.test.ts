/**
 * `machine/adapters/` 单测（REQ-v0.8.0-2026-09-18-01 §4.1-4/§4.1-5；
 * REQ-v0.8.0-2026-09-19-01 · 节点 M4 扩 qoder；REQ-v0.8.1-2026-09-19-01 · M4 opencode 迁 ACP 桥）。
 *
 * 锁「wrapper 族两家（codex/claude）行为零变化」：`buildLaunch` 命令与参数形状、
 * `permission` 三档映射、`baseConfig` 形状**逐字**断言；并锁协议维度
 * （codex/claude = `"wrapper"`、opencode/qoder = `"acp"`）与两家 ACP 适配器
 * （拉桥进程 / `--risk` 三档 / baseConfig 形状 / backendCmd 必填抛错）。
 * `getAdapter` 四家可达、恰 4 个不同实例。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_KINDS } from "../agent-kinds.js";
import { getAdapter, wrapperConfigPath } from "../adapters/index.js";
import { A2A_OUTCOME_CONVENTION } from "../launcher/agent-config.js";
import { appRootFromModule } from "../launcher/app-root.js";
import { AgentManager } from "../launcher/manager.js";
import type { LaunchRequest } from "../adapters/types.js";
import type { MachineConfig } from "../types.js";

/** 覆盖全部可选字段的拉起请求（用于逐字锁定参数形状） */
const FULL_REQUEST: LaunchRequest = {
  projectId: "p1",
  workspace: "/ws/p1",
  a2aPort: 4100,
  configPath: "/cfg/opencode.p1.json",
  permissionArgs: ["--auto-approve"],
};

test("getAdapter：AGENT_KINDS 每个成员可达、kind 对应、恰 4 个不同实例", () => {
  assert.equal(AGENT_KINDS.length, 4);
  const adapters = AGENT_KINDS.map((kind) => getAdapter(kind));
  assert.deepEqual(
    adapters.map((a) => a.kind),
    [...AGENT_KINDS],
  );
  assert.equal(new Set(adapters).size, AGENT_KINDS.length);
});

test("协议维度：codex/claude = \"wrapper\"，opencode/qoder = \"acp\"（v0.8.1 M4 opencode 迁桥）", () => {
  const expected = {
    opencode: "acp",
    codex: "wrapper",
    claude: "wrapper",
    qoder: "acp",
  } as const;
  for (const kind of AGENT_KINDS) {
    assert.equal(getAdapter(kind).protocol, expected[kind]);
  }
});

test("buildLaunch 逐字锁定：codex/claude 用 --workspace（wrapper 族行为零变化）", () => {
  assert.deepEqual(getAdapter("codex").buildLaunch(FULL_REQUEST), {
    command: "a2a-codex",
    args: [
      "--config",
      "/cfg/opencode.p1.json",
      "--port",
      "4100",
      "--hostname",
      "127.0.0.1",
      "--advertise-host",
      "localhost",
      "--workspace",
      "/ws/p1",
      "--auto-approve",
    ],
  });
  assert.deepEqual(getAdapter("claude").buildLaunch(FULL_REQUEST), {
    command: "a2a-claude",
    args: [
      "--config",
      "/cfg/opencode.p1.json",
      "--port",
      "4100",
      "--hostname",
      "127.0.0.1",
      "--advertise-host",
      "localhost",
      "--workspace",
      "/ws/p1",
      "--auto-approve",
    ],
  });
});

test("buildLaunch：codex/claude 缺省 configPath 回退 wrapperConfigPath", () => {
  const minimal: LaunchRequest = { projectId: "p1", workspace: "/ws/p1", a2aPort: 4100 };
  assert.deepEqual(getAdapter("codex").buildLaunch(minimal).args.slice(0, 2), [
    "--config",
    wrapperConfigPath("codex", "p1"),
  ]);
  assert.deepEqual(getAdapter("claude").buildLaunch(minimal).args.slice(0, 2), [
    "--config",
    wrapperConfigPath("claude", "p1"),
  ]);
});

test("permission 三档映射逐字锁定（wrapper 族两家行为零变化）", () => {
  assert.deepEqual(getAdapter("codex").permission("read"), { args: ["--sandbox", "read-only"] });
  assert.deepEqual(getAdapter("codex").permission("write"), {
    args: ["--sandbox", "workspace-write"],
  });
  assert.deepEqual(getAdapter("codex").permission("full"), {
    args: ["--sandbox", "danger-full-access"],
  });

  assert.deepEqual(getAdapter("claude").permission("read"), {
    args: ["--permission-mode", "plan"],
  });
  assert.deepEqual(getAdapter("claude").permission("write"), {
    args: ["--permission-mode", "acceptEdits"],
  });
  assert.deepEqual(getAdapter("claude").permission("full"), {
    args: ["--permission-mode", "bypassPermissions"],
    config: { claude: { dangerouslyAllowBypassPermissions: true } },
  });
});

test("baseConfig 形状逐字锁定（含 a2a-outcome 约定注入）", () => {
  assert.deepEqual(getAdapter("opencode").baseConfig(), {
    opencode: { systemPrompt: A2A_OUTCOME_CONVENTION, systemPromptMode: "append" },
  });
  assert.deepEqual(getAdapter("codex").baseConfig(), {
    codex: { skipGitRepoCheck: true, developerInstructions: A2A_OUTCOME_CONVENTION },
  });
  assert.deepEqual(getAdapter("claude").baseConfig(), {
    claude: { settingSources: ["user"], systemPromptAppend: A2A_OUTCOME_CONVENTION },
  });
});

test("qoder buildLaunch（ACP 族）：拉起仓内桥进程（node + dist/acp-bridge/index.js）", () => {
  const spec = getAdapter("qoder").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: "qoderclicn" },
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
    "qoderclicn",
  ]);
});

test("qoder buildLaunch：permissionArgs（--risk <档>）追加在基础参数之后", () => {
  const spec = getAdapter("qoder").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: "qoderclicn" },
    permissionArgs: getAdapter("qoder").permission("read").args,
  });
  assert.deepEqual(spec.args.slice(-2), ["--risk", "read"]);
});

test("qoder permission 三档映射：read/write/full → --risk <档>", () => {
  assert.deepEqual(getAdapter("qoder").permission("read"), { args: ["--risk", "read"] });
  assert.deepEqual(getAdapter("qoder").permission("write"), { args: ["--risk", "write"] });
  assert.deepEqual(getAdapter("qoder").permission("full"), { args: ["--risk", "full"] });
});

test("qoder baseConfig 形状锁定（占位 qoder 段 + outcome 注入）", () => {
  assert.deepEqual(getAdapter("qoder").baseConfig(), {
    qoder: { systemPromptAppend: A2A_OUTCOME_CONVENTION },
  });
});

test("qoder buildLaunch：agentConfig.backendCmd 原样透传（绝对路径）", () => {
  const spec = getAdapter("qoder").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: "/opt/qoder/qoderclicn" },
  });
  assert.equal(spec.args[spec.args.indexOf("--backend-cmd") + 1], "/opt/qoder/qoderclicn");
});

// ---- REQ-v0.8.2-2026-09-20-01 · M1（协议面增补）：model 走桥 `--model` ⇒ ACP set_config_option ----
// ---- REQ-v0.8.4-2026-09-20-01 · M3 翻向：读点 = 顶层平铺 agentConfig.model，段内 model = 遗留键 ----

/** ACP 族未配 model 时的桥侧参数基线（args[0]=桥入口绝对路径，运行环境相关，单列剔除）。 */
const QODER_NO_MODEL_BASELINE = [
  "--port",
  "4100",
  "--workspace",
  "/ws/p1",
  "--project-id",
  "p1",
  "--backend-cmd",
  "qoderclicn",
];

function qoderBridgeArgs(agentConfig: Record<string, unknown> | undefined): string[] {
  const spec = getAdapter("qoder").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig,
  });
  return spec.args.slice(1);
}

test("qoder 平铺 model 已配 ⇒ 下发 --model，值逐字 = 配置值（不再拼后端 argv）", () => {
  assert.deepEqual(qoderBridgeArgs({ backendCmd: "qoderclicn", model: "provider/model-x" }), [
    ...QODER_NO_MODEL_BASELINE,
    "--model",
    "provider/model-x",
  ]);
});

test("qoder 平铺 model 已配 + permissionArgs：--model 在 --backend-cmd 后、--risk 前", () => {
  const spec = getAdapter("qoder").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: "qoderclicn", model: "m1" },
    permissionArgs: getAdapter("qoder").permission("read").args,
  });
  assert.deepEqual(spec.args.slice(1), [
    ...QODER_NO_MODEL_BASELINE,
    "--model",
    "m1",
    "--risk",
    "read",
  ]);
});

test("qoder model 未配 ⇒ 不下发 --model / --backend-args（argv 逐字 = 基线，桥不发 set）", () => {
  const args = qoderBridgeArgs({ backendCmd: "qoderclicn" });
  assert.deepEqual(args, QODER_NO_MODEL_BASELINE);
  assert.ok(!args.includes("--model"));
  assert.ok(!args.includes("--backend-args"));
});

test("qoder 平铺 model 非法值（缺键 / 空串 / 非字符串）⇒ 与未配置同路径逐字一致", () => {
  const invalidCases: Record<string, Record<string, unknown>> = {
    缺键: { backendCmd: "qoderclicn" },
    空串: { backendCmd: "qoderclicn", model: "" },
    数字: { backendCmd: "qoderclicn", model: 42 },
    null: { backendCmd: "qoderclicn", model: null },
  };
  for (const [name, agentConfig] of Object.entries(invalidCases)) {
    assert.deepEqual(qoderBridgeArgs(agentConfig), QODER_NO_MODEL_BASELINE, `非法值「${name}」应走未配置路径`);
  }
});

test("qoder 遗留段内 model（v0.8.4 翻向）⇒ 不生效：argv 逐字 = 未配置基线", () => {
  assert.deepEqual(
    qoderBridgeArgs({ backendCmd: "qoderclicn", qoder: { model: "provider/model-x" } }),
    QODER_NO_MODEL_BASELINE,
  );
});

test("qoder 旧 -m argv 拼装已撤除（model 唯一通道 = 协议面 set）", () => {
  const args = qoderBridgeArgs({ backendCmd: "qoderclicn", model: "provider/model-x" });
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
  "opencode.exe",
  "--backend-args",
  '["acp"]',
];

function opencodeBridgeArgs(agentConfig: Record<string, unknown>): string[] {
  return getAdapter("opencode")
    .buildLaunch({ projectId: "p1", workspace: "/ws/p1", a2aPort: 4100, agentConfig })
    .args.slice(1);
}

test("opencode 平铺 model 已配 ⇒ 下发 --model（协议面通路对两家同方言启用）", () => {
  assert.deepEqual(
    opencodeBridgeArgs({ backendCmd: "opencode.exe", model: "provider/model-x" }),
    [...OPENCODE_NO_MODEL_BASELINE, "--model", "provider/model-x"],
  );
});

test("opencode 平铺 model 已配 + permissionArgs：--model 在 --backend-args 后、--risk 前", () => {
  const spec = getAdapter("opencode").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: "opencode.exe", model: "m1" },
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
    opencodeBridgeArgs({ backendCmd: "opencode.exe", opencode: { model: "provider/model-x" } }),
    OPENCODE_NO_MODEL_BASELINE,
  );
});

test('opencode 平铺 model 未配 / 非法 ⇒ argv 逐字 = 基线（后端 argv 恒 ["acp"]，不含 --model）', () => {
  const cases: Record<string, Record<string, unknown>> = {
    未配: { backendCmd: "opencode.exe" },
    空串: { backendCmd: "opencode.exe", model: "" },
    数字: { backendCmd: "opencode.exe", model: 7 },
    非字符串: { backendCmd: "opencode.exe", model: null },
  };
  for (const [name, agentConfig] of Object.entries(cases)) {
    assert.deepEqual(opencodeBridgeArgs(agentConfig), OPENCODE_NO_MODEL_BASELINE, `「${name}」应走未配置路径`);
  }
});

// ---------- REQ-v0.8.4-2026-09-20-01 · M3：遗留键告警锚（段内 model ⇒ ACP 族告警 / wrapper 族不告警）----------

test("遗留键告警（manager.start）：ACP 族段内 model ⇒ 启动告警一次；无段内 model ⇒ 无告警", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "a2a-machine-legacy-"));
  const originalWarn = console.warn;
  // 后端命令取必然不存在的绝对路径：桥进程快速失败退出 ⇒ 拉起不依赖本机环境
  const bogusBackend = join(tmpdir(), "a2a-machine-legacy-nonexistent-backend.exe");
  const mkConfig = (agentConfig: Record<string, unknown>): MachineConfig => ({
    machineId: "m-test",
    launcher: { port: 3199 },
    projects: [
      { projectId: "p-legacy", workspace, agentKind: "qoder", a2aPort: 4199, agentConfig },
    ],
  });
  const warnings: string[] = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const manager = new AgentManager(mkConfig({ backendCmd: bogusBackend, qoder: { model: "legacy-m" } }));
    try {
      // 拉起成败与告警无关（告警在 spawn 之前）；两种收敛都接受
      await manager.ensure("p-legacy").catch(() => undefined);
    } finally {
      await manager.stop("p-legacy").catch(() => undefined);
    }
    assert.equal(
      warnings.filter((w) => w.includes("遗留键告警")).length,
      1,
      "ACP 族段内 model 应触发恰好一次遗留键告警",
    );
    const warning = warnings.find((w) => w.includes("遗留键告警")) ?? "";
    assert.match(warning, /agentConfig\.qoder\.model 已废弃/);
    assert.match(warning, /顶层平铺键 agentConfig\.model/);
    assert.match(warning, /本键不生效/);

    warnings.length = 0;
    const clean = new AgentManager(mkConfig({ backendCmd: bogusBackend, model: "flat-m" }));
    try {
      await clean.ensure("p-legacy").catch(() => undefined);
    } finally {
      await clean.stop("p-legacy").catch(() => undefined);
    }
    assert.equal(
      warnings.filter((w) => w.includes("遗留键告警")).length,
      0,
      "平铺 model（合法键）不得告警",
    );
  } finally {
    console.warn = originalWarn;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("遗留键不生效（谓词口径，与 manager.start 告警同源）：ACP 族 adapter 不消费段内 model", () => {
  assert.ok(
    !qoderBridgeArgs({ backendCmd: "qoderclicn", qoder: { model: "legacy-m" } }).includes("--model"),
  );
  assert.ok(
    !opencodeBridgeArgs({ backendCmd: "opencode.exe", opencode: { model: "legacy-m" } }).includes(
      "--model",
    ),
  );
  // 平铺 + 段内并存 ⇒ 只透传平铺值（段内不掺入、不双读）
  assert.deepEqual(
    qoderBridgeArgs({ backendCmd: "qoderclicn", model: "flat-m", qoder: { model: "legacy-m" } }),
    [...QODER_NO_MODEL_BASELINE, "--model", "flat-m"],
  );
});

test("wrapper 族（codex/claude）段内 model = 外部契约 ⇒ 不告警、不生效（adapter 不消费）", () => {
  for (const kind of ["codex", "claude"] as const) {
    const spec = getAdapter(kind).buildLaunch({
      projectId: "p1",
      workspace: "/ws/p1",
      a2aPort: 4100,
      configPath: `/cfg/${kind}.p1.json`,
      agentConfig: { [kind]: { model: "seg-model" } },
    });
    assert.ok(!spec.args.includes("--model"), `${kind}：adapter 不得消费段内 model`);
  }
  // 告警门控源码锚：manager.start 的遗留键告警分支只挂 ACP 族 ⇒ wrapper 族恒不进告警路径
  const managerSrc = readFileSync(
    join(appRootFromModule(import.meta.url), "launcher", "manager.ts"),
    "utf8",
  );
  assert.ok(
    managerSrc.includes('project.agentKind === "qoder" || project.agentKind === "opencode"'),
    "遗留键告警门控必须限定 ACP 族",
  );
  assert.ok(
    !/agentKind === "codex"[\s\S]{0,200}遗留键告警/.test(managerSrc),
    "wrapper 族不得进入遗留键告警路径",
  );
});

test("qoder buildLaunch：无 agentConfig ⇒ 抛错且信息含 backendCmd", () => {
  const minimal: LaunchRequest = { projectId: "p1", workspace: "/ws/p1", a2aPort: 4100 };
  assert.throws(() => getAdapter("qoder").buildLaunch(minimal), /backendCmd/);
});

test("qoder buildLaunch：agentConfig 缺 backendCmd（缺键 / 空串）⇒ 抛错", () => {
  const missing: LaunchRequest = {
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { systemPromptAppend: "x" },
  };
  const empty: LaunchRequest = {
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: "" },
  };
  assert.throws(() => getAdapter("qoder").buildLaunch(missing), /backendCmd/);
  assert.throws(() => getAdapter("qoder").buildLaunch(empty), /backendCmd/);
});

// ---------- v0.8.1 M4：opencode 迁 ACP 桥（与 qoder 同构，差异 = --backend-args + 配置面） ----------

test("opencode buildLaunch（ACP 族）逐字锁定：桥进程 + --backend-args [\"acp\"] + --risk + --config-file/segment", () => {
  const spec = getAdapter("opencode").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    configPath: "/cfg/opencode.p1.json",
    permissionArgs: getAdapter("opencode").permission("write").args,
    agentConfig: { backendCmd: "C:/npm/opencode.exe" },
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
    "C:/npm/opencode.exe",
    "--backend-args",
    '["acp"]',
    "--risk",
    "write",
    "--config-file",
    "/cfg/opencode.p1.json",
    "--config-segment",
    "opencode",
  ]);
});

test("opencode buildLaunch：无 configPath ⇒ 不注入 --config-file/--config-segment（桥配置取空）", () => {
  const spec = getAdapter("opencode").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: "opencode" },
  });
  assert.ok(!spec.args.includes("--config-file"));
  assert.ok(!spec.args.includes("--config-segment"));
  assert.deepEqual(spec.args.slice(-2), ["--backend-args", '["acp"]']);
});

test("opencode permission 三档映射：read/write/full → --risk <档>（替代旧 --auto-approve 二值）", () => {
  assert.deepEqual(getAdapter("opencode").permission("read"), { args: ["--risk", "read"] });
  assert.deepEqual(getAdapter("opencode").permission("write"), { args: ["--risk", "write"] });
  assert.deepEqual(getAdapter("opencode").permission("full"), { args: ["--risk", "full"] });
});

test("opencode buildLaunch：backendCmd 必填零硬编码，缺省 ⇒ 抛错且提示 Windows 须 .exe 绝对路径", () => {
  const minimal: LaunchRequest = { projectId: "p1", workspace: "/ws/p1", a2aPort: 4100 };
  assert.throws(() => getAdapter("opencode").buildLaunch(minimal), /backendCmd/);
  assert.throws(
    () => getAdapter("opencode").buildLaunch({ ...minimal, agentConfig: { backendCmd: "" } }),
    /backendCmd/,
  );
  assert.throws(
    () => getAdapter("opencode").buildLaunch(minimal),
    /Windows.*\.exe|\.exe.*绝对路径/,
  );
});
