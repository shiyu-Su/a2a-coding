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
      this.logger(`[acp] 收到未知 id 的响应：${String(id)}`);
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
 * 缺省 spawn：`node:child_process`，POSIX `detached:true`（独立进程组 ⇒ 可组杀），
 * Windows 走 `taskkill /T /F`；`kill()` = **树杀**（防孤儿 qodercn）。
 */
export function createNodeAcpSpawn(): AcpSpawn {
  return (command, args, options) => {
    const child = spawn(command, [...args], {
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
