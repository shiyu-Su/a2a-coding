/**
 * B6 定向单测：artifacts 形状 / 树杀 / 端口占用结构化退出（REQ-v0.8.0-2026-09-19-01 · 节点 B6）。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactNameFor, buildArtifacts, buildWorkspaceArtifacts } from "../acp-bridge/artifacts.js";
import { classifyFatal, killProcessTree } from "../acp-bridge/lifecycle.js";
import { createAcpA2AServer } from "../acp-bridge/a2a-server.js";
import type { TaskExecutor } from "../acp-bridge/types.js";

test("B6 artifacts 形状：A2A v0.3 parts（text/uri）", () => {
  let n = 0;
  const arts = buildArtifacts(
    [
      { name: "a.txt", text: "hello" },
      { name: "b", uri: "file:b" },
    ],
    { idFactory: () => `id-${(n += 1)}` },
  );
  assert.deepEqual(arts, [
    { artifactId: "id-1", name: "a.txt", parts: [{ kind: "text", text: "hello" }] },
    { artifactId: "id-2", name: "b", parts: [{ kind: "text", text: "file:b" }] },
  ]);
});

test("B6 workspace 文件 artifact：name = POSIX 相对路径；无内容 → file: 引用", () => {
  const abs = process.platform === "win32" ? "C:\\ws\\src\\a.ts" : "/ws/src/a.ts";
  const ws = process.platform === "win32" ? "C:\\ws" : "/ws";
  assert.equal(artifactNameFor(ws, abs), "src/a.ts");
  const arts = buildWorkspaceArtifacts(ws, [{ path: abs }, { path: abs, content: "x" }], {
    idFactory: () => "id",
  });
  assert.equal(arts[0]?.parts[0]?.text, "file:src/a.ts");
  assert.equal(arts[1]?.parts[0]?.text, "x");
});

test("B6 树杀：win32 → taskkill（/T /F）", () => {
  const calls: number[] = [];
  killProcessTree(1234, { platform: "win32", spawnTaskkill: (pid) => calls.push(pid) });
  assert.deepEqual(calls, [1234]);
});

test("B6 树杀：POSIX → 组杀；组杀失败回落单进程", () => {
  const groups: Array<[number, string]> = [];
  const procs: Array<[number, string]> = [];
  killProcessTree(2222, {
    platform: "linux",
    signalGroup: (pid, sig) => {
      groups.push([pid, sig]);
      return true;
    },
    signalProcess: (pid, sig) => procs.push([pid, sig]),
  });
  assert.deepEqual(groups, [[2222, "SIGTERM"]]);
  assert.deepEqual(procs, []);

  const groups2: Array<[number, string]> = [];
  const procs2: Array<[number, string]> = [];
  killProcessTree(3333, {
    platform: "linux",
    signalGroup: (pid, sig) => {
      groups2.push([pid, sig]);
      return false;
    },
    signalProcess: (pid, sig) => procs2.push([pid, sig]),
  });
  assert.deepEqual(groups2, [[3333, "SIGTERM"]]);
  assert.deepEqual(procs2, [[3333, "SIGTERM"]]);
});

test("B6 树杀：pid<=1 忽略（防广播灾难）", () => {
  const calls: number[] = [];
  killProcessTree(1, { platform: "win32", spawnTaskkill: (pid) => calls.push(pid) });
  assert.deepEqual(calls, []);
});

test("B6 classifyFatal：EADDRINUSE → { code, exitCode: 1 }", () => {
  const err = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
  const fatal = classifyFatal(err);
  assert.equal(fatal.code, "EADDRINUSE");
  assert.equal(fatal.exitCode, 1);
});

test("B6 端口占用：第二个 listen 被拒（EADDRINUSE）", async () => {
  const executor: TaskExecutor = { execute: () => Promise.resolve({ state: "completed" }) };
  const first = createAcpA2AServer({ executor });
  const second = createAcpA2AServer({ executor });
  await first.listen(0);
  try {
    await assert.rejects(
      () => second.listen(first.port()),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "EADDRINUSE",
    );
  } finally {
    await first.close();
  }
});
