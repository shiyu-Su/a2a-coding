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

/**
 * v0.3.1 机制②：「显式状态标记」约定文案（三端统一、简短、确定性）。
 *
 * worker 在「需要人工拍板」或「确认无法完成」时，于回复末尾输出一个
 * fenced `a2a-outcome` JSON 块；`@a2a-wrapper/core` 的 `resolveOutcome`
 * 在收口点解析后映射为标准 A2A 任务态（input-required / failed）；正常完成
 * 不输出该块（回退 completed）。文案经三端 wrapper 的 systemPrompt 类通道注入。
 */
const A2A_OUTCOME_CONVENTION_LINES = [
  "A2A task outcome convention (follow exactly):",
  "1) If you need the user to decide something before you can continue, end your reply with this fenced block (replace the placeholder):",
  "```a2a-outcome",
  '{"state":"input-required","question":"<the question for the user>"}',
  "```",
  "2) If you are certain the task cannot be completed or is blocked, end your reply with:",
  "```a2a-outcome",
  '{"state":"failed","reason":"<why it is blocked>"}',
  "```",
  "3) On a normal successful completion, do NOT output any a2a-outcome block.",
  "Output at most one such block, and only as the very last thing in your reply.",
];

/** 三端共用的约定文案（供适配器 baseConfig() 绑定到各自的 systemPrompt 类配置键）。 */
export const A2A_OUTCOME_CONVENTION = A2A_OUTCOME_CONVENTION_LINES.join("\n");

/**
 * 默认覆盖项：关闭 events（trace / 中间调用）输出；注入 ② 约定。
 *
 * 三端 wrapper 各自只读取自己 kind 段（多余 kind 段被忽略），因此这里一次性写入
 * 三端键以保证约定「必达」；各适配器 `baseConfig()` 再做 kind 级显式绑定。
 */
const DEFAULT_AGENT_CONFIG: Record<string, unknown> = {
  events: { enabled: false },
  opencode: { systemPrompt: A2A_OUTCOME_CONVENTION, systemPromptMode: "append" },
  codex: { developerInstructions: A2A_OUTCOME_CONVENTION },
  claude: { systemPromptAppend: A2A_OUTCOME_CONVENTION },
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
