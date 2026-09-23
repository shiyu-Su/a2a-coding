/**
 * `machine/config.ts` 加载期 `agentConfig.sessionTimeoutMs` 上限护栏
 * （REQ-v0.8.7-2026-09-22-01 · M2）。
 *
 * 判据：上限单一源 = `launcher/agent-config.ts` 的 `SESSION_TIMEOUT_MS_CAP`（= 600_000，10 min，
 * v0.8.9 需求2 起；收严理由 = 最坏总框 1500s 恒 < orch 孤儿墙钟 1800s）；
 * `parseProject` 对**已写的**该键 fail-fast（非正整数 / 非整数 / 超上限 ⇒ 抛），未写 ⇒ 正常通过
 * （缺省由桥落 `DEFAULT_SESSION_TIMEOUT_MS`）。桥侧只宽松校验「整数 > 0」，**不重复定义上限**。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMachineConfig } from "../config.js";
import { SESSION_TIMEOUT_MS_CAP } from "../launcher/agent-config.js";

/** 写一份临时机器配置（单个 project 的 agentConfig 由调用方给），跑完清理。 */
function withAgentConfig(agentConfig: unknown, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "a2a-machine-sot-"));
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

test("config：sessionTimeoutMs 上限常量 = 600000（10 min，v0.8.9 需求2 · M1 由 15 min 收严；依据见常量注释）", () => {
  assert.equal(SESSION_TIMEOUT_MS_CAP, 600_000);
});

test("config：未写 sessionTimeoutMs ⇒ 正常加载（缺省由桥落 DEFAULT）", () => {
  withAgentConfig({ backendCmd: "C:/x/opencode.exe" }, (path) => {
    const cfg = loadMachineConfig(path);
    assert.equal(cfg.projects[0]?.agentConfig?.["sessionTimeoutMs"], undefined);
  });
});

test("config：合法值（1 / 边界 CAP）⇒ 正常加载并原样保留", () => {
  for (const ms of [1, 60_000, SESSION_TIMEOUT_MS_CAP]) {
    withAgentConfig({ sessionTimeoutMs: ms }, (path) => {
      assert.equal(loadMachineConfig(path).projects[0]?.agentConfig?.["sessionTimeoutMs"], ms);
    });
  }
});

test("config：超限（CAP+1）⇒ 加载即抛，文案含上限（fail-fast，不静默透传）", () => {
  withAgentConfig({ sessionTimeoutMs: SESSION_TIMEOUT_MS_CAP + 1 }, (path) => {
    assert.throws(
      () => loadMachineConfig(path),
      new RegExp(`sessionTimeoutMs[\\s\\S]*${SESSION_TIMEOUT_MS_CAP}`),
    );
  });
});

test("config：非法取值（0 / 负数 / 小数 / 字符串 / null）⇒ 一律抛", () => {
  for (const bad of [0, -5, 1.5, "60000", null]) {
    withAgentConfig({ sessionTimeoutMs: bad }, (path) => {
      assert.throws(
        () => loadMachineConfig(path),
        /sessionTimeoutMs/,
        `非法值 ${JSON.stringify(bad)} 应当被拒`,
      );
    });
  }
});
