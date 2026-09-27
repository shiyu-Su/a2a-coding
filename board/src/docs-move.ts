/**
 * 改版自动善后（v0.9.3 B-T6 · REQ-2026-09-26-02 T5/T6）—— 排期写链内的**受限 mv**。
 *
 * 触发（改造文档 §2-T6 冻结边界）：排期写成功 ∧ 新 version ≠ 旧 version ∧ 该 Feature
 * `decisions` 含 `doc/{旧版本}/` 登记路径 ⇒ 写 version + 自动 mv 这些文档至 `doc/{新版本}/`
 * + `decisions` 追加新路径。**幂等**：目标已存在 ⇒ 跳过 mv、仅登记新路径。
 *
 * 守卫（与读面 `docs-read.ts` 同族口径，但本模块是**文件动作**，不是 HTTP 面）：
 * 1. **只动主仓（源 A）`<repoRoot>/doc/{版本}/` 树内** —— 判据 = 该登记文件在主干树内
 *    **确实存在**（`existsSync(fromAbs)`）。登记文本对源 A / 源 B 是**同一形态**（读面
 *    `/features/:id/docs` 先查主仓、未命中回落组织工作区），故板**无法从文本区分双源**：
 *    主干未命中 ⇒ 一律**不碰**、列入 `manual`（可能是源 B 组织工作区文档，交宿主手工搬）。
 * 2. **仅 decisions 登记路径** —— 本模块只吃 decisions 条目，非登记文件永不成为动作对象；
 * 3. 段卫生 + 根内收 —— `..` / 反斜杠 / 盘符 / `%` / 绝对路径 / `doc/` 下多于一层的层级
 *    一律 `rejected`（拒在规划层，不给文件动作机会）；version 段与目标段均过 `v\d+\.\d+\.\d+`
 *    白名单；仅 `.md` 闭集；resolve 后核验仍在 `<repoRoot>/doc` 根内；
 * 4. 目标版本不合白名单（含清空回池 = 空串）⇒ 整体不搬（文档留在原目录，M6 失联警示行仍如实显示）。
 *
 * mv 为**服务端文件动作、不经 HTTP 写路由面**（`/static/` 白名单不扩）。本模块零 HTTP、
 * 零桥调用：规划 = 纯函数，执行 = 薄文件层（异常归一进回执、**不抛穿** —— 排期写已成功，
 * 善后失败不得把整条写改成 5xx，失败/待办项在回执如实列出）。
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { parseDecisionItems } from "./web/views.js";
import { DOC_FILE_SUFFIX, isValidDocVersion } from "./docs-read.js";
import { normalizeVersion } from "./version-order.js";

/** 一条待搬迁的登记文档（主仓树内绝对路径 + 登记原文 + 搬移后的新登记路径）。 */
export interface DocsMoveAction {
  readonly sourceEntry: string;
  readonly fromAbs: string;
  readonly toAbs: string;
  /** 搬移后的新登记路径（`doc/{新版本}/{file}.md`）⇒ 进 decisions 追加 */
  readonly newPath: string;
}

export interface DocsMovePlan {
  /** 归一后的目标版本（空串 = 未排期 / 回池） */
  readonly targetVersion: string;
  readonly actions: DocsMoveAction[];
  /** 交宿主手工处置的登记项（主干树内未命中 ⇒ 可能是组织工作区（源 B）；或无版本段的登记） */
  readonly manual: string[];
  /** 守卫拒绝（越树路径 / 层级越界 / 非法文件名 / 非 .md / 版本段不合法） */
  readonly rejected: string[];
}

/** `doc/` 引用允许的前置边界字符（行首由「idx === 0」单独放行）。 */
const DOC_REF_BOUNDARY = /[\s("'[=<]/;
/** `doc/` 之后的相对路径串（到空白 / 引号 / 尖括号为界），用于本模块自持的严格解析。 */
const DOC_REF_RE = /doc\/([^\s"'<>]*)/;

/**
 * 严格解析一条 decisions 登记文本里的 `doc/...md` 引用（**不复用**展示层的宽松提取：
 * 展示可以「剥前缀当文件名」，文件动作必须先把越界形态拒掉）。
 * 返回 null = 该条目不含 `doc/` 引用（与本模块无关）。
 *
 * **边界判据**：`doc/` 只有以**独立路径起点**形态出现（行首或空白 / 引号 / 尖括号 / 方括号 / `=` 之后）
 * 才认作登记路径；前面紧挨 `/` `\` `:` 或词字符（如 `C:/repo/doc/…`、`some/dir/doc/…`）⇒ 是**别的路径
 * 的后缀**，本模块无法据此定位主干文件 ⇒ `unsafe` 拒掉（不静默丢：进 rejected 回执）。
 */
function parseDocRef(item: string): { version: string; file: string } | "unsafe" | null {
  const m = DOC_REF_RE.exec(item);
  if (m === null) return null;
  const idx = m.index;
  if (idx > 0 && !DOC_REF_BOUNDARY.test(item[idx - 1] as string)) return "unsafe";
  const rest = m[1] ?? "";
  if (rest.includes("\\")) return "unsafe";
  if (rest.includes(":")) return "unsafe";
  if (rest.startsWith("/")) return "unsafe";
  if (rest.includes("%")) return "unsafe";
  const segs = rest.split("/");
  if (segs.some((s) => s === ".." || s === ".")) return "unsafe";
  if (segs.length === 1) {
    const file = segs[0] ?? "";
    if (!isSafeDocFile(file)) return "unsafe";
    return { version: "", file };
  }
  if (segs.length !== 2) return "unsafe"; // `doc/a/b/x.md` ⇒ 层级越界，主干树内无此形态
  const [version, file] = segs;
  if (!isSafeDocFile(file ?? "")) return "unsafe";
  return { version: version ?? "", file: file ?? "" };
}

/** 文件名段卫生 + `.md` 闭集（空段 / `.` / `..` / 分隔符 / 盘符 / `%` 一律拒）。 */
function isSafeDocFile(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes(":") &&
    !name.includes("%") &&
    name.endsWith(DOC_FILE_SUFFIX)
  );
}

/**
 * 规划（纯函数）：逐条 decisions → 严格解析 → 版本段合法且 ≠ 目标版本 ⇒ 生成一条 mv 动作
 * （from/to 均落在 `<repoRoot>/doc` 根内，resolve 后二次核验）。
 * 目标版本不合白名单（含清空 = 空串）⇒ 不搬、不列 manual（文档原地留存，读面失联警示照旧）。
 */
export function planDocsMove(
  decisionsJson: string | null | undefined,
  targetVersionRaw: string,
  repoRoot: string,
): DocsMovePlan {
  const targetVersion = normalizeVersion(targetVersionRaw);
  const plan: DocsMovePlan = { targetVersion, actions: [], manual: [], rejected: [] };
  const items = parseDecisionItems(decisionsJson);
  if (items.length === 0) return plan;
  if (!isValidDocVersion(targetVersion)) return plan;
  const docRoot = resolve(join(resolve(repoRoot), "doc"));
  const inside = (p: string): boolean => {
    const prefix = docRoot.endsWith(sep) ? docRoot : `${docRoot}${sep}`;
    const lower = process.platform === "win32";
    return lower ? p.toLowerCase().startsWith(prefix.toLowerCase()) : p.startsWith(prefix);
  };
  for (const item of items) {
    const ref = parseDocRef(item);
    if (ref === null) continue;
    if (ref === "unsafe") {
      plan.rejected.push(item);
      continue;
    }
    if (ref.version === "") {
      // `doc/x.md` 无版本段 ⇒ 主干无对应目录形态，不猜落点，交人工
      plan.manual.push(item);
      continue;
    }
    if (!isValidDocVersion(ref.version)) {
      plan.rejected.push(item);
      continue;
    }
    if (ref.version === targetVersion) continue; // 已与目标一致 ⇒ 无需搬
    const fromAbs = resolve(join(docRoot, ref.version, ref.file));
    const toAbs = resolve(join(docRoot, targetVersion, ref.file));
    if (!inside(fromAbs) || !inside(toAbs)) {
      plan.rejected.push(item);
      continue;
    }
    plan.actions.push({ sourceEntry: item, fromAbs, toAbs, newPath: `doc/${targetVersion}/${ref.file}` });
  }
  return plan;
}

/** mv 执行回执（全部为**新登记路径**或**登记原文**，逐档如实，不做汇总数）。 */
export interface DocsMoveResult {
  /** 已搬迁（主干命中 ⇒ rename 成功） */
  readonly moved: string[];
  /** 幂等：目标已存在 ⇒ 跳过 mv、仅登记新路径 */
  readonly registerOnly: string[];
  /** 主干树内未命中 ⇒ 不碰（可能是组织工作区（源 B）文档），交宿主手工 */
  readonly manual: string[];
  /** 盘上异常（rename 失败等）—— 排期写不因此回滚，如实列出 */
  readonly failed: string[];
}

/**
 * 执行（薄文件层）：逐 action ——
 * 1. 目标已在 ⇒ `registerOnly`（**不覆盖**，幂等重放）；
 * 2. 主干源不在 ⇒ `manual`（双源不可从文本区分 ⇒ 不猜、不碰，回执列出交宿主；
 *    组织工作区（源 B）文档天然落在这里）；
 * 3. 否则建目标目录 + rename，成功进 `moved`、异常捕获进 `failed`（**不抛穿**）。
 * `fileExists` / `move` 注入仅供测试；缺省走 `existsSync` / `mkdirSync + renameSync`。
 */
export function executeDocsMove(
  plan: DocsMovePlan,
  fileExists: (p: string) => boolean = existsSync,
  move: (from: string, to: string) => void = (from, to) => {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  },
): DocsMoveResult {
  const moved: string[] = [];
  const registerOnly: string[] = [];
  const manual: string[] = [...plan.manual];
  const failed: string[] = [];
  for (const a of plan.actions) {
    if (fileExists(a.toAbs)) {
      registerOnly.push(a.newPath);
      continue;
    }
    if (!fileExists(a.fromAbs)) {
      manual.push(`${a.sourceEntry}（主干 doc 树内未命中 ⇒ 不自动搬，可能是组织工作区（源 B）文档）`);
      continue;
    }
    try {
      move(a.fromAbs, a.toAbs);
      moved.push(a.newPath);
    } catch (err) {
      failed.push(`${a.sourceEntry}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }
  return { moved, registerOnly, manual, failed };
}

/**
 * decisions 追加项（善后第二跳）：`moved` + `registerOnly` 的新路径去重保序；
 * 皆空 ⇒ `[]`（调用方据此跳过第二跳，零多余出网）。`manual` / `failed` **不进登记**
 * （没搬成的东西不得登记成新路径）。
 */
export function docsMoveRegistrations(result: DocsMoveResult): string[] {
  const seen = new Set<string>();
  for (const p of [...result.moved, ...result.registerOnly]) {
    if (p !== "") seen.add(p);
  }
  return [...seen];
}
