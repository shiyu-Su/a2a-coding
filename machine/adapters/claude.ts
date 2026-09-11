/**
 * Claude Code 执行层适配器。
 *
 * - 包装器：`a2a-claude`（a2a-wrapper），按每项目配置拉起 A2A Server。
 * - 无头调用：`claude -p "<prompt>"`。
 * - 会话恢复：`claude -p --resume <id>`（session id 为 UUID）。
 * - 结构化输出：`--output-format json`，顶层字段 `session_id`。
 * - 权限：`--permission-mode default | acceptEdits | bypassPermissions`，
 *   只读任务额外用 `--allowedTools` 预授权只读工具。
 */
import type { AgentKind } from "../types.js";
import { parseJsonObject, readStringField } from "./json.js";
import type { Adapter, LaunchRequest, LaunchSpec, PermissionRisk } from "./types.js";
import { wrapperConfigPath } from "./types.js";

export class ClaudeAdapter implements Adapter {
  readonly kind: AgentKind = "claude";

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
    return { command: "a2a-claude", args };
  }

  resumeArgs(sessionId: string): string[] {
    // claude -p --resume <id>
    return ["--resume", sessionId];
  }

  parseSessionId(line: string): string | undefined {
    // --output-format json：{ "type": "result", ..., "session_id": "<uuid>" }
    const event = parseJsonObject(line);
    if (event === undefined) return undefined;
    return readStringField(event, "session_id");
  }

  permissionArgs(risk: PermissionRisk): string[] {
    switch (risk) {
      case "read":
        // 只读档：默认模式下仅预授权只读工具，其余权限请求在非交互模式被拒绝。
        return ["--permission-mode", "default", "--allowedTools", "Read,Grep,Glob"];
      case "write":
        // 工作区写入档：自动接受文件编辑，其余操作仍走默认（拒绝）策略。
        return ["--permission-mode", "acceptEdits"];
      case "full":
        return ["--permission-mode", "bypassPermissions"];
    }
  }
}
