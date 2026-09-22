/**
 * Qoder（CN 版 `qodercn`）执行层适配器 —— **ACP 族**（`protocol = "acp"`）。
 *
 * REQ-v0.8.0-2026-09-19-01 · M2；**增补#2-N1：`backendCmd` 必填化**（代码零硬编码缺省）（已废）；
 * **REQ-v0.8.6-2026-09-21-02 · B2 反转：`backendCmd` 降为可选覆盖**（四 kind 一致，未配置 ⇒ 自动解析）。
 *
 * 与三家 wrapper 族的差异：qoder **没有**仓外 `a2a-qoder` 包装器，改由**仓内自持 ACP 桥**
 * （`machine/acp-bridge/`）承担 A2A 服务面。故本适配器 `buildLaunch` 拉起的是**桥进程**：
 *
 *   `node <appRoot>/dist/acp-bridge/index.js
 *     --port <a2aPort> --workspace <workspace> --project-id <projectId>
 *     --backend-cmd <归一后的命令> --backend-args <归一后的参数>   // 脚本形态 ⇒ node + 脚本路径；.exe ⇒ 直调
 *     [--model <agentConfig.model>]
 *     [--system-prompt <agentConfig.systemPrompt> [--system-prompt-mode <append|replace>]]
 *     --risk <read|write|full>`
 *
 * - ACP 后端命令 = **可选覆盖**（REQ-v0.8.6-2026-09-21-02 · B2：四 kind 一致）：顶层平铺键
 *   `agentConfig.backendCmd`（绝对路径或 PATH 命令名）以显式值为准；未配置 ⇒ `./backend-entry.ts`
 *   按 `knownPaths`（win `~/.qoder-cn/bin/qoderclicn/qoderclicn.exe` · posix `~/.local/bin/qoderclicn`）
 *   → L3 PATH（**命令名 `qoderclicn`，≠ kind 名**）解析；均未命中 ⇒ `buildLaunch` 抛明确错误
 *   （逐层清单落 launcher.log，不进 message）。qoder 无 npm 包 ⇒ 不探 L1/L2。
 *   （`backendCmd` 是 machine 自消费键故平铺；v0.8.5 段退役后为唯一键位口径。）
 * - 桥绑定项目 `a2aPort`（Launcher `waitForPort` 以 TCP 就绪判定），内部以 stdio 拉起该后端。
 * - 权限：risk 三档经 `--risk` 透传给桥，由桥映射 ACP `session/request_permission`。
 * - 自定义注入（v0.8.5 · M4）：`agentConfig.<kind>` 段与配置通道整体退役 ⇒
 *   `agentConfig.systemPrompt` / `agentConfig.systemPromptMode` ⇒ 桥 `--system-prompt` /
 *   `--system-prompt-mode`；桥自带缺省注入（outcome 约定）保持不变。
 * - 模型：**协议面**通路（REQ-v0.8.2 M1 协议面增补；REQ-v0.8.4 M1 键位平铺）—— **平铺** `agentConfig.model` ⇒ `--model`
 *   原样透传 ⇒ 桥发 `session/set_config_option {configId:"model"}`。**取代**旧 v0.8.2 M1 的
 *   `-m` argv 拼装（其与 qoder 侧「必须传 modelId、显示名报 `-32602`」的取值口径冲突，
 *   同一配置值无法同时喂两通道（CLI 可容显示名、协议面须 modelId），故撤除 `-m` 拼装）。
 * - outcome 注入：**唯一落点 = ACP 桥缺省**（B12③ 单一源，本适配器不再产出任何段覆盖项）。
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

/** 未解析到入口时的明确错误文案（含分层摘要；完整清单在 launcher.log，不进本 message）。 */
export const QODER_CN_BACKEND_CMD_REQUIRED =
  "未能解析到 qoder-cn 的 ACP 后端入口：L0 显式 agentConfig.backendCmd / known 已知安装位置（~/.qoder-cn/bin/qoderclicn/qoderclicn.exe 或 ~/.local/bin/qoderclicn）/ L3 PATH（命令名 qoderclicn，≠ kind 名）均未命中——请安装 qoderclicn，或显式配置 agentConfig.backendCmd（绝对路径或 PATH 命令名）；清单见 launcher.log [backend] 行";

/**
 * qoder 的 ACP 后端参数（kind 级协议事实：`qoderclicn --acp`）。
 * 此前由桥的 `DEFAULT_BACKEND_ARGS` 兜底（不下发 `--backend-args`）；接形态归一后**显式下发**，
 * 可执行体形态下实参逐字不变。
 */
export const QODER_CN_BACKEND_ARGS: readonly string[] = ["--acp"];

export class QoderCnAdapter implements Adapter {
  readonly kind: AgentKind = "qoder-cn";
  readonly protocol = "acp";

  buildLaunch(request: LaunchRequest): LaunchSpec {
    // 后端入口：显式 `backendCmd` 优先，未配置 ⇒ 按 knownPaths + PATH 自动解析（四 kind 一致）。
    const backendCmd = requireBackendEntry(
      "qoder-cn",
      request.agentConfig,
      QODER_CN_BACKEND_CMD_REQUIRED,
    );
    const model = resolveAcpModel(request.agentConfig);
    const systemPrompt = resolveSystemPrompt(request.agentConfig);
    const systemPromptMode = resolveSystemPromptMode(request.agentConfig);
    // 后端启动形态归一（与三家同构）：qoder 真身是 `.exe` / 无扩展名 ⇒ 恒等（直调 + `--acp`），
    // 后端命令行与旧「不下发 `--backend-args`、由桥落缺省 `["--acp"]`」逐字一致。
    const backend = resolveBackendSpawn(backendCmd, QODER_CN_BACKEND_ARGS);
    // 与三家 wrapper 族不同：拉起的是仓内自持桥进程（非仓外 a2a-<kind> 包装器）。
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
      // 模型透传（REQ-v0.8.2 M1 · 协议面增补）：配置了 ⇒ 下发 `--model <原样值>`，由桥经 ACP
      // `session/set_config_option` 设置；未配/非法 ⇒ 不下发该旗标（桥不发 set 请求，逐字回到现状）。
      // 本适配器不参与后端 argv 拼装、不做 name↔modelId 映射。
      ...(model !== undefined ? ["--model", model] : []),
      // 自定义注入（v0.8.5 · M4）：段与配置通道退役 ⇒ 走平铺键 + 桥 flag。
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
