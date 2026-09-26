/**
 * 板对编排桥 MCP 面的**第二个、也是唯一第二个**写封装（v0.9.2 M2 · REQ-v0.9.2-2026-09-25-02）——
 * 与 `requirement.ts`（唯一 create 写点）并列，只暴露「排期写」这一条路径：{@link scheduleFeature}。
 *
 * **为什么开这一个口**：用户已批裁定改述口径 ——「**板不写状态机迁移**（approve / cancel /
 * 主链 `to` 非当前态的 advance 仍零路径）；登记字段 `version` 的**排期写**放开（单一封装文件、
 * 仅 `version` 一字段、装配不携带 stage/approval）」。排期走的是 `a2a_feature_advance` 的
 * 「`to` = 当前态 ∧ 带登记字段」**特例**（v0.9.0 已落地，状态机零改动、orch 零改动），
 * 只把需求的 `version` 归到某版，**不迁移动任何主链状态**。
 *
 * **纪律边界（本文件的存在理由）**：`a2a_feature_advance` 这个工具名在 `src/**` 的命中文件集合
 * **有且仅有本文件**（`test/requirement.test.mjs` + `test/server-write.test.mjs` 以源码扫描钉死）。
 * approve / cancel 两个真·状态机迁移工具名在 `src/**` 仍恒为 0 命中 —— 排期不是迁移，
 * 故只借 advance 的登记字段通道，且**在 TS 类型层封死**：入参类型 {@link ScheduleAdvanceInput}
 * 不接受 `stage` / `approval` 键，`version` 必填 `string`（类型上无法省略；清空排期显式发 `""`）。
 *
 * **不实现端点**：本文件只提供封装骨架（M3 才接线 `POST /features/:id/schedule`）；
 * `to` 由调用方（M3 先 `getFeature` 取当前态）传入，本封装不自取、不猜。
 *
 * 通用 MCP 客户端能力（端点组装 / tools/call 请求体 / 信封解析 / fetch 链路）沿用 `mcp-client.ts`；
 * 组身份是参数、绝不硬编码（同 `requirement.ts`：`null` 身份不可用，空组名在写面边界抛出）。
 */

import * as mcpClient from "./mcp-client.js";
import { callTool, McpConfigError } from "./mcp-client.js";

/** 排期写复用的 MCP 端点缺省基址（与 requirement.ts 同源，8787 = 编排桥 MCP 面）。 */
export const DEFAULT_MCP_BASE_URL = "http://127.0.0.1:8787";

/** 被封装的 advance 工具名（纪律扫描锚：src/** 仅此文件出现该名）。 */
export const FEATURE_ADVANCE_TOOL = "a2a_feature_advance";

/**
 * 排期写入参：**只有 `version` 一个业务字段**，`to` 是「当前态」回填参数（由调用方取来原样传回），
 * `featureId` 定位目标需求。类型层**不含 `stage` / `approval` 键**，`version` 必填 `string`
 * （清空排期 = 显式传 `""`）—— 从签名上杜绝「顺手写 stage/approval」或「省略 version 落空值」。
 */
export interface ScheduleAdvanceInput {
  featureId: string;
  /** 当前态（`to` = 现态 ⇒ advance 走登记字段特例，不迁移状态机）。 */
  to: string;
  /** 目标版本号；空串 = 取消排期（回「未排期」）。必填，类型上无法省略。 */
  version: string;
}

export interface ScheduleFeatureOptions {
  /** **组身份**（= MCP URL 首段 = projectGroup.name）；必填、非空。 */
  group: string;
  /** MCP 端点基址，缺省 {@link DEFAULT_MCP_BASE_URL}。 */
  baseUrl?: string;
  /** fetch 实现（测试注入用）；缺省 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（ms），缺省 10_000。 */
  timeoutMs?: number;
}

/** 排期写成功后的归一结果（`version` 为桥回显的登记字段；老桥缺列则 null）。 */
export interface ScheduleResult {
  ok: true;
  featureId: string;
  state: string | null;
  version: string | null;
}

/** 失败 —— 透传桥错误码（如 `feature_invalid_stage` / `project_not_a_member` / 非法迁移被拒），不吞。 */
export interface ScheduleFailed {
  ok: false;
  code: string;
  error: string;
}

export type ScheduleOutcome = ScheduleResult | ScheduleFailed;

/** 调用方参数不合法（组身份缺失 / featureId 或 to 为空 / version 键缺失）—— 属编程错误，先于网络即抛出。 */
export class FeatureScheduleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeatureScheduleConfigError";
  }
}

// ---------------------------------------------------------------------------
// 纯函数（无 I/O；单测目标）—— advance 排期入参口径与结果归一
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
 * 空组名（null 身份）在写面边界以 {@link FeatureScheduleConfigError} 语义抛出。
 */
export function buildMcpEndpoint(baseUrl: string, group: string): string {
  try {
    return mcpClient.buildMcpEndpoint(baseUrl, group);
  } catch (err) {
    if (err instanceof McpConfigError) throw new FeatureScheduleConfigError(err.message);
    throw err;
  }
}

/**
 * 组装 `a2a_feature_advance` 的排期入参对象 —— 出参键集合**有且仅有** `{featureId, to, version}`：
 * - **绝不携带 `stage` / `approval`**（TS 类型层已封死，装配也不补）；
 * - `to` **恒等**于调用方传入的当前态（不加工、不回落）；
 * - `version` **键始终存在**（清空 = 显式 `""`），缺失即编程错误抛出。
 * 纯函数，供纪律与契约断言。
 */
export function buildScheduleAdvanceArgs(input: ScheduleAdvanceInput): Record<string, unknown> {
  const featureId = input.featureId.trim();
  if (featureId === "") {
    throw new FeatureScheduleConfigError("featureId 不可为空");
  }
  const to = input.to.trim();
  if (to === "") {
    throw new FeatureScheduleConfigError("to（当前态）不可为空：排期写须回填 Feature 当前态");
  }
  if (!input || typeof input !== "object" || !Object.prototype.hasOwnProperty.call(input, "version")) {
    throw new FeatureScheduleConfigError("version 键缺失：排期写必须显式传 version（清空 = 空串）");
  }
  if (typeof input.version !== "string") {
    throw new FeatureScheduleConfigError("version 必须是字符串（清空 = 空串）");
  }
  return { featureId, to, version: input.version };
}

/**
 * 组装 JSON-RPC `tools/call` 请求体（通用实现在 mcp-client.ts，
 * 此处固定为 `a2a_feature_advance` 的写面口径）。
 */
export function buildToolsCallRequest(args: Record<string, unknown>, id = 1): unknown {
  return mcpClient.buildToolsCallRequest(FEATURE_ADVANCE_TOOL, args, id);
}

/**
 * 解析桥的 tools/call 响应并归一为排期结果（纯函数）：通用信封解析在 mcp-client.ts，
 * 此处叠加排期归一（成功负载缺 featureId → `response_invalid`；失败原样透传 code/error）。
 */
export function parseToolCallEnvelope(json: unknown): ScheduleOutcome {
  return normalizeScheduleOutcome(mcpClient.parseToolCallEnvelope(json));
}

function normalizeScheduleOutcome(outcome: mcpClient.ToolCallOutcome): ScheduleOutcome {
  if (!outcome.ok) return { ok: false, code: outcome.code, error: outcome.error };
  const featureId = str(outcome.payload.featureId);
  if (featureId === null) {
    return { ok: false, code: "response_invalid", error: "advance 成功但缺 featureId" };
  }
  return {
    ok: true,
    featureId,
    state: str(outcome.payload.state),
    version: str(outcome.payload.version),
  };
}

// ---------------------------------------------------------------------------
// 网络层
// ---------------------------------------------------------------------------

/**
 * 板侧排期一条需求 = 以组身份调一次 `a2a_feature_advance`（`to` = 当前态 ∧ 仅 `version` 登记字段，
 * 不迁移状态机、不携带 stage/approval）。不抛业务错误：桥返回失败、传输层异常，一律归一为
 * {@link ScheduleFailed}（不吞）。仅当调用方参数违反前置（空组名 / featureId / to / 缺 version 键）
 * 时抛 {@link FeatureScheduleConfigError}。
 */
export async function scheduleFeature(
  input: ScheduleAdvanceInput,
  options: ScheduleFeatureOptions,
): Promise<ScheduleOutcome> {
  try {
    mcpClient.buildMcpEndpoint(options.baseUrl ?? DEFAULT_MCP_BASE_URL, options.group);
  } catch (err) {
    if (err instanceof McpConfigError) throw new FeatureScheduleConfigError(err.message);
    throw err;
  }
  const args = buildScheduleAdvanceArgs(input);
  const outcome = await callTool(
    options.baseUrl ?? DEFAULT_MCP_BASE_URL,
    options.group,
    FEATURE_ADVANCE_TOOL,
    args,
    { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs },
  ).catch((err: unknown) => {
    if (err instanceof McpConfigError) throw new FeatureScheduleConfigError(err.message);
    throw err;
  });
  return normalizeScheduleOutcome(outcome);
}
