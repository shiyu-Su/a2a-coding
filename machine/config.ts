import { readFileSync } from "node:fs";
import { AGENT_KINDS } from "./agent-kinds.js";
import {
  effectiveSessionTimeoutMs,
  SESSION_TIMEOUT_MS_CAP,
} from "./launcher/agent-config.js";
import type { AgentKind, BridgeConfig, MachineConfig, ProjectConfig, RiskLevel } from "./types.js";

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

/** 解析 `launcher.bridge`：整段可选，但一旦存在则 `url` / `token` 均为必填非空串 */
function asBridge(v: unknown, ctx: string): BridgeConfig {
  const o = asRecord(v, ctx);
  return {
    url: asString(o["url"], `${ctx}.url`),
    token: asString(o["token"], `${ctx}.token`),
  };
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
    const sessionTimeoutMs = project.agentConfig["sessionTimeoutMs"];
    if (sessionTimeoutMs !== undefined) {
      // v0.8.7 · M2：session 超时上限护栏（加载期 fail-fast，单一源 = agent-config 的 CAP 常量）。
      // 超限/非法若不在此拦截，会一路透传到桥 flag，拉长该项目台账寿命且与 dispatch deadline 脱钩。
      if (
        typeof sessionTimeoutMs !== "number" ||
        !Number.isInteger(sessionTimeoutMs) ||
        sessionTimeoutMs <= 0 ||
        sessionTimeoutMs > SESSION_TIMEOUT_MS_CAP
      ) {
        fail(
          `projects[${idx}].agentConfig.sessionTimeoutMs 必须是 1-${SESSION_TIMEOUT_MS_CAP} 的整数（毫秒，上限 10 min）`,
        );
      }
    }
    // v0.8.9 需求2 · M3：续跑余量键（非负整数，0 合法 = 显式关闭）。
    // 上限不是全局 CAP，而是**本项目生效窗**（M1 的 effectiveSessionTimeoutMs：显式窗 ?? 桥缺省）
    // —— 余量封顶于窗，保证「续跑轮额度 = min(余量, 生效窗)」不因配置组合越出预算公式。
    const continueMarginMs = project.agentConfig["continueMarginMs"];
    if (continueMarginMs !== undefined) {
      if (
        typeof continueMarginMs !== "number" ||
        !Number.isInteger(continueMarginMs) ||
        continueMarginMs < 0
      ) {
        fail(
          `projects[${idx}].agentConfig.continueMarginMs 必须是非负整数（毫秒，0 = 关闭续跑）`,
        );
      }
      const windowMs = effectiveSessionTimeoutMs(project.agentConfig);
      const windowSource =
        project.agentConfig["sessionTimeoutMs"] === undefined
          ? "桥缺省"
          : "agentConfig.sessionTimeoutMs";
      if (continueMarginMs > windowMs) {
        fail(
          `projects[${idx}].agentConfig.continueMarginMs 必须是 0-${String(windowMs)} 的整数（毫秒，上限 = 生效会话窗 ${String(windowMs)}，出处=${windowSource}）`,
        );
      }
    }
    // v0.8.9 · M5：SessionMap 保留边界两键（正整数即可，无上限语义；与 sessionTimeoutMs 独立）。
    for (const key of ["sessionRetentionDays", "sessionRetentionMax"] as const) {
      const value = project.agentConfig[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        fail(`projects[${idx}].agentConfig.${key} 必须是正整数`);
      }
    }
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
    launcherConfig.startupCheckPrompt = asString(startupCheckPrompt, "launcher.startupCheckPrompt");
  }
  const listenHost = launcher["listenHost"];
  if (listenHost !== undefined) {
    // 可选绑定地址；缺省不写 → 保持现有绑定行为（绑全部网卡）
    launcherConfig.listenHost = asString(listenHost, "launcher.listenHost");
  }
  const shutdownEndpoint = launcher["shutdownEndpoint"];
  if (shutdownEndpoint !== undefined) {
    launcherConfig.shutdownEndpoint = asBool(shutdownEndpoint, "launcher.shutdownEndpoint");
  }
  const shutdownToken = launcher["shutdownToken"];
  if (shutdownToken !== undefined) {
    launcherConfig.shutdownToken = asString(shutdownToken, "launcher.shutdownToken");
  }
  const bridge = launcher["bridge"];
  if (bridge !== undefined) {
    // 缺省整段不写 = 不启用 Runner 出站（现状行为）；写了就必须 url + token 齐全
    launcherConfig.bridge = asBridge(bridge, "launcher.bridge");
  }
  return {
    machineId: asString(o["machineId"], "machineId"),
    launcher: launcherConfig,
    projects: parsed,
  };
}
