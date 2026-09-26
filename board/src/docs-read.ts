/**
 * 板读文档面（BD10 · REQ-v0.9.1-2026-09-25-04 · **纯函数**，零 HTTP —— HTTP 归 BD11）。
 *
 * 职责：文档根解析 + version/文件名解析 + 单文件读取（守卫端点 `/features/:id/docs?file=`）。
 * 双源（改造文档裁决 ①）：
 * - 源 A = `<repoRoot>/doc/{version}/`（主仓根，板配置键 `repoRoot`，缺省 = 板根上一级）；
 * - 源 B = `<orgsDir>/<org>/doc/{version}/`（组织工作区，沿用既有 `orgsDir` 配置）。
 *
 * **目录扫描（`listDocs`）已作废**（REQ-v0.9.2-2026-09-26-01 按需求归约）：详情页「阶段产出」
 * 改由本需求 `decisions` 登记驱动，板不再列 `doc/{版本}/` 全目录。
 *
 * **守卫四件套**（裁决 ②，读取路径全部必配）：
 * 1. 根内收 —— resolve 后核验仍在允许根内（照抄 `resolveOrgWorkspace` 双保险，
 *    host-face.ts:117-133 风格；拒 `..`/盘符/分隔符 + Windows 大小写不敏感比较）；
 * 2. version 白名单 —— `^v\d+\.\d+\.\d+$`，不匹配 ⇒ 结构化拒绝（**不抛错**）；
 * 3. 仅 `.md` 后缀闭集（读取前校验）；
 * 4. 256KiB 读上限（先例 write-guard.ts:30），超限只读到上限并打截断标记（不整读大文件）。
 *
 * 降级不报错口径（B3）：非法输入一律走结构化失败值，**本模块不抛未捕获异常**；
 * 失败文案**不得携带根绝对路径**（HTTP 层 404 不泄根）。
 */
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 单文档读取上限（字节）：与写面请求体上限同值同先例（write-guard.ts `MAX_REQUIREMENT_BODY_BYTES`）。 */
export const MAX_DOC_FILE_BYTES = 262_144;

/** 版本目录名白名单：`v{major}.{minor}.{patch}`（B3 ⇒ 不匹配不报错，只降级）。 */
export const DOC_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;

/** 文档扩展名闭集（守卫 3）。 */
export const DOC_FILE_SUFFIX = ".md";

/** 双源标识：A = 主仓根，B = 组织工作区。 */
export type DocsSource = "A" | "B";

/** version 白名单判定（守卫 2 的布尔投影）。 */
export function isValidDocVersion(version: string): boolean {
  return DOC_VERSION_PATTERN.test(version);
}

/**
 * 路径段卫生检查（守卫 1 的第一道）：空段 / `.` / `..` / 分隔符 / 盘符冒号 / 反斜杠
 * 一律拒。percent 编码（`%2e` `%5c` 族）在 HTTP 层 decode 后仍会落到本检查，
 * 故此处**同时拒含 `%` 的段**——本模块消费的是文件系统语义，没有任何合法文档名需要百分号。
 */
function isSafeSegment(seg: string): boolean {
  return (
    seg !== "" &&
    seg !== "." &&
    seg !== ".." &&
    !seg.includes("/") &&
    !seg.includes("\\") &&
    !seg.includes(":") &&
    !seg.includes("%")
  );
}

/**
 * 守卫 1（根内收）：以 root 为允许根拼出 target，resolve 后核验仍在根内。
 * Windows 文件系统大小写不敏感 ⇒ 前缀比较同样小写化（照抄 resolveOrgWorkspace）。
 */
function insideRoot(rootAbs: string, targetAbs: string): boolean {
  const prefix = rootAbs.endsWith(sep) ? rootAbs : `${rootAbs}${sep}`;
  return process.platform === "win32"
    ? targetAbs.toLowerCase().startsWith(prefix.toLowerCase())
    : targetAbs.startsWith(prefix);
}

/**
 * 主仓根缺省 = 板根上一级（`<仓根>/board/config/config.json.default` 推导同款逻辑：
 * 由模块位置反推，源码运行与 dist 运行落同一仓根）。
 */
export function defaultRepoRoot(metaUrl: string = import.meta.url): string {
  // dist/docs-read.js → <board>/src/../.. = <仓根>（与 config.ts defaultConfigPath 同锚点）
  return resolve(dirname(fileURLToPath(metaUrl)), "..", "..");
}

/** 源 A 的 doc 根 = `<repoRoot>/doc`；源 B 的 doc 根 = `<orgsDir>/<org>/doc`。 */
export function docsRootFor(source: DocsSource, dirs: { repoRoot: string; orgsDir: string; org: string }): string {
  if (source === "A") return join(dirs.repoRoot, "doc");
  return join(dirs.orgsDir, dirs.org, "doc");
}

/** 读取成功：内容 + 是否因 256KiB 上限截断 + 实际读到的字节数。 */
export interface ReadDocOk {
  readonly ok: true;
  readonly content: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

/** 结构化失败（不抛错）：三码 —— 非法入参 / 找不到 / 根内收拒绝。HTTP 层据此出 404/400，不泄根。 */
export interface ReadDocFail {
  readonly ok: false;
  readonly code: "docs_read_invalid" | "docs_read_not_found" | "docs_read_escapes_root";
  readonly error: string;
}

export type ReadDocResult = ReadDocOk | ReadDocFail;

function fail(code: ReadDocFail["code"], error: string): ReadDocFail {
  return { ok: false, code, error };
}

/**
 * 单文档读取（守卫全四件套过一遍才落盘）：
 * version 白名单 → 文件名段卫生 + `.md` 闭集 → 拼根 → 根内收核验 → stat 判存在/是文件 →
 * 上限内分块读（超限只读 256KiB 打 `truncated`，不整读）。
 * 任何一步不过 ⇒ 结构化失败；盘上异常 ⇒ 同样失败，不抛穿。
 */
export function readDoc(
  dirs: { repoRoot: string; orgsDir: string | null; org: string | null },
  source: DocsSource,
  version: string,
  name: string,
): ReadDocResult {
  if (!isValidDocVersion(version)) {
    return fail("docs_read_invalid", "版本号不符合 v{major}.{minor}.{patch} 白名单，不打开任何目录");
  }
  if (!isSafeSegment(name) || !name.endsWith(DOC_FILE_SUFFIX)) {
    return fail("docs_read_invalid", "文档名含非法字符或不是 .md，拒绝读取");
  }
  const docRoot = docsRootFor(source, {
    repoRoot: resolve(dirs.repoRoot),
    orgsDir: dirs.orgsDir === null ? "" : resolve(dirs.orgsDir),
    org: dirs.org ?? "",
  });
  const target = resolve(join(docRoot, version, name));
  if (!insideRoot(resolve(docRoot), target)) {
    return fail("docs_read_escapes_root", "目标落在文档根之外，拒绝读取");
  }
  let size: number;
  try {
    const st = statSync(target);
    if (!st.isFile()) return fail("docs_read_not_found", "目标不是普通文件");
    size = st.size;
  } catch {
    return fail("docs_read_not_found", "文档不存在或不可读");
  }
  const cap = Math.min(size, MAX_DOC_FILE_BYTES);
  const buf = Buffer.allocUnsafe(cap);
  let fd: number | null = null;
  let read = 0;
  try {
    fd = openSync(target, "r");
    while (read < cap) {
      const n = readSync(fd, buf, read, cap - read, read);
      if (n <= 0) break;
      read += n;
    }
  } catch {
    return fail("docs_read_not_found", "文档不存在或不可读");
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 已读完，关闭异常不影响内容 */
      }
    }
  }
  let text = buf.subarray(0, read).toString("utf8");
  const truncated = size > MAX_DOC_FILE_BYTES;
  if (truncated) {
    // 截断点可能劈开一个 UTF-8 多字节序列 ⇒ 去掉尾部替换符，保证输出干净
    text = text.replace(/\uFFFD$/, "");
  }
  return { ok: true, content: text, truncated, bytes: read };
}
