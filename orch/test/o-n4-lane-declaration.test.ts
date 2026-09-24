/**
 * v0.8.10 O-N4 · orch 侧「`readOnly` 声明与透传」—— 声明面（MCP 入参 → `tasks.lane`）。
 *
 * 覆盖（节点任务书门禁）：
 * ① `a2a_call(readOnly=true)` 登记 Feature 节点 ⇒ 行 `lane='read'`；
 * ② 缺省 / `readOnly=false` ⇒ `lane='write'`（显式写入，不依赖 NULL 缺省）；
 * ③ inquiry（`core.call` 散活建行）⇒ **恒 `lane='read'`**（散活本就是只读语义；
 *    若不强制标 read 则按缺省=写 ⇒ 撞 machine 写闸 ⇒「散活让路」目标落空）；
 * ④ schema 锚：`readOnly` 为可选布尔、随 zod 解析保留（`validateCallMode` 不因其存在而变判）。
 *
 * `lane → DispatchCommand.readOnly` 的透传用例在 `runner-endpoints.test.ts`
 * （「readOnly 透传」：只读档带键 / 写档与缺档不带键）。
 *
 * 运行：`npm test`。夹具同 `project-group.test.ts`：`:memory:` 库 + 零出站桩 + 未配组全量接纳。
 */
process.env["SESSION_DB"] = ":memory:";
process.env["SYNC_BUDGET_MS"] = "200";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createFeature, createTask, getTask, runnerProjectsReplace, upsertRunner } from "../session/store.js";
import { a2aCallSchema, validateCallMode } from "../bridge/register-tools.js";
import type { BridgeCore } from "../bridge/index.js";

// 零出站桩：pull 模型桥侧不应有直接出站；领取走 HTTP /connect（本测试不发生）⇒ 抛错即失败
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  throw new Error(`单测未预期的出站请求：${String(input)}`);
};

const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-on4-lane-"));
const CFG_PATH = join(CFG_DIR, "config.json");
process.env["MACHINES_CONFIG"] = CFG_PATH; // 必须在 import bridge/index.js **之前**
writeFileSync(CFG_PATH, JSON.stringify({ machines: [{ machineId: "m1" }] }, null, 2));

const { createCore } = await import("../bridge/index.js");
const core: BridgeCore = createCore();

// 注册投影：m1/alpha 在线（locateProject 命中 ⇒ inquiry 可入队）
upsertRunner({ runnerId: "m1", machineId: "m1", protocolVersion: "2.0" });
runnerProjectsReplace("m1", [
  { projectId: "alpha", agentKind: "opencode", a2aPort: 3010, status: "online" },
]);

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(CFG_DIR, { recursive: true, force: true });
});

function okOrThrow<T extends { ok: boolean }>(v: T, what: string): Extract<T, { ok: true }> {
  assert.equal(v.ok, true, `${what} 应成功：${JSON.stringify(v)}`);
  return v as Extract<T, { ok: true }>;
}

test("① registerFeatureNode readOnly=true ⇒ 行 lane='read'", () => {
  createFeature({ featureId: "f-r", title: "只读档", state: "executing" });
  const outcome = okOrThrow(
    core.registerFeatureNode("alpha", "只读核实", undefined, "f-r", [], undefined, true),
    "登记 readOnly=true 节点",
  );
  assert.equal(getTask(outcome.taskId!)?.lane, "read");
});

test("② registerFeatureNode 缺省 / false ⇒ 行 lane='write'（显式写入）", () => {
  createFeature({ featureId: "f-w", title: "写档", state: "executing" });
  const omitted = okOrThrow(
    core.registerFeatureNode("alpha", "改造任务", undefined, "f-w", []),
    "登记缺省节点",
  );
  assert.equal(getTask(omitted.taskId!)?.lane, "write");

  const explicitFalse = okOrThrow(
    core.registerFeatureNode("alpha", "改造任务", undefined, "f-w", [], undefined, false),
    "登记 readOnly=false 节点",
  );
  assert.equal(getTask(explicitFalse.taskId!)?.lane, "write");
});

test("③ inquiry 散活建行 ⇒ 恒 lane='read'（wait=false 全异步入队）", async () => {
  const outcome = okOrThrow(
    await core.call("alpha", "只读询问当前行为", undefined, false, "inquiry"),
    "inquiry 派发",
  );
  const rec = getTask(outcome.taskId!);
  assert.notEqual(rec, null, "inquiry 行应已建行");
  assert.equal(rec?.lane, "read", "散活恒落只读档（否则撞 machine 写闸）");
});

test("④ schema 锚：readOnly 可选布尔随解析保留；validateCallMode 不因其变判", () => {
  const callArgs = z.object(a2aCallSchema);

  const parsed = callArgs.parse({ project: "alpha", message: "x", mode: "execute", featureId: "f", readOnly: true });
  assert.equal(parsed.readOnly, true);

  const omitted = callArgs.parse({ project: "alpha", message: "x", mode: "inquiry" });
  assert.equal(omitted.readOnly, undefined);

  // 对偶校验只看 mode/featureId：带 readOnly 不改变两个错误码
  assert.equal(validateCallMode({ mode: "execute" }).ok, false);
  assert.equal(validateCallMode({ mode: "execute", featureId: "f" }).ok, true);
});

// 防脏用：store 直写路径不受本节点影响（lane 缺省 = NULL ⇒ 读侧归一 write）
test("⑤ 存量语义不回归：createTask 不带 lane ⇒ 读侧归一 write", () => {
  createTask({ taskId: "t-legacy", projectId: "alpha", contextId: "c", state: "working" });
  assert.equal(getTask("t-legacy")?.lane, "write");
});
