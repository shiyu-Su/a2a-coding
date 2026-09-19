/**
 * `machine/config.ts` 加载期 agentKind 校验（REQ-v0.8.0-2026-09-18-01 §4.1-1/§4.1-6）。
 *
 * 判据：
 * - 未知 agentKind（如 `dsh`）被拒，且 `[config]` 文案含由 `AGENT_KINDS` **动态拼出**的
 *   可选值（`AGENT_KINDS.join(" / ")`，非硬编码）；
 * - 空串走「非空字符串」校验被拒；
 * - `AGENT_KINDS` 每个成员均正常通过。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMachineConfig } from "../config.js";
import { AGENT_KINDS } from "../agent-kinds.js";

/** 写一份临时机器配置（projects 由调用方给），跑完清理 */
function withConfig(projects: unknown[], run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "a2a-machine-kind-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ machineId: "m-test", launcher: { port: 3100 }, projects }),
      "utf8",
    );
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function project(agentKind: unknown): Record<string, unknown> {
  return { projectId: "p1", workspace: "/ws/p1", agentKind, a2aPort: 4100 };
}

test("config：未知 agentKind（dsh）被拒，文案含由 AGENT_KINDS 动态拼出的可选值", () => {
  withConfig([project("dsh")], (path) => {
    assert.throws(
      () => loadMachineConfig(path),
      new RegExp(`\\[config\\].*${AGENT_KINDS.join(" / ")}`),
    );
  });
});

test("config：空串 agentKind 被拒（非空字符串校验）", () => {
  withConfig([project("")], (path) => {
    assert.throws(() => loadMachineConfig(path), /\[config\].*agentKind/);
  });
});

test("config：agentKind 缺失 / 非串均被拒", () => {
  withConfig([{ projectId: "p1", workspace: "/ws/p1", a2aPort: 4100 }], (path) => {
    assert.throws(() => loadMachineConfig(path), /\[config\].*agentKind/);
  });
  withConfig([project(42)], (path) => {
    assert.throws(() => loadMachineConfig(path), /\[config\].*agentKind/);
  });
});

test("config：AGENT_KINDS 每个成员均通过加载期校验", () => {
  for (const kind of AGENT_KINDS) {
    withConfig([project(kind)], (path) => {
      const config = loadMachineConfig(path);
      assert.equal(config.projects[0]?.agentKind, kind);
    });
  }
});
