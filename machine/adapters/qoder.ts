/**
 * Qoder（CN 版 `qodercn`）执行层适配器 —— **ACP 族**（`protocol = "acp"`）。
 *
 * REQ-v0.8.0-2026-09-19-01 · M2；**增补#2-N1：`backendCmd` 必填化**（代码零硬编码缺省）。
 *
 * 与三家 wrapper 族的差异：qoder **没有**仓外 `a2a-qoder` 包装器，改由**仓内自持 ACP 桥**
 * （`machine/acp-bridge/`）承担 A2A 服务面。故本适配器 `buildLaunch` 拉起的是**桥进程**：
 *
 *   `node <appRoot>/dist/acp-bridge/index.js
 *     --port <a2aPort> --workspace <workspace> --project-id <projectId>
 *     --backend-cmd <agentConfig.backendCmd> [--model <agentConfig.qoder.model>]
 *     --risk <read|write|full>`
 *
 * - ACP 后端命令**必须**由项目配置**顶层平铺键** `agentConfig.backendCmd` 指定（绝对路径或 PATH 命令名），
 *   代码**不含**缺省值；未配置（缺键 / 非法 / 空串）⇒ `buildLaunch` 抛明确错误。
 *   （`backendCmd` 是 machine 自消费键故平铺；wrapper 族豁免：其 CLI 定位在仓外包装器内。）
 * - 桥绑定项目 `a2aPort`（Launcher `waitForPort` 以 TCP 就绪判定），内部以 stdio 拉起该后端。
 * - 权限：risk 三档经 `--risk` 透传给桥，由桥映射 ACP `session/request_permission`。
 * - 模型：**协议面**通路（REQ-v0.8.2 M1 协议面增补）—— `agentConfig.qoder.model` ⇒ `--model`
 *   原样透传 ⇒ 桥发 `session/set_config_option {configId:"model"}`。**取代**旧 v0.8.2 M1 的
 *   `-m` argv 拼装（其与 qoder 侧「必须传 modelId、显示名报 `-32602`」的取值口径冲突，
 *   同一配置值无法同时喂两通道（CLI 可容显示名、协议面须 modelId），故撤除 `-m` 拼装）。
 * - outcome 注入：沿用 `A2A_OUTCOME_CONVENTION`（M1 下沉的零依赖叶模块 `../agent-outcome.js`）。
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
export const QODER_BACKEND_CMD_REQUIRED =
  "qoder 项目必须配置 agentConfig.backendCmd（ACP 后端命令，绝对路径或 PATH 命令名）";

export class QoderAdapter implements Adapter {
  readonly kind: AgentKind = "qoder";
  readonly protocol = "acp";

  buildLaunch(request: LaunchRequest): LaunchSpec {
    // ACP 族后端命令必填：代码零硬编码缺省（未配置即抛错，避免静默落到错误命令）。
    const backendCmd = resolveAcpBackendCmd(request.agentConfig);
    if (backendCmd === undefined) {
      throw new Error(QODER_BACKEND_CMD_REQUIRED);
    }
    const model = resolveAcpModel(request.agentConfig, "qoder");
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
      backendCmd,
      // 模型透传（REQ-v0.8.2 M1 · 协议面增补）：配置了 ⇒ 下发 `--model <原样值>`，由桥经 ACP
      // `session/set_config_option` 设置；未配/非法 ⇒ 不下发该旗标（桥不发 set 请求，逐字回到现状）。
      // 本适配器不参与后端 argv 拼装、不做 name↔modelId 映射。
      ...(model !== undefined ? ["--model", model] : []),
      // permission(risk).args（`--risk <档>`）追加在基础参数之后。
      ...(request.permissionArgs ?? []),
    ];
    return { command: "node", args };
  }

  permission(risk: PermissionRisk): PermissionSpec {
    // risk 三档经桥透传，由桥映射 ACP session/request_permission。
    return { args: ["--risk", risk] };
  }

  baseConfig(): Record<string, unknown> {
    // 桥不走包装器 JSON 配置模型：此段为占位（保证 writeAgentConfig 产物含 qoder 段），
    // outcome 注入依 B5 定稿的 ACP 通道（session/new 或首轮 prompt）落地。
    return { qoder: { systemPromptAppend: A2A_OUTCOME_CONVENTION } };
  }
}
