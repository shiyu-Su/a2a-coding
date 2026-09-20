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
import { join } from "node:path";
import { AGENT_KINDS } from "../agent-kinds.js";
import { getAdapter, wrapperConfigPath } from "../adapters/index.js";
import { A2A_OUTCOME_CONVENTION } from "../launcher/agent-config.js";
import type { LaunchRequest } from "../adapters/types.js";

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
