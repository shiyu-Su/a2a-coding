/**
 * Agent 配置面快照（观测用）。
 *
 * 每次拉起 Agent（manager.start，含自检触发的启动）向 Launcher 日志报告：
 * 1. 配置获取层级：项目 agentConfig（渲染产物路径）+ 用户级配置层（按 kind 各异，
 *    claude 依生成的 settingSources 标注「已加载（路径）/未加载（隔离）」）；
 * 2. endpoint 与模型 id（配置面解析，值标注来源）。
 *
 * 注意：这是「配置面」解析，不是运行时确认——运行时权威模型 id 只在包装器
 * events（默认关闭）中，endpoint 不经 A2A 暴露；env 与用户配置文件并存且不同时
 * 都列出，优先级不猜测（claude 的 env vs settings 先后属「需实测」项）。
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

/** 包装器配置片段里的 model（agentConfig.<kind>.model） */
function agentConfigModel(project: ProjectConfig): string | null {
  const section = (project.agentConfig ?? {})[project.agentKind];
  if (typeof section !== "object" || section === null || Array.isArray(section)) return null;
  const model = (section as Record<string, unknown>)["model"];
  return typeof model === "string" && model.length > 0 ? model : null;
}

function envString(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * 模型 / endpoint 的配置面解析（值标注出处：agentConfig / env / settings）。
 * `userSettingsLoaded=false`（claude 隔离模式）时不读 settings——与运行时加载语义一致。
 */
export function resolveModelEndpoint(
  project: ProjectConfig,
  userSettingsLoaded: boolean,
): { model: string; endpoint: string } {
  const fromAgentConfig = agentConfigModel(project);
  switch (project.agentKind) {
    case "claude": {
      // 模型优先级（高→低）：agentConfig（→SDK --model）> env ANTHROPIC_MODEL > settings.model
      const settings = userSettingsLoaded
        ? readJsonIfExists(join(homedir(), ".claude", "settings.json"))
        : null;
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
  }
}

/** 配置获取层级：项目 agentConfig（渲染产物路径）+ 各 kind 的用户级配置层 */
function describeHierarchy(project: ProjectConfig, configPath: string): string {
  switch (project.agentKind) {
    case "claude": {
      // settingSources 由生成的包装器配置决定（baseConfig 默认 ["user"]，agentConfig 可覆盖）
      const settingSources = generatedSettingSources(configPath);
      const userPath = join(homedir(), ".claude", "settings.json");
      if (settingSources.includes("user")) {
        const exists = existsSync(userPath);
        return `项目 agentConfig（${configPath}）+ 用户级配置（${userPath}${exists ? "" : "，文件不存在"}）`;
      }
      return `项目 agentConfig（${configPath}）+ 用户级配置未加载（settingSources=${JSON.stringify(settingSources)}，隔离）`;
    }
    case "codex":
      return `项目 agentConfig（${configPath}）+ 用户级配置（~/.codex/config.toml，运行时始终读取）`;
    case "opencode":
      return `项目 agentConfig（${configPath}）+ 用户全局 opencode 配置与 workspace opencode.json（运行时读取）`;
  }
}

/** 读取生成的包装器配置里 claude 的 settingSources；缺失视为未加载（包装器内置默认隔离） */
function generatedSettingSources(configPath: string): string[] {
  const generated = readJsonIfExists(configPath);
  const claude = generated?.["claude"];
  const settingSources =
    claude !== null && typeof claude === "object" && !Array.isArray(claude)
      ? (claude as Record<string, unknown>)["settingSources"]
      : undefined;
  return Array.isArray(settingSources) ? settingSources.filter((s): s is string => typeof s === "string") : [];
}

/** 单次 Agent 启动的配置快照：配置层级 + endpoint / 模型 id */
export interface AgentConfigSnapshot {
  hierarchy: string;
  model: string;
  endpoint: string;
}

/** 汇总单次启动的配置面快照（launcher 与 self-check 共用）；快照遵循 settingSources 隔离语义 */
export function describeAgentConfig(project: ProjectConfig, configPath: string): AgentConfigSnapshot {
  const userSettingsLoaded =
    project.agentKind !== "claude" || generatedSettingSources(configPath).includes("user");
  return {
    hierarchy: describeHierarchy(project, configPath),
    ...resolveModelEndpoint(project, userSettingsLoaded),
  };
}
