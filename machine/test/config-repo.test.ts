/**
 * `machine/config.ts` 加载期 `ProjectConfig.repo`（可选键）抽取
 * + `launcher/config-snapshot.ts` 仓库标识播报（REQ-v0.10.0 · M1）。
 *
 * 校验判据：**条件写入**（照 `risk` 先例）—— 未配置 ⇒ 不落该键（单仓零感知、无报错、无需迁移）；
 * 写了必须是非空字符串（空串 / 非串 ⇒ 加载期 fail-fast 且指名 `.repo`）。
 * **不做缺省推断 / 归一**：缺省 = 宿主仓的解释权归引擎，machine 只「配置了才上报」。
 * 播报判据：配置 ⇒ `repo=<值>（agentConfig）`；未配置 ⇒ 省略该键（`undefined`，缺键 ≠ 报空）。
 *
 * 运行：`npm run build && node --test dist/test/config-repo.test.js`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMachineConfig } from "../config.js";
import { describeAgentConfig } from "../launcher/config-snapshot.js";
import type { ProjectConfig } from "../types.js";

/** 写一份临时机器配置（单个 project 携带可选顶层 `repo` 键），跑完清理。 */
function withRepo(repo: unknown, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "a2a-machine-repo-"));
  try {
    const path = join(dir, "config.json");
    const project: Record<string, unknown> = {
      projectId: "p1",
      workspace: "/ws/p1",
      agentKind: "opencode",
      a2aPort: 4100,
    };
    if (repo !== undefined) project["repo"] = repo;
    writeFileSync(
      path,
      JSON.stringify({ machineId: "m-test", launcher: { port: 3100 }, projects: [project] }),
      "utf8",
    );
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 加载必须抛 ⇒ 返回错误文案（供含键名断言）；不抛 ⇒ 断言失败。 */
function loadErrorText(path: string): string {
  try {
    loadMachineConfig(path);
  } catch (err) {
    return String(err);
  }
  assert.fail("预期 fail-fast，但加载成功");
}

// ---- 校验面：ProjectConfig.repo ----

test("config：未写 repo ⇒ 正常加载、不落该键（单仓零感知）", () => {
  withRepo(undefined, (path) => {
    const cfg = loadMachineConfig(path);
    assert.equal(cfg.projects[0]?.repo, undefined);
    assert.ok(!("repo" in (cfg.projects[0] ?? {})), "未配置不得凭空写入 repo 键");
  });
});

test("config：合法非空串 ⇒ 原样解析到 project.repo", () => {
  withRepo("a2a-coding/machine", (path) => {
    assert.equal(loadMachineConfig(path).projects[0]?.repo, "a2a-coding/machine");
  });
});

test("config：非法取值（空串 / 非串）⇒ 一律抛且指名键 `.repo`", () => {
  for (const bad of ["", 42, null, {}, true]) {
    withRepo(bad, (path) => {
      const text = loadErrorText(path);
      assert.match(text, /\.repo/, `非法值 ${JSON.stringify(bad)} 应当被拒：${text}`);
    });
  }
});

// ---- 播报面：config-snapshot repo ----

function project(repo?: string): ProjectConfig {
  return { projectId: "p1", workspace: "/ws/p1", agentKind: "qoder-cn", a2aPort: 4100, repo };
}

test("repo 段 · 配置 ⇒ 播报 `repo=<值>（agentConfig）`", () => {
  assert.equal(describeAgentConfig(project("mono/core")).repo, "repo=mono/core（agentConfig）");
});

test("repo 段 · 未配置 ⇒ 省略该键（undefined，缺键 ≠ 报空）", () => {
  assert.equal(describeAgentConfig(project()).repo, undefined);
});
