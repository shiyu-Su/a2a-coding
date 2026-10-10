/**
 * REQ-2026-09-28-10 v0.9.5 · 板宿主桥模型透传（hostModel）· **T2 锚对账**（离线单测）。
 *
 * 事实源：改造文档 `doc/v0.9.5/板宿主桥模型透传-改造文档.md`（v2 定稿）§4 验收标准 +
 * §2 C1–C4（尤其 **C3 装配传参** / **C4 配置模板**）与 R1 两处必改项。
 *
 * 本文件**只补齐 T1 `host-model-passthrough.test.mjs` 未覆盖的锚**，不重复其既有用例：
 * T1 已把五条口径钉在 **config 层（C1）** 与 **`orgBridgeConfig` 直调层（C2）**：
 * 缺省不注入 / 有值注入只含 model / 空串同 null / 未知键忽略 / 解析进 BoardConfig。
 * 本文件把同样五条补到**装配与落地面**（T1 未触及的三条链）：
 *
 * - **R1 C3 装配**：`buildHostFace` 条件展开 ⇒ faceDeps.hostModel（有值 / 缺省 / 显式 null）；
 *   `orgsDir=null` ⇒ 宿主面不装配（本特性不改此口径，回归锚）；
 * - **R2 注入面 `bridgeConfigFor`**：这是 `triggerTurn` 真正走的那个口（T1 直调的 `orgBridgeConfig`
 *   是其下层），把「有值注入只含 model / 缺省·null·空串不注入」补到该面；
 * - **R3 §4 落地面**：`orgBridgeConfig → buildBridgeLaunchPlan` 的 request —— 「有值注入 / 缺省不注入」
 *   确实落到传给后端桥的起桥参数（缺省时连 `agentConfig` 键都不出现）；
 * - **R4 解析进 BoardConfig 端到端**：`loadConfig` 同场携带未知键与 `_` 注释键 ⇒ 忽略且不影响其它键；
 *   空串 / 纯空白 ⇒ null（同 T1 的 validateConfig 断言，此处走真实文件读入）；
 * - **R5 C4 模板锚（配置模板拆分 S2 起 = 模板两文件口径）**：`hostModel` 键落 `config/config.json.example`
 *   的 `hostKind` 邻位，其**说明**（不透传 / 不校验）落 `README.md` 的 `hostModel` bullet ——
 *   模板不再承载 `_` 注释键，说明位 = README。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_PATH_ENV, loadConfig } from "../dist/config.js";
import { buildBridgeLaunchPlan } from "../dist/host-bridge.js";
import { createHostFace, orgBridgeConfig } from "../dist/host-face.js";
import { buildHostFace } from "../dist/index.js";

const MODEL = "opencode-go/deepseek-v4.1-flash";

/** 可运行起点模板绝对路径（配置模板拆分 S2 起，`hostModel` 等 opt-in 键落这里）。 */
const TEMPLATE_EXAMPLE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "config", "config.json.example");
/** 单元 README 绝对路径（配置模板拆分 S2 起，说明位 = README，不在模板）。 */
const README_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "README.md");

/** README 里承载 `hostModel` 语义的那枚逐键 bullet（恰好一枚，多枚 = 口径分叉）。 */
function readmeHostModelBullet() {
  const hits = readFileSync(README_PATH, "utf8")
    .split(/\r?\n/)
    .filter((line) => /^-\s+\*\*`hostModel`/.test(line));
  assert.equal(hits.length, 1, "README 须恰有一枚 hostModel 逐键 bullet");
  return hits[0];
}

/** 假适配器：只记录板传进来的 request（真适配器的 argv 板无权也无需拼）。 */
function fakeAdapter(kind = "opencode") {
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
      return { command: "node", args: ["ACP-BRIDGE/INDEX.JS", "--port", String(request.a2aPort)] };
    },
  };
}

/** `createHostFace` 的最小替身 deps（不起真桥：桥 / 轮全注入空桩）。 */
function faceDeps(orgsDir) {
  return {
    bridges: {
      async ensureStarted() {
        return { ok: false, reused: false, status: null, error: null };
      },
      async stop() {
        return null;
      },
      statuses() {
        return [];
      },
      async health() {
        return null;
      },
    },
    turns: {
      submitTurn() {
        throw new Error("T2 锚对账不触发真实轮");
      },
      setTurnSettledHandler() {},
      latestTurnOf() {
        return null;
      },
      findAwaitingTurn() {
        return null;
      },
      busyTurnOf() {
        return null;
      },
    },
    orgsDir,
    defaultOrg: null,
    kind: "opencode",
  };
}

// ---------------------------------------------------------------------------
// R1 · C3 装配：buildHostFace 条件展开（R1 必改项：入参可选、零破坏既有调用方）
// ---------------------------------------------------------------------------

test("T2-R1（C3 装配）buildHostFace：有值 ⇒ 进 faceDeps 且 bridgeConfigFor 注入 {model}；缺省 / null ⇒ 不注入；orgsDir=null ⇒ null", () => {
  const root = mkdtempSync(join(tmpdir(), "board-t2-hm-"));
  try {
    const base = {
      orgsDir: root,
      defaultOrg: null,
      kind: "opencode",
      mcpBaseUrl: "http://127.0.0.1:8787",
      machineDist: "MACHINE/DIST",
    };

    const withModel = buildHostFace({ ...base, hostModel: MODEL });
    assert.ok(withModel !== null, "orgsDir 有值 ⇒ 宿主面装配");
    const c1 = withModel.face.bridgeConfigFor("某组织");
    assert.equal("error" in c1, false, "有值不应产出结构化错误");
    assert.deepEqual(c1.agentConfig, { model: MODEL }, "有值 ⇒ agentConfig 注入 model");
    assert.deepEqual(Object.keys(c1.agentConfig), ["model"], "只放 model 一键（不含 backendCmd 等）");

    const omitted = buildHostFace({ ...base });
    assert.equal(
      omitted.face.bridgeConfigFor("某组织").agentConfig,
      undefined,
      "缺省 ⇒ 不注入（既有调用方不传 ⇒ 零改动）",
    );

    const explicitNull = buildHostFace({ ...base, hostModel: null });
    assert.equal(explicitNull.face.bridgeConfigFor("某组织").agentConfig, undefined, "显式 null ⇒ 不注入");

    assert.equal(
      buildHostFace({ ...base, orgsDir: null }),
      null,
      "orgsDir=null ⇒ 宿主面不装配（本特性不改此既有口径）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R2 · 注入面 bridgeConfigFor（triggerTurn 真正走的口）
// ---------------------------------------------------------------------------

test("T2-R2（注入面 bridgeConfigFor）有值 ⇒ 只注入 {model}；缺省 / null / 空串 ⇒ 不注入", () => {
  const root = mkdtempSync(join(tmpdir(), "board-t2-hm-face-"));
  try {
    const rows = [
      { label: "有值", hostModel: MODEL, expected: { model: MODEL } },
      { label: "缺省（undefined）", hostModel: undefined, expected: undefined },
      { label: "显式 null", hostModel: null, expected: undefined },
      { label: "空串", hostModel: "", expected: undefined },
    ];
    for (const row of rows) {
      const deps = faceDeps(root);
      if (row.hostModel !== undefined) deps.hostModel = row.hostModel;
      const face = createHostFace(deps);
      const cfg = face.bridgeConfigFor("某组织");
      assert.equal("error" in cfg, false, `${row.label}：不该产结构化错误`);
      assert.deepEqual(cfg.agentConfig, row.expected, `${row.label}：agentConfig`);
      if (row.expected !== undefined) {
        assert.deepEqual(Object.keys(cfg.agentConfig), ["model"], `${row.label}：只放 model 一键`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R3 · §4 落地面：orgBridgeConfig → buildBridgeLaunchPlan 的 request
// ---------------------------------------------------------------------------

test("T2-R3（§4 落地面）起桥 request：有值 ⇒ agentConfig={model}；缺省 ⇒ 连 agentConfig 键都不出现", () => {
  const root = mkdtempSync(join(tmpdir(), "board-t2-hm-plan-"));
  try {
    const adapter = fakeAdapter("opencode");
    const mcpUrl = "http://127.0.0.1:8787/某组织/mcp";

    const noModel = orgBridgeConfig({ orgsDir: root, kind: "opencode" }, "某组织");
    assert.equal("error" in noModel, false);
    buildBridgeLaunchPlan(adapter, noModel, 1234, mcpUrl);
    const reqNoModel = adapter.calls[1].request; // calls[0]=permission, calls[1]=buildLaunch
    assert.equal("agentConfig" in reqNoModel, false, "缺省 ⇒ 起桥 request 不带 agentConfig 键（后端自身缺省）");

    const withModel = orgBridgeConfig({ orgsDir: root, kind: "opencode", hostModel: MODEL }, "某组织");
    assert.equal("error" in withModel, false);
    buildBridgeLaunchPlan(adapter, withModel, 1234, mcpUrl);
    const reqWithModel = adapter.calls[3].request; // 第二次构建：calls[2]=permission, calls[3]=buildLaunch
    assert.deepEqual(reqWithModel.agentConfig, { model: MODEL }, "有值 ⇒ 落到起桥 request");
    assert.deepEqual(Object.keys(reqWithModel.agentConfig), ["model"], "只放 model 一键");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R4 · 解析进 BoardConfig 端到端（真实文件读入）
// ---------------------------------------------------------------------------

test("T2-R4（解析进 BoardConfig 端到端）loadConfig：未知键 / _ 注释键同场被忽略；空串·纯空白 ⇒ null", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-t2-hm-load-"));
  const path = join(dir, "config.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        _hostModelComment: "注释键不该参与解析",
        futureKnob: { deep: true },
        anotherUnknown: "x",
        hostKind: "opencode",
        hostModel: `  ${MODEL}  `,
      }),
      "utf8",
    );
    const cfg = loadConfig({ [CONFIG_PATH_ENV]: path });
    assert.equal(cfg.hostModel, MODEL, "未知键同场不影响 hostModel 解析（trim 后原样进 BoardConfig）");
    assert.equal(cfg.hostKind, "opencode", "未知键同场不影响其它键解析");

    writeFileSync(path, JSON.stringify({ unknown: 1, hostModel: "   " }), "utf8");
    assert.equal(loadConfig({ [CONFIG_PATH_ENV]: path }).hostModel, null, "纯空白 ⇒ null（与空串同）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R5 · C4 模板锚（模板两文件）：hostModel 落 .example 的 hostKind 邻位，说明落 README bullet
// ---------------------------------------------------------------------------

test("T2-R5（C4 模板锚 · 模板两文件）.example 含 hostModel 键且落 hostKind 邻位；说明（不透传 / 不校验）落 README", () => {
  const text = readFileSync(TEMPLATE_EXAMPLE_PATH, "utf8");
  const parsed = JSON.parse(text);

  assert.ok(Object.prototype.hasOwnProperty.call(parsed, "hostModel"), ".example 须声明 hostModel 键");
  const bullet = readmeHostModelBullet();
  assert.equal(typeof bullet, "string", "hostModel 说明须由 README 承载（模板不留 `_` 注释键）");
  assert.match(bullet, /不透传/, "README 的 hostModel bullet 须写明缺省 = 不透传");
  assert.match(bullet, /不校验/, "README 的 hostModel bullet 须写明板不校验取值");

  const iKind = text.indexOf('"hostKind"');
  const iModel = text.indexOf('"hostModel"');
  const iBridge = text.indexOf('"bridgeUrl"');
  assert.ok(iKind >= 0, ".example 须有 hostKind 键");
  assert.ok(iModel > iKind, "hostModel 应排在 hostKind 之后（邻位）");
  assert.ok(iModel < iBridge, "hostModel 应排在 bridgeUrl 之前（hostKind 邻位）");
});
