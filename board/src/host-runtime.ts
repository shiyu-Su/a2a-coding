/**
 * 板对 machine **运行时产物**的依赖解析（v0.9.0 · BD4a）。
 *
 * 事实源：`doc/v0.9.0/Web看板与确认入口-改造文档.md` §3.4「kind 归一」行 ——
 * 板 spawn 宿主桥要吃的东西全在 `machine/dist/{acp-bridge, adapters}`，那是**构建产物**
 * （= 本版**已知耦合面**，登记在改造文档）。三件事在本文件收口：
 *
 * 1. **路径可配置**：`BOARD_MACHINE_DIST` env > 缺省 `<仓根>/machine/dist`（由本模块位置反推，
 *    源码运行与 `dist/` 运行都落在同一个仓根）；
 * 2. **启动时检查存在性**：`acp-bridge/index.js` 与 `adapters/index.js` 任一缺失 ⇒ 抛
 *    {@link HostRuntimeError}（**清晰报错、不静默失败** —— dist 未构建时最省事的做法是
 *    让 `import` 自己炸，那会把「machine 没 build」伪装成「宿主桥起不来」）。
 * 3. **目录存在性三态探针**（BD14 · {@link statDirKind}）：上面那条「缺什么就说什么」的清晰报错
 *    同样适用于**组织目录根**与**组织目录** —— 过去「配了但指向不存在的目录」与「配好」完全同形。
 *    消费方 = `host-face.ts`（组织根，触发前）与 `host-bridge.ts`（组织目录，spawn 前）。
 *
 * **`getAdapter` 的调用点不在本文件**（本文件只负责把模块**加载**进来）。
 * 见 {@link AdaptersModule}：加载后交 {@link ./host-bridge.ts} 使用 —— 板上
 * **`getAdapter(` 的唯一调用点**由 `test/host-bridge.test.mjs` 源码扫描钉住
 * （**kind 归一唯一事实源 = `getAdapter()`，板是消费方不是实现方**）。
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 桥进程入口（相对 `machine/dist`）—— 板 spawn 的就是它。 */
export const BRIDGE_ENTRY_REL = join("acp-bridge", "index.js");
/** 适配器入口（相对 `machine/dist`）—— `getAdapter(kind)` 的宿主模块。 */
export const ADAPTERS_ENTRY_REL = join("adapters", "index.js");

/** 覆盖 machine dist 目录的环境变量名。 */
export const MACHINE_DIST_ENV = "BOARD_MACHINE_DIST";

/** 仓根（`<board>/dist` 的上两级）。 */
function repoRootFromModule(metaUrl: string): string {
  // dist/host-runtime.js → dirname = <board>/dist → 上二级 = <仓根>
  return resolve(dirname(fileURLToPath(metaUrl)), "..", "..");
}

/**
 * machine dist 缺省落点：`BOARD_MACHINE_DIST` > `<仓根>/machine/dist`。
 * 参数化 `argv1Dir` 仅为可测；运行时不传。
 */
export function resolveMachineDistDir(
  env: NodeJS.ProcessEnv = process.env,
  metaUrl: string = import.meta.url,
): string {
  const fromEnv = env[MACHINE_DIST_ENV];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
  return join(repoRootFromModule(metaUrl), "machine", "dist");
}

/** 依赖解析失败（dist 未构建 / 路径配错 / 模块加载不了）—— 与运行期起桥失败区分开。 */
export class HostRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HostRuntimeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 目录存在性（BD14）—— 「配了但指向不存在的目录」与「配好」必须可区分
// ---------------------------------------------------------------------------

/**
 * 路径的三态闭集：BD14 的两级目录校验（组织根 / 组织目录）都只用到这三档。
 * `not_dir`（存在但是文件）与 `missing` 分开，是因为对策不同
 * （前者要移开那个文件，后者是要不要建 / 是不是组名拼错）。
 */
export type DirKind = "dir" | "not_dir" | "missing";

/** 目录探针（可注入）：单测据此喂三态，生产用 {@link statDirKind} 真查盘。 */
export type DirKindProbeFn = (path: string) => DirKind;

/**
 * 真查盘的三态探针。任何异常（权限 / 非法路径 / 名字过长）一律按 `missing` 算
 * —— 本函数的用途是「起后端进程之前先确认落点」，查不动就等于不能起，不得抛穿调用方。
 */
export function statDirKind(path: string): DirKind {
  try {
    return statSync(path).isDirectory() ? "dir" : "not_dir";
  } catch {
    return "missing";
  }
}

/** 产物存在性检查结果（纯函数，供单测直接断言文案）。 */
export interface RuntimeArtifacts {
  ok: true;
  distDir: string;
  bridgeEntry: string;
  adaptersEntry: string;
}

/**
 * 检查两个运行时产物在不在，缺哪些就在 message 里列哪些（**清晰报错**）。
 * 抛错文案固定含三件事：缺什么 / 期望路径 / 怎么补（`machine` 侧 `npm run build` 或改 env）。
 */
export function assertRuntimeArtifacts(distDir: string): RuntimeArtifacts {
  const bridgeEntry = join(distDir, BRIDGE_ENTRY_REL);
  const adaptersEntry = join(distDir, ADAPTERS_ENTRY_REL);
  const missing: string[] = [];
  if (!existsSync(bridgeEntry)) missing.push(bridgeEntry);
  if (!existsSync(adaptersEntry)) missing.push(adaptersEntry);
  if (missing.length > 0) {
    throw new HostRuntimeError(
      "machine_dist_missing",
      `machine 运行时产物缺失（${missing.length} 个）：${missing.join(" | ")} —— ` +
        "这些是构建产物，不是仓内源文件。请在 machine/ 执行 npm run build，" +
        `或用环境变量 ${MACHINE_DIST_ENV} 指向已构建的 machine/dist（当前解析目录 = ${distDir}）`,
    );
  }
  return { ok: true, distDir, bridgeEntry, adaptersEntry };
}

/** `adapter.buildLaunch()` 的产物（结构镜像 machine/adapters/types.ts，**不 import 它**）。 */
export interface AdapterLaunchSpec {
  command: string;
  args: string[];
}

/** `adapter.permission(risk)` 的产物。 */
export interface AdapterPermissionSpec {
  args: string[];
}

/** `buildLaunch` 的入参（同 machine `LaunchRequest`）。 */
export interface AdapterLaunchRequest {
  projectId: string;
  workspace: string;
  a2aPort: number;
  permissionArgs?: string[];
  agentConfig?: Record<string, unknown>;
}

/**
 * 单个 kind 适配器的**结构镜像**（本文件唯一持有；板不复刻映射表、不 import machine 源码）。
 * 只声明板要用的两个方法 —— `kind` 值域的**唯一事实源在 `getAdapter` 的注册表**，
 * 故板侧 kind 参数是 `string`，未知 kind 由 {@link AdaptersModule.getAdapter} 返回空来暴露。
 */
export interface AdapterLike {
  readonly kind: string;
  readonly protocol: string;
  buildLaunch(request: AdapterLaunchRequest): AdapterLaunchSpec;
  permission(risk: "read" | "write" | "full"): AdapterPermissionSpec;
}

/** `machine/dist/adapters/index.js` 的加载面（`getAdapter` 是板要的唯一出口）。 */
export interface AdaptersModule {
  getAdapter(kind: string): AdapterLike | undefined;
}

/**
 * 动态加载适配器模块（**运行时依赖**，故非静态 import —— 静态 import 会让板在 machine
 * 未构建时连自己的 typecheck/单测都跑不起来，且把耦合固化进编译期）。
 * 加载失败落 {@link HostRuntimeError}（`adapters_load_failed`），带原因。
 */
export async function loadAdaptersModule(distDir: string): Promise<AdaptersModule> {
  const { adaptersEntry } = assertRuntimeArtifacts(distDir);
  let mod: unknown;
  try {
    mod = (await import(pathToFileURL(adaptersEntry).href)) as unknown;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new HostRuntimeError(
      "adapters_load_failed",
      `machine 适配器模块加载失败：${adaptersEntry} —— ${reason}`,
    );
  }
  if (
    typeof mod !== "object" ||
    mod === null ||
    typeof (mod as { getAdapter?: unknown }).getAdapter !== "function"
  ) {
    throw new HostRuntimeError(
      "adapters_load_failed",
      `machine 适配器模块无 getAdapter 出口（构建产物与板期望不符）：${adaptersEntry}`,
    );
  }
  // 直接交回模块对象：**调用点只有一个，且在 `host-bridge.ts`**（板不自拼 argv）。
  return mod as AdaptersModule;
}
