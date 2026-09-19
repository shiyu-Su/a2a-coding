/**
 * `machine/launcher/agents-prune.ts` 清理行为（REQ-v0.8.0-2026-09-18-01 §4.1-7）。
 *
 * 判据：由 `AGENT_KINDS` 派生的 `AGENT_CONFIG_RE` 对 `agents/<kind>.<proj>.json`
 * （每个 kind 成员）匹配 ⇒ 在册者**不被误删**、过期者**可被清理**；无关文件不动。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneStaleAgentConfigs } from "../launcher/agents-prune.js";
import { AGENT_KINDS } from "../agent-kinds.js";
import type { ProjectConfig } from "../types.js";

/** 建一个含 `agents/<files>` 的临时 appRoot，跑完清理 */
function withAgents(files: string[], run: (appRoot: string, dir: string) => void): void {
  const appRoot = mkdtempSync(join(tmpdir(), "a2a-machine-prune-"));
  try {
    const dir = join(appRoot, "agents");
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), "{}", "utf8");
    run(appRoot, dir);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
}

function project(agentKind: ProjectConfig["agentKind"], projectId: string): ProjectConfig {
  return { projectId, workspace: `/ws/${projectId}`, agentKind, a2aPort: 4100 };
}

test("prune：AGENT_KINDS 各成员的 <kind>.<proj>.json 在册时不被误删", () => {
  const projects = AGENT_KINDS.map((kind) => project(kind, "p1"));
  const files = AGENT_KINDS.map((kind) => `${kind}.p1.json`);
  withAgents(files, (appRoot, dir) => {
    const result = pruneStaleAgentConfigs(appRoot, projects);
    assert.deepEqual(result.removed, []);
    assert.equal(result.kept, projects.length);
    assert.deepEqual(readdirSync(dir).sort(), [...files].sort());
  });
});

test("prune：每个 kind 成员的过期 <kind>.<proj>.json（不在册）均被清理", () => {
  const files = AGENT_KINDS.map((kind) => `${kind}.stale.json`);
  withAgents(files, (appRoot, dir) => {
    const result = pruneStaleAgentConfigs(appRoot, [project("opencode", "p1")]);
    assert.deepEqual(result.removed.sort(), [...files].sort());
    assert.equal(result.kept, 1);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("prune：无关文件（非 <kind>.<proj>.json 形态）不被误删", () => {
  const unrelated = [
    "notes.txt",
    "mcp.foo.json",
    "opencode.json",
    "opencode..json",
    "opencode.p1.json.bak",
    "dsh.p1.json",
  ];
  withAgents(unrelated, (appRoot, dir) => {
    const result = pruneStaleAgentConfigs(appRoot, []);
    assert.deepEqual(result.removed, []);
    assert.equal(result.kept, 0);
    assert.deepEqual(readdirSync(dir).sort(), [...unrelated].sort());
  });
});

test("prune：在册保留 + 过期清理 + 无关不动（混合）", () => {
  const files = ["opencode.p1.json", "opencode.old.json", "notes.txt"];
  withAgents(files, (appRoot, dir) => {
    const result = pruneStaleAgentConfigs(appRoot, [project("opencode", "p1")]);
    assert.deepEqual(result.removed, ["opencode.old.json"]);
    assert.equal(result.kept, 1);
    assert.deepEqual(readdirSync(dir).sort(), ["notes.txt", "opencode.p1.json"]);
  });
});

test("prune：agents/ 目录不存在时返回空结果（不抛出）", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "a2a-machine-prune-"));
  try {
    const result = pruneStaleAgentConfigs(appRoot, [project("opencode", "p1")]);
    assert.deepEqual(result.removed, []);
    assert.equal(result.kept, 1);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});
