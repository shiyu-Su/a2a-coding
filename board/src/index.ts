/**
 * board 服务启动入口（BD1 骨架 + BD7 写面配置 + BD8 宿主面装配 + BD10 配置面无兜底 + BD11 组织名进表单
 * + **BD12″ 配置化** + **BD13″ 服务化**：pidfile 自写 / 行级时间戳日志 / SIGINT·SIGTERM 与 `POST /shutdown` 共用优雅停机链）。
 *
 * **BD12″ 起配置只从文件读**（用户裁定：「需要配置文件、template、default，而非启动参数」）：
 * 生效配置 = `config/config.json`（活配置，gitignored；模板 `config.json.default` 逐项标注），
 * 启动期读一次（热改不生效、须重启）；**env `BOARD_CONFIG` 只覆盖配置文件路径**，
 * argv 与其余 `BOARD_*` env 一律**不再承载配置内容**（`--port` / `--orgs-dir=` / `--group=` /
 * `--host-kind=` 等通道已撤掉）。加载与校验见 `config.ts`；非法配置以 `[config] …` 文案 fail-fast。
 *
 * 各键语义与缺省（与 BD12″ 之前逐项一致，只挪通道不改语义）：
 * - `port`：缺省 3400；绑定地址**恒为 loopback**（`host` 可覆盖为 `::1` / `localhost`，非 loopback 一律拒起）。
 * - **组织名（BD11 起 = 用户在前台创建/指定）**：主来源是**提需求表单**的 `group` 字段（第一次填写某组织名
 *   = 在板上创建该组织）。配置文件里的 `group` 是**可选默认组织**：表单留空时才用它，**缺失不报错** ——
 *   校验点在**请求期**（表单空 ∧ 无默认 ⇒ `POST /requirements` 结构化 400 `board_group_required`，
 *   不猜、不回落）。宿主面在桥侧 `ownerGroup` 也为空时仍回退该默认，两者皆无 ⇒ 结构化 503
 *   `board_org_not_resolved`。
 * - `orgsDir`（组织目录根，BD8）：**刻意没有缺省值**（§3.8 裁定 9：板不可静默挑一个目录去 spawn 后端进程）
 *   ⇒ 未配置时宿主面不装配，`GET /host` 如实显示「宿主面未装配」，两条宿主写端点返回结构化 503。
 * - `hostKind`：宿主后端 kind，缺省 `claude`；`bridgeUrl` / `mcpBaseUrl`：读面桥 / 写面 MCP 基址；
 *   `machineDist`：machine 运行时产物目录，缺省按仓根推导；`turnTimeoutMs`：单轮有界等待，未配交 BD4b 缺省。
 */
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createBoardServer } from "./server.js";
import { loadConfig, CONFIG_PATH_ENV, readLegacyReleasedVersions } from "./config.js";
import {
  HostBridgeManager,
  defaultMcpUrlForOrg,
  type HostBridgeConfig,
} from "./host-bridge.js";
import { HostTurnManager, createHostBridgeGateway } from "./host-turn.js";
import { createHostFace, orgBridgeConfig, type BoardHostFace } from "./host-face.js";
import {
  createBridgeClient,
  createEngineVersionsFetcher,
  type EngineVersionsFetcher,
  type EngineVersionsOutcome,
} from "./bridge-client.js";
import { projectionLedgerOf } from "./web/views.js";
import type { ChainStateSnapshot } from "./derive.js";
import type { EngineStateProbe, HostRelay } from "./host-relay.js";
import { SuspendLedgerStore, defaultSuspendLedgerFile } from "./suspend-ledger.js";
import { type Heartbeat, createHeartbeat } from "./heartbeat.js";
import { OrgsLedgerStore, defaultOrgsLedgerFile, findOrgRecord, isOrgDisabled as ledgerIsOrgDisabled } from "./orgs-ledger.js";
import {
  VersionsLedgerStore,
  defaultVersionsLedgerFile,
  defaultVersionsSentinelFile,
  migrateLedgerOrgs,
  migrateReleasedVersions,
  releasedVersionLabels,
  type VersionsLedger,
} from "./versions-ledger.js";
import { readVersion } from "./version.js";
import { patchStreamTimestamp } from "./log.js";
import { createFatalRecorder, defaultFatalLogPath } from "./fatal-log.js";
import {
  buildPidRecord,
  createShutdownChain,
  defaultPidfilePath,
  writePidfile,
} from "./lifecycle.js";

/** 板根（`dist/` 的上一级）：pidfile 与致命日志都按它定位（不依赖 cwd、不依赖配置已解析）。 */
const boardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * **启动期致命记录器**（BD19 · 缺陷②）—— 对象本身无进程副作用（测试 import 本模块也拿得到一个
 * 没人调用的记录器），**真正安装 `uncaughtException` / `unhandledRejection` 钩子在
 * {@link installBootstrapGuards}，且只在直跑入口时装**。
 */
const fatal = createFatalRecorder({ file: defaultFatalLogPath(boardRoot) });

/**
 * 启动失败的**唯一**出口：先用致命记录器落一条（logger 未就绪 ⇒ `board.fatal.log`），再以 1 退出。
 *
 * ⚠ 装钩子会**吞掉** Node 的默认行为（默认 = 打 stderr 后以 1 死掉），所以这里必须把「退出 1」
 * 显式补回来 —— 否则「启动失败却还活着」会变成新的不可观测面。
 */
function failStartup(err: unknown, source: string): never {
  if (fatal.record(source, err) === "lost") {
    // 两条通道都写不出去（盘不可写）⇒ 至少别再吞掉这一次崩溃
    process.stderr.write(`board 启动失败（且致命日志不可写）：${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
}

/** 进程级钩子：**只由直跑入口调用**（测试进程 import 时零挂钩）。 */
function installBootstrapGuards(): void {
  fatal.setPhase("模块加载完成 · bootstrap");
  process.on("uncaughtException", (err: unknown) => failStartup(err, "uncaughtException"));
  process.on("unhandledRejection", (reason: unknown) => failStartup(reason, "unhandledRejection"));
}


/**
 * 链状态快照的**内存态源**（v0.9.5 增补二 · D2）。三者在装配序列里都晚于宿主面诞生，
 * 故用一个可变盒晚绑定（闭包在渲染时才读 ⇒ 装配期顺序无关）。
 */
export interface ChainSnapshotSources {
  relay: HostRelay | null;
  ledger: SuspendLedgerStore | null;
  heartbeat: Heartbeat | null;
}

/**
 * **组装详情页「链状态」一行的只读快照**（D2 · 件2）：三处内存态归一，**不写任何状态**。
 * - 停链标志在 ⇒ `stopped`（带原因 + 来源；`pendingCount` 取挂起条目，读不到 ⇒ `null`）；
 * - 无停链标志但有挂起条目 / 自动 armed 目标 ⇒ `monitoring`（`pendingCount` = 条目 pending 条数；
 *   自动 armed 无条目 ⇒ `0` = 纯 DAG 监视）；
 * - 三者皆无该需求的知识 ⇒ `null` ⇒ 读面**不渲染该行**（不臆造「监视中」）。
 */
export function composeChainSnapshot(
  sources: ChainSnapshotSources,
  featureId: string,
): ChainStateSnapshot | null {
  const id = featureId.trim();
  if (id === "") return null;
  const entry = sources.ledger?.get(id) ?? null;
  const pendingCount = entry === null ? null : entry.pending.length;
  const stop = sources.relay?.stopView(id) ?? null;
  if (stop !== null) {
    return { chainState: "stopped", reason: stop.reason, source: stop.source, pendingCount };
  }
  if (entry === null && sources.heartbeat?.isAutoArmed(id) !== true) return null;
  return { chainState: "monitoring", reason: null, source: null, pendingCount: pendingCount ?? 0 };
}

/** 启动日志「已发版锁定」一行的产出（v0.10.0 尾段 N2）。 */
export interface StartupReleasedVersions {
  /** 「版本（组织）」标签清单 —— `(org, version)` 是唯一键，光版号会跨组织混淆（口径 32）。 */
  labels: string[];
  /** 数据源的如实标注（写进日志括注，读者须知道清单来自哪一档）。 */
  sourceNote: string;
  /** 非 `null` ⇒ 启动期没读到引擎投影，本串作为 warn 原样输出（**不阻断启动**）。 */
  degraded: string | null;
}

/**
 * 启动日志的已发版清单读取（v0.10.0 尾段 N2 · 换源）：事实源 = **引擎版本台账**，
 * 一次性打 `GET <mcpBaseUrl>/api/versions`；**启动期桥不可达不得让启动崩** ——
 * 读不到 ⇒ 清单退板本地台账**读缓存**并如实标出（口径同 N1 版本列 / B4 门户的降级档）。
 *
 * 本函数**只出日志**，不判锁：已发版锁的**执法**仍在写口按 fail-closed 走（拿不到投影 ⇒ 挡排期写、
 * **锁只紧不松**，见 `server.ts` 的 `versionProjectionOf`），故此处降级不会放松任何锁。
 */
export async function readStartupReleasedVersions(input: {
  engineVersions: EngineVersionsFetcher;
  localLedger: () => VersionsLedger;
  localLedgerFile: string;
}): Promise<StartupReleasedVersions> {
  let outcome: EngineVersionsOutcome;
  try {
    outcome = await input.engineVersions();
  } catch (err) {
    // 注入面按契约不抛（`createEngineVersionsFetcher` 全档收口为 outcome）；本兜底只为
    // 「启动不许崩」这条硬约束兜住第三方注入的读取器，根因照样如实点出。
    outcome = { kind: "absent", code: "versions_fetch_threw", error: err instanceof Error ? err.message : String(err) };
  }
  if (outcome.kind === "projection") {
    return {
      labels: releasedVersionLabels(projectionLedgerOf(outcome.projection)),
      sourceNote: "引擎版本台账 GET /api/versions 的 released 条目（v0.10.0 起事实源在引擎）",
      degraded: null,
    };
  }
  return {
    labels: releasedVersionLabels(input.localLedger()),
    sourceNote: `**降级读缓存** = 板本地版本台账 ${input.localLedgerFile}（启动期未读到引擎投影）`,
    degraded:
      `引擎版本台账投影启动期不可读（${outcome.code} · ${outcome.error}）⇒ 「已发版锁定」清单退到板本地台账读缓存。` +
      "锁的**执法**仍按 fail-closed 判（写口拿不到投影 ⇒ 挡排期写，锁只紧不松），本档不影响启动",
  };
}

/**
 * 装配宿主面（BD8）：BD4a 托管器 + BD4b 轮次 + {@link BoardHostFace} 接线。
 * `orgsDir = null` ⇒ 直接返 `null`（不建任何托管器 ⇒ 板不会去 spawn 任何进程）。
 */
export function buildHostFace(input: {
  orgsDir: string | null;
  defaultOrg: string | null;
  kind: string;
  mcpBaseUrl: string;
  machineDist: string;
  turnTimeoutMs?: number;
  /**
   * **宿主后端模型**（v0.9.5 hostModel）：可选；有值 ⇒ 经 faceDeps 透传为起桥 `agentConfig.model`。
   * 缺省 / `null` ⇒ 不注入（后端自身缺省）。既有调用方不传 ⇒ 零改动。
   */
  hostModel?: string | null;
  /**
   * **停用闸判据**（v0.9.4 A4 · BD3）：注入 `isOrgDisabled` ⇒ {@link orgBridgeConfig} 命中停用台账即拒
   * （不起桥、不 spawn）。事实源 = 板组织台账（由 main 建单一 {@link OrgsLedgerStore} 后注入），
   * 与板 HTTP 写面读同一份文件；未注入 ⇒ 不判停用（保持 BD1–BD2 期间行为）。
   */
  isOrgDisabled?: (org: string) => boolean;
  /**
   * **本组织 agent 配置现读闭包**（v0.9.8 · 按项目组配 agent）：单闭包一次读台账同时返回
   * {kind, model} 两键（不拆两次读）；未注入 ⇒ 起桥取值恒全局（逐字节同 v0.9.7）。
   */
  orgHostAgent?: (org: string) => { kind: string | null; model: string | null };
  /**
   * **v0.9.5 C3 只读引擎态探针**：接力的点火判据（收口后一跳 `getFeature` 重取
   * `state/stage/approval`）。由 `main()` 用读面 `BridgeClient` 装配后传入；
   * 未注入 ⇒ 接力决策判不了引擎态 ⇒ 保守停链（既有行为不变）。
   */
  engineProbe?: EngineStateProbe | null;
  /**
   * **v0.9.5 增补二 · D2 链状态只读快照**：详情页「链状态」一行的事实源（relay + 挂起台账 + 心跳
   * 三处内存态归一）。由 `main()` 传入晚绑定闭包；未注入 ⇒ 宿主面回落 relay 内存态（更小快照）。
   */
  chainSnapshot?: (featureId: string) => ChainStateSnapshot | null;
}): { face: BoardHostFace; bridges: HostBridgeManager } | null {
  if (input.orgsDir === null) return null;
  const faceDeps = {
    orgsDir: input.orgsDir,
    defaultOrg: input.defaultOrg,
    kind: input.kind,
    ...(input.turnTimeoutMs !== undefined ? { turnTimeoutMs: input.turnTimeoutMs } : {}),
    ...(input.hostModel !== undefined ? { hostModel: input.hostModel } : {}),
    ...(input.isOrgDisabled !== undefined ? { isOrgDisabled: input.isOrgDisabled } : {}),
    ...(input.orgHostAgent !== undefined ? { orgHostAgent: input.orgHostAgent } : {}),
    ...(input.engineProbe !== undefined ? { engineProbe: input.engineProbe } : {}),
    ...(input.chainSnapshot !== undefined ? { chainSnapshot: input.chainSnapshot } : {}),
    mcpUrlFor: (org: string) => defaultMcpUrlForOrg(org, input.mcpBaseUrl),
  };
  const bridges = new HostBridgeManager({ machineDistDir: input.machineDist });
  const gateway = createHostBridgeGateway(bridges, (org) => {
    const config = orgBridgeConfig(faceDeps, org);
    if ("error" in config) {
      // 触发路径先查配置、不会走到这里；兜底只为「轮内重拉桥」时同样**不回落任何目录**。
      throw new Error(`${config.error.code}: ${config.error.message}`);
    }
    return config as HostBridgeConfig;
  });
  const turns = new HostTurnManager({ gateway });
  return { face: createHostFace({ ...faceDeps, bridges, turns }), bridges };
}

async function main(): Promise<void> {
  // BD13″ 行级时间戳：入口直跑才包装 stdout/stderr（import 方 = 测试进程，零副作用）；
  // console.* 走同一 write 出口，一并带时间戳落 board.log。
  fatal.setPhase("日志流包装");
  patchStreamTimestamp(process.stdout);
  patchStreamTimestamp(process.stderr, () => "error");
  fatal.setPhase("配置加载");
  const cfg = loadConfig();
  const group = cfg.group;
  const orgsDir = cfg.orgsDir;
  // 板组织台账（v0.9.4 A1/A3）：单进程单写手 ⇒ 建 ONE store，宿主面停用闸与 HTTP 写面读同一份文件。
  const orgsLedgerFile = defaultOrgsLedgerFile();
  const orgsLedger = new OrgsLedgerStore(orgsLedgerFile);
  // 板版本台账（v0.9.4 N1）：一次性迁移 config `releasedVersions` → 台账 released（启动前置、fail-fast）。
  // 灌入失败 ⇒ 抛出 ⇒ failStartup 拒起板（防已发版锁静默消失）。
  // v0.10.0 B1：迁移边界 = **独立哨兵**（`.data/versions.migrated.json`），**不复用台账 `exists()`**
  // —— 台账「存在」≠「非空」（空台账 / 坏文件 load 按空台账起 ⇒ 残留键会被再次灌入 = 假绿）。
  // 哨兵缺失 ⇒ 视同未迁移（v0.9.4 既有部署升级日即此形态，首启完成迁移后补立）；残留键档每次启动 warn（事实提醒，直至整键删除）。
  // v0.9.4 N3：`releasedVersions` 已从 BoardConfig 退役（运行时锁改读台账）⇒ 迁移输入经 `readLegacyReleasedVersions`
  // 直接从配置文件读历史键（唯一读取点）。
  fatal.setPhase("版本台账迁移");
  const versionsLedgerFile = defaultVersionsLedgerFile();
  const versionsLedger = new VersionsLedgerStore(versionsLedgerFile, defaultVersionsSentinelFile());
  const versionMigration = migrateReleasedVersions({
    releasedVersions: readLegacyReleasedVersions(cfg.sourcePath),
    store: versionsLedger,
    now: new Date().toISOString(),
  });
  if (versionMigration.warning !== null) {
    process.stderr.write(`警告：${versionMigration.warning}\n`);
  }
  if (versionMigration.migrated.length > 0) {
    process.stdout.write(
      `版本台账一次性迁移：config releasedVersions（${versionMigration.migrated.join(" · ")}）已灌入 ${versionsLedgerFile}（status=released）\n`,
    );
  }
  // v0.9.6 B1（口径 32）：台账组织维度一次性迁移 —— 串接在 releasedVersions 灌入之后，
  // 判据 = 条目缺 `org` 键 ⇒ stamp 为 config 的 group；未配 group ⇒ 一次性 warn + 留空串桶（**不 fail-fast**）。
  // 无缺 org 条目 ⇒ 幂等空操作（不落盘，重启不重复 stamp）。
  let orgBucketedCount = 0;
  {
    const before = versionsLedger.load();
    const orgMigration = migrateLedgerOrgs(before.ledger, group, new Date().toISOString());
    if (orgMigration.stamped.length > 0) {
      versionsLedger.save(orgMigration.ledger);
      process.stdout.write(
        `版本台账一次性迁移：${orgMigration.stamped.length} 条缺组织维度的条目已 stamp 为默认组织（${orgMigration.stamped.join(" · ")}），落 ${versionsLedgerFile}\n`,
      );
    }
    orgBucketedCount = orgMigration.bucketed.length;
    if (orgMigration.warning !== null) {
      process.stderr.write(`警告：${orgMigration.warning}\n`);
    }
  }
  // 哨兵收尾：本轮迁移链路**成功走完**（含空操作档）⇒ 落哨兵（一次性迁移此后不再重跑）。
  // seedReleased 写失败已在上方抛出拒起板 ⇒ 走到这里落哨兵不会把失败记成完成；写失败同样抛出（fail-fast）。
  if (!versionsLedger.migrationDone()) {
    versionsLedger.markMigrationDone(
      `migrated=${versionMigration.migrated.length} residual=${versionMigration.residual.length} orgBucketed=${orgBucketedCount}`,
    );
  }
  fatal.setPhase("宿主面装配");
  // v0.9.5 C3：只读引擎态探针 = 读面 BridgeClient 的一跳 getFeature（GET-only 硬约束不动）。
  // 与 HTTP 读面共用同一客户端实例（同一 baseUrl），不新增出网面。
  const readClient = createBridgeClient({ baseUrl: cfg.bridgeUrl });
  const engineProbe: EngineStateProbe = {
    async fetchEngineState(featureId: string) {
      const detail = await readClient.getFeature(featureId);
      return {
        state: detail.feature.state,
        stage: detail.feature.stage,
        approval: detail.feature.approval,
      };
    },
  };
  // v0.9.5 增补二 · D2：链状态快照的三处内存态源（宿主面 → 台账 → 接力 → 心跳 的装配顺序里
  // 后三者都晚于宿主面诞生 ⇒ 用可变盒晚绑定，闭包在页面渲染时才读）。
  const chainSources: ChainSnapshotSources = { relay: null, ledger: null, heartbeat: null };
  const hostFace = buildHostFace({
    orgsDir,
    defaultOrg: group,
    kind: cfg.hostKind,
    mcpBaseUrl: cfg.mcpBaseUrl,
    machineDist: cfg.machineDist,
    ...(cfg.turnTimeoutMs !== null ? { turnTimeoutMs: cfg.turnTimeoutMs } : {}),
    ...(cfg.hostModel !== null ? { hostModel: cfg.hostModel } : {}),
    isOrgDisabled: (org) => ledgerIsOrgDisabled(orgsLedger.load().ledger, org),
    // v0.9.8 按项目组配 agent：单闭包一次读台账同时取 {kind, model}（照上条 isOrgDisabled 现读先例；
    // 装配点唯一 ⇒ 触发建桥与轮内重拉桥两条路同值）。
    orgHostAgent: (org) => {
      const rec = findOrgRecord(orgsLedger.load().ledger, org);
      return { kind: rec?.agentKind ?? null, model: rec?.agentModel ?? null };
    },
    engineProbe,
    // v0.9.5 增补二 · D2：链状态行只读快照（relay / 台账 / 心跳晚绑定，故用可变盒）
    chainSnapshot: (featureId) => composeChainSnapshot(chainSources, featureId),
  });
  fatal.setPhase("自动接力装配");
  // v0.9.5 C7/C8：suspended 台账**单进程单实例** —— 在起接力前建，供「挂起口写入（HTTP 侧）、
  // 接力决策查条目、心跳扫台账 / 记去重位」三处共用同一份内存事实源（`.data/suspended.json` 仅供取证）。
  const suspendLedger = new SuspendLedgerStore(defaultSuspendLedgerFile());
  chainSources.ledger = suspendLedger;
  // v0.9.5 C8：心跳实例（在 HTTP 监听后 start()；停机链**先 stop() 再 stopAll()**）。
  // 变量提前声明：接力的 onMonitor 通知是异步到达的，闭包经 `heartbeat?.` 晚绑定，避免构造期循环依赖。
  let heartbeat: Heartbeat | null = null;
  // v0.9.5 C1：起接力（幂等）——把轮收口回调接到接力驱动器。宿主面未装配 ⇒ 不起（不 spawn 任何进程）。
  // 接力日志经板日志出口留痕（决策 / 点火 / 停链）。
  const relayLog = (line: string): void => void process.stdout.write(`${line}\n`);
  const relay = hostFace?.face.startRelay({
    log: relayLog,
    // C8 规格④：显式挂起条目的查询只读挂接（分辨 MON1 显式挂起 / MON2 忘调挂起的自动 armed）。
    suspendLookup: (requirementId) => {
      const entry = suspendLedger.get(requirementId);
      return entry === null ? null : { pendingCount: entry.pending.length };
    },
    // C8：监视归属通知 ⇒ 心跳维护自动 armed 注册表（⑤ 兜底只对 auto 目标适用）。
    onMonitor: (notice) => heartbeat?.noteMonitor(notice),
  });
  chainSources.relay = relay ?? null;
  if (relay !== null && relay !== undefined) {
    process.stdout.write(
      "自动接力已装配：轮收口后按判定表决策（succeeded+执行中⇒进监视，不立即点火；awaiting/failed/timeout/canceled/reviewing/终态⇒交人停链）；链内连续点火上限 10（人工动作清零）；停链标志落内存、不跨重启\n",
    );
  }
  fatal.setPhase("HTTP 监听");
  // v0.9.5 C10：组织种子化 —— 建组织链落 `AGENTS.md`（模板渲染）+ `flow/spec` 三份规范快照，
  // 并在 createBoardServer 内 listen 前做幂等回填（只补缺不覆盖、逐组织 fail-open、跳过停用组织）。
  // `orgSeed` 省略 ⇒ 不种子化；生产入口（本文件）显式启用。
  process.stdout.write(
    "组织种子化已装配（v0.9.5 C10）：建组织落 AGENTS.md + flow/spec 快照；板启动幂等回填（只补缺不覆盖、逐组织 fail-open、跳过停用组织）\n",
  );
  const handle = await createBoardServer({
    host: cfg.host,
    port: cfg.port,
    client: readClient,
    bridge: { baseUrl: cfg.bridgeUrl },
    defaultGroup: group,
    mcpBaseUrl: cfg.mcpBaseUrl,
    hostFace: hostFace?.face ?? null,
    docs: { repoRoot: cfg.repoRoot, orgsDir: cfg.orgsDir },
    orgsLedgerFile,
    versionsLedgerFile,
    suspendLedgerStore: suspendLedger,
    orgSeed: { hostKind: cfg.hostKind },
    onShutdown: () => shutdown("POST /shutdown"),
  });
  process.stdout.write(
    `board v${readVersion()} 监听 http://${handle.host}:${handle.port}/（配置来源 = ${cfg.sourcePath}${CONFIG_PATH_ENV in process.env ? `（经 env ${CONFIG_PATH_ENV} 指定）` : ""}）\n`,
  );
  process.stdout.write(
    `生效值：port = ${cfg.port} · host = ${cfg.host} · 读面桥 = ${cfg.bridgeUrl} · MCP 基址 = ${cfg.mcpBaseUrl} · hostKind = ${cfg.hostKind} · machineDist = ${cfg.machineDist} · turnTimeoutMs = ${cfg.turnTimeoutMs ?? "未配置（下游缺省 10 min）"}\n`,
  );
  // v0.9.6 B1（口径 32）：启动日志的已发版清单**带组织维度**（`(org, version)` 是唯一键，光版号会跨组织混淆）。
  // v0.10.0 尾段 N2：清单的**数据源换到引擎版本台账**（一次性只读）；启动期桥不可达 ⇒ 退本地台账读缓存
  // + 如实 warn，**不阻断启动**（锁的执法仍在写口 fail-closed，本处只出日志）。
  const startupReleased = await readStartupReleasedVersions({
    engineVersions: createEngineVersionsFetcher({ baseUrl: cfg.mcpBaseUrl }),
    localLedger: () => versionsLedger.load().ledger,
    localLedgerFile: versionsLedgerFile,
  });
  if (startupReleased.degraded !== null) {
    process.stderr.write(`警告：${startupReleased.degraded}\n`);
  }
  if (startupReleased.labels.length > 0) {
    process.stdout.write(
      `已发版锁定：${startupReleased.labels.join(" · ")}（${startupReleased.sourceNote}）⇒ 提需求排入这些版本、以及排期写改入 / 改出（含清空）这些版本一律 409 board_version_released 拒绝（同锁版重提放行）；后台 POST /versions setStatus 直投标记 released / 重开为进行中实时生效（前台已撤该入口 · 增补十一 E3）\n`,
    );
  }
  if (group === null) {
    process.stdout.write(
      "未配默认组织（config.json 的 group）：不是错误 —— 组织名由提需求表单给出；未配默认时表单的组织名为必填，留空 ⇒ POST /requirements 结构化 400 board_group_required（不猜、不回落兜底组名）\n",
    );
  }
  if (hostFace === null) {
    process.stdout.write(
      "宿主面未装配：config.json 的 orgsDir 未配置（无缺省值，刻意不兜底）⇒ 不起桥、不触发一轮；触发端点返回结构化 503\n",
    );
  } else {
    // BD14：配了 orgsDir **不等于**落点可用 —— 目录不存在时这里必须出声，
    // 不能再照打「宿主面就绪」把问题推到第一次触发一轮（真机上曾以 502 + 负 errno 暴露）。
    const orgsDirProblem = hostFace.face.orgsDirProblem();
    if (orgsDirProblem !== null) {
      process.stderr.write(`警告：${orgsDirProblem.message}\n`);
      process.stderr.write(
        `宿主面已装配但**未就绪**：任何组织的触发一轮一律返回结构化 503 ${orgsDirProblem.code}（不起桥、不代建目录）\n`,
      );
    } else {
      process.stdout.write(`宿主面就绪：组织目录根 = ${orgsDir ?? "—"} · kind = ${cfg.hostKind}\n`);
    }
  }

  // BD13″ pidfile：**板自己写**（listening 之后），boardctl 只读；停机路径删。
  fatal.setPhase("pidfile 写入");
  const pidfilePath = defaultPidfilePath(boardRoot);
  if (writePidfile(pidfilePath, buildPidRecord({ port: handle.port, host: handle.host }))) {
    process.stdout.write(`pidfile：${pidfilePath}（pid=${process.pid}）\n`);
  }

  // BD19：走到这里 = 日志通道（`board.log` 重定向 + 行级时间戳）已可用 ⇒ 致命记录器**切正常日志**，
  // 之后的崩溃不再单开 `board.fatal.log`（那条通道只服务「logger 之前死掉」这一段）。
  fatal.markLoggerReady();

  // v0.9.5 C8 · T8：**心跳监视 + 唤醒点火**（板首个常驻句柄）——HTTP 监听后 start()，停机链先 stop()。
  // 依赖全为既有只读面：读面 BridgeClient（引擎态 / 子任务结果）+ suspended 台账 + 接力驱动器（只读链状态）
  // + host-bridge 的 sweepIdle（补其全仓无调用点的欠账，同拍驱动空闲回收）。
  // R2 规格③：心跳只读调用走 3300 只读运维面，**不调 beginRound / ensureStarted** —— 不刷新桥 lastActivityAt
  // （只有命中真正点火时经接力发轮，那是真实轮、理应刷新活动时间），故 idle 回收不被心跳干扰。
  if (relay !== null && relay !== undefined && hostFace !== null) {
    heartbeat = createHeartbeat({
      ledger: handle.suspendLedger,
      readEngine: async (featureId) => {
        const detail = await readClient.getFeature(featureId);
        return {
          state: detail.feature.state,
          stage: detail.feature.stage,
          approval: detail.feature.approval,
          ownerGroup: detail.feature.ownerGroup,
          // 发起改造轨：DAG 节点挂 Feature 下、引擎轨可见 ⇒ 直接投影 node state 供定条件评估。
          tasks: detail.tasks.map((t) => ({ taskId: t.taskId, state: t.state })),
        };
      },
      readTaskState: async (taskId) => {
        const task = await readClient.getTask(taskId);
        return task === null ? null : task.state;
      },
      fire: (input) => hostFace.face.wakeTurn(input),
      relay,
      // ⑥ 交人闸：板侧有「当前待澄清的一轮」⇒ 心跳不自火。判据 = awaitingTurnOf（含取代校验，
      // 与详情页回答框同源）；**不得**换成 latestTurnOf / 扫台账 —— 陈旧 awaiting 残留会把心跳永久焊死。
      awaitingHeld: (featureId) => hostFace.face.awaitingTurnOf(featureId) !== null,
      sweepIdle: () => hostFace.bridges.sweepIdle(),
      defaultOrg: group,
      log: relayLog,
    });
    chainSources.heartbeat = heartbeat;
    heartbeat.start();
    // 时间戳前缀按 write 落一个（`patchStreamTimestamp` 不拆行）⇒ 横幅每行必须各自一次 write，不得合并。
    process.stdout.write(
      "心跳监视已装配（v0.9.5 C8）：单 setInterval 扫 suspended 台账 + 自动 armed 目标；命中经接力点火" +
        "（同 contextId 新一轮，计入链内计数）；同条件只唤一次；顺带驱动 sweepIdle 空闲回收\n",
    );
    process.stdout.write("板侧口径：本需求有待澄清轮（等你回答）⇒ 心跳不自火，回答后下一拍照旧重评\n");
  }

  // BD13″ 优雅停机（SIGINT / SIGTERM 与 POST /shutdown **共用一条链**，重入幂等）：
  // 链的实现见 `lifecycle.createShutdownChain`（先停宿主桥 → 关卡口 → 删 pidfile）。
  //
  // **BD19 缺陷① · 全仓唯一的停机终点 `process.exit`**（`forceExit`）：
  // 既有纪律「主流程不 `process.exit`、只设 `exitCode`」防的是**运行期**退出码被 Windows 污染，
  // 而这里已是**停机终点**（链已走完：桥已停、口已关、pidfile 已删、日志已打），
  // 要的恰恰是「一定退得出去」的确定性 ⇒ 两者不冲突，且它仍排在 `setExitCode(0)` 之后、
  // 只在「链完成后仍未退出」时才介入（定时器 `unref()` ⇒ 正常收尾时压根轮不到它 fire）。
  // 启动失败那条 `process.exit(1)`（{@link failStartup}）是另一条路径，不是本闸。
  const shutdown = createShutdownChain({
    stopBridges: async () => {
      // R2 规格①（先后写死）：**先停心跳（clearInterval）再停桥（stopAll）** —— 否则停机途中心跳仍可能
      // 命中点火、把刚停的桥复活（`runJob → ensureBridge` 会重拉），只剩「等它自己停」的竞态。
      heartbeat?.stop();
      await hostFace?.bridges.stopAll("shutdown");
    },
    closeServer: () => handle.close(),
    pidfilePath,
    log: (line) => void process.stdout.write(line),
    forceExit: (code) => void process.exit(code),
  });
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

// 仅当作为脚本直接运行时启动（import 时不自启，便于测试）
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  // BD19：**钩子先于任何启动动作**装上 ⇒ 死在配置校验 / 宿主面装配 / 监听之前的那一段，
  // 也能留下 `board.fatal.log`（此前这一段是「零日志 + pidfile 不写 + boardctl 只报启动超时」）。
  installBootstrapGuards();
  main().catch((err: unknown) => failStartup(err, "main()"));
}
