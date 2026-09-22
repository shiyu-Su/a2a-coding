/**
 * v0.8.8 O1 单测（`node:test`，无新依赖）：六类闭集上移 + 兜底宽容 + 墙钟改判。
 *
 * 覆盖（改造文档 §2.1 / §4 判据 2 / 节点验收 ①②③）：
 * - **闭集派生**：`FailureKind` 取值 = `PROTOCOL.md` 2.3 的六类；旧二分 `infra` / `task` 不再合法。
 * - **入站兜底（D2 硬要求）**：`/runner/result` 对 `failureKind` **不整包 400 拒收** ——
 *   ① **缺键** 与 ② **旧值 `infra` / `task`** 一律落安全类 `business` + **warn 带原值**
 *   （`failure_kind_fallback=…`，缺键记 `?`），供事后区分「真 business」与「兜底 business」。
 * - **事实源移交**：machine 上报合格六类值 ⇒ orch **原样采纳**（不再二次分类）。
 * - **墙钟改判**：孤儿墙钟判死落「**不可续跑**」子类 `runner`，**断言与 `acp-prompt` 的 `timeout` 不同值**。
 * - **读侧放宽**：`failure_kind` 列的非法值（存量旧行）⇒ 兜底 + warn，**不再 fail-fast 崩读路径**。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionStore,
  claimTask,
  close as closeStore,
  createTask,
  enqueueTask,
  getTask,
  openStoreDatabase,
  upsertRunner,
} from "../session/store.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import {
  RUNNER_RESULT_PATH,
  createRunnerEndpoints,
  mapAcpErrorKindToFailureKind,
  resolveReportedFailureKind,
  type RunnerEndpointOptions,
} from "../bridge/runner.js";
import { configureBridgeLog } from "../bridge/bridge-log.js";
import type { BridgeCore } from "../bridge/index.js";
import { FAILURE_KINDS, ORPHAN_FAILURE_KIND } from "../types.js";
import type { FailureKind, MachineRef, MachinesConfig } from "../types.js";

// ---------------------------------------------------------------------------
// 脚手架（同 o3-failure-kind 先例：固定判决时钟 + fake core + 真 HTTP 端点）
// ---------------------------------------------------------------------------

const transports: HttpTransportHandle[] = [];

after(async () => {
  configureBridgeLog({ file: null });
  for (const transport of transports) await transport.close();
  closeStore();
});

function unused(name: string): never {
  throw new Error(`unused BridgeCore method: ${name}`);
}

function fakeCore(): BridgeCore {
  return {
    projects: async () => unused("projects"),
    tasks: async () => unused("tasks"),
    call: async () => unused("call"),
    registerFeatureNode: () => unused("registerFeatureNode"),
    taskStatus: async () => unused("taskStatus"),
    cancel: async () => unused("cancel"),
    events: () => unused("events"),
    wait: async () => unused("wait"),
    featureCreate: () => unused("featureCreate"),
    featureStatus: () => unused("featureStatus"),
    featureAdvance: () => unused("featureAdvance"),
    featureApprove: () => unused("featureApprove"),
    featureCancel: () => unused("featureCancel"),
    kickScheduler: () => unused("kickScheduler"),
  };
}

const NOW = Date.parse("2026-09-22T03:00:00.000Z");

function isoAt(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function makeConfig(machines: MachineRef[]): MachinesConfig {
  return {
    machines,
    transport: { mode: "http", http: { host: "127.0.0.1", port: 0, path: "/mcp" } },
    web: { enabled: false, host: "127.0.0.1", port: 0 },
    runner: { holdMs: 50, heartbeatTimeoutMs: 3_600_000, orphanTimeoutMs: 1_800_000 },
  };
}

function endpoints(overrides: Partial<RunnerEndpointOptions> = {}) {
  return createRunnerEndpoints({
    role: () => "owner",
    config: () => makeConfig([{ machineId: "m-o1", launcherUrl: "", token: "tok-o1" }]),
    now: () => NOW,
    sweepIntervalMs: 3_600_000, // 关闭自动循环：由用例显式驱动
    ...overrides,
  });
}

async function serve(handle: ReturnType<typeof createRunnerEndpoints>): Promise<number> {
  const transport = await startHttpTransport({
    core: fakeCore(),
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    isReady: () => true,
    role: () => "owner",
    version: "test",
    onShutdown: () => {
      /* 测试不触发停机 */
    },
    runner: handle,
  });
  transports.push(transport);
  return transport.port;
}

/** 入队 + 领取（`projectIds` 限定本项目：同进程共享 `:memory:` 库） */
function claim(taskId: string, projectId: string, claimToken: string, claimedAt: string): void {
  const claimed = claimTask({ claimedBy: "m-o1", claimToken, claimedAt, projectIds: [projectId] });
  assert.equal(claimed?.taskId, taskId, `任务 ${taskId} 应被领取`);
}

function seed(taskId: string, claimToken: string): void {
  createTask({
    taskId,
    projectId: "p-o1",
    contextId: `ctx-${taskId}`,
    state: "working",
    dispatchMessage: `${taskId}: run`,
    prompt: taskId,
  });
  assert.notEqual(enqueueTask(taskId), null);
  claim(taskId, "p-o1", claimToken, isoAt(0));
}

async function post(
  port: number,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${RUNNER_RESULT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok-o1" },
    body: JSON.stringify({ machineId: "m-o1", ...body }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 无体响应
  }
  return { status: res.status, data: (parsed["data"] ?? {}) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// 桥日志捕获（写文件 ⇒ 可断言「warn 带原值」）
// ---------------------------------------------------------------------------

const logDir = mkdtempSync(join(tmpdir(), "a2a-o1-log-"));
after(() => rmSync(logDir, { recursive: true, force: true }));

/** 把桥日志定向到临时文件，返回「读出全部 warn 文本」的函数 */
function captureWarns(name: string): () => string {
  const file = join(logDir, `${name}.log`);
  configureBridgeLog({ file });
  return () => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
}

// ---------------------------------------------------------------------------
// ① 闭集派生 + 兜底纯函数（不依赖库与 HTTP）
// ---------------------------------------------------------------------------

test("O1 闭集 = PROTOCOL 2.3 六类；旧二分值不再是成员", () => {
  assert.deepEqual([...FAILURE_KINDS].sort(), [
    "agent",
    "business",
    "model_queue",
    "runner",
    "timeout",
    "transport",
  ]);
  assert.doesNotMatch(JSON.stringify(FAILURE_KINDS), /"infra"|"task"/);
});

test("O1 兜底映射值域 = 六类安全值：spawn/closed ⇒ agent；其余 ⇒ business", () => {
  assert.equal(mapAcpErrorKindToFailureKind("spawn"), "agent");
  assert.equal(mapAcpErrorKindToFailureKind("closed"), "agent");
  for (const v of ["timeout", "rpc", "protocol", "whatever", undefined, null, 7]) {
    assert.equal(mapAcpErrorKindToFailureKind(v), "business", `输入 ${String(v)} ⇒ business`);
  }
});

test("O1 resolve 纯函数：合格六类值原样采纳（不 warn）；缺键 ⇒ ?；旧值/未知 ⇒ business + 原值", () => {
  for (const kind of FAILURE_KINDS) {
    assert.deepEqual(resolveReportedFailureKind(kind, "spawn"), { kind, fallbackFrom: null });
  }
  // 缺键 = machine 明说「判不出」⇒ 残余事实 acpErrorKind 决定安全值
  assert.deepEqual(resolveReportedFailureKind(undefined, "closed"), {
    kind: "agent",
    fallbackFrom: "?",
  });
  assert.deepEqual(resolveReportedFailureKind(undefined, undefined), {
    kind: "business",
    fallbackFrom: "?",
  });
  assert.deepEqual(resolveReportedFailureKind(null, "spawn"), { kind: "agent", fallbackFrom: "?" });
  // 旧值 / 未知值 ⇒ 不替 machine 复核它的分类主张（只落安全类 + 留原值）
  assert.deepEqual(resolveReportedFailureKind("infra", "spawn"), {
    kind: "business",
    fallbackFrom: "infra",
  });
  assert.deepEqual(resolveReportedFailureKind("task", undefined), {
    kind: "business",
    fallbackFrom: "task",
  });
  assert.deepEqual(resolveReportedFailureKind("nope", "closed"), {
    kind: "business",
    fallbackFrom: "nope",
  });
  assert.deepEqual(resolveReportedFailureKind(42, "closed"), {
    kind: "business",
    fallbackFrom: "42",
  });
});

// ---------------------------------------------------------------------------
// ② 混跑负向用例：入站不整包拒 + 落安全类 + warn 带原值
// ---------------------------------------------------------------------------

test("混跑 ①：缺 failureKind 键的载荷 ⇒ 桥不崩、不拒（200）、落 business、warn 带 ?", async () => {
  const warns = captureWarns("missing-key");
  const port = await serve(endpoints());
  upsertRunner({
    runnerId: "m-o1-a",
    machineId: "m-o1",
    protocolVersion: "1.0.0",
    state: "online",
  });

  seed("o1-mk-1", "ct-mk-1");
  const res = await post(port, {
    taskId: "o1-mk-1",
    claimToken: "ct-mk-1",
    state: "failed",
    text: "2.2 形态：判不出 ⇒ 不报该键",
  });
  assert.equal(res.status, 200, "缺键不得 400（硬校验 = 旧机丢单）");
  assert.equal(res.data["state"], "failed");
  assert.equal(getTask("o1-mk-1")?.failureKind, "business");
  const logged = warns();
  assert.match(logged, /"level":"warn"/);
  assert.match(logged, /failure_kind_fallback=\?/);
});

test("混跑 ②：旧值 infra / task 载荷 ⇒ 200 + 落 business + warn 能看出原值", async () => {
  const warns = captureWarns("legacy-values");
  const port = await serve(endpoints());
  upsertRunner({
    runnerId: "m-o1-b",
    machineId: "m-o1",
    protocolVersion: "1.0.0",
    state: "online",
  });

  for (const [legacy, taskId] of [
    ["infra", "o1-lg-infra"],
    ["task", "o1-lg-task"],
  ] as const) {
    seed(taskId, `ct-${taskId}`);
    const res = await post(port, {
      taskId,
      claimToken: `ct-${taskId}`,
      state: "failed",
      text: `2.2 形态旧值 ${legacy}`,
      failureKind: legacy,
    });
    assert.equal(res.status, 200, `旧值 ${legacy} 不得整包拒收`);
    assert.equal(getTask(taskId)?.failureKind, "business", `旧值 ${legacy} ⇒ 安全兜底类`);
  }
  const logged = warns();
  assert.match(logged, /failure_kind_fallback=infra/, "warn 必须带原值 infra");
  assert.match(logged, /failure_kind_fallback=task/, "warn 必须带原值 task");
});

test("混跑 ②b：2.2 完整形态（旧值 infra + acpErrorKind=spawn）⇒ 仍 business，orch 不二次分类", async () => {
  const warns = captureWarns("legacy-with-acp-kind");
  const port = await serve(endpoints());
  upsertRunner({
    runnerId: "m-o1-c",
    machineId: "m-o1",
    protocolVersion: "1.0.0",
    state: "online",
  });
  seed("o1-lg-22", "ct-lg-22");
  const res = await post(port, {
    taskId: "o1-lg-22",
    claimToken: "ct-lg-22",
    state: "failed",
    text: "2.2：failureKind=infra 且带原生 acpErrorKind",
    failureKind: "infra",
    diagnostics: { acpErrorKind: "spawn", elapsedMs: 10, stage: "wait" },
  });
  assert.equal(res.status, 200);
  assert.equal(
    getTask("o1-lg-22")?.failureKind,
    "business",
    "已成立的（旧）分类主张 ⇒ 不拿 acpErrorKind 复核（否则 orch 成第二套分类器）",
  );
  assert.match(warns(), /failure_kind_fallback=infra/);
});

test("正向：machine 上报合格六类值 ⇒ 原样采纳且零 warn（事实源已移交）", async () => {
  const warns = captureWarns("adopt-sixclass");
  const port = await serve(endpoints());
  upsertRunner({
    runnerId: "m-o1-d",
    machineId: "m-o1",
    protocolVersion: "1.0.0",
    state: "online",
  });
  const adopted: Array<[string, FailureKind]> = [
    ["o1-ad-transport", "transport"],
    ["o1-ad-timeout", "timeout"],
    ["o1-ad-agent", "agent"],
  ];
  for (const [taskId, kind] of adopted) {
    seed(taskId, `ct-${taskId}`);
    const res = await post(port, {
      taskId,
      claimToken: `ct-${taskId}`,
      state: "failed",
      text: `2.3 形态：${kind}`,
      failureKind: kind,
      diagnostics: { acpErrorKind: "spawn", elapsedMs: 10, stage: "poll" },
    });
    assert.equal(res.status, 200);
    assert.equal(
      getTask(taskId)?.failureKind,
      kind,
      "合格值不得被兜底映射改写（acpErrorKind=spawn 不得把它改成 agent）",
    );
  }
  assert.doesNotMatch(warns(), /failure_kind_fallback=/, "合格六类值不留兜底 warn");
});

// ---------------------------------------------------------------------------
// ③ 墙钟判死改判：落「不可续跑」子类，且不得与 acp-prompt 的 timeout 混淆
// ---------------------------------------------------------------------------

test("墙钟判死 ⇒ failure_kind = runner（不可续跑），断言与 acp-prompt 的 timeout 不同值", () => {
  const handle = endpoints();
  upsertRunner({
    runnerId: "m-o1-e",
    machineId: "m-o1",
    protocolVersion: "1.0.0",
    state: "online",
  });
  createTask({
    taskId: "o1-orphan-1",
    projectId: "p-o1-orphan",
    contextId: "ctx-o1-orphan-1",
    state: "working",
    dispatchMessage: "o1-orphan-1: run",
    prompt: "o1-orphan-1",
  });
  assert.notEqual(enqueueTask("o1-orphan-1"), null);
  // 领取时刻已超缺省 orphanTimeoutMs（30 min）⇒ 墙钟判死
  const claimed = claimTask({
    claimedBy: "m-o1",
    claimToken: "ct-orphan-1",
    claimedAt: isoAt(-1_800_001),
    projectIds: ["p-o1-orphan"],
  });
  assert.equal(claimed?.taskId, "o1-orphan-1");

  assert.deepEqual(handle.sweepOrphanedTasks().orphanedTasks, ["o1-orphan-1"]);

  const row = getTask("o1-orphan-1");
  assert.equal(row?.failureKind, ORPHAN_FAILURE_KIND);
  assert.equal(row?.failureKind, "runner", "载体侧事实（执行体已不在机上）");
  assert.notEqual(
    row?.failureKind,
    "timeout",
    "不得与场景 C 的 acp-prompt timeout 同值 —— 否则 trace 把「墙钟判死」显示成「本可续跑」",
  );
  assert.equal(row?.state, "failed");
});

// ---------------------------------------------------------------------------
// ④ 读侧放宽：存量非法值 ⇒ 兜底 + warn，不再崩读路径
// ---------------------------------------------------------------------------

test("读侧：failure_kind 存量旧值（infra）⇒ 落 business + warn，且读路径不抛", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "a2a-o1-read-")), "sessions.sqlite");
  const store = new SessionStore(dbPath);
  try {
    store.createTask({
      taskId: "o1-read-1",
      projectId: "p-o1-read",
      contextId: "c1",
      state: "failed",
    });
    assert.equal(store.setTaskFailureKind("o1-read-1", "business"), true);

    // 绕过类型，直连造「二分时代」的存量行（清洗归 §2.1 迁移脚本 = O8；迁移前读侧不得崩）
    const raw = openStoreDatabase(dbPath);
    try {
      raw.exec("UPDATE tasks SET failure_kind = 'infra' WHERE task_id = 'o1-read-1'");
    } finally {
      raw.close();
    }

    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    };
    let task: ReturnType<SessionStore["getTask"]>;
    try {
      task = store.getTask("o1-read-1");
    } finally {
      console.error = original;
    }
    assert.equal(
      task?.failureKind,
      "business",
      "非法存量值 ⇒ 安全兜底类（读侧放宽；旧口径此处直接 throw）",
    );
    assert.match(
      errors.join("\n"),
      /failure_kind_fallback=infra/,
      "读侧兜底同样须留原值痕迹",
    );
  } finally {
    store.close();
  }
});

test("读侧：合法六类值原样读回（放宽不等于放弃闭集）", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "a2a-o1-read-ok-")), "sessions.sqlite");
  const store = new SessionStore(dbPath);
  try {
    for (const kind of FAILURE_KINDS) {
      const taskId = `o1-read-${kind}`;
      store.createTask({ taskId, projectId: "p-o1-read2", contextId: "c", state: "failed" });
      assert.equal(store.setTaskFailureKind(taskId, kind), true);
      assert.equal(store.getTask(taskId)?.failureKind, kind);
    }
  } finally {
    store.close();
  }
});
