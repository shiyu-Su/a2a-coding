/**
 * 播报面 model 读点单测（REQ-v0.8.5-2026-09-21-01 · M6 语义级重写）。
 *
 * 锁 `launcher/config-snapshot.ts` 在「`agentConfig.<kind>` 段与 wrapper 配置通道退役」
 * 后的四条口径：
 * - **四 kind 统一读顶层平铺** `agentConfig.model`；段内 `agentConfig.<kind>.model`
 *   随段退役、不再被播报消费（负向锚）；
 * - **claude 直读** `~/.claude/settings.json`：「**存在** / **不存在**」两分支的播报输出
 *   各有断言（借 `HOME` / `USERPROFILE` 把用户目录重定向到临时目录，**不碰真实用户配置**）；
 * - 未配平铺 model 时四 kind 的兜底口径；
 * - `config/model-catalog.json` JSON 合法、codex / claude 两段与既有段同形、键集齐备。
 *
 * 直调纯函数 `resolveModelEndpoint` / `describeAgentConfig`，不起进程。
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeAgentConfig, resolveModelEndpoint } from "../launcher/config-snapshot.js";
import type { BackendEntryDeps } from "../adapters/backend-entry.js";
import type { ProjectConfig } from "../types.js";

const KINDS = ["claude", "codex", "opencode", "qoder-cn"] as const;

/** 四 kind 未配平铺 `model` 时的兜底口径（与实现逐字一致的可判据点） */
const FALLBACK_MODEL: Record<ProjectConfig["agentKind"], string> = {
  claude: "未指定（CLI 默认）",
  codex: "~/.codex/config.toml",
  opencode: "opencode 配置",
  "qoder-cn": "qodercn 配置（ACP）",
};

function project(
  agentKind: ProjectConfig["agentKind"],
  agentConfig?: Record<string, unknown>,
): ProjectConfig {
  return { projectId: "p1", workspace: "/ws/p1", agentKind, a2aPort: 4100, agentConfig };
}

/**
 * claude 分支读 env（ANTHROPIC_MODEL / ANTHROPIC_BASE_URL / OPENAI_BASE_URL）与
 * `~/.claude/settings.json` 作次级回退；本机 env / 用户配置若恰好存在会污染「未指定」
 * 断言，测试期间统一隔离、结束后还原。
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

/**
 * 把 `os.homedir()` 指向新建的空临时目录：默认覆盖「`~/.claude/settings.json` 不存在」
 * 分支；回调内可再写入该文件以覆盖「存在」分支。结束后还原 `HOME` / `USERPROFILE`
 * 并删除临时目录 —— **真实用户配置全程只读**（本节点纪律）。
 */
function withFakeHome<T>(fn: (home: string) => T): T {
  const savedHome = process.env["HOME"];
  const savedProfile = process.env["USERPROFILE"];
  const home = mkdtempSync(join(tmpdir(), "a2a-machine-home-"));
  try {
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    return fn(home);
  } finally {
    restoreEnv("HOME", savedHome);
    restoreEnv("USERPROFILE", savedProfile);
    rmSync(home, { recursive: true, force: true });
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** 在临时 home 下写 claude 用户级配置（只写临时目录，绝不触碰真实 `~/.claude`） */
function writeClaudeSettings(home: string, content: unknown): string {
  const dir = join(home, ".claude");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify(content, null, 2), "utf8");
  return file;
}

// ---- 分支 1：四 kind 统一读平铺 ----

test("平铺命中：四 kind 均取 agentConfig.model（标注 agentConfig）", () => {
  withScrubbedEnv(() =>
    withFakeHome(() => {
      for (const kind of KINDS) {
        const { model } = resolveModelEndpoint(project(kind, { model: "m-flat" }));
        assert.equal(model, "m-flat（agentConfig）", `${kind}：平铺 model 应为播报读点`);
      }
      assert.equal(
        resolveModelEndpoint(project("qoder-cn", { model: "m-flat" })).endpoint,
        "qoder CN 服务端（经 ACP 桥）",
      );
      assert.equal(
        resolveModelEndpoint(project("opencode", { model: "m-flat" })).endpoint,
        "opencode provider 配置",
      );
      assert.equal(
        resolveModelEndpoint(project("codex", { model: "m-flat" })).endpoint,
        "~/.codex/config.toml provider",
      );
      assert.equal(
        resolveModelEndpoint(project("claude", { model: "m-flat" })).endpoint,
        "默认官方 API",
      );
    }),
  );
});

test("负向锚：段内 agentConfig.<kind>.model 随段退役，不被播报消费", () => {
  withScrubbedEnv(() =>
    withFakeHome(() => {
      for (const kind of KINDS) {
        const { model } = resolveModelEndpoint(project(kind, { [kind]: { model: "m-section" } }));
        assert.equal(model, FALLBACK_MODEL[kind], `${kind}：段内 model 不得被播报消费`);
      }
    }),
  );
});

// ---- 分支 2：未配平铺 → 各 kind 兜底口径 ----

test("未配兜底：四 kind 无平铺 model ⇒ 各自兜底口径", () => {
  withScrubbedEnv(() =>
    withFakeHome(() => {
      for (const kind of KINDS) {
        assert.equal(
          resolveModelEndpoint(project(kind)).model,
          FALLBACK_MODEL[kind],
          `${kind}：agentConfig 缺省时的兜底`,
        );
        assert.equal(
          resolveModelEndpoint(project(kind, {})).model,
          FALLBACK_MODEL[kind],
          `${kind}：空 agentConfig 时的兜底`,
        );
      }
    }),
  );
});

test("非法平铺值（空串 / 非字符串 / 非法容器）视同未配，落兜底", () => {
  withScrubbedEnv(() =>
    withFakeHome(() => {
      for (const bad of ["", 42, null, undefined, {}, []]) {
        assert.equal(
          resolveModelEndpoint(project("qoder-cn", { model: bad })).model,
          "qodercn 配置（ACP）",
          `平铺 model=${JSON.stringify(bad)} 不应被播报`,
        );
        assert.equal(
          resolveModelEndpoint(project("codex", { model: bad })).model,
          "~/.codex/config.toml",
        );
      }
    }),
  );
});

// ---- 分支 3：claude 直读 ~/.claude/settings.json（两分支都要有断言）----

test("claude 用户级层 · 不存在分支：settings.json 缺 ⇒ 播报 n/a，值不参与解析", () => {
  withScrubbedEnv(() =>
    withFakeHome((home) => {
      // backendCmd 给沙箱内真文件（L0 契约 = 存在且是文件）；本例只测 model 播报面，不碰 backend 段
      const entryFile = join(home, "fake-acp-entry.js");
      writeFileSync(entryFile, "", "utf8");
      const snapshot = describeAgentConfig(project("claude", { backendCmd: entryFile }));
      assert.match(
        snapshot.hierarchy,
        /^项目 agentConfig（平铺键）\+ /,
        "层级首项 = 平铺 agentConfig",
      );
      assert.match(
        snapshot.hierarchy,
        /claude 用户级配置 n\/a（.*settings\.json 不存在）/,
        "缺文件 ⇒ 用户级层播报 n/a",
      );
      assert.ok(
        snapshot.hierarchy.includes(join(home, ".claude", "settings.json")),
        `n/a 文案应带被判定的路径：${snapshot.hierarchy}`,
      );
      assert.equal(snapshot.model, "未指定（CLI 默认）");
      assert.equal(snapshot.endpoint, "默认官方 API");
    }),
  );
});

test("claude 用户级层 · 存在分支：settings.json 在 ⇒ 播报路径 + settings 值参与解析", () => {
  withScrubbedEnv(() =>
    withFakeHome((home) => {
      const settingsPath = writeClaudeSettings(home, {
        model: "m-settings",
        env: { ANTHROPIC_BASE_URL: "https://settings.example/v1" },
      });

      const snapshot = describeAgentConfig(project("claude"));
      assert.ok(
        snapshot.hierarchy.includes(settingsPath),
        `存在 ⇒ 播报用户级配置路径：${snapshot.hierarchy}`,
      );
      assert.doesNotMatch(snapshot.hierarchy, /n\/a/, "存在时不得播报 n/a");
      assert.equal(snapshot.model, "m-settings（settings）", "缺平铺时回退命中 settings.model");
      assert.equal(snapshot.endpoint, "https://settings.example/v1（settings）");

      // 直读不等于覆盖：平铺 agentConfig 优先级仍最高
      assert.equal(
        describeAgentConfig(project("claude", { model: "m-flat" })).model,
        "m-flat（agentConfig）",
      );

      // 既有优先级（env > settings）不变：两值不同 ⇒ 「并存」文案
      process.env["ANTHROPIC_BASE_URL"] = "https://env.example/v1";
      assert.equal(
        describeAgentConfig(project("claude")).endpoint,
        "https://env.example/v1（env）/ https://settings.example/v1（settings）并存",
      );
    }),
  );
});

// ---- describeAgentConfig 汇总面（hierarchy + model + endpoint 同快照）----

test("describeAgentConfig：四 kind 层级与模型 / endpoint 同快照（无 configPath 入参）", () => {
  withScrubbedEnv(() =>
    withFakeHome(() => {
      const expectedLayer: Record<ProjectConfig["agentKind"], RegExp> = {
        claude: /claude 用户级配置 n\/a（.*不存在）/,
        codex: /codex 用户级配置（~\/\.codex\/config\.toml，运行时始终读取）/,
        opencode: /opencode 用户级配置（全局配置与 workspace opencode\.json，运行时读取）/,
        "qoder-cn": /qodercn 用户级配置（~\/\.qoder-cn\/，经 ACP 桥运行时读取）/,
      };
      for (const kind of KINDS) {
        const snapshot = describeAgentConfig(project(kind, { model: "m-flat" }));
        assert.match(snapshot.hierarchy, /^项目 agentConfig（平铺键）\+ /, `${kind}：层级首项`);
        assert.match(snapshot.hierarchy, expectedLayer[kind], `${kind}：用户级配置层`);
        assert.equal(snapshot.model, "m-flat（agentConfig）", `${kind}：快照模型`);
        assert.notEqual(snapshot.endpoint, "", `${kind}：endpoint 不得为空`);
      }
    }),
  );
});

// ---- backend 段：分层解析日志正文（§2.3 · B4，注入 deps 造命中 / 全 miss 两例）----

/** codex 在 L2 全局 npm 根命中：L1 机器本地空、L2 有包、L0 未显式配。 */
const codexHitDeps: BackendEntryDeps = {
  platform: "win32",
  env: {},
  machineModulesRoot: "C:/machine-empty",
  npmRoots: ["C:/npm-global"],
  isFile: (p) => p.includes("npm-global"),
  readJson: () => ({ bin: { "codex-acp": "dist/index.js" } }),
};

test("backend 段 · 命中：kind + 命中层名 + 绝对路径", () => {
  const snapshot = describeAgentConfig(project("codex"), codexHitDeps);
  assert.match(
    snapshot.backend,
    /^p1 kind=codex L2-npm-global hit C:[/\\]npm-global[/\\]/,
    `命中形态异常：${snapshot.backend}`,
  );
  assert.doesNotMatch(snapshot.backend, /逐层清单/, "命中不得输出失败清单");
});

/** 四层全 miss：机器本地空、全局根无包、PATH 空目录 ⇒ 完整分层清单入日志。 */
const allMissDeps: BackendEntryDeps = {
  platform: "win32",
  env: {},
  machineModulesRoot: "C:/machine-empty",
  npmRoots: ["C:/npm-empty"],
  isFile: () => false,
  readJson: () => ({}),
};

test("backend 段 · 未命中：解析失败 + 逐层清单（含各层与 outcome）", () => {
  const snapshot = describeAgentConfig(project("codex"), allMissDeps);
  assert.match(snapshot.backend, /^p1 解析失败，逐层清单：/, `失败形态异常：${snapshot.backend}`);
  assert.match(snapshot.backend, /L0-explicit=miss/);
  assert.match(snapshot.backend, /L1-local=miss/);
  assert.match(snapshot.backend, /L2-npm-global=miss/);
  assert.match(snapshot.backend, /L3-path=miss/);
});

test("backend 段 · L0 显式 backendCmd 命中即停（不扫后续层）", () => {
  // L0 存在性门（REQ-v0.8.6-2026-09-21-02 真机补正①）：显式值必须「存在且是文件」才 hit
  // ⇒ 本例 isFile 只放行显式路径，其余层仍全空 ⇒ 「命中即停」由「无后续层被扫描」佐证。
  const l0HitDeps: BackendEntryDeps = {
    ...allMissDeps,
    isFile: (p) => p === "D:/mine.cmd",
  };
  const snapshot = describeAgentConfig(project("codex", { backendCmd: "D:/mine.cmd" }), l0HitDeps);
  assert.equal(snapshot.backend, "p1 kind=codex L0-explicit hit D:/mine.cmd");
});

test("backend 段 · L0 显式路径不存在 ⇒ rejected-missing 且不回落（下层备好可命中素材）", () => {
  const l0RejectDeps: BackendEntryDeps = {
    platform: "win32",
    env: {},
    machineModulesRoot: "C:/machine-empty",
    npmRoots: ["C:/npm-global"],
    isFile: (p) => p.includes("npm-global"),
    readJson: () => ({ bin: { "codex-acp": "dist/index.js" } }),
  };
  const snapshot = describeAgentConfig(project("codex", { backendCmd: "D:/mine.cmd" }), l0RejectDeps);
  assert.match(snapshot.backend, /^p1 解析失败，逐层清单：L0-explicit=rejected-missing\(D:\/mine\.cmd\)/);
  assert.doesNotMatch(snapshot.backend, /L1-local|L2-npm-global|L3-path/, "显式被拒 ⇒ 不扫后续层、不静默回落");
});

const CATALOG_URL = new URL("../../config/model-catalog.json", import.meta.url);

test("model-catalog：JSON 合法，codex / claude 两段与既有段同形且键集齐备", () => {
  const catalog = JSON.parse(readFileSync(CATALOG_URL, "utf8")) as Record<string, unknown>;

  for (const seg of ["qoder-cn", "opencode", "codex", "claude"] as const) {
    const section = catalog[seg];
    assert.equal(typeof section, "object", `${seg} 段应为对象`);
    assert.ok(section !== null && !Array.isArray(section), `${seg} 段应为非数组对象`);
    const entries = Object.entries(section as Record<string, unknown>);
    assert.ok(entries.length > 0, `${seg} 段不应为空`);
    for (const [key, value] of entries) {
      assert.notEqual(key.trim(), "", `${seg} 段不得有空 key`);
      assert.equal(typeof value, "string", `${seg}.${key} 显示名应为字符串`);
      assert.notEqual(value, "", `${seg}.${key} 显示名不应为空`);
    }
  }

  assert.deepEqual(
    Object.keys(catalog["codex"] as object).sort(),
    ["deepseek-flash", "deepseek-v4-pro"],
    "codex 段键集",
  );
  assert.deepEqual(
    Object.keys(catalog["claude"] as object).sort(),
    ["default", "fable", "haiku", "opus", "sonnet"],
    "claude 段键集",
  );

  const comment = catalog["_comment"];
  assert.equal(typeof comment, "string", "_comment 应为字符串");
  assert.match(String(comment), /codex/);
  assert.match(String(comment), /claude/);
});
