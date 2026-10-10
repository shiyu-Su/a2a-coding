/**
 * ACP 桥的 A2A 服务面（REQ-v0.8.0-2026-09-19-01 · 节点 B1）。
 *
 * 职责：`node:http` 监听一个端口，**只提供 `POST /a2a/jsonrpc`**，兼容
 * `machine/launcher/a2a-client.ts` 的既有调用形状（Runner 派发链的消费面）：
 * - `message/send`（`configuration.blocking:false` = 立即回 task 句柄）；
 * - `tasks/get`（轮询至终态）；
 * - `tasks/cancel`。
 *
 * 执行器 / 时钟 / id 工厂全部经构造注入；本模块**不 import `orch/**` / `launcher/**`**
 * （A2A 形状在本模块内自持，防依赖倒置）。
 *
 * 就绪语义：`listen()` resolve = 端口已 listening（Launcher 的 `waitForPort` 为 TCP 探测，
 * listen 即就绪，不依赖 `/health`）。
 *
 * v0.10.2 · 节点 M-2：本模块是 **`message.metadata`（角色意图载体）的唯一解析点**（{@link parseRoleIntent}）
 * —— 解析产物以 typed 字段挂在 `MessageSendParams` 上透给执行器，桥内其它模块不得再读 `metadata`。
 * **不传 ⇒ 两个键都不落 ⇒ 派发链逐字现状**。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TaskRegistry, type MessageSendParams } from "./task-registry.js";
import type { A2ATask, Clock, SessionOverrides, TaskExecutor, TextPart } from "./types.js";

/** 唯一业务路径（与 `a2a-client.ts` 的 `${endpoint}/a2a/jsonrpc` 一致）。 */
export const A2A_JSONRPC_PATH = "/a2a/jsonrpc";

const JSONRPC_VERSION = "2.0";
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;
const RPC_TASK_NOT_FOUND = -32001;
/** 请求体上限（1 MiB；prompt 级载荷足够，防内存滥用） */
const MAX_BODY_BYTES = 1_048_576;

export interface AcpA2AServerOptions {
  /** 任务执行器（**必填**，可注入） */
  executor: TaskExecutor;
  /** 可注入时钟（缺省 `() => new Date()`） */
  now?: Clock;
  /** 任务 id 生成（缺省 `randomUUID`；注入便于单测） */
  idFactory?: () => string;
  /** 监听地址（缺省 `127.0.0.1`，与 endpoint 约定一致） */
  host?: string;
  /** 日志出口（缺省静默） */
  logger?: (message: string) => void;
}

export interface AcpA2AServer {
  readonly server: Server;
  /** 在 `host:port` 上监听；resolve = 已 listening（端口就绪）。`port=0` 取系统分配端口。 */
  listen(port: number): Promise<void>;
  /** 实际监听端口（未监听时抛错）。 */
  port(): number;
  /** 关闭监听（幂等）。 */
  close(): Promise<void>;
}

/** JSON-RPC 请求（解析后）。 */
interface RpcRequest {
  id: unknown;
  method: string;
  params: unknown;
}

/** 带错误码的 RPC 异常（映射为 JSON-RPC error 响应）。 */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 从原始 parts 中提取 v0.3 text parts（忽略非 text / 非法项）。 */
function parseTextParts(raw: unknown): TextPart[] {
  if (!Array.isArray(raw)) return [];
  const parts: TextPart[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const text = item["text"];
    if (item["kind"] === "text" && typeof text === "string") {
      parts.push({ kind: "text", text });
    }
  }
  return parts;
}

/**
 * `metadata` 中被桥**认领**的原样字符串键（v0.10.2 · M-2）。
 * 未列出的键 ⇒ **忽略**（桥不猜后端方言，也不据未知键报错：launcher 侧 `roles` 已有 fail-closed
 * 校验，本侧只是第二道读点，宽容读、不另立判据）。
 */
const OVERRIDE_TEXT_KEYS = ["model", "mode", "collaborationMode", "risk", "systemPrompt"] as const;

/**
 * `message/send` 的**角色意图解析结果**（v0.10.2 · M-2）。
 * 形状与 `TaskExecutionInput` 同位（本对象即透传体，不再另设一层）。
 */
export interface RoleIntent {
  taskType?: string;
  overrides?: SessionOverrides;
}

/**
 * **`message.metadata` 的唯一解析点**（v0.10.2 · M-2 · F-M2 / F-C6）：
 * machine → 后端 agent 段的角色意图自本版经 A2A `metadata` 承载（**新载体，仓内此前零命中**），
 * 桥侧只在此处读一次 —— 其余模块（registry / session / index）一律接**已解析的 typed 字段**，
 * 不得再自行解析 `metadata`（「双通道以 metadata 为准」的另一半 = metadata 也只有一个消费点）。
 *
 * 取值纪律：**逐键宽容**（非串 / 空串 / 非法枚举 ⇒ 该键不落 ⇒ 该旋钮回落构造器），
 * 全部键都落空 ⇒ `overrides` 不落（= 无覆盖，逐字现状）。
 */
export function parseRoleIntent(metadata: unknown): RoleIntent {
  if (!isRecord(metadata)) return {};
  const taskType = metadata["taskType"];
  const overrides: SessionOverrides = {};
  for (const key of OVERRIDE_TEXT_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.length > 0) overrides[key] = value;
  }
  const mode = metadata["systemPromptMode"];
  if (mode === "append" || mode === "replace") overrides.systemPromptMode = mode;
  return {
    ...(typeof taskType === "string" && taskType.length > 0 ? { taskType } : {}),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}

/** 解析 `message/send` 参数；非法返回 `null`。 */
function parseMessageSendParams(params: unknown): MessageSendParams | null {
  if (!isRecord(params)) return null;
  const message = params["message"];
  if (!isRecord(message)) return null;
  const messageId = message["messageId"];
  if (typeof messageId !== "string" || messageId.length === 0) return null;
  const parts = parseTextParts(message["parts"]);
  const contextId = message["contextId"];
  const parsed: MessageSendParams = {
    message: {
      role: message["role"] === "agent" ? "agent" : "user",
      parts,
      messageId,
      ...(typeof contextId === "string" ? { contextId } : {}),
    },
  };
  // v0.10.2 · M-2：`metadata` 缺键 ⇒ `parseRoleIntent` 出空对象 ⇒ 两个键都不落（逐字现状）
  const intent = parseRoleIntent(message["metadata"]);
  if (intent.taskType !== undefined) parsed.taskType = intent.taskType;
  if (intent.overrides !== undefined) parsed.overrides = intent.overrides;
  const configuration = params["configuration"];
  if (isRecord(configuration) && configuration["blocking"] === true) {
    parsed.configuration = { blocking: true };
  }
  return parsed;
}

/** 从 `{ id }` 形状参数取任务 id；非法返回 `null`。 */
function taskIdOf(params: unknown): string | null {
  if (!isRecord(params)) return null;
  const id = params["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

function parseRpcRequest(raw: unknown): RpcRequest | null {
  if (!isRecord(raw)) return null;
  const method = raw["method"];
  if (typeof method !== "string" || method.length === 0) return null;
  return { id: raw["id"], method, params: raw["params"] };
}

function rpcErrorBody(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, error: { code, message } };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 创建 A2A 服务面（未监听）。 */
export function createAcpA2AServer(options: AcpA2AServerOptions): AcpA2AServer {
  const registry = new TaskRegistry({
    executor: options.executor,
    now: options.now,
    idFactory: options.idFactory,
  });
  const host = options.host ?? "127.0.0.1";
  const log = options.logger ?? ((): void => undefined);

  const dispatch = async (request: RpcRequest): Promise<unknown> => {
    switch (request.method) {
      case "message/send": {
        const params = parseMessageSendParams(request.params);
        if (params === null) throw new RpcError(RPC_INVALID_PARAMS, "message/send 参数非法");
        return await registry.send(params);
      }
      case "tasks/get": {
        const id = taskIdOf(request.params);
        if (id === null) throw new RpcError(RPC_INVALID_PARAMS, "tasks/get 缺少 id");
        const task: A2ATask | null = registry.get(id);
        if (task === null) throw new RpcError(RPC_TASK_NOT_FOUND, `未知任务 ${id}`);
        return task;
      }
      case "tasks/cancel": {
        const id = taskIdOf(request.params);
        if (id === null) throw new RpcError(RPC_INVALID_PARAMS, "tasks/cancel 缺少 id");
        const task = await registry.cancel(id);
        if (task === null) throw new RpcError(RPC_TASK_NOT_FOUND, `未知任务 ${id}`);
        return task;
      }
      default:
        throw new RpcError(RPC_METHOD_NOT_FOUND, `未知方法 ${request.method}`);
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "";
    const path = url.split("?")[0] ?? url;
    if (path !== A2A_JSONRPC_PATH) {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: `未知路径 ${path}` } });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "仅支持 POST" } });
      return;
    }

    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch (err) {
      sendJson(res, 413, rpcErrorBody(null, RPC_PARSE_ERROR, errorText(err)));
      return;
    }

    let parsed: unknown = null;
    try {
      parsed = bodyText.length === 0 ? null : JSON.parse(bodyText);
    } catch {
      sendJson(res, 200, rpcErrorBody(null, RPC_PARSE_ERROR, "JSON 解析失败"));
      return;
    }

    const request = parseRpcRequest(parsed);
    if (request === null) {
      const id = isRecord(parsed) ? parsed["id"] : null;
      sendJson(res, 200, rpcErrorBody(id, RPC_INVALID_REQUEST, "非法 JSON-RPC 请求"));
      return;
    }

    try {
      const result = await dispatch(request);
      sendJson(res, 200, { jsonrpc: JSONRPC_VERSION, id: request.id ?? null, result });
    } catch (err) {
      if (err instanceof RpcError) {
        sendJson(res, 200, rpcErrorBody(request.id, err.code, err.message));
      } else {
        log(`[acp-bridge] 内部错误：${errorText(err)}`);
        sendJson(res, 200, rpcErrorBody(request.id, RPC_INTERNAL_ERROR, errorText(err)));
      }
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  return {
    server,
    listen(port: number): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    port(): number {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("A2A 服务未监听，无法取端口");
      }
      return address.port;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },
  };
}
