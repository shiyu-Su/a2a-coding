/**
 * `machine/config.ts` 的 `launcher.bridge` 解析测试（v0.7.0 Phase A · 节点 MA1）。
 *
 * 判据：整段缺省 = 不启用 Runner（零出站）；存在则 url + token 均为必填非空串。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMachineConfig } from "../config.js";

function withTempConfig(launcher: Record<string, unknown>, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "a2a-machine-bridge-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ machineId: "m-test", launcher, projects: [] }), "utf8");
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("launcher.bridge 缺省不写：不启用 Runner（bridge 为 undefined）", () => {
  withTempConfig({ port: 3100 }, (path) => {
    const config = loadMachineConfig(path);
    assert.equal(config.launcher.bridge, undefined);
  });
});

test("launcher.bridge 同时给 url + token：解析为 BridgeConfig", () => {
  withTempConfig({ port: 3100, bridge: { url: "http://x.test:3200", token: "secret" } }, (path) => {
    const config = loadMachineConfig(path);
    assert.deepEqual(config.launcher.bridge, { url: "http://x.test:3200", token: "secret" });
  });
});

test("launcher.bridge 缺 token / url 非串：报 [config] 错误", () => {
  withTempConfig({ port: 3100, bridge: { url: "http://x.test:3200" } }, (path) => {
    assert.throws(() => loadMachineConfig(path), /\[config\].*token/);
  });
  withTempConfig({ port: 3100, bridge: { url: "", token: "secret" } }, (path) => {
    assert.throws(() => loadMachineConfig(path), /\[config\].*url/);
  });
});
