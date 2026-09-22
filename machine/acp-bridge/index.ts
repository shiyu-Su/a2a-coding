/**
 * ACP 桥进程入口（REQ-v0.8.0-2026-09-19-01 · 节点 B1；B6 完成完整链接线）。
 *
 * 形态 = 仓内自持的 `a2a-<kind>` 等价物：由 Launcher 每项目 spawn 一个，绑定该项目的
 * `a2aPort`，对 Runner 暴露 A2A 服务面（见 `a2a-server.ts`）。
 *
 * 运行链（B6 装配）：ACP 后端进程（`--backend-cmd`，如 `qodercn --acp`）
 *   ← `AcpClient`（B2）← `createPermissionHandler(risk)`（B4）
 *   ← `AcpSessionRunner`（B3，含 `SessionMap`/outcome，B5）
 *   → `createAcpA2AServer`（B1）。
 *
 * **子进程树杀**：退出时 `client.close()` 经 `lifecycle.killProcessTree` 杀后端进程树，防孤儿。
 *
 * CLI：`node dist/acp-bridge/index.js --port <n> --workspace <path>
 *       --project-id <id> --backend-cmd <cmd> --risk <read|write|full>
 *       [--backend-args <JSON字符串数组>]
 *       [--system-prompt <text> --system-prompt-mode <append|replace>]
 *       [--model <value>] [--mode <modeId>] [--collaboration-mode <value>]
 *       [--session-meta-json <JSON对象>] [--session-timeout <ms>]`
 *
 * v0.8.7 · M1：`--session-timeout <ms>` = 会话执行超时毫秒数，**只校验「整数 > 0」**
 * （上限护栏的单一源在 launcher 项目解析处，本模块零仓内依赖故不复制上限常量）；缺省 ⇒ 落
 * `DEFAULT_SESSION_TIMEOUT_MS`。
 *
 * v0.8.5 · M1（模式 / 会话元信息通道，REQ-v0.8.5-2026-09-21-01）：`--mode`（adapter 按 risk 映射后的
 * **原样值**，桥**不做 kind→mode 映射**）与 `--collaboration-mode` 均原样透传、不校验（缺省 / 空串 ⇒ 不下发）；
 * 前者优先 `session/set_mode`、**仅 `-32601`** 回落 `set_config_option{configId:"mode"}`；后者只走
 * `session/set_config_option{configId:"collaboration_mode"}`。`--session-meta-json`（JSON 对象）= 会话建立期
 * `_meta` 注入，`session/new` / `load` / `resume` **三路统一携带**。
 *
 * v0.8.1 · M1：后端参数数组化（`--backend-args`，缺省 `["--acp"]` 保 qoder 逐字不变）；
 * 同版引入的 `--config-file` + `--config-segment` 最小配置面**已于 v0.8.5 · M4 整体退役**
 * （`agentConfig.<kind>` 段与配置通道退役）⇒ 自定义注入改走本文件的
 * `--system-prompt` / `--system-prompt-mode`（解析逐字复用 `parseModelArg`；缺省 / 空串 ⇒ 不下发）。
 *
 * v0.8.2 · M1（协议面增补）：`--model` = 项目 `agentConfig.model` 的**原样透传值**（读点自 v0.8.4 起平铺，
 * v0.8.5 段退役后为唯一口径），
 * 由 `AcpSessionRunner` 在会话建立（new / load / resume）成功后经 ACP
 * `session/set_config_option {configId:"model"}` 下发；缺省 / 空串 ⇒ 不发该请求（与旧版逐字一致）。
 * 走 CLI 而非 `--config-file` 白名单扩展：后者只覆盖 opencode，qoder 不接该通道。
 *
 * 不 import `launcher/**` / `orch/**`；无第三方依赖（仅 node:*）。
 */
import { pathToFileURL } from "node:url";
import { createAcpA2AServer, type AcpA2AServer } from "./a2a-server.js";
import { AcpClient, createNodeAcpSpawn } from "./acp/client.js";
import { createPermissionHandler } from "./acp/permission.js";
import {
  AcpSessionRunner,
  DEFAULT_SESSION_TIMEOUT_MS,
  type AcpInjectionConfig,
} from "./acp/session.js";
import type { AcpSpawn } from "./acp/types.js";
import { classifyFatal } from "./lifecycle.js";
import { SessionMap } from "./session-map.js";
import type { TaskExecutionInput, TaskExecutionResult, TaskExecutor } from "./types.js";

/** 风险档位（与线协议 `RiskLevel` 同口径；本模块自带字面量，不 import launcher/types）。 */
export type BridgeRisk = "read" | "write" | "full";

/** 后端参数缺省（qoder v0.8.0 行为逐字不变；opencode 由 adapter 传 `["acp"]`）。 */
export const DEFAULT_BACKEND_ARGS: readonly string[] = ["--acp"];

/** 桥启动参数。 */
export interface BridgeArgs {
  port: number;
  workspace: string;
  projectId: string;
  /** ACP 后端可执行命令（如 `qodercn`）；Bridge 以其 + `backendArgs` spawn 后端。 */
  backendCmd: string;
  risk: BridgeRisk;
  /** 后端参数数组；缺省 = {@link DEFAULT_BACKEND_ARGS}。 */
  backendArgs?: readonly string[];
  /**
   * `--system-prompt` 解析结果（自定义注入文本；v0.8.5 · M4）：缺省 / 空串 ⇒ `undefined`
   * ⇒ 桥只用**缺省 outcome 约定**注入（B12③ 单一源）。
   */
  systemPrompt?: string;
  /** `--system-prompt-mode` 解析结果（`append` | `replace`）；缺省 / 非法 ⇒ `undefined` ⇒ 桥缺省 `append`。 */
  systemPromptMode?: "append" | "replace";
  /**
   * `--model` 解析结果（平铺 `agentConfig.model` 原样值）；缺省 / 空串 ⇒ `undefined`
   * （此时桥**不发** `session/set_config_option`）。
   */
  model?: string;
  /**
   * `--mode` 解析结果（**原样值**；REQ-v0.8.5 · M1）；缺省 / 空串 ⇒ `undefined`
   * ⇒ 桥**不发** mode 请求（`session/set_mode` 与回落用的 `set_config_option{configId:"mode"}` 均不发）。
   */
  mode?: string;
  /** `--collaboration-mode` 解析结果（**原样值**）；缺省 / 空串 ⇒ `undefined` ⇒ 桥不发该请求。 */
  collaborationMode?: string;
  /**
   * `--session-meta-json` 解析结果（会话建立期 `_meta` 注入，供 claude full 档用）；
   * 缺省 ⇒ 三路（new / load / resume）均不携带 `_meta` 键。
   */
  sessionMeta?: Record<string, unknown>;
  /**
   * `--session-timeout` 解析结果（会话执行超时毫秒数，v0.8.7 · M1）；缺省 ⇒ `undefined`
   * ⇒ 由 {@link startBridge} 落 `deps.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS`。
   */
  sessionTimeoutMs?: number;
}

function requiredArg(map: ReadonlyMap<string, string>, key: string): string {
  const value = map.get(key);
  if (value === undefined || value.length === 0) {
    throw new Error(`缺少必填参数 --${key}`);
  }
  return value;
}

/** 解析 CLI 参数（`--key value` 形式；未知键忽略）。非法即抛错。 */
export function parseBridgeArgs(argv: readonly string[]): BridgeArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 ${token} 缺少取值`);
    }
    map.set(token.slice(2), value);
    i += 1;
  }

  const port = Number(map.get("port"));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("--port 必须是 1-65535 的整数");
  }
  const riskRaw = map.get("risk") ?? "write";
  if (riskRaw !== "read" && riskRaw !== "write" && riskRaw !== "full") {
    throw new Error("--risk 必须是 read / write / full");
  }
  const backendArgs = parseBackendArgs(map.get("backend-args"));
  const model = parseModelArg(map.get("model"));
  const mode = parseModelArg(map.get("mode"));
  const collaborationMode = parseModelArg(map.get("collaboration-mode"));
  const sessionMeta = parseSessionMetaArg(map.get("session-meta-json"));
  const systemPrompt = parseModelArg(map.get("system-prompt"));
  const systemPromptMode = parseSystemPromptModeArg(map.get("system-prompt-mode"));
  const sessionTimeoutMs = parseSessionTimeoutArg(map.get("session-timeout"));
  return {
    port,
    workspace: requiredArg(map, "workspace"),
    projectId: requiredArg(map, "project-id"),
    backendCmd: requiredArg(map, "backend-cmd"),
    risk: riskRaw,
    ...(backendArgs !== undefined ? { backendArgs } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(systemPromptMode !== undefined ? { systemPromptMode } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(collaborationMode !== undefined ? { collaborationMode } : {}),
    ...(sessionMeta !== undefined ? { sessionMeta } : {}),
    ...(sessionTimeoutMs !== undefined ? { sessionTimeoutMs } : {}),
  };
}

/**
 * `--session-timeout` 解析（v0.8.7 · M1）：**只做「整数 > 0」宽松校验**（纪律同 `--port`），非法即抛。
 * 上限（15 min）护栏**不在桥侧** —— `acp-bridge` 是零仓内依赖的叶模块，复制上限常量必漂移，
 * 单一源在 launcher 的项目配置解析处。缺省 ⇒ `undefined`（⇒ 由 `startBridge` 落
 * `deps.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS`）。
 */
export function parseSessionTimeoutArg(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("--session-timeout 必须是正整数毫秒");
  }
  return value;
}

/**
 * `--model` 解析：**不做校验**（值原样透传给 ACP `session/set_config_option`）。
 * 缺省 / 空串 ⇒ `undefined`（⇒ 桥不发该请求，行为与未引入本通路时逐字一致）。
 */
export function parseModelArg(raw: string | undefined): string | undefined {
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

/**
 * `--system-prompt-mode` 解析（v0.8.5 · M4）：取值仅 `append` / `replace`。
 * 缺省 / 空串 / 其它值 ⇒ `undefined`（⇒ `AcpInjectionConfig` 缺省 `append`，与退役前行为一致）。
 */
export function parseSystemPromptModeArg(
  raw: string | undefined,
): "append" | "replace" | undefined {
  return raw === "append" || raw === "replace" ? raw : undefined;
}

/**
 * `--session-meta-json` 解析（REQ-v0.8.5 · M1）：JSON **对象**，原样作为会话建立参数的 `_meta` 注入
 * （`session/new` / `load` / `resume` **三路统一携带**）。缺省 / 空串 ⇒ `undefined`（⇒ 零注入）。
 * 非法 JSON / 非对象 ⇒ 抛错（参数格式错误 fail-fast，纪律同 `--backend-args`）。
 */
export function parseSessionMetaArg(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--session-meta-json 不是合法 JSON：${raw.slice(0, 80)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--session-meta-json 必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/** `--backend-args` 解析：JSON 字符串数组；缺省返回 `undefined`（由调用方落 {@link DEFAULT_BACKEND_ARGS}）。 */
export function parseBackendArgs(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--backend-args 不是合法 JSON：${raw.slice(0, 80)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("--backend-args 必须是 JSON 字符串数组");
  }
  return parsed as string[];
}

/**
 * 兼容保留：B1 的纯回显执行器（**已被运行链取代**，仅作离线自测 / 回退用途）。
 * 生产路径见 {@link startBridge}。
 */
export function createStubExecutor(): TaskExecutor {
  return {
    execute(input: TaskExecutionInput): Promise<TaskExecutionResult> {
      return Promise.resolve({ state: "completed", text: `stub:${input.text}` });
    },
  };
}

/** `startBridge` 依赖注入（测试可替换 spawn/env/logger）。 */
export interface StartBridgeDeps {
  spawn?: AcpSpawn;
  env?: NodeJS.ProcessEnv;
  logger?: (message: string) => void;
  sessionTimeoutMs?: number;
}

/** 已启动的桥（server 尚未 listen；由调用方决定端口）。 */
export interface RunningBridge {
  server: AcpA2AServer;
  client: AcpClient;
  runner: AcpSessionRunner;
}

/**
 * 装配完整链：spawn 后端 → `initialize` 握手 → 权限处理器 → 会话执行器 → A2A 服务面。
 * 端口 listen 由调用方执行（便于以 `port=0` 取随机端口做集成测试）。
 */
export async function startBridge(args: BridgeArgs, deps: StartBridgeDeps = {}): Promise<RunningBridge> {
  const logger = deps.logger ?? ((message: string): void => console.log(message));
  const client = new AcpClient({
    command: args.backendCmd,
    args: [...(args.backendArgs ?? DEFAULT_BACKEND_ARGS)],
    cwd: args.workspace,
    env: deps.env ?? { ...process.env },
    spawn: deps.spawn ?? createNodeAcpSpawn(),
    logger,
  });
  await client.initialize();
  client.setRequestHandler(createPermissionHandler(args.risk, logger));

  // 自定义注入（v0.8.5 · M4）：段与 `--config-file` 通道退役 ⇒ 直接来自桥 flag。
  const injection: AcpInjectionConfig = {
    ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
    ...(args.systemPromptMode !== undefined ? { systemPromptMode: args.systemPromptMode } : {}),
  };
  const sessions = new SessionMap({ projectId: args.projectId, baseDir: args.workspace, logger });
  const runner = new AcpSessionRunner({
    client,
    cwd: args.workspace,
    sessions,
    timeoutMs: args.sessionTimeoutMs ?? deps.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
    injection,
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
    ...(args.collaborationMode !== undefined ? { collaborationMode: args.collaborationMode } : {}),
    ...(args.sessionMeta !== undefined ? { sessionMeta: args.sessionMeta } : {}),
    logger,
  });
  const server = createAcpA2AServer({ executor: runner, logger });
  return { server, client, runner };
}

/** 判断是否作为入口直接执行（避免被 import 时触发 main）。 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<void> {
  const args = parseBridgeArgs(process.argv.slice(2));
  let running: RunningBridge | null = null;
  try {
    running = await startBridge(args);
    await running.server.listen(args.port);
  } catch (err) {
    // 端口占用等启动期致命错误 → 结构化退出（非静默）
    const fatal = classifyFatal(err);
    console.error(`[acp-bridge] fatal(${fatal.code}) exit=${String(fatal.exitCode)}: ${fatal.message}`);
    process.exit(fatal.exitCode);
    return;
  }
  console.log(
    `[acp-bridge] project=${args.projectId} listening 127.0.0.1:${String(running.server.port())} ` +
      `backend=${args.backendCmd} risk=${args.risk} workspace=${args.workspace}`,
  );

  const shutdown = (signal: string): void => {
    console.log(`[acp-bridge] 收到 ${signal}，优雅退出`);
    void (async () => {
      await running.server.close();
      await running.client.close();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (isMain()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[acp-bridge] 启动失败：${message}`);
    process.exit(1);
  });
}
