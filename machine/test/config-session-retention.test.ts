/**
 * `machine/config.ts` 加载期 `agentConfig.sessionRetentionDays` / `sessionRetentionMax`
 * 护栏（REQ-v0.8.9-2026-09-23-01 · M5）。
 *
 * 判据：未写 ⇒ 正常加载（缺省由桥 SessionMap 落 7d / 500）；写了必须为正整数，
 * 否则 fail-fast（0 / 负数 / 小数 / 字符串 / null ⇒ 抛）。**无上限语义**
 * （与 `sessionTimeoutMs` 的 15 min 上限护栏相互独立，互不派生）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMachineConfig } from "../config.js";

/** 写一份临时机器配置（单个 project 的 agentConfig 由调用方给），跑完清理。 */
function withAgentConfig(agentConfig: unknown, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "a2a-machine-sret-"));
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

test("config：未写两键 ⇒ 正常加载（缺省由桥落 7d / 500）", () => {
  withAgentConfig({ backendCmd: "C:/x/opencode.exe" }, (path) => {
    const cfg = loadMachineConfig(path);
    assert.equal(cfg.projects[0]?.agentConfig?.["sessionRetentionDays"], undefined);
    assert.equal(cfg.projects[0]?.agentConfig?.["sessionRetentionMax"], undefined);
  });
});

test("config：合法值（1 / 常用值 / 无上限大值）⇒ 正常加载并原样保留", () => {
  for (const [key, values] of [
    ["sessionRetentionDays", [1, 7, 3650]],
    ["sessionRetentionMax", [1, 500, 100000]],
  ] as const) {
    for (const v of values) {
      withAgentConfig({ [key]: v }, (path) => {
        assert.equal(loadMachineConfig(path).projects[0]?.agentConfig?.[key], v, `${key}=${v}`);
      });
    }
  }
});

test("config：非法取值（0 / 负数 / 小数 / 字符串 / null）⇒ 一律抛且指名键", () => {
  for (const key of ["sessionRetentionDays", "sessionRetentionMax"]) {
    for (const bad of [0, -5, 1.5, "7", null]) {
      withAgentConfig({ [key]: bad }, (path) => {
        assert.throws(
          () => loadMachineConfig(path),
          new RegExp(key),
          `${key}=${JSON.stringify(bad)} 应当被拒`,
        );
      });
    }
  }
});
