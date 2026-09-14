/**
 * 清理 `agents/` 下不属于当前 `projects[]` 的过期包装器配置（REQ-v0.2.0-2026-09-13-05）。
 *
 * `writeAgentConfig` 每次启动覆盖生成 `agents/<agentKind>.<projectId>.json`，项目从
 * `projects[]` 移除后旧文件残留。Launcher 启动时以当前 `projects[]` 的期望文件名集合为
 * 白名单，删除符合命名模式但不在白名单的过期文件。
 *
 * 仅删匹配 `^(opencode|codex|claude)\..+\.json$` 的文件；目录不存在 / 单文件删除失败均
 * 不抛出（尽力而为），避免影响 Launcher 启动。
 */
import { readdirSync, unlinkSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "../types.js";

/** 清理结果：被删文件名 + 白名单（保留）数量 */
export interface PruneResult {
  removed: string[];
  kept: number;
}

/** 包装器配置文件名模式：`<agentKind>.<projectId>.json` */
const AGENT_CONFIG_RE = /^(opencode|codex|claude)\..+\.json$/;

/**
 * 删除 `agents/` 下不属于当前 `projects[]` 的过期包装器配置。
 * 目录不存在时返回空结果；单文件删除失败跳过，不抛未捕获异常。
 */
export function pruneStaleAgentConfigs(
  appRoot: string,
  projects: readonly ProjectConfig[],
): PruneResult {
  const dir = join(appRoot, "agents");
  const allowed = new Set(projects.map((p) => `${p.agentKind}.${p.projectId}.json`));

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 目录不存在（尚无项目拉起）或不可读：视为无过期项
    return { removed: [], kept: allowed.size };
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !AGENT_CONFIG_RE.test(entry.name) || allowed.has(entry.name)) {
      continue;
    }
    try {
      unlinkSync(join(dir, entry.name));
      removed.push(entry.name);
    } catch {
      // 单文件删除失败（占用 / 权限）不阻塞其余清理
    }
  }
  return { removed, kept: allowed.size };
}
