/**
 * 每项目 A2A 包装器配置生成。
 *
 * 包装器 `--config` 指定的 JSON 与其内置默认值深合并，因此这里只需写出「覆盖项」，
 * 按以下优先级分层合并（后者覆盖前者）：
 * 1. `DEFAULT_AGENT_CONFIG`：默认关闭 events（trace / 中间调用）输出；
 * 2. 适配器 `baseConfig()`：kind 级默认项（如 codex 关闭 Git 校验）；
 * 3. 项目 `agentConfig`：用户级覆盖，可改写上述任一默认（支持 `opencode` / `mcp` /
 *    `systemPrompt` 等顶层键）；
 * 4. 风险配置补丁（`permission(risk).config`）：launcher 强制的安全项，最后合并，
 *    保证不被 `agentConfig` 覆盖（如 claude full 档的 `dangerouslyAllowBypassPermissions`）。
 *
 * 产物写入 `<appRoot>/agents/<agentKind>.<projectId>.json`，每次启动覆盖生成，
 * 属运行态产物（见 machine/.gitignore）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "../types.js";
import { A2A_OUTCOME_CONVENTION } from "../agent-outcome.js";

// REQ-v0.8.0-2026-09-19-01 · M1：`A2A_OUTCOME_CONVENTION` 已下沉**零依赖叶模块**
// `machine/agent-outcome.ts`（消除未来 `acp-bridge → launcher` 依赖倒置）。
// 此处 re-export 保持既有 import 站点（adapters/*、测试）零改动；本模块自身
// （DEFAULT_AGENT_CONFIG）经上面的 import 继续使用该常量。
export { A2A_OUTCOME_CONVENTION };

/**
 * 默认覆盖项：关闭 events（trace / 中间调用）输出；注入 ② 约定。
 *
 * 各端 wrapper 各自只读取自己 kind 段（多余 kind 段被忽略），因此这里一次性写入
 * 全部 kind 键以保证约定「必达」；各适配器 `baseConfig()` 再做 kind 级显式绑定。
 *
 * qoder（ACP 族）注：桥不走包装器 JSON 配置模型，`qoder` 段当前为**占位** —— 保证
 * `writeAgentConfig` 产物含 qoder 段（满足 `agent-config-segments` 断言）；outcome 注入
 * 依 B5 定稿的 ACP 通道（session/new 或首轮 prompt）落地。
 */
const DEFAULT_AGENT_CONFIG: Record<string, unknown> = {
  events: { enabled: false },
  opencode: { systemPrompt: A2A_OUTCOME_CONVENTION, systemPromptMode: "append" },
  codex: { developerInstructions: A2A_OUTCOME_CONVENTION },
  claude: { systemPromptAppend: A2A_OUTCOME_CONVENTION },
  qoder: { systemPromptAppend: A2A_OUTCOME_CONVENTION },
};

/**
 * 从项目 agentConfig 解析 **ACP 族**后端命令：读**顶层平铺键** `agentConfig.backendCmd`。
 *
 * 键位原则：`backendCmd` 是 **machine 自消费键** —— 由 `agentKind` 决定哪个 adapter 读它，
 * 故**平铺**（同 `timeouts` 等先例）；而 **wrapper 消费的**分段键（`opencode` / `codex` /
 * `claude` 段）是第三方包装器按段读取的**外部契约**，维持分段。
 *
 * `backendCmd` 为 **ACP 族必填**（代码零硬编码缺省，wrapper 族豁免）；缺键 / 非法 / 空串 →
 * `undefined`（必填判定由调用方负责）。DEFAULT_AGENT_CONFIG **不预置**该键。
 */
export function resolveAcpBackendCmd(
  agentConfig: Record<string, unknown> | undefined,
): string | undefined {
  const backendCmd = agentConfig?.["backendCmd"];
  return typeof backendCmd === "string" && backendCmd.length > 0 ? backendCmd : undefined;
}

/** 纯对象判定（排除 null 与数组） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 深合并两个纯对象：`override` 的值优先；
 * 双方同为纯对象时递归合并，其余类型（数组 / 标量 / null）整体替换。
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return merged;
}

/**
 * 生成并写出项目包装器配置，返回配置文件绝对路径。
 * 写失败时抛出原始 fs 错误，由调用方（AgentManager.start）包装为 AgentStartError。
 */
export function writeAgentConfig(
  project: ProjectConfig,
  appRoot: string,
  baseConfig: Record<string, unknown>,
  riskConfig?: Record<string, unknown>,
): string {
  const config = deepMerge(
    deepMerge(deepMerge(DEFAULT_AGENT_CONFIG, baseConfig), project.agentConfig ?? {}),
    riskConfig ?? {},
  );
  const dir = join(appRoot, "agents");
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, `${project.agentKind}.${project.projectId}.json`);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}
