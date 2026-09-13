/**
 * 执行层适配器入口：`getAdapter(kind)` 按 agentKind 返回单例适配器。
 * 新增 Agent 类型只需实现 `Adapter` 并在此注册，调用方零改动。
 */
import type { AgentKind } from "../types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { OpenCodeAdapter } from "./opencode.js";
import type { Adapter } from "./types.js";

export type {
  Adapter,
  LaunchRequest,
  LaunchSpec,
  PermissionRisk,
  PermissionSpec,
} from "./types.js";
export { wrapperConfigPath } from "./types.js";

const ADAPTERS: Record<AgentKind, Adapter> = {
  opencode: new OpenCodeAdapter(),
  codex: new CodexAdapter(),
  claude: new ClaudeAdapter(),
};

/** 按 agentKind 取适配器；kind 由配置加载器校验，必命中。 */
export function getAdapter(kind: AgentKind): Adapter {
  return ADAPTERS[kind];
}
