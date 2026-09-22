import { readFileSync } from "node:fs";
import type {
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

/**
 * 进程内**已发 warn 文案**集合（v0.7.2 K6：文案级 once-per-process 去重）。
 *
 * 动机：`loadMachinesConfig` 被多条 **per-request** 路径现读 ——
 * - Runner 端点：`bridge/index.ts` 把 `config: () => loadMachinesConfig(...)` 包成惰性闭包注入，
 *   `/runner/register` 每请求读、`/runner/connect` 长轮询约 25s/轮读；
 * - MCP 工具处理器：`loadMachines()` ⇒ `locateProject` / `dispatchTask` / `registerFeatureNode` /
 *   `handleTaskStatus` / `handleCancel` / `handleProjects`，每次工具调用读。
 *
 * 坏配置（`web.allowStdio` 残留、`machines[].launcherUrl` 缺省/非法）会按
 * 「每台机器 × 每请求」重复打印，淹没启动日志。本去重**只作用于告警文案**：
 * - **不缓存 config** —— 解析仍每次现读 ⇒ 配置热改（成员的增删 / 段增删 / `launcherUrl` 增删）
 *   即时生效，语义与去重前完全一致；
 * - **不改 schema**、**不 fail-fast**；
 * - **同文案仅 warn 一次**；**不同文案各自独立**（`machines[0]` 与 `machines[1]` 文案因下标不同 ⇒ 各一条）。
 */
const warnedTexts = new Set<string>();

/** 同文案在进程内仅 `console.warn` 一次，其余静默（不同文案互不影响） */
function warnOnce(msg: string): void {
  if (warnedTexts.has(msg)) return;
  warnedTexts.add(msg);
  console.warn(msg);
}

/**
 * 测试专用：清空「已发 warn 文案」集合，使同一文案在后续用例中可再次观测到告警。
 * **生产路径不得调用**（会破坏 once-per-process 语义）。
 */
export function resetWarnOnceCache(): void {
  warnedTexts.clear();
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

/**
 * 解析 `transport.mode`（v0.7.1 stdio 退役）：**仅接受 `"http"`**。
 * 显式 `"stdio"` = 已退役的死形态 ⇒ **结构化 fail-fast**（不得静默降级为 http）。
 */
function asTransportMode(v: unknown, ctx: string): TransportMode {
  if (v === "http") return "http";
  if (v === "stdio") {
    fail(`${ctx} "stdio" 已退役（stdio transport 不再支持）：仅接受 "http"`);
  }
  fail(`${ctx} 必须是 "http"`);
}

/**
 * HTTP 接入面**保留首段**（v0.8.6 §2.2 B 形态：`/<组名>/mcp` 身份 = URL 首段）。
 * 两处消费（均为启动 fail-fast）：
 * - ① `transport.http.path` 不得为这些段本身或其前缀（否则保留路由空间的请求会被身份首段解析牵连）；
 * - ④ 组名不得取这些段（否则 `/health` / `/shutdown` / `/runner` 流量的归属产生歧义）。
 */
export const RESERVED_FIRST_SEGMENTS = ["health", "shutdown", "runner"] as const;

/**
 * 组名字符集（v0.8.6 §2.2 启动校验 ③）：组名进 URL 路径首段 ⇒ 只允许
 * `[A-Za-z0-9_-]+`（不含 `/`、空白与其它需要百分号编码的字符）。
 */
const GROUP_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 解析 `transport.http.path`（v0.8.6 §2.2 B 形态三项启动校验合一）：
 * 非空字符串、以 `/` 开头、**拒尾斜杠**（②：「首段 = 组身份」解析下 `"/mcp/"` 产生空段歧义）、
 * **不得为保留首段本身或其前缀**（①：如 `/health` / `/runner/…`）。非法一律 `fail()`。
 */
function asHttpPath(v: unknown, ctx: string): string {
  const s = asString(v, ctx);
  if (!s.startsWith("/")) fail(`${ctx} 必须以 "/" 开头`);
  if (s.endsWith("/")) {
    fail(
      `${ctx} "${s}" 非法：不得以 "/" 结尾（组身份 = URL 首段解析下尾斜杠产生空段歧义，请去掉结尾的 "/"）`,
    );
  }
  for (const reserved of RESERVED_FIRST_SEGMENTS) {
    if (s.startsWith(`/${reserved}`)) {
      fail(
        `${ctx} "${s}" 非法：MCP 端点不得为 /${reserved} 本身或其前缀` +
          `（占用保留路由空间会令 /${reserved} 系请求与「/<组名>/…」身份解析纠缠，` +
          `请改用独立路径，如 /mcp）`,
      );
    }
  }
  return s;
}

/**
 * 桥 transport 缺省（v0.7.1）：stdio 已退役 ⇒ `mode` **缺省 `http`**（桥恒常驻）；
 * http 绑定 loopback，端口避开 Launcher 3100、项目 A2A 3010-3012 与回调 3200。
 */
const DEFAULT_TRANSPORT_MODE: TransportMode = "http";
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 8787;
const DEFAULT_HTTP_PATH = "/mcp";

/** `http` 段缺省值（`transport` 或 `transport.http` 缺失时使用） */
function defaultHttpTransport(): HttpTransportConfig {
  return { host: DEFAULT_HTTP_HOST, port: DEFAULT_HTTP_PORT, path: DEFAULT_HTTP_PATH };
}

/** 无 `transport` 段时的解析结果（旧 `config.json` 零改动可用：`mode` 缺省 `http`） */
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
 * 解析 `transport` 配置（段可选；`mode` 缺省 `http`，显式 `"stdio"` ⇒ fail-fast）。
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

/**
 * 解析 `web` 配置段（v0.5.0 网页端只读工作台；段可选，缺省字段补默认值）。
 *
 * 语义（本节点只解析与暴露配置，**不实现 bind**）：
 * - `enabled`（缺省 `true`）：是否允许常驻桥另起只读 HTTP 工作台；
 * - 运行时 bind 判定式：`web.enabled && role === "owner"`；
 * - `host` 只校验**非空字符串**；**非 loopback 不在此拒绝**（loopback 拒起属运行时）。
 * - `port` 非法（非整数 / 越界 / 类型错）一律结构化报错（复用 `fail`），不静默降级。
 * - `allowStdio`（v0.7.1 起随 stdio 退役成**死配置**）：显式出现仅 **warn + 忽略**，
 *   **不 fail-fast**（避免旧部署因残留键直接起不来）；解析产物不再含该字段。
 *   v0.7.2 K6：该告警**文案级 once-per-process 去重**（同文案进程内仅 warn 一次）。
 */
function parseWeb(v: unknown): WebConfig {
  const w = asRecord(v, "web");
  const enabledRaw = w["enabled"];
  const hostRaw = w["host"];
  const portRaw = w["port"];
  if (w["allowStdio"] !== undefined) {
    warnOnce("[config] web.allowStdio 已退役（stdio transport 退役）：按死配置 warn + 忽略。");
  }
  return {
    enabled: enabledRaw === undefined ? DEFAULT_WEB_ENABLED : asBool(enabledRaw, "web.enabled"),
    host: hostRaw === undefined ? DEFAULT_WEB_HOST : asString(hostRaw, "web.host"),
    port: portRaw === undefined ? DEFAULT_WEB_PORT : asPort(portRaw, "web.port"),
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
 * 这是「段缺省 / 未配任何组」这一唯一情形下的合法结果（v0.8.6 起亦作 N1 过渡聚合视图
 * `aggregateProjectGroup([])` 的空态）；**配置异常一律 fail-fast**，绝不复用本默认
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
 * 解析 `projectGroup` 配置段（v0.8.6 一桥多组 §2.1；纯函数，可单测）。
 *
 * 键名沿用 `projectGroup`，**形状由「单组对象」扩为「组数组」**，每项 `{ name, members[] }`。
 *
 * - **段缺失**（`value === undefined` / `null`）⇒ 返回 `[]`（顶层 `groups: []` = **全量接纳**，
 *   与今天 `defaultProjectGroup()` 语义一致，**绝不 fail-fast** —— 验收项）；
 * - **段存在** ⇒ 必须是**数组**（每个元素是一个组对象）；逐组严格校验：
 *   组项必须对象；**`name` 必填**（v0.8.6 §2.2 B 形态：组名 = URL 路径首段身份，
 *   无名组不可被寻址 ⇒ 配组后匿名又被 403 拒绝 = 死配置 ⇒ **fail-fast**）且匹配 `[A-Za-z0-9_-]+`；
 *   `members` 必须为**非空**数组（**空数组 = 配置错误 ⇒ fail**，U1 裁定：要么删段、要么列成员）；
 *   成员项必须为对象且 `{ machineId, projectId }` 均为非空字符串；
 *   **`machineId` 必须 ∈ `machines[]`，否则 fail-fast**（拼错机器名的代价 = 桥整体拒绝该段）；
 *   每组派生 `selective: true`。
 * - **组间成员互斥（用户 2026-09-21 已裁）**：同一 `(machineId, projectId)` **只能出现在一个组**
 *   ⇒ 配置期 **fail-fast**。判据同源于 `memberKey()`（禁第二套拼接）；**组内重复项**由集合去重、
 *   不触发互斥（互斥只针对**跨组**）。
 *
 * 非法一律走既有 `fail()` 约定（`[config]` 前缀 + 字段路径 + 中文解释 + 对策），
 * 不新造第二种错误风格、不静默降级。
 */
export function parseProjectGroups(
  value: unknown,
  machineIds: ReadonlySet<string>,
): ProjectGroup[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    fail("projectGroup 必须是组数组（每个元素是一个项目组对象：{ name, members[] }）");
  }
  /** 成员 key → 首个声明它的组下标（跨组去重判据，同源于 `memberKey`） */
  const ownerGroupIndex = new Map<string, number>();
  const groups: ProjectGroup[] = [];
  value.forEach((item, gi) => {
    const ctx = `projectGroup[${gi}]`;
    const g = asRecord(item, ctx);
    const nameRaw = g["name"];
    if (nameRaw === undefined || nameRaw === null) {
      fail(
        `${ctx}.name 组名必填：身份由 URL 路径首段承载（访问 /<组名>/mcp），` +
          `无名组不可被寻址、且配组后匿名访问已被 403 拒绝（请为本组补 name，字符集 [A-Za-z0-9_-]+）`,
      );
    }
    const name = asString(nameRaw, `${ctx}.name`);
    if (!GROUP_NAME_RE.test(name)) {
      fail(
        `${ctx}.name "${name}" 非法：组名进 URL 路径首段，只允许字母 / 数字 / 下划线 / 连字符` +
          `（[A-Za-z0-9_-]+），请改名`,
      );
    }
    const membersRaw = g["members"];
    if (!Array.isArray(membersRaw)) fail(`${ctx}.members 必须是数组`);
    if (membersRaw.length === 0) {
      fail(`${ctx}.members 必须是非空数组（要么删除本段 = 全量接纳，要么列出成员）`);
    }
    const members = membersRaw.map((m, mi): ProjectMember => {
      const mctx = `${ctx}.members[${mi}]`;
      const r = asRecord(m, mctx);
      const machineId = asString(r["machineId"], `${mctx}.machineId`);
      const projectId = asString(r["projectId"], `${mctx}.projectId`);
      if (!machineIds.has(machineId)) {
        fail(`${mctx}.machineId "${machineId}" 不在 machines[] 中（成员必须指向已配置机器）`);
      }
      return { machineId, projectId };
    });
    const memberKeys = new Set<string>();
    const memberMachineIds = new Set<string>();
    for (const m of members) {
      const key = memberKey(m.machineId, m.projectId);
      memberMachineIds.add(m.machineId);
      if (memberKeys.has(key)) continue; // 组内重复项：集合去重即可，非跨组冲突
      const owner = ownerGroupIndex.get(key);
      if (owner !== undefined) {
        fail(
          `projectGroup 组间成员互斥：{ machineId: "${m.machineId}", projectId: "${m.projectId}" } ` +
            `同时出现在 projectGroup[${owner}] 与 ${ctx}` +
            `（同一成员只能属于一个组，请从其中一组删除）`,
        );
      }
      ownerGroupIndex.set(key, gi);
      memberKeys.add(key);
    }
    groups.push({ name, members, memberKeys, memberMachineIds, selective: true });
  });
  return groups;
}

/**
 * **全组聚合视图**（v0.8.6 §2.1）：把 `groups[]` 并成单个 `ProjectGroup`（「无身份 / 全量视图」口径）。
 *
 * 消费者（均为**刻意**使用聚合语义，而非旧单组遗留）：
 * - `bridge/index.ts#resolveGroup(identity)` 在 `identity === null`（配组环境的 web 运维视图 /
 *   HTTP 匿名在 403 门后理论不可达）时**同源复用**（禁第二套并集拼接）；
 * - Runner claim **不再走本聚合视图**：v0.8.6 §2.5 N5 起直接读 `groups[]` 做「任一组放行」判定
 *   （`bridge/runner.ts#claimableProjects`）；`MachinesConfig.projectGroup` 字段仅剩存量断言消费，
 *   待收尾节点与本函数一并退役。
 *
 * 聚合口径：`members` = 各组声明拼接；`memberKeys` / `memberMachineIds` = 各组并集（互斥保证不重叠）；
 * `selective` = `groups.length > 0`；空组 ⇒ 回 `defaultProjectGroup()`（全量接纳）。
 * 纯函数，无 I/O、无副作用。
 */
export function aggregateProjectGroup(groups: readonly ProjectGroup[]): ProjectGroup {
  if (groups.length === 0) return defaultProjectGroup();
  const members: ProjectMember[] = [];
  const memberKeys = new Set<string>();
  const memberMachineIds = new Set<string>();
  for (const g of groups) {
    members.push(...g.members);
    for (const k of g.memberKeys) memberKeys.add(k);
    for (const id of g.memberMachineIds) memberMachineIds.add(id);
  }
  return { name: groups[0]?.name ?? null, members, memberKeys, memberMachineIds, selective: true };
}

/**
 * 解析 `machines[].launcherUrl`（v0.7.0：必填 → **可选 / 已作废**）。
 *
 * 语义（**解析宽容；不 fail-fast、不回退全量接纳**）：
 * - **缺省** ⇒ 告警 + 归一为 `""`（pull 模型下该字段无消费方；入站通道退役）；
 * - **存在且为非空字符串** ⇒ 原样保留（旧配置零改动，出站路径退役前仍可用）；
 * - **存在但非法**（空串 / 非字符串）⇒ 告警 + 忽略（归一为 `""`），不抛错。
 *
 * v0.7.2 K6：上述告警**文案级 once-per-process 去重**。文案内嵌 `machines[i]` 下标 ⇒
 * **每台机器各一条**（不同下标 = 不同文案），但同一台机器**不再按每请求重复刷屏**。
 * 去重只作用于告警，**不影响解析结果**（`launcherUrl` 仍每次现读，热改即时生效）。
 *
 * ⚠ 类型侧 `MachineRef.launcherUrl` 暂保持必填（`bridge/index.ts` 出站路径仍直接解引用，
 * 改成可选会连带 typecheck 变红），故此处恒返回字符串；待出站路径退役节点（A6）后转可选。
 */
function parseLauncherUrl(v: unknown, index: number): string {
  const ctx = `machines[${index}].launcherUrl`;
  if (v === undefined) {
    warnOnce(
      `[config] ${ctx} 缺省：v0.7.0 起入站指挥通道退役（Runner 反向注册替代），该字段可选、不再 fail-fast。`,
    );
    return "";
  }
  if (typeof v === "string" && v.length > 0) return v;
  warnOnce(`[config] ${ctx} 非法（须为非空字符串）：按解析宽容忽略。`);
  return "";
}

/** 加载并校验「orch 侧机器清单」（含桥 transport / 网页端只读工作台 / runner 阈值配置） */
export function loadMachinesConfig(path: string): MachinesConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const o = asRecord(raw, "machines config");
  const machines = o["machines"];
  if (!Array.isArray(machines)) fail("machines 必须是数组");
  if (o["callback"] !== undefined)
    warnOnce("[config] callback 段已退役（push 通知链拆除）：按死配置 warn + 忽略。");
  const transportRaw = o["transport"];
  const transport = transportRaw === undefined ? defaultTransport() : parseTransport(transportRaw);
  const webRaw = o["web"];
  const web = parseWeb(webRaw === undefined ? {} : webRaw);
  const runnerRaw = o["runner"];
  const runner = runnerRaw === undefined ? defaultRunner() : parseRunner(runnerRaw);
  const machineRefs = machines.map((m, i): MachineRef => {
    const r = asRecord(m, `machines[${i}]`);
    if (r["pushCallback"] !== undefined)
      warnOnce(
        `[config] machines[${i}].pushCallback 已退役（push 通知链拆除）：按死配置 warn + 忽略。`,
      );
    const tokenRaw = r["token"];
    return {
      machineId: asString(r["machineId"], `machines[${i}].machineId`),
      launcherUrl: parseLauncherUrl(r["launcherUrl"], i),
      token: tokenRaw === undefined ? undefined : asString(tokenRaw, `machines[${i}].token`),
    };
  });
  /**
   * v0.8.6 一桥多组：在 `machines[]` 解析之后接入（成员 `machineId ∈ machines[]` 校验依赖其派生集合）。
   * 段缺失 / 未配任何组 ⇒ `groups: []`（全量接纳），**恒返回数组**（运行时不会出现 `undefined`）。
   * `projectGroup` = 全组聚合视图（v0.8.6 §2.2 起桥侧组判定走 `bridge/index.ts#resolveGroup(identity)`；
   * §2.5 N5 起 Runner claim 亦直接读 `groups[]`「任一组放行」，本字段生产路径已无消费者）。
   */
  const groups = parseProjectGroups(
    o["projectGroup"],
    new Set(machineRefs.map((r) => r.machineId)),
  );
  /**
   * B 形态启动校验 ④：组名不得与**保留 URL 首段**冲突 —— {health, shutdown, runner} ∪
   * {`transport.http.path` 的首段}。身份 = 首段的解析下，撞首段的组地址与既有路由无法区分 ⇒ fail-fast。
   */
  const reservedFirstSegments = new Set<string>([
    ...RESERVED_FIRST_SEGMENTS,
    transport.http.path.slice(1).split("/")[0] ?? "",
  ]);
  for (const [gi, g] of groups.entries()) {
    if (g.name !== null && reservedFirstSegments.has(g.name)) {
      fail(
        `projectGroup[${gi}].name "${g.name}" 与保留 URL 首段冲突` +
          `（保留段 = health / shutdown / runner / transport.http.path 首段 "${transport.http.path.slice(1).split("/")[0]}"）：` +
          `组地址 /<组名>… 与既有路由无法区分，请改用其它 [A-Za-z0-9_-]+ 组名`,
      );
    }
  }
  return {
    machines: machineRefs,
    transport,
    web,
    runner,
    groups,
    projectGroup: aggregateProjectGroup(groups),
  };
}
