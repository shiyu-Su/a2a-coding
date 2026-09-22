/**
 * v0.8.7 · 节点 M5：在飞台账落盘（InFlightLedger persist 回调）。
 * 覆盖四组落点断言：落盘 / 清盘 / 无 writer 零 IO / 自检前缀进不了台账（不落盘）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { InFlightLedger, type InFlightEntry } from "../launcher/runner.js";
import { atomicWriteJson } from "../launcher/runner-outbox.js";
import { SELF_CHECK_LEDGER_PREFIX } from "../launcher/self-check.js";

const ENTRY: InFlightEntry = {
  taskId: "t-1",
  projectId: "alpha",
  startedAt: "2026-09-22T00:00:00.000Z",
  a2aTaskId: null,
};

test("persist 回调：add 携条目、remove 成功携 null 清盘、重复 remove 不再回调", () => {
  const calls: Array<[InFlightEntry | null, string]> = [];
  const ledger = new InFlightLedger({
    persist: (entry, taskId) => calls.push([entry, taskId]),
  });

  ledger.add(ENTRY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], ENTRY);
  assert.equal(calls[0]?.[1], "t-1");

  assert.equal(ledger.remove("t-1"), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.[0], null);
  assert.equal(calls[1]?.[1], "t-1");

  assert.equal(ledger.remove("t-1"), false);
  assert.equal(calls.length, 2, "未命中删除不应产生清盘回调");
});

test("无 writer 零 IO：缺省构造 add/remove 纯内存、行为不变", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-inflight-idle-"));
  try {
    const ledger = new InFlightLedger();
    ledger.add(ENTRY);
    assert.equal(ledger.has("t-1"), true);
    assert.equal(ledger.remove("t-1"), true);
    assert.equal(ledger.size, 0);
    assert.equal(existsSync(dir), true, "临时目录本身存在（对照）");
    assert.equal(existsSync(join(dir, "t-1.json")), false, "缺省构造不产生任何文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("自检前缀进不了台账落盘面：add/remove 均不触发 persist，但内存登记照常", () => {
  const calls: string[] = [];
  const ledger = new InFlightLedger({ persist: (_entry, taskId) => calls.push(taskId) });

  const selfCheckTaskId = `${SELF_CHECK_LEDGER_PREFIX}alpha`;
  ledger.add({ taskId: selfCheckTaskId, projectId: "alpha", startedAt: "2026-09-22T00:00:00.000Z" });
  assert.equal(ledger.has(selfCheckTaskId), true, "自检条目仍在内存台账（idleStop 保护不失效）");
  assert.deepEqual(calls, [], "自检条目不触发落盘回调");

  assert.equal(ledger.remove(selfCheckTaskId), true);
  assert.deepEqual(calls, [], "自检条目不触发清盘回调");

  // 对照：非自检前缀正常回调
  ledger.add(ENTRY);
  assert.deepEqual(calls, ["t-1"]);
});

test("launcher writer 语义（atomicWriteJson + rmSync）：落盘可读回、清盘后不存在", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-inflight-writer-"));
  try {
    const ledger = new InFlightLedger({
      persist: (entry, taskId) => {
        const path = join(dir, `${taskId}.json`);
        if (entry !== null) atomicWriteJson(path, entry);
        else rmSync(path, { force: true });
      },
    });

    ledger.add(ENTRY);
    const written = JSON.parse(readFileSync(join(dir, "t-1.json"), "utf8")) as InFlightEntry;
    assert.deepEqual(written, ENTRY);

    ledger.remove("t-1");
    assert.equal(existsSync(join(dir, "t-1.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson：目录不存在时自动创建（mkdir -p 语义）、覆盖写不留半截", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-inflight-mkdir-"));
  try {
    const nested = join(dir, "inflight", "t-2.json");
    atomicWriteJson(nested, { ok: 1 });
    assert.deepEqual(JSON.parse(readFileSync(nested, "utf8")), { ok: 1 });
    atomicWriteJson(nested, { ok: 2 });
    assert.deepEqual(JSON.parse(readFileSync(nested, "utf8")), { ok: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
