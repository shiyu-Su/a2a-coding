/**
 * 最小 A2A 客户端（v0.7.0 · 节点 M3·MB1）：**machine 单元内共享**模块。
 *
 * 由 `self-check.ts` 的进程内实现**上提**而来 —— 同一套线协议解析不再各写一份，
 * 供「启动自检」与「Runner 命令执行」共用（不跨单元共享：orch 侧有各自实现）。
 *
 * 线协议：包装器服务端以 legacyCompat 挂载 `/a2a/jsonrpc`（v0.3 兼容），故用原生 fetch
 * 直发 v0.3 形状的 `message/send` / `tasks/get` / `tasks/cancel`（role "user"、parts
 * `kind:"text"`、必填 messageId；configuration 缺省即 returnImmediately）。不引新依赖。
 *
 * 出口收敛：全部经可注入的 {@link A2AFetch}（缺省全局 `fetch`），便于单测替换。
 */
import { randomUUID } from "node:crypto";

/** 单条 JSON-RPC HTTP 请求超时下限（不超过调用方预算即可） */
export const MIN_REQUEST_TIMEOUT_MS = 5_000;

/** 可注入 fetch 出口（缺省全局 `fetch`；单测注入 fake） */
export type A2AFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * v0.3 终态集合：`completed` 为唯一成功态，其余终态均判失败。
 * 轮询据此停止（`taskStateOf` 返回值 ∈ 本集合即终态）。
 */
export const A2A_TERMINAL_STATES: ReadonlySet<string> = new Set([
  "completed",
  "canceled",
  "failed",
  "rejected",
  "input-required",
  "auth-required",
]);

/** v0.3 parts（`[{kind:"text",text}]`）拼接文本 */
export function textFromParts(parts: unknown): string {
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
export function resultText(result: unknown): string {
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
export function statusMessageText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const status = (result as Record<string, unknown>)["status"];
  if (typeof status !== "object" || status === null) return "";
  const message = (status as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return "";
  return textFromParts((message as Record<string, unknown>)["parts"]);
}

/**
 * v0.3 任务态：result 含非空 `id` 视为 Task（Message 无此字段）。
 * 返回 null 表示非 Task；Task 缺 status.state 记为 "unknown"。
 */
export function taskStateOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const o = result as Record<string, unknown>;
  if (typeof o["id"] !== "string" || o["id"].length === 0) return null;
  const status = o["status"];
  if (typeof status !== "object" || status === null) return "unknown";
  const state = (status as Record<string, unknown>)["state"];
  return typeof state === "string" ? state : "unknown";
}

/** v0.3 任务 id：非空字符串 `id` 即 Task id（Message 直返无句柄 → null） */
export function taskIdOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const id = (result as Record<string, unknown>)["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** v0.3 artifacts：非数组一律折算为空数组（保证下游 `[]` 而非 undefined） */
export function artifactsOf(result: unknown): unknown[] {
  if (typeof result !== "object" || result === null) return [];
  const artifacts = (result as Record<string, unknown>)["artifacts"];
  return Array.isArray(artifacts) ? artifacts : [];
}

/** 一次性提取任务视图（Runner 结果组装 / 自检校验共用，避免多次解构） */
export interface A2ATaskView {
  /** Task id；Message 直返（无任务句柄）为 null */
  id: string | null;
  /** 任务态：非 Task（Message 直返）记为 "completed"；缺 state 记为 "unknown" */
  state: string;
  /** 结果文本（Task.status.message + artifacts；Message 取顶层 parts） */
  text: string;
  /** status.message 文本（失败原因） */
  statusText: string;
  /** artifacts 原样（非数组 → `[]`） */
  artifacts: unknown[];
}

export function taskViewOf(result: unknown): A2ATaskView {
  const isTask = taskStateOf(result) !== null;
  return {
    id: taskIdOf(result),
    state: isTask ? (taskStateOf(result) ?? "unknown") : "completed",
    text: resultText(result),
    statusText: statusMessageText(result),
    artifacts: artifactsOf(result),
  };
}

/** 发送 JSON-RPC 2.0 请求并返回 result；HTTP / RPC 错误统一抛出（unknown 文本） */
export async function postJsonRpc(
  endpoint: string,
  method: string,
  params: unknown,
  timeoutMs: number,
  fetchFn?: A2AFetch,
): Promise<unknown> {
  const doFetch: A2AFetch = fetchFn ?? ((input, init) => fetch(input, init));
  const res = await doFetch(`${endpoint}/a2a/jsonrpc`, {
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
