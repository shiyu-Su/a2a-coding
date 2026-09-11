/**
 * OpenCode 执行层适配器。
 *
 * - 包装器：`a2a-opencode`（a2a-wrapper），按真实 CLI 拉起 A2A Server：
 *   `a2a-opencode --port <n> --hostname 127.0.0.1 --advertise-host localhost --directory <workspace>
 *    [--config <file>] [--opencode-url <backendUrl>]`
 *   `--config` 由 launcher 生成（`agents/<agentKind>.<projectId>.json`），与包装器内置默认值
 *   深合并；未提供时包装器使用内置默认配置。workspace 通过 `--directory` 指定。
 * - 会话由包装器按 A2A `contextId` 持有并持久化，启动时不追加 `--session`；
 *   `resumeArgs` 仅保留底层 CLI 的 resume 形态（包装器内部/诊断参考）。
 * - 无头调用：`opencode run "<prompt>"`。
 * - 会话恢复：`opencode run --session <id>`；session id 形如 `ses_*`，
 *   从 `--format json` 输出事件字段 `sessionID` 中解析。
 * - 权限：非交互模式下未开启 `--auto` 时权限请求会被自动拒绝；
 *   因此 write/full 风险必须显式 `--auto`，read 风险保持默认（越权即失败）。
 */
import type { AgentKind } from "../types.js";
import { parseJsonObject, readStringField } from "./json.js";
import type { Adapter, LaunchRequest, LaunchSpec, PermissionRisk } from "./types.js";

export class OpenCodeAdapter implements Adapter {
  readonly kind: AgentKind = "opencode";

  buildLaunch(request: LaunchRequest): LaunchSpec {
    // a2a-opencode 真实参数；--opencode-url 指向 Launcher 前置的 `opencode serve`，
    // 未提供时包装器回退其默认值（http://localhost:4096）。
    const args: string[] = [];
    if (request.configPath !== undefined) {
      args.push("--config", request.configPath);
    }
    args.push(
      "--port",
      String(request.a2aPort),
      "--hostname",
      "127.0.0.1",
      "--advertise-host",
      "localhost",
      "--directory",
      request.workspace,
    );
    if (request.backendUrl !== undefined) {
      args.push("--opencode-url", request.backendUrl);
    }
    return { command: "a2a-opencode", args };
  }

  resumeArgs(sessionId: string): string[] {
    // opencode run --session <id>
    return ["--session", sessionId];
  }

  parseSessionId(line: string): string | undefined {
    // --format json 事件：{ "type": "...", "sessionID": "ses_...", ... }
    const event = parseJsonObject(line);
    if (event === undefined) return undefined;
    return readStringField(event, "sessionID");
  }

  permissionArgs(risk: PermissionRisk): string[] {
    // OpenCode 只有 `--auto` 一个权限旋钮：开启=全部自动放行；
    // 不开启时非交互模式的权限请求自动拒绝（read 风险即天然的只读档）。
    return risk === "read" ? [] : ["--auto"];
  }
}
