/**
 * v0.10.2 · 节点 M-2 定向单测（角色化：派发入参 `taskType` + 会话级 per-request 覆盖）。
 *
 * 覆盖改造文档 §2.3 的三条验收判据：
 * - **①**（F-C11）非法 / 未知职责位 ⇒ **intake 硬拒**：outbox 收到该 `taskId` 的 `failed` 终态
 *   + `failureKind=agent`（**不新增第 7 值**）+ 稳定 token `unknown_task_type=<原值>`，
 *   且**不登记台账 / 不过闸 / 不 ensure / 不发 A2A**（台账在 `startDispatch` 内才登记 ⇒ 静默丢弃
 *   只能等孤儿墙钟，故必须回传结果）；
 * - **②** 不传 `taskType` ⇒ **逐字现状**：`message/send` 载荷不落 `metadata` 键；桥侧两键都不落；
 *   会话方法序列与请求体与未引入本通路时一致；
 * - **③** override 与回落**两路可辨**：喂 override ⇒ 可观测（`set_config_option` / `set_mode` 取值变、
 *   首轮注入文本变、日志列出命中键）；不喂 / 空串 ⇒ 落构造器值。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { A2AFetch } from "../launcher/a2a-client.js";
import { postJsonRpc } from "../launcher/a2a-client.js";
import { InFlightLedger, type RunnerLogger } from "../launcher/runner.js";
import {
  RunnerCommandExecutor,
  buildDispatchMetadata,
  illegalTaskTypeDetail,
  parseRunnerCommand,
  roleOverridesOf,
  type RunnerExecHost,
  type RunnerOutbox,
  type RunnerResultCredential,
  type RunnerTaskResult,
} from "../launcher/runner-exec.js";
import type { ProjectConfig } from "../types.js";
import { A2A_OUTCOME_CONVENTION } from "../acp-bridge/outcome.js";
import { createAcpA2AServer, parseRoleIntent } from "../acp-bridge/a2a-server.js";
import { AcpSessionRunner, type AcpRequestClient } from "../acp-bridge/acp/session.js";
import type {
  TaskExecutionInput,
  TaskExecutionResult,
  TaskExecutor,
} from "../acp-bridge/types.js";

const STARTED_AT = "2026-09-18T00:00:00.000Z";
const ROLES_AGENT_CONFIG = {
  roles: {
    project_manager: { model: "override-model", systemPrompt: "override-prompt", risk: "read" },
    product_manager: { model: "pm-model" },
  },
} as const;

/* ------------------------------------------------------------------ *
 * A. 纯函数：token 拼装 / roles 宽容读点 / metadata 载体形状
 * ------------------------------------------------------------------ */

test("M-2 ①(c)：illegalTaskTypeDetail = 稳定 token 且原样回显（不归一、不修剪）", () => {
  assert.equal(illegalTaskTypeDetail("bogus_role"), "unknown_task_type=bogus_role");
  assert.equal(illegalTaskTypeDetail("  PM  "), "unknown_task_type=  PM  ");
  assert.equal(illegalTaskTypeDetail("中文职责位"), "unknown_task_type=中文职责位");
});

test("M-2 roles 读点：配了的角色 ⇒ 按 ROLE_CONFIG_KEYS 带出；取值非串 / 空串 ⇒ 该键不落", () => {
  assert.deepEqual(roleOverridesOf({ roles: { project_manager: { model: "m", risk: "read" } } }, "project_manager"), {
    model: "m",
    risk: "read",
  });
  assert.deepEqual(
    roleOverridesOf({ roles: { project_manager: { model: "", systemPrompt: "s", risk: 42 } } }, "project_manager"),
    { systemPrompt: "s" },
  );
  assert.deepEqual(roleOverridesOf({ roles: { project_manager: { unknownKnob: "x" } } }, "project_manager"), {});
});

test("M-2 roles 读点：未配 / 形态不合规 ⇒ 空对象（等价「未配 ⇒ 逐字现状」，本侧不校验）", () => {
  assert.deepEqual(roleOverridesOf(undefined, "project_manager"), {});
  assert.deepEqual(roleOverridesOf({}, "project_manager"), {});
  assert.deepEqual(roleOverridesOf({ roles: "not-an-object" }, "project_manager"), {});
  assert.deepEqual(roleOverridesOf({ roles: [] }, "project_manager"), {});
  assert.deepEqual(roleOverridesOf({ roles: { project_manager: "not-an-object" } }, "project_manager"), {});
  assert.deepEqual(roleOverridesOf({ roles: { project_manager: { model: "m" } } }, "unit_agent"), {});
});

test("M-2 ②：buildDispatchMetadata 未传 taskType ⇒ undefined（发送体不落 metadata 键）", () => {
  assert.equal(buildDispatchMetadata(undefined, { roles: ROLES_AGENT_CONFIG.roles }), undefined);
});

test("M-2 metadata 形状：taskType 必带 + 本机 roles 配了才带；他位配置不外泄", () => {
  assert.deepEqual(buildDispatchMetadata("project_manager", { roles: ROLES_AGENT_CONFIG.roles }), {
    taskType: "project_manager",
    model: "override-model",
    systemPrompt: "override-prompt",
    risk: "read",
  });
  assert.deepEqual(buildDispatchMetadata("dev_manager", { roles: ROLES_AGENT_CONFIG.roles }), {
    taskType: "dev_manager",
  });
  assert.deepEqual(buildDispatchMetadata("unit_agent", undefined), { taskType: "unit_agent" });
});

/* ------------------------------------------------------------------ *
 * B. launcher intake（判据① + ② 端到端）
 * ------------------------------------------------------------------ */

test("M-2 解析层宽容透传：合法 / 非法串都落键；缺键 / 非串 / 空串 ⇒ 视为未传", () => {
  const legal = parseRunnerCommand({
    command: "dispatch",
    taskId: "t1",
    projectId: "alpha",
    payload: "hi",
    taskType: "project_manager",
  }) as { taskType?: string };
  assert.equal(legal.taskType, "project_manager");

  const illegal = parseRunnerCommand({
    command: "dispatch",
    taskId: "t1",
    projectId: "alpha",
    payload: "hi",
    taskType: "bogus_role",
  }) as { taskType?: string };
  assert.equal(illegal.taskType, "bogus_role", "非法值须透到 intake，不得在解析层静默丢弃");

  for (const raw of [undefined, "", 42, null, true]) {
    const parsed = parseRunnerCommand({
      command: "dispatch",
      taskId: "t1",
      projectId: "alpha",
      payload: "hi",
      ...(raw === undefined ? {} : { taskType: raw }),
    }) as { taskType?: string };
    assert.equal("taskType" in parsed, false, `「${String(raw)}」应视为未传（现状形态）`);
  }
});

interface Delivery {
  result: RunnerTaskResult;
  credential?: RunnerResultCredential;
}

/** 捕获 outbox 投递（含回传凭证）—— 拒收路径必须交卷，故凭证也得可断言。 */
function captureDeliveries(): { outbox: RunnerOutbox; deliveries: Delivery[]; wait: () => Promise<Delivery> } {
  const deliveries: Delivery[] = [];
  let resolveFn: ((d: Delivery) => void) | null = null;
  const first = new Promise<Delivery>((resolve) => {
    resolveFn = resolve;
  });
  return {
    deliveries,
    outbox: {
      deliver: (result, credential) => {
        const d: Delivery = { result, ...(credential !== undefined ? { credential } : {}) };
        deliveries.push(d);
        if (resolveFn !== null) {
          const done = resolveFn;
          resolveFn = null;
          done(d);
        }
      },
    },
    wait: () => first,
  };
}

function makeFixtures(project: ProjectConfig): {
  host: RunnerExecHost;
  ledger: InFlightLedger;
  outbox: RunnerOutbox;
  wait: () => Promise<Delivery>;
  ensured: string[];
  bodies: Record<string, unknown>[];
  methods: string[];
  logs: string[];
  fetch: A2AFetch;
  logger: RunnerLogger;
} {
  const ensured: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const methods: string[] = [];
  const logs: string[] = [];
  const cap = captureDeliveries();
  const host: RunnerExecHost = {
    ensure: async (projectId) => {
      ensured.push(projectId);
      return { endpoint: "http://127.0.0.1:4321" };
    },
    stop: async () => ({ stopped: true }),
    getProject: (projectId) => {
      if (projectId !== project.projectId) throw new Error(`未知项目：${projectId}`);
      return project;
    },
  };
  const fetchFn: A2AFetch = async (_url, init) => {
    const req = JSON.parse(String(init.body)) as { method: string; params: unknown };
    methods.push(req.method);
    bodies.push(req.params as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-1",
        result: {
          id: "a2a-1",
          status: { state: "completed", message: { role: "agent", parts: [{ kind: "text", text: "ok" }] } },
          artifacts: [],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const logger: RunnerLogger = {
    info: (m) => void logs.push(`info ${m}`),
    warn: (m) => void logs.push(`warn ${m}`),
    error: (m) => void logs.push(`error ${m}`),
  };
  return {
    host,
    ledger: new InFlightLedger(),
    outbox: cap.outbox,
    wait: cap.wait,
    ensured,
    bodies,
    methods,
    logs,
    fetch: fetchFn,
    logger,
  };
}

function makeExecutor(f: ReturnType<typeof makeFixtures>): RunnerCommandExecutor {
  return new RunnerCommandExecutor({
    host: f.host,
    ledger: f.ledger,
    outbox: f.outbox,
    machineId: "m-test",
    fetch: f.fetch,
    logger: f.logger,
    now: () => new Date(STARTED_AT),
    runGit: () => {
      throw new Error("git unavailable (test fake)");
    },
  });
}

const PROJECT_WITH_ROLES: ProjectConfig = {
  projectId: "alpha",
  workspace: "C:/ws/alpha",
  agentKind: "opencode",
  a2aPort: 4321,
  agentConfig: { roles: ROLES_AGENT_CONFIG.roles },
};

test("M-2 ①：非法 taskType ⇒ intake 硬拒（outbox failed + agent 类 + token；台账 / 闸 / ensure / A2A 零动作）", async () => {
  const f = makeFixtures(PROJECT_WITH_ROLES);
  const exec = makeExecutor(f);

  const ack = await exec.handle({
    type: "dispatch",
    taskId: "t-bad",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
    claimToken: "ct-9",
    taskType: "bogus_role" as never,
  });

  assert.equal(ack, null, "dispatch 一律不回 ack（结果走 outbox）");
  const got = await f.wait();
  assert.equal(got.result.taskId, "t-bad");
  assert.equal(got.result.state, "failed");
  assert.equal(got.credential?.claimToken, "ct-9");
  assert.equal(f.ledger.size, 0, "拒收路径不得登记台账");
  assert.equal(f.ledger.has("t-bad"), false);
  assert.deepEqual(f.ensured, [], "拒收不得拉起后端 Agent");
  assert.deepEqual(f.methods, [], "拒收不得发出任何 A2A 请求");
  assert.equal(
    f.logs.filter((l) => l.includes("unknown_task_type=bogus_role")).length >= 1,
    true,
    `warn 日志须含 token：${f.logs.join("\n")}`,
  );
});

test("M-2 ①：硬拒经 outbox 交卷（failed + failureKind=agent + token 原文），claimToken 走凭证不入结果 schema", async () => {
  const f = makeFixtures(PROJECT_WITH_ROLES);
  const cap = captureDeliveries();
  const exec = new RunnerCommandExecutor({
    host: f.host,
    ledger: f.ledger,
    outbox: cap.outbox,
    machineId: "m-test",
    fetch: f.fetch,
    logger: f.logger,
    now: () => new Date(STARTED_AT),
    runGit: () => {
      throw new Error("git unavailable (test fake)");
    },
  });

  await exec.handle({
    type: "dispatch",
    taskId: "t-bad2",
    projectId: "alpha",
    contextId: "ctx-2",
    payload: "hi",
    claimToken: "ct-7",
    taskType: "产品经理" as never,
  });

  const { result, credential } = await cap.wait();
  assert.equal(result.taskId, "t-bad2");
  assert.equal(result.machineId, "m-test");
  assert.equal(result.projectId, "alpha");
  assert.equal(result.contextId, "ctx-2");
  assert.equal(result.state, "failed");
  assert.equal(result.failureKind, "agent", "未知职责位复用既有 agent 类，不得新增第 7 值");
  assert.equal(result.text, "unknown_task_type=产品经理", "原值原样回显，orch / 宿主可字面匹配");
  assert.equal(result.finishedAt, STARTED_AT);
  assert.equal(credential?.claimToken, "ct-7", "缺凭证 ⇒ 桥侧 /runner/result 拒收 ⇒ 等于没回传");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "claimToken"), false);
});

test("M-2 ①：无 claimToken 的非法 taskType ⇒ 照常交卷（凭证不落，结果仍 failed）", async () => {
  const f = makeFixtures(PROJECT_WITH_ROLES);
  const cap = captureDeliveries();
  const exec = new RunnerCommandExecutor({
    host: f.host,
    ledger: f.ledger,
    outbox: cap.outbox,
    machineId: "m-test",
    fetch: f.fetch,
    logger: f.logger,
    now: () => new Date(STARTED_AT),
    runGit: () => {
      throw new Error("git unavailable (test fake)");
    },
  });

  await exec.handle({
    type: "dispatch",
    taskId: "t-bad3",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
    taskType: "no_such_role" as never,
  });

  const got = await cap.wait();
  assert.equal(got.result.state, "failed");
  assert.equal(got.credential, undefined);
});

test("M-2 ②：合法 taskType ⇒ 正常派发且 message/send 带 metadata（taskType + 本机 roles 映射）", async () => {
  const f = makeFixtures(PROJECT_WITH_ROLES);
  const exec = makeExecutor(f);

  await exec.handle({
    type: "dispatch",
    taskId: "t-ok",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
    taskType: "project_manager",
  });

  await f.wait();
  assert.deepEqual(f.ensured, ["alpha"]);
  assert.equal(f.methods[0], "message/send");
  const message = (f.bodies[0]?.["message"] ?? {}) as Record<string, unknown>;
  assert.deepEqual(message["metadata"], {
    taskType: "project_manager",
    model: "override-model",
    systemPrompt: "override-prompt",
    risk: "read",
  });
});

test("M-2 ②：不传 taskType ⇒ message/send 载荷不落 metadata 键（逐字现状）", async () => {
  const f = makeFixtures(PROJECT_WITH_ROLES);
  const exec = makeExecutor(f);

  await exec.handle({
    type: "dispatch",
    taskId: "t-plain",
    projectId: "alpha",
    contextId: "ctx",
    payload: "hi",
  });

  await f.wait();
  const message = (f.bodies[0]?.["message"] ?? {}) as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(message, "metadata"), false);
  assert.deepEqual(Object.keys(message).sort(), ["contextId", "messageId", "parts", "role"]);
});

/* ------------------------------------------------------------------ *
 * C. 桥侧：metadata 唯一解析点 + 透传（判据②③）
 * ------------------------------------------------------------------ */

test("M-2 ③：parseRoleIntent 逐键宽容解析（非串 / 空串 / 非法枚举 ⇒ 该键不落）", () => {
  assert.deepEqual(
    parseRoleIntent({
      taskType: "dev_manager",
      model: "m1",
      mode: "read-only",
      collaborationMode: "plan",
      risk: "full",
      systemPrompt: "sp",
      systemPromptMode: "replace",
    }),
    {
      taskType: "dev_manager",
      overrides: {
        model: "m1",
        mode: "read-only",
        collaborationMode: "plan",
        risk: "full",
        systemPrompt: "sp",
        systemPromptMode: "replace",
      },
    },
  );
  assert.deepEqual(
    parseRoleIntent({ taskType: "", model: 42, mode: "", systemPromptMode: "append-please" }),
    {},
    "全部键落空 ⇒ taskType / overrides 都不落",
  );
  assert.deepEqual(parseRoleIntent(undefined), {});
  assert.deepEqual(parseRoleIntent("x"), {});
  assert.deepEqual(parseRoleIntent([]), {});
  assert.deepEqual(parseRoleIntent({ unknownKey: "v" }), {}, "未知键忽略（不另立判据）");
  assert.deepEqual(parseRoleIntent({ systemPromptMode: "append" }), {
    overrides: { systemPromptMode: "append" },
  });
});

interface CapturedExecutor extends TaskExecutor {
  readonly inputs: TaskExecutionInput[];
}

function capturingExecutor(): CapturedExecutor {
  const inputs: TaskExecutionInput[] = [];
  return {
    inputs,
    execute: (input) => {
      inputs.push(input);
      return Promise.resolve<TaskExecutionResult>({ state: "completed", text: "ok" });
    },
  };
}

test("M-2 ②③：message/send 经 HTTP ⇒ metadata 解出的两键透到执行器；不带 metadata ⇒ 两键都不落", async () => {
  const executor = capturingExecutor();
  const app = createAcpA2AServer({ executor });
  await app.listen(0);
  try {
    const base = `http://127.0.0.1:${String(app.port())}`;
    await postJsonRpc(
      base,
      "message/send",
      {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "hi" }],
          messageId: "m-1",
          contextId: "c-1",
          metadata: { taskType: "project_manager", model: "override-model", risk: "read" },
        },
        configuration: { blocking: false },
      },
      5_000,
    );
    await postJsonRpc(
      base,
      "message/send",
      {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "hi" }],
          messageId: "m-2",
          contextId: "c-2",
        },
        configuration: { blocking: false },
      },
      5_000,
    );
  } finally {
    await app.close();
  }

  assert.equal(executor.inputs.length, 2);
  const withMeta = executor.inputs[0];
  assert.ok(withMeta !== undefined);
  assert.equal(withMeta.taskType, "project_manager");
  assert.deepEqual(withMeta.overrides, { model: "override-model", risk: "read" });

  const withoutMeta = executor.inputs[1];
  assert.ok(withoutMeta !== undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(withoutMeta, "taskType"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(withoutMeta, "overrides"), false);
});

/* ------------------------------------------------------------------ *
 * D. 会话执行器：override 优先、无则回落构造器（判据③ + ②）
 * ------------------------------------------------------------------ */

const SET_MODE = "session/set_mode";
const SET_CONFIG = "session/set_config_option";

class FakeClient implements AcpRequestClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  responder: (method: string, params: unknown) => unknown = () => ({});

  request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return Promise.resolve().then(() => this.responder(method, params));
  }

  notify(): void {
    return undefined;
  }

  onNotification(): () => void {
    return () => undefined;
  }
}

function wire(client: FakeClient): string[] {
  const methods: string[] = [];
  client.responder = (method, params) => {
    methods.push(method);
    if (method === "session/new") return { sessionId: "s1" };
    if (method === SET_MODE) {
      const p = params as { modeId: string };
      return { modes: { currentModeId: p.modeId, availableModes: [] } };
    }
    if (method === SET_CONFIG) {
      const p = params as { configId: string; value: string };
      return { configOptions: [{ id: p.configId, currentValue: p.value }] };
    }
    if (method === "session/prompt") {
      return { stopReason: "end_turn" };
    }
    return {};
  };
  return methods;
}

interface RunnerOpts {
  model?: string;
  mode?: string;
  collaborationMode?: string;
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace";
}

function makeSessionRunner(client: FakeClient, opts: RunnerOpts = {}, logs?: string[]): AcpSessionRunner {
  return new AcpSessionRunner({
    client,
    cwd: "/ws",
    timeoutMs: 1_000,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.collaborationMode !== undefined ? { collaborationMode: opts.collaborationMode } : {}),
    ...(opts.systemPrompt !== undefined || opts.systemPromptMode !== undefined
      ? {
          injection: {
            ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
            ...(opts.systemPromptMode !== undefined ? { systemPromptMode: opts.systemPromptMode } : {}),
          },
        }
      : {}),
    ...(logs !== undefined ? { logger: (m: string) => void logs.push(m) } : {}),
  });
}

const INPUT = { taskId: "t1", text: "hi", contextId: "ctx", messageId: "m1" };

const paramsOf = (client: FakeClient, method: string): unknown[] =>
  client.calls.filter((c) => c.method === method).map((c) => c.params);

const promptText = (client: FakeClient): string => {
  const call = client.calls.find((c) => c.method === "session/prompt");
  const p = (call?.params ?? {}) as { prompt?: Array<{ text?: string }> };
  return p.prompt?.[0]?.text ?? "";
};

const configValueOf = (client: FakeClient, configId: string): unknown => {
  for (const params of paramsOf(client, SET_CONFIG)) {
    const p = params as { configId?: string; value?: unknown };
    if (p.configId === configId) return p.value;
  }
  return undefined;
};

test("M-2 ③：喂 override ⇒ 四旋钮取覆盖值 + 注入文本含覆盖段 + 日志列出命中键", async () => {
  const client = new FakeClient();
  const methods = wire(client);
  const logs: string[] = [];
  const runner = makeSessionRunner(
    client,
    {
      model: "base-model",
      mode: "base-mode",
      collaborationMode: "base-collab",
      systemPrompt: "base-prompt",
    },
    logs,
  );

  const result = await runner.execute({
    ...INPUT,
    taskType: "project_manager",
    overrides: {
      model: "req-model",
      mode: "req-mode",
      collaborationMode: "req-collab",
      systemPrompt: "req-prompt",
      systemPromptMode: "replace",
    },
  });

  assert.equal(result.state, "completed");
  assert.deepEqual(methods, ["session/new", SET_CONFIG, SET_MODE, SET_CONFIG, "session/prompt"]);
  assert.equal(configValueOf(client, "model"), "req-model");
  assert.equal(configValueOf(client, "collaboration_mode"), "req-collab");
  assert.deepEqual(paramsOf(client, SET_MODE), [{ sessionId: "s1", modeId: "req-mode" }]);
  const text = promptText(client);
  assert.ok(text.startsWith("req-prompt"), `replace 档下注入段应为覆盖文本：${text}`);
  assert.equal(text.includes(A2A_OUTCOME_CONVENTION), false, "replace ⇒ 缺省约定被替换");
  assert.ok(text.endsWith("hi"));
  assert.equal(
    logs.filter((l) => l.includes("per-request 覆盖生效")).length,
    1,
    logs.join("\n"),
  );
  assert.equal(
    logs.filter((l) => l.includes("taskType=project_manager")).length,
    1,
    "职责位须留痕（桥不校验、只打日志）",
  );
});

test("M-2 ②③：不喂 override ⇒ 全回落构造器值、零「覆盖生效」日志（逐字现状）", async () => {
  const client = new FakeClient();
  const methods = wire(client);
  const logs: string[] = [];
  const runner = makeSessionRunner(
    client,
    { model: "base-model", mode: "base-mode", collaborationMode: "base-collab", systemPrompt: "base-prompt" },
    logs,
  );

  await runner.execute(INPUT);

  assert.deepEqual(methods, ["session/new", SET_CONFIG, SET_MODE, SET_CONFIG, "session/prompt"]);
  assert.equal(configValueOf(client, "model"), "base-model");
  assert.equal(configValueOf(client, "collaboration_mode"), "base-collab");
  assert.deepEqual(paramsOf(client, SET_MODE), [{ sessionId: "s1", modeId: "base-mode" }]);
  assert.ok(promptText(client).startsWith(A2A_OUTCOME_CONVENTION));
  assert.ok(promptText(client).includes("base-prompt"));
  assert.equal(logs.filter((l) => l.includes("per-request 覆盖生效")).length, 0, logs.join("\n"));
  assert.equal(logs.filter((l) => l.includes("taskType=")).length, 0, logs.join("\n"));
});

test("M-2 ③：override 逐键混合（空串 / 缺键 ⇒ 该键回落，其余覆盖）", async () => {
  const client = new FakeClient();
  wire(client);
  const runner = makeSessionRunner(client, { model: "base-model", mode: "base-mode" });

  await runner.execute({
    ...INPUT,
    overrides: { model: "", mode: "req-mode", systemPrompt: "req-prompt" },
  });

  assert.equal(configValueOf(client, "model"), "base-model", "空串 = 未给 ⇒ 回落");
  assert.deepEqual(paramsOf(client, SET_MODE), [{ sessionId: "s1", modeId: "req-mode" }]);
  assert.ok(promptText(client).includes("req-prompt"));
});

test("M-2 ③：构造器未配 + 只喂 override ⇒ 覆盖路让「原本零请求」的旋钮真下发", async () => {
  const client = new FakeClient();
  const methods = wire(client);
  await makeSessionRunner(client).execute({ ...INPUT, overrides: { mode: "req-mode" } });

  assert.deepEqual(methods, ["session/new", SET_MODE, "session/prompt"]);
  assert.deepEqual(paramsOf(client, SET_MODE), [{ sessionId: "s1", modeId: "req-mode" }]);
});

test("M-2 ③：override 的 model 设置失败 ⇒ 依旧 fail-fast（回落语义不吞错）", async () => {
  const client = new FakeClient();
  const methods: string[] = [];
  client.responder = (method) => {
    methods.push(method);
    if (method === "session/new") return { sessionId: "s1" };
    throw new Error("后端拒绝该模型");
  };

  const result = await makeSessionRunner(client, { model: "base-model" }).execute({
    ...INPUT,
    overrides: { model: "req-model" },
  });

  assert.equal(result.state, "failed");
  assert.ok((result.text ?? "").includes("model=req-model"), "失败文本须含生效值，非构造器值");
  assert.equal(result.text?.includes("base-model"), false);
  assert.deepEqual(methods, ["session/new", SET_CONFIG], "fail-fast：不发 prompt");
});
