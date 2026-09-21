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

/**
 * 从项目 agentConfig 解析 **ACP 族**后端命令：读**顶层平铺键** `agentConfig.backendCmd`。
 *
 * 键位原则（REQ-v0.8.4-2026-09-20-01 定稿；v0.8.5 段退役后为**唯一**键位口径）：
 * **自消费键（机器读）平铺**。`backendCmd` 为 **ACP 族必填**（代码零硬编码缺省）；
 * 缺键 / 非法 / 空串 → `undefined`（必填判定由调用方负责）。
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
