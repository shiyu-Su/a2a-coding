/**
 * 板 → 引擎**阶段面两写工具**的转发封装（v0.11.0 R1 · B2）—— 与 `requirement.ts` /
 * `feature-schedule.ts` / `group-admin.ts` 同族纪律：**每个引擎写工具名在 `src/**` 的命中文件集合
 * 有且仅有本文件**（两枚同名工具在此单点装配）。
 *
 * **板只转发、不写状态机**（改造文档 §2.5 / 确认单边界 2）：`stage_round_open`（开一轮，幂等由
 * 引擎侧 partial 唯一索引保证，重复调用 ⇒ 返回既有轮）与 `doc_objection`（记段落异议，
 * **不自动开轮**）两口的判据（成员集校验 / 闭集 stage / 幂等键）全部归引擎；板**不判闸、
 * 不重演收口 / 完成度判据、不做本地兜底写**。`gate1_confirm`（门① 确认，v0.11.0 B1）经用户裁定 U3 +
 * 宿主裁决 A9 **获准由板转发**：同样只转发、不自判闸、不重算 docHash（校验归引擎 N6/N7）。
 *
 * 出网通道 = MCP `tools/call`（`mcp-client.ts` 统一链路，组身份 = 需求 `ownerGroup`，
 * 基址 = 板写面 `mcpBaseUrl` 缺省 8787）。引擎错误码经 {@link callTool} 结构化透传，不吞不改写。
 *
 * 工具名锚点：引擎 MCP 面工具一律 `a2a_` 前缀（`register-tools.ts` 既有族），本卡按改造文档
 * §2.5 写口名 `stage_round_open` / `doc_objection` / `gate1_confirm` 冠此前缀；若 N9 注册名不同，**只改本文件三枚常量**。
 */

import { callTool, type ToolCallOutcome } from "./mcp-client.js";

/** 开轮工具名（纪律锚：src/** 仅此文件出现）。 */
export const STAGE_ROUND_OPEN_TOOL = "a2a_stage_round_open";

/** 段落异议工具名（纪律锚：src/** 仅此文件出现）。 */
export const DOC_OBJECTION_TOOL = "a2a_doc_objection";

/** 门① 确认工具名（纪律锚：src/** 仅此文件出现；与引擎注册名逐字一致，若 N9 不同只改本常量）。 */
export const GATE1_CONFIRM_TOOL = "a2a_gate1_confirm";

export interface StageRoundOpenInput {
  featureId: string;
  /** 闭集原值（引擎权威，板不校验值域、不猜阶段）；必填非空。 */
  stage: string;
  /** 可选：本轮来源（确认文档路径等，口径归引擎）。 */
  sources?: readonly string[];
  /** 可选：定向重评的 project 子集；缺省 = 引擎按本组全员物化（不预筛）。 */
  targetProjects?: readonly string[];
  /** 可选：口径修订标识（basisRev 哈希输入之一；留空引擎记字面 `-`）。 */
  basisRevInput?: string | null;
}

export interface DocObjectionInput {
  featureId: string;
  docVersion: string;
  sectionId: string;
  objectionText: string;
  /** 可选：异议对象类型（值域归引擎）。 */
  targetType?: string | null;
  /** 可选：定向重评 project 清单。 */
  projectIds?: readonly string[];
}

export interface Gate1ConfirmInput {
  featureId: string;
  /** 本轮 synthesis 的文档版本（原样透传，板不重算）。 */
  docVersion: string;
  /** 本轮 synthesis 的文档哈希（原样透传，板不重算、不自判闸）。 */
  docHash: string;
  /** 本轮轮次（v0.11.0 B1 全链透传：引擎 `gate1_confirm` 必填正整数 `round`）。 */
  round: number;
  /** 本次确认顺带排期；缺省 / 空白 ⇒ 不带该键（引擎保持只确认、不推进）。 */
  version?: string | null;
}

export interface StageRoundWriteOptions {
  /** **组身份**（= 需求 ownerGroup）；必填、非空（空身份在 mcp-client 边界抛错）。 */
  group: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 开轮成功归一（camelCase 单形、逐键容错；`created` 行只透传不解读）。 */
export interface StageRoundOpenSuccess {
  ok: true;
  featureId: string | null;
  stage: string | null;
  round: number | null;
  basisRev: string | null;
  created: { projectId: string | null; taskId: string | null }[];
  /** 引擎幂等回执：`true` ⇒ 同 `basisRev` 命中既有轮、未新开（0cb2d1db 缺陷二，板须可见提示、不得静默）。 */
  replayed: boolean;
}

/** 异议成功归一：`staleRevPending` 三态（缺键 ⇒ null，板不替引擎猜）。 */
export interface DocObjectionSuccess {
  ok: true;
  staleRevPending: boolean | null;
}

/** 门① 确认成功归一：透传引擎回执（`confirmed` 三态，缺键 ⇒ null，板不替引擎猜）。 */
export interface Gate1ConfirmSuccess {
  ok: true;
  confirmed: boolean | null;
}

export interface StageWriteFailure {
  ok: false;
  /** 引擎错误码（`transport_error` / `http_*` / 引擎业务码），结构化透传。 */
  code: string;
  error: string;
}

export type StageRoundOpenOutcome = StageRoundOpenSuccess | StageWriteFailure;
export type DocObjectionOutcome = DocObjectionSuccess | StageWriteFailure;
export type Gate1ConfirmOutcome = Gate1ConfirmSuccess | StageWriteFailure;

export interface StageRoundWriteClient {
  openStageRound(input: StageRoundOpenInput, options: StageRoundWriteOptions): Promise<StageRoundOpenOutcome>;
  recordDocObjection(input: DocObjectionInput, options: StageRoundWriteOptions): Promise<DocObjectionOutcome>;
  openGate1Confirm(input: Gate1ConfirmInput, options: StageRoundWriteOptions): Promise<Gate1ConfirmOutcome>;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function triBool(v: unknown): boolean | null {
  return v === true ? true : v === false ? false : null;
}

/** `created[]` 逐行容错展开（非数组 ⇒ 空清单；行内缺键 ⇒ null，不臆造）。 */
function createdRows(v: unknown): { projectId: string | null; taskId: string | null }[] {
  if (!Array.isArray(v)) return [];
  return v.map((row) => {
    const rec = typeof row === "object" && row !== null && !Array.isArray(row) ? (row as Record<string, unknown>) : {};
    return { projectId: str(rec.projectId), taskId: str(rec.taskId) };
  });
}

/** 可选字符串键：`null` / `undefined` / trim 后空 ⇒ 不出键（引擎侧「未给」与「给空」不同义）。 */
function optStr(value: string | null | undefined): string | undefined {
  const v = value === null || value === undefined ? "" : value.trim();
  return v === "" ? undefined : v;
}

/** 可选字符串数组键：逐项 trim 去空；`null` / 空清单 ⇒ 不出键。 */
function optList(value: readonly string[] | null | undefined): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  const items = value.map((x) => x.trim()).filter((x) => x !== "");
  return items.length === 0 ? undefined : items;
}

/** 开轮载荷装配（纯函数，供契约断言）：必填三键恒在、可选键「未给即不出键」。 */
export function buildStageRoundOpenArgs(input: StageRoundOpenInput): Record<string, unknown> {
  const args: Record<string, unknown> = {
    featureId: input.featureId.trim(),
    stage: input.stage.trim(),
  };
  const sources = optList(input.sources);
  if (sources !== undefined) args.sources = sources;
  const targets = optList(input.targetProjects);
  if (targets !== undefined) args.targetProjects = targets;
  const basis = optStr(input.basisRevInput);
  if (basis !== undefined) args.basisRevInput = basis;
  return args;
}

/** 异议载荷装配（纯函数）：必填四键恒在、可选键同上。 */
export function buildDocObjectionArgs(input: DocObjectionInput): Record<string, unknown> {
  const args: Record<string, unknown> = {
    featureId: input.featureId.trim(),
    docVersion: input.docVersion.trim(),
    sectionId: input.sectionId.trim(),
    objectionText: input.objectionText.trim(),
  };
  const targetType = optStr(input.targetType);
  if (targetType !== undefined) args.targetType = targetType;
  const projectIds = optList(input.projectIds);
  if (projectIds !== undefined) args.projectIds = projectIds;
  return args;
}

/** 门① 确认载荷装配（纯函数，供契约断言）：必填四键恒在，`docVersion`/`docHash` 原样透传不重算，`round` 数值直传。 */
export function buildGate1ConfirmArgs(input: Gate1ConfirmInput): Record<string, unknown> {
  const args: Record<string, unknown> = {
    featureId: input.featureId.trim(),
    docVersion: input.docVersion.trim(),
    docHash: input.docHash.trim(),
    round: input.round,
  };
  const version = optStr(input.version);
  if (version !== undefined) args.version = version;
  return args;
}

function failure(outcome: ToolCallOutcome): StageWriteFailure {
  return outcome.ok === false
    ? { ok: false, code: outcome.code, error: outcome.error }
    : { ok: false, code: "response_invalid", error: "不该走到失败归一的成功档" };
}

function normalizeOpen(outcome: ToolCallOutcome): StageRoundOpenOutcome {
  if (!outcome.ok) return failure(outcome);
  const raw = outcome.payload;
  return {
    ok: true,
    featureId: str(raw.featureId),
    stage: str(raw.stage),
    round: num(raw.round),
    basisRev: str(raw.basisRev),
    created: createdRows(raw.created),
    replayed: Boolean(raw.replayed),
  };
}

function normalizeObjection(outcome: ToolCallOutcome): DocObjectionOutcome {
  if (!outcome.ok) return failure(outcome);
  return { ok: true, staleRevPending: triBool(outcome.payload.staleRevPending) };
}

function normalizeConfirm(outcome: ToolCallOutcome): Gate1ConfirmOutcome {
  if (!outcome.ok) return failure(outcome);
  return { ok: true, confirmed: triBool(outcome.payload.confirmed) };
}

/**
 * 建引擎阶段面写客户端。每次调用 = 一次 `tools/call`（无重试、无本地兜底）；
 * 业务失败与传输异常一律归一为 {@link StageWriteFailure}（不吞），仅空组身份在 mcp-client
 * 边界抛 {@link import("./mcp-client.js").McpConfigError}（handler 侧以 503 收口，不回落板级默认组）。
 */
export function createStageRoundWriteClient(
  clientOptions: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): StageRoundWriteClient {
  return {
    openStageRound(input, options) {
      return callTool(
        options.baseUrl ?? clientOptions.baseUrl ?? "http://127.0.0.1:8787",
        options.group,
        STAGE_ROUND_OPEN_TOOL,
        buildStageRoundOpenArgs(input),
        { fetchImpl: options.fetchImpl ?? clientOptions.fetchImpl, timeoutMs: options.timeoutMs ?? clientOptions.timeoutMs },
      ).then(normalizeOpen);
    },
    recordDocObjection(input, options) {
      return callTool(
        options.baseUrl ?? clientOptions.baseUrl ?? "http://127.0.0.1:8787",
        options.group,
        DOC_OBJECTION_TOOL,
        buildDocObjectionArgs(input),
        { fetchImpl: options.fetchImpl ?? clientOptions.fetchImpl, timeoutMs: options.timeoutMs ?? clientOptions.timeoutMs },
      ).then(normalizeObjection);
    },
    openGate1Confirm(input, options) {
      return callTool(
        options.baseUrl ?? clientOptions.baseUrl ?? "http://127.0.0.1:8787",
        options.group,
        GATE1_CONFIRM_TOOL,
        buildGate1ConfirmArgs(input),
        { fetchImpl: options.fetchImpl ?? clientOptions.fetchImpl, timeoutMs: options.timeoutMs ?? clientOptions.timeoutMs },
      ).then(normalizeConfirm);
    },
  };
}
