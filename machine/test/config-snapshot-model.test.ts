/**
 * 播报面 model 读点单测（REQ-v0.8.4-2026-09-20-01 · 增补轨）。
 *
 * 锁 `launcher/config-snapshot.ts` 三条分支（与 M1 `agent-config.ts` 生效读点同键位口径）：
 * - ACP 族（qoder / opencode）：读**顶层平铺** `agentConfig.model`；
 * - wrapper 族（claude / codex）：读**段内** `agentConfig.<kind>.model`，平铺 `model` 不生效；
 * - 未配：落各 kind「未指定」兜底口径。
 *
 * 直调纯函数 `resolveModelEndpoint` / `describeAgentConfig`，不起进程。
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeAgentConfig, resolveModelEndpoint } from "../launcher/config-snapshot.js";
import type { ProjectConfig } from "../types.js";

function project(
  agentKind: ProjectConfig["agentKind"],
  agentConfig?: Record<string, unknown>,
): ProjectConfig {
  return { projectId: "p1", workspace: "/ws/p1", agentKind, a2aPort: 4100, agentConfig };
}

/**
 * claude / codex 分支读 env（ANTHROPIC_MODEL / ANTHROPIC_BASE_URL / OPENAI_BASE_URL）作次级
 * 回退；本机 env 若恰好配置会污染「未指定」断言，测试期间统一清空、结束后还原。
 */
const ENV_KEYS = ["ANTHROPIC_MODEL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"] as const;

function withScrubbedEnv<T>(fn: () => T): T {
  const saved = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, process.env[k]] as const),
  );
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---- 分支 1：ACP 族读平铺 ----

test("ACP 族平铺命中：qoder / opencode 播报取 agentConfig.model（标注 agentConfig）", () => {
  for (const kind of ["qoder", "opencode"] as const) {
    const { model, endpoint } = resolveModelEndpoint(
      project(kind, { backendCmd: "x", model: "m-flat" }),
      true,
    );
    assert.equal(model, "m-flat（agentConfig）", `${kind}：平铺 model 应为播报读点`);
    assert.notEqual(endpoint, "");
  }
  assert.equal(
    resolveModelEndpoint(project("qoder", { model: "m-flat" }), true).endpoint,
    "qoder CN 服务端（经 ACP 桥）",
  );
  assert.equal(
    resolveModelEndpoint(project("opencode", { model: "m-flat" }), true).endpoint,
    "opencode provider 配置",
  );
});

test("ACP 族负向锚：段内 model 不影响播报，未配平铺即落兜底", () => {
  for (const kind of ["qoder", "opencode"] as const) {
    const { model } = resolveModelEndpoint(
      project(kind, { [kind]: { model: "m-section" } }),
      true,
    );
    assert.notEqual(model, "m-section（agentConfig）", `${kind}：段内 model 不得被播报消费`);
    assert.match(model, /配置（ACP）$|^opencode 配置$/, `${kind}：未配平铺应落「未指定」兜底`);
  }
});

// ---- 分支 2：wrapper 族读段内，平铺不生效 ----

test("wrapper 族段读：claude / codex 播报取 agentConfig.<kind>.model", () => {
  withScrubbedEnv(() => {
    assert.equal(
      resolveModelEndpoint(project("claude", { claude: { model: "m-claude" } }), true).model,
      "m-claude（agentConfig）",
    );
    assert.equal(
      resolveModelEndpoint(project("codex", { codex: { model: "m-codex" } }), true).model,
      "m-codex（agentConfig）",
    );
  });
});

test("wrapper 族负向锚：同项目外层平铺 model 对播报不生效（段读优先且唯一）", () => {
  withScrubbedEnv(() => {
    const claude = resolveModelEndpoint(
      project("claude", { model: "m-flat", claude: { model: "m-claude" } }),
      true,
    );
    assert.equal(claude.model, "m-claude（agentConfig）");
    assert.doesNotMatch(claude.model, /m-flat/);

    const codex = resolveModelEndpoint(
      project("codex", { model: "m-flat", codex: { model: "m-codex" } }),
      true,
    );
    assert.equal(codex.model, "m-codex（agentConfig）");
    assert.doesNotMatch(codex.model, /m-flat/);

    // 仅平铺、段内无 model → 平铺不被读，落未配置兜底
    assert.equal(
      resolveModelEndpoint(project("claude", { model: "m-flat" }), false).model,
      "未指定（CLI 默认）",
    );
    assert.equal(
      resolveModelEndpoint(project("codex", { model: "m-flat" }), true).model,
      "~/.codex/config.toml",
    );
  });
});

// ---- 分支 3：未配 → 「未指定」口径 ----

test("未配置兜底：四 kind 既无平铺也无段内 model 时按现实现口径播报", () => {
  withScrubbedEnv(() => {
    assert.equal(resolveModelEndpoint(project("claude", {}), false).model, "未指定（CLI 默认）");
    assert.equal(resolveModelEndpoint(project("claude"), false).model, "未指定（CLI 默认）");
    assert.equal(resolveModelEndpoint(project("codex", {}), true).model, "~/.codex/config.toml");
    assert.equal(resolveModelEndpoint(project("opencode", {}), true).model, "opencode 配置");
    assert.equal(resolveModelEndpoint(project("qoder", {}), true).model, "qodercn 配置（ACP）");
  });
});

test("非法平铺值（空串 / 非字符串）视同未配，落兜底", () => {
  for (const bad of ["", 42, null, undefined]) {
    assert.equal(
      resolveModelEndpoint(project("qoder", { model: bad }), true).model,
      "qodercn 配置（ACP）",
      `平铺 model=${JSON.stringify(bad)} 不应被播报`,
    );
  }
});

// ---- describeAgentConfig 汇总面（hierarchy + model + endpoint 同快照）----

test("describeAgentConfig：ACP 族快照透传平铺 model 读点", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "a2a-machine-snap-"));
  try {
    const configPath = join(appRoot, "agents", "qoder.p1.json");
    const snapshot = describeAgentConfig(project("qoder", { model: "m-flat" }), configPath);
    assert.equal(snapshot.model, "m-flat（agentConfig）");
    assert.equal(snapshot.endpoint, "qoder CN 服务端（经 ACP 桥）");
    assert.match(snapshot.hierarchy, /项目 agentConfig/);
    assert.match(snapshot.hierarchy, /qodercn 用户级配置/);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});
