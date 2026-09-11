/**
 * Codex 执行层适配器。
 *
 * - 包装器：`a2a-codex`（a2a-wrapper），按每项目配置拉起 A2A Server。
 * - 无头调用：`codex exec "<prompt>"`。
 * - 会话恢复：`codex exec resume <id>`；session id 从 `--json` 输出首行
 *   `{"type":"thread.started","thread_id":"..."}` 的 `thread_id` 解析（UUID）。
 * - 权限：`codex exec` 的审批恒为 `never` 且**拒绝** `--ask-for-approval`，
 *   唯一权限旋钮是 `--sandbox read-only | workspace-write | danger-full-access`。
 */
import type { AgentKind } from "../types.js";
import { parseJsonObject, readStringField } from "./json.js";
import type { Adapter, LaunchRequest, LaunchSpec, PermissionRisk } from "./types.js";
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
      "--workspace",
      request.workspace,
      "--port",
      String(request.a2aPort),
    ];
    if (request.sessionId !== undefined) {
      args.push(...this.resumeArgs(request.sessionId));
    }
    return { command: "a2a-codex", args };
  }

  resumeArgs(sessionId: string): string[] {
    // codex exec resume <id>
    return ["resume", sessionId];
  }

  parseSessionId(line: string): string | undefined {
    // --json 首行：{ "type": "thread.started", "thread_id": "<uuid>" }
    const event = parseJsonObject(line);
    if (event === undefined) return undefined;
    if (event["type"] !== "thread.started") return undefined;
    return readStringField(event, "thread_id");
  }

  permissionArgs(risk: PermissionRisk): string[] {
    // 审批恒为 never，codex exec 拒绝 --ask-for-approval：只映射沙箱三档。
    return ["--sandbox", SANDBOX_BY_RISK[risk]];
  }
}
