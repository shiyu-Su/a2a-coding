/**
 * `agentConfig.roles`（职责位 → 旋钮映射）的**形状常量 + risk rank 单一常量 + fail-closed
 * 校验器**（v0.10.2 · M-4 · 改造文档 §2.3 F-C2）。
 *
 * 分工（三面一个读点，口径不分叉）：
 * - `task-types.ts` —— 角色名的**取值闭集**（本模块只做校验，不另存一份成员清单）；
 * - `launcher/runner-exec.ts` `roleOverridesOf` —— 派发期**宽容读点**（只读、不校验）；
 * - 本模块 —— **加载期唯一判据**（四条 fail-closed 校验）+ 播报面 / 自检面共用的生效值读点。
 *
 * **范围（F-C2 收窄，两套语义并存，勿误判为不一致）**：fail-closed **只作用于 `roles` 子对象**。
 * `agentConfig` **顶层平铺键保持现状** —— 未知顶层键静默忽略（既不拒也不 strip），存量配置因此
 * 零迁移；把顶层也收紧会让现网 `config.json*` 直接起不来。
 */
import { RESERVED_AGENT_CONFIG_FLAT_KEYS } from "./agent-kinds.js";
import { TASK_TYPES, isTaskType, type TaskType } from "./task-types.js";
import type { RiskLevel } from "./types.js";

/** `agentConfig` 里承载职责位映射的**键名**（单一源；顶层平铺 ⇒ 须登记进保留命名空间） */
export const ROLES_AGENT_CONFIG_KEY = "roles";

/**
 * 单个角色可配的四个旋钮（**键清单单一源**）：派发读点 `roleOverridesOf`、加载期校验、
 * 播报面一律引本常量，不得各写一份字面数组。
 */
export const ROLE_CONFIG_KEYS = ["model", "systemPrompt", "systemPromptMode", "risk"] as const;

export type RoleConfigKey = (typeof ROLE_CONFIG_KEYS)[number];

/** 取值面：四个旋钮全部可选（缺的键 ⇒ 该位回落顶层平铺 / 构造器缺省） */
export interface RoleConfig {
  model?: string;
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace";
  risk?: RiskLevel;
}

/** `roles` 的形态：闭集角色名 ⇒ 该位旋钮。未配的角色 = 不覆盖。 */
export type RolesConfig = Partial<Record<TaskType, RoleConfig>>;

/**
 * 项目 `risk` 的**缺省生效值**（与 `launcher/manager.ts` / `launcher/runner.ts` 的
 * `project.risk ?? "write"` 同口径；本模块是「角色 risk 上限」那条校验的运行期消费者）。
 */
export const DEFAULT_RISK_LEVEL: RiskLevel = "write";

/**
 * `risk` 的**显式 rank 映射**（F-C2 硬要求）：`read < write < full`。
 *
 * **禁字面序比较**：字典序给出的却是 `full < read < write` —— 拿 `role.risk <= project.risk`
 * 这类串比较判「不得高于」会把最宽的 `full` 判成最小，校验**反向失效**。
 * rank 值只此一处，比较一律经 {@link riskRankOf}。
 */
export const RISK_RANK: Readonly<Record<RiskLevel, number>> = Object.freeze({
  read: 0,
  write: 1,
  full: 2,
});

/** 某档的 rank（未知取值 ⇒ `undefined`，调用方应先过 {@link isRiskLevel}） */
export function riskRankOf(level: RiskLevel): number {
  return RISK_RANK[level];
}

/** 取值是否属于 `RiskLevel` 闭集（与 `config.ts` 的 `asRiskLevel` 同判据，此处不抛错） */
export function isRiskLevel(value: unknown): value is RiskLevel {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(RISK_RANK, value as RiskLevel)
  );
}

/** 本项目的**生效** risk（只读本机配置值 ?? 缺省，不读 orch 注册投影 —— F-C2） */
export function effectiveRiskOf(project: { risk?: RiskLevel }): RiskLevel {
  return project.risk ?? DEFAULT_RISK_LEVEL;
}

/** `agentConfig.roles` 的宽容读点：缺键 / 非对象 ⇒ `undefined`（= 未配 ⇒ 逐字现状） */
export function rolesOf(agentConfig: Record<string, unknown> | undefined): RolesConfig | undefined {
  const raw = agentConfig?.[ROLES_AGENT_CONFIG_KEY];
  if (!isPlainRecord(raw)) return undefined;
  return raw as RolesConfig;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * **四条 fail-closed 校验**（F-C2）的唯一实现点，返回**错误文案清单**（空 ⇒ 合规）：
 * ① 角色名须属 `TASK_TYPES` 闭集，**且不得撞** `RESERVED_AGENT_CONFIG_FLAT_KEYS`
 *    （平铺自消费键与角色名同处一个 `agentConfig` 命名空间，撞名 ⇒ 读点歧义）；
 * ② `role.risk` 必须是合法档位，**且 rank 不得高于项目生效 risk**（经 {@link RISK_RANK} 显式映射）；
 * ③ `roles` 子对象内**未知键即拒**（防 `modle` 之类拼错静默失效）；
 * ④ **未配 `roles` ⇒ 零错误**（老配置逐字现状，无迁移）。
 *
 * 本函数**不抛**：`config.ts` 侧把每条转成 `fail()`（加载期 fail-fast），
 * `launcher/self-check.ts` 侧把每条转成日志（配置级校验面）。两处共用同一判据 ⇒ 不会长出两套。
 */
export function agentRolesErrors(
  agentConfig: Record<string, unknown> | undefined,
  projectRisk: RiskLevel,
  ctx: string,
): string[] {
  const raw = agentConfig?.[ROLES_AGENT_CONFIG_KEY];
  if (raw === undefined) return []; // ④ 未配 ⇒ 逐字现状

  const errors: string[] = [];
  if (!isPlainRecord(raw)) {
    errors.push(`${ctx} 必须是对象（角色名 → 旋钮对象）`);
    return errors;
  }

  const reserved = new Set<string>(RESERVED_AGENT_CONFIG_FLAT_KEYS);
  for (const [roleName, roleValue] of Object.entries(raw)) {
    // ① 闭集 + 防撞保留命名空间
    if (!isTaskType(roleName)) {
      errors.push(`${ctx}.${roleName} 不是合法职责位（闭集：${TASK_TYPES.join(" / ")}）`);
    }
    if (reserved.has(roleName)) {
      errors.push(
        `${ctx}.${roleName} 撞 agentConfig 顶层平铺保留键（RESERVED_AGENT_CONFIG_FLAT_KEYS），角色名不得占用平铺自消费命名空间`,
      );
    }

    if (!isPlainRecord(roleValue)) {
      errors.push(`${ctx}.${roleName} 必须是旋钮对象（可配 ${ROLE_CONFIG_KEYS.join(" / ")}）`);
      continue;
    }

    // ③ 子对象内未知键即拒
    const known = new Set<string>(ROLE_CONFIG_KEYS);
    for (const key of Object.keys(roleValue)) {
      if (!known.has(key)) {
        errors.push(
          `${ctx}.${roleName}.${key} 是未知键（该位可配 ${ROLE_CONFIG_KEYS.join(" / ")}；拼错的键会被静默忽略，故直接拒绝）`,
        );
      }
    }

    // 取值形态（四个旋钮各一条判据；未知键已在上一步拦下）
    for (const key of ["model", "systemPrompt"] as const) {
      const value = roleValue[key];
      if (value !== undefined && !(typeof value === "string" && value.length > 0)) {
        errors.push(`${ctx}.${roleName}.${key} 必须是非空字符串`);
      }
    }
    const mode = roleValue["systemPromptMode"];
    if (mode !== undefined && mode !== "append" && mode !== "replace") {
      errors.push(`${ctx}.${roleName}.systemPromptMode 必须是 append / replace`);
    }
    const risk = roleValue["risk"];
    if (risk !== undefined) {
      if (!isRiskLevel(risk)) {
        errors.push(`${ctx}.${roleName}.risk 必须是 read / write / full`);
      } else if (riskRankOf(risk) > riskRankOf(projectRisk)) {
        // ② 不得高于项目生效 risk（显式 rank，禁字面序比较）
        errors.push(
          `${ctx}.${roleName}.risk=${risk}（rank ${String(riskRankOf(risk))}）高于本项目生效 risk=${projectRisk}（rank ${String(riskRankOf(projectRisk))}）`,
        );
      }
    }
  }
  return errors;
}

/**
 * 播报正文里的单角色摘要（`config-snapshot` 用）：
 * `systemPrompt` **只报字符数、不落正文**（提示词可能整段策略文本，日志面不承载）。
 */
export function describeRoleConfig(role: RoleConfig): string {
  const bits: string[] = [];
  if (role.model !== undefined) bits.push(`model=${role.model}`);
  if (role.systemPrompt !== undefined)
    bits.push(`systemPrompt=${String(role.systemPrompt.length)}chars`);
  if (role.systemPromptMode !== undefined) bits.push(`systemPromptMode=${role.systemPromptMode}`);
  if (role.risk !== undefined) bits.push(`risk=${role.risk}`);
  return bits.length > 0 ? bits.join(" ") : "无覆盖（回落平铺 / 构造器）";
}

/**
 * 职责位映射的**逐位清单**（自检面用）：按 `TASK_TYPES` 闭集序给出该位是否配置、
 * 配置了什么。纯同步、零 I/O、零派发 ⇒ 角色数不换算成墙钟。
 */
export function roleSummaryLines(
  agentConfig: Record<string, unknown> | undefined,
  projectRisk: RiskLevel,
): string[] {
  const roles = rolesOf(agentConfig);
  if (roles === undefined)
    return [`未配 ${ROLES_AGENT_CONFIG_KEY} ⇒ 全部职责位逐字现状（生效 risk=${projectRisk}）`];
  const lines: string[] = [`职责位映射生效值（上限 risk=${projectRisk}）：`];
  for (const taskType of TASK_TYPES) {
    const role = roles[taskType];
    lines.push(
      role === undefined
        ? `  ${taskType}=未配（回落平铺 / 构造器）`
        : `  ${taskType}={${describeRoleConfig(role)}}`,
    );
  }
  return lines;
}
