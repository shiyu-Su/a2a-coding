/**
 * 板对编排桥 MCP 面的**唯一写封装**（v0.9.0 B9）—— 只暴露 {@link createRequirement}。
 *
 * **为什么只有 create**：板是「人的入口」，需求即 Feature（§2.2-3）。板建一条需求 =
 * 以**组身份**调 `a2a_feature_create`，落初态 `waiting_approval`。板**不写状态机** ——
 * 审批门放行（approve）/ 主链推进（advance）/ 终止（cancel）全归编排 agent，本模块
 * 机制上不提供这些路径（仅 create 一个调用点，`test/requirement.test.mjs` 以源码扫描坐实）。
 *
 * **两种 `waiting_approval` 不再歧义的机制**：板建的需求**显式**传 `stage = 需求分析` +
 * `approval = 未发起`（与既有 12 处调用的唯一行为区别 —— 那些走缺省 `stage = 改造方案` /
 * `approval = 待审批`）。缺省值由桥给出，故「提前批准一个方案未定的需求」在机制上不可能。
 *
 * **选型：自写最小 JSON-RPC over Streamable-HTTP，不引官方 SDK**。理由 —— ① 桥的 MCP 面
 * **无状态**（每请求新建 server/transport、响应无 `Mcp-Session-Id`），官方 SDK 的
 * `StreamableHTTPClientTransport` 会走 `initialize` 握手并期待 session 语义，对本端点是多余；
 * ② 本模块只需一次 `tools/call`，裸 POST + JSON.parse 即足；③ 保持板**零运行时依赖**
 * （见 package.json，当前仅 devDependencies）。
 *
 * **组身份是参数、绝不硬编码**：身份由连接 URL 决定（`/<组名>/mcp`，S1 身份链），
 * 故 {@link CreateRequirementOptions.group} 必填、`null` 身份不可用（空组名直接抛错）。
 * BD11 起该值的**主来源是提需求表单**（用户在前台创建/指定组织），板级配置仅作表单留空时的默认；
 * 无论来自哪，到本模块都必须是**已定且非空**的显式组名 —— 缺失的判定在写面请求期（400），不在这里猜。
 *
 * 网络与解析**分离**：`build*` / `parse*` 为纯函数（不依赖桥在跑即单测）；
 * {@link createRequirement} 负责 fetch + 委派解析。桥返回的业务错误码**结构化透传、不吞**。
 */

/** 桥 MCP 端点缺省基址（8787 = 编排桥 streamable-HTTP 面；只读运维视图另在 3300）。 */
export const DEFAULT_MCP_BASE_URL = "http://127.0.0.1:8787";

/** 板建需求的固定登记口径（见文件头「两种 waiting_approval」）。 */
export const REQUIREMENT_STAGE = "需求分析";
export const REQUIREMENT_APPROVAL = "未发起";

/** 被封装的唯一工具名（源码扫描断言以此为锚）。 */
export const FEATURE_CREATE_TOOL = "a2a_feature_create";

export interface CreateRequirementInput {
  /** Feature 标题（需求的简短摘要）—— 桥侧必填。 */
  title: string;
  /** 版本号（需求登记要带版本，如 `v0.9.0`）—— 由调用方给出。 */
  version: string;
  /** 需求原文（可选）。 */
  requirement?: string;
  /** Feature 级会话上下文（可选，落 features.context_id）。 */
  contextId?: string;
}

export interface CreateRequirementOptions {
  /** **组身份**（= MCP URL 首段 = projectGroup.name）；必填、非空。 */
  group: string;
  /** MCP 端点基址，缺省 {@link DEFAULT_MCP_BASE_URL}。 */
  baseUrl?: string;
  /** fetch 实现（测试注入用）；缺省 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（ms），缺省 10_000。 */
  timeoutMs?: number;
}

/** create 成功后的归一结果（`stage`/`version`/`approval` 为桥 O1 回显；混跑期老桥缺列则 null）。 */
export interface RequirementCreated {
  ok: true;
  featureId: string;
  state: string | null;
  stage: string | null;
  version: string | null;
  approval: string | null;
}

/** 失败 —— 透传桥错误码（如 `feature_invalid_stage` / `project_not_a_member`），不吞。 */
export interface RequirementFailed {
  ok: false;
  code: string;
  error: string;
}

export type CreateRequirementOutcome = RequirementCreated | RequirementFailed;

/** 调用方参数不合法（组身份缺失 / 标题为空）—— 属编程错误，先于网络即抛出。 */
export class RequirementConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementConfigError";
  }
}

// ---------------------------------------------------------------------------
// 纯函数（无 I/O；单测目标）
// ---------------------------------------------------------------------------

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
    throw new RequirementConfigError("组身份（group）缺失：板必须以显式组名连接 MCP，null 身份不可用");
  }
  const base = normalizeMcpBaseUrl(baseUrl);
  return `${base}/${encodeURIComponent(g)}/mcp`;
}

/**
 * 组装 `a2a_feature_create` 的入参对象 —— **始终显式带上** `stage` / `approval` / `version`。
 * 这是「板建的需求停在『需求分析 + 审批门未发起』」的机制落点（纯函数，供断言①）。
 */
export function buildFeatureCreateArgs(input: CreateRequirementInput): Record<string, unknown> {
  const title = input.title.trim();
  if (title === "") {
    throw new RequirementConfigError("需求标题（title）不可为空");
  }
  const args: Record<string, unknown> = {
    title,
    version: input.version,
    stage: REQUIREMENT_STAGE,
    approval: REQUIREMENT_APPROVAL,
  };
  if (input.requirement !== undefined) args.requirement = input.requirement;
  if (input.contextId !== undefined) args.contextId = input.contextId;
  return args;
}

/** 组装 JSON-RPC `tools/call` 请求体。 */
export function buildToolsCallRequest(args: Record<string, unknown>, id = 1): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: FEATURE_CREATE_TOOL, arguments: args },
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
 * 解析桥的 tools/call 响应为归一结果（纯函数，供断言③「结构化透传」）。三层信封：
 * - JSON-RPC 层 `error` → `jsonrpc_<code>`；
 * - `result.content[].text` 内是桥 handler 的 JSON（`{ok:true,...}` / `{ok:false,code,error}`）；
 * - 非 JSON 文本（如 `MCP error -32602: Input validation error`）→ `protocol_error` 承载原文。
 */
export function parseToolCallEnvelope(json: unknown): CreateRequirementOutcome {
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
    const featureId = str(payload.featureId);
    if (featureId === null) {
      return { ok: false, code: "response_invalid", error: "create 成功但缺 featureId" };
    }
    return {
      ok: true,
      featureId,
      state: str(payload.state),
      stage: str(payload.stage),
      version: str(payload.version),
      approval: str(payload.approval),
    };
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

// ---------------------------------------------------------------------------
// 网络层
// ---------------------------------------------------------------------------

/**
 * 板侧建一条需求 = 以组身份调一次 `a2a_feature_create`（显式传 `stage`/`approval`）。
 * 不抛业务错误：桥返回失败、传输层异常，一律归一为 {@link RequirementFailed}（不吞）。
 * 仅当调用方参数违反前置（空组名 / 空标题）时抛 {@link RequirementConfigError}。
 */
export async function createRequirement(
  input: CreateRequirementInput,
  options: CreateRequirementOptions,
): Promise<CreateRequirementOutcome> {
  const url = buildMcpEndpoint(options.baseUrl ?? DEFAULT_MCP_BASE_URL, options.group);
  const body = buildToolsCallRequest(buildFeatureCreateArgs(input));
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
    return parseToolCallEnvelope(JSON.parse(raw) as unknown);
  } catch {
    return { ok: false, code: "response_invalid", error: `桥响应不是合法 JSON：${raw.slice(0, 200)}` };
  }
}
