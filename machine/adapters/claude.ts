/**
 * Claude Code 执行层适配器。
 *
 * - 包装器：`a2a-claude`（a2a-wrapper），按真实 CLI 拉起 A2A Server：
 *   `a2a-claude --config <f> --port <n> --hostname 127.0.0.1 --advertise-host localhost
 *    --workspace <workspace> [permission...]`
 * - 会话由包装器按 A2A `contextId` 内部持有（+ 会话落盘补丁），Launcher 不传任何 resume 参数。
 * - 权限：`--permission-mode plan | acceptEdits | bypassPermissions`
 *   （无头模式拒绝 `default` / `auto`，只读档用 `plan`）。
 * - full 档的 `bypassPermissions` 无对应 CLI 开关，需同时注入配置项
 *   `claude.dangerouslyAllowBypassPermissions=true`（见 `permission().config`）。
 * - 默认配置：`claude.settingSources=["user"]`（加载用户级 `~/.claude/settings.json`，
 *   与 opencode / codex 的配置继承语义一致；项目可用 `agentConfig.claude.settingSources` 覆盖）。
 */
import type { AgentKind } from "../types.js";
import type {
  Adapter,
  LaunchRequest,
  LaunchSpec,
  PermissionRisk,
  PermissionSpec,
} from "./types.js";
import { wrapperConfigPath } from "./types.js";

export class ClaudeAdapter implements Adapter {
  readonly kind: AgentKind = "claude";

  buildLaunch(request: LaunchRequest): LaunchSpec {
    const configPath = request.configPath ?? wrapperConfigPath(this.kind, request.projectId);
    const args: string[] = [
      "--config",
      configPath,
      "--port",
      String(request.a2aPort),
      "--hostname",
      "127.0.0.1",
      "--advertise-host",
      "localhost",
      "--workspace",
      request.workspace,
      ...(request.permissionArgs ?? []),
    ];
    return { command: "a2a-claude", args };
  }

  permission(risk: PermissionRisk): PermissionSpec {
    switch (risk) {
      case "read":
        // 只读档：plan 模式仅允许规划与只读探索，写入类操作被拒绝。
        return { args: ["--permission-mode", "plan"] };
      case "write":
        // 工作区写入档：自动接受文件编辑，其余操作仍按默认（拒绝）策略。
        return { args: ["--permission-mode", "acceptEdits"] };
      case "full":
        // 全权档：bypassPermissions 需配合配置开关，否则包装器拒绝启动。
        return {
          args: ["--permission-mode", "bypassPermissions"],
          config: { claude: { dangerouslyAllowBypassPermissions: true } },
        };
    }
  }

  baseConfig(): Record<string, unknown> {
    // 默认加载用户级配置（~/.claude/settings.json 的模型 / 网关 / 认证 env），
    // 与 opencode / codex「默认继承用户配置」语义一致；
    // 项目可经 agentConfig.claude.settingSources 覆盖（如 [] 恢复完全隔离）。
    return { claude: { settingSources: ["user"] } };
  }
}
