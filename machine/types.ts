/**
 * machine 侧类型（部署单元 2：每台执行机器）。
 *
 * - 本机配置与运行态：launcher 直接依赖。
 * - 线协议类型（Bridge ⇄ Launcher HTTP）：按 option a 在两侧各自声明，
 *   orch 侧同名类型见 `src/orch/types.ts`，修改时需两侧同步。
 */

/** 执行层 Agent 类型（决定 A2A 包装器与 CLI 参数） */
export type AgentKind = "opencode" | "codex" | "claude";

/** 单台机器上的一个项目 */
export interface ProjectConfig {
  projectId: string;
  workspace: string;
  agentKind: AgentKind;
  /** 该项目的 A2A Server 监听端口 */
  a2aPort: number;
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
