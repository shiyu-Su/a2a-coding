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
 *       [--backend-args <JSON字符串数组>] [--config-file <path> --config-segment <kind>]
 *       [--model <value>]`
 *
 * v0.8.1 · M1：后端参数数组化（`--backend-args`，缺省 `["--acp"]` 保 qoder 逐字不变）；
 * `--config-file` + `--config-segment` 最小配置面（读 writeAgentConfig 产物的指定段，
 * 本节点只读取与透传，注入时机归 M2；缺文件 / 缺段 / 坏 JSON 一律告警不崩、配置取空）。
 *
 * v0.8.2 · M1（协议面增补）：`--model` = 项目 `agentConfig.<kind>.model` 的**原样透传值**，
 * 由 `AcpSessionRunner` 在会话建立（new / load / resume）成功后经 ACP
 * `session/set_config_option {configId:"model"}` 下发；缺省 / 空串 ⇒ 不发该请求（与旧版逐字一致）。
 * 走 CLI 而非 `--config-file` 白名单扩展：后者只覆盖 opencode，qoder 不接该通道。
 *
 * 不 import `launcher/**` / `orch/**`；无第三方依赖（仅 node:*）。
 */
import { readFileSync } from "node:fs";
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
  /** writeAgentConfig 产物路径（可选；与 `configSegment` 同时给出才生效）。 */
  configFile?: string;
  /** 读取 configFile 中的段名（如 `opencode`；machine 自消费段的段选择器）。 */
  configSegment?: string;
  /**
   * `--model` 解析结果（`agentConfig.<kind>.model` 原样值）；缺省 / 空串 ⇒ `undefined`
   * （此时桥**不发** `session/set_config_option`）。
   */
  model?: string;
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
  return {
    port,
    workspace: requiredArg(map, "workspace"),
    projectId: requiredArg(map, "project-id"),
    backendCmd: requiredArg(map, "backend-cmd"),
    risk: riskRaw,
    ...(backendArgs !== undefined ? { backendArgs } : {}),
    ...(map.get("config-file") !== undefined ? { configFile: map.get("config-file") } : {}),
    ...(map.get("config-segment") !== undefined
      ? { configSegment: map.get("config-segment") }
      : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * `--model` 解析：**不做校验**（值原样透传给 ACP `session/set_config_option`）。
 * 缺省 / 空串 ⇒ `undefined`（⇒ 桥不发该请求，行为与未引入本通路时逐字一致）。
 */
export function parseModelArg(raw: string | undefined): string | undefined {
  return raw === undefined || raw.length === 0 ? undefined : raw;
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
 * 读 `--config-file` 产物中 `--config-segment` 指定段（v0.8.1 · M1 最小配置面）。
 * 容忍纪律：任何缺失 / 损坏都**只告警不抛错**，配置取空对象（注入面在 M2 消费）。
 */
export function readConfigSegment(opts: {
  configFile?: string;
  configSegment?: string;
  logger?: (message: string) => void;
}): Record<string, unknown> {
  const log = opts.logger ?? ((message: string): void => console.log(message));
  const { configFile, configSegment } = opts;
  if (configFile === undefined || configFile.length === 0) return {};
  if (configSegment === undefined || configSegment.length === 0) {
    log(`[acp-bridge] 给出 --config-file 但缺 --config-segment，配置取空：${configFile}`);
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(configFile, "utf8");
  } catch (err) {
    log(`[acp-bridge] 读 config-file 失败（配置取空）：${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log(`[acp-bridge] config-file 非合法 JSON（配置取空）：${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    log("[acp-bridge] config-file 顶层非对象（配置取空）");
    return {};
  }
  const segment = (parsed as Record<string, unknown>)[configSegment];
  if (typeof segment !== "object" || segment === null || Array.isArray(segment)) {
    log(`[acp-bridge] config-file 缺段或段非对象（配置取空）：${configSegment}`);
    return {};
  }
  return segment as Record<string, unknown>;
}

/**
 * 从 config 段解析 M2 首轮注入参数（v0.8.1 · M2）。
 * 容忍纪律同 M1：非法类型 ⇒ 忽略该键（缺省 = 仅缺省约定注入，不抛错）。
 */
export function parseInjectionConfig(segment: Record<string, unknown>): AcpInjectionConfig {
  const config: AcpInjectionConfig = {};
  const systemPrompt = segment["systemPrompt"];
  if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
    config.systemPrompt = systemPrompt;
  }
  const mode = segment["systemPromptMode"];
  if (mode === "append" || mode === "replace") {
    config.systemPromptMode = mode;
  } else if (typeof mode === "string" && mode.length > 0) {
    console.log(`[acp-bridge] systemPromptMode 非法（忽略，缺省 append）：${mode}`);
  }
  return config;
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
  /** `--config-file` 指定段的解析结果（无配置面时为空对象；M2 消费）。 */
  config: Record<string, unknown>;
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

  const config = readConfigSegment({
    ...(args.configFile !== undefined ? { configFile: args.configFile } : {}),
    ...(args.configSegment !== undefined ? { configSegment: args.configSegment } : {}),
    logger,
  });
  const injection = parseInjectionConfig(config);
  const sessions = new SessionMap({ projectId: args.projectId, baseDir: args.workspace, logger });
  const runner = new AcpSessionRunner({
    client,
    cwd: args.workspace,
    sessions,
    timeoutMs: deps.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
    injection,
    ...(args.model !== undefined ? { model: args.model } : {}),
    logger,
  });
  const server = createAcpA2AServer({ executor: runner, logger });
  return { server, client, runner, config };
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
