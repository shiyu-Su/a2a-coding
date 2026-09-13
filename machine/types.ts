/**
 * machine 侧类型（部署单元 2：每台执行机器）。
 *
 * - 本机配置与运行态：launcher 直接依赖。
 * - 线协议类型（Bridge ⇄ Launcher HTTP）：按 option a 在两侧各自声明，
 *   orch 侧同名类型见 `src/orch/types.ts`，修改时需两侧同步。
 */

/** 执行层 Agent 类型（决定 A2A 包装器与 CLI 参数） */
export type AgentKind = "opencode" | "codex" | "claude";

/** 任务风险档位：由适配器映射为各 CLI 的权限 / 沙箱参数 */
export type RiskLevel = "read" | "write" | "full";

/** 单台机器上的一个项目 */
export interface ProjectConfig {
  projectId: string;
  workspace: string;
  agentKind: AgentKind;
  /** 该项目的 A2A Server 监听端口 */
  a2aPort: number;
  /**
   * 任务风险档位（可选）：由适配器 `permission(risk)` 映射为各 CLI 权限 / 沙箱参数。
   * 缺省写入档 `write`（= 三端包装器内置默认，保证现有 opencode 项目行为不变）。
   */
  risk?: RiskLevel;
  /**
   * 包装器配置片段（顶层键如 `opencode` / `mcp` / `events` / `systemPrompt`）。
   * 由 launcher 生成到 `agents/<agentKind>.<projectId>.json`，经 `--config` 传给包装器，
   * 与其内置默认值深合并；未提供时仅写入默认覆盖项（关闭 events）。
   */
  agentConfig?: Record<string, unknown>;
}

/** 每台机器的本地配置（每机自维护，Q2） */
export interface MachineConfig {
  machineId: string;
  launcher: {
    port: number;
    /**
     * 空闲回收（用完退出）：项目 Agent 超过该毫秒数无 `ensure` 调用即自动 stop。
     * 缺省 300000（5 分钟）；`0` 表示禁用自动回收。
     */
    idleStopMs?: number;
    /**
     * 启动自检：Launcher 启动时对本机全部项目逐个 ensure → 发送一条真实最小任务
     * → 校验（completed 且响应非空）→ stop。任一失败即退出（fail-fast），
     * 避免「机器看似起来、一用就废」。缺省 `true`；`false` 跳过自检。
     */
    startupCheck?: boolean;
    /** 每个项目自检的总超时（毫秒，覆盖 ensure / 发送 / 轮询全程）；缺省 120000 */
    startupCheckTimeoutMs?: number;
    /** 自检发送的最小任务 prompt；缺省内置极短串（最小化 token 消耗） */
    startupCheckPrompt?: string;
  };
  projects: ProjectConfig[];
}

/** 运行时状态 */
export type AgentStatus = "online" | "offline";

/** 项目 + 运行态（GET /projects 返回） */
export interface ProjectStatus extends ProjectConfig {
  status: AgentStatus;
  endpoint: string | null;
  startedAt: string | null;
}

/** POST /projects/{id}/ensure 返回 */
export interface EnsureResult {
  projectId: string;
  endpoint: string;
  /** true=本次新启动；false=已在运行、直接复用 */
  started: boolean;
}

/** POST /projects/{id}/stop 返回 */
export interface StopResult {
  projectId: string;
  stopped: boolean;
}

/** 统一错误外壳（对外 HTTP / 工具返回） */
export interface ApiError {
  code: string;
  message: string;
}
