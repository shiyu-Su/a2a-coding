/**
 * OpenCode 执行层适配器 —— **ACP 族**（`protocol = "acp"`，REQ-v0.8.1-2026-09-19-01 · M4）。
 *
 * v0.8.1 起从「仓外 `a2a-opencode` 包装器 + `opencode serve` sidecar」迁移到
 * **仓内自持 ACP 桥**（`machine/acp-bridge/`），与 qoder 适配器同构拉起**桥进程**：
 *
 *   `node <appRoot>/dist/acp-bridge/index.js
 *     --port <a2aPort> --workspace <workspace> --project-id <projectId>
 *     --backend-cmd <agentConfig.backendCmd> --backend-args '["acp"]'
 *     [--model <agentConfig.opencode.model>]
 *     --risk <read|write|full>
 *     --config-file <agents 产物路径> --config-segment opencode`
 *
 * - ACP 后端命令**必须**由项目配置**顶层平铺键** `agentConfig.backendCmd` 指定，代码零硬编码缺省；
 *   未配置 ⇒ `buildLaunch` 抛明确错误。探针实证：Windows 下 npm 裸 PATH 只有 .cmd/.ps1 壳，
 *   桥的 shell:false spawn 直调会 ENOENT ⇒ **须配置 opencode.exe 绝对路径**。
 * - `backendArgs` 是 kind 级协议事实（opencode 的 ACP 子命令为 `acp`，非 `--acp` 旗标），
 *   由本适配器内置并以 `--backend-args` JSON 数组透传给桥。
 * - 权限：risk 三档经 `--risk` 透传给桥（替代旧 `--auto-approve` 二值开关），
 *   由桥映射 ACP `session/request_permission`。
 * - 配置消费：桥经 `--config-file`（launcher 生成的 `agents/opencode.<projectId>.json`）+
 *   `--config-segment opencode` 读取本段配置（M1 提供读取面；注入时机在 M2 落地）。
 * - outcome 注入：沿用 `A2A_OUTCOME_CONVENTION`（零依赖叶模块 `../agent-outcome.js`），
 *   保留 opencode 段形状供包装器时代产物与桥读者兼容。
 * - **model 透传（REQ-v0.8.2-2026-09-20-01 · M1 协议面增补）**：`agentConfig.opencode.model` ⇒
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
import { A2A_OUTCOME_CONVENTION } from "../agent-outcome.js";
import { resolveAcpBackendCmd, resolveAcpModel } from "../launcher/agent-config.js";

/** 缺少 `agentConfig.backendCmd` 时的明确错误文案（ACP 族必填）。 */
export const OPENCODE_BACKEND_CMD_REQUIRED =
  "opencode 项目必须配置 agentConfig.backendCmd（ACP 后端命令；Windows 须为 opencode.exe 绝对路径——npm 裸 PATH 只有 .cmd/.ps1 壳，无 shell 的 spawn 直调会 ENOENT）";

/** opencode 的 ACP 启动参数（kind 级协议事实：子命令 `acp`，非 `--acp` 旗标）。 */
export const OPENCODE_BACKEND_ARGS: readonly string[] = ["acp"];

export class OpenCodeAdapter implements Adapter {
  readonly kind: AgentKind = "opencode";
  readonly protocol = "acp";

  buildLaunch(request: LaunchRequest): LaunchSpec {
    // ACP 族后端命令必填：代码零硬编码缺省（未配置即抛错，避免静默落到错误命令）。
    const backendCmd = resolveAcpBackendCmd(request.agentConfig);
    if (backendCmd === undefined) {
      throw new Error(OPENCODE_BACKEND_CMD_REQUIRED);
    }
    const model = resolveAcpModel(request.agentConfig, "opencode");
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
      backendCmd,
      "--backend-args",
      JSON.stringify([...OPENCODE_BACKEND_ARGS]),
      // 模型透传（REQ-v0.8.2 M1 协议面增补）：原样值经桥落到 ACP session/set_config_option；
      // 未配/非法 ⇒ 不下发该旗标，argv 与现状逐字一致。不参与后端 argv 拼装。
      ...(model !== undefined ? ["--model", model] : []),
      // permission(risk).args（`--risk <档>`）追加在基础参数之后。
      ...(request.permissionArgs ?? []),
    ];
    if (request.configPath !== undefined) {
      args.push("--config-file", request.configPath, "--config-segment", "opencode");
    }
    return { command: "node", args };
  }

  permission(risk: PermissionRisk): PermissionSpec {
    // risk 三档经桥透传，由桥映射 ACP session/request_permission。
    return { args: ["--risk", risk] };
  }

  baseConfig(): Record<string, unknown> {
    // opencode 段形状保持不变（systemPrompt/systemPromptMode 键是项目 opencode.json
    // 消费的配置契约；桥读者 M2 起经 --config-segment 读取本段）。
    return {
      opencode: { systemPrompt: A2A_OUTCOME_CONVENTION, systemPromptMode: "append" },
    };
  }
}
