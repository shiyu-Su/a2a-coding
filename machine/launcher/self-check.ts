/**
 * Launcher 启动自检（REQ-v0.1.1-2026-09-11-03）。
 *
 * 对本机全部已配置项目逐个：`ensure` 拉起 → 经 A2A JSON-RPC 发送一条真实最小任务
 * → 轮询至终态并校验（completed 且响应文本非空）→ `stop` 回收。任一失败 / 超时记入
 * 结果（附根因 `cause`）。**粒度（§2.4-⑤ 改判 · REQ-v0.8.6-2026-09-21-02 收口）**：`ok = 至少
 * 一项可服务`，单项失败不再判负全机；由入口（launcher/index.ts）逐项登记不可用，**仅全部项目
 * 不可用**这一种机器级故障时 fail-fast 退出（非零）。
 *
 * 线协议：包装器服务端以 legacyCompat 挂载 `/a2a/jsonrpc`（v0.3 兼容），故用原生
 * fetch 直发 v0.3 形状的 `message/send` / `tasks/get`（role "user"、parts
 * `kind:"text"`、必填 messageId；configuration 缺省即 returnImmediately）。
 * 不引新依赖；自检与真实任务同链路，能真实暴露认证 / 模型 / provider / 运行时缺配。
 * 空闲回收保护（v0.7.0 M5·MC1）：自检任务全程计入本机在飞台账（`manager.inFlight`），
 * 使 idleStop 判据（`inflight==0`）在自检执行期间恒不成立 ⇒ 无需再周期 re-ensure 续约。
 */
import { randomUUID } from "node:crypto";
import type { MachineConfig, ProjectConfig } from "../types.js";
import {
  A2A_TERMINAL_STATES,
  postJsonRpc,
  resultText,
  statusMessageText,
  taskStateOf,
} from "./a2a-client.js";
import type { AgentManager } from "./manager.js";
import { errorMessage } from "./process.js";

/** 单项目自检缺省总超时（覆盖 ensure + 发送 + 轮询全程） */
export const DEFAULT_STARTUP_CHECK_TIMEOUT_MS = 120_000;

/** 自检缺省 prompt：刻意极短，最小化真实模型调用的 token 消耗 */
export const DEFAULT_STARTUP_CHECK_PROMPT = "Reply with exactly: OK";

/** 任务态轮询间隔 */
const POLL_INTERVAL_MS = 1_000;

/**
 * 自检任务在本机在飞台账中的 taskId 前缀（M5·MC1）：自检经 `manager.inFlight` 登记，
 * 使 idleStop 判据在自检执行期间看到在飞任务而不回收 agent（替代旧 re-ensure 续约）。
 */
const SELF_CHECK_LEDGER_PREFIX = "self-check:";

/**
 * 失败根因分类（REQ-v0.8.6-2026-09-21-02 · §2.4-⑥ F-e）：
 * `hintFor` 旧版**只按 kind 分流**（模型名非法也走「检查认证」那支），提示与真因不匹配。
 * 新增本字段后 `hintFor` **先按 cause 分流**、kind 文案仅作兜底。
 * - `backend-entry`：四层解析未命中 ACP 入口（指向分层清单）；
 * - `auth`：认证/登录态问题；
 * - `model`：模型名/参数非法；
 * - `timeout`：任务未在超时窗内达终态。
 * `undefined` = 未识别（多为端口/进程级故障），此时 ensure 类走「检查端口」文案。
 */
export type SelfCheckCause = "backend-entry" | "auth" | "model" | "timeout";

/** 自检失败明细：项目 + 阶段 + 根因分类 + 原因（+ 修复提示） */
export interface SelfCheckFailure {
  projectId: string;
  /** 失败阶段：ensure（拉起）/ send（发送）/ settle（执行与校验） */
  stage: "ensure" | "send" | "settle";
  /** 根因分类（可空 = 未识别，端口/进程级故障）；仅驱动 hintFor 的错误文案分流（REQ-v0.8.6-2026-09-21-02 起不再参与 index.ts 机器级判据） */
  cause?: SelfCheckCause;
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

/**
 * 自检汇总结果。
 *
 * **粒度口径（§2.4-⑤ 改判）**：`ok` 由旧的「任一项目失败即全机失败」改为「**至少一项可服务**」——
 * 单项目失败不再判负全机。`failures` 保留**全量**失败明细（供注册载荷 `selfCheck.failures` 观测），
 * `unavailable` 为**判定不可用的项目集**（machine 私有面，`index.ts` 据此逐项登记 `manager.unavailable`）；
 * 当前与 `failures` 同集（每项失败即该项目不可服务），单列以便语义显式、与「全量保留」区分。
 */
export interface SelfCheckResult {
  /** 至少一项可服务（或本机无项目）即 true；全部不可用为 false（机器级故障） */
  ok: boolean;
  failures: SelfCheckFailure[];
  /** 判定不可用的项目集（machine 私有；不入注册载荷新顶层字段，红线 §2.7-2） */
  unavailable: SelfCheckFailure[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 从失败原因文本分类根因（§2.4-⑥ F-e）。顺序敏感：
 * `backend-entry`（适配器四层解析未命中，文案统一含「ACP 后端入口」+「[backend] 行」）
 * 先判 → `model`（模型名/参数非法，或 `-32602` 无效参数）→ 端口/进程类**返回 undefined**
 * （交 ensure 文案）→ `auth`（认证/登录态）。未命中返回 undefined，由 kind 文案兜底。
 */
export function classifySelfCheckCause(reason: string): SelfCheckCause | undefined {
  if (/ACP 后端入口|\[backend\] 行|后端入口/.test(reason)) return "backend-entry";
  if (/模型|\bmodel\b|-32602|invalid (request )?param/i.test(reason)) return "model";
  // 端口 / 进程级故障（EADDRINUSE、包装器提前退出等）：非项目根因，交 ensure 文案（机器级判据已收敛为「全部项目不可用」，cause 不再参与）
  if (/EADDRINUSE|端口|包装器进程提前退出|spawn/i.test(reason)) return undefined;
  if (/auth|api[ _-]?key|token|认证|登录|login|unauthorized|forbidden|credential|401|403/i.test(reason)) {
    return "auth";
  }
  return undefined;
}

/** 按根因（cause）分流修复提示；cause 缺省时按 kind + stage 文案兜底（改造文档 §2.4-⑥ F-e） */
export function hintFor(
  kind: ProjectConfig["agentKind"],
  stage: SelfCheckFailure["stage"],
  cause?: SelfCheckCause,
): string {
  switch (cause) {
    case "backend-entry":
      return "未能解析到该后端的 ACP 入口（四层：L0 显式 agentConfig.backendCmd / L1 机器本地 / L2 全局 npm / L3 PATH）。见 launcher.log 上方 [backend] 分层清单：安装对应适配器、设 NPM_CONFIG_PREFIX，或显式配置 agentConfig.backendCmd。";
    case "model":
      return "模型名/参数非法：检查 agentConfig 的 model 与 provider 参数（如 claude 的 agentConfig.claude.model、codex 的 ~/.codex/config.toml、opencode 的 provider 配置），属参数问题而非凭据问题。";
    case "auth":
      return "认证/登录态问题：确认对应 API Key / 登录凭据已注入 Launcher 进程环境（详见该 agentKind 的配置说明）。";
    case "timeout":
      return "自检超时：任务未在超时窗内达终态。可提高 launcher.startupCheckTimeoutMs，或检查后端是否响应（认证挂起 / 模型排队亦会表现为超时）。";
    default:
      break;
  }
  // cause 未知 → kind 文案兜底（保持既有分 kind 的认证/模型指引）
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
    case "qoder-cn":
      return "检查 qodercn 认证与登录：把 QODERCN_PERSONAL_ACCESS_TOKEN 注入 Launcher 进程环境（或确认 ~/.qoder-cn/.auth 已 CLI 登录），并确认桥进程 acp-bridge 已随项目拉起（见 Launcher 日志）。";
    default: {
      // 编译期安全网（改造文档 §2.3-4）：新增 kind 时此处 `kind` 不再是 never ⇒ 编译报错。
      const _exhaustive: never = kind;
      return "该 agentKind 尚无专用修复提示；请查看 Launcher 日志中该项目的包装器输出。";
    }
  }
}

/** 压缩为单行并截断（失败原因可能含换行或超长，须保持日志行形状） */
function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
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
    const reason = errorMessage(err);
    const cause = classifySelfCheckCause(reason);
    return {
      projectId: project.projectId,
      stage: "ensure",
      cause,
      reason,
      hint: hintFor(project.agentKind, "ensure", cause),
    };
  }

  // 2-4 任务全程计入本机在飞台账（M5·MC1）：idleStop 判据 = inflight==0，
  // 故在飞期间 agent 不会被空闲回收误杀；替代旧「周期 re-ensure 续约」hack。
  const ledgerTaskId = `${SELF_CHECK_LEDGER_PREFIX}${project.projectId}`;
  manager.inFlight.add({
    taskId: ledgerTaskId,
    projectId: project.projectId,
    startedAt: new Date().toISOString(),
    a2aTaskId: null,
  });

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
      const reason = errorMessage(err);
      const cause = classifySelfCheckCause(reason);
      return {
        projectId: project.projectId,
        stage: "send",
        cause,
        reason,
        hint: hintFor(project.agentKind, "send", cause),
      };
    }

    // 轮询 tasks/get 至终态（send 直接返回 Message 视为已完成）
    try {
      while (taskId !== null && remaining() > 0) {
        const state = taskStateOf(settled);
        if (state !== null && A2A_TERMINAL_STATES.has(state)) break;
        await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, remaining())));
        if (remaining() <= 0) break;
        settled = await postJsonRpc(endpoint, "tasks/get", { id: taskId }, remaining());
      }
    } catch (err) {
      const reason = errorMessage(err);
      const cause = classifySelfCheckCause(reason);
      return {
        projectId: project.projectId,
        stage: "settle",
        cause,
        reason,
        hint: hintFor(project.agentKind, "settle", cause),
      };
    }

    // 校验：completed（或 Message 直返）且响应文本非空
    if (taskId !== null) {
      const state = taskStateOf(settled);
      if (state !== "completed") {
        const timedOut = remaining() <= 0;
        const errorText = singleLine(statusMessageText(settled));
        const reason = timedOut
          ? `自检超时（${timeoutMs}ms）：任务未达终态`
          : `任务终态为 ${state ?? "unknown"}（要求 completed）${errorText ? `：${errorText}` : ""}`;
        const cause: SelfCheckCause | undefined = timedOut
          ? "timeout"
          : classifySelfCheckCause(errorText.length > 0 ? errorText : reason);
        return {
          projectId: project.projectId,
          stage: "settle",
          cause,
          reason,
          hint: hintFor(project.agentKind, "settle", cause),
        };
      }
    }
    const text = resultText(settled);
    if (text.length === 0) {
      return {
        projectId: project.projectId,
        stage: "settle",
        reason: "任务完成但响应文本为空",
        hint: hintFor(project.agentKind, "settle", undefined),
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
    manager.inFlight.remove(ledgerTaskId);
    await stopQuietly(manager, project.projectId);
  }
}

/**
 * 启动自检入口：对本机全部项目顺序执行，返回汇总结果（不抛出、不退出）。
 * **粒度口径（§2.4-⑤）**：`ok = 至少一项可服务`（无项目亦视为 ok）；单项失败**不再判负全机**，
 * 而是进 `unavailable` 集，由入口 `launcher/index.ts` 逐项登记不可用、仅在机器级故障时 fail-fast 退出。
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
        `[self-check] ${project.projectId} 失败（${outcome.stage}${outcome.cause ? "/" + outcome.cause : ""}）：${outcome.reason}`,
      );
      failures.push(outcome);
    } else {
      console.log(
        `[self-check] ${project.projectId} 通过：taskId=${outcome.taskId ?? "-"} contextId=${outcome.contextId} state=${outcome.state} responseChars=${outcome.responseChars} durationMs=${outcome.durationMs}`,
      );
    }
  }
  // 每项失败即该项目不可服务 → 不可用集当前与 failures 同集（全量保留于 failures 供注册载荷观测）
  const unavailable = failures;
  const usable = machine.projects.length - unavailable.length;
  const ok = machine.projects.length === 0 || usable >= 1;
  return { ok, failures, unavailable };
}
