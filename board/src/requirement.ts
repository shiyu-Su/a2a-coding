/**
 * 板对编排桥 MCP 面的**建需求写封装**（v0.9.0 B9）—— 只暴露 {@link createRequirement}。
 *
 * **为什么只有 create**：板是「人的入口」，需求即 Feature（§2.2-3）。板建一条需求 =
 * 以**组身份**调 `a2a_feature_create`，落初态 `waiting_approval`。板**不写状态机迁移** ——
 * 审批门放行（approve）/ 终止（cancel）/ 主链推进（advance 到非当前态）全归编排 agent，本模块
 * 机制上不提供这些路径。唯一放开的登记字段写（`version` 排期写，经 advance「`to` = 当前态」特例）
 * 在**并列的第二个 MCP 写封装** `feature-schedule.ts`，不在本文件（`test/requirement.test.mjs`
 * 以源码扫描坐实：create 命中集 == {requirement.ts}、approve/cancel 零命中、advance 命中集 == {feature-schedule.ts}）。
 *
 * **初值由桥硬编码（v0.10.5 create 契约重构）**：`a2a_feature_create` **不再收** `stage` /
 * `approval` 两枚入参 —— 桥在入口固定写入 `stage = 需求分析` + `approval = 未发起`。板因此
 * **不发这两键**：板侧一旦再传，就成了桥之外的第二处初值执法点（两处可不一致）；不发 ⇒
 * 「提前批准一个方案未定的需求」在机制上不可能（旧形态「板显式传两值」由本契约取代）。
 *
 * **N5 起分层**：通用 MCP 客户端能力（端点组装 / tools/call 请求体 / 信封解析 / 一次
 * 调用的 fetch 链路）在 `mcp-client.ts`；本文件只保留 `a2a_feature_create` 的**入参口径**
 * 与**结果归一**（`RequirementCreated` 的 featureId/stage/... 抽取），同名导出为委托
 * 薄包装以保持既有 import 面与返回契约（`a2a_feature_create` 字面量仍收敛于本文件 =
 * 纪律扫描锚点）。
 *
 * **组身份是参数、绝不硬编码**：身份由连接 URL 决定（`/<组名>/mcp`，S1 身份链），
 * 故 {@link CreateRequirementOptions.group} 必填、`null` 身份不可用（空组名直接抛错）。
 * BD11 起该值的**主来源是提需求表单**（用户在前台创建/指定组织），板级配置仅作表单留空时的默认；
 * 无论来自哪，到本模块都必须是**已定且非空**的显式组名 —— 缺失的判定在写面请求期（400），不在这里猜。
 */

import * as mcpClient from "./mcp-client.js";
import { callTool, McpConfigError } from "./mcp-client.js";
import { parseVersion } from "./version-order.js";

/** 桥 MCP 端点缺省基址（8787 = 编排桥 streamable-HTTP 面；只读运维视图另在 3300）。 */
export const DEFAULT_MCP_BASE_URL = "http://127.0.0.1:8787";

/** 被封装的唯一工具名（源码扫描断言以此为锚）。 */
export const FEATURE_CREATE_TOOL = "a2a_feature_create";

export interface CreateRequirementInput {
  /** Feature 标题（需求的简短摘要）—— 桥侧必填。 */
  title: string;
  /**
   * 版本号（如 `v0.9.0`）—— 由调用方给出；v0.9.2 M6 起可留空（= 未排期），本封装发送前 `trim()`。
   * **v0.9.4 N4 起**：非空值必须命中 `x.y.z`（可带 `v` 前缀），否则先于网络抛
   * {@link RequirementConfigError}（空串放行 = 未排期）。
   */
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
// 纯函数（无 I/O；单测目标）—— create 专属入参口径与结果归一
// 通用客户端能力在 mcp-client.ts（端点组装 / tools/call 请求体 / 信封解析 / callTool）；
// 本文件的同名导出是 create 口径薄包装（工具名固定、返回归一为 create 结果），
// 保持既有 import 面与返回契约不变。
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** 归一 MCP 基址（去尾部斜杠）—— 委托 mcp-client.ts。 */
export function normalizeMcpBaseUrl(baseUrl: string): string {
  return mcpClient.normalizeMcpBaseUrl(baseUrl);
}

/**
 * 组装 MCP 端点 URL（`<base>/<组名>/mcp`）—— 委托 mcp-client.ts；
 * 空组名（null 身份）在写面边界仍以 RequirementConfigError 语义抛出（同 name、同消息）。
 */
export function buildMcpEndpoint(baseUrl: string, group: string): string {
  try {
    return mcpClient.buildMcpEndpoint(baseUrl, group);
  } catch (err) {
    if (err instanceof McpConfigError) throw new RequirementConfigError(err.message);
    throw err;
  }
}

/**
 * 组装 `a2a_feature_create` 的入参对象 —— **只带** `title` / `version`（外加可选 `requirement` /
 * `contextId`）。`stage` / `approval` **不出板**（初值由桥硬编码，见文件头；纯函数，供断言①的负钉）。
 *
 * **semver 收口（v0.9.4 N4 / 改造文档 §2.5）**：`version` 发送前 `trim()`；**空串 = 未排期 ⇒ 放行**
 * （M6 合法路径），非空则必须命中 `version-order.parseVersion` 的 `x.y.z`（可带 `v` 前缀）——
 * 复用现成 `parseVersion`，**零新增第二枚 regex**；不合法先于网络抛 {@link RequirementConfigError}。
 * `normalizeVersion` 不加校验（读面 / 排序 / docs-move 共用的 trim-only 归一入口，加校验会伤存量脏值读面）
 * ⇒ 存量脏值只拦新写、读面保留。
 */
export function buildFeatureCreateArgs(input: CreateRequirementInput): Record<string, unknown> {
  const title = input.title.trim();
  if (title === "") {
    throw new RequirementConfigError("需求标题（title）不可为空");
  }
  // M6 起 version 可留空（未排期）；发送前 trim —— orch 无 trim，空白串会「自成一列」。
  const version = input.version.trim();
  if (version !== "" && parseVersion(version) === null) {
    throw new RequirementConfigError(
      `版本号 ${version} 不是 x.y.z 形式（可带 v 前缀）⇒ 拒绝建需求：` +
        "留空 = 未排期（合法）；非空必须 x.y.z（读面存量脏值保留，只拦新写）",
    );
  }
  const args: Record<string, unknown> = {
    title,
    version,
  };
  if (input.requirement !== undefined) args.requirement = input.requirement;
  if (input.contextId !== undefined) args.contextId = input.contextId;
  return args;
}

/**
 * 组装 JSON-RPC `tools/call` 请求体（通用实现在 mcp-client.ts，
 * 此处固定为 `a2a_feature_create` 的写面口径，签名与既有调用/断言一致）。
 */
export function buildToolsCallRequest(args: Record<string, unknown>, id = 1): unknown {
  return mcpClient.buildToolsCallRequest(FEATURE_CREATE_TOOL, args, id);
}

/**
 * 解析桥的 tools/call 响应并归一为 create 结果（纯函数，供断言③「结构化透传」）：
 * 通用信封解析在 mcp-client.ts，此处叠加 create 归一（成功负载缺 featureId →
 * `response_invalid`；失败原样透传 code/error）。
 */
export function parseToolCallEnvelope(json: unknown): CreateRequirementOutcome {
  return normalizeCreateOutcome(mcpClient.parseToolCallEnvelope(json));
}

function normalizeCreateOutcome(outcome: mcpClient.ToolCallOutcome): CreateRequirementOutcome {
  if (!outcome.ok) return { ok: false, code: outcome.code, error: outcome.error };
  const featureId = str(outcome.payload.featureId);
  if (featureId === null) {
    return { ok: false, code: "response_invalid", error: "create 成功但缺 featureId" };
  }
  return {
    ok: true,
    featureId,
    state: str(outcome.payload.state),
    stage: str(outcome.payload.stage),
    version: str(outcome.payload.version),
    approval: str(outcome.payload.approval),
  };
}

// ---------------------------------------------------------------------------
// 网络层
// ---------------------------------------------------------------------------

/**
 * 板侧建一条需求 = 以组身份调一次 `a2a_feature_create`（**不传** `stage` / `approval` —— 初值由桥硬编码）。
 * 不抛业务错误：桥返回失败、传输层异常，一律归一为 {@link RequirementFailed}（不吞）。
 * 仅当调用方参数违反前置（空组名 / 空标题）时抛 {@link RequirementConfigError}。
 */
export async function createRequirement(
  input: CreateRequirementInput,
  options: CreateRequirementOptions,
): Promise<CreateRequirementOutcome> {
  // 前置校验顺序与重构前一致：先组身份（端点组装）、后标题（入参组装），均先于网络。
  try {
    mcpClient.buildMcpEndpoint(options.baseUrl ?? DEFAULT_MCP_BASE_URL, options.group);
  } catch (err) {
    if (err instanceof McpConfigError) throw new RequirementConfigError(err.message);
    throw err;
  }
  const args = buildFeatureCreateArgs(input);
  const outcome = await callTool(
    options.baseUrl ?? DEFAULT_MCP_BASE_URL,
    options.group,
    FEATURE_CREATE_TOOL,
    args,
    { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs },
  ).catch((err: unknown) => {
    if (err instanceof McpConfigError) throw new RequirementConfigError(err.message);
    throw err;
  });
  return normalizeCreateOutcome(outcome);
}
