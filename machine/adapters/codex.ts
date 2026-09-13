/**
 * Codex 执行层适配器。
 *
 * - 包装器：`a2a-codex`（a2a-wrapper），按真实 CLI 拉起 A2A Server：
 *   `a2a-codex --config <f> --port <n> --hostname 127.0.0.1 --advertise-host localhost
 *    --workspace <workspace> [permission...]`
 * - 会话由包装器按 A2A `contextId` 内部持有（+ 会话落盘补丁），Launcher 不传任何 resume 参数。
 * - 权限：`codex exec` 审批恒为 `never`（headless A2A 不支持交互审批），
 *   唯一权限旋钮是 `--sandbox read-only | workspace-write | danger-full-access`。
 * - 默认配置：`codex.skipGitRepoCheck=true`（关闭 Git 仓库校验，workspace 只需是目录；
 *   项目可在 agentConfig 中覆盖为 false 恢复强校验）。
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

const SANDBOX_BY_RISK: Record<PermissionRisk, string> = {
  read: "read-only",
  write: "workspace-write",
  full: "danger-full-access",
};

export class CodexAdapter implements Adapter {
  readonly kind: AgentKind = "codex";

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
    return { command: "a2a-codex", args };
  }

  permission(risk: PermissionRisk): PermissionSpec {
    // 审批恒为 never：权限只靠沙箱三档映射。
    return { args: ["--sandbox", SANDBOX_BY_RISK[risk]] };
  }

  baseConfig(): Record<string, unknown> {
    // 默认关闭 Git 校验：workspace 仅需指向任意目录（agentConfig 可覆盖为 false）。
    return { codex: { skipGitRepoCheck: true } };
  }
}
