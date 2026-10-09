/**
 * 执行层适配器契约：按 agentKind 分派「拉起 ACP 桥 / 权限映射」。
 *
 * v0.8.5（REQ-v0.8.5-2026-09-21-01 · M4）：wrapper 族退役后四条 kind **同构** ——
 * `protocol` 恒为 `"acp"`，`buildLaunch` 一律拉起仓内 ACP 桥（`machine/acp-bridge/`）；
 * `agentConfig.<kind>` 段与其配置通道（`--config-file` / `--config-segment` /
 * `writeAgentConfig` / `agents/` 产物 / `wrapperConfigPath`）与 `PermissionSpec.config`
 * 一并退役，`Adapter.baseConfig` 删除。
 *
 * 注：会话由 ACP 桥按 A2A `contextId` 内部持有并自行持久化；Launcher 不传 session
 * 参数，也不解析桥输出中的 session id。
 */
import type { AgentKind, RiskLevel } from "../types.js";

/** 拉起一个项目 Agent（ACP 桥进程）所需的上下文 */
export interface LaunchRequest {
  /** 项目标识（桥的 `--project-id`） */
  projectId: string;
  /** 项目 workspace = **代码根**（Agent 执行 / 会话目录，桥的 `--workspace`；可为仓内子目录或自成一仓） */
  workspace: string;
  /** 该项目的 A2A Server 监听端口（桥的 `--port`） */
  a2aPort: number;
  /** 权限参数（launcher 传入 `permission(risk).args`，追加在基础参数之后） */
  permissionArgs?: string[];
  /**
   * 项目 `agentConfig`（来源 = `ProjectConfig.agentConfig`）。四 kind 均为 ACP 族，一律读
   * **顶层平铺自消费键**：`backendCmd`（**可选覆盖**，四 kind 一致 —— 未配置时由
   * `./backend-entry.ts` 逐层自动解析，见 REQ-v0.8.6-2026-09-21-02）· `model`（非必填，协议面模型标识，
   * 原样经 `--model` 透传）· `systemPrompt` / `systemPromptMode`（非必填，自定义注入，
   * 经 `--system-prompt` / `--system-prompt-mode` 透传）。
   */
  agentConfig?: Record<string, unknown>;
}

/** 一条可执行的启动命令 */
export interface LaunchSpec {
  command: string;
  args: string[];
}

/** 任务风险档位（= 线协议 RiskLevel 的别名，权限映射的唯一输入） */
export type PermissionRisk = RiskLevel;

/** 风险档位的权限映射结果：CLI 参数 */
export interface PermissionSpec {
  /** 追加到启动命令的权限 / 模式参数 */
  args: string[];
}

/** 单个 agentKind 的完整适配面 */
export interface Adapter {
  readonly kind: AgentKind;
  /**
   * 启动协议维度（v0.8.5 起**恒为** `"acp"`）：经仓内通用 ACP 接缝拉起
   * （`machine/acp-bridge/`）；wrapper 族（仓外 `a2a-<kind>`）已退役。
   */
  readonly protocol: "acp";
  /** 组装拉起 ACP 桥的命令与参数（含 workspace / port / 权限参数） */
  buildLaunch(request: LaunchRequest): LaunchSpec;
  /** 将任务风险映射为权限参数（`--risk` 档位 + 会话模式 `--mode`） */
  permission(risk: PermissionRisk): PermissionSpec;
}
