/**
 * v0.8.5（REQ-v0.8.5-2026-09-21-01 · M2 codex / M3 claude）：**wrapper 族两家断言由 wrapper 翻向 ACP**
 * （`protocol:"acp"` / 拉桥进程 / `--risk`+`--mode` 三档 / 平铺 model / 段与配置通道（M4）退役；
 * M3 另含 claude full 档 `--session-meta-json`）。播报面归 M6、**全量全绿归 M7**。
 * 锁 ACP 族（opencode / qoder / codex / claude）的 `buildLaunch` 命令与参数形状、
 * `permission` 三档映射**逐字**断言；并锁协议维度与 backendCmd 必填抛错。
 * `getAdapter` 四家可达、恰 4 个不同实例。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_KINDS } from "../agent-kinds.js";
import { getAdapter } from "../adapters/index.js";

import { appRootFromModule } from "../launcher/app-root.js";
import { resolveBackendSpawn, SCRIPT_BACKEND_EXTS } from "../adapters/backend-command.js";

import type { LaunchRequest } from "../adapters/types.js";


/** codex ACP 后端命令样例 = **适配器入口脚本路径**（v0.8.5 · M8 形态归一：`.js` ⇒ 适配器自动以 node 拉起）。 */
const CODEX_BACKEND_CMD_SAMPLE = "C:/npm/@agentclientprotocol/codex-acp/dist/index.js";

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

test("协议维度：opencode/qoder/claude = \"acp\"（v0.8.5 M3 claude 迁桥）", () => {
  for (const kind of ["opencode", "qoder", "claude"] as const) {
    assert.equal(getAdapter(kind).protocol, "acp");
  }
});

test("协议维度：codex = \"acp\"（v0.8.5 M2 codex 迁桥）", () => {
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
    agentConfig: { backendCmd: "node", model: "sonnet" },
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
    "node",
    "--backend-args",
    "[]",
    "--model",
    "sonnet",
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
    agentConfig: { backendCmd: "node" },
  });
  assert.ok(!spec.args.includes("--config"));
  assert.ok(!spec.args.includes("--config-file"));
  assert.ok(!spec.args.includes("--config-segment"));
});

test("claude buildLaunch：无 agentConfig ⇒ 抛错且信息含 backendCmd（ACP 族必填）", () => {
  const minimal: LaunchRequest = { projectId: "p1", workspace: "/ws/p1", a2aPort: 4100 };
  assert.throws(() => getAdapter("claude").buildLaunch(minimal), /backendCmd/);
});

test("claude buildLaunch：未配平铺 model ⇒ argv 无 --model（零回退）", () => {
  const spec = getAdapter("claude").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: "node" },
  });
  assert.ok(!spec.args.includes("--model"));
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
    agentConfig: { backendCmd: "node", claude: { model: "seg-model" } },
  });
  assert.ok(!only.args.includes("--model"), "claude：adapter 不得消费段内 model（只读平铺）");
  // 平铺 + 段内并存 ⇒ 只透传平铺值
  const both = getAdapter("claude").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: "node", model: "flat-m", claude: { model: "seg-model" } },
  });
  assert.equal(both.args[both.args.indexOf("--model") + 1], "flat-m");
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

test("opencode buildLaunch（ACP 族）逐字锁定：桥进程 + --backend-args [\"acp\"] + --risk（--config-file/segment 已退役）", () => {
  const spec = getAdapter("opencode").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
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
  ]);
});

test("opencode buildLaunch：无平铺 systemPrompt ⇒ 不注入 --system-prompt（桥缺省注入）", () => {
  const spec = getAdapter("opencode").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: "opencode" },
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

// ---------- v0.8.5-2026-09-21-01 · M2：codex 迁 ACP 桥（wrapper → acp） ----------

test("codex buildLaunch（ACP 族）：脚本入口形态 --backend-args [<入口>]（无 kind 级子命令）", () => {
  assert.deepEqual(codexBridgeArgs({ backendCmd: CODEX_BACKEND_CMD_SAMPLE }), CODEX_NO_MODEL_BASELINE);
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
    assert.deepEqual(codexBridgeArgs(agentConfig), CODEX_NO_MODEL_BASELINE, `「${name}」应走未配置路径`);
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

test("codex buildLaunch：backendCmd 必填零硬编码（缺键 / 空串 ⇒ 抛错，文案指适配器 dist/index.js 入口）", () => {
  const minimal: LaunchRequest = { projectId: "p1", workspace: "/ws/p1", a2aPort: 4100 };
  assert.throws(() => getAdapter("codex").buildLaunch(minimal), /backendCmd/);
  assert.throws(() => getAdapter("codex").buildLaunch(minimal), /dist\/index\.js/);
  assert.throws(
    () => getAdapter("codex").buildLaunch({ ...minimal, agentConfig: { backendCmd: "" } }),
    /backendCmd/,
  );
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
  const script = "C:/npm/@agentclientprotocol/codex-acp/dist/index.js";
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
  const exe = "C:/npm/opencode.exe";
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

/** claude 未配 model 时的桥侧参数基线（`backendCmd:"node"` ⇒ 可执行体形态，`--backend-args '[]'`）。 */
const CLAUDE_BASELINE_N1 = [
  "--port",
  "4100",
  "--workspace",
  "/ws/p1",
  "--project-id",
  "p1",
  "--backend-cmd",
  "node",
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
    assert.deepEqual(codexBridgeArgs(agentConfig), CODEX_NO_MODEL_BASELINE, `「${name}」应走未配置路径`);
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
  assert.deepEqual(claudeBridgeArgsN1({ backendCmd: "node", systemPrompt: "be terse" }), [
    ...CLAUDE_BASELINE_N1,
    "--system-prompt",
    "be terse",
  ]);
  const unset = claudeBridgeArgsN1({ backendCmd: "node" });
  assert.deepEqual(unset, CLAUDE_BASELINE_N1);
  assert.ok(!unset.includes("--system-prompt"));
  assert.ok(!unset.includes("--system-prompt-mode"));
  assert.ok(!unset.includes("--model"), "负向锚保留：未配 model ⇒ 无 --model");
});

test("claude 平铺 systemPromptMode 已配 ⇒ 下发 --system-prompt-mode；非法 ⇒ 不下发（只留 systemPrompt）", () => {
  assert.deepEqual(
    claudeBridgeArgsN1({ backendCmd: "node", systemPrompt: "sp", systemPromptMode: "replace" }),
    [...CLAUDE_BASELINE_N1, "--system-prompt", "sp", "--system-prompt-mode", "replace"],
  );
  assert.deepEqual(
    claudeBridgeArgsN1({ backendCmd: "node", systemPrompt: "sp", systemPromptMode: "bogus" }),
    [...CLAUDE_BASELINE_N1, "--system-prompt", "sp"],
  );
});

test("claude systemPrompt 与 --backend-args / permissionArgs（full 档）共存互不覆盖", () => {
  const spec = getAdapter("claude").buildLaunch({
    projectId: "p1",
    workspace: "/ws/p1",
    a2aPort: 4100,
    agentConfig: { backendCmd: "node", systemPrompt: "sp" },
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

test("平铺 systemPrompt(Mode) 读点 = 4 家（opencode/qoder/codex/claude）且与 backend-args 形态解析无耦合（N1 接线锚）", () => {
  const root = appRootFromModule(import.meta.url);
  for (const kind of ["opencode", "qoder", "codex", "claude"]) {
    const src = readFileSync(join(root, "adapters", `${kind}.ts`), "utf8");
    assert.ok(src.includes("resolveSystemPrompt(request.agentConfig)"), `${kind} 应读平铺 systemPrompt`);
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
