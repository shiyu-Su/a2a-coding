/**
 * `orch/bridge/register-tools.ts` 单测 —— `a2a_call` **执行准入**（REQ-v0.4.1-2026-09-16-01 §2.5，A 步）。
 *
 * 覆盖（R3 要求的落点补齐）：
 * ① **未知键被 strip** —— SDK 以 `z.object(shape)`（zod 默认 strip）解析入参 ⇒ 未知键被**丢弃而非报错**，
 *    故宿主可在 N1/N2 期间**提前**按新签名（`mode`）调用而不报错（自举前向兼容）；本用例即"锁定该行为"，
 *    防 SDK 升级改成 strict 语义；
 * ② **缺 `mode` 被拒** —— `mode` 必填、无缺省（不沉默漏过、也不误伤只读询问）；
 * ③ **对偶校验两个错误码** —— `execute` 无 `featureId` ⇒ `feature_required_for_execute`；
 *    `inquiry` 带 `featureId` ⇒ `feature_not_allowed_for_inquiry`；
 * ④ `mode` 取值不在枚举 ⇒ schema 层拒绝。
 *
 * 范围：本文件只覆盖 **A 步**的准入判定；`MOUNTABLE_FEATURE_STATES` 的**实际挂载门**在
 * `bridge/index.ts`（N1c 起复用本常量）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  A2A_CALL_MODES,
  MOUNTABLE_FEATURE_STATES,
  a2aCallSchema,
  validateCallMode,
} from "../bridge/register-tools.js";

/** 与 SDK `objectFromShape` 同构：以 raw shape 构造对象 schema（zod 默认 strip 未知键） */
const callArgs = z.object(a2aCallSchema);

const VALID_INQUIRY = { project: "orch", message: "只读核实当前行为", mode: "inquiry" } as const;

test("① 未知键被 strip：旧桥（z.object）丢弃未知键 ⇒ 宿主可提前用新签名", () => {
  const parsed = callArgs.safeParse({
    ...VALID_INQUIRY,
    unknownFutureKey: "x",
    wait: false,
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed.data, "unknownFutureKey"),
    false,
    "未知键必须被丢弃（不报错、不透传）",
  );
  assert.equal(parsed.data.mode, "inquiry", "已知键正常保留");
  assert.equal(parsed.data.wait, false);
});

test("② 缺 mode 被拒（必填、无缺省）", () => {
  const parsed = callArgs.safeParse({ project: "orch", message: "忘了带 mode" });
  assert.equal(parsed.success, false, "缺 mode ⇒ 解析失败（响亮报错，不沉默漏过）");
});

test("④ mode 取值非法 ⇒ schema 拒绝；合法枚举值均可解析", () => {
  assert.equal(callArgs.safeParse({ ...VALID_INQUIRY, mode: "run" }).success, false);
  for (const mode of A2A_CALL_MODES) {
    assert.equal(
      callArgs.safeParse({ project: "orch", message: "m", mode }).success,
      true,
      `mode="${mode}" 应可解析`,
    );
  }
});

test("③ 对偶校验：execute 无 featureId ⇒ feature_required_for_execute", () => {
  const admission = validateCallMode({ mode: "execute" });
  assert.equal(admission.ok, false);
  if (admission.ok) return;
  assert.equal(admission.code, "feature_required_for_execute");
  assert.match(
    admission.error,
    /mode="inquiry"/,
    "错误消息须给出修法（改 inquiry 或补 featureId）",
  );

  // 空串等同未提供
  assert.equal(validateCallMode({ mode: "execute", featureId: "" }).ok, false);
  // 带上 featureId ⇒ 放行
  assert.equal(validateCallMode({ mode: "execute", featureId: "F-1" }).ok, true);
});

test("③ 对偶校验：inquiry 带 featureId ⇒ feature_not_allowed_for_inquiry", () => {
  const admission = validateCallMode({ mode: "inquiry", featureId: "F-1" });
  assert.equal(admission.ok, false);
  if (admission.ok) return;
  assert.equal(admission.code, "feature_not_allowed_for_inquiry");
  assert.match(admission.error, /mode="execute"/, "错误消息须给出修法");

  // Step 0/1 只读核实路径（无 featureId）⇒ 放行，不得被准入拦
  assert.equal(validateCallMode({ mode: "inquiry" }).ok, true);
});

test("挂载态常量：executing / decomposing（v0.10.5 O4 收窄摘除 waiting_approval，常量集合驱动）", () => {
  assert.deepEqual(
    [...MOUNTABLE_FEATURE_STATES],
    ["executing", "decomposing"],
    "常量集合驱动：描述与文案经 join 自动跟随；waiting_approval 已随挂载白名单收窄摘除（DAG 初版登记只在 decomposing）",
  );
});
