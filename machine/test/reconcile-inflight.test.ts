/**
 * `machine/launcher/reconcile-inflight.ts` 单元测试（v0.8.7 · 节点 M6 启动补结算）。
 *
 * 覆盖节点硬用例：
 * - ① stub 桥对重复终态回 `200 {ack:true, ignored:true}` ⇒ outbox 文件已删、
 *   `pendingCount === 0`、`deliveredCount === 孤儿数`；
 * - ② 同一孤儿 taskId 连续两次冷启动 ⇒ `.a2a/outbox` 不产生第二份文件（覆盖写 ⇒ 只发一次）；
 * - ③ 自检前缀条目永不出现在补结算清单（纯判定层；NTFS 冒号文件名本不可达，读取层为防御过滤）；
 * - ④（负向，仅登记现状）桥回 4xx 时 outbox 文件保留 = 现状行为，非设计承诺。
 * 另覆盖：executor-alive 跳过（宁漏勿误杀）/ 损坏条目跳过 / deliver 失败保留台账条目 /
 * 上报体形状（failed + text 原因 + 无 claimToken）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INFLIGHT_RECONCILE_FAILURE_TEXT,
  planInflightReconcile,
  reconcileInflightOnStartup,
  type InflightRecord,
} from "../launcher/reconcile-inflight.js";
import { FileOutbox } from "../launcher/runner-outbox.js";
import { SELF_CHECK_LEDGER_PREFIX } from "../launcher/self-check.js";
import type { RunnerLogger } from "../launcher/runner.js";
import type { BridgeConfig } from "../types.js";

const BRIDGE: BridgeConfig = { url: "http://bridge.test:3200", token: "tok-m6" };
const MACHINE_ID = "m-test";
const NOW_ISO = "2026-09-22T02:00:00.000Z";

const SILENT: RunnerLogger = {
  info: (message) => void message,
  warn: (message) => void message,
  error: (message) => void message,
};

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `a2a-${label}-`));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function makeOutbox(
  dir: string,
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
): FileOutbox {
  return new FileOutbox({
    dir,
    bridge: BRIDGE,
    fetch: fetchFn,
    logger: SILENT,
    now: () => new Date(NOW_ISO),
    random: () => 0.5,
    sleep: async () => {},
  });
}

function inflightFile(dir: string, record: InflightRecord): void {
  writeJson(join(dir, `${record.taskId}.json`), record);
}

/** 桥 200 {ack:true, ignored:true}（契约 3：重复/迟到终态 = 2xx-with-ignore） */
function ignoredOk(): Response {
  return new Response(
    JSON.stringify({ result: { ack: true, ignored: true }, data: null, error: null }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function bridgeDown(): Response {
  return new Response(JSON.stringify({ result: null, data: null, error: null }), { status: 503 });
}

function makeRecord(taskId: string, projectId: string): InflightRecord {
  return { taskId, projectId, startedAt: "2026-09-22T01:00:00.000Z" };
}

// ---------- 纯判定 ----------

test("planInflightReconcile：无执行体 ⇒ 孤儿；projectId 命中存活执行体 ⇒ 跳过（宁漏勿误杀）", () => {
  const records = [makeRecord("t-1", "alpha"), makeRecord("t-2", "beta")];
  const plan = planInflightReconcile(records, { liveExecutorProjectIds: new Set(["beta"]) });
  assert.deepEqual(plan.orphans, [records[0]]);
  assert.deepEqual(plan.skipped, [{ record: records[1], reason: "executor-alive" }]);
});

test("planInflightReconcile：自检前缀条目永不出现在补结算清单（硬用例 ③）", () => {
  const selfCheck: InflightRecord = {
    taskId: `${SELF_CHECK_LEDGER_PREFIX}alpha`,
    projectId: "alpha",
    startedAt: "2026-09-22T01:00:00.000Z",
  };
  const plan = planInflightReconcile([selfCheck, makeRecord("t-1", "alpha")], {
    liveExecutorProjectIds: new Set(),
  });
  // 自检条目即便「无执行体」也不进孤儿清单（否则重启后被当孤儿上报 = 假故障）
  assert.deepEqual(plan.orphans.map((r) => r.taskId), ["t-1"]);
  assert.deepEqual(plan.skipped, [{ record: selfCheck, reason: "self-check" }]);
});

// ---------- 端到端（tmp 目录 + 真 FileOutbox + stub 桥） ----------

test("硬用例 ①：桥 200 {ack,ignored} ⇒ outbox 文件已删、pendingCount=0、deliveredCount=孤儿数", async () => {
  const inflightDir = tmpDir("infl");
  const childrenDir = tmpDir("child");
  const outboxDir = tmpDir("outbox");
  try {
    inflightFile(inflightDir, makeRecord("t-1", "alpha"));
    inflightFile(inflightDir, makeRecord("t-2", "beta"));
    // 子女账本只有一条**不存活**的 pid ⇒ 不构成执行体
    writeJson(join(childrenDir, "4242.json"), { pid: 4242, projectId: "gamma", kind: "wrapper" });

    const bodies: Array<Record<string, unknown>> = [];
    const outbox = makeOutbox(outboxDir, async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return ignoredOk();
    });

    const summary = await reconcileInflightOnStartup({
      inflightDir,
      machineId: MACHINE_ID,
      outbox,
      childrenDir,
      isAlive: () => false,
      now: () => new Date(NOW_ISO),
      logger: SILENT,
    });
    assert.deepEqual(summary, { reported: 2, skipped: 0, failed: 0, degraded: false });
    assert.deepEqual(readdirSync(inflightDir), [], "已消费的台账条目必须删除");
    assert.deepEqual(readdirSync(outboxDir).sort(), ["t-1.json", "t-2.json"]);
    assert.equal(outbox.pendingCount, 2);

    const report = await outbox.flushOnce();
    assert.deepEqual(report, { attempted: 2, acked: 2 });
    assert.deepEqual(readdirSync(outboxDir), [], "ack 后 outbox 文件已删");
    assert.equal(outbox.pendingCount, 0);
    assert.equal(outbox.deliveredCount, 2, "deliveredCount === 孤儿数");

    assert.equal(bodies.length, 2);
    const byTask = new Map(bodies.map((b) => [String(b["taskId"]), b]));
    assert.deepEqual([...byTask.keys()].sort(), ["t-1", "t-2"]);
    assert.equal(byTask.get("t-1")?.["projectId"], "alpha");
    assert.equal(byTask.get("t-2")?.["projectId"], "beta");
    for (const body of byTask.values()) {
      assert.equal(body["state"], "failed");
      assert.equal(body["machineId"], MACHINE_ID);
      assert.equal(body["contextId"], "");
      assert.equal(typeof body["text"], "string");
      assert.ok(String(body["text"]).includes(INFLIGHT_RECONCILE_FAILURE_TEXT), "原因走 text");
      assert.equal("claimToken" in body, false, "不落 claimToken（A2 窄口）");
      assert.equal(body["finishedAt"], NOW_ISO);
      assert.deepEqual(body["artifacts"], []);
    }
  } finally {
    for (const d of [inflightDir, childrenDir, outboxDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("执行体在册跳过：存活 pid 所属项目的在飞条目不上报、文件保留", async () => {
  const inflightDir = tmpDir("infl");
  const childrenDir = tmpDir("child");
  const outboxDir = tmpDir("outbox");
  try {
    inflightFile(inflightDir, makeRecord("t-alive", "alpha"));
    inflightFile(inflightDir, makeRecord("t-dead", "beta"));
    writeJson(join(childrenDir, "777.json"), { pid: 777, projectId: "alpha", kind: "wrapper" });

    const outbox = makeOutbox(outboxDir, async () => ignoredOk());
    const summary = await reconcileInflightOnStartup({
      inflightDir,
      machineId: MACHINE_ID,
      outbox,
      childrenDir,
      isAlive: (pid) => pid === 777,
      logger: SILENT,
    });
    assert.equal(summary.reported, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(existsSync(join(inflightDir, "t-alive.json")), true, "有执行体 ⇒ 条目保留");
    assert.equal(existsSync(join(inflightDir, "t-dead.json")), false);
    assert.deepEqual(readdirSync(outboxDir), ["t-dead.json"]);
    assert.equal(outbox.deliveredCount + outbox.pendingCount, 1);
  } finally {
    for (const d of [inflightDir, childrenDir, outboxDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("硬用例 ②：同一孤儿 taskId 连续两次冷启动 ⇒ outbox 不产生第二份文件（覆盖写 ⇒ 只发一次）", async () => {
  const inflightDir = tmpDir("infl");
  const childrenDir = tmpDir("child");
  const outboxDir = tmpDir("outbox");
  try {
    const record = makeRecord("t-1", "alpha");
    let online = false;
    const bodies: Array<Record<string, unknown>> = [];
    const makeFetch =
      () =>
      async (_url: string, init: RequestInit): Promise<Response> => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return online ? ignoredOk() : bridgeDown();
      };

    // —— 冷启动 1：桥不可达，投递失败但 outbox 文件保留 ——
    inflightFile(inflightDir, record);
    const outbox1 = makeOutbox(outboxDir, makeFetch());
    const s1 = await reconcileInflightOnStartup({
      inflightDir,
      machineId: MACHINE_ID,
      outbox: outbox1,
      childrenDir,
      isAlive: () => false,
      logger: SILENT,
    });
    assert.equal(s1.reported, 1);
    assert.deepEqual(await outbox1.flushOnce(), { attempted: 1, acked: 0 });
    assert.equal(existsSync(join(outboxDir, "t-1.json")), true);
    outbox1.stop();

    // 模拟「第一次启动在删台账前又崩了」⇒ 孤儿条目仍在盘上，第二次冷启动再次见到它
    inflightFile(inflightDir, record);
    online = true;
    const outbox2 = makeOutbox(outboxDir, makeFetch());
    const s2 = await reconcileInflightOnStartup({
      inflightDir,
      machineId: MACHINE_ID,
      outbox: outbox2,
      childrenDir,
      isAlive: () => false,
      logger: SILENT,
    });
    assert.equal(s2.reported, 1);
    assert.deepEqual(
      readdirSync(outboxDir),
      ["t-1.json"],
      "同 taskId 覆盖写 ⇒ 第二次冷启动不产生第二份文件",
    );
    assert.deepEqual(await outbox2.flushOnce(), { attempted: 1, acked: 1 });
    assert.deepEqual(readdirSync(outboxDir), []);
    outbox2.stop();
  } finally {
    for (const d of [inflightDir, childrenDir, outboxDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("硬用例 ④（负向，仅登记现状、非设计承诺）：桥回 4xx 时 outbox 文件保留", async () => {
  const inflightDir = tmpDir("infl");
  const childrenDir = tmpDir("child");
  const outboxDir = tmpDir("outbox");
  try {
    inflightFile(inflightDir, makeRecord("t-1", "alpha"));
    const outbox = makeOutbox(outboxDir, async () => new Response("{}", { status: 404 }));
    await reconcileInflightOnStartup({
      inflightDir,
      machineId: MACHINE_ID,
      outbox,
      childrenDir,
      isAlive: () => false,
      logger: SILENT,
    });
    assert.deepEqual(await outbox.flushOnce(), { attempted: 1, acked: 0 });
    // 现状行为（无限退避重试，无 4xx 分流）——改造文档 §4 硬验收 (b)「被拒不无限重试」
    // 由后续节点落地，本用例仅锁定现状不被无意改坏，不作通过口径。
    assert.equal(existsSync(join(outboxDir, "t-1.json")), true);
    outbox.stop();
  } finally {
    for (const d of [inflightDir, childrenDir, outboxDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("损坏 / 非台账命名的 inflight 条目：跳过不动（宁漏勿误杀）；目录不存在 = 零上报不抛", async () => {
  const inflightDir = tmpDir("infl");
  const childrenDir = tmpDir("child");
  const outboxDir = tmpDir("outbox");
  try {
    writeFileSync(join(inflightDir, "t-broken.json"), "{not json", "utf8");
    writeFileSync(join(inflightDir, "notes.txt"), "ignore", "utf8");
    inflightFile(inflightDir, makeRecord("t-ok", "alpha"));

    const outbox = makeOutbox(outboxDir, async () => ignoredOk());
    const summary = await reconcileInflightOnStartup({
      inflightDir,
      machineId: MACHINE_ID,
      outbox,
      childrenDir,
      isAlive: () => false,
      logger: SILENT,
    });
    assert.equal(summary.reported, 1);
    assert.equal(existsSync(join(inflightDir, "t-broken.json")), true, "损坏条目保留");
    assert.equal(existsSync(join(inflightDir, "notes.txt")), true, "未知文件不动");

    // 目录不存在（inflightDir 子目录未创建过）⇒ 零上报、不抛
    const s2 = await reconcileInflightOnStartup({
      inflightDir: join(inflightDir, "no-such-dir"),
      machineId: MACHINE_ID,
      outbox,
      childrenDir: join(childrenDir, "no-such-dir"),
      logger: SILENT,
    });
    assert.deepEqual(s2, { reported: 0, skipped: 0, failed: 0, degraded: false });
    outbox.stop();
  } finally {
    for (const d of [inflightDir, childrenDir, outboxDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("deliver 落盘失败：台账条目保留待下次启动重试、degraded 置位、绝不抛出", async () => {
  const inflightDir = tmpDir("infl");
  const childrenDir = tmpDir("child");
  try {
    inflightFile(inflightDir, makeRecord("t-1", "alpha"));
    // outbox.dir 指向一个**文件**而非目录 ⇒ atomicWriteJson 必失败
    const blocker = join(inflightDir, "blocker");
    writeFileSync(blocker, "x", "utf8");
    const outbox = new FileOutbox({
      dir: blocker,
      bridge: BRIDGE,
      fetch: async () => ignoredOk(),
      logger: SILENT,
      sleep: async () => {},
    });
    const warns: string[] = [];
    const summary = await reconcileInflightOnStartup({
      inflightDir,
      machineId: MACHINE_ID,
      outbox,
      childrenDir,
      isAlive: () => false,
      logger: { warn: (m) => warns.push(m), info: (m) => void m },
    });
    assert.deepEqual(summary, { reported: 0, skipped: 0, failed: 1, degraded: true });
    assert.equal(existsSync(join(inflightDir, "t-1.json")), true, "上报失败 ⇒ 条目保留");
    assert.equal(warns.length, 1);
  } finally {
    for (const d of [inflightDir, childrenDir]) rmSync(d, { recursive: true, force: true });
  }
});
