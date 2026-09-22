/**
 * ACP stdio JSON-RPC 客户端（REQ-v0.8.0-2026-09-19-01 · 节点 B2）。
 *
 * 方言依据 = **P1 探针实测**（`qoderclicn --acp` v1.1.57）：
 * - framing = **newline-delimited JSON**（stdout 逐行 JSON；`\n` 分隔，容忍 `\r\n`）；
 * - `initialize` params `{ protocolVersion: 1, clientCapabilities: {} }`；
 * - 响应按 `id` 关联；通知无 `id`；服务端请求（`session/request_permission`）有 `id` + `method`。
 *
 * 可注入：`spawn`（含 stdio 流）经构造注入（fake stdio 单测）；不 import `orch/**` / `launcher/**`。
 * 后端意外退出 → 所有在飞请求以**结构化** `AcpError`（kind `closed`/`spawn`）拒绝，绝不挂起。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  AcpChildProcess,
  AcpInbound,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpSpawn,
  JsonRpcErrorObject,
  JsonRpcId,
} from "./types.js";
import { killProcessTree } from "../lifecycle.js";

const DEFAULT_PROTOCOL_VERSION = 1;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** ACP 结构化错误（不以裸字符串暴露）。 */
export class AcpError extends Error {
  readonly kind: "spawn" | "closed" | "timeout" | "rpc" | "protocol";
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(
    kind: AcpError["kind"],
    message: string,
    options: { code?: number; data?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AcpError";
    this.kind = kind;
    this.code = options.code;
    this.data = options.data;
  }
}

/** 通知处理器（服务端 → 客户端，无 id）。 */
export type AcpNotificationHandler = (method: string, params: unknown) => void;
/** 服务端请求处理器（服务端 → 客户端，有 id；返回值作为 result 回写）。 */
export type AcpServerRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

export interface AcpClientOptions {
  command: string;
  /** 后端参数（缺省 `["--acp"]`，P1 探针确认）。 */
  args?: readonly string[];
  cwd?: string;
  /** 环境（**显式继承**，调用方传 `{ ...process.env }`；文件凭据经此可读）。 */
  env?: NodeJS.ProcessEnv;
  spawn: AcpSpawn;
  requestTimeoutMs?: number;
  logger?: (message: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: AcpError) => void;
  timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcError(value: unknown): value is JsonRpcErrorObject {
  return (
    isRecord(value) && typeof value["code"] === "number" && typeof value["message"] === "string"
  );
}

function parseInbound(raw: unknown): AcpInbound | null {
  if (!isRecord(raw)) return null;
  const method = raw["method"];
  const id = raw["id"];
  if (typeof method === "string" && method.length > 0) {
    if (id === undefined) return { kind: "notification", method, params: raw["params"] };
    if (typeof id === "string" || typeof id === "number") {
      return { kind: "request", id, method, params: raw["params"] };
    }
    return null;
  }
  if (id === null || typeof id === "string" || typeof id === "number") {
    const error = raw["error"];
    return { kind: "response", id, result: raw["result"], error: isRpcError(error) ? error : undefined };
  }
  return null;
}

/** 迟到响应日志里 payload 的字符上限（「留证据」与「不炸日志」之间的取值）。 */
export const LATE_PAYLOAD_MAX_CHARS = 2_000;

/**
 * 宽 JSON 原文：`JSON.stringify` 无结果（`undefined` / BigInt）或抛错（循环引用）时回落
 * `String(value)`；超 `maxChars` 截断并标 `…(+N)`。**永不抛错**。
 *
 * **导出**：`session.ts` 的 `acpErrorData` 诊断键复用同一实现（勿两处字面量漂移）。
 */
export function wideJson(value: unknown, maxChars: number = LATE_PAYLOAD_MAX_CHARS): string {
  let text: string;
  try {
    const json = JSON.stringify(value);
    text = json === undefined ? String(value) : json;
  } catch {
    text = String(value);
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…(+${String(text.length - maxChars)})`;
}

/**
 * 迟到响应（请求侧已超时并 `pending.delete` 后才回来的那件）的 payload 摘要 ——
 * `error` 三要素优先，否则 `result` 摘要。这是**唯一能捕获「满窗之后才回来的排队 / 限流错误」**
 * 的现场（v0.8.8 · M1 取证面）。
 */
function latePayloadText(result: unknown, error: JsonRpcErrorObject | undefined): string {
  if (error !== undefined) {
    const data = error.data === undefined ? "" : ` data=${wideJson(error.data)}`;
    return `error code=${String(error.code)} message=${error.message}${data}`;
  }
  return `result=${wideJson(result)}`;
}

/** NDJSON JSON-RPC 客户端（单个后端进程）。 */
export class AcpClient {
  private readonly child: AcpChildProcess;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Set<AcpNotificationHandler>();
  private requestHandler: AcpServerRequestHandler | null = null;
  private readonly requestTimeoutMs: number;
  private readonly logger: (message: string) => void;
  private nextId = 1;
  private closed = false;
  private exitReason: AcpError | null = null;
  private stdoutBuffer = "";

  constructor(options: AcpClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = options.logger ?? ((): void => undefined);
    this.child = options.spawn(options.command, [...(options.args ?? ["--acp"])], {
      cwd: options.cwd,
      env: options.env ?? { ...process.env },
    });
    this.child.stdout.on("data", (chunk: unknown) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: unknown) => this.logger(`[acp] stderr: ${toText(chunk)}`));
    this.child.onError((error) =>
      this.fail(new AcpError("spawn", `ACP 后端进程错误：${error.message}`, { cause: error })),
    );
    this.child.onExit((code, signal) =>
      this.fail(
        new AcpError("closed", `ACP 后端进程退出（code=${String(code)}, signal=${String(signal)}）`),
      ),
    );
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** 注册通知处理器；返回取消函数。 */
  onNotification(handler: AcpNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  /** 注册唯一服务端请求处理器（如 `session/request_permission`）。 */
  setRequestHandler(handler: AcpServerRequestHandler): void {
    this.requestHandler = handler;
  }

  /** `initialize` 握手（P1 探针形状）。 */
  async initialize(
    params?: Partial<AcpInitializeParams>,
    timeoutMs?: number,
  ): Promise<AcpInitializeResult> {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        clientCapabilities: params?.clientCapabilities ?? {},
      },
      timeoutMs,
    );
    if (!isRecord(result)) throw new AcpError("protocol", "initialize 响应非法（非对象）");
    const protocolVersion = result["protocolVersion"];
    if (typeof protocolVersion !== "number") {
      throw new AcpError("protocol", "initialize 响应缺少 protocolVersion");
    }
    return { ...result, protocolVersion };
  }

  /** 发送 JSON-RPC 请求并等待响应（按 id 关联；超时 → `timeout`）。 */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) throw this.exitReason ?? new AcpError("closed", "ACP 客户端已关闭");
    const id = this.nextId;
    this.nextId += 1;
    const timeout = timeoutMs ?? this.requestTimeoutMs;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpError("timeout", `ACP 请求超时：${method}（${String(timeout)}ms）`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return await promise;
  }

  /**
   * 发送 JSON-RPC 通知（无 `id`，不等响应；REQ-v0.8.1 M1③）。
   * 探针实证：opencode 的 `session/cancel` 为 notification 形态（请求形态反而无响应可回）。
   */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  /** 关闭：拒绝在飞请求并**树杀**后端进程（防孤儿）。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.exitReason = new AcpError("closed", "ACP 客户端已关闭");
    this.rejectAll(this.exitReason);
    try {
      this.child.kill("SIGTERM");
    } catch {
      // 进程可能已退出
    }
  }

  private rejectAll(error: AcpError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private fail(error: AcpError): void {
    if (this.closed) return;
    this.closed = true;
    this.exitReason = error;
    this.rejectAll(error);
    this.logger(`[acp] ${error.kind}：${error.message}`);
  }

  private write(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    try {
      this.child.stdin.write(line);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.fail(new AcpError("closed", `ACP 写入失败：${text}`, { cause: err }));
    }
  }

  private onStdout(chunk: unknown): void {
    this.stdoutBuffer += toText(chunk);
    for (;;) {
      const index = this.stdoutBuffer.indexOf("\n");
      if (index < 0) break;
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line.trim().length > 0) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.logger(`[acp] 无法解析入站行（忽略）：${line.slice(0, 200)}`);
      return;
    }
    const inbound = parseInbound(parsed);
    if (inbound === null) {
      this.logger("[acp] 非法 JSON-RPC 消息（忽略）");
      return;
    }
    switch (inbound.kind) {
      case "response":
        this.handleResponse(inbound.id, inbound.result, inbound.error);
        break;
      case "notification":
        this.dispatchNotification(inbound.method, inbound.params);
        break;
      case "request":
        void this.dispatchRequest(inbound.id, inbound.method, inbound.params);
        break;
    }
  }

  private handleResponse(id: JsonRpcId | null, result: unknown, error: JsonRpcErrorObject | undefined): void {
    if (id === null) return;
    const pending = this.pending.get(id);
    if (pending === undefined) {
      // 迟到响应留痕（v0.8.8 · M1 取证面）：超时时 `pending.delete` 已发生 ⇒ 响应回来只能落这里。
      // 历史取证（launcher.log 31/31 次皆紧跟某条 failed）证明 payload 一字不留 = 排队证据被吃掉。
      this.logger(
        `[acp] 收到未知 id 的响应（迟到件，payload 留痕）：${String(id)} ${latePayloadText(result, error)}`,
      );
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error !== undefined) {
      pending.reject(new AcpError("rpc", error.message, { code: error.code, data: error.data }));
      return;
    }
    pending.resolve(result);
  }

  private dispatchNotification(method: string, params: unknown): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(method, params);
      } catch (err) {
        this.logger(`[acp] 通知处理器异常：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async dispatchRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandler;
    if (handler === null) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `未注册的服务端请求方法：${method}` },
      });
      return;
    }
    try {
      const result = await handler(method, params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      const acpError = err instanceof AcpError ? err : null;
      this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: acpError?.code ?? -32603,
          message: err instanceof Error ? err.message : String(err),
          ...(acpError?.data !== undefined ? { data: acpError.data } : {}),
        },
      });
    }
  }
}

function toText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  return String(chunk);
}

/**
 * `shell:false` 下可直调的扩展名（CreateProcess 语义）。
 * 探针实证（REQ-v0.8.2 P1 · Node v24/win32）：`.cmd`/`.bat` 直调抛 `EINVAL`、裸名（仅存 `.cmd` 壳）
 * `ENOENT` ⇒ 批处理壳不可直调；按改造文档 B4 退化为「只补 `.exe` 候选」。
 */
const SHELL_SPAWNABLE_EXTS = new Set([".exe"]);

/**
 * win32 下 `shell:false` **不可直调**的扩展名（P1 实测：`.cmd`/`.bat` ⇒ EINVAL、`.ps1` ⇒ EFTYPE）。
 * 命中即明确报错，不喂给 spawn、不解析批处理内容、不退回 `shell:true`（DEP0190 只拼接不转义）。
 *
 * **导出**：`adapters/backend-entry.ts` 的分层探测复用**同一集合**判 `rejected-shell`（勿两处字面量漂移）。
 */
export const WIN_SPAWN_REJECTED_EXTS = new Set([".cmd", ".bat", ".ps1"]);

export interface ResolveSpawnCommandDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 候选存在性判据（缺省 = 真实文件系统上的普通文件；注入便于单测）。 */
  isFile?: (candidate: string) => boolean;
}

/**
 * 命令别名 / PATHEXT 候选补全（REQ-v0.8.2 M2 · A4/B4）——消除「裸命令名 ENOENT」部署坑。
 *
 * 只在 win32 生效；**显式 `.cmd`/`.bat`/`.ps1`（含绝对路径）⇒ 抛 `AcpError("spawn")` 明确报错**
 * （P1 实测直调 EINVAL/EFTYPE，静默失败难排查）；其余**绝对路径 / 已带扩展名 / 候选全不命中一律原样返回**
 * （失败保持与现状一致的 ENOENT 路径，不得静默改写）。候选序列 = PATHEXT ∩ 可直调集（实测退化为
 * `.exe`）；检索目录序：裸名 = cwd → PATH；带目录的相对路径 = 仅该目录（对齐 CreateProcess「相对路径
 * 只按自身目录解析、不并入 PATH」语义）。
 */
export function resolveSpawnCommand(command: string, deps: ResolveSpawnCommandDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform !== "win32") return command;
  if (command.length === 0) return command;

  const ext = path.win32.extname(command).toLowerCase();
  if (WIN_SPAWN_REJECTED_EXTS.has(ext)) {
    throw new AcpError(
      "spawn",
      `ACP 后端命令 "${command}" 以 ${ext} 结尾：Windows shell:false 无法直调批处理/脚本壳（实测 EINVAL/EFTYPE）。` +
        "请在项目配置中改为对应 .exe 真身的绝对路径（如 opencode → node_modules/opencode-ai/bin/opencode.exe）。",
    );
  }
  if (path.win32.isAbsolute(command)) return command;
  if (ext.length > 0) return command;

  const isFile =
    deps.isFile ??
    ((candidate: string): boolean => {
      try {
        return existsSync(candidate);
      } catch {
        return false;
      }
    });

  const pathExt = (env["PATHEXT"] ?? ".EXE")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0 && SHELL_SPAWNABLE_EXTS.has(e));
  if (pathExt.length === 0) return command;

  const parsed = path.win32.parse(command);
  const searchDirs: string[] = [];
  if (parsed.dir.length > 0) {
    if (!path.win32.isAbsolute(parsed.dir)) {
      searchDirs.push(path.win32.resolve(deps.cwd ?? process.cwd(), parsed.dir));
    }
    // 绝对目录前缀的相对形态（`C:foo` 驱动器相对）极少见：不检索，原样返回走现状路径
  } else {
    searchDirs.push(deps.cwd ?? process.cwd());
  }
  for (const entry of (env["PATH"] ?? env["Path"] ?? "").split(";")) {
    const dir = entry.trim().replace(/^"|"$/g, "");
    if (dir.length > 0 && dir !== ".") searchDirs.push(dir);
  }

  for (const dir of searchDirs) {
    for (const candidateExt of pathExt) {
      const candidate = path.win32.join(dir, `${parsed.name}${candidateExt}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return command;
}

/**
 * 缺省 spawn：`node:child_process`，POSIX `detached:true`（独立进程组 ⇒ 可组杀），
 * Windows 走 `taskkill /T /F`；`kill()` = **树杀**（防孤儿 qodercn）。
 */
export function createNodeAcpSpawn(): AcpSpawn {
  return (command, args, options) => {
    const child = spawn(resolveSpawnCommand(command, { env: options.env, cwd: options.cwd }), [...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      kill: (signal) => {
        if (child.pid !== undefined) killProcessTree(child.pid, { signal: signal ?? "SIGTERM" });
        return true;
      },
      onExit: (listener) => {
        child.on("exit", listener);
      },
      onError: (listener) => {
        child.on("error", listener);
      },
    };
  };
}
