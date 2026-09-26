/**
 * 板侧最小 MCP 客户端（JSON-RPC over Streamable-HTTP）—— 通用端点/请求/解析/调用能力。
 *
 * 自 requirement.ts 抽出（N5 纯重构，行为零变更）：端点组装、tools/call 请求体、
 * 响应信封解析与一次 `tools/call` 的 fetch 全链路。写面口径不变 ——
 * 建需求的唯一封装仍是 `requirement.ts` 的 `createRequirement`，
 * 本文件只承载「与具体工具无关」的客户端能力（工具名为参数，不出现任何写工具字面量）。
 *
 * 选型沿用 requirement.ts 头注：无状态端点、裸 POST + JSON.parse、零运行时依赖。
 * 组身份是参数、绝不硬编码：`null` 身份不可用（空组名直接抛错）。
 */

/** 调用方参数不合法（组身份缺失等）—— 属编程错误，先于网络即抛出。 */
export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementConfigError";
  }
}

/** 归一结果（通用形）：成功 = content JSON 负载原样；失败 = 错误码结构化透传、不吞。 */
export interface ToolCallSucceeded {
  ok: true;
  payload: Record<string, unknown>;
}

export interface ToolCallFailed {
  ok: false;
  code: string;
  error: string;
}

export type ToolCallOutcome = ToolCallSucceeded | ToolCallFailed;

/**
 * `callToolRaw` 的结果（N6 组织视角页）：JSON-RPC 层已解包、**工具级信封未解析**的原始负载。
 * 只读工具（如 `a2a_projects`）的成功负载**没有 `ok` 字段**（成功 = 纯视图、失败 = `{ok:false,…}`），
 * {@link parseToolCallEnvelope} 的「`ok === true` 才算成功」契约会把它误判为失败 —— 故原始出口单独存在，
 * 工具级语义归调用方归一（见 `orgs-view.ts` 的 `normalizeProjectsOutcome`）。
 */
export type ToolCallRawOutcome =
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; code: string; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** 归一 MCP 基址（去尾部斜杠）。 */
export function normalizeMcpBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * 组装 MCP 端点 URL：`<base>/<组名>/mcp`。组名**必须显式非空**（`null` 身份不可用），
 * 且经 `encodeURIComponent` 安全编码进路径首段。
 */
export function buildMcpEndpoint(baseUrl: string, group: string): string {
  const g = group.trim();
  if (g === "") {
    throw new McpConfigError("组身份（group）缺失：板必须以显式组名连接 MCP，null 身份不可用");
  }
  const base = normalizeMcpBaseUrl(baseUrl);
  return `${base}/${encodeURIComponent(g)}/mcp`;
}

/** 组装 JSON-RPC `tools/call` 请求体。 */
export function buildToolsCallRequest(tool: string, args: Record<string, unknown>, id = 1): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: tool, arguments: args },
  };
}

/** 从 `result.content[]` 抽出全部 text 块并拼接。 */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

/**
 * 解析桥的 tools/call 响应为归一结果（纯函数，错误码结构化透传）。三层信封：
 * - JSON-RPC 层 `error` → `jsonrpc_<code>`；
 * - `result.content[].text` 内是桥 handler 的 JSON（`{ok:true,...}` / `{ok:false,code,error}`）；
 * - 非 JSON 文本（如 `MCP error -32602: Input validation error`）→ `protocol_error` 承载原文。
 */
export function parseToolCallEnvelope(json: unknown): ToolCallOutcome {
  if (!isRecord(json)) {
    return { ok: false, code: "response_invalid", error: "桥响应不是 JSON 对象" };
  }

  const rpcError = json.error;
  if (isRecord(rpcError)) {
    const code = typeof rpcError.code === "number" ? `jsonrpc_${rpcError.code}` : "jsonrpc_error";
    return { ok: false, code, error: str(rpcError.message) ?? "JSON-RPC 错误" };
  }

  const result = json.result;
  if (!isRecord(result)) {
    return { ok: false, code: "response_invalid", error: "桥响应缺 result" };
  }

  const text = textOfContent(result.content);
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    payload = undefined;
  }

  if (isRecord(payload) && payload.ok === true) {
    return { ok: true, payload };
  }

  if (isRecord(payload) && payload.ok === false) {
    // 结构化透传桥的错误码与说明（不吞、不改写）。
    return {
      ok: false,
      code: str(payload.code) ?? "unknown",
      error: str(payload.error) ?? "桥返回失败",
    };
  }

  // content 非约定 JSON（协议级校验错误等）：以 isError / 原文兜底，仍结构化返回。
  if (text.trim() === "") {
    return { ok: false, code: "response_invalid", error: "桥 result.content 无文本负载" };
  }
  return {
    ok: false,
    code: result.isError === true ? "protocol_error" : "response_invalid",
    error: text,
  };
}

/**
 * 网络 + JSON-RPC 层解包的公共段：一次 `tools/call` 的 fetch 全链路与外层信封解析
 * （JSON-RPC `error` / 缺 `result` / 非法 JSON ⇒ 结构化失败）。
 * 工具级负载（`result.content[].text` 内的 JSON）不在此归一 —— 信封档与原始档共用本段。
 */
async function fetchToolJson(
  baseUrl: string,
  group: string,
  tool: string,
  args: Record<string, unknown>,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: true; json: Record<string, unknown> } | ToolCallFailed> {
  const url = buildMcpEndpoint(baseUrl, group);
  const body = buildToolsCallRequest(tool, args);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { ok: false, code: "no_fetch", error: "运行环境无 fetch 实现" };
  }

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // 传输层异常：如实结构化上报，不吞成「成功」。
    return { ok: false, code: "transport_error", error: err instanceof Error ? err.message : String(err) };
  }

  const raw = await res.text();
  if (!res.ok) {
    return { ok: false, code: `http_${res.status}`, error: `桥返回 HTTP ${res.status}：${raw.slice(0, 200)}` };
  }
  try {
    const json = JSON.parse(raw) as unknown;
    if (!isRecord(json)) {
      return { ok: false, code: "response_invalid", error: "桥响应不是 JSON 对象" };
    }
    return { ok: true, json };
  } catch {
    return { ok: false, code: "response_invalid", error: `桥响应不是合法 JSON：${raw.slice(0, 200)}` };
  }
}

/**
 * 以组身份对 MCP 端点发起一次 `tools/call` 并解析响应 —— 网络 + 解析的统一链路。
 * 不抛业务错误：桥返回失败、传输层异常，一律归一为 `ToolCallFailed`（不吞）。
 * 仅当调用方参数违反前置（空组名）时抛 {@link McpConfigError}。
 */
export async function callTool(
  baseUrl: string,
  group: string,
  tool: string,
  args: Record<string, unknown>,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ToolCallOutcome> {
  const fetched = await fetchToolJson(baseUrl, group, tool, args, options);
  if (!fetched.ok) return fetched;
  return parseToolCallEnvelope(fetched.json);
}

/**
 * 同 {@link callTool}，但**成功判定放宽**：桥侧部分只读工具（如 `a2a_projects`）的成功负载
 * **没有 `ok` 字段**（成功 = 纯视图、失败 = `{ok:false,code,error}`），{@link parseToolCallEnvelope}
 * 的「`ok === true` 才算成功」契约会把这种视图误判为失败。本出口只把「`ok:false` / RPC error /
 * 坏信封」收口成结构化失败，**其余对象负载原样交出**（工具级语义归调用方归一，
 * 见 `orgs-view.ts` 的 `normalizeProjectsOutcome`）。
 */
export async function callToolRaw(
  baseUrl: string,
  group: string,
  tool: string,
  args: Record<string, unknown>,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ToolCallRawOutcome> {
  const fetched = await fetchToolJson(baseUrl, group, tool, args, options);
  if (!fetched.ok) return fetched;
  const rpcError = fetched.json.error;
  if (isRecord(rpcError)) {
    const code = typeof rpcError.code === "number" ? `jsonrpc_${rpcError.code}` : "jsonrpc_error";
    return { ok: false, code, error: str(rpcError.message) ?? "JSON-RPC 错误" };
  }
  const result = fetched.json.result;
  if (!isRecord(result)) {
    return { ok: false, code: "response_invalid", error: "桥响应缺 result" };
  }
  const text = textOfContent(result.content);
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    payload = undefined;
  }
  if (isRecord(payload) && payload.ok === false) {
    return {
      ok: false,
      code: typeof payload.code === "string" ? payload.code : "unknown",
      error: typeof payload.error === "string" ? payload.error : "桥返回失败",
    };
  }
  if (isRecord(payload)) {
    return { ok: true, json: payload };
  }
  if (text.trim() === "") {
    return { ok: false, code: "response_invalid", error: "桥 result.content 无文本负载" };
  }
  return {
    ok: false,
    code: result.isError === true ? "protocol_error" : "response_invalid",
    error: text,
  };
}
