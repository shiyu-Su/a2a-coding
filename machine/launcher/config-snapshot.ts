/**
 * Agent 配置面快照（观测用）。
 *
 * 每次拉起 Agent（manager.start，含自检触发的启动）向 Launcher 日志报告：
 * 1. 配置获取层级：项目 agentConfig（**平铺键**）+ 各 kind 的用户级配置层；
 * 2. endpoint 与模型 id（配置面解析，值标注来源）；
 * 3. v0.10.2 · M-4 起：`agentConfig.roles`（职责位映射）的**生效值**（F-C7 取证面）。
 *
 * v0.8.5 语义级重写（REQ-v0.8.5-2026-09-21-01 · M6，随 `agentConfig.<kind>` 段与
 * wrapper 配置通道退役）：
 * - 播报读点**四 kind 统一**为顶层平铺 `agentConfig.model`（段内 model 随段死）；
 * - claude 用户级配置层**直读** `~/.claude/settings.json` —— **存在即播报路径、
 *   不存在即 `n/a`**，不再由段键 `settingSources` 推断「是否加载用户配置」。
 *
 * 注意：这是「配置面」解析，不是运行时确认——运行时权威模型 id 只在后端报文里，
 * endpoint 不经 A2A 暴露；env 与用户配置文件并存且不同时都列出，优先级不猜测
 * （claude 的 env vs settings 先后属「需实测」项）。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectConfig } from "../types.js";
import {
  formatBackendProbe,
  resolveBackendEntry,
  type BackendEntryDeps,
} from "../adapters/backend-entry.js";
import {
  DEFAULT_MAX_CONCURRENT_READS,
  DEFAULT_MAX_CONCURRENT_WRITES,
  resolveContinueMarginMs,
  resolveMaxConcurrentReads,
  resolveMaxConcurrentWrites,
  resolveSessionRetentionDays,
  resolveSessionRetentionMax,
  resolveSessionTimeoutMs,
} from "./agent-config.js";
import {
  DEFAULT_SESSION_RETENTION_DAYS,
  DEFAULT_SESSION_RETENTION_MAX,
} from "../acp-bridge/session-map.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "../acp-bridge/acp/session.js";
import { describeRoleConfig, effectiveRiskOf, rolesOf } from "../agent-roles.js";
import { TASK_TYPES } from "../task-types.js";

/** 读取 JSON 文件；不存在或解析失败返回 null（快照尽力而为，不抛出） */
function readJsonIfExists(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * claude 用户级配置文件路径。**每次调用时求值**（不缓存）：`os.homedir()` 读
 * `HOME` / `USERPROFILE` ⇒ 单测可借它把用户目录重定向到临时目录，从而在**不碰真实
 * `~/.claude/settings.json`**（本节点只读纪律）的前提下覆盖「存在 / 不存在」两个分支。
 */
function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/**
 * 启动日志播报的 model 读点（REQ-v0.8.5-2026-09-21-01 · M6）：**四 kind 统一读
 * 顶层平铺** `agentConfig.model` —— 段内 `agentConfig.<kind>.model` 随段退役，
 * 不再被播报消费。
 */
function agentConfigModel(project: ProjectConfig): string | null {
  const model = (project.agentConfig ?? {})["model"];
  return typeof model === "string" && model.length > 0 ? model : null;
}

function envString(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * 模型 / endpoint 的配置面解析（值标注出处：agentConfig / env / settings）。
 *
 * v0.8.5：wrapper 配置通道退役 ⇒ **去 `userSettingsLoaded` 入参**；claude 分支**总是**
 * 直读 `~/.claude/settings.json`（文件不存在 ⇒ `readJsonIfExists` 返回 null，即 `n/a`）。
 */
export function resolveModelEndpoint(project: ProjectConfig): {
  model: string;
  endpoint: string;
} {
  const fromAgentConfig = agentConfigModel(project);
  switch (project.agentKind) {
    case "claude": {
      // 模型优先级（高→低）：agentConfig（→ ACP `set_config_option`）> env ANTHROPIC_MODEL > settings.model
      const settings = readJsonIfExists(claudeSettingsPath());
      const settingsModel =
        typeof settings?.["model"] === "string" ? (settings["model"] as string) : null;
      const settingsEnv = settings?.["env"];
      const settingsEnvRecord =
        typeof settingsEnv === "object" && settingsEnv !== null && !Array.isArray(settingsEnv)
          ? (settingsEnv as Record<string, unknown>)
          : null;
      const settingsBaseUrl =
        settingsEnvRecord !== null && typeof settingsEnvRecord["ANTHROPIC_BASE_URL"] === "string"
          ? (settingsEnvRecord["ANTHROPIC_BASE_URL"] as string)
          : null;
      const envModel = envString("ANTHROPIC_MODEL");
      const envBaseUrl = envString("ANTHROPIC_BASE_URL");

      const model =
        fromAgentConfig !== null
          ? `${fromAgentConfig}（agentConfig）`
          : envModel !== null
            ? `${envModel}（env）`
            : settingsModel !== null
              ? `${settingsModel}（settings）`
              : "未指定（CLI 默认）";
      const endpoint =
        envBaseUrl !== null && settingsBaseUrl !== null && envBaseUrl !== settingsBaseUrl
          ? `${envBaseUrl}（env）/ ${settingsBaseUrl}（settings）并存`
          : envBaseUrl !== null
            ? `${envBaseUrl}（env）`
            : settingsBaseUrl !== null
              ? `${settingsBaseUrl}（settings）`
              : "默认官方 API";
      return { model, endpoint };
    }
    case "codex": {
      const envBaseUrl = envString("OPENAI_BASE_URL");
      return {
        model:
          fromAgentConfig !== null ? `${fromAgentConfig}（agentConfig）` : "~/.codex/config.toml",
        endpoint: envBaseUrl !== null ? `${envBaseUrl}（env）` : "~/.codex/config.toml provider",
      };
    }
    case "opencode": {
      return {
        model: fromAgentConfig !== null ? `${fromAgentConfig}（agentConfig）` : "opencode 配置",
        endpoint: "opencode provider 配置",
      };
    }
    case "qoder-cn": {
      return {
        model:
          fromAgentConfig !== null ? `${fromAgentConfig}（agentConfig）` : "qodercn 配置（ACP）",
        endpoint: "qoder CN 服务端（经 ACP 桥）",
      };
    }
    default: {
      // 编译期安全网（改造文档 §2.3-4）：新增 kind ⇒ 此处 `project.agentKind` 不再是 never。
      const _exhaustive: never = project.agentKind;
      return { model: "未知 agentKind（中性兜底）", endpoint: "未指定（中性兜底）" };
    }
  }
}

/**
 * SessionMap 保留边界播报（v0.8.9 · M5）：值标注出处（agentConfig / 缺省），
 * 与派发通路（adapter ⇒ 桥 flag）同一读点（`resolveSessionRetention*`），口径不分叉。
 */
function describeSessionRetention(project: ProjectConfig): string {
  const days = resolveSessionRetentionDays(project.agentConfig);
  const max = resolveSessionRetentionMax(project.agentConfig);
  const daysText =
    days !== undefined
      ? `${String(days)}（agentConfig）`
      : `${String(DEFAULT_SESSION_RETENTION_DAYS)}（缺省）`;
  const maxText =
    max !== undefined
      ? `${String(max)}（agentConfig）`
      : `${String(DEFAULT_SESSION_RETENTION_MAX)}（缺省）`;
  return `sessionRetentionDays=${daysText} sessionRetentionMax=${maxText}`;
}

/**
 * 会话窗 / 续跑余量播报（v0.8.9 需求2 · M3）：值标注出处（agentConfig / 缺省），
 * 与派发通路同一读点（`resolveSessionTimeoutMs` / `resolveContinueMarginMs`），口径不分叉。
 * 补上「配了窗但日志看不到」的盲区，并把「续跑开没开」变成可观测运维事实。
 *
 * 余量缺省写作字面 0：其单一源是 `runner-exec.ts` 的 `DEFAULT_CONTINUE_MARGIN_MS`（缺省关闭），
 * 播报模块不引执行引擎（避免把整张派发依赖图拉进快照面）。
 *
 * `cancelQuiesceMs`（v0.8.10 · M-N4，v0.8.10 增补轨改口径）= 该项目**最近一次取消往返**的
 * 墙钟耗时：本机 loopback 的 `tasks/cancel`/`tasks/get` 到桥台账转终态为止，
 * **不反映后端是否真的停止计算**（桥侧 `session/cancel` 为 fire-and-forget、台账就地置终态）。
 * 与上面两个配置面键同处播报。**没有取值就不出该键**（缺键 ≠ 报 0）。
 */
function describeSessionWindow(project: ProjectConfig, cancelQuiesceMs?: number): string {
  const timeout = resolveSessionTimeoutMs(project.agentConfig);
  const margin = resolveContinueMarginMs(project.agentConfig);
  const timeoutText =
    timeout !== undefined
      ? `${String(timeout)}（agentConfig）`
      : `${String(DEFAULT_SESSION_TIMEOUT_MS)}（缺省）`;
  const marginText = margin !== undefined ? `${String(margin)}（agentConfig）` : "0（缺省）";
  const quiesceText =
    cancelQuiesceMs === undefined
      ? ""
      : ` cancelQuiesceMs=${String(cancelQuiesceMs)}（取消往返：桥台账转终态耗时，非后端静默）`;
  return `sessionTimeoutMs=${timeoutText} continueMarginMs=${marginText}${quiesceText}`;
}

/**
 * 两把并发闸上限播报（v0.8.10 · M-N5）：此前 `maxConcurrentWrites` / `maxConcurrentReads`
 * 是全仓唯一无任何回显面的配置键（闸只在 `DispatchGate` 内执法、类体无 logger，快照只有
 * in-flight/queued 计数）⇒「这台机这一项配了多少」只能靠并发行为反推。
 *
 * 值与出处与执法通路**同一读点**（`resolveMaxConcurrent*`，即 `effectiveGateLimits` 的组成），
 * 口径不分叉。**出处标注按「键配没配」判定而非「值是否等于缺省」** ⇒ 显式配 `1` 与缺省回落
 * 可区分（同 `continueMarginMs=0（agentConfig）` 的判据）。
 */
function describeGateLimits(project: ProjectConfig): string {
  const write = resolveMaxConcurrentWrites(project.agentConfig);
  const read = resolveMaxConcurrentReads(project.agentConfig);
  const writeText =
    write !== undefined
      ? `${String(write)}（agentConfig）`
      : `${String(DEFAULT_MAX_CONCURRENT_WRITES)}（缺省）`;
  const readText =
    read !== undefined
      ? `${String(read)}（agentConfig）`
      : `${String(DEFAULT_MAX_CONCURRENT_READS)}（缺省）`;
  return `并发闸：写上限=${writeText} 读上限=${readText}`;
}

/**
 * 职责位映射（`agentConfig.roles`）生效值播报（v0.10.2 · M-4 · F-C7 取证面）：
 * 逐角色列出该机该项目**配了什么**（`systemPrompt` 只报字符数、不落正文）。
 *
 * - **未配 `roles` ⇒ 省略该键**（照 `repo` 先例：缺键 ≠ 报空，老配置日志形状不变）；
 * - 上限取**本机生效 risk**（`project.risk ?? write`），与加载期校验②、自检面**同一读点**
 *   （`effectiveRiskOf`），口径不分叉；不读 orch 注册投影。
 * - 「配了的角色」按 `TASK_TYPES` 闭集序列出，**未配的角色不进播报正文**（回落平铺 / 构造器，
 *   逐位全清单在自检行里 —— 那边是「配没配都要看得见」，这里是「只报生效的覆盖」）。
 */
function describeRoles(project: ProjectConfig): string | undefined {
  const roles = rolesOf(project.agentConfig);
  if (roles === undefined) return undefined;
  const configured: string[] = [];
  for (const taskType of TASK_TYPES) {
    const role = roles[taskType];
    if (role === undefined) continue;
    configured.push(`${taskType}{${describeRoleConfig(role)}}`);
  }
  const body =
    configured.length > 0 ? configured.join(" ") : "无（配了空对象 ⇒ 全部回落平铺 / 构造器）";
  return `职责位 roles：上限 risk=${effectiveRiskOf(project)}｜${body}`;
}

/** 单次 Agent 启动的配置快照：配置层级 + endpoint / 模型 id + 后端入口分层解析结果 */
export interface AgentConfigSnapshot {
  hierarchy: string;
  model: string;
  endpoint: string;
  /**
   * SessionMap 保留边界（v0.8.9 · M5）：`sessionRetentionDays=… sessionRetentionMax=…`，
   * 值标注出处（agentConfig / 缺省）—— orch 据此可见「这台机该配了什么保留策略」。
   */
  sessionRetention: string;
  /**
   * 会话窗与续跑余量（v0.8.9 需求2 · M3）：`sessionTimeoutMs=… continueMarginMs=…`，
   * 值标注出处（agentConfig / 缺省）—— 「这台机开没开续跑」的运维查表面。
   * v0.8.10 · M-N4 起，有取消往返取值时同处再追
   * `cancelQuiesceMs=<往返耗时>（取消往返：桥台账转终态耗时，非后端静默）`。
   */
  sessionWindow: string;
  /**
   * 两把并发闸的生效上限（v0.8.10 · M-N5）：`并发闸：写上限=… 读上限=…`，
   * 值标注出处（agentConfig / 缺省）—— 「这台机这一项配了多少」的运维查表面。
   */
  gateLimits: string;
  /**
   * 仓库标识（v0.10.0 · M1）：项目配置 `repo` 生效时播报 `repo=<值>（agentConfig）`；
   * **未配置 ⇒ 省略该键**（`undefined`）—— 缺省 = 宿主仓的解释权归引擎，machine 只「配置了才上报」。
   */
  repo?: string;
  /**
   * 职责位映射生效值（v0.10.2 · M-4 · F-C7 取证面）：
   * `职责位 roles：上限 risk=…｜<taskType>{…} …`；
   * **未配 `roles` ⇒ 省略该键**（照 `repo` 先例，老配置日志形状不变）。
   */
  roles?: string;
  /**
   * 后端入口 `[backend]` 日志行正文（不含 `[backend]` 前缀，manager 打印时加）。
   * 命中：`<projectId> kind=<kind> <层名> hit <绝对路径>`；
   * 未命中：`<projectId> 解析失败，逐层清单：L0-explicit=miss(..) | ..`（清单入日志，不进 Error message）。
   */
  backend: string;
}

/**
 * 用户级配置层播报文案（配置获取层级的第二项；项目侧恒为平铺 `agentConfig`）。
 *
 * v0.8.5 · M6：退役 `describeHierarchy`（其 `configPath` 产物路径与 `settingSources`
 * 推断随 wrapper 配置通道一并退役）⇒ 收敛为「只描述用户级配置层」；claude 的判据
 * 改为**直读文件**：存在即播报路径，不存在即 `n/a`。
 */
function userConfigLayer(project: ProjectConfig): string {
  switch (project.agentKind) {
    case "claude": {
      const userPath = claudeSettingsPath();
      return existsSync(userPath)
        ? `claude 用户级配置（${userPath}）`
        : `claude 用户级配置 n/a（${userPath} 不存在）`;
    }
    case "codex":
      return "codex 用户级配置（~/.codex/config.toml，运行时始终读取）";
    case "opencode":
      return "opencode 用户级配置（全局配置与 workspace opencode.json，运行时读取）";
    case "qoder-cn":
      return "qodercn 用户级配置（~/.qoder-cn/，经 ACP 桥运行时读取）";
    default: {
      // 编译期安全网（改造文档 §2.3-4）：新增 kind ⇒ 此处 `project.agentKind` 不再是 never。
      const _exhaustive: never = project.agentKind;
      return "未知 agentKind 的用户级配置层（中性兜底）";
    }
  }
}

/**
 * 后端入口分层解析的 `[backend]` 日志正文（改造文档 §2.3；REQ-v0.8.6-...-02 · B4）。
 *
 * 复用 `describeAgentConfig` 这一「每次拉起都打」的读点 ⇒ 自检期 / 派发期 / 复用期
 * 经同一路径自动落 `launcher.log`，`self-check.ts` 零改动即携带该信息。
 * 命中（有 `command`）只报命中层；未命中则把解析器已扫的**全层清单**渲染进日志
 * （清单入日志、不进 Error message，规避 `singleLine()` 300 字符截断）。
 */
function describeBackend(project: ProjectConfig, deps?: BackendEntryDeps): string {
  const { command, probes } = resolveBackendEntry(project.agentKind, project.agentConfig, deps);
  if (command !== undefined) {
    const hit = probes.find((p) => p.status === "hit");
    const layer = hit?.layer ?? "hit";
    return `${project.projectId} kind=${project.agentKind} ${layer} hit ${command}`;
  }
  const clean = probes.map(formatBackendProbe).join(" | ");
  return `${project.projectId} 解析失败，逐层清单：${clean}`;
}

/**
 * 汇总单次启动的配置面快照（manager.start 播报用）。
 *
 * v0.8.5 · M6：**去 `configPath` 入参**（`agents/` 产物退役 ⇒ 无产物路径可播报），
 * `userSettingsLoaded` 随段键推断一并退役 ⇒ 快照 = 平铺 `agentConfig` + 用户级配置层
 * + 模型 / endpoint（claude 的用户级层按文件存在性直读判定）。
 * v0.8.6 · B4：追加 `backend` 段（后端入口分层解析结果，供 `[backend]` 日志行）。
 * v0.8.10 · M-N5：追加 `gateLimits` 段（两把并发闸的生效上限与出处）。
 * v0.10.2 · M-4：追加 `roles` 段（职责位映射生效值；未配 ⇒ 省略该键）。
 * `deps` 仅供注入式单测造「命中 / 全 miss」两例；运行期缺省走真机 fs。
 * `cancelQuiesceMs`（v0.8.10 · M-N4）= 该机该项目的取消往返耗时（本机 `tasks/cancel` →
 * `tasks/get` 到桥台账转终态，来自停事件账）；**不反映后端是否真的停止计算**。
 * 给出才播报、不给即省略该键。
 */
export function describeAgentConfig(
  project: ProjectConfig,
  deps?: BackendEntryDeps,
  cancelQuiesceMs?: number,
): AgentConfigSnapshot {
  const rolesLine = describeRoles(project);
  return {
    hierarchy: `项目 agentConfig（平铺键）+ ${userConfigLayer(project)}`,
    ...resolveModelEndpoint(project),
    sessionRetention: describeSessionRetention(project),
    sessionWindow: describeSessionWindow(project, cancelQuiesceMs),
    gateLimits: describeGateLimits(project),
    ...(project.repo !== undefined ? { repo: `repo=${project.repo}（agentConfig）` } : {}),
    ...(rolesLine !== undefined ? { roles: rolesLine } : {}),
    backend: describeBackend(project, deps),
  };
}
