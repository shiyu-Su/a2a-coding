/**
 * 宿主桥的**进程托管**（v0.9.0 · BD4a）—— 「一个组织一个宿主桥」的生命周期，**不含 RPC / 对话轮**。
 *
 * 事实源：`doc/v0.9.0/Web看板与确认入口-改造文档.md`
 * - **§2.2-5** 宿主可选（组织级 `agentKind`，缺省 `claude`）+ 板 spawn `machine/dist/acp-bridge`；
 * - **§2.2-6** 进程拓扑 (a)：**每组织一桥**（桥 `--workspace` = 该组织目录）· 桥内每需求一个 `contextId`；
 * - **§2.2-7** 起停策略：有在飞 ⇒ 不收 · 无在飞 ⇒ `host.idleStopMs`（缺省 15 min、`0` = 常驻、按组织可覆盖）
 *   · 回收 = **先 SIGTERM、超时再树杀**（板 spawn 的是「桥 + 后端」**两级进程**）· **故障可见**；
 * - **§3.4** kind 归一唯一事实源 = `getAdapter()`，**板不得自拼 argv**；必填 4 flag + `--risk` 缺省 write；
 *   桥**有优雅停机**（SIGTERM / SIGINT）⇒ 回收不必只靠树杀；
 * - **§3.7**（M2b 实测）payload **必须是 ACP tagged-union**（缺 `type` 键能过 M2a 的启动期校验，
 *   却在运行期 `session/new` 才炸 `-32602`）⇒ 本文件把它写成**唯一产出点**。
 *
 * ## 本节点的边界
 * - **不做 RPC、不做对话轮**：这里只有「起 / 停 / 查 / 回收 / 记账」。在飞轮数由**下一节点**经
 *   {@link HostBridgeManager.beginRound} / {@link HostBridgeManager.endRound} 喂进来；
 * - **不起真桥**：一切进程与网络动作经 {@link HostBridgeDeps} 注入 ⇒ 单测可断言全部生命周期语义；
 * - **不写组织配置**：`workspace` / `kind` / `idleStopMs` 由调用方（组织管理侧）传入。
 *   但**会在 spawn 前查该目录在不在（BD14），缺失时由板代建组织子目录（BD15）** —— 建不动就是起不来，
 *   账上必须写清是**目录问题**还是**后端问题**，不再一律伪装成 `bridge_exited` + 一个负 errno。
 *
 * ## 「查」的口径（与节点描述的一处差异，如实登记）
 * 节点写「读桥 `/health`」，但 `machine/acp-bridge/a2a-server.ts` 只接受 **POST**（非 POST ⇒ 405）、
 * **无 `/health` 路由**，其模块头亦注明「listen 即就绪，不依赖 `/health`」。
 * ⇒ 板的可用性判据落为 **进程存活 ∧ 桥端口可连**（{@link HostBridgeDeps.probePort}），
 * 语义等价于 machine 侧 `launcher/ports.ts` 的 `waitForPort`。**不臆造不存在的 HTTP 端点**；
 * 探测函数可注入 ⇒ 未来桥若补 `/health`，换实现不动本文件的语义。
 */
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import {
  assertRuntimeArtifacts,
  loadAdaptersModule,
  resolveMachineDistDir,
  statDirKind,
  type AdapterLike,
  type AdaptersModule,
  type DirKindProbeFn,
  type RuntimeArtifacts,
} from "./host-runtime.js";import {
  allocateFreePort,
  buildChildEnv,
  createNodeSpawnBridge,
  createTreeKiller,
  describeSpawnFailure,
  probeTcpPort,
  type BridgeChildHandle,
  type AllocatePortFn,
  type KillTreeFn,
  type ProbePortFn,
  type SpawnBridgeFn,
} from "./host-process.js";
import {
  HostBridgeLedgerStore,
  type HostBridgePatch,
} from "./host-bridge-ledger.js";
import { buildMcpEndpoint, DEFAULT_MCP_BASE_URL } from "./requirement.js";

// ---------------------------------------------------------------------------
// 口径常量（§2.2-7 / §3.4 / §3.5 / §3.7）
// ---------------------------------------------------------------------------

/** `host.idleStopMs` 缺省 = **15 分钟**（已裁）；`0` = 常驻不回收。 */
export const DEFAULT_IDLE_STOP_MS = 15 * 60_000;

/** 组织级宿主桥的 `--project-id` 前缀（建议值 = `host-<组织名>`）。 */
export const HOST_PROJECT_ID_PREFIX = "host-";

/** 注入给后端的 MCP server 名（⚠ 板侧提示词**不得硬编码工具全名**，§3.6 直接约束 3）。 */
export const HOST_MCP_SERVER_NAME = "a2a";

/** 宿主桥风险档 —— **宿主必须能写文件**（要落需求确认单 / 改造文档）⇒ 恒 `write`，不得降 `read`。 */
export const HOST_BRIDGE_RISK = "write" as const;

/** 故障可见的统一文案（板必须显示「宿主桥已断」，**不得静默**）。 */
export const HOST_BRIDGE_DOWN_MESSAGE = "宿主桥已断";

/** 缺省 kind（§3.5 待决 #4 已裁 = `claude`；组织可覆盖。**值域事实源仍是 `getAdapter()`**）。 */
export const DEFAULT_HOST_AGENT_KIND = "claude";

/** SIGTERM 后等待优雅退出的宽限，超时 ⇒ 树杀（§2.2-7）。 */
export const DEFAULT_TERM_GRACE_MS = 5_000;

/** `ensureStarted` 等待端口就绪的上限（超时 ⇒ 结构化 `failed`，不无限等）。 */
export const DEFAULT_START_TIMEOUT_MS = 30_000;

/** 就绪轮询间隔 / 停止轮询间隔。 */
const START_POLL_MS = 200;
const STOP_POLL_MS = 25;

/** 编排桥 MCP 面缺省基址（与 `requirement.ts` 同一常量，8787 = streamable-HTTP 面）。 */
export const DEFAULT_HOST_MCP_BASE_URL = DEFAULT_MCP_BASE_URL;

/**
 * **组织目录建不出来**（BD14 引入 · BD15 语义收窄）：过去 = 「目录不存在 / 不是目录」，
 * BD15 起组织子目录缺失由板代建（{@link prepareWorkspace}），本码只剩三档根因 ——
 * 父级（组织目录根）不可用 / 路径被文件占用 / mkdir 权限不足。
 * 与「桥起来即崩」`bridge_exited`、「后端命令不存在」`spawn_enoent` 的区分口径不变。
 */
export const ORG_WORKSPACE_MISSING = "org_workspace_missing";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 建桥所需的组织侧入参（**板不写组织配置** —— 全部由调用方给出）。 */
export interface HostBridgeConfig {
  /** 组织名（= `projectGroup.name` = MCP URL 首段 = 目录名）。 */
  org: string;
  /** 该组织目录 = 桥 `--workspace`（`SessionMap` 亦落此处，§2.2-6 三硬约束之一）。 */
  workspace: string;
  /** 后端 kind；缺省 {@link DEFAULT_HOST_AGENT_KIND}。值域事实源 = `getAdapter()` 注册表。 */
  kind?: string;
  /** 空闲回收阈值（ms）；缺省 {@link DEFAULT_IDLE_STOP_MS}、`0` = 常驻。**按组织可覆盖**。 */
  idleStopMs?: number;
  /** 注入给后端的编排桥 MCP 端点；缺省由组织名推导（{@link defaultMcpUrlForOrg}）。 */
  mcpUrl?: string;
  /** 覆盖 `--project-id`（缺省 `host-<org>`）。 */
  projectId?: string;
  /** 组织级后端覆盖项，原样透传给 `buildLaunch`（如 `{backendCmd, model}`）；板不解释其内容。 */
  agentConfig?: Record<string, unknown>;
}

/** 一次起桥的完整命令形状（可直接贴给用户核对；无密钥，MCP 端点是本机地址）。 */
export interface BridgeLaunchPlan {
  command: string;
  args: string[];
  projectId: string;
  port: number;
  kind: string;
  workspace: string;
  /** `--mcp-servers-json` 的解析后负载（shape 断言用）。 */
  mcpServers: readonly Record<string, unknown>[];
}

/** 进程生命周期可见态（**不是** Feature 状态机）。 */
export type HostBridgeState =
  | "running"      // 已 spawn 且端口可连
  | "starting"     // 已 spawn，等待端口就绪
  | "unreachable"  // 进程还在、端口连不上 ⇒ 「宿主桥已断」
  | "exited"       // 中途消失（桥或后端自己退出）/ 已回收 —— spawn **成功之后**的事，别和起不来混
  | "failed";      // 起不来（组织目录缺失 / 产物缺失 / kind 未知 / spawn 抛错或 ENOENT / 就绪超时）

export interface HostBridgeStatus {
  org: string;
  state: HostBridgeState;
  pid: number | null;
  port: number | null;
  workspace: string;
  kind: string;
  projectId: string;
  idleStopMs: number;
  /** **板自己的在飞轮数**（回收判据唯一来源，见文件头）。 */
  inFlightRounds: number;
  startedAt: string | null;
  lastActivityAt: string | null;
  /** `now - lastActivityAt`；无活动记录 ⇒ null。 */
  idleMs: number | null;
  /** 结构化错误（**不得静默**）。 */
  error: { code: string; message: string } | null;
  /** 面向人的显示文案（板视图直接用；故障态必带 {@link HOST_BRIDGE_DOWN_MESSAGE}）。 */
  display: string;
}

/** 空闲回收判据的结论（含原因，便于板如实显示「为什么没收」）。 */
export interface IdleReclaimDecision {
  reclaim: boolean;
  reason: "resident" | "in_flight" | "below_threshold" | "idle_timeout";
}

/** `ensureStarted` 的结果（`reused` = 复用已在跑的桥，未新起进程）。 */
export interface EnsureStartedResult {
  ok: boolean;
  reused: boolean;
  status: HostBridgeStatus;
}

// ---------------------------------------------------------------------------
// 纯函数（无 I/O；单测目标）
// ---------------------------------------------------------------------------

/** 组织 → 桥 `--project-id`（`host-<组织名>`，空白清洗成 `-`）。 */
export function hostProjectId(org: string): string {
  return `${HOST_PROJECT_ID_PREFIX}${org.trim().replace(/\s+/g, "-")}`;
}

/**
 * 组织 → 注入给后端的 MCP 端点 `<基址>/<组名>/mcp`。
 * 复用 `requirement.ts` 的 {@link buildMcpEndpoint}（同一 URL 口径 = 同一身份链，S1）：
 * 组身份写在路径首段、空组名（`null` 身份）不可用。
 */
export function defaultMcpUrlForOrg(org: string, baseUrl: string = DEFAULT_HOST_MCP_BASE_URL): string {
  return buildMcpEndpoint(baseUrl, org);
}

/**
 * `--mcp-servers-json` 的负载（§3.7 关键实现事实的落点）——
 * **`type: "http"` 是 ACP tagged-union 的判别键**，缺了它 M2a 的启动期校验放行、
 * 运行期 `session/new` 才炸；`headers: []` 一并给出（各家后端方言要求该键存在）。
 */
export function buildMcpServersPayload(mcpUrl: string): Record<string, unknown>[] {
  return [{ type: "http", name: HOST_MCP_SERVER_NAME, url: mcpUrl, headers: [] }];
}

/**
 * 起桥命令的**唯一产出点**：4 必填 flag（`--port` / `--workspace` / `--project-id` /
 * `--backend-cmd`）+ `--risk write` **全部由 `adapter.buildLaunch()` + `adapter.permission("write")` 给出**，
 * 板**只在尾部追加 `--mcp-servers-json`**（M2a 新接的那根线，adapter 不知道）。
 * 依据 §3.4：「kind 归一唯一事实源 = `getAdapter()`，板是消费方不是实现方」——
 * 自拼 argv = 抄第二份映射表 + 立刻踩 Windows 两坑（`.cmd/.ps1` 不可直调 · npm 全局路径漂移）。
 */
export function buildBridgeLaunchPlan(
  adapter: AdapterLike,
  config: HostBridgeConfig,
  port: number,
  mcpUrl: string,
): BridgeLaunchPlan {
  const projectId = config.projectId ?? hostProjectId(config.org);
  const spec = adapter.buildLaunch({
    projectId,
    workspace: config.workspace,
    a2aPort: port,
    // 宿主必须能写文件 ⇒ 恒取 write 档（产出 `--risk write` + kind 侧对应会话模式）。
    permissionArgs: [...adapter.permission(HOST_BRIDGE_RISK).args],
    ...(config.agentConfig !== undefined ? { agentConfig: config.agentConfig } : {}),
  });
  const mcpServers = buildMcpServersPayload(mcpUrl);
  return {
    command: spec.command,
    // 板**不重排、不改写** adapter 的 argv，只在尾部追加自己那一根旗标。
    args: [...spec.args, "--mcp-servers-json", JSON.stringify(mcpServers)],
    projectId,
    port,
    kind: adapter.kind,
    workspace: config.workspace,
    mcpServers,
  };
}

/** 起桥命令行（脱敏后原样可贴；用于「交付与自证」第 4 项）。 */
export function formatLaunchCommand(plan: BridgeLaunchPlan): string {
  return [plan.command, ...plan.args].join(" ");
}

/**
 * 空闲回收判据（纯函数）。**在飞轮数只认板自己的账**（§2.2-7 括号里的教训）：
 * 板管的桥**不进 Launcher 台账**，拿它的口径判「空闲」会把还在跑的会话腰斩。
 */
export function decideIdleReclaim(input: {
  idleStopMs: number;
  inFlightRounds: number;
  idleMs: number | null;
}): IdleReclaimDecision {
  if (input.idleStopMs <= 0) return { reclaim: false, reason: "resident" };
  if (input.inFlightRounds > 0) return { reclaim: false, reason: "in_flight" };
  if (input.idleMs === null) return { reclaim: false, reason: "below_threshold" };
  if (input.idleMs < input.idleStopMs) return { reclaim: false, reason: "below_threshold" };
  return { reclaim: true, reason: "idle_timeout" };
}

/**
 * 组织目录（= 桥 `--workspace` = spawn 的 cwd）的**自动供给**（BD15 · 纯函数，探针与 mkdir 可注入）。
 * 两层目录分职：`orgsDir` 根 = **部署面**，必须预先存在（配错即报错，见 `host-face.diagnoseOrgsDir`，
 * 行为与收口轨 9 一致）；`<orgsDir>/<组织名>` = **数据面**，缺失时由板 `mkdir` 代建 ——
 * 用户在板上第一次用某组织名，不该先撞一次错误再回终端建目录。
 * {@link ORG_WORKSPACE_MISSING} 语义随之收窄为「**建不出来**」（根不可用 / 路径被文件占用 / 权限不足），
 * 报错仍照 `assertRuntimeArtifacts` 三件套给账：**什么不对 + 绝对路径 + 根因/怎么补**，且**不 spawn 任何进程**。
 * ⛔ 板**只建组织子目录、不建根** ⇒ 单级创建（非递归），且动手前先确认父级是好目录。
 * 已存在的目录一律不碰（幂等，不覆盖、不清空）。
 */
export function prepareWorkspace(
  workspace: string,
  probe: DirKindProbeFn,
  makeDir: (path: string) => void = (p) => void mkdirSync(p),
): { code: string; message: string } | null {
  const abs = resolve(workspace);
  const kind = probe(abs);
  if (kind === "dir") return null;
  if (kind === "not_dir") {
    return {
      code: ORG_WORKSPACE_MISSING,
      message:
        `组织目录建不出来（该路径上是个文件，占用着目录位）：${abs} —— ` +
        `宿主桥要以它为工作目录起后端进程 ⇒ **未 spawn 任何进程**。` +
        `对策：移开该文件，或换一个组织名（板不会覆盖既有文件）。`,
    };
  }
  const parent = dirname(abs);
  if (probe(parent) !== "dir") {
    return {
      code: ORG_WORKSPACE_MISSING,
      message:
        `组织目录建不出来（要挂靠的组织目录根不可用）：${abs} —— 根 = ${parent} 不存在或不是目录。` +
        `根是**部署面**，板刻意不代建（配错必须可见）⇒ **未 spawn 任何进程**。` +
        `对策：改 config.json 的 orgsDir 指向已有目录后重启板。`,
    };
  }
  try {
    makeDir(abs);
  } catch (err) {
    return {
      code: ORG_WORKSPACE_MISSING,
      message:
        `组织目录建不出来（mkdir 失败）：${abs} —— 根因：${errorMessage(err)} ⇒ **未 spawn 任何进程**。` +
        `对策：检查组织目录根 ${parent} 的写权限，或换一个组织名。`,
    };
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorOf(err: unknown, fallbackCode: string): { code: string; message: string } {
  const code =
    typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
      ? ((err as { code: string }).code)
      : fallbackCode;
  return { code, message: errorMessage(err) };
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// 依赖注入面（单测据此断言，不真起桥）
// ---------------------------------------------------------------------------

export interface HostBridgeDeps {
  /** 进程拉起（缺省 = 平台原生形态，见 `host-process.ts`）。 */
  spawnBridge?: SpawnBridgeFn;
  /** 探活（缺省 = TCP 可连；口径见文件头「查」）。 */
  probePort?: ProbePortFn;
  /** 树杀（缺省 = win32 `taskkill /T /F` · POSIX 组杀）。 */
  killTree?: KillTreeFn;
  /** 空闲端口分配（缺省 = `listen(0)` 取一个再放开）。 */
  allocatePort?: AllocatePortFn;
  /** 适配器模块（测试注入；缺省按需从 `machineDistDir` 动态加载）。 */
  adapters?: AdaptersModule;
  /** machine 运行时产物目录（缺省由 `BOARD_MACHINE_DIST` / 仓根推导）。 */
  machineDistDir?: string;
  /**
   * 产物存在性检查（缺省 = {@link assertRuntimeArtifacts}，真查 `existsSync`）。
   * 测试注入桩 ⇒ 单测能在「不起桥」的前提下走完整起停路径；生产不注入即真查。
   */
  artifactCheck?: (distDir: string) => RuntimeArtifacts;
  /**
   * 目录三态探针（BD14 引入 · 缺省 = {@link statDirKind} 真查盘）：起桥**之前**探
   * `--workspace` 落点，结论决定「放行 / 板代建 / 建不出来」（BD15）。测试注入桩 ⇒ 单测继续在「不起真桥」的前提下跑。
   */
  dirKind?: DirKindProbeFn;
  /** 板侧私有台账；显式传 `null` ⇒ 纯内存（测试用）。 */
  ledger?: HostBridgeLedgerStore | null;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  termGraceMs?: number;
  startTimeoutMs?: number;
  /** 子进程环境基址（缺省 = `process.env`，再前置 machine 的 `node_modules/.bin`）。 */
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * 平台判定（缺省 = `process.platform`）—— 与 {@link createNodeSpawnBridge} / {@link createTreeKiller}
   * 的 `platform` 参数同风格：可注入 ⇒ 单测能在**任一平台**上钉住 win32 / POSIX 两条停桥分支
   * （win32 走「先整树杀」、POSIX 保持「先 SIGTERM 超时才树杀」原序）。
   */
  platform?: NodeJS.Platform;
}

interface ManagedBridge {
  org: string;
  workspace: string;
  kind: string;
  idleStopMs: number;
  mcpUrl: string;
  projectId: string;
  agentConfig: Record<string, unknown> | undefined;
  child: BridgeChildHandle | null;
  state: HostBridgeState;
  pid: number | null;
  port: number | null;
  inFlightRounds: number;
  startedAt: number | null;
  lastActivityAt: number | null;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null;
  error: { code: string; message: string } | null;
  /** 串行化「同一组织的起桥」，避免并发双起（同组织内轮次串行的进程侧保障）。 */
  starting: Promise<EnsureStartedResult> | null;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise<void>((res) => {
    setTimeout(res, ms).unref();
  });
}

// ---------------------------------------------------------------------------
// 托管器
// ---------------------------------------------------------------------------

/**
 * 一个板进程内持有 0..N 个组织宿主桥（**一组织一桥**；跨组织真并行、组织内轮次串行）。
 * 本类只管进程生命周期；对话轮（prompt / cancel / 结果回收）归下一节点。
 */
export class HostBridgeManager {
  private readonly bridges = new Map<string, ManagedBridge>();
  private readonly deps: HostBridgeDeps;
  private readonly ledger: HostBridgeLedgerStore | null;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private adaptersPromise: Promise<AdaptersModule> | null = null;

  constructor(deps: HostBridgeDeps = {}) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.delay = deps.delay ?? defaultDelay;
    this.ledger = deps.ledger === null ? null : (deps.ledger ?? new HostBridgeLedgerStore());
  }

  /** machine dist 目录（配置优先，缺省由仓根推导）—— **路径可配置**那条要求的落点。 */
  distDir(): string {
    return this.deps.machineDistDir ?? resolveMachineDistDir();
  }

  /**
   * **启动时检查存在性**（依赖解析要求）：产物缺失 ⇒ 抛 {@link HostRuntimeError}（清晰文案），不静默。
   * 返回检查到的绝对路径，供板如实显示耦合面状态。
   */
  checkRuntime(): RuntimeArtifacts {
    return this.artifacts();
  }

  /** 产物检查（可注入桩；缺省 = 真查 existsSync，缺失即抛清晰错误）。 */
  private artifacts(): RuntimeArtifacts {
    return (this.deps.artifactCheck ?? assertRuntimeArtifacts)(this.distDir());
  }

  private loadAdapters(): Promise<AdaptersModule> {
    if (this.deps.adapters !== undefined) return Promise.resolve(this.deps.adapters);
    if (this.adaptersPromise === null) {
      this.adaptersPromise = loadAdaptersModule(this.distDir()).catch((err: unknown) => {
        // 失败不缓存：补建 dist / 改配置后无需重建 manager 即可重试。
        this.adaptersPromise = null;
        throw err;
      });
    }
    return this.adaptersPromise;
  }

  private resolveConfig(config: HostBridgeConfig): ManagedBridge {
    const org = config.org.trim();
    if (org === "") throw new Error("组织名缺失：宿主桥按组织建，org 不可为空");
    if (config.workspace.trim() === "") throw new Error(`组织 ${org} 的 workspace（组织目录）缺失`);
    const existing = this.bridges.get(org);
    if (existing !== undefined) {
      // 起停口径以最新一次调用为准（kind / 阈值 / 目录可按组织覆盖）。
      existing.workspace = config.workspace;
      existing.kind = config.kind ?? DEFAULT_HOST_AGENT_KIND;
      existing.idleStopMs = config.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
      existing.mcpUrl = config.mcpUrl ?? defaultMcpUrlForOrg(org);
      existing.projectId = config.projectId ?? hostProjectId(org);
      existing.agentConfig = config.agentConfig;
      return existing;
    }
    const created: ManagedBridge = {
      org,
      workspace: config.workspace,
      kind: config.kind ?? DEFAULT_HOST_AGENT_KIND,
      idleStopMs: config.idleStopMs ?? DEFAULT_IDLE_STOP_MS,
      mcpUrl: config.mcpUrl ?? defaultMcpUrlForOrg(org),
      projectId: config.projectId ?? hostProjectId(org),
      agentConfig: config.agentConfig,
      child: null,
      state: "exited",
      pid: null,
      port: null,
      inFlightRounds: 0,
      startedAt: null,
      lastActivityAt: null,
      exitInfo: null,
      error: null,
      starting: null,
    };
    this.bridges.set(org, created);
    return created;
  }

  // -- 查 -------------------------------------------------------------------

  /** 结构化状态；组织未曾托管 ⇒ null（板侧显示「无宿主桥」，与「桥已断」区分）。 */
  statusOf(org: string): HostBridgeStatus | null {
    const b = this.bridges.get(org.trim());
    if (b === undefined) return null;
    const idleMs = b.lastActivityAt === null ? null : Math.max(0, this.now() - b.lastActivityAt);
    return {
      org: b.org,
      state: b.state,
      pid: b.pid,
      port: b.port,
      workspace: b.workspace,
      kind: b.kind,
      projectId: b.projectId,
      idleStopMs: b.idleStopMs,
      inFlightRounds: b.inFlightRounds,
      startedAt: b.startedAt === null ? null : toIso(b.startedAt),
      lastActivityAt: b.lastActivityAt === null ? null : toIso(b.lastActivityAt),
      idleMs,
      error: b.error,
      display: displayText(b, idleMs),
    };
  }

  /** 全部已托管组织的状态快照（板列表视图用）。 */
  statuses(): HostBridgeStatus[] {
    return [...this.bridges.keys()]
      .map((org) => this.statusOf(org))
      .filter((s): s is HostBridgeStatus => s !== null);
  }

  /**
   * **主动探活**（查的进程侧动作）：刷新一次状态并回结构化结果。
   * 进程在但端口连不上 ⇒ `unreachable` + 「宿主桥已断」；进程消失 ⇒ `exited`。
   */
  async health(org: string): Promise<HostBridgeStatus | null> {
    const b = this.bridges.get(org.trim());
    if (b === undefined) return null;
    if (b.child === null || b.child.exited()) {
      if (b.state === "running" || b.state === "starting") {
        b.state = "exited";
        b.error = {
          code: "bridge_exited",
          message: `桥进程已消失（pid=${String(b.pid)}，exit=${formatExit(b.exitInfo)}）`,
        };
        this.writeLedger(b, { stoppedAt: toIso(this.now()), stopReason: "exited" });
      }
      return this.statusOf(b.org);
    }
    const alive = b.port === null ? false : await this.probe(b.port);
    if (alive) {
      if (b.state !== "running") {
        b.state = "running";
        b.error = null;
      }
      return this.statusOf(b.org);
    }
    b.state = "unreachable";
    b.error = {
      code: "bridge_unreachable",
      message: `桥进程在（pid=${String(b.pid)}）但端口 :${String(b.port)} 不可连`,
    };
    return this.statusOf(b.org);
  }

  // -- 起 -------------------------------------------------------------------

  /**
   * **起**：确保该组织的桥在线（幂等 —— 在线即复用；进程消失 / 端口不可连 ⇒ 重拉）。
   * 起不来时**不抛**：返回 `ok = false` + `state = "failed"` 的结构化状态（§2.2-7 故障可见）。
   */
  async ensureStarted(config: HostBridgeConfig): Promise<EnsureStartedResult> {
    const b = this.resolveConfig(config);
    if (b.starting !== null) return b.starting;
    const task = this.doEnsure(b).then((reused) => ({
      ok: b.state === "running",
      reused,
      status: this.statusOf(b.org) ?? this.failedSnapshot(b),
    }));
    b.starting = task.finally(() => {
      b.starting = null;
    });
    return b.starting;
  }

  private async doEnsure(b: ManagedBridge): Promise<boolean> {
    if (b.child !== null && !b.child.exited() && b.port !== null) {
      if (await this.probe(b.port)) {
        b.state = "running";
        b.error = null;
        return true; // 复用，不新起进程
      }
      // 进程在但端口不通 ⇒ 判「桥已断」，先收干净再重拉（重拉后同 contextId 回退归下一节点）。
      b.error = { code: "bridge_unreachable", message: `端口 :${String(b.port)} 不可连 ⇒ 重拉` };
      await this.stopInternal(b, "restart_after_unreachable");
    } else if (b.child !== null) {
      await this.stopInternal(b, "restart_after_exit");
    }

    b.state = "starting";
    b.error = null;
    b.exitInfo = null;

    // BD14 ①：落点先查盘，**再**去加载适配器 / 分配端口 —— 目录不可用时连一次 import 都不必做。
    // BD15：组织子目录缺失在此被板代建（建根仍然越界 —— prepareWorkspace 只建一级）。
    const wsProblem = prepareWorkspace(b.workspace, this.dirKind());
    if (wsProblem !== null) {
      b.state = "failed";
      b.error = wsProblem;
      return false; // 建不出来 ⇒ 未 spawn 任何进程（板仍不建组织目录根）
    }

    let plan: BridgeLaunchPlan;
    try {
      plan = await this.buildPlan(b);
    } catch (err) {
      b.state = "failed";
      b.error = errorOf(err, "launch_plan_failed");
      return false;
    }

    const spawnBridge: SpawnBridgeFn = this.deps.spawnBridge ?? createNodeSpawnBridge();
    let child: BridgeChildHandle;
    try {
      child = spawnBridge({
        command: plan.command,
        args: plan.args,
        cwd: plan.workspace,
        env: buildChildEnv(dirname(this.distDir()), this.deps.baseEnv ?? process.env),
      });
    } catch (err) {
      b.state = "failed";
      b.error = { code: "spawn_failed", message: errorMessage(err) };
      return false;
    }

    const nowMs = this.now();
    b.child = child;
    b.pid = child.pid;
    b.port = plan.port;
    b.startedAt = nowMs;
    b.lastActivityAt = nowMs;
    b.inFlightRounds = 0;
    child.onExit((info) => {
      b.exitInfo = info;
    });
    if (child.exited()) b.exitInfo = child.exitInfo();

    if (await this.waitUntilReady(child, plan.port)) {
      b.state = "running";
      b.error = null;
      this.writeLedger(b, { stoppedAt: null, stopReason: null });
      return false;
    }

    // 起不来 / 中途消失：**先按 spawn 自身的失败事实归因**（BD14 —— win32 下 spawn 失败不发 exit，
    // 只把负 libuv errno 塞进 exitCode，故必须在读 exitInfo 之前先看 spawnError）。
    const died = child.exited();
    if (died && b.exitInfo === null) b.exitInfo = child.exitInfo();
    const spawnFailure = describeSpawnFailure({
      spawnError: child.spawnError?.() ?? null,
      cwd: plan.workspace,
      command: plan.command,
    });
    b.state = spawnFailure !== null ? "failed" : died ? "exited" : "failed";
    b.error =
      spawnFailure !== null
        ? { code: spawnFailure.code, message: spawnFailure.message }
        : died
          ? {
              code: "bridge_exited",
              message: `桥进程启动后即退出（exit=${formatExit(b.exitInfo)}），端口 :${String(plan.port)} 未就绪`,
            }
          : {
              code: "bridge_start_timeout",
              message: `等待端口 :${String(plan.port)} 就绪超时（${String(this.startTimeoutMs())}ms）`,
            };
    b.child = null;
    b.pid = null;
    b.port = null;
    this.writeLedger(b, { stoppedAt: toIso(this.now()), stopReason: b.error.code });
    return false;
  }

  private failedSnapshot(b: ManagedBridge): HostBridgeStatus {
    return this.statusOf(b.org) ?? {
      org: b.org,
      state: "failed",
      pid: null,
      port: null,
      workspace: b.workspace,
      kind: b.kind,
      projectId: b.projectId,
      idleStopMs: b.idleStopMs,
      inFlightRounds: b.inFlightRounds,
      startedAt: null,
      lastActivityAt: null,
      idleMs: null,
      error: b.error ?? { code: "unknown", message: "未知失败" },
      display: `${b.org} ${HOST_BRIDGE_DOWN_MESSAGE}`,
    };
  }

  private async buildPlan(b: ManagedBridge): Promise<BridgeLaunchPlan> {
    this.artifacts(); // 缺失即抛，文案见 host-runtime（清晰报错、不静默）
    const adapters = await this.loadAdapters();
    // **板内 `getAdapter()` 的唯一调用点**（test/host-bridge.test.mjs 以源码扫描钉住）。
    const adapter = adapters.getAdapter(b.kind);
    if (adapter === undefined || typeof adapter.buildLaunch !== "function") {
      throw new Error(
        `未知宿主后端 kind "${b.kind}"：machine 适配器注册表无此项（kind 值域事实源 = getAdapter()，板不复制映射表）`,
      );
    }
    const port = await (this.deps.allocatePort ?? (() => allocateFreePort()))();
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`分配到的端口非法：${String(port)}`);
    }
    return buildBridgeLaunchPlan(
      adapter,
      {
        org: b.org,
        workspace: b.workspace,
        projectId: b.projectId,
        agentConfig: b.agentConfig,
      },
      port,
      b.mcpUrl,
    );
  }

  private startTimeoutMs(): number {
    return this.deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  }

  /** 目录三态探针（缺省真查盘；注入桩只为让单测不必造真目录）。 */
  private dirKind(): DirKindProbeFn {
    return this.deps.dirKind ?? statDirKind;
  }

  /** 平台判定（缺省 `process.platform`；可注入 ⇒ 单测钉住停桥两条分支）。 */
  private platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private async probe(port: number): Promise<boolean> {
    const probePort: ProbePortFn = this.deps.probePort ?? ((p: number) => probeTcpPort(p));
    return probePort(port);
  }

  private async waitUntilReady(child: BridgeChildHandle, port: number): Promise<boolean> {
    const deadline = this.now() + this.startTimeoutMs();
    for (;;) {
      if (await this.probe(port)) return true;
      if (child.exited()) return false;
      if (this.now() >= deadline) return false;
      await this.delay(START_POLL_MS);
    }
  }

  // -- 停 -------------------------------------------------------------------

  /**
   * **停**：win32 / POSIX 两条停法（平台可注入，见 {@link HostBridgeDeps.platform}）。
   *
   * - **win32**：板 spawn 的是 `cmd.exe → 桥 → 后端` 三层，`SIGTERM` 只够到 cmd 壳
   *   （壳一走 `waitExit` 立即为真，父链消失后真正的 node 孙与后端树全成孤儿 —— 2026-09-28 T3 真机实测）。
   *   ⇒ **放弃 SIGTERM 宽限窗**（修法 A）：先 `killTree(pid)` 整树杀（复用 {@link createTreeKiller}），
   *   再 `child.kill` 补一刀，最后 `waitExit` **确认退出**；**确认后才记台账** `exited/pid:null`。
   * - **POSIX**：原语义逐字不动（`detached:true` 进程组语义与 Windows 不同，组杀本就能覆盖后端孙进程）。
   */
  async stop(org: string, reason = "manual"): Promise<HostBridgeStatus | null> {
    const b = this.bridges.get(org.trim());
    if (b === undefined) return null;
    await this.stopInternal(b, reason);
    return this.statusOf(b.org);
  }

  private async stopInternal(b: ManagedBridge, reason: string): Promise<void> {
    const child = b.child;
    const pid = b.pid;
    if (child !== null && !child.exited() && pid !== null) {
      if (this.platform() === "win32") {
        // win32：整树杀在前（此时父 cmd 壳还活着，`taskkill /T` 才够得到 node 孙与后端）。
        const confirmed = await this.stopWin32(child, pid);
        if (!confirmed) {
          // 未确认退出 ⇒ **不记** `exited/pid:null`（否则台账谎报「已收」，残余孤儿无人追；不新增状态）。
          b.error = {
            code: "bridge_stop_unconfirmed",
            message: `整树杀与信号已发，但桥进程（pid=${String(pid)}）未确认退出 ⇒ 台账不记为已收`,
          };
          return;
        }
      } else {
        await this.stopPosix(child, pid);
      }
    }
    b.child = null;
    b.pid = null;
    b.port = null;
    b.state = "exited";
    b.inFlightRounds = 0;
    this.writeLedger(b, { stoppedAt: toIso(this.now()), stopReason: reason });
  }

  /** win32 停法：先整树杀 → 补一刀 → 确认；返回「是否确认退出」。 */
  private async stopWin32(child: BridgeChildHandle, pid: number): Promise<boolean> {
    const graceMs = this.deps.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
    const killTree: KillTreeFn = this.deps.killTree ?? createTreeKiller(this.platform());
    await killTree(pid); // 父链活着时整树杀（覆盖 cmd 壳 → node 桥 → 后端）
    child.kill("SIGTERM"); // 补一刀
    return this.waitExit(child, graceMs); // 确认退出后才记台账
  }

  /** POSIX 停法（**原语义逐字不动**）：先 `SIGTERM` 优雅优先，`termGraceMs` 内没退才树杀。 */
  private async stopPosix(child: BridgeChildHandle, pid: number): Promise<void> {
    const graceMs = this.deps.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
    child.kill("SIGTERM"); // 优雅优先
    if (!(await this.waitExit(child, graceMs))) {
      const killTree: KillTreeFn = this.deps.killTree ?? createTreeKiller();
      await killTree(pid); // 超时 ⇒ 树杀（覆盖后端那一层）
      await this.waitExit(child, graceMs);
    }
  }

  private async waitExit(child: BridgeChildHandle, timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    while (!child.exited()) {
      if (this.now() >= deadline) return false;
      await this.delay(STOP_POLL_MS);
    }
    return true;
  }

  // -- 在飞轮数 / 空闲回收 ---------------------------------------------------

  /**
   * **在飞轮数记账**（对话轮节点调用）：`beginRound` 抬计数 ⇒ 期间**绝不回收**；
   * `endRound` 落计数并把 `lastActivityAt` 推到当下 ⇒ 空闲计时从轮次结束起算。
   */
  beginRound(org: string): void {
    const b = this.bridges.get(org.trim());
    if (b === undefined) return;
    b.inFlightRounds += 1;
    b.lastActivityAt = this.now();
  }

  endRound(org: string): void {
    const b = this.bridges.get(org.trim());
    if (b === undefined) return;
    b.inFlightRounds = Math.max(0, b.inFlightRounds - 1);
    b.lastActivityAt = this.now();
  }

  /** 该组织此刻是否应回收（暴露判据与原因，供板显示「为什么不收」）。 */
  reclaimDecision(org: string): IdleReclaimDecision | null {
    const b = this.bridges.get(org.trim());
    if (b === undefined) return null;
    const idleMs = b.lastActivityAt === null ? null : Math.max(0, this.now() - b.lastActivityAt);
    return decideIdleReclaim({
      idleStopMs: b.idleStopMs,
      inFlightRounds: b.inFlightRounds,
      idleMs,
    });
  }

  /**
   * **空闲回收 sweep**（由板侧定时器调用；本节点不自行起定时器 ⇒ 不留常驻句柄）。
   * 返回本轮实际回收的组织清单；在飞 > 0 与 `idleStopMs = 0`（常驻）的组织**不出现在结果里**。
   */
  async sweepIdle(): Promise<string[]> {
    const reclaimed: string[] = [];
    for (const b of [...this.bridges.values()]) {
      if (b.child === null || b.child.exited()) continue;
      const decision = this.reclaimDecision(b.org);
      if (decision !== null && decision.reclaim) {
        await this.stopInternal(b, decision.reason);
        reclaimed.push(b.org);
      }
    }
    return reclaimed;
  }

  /** 收尾：停掉所有在线桥（板进程退出路径调用，**不留常驻进程**）。 */
  async stopAll(reason = "shutdown"): Promise<void> {
    for (const b of [...this.bridges.values()]) {
      if (b.child !== null && !b.child.exited()) await this.stopInternal(b, reason);
    }
  }

  // -- 台账 -----------------------------------------------------------------

  /**
   * 板侧私有台账（本地文件，**不用引擎 `features` 表**）。
   * 只写进程生命周期字段；**CLI 会话句柄与文档路径由对话轮节点经同一 upsert 追加**，
   * 本方法不覆盖它们（`upsertHost` 的数组是追加语义）。
   */
  private writeLedger(b: ManagedBridge, extra: { stoppedAt?: string | null; stopReason?: string | null }): void {
    if (this.ledger === null) return;
    const patch: HostBridgePatch = {
      org: b.org,
      pid: b.pid,
      port: b.port,
      workspace: b.workspace,
      kind: b.kind,
      mcpUrl: b.mcpUrl,
      startedAt: b.startedAt === null ? null : toIso(b.startedAt),
      stoppedAt: extra.stoppedAt ?? null,
      stopReason: extra.stopReason ?? null,
    };
    try {
      this.ledger.update(patch);
    } catch {
      // 台账写失败不得把「桥在跑」伪装成「桥起不来」：状态仍由内存侧给出，
      // 但降级必须可见 ⇒ 挂到 error 上（不改 state，进程确实活着）。
      b.error = b.error ?? {
        code: "ledger_write_failed",
        message: `宿主桥台账写入失败：${this.ledger.file}`,
      };
    }
  }
}

function formatExit(info: { code: number | null; signal: NodeJS.Signals | null } | null): string {
  if (info === null) return "未知";
  return `code=${String(info.code)} signal=${String(info.signal)}`;
}

function displayText(b: ManagedBridge, idleMs: number | null): string {
  const head = `${b.org}（${b.kind} · ${b.projectId}）`;
  switch (b.state) {
    case "running":
      return idleMs === null
        ? `${head} 宿主桥在线 :${String(b.port)}`
        : `${head} 宿主桥在线 :${String(b.port)}（空闲 ${String(Math.floor(idleMs / 1000))}s）`;
    case "starting":
      return `${head} 宿主桥启动中 :${String(b.port)}`;
    case "unreachable":
      return `${head} ${HOST_BRIDGE_DOWN_MESSAGE}：进程在（pid=${String(b.pid)}）但端口 :${String(b.port)} 连不上`;
    case "exited":
      return b.error !== null
        ? `${head} ${HOST_BRIDGE_DOWN_MESSAGE}：${b.error.message}`
        : `${head} 宿主桥已收（退出信息 ${formatExit(b.exitInfo)}）`;
    case "failed":
    default:
      return `${head} ${HOST_BRIDGE_DOWN_MESSAGE}：${b.error?.code ?? "unknown"} ${b.error?.message ?? "起不来"}`;
  }
}
