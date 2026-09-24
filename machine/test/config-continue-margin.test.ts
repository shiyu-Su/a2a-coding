/**
 * `machine/config.ts` 加载期 `agentConfig.continueMarginMs` 护栏
 * + `launcher/config-snapshot.ts` 会话窗/余量播报（REQ-v0.8.9-2026-09-23-02 · M3）。
 *
 * 校验判据：**非负整数**（0 合法 = 显式关闭续跑；负数 / 小数 / 字符串 / null ⇒ 抛）；
 * **上限 = 生效会话窗**（M1 `effectiveSessionTimeoutMs`：显式 `sessionTimeoutMs` ?? 桥缺省
 * 600_000），超限 fail-fast 且报错文案带生效窗实际数值与出处。
 * 播报判据：两键值均标注出处（agentConfig / 缺省），缺省口径 = 600_000 / 0。
 *
 * 运行：`npm run build && node --test dist/test/config-continue-margin.test.js`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMachineConfig } from "../config.js";
import { describeAgentConfig } from "../launcher/config-snapshot.js";
import type { ProjectConfig } from "../types.js";

/** 写一份临时机器配置（单个 project 的 agentConfig 由调用方给），跑完清理。 */
function withAgentConfig(agentConfig: unknown, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "a2a-machine-cem-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        machineId: "m-test",
        launcher: { port: 3100 },
        projects: [
          { projectId: "p1", workspace: "/ws/p1", agentKind: "opencode", a2aPort: 4100, agentConfig },
        ],
      }),
      "utf8",
    );
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 加载必须抛 ⇒ 返回错误文案（供含数值断言）；不抛 ⇒ 断言失败。 */
function loadErrorText(path: string): string {
  try {
    loadMachineConfig(path);
  } catch (err) {
    return String(err);
  }
  assert.fail("预期 fail-fast，但加载成功");
}

// ---- 校验面：continueMarginMs ----

test("config：未写 continueMarginMs ⇒ 正常加载（缺省 0 = 关闭续跑，不落配置）", () => {
  withAgentConfig({ backendCmd: "C:/x/opencode.exe" }, (path) => {
    const cfg = loadMachineConfig(path);
    assert.equal(cfg.projects[0]?.agentConfig?.["continueMarginMs"], undefined);
  });
});

test("config：continueMarginMs=0 合法（显式关闭）⇒ 正常加载并原样保留", () => {
  withAgentConfig({ continueMarginMs: 0 }, (path) => {
    assert.equal(loadMachineConfig(path).projects[0]?.agentConfig?.["continueMarginMs"], 0);
  });
});

test("config：合法值（含边界 = 生效窗）⇒ 正常加载并原样保留", () => {
  for (const agentConfig of [
    { continueMarginMs: 60_000 }, // 未配窗 ⇒ 上限吃桥缺省 600_000
    { continueMarginMs: 600_000 }, // 未配窗 ⇒ 边界 = 桥缺省窗
    { sessionTimeoutMs: 120_000, continueMarginMs: 120_000 }, // 显式窗 ⇒ 边界 = 显式窗
  ]) {
    withAgentConfig(agentConfig, (path) => {
      assert.equal(
        loadMachineConfig(path).projects[0]?.agentConfig?.["continueMarginMs"],
        agentConfig["continueMarginMs"],
        JSON.stringify(agentConfig),
      );
    });
  }
});

test("config：超生效窗（未配窗 ⇒ 上限=桥缺省 600000）⇒ 抛且文案含窗数值与出处", () => {
  withAgentConfig({ continueMarginMs: 600_001 }, (path) => {
    const text = loadErrorText(path);
    assert.match(text, /continueMarginMs/);
    assert.ok(text.includes("600000"), `文案应含生效窗数值：${text}`);
    assert.ok(text.includes("桥缺省"), `文案应标注窗出处=桥缺省：${text}`);
  });
});

test("config：超生效窗（显式窗 120000）⇒ 抛且文案含该窗数值与出处", () => {
  withAgentConfig({ sessionTimeoutMs: 120_000, continueMarginMs: 120_001 }, (path) => {
    const text = loadErrorText(path);
    assert.match(text, /continueMarginMs/);
    assert.ok(text.includes("120000"), `文案应含生效窗数值：${text}`);
    assert.ok(
      text.includes("agentConfig.sessionTimeoutMs"),
      `文案应标注窗出处=显式配置：${text}`,
    );
  });
});

test("config：非法取值（负数 / 小数 / 字符串 / null）⇒ 一律抛且指名键（0 不在此列）", () => {
  for (const bad of [-1, -5, 1.5, "60000", null]) {
    withAgentConfig({ continueMarginMs: bad }, (path) => {
      const text = loadErrorText(path);
      assert.match(text, /continueMarginMs/, `非法值 ${JSON.stringify(bad)} 应当被拒：${text}`);
    });
  }
});

// ---- 校验面：sessionTimeoutMs 文案收严（15 min → 10 min）----

test("config：sessionTimeoutMs 超限文案 =「上限 10 min」（v0.8.9 需求2 · M1 收严后口径）", () => {
  withAgentConfig({ sessionTimeoutMs: 600_001 }, (path) => {
    const text = loadErrorText(path);
    assert.match(text, /sessionTimeoutMs/);
    assert.ok(text.includes("上限 10 min"), `文案应为 10 min 口径：${text}`);
    assert.ok(!text.includes("15 min"), `不得残留 15 min 旧口径：${text}`);
  });
});

// ---- 播报面：config-snapshot sessionWindow ----

function project(agentConfig?: Record<string, unknown>): ProjectConfig {
  return { projectId: "p1", workspace: "/ws/p1", agentKind: "qoder-cn", a2aPort: 4100, agentConfig };
}

test("sessionWindow 段 · 不配 ⇒ 缺省值标注（600000 / 0，出处=缺省）", () => {
  assert.equal(
    describeAgentConfig(project()).sessionWindow,
    "sessionTimeoutMs=600000（缺省） continueMarginMs=0（缺省）",
  );
});

test("sessionWindow 段 · 显式配 ⇒ 生效值标注出处（agentConfig），两键独立", () => {
  assert.equal(
    describeAgentConfig(project({ sessionTimeoutMs: 120_000, continueMarginMs: 60_000 }))
      .sessionWindow,
    "sessionTimeoutMs=120000（agentConfig） continueMarginMs=60000（agentConfig）",
  );
  assert.equal(
    describeAgentConfig(project({ sessionTimeoutMs: 120_000 })).sessionWindow,
    "sessionTimeoutMs=120000（agentConfig） continueMarginMs=0（缺省）",
    "只配窗 ⇒ 余量仍报缺省 0（续跑未开可见）",
  );
  assert.equal(
    describeAgentConfig(project({ continueMarginMs: 0 })).sessionWindow,
    "sessionTimeoutMs=600000（缺省） continueMarginMs=0（agentConfig）",
    "只配余量=0 ⇒ 显式关闭与缺省关闭出处可区分",
  );
});

test("sessionWindow 段 · 有取消往返耗时 ⇒ 同处追 `cancelQuiesceMs=<耗时>（取消往返：桥台账转终态耗时，非后端静默）`；无取值 ⇒ 不出该键", () => {
  // 无取值（缺省调用）⇒ 整段只有两键（缺键 ≠ 报 0）
  assert.equal(
    describeAgentConfig(project()).sessionWindow,
    "sessionTimeoutMs=600000（缺省） continueMarginMs=0（缺省）",
  );
  assert.equal(
    describeAgentConfig(project({ sessionTimeoutMs: 120_000, continueMarginMs: 60_000 }), undefined, 2_400)
      .sessionWindow,
    "sessionTimeoutMs=120000（agentConfig） continueMarginMs=60000（agentConfig） cancelQuiesceMs=2400（取消往返：桥台账转终态耗时，非后端静默）",
  );
  // 0ms 是合法取值（往返瞬时完成，不反映后端静默），不得当成「无值」丢掉
  assert.equal(
    describeAgentConfig(project(), undefined, 0).sessionWindow,
    "sessionTimeoutMs=600000（缺省） continueMarginMs=0（缺省） cancelQuiesceMs=0（取消往返：桥台账转终态耗时，非后端静默）",
  );
});
