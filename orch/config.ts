import { readFileSync } from "node:fs";
import type {
  CallbackConfig,
  HttpTransportConfig,
  MachineRef,
  MachinesConfig,
  ProjectGroup,
  ProjectMember,
  RunnerConfig,
  TransportConfig,
  TransportMode,
  WebConfig,
} from "./types.js";

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

function asBool(v: unknown, ctx: string): boolean {
  if (typeof v !== "boolean") fail(`${ctx} 必须是布尔值`);
  return v;
}

function asPort(v: unknown, ctx: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
    fail(`${ctx} 必须是 1-65535 的整数`);
  }
  return v;
}

function asTransportMode(v: unknown, ctx: string): TransportMode {
  if (v !== "stdio" && v !== "http") fail(`${ctx} 必须是 "stdio" 或 "http"`);
  return v;
}

function asHttpPath(v: unknown, ctx: string): string {
  const s = asString(v, ctx);
  if (!s.startsWith("/")) fail(`${ctx} 必须以 "/" 开头`);
  return s;
}

/** 回调端点默认绑定 loopback / 默认端口（避开 Launcher 3100 与项目 A2A 3010-3012） */
const DEFAULT_CALLBACK_HOST = "127.0.0.1";
const DEFAULT_CALLBACK_PORT = 3200;

/** 解析 `callback` 配置（缺省字段补默认值；`enabled` 缺省 false） */
function parseCallback(v: unknown): CallbackConfig {
  const c = asRecord(v, "callback");
  const enabled = c["enabled"] === undefined ? false : asBool(c["enabled"], "callback.enabled");
  const host =
    c["host"] === undefined ? DEFAULT_CALLBACK_HOST : asString(c["host"], "callback.host");
  const port = c["port"] === undefined ? DEFAULT_CALLBACK_PORT : asPort(c["port"], "callback.port");
  const tokenRaw = c["token"];
  const token = tokenRaw === undefined ? undefined : asString(tokenRaw, "callback.token");
  return token === undefined ? { enabled, host, port } : { enabled, host, port, token };
}

/**
 * 桥 transport 缺省（v0.4.1）：`mode` 缺省 `stdio` = 与旧配置行为一致；
 * http 绑定 loopback，端口避开 Launcher 3100、项目 A2A 3010-3012 与回调 3200。
 */
const DEFAULT_TRANSPORT_MODE: TransportMode = "stdio";
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 8787;
const DEFAULT_HTTP_PATH = "/mcp";

/** `http` 段缺省值（`transport` 或 `transport.http` 缺失时使用） */
function defaultHttpTransport(): HttpTransportConfig {
  return { host: DEFAULT_HTTP_HOST, port: DEFAULT_HTTP_PORT, path: DEFAULT_HTTP_PATH };
}

/** 无 `transport` 段时的解析结果（旧 `config.json` 零改动可用） */
function defaultTransport(): TransportConfig {
  return { mode: DEFAULT_TRANSPORT_MODE, http: defaultHttpTransport() };
}

/** 解析 `transport.http`（缺省字段补默认值） */
function parseHttpTransport(v: unknown): HttpTransportConfig {
  const h = asRecord(v, "transport.http");
  const hostRaw = h["host"];
  const portRaw = h["port"];
  const pathRaw = h["path"];
  return {
    host: hostRaw === undefined ? DEFAULT_HTTP_HOST : asString(hostRaw, "transport.http.host"),
    port: portRaw === undefined ? DEFAULT_HTTP_PORT : asPort(portRaw, "transport.http.port"),
    path: pathRaw === undefined ? DEFAULT_HTTP_PATH : asHttpPath(pathRaw, "transport.http.path"),
  };
}

/**
 * 解析 `transport` 配置（段可选；`mode` 缺省 `stdio`）。
 * 非法 mode / 端口 / 路径一律结构化报错（复用 `fail`），不静默降级。
 */
function parseTransport(v: unknown): TransportConfig {
  const t = asRecord(v, "transport");
  const modeRaw = t["mode"];
  const mode =
    modeRaw === undefined ? DEFAULT_TRANSPORT_MODE : asTransportMode(modeRaw, "transport.mode");
  const httpRaw = t["http"];
  const http = httpRaw === undefined ? defaultHttpTransport() : parseHttpTransport(httpRaw);
  return { mode, http };
}

/**
 * 网页端只读工作台缺省（v0.5.0 §2.2）。
 * `port` 取 3300：避开 Launcher 3100、项目 A2A 3010-3012、MCP http 8787 与回调 3200。
 */
const DEFAULT_WEB_ENABLED = true;
const DEFAULT_WEB_HOST = "127.0.0.1";
const DEFAULT_WEB_PORT = 3300;
const DEFAULT_WEB_ALLOW_STDIO = false;

/**
 * 解析 `web` 配置段（v0.5.0 网页端只读工作台；段可选，缺省字段补默认值）。
 *
 * 语义（本节点只解析与暴露配置，**不实现 bind**）：
 * - `enabled`（缺省 `true`）**只在常驻（`transport.mode === "http"`）形态下生效**；
 *   stdio 形态**不读它**（避免「`enabled = true` 但无效果」的歧义）。
 * - `allowStdio`（缺省 `false`）= **唯一**允许 stdio 形态也 bind 的显式开关
 *   （运行时开启时必须 `server.unref()`）。
 * - 运行时 bind 判定式：`(mode === "http" ? web.enabled : web.allowStdio) && role === "owner"`。
 * - `host` 只校验**非空字符串**；**非 loopback 不在此拒绝**（loopback 拒起属运行时）。
 * - `port` 非法（非整数 / 越界 / 类型错）一律结构化报错（复用 `fail`），不静默降级。
 */
function parseWeb(v: unknown): WebConfig {
  const w = asRecord(v, "web");
  const enabledRaw = w["enabled"];
  const hostRaw = w["host"];
  const portRaw = w["port"];
  const allowStdioRaw = w["allowStdio"];
  return {
    enabled: enabledRaw === undefined ? DEFAULT_WEB_ENABLED : asBool(enabledRaw, "web.enabled"),
    host: hostRaw === undefined ? DEFAULT_WEB_HOST : asString(hostRaw, "web.host"),
    port: portRaw === undefined ? DEFAULT_WEB_PORT : asPort(portRaw, "web.port"),
    allowStdio:
      allowStdioRaw === undefined
        ? DEFAULT_WEB_ALLOW_STDIO
        : asBool(allowStdioRaw, "web.allowStdio"),
  };
}

/**
 * 正整数毫秒（v0.7.0 `runner` 段）：非 number / 非整数 / <1 一律结构化报错。
 * 上限不设（阈值语义由消费方裁决），但拒绝 NaN / 小数 / 负数 / 0 / 字符串布尔等弱类型。
 */
function asPositiveMs(v: unknown, ctx: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    fail(`${ctx} 必须是正整数（毫秒，>=1）`);
  }
  return v;
}

/**
 * `runner` 段缺省（v0.7.0 D2）：hold ~25s（poll 即心跳）、心跳判死 60s。
 * 与 `PROTOCOL.md` 2.0 的常量约定一致；缺省段零改动可用（旧 `config.json` 无本段）。
 */
const DEFAULT_RUNNER_HOLD_MS = 25000;
const DEFAULT_RUNNER_HEARTBEAT_TIMEOUT_MS = 60000;

/** `runner` 段缺省构造（段缺失 / 空段时使用） */
export function defaultRunner(): RunnerConfig {
  return {
    holdMs: DEFAULT_RUNNER_HOLD_MS,
    heartbeatTimeoutMs: DEFAULT_RUNNER_HEARTBEAT_TIMEOUT_MS,
  };
}

/**
 * 解析顶层 `runner` 段（v0.7.0 D2；段可选，缺省字段补默认值）。
 *
 * - **段缺失 / 空段** ⇒ 全缺省（`{ 25000, 60000 }`），旧 `config.json` 零改动可用；
 * - **段存在** ⇒ 结构校验：必须对象；`holdMs` / `heartbeatTimeoutMs` 若声明必须为
 *   正整数毫秒，非法**一律 fail-fast**（复用 `fail`，不静默降级）。
 */
export function parseRunner(v: unknown): RunnerConfig {
  const r = asRecord(v, "runner");
  const holdRaw = r["holdMs"];
  const heartbeatRaw = r["heartbeatTimeoutMs"];
  return {
    holdMs:
      holdRaw === undefined
        ? DEFAULT_RUNNER_HOLD_MS
        : asPositiveMs(holdRaw, "runner.holdMs"),
    heartbeatTimeoutMs:
      heartbeatRaw === undefined
        ? DEFAULT_RUNNER_HEARTBEAT_TIMEOUT_MS
        : asPositiveMs(heartbeatRaw, "runner.heartbeatTimeoutMs"),
  };
}

/**
 * 成员 key 分隔符（v0.6.0）。取 NUL：配置 id 中不可能出现，保证
 * `memberKey` 对 `(machineId, projectId)` **单射** —— 用 `":"` / `"/"` 拼接会让
 * `("a", "b:c")` 与 `("a:b", "c")` 碰撞（§2.3-I1 单一判据的前提）。
 */
const MEMBER_KEY_SEP = "\u0000";

/**
 * 成员 key **唯一构造**（v0.6.0 §2.1 总纲 3 / §2.3-I1）。
 *
 * 全仓成员判定的**唯一**来源：过滤（`isMemberProject`）与断言（`assertMember`）必须共用它，
 * **禁止第二套拼接**（v0.5.1 D2 教训：双份判据 ⇒ 缓存 / 扫描路径判据分叉）。
 * 纯函数，无 I/O、无副作用。
 */
export function memberKey(machineId: string, projectId: string): string {
  return `${machineId}${MEMBER_KEY_SEP}${projectId}`;
}

/**
 * `projectGroup` 段缺省态（v0.6.0）= **全量接纳**：`selective: false`、无成员。
 *
 * 这是「段缺省」这一唯一情形下的合法结果；**配置异常一律 fail-fast**，绝不复用本默认
 * （§2.3-I2：任何「未命中 / 配置异常」都不得回退成全量接纳）。
 */
export function defaultProjectGroup(): ProjectGroup {
  return {
    name: null,
    members: [],
    memberKeys: new Set(),
    memberMachineIds: new Set(),
    selective: false,
  };
}

/**
 * 解析 `projectGroup` 配置段（v0.6.0 静态项目组；纯函数，可单测）。
 *
 * - **段缺失**（`value === undefined`）⇒ `selective: false` 全量接纳（旧 `config.json` 零改动可用，
 *   **绝不 fail-fast** —— 这是验收项）；
 * - **段存在** ⇒ 严格校验：必须对象；`name` 缺省/`null` ⇒ `null`，否则须非空字符串；
 *   `members` 必须为**非空**数组（**空数组 = 配置错误 ⇒ fail**，U1 裁定：要么删段、要么列成员）；
 *   成员项必须为对象且 `{ machineId, projectId }` 均为非空字符串；
 *   **`machineId` 必须 ∈ `machines[]`，否则 fail-fast**（拼错机器名的代价 = 桥整体拒绝该段）。
 * - 派生：`memberKeys` / `memberMachineIds` / `selective: true`（成员判定同源于 `memberKey`）。
 *
 * 非法一律走既有 `fail()` 约定（`[config]` 前缀 + 字段路径），不新造第二种错误风格、不静默降级。
 */
export function parseProjectGroup(value: unknown, machineIds: ReadonlySet<string>): ProjectGroup {
  if (value === undefined) return defaultProjectGroup();
  const g = asRecord(value, "projectGroup");
  const nameRaw = g["name"];
  const name =
    nameRaw === undefined || nameRaw === null ? null : asString(nameRaw, "projectGroup.name");
  const membersRaw = g["members"];
  if (!Array.isArray(membersRaw)) fail("projectGroup.members 必须是数组");
  if (membersRaw.length === 0) {
    fail("projectGroup.members 必须是非空数组（要么删除本段 = 全量接纳，要么列出成员）");
  }
  const members = membersRaw.map((m, i): ProjectMember => {
    const ctx = `projectGroup.members[${i}]`;
    const r = asRecord(m, ctx);
    const machineId = asString(r["machineId"], `${ctx}.machineId`);
    const projectId = asString(r["projectId"], `${ctx}.projectId`);
    if (!machineIds.has(machineId)) {
      fail(`${ctx}.machineId "${machineId}" 不在 machines[] 中（成员必须指向已配置机器）`);
    }
    return { machineId, projectId };
  });
  return {
    name,
    members,
    memberKeys: new Set(members.map((m) => memberKey(m.machineId, m.projectId))),
    memberMachineIds: new Set(members.map((m) => m.machineId)),
    selective: true,
  };
}

/**
 * 解析 `machines[].launcherUrl`（v0.7.0：必填 → **可选 / 已作废**）。
 *
 * 语义（**解析宽容；不 fail-fast、不回退全量接纳**）：
 * - **缺省** ⇒ 告警 + 归一为 `""`（pull 模型下该字段无消费方；入站通道退役）；
 * - **存在且为非空字符串** ⇒ 原样保留（旧配置零改动，出站路径退役前仍可用）；
 * - **存在但非法**（空串 / 非字符串）⇒ 告警 + 忽略（归一为 `""`），不抛错。
 *
 * ⚠ 类型侧 `MachineRef.launcherUrl` 暂保持必填（`bridge/index.ts` 出站路径仍直接解引用，
 * 改成可选会连带 typecheck 变红），故此处恒返回字符串；待出站路径退役节点（A6）后转可选。
 */
function parseLauncherUrl(v: unknown, index: number): string {
  const ctx = `machines[${index}].launcherUrl`;
  if (v === undefined) {
    console.warn(
      `[config] ${ctx} 缺省：v0.7.0 起入站指挥通道退役（Runner 反向注册替代），该字段可选、不再 fail-fast。`,
    );
    return "";
  }
  if (typeof v === "string" && v.length > 0) return v;
  console.warn(`[config] ${ctx} 非法（须为非空字符串）：按解析宽容忽略。`);
  return "";
}

/** 加载并校验「orch 侧机器清单」（含可选回调端点 / 桥 transport / 网页端只读工作台 / runner 阈值配置） */
export function loadMachinesConfig(path: string): MachinesConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const o = asRecord(raw, "machines config");
  const machines = o["machines"];
  if (!Array.isArray(machines)) fail("machines 必须是数组");
  const callbackRaw = o["callback"];
  const callback = callbackRaw === undefined ? undefined : parseCallback(callbackRaw);
  const transportRaw = o["transport"];
  const transport = transportRaw === undefined ? defaultTransport() : parseTransport(transportRaw);
  const webRaw = o["web"];
  const web = parseWeb(webRaw === undefined ? {} : webRaw);
  const runnerRaw = o["runner"];
  const runner = runnerRaw === undefined ? defaultRunner() : parseRunner(runnerRaw);
  const machineRefs = machines.map((m, i): MachineRef => {
    const r = asRecord(m, `machines[${i}]`);
    const pushCallbackRaw = r["pushCallback"];
    const tokenRaw = r["token"];
    return {
      machineId: asString(r["machineId"], `machines[${i}].machineId`),
      launcherUrl: parseLauncherUrl(r["launcherUrl"], i),
      token: tokenRaw === undefined ? undefined : asString(tokenRaw, `machines[${i}].token`),
      pushCallback:
        pushCallbackRaw === undefined
          ? undefined
          : asBool(pushCallbackRaw, `machines[${i}].pushCallback`),
    };
  });
  /**
   * v0.6.0 项目组：在 `machines[]` 解析之后接入（成员 `machineId ∈ machines[]` 校验依赖其派生集合）。
   * 段缺失 ⇒ `selective: false`（全量接纳），**恒返回完整对象**（运行时不存在 `undefined`）。
   */
  const projectGroup = parseProjectGroup(
    o["projectGroup"],
    new Set(machineRefs.map((r) => r.machineId)),
  );
  return {
    machines: machineRefs,
    callback,
    transport,
    web,
    runner,
    projectGroup,
  };
}
