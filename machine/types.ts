/**
 * machine 侧类型（部署单元 2：每台执行机器）。
 *
 * - 本机配置与运行态：launcher 直接依赖。
 * - 线协议类型（Bridge ⇄ Launcher HTTP）：按 option a 在两侧各自声明，
 *   orch 侧同名类型见 `orch/types.ts`，修改时需两侧同步。
 */
import type { AgentKind } from "./agent-kinds.js";

/**
 * Bridge ⇄ Launcher 线协议版本（单一事实源：仓库根 PROTOCOL.md；orch 侧同名常量见
 * orch/types.ts，修改需两侧同步并由契约测试锁定）。
 * 规则：加可选字段 minor+1；删字段 / 改语义 / 加必填请求体 major+1；
 *      必填字段的取值集合扩展 minor+1。
 * v0.7.0：major 由 1.0 升到 2.0（删字段 / 改语义 / 加必填请求体的破坏性变更）。
 * v0.8.0：minor 升到 2.1（`projects[].agentKind` 必填字段取值集合扩展 +qoder，非破坏）。
 * req03 硬切：minor 升到 2.2（`projects[].agentKind` 必填字段取值 `qoder` 更名为 `qoder-cn`）。
 * v0.8.8：minor 升到 2.3（`failureKind` 必填字段取值集合**成员移除** —— 六类闭集硬切：旧值
 *      `infra` / `task` 自 2.3 起非法，但仍可被接收 ⇒ 接收端兜底落 `business` 并 warn 留原值
 *      ⇒ 与上述两次「扩展 / 更名」不同，本次是**单方不兼容**，orch 与 machine **两侧同升**
 *      （混跑期未升级侧上报的旧值只会被兜底归类，不会被拒收）。
 */
export const PROTOCOL_VERSION = "2.3";

/**
 * 执行层 Agent 类型（决定执行层适配器与 CLI 参数）。
 * 取值集合单一事实源 = `./agent-kinds.js`（本模块仅 re-export，既有 import 站点不变）。
 */
export type { AgentKind };

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
   * 任务风险档位（可选）：由适配器 `permission(risk)` 映射为 ACP 会话模式 / 权限门档位
   * （v0.8.5 起四 kind 同构；codex 的 read 档另加 `--collaboration-mode plan`）。
   * 缺省写入档 `write`（= 执行层适配器内置默认，保证既有项目行为不变）。
   */
  risk?: RiskLevel;
  /**
   * 项目 agentConfig（键位口径 = **自消费键顶层平铺**；`agentConfig.<kind>` 段已整体退役，
   * v0.8.5 · M4 起为**唯一**口径）。
   *
   * **具备平铺读点的键**（读者 = machine 代码 / 仓内 ACP 桥）：
   * - `backendCmd` —— ACP 适配器入口，**可选覆盖**（v0.8.6 起缺省由 `adapters/backend-entry.ts`
   *   四层链自动解析，见 REQ-v0.8.6-2026-09-21-02；写了则以显式值为准，可指向非标准位置的自建适配器）：
   *   脚本形态（`.js` / `.mjs` / `.cjs`）⇒ 适配器自动以 `process.execPath` + 脚本路径拉起；
   *   可执行体形态（`.exe`）⇒ 直调（形态归一见 `adapters/backend-command.ts`）；
   * - `model` —— 非必填，适配器读出后经 `--model` 透传给 ACP 桥（协议面 set，不校验、不映射）；
   * - `systemPrompt` / `systemPromptMode` —— 非必填，自定义注入经 `--system-prompt` /
   *   `--system-prompt-mode` 透传（缺省 `append`）。
   *
   * **段键（`<kind>` 段）已退役**：段内键不再被任何人消费（写了无效、也不再告警）—— 其读者
   * （`writeAgentConfig` / `agents/` 产物 / `--config-file` / `--config-segment`）随段一并删除。
   * **「保留」≠ 提供读点**：命名空间保留键清单见 `./agent-kinds.ts` 的
   * `RESERVED_AGENT_CONFIG_FLAT_KEYS`（保留只占命名空间，不等于该键已有平铺读点）。
   */
  agentConfig?: Record<string, unknown>;
}

/**
 * Runner 出站桥配置（v0.7.0 Phase A 影子注册）。
 *
 * `url` 与 `token` **同时给出**才启用 Runner 出站循环；`launcher.bridge` 整段缺省
 * = 不启动 Runner 出站 = 现状行为（零出站）。占位符写入 `config.json.default`
 * 由 machine 阶段 C 文档节点负责，本节点仅解析。
 */
export interface BridgeConfig {
  /** 桥的基址（如 `http://127.0.0.1:3200`）；Runner 在其上拼 `/runner/register`、`/runner/connect` */
  url: string;
  /** per-machine 静态 Bearer token（与 orch 侧 `machines[].token` 对应） */
  token: string;
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
    /**
     * Launcher 监听地址（可选）。**缺省不设置 = 交由 Node 绑定全部网卡**（保持 v0.2.0
     * 现状，避免跨机直连回归）。启用 `shutdownEndpoint` 时建议设为 `127.0.0.1`。
     */
    listenHost?: string;
    /**
     * 优雅停止端点 `POST /shutdown`：缺省 `false`（不注册）。启用后仅接受 loopback
     * 来源；反代转发会使源地址变为 loopback，故 Caddy / 反向代理必须 deny `/shutdown`。
     */
    shutdownEndpoint?: boolean;
    /** `POST /shutdown` 可选 Bearer 令牌；缺省不校验（配合 loopback 收窄使用） */
    shutdownToken?: string;
    /**
     * Runner 出站桥（v0.7.0 Phase A 影子注册）。缺省不写 = **不启动 Runner 出站**
     * （现状行为、零出站）；同时给出 `url` 与 `token` 才启用。
     */
    bridge?: BridgeConfig;
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

/**
 * 子进程账本条目：**Launcher 本地文件**，一进程一文件落
 * `<machine 根>/.a2a/children/<pid>.json`（与 `.a2a/logs`、`.a2a/launcher.pid` 同族）。
 *
 * 用途：启动时对账清理 + `machine/scripts/reaper.mjs` 的孤儿判定数据源。
 * **非线协议**：不得并入 `ProjectStatus`（不变量：不加协议 `pid`）。
 */
export interface ChildLedgerEntry {
  /** 子进程 pid（账本文件名即 `<pid>.json`） */
  pid: number;
  /** 所属项目（机器配置中的 projectId） */
  projectId: string;
  /** wrapper = A2A 包装器 / ACP 桥（v0.8.1 起 `"serve"` 随 opencode serve 退役，旧磁盘条目由对账按 pid 处理、kind 无关） */
  kind: "wrapper";
  /** 启动时刻（UTC ISO 8601） */
  startedAt: string;
  /** 诊断用启动命令行（可选；不含环境变量；敏感 argv 取值经脱敏，如 `--session-meta-json` ⇒ `<redacted>`） */
  command?: string;
}

/** 统一错误外壳（对外 HTTP / 工具返回） */
export interface ApiError {
  code: string;
  message: string;
}
