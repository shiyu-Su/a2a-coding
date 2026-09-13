/**
 * 执行层适配器契约：按 agentKind 分派「包装器拉起 / 权限映射 / 默认配置」。
 *
 * 三端（opencode / codex / claude）的差异全部收敛在本目录的 Adapter 实现中；
 * launcher 与后续 bridge 只依赖本契约，不感知具体 CLI 参数。
 *
 * 注：会话由包装器按 A2A `contextId` 内部持有并自行持久化（见会话落盘补丁），
 * Launcher 不传 session / resume 参数，也不解析包装器输出中的 session id。
 */
import { posix } from "node:path";
import type { AgentKind, RiskLevel } from "../types.js";

/** 拉起一个项目 Agent（A2A 包装器）所需的上下文 */
export interface LaunchRequest {
  /** 项目标识（用于定位每项目包装器配置文件） */
  projectId: string;
  /** 项目 workspace（Agent 执行目录） */
  workspace: string;
  /** 该项目的 A2A Server 监听端口 */
  a2aPort: number;
  /**
   * 底层后端服务基址（opencode 项目为 Launcher 前置拉起的 `opencode serve`）。
   * opencode 适配器映射为 `--opencode-url`；其他 kind 忽略。
   */
  backendUrl?: string;
  /**
   * launcher 生成的包装器配置文件绝对路径。
   * 提供时经 `--config` 传给包装器；缺省时回退到 `wrapperConfigPath(kind, projectId)`。
   */
  configPath?: string;
  /** 权限参数（launcher 传入 `permission(risk).args`，追加在基础参数之后） */
  permissionArgs?: string[];
}

/** 一条可执行的启动命令 */
export interface LaunchSpec {
  command: string;
  args: string[];
}

/** 任务风险档位（= 线协议 RiskLevel 的别名，权限映射的唯一输入） */
export type PermissionRisk = RiskLevel;

/** 风险档位的权限映射结果：CLI 参数 + 可选配置补丁 */
export interface PermissionSpec {
  /** 追加到启动命令的权限 / 沙箱参数 */
  args: string[];
  /**
   * 需同时注入包装器配置文件的覆盖项（如 claude full 档的
   * `claude.dangerouslyAllowBypassPermissions`）。由 launcher 最后合并，避免被用户配置覆盖。
   */
  config?: Record<string, unknown>;
}

/** 单个 agentKind 的完整适配面 */
export interface Adapter {
  readonly kind: AgentKind;
  /** 组装拉起 A2A 包装器的命令与参数（含 workspace / port / 权限参数） */
  buildLaunch(request: LaunchRequest): LaunchSpec;
  /** 将任务风险映射为权限参数 + 可选配置补丁 */
  permission(risk: PermissionRisk): PermissionSpec;
  /** 该 kind 的默认包装器配置覆盖项（与 DEFAULT_AGENT_CONFIG 先合并） */
  baseConfig(): Record<string, unknown>;
}

/**
 * 每项目 A2A 包装器配置文件路径（改造文档 §3.1：`agents/<agentKind>.<project>.json`）。
 * 统一使用 POSIX 分隔符，保证跨机（Windows/Mac）命令行参数一致。
 */
export function wrapperConfigPath(kind: AgentKind, projectId: string): string {
  return posix.join("agents", `${kind}.${projectId}.json`);
}
