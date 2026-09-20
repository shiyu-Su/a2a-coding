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
   * launcher 生成的包装器配置文件绝对路径。
   * 提供时经 `--config` 传给包装器；缺省时回退到 `wrapperConfigPath(kind, projectId)`。
   */
  configPath?: string;
  /** 权限参数（launcher 传入 `permission(risk).args`，追加在基础参数之后） */
  permissionArgs?: string[];
  /**
   * 项目 `agentConfig`（本项目实际生效的配置片段，来源 = `ProjectConfig.agentConfig`，与
   * `writeAgentConfig` / `baseConfig` 同一来源与命名惯例）。
   * ACP 族（qoder）适配器据此读取**顶层平铺键** `agentConfig.backendCmd`（必填）作为后端命令；
   * wrapper 族忽略本字段。
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
  /**
   * 启动协议维度（改造文档 §2.2/§2.3）。
   * - `"wrapper"`：经仓外 `a2a-<kind>` 包装器拉起（现存 codex / claude 两家）；
   * - `"acp"`：经仓内通用 ACP 接缝拉起（`machine/acp-bridge/`，qoder / opencode 两家）。
   */
  readonly protocol: "wrapper" | "acp";
  /** 组装拉起 A2A 包装器的命令与参数（含 workspace / port / 权限参数） */
  buildLaunch(request: LaunchRequest): LaunchSpec;
  /** 将任务风险映射为权限参数 + 可选配置补丁 */
  permission(risk: PermissionRisk): PermissionSpec;
  /** 该 kind 的默认包装器配置覆盖项（与 DEFAULT_AGENT_CONFIG 先合并） */
  baseConfig(): Record<string, unknown>;
}

/**
 * ACP 族 adapter 契约（**占位**，REQ-v0.8.0-2026-09-18-01 改造文档 §2.2/§2.3）。
 *
 * 仅**类型 / 接口占位**：声明「以 ACP 作为启动协议」的 kind 的形状 —— `protocol:"acp"`
 * 加命令 / 参数 / 认证等启动要素。当前**无实现类、不注册进 `ADAPTERS`**（三家均为
 * `"wrapper"` 族）；未来接入 ACP kind 时以此接口为实现落点。
 *
 * 归属说明：本契约属**执行层适配接缝**，不在 `PROTOCOL.md`（Runner ⇄ Bridge 线协议）
 * 定义域内；契约文档随本注释落在 machine 侧。
 */
export interface AcpAdapter {
  readonly kind: AgentKind;
  readonly protocol: "acp";
  /** 拉起 ACP 后端进程的可执行命令（未来落点，如通用 `a2a-acp` 桥） */
  readonly command: string;
  /** 命令基础参数（不含认证；认证经 `auth` 注入） */
  readonly args?: readonly string[];
  /** 认证要素：凭据如何注入（形状待真正接入 ACP 时定稿） */
  readonly auth?: {
    /** 承载凭据的环境变量名 */
    readonly envVar: string;
    /** 凭据来源：进程环境 / 配置文件 */
    readonly source: "env" | "config";
  };
}

/**
 * 每项目 A2A 包装器配置文件路径（改造文档 §3.1：`agents/<agentKind>.<project>.json`）。
 * 统一使用 POSIX 分隔符，保证跨机（Windows/Mac）命令行参数一致。
 */
export function wrapperConfigPath(kind: AgentKind, projectId: string): string {
  return posix.join("agents", `${kind}.${projectId}.json`);
}
