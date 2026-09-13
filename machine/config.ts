import { readFileSync } from "node:fs";
import type { AgentKind, MachineConfig, ProjectConfig, RiskLevel } from "./types.js";

const AGENT_KINDS: readonly AgentKind[] = ["opencode", "codex", "claude"];

function fail(msg: string): never {
  throw new Error(`[config] ${msg}`);
}

function asRecord(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    fail(`${ctx} 必须是对象`);
  }
  return v as Record<string, unknown>;
}

function asString(v: unknown, ctx: string): string {
  if (typeof v !== "string" || v.length === 0) fail(`${ctx} 必须是非空字符串`);
  return v;
}

function asPort(v: unknown, ctx: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > 65535) {
    fail(`${ctx} 必须是 1-65535 的整数`);
  }
  return v;
}

function asIdleStopMs(v: unknown, ctx: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    fail(`${ctx} 必须是非负整数（0 = 禁用空闲回收）`);
  }
  return v;
}

function asBool(v: unknown, ctx: string): boolean {
  if (typeof v !== "boolean") fail(`${ctx} 必须是布尔值`);
  return v;
}

function asPositiveInt(v: unknown, ctx: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    fail(`${ctx} 必须是正整数`);
  }
  return v;
}

function asRiskLevel(v: unknown, ctx: string): RiskLevel {
  if (v !== "read" && v !== "write" && v !== "full") {
    fail(`${ctx} 必须是 read / write / full`);
  }
  return v;
}

function parseProject(v: unknown, idx: number): ProjectConfig {
  const o = asRecord(v, `projects[${idx}]`);
  const agentKind = asString(o["agentKind"], `projects[${idx}].agentKind`);
  if (!AGENT_KINDS.includes(agentKind as AgentKind)) {
    fail(`projects[${idx}].agentKind 必须是 ${AGENT_KINDS.join(" / ")}`);
  }
  const project: ProjectConfig = {
    projectId: asString(o["projectId"], `projects[${idx}].projectId`),
    workspace: asString(o["workspace"], `projects[${idx}].workspace`),
    agentKind: agentKind as AgentKind,
    a2aPort: asPort(o["a2aPort"], `projects[${idx}].a2aPort`),
  };
  const agentConfig = o["agentConfig"];
  if (agentConfig !== undefined) {
    // 包装器配置片段：必须是普通对象（非 null / 非数组）
    project.agentConfig = asRecord(agentConfig, `projects[${idx}].agentConfig`);
  }
  const risk = o["risk"];
  if (risk !== undefined) {
    // 任务风险档位：缺省不写（由 launcher 取 write），写了必须是三值之一
    project.risk = asRiskLevel(risk, `projects[${idx}].risk`);
  }
  return project;
}

/** 加载并校验「每机本地配置」 */
export function loadMachineConfig(path: string): MachineConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const o = asRecord(raw, "machine config");
  const launcher = asRecord(o["launcher"], "launcher");
  const projects = o["projects"];
  if (!Array.isArray(projects)) fail("projects 必须是数组");
  const parsed = projects.map(parseProject);
  const seen = new Set<string>();
  for (const p of parsed) {
    if (seen.has(p.projectId)) fail(`projectId 重复：${p.projectId}`);
    seen.add(p.projectId);
  }
  const launcherConfig: MachineConfig["launcher"] = {
    port: asPort(launcher["port"], "launcher.port"),
  };
  const idleStopMs = launcher["idleStopMs"];
  if (idleStopMs !== undefined) {
    launcherConfig.idleStopMs = asIdleStopMs(idleStopMs, "launcher.idleStopMs");
  }
  const startupCheck = launcher["startupCheck"];
  if (startupCheck !== undefined) {
    launcherConfig.startupCheck = asBool(startupCheck, "launcher.startupCheck");
  }
  const startupCheckTimeoutMs = launcher["startupCheckTimeoutMs"];
  if (startupCheckTimeoutMs !== undefined) {
    launcherConfig.startupCheckTimeoutMs = asPositiveInt(
      startupCheckTimeoutMs,
      "launcher.startupCheckTimeoutMs",
    );
  }
  const startupCheckPrompt = launcher["startupCheckPrompt"];
  if (startupCheckPrompt !== undefined) {
    launcherConfig.startupCheckPrompt = asString(
      startupCheckPrompt,
      "launcher.startupCheckPrompt",
    );
  }
  return {
    machineId: asString(o["machineId"], "machineId"),
    launcher: launcherConfig,
    projects: parsed,
  };
}
