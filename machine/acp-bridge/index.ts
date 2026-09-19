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
 *       --project-id <id> --backend-cmd <cmd> --risk <read|write|full>`
 *
 * 不 import `launcher/**` / `orch/**`；无第三方依赖（仅 node:*）。
 */
import { pathToFileURL } from "node:url";
import { createAcpA2AServer, type AcpA2AServer } from "./a2a-server.js";
import { AcpClient, createNodeAcpSpawn } from "./acp/client.js";
import { createPermissionHandler } from "./acp/permission.js";
import { AcpSessionRunner, DEFAULT_SESSION_TIMEOUT_MS } from "./acp/session.js";
import type { AcpSpawn } from "./acp/types.js";
import { classifyFatal } from "./lifecycle.js";
import { SessionMap } from "./session-map.js";
import type { TaskExecutionInput, TaskExecutionResult, TaskExecutor } from "./types.js";

/** 风险档位（与线协议 `RiskLevel` 同口径；本模块自带字面量，不 import launcher/types）。 */
export type BridgeRisk = "read" | "write" | "full";

/** 桥启动参数。 */
export interface BridgeArgs {
  port: number;
  workspace: string;
  projectId: string;
  /** ACP 后端可执行命令（如 `qodercn`）；Bridge 以其 + `--acp` spawn 后端。 */
  backendCmd: string;
  risk: BridgeRisk;
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
  return {
    port,
    workspace: requiredArg(map, "workspace"),
    projectId: requiredArg(map, "project-id"),
    backendCmd: requiredArg(map, "backend-cmd"),
    risk: riskRaw,
  };
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
    args: ["--acp"],
    cwd: args.workspace,
    env: deps.env ?? { ...process.env },
    spawn: deps.spawn ?? createNodeAcpSpawn(),
    logger,
  });
  await client.initialize();
  client.setRequestHandler(createPermissionHandler(args.risk, logger));

  const sessions = new SessionMap({ projectId: args.projectId, baseDir: args.workspace, logger });
  const runner = new AcpSessionRunner({
    client,
    cwd: args.workspace,
    sessions,
    timeoutMs: deps.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
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
