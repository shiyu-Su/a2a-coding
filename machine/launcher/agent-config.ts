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

/** 默认覆盖项：关闭 events（trace / 中间调用）输出 */
const DEFAULT_AGENT_CONFIG: Record<string, unknown> = {
  events: { enabled: false },
};

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
    merged[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
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
