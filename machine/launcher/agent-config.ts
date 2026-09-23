/**
 * 项目 `agentConfig` **平铺自消费键**读取器。
 *
 * REQ-v0.8.5-2026-09-21-01 · M4：`agentConfig.<kind>` 段与其配置通道（`DEFAULT_AGENT_CONFIG` /
 * `deepMerge` / `writeAgentConfig` / `agents/<kind>.<projectId>.json` 产物 / `--config-file` +
 * `--config-segment`）整体退役后，本模块只剩「**顶层平铺键**读取器」，与
 * `resolveAcpBackendCmd` / `resolveAcpModel` 同轨；自定义注入改走「平铺键 + 桥 flag」
 * （`agentConfig.systemPrompt(Mode)` ⇒ `--system-prompt` / `--system-prompt-mode`，B3）。
 * outcome 约定的**唯一落点**仍是 ACP 桥缺省注入（B12③，单一源 `../agent-outcome.js`）。
 */

// `A2A_OUTCOME_CONVENTION` re-export **保留**：既有 import 站点（adapters/*、测试）零改动。
export { A2A_OUTCOME_CONVENTION } from "../agent-outcome.js";

// 桥会话窗缺省的**单一源**（v0.8.9 需求2 · M1）：launcher 侧不重复定义该常量。
import { DEFAULT_SESSION_TIMEOUT_MS } from "../acp-bridge/acp/session.js";

/**
 * 从项目 agentConfig 解析 **ACP 族**后端命令：读**顶层平铺键** `agentConfig.backendCmd`。
 *
 * 键位原则（REQ-v0.8.4-2026-09-20-01 定稿；v0.8.5 段退役后为**唯一**键位口径）：
 * **自消费键（机器读）平铺**。`backendCmd` 对**四个 kind 一律是「可选覆盖」**（REQ-v0.8.6-2026-09-21-02 · B2
 * 起：不再必填，未配置时由 `../adapters/backend-entry.ts` 逐层自动解析）；
 * 缺键 / 非法 / 空串 → `undefined`（⇒ 交调用方回落解析；「解析不到 ⇒ 抛」也归调用方）。
 * 本函数**只服务 L0 显式层**，自身语义不变。
 */
export function resolveAcpBackendCmd(
  agentConfig: Record<string, unknown> | undefined,
): string | undefined {
  const backendCmd = agentConfig?.["backendCmd"];
  return typeof backendCmd === "string" && backendCmd.length > 0 ? backendCmd : undefined;
}

/**
 * 从项目 agentConfig 解析 **ACP 族**模型标识：读**顶层平铺键** `agentConfig["model"]`
 * （REQ-v0.8.4-2026-09-20-01 · M1：读点平铺化，取代 v0.8.2 的分段键 `agentConfig.<kind>.model`）。
 *
 * `model` 的**读者是 machine adapter**（读出后经 `--model` 透传给桥，桥原样下发、不解释取值）
 * ⇒ 属**自消费键** ⇒ **平铺**，与 `backendCmd` 同轨；取值判定口径同 `resolveAcpBackendCmd`。
 *
 * 宽容缺省：缺键 / 空串 / 非字符串 → `undefined`（⇒ 不配 model，后端用自身默认）。
 * machine 侧**不做取值校验**（透传语义；校验归后端）。
 */
export function resolveAcpModel(
  agentConfig: Record<string, unknown> | undefined,
): string | undefined {
  const model = agentConfig?.["model"];
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

/**
 * 从项目 agentConfig 解析**平铺** `agentConfig.systemPrompt`：自定义系统提示注入文本，
 * 由 adapter 经桥 `--system-prompt` 透传（v0.8.5 · M4：段与 `--config-file` 通道退役后，
 * 自定义注入的唯一通路；桥自带缺省注入 = outcome 约定，保持不变）。
 *
 * 宽容缺省（同 `resolveAcpModel`）：缺键 / 空串 / 非字符串 → `undefined`
 * （⇒ adapter 不下发该旗标，桥只用缺省 outcome 约定）。
 */
export function resolveSystemPrompt(
  agentConfig: Record<string, unknown> | undefined,
): string | undefined {
  const value = agentConfig?.["systemPrompt"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 从项目 agentConfig 解析**平铺** `agentConfig.systemPromptMode`（`append` | `replace`），
 * 由 adapter 经桥 `--system-prompt-mode` 透传。
 *
 * 宽容缺省：缺键 / 非字符串 / 非法取值 → `undefined`（⇒ adapter 不下发该旗标，桥缺省 `append`）。
 */
export function resolveSystemPromptMode(
  agentConfig: Record<string, unknown> | undefined,
): "append" | "replace" | undefined {
  const value = agentConfig?.["systemPromptMode"];
  return value === "append" || value === "replace" ? value : undefined;
}

/**
 * `agentConfig.sessionTimeoutMs` 的加载期上限（REQ-v0.8.7-2026-09-22-01 · M2；
 * REQ-v0.8.9 需求2 · M1 由 15 min 收严到 **10 min = 600_000 ms**），超限 ⇒ `loadMachineConfig` fail-fast。
 *
 * 上限的**单一源**在此（machine 侧）—— 桥是零仓内依赖的叶模块，只宽松校验「整数 > 0」，
 * 两处各定义常量必漂移。取 10 min 的理由：最坏总框 = `600s(窗) + 300s(结构余量) + 600s(余量按窗封顶)`
 * = **1500s(25 min)** ≤ 安全线、且 < orch 孤儿墙钟 30 min ⇒ **免组合校验**（无需在加载期再校
 * 「窗 + 余量」的合计）。
 */
export const SESSION_TIMEOUT_MS_CAP = 600_000;

/**
 * 从项目 agentConfig 解析**平铺** `agentConfig.sessionTimeoutMs`（v0.8.7 · M2），
 * 由 adapter 经桥 `--session-timeout <ms>` 透传（四 ACP kind 同轨）。
 *
 * 取值合法性由**加载期**把守（`../config.ts` `parseProject`：非正整数或超
 * {@link SESSION_TIMEOUT_MS_CAP} ⇒ fail-fast）；本读取器只管「缺键 / 非数字 → `undefined`」
 * （⇒ adapter 不下发该旗标，桥落自身缺省 `DEFAULT_SESSION_TIMEOUT_MS`）。
 */
export function resolveSessionTimeoutMs(
  agentConfig: Record<string, unknown> | undefined,
): number | undefined {
  const value = agentConfig?.["sessionTimeoutMs"];
  return typeof value === "number" ? value : undefined;
}

/**
 * 从项目 agentConfig 解析**平铺** `agentConfig.continueMarginMs`（v0.8.9 需求2 · M1）：
 * 自动续跑的**余量**（在「生效窗 + 结构余量」之上再追加的派发预算），由 launcher 侧
 * `dispatchBudgetMs` 消费（不进桥旗标，桥不知道派发预算）。
 *
 * **缺省 0 = 不续跑**（缺省值归 `runner-exec.ts` `DEFAULT_CONTINUE_MARGIN_MS`，此处不落地缺省）。
 * 取值合法性由**加载期**把守（`../config.ts` `parseProject`）；本读取器只管「缺键 / 非数字 →
 * `undefined`」。
 */
export function resolveContinueMarginMs(
  agentConfig: Record<string, unknown> | undefined,
): number | undefined {
  const value = agentConfig?.["continueMarginMs"];
  return typeof value === "number" ? value : undefined;
}

/**
 * 项目**生效**的桥会话窗（v0.8.9 需求2 · M1）：显式 `agentConfig.sessionTimeoutMs`
 * ?? 桥缺省 {@link DEFAULT_SESSION_TIMEOUT_MS}。
 *
 * 存在的意义 = 消掉「配不配 `sessionTimeoutMs` ⇒ 续跑资格不同」的隐式耦合：预算/闸门一律
 * 走本函数取生效窗，**单一源**是桥常量（launcher 侧不得另写字面量，先例：
 * `config-snapshot.ts` 从 `../acp-bridge/session-map.js` 引缺省常量）。
 */
export function effectiveSessionTimeoutMs(
  agentConfig: Record<string, unknown> | undefined,
): number {
  return resolveSessionTimeoutMs(agentConfig) ?? DEFAULT_SESSION_TIMEOUT_MS;
}

/**
 * 从项目 agentConfig 解析**平铺** `agentConfig.sessionRetentionDays`（v0.8.9 · M5），
 * 由 adapter 经桥 `--session-retention-days <n>` 透传（SessionMap 条目保留天数）。
 *
 * **与 `sessionTimeoutMs` 语义完全独立**（一个管映射留存、一个管会话执行窗），互不派生。
 * 取值合法性由**加载期**把守（`../config.ts` `parseProject`：非正整数 ⇒ fail-fast）；
 * 本读取器只管「缺键 / 非数字 → `undefined`」（⇒ adapter 不下发该旗标，桥落自身缺省 7 天）。
 */
export function resolveSessionRetentionDays(
  agentConfig: Record<string, unknown> | undefined,
): number | undefined {
  const value = agentConfig?.["sessionRetentionDays"];
  return typeof value === "number" ? value : undefined;
}

/**
 * 从项目 agentConfig 解析**平铺** `agentConfig.sessionRetentionMax`（v0.8.9 · M5），
 * 由 adapter 经桥 `--session-retention-max <n>` 透传（单项目映射条数上限）。
 * 口径同 {@link resolveSessionRetentionDays}（缺省 ⇒ 桥落自身缺省 500 条）。
 */
export function resolveSessionRetentionMax(
  agentConfig: Record<string, unknown> | undefined,
): number | undefined {
  const value = agentConfig?.["sessionRetentionMax"];
  return typeof value === "number" ? value : undefined;
}
