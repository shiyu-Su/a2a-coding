/**
 * `DEFAULT_AGENT_CONFIG` 段一致性（REQ-v0.8.0-2026-09-18-01 §4.1-8）。
 *
 * 行为化测试（**不扩大导出面**）：经 `writeAgentConfig` 写临时目录 → 读回 →
 * 断言每个 `AGENT_KINDS` 成员对应键存在（+ `events` 段），并锁产物命名
 * `agents/<agentKind>.<projectId>.json`。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentConfig } from "../launcher/agent-config.js";
import { AGENT_KINDS } from "../agent-kinds.js";
import { getAdapter } from "../adapters/index.js";
import type { ProjectConfig } from "../types.js";

function project(agentKind: ProjectConfig["agentKind"]): ProjectConfig {
  return { projectId: "p1", workspace: "/ws/p1", agentKind, a2aPort: 4100 };
}

test("writeAgentConfig：读回配置含每个 AGENT_KINDS 成员段 + events 段", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "a2a-machine-seg-"));
  try {
    for (const kind of AGENT_KINDS) {
      const path = writeAgentConfig(project(kind), appRoot, getAdapter(kind).baseConfig());
      const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      assert.equal(typeof written["events"], "object", "缺少 events 段");
      for (const member of AGENT_KINDS) {
        assert.ok(
          typeof written[member] === "object" && written[member] !== null,
          `缺少 ${member} 段`,
        );
      }
    }
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

test("writeAgentConfig：产物名为 agents/<agentKind>.<projectId>.json", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "a2a-machine-seg-"));
  try {
    const path = writeAgentConfig(project("codex"), appRoot, getAdapter("codex").baseConfig());
    assert.equal(path, join(appRoot, "agents", "codex.p1.json"));
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});
