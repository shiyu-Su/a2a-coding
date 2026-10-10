/**
 * v0.10.2 **O-2**（REQ-2026-10-09-01 · 改造文档 §2.3 F-C1 / F-M2 · §3.1 orch「做」条）——
 * 职责位「**入参与透传**」（声明链三段：入参 → 落库列 → 命令顶层单键）。
 *
 * 三条验收判据（对应节点任务书）：
 * ① **非法值结构化拒绝**：`a2aCallSchema.taskType` 用 `z.enum(TASK_TYPES)` 收窄 ⇒ `safeParse` 失败，
 *    错误文案含四个合法值（**不兜底归一** —— 「未声明」才缺省 `unit_agent`）；
 * ② **inquiry 携带 `taskType` ⇒ 放行**（v0.10.2 增补三 E-1：原 F-C1 的跨字段拒下线）：
 *    `a2aCallArgsSchema` 不再挂 `superRefine` 拦该组合，`validateCallMode` / `taskTypeFieldIssues`
 *    两路同源；错误码 `task_type_not_allowed_for_inquiry` **退役**，`taskType` 相关只剩值域一码
 *    `task_type_invalid`。并验 **inquiry 侧声明链**：带职责位 ⇒ 落 `tasks.task_type`、
 *    `lane` 仍 `read`（**不占写闸**）、经**同一** `toDispatchCommand` 带顶层键；不传 ⇒ 逐字现状；
 * ③ **非缺省透传为顶层键、缺省不带键**：`toDispatchCommand` 逐字照 `readOnly?: true` 形制
 *    （只挂命令顶层、**不进 `payload`**；`unit_agent` 缺省 ⇒ 键**不出现**）—— 断言直接调
 *    **导出的生产函数**，不再手抄命令体，防与 `bridge/runner.ts` 漂移。
 *
 * 附：**混跑留痕 warn**（F-C1「未消费 warn 留痕带原值」，照 v0.8.8 `failure_kind_fallback=<原值>`
 * 形制）⇒ 走真实 `/runner/connect` 领取链，`bridgeLog` 定向到临时文件后断言。
 *
 * **不做什么** 的回归锁：`readOnly` 语义未变 / inquiry 恒 `lane=read` / 未新建错误码族 /
 * `contextId` 生成规则未动（缺省仍走 `randomUUID`）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  a2aCallArgsSchema,
  a2aCallSchema,
  taskTypeFieldIssues,
  validateCallMode,
  validateCallTaskType,
} from "../bridge/register-tools.js";
import {
  claimTask,
  close as closeStore,
  createFeature,
  createTask,
  enqueueTask,
  getTask,
  runnerProjectsReplace,
  upsertRunner,
} from "../session/store.js";
import { TASK_TYPES } from "../types.js";
import { configureBridgeLog } from "../bridge/bridge-log.js";
import {
  RUNNER_CONNECT_PATH,
  RUNNER_REGISTER_PATH,
  createRunnerEndpoints,
  toDispatchCommand,
  type RunnerEndpointHandle,
} from "../bridge/runner.js";
import { startHttpTransport, type HttpTransportHandle } from "../bridge/transports/http.js";
import type { BridgeCore } from "../bridge/index.js";
import type { MachineRef, MachinesConfig } from "../types.js";

// ---------------------------------------------------------------------------
// ① 非法值结构化拒绝（z.enum 收窄 + 文案含四值）
// ---------------------------------------------------------------------------

const callArgs = z.object(a2aCallSchema);

/** `dist/test` → 上溯两级 = orch 单元根（同 `v0102-o1-task-type.test.ts` 的静态锚形制） */
const HERE = dirname(fileURLToPath(import.meta.url));

/** orch 声明链源码（静态锚：退役错误码不得残留） */
function registerToolsSource(): string {
  return readFileSync(resolve(HERE, "..", "..", "bridge", "register-tools.ts"), "utf8");
}

test("① 非法值 ⇒ schema safeParse 失败；文案含四个合法值（TASK_TYPES 全清单）", () => {
  const parsed = callArgs.safeParse({
    project: "orch",
    message: "m",
    mode: "execute",
    featureId: "f-x",
    taskType: "boss",
  });
  assert.equal(parsed.success, false, "闭集外 ⇒ 拒");
  const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join("；");
  for (const v of TASK_TYPES) {
    assert.ok(message.includes(v), `文案必须含合法值 ${v}（实得：${message}）`);
  }
});

test("① 合法四值逐个可解析（`unit_agent` 显式声明也合法）", () => {
  for (const taskType of TASK_TYPES) {
    const parsed = callArgs.safeParse({
      project: "orch",
      message: "m",
      mode: "execute",
      featureId: "f-ok",
      taskType,
    });
    assert.equal(parsed.success, true, `taskType=${taskType} 应可解析`);
  }
});

test("① 缺省（不带键）⇒ 解析通过、值为 undefined（**不兜底归一** = 交给落库读侧归一）", () => {
  const parsed = callArgs.safeParse({
    project: "orch",
    message: "m",
    mode: "execute",
    featureId: "f-ok",
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.taskType, undefined, "缺省 ⇒ 键值为 undefined（不是兜底 unit_agent）");
});

test("① `validateCallTaskType` 纯函数兜底同判据（网页 / 直接调用共用）", () => {
  assert.deepEqual(validateCallTaskType(undefined), { ok: true });
  assert.deepEqual(validateCallTaskType(""), { ok: true });
  for (const v of TASK_TYPES) {
    assert.deepEqual(validateCallTaskType(v), { ok: true }, `${v} 应放行`);
  }
  const bad = validateCallTaskType("ceo");
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.code, "task_type_invalid");
  for (const v of TASK_TYPES) {
    assert.ok(bad.error.includes(v), `拒绝文案必须含合法值 ${v}（实得：${bad.error}）`);
  }
});

// ---------------------------------------------------------------------------
// ② inquiry 携带 taskType ⇒ **放行**（v0.10.2 增补三 E-1：F-C1 的跨字段拒已下线）
// ---------------------------------------------------------------------------

test("② schema 层：inquiry + taskType ⇒ **解析通过**（跨字段拒随增补三下线）", () => {
  for (const taskType of TASK_TYPES) {
    const parsed = a2aCallArgsSchema.safeParse({
      project: "orch",
      message: "m",
      mode: "inquiry",
      taskType,
    });
    assert.equal(parsed.success, true, `inquiry 携 taskType=${taskType} ⇒ 放行（E-1）`);
  }
});

test("② inquiry + 缺省 taskType ⇒ 放行（缺省只对「未声明」成立）", () => {
  const ok = a2aCallArgsSchema.safeParse({
    project: "orch",
    message: "只读核实",
    mode: "inquiry",
  });
  assert.equal(ok.success, true);
});

test("② validateCallMode：inquiry + taskType ⇒ 放行；featureId 对偶拦不动", () => {
  assert.deepEqual(
    validateCallMode({ mode: "inquiry", taskType: "product_manager" }),
    { ok: true },
    "E-1：职责位与 mode 正交，inquiry 携带不再被拦",
  );
  assert.deepEqual(validateCallMode({ mode: "inquiry", taskType: "" }), { ok: true });
  // 既有对偶拦（不属本增补的改动面）
  const withFeature = validateCallMode({ mode: "inquiry", featureId: "f" });
  assert.equal(withFeature.ok, false);
  if (withFeature.ok) return;
  assert.equal(withFeature.code, "feature_not_allowed_for_inquiry");
});

test("② taskTypeFieldIssues：值域一码仍在（inquiry 也校验非法值）", () => {
  const wrong = taskTypeFieldIssues({
    project: "orch",
    message: "m",
    mode: "execute",
    featureId: "f",
    taskType: "ceo",
  });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.code, "task_type_invalid");

  const inquiryWrong = taskTypeFieldIssues({
    project: "orch",
    message: "m",
    mode: "inquiry",
    taskType: "boss",
  });
  assert.equal(inquiryWrong.ok, false, "放开携带 ≠ 放开值域");
  if (!inquiryWrong.ok) assert.equal(inquiryWrong.code, "task_type_invalid");

  const okInquiry = taskTypeFieldIssues({
    project: "orch",
    message: "m",
    mode: "inquiry",
    taskType: "product_manager",
  });
  assert.deepEqual(okInquiry, { ok: true });
});

test("② E-1 锚点：退役错误码不再被产出（声明链源码无该码的产出点）", () => {
  const src = registerToolsSource();
  assert.doesNotMatch(
    src,
    /code: "task_type_not_allowed_for_inquiry"/,
    "跨字段拒已下线，该码不得再有产出点",
  );
  assert.doesNotMatch(src, /taskType !== undefined/, "superRefine 的跨字段拒判据不得残留");
});

// ---------------------------------------------------------------------------
// 桥日志捕获（写文件 ⇒ 可断言「warn 带原值」，形制同 o1-sixclass）
// ---------------------------------------------------------------------------

const logDir = mkdtempSync(join(tmpdir(), "a2a-o2-log-"));

function captureLog(name: string): () => string {
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
// ③ 声明链第二段：`core.registerFeatureNode(…, taskType)` ⇒ 落 `tasks.task_type`
// ---------------------------------------------------------------------------

// 默认零出站桩（同 o-n4 形制）；混跑留痕用例临时切回真 fetch 走 loopback HTTP
const originalFetch = globalThis.fetch; // 先保留原生 fetch 引用（供混跑用例切回）
const zeroOutboundStub: typeof globalThis.fetch = async (input) => {
  throw new Error(`单测未预期的出站请求：${String(input)}`);
};
globalThis.fetch = zeroOutboundStub;

const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-o2-cfg-"));
const CFG_PATH = join(CFG_DIR, "config.json");
process.env["MACHINES_CONFIG"] = CFG_PATH; // 必须在 import bridge/index.js **之前**
writeFileSync(CFG_PATH, JSON.stringify({ machines: [{ machineId: "m-o2" }] }, null, 2));

const { createCore } = await import("../bridge/index.js");
const core = createCore();

const transports: HttpTransportHandle[] = [];

after(async () => {
  for (const transport of transports) await transport.close();
  globalThis.fetch = originalFetch;
  configureBridgeLog({ file: null });
  rmSync(logDir, { recursive: true, force: true });
  rmSync(CFG_DIR, { recursive: true, force: true });
  closeStore();
});

function okOrThrow<T extends { ok: boolean }>(v: T, what: string): Extract<T, { ok: true }> {
  assert.equal(v.ok, true, `${what} 应成功：${JSON.stringify(v)}`);
  return v as Extract<T, { ok: true }>;
}

upsertRunner({ runnerId: "m-o2", machineId: "m-o2", protocolVersion: "2.3" });
runnerProjectsReplace("m-o2", [
  { projectId: "alpha", agentKind: "opencode", a2aPort: 3010, status: "online" },
  { projectId: "alpha-dispatch", agentKind: "opencode", a2aPort: 3011, status: "online" },
  { projectId: "alpha-mixed", agentKind: "opencode", a2aPort: 3012, status: "online" },
]);

test("③ registerFeatureNode 传非缺省 taskType ⇒ 落库列取该值", () => {
  createFeature({ featureId: "f-t", title: "职责位", state: "executing" });
  const outcome = okOrThrow(
    core.registerFeatureNode(
      "alpha",
      "本侧方案贡献",
      undefined,
      "f-t",
      [],
      undefined,
      undefined,
      "dev_manager",
    ),
    "登记 dev_manager 节点",
  );
  assert.equal(getTask(outcome.taskId!)?.taskType, "dev_manager");
});

test("③ registerFeatureNode 缺省 taskType ⇒ 落库 NULL ⇒ 读侧归一 unit_agent（**不显式兜底写值**）", () => {
  createFeature({ featureId: "f-d", title: "缺省职责位", state: "executing" });
  const outcome = okOrThrow(
    core.registerFeatureNode("alpha", "既有派发", undefined, "f-d", []),
    "登记缺省节点",
  );
  assert.equal(getTask(outcome.taskId!)?.taskType, "unit_agent", "读侧归一 unit_agent");
});

// ---------------------------------------------------------------------------
// ②′ E-1（增补三）：inquiry 携带 taskType ⇒ 落库 + lane 仍 read + 同一命令装配链带顶层键
// ---------------------------------------------------------------------------

test("②′ inquiry 带 taskType ⇒ 建行落 tasks.task_type，lane 仍 read", async () => {
  const outcome = okOrThrow(
    await core.call("alpha", "接不接（PM 表态轮）", undefined, false, "inquiry", "product_manager"),
    "inquiry 带 product_manager",
  );
  const rec = getTask(outcome.taskId!);
  assert.equal(rec?.taskType, "product_manager", "E-1：inquiry 的职责位声明落库");
  assert.equal(rec?.lane, "read", "读档语义不变（不因职责位升写档、不占写闸）");
});

test("②′ inquiry 不传 taskType ⇒ 逐字现状（读侧归一 unit_agent、仍 read 档）", async () => {
  const outcome = okOrThrow(
    await core.call("alpha", "纯事实核实", undefined, false, "inquiry"),
    "inquiry 不带职责位",
  );
  const rec = getTask(outcome.taskId!);
  assert.equal(rec?.taskType, "unit_agent", "⑤ 不传 ⇒ 逐字现状");
  assert.equal(rec?.lane, "read");
});

test("②′ inquiry 行经**同一** toDispatchCommand 链 ⇒ 非缺省带顶层键、缺省不带键", async () => {
  const declared = okOrThrow(
    await core.call(
      "alpha-dispatch",
      "接不接（PM 表态轮）",
      undefined,
      false,
      "inquiry",
      "product_manager",
    ),
    "inquiry 带职责位（declared）",
  );
  const def = okOrThrow(
    await core.call("alpha-dispatch", "纯事实核实", undefined, false, "inquiry"),
    "inquiry 不带职责位（default）",
  );

  function claimAndCommand(taskId: string): Record<string, unknown> {
    const claimed = claimTask({
      claimedBy: "m-o2",
      claimToken: `ct-${taskId}`,
      projectIds: ["alpha-dispatch"],
    });
    assert.notEqual(claimed, null, `任务 ${taskId} 应被领取`);
    if (claimed === null) throw new Error("unreachable");
    assert.equal(claimed.taskId, taskId, "领取到的应是本 inquiry 行");
    assert.equal(claimed.lane, "read", "inquiry 行领取后仍是只读档（不占写闸）");
    return toDispatchCommand(claimed) as unknown as Record<string, unknown>;
  }

  const declaredCmd = claimAndCommand(declared.taskId!);
  assert.equal(declaredCmd.taskType, "product_manager", "E-1：inquiry 派发命令带顶层 taskType");
  assert.equal(declaredCmd.readOnly, true, "读档 ⇒ 命令带 readOnly=true（不受职责位影响）");

  const defCmd = claimAndCommand(def.taskId!);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(defCmd, "taskType"),
    "不传 ⇒ 命令不含 taskType 键（⑤ 逐字现状）",
  );
  assert.equal(defCmd.readOnly, true);
});

// ---------------------------------------------------------------------------
// ③ 声明链第三段：`toDispatchCommand` 顶层单键（不进 payload；缺省不带键）
//    断言直接调**导出的生产函数**（`bridge/runner.ts` 的 `toDispatchCommand`），
//    避免与命令装配判据漂移；「键在顶层」= hasOwnProperty，「不进 payload」= 命令体内该键
//    至多出现一次（顶层唯一）。
// ---------------------------------------------------------------------------

function dispatchFor(
  taskId: string,
  projectId: string,
  taskType?: (typeof TASK_TYPES)[number],
): Record<string, unknown> {
  createTask({
    taskId,
    projectId,
    contextId: `ctx-${taskId}`,
    state: "working",
    ...(taskType === undefined ? {} : { taskType }),
    dispatchMessage: `dispatch task ${taskId}`,
    prompt: taskId,
  });
  assert.notEqual(enqueueTask(taskId), null, `任务 ${taskId} 应成功入队`);
  const claimed = claimTask({
    claimedBy: "m-o2",
    claimToken: `ct-${taskId}`,
    projectIds: [projectId],
  });
  assert.notEqual(claimed, null, `任务 ${taskId} 应被领取`);
  if (claimed === null) throw new Error("unreachable");
  // 命令体直接用**生产函数**装配（不再手抄，防与 bridge/runner.ts 漂移）
  return toDispatchCommand(claimed) as unknown as Record<string, unknown>;
}

test("③ 非缺省 taskType ⇒ 命令顶层带该键；缺省 ⇒ **不带键**（hasOwnProperty false）", () => {
  const declared = dispatchFor("t-declared", "alpha-dispatch", "project_manager");
  assert.equal(declared.taskType, "project_manager", "非缺省 ⇒ 顶层带键");
  assert.ok(
    Object.prototype.hasOwnProperty.call(declared, "taskType"),
    "键必须在顶层（不进 payload）",
  );
  const serialized = JSON.stringify(declared);
  const occurrences = serialized.split('"taskType"').length - 1;
  assert.equal(occurrences, 1, `taskType 键在命令体中至多出现一次（顶层）：${serialized}`);

  const def = dispatchFor("t-default", "alpha-dispatch");
  assert.ok(
    !Object.prototype.hasOwnProperty.call(def, "taskType"),
    "缺省（unit_agent）⇒ 命令不含 taskType 键（undefined = 对端按 unit_agent）",
  );

  const explicit = dispatchFor("t-explicit-default", "alpha-dispatch", "unit_agent");
  assert.ok(
    !Object.prototype.hasOwnProperty.call(explicit, "taskType"),
    "显式 unit_agent ⇒ 同样不带键（缺省档一律不带）",
  );
});

// ---------------------------------------------------------------------------
// 混跑留痕 warn（F-C1；照 v0.8.8 `failure_kind_fallback=<原值>` 形制）
//   走真 `/runner/connect` 领取链 ⇒ 触发 emitClaim ⇒ 断言日志文本含 task_type_unconsumed=<原值>
// ---------------------------------------------------------------------------

function unused(name: string): never {
  throw new Error(`unused BridgeCore method: ${name}`);
}

/** 内核桩：混跑用例只触达 `/runner/*`，MCP 面调用即失败 */
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
    featureTrace: () => unused("featureTrace"),
    configWriteGroup: async () => unused("configWriteGroup"),
    kickScheduler: () => unused("kickScheduler"),
  };
}

function makeHarnessConfig(machineId: string, token: string): MachinesConfig {
  const machines: MachineRef[] = [{ machineId, launcherUrl: "", token }];
  return {
    machines,
    transport: { mode: "http", http: { host: "127.0.0.1", port: 0, path: "/mcp" } },
    web: { enabled: false, host: "127.0.0.1", port: 0 },
    runner: { holdMs: 60, heartbeatTimeoutMs: 60_000, orphanTimeoutMs: 1_800_000 },
  };
}

async function startMixedRunHarness(
  cfg: MachinesConfig,
): Promise<{ port: number; handle: RunnerEndpointHandle }> {
  const handle = createRunnerEndpoints({ role: () => "owner", config: () => cfg });
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
  return { port: transport.port, handle };
}

interface HttpResult {
  status: number;
  text: string;
  body: unknown;
}

async function postJson(
  port: number,
  path: string,
  body: unknown,
  token: string,
): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    /* 204 无体 */
  }
  return { status: res.status, text, body: parsed };
}

test("混跑留痕：真 /runner/connect 领取 ⇒ 非缺省 taskType ⇒ warn 带原值；缺省不 warn", async () => {
  // 切回原生 fetch（走 loopback HTTP）
  globalThis.fetch = originalFetch;

  const readLog = captureLog("mixed-run-non-default");
  const machineId = "m-o2-mixed";
  const token = "tok-mixed";
  const cfg = makeHarnessConfig(machineId, token);
  const h = await startMixedRunHarness(cfg);

  const reg = await postJson(
    h.port,
    RUNNER_REGISTER_PATH,
    {
      machineId,
      protocolVersion: "2.3",
      capabilities: {},
      projects: [{ projectId: "alpha-mixed", agentKind: "opencode", a2aPort: 3061 }],
    },
    token,
  );
  assert.equal(reg.status, 200, `Runner 注册应 200，实得 ${reg.status}：${reg.text}`);

  createTask({
    taskId: "t-warn-on",
    projectId: "alpha-mixed",
    contextId: "ctx-w-on",
    state: "working",
    taskType: "product_manager",
    dispatchMessage: "接不接（PM 表态轮）",
    prompt: "pm",
  });
  assert.notEqual(enqueueTask("t-warn-on"), null, "任务应成功入队");

  const dispatchRes = await postJson(h.port, RUNNER_CONNECT_PATH, { machineId }, token);
  assert.equal(dispatchRes.status, 200, `/connect 应返 dispatch，实得 ${dispatchRes.status}`);
  const envelope = (dispatchRes.body ?? {}) as { data?: Record<string, unknown> };
  const cmd = envelope.data ?? {};
  assert.equal(cmd["taskId"], "t-warn-on");
  assert.equal(cmd["taskType"], "product_manager", "命令顶层带非缺省 taskType");

  const logged = readLog();
  assert.match(logged, /"level":"warn"/, "混跑留痕必须是 warn 级");
  assert.match(
    logged,
    /task_type_unconsumed=product_manager/,
    `warn 必须带原值（实得日志：${logged}）`,
  );

  // 缺省档 ⇒ 无该 warn（避免噪音）；换新日志文件重捕
  const readLogQuiet = captureLog("mixed-run-default");
  createTask({
    taskId: "t-warn-off",
    projectId: "alpha-mixed",
    contextId: "ctx-w-off",
    state: "working",
    dispatchMessage: "缺省职责位（不 warn）",
    prompt: "default",
  });
  assert.notEqual(enqueueTask("t-warn-off"), null);
  const dispatchRes2 = await postJson(h.port, RUNNER_CONNECT_PATH, { machineId }, token);
  assert.equal(dispatchRes2.status, 200);
  const cmd2 = ((dispatchRes2.body ?? {}) as { data?: Record<string, unknown> }).data ?? {};
  assert.equal(cmd2["taskId"], "t-warn-off");
  assert.ok(
    !Object.prototype.hasOwnProperty.call(cmd2, "taskType"),
    "缺省档命令体不含 taskType 键",
  );
  const logged2 = readLogQuiet();
  assert.doesNotMatch(
    logged2,
    /task_type_unconsumed/,
    `缺省档不得产混跑 warn（实得：${logged2}）`,
  );

  // 恢复零出站桩，避免污染后续测试
  globalThis.fetch = zeroOutboundStub;
});

// ---------------------------------------------------------------------------
// 「不做什么」回归锁
// ---------------------------------------------------------------------------

test("不回归：readOnly 语义未变（`a2aCallSchema.readOnly` 仍是可选布尔、缺省 undefined）", () => {
  const t = callArgs.safeParse({
    project: "orch",
    message: "m",
    mode: "execute",
    featureId: "f",
    readOnly: true,
  });
  assert.equal(t.success, true);
  if (!t.success) return;
  assert.equal(t.data.readOnly, true);

  const d = callArgs.safeParse({
    project: "orch",
    message: "m",
    mode: "execute",
    featureId: "f",
  });
  assert.equal(d.success, true);
  if (!d.success) return;
  assert.equal(d.data.readOnly, undefined, "缺省 ⇒ 不兜底 false（保持既有语义）");
});

test("不回归：inquiry 恒 lane=read（E-1 只放开职责位声明，不动读档）", async () => {
  const outcome = okOrThrow(
    await core.call("alpha", "只读询问 taskType 不注入", undefined, false, "inquiry"),
    "inquiry 派发",
  );
  const rec = getTask(outcome.taskId!);
  assert.equal(rec?.lane, "read", "散活恒落只读档（O-N4 语义未变）");
  assert.equal(rec?.taskType, "unit_agent", "不传职责位 ⇒ 逐字现状（读侧归一 unit_agent）");
});

test("不回归：错误码族不扩张（taskType 相关只剩值域一码；跨字段码已随 E-1 退役）", () => {
  assert.equal(validateCallMode({ mode: "execute" }).ok, false);
  assert.equal(validateCallMode({ mode: "inquiry", featureId: "f" }).ok, false);
  assert.equal(validateCallMode({ mode: "inquiry", taskType: "project_manager" }).ok, true);
  const bad = validateCallTaskType("boss");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "task_type_invalid");
});

test("不回归：contextId 生成规则未动（缺省仍走 randomUUID，非 taskType 引入的固定值）", () => {
  createFeature({ featureId: "f-ctx", title: "contextId 未变", state: "executing" });
  const a = okOrThrow(
    core.registerFeatureNode("alpha", "节点 A", undefined, "f-ctx", [], undefined, undefined, "project_manager"),
    "登记 project_manager 节点 A",
  );
  const b = okOrThrow(
    core.registerFeatureNode("alpha", "节点 B", undefined, "f-ctx", [], undefined, undefined, "project_manager"),
    "登记 project_manager 节点 B",
  );
  const ctxA = getTask(a.taskId!)?.contextId;
  const ctxB = getTask(b.taskId!)?.contextId;
  assert.ok(ctxA && ctxB, "两节点都应有 contextId");
  assert.notEqual(ctxA, ctxB, "不同节点 ⇒ 独立 contextId（未因同 taskType 复用）");
  assert.match(ctxA!, /^[0-9a-f-]{36}$/i, "contextId 仍是 UUID 形制");
});
