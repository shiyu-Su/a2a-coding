/**
 * 适配器后端入口**自动解析**（REQ-v0.8.6-2026-09-21-02 · B1）。
 *
 * 职责：把「某个 `agentKind` 的 ACP 后端命令从哪来」收敛成一次**逐层探测**，
 * 命中即返回**真身绝对路径**（脚本入口 / `.exe` 真身），未命中返回分层清单。
 * 与 `backend-command.ts`（纯**形态归一**：`node <脚本>` 还是直调、无 fs、无 kind 知识）**正交串联**：
 * 本模块找到路径 → `resolveBackendSpawn` 决定启动形态。
 *
 * 四层（改造文档 §2.1 / §2.3，命中即停；qoder 纳表 ⇒ 四个 kind 全免手填）：
 * - **L0 显式** `agentConfig.backendCmd`（复用 `resolveAcpBackendCmd`，以显式值为准，但**必须存在且是文件**；
 *   被拒时**不回落下层**，直接以项目级失败收口 —— 显式覆盖是用户明示意图，不得静默降级）；
 * - **L1 机器本地** `machine/node_modules/<pkg>`；
 * - **L2 全局 npm** 固定候选表（免子进程：`NPM_CONFIG_PREFIX` + win `%APPDATA%/npm/node_modules`
 *   + posix `/usr/local/lib/node_modules`、`/usr/lib/node_modules`，按 root 去重）；
 * - **L3 PATH**（**仅当真身为可执行体**；三家 JS 适配器全局只有 `.cmd/.ps1` 壳 ⇒ 实质恒 `rejected-shell`）。
 * `qoder-cn` 无 npm 包，走 `knownPaths`（**具体文件白名单，非扫目录**，按平台选）+ L3 PATH（其 `.exe` 真身可命中）。
 *
 * **两条不许踩的铁律**（改造文档 §1.1 / §2.2）：
 * - `bin` **绝不回退 `main`** —— claude `main=dist/lib.js` 非 ACP stdio 入口，拉起来「initialize 无响应」比 ENOENT 更难查。
 * - PATH 层**只按适配器命令名查**（`opencode` / `codex-acp` / `claude-agent-acp` / `qoderclicn`），
 *   **绝不用 kind 名** —— 否则会命中 `claude.exe` 这类不会说 ACP 的 native CLI。
 *
 * 依赖注入（`deps`）使本模块可**纯单测**（不依赖真机装了没装包），对齐 `acp-bridge/acp/client.ts` 既有纪律。
 * **分层清单不进 Error message 正文**（`self-check` 的 `singleLine()` 截 300 字符）—— `probes` 交调用方/日志打印。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentKind } from "../types.js";
import { dirname } from "node:path";
import { resolveAcpBackendCmd } from "../launcher/agent-config.js";
import { SCRIPT_BACKEND_EXTS } from "./backend-command.js";
import { WIN_SPAWN_REJECTED_EXTS } from "../acp-bridge/acp/client.js";

/** 探测层（记录带**层名**，非仅路径 —— 否则日志分不清是哪层给的，改造文档 §2.1 收口 ②）。 */
export type BackendEntryLayer =
  | "L0-explicit"
  | "L1-local"
  | "L2-npm-global"
  | "L3-path"
  | "known";

/** 单条探测的状态。 */
export type BackendProbeStatus =
  | "hit"
  | "miss"
  | "rejected-shell"
  /** L0 显式值指向的路径不存在（项目级失败，不回落下层）。 */
  | "rejected-missing"
  /** L0 显式值存在但非文件（如目录；项目级失败，不回落下层）。 */
  | "rejected-not-file";

/** 一条探测记录：命中层名 + 状态 + 探测对象（路径或命令名）+ 可选说明。 */
export interface BackendEntryProbe {
  layer: BackendEntryLayer;
  status: BackendProbeStatus;
  target: string;
  note?: string;
}

/** `resolveBackendEntry` 的返回：命中的入口路径（未命中 = `undefined`）+ 全量探测记录。 */
export interface BackendEntryResolution {
  command?: string;
  /**
   * L0 显式值被拒时的收口文案（存在但未达「存在且是文件」）。
   * 非 `undefined` ⇒ 调用方必须失败，**不得**改走自动解析（`requireBackendEntry` 优先抛本字段）。
   */
  rejection?: string;
  probes: BackendEntryProbe[];
}

/** 已知安装位置：按平台标注的**具体文件**（非扫目录，改造文档 §2.1 ❗）。 */
export interface KnownBackendPath {
  platform: "win32" | "posix";
  path: string;
}

/** `KIND → 入口` 表的一项。 */
export interface BackendEntrySpec {
  /** npm 包名（含 scope）；L1/L2 用它定位 `<root>/<pkg>/package.json`。qoder 无包 ⇒ 缺省。 */
  package?: string;
  /** PATH 层命令名（§2.2 铁律：≠ kind 名，`qoder-cn` 的命令名是 `qoderclicn`）。 */
  pathCommand?: string;
  /** 具体文件白名单（qoder 用；按平台选，`~` 展开 home）。 */
  knownPaths?: KnownBackendPath[];
}

/**
 * 唯一事实源：四个 kind 的缺省入口（改造文档 §0 校正 —— 表键用终名 `qoder-cn`；
 * ⚠ 命令名 `qoderclicn` 是 CLI 真名，与 kind 更名无关）。
 */
export const BACKEND_LOOKUP_BY_KIND: Record<AgentKind, BackendEntrySpec> = {
  opencode: { package: "opencode-ai", pathCommand: "opencode" },
  codex: { package: "@agentclientprotocol/codex-acp", pathCommand: "codex-acp" },
  claude: { package: "@agentclientprotocol/claude-agent-acp", pathCommand: "claude-agent-acp" },
  "qoder-cn": {
    pathCommand: "qoderclicn",
    knownPaths: [
      { platform: "win32", path: "~/.qoder-cn/bin/qoderclicn/qoderclicn.exe" },
      { platform: "posix", path: "~/.local/bin/qoderclicn" },
    ],
  },
};

/** 可注入依赖（纯单测用；对齐 `client.ts` 的 deps 纪律）。 */
export interface BackendEntryDeps {
  isFile?: (candidate: string) => boolean;
  /** L0 显式值「存在但不是文件」（目录）判据，用于区分 `rejected-missing` / `rejected-not-file`。 */
  isDirectory?: (candidate: string) => boolean;
  readJson?: (file: string) => unknown;
  /** L2 全局 npm 根候选（已去重）；注入以覆盖真机装了没装包。 */
  npmRoots?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** L1 机器本地 node_modules 根；缺省 = machine 应用根下的 `node_modules`。 */
  machineModulesRoot?: string;
  /** home 目录（`~` 展开用）。 */
  homedir?: () => string;
}

const DEFAULT_MACHINE_MODULES_ROOT = join(
  findMachineAppRoot(),
  "node_modules",
);

/** 从本模块向上找含 package.json 的目录（machine 应用根）；找不到退回到本模块目录。 */
function findMachineAppRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let current = resolve(here);
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(here);
    current = parent;
  }
}

function defaultIsFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function defaultIsDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * L0 显式值被拒的项目级失败文案。
 * ⚠ 措辞承重：必含「**后端入口**」—— `launcher/self-check.ts` 的 `classifySelfCheckCause`
 * 依 `/(ACP 后端入口|\[backend\] 行|后端入口)/` 归 `backend-entry` 类（缺这四字 ⇒ 归错类、
 * 可能被当成机器级故障而整机退出）。另必含**原样配置值**与「原因 + 建议」，且**保持精简单句**
 * （分层清单仍由 `config-snapshot` 的 `[backend]` 行渲染，不进本 message）。
 */
function explicitEntryRejectedMessage(explicit: string, notFile: boolean): string {
  const reason = notFile ? "不是文件" : "不存在";
  return `显式 agentConfig.backendCmd 指向的 ACP 后端入口${reason}：${explicit} —— 请改成真实入口文件的绝对路径，或删除 backendCmd 键以启用四层自动解析；逐层清单见 launcher.log [backend] 行`;
}

function defaultReadJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** 包名的 unscoped 段（`@scope/name` ⇒ `name`；无 scope ⇒ 原样）。 */
function unscopedName(pkg: string): string {
  const slash = pkg.lastIndexOf("/");
  return slash >= 0 ? pkg.slice(slash + 1) : pkg;
}

/** L2 全局 npm 根候选（免子进程，改造文档 §2.1 裁决 ②）：按 root 去重（大小写归一）。 */
function defaultNpmRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw: string[] = [];
  const prefix = env["NPM_CONFIG_PREFIX"];
  if (typeof prefix === "string" && prefix.length > 0) {
    raw.push(platform === "win32" ? prefix : join(prefix, "node_modules"));
    // win 的 npm 前缀即安装目录（其下直接是包），posix 前缀下再套 node_modules。
  }
  if (platform === "win32") {
    const appData = env["APPDATA"];
    if (typeof appData === "string" && appData.length > 0) {
      raw.push(join(appData, "npm", "node_modules"));
    }
  } else {
    raw.push("/usr/local/lib/node_modules");
    raw.push("/usr/lib/node_modules");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of raw) {
    const key = (platform === "win32" ? root.toLowerCase() : root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

/**
 * 对一个候选真身路径分类：命中（可直调 / node 可跑的脚本）/ `rejected-shell`（win 壳）/ 未命中（非文件）。
 * win32 壳扩展名复用 `WIN_SPAWN_REJECTED_EXTS`（与桥同一集合，勿两处字面量）。
 */
function classifyEntry(
  candidate: string,
  isFile: (p: string) => boolean,
  platform: NodeJS.Platform,
): { status: "hit" } | { status: "rejected-shell" } | { status: "absent" } {
  if (!isFile(candidate)) return { status: "absent" };
  const ext = extname(candidate).toLowerCase();
  if (SCRIPT_BACKEND_EXTS.includes(ext)) return { status: "hit" }; // .js/.mjs/.cjs ⇒ resolveBackendSpawn 以 node 跑
  if (platform === "win32" && WIN_SPAWN_REJECTED_EXTS.has(ext)) return { status: "rejected-shell" };
  return { status: "hit" }; // .exe / posix 无扩展名真身
}

/** 解析一个 npm 包根下的 `<pkg>` 入口（§2.2 `bin` 规则；不掺 `main`）。 */
function probePackageRoot(
  spec: BackendEntrySpec,
  root: string,
  layer: BackendEntryLayer,
  isFile: (p: string) => boolean,
  readJson: (f: string) => unknown,
  platform: NodeJS.Platform,
): { command?: string; probes: BackendEntryProbe[] } {
  const pkg = spec.package;
  if (pkg === undefined) return { probes: [] };
  const probes: BackendEntryProbe[] = [];
  const pkgDir = join(root, ...pkg.split("/"));
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!isFile(pkgJsonPath)) {
    probes.push({ layer, status: "miss", target: pkgJsonPath });
    return { probes };
  }
  let pkgJson: Record<string, unknown>;
  try {
    const parsed = readJson(pkgJsonPath);
    if (parsed === null || typeof parsed !== "object") {
      probes.push({ layer, status: "miss", target: pkgJsonPath, note: "bad-package-json" });
      return { probes };
    }
    pkgJson = parsed as Record<string, unknown>;
  } catch {
    probes.push({ layer, status: "miss", target: pkgJsonPath, note: "read-error" });
    return { probes };
  }

  // `bin` 规则：字符串直取 / 对象取 bin[unscoped] / 单条目宽容（记 bin-key-mismatch）/ 多条目不匹配判未命中。
  const unscoped = unscopedName(pkg);
  const bin = pkgJson["bin"];
  let binValue: string | undefined;
  let note: string | undefined;
  if (typeof bin === "string") {
    binValue = bin;
  } else if (bin !== null && typeof bin === "object") {
    const map = bin as Record<string, unknown>;
    const keys = Object.keys(map);
    const direct = map[unscoped];
    if (typeof direct === "string") {
      binValue = direct;
    } else if (keys.length === 1 && typeof map[keys[0] as string] === "string") {
      binValue = map[keys[0] as string] as string;
      note = "bin-key-mismatch";
    } else {
      // 多条目且不匹配 ⇒ 判未命中（不猜，进下一层）。
      probes.push({ layer, status: "miss", target: pkgJsonPath, note: "bin-ambiguous" });
      return { probes };
    }
  } else {
    probes.push({ layer, status: "miss", target: pkgJsonPath, note: "no-bin" });
    return { probes };
  }

  const command = resolve(pkgDir, binValue);
  const cls = classifyEntry(command, isFile, platform);
  if (cls.status === "hit") {
    probes.push({ layer, status: "hit", target: command, ...(note !== undefined ? { note } : {}) });
    return { command, probes };
  }
  if (cls.status === "rejected-shell") {
    probes.push({ layer, status: "rejected-shell", target: command, ...(note !== undefined ? { note } : {}) });
    return { probes };
  }
  probes.push({ layer, status: "miss", target: command, ...(note !== undefined ? { note } : {}) });
  return { probes };
}

/** 展开 `~` 前缀为 home 绝对路径。 */
function expandHome(p: string, home: string): string {
  if (p === "~" || p.startsWith("~/") || (p.startsWith("~" + sep))) {
    return join(home, p.slice(p === "~" ? 1 : 2));
  }
  return p;
}

/** PATH 层：只按**适配器命令名**查（§2.2 铁律）；win 优先 `.exe`，命中壳则记 `rejected-shell` 继续找别处。 */
function probePathLayer(
  commandName: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isFile: (p: string) => boolean,
): { command?: string; probes: BackendEntryProbe[] } {
  const probes: BackendEntryProbe[] = [];
  const pathValue = env["PATH"] ?? env["Path"] ?? "";
  const dirs = pathValue.split(delimiter).filter((d) => d.length > 0);
  const exts =
    platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1"] : [""];
  let sawShell = false;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, commandName + ext);
      const cls = classifyEntry(candidate, isFile, platform);
      if (cls.status === "absent") continue;
      if (cls.status === "rejected-shell") {
        sawShell = true;
        probes.push({ layer: "L3-path", status: "rejected-shell", target: candidate });
        break; // 本目录命中的是壳，换下一个目录找真身
      }
      probes.push({ layer: "L3-path", status: "hit", target: candidate });
      return { command: candidate, probes };
    }
  }
  if (!sawShell) {
    probes.push({ layer: "L3-path", status: "miss", target: commandName });
  }
  return { probes };
}

/** `knownPaths` 层（qoder）：按平台选具体文件，命中即用。 */
function probeKnownPaths(
  spec: BackendEntrySpec,
  platform: NodeJS.Platform,
  isFile: (p: string) => boolean,
  home: string,
): { command?: string; probes: BackendEntryProbe[] } {
  const probes: BackendEntryProbe[] = [];
  const known = spec.knownPaths ?? [];
  const matching = known.filter((k) =>
    k.platform === "win32" ? platform === "win32" : platform !== "win32",
  );
  if (matching.length === 0) {
    probes.push({ layer: "known", status: "miss", target: "(no path for platform)" });
    return { probes };
  }
  for (const k of matching) {
    const candidate = expandHome(k.path, home);
    const cls = classifyEntry(candidate, isFile, platform);
    if (cls.status === "hit") {
      probes.push({ layer: "known", status: "hit", target: candidate });
      return { command: candidate, probes };
    }
    if (cls.status === "rejected-shell") {
      probes.push({ layer: "known", status: "rejected-shell", target: candidate });
      continue;
    }
    probes.push({ layer: "known", status: "miss", target: candidate });
  }
  return { probes };
}

/**
 * 解析后端入口，**不抛**：命中返回 `{ command, probes }`，未命中返回 `{ probes }`（全量分层清单），
 * 显式层被拒返回 `{ probes, rejection }`（**不回落下层**）。
 * 命中即停（改造文档 §2.3 裁决 ③）；成功路径只记录到命中层为止。
 */
export function resolveBackendEntry(
  kind: AgentKind,
  agentConfig: Record<string, unknown> | undefined,
  deps: BackendEntryDeps = {},
): BackendEntryResolution {
  const probes: BackendEntryProbe[] = [];
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const isFile = deps.isFile ?? defaultIsFile;
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  const readJson = deps.readJson ?? defaultReadJson;
  const home = (deps.homedir ?? homedir)();
  // 未知 kind 兜底为空表（正常由配置加载器校验，命中 `Record`；防御性 ⇒ 判未命中而非抛）。
  const spec: BackendEntrySpec = BACKEND_LOOKUP_BY_KIND[kind] ?? {};

  // L0 显式：以配置值为准（含指向非标准位置的自建适配器），但**必须存在且是文件**。
  // 显式覆盖是用户明示意图 ⇒ 错了不得静默回落 L1/L2/L3（需求「不得静默降级」），
  // 而是当场以**项目级**失败收口（REQ-v0.8.6-2026-09-21-02 真机补正①）。
  const explicit = resolveAcpBackendCmd(agentConfig);
  if (explicit !== undefined) {
    if (isFile(explicit)) {
      probes.push({ layer: "L0-explicit", status: "hit", target: explicit });
      return { command: explicit, probes };
    }
    const notFile = isDirectory(explicit);
    probes.push({
      layer: "L0-explicit",
      status: notFile ? "rejected-not-file" : "rejected-missing",
      target: explicit,
    });
    return { probes, rejection: explicitEntryRejectedMessage(explicit, notFile) };
  }
  probes.push({ layer: "L0-explicit", status: "miss", target: "backendCmd" });

  // L1 机器本地 node_modules（仅 npm 包类）。
  if (spec.package !== undefined) {
    const localRoot = deps.machineModulesRoot ?? DEFAULT_MACHINE_MODULES_ROOT;
    const r = probePackageRoot(spec, localRoot, "L1-local", isFile, readJson, platform);
    probes.push(...r.probes);
    if (r.command !== undefined) return { command: r.command, probes };

    // L2 全局 npm 候选表（去重）。
    const npmRoots = deps.npmRoots ?? defaultNpmRoots(env, platform);
    for (const root of npmRoots) {
      const rr = probePackageRoot(spec, root, "L2-npm-global", isFile, readJson, platform);
      probes.push(...rr.probes);
      if (rr.command !== undefined) return { command: rr.command, probes };
    }
  }

  // known（qoder 具体文件白名单）先于 PATH。
  if (spec.knownPaths !== undefined) {
    const rk = probeKnownPaths(spec, platform, isFile, home);
    probes.push(...rk.probes);
    if (rk.command !== undefined) return { command: rk.command, probes };
  }

  // L3 PATH（仅当真身为可执行体）。
  if (spec.pathCommand !== undefined && !isAbsolute(spec.pathCommand)) {
    const rp = probePathLayer(spec.pathCommand, env, platform, isFile);
    probes.push(...rp.probes);
    if (rp.command !== undefined) return { command: rp.command, probes };
  }

  return { probes };
}

/**
 * 要求解析到入口，否则抛（未命中 ⇒ 明确不可用，改造文档 §2.4 裁决 ④）。
 * Error message 只带**一句**：L0 显式被拒 ⇒ 抛该层的专项文案（含原样路径），否则抛调用方给定的
 * `requiredMsg`；**分层清单由调用方 / 日志打印 `resolveBackendEntry().probes`**（不进本 message，
 * 避免被 `singleLine()` 截断）。
 */
export function requireBackendEntry(
  kind: AgentKind,
  agentConfig: Record<string, unknown> | undefined,
  requiredMsg: string,
  deps: BackendEntryDeps = {},
): string {
  const { command, rejection } = resolveBackendEntry(kind, agentConfig, deps);
  if (command === undefined) {
    throw new Error(rejection ?? requiredMsg);
  }
  return command;
}

/** 把一条探测渲染为日志片段（供调用方拼分层清单；层名必带）。 */
export function formatBackendProbe(probe: BackendEntryProbe): string {
  const suffix = probe.note !== undefined ? `(${probe.target} ${probe.note})` : `(${probe.target})`;
  return `${probe.layer}=${probe.status}${suffix}`;
}
