/**
 * 执行层适配器契约：按 agentKind 分派「包装器拉起 / 会话恢复 / 输出解析 / 权限参数」。
 *
 * 三端（opencode / codex / claude）的差异全部收敛在本目录的 Adapter 实现中；
 * launcher 与后续 bridge 只依赖本契约，不感知具体 CLI 参数。
 */
import { posix } from "node:path";
import type { AgentKind } from "../types.js";

/** 拉起一个项目 Agent（A2A 包装器）所需的上下文 */
export interface LaunchRequest {
  /** 项目标识（用于定位每项目包装器配置文件） */
  projectId: string;
  /** 项目 workspace（Agent 执行目录） */
  workspace: string;
  /** 该项目的 A2A Server 监听端口 */
  a2aPort: number;
  /** 已持久化的底层 CLI 会话 id；提供时随启动参数一并恢复上下文 */
  sessionId?: string;
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
}

/** 一条可执行的启动命令 */
export interface LaunchSpec {
  command: string;
  args: string[];
}

/** 任务风险档位（权限参数的唯一输入） */
export type PermissionRisk = "read" | "write" | "full";

/** 单个 agentKind 的完整适配面 */
export interface Adapter {
  readonly kind: AgentKind;
  /** 组装拉起 A2A 包装器的命令与参数（含 workspace/port，恢复时含 session 参数） */
  buildLaunch(request: LaunchRequest): LaunchSpec;
  /** 底层 CLI 的会话恢复参数（如 `--session <id>` / `resume <id>` / `--resume <id>`） */
  resumeArgs(sessionId: string): string[];
  /** 从一行 JSON/JSONL 输出中提取底层 CLI 会话 id */
  parseSessionId(line: string): string | undefined;
  /** 将任务风险映射为底层 CLI 的权限参数 */
  permissionArgs(risk: PermissionRisk): string[];
}

/**
 * 每项目 A2A 包装器配置文件路径（改造文档 §3.1：`agents/<agentKind>.<project>.json`）。
 * 统一使用 POSIX 分隔符，保证跨机（Windows/Mac）命令行参数一致。
 */
export function wrapperConfigPath(kind: AgentKind, projectId: string): string {
  return posix.join("agents", `${kind}.${projectId}.json`);
}
