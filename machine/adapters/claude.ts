/**
 * Claude Code 执行层适配器 —— **ACP 族**（`protocol = "acp"`，REQ-v0.8.5-2026-09-21-01 · M3）。
 *
 * v0.8.5 起从「仓外 `a2a-claude` 包装器」迁移到**仓内自持 ACP 桥**（`machine/acp-bridge/`），
 * 与 opencode / qoder 适配器同构拉起**桥进程**：
 *
 *   `node <appRoot>/dist/acp-bridge/index.js
 *     --port <a2aPort> --workspace <workspace> --project-id <projectId>
 *     --backend-cmd <归一后的命令> --backend-args <归一后的参数>   // 脚本形态 ⇒ node + 脚本路径；.exe ⇒ 直调
 *     [--model <agentConfig.model>]
 *     [--system-prompt <agentConfig.systemPrompt> [--system-prompt-mode <append|replace>]]
 *     --risk <read|write|full> --mode <plan|acceptEdits|bypassPermissions>
 *     [--session-meta-json <full 档 _meta>]`
 *
 * - ACP 后端命令 = **可选覆盖**（REQ-v0.8.6-2026-09-21-02 · B2：四 kind 一致）：顶层平铺键
 *   `agentConfig.backendCmd` 以显式值为准；未配置 ⇒ `./backend-entry.ts` 逐层解析（L1 机器本地 →
 *   L2 全局 npm 包 `@agentclientprotocol/claude-agent-acp` → L3 PATH 命令名 `claude-agent-acp`），
 *   均未命中 ⇒ `buildLaunch` 抛明确错误（逐层清单落 launcher.log，不进 message）。
 *   **Windows 形态**：显式值填该适配器 `dist/index.js` 的**绝对路径**（该包 `bin` =
 *   `claude-agent-acp` → `dist/index.js`，本身即 JS 入口）⇒ 适配器自动以 `process.execPath` +
 *   脚本路径拉起（形态归一见 `./backend-command.ts`）；`.cmd` / `.ps1` 壳不可直调。
 * - `--backend-args` 由**形态归一**产出：可执行体形态 = `[]`（`--acp` 已被两家适配器**静默忽略**、
 *   报文逐字节同构 ⇒ 裸 bin + stdio 即规范形态）；脚本形态 = `[<适配器入口绝对路径>]`。
 * - 权限三档（B2-①）：risk **恒映射**出会话模式，单一出口 = `permission(risk)`，产出
 *   `--risk <档>`（桥的权限门档位，语义与 opencode / qoder 一致）+ `--mode <modeId>`
 *   （会话模式；桥对 kind 无知、只收原样值）。claude **三档逐档同名对齐**：
 *   `read → plan` · `write → acceptEdits` · `full → bypassPermissions`
 *   （三档均为真机 `session/new` 报文 `modes` 中的可用值）。
 * - full 档的 `bypassPermissions`（B2-③）：**替代**旧 `PermissionSpec.config`
 *   （`claude:{dangerouslyAllowBypassPermissions:true}`）—— 经 **`--session-meta-json`** 下发
 *   `_meta.claudeCode.options.allowDangerouslySkipPermissions=true`（键名与默认值已按适配器
 *   源码自证：`acp-agent.js` 读 `params._meta.claudeCode.options.allowDangerouslySkipPermissions`，
 *   判定为 `!== false` ⇒ **缺省即 true**，与今天配置开关语义一致）；桥在
 *   new / load / resume **三路统一携带**（否则复用会话静默降级）。
 * - **model 平铺（B14′ 必做）**：读**顶层平铺** `agentConfig.model`（复用 `resolveAcpModel`，
 *   kind 无关、零新函数）⇒ 桥 `--model <原样值>` ⇒ ACP `session/set_config_option{configId:"model"}`。
 *   真机报文证 claude 有 `configOptions{id:"model"}`（options default/opus/fable/sonnet/haiku）——
 *   段退役后若不补平铺 model，claude 会**丢能力**（旧 `agentConfig.claude.model` 随段死）。
 * - outcome 注入：由**桥缺省**注入 `A2A_OUTCOME_CONVENTION`（B12③ 单一源），本适配器不再产出段覆盖项。
 */
import { join } from "node:path";
import type { AgentKind } from "../types.js";
import type {
  Adapter,
  LaunchRequest,
  LaunchSpec,
  PermissionRisk,
  PermissionSpec,
} from "./types.js";
import { appRootFromModule } from "../launcher/app-root.js";
import {
  resolveAcpModel,
  resolveSystemPrompt,
  resolveSystemPromptMode,
} from "../launcher/agent-config.js";
import { requireBackendEntry } from "./backend-entry.js";
import { resolveBackendSpawn } from "./backend-command.js";

/** 四层均未解析到入口时的明确错误文案（含分层摘要；纪律对齐 `OPENCODE_BACKEND_CMD_REQUIRED`）。 */
export const CLAUDE_BACKEND_CMD_REQUIRED =
  "未能解析到 claude 的 ACP 后端入口：L0 显式 agentConfig.backendCmd / L1 机器本地 / L2 全局 npm（@agentclientprotocol/claude-agent-acp）/ L3 PATH（命令名 claude-agent-acp）均未命中——请安装该适配器、设 NPM_CONFIG_PREFIX，或显式配置 agentConfig.backendCmd（其 dist/index.js 绝对路径 ⇒ 以 node 拉起；.cmd/.ps1 壳不可直调）；清单见 launcher.log [backend] 行";

/** wrapper 族迁 ACP 后显式下发的空后端参数（B11′）：`--acp` 已被适配器静默忽略 ⇒ 裸 bin + stdio 即规范形态。 */
export const CLAUDE_BACKEND_ARGS: readonly string[] = [];

/** risk → 会话模式（claude **三档逐档同名**；映射表唯一落点 = adapter，桥只收原样值）。 */
const MODE_BY_RISK: Record<PermissionRisk, string> = {
  read: "plan",
  write: "acceptEdits",
  full: "bypassPermissions",
};

/**
 * full 档会话建立期 `_meta`（替代旧 `PermissionSpec.config`）：
 * `_meta.claudeCode.options.allowDangerouslySkipPermissions = true`。
 */
export const CLAUDE_FULL_SESSION_META: Record<string, unknown> = {
  claudeCode: { options: { allowDangerouslySkipPermissions: true } },
};

export class ClaudeAdapter implements Adapter {
  readonly kind: AgentKind = "claude";
  readonly protocol = "acp";

  buildLaunch(request: LaunchRequest): LaunchSpec {
    // 后端入口：显式 `backendCmd` 优先，未配置 ⇒ 逐层自动解析（四 kind 一致，REQ-v0.8.6 · B2）。
    const backendCmd = requireBackendEntry(
      "claude",
      request.agentConfig,
      CLAUDE_BACKEND_CMD_REQUIRED,
    );
    const model = resolveAcpModel(request.agentConfig);
    // 平铺 systemPrompt(Mode)（v0.8.5 · N1）：自定义注入复用 resolveSystemPrompt / resolveSystemPromptMode。
    const systemPrompt = resolveSystemPrompt(request.agentConfig);
    const systemPromptMode = resolveSystemPromptMode(request.agentConfig);
    // 后端启动形态归一（v0.8.5 · M8 增补）：脚本形态 ⇒ node + 脚本路径；可执行体 ⇒ 直调。
    const backend = resolveBackendSpawn(backendCmd, CLAUDE_BACKEND_ARGS);
    // 拉起的是仓内自持桥进程（非仓外 a2a-claude 包装器）。
    const appRoot = appRootFromModule(import.meta.url);
    const bridgeEntry = join(appRoot, "dist", "acp-bridge", "index.js");
    const args: string[] = [
      bridgeEntry,
      "--port",
      String(request.a2aPort),
      "--workspace",
      request.workspace,
      "--project-id",
      request.projectId,
      "--backend-cmd",
      backend.command,
      "--backend-args",
      JSON.stringify(backend.args),
      // 模型透传（B14′）：原样值经桥落到 ACP session/set_config_option；
      // 未配 / 空串 ⇒ 不下发该旗标（零回退）。不参与后端 argv 拼装。
      ...(model !== undefined ? ["--model", model] : []),
      // 自定义注入（v0.8.5 · M4 / N1）：平铺 systemPrompt(Mode) ⇒ 桥 --system-prompt / --system-prompt-mode；
      // 未配 ⇒ 不下发该旗标（桥只用缺省 outcome 约定注入）。
      ...(systemPrompt !== undefined ? ["--system-prompt", systemPrompt] : []),
      ...(systemPromptMode !== undefined ? ["--system-prompt-mode", systemPromptMode] : []),
      // permission(risk).args（`--risk <档>` / `--mode <modeId>` / full 档 `--session-meta-json`）。
      ...(request.permissionArgs ?? []),
    ];
    return { command: "node", args };
  }

  permission(risk: PermissionRisk): PermissionSpec {
    // 单一出口：风险档位 → 权限门档位（--risk）+ 会话模式（--mode）。
    const args: string[] = ["--risk", risk, "--mode", MODE_BY_RISK[risk]];
    if (risk === "full") {
      // bypassPermissions 的承载：会话建立期 `_meta`（替代旧 PermissionSpec.config）。
      args.push("--session-meta-json", JSON.stringify(CLAUDE_FULL_SESSION_META));
    }
    return { args };
  }
}
