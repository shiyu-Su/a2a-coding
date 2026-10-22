/**
 * 组织种子化（v0.9.5 C10 · REQ-2026-09-28-09）—— 建组织链与启动回填**共用**的落盘供给。
 *
 * ## 三件事
 *
 * 1. **模板接线**：`board/templates/org/AGENTS.template.md` 渲染后落 `<orgDir>/AGENTS.md`
 *    （占位符替换见 {@link renderAgentsTemplate} —— 只替换 T11 **权威已知**的键）。
 * 2. **flow/spec 快照**：运行时读 `<repoRoot>/flow/spec/` 的三份规范（{@link DEFAULT_SPEC_SNAPSHOTS}），
 *    落 `<orgDir>/flow/spec/<名>`，文件头加**版本戳双记**注释（来源路径 + board 版本 + 源文件自身规范版本戳）。
 *    路径经 `docs-read.ts#defaultRepoRoot()` 单点推导，**禁硬编码**。
 * 3. **启动幂等回填**：枚举 `listOrgDirs(orgsDir) ∪ 组织台账`，只补缺失、不覆盖已有
 *    （组织可能已自改）、原子写、**逐组织 fail-open**、跳过已停用组织。
 *
 * ## 硬口径（R3 定稿）
 *
 * - **fail-open**：模板 / flow/spec 缺失或不可读 ⇒ **跳过 + 结构化告警**，绝不阻断建组织或板启动；
 * - **不回滚**：seed 落盘失败 ⇒ 结构化告警、**不回滚组织创建**（缺失由启动幂等回填自愈）；
 * - **只补缺不覆盖**：目标已存在（哪怕内容是组织自改的）⇒ 一律跳过；
 * - **模板内容归 T7 单点维护**：本模块只做接线 + 落盘 + 回填 + 版本戳，**不改模板内容**；
 *   占位符替换只动 T11 权威已知的键（`{ORG_NAME}` / `{HOST_KIND}` / `{FLOW_SPEC_STAMP}`），
 *   其余使用期占位符（如 `{ORG_MEMBER_PROJECTS}`，需成员写面数据）**原样保留**。
 *
 * **无独立写路由**：本模块不注册任何 HTTP 端点，写面白名单保持 11 条不动（T7 落挂起口后的终态）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { defaultRepoRoot } from "./docs-read.js";
import { statDirKind } from "./org-workspace.js";
import { readVersion } from "./version.js";

/** 组织版 `AGENTS.md` 的模板文件名（板侧资产，来源与占位符总表见 `templates/org/README.md`）。 */
export const AGENTS_TEMPLATE_FILE = "AGENTS.template.md";

/** 模板渲染后的目标文件名。 */
export const AGENTS_TARGET_FILE = "AGENTS.md";

/**
 * flow/spec 快照的**缺省清单**（三份规范，C10 定稿 + v0.9.6 模板接入）：
 * 需求流程内核 + 引擎映射 + 文档模板。`templates/org/README.md` §2 的 flow/ 十文件清单是 V1 人工铺设口径，
 * 不属本节点范围。
 */
export const DEFAULT_SPEC_SNAPSHOTS: readonly string[] = ["需求流程.md", "引擎映射.md", "文档模板.md"];

/** 缺省宿主 kind（渲染 `{HOST_KIND}`；与 `config.ts` 的缺省一致）。 */
export const DEFAULT_SEED_HOST_KIND = "claude";

/** 快照文件头的「未提取到版本戳」回退串（源文件格式不含版本戳时）。 */
export const SPEC_STAMP_FALLBACK = "（未提取到规范版本戳）";

/** `{FLOW_SPEC_STAMP}` 的「源不可读」回退串（flow/spec 缺失时 AGENTS.md 仍可落盘）。 */
export const FLOW_STAMP_UNAVAILABLE = "（未获取：flow/spec 不可读）";

/** 结构化告警码闭集（fail-open 的事实载体；调用方据此打印 / 排查）。 */
export type OrgSeedWarningCode =
  | "board_org_seed_template_missing"
  | "board_org_seed_spec_missing"
  | "board_org_seed_write_failed";

/** 一条结构化告警（**不抛错**；org + target 用于定位，message 为人读根因）。 */
export interface OrgSeedWarning {
  code: OrgSeedWarningCode;
  org: string;
  /** 目标路径（相对组织目录，正斜杠分隔；拿不到绝对路径时不泄根）。 */
  target: string;
  message: string;
}

/** 单个组织的种子化结果（created / skipped 均为**相对组织目录**的路径，正斜杠分隔）。 */
export interface OrgSeedResult {
  org: string;
  /** 本次新落盘的目标文件。 */
  created: string[];
  /** 已存在、按「只补缺不覆盖」跳过（可能被组织自改）。 */
  skipped: string[];
  warnings: OrgSeedWarning[];
}

/** 注入面（测试喂 fixture；**省略 / null ⇒ 不种子化**，board 由 index.ts 显式装配）。 */
export interface OrgSeedOptions {
  /** 模板根（`<board>/templates/org`）；缺省 {@link defaultTemplateRoot}；测试注入 fixture。 */
  templateRoot?: string;
  /** 主仓根（flow/spec 来源）；缺省 `docs-read#defaultRepoRoot()`。 */
  repoRoot?: string;
  /** board 版本（版本戳双记用）；缺省 `package.json`（`version.ts#readVersion`）。 */
  boardVersion?: string;
  /** 宿主 kind（渲染 `{HOST_KIND}`）；缺省 {@link DEFAULT_SEED_HOST_KIND}。 */
  hostKind?: string;
  /** 快照文件名清单；缺省 {@link DEFAULT_SPEC_SNAPSHOTS}。 */
  specFiles?: readonly string[];
}

/** 归一后的种子化配置（`createBoardServer` 内一次解析，handler 与回填共用）。 */
export interface ResolvedOrgSeedOptions {
  templateRoot: string;
  repoRoot: string;
  boardVersion: string;
  hostKind: string;
  specFiles: readonly string[];
}

/**
 * 模板根缺省 = 板根的 `templates/org`（由模块位置反推：源码运行 `src/` 与 dist 运行 `dist/`
 * 都落同一 `board/templates/org` —— 与 `createConfig` / `docs-render#defaultStaticRoot` 同款锚点）。
 */
export function defaultTemplateRoot(metaUrl: string = import.meta.url): string {
  return join(resolve(dirname(fileURLToPath(metaUrl)), ".."), "templates", "org");
}

/** 归一注入项（缺省全部按板内真实资产推导）。 */
export function resolveOrgSeedOptions(
  options: OrgSeedOptions = {},
  fallback: { repoRoot?: string } = {},
): ResolvedOrgSeedOptions {
  return {
    templateRoot: options.templateRoot ?? defaultTemplateRoot(),
    repoRoot: options.repoRoot ?? fallback.repoRoot ?? defaultRepoRoot(),
    boardVersion: options.boardVersion ?? readVersion(),
    hostKind: options.hostKind ?? DEFAULT_SEED_HOST_KIND,
    specFiles: options.specFiles ?? DEFAULT_SPEC_SNAPSHOTS,
  };
}

// ---------------------------------------------------------------------------
// 纯函数（无 I/O；单测目标）
// ---------------------------------------------------------------------------

/**
 * 模板占位符渲染（**纯函数**）：只替换 T11 权威已知的三个键 —— `{ORG_NAME}` / `{HOST_KIND}` /
 * `{FLOW_SPEC_STAMP}`；其余占位符（使用期占位，如 `{ORG_MEMBER_PROJECTS}`）**原样保留**。
 * `flowSpecStamp = null` ⇒ `{FLOW_SPEC_STAMP}` 落 {@link FLOW_STAMP_UNAVAILABLE}（源不可读的诚实表达）。
 */
export function renderAgentsTemplate(
  template: string,
  vars: { org: string; hostKind: string; flowSpecStamp: string | null },
): string {
  const stamp = vars.flowSpecStamp ?? FLOW_STAMP_UNAVAILABLE;
  return template
    .replaceAll("{ORG_NAME}", vars.org)
    .replaceAll("{HOST_KIND}", vars.hostKind)
    .replaceAll("{FLOW_SPEC_STAMP}", stamp);
}

/**
 * 从规范正文提取「规范版本戳」（**纯函数**）：认 `**规范版本戳**：<token>` 首个命中
 * （`需求流程.md` / `引擎映射.md` / `文档模板.md` 顶部均为此形）。取不到 ⇒ `null`（不臆造）。
 */
export function extractSpecStamp(content: string): string | null {
  const m = content.match(/\*\*规范版本戳\*\*[：:]\s*([^\n\r]+)/);
  if (m === null) return null;
  const stamp = (m[1] ?? "").trim();
  return stamp === "" ? null : stamp;
}

/**
 * 快照文件头的**版本戳双记**注释行（**纯函数**）：来源路径 + board 版本 + 源文件自身规范版本戳。
 * 三样缺一不可 —— 只记一套会把「板版本」与「flow 规范版本」混淆（R3 定稿口径）。
 */
export function snapshotHeader(sourceRel: string, boardVersion: string, specStamp: string | null): string {
  return (
    `<!-- 快照（板侧组织种子化 · 只补缺不覆盖）：来源 ${sourceRel} · board 版本 v${boardVersion} · ` +
    `源文件规范版本戳 ${specStamp ?? SPEC_STAMP_FALLBACK} -->\n`
  );
}

/** 规范快照的目标相对路径（POSIX 风格，供结果回执与断言）。 */
export function specSnapshotRel(name: string): string {
  return `flow/spec/${name}`;
}

/**
 * 回填组织清单（**纯函数**）：盘枚举 ∪ 台账在用名，trim 去重、剔空名与点段、
 * **一票否决已停用名**，字典序稳定排序。
 */
export function orgsToBackfill(input: {
  disk: readonly string[];
  ledger: readonly string[];
  disabled: readonly string[];
}): string[] {
  const disabled = new Set(input.disabled.map((n) => n.trim()).filter((n) => n !== ""));
  const names = new Set<string>();
  for (const raw of [...input.disk, ...input.ledger]) {
    const name = raw.trim();
    if (name === "" || name === "." || name === "..") continue;
    if (disabled.has(name)) continue;
    names.add(name);
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function relPath(...parts: string[]): string {
  return parts.join("/");
}

/** 目标是否已存在（只补缺不覆盖的唯一判据；存在即跳过，哪怕内容被组织自改）。 */
function targetExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

interface SeedFile {
  /** 相对组织目录的目标路径（正斜杠）。 */
  rel: string;
  /** 落盘绝对路径。 */
  abs: string;
  /** 完整内容（含快照头）。 */
  content: string;
}

/**
 * 单组织种子化（**不抛错** —— 一切失败收口为结构化告警）：
 * ① 读模板（缺 ⇒ 告警，跳过 AGENTS.md）；② 读 flow/spec 三份（逐份缺 ⇒ 告警，跳过该份；
 * 全缺 ⇒ `{FLOW_SPEC_STAMP}` 落回退串，AGENTS.md 照落）；③ 只补缺、原子写、逐文件 fail-open。
 */
export function seedOrgWorkspace(
  orgDir: string,
  org: string,
  options: ResolvedOrgSeedOptions,
): OrgSeedResult {
  const warnings: OrgSeedWarning[] = [];
  const files: SeedFile[] = [];

  // ① flow/spec 快照（先读源 —— `{FLOW_SPEC_STAMP}` 取自同一批源文件）
  const specs = options.specFiles.map((name) => {
    const sourceRel = relPath("flow", "spec", name);
    const sourceAbs = join(resolve(options.repoRoot), "flow", "spec", name);
    let content: string | null = null;
    try {
      content = readFileSync(sourceAbs, "utf8");
    } catch (err) {
      warnings.push({
        code: "board_org_seed_spec_missing",
        org,
        target: sourceRel,
        message: `flow/spec 源缺失或不可读 ⇒ 跳过该份快照（fail-open，不阻断）：${errMessage(err)}`,
      });
    }
    return { name, sourceRel, content };
  });
  const stamp = specs.map((s) => (s.content === null ? null : extractSpecStamp(s.content))).find((s) => s !== null) ?? null;
  for (const s of specs) {
    if (s.content === null) continue;
    const rel = specSnapshotRel(s.name);
    files.push({
      rel,
      abs: join(resolve(orgDir), "flow", "spec", s.name),
      content: snapshotHeader(s.sourceRel, options.boardVersion, extractSpecStamp(s.content)) + s.content,
    });
  }

  // ② AGENTS.md（模板渲染）
  const templateAbs = join(resolve(options.templateRoot), AGENTS_TEMPLATE_FILE);
  try {
    const template = readFileSync(templateAbs, "utf8");
    files.push({
      rel: AGENTS_TARGET_FILE,
      abs: join(resolve(orgDir), AGENTS_TARGET_FILE),
      content: renderAgentsTemplate(template, { org, hostKind: options.hostKind, flowSpecStamp: stamp }),
    });
  } catch (err) {
    warnings.push({
      code: "board_org_seed_template_missing",
      org,
      target: AGENTS_TARGET_FILE,
      message: `组织 AGENTS 模板缺失或不可读 ⇒ 跳过 AGENTS.md（fail-open，不阻断）：${errMessage(err)}`,
    });
  }

  // ③ 只补缺、原子写、逐文件 fail-open
  const created: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (targetExists(file.abs)) {
      skipped.push(file.rel);
      continue;
    }
    try {
      writeFileAtomic(file.abs, file.content);
      created.push(file.rel);
    } catch (err) {
      warnings.push({
        code: "board_org_seed_write_failed",
        org,
        target: file.rel,
        message: `种子落盘失败（fail-open，不回滚组织创建）：${errMessage(err)}`,
      });
    }
  }
  return { org, created, skipped, warnings };
}

/** 启动回填的输入（orgsDir = 组织目录根；清单由调用方经 `listOrgDirs` / 台账给出）。 */
export interface OrgSeedBackfillInput {
  orgsDir: string | null;
  disk: readonly string[];
  ledger: readonly string[];
  disabled: readonly string[];
  options: ResolvedOrgSeedOptions;
}

/** 启动回填的结果（逐组织结果 + 汇合告警；**零抛**）。 */
export interface OrgSeedBackfillResult {
  /** 本次实际扫描的组织（已剔停用）。 */
  orgs: string[];
  results: OrgSeedResult[];
  warnings: OrgSeedWarning[];
}

/**
 * 启动幂等回填（**零抛**）：枚举源 = 盘枚举 ∪ 台账在用（剔停用）⇒ 逐组织 {@link seedOrgWorkspace}，
 * **逐组织 fail-open**（单组织异常只记告警、不阻断其余组织、更不阻断板启动）。`orgsDir` 未配置 ⇒ 空结果。
 *
 * **根不代建硬纪律（BD15/BD14）**：`orgsDir` 根是**部署面**配置，**必须预先存在**；
 * 根不存在 / 不是目录 ⇒ 回填**整体跳过**（否则 ledger 独有组织会经「原子写建父目录」把根偷偷建出来，
 * 破坏「板刻意不代建根」）。根缺失一事已由宿主面的启动 warn 如实承载，此处不重复出声。
 */
export function backfillOrgWorkspaces(input: OrgSeedBackfillInput): OrgSeedBackfillResult {
  if (input.orgsDir === null) return { orgs: [], results: [], warnings: [] };
  if (statDirKind(resolve(input.orgsDir)) !== "dir") return { orgs: [], results: [], warnings: [] };
  const orgs = orgsToBackfill({ disk: input.disk, ledger: input.ledger, disabled: input.disabled });
  const results: OrgSeedResult[] = [];
  const warnings: OrgSeedWarning[] = [];
  for (const org of orgs) {
    try {
      const result = seedOrgWorkspace(join(resolve(input.orgsDir), org), org, input.options);
      results.push(result);
      warnings.push(...result.warnings);
    } catch (err) {
      // seedOrgWorkspace 自身零抛；本条为最后兜底 —— 单组织异常绝不外溢到板启动。
      warnings.push({
        code: "board_org_seed_write_failed",
        org,
        target: "",
        message: `组织种子化意外失败（已忽略，不阻断板启动）：${errMessage(err)}`,
      });
    }
  }
  return { orgs, results, warnings };
}

/** 错误 → 文案（不抛）。 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 结果统计（回填日志用；正斜杠无关，只计数）。 */
export function summarizeSeedResults(results: readonly OrgSeedResult[]): { created: number; skipped: number } {
  let created = 0;
  let skipped = 0;
  for (const r of results) {
    created += r.created.length;
    skipped += r.skipped.length;
  }
  return { created, skipped };
}
