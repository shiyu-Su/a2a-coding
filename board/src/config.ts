/**
 * board 配置加载器（BD12″ · v0.9.0）—— 配置**只从文件读**，argv / env 不再承载任何配置内容。
 *
 * 蓝本 = `orch/config` 与 `machine/config` 的同构约定（宿主已取证）：
 * - **两个文件**：`config/config.json.default`（入库模板，`_comment` 族键逐项标注语义/缺省/fail-fast）
 *   + `config/config.json`（活配置，gitignored）；两者之间**无自动复制/回退**（模板只是给人 `cp` 的）；
 * - **注释键约定** = 下划线开头的普通 JSON 键，加载器天然忽略；约定「注释留在模板、活配置勿拷贝」；
 * - **启动期读一次**（main 里调用 {@link loadConfig}）⇒ 热改不生效、须重启；
 * - **非法值统一 `[config] <字段路径> …` 中文错误 + 对策，fail-fast 不静默降级**；
 * - **env 只覆盖「配置文件路径」**：`BOARD_CONFIG`；**无 argv 覆盖配置内容**（用户裁定：「而非启动参数」）。
 *
 * 缺省值口径与 BD12″ 之前逐项一致（只挪通道、不改语义）：
 * `port` 3400 · `host` 127.0.0.1（loopback 守卫仍在 `server.assertLoopbackHost`）·
 * `orgsDir` **无缺省**（留空 = 未配置 ⇒ 宿主面不装配，§3.8 裁定 9 严禁回落）·
 * `group` **可选默认**（缺失不报错，BD11 形态：表单 > 默认，皆无 ⇒ 请求期 400）·
 * `hostKind` `claude` · `bridgeUrl` `http://127.0.0.1:3300` · `mcpBaseUrl` `http://127.0.0.1:8787` ·
 * `machineDist` 按仓根推导（`<仓根>/machine/dist`）· `repoRoot` 缺省 = 板根上一级（BD10 读文档面）·
 * `turnTimeoutMs` 未配 ⇒ 交 BD4b 缺省。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BRIDGE_BASE_URL } from "./bridge-client.js";
import { DEFAULT_MCP_BASE_URL } from "./requirement.js";
import { DEFAULT_HOST_AGENT_KIND } from "./host-bridge.js";
import { resolveMachineDistDir } from "./host-runtime.js";
import { defaultRepoRoot } from "./docs-read.js";

export const DEFAULT_PORT = 3400;
export const DEFAULT_HOST = "127.0.0.1";

/** 唯一保留的 env 通道：只覆盖**配置文件路径**，不承载配置内容。 */
export const CONFIG_PATH_ENV = "BOARD_CONFIG";

/** 模板文件名（缺配置时的错误文案指向它，提示 `cp`）。 */
export const CONFIG_TEMPLATE_NAME = "config.json.default";

export interface BoardConfig {
  /** 实际读取的配置文件路径（启动横幅回显「配置来源」）。 */
  readonly sourcePath: string;
  readonly port: number;
  readonly host: string;
  /** 组织目录根：**无缺省**；`null` = 未配置 ⇒ 宿主面不装配（不是错误）。 */
  readonly orgsDir: string | null;
  /** 板级默认组织：**可选默认**；`null` = 未配置（BD11 起不是错误，表单留空才请求期 400）。 */
  readonly group: string | null;
  readonly hostKind: string;
  readonly bridgeUrl: string;
  readonly mcpBaseUrl: string;
  readonly machineDist: string;
  /** 主仓根（BD10 读文档面源 A 的锚点）：配置键 `repoRoot` 缺省 = 板根上一级（恒有值，非 null）。 */
  readonly repoRoot: string;
  /** 单轮有界等待毫秒；`null` = 未配置 ⇒ 交下游 `DEFAULT_TURN_TIMEOUT_MS`。 */
  readonly turnTimeoutMs: number | null;
}

/** 缺省配置文件落点：`<board>/config/config.json`（源码与 `dist/` 运行都落到同一处）。 */
export function defaultConfigPath(metaUrl: string = import.meta.url): string {
  // dist/config.js → <board>/config/config.json
  return resolve(dirname(fileURLToPath(metaUrl)), "..", "config", "config.json");
}

/** 配置文件路径解析：`BOARD_CONFIG` env（仅路径）> 仓内缺省。空白按未设置算。 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  metaUrl: string = import.meta.url,
): string {
  const fromEnv = env[CONFIG_PATH_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return resolve(fromEnv.trim());
  return defaultConfigPath(metaUrl);
}

/** `[config]` 前缀 = 全部配置错误的统一口径（结构化、不静默降级）。 */
function configError(field: string, problem: string, remedy: string): Error {
  return new Error(`[config] ${field} ${problem} —— 对策：${remedy}`);
}

/** 可选字符串键：未配置（键缺失 / 空串 / 纯空白）⇒ `null`；类型错 ⇒ fail-fast。 */
function optString(raw: Record<string, unknown>, key: string): string | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    throw configError(key, `必须是字符串（收到 ${JSON.stringify(v)}）`, `改 ${key} 为字符串，或整键删除用缺省值`);
  }
  const t = v.trim();
  return t === "" ? null : t;
}

function requireUrl(raw: string, key: string): string {
  let ok = false;
  try {
    const u = new URL(raw);
    ok = (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    ok = false;
  }
  if (!ok) {
    throw configError(key, `必须是含主机的 http(s):// 绝对地址（收到 "${raw}"）`, `如 http://127.0.0.1:3300；或整键删除用缺省值`);
  }
  return raw;
}

/**
 * 解析 + 校验（纯函数，供单测直接喂对象）。`_` 前缀注释键与**未知键一律忽略**；
 * 任一字段非法 ⇒ 抛 `[config] <字段路径> …`（不静默降级、不部分生效）。
 */
export function validateConfig(parsed: unknown, sourcePath: string): BoardConfig {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configError("(root)", `配置文件顶层必须是 JSON 对象（收到 ${Array.isArray(parsed) ? "数组" : parsed === null ? "null" : typeof parsed}）`, `照 ${CONFIG_TEMPLATE_NAME} 的结构修正 ${sourcePath}`);
  }
  const raw = parsed as Record<string, unknown>;

  let port = DEFAULT_PORT;
  if (raw.port !== undefined && raw.port !== null) {
    if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
      throw configError("port", `必须是 1–65535 的整数（收到 ${JSON.stringify(raw.port)}）`, `改 port 为整数端口，或整键删除用缺省 ${DEFAULT_PORT}`);
    }
    port = raw.port;
  }

  const host = optString(raw, "host") ?? DEFAULT_HOST;
  const hostKind = optString(raw, "hostKind") ?? DEFAULT_HOST_AGENT_KIND;
  const bridgeUrl = requireUrl(optString(raw, "bridgeUrl") ?? DEFAULT_BRIDGE_BASE_URL, "bridgeUrl");
  const mcpBaseUrl = requireUrl(optString(raw, "mcpBaseUrl") ?? DEFAULT_MCP_BASE_URL, "mcpBaseUrl");

  // orgsDir / group：**无缺省兜底可言** —— 留空 = 未配置（各自的「未配置语义」由消费方承担）。
  const orgsDirRaw = optString(raw, "orgsDir");
  const orgsDir = orgsDirRaw === null ? null : resolve(orgsDirRaw);
  const group = optString(raw, "group");

  const machineDistRaw = optString(raw, "machineDist");
  // 恒给出显式值 ⇒ 启动路径不再经 host-runtime 的 BOARD_MACHINE_DIST 兜底（旧 env 通道随之失效）。
  const machineDist = machineDistRaw ?? resolveMachineDistDir({});

  // repoRoot（BD10）：读文档面源 A 的锚点，缺省 = 板根上一级；目录可不存在（列目录时按空清单降级）。
  const repoRootRaw = optString(raw, "repoRoot");
  const repoRoot = repoRootRaw === null ? defaultRepoRoot() : resolve(repoRootRaw);

  let turnTimeoutMs: number | null = null;
  if (raw.turnTimeoutMs !== undefined && raw.turnTimeoutMs !== null) {
    const v = raw.turnTimeoutMs;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw configError("turnTimeoutMs", `必须是正整数毫秒（收到 ${JSON.stringify(v)}）`, "改 turnTimeoutMs 为正整数，或整键删除交下游缺省（10 min）");
    }
    turnTimeoutMs = v;
  }

  return { sourcePath, port, host, orgsDir, group, hostKind, bridgeUrl, mcpBaseUrl, machineDist, repoRoot, turnTimeoutMs };
}

/**
 * 启动期读一次。**缺文件不裸崩**：给明确文案并提示从模板复制；坏 JSON / 非法值同走 `[config]` 口径。
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  metaUrl: string = import.meta.url,
): BoardConfig {
  const path = resolveConfigPath(env, metaUrl);
  let rawText: string;
  try {
    rawText = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw configError(
        "(file)",
        `配置文件不存在：${path}`,
        `从模板复制一份再按需修改：cp "${join(dirname(path), CONFIG_TEMPLATE_NAME)}" "${path}"（或设 env ${CONFIG_PATH_ENV} 指向配置文件）`,
      );
    }
    throw configError("(file)", `配置文件读取失败：${path}（${err instanceof Error ? err.message : String(err)}）`, "检查文件权限与路径");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw configError(
      "(json)",
      `配置文件不是合法 JSON：${path}（${err instanceof Error ? err.message : String(err)}）`,
      `对照 ${CONFIG_TEMPLATE_NAME} 检查引号/逗号（模板仅供照抄、不参与加载）`,
    );
  }
  return validateConfig(parsed, path);
}
