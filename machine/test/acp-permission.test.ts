/**
 * `machine/acp-bridge/acp/permission.ts` 定向单测（REQ-v0.8.0-2026-09-19-01 · 节点 B4）。
 *
 * 判据：三档批准/拒绝矩阵 + **read 档写请求被拒**越权用例 + 未知选项拒绝 + 空选项拒绝。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPermissionOption,
  createPermissionHandler,
  decidePermission,
  extractOptions,
  type AcpPermissionOption,
} from "../acp-bridge/acp/permission.js";

const ALLOW: AcpPermissionOption = { optionId: "allow-1", name: "Allow", kind: "allow_once" };
const ALLOW_ALWAYS: AcpPermissionOption = { optionId: "allow-always", name: "Always", kind: "allow_always" };
const REJECT: AcpPermissionOption = { optionId: "reject-1", name: "Reject", kind: "reject_once" };

test("B4 选项分类：allow / reject / unknown", () => {
  assert.equal(classifyPermissionOption(ALLOW), "allow");
  assert.equal(classifyPermissionOption(REJECT), "reject");
  assert.equal(classifyPermissionOption({ optionId: "x", kind: "weird" }), "unknown");
});

test("B4 read 档：写请求（allow 选项）→ 拒绝（防越权）", () => {
  assert.deepEqual(decidePermission("read", [ALLOW, REJECT]), { outcome: "selected", optionId: "reject-1" });
});

test("B4 read 档：仅 allow 选项 → cancelled（不猜测放行）", () => {
  assert.deepEqual(decidePermission("read", [ALLOW]), { outcome: "cancelled" });
});

test("B4 write 档：allow 可批", () => {
  assert.deepEqual(decidePermission("write", [ALLOW, REJECT]), { outcome: "selected", optionId: "allow-1" });
});

test("B4 write 档：仅 reject 选项 → 选 reject", () => {
  assert.deepEqual(decidePermission("write", [REJECT]), { outcome: "selected", optionId: "reject-1" });
});

test("B4 full 档：优先 allow_always", () => {
  assert.deepEqual(decidePermission("full", [ALLOW, ALLOW_ALWAYS]), { outcome: "selected", optionId: "allow-always" });
});

test("B4 空 / 未知选项 → cancelled", () => {
  assert.deepEqual(decidePermission("write", []), { outcome: "cancelled" });
  assert.deepEqual(decidePermission("write", [{ optionId: "x", kind: "weird" }]), { outcome: "cancelled" });
});

test("B4 extractOptions：非法入参 → 空数组；合法项保留", () => {
  assert.deepEqual(extractOptions(null), []);
  assert.deepEqual(extractOptions({ options: "nope" }), []);
  assert.deepEqual(extractOptions({ options: [ALLOW, { name: "no id" }] }), [ALLOW]);
});

test("B4 处理器：request_permission 返回 {outcome}；其它方法抛错", () => {
  const handler = createPermissionHandler("write");
  assert.deepEqual(handler("session/request_permission", { options: [ALLOW] }), {
    outcome: { outcome: "selected", optionId: "allow-1" },
  });
  assert.throws(() => handler("session/other", {}));
});
