/**
 * `orch/bridge/scheduler.ts` 单元测试（v0.4.0 拓扑并行，`node:test`，无新依赖）。
 *
 * 覆盖：
 * - 纯函数：`depStateOf`（依赖三态）/ `computeReadyNodes`（同批就绪）/ `propagateBlocked`
 *   （传递闭包）/ `reduceConvergence`（收敛判定）；
 * - 调度器行为：同层整批并发派发、三层防重派、失败传播置 blocked + Feature failed、
 *   全 completed 自动 integrating、`recover()` 并行收敛语义；
 * - v0.5.0 D5 续派时序硬闸（T1–T4）：`pendingEvidence` 未清时 `all_completed` 不得推进
 *   `integrating`（否则 re-arm 后的续派永久达不到）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 * 隔离：默认库固定 `:memory:`，每个用例先 `close()` 重置为空库。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  close,
  createFeature,
  createTask,
  EVENT_FEATURE_STATE,
  getFeature,
  getTask,
  listEvents,
  listFeatureTasks,
  markTaskExhausted,
  rearmForRetry,
  setTaskNotBefore,
  updateFeatureState,
  updateTaskState,
} from "../session/store.js";
import {
  EVIDENCE_EVENT_KIND,
  EVIDENCE_POLL_MS,
  EVIDENCE_READY_STREAK,
  EVIDENCE_WAIT_MAX_MS,
  EVENT_TASK_RETRY,
  FeatureScheduler,
  MAX_RETRY,
  buildRetryMessage,
  classifyFailure,
  computeReadyNodes,
  decideEvidenceOutcome,
  depStateOf,
  isEvidenceNode,
  isLocalTerminalTask,
  isNeutered,
  isPastNotBefore,
  markEvidenceMessage,
  propagateBlocked,
  reduceConvergence,
  type EvidenceResult,
  type FeatureDispatchResult,
} from "../bridge/scheduler.js";
import type { TaskRecord, TaskState } from "../types.js";

// 默认存储固定内存库（getDefaultStore 首次调用时读取）
process.env["SESSION_DB"] = ":memory:";

/** 构造测试用 TaskRecord（仅提供断言关心的字段）；`over` 覆盖 v0.4.1 新列等 */
function task(
  id: string,
  state: TaskState,
  dependencies: string[] | null = null,
  remoteTaskId: string | null = null,
  over: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    taskId: id,
    projectId: "p1",
    contextId: "c1",
    state,
    artifactsJson: null,
    text: null,
    prompt: null,
    updatedAt: "2026-01-01T00:00:00Z",
    // v0.5.0 三时刻列：调度判定不消费它们，默认取中性值（老记录形态 = 全 NULL）
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    featureId: "f1",
    dependencies,
    inputArtifacts: null,
    remoteTaskId,
    dispatchMessage: null,
    // v0.4.1 失败自动化列：默认取中性值（未中性化 / 无重试 / 无门）
    retryCount: 0,
    failureKind: null,
    exhausted: false,
    notBefore: null,
    lastPollAt: null,
    ...over,
  };
}

function byIdOf(nodes: readonly TaskRecord[]): Map<string, TaskRecord> {
  return new Map(nodes.map((n) => [n.taskId, n]));
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("depStateOf：无依赖 / 上游 completed → completed", () => {
  const nodes = [task("A", "completed"), task("B", "working", ["A"]), task("C", "working")];
  const byId = byIdOf(nodes);
  assert.equal(depStateOf(nodes[1]!, byId), "completed");
  assert.equal(depStateOf(nodes[2]!, byId), "completed");
});

test("depStateOf：上游未完成 → pending", () => {
  const nodes = [task("A", "working"), task("B", "input-required"), task("C", "working", ["A", "B"])];
  assert.equal(depStateOf(nodes[2]!, byIdOf(nodes)), "pending");
});

test("depStateOf：上游 failed / blocked → upstreamFailed", () => {
  const failed = [task("A", "failed"), task("B", "working", ["A"])];
  assert.equal(depStateOf(failed[1]!, byIdOf(failed)), "upstreamFailed");
  const blocked = [task("A", "blocked"), task("B", "working", ["A"])];
  assert.equal(depStateOf(blocked[1]!, byIdOf(blocked)), "upstreamFailed");
});

test("computeReadyNodes：同批取所有 working 且依赖完成、未派发、不在飞者", () => {
  const nodes = [
    task("A", "working"),
    task("B", "working"),
    task("C", "working", ["A"]), // 依赖未完成
    task("D", "working", null, "r-D"), // 已派发（远端 id 非空）
    task("E", "completed"), // 非 working
  ];
  assert.deepEqual(
    computeReadyNodes(nodes).map((n) => n.taskId),
    ["A", "B"],
  );
});

test("computeReadyNodes：节点级在飞标记使其不可再被选中", () => {
  const nodes = [task("A", "working"), task("B", "working")];
  assert.deepEqual(
    computeReadyNodes(nodes, new Set(["A"])).map((n) => n.taskId),
    ["B"],
  );
  assert.deepEqual(computeReadyNodes(nodes, new Set(["A", "B"])), []);
});

test("propagateBlocked：沿 dependencies 反向传递闭包（含多分支）", () => {
  const nodes = [
    task("A", "failed"),
    task("B", "working", ["A"]),
    task("C", "working", ["B"]),
    task("D", "working", ["A"]),
    task("E", "working"), // 无关联
  ];
  assert.deepEqual(new Set(propagateBlocked("A", nodes)), new Set(["B", "C", "D"]));
  assert.deepEqual(propagateBlocked("E", nodes), []);
});

test("propagateBlocked：中间节点已终态不阻断下探，且不改写非 working 节点", () => {
  const nodes = [
    task("A", "failed"),
    task("B", "completed", ["A"]), // 已完成：不置 blocked
    task("C", "working", ["B"]), // 但仍是 A 的下游闭包 → blocked
  ];
  assert.deepEqual(propagateBlocked("A", nodes), ["C"]);
});

test("reduceConvergence：failed / blocked → failed（优先于 needs_input）", () => {
  assert.equal(reduceConvergence([task("A", "failed")]).kind, "failed");
  assert.equal(reduceConvergence([task("A", "blocked")]).kind, "failed");
  assert.equal(
    reduceConvergence([task("A", "blocked"), task("B", "input-required")]).kind,
    "failed",
  );
});

test("reduceConvergence：input-required → needs_input", () => {
  assert.equal(reduceConvergence([task("A", "completed"), task("B", "input-required")]).kind, "needs_input");
});

test("reduceConvergence：全 completed → all_completed；否则 dispatch", () => {
  assert.equal(reduceConvergence([task("A", "completed"), task("B", "completed")]).kind, "all_completed");
  assert.equal(reduceConvergence([task("A", "completed"), task("B", "working")]).kind, "dispatch");
  assert.equal(reduceConvergence([task("A", "working")]).kind, "dispatch");
});

// ---------------------------------------------------------------------------
// v0.4.1：失败分类（§2.2）
// ---------------------------------------------------------------------------

test("classifyFailure：白名单 → infra（含 Prompt timeout after / interrupted / abandoned / 库锁 / 网络）", () => {
  assert.equal(classifyFailure("Prompt timeout after 600000ms"), "infra", "必须含 wrapper 超时");
  assert.equal(classifyFailure("PROMPT TIMEOUT AFTER 600s"), "infra", "大小写不敏感");
  // 桥重启 written text（FEATURE_INTERRUPTED_TEXT）与看护放弃 text（FEATURE_ABANDONED_TEXT）
  assert.equal(
    classifyFailure("任务因桥进程重启而中断（interrupted），未产出终态；请重新发起或重试。"),
    "infra",
  );
  assert.equal(
    classifyFailure("任务后台看护连续失败超限（abandoned），任务状态未知；请重新发起或重试。"),
    "infra",
  );
  assert.equal(classifyFailure("database is locked"), "infra");
  assert.equal(classifyFailure("fetch failed"), "infra");
  assert.equal(classifyFailure("ECONNREFUSED 127.0.0.1:3010"), "infra");
});

test("classifyFailure：未知文本 / 空 / null **安全降级 task**（不重试）", () => {
  assert.equal(classifyFailure("门禁未通过：3 个断言失败"), "task", "任务级失败不得误判 infra");
  assert.equal(classifyFailure("预期产物缺失"), "task");
  assert.equal(classifyFailure(""), "task");
  assert.equal(classifyFailure(null), "task");
  assert.equal(classifyFailure(undefined), "task");
});

// ---------------------------------------------------------------------------
// v0.4.1：中性化（exhausted ⇒ 视作 completed）
//   `exhausted` 节点 raw `state` 仍是 `failed`，5 处判定各需认它
// ---------------------------------------------------------------------------

test("中性化①depStateOf：exhausted 上游视作 completed ⇒ 下游可继续派发", () => {
  const neutered = [
    task("A", "failed", null, null, { exhausted: true }),
    task("B", "working", ["A"]),
  ];
  assert.equal(depStateOf(neutered[1]!, byIdOf(neutered)), "completed");
  // 对照：未中性化的 failed 上游仍是 upstreamFailed
  const plain = [task("A", "failed"), task("B", "working", ["A"])];
  assert.equal(depStateOf(plain[1]!, byIdOf(plain)), "upstreamFailed");
});

test("中性化②reduceConvergence 的 failed/blocked 计数：不计入 exhausted", () => {
  const nodes = [
    task("A", "failed", null, null, { exhausted: true }),
    task("B", "completed"),
  ];
  assert.notEqual(reduceConvergence(nodes).kind, "failed", "中性化节点不得把 Feature 判 failed");
});

test("中性化③all_completed 专门用例：取证成功且工作已做完 ⇒ 可推进 integrating（最致命一处）", () => {
  // 失败节点已被中性化（raw state 仍 failed）+ 工作节点全部 completed
  const nodes = [
    task("A", "failed", null, null, { exhausted: true }),
    task("B", "completed"),
  ];
  const convergence = reduceConvergence(nodes);
  assert.equal(
    convergence.kind,
    "all_completed",
    "漏认中性化 ⇒ 恒不满足 every(completed) ⇒ Feature 永久卡 executing",
  );
});

test("中性化④computeReadyNodes：exhausted 节点不参与派发", () => {
  const nodes = [
    task("A", "working", null, null, { exhausted: true }),
    task("B", "working"),
  ];
  assert.deepEqual(
    computeReadyNodes(nodes).map((n) => n.taskId),
    ["B"],
  );
});

test("中性化⑤isLocalTerminalTask：exhausted 节点视作本地终态（不误查远端）", () => {
  assert.equal(isLocalTerminalTask(task("A", "failed", null, null, { exhausted: true })), true);
  // 对照：既有语义不变（completed/failed/input-required/blocked 本就是本地终态）
  assert.equal(isLocalTerminalTask(task("A", "failed")), true);
  assert.equal(isLocalTerminalTask(task("A", "blocked")), true);
  assert.equal(isLocalTerminalTask(task("A", "input-required")), true);
  assert.equal(isLocalTerminalTask(task("A", "completed")), true);
  // 非终态
  assert.equal(isLocalTerminalTask(task("A", "working")), false);
  // 中性化判定单列（与 state 解耦）
  assert.equal(isNeutered({ exhausted: true }), true);
  assert.equal(isNeutered({ exhausted: false }), false);
});

// ---------------------------------------------------------------------------
// v0.4.1：持久化派发门 not_before（§2.3）
// ---------------------------------------------------------------------------

test("computeReadyNodes：not_before 未到不被选中；到点被选中（门=持久化，非内存态）", () => {
  const nowMs = Date.parse("2026-09-15T10:00:00.000Z");
  const nodes = [
    task("A", "working", null, null, { notBefore: "2026-09-15T10:05:00.000Z" }), // 未到
    task("B", "working", null, null, { notBefore: null }), // 无门
    task("C", "working", null, null, { notBefore: "2026-09-15T09:59:00.000Z" }), // 已过
  ];
  assert.deepEqual(
    computeReadyNodes(nodes, undefined, nowMs).map((n) => n.taskId),
    ["B", "C"],
    "门未到者必须不被派出（否则「登记即就绪」绕过硬路径）",
  );
  assert.deepEqual(
    computeReadyNodes(nodes, undefined, Date.parse("2026-09-15T10:05:00.000Z")).map((n) => n.taskId),
    ["A", "B", "C"],
    "到点即恢复可派（<= now 含相等）",
  );
});

test("isPastNotBefore：NULL / 已过 ⇒ 可派；损坏时间戳按「无门」处理（不永久卡死）", () => {
  assert.equal(isPastNotBefore(task("A", "working")), true);
  assert.equal(
    isPastNotBefore(task("A", "working", null, null, { notBefore: "2026-09-15T09:59:00.000Z" }),
      Date.parse("2026-09-15T10:00:00.000Z")),
    true,
  );
  assert.equal(
    isPastNotBefore(task("A", "working", null, null, { notBefore: "2026-09-15T10:05:00.000Z" }),
      Date.parse("2026-09-15T10:00:00.000Z")),
    false,
  );
  assert.equal(
    isPastNotBefore(task("A", "working", null, null, { notBefore: "not-a-timestamp" })),
    true,
    "坏值不阻塞派发（避免坏值把 Feature 永久卡在 executing）",
  );
});

// ---------------------------------------------------------------------------
// v0.4.1：常量与单测可注入（避免真等 10min）
// ---------------------------------------------------------------------------

test("v0.4.1 常量：MAX_RETRY=1 / 等回收门上界 10min / 轮询 5s，且经 options 可注入", () => {
  assert.equal(MAX_RETRY, 1, "N=1：只同 ctx 续一次（防死循环承重件）");
  assert.equal(EVIDENCE_WAIT_MAX_MS, 600_000);
  assert.equal(EVIDENCE_POLL_MS, 5_000);

  const bare = new FeatureScheduler({ dispatch: () => Promise.resolve({ ok: true }) });
  assert.equal(bare.maxRetry, MAX_RETRY);
  assert.equal(bare.evidenceWaitMaxMs, EVIDENCE_WAIT_MAX_MS);
  assert.equal(bare.evidencePollMs, EVIDENCE_POLL_MS);

  const injected = new FeatureScheduler({
    dispatch: () => Promise.resolve({ ok: true }),
    maxRetry: 0,
    evidenceWaitMaxMs: 50,
    evidencePollMs: 5,
  });
  assert.equal(injected.maxRetry, 0);
  assert.equal(injected.evidenceWaitMaxMs, 50);
  assert.equal(injected.evidencePollMs, 5);
});

// ---------------------------------------------------------------------------
// 调度器行为（内存库）
// ---------------------------------------------------------------------------

test("拓扑并行：同层无依赖节点在同一批并发派发，跨层仍按依赖串行", async () => {
  close();
  createFeature({ featureId: "f-par", title: "并行", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-par" });
  createTask({ taskId: "B", projectId: "p1", contextId: "c1", state: "working", featureId: "f-par" });
  createTask({
    taskId: "C",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-par",
    dependencies: ["A"],
  });

  const started: string[] = [];
  const resolvers: Array<() => void> = [];
  let inflight = 0;
  let peak = 0;
  const scheduler = new FeatureScheduler({
    dispatch: (node) => {
      started.push(node.taskId);
      inflight += 1;
      peak = Math.max(peak, inflight);
      return new Promise<FeatureDispatchResult>((resolve) => {
        resolvers.push(() => {
          inflight -= 1;
          resolve({ ok: true });
        });
      });
    },
  });

  scheduler.kick(); // 同步段内完成就绪计算 + 整批启动
  assert.deepEqual(started.slice().sort(), ["A", "B"]);
  assert.equal(peak, 2, "A/B 应同时在飞（并发派发）");
  assert.ok(!started.includes("C"), "C 依赖 A，不应在本批派发");

  for (const release of resolvers) release();
  await new Promise((r) => setImmediate(r));
  assert.equal(getFeature("f-par")?.state, "executing");
});

test("三层防重派：派发进行中重复 kick 不重派同一节点", async () => {
  close();
  createFeature({ featureId: "f-dup", title: "防重", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-dup" });

  let calls = 0;
  let release: () => void = () => {};
  const scheduler = new FeatureScheduler({
    dispatch: () => {
      calls += 1;
      return new Promise<FeatureDispatchResult>((resolve) => {
        release = () => resolve({ ok: true });
      });
    },
  });

  scheduler.kick();
  assert.equal(calls, 1);
  scheduler.kick(); // 模拟 settle 重入
  scheduler.kick();
  assert.equal(calls, 1, "批门闩 + 在飞标记应拦下重派");

  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
});

test("失败传播：上游 failed → 下游传递闭包置 blocked，Feature 收敛 failed", () => {
  close();
  createFeature({ featureId: "f-fail", title: "失败", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-fail" });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-fail",
    dependencies: ["A"],
  });
  createTask({
    taskId: "C",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-fail",
    dependencies: ["B"],
  });

  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
  updateTaskState("A", "failed", null, "boom");
  scheduler.notifyTaskSettled("f-fail", "A", { state: "failed", text: "boom" });

  assert.equal(getTask("A")?.state, "failed");
  assert.equal(getTask("B")?.state, "blocked");
  assert.equal(getTask("C")?.state, "blocked");
  assert.equal(getFeature("f-fail")?.state, "failed");
});

test("派发失败：该节点置 failed + 下游 blocked + Feature failed", async () => {
  close();
  createFeature({ featureId: "f-dispfail", title: "派发失败", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-dispfail" });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-dispfail",
    dependencies: ["A"],
  });

  const scheduler = new FeatureScheduler({
    dispatch: async () => ({ ok: false, error: "ensure 超时" }),
  });
  scheduler.kick();
  await new Promise((r) => setImmediate(r));

  assert.equal(getTask("A")?.state, "failed");
  assert.equal(getTask("B")?.state, "blocked");
  assert.equal(getFeature("f-dispfail")?.state, "failed");
});

test("收敛：全部任务 completed → Feature executing → integrating", () => {
  close();
  createFeature({ featureId: "f-done", title: "完成", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "completed", featureId: "f-done" });
  createTask({ taskId: "B", projectId: "p1", contextId: "c1", state: "completed", featureId: "f-done" });

  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
  scheduler.kick();
  assert.equal(getFeature("f-done")?.state, "integrating");
  assert.equal(getTask("A")?.state, "completed");
});

test("recover：收集全部在飞节点各置 failed(interrupted)，Feature failed 且不重派", () => {
  close();
  createFeature({ featureId: "f-rec", title: "恢复", state: "executing" });
  createTask({
    taskId: "A",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-rec",
    remoteTaskId: "r-A",
  });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-rec",
    remoteTaskId: "r-B",
  });
  createTask({ taskId: "C", projectId: "p1", contextId: "c1", state: "working", featureId: "f-rec" });

  let dispatched = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async () => {
      dispatched += 1;
      return { ok: true };
    },
  });
  const summary = scheduler.recover();

  assert.equal(summary.scanned, 1);
  assert.equal(summary.interruptedTasks, 2);
  assert.equal(summary.failedFeatures, 1);
  assert.equal(getTask("A")?.state, "failed");
  assert.equal(getTask("B")?.state, "failed");
  assert.equal(getTask("C")?.state, "working", "未派发节点不应被改写");
  assert.equal(getFeature("f-rec")?.state, "failed");
  assert.equal(dispatched, 0, "recover 不重派");
});

test("recover：无在飞任务的 executing Feature 保持，等待续推", () => {
  close();
  createFeature({ featureId: "f-idle", title: "空闲", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-idle" });

  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
  const summary = scheduler.recover();

  assert.equal(summary.scanned, 1);
  assert.equal(summary.interruptedTasks, 0);
  assert.equal(summary.failedFeatures, 0);
  assert.equal(getFeature("f-idle")?.state, "executing");
  assert.equal(getTask("A")?.state, "working");
});

// ---------------------------------------------------------------------------
// v0.4.1：infra 处置判定 + 中性化写入 + 取证决策（§2.2 / §2.3 / §2.4 / §2.5）
// ---------------------------------------------------------------------------

const INFRA_TEXT = "Prompt timeout after 600000ms";

test("buildRetryMessage：中性固定模板（三段齐全、原文照附、不含决策内容）", () => {
  const msg = buildRetryMessage("原任务：改 X");
  assert.ok(msg.includes("【自动重试 · 第 1/1 次 · 同会话续接】"));
  assert.ok(msg.includes("上一次执行在约 600s 时被客户端超时中断"), "① 发生了什么");
  assert.ok(msg.includes("先核对当前工作区/会话状态"), "② 怎么继续：核现状");
  assert.ok(msg.includes("只把尚未完成的部分做完"), "② 怎么继续：不重写");
  assert.ok(msg.includes("先把改动落盘"), "② 怎么继续：接近上限先落盘");
  assert.ok(msg.includes("原任务内容如下（未变更）"));
  assert.ok(msg.includes("原任务：改 X"), "原 dispatch_message 全文照附（追加，不替换）");
  assert.ok(!msg.includes("只做"), "不得含决策内容（引擎不替宿主拍板 scope）");
});

test("decideEvidenceOutcome：§2.3 决策矩阵（无证据/不稳定/D 空/R 空门禁绿/可重试/用尽）", () => {
  const base: EvidenceResult = { stable: true, d: ["src/a.ts"], r: ["src/b.ts"], gatesOk: false };
  assert.equal(decideEvidenceOutcome(null, 0).kind, "needs_input", "无证据 ⇒ 交人");
  assert.equal(
    decideEvidenceOutcome({ ...base, stable: false }, 0).kind,
    "needs_input",
    "stable=false ⇒ 不拍板不重试",
  );
  assert.equal(decideEvidenceOutcome({ ...base, d: [] }, 0).kind, "needs_input", "D 空 ⇒ 不自动重做");
  assert.equal(
    decideEvidenceOutcome({ ...base, r: [], gatesOk: true }, 0).kind,
    "settle",
    "R 空且门禁绿 ⇒ 按成功收口",
  );
  assert.equal(decideEvidenceOutcome(base, 0).kind, "retry");
  assert.equal(decideEvidenceOutcome(base, MAX_RETRY).kind, "needs_input", "重试用尽 ⇒ 交人");
  // 注入 maxRetry 生效（单测可关掉重试）
  assert.equal(decideEvidenceOutcome(base, 0, 0).kind, "needs_input");
});

test("isEvidenceNode / markEvidenceMessage：角色标记（role flag）随消息持久化", () => {
  assert.equal(isEvidenceNode({ dispatchMessage: markEvidenceMessage("x"), prompt: null }), true);
  assert.equal(isEvidenceNode({ dispatchMessage: null, prompt: markEvidenceMessage("x") }), true);
  assert.equal(isEvidenceNode({ dispatchMessage: "普通任务", prompt: null }), false);
  assert.equal(isEvidenceNode({ dispatchMessage: null, prompt: null }), false);
});

test("infra 失败：先中性化后登记取证节点，不 propagate、不 failFeature、不 rearm", () => {
  close();
  createFeature({ featureId: "f-infra", title: "infra", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-infra" });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-infra",
    dependencies: ["A"],
  });

  const registered: Array<[string, string]> = [];
  let exhaustedAtRegister: boolean | null = null;
  const scheduler = new FeatureScheduler({
    dispatch: async () => ({ ok: true }),
    registerEvidenceNode: (featureId, failedTaskId) => {
      registered.push([featureId, failedTaskId]);
      exhaustedAtRegister = getTask(failedTaskId)?.exhausted ?? null;
    },
  });

  updateTaskState("A", "failed", null, INFRA_TEXT);
  scheduler.notifyTaskSettled("f-infra", "A", { state: "failed", text: INFRA_TEXT });

  assert.equal(getTask("A")?.exhausted, true, "必须已中性化（唯一写入点 markTaskExhausted）");
  assert.equal(getTask("A")?.state, "failed", "中性化不改写 state");
  assert.equal(getTask("A")?.failureKind, "infra", "失败原因落库（§4.1.13）");
  assert.deepEqual(registered, [["f-infra", "A"]], "必须请求登记取证节点");
  assert.equal(
    exhaustedAtRegister,
    true,
    "顺序硬约束：登记时失败节点必须**已**中性化（否则 reduceConvergence 立刻判 Feature failed）",
  );
  assert.equal(getFeature("f-infra")?.state, "executing", "取证期间 Feature 必须非终态");
  assert.equal(getTask("B")?.state, "working", "infra 分支不得 propagate（下游不被 blocked）");
});

test("task 类失败：维持现状（propagate → 下游 blocked → Feature failed）", () => {
  close();
  createFeature({ featureId: "f-taskcls", title: "task", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-taskcls" });
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-taskcls",
    dependencies: ["A"],
  });

  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
  scheduler.notifyTaskSettled("f-taskcls", "A", { state: "failed", text: "门禁未通过：3 个断言失败" });

  assert.equal(getTask("A")?.exhausted, false, "task 类不得中性化");
  assert.equal(getTask("A")?.failureKind, "task", "两类失败都落库（§4.1.13）");
  assert.equal(getTask("B")?.state, "blocked");
  assert.equal(getFeature("f-taskcls")?.state, "failed");
});

test("取证节点自身失败：直接 needs_input（不再取证、不 propagate、不 failFeature）", () => {
  close();
  createFeature({ featureId: "f-evfail", title: "取证失败", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "failed", featureId: "f-evfail" });
  markTaskExhausted("A");
  createTask({
    taskId: "EV",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-evfail",
    dispatchMessage: markEvidenceMessage("取证：跑 git status / diff / 门禁"),
  });

  let registered = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async () => ({ ok: true }),
    registerEvidenceNode: () => {
      registered += 1;
    },
  });
  updateTaskState("EV", "failed", null, INFRA_TEXT);
  scheduler.notifyTaskSettled("f-evfail", "EV", { state: "failed", text: INFRA_TEXT });

  assert.equal(getFeature("f-evfail")?.state, "needs_input");
  assert.equal(registered, 0, "取证节点失败**不得**再派第二个取证节点（防「取证套取证」）");
  assert.equal(getTask("A")?.state, "failed", "不得 propagate / 不得改写其他节点");
  assert.equal(getTask("EV")?.failureKind, null, "取证节点豁免：不参与 {infra, task} 分类，故不写此列");
});

test("取证节点派发失败：直接 needs_input（§4.1.8，不 failed、不 propagate）", async () => {
  seedPendingEvidence("f-evdisp");
  const scheduler = new FeatureScheduler({
    dispatch: async () => ({ ok: false, error: "ensure 超时" }),
    // 先让等回收门达标放行（未派发的取证节点会被门挡 ⇒ 这正是门生效的证据）
    probeProjectReady: () => ({ ready: true, reason: "offline" }),
    evidencePollMs: 1,
  });
  scheduler.kick(); // 门：streak=1 ⇒ 仍挡
  await gateSleep(5);
  assert.equal(getFeature("f-evdisp")?.state, "executing", "门未达标前不派发（故未触发派发失败）");
  scheduler.kick(); // 门：streak=2 ⇒ 放行 ⇒ 派发 ⇒ 失败
  await gateSleep(5);

  assert.equal(getFeature("f-evdisp")?.state, "needs_input");
  assert.equal(getTask("EV")?.state, "working", "不得置 failed（否则 Feature 直接终态）");
});

test("取证 settle 且 D 非空：条件重试同 ctx 续一次，retry_count 自增，且重试节点可被派发", () => {
  close();
  createFeature({ featureId: "f-retry", title: "重试", state: "executing" });
  createTask({
    taskId: "A",
    projectId: "p1",
    state: "failed",
    featureId: "f-retry",
    contextId: "ctx-A",
    remoteTaskId: "remote-A",
    dispatchMessage: "原始任务内容",
  });
  markTaskExhausted("A");
  createTask({
    taskId: "EV",
    projectId: "p1",
    contextId: "ctx-ev",
    state: "completed",
    featureId: "f-retry",
    dispatchMessage: markEvidenceMessage("取证"),
  });

  const scheduler = new FeatureScheduler({
    dispatch: async () => ({ ok: true }),
    resolveEvidence: () => ({ stable: true, d: ["src/a.ts"], r: ["src/b.ts"], gatesOk: false }),
  });
  scheduler.notifyTaskSettled("f-retry", "EV", { state: "completed", text: "done" });

  const a = getTask("A");
  assert.equal(a?.state, "working");
  assert.equal(a?.retryCount, 1, "retry_count 在 re-arm 时自增（不在 fail 时）");
  assert.equal(a?.remoteTaskId, null, "清远端 id 以便重派");
  assert.equal(a?.contextId, "ctx-A", "必须**同 ctx** 续接");
  assert.equal(a?.exhausted, false, "re-arm ⇒ 退出中性化（exhausted 必须已清）");
  assert.ok(a?.dispatchMessage?.includes("【自动重试 · 第 1/1 次 · 同会话续接】"));
  assert.ok(a?.dispatchMessage?.includes("原始任务内容"), "原消息全文照附");
  assert.equal(getFeature("f-retry")?.state, "executing", "重试不打扰 orch、Feature 保持 executing");
  assert.deepEqual(
    computeReadyNodes(listFeatureTasks("f-retry", { limit: 100 })).map((n) => n.taskId),
    ["A"],
    "exhausted 已被清 ⇒ 重试节点作为普通 working 节点自然可派",
  );

  // §4.1.13 可观测：恰好一条 task.retry（只在 retry 分支写）
  const retries = taskRetryEvents();
  assert.equal(retries.length, 1, "恰好一条 task.retry 事件");
  assert.equal(retries[0]?.taskId, "A");
  assert.equal(retries[0]?.payload["retryCount"], 1, "payload 带 re-arm 后的真实新值");
  assert.equal(retries[0]?.payload["failureKind"], "infra");
});

test("取证 settle 且重试用尽（retryCount ≥ MAX_RETRY）：交人（needs_input）", () => {
  close();
  createFeature({ featureId: "f-exhausted", title: "用尽", state: "executing" });
  createTask({
    taskId: "A",
    projectId: "p1",
    contextId: "c1",
    state: "failed",
    featureId: "f-exhausted",
    dispatchMessage: "orig",
  });
  markTaskExhausted("A");
  // 模拟「已重试过一次后又失败」：retry_count 0→1（rearmForRetry 的唯一自增点，且**清 exhausted**），
  // 随后第二次 infra 失败 ⇒ infra 分支会**再次中性化** ⇒ 必须复原 exhausted=1，否则本用例会
  // 因「定位不到失败节点」而**vacuous 通过**（分支身份由 decideEvidenceOutcome 矩阵单独覆盖）。
  assert.equal(rearmForRetry("A", "retry msg"), true);
  updateTaskState("A", "failed", null, INFRA_TEXT);
  assert.equal(markTaskExhausted("A"), true);
  assert.equal(getTask("A")?.retryCount, 1);
  assert.equal(getTask("A")?.exhausted, true);
  assert.equal(getTask("A")?.state, "failed");

  createTask({
    taskId: "EV",
    projectId: "p1",
    contextId: "ctx-ev",
    state: "completed",
    featureId: "f-exhausted",
    dispatchMessage: markEvidenceMessage("取证"),
  });

  const scheduler = new FeatureScheduler({
    dispatch: async () => ({ ok: true }),
    resolveEvidence: () => ({ stable: true, d: ["src/a.ts"], r: ["src/b.ts"], gatesOk: false }),
  });
  scheduler.notifyTaskSettled("f-exhausted", "EV", { state: "completed", text: "done" });

  assert.equal(getFeature("f-exhausted")?.state, "needs_input", "重试用尽 ⇒ 交人（不再自动重派）");
  assert.equal(getTask("A")?.retryCount, 1, "不得产生第 2 次重试（N=1 门槛承重）");
  assert.equal(taskRetryEvents().length, 0, "needs_input 分支**不写** task.retry");
});

test("补缺测①：store 级 all_completed ⇒ Feature 能推进 integrating（取证 settle 收口）", async () => {
  close();
  createFeature({ featureId: "f-settle", title: "收口", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "failed", featureId: "f-settle" });
  markTaskExhausted("A"); // raw state 仍 failed
  createTask({ taskId: "B", projectId: "p1", contextId: "c1", state: "completed", featureId: "f-settle" });
  createTask({
    taskId: "EV",
    projectId: "p1",
    contextId: "ctx-ev",
    state: "completed",
    featureId: "f-settle",
    dispatchMessage: markEvidenceMessage("取证"),
  });

  const scheduler = new FeatureScheduler({
    dispatch: async () => ({ ok: true }),
    resolveEvidence: () => ({ stable: true, d: ["src/a.ts"], r: [], gatesOk: true }),
  });
  scheduler.notifyTaskSettled("f-settle", "EV", { state: "completed", text: "ok" });
  await new Promise((r) => setImmediate(r));

  assert.equal(
    getFeature("f-settle")?.state,
    "integrating",
    "漏认 all_completed 的中性化 ⇒ 此处会永久卡在 executing（最致命一处）",
  );
  assert.equal(taskRetryEvents().length, 0, "settle 分支**不写** task.retry");
});

test("补缺测②：中性化第 6 处 —— exhausted 失败节点不触发传播，下游不被 blocked 且可继续派发", () => {
  close();
  createFeature({ featureId: "f-sweep", title: "传播扫描", state: "executing" });
  createTask({
    taskId: "A",
    projectId: "p1",
    contextId: "c1",
    state: "failed",
    featureId: "f-sweep",
    remoteTaskId: "r-A",
  });
  markTaskExhausted("A");
  createTask({
    taskId: "B",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId: "f-sweep",
    dependencies: ["A"],
  });

  const started: string[] = [];
  const scheduler = new FeatureScheduler({
    dispatch: async (node) => {
      started.push(node.taskId);
      return { ok: true };
    },
  });
  scheduler.kick();

  assert.equal(getTask("B")?.state, "working", "B 不得被置 blocked（否则中性化被整条击穿）");
  assert.deepEqual(started, ["B"], "中性化后 A 的下游 B 必须可继续派发");
  assert.equal(getFeature("f-sweep")?.state, "executing", "Feature 不得被判 failed");
});

// ---------------------------------------------------------------------------
// v0.4.1：等回收门（§2.3 ③ / §2.5）—— tick 驱动，探测靠注入 stub
// ---------------------------------------------------------------------------

const gateSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 造「executing Feature + 待派发取证节点」场景 */
function seedPendingEvidence(featureId: string): void {
  close();
  createFeature({ featureId, title: "等回收门", state: "executing" });
  createTask({
    taskId: "EV",
    projectId: "p1",
    contextId: "c1",
    state: "working",
    featureId,
    dispatchMessage: markEvidenceMessage("取证：跑 git status / diff / 门禁"),
  });
}

/** 统计 `task.evidence` 转折点事件数（按 phase） */
function evidencePhases(): string[] {
  return listEvents({ limit: 1000 })
    .filter((e) => e.kind === EVIDENCE_EVENT_KIND)
    .map((e) => String(JSON.parse(e.payload ?? "{}")["phase"]));
}

/** 取 `task.retry` 事件（§4.1.13：宿主经 `a2a_events` 应能看到重试发生） */
function taskRetryEvents(): Array<{ taskId: string | null; payload: Record<string, unknown> }> {
  return listEvents({ limit: 1000 })
    .filter((e) => e.kind === EVENT_TASK_RETRY)
    .map((e) => ({
      taskId: e.taskId,
      payload: JSON.parse(e.payload ?? "{}") as Record<string, unknown>,
    }));
}

test("等回收门①：未达标 ⇒ 取证节点不被派发，not_before 被持久化续挡（且只留 1 条转折点事件）", async () => {
  seedPendingEvidence("f-gate1");
  const started: string[] = [];
  let probes = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async (node) => {
      started.push(node.taskId);
      return { ok: true };
    },
    probeProjectReady: () => {
      probes += 1;
      return { ready: false, reason: "online" };
    },
    evidencePollMs: 60_000, // 节流：本用例内不会二次探测
  });

  scheduler.kick();
  await gateSleep(5);
  scheduler.kick();
  await gateSleep(5);

  assert.deepEqual(started, [], "未达标不得派发取证节点");
  const ev = getTask("EV");
  assert.equal(ev?.state, "working");
  assert.ok(ev?.notBefore !== null, "必须写**持久化**挡板（非内存态，否则桥重启即绕过硬路径）");
  assert.ok(Date.parse(ev.notBefore) > Date.now(), "挡板指向未来");
  assert.ok(ev?.lastPollAt !== null, "已记录探测时间（供节流）");
  assert.equal(probes, 1, "60s 节流内只探测一次");
  assert.deepEqual(evidencePhases(), ["wait_start"], "严禁每次轮询都写事件（只写转折点）");
});

test("等回收门②：需连续 2 次达标（debounce）才清门放行", async () => {
  seedPendingEvidence("f-gate2");
  const started: string[] = [];
  let probes = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async (node) => {
      started.push(node.taskId);
      return { ok: true };
    },
    probeProjectReady: () => {
      probes += 1;
      return { ready: true, reason: "offline" };
    },
    evidencePollMs: 1, // 允许快速二次探测
  });

  scheduler.kick(); // 第 1 次达标 ⇒ streak=1 ⇒ 仍挡
  await gateSleep(5);
  assert.deepEqual(started, [], "第 1 次达标不得放行（debounce 覆盖 stop() 优雅期窗口）");
  assert.ok(getTask("EV")?.notBefore !== null, "仍在门内");

  scheduler.kick(); // 第 2 次达标 ⇒ streak=2 ⇒ 放行
  await gateSleep(5);
  assert.equal(probes, EVIDENCE_READY_STREAK, "恰好 2 次探测");
  assert.equal(getTask("EV")?.notBefore, null, "达标后必须清门");
  assert.deepEqual(started, ["EV"], "放行后由既有 tick 正常派发");
  assert.deepEqual(evidencePhases(), ["wait_start", "wait_ready"]);
});

test("等回收门③：上界到点 ⇒ 放行（转软校验 = 一等路径）", async () => {
  seedPendingEvidence("f-gate3");
  const started: string[] = [];
  let probes = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async (node) => {
      started.push(node.taskId);
      return { ok: true };
    },
    probeProjectReady: () => {
      probes += 1;
      return { ready: false, reason: "online" };
    },
    evidenceWaitMaxMs: 0, // 上界立即到点
    evidencePollMs: 60_000,
  });

  scheduler.kick();
  await gateSleep(5);

  assert.equal(getTask("EV")?.notBefore, null, "上界到点必须清门放行");
  assert.deepEqual(started, ["EV"], "放行后派发（软校验由取证节点自采 ①②）");
  assert.equal(probes, 0, "上界判定先于探测");
  assert.deepEqual(evidencePhases(), ["wait_timeout"]);
});

test("等回收门④：503 / starting / 不可达 一律视作未就绪（不放行）", async () => {
  for (const reason of ["503", "starting", "unreachable"]) {
    seedPendingEvidence(`f-gate4-${reason}`);
    const started: string[] = [];
    const scheduler = new FeatureScheduler({
      dispatch: async (node) => {
        started.push(node.taskId);
        return { ok: true };
      },
      probeProjectReady: () => ({ ready: false, reason }),
      evidencePollMs: 1,
    });

    for (let i = 0; i < 3; i += 1) {
      scheduler.kick();
      await gateSleep(3);
    }

    assert.deepEqual(started, [], `${reason}：不得放行`);
    assert.ok(getTask("EV")?.notBefore !== null, `${reason}：仍在门内`);
  }
});

test("等回收门⑤：last_poll_at 节流 —— 同一轮询间隔内不重复探测", async () => {
  seedPendingEvidence("f-gate5");
  let probes = 0;
  const scheduler = new FeatureScheduler({
    dispatch: async () => ({ ok: true }),
    probeProjectReady: () => {
      probes += 1;
      return { ready: false, reason: "online" };
    },
    evidencePollMs: 60_000,
  });

  scheduler.kick();
  await gateSleep(3);
  scheduler.kick();
  await gateSleep(3);
  scheduler.kick();
  await gateSleep(3);

  assert.equal(probes, 1, "一次性 3 次 tick 也只探测一次");
  assert.deepEqual(evidencePhases(), ["wait_start"], "节流期间不产生新事件");
});

test("等回收门⑥：探测不在 dispatch 内 await ⇒ drain() 不被长门阻塞", async () => {
  seedPendingEvidence("f-gate6");
  const scheduler = new FeatureScheduler({
    dispatch: async () => ({ ok: true }),
    probeProjectReady: () => ({ ready: false, reason: "online" }),
    evidencePollMs: 1, // 门会持续续挡，但不得占用在飞标记
  });

  scheduler.kick();
  await gateSleep(5);

  const drained = await scheduler.drain(50);
  assert.equal(drained, true, "门不占 dispatching/inFlightNodes ⇒ 立即可排空（不阻塞停机）");
  assert.ok(getTask("EV")?.notBefore !== null, "节点仍被挡（drain 不改变门）");
});

// ---------------------------------------------------------------------------
// v0.5.0 D5：续派时序硬闸（`hasPendingEvidenceDecision`）
//
// ⚠️ 本组用例**必须走真实 infra 路径**填 `pendingEvidence`：`updateTaskState("A","failed")`
//    → `notifyTaskSettled(infra)`，并由 stub **真建取证节点**（镜像 `index.ts:registerEvidenceNode`：
//    建节点 + `markEvidenceMessage` 角色标记 + `setTaskNotBefore` 初始挡板）。
//    既有 helper `seedPendingEvidence`（上方）**只建节点、不填 map** ⇒ 用它写本组用例会 **vacuous**
//    （闸谓词的 `pendingEvidence.has(...)` 恒为假，闸根本不会触发）。
// ---------------------------------------------------------------------------

/** 取某 Feature 的 `feature.state` 事件（可按目标态过滤）——用于 kill-shot 的「事件数 = 0 / 恰 1」断言 */
function featureStateEvents(
  featureId: string,
  state?: string,
): Array<{ featureId: string | null; state: string | null }> {
  return listEvents({ limit: 1000 })
    .filter((e) => e.kind === EVENT_FEATURE_STATE && e.featureId === featureId)
    .filter((e) => state === undefined || e.state === state)
    .map((e) => ({ featureId: e.featureId, state: e.state }));
}

/**
 * 镜像 `index.ts:registerEvidenceNode` 的**实质动作**：真建取证节点（含角色标记）+ 初始持久化挡板。
 * 只记录不建节点的 stub 会让闸谓词的 `nodes.some(isEvidenceNode)` 恒为假 ⇒ 用例 vacuous。
 */
function realRegisterEvidenceNode(featureId: string, failedTaskId: string): void {
  const failed = getTask(failedTaskId);
  assert.ok(failed !== null, "取证登记时失败节点必须已在库（镜像 index.ts 的前置检查）");
  const message = markEvidenceMessage("取证：跑 git status / diff / 门禁");
  createTask({
    taskId: "EV",
    projectId: failed.projectId,
    contextId: "ctx-ev",
    state: "working",
    prompt: message,
    featureId,
    dispatchMessage: message,
  });
  setTaskNotBefore("EV", new Date(Date.now() + EVIDENCE_POLL_MS).toISOString());
}

/**
 * 用**公开入口**造「A 以 infra 失败 ⇒ 取证节点已登记」场景（= 闸的前置条件）。
 * `notifyTaskSettled` 的 infra 分支会真实执行 `markTaskExhausted` + `pendingEvidence.set`
 * + `registerEvidenceNode`（stub 真建节点）；**不** 走私有 map 直写。
 */
function seedRealInfraEvidence(featureId: string, scheduler: FeatureScheduler): void {
  close();
  createFeature({ featureId, title: "D5 续派时序", state: "executing" });
  createTask({
    taskId: "A",
    projectId: "p1",
    contextId: "ctx-A",
    state: "working",
    featureId,
    dispatchMessage: "原始任务内容",
  });
  updateTaskState("A", "failed", null, INFRA_TEXT);
  scheduler.notifyTaskSettled(featureId, "A", { state: "failed", text: INFRA_TEXT });
}

test("T1（D5 主场景 · push 先行形状）：决策未落时不得 integrating；决策 retry 后续派", async () => {
  const scheduler = new FeatureScheduler({
    dispatch: async () => ({ ok: true }),
    registerEvidenceNode: (featureId, failedTaskId) => realRegisterEvidenceNode(featureId, failedTaskId),
    resolveEvidence: () => ({ stable: true, d: ["src/a.ts"], r: ["src/b.ts"], gatesOk: false }),
  });
  seedRealInfraEvidence("f-d5-t1", scheduler);

  // 前置证据：真实 infra 路径确实生效（否则本组用例 vacuous）
  assert.equal(getTask("A")?.exhausted, true, "infra 分支必须已中性化（map 的写入路径）");
  assert.equal(getTask("A")?.state, "failed", "中性化不改写 state");
  const ev = getTask("EV");
  assert.ok(ev !== null, "取证节点已由 stub 真建出（镜像 index.ts 的登记动作）");
  assert.equal(ev.state, "working", "登记时取证节点为待派发 working");
  assert.equal(isEvidenceNode(ev), true, "角色标记随消息落库 ⇒ 闸谓词第 ② 条成立");

  // 第 1 步：模拟 push 先行，把取证节点预写为 completed（= 收敛会提前成立的 D5 形状）
  updateTaskState("EV", "completed");
  scheduler.kick();
  await new Promise((r) => setImmediate(r));

  assert.equal(
    getFeature("f-d5-t1")?.state,
    "executing",
    "kill-shot：存在待决策取证流 ⇒ all_completed 必须被闸拦下（否则续派永不可达）",
  );
  assert.equal(featureStateEvents("f-d5-t1", "integrating").length, 0, "不得推进 integrating");
  assert.equal(featureStateEvents("f-d5-t1", "failed").length, 0, "也不得被判 failed");

  // 第 2 步：看护 settle 取证节点 ⇒ 决策 retry ⇒ 同 ctx 续派
  scheduler.notifyTaskSettled("f-d5-t1", "EV", { state: "completed", text: "done" });
  await new Promise((r) => setImmediate(r));

  const retries = taskRetryEvents();
  assert.equal(retries.length, 1, "恰好 1 条 task.retry（续派 kill-shot）");
  assert.equal(retries[0]?.taskId, "A");
  const a = getTask("A");
  assert.equal(a?.state, "working", "re-arm 后节点回到 working（可被 tick 续派）");
  assert.equal(a?.retryCount, 1, "retry_count 自增 1");
  assert.equal(a?.remoteTaskId, null, "清远端 id 以便续派");
  assert.equal(getFeature("f-d5-t1")?.state, "executing", "重试在飞，Feature 保持 executing");
});

test("T2（settle 穿闸收口）：闸不挡合法 integrating（恰 1 条）", async () => {
  const scheduler = new FeatureScheduler({
    dispatch: async () => ({ ok: true }),
    registerEvidenceNode: (featureId, failedTaskId) => realRegisterEvidenceNode(featureId, failedTaskId),
    resolveEvidence: () => ({ stable: true, d: ["x"], r: [], gatesOk: true }),
  });
  seedRealInfraEvidence("f-d5-t2", scheduler);

  updateTaskState("EV", "completed");
  scheduler.kick();
  await new Promise((r) => setImmediate(r));
  assert.equal(getFeature("f-d5-t2")?.state, "executing", "决策未落 ⇒ 仍被闸拦下");
  assert.equal(featureStateEvents("f-d5-t2", "integrating").length, 0);

  scheduler.notifyTaskSettled("f-d5-t2", "EV", { state: "completed", text: "ok" });
  await new Promise((r) => setImmediate(r));

  assert.equal(
    getFeature("f-d5-t2")?.state,
    "integrating",
    "settle 出口已清 map ⇒ 合法 integrating 不得被闸误挡",
  );
  assert.equal(featureStateEvents("f-d5-t2", "integrating").length, 1, "恰 1 条");
  assert.equal(taskRetryEvents().length, 0, "settle 分支不写 task.retry");
});

test("T3（needs_input 出口清 map / 防死锁 · 锁 A2-1）：回到 executing 后必须能 integrating", async () => {
  const scheduler = new FeatureScheduler({
    dispatch: async () => ({ ok: true }),
    registerEvidenceNode: (featureId, failedTaskId) => realRegisterEvidenceNode(featureId, failedTaskId),
    resolveEvidence: () => null,
  });
  seedRealInfraEvidence("f-d5-t3", scheduler);

  updateTaskState("EV", "completed");
  scheduler.notifyTaskSettled("f-d5-t3", "EV", { state: "completed", text: "done" });
  assert.equal(getFeature("f-d5-t3")?.state, "needs_input", "无证据 ⇒ 交人");

  // 澄清补齐后回到 executing（宿主 advance(to=executing, answer=…) 的等价形态）
  updateFeatureState("f-d5-t3", "executing");
  scheduler.kick();
  await new Promise((r) => setImmediate(r));

  assert.equal(
    getFeature("f-d5-t3")?.state,
    "integrating",
    "若「交人」出口未清 map ⇒ 闸继续拦 ⇒ 永久停 executing（本用例即红）",
  );
  assert.equal(featureStateEvents("f-d5-t3", "integrating").length, 1);
});

test("T4（无取证节点负例 · 锁 A2-3 结构锚）：map 有条目但无取证节点 ⇒ 不得误困 executing", async () => {
  // ⚠️ 刻意**不注入** registerEvidenceNode：map 会被填，但**不会**建出取证节点
  const scheduler = new FeatureScheduler({ dispatch: async () => ({ ok: true }) });
  close();
  createFeature({ featureId: "f-d5-t4", title: "无取证节点", state: "executing" });
  createTask({ taskId: "A", projectId: "p1", contextId: "c1", state: "working", featureId: "f-d5-t4" });
  createTask({ taskId: "B", projectId: "p1", contextId: "c1", state: "completed", featureId: "f-d5-t4" });

  updateTaskState("A", "failed", null, INFRA_TEXT);
  scheduler.notifyTaskSettled("f-d5-t4", "A", { state: "failed", text: INFRA_TEXT });
  assert.equal(getTask("A")?.exhausted, true, "infra 分支仍会中性化并填 map");
  const a = getTask("A");
  assert.ok(a !== null, "A 必须存在");
  assert.equal(isEvidenceNode(a), false, "A 不是取证节点（结构锚：节点集内无取证节点）");

  scheduler.kick();
  await new Promise((r) => setImmediate(r));

  assert.equal(
    getFeature("f-d5-t4")?.state,
    "integrating",
    "裸 `has(map)` 会误困 executing ⇒ 谓词必须同时要求 nodes.some(isEvidenceNode)",
  );
  assert.equal(featureStateEvents("f-d5-t4", "integrating").length, 1);
});
