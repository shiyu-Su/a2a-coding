/**
 * OpenCode 执行层适配器。
 *
 * - 包装器：`a2a-opencode`（a2a-wrapper），按真实 CLI 拉起 A2A Server：
 *   `a2a-opencode --port <n> --hostname 127.0.0.1 --advertise-host localhost --directory <workspace>
 *    [--config <file>] [--opencode-url <backendUrl>] [permission...]`
 *   `--config` 由 launcher 生成（`agents/<agentKind>.<projectId>.json`），与包装器内置默认值
 *   深合并；未提供时包装器使用内置默认配置。workspace 通过 `--directory` 指定。
 * - 会话由包装器按 A2A `contextId` 内部持有（+ 会话落盘补丁），Launcher 不传任何 resume 参数。
 * - 权限：`--auto-approve` / `--no-auto-approve` 二值开关；包装器只有这一个旋钮，
 *   write 与 full 无法区分（两者同为自动放行），read 保持不自动放行（越权即失败）。
 */
import type { AgentKind } from "../types.js";
import type {
  Adapter,
  LaunchRequest,
  LaunchSpec,
  PermissionRisk,
  PermissionSpec,
} from "./types.js";
import { A2A_OUTCOME_CONVENTION } from "../launcher/agent-config.js";

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
    args.push(...(request.permissionArgs ?? []));
    return { command: "a2a-opencode", args };
  }

  permission(risk: PermissionRisk): PermissionSpec {
    // read=不自动放行；write/full=自动放行（粒度限制，二者无法区分）。
    return risk === "read" ? { args: ["--no-auto-approve"] } : { args: ["--auto-approve"] };
  }

  baseConfig(): Record<string, unknown> {
    // v0.3.1 机制②：注入「a2a-outcome」约定，使 worker 在需人工拍板 / 无法完成时
    // 于回复末尾输出结构化块（append 模式，不替换既有 systemPrompt）。
    return {
      opencode: { systemPrompt: A2A_OUTCOME_CONVENTION, systemPromptMode: "append" },
    };
  }
}
