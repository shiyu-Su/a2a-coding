/**
 * 板对编排桥 MCP 面的**第三个写封装**（v0.9.4 B 档 · BD4 · REQ-2026-09-26-01 §2.2）——
 * 与 `requirement.ts`（建需求）/ `feature-schedule.ts`（排期写）并列，只暴露「组织成员写」这一条路径。
 *
 * **为什么经工具而不是直写配置**：成员的真身在 orch `config.json` 的 `projectGroup` 段，
 * 校验规则的唯一事实源也在 orch（`config.ts#parseProjectGroups`）。板**绝不直写** `orch/config.json`
 * （写了就绕过 dry-run / 备份 / 乐观校验）；唯一通路 = 以组身份调 O1 受控写工具
 * `a2a_config_write_group`。**orch 不可达 ⇒ 结构化报错 + 浮层引导，绝不降级本地直写**
 * （(b) 案收益 = 单一写手，降级一次即归零）。
 *
 * **板消费的恰为五操作的双子集 + 停用释放一条**：增 → `group.member.add`、删 → `group.member.remove`；
 * **停用组织释放成员** → `group.remove`（v0.9.4 增补五 §9.4-①，只由停用 handler 产出，**不经成员表单**）；
 * `group.update` **板不消费**（整组编辑留作后续备用通道，见改造文档 §2.3）。
 * 成员装配函数 {@link buildConfigWriteGroupArgs} 仍把 op 钉在二元闭集上 —— 从签名上无法让**表单路径**去删组。
 * **另两条例外（v0.9.4 增补 §9-a 死锁兜底 / §9.4 停用释放）**：`group.add` 与 `group.remove` 均不经成员表单、
 * 不经 {@link buildConfigWriteGroupArgs} 产出，各由 {@link createGroupWithMembers}（`member.add` 撞
 * `config_write_group_not_found` 时一次性改发）与 {@link releaseOrgGroup}（停用 handler）单独装配。
 *
 * **纪律边界**：`a2a_config_write_group` 工具名在 `src/**` 的命中文件集合**有且仅有本文件**
 * （`test/requirement.test.mjs` 同形扫描钉死）；approve / cancel 仍恒 0 命中（本封装不碰状态机）。
 *
 * 通用 MCP 客户端能力沿用 `mcp-client.ts`；组身份是参数、绝不硬编码（`null` 身份不可用）。
 */

import * as mcpClient from "./mcp-client.js";
import { callTool, McpConfigError } from "./mcp-client.js";
import type { GroupRow } from "./orgs-view.js";

/** 成员写复用的 MCP 端点缺省基址（与另两个写封装同源，8787 = 编排桥 MCP 面）。 */
export const DEFAULT_MCP_BASE_URL = "http://127.0.0.1:8787";

/** 被封装的唯一工具名（源码扫描断言以此为锚）。 */
export const CONFIG_WRITE_GROUP_TOOL = "a2a_config_write_group";

/** 板消费的两个成员操作（= O1 五操作闭集的**双子集**，类型层收窄）。 */
export const MEMBER_OP_ADD = "group.member.add";
export const MEMBER_OP_REMOVE = "group.member.remove";
export type GroupMemberOp = typeof MEMBER_OP_ADD | typeof MEMBER_OP_REMOVE;

/**
 * 死锁兜底唯一改发的建组操作（v0.9.4 §9-a · REQ-2026-09-27-06 增补）：
 * **不经表单、不经 {@link memberActionToOp}**，只在 `group.member.add` 撞上组不存在时由
 * {@link writeGroupMembersWithRetry} 一次性改发（组织在 orch config 的出现 = 第一个成员条目）。
 */
export const GROUP_ADD_OP = "group.add";

/**
 * 停用组织的成员释放操作（v0.9.4 增补五 §9.4-①）：同样**不经成员表单、不经 {@link memberActionToOp}**，
 * 只由 {@link releaseOrgGroup} 装配 —— 语义 = 该组织退出编排、名下项目归还「无归属」。
 */
export const GROUP_REMOVE_OP = "group.remove";

/**
 * O1 提供但**成员表单路径无法产出**的三操作（登记用：纪律断言与 README 口径复述；
 * `group.add` 走 {@link createGroupWithMembers}、`group.remove` 走 {@link releaseOrgGroup} 两条独立装配径）。
 */
export const CONFIG_WRITE_OPS_NOT_CONSUMED_BY_MEMBER_FORM: readonly string[] = [
  GROUP_ADD_OP,
  "group.update",
  GROUP_REMOVE_OP,
];

/** 一次成员写 = 一个 `{machineId, projectId}` 对（表单口径见 `write-guard.parseMemberForm`）。 */
export interface MemberPair {
  machineId: string;
  projectId: string;
}

export interface GroupMemberWriteInput {
  op: GroupMemberOp;
  /** 目标组名（= 板上的组织名；O1 按 config 现有条目精确串匹配）。 */
  groupName: string;
  members: readonly MemberPair[];
}

export interface GroupMemberWriteOptions {
  /** **组身份**（= MCP URL 首段）；必填、非空。O1 是全组面工具，但连接仍需显式身份。 */
  group: string;
  /** MCP 端点基址，缺省 {@link DEFAULT_MCP_BASE_URL}。 */
  baseUrl?: string;
  /** fetch 实现（测试注入用）；缺省 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（ms），缺省 10_000。 */
  timeoutMs?: number;
}

/** 写成功后的归一结果（`backedUpTo` = 本次实际写入前的备份路径，**仅展示、板不解析**）。 */
export interface GroupMemberWriteSuccess {
  ok: true;
  op: string | null;
  groupName: string | null;
  /** false = 操作未产生任何变更（删本不在组内的成员 = 幂等零写入）。 */
  changed: boolean;
  /** 操作后该组声明态成员；桥未回列 ⇒ null（不臆造清单）。 */
  members: MemberPair[] | null;
  backedUpTo: string | null;
}

/** 失败 —— 透传桥错误码（闭集六元 + 传输层码），不吞。 */
export interface GroupMemberWriteFailed {
  ok: false;
  code: string;
  error: string;
}

export type GroupMemberWriteOutcome = GroupMemberWriteSuccess | GroupMemberWriteFailed;

/** 调用方参数不合法（组身份缺失 / op 越界 / 成员对为空）—— 属编程错误，先于网络即抛出。 */
export class GroupAdminConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupAdminConfigError";
  }
}

// ---------------------------------------------------------------------------
// 纯函数（无 I/O；单测目标）
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 归一 MCP 基址（去尾部斜杠）—— 委托 mcp-client.ts。 */
export function normalizeMcpBaseUrl(baseUrl: string): string {
  return mcpClient.normalizeMcpBaseUrl(baseUrl);
}

/**
 * 组装 MCP 端点 URL（`<base>/<组名>/mcp`）—— 委托 mcp-client.ts；
 * 空组名（null 身份）在写面边界以 {@link GroupAdminConfigError} 语义抛出。
 */
export function buildMcpEndpoint(baseUrl: string, group: string): string {
  try {
    return mcpClient.buildMcpEndpoint(baseUrl, group);
  } catch (err) {
    if (err instanceof McpConfigError) throw new GroupAdminConfigError(err.message);
    throw err;
  }
}

/** 表单动作的字面值域（与 `write-guard.MemberWriteAction` 同形，此处不跨模块引类型以免成环）。 */
export type MemberFormAction = "add" | "remove";

/**
 * 表单动作 → O1 op（**恰双子集映射**，唯一事实源）：`add` → `group.member.add`、
 * `remove` → `group.member.remove`。入参域已被 `write-guard.parseMemberForm` 收在二值闭集，
 * 故本函数是**全函数**（无「猜动作」分支）；`group.add` / `group.update` / `group.remove` 无法由本函数产出。
 */
export function memberActionToOp(action: MemberFormAction): GroupMemberOp {
  return action === "add" ? MEMBER_OP_ADD : MEMBER_OP_REMOVE;
}

/**
 * 组名 + 成员对的公共校验（两条装配径共用）：空组名 / 空成员集 / 残缺成员对 = 编程错误抛出，
 * 出参恒为 `{groupName, members}`，成员对逐条 trim（**不发「半截」写**）。
 */
function normalizeGroupNameAndMembers(input: {
  groupName: string;
  members: readonly MemberPair[];
}): { groupName: string; members: MemberPair[] } {
  const groupName = input.groupName.trim();
  if (groupName === "") {
    throw new GroupAdminConfigError("groupName（目标组名）不可为空");
  }
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new GroupAdminConfigError("members 不可为空：成员写必须显式给出 {machineId, projectId}");
  }
  const members: MemberPair[] = [];
  for (const [i, m] of input.members.entries()) {
    const machineId = (m.machineId ?? "").trim();
    const projectId = (m.projectId ?? "").trim();
    if (machineId === "" || projectId === "") {
      throw new GroupAdminConfigError(`members[${i}] 必须是 {machineId, projectId} 非空对`);
    }
    members.push({ machineId, projectId });
  }
  return { groupName, members };
}

/**
 * 组装 `a2a_config_write_group` 的入参对象（纯函数，供契约断言）：
 * - `op` **只能是双子集**（`group.add` / `group.update` / `group.remove` 在装配层就被拒）；
 * - `groupName` 与每个成员对**非空**（空值 = 编程错误，不发「半截」写）；
 * - 出参键集合恒为 `{op, groupName, members}`，不携带任何其它配置段。
 */
export function buildConfigWriteGroupArgs(input: GroupMemberWriteInput): Record<string, unknown> {
  if (input.op !== MEMBER_OP_ADD && input.op !== MEMBER_OP_REMOVE) {
    throw new GroupAdminConfigError(
      `板侧成员写只消费 ${MEMBER_OP_ADD} / ${MEMBER_OP_REMOVE}（收到 ${JSON.stringify(input.op)}）`,
    );
  }
  return { op: input.op, ...normalizeGroupNameAndMembers(input) };
}

/**
 * 组装 JSON-RPC `tools/call` 请求体（通用实现在 mcp-client.ts，
 * 此处固定为 `a2a_config_write_group` 的写面口径）。
 */
export function buildToolsCallRequest(args: Record<string, unknown>, id = 1): unknown {
  return mcpClient.buildToolsCallRequest(CONFIG_WRITE_GROUP_TOOL, args, id);
}

/**
 * 组装 `group.add`（建组带首批成员）的入参（纯函数，仅供死锁兜底一条径）：
 * 键集合与成员写同形 `{op, groupName, members}`，成员对的校验口径与
 * {@link buildConfigWriteGroupArgs} 完全一致（同一 trim / 同一「不发半截写」判据）。
 */
export function buildConfigCreateGroupArgs(input: {
  groupName: string;
  members: readonly MemberPair[];
}): Record<string, unknown> {
  return { op: GROUP_ADD_OP, ...normalizeGroupNameAndMembers(input) };
}

/**
 * 组装 `group.remove`（停用组织时释放整组成员登记）的入参（纯函数，仅供停用一条径）：
 * 键集合恒为 `{op, groupName}` —— **不携带 members**（O1 契约：`group.remove` 不消费成员集），
 * 也不携带任何其它配置段。空组名 = 编程错误抛出（同成员写口径，不发半截写）。
 */
export function buildConfigRemoveGroupArgs(input: { groupName: string }): Record<string, unknown> {
  const groupName = input.groupName.trim();
  if (groupName === "") {
    throw new GroupAdminConfigError("groupName（目标组名）不可为空");
  }
  return { op: GROUP_REMOVE_OP, groupName };
}

/** 桥回列的成员数组 → 归一对数组（非对象项与空对剔除；缺列 ⇒ null，不臆造）。 */
function normalizeMembersPayload(raw: unknown): MemberPair[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MemberPair[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const machineId = str(item.machineId);
    const projectId = str(item.projectId);
    if (machineId === null || projectId === null || machineId === "" || projectId === "") continue;
    out.push({ machineId, projectId });
  }
  return out;
}

/** 桥的 tools/call 响应 → 成员写结果（通用信封解析在 mcp-client.ts，此处叠加载体归一）。 */
export function parseToolCallEnvelope(json: unknown): GroupMemberWriteOutcome {
  return normalizeWriteGroupOutcome(mcpClient.parseToolCallEnvelope(json));
}

export function normalizeWriteGroupOutcome(
  outcome: mcpClient.ToolCallOutcome,
): GroupMemberWriteOutcome {
  if (!outcome.ok) return { ok: false, code: outcome.code, error: outcome.error };
  return {
    ok: true,
    op: str(outcome.payload.op),
    groupName: str(outcome.payload.groupName),
    changed: outcome.payload.changed === true,
    members: normalizeMembersPayload(outcome.payload.members),
    backedUpTo: str(outcome.payload.backedUpTo),
  };
}

// ---------------------------------------------------------------------------
// 错误映射读面（HTTP 状态归板，闭集契约见改造文档 §2.3）
// ---------------------------------------------------------------------------

/** O1 失败码闭集六元 → 板侧 HTTP 状态（唯一映射表；未知码走 {@link MEMBER_WRITE_UNREACHABLE_STATUS}）。 */
export const CONFIG_WRITE_HTTP_STATUS: Readonly<Record<string, number>> = {
  config_write_dry_run_rejected: 422,
  config_write_unknown_machine: 422,
  config_write_group_not_found: 409,
  config_write_duplicate_member: 409,
  config_write_concurrent_modification: 409,
  config_write_io_failed: 500,
};

/** 非闭集码（`transport_error` / `http_*` / `jsonrpc_*` / `response_invalid` / `internal_error` …）⇒ 桥不可达档。 */
export const MEMBER_WRITE_UNREACHABLE_STATUS = 502;

/** `config_write_group_not_found` 的保守文案（不转译桥原文，避免把内部路径泄漏到浮层）。 */
export const GROUP_NOT_FOUND_CODE = "config_write_group_not_found";
export const GROUP_NOT_FOUND_DISPLAY = "目标组不存在（或已被移除）：请在板上先建组织，或核对组织名后重试。";

/** 桥不可达档的引导（B 档硬口径：**绝不降级本地直写** orch 配置）。 */
export const BRIDGE_UNREACHABLE_GUIDANCE =
  "⇒ 编排桥（MCP 面）不可达：成员写的唯一通路是受控写工具，板**不会降级去本地直写 orch/config.json**。" +
  "请确认桥进程在跑（8787）后重试；确需立即改组配置，只能由人手工编辑并重启桥。";

/** `config_write_concurrent_modification`（板允许**单次**自动重读重试，见 {@link writeGroupMembersOnce} 下方说明）。 */
export const CONCURRENT_MODIFICATION_CODE = "config_write_concurrent_modification";

// ---------------------------------------------------------------------------
// 末位成员拒写（v0.9.4 增补二 · REQ-2026-09-27-07 ①）
// ---------------------------------------------------------------------------

/**
 * 末位成员 remove 的业务拒绝码（板侧码，**不出网**）：桥侧不变量「组成员非空」由板在写前拦截，
 * 不再让用户撞 `config_write_dry_run_rejected` 的桥原文。
 */
export const LAST_MEMBER_REMOVE_CODE = "board_last_member_remove";

/** 末位成员 remove 的业务化展示文案（浮层唯一口径；桥原文只进日志，绝不进浮层）。 */
export const LAST_MEMBER_REMOVE_DISPLAY = "组织内仅剩一项目时，无法删除项目，请选择停用组织";

/** 成员对相等（trim 后逐字相等；与出网前的成员对归一口径一致）。 */
export function isSameMemberPair(a: MemberPair, b: MemberPair): boolean {
  return a.machineId.trim() === b.machineId.trim() && a.projectId.trim() === b.projectId.trim();
}

/**
 * 「remove 是否撞末位成员」纯判据（写前闸，事实源 = 3300 `GET /api/groups` 的该组声明面投影）：
 * - 声明面**持有该组** 且 `memberCount ≤ 1` ⇒ 删的就是末位（或唯一）成员 → `true`；
 *   （声明面持组却零成员 = orch 不变量下的坏态，同样拒，与桥行为一致）
 * - 声明面**无该组** ⇒ `false`（删不在组内的成员 = 幂等零写入，照旧出网交 O1 判，
 *   **不得**翻译成「末位不可删」）；
 * - 非 remove 动作 ⇒ `false`（增员不经本闸）。
 */
export function removesLastGroupMember(input: {
  action: MemberFormAction;
  groupName: string;
  member: MemberPair;
  groups: readonly GroupRow[];
}): boolean {
  if (input.action !== "remove") return false;
  const row = input.groups.find((g) => g.name === input.groupName);
  if (row === undefined) return false;
  if (row.memberCount > 1) return false;
  return row.members.length === 0 || row.members.some((m) => isSameMemberPair(m, input.member));
}

// ---------------------------------------------------------------------------
// 加成员撞「组间成员互斥」的业务化文案（v0.9.4 增补五 §9.4-③）
// ---------------------------------------------------------------------------

/** O1 的重复成员失败码（同组重复添加与跨组互斥共用一码，板侧按声明面投影分流文案）。 */
export const DUPLICATE_MEMBER_CODE = "config_write_duplicate_member";

/** 板侧业务码：项目已属其它组织 ⇒ 引导「先移除 / 先停用」，**不透传桥原文**。 */
export const MEMBER_GROUP_CONFLICT_CODE = "board_member_group_conflict";

/** 声明面查不到所属组织（3300 不可达 / 组数据缺位）时的通用引导（不猜组织名）。 */
export const MEMBER_GROUP_CONFLICT_GENERIC =
  "该项目已在某个组织的成员登记中（组间成员互斥）：请先到所属组织的管理页移除成员，或停用该组织（停用会释放其成员）。";

/** 组织空间管理页的板内路径（业务文案里的落点）。 */
export function orgManageHref(org: string): string {
  return `/org/${encodeURIComponent(org)}/manage`;
}

/**
 * 「项目当前所属组织」的声明面查法（纯函数，事实源 = 3300 `GET /api/groups` 投影）：
 * 先按**成员对精确相等**匹配（O1 的查重键 = `{machineId, projectId}` 对），命中即该组；
 * 未命中再按 `projectId` 匹配（同项目换了 machineId 登记时仍能把「在哪一组」讲清）；
 * 两组都查不到 ⇒ `null`（**不臆造**组织名，调用方退化为通用文案）。
 */
export function ownerOrgOfProject(groups: readonly GroupRow[], member: MemberPair): string | null {
  const pairHit = groups.find((g) =>
    g.members.some((m) => isSameMemberPair(m, member)),
  );
  if (pairHit !== undefined) return pairHit.name;
  const projectHit = groups.find((g) =>
    g.members.some((m) => m.projectId.trim() === member.projectId.trim()),
  );
  return projectHit !== undefined ? projectHit.name : null;
}

export interface MemberConflictDisplay {
  code: string;
  error: string;
  /** 指向所属组织管理页的链接；查不到组织 ⇒ `null`（只给文案，不给假链接）。 */
  link: { href: string; label: string } | null;
}

/** 组间互斥的浮层呈现（纯函数）：文案点名所属组织 + 该组织管理页链接。 */
export function describeMemberGroupConflict(input: {
  member: MemberPair;
  groups: readonly GroupRow[];
}): MemberConflictDisplay {
  const owner = ownerOrgOfProject(input.groups, input.member);
  if (owner === null) {
    return { code: MEMBER_GROUP_CONFLICT_CODE, error: MEMBER_GROUP_CONFLICT_GENERIC, link: null };
  }
  return {
    code: MEMBER_GROUP_CONFLICT_CODE,
    error:
      `该项目当前属于组织 ${owner}，请先到 ${owner} 的管理页移除成员，` +
      `或先停用 ${owner}（停用会释放其成员）。`,
    link: { href: orgManageHref(owner), label: `打开 ${owner} 管理页` },
  };
}

/**
 * 失败码 → 浮层可呈现的 `{status, code, error}`（纯函数）：
 * - 闭集六元按表给状态；`group_not_found` 走保守文案（丢弃桥原文）；
 * - 其余（含传输层 / JSON-RPC / 坏信封）一律 502 档 + 不可达引导。
 */
export function describeMemberWriteFailure(
  code: string,
  error: string,
): { status: number; code: string; error: string } {
  const mapped = CONFIG_WRITE_HTTP_STATUS[code];
  if (mapped !== undefined) {
    return {
      status: mapped,
      code,
      error: code === GROUP_NOT_FOUND_CODE ? GROUP_NOT_FOUND_DISPLAY : error,
    };
  }
  return {
    status: MEMBER_WRITE_UNREACHABLE_STATUS,
    code,
    error: `${error} ${BRIDGE_UNREACHABLE_GUIDANCE}`,
  };
}

// ---------------------------------------------------------------------------
// G11 驻留尾巴（板只能引导，不代重启 Launcher）
// ---------------------------------------------------------------------------

/**
 * 加成员成功后的**驻留引导**：`projectGroup` 成员条目写完即热生效（桥 per-call 现读），
 * 但目标机上「尚未登记的 project」仍须**人工重启 Launcher** 才会被拉起 —— 板不重启 machine 侧进程。
 */
export const MEMBER_ADD_RESIDENCY_NOTE =
  "成员条目已写入桥配置并热生效（无需重启桥）；但若该 project 尚未在目标机上登记，" +
  "仍需人工重启该机 Launcher 才会被拉起（板不代重启 machine 侧进程）。";

// ---------------------------------------------------------------------------
// 网络层
// ---------------------------------------------------------------------------

/**
 * 板侧写一次配置 = 以组身份调一次 `a2a_config_write_group`（入参已由装配层钉死闭集）。
 * 不抛业务错误：桥返回失败、传输层异常，一律归一为 {@link GroupMemberWriteFailed}（不吞）；
 * 仅当调用方参数违反前置（空组身份 / op 越界 / 空成员对）时抛 {@link GroupAdminConfigError}。
 */
async function callWriteGroupTool(
  args: Record<string, unknown>,
  options: GroupMemberWriteOptions,
): Promise<GroupMemberWriteOutcome> {
  try {
    mcpClient.buildMcpEndpoint(options.baseUrl ?? DEFAULT_MCP_BASE_URL, options.group);
  } catch (err) {
    if (err instanceof McpConfigError) throw new GroupAdminConfigError(err.message);
    throw err;
  }
  const outcome = await callTool(
    options.baseUrl ?? DEFAULT_MCP_BASE_URL,
    options.group,
    CONFIG_WRITE_GROUP_TOOL,
    args,
    { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs },
  ).catch((err: unknown) => {
    if (err instanceof McpConfigError) throw new GroupAdminConfigError(err.message);
    throw err;
  });
  return normalizeWriteGroupOutcome(outcome);
}

/**
 * 板侧写一次成员 = 以组身份调一次 `a2a_config_write_group`（op ∈ {member.add, member.remove}）。
 * 语义与错误处置见 {@link callWriteGroupTool}。
 */
export async function writeGroupMembers(
  input: GroupMemberWriteInput,
  options: GroupMemberWriteOptions,
): Promise<GroupMemberWriteOutcome> {
  return callWriteGroupTool(buildConfigWriteGroupArgs(input), options);
}

/**
 * **死锁兜底**（v0.9.4 §9-a）：以 `group.add` 建组并带上首批成员 —— 解「新组织的第一个成员
 * 永远加不进」（组不存在 ⇒ `member.add` 恒被 O1 拒）。仅此一条径使用；用户提交的仍是同一个
 * 成员条目，O1 契约零改动。
 */
export async function createGroupWithMembers(
  input: { groupName: string; members: readonly MemberPair[] },
  options: GroupMemberWriteOptions,
): Promise<GroupMemberWriteOutcome> {
  return callWriteGroupTool(buildConfigCreateGroupArgs(input), options);
}

/**
 * **停用即释放成员**（v0.9.4 增补五 §9.4-①）：以 `group.remove` 摘除该组织在 orch `projectGroup` 的**整组段**
 * （语义 = 组织退出编排、项目归还「无归属」，可被其它组织接管）。
 * **幂等放行** = O1 回 `config_write_group_not_found`（板台账新建、从未挂成员的组织本无组段）⇒ 归一为
 * `ok:true / changed:false` 的成功（**不留半态**：其余失败码原样上报，由停用 handler 判「停用整体失败」）。
 */
export async function releaseOrgGroup(
  input: { groupName: string },
  options: GroupMemberWriteOptions,
): Promise<GroupMemberWriteOutcome> {
  const args = buildConfigRemoveGroupArgs(input);
  const outcome = await callWriteGroupTool(args, options);
  if (!outcome.ok && outcome.code === GROUP_NOT_FOUND_CODE) {
    return {
      ok: true,
      op: GROUP_REMOVE_OP,
      groupName: String(args.groupName),
      changed: false,
      members: null,
      backedUpTo: null,
    };
  }
  return outcome;
}

/** {@link writeGroupMembersWithRetry} 的出口：`retriedOnce` = 是否消费了那唯一一次重试。 */
export interface MemberWriteAttempt {
  outcome: GroupMemberWriteOutcome;
  retriedOnce: boolean;
  /** true = 成员写撞上组不存在后改发 `group.add` 建组带首成员**成功**（兜底只此一次）。 */
  groupCreatedOnce: boolean;
}

/**
 * 带**单次自动重读重试**与**组不存在兜底建组**的成员写（改造文档 §2.2 + §9-a 口径）：
 * - 仅 `config_write_concurrent_modification`（config 在处理途中被外部改动）触发重投，
 *   **至多一次**，其余失败码一律原样上报；
 * - 「重取成员清单」由 O1 的 RMW 承载：受控写每次调用**现读 config**（不依赖任何缓存），
 *   故重投 = 在最新成员清单上重放同一操作；板侧**不缓存成员清单**（零新增存储），
 *   也不得为「凑一次成功」改写用户的操作意图（重试仍是同一 op / 同一成员对）；
 * - `group.member.add` 撞 `config_write_group_not_found` ⇒ 改发一次 `group.add`（建组带该成员）；
 *   **只对 add 兜底一次**（删一个不存在组里的成员 = 幂等零写入，不得翻译成建组）。
 */
export async function writeGroupMembersWithRetry(
  input: GroupMemberWriteInput,
  options: GroupMemberWriteOptions,
): Promise<MemberWriteAttempt> {
  const first = await writeGroupMembers(input, options);
  if (!first.ok && first.code === CONCURRENT_MODIFICATION_CODE) {
    const second = await writeGroupMembers(input, options);
    return { outcome: second, retriedOnce: true, groupCreatedOnce: false };
  }
  if (!first.ok && first.code === GROUP_NOT_FOUND_CODE && input.op === MEMBER_OP_ADD) {
    const created = await createGroupWithMembers(
      { groupName: input.groupName, members: input.members },
      options,
    );
    return { outcome: created, retriedOnce: false, groupCreatedOnce: created.ok };
  }
  return { outcome: first, retriedOnce: false, groupCreatedOnce: false };
}
