/**
 * Agent 配置面快照（观测用）。
 *
 * 每次拉起 Agent（manager.start，含自检触发的启动）向 Launcher 日志报告：
 * 1. 配置获取层级：项目 agentConfig（**平铺键**）+ 各 kind 的用户级配置层；
 * 2. endpoint 与模型 id（配置面解析，值标注来源）。
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
    case "qoder": {
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

/** 单次 Agent 启动的配置快照：配置层级 + endpoint / 模型 id */
export interface AgentConfigSnapshot {
  hierarchy: string;
  model: string;
  endpoint: string;
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
    case "qoder":
      return "qodercn 用户级配置（~/.qoder-cn/，经 ACP 桥运行时读取）";
    default: {
      // 编译期安全网（改造文档 §2.3-4）：新增 kind ⇒ 此处 `project.agentKind` 不再是 never。
      const _exhaustive: never = project.agentKind;
      return "未知 agentKind 的用户级配置层（中性兜底）";
    }
  }
}

/**
 * 汇总单次启动的配置面快照（manager.start 播报用）。
 *
 * v0.8.5 · M6：**去 `configPath` 入参**（`agents/` 产物退役 ⇒ 无产物路径可播报），
 * `userSettingsLoaded` 随段键推断一并退役 ⇒ 快照 = 平铺 `agentConfig` + 用户级配置层
 * + 模型 / endpoint（claude 的用户级层按文件存在性直读判定）。
 */
export function describeAgentConfig(project: ProjectConfig): AgentConfigSnapshot {
  return {
    hierarchy: `项目 agentConfig（平铺键）+ ${userConfigLayer(project)}`,
    ...resolveModelEndpoint(project),
  };
}
