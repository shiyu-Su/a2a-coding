/**
 * OpenCode 执行层适配器 —— **ACP 族**（`protocol = "acp"`，REQ-v0.8.1-2026-09-19-01 · M4）。
 *
 * v0.8.1 起从「仓外 `a2a-opencode` 包装器 + `opencode serve` sidecar」迁移到
 * **仓内自持 ACP 桥**（`machine/acp-bridge/`），与 qoder 适配器同构拉起**桥进程**：
 *
 *   `node <appRoot>/dist/acp-bridge/index.js
 *     --port <a2aPort> --workspace <workspace> --project-id <projectId>
 *     --backend-cmd <归一后的命令> --backend-args <归一后的参数>   // 脚本形态 ⇒ node + 脚本路径；.exe ⇒ 直调
 *     [--model <agentConfig.model>]
 *     [--session-timeout <agentConfig.sessionTimeoutMs>]
 *     [--system-prompt <agentConfig.systemPrompt> [--system-prompt-mode <append|replace>]]
 *     --risk <read|write|full>`
 *
 * - ACP 后端命令 = **可选覆盖**（REQ-v0.8.6-2026-09-21-02 · B2：四 kind 一致）：顶层平铺键
 *   `agentConfig.backendCmd` 以显式值为准；未配置 ⇒ `./backend-entry.ts` 逐层解析
 *   （L1 机器本地 → L2 全局 npm 包 `opencode-ai` → L3 PATH 命令名 `opencode`），均未命中 ⇒
 *   `buildLaunch` 抛明确错误（逐层清单落 launcher.log，不进 message）。
 *   显式值的 **Windows 形态**：须为 `opencode.exe` 绝对路径——npm 裸 PATH 只有 `.cmd/.ps1` 壳，
 *   桥的 `shell:false` spawn 直调会 ENOENT。
 * - `--backend-args` 经**形态归一**产出（同 codex / claude）：脚本入口 ⇒ `node <脚本>` + `["acp"]` 后置；
 *   `.exe` 真身 ⇒ 直调 + `["acp"]`（opencode 的 ACP 子命令为 `acp`，非 `--acp` 旗标，kind 级协议事实）。
 * - 权限：risk 三档经 `--risk` 透传给桥（替代旧 `--auto-approve` 二值开关），
 *   由桥映射 ACP `session/request_permission`。
 * - 自定义注入（v0.8.5 · M4）：`agentConfig.<kind>` 段与 `--config-file` / `--config-segment`
 *   配置通道**整体退役** ⇒ 改走**平铺键 + 桥 flag**：`agentConfig.systemPrompt` ⇒
 *   `--system-prompt`、`agentConfig.systemPromptMode` ⇒ `--system-prompt-mode`；桥自带缺省注入
 *   （outcome 约定）保持不变（B12③ 单一源）。
 * - **model 透传（REQ-v0.8.2-2026-09-20-01 · M1 协议面增补；REQ-v0.8.4-2026-09-20-01 · M1 键位平铺）**：
 *   **平铺** `agentConfig.model` ⇒
 *   桥 `--model <原样值>` ⇒ 桥发 ACP `session/set_config_option {configId:"model"}`。
 *   旧 M1 探针实证 `acp` 子命令**严格拒绝** `-m/--model`（短/长旗标、前置/后置四组合均 rc=1 打
 *   usage 退出，拼装即启动崩溃），故后端 argv 通道对 opencode 根本不可用 —— 协议面是两家
 *   （opencode / qoder）**同方言**的唯一通路，本适配器据此启用透传。桥侧**不校验**值、
 *   adapter 侧不做 name↔modelId 映射；未配 / 非法 ⇒ 不下发旗标（零回退）。
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
  resolveSessionTimeoutMs,
  resolveSystemPrompt,
  resolveSystemPromptMode,
} from "../launcher/agent-config.js";
import { requireBackendEntry } from "./backend-entry.js";
import { resolveBackendSpawn } from "./backend-command.js";

/** 四层均未解析到入口时的明确错误文案（含分层摘要；完整清单在 launcher.log，不进本 message）。 */
export const OPENCODE_BACKEND_CMD_REQUIRED =
  "未能解析到 opencode 的 ACP 后端入口：L0 显式 agentConfig.backendCmd / L1 机器本地 / L2 全局 npm（opencode-ai）/ L3 PATH（命令名 opencode）均未命中——请安装该适配器、设 NPM_CONFIG_PREFIX，或显式配置 agentConfig.backendCmd（Windows 须 opencode.exe 绝对路径——npm 裸 PATH 只有 .cmd/.ps1 壳）；清单见 launcher.log [backend] 行";

/** opencode 的 ACP 启动参数（kind 级协议事实：子命令 `acp`，非 `--acp` 旗标）。 */
export const OPENCODE_BACKEND_ARGS: readonly string[] = ["acp"];

export class OpenCodeAdapter implements Adapter {
  readonly kind: AgentKind = "opencode";
  readonly protocol = "acp";

  buildLaunch(request: LaunchRequest): LaunchSpec {
    // 后端入口：显式 `backendCmd` 优先，未配置 ⇒ 逐层自动解析（四 kind 一致，REQ-v0.8.6 · B2）。
    const backendCmd = requireBackendEntry(
      "opencode",
      request.agentConfig,
      OPENCODE_BACKEND_CMD_REQUIRED,
    );
    const model = resolveAcpModel(request.agentConfig);
    const sessionTimeoutMs = resolveSessionTimeoutMs(request.agentConfig);
    const systemPrompt = resolveSystemPrompt(request.agentConfig);
    const systemPromptMode = resolveSystemPromptMode(request.agentConfig);
    // 后端启动形态归一（同 codex / claude）：脚本形态 ⇒ node + 脚本路径；可执行体 ⇒ 直调。
    const backend = resolveBackendSpawn(backendCmd, OPENCODE_BACKEND_ARGS);
    // 拉起的是仓内自持桥进程（非仓外 a2a-opencode 包装器，也不再前置 opencode serve）。
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
      // 模型透传（REQ-v0.8.2 M1 协议面增补）：原样值经桥落到 ACP session/set_config_option；
      // 未配/非法 ⇒ 不下发该旗标，argv 与现状逐字一致。不参与后端 argv 拼装。
      ...(model !== undefined ? ["--model", model] : []),
      // 会话超时透传（REQ-v0.8.7 M2）：平铺 sessionTimeoutMs ⇒ `--session-timeout <ms>`；未配 ⇒ 桥落缺省。
      ...(sessionTimeoutMs !== undefined ? ["--session-timeout", String(sessionTimeoutMs)] : []),
      // 自定义注入（v0.8.5 · M4）：段与 `--config-file` 通道退役 ⇒ 走平铺键 + 桥 flag。
      ...(systemPrompt !== undefined ? ["--system-prompt", systemPrompt] : []),
      ...(systemPromptMode !== undefined ? ["--system-prompt-mode", systemPromptMode] : []),
      // permission(risk).args（`--risk <档>`）追加在基础参数之后。
      ...(request.permissionArgs ?? []),
    ];
    return { command: "node", args };
  }

  permission(risk: PermissionRisk): PermissionSpec {
    // risk 三档经桥透传，由桥映射 ACP session/request_permission。
    return { args: ["--risk", risk] };
  }
}
