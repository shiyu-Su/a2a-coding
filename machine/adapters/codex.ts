/**
 * Codex 执行层适配器 —— **ACP 族**（`protocol = "acp"`，REQ-v0.8.5-2026-09-21-01 · M2）。
 *
 * v0.8.5 起从「仓外 `a2a-codex` 包装器」迁移到**仓内自持 ACP 桥**（`machine/acp-bridge/`），
 * 与 opencode / qoder 适配器同构拉起**桥进程**：
 *
 *   `node <appRoot>/dist/acp-bridge/index.js
 *     --port <a2aPort> --workspace <workspace> --project-id <projectId>
 *     --backend-cmd <归一后的命令> --backend-args <归一后的参数>   // 脚本形态 ⇒ node + 脚本路径；.exe ⇒ 直调
 *     [--model <agentConfig.model>]
 *     [--system-prompt <agentConfig.systemPrompt> [--system-prompt-mode <append|replace>]]
 *     --risk <read|write|full> --mode <modeId> [--collaboration-mode plan]`
 *
 * - ACP 后端命令 = **可选覆盖**（REQ-v0.8.6-2026-09-21-02 · B2：四 kind 一致）：顶层平铺键
 *   `agentConfig.backendCmd` 以显式值为准；未配置 ⇒ `./backend-entry.ts` 逐层解析
 *   （L1 机器本地 → L2 全局 npm 包 `@agentclientprotocol/codex-acp` → L3 PATH 命令名 `codex-acp`），
 *   均未命中 ⇒ `buildLaunch` 抛明确错误（逐层清单落 launcher.log，不进 message）。
 *   **Windows 形态**：显式值填该适配器 `dist/index.js` 的**绝对路径** ⇒ 适配器自动以
 *   `process.execPath` + 脚本路径拉起（形态归一见 `./backend-command.ts`）；`.cmd` / `.ps1`
 *   壳在桥的 shell:false spawn 下会 ENOENT/EINVAL，故不能指向 npm 生成的壳。
 * - `--backend-args` 由**形态归一**产出：可执行体形态 = `[]`（codex-acp 自带 bin + stdio 入口、
 *   无 kind 级子命令 ⇒ 区别于 opencode 的 `["acp"]` 与 qoder 的 `["--acp"]`）；脚本形态 =
 *   `[<适配器入口绝对路径>]`（B11′ 的「显式下发」语义保留）。
 * - 权限：risk 三档经 `permission(risk)` **单一出口**下发 —— `--risk <档>`（桥映射 ACP
 *   `session/request_permission`）**加** `--mode <modeId>`（桥 `applyMode()`：优先
 *   `session/set_mode`，**仅 `-32601`** 回落 `set_config_option{configId:"mode"}`；失败 fail-fast）。
 *   映射表唯一落点 = 本适配器（桥对 kind 无知）：`write → agent`、`full → agent-full-access`、
 *   `read → read-only`。
 * - `read` 档**额外**下发 `--collaboration-mode plan`（B2-② 定稿）：codex 的 `collaboration_mode`
 *   只出现在 `configOptions`（不在 `modes` 里）⇒ 桥只走
 *   `set_config_option{configId:"collaboration_mode"}`；`write` / `full` **不下发**该旗标
 *   （真实执行；plan 阶段零写）。`CODEX_CONFIG` 路径已由探针证伪，不使用。
 * - **model 透传**：**平铺** `agentConfig.model`（复用既有 `resolveAcpModel`，kind 无关、零新函数）⇒
 *   桥 `--model <原样值>` ⇒ 桥发 ACP `session/set_config_option {configId:"model"}`。
 *   未配 / 非法 ⇒ 不下发旗标（零回退）。桥侧不校验值、adapter 侧不做 name↔modelId 映射。
 * - outcome 注入：**唯一落点 = ACP 桥缺省**（`acp-bridge/acp/session.ts` 的 `buildInjection()`
 *   缺省即 `A2A_OUTCOME_CONVENTION`）⇒ 本适配器 `baseConfig()` 退役，`developerInstructions`
 *   等 codex 段键全部删除。
 * - 配置面：`agentConfig.<kind>` 段与 `--config-file` / `--config-segment` 配置通道已随本版
 *   **整体退役**（M4）；自定义注入改走平铺键 `agentConfig.systemPrompt(Mode)` ⇒ 桥
 *   `--system-prompt(Mode)`。
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

/** 四层均未解析到入口时的明确错误文案（含分层摘要；完整清单在 launcher.log，不进本 message）。 */
export const CODEX_BACKEND_CMD_REQUIRED =
  "未能解析到 codex 的 ACP 后端入口：L0 显式 agentConfig.backendCmd / L1 机器本地 / L2 全局 npm（@agentclientprotocol/codex-acp）/ L3 PATH（命令名 codex-acp）均未命中——请安装该适配器、设 NPM_CONFIG_PREFIX，或显式配置 agentConfig.backendCmd（其 dist/index.js 绝对路径 ⇒ 以 node 拉起；.cmd/.ps1 壳不可直调）；清单见 launcher.log [backend] 行";

/** codex 的 ACP 后端参数（kind 级协议事实：自带 bin + stdio 入口、无子命令 ⇒ 空数组）。 */
export const CODEX_BACKEND_ARGS: readonly string[] = [];

/** risk 三档 → ACP 会话模式 id（映射表唯一落点 = 本适配器；桥只做原样透传）。 */
const MODE_BY_RISK: Record<PermissionRisk, string> = {
  read: "read-only",
  write: "agent",
  full: "agent-full-access",
};

/** read 档附带的协作模式（B2-②：只走 set_config_option；write / full 不下发）。 */
const READ_COLLABORATION_MODE = "plan";

export class CodexAdapter implements Adapter {
  readonly kind: AgentKind = "codex";
  readonly protocol = "acp";

  buildLaunch(request: LaunchRequest): LaunchSpec {
    // 后端入口：显式 `backendCmd` 优先，未配置 ⇒ 逐层自动解析（四 kind 一致，REQ-v0.8.6 · B2）。
    const backendCmd = requireBackendEntry(
      "codex",
      request.agentConfig,
      CODEX_BACKEND_CMD_REQUIRED,
    );
    const model = resolveAcpModel(request.agentConfig);
    // 平铺 systemPrompt(Mode)（v0.8.5 · N1）：自定义注入复用 resolveSystemPrompt / resolveSystemPromptMode。
    const systemPrompt = resolveSystemPrompt(request.agentConfig);
    const systemPromptMode = resolveSystemPromptMode(request.agentConfig);
    // 后端启动形态归一（v0.8.5 · M8 增补）：脚本形态 ⇒ node + 脚本路径；可执行体 ⇒ 直调。
    const backend = resolveBackendSpawn(backendCmd, CODEX_BACKEND_ARGS);
    // 拉起的是仓内自持桥进程（非仓外 a2a-codex 包装器）。
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
      // 可执行体形态 = 空数组（B11′）；脚本形态 = [<适配器入口绝对路径>]（形态归一，见 backend-command.ts）。
      "--backend-args",
      JSON.stringify(backend.args),
      // 模型透传：原样值经桥落到 ACP session/set_config_option；未配/非法 ⇒ 不下发该旗标。
      ...(model !== undefined ? ["--model", model] : []),
      // 自定义注入（v0.8.5 · M4 / N1）：平铺 systemPrompt(Mode) ⇒ 桥 --system-prompt / --system-prompt-mode；
      // 未配 ⇒ 不下发该旗标（桥只用缺省 outcome 约定注入）。
      ...(systemPrompt !== undefined ? ["--system-prompt", systemPrompt] : []),
      ...(systemPromptMode !== undefined ? ["--system-prompt-mode", systemPromptMode] : []),
      // permission(risk).args（`--risk <档>` + `--mode <modeId>` [+ `--collaboration-mode`]）追加其后。
      ...(request.permissionArgs ?? []),
    ];
    return { command: "node", args };
  }

  permission(risk: PermissionRisk): PermissionSpec {
    // risk → 权限/模式 单一出口：`--risk` 管桥的 permission 门，`--mode` 管会话模式。
    const args: string[] = ["--risk", risk, "--mode", MODE_BY_RISK[risk]];
    if (risk === "read") {
      // read 档附加 plan 协作模式（B2-②；write / full 真实执行、不下发）。
      args.push("--collaboration-mode", READ_COLLABORATION_MODE);
    }
    return { args };
  }
}
