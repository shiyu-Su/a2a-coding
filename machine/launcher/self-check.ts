/**
 * Launcher 启动自检（REQ-v0.1.1-2026-09-11-03）。
 *
 * 对本机全部已配置项目逐个：`ensure` 拉起 → 经 A2A JSON-RPC 发送一条真实最小任务
 * → 轮询至终态并校验（completed 且响应文本非空）→ `stop` 回收。任一失败 / 超时
 * 记入结果，由入口（launcher/index.ts）在监听端口前 fail-fast 退出（非零）。
 *
 * 线协议：包装器服务端以 legacyCompat 挂载 `/a2a/jsonrpc`（v0.3 兼容），故用原生
 * fetch 直发 v0.3 形状的 `message/send` / `tasks/get`（role "user"、parts
 * `kind:"text"`、必填 messageId；configuration 缺省即 returnImmediately）。
 * 不引新依赖；自检与真实任务同链路，能真实暴露认证 / 模型 / provider / 运行时缺配。
 * 自检全程按 `LEASE_RENEW_INTERVAL_MS` 周期 re-ensure 续约空闲计时（与 orch 桥同机制），
 * 防止 `launcher.idleStopMs` 小于模型耗时时把执行中的自检任务误杀。
 */
import { randomUUID } from "node:crypto";
import type { MachineConfig, ProjectConfig } from "../types.js";
import type { AgentManager } from "./manager.js";
import { errorMessage } from "./process.js";

/** 单项目自检缺省总超时（覆盖 ensure + 发送 + 轮询全程） */
export const DEFAULT_STARTUP_CHECK_TIMEOUT_MS = 120_000;

/** 自检缺省 prompt：刻意极短，最小化真实模型调用的 token 消耗 */
export const DEFAULT_STARTUP_CHECK_PROMPT = "Reply with exactly: OK";

/** 任务态轮询间隔 */
const POLL_INTERVAL_MS = 1_000;

/**
 * 空闲回收续约间隔：自检全程（发送 + 轮询）周期 re-ensure 复位 `launcher.idleStopMs`
 * 计时（与 orch 桥 `LEASE_RENEW_INTERVAL_MS` 同机制），防止模型耗时超过空闲时长时
 * agent 在任务执行中被自动回收。
 */
const LEASE_RENEW_INTERVAL_MS = 5_000;

/** 单条 HTTP 请求超时下限（不超过剩余自检预算即可） */
const MIN_REQUEST_TIMEOUT_MS = 5_000;

/** v0.3 终态集合：`completed` 为唯一成功态，其余终态均判自检失败 */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "completed",
  "canceled",
  "failed",
  "rejected",
  "input-required",
  "auth-required",
]);

/** 自检失败明细：项目 + 阶段 + 原因（+ 修复提示） */
export interface SelfCheckFailure {
  projectId: string;
  /** 失败阶段：ensure（拉起）/ send（发送）/ settle（执行与校验） */
  stage: "ensure" | "send" | "settle";
  reason: string;
  hint?: string;
}

/** 自检通过明细：统一字段（与 wrapper `[a2a-task]` 结束行同套同口径，观测用，不打印响应内容） */
export interface SelfCheckPass {
  projectId: string;
  /** 任务 id（Message 直返路径无任务句柄，打印 `-`） */
  taskId: string | null;
  /** A2A 上下文 id（自检生成，与发出消息同源） */
  contextId: string;
  /** 任务终态（正常为 completed） */
  state: string;
  /** agent 响应文本长度（字符数） */
  responseChars: number;
  /** 任务执行耗时：发送 → 终态（毫秒，与 wrapper 结束行 durationMs 同口径；ensure 拉起耗时不混入） */
  durationMs: number;
}

/** 单项目自检结果：失败（SelfCheckFailure，以 stage 判别）或通过（SelfCheckPass） */
export type SelfCheckOutcome = SelfCheckPass | SelfCheckFailure;

export interface SelfCheckResult {
  ok: boolean;
  failures: SelfCheckFailure[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 按 agentKind 与失败阶段给出修复提示 */
function hintFor(kind: ProjectConfig["agentKind"], stage: SelfCheckFailure["stage"]): string {
  if (stage === "ensure") {
    return "检查该项目 workspace 是否存在、a2aPort 是否被占用；详见 Launcher 日志中该项目的包装器输出。";
  }
  switch (kind) {
    case "claude":
      return "检查认证与模型：把 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL 注入 Launcher 进程环境，或确认 ~/.claude/settings.json 的用户级配置（默认 settingSources 含 user）；模型可经 agentConfig.claude.model 指定。";
    case "codex":
      return "检查认证与 provider：OPENAI_API_KEY 或 ~/.codex/auth.json；provider / 模型见 ~/.codex/config.toml（可经 agentConfig.codex 覆盖）。";
    case "opencode":
      return "检查 opencode CLI 可用且已登录，provider / 模型配置正确（用户全局或项目 opencode.json）。";
  }
}

/** v0.3 parts（`[{kind:"text",text}]`）拼接文本 */
function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const o = part as Record<string, unknown>;
    if (o["kind"] === "text" && typeof o["text"] === "string" && o["text"].length > 0) {
      chunks.push(o["text"]);
    }
  }
  return chunks.join("\n");
}

/**
 * 提取 v0.3 结果文本：Task 取 status.message 与 artifacts；Message 取顶层 parts。
 */
function resultText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const o = result as Record<string, unknown>;
  const chunks: string[] = [];
  const status = o["status"];
  if (typeof status === "object" && status !== null) {
    const message = (status as Record<string, unknown>)["message"];
    if (typeof message === "object" && message !== null) {
      chunks.push(textFromParts((message as Record<string, unknown>)["parts"]));
    }
  }
  if (Array.isArray(o["artifacts"])) {
    for (const artifact of o["artifacts"]) {
      if (typeof artifact === "object" && artifact !== null) {
        chunks.push(textFromParts((artifact as Record<string, unknown>)["parts"]));
      }
    }
  }
  if (chunks.length === 0) chunks.push(textFromParts(o["parts"]));
  return chunks.join("\n");
}

/**
 * 提取任务 status.message 文本（失败原因；与任务结果保障的 text 落库口径同源）。
 */
function statusMessageText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const status = (result as Record<string, unknown>)["status"];
  if (typeof status !== "object" || status === null) return "";
  const message = (status as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return "";
  return textFromParts((message as Record<string, unknown>)["parts"]);
}

/** 压缩为单行并截断（失败原因可能含换行或超长，须保持日志行形状） */
function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * v0.3 任务态：result 含非空 `id` 视为 Task（Message 无此字段）。
 * 返回 null 表示非 Task；Task 缺 status.state 记为 "unknown"。
 */
function taskStateOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const o = result as Record<string, unknown>;
  if (typeof o["id"] !== "string" || o["id"].length === 0) return null;
  const status = o["status"];
  if (typeof status !== "object" || status === null) return "unknown";
  const state = (status as Record<string, unknown>)["state"];
  return typeof state === "string" ? state : "unknown";
}

/** 发送 JSON-RPC 2.0 请求并返回 result；HTTP / RPC 错误统一抛出（unknown 文本） */
async function postJsonRpc(
  endpoint: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetch(`${endpoint}/a2a/jsonrpc`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(Math.max(MIN_REQUEST_TIMEOUT_MS, timeoutMs)),
  });
  const text = await res.text();
  let body: { result?: unknown; error?: { message?: unknown } | null } | null = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as { result?: unknown; error?: { message?: unknown } | null };
    } catch {
      body = null;
    }
  }
  const rpcError = body?.error;
  if (rpcError !== undefined && rpcError !== null) {
    const msg = typeof rpcError.message === "string" ? rpcError.message : JSON.stringify(rpcError);
    throw new Error(msg);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return body?.result;
}

/** 自检路径上的 best-effort 回收：失败只记日志，不影响自检结果 */
async function stopQuietly(manager: AgentManager, projectId: string): Promise<void> {
  try {
    await manager.stop(projectId);
  } catch (err) {
    console.error(`[self-check] ${projectId} 回收失败（不影响自检结果）：${errorMessage(err)}`);
  }
}

/**
 * 自检单个项目；通过返回 SelfCheckPass（响应长度 + 耗时），失败返回 SelfCheckFailure。
 * 无论成败，结束前都 stop 该项目 Agent（恢复按需 / 用完退出语义）。
 */
async function checkProject(
  manager: AgentManager,
  project: ProjectConfig,
  prompt: string,
  timeoutMs: number,
): Promise<SelfCheckOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const remaining = () => deadline - Date.now();

  // 1. ensure（幂等拉起 + 端口就绪等待）
  let endpoint: string;
  try {
    const ensured = await manager.ensure(project.projectId);
    endpoint = ensured.endpoint;
  } catch (err) {
    return {
      projectId: project.projectId,
      stage: "ensure",
      reason: errorMessage(err),
      hint: hintFor(project.agentKind, "ensure"),
    };
  }

  // 2-4 全程续约空闲计时（与 orch 桥 LEASE_RENEW 同机制）：模型调用可能长于
  // launcher.idleStopMs，期间无 ensure 调用会被空闲回收误杀执行中的自检任务。
  const renewTimer = setInterval(() => {
    void manager.ensure(project.projectId).catch((err: unknown) => {
      console.error(`[self-check] ${project.projectId} 空闲续约失败：${errorMessage(err)}`);
    });
  }, LEASE_RENEW_INTERVAL_MS);
  renewTimer.unref();

  try {
    // message/send（真实最小任务；新 contextId = 新会话，不续接历史）。
    // configuration.blocking=false → 服务端翻译为 returnImmediately：立即返回 task
    // 句柄，等待移至下方 tasks/get 轮询，避免 HTTP 请求挂满整个模型耗时。
    // taskStartedAt 记「发送 → 终态」的任务执行段耗时（与 wrapper 结束行同口径）。
    const contextId = randomUUID();
    const taskStartedAt = Date.now();
    let taskId: string | null = null;
    let settled: unknown;
    try {
      const result = await postJsonRpc(
        endpoint,
        "message/send",
        {
          message: {
            role: "user",
            parts: [{ kind: "text", text: prompt }],
            messageId: randomUUID(),
            contextId,
          },
          configuration: { blocking: false },
        },
        remaining(),
      );
      settled = result;
      if (taskStateOf(result) !== null) {
        taskId = (result as Record<string, unknown>)["id"] as string;
      }
    } catch (err) {
      return {
        projectId: project.projectId,
        stage: "send",
        reason: errorMessage(err),
        hint: hintFor(project.agentKind, "send"),
      };
    }

    // 轮询 tasks/get 至终态（send 直接返回 Message 视为已完成）
    try {
      while (taskId !== null && remaining() > 0) {
        const state = taskStateOf(settled);
        if (state !== null && TERMINAL_STATES.has(state)) break;
        await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, remaining())));
        if (remaining() <= 0) break;
        settled = await postJsonRpc(endpoint, "tasks/get", { id: taskId }, remaining());
      }
    } catch (err) {
      return {
        projectId: project.projectId,
        stage: "settle",
        reason: errorMessage(err),
        hint: hintFor(project.agentKind, "settle"),
      };
    }

    // 校验：completed（或 Message 直返）且响应文本非空
    if (taskId !== null) {
      const state = taskStateOf(settled);
      if (state !== "completed") {
        const timedOut = remaining() <= 0;
        const errorText = singleLine(statusMessageText(settled));
        return {
          projectId: project.projectId,
          stage: "settle",
          reason: timedOut
            ? `自检超时（${timeoutMs}ms）：任务未达终态`
            : `任务终态为 ${state ?? "unknown"}（要求 completed）${errorText ? `：${errorText}` : ""}`,
          hint: hintFor(project.agentKind, "settle"),
        };
      }
    }
    const text = resultText(settled);
    if (text.length === 0) {
      return {
        projectId: project.projectId,
        stage: "settle",
        reason: "任务完成但响应文本为空",
        hint: hintFor(project.agentKind, "settle"),
      };
    }
    return {
      projectId: project.projectId,
      taskId,
      contextId,
      state: taskStateOf(settled) ?? "completed",
      responseChars: text.length,
      durationMs: Date.now() - taskStartedAt,
    };
  } finally {
    clearInterval(renewTimer);
    await stopQuietly(manager, project.projectId);
  }
}

/**
 * 启动自检入口：对本机全部项目顺序执行，返回汇总结果（不抛出、不退出，
 * fail-fast 的 process.exit 由入口 launcher/index.ts 决定）。
 */
export async function runStartupSelfCheck(
  manager: AgentManager,
  machine: MachineConfig,
): Promise<SelfCheckResult> {
  const prompt = machine.launcher.startupCheckPrompt ?? DEFAULT_STARTUP_CHECK_PROMPT;
  const timeoutMs = machine.launcher.startupCheckTimeoutMs ?? DEFAULT_STARTUP_CHECK_TIMEOUT_MS;
  const failures: SelfCheckFailure[] = [];

  console.log(
    `[self-check] 开始：${machine.projects.length} 个项目，prompt="${prompt}"，每项目超时 ${timeoutMs}ms`,
  );
  for (const project of machine.projects) {
    console.log(`[self-check] ${project.projectId}（${project.agentKind}）自检中…`);
    const outcome = await checkProject(manager, project, prompt, timeoutMs);
    if ("stage" in outcome) {
      console.error(
        `[self-check] ${project.projectId} 失败（${outcome.stage}）：${outcome.reason}`,
      );
      failures.push(outcome);
    } else {
      console.log(
        `[self-check] ${project.projectId} 通过：taskId=${outcome.taskId ?? "-"} contextId=${outcome.contextId} state=${outcome.state} responseChars=${outcome.responseChars} durationMs=${outcome.durationMs}`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}
