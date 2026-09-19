/**
 * ACP（Agent Client Protocol）stdio 客户端类型 —— `machine/acp-bridge/acp/`。
 *
 * 归属：REQ-v0.8.0-2026-09-19-01 · 节点 B2。**零仓内依赖**（不 import `orch/**` / `launcher/**`）。
 *
 * 方言依据 = P1 探针**实测**（`qoderclicn --acp` v1.1.57）：
 * - framing = **newline-delimited JSON**（每条消息一行，`\n` 结尾；非 Content-Length）；
 * - `initialize` params `{ protocolVersion: 1, clientCapabilities: {} }` →
 *   result `{ protocolVersion, authMethods?, agentInfo?, agentCapabilities? }`；
 * - 通知 `session/update` 无 `id`；服务端请求（如 `session/request_permission`）有 `id` + `method`。
 */
import type { Readable, Writable } from "node:stream";

/** JSON-RPC id（ACP 实测为 number；宽容 string）。 */
export type JsonRpcId = string | number;

/** JSON-RPC 错误对象。 */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** 入站消息：响应（有 id 无 method）/ 通知（有 method 无 id）/ 服务端请求（id + method）。 */
export type AcpInbound =
  | { kind: "response"; id: JsonRpcId | null; result?: unknown; error?: JsonRpcErrorObject }
  | { kind: "notification"; method: string; params?: unknown }
  | { kind: "request"; id: JsonRpcId; method: string; params?: unknown };

/** `initialize` 参数（实测缺省 `protocolVersion: 1`）。 */
export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities?: Record<string, unknown>;
}

/** `initialize` 结果中的认证方式。 */
export interface AcpAuthMethod {
  id: string;
  name?: string;
  description?: string;
}

/** `initialize` 结果中的后端信息。 */
export interface AcpAgentInfo {
  name?: string;
  title?: string;
  version?: string;
}

/** `initialize` 结果（保留未知字段以便前瞻兼容）。 */
export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: AcpAgentInfo;
  agentCapabilities?: Record<string, unknown>;
  authMethods?: AcpAuthMethod[];
  [key: string]: unknown;
}

/** ACP 错误类别（结构化错误：不以裸字符串暴露给调用方）。 */
export type AcpErrorKind = "spawn" | "closed" | "timeout" | "rpc" | "protocol";

/**
 * 子进程最小接口（`spawn` 返回；单测注入 fake 时同形）。
 * 仅暴露 B2 所需：三流 + kill + exit/error 订阅。
 */
export interface AcpChildProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

/** spawn 选项。 */
export interface AcpSpawnOptions {
  cwd?: string;
  /** **显式继承** 的环境（调用方传 `{ ...process.env }`，文件凭据经此可读）。 */
  env: NodeJS.ProcessEnv;
}

/** 可注入 spawn（缺省实现见 `client.ts` 的 `createNodeAcpSpawn`）。 */
export type AcpSpawn = (
  command: string,
  args: readonly string[],
  options: AcpSpawnOptions,
) => AcpChildProcess;
